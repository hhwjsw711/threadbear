// Other runners' threads (docs/protocol/runners.md, "Other runners' threads"): what
// `remoteThreads.list` answers and `remoteThreads.updated` sends, a port of
// RemoteThreads.swift. Their sidebar rows come from this Mac's runner, marked
// with a `runnerId`; everything else about them goes through that runner too
// (the relay), so the rows, the transcript and the composer take them as they
// are.
use crate::inbox::{iso_time, parse_ms, ThreadSummary};
use serde_json::Value;

/// The old runner let go of a thread during a move (its row left the index,
/// or this Mac's runner deleted it): the row to keep in its place (`movedAway`).
/// It stays as it was, the old runner's and locked with its move, until the
/// destination lists it: this Mac's own `threads.list` for a move here, the
/// destination's index row for a move to another. A row that has only gone
/// from its old runner says nothing about where the thread is, and a
/// secondary runner can take its own row out and put it back at will
/// (Daybreak 113, 13 Nov 2026): taken as arrived, the thread looked like
/// this Mac's, its box unlocked, while every message still went to the old
/// runner. None when it isn't a move, and the row should go.
pub fn moved_away(thread: &ThreadSummary) -> Option<ThreadSummary> {
    let moving = thread.moving.as_ref()?;
    if matches!(moving["state"].as_str(), Some("failed" | "cancelled")) {
        return None;
    }
    moving["to"].as_str().filter(|id| !id.is_empty())?;
    Some(thread.clone())
}

/// Where a move in flight is going, as its row says.
pub fn moving_to(thread: &ThreadSummary) -> Option<&str> {
    thread.moving.as_ref()?["to"]
        .as_str()
        .filter(|id| !id.is_empty())
}

/// A runner the backend knows of (`RemoteRunner`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RemoteRunner {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub online: bool,
    /// One thread's box on a virtual runner (`RemoteRunner.box`): such a
    /// runner is never a machine to pick (Runs on, Move to, Settings).
    pub runner_box: Option<RunnerBox>,
}

/// Why a box's thread waits on a cloud token (`RemoteRunner.box.token`):
/// its login has none yet, or Claude refused the one it has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenNeed {
    None,
    Dead,
}

/// A thread's box on a virtual runner, as its machine has it
/// (docs/protocol/runners.md, "Other runners' threads" and "Virtual runners").
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunnerBox {
    /// creating, starting, awake, saving, asleep, waking, needsToken and the
    /// rest; anything this app doesn't know is shown as nothing special.
    pub state: String,
    pub waiting: bool,
    pub unreachable: bool,
    pub unsure: bool,
    /// Its virtual runner's id (`RemoteThreads.services`).
    pub service: Option<String>,
    pub token: Option<TokenNeed>,
    /// The Claude login it runs on, an email: whose token the card makes.
    pub login: Option<String>,
}

impl RunnerBox {
    fn decode(v: &Value) -> Option<RunnerBox> {
        // Any box at all is a box: one this app can't read is still never a
        // machine to pick, just one it says nothing special about.
        if v.is_null() {
            return None;
        }
        let state = v["state"].as_str().unwrap_or("").to_owned();
        let text = |key: &str| v[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
        let token = match v["token"].as_str() {
            Some("none") => Some(TokenNeed::None),
            Some("dead") => Some(TokenNeed::Dead),
            _ => None,
        };
        Some(RunnerBox {
            state,
            waiting: v["waiting"] == true,
            unreachable: v["unreachable"] == true,
            unsure: v["unsure"] == true,
            service: text("service"),
            token,
            login: text("login"),
        })
    }

    /// Its thread can't run until a cloud token is set for its login: the
    /// thread shows the token card.
    pub fn needs_token(&self) -> bool {
        self.token.is_some() || self.state == "needsToken"
    }
}

/// A virtual runner (`RemoteThreads.services`): one Runs on entry, however
/// many threads (boxes) are on it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VirtualRunner {
    pub id: String,
    pub name: String,
    pub provider: String,
}

impl VirtualRunner {
    fn decode(v: &Value) -> Option<VirtualRunner> {
        let id = v["id"].as_str().filter(|s| !s.is_empty())?.to_owned();
        let name = v["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(&id)
            .to_owned();
        Some(VirtualRunner {
            name,
            provider: v["provider"].as_str().unwrap_or("").to_owned(),
            id,
        })
    }
}

/// `RemoteThreads`: what the sidebar shows of the other runners.
#[derive(Clone, Debug, Default)]
pub struct RemoteThreads {
    pub runners: Vec<RemoteRunner>,
    pub threads: Vec<ThreadSummary>,
    /// Mike's runner order (backend API 58), every runner's id: what the
    /// phone and the Runners panel list them in. None from a backend without one.
    pub order: Option<Vec<String>>,
    /// The virtual runners (API 94, the virtualRunners experiment): Runs
    /// on's entries after the machines. Empty from an older runner.
    pub services: Vec<VirtualRunner>,
    /// A partial or unready index cannot prove a previously seen row is gone.
    /// Missing `ready` is an older runner, whose array is already ready.
    complete: bool,
}

impl RemoteRunner {
    fn decode(v: &Value) -> Option<RemoteRunner> {
        let id = v["id"].as_str().filter(|s| !s.is_empty())?.to_owned();
        let name = v["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(&id)
            .to_owned();
        let runner_box = v.get("box").and_then(RunnerBox::decode);
        Some(RemoteRunner {
            name,
            icon: v["icon"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            online: v["online"].as_bool().unwrap_or(false),
            runner_box,
            id,
        })
    }
}

/// One row of another runner's sidebar table as a summary the sidebar takes
/// like a local one (`RemoteThread.summary`): the table has no seqs, so an
/// unread one gets 1 and 0, which is all the rows look at.
fn summary(row: &Value) -> Option<ThreadSummary> {
    let runner_id = row["runnerId"]
        .as_str()
        .filter(|s| !s.is_empty())?
        .to_owned();
    // The backend takes any string a runner writes, and an extra Mac may be
    // compromised: a row whose id isn't a thread id's shape is left out, as
    // the id goes into shell lines and links (thread_link::is_thread_id).
    let id = row["threadId"]
        .as_str()
        .filter(|s| crate::thread_link::is_thread_id(s))?
        .to_owned();
    let text = |key: &str| row[key].as_str().unwrap_or("").to_owned();
    let unread = row["unread"].as_bool().unwrap_or(false);
    let created = row["createdAt"].as_str().and_then(parse_ms).unwrap_or(0);
    let last_activity_at = row["lastActivityAt"]
        .as_str()
        .filter(|s| parse_ms(s).is_some())
        .or_else(|| row["updatedAt"].as_str().filter(|s| parse_ms(s).is_some()))
        .map_or_else(|| iso_time(created), str::to_owned);
    let snoozed_until = row["snoozedUntil"]
        .as_str()
        .filter(|s| parse_ms(s).is_some())
        .map(str::to_owned);
    // Hibernating until that runner restarts is kept as a date in the year 9999.
    let until_restart = snoozed_until
        .as_deref()
        .and_then(parse_ms)
        .is_some_and(|t| t > 200_000_000_000_000);
    let provider = row["provider"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("claude")
        .to_owned();
    let status = row["status"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("idle")
        .to_owned();
    Some(ThreadSummary {
        id,
        title: text("title"),
        cwd: text("cwd"),
        account_id: text("accountId"),
        pool_id: row["poolId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        provider,
        model: row["model"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        model_in_use: row["modelInUse"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 200)
            .map(str::to_owned),
        effort: row["effort"]
            .as_str()
            .filter(|s| matches!(*s, "low" | "medium" | "high" | "xhigh" | "max" | "ultra"))
            .map(str::to_owned),
        effort_in_use: row["effortInUse"]
            .as_str()
            .filter(|s| matches!(*s, "low" | "medium" | "high" | "xhigh" | "max" | "ultra"))
            .map(str::to_owned),
        status,
        needs_you: row["needsYou"].as_bool().unwrap_or(false),
        preview: text("preview"),
        last_activity_at,
        snoozed_until,
        snoozed_until_restart: until_restart.then_some(true),
        archived_at: row["archivedAt"]
            .as_str()
            .filter(|s| parse_ms(s).is_some())
            .map(str::to_owned),
        coordinator_project_id: row["coordinatorProjectId"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned),
        starred_at: row["starredAt"]
            .as_str()
            .filter(|s| parse_ms(s).is_some())
            .map(str::to_owned),
        started_by: row.get("startedBy").filter(|v| !v.is_null()).cloned(),
        asked: row["asked"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        keywords: row["keywords"].as_str().map(str::to_owned),
        created_at: row["createdAt"]
            .as_str()
            .filter(|s| parse_ms(s).is_some())
            .map(str::to_owned),
        moving: row.get("moving").filter(|v| !v.is_null()).cloned(),
        last_seq: if unread { 1 } else { 0 },
        last_seen_seq: 0,
        runner_id: Some(runner_id),
        // Its real access (API 88). A runner from before it doesn't say, and
        // guessing Full access showed every other runner's thread as that,
        // even ones on Auto (18 Nov 2026), so it's "unknown".
        permission_mode: row["permissionMode"]
            .as_str()
            .filter(|s| matches!(*s, "full" | "ask" | "auto" | "plan"))
            .unwrap_or("unknown")
            .to_owned(),
        // The done card's loose ends, which this Mac's runner adds to the row
        // of a thread it's watching (relay.ts `overlay`): the sidebar's own
        // rows don't carry them, and this summary replaces the last one.
        loose_ends: row.get("looseEnds").filter(|v| v.is_object()).cloned(),
        // What it's waiting on, as its runner worked it out (API 99).
        wait_state: row["waitState"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 32)
            .map(str::to_owned),
        ..Default::default()
    })
}

/// `remoteThreads.list`'s answer (or `remoteThreads.updated`'s params), read
/// leniently: an unreadable row is left out.
pub fn decode_remote_threads(value: &Value) -> RemoteThreads {
    let values = value["threads"].as_array();
    let mut ids = std::collections::HashSet::new();
    let threads: Vec<_> = values
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, row)| match summary(row) {
            Some(thread) if ids.insert(thread.id.clone()) => Some(thread),
            _ => {
                crate::wire::dropped::<ThreadSummary>(&format!("remote thread list entry at {i}"));
                None
            }
        })
        .collect();
    if values.is_none() {
        crate::wire::dropped::<RemoteThreads>("remote thread list envelope");
    }
    let ready = value["ready"].as_bool();
    let complete = ready != Some(false) && values.is_some_and(|v| v.len() == threads.len());
    RemoteThreads {
        runners: value["runners"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(RemoteRunner::decode)
            .collect(),
        threads,
        order: value["order"].as_array().map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect()
        }),
        services: value["services"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(VirtualRunner::decode)
            .collect(),
        complete,
    }
}

/// The newest `thread.updated` for each of the other runners' threads, in
/// the order they came, so a `remoteThreads.list` reply asked for before
/// some of them, and answered after (replies and notifications come by
/// separate paths), doesn't put back what they changed: a done card's loose
/// ends went again on a reconnect that way (Codex's review, 15 Nov 2026).
#[derive(Default, Debug)]
pub struct RecentUpdates {
    count: u64,
    newest: std::collections::HashMap<String, (u64, ThreadSummary)>,
}

impl RecentUpdates {
    /// Where the count is now: what a list asked for now has seen.
    pub fn mark(&self) -> u64 {
        self.count
    }

    pub fn note(&mut self, t: &ThreadSummary) {
        self.count += 1;
        self.newest.insert(t.id.clone(), (self.count, t.clone()));
    }

    pub fn forget(&mut self, id: &str) {
        self.newest.remove(id);
    }

    /// A whole list came by the notifications' own path, after every update
    /// noted so far: it's newer than all of them, so none is put back over
    /// a list from then on (Codex's review: an archive the list said after
    /// an update was undone by it). Keeps the cache to what's still in flight.
    pub fn superseded(&mut self) {
        self.newest.clear();
    }

    /// Takes into `list` every update that came after `mark`.
    pub fn reapply(&self, list: &mut RemoteThreads, mark: u64) {
        let mut later: Vec<&(u64, ThreadSummary)> =
            self.newest.values().filter(|(n, _)| *n > mark).collect();
        later.sort_by_key(|(n, _)| *n);
        for (_, t) in later {
            list.take_update(t);
        }
    }
}

impl RemoteThreads {
    pub fn can_remove_missing(&self) -> bool {
        self.complete
    }

    /// A `thread.updated` for one of its threads, from this Mac's runner
    /// (relay.ts `summary`), taken into its row here, on the runner it's
    /// listed for. The list is put back over the app's threads whenever
    /// this Mac's own list comes in (`apply_remote_index`), and without this
    /// it put back the row from before the thread was opened: the done
    /// card's loose ends, which only come once it's watched, went from the
    /// card a moment after they came (the nightly parity run, 14 Nov 2026).
    /// Not onto a row another runner now lists: the update was about the
    /// thread where it was (Codex's review, 15 Nov).
    pub fn take_update(&mut self, t: &ThreadSummary) {
        if let Some(row) = self
            .threads
            .iter_mut()
            .find(|row| row.id == t.id && (t.runner_id.is_none() || row.runner_id == t.runner_id))
        {
            let runner = row.runner_id.clone();
            *row = t.clone();
            row.runner_id = runner;
        }
    }

    pub fn runner(&self, id: &str) -> Option<&RemoteRunner> {
        self.runners.iter().find(|r| r.id == id)
    }

    /// The other runners that are machines: every one but a box's.
    pub fn machines(&self) -> impl Iterator<Item = &RemoteRunner> {
        self.runners.iter().filter(|r| r.runner_box.is_none())
    }
}

/// A runner from `runners.list` (`RunnerInfo`): every machine, this one too.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunnerInfo {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub online: bool,
    pub is_self: bool,
    pub last_seen_ms: Option<i64>,
    /// What its last heartbeat said, for the Runners panel (runners.rs).
    /// None from a runner before they were passed on (5 Nov).
    pub version: Option<String>,
    pub release: Option<String>,
    pub started_ms: Option<i64>,
    /// An old release finishing its threads in a handover.
    pub draining: bool,
}

/// `runners.list`'s answer, this runner first and then the rest by name.
pub fn decode_runners(value: &Value) -> Vec<RunnerInfo> {
    value["runners"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let id = r["id"].as_str().filter(|s| !s.is_empty())?.to_owned();
            let text = |key: &str| r[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
            let is_self = r["self"].as_bool().unwrap_or(false);
            Some(RunnerInfo {
                name: text("name").unwrap_or_else(|| id.clone()),
                icon: text("icon"),
                // The answering runner is plainly up; anything else unsaid is offline.
                online: r["online"].as_bool().unwrap_or(is_self),
                is_self,
                last_seen_ms: r["lastSeenAt"].as_str().and_then(parse_ms),
                version: text("version"),
                release: text("release"),
                started_ms: r["startedAt"].as_str().and_then(parse_ms),
                draining: r["draining"].as_bool().unwrap_or(false),
                id,
            })
        })
        .collect()
}

/// One login a move could carry on with on the other runner.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MoveLogin {
    pub id: String,
    pub title: String,
    pub email: Option<String>,
}

impl MoveLogin {
    /// As the sheet's picker names it (MoveSheet.body).
    pub fn label(&self) -> String {
        match &self.email {
            Some(email) => format!("{} ({email})", self.title),
            None => self.title.clone(),
        }
    }
}

/// `threads.movePreview`'s answer (`MovePreview`): the other runner's guess at
/// where a thread would go and on which login, what's in the way, and what
/// won't come with it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MovePreview {
    pub cwd: Option<String>,
    pub account_id: Option<String>,
    pub accounts: Vec<MoveLogin>,
    pub left_behind: Vec<String>,
    pub problems: Vec<String>,
    /// It gets a new worktree of its own in `cwd`'s repo.
    pub worktree: bool,
    /// That repo is cloned there first.
    pub clone: Option<String>,
    /// The address it's cloned from, shown with `clone`.
    pub clone_from: Option<String>,
    /// The thread's own runner said what it would leave behind.
    pub source_checked: bool,
    /// The runner's one-use id for this look: `threads.move` takes it, so
    /// the move does what this showed or nothing (Daybreak 142).
    pub preview_id: Option<String>,
}

impl MovePreview {
    pub fn decode(value: &Value) -> MovePreview {
        let text = |key: &str| {
            value[key]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let lines = |key: &str| {
            value[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|l| l.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        };
        MovePreview {
            cwd: text("cwd"),
            account_id: text("accountId"),
            accounts: value["accounts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| {
                    Some(MoveLogin {
                        id: a["id"].as_str()?.to_owned(),
                        title: a["title"].as_str().unwrap_or("").to_owned(),
                        email: a["email"].as_str().map(str::to_owned),
                    })
                })
                .collect(),
            left_behind: lines("leftBehind"),
            problems: lines("problems"),
            worktree: value["worktree"].as_bool().unwrap_or(false),
            clone: text("clone"),
            clone_from: text("cloneFrom"),
            source_checked: value["sourceChecked"].as_bool().unwrap_or(false),
            preview_id: text("previewId"),
        }
    }

    /// Nothing to decide or be told: Move to goes without showing the sheet.
    /// A clone is always shown first (where from, and to), and only a look
    /// the runner gave an id to can go.
    pub fn can_go_as_is(&self) -> bool {
        self.source_checked
            && self.problems.is_empty()
            && self.left_behind.is_empty()
            && self.cwd.is_some()
            && self.account_id.is_some()
            && self.clone.is_none()
            && self.preview_id.is_some()
    }
}

/// What the in-thread token card shows for a box waiting on a cloud token
/// (docs/protocol/keys.md, "Cloud tokens on the Mac"): whose token, whether its
/// last one was refused, and this Mac's login of that email when it runs on
/// a year-long token the card can offer to use as well.
#[derive(Clone, Debug, PartialEq)]
pub struct TokenCard {
    pub login: String,
    pub text: String,
    pub tip: String,
    pub dead: bool,
    pub mac_account: Option<String>,
}

pub fn token_card(b: &RunnerBox, logins: &crate::logins::RunnerLogins) -> Option<TokenCard> {
    if !b.needs_token() {
        return None;
    }
    let login = b.login.clone().filter(|l| !l.is_empty())?;
    let dead = b.token == Some(TokenNeed::Dead);
    let mac_account = logins
        .accounts
        .iter()
        .find(|a| {
            a.provider_id() == "claude"
                && a.year_token.is_some()
                && a.email
                    .as_deref()
                    .is_some_and(|e| e.eq_ignore_ascii_case(&login))
        })
        .map(|a| a.id.clone());
    let (text, tip) = if dead {
        (
            format!("Claude refused {login}'s cloud token"),
            "Claude turned down the token this login's cloud machines run on: it was revoked or has run out. Make a new one, and the thread carries on once it's set.".to_owned(),
        )
    } else {
        (
            format!("{login} needs a cloud token"),
            "A thread on a virtual runner runs Claude Code on a token from claude setup-token, kept sealed in your backend, one per login. Your message waits and goes once it's set.".to_owned(),
        )
    };
    Some(TokenCard {
        login,
        text,
        tip,
        dead,
        mac_account,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rows_become_summaries_marked_with_their_runner() {
        let list = decode_remote_threads(&json!({
            "runners": [{ "id": "r", "name": "mac-mini", "icon": "macmini", "online": true }, { "id": "r2" }],
            "threads": [
                { "runnerId": "r", "threadId": "t1", "title": "Backup", "cwd": "/Users/alex/misc", "accountId": "claude-main", "provider": "claude",
                  "model": "claude-opus-5-5", "status": "idle", "needsYou": true, "unread": true, "preview": "done", "createdAt": "2026-11-09T01:00:00.000Z", "lastActivityAt": "2026-11-09T02:00:00.000Z" },
                { "runnerId": "r", "threadId": "t2", "status": "running", "createdAt": "2026-11-09T01:00:00.000Z" },
                { "threadId": "no-runner" },
            ],
            "order": ["runner_mock", "r"],
        }));
        assert_eq!(list.runners.len(), 2);
        assert_eq!(list.runner("r").unwrap().name, "mac-mini");
        assert_eq!(list.runner("r2").unwrap().name, "r2");
        assert_eq!(list.threads.len(), 2);
        let t = &list.threads[0];
        assert_eq!(t.id, "t1");
        assert_eq!(t.runner_id.as_deref(), Some("r"));
        assert!(t.needs_you);
        assert!(t.unread());
        assert_eq!(t.last_activity_at, "2026-11-09T02:00:00.000Z");
        // No activity time falls back to its creation.
        assert_eq!(list.threads[1].last_activity_at, "2026-11-09T01:00:00.000Z");
        assert!(list.threads[1].busy());
    }

    // A row's own mode (API 88), never a guess of Full access: a runner that
    // doesn't say, or says something no app knows, is "unknown" (18 Nov
    // 2026, an Auto thread on the Dell XPS showed as Full access).
    #[test]
    fn a_rows_access_mode_is_its_own_or_unknown() {
        let list = decode_remote_threads(&json!({
            "runners": [{ "id": "r", "name": "Dell XPS" }],
            "threads": [
                { "runnerId": "r", "threadId": "t1", "status": "idle", "createdAt": "2026-11-09T01:00:00.000Z", "permissionMode": "auto" },
                { "runnerId": "r", "threadId": "t2", "status": "idle", "createdAt": "2026-11-09T01:00:00.000Z" },
                { "runnerId": "r", "threadId": "t3", "status": "idle", "createdAt": "2026-11-09T01:00:00.000Z", "permissionMode": "root" },
            ],
        }));
        let modes: Vec<_> = list
            .threads
            .iter()
            .map(|t| t.permission_mode.as_str())
            .collect();
        assert_eq!(modes, vec!["auto", "unknown", "unknown"]);
        assert_eq!(crate::logins::permission_title("unknown"), "Access unknown");
    }

    // The relay puts a watched thread's done-card loose ends on its row
    // (relay.ts `overlay`): they reach the done card, for the seq it's on.
    #[test]
    fn remote_coordinator_metadata_needs_no_local_registry() {
        let rows = decode_remote_threads(&json!({"threads":[
            {"runnerId":"r", "threadId":"t1", "coordinatorProjectId":"p_remote"},
            {"runnerId":"r", "threadId":"t2", "coordinatorProjectId":5},
            {"runnerId":"r", "threadId":"t3", "coordinatorProjectId":"  "}
        ]}));
        assert_eq!(rows.threads.len(), 3);
        assert_eq!(
            rows.threads[0].coordinator_project_id.as_deref(),
            Some("p_remote")
        );
        assert!(rows.threads[0].is_coordinator());
        assert!(!rows.threads[1].is_coordinator());
        assert!(!rows.threads[2].is_coordinator());
    }

    #[test]
    fn a_rows_effort_and_model_in_use_reach_the_summary() {
        let oversized = "x".repeat(201);
        let list = decode_remote_threads(&json!({
            "runners": [{ "id": "r", "name": "Hetzner Cloud" }],
            "threads": [
                { "runnerId": "r", "threadId": "t1", "status": "idle", "createdAt": "2026-11-09T01:00:00.000Z",
                  "modelInUse": "gpt-6.2-sol", "effort": "high", "effortInUse": "low" },
                { "runnerId": "r", "threadId": "t2", "status": "idle", "createdAt": "2026-11-09T01:00:00.000Z",
                  "modelInUse": "", "effort": "", "effortInUse": "" },
                { "runnerId": "r", "threadId": "t3", "status": "idle", "createdAt": "2026-11-09T01:00:00.000Z",
                  "modelInUse": oversized, "effort": "turbo", "effortInUse": "bogus" },
            ],
        }));
        assert_eq!(list.threads[0].model_in_use.as_deref(), Some("gpt-6.2-sol"));
        assert_eq!(list.threads[0].effort.as_deref(), Some("high"));
        assert_eq!(list.threads[0].effort_in_use.as_deref(), Some("low"));
        assert_eq!(list.threads[1].model_in_use, None);
        assert_eq!(list.threads[1].effort, None);
        assert_eq!(list.threads[1].effort_in_use, None);
        assert_eq!(list.threads[2].model_in_use, None);
        assert_eq!(list.threads[2].effort, None);
        assert_eq!(list.threads[2].effort_in_use, None);
    }

    #[test]
    fn a_rows_loose_ends_reach_the_summary() {
        let list = decode_remote_threads(&json!({
            "runners": [{ "id": "r", "name": "mac-mini" }],
            "threads": [
                { "runnerId": "r", "threadId": "t1", "status": "idle", "createdAt": "2026-11-09T01:00:00.000Z",
                  "looseEnds": { "seq": 47, "ends": [{ "kind": "scheduled", "text": "Look at how the experiment went", "at": "2026-11-15T01:30:00.000Z" }] } },
                { "runnerId": "r", "threadId": "t2", "status": "idle", "createdAt": "2026-11-09T01:00:00.000Z", "looseEnds": "junk" },
            ],
        }));
        let check = list.threads[0].loose_ends_check().expect("its loose ends");
        assert_eq!(check.seq, 47);
        assert_eq!(check.ends[0].text, "Look at how the experiment went");
        assert!(
            list.threads[1].loose_ends.is_none(),
            "one that isn't an object is left off"
        );
    }

    #[test]
    fn a_thread_updated_stays_when_the_list_is_put_back() {
        let mut list = decode_remote_threads(&json!({
            "runners": [{ "id": "r", "name": "mac-mini" }],
            "threads": [{ "runnerId": "r", "threadId": "t1", "status": "idle", "createdAt": "2026-11-09T01:00:00.000Z" }],
        }));
        assert!(list.threads[0].loose_ends_check().is_none());
        let updated: ThreadSummary = crate::wire::read(json!({
            "id": "t1", "title": "Start", "status": "idle", "runnerId": "r",
            "looseEnds": { "seq": 39, "ends": [{ "kind": "scheduled", "text": "Look at how the experiment went", "at": "2026-11-15T01:30:00.000Z" }] },
        })).expect("a summary");
        list.take_update(&updated);
        assert_eq!(list.threads[0].loose_ends_check().map(|c| c.seq), Some(39));
        assert_eq!(list.threads[0].runner_id.as_deref(), Some("r"));
        // One it doesn't list isn't added: the list says which threads there are.
        list.take_update(&ThreadSummary {
            id: "t9".into(),
            ..updated
        });
        assert_eq!(list.threads.len(), 1);
    }

    /// A list asked for before an update and answered after it keeps the
    /// update; one asked for after it is taken as it is.
    #[test]
    fn a_list_asked_for_before_an_update_keeps_it() {
        let rows = json!({
            "runners": [{ "id": "r", "name": "mac-mini" }],
            "threads": [{ "runnerId": "r", "threadId": "t1", "status": "idle", "createdAt": "2026-11-09T01:00:00.000Z" }],
        });
        let updated: ThreadSummary = crate::wire::read(json!({
            "id": "t1", "title": "Start", "status": "idle",
            "looseEnds": { "seq": 39, "ends": [{ "kind": "scheduled", "text": "Look at how the experiment went" }] },
        })).expect("a summary");
        let mut recent = RecentUpdates::default();
        let asked = recent.mark();
        recent.note(&updated);
        let mut late = decode_remote_threads(&rows);
        recent.reapply(&mut late, asked);
        assert_eq!(late.threads[0].loose_ends_check().map(|c| c.seq), Some(39));
        assert_eq!(late.threads[0].runner_id.as_deref(), Some("r"));
        let mut fresh = decode_remote_threads(&rows);
        recent.reapply(&mut fresh, recent.mark());
        assert!(fresh.threads[0].loose_ends_check().is_none());
    }

    /// A list that came by the notifications after an update is newer than
    /// it, and so is anything after; an update for the thread on another
    /// runner doesn't go onto the row of the runner that lists it now.
    #[test]
    fn a_newer_list_and_another_runner_win_over_an_update() {
        let rows = |runner: &str| {
            json!({
                "runners": [{ "id": runner, "name": runner }],
                "threads": [{ "runnerId": runner, "threadId": "t1", "status": "idle", "createdAt": "2026-11-09T01:00:00.000Z" }],
            })
        };
        let mut updated: ThreadSummary = crate::wire::read(json!({
            "id": "t1", "title": "Start", "status": "idle",
            "looseEnds": { "seq": 39, "ends": [{ "kind": "scheduled", "text": "Look at how the experiment went" }] },
        })).expect("a summary");
        updated.runner_id = Some("r".into());
        let mut recent = RecentUpdates::default();
        let asked = recent.mark();
        recent.note(&updated);
        let mut moved = decode_remote_threads(&rows("s"));
        recent.reapply(&mut moved, asked);
        assert!(
            moved.threads[0].loose_ends_check().is_none(),
            "not onto another runner's row"
        );
        recent.superseded();
        let mut late = decode_remote_threads(&rows("r"));
        recent.reapply(&mut late, asked);
        assert!(
            late.threads[0].loose_ends_check().is_none(),
            "a newer list said otherwise"
        );
    }

    #[test]
    fn a_move_keeps_the_thread_as_its_old_runners_until_the_destination_lists_it() {
        let mut thread = ThreadSummary {
            id: "t".into(),
            runner_id: Some("mac-mini".into()),
            moving: Some(json!({ "to": "laptop", "toName": "laptop", "state": "copying" })),
            ..Default::default()
        };
        let kept = moved_away(&thread).unwrap();
        // Daybreak 113: never this Mac's (or the destination's) on the old
        // runner's word alone, and still locked with its move.
        assert_eq!(
            kept.runner_id.as_deref(),
            Some("mac-mini"),
            "still the old runner's"
        );
        assert!(kept.moving_line().is_some(), "its box stays locked");
        assert_eq!(moving_to(&kept), Some("laptop"));
        let local = ThreadSummary {
            id: "u".into(),
            moving: Some(json!({ "to": "mac-mini", "state": "claimed" })),
            ..Default::default()
        };
        assert!(
            moved_away(&local).unwrap().runner_id.is_none(),
            "one moving off this Mac stays this Mac's"
        );
        thread.moving.as_mut().unwrap()["state"] = json!("failed");
        assert!(moved_away(&thread).is_none());
        thread.moving = None;
        assert!(
            moved_away(&thread).is_none(),
            "an ordinary delete still deletes"
        );
    }

    #[test]
    fn a_preview_with_nothing_to_say_can_just_go() {
        let answer = json!({ "cwd": "/Users/alex/x", "accountId": "claude-main", "accounts": [{ "id": "claude-main", "title": "Claude", "email": "a@b" }], "leftBehind": [], "problems": [], "sourceChecked": true, "previewId": "p1" });
        assert!(MovePreview::decode(&answer).can_go_as_is());
        let left = json!({ "cwd": "/x", "accountId": "a", "leftBehind": ["a job"], "sourceChecked": true });
        assert!(!MovePreview::decode(&left).can_go_as_is());
        let unchecked =
            json!({ "cwd": "/x", "accountId": "a", "sourceChecked": false, "previewId": "p1" });
        assert!(!MovePreview::decode(&unchecked).can_go_as_is());
        let cloning = json!({ "cwd": "/x", "accountId": "a", "sourceChecked": true, "previewId": "p1", "clone": "/x", "cloneFrom": "git@github.com:o/r.git" });
        assert!(
            !MovePreview::decode(&cloning).can_go_as_is(),
            "a clone is shown first"
        );
        assert_eq!(
            MovePreview::decode(&cloning).clone_from.as_deref(),
            Some("git@github.com:o/r.git")
        );
        let unbound = json!({ "cwd": "/x", "accountId": "a", "sourceChecked": true });
        assert!(
            !MovePreview::decode(&unbound).can_go_as_is(),
            "no previewId, nothing to bind the move to"
        );
        assert_eq!(
            MovePreview::decode(&answer).accounts[0].label(),
            "Claude (a@b)"
        );
    }

    #[test]
    fn runners_list_decodes_itself_and_the_others() {
        let list = decode_runners(&json!({ "runners": [
            { "id": "m", "name": "laptop", "icon": "laptopcomputer", "self": true, "version": "0.1.0+20261105T064853Z-c4d90ca", "release": "20261105T064853Z-c4d90ca", "startedAt": "2026-11-11T01:00:00.000Z" },
            { "id": "b", "name": "mac-mini", "online": false, "lastSeenAt": "2026-11-09T01:00:00.000Z", "draining": true },
            { "id": "c", "name": "" },
        ] }));
        assert_eq!(list.len(), 3);
        assert!(list[0].is_self);
        assert!(
            list[0].online,
            "the answering runner is up even if it doesn't say"
        );
        assert_eq!(list[0].release.as_deref(), Some("20261105T064853Z-c4d90ca"));
        assert_eq!(list[0].started_ms, parse_ms("2026-11-11T01:00:00.000Z"));
        assert!(!list[1].online);
        assert!(list[1].draining);
        assert_eq!(list[1].last_seen_ms, parse_ms("2026-11-09T01:00:00.000Z"));
        assert_eq!(list[2].name, "c", "no name is its id");
        assert!(!list[2].online);
    }

    #[test]
    fn the_runner_order_comes_with_the_other_runners() {
        assert_eq!(
            decode_remote_threads(&json!({ "runners": [], "threads": [], "order": ["m", "b", 3] }))
                .order,
            Some(vec!["m".to_string(), "b".to_string()])
        );
        assert_eq!(
            decode_remote_threads(&json!({ "runners": [], "threads": [] })).order,
            None
        );
    }

    #[test]
    fn a_far_off_snooze_means_until_that_runner_restarts() {
        let list = decode_remote_threads(&json!({ "runners": [], "threads": [
            { "runnerId": "r", "threadId": "t", "createdAt": "2026-11-09T01:00:00.000Z", "snoozedUntil": "9999-12-31T00:00:00.000Z" }
        ]}));
        assert_eq!(list.threads[0].snoozed_until_restart, Some(true));
    }
    // Virtual runners (docs/protocol/keys.md, "Virtual runners"): a box's runner
    // says its box, and the list says the virtual runners themselves.
    #[test]
    fn a_box_runner_and_the_virtual_runners_decode() {
        let list = decode_remote_threads(&json!({
            "runners": [
                { "id": "m", "name": "bruce", "online": true },
                { "id": "b1", "name": "Cloud (Fly)", "online": true, "box": { "state": "needsToken", "service": "s1", "token": "none", "login": "mike@example.com" } },
                { "id": "b2", "name": "Cloud (Fly)", "online": true, "box": { "state": "awake", "token": "dead", "login": "mike@example.com", "waiting": true, "unreachable": true, "unsure": true } },
                { "id": "b3", "name": "Cloud (Fly)", "online": true, "box": { "state": "asleep", "token": "what" } },
                { "id": "b4", "box": "nonsense" },
            ],
            "threads": [],
            "services": [{ "id": "s1", "name": "Cloud (Fly)", "provider": "fly" }, { "name": "no id" }, { "id": "s2", "provider": "fly" }],
        }));
        assert!(list.runner("m").unwrap().runner_box.is_none());
        let b1 = list.runner("b1").unwrap().runner_box.clone().unwrap();
        assert_eq!(b1.state, "needsToken");
        assert_eq!(b1.service.as_deref(), Some("s1"));
        assert_eq!(b1.token, Some(TokenNeed::None));
        assert_eq!(b1.login.as_deref(), Some("mike@example.com"));
        let b2 = list.runner("b2").unwrap().runner_box.clone().unwrap();
        assert_eq!(b2.token, Some(TokenNeed::Dead));
        assert!(b2.waiting && b2.unreachable && b2.unsure);
        assert_eq!(
            list.runner("b3")
                .unwrap()
                .runner_box
                .as_ref()
                .unwrap()
                .token,
            None,
            "an unknown token word is no need"
        );
        assert_eq!(
            list.runner("b4")
                .unwrap()
                .runner_box
                .as_ref()
                .unwrap()
                .state,
            "",
            "a box it can't read is still a box, with nothing to say"
        );
        assert_eq!(
            list.services,
            vec![
                VirtualRunner {
                    id: "s1".into(),
                    name: "Cloud (Fly)".into(),
                    provider: "fly".into()
                },
                VirtualRunner {
                    id: "s2".into(),
                    name: "s2".into(),
                    provider: "fly".into()
                }
            ]
        );
        let machines: Vec<&str> = list.machines().map(|r| r.id.as_str()).collect();
        assert_eq!(
            machines,
            vec!["m"],
            "a box's runner is never a machine to pick"
        );
        assert!(
            decode_remote_threads(&json!({ "runners": [], "threads": [] }))
                .services
                .is_empty(),
            "an older runner sends none"
        );
    }

    #[test]
    fn a_box_needs_a_token_while_its_login_has_none_or_a_refused_one() {
        let b = |state: &str, token: Option<TokenNeed>| RunnerBox {
            state: state.into(),
            token,
            ..Default::default()
        };
        assert!(b("needsToken", None).needs_token());
        assert!(b("awake", Some(TokenNeed::Dead)).needs_token());
        assert!(b("asleep", Some(TokenNeed::None)).needs_token());
        assert!(!b("awake", None).needs_token());
    }
    // The in-thread token card (Mike's "option C", 17 Nov): what it says,
    // and the third way only when this Mac's login of that email has a
    // year-long token.
    #[test]
    fn the_token_card_says_whose_token_and_offers_this_macs_only_when_there_is_one() {
        use crate::logins::{Account, RunnerLogins, YearToken};
        let logins = RunnerLogins {
            accounts: vec![
                Account {
                    id: "claude-main".into(),
                    provider: "claude".into(),
                    email: Some("Mike@Example.com".into()),
                    year_token: Some(YearToken { made_at: None }),
                    ..Default::default()
                },
                Account {
                    id: "claude-2".into(),
                    provider: "claude".into(),
                    email: Some("work@example.com".into()),
                    ..Default::default()
                },
                Account {
                    id: "codex-main".into(),
                    provider: "codex".into(),
                    email: Some("codex@example.com".into()),
                    year_token: Some(YearToken { made_at: None }),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let need = |state: &str, token: Option<TokenNeed>, login: &str| RunnerBox {
            state: state.into(),
            token,
            login: Some(login.into()),
            ..Default::default()
        };
        let none = token_card(
            &need("needsToken", Some(TokenNeed::None), "mike@example.com"),
            &logins,
        )
        .unwrap();
        assert_eq!(none.text, "mike@example.com needs a cloud token");
        assert_eq!(none.login, "mike@example.com");
        assert!(!none.dead);
        assert_eq!(
            none.mac_account.as_deref(),
            Some("claude-main"),
            "an email is matched whatever its case"
        );
        let dead = token_card(
            &need("awake", Some(TokenNeed::Dead), "work@example.com"),
            &logins,
        )
        .unwrap();
        assert_eq!(dead.text, "Claude refused work@example.com's cloud token");
        assert!(dead.dead);
        assert_eq!(
            dead.mac_account, None,
            "no year-long token on this Mac for that login"
        );
        assert_eq!(
            token_card(
                &need("needsToken", Some(TokenNeed::None), "codex@example.com"),
                &logins
            )
            .unwrap()
            .mac_account,
            None,
            "only a Claude login's token"
        );
        assert!(
            token_card(&need("awake", None, "mike@example.com"), &logins).is_none(),
            "no card once it has one"
        );
        let nameless = RunnerBox {
            state: "needsToken".into(),
            ..Default::default()
        };
        assert!(
            token_card(&nameless, &logins).is_none(),
            "nothing to make a token for without its login"
        );
    }
}
