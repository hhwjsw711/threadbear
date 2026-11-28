// One thread: its transcript (rows come from the reducer in threadbear-core),
// its cards and the composer. Reads the newest page of events, then subscribes
// from the last of them, as the Mac app's ThreadSession does.
mod find;

use crate::composer::Composer;
use crate::rows::list::{transcript_list, TranscriptList};
use crate::{call, RT};
use gpui_kit::component::WindowExt as _;
use gpui_kit::component::{v_flex, ActiveTheme as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::style::px;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use threadbear_client::runner::{Client, Progress, ProgressFn, Resend, RpcError};
use threadbear_core::inbox::ThreadSummary;
use threadbear_core::older_pages::{
    Answer as OlderAnswer, Ask as OlderAsk, OlderPages, Then as OlderThen, EVENTS_PAGE,
};
use threadbear_core::outbox::{Answer, Effects, Event as OutboxEvent, Outbox, Send as Sending};
use threadbear_core::reducer::{
    BackgroundTask, Event, EventsPage, FeedAction, ImageRef, PendingMessage, Row, RowContent,
    ThreadFeed, TranscriptChange, TranscriptModel,
};
use threadbear_core::thread_load::{Event as LoadEvent, Then as LoadThen, ThreadLoad, View};

/// Streamed text arrives faster than it's worth drawing: flushed at most this
/// often, as ThreadSession does (30 Hz).
const FLUSH_EVERY: Duration = Duration::from_millis(33);
/// How long a thread sits idle with a message still queued before it's taken
/// for lost (`AppModel.queuedGrace`).
const QUEUED_GRACE: Duration = Duration::from_secs(10);
/// A kept thread further behind than this many events when it's shown again
/// reads its newest page afresh rather than every event since (`resubscribe`).
const CATCH_UP_LIMIT: i64 = 2000;
/// A kept pane holding more events than this (older pages scrolled to, or a
/// lot happening while it was kept) goes back to its newest page (`set_kept`).
const KEPT_EVENTS: usize = 2000;

/// Where the time went in a pane's last full read, for the automation's dump
/// and features/tools/switch-perf.ts: the runner's answer, its size, turning
/// it into events and folding them into rows (both off the main thread), and
/// the first frame drawn with them. Milliseconds from the read's start.
#[derive(Clone, Default)]
pub(crate) struct LoadTiming {
    started: Option<std::time::Instant>,
    request_ms: f64,
    bytes: usize,
    decode_ms: f64,
    fold_ms: f64,
    ready_ms: Option<f64>,
    painted_ms: Option<f64>,
    /// Full reads (`threads.events` for the newest page) this pane has made:
    /// one, unless a reconnect or Try again read it again. Switching back to a
    /// kept thread makes none (app.rs, `kept`).
    reads: u32,
    /// No transcript was showing when this read started, so Mike was looking
    /// at the spinner for it, rather than at rows a reload replaces.
    cold: bool,
    /// Why opening the thread had to read it (app.rs `open`): `new`, not
    /// opened since the app started, or `evicted`, pushed out of the kept
    /// ones (pane_cache.rs); and how many were kept then.
    pub(crate) why: Option<(&'static str, usize)>,
}

impl LoadTiming {
    fn since(&self) -> f64 {
        self.started
            .map(|s| s.elapsed().as_secs_f64() * 1000.)
            .unwrap_or(0.)
    }
}

/// `threads.unsubscribe`s on their way, by thread. Each is its own task on the
/// runtime, which has more than one worker, so one sent as a thread is evicted
/// (pane_cache.rs) could reach the runner after a subscribe for it sent as it's
/// opened again straight after, and end the new pane's subscription. A
/// subscribe waits for them (`after_unsubscribe`). Codex's review, 12 Nov.
static UNSUBSCRIBING: std::sync::Mutex<
    std::collections::BTreeMap<String, Vec<futures::channel::oneshot::Receiver<()>>>,
> = std::sync::Mutex::new(std::collections::BTreeMap::new());

async fn after_unsubscribe(thread_id: &str) {
    let waits = UNSUBSCRIBING
        .lock()
        .ok()
        .and_then(|mut map| map.remove(thread_id))
        .unwrap_or_default();
    for wait in waits {
        let _ = wait.await;
    }
}

/// A page read and folded off the main thread (`load`), as ThreadSession.open's
/// `Task.detached`: the events go into the model there, and only the buttons
/// among them come back to the main thread, whose store they live in.
struct Prepared {
    model: TranscriptModel,
    buttons: Vec<Event>,
    at_start: bool,
    bytes: usize,
    decode_ms: f64,
    fold_ms: f64,
}

fn prepare(v: Value, root: Option<String>) -> Prepared {
    #[cfg(feature = "automation")]
    let bytes = serde_json::to_vec(&v).map(|b| b.len()).unwrap_or(0);
    #[cfg(not(feature = "automation"))]
    let bytes = 0;
    let t = std::time::Instant::now();
    let page = EventsPage::decode(&v).unwrap_or_default();
    drop(v);
    let decode_ms = t.elapsed().as_secs_f64() * 1000.;
    let t = std::time::Instant::now();
    let buttons: Vec<Event> = page
        .events
        .iter()
        .filter(|e| {
            matches!(
                e.payload,
                threadbear_core::reducer::EventPayload::ButtonUpdated(_)
            )
        })
        .cloned()
        .collect();
    let mut model = TranscriptModel::new(root);
    model.load(page.events, &page.in_progress);
    model.known_start = page.at_start;
    Prepared {
        model,
        buttons,
        at_start: page.at_start,
        bytes,
        decode_ms,
        fold_ms: t.elapsed().as_secs_f64() * 1000.,
    }
}

/// The app's windows that are in front, by id: a thread is read only while
/// one is (AppModel.isLooking is the app being active). Each window says so
/// from its own activation, as the app's "active window" isn't the question:
/// on the Mac it's NSApp.mainWindow, which stays set once the app is behind
/// another, and on X11 it moves after the callback. The main window, Settings
/// and each panel's window of its own; `SCRIPTED` is a script's `focus`.
static LOOKING: std::sync::Mutex<std::collections::BTreeSet<u64>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

pub(crate) const SCRIPTED: u64 = u64::MAX;

pub(crate) fn set_looking(window: u64, active: bool) {
    if let Ok(mut windows) = LOOKING.lock() {
        if active {
            windows.insert(window);
        } else {
            windows.remove(&window);
        }
    }
}

pub(crate) fn is_looking() -> bool {
    LOOKING.lock().map(|w| !w.is_empty()).unwrap_or(true)
}

/// While a script's command runs (automation's `step`), whose clicks and
/// keys go through the window but aren't Mike at it: a scripted Swift app
/// never counts as in front. A count, so a command inside another keeps it,
/// and put back by a guard, so a panic doesn't leave it set.
static SCRIPTED_INPUT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

struct ScriptedInput;

impl Drop for ScriptedInput {
    fn drop(&mut self) {
        SCRIPTED_INPUT.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

pub(crate) fn scripted_input<R>(f: impl FnOnce() -> R) -> R {
    SCRIPTED_INPUT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let _scripted = ScriptedInput;
    f()
}

pub(crate) fn input_is_scripted() -> bool {
    SCRIPTED_INPUT.load(std::sync::atomic::Ordering::Relaxed) > 0
}

/// A window's id for `set_looking`.
pub(crate) fn window_key(window: &Window) -> u64 {
    window.window_handle().window_id().as_u64()
}

/// Every message on its way, every thread's (core's outbox.rs), kept for
/// the whole app rather than in a pane: a pane goes when another thread is
/// opened, and a message held for a restarting runner can wait a minute and
/// more. A global, not the app's own field, so a pane, the sidebar and a
/// composer saving its draft can each read it from inside another update
/// without updating the app again. It's only ever moved by `move_outbox`,
/// whose closure reads nothing else, and its clock by `arm_clock`.
#[derive(Default)]
struct Shared {
    outbox: Outbox<crate::composer::RestoreDraft>,
    /// The app, for a deadline to show what it moved.
    app: Option<WeakEntity<crate::app::Threadbear>>,
    /// The timer that delivers the outbox's next deadline, and when.
    clock: Option<(std::time::Instant, Task<()>)>,
}

impl Global for Shared {}

fn read_outbox<R>(cx: &App, f: impl FnOnce(&Outbox<crate::composer::RestoreDraft>) -> R) -> R {
    match cx.try_global::<Shared>() {
        Some(shared) => f(&shared.outbox),
        None => f(&Outbox::default()),
    }
}

/// The only way the outbox moves: the event, then its clock set for its
/// next deadline.
fn move_outbox(
    event: OutboxEvent<crate::composer::RestoreDraft>,
    app: Option<&WeakEntity<crate::app::Threadbear>>,
    cx: &mut App,
) -> Effects<crate::composer::RestoreDraft> {
    let shared = cx.default_global::<Shared>();
    if let Some(app) = app {
        shared.app = Some(app.clone());
    }
    let effects = shared.outbox.next(event, std::time::Instant::now());
    arm_clock(cx);
    effects
}

/// Delivers `Clock` when the outbox's next deadline comes.
fn arm_clock(cx: &mut App) {
    let shared = cx.default_global::<Shared>();
    let deadline = shared.outbox.deadline();
    if shared.clock.as_ref().map(|(at, _)| *at) == deadline {
        return;
    }
    let Some(at) = deadline else {
        shared.clock = None;
        return;
    };
    let task = cx.spawn(async move |cx| {
        let wait = at.saturating_duration_since(std::time::Instant::now());
        cx.background_executor().timer(wait).await;
        cx.update(clock_came);
    });
    cx.default_global::<Shared>().clock = Some((at, task));
}

/// A deadline came: a taken message is called queued, a hold runs out.
fn clock_came(cx: &mut App) {
    cx.default_global::<Shared>().clock = None;
    let effects = move_outbox(OutboxEvent::Clock, None, cx);
    let app = cx.try_global::<Shared>().and_then(|s| s.app.clone());
    let Some(app) = app else { return };
    for thread in &effects.moved {
        show_outbox_in(&app, thread, cx);
    }
    if effects.moved.is_empty() && effects.let_go {
        app.update(cx, |_, cx| cx.notify()).ok();
    }
}

/// What's on its way to a thread, for its transcript.
pub(crate) fn outbox(thread_id: &str, cx: &App) -> Vec<PendingMessage> {
    read_outbox(cx, |o| o.pending(thread_id))
}

/// How many times the outbox has changed, for the sidebar's cache.
pub(crate) fn outbox_changes(cx: &App) -> u64 {
    read_outbox(cx, Outbox::changes)
}

/// The threads the sidebar has under Running for a message on its way
/// (`Outbox::sending`).
pub(crate) fn sending(cx: &App) -> Vec<String> {
    read_outbox(cx, Outbox::sending)
}

/// The runner said something new about a thread (`thread.updated`, or a
/// changed row in this Mac's list or another runner's): what it says now
/// goes, and a message it took no longer holds the thread under Running.
pub(crate) fn summary_arrived(thread_id: &str, cx: &mut App) {
    move_outbox(
        OutboxEvent::Summary {
            thread: thread_id.to_owned(),
        },
        None,
        cx,
    );
}

/// The boxes' words of a thread's messages not yet on their way (held for
/// the new runner, or behind another), oldest first, for the drafts file.
pub(crate) fn held_drafts(thread_id: &str, cx: &App) -> Vec<crate::composer::RestoreDraft> {
    read_outbox(cx, |o| {
        o.held_drafts(thread_id)
            .into_iter()
            // Their words as they went, a card's answers included.
            .map(|draft| {
                let (text, images) = draft.for_saving();
                crate::composer::RestoreDraft::plain(text, images)
            })
            .collect()
    })
}

/// A message of the thread's on its way to the runner and not answered yet:
/// a refusal would put its words back in a box a restart had already saved.
pub(crate) fn sending_now(thread_id: &str, cx: &App) -> bool {
    read_outbox(cx, |o| o.sending_now(thread_id))
}

/// How a send got on, as the connection's task reports it.
enum SendStep {
    Progress(Progress),
    Done(Result<Option<Value>, RpcError>),
}

pub struct ThreadPane {
    client: Arc<Client>,
    /// Its transcript and box on their way in as it opens (open_motion.rs).
    pub(crate) entering: crate::open_motion::Entering,
    /// The app, from the composer as the pane's made: never read from the
    /// composer later, as a send comes from inside the composer's own update.
    pub(crate) app: WeakEntity<crate::app::Threadbear>,
    pub(crate) summary: ThreadSummary,
    pub(crate) feed: ThreadFeed,
    /// How far its read has got (thread_load.rs): moved only by `move_load`.
    load: ThreadLoad,
    error: Option<String>,
    /// The wait before a message still queued on an idle thread is let go
    /// (`check_queued`).
    queued_check: Option<Task<()>>,
    /// A sub-agent's transcript rather than the thread's (`ThreadSession`'s
    /// `subagentId`): read whole with `threads.subagent`, no composer.
    pub(crate) subagent_id: Option<String>,
    /// A running sub-agent's read again for what's new is on its way.
    refreshing: bool,
    _poll: Option<Task<()>>,
    /// Following new lines was paused for a selection being dragged
    /// (selection_bar.rs), to take up again on release.
    pub(crate) selection_paused_follow: bool,
    pub(crate) scroller: Entity<TranscriptList>,
    /// Everything the rows themselves hold between frames (rows.rs).
    pub(crate) rows: crate::rows::RowsState,
    pub(crate) composer: Entity<Composer>,
    /// Tool and thinking rows opened, by row id (and "<row>|all" for a diff
    /// showing every line). Groups keep theirs in the model.
    pub(crate) open_rows: HashSet<String>,
    pub(crate) chosen: HashMap<String, HashMap<usize, Vec<String>>>,
    flush_queued: bool,
    /// Paging older history in above its rows (older_pages.rs).
    older: OlderPages,
    /// In a panel of its own whose tab is behind another: not in front of
    /// Mike, so not read (thread_panels.rs, `isShowing`).
    pub(crate) behind: bool,
    pub(crate) timing: LoadTiming,
    /// The zoom when it was kept (`set_kept`).
    kept_zoom: Option<u64>,
    /// Its last messages' PRs are still to be read ahead, waiting for the
    /// reply streaming in to be whole (`preload_recent_prs`).
    prs_to_preload: bool,
    /// The find bar over the transcript, while it's up (find.rs).
    pub(crate) find: Option<find::ThreadFind>,
    _subs: Vec<Subscription>,
}

impl ThreadPane {
    pub fn new(
        client: Arc<Client>,
        summary: ThreadSummary,
        composer: Entity<Composer>,
        cx: &mut Context<Self>,
    ) -> Self {
        find::bind_keys(cx);
        let scroller = cx.new(|cx| TranscriptList::new(0, cx));
        // Any scroll or layout change: older rows may be due and where the
        // view is reading is remembered for when the thread is left.
        let scrolled = cx.observe(&scroller, |this: &mut ThreadPane, _, cx| {
            this.after_list_change(cx)
        });
        let app = composer.read(cx).app.clone();
        let mut pane = ThreadPane {
            client,
            app,
            summary,
            feed: ThreadFeed::new(TranscriptModel::new(None)),
            load: ThreadLoad::opening(),
            error: None,
            queued_check: None,
            subagent_id: None,
            refreshing: false,
            _poll: None,
            scroller,
            selection_paused_follow: false,
            rows: Default::default(),
            composer,
            open_rows: HashSet::new(),
            chosen: HashMap::new(),
            flush_queued: false,
            older: OlderPages::default(),
            behind: false,
            timing: LoadTiming::default(),
            kept_zoom: None,
            prs_to_preload: false,
            entering: Default::default(),
            find: None,
            _subs: vec![scrolled],
        };
        // Messages still on their way to it from before it was last open.
        let _ = pane.feed.set_pending(outbox(&pane.summary.id, cx));
        // Its diagrams and pages drawing, and the web runtime (rich_boxes.rs).
        pane._subs.extend(crate::rich_boxes::watch(cx));
        pane.load(cx);
        pane.load_buttons(cx);
        pane
    }

    /// A sub-agent's transcript (`selectSubagent`): read again every 3 s
    /// while it runs, as the Swift app's `pollSubagent` does, and as the
    /// thread's summary says it has done something.
    pub fn new_subagent(
        client: Arc<Client>,
        summary: ThreadSummary,
        subagent_id: String,
        composer: Entity<Composer>,
        cx: &mut Context<Self>,
    ) -> Self {
        let scroller = cx.new(|cx| TranscriptList::new(0, cx));
        let app = composer.read(cx).app.clone();
        let mut pane = ThreadPane {
            client,
            app,
            summary,
            feed: ThreadFeed::new(TranscriptModel::new(None)),
            load: ThreadLoad::opening(),
            error: None,
            queued_check: None,
            subagent_id: Some(subagent_id),
            refreshing: false,
            _poll: None,
            scroller,
            selection_paused_follow: false,
            rows: Default::default(),
            composer,
            open_rows: HashSet::new(),
            chosen: HashMap::new(),
            flush_queued: false,
            older: OlderPages::default(),
            behind: false,
            timing: LoadTiming::default(),
            kept_zoom: None,
            prs_to_preload: false,
            entering: Default::default(),
            find: None,
            _subs: vec![],
        };
        pane._subs.extend(crate::rich_boxes::watch(cx));
        pane.load_subagent(cx);
        pane._poll = Some(cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_secs(3)).await;
            let Ok(running) = this.update(cx, |this, cx| {
                let running = this.subagent_live().is_some();
                this.refresh_subagent(cx);
                running
            }) else {
                break;
            };
            if !running {
                break;
            }
        }));
        pane
    }

    /// Where a read is up to (loaded, no record, failed, rows), for the
    /// automation's `subagent`.
    #[cfg(feature = "automation")]
    pub(crate) fn read_state(&self) -> (bool, bool, Option<String>, usize) {
        (
            self.load.is_shown(),
            self.load == ThreadLoad::NoRecord,
            self.load.failure(),
            self.feed.model().rows().len(),
        )
    }

    /// "Started by GPUI Port Coordinator · building the Browser pane": one
    /// quiet line above the transcript of a thread another thread started
    /// (the nestedThreads experiment), the starter's title a link to it.
    /// Plain words, no label over it, as Mike's UI rules ask.
    fn render_started_strip(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        // `tipped!` calls `test_support`, which this trait gives.
        use crate::sidebar::tipped;
        use gpui_kit::base::TestSupportExt as _;
        use gpui_kit::component::StyledExt as _;
        if self.subagent_id.is_some() {
            return None;
        }
        let app = self.app.upgrade()?;
        let line = app.read(cx).started_line(&self.summary)?;
        let secondary = crate::style::secondary_text(cx);
        let title: AnyElement = match line.thread_id.clone() {
            Some(id) => tipped!(
                div()
                    .cursor_pointer()
                    .font_medium()
                    .hover(move |s| s.underline().text_decoration_color(secondary)),
                ElementId::Name(format!("started-by-{id}").into()),
                format!("Open {}", line.title)
            )
            .child(line.title.clone())
            .on_click(move |_, window, cx| {
                let id = id.clone();
                app.update(cx, |a, cx| a.open(id, window, cx));
            })
            .into_any_element(),
            None => div().child(line.title.clone()).into_any_element(),
        };
        Some(
            gpui_kit::component::h_flex()
                .flex_none()
                .min_w_0()
                .px_7()
                .pt(px(8.))
                .pb(px(2.))
                .gap(px(4.))
                .text_size(px(12.))
                .text_color(secondary)
                .child(div().flex_none().child("Started by"))
                .child(title)
                .when_some(line.why, |s, why| {
                    s.child(div().min_w_0().truncate().child(format!("\u{b7} {why}")))
                })
                .into_any_element(),
        )
    }

    pub(crate) fn can_rewind(&self, cx: &App) -> bool {
        let fallback = || threadbear_core::composer::can_rewind(&self.summary.provider);
        let Some(app) = self.app.upgrade() else {
            return fallback();
        };
        let app = app.read(cx);
        let logins = match self.summary.runner_id.as_deref() {
            Some(runner) => app.remote.logins.get(runner),
            None => Some(&app.logins),
        };
        logins.map_or_else(fallback, |l| l.can_rewind(&self.summary.provider))
    }

    /// The pencil by one of Mike's messages (`editMessage`): its words and
    /// pictures go into the composer, and sending replaces it.
    pub(crate) fn edit_message(
        &mut self,
        row_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(row) = self.feed.model().item(row_id).cloned() else {
            return;
        };
        let RowContent::User(message) = &row.content else {
            return;
        };
        if !message.editable || !self.can_rewind(cx) {
            return;
        }
        let (seq, text, images) = (row.seq, message.text.clone(), message.images.clone());
        self.composer
            .update(cx, |c, cx| c.start_editing(seq, &text, &images, window, cx));
    }

    /// Its entry in the thread's list of sub-agents, as the summary has it now.
    pub(crate) fn subagent_entry(&self) -> Option<threadbear_core::sidebar::Subagent> {
        let id = self.subagent_id.as_deref()?;
        threadbear_core::sidebar::subagents(&self.summary)
            .into_iter()
            .find(|s| s.id == id)
    }

    /// When it started, in seconds, while it's still running: its working
    /// line follows that.
    fn subagent_live(&self) -> Option<f64> {
        self.subagent_entry()
            .filter(|s| s.running())
            .map(|s| s.started_ms() as f64 / 1000.)
    }

    /// Every event it has so far, in one read (`openSubagent`). No record of
    /// it (-32006) says so rather than failing.
    fn load_subagent(&mut self, cx: &mut Context<Self>) {
        let Some(subagent_id) = self.subagent_id.clone() else {
            return;
        };
        // Read again under rows already shown (its thread moved runners), it
        // only replaces them if it works: a failure stays out of sight, as it
        // always did, and it's never caught up later, so it isn't a reread.
        let first = !self.load.is_shown();
        if first {
            self.move_load(LoadEvent::Read, cx);
        }
        let (client, id, root) = (
            self.client.clone(),
            self.summary.id.clone(),
            self.summary.cwd.clone(),
        );
        cx.spawn(async move |this, cx| {
            let res = call(
                client,
                "threads.subagent",
                json!({ "threadId": id, "subagentId": subagent_id }),
            )
            .await;
            this.update(cx, |this, cx| {
                match res {
                    Ok(v) => {
                        let events: Vec<Event> = v["events"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Event::decode)
                            .collect();
                        let mut model = TranscriptModel::new(Some(root));
                        model.load(events, &[]);
                        model.known_start = true;
                        this.feed = ThreadFeed::new(model);
                        let live = this.subagent_live();
                        let _ = this.feed.set_live_turn(live.map(|_| ""), live);
                        this.move_load(LoadEvent::Landed, cx);
                        this.scroller
                            .update(cx, |s, cx| s.reset(this.feed.model().rows().len(), cx));
                        this.scroller.update(cx, |s, cx| s.scroll_to_end(cx));
                        this.find_rows_changed(cx);
                    }
                    Err(e) if e.code == -32006 && first => {
                        this.move_load(LoadEvent::NoRecord, cx);
                    }
                    Err(e) if first => {
                        this.move_load(LoadEvent::ReadFailed { message: e.message }, cx);
                    }
                    Err(_) => {}
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Reads a running sub-agent again and adds what's new (`refreshSubagent`):
    /// the runner numbers its events from 1 on every read and the CLI only adds
    /// to its record, so the new ones are past the last seq shown.
    pub(crate) fn refresh_subagent(&mut self, cx: &mut Context<Self>) {
        let Some(subagent_id) = self.subagent_id.clone() else {
            return;
        };
        if !self.load.is_shown() || self.refreshing {
            return;
        }
        self.refreshing = true;
        let (client, id) = (self.client.clone(), self.summary.id.clone());
        cx.spawn(async move |this, cx| {
            let res = call(
                client,
                "threads.subagent",
                json!({ "threadId": id, "subagentId": subagent_id }),
            )
            .await;
            this.update(cx, |this, cx| {
                this.refreshing = false;
                let Ok(v) = res else { return };
                let accepted = this.feed.accepted_seq();
                let fresh: Vec<Event> = v["events"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Event::decode)
                    .filter(|e| e.seq > accepted)
                    .collect();
                if !fresh.is_empty() {
                    let action = this.feed.catch_up(fresh);
                    this.handle(action, cx);
                }
                // Its working line goes once it has finished.
                let live = this.subagent_live();
                if this.feed.model().open_turn().is_some() != live.is_some() {
                    let change = this.feed.set_live_turn(live.map(|_| ""), live);
                    this.apply(change, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn client_handle(&self) -> Arc<Client> {
        self.client.clone()
    }

    pub fn stop(&mut self, cx: &mut Context<Self>) {
        if self.summary.busy() {
            self.request(
                "threads.interrupt",
                json!({ "threadId": self.summary.id }),
                cx,
            );
        }
    }

    /// Every row measured again, for a new zoom (their heights are in points).
    pub(crate) fn remeasure_rows(&mut self, cx: &mut Context<Self>) {
        let count = self.feed.model().rows().len();
        self.scroller.update(cx, |s, cx| {
            s.remeasure_items(0..count, cx);
        });
        cx.notify();
    }

    /// The thread's last message of his, for Send again (`sendAgain`).
    pub(crate) fn last_user_text(&self) -> Option<String> {
        self.feed
            .model()
            .rows()
            .iter()
            .rev()
            .take(80)
            .find_map(|row| match &row.content {
                RowContent::User(message) if !message.is_from_runner() => {
                    Some(message.text.clone())
                }
                _ => None,
            })
    }

    fn background_tasks(&self) -> Vec<BackgroundTask> {
        self.summary
            .background
            .iter()
            .flatten()
            .filter_map(BackgroundTask::decode)
            .collect()
    }

    pub fn load(&mut self, cx: &mut Context<Self>) {
        if self.subagent_id.is_some() {
            return self.load_subagent(cx);
        }
        let client = self.client.clone();
        let id = self.summary.id.clone();
        let root = self.summary.cwd.clone();
        self.move_load(LoadEvent::Read, cx);
        self.timing = LoadTiming {
            started: Some(std::time::Instant::now()),
            reads: self.timing.reads + 1,
            cold: !self.load.is_shown(),
            ..Default::default()
        };
        cx.spawn(async move |this, cx| {
            let v = match call(
                client.clone(),
                "threads.events",
                json!({ "threadId": id, "limit": EVENTS_PAGE }),
            )
            .await
            {
                Ok(v) => v,
                Err(e) => {
                    this.update(cx, |this, cx| {
                        // A reload over a transcript already shown keeps it,
                        // says so on the error line, and is tried again
                        // when it's next shown from the kept ones.
                        this.move_load(LoadEvent::ReadFailed { message: e.message }, cx);
                        threadbear_client::log::write(
                            "switch",
                            &format!(
                                "id={} from=read failed after_ms={:.0} up_s={}",
                                short_id(&this.summary.id),
                                this.timing.since(),
                                crate::app_log::uptime_s()
                            ),
                        );
                        cx.notify();
                    })
                    .ok();
                    return;
                }
            };
            let Ok(request_ms) = this.update(cx, |this, _| this.timing.since()) else {
                return;
            };
            // Turning a long thread's page into rows takes a while: off the
            // main thread, so the window goes on drawing (and the spinner
            // turning) meanwhile, as ThreadSession.open does.
            let prepared = cx
                .background_executor()
                .spawn(async move { prepare(v, Some(root)) })
                .await;
            // A pane let go while it read (evicted, pane_cache.rs) stops
            // here: subscribing for it would leave a subscription nobody ends.
            let Ok((after_seq, relay_seen)) = this.update(cx, |this, cx| {
                let Prepared {
                    mut model,
                    buttons,
                    at_start: _,
                    bytes,
                    decode_ms,
                    fold_ms,
                } = prepared;
                this.timing.request_ms = request_ms;
                this.timing.bytes = bytes;
                this.timing.decode_ms = decode_ms;
                this.timing.fold_ms = fold_ms;
                // Where the view was reading, if this is a reload.
                // A place still being paged back to wins: the page on its way
                // to it is let go with the old rows (older_pages.rs), so
                // paging back starts again from the new ones.
                let memory = this
                    .rows
                    .pending_restore
                    .take()
                    .or_else(|| this.load.is_shown().then(|| this.capture_memory(cx)));
                crate::reply_buttons::fold(&buttons, &this.summary.id);
                // What the thread's summary says now (ThreadSession.load),
                // not as it was when the read started: what's running in
                // the background and the runner's loose-ends check for the
                // done card.
                let _ = model.set_background(this.background_tasks());
                let _ = model.set_loose_ends(this.summary.loose_ends_check());
                this.feed = ThreadFeed::new(model);
                // What's still on its way stays at the end, less what this
                // page shows arrived (a reload after a restart brings them).
                let _ = this.feed.set_pending(outbox(&this.summary.id, cx));
                this.keep_outbox(cx);
                // Another runner's thread through this Mac's runner has
                // gaps in its seqs (`feed.sparse = viaRelay`).
                this.feed.set_sparse(this.summary.runner_id.is_some());
                this.feed.begin_subscribe();
                // Its rows show; a reload that worked puts right the one that
                // didn't, on the error line too.
                this.move_load(LoadEvent::Landed, cx);
                // Paging starts over from the new newest page.
                this.older.newest_read();
                this.scroller
                    .update(cx, |s, cx| s.reset(this.feed.model().rows().len(), cx));
                this.restore_memory(memory, cx);
                this.find_rows_changed(cx);
                this.mark_seen();
                this.prs_to_preload = !this.preload_recent_prs(cx);
                // Paging older rows in is driven by the view reaching the
                // top, and a first page shorter than the view can't.
                this.load_older_if_near_top(cx);
                this.timing.ready_ms = Some(this.timing.since());
                cx.notify();
                (this.feed.accepted_seq(), this.feed.relay_seen())
            }) else {
                return;
            };
            after_unsubscribe(&id).await;
            // Let go while it waited: no subscription for a pane that's gone.
            if this.update(cx, |_, _| ()).is_err() {
                return;
            }
            let mut params = json!({ "threadId": id, "afterSeq": after_seq });
            if let Some(seen) = relay_seen {
                params["relaySeen"] = json!(seen);
            }
            let sub = call(client, "threads.subscribe", params).await;
            this.update(cx, |this, cx| {
                match sub.ok().and_then(|v| EventsPage::decode(&v)) {
                    Some(page) => {
                        // Read and subscribed again: up to date, whatever an
                        // earlier try left (`shows_old_turn`).
                        this.move_load(LoadEvent::Subscribed, cx);
                        let action = this.feed.finish_subscribe(page.events, &page.in_progress);
                        this.handle(action, cx);
                    }
                    // Not subscribed: the next connection reads it again, and
                    // so does showing it again from the kept ones (`shown_again`).
                    None => {
                        this.feed.catch_up_failed();
                        this.move_load(LoadEvent::SubscribeFailed, cx);
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// The only writer of `load` (thread_load.rs): moves it on, does what
    /// the move says to the error line, which sends and card buttons write
    /// too, and redraws the pane if anything changed (it's a cached view, so
    /// its parent redrawing doesn't). A sub-agent's read never cleared the
    /// error line.
    fn move_load(&mut self, event: LoadEvent, cx: &mut Context<Self>) -> LoadThen {
        let was = self.load.clone();
        let (load, then) = std::mem::replace(&mut self.load, ThreadLoad::opening()).next(event);
        self.load = load;
        let error = self.error.clone();
        match &then {
            LoadThen::SayOnErrorLine(message) => self.error = Some(message.clone()),
            LoadThen::ClearErrorLine if self.subagent_id.is_none() => self.error = None,
            LoadThen::ClearErrorLine | LoadThen::CatchUp | LoadThen::Nothing => {}
        }
        if self.load != was || self.error != error {
            cx.notify();
        }
        then
    }

    /// Kept loaded while another thread's shown (pane_cache.rs): not in
    /// front of Mike, so news to it doesn't mark it read, and the zoom it was
    /// measured at, so its rows are measured again if that's changed.
    pub(crate) fn set_kept(&mut self, cx: &mut Context<Self>) {
        self.behind = true;
        self.kept_zoom = Some(crate::style::layout_key());
        // Older pages paged in while it was read go, as Swift's sessions
        // do once hidden: it's kept for coming back to the end of it, and
        // they're read again if it's scrolled up to them.
        let _ = self.trim_kept(cx);
    }

    /// A kept pane with more than `KEPT_EVENTS` back to its newest page, at
    /// the end of it: where it was reading may have gone with the older
    /// pages, and going back there would only read them in again. Also as
    /// news comes to a kept thread that's busy (`apply`).
    fn trim_kept(&mut self, cx: &mut Context<Self>) -> bool {
        let trim = self.load.is_shown()
            && self.feed.model().events().len() > KEPT_EVENTS
            && !self.feed.has_pending();
        if trim {
            self.feed.trim(EVENTS_PAGE as usize);
            // Back to the end of it: a place it was paging back to is given
            // up with the page on its way there.
            self.older.trimmed();
            self.rows.pending_restore = None;
            self.scroller.update(cx, |s, cx| {
                s.reset(self.feed.model().rows().len(), cx);
                s.scroll_to_end(cx);
            });
        }
        trim
    }

    /// Its transcript is from before the connection last went, and the
    /// thread's summary says the turn it shows running has ended: what it
    /// shows is old, so its working line says it's catching up rather than
    /// counting on. A kept thread opened while the runner was restarting
    /// still showed "Bear with me" ticking from a transcript 30 minutes old,
    /// a turn that had ended 2 minutes before, while the sidebar rightly had
    /// it in the Inbox (19 Nov).
    /// Catching up counts too: what it shows is old till that lands.
    pub(crate) fn shows_old_turn(&self) -> bool {
        (self.load.shows_old() || self.feed.is_catching_up()) && !self.summary.busy()
    }

    /// The connection's back while this pane is kept and not shown: it
    /// catches up when it's next shown, rather than every kept thread asking
    /// at once while a restarted runner is busiest.
    pub(crate) fn connection_back(&mut self, cx: &mut Context<Self>) {
        self.move_load(LoadEvent::ConnectionBack, cx);
    }

    /// Shown again from the threads kept loaded (pane_cache.rs): straight
    /// away as it was, read as it's in front, and caught up from its last seq
    /// if the connection came back while it was kept.
    pub(crate) fn shown_again(&mut self, cx: &mut Context<Self>) {
        self.behind = false;
        // Rows are measured in points: a zoom since it was last shown
        // (shell.rs only remeasures the panes on show).
        if self
            .kept_zoom
            .take()
            .is_some_and(|z| z != crate::style::layout_key())
        {
            self.remeasure_rows(cx);
        }
        // Behind since the connection came back, or its first read failed
        // while it was kept: read now.
        if self.move_load(LoadEvent::ShownAgain, cx) == LoadThen::CatchUp {
            self.resubscribe(cx);
        }
        self.mark_seen();
        // What's on its way to it as the outbox has it now.
        self.show_outbox(cx);
        if self.load.is_shown() {
            self.prs_to_preload = !self.preload_recent_prs(cx);
        }
    }

    /// Reads ahead the PRs its last few
    /// messages link to, as the thread shows and as a turn ends: those are
    /// the ones likely to be clicked, and a read takes a second or more
    /// (Mike, 19 Nov). Each is read once while the app runs, from the
    /// cache's copy if an earlier run kept one (pr_view.rs `preload_pr`).
    /// A reply still streaming in could hold half a link, so nothing is
    /// read while one is (false: `apply` tries again until it's whole).
    /// After the update it's
    /// called in: showing a kept pane again is inside the app's own, and
    /// reading the app there panics.
    fn preload_recent_prs(&self, cx: &mut Context<Self>) -> bool {
        use threadbear_core::pull_requests as prs;
        if self.subagent_id.is_some() {
            return true;
        }
        let recent: Vec<(&str, bool)> = self
            .feed
            .model()
            .rows()
            .iter()
            .rev()
            .filter_map(|row| match &row.content {
                RowContent::Assistant(item) => Some((item.text.as_str(), item.is_streaming)),
                RowContent::User(message) => Some((message.text.as_str(), false)),
                _ => None,
            })
            .take(prs::RECENT_MESSAGES)
            .collect();
        if recent.iter().any(|(_, streaming)| *streaming) {
            return false;
        }
        let urls = prs::recent_pr_links(recent.into_iter().map(|(text, _)| text), prs::RECENT_PRS);
        if urls.is_empty() {
            return true;
        }
        let app = self.app.clone();
        cx.defer(move |cx| {
            let Some(app) = app.upgrade() else { return };
            let side = app.read(cx).side.clone();
            side.update(cx, |side, cx| {
                urls.iter().for_each(|url| side.preload_pr(url, cx))
            });
        });
        true
    }

    /// What happened while it wasn't subscribed, from the last seq it has
    /// (ThreadSession.subscribe after a reconnect): `threads.subscribe` with
    /// `afterSeq`, whose answer has the events since and the text of anything
    /// still streaming. One that never finished its first read reads it now,
    /// and one far behind reads its newest page again rather than every event
    /// since, keeping what it shows until that lands.
    pub(crate) fn resubscribe(&mut self, cx: &mut Context<Self>) {
        if self.subagent_id.is_some() {
            return;
        }
        let behind = i64::try_from(self.summary.last_seq)
            .unwrap_or(i64::MAX)
            .saturating_sub(self.feed.accepted_seq());
        // Another runner's thread: its summary's `last_seq` isn't the relay's
        // seqs (remote.rs), so how far behind it is can't be told, and its
        // newest page is read rather than everything since.
        let remote = self.summary.runner_id.is_some();
        if !self.load.is_shown() || remote || behind > CATCH_UP_LIMIT {
            // Back to the spinner from a failed first read, as Try again does.
            self.move_load(LoadEvent::TryAgain, cx);
            return self.load(cx);
        }
        self.feed.begin_subscribe();
        let (client, id, after_seq, relay_seen) = (
            self.client.clone(),
            self.summary.id.clone(),
            self.feed.accepted_seq(),
            self.feed.relay_seen(),
        );
        cx.spawn(async move |this, cx| {
            after_unsubscribe(&id).await;
            // Let go while it waited: no subscription for a pane that's gone.
            if this.update(cx, |_, _| ()).is_err() {
                return;
            }
            let mut params = json!({ "threadId": id, "afterSeq": after_seq });
            if let Some(seen) = relay_seen {
                params["relaySeen"] = json!(seen);
            }
            let sub = call(client, "threads.subscribe", params).await;
            this.update(cx, |this, cx| {
                match sub.ok().and_then(|v| EventsPage::decode(&v)) {
                    Some(page) => {
                        this.move_load(LoadEvent::Subscribed, cx);
                        crate::reply_buttons::fold(&page.events, &this.summary.id);
                        let action = this.feed.finish_subscribe(page.events, &page.in_progress);
                        this.handle(action, cx);
                    }
                    // The next connection, or the next time it's shown, tries again.
                    None => {
                        this.feed.catch_up_failed();
                        this.move_load(LoadEvent::SubscribeFailed, cx);
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// Try again, after the first read failed: back to Loading… at once.
    fn retry_load(&mut self, cx: &mut Context<Self>) {
        self.move_load(LoadEvent::TryAgain, cx);
        cx.notify();
        self.load(cx);
    }

    /// "Couldn't load this thread.", what went wrong, and Try again, where
    /// the transcript would be (DetailView's failed state).
    fn render_load_failure(&self, message: String, cx: &mut Context<Self>) -> AnyElement {
        let secondary = crate::style::secondary_text(cx);
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .items_center()
            .justify_center()
            .child(
                v_flex()
                    .max_w(px(420.))
                    .px(px(20.))
                    .gap(px(8.))
                    .items_center()
                    .child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(crate::style::natural_line(13.)))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(if self.subagent_id.is_some() {
                                "Couldn't load this sub-agent."
                            } else {
                                "Couldn't load this thread."
                            }),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(crate::style::natural_line(13.)))
                            .text_color(secondary)
                            .text_center()
                            .child(message),
                    )
                    // A regular push button, as Swift's Button("Try again").
                    .child(
                        crate::push_button::PushButton::new(
                            "load-retry",
                            "Try again",
                            if self.subagent_id.is_some() {
                                "Load the sub-agent's transcript again"
                            } else {
                                "Load the thread again"
                            },
                        )
                        .render(cx, {
                            let me = cx.entity().downgrade();
                            move |_, _, cx| {
                                me.update(cx, |this, cx| this.retry_load(cx)).ok();
                            }
                        }),
                    ),
            )
            .into_any_element()
    }

    // Opening it reads it, as on the Mac, while the window's in front: one
    // opened behind other windows stays unread until he comes back to it.
    pub(crate) fn mark_seen(&self) {
        // Reading a sub-agent isn't reading its thread.
        if self.summary.unread() && is_looking() && self.subagent_id.is_none() && !self.behind {
            let client = self.client.clone();
            let params = json!({ "threadId": self.summary.id, "seq": self.summary.last_seq });
            RT.spawn(async move { client.call("threads.markSeen", params).await });
        }
    }

    pub fn unsubscribe(&self) {
        if self.subagent_id.is_some() {
            return;
        }
        let client = self.client.clone();
        let params = json!({ "threadId": self.summary.id });
        let (done, wait) = futures::channel::oneshot::channel::<()>();
        if let Ok(mut map) = UNSUBSCRIBING.lock() {
            map.entry(self.summary.id.clone()).or_default().push(wait);
        }
        RT.spawn(async move {
            let _ = client.call("threads.unsubscribe", params).await;
            let _ = done.send(());
        });
    }

    pub fn summary_changed(&mut self, t: &ThreadSummary, cx: &mut Context<Self>) {
        if t.id == self.summary.id && self.subagent_id.is_some() {
            let before = self
                .subagent_entry()
                .map(|s| (s.status, s.tool_uses, s.activity));
            self.summary = t.clone();
            if self
                .subagent_entry()
                .map(|s| (s.status, s.tool_uses, s.activity))
                != before
            {
                self.refresh_subagent(cx);
            }
            cx.notify();
            return;
        }
        if t.id == self.summary.id {
            self.summary = t.clone();
            if self.load.is_shown() {
                self.mark_seen();
                let change = self.feed.set_background(self.background_tasks());
                self.apply(change, cx);
                // A new check (a turn done, a Land, a thread it started
                // finishing) or none (a turn starting): AppModel+Connection.
                let change = self.feed.set_loose_ends(self.summary.loose_ends_check());
                self.apply(change, cx);
            }
            self.check_queued(cx);
            cx.notify();
        }
    }

    pub fn event(&mut self, params: &Value, cx: &mut Context<Self>) {
        if params["threadId"].as_str() != Some(self.summary.id.as_str()) {
            return;
        }
        if let Some(event) = Event::decode(&params["event"]) {
            if crate::reply_buttons::fold(std::slice::from_ref(&event), &self.summary.id) {
                cx.notify();
            }
            if self.subagent_id.is_none() && self.summary.runner_id.is_none() {
                // This Mac's runner shows a message before its summary.
                move_outbox(
                    OutboxEvent::Heard {
                        thread: self.summary.id.clone(),
                        event: event.clone(),
                    },
                    None,
                    cx,
                );
            }
            let action = self.feed.receive(event);
            self.handle(action, cx);
        }
    }

    /// Every button the thread has (`buttons.list`): replies older than the
    /// loaded page link buttons whose events aren't loaded.
    fn load_buttons(&self, cx: &mut Context<Self>) {
        let (client, id) = (self.client.clone(), self.summary.id.clone());
        cx.spawn(async move |this, cx| {
            let Ok(v) = call(client, "buttons.list", json!({ "threadId": id })).await else {
                return;
            };
            let list: Vec<threadbear_core::reply_buttons::ReplyButton> = v["buttons"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(threadbear_core::reply_buttons::ReplyButton::decode)
                .collect();
            if crate::reply_buttons::receive(list, &id) {
                this.update(cx, |_, cx| cx.notify()).ok();
            }
        })
        .detach();
    }

    fn handle(&mut self, action: FeedAction, cx: &mut Context<Self>) {
        match action {
            FeedAction::None => {}
            FeedAction::ScheduleFlush => self.schedule_flush(cx),
            FeedAction::NeedsCatchUp { after_seq } => self.catch_up(after_seq, cx),
        }
    }

    fn schedule_flush(&mut self, cx: &mut Context<Self>) {
        if self.flush_queued {
            return;
        }
        self.flush_queued = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(FLUSH_EVERY).await;
            this.update(cx, |this, cx| {
                this.flush_queued = false;
                let change = this.feed.flush();
                this.apply(change, cx);
            })
            .ok();
        })
        .detach();
    }

    fn catch_up(&mut self, after_seq: i64, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let id = self.summary.id.clone();
        cx.spawn(async move |this, cx| {
            let page = call(
                client,
                "threads.events",
                json!({ "threadId": id, "afterSeq": after_seq }),
            )
            .await;
            this.update(cx, |this, cx| {
                match page.ok().and_then(|v| EventsPage::decode(&v)) {
                    Some(page) => {
                        let action = this.feed.catch_up(page.events);
                        this.handle(action, cx);
                    }
                    None => this.feed.catch_up_failed(),
                }
            })
            .ok();
        })
        .detach();
    }

    /// Tells the list what the reducer changed, so it keeps its place: rows
    /// gone first, from the bottom up, then new ones from the top down. GPUI's
    /// list holds the view on the row at its top (or follows the tail) across
    /// all of it, which is what `apply` in TranscriptController did by hand.
    pub(crate) fn apply(&mut self, change: TranscriptChange, cx: &mut Context<Self>) {
        self.keep_outbox(cx);
        if change.is_empty() {
            return;
        }
        // A turn's footer: it's over, its reply whole. The runner's word
        // that it's idle can come before the reply's row, so not that.
        // Only the thread on show: a kept one's turns end unwatched.
        let turn_ended = self.kept_zoom.is_none()
            && change.inserted.iter().any(|&i| {
                matches!(
                    self.feed.model().rows().get(i).map(|r| &r.content),
                    Some(RowContent::Footer(_))
                )
            });
        if self.prs_to_preload || turn_ended {
            self.prs_to_preload = !self.preload_recent_prs(cx);
        }
        // Kept and not shown (`set_kept`): a busy thread's events don't
        // pile up in it while nobody's looking.
        if self.kept_zoom.is_some() && self.trim_kept(cx) {
            return;
        }
        self.scroller.update(cx, |s, cx| {
            for &i in change.removed.iter().rev() {
                s.splice(i..i + 1, 0, cx);
            }
            for &i in change.inserted.iter() {
                s.splice(i..i, 1, cx);
            }
            for &i in change.updated.iter() {
                s.remeasure_items(i..i + 1, cx);
            }
        });
        self.find_rows_changed(cx);
        cx.notify();
    }

    pub(crate) fn send(&mut self, text: String, answers: Option<Value>, cx: &mut Context<Self>) {
        self.send_message(
            text,
            Vec::new(),
            answers.unwrap_or(Value::Null),
            None,
            WeakEntity::new_invalid(),
            cx,
        );
    }

    /// What the model shows as on its way, told to the outbox: what it no
    /// longer has has landed (or an edit cut it). A sub-agent's pane never
    /// sends.
    fn keep_outbox(&self, cx: &mut Context<Self>) {
        if self.subagent_id.is_some() {
            return;
        }
        let list = self.feed.model().pending().to_vec();
        let event = OutboxEvent::Transcript {
            thread: self.summary.id.clone(),
            list,
        };
        move_outbox(event, Some(&self.app), cx);
    }

    /// The outbox's messages for this thread on show again, after a send's
    /// task changed them.
    fn show_outbox(&mut self, cx: &mut Context<Self>) {
        if self.subagent_id.is_some() {
            return;
        }
        let change = self.feed.set_pending(outbox(&self.summary.id, cx));
        self.apply(change, cx);
        self.check_queued(cx);
        cx.notify();
    }

    /// Why a message to this thread can't go now, if it can't: no runner,
    /// and no restart under way to wait for (`send`'s `guard ready != nil ||
    /// holding`). The words stay in the box.
    pub(crate) fn cant_send_now(&self) -> Option<String> {
        let held = self.summary.runner_id.is_none() && self.client.restart_under_way();
        (self.client.connected_session().is_none() && !held).then(|| NOT_CONNECTED_TEXT.to_owned())
    }

    /// Sends a message (AppModel.post): it shows dimmed at the end of the
    /// transcript straight away, and goes back into the box if the runner
    /// doesn't take it, with the error bar saying so. Sent while the runner
    /// restarts, it waits in the transcript for the new one ("Runner
    /// restarting. Sends when it's back."). `draft` is what to give back.
    pub(crate) fn send_message(
        &mut self,
        text: String,
        images: Vec<ImageRef>,
        answers: Value,
        draft: Option<crate::composer::RestoreDraft>,
        composer: WeakEntity<Composer>,
        cx: &mut Context<Self>,
    ) {
        // Sending moves on from whatever went wrong before; a send that
        // fails says so again.
        self.error = None;
        // By count, never its words (activity.rs).
        crate::activity::sent(
            Some(&self.summary.id),
            images.len(),
            answers
                .as_object()
                .map(|a| a.len())
                .or_else(|| answers.as_array().map(Vec::len))
                .unwrap_or(0),
            false,
        );
        let thread_id = self.summary.id.clone();
        let app = self.app.clone();
        // Another Mac's thread goes through this Mac's runner, whose restart
        // isn't that runner's: it's sent as it is.
        let remote = self.summary.runner_id.is_some();
        let holding =
            !remote && self.client.connected_session().is_none() && self.client.restart_under_way();
        // Only a user.message after this can be it: the thread's last seq as
        // the summary has it, if the transcript hasn't caught up (a pane
        // that's still loading), so an older one with the same words isn't.
        let after_seq = self
            .feed
            .accepted_seq()
            .max(i64::try_from(self.summary.last_seq).unwrap_or(i64::MAX));
        // A card's answers aren't in the box's words: the message as it
        // goes, back in the box's form, so a quit keeps them too, held or
        // given back (`RestoreDraft::for_saving`).
        let mut draft = draft;
        if let Some(draft) = draft.as_mut().filter(|d| d.card.is_some()) {
            let (words, order) = threadbear_core::composer::edit_draft(&text, images.len());
            draft.as_sent = Some((
                words,
                order
                    .into_iter()
                    .filter_map(|i| images.get(i).cloned())
                    .collect(),
            ));
        }
        // Shown straight away and put right when the runner echoes it back.
        let sending = Sending {
            thread: thread_id.clone(),
            text: text.clone(),
            images: images.clone(),
            after_seq,
            remote,
            holding,
            busy: self.summary.busy(),
            draft,
        };
        let Some((pending_id, ticket)) =
            move_outbox(OutboxEvent::Send(sending), Some(&self.app), cx).ticket
        else {
            return;
        };
        self.show_outbox(cx);
        // The sidebar watches the app, not this pane: it moves the thread out
        // of the Inbox now (`thread::sending`).
        self.app.update(cx, |_, cx| cx.notify()).ok();
        self.scroller.update(cx, |s, cx| s.scroll_to_end(cx));

        // The runner it's shown on (null for this Mac's), so this Mac's
        // runner refuses it rather than passing it to any other (Daybreak 113).
        let mut params =
            json!({ "threadId": thread_id, "text": text, "runnerId": self.summary.runner_id });
        if !images.is_empty() {
            params["images"] = json!(images
                .iter()
                .map(crate::composer::image_ref_json)
                .collect::<Vec<_>>());
        }
        if !answers.is_null() {
            params["answers"] = answers;
        }
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<SendStep>();
        let told = tx.clone();
        let gate = ticket.gate.clone();
        let progress: ProgressFn = Arc::new(move |p| {
            // At once, from the connection's task: the quit's drafts read it
            // straight after `stop_holding` (`held_drafts`).
            gate.set(p == Progress::Held);
            let _ = told.unbounded_send(SendStep::Progress(p));
        });
        let probe = ticket.message.clone();
        let resend = Resend {
            thread_id: thread_id.clone(),
            after_seq: ticket.message.after_seq,
            was_idle: ticket.was_idle,
            landed: Arc::new(move |v: &Value| {
                Event::decode(v).is_some_and(|e| probe.is_landed_by(&e))
            }),
        };
        let client = self.client.clone();
        // Its place among this runner's requests, from the click (`Place`).
        let place = (!remote).then(|| client.place(&thread_id));
        RT.spawn(async move {
            let res = match place {
                Some(place) => {
                    client
                        .send_through_restart(place, params, resend, progress)
                        .await
                }
                None => client.call("threads.send", params).await.map(Some),
            };
            let _ = tx.unbounded_send(SendStep::Done(res));
        });
        let title = self.summary.title.clone();
        cx.spawn(async move |_, cx| {
            use futures::StreamExt as _;
            let mut res = Err(RpcError {
                code: threadbear_client::runner::CLOSED,
                message: "The connection to the runner closed".into(),
                data: None,
            });
            while let Some(step) = rx.next().await {
                match step {
                    // Held for the new runner, or going now: the bubble's note.
                    SendStep::Progress(p) => {
                        let event = OutboxEvent::Progress {
                            id: pending_id.clone(),
                            still_to_go: p == Progress::Held,
                        };
                        cx.update(|cx| {
                            move_outbox(event, None, cx);
                            show_outbox_in(&app, &thread_id, cx);
                        });
                    }
                    SendStep::Done(done) => {
                        res = done;
                        break;
                    }
                }
            }
            // A connection that closed with it on its way, or no answer in
            // time: it may have arrived, which its echo says.
            let answer = match &res {
                Ok(_) => Answer::Took,
                Err(e)
                    if matches!(
                        e.code,
                        threadbear_client::runner::TIMED_OUT | threadbear_client::runner::CLOSED
                    ) =>
                {
                    Answer::MayHaveArrived
                }
                Err(_) => Answer::Refused,
            };
            let event = OutboxEvent::Answered {
                id: pending_id,
                answer,
            };
            let effects = cx.update(|cx| move_outbox(event, None, cx));
            // Shown again, and the drafts file written again, whatever the
            // answer: a message once held is in that file until then, and
            // one that turned out to have arrived mustn't stay there to come
            // back after a crash (Codex's review, 21 Nov). Off the end of
            // the transcript if it failed.
            cx.update(|cx| show_outbox_in(&app, &thread_id, cx));
            let (Some(draft), Err(e)) = (effects.gave_back, res) else {
                return;
            };
            // Back in the box, and the error bar says so, naming the thread,
            // until it's dismissed.
            if let (Some(composer), Some(draft)) = (composer.upgrade(), draft) {
                composer.update(cx, |c, cx| c.restore_draft(draft, cx));
            }
            app.update(cx, |app, cx| app.show_send_failed(&e, &title, holding, cx))
                .ok();
        })
        .detach();
    }

    /// A queued message starts its own turn once the thread is free, so one
    /// still queued after the thread has sat idle a while was lost on the
    /// way: it goes rather than wait there for good (`checkQueued`).
    pub(crate) fn check_queued(&mut self, cx: &mut Context<Self>) {
        if self.summary.busy()
            || !self.feed.model().pending().iter().any(|m| m.queued)
            || self.queued_check.is_some()
        {
            return;
        }
        self.queued_check = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(QUEUED_GRACE).await;
            this.update(cx, |this, cx| {
                this.queued_check = None;
                if !this.summary.busy() && this.feed.model().pending().iter().any(|m| m.queued) {
                    let event = OutboxEvent::QueuedLost {
                        thread: this.summary.id.clone(),
                    };
                    move_outbox(event, None, cx);
                    this.show_outbox(cx);
                }
            })
            .ok();
        }));
    }

    /// Return in an empty box allows the sole waiting approval, the ⏎ its
    /// Allow button shows (ComposerView.allowSoleApproval); with two, Return
    /// can't know which, and another runner asking for a thread is started
    /// only by a click on its card.
    pub(crate) fn allow_sole_approval(&mut self, cx: &mut Context<Self>) -> bool {
        let pending = self.feed.model().pending_approval_ids();
        let [id] = pending.as_slice() else {
            return false;
        };
        let id = id.clone();
        let stacked = match self.feed.model().item(&format!("ap:{id}")) {
            Some(Row {
                content: RowContent::Approval(item),
                ..
            }) if item.is_start_request() => return false,
            Some(Row {
                content: RowContent::Approval(item),
                ..
            }) => !item.queued().is_empty(),
            _ => false,
        };
        // A stacked card's Return is its "Allow N": the ticked calls only,
        // the crossed ones refused (Codex review, 10 Nov 2026: a bare allow
        // here ran a call Mike had crossed out). Either way the card spins
        // until the answer lands.
        if stacked {
            self.respond_queued(&id, "allow", cx);
        } else {
            self.respond_approval(&id, "allow", None, None, cx);
        }
        true
    }

    /// The composer's picks on the open card, handed to the reducer so its
    /// row reads them (ThreadSession.setAskPicks and friends).
    pub(crate) fn set_card_picks(
        &mut self,
        seq: i64,
        picks: std::collections::BTreeMap<i64, i64>,
        notes: std::collections::BTreeMap<i64, threadbear_core::reducer::AskNote>,
        next: std::collections::BTreeSet<i64>,
        explain: std::collections::BTreeSet<i64>,
        cx: &mut Context<Self>,
    ) {
        let change = self.feed.set_ask_picks(seq, picks);
        self.apply(change, cx);
        let change = self.feed.set_ask_notes(seq, notes);
        self.apply(change, cx);
        let change = self.feed.set_next_picks(seq, next, explain);
        self.apply(change, cx);
        cx.notify();
    }

    /// Something the composer tried that didn't work, for the error line.
    pub(crate) fn show_error(&mut self, message: String, cx: &mut Context<Self>) {
        self.error = Some(message);
        cx.notify();
    }

    /// The error line over the transcript, with a Dismiss. It used to be
    /// bare words that only went when some later card button's request
    /// happened to work, so a failed picture ("Couldn't add that picture:
    /// Not connected to the runner", 17 Nov) sat there for good.
    fn render_error_line(
        &self,
        error: String,
        danger: Hsla,
        muted: Hsla,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        use crate::sidebar::tipped;
        use gpui_kit::base::TestSupportExt as _;
        gpui_kit::component::h_flex()
            .flex_none()
            .px_7()
            .py_1()
            .gap(px(8.))
            .items_center()
            .text_sm()
            .child(div().flex_1().min_w_0().text_color(danger).child(error))
            .child(
                tipped!(
                    div()
                        .flex_none()
                        .cursor_pointer()
                        .px(px(6.))
                        .py(px(2.))
                        .rounded(px(5.))
                        .text_color(muted)
                        .hover(|s| s.underline()),
                    "thread-error-dismiss",
                    "Hide this message"
                )
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.error = None;
                    cx.notify();
                }))
                .child("Dismiss"),
            )
            .into_any_element()
    }

    pub(crate) fn request(&mut self, method: &'static str, params: Value, cx: &mut Context<Self>) {
        let going = crate::call_action(self.client.clone(), method, params);
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |this, cx| {
                this.error = res.err().map(|e| e.message);
                this.scroller.update(cx, |s, cx| s.scroll_to_end(cx));
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A request that says how it went, for cards that show a spinner until
    /// the answer lands and need their buttons back when it doesn't.
    pub(crate) fn request_then(
        &mut self,
        method: &'static str,
        params: Value,
        done: impl FnOnce(&mut Self, bool, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        let going = crate::call_action(self.client.clone(), method, params);
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |this, cx| {
                let failed = res.is_err();
                this.error = res.err().map(|e| e.message);
                done(this, failed, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The composer takes the cursor, as Send back on a plan asks.
    pub(crate) fn focus_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.composer
            .clone()
            .update(cx, |c, cx| c.focus(window, cx));
        crate::web_panels::keyboard_to_app(window);
    }

    pub(crate) fn toggle_row(&mut self, row: &Row, cx: &mut Context<Self>) {
        let open = !self.row_open(row);
        self.set_open(row, open, cx);
    }

    /// "Show 30 more lines" under an opened diff: every line of it.
    pub(crate) fn show_all_lines(&mut self, key: &str, row_id: &str, cx: &mut Context<Self>) {
        self.open_rows.insert(key.to_owned());
        if let Some(i) = self.feed.model().index_of(row_id) {
            self.scroller.update(cx, |s, cx| {
                s.remeasure_items(i..i + 1, cx);
            });
        }
        cx.notify();
    }

    /// A part of a row that opens and closes by itself (a review finding's
    /// case, say): its key in `open_rows`, and the row remeasured.
    pub(crate) fn toggle_part(&mut self, key: &str, row_id: &str, cx: &mut Context<Self>) {
        if !self.open_rows.remove(key) {
            self.open_rows.insert(key.to_owned());
        }
        if let Some(i) = self.feed.model().index_of(row_id) {
            self.scroller.update(cx, |s, cx| {
                s.remeasure_items(i..i + 1, cx);
            });
        }
        cx.notify();
    }

    /// Older events have been reached, or the list moved: asks for an older
    /// page when the top is near, and remembers where the view is.
    fn after_list_change(&mut self, cx: &mut Context<Self>) {
        self.load_older_if_near_top(cx);
        if self.load.is_shown() {
            crate::rows::remember_scroll(&self.summary.id, self.capture_memory(cx));
        }
    }

    /// Its first page is in (a handover waits for the open thread's).
    pub(crate) fn is_loaded(&self) -> bool {
        self.load.is_shown()
    }

    /// Still bringing older pages in to get back to a remembered place.
    pub(crate) fn restoring_place(&self) -> bool {
        self.rows.pending_restore.is_some()
    }

    /// Where the outgoing app had this thread scrolled to as it handed over.
    pub(crate) fn take_handed_memory(
        &mut self,
        memory: crate::rows::ScrollMemory,
        cx: &mut Context<Self>,
    ) {
        if !self.load.is_shown() {
            return;
        }
        // The place it was still paging back to is the old one now
        // (Codex's second look).
        self.rows.pending_restore = None;
        if memory.pinned {
            self.scroller.update(cx, |s, cx| s.scroll_to_end(cx));
        } else {
            self.restore_memory(Some(memory), cx);
        }
    }

    /// `captureMemory`: pinned to the bottom, or the row at the top of the
    /// view and how far down it the view starts (a row part scrolled off the
    /// top has a negative offset, as the Swift app measures it).
    pub(crate) fn capture_memory(&self, cx: &App) -> crate::rows::ScrollMemory {
        let scroller = self.scroller.read(cx);
        if scroller.at_bottom() {
            return crate::rows::ScrollMemory {
                pinned: true,
                anchor_id: None,
                offset: 0.,
            };
        }
        match scroller.top_row() {
            Some((index, offset_in_item)) => {
                let anchor_id = self.feed.model().rows().get(index).map(|r| r.id.clone());
                crate::rows::ScrollMemory {
                    pinned: anchor_id.is_none(),
                    anchor_id,
                    offset: -f32::from(offset_in_item),
                }
            }
            None => crate::rows::ScrollMemory {
                pinned: true,
                anchor_id: None,
                offset: 0.,
            },
        }
    }

    /// Back to a remembered place: a row still in the loaded rows, or the
    /// bottom if it's gone with an older page.
    pub(crate) fn restore_memory(
        &mut self,
        memory: Option<crate::rows::ScrollMemory>,
        cx: &mut Context<Self>,
    ) {
        let memory = memory.or_else(|| crate::rows::recalled_scroll(&self.summary.id));
        let Some(memory) = memory else { return };
        if memory.pinned {
            return;
        }
        if let Some(index) = memory
            .anchor_id
            .as_deref()
            .and_then(|id| self.feed.model().index_of(id))
        {
            self.scroller
                .update(cx, |s, cx| s.scroll_to_row(index, px(memory.offset), cx));
        } else if memory.anchor_id.is_some() && self.has_more_above() {
            // In an older page than the first one the pane has: bring pages
            // in until it's there, or they run out (`finish_older` retries).
            self.rows.pending_restore = Some(memory);
            self.load_older(cx);
        }
    }

    /// `hasMoreAbove`: there are events the runner hasn't sent.
    pub(crate) fn has_more_above(&self) -> bool {
        let model = self.feed.model();
        self.older
            .has_more(model.first_seq(), model.has_older_events())
    }

    /// `loadOlderIfNearTop`: with GPUI's list every row of the loaded events
    /// is a row in the list already, so "near the top" is near its first
    /// row by count: the rows above it haven't been measured.
    fn load_older_if_near_top(&mut self, cx: &mut Context<Self>) {
        if !self.load.is_shown() || self.older.fetching() || !self.has_more_above() {
            return;
        }
        // While it follows the tail the list reports no top row: it's at the
        // bottom, as far from older rows as it gets.
        let near = self
            .scroller
            .read(cx)
            .top_row()
            .is_some_and(|(index, _)| index < 30);
        if near {
            self.load_older(cx);
        }
    }

    /// Fetches the next older page and adds it above, keeping the rows on
    /// screen where they are (`ThreadSession.loadOlder`).
    pub(crate) fn load_older(&mut self, cx: &mut Context<Self>) {
        if !self.load.is_shown() {
            return;
        }
        let model = self.feed.model();
        let Some(ask) = self.older.ask(model.first_seq(), model.has_older_events()) else {
            return;
        };
        let client = self.client.clone();
        let id = self.summary.id.clone();
        cx.spawn(async move |this, cx| {
            let page = call(
                client,
                "threads.events",
                json!({ "threadId": id, "beforeSeq": ask.before, "limit": EVENTS_PAGE }),
            )
            .await;
            this.update(cx, |this, cx| this.finish_older(page, ask, cx))
                .ok();
        })
        .detach();
    }

    fn finish_older(
        &mut self,
        page: Result<Value, threadbear_client::runner::RpcError>,
        ask: OlderAsk,
        cx: &mut Context<Self>,
    ) {
        let page = page.ok().and_then(|v| EventsPage::decode(&v));
        let answer = match &page {
            None => OlderAnswer::Failed,
            Some(page)
                if !page
                    .events
                    .iter()
                    .any(|e| !e.is_transient() && e.seq < ask.before) =>
            {
                OlderAnswer::Empty
            }
            Some(_) => OlderAnswer::Arrived,
        };
        match (self.older.answered(ask, answer), page) {
            // Try again a few times, further apart each time.
            (OlderThen::RetryIn(delay), _) => {
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(delay).await;
                    this.update(cx, |this, cx| this.load_older_if_near_top(cx))
                        .ok();
                })
                .detach();
            }
            // Stepped back past the range the page covered: go on.
            (OlderThen::Skip, _) => self.load_older_if_near_top(cx),
            (OlderThen::Prepend, Some(page)) => self.prepend_older(page, cx),
            (OlderThen::Prepend | OlderThen::Nothing | OlderThen::Fetch, _) => {}
        }
    }

    /// An older page's rows, added above.
    fn prepend_older(&mut self, page: EventsPage, cx: &mut Context<Self>) {
        let memory = self.capture_memory(cx);
        let mut model = self.feed.model().clone();
        let result = model.prepend(page.events);
        if page.at_start {
            model.known_start = true;
        }
        self.feed.replace_model(model);
        let count = self.feed.model().rows().len();
        if result.keeps_order && result.added > 0 {
            let added = result.added;
            self.scroller.update(cx, |s, cx| {
                s.prepend(added, cx);
            });
            for id in result.changed_ids {
                if let Some(i) = self.feed.model().index_of(&id) {
                    self.scroller.update(cx, |s, cx| {
                        s.remeasure_items(i..i + 1, cx);
                    });
                }
            }
        } else if !result.keeps_order {
            // A row moved across the old first row (a result whose call was
            // on the older page), or the first row was a group that grew back
            // over the page and took a new id: the list can't just gain rows
            // at the top. Reload it around the anchor, or if that row's gone,
            // the first row that's still there.
            self.scroller.update(cx, |s, cx| s.reset(count, cx));
            let anchor = memory
                .anchor_id
                .as_deref()
                .and_then(|id| self.feed.model().index_of(id));
            if !memory.pinned {
                let (index, offset) = match anchor {
                    Some(i) => (i, memory.offset),
                    None => (result.added, 0.),
                };
                self.scroller
                    .update(cx, |s, cx| s.scroll_to_row(index, px(offset), cx));
            }
        }
        self.keep_outbox(cx);
        self.find_rows_changed(cx);
        cx.notify();
        if let Some(memory) = self.rows.pending_restore.take() {
            // Keeps paging if its row isn't here yet (`restore_memory`).
            self.restore_memory(Some(memory), cx);
        } else {
            self.load_older_if_near_top(cx);
        }
    }

    fn set_open(&mut self, row: &Row, open: bool, cx: &mut Context<Self>) {
        if matches!(row.content, RowContent::Group(_)) {
            let change = self.feed.set_expanded(&row.id, open);
            self.apply(change, cx);
        } else {
            if open {
                // Opening another runner's tool asks for its output, kept on
                // that runner: it fills the row in as more events if that
                // runner has full sync on (`fetchHeldBody`).
                if !self.open_rows.contains(&row.id) {
                    self.fetch_held_body(row);
                }
                self.open_rows.insert(row.id.clone());
            } else {
                self.open_rows.remove(&row.id);
            }
            if let Some(i) = self.feed.model().index_of(&row.id) {
                self.scroller.update(cx, |s, cx| {
                    s.remeasure_items(i..i + 1, cx);
                });
            }
        }
        cx.notify();
    }

    fn fetch_held_body(&self, row: &Row) {
        let RowContent::Tool(tool) = &row.content else {
            return;
        };
        let Some(seq) = tool.result.as_ref().and_then(|r| r.held_back_seq) else {
            return;
        };
        if self.summary.runner_id.is_none() {
            return;
        }
        let client = self.client.clone();
        let params = json!({ "threadId": self.summary.id, "seq": seq });
        RT.spawn(async move { client.call("threads.heldBody", params).await });
    }

    pub(crate) fn row_open(&self, row: &Row) -> bool {
        match &row.content {
            RowContent::Group(group) => group.is_expanded,
            _ => self.open_rows.contains(&row.id),
        }
    }

    /// A work link in a reply: opens the step's group, scrolls to the step and
    /// lights it up for a moment (`openThreadLink`).
    pub(crate) fn open_work_link(
        &mut self,
        quote: &str,
        row_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let model = self.feed.model();
        // A link with no step behind it beeps, as the Swift app's does, so
        // the click doesn't look as if it was missed.
        let Some((step, group)) = model
            .row(row_id)
            .and_then(|r| r.turn_id.clone())
            .and_then(|turn| model.work_step(quote, &turn))
        else {
            return crate::composer_answers::beep();
        };
        if let Some(group) = group {
            let closed = model
                .row(&group)
                .is_some_and(|r| matches!(&r.content, RowContent::Group(g) if !g.is_expanded));
            if closed {
                let change = self.feed.set_expanded(&group, true);
                self.apply(change, cx);
            }
        }
        // A third of the way down the view, not at its very top, so what led
        // up to the step is in sight too (`openThreadLink`).
        if let Some(index) = self.feed.model().index_of(&step) {
            self.scroller
                .update(cx, |s, cx| s.scroll_to_row(index, px(0.), cx));
            let scroller = self.scroller.clone();
            window.on_next_frame(move |_, cx| {
                scroller.update(cx, |s, cx| {
                    let down = s.viewport().size.height / 3.;
                    s.back_up(down, cx);
                });
            });
            self.light_row(step, cx);
        }
    }

    /// Brings a row into view a third of the way down and lights it up, as a
    /// work link does: the composer's chip for a changed draft shows where
    /// the draft is (composer_drafts.rs).
    pub(crate) fn reveal_row(&mut self, row_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        // A reply that's folded away or not loaded: a beep, so the click
        // doesn't look missed (`open_work_link`'s).
        let Some(index) = self.feed.model().index_of(row_id) else {
            return crate::composer_answers::beep();
        };
        self.scroller
            .update(cx, |s, cx| s.scroll_to_row(index, px(0.), cx));
        let scroller = self.scroller.clone();
        window.on_next_frame(move |_, cx| {
            scroller.update(cx, |s, cx| {
                let down = s.viewport().size.height / 3.;
                s.back_up(down, cx);
            });
        });
        self.light_row(row_id.to_owned(), cx);
    }

    /// Scrolls to and highlights the transcript row at or just before `target_seq`
    /// (used by coordinator open-loop Jump links). Falls back to focusing the composer.
    pub(crate) fn reveal_seq(
        &mut self,
        target_seq: i64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let row_id = self
            .feed
            .model()
            .rows()
            .iter()
            .rev()
            .find(|r| r.seq <= target_seq)
            .map(|r| r.id.clone());
        if let Some(id) = row_id {
            self.reveal_row(&id, window, cx);
        } else {
            self.focus_composer(window, cx);
        }
    }

    /// Lights a row up for a moment so the eye lands on the step (`light`).
    fn light_row(&mut self, row_id: String, cx: &mut Context<Self>) {
        self.rows.lit_row = Some(row_id.clone());
        self.rows.lit_serial += 1;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(crate::rows::LIGHT_TIME + Duration::from_millis(100))
                .await;
            this.update(cx, |this, cx| {
                if this.rows.lit_row.as_deref() == Some(row_id.as_str()) {
                    this.rows.lit_row = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// A `thread:` link: the app opens it (its id or a unique start of one).
    pub(crate) fn open_thread_link(
        &mut self,
        id: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.emit(crate::rows::OpenThreadRequest(id.to_lowercase()));
    }

    /// Ticks the working line's elapsed time once a second while it's on
    /// screen, so the row itself never has to change as time passes.
    pub(crate) fn ensure_ticking(&mut self, active: bool, cx: &mut Context<Self>) {
        if !active || self.rows.tick_scheduled {
            return;
        }
        self.rows.tick_scheduled = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(1)).await;
            this.update(cx, |this, cx| {
                this.rows.tick_scheduled = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

impl ThreadPane {
    /// One line in the app's log per read, once its rows are on screen:
    /// how long it kept Mike waiting and where the time went, which
    /// desktop/scripts/switch-stats.mjs adds up. Only the installed app writes
    /// the file (app_log.rs). Mike, 16 Nov, seeing more spinners switching
    /// threads, and nothing had recorded how long they lasted.
    fn log_read(&self) {
        let t = &self.timing;
        let from = if t.cold { "read" } else { "refresh" };
        let why = t.why.map_or(String::new(), |(why, kept)| {
            format!(" why={why} kept={kept}")
        });
        let remote = if self.summary.runner_id.is_some() {
            " remote"
        } else {
            ""
        };
        threadbear_client::log::write(
            "switch",
            &format!(
                "id={} from={from}{why}{remote} waited_ms={:.0} request_ms={:.0} kb={} decode_ms={:.0} fold_ms={:.0} rows={} up_s={}",
                short_id(&self.summary.id),
                t.painted_ms.unwrap_or(0.),
                t.request_ms,
                t.bytes / 1024,
                t.decode_ms,
                t.fold_ms,
                self.feed.model().rows().len(),
                crate::app_log::uptime_s(),
            ),
        );
    }
}

#[cfg(feature = "automation")]
impl ThreadPane {
    /// The rows as the Swift app's dump gives them, with their heights once
    /// they've been measured.
    pub fn dump(&self, cx: &App) -> Value {
        let scroller = self.scroller.read(cx);
        let rows: Vec<Value> = self
            .feed
            .model()
            .rows()
            .iter()
            .enumerate()
            .map(|(index, row)| {
                // 300 characters: at 100 a review's later findings and a
                // done card's later loose ends were cut off the dump, though
                // drawn (the nightly parity run, 12 Nov).
                let mut out = json!({ "id": row.id, "kind": row.kind().as_str(), "text": threadbear_core::reducer::RowDebug::excerpt(row, 300), "inGroup": row.in_group, "seq": row.seq, "onScreen": scroller.row_on_screen(index) });
                if let Some(height) = scroller.row_height(index) {
                    out["height"] = json!(f32::from(height).round());
                }
                if let Some(turn) = &row.turn_id {
                    out["turn"] = json!(turn);
                }
                // A gap's words, from the row's own top: they must sit inside
                // its fixed height, not over the rows either side.
                if matches!(row.content, RowContent::Gap(_)) && scroller.row_on_screen(index) {
                    if let (Some(at), Some(drawn)) = (scroller.row_bounds(index), self.rows.gap_labels.borrow().get(&row.id).copied()) {
                        out["label"] = json!({ "top": f32::from(drawn.top() - at.top()).round(), "height": f32::from(drawn.size.height).round() });
                    }
                }
                if matches!(row.content, RowContent::Group(_) | RowContent::Tool(_) | RowContent::Reasoning(_)) || row.kind() == threadbear_core::reducer::RowKind::Diff {
                    out["expanded"] = json!(self.row_open(row));
                }
                // A review folds only with findings to tuck away.
                if let RowContent::LabReview(review) = &row.content {
                    if review.folds() {
                        out["expanded"] = json!(self.row_open(row));
                    }
                }
                // My message's changed drafts, drawn as chips under its words
                // (rows.rs, `edited_drafts`).
                #[cfg(feature = "automation")]
                if let RowContent::User(message) = &row.content {
                    if let Some((words, drafts)) = threadbear_core::draft_block::split_edited(&message.text) {
                        out["editedDrafts"] = json!({ "words": words, "chips": drafts.iter().map(|d| d.kind.edited_label()).collect::<Vec<_>>() });
                    }
                }
                #[cfg(feature = "automation")]
                if let RowContent::Assistant(item) = &row.content {
                    if let Some(labels) = crate::reply_buttons::dump_labels(&item.text, &self.summary.id) {
                        out["buttons"] = json!(labels);
                    }
                    if let Some(drafts) = crate::draft_boxes::dump(&item.text, &self.summary.id, &row.id, cx) {
                        out["drafts"] = drafts;
                    }
                    // Its ```mermaid and ```html boxes (rich_boxes.rs).
                    if let Some(rich) = crate::rich_boxes::dump(&item.text, cx) {
                        out["rich"] = rich;
                    }
                    if let Some(blocks) = crate::shell_blocks::dump_lines(&item.text, &self.summary.id, cx) {
                        out["shellBlocks"] = json!(blocks);
                    }
                    // The live marks before its links to other threads.
                    if let Some(app) = self.composer.read(cx).app.upgrade() {
                        if let Some(marks) = crate::thread_link_marks::dump(&item.text, app.read(cx)) {
                            out["linkMarks"] = json!(marks);
                        }
                        // And the state marks before its links to PRs (pr_view.rs).
                        if let Some(marks) = crate::pr_view::dump_marks(&item.text, app.read(cx), cx) {
                            out["prMarks"] = json!(marks);
                        }
                        if let Some(read) = crate::pr_view::dump_read(&item.text, app.read(cx), cx) {
                            out["prsRead"] = json!(read);
                        }
                    }
                }
                if let Some(chips) = crate::chips::row_chips(self, row, cx) {
                    out["chips"] = json!(chips);
                }
                // The web addresses Mike's bubble draws as links (`bubble_words`).
                if let RowContent::User(message) = &row.content {
                    let links = crate::chips::bubble_links(message);
                    if !links.is_empty() {
                        out["links"] = json!(links);
                    }
                }
                out
            })
            .collect();
        // The done card's loose ends as the summary has them and as the
        // transcript took them, by the card's seq and count: which of the
        // two lost them, when a card shows none (the nightly parity run).
        let ends = |c: Option<&threadbear_core::reducer::LooseEnds>| {
            c.map(|c| json!({ "seq": c.seq, "count": c.ends.len() }))
        };
        let loose_ends = json!({ "summary": ends(self.summary.loose_ends_check().as_ref()), "transcript": ends(self.feed.model().loose_ends()) });
        json!({ "threadId": self.summary.id, "state": self.load_state(), "error": self.error, "atBottom": scroller.at_bottom(), "hasMoreAbove": self.has_more_above(), "spinner": self.load.view() == View::Spinner, "timing": self.timing_json(), "looseEnds": loose_ends, "threadFind": self.find_dump(), "rows": rows })
    }

    /// The Swift dump's names, a failure with its message.
    pub(crate) fn load_state(&self) -> String {
        self.load.name()
    }

    pub(crate) fn timing_json(&self) -> Value {
        let t = &self.timing;
        json!({ "requestMs": t.request_ms, "bytes": t.bytes, "decodeMs": t.decode_ms, "foldMs": t.fold_ms, "readyMs": t.ready_ms, "paintedMs": t.painted_ms.filter(|m| *m >= 0.), "reads": t.reads })
    }

    /// The reply buttons the thread's replies link, oldest first.
    #[cfg(feature = "automation")]
    pub(crate) fn linked_buttons(&self) -> Vec<String> {
        self.feed
            .model()
            .rows()
            .iter()
            .flat_map(|row| match &row.content {
                RowContent::Assistant(item) => threadbear_core::reply_buttons::ids_in(&item.text),
                _ => Vec::new(),
            })
            .collect()
    }

    pub fn set_row_open(
        &mut self,
        row: &str,
        open: bool,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let found = self
            .feed
            .model()
            .rows()
            .iter()
            .find(|r| r.id.starts_with(row))
            .cloned();
        let Some(found) = found else {
            return Err(format!("no row starting {row:?}"));
        };
        self.set_open(&found, open, cx);
        Ok(())
    }

    /// `scroll`: to the top or bottom, or a row (offset in points below the
    /// top of the view, as the Swift command has it).
    pub fn scroll_command(
        &mut self,
        to: Option<&str>,
        row: Option<&str>,
        offset: f32,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        match to {
            Some("top") => self
                .scroller
                .update(cx, |s, cx| s.scroll_to_row(0, px(0.), cx)),
            Some("bottom") => self.scroller.update(cx, |s, cx| s.scroll_to_end(cx)),
            _ => {
                let Some(row) = row else {
                    return Err("scroll needs to or row".into());
                };
                let Some(index) = self
                    .feed
                    .model()
                    .rows()
                    .iter()
                    .position(|r| r.id.starts_with(row))
                else {
                    return Err(format!("no row starting {row:?}"));
                };
                self.scroller
                    .update(cx, |s, cx| s.scroll_to_row(index, px(offset), cx));
            }
        }
        Ok(())
    }

    /// `link`: follows a `work:` or `thread:` link as a click in that row would.
    pub fn follow_link_command(
        &mut self,
        row: &str,
        url: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let Some(row_id) = self
            .feed
            .model()
            .rows()
            .iter()
            .find(|r| r.id.starts_with(row))
            .map(|r| r.id.clone())
        else {
            return Err(format!("no row starting {row:?}"));
        };
        self.link_clicked(url, &row_id, window, cx);
        Ok(())
    }

    /// `expand`/`collapse` with `all` for a diff.
    pub fn expand_detail(
        &mut self,
        row: &str,
        all: bool,
        open: bool,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        let found = self
            .feed
            .model()
            .rows()
            .iter()
            .find(|r| r.id.starts_with(row))
            .cloned();
        let Some(found) = found else {
            return Err(format!("no row starting {row:?}"));
        };
        if all {
            let key = threadbear_core::reducer::DiffPreview::all_key(&found.id);
            if open {
                self.open_rows.insert(found.id.clone());
                self.open_rows.insert(key);
            } else {
                self.open_rows.remove(&key);
            }
            if let Some(i) = self.feed.model().index_of(&found.id) {
                self.scroller.update(cx, |s, cx| {
                    s.remeasure_items(i..i + 1, cx);
                });
            }
            cx.notify();
            return Ok(());
        }
        self.set_open(&found, open, cx);
        Ok(())
    }

    /// Every event the thread has, for the long-thread check.
    pub fn load_all_events(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let id = self.summary.id.clone();
        let root = self.summary.cwd.clone();
        cx.spawn(async move |this, cx| {
            let page = call(
                client,
                "threads.events",
                json!({ "threadId": id, "limit": 1000000 }),
            )
            .await;
            this.update(cx, |this, cx| {
                if let Some(page) = page.ok().and_then(|v| EventsPage::decode(&v)) {
                    let mut model = TranscriptModel::new(Some(root));
                    model.load(page.events, &page.in_progress);
                    // What the summary adds to the rows, as `load` has it.
                    let _ = model.set_background(this.background_tasks());
                    let _ = model.set_loose_ends(this.summary.loose_ends_check());
                    this.feed = ThreadFeed::new(model);
                    // A page on its way belongs to the rows that went.
                    this.older.newest_read();
                    this.scroller
                        .update(cx, |s, cx| s.reset(this.feed.model().rows().len(), cx));
                    this.find_rows_changed(cx);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }
}

impl Render for ThreadPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The first frame drawn with its rows, for the read's timings: once
        // this frame is on screen.
        // Its read done, not only rows showing: a reload under rows already
        // shown would otherwise count the frame drawn as it started.
        if self.load.is_shown()
            && self.timing.ready_ms.is_some()
            && self.timing.painted_ms.is_none()
        {
            self.timing.painted_ms = Some(-1.);
            let me = cx.weak_entity();
            window.on_next_frame(move |_, cx| {
                me.update(cx, |this, _| {
                    this.timing.painted_ms = Some(this.timing.since());
                    this.log_read();
                })
                .ok();
            });
        }
        // What goes where the transcript goes, from the load state alone.
        let view = self.load.view();
        let loading = view == View::Spinner;
        // Coming in as it opens, once it has its rows (open_motion.rs).
        let entering = self.entering.transcript(self.load.is_shown(), window);
        let theme = cx.theme();
        let (muted, danger, bg) = (theme.muted_foreground, theme.danger, theme.background);
        self.rows.list_width = f32::from(self.scroller.read(cx).viewport().size.width);
        let composer = self.composer.clone();
        // The thread's title and project line are in the panel's bar (header.rs).
        // The whole thread is drop space for the box (ComposerDropView), outlined
        // while a file is over it. It's a layer over the thread for as long as a
        // file's being dragged, because selectable text under the pointer takes
        // the hover for itself, and a drop on a reply then went nowhere.
        let dragging_file = cx.has_active_drag();
        let thread_drop = composer.clone();
        let file_drop = composer.clone();
        let drop_layer = dragging_file.then(|| {
            div()
                .absolute()
                .inset_0()
                .on_drop(move |paths: &ExternalPaths, window, cx| {
                    let paths = paths.paths().to_vec();
                    // Over a card's Something else box it's that answer's.
                    let at = window.mouse_position();
                    composer.update(cx, |c, cx| c.take_dropped_paths(paths, at, window, cx));
                })
                .drag_over::<ExternalPaths>(|s, _, _, cx| {
                    s.bg(crate::style::accent(cx).opacity(0.06))
                        .border_2()
                        .border_color(crate::style::accent(cx))
                })
                // A thread from the sidebar goes into the message as its chip.
                .on_drop(
                    move |drag: &crate::composer_inline::DraggedThread, window, cx| {
                        let at = window.mouse_position();
                        thread_drop.update(cx, |c, cx| c.take_thread_drop(drag, at, window, cx));
                    },
                )
                .drag_over::<crate::composer_inline::DraggedThread>(|s, _, _, cx| {
                    s.bg(crate::style::accent(cx).opacity(0.06))
                        .border_2()
                        .border_color(crate::style::accent(cx))
                })
                // A file or picture dragged from inside the app (file_drag.rs)
                // is a dropped file too, but only let go over a box: one let
                // go anywhere else over the thread is a drag out that changed
                // its mind, and shouldn't land in the message (`takesDropFromThread`
                // turns this app's own drags away; the box still takes them).
                // GPUI only hands the system its drag once it's out of the window.
                .on_drop(move |file: &crate::file_drag::DraggedFile, window, cx| {
                    let Some(real) = file.still_grabbed() else {
                        return;
                    };
                    let at = window.mouse_position();
                    file_drop.update(cx, |c, cx| {
                        if c.box_under(at, cx).is_some() {
                            c.take_dropped_paths(vec![real], at, window, cx);
                        }
                    });
                })
                .drag_over::<crate::file_drag::DraggedFile>(|s, _, _, cx| {
                    s.bg(crate::style::accent(cx).opacity(0.06))
                        .border_2()
                        .border_color(crate::style::accent(cx))
                })
        });
        v_flex()
            .relative()
            .size_full()
            .map(|el| Self::find_keys(el, cx)) // ⌘F, ⌘G and ⇧⌘G (find.rs)
            // This pane is cached. A platform drag changes App's drag state,
            // not the pane, so typing could leave its drop layer unmounted
            // for the whole drag. Hear the first move even over selectable
            // text, and redraw only when the drag state changes.
            .child(
                canvas(|_, _, _| {}, {
                    let pane = cx.weak_entity();
                    let composer = self.composer.downgrade();
                    let accepts_drop = self.subagent_id.is_none();
                    move |bounds, _, window, _| {
                        let moved = pane.clone();
                        window.on_mouse_event(move |_: &MouseMoveEvent, phase, _, cx| {
                            if phase.capture() && cx.has_active_drag() != dragging_file {
                                moved.update(cx, |_, cx| cx.notify()).ok();
                            }
                        });
                        let released = pane.clone();
                        let composer = composer.clone();
                        window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
                            // A native drop belongs to the thread even when a
                            // selectable text hitbox has taken the hover. Capture
                            // its real pasteboard before GPUI's bubbling handlers,
                            // while the source file and its access grant exist.
                            if accepts_drop
                                && phase.capture()
                                && event.button == MouseButton::Left
                                && bounds.contains(&event.position)
                                && !window.has_active_dialog(cx)
                                && !window.has_active_sheet(cx)
                            {
                                if let Some(composer) = composer
                                    .upgrade()
                                    .filter(|composer| composer.read(cx).can_take_pictures(cx))
                                {
                                    if let Some(paths) = crate::composer_media::read(true) {
                                        composer.update(cx, |c, cx| {
                                            c.take_dropped_paths(paths, event.position, window, cx)
                                        });
                                        cx.stop_active_drag(window);
                                        cx.stop_propagation();
                                    }
                                }
                            }
                            if phase.capture() && dragging_file {
                                let released = released.clone();
                                window.defer(cx, move |_, cx| {
                                    released.update(cx, |_, cx| cx.notify()).ok();
                                });
                            }
                        });
                    }
                })
                .absolute()
                .inset_0(),
            )
            // ⌘C on words selected in a reply: HTML with their links beside
            // the words (selection_bar.rs). Ahead of the kit's own copy, which
            // has the words alone.
            .capture_action({
                // Not a listener: the copy reads this pane, which a listener
                // would hold for its own update.
                let pane = cx.weak_entity();
                move |_: &gpui_kit::component::input::Copy, window: &mut Window, cx: &mut App| {
                    if pane
                        .upgrade()
                        .is_some_and(|pane| crate::selection_bar::copy(&pane, window, cx))
                    {
                        cx.stop_propagation();
                    }
                }
            })
            .child(crate::selection_bar::watch(cx.weak_entity()))
            // Whether the left button's down, so asking which link is under
            // the pointer never lands in a click (reply_links.rs).
            .child(crate::reply_links::watch())
            .when_some(self.error.clone(), |s, e| {
                s.child(self.render_error_line(e, danger, muted, cx))
            })
            // Which thread started it (nested threads), then the find bar
            // while it's up (find.rs), above the transcript.
            .children(self.above_transcript(cx))
            .map(|s| match view {
                // No record of it is a plain note, not something that failed.
                View::NoRecord => s.child(
                    div()
                        .flex_1()
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(13.))
                        .text_color(muted)
                        .child(threadbear_core::thread_load::NO_RECORD),
                ),
                View::Failed { message } => s.child(self.render_load_failure(message, cx)),
                View::Transcript
                    if self.load.is_shown()
                        && self.subagent_id.is_some()
                        && self.feed.model().rows().is_empty() =>
                {
                    s.child(
                        div()
                            .flex_1()
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(13.))
                            .text_color(muted)
                            .child("Nothing yet."),
                    )
                }
                View::Spinner | View::Transcript => s.child(crate::open_motion::transcript_frame(
                    div()
                        .relative()
                        .size_full()
                        .child(transcript_list(
                            &self.scroller,
                            bg,
                            cx.processor(|this, ix: usize, window, cx| {
                                this.render_item(ix, window, cx)
                            }),
                            cx,
                        ))
                        // A small spinner in the middle of where the transcript
                        // will be, and no words, from the moment it's opened
                        // (DetailView's `ProgressView().controlSize(.small)`
                        // over the transcript while `.loading`).
                        .when(loading, |s| {
                            s.child(
                                div()
                                    .absolute()
                                    .inset_0()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(self.spinner(16., cx).transcript_loader()),
                            )
                        })
                        // Where an archive's page starts from (archive_flight.rs); a sub-agent's never flies.
                        .when(self.subagent_id.is_none(), |s| {
                            s.child(crate::archive_flight::transcript_mark(cx.entity_id()))
                        }),
                    entering,
                )),
            })
            // A sub-agent can't be written to: it takes its brief from the
            // agent that started it.
            // Dropping from the new-thread page, when it was started there.
            .when(self.subagent_id.is_none(), |s| {
                s.child(
                    self.entering
                        .wrap_box(self.composer.clone().into_any_element()),
                )
            })
            .children(drop_layer)
            // The card of a link the pointer's resting on (reply_links.rs), and
            // the bar over selected words (selection_bar.rs).
            .children(crate::reply_links::peek_overlay(self, cx))
            .children(crate::selection_bar::overlay(self, window, cx))
    }
}

/// What the banner says when a message can't go (`notConnectedText`).
pub(crate) const NOT_CONNECTED_TEXT: &str =
    "Not connected to the runner, so that wasn't sent. It's still in the box.";

/// Shows the messages on their way to a thread in whichever pane has the
/// thread open now, if one does: not necessarily the one the message was
/// sent from, which may have gone. At the top of the app's updates only:
/// from a send's task or the outbox's clock.
fn show_outbox_in(app: &WeakEntity<crate::app::Threadbear>, thread_id: &str, cx: &mut App) {
    let pane = app
        .read_with(cx, |app, cx| app.pane_for(thread_id, cx))
        .ok()
        .flatten();
    if let Some(pane) = pane {
        pane.update(cx, |p, cx| p.show_outbox(cx));
    }
    // A held message is in the drafts file while it's held, and out of it
    // once it's gone or come back to the box (`held_drafts`). The sidebar
    // redraws too: a thread whose send failed goes back to the Inbox.
    app.update(cx, |app, cx| {
        app.drafts_changed(cx);
        cx.notify();
    })
    .ok();
}

/// A thread's id as the log names it: the first eight characters, as a
/// `thread:` link or `tb show` takes it.
pub(crate) fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}
