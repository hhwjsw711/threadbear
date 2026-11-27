// The stage (ReviewWindow.swift's `stage`): which option and shot this is
// over it, the shot itself (or all of them side by side), and under it the
// arrows, the option's other shots and a mark for every shot of every option.
//
// The shot zoomed in is threadbear_core::review::StageZoom; this draws the
// image where it says, at the stage's own points (a native scroll view's, so
// not the app's text zoom), and hands it the pointer.
use super::ReviewWindow;
use crate::style::{self, px};
use futures::StreamExt as _;
use gpui_kit::assets::IconName;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Icon, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use std::cell::Cell;
use std::rc::Rc;
use threadbear_core::open_policy::Origin;
use threadbear_core::reducer::{ReviewOption, ReviewShot};
use threadbear_core::review::{
    self as rules, GalleryLayout, Point as StagePoint, ReviewMode, ScrollPhase, StageZoom, ZoomStep,
};

/// ReviewWindow's spacing, in the stage's points.
const STAGE_INSET: f32 = 14.;
const CELL_SPACING: f32 = 12.;
const CELL_PADDING: f32 = 8.;
const CAPTION_HEIGHT: f32 = 20.;
/// The film strip's pictures, cropped from the top left.
const STRIP_THUMB: (f32, f32) = (92., 58.);
/// The film strip's row: its pictures, their names and the room round them.
const STRIP_ROW: f32 = 96.;
/// The column back and next each stand in, beside the picture.
const STEP_COLUMN: f32 = 60.;
/// What a wheel's line is in points when Shift turns it sideways.
const WHEEL_LINE: f32 = 16.;

/// What the stage holds between frames.
#[derive(Default)]
pub(crate) struct StageState {
    /// The images' room as last drawn, in window points: the zoom's view and
    /// the gallery's room come from it, a frame behind a resize.
    room: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The shot on show, zoomed and moved, with the image it's for and
    /// whether that was today's version flicked to.
    zoom: Option<Zoomed>,
    /// A zoom asked for before the stage had its size.
    pending: Option<ZoomStep>,
    /// The minimap's being dragged.
    minimap_drag: bool,
    strip_scroll: ScrollHandle,

    /// The option and shot the film strip last scrolled to.
    followed: Option<(usize, usize)>,
    /// A page shot on show, sealed with its scripts off (`review.media`):
    /// its file and its view, dropped once another shot shows.
    pub(crate) page: Option<(String, Rc<threadbear_web::PanelPage>)>,
    pub(super) page_events: Option<Task<()>>,
    #[cfg(feature = "automation")]
    pub(super) focus_events: u64,
    live_digest: Option<String>,
    pub(super) notice: Option<String>,
    /// Why the page shot on show couldn't show in place, by its file.
    pub(super) page_failed: Option<(String, String)>,
    /// What the page is waiting for (the runtime), for the dump.
    page_waiting: Option<String>,
    /// The web runtime watched, so the stage draws again as it starts.
    runtime_watch: Option<Subscription>,
}

struct Zoomed {
    path: String,
    peeking: bool,
    zoom: StageZoom,
}

impl StageState {
    /// Why the last page shot couldn't show in place, for the dump.
    pub(crate) fn page_failed_reason(&self) -> Option<String> {
        self.page_failed
            .as_ref()
            .map(|(_, why)| why.clone())
            .or_else(|| self.page_waiting.clone())
    }

    pub(crate) fn zoom_requested(&mut self, step: ZoomStep) {
        match &mut self.zoom {
            Some(z) => z.zoom.apply(step),
            None => self.pending = Some(step),
        }
    }

    pub(crate) fn is_zoomed(&self) -> bool {
        self.zoom.as_ref().is_some_and(|z| z.zoom.is_zoomed())
    }

    pub(crate) fn minimap_showing(&self) -> bool {
        self.zoom
            .as_ref()
            .is_some_and(|z| z.zoom.minimap().is_some())
    }

    fn room(&self) -> Option<Bounds<Pixels>> {
        self.room.get()
    }

    /// The zoom for the shot about to be drawn: kept for the same image; for
    /// today's version flicked to (or back), the same part at the same zoom,
    /// or there'd be nothing to compare; for any other, fitted afresh.
    fn follow(
        &mut self,
        path: &str,
        peeking: bool,
        doc: (f64, f64),
        view: (f64, f64),
    ) -> &mut StageZoom {
        let keep = self.zoom.as_ref().is_some_and(|z| z.path == path);
        if !keep {
            let swapped = self.zoom.as_ref().is_some_and(|z| z.peeking != peeking);
            match (&mut self.zoom, swapped) {
                (Some(z), true) => {
                    z.zoom.set_view(view.0, view.1);
                    z.zoom.swap_image(doc.0, doc.1);
                    z.path = path.to_owned();
                    z.peeking = peeking;
                }
                _ => {
                    let mut zoom = StageZoom::new(doc.0, doc.1, view.0, view.1);
                    if let Some(step) = self.pending.take() {
                        zoom.apply(step);
                    }
                    self.zoom = Some(Zoomed {
                        path: path.to_owned(),
                        peeking,
                        zoom,
                    });
                }
            }
        }
        #[expect(clippy::expect_used, reason = "made just above when there was none")]
        let z = self.zoom.as_mut().expect("just made");
        z.peeking = peeking;
        if let Some(step) = self.pending.take() {
            z.zoom.apply(step);
        }
        z.zoom.set_view(view.0, view.1);
        &mut z.zoom
    }
}

/// An image's size in pixels, or the Swift app's stand-in when the runner
/// didn't say (`sourceSize`).
fn pt(v: f64) -> Pixels {
    gpui_kit::px(v as f32)
}

impl ReviewWindow {
    pub(super) fn render_stage(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let dark = cx.theme().is_dark();
        let single = self.session.mode == ReviewMode::Single;
        let images = if single {
            self.render_shot(window, cx)
        } else {
            self.render_gallery(window, cx)
        };
        let (back, next) = self.render_steps(cx);
        // The film strip's row whenever any option has several shots, so
        // the picture keeps its size from one option to the next. Side by
        // side they have its room too.
        let strip = (single
            && self
                .session
                .review()
                .options
                .iter()
                .any(|o| o.shot_count() > 1))
        .then(|| self.render_strip_row(cx));
        let room = self.stage.room.clone();
        v_flex()
            .id("review-stage")
            .flex_1()
            .min_h_0()
            .w_full()
            .bg(hsla(0., 0., 0., if dark { 0.22 } else { 0.05 }))
            .child(
                // A shot keeps clear of the title bar and the band, as the
                // caption and the row of marks once kept it; side by side
                // they have their own inset.
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .when(single, |s| s.py(px(STAGE_INSET)))
                    .child(back)
                    .child(
                        div()
                            .id("review-images")
                            .relative()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .overflow_hidden()
                            .child(
                                canvas(move |bounds, _, _| room.set(Some(bounds)), |_, _, _, _| {})
                                    .absolute()
                                    .size_full(),
                            )
                            .child(images),
                    )
                    .child(next),
            )
            .children(strip)
            .into_any_element()
    }

    /// The ways to try the option on show, at the end of the tabs' row:
    /// today's version flicked to, the option running live.
    pub(super) fn render_tries(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let Some(option) = self
            .session
            .shown_option()
            .filter(|_| self.session.mode == ReviewMode::Single)
            .cloned()
        else {
            return vec![];
        };
        let mut buttons: Vec<AnyElement> = vec![];
        if let (Some(baseline), true) = (self.session.baseline().cloned(), self.session.can_peek())
        {
            let peeking = self.session.peeking;
            let focused = self
                .session
                .focused_option()
                .map(|o| o.id.clone())
                .unwrap_or_else(|| "it".into());
            let tip = if peeking {
                format!("Back to {focused} (or let go of Space)")
            } else {
                format!("Flick to {}: click, or hold Space", baseline.title)
            };
            let (fg, bg) = if peeking {
                (gpui_kit::white(), style::control_accent(cx))
            } else {
                (style::label_text(cx), style::primary_opacity(cx, 0.08))
            };
            buttons.push(
                // Its words in a 140 wide frame, as the Swift label's
                // `frame(maxWidth: 140)` takes all of that whatever they say.
                crate::highlights::tipped(
                    capsule_button(
                        "review-peek",
                        Icon::new(IconName::ArrowLeftRight),
                        16.,
                        12.,
                        &baseline.title,
                        fg,
                        bg,
                    )
                    .w(px(140. + 22.))
                    .justify_center(),
                    tip,
                )
                .on_click(
                    cx.listener(move |this, _: &ClickEvent, _, cx| this.set_peeking(!peeking, cx)),
                )
                .into_any_element(),
            );
        }
        if let Some(url) = option.url.clone() {
            let tip = format!("Try {} running live: {url}", option.id);
            buttons.push(
                crate::highlights::tipped(
                    capsule_button(
                        "review-open-live",
                        Icon::new(IconName::ArrowUpRight),
                        12.,
                        7.,
                        "Open live",
                        style::label_text(cx),
                        style::primary_opacity(cx, 0.08),
                    ),
                    tip,
                )
                // Only a web page, which is all an option's url is for: a
                // runner (maybe another Mac's) sends it, and anything else
                // would open whatever it named here.
                .on_click(move |_, _, cx| {
                    crate::open_gate::open_web(&url, cx);
                })
                .into_any_element(),
            );
        }
        buttons
    }

    /// One shot with the whole stage to zoom in. A click goes back to all of
    /// them; zoomed in, a press is for dragging.
    fn render_shot(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let (Some(shot), Some(room)) = (self.session.shown_shot(), self.stage.room()) else {
            return div().into_any_element();
        };
        if shot.media.is_some() {
            return self.render_media(&shot, room, window, cx);
        }
        let scale = f64::from(window.scale_factor()).max(1.);
        let (w, h) = super::parts::pixels(&shot.image);
        let peeking = self.session.peeking && self.session.can_peek();
        let path = shot.image.path.clone();
        let zoom = self.stage.follow(
            &path,
            peeking,
            (w / scale, h / scale),
            (f64::from(room.size.width), f64::from(room.size.height)),
        );
        let image = zoom.image_rect();
        let minimap = zoom.minimap();
        let fitted = zoom.is_fitted();
        let dragging = zoom.dragging();
        self.after_zoom();
        let id = self
            .session
            .focused_option()
            .map(|o| o.id.clone())
            .unwrap_or_default();
        let unavailable = style::secondary_text(cx);
        let mut stage = div()
            .id("review-shot")
            .absolute()
            .size_full()
            .overflow_hidden()
            .cursor(if fitted {
                CursorStyle::Arrow
            } else if dragging {
                CursorStyle::ClosedHand
            } else {
                CursorStyle::OpenHand
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                    this.stage_pressed(ev, window, cx)
                }),
            )
            .on_scroll(cx.listener(|this, ev: &ScrollEvent, _, cx| this.stage_scrolled(ev, cx)))
            .on_pinch(cx.listener(|this, ev: &PinchEvent, _, cx| this.stage_pinched(ev, cx)))
            .child(
                // With an id, so a GIF option plays (files.rs, the pane's picture).
                img(crate::rows::markdown::file_picture(&path))
                    .id(SharedString::from(format!("stage-picture-{path}")))
                    .absolute()
                    .left(pt(image.x))
                    .top(pt(image.y))
                    .w(pt(image.width))
                    .h(pt(image.height))
                    .object_fit(ObjectFit::Fill)
                    .with_fallback(move || {
                        div()
                            .size_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                Icon::new(IconName::ImageOff)
                                    .with_size(gpui_kit::px(40.))
                                    .text_color(unavailable),
                            )
                            .into_any_element()
                    }),
            );
        if let Some(map) = minimap {
            stage = stage.child(self.render_minimap(&path, map, cx));
        }
        // Zoomed in, no tip over the image: it's for dragging, and a tip
        // would sit over what's being looked at.
        if fitted {
            crate::highlights::tipped(
                stage,
                format!("{id}: click to see them all, scroll to zoom"),
            )
            .into_any_element()
        } else {
            stage.into_any_element()
        }
    }

    /// A clip, a sound or a page. On a Mac the clip plays on the stage in the
    /// system's player, round and round with its controls and its sound on,
    /// as the Swift window's does: some clips are there to be heard. A sound
    /// is its waveform with the pane's play bar along the bottom, paused at
    /// the start, so stepping through music beds doesn't start each. A page,
    /// or a clip anywhere else (or one the open gate won't play), is its
    /// still, fitted, with a button that opens it where it can, through the
    /// gate (the clip in the app this computer plays videos in, the page in
    /// the browser). The Swift window shows the page in place with its
    /// scripts off.
    fn render_media(
        &mut self,
        shot: &ReviewShot,
        room: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // Zoom is for pictures: a clip or page has its own ways to move round.
        self.stage.zoom = None;
        self.after_zoom();
        let fit = GalleryLayout::fit(
            rules::aspect(&shot.image),
            f64::from(room.size.width),
            f64::from(room.size.height),
        );
        // A page in place, sealed as the pane's are: only its own named
        // assets, no network, its scripts off (the Swift window's too).
        if let Some(page) = shot.page() {
            if let Some(view) = self.stage_page(page, window, cx) {
                return div()
                    .id("review-media")
                    .absolute()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(div().flex_none().w(pt(fit.0)).h(pt(fit.1)).child(view))
                    .into_any_element();
            }
        }
        if let Some(video) = shot.video().filter(|_| crate::media_view::SHOWN_HERE) {
            let path = video.to_owned();
            // Fitted as its still is, so the controls sit on the film.
            if let Ok(view) = crate::media_view::slot(&stage_key(video), window, |opening| {
                crate::open_gate::show_media(
                    &path,
                    Origin::ThisMac,
                    crate::media_view::Kind::StageVideo,
                    opening,
                )
            }) {
                return div()
                    .id("review-media")
                    .absolute()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(div().flex_none().w(pt(fit.0)).h(pt(fit.1)).child(view))
                    .into_any_element();
            }
        }
        if let Some(sound) = shot.audio().filter(|_| crate::media_view::SHOWN_HERE) {
            let path = sound.to_owned();
            if let Ok(view) = crate::media_view::slot(&stage_key(sound), window, |opening| {
                crate::open_gate::show_media(
                    &path,
                    Origin::ThisMac,
                    crate::media_view::Kind::PaneAudio,
                    opening,
                )
            }) {
                return div()
                    .id("review-media")
                    .absolute()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .relative()
                            .flex_none()
                            .w(pt(fit.0))
                            .h(pt(fit.1))
                            .child(
                                img(crate::rows::markdown::file_picture(&shot.image.path))
                                    .size_full()
                                    .object_fit(ObjectFit::Fill),
                            )
                            // The bar sits in the middle of its slot, at most
                            // 560 wide (native/media_views.m, layoutInSlot).
                            .child(
                                div()
                                    .absolute()
                                    .left_0()
                                    .right_0()
                                    .bottom(px(16.))
                                    .h(px(44.))
                                    .child(view),
                            ),
                    )
                    .into_any_element();
            }
        }
        let play_tip = if crate::media_view::SHOWN_HERE {
            "Play it in the app this computer plays videos in"
        } else {
            "Play it in the app this computer plays videos in: this window can't play clips yet"
        };
        let (icon, words, tip, path) = match (shot.video().or(shot.audio()), shot.page()) {
            (Some(video), _) if shot.video().is_some() => (
                IconName::Play,
                "Play the clip",
                play_tip.to_owned(),
                video.to_owned(),
            ),
            (Some(sound), _) => (
                IconName::Music,
                "Play the sound",
                if crate::media_view::SHOWN_HERE {
                    "Play it in the app this computer plays sounds in"
                } else {
                    "Play it in the app this computer plays sounds in: this window can't play sounds yet"
                }
                .to_owned(),
                sound.to_owned(),
            ),
            // Says why it isn't here: this window does show pages, so "can't
            // show pages yet" sent Mike looking for why it was a button at
            // all (16 Nov, Chromium hadn't started after an update).
            (_, Some(page)) => (
                IconName::Globe,
                "Open the page",
                format!(
                    "Open it in your browser. It isn't showing here because {}",
                    self.page_away_why(page, cx)
                ),
                page.to_owned(),
            ),
            _ => return div().into_any_element(),
        };
        let unavailable = style::secondary_text(cx);
        let button = crate::highlights::tipped(
            h_flex()
                .id("review-open-media")
                .h(px(40.))
                .px(px(18.))
                .gap(px(9.))
                .items_center()
                .rounded_full()
                .bg(hsla(0., 0., 0., 0.72))
                .border_1()
                .border_color(hsla(0., 0., 1., 0.24))
                .shadow_lg()
                .cursor_pointer()
                .hover(|s| s.bg(hsla(0., 0., 0., 0.85)))
                .text_color(gpui_kit::white())
                .child(
                    Icon::new(icon)
                        .with_size(px(16.))
                        .text_color(gpui_kit::white()),
                )
                .child(
                    div()
                        .text_size(px(style::size::BODY))
                        .font_weight(FontWeight::MEDIUM)
                        .child(words),
                ),
            tip,
        )
        .on_click(move |_, _, cx| crate::open_gate::open_file(&path, Origin::ThisMac, cx));
        div()
            .id("review-media")
            .absolute()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .relative()
                    .flex_none()
                    .w(pt(fit.0))
                    .h(pt(fit.1))
                    .child(
                        img(crate::rows::markdown::file_picture(&shot.image.path))
                            .size_full()
                            .object_fit(ObjectFit::Fill)
                            .with_fallback(move || {
                                div()
                                    .size_full()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(
                                        Icon::new(IconName::ImageOff)
                                            .with_size(gpui_kit::px(40.))
                                            .text_color(unavailable),
                                    )
                                    .into_any_element()
                            }),
                    )
                    // Dimmed, so it reads as a still with something to open,
                    // and the button stands out over any mockup.
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .bg(hsla(0., 0., 0., 0.35))
                            .flex()
                            .items_center()
                            .justify_center()
                            // Under it, after a failed start, the way to get
                            // pages back here (web panels and Settings have it too).
                            .child(v_flex().items_center().gap(px(10.)).child(button).children(
                                shot.page().and_then(|_| {
                                    crate::web_runtime::try_again_button("review-web-try-again", cx)
                                }),
                            )),
                    ),
            )
            .into_any_element()
    }

    /// Why a page shot is its still rather than the page: what stopped
    /// `stage_page`.
    fn page_away_why(&self, path: &str, cx: &App) -> String {
        if let Some((_, why)) = self.stage.page_failed.as_ref().filter(|(p, _)| p == path) {
            return why.clone();
        }
        use crate::web_runtime::Engine;
        use threadbear_core::web_runtime::State;
        let Some(runtime) = crate::web_runtime::runtime(cx) else {
            return "pages can't show here on this system yet".into();
        };
        let r = runtime.read(cx);
        match (&r.state, &r.engine) {
            (State::Ready, Engine::Failed(why)) => format!("the web runtime didn't start: {why}"),
            (State::Ready, Engine::Waiting(_)) => {
                "the web runtime is waiting for the last copy of Threadbear to quit".into()
            }
            (State::Ready, _) => "the web runtime is starting".into(),
            (State::Unavailable, _) => "pages can't show here on this system yet".into(),
            (state, _) => format!(
                "the web runtime isn't ready ({})",
                state.words().to_lowercase()
            ),
        }
    }

    /// The page's view, placed where it's drawn each frame, or None while the
    /// web runtime isn't running here or the gate won't show the file: then
    /// the still and Open the page, as before.
    pub(super) fn stage_page(
        &mut self,
        path: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        self.page_view(path, false, window, cx)
    }

    pub(super) fn canvas_live_page(
        &mut self,
        path: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        self.page_view(path, true, window, cx)
    }

    fn page_view(
        &mut self,
        path: &str,
        live: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let Some(runtime) = crate::web_runtime::runtime(cx) else {
            self.stage.page_waiting = Some("no web runtime here".into());
            return None;
        };
        // Drawn again as it starts, so the page comes once it's running.
        if self.stage.runtime_watch.is_none() {
            self.stage.runtime_watch = Some(cx.observe(&runtime, |_, _, cx| cx.notify()));
        }
        if runtime.read(cx).state != threadbear_core::web_runtime::State::Ready
            || !runtime.update(cx, |r, cx| r.ensure_engine(cx))
        {
            self.stage.page_waiting = Some(format!("runtime {:?}", runtime.read(cx).state));
            return None;
        }
        self.stage.page_waiting = None;
        if self
            .stage
            .page_failed
            .as_ref()
            .is_some_and(|(p, _)| p == path)
        {
            return None;
        }
        if self.stage.page.as_ref().is_none_or(|(p, _)| p != path)
            || self.stage.live_digest.is_some() != live
        {
            self.drop_page(cx);
            let made = (|| {
                let preview = if live {
                    let (real, digest) = crate::live_pages::prepare(path)?;
                    let real = std::path::Path::new(&real);
                    let site =
                        threadbear_core::local_preview::Site::page_only(real, digest.clone())
                            .ok_or_else(|| "the page couldn't be sealed".to_owned())?;
                    self.stage.live_digest = Some(digest);
                    threadbear_web::PreviewSite::live(std::sync::Arc::new(site))
                } else {
                    self.stage.live_digest = None;
                    let real = threadbear_core::local_preview::decide_page(path, Origin::ThisMac)?;
                    let site = threadbear_core::local_preview::Site::new(&real, None)
                        .ok_or_else(|| "its folder couldn't be read".to_owned())?;
                    threadbear_web::PreviewSite::new(std::sync::Arc::new(site), false)
                };
                let parent = crate::web_panels::native_view(window)
                    .ok_or_else(|| "the window has no view".to_owned())?;
                let (page, events) = threadbear_web::PanelPage::open(
                    parent,
                    &preview.page_url(),
                    threadbear_web::PanelKind::Preview(preview),
                )?;
                Ok::<_, String>((page, events))
            })();
            match made {
                Ok((page, mut events)) => {
                    let page = Rc::new(page);
                    self.stage.page = Some((path.to_owned(), page.clone()));
                    let tracked = Rc::downgrade(&page);
                    let handle = self.handle;
                    self.stage.page_events = Some(cx.spawn(async move |this, cx| {
                        while let Some(event) = events.next().await {
                            if !matches!(event, threadbear_web::PanelEvent::Focused) {
                                continue;
                            }
                            cx.update_window(handle, |_, window, cx| {
                                this.update(cx, |this, cx| {
                                    if !this.stage.page.as_ref().is_some_and(|(_, p)| {
                                        std::rc::Weak::ptr_eq(&Rc::downgrade(p), &tracked)
                                    }) {
                                        return;
                                    }
                                    #[cfg(feature = "automation")]
                                    {
                                        this.stage.focus_events += 1;
                                    }
                                    this.release_reply_keys(window, cx);
                                    cx.notify();
                                })
                                .ok();
                            })
                            .ok();
                        }
                    }));
                    if let Some(digest) = self.stage.live_digest.clone() {
                        let path = path.to_owned();
                        let page = Rc::downgrade(&page);
                        cx.spawn(async move |this, cx| loop {
                            cx.background_executor().timer(std::time::Duration::from_secs(1)).await;
                            let current = this.read_with(cx, |this, _| this.stage.page.as_ref().is_some_and(|(_, p)| std::rc::Weak::ptr_eq(&Rc::downgrade(p), &page)));
                            if !matches!(current, Ok(true)) { break; }
                            let file = path.clone();
                            let same = cx.background_executor().spawn(async move {
                                crate::live_pages::prepare(&file).map(|(_, d)| d)
                            }).await.is_ok_and(|d| d == digest);
                            if !same {
                                this.update(cx, |this, cx| {
                                    if !this.stage.page.as_ref().is_some_and(|(_, p)| std::rc::Weak::ptr_eq(&Rc::downgrade(p), &page)) { return; }
                                    this.canvas_stop_playing(cx);
                                    this.stage.notice = Some("The page changed, so it stopped. Press Interact to try it again.".into());
                                    cx.notify();
                                }).ok();
                                break;
                            }
                        }).detach();
                    }
                }
                Err(why) => {
                    self.stage.page_failed = Some((path.to_owned(), why));
                    return None;
                }
            }
        }
        // The previous frame must not keep a stopped Chromium runtime alive.
        let page = Rc::downgrade(&self.stage.page.as_ref()?.1);
        // The title bar's menu draws under a native view: out of sight while it's up.
        let covered = self.more_open;
        let owner = cx.entity().downgrade();
        Some(
            canvas(
                move |bounds, window, cx| {
                    let Some(page) = page.upgrade() else { return };
                    let height = f32::from(window.viewport_size().height);
                    if live {
                        page.set_zoom_factor(threadbear_core::review_canvas::html_zoom(f32::from(
                            bounds.size.width,
                        )));
                    }
                    page.set_bounds(
                        f32::from(bounds.origin.x),
                        f32::from(bounds.origin.y),
                        f32::from(bounds.size.width),
                        f32::from(bounds.size.height),
                        height,
                    );
                    let clip = window.content_mask().bounds;
                    let whole = bounds.origin.x >= clip.origin.x
                        && bounds.origin.y >= clip.origin.y
                        && bounds.right() <= clip.right()
                        && bounds.bottom() <= clip.bottom()
                        && bounds.size.width > gpui_kit::px(0.)
                        && bounds.size.height > gpui_kit::px(0.);
                    page.set_hidden(covered || !whole);
                    if !covered && whole {
                        window.add_tooltip_exclusion(bounds);
                    }
                    if covered || !whole {
                        crate::web_panels::keyboard_to_app(window);
                    }
                    if live && !whole {
                        let page = Rc::downgrade(&page);
                        cx.defer(move |cx| {
                            owner
                                .update(cx, |this, cx| {
                                    if this.stage.page.as_ref().is_some_and(|(_, p)| {
                                        std::rc::Weak::ptr_eq(&Rc::downgrade(p), &page)
                                    }) {
                                        this.canvas_stop_playing(cx);
                                    }
                                })
                                .ok();
                        });
                    }
                },
                |_, _, _, _| {},
            )
            .size_full()
            .into_any_element(),
        )
    }

    /// The whole image small, top right, with a box for the part on show, while
    /// some of it is off the stage; drag or click it to go there.
    fn render_minimap(
        &mut self,
        path: &str,
        map: rules::Minimap,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let f = map.frame;
        let s = map.shown;
        crate::highlights::tipped(
            div()
                .id("review-minimap")
                .absolute()
                .left(pt(f.x))
                .top(pt(f.y))
                .w(pt(f.width))
                .h(pt(f.height))
                .rounded(gpui_kit::px(4.))
                .overflow_hidden()
                .bg(hsla(0., 0., 0., 0.55))
                .border_1()
                .border_color(hsla(0., 0., 1., 0.25))
                .cursor(CursorStyle::Arrow)
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                        cx.stop_propagation();
                        this.stage.minimap_drag = true;
                        this.minimap_moved(ev.position, cx);
                    }),
                )
                .child(
                    img(crate::rows::markdown::file_picture(path))
                        .absolute()
                        .size_full()
                        .object_fit(ObjectFit::Fill)
                        .opacity(0.8),
                )
                .child(
                    div()
                        .absolute()
                        .left(pt(s.x))
                        .top(pt(s.y))
                        .w(pt(s.width))
                        .h(pt(s.height))
                        .border(gpui_kit::px(1.5))
                        .border_color(gpui_kit::white())
                        .bg(hsla(0., 0., 1., 0.2)),
                ),
            "Drag to move around the image",
        )
        .into_any_element()
    }

    /// All of them side by side, each its first shot, as many columns as make
    /// them biggest (`ReviewGalleryLayout`).
    fn render_gallery(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(room) = self.stage.room() else {
            return div().into_any_element();
        };
        let options = self.session.review().options.clone();
        let (w, h) = (
            (f64::from(room.size.width) - f64::from(STAGE_INSET) * 2.).max(0.),
            (f64::from(room.size.height) - f64::from(STAGE_INSET) * 2.).max(0.),
        );
        let aspects: Vec<f64> = options.iter().map(|o| rules::aspect(&o.image)).collect();
        let chrome_h = f64::from(CELL_PADDING) * 2. + f64::from(CAPTION_HEIGHT);
        let layout = GalleryLayout::best(
            &aspects,
            w,
            h,
            f64::from(CELL_SPACING),
            f64::from(CELL_PADDING) * 2.,
            chrome_h,
        );
        let mut rows = v_flex().gap(gpui_kit::px(CELL_SPACING)).items_center();
        for first in (0..options.len()).step_by(layout.columns.max(1)) {
            let mut row = h_flex().gap(gpui_kit::px(CELL_SPACING));
            let end = (first + layout.columns).min(options.len());
            for (index, option) in options.iter().enumerate().take(end).skip(first) {
                row = row.child(self.render_cell(
                    index,
                    option,
                    layout.cell_width,
                    layout.cell_height,
                    window,
                    cx,
                ));
            }
            rows = rows.child(row);
        }
        div()
            .absolute()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(rows)
            .into_any_element()
    }

    /// An option among them all: its first shot, how many it has, and the
    /// agent's pick marked; a tick's outline round it once it's picked.
    fn render_cell(
        &mut self,
        index: usize,
        option: &ReviewOption,
        width: f64,
        height: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let picked = self.session.draft().picked_ids.contains(&option.id);
        let count = option.shot_count();
        let recommended = self.session.review().recommended.as_deref() == Some(option.id.as_str());
        let room = (
            (width - f64::from(CELL_PADDING) * 2.).max(0.),
            (height - f64::from(CELL_PADDING) * 2. - f64::from(CAPTION_HEIGHT)).max(0.),
        );
        let fit = GalleryLayout::fit(rules::aspect(&option.image), room.0, room.1);
        let accent = style::control_accent(cx);
        let id_color = if picked {
            accent
        } else {
            style::secondary_text(cx)
        };
        let path = option.image.path.clone();
        let unavailable = style::secondary_text(cx);
        let caption = h_flex()
            .flex_none()
            .h(gpui_kit::px(CAPTION_HEIGHT))
            .gap(px(6.))
            .items_start()
            .child(
                div()
                    .text_size(px(style::size::DETAIL))
                    .line_height(px(style::natural_line(style::size::DETAIL)))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(id_color)
                    .min_w_0()
                    .truncate()
                    .child(option.label()),
            )
            .when(count > 1, |s| {
                s.child(
                    div()
                        .text_size(px(style::size::DETAIL))
                        .line_height(px(style::natural_line(style::size::DETAIL)))
                        .text_color(style::tertiary_label(cx))
                        .child(format!("{count} shots")),
                )
            })
            .when(recommended, |s| s.child(super::parts::recommended_mark(cx)));
        let picture = crate::highlights::tipped(
            div()
                .id(("review-cell", index))
                .relative()
                .flex_none()
                .w(pt(fit.0))
                .h(pt(fit.1))
                .cursor_pointer(),
            format!("{}: click to enlarge", option.id),
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
            this.take_keys(window, cx);
            this.enlarge(index, 0, cx);
        }))
        .child(
            // With an id, so a GIF option plays here too, as it does
            // enlarged (render_stage's picture).
            img(crate::rows::markdown::file_picture(&path))
                .id(SharedString::from(format!(
                    "review-cell-picture-{index}-{path}"
                )))
                .size_full()
                .object_fit(ObjectFit::Fill)
                .with_fallback(move || {
                    div()
                        .size_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            Icon::new(IconName::ImageOff)
                                .with_size(gpui_kit::px(28.))
                                .text_color(unavailable),
                        )
                        .into_any_element()
                }),
        )
        // Its first shot a clip or a page: a still, marked as one, and on
        // a Mac a clip plays over it, muted and with no controls, as they
        // all play at once to be compared moving. A click on it goes
        // through the player to this cell, which enlarges it.
        .children(media_badge(&option.shot(0)))
        .children(self.cell_clip(index, &option.shot(0), window));
        v_flex()
            .relative()
            .flex_none()
            .w(pt(width))
            .h(pt(height))
            .p(gpui_kit::px(CELL_PADDING))
            .child(caption)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(picture),
            )
            .when(picked, |s| {
                s.child(
                    div()
                        .absolute()
                        .inset_0()
                        .rounded(gpui_kit::px(10.))
                        .border_2()
                        .border_color(accent),
                )
            })
            .into_any_element()
    }

    /// Back and next, each in a column of its own beside the picture, so
    /// neither is ever over it (a clip or a page there is a view of its own
    /// over the window).
    fn render_steps(&mut self, cx: &mut Context<Self>) -> (AnyElement, AnyElement) {
        let single = self.session.mode == ReviewMode::Single;
        let back_tip = if single {
            "Previous (\u{2190})"
        } else {
            "Back to the last one (\u{2190})"
        };
        let next_tip = if self.session.next_is_all() {
            "See them all and choose (\u{2192})"
        } else {
            "Next (\u{2192})"
        };
        let back = step_button(
            "review-previous",
            IconName::ChevronLeft,
            back_tip,
            self.session.can_step_back(),
            false,
            cx,
        )
        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.browse(-1, cx)));
        let next = step_button(
            "review-next",
            IconName::ChevronRight,
            next_tip,
            self.session.can_step_forward(),
            true,
            cx,
        )
        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.browse(1, cx)));
        let column = || {
            div()
                .flex_none()
                .w(px(STEP_COLUMN))
                .h_full()
                .flex()
                .items_center()
                .justify_center()
        };
        (
            column().child(back).into_any_element(),
            column().child(next).into_any_element(),
        )
    }

    /// The row under the picture for the shots of the option on show: as
    /// tall with one shot as with several.
    fn render_strip_row(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let option = self
            .session
            .focused_option()
            .filter(|o| self.session.mode == ReviewMode::Single && o.shot_count() > 1)
            .cloned();
        let here = (self.session.focused(), self.session.shot());
        if option.is_some() && self.stage.followed != Some(here) {
            self.stage.followed = Some(here);
            self.stage.strip_scroll.scroll_to_item(here.1);
        }
        h_flex()
            .flex_none()
            .w_full()
            .h(px(STRIP_ROW))
            .px(px(22.))
            .justify_center()
            .children(option.map(|o| self.render_filmstrip(&o, cx)))
            .into_any_element()
    }

    /// The option's shots, scrolling sideways once there are more than the
    /// row has room for; the one on show outlined.
    fn render_filmstrip(&mut self, option: &ReviewOption, cx: &mut Context<Self>) -> AnyElement {
        let (primary, secondary) = (style::label_text(cx), style::secondary_text(cx));
        let focused = self.session.focused();
        let mut strip = h_flex()
            .id("review-filmstrip")
            .p(px(3.))
            .gap(px(8.))
            .overflow_x_scroll()
            .track_scroll(&self.stage.strip_scroll);
        for (index, shot) in option.all_shots().iter().enumerate() {
            let current = index == self.session.shot();
            let title = shot
                .title
                .clone()
                .unwrap_or_else(|| format!("{}", index + 1));
            strip = strip.child(
                crate::highlights::tipped(
                    v_flex()
                        .id(("review-strip", index))
                        .flex_none()
                        .gap(px(4.))
                        .cursor_pointer(),
                    rules::shot_tip(option, index),
                )
                .on_click(
                    cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.enlarge(focused, index, cx)
                    }),
                )
                .child(
                    div()
                        .relative()
                        .child(
                            super::parts::thumb(&shot.image, STRIP_THUMB.0, STRIP_THUMB.1, 4., cx)
                                .opacity(if current { 1. } else { 0.55 }),
                        )
                        .when(current, |s| {
                            s.child(
                                div()
                                    .absolute()
                                    .top(px(-3.))
                                    .left(px(-3.))
                                    .w(px(STRIP_THUMB.0 + 6.))
                                    .h(px(STRIP_THUMB.1 + 6.))
                                    .rounded(px(5.))
                                    .border_2()
                                    .border_color(primary),
                            )
                        }),
                )
                .child(
                    div()
                        .w(px(STRIP_THUMB.0))
                        .truncate()
                        .text_size(px(style::size::DETAIL - 1.))
                        .line_height(px(style::natural_line(style::size::DETAIL - 1.)))
                        .text_color(if current { primary } else { secondary })
                        .child(title),
                ),
            );
        }
        div()
            .min_w_0()
            .max_w_full()
            .overflow_hidden()
            .child(strip)
            .into_any_element()
    }

    // The pointer on the stage.

    fn stage_point(&self, at: Point<Pixels>) -> Option<StagePoint> {
        let room = self.stage.room()?;
        Some(StagePoint {
            x: f64::from(at.x - room.origin.x),
            y: f64::from(at.y - room.origin.y),
        })
    }

    fn stage_pressed(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.take_keys(window, cx);
        let Some(at) = self.stage_point(ev.position) else {
            return;
        };
        let Some(z) = self.stage.zoom.as_mut() else {
            return;
        };
        // Fitted, a press is a click: back to all of them.
        if z.zoom.press(at, ev.click_count) {
            self.show_all(cx);
            return;
        }
        self.after_zoom();
        cx.notify();
    }

    /// A drag from the stage or the minimap, wherever the pointer's gone in
    /// the window.
    pub(super) fn stage_dragged(
        &mut self,
        ev: &MouseMoveEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if ev.pressed_button != Some(MouseButton::Left) {
            if self.stage.minimap_drag
                || self.stage.zoom.as_ref().is_some_and(|z| z.zoom.dragging())
            {
                self.stage_released(cx);
            }
            return;
        }
        if self.stage.minimap_drag {
            self.minimap_moved(ev.position, cx);
            return;
        }
        let Some(at) = self.stage_point(ev.position) else {
            return;
        };
        if let Some(z) = self.stage.zoom.as_mut().filter(|z| z.zoom.dragging()) {
            z.zoom.drag_to(at);
            cx.notify();
        }
    }

    pub(super) fn stage_released(&mut self, cx: &mut Context<Self>) {
        self.stage.minimap_drag = false;
        if let Some(z) = self.stage.zoom.as_mut().filter(|z| z.zoom.dragging()) {
            z.zoom.release();
            cx.notify();
        }
    }

    fn minimap_moved(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(at) = self.stage_point(at) else {
            return;
        };
        if let Some(z) = self.stage.zoom.as_mut() {
            if let Some(map) = z.zoom.minimap() {
                z.zoom.minimap_to(StagePoint {
                    x: at.x - map.frame.x,
                    y: at.y - map.frame.y,
                });
                cx.notify();
            }
        }
    }

    /// A wheel zooms (Shift turns it sideways); a trackpad swipe zooms from
    /// fit and moves round once zoomed in, decided as it starts.
    fn stage_scrolled(&mut self, ev: &ScrollEvent, cx: &mut Context<Self>) {
        let at = self.stage_point(ev.position);
        let Some(z) = self.stage.zoom.as_mut() else {
            return;
        };
        let held = ev.modifiers.platform || ev.modifiers.control || ev.modifiers.alt;
        match ev.delta {
            ScrollDelta::Lines(lines) => {
                if !z.zoom.wheel(f64::from(lines.y), ev.modifiers.shift, at) {
                    z.zoom.scroll_by(
                        f64::from(lines.x * WHEEL_LINE),
                        f64::from(lines.y * WHEEL_LINE),
                    );
                }
            }
            ScrollDelta::Pixels(delta) => {
                let phase = match ev.touch_phase {
                    TouchPhase::Started => ScrollPhase::Started,
                    TouchPhase::Ended | TouchPhase::Cancelled => ScrollPhase::Ended,
                    TouchPhase::Moved => ScrollPhase::Moved,
                };
                z.zoom
                    .swipe(f64::from(delta.x), f64::from(delta.y), phase, held, at);
            }
        }
        self.after_zoom();
        cx.stop_propagation();
        cx.notify();
    }

    fn stage_pinched(&mut self, ev: &PinchEvent, cx: &mut Context<Self>) {
        let at = self.stage_point(ev.position);
        if let Some(z) = self.stage.zoom.as_mut() {
            z.zoom.pinch(f64::from(ev.delta), at);
            self.after_zoom();
            cx.notify();
        }
    }
}

/// The stage's player for a clip (media_view.rs), one per window.
pub(super) fn stage_key(path: &str) -> String {
    format!("review stage {path}")
}

impl ReviewWindow {
    /// A cell's clip playing over its still, on a Mac: muted, looping, no
    /// controls. One the gate won't play leaves the still.
    fn cell_clip(
        &mut self,
        index: usize,
        shot: &ReviewShot,
        window: &mut Window,
    ) -> Option<AnyElement> {
        let video = shot
            .video()
            .filter(|_| crate::media_view::SHOWN_HERE)?
            .to_owned();
        let key = format!("review cell {index} {video}");
        let view = crate::media_view::slot(&key, window, |opening| {
            crate::open_gate::show_media(
                &video,
                Origin::ThisMac,
                crate::media_view::Kind::CellVideo,
                opening,
            )
        })
        .ok()?;
        Some(div().absolute().inset_0().child(view).into_any_element())
    }
}

/// A clip's, a sound's or a page's mark on its still in the grid. A sound
/// stays its waveform there: muted, as cells' clips are, it would say nothing.
fn media_badge(shot: &ReviewShot) -> Option<AnyElement> {
    let icon = if shot.video().is_some() {
        IconName::Play
    } else if shot.audio().is_some() {
        IconName::Music
    } else if shot.page().is_some() {
        IconName::Globe
    } else {
        return None;
    };
    Some(
        div()
            .absolute()
            .left(px(8.))
            .bottom(px(8.))
            .size(px(26.))
            .rounded_full()
            .bg(hsla(0., 0., 0., 0.62))
            .flex()
            .items_center()
            .justify_center()
            .child(
                Icon::new(icon)
                    .with_size(px(13.))
                    .text_color(gpui_kit::white()),
            )
            .into_any_element(),
    )
}

/// The back and next buttons: a chevron in a circle, next a shade stronger,
/// as it's the way on.
fn step_button(
    id: &'static str,
    icon: IconName,
    tip: &'static str,
    enabled: bool,
    prominent: bool,
    cx: &App,
) -> gpui_kit::base::ObservedElement<Stateful<Div>> {
    let fill = style::primary_opacity(cx, if prominent && enabled { 0.1 } else { 0.05 });
    let fg = if enabled {
        style::label_text(cx)
    } else {
        style::secondary_text(cx).opacity(0.4)
    };
    crate::highlights::tipped(
        div()
            .id(id)
            .flex_none()
            .size(px(36.))
            .rounded_full()
            .bg(fill)
            .flex()
            .items_center()
            .justify_center()
            .when(enabled, |s| s.cursor_pointer()),
        tip,
    )
    .child(Icon::new(icon).with_size(px(15.)).text_color(fg))
}

/// A capsule with a symbol and a few words over the stage (the caption's
/// buttons). The symbol's size and gap are each Swift button's own: its
/// swap symbol is wider than its arrow.
fn capsule_button(
    id: &'static str,
    icon: Icon,
    icon_size: f32,
    gap: f32,
    title: &str,
    fg: Hsla,
    bg: Hsla,
) -> Stateful<Div> {
    h_flex()
        .id(id)
        .flex_none()
        .h(px(26.))
        .px(px(11.))
        .gap(px(gap))
        .items_center()
        .rounded_full()
        .bg(bg)
        .cursor_pointer()
        .text_color(fg)
        .child(icon.with_size(px(icon_size)).text_color(fg))
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_size(px(style::size::DETAIL))
                .font_weight(FontWeight::MEDIUM)
                .child(title.to_owned()),
        )
}
