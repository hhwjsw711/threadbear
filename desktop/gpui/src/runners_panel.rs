// The Runners panel, a port of the Swift app's RunnersPanel.swift: each
// machine the threads run on, whether it's up and for how long, the build it
// runs, and the threads running there, which open on a click; its CPU, memory
// and disk behind its name. The cards drag into Mike's order, the one the
// phone and Settings › Runners use. The words are threadbear_core::runners.
//
// `runners.list` is only asked at hello otherwise, so the panel asks again
// every 30 s while it's on show: who's online goes stale in a few minutes.
// The figures (`runners.stats`) only while some runner's details are open and
// the window can be seen: asking has every runner report every 10 s, a write
// each in the backend, and the panel stays docked all day (the Convex I/O
// work, 5 Nov).
use crate::a11y::A11yRole as _;
use crate::activity_panels::{
    about_button, button_row, dot, icon_button, panel_column, push_button, small_heading,
    system_green, system_orange, text_button, text_line,
};
use crate::app::Threadbear;
use crate::highlights::{tipped, tipped_as};
use crate::mac_switch::MacSwitch;
use crate::spinner::Spinner;
use crate::tips::Tip as _;
use crate::{call, icons, now_ms, shell, style};
use gpui_kit::base::{A11yDisabledExt as _, TestSupportExt as _};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::style::px;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use threadbear_core::inbox::{self, ThreadSummary};
use threadbear_core::login_share::{self as share, Share};
use threadbear_core::remote::{self, RunnerInfo};
use threadbear_core::remote_tokens::{self as tokens, Step};
use threadbear_core::runners::{self as rules, MachineStats, State};

/// Past this many a runner's running threads are a count: the panel is a
/// glance, and the sidebar's Running section has them all.
const SHOWN_THREADS: usize = 6;

/// The Runners panel's state in the app (`Threadbear::runners_panel`).
#[derive(Default)]
pub(crate) struct RunnersPanelState {
    /// The view the dock shows it in, made the first time it's drawn.
    pub(crate) view: Option<Entity<crate::activity_panels::PanelView>>,
    /// `runners.stats`: each runner's latest figures, by its id.
    pub(crate) stats: HashMap<String, MachineStats>,
    /// The runner has answered `runners.stats` at least once.
    pub(crate) stats_asked: bool,
    /// The refresh button's `runners.list` is on its way.
    pub(crate) refreshing: bool,
    /// Mike's runner order (`RemoteThreads.order`), None until the backend
    /// has one; a drop shows here at once (`runnerOrder`).
    pub(crate) order: Option<Vec<String>>,
    /// A drop still being saved (`pendingRunnerOrder`): the backend's own
    /// order doesn't replace it until it's the same, or a moment has passed.
    pending_order: Option<Vec<String>>,
    /// The panel is on show, and its timer is going.
    showing: bool,
    ticking: bool,
    /// The window it's drawn in, for whether it can be seen.
    window: Option<AnyWindowHandle>,
    /// Year-long token… for another runner's Claude login, by (runner,
    /// login): where it's got to (remote_tokens.rs).
    pub(crate) tokens: HashMap<(String, String), Step>,
    /// Each one's asking and polling; dropped, it stops.
    token_tasks: HashMap<(String, String), Task<()>>,
    /// The sign-in pages already opened, so a poll doesn't open one twice.
    token_pages: HashSet<String>,
    /// Use this Mac's Claude logins (login_share.rs): each runner's switch
    /// as this Mac's runner last said, by runner id.
    pub(crate) shares: HashMap<String, Share>,
    /// This Mac's runner can share its logins (it answered, and isn't on a
    /// runner key): until then there's no switch.
    pub(crate) shares_known: bool,
    /// A click on its way, and which way: the switch shows it at once and
    /// takes no more clicks until it lands.
    pub(crate) share_going: HashMap<String, bool>,
}

/// A runner's card being dragged, and what it's called on the way.
#[derive(Clone)]
struct DraggedRunner {
    id: String,
    name: SharedString,
    symbol: &'static str,
}

/// What follows the pointer while a card is dragged: the card's icon and
/// name, lifted (ReorderList's lifted row).
struct RunnerGhost {
    name: SharedString,
    symbol: &'static str,
}

impl Render for RunnerGhost {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (bg, lift, edge) = (
            cx.theme().background,
            style::primary_opacity(cx, 0.1),
            style::hairline(cx),
        );
        h_flex()
            .w(px(220.))
            .px(px(10.))
            .py(px(8.))
            .gap(px(10.))
            .items_center()
            .rounded(px(8.))
            .bg(bg)
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(8.))
                    .bg(lift)
                    .border_1()
                    .border_color(edge),
            )
            .shadow_lg()
            .child(
                icons::symbol(self.symbol)
                    .with_size(px(15.))
                    .text_color(style::secondary_text(cx)),
            )
            .child(
                text_line(self.name.clone(), 12., style::label_text(cx))
                    .font_weight(FontWeight::MEDIUM),
            )
    }
}

impl Threadbear {
    // Asking the runner.

    /// Every runner again (`loadRunners`), or the refresh button's
    /// (`refreshRunners`), which spins and says if they couldn't be read.
    pub(crate) fn load_runners_list(&mut self, shown: bool, cx: &mut Context<Self>) {
        if shown {
            if self.runners_panel.refreshing {
                return;
            }
            self.runners_panel.refreshing = true;
            cx.notify();
        }
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let res = call(client, "runners.list", json!({})).await;
            this.update(cx, |t, cx| {
                if shown {
                    t.runners_panel.refreshing = false;
                }
                match res {
                    Ok(v) => {
                        t.remote.all_runners = remote::decode_runners(&v);
                        t.remote.keep_machines();
                    }
                    Err(e) if shown => t.show_error(e.message, cx),
                    Err(_) => {}
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Every runner's latest figures (`loadRunnerStats`). A runner older than
    /// `runners.stats` has none to give.
    pub(crate) fn load_runner_stats(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let res = call(client, "runners.stats", json!({})).await;
            this.update(cx, |t, cx| {
                t.receive_runner_stats(res.map_err(|e| e.code));
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn receive_runner_stats(&mut self, res: Result<Value, i64>) {
        match res {
            Ok(v) => {
                self.runners_panel.stats = rules::decode_stats(&v)
                    .into_iter()
                    .map(|s| (s.runner_id.clone(), s))
                    .collect()
            }
            Err(-32601) => self.runners_panel.stats.clear(),
            Err(_) => return,
        }
        self.runners_panel.stats_asked = true;
    }

    /// The panel came on show or went: while it's on show, the runners every
    /// 30 s and the figures every 10 s (the Swift view's two `.task`s).
    pub(crate) fn runners_panel_shown(&mut self, showing: bool, cx: &mut Context<Self>) {
        self.runners_panel.showing = showing;
        if !showing {
            return;
        }
        // Straight away, as the Swift view's `.task`s start when it shows,
        // even if the timer from an earlier showing is still waiting.
        self.load_runners_list(false, cx);
        if !self.runners_open().is_empty() {
            self.load_runner_stats(cx);
            self.load_open_runners_logins(cx);
        }
        if self.runners_panel.ticking {
            return;
        }
        self.runners_panel.ticking = true;
        cx.spawn(async move |this, cx| {
            let mut tick: u64 = 0;
            loop {
                cx.background_executor()
                    .timer(Duration::from_secs(10))
                    .await;
                tick += 1;
                let window = this
                    .read_with(cx, |t, _| t.runners_panel.window)
                    .ok()
                    .flatten();
                // Some window of the app can be seen: not minimised, covered,
                // or the screen asleep. A scripted window often isn't, so the
                // automation's `runners {"stats": true}` asks for itself.
                let visible = window.is_some_and(|w| {
                    cx.update_window(w, |_, window, _| window.is_visible())
                        .unwrap_or(false)
                });
                let go = this
                    .update(cx, |t, cx| t.runners_tick(tick, visible, cx))
                    .unwrap_or(false);
                if !go {
                    break;
                }
            }
        })
        .detach();
    }

    fn runners_tick(&mut self, tick: u64, visible: bool, cx: &mut Context<Self>) -> bool {
        if !self.runners_panel.showing {
            self.runners_panel.ticking = false;
            return false;
        }
        if tick.is_multiple_of(3) {
            self.load_runners_list(false, cx);
            self.load_open_runners_logins(cx);
        }
        if visible && !self.runners_open().is_empty() {
            self.load_runner_stats(cx);
        }
        true
    }

    /// The logins of the other runners whose details are open, for their
    /// Claude logins section: not from drawing, which an answer that fails
    /// would set going again at once.
    fn load_open_runners_logins(&mut self, cx: &mut Context<Self>) {
        let open = self.runners_open();
        let ids: Vec<String> = self
            .remote
            .all_runners
            .iter()
            .filter(|r| !r.is_self && open.contains(&r.id))
            .map(|r| r.id.clone())
            .collect();
        if !ids.is_empty() {
            self.load_login_shares(cx);
        }
        for id in ids {
            self.load_remote_logins(id, cx);
        }
    }

    /// `runners.sharedLogins`: each runner's Use this Mac's Claude logins.
    /// A runner older than it, or one that can't share, shows no switch.
    pub(crate) fn load_login_shares(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let res = call(client, "runners.sharedLogins", json!({})).await;
            this.update(cx, |t, cx| {
                match res {
                    Ok(v) => {
                        let got = share::decode(&v);
                        t.runners_panel.shares_known = got.blocked.is_none();
                        t.runners_panel.shares = got
                            .rows
                            .into_iter()
                            .map(|r| (r.runner_id.clone(), r))
                            .collect();
                    }
                    Err(e) if e.code == -32601 => t.runners_panel.shares_known = false,
                    Err(_) => return,
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The switch: shown flipped at once, and nothing more taken until this
    /// Mac's runner says how the first send went. Refused, it flips back
    /// and says why.
    pub(crate) fn set_login_share(&mut self, runner: String, on: bool, cx: &mut Context<Self>) {
        if self.runners_panel.share_going.contains_key(&runner) {
            return;
        }
        self.runners_panel.share_going.insert(runner.clone(), on);
        cx.notify();
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let res = call(
                client,
                "runners.shareLogins",
                json!({ "runnerId": runner, "on": on }),
            )
            .await;
            this.update(cx, |t, cx| {
                t.runners_panel.share_going.remove(&runner);
                match res {
                    Ok(v) => {
                        match serde_json::from_value::<Share>(v) {
                            Ok(row) if row.on || row.state != "off" => {
                                t.runners_panel.shares.insert(runner.clone(), row);
                            }
                            _ => {
                                t.runners_panel.shares.remove(&runner);
                            }
                        }
                        // Its logins as they are now, with the ones from here.
                        t.remote.logins_at.remove(&runner);
                        t.load_remote_logins(runner.clone(), cx);
                    }
                    Err(e) => t.show_error(e.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The runners whose details are open, kept across launches
    /// (`runnersPanelOpen`).
    fn runners_open(&self) -> HashSet<String> {
        self.settings
            .saved
            .runners_panel_open
            .as_deref()
            .unwrap_or("")
            .split(',')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    }

    /// Its name and state open the details (Mike, 5 Nov: "click on them to
    /// get more info about that specific runner"); opening asks for the
    /// figures straight away rather than at the next tick.
    pub(crate) fn toggle_runner_details(&mut self, id: &str, cx: &mut Context<Self>) -> bool {
        let mut open = self.runners_open();
        let opened = !open.remove(id);
        if opened {
            open.insert(id.to_owned());
        }
        let mut ids: Vec<String> = open.into_iter().collect();
        ids.sort();
        self.settings.saved.runners_panel_open = (!ids.is_empty()).then(|| ids.join(","));
        self.save_settings_soon(cx);
        if opened {
            self.load_runner_stats(cx);
            if self
                .remote
                .all_runners
                .iter()
                .any(|r| r.id == id && !r.is_self)
            {
                self.load_login_shares(cx);
                self.load_remote_logins(id.to_owned(), cx);
            }
        }
        cx.notify();
        opened
    }

    // The order.

    /// `orderedRunners`.
    pub(crate) fn ordered_runners(&self) -> Vec<RunnerInfo> {
        rules::ordered(
            &self.remote.all_runners,
            self.runners_panel.order.as_deref(),
        )
    }

    /// The order can be changed once the backend has one and this Mac's own
    /// runner is known: without it a drop would save an order that leaves
    /// this Mac out (`canOrderRunners`).
    fn can_order_runners(&self) -> bool {
        self.runners_panel.order.is_some()
            && !self.remote.machines().is_empty()
            && self.remote.all_runners.iter().any(|r| r.is_self)
    }

    /// `receive(remote:)`'s part: the backend's order, unless a drop of
    /// Mike's is still on its way and this isn't it yet.
    pub(crate) fn receive_runner_order(&mut self) {
        let order = self.remote.index.order.clone();
        match &self.runners_panel.pending_order {
            Some(pending) if order.as_ref() == Some(pending) => {
                self.runners_panel.pending_order = None
            }
            Some(_) => {}
            None => self.runners_panel.order = order,
        }
    }

    /// A card dropped on another's place: it moves there and the others
    /// shift round it (`setRunnerOrder(part:)`).
    fn drop_runner(&mut self, dragged: &str, onto: &str, cx: &mut Context<Self>) {
        let shown: Vec<String> = self.ordered_runners().into_iter().map(|r| r.id).collect();
        let (Some(from), Some(to)) = (
            shown.iter().position(|id| id == dragged),
            shown.iter().position(|id| id == onto),
        ) else {
            return;
        };
        if from == to {
            return;
        }
        let part = rules::moving(&shown, from, to);
        let self_id = self
            .remote
            .all_runners
            .iter()
            .find(|r| r.is_self)
            .map(|r| r.id.clone());
        let others: Vec<String> = self.remote.machines().into_iter().map(|r| r.id).collect();
        let order = rules::order_after_drop(
            &part,
            self_id.as_deref(),
            &others,
            self.runners_panel.order.as_deref(),
        );
        self.set_runner_order(order, cx);
    }

    /// Saves the order through this Mac's runner (`runners.setOrder`), here
    /// at once. Normally the list comes back in it straight away; if
    /// something else (the phone) moved it again before that, the backend's
    /// order wins after a moment rather than this one staying for good.
    pub(crate) fn set_runner_order(&mut self, ids: Vec<String>, cx: &mut Context<Self>) {
        self.runners_panel.pending_order = Some(ids.clone());
        self.runners_panel.order = Some(ids.clone());
        cx.notify();
        let going = crate::call_action(
            self.client.clone(),
            "runners.setOrder",
            json!({ "runnerIds": ids }),
        );
        cx.spawn(async move |this, cx| {
            let res = going.await;
            if res.is_ok() {
                cx.background_executor().timer(Duration::from_secs(5)).await;
            }
            this.update(cx, |t, cx| {
                if t.runners_panel.pending_order.as_ref() == Some(&ids) {
                    t.runners_panel.pending_order = None;
                    t.runners_panel.order = t.remote.index.order.clone();
                }
                if let Err(e) = res {
                    t.show_error(format!("Couldn't save the runner order. {}", e.message), cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // What it shows.

    /// The threads running now, in the sidebar's Running order.
    fn running_threads(&self) -> Vec<ThreadSummary> {
        let wakes = inbox::wakes(&self.scheduled.list);
        // Sectioned as shared pointers: only the Running rows are copied out
        // (thread_map.rs; this panel redraws as often as the sidebar).
        inbox::sections_ordered(self.threads.values(), now_ms(), self.sidebar.order, &wakes)
            .into_iter()
            .find(|s| s.key == "running")
            .map(|s| s.rows.iter().map(|t| (**t).clone()).collect())
            .unwrap_or_default()
    }

    /// Where new threads start: this Mac unless Mike picked another.
    fn is_default_runner(&self, r: &RunnerInfo) -> bool {
        match &self.new_thread.prefs.remembered.default_runner {
            None => r.is_self,
            Some(id) => *id == r.id,
        }
    }

    /// `RunnersPanel`: how many are up, then a card for each runner.
    pub(crate) fn render_runners_panel(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.runners_panel.window = Some(window.window_handle());
        let runners = self.ordered_runners();
        let open = self.runners_open();
        let running = self.running_threads();
        let movable = self.can_order_runners();
        let now = now_ms();
        let header = h_flex()
            .gap(px(6.))
            .items_center()
            .child(small_heading(rules::summary(&self.remote.all_runners), cx))
            .child(div().flex_1())
            .child(icon_button(
                "runners-refresh",
                "arrow.clockwise",
                "Check the runners again now",
                self.runners_panel.refreshing,
                cx,
                |t, _, cx| t.load_runners_list(true, cx),
            ))
            .child(about_button(
                "runners-about",
                rules::ABOUT.iter().map(|p| p.to_string()).collect(),
                None,
                cx,
            ));
        let mut children = vec![header.into_any_element()];
        for r in &runners {
            let on_it: Vec<ThreadSummary> =
                rules::running(r, &running).into_iter().cloned().collect();
            children.push(self.render_runner_card(
                r,
                &on_it,
                open.contains(&r.id),
                movable,
                now,
                cx,
            ));
        }
        panel_column("runners-panel", 14., children)
    }

    /// `RunnerCard`: its icon, then the name, star, build and a chevron, its
    /// state, the details when open, and what's running there.
    fn render_runner_card(
        &mut self,
        r: &RunnerInfo,
        running: &[ThreadSummary],
        open: bool,
        movable: bool,
        now: i64,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let state = rules::state(r);
        let (tertiary, secondary) = (style::tertiary_label(cx), style::secondary_text(cx));
        let symbol = icons::runner_symbol(r.icon.as_deref());
        let id = r.id.clone();
        let header_tip = if open {
            format!("Hide {}'s details", r.name)
        } else {
            format!("Show {}'s CPU, memory and disk", r.name)
        };
        let toggle_id = id.clone();
        let header = tipped(
            div()
                .id(SharedString::from(format!("runner-header-{}", r.id)))
                .group(SharedString::from(format!("runner-{}", r.id)))
                .cursor_pointer(),
            header_tip,
        )
        .on_click(cx.listener(move |t, _: &ClickEvent, _, cx| {
            t.toggle_runner_details(&toggle_id, cx);
        }))
        .child(self.render_runner_header(r, state, open, now, cx));
        let mut column = v_flex().flex_1().min_w_0().gap(px(3.)).child(header);
        if open {
            column = column.child(
                div()
                    .pt(px(5.))
                    .pb(px(2.))
                    .child(self.render_runner_details(r, now, cx)),
            );
            if !r.is_self {
                column = column.child(self.render_runner_logins(r, now, cx));
            }
        }
        if !running.is_empty() {
            let mut list = v_flex().pt(px(3.)).gap(px(1.));
            for t in running.iter().take(SHOWN_THREADS) {
                list = list.child(self.render_running_row(t, cx));
            }
            if running.len() > SHOWN_THREADS {
                list = list.child(
                    text_line(
                        format!("and {} more", running.len() - SHOWN_THREADS),
                        11.,
                        tertiary,
                    )
                    .pl(px(21.))
                    .pt(px(2.)),
                );
            }
            column = column.child(list);
        }
        let mut card = h_flex().w_full().items_start().gap(px(10.));
        if movable {
            // As wide as SF's 11 point line.3.horizontal, so the words line
            // up with the Swift card's.
            card = card.child(
                tipped_as(
                    div()
                        .id(SharedString::from(format!("runner-handle-{}", r.id)))
                        .flex_none()
                        .w(px(13.))
                        .h(px(17.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_grab(),
                    "Drag to change the order",
                    gpui_kit::Role::GenericContainer,
                )
                .child(
                    icons::symbol("line.3.horizontal")
                        .with_size(px(12.))
                        .text_color(tertiary),
                ),
            );
        }
        card = card
            .child(
                div()
                    .flex_none()
                    .w(px(22.))
                    .h(px(17.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(icons::symbol(symbol).with_size(px(15.)).text_color(
                        if state == State::Offline {
                            tertiary
                        } else {
                            secondary
                        },
                    )),
            )
            .child(column);
        let shell = div()
            .id(SharedString::from(format!("runner-card-{}", r.id)))
            .w_full()
            .rounded(px(8.));
        if !movable {
            return shell.child(card).into_any_element();
        }
        // A drop on a card puts the dragged one in its place: the slot it
        // would take shows dashed meanwhile (the margin keeps the border's
        // point from moving the card).
        let slot = style::tertiary_label(cx);
        let drag = DraggedRunner {
            id: id.clone(),
            name: r.name.clone().into(),
            symbol,
        };
        shell
            .on_drag(drag, |drag, _, _, cx| {
                cx.new(|_| RunnerGhost {
                    name: drag.name.clone(),
                    symbol: drag.symbol,
                })
            })
            .drag_over::<DraggedRunner>(move |s, _, _, _| {
                s.border_1()
                    .border_dashed()
                    .border_color(slot)
                    .m(gpui_kit::px(-1.))
            })
            .on_drop(
                cx.listener(move |t, drag: &DraggedRunner, _, cx| t.drop_runner(&drag.id, &id, cx)),
            )
            .child(card)
            .into_any_element()
    }

    /// The name, star, build and a chevron, then the state with its dot.
    fn render_runner_header(
        &self,
        r: &RunnerInfo,
        state: State,
        open: bool,
        now: i64,
        cx: &App,
    ) -> impl IntoElement {
        let (fg, secondary, tertiary) = (
            style::label_text(cx),
            style::secondary_text(cx),
            style::tertiary_label(cx),
        );
        let group = SharedString::from(format!("runner-{}", r.id));
        let mut name_line = h_flex().h(px(15.)).gap(px(5.)).items_center().child(
            text_line(r.name.clone(), 12., fg)
                .font_weight(FontWeight::MEDIUM)
                .truncate(),
        );
        if self.is_default_runner(r) {
            // SF's star.fill at 8 points is 9 square and sits on the name's
            // baseline: this one at 11, a point under the line's middle
            // (measured side by side).
            name_line = name_line.child(
                div().flex_none().mt(px(2.)).child(
                    icons::symbol("star.fill")
                        .with_size(px(11.))
                        .text_color(tertiary),
                ),
            );
        }
        name_line = name_line.child(div().flex_1().min_w(px(6.)));
        if let Some(build) = rules::build(r) {
            name_line = name_line.child(
                text_line(build, 10., tertiary)
                    .font_family(cx.theme().mono_font_family.clone())
                    .flex_none(),
            );
        }
        let chevron = style::group_hover_text(
            div()
                .id(SharedString::from(format!("runner-chevron-{}", r.id)))
                .flex_none()
                .text_color(tertiary),
            group,
            secondary,
        )
        .child(
            icons::symbol(if open {
                "chevron.down"
            } else {
                "chevron.right"
            })
            .with_size(px(11.)),
        );
        name_line = name_line.child(chevron);
        let dot_color = match state {
            State::Online => system_green(cx).opacity(0.85),
            State::Updating => system_orange(cx),
            State::Offline => secondary.opacity(0.35),
        };
        // No count of its running threads here: they're listed just below
        // (one mark, one meaning).
        let state_line = h_flex()
            .gap(px(5.))
            .items_center()
            .child(dot(dot_color).mt(px(1.)))
            .child(text_line(rules::state_line(r, now), 11., secondary).truncate());
        v_flex().gap(px(3.)).child(name_line).child(state_line)
    }

    /// `RunnerDetails`: CPU, memory and disk as bars, then what the machine
    /// is and how long it's been up; or why there's nothing yet.
    fn render_runner_details(&self, r: &RunnerInfo, now: i64, cx: &App) -> AnyElement {
        let tertiary = style::tertiary_label(cx);
        let Some(stats) = self.runners_panel.stats.get(&r.id) else {
            return text_line(
                rules::empty_line(r, self.runners_panel.stats_asked),
                11.,
                tertiary,
            )
            .into_any_element();
        };
        let mut lines: Vec<String> = rules::machine_lines(stats);
        lines.extend(rules::stale_line(stats, now));
        v_flex()
            .gap(px(5.))
            .children(rules::gauges(stats).into_iter().map(|g| gauge_row(g, cx)))
            // SwiftUI's line at 10.5 points is 13, a point under what
            // `natural_line` gives for 11 (measured against the Swift panel).
            .child(
                v_flex()
                    .pt(px(2.))
                    .gap(px(1.))
                    .children(lines.into_iter().map(|l| {
                        text_line(l, 10.5, tertiary)
                            .line_height(px(13.))
                            .line_clamp(2)
                    })),
            )
            .into_any_element()
    }

    /// `RunningThreadRow`: a spinner and its title, opening it on a click.
    fn render_running_row(&mut self, t: &ThreadSummary, cx: &mut Context<Self>) -> AnyElement {
        let (secondary, fg, hover) = (
            style::secondary_text(cx),
            style::label_text(cx),
            style::sidebar_hover(cx),
        );
        let title = if t.title.is_empty() {
            "Untitled".to_owned()
        } else {
            t.title.clone()
        };
        let tip = format!(
            "Open {}",
            if t.title.is_empty() {
                "this thread"
            } else {
                t.title.as_str()
            }
        );
        let id = t.id.clone();
        tipped(
            h_flex()
                .id(SharedString::from(format!("runner-thread-{}", t.id)))
                .ml(px(-4.))
                .px(px(4.))
                .py(px(3.))
                .gap(px(7.))
                .items_center()
                .rounded(px(style::RAIL_CORNER))
                .cursor_pointer()
                .text_color(secondary)
                .hover(move |s| s.bg(hover).text_color(fg)),
            tip,
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
            this.reveal_thread(&id, cx);
            this.open(id.clone(), window, cx);
        }))
        .child(
            div().flex_none().size(px(11.)).child(
                Spinner::new()
                    .icon(gpui_kit::assets::IconName::LoaderCircle)
                    .color(secondary)
                    .with_size(px(11.)),
            ),
        )
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_size(px(11.))
                .line_height(px(style::natural_line(11.)))
                .child(title),
        )
        .into_any_element()
    }

    // Year-long tokens for another runner's Claude logins
    // (remote_tokens.rs, docs/protocol.md `accounts.yearToken`).

    /// "Claude logins", then each with its line and Year-long token….
    fn render_runner_logins(
        &mut self,
        r: &RunnerInfo,
        now: i64,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (fg, secondary, tertiary) = (
            style::label_text(cx),
            style::secondary_text(cx),
            style::tertiary_label(cx),
        );
        let mut list = v_flex()
            .pt(px(8.))
            .gap(px(6.))
            .child(small_heading(tokens::HEADING, cx));
        if self.runners_panel.shares_known {
            list = list.child(self.render_login_share(r, cx));
        }
        let Some(logins) = self.remote.logins.get(&r.id) else {
            return list
                .child(text_line(tokens::LOADING, 11., tertiary))
                .into_any_element();
        };
        let accounts: Vec<_> = tokens::claude_logins(logins).into_iter().cloned().collect();
        if accounts.is_empty() {
            return list
                .child(text_line(tokens::NO_LOGINS, 11., tertiary))
                .into_any_element();
        }
        let zone = threadbear_core::chrono::Local;
        for a in accounts {
            let key = (r.id.clone(), a.id.clone());
            let step = self.runners_panel.tokens.get(&key).cloned();
            let busy = step.as_ref().is_some_and(Step::busy);
            let (runner, account) = key.clone();
            let mut head = h_flex().gap(px(8.)).items_center().child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(1.))
                    .child(text_line(a.name(), 11., fg).truncate())
                    .children(
                        tokens::status(&a, now, &zone)
                            .map(|w| text_line(w, 10.5, tertiary).truncate()),
                    ),
            );
            if tokens::can_token(&a) && !matches!(step, Some(Step::Waiting { .. })) {
                head = head.child(push_button(
                    SharedString::from(format!("runner-token-{}-{}", r.id, a.id)),
                    tokens::button_label(&a),
                    tokens::button_tip(&a, &r.name),
                    true,
                    busy,
                    cx,
                    move |t, _, cx| t.start_year_token(runner.clone(), account.clone(), cx),
                ));
            }
            let mut row = v_flex().gap(px(4.)).child(head);
            if let Some(step) = step {
                row = row.child(
                    text_line(
                        step.words(),
                        11.,
                        if matches!(step, Step::Failed(_)) {
                            system_orange(cx)
                        } else {
                            secondary
                        },
                    )
                    .line_clamp(4),
                );
                if let Step::Waiting { url, .. } = &step {
                    let id = |what: &str| {
                        SharedString::from(format!("runner-token-{what}-{}-{}", r.id, a.id))
                    };
                    let (k1, k2, page) = (key.clone(), key.clone(), url.clone());
                    row = row.child(button_row(
                        vec![
                            push_button(
                                id("paste"),
                                "Paste code",
                                "Send the code you copied from the page to that runner",
                                true,
                                false,
                                cx,
                                move |t, _, cx| t.paste_year_token_code(k1.clone(), cx),
                            ),
                            text_button(
                                id("page"),
                                "Open the page again",
                                "Open the claude.ai page to approve the token again",
                                11.,
                                true,
                                false,
                                cx,
                                move |_, _, cx| crate::files::open_web(&page, cx),
                            ),
                            text_button(
                                id("cancel"),
                                "Cancel",
                                "Stop making this token",
                                11.,
                                false,
                                false,
                                cx,
                                move |t, _, cx| t.cancel_year_token(k2.clone(), cx),
                            ),
                        ],
                        false,
                        cx,
                    ));
                }
            }
            list = list.child(row);
        }
        list.into_any_element()
    }

    /// Use this Mac's Claude logins: the switch, a spinner while a click is
    /// on its way, then what's there from this Mac.
    fn render_login_share(&self, r: &RunnerInfo, cx: &mut Context<Self>) -> AnyElement {
        let (fg, tertiary) = (style::label_text(cx), style::tertiary_label(cx));
        let row = self.runners_panel.shares.get(&r.id);
        let going = self.runners_panel.share_going.get(&r.id).copied();
        let on = share::shown_on(row, going);
        let busy = going.is_some() || row.is_some_and(|s| s.state == "sending");
        let tip = share::tip(on, &r.name);
        let runner = r.id.clone();
        let switch = div()
            .id(SharedString::from(format!("runner-share-{}", r.id)))
            .test_support()
            .a11y_role(Role::GenericContainer)
            .aria_label(tip.clone())
            .tip(tip)
            .child(
                MacSwitch::new(
                    SharedString::from(format!("runner-share-switch-{}", r.id)),
                    on,
                )
                .disabled(busy)
                .on_change({
                    let me = cx.entity().downgrade();
                    move |next, _, cx| {
                        let runner = runner.clone();
                        me.update(cx, |t, cx| t.set_login_share(runner, next, cx))
                            .ok();
                    }
                }),
            )
            .a11y_disabled(busy);
        let mut head = h_flex().gap(px(8.)).items_center().child(
            text_line(share::SWITCH, 11., fg)
                .flex_1()
                .min_w_0()
                .truncate(),
        );
        if busy {
            head = head.child(
                div().flex_none().size(px(11.)).child(
                    Spinner::new()
                        .icon(gpui_kit::assets::IconName::LoaderCircle)
                        .color(tertiary)
                        .with_size(px(11.)),
                ),
            );
        }
        head = head.child(switch);
        v_flex()
            .gap(px(2.))
            .child(head)
            .children(
                share::lines(row, going)
                    .into_iter()
                    .map(|l| text_line(l, 10.5, tertiary).line_clamp(3)),
            )
            .into_any_element()
    }

    /// The switch's lines for the dump: its state, then what's under it.
    fn login_share_lines(&self, r: &RunnerInfo) -> Vec<String> {
        if !self.runners_panel.shares_known {
            return Vec::new();
        }
        let row = self.runners_panel.shares.get(&r.id);
        let going = self.runners_panel.share_going.get(&r.id).copied();
        let on = share::shown_on(row, going);
        let busy = going.is_some() || row.is_some_and(|s| s.state == "sending");
        let mut lines = vec![format!(
            "{}: {}{}",
            share::SWITCH,
            if on { "on" } else { "off" },
            if busy { " (busy)" } else { "" }
        )];
        lines.extend(
            share::lines(row, going)
                .into_iter()
                .map(|l| format!("  {l}")),
        );
        lines
    }

    /// The section's lines for the dump.
    fn runner_login_lines(&self, r: &RunnerInfo, now: i64) -> Vec<String> {
        let shared = self.login_share_lines(r);
        let Some(logins) = self.remote.logins.get(&r.id) else {
            return [shared, vec![tokens::LOADING.to_owned()]].concat();
        };
        let accounts = tokens::claude_logins(logins);
        if accounts.is_empty() {
            return [shared, vec![tokens::NO_LOGINS.to_owned()]].concat();
        }
        let mut lines = shared;
        lines.push(tokens::HEADING.to_owned());
        for a in accounts {
            let status = tokens::status(a, now, &threadbear_core::chrono::Local)
                .map_or_else(String::new, |s| format!(", {s}"));
            let button = if tokens::can_token(a) {
                format!(" [{}]", tokens::button_label(a))
            } else {
                String::new()
            };
            lines.push(format!("{}{status}{button}", a.name()));
            if let Some(step) = self.runners_panel.tokens.get(&(r.id.clone(), a.id.clone())) {
                lines.push(format!("  {}", step.words()));
            }
        }
        lines
    }

    /// Year-long token… on another runner's login: starts setup-token
    /// there, and follows it until its page is ready to open.
    pub(crate) fn start_year_token(
        &mut self,
        runner: String,
        account: String,
        cx: &mut Context<Self>,
    ) {
        let key = (runner.clone(), account.clone());
        if self.runners_panel.tokens.get(&key).is_some_and(Step::busy) {
            return;
        }
        self.runners_panel
            .tokens
            .insert(key.clone(), Step::Starting);
        self.follow_year_token(key, json!({ "runnerId": runner, "accountId": account }), cx);
    }

    /// Paste code: the clipboard's code, if it's this page's, to the runner.
    pub(crate) fn paste_year_token_code(&mut self, key: (String, String), cx: &mut Context<Self>) {
        let Some(Step::Waiting { url, .. }) = self.runners_panel.tokens.get(&key).cloned() else {
            return;
        };
        let clipboard = cx.read_from_clipboard().and_then(|item| item.text());
        match tokens::code_for(clipboard.as_deref(), &url) {
            Err(why) => {
                self.runners_panel.tokens.insert(
                    key,
                    Step::Waiting {
                        url,
                        notice: Some(why.to_owned()),
                    },
                );
                cx.notify();
            }
            Ok(code) => {
                self.runners_panel
                    .tokens
                    .insert(key.clone(), Step::Checking { url });
                let params = json!({ "runnerId": key.0, "accountId": key.1, "code": code });
                self.follow_year_token(key, params, cx);
            }
        }
    }

    /// Cancel: gone from the panel at once, and stopped on the runner.
    pub(crate) fn cancel_year_token(&mut self, key: (String, String), cx: &mut Context<Self>) {
        self.runners_panel.tokens.remove(&key);
        self.runners_panel.token_tasks.remove(&key);
        let client = self.client.clone();
        let params = json!({ "runnerId": key.0, "accountId": key.1, "cancel": true });
        cx.spawn(async move |_, _| {
            let _ = call(client, "accounts.yearToken", params).await;
        })
        .detach();
        cx.notify();
    }

    /// Asks once with `params`, then every 2 s while there's more to come;
    /// opens the sign-in page the first time it's there, and reads the
    /// runner's logins again once the token's made.
    fn follow_year_token(&mut self, key: (String, String), params: Value, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let check = json!({ "runnerId": key.0, "accountId": key.1, "check": true });
        let k = key.clone();
        let task = cx.spawn(async move |this, cx| {
            let mut params = params;
            loop {
                let res = call(client.clone(), "accounts.yearToken", params).await;
                let step = match res {
                    Ok(v) => tokens::step_from(
                        &serde_json::from_value::<tokens::Answer>(v).unwrap_or_default(),
                    ),
                    Err(e) => Step::Failed(e.message),
                };
                let go = this
                    .update(cx, |t, cx| {
                        if let Some(url) =
                            step.url().filter(|_| matches!(step, Step::Waiting { .. }))
                        {
                            if t.runners_panel.token_pages.insert(url.to_owned()) {
                                crate::files::open_web(url, cx);
                            }
                        }
                        if step == Step::Done {
                            t.remote.logins_at.remove(&k.0);
                            t.load_remote_logins(k.0.clone(), cx);
                        }
                        let go = step.polls();
                        t.runners_panel.tokens.insert(k.clone(), step);
                        if !go {
                            t.runners_panel.token_tasks.remove(&k);
                        }
                        cx.notify();
                        go
                    })
                    .unwrap_or(false);
                if !go {
                    break;
                }
                cx.background_executor().timer(Duration::from_secs(2)).await;
                params = check.clone();
            }
        });
        self.runners_panel.token_tasks.insert(key, task);
        cx.notify();
    }

    // For scripts and the specs.

    /// What the panel says, a line each, in the Swift app's dump shape.
    pub(crate) fn runners_dump(&self, cx: &App) -> Value {
        let open = self.runners_open();
        let running = self.running_threads();
        let now = now_ms();
        let mut lines = vec![rules::summary(&self.remote.all_runners)];
        for r in self.ordered_runners() {
            let star = if self.is_default_runner(&r) { " *" } else { "" };
            let build = rules::build(&r).map_or_else(String::new, |b| format!(", {b}"));
            lines.push(format!(
                "{}{star}: {}{build}",
                r.name,
                rules::state_line(&r, now)
            ));
            if open.contains(&r.id) {
                match self.runners_panel.stats.get(&r.id) {
                    Some(s) => {
                        lines.extend(rules::gauges(s).into_iter().map(|g| {
                            format!(
                                "  {} {}{}",
                                g.title,
                                g.text,
                                if g.high { " (high)" } else { "" }
                            )
                        }));
                        lines.extend(
                            rules::machine_lines(s)
                                .into_iter()
                                .chain(rules::stale_line(s, now))
                                .map(|l| format!("  {l}")),
                        );
                    }
                    None => lines.push(format!(
                        "  {}",
                        rules::empty_line(&r, self.runners_panel.stats_asked)
                    )),
                }
                if !r.is_self {
                    lines.extend(
                        self.runner_login_lines(&r, now)
                            .into_iter()
                            .map(|l| format!("  {l}")),
                    );
                }
            }
            let on_it = rules::running(&r, &running);
            lines.extend(on_it.iter().take(SHOWN_THREADS).map(|t| {
                format!(
                    "  > {}",
                    if t.title.is_empty() {
                        "Untitled"
                    } else {
                        t.title.as_str()
                    }
                )
            }));
            if on_it.len() > SHOWN_THREADS {
                lines.push(format!("  and {} more", on_it.len() - SHOWN_THREADS));
            }
        }
        json!({
            "shown": self.activity_panel_showing(shell::RUNNERS, cx),
            "docked": self.dock.read(cx).layout().contains(shell::RUNNERS),
            "lines": lines
        })
    }

    /// The Swift app's `runners` command, without its `stats` (run() asks for
    /// those itself, as that needs the runner's answer first): the icon's
    /// tooltip and each runner's line.
    pub(crate) fn runners_lines(&self) -> Vec<String> {
        let running = self.running_threads();
        let now = now_ms();
        let mut lines = vec![rules::tooltip(&self.remote.all_runners)];
        for r in &self.remote.all_runners {
            let count = rules::running(r, &running).len();
            let build = rules::build(r).map_or_else(String::new, |b| format!(", {b}"));
            lines.push(format!(
                "{}: {}{build}{}",
                r.name,
                rules::state_line(r, now),
                if count > 0 {
                    format!(", {count} running")
                } else {
                    String::new()
                }
            ));
        }
        lines
    }
}

/// `GaugeRow`: its name, the bar, and its figure, orange past the runner's
/// warning lines.
fn gauge_row(g: rules::Gauge, cx: &App) -> AnyElement {
    let (fg, secondary) = (style::label_text(cx), style::secondary_text(cx));
    let fill = if g.high {
        system_orange(cx)
    } else {
        secondary.opacity(0.6)
    };
    let track = style::primary_opacity(cx, 0.08);
    let digits = FontFeatures(std::sync::Arc::new(vec![("tnum".into(), 1)]));
    h_flex()
        .gap(px(8.))
        .items_center()
        .child(text_line(g.title, 11., secondary).w(px(48.)).flex_none())
        .child(
            div().flex_1().h(px(5.)).rounded_full().bg(track).child(
                div()
                    .h_full()
                    .min_w(px(3.))
                    .w(relative(g.fraction as f32))
                    .rounded_full()
                    .bg(fill),
            ),
        )
        .child(
            text_line(g.text, 11., if g.high { fg } else { secondary })
                .font_features(digits)
                .min_w(px(84.))
                .flex_none()
                .flex()
                .justify_end()
                .whitespace_nowrap(),
        )
        .into_any_element()
}

/// The automation's `runners` (the Swift app's): `show` opens or closes the
/// panel, `open` a runner's details by its id or name; with neither, the
/// icon's tooltip and each runner's line. `drag` with `onto` (names) is this
/// app's own: a drag of one card onto another's place, through real pointer
/// events and hit testing, as a person's goes.
#[cfg(feature = "automation")]
pub(crate) fn automation(
    app: &Entity<Threadbear>,
    cmd: &Value,
    window: &mut Window,
    cx: &mut App,
) -> Result<Value, String> {
    if let (Some(from), Some(onto)) = (cmd["drag"].as_str(), cmd["onto"].as_str()) {
        use gpui_kit::test::{TestEventExt as _, TestQueryExt as _, TestWindowExt as _};
        window.render_frame(cx);
        // A card by its name and state, whose tip says what a click there does.
        let center = |name: &str, window: &mut Window| -> Result<Point<Pixels>, String> {
            let tips = [
                format!("Show {name}'s CPU, memory and disk"),
                format!("Hide {name}'s details"),
            ];
            let found = window
                .elements()
                .into_iter()
                .filter(|e| e.visible() && e.label().is_some_and(|l| tips.contains(&l.to_string())))
                .next_back();
            found
                .map(|e| e.visible_bounds().center())
                .ok_or_else(|| format!("no card for {name} on screen"))
        };
        let (a, b) = (center(from, window)?, center(onto, window)?);
        window.pointer_move(a, None, cx);
        window.pointer_down(a, MouseButton::Left, cx);
        for step in 1..=8 {
            let t = step as f32 / 8.;
            window.pointer_move(
                point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t),
                Some(MouseButton::Left),
                cx,
            );
        }
        window.pointer_up(b, MouseButton::Left, cx);
        return Ok(json!("ok"));
    }
    if let Some(show) = cmd["show"].as_bool() {
        let shown = app.update(cx, |t, cx| {
            if t.activity_panel_showing(shell::RUNNERS, cx) != show {
                t.toggle_under_threads(shell::RUNNERS, cx);
            }
            t.activity_panel_showing(shell::RUNNERS, cx)
        });
        return match (show, shown) {
            (false, _) => Ok(json!("ok closed")),
            (true, true) => Ok(json!("ok shown")),
            (true, false) => Err("the panel didn't open".into()),
        };
    }
    if let Some(which) = cmd["open"].as_str() {
        let id = app
            .read(cx)
            .remote
            .all_runners
            .iter()
            .find(|r| r.id == which || r.name == which)
            .map(|r| r.id.clone())
            .ok_or_else(|| format!("no runner {which}"))?;
        let opened = app.update(cx, |t, cx| t.toggle_runner_details(&id, cx));
        return Ok(json!(if opened { "ok open" } else { "ok closed" }));
    }
    Ok(json!(format!(
        "ok {}",
        serde_json::to_string(&app.read(cx).runners_lines()).unwrap_or_default()
    )))
}

/// `runners {"stats": true}`: the figures asked for now, as the panel does
/// every 10 s while it can be seen (a scripted window often can't), and
/// each runner's bars in a line.
pub(crate) async fn stats_command(
    app: &WeakEntity<Threadbear>,
    cx: &mut AsyncApp,
) -> Result<Value, String> {
    let client = app
        .read_with(cx, |t, _| t.client.clone())
        .map_err(|e| e.to_string())?;
    let res = call(client, "runners.stats", json!({})).await;
    let lines = app
        .update(cx, |t, cx| {
            t.receive_runner_stats(res.map_err(|e| e.code));
            cx.notify();
            let mut stats: Vec<&MachineStats> = t.runners_panel.stats.values().collect();
            stats.sort_by(|a, b| a.runner_id.cmp(&b.runner_id));
            stats
                .iter()
                .map(|s| {
                    format!(
                        "{}: {}",
                        s.runner_id,
                        rules::gauges(s)
                            .iter()
                            .map(|g| format!("{} {}", g.title, g.text))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                })
                .collect::<Vec<_>>()
        })
        .map_err(|e| e.to_string())?;
    Ok(json!(format!(
        "ok {}",
        serde_json::to_string(&lines).unwrap_or_default()
    )))
}
