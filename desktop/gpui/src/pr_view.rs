// A GitHub pull request open as a dock panel beside the thread: a PR link
// clicked in a reply or in Highlights opens here rather than in the browser,
// with what's needed to decide on it and the buttons to act
// (docs/protocol/panels.md, "Pull requests"; the rules and words are
// threadbear_core::pull_requests). Mike picked this layout, option A of three
// mockups (18 Nov 2026), after trying Capy, and asked for PRs to be normal
// dock panels rather than an overlay inside Highlights (27 Nov 2026).
//
// Each PR opens as a real tab beside Highlights (or down the right when no
// side panel is open), with Refresh and Open on GitHub in its panel bar.
// Un-moved PR tabs follow their thread (closing on switch and coming back on
// return); dragging one into another group or a window of its own keeps it
// open across threads. The runner reads it with gh; every button spins and
// stops taking clicks until GitHub has answered, then the PR is read again.
use crate::app::Threadbear;
use crate::highlights::{icon, palette, tipped, Palette, SidePane};
use crate::style::{self, px};
use crate::tips::Tip as _;
use crate::{call, now_ms};
use gpui_kit::base::TextViewState;
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _, StyledExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use threadbear_core::inbox::{ago, parse_ms, ThreadSummary};
use threadbear_core::pull_requests::{
    self as rules, CachedPr, CheckState, MergeMethod, PrFiles, PrRef, PrState, PrTab, PrView,
};

/// The tip on a PR's buttons while the copy kept from an earlier run is
/// read again.
const CHECKING: &str = "Checking GitHub for changes first";

/// GitHub's merged purple: no other colour in the app means merged.
const MERGED: u32 = 0xa371f7;

pub(crate) enum PrLoad {
    Loading,
    Ready(Arc<PrView>),
    Failed(String),
}

/// What's kept of one PR's tab while the app runs.
#[derive(Default)]
pub(crate) struct PrUi {
    pub(crate) tab: PrTab,
    /// The button whose work is under way ("merge", "close", "comment", ...),
    /// spinning, with every action button holding off until it lands.
    pub(crate) busy: Option<&'static str>,
    pub(crate) error: Option<String>,
    /// Read again after an action or Refresh, with the old one still showing.
    refreshing: bool,
    body: Option<(String, Entity<TextViewState>)>,
    notes: HashMap<usize, (String, Entity<TextViewState>)>,
    comment: Option<Entity<TextareaState>>,
    /// Diff files folded shut, by path.
    folded: std::collections::HashSet<String>,
    scroll: ScrollHandle,
}

#[derive(Default)]
pub(crate) struct PrPanes {
    loads: HashMap<String, PrLoad>,
    ui: HashMap<String, PrUi>,
    /// The folder of the thread each PR was opened from, so "Start a thread"
    /// and "Ask Claude to review" still know where to start even if the panel
    /// was dragged out onto another thread.
    cwds: HashMap<String, String>,
    /// The thread starting a review or a thread on it, so a second click
    /// can't start two.
    starting: Option<String>,
    /// Each PR link's state, for its colour in Highlights' Links, and the
    /// links already asked about (`github.prStates`).
    states: HashMap<String, PrState>,
    asked: std::collections::HashSet<String>,
    /// Each PR's status for Highlights' Pull requests, with when it came, and
    /// the PRs being asked about.
    status: HashMap<String, (rules::PrStatus, i64)>,
    status_asking: std::collections::HashSet<String>,
    /// When `github.prStatus` last failed (gh missing or signed out): not
    /// asked again for a minute.
    status_failed_at: Option<i64>,
    /// A redraw is booked for when the statuses showing go stale.
    status_redraw: bool,
    /// Auto-fix wands pressed and not yet answered: what each was turned to.
    watch_pending: HashMap<String, bool>,
    /// A PR's files that came before the PR itself (`load_pr`).
    early_files: HashMap<String, PrFiles>,
    /// When each PR showing was read from GitHub, for reading it again
    /// behind it once that's a while ago (`rules::PR_FRESH_MS`).
    read_at: HashMap<String, i64>,
    /// The PRs showing as the cache kept them from an earlier run, until
    /// GitHub's answer replaces them: their buttons wait for that.
    from_cache: std::collections::HashSet<String>,
    /// The PR the pane drew last, for a script's click to scroll to a
    /// button below its bottom.
    #[cfg(feature = "automation")]
    shown: Option<String>,
}

impl PrPanes {
    /// The scroll of the PR on show, for a script's click to scroll down
    /// to Close without merging (below the bottom on GitHub's 1024 by
    /// 768 Macs, 18 Nov).
    #[cfg(feature = "automation")]
    pub(crate) fn shown_scroll(&self) -> Option<ScrollHandle> {
        self.shown
            .as_ref()
            .and_then(|url| self.ui.get(url))
            .map(|ui| ui.scroll.clone())
    }

    #[cfg(feature = "automation")]
    pub(crate) fn describe(&self, url: &str) -> Value {
        let ui = self.ui.get(url);
        let load = match self.loads.get(url) {
            // The words the tab draws, for the specs.
            Some(PrLoad::Ready(pr)) => {
                let (checks, failed) = rules::checks_summary(&pr.checks);
                json!({ "title": pr.title, "state": pr.state.words(), "status": rules::status_words(pr), "checks": checks, "failed": failed, "files": pr.files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(), "filesLater": pr.files_later, "activity": pr.activity.iter().map(|a| a.body.clone()).collect::<Vec<_>>(), "canMerge": pr.can_merge, "fromCache": self.from_cache.contains(url) })
            }
            Some(PrLoad::Failed(e)) => json!({ "error": e }),
            _ => json!("loading"),
        };
        json!({ "url": url, "pr": load, "tab": ui.map(|u| u.tab.title()), "busy": ui.and_then(|u| u.busy), "error": ui.and_then(|u| u.error.clone()) })
    }
}

/// The canonical URL of a PR link, if it's one that opens here.
pub(crate) fn pr_url(url: &str) -> Option<String> {
    PrRef::parse(url).map(|r| r.url())
}

impl SidePane {
    /// Remembers the working folder of the thread a PR was opened from.
    pub(crate) fn remember_pr_cwd(&mut self, url: &str, cwd: String) {
        if !cwd.is_empty() {
            self.prs.cwds.insert(url.to_owned(), cwd);
        }
    }

    /// The PR's state, from its full read if ready else from `github.prStates`.
    pub(crate) fn pr_state(&self, url: &str) -> Option<PrState> {
        match self.prs.loads.get(url) {
            Some(PrLoad::Ready(pr)) => Some(pr.state),
            _ => self.prs.states.get(url).copied(),
        }
    }

    /// The PR's title once loaded, for the dock tab's tooltip.
    pub(crate) fn pr_title(&self, url: &str) -> Option<String> {
        match self.prs.loads.get(url) {
            Some(PrLoad::Ready(pr)) => Some(pr.title.clone()),
            _ => None,
        }
    }

    pub(crate) fn pr_refreshing(&self, url: &str) -> bool {
        self.prs.ui.get(url).is_some_and(|u| u.refreshing)
            || matches!(self.prs.loads.get(url), Some(PrLoad::Loading))
    }

    /// True when a PR panel restored from the saved layout hasn't started
    /// reading yet. Never true for a failed load (which waits for Try again).
    pub(crate) fn needs_pr_begin(&self, url: &str) -> bool {
        !self.prs.loads.contains_key(url)
    }

    pub(crate) fn refresh_pr(&mut self, url: &str, cx: &mut Context<Self>) {
        self.load_pr(url, cx);
    }

    /// Reads the PR the first time it shows, or again if the last read failed
    /// (a read started by a hover, say, that the runner or GitHub turned
    /// down), or behind what's showing once that was read a while ago.
    pub(crate) fn begin_pr(&mut self, url: &str, cx: &mut Context<Self>) {
        let stale = self
            .prs
            .read_at
            .get(url)
            .is_some_and(|at| now_ms() - at > rules::PR_FRESH_MS);
        let refreshing = self.prs.ui.get(url).is_some_and(|u| u.refreshing);
        match self.prs.loads.get(url) {
            None | Some(PrLoad::Failed(_)) => self.load_pr(url, cx),
            Some(PrLoad::Ready(_)) if stale && !refreshing => self.load_pr(url, cx),
            _ => {}
        }
    }

    /// The pointer resting on a PR link in a reply (reply_links.rs): read it
    /// now, so the click that usually follows finds it read or on its way.
    /// A read takes a second or more (three gh calls, behind whatever else
    /// the runner is doing), and Mike found the tab slow to fill (19 Nov).
    /// Once per PR while the app runs, as an opened one is. A thread showing
    /// reads the PRs its last messages link to the same way (thread.rs
    /// `preload_recent_prs`).
    pub(crate) fn preload_pr(&mut self, url: &str, cx: &mut Context<Self>) {
        let Some(url) = pr_url(url) else { return };
        if !self.prs.loads.contains_key(&url) {
            self.load_pr(&url, cx);
        }
    }

    /// Reads the PR in two: the PR itself, and its files apart
    /// (`github.prFiles`), as a big PR's diff is the slowest read. The tab
    /// shows the PR once the first answers, its Diff once the second does,
    /// whichever comes first. One the app hasn't read since it started
    /// shows as an earlier run kept it (`cache`) while GitHub's is read.
    fn load_pr(&mut self, url: &str, cx: &mut Context<Self>) {
        match self.prs.loads.get(url) {
            Some(PrLoad::Ready(_)) => {
                self.prs.ui.entry(url.to_owned()).or_default().refreshing = true
            }
            _ => {
                self.prs.loads.insert(url.to_owned(), PrLoad::Loading);
                let url = url.to_owned();
                let read = cx.background_spawn({
                    let url = url.clone();
                    async move { cache::read(&url) }
                });
                cx.spawn(async move |this, cx| {
                    let Some(kept) = read.await else { return };
                    this.update(cx, |this, cx| this.pr_from_cache(&url, kept, cx))
                        .ok();
                })
                .detach();
            }
        }
        self.prs.early_files.remove(url);
        let (client, url) = (self.client.clone(), url.to_owned());
        cx.spawn({
            let (client, url) = (client.clone(), url.clone());
            async move |this, cx| {
                let res = call(client, "github.prFiles", json!({ "url": url })).await;
                this.update(cx, |this, cx| this.pr_files_read(&url, res, cx))
                    .ok();
            }
        })
        .detach();
        cx.spawn(async move |this, cx| {
            let res = call(client, "github.pr", json!({ "url": url, "files": false })).await;
            this.update(cx, |this, cx| {
                let load = match res {
                    Ok(v) => match serde_json::from_value::<PrView>(v) {
                        Ok(mut pr) => {
                            // A reply's mark for it shows the new state too.
                            if this.prs.states.insert(url.clone(), pr.state) != Some(pr.state) {
                                cx.refresh_windows();
                            }
                            if pr.files_later {
                                if let Some(files) = this.prs.early_files.remove(&url) {
                                    pr = pr.with_files(files);
                                } else if let Some(PrLoad::Ready(before)) = this.prs.loads.get(&url)
                                {
                                    pr = pr.keeping_files_of(before);
                                }
                            }
                            PrLoad::Ready(Arc::new(pr))
                        }
                        Err(e) => PrLoad::Failed(format!("Couldn't read the PR: {e}")),
                    },
                    // An older runner: no PRs here, so its page in the browser.
                    Err(e) if e.code == -32601 => PrLoad::Failed(
                        "This runner can't read PRs yet. Open it on GitHub instead.".into(),
                    ),
                    Err(e) => PrLoad::Failed(e.message),
                };
                // A refresh that failed keeps what was showing, with why.
                let ui = this.prs.ui.entry(url.clone()).or_default();
                ui.refreshing = false;
                match (load, this.prs.loads.get(&url)) {
                    (PrLoad::Failed(e), Some(PrLoad::Ready(_))) => ui.error = Some(e),
                    (load, _) => {
                        if matches!(load, PrLoad::Ready(_)) {
                            this.prs.read_at.insert(url.clone(), now_ms());
                            this.prs.from_cache.remove(&url);
                        }
                        this.prs.loads.insert(url.clone(), load);
                        this.keep_pr(&url, cx);
                    }
                }
                cx.refresh_windows();
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.refresh_windows();
        cx.notify();
    }

    /// `github.prFiles` answered: into the PR if it's read and waiting for
    /// them, kept for it if it isn't read yet. An older runner doesn't know
    /// the call, and its `github.pr` brought the files anyway.
    fn pr_files_read(
        &mut self,
        url: &str,
        res: Result<serde_json::Value, threadbear_client::runner::RpcError>,
        cx: &mut Context<Self>,
    ) {
        let files = match res {
            Ok(v) => serde_json::from_value::<PrFiles>(v).unwrap_or_else(|e| PrFiles {
                files_error: Some(e.to_string()),
                ..Default::default()
            }),
            Err(e) if e.code == -32601 => return,
            Err(e) => PrFiles {
                files_error: Some(e.message),
                ..Default::default()
            },
        };
        let refreshing = self.prs.ui.get(url).is_some_and(|u| u.refreshing);
        match self.prs.loads.get(url) {
            Some(PrLoad::Ready(pr)) if pr.files_later => {
                let pr = PrView::clone(pr).with_files(files);
                self.prs
                    .loads
                    .insert(url.to_owned(), PrLoad::Ready(Arc::new(pr)));
                self.keep_pr(url, cx);
            }
            // The PR (or a refresh of it) still to come: it takes them.
            Some(PrLoad::Loading) => {
                self.prs.early_files.insert(url.to_owned(), files);
            }
            Some(PrLoad::Ready(_)) if refreshing => {
                self.prs.early_files.insert(url.to_owned(), files);
            }
            // Failed, or a read of an older runner's that had them already.
            _ => return,
        }
        cx.notify();
    }

    /// The cache's copy of a PR, from an earlier run, shown while GitHub's
    /// is read if that hasn't come first. Its files are kept for GitHub's
    /// read without them, as a refresh's are.
    fn pr_from_cache(&mut self, url: &str, kept: CachedPr, cx: &mut Context<Self>) {
        if !matches!(self.prs.loads.get(url), Some(PrLoad::Loading)) {
            return;
        }
        if self.prs.states.insert(url.to_owned(), kept.pr.state) != Some(kept.pr.state) {
            cx.refresh_windows();
        }
        self.prs
            .loads
            .insert(url.to_owned(), PrLoad::Ready(Arc::new(kept.pr)));
        self.prs.read_at.insert(url.to_owned(), kept.read_at);
        self.prs.from_cache.insert(url.to_owned());
        self.prs.ui.entry(url.to_owned()).or_default().refreshing = true;
        cx.notify();
    }

    /// A whole read (its files too) goes in the cache for the next run,
    /// written off the main thread.
    fn keep_pr(&self, url: &str, cx: &mut Context<Self>) {
        let Some(PrLoad::Ready(pr)) = self.prs.loads.get(url) else {
            return;
        };
        if pr.files_later || pr.files_error.is_some() || self.prs.from_cache.contains(url) {
            return;
        }
        let kept = CachedPr {
            read_at: self.prs.read_at.get(url).copied().unwrap_or_else(now_ms),
            pr: PrView::clone(pr),
        };
        cx.background_spawn(async move { cache::write(&kept) })
            .detach();
    }

    /// A PR link's state for its row's colour, asked of the runner the first
    /// time the row shows; None until it answers, or if it can't say.
    pub(crate) fn pr_link_state(&mut self, url: &str, cx: &mut Context<Self>) -> Option<PrState> {
        let url = pr_url(url)?;
        self.ask_pr_states(std::slice::from_ref(&url), cx);
        self.prs.states.get(&url).copied()
    }

    /// Asks the runner once for the states of the links in `urls` it hasn't
    /// been asked about, in one `github.prStates`. The answer redraws every
    /// window, as the marks in replies are drawn from it too.
    pub(crate) fn ask_pr_states(&mut self, urls: &[String], cx: &mut Context<Self>) {
        let new: Vec<String> = urls
            .iter()
            .filter_map(|u| pr_url(u))
            .filter(|u| !self.prs.states.contains_key(u) && self.prs.asked.insert(u.clone()))
            .collect();
        if new.is_empty() {
            return;
        }
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let Ok(v) = call(client, "github.prStates", json!({ "urls": new })).await else {
                return;
            };
            this.update(cx, |this, cx| {
                for url in &new {
                    if let Some(s) = v["states"][url].as_str().and_then(PrState::parse) {
                        this.prs.states.insert(url.clone(), s);
                    }
                }
                cx.refresh_windows();
            })
            .ok();
        })
        .detach();
    }

    /// The status of each PR in `urls` as last heard, asking the runner in
    /// one `github.prStatus` for those it hasn't heard about lately
    /// (`rules::PR_STATUS_FRESH_MS`). Called as Highlights draws, and it
    /// books a redraw for when they go stale, so a pane left open keeps up.
    pub(crate) fn pr_statuses(
        &mut self,
        urls: &[String],
        cx: &mut Context<Self>,
    ) -> HashMap<String, rules::PrStatus> {
        let now = now_ms();
        let canon: Vec<String> = urls.iter().filter_map(|u| pr_url(u)).collect();
        let stale = |s: &Self, u: &String| {
            s.prs
                .status
                .get(u)
                .is_none_or(|(_, at)| now - at >= rules::PR_STATUS_FRESH_MS)
        };
        let failed_lately = self
            .prs
            .status_failed_at
            .is_some_and(|at| now - at < 60_000);
        let ask: Vec<String> = canon
            .iter()
            .filter(|u| stale(self, u) && !self.prs.status_asking.contains(*u))
            .cloned()
            .collect();
        if !ask.is_empty() && !failed_lately {
            self.prs.status_asking.extend(ask.iter().cloned());
            let client = self.client.clone();
            cx.spawn(async move |this, cx| {
                let answer = call(client, "github.prStatus", json!({ "urls": ask })).await;
                this.update(cx, |this, cx| {
                    let at = now_ms();
                    for url in &ask {
                        this.prs.status_asking.remove(url);
                    }
                    match answer {
                        Ok(v) => {
                            this.prs.status_failed_at = None;
                            for url in &ask {
                                match rules::PrStatus::decode(&v["prs"][url]) {
                                    Some(s) => {
                                        this.prs.status.insert(url.clone(), (s, at));
                                    }
                                    // GitHub didn't give it: not asked again
                                    // until it goes stale like the rest.
                                    None => {
                                        if let Some(old) = this.prs.status.get_mut(url) {
                                            old.1 = at;
                                        }
                                    }
                                }
                            }
                        }
                        Err(_) => this.prs.status_failed_at = Some(at),
                    }
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
        if !canon.is_empty() && !self.prs.status_redraw {
            self.prs.status_redraw = true;
            cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(
                        rules::PR_STATUS_FRESH_MS as u64,
                    ))
                    .await;
                this.update(cx, |this, cx| {
                    this.prs.status_redraw = false;
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
        canon
            .into_iter()
            .filter_map(|u| self.prs.status.get(&u).map(|(s, _)| (u, s.clone())))
            .collect()
    }

    /// A PR's status as last heard, asking nothing (the specs' dump).
    #[cfg(feature = "automation")]
    pub(crate) fn pr_status_heard(&self, url: &str) -> Option<rules::PrStatus> {
        pr_url(url).and_then(|u| self.prs.status.get(&u).map(|(s, _)| s.clone()))
    }

    /// A PR row's auto-fix wand as it shows: what it was pressed to while
    /// the runner answers, else what the highlight says.
    pub(crate) fn pr_watch_shown(&self, url: &str, watched: bool) -> (bool, bool) {
        match pr_url(url).and_then(|u| self.prs.watch_pending.get(&u).copied()) {
            Some(on) => (on, true),
            None => (watched, false),
        }
    }

    /// The wand pressed: the runner watches the PR for this thread, or stops
    /// (`prWatch.set`), then Highlights is read again for every wand.
    pub(crate) fn press_pr_watch(
        &mut self,
        thread_id: String,
        url: String,
        on: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(url) = pr_url(&url) else { return };
        if self.prs.watch_pending.contains_key(&url) {
            return;
        }
        self.prs.watch_pending.insert(url.clone(), on);
        crate::activity::menu_chosen(
            Some(format!("PR > auto-fix {}", if on { "on" } else { "off" })),
            None,
        );
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let res = call(
                client,
                "prWatch.set",
                json!({ "threadId": thread_id, "urls": [url], "on": on }),
            )
            .await;
            this.update(cx, |this, cx| {
                if let Err(e) = res {
                    this.note_error(
                        format!(
                            "Couldn't turn auto-fix {}: {}",
                            if on { "on" } else { "off" },
                            e.message
                        ),
                        cx,
                    );
                }
                this.refresh_highlights(thread_id.clone(), std::time::Duration::ZERO, cx);
                // Kept until the new highlights come, so the wand doesn't flick back.
                let url2 = url.clone();
                cx.spawn(async move |this, cx| {
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(1500))
                        .await;
                    this.update(cx, |this, cx| {
                        this.prs.watch_pending.remove(&url2);
                        cx.notify();
                    })
                    .ok();
                })
                .detach();
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// A button's work on GitHub: busy until it lands, then the PR read again.
    fn pr_act(
        &mut self,
        url: &str,
        key: &'static str,
        params: Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let ui = self.prs.ui.entry(url.to_owned()).or_default();
        if ui.busy.is_some() {
            return;
        }
        ui.busy = Some(key);
        ui.error = None;
        let comment = ui.comment.clone();
        let mut params = params;
        params["url"] = json!(url);
        let url = url.to_owned();
        let going = crate::call_action(self.client.clone(), "github.prAct", params);
        crate::activity::menu_chosen(Some(format!("PR > {key}")), None);
        cx.spawn_in(window, async move |this, cx| {
            let res = going.await;
            this.update_in(cx, |this, window, cx| {
                // Highlights' status asks again on its next draw.
                this.prs.status.remove(&url);
                let ui = this.prs.ui.entry(url.clone()).or_default();
                ui.busy = None;
                match res {
                    Ok(_) => {
                        // What was typed went with it: the box empties.
                        if matches!(key, "comment" | "approve" | "requestChanges") {
                            if let Some(c) = comment {
                                c.update(cx, |s, cx| s.set_value("", window, cx));
                            }
                        }
                        this.load_pr(&url, cx);
                    }
                    Err(e) => ui.error = Some(e.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// The PR's panel body: Overview, Diff or Checks, under the bar and
    /// buttons, plus its Review/Merge popup menu when open.
    pub(crate) fn render_pr_panel(
        &mut self,
        url: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = palette(cx);
        let cwd = self
            .prs
            .cwds
            .get(url)
            .cloned()
            .or_else(|| self.thread(cx).map(|t| t.cwd))
            .unwrap_or_default();
        let pr = match self.prs.loads.get(url) {
            None | Some(PrLoad::Loading) => {
                return pr_skeleton(style::primary_opacity(cx, 0.07)).into_any_element()
            }
            Some(PrLoad::Failed(e)) => {
                let (again, open) = (url.to_owned(), url.to_owned());
                return v_flex()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap(px(10.))
                    .p(px(24.))
                    .child(
                        div()
                            .text_center()
                            .text_size(px(style::size::LABEL))
                            .text_color(p.secondary)
                            .child(format!("Couldn't read this PR: {e}")),
                    )
                    .child(
                        h_flex()
                            .gap(px(8.))
                            .child(
                                crate::push_button::PushButton::new(
                                    "pr-again",
                                    "Try again",
                                    "Read it from GitHub again",
                                )
                                .render(cx, {
                                    let side = cx.entity().downgrade();
                                    move |_, _, cx| {
                                        let _ =
                                            side.update(cx, |this, cx| this.load_pr(&again, cx));
                                    }
                                }),
                            )
                            .child(
                                crate::push_button::PushButton::new(
                                    "pr-browser",
                                    "Open on GitHub",
                                    "Open it in the browser",
                                )
                                .render(cx, move |_, _, cx| crate::files::open_web(&open, cx)),
                            ),
                    )
                    .into_any_element();
            }
            Some(PrLoad::Ready(pr)) => pr.clone(),
        };
        self.prs.ui.entry(url.to_owned()).or_default();
        #[cfg(feature = "automation")]
        {
            self.prs.shown = Some(url.to_owned());
        }
        let ui_tab = self.prs.ui[url].tab;
        let scroll = self.prs.ui[url].scroll.clone();
        let body = match ui_tab {
            PrTab::Overview => self.pr_overview(&cwd, url, &pr, p, window, cx),
            PrTab::Diff => self.pr_diff(url, &pr, p, cx),
            PrTab::Checks => pr_checks(&pr, p, cx),
        };
        let menu = self
            .menu
            .as_ref()
            .filter(|m| m.owner.as_deref() == Some(url))
            .map(|m| (m.position, m.view.clone()));
        v_flex()
            .relative()
            .size_full()
            .text_color(p.fg)
            .child(self.pr_bar(url, &pr, p, cx))
            .child(
                div()
                    .id("pr-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&scroll)
                    .child(v_flex().px(px(18.)).pt(px(4.)).pb(px(24.)).child(body)),
            )
            .when_some(menu, |s, (position, view)| {
                s.child(
                    deferred(
                        anchored()
                            .position(position)
                            .snap_to_window_with_margin(px(8.))
                            .child(div().occlude().child(view)),
                    )
                    .with_priority(1),
                )
            })
            .into_any_element()
    }

    /// Overview, Diff, Checks, and on the right Review and Merge.
    fn pr_bar(
        &mut self,
        url: &str,
        pr: &Arc<PrView>,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let ui = &self.prs.ui[url];
        let (tab_now, busy) = (ui.tab, ui.busy);
        // A copy from an earlier run could say it can merge when it's merged
        // since: its buttons wait for GitHub's answer.
        let checking = ui.refreshing && self.prs.from_cache.contains(url);
        let held = busy.is_some() || checking;
        let mut tabs = h_flex()
            .p(px(2.))
            .gap(px(2.))
            .rounded(px(7.))
            .bg(style::chip_fill(cx));
        for tab in PrTab::ALL {
            let on = tab == tab_now;
            let label = match tab {
                PrTab::Diff if !pr.files.is_empty() => format!("Diff {}", pr.files.len()),
                PrTab::Checks if !pr.checks.is_empty() => format!("Checks {}", pr.checks.len()),
                _ => tab.title().to_owned(),
            };
            let key = url.to_owned();
            let hover = p.hover;
            tabs = tabs.child(
                tipped(
                    div()
                        .id(SharedString::from(format!("pr-view-{}", tab.title())))
                        .px(px(9.))
                        .h(px(22.))
                        .flex()
                        .items_center()
                        .rounded(px(5.))
                        .text_size(px(style::size::LABEL))
                        .cursor_pointer()
                        .when(on, |d| {
                            d.bg(style::chip_hover_fill(cx))
                                .text_color(p.fg)
                                .font_semibold()
                        })
                        .when(!on, |d| {
                            d.text_color(p.secondary).hover(move |s| s.bg(hover))
                        })
                        .child(label),
                    tab.title(),
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.prs.ui.entry(key.clone()).or_default().tab = tab;
                    cx.notify();
                })),
            );
        }
        let mut right = h_flex().gap(px(6.)).items_center();
        if pr.can_merge {
            let review_url = url.to_owned();
            right = right.child(self.menu_button(
                "pr-review",
                "Review",
                busy.is_some_and(|b| matches!(b, "approve" | "requestChanges")),
                held,
                false,
                if checking {
                    CHECKING
                } else {
                    "Approve it, or ask for changes"
                },
                p,
                cx,
                move |this, position, window, cx| {
                    this.open_review_menu(&review_url, position, window, cx)
                },
            ));
            let method =
                rules::merge_method(&pr.merge_methods, crate::reply_links::pr_merge_method());
            if let Some(method) = method.filter(|_| pr.state == PrState::Open) {
                let merge_url = url.to_owned();
                let label = if busy == Some("merge") {
                    "Merging…"
                } else {
                    "Merge"
                };
                let tip = if checking {
                    CHECKING.to_owned()
                } else {
                    format!("{} (the arrow picks another way)", method.title())
                };
                right = right.child(self.menu_button(
                    "pr-merge",
                    label,
                    busy == Some("merge"),
                    held,
                    true,
                    &tip,
                    p,
                    cx,
                    move |this, position, window, cx| {
                        this.open_merge_menu(&merge_url, position, window, cx)
                    },
                ));
            }
        }
        // The buttons go under the views when the pane's too narrow for both.
        let bar = h_flex()
            .flex_none()
            .flex_wrap()
            .px(px(14.))
            .py(px(8.))
            .gap(px(8.))
            .items_center()
            .child(tabs)
            .child(div().flex_1())
            .child(right);
        let read_at = self.prs.read_at.get(url).copied();
        v_flex()
            .flex_none()
            .child(bar)
            .when_some(read_at.filter(|_| checking), |col, at| {
                col.child(
                    div()
                        .px(px(18.))
                        .pb(px(4.))
                        .text_size(px(style::size::DETAIL))
                        .text_color(p.faint)
                        .child(format!(
                            "As it was {}. Checking GitHub for changes…",
                            ago_words(at)
                        )),
                )
            })
    }

    /// A button that opens its menu below itself; `primary` is Merge's fill.
    #[expect(
        clippy::too_many_arguments,
        reason = "baselined when the lint was turned on (20 Nov 2026); take it off when this is next split up"
    )]
    fn menu_button(
        &self,
        id: &'static str,
        label: &str,
        spinning: bool,
        held: bool,
        primary: bool,
        tip: &str,
        p: Palette,
        cx: &mut Context<Self>,
        open: impl Fn(&mut SidePane, Point<Pixels>, &mut Window, &mut Context<SidePane>) + 'static,
    ) -> impl IntoElement {
        let fill = if primary {
            hsla(0.36, 0.45, 0.33, 1.)
        } else {
            style::button_fill(cx)
        };
        let text = if primary { gpui::white() } else { p.fg };
        let mut b = div()
            .id(id)
            .h(px(24.))
            .px(px(10.))
            .gap(px(5.))
            .flex()
            .items_center()
            .rounded(px(6.))
            .bg(fill)
            .text_size(px(style::size::LABEL))
            .text_color(text)
            .font_medium();
        if spinning {
            b = b.child(crate::spinner::TurningArc::new(11., text));
        }
        b = b
            .child(label.to_owned())
            .child(icon("chevron.down", 9., text));
        if held {
            b = b.opacity(0.7);
        } else {
            b = b.cursor_pointer();
        }
        tipped(b, tip.to_owned()).on_click(cx.listener(move |this, e: &ClickEvent, window, cx| {
            if held {
                return;
            }
            let at = e.position();
            open(this, point(at.x, at.y + px(14.)), window, cx);
        }))
    }

    fn open_merge_menu(
        &mut self,
        url: &str,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(PrLoad::Ready(pr)) = self.prs.loads.get(url) else {
            return;
        };
        let starred = rules::merge_method(&pr.merge_methods, crate::reply_links::pr_merge_method());
        let mut items: Vec<crate::highlights::MenuItem> = pr
            .merge_methods
            .iter()
            // The starred one is what the Merge button means.
            .map(|m| {
                crate::highlights::MenuItem::action(
                    m.title(),
                    if Some(*m) == starred {
                        "star.fill"
                    } else {
                        "arrow.triangle.merge"
                    },
                    crate::highlights::MenuAction::PrMerge {
                        url: url.to_owned(),
                        method: m.id().to_owned(),
                    },
                )
            })
            .collect();
        // The default, set from the same menu and marked (AGENTS.md's rule
        // for menus that pick one of several).
        items.push(crate::highlights::MenuItem::separator());
        let choices = pr
            .merge_methods
            .iter()
            .map(|m| crate::highlights::MenuItem {
                title: m.title().to_owned(),
                symbol: Some("star"),
                action: Some(crate::highlights::MenuAction::PrMergeDefault {
                    method: m.id().to_owned(),
                }),
                checked: Some(*m) == starred,
                children: vec![],
            })
            .collect();
        items.push(crate::highlights::MenuItem::submenu(
            "Default", "star", choices,
        ));
        self.open_pr_menu(url, items, position, window, cx);
    }

    fn open_review_menu(
        &mut self,
        url: &str,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        use crate::highlights::{MenuAction, MenuItem};
        let items = vec![
            MenuItem::action(
                "Approve",
                "checkmark",
                MenuAction::PrReview {
                    url: url.to_owned(),
                    action: "approve".into(),
                },
            ),
            MenuItem::action(
                "Request changes",
                "exclamationmark.triangle",
                MenuAction::PrReview {
                    url: url.to_owned(),
                    action: "requestChanges".into(),
                },
            ),
        ];
        self.open_pr_menu(url, items, position, window, cx);
    }

    /// A merge or review chosen from its menu.
    pub(crate) fn pr_menu_action(
        &mut self,
        url: &str,
        action: &str,
        method: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            "merge" => {
                let Some(method) = method.and_then(MergeMethod::parse) else {
                    return;
                };
                self.pr_act(
                    url,
                    "merge",
                    json!({ "action": "merge", "method": method.id() }),
                    window,
                    cx,
                );
            }
            "approve" | "requestChanges" => {
                let body = self
                    .prs
                    .ui
                    .get(url)
                    .and_then(|u| u.comment.as_ref())
                    .map(|c| c.read(cx).value().to_string())
                    .unwrap_or_default();
                if action == "requestChanges" && body.trim().is_empty() {
                    let ui = self.prs.ui.entry(url.to_owned()).or_default();
                    ui.error =
                        Some("Say what to change in the comment box, then Request changes.".into());
                    ui.tab = PrTab::Overview;
                    cx.notify();
                    return;
                }
                let key = if action == "approve" {
                    "approve"
                } else {
                    "requestChanges"
                };
                self.pr_act(
                    url,
                    key,
                    json!({ "action": action, "body": body }),
                    window,
                    cx,
                );
            }
            _ => {}
        }
    }

    #[expect(
        clippy::too_many_lines,
        reason = "baselined at 286 lines when the lint was turned on (20 Nov 2026); split it when it's next worked on"
    )]
    fn pr_overview(
        &mut self,
        cwd: &str,
        url: &str,
        pr: &Arc<PrView>,
        p: Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let now = now_ms();
        let mut col = v_flex().gap(px(0.));
        // Title, and who and when.
        col = col.child(
            div()
                .text_size(px(17.))
                .line_height(px(23.))
                .font_semibold()
                .text_color(p.fg)
                .child(pr.title.clone()),
        );
        let when = parse_ms(&pr.created_at)
            .map(|ms| format!(" · {} ago", ago(ms, now)))
            .unwrap_or_default();
        col = col.child(
            div()
                .mt(px(3.))
                .text_size(px(style::size::DETAIL))
                .text_color(p.secondary)
                .child(format!("{}{when}", pr.author)),
        );
        if let Some(e) = self.prs.ui.get(url).and_then(|u| u.error.clone()) {
            col = col.child(
                div()
                    .mt(px(10.))
                    .px(px(10.))
                    .py(px(7.))
                    .rounded(px(7.))
                    .bg(style::error_background(cx))
                    .text_size(px(style::size::DETAIL))
                    .text_color(style::failed_text(cx))
                    .child(e),
            );
        }
        // The fields.
        let (checks_words, failed) = rules::checks_summary(&pr.checks);
        let mut fields = v_flex().mt(px(14.)).gap(px(7.));
        let mono = cx.theme().mono_font_family.clone();
        fields = fields.child(field(
            "Branch",
            h_flex()
                .gap(px(5.))
                .min_w_0()
                .child(
                    div()
                        .font_family(mono.clone())
                        .text_size(px(style::size::DETAIL))
                        .truncate()
                        .child(pr.head.clone()),
                )
                .child(div().text_color(p.faint).child("→"))
                .child(
                    div()
                        .font_family(mono)
                        .text_size(px(style::size::DETAIL))
                        .child(pr.base.clone()),
                )
                .child(
                    div()
                        .ml(px(4.))
                        .text_color(style::added_text(cx))
                        .child(format!("+{}", pr.additions)),
                )
                .child(
                    div()
                        .text_color(style::removed_text(cx))
                        .child(format!("−{}", pr.deletions)),
                )
                .into_any_element(),
            p,
        ));
        fields = fields.child(field(
            "Status",
            h_flex()
                .gap(px(6.))
                .items_center()
                .child(icon("arrow.triangle.pull", 11., state_colour(pr.state, cx)))
                .child(rules::status_words(pr))
                .into_any_element(),
            p,
        ));
        let to_checks = url.to_owned();
        fields = fields.child(field(
            "Checks",
            tipped(
                div().id("pr-checks-row").cursor_pointer().child(
                    h_flex()
                        .gap(px(4.))
                        .child(checks_words)
                        .when_some(failed, |d, f| {
                            d.child(
                                div()
                                    .text_color(style::failed_text(cx))
                                    .child(format!("· {f}")),
                            )
                        }),
                ),
                "See each check",
            )
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.prs.ui.entry(to_checks.clone()).or_default().tab = PrTab::Checks;
                cx.notify();
            }))
            .into_any_element(),
            p,
        ));
        col = col.child(fields);
        // Claude: a thread to review it, or to work on it.
        let starting = self.prs.starting.is_some();
        let (review_pr, work_pr, review_cwd, work_cwd) =
            (pr.clone(), pr.clone(), cwd.to_owned(), cwd.to_owned());
        // Two buttons that wrap onto a second line in a narrow pane, rather
        // than words saying what they're for: their tips say that.
        col = col.child(
            h_flex()
                .mt(px(14.))
                .flex_wrap()
                .gap(px(8.))
                .items_center()
                .child(
                    crate::push_button::PushButton::new(
                        "pr-claude-work",
                        "Start a thread",
                        "A new thread in this folder, with the PR in its message box",
                    )
                    .small()
                    .render(cx, {
                        let side = cx.entity().downgrade();
                        move |_, window, cx| {
                            let _ = side.update(cx, |this, cx| {
                                this.start_pr_draft(&work_pr, &work_cwd, window, cx)
                            });
                        }
                    }),
                )
                .child(
                    crate::push_button::PushButton::new(
                        "pr-claude-review",
                        "Ask Claude to review",
                        "Starts a thread in this folder that reads it and says whether to merge",
                    )
                    .small()
                    .busy(starting)
                    .render(cx, {
                        let side = cx.entity().downgrade();
                        move |_, window, cx| {
                            let _ = side.update(cx, |this, cx| {
                                this.start_pr_review(&review_pr, &review_cwd, window, cx)
                            });
                        }
                    }),
                ),
        );
        // The description.
        if !pr.body.trim().is_empty() {
            let doc = self.pr_markdown(url, None, &pr.body, cx);
            col = col.child(
                div()
                    .mt(px(16.))
                    .pt(px(12.))
                    .border_t_1()
                    .border_color(p.hairline)
                    .text_size(px(style::size::LABEL))
                    .line_height(px(20.))
                    .child(self.pr_text(&doc, cwd, cx)),
            );
        }
        // What's happened on it.
        if !pr.activity.is_empty() {
            col = col.child(
                div()
                    .mt(px(18.))
                    .mb(px(6.))
                    .text_size(px(style::size::LABEL))
                    .font_semibold()
                    .text_color(p.fg)
                    .child("Activity"),
            );
            for (i, a) in pr.activity.iter().enumerate() {
                let what = match a.review.as_deref() {
                    Some("approved") => "approved",
                    Some("changes") => "asked for changes",
                    _ if a.kind == "review" => "reviewed",
                    _ => "commented",
                };
                let when = parse_ms(&a.at)
                    .map(|ms| format!(" · {}", ago(ms, now)))
                    .unwrap_or_default();
                let mut entry = v_flex().py(px(6.)).gap(px(3.)).child(
                    div()
                        .text_size(px(style::size::DETAIL))
                        .text_color(p.secondary)
                        .child(format!("{} {what}{when}", a.author)),
                );
                if !a.body.trim().is_empty() {
                    let doc = self.pr_markdown(url, Some(i), &a.body, cx);
                    entry = entry.child(
                        div()
                            .text_size(px(style::size::LABEL))
                            .line_height(px(20.))
                            .child(self.pr_text(&doc, cwd, cx)),
                    );
                }
                col = col.child(entry);
            }
        }
        // A comment to GitHub, and Request changes' words.
        let box_ = self.pr_comment_box(url, window, cx);
        let busy = self.prs.ui.get(url).and_then(|u| u.busy);
        let send_url = url.to_owned();
        col = col.child(
            v_flex()
                .mt(px(14.))
                .rounded(px(9.))
                .border_1()
                .border_color(p.card_border)
                .bg(style::composer_fill(cx))
                .child(
                    div()
                        .px(px(4.))
                        .pt(px(2.))
                        .child(Textarea::new(&box_).h(px(64.)).appearance(false)),
                )
                .child(
                    h_flex().px(px(8.)).pb(px(8.)).child(div().flex_1()).child(
                        crate::push_button::PushButton::new(
                            "pr-comment",
                            "Comment",
                            "Posts it on the PR on GitHub, as your gh account",
                        )
                        .small()
                        .busy(busy == Some("comment"))
                        .render(cx, {
                            let side = cx.entity().downgrade();
                            let input = box_.clone();
                            move |_, window, cx| {
                                let text = input.read(cx).value().to_string();
                                let _ = side.update(cx, |this, cx| {
                                    if text.trim().is_empty() {
                                        return;
                                    }
                                    this.pr_act(
                                        &send_url,
                                        "comment",
                                        json!({ "action": "comment", "body": text }),
                                        window,
                                        cx,
                                    );
                                });
                            }
                        }),
                    ),
                ),
        );
        // Closing (or opening it again) is rare and final enough to sit
        // at the bottom, not beside Merge.
        if pr.can_merge || pr.state == PrState::Closed {
            let (label, action) = if pr.state == PrState::Closed {
                ("Reopen", "reopen")
            } else {
                ("Close without merging", "close")
            };
            if pr.state != PrState::Merged {
                let act_url = url.to_owned();
                col = col.child(
                    h_flex().mt(px(10.)).child(div().flex_1()).child(
                        crate::push_button::PushButton::new(
                            "pr-close",
                            label,
                            if action == "close" {
                                "Closes the PR on GitHub"
                            } else {
                                "Opens the PR again on GitHub"
                            },
                        )
                        .small()
                        .busy(busy == Some(if action == "close" { "close" } else { "reopen" }))
                        .render(cx, {
                            let side = cx.entity().downgrade();
                            move |_, window, cx| {
                                let _ = side.update(cx, |this, cx| {
                                    this.pr_act(
                                        &act_url,
                                        if action == "close" { "close" } else { "reopen" },
                                        json!({ "action": action }),
                                        window,
                                        cx,
                                    )
                                });
                            }
                        }),
                    ),
                );
            }
        }
        col.into_any_element()
    }

    fn pr_comment_box(
        &mut self,
        url: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextareaState> {
        if let Some(c) = self.prs.ui.get(url).and_then(|u| u.comment.clone()) {
            return c;
        }
        let c = cx.new(|cx| TextareaState::new(window, cx).placeholder("Comment on GitHub"));
        self.prs.ui.entry(url.to_owned()).or_default().comment = Some(c.clone());
        c
    }

    /// A markdown view kept for the description (`None`) or a comment, made
    /// again only when its words change.
    fn pr_markdown(
        &mut self,
        url: &str,
        at: Option<usize>,
        text: &str,
        cx: &mut Context<Self>,
    ) -> Entity<TextViewState> {
        let ui = self.prs.ui.entry(url.to_owned()).or_default();
        let kept = match at {
            None => ui.body.as_ref(),
            Some(i) => ui.notes.get(&i),
        };
        if let Some((was, doc)) = kept {
            if was == text {
                return doc.clone();
            }
        }
        let source = text.to_owned();
        let doc = cx.new(|cx| TextViewState::markdown(&source, cx));
        let ui = self.prs.ui.entry(url.to_owned()).or_default();
        match at {
            None => ui.body = Some((source, doc.clone())),
            Some(i) => {
                ui.notes.insert(i, (source, doc.clone()));
            }
        }
        doc
    }

    /// PR words, drawn as a reply's, their links going where a reply's go
    /// from the pane (another PR opens as its own panel).
    fn pr_text(
        &self,
        doc: &Entity<TextViewState>,
        cwd: &str,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let side = cx.entity().downgrade();
        let style = crate::rows::reading_style(cx);
        // Through the open gate's view, its click handler replaced by the
        // pane's, which still opens only through the gate (or as a PR panel).
        crate::open_gate::text_view(doc, crate::open_gate::Origin::ThisMac, cwd)
            .selectable(true)
            .style(style)
            .on_link_click(
                move |url: &SharedString, _: &ClickEvent, _: &mut Window, cx: &mut App| {
                    let url = url.to_string();
                    let _ = side.update(cx, |this, cx| this.follow_link(&url, cx));
                },
            )
    }

    fn pr_diff(
        &mut self,
        url: &str,
        pr: &Arc<PrView>,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if pr.files.is_empty() && pr.files_later {
            return files_skeleton(style::primary_opacity(cx, 0.07)).into_any_element();
        }
        if pr.files.is_empty() {
            let note = pr.files_error.clone().map_or_else(
                || "No changes.".to_owned(),
                |e| format!("Couldn't read the diff: {e}"),
            );
            return div()
                .pt(px(20.))
                .text_size(px(style::size::LABEL))
                .text_color(p.secondary)
                .child(note)
                .into_any_element();
        }
        let folded = self
            .prs
            .ui
            .get(url)
            .map(|u| u.folded.clone())
            .unwrap_or_default();
        let mut col = v_flex().gap(px(6.));
        for (i, f) in pr.files.iter().enumerate() {
            let shut = folded.contains(&f.path);
            let (key, path) = (url.to_owned(), f.path.clone());
            let name = match &f.from {
                Some(from) => format!("{from} → {}", f.path),
                None => f.path.clone(),
            };
            let head = tipped(
                h_flex()
                    .id(("pr-file", i))
                    .gap(px(6.))
                    .py(px(4.))
                    .items_center()
                    .cursor_pointer()
                    .child(icon(
                        if shut {
                            "chevron.right"
                        } else {
                            "chevron.down"
                        },
                        10.,
                        p.faint,
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .font_family(cx.theme().mono_font_family.clone())
                            .text_size(px(style::size::DETAIL))
                            .child(name),
                    )
                    .child(
                        div()
                            .text_size(px(style::size::DETAIL))
                            .text_color(style::added_text(cx))
                            .child(format!("+{}", f.additions)),
                    )
                    .child(
                        div()
                            .text_size(px(style::size::DETAIL))
                            .text_color(style::removed_text(cx))
                            .child(format!("−{}", f.deletions)),
                    ),
                if shut {
                    "Show this file's changes"
                } else {
                    "Hide this file's changes"
                },
            )
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                let ui = this.prs.ui.entry(key.clone()).or_default();
                if !ui.folded.remove(&path) {
                    ui.folded.insert(path.clone());
                }
                cx.notify();
            }));
            col = col.child(head);
            if shut {
                continue;
            }
            if f.binary {
                col = col.child(
                    div()
                        .pl(px(16.))
                        .text_size(px(style::size::DETAIL))
                        .text_color(p.secondary)
                        .child("Binary file"),
                );
            } else if !f.hunks.is_empty() {
                let diff = f.edit_diff(&format!("{url}#{i}"));
                col = col.child(
                    div()
                        .rounded(px(7.))
                        .border_1()
                        .border_color(p.card_border)
                        .py(px(4.))
                        .overflow_hidden()
                        .child(crate::rows::diff::diff_with_note(
                            SharedString::from(format!("pr-diff-{i}")),
                            std::slice::from_ref(&diff),
                            usize::MAX,
                            8.,
                            None,
                            crate::rows::diff::DiffNote::None,
                            cx,
                        )),
                );
            }
        }
        if let Some(cut) = pr.files_cut {
            col = col.child(
                div()
                    .pt(px(6.))
                    .text_size(px(style::size::DETAIL))
                    .text_color(p.secondary)
                    .child(format!("{cut} more lines are on GitHub.")),
            );
        }
        col.into_any_element()
    }

    /// Start a thread on it: the new-thread box in this thread's folder,
    /// with the PR's link and name in it for Mike to say what to do, keeping
    /// the PR panel open beside the new thread so he can read it as he writes.
    fn start_pr_draft(
        &mut self,
        pr: &PrView,
        cwd: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(app) = self.app.upgrade() else {
            return;
        };
        let (text, cwd, url) = (rules::work_prompt(pr), cwd.to_owned(), pr.url.clone());
        app.update(cx, |app, cx| {
            app.new_thread(cx);
            app.choose_new_thread_runner(None, true, cx);
            if !cwd.is_empty() {
                app.new_thread.picks.cwd = Some(cwd.clone());
            }
            let composer = app.ensure_new_composer(window, cx);
            composer.update(cx, |c, cx| c.replace_text(text, cx));
            app.main_context_maybe_changed(cx);
            app.open_pr_panel(&url, (!cwd.is_empty()).then_some(cwd), cx);
            cx.notify();
        });
    }

    /// Ask Claude to review: a new thread in this folder that reads it and
    /// says whether to merge, opened once the runner has made it.
    fn start_pr_review(
        &mut self,
        pr: &PrView,
        cwd: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.prs.starting.is_some() {
            return;
        }
        let pr_url = pr.url.clone();
        self.prs.starting = Some(pr_url.clone());
        let params = json!({ "cwd": cwd, "text": rules::review_prompt(pr), "title": format!("Review #{}: {}", pr.number, pr.title) });
        let going = crate::call_action(self.client.clone(), "threads.create", params);
        let app = self.app.clone();
        cx.spawn_in(window, async move |this, cx| {
            let res = going.await;
            this.update_in(cx, |this, window, cx| {
                this.prs.starting = None;
                match res {
                    Ok(v) => {
                        if let (Ok(t), Some(app)) = (
                            serde_json::from_value::<ThreadSummary>(v["thread"].clone()),
                            app.upgrade(),
                        ) {
                            let cwd = t.cwd.clone();
                            app.update(cx, |app, cx| {
                                let id = t.id.clone();
                                app.store_reply_summary(t);
                                app.open(id, window, cx);
                                app.main_context_maybe_changed(cx);
                                app.open_pr_panel(&pr_url, Some(cwd), cx);
                            });
                        }
                    }
                    Err(e) => {
                        if let Some(ui) = this.prs.ui.get_mut(&pr_url) {
                            ui.error = Some(format!("Couldn't start the review: {}", e.message));
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

// ---------------------------------------------------------------- dock panels

/// One PR open as a BearDock panel, drawing from `SidePane`'s shared PR cache
/// and redrawing when that PR's read or UI state changes.
pub(crate) struct PrPanelView {
    side: Entity<SidePane>,
    url: String,
    _watch: Subscription,
}

impl PrPanelView {
    fn new(side: Entity<SidePane>, url: String, cx: &mut Context<Self>) -> Self {
        let watch = cx.observe(&side, |_, _, cx| cx.notify());
        PrPanelView {
            side,
            url,
            _watch: watch,
        }
    }
}

impl Render for PrPanelView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.side.read(cx).needs_pr_begin(&self.url) {
            let (side, url) = (self.side.clone(), self.url.clone());
            cx.defer(move |cx| side.update(cx, |s, cx| s.begin_pr(&url, cx)));
        }
        let url = self.url.clone();
        let body = self
            .side
            .update(cx, |s, cx| s.render_pr_panel(&url, window, cx));
        div().size_full().bg(cx.theme().background).child(body)
    }
}

impl Threadbear {
    /// Opens a GitHub PR as a normal dock panel beside Highlights (or down the
    /// right if no side panel is open), tracked as a per-thread tab until Mike
    /// closes it or drags it into another group or window.
    pub(crate) fn open_pr_panel(&mut self, url: &str, cwd: Option<String>, cx: &mut Context<Self>) {
        let Some(r) = PrRef::parse(url) else { return };
        let canonical = r.url();
        let panel = r.panel_id();
        self.side.update(cx, |s, cx| {
            if let Some(cwd) = cwd {
                s.remember_pr_cwd(&canonical, cwd);
            }
            s.begin_pr(&canonical, cx);
        });
        self.dock_thread_tab(&panel, None, cx);
        cx.notify();
    }

    pub(crate) fn pr_panel_title(&self, panel: &str) -> Option<String> {
        Some(rules::panel_ref(panel)?.tab_title())
    }

    pub(crate) fn pr_panel_tip(&self, panel: &str, cx: &App) -> Option<String> {
        let r = rules::panel_ref(panel)?;
        let url = r.url();
        Some(match self.side.read(cx).pr_title(&url) {
            Some(title) => format!("{}/{}#{}: {title}", r.owner, r.repo, r.number),
            None => format!("{}/{}#{}", r.owner, r.repo, r.number),
        })
    }

    pub(crate) fn pr_panel_icon(&self, panel: &str, cx: &App) -> Option<AnyElement> {
        let url = rules::panel_url(panel)?;
        let color = self
            .side
            .read(cx)
            .pr_state(url)
            .map_or_else(|| cx.theme().muted_foreground, |s| state_colour(s, cx));
        Some(
            crate::icons::symbol("arrow.triangle.pull")
                .with_size(px(13.))
                .text_color(color)
                .into_any_element(),
        )
    }

    /// Refresh and Open on GitHub at the right end of a PR panel's dock bar.
    pub(crate) fn pr_panel_buttons(
        &mut self,
        url: &str,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let p = palette(cx);
        let hover = p.hover;
        let fg = p.fg;
        let refreshing = self.side.read(cx).pr_refreshing(url);
        let side = self.side.clone();
        let refresh_url = url.to_owned();
        let open_url = url.to_owned();
        let mut row = h_flex().flex_none().items_center().pr(px(4.));
        if refreshing {
            let spinner = div()
                .id(SharedString::from(format!("pr-reading-{url}")))
                .size(px(26.))
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .child(crate::spinner::TurningArc::new(12., p.secondary));
            row = row.child(tipped(spinner, "Reading it from GitHub".to_owned()));
        } else {
            row = row.child(
                tipped(
                    div()
                        .id(SharedString::from(format!("pr-refresh-{url}")))
                        .size(px(26.))
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.))
                        .hover(move |s| s.bg(hover).text_color(fg))
                        .cursor_pointer()
                        .child(icon("arrow.clockwise", style::size::LABEL, p.secondary)),
                    "Read it again from GitHub".to_owned(),
                )
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(move |_, _, cx| {
                    side.update(cx, |s, cx| s.refresh_pr(&refresh_url, cx));
                }),
            );
        }
        row = row.child(
            tipped(
                div()
                    .id(SharedString::from(format!("pr-open-{url}")))
                    .size(px(26.))
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .hover(move |s| s.bg(hover).text_color(fg))
                    .cursor_pointer()
                    .child(icon("arrow.up.right", style::size::LABEL, p.secondary)),
                "Open on GitHub".to_owned(),
            )
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(move |_, _, cx| crate::files::open_web(&open_url, cx)),
        );
        Some(row.into_any_element())
    }

    pub(crate) fn pr_panel_view(
        &mut self,
        panel: &str,
        ghost: bool,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if ghost {
            return div()
                .size_full()
                .bg(cx.theme().background)
                .into_any_element();
        }
        let Some(url) = rules::panel_url(panel) else {
            return div().size_full().into_any_element();
        };
        let side = self.side.clone();
        let url = url.to_owned();
        let view = self
            .thread_panels
            .pr_views
            .entry(panel.to_owned())
            .or_insert_with(|| cx.new(|cx| PrPanelView::new(side, url, cx)))
            .clone();
        AnyView::from(view).into_any_element()
    }

    #[cfg(feature = "automation")]
    pub(crate) fn pr_panels_dump(&self, cx: &App) -> Value {
        let dock = self.dock.read(cx);
        let side = self.side.read(cx);
        let list: Vec<Value> = dock
            .layout()
            .panels()
            .iter()
            .filter_map(|id| {
                let url = rules::panel_url(id)?;
                Some(json!({
                    "id": id,
                    "url": url,
                    "title": self.pr_panel_title(id),
                    "tip": self.pr_panel_tip(id, cx),
                    "showing": dock.is_showing(id),
                    "floating": dock.layout().is_floating(id),
                    "perThread": self.thread_panels.thread_tabs.contains_key(id),
                    "pr": side.prs.describe(url),
                }))
            })
            .collect();
        json!(list)
    }
}

fn field(name: &'static str, value: AnyElement, p: Palette) -> impl IntoElement {
    h_flex()
        .gap(px(10.))
        .items_center()
        .text_size(px(style::size::LABEL))
        .child(
            div()
                .w(px(64.))
                .flex_none()
                .text_color(p.secondary)
                .child(name),
        )
        .child(div().flex_1().min_w_0().text_color(p.fg).child(value))
}

/// A PR's colour by state: green while open, grey as a draft, purple
/// merged, red closed, as GitHub shows them.
pub(crate) fn state_colour(state: PrState, cx: &App) -> Hsla {
    match state {
        PrState::Open => style::tick_green(cx),
        PrState::Draft => style::secondary_text(cx),
        PrState::Merged => rgb(MERGED).into(),
        PrState::Closed => style::failed_text(cx),
    }
}

fn pr_checks(pr: &PrView, p: Palette, cx: &mut App) -> AnyElement {
    if pr.checks.is_empty() {
        return div()
            .pt(px(20.))
            .text_size(px(style::size::LABEL))
            .text_color(p.secondary)
            .child("No checks on this PR.")
            .into_any_element();
    }
    let mut col = v_flex().pt(px(4.));
    for (i, c) in pr.checks.iter().enumerate() {
        let (symbol, colour) = match c.state {
            CheckState::Passed => ("checkmark", style::tick_green(cx)),
            CheckState::Failed => ("xmark", style::failed_text(cx)),
            CheckState::Running => ("clock", style::status_progress(cx)),
            CheckState::Pending => ("circle", p.secondary),
            CheckState::Skipped => ("minus.circle", p.faint),
        };
        let mut row = h_flex()
            .id(("pr-check", i))
            .gap(px(8.))
            .py(px(5.))
            .items_center()
            .text_size(px(style::size::LABEL))
            .child(icon(symbol, 12., colour))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_color(p.fg)
                    .child(c.name.clone()),
            )
            .when_some(c.seconds, |d, s| {
                d.child(
                    div()
                        .text_size(px(style::size::DETAIL))
                        .text_color(p.faint)
                        .child(rules::duration(s)),
                )
            });
        if let Some(url) = c.url.clone() {
            let hover = p.hover;
            row = row
                .cursor_pointer()
                .rounded(px(5.))
                .hover(move |s| s.bg(hover))
                .on_click(move |_, _, cx| crate::files::open_web(&url, cx));
            col = col.child(tipped(row, "Open its log on GitHub"));
        } else {
            col = col.child(row);
        }
    }
    col.into_any_element()
}

/// The markdown plugin that draws `[\u{2060}](tbpr:<url>)` before a PR link
/// in a reply as GitHub's pull request mark in its state's colour (open,
/// draft, merged, closed), from what the pane knows of it; grey until the
/// runner says (`ask_pr_states`).
pub(crate) struct PrMarks;

#[derive(Clone)]
struct PrMarkRef {
    url: String,
}

impl gpui_kit::base::text::MarkdownPlugin for PrMarks {
    fn name(&self) -> &str {
        "pr-link-mark"
    }

    fn parse(
        &self,
        node: &markdown::mdast::Node,
        _cx: &gpui_kit::base::text::MarkdownParseContext<'_>,
    ) -> Option<gpui_kit::base::text::MarkdownNode> {
        let markdown::mdast::Node::Link(link) = node else {
            return None;
        };
        let url = link.url.strip_prefix(rules::MARK_SCHEME)?.to_owned();
        Some(
            gpui_kit::base::text::MarkdownNode::new("pr-link-mark", PrMarkRef { url })
                .text("")
                .markdown(""),
        )
    }

    fn render_inline(
        &self,
        node: &gpui_kit::base::text::MarkdownNode,
        _context: &gpui_kit::base::text::InlineRenderContext,
        _window: &mut Window,
        cx: &mut App,
    ) -> Option<gpui_kit::base::text::InlineElement> {
        let mark = node.data::<PrMarkRef>()?.clone();
        let app = cx
            .try_global::<crate::open_gate::GateNotices>()
            .and_then(|n| n.0.upgrade());
        let state = app.and_then(|a| a.read(cx).side.read(cx).prs.states.get(&mark.url).copied());
        let colour = state.map_or(style::faint_text(cx), |s| state_colour(s, cx));
        let mark_el = div()
            .id(SharedString::from(format!("pr-link-mark-{}", mark.url)))
            .flex_none()
            .mr(px(3.))
            .child(icon("arrow.triangle.pull", 12., colour))
            .tip(state.map_or("Pull request", PrState::words));
        Some(gpui_kit::base::text::InlineElement::new(mark_el).with_baseline(px(11.)))
    }
}

/// The PR links in a reply already read or being read (`preload_pr`, a
/// click), for the dump's `prsRead`.
#[cfg(feature = "automation")]
pub(crate) fn dump_read(text: &str, app: &crate::app::Threadbear, cx: &App) -> Option<Vec<String>> {
    let loads = &app.side.read(cx).prs.loads;
    let out: Vec<String> = rules::pr_links(text)
        .into_iter()
        .filter(|u| loads.contains_key(u))
        .collect();
    (!out.is_empty()).then_some(out)
}

/// For scripts: each PR link's mark in a reply, as "<url>: <state>" ("Pull
/// request" until the runner says), in order. None with no PR links.
#[cfg(feature = "automation")]
pub(crate) fn dump_marks(
    text: &str,
    app: &crate::app::Threadbear,
    cx: &App,
) -> Option<Vec<String>> {
    let states = &app.side.read(cx).prs.states;
    let out: Vec<String> = rules::pr_links(text)
        .into_iter()
        .map(|u| {
            format!(
                "{u}: {}",
                states.get(&u).map_or("Pull request", |s| s.words())
            )
        })
        .collect();
    (!out.is_empty()).then_some(out)
}

/// "5m ago", for how old the copy showing is.
fn ago_words(at: i64) -> String {
    match ago(at, now_ms()) {
        now if now == "now" => "just now".to_owned(),
        short => format!("{short} ago"),
    }
}

/// Grey shapes where a PR's bar, title, fields and description go, gently
/// pulsing, until it's read: the sidebar's loading rows' look
/// (sidebar.rs `render_loading_rows`). Mike asked for skeletons (19 Nov).
fn pr_skeleton(fill: Hsla) -> impl IntoElement {
    // Widths as parts of the pane, as it's often narrow.
    let bar = |w: f32, h: f32| {
        div()
            .flex_none()
            .w(relative(w))
            .h(px(h))
            .rounded_full()
            .bg(fill)
    };
    let block = |w: f32, h: f32| div().flex_none().w(px(w)).h(px(h)).rounded(px(6.)).bg(fill);
    let field = move |label: f32, value: f32| {
        h_flex()
            .w_full()
            .gap(px(14.))
            .items_center()
            .child(
                div()
                    .flex_none()
                    .w(px(label))
                    .h(px(8.))
                    .rounded_full()
                    .bg(fill),
            )
            .child(div().flex_1().child(bar(value, 8.)))
    };
    v_flex()
        .id("pr-skeleton")
        .size_full()
        .min_w_0()
        .overflow_hidden()
        .with_animation(
            "pr-skeleton",
            Animation::new(std::time::Duration::from_millis(1800))
                .repeat()
                .with_easing(bounce(ease_in_out)),
            |el, delta| el.opacity(1. - delta * 0.5),
        )
        // Nothing here may be wider than a narrow pane, or it widens the
        // whole skeleton past the pane's edge.
        .child(
            h_flex()
                .min_w_0()
                .px(px(14.))
                .py(px(8.))
                .gap(px(8.))
                .items_center()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(div().w(relative(0.6)).h(px(26.)).rounded(px(6.)).bg(fill)),
                )
                .child(block(64., 24.)),
        )
        .child(
            v_flex()
                .px(px(18.))
                .pt(px(12.))
                .gap(px(14.))
                .child(
                    v_flex()
                        .gap(px(8.))
                        .child(bar(0.85, 13.))
                        .child(bar(0.5, 13.)),
                )
                .child(field(52., 0.4))
                .child(field(52., 0.65))
                .child(field(52., 0.5))
                .child(
                    v_flex()
                        .pt(px(8.))
                        .gap(px(8.))
                        .child(bar(0.95, 8.))
                        .child(bar(0.85, 8.))
                        .child(bar(0.9, 8.))
                        .child(bar(0.55, 8.)),
                ),
        )
}

/// The Diff tab's rows while the PR's changes are read: a file's name and
/// its counts each.
fn files_skeleton(fill: Hsla) -> impl IntoElement {
    const NAMES: [f32; 4] = [0.6, 0.45, 0.7, 0.4];
    v_flex()
        .id("pr-files-skeleton")
        .w_full()
        .pt(px(6.))
        .gap(px(12.))
        .with_animation(
            "pr-files-skeleton",
            Animation::new(std::time::Duration::from_millis(1800))
                .repeat()
                .with_easing(bounce(ease_in_out)),
            |el, delta| el.opacity(1. - delta * 0.5),
        )
        .children(NAMES.into_iter().map(move |w| {
            h_flex()
                .w_full()
                .gap(px(8.))
                .items_center()
                .child(div().flex_none().size(px(9.)).rounded(px(2.)).bg(fill))
                .child(
                    div()
                        .flex_1()
                        .child(div().w(relative(w)).h(px(9.)).rounded_full().bg(fill)),
                )
                .child(
                    div()
                        .flex_none()
                        .w(px(46.))
                        .h(px(9.))
                        .rounded_full()
                        .bg(fill),
                )
        }))
}

/// PRs read before, kept between runs (`CachedPr`), one file each, so one
/// opened again shows at once while it's read again. A scripted app keeps
/// its own beside its automation file, never the user's.
mod cache {
    use std::path::PathBuf;
    use threadbear_core::pull_requests::{CachedPr, PrRef};

    /// How many are kept: the oldest go past this.
    const KEEP: usize = 200;

    fn folder() -> Option<PathBuf> {
        if crate::scripted::scripted() {
            let file = PathBuf::from(std::env::var_os("THREADBEAR_AUTOMATION")?);
            return Some(file.parent()?.join("prs"));
        }
        let home = PathBuf::from(std::env::var_os("HOME").filter(|h| !h.is_empty())?);
        Some(if cfg!(target_os = "macos") {
            home.join("Library/Caches/Threadbear/prs")
        } else {
            home.join(".cache/threadbear/prs")
        })
    }

    pub(super) fn read(url: &str) -> Option<CachedPr> {
        let name = PrRef::parse(url)?.cache_name();
        let bytes = std::fs::read(folder()?.join(name)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Written whole and moved into place, this user's only (private repos'
    /// PRs are in it), so a read never finds half.
    pub(super) fn write(kept: &CachedPr) {
        let (Some(dir), Some(r)) = (folder(), PrRef::parse(&kept.pr.url)) else {
            return;
        };
        let Ok(bytes) = serde_json::to_vec(kept) else {
            return;
        };
        if threadbear_core::private_file::write(&dir.join(r.cache_name()), &bytes).is_ok() {
            prune(&dir);
        }
    }

    fn prune(dir: &std::path::Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        if files.len() <= KEEP {
            return;
        }
        files.sort_by_key(|a| std::cmp::Reverse(a.0));
        for (_, path) in files.drain(KEEP..) {
            let _ = std::fs::remove_file(path);
        }
    }
}
