// Sending through a runner restart, against a fake runner in this process
// that can be told to restart, turn a send away, or close with one on its
// way: the cases the Swift app's PendingSendTests cover for `post`,
// `inRestartOrder` and `whenRestarted`. No double sends, no lost ones.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "a test: a panic is its failure, with the line"
)]
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use threadbear_client::auth::{self, Role};
use threadbear_client::config::RunnerConfig;
use threadbear_client::runner::{
    Client, Progress, ProgressFn, Resend, Sink, Status, CLOSED, NOT_CONNECTED, RESTART_RETRY_MS,
    TIMED_OUT,
};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// What the fake runner does with the next `threads.send` (or
/// `threads.update`): answer, refuse, or close the connection without a word.
#[derive(Clone, Debug)]
enum Reply {
    Ok,
    Refuse(i64, &'static str),
    Close,
    /// Says it's restarting, then closes without an answer.
    RestartAndClose,
    /// Never answers, with the connection left open, as a runner whose
    /// event loop has stalled; `lands` says whether it took the message.
    Stall {
        lands: bool,
    },
}

#[derive(Default)]
struct Runner {
    /// Every request it was sent, by method and the connection it came on.
    seen: Vec<(String, Value, u64)>,
    replies: Vec<Reply>,
    /// Down: every new connection is dropped before the handshake.
    down: bool,
    connection: u64,
    conns: Vec<mpsc::UnboundedSender<Message>>,
    /// How many more `hello`s it answers with an error.
    hello_errors: u32,
    /// The thread `threads.list` answers with, and the events after a send.
    summary: Value,
    events: Vec<Value>,
}

struct Fake {
    state: Arc<Mutex<Runner>>,
    config: RunnerConfig,
}

impl Fake {
    async fn start() -> Fake {
        let home =
            std::env::temp_dir().join(format!("tb-restart-hold-{}-{}", std::process::id(), next()));
        std::fs::create_dir_all(home.join("secrets")).unwrap();
        std::fs::write(home.join("secrets").join("runner-token"), TOKEN).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(Runner {
            summary: json!({ "id": "t1", "status": "idle", "lastSeq": 10 }),
            ..Runner::default()
        }));
        let shared = state.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                if shared.lock().unwrap().down {
                    drop(stream);
                    continue;
                }
                let shared = shared.clone();
                tokio::spawn(async move { serve(stream, shared, port).await });
            }
        });
        Fake {
            state,
            config: RunnerConfig {
                home: PathBuf::from(&home),
                port,
            },
        }
    }

    fn notice(&self, message: &str) {
        let text = json!({ "jsonrpc": "2.0", "method": "runner.notice", "params": { "level": "info", "message": message } }).to_string();
        for c in &self.state.lock().unwrap().conns {
            let _ = c.send(Message::text(text.clone()));
        }
    }

    /// Every connection closed, and none taken until `up`.
    fn go_down(&self) {
        let mut s = self.state.lock().unwrap();
        s.down = true;
        for c in s.conns.drain(..) {
            let _ = c.send(Message::Close(None));
        }
    }

    fn up(&self) {
        self.state.lock().unwrap().down = false;
    }

    fn reply_with(&self, replies: &[Reply]) {
        self.state.lock().unwrap().replies = replies.to_vec();
    }

    fn sends(&self) -> Vec<(String, Value, u64)> {
        self.state
            .lock()
            .unwrap()
            .seen
            .iter()
            .filter(|(m, _, _)| m == "threads.send" || m == "threads.update")
            .cloned()
            .collect()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.config.home);
    }
}

fn next() -> u32 {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

async fn serve(stream: tokio::net::TcpStream, state: Arc<Mutex<Runner>>, port: u16) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (mut write, mut read) = ws.split();
    let runner_nonce = auth::new_nonce();
    let _ = write.send(Message::text(json!({ "jsonrpc": "2.0", "method": "auth.challenge", "params": { "nonce": runner_nonce } }).to_string())).await;
    let Some(Ok(Message::Text(prove))) = read.next().await else {
        return;
    };
    let prove: Value = serde_json::from_str(prove.as_str()).unwrap();
    let client_nonce = prove["params"]["nonce"].as_str().unwrap().to_owned();
    let proof = auth::proof(
        TOKEN,
        Role::Runner,
        &runner_nonce,
        &client_nonce,
        "primary",
        port,
    );
    let _ = write
        .send(Message::text(
            json!({ "jsonrpc": "2.0", "id": 1, "result": { "proof": proof } }).to_string(),
        ))
        .await;
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let connection = {
        let mut s = state.lock().unwrap();
        s.connection += 1;
        s.conns.push(tx.clone());
        s.connection
    };
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let close = matches!(msg, Message::Close(_));
            if write.send(msg).await.is_err() || close {
                break;
            }
        }
        let _ = write.close().await;
    });
    while let Some(Ok(msg)) = read.next().await {
        let Message::Text(text) = msg else { continue };
        let v: Value = serde_json::from_str(text.as_str()).unwrap();
        let (id, method, params) = (
            v["id"].clone(),
            v["method"].as_str().unwrap_or("").to_owned(),
            v["params"].clone(),
        );
        let answer =
            |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string();
        let reply = {
            let mut s = state.lock().unwrap();
            s.seen.push((method.clone(), params.clone(), connection));
            match method.as_str() {
                "hello" if s.hello_errors > 0 => {
                    s.hello_errors -= 1;
                    Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": "hello broke" } }).to_string())
                }
                "hello" => Some(answer(json!({ "protocol": 1, "runnerVersion": format!("fake-{connection}") }))),
                "threads.send" | "threads.update" | "actions.run" => match if s.replies.is_empty() { Reply::Ok } else { s.replies.remove(0) } {
                    Reply::Ok => {
                        // A send lands as its user.message, as the runner's does.
                        if method == "threads.send" {
                            land(&mut s, &params);
                        }
                        Some(answer(json!({ "turnId": "turn_1" })))
                    }
                    Reply::Stall { lands } => {
                        if lands {
                            land(&mut s, &params);
                        }
                        None
                    }
                    Reply::Refuse(code, message) => Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()),
                    Reply::Close => {
                        // Taken or not, as the test says, and no answer.
                        let _ = tx.send(Message::Close(None));
                        None
                    },
                    Reply::RestartAndClose => {
                        let notice = json!({ "jsonrpc": "2.0", "method": "runner.notice", "params": { "level": "info", "message": "The runner is restarting now." } });
                        let _ = tx.send(Message::text(notice.to_string()));
                        let _ = tx.send(Message::Close(None));
                        None
                    }
                },
                "threads.list" => Some(answer(json!({ "threads": [s.summary.clone()] }))),
                "threads.events" => {
                    let after = params["afterSeq"].as_i64().unwrap_or(0);
                    Some(answer(json!({ "events": s.events.iter().filter(|e| e["seq"].as_i64().unwrap_or(0) > after).cloned().collect::<Vec<_>>() })))
                }
                _ => Some(answer(json!({}))),
            }
        };
        if let Some(reply) = reply {
            let _ = tx.send(Message::text(reply));
        }
    }
    writer.abort();
}

/// A send's user.message, after the thread's last event.
fn land(s: &mut Runner, params: &Value) {
    let seq = s.summary["lastSeq"].as_i64().unwrap_or(0) + 1;
    s.summary["lastSeq"] = json!(seq);
    s.events
        .push(json!({ "seq": seq, "type": "user.message", "text": params["text"] }));
}

struct Statuses(mpsc::UnboundedSender<Status>);

impl Sink for Statuses {
    fn status(&self, status: &Status) {
        let _ = self.0.send(status.clone());
    }
    fn notification(&self, _: &str, _: &Value) {}
}

async fn connect(fake: &Fake) -> (Arc<Client>, mpsc::UnboundedReceiver<Status>) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let client = Client::new(fake.config.clone(), Statuses(tx));
    tokio::spawn(client.clone().run());
    until_connected(&mut rx).await;
    (client, rx)
}

async fn until_connected(rx: &mut mpsc::UnboundedReceiver<Status>) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(s) = rx.recv().await {
            if matches!(s, Status::Connected { .. }) {
                return;
            }
        }
    })
    .await
    .expect("connected in time");
}

async fn until_disconnected(rx: &mut mpsc::UnboundedReceiver<Status>) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(s) = rx.recv().await {
            if matches!(s, Status::Disconnected { .. }) {
                return;
            }
        }
    })
    .await
    .expect("disconnected in time");
}

/// What a held request said, in order.
fn progress() -> (ProgressFn, Arc<Mutex<Vec<Progress>>>) {
    let said = Arc::new(Mutex::new(vec![]));
    let into = said.clone();
    (Arc::new(move |p| into.lock().unwrap().push(p)), said)
}

fn send(text: &str) -> Value {
    json!({ "threadId": "t1", "text": text })
}

fn resend(text: &str, after_seq: i64, was_idle: bool) -> Resend {
    let text = text.to_owned();
    Resend {
        thread_id: "t1".into(),
        after_seq,
        was_idle,
        landed: Arc::new(move |e: &Value| {
            e["type"] == "user.message" && e["text"] == text.as_str()
        }),
    }
}

/// Lets the client hear what's just been sent to it.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(150)).await;
}

// A hello that fails ends that session and the next one tries again, as
// the Swift app's connect loop does: it used to sit on "Connecting" with
// no threads for as long as the socket stayed open.
#[tokio::test]
async fn a_failed_hello_connects_again() {
    let fake = Fake::start().await;
    fake.state.lock().unwrap().hello_errors = 1;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let client = Client::new(fake.config.clone(), Statuses(tx));
    tokio::spawn(client.clone().run());
    until_disconnected(&mut rx).await;
    until_connected(&mut rx).await;
    let hellos: Vec<u64> = fake
        .state
        .lock()
        .unwrap()
        .seen
        .iter()
        .filter(|(m, _, _)| m == "hello")
        .map(|(_, _, c)| *c)
        .collect();
    assert_eq!(hellos, vec![1, 2], "the second connection's hello");
}

#[tokio::test]
async fn a_message_sent_while_the_runner_restarts_waits_for_the_new_one() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner is restarting now.");
    settle().await;
    fake.go_down();
    until_disconnected(&mut rx).await;
    let (said, heard) = progress();
    let sending = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .call_in_restart_order("threads.send", send("check the backups"), said)
                .await
        }
    });
    settle().await;
    assert_eq!(
        *heard.lock().unwrap(),
        vec![Progress::Held],
        "it says it's waiting at once"
    );
    assert!(fake.sends().is_empty());
    fake.up();
    let answer = tokio::time::timeout(Duration::from_secs(5), sending)
        .await
        .expect("sent once it's back")
        .unwrap();
    assert!(answer.is_ok(), "{answer:?}");
    let sends = fake.sends();
    assert_eq!(sends.len(), 1, "once, on the new runner");
    assert_eq!(sends[0].2, 2);
    assert_eq!(
        *heard.lock().unwrap(),
        vec![Progress::Held, Progress::Sending]
    );
}

#[tokio::test]
async fn a_send_while_disconnected_with_no_restart_fails_at_once() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.go_down();
    until_disconnected(&mut rx).await;
    let (said, heard) = progress();
    let err = client
        .call_in_restart_order("threads.send", send("hello"), said)
        .await
        .unwrap_err();
    assert_eq!(err.code, NOT_CONNECTED);
    assert!(heard.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_held_message_gives_up_if_the_runner_doesnt_come_back() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    client.set_restart_waits(Duration::from_millis(400), Duration::from_millis(400));
    fake.notice("The runner is restarting now.");
    settle().await;
    fake.go_down();
    until_disconnected(&mut rx).await;
    let (said, _) = progress();
    let err = client
        .call_in_restart_order("threads.send", send("hello"), said)
        .await
        .unwrap_err();
    assert_eq!(err.code, NOT_CONNECTED);
    fake.up();
    settle().await;
    assert!(fake.sends().is_empty(), "never sent after giving up");
}

#[tokio::test]
async fn a_send_turned_away_by_a_restart_goes_again_to_the_new_runner() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner will restart when 1 thread finishes.");
    settle().await;
    fake.reply_with(&[Reply::Refuse(-32004, "Thread not found")]);
    let (said, heard) = progress();
    let sending = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .call_in_restart_order("threads.send", send("again please"), said)
                .await
        }
    });
    settle().await;
    // Going (which clears a bubble the app showed as held when the runner
    // was back before it went), then turned away and held.
    assert_eq!(
        *heard.lock().unwrap(),
        vec![Progress::Sending, Progress::Held]
    );
    fake.go_down();
    until_disconnected(&mut rx).await;
    fake.up();
    let answer = tokio::time::timeout(Duration::from_secs(5), sending)
        .await
        .unwrap()
        .unwrap();
    assert!(answer.is_ok(), "{answer:?}");
    let sends = fake.sends();
    assert_eq!(sends.len(), 2, "turned away once, then taken");
    assert_eq!((sends[0].2, sends[1].2), (1, 2));
}

#[tokio::test]
async fn other_refusals_during_a_restart_still_fail() {
    let fake = Fake::start().await;
    let (client, _rx) = connect(&fake).await;
    fake.notice("The runner will restart when 1 thread finishes.");
    settle().await;
    fake.reply_with(&[Reply::Refuse(-32020, "The thread is busy")]);
    let (said, _) = progress();
    let err = client
        .call_in_restart_order("threads.send", send("hello"), said)
        .await
        .unwrap_err();
    assert_eq!(err.code, -32020);
    assert_eq!(fake.sends().len(), 1);
}

#[tokio::test]
async fn thread_not_found_with_no_restart_still_fails() {
    let fake = Fake::start().await;
    let (client, _rx) = connect(&fake).await;
    fake.reply_with(&[Reply::Refuse(-32004, "Thread not found")]);
    let (said, _) = progress();
    let err = client
        .call_in_restart_order("threads.send", send("hello"), said)
        .await
        .unwrap_err();
    assert_eq!(err.code, -32004);
}

#[tokio::test]
async fn requests_held_for_a_restart_go_in_the_order_they_were_made() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner is restarting now.");
    settle().await;
    fake.go_down();
    until_disconnected(&mut rx).await;
    let mut tasks = vec![];
    for (method, params) in [
        (
            "threads.update",
            json!({ "threadId": "t1", "model": "opus" }),
        ),
        ("threads.send", send("first")),
        ("threads.send", send("second")),
    ] {
        let client = client.clone();
        tasks.push(tokio::spawn(async move {
            client
                .call_in_restart_order(method, params, progress().0)
                .await
        }));
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    fake.up();
    for t in tasks {
        assert!(tokio::time::timeout(Duration::from_secs(5), t)
            .await
            .unwrap()
            .unwrap()
            .is_ok());
    }
    let order: Vec<String> = fake
        .sends()
        .iter()
        .map(|(m, p, _)| p["text"].as_str().map_or(m.clone(), str::to_owned))
        .collect();
    assert_eq!(order, vec!["threads.update", "first", "second"]);
}

#[tokio::test]
async fn a_message_sent_while_one_waits_goes_after_it() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner will restart when 1 thread finishes.");
    settle().await;
    // The first is turned away and waits; the second, sent while it waits,
    // goes behind it even though the old runner is still connected.
    fake.reply_with(&[Reply::Refuse(-32004, "Thread not found")]);
    let first = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .call_in_restart_order(
                    "threads.update",
                    json!({ "threadId": "t1", "effort": "high" }),
                    progress().0,
                )
                .await
        }
    });
    settle().await;
    let (said, heard) = progress();
    let second = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .call_in_restart_order("threads.send", send("after the pick"), said)
                .await
        }
    });
    settle().await;
    assert_eq!(*heard.lock().unwrap(), vec![Progress::Held]);
    assert_eq!(fake.sends().len(), 1, "the second waits its turn");
    fake.go_down();
    until_disconnected(&mut rx).await;
    fake.up();
    assert!(tokio::time::timeout(Duration::from_secs(5), first)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
    assert!(tokio::time::timeout(Duration::from_secs(5), second)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
    let sends = fake.sends();
    assert_eq!(
        sends
            .iter()
            .map(|(m, _, c)| (m.as_str(), *c))
            .collect::<Vec<_>>(),
        vec![
            ("threads.update", 1),
            ("threads.update", 2),
            ("threads.send", 2)
        ]
    );
}

#[tokio::test]
async fn a_send_cut_off_by_a_restart_goes_again_to_the_new_runner() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner is restarting now.");
    settle().await;
    // The old runner closes with the message on its way and never took it.
    fake.reply_with(&[Reply::Close]);
    let (said, heard) = progress();
    let sending = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .send_through_restart(
                    client.place("t1"),
                    send("cut off"),
                    resend("cut off", 10, true),
                    said,
                )
                .await
        }
    });
    until_disconnected(&mut rx).await;
    fake.go_down();
    settle().await;
    assert_eq!(
        *heard.lock().unwrap(),
        vec![Progress::Sending, Progress::Held]
    );
    fake.up();
    let answer = tokio::time::timeout(Duration::from_secs(5), sending)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(answer, Ok(Some(_))), "{answer:?}");
    let sends = fake.sends();
    assert_eq!(sends.len(), 2);
    assert_eq!(sends[1].2, 2, "again, on the new runner");
}

#[tokio::test]
async fn a_cut_off_send_that_had_arrived_isnt_sent_twice() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner is restarting now.");
    settle().await;
    fake.reply_with(&[Reply::Close]);
    // It had landed: its user.message is in the thread.
    fake.state
        .lock()
        .unwrap()
        .events
        .push(json!({ "seq": 11, "type": "user.message", "text": "arrived" }));
    let sending = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .send_through_restart(
                    client.place("t1"),
                    send("arrived"),
                    resend("arrived", 10, true),
                    progress().0,
                )
                .await
        }
    });
    until_disconnected(&mut rx).await;
    let answer = tokio::time::timeout(Duration::from_secs(5), sending)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(answer, Ok(None)), "{answer:?}");
    assert_eq!(fake.sends().len(), 1, "not sent twice");
}

#[tokio::test]
async fn a_cut_off_send_to_a_busy_thread_goes_back_in_the_box() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner is restarting now.");
    settle().await;
    fake.reply_with(&[Reply::Close]);
    fake.state.lock().unwrap().summary["status"] = json!("running");
    let sending = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .send_through_restart(
                    client.place("t1"),
                    send("maybe queued"),
                    resend("maybe queued", 10, true),
                    progress().0,
                )
                .await
        }
    });
    until_disconnected(&mut rx).await;
    let err = tokio::time::timeout(Duration::from_secs(5), sending)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(err.code, CLOSED);
    assert_eq!(fake.sends().len(), 1);
}

#[tokio::test]
async fn a_cut_off_send_with_another_on_its_way_isnt_sent_again() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner is restarting now.");
    settle().await;
    fake.reply_with(&[Reply::Close]);
    let sending = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .send_through_restart(
                    client.place("t1"),
                    send("one of two"),
                    resend("one of two", 10, false),
                    progress().0,
                )
                .await
        }
    });
    until_disconnected(&mut rx).await;
    let err = tokio::time::timeout(Duration::from_secs(5), sending)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(err.code, CLOSED);
    assert_eq!(fake.sends().len(), 1);
}

#[tokio::test]
async fn a_cut_off_send_with_no_restart_isnt_sent_again() {
    let fake = Fake::start().await;
    let (client, _rx) = connect(&fake).await;
    fake.reply_with(&[Reply::Close]);
    let err = client
        .send_through_restart(
            client.place("t1"),
            send("dropped"),
            resend("dropped", 10, true),
            progress().0,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, CLOSED);
    settle().await;
    assert_eq!(fake.sends().len(), 1);
}

/// While a restart is under way it tries every half second, rather than
/// backing off to 10 s: the window said "Reconnecting" well after the
/// runner was back.
#[tokio::test]
async fn reconnects_quickly_while_the_runner_restarts() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner is restarting now.");
    settle().await;
    fake.go_down();
    until_disconnected(&mut rx).await;
    // Down long enough that doubling would be waiting 4 s by now.
    tokio::time::sleep(Duration::from_secs(4)).await;
    fake.up();
    let back = Instant::now();
    until_connected(&mut rx).await;
    assert!(
        back.elapsed() < Duration::from_millis(1500),
        "back in {:?}",
        back.elapsed()
    );
    assert!(
        !client.restart_under_way(),
        "connected again, the restart is over"
    );
}

#[tokio::test]
async fn backs_off_when_the_runner_just_went_away() {
    let fake = Fake::start().await;
    let (_client, mut rx) = connect(&fake).await;
    fake.go_down();
    let mut waits = vec![];
    tokio::time::timeout(Duration::from_secs(10), async {
        while waits.len() < 4 {
            if let Some(Status::Disconnected { retry_in_ms, .. }) = rx.recv().await {
                waits.push(retry_in_ms);
            }
        }
    })
    .await
    .unwrap();
    // Never more than two seconds: it's this Mac's own runner.
    assert_eq!(waits, vec![500, 1000, 2000, 2000]);
}

/// A held message cut off on the next runner too goes again in its place in
/// the queue, ahead of one held after it (Codex's review, 12 Nov).
#[tokio::test]
async fn a_held_message_cut_off_again_keeps_its_place() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner is restarting now.");
    settle().await;
    fake.go_down();
    until_disconnected(&mut rx).await;
    // The first goes to the new runner, which restarts and closes on it.
    fake.reply_with(&[Reply::RestartAndClose]);
    let first = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .send_through_restart(
                    client.place("t1"),
                    send("first"),
                    resend("first", 10, true),
                    progress().0,
                )
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    let second = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .send_through_restart(
                    client.place("t1"),
                    send("second"),
                    resend("second", 10, false),
                    progress().0,
                )
                .await
        }
    });
    settle().await;
    fake.up();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(8), first)
            .await
            .unwrap()
            .unwrap(),
        Ok(Some(_))
    ));
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(8), second)
            .await
            .unwrap()
            .unwrap(),
        Ok(Some(_))
    ));
    let order: Vec<(String, u64)> = fake
        .sends()
        .iter()
        .map(|(_, p, c)| (p["text"].as_str().unwrap().to_owned(), *c))
        .collect();
    assert_eq!(
        order,
        vec![
            ("first".into(), 2),
            ("first".into(), 3),
            ("second".into(), 3)
        ]
    );
}

/// A restart that has begun turns new turns away before taking them
/// ("The runner is restarting; send again in a moment."): it goes again.
#[tokio::test]
async fn a_send_the_restarting_runner_refuses_goes_again() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner is restarting now.");
    settle().await;
    fake.reply_with(&[Reply::Refuse(
        -32020,
        "The runner is restarting; send again in a moment.",
    )]);
    let sending = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .call_in_restart_order("threads.send", send("refused once"), progress().0)
                .await
        }
    });
    settle().await;
    fake.go_down();
    until_disconnected(&mut rx).await;
    fake.up();
    assert!(tokio::time::timeout(Duration::from_secs(5), sending)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
    assert_eq!(fake.sends().len(), 2);
}

/// Two held messages go in the order they were made, however their tasks
/// are scheduled: the place is taken where each is made, not when its task
/// first runs (Codex's review, 12 Nov).
#[tokio::test]
async fn held_messages_go_in_the_order_they_were_made() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner is restarting now.");
    settle().await;
    fake.go_down();
    until_disconnected(&mut rx).await;
    let (a, b) = (client.place("t1"), client.place("t1"));
    // The later one's task starts first.
    let second = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .send_through_restart(b, send("second"), resend("second", 10, false), progress().0)
                .await
        }
    });
    settle().await;
    let first = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .send_through_restart(a, send("first"), resend("first", 10, false), progress().0)
                .await
        }
    });
    settle().await;
    fake.up();
    assert!(tokio::time::timeout(Duration::from_secs(8), first)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
    assert!(tokio::time::timeout(Duration::from_secs(8), second)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
    let order: Vec<String> = fake
        .sends()
        .iter()
        .map(|(_, p, _)| p["text"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(order, vec!["first", "second"]);
}

/// A message held as the app quits stays held: its words go in the drafts
/// file, so it mustn't also reach the new runner (Codex's review, 12 Nov).
#[tokio::test]
async fn a_held_message_never_goes_once_the_app_is_quitting() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner is restarting now.");
    settle().await;
    fake.go_down();
    until_disconnected(&mut rx).await;
    let (said, heard) = progress();
    let sending = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .send_through_restart(
                    client.place("t1"),
                    send("held at quit"),
                    resend("held at quit", 10, true),
                    said,
                )
                .await
        }
    });
    settle().await;
    client.stop_holding();
    fake.up();
    let err = tokio::time::timeout(Duration::from_secs(8), sending)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(err.code, NOT_CONNECTED);
    assert!(fake.sends().is_empty(), "it went: {:?}", fake.sends());
    assert_eq!(
        *heard.lock().unwrap(),
        vec![Progress::Held],
        "it never said it was going"
    );
}

/// Made A then B, B's task first, and the old runner turns A away during a
/// handover: A goes again on the new runner before B goes at all, as A
/// keeps its place until it's answered (Codex's third review, 12 Nov).
#[tokio::test]
async fn one_turned_away_keeps_its_place_ahead_of_one_made_after_it() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner will restart when 1 thread finishes.");
    settle().await;
    fake.reply_with(&[Reply::Refuse(
        -32020,
        "The runner is handing over to a new one; send again in a moment.",
    )]);
    let (a, b) = (client.place("t1"), client.place("t1"));
    let second = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .send_through_restart(b, send("B"), resend("B", 10, false), progress().0)
                .await
        }
    });
    settle().await;
    let first = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .send_through_restart(a, send("A"), resend("A", 10, false), progress().0)
                .await
        }
    });
    settle().await;
    fake.go_down();
    until_disconnected(&mut rx).await;
    fake.up();
    assert!(tokio::time::timeout(Duration::from_secs(8), first)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
    assert!(tokio::time::timeout(Duration::from_secs(8), second)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
    let order: Vec<(String, u64)> = fake
        .sends()
        .iter()
        .map(|(_, p, c)| (p["text"].as_str().unwrap().to_owned(), *c))
        .collect();
    assert_eq!(
        order,
        vec![("A".into(), 1), ("A".into(), 2), ("B".into(), 2)]
    );
}

/// Another thread's message doesn't wait for this one's answer.
#[tokio::test]
async fn another_threads_message_goes_while_one_waits() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner will restart when 1 thread finishes.");
    settle().await;
    fake.reply_with(&[Reply::Refuse(-32004, "Thread not found")]);
    let held = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .send_through_restart(
                    client.place("t1"),
                    send("held"),
                    resend("held", 10, false),
                    progress().0,
                )
                .await
        }
    });
    settle().await;
    let mut other = send("other thread");
    other["threadId"] = json!("t2");
    let other = tokio::time::timeout(
        Duration::from_secs(2),
        client.call_in_restart_order("threads.send", other, progress().0),
    )
    .await;
    assert!(other.unwrap().is_ok(), "t2's message waited for t1's");
    fake.go_down();
    until_disconnected(&mut rx).await;
    fake.up();
    assert!(tokio::time::timeout(Duration::from_secs(8), held)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
}

// 19 Nov: the runner stalled for four minutes on a Mac out of memory, took
// the message when it came back, and answered after the app had stopped
// waiting. The app said it wasn't sent and put it back in the box. Now it
// looks first.
#[tokio::test]
async fn a_send_with_no_answer_in_time_that_had_arrived_counts_as_sent() {
    let fake = Fake::start().await;
    let (client, _rx) = connect(&fake).await;
    client.set_timeout_cap(Duration::from_millis(300));
    fake.reply_with(&[Reply::Stall { lands: true }]);
    let (said, _) = progress();
    let answer = client
        .send_through_restart(
            client.place("t1"),
            send("the brief"),
            resend("the brief", 10, true),
            said,
        )
        .await;
    assert!(matches!(answer, Ok(None)), "{answer:?}");
    assert_eq!(fake.sends().len(), 1, "never sent twice");
}

#[tokio::test]
async fn a_send_with_no_answer_in_time_that_hasnt_arrived_is_given_back_once() {
    let fake = Fake::start().await;
    let (client, _rx) = connect(&fake).await;
    client.set_timeout_cap(Duration::from_millis(300));
    fake.reply_with(&[Reply::Stall { lands: false }]);
    let (said, _) = progress();
    let err = client
        .send_through_restart(
            client.place("t1"),
            send("the brief"),
            resend("the brief", 10, true),
            said,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, TIMED_OUT);
    assert_eq!(
        fake.sends().len(),
        1,
        "not sent again on a guess: a stalled runner may still take it"
    );
}

// With another message on its way, or a busy thread, one with the same
// words could pass for it: no answer in time stays that, and it's given
// back rather than taken as sent on a guess (Codex's and Gemini's review).
#[tokio::test]
async fn a_send_with_no_answer_in_time_isnt_confirmed_by_another_with_the_same_words() {
    let fake = Fake::start().await;
    let (client, _rx) = connect(&fake).await;
    client.set_timeout_cap(Duration::from_millis(300));
    fake.reply_with(&[Reply::Ok, Reply::Stall { lands: false }]);
    let (said, _) = progress();
    client
        .send_through_restart(
            client.place("t1"),
            send("yes"),
            resend("yes", 10, false),
            said.clone(),
        )
        .await
        .unwrap();
    let err = client
        .send_through_restart(
            client.place("t1"),
            send("yes"),
            resend("yes", 10, false),
            said,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, TIMED_OUT);
}

#[tokio::test]
async fn user_actions_wait_for_a_restarting_runner_and_replay_in_order() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.notice("The runner is restarting now.");
    settle().await;
    fake.go_down();
    until_disconnected(&mut rx).await;

    let first_place = client.place_for("projects.update", &json!({ "projectId": "p1" }));
    let second_place = client.place_for("coordinators.addTask", &json!({ "projectId": "p1" }));
    let approval_place = client.place_for("approvals.respond", &json!({ "threadId": "t1" }));

    let second = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .call_in_restart_order_at(
                    second_place,
                    "coordinators.addTask",
                    json!({ "projectId": "p1", "title": "Check logs" }),
                    progress().0,
                )
                .await
        }
    });
    settle().await;
    let first = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .call_in_restart_order_at(
                    first_place,
                    "projects.update",
                    json!({ "projectId": "p1", "title": "Renamed" }),
                    progress().0,
                )
                .await
        }
    });
    let approval = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .call_in_restart_order_at(
                    approval_place,
                    "approvals.respond",
                    json!({ "threadId": "t1", "approvalId": "a1", "decision": "allow" }),
                    progress().0,
                )
                .await
        }
    });
    let create = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .call_through_restart("threads.create", json!({ "text": "hello" }))
                .await
        }
    });
    settle().await;

    fake.up();
    for task in [first, second, approval, create] {
        assert!(tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .is_ok());
    }

    let seen: Vec<(String, u64)> = fake
        .state
        .lock()
        .unwrap()
        .seen
        .iter()
        .filter(|(m, _, _)| m != "hello")
        .map(|(m, _, c)| (m.clone(), *c))
        .collect();
    assert!(
        seen.iter().all(|(_, c)| *c == 2),
        "all ran on the new runner: {seen:?}"
    );
    let p1_order: Vec<&str> = seen
        .iter()
        .filter_map(|(m, _)| {
            matches!(m.as_str(), "projects.update" | "coordinators.addTask").then_some(m.as_str())
        })
        .collect();
    assert_eq!(p1_order, vec!["projects.update", "coordinators.addTask"]);
    assert!(seen.iter().any(|(m, _)| m == "approvals.respond"));
    assert!(seen.iter().any(|(m, _)| m == "threads.create"));
}

#[tokio::test]
async fn user_action_while_disconnected_without_restart_fails_at_once() {
    let fake = Fake::start().await;
    let (client, mut rx) = connect(&fake).await;
    fake.go_down();
    until_disconnected(&mut rx).await;
    let err = client
        .call_through_restart("threads.create", json!({ "text": "hello" }))
        .await
        .unwrap_err();
    assert_eq!(err.code, NOT_CONNECTED);
}

#[tokio::test]
async fn restart_reconnect_polls_at_restart_retry_interval() {
    let fake = Fake::start().await;
    let (_client, mut rx) = connect(&fake).await;
    fake.notice("The runner is restarting now.");
    settle().await;
    fake.go_down();
    let mut waits = vec![];
    tokio::time::timeout(Duration::from_secs(5), async {
        while waits.len() < 3 {
            if let Some(Status::Disconnected { retry_in_ms, .. }) = rx.recv().await {
                waits.push(retry_in_ms);
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(waits, vec![RESTART_RETRY_MS; 3]);
}

#[tokio::test]
async fn a_slow_command_action_does_not_block_stop_approvals_or_sends_on_the_same_thread() {
    let fake = Fake::start().await;
    let (client, _rx) = connect(&fake).await;
    // Make `actions.run` stall indefinitely on the runner (like a long Land check).
    fake.reply_with(&[Reply::Stall { lands: false }]);
    let action_place = client.place_for(
        "actions.run",
        &json!({ "threadId": "t1", "actionId": "worktree.land" }),
    );
    let _running = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .call_in_restart_order_at(
                    action_place,
                    "actions.run",
                    json!({ "threadId": "t1", "actionId": "worktree.land" }),
                    progress().0,
                )
                .await
        }
    });
    settle().await;

    // Stop, approval answers, and messages on the same thread must go straight
    // through without waiting behind the running command action.
    for (method, params) in [
        ("threads.interrupt", json!({ "threadId": "t1" })),
        (
            "approvals.respond",
            json!({ "threadId": "t1", "approvalId": "a1", "decision": "allow" }),
        ),
        ("threads.send", send("carry on")),
    ] {
        let res = tokio::time::timeout(
            Duration::from_secs(2),
            client.call_through_restart(method, params),
        )
        .await
        .unwrap_or_else(|_| panic!("{method} blocked behind actions.run"));
        assert!(res.is_ok(), "{method} failed: {res:?}");
    }
}
