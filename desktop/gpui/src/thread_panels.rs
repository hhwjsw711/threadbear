// The panels round the main one (the Swift app's ThreadPanels.swift, and the
// Threads panel's toggles in AppModel+Chrome.swift):
//
// - the Threads panel folded away with ⌘/ and back as it was;
// - a thread open in a panel of its own (Open in New Panel), which stays put
//   whatever the sidebar picks, with its title line and menus in its bar and
//   its transcript and box under them, as in the main panel. Picking it again
//   anywhere brings its panel to the front. One transcript is drawn in one
//   place, so a main panel left with it selected says so (`OpenElsewhereNote`);
// - tabs opened beside the main panel for what it shows (an agent's
//   show_panel as a tab), which close when the main panel moves on unless
//   they've been dragged out of its group.
use crate::app::Threadbear;
use crate::shell::{SidebarMode, MAIN, THREADS};
use crate::style::{self, px};
use crate::thread::ThreadPane;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;
use std::collections::{HashMap, HashSet};
use threadbear_dock::{DockDrop, DockEdge, DockLayout};

// A thread's own panel's id, the Swift app's, so a saved layout carries over.
pub(crate) use threadbear_core::thread_panels::{panel as thread_panel, pinned_thread};

/// What the app keeps for these panels (`Threadbear::thread_panels`).
#[derive(Default)]
pub(crate) struct ThreadPanels {
    /// Each thread open in a panel of its own, by thread: its transcript and
    /// box, made the first time the panel draws, and let go when it closes.
    panes: HashMap<String, PanelPane>,
    /// Tabs opened beside the main panel for what it shows now (`mainTabs`).
    main_tabs: HashSet<String>,
    /// Per-thread dynamic panels (PRs, files, folders) still in the dock group
    /// they opened into: panel id -> home group id. Dragging one out drops it
    /// here so it stays open across threads.
    pub(crate) thread_tabs: HashMap<String, String>,
    /// Per-thread dynamic panels hidden by View > Hide Panels on the current thread.
    pub(crate) hidden_thread_tabs: HashSet<String>,
    /// Per-thread dynamic panels closed when switching away, restored on return.
    pub(crate) saved_thread_tabs: HashMap<MainContext, SavedThreadTabs>,
    /// True while `main_context_maybe_changed` is closing tabs for a thread
    /// switch so `dock_layout_changed` keeps file/folder state cached for return.
    pub(crate) switching_context: bool,
    /// PR panel views, by panel id, let go when the panel closes (pr_view.rs).
    pub(crate) pr_views: HashMap<String, Entity<crate::pr_view::PrPanelView>>,
    /// File panel views, by panel id, let go when the panel closes (files.rs).
    pub(crate) file_views: HashMap<String, Entity<crate::files::FilePanelView>>,
    /// Folder panel views, by panel id, let go when the panel closes (folders.rs).
    pub(crate) folder_views: HashMap<String, Entity<crate::folders::FolderPanelView>>,
    /// What the main panel showed when last looked at.
    pub(crate) context: Option<MainContext>,
    /// Pinned list and picture panels' views, by panel id (pinned_panels.rs).
    pub(crate) pinned: HashMap<String, Entity<crate::pinned_panels::PinnedPanelView>>,
}

/// Un-moved per-thread panels remembered when leaving a thread, in tab order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SavedThreadTabs {
    pub(crate) panels: Vec<String>,
    pub(crate) selected: Option<String>,
}

struct PanelPane {
    pane: Entity<ThreadPane>,
    /// A thread: link in its transcript.
    _events: Subscription,
}

/// What the main panel shows: a thread, a project's page or one of the
/// activity bar's pages. Its tabs go when this changes.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct MainContext {
    pub(crate) thread: Option<String>,
    pub(crate) project: Option<String>,
    pub(crate) page: Option<SidebarMode>,
}

impl ThreadPanels {
    /// The panes of the threads open in panels of their own.
    pub(crate) fn panes(&self) -> impl Iterator<Item = &Entity<ThreadPane>> {
        self.panes.values().map(|p| &p.pane)
    }
}

impl Threadbear {
    // ---------------------------------------------------------------- the Threads panel

    /// ⌘/ folded the Threads panel away (`threadsCollapsed`). It stays in the
    /// layout with nothing to show (`panel_available`), so the dock gives its
    /// room to the rest and it comes back where it was, as wide as it was.
    pub(crate) fn threads_collapsed(&self) -> bool {
        self.settings.saved.threads_collapsed == Some(true)
    }

    /// The Threads panel is on screen: in the layout and not folded away
    /// (`threadsShowing`), which is what the View menu's titles go by.
    pub(crate) fn threads_showing(&self, cx: &App) -> bool {
        self.dock.read(cx).layout().contains(THREADS) && !self.threads_collapsed()
    }

    pub(crate) fn set_threads_collapsed(&mut self, collapsed: bool, cx: &mut Context<Self>) {
        if self.threads_collapsed() == collapsed {
            return;
        }
        self.settings.saved.threads_collapsed = collapsed.then_some(true);
        self.save_settings_soon(cx);
        // The dock asks what's available as it draws, so a redraw is all it
        // takes; the menus' titles follow (`menus_stale`).
        self.dock.update(cx, |_, cx| cx.notify());
        cx.notify();
    }

    /// ⌘/ (`toggleThreadsCollapsed`): folds the Threads panel away, or
    /// brings it back as it was. The activity bar stays. If Hide Threads had
    /// taken the panel out of the layout, this puts it back instead.
    pub(crate) fn toggle_threads_collapsed(&mut self, cx: &mut Context<Self>) {
        if !self.dock.read(cx).layout().contains(THREADS) {
            self.set_threads_collapsed(false, cx);
            self.dock.update(cx, |m, cx| {
                m.open(THREADS, DockDrop::window(DockEdge::Left), cx)
            });
            return;
        }
        let collapsed = !self.threads_collapsed();
        self.set_threads_collapsed(collapsed, cx);
    }

    /// A view's icon in the activity bar, or Show Inbox and the rest in the
    /// Thread menu, bring the Threads panel back if ⌘/ folded it away, as
    /// the Swift app's do.
    pub(crate) fn unfold_threads(&mut self, cx: &mut Context<Self>) {
        self.set_threads_collapsed(false, cx);
    }

    // ---------------------------------------------------------------- a thread in a panel of its own

    /// The pane of a thread open in a panel of its own, once it's drawn.
    pub(crate) fn thread_panel_pane(&self, id: &str) -> Option<Entity<ThreadPane>> {
        self.thread_panels.panes.get(id).map(|p| p.pane.clone())
    }

    /// Whether a thread is open in a panel of its own.
    pub(crate) fn has_thread_panel(&self, id: &str, cx: &App) -> bool {
        self.dock.read(cx).layout().contains(&thread_panel(id))
    }

    /// Open in New Panel (`openThreadInPanel`): a panel of its own to the
    /// right of the main panel, where it stays whatever the sidebar picks.
    /// The thread moves out of the main panel if it's there, taking its
    /// transcript with it, and the main panel goes to a new thread. One
    /// that's in a panel already comes to the front.
    pub(crate) fn open_thread_in_panel(&mut self, id: String, cx: &mut Context<Self>) {
        let panel = thread_panel(&id);
        if self.has_thread_panel(&id, cx) {
            self.dock.update(cx, |m, cx| {
                m.show(&panel, &[], DockDrop::window(DockEdge::Right), cx)
            });
            return;
        }
        if !self.threads.contains_key(&id) {
            return;
        }
        if self.selected.as_deref() == Some(id.as_str()) {
            self.close_subagent(cx);
            // Its transcript goes with it, still reading the thread, rather
            // than the thread being read again from the start.
            if self
                .pane
                .as_ref()
                .is_some_and(|p| p.read(cx).summary.id == id)
            {
                if let Some(pane) = self.pane.take() {
                    self.pane_events = None;
                    self.keep_panel_pane(id, pane, cx);
                }
            }
            self.new_thread(cx);
        }
        let drop = match self.dock.read(cx).layout().group_containing(MAIN) {
            Some(main) => DockDrop::edge(main.id, DockEdge::Right),
            None => DockDrop::window(DockEdge::Right),
        };
        self.dock.update(cx, |m, cx| m.open(&panel, drop, cx));
        cx.notify();
    }

    /// Move to Main Panel, and the note's Show it here: the panel closes and
    /// the thread shows in the main panel, its transcript carried over.
    pub(crate) fn move_to_main_panel(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let moved = self.thread_panels.panes.remove(&id).map(|p| p.pane);
        self.dock
            .update(cx, |m, cx| m.close(&thread_panel(&id), cx));
        // Selected behind the note (Back went to it): not open there yet.
        if self.selected.as_deref() == Some(id.as_str()) && self.pane.is_none() {
            self.selected = None;
        }
        self.open_with(id, moved, window, cx);
    }

    /// A thread named from anywhere (its row, a link, Back): shown in its
    /// own panel if it has one, which comes to the front while the main
    /// panel stays as it is, as the Swift app's `select` does (Back
    /// included, which `show(place)` sends through `select`). Says whether
    /// it did.
    pub(crate) fn open_in_its_panel(&mut self, id: &str, cx: &mut Context<Self>) -> bool {
        if !self.has_thread_panel(id, cx) {
            return false;
        }
        let panel = thread_panel(id);
        self.dock.update(cx, |m, cx| {
            m.show(&panel, &[], DockDrop::window(DockEdge::Right), cx)
        });
        // Seen now, if its tab was behind another.
        self.mark_thread_panels_seen(cx);
        true
    }

    /// The thread the main panel has selected but can't show, as it's open
    /// in a panel of its own. Opening a thread sends it to its own panel, so
    /// no click leaves the window like this, in either app: it's the Swift
    /// app's safety net (DetailView's `OpenElsewhereNote` branch), kept so a
    /// transcript is never drawn in two places.
    pub(crate) fn open_elsewhere(&self, cx: &App) -> Option<String> {
        let id = self.selected.clone()?;
        (self.pane.is_none()
            && self.home_page().is_none()
            && self.projects.open.is_none()
            && self.has_thread_panel(&id, cx))
        .then_some(id)
    }

    /// Takes a pane on as a thread's panel's, opening a thread: link in it
    /// in the main panel.
    fn keep_panel_pane(&mut self, id: String, pane: Entity<ThreadPane>, cx: &mut Context<Self>) {
        let events = cx.subscribe(
            &pane,
            |this, _, event: &crate::rows::OpenThreadRequest, cx| {
                this.open_linked_from_panel(event.0.clone(), cx)
            },
        );
        self.thread_panels.panes.insert(
            id,
            PanelPane {
                pane,
                _events: events,
            },
        );
    }

    /// A thread: link clicked in a panel's transcript (its id or a unique
    /// start of one). The panel can be in a window of its own, so the main
    /// window does the opening, once this update's over.
    fn open_linked_from_panel(&mut self, start: String, cx: &mut Context<Self>) {
        let matches: Vec<String> = self
            .threads
            .keys()
            .filter(|k| **k == start || k.starts_with(&start))
            .cloned()
            .collect();
        let [only] = matches.as_slice() else { return };
        let (id, me, window) = (only.clone(), cx.entity().downgrade(), self.main_window);
        cx.defer(move |cx| {
            window
                .update(cx, |_, window, cx| {
                    me.update(cx, |this, cx| this.open(id, window, cx)).ok();
                })
                .ok();
        });
    }

    /// The panel's title: the thread's, as in the main panel.
    pub(crate) fn thread_panel_title(&self, panel: &str) -> Option<String> {
        let id = pinned_thread(panel)?;
        let title = self
            .threads
            .get(id)
            .map(|t| t.title.clone())
            .unwrap_or_default();
        Some(if title.is_empty() {
            "Untitled".into()
        } else {
            title
        })
    }

    /// The panel's bar: the thread's title line (`HeaderTitle`).
    pub(crate) fn thread_panel_header(
        &mut self,
        panel: &str,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let thread = self
            .threads
            .get(pinned_thread(panel)?)
            .map(|t| (**t).clone())?;
        Some(self.render_thread_title(thread, cx))
    }

    /// The end of its bar: Share and the ... menu, but no back and forward,
    /// which are the main panel's (`ShareButton(pinned:)`, `ThreadMenuButton(pinned:)`).
    pub(crate) fn thread_panel_buttons(
        &mut self,
        panel: &str,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let thread = self
            .threads
            .get(pinned_thread(panel)?)
            .map(|t| (**t).clone())?;
        let share = self
            .website_url
            .is_some()
            .then(|| self.render_share_button(&thread, cx));
        let more = self.render_more_button(&thread, cx);
        Some(
            h_flex()
                .flex_none()
                .items_center()
                .children(share)
                .child(more)
                .into_any_element(),
        )
    }

    /// The pane of the thread in a panel of its own whose box (or a card's
    /// Something else box) has the focus: what a menu command or its key
    /// acts on in place of the main panel's thread.
    pub(crate) fn focused_panel_pane(
        &self,
        window: &Window,
        cx: &App,
    ) -> Option<Entity<ThreadPane>> {
        self.thread_panels
            .panes()
            .find(|pane| {
                pane.read(cx)
                    .composer
                    .read(cx)
                    .native_paste_target(window, cx)
                    .is_some()
            })
            .cloned()
    }

    /// The thread a menu command (Archive, Stop, Hibernate, Copy
    /// Transcript) acts on: one in a panel of its own while its box has the
    /// focus, else the main panel's.
    pub(crate) fn command_thread(&self, window: &Window, cx: &App) -> Option<String> {
        match self.focused_panel_pane(window, cx) {
            Some(pane) => Some(pane.read(cx).summary.id.clone()),
            None => self.selected.clone(),
        }
    }

    /// What a thread's own panel shows (`PinnedThreadView`): its sign-in
    /// line and its reviews waiting over its transcript and box, as in the
    /// main panel.
    pub(crate) fn thread_panel_view(
        &mut self,
        panel: &str,
        ghost: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // A drag's ghost is the empty panel: a transcript is drawn in one place.
        let Some(thread) = pinned_thread(panel)
            .and_then(|id| self.threads.get(id))
            .cloned()
            .filter(|_| !ghost)
        else {
            return div().size_full().into_any_element();
        };
        let pane = match self.thread_panel_pane(&thread.id) {
            Some(pane) => pane,
            None => {
                // Another runner's thread: its logins fill the pickers once they've come.
                if let Some(runner) = thread.runner_id.clone() {
                    self.load_remote_logins(runner, cx);
                }
                let composer = self.composer_for(&thread.id, window, cx);
                let (client, summary) = (self.client.clone(), (*thread).clone());
                // One kept loaded since it was last open shows at once.
                let pane = match self.kept.take(&thread.id, cx) {
                    Some(pane) => {
                        pane.update(cx, |p, cx| {
                            p.summary_changed(&summary, cx);
                            p.shown_again(cx);
                        });
                        pane
                    }
                    None => cx.new(|cx| ThreadPane::new(client, summary, composer.clone(), cx)),
                };
                composer.update(cx, |c, cx| {
                    c.attach(pane.downgrade());
                    cx.notify();
                });
                self.keep_panel_pane(thread.id.clone(), pane.clone(), cx);
                pane
            }
        };
        let mut column = v_flex().size_full();
        let (account, remote) = (
            self.sign_in_account(&thread, cx),
            self.remote_sign_in_runner(&thread, cx),
        );
        if self.sign_in_needed(&thread, cx) {
            column = column.child(self.render_signin_banner(&thread, account, remote, cx));
        }
        if let Some(bar) = self.pending_reviews_bar(&thread, cx) {
            column = column.child(bar);
        }
        column
            .child(div().flex_1().min_h_0().child(pane))
            .into_any_element()
    }

    /// In the main panel, for a thread that's open in a panel of its own
    /// (reached by Back, say): it can only show in one place at a time
    /// (`OpenElsewhereNote`).
    pub(crate) fn render_open_elsewhere(
        &mut self,
        id: String,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let me = cx.entity().downgrade();
        let (go_id, here_id, here_me) = (id.clone(), id, me.clone());
        let go = crate::push_button::PushButton::new(
            "elsewhere-go",
            "Go to it",
            "Bring its panel to the front",
        )
        .render(cx, move |_, _, cx| {
            let panel = thread_panel(&go_id);
            me.update(cx, |this, cx| {
                this.dock.update(cx, |m, cx| {
                    m.show(&panel, &[], DockDrop::window(DockEdge::Right), cx)
                });
                this.mark_thread_panels_seen(cx);
            })
            .ok();
        });
        let here = crate::push_button::PushButton::new(
            "elsewhere-here",
            "Show it here",
            "Close its panel and show the thread in the main panel",
        )
        .render(cx, move |_, window, cx| {
            here_me
                .update(cx, |this, cx| {
                    this.move_to_main_panel(here_id.clone(), window, cx)
                })
                .ok();
        });
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap(px(10.))
            .child(
                div()
                    .text_size(px(style::size::LABEL))
                    .line_height(px(style::natural_line(style::size::LABEL)))
                    .text_color(style::secondary_text(cx))
                    .child("This thread is open in its own panel."),
            )
            .child(h_flex().gap(px(8.)).child(go).child(here))
            .into_any_element()
    }

    /// A thread was deleted: its panel goes too (`forget`).
    pub(crate) fn close_thread_panel(&mut self, id: &str, cx: &mut Context<Self>) {
        let panel = thread_panel(id);
        if self.dock.read(cx).layout().contains(&panel) {
            self.dock.update(cx, |m, cx| m.close(&panel, cx));
        }
    }

    /// Reads the threads in panels of their own that are in front (their
    /// tab's showing, or they have a window of their own), as the main
    /// panel's thread is read: only while one of the app's windows is.
    pub(crate) fn mark_thread_panels_seen(&mut self, cx: &mut Context<Self>) {
        let showing: Vec<Entity<ThreadPane>> = self
            .thread_panels
            .panes
            .iter()
            .filter(|(id, _)| self.dock.read(cx).is_showing(&thread_panel(id)))
            .map(|(_, p)| p.pane.clone())
            .collect();
        for pane in showing {
            pane.update(cx, |p, _| {
                p.behind = false;
                p.mark_seen();
            });
        }
    }

    /// After every layout change (`dockChanged`): a tab dragged out of the
    /// main panel's group is Mike's to keep, panels that closed let go of
    /// their threads, and each thread's panel knows whether it's in front.
    /// A thread whose panel closed while the main panel had it selected
    /// behind the note shows there again, still reading.
    pub(crate) fn thread_panels_layout_changed(
        &mut self,
        layout: &DockLayout,
        cx: &mut Context<Self>,
    ) {
        let main = layout.group_containing(MAIN);
        self.thread_panels
            .main_tabs
            .retain(|p| main.as_ref().is_some_and(|g| g.panels.contains(p)));
        let gone: Vec<String> = self
            .thread_panels
            .panes
            .keys()
            .filter(|id| !layout.contains(&thread_panel(id)))
            .cloned()
            .collect();
        let main_thread = self.pane.as_ref().map(|p| p.read(cx).summary.id.clone());
        for id in gone {
            let Some(left) = self.thread_panels.panes.remove(&id) else {
                continue;
            };
            if self.selected.as_deref() == Some(id.as_str()) && self.pane.is_none() {
                let (me, window) = (cx.entity().downgrade(), self.main_window);
                cx.defer(move |cx| {
                    window
                        .update(cx, |_, window, cx| {
                            me.update(cx, |this, cx| {
                                this.selected = None;
                                this.open_with(id, Some(left.pane), window, cx);
                            })
                            .ok();
                        })
                        .ok();
                });
                continue;
            }
            // The main panel may be reading it now (Move to Main Panel).
            // Otherwise it's kept loaded, for opening again (pane_cache.rs).
            if main_thread.as_deref() != Some(id.as_str()) {
                self.kept.keep(left.pane, cx);
            }
        }
        for (id, panel) in &self.thread_panels.panes {
            let behind = !self.dock.read(cx).is_showing(&thread_panel(id));
            panel.pane.update(cx, |p, _| p.behind = behind);
        }
        self.mark_thread_panels_seen(cx);
    }

    // ---------------------------------------------------------------- tabs for what the main panel shows

    /// Opens a panel as a tab beside the main panel, for what it shows now
    /// (`openMainTab`). It closes when the main panel moves on, unless it's
    /// dragged out of the main panel's group first.
    pub(crate) fn open_main_tab(&mut self, panel: &str, cx: &mut Context<Self>) {
        let Some(main) = self.dock.read(cx).layout().group_containing(MAIN) else {
            self.dock.update(cx, |m, cx| {
                m.open(panel, DockDrop::window(DockEdge::Right), cx)
            });
            return;
        };
        self.thread_panels.main_tabs.insert(panel.to_owned());
        self.dock
            .update(cx, |m, cx| m.open(panel, DockDrop::tab(main.id), cx));
    }

    pub(crate) fn current_main_context(&self) -> MainContext {
        MainContext {
            thread: self.selected.clone(),
            project: self.projects.open.clone(),
            page: self.home_page(),
        }
    }

    /// Opens a per-thread dynamic panel (PR, file or folder) as a sibling tab
    /// beside `preferred_section` (default Highlights), then any open side
    /// panel, else down the right edge. Tracks it in `thread_tabs` so it
    /// follows the current thread until closed or dragged out.
    pub(crate) fn dock_thread_tab(
        &mut self,
        panel: &str,
        preferred_section: Option<&str>,
        cx: &mut Context<Self>,
    ) {
        if self.dock.read(cx).layout().contains(panel) {
            self.dock.update(cx, |m, cx| {
                m.show(panel, &[], DockDrop::window(DockEdge::Right), cx)
            });
            return;
        }
        if self.thread_panels.context.is_none() {
            self.thread_panels.context = Some(self.current_main_context());
        }
        // Prefer the requested section (e.g. Files when opened from Files),
        // then Highlights, then another open side panel or per-thread tab, so
        // a panel dragged elsewhere never hijacks new per-thread tabs. Know
        // its home group before opening so `dock_layout_changed` omits this
        // transient tab from `desktop-settings.json`.
        let target_group = {
            let layout = self.dock.read(cx).layout();
            preferred_section
                .and_then(|s| layout.group_containing(s))
                .or_else(|| layout.group_containing(crate::shell::HIGHLIGHTS))
                .map(|g| g.id)
                .or_else(|| {
                    self.open_panes(cx)
                        .into_iter()
                        .find_map(|p| layout.group_containing(&p).map(|g| g.id))
                })
        };
        if let Some(group_id) = target_group {
            self.thread_panels
                .thread_tabs
                .insert(panel.to_owned(), group_id.clone());
            self.dock
                .update(cx, |m, cx| m.open(panel, DockDrop::tab(group_id), cx));
        } else {
            self.dock.update(cx, |m, cx| {
                m.open(panel, DockDrop::window(DockEdge::Right), cx)
            });
            if let Some(group) = self.dock.read(cx).layout().group_containing(panel) {
                self.thread_panels
                    .thread_tabs
                    .insert(panel.to_owned(), group.id);
                let layout = self.dock.read(cx).layout().clone();
                self.settings.saved.dock_layout =
                    serde_json::to_value(self.layout_for_save(&layout)).ok();
                self.save_settings_soon(cx);
            }
        }
    }

    /// Reopens a thread's un-moved PR, file and folder panels when returning.
    pub(crate) fn restore_thread_tabs(&mut self, saved: SavedThreadTabs, cx: &mut Context<Self>) {
        let open_panes = self.open_panes(cx);
        if saved.selected.is_none() && open_panes.is_empty() {
            return;
        }
        let prev_selected = open_panes.into_iter().find_map(|p| {
            self.dock
                .read(cx)
                .layout()
                .group_containing(&p)
                .map(|g| g.selected)
        });
        for panel in &saved.panels {
            if self.dock.read(cx).layout().contains(panel) {
                continue;
            }
            if let Some(url) = threadbear_core::pull_requests::panel_url(panel) {
                self.open_pr_panel(url, None, cx);
            } else if threadbear_core::highlights::file_panel_path(panel).is_some() {
                self.reopen_file_panel(panel, cx);
            } else if threadbear_core::highlights::folder_panel_path(panel).is_some() {
                self.reopen_folder_panel(panel, cx);
            }
        }
        let select = saved.selected.or(prev_selected);
        if let Some(sel) = select {
            if self.dock.read(cx).layout().contains(&sel) {
                self.dock.update(cx, |m, cx| m.select(&sel, cx));
            }
        }
    }

    /// After a dock layout change: a per-thread panel dragged out of its home
    /// group stays open across threads, closed views are dropped, and
    /// user-closed file/folder panels flush edits and update `pane_store`.
    pub(crate) fn thread_tabs_layout_changed(
        &mut self,
        layout: &DockLayout,
        cx: &mut Context<Self>,
    ) {
        let switching = self.thread_panels.switching_context;
        let closed_files: Vec<String> = if switching {
            vec![]
        } else {
            self.thread_panels
                .file_views
                .keys()
                .filter(|p| !layout.contains(p))
                .cloned()
                .collect()
        };
        let closed_folders: Vec<String> = if switching {
            vec![]
        } else {
            self.thread_panels
                .folder_views
                .keys()
                .filter(|p| !layout.contains(p))
                .cloned()
                .collect()
        };
        let mut preview_changed = !closed_files.is_empty() || !closed_folders.is_empty();
        self.thread_panels.thread_tabs.retain(|panel, home| {
            let still_home = layout
                .group_containing(panel)
                .is_some_and(|g| g.id == *home);
            if !still_home && threadbear_core::highlights::is_preview_panel(panel) {
                preview_changed = true;
            }
            still_home
        });
        self.thread_panels
            .pr_views
            .retain(|panel, _| layout.contains(panel));
        self.thread_panels
            .file_views
            .retain(|panel, _| layout.contains(panel));
        self.thread_panels
            .folder_views
            .retain(|panel, _| layout.contains(panel));
        if !closed_files.is_empty() || !closed_folders.is_empty() {
            self.side.update(cx, |s, cx| {
                for panel in &closed_files {
                    s.drop_file_panel(panel, cx);
                }
                for panel in &closed_folders {
                    s.drop_folder_panel(panel);
                }
            });
        }
        if preview_changed && !switching {
            self.save_thread_pane_store(layout, cx);
        }
    }

    /// The main panel moved to another thread, a new thread, a page or a
    /// project (`mainContextChanged`): the tabs opened for what it showed
    /// before go, and its own tab comes to the front. Per-thread PR, file and
    /// folder panels still in their home group are remembered for this context,
    /// closed, and restored if the new context had any (or from `pane_store`
    /// on first visit after launch). Run whenever the app changes, as that's
    /// every way the main panel can move on.
    pub(crate) fn main_context_maybe_changed(&mut self, cx: &mut Context<Self>) {
        let now = self.current_main_context();
        let before = self.thread_panels.context.replace(now.clone());
        let Some(prev) = before else {
            if self.pane_thread().is_some() {
                self.restore_pane_store_panels(cx);
            }
            return;
        };
        if prev == now {
            if self.pane_thread().is_some() {
                self.restore_pane_store_panels(cx);
            }
            return;
        }
        let layout = self.dock.read(cx).layout().clone();
        let main = layout.group_containing(MAIN);
        let stale: Vec<String> = self
            .thread_panels
            .main_tabs
            .drain()
            .filter(|p| main.as_ref().is_some_and(|g| g.panels.contains(p)))
            .collect();
        let closing_tabs: Vec<String> = layout
            .panels()
            .into_iter()
            .filter(|p| self.thread_panels.thread_tabs.contains_key(p))
            .collect();
        let selected_tab = closing_tabs
            .iter()
            .find(|p| self.dock.read(cx).is_showing(p))
            .cloned();
        if closing_tabs.is_empty() {
            self.thread_panels.saved_thread_tabs.remove(&prev);
        } else {
            self.thread_panels.saved_thread_tabs.insert(
                prev,
                SavedThreadTabs {
                    panels: closing_tabs.clone(),
                    selected: selected_tab,
                },
            );
        }
        // Flush any unsaved typing in file panels being hidden for this switch.
        if closing_tabs
            .iter()
            .any(|p| threadbear_core::highlights::file_panel_path(p).is_some())
        {
            self.side.update(cx, |s, cx| {
                for p in &closing_tabs {
                    if threadbear_core::highlights::file_panel_path(p).is_some() {
                        s.leave_edit(p, cx);
                    }
                }
            });
        }
        self.thread_panels.thread_tabs.clear();
        let hidden_tabs = std::mem::take(&mut self.thread_panels.hidden_thread_tabs);
        self.hidden_panes
            .retain(|p| !closing_tabs.contains(p) && !hidden_tabs.contains(p));
        let restore = self.thread_panels.saved_thread_tabs.remove(&now);

        let needs_main_select = main.as_ref().is_some_and(|g| g.selected != MAIN);
        if !stale.is_empty() || !closing_tabs.is_empty() || needs_main_select {
            self.thread_panels.switching_context = true;
            self.dock.update(cx, |m, cx| {
                for panel in stale.iter().chain(&closing_tabs) {
                    m.close(panel, cx);
                }
                if needs_main_select && m.layout().contains(MAIN) {
                    m.select(MAIN, cx);
                }
            });
            self.thread_panels.switching_context = false;
        }
        if let Some(saved) = restore {
            self.restore_thread_tabs(saved, cx);
        } else {
            self.restore_pane_store_panels(cx);
        }
    }

    /// The panels for the dump: each thread in a panel of its own, whether
    /// it's in front, and its transcript as the main one's is dumped.
    #[cfg(feature = "automation")]
    pub(crate) fn thread_panels_dump(&self, cx: &App) -> serde_json::Value {
        let layout = self.dock.read(cx).layout();
        let list: Vec<serde_json::Value> = layout
            .panels()
            .iter()
            .filter_map(|panel| {
                let id = pinned_thread(panel)?;
                let pane = self.thread_panels.panes.get(id);
                let thread = self.threads.get(id);
                Some(serde_json::json!({
                    "id": id,
                    // Its settings as its box's chips show them.
                    "mode": thread.map(|t| if t.permission_mode.is_empty() { "full" } else { t.permission_mode.as_str() }),
                    "archived": thread.is_some_and(|t| t.is_archived()),
                    "title": self.thread_panel_title(panel),
                    "showing": self.dock.read(cx).is_showing(panel),
                    "transcript": pane.map(|p| p.pane.read(cx).dump(cx)),
                }))
            })
            .collect();
        serde_json::json!(list)
    }
}

/// The automation's `open-panel`: a thread in a panel of its own, as the
/// row's Open in New Panel, and `move-to-main`, as Move to Main Panel.
#[cfg(feature = "automation")]
pub(crate) fn automation(
    app: &Entity<Threadbear>,
    cmd: &serde_json::Value,
    window: &mut Window,
    cx: &mut App,
) -> Result<serde_json::Value, String> {
    use gpui_kit::test::TestWindowExt as _;
    let start = cmd["id"]
        .as_str()
        .ok_or("id is the thread's id, or its start")?;
    let id = app.read(cx).thread_id_from(start)?;
    match cmd["cmd"].as_str() {
        Some("move-to-main") => {
            app.update(cx, |t, cx| t.move_to_main_panel(id.clone(), window, cx))
        }
        // `keepSelected`: the state the main panel's note is there for, which
        // no click reaches: the thread selected in the main panel as its own
        // panel opens (the Swift command does the same).
        _ if cmd["keepSelected"].as_bool() == Some(true) => app.update(cx, |t, cx| {
            if t.has_thread_panel(&id, cx) {
                return Err(format!("{id} is in a panel of its own already"));
            }
            t.open(id.clone(), window, cx);
            match t.pane.take() {
                Some(pane) if pane.read(cx).summary.id == id => {
                    t.pane_events = None;
                    t.keep_panel_pane(id.clone(), pane, cx);
                }
                other => t.pane = other,
            }
            let drop = match t.dock.read(cx).layout().group_containing(MAIN) {
                Some(main) => DockDrop::edge(main.id, DockEdge::Right),
                None => DockDrop::window(DockEdge::Right),
            };
            t.dock
                .update(cx, |m, cx| m.open(&thread_panel(&id), drop, cx));
            cx.notify();
            Ok(())
        })?,
        _ => app.update(cx, |t, cx| t.open_thread_in_panel(id.clone(), cx)),
    }
    // Drawn, so its transcript starts reading as a person would see it.
    window.render_frame(cx);
    Ok(serde_json::json!(format!("ok {id}")))
}
