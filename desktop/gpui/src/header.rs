// What sits over and around the thread: its title line in the panel's bar with
// back, forward, share and the ... menu (DetailView's HeaderTitle and
// ThreadMenuButton, HistoryButtons, ShareButton), the banners above the
// transcript (ConnectionBanner, ErrorBanner, LimitBanner, SignInBanner,
// RefusalOffer) and the notes that float over the panel (ArchivedToast,
// InboxEndToast).
use crate::app::Threadbear;
use crate::shell;
use crate::sidebar::{MenuAction, MenuRow};
use crate::spinner::Spinner;
use crate::style::{self, px};
use crate::tips::Tip as _;
use crate::{call, icons};
use gpui_kit::assets::IconName;
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Icon, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use threadbear_core::inbox::ThreadSummary;
use threadbear_core::navigation::history_tip;
use threadbear_core::reducer::{RowContent, TurnCompletion, TurnErrorKind, TurnOutcome};
use threadbear_core::shortcuts::ShortcutCommand;
use threadbear_core::sign_in::{self, SignInAccount};

/// `PaneHeader.height`: the panels' bars, and the title bar's strip.
pub(crate) const HEADER_HEIGHT: f32 = 38.;

/// A control's tooltip and the label scripts find it by (Swift's `.tip`), as
/// `tipped!` in the sidebar: the element's result is whatever `test_support`
/// makes of it, so this is a macro rather than a function.
/// A button to VoiceOver, or what the third argument says.
macro_rules! tipped {
    ($el:expr, $tip:expr $(,)?) => {
        tipped!($el, $tip, gpui_kit::Role::Button)
    };
    ($el:expr, $tip:expr, $role:expr $(,)?) => {{
        let tip_text: SharedString = $tip.into();
        let shown = tip_text.clone();
        crate::tips::Tip::tip(
            crate::a11y::A11yRole::a11y_role($el.test_support(), $role).aria_label(tip_text),
            shown,
        )
    }};
}

/// `Banner`: a line about the runner, quiet or warning.
struct Banner {
    quiet: bool,
    text: String,
    /// The tooltip: a drop's raw reason, the threads a restart waits for.
    detail: Option<String>,
    retry: bool,
    /// Start runner, beside Try again (`showStart`).
    start: bool,
    /// Start runner spins: launchctl hasn't answered yet.
    starting: bool,
    /// A warning's symbol, or a quiet line's (None there is a spinner).
    icon: Option<&'static str>,
    /// A failed CLI update: the line has Dismiss, which forgets it.
    dismiss: Option<String>,
}

impl Banner {
    /// Something under way: a spinner and the words.
    fn quiet(text: &str) -> Banner {
        Banner {
            quiet: true,
            text: text.into(),
            detail: None,
            retry: false,
            start: false,
            starting: false,
            icon: None,
            dismiss: None,
        }
    }

    /// Quiet, with a symbol in place of the spinner.
    fn quiet_with(icon: &'static str, text: &str) -> Banner {
        Banner {
            icon: Some(icon),
            ..Banner::quiet(text)
        }
    }

    /// What the connection's phase says (threadbear_core::connection),
    /// with Start runner only where this app can start the runner.
    fn connection(banner: threadbear_core::connection::Banner, can_start: bool) -> Banner {
        use threadbear_core::connection::Buttons;
        let (retry, start, starting) = match banner.buttons {
            Buttons::None => (false, false, false),
            Buttons::TryAgain => (true, false, false),
            Buttons::StartRunnerAndTryAgain { starting } => (true, can_start, starting),
        };
        Banner {
            quiet: banner.quiet,
            text: banner.text.into(),
            detail: banner.detail,
            retry,
            start,
            starting,
            icon: banner.icon,
            dismiss: None,
        }
    }
}

/// A failed CLI update's key, so dismissing it hides only that one
/// (`failureKey`): when it finished, or what it was going to.
fn cli_failure_key(cli: &threadbear_core::updates::CliStatus) -> String {
    let update = cli.update.as_ref();
    let when = update
        .and_then(|u| u.finished_ms)
        .map(|ms| ms.to_string())
        .or_else(|| update.and_then(|u| u.target_version.clone()))
        .unwrap_or_default();
    format!("{}|{when}", cli.provider)
}

/// What `limit_advice` says about a thread at its limit (`LimitAdvice`), for
/// the limit box at the top of its composer (composer.rs).
pub(crate) struct LimitAdvice {
    pub(crate) text: String,
    /// The logins it could carry on with now, best first, each with its
    /// title: "mike (78% left)". Continue now opens the picker on the
    /// first's pool.
    pub(crate) targets: Vec<(String, String)>,
    /// A turn stopped at the limit (or the thread is waiting for room), so
    /// there's something to carry on: the box offers to do it by itself.
    /// Not for another Mac's thread, whose runner the setting can't reach
    /// through the backend yet.
    pub(crate) stopped: bool,
    /// A turn stopped at the limit, or it's waiting for room, on any
    /// runner: a pick from Continue now asks it to carry on there at once
    /// (`carryOn`), which another runner's thread takes through the backend
    /// too (API 77). Without it, a thread whose Carry on by itself is off
    /// moved to the new login and sat there (Codex's review, 13 Nov).
    pub(crate) carry_on: bool,
    /// It's waiting, and carries on by itself at this time.
    pub(crate) carries_on_at: Option<i64>,
    /// A Codex login it would carry on with that's out of room but has a
    /// usage reset left: its id and the Use a reset button's tip (Mike, 16
    /// Nov: he found two resets unused in Codex's settings after a pool
    /// had sat out of room). Only this Mac's threads: the reset is spent
    /// through this runner, with that login's own Codex.
    pub(crate) reset: Option<(String, String)>,
}

impl Threadbear {
    // The title line (`HeaderTitle`).

    /// The thread's title in the panel's bar, or a field while it's renamed.
    pub(crate) fn render_header_title(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // A project's page has its own title line (project_page.rs).
        if let Some(title) = self.render_project_header_title(cx) {
            return title;
        }
        // An archived session's (archive_search.rs).
        if let Some(title) = self.render_archive_header_title(cx) {
            return title;
        }
        let Some(thread) = self
            .open_thread()
            .cloned()
            .filter(|_| self.home_page().is_none())
        else {
            return div().into_any_element();
        };
        let _ = window;
        self.render_thread_title(thread, cx)
    }

    /// A thread's title line, for the main panel's bar or the bar of a panel
    /// it has of its own (thread_panels.rs), as both are Swift's `HeaderTitle`.
    pub(crate) fn render_thread_title(
        &mut self,
        thread: ThreadSummary,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let faint = style::faint_text(cx);
        let secondary = style::secondary_text(cx);
        let hover = style::primary_opacity(cx, 0.06);
        let header_size = px(style::size::HEADER);
        let projects = self.render_project_chips(&thread, cx);
        let title_el: AnyElement = if self.renaming.as_deref() == Some(thread.id.as_str()) {
            self.render_rename_field(cx)
        } else {
            let title: SharedString = if thread.title.is_empty() {
                "Untitled".into()
            } else {
                thread.title.clone().into()
            };
            let id = thread.id.clone();
            tipped!(
                div()
                    .id("header-title")
                    .min_w_0()
                    .truncate()
                    .font_weight(FontWeight::SEMIBOLD)
                    .px(px(4.))
                    .py(px(1.))
                    .mx(px(-4.))
                    .rounded(px(5.))
                    .hover(move |s| s.bg(hover)),
                "Click to rename",
            )
            // The press goes on to the bar under it, so a drag from the title
            // moves the window, as dragging a title bar does (and Swift's
            // tap gesture let it). Only a press that didn't is a click.
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                if !this.dock_view.read(cx).press_moved() {
                    this.start_renaming(id.clone(), window, cx);
                }
            }))
            // Fades over to a new name, as the agent names a new thread (open_motion.rs).
            .child(crate::open_motion::title(
                &thread.id,
                "header",
                title,
                cx.reduce_motion(),
            ))
            .into_any_element()
        };
        let worktree = thread
            .worktree
            .as_ref()
            .and_then(|w| w["branch"].as_str())
            .map(String::from);
        let worktree_tip = thread.worktree.as_ref().and_then(|w| w["mainCheckout"].as_str()).map(|path| format!("Works on its own branch in a worktree. tb land, or the Land chip, puts it on main in {}.", abbreviate(path))).unwrap_or_else(|| "Works on its own branch in a worktree.".to_owned());
        let schedule = thread.schedule.clone();
        h_flex()
            .min_w_0()
            // Where the Swift bar's title line sits, measured against it
            // (features/tools/compare.ts): 7 further in and 1 lower than the
            // dock's padding alone puts it.
            .pl(px(7.))
            .relative()
            .top(px(1.))
            .gap(px(6.))
            .text_size(header_size)
            .child(projects)
            .child(title_el)
            .when(thread.is_archived(), |s| s.child(div().flex_none().text_color(faint).child("·  Archived")))
            .when(thread.on_old_runner == Some(true), |s| {
                s.child(tipped!(div().id("old-runner").flex_none().text_color(faint), "This turn started before the runner updated, so it runs on the previous version. The thread moves to the new one when the turn ends.", gpui_kit::Role::GenericContainer).child("·  Finishing on the previous version"))
            })
            .when_some(worktree, |s, branch| s.child(tipped!(div().id("worktree-branch").flex_none().text_color(faint), worktree_tip).child(format!("·  {branch}"))))
            // A click opens the schedule in the editor, while it's still
            // there (`ScheduleChip`); the tip says when it runs.
            .when_some(schedule, |s, origin| {
                let id = origin["id"].as_str().unwrap_or("").to_owned();
                let current = self.scheduled.list.iter().find(|sc| sc.id == id);
                let tip = threadbear_core::schedules::started_by_tip(origin["title"].as_str().unwrap_or(""), current);
                let live = current.is_some();
                let (fg, hover_bg) = (cx.theme().foreground, style::primary_opacity(cx, 0.08));
                s.child(
                    tipped!(h_flex().id("schedule-chip").flex_none().ml(px(4.)).gap(px(4.)).items_center().pl(px(5.)).pr(px(7.)).py(px(2.)).rounded_full().bg(style::primary_opacity(cx, 0.05)).text_size(px(style::size::DETAIL)).text_color(secondary), tip)
                        .when(live, |s| {
                            s.hover(move |s| s.bg(hover_bg).text_color(fg)).on_click(cx.listener(move |this, _: &ClickEvent, window, cx| this.edit_schedule(&id, window, cx)))
                        })
                        .child(icon("clock", 11., secondary))
                        .child("Scheduled"),
                )
            })
            .into_any_element()
    }

    /// One of the thread's projects, as its icon before the title; or the
    /// folder glyph when it's in none (`ProjectIconButton`, the `folder` mark).
    /// A click opens the project's page; the menu takes the thread out, keeps
    /// it there (for one the librarian put it in) or adds it to another. A
    /// dashed ring is the librarian's guess that no one has confirmed yet.
    fn render_project_chips(
        &mut self,
        thread: &ThreadSummary,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let projects = thread.projects.clone().unwrap_or_default();
        let secondary = style::secondary_text(cx);
        let cwd = thread.cwd.clone();
        if projects.is_empty() || !self.projects_supported {
            let tip = format!("In {}", abbreviate(&cwd));
            // SF's folder at 12 pt is about 13.5 wide; Lucide's is at 14.
            return tipped!(
                div().id("header-folder").flex_none(),
                tip,
                gpui_kit::Role::Image
            )
            .child(icon("folder", 14., secondary))
            .into_any_element();
        }
        let hover = style::primary_opacity(cx, 0.08);
        let ring = secondary.opacity(0.5);
        let mut chips = h_flex().flex_none().gap(px(3.));
        for (index, membership) in projects.into_iter().enumerate() {
            let project = self.project(&membership.id).cloned();
            let title = project
                .as_ref()
                .map_or_else(|| membership.title.clone(), |p| p.title.clone());
            let guessed = membership.by == "librarian" && !membership.pinned;
            let tip = if guessed {
                format!("The librarian put this thread in {title}. Right-click to keep it there or take it out. In {}", abbreviate(&cwd))
            } else {
                format!(
                    "{title}, in {}. Click to open the project",
                    abbreviate(&cwd)
                )
            };
            let (open_id, menu_project, menu_thread) =
                (membership.id.clone(), membership.clone(), thread.id.clone());
            chips = chips.child(
                tipped!(
                    div()
                        .id(("project-chip", index))
                        .flex_none()
                        .p(px(2.))
                        .rounded(px(5.))
                        .hover(move |s| s.bg(hover))
                        .when(guessed, |s| s
                            .border(gpui_kit::px(0.75))
                            .border_dashed()
                            .border_color(ring)),
                    tip
                )
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.open_project_page(&open_id, cx)
                }))
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                        let rows = this.project_chip_rows(&menu_thread, &menu_project);
                        let thread = menu_thread.clone();
                        this.open_menu(Some(thread), rows, ev.position, false, window, cx);
                    }),
                )
                .child(crate::projects::project_icon(
                    project.as_ref(),
                    &title,
                    16.,
                    cx,
                )),
            );
        }
        chips.into_any_element()
    }

    /// The menu on a project's chip: open it, keep it, take the thread out, or
    /// add it to another (`ProjectIconButton`'s menu).
    fn project_chip_rows(
        &self,
        thread_id: &str,
        membership: &threadbear_core::inbox::Project,
    ) -> Vec<MenuRow> {
        let title = self
            .project(&membership.id)
            .map_or_else(|| membership.title.clone(), |p| p.title.clone());
        let mut rows = vec![
            MenuRow::item(
                format!("Open {title}"),
                "arrow.right.circle",
                MenuAction::Project(crate::projects::ProjectAction::Open(membership.id.clone())),
            ),
            MenuRow::separator(),
        ];
        if !membership.pinned {
            rows.push(MenuRow::item(
                format!("Keep it in {title}"),
                "pin",
                MenuAction::ThreadProject {
                    thread: thread_id.to_string(),
                    add: Some(membership.id.clone()),
                    remove: None,
                },
            ));
        }
        rows.push(MenuRow::item(
            format!("Take it out of {title}"),
            "minus.circle",
            MenuAction::ThreadProject {
                thread: thread_id.to_string(),
                add: None,
                remove: Some(membership.id.clone()),
            },
        ));
        let others = self
            .threads
            .get(thread_id)
            .map(|t| threadbear_core::projects::projects_to_add(&self.projects.list, t))
            .unwrap_or_default();
        if !others.is_empty() {
            let children = others
                .into_iter()
                .map(|p| {
                    MenuRow::item(
                        p.title.clone(),
                        "square.stack",
                        MenuAction::ThreadProject {
                            thread: thread_id.to_string(),
                            add: Some(p.id.clone()),
                            remove: None,
                        },
                    )
                })
                .collect();
            rows.push(MenuRow::submenu(
                "Add to another project",
                "plus.square.on.square",
                children,
            ));
        }
        rows
    }

    /// `threads.setProjects` from a menu: shown at once (projects.rs).
    pub(crate) fn set_thread_projects(
        &mut self,
        thread: String,
        add: Option<String>,
        remove: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.set_projects(
            &thread,
            add.into_iter().collect(),
            remove.into_iter().collect(),
            cx,
        );
    }

    fn render_rename_field(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let Some((field, _)) = &self.rename_field else {
            return div().into_any_element();
        };
        div()
            .id("title-field")
            .min_w(px(160.))
            .flex_1()
            .font_weight(FontWeight::SEMIBOLD)
            // Escape puts it back: captured so the field doesn't just keep it.
            .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| {
                if ev.keystroke.key == "escape" {
                    this.finish_rename(false, cx);
                    cx.stop_propagation();
                }
            }))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .tip("Return saves, Escape cancels")
            .child(Input::new(field).appearance(false).small().pl(px(0.)))
            .into_any_element()
    }

    /// Whether this panel's bar shows the rename field now: the main panel
    /// on the open thread, or a thread's own panel (thread_panels.rs). The
    /// dock then lets the field take the bar's free width.
    pub(crate) fn header_is_renaming(&self, panel: &str) -> bool {
        let Some(renaming) = self.renaming.as_deref() else {
            return false;
        };
        match crate::thread_panels::pinned_thread(panel) {
            Some(id) => id == renaming,
            None => {
                panel == crate::shell::MAIN
                    && self.home_page().is_none()
                    && self.projects.open.is_none()
                    && self.open_thread().is_some_and(|t| t.id == renaming)
            }
        }
    }

    /// Makes the title a field, as a click on it does (`startRenaming`).
    pub(crate) fn start_renaming(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(title) = self.threads.get(&id).map(|t| t.title.clone()) else {
            return;
        };
        if self.selected.as_deref() != Some(id.as_str()) {
            self.open(id.clone(), window, cx);
        }
        let field = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Thread title")
                .default_value(title)
        });
        // A new name typed and not yet taken: an update's restart waits for it.
        crate::unsent::watch_in(&field, "the title box", Some(id.clone()), cx);
        // The whole name selected, so typing replaces it, as a click on the
        // Swift app's title does (Mike, 11 Nov).
        field.update(cx, |s, cx| s.select_all(window, cx));
        let subscription = cx.subscribe(&field, |this, _, ev: &InputEvent, cx| match ev {
            InputEvent::PressEnter { .. } | InputEvent::Blur => this.finish_rename(true, cx),
            _ => {}
        });
        let handle = field.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        crate::web_panels::keyboard_to_app(window);
        self.rename_field = Some((field, subscription));
        self.renaming = Some(id);
        cx.notify();
    }

    /// Return or clicking away saves, Escape puts it back. A name given here
    /// is Mike's, so the runner won't let a model or an agent rename it after.
    pub(crate) fn finish_rename(&mut self, save: bool, cx: &mut Context<Self>) {
        let Some(id) = self.renaming.take() else {
            return;
        };
        let Some((field, _)) = self.rename_field.take() else {
            return;
        };
        if save {
            let draft = field.read(cx).value().to_string();
            self.rename_thread(&id, &draft, cx);
        }
        cx.notify();
    }

    /// `rename`: Mike's own name for a thread, shown at once, put back if it
    /// fails.
    pub(crate) fn rename_thread(&mut self, id: &str, title: &str, cx: &mut Context<Self>) {
        let title = title.trim().to_string();
        if title.is_empty() || self.threads.get(id).is_some_and(|t| t.title == title) {
            return;
        }
        let local = title.clone();
        self.update_thread(id, move |t| t.title = local, json!({ "title": title }), cx);
    }

    // The bar's buttons: back, forward, share, the ... menu.

    pub(crate) fn render_header_buttons(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let thread = self
            .open_thread()
            .cloned()
            .filter(|_| self.home_page().is_none() && self.projects.open.is_none());
        let coordinator = self
            .projects
            .open
            .is_some()
            .then(|| self.render_coordinator_bar(cx))
            .flatten();
        let back = self.render_history_button(true, cx);
        let forward = self.render_history_button(false, cx);
        let share = thread
            .as_ref()
            .filter(|_| self.website_url.is_some())
            .map(|t| self.render_share_button(t, cx));
        let more = thread
            .as_ref()
            .map(|t| self.render_more_button(t, cx))
            .or_else(|| self.render_project_more_button(cx));
        h_flex()
            .flex_none()
            .items_center()
            .children(coordinator)
            .child(back)
            .child(forward)
            .children(share)
            .children(more)
            .into_any_element()
    }

    /// `HistoryButton`: ‹ or ›, tipped with where it goes, dimmed with nowhere.
    fn render_history_button(&mut self, back: bool, cx: &mut Context<Self>) -> AnyElement {
        let enabled = if back {
            self.can_go_back()
        } else {
            self.can_go_forward()
        };
        let destination = enabled.then(|| self.destination(back)).flatten();
        let shortcut = self
            .shortcuts
            .key(if back {
                ShortcutCommand::Back
            } else {
                ShortcutCommand::Forward
            })
            .map(|k| k.display());
        let tip = history_tip(back, destination.as_deref(), shortcut.as_deref());
        let secondary = style::secondary_text(cx);
        let symbol = if back {
            "chevron.left"
        } else {
            "chevron.right"
        };
        tipped!(
            div()
                .id(if back {
                    "history-back"
                } else {
                    "history-forward"
                })
                .w(px(22.))
                .h(px(26.))
                .flex()
                .items_center()
                .justify_center()
                .when(!enabled, |s| s.opacity(0.35)),
            tip
        )
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .when(enabled, |s| {
            s.on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                if back {
                    this.go_back(window, cx);
                } else {
                    this.go_forward(window, cx);
                }
                this.sync_menus(cx);
            }))
        })
        .child(icon(symbol, style::size::LABEL, secondary))
        .into_any_element()
    }

    /// The share icon: accent when someone else can read the thread.
    pub(crate) fn render_share_button(
        &mut self,
        thread: &ThreadSummary,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let on = share_is_on(thread);
        let tip = if on {
            "Shared: anyone with the link can read it"
        } else {
            "Share this thread on the web"
        };
        let color = if on {
            style::accent(cx)
        } else {
            style::secondary_text(cx)
        };
        let open = self.share_popover.as_deref() == Some(thread.id.as_str());
        let id = thread.id.clone();
        let hover = style::sidebar_hover(cx);
        let mut button = tipped!(
            div()
                .id("header-share")
                .relative()
                .w(px(26.))
                .h(px(26.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .hover(move |s| s.bg(hover)),
            tip
        )
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
            this.toggle_share_popover(id.clone(), window, cx)
        }))
        .child(icon("square.and.arrow.up", style::size::LABEL, color));
        if open {
            button = button.child(self.render_share_popover(thread, cx));
        }
        button.into_any_element()
    }

    /// Opens the share popover on `id`, or closes it if it's up. Open, it
    /// has the keyboard, so Escape closes it as the Swift app's NSPopover
    /// does by itself (the fuzzing run found it didn't, 18 Nov).
    pub(crate) fn toggle_share_popover(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.share_popover.as_deref() == Some(id.as_str()) {
            self.close_share_popover(window, cx);
            return;
        }
        if self.share_popover.is_none() {
            self.share_before = window.focused(cx).filter(|f| *f != self.share_focus);
        }
        self.share_popover = Some(id);
        window.focus(&self.share_focus, cx);
        crate::web_panels::keyboard_to_app(window);
        cx.notify();
    }

    /// Puts the share popover away, giving the keyboard back if it still has it.
    pub(crate) fn close_share_popover(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.share_popover = None;
        crate::sidebar::give_back_focus(
            &self.share_focus,
            self.share_before.take().as_ref(),
            window,
            cx,
        );
        cx.notify();
    }

    /// Who can read the thread, the link, and Copy (`SharePopover`).
    fn render_share_popover(
        &mut self,
        thread: &ThreadSummary,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let on = share_is_on(thread);
        let link = self.share_link(thread);
        let id = thread.id.clone();
        let busy = self.share_busy;
        let (secondary, bg, border) = (
            style::secondary_text(cx),
            cx.theme().popover,
            cx.theme().border,
        );
        // Each choice is named by its own words to a screen reader, and says
        // whether it's the one chosen (both were "Who can read it" until 18 Nov).
        let option = |label: &'static str,
                      tip: &'static str,
                      access: &'static str,
                      selected: bool,
                      id: String,
                      cx: &mut Context<Self>| {
            div()
                .id(label)
                .test_support()
                .role(Role::RadioButton)
                .aria_toggled(if selected {
                    Toggled::True
                } else {
                    Toggled::False
                })
                .aria_label(label)
                .tip(tip)
                .flex_1()
                .flex()
                .justify_center()
                .px(px(8.))
                .py(px(4.))
                .rounded(px(6.))
                .when(selected, |s| s.bg(style::primary_opacity(cx, 0.08)))
                .text_size(px(style::size::LABEL))
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    if !this.share_busy {
                        this.set_share(id.clone(), access, false, cx);
                    }
                }))
                .child(label)
        };
        let rows = vec![
            option(
                "Only you",
                "Only you can read it",
                "off",
                !on,
                id.clone(),
                cx,
            )
            .into_any_element(),
            option(
                "Anyone with the link",
                "Anyone with the link can read it",
                "link",
                on,
                id.clone(),
                cx,
            )
            .into_any_element(),
        ];
        let id_for_new = id;
        let link_row = link.map(|link| {
            let (copy, open) = (link.clone(), link.clone());
            h_flex()
                .gap(px(6.))
                .items_center()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(style::size::DETAIL))
                        .text_color(secondary)
                        .child(link),
                )
                .child(self.small_button(
                    "share-new",
                    "arrow.triangle.2.circlepath",
                    "Make a new link. The old one stops working.",
                    cx.listener(move |this, _: &ClickEvent, _, cx| {
                        if !this.share_busy {
                            this.set_share(id_for_new.clone(), "link", true, cx)
                        }
                    }),
                    cx,
                ))
                .child(self.small_button(
                    "share-open",
                    "arrow.up.right",
                    "Open the shared page in your browser",
                    cx.listener(move |_, _: &ClickEvent, _, cx| {
                        crate::open_gate::open_web(&open, cx);
                    }),
                    cx,
                ))
                .child(
                    tipped!(
                        div()
                            .id("share-copy")
                            .px(px(8.))
                            .py(px(3.))
                            .rounded(px(6.))
                            .bg(style::primary_opacity(cx, 0.08))
                            .text_size(px(style::size::DETAIL)),
                        "Copy the link to paste anywhere"
                    )
                    .on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()))
                    }))
                    .child("Copy link"),
                )
        });
        deferred(
            anchored().child(
                div()
                    .id("share-popover")
                    .occlude()
                    .w(px(380.))
                    .p(px(16.))
                    .rounded(px(12.))
                    .bg(bg)
                    .border_1()
                    .border_color(border)
                    .shadow_lg()
                    .track_focus(&self.share_focus)
                    .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                        if ev.keystroke.key == "escape" {
                            this.close_share_popover(window, cx);
                            cx.stop_propagation();
                        }
                    }))
                    .on_mouse_down_out(cx.listener(|this, _: &MouseDownEvent, window, cx| {
                        this.close_share_popover(window, cx)
                    }))
                    .child(
                        v_flex()
                            .gap(px(12.))
                            .child(
                                div()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_size(px(style::size::LABEL))
                                    .child("Share this thread"),
                            )
                            .child(
                                h_flex()
                                    .id("share-who")
                                    .test_support()
                                    .role(Role::RadioGroup)
                                    .aria_label("Who can read it")
                                    .gap(px(4.))
                                    .children(rows),
                            )
                            .when(busy, |s| {
                                s.child(
                                    div().size(px(14.)).child(
                                        Spinner::new()
                                            .icon(IconName::LoaderCircle)
                                            .color(secondary)
                                            .with_size(px(14.)),
                                    ),
                                )
                            })
                            .when_some(link_row, |s, l| s.child(l)),
                    ),
            ),
        )
        .with_priority(2)
        .into_any_element()
    }

    fn small_button(
        &self,
        id: &'static str,
        symbol: &'static str,
        tip: &'static str,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let secondary = style::secondary_text(cx);
        tipped!(
            div()
                .id(id)
                .size(px(22.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(5.)),
            tip
        )
        .on_click(on_click)
        .child(icon(symbol, 12., secondary))
        .into_any_element()
    }

    pub(crate) fn share_link(&self, thread: &ThreadSummary) -> Option<String> {
        let website = self.website_url.as_ref()?;
        let share = thread.share.as_ref()?;
        (share["access"] == "link").then(|| {
            format!(
                "{}/s/{}",
                website.trim_end_matches('/'),
                share["slug"].as_str().unwrap_or("")
            )
        })
    }

    /// Sets sharing through `threads.share`, the same call the popover makes.
    pub(crate) fn set_share(
        &mut self,
        id: String,
        access: &str,
        new_link: bool,
        cx: &mut Context<Self>,
    ) {
        // One at a time: a second New link while the first is on its way
        // made two, and the link shown first stopped working.
        if self.share_busy {
            return;
        }
        let params = json!({ "threadId": id, "access": access, "newLink": new_link });
        let going = crate::call_action(self.client.clone(), "threads.share", params);
        self.share_busy = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |this, cx| {
                this.share_busy = false;
                match res {
                    Ok(v) => {
                        // Another runner's thread stays that runner's,
                        // shared (the relay answers for it; 23 Nov review).
                        if let Ok(t) = serde_json::from_value::<ThreadSummary>(v["thread"].clone())
                        {
                            this.store_reply_summary(t);
                        }
                    }
                    Err(e) => this.show_error(e.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The thread's ... menu: the same as its row's, with Copy transcript and
    /// the thread's own web page (`ThreadMenuButton`).
    pub(crate) fn render_more_button(
        &mut self,
        thread: &ThreadSummary,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = thread.id.clone();
        let secondary = style::secondary_text(cx);
        let hover = style::sidebar_hover(cx);
        tipped!(
            div()
                .id("header-more")
                .w(px(26.))
                .h(px(26.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .hover(move |s| s.bg(hover)),
            "More"
        )
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
            let at = ev.position();
            this.open_more_menu(id.clone(), point(at.x, at.y + px(14.)), window, cx);
        }))
        .child(icon("ellipsis", style::size::LABEL, secondary))
        .into_any_element()
    }

    pub(crate) fn open_more_menu(
        &mut self,
        id: String,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(thread) = self.threads.get(&id).cloned() else {
            return;
        };
        let mut rows = self.thread_menu_rows(&thread, cx);
        // Swift's menu has "Copy thread id" last and Copy transcript above it;
        // the row's menu ends with that divider and item.
        rows.truncate(rows.len().saturating_sub(2));
        rows.push(MenuRow::separator());
        rows.push(MenuRow::item(
            "Copy transcript as Markdown",
            "doc.plaintext",
            MenuAction::CopyTranscript,
        ));
        rows.push(MenuRow::item(
            "Copy thread id",
            "number",
            MenuAction::CopyId,
        ));
        // Only while there's a website to go to, as with the share button.
        if self.website_url.is_some() {
            rows.push(MenuRow::item(
                "Open on the web",
                "safari",
                MenuAction::OpenOnWeb,
            ));
        }
        self.open_menu(Some(id), rows, position, false, window, cx);
    }

    pub(crate) fn thread_web_link(&self, id: &str) -> Option<String> {
        self.website_url
            .as_ref()
            .map(|w| format!("{}/t/{}", w.trim_end_matches('/'), id))
    }

    // The banners over the transcript.

    pub(crate) fn render_banners(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let _ = window;
        let thread = self.open_thread().cloned();
        let mut column = v_flex().flex_none();
        if let Some(banner) = self.connection_banner() {
            column = column.child(self.render_connection_banner(banner, cx));
        }
        if let Some(error) = self.error_message.clone() {
            column = column.child(self.render_error_banner(error, cx));
        }
        if let Some(thread) = &thread {
            // A thread at its limit says so in a box on its composer
            // (composer.rs, `LimitBox`), not across the top: Mike's call on
            // 10 Nov, as the bar read as an error and offered only the switch.
            let (account, remote) = (
                self.sign_in_account(thread, cx),
                self.remote_sign_in_runner(thread, cx),
            );
            if self.sign_in_needed(thread, cx) {
                column = column.child(self.render_signin_banner(thread, account, remote, cx));
            }
            // The refusal offer sits just above the box (RefusalOffer in
            // ComposerView), drawn by the composer (`refusal_offer`).
            // Reviews waiting, older ones too (review_window.rs).
            if let Some(bar) = self.pending_reviews_bar(thread, cx) {
                column = column.child(bar);
            }
        }
        column.into_any_element()
    }

    /// `SubagentHeader`: back to the thread, the sub-agent's title, and what
    /// it is: "Explore · Opus 5.5 · High · Running in the background · 4 tool
    /// calls · from Fix the build".
    pub(crate) fn render_subagent_header(&mut self, cx: &mut Context<Self>) -> AnyElement {
        use threadbear_core::sidebar as side;
        let Some((thread_id, sub_id)) = self.subagent.clone() else {
            return div().into_any_element();
        };
        let thread = self.threads.get(&thread_id);
        let sub = thread.and_then(|t| side::subagents(t).into_iter().find(|s| s.id == sub_id));
        let title = sub
            .as_ref()
            .map_or_else(|| "Sub-agent".to_owned(), side::subagent_title);
        let meta = side::subagent_header_meta(sub.as_ref(), thread.map(|t| t.title.as_str()));
        let (secondary, hover, fg) = (
            style::secondary_text(cx),
            style::primary_opacity(cx, 0.08),
            cx.theme().foreground,
        );
        h_flex()
            .flex_none()
            .px(px(14.))
            .py(px(8.))
            .gap(px(10.))
            .items_center()
            .border_b(gpui_kit::px(0.5))
            .border_color(style::hairline(cx))
            .child(
                tipped!(
                    div()
                        .id("subagent-back")
                        .flex_none()
                        .size(px(22.))
                        .rounded(px(5.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover)),
                    "Back to the thread"
                )
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.close_subagent(cx)))
                .child(icon("chevron.left", 12., secondary)),
            )
            .child(
                v_flex()
                    .min_w_0()
                    .gap(px(2.))
                    .child(
                        div()
                            .text_size(px(style::size::SIDEBAR_TITLE))
                            .line_height(px(style::natural_line(style::size::SIDEBAR_TITLE)))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(fg)
                            .truncate()
                            .child(title),
                    )
                    .child(
                        div()
                            .text_size(px(style::size::SIDEBAR_META + 1.))
                            .line_height(px(style::natural_line(style::size::SIDEBAR_META + 1.)))
                            .text_color(secondary)
                            .truncate()
                            .child(meta),
                    ),
            )
            .into_any_element()
    }

    /// `AppModel.banner`: the line about the runner, if there's anything to
    /// say. What the connection says comes from its phase alone
    /// (threadbear_core::connection::banner), which only moves on what this
    /// app has heard, so a draw can't catch the client half way through
    /// telling it something.
    fn connection_banner(&self) -> Option<Banner> {
        let connection =
            threadbear_core::connection::banner(&self.connection, std::time::Instant::now());
        if !self.connected() {
            return connection.map(|b| Banner::connection(b, self.can_start_runner()));
        }
        // Mike's own click comes first: he's looking for it.
        if let Some((_, note)) = self.busy_notes.last() {
            return Some(Banner::quiet(note));
        }
        if let Some(done) = &self.done_note {
            return Some(Banner::quiet_with("checkmark", done));
        }
        // The runner restarting now.
        if let Some(banner) = connection {
            return Some(Banner::connection(banner, false));
        }
        // A restart waiting for threads, in the client's words: how many,
        // and which, by the threads' titles.
        let restart = self.client.restart();
        let waiting_on_you = |id: &str| self.threads.get(id).is_some_and(|t| t.needs_answer());
        if let Some(text) = restart.pending_text(waiting_on_you) {
            let detail =
                restart.waiting_for_text(|id| self.threads.get(id).map(|t| t.title.clone()));
            return Some(Banner {
                detail,
                ..Banner::quiet_with("arrow.clockwise", &text)
            });
        }
        // A CLI update under way (a spinner), or one that failed, which
        // stays until it's dismissed.
        self.cli_banner()
    }

    /// An update under way, or one that failed and hasn't been dismissed
    /// (`cliBanner`).
    fn cli_banner(&self) -> Option<Banner> {
        use threadbear_core::updates as rules;
        for cli in &self.updates_panel.clis {
            let (Some(update), Some(text)) = (cli.update.as_ref(), rules::banner_text(cli)) else {
                continue;
            };
            if update.state == "failed" {
                let key = cli_failure_key(cli);
                if self.dismissed_cli_failures.contains(&key) {
                    continue;
                }
                return Some(Banner {
                    dismiss: Some(key),
                    ..Banner::quiet_with("exclamationmark.triangle", &text)
                });
            }
            return Some(Banner::quiet(&text));
        }
        None
    }

    /// What a click from a menu is doing, in the banner until it's done
    /// (`whileBusy`'s `note:`): for a click from somewhere that can't show a
    /// spinner of its own. The banner can't be pressed, so this is only
    /// what's going on; the work itself still refuses a second go while it
    /// runs. Returns false, and changes nothing, if `key` is already busy.
    pub(crate) fn begin_note(&mut self, key: &str, text: &str, cx: &mut Context<Self>) -> bool {
        if self.busy_notes.iter().any(|(k, _)| k == key) {
            return false;
        }
        self.busy_notes.push((key.to_owned(), text.to_owned()));
        cx.notify();
        true
    }

    pub(crate) fn end_note(&mut self, key: &str, cx: &mut Context<Self>) {
        if let Some(i) = self.busy_notes.iter().rposition(|(k, _)| k == key) {
            self.busy_notes.remove(i);
            cx.notify();
        }
    }

    /// Says something's done in the banner for a moment (`flashDone`).
    pub(crate) fn flash_done(&mut self, text: &str, cx: &mut Context<Self>) {
        self.done_note = Some(text.to_owned());
        let text = text.to_owned();
        self.done_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(2))
                .await;
            this.update(cx, |this, cx| {
                if this.done_note.as_deref() == Some(text.as_str()) {
                    this.done_note = None;
                    cx.notify();
                }
            })
            .ok();
        }));
        cx.notify();
    }

    fn render_connection_banner(&mut self, banner: Banner, cx: &mut Context<Self>) -> AnyElement {
        let hairline = style::hairline(cx);
        let secondary = style::secondary_text(cx);
        let spinner = || {
            Spinner::new()
                .icon(IconName::LoaderCircle)
                .color(secondary)
                .with_size(px(13.))
        };
        if banner.quiet {
            // A restart: grey words on the window's own background with a
            // hairline under them, so it reads as information, not a
            // problem. The threads it waits for are its tooltip.
            let line = tipped!(
                div().id("banner-text").flex_1().min_w_0().truncate(),
                banner.detail.clone().unwrap_or_default(),
                gpui_kit::Role::GenericContainer
            )
            .child(banner.text);
            return h_flex()
                .flex_none()
                .px(px(14.))
                .py(px(7.))
                .gap(px(8.))
                .items_center()
                .border_b_1()
                .border_color(hairline)
                .text_size(px(style::size::LABEL))
                .text_color(secondary)
                .child(match banner.icon {
                    Some(name) => icon(name, 13., secondary).into_any_element(),
                    None => spinner().into_any_element(),
                })
                .child(line)
                .when_some(banner.dismiss, |s, key| {
                    s.child(
                        tipped!(
                            div()
                                .id("banner-dismiss")
                                .px(px(6.))
                                .py(px(2.))
                                .rounded(px(5.))
                                .cursor_pointer(),
                            "Hide this until it happens again"
                        )
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.dismissed_cli_failures.insert(key.clone());
                            cx.notify();
                        }))
                        .child("Dismiss"),
                    )
                })
                .into_any_element();
        }
        let detail = banner.detail.clone().unwrap_or_default();
        let warning_fill = style::warning_fill(cx);
        h_flex()
            .flex_none()
            .px(px(14.))
            .py(px(8.))
            .gap(px(8.))
            .items_center()
            .bg(warning_fill)
            .text_size(px(style::size::LABEL))
            .child(icon(
                banner.icon.unwrap_or("bolt.horizontal"),
                13.,
                secondary,
            ))
            .child(
                tipped!(
                    div().id("connection-text").flex_1().min_w_0().truncate(),
                    detail,
                    gpui_kit::Role::GenericContainer
                )
                .child(banner.text),
            )
            // Regular push buttons, as the Swift bar's. Start runner spins
            // until launchctl has answered and the app has tried again, and
            // can't be pressed twice meanwhile.
            .when(banner.start, |s| {
                let me = cx.entity().downgrade();
                s.child(
                    crate::push_button::PushButton::new(
                        "banner-start-runner",
                        "Start runner",
                        "Start the runner's background service",
                    )
                    .busy(banner.starting)
                    .render(cx, move |_, _, cx| {
                        me.update(cx, |this, cx| this.start_runner(cx)).ok();
                    }),
                )
            })
            .when(banner.retry, |s| {
                let me = cx.entity().downgrade();
                s.child(
                    crate::push_button::PushButton::new(
                        "banner-retry",
                        "Try again",
                        "Try to reach the runner now rather than waiting",
                    )
                    .render(cx, move |_, _, cx| {
                        me.update(cx, |this, cx| this.reconnect_now(cx)).ok();
                    }),
                )
            })
            .into_any_element()
    }

    fn render_error_banner(&mut self, error: String, cx: &mut Context<Self>) -> AnyElement {
        let fill = style::needs_you(cx).opacity(0.1);
        let orange = style::needs_you(cx);
        let tip = error.clone();
        h_flex()
            .flex_none()
            .px(px(14.))
            .py(px(7.))
            .gap(px(8.))
            .items_center()
            .bg(fill)
            .text_size(px(style::size::LABEL))
            .child(icon("exclamationmark.triangle", 13., orange))
            .child(
                tipped!(
                    div().id("error-text").flex_1().min_w_0(),
                    tip,
                    gpui_kit::Role::GenericContainer
                )
                .child(div().line_clamp(2).child(error)),
            )
            .when(self.own_checkout().is_some(), |s| {
                s.child(self.render_investigate_button(cx))
            })
            .child(
                tipped!(
                    div()
                        .id("error-dismiss")
                        .px(px(6.))
                        .py(px(2.))
                        .rounded(px(5.))
                        .text_color(style::secondary_text(cx)),
                    "Hide this message"
                )
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.dismiss_error(cx)))
                .child("Dismiss"),
            )
            .into_any_element()
    }

    fn render_investigate_button(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let creating = self.creating_investigation;
        let secondary = style::secondary_text(cx);
        h_flex()
            .gap(px(6.))
            .items_center()
            .when(creating, |s| {
                s.child(
                    Spinner::new()
                        .icon(IconName::LoaderCircle)
                        .color(secondary)
                        .with_size(px(13.)),
                )
            })
            .child(
                tipped!(
                    div()
                        .id("error-investigate")
                        .px(px(6.))
                        .py(px(2.))
                        .rounded(px(5.))
                        .when(creating, |s| s.opacity(0.5)),
                    "Start a thread in Threadbear's own repo to find what caused this and fix it"
                )
                .when(!creating, |s| {
                    s.on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        this.investigate_error(window, cx)
                    }))
                })
                .child("Investigate"),
            )
            .into_any_element()
    }

    /// `noteFailedAccounts`: the login a thread was on as it went into
    /// error, kept until it leaves error.
    pub(crate) fn note_failed_account(
        &mut self,
        before: Option<&ThreadSummary>,
        now: &ThreadSummary,
    ) {
        if now.status == "error" {
            if before.is_none_or(|b| b.status != "error")
                || !self.failed_on_account.contains_key(&now.id)
            {
                self.failed_on_account
                    .insert(now.id.clone(), now.account_id.clone());
            }
        } else {
            self.failed_on_account.remove(&now.id);
        }
    }

    /// A move of `now` that has just failed says so in the error bar, with
    /// why (ThreadSummary::move_failure). A thread the app hadn't seen
    /// before (`before` None) says nothing: that's an old failure, already
    /// on its row.
    pub(crate) fn note_failed_move(
        &mut self,
        before: Option<&ThreadSummary>,
        now: &ThreadSummary,
        cx: &mut Context<Self>,
    ) {
        if let Some(message) = before.and_then(|b| now.move_failure(b)) {
            self.show_error(message, cx);
        }
    }

    /// The same over a new list of every thread, against the one before it.
    pub(crate) fn note_failed_accounts(
        &mut self,
        before: &std::collections::HashMap<String, std::sync::Arc<ThreadSummary>>,
    ) {
        let now: Vec<ThreadSummary> = self.threads.values().map(|t| &**t).cloned().collect();
        for t in &now {
            self.note_failed_account(before.get(&t.id).map(|t| &**t), t);
        }
        let known: std::collections::HashSet<String> = self.threads.keys().cloned().collect();
        self.failed_on_account.retain(|id, _| known.contains(id));
    }

    /// `limitAdvice`: when a thread can't go on where it is, says so, and
    /// where it could go instead.
    pub(crate) fn limit_advice(&self, thread: &ThreadSummary, cx: &App) -> Option<LimitAdvice> {
        use threadbear_core::new_thread::{
            continue_title, has_room, pool_logins, reset_target, reset_tip, switch_targets,
            usage_of,
        };
        // Another runner's thread is judged by that runner's own logins and
        // offered them, never this Mac's: a login id like "claude-main" is
        // that runner's, and one of the same id here is a different login
        // (Mike, 13 Nov: a Pixel thread that had finished fine said this
        // Mac's login was at its limit, and offered this Mac's logins). Until
        // they've come (`load_remote_logins`), nothing is said.
        let logins = match thread.runner_id.as_deref() {
            Some(runner) => self.remote.logins.get(runner)?,
            None => &self.logins,
        };
        let accounts = &logins.accounts;
        let targets: Vec<(String, String)> = switch_targets(accounts, &thread.account_id)
            .into_iter()
            .map(|a| (a.id.clone(), continue_title(a, accounts)))
            .collect();
        let local = thread.runner_id.is_none();
        // The thread's own login first, then the rest of its pool.
        let pool_of = thread
            .pool_id
            .as_deref()
            .filter(|_| logins.uses_pools())
            .and_then(|id| logins.pool(id));
        let reset_offer = if local {
            let own = logins.account(&thread.account_id);
            let pooled = pool_of
                .map(|p| pool_logins(p, accounts, None))
                .unwrap_or_default();
            reset_target(own.into_iter().chain(pooled)).map(|a| {
                (
                    a.id.clone(),
                    reset_tip(a, accounts, &threadbear_core::sidebar::local_now()),
                )
            })
        } else {
            None
        };
        // A pool thread is the runner's to move: nothing while its pool has a
        // login with room, and when it carries on once it's waiting. Once
        // the whole pool is out it asks: Continue now on a login outside
        // the pool (which pins it there), or wait.
        if logins.uses_pools() {
            if let Some(pool) = thread.pool_id.as_deref().and_then(|id| logins.pool(id)) {
                if let Some(until) = thread.waiting_for_room_until_ms() {
                    return Some(LimitAdvice {
                        text: format!("Every login in {} is out of room.", pool.title),
                        targets,
                        stopped: local,
                        carry_on: true,
                        carries_on_at: Some(until),
                        reset: reset_offer,
                    });
                }
                if pool_logins(pool, accounts, None).into_iter().any(has_room) {
                    return None;
                }
            }
        }
        let usage = logins.account(&thread.account_id).and_then(usage_of);
        // A signed-out login isn't at a limit that resets: the sign-in line
        // and its row in Usage say what to do instead.
        let signed_out = logins
            .account(&thread.account_id)
            .is_some_and(|a| a.signed_out);
        let blocked = usage.as_ref().is_some_and(|u| u.blocked) && !signed_out;
        // Only while the thread is still on the login the turn failed on:
        // after "Switch to ..." the status stays error until the next turn,
        // and the line would blame the new login.
        let failed_on_limit = thread.status == "error"
            && self.failed_on_account.get(&thread.id) == Some(&thread.account_id)
            // This thread's own turn: a box in a panel of its own isn't the
            // main panel's thread.
            && self
                .completion_for(&thread.id, cx)
                .is_some_and(|c| c.error_kind == Some(TurnErrorKind::UsageLimit));
        // A pinned thread at its limit waits for its own login too.
        let waiting = thread.waiting_for_room_until_ms();
        if !blocked && !failed_on_limit && waiting.is_none() {
            return None;
        }
        let ended = logins
            .account(&thread.account_id)
            .is_some_and(|a| a.plan_ended);
        let name = threadbear_core::logins::short_account_name(&thread.account_id, accounts);
        // A lapsed plan has no reset coming (the runner sends no usage for it).
        let mut text = if ended {
            format!("{name}'s plan has ended")
        } else {
            format!("{name} has reached its limit")
        };
        // The soonest of the windows that are used up (`mainWindows`).
        let reset = usage.as_ref().and_then(|u| {
            threadbear_core::new_thread::main_windows(u)
                .into_iter()
                .filter(|w| w.remaining_percent < 1.)
                .filter_map(|w| w.resets_at)
                .min()
        });
        if let Some(ms) = reset {
            let now = threadbear_core::sidebar::local_now();
            let at = threadbear_core::chrono::TimeZone::timestamp_millis_opt(&now.timezone(), ms)
                .single();
            if let Some(at) = at {
                text.push_str(&format!(
                    ", resets {}",
                    threadbear_core::new_thread::reset_time(&at, &now)
                ));
            }
        }
        text.push('.');
        // Another runner's thread always asks: neither why its turn failed
        // nor its wait for room comes through the backend, and that runner
        // carries on only a thread whose turn really stopped at its limit
        // (runner.ts update, limitHitTurn), so asking is safe (Codex's
        // second review, 13 Nov).
        let carry_on = failed_on_limit || waiting.is_some() || !local;
        Some(LimitAdvice {
            text,
            targets,
            stopped: local && carry_on,
            carry_on,
            carries_on_at: waiting,
            reset: reset_offer,
        })
    }

    /// The limit box's Carry on by itself (`setCarryOnAtReset`): shown at
    /// once; the runner's answer says when it'll carry on.
    pub(crate) fn set_carry_on_at_reset(&mut self, thread: &str, on: bool, cx: &mut Context<Self>) {
        self.update_thread(
            thread,
            |t| t.carry_on_at_reset = on,
            json!({ "carryOnAtReset": on }),
            cx,
        );
    }

    /// `limit` in the dump (`AppDump.LimitInfo`): the line's words and its button.
    #[cfg(feature = "automation")]
    pub(crate) fn limit_dump(&self, cx: &App) -> Value {
        let Some(thread) = self.open_thread() else {
            return Value::Null;
        };
        let Some(advice) = self.limit_advice(thread, cx) else {
            return Value::Null;
        };
        // "Yes" or "No" when the box offers to carry on by itself.
        let carry_on = advice.stopped.then_some({
            if thread.carry_on_at_reset {
                "Yes"
            } else {
                "No"
            }
        });
        // Continue now, when there's a login with room, and the one with
        // most room, whose pool the picker it opens shows first; then
        // every login with room.
        let button = advice.targets.first().map(|_| "Continue now");
        let best = advice.targets.first().map(|(_, title)| title);
        let menu: Vec<&String> = advice.targets.iter().map(|(_, title)| title).collect();
        json!({ "text": advice.text, "button": button, "best": best, "logins": menu, "carryOn": carry_on, "reset": advice.reset.as_ref().map(|(id, tip)| json!({ "accountId": id, "tip": tip, "busy": self.resetting.contains(id) })) })
    }

    pub(crate) fn take_reset_offer(
        &mut self,
        action: threadbear_core::reset_hint::ResetAction,
        runner: Option<String>,
        account: String,
        cx: &mut Context<Self>,
    ) {
        use threadbear_core::reset_hint::{ResetAction, CLAUDE_USAGE_URL};
        match action {
            ResetAction::RedeemCodex => self.use_reset_on(runner, account, cx),
            ResetAction::OpenClaudeUsage => {
                crate::open_gate::open_web(CLAUDE_USAGE_URL, cx);
            }
        }
    }

    /// The limit box's Use a reset (`accounts.useReset`): spends one of the
    /// Codex login's usage resets. The button spins and can't be pressed
    /// again until the runner answers; the runner's reading after the reset
    /// lifts the block, and a thread waiting for room carries on by itself.
    pub(crate) fn use_reset(&mut self, account: String, cx: &mut Context<Self>) {
        self.use_reset_on(None, account, cx);
    }

    /// Use a reset for one of `runner`'s logins (a remote thread's login
    /// list), or this Mac's with None. This Mac's runner spends it on its own
    /// login of the same email if it has one (one subscription), else on
    /// that runner through Convex. The key it spins under is
    /// `reset_key`'s.
    pub(crate) fn use_reset_on(
        &mut self,
        runner: Option<String>,
        account: String,
        cx: &mut Context<Self>,
    ) {
        let key = reset_key(runner.as_deref(), &account);
        if !self.resetting.insert(key.clone()) {
            return;
        }
        cx.notify();
        let client = self.client.clone();
        let mut params = json!({ "accountId": account });
        if let Some(runner) = &runner {
            params["runnerId"] = json!(runner);
        }
        let going = crate::call_action(client, "accounts.useReset", params);
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |t, cx| {
                t.resetting.remove(&key);
                let logins = match runner.as_deref() {
                    Some(r) => t.remote.logins.get(r).unwrap_or(&t.logins),
                    None => &t.logins,
                };
                let name = threadbear_core::logins::short_account_name(&account, &logins.accounts);
                match res {
                    Ok(v) => {
                        // The login as the runner has it after the reset, so
                        // the box goes now rather than with the next
                        // accounts.updated (up to 5 s later). Another
                        // runner's list is read again instead: the answer
                        // may be this Mac's twin of that login.
                        match runner.clone() {
                            Some(r) => {
                                if v["account"].is_object() {
                                    t.logins.replace_same_login(&v["account"]);
                                }
                                t.load_remote_logins(r, cx);
                            }
                            None if v["account"].is_object() => {
                                t.logins.replace_account(&v["account"]);
                            }
                            None => {}
                        }
                        match v["outcome"].as_str() {
                            Some("reset") | Some("alreadyRedeemed") => {
                                t.flash_done(&format!("Reset {name}'s limits"), cx)
                            }
                            Some("nothingToReset") => t.show_error(
                                format!("Codex says {name} has nothing to reset yet."),
                                cx,
                            ),
                            Some("noCredit") => {
                                t.show_error(format!("{name} has no resets left."), cx)
                            }
                            _ => {}
                        }
                    }
                    Err(e) if e.code == -32601 => t.show_error(
                        "This Mac's runner is too old to use a reset. It updates by itself.".into(),
                        cx,
                    ),
                    Err(e) => t.show_error(e.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Whether a Use a reset is on its way for this login (`use_reset_on`).
    pub(crate) fn resetting_login(&self, runner: Option<&str>, account: &str) -> bool {
        self.resetting.contains(&reset_key(runner, account))
    }

    /// The Usage panel's Find work for it (`accounts.findWork`): the runner
    /// starts a thread on that login suggesting work for the rest of its
    /// week, or answers the one it already started, and it opens. The button
    /// spins and takes no clicks until then.
    pub(crate) fn find_work(&mut self, account: String, cx: &mut Context<Self>) {
        if !self.usage.finding_work.insert(account.clone()) {
            return;
        }
        cx.notify();
        let going = crate::call_action(
            self.client.clone(),
            "accounts.findWork",
            json!({ "accountId": account }),
        );
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |t, cx| {
                t.usage.finding_work.remove(&account);
                match res {
                    Ok(v) => {
                        let id = v["threadId"].as_str().unwrap_or_default().to_owned();
                        if id.is_empty() {
                            t.show_error(
                                "The runner didn't say what thread it made.".to_owned(),
                                cx,
                            );
                        } else {
                            // Listed now, so it opens before threads.created.
                            if let Ok(thread) = serde_json::from_value::<
                                threadbear_core::inbox::ThreadSummary,
                            >(v["thread"].clone())
                            {
                                if thread.id == id {
                                    t.store_reply_summary(thread);
                                }
                            }
                            // Not from inside this update: opening needs the
                            // window, whose update would come back here.
                            let (me, window) = (cx.entity().downgrade(), t.main_window);
                            cx.defer(move |cx| {
                                window
                                    .update(cx, |_, window, cx| {
                                        me.update(cx, |this, cx| this.open(id, window, cx)).ok()
                                    })
                                    .ok();
                            });
                        }
                    }
                    Err(e) if e.code == -32601 => t.show_error(
                        "This Mac's runner is too old for Find work for it. It updates by itself."
                            .into(),
                        cx,
                    ),
                    Err(e) => t.show_error(e.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn switch_account(&mut self, thread: &str, account: String, cx: &mut Context<Self>) {
        self.update_thread(thread, |_| {}, json!({ "accountId": account }), cx);
    }

    /// Whether the open thread's last turn failed with its login refused
    /// (`signInNeeded`: errorKind auth, signed out or its session ran out).
    pub(crate) fn sign_in_needed(&self, thread: &ThreadSummary, cx: &App) -> bool {
        thread.status == "error"
            && self.completion_for(&thread.id, cx).is_some_and(|c| {
                c.outcome == TurnOutcome::Failed && c.error_kind == Some(TurnErrorKind::Auth)
            })
    }

    /// `signInAccount`: this Mac's login to sign in again. Never another
    /// runner's thread (its login is signed in on that Mac). A missing
    /// secondary login cannot fall back to another login (sign_in.rs).
    pub(crate) fn sign_in_account(
        &self,
        thread: &ThreadSummary,
        cx: &App,
    ) -> Option<SignInAccount> {
        if !self.sign_in_needed(thread, cx) {
            return None;
        }
        let known = self
            .logins
            .account(&thread.account_id)
            .map(|a| SignInAccount {
                id: a.id.clone(),
                provider: a.provider_id().to_owned(),
                title: a.title.clone(),
                config_dir: a.config_dir.clone(),
            });
        let account = sign_in::account_for(
            &thread.account_id,
            &thread.provider,
            thread.runner_id.is_some(),
            known,
        )?;
        (!self.logins.login_command(&account.provider).is_empty()).then_some(account)
    }

    /// `remoteSignInRunner`: another Mac's thread whose login was refused,
    /// and the runner to sign in on.
    pub(crate) fn remote_sign_in_runner(&self, thread: &ThreadSummary, cx: &App) -> Option<String> {
        let runner = thread.runner_id.as_deref()?;
        self.sign_in_needed(thread, cx)
            .then(|| self.runner_name_of(runner))
    }

    pub(crate) fn render_signin_banner(
        &mut self,
        thread: &ThreadSummary,
        account: Option<SignInAccount>,
        remote: Option<String>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let hairline = style::hairline(cx);
        let orange = style::needs_you(cx);
        let id = thread.id.clone();
        // Where this login's confetti pops from once it's signed back in,
        // if the line's still up (confetti.rs).
        let anchor = account
            .as_ref()
            .map(|a| crate::confetti::anchor(format!("sign-in-line:{}", a.id)));
        let provider = account
            .as_ref()
            .map_or(thread.provider.as_str(), |a| a.provider.as_str());
        let fallback = threadbear_core::logins::RunnerLogins::default();
        let logins = match thread.runner_id.as_deref() {
            Some(id) => self.remote.logins.get(id).unwrap_or(&fallback),
            None => &self.logins,
        };
        let name = logins.provider_title(provider);
        // Which login, by id and email: Mike has several of each provider,
        // and "Claude needs you to sign in again" left him guessing which
        // (claude-1, 14 Nov).
        let who = match logins.account(&thread.account_id) {
            Some(a) => threadbear_core::usage::sign_in_label(a),
            None => thread.account_id.clone(),
        };
        // The id already names the provider (claude-1, codex-main), and the
        // line has to fit beside the Highlights pane.
        let login = if who.is_empty() { name.clone() } else { who };
        let (text, tip) = match (&account, &remote) {
            (Some(_), _) => (format!("{login} is signed out."), format!("{login} was refused: signed out, or its sign-in ended. Sign in… opens its own sign-in")),
            (None, Some(runner)) => {
                let command = logins.login_command(provider);
                let tip = if command.is_empty() { format!("Sign in on {runner} itself") } else { format!("Sign in on {runner} itself: {command} in its Terminal") };
                (format!("{login} on {runner} is signed out."), tip)
            }
            (None, None) => (format!("{login} is signed out."), "Sign in using that login's CLI, then send your last message again".into()),
        };
        h_flex()
            .flex_none()
            .px(px(14.))
            .py(px(7.))
            .gap(px(8.))
            .items_center()
            .border_b_1()
            .border_color(hairline)
            .text_size(px(style::size::LABEL))
            .child(icon(
                "person.crop.circle.badge.exclamationmark",
                13.,
                orange,
            ))
            .child(
                tipped!(
                    div()
                        .id("signin-text")
                        .relative()
                        .flex_1()
                        .min_w_0()
                        .truncate(),
                    tip,
                    gpui_kit::Role::GenericContainer
                )
                .child(text)
                .children(anchor),
            )
            // Another Mac's login is signed in on that Mac: Terminal here would
            // sign in this Mac's CLI.
            .when_some(account, |s, account| {
                let tip = format!("Opens Terminal on {name}'s own sign-in for this login");
                s.child(
                    tipped!(
                        div()
                            .id("signin-button")
                            .px(px(8.))
                            .py(px(3.))
                            .rounded(px(5.))
                            .bg(style::primary_opacity(cx, 0.08)),
                        tip
                    )
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.sign_in(account.clone(), cx)
                    }))
                    .child("Sign in…"),
                )
            })
            .child(
                tipped!(
                    div()
                        .id("signin-again")
                        .px(px(8.))
                        .py(px(3.))
                        .rounded(px(5.))
                        .bg(style::primary_opacity(cx, 0.08)),
                    "Send your last message again, once you've signed in"
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.send_again(&id, cx)))
                .child("Send again"),
            )
            .into_any_element()
    }

    /// Sign in… on a login's row in the Usage panel: this Mac's login by id.
    pub(crate) fn sign_in_login(&mut self, id: &str, cx: &mut Context<Self>) {
        let known = self.logins.account(id).map(|a| SignInAccount {
            id: a.id.clone(),
            provider: a.provider_id().to_owned(),
            title: a.title.clone(),
            config_dir: a.config_dir.clone(),
        });
        let provider = known
            .as_ref()
            .map(|a| a.provider.clone())
            .unwrap_or_default();
        match sign_in::account_for(id, &provider, false, known) {
            Some(account) if !self.logins.login_command(&account.provider).is_empty() => {
                self.sign_in(account, cx)
            }
            _ => self.show_error(
                format!(
                    "Threadbear can't sign {id} in from here: run its CLI's sign-in in Terminal."
                ),
                cx,
            ),
        }
    }

    /// Sign in…: Terminal on the CLI's own sign-in for that login, as the
    /// runner starts that CLI (`signIn`). A .command file rather than
    /// AppleScript, so macOS doesn't ask to let Threadbear control Terminal.
    /// The CLI's path is the runner's (Codex is often Threadbear's own copy,
    /// not on the PATH), asked for now so it's the one in use.
    pub(crate) fn sign_in(&mut self, account: SignInAccount, cx: &mut Context<Self>) {
        self.sign_in_as(account, false, cx);
    }

    /// Sign in…, then a year-long token for the same Claude login in the
    /// same Terminal window: the setup cards' Sign in… and Add.
    pub(crate) fn sign_in_for_a_year(&mut self, account: SignInAccount, cx: &mut Context<Self>) {
        self.sign_in_as(account, true, cx);
    }

    fn sign_in_as(&mut self, account: SignInAccount, year: bool, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let command = self.logins.login_command(&account.provider).to_owned();
        let name = self.logins.provider_title(&account.provider);
        cx.spawn(async move |this, cx| {
            let clis = call(client, "clis.list", json!({})).await.ok();
            let path = clis
                .as_ref()
                .and_then(|v| v["clis"].as_array())
                .and_then(|list| {
                    list.iter()
                        .find(|c| c["provider"].as_str() == Some(account.provider.as_str()))
                })
                .and_then(|c| c["path"].as_str())
                .unwrap_or("")
                .to_owned();
            let file = std::env::temp_dir().join(format!(
                "threadbear-sign-in-{}.command",
                sign_in::file_safe(&account.id)
            ));
            let script = if year {
                sign_in::sign_in_for_a_year_script(&account, &path, &command, &name)
            } else {
                sign_in::script_named(&account, &path, &command, &name)
            };
            let written = write_script(&file, &script);
            this.update(cx, |this, cx| match written {
                // The script this app just wrote, every word of it quoted.
                Ok(()) => crate::open_gate::open_own(&file, cx),
                Err(e) => this.show_error(format!("Couldn't open Terminal to sign in: {e}"), cx),
            })
            .ok();
        })
        .detach();
    }

    /// Year-long token… on a Claude login's Usage row: Terminal on
    /// `claude setup-token` for that login, through the app's own helper,
    /// which keeps the token in the login's folder (sign_in::token_script).
    /// The runner sees the new file on its next look at the logins.
    pub(crate) fn make_year_token(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(account) = self
            .logins
            .account(id)
            .map(|a| SignInAccount {
                id: a.id.clone(),
                provider: a.provider_id().to_owned(),
                title: a.title.clone(),
                config_dir: a.config_dir.clone(),
            })
            .filter(|a| a.provider == "claude" && a.can_sign_in())
        else {
            self.show_error(format!("Threadbear can't make a token for {id} from here: run claude setup-token for it in Terminal."), cx);
            return;
        };
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let clis = call(client, "clis.list", json!({})).await.ok();
            let path = clis
                .as_ref()
                .and_then(|v| v["clis"].as_array())
                .and_then(|list| {
                    list.iter()
                        .find(|c| c["provider"].as_str() == Some("claude"))
                })
                .and_then(|c| c["path"].as_str())
                .unwrap_or("")
                .to_owned();
            let file = std::env::temp_dir().join(format!(
                "threadbear-token-{}.command",
                sign_in::file_safe(&account.id)
            ));
            let written = write_script(&file, &sign_in::token_script(&account, &path));
            this.update(cx, |this, cx| match written {
                Ok(()) => crate::open_gate::open_own(&file, cx),
                Err(e) => {
                    this.show_error(format!("Couldn't open Terminal to make a token: {e}"), cx)
                }
            })
            .ok();
        })
        .detach();
    }

    /// Sends the thread's last message of his again, after signing in
    /// (`sendAgain`).
    pub(crate) fn send_again(&mut self, thread: &str, cx: &mut Context<Self>) {
        if let Some(pane) = self.pane_for(thread, cx) {
            pane.update(cx, |p, cx| {
                if let Some(text) = p.last_user_text() {
                    p.send(text, None, cx);
                }
            });
        }
    }

    /// A thread's last turn's end, from its own pane: a pinned thread's auth
    /// failure, limit or refusal belongs to it, even while a different
    /// thread is open in the main panel.
    fn completion_for(&self, thread: &str, cx: &App) -> Option<TurnCompletion> {
        let pane = self.pane_for(thread, cx)?;
        let p = pane.read(cx);
        p.feed
            .model()
            .rows()
            .iter()
            .rev()
            .take(40)
            .find_map(|row| match &row.content {
                RowContent::Footer(c) => Some(c.clone()),
                _ => None,
            })
    }

    /// `refusalTarget`: a Claude turn the safeguards refused, with a Codex
    /// login that can carry on.
    pub(crate) fn refusal_target(
        &self,
        thread: &ThreadSummary,
        cx: &App,
    ) -> Option<(String, String)> {
        if thread.status != "error" || thread.provider != "claude" {
            return None;
        }
        let completion = self.completion_for(&thread.id, cx)?;
        if completion.outcome != TurnOutcome::Failed {
            return None;
        }
        let error = completion.error.as_deref()?.to_lowercase();
        let refused = error.contains("api error:")
            && (error.contains("reasoning_extraction")
                || (error.contains("safeguards flagged this message") && error.contains("claude")));
        if !refused {
            return None;
        }
        self.logins
            .accounts
            .iter()
            .find(|a| {
                a.provider == "codex"
                    && a.models.iter().any(|m| m.id == REFUSAL_MODEL)
                    && !a
                        .usage
                        .as_ref()
                        .is_some_and(|u| u["blocked"].as_bool() == Some(true))
                    && a.note.as_deref().unwrap_or("").is_empty()
            })
            .map(|a| (a.id.clone(), a.name()))
    }

    /// `RefusalOffer`: "Claude couldn't continue with this message." with
    /// Continue with Codex Sol, just above the box, as the Swift composer
    /// has it (it sat over the transcript at the top here before 12 Nov).
    /// None when the open thread's last turn wasn't refused.
    pub(crate) fn refusal_offer(
        app: &Entity<Threadbear>,
        thread_id: &str,
        cx: &App,
    ) -> Option<AnyElement> {
        let t = app.read(cx);
        // Any box's own thread, in the main panel or one of its own.
        let thread = t.threads.get(thread_id)?;
        let (account, title) = t.refusal_target(thread, cx)?;
        let continuing = t.continuing_refusal.contains(thread_id);
        Some(Self::render_refusal_offer(
            app.downgrade(),
            thread_id.to_owned(),
            account,
            title,
            continuing,
            cx,
        ))
    }

    fn render_refusal_offer(
        app: WeakEntity<Threadbear>,
        id: String,
        account: String,
        title: String,
        continuing: bool,
        cx: &App,
    ) -> AnyElement {
        let tip = format!("Move this thread to {title} on GPT-6.1-Sol and continue the task. Your draft stays in the box.");
        let (hairline, fill, secondary) = (
            style::hairline(cx),
            style::card_background(cx),
            style::secondary_text(cx),
        );
        h_flex()
            .flex_none()
            .w_full()
            .mb(px(8.))
            .p(px(12.))
            .gap(px(12.))
            .items_center()
            .rounded(px(12.))
            .bg(fill)
            .border_1()
            .border_color(hairline)
            .text_size(px(style::size::LABEL))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_color(secondary)
                    .child("Claude couldn't continue with this message."),
            )
            .child(
                tipped!(
                    div()
                        .id("refusal-continue")
                        .px(px(10.))
                        .py(px(4.))
                        .rounded(px(6.))
                        .bg(style::primary_opacity(cx, 0.1))
                        .when(continuing, |s| s.opacity(0.5)),
                    tip
                )
                .when(!continuing, |s| {
                    s.cursor_pointer().on_click(move |_: &ClickEvent, _, cx| {
                        if let Some(app) = app.upgrade() {
                            app.update(cx, |this, cx| {
                                this.continue_refusal(id.clone(), account.clone(), cx)
                            });
                        }
                    })
                })
                .child(if continuing {
                    "Continuing…"
                } else {
                    "Continue with Codex Sol"
                }),
            )
            .into_any_element()
    }

    /// `continueRefusal`: moves the thread to the Codex login, then sends the
    /// continuation; the draft stays where it is.
    pub(crate) fn continue_refusal(
        &mut self,
        thread: String,
        account: String,
        cx: &mut Context<Self>,
    ) {
        if !self.continuing_refusal.insert(thread.clone()) {
            return;
        }
        cx.notify();
        let client = self.client.clone();
        // The runner it's shown on, as every send says it (thread.rs, Daybreak 113).
        let runner_id = self.threads.get(&thread).and_then(|t| t.runner_id.clone());
        let params = json!({ "threadId": thread, "accountId": account, "model": REFUSAL_MODEL });
        let going = crate::call_action(client.clone(), "threads.update", params);
        cx.spawn(async move |this, cx| {
            let moved = going.await;
            let sent = match &moved {
                Ok(v) if v["thread"]["provider"] == "codex" => crate::call_action(client, "threads.send", json!({ "threadId": thread, "text": REFUSAL_CONTINUATION, "runnerId": runner_id })).await.map(|_| ()),
                Ok(_) => Err(threadbear_client::runner::RpcError { code: -1, message: "Codex Sol is no longer available. Choose a model to carry on.".into(), data: None }),
                Err(e) => Err(e.clone()),
            };
            this.update(cx, |this, cx| {
                this.continuing_refusal.remove(&thread);
                if let Err(e) = sent {
                    this.show_error(e.message, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Shows `message` in the error bar (`showError`).
    pub(crate) fn show_error(&mut self, message: String, cx: &mut Context<Self>) {
        self.error_message = Some(message);
        cx.notify();
    }

    /// The error bar, about not being connected: out of date, and so gone,
    /// once the app's connected again (`showConnectionError`).
    pub(crate) fn show_connection_error(&mut self, message: String, cx: &mut Context<Self>) {
        self.connection_error = Some(message.clone());
        self.show_error(message, cx);
    }

    /// Connected again: a bar about not being connected goes, unless
    /// something else has taken its place (`clearConnectionError`).
    pub(crate) fn clear_connection_error(&mut self) {
        if let Some(stale) = self.connection_error.take() {
            if self.error_message.as_deref() == Some(stale.as_str()) {
                self.error_message = None;
            }
        }
    }

    /// A send that didn't go, its words back in the thread's box
    /// (`showSendFailed`). A lost connection's banner goes once the app
    /// reconnects, seconds later, and Mike may have moved on to another
    /// thread by then, so this one names the thread and stays until he
    /// dismisses it. `held`: it waited for a restarting runner that didn't
    /// come back.
    pub(crate) fn show_send_failed(
        &mut self,
        error: &threadbear_client::runner::RpcError,
        title: &str,
        held: bool,
        cx: &mut Context<Self>,
    ) {
        use threadbear_client::runner::{CLOSED, NOT_CONNECTED, TIMED_OUT};
        let what = match error.code {
            NOT_CONNECTED if held => {
                return self.show_connection_error(crate::thread::NOT_CONNECTED_TEXT.to_owned(), cx)
            }
            NOT_CONNECTED => "Couldn't reach the runner.".to_owned(),
            CLOSED => "Lost the connection to the runner.".to_owned(),
            TIMED_OUT => "The runner didn't answer in time.".to_owned(),
            _ => return self.show_error(error.message.clone(), cx),
        };
        self.show_error(send_failed_text(&what, title, error.code == TIMED_OUT), cx);
    }

    fn dismiss_error(&mut self, cx: &mut Context<Self>) {
        self.error_message = None;
        cx.notify();
    }

    /// The checkout this app follows, where a thread can fix it
    /// (`ownCheckout`): the one the runner follows main in, or a fork's
    /// release checkout, or for a debug build the one it was compiled from,
    /// when the file is there. None when there's nowhere to work.
    fn own_checkout(&self) -> Option<String> {
        if let Some(checkout) = self
            .runner_checkout
            .clone()
            .or_else(|| self.upstream_checkout.clone())
        {
            return Some(checkout);
        }
        if cfg!(debug_assertions) {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            if path.join("AGENTS.md").exists() {
                return path
                    .canonicalize()
                    .ok()
                    .map(|p| p.to_string_lossy().to_string());
            }
        }
        None
    }

    /// The error bar's Investigate: a new thread in the app's own checkout
    /// that finds the error's cause and fixes it; the bar goes and the new
    /// thread opens once it's made (`investigateError`).
    pub(crate) fn investigate_error(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(message), Some(checkout)) = (self.error_message.clone(), self.own_checkout())
        else {
            return;
        };
        if self.creating_investigation {
            return;
        }
        self.creating_investigation = true;
        cx.notify();
        let client = self.client.clone();
        // What the app knew, so the thread doesn't start from the bar's words
        // alone (`errorReport`): the open thread, when, and the versions.
        let open = self.open_thread();
        let report = threadbear_core::investigate::Report {
            message,
            at: threadbear_core::investigate::now_text(),
            thread_id: open.map(|t| t.id.clone()),
            thread_title: open.map(|t| t.title.clone()),
            thread_folder: open.map(|t| t.cwd.clone()),
            app_version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            runner_version: Some(self.runner_version.clone()),
        };
        let params = json!({ "cwd": checkout, "text": threadbear_core::investigate::prompt(&report), "title": threadbear_core::investigate::title(&report), "permissionMode": "full" });
        let reported = report.message;
        let going = crate::call_action(client, "threads.create", params);
        cx.spawn_in(window, async move |this, cx| {
            let res = going.await;
            this.update_in(cx, |this, window, cx| {
                this.creating_investigation = false;
                match res {
                    Ok(v) => {
                        // Only the error it was about: another may have come
                        // up while the thread was being made.
                        if this.error_message.as_deref() == Some(reported.as_str()) {
                            this.error_message = None;
                        }
                        if let Ok(t) = serde_json::from_value::<ThreadSummary>(v["thread"].clone())
                        {
                            let id = t.id.clone();
                            this.store_reply_summary(t);
                            this.open(id, window, cx);
                        }
                    }
                    Err(e) => this.show_error(e.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Try again: says "Connecting to the runner…" until this try has an
    /// answer, so the click shows (`reconnectNow`).
    pub(crate) fn reconnect_now(&mut self, cx: &mut Context<Self>) {
        self.advance_connection(threadbear_core::connection::Event::TryAgain, cx);
        self.client.retry_now();
    }

    // The notes floating over the panel.

    pub(crate) fn render_toasts(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let _ = window;
        let overlay = div()
            .absolute()
            .top(px(10.))
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .items_start();
        if let Some(note) = self.archived_note.clone() {
            return overlay
                .child(self.render_archived_toast(note, cx))
                .into_any_element();
        }
        if let Some(note) = self.inbox_end_note {
            return overlay
                .child(self.render_inbox_end_toast(note, cx))
                .into_any_element();
        }
        if let Some(text) = self.import_note.clone() {
            return overlay
                .child(self.render_import_note(text, cx))
                .into_any_element();
        }
        if let Some(tier) = self.milestone.note {
            return overlay
                .child(self.render_milestone_toast(tier, cx))
                .into_any_element();
        }
        div().into_any_element()
    }

    pub(crate) fn toast_capsule(&self, id: &'static str, cx: &mut Context<Self>) -> Stateful<Div> {
        let bg = cx.theme().popover;
        let border = cx.theme().border;
        div()
            .id(id)
            .occlude()
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(14.))
            .py(px(7.))
            .rounded_full()
            .bg(bg)
            .border_1()
            .border_color(border)
            .shadow_lg()
            .text_size(px(style::size::LABEL))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.toast_hovered = *hovered;
                cx.notify();
            }))
    }

    /// "Archived" and the thread's name with Undo; a click on it opens the
    /// thread in the Archived section (`ArchivedToast`). An x, or a
    /// sideways swipe on a trackpad, puts it away; it follows the fingers
    /// and goes past `SWIPE_AWAY`, else springs back.
    fn render_archived_toast(
        &mut self,
        note: shell::ArchivedNote,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        const SWIPE_AWAY: f32 = 60.;
        let (secondary, separator, accent) = (
            style::secondary_text(cx),
            style::hairline(cx),
            style::accent(cx),
        );
        let title = if note.title.is_empty() {
            "Untitled".to_string()
        } else {
            note.title
        };
        let shift = self.toast_swipe.x;
        let fade = (1. - (f32::from(shift).abs() / (SWIPE_AWAY * 2.))).clamp(0.3, 1.);
        self.toast_capsule("archived-toast", cx)
            .relative()
            .left(shift)
            .opacity(fade)
            .on_scroll(cx.listener(|this, ev: &ScrollEvent, _, cx| {
                // A trackpad's own pixels only: a mouse wheel's lines have
                // no end to the gesture to spring back on.
                if !ev.delta.precise() {
                    return;
                }
                match ev.touch_phase {
                    TouchPhase::Ended | TouchPhase::Cancelled => {
                        if f32::from(this.toast_swipe.x).abs() > SWIPE_AWAY
                            && ev.touch_phase == TouchPhase::Ended
                        {
                            this.dismiss_archived_note(cx);
                        } else {
                            this.toast_swipe = Point::default();
                            cx.notify();
                        }
                    }
                    _ => {
                        let d = ev.delta.pixel_delta(px(16.));
                        // Sideways only: an up or down scroll is for the page under it.
                        if f32::from(d.x).abs() > f32::from(d.y).abs()
                            || this.toast_swipe.x != px(0.)
                        {
                            this.toast_swipe.x += d.x;
                            cx.stop_propagation();
                            cx.notify();
                        }
                    }
                }
            }))
            .child(
                tipped!(
                    h_flex().id("archived-open").gap(px(7.)).items_center(),
                    "Open this thread"
                )
                .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                    this.open_archived_note(window, cx)
                }))
                .child(icon("archivebox", style::size::LABEL, secondary))
                .child(div().text_color(secondary).child("Archived"))
                .child(div().max_w(px(280.)).truncate().child(title)),
            )
            .child(div().w(gpui_kit::px(1.)).h(px(14.)).bg(separator))
            .child(
                tipped!(
                    div()
                        .id("archived-undo")
                        .text_color(accent)
                        .font_weight(FontWeight::MEDIUM),
                    "Put it back in the inbox"
                )
                .on_click(
                    cx.listener(|this, _: &ClickEvent, window, cx| this.undo_archive(window, cx)),
                )
                .child("Undo"),
            )
            .child(
                tipped!(
                    div()
                        .id("archived-dismiss")
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(18.))
                        .rounded_full()
                        .cursor_pointer()
                        .hover(|d| d.bg(separator)),
                    "Dismiss (⌘Z still brings it back)"
                )
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.dismiss_archived_note(cx)))
                .child(icon("xmark", style::size::LABEL - 2., secondary)),
            )
            .into_any_element()
    }

    /// Next Inbox Thread with nowhere to go (`InboxEndToast`): a click takes
    /// it down.
    fn render_inbox_end_toast(
        &mut self,
        note: shell::InboxEndNote,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (secondary, green) = (style::secondary_text(cx), style::tick_green(cx));
        let (title, detail) = if note.empty {
            ("Inbox clear", "Nothing's waiting on you")
        } else {
            ("That's the end of the inbox", "You're all caught up")
        };
        self.toast_capsule("inbox-end-toast", cx)
            .gap(px(7.))
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.dismiss_inbox_end(cx)))
            .child(icon("checkmark.circle.fill", style::size::LABEL, green))
            .child(title)
            .child(div().text_color(secondary).child(detail))
            .into_any_element()
    }

    // For the automation and the specs.

    /// The header as `dump` reports it (`ThreadHeader`).
    #[cfg(feature = "automation")]
    pub(crate) fn header_dump(&self) -> Option<Value> {
        let t = self
            .open_thread()
            .filter(|_| self.home_page().is_none() && self.projects.open.is_none())?;
        let back_to = self.can_go_back().then(|| self.destination(true)).flatten();
        let forward_to = self
            .can_go_forward()
            .then(|| self.destination(false))
            .flatten();
        let back_key = self
            .shortcuts
            .key(ShortcutCommand::Back)
            .map(|k| k.display());
        let forward_key = self
            .shortcuts
            .key(ShortcutCommand::Forward)
            .map(|k| k.display());
        Some(json!({
            "title": if t.title.is_empty() { "Untitled" } else { t.title.as_str() },
            "renaming": self.renaming.as_deref() == Some(t.id.as_str()),
            "backTip": history_tip(true, back_to.as_deref(), back_key.as_deref()),
            "forwardTip": history_tip(false, forward_to.as_deref(), forward_key.as_deref()),
            "shared": share_is_on(t),
            // The bar over the thread with reviews waiting (review_window.rs).
            "pendingReviews": t.pending_reviews.filter(|n| *n > 0).map(threadbear_core::review::pending_button_title),
        }))
    }

    /// `banner` in the dump (`AppDump.BannerInfo`).
    #[cfg(feature = "automation")]
    pub(crate) fn banner_dump(&self) -> Value {
        match self.connection_banner() {
            Some(b) => {
                json!({ "style": if b.quiet { "quiet" } else { "warning" }, "text": b.text, "detail": b.detail })
            }
            None => Value::Null,
        }
    }

    /// The share popover's state, as the Swift `share` command says it.
    #[cfg(feature = "automation")]
    pub(crate) fn share_status(&self) -> String {
        let Some(t) = self.open_thread() else {
            return "error no thread is open".into();
        };
        let access = t
            .share
            .as_ref()
            .and_then(|s| s["access"].as_str())
            .unwrap_or("off");
        let link = self.share_link(t).unwrap_or_else(|| "none".into());
        let web = self.thread_web_link(&t.id).unwrap_or_else(|| "none".into());
        format!(
            "ok access {access} link {link} popover {} web {web}",
            if self.share_popover.as_deref() == Some(t.id.as_str()) {
                "shown"
            } else {
                "closed"
            }
        )
    }

    #[cfg(feature = "automation")]
    pub(crate) fn signin_status(&self, cx: &App) -> String {
        match self.open_thread().and_then(|t| self.sign_in_account(t, cx)) {
            Some(account) => format!(
                "ok {} {}",
                account.id,
                self.open_thread()
                    .map(|t| t.provider.clone())
                    .unwrap_or_default()
            ),
            None => "ok none".into(),
        }
    }

    #[cfg(feature = "automation")]
    pub(crate) fn refusal_status(&self, cx: &App) -> String {
        match self.open_thread().and_then(|t| self.refusal_target(t, cx)) {
            Some((account, _)) => format!("ok {account} {REFUSAL_MODEL}"),
            None => "ok none".into(),
        }
    }
}

/// `RefusalRecovery.model` and `continuation`.
const REFUSAL_MODEL: &str = "gpt-6.1-sol";
const REFUSAL_CONTINUATION: &str = "Please continue with the task from where it stopped.";

fn share_is_on(thread: &ThreadSummary) -> bool {
    thread.share.as_ref().is_some_and(|s| s["access"] == "link")
}

/// The site for the runner's `runner.status` `sync`: its `site`, else the
/// deployment's .convex.site host (`RunnerStatus.websiteURL`).
pub(crate) fn website_url(status: &Value) -> Option<String> {
    let sync = status.get("sync")?;
    if let Some(site) = sync["site"].as_str().filter(|s| s.starts_with("https://")) {
        return Some(site.to_string());
    }
    let url = sync["url"].as_str()?;
    url.contains(".convex.cloud")
        .then(|| url.replace(".convex.cloud", ".convex.site"))
}

/// An SF Symbol's icon, at a point size and in a colour.
fn icon(name: &str, size: f32, color: Hsla) -> Icon {
    icons::symbol(name).with_size(px(size)).text_color(color)
}

/// `abbreviatingHome`, for tooltips.
fn abbreviate(path: &str) -> String {
    threadbear_core::new_thread::abbreviate_home(path, &crate::files::home_dir())
}

/// The sign-in script, readable and runnable by Mike only, written whole:
/// into a new file of its own (never through whatever's at that name, a
/// symlink in a shared /tmp included), then renamed over the old one, as
/// Swift's `write(to:atomically:)` does (`private_file`).
fn write_script(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    threadbear_core::private_file::write_with_mode(path, text.as_bytes(), 0o700)
}

/// The error bar's words for a send that didn't go (`show_send_failed`).
/// `unanswered`: the runner never answered, and the message wasn't in the
/// thread when the app looked, but a stalled runner may still take it, so
/// it doesn't say it wasn't sent.
fn send_failed_text(what: &str, title: &str, unanswered: bool) -> String {
    let title = title.trim();
    let name = if title.is_empty() {
        "this thread".to_owned()
    } else {
        format!("\u{201C}{title}\u{201D}")
    };
    if unanswered {
        format!("{what} Your message to {name} hasn't shown up there, so it's back in its box. It may still arrive: look before sending it again.")
    } else {
        format!("{what} Your message to {name} wasn't sent. It's back in its box.")
    }
}

/// What a Use a reset spins under: the login's id on this Mac's runner,
/// `runner/id` on another's, as the same id there is another login.
pub(crate) fn reset_key(runner: Option<&str>, account: &str) -> String {
    match runner {
        Some(runner) => format!("{runner}/{account}"),
        None => account.to_owned(),
    }
}

#[cfg(test)]
mod send_failed_tests {
    use super::send_failed_text;

    #[test]
    fn a_send_with_no_answer_doesnt_say_it_wasnt_sent() {
        let text = send_failed_text("The runner didn't answer in time.", "Daily brief", true);
        assert!(!text.contains("wasn't sent"), "{text}");
        assert!(
            text.contains("\u{201C}Daily brief\u{201D}") && text.contains("back in its box"),
            "{text}"
        );
    }

    #[test]
    fn a_lost_connection_says_it_wasnt_sent() {
        assert_eq!(send_failed_text("Couldn't reach the runner.", "  ", false), "Couldn't reach the runner. Your message to this thread wasn't sent. It's back in its box.");
    }
}
