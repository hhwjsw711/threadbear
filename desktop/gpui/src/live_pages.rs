// Live pages (the livePages experiment, docs/live-pages-design): a page an
// agent shows in its reply as `![title](/path/page.html)` is a card in the
// transcript. Until Run it shows only its title and what Run does; Run puts
// the page there in the card, with its scripts on, in the side pane's sealed
// page view (web_panels::local_page: no network, nothing read but the page and
// what it names in its folder, served only while its bytes are the ones Run
// was pressed for). One runs at a time; Stop, Run on another, or the page
// changing on disk stops it. Scrolled partly out of the transcript, its view
// hides (a native view can't be cut to the transcript), and Chromium pauses
// it while it's hidden. Full size moves the running page into the side pane,
// as wide and tall as Mike makes the pane (Mike, 20 Nov: "a bit small and
// can't be resized"); the card then says where it is, and Stop, Run on
// another, or the pane closing still stop it.
//
// The reply's `![...](....html)` becomes a fenced block first
// (rows::markdown::live_pages), drawn here by a block plugin of the kit's,
// as rich_boxes.rs draws ```html.
use crate::style::{self, px, size};
use gpui_kit::base::text::{MarkdownNode, MarkdownParseContext, MarkdownPlugin};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;

pub(crate) const EXPERIMENT: &str = "livePages";
/// The fence a live page becomes in the reply's markdown: a name with a
/// random part made each time the app starts, so only the app's own rewrite
/// (rows::markdown::live_pages, which checks the experiment and that the
/// thread is this Mac's) makes a card. A fence an agent writes itself is just
/// code, whatever it's called (Codex and Gemini's review, 19 Nov).
pub(crate) fn fence() -> &'static str {
    static FENCE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    FENCE.get_or_init(|| {
        use std::hash::{BuildHasher as _, Hasher as _};
        let half = |n: u64| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(n);
            h.finish()
        };
        format!("threadbear-live-page-{:016x}{:016x}", half(1), half(2))
    })
}
const NODE: &str = "live-page";

pub(crate) const RUN_TIP: &str =
    "Run this page here: its scripts on, with no internet and no files but its own";
pub(crate) const STOP_TIP: &str = "Stop this page";
pub(crate) const BIG_TIP: &str = "Run this page big in the side pane, which you can widen";
const IN_PANE: &str = "Running in the side pane.";
const PANE_STOPPED: &str =
    "This page has stopped. Press Run or Full size on its card to start it again.";
const SEALED: &str = "Runs sealed: no internet, and no files but its own.";

/// The card's measures, in points at 100%.
const HEADER: f32 = 34.;
const PAD: f32 = 12.;
const RADIUS: f32 = 8.;
/// The page's height for its width, a little wider than tall.
const ASPECT: f32 = 0.62;
/// Short enough to sit whole in the transcript over the composer, as its
/// view only shows while all of it is in sight.
const MAX_BODY: f32 = 360.;
/// The least it shrinks to for a short transcript.
const MIN_BODY: f32 = 140.;

/// Whether the experiment's on (from the runner's hello), and which page is running.
#[derive(Default)]
pub(crate) struct LivePages {
    on: bool,
    /// Pages run only in the main window, where the pool's views live.
    main: Option<AnyWindowHandle>,
    running: Option<Running>,
    /// Bumped by each Run, so running a page again makes a fresh one.
    runs: u64,
}

#[derive(Clone)]
struct Running {
    /// The file as the reply names it, which picks the card.
    path: String,
    /// The page the open gate found, and the bytes Run was pressed for.
    real: String,
    digest: String,
    run: u64,
    /// Opened big: it shows in the side pane, not the card.
    big: bool,
}

/// Seconds a running page's view may stay hidden (another thread open, the
/// card scrolled partly away, a menu over it) before the page stops, as a
/// hidden page's workers would otherwise go on running. Read from the view,
/// not from the card being drawn: the app draws nothing while Mike drags
/// inside the page, which is the page's own view (Gemini's second review).
const HIDDEN_CHECKS: u32 = 3;
/// The most a live page may be, as the runner sends no more to the phone.
const MAX_PAGE_BYTES: u64 = 10 * 1024 * 1024;

impl Global for LivePages {}

pub(crate) fn set_on(on: bool, main: AnyWindowHandle, cx: &mut App) {
    let state = cx.default_global::<LivePages>();
    state.on = on;
    state.main = Some(main);
}

pub(crate) fn on(cx: &App) -> bool {
    cx.try_global::<LivePages>().is_some_and(|l| l.on)
}

/// The page a card names: where it is, and what the agent called it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LivePage {
    pub(crate) path: String,
    pub(crate) title: String,
}

impl LivePage {
    /// From the fence's body: the path on its first line, the title on the next.
    pub(crate) fn from_fence(lang: Option<&str>, value: &str) -> Option<LivePage> {
        if lang != Some(fence()) {
            return None;
        }
        let mut lines = value.lines();
        let path = lines.next()?.trim().to_owned();
        if !path.starts_with('/') {
            return None;
        }
        let title = lines
            .next()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map_or_else(
                || threadbear_core::highlights::last_component(&path).to_owned(),
                str::to_owned,
            );
        Some(LivePage { path, title })
    }
}

// ---------------------------------------------------------------- the plugin

pub(crate) struct Cards;

#[derive(Clone)]
struct PageRef(LivePage);

impl MarkdownPlugin for Cards {
    fn is_block(&self) -> bool {
        true
    }

    fn name(&self) -> &str {
        NODE
    }

    fn parse(
        &self,
        node: &markdown::mdast::Node,
        cx: &MarkdownParseContext<'_>,
    ) -> Option<MarkdownNode> {
        let markdown::mdast::Node::Code(code) = node else {
            return None;
        };
        let page = LivePage::from_fence(code.lang.as_deref(), &code.value)?;
        let source = cx.node_source(node).unwrap_or_default().to_owned();
        // A selection across the reply copies it as the agent wrote it.
        let written = format!("![{}]({})", page.title, page.path);
        Some(
            MarkdownNode::new(NODE, PageRef(page.clone()))
                .text(written)
                .markdown(source)
                .accessibility_label(format!("Live page {}", page.title)),
        )
    }

    fn render(&self, node: &MarkdownNode, window: &mut Window, cx: &mut App) -> impl IntoElement {
        match node.data::<PageRef>() {
            Some(PageRef(page)) => card(page, window, cx),
            None => div().child(node.as_text().to_owned()).into_any_element(),
        }
    }
}

// ---------------------------------------------------------------- running

/// What Run found: the page to run, or why it can't.
pub(crate) fn prepare(path: &str) -> Result<(String, String), String> {
    let real = threadbear_core::local_preview::decide_page(
        path,
        threadbear_core::open_policy::Origin::ThisMac,
    )?;
    if std::fs::metadata(&real).is_ok_and(|m| m.len() > MAX_PAGE_BYTES) {
        return Err("This page is over 10 MB, so it doesn't run here.".into());
    }
    let (_, digest) =
        threadbear_core::local_preview::scan(&real).ok_or("Threadbear couldn't read that page.")?;
    Ok((real.to_string_lossy().into_owned(), digest))
}

fn run(page: &LivePage, window: &mut Window, cx: &mut App) {
    // The experiment's switch again, at the click.
    let found = if on(cx) {
        prepare(&page.path)
    } else {
        Err("Live pages are off (Settings > General > Experiments).".into())
    };
    let state = cx.default_global::<LivePages>();
    state.runs += 1;
    let run = state.runs;
    state.running = found.as_ref().ok().map(|(real, digest)| Running {
        path: page.path.clone(),
        real: real.clone(),
        digest: digest.clone(),
        run,
        big: false,
    });
    match found {
        Ok((real, digest)) => {
            FAILED.with(|f| f.borrow_mut().remove(&page.path));
            crate::web_panels::close_live_pages(Some((&real, &digest, run)), cx);
            watch(run, cx);
        }
        Err(why) => {
            FAILED.with(|f| f.borrow_mut().insert(page.path.clone(), why));
            crate::web_panels::close_live_pages(None, cx);
        }
    }
    window.refresh();
}

/// Full size: runs the page if it isn't running, then shows it in the side
/// pane beside this thread, opening the pane if it's shut. The same page
/// moves there (one view, one key), so it doesn't start again.
fn open_big(page: &LivePage, window: &mut Window, cx: &mut App) {
    if running_for(page, cx).is_none() {
        run(page, window, cx);
    }
    let Some(running) = cx
        .global_mut::<LivePages>()
        .running
        .as_mut()
        .filter(|r| r.path == page.path)
    else {
        return;
    };
    running.big = true;
    let Some(app) = crate::terminal::app(cx) else {
        return;
    };
    let side = app.read(cx).side.clone();
    let Some(thread) = side.read(cx).thread(cx) else {
        return;
    };
    app.update(cx, |t, cx| {
        t.open_preview_panel(
            &page.path,
            Some(page.title.clone()),
            None,
            true,
            None,
            &thread,
            cx,
        );
    });
    window.refresh();
}

/// The side pane's view of a page opened big: the running page, if it's
/// still this one and still big, else a note saying how to start it again.
pub(crate) fn pane_view(real: &str, main: bool, window: &mut Window, cx: &mut App) -> AnyElement {
    let running = cx
        .try_global::<LivePages>()
        .and_then(|s| s.running.clone())
        .filter(|r| r.big && r.real == real);
    match running {
        Some(r) => div()
            .id("live-page-pane")
            .size_full()
            .child(crate::web_panels::live_page(
                &r.real, &r.digest, r.run, true, main, window, cx,
            ))
            .into_any_element(),
        None => v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .p(px(24.))
            .child(
                div()
                    .text_center()
                    .text_size(px(size::DETAIL))
                    .text_color(style::secondary_label(cx))
                    .child(PANE_STOPPED),
            )
            .into_any_element(),
    }
}

fn stop(window: &mut Window, cx: &mut App) {
    cx.default_global::<LivePages>().running = None;
    crate::web_panels::close_live_pages(None, cx);
    window.refresh();
}

/// While `run` is the running page, once a second: stopped when its view
/// has been hidden for `HIDDEN_CHECKS` checks in a row, or when its file no
/// longer has the bytes Run was pressed for (read here, not as the card draws).
fn watch(run: u64, cx: &mut App) {
    cx.spawn(async move |cx| {
        let mut hidden_for = 0;
        loop {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(1))
                .await;
            let Some(running) =
                cx.update(|cx| cx.try_global::<LivePages>().and_then(|s| s.running.clone()))
            else {
                break;
            };
            if running.run != run {
                break;
            }
            let real = running.real.clone();
            let same = cx
                .background_executor()
                .spawn(async move {
                    threadbear_core::local_preview::scan(std::path::Path::new(&real))
                        .map(|(_, d)| d)
                })
                .await
                .is_some_and(|d| d == running.digest);
            let hidden = cx.update(|cx| {
                crate::web_panels::live_page_hidden(&running.real, &running.digest, run, cx)
            });
            hidden_for = if hidden == Some(true) {
                hidden_for + 1
            } else {
                0
            };
            if same && hidden_for < HIDDEN_CHECKS {
                continue;
            }
            cx.update(|cx| {
                if cx
                    .try_global::<LivePages>()
                    .and_then(|s| s.running.as_ref())
                    .is_some_and(|r| r.run == run)
                {
                    cx.default_global::<LivePages>().running = None;
                    crate::web_panels::close_live_pages(None, cx);
                    if !same {
                        FAILED.with(|f| {
                            f.borrow_mut().insert(
                                running.path.clone(),
                                "The page changed, so it stopped. Run it again to see the new one."
                                    .into(),
                            )
                        });
                    }
                    cx.refresh_windows();
                }
            });
            break;
        }
    })
    .detach();
}

thread_local! {
    /// Why a card's Run didn't start it, by path, until it's pressed again.
    static FAILED: std::cell::RefCell<std::collections::HashMap<String, String>> = std::cell::RefCell::new(std::collections::HashMap::new());
}

/// The running page for this card.
fn running_for(page: &LivePage, cx: &App) -> Option<Running> {
    cx.try_global::<LivePages>()?
        .running
        .clone()
        .filter(|r| r.path == page.path)
}

/// For the dump: the running page's path, if any.
pub(crate) fn dump(cx: &App) -> serde_json::Value {
    let state = cx.try_global::<LivePages>();
    serde_json::json!({
        "on": state.is_some_and(|s| s.on),
        "running": state.and_then(|s| s.running.as_ref()).map(|r| r.path.clone()),
        "big": state.and_then(|s| s.running.as_ref()).is_some_and(|r| r.big),
    })
}

// ---------------------------------------------------------------- the card

fn card(page: &LivePage, window: &mut Window, cx: &mut App) -> AnyElement {
    let running = running_for(page, cx);
    let (fill, edge, hairline, label, secondary) = (
        style::code_background(cx),
        style::card_border(cx),
        style::hairline(cx),
        style::label_text(cx),
        style::secondary_label(cx),
    );
    let id = stable_id(&page.path);
    let big = running.as_ref().is_none_or(|r| !r.big).then(|| {
        let page = page.clone();
        text_button(
            format!("live-big-{id}"),
            "Full size",
            BIG_TIP,
            false,
            cx,
            move |window, cx| open_big(&page, window, cx),
        )
    });
    let button = if running.is_some() {
        text_button(format!("live-stop-{id}"), "Stop", STOP_TIP, false, cx, stop)
    } else {
        let page = page.clone();
        text_button(
            format!("live-run-{id}"),
            "Run",
            RUN_TIP,
            true,
            cx,
            move |window, cx| run(&page, window, cx),
        )
    };
    let header = h_flex()
        .h(px(HEADER))
        .flex_none()
        .items_center()
        .pl(px(PAD))
        .pr(px(8.))
        .gap(px(8.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(size::DETAIL))
                .font_weight(FontWeight::MEDIUM)
                .text_color(label)
                .child(page.title.clone()),
        )
        .child(
            div()
                .flex_none()
                .max_w(px(200.))
                .truncate()
                .text_size(px(size::DETAIL))
                .text_color(secondary)
                .child(threadbear_core::highlights::last_component(&page.path).to_owned()),
        )
        .children(big)
        .child(button);
    // In points, as `px` zooms them.
    let width = (f32::from(window.viewport_size().width) / style::zoom_scale())
        .min(style::MAX_CONTENT_WIDTH);
    // Never taller than the transcript has room for, header and a margin
    // included, or the page would never be wholly in view to show.
    let room =
        crate::web_panels::live_room().map_or(MAX_BODY, |h| (h - HEADER - 24.).max(MIN_BODY));
    let height = (width * ASPECT).min(MAX_BODY).min(room);
    let body = match running {
        Some(r) if !r.big => {
            let main =
                cx.try_global::<LivePages>().and_then(|s| s.main) == Some(window.window_handle());
            // Hidden while partly scrolled out, it leaves the box's own fill.
            let view =
                crate::web_panels::live_page(&r.real, &r.digest, r.run, false, main, window, cx);
            div().w_full().h(px(height)).child(view).into_any_element()
        }
        Some(_) => v_flex()
            .w_full()
            .min_h(px(height.min(120.)))
            .items_center()
            .justify_center()
            .px(px(PAD))
            .child(
                div()
                    .text_size(px(size::DETAIL))
                    .text_color(secondary)
                    .child(IN_PANE),
            )
            .into_any_element(),
        None => {
            let why = FAILED.with(|f| f.borrow().get(&page.path).cloned());
            v_flex()
                .w_full()
                .min_h(px(height.min(120.)))
                .items_center()
                .justify_center()
                .gap(px(6.))
                .px(px(PAD))
                .child(
                    div()
                        .text_size(px(size::DETAIL))
                        .text_color(if why.is_some() {
                            style::failed_text(cx)
                        } else {
                            secondary
                        })
                        .child(why.unwrap_or_else(|| SEALED.to_owned())),
                )
                .into_any_element()
        }
    };
    v_flex()
        .id(SharedString::from(format!("live-page-{id}")))
        .w_full()
        .my(px(4.))
        .rounded(px(RADIUS))
        .bg(fill)
        .border(gpui_kit::px(0.5))
        .border_color(edge)
        // No overflow_hidden: the page measures the transcript's room from
        // the clip around it (web_panels::placed), and clipped to the card
        // it measured the card, shrinking it to the least each frame (Mike,
        // 25 Nov: the page squashed to a strip).
        // Not the start of a selection in the reply around it.
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(header)
        .child(div().h(gpui_kit::px(0.5)).w_full().bg(hairline))
        .child(body)
        .into_any_element()
}

/// A card's element id: the same path, the same id.
fn stable_id(path: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish()
}

/// Run (filled) or Stop in the header.
fn text_button(
    id: String,
    title: &'static str,
    tip: &'static str,
    filled: bool,
    cx: &App,
    action: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let (accent, label, hover) = (
        style::control_accent(cx),
        style::label_text(cx),
        style::primary_opacity(cx, 0.08),
    );
    let button = div()
        .id(SharedString::from(id))
        .role(Role::Button)
        .flex_none()
        .h(px(22.))
        .px(px(10.))
        .rounded(px(6.))
        .flex()
        .items_center()
        .cursor_pointer()
        .text_size(px(size::DETAIL))
        .font_weight(FontWeight::MEDIUM)
        .when(filled, |d| d.bg(accent).text_color(gpui_kit::white()))
        .when(!filled, |d| {
            d.border(gpui_kit::px(0.5))
                .border_color(style::button_edge(cx))
                .text_color(label)
                .hover(move |s| s.bg(hover))
        })
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| action(window, cx))
        .child(title);
    crate::highlights::tipped(button, tip).into_any_element()
}

#[cfg(test)]
mod tests {
    use super::{fence, LivePage};

    #[test]
    fn a_fence_names_its_page_and_title() {
        assert_eq!(
            LivePage::from_fence(Some(fence()), "/w/garden.html\nGarden lights\n"),
            Some(LivePage {
                path: "/w/garden.html".into(),
                title: "Garden lights".into()
            })
        );
        assert_eq!(
            LivePage::from_fence(Some(fence()), "/w/garden.html\n").map(|p| p.title),
            Some("garden.html".into())
        );
        assert_eq!(
            LivePage::from_fence(Some("html"), "/w/garden.html\nx"),
            None
        );
        // One an agent writes by the old fixed name is only code.
        assert_eq!(
            LivePage::from_fence(Some("threadbear-live-page"), "/w/garden.html\nx"),
            None
        );
        assert!(fence().len() > "threadbear-live-page-".len() + 16);
        assert_eq!(
            LivePage::from_fence(Some(fence()), "relative/garden.html\nx"),
            None
        );
    }
}
