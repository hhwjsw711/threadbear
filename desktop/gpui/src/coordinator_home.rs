// The coordinator's project home: its real conversation in the centre,
// sticky open loops + living project brief + collapsed agent memory in
// Highlights, and quiet helper detail on Activity.
use crate::a11y::A11yRole as _;
use crate::app::Threadbear;
use crate::coordinators::Tab;
use crate::icons;
use crate::projects::project_icon;
use crate::spinner::Spinner;
use crate::style::{self, px, size};
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::Input;
use gpui_kit::component::{
    h_flex, v_flex, ActiveTheme as _, Disableable as _, Sizable as _, WindowExt as _,
};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use threadbear_core::coordinators::{note_sections, Coordinator, Loop, LoopKind, LoopState, State};
use threadbear_core::projects::{Project, TextField};

impl Threadbear {
    pub(crate) fn render_coordinator_home(
        &mut self,
        project: &Project,
        coordinator: &Coordinator,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if self.selected.as_deref() != Some(coordinator.thread_id.as_str()) || self.pane.is_none() {
            self.open(coordinator.thread_id.clone(), window, cx);
            self.projects.open = Some(project.id.clone());
        }
        // The tabs sit in the bar beside Pause and the arrows (`render_coordinator_bar`)
        // and drop to a row of their own here only when the panel's too narrow
        // for them beside the title (Mike, 26 Nov: the old header, title again,
        // status and tabs, took about 176px over the conversation).
        let tabs =
            (!self.coordinator_tabs_in_bar()).then(|| self.coordinator_tabs(coordinator, cx));
        let body = match self.coordinators.tab {
            Tab::Conversation => self.pane.as_ref().map_or_else(
                || {
                    div()
                        .p(px(30.))
                        .child("Loading the coordinator…")
                        .into_any_element()
                },
                |pane| div().size_full().child(pane.clone()).into_any_element(),
            ),
            Tab::Activity => self.render_coordinator_activity(coordinator, cx),
            Tab::Tasks => self.render_coordinator_tasks(coordinator, window, cx),
            Tab::Threads => {
                let threads = threadbear_core::projects::threads_in(
                    &project.id,
                    self.threads.values().map(|t| &**t),
                )
                .into_iter()
                .filter(|t| t.id != coordinator.thread_id)
                .cloned()
                .collect::<Vec<_>>();
                let list = self.render_threads_section(project, &threads, cx);
                div()
                    .id("coordinator-project-threads")
                    .size_full()
                    .overflow_y_scroll()
                    .p(px(28.))
                    .child(list)
                    .into_any_element()
            }
        };
        let width = self.coordinators.home_width.clone();
        v_flex()
            .size_full()
            .relative()
            .child(
                canvas(
                    move |bounds, window, _| {
                        let w = f32::from(bounds.size.width);
                        if (width.get() - w).abs() > 0.5 {
                            width.set(w);
                            window.refresh();
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .children(tabs)
            .child(div().flex_1().min_h_0().child(body))
            .into_any_element()
    }

    /// Whether the open coordinator's tabs fit in the panel's bar beside the
    /// title, or drop to a row of their own under it.
    pub(crate) fn coordinator_tabs_in_bar(&self) -> bool {
        let w = self.coordinators.home_width.get();
        w == 0. || w >= TABS_IN_BAR_WIDTH
    }

    /// The coordinator's state after its project's title in the bar: a dot
    /// and "2 helpers working", "Coordinator on" or "Paused".
    pub(crate) fn render_coordinator_bar_status(
        &self,
        project_id: &str,
        cx: &App,
    ) -> Option<AnyElement> {
        let coordinator = self.coordinator_for_project(project_id)?;
        let working = coordinator.working();
        let (text, dot) = if coordinator.state == State::Paused {
            ("Paused".to_owned(), style::faint_text(cx))
        } else if working == 0 {
            ("Coordinator on".to_owned(), style::added_text(cx))
        } else {
            (
                format!(
                    "{working} helper{} working",
                    if working == 1 { "" } else { "s" }
                ),
                style::status_progress(cx),
            )
        };
        Some(
            h_flex()
                .flex_none()
                .ml(px(6.))
                .gap(px(6.))
                .items_center()
                .text_size(px(12.))
                .font_weight(FontWeight::NORMAL)
                .text_color(style::secondary_text(cx))
                .child(status_dot(dot))
                .child(text)
                .into_any_element(),
        )
    }

    /// The bar's controls over a coordinator's home, before its arrows: the
    /// tabs as a segmented control (when they fit) and Pause or Resume.
    pub(crate) fn render_coordinator_bar(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let project = self.open_project()?.clone();
        let coordinator = self.coordinator_for_project(&project.id)?.clone();
        let busy = self
            .coordinators
            .busy
            .contains(&format!("pause:{}", project.id));
        let paused = coordinator.state == State::Paused;
        let pause = coordinator.clone();
        let tabs = self
            .coordinator_tabs_in_bar()
            .then(|| self.coordinator_segments(&coordinator, cx));
        Some(
            h_flex()
                .flex_none()
                .gap(px(10.))
                .mr(px(6.))
                .items_center()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .children(tabs)
                .child(control(
                    "coordinator-pause",
                    if paused { "Resume" } else { "Pause" },
                    "Pause or resume the coordinator and its helpers",
                    busy,
                    cx,
                    cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.pause_coordinator(&pause, cx)
                    }),
                ))
                .into_any_element(),
        )
    }

    /// The tabs in the bar, as a small segmented control (usage.rs's range).
    fn coordinator_segments(
        &self,
        coordinator: &Coordinator,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let count = self.conversation_count(coordinator);
        let fg = cx.theme().foreground;
        let secondary = style::secondary_text(cx);
        let selected = style::primary_opacity(cx, 0.19);
        let mut segments = h_flex()
            .id("coordinator-tabs")
            .flex_none()
            .h(px(26.))
            .p(px(2.))
            .gap(px(2.))
            .rounded(px(7.))
            .bg(style::primary_opacity(cx, 0.075))
            .role(Role::TabList);
        let tasks_count = coordinator
            .task_board
            .as_deref()
            .map_or(0, |board| board.open_count());
        for tab in Tab::ALL {
            let active = self.coordinators.tab == tab;
            let mut label = h_flex().gap(px(6.)).items_center().child(tab.title());
            if tab == Tab::Conversation && count > 0 {
                label = label.child(
                    div()
                        .text_size(px(11.))
                        .text_color(style::needs_you_text(cx))
                        .child(count.to_string()),
                );
            } else if tab == Tab::Tasks && tasks_count > 0 {
                label = label.child(
                    div()
                        .text_size(px(11.))
                        .text_color(style::secondary_text(cx))
                        .child(tasks_count.to_string()),
                );
            }
            segments = segments.child(
                crate::highlights::tipped(
                    div()
                        .id(SharedString::from(format!(
                            "coordinator-tab-{}",
                            tab.title()
                        )))
                        .role(Role::Tab)
                        .h_full()
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .rounded(px(5.))
                        .cursor_pointer()
                        .text_size(px(12.))
                        .text_color(if active { fg } else { secondary })
                        .when(active, |s| s.bg(selected))
                        .when(!active, |s| s.hover(move |s| s.text_color(fg))),
                    format!("Show the project's {}", tab.title().to_lowercase()),
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.open_coordinator_tab(tab, cx);
                }))
                .child(label),
            );
        }
        segments.into_any_element()
    }

    /// The number beside Conversation: open loops to act on, else the
    /// decisions on its card.
    fn conversation_count(&self, coordinator: &Coordinator) -> usize {
        if coordinator.task_board.is_some() {
            return self
                .threads
                .get(&coordinator.thread_id)
                .and_then(|t| t.asks.as_ref())
                .map_or(0, |asks| {
                    asks.iter().filter(|ask| ask.ticked != Some(true)).count()
                });
        }
        let actionable = coordinator.actionable_loops();
        if actionable > 0 {
            return actionable;
        }
        self.threads
            .get(&coordinator.thread_id)
            .and_then(|t| t.asks.as_ref())
            .map_or(0, Vec::len)
    }

    fn coordinator_tabs(&self, coordinator: &Coordinator, cx: &mut Context<Self>) -> AnyElement {
        let mut tabs = h_flex()
            .w_full()
            .pt(px(10.))
            .px(px(28.))
            .gap(px(23.))
            .border_b_1()
            .border_color(cx.theme().border);
        let tasks_count = coordinator
            .task_board
            .as_deref()
            .map_or(0, |board| board.open_count());
        for tab in Tab::ALL {
            let active = self.coordinators.tab == tab;
            let ink = if active {
                cx.theme().foreground
            } else {
                style::secondary_text(cx)
            };
            let mut label = h_flex().gap(px(6.)).child(tab.title());
            if tab == Tab::Conversation {
                let count = self.conversation_count(coordinator);
                if count > 0 {
                    label = label.child(
                        div()
                            .text_size(px(11.))
                            .text_color(style::needs_you_text(cx))
                            .child(count.to_string()),
                    );
                }
            } else if tab == Tab::Tasks && tasks_count > 0 {
                label = label.child(
                    div()
                        .text_size(px(11.))
                        .text_color(style::secondary_text(cx))
                        .child(tasks_count.to_string()),
                );
            }
            tabs = tabs.child(
                crate::highlights::tipped(
                    div()
                        .id(SharedString::from(format!(
                            "coordinator-tab-{}",
                            tab.title()
                        )))
                        .role(Role::Tab)
                        .cursor_pointer()
                        .pb(px(13.))
                        .text_size(px(14.))
                        .text_color(ink)
                        .when(active, |s| s.border_b_2().border_color(style::accent(cx))),
                    format!("Show the project's {}", tab.title().to_lowercase()),
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.open_coordinator_tab(tab, cx);
                }))
                .child(label),
            );
        }
        tabs.into_any_element()
    }

    pub(crate) fn render_add_coordinator(
        &mut self,
        project: &Project,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self.coordinators_on() || project.archived {
            return None;
        }
        let id = project.id.clone();
        Some(control(
            "project-add-coordinator",
            "Add a coordinator",
            "Add a coordinator that keeps this project's notes and work current",
            false,
            cx,
            cx.listener(move |this, _: &ClickEvent, window, cx| {
                this.show_coordinator_setup(&id, window, cx)
            }),
        ))
    }

    pub(crate) fn show_coordinator_setup(
        &mut self,
        project: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.coordinators.setup.is_some() {
            return;
        }
        if self.coordinators.saved_picks.is_none() {
            self.coordinators.saved_picks = Some(self.new_thread.picks.clone());
        }
        self.choose_new_thread_runner(None, true, cx);
        let composer = self.ensure_new_composer(window, cx);
        let app = cx.entity();
        let project_id = project.to_owned();
        let start_key = format!("start:{project_id}");
        self.coordinators.setup_id = self.coordinators.setup_id.wrapping_add(1);
        let setup_id = self.coordinators.setup_id;
        self.coordinators.setup_close_dialog = false;
        self.coordinators.setup_error = None;
        self.coordinators.setup = Some(project_id.clone());
        let view = cx.new(|cx| CoordinatorSetupSheet {
            id: setup_id,
            app: app.downgrade(),
            composer,
            project: project_id,
            closing: false,
            _changes: cx.observe(&app, |_, _, cx| cx.notify()),
        });
        let app_for_busy = app.downgrade();
        let app_for_close = app.downgrade();
        cx.notify();
        window.open_dialog(cx, move |dialog, _, cx| {
            let busy = app_for_busy
                .upgrade()
                .is_some_and(|a| a.read(cx).coordinators.busy.contains(&start_key));
            let close_app = app_for_close.clone();
            dialog
                .w(px(460.))
                .centered()
                .entrance(gpui_kit::component::dialog::DialogEntrance::FadeSlide)
                .p(px(22.))
                .bg(cx.theme().popover)
                .rounded(px(14.))
                .close_button(false)
                .overlay_closable(!busy)
                .keyboard(!busy)
                .child(view.clone())
                .on_close(move |_, _, cx| {
                    if let Some(app) = close_app.upgrade() {
                        app.update(cx, |this, cx| {
                            this.close_coordinator_setup(Some(setup_id), cx)
                        });
                    }
                })
        });
        crate::web_panels::keyboard_to_app(window);
    }

    pub(crate) fn render_coordinator_document(
        &mut self,
        project: &Project,
        coordinator: &Coordinator,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let memory_open = self.agent_memory_open(&project.id);
        let memory = self.render_agent_memory(project, memory_open, window, cx);
        if coordinator.task_board.is_some() {
            return self.render_editorial_brief(
                project,
                coordinator,
                memory_open,
                memory,
                window,
                cx,
            );
        }
        let work = self.render_open_loops(project, coordinator, memory_open, window, cx);
        let mut pane = v_flex()
            .id("coordinator-living-document")
            .size_full()
            .child(work);
        if !memory_open {
            pane = pane.child(
                div()
                    .id("coordinator-project-brief")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.coordinators.document_scroll)
                    .child(self.render_project_brief(project, window, cx)),
            );
        }
        pane.child(memory).into_any_element()
    }

    fn render_editorial_brief(
        &mut self,
        project: &Project,
        coordinator: &Coordinator,
        memory_open: bool,
        memory: AnyElement,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let header = h_flex()
            .flex_none()
            .w_full()
            .h(px(38.))
            .px(px(16.))
            .gap(px(7.))
            .items_center()
            .border_b_1()
            .border_color(style::hairline(cx))
            .child(
                icons::symbol("doc.plaintext")
                    .with_size(px(13.))
                    .text_color(style::secondary_text(cx)),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(cx.theme().foreground)
                    .child("Project brief"),
            );

        if memory_open {
            return v_flex()
                .id("coordinator-living-document")
                .size_full()
                .child(header)
                .child(memory)
                .into_any_element();
        }

        let mut body = v_flex()
            .w_full()
            .gap(px(16.))
            .px(px(16.))
            .py(px(16.))
            .child(self.render_text_section(project, TextField::State, window, cx))
            .child(div().w_full().h(gpui_kit::px(1.)).bg(style::hairline(cx)))
            .child(self.render_task_highlights(coordinator, cx));

        if !project.links.is_empty() {
            let text = project
                .links
                .iter()
                .map(|l| format!("[{}]({})", l.title, l.url))
                .collect::<Vec<_>>()
                .join(" · ");
            body = body
                .child(div().w_full().h(gpui_kit::px(1.)).bg(style::hairline(cx)))
                .child(
                    v_flex()
                        .w_full()
                        .gap(px(6.))
                        .child(
                            div()
                                .text_size(px(12.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(style::secondary_text(cx))
                                .child("Links"),
                        )
                        .child(crate::open_gate::reading_markdown_view(
                            SharedString::from(format!("coordinator-links-{}", project.id)),
                            text,
                            crate::open_gate::Origin::ThisMac,
                            project.folders.first().map_or("", String::as_str),
                        )),
                );
        }

        let goals = self.render_brief_goals(project, window, cx);
        v_flex()
            .id("coordinator-living-document")
            .size_full()
            .child(header)
            .child(
                div()
                    .id("coordinator-highlights-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.coordinators.document_scroll)
                    .child(body),
            )
            .child(v_flex().flex_none().w_full().child(goals).child(memory))
            .into_any_element()
    }

    fn render_brief_goals(
        &mut self,
        project: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let open = self.goals_open(&project.id);
        let editing_goals = self
            .projects
            .editing
            .as_ref()
            .is_some_and(|e| e.project == project.id && e.field == TextField::Goals);
        let project_id = project.id.clone();
        let preview = project
            .goals
            .lines()
            .find(|line| !line.trim().is_empty())
            .map(str::trim)
            .unwrap_or("Add project goals")
            .to_owned();

        let toggle = crate::highlights::tipped(
            h_flex()
                .id("coordinator-brief-goals-toggle")
                .role(Role::Button)
                .flex_none()
                .w_full()
                .items_center()
                .gap(px(8.))
                .px(px(16.))
                .py(px(10.))
                .border_t_1()
                .border_color(style::hairline(cx))
                .bg(style::primary_opacity(cx, 0.02))
                .when(!editing_goals, |s| {
                    s.cursor_pointer()
                        .hover(|s| s.bg(style::hover_fill(cx)))
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.toggle_goals(&project_id, cx)
                        }))
                }),
            if open {
                "Hide project goals"
            } else {
                "Show project goals"
            },
        )
        .child(
            icons::symbol("scope")
                .with_size(px(13.))
                .text_color(style::secondary_text(cx)),
        )
        .child(
            div()
                .flex_none()
                .text_size(px(12.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(cx.theme().foreground)
                .child("Goals"),
        )
        .when(!open, |row| {
            row.child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(11.5))
                    .text_color(style::faint_text(cx))
                    .child(format!("· {preview}")),
            )
        })
        .when(open, |row| row.child(div().flex_1()))
        .child(
            icons::symbol(if open {
                "chevron.down"
            } else {
                "chevron.right"
            })
            .with_size(px(12.))
            .text_color(style::faint_text(cx)),
        );

        if !open {
            return toggle.into_any_element();
        }
        v_flex()
            .flex_none()
            .w_full()
            .child(toggle)
            .child(
                div()
                    .w_full()
                    .px(px(16.))
                    .pb(px(14.))
                    .bg(style::primary_opacity(cx, 0.02))
                    .child(self.render_text_section(project, TextField::Goals, window, cx)),
            )
            .into_any_element()
    }

    fn render_open_loops(
        &mut self,
        project: &Project,
        coordinator: &Coordinator,
        memory_open: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // Decisions waiting on Mike are answered on the Needs you card under the
        // conversation, so this pane only mirrors that card's live asks, read
        // only. The runner's waiting_on_user loops stay out of it: once the card
        // moves on they'd linger here with nowhere to answer them.
        let open_loops: Vec<Loop> = coordinator
            .open_loops()
            .into_iter()
            .filter(|l| !l.waiting_on_user())
            .cloned()
            .collect();
        let signoff = coordinator.signoff_count();
        let asks = self
            .threads
            .get(&coordinator.thread_id)
            .and_then(|t| t.asks.clone())
            .unwrap_or_default();
        let total_waiting = asks.len();

        let pin_color = if total_waiting > 0 {
            style::needs_you_text(cx)
        } else if signoff > 0 {
            style::added_text(cx)
        } else {
            style::secondary_text(cx)
        };

        // Wraps so a narrow pane drops the second count onto its own line
        // rather than pushing it past the edge.
        let mut header = h_flex()
            .w_full()
            .flex_wrap()
            .items_center()
            .gap(px(7.))
            .child(
                icons::symbol("pin")
                    .with_size(px(13.))
                    .text_color(pin_color),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(cx.theme().foreground)
                    .child("Open loops"),
            )
            .child(div().flex_1());

        if total_waiting > 0 {
            header = header.child(count_pill(
                format!("{total_waiting} waiting on you"),
                amber_pill_bg(cx),
                amber_card_border(cx),
                style::needs_you_text(cx),
            ));
        }
        if signoff > 0 {
            header = header.child(count_pill(
                format!("{signoff} to sign off"),
                style::added_line_bg(cx),
                green_card_border(cx),
                style::added_text(cx),
            ));
        }
        if open_loops.is_empty() && asks.is_empty() {
            header = header.child(
                div()
                    .text_size(px(11.))
                    .text_color(style::faint_text(cx))
                    .child("All caught up"),
            );
        }

        let mut zone = v_flex()
            .flex_none()
            .w_full()
            .gap(px(8.))
            .px(px(14.))
            .py(px(11.))
            .border_b_1()
            .border_color(style::hairline(cx))
            .child(header);

        if let Some(banner) = self.render_loop_undo_banner(project, cx) {
            zone = zone.child(banner);
        }

        if memory_open {
            return self
                .append_collapsed_loops(zone, project, &open_loops, asks.len(), window, cx)
                .into_any_element();
        }

        if !open_loops.is_empty() || !asks.is_empty() {
            let mut list = v_flex().w_full().gap(px(7.));
            for (index, ask) in asks.into_iter().enumerate() {
                list = list.child(self.render_waiting_row(index, ask.action, cx));
            }
            for item in &open_loops {
                list = list.child(self.render_loop_card(project, item, window, cx));
            }
            zone = zone.child(
                div()
                    .id("coordinator-open-loops-list")
                    .w_full()
                    .max_h(px(450.))
                    .overflow_y_scroll()
                    .track_scroll(&self.coordinators.loops_scroll)
                    .child(list),
            );
        }

        zone.into_any_element()
    }

    fn render_loop_undo_banner(
        &self,
        project: &Project,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let undo = self
            .coordinators
            .undo_loop
            .as_ref()
            .filter(|u| u.project_id == project.id)?;
        let undo_project = undo.project_id.clone();
        let undo_id = undo.loop_id.clone();
        let undo_title = truncate_label(&undo.title, 34);
        let undo_busy = self
            .coordinators
            .busy
            .contains(&format!("loop:{}", undo.loop_id));
        Some(
            h_flex()
                .id("coordinator-loop-undo-banner")
                .w_full()
                .items_center()
                .gap(px(8.))
                .px(px(10.))
                .py(px(7.))
                .rounded(px(8.))
                .bg(style::added_line_bg(cx))
                .border_1()
                .border_color(green_card_border(cx))
                .child(
                    icons::symbol("checkmark")
                        .with_size(px(12.))
                        .text_color(style::added_text(cx)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(12.))
                        .text_color(style::added_text(cx))
                        .child(format!("Closed \"{undo_title}\"")),
                )
                .child(
                    crate::highlights::tipped(
                        h_flex()
                            .id("coordinator-loop-undo")
                            .role(Role::Button)
                            .flex_none()
                            .gap(px(4.))
                            .items_center()
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(5.))
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(cx.theme().foreground)
                            .when(!undo_busy, |s| {
                                s.cursor_pointer()
                                    .hover(|s| s.bg(style::hover_fill(cx)))
                                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                        this.reopen_coordinator_loop(&undo_project, &undo_id, cx)
                                    }))
                            })
                            .when(undo_busy, |s| {
                                s.child(
                                    Spinner::new()
                                        .with_size(px(11.))
                                        .color(style::secondary_text(cx)),
                                )
                            }),
                        "Reopen this closed loop",
                    )
                    .child("Undo"),
                )
                .child(
                    crate::highlights::tipped(
                        div()
                            .id("coordinator-loop-undo-dismiss")
                            .role(Role::Button)
                            .flex_none()
                            .cursor_pointer()
                            .p(px(2.))
                            .rounded(px(4.))
                            .hover(|s| s.bg(style::hover_fill(cx)))
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                                this.dismiss_undo_loop(cx)
                            })),
                        "Dismiss this undo notice",
                    )
                    .child(
                        icons::symbol("xmark")
                            .with_size(px(11.))
                            .text_color(style::secondary_text(cx)),
                    ),
                )
                .into_any_element(),
        )
    }

    fn append_collapsed_loops(
        &mut self,
        mut zone: Div,
        project: &Project,
        open_loops: &[Loop],
        waiting: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let active_reply_id = self
            .coordinators
            .replying_loop
            .as_ref()
            .filter(|draft| draft.project_id == project.id)
            .map(|draft| draft.loop_id.clone());
        let mut hidden_signoff = open_loops.iter().filter(|l| l.needs_signoff()).count();
        let mut hidden_checking = open_loops.iter().filter(|l| l.checking()).count();
        if let Some(reply_id) = active_reply_id {
            if let Some(item) = open_loops.iter().find(|l| l.id == reply_id) {
                if item.needs_signoff() {
                    hidden_signoff = hidden_signoff.saturating_sub(1);
                } else if item.checking() {
                    hidden_checking = hidden_checking.saturating_sub(1);
                }
                zone = zone.child(self.render_loop_card(project, item, window, cx));
            }
        }
        let mut parts = Vec::new();
        if hidden_signoff > 0 {
            parts.push(format!("{hidden_signoff} to sign off"));
        }
        if waiting > 0 {
            parts.push(format!(
                "{waiting} decision{}",
                if waiting == 1 { "" } else { "s" }
            ));
        }
        if hidden_checking > 0 {
            parts.push(format!("{hidden_checking} checking"));
        }
        if !parts.is_empty() {
            zone = zone.child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(11.5))
                    .child(
                        div()
                            .flex_none()
                            .text_color(style::secondary_text(cx))
                            .child(parts.join(" · ")),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_right()
                            .text_color(style::faint_text(cx))
                            .child("Collapsed while inspecting memory"),
                    ),
            );
        }
        zone
    }

    /// One decision from the coordinator's Needs you card, mirrored read only:
    /// clicking it takes you to the card, where it's answered.
    fn render_waiting_row(
        &self,
        index: usize,
        action: String,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        crate::highlights::tipped(
            h_flex()
                .id(SharedString::from(format!("coordinator-question-{index}")))
                .role(Role::Button)
                .w_full()
                .items_center()
                .gap(px(8.))
                .px(px(11.))
                .py(px(8.))
                .rounded(px(9.))
                .bg(amber_card_bg(cx))
                .border_1()
                .border_color(amber_card_border(cx))
                .cursor_pointer()
                .hover(|s| s.bg(style::hover_fill(cx)))
                .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                    this.jump_to_coordinator_loop(None, window, cx);
                })),
            "Answer this on the Needs you card",
        )
        .child(status_dot(style::needs_you_text(cx)))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(12.5))
                .line_height(px(17.))
                .text_color(cx.theme().foreground)
                .child(action),
        )
        .child(
            div()
                .flex_none()
                .text_size(px(11.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(style::needs_you_text(cx))
                .child("Answer below"),
        )
        .into_any_element()
    }

    fn render_loop_card(
        &mut self,
        project: &Project,
        item: &Loop,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let busy = self
            .coordinators
            .busy
            .contains(&format!("loop:{}", item.id));
        if item.checking() {
            return self.render_checking_loop_row(project, item, busy, cx);
        }

        // Waiting-on-you loops never get here (render_open_loops mirrors the
        // Needs you card instead), so what's left is an answered question.
        let (bar_color, bg_color, border_color, status_color, status_text) = (
            style::tick_green(cx),
            green_card_bg(cx),
            green_card_border(cx),
            style::added_text(cx),
            "Your question · Answered",
        );

        let mut body = v_flex()
            .flex_1()
            .min_w_0()
            .px(px(11.))
            .py(px(8.))
            .gap(px(5.))
            .child(
                h_flex()
                    .items_center()
                    .gap(px(6.))
                    .child(status_dot(bar_color))
                    .child(
                        div()
                            .text_size(px(11.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(status_color)
                            .child(status_text),
                    ),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .line_height(px(18.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(cx.theme().foreground)
                    .child(item.title.clone()),
            );

        if let Some(summary) = item.summary.as_ref() {
            body = body.child(
                div()
                    .text_size(px(12.))
                    .line_height(px(17.))
                    .text_color(style::secondary_text(cx))
                    .child(summary.clone()),
            );
        }

        body = body.child(self.render_loop_actions(project, item, busy, cx));

        if let Some(input) = self
            .coordinators
            .replying_loop
            .as_ref()
            .filter(|draft| draft.project_id == project.id && draft.loop_id == item.id)
            .map(|draft| draft.input.clone())
        {
            body = body.child(self.render_loop_reply_input(&item.id, input, busy, cx));
        }

        h_flex()
            .id(SharedString::from(format!("coordinator-loop-{}", item.id)))
            .w_full()
            .rounded(px(9.))
            .overflow_hidden()
            .bg(bg_color)
            .border_1()
            .border_color(border_color)
            .child(div().w(px(3.)).flex_none().bg(bar_color))
            .child(body)
            .into_any_element()
    }

    fn render_checking_loop_row(
        &self,
        project: &Project,
        item: &Loop,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let close_project = project.id.clone();
        let close_id = item.id.clone();
        let close_title = item.title.clone();
        h_flex()
            .id(SharedString::from(format!("coordinator-loop-{}", item.id)))
            .w_full()
            .items_center()
            .gap(px(8.))
            .px(px(11.))
            .py(px(8.))
            .rounded(px(9.))
            .bg(style::card_background(cx))
            .border_1()
            .border_color(style::card_border(cx))
            .child(status_dot(style::status_progress(cx)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(12.5))
                    .line_height(px(17.))
                    .text_color(cx.theme().foreground)
                    .child(item.title.clone()),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(px(11.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(style::status_progress(cx))
                    .child("Checking…"),
            )
            .child(
                crate::highlights::tipped(
                    div()
                        .id(SharedString::from(format!("loop-close-{}", item.id)))
                        .role(Role::Button)
                        .flex_none()
                        .p(px(2.))
                        .rounded(px(4.))
                        .when(!busy, |s| {
                            s.cursor_pointer()
                                .hover(|s| s.bg(style::hover_fill(cx)))
                                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                    this.close_coordinator_loop(
                                        &close_project,
                                        &close_id,
                                        close_title.clone(),
                                        cx,
                                    )
                                }))
                        }),
                    "Close this open question",
                )
                .child(if busy {
                    Spinner::new()
                        .with_size(px(11.))
                        .color(style::secondary_text(cx))
                        .into_any_element()
                } else {
                    icons::symbol("xmark")
                        .with_size(px(11.))
                        .text_color(style::faint_text(cx))
                        .into_any_element()
                }),
            )
            .into_any_element()
    }

    fn render_loop_actions(
        &self,
        project: &Project,
        item: &Loop,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project_id = project.id.clone();
        let loop_id = item.id.clone();
        let source_seq = item.source_seq;
        let jump_button = crate::highlights::tipped(
            h_flex()
                .id(SharedString::from(format!("loop-jump-{loop_id}")))
                .role(Role::Button)
                .flex_none()
                .items_center()
                .gap(px(3.))
                .px(px(4.))
                .py(px(2.))
                .rounded(px(4.))
                .cursor_pointer()
                .text_size(px(11.5))
                .text_color(style::secondary_text(cx))
                .hover(|s| s.bg(style::hover_fill(cx)))
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    this.jump_to_coordinator_loop(source_seq, window, cx)
                })),
            "Jump to this answer in the conversation",
        )
        .child("Jump")
        .child(
            icons::symbol("arrow.up.right")
                .with_size(px(11.))
                .text_color(style::faint_text(cx)),
        );

        let close_project = project_id.clone();
        let close_id = loop_id.clone();
        let close_title = item.title.clone();
        let follow_project = project_id;
        let follow_id = loop_id.clone();
        h_flex()
            .w_full()
            .flex_wrap()
            .items_center()
            .gap(px(6.))
            .pt(px(2.))
            .child(loop_button(
                SharedString::from(format!("loop-close-{loop_id}")),
                ButtonSpec {
                    icon: Some("checkmark"),
                    label: "Got it, close",
                    tip: "Mark this question answered and close it",
                    tone: ButtonTone::green(cx),
                    busy,
                },
                cx,
                cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.close_coordinator_loop(&close_project, &close_id, close_title.clone(), cx)
                }),
            ))
            .child(loop_button(
                SharedString::from(format!("loop-followup-{loop_id}")),
                ButtonSpec {
                    icon: None,
                    label: "Follow up",
                    tip: "Ask a follow-up on this question",
                    tone: ButtonTone::neutral(cx),
                    busy,
                },
                cx,
                cx.listener(move |this, _: &ClickEvent, window, cx| {
                    this.start_reply_coordinator_loop(
                        &follow_project,
                        &follow_id,
                        false,
                        "Ask a follow-up…",
                        window,
                        cx,
                    )
                }),
            ))
            .child(div().flex_1())
            .child(jump_button)
            .into_any_element()
    }

    fn render_loop_reply_input(
        &self,
        loop_id: &str,
        input: Entity<gpui_kit::component::input::InputState>,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        h_flex()
            .w_full()
            .items_center()
            .gap(px(6.))
            .pt(px(4.))
            .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| {
                if ev.keystroke.key == "escape" {
                    this.cancel_reply_coordinator_loop(cx);
                    cx.stop_propagation();
                } else if ev.keystroke.key == "enter" && !ev.keystroke.modifiers.shift {
                    this.submit_reply_coordinator_loop(cx);
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(Input::new(&input).text_size(px(12.))),
            )
            .child(loop_button(
                SharedString::from(format!("loop-reply-send-{loop_id}")),
                ButtonSpec {
                    icon: None,
                    label: "Send",
                    tip: "Send this reply to the coordinator",
                    tone: ButtonTone::amber(cx),
                    busy,
                },
                cx,
                cx.listener(|this, _: &ClickEvent, _, cx| this.submit_reply_coordinator_loop(cx)),
            ))
            .child(
                crate::highlights::tipped(
                    div()
                        .id(SharedString::from(format!("loop-reply-cancel-{loop_id}")))
                        .role(Role::Button)
                        .flex_none()
                        .cursor_pointer()
                        .p(px(4.))
                        .rounded(px(5.))
                        .hover(|s| s.bg(style::hover_fill(cx)))
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                            this.cancel_reply_coordinator_loop(cx)
                        })),
                    "Cancel replying to this loop",
                )
                .child(
                    icons::symbol("xmark")
                        .with_size(px(12.))
                        .text_color(style::secondary_text(cx)),
                ),
            )
            .into_any_element()
    }

    fn render_project_brief(
        &mut self,
        project: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut brief = v_flex()
            .w_full()
            .gap(px(18.))
            .px(px(16.))
            .pt(px(14.))
            .pb(px(22.))
            .child(
                div()
                    .text_size(px(15.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(cx.theme().foreground)
                    .child("Project brief"),
            )
            .child(self.render_text_section(project, TextField::State, window, cx))
            .child(self.render_text_section(project, TextField::Goals, window, cx));

        if !project.links.is_empty() {
            let text = project
                .links
                .iter()
                .map(|l| format!("[{}]({})", l.title, l.url))
                .collect::<Vec<_>>()
                .join(" · ");
            brief = brief.child(crate::open_gate::reading_markdown_view(
                SharedString::from(format!("coordinator-links-{}", project.id)),
                text,
                crate::open_gate::Origin::ThisMac,
                project.folders.first().map_or("", String::as_str),
            ));
        }

        brief.into_any_element()
    }

    fn render_agent_memory(
        &mut self,
        project: &Project,
        open: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let sections = note_sections(&project.notes);
        let count = sections.len();
        let count_label = if count == 0 {
            "No notes yet".to_owned()
        } else {
            format!("{count} note{}", if count == 1 { "" } else { "s" })
        };
        if !open {
            return self.render_collapsed_agent_memory(project, &sections, &count_label, cx);
        }

        let project_id = project.id.clone();
        let editing_notes = self
            .projects
            .editing
            .as_ref()
            .is_some_and(|e| e.project == project.id && e.field == TextField::Notes);

        let header = h_flex()
            .flex_none()
            .w_full()
            .items_center()
            .gap(px(8.))
            .px(px(16.))
            .py(px(11.))
            .bg(style::primary_opacity(cx, 0.02))
            .child(
                icons::symbol("cpu")
                    .with_size(px(14.))
                    .text_color(style::secondary_text(cx)),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(cx.theme().foreground)
                    .child("Agent memory"),
            )
            .child(div().flex_1())
            .child(
                crate::highlights::tipped(
                    h_flex()
                        .id("coordinator-agent-memory-toggle")
                        .role(Role::Button)
                        .flex_none()
                        .items_center()
                        .gap(px(4.))
                        .px(px(9.))
                        .py(px(4.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(style::hairline(cx))
                        .bg(style::primary_opacity(cx, 0.05))
                        .text_size(px(11.5))
                        .text_color(cx.theme().foreground)
                        .when(!editing_notes, |s| {
                            s.cursor_pointer()
                                .hover(|s| s.bg(style::hover_fill(cx)))
                                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                    this.toggle_agent_memory(&project_id, cx)
                                }))
                        }),
                    if editing_notes {
                        "Save or cancel your note edits before hiding agent memory"
                    } else {
                        "Hide agent memory notes"
                    },
                )
                .child("Hide")
                .child(
                    icons::symbol("chevron.down")
                        .with_size(px(12.))
                        .text_color(style::secondary_text(cx)),
                ),
            );

        let body = if editing_notes {
            v_flex()
                .w_full()
                .gap(px(10.))
                .px(px(16.))
                .pb(px(18.))
                .child(self.render_text_section(project, TextField::Notes, window, cx))
        } else {
            self.render_memory_note_cards(project, sections, cx)
        };

        v_flex()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(header)
            .child(
                div()
                    .id("coordinator-agent-memory-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.coordinators.memory_scroll)
                    .child(body),
            )
            .into_any_element()
    }

    fn render_collapsed_agent_memory(
        &self,
        project: &Project,
        sections: &[(Option<String>, String)],
        count_label: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project_id = project.id.clone();
        let preview_titles: Vec<&str> = sections
            .iter()
            .filter_map(|(heading, _)| heading.as_deref())
            .take(3)
            .collect();
        let preview = preview_titles.join(", ");
        crate::highlights::tipped(
            h_flex()
                .id("coordinator-agent-memory-toggle")
                .role(Role::Button)
                .flex_none()
                .w_full()
                .items_center()
                .gap(px(8.))
                .px(px(16.))
                .py(px(12.))
                .border_t_1()
                .border_color(style::hairline(cx))
                .bg(style::primary_opacity(cx, 0.02))
                .cursor_pointer()
                .hover(|s| s.bg(style::hover_fill(cx)))
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.toggle_agent_memory(&project_id, cx)
                })),
            "Show agent memory notes",
        )
        .child(
            icons::symbol("cpu")
                .with_size(px(14.))
                .text_color(style::secondary_text(cx)),
        )
        .child(
            div()
                .flex_none()
                .text_size(px(12.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(cx.theme().foreground)
                .child("Agent memory"),
        )
        // The count never truncates; only the note titles after it give way
        // when the pane is narrow.
        .child(
            div()
                .flex_none()
                .text_size(px(11.5))
                .text_color(style::secondary_text(cx))
                .child(format!("· {count_label}")),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(11.5))
                .text_color(style::faint_text(cx))
                .child(preview),
        )
        .child(
            h_flex()
                .flex_none()
                .items_center()
                .gap(px(4.))
                .text_size(px(11.5))
                .text_color(style::secondary_text(cx))
                .child("Show")
                .child(
                    icons::symbol("chevron.up")
                        .with_size(px(12.))
                        .text_color(style::faint_text(cx)),
                ),
        )
        .into_any_element()
    }

    fn render_memory_note_cards(
        &self,
        project: &Project,
        sections: Vec<(Option<String>, String)>,
        cx: &mut Context<Self>,
    ) -> Div {
        let edit_project = project.id.clone();
        let mut body = v_flex()
            .w_full()
            .gap(px(10.))
            .px(px(16.))
            .pb(px(18.))
            .child(
            h_flex()
                .w_full()
                .items_center()
                .gap(px(8.))
                .px(px(11.))
                .py(px(8.))
                .rounded(px(8.))
                .bg(style::card_background(cx))
                .border_1()
                .border_color(style::card_border(cx))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(11.5))
                        .text_color(style::secondary_text(cx))
                        .child(
                            "Read and written by coordinator and helpers · hidden from your brief",
                        ),
                )
                .child(
                    crate::highlights::tipped(
                        div()
                            .id("edit-Notes")
                            .role(Role::Button)
                            .flex_none()
                            .cursor_pointer()
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(5.))
                            .text_size(px(11.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(style::needs_you_text(cx))
                            .hover(|s| s.bg(style::hover_fill(cx)))
                            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                                this.start_editing_project(
                                    &edit_project,
                                    TextField::Notes,
                                    window,
                                    cx,
                                )
                            })),
                        "Edit the notes (or double-click it)",
                    )
                    .child("Edit raw"),
                ),
        );

        if sections.is_empty() {
            let empty_project = project.id.clone();
            return body.child(
                div()
                    .id("coordinator-memory-empty")
                    .role(Role::Button)
                    .w_full()
                    .px(px(12.))
                    .py(px(12.))
                    .rounded(px(9.))
                    .bg(style::card_background(cx))
                    .border_1()
                    .border_color(style::card_border(cx))
                    .text_size(px(12.5))
                    .line_height(px(18.))
                    .text_color(style::faint_text(cx))
                    .on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
                        if ev.click_count() == 2 {
                            this.start_editing_project(&empty_project, TextField::Notes, window, cx);
                        }
                    }))
                    .child(
                        "Technical notes from the coordinator and helpers appear here. Double-click to edit.",
                    ),
            );
        }

        let base = project.folders.first().cloned().unwrap_or_default();
        for (index, (section_title, section_body)) in sections.into_iter().enumerate() {
            let card_project = project.id.clone();
            let mut card = v_flex()
                .id(SharedString::from(format!(
                    "coordinator-memory-card-{index}"
                )))
                .role(Role::Button)
                .w_full()
                .gap(px(6.))
                .px(px(12.))
                .py(px(10.))
                .rounded(px(9.))
                .bg(style::card_background(cx))
                .border_1()
                .border_color(style::card_border(cx))
                .on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
                    if ev.click_count() == 2 {
                        this.start_editing_project(&card_project, TextField::Notes, window, cx);
                    }
                }));
            if let Some(title) = section_title {
                card = card.child(
                    div()
                        .text_size(px(12.5))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(cx.theme().foreground)
                        .child(title),
                );
            }
            if !section_body.is_empty() {
                let view = crate::open_gate::reading_markdown_view(
                    SharedString::from(format!("coordinator-memory-{}-{index}", project.id)),
                    section_body,
                    crate::open_gate::Origin::ThisMac,
                    &base,
                )
                .style(crate::rows::reading_style(cx));
                card = card.child(
                    div()
                        .w_full()
                        .text_size(px(12.))
                        .line_height(px(18.))
                        .child(view),
                );
            }
            body = body.child(card);
        }
        body
    }

    fn render_coordinator_activity(
        &mut self,
        coordinator: &Coordinator,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if let Some(sub) = self.subagent_pane.clone() {
            return v_flex()
                .size_full()
                .child(self.render_subagent_header(cx))
                .child(div().flex_1().min_h_0().child(sub))
                .into_any_element();
        }
        let mut list = v_flex()
            .w_full()
            .gap(px(22.))
            .p(px(28.))
            .child(heading("Activity", cx));
        let helpers = self
            .threads
            .get(&coordinator.thread_id)
            .and_then(|t| t.subagents.clone())
            .unwrap_or_default();
        if helpers.is_empty() {
            list = list.child(
                div()
                    .text_size(px(13.))
                    .text_color(style::secondary_text(cx))
                    .child("Helper results appear here as the coordinator works."),
            );
        }
        for helper in helpers.iter().rev() {
            let Some(id) = helper["id"].as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            let thread = coordinator.thread_id.clone();
            let id = id.to_owned();
            let title = helper["description"].as_str().unwrap_or("Helper");
            let state = helper["status"].as_str().unwrap_or("");
            let mut row = v_flex()
                .w_full()
                .gap(px(7.))
                .pb(px(18.))
                .border_b_1()
                .border_color(cx.theme().border)
                .child(div().text_size(px(14.)).child(title.to_owned()))
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(style::secondary_text(cx))
                        .child(state.to_owned()),
                );
            if let Some(summary) = helper["summary"].as_str() {
                row = row.child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(20.))
                        .child(summary.to_owned()),
                );
            }
            row = row.child(control(
                SharedString::from(format!("coordinator-helper-{id}")),
                "Read helper messages",
                "Inspect this helper's conversation",
                false,
                cx,
                cx.listener(move |this, _: &ClickEvent, window, cx| {
                    this.open_subagent(thread.clone(), id.clone(), window, cx)
                }),
            ));
            list = list.child(row);
        }
        div()
            .id("coordinator-activity")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.coordinators.work_scroll)
            .child(list)
            .into_any_element()
    }

    pub(crate) fn coordinator_dump(&self, cx: &App) -> Value {
        let project = self.open_project();
        let current = project.and_then(|p| self.coordinator_for_project(&p.id));
        let highlights = crate::shell::HIGHLIGHTS;
        let document_shown = current.is_some()
            && self.panel_available(highlights, cx)
            && self.dock.read(cx).is_showing(highlights)
            && self
                .side
                .read(cx)
                .drawn
                .get(highlights)
                .is_some_and(|kind| kind == "project");
        let editing = self.projects.editing.as_ref().map(|e| {
            let current = self.project(&e.project).map(|p| e.field.text(p).to_owned());
            json!({"field":e.field.title(),"draft":e.input.read(cx).value().to_string(),"reviewCurrent":current.filter(|text| !e.saving && *text != e.baseline)})
        });
        let agent_memory_open = project.is_some_and(|p| self.agent_memory_open(&p.id));
        let undo_loop = self.coordinators.undo_loop.as_ref().map(|u| {
            json!({
                "projectId": u.project_id,
                "loopId": u.loop_id,
                "title": u.title,
            })
        });
        let loops = current.map(|c| {
            c.loops
                .iter()
                .map(|l| {
                    json!({
                        "id": l.id,
                        "kind": match l.kind {
                            LoopKind::UserQuestion => "user_question",
                            LoopKind::WaitingOnUser => "waiting_on_user",
                        },
                        "state": match l.state {
                            LoopState::Open => "open",
                            LoopState::Answered => "answered",
                            LoopState::Closed => "closed",
                        },
                        "title": l.title,
                        "summary": l.summary,
                        "options": l.options,
                        "sourceSeq": l.source_seq,
                    })
                })
                .collect::<Vec<_>>()
        });
        json!({
            "on": self.coordinators_on(),
            "count": self.coordinators.list.len(),
            "tab": self.coordinators.tab.title(),
            "setup": self.coordinators.setup.clone(),
            "project": current.map(|c| c.project_id.clone()),
            "thread": current.map(|c| c.thread_id.clone()),
            "state": current.map(|c| if c.state == State::Paused { "paused" } else { "active" }),
            "tasks": current.map(|c| c.tasks.iter().map(|t| json!({"title": t.title, "state": t.status_label()})).collect::<Vec<_>>()),
            "taskDetailsBounds": current.and_then(|c| self.task_details_bounds(&c.project_id)),
            "taskBoard": current.and_then(|c| c.task_board.as_deref()).map(|board| {
                json!({
                    "workItems": board.groups().into_iter().filter_map(|group| {
                        let item = group.item?;
                        let progress = group.progress();
                        Some(json!({
                            "id": item.id, "collapsed": item.collapsed,
                            "done": progress.done, "total": progress.total,
                        }))
                    }).collect::<Vec<_>>(),
                    "tasks": board.tasks.iter().map(|task| json!({
                        "id": task.id, "title": task.title, "state": task.state.label(),
                        "mark": task.mark().glyph(), "parentTaskId": task.parent_task_id,
                        "canReopen": task.can_reopen,
                    })).collect::<Vec<_>>(),
                    "sending": current.is_some_and(|c| self.task_request_sending(&c.project_id)),
                })
            }),
            "loops": loops,
            // What Open loops draws: the Needs you card's asks plus the
            // questions it's checking or has answered.
            "openLoopsCount": current.map(|c| {
                let asks = self
                    .threads
                    .get(&c.thread_id)
                    .and_then(|t| t.asks.as_ref())
                    .map_or(0, Vec::len);
                asks + c.open_loops().iter().filter(|l| !l.waiting_on_user()).count()
            }),
            "agentMemoryOpen": agent_memory_open,
            "undoLoop": undo_loop,
            "documentShown": document_shown,
            "editing": editing,
            "document": project.map(|p| json!({"goals": p.goals, "state": p.state, "notes": p.notes})),
        })
    }
}

/// Centered dialog sheet for adding a coordinator to a project. Renders as a
/// child view so its composer can read the app cleanly outside the app render.
struct CoordinatorSetupSheet {
    id: u64,
    app: WeakEntity<Threadbear>,
    composer: Entity<crate::composer::Composer>,
    project: String,
    closing: bool,
    _changes: Subscription,
}

impl Render for CoordinatorSetupSheet {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(app_entity) = self.app.upgrade() else {
            return div().into_any_element();
        };
        let (active, close_now, project, busy, error) = {
            let app = app_entity.read(cx);
            let same = app.coordinators.setup_id == self.id;
            let active = same
                && app.coordinators_on()
                && app.coordinators.setup.as_deref() == Some(self.project.as_str());
            let close_now = same && app.coordinators.setup_close_dialog;
            let project = app.project(&self.project).cloned();
            let busy = app
                .coordinators
                .busy
                .contains(&format!("start:{}", self.project));
            let error = app.coordinators.setup_error.clone();
            (active, close_now, project, busy, error)
        };
        if !active {
            if close_now && !self.closing {
                self.closing = true;
                let id = self.id;
                let app = self.app.clone();
                window.defer(cx, move |window, cx| {
                    let should_close = app.upgrade().is_some_and(|a| {
                        a.update(cx, |this, _| {
                            if this.coordinators.setup_id == id
                                && this.coordinators.setup_close_dialog
                            {
                                this.coordinators.setup_close_dialog = false;
                                true
                            } else {
                                false
                            }
                        })
                    });
                    if should_close {
                        window.close_dialog(cx);
                    }
                });
            }
            return div().into_any_element();
        }
        let title = project
            .as_ref()
            .map_or_else(|| "project".to_owned(), |p| p.title.clone());
        let icon = project_icon(project.as_ref(), &title, 36., cx);
        let picker = self.composer.update(cx, |composer, cx| {
            composer.render_coordinator_picker(busy, window, cx)
        });
        let cancel_tip = "Keep the project as it is";
        let add_tip = "Start this project's coordinator using the chosen pool and model";
        v_flex()
            .id("coordinator-setup-sheet")
            .w_full()
            .gap(px(18.))
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .gap(px(12.))
                    .child(icon)
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(4.))
                            .child(
                                div()
                                    .text_size(px(15.))
                                    .line_height(px(20.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(cx.theme().foreground)
                                    .child(format!("Add a {title} coordinator")),
                            )
                            .child(
                                div()
                                    .text_size(px(size::LABEL))
                                    .line_height(px(18.))
                                    .text_color(style::secondary_text(cx))
                                    .child("Starts from this project's goals, state and notes. Helpers report here, and it brings you decisions that need you."),
                            ),
                    ),
            )
            .child(picker)
            .when_some(error, |s, message| {
                s.child(
                    div()
                        .pl(px(60.))
                        .text_size(px(size::DETAIL))
                        .line_height(px(17.))
                        .text_color(style::failed(cx))
                        .child(message),
                )
            })
            .child(
                h_flex()
                    .w_full()
                    .justify_end()
                    .items_center()
                    .gap(px(8.))
                    .pt(px(2.))
                    .child(
                        div()
                            .id("coordinator-cancel-add")
                            .test_support()
                            .a11y_role(Role::GenericContainer)
                            .aria_label(cancel_tip.to_owned())
                            .child(
                                Button::new("coordinator-cancel-add-button")
                                    .label("Cancel")
                                    .outline()
                                    .disabled(busy)
                                    .tooltip(cancel_tip)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.closing = true;
                                        window.close_dialog(cx);
                                        if let Some(app) = this.app.upgrade() {
                                            let id = this.id;
                                            app.update(cx, |app, cx| {
                                                app.close_coordinator_setup(Some(id), cx)
                                            });
                                        }
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .id("coordinator-confirm-add")
                            .test_support()
                            .a11y_role(Role::GenericContainer)
                            .aria_label(add_tip.to_owned())
                            .child(
                                Button::new("coordinator-confirm-add-button")
                                    .label("Add coordinator")
                                    .primary()
                                    .loading(busy)
                                    .disabled(busy)
                                    .tooltip(add_tip)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        if let Some(app) = this.app.upgrade() {
                                            let project_id = this.project.clone();
                                            let id = this.id;
                                            app.update(cx, |app, cx| {
                                                app.start_coordinator(&project_id, id, window, cx)
                                            });
                                        }
                                    })),
                            ),
                    ),
            )
            .into_any_element()
    }
}

fn heading(text: &str, cx: &App) -> AnyElement {
    div()
        .text_size(px(14.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(cx.theme().foreground)
        .child(text.to_owned())
        .into_any_element()
}

fn status_dot(color: Hsla) -> Div {
    div().size(px(6.)).flex_none().rounded_full().bg(color)
}

fn count_pill(label: String, bg: Hsla, border: Hsla, fg: Hsla) -> AnyElement {
    div()
        .flex_none()
        .px(px(8.))
        .py(px(2.))
        .rounded_full()
        .bg(bg)
        .border_1()
        .border_color(border)
        .text_size(px(11.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .child(label)
        .into_any_element()
}

struct ButtonTone {
    bg: Hsla,
    border: Hsla,
    fg: Hsla,
}

impl ButtonTone {
    fn green(cx: &App) -> Self {
        Self {
            bg: style::added_line_bg(cx),
            border: green_card_border(cx),
            fg: style::added_text(cx),
        }
    }

    fn amber(cx: &App) -> Self {
        Self {
            bg: amber_pill_bg(cx),
            border: amber_card_border(cx),
            fg: style::needs_you_text(cx),
        }
    }

    fn neutral(cx: &App) -> Self {
        Self {
            bg: style::primary_opacity(cx, 0.06),
            border: style::hairline(cx),
            fg: cx.theme().foreground,
        }
    }
}

struct ButtonSpec<'a> {
    icon: Option<&'static str>,
    label: &'a str,
    tip: &'a str,
    tone: ButtonTone,
    busy: bool,
}

fn loop_button(
    id: impl Into<ElementId>,
    spec: ButtonSpec<'_>,
    cx: &App,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let fg = spec.tone.fg;
    crate::highlights::tipped(
        h_flex()
            .id(id)
            .role(Role::Button)
            .flex_none()
            .items_center()
            .gap(px(4.))
            .px(px(8.))
            .py(px(3.5))
            .rounded(px(6.))
            .bg(spec.tone.bg)
            .border_1()
            .border_color(spec.tone.border)
            .text_size(px(11.5))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .when(!spec.busy, |s| {
                s.cursor_pointer()
                    .hover(|s| s.opacity(0.88))
                    .on_click(on_click)
            })
            .when(spec.busy, |s| {
                s.child(
                    Spinner::new()
                        .with_size(px(11.))
                        .color(style::secondary_text(cx)),
                )
            })
            .when(!spec.busy, |s| {
                s.when_some(spec.icon, |s, name| {
                    s.child(icons::symbol(name).with_size(px(11.)).text_color(fg))
                })
            }),
        spec.tip.to_owned(),
    )
    .child(spec.label.to_owned())
    .into_any_element()
}

fn truncate_label(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        text.to_owned()
    } else {
        let mut out: String = text.chars().take(max_chars.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

fn rgba_hsla(r: f32, g: f32, b: f32, a: f32) -> Hsla {
    Hsla::from(Rgba { r, g, b, a })
}

fn green_card_bg(cx: &App) -> Hsla {
    if cx.theme().is_dark() {
        rgba_hsla(0.16, 0.65, 0.34, 0.08)
    } else {
        rgba_hsla(0.10, 0.56, 0.25, 0.06)
    }
}

fn green_card_border(cx: &App) -> Hsla {
    if cx.theme().is_dark() {
        rgba_hsla(0.24, 0.78, 0.42, 0.28)
    } else {
        rgba_hsla(0.12, 0.58, 0.28, 0.26)
    }
}

fn amber_card_bg(cx: &App) -> Hsla {
    if cx.theme().is_dark() {
        rgba_hsla(0.95, 0.62, 0.12, 0.07)
    } else {
        rgba_hsla(0.85, 0.48, 0.04, 0.06)
    }
}

fn amber_pill_bg(cx: &App) -> Hsla {
    if cx.theme().is_dark() {
        rgba_hsla(0.95, 0.62, 0.12, 0.14)
    } else {
        rgba_hsla(0.85, 0.48, 0.04, 0.12)
    }
}

fn amber_card_border(cx: &App) -> Hsla {
    if cx.theme().is_dark() {
        rgba_hsla(0.95, 0.62, 0.12, 0.28)
    } else {
        rgba_hsla(0.78, 0.42, 0.04, 0.26)
    }
}

/// The panel width the bar needs for the tabs beside the title, the status,
/// Pause and the arrows; narrower, they drop to a row under it.
const TABS_IN_BAR_WIDTH: f32 = 820.;

pub(crate) fn control(
    id: impl Into<ElementId>,
    label: &str,
    tip: &str,
    busy: bool,
    cx: &App,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    crate::highlights::tipped(
        h_flex()
            .id(id)
            .role(Role::Button)
            .flex_none()
            .self_start()
            .gap(px(7.))
            .items_center()
            .px(px(11.))
            .py(px(6.))
            .rounded(px(6.))
            .bg(style::primary_opacity(cx, 0.08))
            .text_size(px(12.))
            .text_color(cx.theme().foreground)
            .when(!busy, |s| s.cursor_pointer().on_click(on_click))
            .when(busy, |s| {
                s.child(
                    Spinner::new()
                        .with_size(px(12.))
                        .color(style::secondary_text(cx)),
                )
            }),
        tip.to_owned(),
    )
    .child(label.to_owned())
    .into_any_element()
}
