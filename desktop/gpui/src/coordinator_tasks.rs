// Coordinator task board: a calm, read-only Editorial Living Brief pulse in
// Highlights and a full-width Linear-style status-grouped Tasks view with a
// focused slide-in detail sheet. Pending controls are keyed by project and
// target so duplicate clicks are ignored while a request is in flight.
use crate::app::Threadbear;
use crate::call;
use crate::coordinators::Tab;
use crate::icons;
use crate::rows::cards;
use crate::spinner::Spinner;
use crate::style::{self, px};
use crate::tips::Tip as _;
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::date_picker::{DatePicker, DatePickerEvent, DatePickerState};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use threadbear_core::chrono::{DateTime, Local, NaiveDate};
use threadbear_core::coordinators::tasks::{
    self, Group, Highlight, Kind, Owner, PostponeUntil, State, StatusBucket, TaskAction, TaskBoard,
    TaskDue, WorkTask,
};
use threadbear_core::coordinators::Coordinator;
use threadbear_core::inbox::OpenAsk;

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum TaskFilter {
    #[default]
    All,
    NeedsYou,
    InProgress,
    Waiting,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum TaskGrouping {
    #[default]
    Status,
    WorkItem,
}

#[derive(Default)]
pub(crate) struct BoardUi {
    selected: Option<String>,
    filter: TaskFilter,
    grouping: TaskGrouping,
    done_open: bool,
    add_open: bool,
    list_scroll: ScrollHandle,
    detail_scroll: ScrollHandle,
    add: Option<AddInput>,
    added: bool,
    undo: Option<String>,
    picked_choice: HashMap<String, String>,
    editor: Option<DecisionEditor>,
    pending: HashSet<Target>,
}

struct AddInput {
    input: Entity<InputState>,
    _enter: Subscription,
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum Target {
    Task(String),
    WorkItem(String),
    Add,
}

struct DecisionEditor {
    task: String,
    asks_seq: Option<u64>,
    mode: EditMode,
}

enum EditMode {
    Postpone,
    Date {
        picker: Entity<DatePickerState>,
        _change: Subscription,
    },
    AfterTask,
    Reply {
        input: Entity<InputState>,
        _enter: Subscription,
    },
}

#[derive(Clone, Copy)]
enum EditorChoice {
    Postpone,
    Date,
    AfterTask,
    Reply,
}

struct DecisionEditorTarget {
    task: String,
    asks_seq: Option<u64>,
}

impl Threadbear {
    pub(crate) fn task_details_bounds(&self, project: &str) -> Option<[f32; 4]> {
        if self.coordinators.tab != Tab::Tasks {
            return None;
        }
        let ui = self.coordinators.task_boards.get(project)?;
        ui.selected.as_ref()?;
        let bounds = ui.detail_scroll.bounds();
        Some([
            bounds.left().into(),
            bounds.top().into(),
            bounds.right().into(),
            bounds.bottom().into(),
        ])
    }

    pub(crate) fn task_request_sending(&self, project: &str) -> bool {
        self.coordinators
            .task_boards
            .get(project)
            .is_some_and(|ui| ui.pending.contains(&Target::Add))
    }

    pub(crate) fn open_coordinator_tab(&mut self, tab: Tab, cx: &mut Context<Self>) {
        let changed = self.coordinators.tab != tab;
        self.coordinators.tab = tab;
        self.close_subagent(cx);
        if let Some(project) = self
            .projects
            .open
            .as_deref()
            .filter(|_| changed && tab == Tab::Tasks)
        {
            self.refresh_task_board(project, cx);
        }
        cx.notify();
    }

    /// Jumps from an ordinary thread's Highlights brief straight into a
    /// project's coordinator Tasks tab, optionally selecting a specific task.
    pub(crate) fn open_project_coordinator_tasks(
        &mut self,
        project: &str,
        task: Option<&str>,
        cx: &mut Context<Self>,
    ) {
        self.open_project_page(project, cx);
        if let Some(task_id) = task {
            self.select_board_task(project, task_id, cx);
        }
        self.open_coordinator_tab(Tab::Tasks, cx);
    }

    /// Jumps from an ordinary thread's Highlights brief into a project's
    /// coordinator home on its Conversation tab.
    pub(crate) fn open_project_coordinator_home(&mut self, project: &str, cx: &mut Context<Self>) {
        self.open_project_page(project, cx);
        self.open_coordinator_tab(Tab::Conversation, cx);
    }

    pub(crate) fn refresh_task_board(&self, project: &str, cx: &mut Context<Self>) {
        let Some(before) = self.coordinator_for_project(project).cloned() else {
            return;
        };
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let result = call(
                client,
                "coordinators.get",
                json!({"projectId":before.project_id}),
            )
            .await;
            if let Ok(value) = result {
                this.update(cx, |this, cx| {
                    this.apply_task_board(&before, &value, cx);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn apply_task_board(&mut self, before: &Coordinator, value: &Value, cx: &mut Context<Self>) {
        let Some(current) = self.coordinator_for_project(&before.project_id) else {
            return;
        };
        let row = &value["coordinator"];
        // A reply can arrive after an update for this project. Prefer the
        // broadcast when both report the same millisecond and disagree.
        if row["projectId"].as_str() == Some(&before.project_id)
            && row["threadId"].as_str() == Some(&current.thread_id)
            && (current == before
                || row["updatedAt"]
                    .as_str()
                    .is_some_and(|at| at > current.updated_at.as_str()))
        {
            self.replace_coordinator(row, cx);
        }
    }

    fn change_task_board(
        &mut self,
        project: &str,
        target: Target,
        (method, params): (&'static str, Value),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.can_act() {
            return;
        }
        let Some(before) = self.coordinator_for_project(project).cloned() else {
            return;
        };
        let ui = self
            .coordinators
            .task_boards
            .entry(project.to_owned())
            .or_default();
        if !ui.pending.insert(target.clone()) {
            return;
        }
        if target == Target::Add {
            ui.added = false;
        }
        let going = crate::call_action(self.client.clone(), method, params);
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = going.await;
            this.update_in(cx, |this, window, cx| {
                if let Ok(value) = &result {
                    this.apply_task_board(&before, value, cx);
                }
                if let Some(ui) = this.coordinators.task_boards.get_mut(&before.project_id) {
                    ui.pending.remove(&target);
                    if result.is_ok() {
                        match &target {
                            Target::Add => {
                                if let Some(add) = &ui.add {
                                    add.input.update(cx, |s, cx| s.set_value("", window, cx));
                                }
                                ui.added = true;
                            }
                            Target::Task(id) => {
                                if ui.editor.as_ref().is_some_and(|e| &e.task == id) {
                                    ui.editor = None;
                                }
                                ui.picked_choice.remove(id);
                                if method == "coordinators.closeTask" {
                                    ui.undo = Some(id.clone());
                                } else if ui.undo.as_ref() == Some(id) {
                                    ui.undo = None;
                                }
                            }
                            Target::WorkItem(_) => {}
                        }
                    }
                }
                if let Err(error) = result {
                    this.show_error(error.message, cx);
                    this.refresh_task_board(&before.project_id, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn task_action(
        &mut self,
        project: &str,
        task: &str,
        action: TaskAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.change_task_board(
            project,
            Target::Task(task.to_owned()),
            action.request(project, task),
            window,
            cx,
        );
    }

    fn send_task_request(&mut self, project: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(add) = self
            .coordinators
            .task_boards
            .get(project)
            .and_then(|ui| ui.add.as_ref())
        else {
            return;
        };
        let text = add.input.read(cx).value();
        let text = text.trim();
        if !text.is_empty() {
            self.change_task_board(
                project,
                Target::Add,
                tasks::add_request(project, text),
                window,
                cx,
            );
        }
    }

    fn select_board_task(&mut self, project: &str, task: &str, cx: &mut Context<Self>) {
        let ui = self
            .coordinators
            .task_boards
            .entry(project.to_owned())
            .or_default();
        if ui.selected.as_deref() != Some(task) {
            ui.selected = Some(task.to_owned());
            ui.detail_scroll.set_offset(Point::default());
        }
        cx.notify();
    }

    fn close_board_task(&mut self, project: &str, cx: &mut Context<Self>) {
        if let Some(ui) = self.coordinators.task_boards.get_mut(project) {
            ui.selected = None;
            ui.editor = None;
        }
        cx.notify();
    }

    fn set_task_filter(&mut self, project: &str, filter: TaskFilter, cx: &mut Context<Self>) {
        let ui = self
            .coordinators
            .task_boards
            .entry(project.to_owned())
            .or_default();
        ui.filter = filter;
        cx.notify();
    }

    fn toggle_task_grouping(&mut self, project: &str, cx: &mut Context<Self>) {
        let ui = self
            .coordinators
            .task_boards
            .entry(project.to_owned())
            .or_default();
        ui.grouping = match ui.grouping {
            TaskGrouping::Status => TaskGrouping::WorkItem,
            TaskGrouping::WorkItem => TaskGrouping::Status,
        };
        cx.notify();
    }

    fn toggle_done_section(&mut self, project: &str, cx: &mut Context<Self>) {
        let ui = self
            .coordinators
            .task_boards
            .entry(project.to_owned())
            .or_default();
        ui.done_open = !ui.done_open;
        cx.notify();
    }

    fn toggle_add_task(&mut self, project: &str, window: &mut Window, cx: &mut Context<Self>) {
        let ui = self
            .coordinators
            .task_boards
            .entry(project.to_owned())
            .or_default();
        ui.add_open = !ui.add_open;
        if ui.add_open {
            ui.added = false;
            let input = ui.add.as_ref().map(|a| a.input.clone());
            if let Some(input) = input {
                window.focus(&input.read(cx).focus_handle(cx), cx);
                crate::web_panels::keyboard_to_app(window);
            }
        }
        cx.notify();
    }

    fn pick_decision_choice(
        &mut self,
        project: &str,
        task: &str,
        choice: String,
        cx: &mut Context<Self>,
    ) {
        let ui = self
            .coordinators
            .task_boards
            .entry(project.to_owned())
            .or_default();
        ui.picked_choice.insert(task.to_owned(), choice);
        cx.notify();
    }

    fn visible_task_ids(&self, project: &str, board: &TaskBoard) -> Vec<String> {
        let ui = self.coordinators.task_boards.get(project);
        let filter = ui.map_or(TaskFilter::All, |u| u.filter);
        let grouping = ui.map_or(TaskGrouping::Status, |u| u.grouping);
        let done_open = ui.is_some_and(|u| u.done_open);
        match grouping {
            TaskGrouping::Status => board
                .status_groups()
                .into_iter()
                .filter(|group| match filter {
                    TaskFilter::All => group.bucket != StatusBucket::Done || done_open,
                    TaskFilter::NeedsYou => group.bucket == StatusBucket::NeedsYou,
                    TaskFilter::InProgress => group.bucket == StatusBucket::InProgress,
                    TaskFilter::Waiting => group.bucket == StatusBucket::Waiting,
                })
                .flat_map(|group| group.tasks.into_iter().map(|t| t.id.clone()))
                .collect(),
            TaskGrouping::WorkItem => board
                .groups()
                .into_iter()
                .filter(|g| g.item.is_none_or(|item| !item.collapsed))
                .flat_map(|g| {
                    g.roots.into_iter().flat_map(|row| {
                        std::iter::once(row.task)
                            .chain(row.children)
                            .filter(move |t| matches_filter(t, filter))
                            .map(|t| t.id.clone())
                    })
                })
                .collect(),
        }
    }

    /// Quiet, read-only "Active now" pulse inside the Editorial Living Brief.
    /// Zero action buttons or forms: clicking any row opens that task in Tasks.
    pub(crate) fn render_task_highlights(
        &self,
        coordinator: &Coordinator,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(board) = coordinator.task_board.as_deref() else {
            return Empty.into_any_element();
        };
        let project = &coordinator.project_id;
        let pulse = board.active_pulse();
        let open_total = board.open_count();

        let all_label = if open_total > 0 {
            format!("All {open_total} tasks →")
        } else {
            "All tasks →".to_owned()
        };
        let header = h_flex()
            .w_full()
            .items_center()
            .gap(px(6.))
            .child(
                div()
                    .text_size(px(12.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(style::secondary_text(cx))
                    .child("Active now"),
            )
            .child(div().flex_1())
            .child(
                crate::highlights::tipped(
                    div()
                        .id("coordinator-brief-all-tasks")
                        .role(Role::Button)
                        .flex_none()
                        .cursor_pointer()
                        .px(px(5.))
                        .py(px(1.5))
                        .rounded(px(4.))
                        .text_size(px(11.5))
                        .text_color(style::secondary_text(cx))
                        .hover(|s| {
                            s.text_color(cx.theme().foreground)
                                .bg(style::hover_fill(cx))
                        })
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                            this.open_coordinator_tab(Tab::Tasks, cx);
                        })),
                    "Open all tasks",
                )
                .child(all_label),
            );

        let section = v_flex()
            .id("coordinator-task-highlights")
            .w_full()
            .gap(px(6.))
            .child(header);

        if pulse.is_empty() {
            return section
                .child(
                    div()
                        .text_size(px(12.5))
                        .text_color(style::faint_text(cx))
                        .child("No open tasks right now."),
                )
                .into_any_element();
        }

        let mut list = v_flex().w_full();
        let shown: Vec<&WorkTask> = pulse.into_iter().take(7).collect();
        let last_index = shown.len().saturating_sub(1);
        for (index, task) in shown.into_iter().enumerate() {
            let project = project.clone();
            let task_id = task.id.clone();
            let (tag_text, tag_color) = pulse_tag(task, cx);
            let note = task
                .now
                .as_deref()
                .map(|text| truncate_text(text.trim(), 96))
                .filter(|text| !text.is_empty());

            let row = crate::highlights::tipped(
                h_flex()
                    .id(id("highlight-task-title", &task.id))
                    .role(Role::Button)
                    .w_full()
                    .items_start()
                    .gap(px(9.))
                    .px(px(6.))
                    .py(px(6.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(|s| s.bg(style::hover_fill(cx)))
                    .when(index < last_index, |el| {
                        el.border_b_1()
                            .border_color(style::primary_opacity(cx, 0.055))
                    })
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.select_board_task(&project, &task_id, cx);
                        this.open_coordinator_tab(Tab::Tasks, cx);
                    })),
                format!("Open {} in Tasks", task.title),
            )
            .child(
                div()
                    .flex_none()
                    .mt(px(5.5))
                    .size(px(6.))
                    .rounded_full()
                    .bg(status_dot_color(task, cx)),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(1.5))
                    .child(
                        div()
                            .text_size(px(12.5))
                            .line_height(px(17.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(cx.theme().foreground)
                            .child(task.title.clone()),
                    )
                    .when_some(note, |col, note| {
                        col.child(
                            div()
                                .text_size(px(11.5))
                                .line_height(px(16.))
                                .text_color(style::secondary_text(cx))
                                .child(note),
                        )
                    }),
            )
            .child(
                div()
                    .flex_none()
                    .pt(px(1.))
                    .text_size(px(11.))
                    .text_color(tag_color)
                    .child(tag_text),
            );
            list = list.child(row);
        }

        section.child(list).into_any_element()
    }

    pub(crate) fn render_coordinator_tasks(
        &mut self,
        coordinator: &Coordinator,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(board) = coordinator.task_board.as_deref() else {
            return div()
                .p(px(24.))
                .text_color(style::secondary_text(cx))
                .child("Tasks are available when the runner supports the task board.")
                .into_any_element();
        };
        let project = &coordinator.project_id;
        let ui = self
            .coordinators
            .task_boards
            .entry(project.clone())
            .or_default();
        let add_state =
            ui.add.get_or_insert_with(|| {
                let input = cx.new(|cx| {
                    InputState::new(window, cx).placeholder("Add a request for the coordinator")
                });
                let project = project.clone();
                let enter =
                    cx.subscribe_in(&input, window, move |this, input, event, window, cx| {
                        match event {
                            InputEvent::PressEnter { .. } => {
                                this.send_task_request(&project, window, cx);
                            }
                            InputEvent::Change => {
                                if let Some(ui) = this.coordinators.task_boards.get_mut(&project) {
                                    if !input.read(cx).value().trim().is_empty() {
                                        ui.added = false;
                                    }
                                }
                                cx.notify();
                            }
                            _ => {}
                        }
                    });
                AddInput {
                    input,
                    _enter: enter,
                }
            });
        let input = add_state.input.clone();

        let visible_ids = self.visible_task_ids(project, board);
        let ui = &self.coordinators.task_boards[project];
        let filter = ui.filter;
        let grouping = ui.grouping;
        let done_open = ui.done_open;
        let add_open = ui.add_open;
        let added = ui.added;
        let busy_add = ui.pending.contains(&Target::Add);
        let selected_task = ui.selected.as_deref().and_then(|id| board.task(id));

        let toolbar = self.render_tasks_toolbar(project, board, filter, grouping, add_open, cx);
        let add_bar = (add_open || added || busy_add)
            .then(|| self.render_add_task_bar(project, &input, busy_add, added, cx));

        let list_content = match grouping {
            TaskGrouping::Status => {
                self.render_status_task_list(project, board, filter, done_open, selected_task, cx)
            }
            TaskGrouping::WorkItem => {
                let groups = board.groups();
                self.render_work_item_task_list(project, board, &groups, filter, selected_task, cx)
            }
        };

        let sheet = selected_task
            .map(|task| self.render_task_detail_sheet(coordinator, board, task, &visible_ids, cx));

        let project_keys = project.clone();
        let visible_keys = visible_ids;
        let stage = div()
            .id("coordinator-tasks-stage")
            .relative()
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_hidden()
            .child(
                div()
                    .id("coordinator-task-list")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.coordinators.task_boards[project].list_scroll)
                    .child(list_content),
            )
            .children(sheet);

        v_flex()
            .size_full()
            .on_key_down(cx.listener(move |this, ev: &KeyDownEvent, _, cx| {
                let Some(ui) = this.coordinators.task_boards.get(&project_keys) else {
                    return;
                };
                if ui.editor.is_some() || ui.add_open {
                    return;
                }
                let Some(current) = ui.selected.as_deref() else {
                    return;
                };
                match ev.keystroke.key.as_str() {
                    "escape" => {
                        this.close_board_task(&project_keys, cx);
                        cx.stop_propagation();
                    }
                    "up" | "down" => {
                        if let Some(pos) = visible_keys.iter().position(|id| id == current) {
                            let next = if ev.keystroke.key == "up" {
                                pos.checked_sub(1)
                            } else {
                                (pos + 1 < visible_keys.len()).then_some(pos + 1)
                            };
                            if let Some(target) = next.and_then(|i| visible_keys.get(i)) {
                                this.select_board_task(&project_keys, target, cx);
                                cx.stop_propagation();
                            }
                        }
                    }
                    _ => {}
                }
            }))
            .child(toolbar)
            .children(add_bar)
            .child(stage)
            .into_any_element()
    }

    fn render_tasks_toolbar(
        &self,
        project: &str,
        board: &TaskBoard,
        active_filter: TaskFilter,
        grouping: TaskGrouping,
        add_open: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let status_groups = board.status_groups();
        let count_for = |bucket: StatusBucket| -> usize {
            status_groups
                .iter()
                .find(|g| g.bucket == bucket)
                .map_or(0, |g| g.tasks.len())
        };
        let needs_you = count_for(StatusBucket::NeedsYou);
        let in_progress = count_for(StatusBucket::InProgress);
        let waiting = count_for(StatusBucket::Waiting);
        let open_all = needs_you + in_progress + waiting;

        let mut bar = h_flex()
            .flex_none()
            .w_full()
            .min_h(px(42.))
            .px(px(18.))
            .py(px(6.))
            .gap(px(5.))
            .flex_wrap()
            .items_center()
            .border_b_1()
            .border_color(style::hairline(cx));

        for (filter, label, count, accent_num) in [
            (TaskFilter::All, "All", open_all, false),
            (TaskFilter::NeedsYou, "Needs you", needs_you, needs_you > 0),
            (TaskFilter::InProgress, "In progress", in_progress, false),
            (TaskFilter::Waiting, "Waiting", waiting, false),
        ] {
            let active = active_filter == filter;
            let project = project.to_owned();
            let tip = format!("Filter tasks: {label}");
            let pill = crate::highlights::tipped(
                h_flex()
                    .id(id("task-filter", label))
                    .role(Role::Button)
                    .h(px(24.))
                    .px(px(9.))
                    .gap(px(5.))
                    .items_center()
                    .rounded(px(6.))
                    .cursor_pointer()
                    .text_size(px(12.))
                    .text_color(if active {
                        cx.theme().foreground
                    } else {
                        style::secondary_text(cx)
                    })
                    .when(active, |s| {
                        s.bg(style::sidebar_selected(cx))
                            .font_weight(FontWeight::MEDIUM)
                    })
                    .when(!active, |s| s.hover(|s| s.bg(style::hover_fill(cx))))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.set_task_filter(&project, filter, cx);
                    })),
                tip,
            )
            .child(label)
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(if accent_num {
                        style::needs_you_text(cx)
                    } else {
                        style::faint_text(cx)
                    })
                    .child(count.to_string()),
            );
            bar = bar.child(pill);
        }

        let group_project = project.to_owned();
        let group_label = match grouping {
            TaskGrouping::Status => "Group: Status",
            TaskGrouping::WorkItem => "Group: Work item",
        };
        let group_btn = crate::highlights::tipped(
            h_flex()
                .id("coordinator-task-grouping")
                .role(Role::Button)
                .h(px(24.))
                .px(px(9.))
                .gap(px(4.))
                .items_center()
                .rounded(px(6.))
                .border_1()
                .border_color(style::hairline(cx))
                .bg(style::card_background(cx))
                .cursor_pointer()
                .text_size(px(11.5))
                .text_color(style::secondary_text(cx))
                .hover(|s| {
                    s.text_color(cx.theme().foreground)
                        .bg(style::hover_fill(cx))
                })
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.toggle_task_grouping(&group_project, cx);
                })),
            "Switch between grouping by status and by work item",
        )
        .child(group_label)
        .child(
            icons::symbol("chevron.down")
                .with_size(px(10.))
                .text_color(style::faint_text(cx)),
        );

        let add_project = project.to_owned();
        let add_btn = crate::highlights::tipped(
            h_flex()
                .id("coordinator-task-add-toggle")
                .role(Role::Button)
                .h(px(24.))
                .px(px(9.))
                .gap(px(4.))
                .items_center()
                .rounded(px(6.))
                .border_1()
                .border_color(if add_open {
                    style::accent(cx).opacity(0.45)
                } else {
                    style::card_border(cx)
                })
                .bg(if add_open {
                    style::accent(cx).opacity(0.12)
                } else {
                    style::card_background(cx)
                })
                .cursor_pointer()
                .text_size(px(11.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(cx.theme().foreground)
                .hover(|s| s.bg(style::hover_fill(cx)))
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    this.toggle_add_task(&add_project, window, cx);
                })),
            "Add a request for the coordinator",
        )
        .child(
            icons::symbol("plus")
                .with_size(px(11.))
                .text_color(style::secondary_text(cx)),
        )
        .child("Add task");

        bar.child(div().flex_1())
            .child(group_btn)
            .child(add_btn)
            .into_any_element()
    }

    fn render_add_task_bar(
        &self,
        project: &str,
        input: &Entity<InputState>,
        busy: bool,
        added: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let connected = self.can_act();
        let blank = input.read(cx).value().trim().is_empty();
        let send_project = project.to_owned();
        let close_project = project.to_owned();
        let enabled = !busy && connected && !blank;

        let mut add_pill = cards::pill(
            "coordinator-request-add",
            if busy { "Sending…" } else { "Add" },
            true,
            enabled,
            None,
            cx,
        )
        .h(px(26.))
        .min_w(px(56.))
        .px(px(12.))
        .rounded(px(13.))
        .text_size(px(12.));
        if enabled {
            add_pill = add_pill.on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                this.send_task_request(&send_project, window, cx);
            }));
        }

        v_flex()
            .flex_none()
            .w_full()
            .gap(px(5.))
            .px(px(18.))
            .py(px(8.))
            .border_b_1()
            .border_color(style::hairline(cx))
            .bg(style::primary_opacity(cx, 0.02))
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap(px(8.))
                    .children(busy.then(|| spinner(cx)))
                    .child(
                        div()
                            .id("coordinator-task-add-input")
                            .flex_1()
                            .min_w_0()
                            .tip("Add a request for the coordinator")
                            .child(Input::new(input).small().disabled(busy || !connected)),
                    )
                    .child(
                        add_pill
                            .test_support()
                            .tip("Send a request to the coordinator"),
                    )
                    .child(
                        crate::highlights::tipped(
                            div()
                                .id("coordinator-task-add-close")
                                .role(Role::Button)
                                .flex_none()
                                .cursor_pointer()
                                .p(px(4.))
                                .rounded(px(5.))
                                .hover(|s| s.bg(style::hover_fill(cx)))
                                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                                    this.toggle_add_task(&close_project, window, cx);
                                })),
                            "Hide add task box",
                        )
                        .child(
                            icons::symbol("xmark")
                                .with_size(px(12.))
                                .text_color(style::secondary_text(cx)),
                        ),
                    ),
            )
            .when(added, |col| {
                col.child(
                    div()
                        .text_size(px(11.5))
                        .text_color(style::added_text(cx))
                        .child("Request sent to the coordinator"),
                )
            })
            .into_any_element()
    }

    fn render_status_task_list(
        &self,
        project: &str,
        board: &TaskBoard,
        filter: TaskFilter,
        done_open: bool,
        selected: Option<&WorkTask>,
        cx: &mut Context<Self>,
    ) -> Div {
        let groups = board.status_groups();
        let mut list = v_flex().w_full().pb(px(28.));
        let mut any = false;
        for group in groups {
            let include = match filter {
                TaskFilter::All => true,
                TaskFilter::NeedsYou => group.bucket == StatusBucket::NeedsYou,
                TaskFilter::InProgress => group.bucket == StatusBucket::InProgress,
                TaskFilter::Waiting => group.bucket == StatusBucket::Waiting,
            };
            if !include {
                continue;
            }
            any = true;
            if group.bucket == StatusBucket::Done {
                let done_project = project.to_owned();
                let count = group.tasks.len();
                let header = crate::highlights::tipped(
                    h_flex()
                        .id("coordinator-done-toggle")
                        .role(Role::Button)
                        .w_full()
                        .items_center()
                        .gap(px(7.))
                        .px(px(18.))
                        .py(px(8.))
                        .border_t_1()
                        .border_b_1()
                        .border_color(style::hairline(cx))
                        .bg(style::primary_opacity(cx, 0.015))
                        .cursor_pointer()
                        .hover(|s| s.bg(style::hover_fill(cx)))
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.toggle_done_section(&done_project, cx);
                        })),
                    if done_open {
                        "Hide completed tasks"
                    } else {
                        "Show completed tasks"
                    },
                )
                .child(
                    icons::symbol(if done_open {
                        "chevron.down"
                    } else {
                        "chevron.right"
                    })
                    .with_size(px(11.))
                    .text_color(style::faint_text(cx)),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(style::faint_text(cx))
                        .child("Done"),
                )
                .child(
                    div()
                        .text_size(px(11.5))
                        .text_color(style::faint_text(cx))
                        .child(format!("{count} completed")),
                );
                list = list.child(header);
                if done_open {
                    for task in group.tasks {
                        list = list.child(
                            self.linear_task_row(project, board, task, selected, true, false, cx),
                        );
                    }
                }
                continue;
            }

            let header = status_group_header(group.bucket, group.tasks.len(), cx);
            list = list.child(header);
            for task in group.tasks {
                list = list
                    .child(self.linear_task_row(project, board, task, selected, true, false, cx));
            }
        }
        if !any {
            list = list.child(
                div()
                    .px(px(18.))
                    .py(px(24.))
                    .text_size(px(13.))
                    .text_color(style::faint_text(cx))
                    .child(match filter {
                        TaskFilter::All => "No tasks yet.",
                        TaskFilter::NeedsYou => "Nothing needs you right now.",
                        TaskFilter::InProgress => "Nothing in progress right now.",
                        TaskFilter::Waiting => "Nothing waiting or postponed.",
                    }),
            );
        }
        list
    }

    fn render_work_item_task_list(
        &self,
        project: &str,
        board: &TaskBoard,
        groups: &[Group<'_>],
        filter: TaskFilter,
        selected: Option<&WorkTask>,
        cx: &mut Context<Self>,
    ) -> Div {
        let mut list = v_flex().w_full().pb(px(28.));
        let ui = &self.coordinators.task_boards[project];
        let connected = self.can_act();
        let mut any = false;
        for group in groups {
            let visible_roots: Vec<_> = group
                .roots
                .iter()
                .filter(|row| {
                    matches_filter(row.task, filter)
                        || row.children.iter().any(|c| matches_filter(c, filter))
                })
                .collect();
            if filter != TaskFilter::All && visible_roots.is_empty() {
                continue;
            }
            any = true;
            if let Some(item) = group.item {
                let progress = group.progress();
                let busy = ui.pending.contains(&Target::WorkItem(item.id.clone()));
                let collapsed = item.collapsed;
                let item_id = item.id.clone();
                let group_title = item.title.clone();
                let project_id = project.to_owned();
                let tip = format!(
                    "{} {}",
                    if collapsed { "Expand" } else { "Collapse" },
                    item.title
                );
                let header = h_flex()
                    .id(id("work-item", &item.id))
                    .role(Role::Button)
                    .w_full()
                    .items_center()
                    .gap(px(7.))
                    .px(px(18.))
                    .py(px(8.))
                    .border_t_1()
                    .border_b_1()
                    .border_color(style::hairline(cx))
                    .bg(style::primary_opacity(cx, 0.015))
                    .text_size(px(12.))
                    .text_color(style::secondary_text(cx))
                    .child(if busy {
                        spinner(cx)
                    } else {
                        icons::symbol(if collapsed {
                            "chevron.right"
                        } else {
                            "chevron.down"
                        })
                        .with_size(px(11.))
                        .text_color(style::faint_text(cx))
                        .into_any_element()
                    })
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(group_title),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_size(px(11.5))
                            .text_color(style::faint_text(cx))
                            .child(format!("{} of {} done", progress.done, progress.total)),
                    )
                    .when(!busy && connected, |el| {
                        el.cursor_pointer()
                            .hover(|s| s.bg(style::hover_fill(cx)))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let request =
                                    tasks::collapse_request(&project_id, &item_id, !collapsed);
                                this.change_task_board(
                                    &project_id,
                                    Target::WorkItem(item_id.clone()),
                                    request,
                                    window,
                                    cx,
                                );
                            }))
                    });
                list = list.child(crate::highlights::tipped(header, tip));
            } else if !board.work_items.is_empty() {
                list = list.child(
                    h_flex()
                        .w_full()
                        .px(px(18.))
                        .py(px(8.))
                        .border_t_1()
                        .border_b_1()
                        .border_color(style::hairline(cx))
                        .bg(style::primary_opacity(cx, 0.015))
                        .text_size(px(12.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(style::secondary_text(cx))
                        .child("Other"),
                );
            }
            if group.item.is_none_or(|item| !item.collapsed) {
                for row in visible_roots {
                    if matches_filter(row.task, filter) {
                        list =
                            list.child(self.linear_task_row(
                                project, board, row.task, selected, false, false, cx,
                            ));
                    }
                    for child in &row.children {
                        if matches_filter(child, filter) {
                            list =
                                list.child(self.linear_task_row(
                                    project, board, child, selected, false, true, cx,
                                ));
                        }
                    }
                }
            }
        }
        if !any {
            list = list.child(
                div()
                    .px(px(18.))
                    .py(px(24.))
                    .text_size(px(13.))
                    .text_color(style::faint_text(cx))
                    .child("No tasks match this filter."),
            );
        }
        list
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Row renderer takes display flags for work-item tags and subtask indentation"
    )]
    fn linear_task_row(
        &self,
        project: &str,
        board: &TaskBoard,
        task: &WorkTask,
        selected: Option<&WorkTask>,
        show_work_item_tag: bool,
        subtask: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let active = selected.is_some_and(|s| s.id == task.id);
        let label = task.title.clone();
        let task_id = task.id.clone();
        let project_id = project.to_owned();
        let subtask_prog = (!subtask)
            .then(|| board.subtask_progress(&task.id))
            .flatten();
        let work_item_tag = show_work_item_tag
            .then(|| board.work_item_title(task).map(str::to_owned))
            .flatten();
        let owner_text = row_owner_label(task);
        let (due_text, due_amber) = row_due_label(task);
        let done = task.state == State::Done;

        let tip = format!(
            "Show task {label}{}",
            task.due
                .as_ref()
                .map_or_else(String::new, |due| format!(" · {}", due_label(board, due)))
        );

        crate::highlights::tipped(
            h_flex()
                .id(id("task-row", &task.id))
                .role(Role::Button)
                .w_full()
                .h(px(38.))
                .gap(px(10.))
                .pl(px(if subtask { 38. } else { 18. }))
                .pr(px(18.))
                .items_center()
                .border_b_1()
                .border_color(style::primary_opacity(cx, 0.045))
                .cursor_pointer()
                .when(active, |el| el.bg(style::accent(cx).opacity(0.13)))
                .when(!active, |el| el.hover(|el| el.bg(style::hover_fill(cx))))
                .child(task_status_icon(task, 14., cx))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(13.))
                        .when(active, |el| {
                            el.font_weight(FontWeight::MEDIUM)
                                .text_color(cx.theme().foreground)
                        })
                        .when(!active && !done, |el| el.text_color(cx.theme().foreground))
                        .when(done && !active, |el| {
                            el.text_color(style::faint_text(cx)).line_through()
                        })
                        .child(label),
                )
                .when_some(subtask_prog, |row, prog| {
                    row.child(
                        div()
                            .flex_none()
                            .px(px(6.))
                            .py(px(1.))
                            .rounded(px(4.))
                            .bg(style::primary_opacity(cx, 0.05))
                            .text_size(px(11.))
                            .text_color(style::faint_text(cx))
                            .child(format!("{}/{}", prog.done, prog.total)),
                    )
                })
                .when_some(work_item_tag, |row, tag| {
                    row.child(
                        div()
                            .flex_none()
                            .px(px(7.))
                            .py(px(1.5))
                            .rounded(px(10.))
                            .border_1()
                            .border_color(style::hairline(cx))
                            .text_size(px(11.))
                            .text_color(style::secondary_text(cx))
                            .child(tag),
                    )
                })
                .child(
                    div()
                        .flex_none()
                        .w(px(60.))
                        .truncate()
                        .text_right()
                        .text_size(px(11.5))
                        .text_color(style::faint_text(cx))
                        .child(owner_text),
                )
                .child(
                    div()
                        .flex_none()
                        .w(px(58.))
                        .truncate()
                        .text_right()
                        .text_size(px(11.5))
                        .text_color(if due_amber {
                            style::needs_you_text(cx)
                        } else {
                            style::secondary_text(cx)
                        })
                        .child(due_text),
                ),
            tip,
        )
        .on_click(cx.listener(move |this, _, _, cx| {
            this.select_board_task(&project_id, &task_id, cx);
        }))
        .into_any_element()
    }

    fn render_task_detail_sheet(
        &self,
        coordinator: &Coordinator,
        board: &TaskBoard,
        task: &WorkTask,
        visible_ids: &[String],
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project = &coordinator.project_id;
        let pos = visible_ids.iter().position(|id| id == &task.id);
        let prev_id = pos
            .and_then(|i| i.checked_sub(1))
            .and_then(|i| visible_ids.get(i))
            .cloned();
        let next_id = pos.and_then(|i| visible_ids.get(i + 1)).cloned();

        let breadcrumb = task
            .parent_task_id
            .as_deref()
            .and_then(|id| board.task(id))
            .map(|parent| parent.title.clone())
            .or_else(|| board.work_item_title(task).map(str::to_owned));

        let close_project = project.clone();
        let close_x_project = project.clone();
        let prev_project = project.clone();
        let next_project = project.clone();

        let top_bar = h_flex()
            .flex_none()
            .w_full()
            .h(px(40.))
            .px(px(14.))
            .gap(px(6.))
            .items_center()
            .border_b_1()
            .border_color(style::hairline(cx))
            .child(
                crate::highlights::tipped(
                    h_flex()
                        .id("task-sheet-back")
                        .role(Role::Button)
                        .flex_none()
                        .items_center()
                        .gap(px(4.))
                        .px(px(5.))
                        .py(px(2.))
                        .rounded(px(5.))
                        .cursor_pointer()
                        .text_size(px(12.))
                        .text_color(style::secondary_text(cx))
                        .hover(|s| {
                            s.text_color(cx.theme().foreground)
                                .bg(style::hover_fill(cx))
                        })
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.close_board_task(&close_project, cx);
                        })),
                    "Close task details",
                )
                .child(
                    icons::symbol("arrow.left")
                        .with_size(px(12.))
                        .text_color(style::secondary_text(cx)),
                )
                .child("Tasks"),
            )
            .when_some(breadcrumb, |bar, crumb| {
                bar.child(
                    div()
                        .text_size(px(12.))
                        .text_color(style::faint_text(cx))
                        .child("/"),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(12.))
                        .text_color(style::secondary_text(cx))
                        .child(crumb),
                )
            })
            .when(
                task.parent_task_id.is_none() && board.work_item_title(task).is_none(),
                |bar| bar.child(div().flex_1()),
            )
            .when_some(pos, |bar, index| {
                bar.child(
                    div()
                        .flex_none()
                        .mr(px(4.))
                        .text_size(px(11.))
                        .text_color(style::faint_text(cx))
                        .child(format!("{} of {}", index + 1, visible_ids.len())),
                )
            })
            .child(stepper_button(
                "task-step-prev",
                "arrow.up",
                "Previous task",
                prev_id.is_some(),
                cx,
                cx.listener(move |this, _: &ClickEvent, _, cx| {
                    if let Some(id) = &prev_id {
                        this.select_board_task(&prev_project, id, cx);
                    }
                }),
            ))
            .child(stepper_button(
                "task-step-next",
                "arrow.down",
                "Next task",
                next_id.is_some(),
                cx,
                cx.listener(move |this, _: &ClickEvent, _, cx| {
                    if let Some(id) = &next_id {
                        this.select_board_task(&next_project, id, cx);
                    }
                }),
            ))
            .child(div().ml(px(4.)).child(stepper_button(
                "task-sheet-close",
                "xmark",
                "Close task details",
                true,
                cx,
                cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.close_board_task(&close_x_project, cx);
                }),
            )));

        let body = self.render_task_detail_body(coordinator, board, task, cx);
        let ui = &self.coordinators.task_boards[project];
        let narrow =
            self.coordinators.home_width.get() > 0. && self.coordinators.home_width.get() < 520.;

        div()
            .id("coordinator-task-sheet")
            .absolute()
            .top_0()
            .right_0()
            .bottom_0()
            .when(narrow, |el| el.left_0())
            .when(!narrow, |el| el.w(px(416.)).max_w(relative(0.88)))
            .flex()
            .flex_col()
            .bg(sheet_background(cx))
            .border_l_1()
            .border_color(style::card_border(cx))
            .shadow_lg()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(top_bar)
            .child(
                div()
                    .id("coordinator-task-detail")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&ui.detail_scroll)
                    .px(px(18.))
                    .py(px(16.))
                    .child(body),
            )
            .into_any_element()
    }

    fn render_task_detail_body(
        &self,
        coordinator: &Coordinator,
        board: &TaskBoard,
        task: &WorkTask,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut detail = v_flex().w_full().gap(px(14.)).child(
            div()
                .text_size(px(16.))
                .line_height(px(22.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(cx.theme().foreground)
                .child(task.title.clone()),
        );

        // Meta chips row
        let mut chips = h_flex().flex_wrap().gap(px(6.));
        chips = chips.child(status_meta_chip(task, cx));
        if let Some(wi) = board.work_item_title(task) {
            chips = chips.child(neutral_meta_chip(wi.to_owned(), cx));
        }
        if !matches!(task.owner, Owner::User) {
            chips = chips.child(neutral_meta_chip(task.owner.label().to_owned(), cx));
        }
        if let Some(due) = &task.due {
            let label = format!(
                "{} {}",
                if task.state == State::Postponed {
                    "Postponed until"
                } else {
                    "Due"
                },
                due_label(board, due)
            );
            chips = chips.child(neutral_meta_chip(label, cx));
        }
        detail = detail.child(chips);

        if let Some(now) = &task.now {
            detail = detail.child(detail_field("Now", now, cx));
        }
        if let Some(done) = &task.done_when {
            detail = detail.child(detail_field("Done when", done, cx));
        }
        if let Some(answer) = task.decision.as_ref().and_then(|d| d.answer.as_ref()) {
            detail = detail.child(detail_field("Answer", answer, cx));
        }

        detail = detail.children(self.task_controls(coordinator, board, task, cx));

        // Sub-tasks
        let children: Vec<&WorkTask> = board
            .tasks
            .iter()
            .filter(|t| t.parent_task_id.as_deref() == Some(&task.id))
            .collect();
        if !children.is_empty() {
            let mut sub_list = v_flex().w_full().gap(px(4.));
            for child in children {
                let project = coordinator.project_id.clone();
                let child_id = child.id.clone();
                let done = child.state == State::Done;
                let row = crate::highlights::tipped(
                    h_flex()
                        .id(id("subtask-row", &child.id))
                        .role(Role::Button)
                        .w_full()
                        .items_center()
                        .gap(px(8.))
                        .px(px(9.))
                        .py(px(6.))
                        .rounded(px(6.))
                        .bg(style::primary_opacity(cx, 0.03))
                        .cursor_pointer()
                        .hover(|s| s.bg(style::hover_fill(cx)))
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.select_board_task(&project, &child_id, cx);
                        })),
                    format!("Show task {}", child.title),
                )
                .child(task_status_icon(child, 13., cx))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(12.5))
                        .when(done, |el| {
                            el.text_color(style::faint_text(cx)).line_through()
                        })
                        .when(!done, |el| el.text_color(style::secondary_text(cx)))
                        .child(child.title.clone()),
                )
                .child(
                    div()
                        .flex_none()
                        .text_size(px(11.))
                        .text_color(style::faint_text(cx))
                        .child(child.state.label()),
                );
                sub_list = sub_list.child(row);
            }
            detail = detail.child(
                v_flex()
                    .w_full()
                    .gap(px(5.))
                    .child(field_label("Sub-tasks", cx))
                    .child(sub_list),
            );
        }

        detail = detail.children(self.render_task_source_footer(coordinator, task, cx));

        detail.into_any_element()
    }

    fn render_task_source_footer(
        &self,
        coordinator: &Coordinator,
        task: &WorkTask,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let source_link = task.source.as_ref().and_then(|source| {
            let thread = source
                .thread_id
                .as_ref()
                .or_else(|| source.seq.is_some().then_some(&coordinator.thread_id))?;
            let coordinator_thread = coordinator.thread_id.clone();
            let thread = thread.clone();
            let seq = source.seq;
            let helper = self
                .threads
                .get(&coordinator_thread)
                .and_then(|t| t.subagents.as_ref())
                .is_some_and(|helpers| helpers.iter().any(|h| h["id"].as_str() == Some(&thread)));
            let label = if helper || source.run_id.is_some() {
                "Open helper thread ↗"
            } else if thread == coordinator_thread {
                "Open in conversation ↗"
            } else {
                "Open source thread ↗"
            };
            let tip = if helper || source.run_id.is_some() {
                "Open helper thread"
            } else if thread == coordinator_thread {
                "Open in conversation"
            } else {
                "Open source thread"
            };
            Some(
                crate::highlights::tipped(
                    div()
                        .id("task-source")
                        .role(Role::Button)
                        .cursor_pointer()
                        .text_size(px(12.))
                        .text_color(style::link_text(cx))
                        .hover(|s| s.underline())
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            if thread == coordinator_thread {
                                this.jump_to_coordinator_loop(seq, window, cx);
                            } else if helper {
                                this.open_coordinator_tab(Tab::Activity, cx);
                                this.open_subagent(
                                    coordinator_thread.clone(),
                                    thread.clone(),
                                    window,
                                    cx,
                                );
                            } else {
                                this.open_thread_link(&thread, window, cx);
                            }
                        })),
                    tip,
                )
                .child(label),
            )
        });
        let updated = task
            .updated_at
            .as_deref()
            .and_then(local_time)
            .map(|at| format!("Updated {}", at.format("%a %-d %b, %-I:%M %p")));

        if source_link.is_none() && updated.is_none() {
            return None;
        }
        Some(
            h_flex()
                .w_full()
                .pt(px(10.))
                .mt(px(4.))
                .gap(px(8.))
                .items_center()
                .border_t_1()
                .border_color(style::hairline(cx))
                .children(source_link)
                .child(div().flex_1())
                .when_some(updated, |row, text| {
                    row.child(
                        div()
                            .flex_none()
                            .text_size(px(11.5))
                            .text_color(style::faint_text(cx))
                            .child(text),
                    )
                })
                .into_any_element(),
        )
    }

    fn task_controls(
        &self,
        coordinator: &Coordinator,
        board: &TaskBoard,
        task: &WorkTask,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let project = &coordinator.project_id;
        let ui = self.coordinators.task_boards.get(project);
        let pending = ui.is_some_and(|ui| ui.pending.contains(&Target::Task(task.id.clone())));
        if pending {
            return Some(
                h_flex()
                    .items_center()
                    .gap(px(6.))
                    .child(spinner(cx))
                    .child(muted("Updating task…", cx))
                    .into_any_element(),
            );
        }
        let main_action = match (&task.owner, task.kind, task.state) {
            (Owner::User, Kind::Action, state) if state != State::Done => {
                Some(("Done", "Mark this task done", TaskAction::Done, true))
            }
            (Owner::Agent, Kind::Action, State::ReadyToClose) => Some((
                "Got it, close",
                "Confirm this task is done",
                TaskAction::Close,
                true,
            )),
            (Owner::Agent, Kind::Action, State::Done) if task.can_reopen => {
                Some(("Undo", "Reopen this task", TaskAction::Reopen, false))
            }
            _ => None,
        };
        if let Some((label, tip, action, prominent)) = main_action {
            let pill = self.wired_task_pill(
                "task-main-action",
                label,
                tip,
                prominent,
                matches!(action, TaskAction::Close),
                project,
                &task.id,
                action,
                cx,
            );
            return Some(h_flex().child(pill).into_any_element());
        }

        if task.kind != Kind::Decision
            || task.owner != Owner::User
            || task.highlight() != Some(Highlight::NeedsYou)
        {
            return None;
        }

        Some(self.decision_controls(coordinator, board, task, cx))
    }

    fn decision_controls(
        &self,
        coordinator: &Coordinator,
        board: &TaskBoard,
        task: &WorkTask,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project = &coordinator.project_id;
        let ui = self.coordinators.task_boards.get(project);
        let ask = self
            .threads
            .get(&coordinator.thread_id)
            .and_then(|t| tasks::decision_ask(t, &task.id));
        let asks_seq = ask.map(|(_, seq)| seq);
        let editor = ui
            .and_then(|ui| ui.editor.as_ref())
            .filter(|editor| editor.task == task.id && editor.asks_seq == asks_seq);
        let ask = ask.map(|(ask, _)| ask);

        let choices: Vec<(&str, Option<&str>, bool)> = decision_choices(task, ask)
            .into_iter()
            .filter(|(label, _, _)| {
                !label
                    .trim()
                    .trim_end_matches(['.', '!', '?'])
                    .eq_ignore_ascii_case("not now")
            })
            .collect();

        // Default radio selection: explicit user pick, else recommended option, else first option.
        let picked = ui
            .and_then(|u| u.picked_choice.get(&task.id))
            .map(String::as_str)
            .filter(|p| choices.iter().any(|(label, _, _)| label == p))
            .or_else(|| {
                choices
                    .iter()
                    .find(|(_, _, suggested)| *suggested)
                    .or_else(|| choices.first())
                    .map(|(label, _, _)| *label)
            })
            .map(str::to_owned);

        let mut card_body = v_flex()
            .id(id("task-controls", &task.id))
            .w_full()
            .gap(px(8.));

        if task.now.is_none() {
            if let Some(why) = ask.and_then(|a| a.why.as_deref()) {
                card_body = card_body.child(detail_field("Now", why, cx));
            }
        }
        if let Some(ask) = ask {
            card_body = card_body.children(self.decision_links(coordinator, ask, cx));
        }

        // Selectable Threadbear-native radio option rows
        if !choices.is_empty() {
            let mut radio_list = v_flex().w_full().gap(px(6.));
            for (index, (label, note, suggested)) in choices.iter().enumerate() {
                let is_picked = picked.as_deref() == Some(*label);
                let pick_project = project.clone();
                let pick_task = task.id.clone();
                let pick_label = (*label).to_owned();
                let tip = if *suggested {
                    format!("{label} (recommended)")
                } else {
                    (*label).to_owned()
                };
                let row = h_flex()
                    .id(id("task-choice", &index.to_string()))
                    .role(Role::Button)
                    .w_full()
                    .items_start()
                    .gap(px(9.))
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(if is_picked {
                        style::accent(cx).opacity(0.5)
                    } else {
                        style::primary_opacity(cx, 0.08)
                    })
                    .bg(if is_picked {
                        style::accent(cx).opacity(0.09)
                    } else {
                        style::primary_opacity(cx, 0.025)
                    })
                    .cursor_pointer()
                    .when(!is_picked, |el| el.hover(|s| s.bg(style::hover_fill(cx))))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.pick_decision_choice(
                            &pick_project,
                            &pick_task,
                            pick_label.clone(),
                            cx,
                        );
                    }))
                    .child(radio_dot(is_picked, cx))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(2.))
                            .child(
                                h_flex()
                                    .flex_wrap()
                                    .items_center()
                                    .gap(px(5.))
                                    .child(
                                        div()
                                            .text_size(px(12.5))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(cx.theme().foreground)
                                            .child((*label).to_owned()),
                                    )
                                    .when(*suggested, |row| {
                                        row.child(
                                            icons::symbol("star.fill")
                                                .with_size(px(10.))
                                                .text_color(style::recommended_star(cx)),
                                        )
                                    }),
                            )
                            .when_some(*note, |col, note| {
                                col.child(
                                    div()
                                        .text_size(px(11.5))
                                        .line_height(px(16.))
                                        .text_color(style::secondary_text(cx))
                                        .child(note.to_owned()),
                                )
                            }),
                    )
                    .test_support()
                    .aria_label(SharedString::from((*label).to_owned()))
                    .tip(tip);
                radio_list = radio_list.child(row);
            }
            card_body = card_body.child(radio_list);
        }

        let mode = editor.map(|editor| &editor.mode);
        let mut actions = h_flex().flex_wrap().items_center().gap(px(7.)).pt(px(2.));
        if let Some(chosen) = picked {
            actions = actions.child(self.wired_task_pill(
                "task-send-choice",
                "Send choice",
                "Send the selected choice",
                true,
                false,
                project,
                &task.id,
                TaskAction::Answer {
                    answer: chosen,
                    asks_seq,
                },
                cx,
            ));
        }
        actions = actions
            .child(self.decision_mode_pill(
                coordinator,
                task,
                asks_seq,
                EditorChoice::Reply,
                matches!(mode, Some(EditMode::Reply { .. })),
                cx,
            ))
            .child(self.decision_mode_pill(
                coordinator,
                task,
                asks_seq,
                EditorChoice::Postpone,
                matches!(
                    mode,
                    Some(EditMode::Postpone | EditMode::AfterTask | EditMode::Date { .. })
                ),
                cx,
            ));
        card_body = card_body.child(actions);

        if let Some(mode) = mode {
            card_body = card_body.child(self.render_decision_editor(
                coordinator,
                board,
                task,
                asks_seq,
                mode,
                cx,
            ));
        }

        // Threadbear-native decision card frame with amber left accent bar
        div()
            .relative()
            .w_full()
            .rounded(px(10.))
            .bg(style::card_background(cx))
            .border_1()
            .border_color(style::card_border(cx))
            .overflow_hidden()
            .child(div().pl(px(15.)).pr(px(12.)).py(px(12.)).child(card_body))
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .bottom_0()
                    .w(px(3.))
                    .bg(style::needs_you(cx)),
            )
            .into_any_element()
    }

    fn render_decision_editor(
        &self,
        coordinator: &Coordinator,
        board: &TaskBoard,
        task: &WorkTask,
        asks_seq: Option<u64>,
        mode: &EditMode,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project = &coordinator.project_id;
        let connected = self.can_act();
        let mut body = v_flex().w_full().gap(px(8.));
        match mode {
            EditMode::Reply { input, .. } => {
                let reply = input.read(cx).value().trim().to_owned();
                let enabled = connected && !reply.is_empty();
                let send_project = project.clone();
                let send_task = task.id.clone();
                let mut send_pill =
                    cards::pill("send-task-reply", "Reply", true, enabled, None, cx)
                        .h(px(27.))
                        .min_w(px(58.))
                        .px(px(13.))
                        .rounded(px(13.5))
                        .text_size(px(12.));
                if enabled {
                    send_pill = send_pill.on_click(cx.listener(move |this, _, window, cx| {
                        this.task_action(
                            &send_project,
                            &send_task,
                            TaskAction::Answer {
                                answer: reply.clone(),
                                asks_seq,
                            },
                            window,
                            cx,
                        );
                    }));
                }
                body = body.child(
                    h_flex()
                        .gap(px(6.))
                        .w_full()
                        .pt(px(2.))
                        .child(
                            div()
                                .id("task-reply-input")
                                .min_w_0()
                                .flex_1()
                                .tip("Write your own reply")
                                .child(Input::new(input).small().disabled(!connected)),
                        )
                        .child(send_pill.test_support().tip("Send your own reply")),
                );
            }
            EditMode::Postpone | EditMode::Date { .. } | EditMode::AfterTask => {
                let tomorrow = self.wired_task_pill(
                    "task-postpone-tomorrow",
                    "Tomorrow 9 a.m.",
                    "Postpone until tomorrow at 9 a.m.",
                    false,
                    false,
                    project,
                    &task.id,
                    TaskAction::Postpone {
                        due: PostponeUntil::Tomorrow,
                        asks_seq,
                    },
                    cx,
                );
                let dependencies = board.dependencies(&task.id);
                body = body.child(
                    h_flex()
                        .flex_wrap()
                        .gap(px(6.))
                        .pt(px(4.))
                        .border_t_1()
                        .border_color(style::hairline(cx))
                        .child(tomorrow)
                        .child(self.decision_mode_pill(
                            coordinator,
                            task,
                            asks_seq,
                            EditorChoice::Date,
                            matches!(mode, EditMode::Date { .. }),
                            cx,
                        ))
                        .when(!dependencies.is_empty(), |el| {
                            el.child(self.decision_mode_pill(
                                coordinator,
                                task,
                                asks_seq,
                                EditorChoice::AfterTask,
                                matches!(mode, EditMode::AfterTask),
                                cx,
                            ))
                        }),
                );
                if let EditMode::Date { picker, .. } = mode {
                    body = body.child(
                        crate::highlights::tipped_as(
                            div().id("task-date-picker").w(px(175.)).max_w_full(),
                            "Choose a date at 9 a.m.",
                            Role::GenericContainer,
                        )
                        .child(DatePicker::new(picker).small().placeholder("Choose a date")),
                    );
                }
                if let EditMode::AfterTask = mode {
                    let rows = dependencies.into_iter().map(|dependency| {
                        let label = format!("After {}", dependency.title);
                        self.wired_task_pill(
                            id("task-postpone-after", &dependency.id),
                            &label,
                            &label,
                            false,
                            false,
                            project,
                            &task.id,
                            TaskAction::Postpone {
                                due: PostponeUntil::AfterTask {
                                    task_id: dependency.id.clone(),
                                },
                                asks_seq,
                            },
                            cx,
                        )
                    });
                    body = body.child(v_flex().items_start().gap(px(5.)).children(rows));
                }
            }
        }
        body.into_any_element()
    }

    fn decision_links(
        &self,
        coordinator: &Coordinator,
        ask: &OpenAsk,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let links = ask.links.as_ref()?;
        let links: Vec<_> = links
            .iter()
            .enumerate()
            .filter_map(|(index, link)| {
                let label = link["title"].as_str()?;
                let url = link["url"].as_str()?;
                let url = if url.starts_with('/') {
                    threadbear_core::open_policy::file_url(url)
                } else {
                    url.to_owned()
                };
                let thread = coordinator.thread_id.clone();
                Some(
                    crate::highlights::tipped(
                        h_flex()
                            .id(id("task-decision-link", &index.to_string()))
                            .role(Role::Button)
                            .items_center()
                            .gap(px(4.))
                            .px(px(8.))
                            .py(px(3.))
                            .rounded(px(6.))
                            .border_1()
                            .border_color(style::hairline(cx))
                            .bg(style::primary_opacity(cx, 0.03))
                            .cursor_pointer()
                            .text_size(px(11.5))
                            .text_color(style::link_text(cx))
                            .hover(|s| s.bg(style::hover_fill(cx)))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                if let Some(pane) = this.pane_for(&thread, cx) {
                                    // A link can read the app again to open a side pane.
                                    let url = url.clone();
                                    window.defer(cx, move |window, cx| {
                                        pane.update(cx, |pane, cx| {
                                            pane.link_clicked(&url, "", window, cx)
                                        });
                                    });
                                }
                            })),
                        label.to_owned(),
                    )
                    .child(label.to_owned())
                    .into_any_element(),
                )
            })
            .collect();
        if links.is_empty() {
            return None;
        }
        Some(
            h_flex()
                .flex_wrap()
                .gap(px(5.))
                .children(links)
                .into_any_element(),
        )
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Builds and wires a native Threadbear capsule pill for a task action"
    )]
    fn wired_task_pill(
        &self,
        id: impl Into<ElementId>,
        label: &str,
        tip: &str,
        prominent: bool,
        green: bool,
        project: &str,
        task: &str,
        action: TaskAction,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let enabled = self.can_act();
        let (project, task) = (project.to_owned(), task.to_owned());
        let mut pill = cards::pill(id, label, prominent, enabled, None, cx)
            .h(px(27.))
            .min_w(px(0.))
            .px(px(13.))
            .rounded(px(13.5))
            .text_size(px(12.));
        if green && enabled {
            pill = pill
                .bg(style::added_line_bg(cx))
                .border_color(style::added_text(cx).opacity(0.35))
                .text_color(style::added_text(cx));
        }
        if enabled {
            pill = pill.on_click(cx.listener(move |this, _, window, cx| {
                this.task_action(&project, &task, action.clone(), window, cx);
            }));
        }
        pill.test_support().tip(tip.to_owned()).into_any_element()
    }

    fn decision_mode_pill(
        &self,
        coordinator: &Coordinator,
        task: &WorkTask,
        asks_seq: Option<u64>,
        choice: EditorChoice,
        active: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (label, tip) = match choice {
            EditorChoice::Postpone => ("Not now", "Show postponement options"),
            EditorChoice::Date => ("Pick a date", "Postpone to a date"),
            EditorChoice::AfterTask => ("After a task", "Postpone until another task is done"),
            EditorChoice::Reply => ("Write reply", "Write your own reply"),
        };
        let project = coordinator.project_id.clone();
        let task_id = task.id.clone();
        let mut pill = cards::pill(id("decision-mode", label), label, false, true, None, cx)
            .h(px(27.))
            .min_w(px(0.))
            .px(px(12.))
            .rounded(px(13.5))
            .text_size(px(12.))
            .when(active, |el| {
                el.bg(style::accent(cx).opacity(0.14))
                    .border_color(style::accent(cx).opacity(0.45))
            });
        pill = pill.on_click(cx.listener(move |this, _, window, cx| {
            let mode = if active {
                match choice {
                    EditorChoice::Date | EditorChoice::AfterTask => Some(EditorChoice::Postpone),
                    _ => None,
                }
            } else {
                Some(choice)
            };
            this.edit_decision(
                &project,
                DecisionEditorTarget {
                    task: task_id.clone(),
                    asks_seq,
                },
                mode,
                window,
                cx,
            );
        }));
        pill.test_support().tip(tip.to_owned()).into_any_element()
    }

    fn edit_decision(
        &mut self,
        project: &str,
        target: DecisionEditorTarget,
        choice: Option<EditorChoice>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (project, task, asks_seq) = (project.to_owned(), target.task.clone(), target.asks_seq);
        let editor = choice.map(|choice| {
            let mode = match choice {
                EditorChoice::Postpone => EditMode::Postpone,
                EditorChoice::AfterTask => EditMode::AfterTask,
                EditorChoice::Date => {
                    let picker = cx.new(|cx| {
                        DatePickerState::new(window, cx).disabled_matcher(|date: &NaiveDate| {
                            !tasks::can_postpone_to_date(*date, Local::now().naive_local())
                        })
                    });
                    let project = project.clone();
                    let change = cx.subscribe_in(
                        &picker,
                        window,
                        move |this, _, event: &DatePickerEvent, window, cx| {
                            let DatePickerEvent::Change(date) = event;
                            if let Some(chosen) = date.start() {
                                if !tasks::can_postpone_to_date(
                                    chosen.date(),
                                    Local::now().naive_local(),
                                ) {
                                    this.show_error(
                                        "Choose a postpone time in the future.".to_owned(),
                                        cx,
                                    );
                                    return;
                                }
                                let date = chosen.format("%Y-%m-%d").to_string();
                                this.task_action(
                                    &project,
                                    &task,
                                    TaskAction::Postpone {
                                        due: PostponeUntil::Date { date },
                                        asks_seq,
                                    },
                                    window,
                                    cx,
                                );
                            }
                        },
                    );
                    EditMode::Date {
                        picker,
                        _change: change,
                    }
                }
                EditorChoice::Reply => {
                    let input = cx.new(|cx| InputState::new(window, cx).placeholder("Your reply"));
                    window.focus(&input.read(cx).focus_handle(cx), cx);
                    crate::web_panels::keyboard_to_app(window);
                    let project = project.clone();
                    let enter = cx.subscribe_in(
                        &input,
                        window,
                        move |this, input, event: &InputEvent, window, cx| {
                            if matches!(event, InputEvent::Change) {
                                cx.notify();
                            }
                            if matches!(event, InputEvent::PressEnter { .. }) {
                                let answer = input.read(cx).value().trim().to_owned();
                                if !answer.is_empty() {
                                    this.task_action(
                                        &project,
                                        &task,
                                        TaskAction::Answer { answer, asks_seq },
                                        window,
                                        cx,
                                    );
                                }
                            }
                        },
                    );
                    EditMode::Reply {
                        input,
                        _enter: enter,
                    }
                }
            };
            DecisionEditor {
                task: target.task,
                asks_seq,
                mode,
            }
        });
        self.coordinators
            .task_boards
            .entry(project)
            .or_default()
            .editor = editor;
        cx.notify();
    }
}

fn matches_filter(task: &WorkTask, filter: TaskFilter) -> bool {
    match filter {
        TaskFilter::All => true,
        TaskFilter::NeedsYou => task.status_bucket() == StatusBucket::NeedsYou,
        TaskFilter::InProgress => task.status_bucket() == StatusBucket::InProgress,
        TaskFilter::Waiting => task.status_bucket() == StatusBucket::Waiting,
    }
}

fn decision_choices<'a>(
    task: &'a WorkTask,
    ask: Option<&'a OpenAsk>,
) -> Vec<(&'a str, Option<&'a str>, bool)> {
    let decision = task.decision.as_ref();
    let recommended = decision.and_then(|d| d.recommendation.as_deref());
    if let Some((ask, options)) = ask
        .and_then(|ask| Some((ask, ask.options.as_ref()?)))
        .filter(|(_, options)| !options.is_empty())
    {
        return options
            .iter()
            .enumerate()
            .map(|(index, label)| {
                let note = ask
                    .option_notes
                    .as_ref()
                    .filter(|notes| notes.len() == options.len())
                    .and_then(|notes| notes.get(index))
                    .map(String::as_str)
                    .filter(|note| !note.is_empty())
                    .or_else(|| {
                        decision?
                            .options
                            .iter()
                            .find(|option| option.label == *label)?
                            .does
                            .as_deref()
                    });
                let suggested = ask
                    .suggested
                    .map_or(recommended == Some(label), |selected| index == selected);
                (label.as_str(), note, suggested)
            })
            .collect();
    }
    decision
        .into_iter()
        .flat_map(|d| &d.options)
        .map(|option| {
            (
                option.label.as_str(),
                option.does.as_deref(),
                recommended == Some(&option.label),
            )
        })
        .collect()
}

fn sheet_background(cx: &App) -> Hsla {
    if cx.theme().is_dark() {
        rgb(0x232325).into()
    } else {
        rgb(0xfbfbfc).into()
    }
}

fn status_dot_color(task: &WorkTask, cx: &App) -> Hsla {
    match task.state {
        State::Done => style::added_text(cx).opacity(0.65),
        State::Postponed | State::Waiting => style::faint_text(cx),
        State::ReadyToClose => style::added_text(cx),
        _ if task.owner == Owner::User || task.needs_you => style::needs_you_text(cx),
        State::Working => style::status_progress(cx),
        State::Todo => style::secondary_text(cx),
    }
}

fn pulse_tag(task: &WorkTask, cx: &App) -> (String, Hsla) {
    match task.status_bucket() {
        StatusBucket::NeedsYou => {
            if task.kind == Kind::Decision {
                ("You".to_owned(), style::needs_you_text(cx))
            } else if let Some(due) = &task.due {
                (short_due(due), style::faint_text(cx))
            } else {
                ("You".to_owned(), style::needs_you_text(cx))
            }
        }
        StatusBucket::InProgress => match task.state {
            State::Working => ("Working".to_owned(), style::status_progress(cx)),
            State::ReadyToClose => ("Ready".to_owned(), style::added_text(cx)),
            _ => ("Queued".to_owned(), style::faint_text(cx)),
        },
        StatusBucket::Waiting => match (&task.owner, task.state) {
            (Owner::Person { name }, _) => (name.clone(), style::faint_text(cx)),
            (_, State::Postponed) => (
                task.due
                    .as_ref()
                    .map(short_due)
                    .unwrap_or_else(|| "Later".to_owned()),
                style::faint_text(cx),
            ),
            _ => ("Waiting".to_owned(), style::faint_text(cx)),
        },
        StatusBucket::Done => ("Done".to_owned(), style::faint_text(cx)),
    }
}

fn task_status_icon(task: &WorkTask, size: f32, cx: &App) -> AnyElement {
    let (symbol, color) = match task.state {
        State::Done => ("checkmark.circle.fill", style::added_text(cx).opacity(0.75)),
        State::Postponed => ("pause.circle", style::faint_text(cx)),
        State::ReadyToClose => ("checkmark.circle.fill", style::added_text(cx)),
        State::Waiting if task.owner != Owner::User && !task.needs_you => {
            ("clock", style::faint_text(cx))
        }
        _ if (task.owner == Owner::User || task.needs_you) && task.kind == Kind::Decision => {
            ("task.decision", style::needs_you_text(cx))
        }
        _ if task.owner == Owner::User || task.needs_you => ("circle", style::needs_you_text(cx)),
        State::Working => ("task.progress", style::status_progress(cx)),
        State::Todo | State::Waiting => ("circle.dashed", style::secondary_text(cx)),
    };
    div()
        .flex_none()
        .w(px(size + 2.))
        .flex()
        .items_center()
        .justify_center()
        .child(icons::symbol(symbol).with_size(px(size)).text_color(color))
        .into_any_element()
}

fn status_group_header(bucket: StatusBucket, count: usize, cx: &App) -> Div {
    let (symbol, icon_color, text_color) = match bucket {
        StatusBucket::NeedsYou => (
            "task.decision",
            style::needs_you_text(cx),
            style::needs_you_text(cx),
        ),
        StatusBucket::InProgress => (
            "task.progress",
            style::status_progress(cx),
            style::secondary_text(cx),
        ),
        StatusBucket::Waiting => ("clock", style::faint_text(cx), style::secondary_text(cx)),
        StatusBucket::Done => (
            "checkmark.circle.fill",
            style::faint_text(cx),
            style::faint_text(cx),
        ),
    };
    h_flex()
        .w_full()
        .items_center()
        .gap(px(8.))
        .px(px(18.))
        .py(px(7.))
        .bg(style::primary_opacity(cx, 0.015))
        .border_t_1()
        .border_b_1()
        .border_color(style::hairline(cx))
        .child(
            icons::symbol(symbol)
                .with_size(px(13.))
                .text_color(icon_color),
        )
        .child(
            div()
                .text_size(px(12.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(text_color)
                .child(bucket.label()),
        )
        .child(
            div()
                .text_size(px(11.5))
                .text_color(style::faint_text(cx))
                .child(count.to_string()),
        )
}

fn row_owner_label(task: &WorkTask) -> String {
    if task.kind == Kind::Decision && task.state != State::Done {
        return "Decision".to_owned();
    }
    match &task.owner {
        Owner::User => "You".to_owned(),
        Owner::Agent => {
            if task.state == State::ReadyToClose {
                "Ready".to_owned()
            } else {
                "Helper".to_owned()
            }
        }
        Owner::Person { name } => name.clone(),
    }
}

fn row_due_label(task: &WorkTask) -> (String, bool) {
    if let Some(due) = &task.due {
        let amber = task.status_bucket() == StatusBucket::NeedsYou && task.kind == Kind::Decision;
        return (short_due(due), amber);
    }
    let text = match task.state {
        State::Working => "Now",
        State::ReadyToClose => "Sign off",
        State::Waiting => "Waiting",
        State::Postponed => "Later",
        State::Done => "Done",
        State::Todo => "",
    };
    (text.to_owned(), false)
}

fn status_meta_chip(task: &WorkTask, cx: &App) -> Div {
    let dot = status_dot_color(task, cx);
    let (label, bg, border, fg) = match task.status_bucket() {
        StatusBucket::NeedsYou => {
            let kind = if task.kind == Kind::Decision {
                "Needs you · Decision"
            } else {
                "Needs you"
            };
            (
                kind,
                style::needs_you_text(cx).opacity(0.12),
                style::needs_you_text(cx).opacity(0.28),
                style::needs_you_text(cx),
            )
        }
        StatusBucket::InProgress if task.state == State::ReadyToClose => (
            "Ready to close",
            style::added_line_bg(cx),
            style::added_text(cx).opacity(0.28),
            style::added_text(cx),
        ),
        StatusBucket::InProgress => (
            task.state.label(),
            style::status_progress(cx).opacity(0.12),
            style::status_progress(cx).opacity(0.28),
            style::status_progress(cx),
        ),
        StatusBucket::Waiting | StatusBucket::Done => (
            task.state.label(),
            style::primary_opacity(cx, 0.05),
            style::hairline(cx),
            style::secondary_text(cx),
        ),
    };
    h_flex()
        .items_center()
        .gap(px(5.))
        .px(px(8.))
        .py(px(3.))
        .rounded(px(6.))
        .bg(bg)
        .border_1()
        .border_color(border)
        .text_size(px(11.5))
        .text_color(fg)
        .child(div().size(px(6.)).rounded_full().bg(dot))
        .child(label)
}

fn neutral_meta_chip(label: String, cx: &App) -> Div {
    div()
        .px(px(8.))
        .py(px(3.))
        .rounded(px(6.))
        .bg(style::primary_opacity(cx, 0.05))
        .border_1()
        .border_color(style::hairline(cx))
        .text_size(px(11.5))
        .text_color(style::secondary_text(cx))
        .child(label)
}

fn stepper_button(
    id: impl Into<ElementId>,
    symbol: &'static str,
    tip: &'static str,
    enabled: bool,
    cx: &App,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let mut el = div()
        .id(id)
        .role(Role::Button)
        .flex_none()
        .size(px(22.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(5.))
        .border_1()
        .border_color(style::hairline(cx))
        .bg(style::card_background(cx))
        .child(
            icons::symbol(symbol)
                .with_size(px(11.))
                .text_color(if enabled {
                    style::secondary_text(cx)
                } else {
                    style::faint_text(cx).opacity(0.45)
                }),
        );
    if enabled {
        el = el
            .cursor_pointer()
            .hover(|s| s.bg(style::hover_fill(cx)))
            .on_click(on_click);
    }
    crate::highlights::tipped(el, tip).into_any_element()
}

fn radio_dot(picked: bool, cx: &App) -> Div {
    let mut outer = div()
        .flex_none()
        .mt(px(2.))
        .size(px(14.))
        .rounded_full()
        .border_1()
        .border_color(if picked {
            style::accent(cx)
        } else {
            style::faint_text(cx)
        })
        .flex()
        .items_center()
        .justify_center();
    if picked {
        outer = outer.child(div().size(px(6.)).rounded_full().bg(style::accent(cx)));
    }
    outer
}

fn id(prefix: &str, key: &str) -> ElementId {
    SharedString::from(format!("{prefix}-{key}")).into()
}

fn spinner(cx: &App) -> AnyElement {
    Spinner::new()
        .with_size(px(12.))
        .color(style::secondary_text(cx))
        .into_any_element()
}

fn muted(text: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .text_size(px(12.))
        .line_height(px(17.))
        .text_color(style::secondary_text(cx))
        .child(text.into())
}

fn field_label(label: &str, cx: &App) -> Div {
    div()
        .text_size(px(11.5))
        .font_weight(FontWeight::MEDIUM)
        .text_color(style::faint_text(cx))
        .child(label.to_owned())
}

fn detail_field(label: &str, text: &str, cx: &App) -> Div {
    v_flex()
        .w_full()
        .gap(px(3.))
        .child(field_label(label, cx))
        .child(
            div()
                .text_size(px(13.))
                .line_height(px(19.))
                .text_color(cx.theme().foreground)
                .child(text.to_owned()),
        )
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        text.to_owned()
    } else {
        let mut out: String = text.chars().take(max_chars.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

fn local_time(at: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(at)
        .ok()
        .map(|at| at.with_timezone(&Local))
}

fn short_due(due: &TaskDue) -> String {
    match due {
        TaskDue::At { at } => local_time(at)
            .map(|at| at.format("%a %-d").to_string())
            .unwrap_or_default(),
        TaskDue::AfterTask { .. } => "After…".to_owned(),
    }
}

fn due_label(board: &TaskBoard, due: &TaskDue) -> String {
    match due {
        TaskDue::At { at } => local_time(at)
            .map(|at| at.format("%a %-d %b, %-I:%M %p").to_string())
            .unwrap_or_else(|| at.clone()),
        TaskDue::AfterTask { task_id } => format!(
            "after {}",
            board
                .task(task_id)
                .map_or(task_id.as_str(), |task| task.title.as_str())
        ),
    }
}
