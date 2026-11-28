//! The inline project brief shown for each project in a normal thread's
//! Highlights pane: the project's live state, open questions and tasks
//! (coordinator tasks/decisions plus open `Needs you` asks from other open
//! threads in the project), and other open threads in the project.
use crate::coordinators::tasks::{Kind as TaskKind, Owner, State as TaskState, StatusBucket};
use crate::coordinators::{Coordinator, TaskState as LegacyTaskState};
use crate::inbox::ThreadSummary;
use crate::projects::{self, Project};
use crate::sidebar::{preview_plain, relative_short};
use chrono::{DateTime, TimeZone};
use std::collections::HashSet;

/// Default row caps inside the inline project brief before "Show all".
pub const ITEM_LIMIT: usize = 5;
pub const THREAD_LIMIT: usize = 4;
/// Characters shown in the State preview before a "More" toggle appears.
pub const STATE_PREVIEW_CHARS: usize = 210;
/// Lines shown in the State preview before a "More" toggle appears.
pub const STATE_PREVIEW_LINES: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum BriefUrgency {
    NeedsYou,
    Working,
    Ready,
    Waiting,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BriefTarget {
    CoordinatorTask { project_id: String, task_id: String },
    CoordinatorHome { project_id: String },
    Thread { thread_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BriefItem {
    pub id: String,
    pub title: String,
    pub note: Option<String>,
    pub urgency: BriefUrgency,
    pub tag: String,
    pub target: BriefTarget,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BriefThread {
    pub id: String,
    pub title: String,
    pub running: bool,
    pub tag: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectBrief {
    pub has_coordinator: bool,
    pub has_task_board: bool,
    pub coordinator_open_tasks: usize,
    pub state: Option<String>,
    pub state_updated: Option<String>,
    pub items: Vec<BriefItem>,
    pub open_threads: Vec<BriefThread>,
}

impl ProjectBrief {
    pub fn build<'a, Tz: TimeZone>(
        project: Option<&Project>,
        coordinator: Option<&Coordinator>,
        current_thread_id: &str,
        threads: impl IntoIterator<Item = &'a ThreadSummary>,
        now: &DateTime<Tz>,
    ) -> Self {
        let now_ms = now.timestamp_millis();
        let Some(project) = project else {
            return Self::default();
        };

        let state_raw = project.state.trim();
        let state = (!state_raw.is_empty()).then(|| state_raw.to_owned());
        let state_updated = state.as_ref().and_then(|_| {
            project
                .state_updated_ms
                .map(|at| format!("Updated {}", projects::ago(at, now)))
        });

        let coord_thread_id = coordinator.map(|c| c.thread_id.as_str());
        let mut coord_thread: Option<&ThreadSummary> = None;
        let mut project_threads: Vec<&ThreadSummary> = Vec::new();
        let mut seen = HashSet::new();

        // Filter to this project's open inbox threads in a single pass before
        // sorting, so large thread lists (1,000+ archived/unrelated threads)
        // never parse timestamps or sort threads outside this project.
        for thread in threads {
            if coord_thread_id == Some(thread.id.as_str()) {
                coord_thread = Some(thread);
                continue;
            }
            if thread.id == current_thread_id
                || thread.is_coordinator()
                || thread.is_archived()
                || (thread.snoozed(now_ms) && !thread.waiting_on_work())
                || !thread.projects.iter().flatten().any(|m| m.id == project.id)
                || !seen.insert(thread.id.as_str())
            {
                continue;
            }
            project_threads.push(thread);
        }

        let (items, has_task_board, coordinator_open_tasks) =
            collect_coordinator_items(project, coordinator, coord_thread);

        project_threads.sort_by_cached_key(|t| (std::cmp::Reverse(t.activity_ms()), t.id.as_str()));
        let mut thread_needs: Vec<BriefItem> = Vec::new();
        let mut running_threads: Vec<BriefThread> = Vec::new();
        let mut idle_threads: Vec<BriefThread> = Vec::new();

        for thread in project_threads {
            let thread_title = if thread.title.trim().is_empty() {
                "Untitled"
            } else {
                thread.title.trim()
            };

            let unticked_asks: Vec<String> = thread
                .asks
                .iter()
                .flatten()
                .filter(|a| a.ticked != Some(true))
                .map(|a| preview_plain(&a.action))
                .filter(|s| !s.is_empty())
                .collect();

            let needs_user = thread.on_card()
                || thread.waiting_on_mike()
                || thread.review_waiting()
                || (!unticked_asks.is_empty() && !thread.busy() && !thread.asks_wait_for_jobs());

            if needs_user {
                let (title, note) = if let Some(first_ask) = unticked_asks.first() {
                    let count = unticked_asks.len();
                    let short = truncate_chars(thread_title, 34);
                    let asks_word = if count == 1 { "ask" } else { "asks" };
                    (
                        first_ask.clone(),
                        Some(format!("In \"{short}\" · {count} {asks_word}")),
                    )
                } else if thread.on_card() {
                    (
                        thread_title.to_owned(),
                        Some("Waiting for your approval or answer".to_owned()),
                    )
                } else if thread.review_waiting() {
                    (
                        thread_title.to_owned(),
                        Some("Design review waiting on your pick".to_owned()),
                    )
                } else {
                    (thread_title.to_owned(), Some("Needs your reply".to_owned()))
                };
                thread_needs.push(BriefItem {
                    id: format!("thread-ask:{}", thread.id),
                    title,
                    note,
                    urgency: BriefUrgency::NeedsYou,
                    tag: "You →".to_owned(),
                    target: BriefTarget::Thread {
                        thread_id: thread.id.clone(),
                    },
                });
                continue;
            }

            let running =
                thread.busy() || thread.working_in_background() || thread.waiting_on_work();
            let row = BriefThread {
                id: thread.id.clone(),
                title: thread_title.to_owned(),
                running,
                tag: if running {
                    "Running".to_owned()
                } else {
                    relative_short(thread.activity_ms(), now)
                },
            };
            if running {
                running_threads.push(row);
            } else {
                idle_threads.push(row);
            }
        }

        // Keep NeedsYou coordinator items first, then other threads' NeedsYou
        // items, then Working / Ready / Waiting coordinator items.
        let mut merged: Vec<BriefItem> = Vec::with_capacity(items.len() + thread_needs.len());
        let mut rest: Vec<BriefItem> = Vec::new();
        for item in items {
            if item.urgency == BriefUrgency::NeedsYou {
                merged.push(item);
            } else {
                rest.push(item);
            }
        }
        merged.extend(thread_needs);
        rest.sort_by_key(|item| item.urgency);
        merged.extend(rest);

        running_threads.extend(idle_threads);

        Self {
            has_coordinator: coordinator.is_some(),
            has_task_board,
            coordinator_open_tasks,
            state,
            state_updated,
            items: merged,
            open_threads: running_threads,
        }
    }

    pub fn waiting_count(&self) -> usize {
        self.items
            .iter()
            .filter(|i| i.urgency == BriefUrgency::NeedsYou)
            .count()
    }

    pub fn has_card_content(&self, links_count: usize) -> bool {
        self.state.is_some()
            || !self.items.is_empty()
            || !self.open_threads.is_empty()
            || links_count > 0
    }

    /// Compact summary shown on a collapsed project heading, e.g.
    /// `"2 waiting · 5 open"` or `"1 open"`.
    pub fn collapsed_summary(&self, links_count: usize) -> Option<String> {
        let mut parts: Vec<String> = Vec::new();
        let waiting = self.waiting_count();
        if waiting > 0 {
            parts.push(format!("{waiting} waiting"));
        }
        if !self.open_threads.is_empty() {
            parts.push(format!("{} open", self.open_threads.len()));
        }
        if parts.is_empty() {
            if self.coordinator_open_tasks > 0 {
                let n = self.coordinator_open_tasks;
                parts.push(format!("{n} task{}", if n == 1 { "" } else { "s" }));
            } else if !self.items.is_empty() {
                parts.push(format!("{} open", self.items.len()));
            } else if links_count > 0 {
                parts.push(links_count.to_string());
            }
        }
        (!parts.is_empty()).then(|| parts.join(" · "))
    }

    /// Preview of the project's state text, returning `(text, truncated)`.
    pub fn state_preview(&self) -> Option<(String, bool)> {
        let full = self.state.as_deref()?;
        Some(preview_state_text(
            full,
            STATE_PREVIEW_CHARS,
            STATE_PREVIEW_LINES,
        ))
    }
}

/// Truncates `text` cleanly at a word boundary if it exceeds `max_chars` or
/// `max_lines`, returning `(preview, was_truncated)`.
pub fn preview_state_text(text: &str, max_chars: usize, max_lines: usize) -> (String, bool) {
    let lines: Vec<&str> = text.lines().collect();
    let line_cut = lines.len() > max_lines;
    let joined = if line_cut {
        lines[..max_lines].join("\n")
    } else {
        text.to_owned()
    };
    let char_count = joined.chars().count();
    if char_count <= max_chars && !line_cut {
        return (joined, false);
    }
    if char_count <= max_chars {
        return (format!("{}…", joined.trim_end()), true);
    }
    let slice: String = joined.chars().take(max_chars).collect();
    let trimmed = match slice.rfind(char::is_whitespace) {
        Some(pos) if pos > max_chars / 2 => slice[..pos].trim_end(),
        _ => slice.trim_end(),
    };
    (format!("{trimmed}…"), true)
}

fn collect_coordinator_items(
    project: &Project,
    coordinator: Option<&Coordinator>,
    coord_thread: Option<&ThreadSummary>,
) -> (Vec<BriefItem>, bool, usize) {
    let Some(coord) = coordinator else {
        return (Vec::new(), false, 0);
    };
    let mut items = Vec::new();
    if let Some(board) = coord.task_board.as_deref() {
        for task in board.active_pulse() {
            let (urgency, tag) = match task.status_bucket() {
                StatusBucket::NeedsYou => (BriefUrgency::NeedsYou, "You →".to_owned()),
                StatusBucket::InProgress if task.state == TaskState::Working => {
                    (BriefUrgency::Working, "Working".to_owned())
                }
                StatusBucket::InProgress if task.state == TaskState::ReadyToClose => {
                    (BriefUrgency::Ready, "Ready".to_owned())
                }
                _ => {
                    let label = match &task.owner {
                        Owner::Person { name } => name.clone(),
                        _ => task.state.label().to_owned(),
                    };
                    (BriefUrgency::Waiting, label)
                }
            };
            let note = task
                .now
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| truncate_chars(s, 96))
                .or_else(|| {
                    (urgency == BriefUrgency::NeedsYou && task.kind == TaskKind::Decision)
                        .then(|| "Coordinator decision · Waiting on your pick".to_owned())
                });
            items.push(BriefItem {
                id: format!("task:{}", task.id),
                title: task.title.clone(),
                note,
                urgency,
                tag,
                target: BriefTarget::CoordinatorTask {
                    project_id: project.id.clone(),
                    task_id: task.id.clone(),
                },
            });
        }
        return (items, true, board.open_count());
    }

    // Legacy coordinator without a canonical task board: mirror its open asks,
    // non-waiting loops, and active helper tasks.
    if let Some(coord_thread) = coord_thread {
        for (idx, ask) in coord_thread
            .asks
            .iter()
            .flatten()
            .filter(|a| a.ticked != Some(true))
            .enumerate()
        {
            let action = preview_plain(&ask.action);
            if action.is_empty() {
                continue;
            }
            items.push(BriefItem {
                id: format!("coord-ask:{idx}"),
                title: action,
                note: Some("Coordinator · Needs your answer".to_owned()),
                urgency: BriefUrgency::NeedsYou,
                tag: "You →".to_owned(),
                target: BriefTarget::CoordinatorHome {
                    project_id: project.id.clone(),
                },
            });
        }
    }
    for item in coord
        .open_loops()
        .into_iter()
        .filter(|l| !l.waiting_on_user())
    {
        let (urgency, tag) = if item.needs_signoff() {
            (BriefUrgency::Ready, "Ready".to_owned())
        } else {
            (BriefUrgency::Working, "Checking".to_owned())
        };
        items.push(BriefItem {
            id: format!("loop:{}", item.id),
            title: item.title.clone(),
            note: item.summary.as_deref().map(|s| truncate_chars(s, 96)),
            urgency,
            tag,
            target: BriefTarget::CoordinatorHome {
                project_id: project.id.clone(),
            },
        });
    }
    for task in coord.tasks.iter().filter(|t| !t.finished()) {
        let (urgency, tag) = if task.state == LegacyTaskState::Review || task.status == "completed"
        {
            (BriefUrgency::Ready, "Review".to_owned())
        } else {
            match task.state {
                LegacyTaskState::Working => (BriefUrgency::Working, "Working".to_owned()),
                LegacyTaskState::Blocked => (BriefUrgency::NeedsYou, "Blocked".to_owned()),
                _ => (BriefUrgency::Waiting, "To do".to_owned()),
            }
        };
        let note = task
            .summary
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| (!task.done_when.trim().is_empty()).then_some(task.done_when.as_str()))
            .map(|s| truncate_chars(s.trim(), 96));
        items.push(BriefItem {
            id: format!("ctask:{}", task.id),
            title: task.title.clone(),
            note,
            urgency,
            tag,
            target: BriefTarget::CoordinatorHome {
                project_id: project.id.clone(),
            },
        });
    }
    (items, false, 0)
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    let prefix: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{}…", prefix.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordinators::tasks::TaskBoard;
    use crate::inbox::{OpenAsk, Project as Membership};
    use chrono::Utc;
    use serde_json::json;
    use std::sync::Arc;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-27T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn project(id: &str, title: &str, state: &str, state_updated_ms: Option<i64>) -> Project {
        Project {
            id: id.into(),
            title: title.into(),
            state: state.into(),
            state_updated_ms,
            ..Default::default()
        }
    }

    fn thread(id: &str, title: &str, project_id: &str, activity: &str) -> ThreadSummary {
        ThreadSummary {
            id: id.into(),
            title: title.into(),
            last_activity_at: activity.into(),
            status: "idle".into(),
            projects: Some(vec![Membership {
                id: project_id.into(),
                title: "P".into(),
                by: "mike".into(),
                pinned: true,
                why: None,
            }]),
            ..Default::default()
        }
    }

    fn coordinator_with_board(project_id: &str, thread_id: &str) -> Coordinator {
        let board = TaskBoard::decode(&json!({
            "workItems": [],
            "tasks": [
                {
                    "id": "t_decision",
                    "title": "Approve Usage honey pot tooltip wording",
                    "kind": "decision",
                    "owner": { "kind": "user" },
                    "state": "todo",
                    "needsYou": true
                },
                {
                    "id": "t_working",
                    "title": "Verify Search Console indexing for /docs",
                    "kind": "action",
                    "owner": { "kind": "agent" },
                    "state": "working",
                    "now": "Helper checking sitemap status"
                },
                {
                    "id": "t_ready",
                    "title": "Preview-before-coding local recipe",
                    "kind": "action",
                    "owner": { "kind": "agent" },
                    "state": "ready_to_close",
                    "now": "Saved to ~/ThreadbearThreads/recipes"
                },
                {
                    "id": "t_done",
                    "title": "Already finished",
                    "kind": "action",
                    "owner": { "kind": "agent" },
                    "state": "done"
                }
            ]
        }))
        .unwrap();
        Coordinator {
            project_id: project_id.into(),
            thread_id: thread_id.into(),
            state: crate::coordinators::State::Active,
            charter: String::new(),
            interests: vec![],
            tasks: vec![],
            loops: vec![],
            task_board: Some(Arc::new(board)),
            updated_at: "2026-11-27T11:50:00Z".into(),
        }
    }

    #[test]
    fn merges_coordinator_tasks_thread_asks_and_open_threads_cleanly() {
        let now = now();
        let fourteen_min_ago = now.timestamp_millis() - 14 * 60 * 1000;
        let proj = project(
            "p_tb",
            "Threadbear",
            "27 Nov Mac release is live.",
            Some(fourteen_min_ago),
        );
        let coord = coordinator_with_board("p_tb", "t_coord");

        let current = thread(
            "t_current",
            "Current thread",
            "p_tb",
            "2026-11-27T11:59:00Z",
        );
        let coord_thread = ThreadSummary {
            coordinator_project_id: Some("p_tb".into()),
            ..thread("t_coord", "Threadbear", "p_tb", "2026-11-27T11:58:00Z")
        };

        let mut ask_thread = thread(
            "t_ask",
            "Thread stuck in Running after quota",
            "p_tb",
            "2026-11-27T11:55:00Z",
        );
        ask_thread.needs = Some("you".into());
        ask_thread.needs_you = true;
        ask_thread.asks = Some(vec![OpenAsk {
            action: "Confirm **Convex** panel production view".into(),
            ticked: Some(false),
            ..Default::default()
        }]);

        let mut running = thread(
            "t_run",
            "Why PRs open under highlights",
            "p_tb",
            "2026-11-27T11:40:00Z",
        );
        running.status = "running".into();

        let idle_newer = thread(
            "t_idle_new",
            "Shareable web artifacts",
            "p_tb",
            "2026-11-27T11:32:00Z",
        );
        let idle_older = thread(
            "t_idle_old",
            "Monitoring Coordinators",
            "p_tb",
            "2026-11-27T10:00:00Z",
        );
        let mut archived = thread("t_arch", "Old thread", "p_tb", "2026-11-27T11:50:00Z");
        archived.archived_at = Some("2026-11-27T11:51:00Z".into());

        let mut snoozed = thread("t_snooze", "Later thread", "p_tb", "2026-11-27T11:50:00Z");
        snoozed.snoozed_until = Some("2026-11-28T12:00:00Z".into());

        let other_project = thread("t_other", "Unrelated", "p_other", "2026-11-27T11:55:00Z");

        let brief = ProjectBrief::build(
            Some(&proj),
            Some(&coord),
            "t_current",
            [
                &current,
                &coord_thread,
                &ask_thread,
                &running,
                &idle_older,
                &idle_newer,
                &archived,
                &snoozed,
                &other_project,
            ],
            &now,
        );

        assert!(brief.has_coordinator);
        assert!(brief.has_task_board);
        assert_eq!(brief.coordinator_open_tasks, 3);
        assert_eq!(brief.state.as_deref(), Some("27 Nov Mac release is live."));
        assert_eq!(brief.state_updated.as_deref(), Some("Updated 14m ago"));

        // Items order: NeedsYou coordinator decision, NeedsYou thread ask, Working, Ready.
        let titles: Vec<&str> = brief.items.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(
            titles,
            vec![
                "Approve Usage honey pot tooltip wording",
                "Confirm Convex panel production view",
                "Verify Search Console indexing for /docs",
                "Preview-before-coding local recipe",
            ]
        );
        assert_eq!(brief.items[0].urgency, BriefUrgency::NeedsYou);
        assert_eq!(
            brief.items[0].target,
            BriefTarget::CoordinatorTask {
                project_id: "p_tb".into(),
                task_id: "t_decision".into()
            }
        );
        assert_eq!(brief.items[1].urgency, BriefUrgency::NeedsYou);
        assert_eq!(
            brief.items[1].target,
            BriefTarget::Thread {
                thread_id: "t_ask".into()
            }
        );
        assert!(brief.items[1]
            .note
            .as_deref()
            .unwrap_or("")
            .contains("1 ask"));
        assert_eq!(brief.items[2].urgency, BriefUrgency::Working);
        assert_eq!(brief.items[3].urgency, BriefUrgency::Ready);

        // Open threads: running first, then newest idle first; excludes current,
        // coordinator, ask_thread (already in items), archived, snoozed, other project.
        let thread_ids: Vec<&str> = brief.open_threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(thread_ids, vec!["t_run", "t_idle_new", "t_idle_old"]);
        assert!(brief.open_threads[0].running);
        assert_eq!(brief.open_threads[0].tag, "Running");
        assert_eq!(brief.open_threads[1].tag, "28m");
        assert_eq!(brief.open_threads[2].tag, "2h");

        assert_eq!(
            brief.collapsed_summary(4).as_deref(),
            Some("2 waiting · 3 open")
        );
    }

    #[test]
    fn non_coordinated_project_still_builds_state_asks_and_open_threads() {
        let now = now();
        let proj = project("p_mt", "Mikerosoft tools", "Delegate works.", None);
        let mut ask_thread = thread(
            "t_ask",
            "Next steps for Mikerosoft tools",
            "p_mt",
            "2026-11-27T11:00:00Z",
        );
        ask_thread.needs = Some("you".into());
        ask_thread.needs_you = true;

        let open = thread("t_open", "Polish agy_usage", "p_mt", "2026-11-27T11:30:00Z");

        let brief = ProjectBrief::build(Some(&proj), None, "t_cur", [&ask_thread, &open], &now);
        assert!(!brief.has_coordinator);
        assert_eq!(brief.state.as_deref(), Some("Delegate works."));
        assert_eq!(brief.state_updated, None);
        assert_eq!(brief.items.len(), 1);
        assert_eq!(brief.items[0].title, "Next steps for Mikerosoft tools");
        assert_eq!(brief.items[0].tag, "You →");
        assert_eq!(brief.open_threads.len(), 1);
        assert_eq!(brief.open_threads[0].id, "t_open");
        assert_eq!(
            brief.collapsed_summary(1).as_deref(),
            Some("1 waiting · 1 open")
        );
    }

    #[test]
    fn preview_state_text_truncates_cleanly_at_word_or_line_boundary() {
        let short = "Short project state.";
        assert_eq!(preview_state_text(short, 100, 3), (short.to_owned(), false));

        let long = "The share sheet is live in the beta and the uploader now resumes after a crash. Next up is the nightly report and a faster build on CI for the release branch.";
        let (preview, cut) = preview_state_text(long, 60, 3);
        assert!(cut);
        assert!(preview.ends_with('…'));
        assert!(preview.chars().count() <= 61);

        let multiline = "Line one\nLine two\nLine three\nLine four";
        let (preview, cut) = preview_state_text(multiline, 200, 3);
        assert!(cut);
        assert_eq!(preview, "Line one\nLine two\nLine three…");
    }
}
