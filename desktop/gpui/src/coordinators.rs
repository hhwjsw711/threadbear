// The project's coordinator uses an ordinary thread and its existing
// composer. Only its project link and helper-owned work live here.
use crate::app::Threadbear;
use crate::call;
use gpui_kit::component::input::InputState;
use gpui_kit::component::WindowExt as _;
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use threadbear_core::coordinators::{Coordinator, State};
use threadbear_core::inbox::ThreadSummary;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Tab {
    #[default]
    Conversation,
    Activity,
    Tasks,
    Threads,
}

impl Tab {
    pub(crate) const ALL: [Self; 4] = [
        Self::Conversation,
        Self::Activity,
        Self::Tasks,
        Self::Threads,
    ];

    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::Conversation => "Conversation",
            Self::Activity => "Activity",
            Self::Tasks => "Tasks",
            Self::Threads => "Threads",
        }
    }
}

pub(crate) struct UndoLoop {
    pub(crate) project_id: String,
    pub(crate) loop_id: String,
    pub(crate) title: String,
}

pub(crate) struct LoopReplyDraft {
    pub(crate) project_id: String,
    pub(crate) loop_id: String,
    pub(crate) close: bool,
    pub(crate) input: Entity<InputState>,
}

#[derive(Default)]
pub(crate) struct CoordinatorsState {
    pub(crate) list: Vec<Coordinator>,
    pub(crate) generation: u64,
    pub(crate) loading: bool,
    pub(crate) tab: Tab,
    pub(crate) setup: Option<String>,
    pub(crate) setup_id: u64,
    pub(crate) setup_close_dialog: bool,
    pub(crate) setup_error: Option<String>,
    pub(crate) saved_picks: Option<threadbear_core::new_thread::NewThreadPicks>,
    pub(crate) busy: HashSet<String>,
    pub(crate) agent_memory_open: HashSet<String>,
    pub(crate) goals_open: HashSet<String>,
    pub(crate) undo_loop: Option<UndoLoop>,
    pub(crate) replying_loop: Option<LoopReplyDraft>,
    pub(crate) loops_scroll: ScrollHandle,
    pub(crate) document_scroll: ScrollHandle,
    pub(crate) memory_scroll: ScrollHandle,
    pub(crate) work_scroll: ScrollHandle,
    pub(crate) task_boards: std::collections::HashMap<String, crate::coordinator_tasks::BoardUi>,
    /// The open home's width, measured as it's drawn, for whether its tabs
    /// fit in the bar (coordinator_home.rs).
    pub(crate) home_width: std::rc::Rc<std::cell::Cell<f32>>,
}

impl Threadbear {
    pub(crate) fn coordinators_on(&self) -> bool {
        self.experiment_on("coordinators")
    }

    pub(crate) fn confirmed_coordinators_on(&self) -> bool {
        match self
            .runner_settings_state
            .confirmed_experiment_on("coordinators")
        {
            Some(on) => on,
            // Across a reconnect, wait for `settings.get` on the new session
            // rather than trusting cached pre-reconnect settings or a mock
            // hello that ignores runtime experiment toggles.
            None if self.runner_settings_state.confirmed().is_some() => false,
            None => self.remote.experiments.iter().any(|e| e == "coordinators"),
        }
    }

    pub(crate) fn coordinator_for_project(&self, id: &str) -> Option<&Coordinator> {
        self.coordinators_on()
            .then(|| self.coordinators.list.iter().find(|c| c.project_id == id))
            .flatten()
    }

    pub(crate) fn coordinator_project_for_thread(&self, id: &str) -> Option<String> {
        self.coordinators_on()
            .then(|| self.coordinators.list.iter().find(|c| c.thread_id == id))
            .flatten()
            .map(|c| c.project_id.clone())
    }

    pub(crate) fn load_coordinators(&mut self, cx: &mut Context<Self>) {
        if !self.coordinators_on() {
            if self.coordinators.setup.is_some() {
                self.coordinators.setup_close_dialog = true;
                self.close_coordinator_setup(None, cx);
            }
            self.receive_coordinators(&json!([]));
            return;
        }
        // Wait for any in-flight/queued toggle of the coordinator experiment
        // to settle on the runner before asking for `coordinators.list`, so a
        // runner that still has it off does not reject the call.
        if !self.connected()
            || !self.confirmed_coordinators_on()
            || self
                .runner_settings_state
                .has_pending_experiment("coordinators")
        {
            return;
        }
        self.coordinators.generation += 1;
        self.coordinators.loading = true;
        let generation = self.coordinators.generation;
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let result = call(client, "coordinators.list", json!({})).await;
            this.update(cx, |this, cx| {
                if this.coordinators.generation != generation || !this.coordinators_on() {
                    return;
                }
                this.coordinators.loading = false;
                match result {
                    Ok(value) => this.receive_coordinators(&value["coordinators"]),
                    Err(error) => this.show_error(error.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn receive_coordinators(&mut self, value: &Value) {
        if !value.is_array() {
            return;
        }
        self.coordinators.generation += 1;
        self.coordinators.loading = false;
        self.coordinators.list = threadbear_core::coordinators::Coordinator::list(value);
        self.invalidate_coordinator_sections();
    }

    pub(crate) fn close_coordinator_setup(&mut self, id: Option<u64>, cx: &mut Context<Self>) {
        if id.is_some_and(|expected| self.coordinators.setup_id != expected) {
            return;
        }
        self.coordinators.setup = None;
        self.coordinators.setup_error = None;
        if let Some(picks) = self.coordinators.saved_picks.take() {
            self.new_thread.picks = picks;
        }
        cx.notify();
    }

    pub(crate) fn start_coordinator(
        &mut self,
        project: &str,
        setup_id: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = format!("start:{project}");
        if !self.coordinators.busy.insert(key.clone()) {
            return;
        }
        self.coordinators.setup_error = None;
        let logins = self.draft_logins();
        let selection = self.with_draft(&logins, |d| d.create_params("", Vec::new(), false));
        let mut params = json!({"projectId":project});
        for name in ["accountId", "poolId", "model", "effort"] {
            if let Some(value) = selection.get(name) {
                params[name] = value.clone();
            }
        }
        let going = crate::call_action(self.client.clone(), "coordinators.start", params);
        let project = project.to_owned();
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = going.await;
            this.update_in(cx, |this, window, cx| {
                this.coordinators.busy.remove(&key);
                let same_dialog = this.coordinators.setup_id == setup_id
                    && this.coordinators.setup.as_deref() == Some(project.as_str());
                match result {
                    Ok(value) => {
                        if let Some(coordinator) = Coordinator::decode(&value["coordinator"]) {
                            let was_loading = this.coordinators.loading;
                            this.coordinators.generation += 1;
                            this.coordinators.loading = false;
                            this.coordinators.list.retain(|c| c.project_id != project);
                            this.coordinators.list.push(coordinator.clone());
                            this.invalidate_coordinator_sections();
                            if was_loading {
                                this.load_coordinators(cx);
                            }
                            if let Ok(thread) =
                                serde_json::from_value::<ThreadSummary>(value["thread"].clone())
                            {
                                this.threads.insert(thread.id.clone(), Arc::new(thread));
                            }
                            if same_dialog {
                                this.coordinators.setup_close_dialog = false;
                                window.close_dialog(cx);
                                this.close_coordinator_setup(Some(setup_id), cx);
                            }
                            this.coordinators.tab = Tab::Conversation;
                            this.open(coordinator.thread_id, window, cx);
                            this.projects.open = Some(project);
                            this.show_pane(crate::shell::HIGHLIGHTS, cx);
                            this.load_list(cx);
                        } else {
                            let message =
                                "The runner did not return the coordinator it made.".to_owned();
                            if same_dialog {
                                this.coordinators.setup_error = Some(message);
                            } else {
                                this.show_error(message, cx);
                            }
                            this.load_coordinators(cx);
                        }
                    }
                    Err(error) => {
                        if same_dialog {
                            this.coordinators.setup_error = Some(error.message);
                        } else {
                            this.show_error(error.message, cx);
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn pause_coordinator(&mut self, coordinator: &Coordinator, cx: &mut Context<Self>) {
        let key = format!("pause:{}", coordinator.project_id);
        if !self.coordinators.busy.insert(key.clone()) {
            return;
        }
        let params =
            json!({"projectId":coordinator.project_id,"paused":coordinator.state != State::Paused});
        let going = crate::call_action(self.client.clone(), "coordinators.pause", params);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = going.await;
            this.update(cx, |this, cx| {
                this.coordinators.busy.remove(&key);
                match result {
                    Ok(value) => this.replace_coordinator(&value["coordinator"], cx),
                    Err(error) => {
                        this.show_error(error.message, cx);
                        this.load_coordinators(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn replace_coordinator(&mut self, value: &Value, cx: &mut Context<Self>) {
        if let Some(coordinator) = Coordinator::decode(value) {
            let was_loading = self.coordinators.loading;
            self.coordinators.generation += 1;
            self.coordinators.loading = false;
            if let Some(existing) = self
                .coordinators
                .list
                .iter_mut()
                .find(|c| c.project_id == coordinator.project_id)
            {
                *existing = coordinator;
            } else {
                self.coordinators.list.push(coordinator);
            }
            self.invalidate_coordinator_sections();
            if was_loading {
                self.load_coordinators(cx);
            }
        }
    }

    pub(crate) fn agent_memory_open(&self, project_id: &str) -> bool {
        self.coordinators.agent_memory_open.contains(project_id)
            || self.projects.editing.as_ref().is_some_and(|e| {
                e.project == project_id && e.field == threadbear_core::projects::TextField::Notes
            })
    }

    pub(crate) fn toggle_agent_memory(&mut self, project_id: &str, cx: &mut Context<Self>) {
        let editing_notes = self.projects.editing.as_ref().is_some_and(|e| {
            e.project == project_id && e.field == threadbear_core::projects::TextField::Notes
        });
        if self.coordinators.agent_memory_open.contains(project_id) {
            if !editing_notes {
                self.coordinators.agent_memory_open.remove(project_id);
            }
        } else {
            self.coordinators
                .agent_memory_open
                .insert(project_id.to_owned());
        }
        cx.notify();
    }

    pub(crate) fn goals_open(&self, project_id: &str) -> bool {
        self.coordinators.goals_open.contains(project_id)
            || self.projects.editing.as_ref().is_some_and(|e| {
                e.project == project_id && e.field == threadbear_core::projects::TextField::Goals
            })
    }

    pub(crate) fn toggle_goals(&mut self, project_id: &str, cx: &mut Context<Self>) {
        let editing_goals = self.projects.editing.as_ref().is_some_and(|e| {
            e.project == project_id && e.field == threadbear_core::projects::TextField::Goals
        });
        if self.coordinators.goals_open.contains(project_id) {
            if !editing_goals {
                self.coordinators.goals_open.remove(project_id);
            }
        } else {
            self.coordinators.goals_open.insert(project_id.to_owned());
        }
        cx.notify();
    }

    pub(crate) fn close_coordinator_loop(
        &mut self,
        project_id: &str,
        loop_id: &str,
        title: String,
        cx: &mut Context<Self>,
    ) {
        let key = format!("loop:{loop_id}");
        if !self.coordinators.busy.insert(key.clone()) {
            return;
        }
        if self
            .coordinators
            .replying_loop
            .as_ref()
            .is_some_and(|draft| draft.project_id == project_id && draft.loop_id == loop_id)
        {
            self.coordinators.replying_loop = None;
        }
        let params = json!({"projectId": project_id, "loopId": loop_id});
        let going = crate::call_action(self.client.clone(), "coordinators.closeLoop", params);
        let project_id = project_id.to_owned();
        let loop_id = loop_id.to_owned();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = going.await;
            this.update(cx, |this, cx| {
                this.coordinators.busy.remove(&key);
                match result {
                    Ok(value) => {
                        this.replace_coordinator(&value["coordinator"], cx);
                        this.coordinators.undo_loop = Some(UndoLoop {
                            project_id,
                            loop_id,
                            title,
                        });
                    }
                    Err(error) => {
                        this.show_error(error.message, cx);
                        this.load_coordinators(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn reopen_coordinator_loop(
        &mut self,
        project_id: &str,
        loop_id: &str,
        cx: &mut Context<Self>,
    ) {
        let key = format!("loop:{loop_id}");
        if !self.coordinators.busy.insert(key.clone()) {
            return;
        }
        let params = json!({"projectId": project_id, "loopId": loop_id});
        let going = crate::call_action(self.client.clone(), "coordinators.reopenLoop", params);
        let loop_id = loop_id.to_owned();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = going.await;
            this.update(cx, |this, cx| {
                this.coordinators.busy.remove(&key);
                match result {
                    Ok(value) => {
                        this.replace_coordinator(&value["coordinator"], cx);
                        if this
                            .coordinators
                            .undo_loop
                            .as_ref()
                            .is_some_and(|undo| undo.loop_id == loop_id)
                        {
                            this.coordinators.undo_loop = None;
                        }
                    }
                    Err(error) => {
                        this.show_error(error.message, cx);
                        this.load_coordinators(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn dismiss_undo_loop(&mut self, cx: &mut Context<Self>) {
        self.coordinators.undo_loop = None;
        cx.notify();
    }

    pub(crate) fn start_reply_coordinator_loop(
        &mut self,
        project_id: &str,
        loop_id: &str,
        close: bool,
        placeholder: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let placeholder = placeholder.to_owned();
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        let focus = input.read(cx).focus_handle(cx);
        self.coordinators.replying_loop = Some(LoopReplyDraft {
            project_id: project_id.to_owned(),
            loop_id: loop_id.to_owned(),
            close,
            input,
        });
        window.focus(&focus, cx);
        crate::web_panels::keyboard_to_app(window);
        cx.notify();
    }

    pub(crate) fn cancel_reply_coordinator_loop(&mut self, cx: &mut Context<Self>) {
        self.coordinators.replying_loop = None;
        cx.notify();
    }

    pub(crate) fn submit_reply_coordinator_loop(&mut self, cx: &mut Context<Self>) {
        let Some((project_id, loop_id, close, text)) =
            self.coordinators.replying_loop.as_ref().map(|draft| {
                (
                    draft.project_id.clone(),
                    draft.loop_id.clone(),
                    draft.close,
                    draft.input.read(cx).value().to_string(),
                )
            })
        else {
            return;
        };
        self.send_coordinator_loop_reply(&project_id, &loop_id, text, close, cx);
    }

    pub(crate) fn send_coordinator_loop_reply(
        &mut self,
        project_id: &str,
        loop_id: &str,
        text: String,
        close: bool,
        cx: &mut Context<Self>,
    ) {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return;
        }
        let key = format!("loop:{loop_id}");
        if !self.coordinators.busy.insert(key.clone()) {
            return;
        }
        let params = json!({
            "projectId": project_id,
            "loopId": loop_id,
            "text": trimmed,
            "close": close,
        });
        let going = crate::call_action(self.client.clone(), "coordinators.replyLoop", params);
        let loop_id = loop_id.to_owned();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = going.await;
            this.update(cx, |this, cx| {
                this.coordinators.busy.remove(&key);
                match result {
                    Ok(value) => {
                        this.replace_coordinator(&value["coordinator"], cx);
                        if this
                            .coordinators
                            .replying_loop
                            .as_ref()
                            .is_some_and(|draft| draft.loop_id == loop_id)
                        {
                            this.coordinators.replying_loop = None;
                        }
                        if this
                            .coordinators
                            .undo_loop
                            .as_ref()
                            .is_some_and(|undo| undo.loop_id == loop_id)
                        {
                            this.coordinators.undo_loop = None;
                        }
                    }
                    Err(error) => {
                        this.show_error(error.message, cx);
                        this.load_coordinators(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn jump_to_coordinator_loop(
        &mut self,
        source_seq: Option<i64>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.coordinators.tab = Tab::Conversation;
        self.close_subagent(cx);
        if let Some(pane) = self.pane.clone() {
            pane.update(cx, |pane, cx| {
                if let Some(seq) = source_seq {
                    pane.reveal_seq(seq, window, cx);
                } else {
                    pane.focus_composer(window, cx);
                }
            });
        }
        cx.notify();
    }
}
