// The sidebar's sections: the rules of the Mac's ThreadSections
// (app/Sources/ThreadbearCore/Threads/ThreadSections.swift), which the phone's
// InboxSections and the website's web/src/sections.ts follow too. A summary
// is what `threads.list` gives; what a row says about it is in `sidebar.rs`.
use serde::Deserialize;
use serde_json::Value;
use std::borrow::Borrow;
use std::collections::HashMap;

pub struct ThreadList {
    pub rows: Vec<ThreadSummary>,
    complete: bool,
}

impl ThreadList {
    pub fn decode(value: &Value) -> Result<Self, &'static str> {
        let Some(values) = value["threads"].as_array() else {
            crate::wire::dropped::<Self>("thread list envelope");
            return Err("The runner sent an unreadable thread list. Keeping the previous threads.");
        };
        let mut rows = Vec::new();
        let mut ids = std::collections::HashSet::new();
        for (i, value) in values.iter().enumerate() {
            match serde_json::from_value::<ThreadSummary>(value.clone()) {
                Ok(row) if ids.insert(row.id.clone()) => rows.push(row),
                _ => crate::wire::dropped::<ThreadSummary>(&format!("thread list entry at {i}")),
            }
        }
        let complete = !rows.is_empty() && rows.len() == values.len();
        Ok(Self { rows, complete })
    }

    pub fn apply<T: From<ThreadSummary>>(self, threads: &mut HashMap<String, T>) -> bool {
        // Missing rows only mean deletion in a fully readable, nonempty list.
        // In particular, never stop Terminal shells on an empty snapshot.
        if self.complete {
            threads.clear();
        }
        threads.extend(self.rows.into_iter().map(|t| (t.id.clone(), T::from(t))));
        self.complete
    }
}

/// The commit a thread waits for the app to have (`awaitingApp`); none when
/// the runner had no commit to look for.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct AwaitingApp {
    #[serde(default)]
    pub commit: Option<String>,
}

/// Archived by the quiet inbox for Mike's own threads (`quietlyArchived`,
/// experiment quietInboxMine): when, and the model's one line on why he
/// didn't need to see it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct QuietlyArchived {
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub why: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    #[serde(deserialize_with = "crate::wire::id")]
    pub id: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub title: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub cwd: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub provider: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub model: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub model_in_use: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub account_id: String,
    /// The pool that picks its login; none when it's pinned to `account_id`.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub pool_id: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub effort: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub effort_in_use: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub permission_mode: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub context_tokens: Option<i64>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub context_window: Option<i64>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub cost_usd: Option<f64>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub status: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub needs_you: bool,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub needs: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::optional_list")]
    pub asks: Option<Vec<OpenAsk>>,
    #[serde(default, deserialize_with = "crate::wire::optional_uint")]
    pub asks_seq: Option<u64>,
    /// The agent said its asks wait until its own shell jobs end (the
    /// runner's `asksAfterJobs`).
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub asks_after_jobs: Option<bool>,
    #[serde(default, deserialize_with = "crate::wire::optional_uint")]
    pub pending_reviews: Option<u64>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub last_activity_at: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub updated_at: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub snoozed_until: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub snoozed_until_restart: Option<bool>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub snoozed_until_release: Option<bool>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub wake_when: Option<Value>,
    #[serde(default, deserialize_with = "crate::wire::optional_list")]
    pub waiting_on: Option<Vec<Value>>,
    /// Hibernating until Mike's app restarts onto the build its turn landed
    /// (wait_for_app_restart): its work isn't over until he's running it.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub awaiting_app_restart: Option<bool>,
    /// Hibernating until GitHub workflow runs finish (end_turn's
    /// waitForRuns): its work isn't over until they have.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub awaiting_runs: Option<bool>,
    /// Waiting to hear the app restarted onto a build with this commit
    /// (wait_for_app_restart), hibernating or not: the Updates panel lists
    /// it with whether the build on its way has it.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub awaiting_app: Option<AwaitingApp>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub woke: Option<Value>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub starred_at: Option<String>,
    /// A coordinator can arrive from another runner without its local registry.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub coordinator_project_id: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub archived_at: Option<String>,
    /// The quiet inbox archived it (protocol "Inbox guess"): only while
    /// it's still archived by Threadbear.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub quietly_archived: Option<QuietlyArchived>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub waiting_for_room: Option<Value>,
    /// Whether a turn that hits its login's limit waits for room and carries
    /// on by itself: on unless Mike turned it off on the limit box, when the
    /// runner sends `false` (and nothing otherwise).
    #[serde(default = "carry_on_by_default")]
    #[serde(deserialize_with = "crate::wire::default_true")]
    pub carry_on_at_reset: bool,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub waiting_for_network: Option<Value>,
    /// Kept as it came: the reducer reads its own `BackgroundTask` from these.
    #[serde(default, deserialize_with = "crate::wire::optional_list")]
    pub background: Option<Vec<Value>>,
    #[serde(default, deserialize_with = "crate::wire::optional_list")]
    pub subagents: Option<Vec<Value>>,
    /// The runner's loose-ends check for the done card (protocol "Loose
    /// ends"), kept as it came and read with `loose_ends_check`, so one
    /// the reducer can't read leaves the rest of the summary standing.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub loose_ends: Option<Value>,
    #[serde(default, deserialize_with = "crate::wire::optional_list")]
    pub projects: Option<Vec<Project>>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub started_by: Option<Value>,
    /// A thread another thread started that Mike moved out from under it in
    /// the sidebar (protocol "Nested threads"): `true`, else absent.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub detached: Option<bool>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub schedule: Option<Value>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub moving: Option<Value>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub asked: Option<String>,
    /// What it's waiting on, as its runner worked it out (protocol "Wait
    /// state", runner/src/wait-state.ts). Read with `wait_state()`. Absent
    /// from a runner before 23 Nov 2026, and cleared by an optimistic change
    /// here (`Sidebar::update_thread`), so the app's own rule draws it until
    /// the runner's next summary.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub wait_state: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub preview: String,
    /// The librarian's search words, for finding a thread by what it's about
    /// when its title and preview don't say it (`matches`).
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub keywords: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::uint")]
    pub last_seq: u64,
    #[serde(default, deserialize_with = "crate::wire::uint")]
    pub last_seen_seq: u64,
    /// The rail's panel buttons (`ThreadSummary.panels`) and Patches, as they
    /// came: the window shell draws a button for each. Kept as they came and
    /// decoded leniently on demand (highlights.rs), as `background` and
    /// `subagents` are.
    #[serde(default, deserialize_with = "crate::wire::optional_list")]
    pub panels: Option<Vec<Value>>,
    #[serde(default, deserialize_with = "crate::wire::optional_list")]
    pub actions: Option<Vec<Value>>,
    #[serde(default, deserialize_with = "crate::wire::optional_list")]
    pub patches: Option<Vec<Value>>,
    #[serde(default, deserialize_with = "crate::wire::optional_list")]
    pub hooks: Option<Vec<Value>>,
    /// Moves when a pin, a removal or a brief changes what `threads.highlights`
    /// would answer, without a new event.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub highlights_at: Option<String>,
    /// The thread's worktree, while it has one (protocol "Worktrees").
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub worktree: Option<Value>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub on_old_runner: Option<bool>,
    /// Sharing (protocol "Sharing"): `{ access, slug }`.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub share: Option<Value>,
    /// When it was made (the About window's numbers, den.rs).
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub created_at: Option<String>,
    /// One of the tour's made-up threads (`threads.samples`): left out of
    /// the About window's numbers.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub sample: Option<bool>,
    /// Which other runner it lives on; none for this Mac's own threads.
    /// Never on the wire: a runner's summaries are all its own (Swift
    /// `ThreadSummary.runnerId`), and `remote::summary` sets it.
    #[serde(skip)]
    pub runner_id: Option<String>,
    /// A panel the agent asked to show Mike, waiting for him to look at the
    /// thread (panel_requests.rs).
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub panel_request: Option<crate::panel_requests::PanelRequest>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OpenAsk {
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub task_id: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub action: String,
    #[serde(rename = "where")]
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub place: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub why: Option<String>,
    // These positions match `suggested` and `optionNotes`. A bad label must
    // drop this field, rather than shift a different choice into its place.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub options: Option<Vec<String>>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub suggested: Option<usize>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub ticked: Option<bool>,
    /// What each option does, the reply a plain ask wants, and the ask's
    /// links, as they came: a decision on a project's page draws the thread's
    /// card from these (`projects::decision_asks`), as its composer draws it
    /// from the turn.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub option_notes: Option<Vec<String>>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub reply: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::optional_list")]
    pub links: Option<Vec<Value>>,
}

/// Puts back the row a failed optimistic change replaced (`before`), but
/// only while the row is still the guess it made (`guess`): a thread.updated
/// or a reconnect's list that came meanwhile is newer than both, and putting
/// the click-time row over it showed a finished thread as running, or took
/// its card away, until its next update (13 Nov 2026, the implicit state
/// machines scan; the Swift app's `threads[threadId] == guess`). Says
/// whether it put it back.
pub fn roll_back<T: Borrow<ThreadSummary>>(
    threads: &mut HashMap<String, T>,
    before: Option<T>,
    guess: Option<&ThreadSummary>,
) -> bool {
    let Some(before) = before else { return false };
    if threads.get(&summary(&before).id).map(summary) != guess {
        return false;
    }
    threads.insert(summary(&before).id.clone(), before);
    true
}

/// Puts back what a summary from a runner doesn't say but this app knows,
/// from the row it's stored over (`old`), as the Swift app's `threads`
/// didSet does for every summary stored:
///
/// - which runner the thread is on: no summary says (`runner_id` is never
///   on the wire), so one from a call's reply (a share's, a project
///   change's) or a relayed thread.updated over another runner's thread
///   would quietly make it one of this Mac's, its calls going to this Mac's
///   runner ("Thread not found") and its own runner's rows skipped as this
///   Mac's (23 Nov review);
/// - another runner's thread's share: the other runners' table leaves it
///   out, so a link made here (the relay's `threads.share` reply) stays
///   until a summary says otherwise. Once made a share never goes back to
///   none (off keeps its slug).
///
/// A thread moved here from another runner keeps the old runner (and its
/// share) only until this Mac's own list says it has arrived: thread.updated
/// asks for that list (app.rs, `arriving`), whose rows don't come through
/// here, and the other runners' table never takes a row of this Mac's.
pub fn keep_local_marks(new: &mut ThreadSummary, old: Option<&ThreadSummary>) {
    let Some(old) = old.filter(|old| old.id == new.id) else {
        return;
    };
    if new.runner_id.is_none() {
        new.runner_id = old.runner_id.clone();
    }
    if new.share.is_none() && new.runner_id.is_some() {
        new.share = old.share.clone();
    }
}

impl OpenAsk {
    /// Where it's to be done, in plain words (`plainWhere`).
    pub fn where_text(&self) -> Option<String> {
        self.place
            .as_deref()
            .filter(|w| !w.is_empty())
            .map(crate::sidebar::preview_plain)
    }
}

fn carry_on_by_default() -> bool {
    true
}

/// One of a thread's projects (`ThreadProject`): who put it there, and the
/// librarian's reason, behind the project's ⓘ in Highlights.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct Project {
    #[serde(default, deserialize_with = "crate::wire::id")]
    pub id: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub title: String,
    /// "mike", "agent" or "librarian".
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub by: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub pinned: bool,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub why: Option<String>,
}

impl ThreadSummary {
    /// While it's on its way to another machine, what its box says in place
    /// of the words ("Moving to bruce…"): anything typed or answered now
    /// could land on the wrong side of the move, so the box and the card
    /// wait. None once it's there, or once the move failed or was called off
    /// (`ThreadMove.line`, ComposerView's `moving`).
    pub fn moving_line(&self) -> Option<String> {
        let moving = self.moving.as_ref()?;
        let state = moving.get("state").and_then(Value::as_str).unwrap_or("");
        let name = moving.get("toName").and_then(Value::as_str).unwrap_or("");
        match state {
            "failed" | "cancelled" => None,
            "ready" => Some(format!("Moving to {name} once this turn ends…")),
            _ => Some(format!("Moving to {name}…")),
        }
    }

    /// What the error bar says when this thread's move has just failed
    /// (`before` was the same thread before this update): where it was going
    /// and why, from the move's note. The row only says "Couldn't move", with
    /// the why behind a tooltip, which told Mike nothing (18 Nov 2026). None
    /// when it hasn't just failed: no move, or the same move already failed
    /// before. Told apart by the move's id, so a second try that also failed
    /// while the app was away still says so (Codex's review).
    pub fn move_failure(&self, before: &ThreadSummary) -> Option<String> {
        let failed = |t: &ThreadSummary| {
            t.moving
                .as_ref()
                .filter(|m| m.get("state").and_then(Value::as_str) == Some("failed"))
                .map(|m| {
                    m.get("moveId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned()
                })
        };
        let now = failed(self)?;
        if failed(before).is_some_and(|was| was == now) {
            return None;
        }
        let moving = self.moving.as_ref()?;
        let to = moving
            .get("toName")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("the other machine");
        let why = moving
            .get("note")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        Some(match why {
            Some(why) => format!("Couldn't move \"{}\" to {to}. {why}", self.title),
            None => format!("Couldn't move \"{}\" to {to}.", self.title),
        })
    }

    /// The runner's wait state, a value this build knows (an unknown one
    /// is drawn as done), or None for a summary without one: the app's own
    /// rule (`section_of_legacy`) decides then.
    pub fn wait_state(&self) -> Option<&str> {
        let s = self.wait_state.as_deref()?;
        Some(if WAIT_STATES.contains(&s) { s } else { "done" })
    }

    /// Newer events than Mike has seen.
    pub fn unread(&self) -> bool {
        self.last_seq > self.last_seen_seq
    }
    /// A turn is running or starting (ThreadStatus.isBusy).
    /// A turn is underway or about to be (Swift `ThreadStatus.isBusy`),
    /// waiting on a permission card included: that turn can still be stopped,
    /// and the composer offered Send instead of Stop for one (10 Nov).
    pub fn busy(&self) -> bool {
        matches!(self.status.as_str(), "running" | "starting" | "waiting")
    }
    /// The background list, read leniently: a malformed entry is left out.
    pub fn background_tasks(&self) -> Vec<BackgroundTask> {
        self.background
            .iter()
            .flatten()
            .filter_map(|v| crate::wire::read(v.clone()))
            .collect()
    }
    /// What's still open on the done card, as the reducer takes it
    /// (Swift `ThreadSummary.looseEnds`, which decodes it leniently too).
    pub fn loose_ends_check(&self) -> Option<crate::reducer::LooseEnds> {
        self.loose_ends
            .as_ref()
            .and_then(crate::reducer::LooseEnds::decode)
    }
    /// Sub-agents or a workflow still at work, or just finished with their
    /// result still to be read (Swift `agentsStillWorking`).
    pub fn agents_still_working(&self) -> bool {
        self.background.iter().flatten().any(|b| {
            matches!(
                b.get("kind").and_then(Value::as_str),
                Some("agent") | Some("other")
            )
        })
    }
    /// The agent said its asks wait for its own shell jobs, and one is still
    /// going (or just finished, its result still to be read): not Mike's to
    /// answer yet, as with sub-agents (24 Nov 2026).
    pub fn asks_wait_for_jobs(&self) -> bool {
        self.asks_after_jobs == Some(true)
            && self
                .background
                .iter()
                .flatten()
                .any(|b| b.get("kind").and_then(Value::as_str) == Some("shell"))
    }
    /// The first name for `agents_still_working`, kept for the thread pane.
    pub fn working(&self) -> bool {
        self.agents_still_working()
    }
    /// Background work and no turn to show for it (Swift
    /// `isWorkingInBackground`): any kind of job counts here, a shell one too.
    pub fn working_in_background(&self) -> bool {
        self.background.as_ref().is_some_and(|b| !b.is_empty()) && !self.busy()
    }
    pub fn said_done(&self) -> bool {
        self.needs.as_deref() == Some("nothing")
    }
    /// A design review waiting on Mike, once the thread has finished working
    /// (Swift `reviewWaiting`).
    pub fn review_waiting(&self) -> bool {
        self.pending_reviews.unwrap_or(0) > 0
            && !self.busy()
            && self.background.as_ref().is_none_or(|b| b.is_empty())
    }
    /// Waiting on an answer from Mike (a card, a question).
    pub fn needs_answer(&self) -> bool {
        self.status == "waiting"
    }
    /// Its turn is stuck on a card only Mike can answer (a permission, a
    /// question, ask_secret), which runs out if he doesn't: first in the
    /// Inbox whatever order it's in (`sort_sections`).
    pub fn on_card(&self) -> bool {
        match self.wait_state() {
            Some(s) => s == "card" && !self.is_archived(),
            None => self.needs_answer() && !self.is_archived(),
        }
    }
    /// The last turn ended asking Mike for something and he hasn't done it
    /// all yet (Swift `waitingOnMike`, whose comments say why sub-agents
    /// still working count differently from a shell job).
    pub fn waiting_on_mike(&self) -> bool {
        if self.needs.as_deref() != Some("you")
            || self.busy()
            || self.agents_still_working()
            || self.asks_wait_for_jobs()
        {
            return false;
        }
        let asks = self.asks.as_deref().unwrap_or(&[]);
        asks.is_empty() || asks.iter().any(|a| a.ticked != Some(true))
    }
    /// Put away by its own agent to wait on its own work, not for Mike: on
    /// threads it's waiting to hear from (end_turn's waitFor, a review of its
    /// change) or on his app restarting onto what it landed. It sits under
    /// Running rather than Hibernating, and its card doesn't say Done, as the
    /// job isn't over: on 19 Nov a thread waiting for main's CI to go green
    /// before landing showed Done, and Mike archived it with nothing landed.
    /// The runner only sends either while the thread is hibernating.
    pub fn waiting_on_work(&self) -> bool {
        if let Some(s) = self.wait_state() {
            return !self.is_archived() && matches!(s, "onThreads" | "landing" | "appRestart");
        }
        if self.is_archived()
            || (self.snoozed_until.is_none() && self.snoozed_until_restart != Some(true))
        {
            return false;
        }
        self.awaiting_app_restart == Some(true)
            || self.awaiting_runs == Some(true)
            || self
                .waiting_on
                .iter()
                .flatten()
                .any(|w| w.get("done").and_then(Value::as_bool) != Some(true))
            || self.waiting_to_land().is_some()
    }
    /// Hibernating until something its own agent is watching for ("when the
    /// landing finishes") while its commits aren't on main yet: waiting to
    /// land, so still working. One Mike hibernated himself isn't. Gives the
    /// loose end's words ("1 commit on … isn't on main").
    pub fn waiting_to_land(&self) -> Option<String> {
        if self.wait_state().is_some_and(|s| s != "landing") {
            return None;
        }
        let wake = self.wake_when.as_ref()?;
        // Watching for something to happen, not just a time in its words.
        if wake.get("agent").and_then(Value::as_bool) != Some(true)
            || wake.get("topic").and_then(Value::as_str).is_none()
        {
            return None;
        }
        self.loose_ends_check()?
            .ends
            .into_iter()
            .find(|e| e.kind == "unlanded")
            .map(|e| e.text)
    }
    /// Snoozed past `now_ms`. A restart snooze carries a far-off `snoozedUntil` too.
    pub fn snoozed(&self, now_ms: i64) -> bool {
        self.snoozed_until_restart == Some(true)
            || self.snoozed_until_ms().is_some_and(|t| t > now_ms)
    }
    pub fn snoozed_until_ms(&self) -> Option<i64> {
        self.snoozed_until.as_deref().and_then(parse_ms)
    }
    /// How much an inbox thread wants Mike, lowest first: InboxUrgency, whose
    /// cases are shared with the phone and the website (and tested below).
    pub fn urgency(&self) -> u8 {
        let broken = self.status == "error" || self.status == "stopped";
        if let Some(s) = self.wait_state() {
            // The runner's `urgencyOf`, from the state alone: a read thread
            // still asking counts as much as an unread one (Mike, 23 Nov).
            return match s {
                "card" | "review" => 0,
                "needsYou" if broken => 1,
                "needsYou" | "limit" => 2,
                "done" if broken => 3,
                _ => 4,
            };
        }
        if self.review_waiting() || self.needs_answer() {
            0
        } else if self.needs_you {
            if broken {
                1
            } else {
                2
            }
        } else if broken {
            3
        } else {
            4
        }
    }
    /// Wants Mike (InboxUrgency.counts): what the Dock badge would count.
    pub fn wants_you(&self) -> bool {
        self.urgency() <= 2
    }
    /// The line under a row's title: its projects, or its folder (`ProjectMark.place`).
    pub fn place(&self) -> String {
        match self.projects.as_deref() {
            Some(projects) if !projects.is_empty() => projects
                .iter()
                .map(|p| {
                    if p.title.is_empty() {
                        "Untitled project"
                    } else {
                        p.title.as_str()
                    }
                })
                .collect::<Vec<_>>()
                .join(", "),
            _ => folder_name(&self.cwd),
        }
    }
    pub fn activity_ms(&self) -> i64 {
        parse_ms(&self.last_activity_at)
            .or_else(|| self.updated_at.as_deref().and_then(parse_ms))
            .or_else(|| self.created_at.as_deref().and_then(parse_ms))
            .unwrap_or(0)
    }
    pub fn archived_ms(&self) -> Option<i64> {
        self.archived_at.as_deref().and_then(parse_ms)
    }
    pub fn is_archived(&self) -> bool {
        self.archived_at.is_some()
    }
    pub fn is_coordinator(&self) -> bool {
        self.coordinator_project_id
            .as_deref()
            .is_some_and(|id| !id.trim().is_empty())
    }
    pub fn is_starred(&self) -> bool {
        self.starred_at.is_some()
    }
    pub fn waiting_for_room_until_ms(&self) -> Option<i64> {
        self.waiting_for_room
            .as_ref()?
            .get("until")?
            .as_str()
            .and_then(parse_ms)
    }
    /// The thread's panels (a page, a picture or a list), read leniently.
    pub fn panels(&self) -> Vec<crate::highlights::Panel> {
        self.panels
            .iter()
            .flatten()
            .filter_map(crate::highlights::Panel::from_value)
            .collect()
    }
    /// Its action chips, read leniently.
    pub fn actions(&self) -> Vec<crate::highlights::Action> {
        self.actions
            .iter()
            .flatten()
            .filter_map(|v| crate::wire::read(v.clone()))
            .collect()
    }
    /// The patches that apply to it, read leniently.
    pub fn patches(&self) -> Vec<crate::highlights::PatchInfo> {
        self.patches
            .iter()
            .flatten()
            .filter_map(|v| crate::wire::read(v.clone()))
            .collect()
    }
    pub fn hooks(&self) -> Vec<crate::highlights::HookInfo> {
        self.hooks
            .iter()
            .flatten()
            .filter_map(|v| crate::wire::read(v.clone()))
            .collect()
    }
    /// A thread on another runner, shown here (`isRemote`).
    pub fn is_remote(&self) -> bool {
        self.runner_id.is_some()
    }
}

/// One item of `ThreadSummary.background` (Swift `BackgroundTask`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct BackgroundTask {
    /// "agent", "shell", "monitor" or "other"; anything else reads as "other".
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub kind: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub description: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub finished: bool,
}

/// How the Inbox section is ordered, from the sort menu on its heading
/// (Swift `InboxOrder`). Newest and oldest ignore urgency.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum InboxOrder {
    #[default]
    NeedsYou,
    Newest,
    Oldest,
}

impl InboxOrder {
    pub const ALL: [InboxOrder; 3] = [InboxOrder::NeedsYou, InboxOrder::Newest, InboxOrder::Oldest];

    pub fn title(self) -> &'static str {
        match self {
            InboxOrder::NeedsYou => "Needs you first",
            InboxOrder::Newest => "Newest first",
            InboxOrder::Oldest => "Oldest first",
        }
    }

    /// The name scripts and the Swift app use for it.
    pub fn name(self) -> &'static str {
        match self {
            InboxOrder::NeedsYou => "needsYou",
            InboxOrder::Newest => "newest",
            InboxOrder::Oldest => "oldest",
        }
    }

    pub fn from_name(name: &str) -> Option<InboxOrder> {
        InboxOrder::ALL.into_iter().find(|o| o.name() == name)
    }

    /// Its icon in the sort menu.
    pub fn symbol(self) -> &'static str {
        match self {
            InboxOrder::NeedsYou => "hand.raised",
            InboxOrder::Newest => "arrow.down",
            InboxOrder::Oldest => "arrow.up",
        }
    }
}

/// A sidebar section and its threads. The rows are whatever the caller keeps
/// its threads in: the app shares them (`Arc<ThreadSummary>`), so building the
/// sections copies pointers, not a summary's every field. The app keeps them
/// until a thread changes, and while threads work that's many times a second:
/// copying 1,400 real-sized summaries took 17 ms each time (sidebar_cost.rs).
#[derive(Clone)]
pub struct Section<T = ThreadSummary> {
    #[allow(dead_code, reason = "the tests find sections by it")]
    pub key: &'static str,
    pub title: &'static str,
    pub rows: Vec<T>,
}

/// Sections in the Mac app's default order (`ThreadSections.build`), with no
/// schedules known.
pub fn sections<'a>(
    threads: impl IntoIterator<Item = &'a ThreadSummary>,
    now_ms: i64,
) -> Vec<Section> {
    sections_ordered(threads, now_ms, InboxOrder::NeedsYou, &HashMap::new())
}

/// When a schedule next messages a thread by itself, and its words for when
/// ("Weekdays at 9:00").
#[derive(Clone, Debug, PartialEq)]
pub struct Wake {
    pub at_ms: i64,
    pub when_text: String,
}

/// `ThreadSections.wakes`: for each thread a schedule will message by itself,
/// the one due soonest. Paused and finished ones don't count, nor ones that
/// start a new thread.
pub fn wakes(schedules: &[crate::highlights::Schedule]) -> HashMap<String, Wake> {
    let mut soonest: HashMap<String, Wake> = HashMap::new();
    for schedule in schedules.iter().filter(|s| s.is_active()) {
        let (Some(thread), Some(at_ms)) = (
            schedule.thread_id.as_ref(),
            schedule.next_run_at.as_deref().and_then(parse_ms),
        ) else {
            continue;
        };
        if soonest.get(thread).is_some_and(|w| w.at_ms <= at_ms) {
            continue;
        }
        soonest.insert(
            thread.clone(),
            Wake {
                at_ms,
                when_text: schedule.when_text.clone(),
            },
        );
    }
    soonest
}

/// `ThreadSections.needsYouCount`: the threads waiting on Mike, for the Dock
/// badge, without sorting anything: one in the Inbox, or starred and awake,
/// that wants him (`wants_you`).
pub fn needs_you_count<'a>(
    threads: impl IntoIterator<Item = &'a ThreadSummary>,
    now_ms: i64,
) -> usize {
    threads
        .into_iter()
        .filter(|t| {
            if !t.wants_you() || t.is_archived() {
                return false;
            }
            if t.is_starred() {
                return t.snoozed_until_ms().is_none();
            }
            if let Some(state) = t.wait_state() {
                return wait_section(state) == "inbox";
            }
            if t.snoozed(now_ms) {
                return false;
            }
            // In the Inbox: what needs Mike goes there even with work going in
            // the background; otherwise a running thread is under Running.
            t.review_waiting()
                || t.needs_answer()
                || t.waiting_on_mike()
                || (t.needs_you && !t.busy() && !t.working_in_background())
                || !(t.busy() || t.working_in_background())
        })
        .count()
}

/// The Dock badge's words: the count, or none (`DockBadge.label`).
pub fn dock_badge(count: usize) -> Option<String> {
    (count > 0).then(|| count.to_string())
}

/// What a notification for a thread that's come to need Mike says
/// (`Notifier.post`): its title, and what it asked for, else its last words.
pub fn notification_words(t: &ThreadSummary) -> (String, String) {
    let title = if t.title.is_empty() {
        "Threadbear".to_owned()
    } else {
        t.title.clone()
    };
    let body = if t.status == "waiting" {
        "Waiting for you to answer.".to_owned()
    } else if let Some(action) = t
        .asks
        .as_ref()
        .and_then(|asks| asks.iter().find(|a| a.ticked != Some(true)))
        .map(|a| crate::sidebar::preview_plain(&a.action))
    {
        action
    } else if t.preview.is_empty() {
        "Finished.".to_owned()
    } else {
        crate::sidebar::preview_plain(&t.preview)
    };
    (title, body)
}

/// `AppModel.apply`'s rule for a notification: the thread has just come to
/// need Mike (it didn't before, or wasn't known) and he isn't looking at it.
/// Never another runner's thread: notifications are low-key, and that Mac's
/// app says so there.
pub fn should_notify(
    before: Option<&ThreadSummary>,
    after: &ThreadSummary,
    looking_at_it: bool,
) -> bool {
    after.needs_you
        && !before.is_some_and(|b| b.needs_you)
        && !looking_at_it
        && after.runner_id.is_none()
}

/// The notification's identifier, as the Swift app's (`Notifier.post`): one
/// per thread and point in it, so a later one doesn't replace an earlier one
/// still unread, and the thread comes back out of it when it's clicked.
pub fn notification_tag(t: &ThreadSummary) -> String {
    format!("{}-{}", t.id, t.last_seq)
}

/// The thread a notification's tag names (`notification_tag`).
pub fn thread_in_tag(tag: &str) -> Option<&str> {
    tag.rsplit_once('-')
        .map(|(id, _)| id)
        .filter(|id| !id.is_empty())
}

/// `ThreadSections.build`: where each thread goes and the order within each
/// heading. `wakes` are the threads a schedule is due to message
/// (`inbox::wakes`): one that's idle with nothing for Mike waits for it under
/// Hibernating rather than sitting in the Inbox.
pub fn sections_ordered<'a, T: Borrow<ThreadSummary> + Clone + 'a>(
    threads: impl IntoIterator<Item = &'a T>,
    now_ms: i64,
    order: InboxOrder,
    wakes: &HashMap<String, Wake>,
) -> Vec<Section<T>> {
    sections_with(threads, now_ms, order, wakes, None)
}

/// `sections_ordered` with nested threads (the nestedThreads experiment,
/// nested.rs): a nested thread has no row of its own, and a starter's row goes
/// where its group does, ordered by the group's most urgent and newest member.
pub fn sections_nested<'a, T: Borrow<ThreadSummary> + Clone + 'a>(
    threads: impl IntoIterator<Item = &'a T>,
    now_ms: i64,
    order: InboxOrder,
    wakes: &HashMap<String, Wake>,
    nesting: &crate::nested::Nesting,
) -> Vec<Section<T>> {
    sections_with(threads, now_ms, order, wakes, Some(nesting))
}

fn sections_with<'a, T: Borrow<ThreadSummary> + Clone + 'a>(
    threads: impl IntoIterator<Item = &'a T>,
    now_ms: i64,
    order: InboxOrder,
    wakes: &HashMap<String, Wake>,
    nesting: Option<&crate::nested::Nesting>,
) -> Vec<Section<T>> {
    let (mut coordinators, mut starred, mut inbox, mut running, mut hibernating, mut archived) =
        (vec![], vec![], vec![], vec![], vec![], vec![]);
    for row in threads {
        let t = summary(row);
        if nesting.is_some_and(|n| n.is_nested(&t.id)) {
            continue;
        }
        let key = nesting
            .and_then(|n| n.group(&t.id))
            .map(|g| g.section)
            .unwrap_or_else(|| section_of(t, now_ms, wakes));
        let section = match key {
            "coordinators" => &mut coordinators,
            "archived" => &mut archived,
            "starred" => &mut starred,
            "hibernating" => &mut hibernating,
            "running" => &mut running,
            _ => &mut inbox,
        };
        section.push(row.clone());
    }
    // A group's row sorts by its most urgent and newest member.
    let keys = |t: &ThreadSummary| match nesting.and_then(|n| n.group(&t.id)) {
        Some(g) => SortKeys {
            urgency: g.urgency,
            activity_ms: g.activity_ms,
            card: g.card,
        },
        None => SortKeys {
            urgency: t.urgency(),
            activity_ms: t.activity_ms(),
            card: t.on_card(),
        },
    };
    sort_sections(
        coordinators,
        starred,
        inbox,
        running,
        hibernating,
        archived,
        order,
        wakes,
        &keys,
    )
}

/// Which section a thread goes under: "coordinators", "starred", "inbox",
/// "running", "hibernating" or "archived" (`sections_ordered`'s rules, for counting one
/// without building them all).
pub fn section_of(t: &ThreadSummary, now_ms: i64, wakes: &HashMap<String, Wake>) -> &'static str {
    if t.is_archived() || t.wait_state() == Some("archived") {
        "archived"
    } else if t.is_coordinator() {
        "coordinators"
    } else if t.is_starred() {
        "starred"
    } else if let Some(state) = t.wait_state() {
        wait_section(state)
    } else {
        section_of_legacy(t, now_ms, wakes)
    }
}

/// The states a runner sends (runner/src/wait-state.ts `WAIT_STATES`).
pub const WAIT_STATES: [&str; 14] = [
    "working",
    "job",
    "onThreads",
    "landing",
    "appRestart",
    "sending",
    "card",
    "review",
    "needsYou",
    "limit",
    "done",
    "scheduled",
    "hibernating",
    "archived",
];

/// The section a wait state is drawn under (the runner's `WAIT_STATES`).
pub fn wait_section(state: &str) -> &'static str {
    match state {
        "working" | "job" | "onThreads" | "landing" | "appRestart" | "sending" => "running",
        "scheduled" | "hibernating" => "hibernating",
        "archived" => "archived",
        _ => "inbox",
    }
}

/// The app's own rule, for a summary with no wait state: a runner from
/// before 23 Nov 2026, or a row this app has just changed itself. Goes once
/// every runner sends one and optimistic changes set the state they guess.
fn section_of_legacy(
    t: &ThreadSummary,
    now_ms: i64,
    wakes: &HashMap<String, Wake>,
) -> &'static str {
    if t.snoozed(now_ms) && t.waiting_on_work() {
        "running"
    } else if t.snoozed(now_ms) {
        "hibernating"
    } else if t.review_waiting()
        || t.needs_answer()
        || t.waiting_on_mike()
        || (t.needs_you && !t.busy() && !t.working_in_background())
    {
        "inbox"
    } else if t.busy() || t.working_in_background() {
        "running"
    } else if t.status == "idle"
        && t.needs.as_deref() != Some("you")
        && t.waiting_for_room.is_none()
        && wakes.contains_key(&t.id)
    {
        "hibernating"
    } else {
        "inbox"
    }
}

/// A thread as the sidebar sorts it while a message Mike sent it is still on
/// its way (the faded bubble with the spinner): starting a turn, as the
/// runner will say once it takes it. Until then the runner's summary still
/// has the last turn's "needs you", so on a busy Mac the thread sat in the
/// Inbox, bold, for as long as the send took (18 Nov). Only the sorting
/// guesses: the runner's next summary replaces the row as usual.
pub fn as_sending(t: &ThreadSummary) -> ThreadSummary {
    let mut t = t.clone();
    // Waiting on a permission card counts as busy, but it sorts into the
    // Inbox: a message sent instead of answering it moves the thread on too.
    if !matches!(t.status.as_str(), "running" | "starting") {
        t.status = "starting".into();
    }
    t.needs_you = false;
    t.needs = None;
    t.wait_state = Some("sending".into());
    t
}

/// The summary behind a row, whatever it's kept in: named, as `.borrow()`
/// alone could mean the row itself.
pub(crate) fn summary<T: Borrow<ThreadSummary>>(row: &T) -> &ThreadSummary {
    row.borrow()
}

/// What a row sorts by: its urgency, its newest activity, and whether a
/// card waits on Mike in it (a nested group's: in any of its threads).
#[derive(Clone, Copy)]
struct SortKeys {
    urgency: u8,
    activity_ms: i64,
    card: bool,
}

#[expect(
    clippy::too_many_arguments,
    reason = "baselined when the lint was turned on (20 Nov 2026); take it off when this is next split up"
)]
fn sort_sections<T: Borrow<ThreadSummary>>(
    mut coordinators: Vec<T>,
    mut starred: Vec<T>,
    mut inbox: Vec<T>,
    mut running: Vec<T>,
    mut hibernating: Vec<T>,
    mut archived: Vec<T>,
    order: InboxOrder,
    wakes: &HashMap<String, Wake>,
    keys: &dyn Fn(&ThreadSummary) -> SortKeys,
) -> Vec<Section<T>> {
    // Sorted by keys worked out once per thread: a time is text to be read,
    // and comparing two threads by reading theirs again each time cost the
    // app more than drawing a frame does (the activity bar's badge counts the
    // Inbox with this on every frame).
    use std::cmp::Reverse;
    let newest_first = |t: &ThreadSummary| (Reverse(keys(t).activity_ms), t.id.clone());
    coordinators.sort_by(|a, b| {
        let (a, b) = (summary(a), summary(b));
        a.coordinator_project_id
            .cmp(&b.coordinator_project_id)
            .then_with(|| a.id.cmp(&b.id))
    });
    starred.sort_by(|a, b| {
        let (a, b) = (summary(a), summary(b));
        a.starred_at
            .cmp(&b.starred_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    // A thread whose turn is stuck on a card goes first in every order: the
    // card runs out, and sorted oldest first it had only just been active,
    // so it sat at the bottom while Mike worked down from the top and his
    // ask_secret card timed out unseen (19 Nov).
    let card_first = |t: &ThreadSummary| !keys(t).card;
    match order {
        InboxOrder::NeedsYou => {
            inbox.sort_by_cached_key(|t| (keys(summary(t)).urgency, newest_first(summary(t))))
        }
        InboxOrder::Newest => {
            inbox.sort_by_cached_key(|t| (card_first(summary(t)), newest_first(summary(t))))
        }
        InboxOrder::Oldest => inbox.sort_by_cached_key(|t| {
            (
                card_first(summary(t)),
                keys(summary(t)).activity_ms,
                Reverse(summary(t).id.clone()),
            )
        }),
    }
    running.sort_by_cached_key(|t| newest_first(summary(t)));
    // A snooze's time, or for one waiting on a schedule its next run. Back on
    // restart has no time, so it goes last.
    let wakes_at = |t: &ThreadSummary| {
        t.snoozed_until_ms()
            .filter(|_| t.snoozed_until_restart != Some(true))
            .or_else(|| wakes.get(&t.id).map(|w| w.at_ms))
            .unwrap_or(i64::MAX)
    };
    hibernating.sort_by_cached_key(|t| (wakes_at(summary(t)), newest_first(summary(t))));
    archived.sort_by_cached_key(|t| (Reverse(summary(t).archived_ms()), summary(t).id.clone()));
    [
        ("starred", "Starred", starred),
        ("coordinators", "Coordinators", coordinators),
        ("inbox", "Inbox", inbox),
        ("running", "Running", running),
        ("hibernating", "Hibernating", hibernating),
        ("archived", "Archived", archived),
    ]
    .into_iter()
    .filter(|(key, _, rows)| !rows.is_empty() || *key == "inbox")
    .map(|(key, title, rows)| Section { key, title, rows })
    .collect()
}

/// Whether a sidebar search finds this thread: its title or its last reply,
/// as ThreadSections.matches has it. `query` is already lowercase.
/// Title, preview or the librarian's search words, case and accent
/// insensitive (`ThreadSections.matches`). The search words find a thread by
/// what it's about when neither says it ("dentist" for a wisdom tooth
/// appointment).
pub fn matches(t: &ThreadSummary, query: &str) -> bool {
    let query = fold(query);
    [
        Some(t.title.as_str()),
        Some(t.preview.as_str()),
        t.keywords.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|text| fold(text).contains(&query))
}

/// Lower case with the accents taken off, for comparing as Swift's
/// `[.caseInsensitive, .diacriticInsensitive]` does: "Café" and "cafe" are
/// the same. Combining marks go, and the accented Latin letters become their
/// plain ones; anything else is only lower-cased.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if ('\u{300}'..='\u{36f}').contains(&c) {
            continue;
        }
        match plain_letter(c) {
            Some(plain) => out.push(plain),
            None => out.extend(c.to_lowercase()),
        }
    }
    out
}

fn plain_letter(c: char) -> Option<char> {
    Some(match c {
        'À'..='Å' | 'à'..='å' | 'Ā'..='ą' => 'a',
        'Ç' | 'ç' | 'Ć'..='č' => 'c',
        'Ď'..='đ' => 'd',
        'È'..='Ë' | 'è'..='ë' | 'Ē'..='ě' => 'e',
        'Ĝ'..='ģ' => 'g',
        'Ĥ'..='ħ' => 'h',
        'Ì'..='Ï' | 'ì'..='ï' | 'Ĩ'..='ı' => 'i',
        'Ĵ' | 'ĵ' => 'j',
        'Ķ' | 'ķ' => 'k',
        'Ĺ'..='ł' => 'l',
        'Ñ' | 'ñ' | 'Ń'..='ň' => 'n',
        'Ò'..='Ö' | 'Ø' | 'ò'..='ö' | 'ø' | 'Ō'..='ő' => 'o',
        'Ŕ'..='ř' => 'r',
        'Ś'..='š' => 's',
        'Ţ'..='ŧ' => 't',
        'Ù'..='Ü' | 'ù'..='ü' | 'Ũ'..='ų' => 'u',
        'Ŵ' | 'ŵ' => 'w',
        'Ý' | 'ý' | 'ÿ' | 'Ŷ' | 'ŷ' | 'Ÿ' => 'y',
        'Ź'..='ž' => 'z',
        _ => return None,
    })
}

/// The last part of a folder's path, on any platform.
pub fn folder_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// "claude-opus-5-5" → "Claude Opus 5.5", "opus" → "Claude Opus",
/// "gpt-6-astra" → "GPT-6 Astra", and with no model the CLI's name: a port
/// of web/src/format.ts's `modelLabel`.
pub fn model_label(provider: &str, model: Option<&str>) -> String {
    let cli = if provider == "codex" {
        "Codex"
    } else {
        "Claude"
    };
    let Some(model) = model.filter(|m| !m.is_empty()) else {
        return cli.into();
    };
    let id = match model.find('[') {
        Some(at) if model.ends_with(']') => &model[..at],
        _ => model,
    };
    let cap = |w: &str| {
        w.chars()
            .next()
            .map(|c| c.to_uppercase().collect::<String>() + &w[c.len_utf8()..])
            .unwrap_or_default()
    };
    let lower = id.to_lowercase();
    let rest = lower.strip_prefix("claude-").unwrap_or(&lower);
    for family in ["opus", "sonnet", "haiku", "fable"] {
        if let Some(after) = rest.strip_prefix(family) {
            let nums: Vec<&str> = after
                .split('-')
                .skip(1)
                .take(2)
                .take_while(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
                .collect();
            if !after.is_empty() && !after.starts_with('-') {
                break;
            }
            let version = if nums.is_empty() {
                String::new()
            } else {
                format!(" {}", nums.join("."))
            };
            return format!("Claude {}{version}", cap(family));
        }
    }
    if let Some(after) = lower.strip_prefix("gpt-") {
        let mut parts = after.splitn(2, '-');
        let version = parts.next().unwrap_or("");
        if !version.is_empty() && version.chars().all(|c| c.is_ascii_digit() || c == '.') {
            let name = parts
                .next()
                .map(|n| format!(" {}", n.split('-').map(cap).collect::<Vec<_>>().join(" ")))
                .unwrap_or_default();
            return format!("GPT-{version}{name}");
        }
    }
    id.to_string()
}

/// "now", "5m", "3h", "2d", then the date, as web/src/format.ts's `ago`.
pub fn ago(ms: i64, now_ms: i64) -> String {
    let s = ((now_ms - ms) / 1000).max(0);
    match s {
        0..60 => "now".into(),
        60..3600 => format!("{}m", s / 60),
        3600..86400 => format!("{}h", s / 3600),
        _ if s < 86400 * 7 => format!("{}d", s / 86400),
        _ => format!("{}w", s / (86400 * 7)),
    }
}

/// Milliseconds since 1970 to ISO 8601 in UTC, as the protocol writes times.
pub fn iso_time(ms: i64) -> String {
    // Howard Hinnant's civil_from_days, the inverse of what parse_ms uses.
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let days = secs.div_euclid(86400);
    let rest = secs.rem_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// ISO 8601 in UTC (the protocol's times) to milliseconds since 1970.
pub fn parse_ms(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| iso.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (
        num(0..4)?,
        num(5..7)?,
        num(8..10)?,
        num(11..13)?,
        num(14..16)?,
        num(17..19)?,
    );
    // Up to three digits of a fraction as milliseconds (".5" is 500), read
    // in place: it's read for every thread as lists sort.
    let frac = if b.get(19) == Some(&b'.') {
        let (mut ms, mut n) = (0i64, 0);
        for c in b[20..].iter().take_while(|c| c.is_ascii_digit()).take(3) {
            ms = ms * 10 + i64::from(c - b'0');
            n += 1;
        }
        ms * [1000, 100, 10, 1][n]
    } else {
        0
    };
    // Days from 1970-01-01 (Howard Hinnant's days_from_civil).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + s * 1000 + frac)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_thread_on_its_way_to_another_machine_says_so_in_its_box() {
        let moving = |state: &str| {
            thread(
                1,
                json!({ "moving": { "moveId": "m1", "to": "r2", "toName": "mac-mini", "state": state } }),
            )
        };
        assert_eq!(
            moving("copying").moving_line().as_deref(),
            Some("Moving to mac-mini…")
        );
        assert_eq!(
            moving("ready").moving_line().as_deref(),
            Some("Moving to mac-mini once this turn ends…")
        );
        assert_eq!(
            moving("failed").moving_line(),
            None,
            "a failed move gives the box back"
        );
        assert_eq!(moving("cancelled").moving_line(), None);
        assert_eq!(thread(2, json!({})).moving_line(), None);
    }

    #[test]
    fn a_move_that_just_failed_says_where_it_was_going_and_why() {
        let moving = |state: &str, note: Option<&str>| {
            let mut m =
                json!({ "moveId": "m1", "to": "r2", "toName": "Hetzner Cloud", "state": state });
            if let Some(n) = note {
                m["note"] = json!(n);
            }
            thread(1, json!({ "moving": m }))
        };
        let why = "The thread or where it would go changed since the Move sheet looked, so it stays where it is.";
        assert_eq!(
            moving("failed", Some(why)).move_failure(&moving("asking", None)).as_deref(),
            Some("Couldn't move \"Thread 1\" to Hetzner Cloud. The thread or where it would go changed since the Move sheet looked, so it stays where it is.")
        );
        assert_eq!(
            moving("failed", None)
                .move_failure(&thread(1, json!({})))
                .as_deref(),
            Some("Couldn't move \"Thread 1\" to Hetzner Cloud.")
        );
        assert_eq!(
            moving("failed", Some(why)).move_failure(&moving("failed", Some(why))),
            None,
            "said once, not on every update after"
        );
        let mut second = moving("failed", Some("Hetzner Cloud has no Claude login."));
        second.moving.as_mut().unwrap()["moveId"] = json!("m2");
        assert_eq!(
            second.move_failure(&moving("failed", Some(why))).as_deref(),
            Some("Couldn't move \"Thread 1\" to Hetzner Cloud. Hetzner Cloud has no Claude login."),
            "another move that failed while the app was away"
        );
        assert_eq!(
            moving("copying", None).move_failure(&moving("asking", None)),
            None
        );
        assert_eq!(
            moving("cancelled", None).move_failure(&moving("asking", None)),
            None,
            "Mike called it off himself"
        );
    }

    #[test]
    fn coordinator_hints_decode_leniently_and_keep_their_section_when_read() {
        for value in [Value::Null, json!(3), json!({}), json!(""), json!("  ")] {
            let row = thread(1, json!({"coordinatorProjectId": value}));
            assert!(!row.is_coordinator());
            assert_eq!(section_of(&row, now(), &HashMap::new()), "inbox");
        }
        let row = thread(
            1,
            json!({"coordinatorProjectId":"p_a", "waitState":"card", "needs":"you", "lastSeenSeq":10}),
        );
        assert!(row.is_coordinator());
        assert_eq!(section_of(&row, now(), &HashMap::new()), "coordinators");
        assert_eq!(needs_you_count([&row], now()), 1);
        let sleeping = thread(
            2,
            json!({"coordinatorProjectId":"p_b", "waitState":"hibernating", "snoozedUntil":"9999-12-31T00:00:00Z"}),
        );
        let gone = thread(
            3,
            json!({"coordinatorProjectId":"p_c", "archivedAt":"2026-11-06T09:00:00Z"}),
        );
        let starred = thread(4, json!({"starredAt":"2026-11-06T09:30:00Z"}));
        let rows = [sleeping, gone, row, starred];
        let sections = sections(rows.iter(), now());
        assert_eq!(
            sections.iter().map(|s| s.key).collect::<Vec<_>>(),
            ["starred", "coordinators", "inbox", "archived"]
        );
        assert_eq!(ids(&sections, "starred"), ["t4"]);
        assert_eq!(ids(&sections, "coordinators"), ["t1", "t2"]);
        assert_eq!(ids(&sections, "archived"), ["t3"]);
    }

    fn thread(n: u32, over: Value) -> ThreadSummary {
        let mut v = json!({
            "id": format!("t{n}"), "title": format!("Thread {n}"), "cwd": "/home/alex/dev/x",
            "provider": "claude", "status": "idle", "needsYou": false,
            "lastActivityAt": format!("2026-11-06T10:{n:02}:00Z"), "preview": "", "lastSeq": 10, "lastSeenSeq": 10
        });
        v.as_object_mut()
            .unwrap()
            .extend(over.as_object().unwrap().clone());
        serde_json::from_value(v).unwrap()
    }
    fn ids(s: &[Section], key: &str) -> Vec<String> {
        s.iter()
            .find(|x| x.key == key)
            .map(|x| x.rows.iter().map(|r| r.id.clone()).collect())
            .unwrap_or_default()
    }
    fn now() -> i64 {
        parse_ms("2026-11-06T12:00:00Z").unwrap()
    }

    /// The runner's wait states (`shared/cases/wait-states.json`): drawn
    /// from the state, every case goes in its section with its urgency and
    /// badge; and with no state (an older runner), the app's own rule puts
    /// it in the same section.
    #[test]
    fn sections_match_the_shared_wait_states() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../shared/cases/wait-states.json"
        );
        let file: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let now = parse_ms(file["now"].as_str().unwrap()).unwrap();
        for case in file["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let t = thread(1, case["thread"].clone());
            let mut wakes = HashMap::new();
            if case["scheduled"].as_bool() == Some(true) {
                wakes.insert(
                    t.id.clone(),
                    Wake {
                        at_ms: now + 60_000,
                        when_text: "soon".into(),
                    },
                );
            }
            let section = case["section"].as_str().unwrap();
            assert_eq!(section_of(&t, now, &wakes), section, "legacy: {name}");
            let mut drawn = t.clone();
            drawn.wait_state = case["state"].as_str().map(str::to_owned);
            assert_eq!(section_of(&drawn, now, &HashMap::new()), section, "{name}");
            assert_eq!(
                u64::from(drawn.urgency()),
                case["urgency"].as_u64().unwrap(),
                "{name}"
            );
            assert_eq!(
                needs_you_count([&drawn], now) == 1,
                case["counted"].as_bool().unwrap(),
                "{name}"
            );
        }
    }

    #[test]
    fn a_thread_with_a_message_on_its_way_is_running_not_in_the_inbox() {
        let waiting = thread(
            1,
            json!({ "needs": "you", "needsYou": true, "lastSeenSeq": 3, "asks": [{ "action": "Send the reply?" }] }),
        );
        assert_eq!(section_of(&waiting, now(), &HashMap::new()), "inbox");
        let sending = as_sending(&waiting);
        assert_eq!(section_of(&sending, now(), &HashMap::new()), "running");
        assert_eq!(ids(&sections([&sending], now()), "running"), ["t1"]);
        // A starred one stays where Mike put it, and one already working
        // keeps what it's doing.
        let starred = as_sending(&thread(
            2,
            json!({ "needsYou": true, "starredAt": "2026-11-06T09:00:00Z" }),
        ));
        assert_eq!(section_of(&starred, now(), &HashMap::new()), "starred");
        assert_eq!(
            as_sending(&thread(3, json!({ "status": "running" }))).status,
            "running"
        );
        // Written instead of answering a permission card.
        let card = thread(4, json!({ "status": "waiting", "needsYou": true }));
        assert_eq!(section_of(&card, now(), &HashMap::new()), "inbox");
        assert_eq!(
            section_of(&as_sending(&card), now(), &HashMap::new()),
            "running"
        );
    }

    #[test]
    fn the_badge_counts_what_waits_on_mike_and_a_notification_says_what_it_asked() {
        let asks = thread(
            1,
            json!({ "needs": "you", "needsYou": true, "asks": [{ "action": "Ship **it**?" }] }),
        );
        let unread = thread(2, json!({ "needsYou": true, "lastSeenSeq": 3 }));
        let read = thread(3, json!({}));
        let asleep = thread(
            4,
            json!({ "needsYou": true, "snoozedUntil": "2026-11-07T00:00:00Z" }),
        );
        let all = [asks.clone(), unread, read, asleep];
        assert_eq!(needs_you_count(&all, now()), 2);
        assert_eq!(dock_badge(2).as_deref(), Some("2"));
        assert_eq!(dock_badge(0), None);
        let (title, body) = notification_words(&asks);
        assert_eq!(title, "Thread 1");
        assert_eq!(body, "Ship it?");
    }

    #[test]
    fn search_finds_the_librarians_words_whatever_the_case_and_accents() {
        let t = thread(
            1,
            json!({ "title": "Café plans", "preview": "Booked the RÉSUMÉ review", "keywords": "dentist wisdom tooth" }),
        );
        assert!(matches(&t, "cafe"), "an accent in the title");
        assert!(matches(&t, "CAFÉ"));
        assert!(matches(&t, "resume"), "and in the preview");
        assert!(matches(&t, "Dentist"), "the librarian's words");
        assert!(!matches(&t, "dentistry"));
        assert_eq!(fold("Ångström Łódź Ñandú"), "angstrom lodz nandu");
        assert_eq!(fold("e\u{301}"), "e", "a combining accent goes too");
    }

    #[test]
    fn a_notification_comes_once_when_a_thread_starts_needing_mike_elsewhere() {
        let quiet = thread(1, json!({}));
        let needy = thread(1, json!({ "needsYou": true, "lastSeq": 42 }));
        assert!(should_notify(Some(&quiet), &needy, false));
        assert!(
            should_notify(None, &needy, false),
            "a thread first heard of needing him"
        );
        assert!(
            !should_notify(Some(&needy), &needy, false),
            "only when it starts"
        );
        assert!(
            !should_notify(Some(&quiet), &needy, true),
            "not while he's looking at it"
        );
        let mut remote = needy.clone();
        remote.runner_id = Some("other-mac".into());
        assert!(
            !should_notify(Some(&quiet), &remote, false),
            "another runner's says so on that Mac"
        );
        let tag = notification_tag(&needy);
        assert_eq!(tag, "t1-42");
        assert_eq!(thread_in_tag(&tag), Some("t1"));
        assert_eq!(
            thread_in_tag("b0e6c5a2-1111-2222-3333-444455556666-7"),
            Some("b0e6c5a2-1111-2222-3333-444455556666"),
            "a thread id has dashes of its own"
        );
        assert_eq!(thread_in_tag("nothing"), None);
    }

    #[test]
    fn a_thread_waiting_on_its_schedule_hibernates_until_it() {
        use crate::highlights::Schedule;
        let schedule = |id: &str, thread: &str, next: &str, paused: bool| Schedule {
            id: id.into(),
            thread_id: Some(thread.into()),
            next_run_at: Some(next.into()),
            when_text: "Weekdays at 9:00".into(),
            paused,
            ..Default::default()
        };
        let quiet = thread(1, json!({}));
        let later = thread(2, json!({}));
        let asks = thread(
            3,
            json!({ "needs": "you", "needsYou": true, "asks": [{ "action": "Ship it?" }] }),
        );
        let paused = thread(4, json!({}));
        let schedules = [
            schedule("s1", "t1", "2026-11-07T09:00:00Z", false),
            schedule("s1b", "t1", "2026-11-06T13:00:00Z", false),
            schedule("s2", "t2", "2026-11-06T12:30:00Z", false),
            schedule("s3", "t3", "2026-11-06T13:00:00Z", false),
            schedule("s4", "t4", "2026-11-06T13:00:00Z", true),
        ];
        let wakes = wakes(&schedules);
        assert_eq!(
            wakes["t1"].at_ms,
            parse_ms("2026-11-06T13:00:00Z").unwrap(),
            "the soonest of its schedules"
        );
        assert!(!wakes.contains_key("t4"), "a paused schedule wakes nothing");
        let s = sections_ordered(
            &[quiet, later, asks, paused],
            now(),
            InboxOrder::NeedsYou,
            &wakes,
        );
        assert_eq!(
            ids(&s, "hibernating"),
            ["t2", "t1"],
            "soonest to wake first"
        );
        assert_eq!(
            ids(&s, "inbox"),
            ["t3", "t4"],
            "one that needs Mike stays where he'll see it"
        );
    }

    #[test]
    fn threads_go_under_the_headings_the_mac_app_uses() {
        let asks = thread(
            1,
            json!({ "needs": "you", "needsYou": true, "asks": [{ "action": "Ship it?" }] }),
        );
        let running = thread(2, json!({ "status": "running" }));
        let done = thread(3, json!({}));
        let asleep = thread(4, json!({ "snoozedUntil": "2026-11-07T00:00:00Z" }));
        let starred = thread(5, json!({ "starredAt": "2026-11-06T09:00:00Z" }));
        let all = [asks, running, done, asleep, starred];
        let s = sections(&all, now());
        assert_eq!(ids(&s, "inbox"), ["t1", "t3"]);
        assert_eq!(ids(&s, "running"), ["t2"]);
        assert_eq!(ids(&s, "hibernating"), ["t4"]);
        assert_eq!(ids(&s, "starred"), ["t5"]);
    }

    #[test]
    fn a_thread_waiting_on_its_own_work_stays_under_running() {
        let waiting = thread(
            1,
            json!({ "needs": "nothing", "snoozedUntil": "2026-11-07T00:00:00Z", "waitingOn": [{ "threadId": "x", "title": "Fix main's CI" }] }),
        );
        let heard = thread(
            2,
            json!({ "needs": "nothing", "snoozedUntil": "2026-11-07T00:00:00Z", "waitingOn": [{ "threadId": "x", "title": "Fix main's CI", "done": true }] }),
        );
        let for_app = thread(
            3,
            json!({ "needs": "nothing", "snoozedUntil": "2026-11-07T00:00:00Z", "awaitingAppRestart": true }),
        );
        let asleep = thread(4, json!({ "snoozedUntil": "2026-11-07T00:00:00Z" }));
        let archived = thread(
            5,
            json!({ "snoozedUntil": "2026-11-07T00:00:00Z", "archivedAt": "2026-11-06T09:00:00Z", "waitingOn": [{ "threadId": "x", "title": "Fix main's CI" }] }),
        );
        let for_runs = thread(
            7,
            json!({ "needs": "nothing", "snoozedUntil": "2026-11-07T00:00:00Z", "awaitingRuns": true }),
        );
        let all = [waiting, heard, for_app, asleep, archived, for_runs];
        let s = sections(&all, now());
        assert_eq!(
            ids(&s, "running"),
            ["t7", "t3", "t1"],
            "still at its job, so not hibernating (newest first)"
        );
        assert_eq!(
            ids(&s, "hibernating"),
            ["t4", "t2"],
            "one whose wait is over, or Mike's own snooze"
        );
        assert_eq!(
            ids(&s, "archived"),
            ["t5"],
            "archiving it still puts it away"
        );
        let woken = thread(6, json!({ "needs": "nothing", "awaitingAppRestart": true }));
        assert!(
            !woken.waiting_on_work(),
            "only while it's hibernating for it"
        );
    }

    #[test]
    fn a_thread_hibernating_with_its_commits_not_on_main_stays_under_running() {
        let unlanded = json!({ "seq": 4, "ends": [{ "kind": "unlanded", "text": "1 commit on thread/x isn't on main" }] });
        let watching = json!({ "said": "when the landing finishes", "topic": "the landing has finished", "agent": true });
        let landing = thread(
            1,
            json!({ "needs": "nothing", "snoozedUntil": "9999-12-31T00:00:00Z", "wakeWhen": watching, "looseEnds": unlanded }),
        );
        let landed = thread(
            2,
            json!({ "needs": "nothing", "snoozedUntil": "9999-12-31T00:00:00Z", "wakeWhen": watching, "looseEnds": { "seq": 4, "ends": [] } }),
        );
        let mikes_own = thread(
            3,
            json!({ "needs": "nothing", "snoozedUntil": "2026-11-07T00:00:00Z", "looseEnds": unlanded }),
        );
        let mikes_words = thread(
            4,
            json!({ "needs": "nothing", "snoozedUntil": "9999-12-31T00:00:00Z", "wakeWhen": { "said": "next time I talk about billing", "topic": "billing" }, "looseEnds": unlanded }),
        );
        let a_time = thread(
            5,
            json!({ "needs": "nothing", "snoozedUntil": "2026-11-08T00:00:00Z", "wakeWhen": { "said": "tomorrow morning", "agent": true }, "looseEnds": unlanded }),
        );
        let s = sections(&[landing, landed, mikes_own, mikes_words, a_time], now());
        assert_eq!(
            ids(&s, "running"),
            ["t1"],
            "waiting to land is still at its job"
        );
        assert_eq!(
            ids(&s, "hibernating"),
            ["t3", "t5", "t4", "t2"],
            "nothing left to land, Mike hibernated it himself, or only a time"
        );
    }

    #[test]
    fn a_turn_waiting_on_a_permission_card_is_still_busy() {
        // As Swift's ThreadStatus.isBusy: it can be stopped, and isn't idle.
        assert!(thread(1, json!({ "status": "waiting" })).busy());
        assert!(thread(1, json!({ "status": "running" })).busy());
        assert!(!thread(1, json!({ "status": "idle" })).busy());
        assert!(!thread(1, json!({ "status": "error" })).busy());
    }

    #[test]
    fn a_thread_stuck_on_an_answer_comes_first_then_newest() {
        let all = [
            thread(1, json!({})),
            thread(2, json!({})),
            thread(3, json!({ "status": "waiting" })),
        ];
        assert_eq!(ids(&sections(&all, now()), "inbox"), ["t3", "t2", "t1"]);
    }

    #[test]
    fn sub_agents_still_going_keep_it_running() {
        let all = [thread(
            1,
            json!({ "needs": "you", "background": [{ "kind": "agent" }] }),
        )];
        assert_eq!(ids(&sections(&all, now()), "running"), ["t1"]);
    }

    #[test]
    fn unread_and_an_empty_inbox() {
        assert!(thread(1, json!({ "lastSeq": 12 })).unread());
        assert!(!thread(1, json!({})).unread());
        let none: [ThreadSummary; 0] = [];
        assert_eq!(
            sections(&none, now())
                .iter()
                .map(|s| s.key)
                .collect::<Vec<_>>(),
            ["inbox"]
        );
    }

    #[test]
    fn dates_and_folders() {
        assert_eq!(parse_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(parse_ms("1970-01-01T00:00:01.25Z"), Some(1250));
        assert_eq!(parse_ms("1970-01-01T00:00:01.123456Z"), Some(1123));
        assert_eq!(parse_ms("1970-01-01T00:00:01.Z"), Some(1000));
        assert_eq!(
            parse_ms("2026-11-06T12:00:00Z").unwrap() - parse_ms("2026-11-06T11:00:00Z").unwrap(),
            3_600_000
        );
        assert_eq!(folder_name("/home/alex/dev/x/"), "x");
        assert_eq!(folder_name(r"C:\Users\alex\dev\y"), "y");
        assert_eq!(ago(now() - 5 * 60_000, now()), "5m");
    }

    #[test]
    fn model_names() {
        assert_eq!(
            model_label("claude", Some("claude-opus-5-5")),
            "Claude Opus 5.5"
        );
        assert_eq!(
            model_label("claude", Some("claude-fable-5-1[1m]")),
            "Claude Fable 5.1"
        );
        assert_eq!(model_label("claude", Some("opus")), "Claude Opus");
        assert_eq!(model_label("codex", Some("gpt-6-astra")), "GPT-6 Astra");
        assert_eq!(model_label("codex", Some("gpt-6.1-sol")), "GPT-6.1 Sol");
        assert_eq!(model_label("claude", None), "Claude");
        assert_eq!(
            model_label("codex", Some("something-else")),
            "something-else"
        );
    }

    // A star that fails rolls back; one that fails after a thread.updated
    // brought the thread's newer state leaves that state standing.
    #[test]
    fn a_failed_change_rolls_back_only_while_the_row_is_still_its_guess() {
        let before = ThreadSummary {
            id: "t".into(),
            status: "running".into(),
            ..Default::default()
        };
        let mut guess = before.clone();
        guess.starred_at = Some("2026-11-13T00:00:00Z".into());
        let mut threads: HashMap<String, ThreadSummary> = HashMap::new();
        threads.insert("t".into(), guess.clone());
        assert!(roll_back(&mut threads, Some(before.clone()), Some(&guess)));
        assert_eq!(threads["t"], before);

        threads.insert("t".into(), guess.clone());
        let mut newer = guess.clone();
        newer.status = "idle".into();
        threads.insert("t".into(), newer.clone());
        assert!(!roll_back(&mut threads, Some(before), Some(&guess)));
        assert_eq!(threads["t"], newer, "the newer row stands");
    }

    // Share on another Mac's thread: the relay's reply names no runner, and
    // storing it as it came made the thread one of this Mac's ("Thread not
    // found" on every send), and the other runners' next table, which has
    // no share, put the share icon back to Only you (23 Nov review).
    #[test]
    fn a_reply_over_another_runners_thread_keeps_its_runner_and_share() {
        let link = json!({ "access": "link", "slug": "abc" });
        let old = ThreadSummary {
            id: "t".into(),
            runner_id: Some("mini".into()),
            share: Some(link),
            ..Default::default()
        };
        // The share's reply: no runner (never on the wire), a new link.
        let mut reply: ThreadSummary =
            serde_json::from_value(json!({ "id": "t", "runnerId": "ignored", "share": { "access": "link", "slug": "new" } }))
                .unwrap();
        assert_eq!(reply.runner_id, None, "runnerId is never read off the wire");
        keep_local_marks(&mut reply, Some(&old));
        assert_eq!(reply.runner_id.as_deref(), Some("mini"));
        assert_eq!(
            reply.share,
            Some(json!({ "access": "link", "slug": "new" })),
            "the reply's own share wins"
        );

        // That runner's next table row: its runner, no share.
        let mut row = ThreadSummary {
            id: "t".into(),
            runner_id: Some("mini".into()),
            ..Default::default()
        };
        keep_local_marks(&mut row, Some(&reply));
        assert_eq!(row.share, Some(json!({ "access": "link", "slug": "new" })));
    }

    #[test]
    fn a_reply_over_this_macs_thread_stays_this_macs() {
        let old = ThreadSummary {
            id: "t".into(),
            share: Some(json!({ "access": "link", "slug": "abc" })),
            ..Default::default()
        };
        let mut reply = ThreadSummary {
            id: "t".into(),
            ..Default::default()
        };
        keep_local_marks(&mut reply, Some(&old));
        assert_eq!(reply.runner_id, None);
        // This Mac's runner says its own share, so none is none.
        assert_eq!(reply.share, None);
        // A new thread has nothing to keep.
        let mut fresh = ThreadSummary {
            id: "n".into(),
            ..Default::default()
        };
        keep_local_marks(&mut fresh, None);
        assert_eq!(
            fresh,
            ThreadSummary {
                id: "n".into(),
                ..Default::default()
            }
        );
    }
}
