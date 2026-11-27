//! The canonical coordinator task board and the two desktop views of it.
use crate::inbox::{OpenAsk, ThreadSummary};
use chrono::{NaiveDate, NaiveDateTime, Timelike};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskBoard {
    pub work_items: Vec<WorkItem>,
    pub tasks: Vec<WorkTask>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub progress: Option<Progress>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTask {
    pub id: String,
    pub title: String,
    pub kind: Kind,
    pub owner: Owner,
    pub state: State,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub work_item_id: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub parent_task_id: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub now: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub done_when: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub source: Option<Source>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub decision: Option<Decision>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub due: Option<TaskDue>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub updated_at: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub closed_at: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub can_reopen: bool,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub needs_you: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Decision,
    Action,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Owner {
    User,
    Agent,
    Person { name: String },
}

impl Owner {
    pub fn label(&self) -> &str {
        match self {
            Self::User => "You",
            Self::Agent => "Agent",
            Self::Person { name } => name,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Todo,
    Working,
    Waiting,
    Postponed,
    ReadyToClose,
    Done,
}

impl State {
    pub fn label(self) -> &'static str {
        match self {
            Self::Todo => "To do",
            Self::Working => "Working",
            Self::Waiting => "Waiting",
            Self::Postponed => "Postponed",
            Self::ReadyToClose => "Ready to close",
            Self::Done => "Done",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub thread_id: Option<String>,
    pub run_id: Option<String>,
    pub seq: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Decision {
    #[serde(default)]
    pub options: Vec<Choice>,
    pub recommendation: Option<String>,
    pub answer: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Choice {
    pub label: String,
    pub does: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TaskDue {
    At { at: String },
    AfterTask { task_id: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    Decision,
    Agent,
    Person,
    Postponed,
    Done,
}

impl Mark {
    pub const ALL: [Self; 5] = [
        Self::Decision,
        Self::Agent,
        Self::Person,
        Self::Postponed,
        Self::Done,
    ];

    pub fn glyph(self) -> &'static str {
        match self {
            Self::Decision => "◆",
            Self::Agent => "◌",
            Self::Person => "👤",
            Self::Postponed => "⏸",
            Self::Done => "✓",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Decision => "Decision",
            Self::Agent => "Agent work",
            Self::Person => "Person's turn",
            Self::Postponed => "Postponed",
            Self::Done => "Done",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Highlight {
    NeedsYou,
    InFlight,
    ReadyToClose,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusBucket {
    NeedsYou,
    InProgress,
    Waiting,
    Done,
}

impl StatusBucket {
    pub const ALL: [Self; 4] = [Self::NeedsYou, Self::InProgress, Self::Waiting, Self::Done];

    pub fn label(self) -> &'static str {
        match self {
            Self::NeedsYou => "Needs you",
            Self::InProgress => "In progress",
            Self::Waiting => "Waiting & scheduled",
            Self::Done => "Done",
        }
    }
}

impl WorkTask {
    pub fn mark(&self) -> Mark {
        match (self.state, self.kind, &self.owner) {
            (State::Done, _, _) => Mark::Done,
            (State::Postponed, _, _) => Mark::Postponed,
            (_, Kind::Decision, _) => Mark::Decision,
            (_, _, Owner::Agent) => Mark::Agent,
            _ => Mark::Person,
        }
    }

    pub fn highlight(&self) -> Option<Highlight> {
        match self.state {
            State::Done | State::Postponed => None,
            _ if self.owner == Owner::User => Some(Highlight::NeedsYou),
            State::ReadyToClose => Some(Highlight::ReadyToClose),
            _ => Some(Highlight::InFlight),
        }
    }

    pub fn status_bucket(&self) -> StatusBucket {
        match self.state {
            State::Done => StatusBucket::Done,
            State::Postponed => StatusBucket::Waiting,
            _ if self.owner == Owner::User || self.needs_you => StatusBucket::NeedsYou,
            State::Waiting => StatusBucket::Waiting,
            State::Working | State::Todo | State::ReadyToClose => StatusBucket::InProgress,
        }
    }

    fn urgency_rank(&self) -> u8 {
        match self.status_bucket() {
            StatusBucket::NeedsYou => match self.kind {
                Kind::Decision => 0,
                Kind::Action => 1,
            },
            StatusBucket::InProgress => match self.state {
                State::Working => 2,
                State::ReadyToClose => 3,
                _ => 4,
            },
            StatusBucket::Waiting => match self.state {
                State::Waiting => 5,
                _ => 6,
            },
            StatusBucket::Done => 7,
        }
    }
}

pub struct StatusGroup<'a> {
    pub bucket: StatusBucket,
    pub tasks: Vec<&'a WorkTask>,
}

pub struct TaskRow<'a> {
    pub task: &'a WorkTask,
    pub children: Vec<&'a WorkTask>,
}

pub struct Group<'a> {
    pub item: Option<&'a WorkItem>,
    pub roots: Vec<TaskRow<'a>>,
}

impl<'a> Group<'a> {
    fn from_tasks(
        item: Option<&'a WorkItem>,
        roots: Vec<&'a WorkTask>,
        children: &mut HashMap<&str, Vec<&'a WorkTask>>,
    ) -> Self {
        Self {
            item,
            roots: roots
                .into_iter()
                .map(|task| TaskRow {
                    task,
                    children: children.remove(task.id.as_str()).unwrap_or_default(),
                })
                .collect(),
        }
    }

    pub fn progress(&self) -> Progress {
        self.item
            .and_then(|item| item.progress)
            .unwrap_or_else(|| Progress {
                done: self
                    .roots
                    .iter()
                    .filter(|row| row.task.state == State::Done)
                    .count(),
                total: self.roots.len(),
            })
    }
}

impl TaskBoard {
    pub fn decode(value: &Value) -> Option<Self> {
        value.as_object()?;
        Some(Self {
            work_items: rows(&value["workItems"], |item: &WorkItem| &item.id),
            tasks: rows(&value["tasks"], |task: &WorkTask| &task.id),
        })
    }

    pub fn task(&self, id: &str) -> Option<&WorkTask> {
        self.tasks.iter().find(|task| task.id == id)
    }

    pub fn groups(&self) -> Vec<Group<'_>> {
        let roots: HashSet<&str> = self
            .tasks
            .iter()
            .filter(|task| task.parent_task_id.is_none())
            .map(|task| task.id.as_str())
            .collect();
        let mut children: HashMap<&str, Vec<&WorkTask>> = HashMap::new();
        let mut grouped: HashMap<&str, Vec<&WorkTask>> = self
            .work_items
            .iter()
            .map(|item| (item.id.as_str(), Vec::new()))
            .collect();
        let mut ungrouped = Vec::new();
        for task in &self.tasks {
            if let Some(parent) = task
                .parent_task_id
                .as_deref()
                .filter(|id| roots.contains(id))
            {
                children.entry(parent).or_default().push(task);
            } else if let Some(group) = task
                .work_item_id
                .as_deref()
                .and_then(|id| grouped.get_mut(id))
            {
                group.push(task);
            } else {
                ungrouped.push(task);
            }
        }
        let mut groups: Vec<_> = self
            .work_items
            .iter()
            .map(|item| {
                let tasks = grouped.remove(item.id.as_str()).unwrap_or_default();
                Group::from_tasks(Some(item), tasks, &mut children)
            })
            .collect();
        if !ungrouped.is_empty() {
            groups.push(Group::from_tasks(None, ungrouped, &mut children));
        }
        groups
    }

    pub fn work_item_title(&self, task: &WorkTask) -> Option<&str> {
        let id = task.work_item_id.as_deref()?;
        self.work_items
            .iter()
            .find(|item| item.id == id)
            .map(|item| item.title.as_str())
    }

    pub fn subtask_progress(&self, task_id: &str) -> Option<Progress> {
        let mut done = 0;
        let mut total = 0;
        for task in &self.tasks {
            if task.parent_task_id.as_deref() == Some(task_id) {
                total += 1;
                if task.state == State::Done {
                    done += 1;
                }
            }
        }
        (total > 0).then_some(Progress { done, total })
    }

    fn root_tasks(&self) -> Vec<&WorkTask> {
        let roots: HashSet<&str> = self
            .tasks
            .iter()
            .filter(|task| task.parent_task_id.is_none())
            .map(|task| task.id.as_str())
            .collect();
        self.tasks
            .iter()
            .filter(|task| {
                task.parent_task_id
                    .as_deref()
                    .is_none_or(|parent| !roots.contains(parent))
            })
            .collect()
    }

    pub fn open_count(&self) -> usize {
        self.root_tasks()
            .into_iter()
            .filter(|task| task.state != State::Done)
            .count()
    }

    pub fn status_groups(&self) -> Vec<StatusGroup<'_>> {
        let roots = self.root_tasks();
        StatusBucket::ALL
            .into_iter()
            .map(|bucket| {
                let mut tasks: Vec<&WorkTask> = roots
                    .iter()
                    .copied()
                    .filter(|task| task.status_bucket() == bucket)
                    .collect();
                tasks.sort_by_key(|task| task.urgency_rank());
                StatusGroup { bucket, tasks }
            })
            .filter(|group| !group.tasks.is_empty())
            .collect()
    }

    pub fn active_pulse(&self) -> Vec<&WorkTask> {
        let mut active: Vec<&WorkTask> = self
            .root_tasks()
            .into_iter()
            // Put off on purpose: back in the brief once it comes due.
            .filter(|task| !matches!(task.state, State::Done | State::Postponed))
            .collect();
        active.sort_by_key(|task| task.urgency_rank());
        active
    }

    pub fn dependencies<'a>(&'a self, task_id: &str) -> Vec<&'a WorkTask> {
        // Anyone already waiting for this task (directly or through another
        // postponement) would leave both sides waiting forever.
        let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
        for task in &self.tasks {
            if let (State::Postponed, Some(TaskDue::AfterTask { task_id })) =
                (task.state, &task.due)
            {
                dependents.entry(task_id).or_default().push(&task.id);
            }
        }
        let mut excluded = HashSet::from([task_id]);
        let mut pending = vec![task_id];
        while let Some(id) = pending.pop() {
            for next in dependents.remove(id).into_iter().flatten() {
                if excluded.insert(next) {
                    pending.push(next);
                }
            }
        }
        self.tasks
            .iter()
            .filter(|task| task.state != State::Done && !excluded.contains(task.id.as_str()))
            .collect()
    }
}

fn rows<T: serde::de::DeserializeOwned>(value: &Value, id: impl Fn(&T) -> &String) -> Vec<T> {
    let mut seen = HashSet::new();
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| serde_json::from_value::<T>(row.clone()).ok())
        .filter(|row| !id(row).trim().is_empty() && seen.insert(id(row).clone()))
        .collect()
}

pub fn decision_ask<'a>(thread: &'a ThreadSummary, task_id: &str) -> Option<(&'a OpenAsk, u64)> {
    let seq = thread.asks_seq?;
    let ask = thread
        .asks
        .as_ref()?
        .iter()
        .find(|ask| ask.task_id.as_deref() == Some(task_id))?;
    Some((ask, seq))
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PostponeUntil {
    Tomorrow,
    Date { date: String },
    AfterTask { task_id: String },
}

#[derive(Clone, Debug)]
pub enum TaskAction {
    Answer {
        answer: String,
        asks_seq: Option<u64>,
    },
    Postpone {
        due: PostponeUntil,
        asks_seq: Option<u64>,
    },
    Done,
    Close,
    Reopen,
}

impl TaskAction {
    pub fn request(&self, project: &str, task: &str) -> (&'static str, Value) {
        let mut params = json!({"projectId": project, "taskId": task});
        let (method, seq) = match self {
            Self::Answer { answer, asks_seq } => {
                params["answer"] = json!(answer);
                ("coordinators.answerDecision", *asks_seq)
            }
            Self::Postpone { due, asks_seq } => {
                params["due"] = json!(due);
                ("coordinators.postponeTask", *asks_seq)
            }
            Self::Done => ("coordinators.markTaskDone", None),
            Self::Close => ("coordinators.closeTask", None),
            Self::Reopen => ("coordinators.reopenTask", None),
        };
        if let Some(seq) = seq {
            params["asksSeq"] = json!(seq);
        }
        (method, params)
    }
}

/// The date picker sends a local calendar date, which the runner schedules for 9 a.m.
pub fn can_postpone_to_date(date: NaiveDate, now: NaiveDateTime) -> bool {
    date > now.date() || (date == now.date() && now.hour() < 9)
}

pub fn collapse_request(project: &str, item: &str, collapsed: bool) -> (&'static str, Value) {
    (
        "coordinators.updateWorkItem",
        json!({"projectId": project, "workItemId": item, "collapsed": collapsed}),
    )
}

pub fn add_request(project: &str, text: &str) -> (&'static str, Value) {
    (
        "coordinators.addToCoordinator",
        json!({"projectId": project, "text": text}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordinators::Coordinator;
    use crate::inbox::ThreadSummary;
    use serde_json::json;

    #[test]
    fn postpone_date_must_have_a_future_local_nine_am() {
        let yesterday = chrono::NaiveDate::from_ymd_opt(2026, 11, 26).unwrap();
        let today = yesterday.succ_opt().unwrap();
        let tomorrow = today.succ_opt().unwrap();
        let before = today.and_hms_opt(8, 59, 59).unwrap();
        let at = today.and_hms_opt(9, 0, 0).unwrap();
        let after = today.and_hms_opt(16, 0, 0).unwrap();
        assert!(!can_postpone_to_date(yesterday, before));
        assert!(can_postpone_to_date(today, before));
        assert!(!can_postpone_to_date(today, at));
        assert!(!can_postpone_to_date(today, after));
        assert!(can_postpone_to_date(tomorrow, after));
    }

    fn board() -> TaskBoard {
        TaskBoard::decode(&json!({
            "workItems": [{"id":"group","title":"Rollout","collapsed":true,"progress":{"done":1,"total":2}}],
            "tasks": [
                {"id":"decision","title":"Pick a date","owner":{"kind":"user"},"state":"todo","kind":"decision","workItemId":"group",
                 "needsYou":true,"decision":{"options":[{"label":"Friday","does":"One extra day"}],"recommendation":"Friday"},
                 "source":{"threadId":"t","runId":"r","seq":32},"due":{"type":"at","at":"2026-12-04T01:00:00Z","preset":"date"},
                 "now":"Both dates work.","doneWhen":"A date is chosen.","extra":true},
                {"id":"child","title":"Check the calendar","owner":{"kind":"agent"},"state":"working","kind":"action","parentTaskId":"decision"},
                {"id":"done","title":"Confirm venue","owner":{"kind":"agent"},"state":"done","kind":"action","workItemId":"group","canReopen":true},
                {"id":"user","title":"Ask for flights","owner":{"kind":"user"},"state":"waiting","kind":"action"},
                {"id":"person","title":"Hear from Alex","owner":{"kind":"person","name":"Alex"},"state":"waiting","kind":"action"},
                {"id":"later","title":"Send agenda","owner":{"kind":"user"},"state":"postponed","kind":"action","due":{"type":"after_task","taskId":"decision"}},
                {"id":"close","title":"Read the notes","owner":{"kind":"agent"},"state":"ready_to_close","kind":"action"},
                {"id":"queued","title":"Make copies","owner":{"kind":"agent"},"state":"todo","kind":"action"},
                {"id":"orphan","title":"Old child","owner":{"kind":"agent"},"state":"done","kind":"action","parentTaskId":"unknown","workItemId":"missing"},
                {"id":"bad","title":"Future kind","owner":{"kind":"agent"},"state":"future","kind":"action"}
            ]
        })).unwrap()
    }

    #[test]
    fn board_decoding_is_optional_and_keeps_valid_rows() {
        let mut row = json!({"projectId":"p","threadId":"t","state":"active"});
        assert!(Coordinator::decode(&row).unwrap().task_board.is_none());
        row["taskBoard"] = json!({"workItems":[]});
        assert!(Coordinator::decode(&row)
            .unwrap()
            .task_board
            .unwrap()
            .tasks
            .is_empty());
        let board = board();
        assert_eq!(board.tasks.len(), 9);
        let task = board.task("decision").unwrap();
        assert!(task.needs_you);
        assert_eq!(task.now.as_deref(), Some("Both dates work."));
        assert_eq!(task.done_when.as_deref(), Some("A date is chosen."));
        assert_eq!(task.source.as_ref().unwrap().seq, Some(32));
        assert_eq!(
            task.decision.as_ref().unwrap().recommendation.as_deref(),
            Some("Friday")
        );
        assert!(matches!(task.due, Some(TaskDue::At { .. })));
    }

    #[test]
    fn groups_keep_order_nest_children_and_count_only_roots() {
        let board = board();
        let groups = board.groups();
        let group = &groups[0];
        assert!(group.item.unwrap().collapsed);
        assert_eq!(
            group.item.unwrap().progress.unwrap(),
            Progress { done: 1, total: 2 }
        );
        assert_eq!(group.progress(), Progress { done: 1, total: 2 });
        assert_eq!(
            group
                .roots
                .iter()
                .map(|row| row.task.id.as_str())
                .collect::<Vec<_>>(),
            ["decision", "done"]
        );
        assert_eq!(group.roots[0].children[0].id, "child");
        assert!(groups[1].item.is_none());
        assert!(groups[1].roots.iter().any(|row| row.task.id == "orphan"));
    }

    #[test]
    fn marks_have_one_meaning_and_keep_legend_order() {
        let board = board();
        assert_eq!(Mark::ALL.map(Mark::glyph), ["◆", "◌", "👤", "⏸", "✓"]);
        for (id, mark) in [
            ("decision", Mark::Decision),
            ("child", Mark::Agent),
            ("user", Mark::Person),
            ("person", Mark::Person),
            ("later", Mark::Postponed),
            ("done", Mark::Done),
        ] {
            assert_eq!(board.task(id).unwrap().mark(), mark);
        }
    }

    #[test]
    fn highlights_only_show_current_work_in_one_section() {
        let board = board();
        for (section, expected) in [
            (Highlight::NeedsYou, &["decision", "user"][..]),
            (Highlight::InFlight, &["child", "person", "queued"][..]),
            (Highlight::ReadyToClose, &["close"][..]),
        ] {
            let ids = board
                .tasks
                .iter()
                .filter(|task| task.highlight() == Some(section))
                .map(|task| task.id.as_str())
                .collect::<Vec<_>>();
            assert_eq!(ids, expected);
        }
    }

    #[test]
    fn card_matching_never_guesses_from_title_and_keeps_revision() {
        let thread: ThreadSummary = serde_json::from_value(json!({
            "id":"t","asksSeq":42,"asks":[
                {"action":"Pick a date","options":["Old answer"]},
                {"action":"Pick a date","taskId":"decision","options":["Friday"],"suggested":0}
            ]
        }))
        .unwrap();
        let (ask, seq) = decision_ask(&thread, "decision").unwrap();
        assert_eq!(ask.suggested, Some(0));
        assert_eq!(seq, 42);
        assert!(decision_ask(&thread, "another").is_none());
    }

    #[test]
    fn rpc_payloads_keep_a_card_revision_and_encode_every_postpone_preset() {
        let (method, value) = TaskAction::Answer {
            answer: "Friday".into(),
            asks_seq: Some(42),
        }
        .request("p", "t");
        assert_eq!(method, "coordinators.answerDecision");
        assert_eq!(
            value,
            json!({"projectId":"p","taskId":"t","answer":"Friday","asksSeq":42})
        );
        for (due, wire) in [
            (PostponeUntil::Tomorrow, json!({"type":"tomorrow"})),
            (
                PostponeUntil::Date {
                    date: "2026-12-04".into(),
                },
                json!({"type":"date","date":"2026-12-04"}),
            ),
            (
                PostponeUntil::AfterTask {
                    task_id: "other".into(),
                },
                json!({"type":"after_task","taskId":"other"}),
            ),
        ] {
            let (method, value) = TaskAction::Postpone {
                due,
                asks_seq: Some(42),
            }
            .request("p", "t");
            assert_eq!(method, "coordinators.postponeTask");
            assert_eq!(
                value,
                json!({"projectId":"p","taskId":"t","due":wire,"asksSeq":42})
            );
        }
        let (_, value) = TaskAction::Answer {
            answer: "Friday".into(),
            asks_seq: None,
        }
        .request("p", "t");
        assert!(value.get("asksSeq").is_none());
        for (action, method) in [
            (TaskAction::Done, "coordinators.markTaskDone"),
            (TaskAction::Close, "coordinators.closeTask"),
            (TaskAction::Reopen, "coordinators.reopenTask"),
        ] {
            assert_eq!(
                action.request("p", "t"),
                (method, json!({"projectId":"p","taskId":"t"}))
            );
        }
        assert_eq!(
            collapse_request("p", "w", true),
            (
                "coordinators.updateWorkItem",
                json!({"projectId":"p","workItemId":"w","collapsed":true})
            )
        );
        assert_eq!(
            add_request("p", "Check prices"),
            (
                "coordinators.addToCoordinator",
                json!({"projectId":"p","text":"Check prices"})
            )
        );
    }

    #[test]
    fn status_groups_order_by_urgency_and_count_subtasks() {
        let board = board();
        let groups = board.status_groups();
        let summary: Vec<(StatusBucket, Vec<&str>)> = groups
            .into_iter()
            .map(|g| {
                (
                    g.bucket,
                    g.tasks.into_iter().map(|t| t.id.as_str()).collect(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (StatusBucket::NeedsYou, vec!["decision", "user"]),
                (StatusBucket::InProgress, vec!["close", "queued"]),
                (StatusBucket::Waiting, vec!["person", "later"]),
                (StatusBucket::Done, vec!["done", "orphan"]),
            ]
        );
        assert_eq!(
            board
                .active_pulse()
                .into_iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            vec!["decision", "user", "close", "queued", "person"]
        );
        assert_eq!(board.open_count(), 6);
        assert_eq!(
            board.subtask_progress("decision"),
            Some(Progress { done: 0, total: 1 })
        );
        assert_eq!(board.subtask_progress("done"), None);
        assert_eq!(
            board.work_item_title(board.task("decision").unwrap()),
            Some("Rollout")
        );
    }
}
