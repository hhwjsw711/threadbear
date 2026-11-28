// The review as a canvas: a board of the
// options you drag and zoom round, the agent's handwritten notes and arrows
// on the pictures, a tour that flies from picture to picture in the agent's
// order, and tools to circle, highlight or pin a part, each a numbered chip
// in the reply. Where everything sits and how the camera moves is
// threadbear_core::review_canvas; this draws it and takes the mouse.
//
// Mike, 22 Nov 2026, picked the board with the agent's tour from three
// mockups, asked for the notes "a little more playful" after Convex
// Explained's doodle kit, a switch at the top to hide them, and his own marks
// as chips "so we can kind of annotate and speak to give feedback".
use super::ReviewWindow;
use crate::style::{self, px};
use gpui_kit::component::{h_flex, ActiveTheme as _, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use std::cell::Cell;
use std::rc::Rc;
use std::time::Instant;
use threadbear_core::reducer::{DesignReview, MarkInk, MarkKind, UserMarkKind};
use threadbear_core::review_canvas::{
    self as board, Board, Camera, Drawing, Lit, Measure, Rect, Stop, Stroke,
};

#[derive(Debug, PartialEq, Eq)]
enum PageWaiting {
    Prompt,
    Opening,
    Stopped,
}

fn page_waiting(state: &threadbear_core::web_runtime::State, not_now: bool) -> PageWaiting {
    use threadbear_core::web_runtime::State;
    if matches!(state, State::Unavailable) || (not_now && !state.busy()) {
        PageWaiting::Stopped
    } else if matches!(state, State::Ready) {
        PageWaiting::Opening
    } else {
        PageWaiting::Prompt
    }
}

/// How long a flight between stops takes.
const FLIGHT_MS: f32 = 650.;
/// How long a stop's notes take to scribble themselves in.
const SCRIBBLE_MS: f32 = 700.;
/// What isn't on the tour's stop, faded back.
const DIMMED: f32 = 0.2;
/// Text smaller than this on screen isn't drawn: it can't be read, and at
/// "see everything" there's a lot of it.
const SMALLEST_TEXT: f32 = 3.5;
/// Mike's own marks, blue, so they never mix with the agent's inks.
const MINE: u32 = 0x6CB8FF;
/// The pen on screen, for Mike's circles; a highlight is wider.
const PEN: f32 = 3.;
const MARKER: f32 = 22.;
/// An option's name in its box's top row, on the board.
const TITLE_SIZE: f32 = 26.;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(crate) enum Tool {
    #[default]
    Move,
    Circle,
    Highlight,
    Pin,
}

impl Tool {
    fn kind(self) -> Option<UserMarkKind> {
        match self {
            Tool::Move => None,
            Tool::Circle => Some(UserMarkKind::Circle),
            Tool::Highlight => Some(UserMarkKind::Highlight),
            Tool::Pin => Some(UserMarkKind::Pin),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Tool::Move => "move",
            Tool::Circle => "circle",
            Tool::Highlight => "highlight",
            Tool::Pin => "pin",
        }
    }
}

struct Flight {
    from: Camera,
    to: Camera,
    start: Instant,
}

struct Drag {
    from: (f32, f32),
    camera: Camera,
}

/// What the canvas holds between frames.
pub(crate) struct CanvasState {
    board: Option<Board>,
    stops: Vec<Stop>,
    pub(crate) stop: usize,
    camera: Camera,
    flight: Option<Flight>,
    /// Mike moved the camera himself: nothing's faded until the tour moves on.
    roaming: bool,
    pub(crate) notes_on: bool,
    pub(crate) tool: Tool,
    drawing: Option<Drawing>,
    drag: Option<Drag>,
    /// When the stop's notes started drawing themselves in.
    scribble: Option<Instant>,
    /// The canvas's place in the window, from its last paint.
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The canvas size the camera was last fitted to, at the stop on show.
    placed: Option<(f32, f32)>,
    /// Where to start when it was opened on an option's picture (a click on
    /// one on the thread's card), before the board was laid out.
    want: Option<(usize, usize)>,
    /// The clip or page playing where it sits on the board (option, shot):
    /// one at a time, with its sound and controls (Mike, 24 Nov 2026: a
    /// double-click took him off the board to hear a music bed).
    pub(crate) playing: board::Playback,
    /// A sound's bar starts paused (the pane's): set by Play, so the first
    /// frame with it up presses its play.
    start_sound: bool,
}

impl CanvasState {
    pub(crate) fn new() -> CanvasState {
        CanvasState {
            board: None,
            stops: Vec::new(),
            stop: 0,
            camera: Camera::default(),
            flight: None,
            roaming: false,
            notes_on: true,
            tool: Tool::Move,
            drawing: None,
            drag: None,
            scribble: None,
            bounds: Rc::new(Cell::new(None)),
            placed: None,
            want: None,
            playing: board::Playback::default(),
            start_sound: false,
        }
    }

    fn viewport(&self) -> Option<(f32, f32)> {
        self.bounds
            .get()
            .map(|b| (f32::from(b.size.width), f32::from(b.size.height)))
    }

    /// The camera now, partway through a flight or not.
    fn camera_now(&mut self) -> Camera {
        let Some(f) = &self.flight else {
            return self.camera;
        };
        let k = f.start.elapsed().as_secs_f32() * 1000. / FLIGHT_MS;
        if k >= 1. {
            self.camera = f.to;
            self.flight = None;
            return self.camera;
        }
        let (vw, vh) = self.viewport().unwrap_or((1000., 700.));
        f.from.toward(&f.to, board::ease(k), vw, vh)
    }

    fn fly_to(&mut self, rect: Rect, max: f32) {
        let Some((vw, vh)) = self.viewport() else {
            return;
        };
        let to = Camera::fit(rect, vw, vh, board::STOP_PAD, max);
        self.fly_camera(to);
    }

    fn fly_camera(&mut self, to: Camera) {
        let from = self.camera_now();
        self.camera = to;
        self.flight = Some(Flight {
            from,
            to,
            start: Instant::now(),
        });
    }

    fn go(&mut self, stop: usize) {
        let Some(s) = self.stops.get(stop.min(self.stops.len().saturating_sub(1))) else {
            return;
        };
        let s = s.clone();
        self.stop = stop.min(self.stops.len() - 1);
        self.roaming = false;
        self.scribble = Some(Instant::now());
        let Some((vw, vh)) = self.viewport() else {
            return;
        };
        let max = if s.lit == Lit::All {
            board::MAX_ZOOM
        } else {
            board::STOP_ZOOM
        };
        self.fly_camera(Camera::for_stop(&s, vw, vh, board::STOP_PAD, max));
    }

    fn lit(&self) -> Option<Lit> {
        if self.roaming {
            return None;
        }
        self.stops
            .get(self.stop)
            .map(|s| s.lit)
            .filter(|l| !matches!(l, Lit::All | Lit::Start))
    }

    /// How far the stop's notes have drawn in, 0 to 1.
    fn scribbled(&self) -> f32 {
        self.scribble.map_or(1., |t| {
            (t.elapsed().as_secs_f32() * 1000. / SCRIBBLE_MS).min(1.)
        })
    }

    fn moving(&self) -> bool {
        self.flight.is_some() || self.scribbled() < 1.
    }
}

/// Text sizes as the window's fonts set them.
struct Measured<'a> {
    window: &'a Window,
    words: Font,
    notes: Font,
}

impl Measure for Measured<'_> {
    fn words(&self, text: &str, width: f32) -> f32 {
        let size = board::WORDS_SIZE;
        let lines = shaped_lines(self.window, text, &self.words, size, Some(width));
        lines.max(1) as f32 * size * 1.5
    }

    fn note(&self, text: &str) -> (f32, f32) {
        let size = board::NOTE_SIZE;
        let run = TextRun {
            len: text.len(),
            font: self.notes.clone(),
            color: Hsla::default(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let shaped = self.window.text_system().shape_text(
            text.to_owned().into(),
            gpui_kit::px(size),
            &[run],
            Some(gpui_kit::px(board::NOTE_WIDTH)),
            None,
        );
        let Ok(lines) = shaped else {
            return board::Guess.note(text);
        };
        let rows: usize = lines.iter().map(|l| l.wrap_boundaries().len() + 1).sum();
        let width = lines
            .iter()
            .map(|l| f32::from(l.width()))
            .fold(0., f32::max)
            .min(board::NOTE_WIDTH);
        (width.max(20.), rows.max(1) as f32 * size * 1.1)
    }
}

fn shaped_lines(window: &Window, text: &str, font: &Font, size: f32, width: Option<f32>) -> usize {
    let run = TextRun {
        len: text.len(),
        font: font.clone(),
        color: Hsla::default(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    window
        .text_system()
        .shape_text(
            text.to_owned().into(),
            gpui_kit::px(size),
            &[run],
            width.map(gpui_kit::px),
            None,
        )
        .map(|lines| lines.iter().map(|l| l.wrap_boundaries().len() + 1).sum())
        .unwrap_or(1)
}

fn ink(ink: MarkInk) -> Hsla {
    rgb(match ink {
        MarkInk::Yellow => 0xF3B01C,
        MarkInk::Green => 0x6FD08C,
        MarkInk::Rose => 0xF07A9A,
    })
    .into()
}

/// A stroke for the painter: its shape in screen points, its width and colour.
struct Pen {
    stroke: Stroke,
    width: f32,
    color: Hsla,
    /// How much of it is drawn, 0 to 1, by whole segments.
    drawn: f32,
}

fn to_screen(camera: &Camera, s: &Stroke) -> Stroke {
    Stroke {
        start: camera.to_screen(s.start),
        curves: s
            .curves
            .iter()
            .map(|c| {
                [
                    camera.to_screen(c[0]),
                    camera.to_screen(c[1]),
                    camera.to_screen(c[2]),
                ]
            })
            .collect(),
    }
}

/// The board's own grey, a touch apart from the window's.
const CANVAS_DARK: u32 = 0x111114;
const CANVAS_LIGHT: u32 = 0xEDEDF1;
/// An option's halo, only just lighter than the board (Mike, 23 Nov: "a lot
/// more subtle"), and a touch green once it's ticked.
const HALO_DARK: u32 = 0x16161B;
const HALO_LIGHT: u32 = 0xF7F7FA;
const HALO_PICKED_DARK: u32 = 0x131A16;
const HALO_PICKED_LIGHT: u32 = 0xE4F2EA;
/// Picked: a ring round each of the option's pictures, as Mike asked
/// (22 Nov), green.
const PICKED: u32 = 0x4CC38A;
/// The dot grid's spacing on the board, doubled or halved as the camera
/// zooms so it stays between these on screen.
const DOTS: f32 = 48.;
const DOTS_ON_SCREEN: (f32, f32) = (18., 36.);

/// A grid of dots behind the board that moves and zooms with it, so the
/// canvas reads as a surface to drag round.
fn paint_dots(cam: &Camera, colour: Hsla, bounds: Bounds<Pixels>, window: &mut Window) {
    let mut step = DOTS;
    while step * cam.s < DOTS_ON_SCREEN.0 {
        step *= 2.;
    }
    while step * cam.s > DOTS_ON_SCREEN.1 {
        step /= 2.;
    }
    let gap = step * cam.s;
    let (w, h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
    let x0 = cam.tx.rem_euclid(gap);
    let y0 = cam.ty.rem_euclid(gap);
    let size = 2.;
    let mut y = y0;
    while y < h {
        let mut x = x0;
        while x < w {
            window.paint_quad(fill(
                Bounds {
                    origin: point(
                        bounds.origin.x + gpui_kit::px(x - size / 2.),
                        bounds.origin.y + gpui_kit::px(y - size / 2.),
                    ),
                    size: size_of(size),
                },
                colour,
            ));
            x += gap;
        }
        y += gap;
    }
}

fn size_of(n: f32) -> Size<Pixels> {
    Size {
        width: gpui_kit::px(n),
        height: gpui_kit::px(n),
    }
}

fn paint_pens(pens: &[Pen], origin: Point<Pixels>, window: &mut Window) {
    let at = |p: (f32, f32)| point(origin.x + gpui_kit::px(p.0), origin.y + gpui_kit::px(p.1));
    for pen in pens {
        if pen.stroke.curves.is_empty() || pen.drawn <= 0. {
            continue;
        }
        let shown = ((pen.stroke.curves.len() as f32 * pen.drawn).ceil() as usize)
            .clamp(1, pen.stroke.curves.len());
        let mut path = PathBuilder::stroke(gpui_kit::px(pen.width.max(0.5)));
        path.move_to(at(pen.stroke.start));
        for c in &pen.stroke.curves[..shown] {
            path.cubic_bezier_to(at(c[2]), at(c[0]), at(c[1]));
        }
        if let Ok(path) = path.build() {
            window.paint_path(path, pen.color);
        }
    }
}

/// One frame of the board: the camera, what the tour has lit, and colours.
struct Scene {
    cam: Camera,
    lit: Option<Lit>,
    notes_on: bool,
    scribbled: f32,
    view: (f32, f32),
    dark: bool,
    label: Hsla,
    secondary: Hsla,
    edge: Hsla,
}

impl Scene {
    fn visible(&self, r: &Rect) -> bool {
        let s = self.cam.rect(r);
        let (vw, vh) = self.view;
        s.right() > -40. && s.x < vw + 40. && s.bottom() > -40. && s.y < vh + 40.
    }

    fn alpha(&self, on: bool) -> f32 {
        if on {
            1.
        } else {
            DIMMED
        }
    }

    fn text_on(&self, size: f32) -> bool {
        size * self.cam.s >= SMALLEST_TEXT
    }

    /// A div where a rect of the board is on screen.
    fn placed(&self, r: &Rect) -> Div {
        let s = self.cam.rect(r);
        div()
            .absolute()
            .left(gpui_kit::px(s.x))
            .top(gpui_kit::px(s.y))
            .w(gpui_kit::px(s.w))
            .h(gpui_kit::px(s.h))
    }

    /// The same, as tall as its words need.
    fn placed_width(&self, r: &Rect) -> Div {
        let s = self.cam.rect(r);
        div()
            .absolute()
            .left(gpui_kit::px(s.x))
            .top(gpui_kit::px(s.y))
            .w(gpui_kit::px(s.w))
    }

    /// The agent's lead, a sticky note at the board's top left.
    fn lead(&self, laid: &Board, review: &DesignReview) -> Option<AnyElement> {
        let lead = laid.lead?;
        let note = review.note.as_deref()?;
        if !self.visible(&lead) {
            return None;
        }
        let cam = &self.cam;
        let dark = self.dark;
        let on = self.lit.is_none_or(|l| l == Lit::Start);
        Some(
            self.placed(&lead)
                .rounded(gpui_kit::px(12. * cam.s))
                .bg(rgb(if dark { 0x2A2620 } else { 0xFFF4D6 }))
                .border_1()
                .border_color(rgb(if dark { 0x4A4030 } else { 0xE8D49A }))
                .p(gpui_kit::px(24. * cam.s))
                .opacity(self.alpha(on))
                .when(self.text_on(board::WORDS_SIZE), |d| {
                    d.text_size(gpui_kit::px(board::WORDS_SIZE * cam.s))
                        .line_height(gpui_kit::px(board::WORDS_SIZE * 1.5 * cam.s))
                        .text_color(rgb(if dark { 0xEFE6D6 } else { 0x3A3020 }))
                        .child(plain(note))
                })
                .into_any_element(),
        )
    }

    /// A picture with its caption, and the agent's marks and notes on it,
    /// ringed green when its option is ticked.
    fn shot(
        &self,
        index: usize,
        shot_laid: &board::BoardShot,
        shot: &threadbear_core::reducer::ReviewShot,
        count: usize,
        picked: bool,
    ) -> (Vec<AnyElement>, Vec<Pen>) {
        let mut parts = Vec::new();
        let mut pens = Vec::new();
        let cam = &self.cam;
        let on = self.lit.is_none_or(|l| l.shows(index, shot_laid.shot));
        if self.visible(&shot_laid.extent()) {
            if picked {
                let ring = 6.;
                let p = &shot_laid.picture;
                parts.push(
                    self.placed(&Rect::new(
                        p.x - ring,
                        p.y - ring,
                        p.w + ring * 2.,
                        p.h + ring * 2.,
                    ))
                    .rounded(gpui_kit::px((8. + ring) * cam.s))
                    .border(gpui_kit::px(2.5))
                    .border_color(rgb(PICKED))
                    .opacity(self.alpha(on))
                    .into_any_element(),
                );
            }
            parts.push(
                self.placed(&shot_laid.picture)
                    .rounded(gpui_kit::px(8. * cam.s))
                    .overflow_hidden()
                    .bg(rgb(0x0D0D0F))
                    .border_1()
                    .border_color(self.edge)
                    .opacity(self.alpha(on))
                    .child(
                        img(crate::rows::markdown::file_picture(&shot.image.path))
                            .size_full()
                            .object_fit(ObjectFit::Fill),
                    )
                    .into_any_element(),
            );
            // Over the picture; laid out only for later pages and a first
            // one with its own name.
            let caption = shot.title.clone().unwrap_or_else(|| {
                if count > 1 {
                    format!("{} of {count}", shot_laid.shot + 1)
                } else {
                    String::new()
                }
            });
            if shot_laid.caption.h > 0. && !caption.is_empty() && self.text_on(17.) {
                let label = cam.rect(&shot_laid.caption);
                let width = if shot.page().is_some() {
                    board::html_label_width(label, cam.rect(&shot_laid.picture))
                } else {
                    label.w
                };
                parts.push(
                    self.placed_width(&shot_laid.caption)
                        .w(gpui_kit::px(width))
                        .text_ellipsis()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_size(gpui_kit::px(17. * cam.s))
                        .text_color(self.secondary)
                        .opacity(self.alpha(on))
                        .child(caption)
                        .into_any_element(),
                );
            }
        }
        if !self.notes_on {
            return (parts, pens);
        }
        let drawn = if on && self.lit.is_some() {
            self.scribbled
        } else {
            1.
        };
        let line = 3.2 * cam.s.max(0.5);
        for (m, mark) in shot.marks.iter().enumerate() {
            let colour = ink(mark.ink).opacity(self.alpha(on));
            let seed = (index * 97 + shot_laid.shot * 13 + m) as u32 + 7;
            let highlight = mark.kind == MarkKind::Highlight;
            for s in board::agent_strokes(&shot_laid.picture, mark, seed) {
                pens.push(Pen {
                    stroke: to_screen(cam, &s),
                    width: if highlight {
                        shot_laid.picture.part(&mark.bbox).h * 1.05 * cam.s
                    } else {
                        line
                    },
                    color: if highlight {
                        colour.opacity(0.3 * self.alpha(on))
                    } else {
                        colour
                    },
                    drawn,
                });
            }
        }
        for place in &shot_laid.notes {
            let Some(mark) = shot.marks.get(place.mark) else {
                continue;
            };
            let colour = ink(mark.ink).opacity(self.alpha(on));
            for s in board::pointer(place) {
                pens.push(Pen {
                    stroke: to_screen(cam, &s),
                    width: line,
                    color: colour,
                    drawn,
                });
            }
            if self.visible(&place.rect) && self.text_on(board::NOTE_SIZE) {
                let r = cam.rect(&place.rect);
                parts.push(
                    div()
                        .absolute()
                        .left(gpui_kit::px(r.x))
                        .top(gpui_kit::px(r.y))
                        .w(gpui_kit::px(r.w + 4. * cam.s))
                        .text_size(gpui_kit::px(board::NOTE_SIZE * cam.s))
                        .line_height(gpui_kit::px(board::NOTE_SIZE * 1.1 * cam.s))
                        .font_family(crate::fonts::HANDWRITING)
                        .font_weight(FontWeight::BOLD)
                        .text_color(colour)
                        .opacity(drawn.min(1.))
                        .child(mark.note.clone().unwrap_or_default())
                        .into_any_element(),
                );
            }
        }
        (parts, pens)
    }

    /// Mike's own marks, numbered, and the one he's drawing.
    fn my_marks(
        &self,
        laid: &Board,
        review: &DesignReview,
        marks: &[threadbear_core::reducer::UserMark],
        drawing: Option<&Drawing>,
    ) -> (Vec<AnyElement>, Vec<Pen>) {
        let cam = &self.cam;
        let mine: Hsla = rgb(MINE).into();
        let mut badges = Vec::new();
        let mut pens = Vec::new();
        for mark in marks {
            let Some((part, points)) = board::mark_points(laid, review, mark) else {
                continue;
            };
            match mark.kind {
                UserMarkKind::Circle => pens.push(Pen {
                    stroke: to_screen(cam, &Stroke::through(&points)),
                    width: PEN,
                    color: mine,
                    drawn: 1.,
                }),
                UserMarkKind::Highlight => pens.push(Pen {
                    stroke: to_screen(cam, &Stroke::through(&points)),
                    width: (part.h * cam.s * 0.85).max(4.),
                    color: mine.opacity(0.38),
                    drawn: 1.,
                }),
                UserMarkKind::Pin => {}
            }
            let pin = mark.kind == UserMarkKind::Pin;
            let spot = if pin {
                points.first().copied().unwrap_or((part.x, part.y))
            } else {
                (part.x, part.y)
            };
            let (x, y) = cam.to_screen(spot);
            badges.push(
                div()
                    .absolute()
                    .left(gpui_kit::px(x - 13.))
                    .top(gpui_kit::px(if pin { y - 26. } else { y - 13. }))
                    .size(gpui_kit::px(26.))
                    .rounded(gpui_kit::px(13.))
                    .when(pin, |d| d.rounded_bl(gpui_kit::px(3.)))
                    .bg(mine)
                    .text_color(rgb(0x0B1A2A))
                    .text_size(gpui_kit::px(14.))
                    .font_weight(FontWeight::BOLD)
                    .flex()
                    .items_center()
                    .justify_center()
                    .shadow_sm()
                    .child(mark.n.to_string())
                    .into_any_element(),
            );
        }
        if let Some(d) = drawing.filter(|d| d.points.len() > 1) {
            let marker = d.kind == UserMarkKind::Highlight;
            pens.push(Pen {
                stroke: to_screen(cam, &Stroke::through(&d.points)),
                width: if marker { MARKER } else { PEN },
                color: if marker { mine.opacity(0.38) } else { mine },
                drawn: 1.,
            });
        }
        (badges, pens)
    }
}

impl ReviewWindow {
    /// Lays the board out once, with the window's fonts, and starts the tour.
    fn ensure_board(&mut self, window: &Window) {
        let Some(canvas) = self.canvas.as_mut() else {
            return;
        };
        if canvas.board.is_some() {
            return;
        }
        let words = window.text_style().font();
        let mut notes = font(crate::fonts::HANDWRITING);
        notes.weight = FontWeight::BOLD;
        let measured = Measured {
            window,
            words,
            notes,
        };
        let laid = board::layout(self.session.review(), &measured);
        canvas.stops = board::stops(&laid);
        canvas.board = Some(laid);
        if let Some((option, shot)) = canvas.want.take() {
            canvas.stop = stop_of(&canvas.stops, option, shot).unwrap_or(0);
        }
    }

    pub(super) fn render_canvas(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.ensure_board(window);
        let review = self.session.review().clone();
        let draft_marks = self.session.draft().marks.clone();
        let Some(scene) = self.scene(window, cx) else {
            return div().into_any_element();
        };
        let Some(laid) = self.canvas.as_ref().and_then(|c| c.board.clone()) else {
            return div().into_any_element();
        };
        let player = self.canvas_player(&scene, &laid, window, cx);
        let mut layer = div().absolute().inset_0();
        let mut pens: Vec<Pen> = Vec::new();
        if let Some(lead) = scene.lead(&laid, &review) {
            layer = layer.child(lead);
        }
        for laid_option in &laid.options {
            let (parts, more) = self.draw_option(&scene, laid_option, &review, cx);
            layer = layer.children(parts);
            pens.extend(more);
        }
        let drawing = self.canvas.as_ref().and_then(|c| c.drawing.clone());
        let (badges, more) = scene.my_marks(&laid, &review, &draft_marks, drawing.as_ref());
        pens.extend(more);
        layer = layer.children(badges);
        layer = layer.children(player);
        let Some(cv) = self.canvas.as_ref() else {
            return div().into_any_element();
        };
        let bounds_cell = cv.bounds.clone();
        let dot_cam = scene.cam;
        let dot_colour: Hsla = rgb(if scene.dark { 0x2E2E36 } else { 0xC4C4CE }).into();
        let tool = cv.tool;
        // The dots are the board's background, under the boxes and pictures
        // (Mike, 23 Nov: they showed through a picture); the agent's notes
        // and your marks are drawn over everything.
        let dots = canvas(
            move |bounds, _, _| bounds_cell.set(Some(bounds)),
            move |bounds, _, window, _| paint_dots(&dot_cam, dot_colour, bounds, window),
        )
        .absolute()
        .inset_0();
        let painter = canvas(
            |_, _, _| {},
            move |bounds, _, window, _| paint_pens(&pens, bounds.origin, window),
        )
        .absolute()
        .inset_0();
        div()
            .id("review-canvas")
            .relative()
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_hidden()
            .bg(if scene.dark {
                rgb(CANVAS_DARK)
            } else {
                rgb(CANVAS_LIGHT)
            })
            .when(tool != Tool::Move, |d| d.cursor(CursorStyle::Crosshair))
            .when(tool == Tool::Move, |d| d.cursor(CursorStyle::OpenHand))
            .child(dots)
            .child(layer)
            .child(painter)
            .child(self.render_canvas_tools(cx))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                    this.canvas_pressed(ev, window, cx)
                }),
            )
            .on_mouse_move(
                cx.listener(|this, ev: &MouseMoveEvent, _, cx| this.canvas_moved(ev, cx)),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, ev: &MouseUpEvent, window, cx| {
                    this.canvas_released(ev, window, cx)
                }),
            )
            .on_scroll(cx.listener(|this, ev: &ScrollEvent, _, cx| this.canvas_scrolled(ev, cx)))
            .on_pinch(cx.listener(|this, ev: &PinchEvent, _, cx| this.canvas_pinched(ev, cx)))
            .into_any_element()
    }

    /// The frame's camera and what's lit, for this frame; places the first
    /// stop once the canvas knows its size.
    fn scene(&mut self, window: &mut Window, cx: &App) -> Option<Scene> {
        let dark = cx.theme().is_dark();
        let cv = self.canvas.as_mut()?;
        // The first stop once the canvas knows its size, and again when the
        // window changes size, unless the board's been moved by hand: a
        // camera fitted to the window's first, larger frame left the lead in
        // the middle and the first option cut off (23 Nov).
        match cv.viewport() {
            Some(size) if cv.placed != Some(size) => {
                let first = cv.placed.is_none();
                cv.placed = Some(size);
                if first || (!cv.roaming && cv.flight.is_none()) {
                    if let Some(stop) = cv.stops.get(cv.stop) {
                        cv.camera = Camera::for_stop(
                            stop,
                            size.0,
                            size.1,
                            board::STOP_PAD,
                            board::STOP_ZOOM,
                        );
                        if first {
                            cv.scribble = Some(Instant::now());
                        }
                    }
                }
                window.request_animation_frame();
            }
            Some(_) => {}
            None => window.request_animation_frame(),
        }
        let cam = cv.camera_now();
        if cv.moving() {
            window.request_animation_frame();
        }
        Some(Scene {
            cam,
            lit: cv.lit(),
            notes_on: cv.notes_on,
            scribbled: cv.scribbled(),
            view: cv.viewport().unwrap_or((2000., 1400.)),
            dark,
            label: style::label_text(cx),
            secondary: style::secondary_text(cx),
            edge: style::hairline(cx),
        })
    }

    /// An option's frame, its name and tick, its words and its pictures with
    /// the agent's notes on them.
    fn draw_option(
        &self,
        scene: &Scene,
        laid_option: &board::BoardOption,
        review: &DesignReview,
        cx: &mut Context<Self>,
    ) -> (Vec<AnyElement>, Vec<Pen>) {
        let mut parts = Vec::new();
        let mut pens = Vec::new();
        let Some(option) = review.options.get(laid_option.index) else {
            return (parts, pens);
        };
        let index = laid_option.index;
        let cam = &scene.cam;
        let picked = self.session.shown_draft().picked_ids.contains(&option.id);
        if scene.visible(&laid_option.extent()) {
            // No box (Mike, 23 Nov: the notes looked shut in): a soft glow
            // the shape of the column, faded out at every edge like a
            // shadow, a touch green once ticked; then its big letter, which
            // the first picture mostly hides.
            let mine = scene.lit.is_none_or(|l| l.option() == Some(index));
            let glow = match (scene.dark, picked) {
                (true, false) => HALO_DARK,
                (true, true) => HALO_PICKED_DARK,
                (false, false) => HALO_LIGHT,
                (false, true) => HALO_PICKED_LIGHT,
            };
            let soft = board::HALO_PAD * cam.s;
            parts.push(
                scene
                    .placed(&laid_option.halo)
                    .rounded(gpui_kit::px(soft))
                    .shadow(vec![BoxShadow {
                        color: rgb(glow).into(),
                        offset: point(px(0.), px(0.)),
                        blur_radius: gpui_kit::px(soft * 1.5),
                        spread_radius: gpui_kit::px(-soft * 0.25),
                        inset: false,
                    }])
                    .opacity(if mine { 1. } else { 0.55 })
                    .into_any_element(),
            );
            let letter_size = board::LETTER_SIZE * cam.s;
            if letter_size >= SMALLEST_TEXT {
                let r = cam.rect(&laid_option.letter);
                let ink = match (scene.dark, picked) {
                    (_, true) => Hsla::from(rgb(PICKED)).opacity(0.22),
                    (true, false) => hsla(0., 0., 1., 0.065),
                    (false, false) => hsla(0., 0., 0., 0.06),
                };
                parts.push(
                    div()
                        .absolute()
                        .left(gpui_kit::px(r.x))
                        .top(gpui_kit::px(r.y))
                        .text_size(gpui_kit::px(letter_size))
                        .line_height(gpui_kit::px(letter_size))
                        .font_weight(FontWeight::EXTRA_BOLD)
                        .text_color(ink)
                        .opacity(if mine { 1. } else { 0.55 })
                        .child(option.id.clone())
                        .into_any_element(),
                );
            }
            parts.push(self.frame_label(index, option, review, &laid_option.title, scene, cx));
        }
        if let (Some(words), Some(note)) = (laid_option.words, option.note.as_deref()) {
            if scene.visible(&words) && scene.text_on(board::WORDS_SIZE) {
                let on = scene.lit.is_none_or(|l| l.shows_words(index));
                parts.push(
                    scene
                        .placed_width(&words)
                        .text_size(gpui_kit::px(board::WORDS_SIZE * cam.s))
                        .line_height(gpui_kit::px(board::WORDS_SIZE * 1.5 * cam.s))
                        .text_color(scene.label)
                        .opacity(scene.alpha(on))
                        .child(plain(note))
                        .into_any_element(),
                );
            }
        }
        let shots = option.all_shots();
        for shot_laid in &laid_option.shots {
            if let Some(shot) = shots.get(shot_laid.shot) {
                let (more_parts, more_pens) =
                    scene.shot(index, shot_laid, shot, shots.len(), picked);
                parts.extend(more_parts);
                pens.extend(more_pens);
                if shot.media.is_some() && scene.visible(&shot_laid.picture) {
                    parts.push(self.play_button(scene, index, shot_laid, option, shot, cx));
                }
            }
        }
        (parts, pens)
    }

    /// The option's top row: its tick (while the review can still be answered)
    /// and the option's name, sized with the board but never too small to
    /// read; a click on the name flies to the option.
    fn frame_label(
        &self,
        index: usize,
        option: &threadbear_core::reducer::ReviewOption,
        review: &DesignReview,
        row: &Rect,
        scene: &Scene,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let r = scene.cam.rect(row);
        let size = (TITLE_SIZE * scene.cam.s).clamp(12., TITLE_SIZE);
        let label = scene.label;
        let editable = self.session.editable();
        let is_picked = self.session.shown_draft().picked_ids.contains(&option.id);
        let starred = review.recommended.as_deref() == Some(option.id.as_str());
        let id = option.id.clone();
        let pick_id = option.id.clone();
        let width = self
            .canvas
            .as_ref()
            .and_then(|c| c.board.as_ref())
            .and_then(|b| b.shot(index, 0))
            .filter(|_| option.shot(0).page().is_some())
            .map(|s| {
                board::html_label_width(
                    Rect {
                        h: r.h.max(size * 1.4),
                        ..r
                    },
                    scene.cam.rect(&s.picture),
                )
            })
            .unwrap_or(r.w);
        h_flex()
            .id(("canvas-frame-label", index))
            .role(Role::Button)
            .aria_label(SharedString::from(format!("Go to {}", option.label())))
            .absolute()
            .left(gpui_kit::px(r.x))
            .top(gpui_kit::px(r.y))
            .w(gpui_kit::px(width))
            .h(gpui_kit::px(r.h.max(size * 1.4)))
            .overflow_hidden()
            .gap(gpui_kit::px(size * 0.45))
            .items_center()
            .text_size(gpui_kit::px(size))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(label)
            .cursor_pointer()
            .when(!option.reference && editable, |d| {
                d.child(
                    div()
                        .id(("canvas-pick", index))
                        .role(Role::CheckBox)
                        .aria_label(SharedString::from(format!("Pick {}", option.label())))
                        .aria_toggled(if is_picked {
                            Toggled::True
                        } else {
                            Toggled::False
                        })
                        .child(super::parts::checkbox(is_picked, style::accent(cx), cx))
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            if this.session.pick(&pick_id) {
                                this.edited(cx);
                            }
                            cx.stop_propagation();
                            cx.notify();
                        })),
                )
            })
            .child(
                div()
                    .flex_initial()
                    .min_w_0()
                    .text_ellipsis()
                    .child(option.label()),
            )
            .when(starred && width >= 190., |d| {
                d.child(super::parts::recommended_mark(cx))
            })
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                if let Some(i) = this
                    .session
                    .review()
                    .options
                    .iter()
                    .position(|o| o.id == id)
                {
                    this.canvas_go_option(i, cx);
                }
            }))
            .into_any_element()
    }

    /// The tools at the top of the canvas: move, circle, highlight, pin, then
    /// the switch for the agent's notes and Fit everything.
    fn render_canvas_tools(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let Some(canvas) = self.canvas.as_ref() else {
            return div().into_any_element();
        };
        let (tool, notes_on) = (canvas.tool, canvas.notes_on);
        let accent: Hsla = rgb(MINE).into();
        let label = style::label_text(cx);
        let tool_button =
            |t: Tool, icon: &'static str, tip: &'static str, cx: &mut Context<Self>| {
                let on = tool == t;
                crate::highlights::tipped(
                    div()
                        .id(SharedString::from(format!("canvas-tool-{}", t.name())))
                        .w(px(36.))
                        .h(px(32.))
                        .rounded(px(8.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .text_size(px(16.))
                        .text_color(if on { accent } else { label })
                        .when(on, |d| d.bg(accent.opacity(0.15)))
                        .hover(|d| d.bg(style::hover_fill(cx)))
                        .child(icon),
                    tip,
                )
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.set_tool(t, cx)))
            };
        h_flex()
            .id("canvas-tools")
            .absolute()
            .top(px(12.))
            .left_0()
            .right_0()
            .justify_center()
            .child(
                h_flex()
                    .gap(px(2.))
                    .p(px(4.))
                    .rounded(px(11.))
                    .bg(cx.theme().background.opacity(0.94))
                    .border_1()
                    .border_color(style::hairline(cx))
                    .shadow_md()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(tool_button(Tool::Move, "\u{270B}", "Move and zoom (V)", cx))
                    .child(tool_button(
                        Tool::Circle,
                        "\u{25EF}",
                        "Circle a part (O)",
                        cx,
                    ))
                    .child(tool_button(
                        Tool::Highlight,
                        "\u{1F58D}",
                        "Highlight a part (H)",
                        cx,
                    ))
                    .child(tool_button(Tool::Pin, "\u{1F4CD}", "Drop a pin (P)", cx))
                    .child(
                        div()
                            .w(px(1.))
                            .h(px(20.))
                            .mx(px(4.))
                            .bg(style::hairline(cx)),
                    )
                    .child(
                        crate::highlights::tipped(
                            h_flex()
                                .id("canvas-notes")
                                .h(px(32.))
                                .px(px(8.))
                                .gap(px(7.))
                                .items_center()
                                .rounded(px(8.))
                                .cursor_pointer()
                                .text_size(px(13.))
                                .text_color(label)
                                .hover(|d| d.bg(style::hover_fill(cx)))
                                .child(
                                    div()
                                        .w(px(28.))
                                        .h(px(16.))
                                        .rounded(px(8.))
                                        .bg(if notes_on {
                                            rgb(0xF3B01C).into()
                                        } else {
                                            style::primary_opacity(cx, 0.2)
                                        })
                                        .child(
                                            div()
                                                .mt(px(2.))
                                                .ml(px(if notes_on { 14. } else { 2. }))
                                                .size(px(12.))
                                                .rounded(px(6.))
                                                .bg(white()),
                                        ),
                                )
                                .child("Notes"),
                            if notes_on {
                                "Hide the agent's notes (N)"
                            } else {
                                "Show the agent's notes (N)"
                            },
                        )
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_notes(cx))),
                    )
                    .child(
                        crate::highlights::tipped(
                            div()
                                .id("canvas-fit")
                                .h(px(32.))
                                .px(px(10.))
                                .rounded(px(8.))
                                .flex()
                                .items_center()
                                .cursor_pointer()
                                .text_size(px(13.))
                                .text_color(label)
                                .hover(|d| d.bg(style::hover_fill(cx)))
                                .child("See everything"),
                            "See everything (0)",
                        )
                        .on_click(
                            cx.listener(|this, _: &ClickEvent, _, cx| this.canvas_everything(cx)),
                        ),
                    ),
            )
            .into_any_element()
    }

    /// Under the board, where the agent's words were: the tour's Back and
    /// Next with where it's up to.
    pub(super) fn render_tour(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let (at, of) = self.canvas_where().unwrap_or((1, 1));
        let label = style::label_text(cx);
        let step = |id: &'static str,
                    glyph: &'static str,
                    tip: &'static str,
                    by: i32,
                    enabled: bool,
                    cx: &mut Context<Self>| {
            crate::highlights::tipped(
                div()
                    .id(id)
                    .size(px(36.))
                    .rounded(px(18.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(18.))
                    .bg(style::button_fill(cx))
                    .border_1()
                    .border_color(style::button_edge(cx))
                    .text_color(if enabled {
                        label
                    } else {
                        style::faint_text(cx)
                    })
                    .when(enabled, |d| {
                        d.cursor_pointer().hover(|d| d.bg(style::hover_fill(cx)))
                    })
                    .child(glyph),
                tip,
            )
            .when(enabled, |d| {
                d.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.canvas_step(by, cx)))
            })
        };
        h_flex()
            .flex_1()
            .min_w_0()
            .gap(px(12.))
            .items_center()
            .child(step("canvas-back", "\u{2039}", "Back (\u{2190})", -1, at > 1, cx))
            .child(
                div()
                    .text_size(px(style::size::WORK))
                    .text_color(style::secondary_text(cx))
                    .child(format!("{at} of {of}")),
            )
            .child(step("canvas-next", "\u{203A}", "Next (\u{2192})", 1, at < of, cx))
            // Wraps in the room left of the reply box rather than running
            // under it.
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(13.))
                    .text_color(style::faint_text(cx))
                    .child("Drag to move, pinch to zoom, double-click to look closer. Circle, highlight or pin a part to talk about it."),
            )
            .into_any_element()
    }

    // ------------------------------------------------------------ moving round

    pub(super) fn set_tool(&mut self, tool: Tool, cx: &mut Context<Self>) {
        if tool != Tool::Move {
            self.canvas_stop_playing(cx);
        }
        if let Some(c) = self.canvas.as_mut() {
            c.tool = tool;
            c.drawing = None;
        }
        cx.notify();
    }

    pub(super) fn toggle_notes(&mut self, cx: &mut Context<Self>) {
        if let Some(c) = self.canvas.as_mut() {
            c.notes_on = !c.notes_on;
            if c.notes_on {
                c.scribble = Some(Instant::now());
            }
        }
        cx.notify();
    }

    /// The tour's stop `by` from this one (0: back to this one).
    pub(super) fn canvas_step(&mut self, by: i32, cx: &mut Context<Self>) {
        self.canvas_stop_playing(cx);
        if let Some(c) = self.canvas.as_mut() {
            let last = c.stops.len().saturating_sub(1) as i32;
            let next = (c.stop as i32 + by).clamp(0, last) as usize;
            c.go(next);
        }
        cx.notify();
    }

    /// The next or previous option's opening stop.
    pub(super) fn canvas_jump(&mut self, by: i32, cx: &mut Context<Self>) {
        let Some(c) = self.canvas.as_ref() else {
            return;
        };
        let current = c.stops.get(c.stop).and_then(|s| s.lit.option());
        let options = self.session.review().options.len() as i32;
        let next = match current {
            Some(o) => (o as i32 + by).clamp(0, options - 1),
            None if by > 0 => 0,
            None => options - 1,
        };
        self.canvas_go_option(next.max(0) as usize, cx);
    }

    pub(super) fn canvas_go_option(&mut self, option: usize, cx: &mut Context<Self>) {
        self.canvas_go_shot(option, 0, cx);
    }

    pub(super) fn canvas_go_shot(&mut self, option: usize, shot: usize, cx: &mut Context<Self>) {
        self.canvas_stop_playing(cx);
        if let Some(c) = self.canvas.as_mut() {
            if c.stops.is_empty() {
                c.want = Some((option, shot));
            } else if let Some(i) = stop_of(&c.stops, option, shot) {
                c.go(i);
            }
        }
        cx.notify();
    }

    pub(super) fn canvas_everything(&mut self, cx: &mut Context<Self>) {
        self.canvas_stop_playing(cx);
        if let Some(c) = self.canvas.as_mut() {
            let last = c.stops.len().saturating_sub(1);
            c.go(last);
        }
        cx.notify();
    }

    /// The board's own keys; whether it took this one. The arrows step
    /// through browse and jump, as on the stage.
    pub(super) fn canvas_key(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        match key {
            "escape" => {
                if self
                    .canvas
                    .as_ref()
                    .is_some_and(|c| c.playing.active().is_some())
                {
                    self.canvas_stop_playing(cx);
                    return true;
                }
                let tool = self.canvas.as_ref().map(|c| c.tool);
                if tool.is_some_and(|t| t != Tool::Move) {
                    self.set_tool(Tool::Move, cx);
                } else {
                    self.canvas_everything(cx);
                }
            }
            "0" => self.canvas_everything(cx),
            "n" => self.toggle_notes(cx),
            "v" => self.set_tool(Tool::Move, cx),
            "o" => self.set_tool(Tool::Circle, cx),
            "h" => self.set_tool(Tool::Highlight, cx),
            "p" => self.set_tool(Tool::Pin, cx),
            "space" => {}
            _ => return false,
        }
        true
    }

    /// A click on a mark's chip: fly to the mark.
    pub(super) fn canvas_show_mark(&mut self, n: u32, cx: &mut Context<Self>) {
        self.canvas_stop_playing(cx);
        let review = self.session.review().clone();
        let Some(mark) = self
            .session
            .draft()
            .marks
            .iter()
            .find(|m| m.n == n)
            .cloned()
        else {
            return;
        };
        if let Some(c) = self.canvas.as_mut() {
            if let Some((part, _)) = c
                .board
                .as_ref()
                .and_then(|b| board::mark_points(b, &review, &mark))
            {
                let around = Rect::new(part.x - 160., part.y - 120., part.w + 320., part.h + 240.);
                c.roaming = true;
                c.fly_to(around, board::STOP_ZOOM);
            }
        }
        cx.notify();
    }

    #[cfg(feature = "automation")]
    pub(super) fn script_canvas_double_click(
        &mut self,
        option: usize,
        shot: usize,
        cx: &mut Context<Self>,
    ) {
        let point = self
            .canvas
            .as_ref()
            .and_then(|c| c.board.as_ref())
            .and_then(|b| b.shot(option, shot))
            .map(|s| s.picture.center());
        if let Some(point) = point {
            self.canvas_look_closer(point, cx);
        }
    }

    /// What the board shows, for scripts and specs.
    #[cfg(feature = "automation")]
    pub(super) fn script_canvas_zoom(&mut self, factor: f32, cx: &mut Context<Self>) {
        if let Some(c) = self.canvas.as_mut() {
            c.camera = c.camera_now().zoom_at((0., 0.), factor);
            c.flight = None;
            c.roaming = true;
        }
        cx.notify();
    }

    #[cfg(feature = "automation")]
    pub(super) fn script_canvas_pan(&mut self, dx: f32, dy: f32, cx: &mut Context<Self>) {
        if let Some(c) = self.canvas.as_mut() {
            c.camera = c.camera_now().pan(dx, dy);
            c.flight = None;
            c.roaming = true;
        }
        cx.notify();
    }

    pub(super) fn canvas_state(&self) -> serde_json::Value {
        let Some(c) = self.canvas.as_ref() else {
            return serde_json::Value::Null;
        };
        let notes: usize = self
            .session
            .review()
            .options
            .iter()
            .flat_map(|o| o.all_shots())
            .map(|s| s.marks.len())
            .sum();
        serde_json::json!({
            "on": self.on_canvas(),
            "stop": c.stop + 1,
            "stops": c.stops.len(),
            "lit": c.stops.get(c.stop).map(|s| format!("{:?}", s.lit)).unwrap_or_default(),
            "notesOn": c.notes_on,
            "camera": [c.camera.s, c.camera.tx, c.camera.ty],
            "stopRect": c.stops.get(c.stop).map(|s| [s.rect.x, s.rect.y, s.rect.w, s.rect.h]),
            "peek": c.stops.get(c.stop).and_then(|s| s.peek),
            "agentMarks": notes,
            "tool": c.tool.name(),
            // What plays where it sits on the board: "clip" in the system's
            // player, "sound" on its play bar ("sound paused" before it
            // starts), "page" in place, "waiting" for
            // any of them, or nothing.
            "activeCard": c.playing.active(),
            "pageBounds": self.stage.page.as_ref().map(|(_, p)| p.bounds()),
            "mediaNotice": self.stage.notice,
            "playing": self.canvas_playing_shot().map(|shot| {
                if shot.video().is_some_and(|v| crate::media_view::state_of(&canvas_key(v)).is_some()) {
                    "clip"
                } else if let Some(sound) = shot.audio().and_then(|a| crate::media_view::state_of(&canvas_key(a))) {
                    if sound.playing { "sound" } else { "sound paused" }
                } else if shot.page().is_some_and(|p| self.stage.page.as_ref().is_some_and(|(shown, _)| shown == p)) {
                    "page"
                } else {
                    "waiting"
                }
            }),
            "marks": self.session.draft().marks.iter().map(|m| format!("{} {} {} {}", m.n, m.kind.name(), m.option_id, m.shot)).collect::<Vec<_>>(),
        })
    }

    /// A mark drawn by a script: `{ kind, option, shot, points: [[x, y]...] }`,
    /// points as fractions of that picture.
    #[cfg(feature = "automation")]
    pub(super) fn script_mark(
        &mut self,
        spec: &serde_json::Map<String, serde_json::Value>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let kind = match spec.get("kind").and_then(|k| k.as_str()) {
            Some("highlight") => UserMarkKind::Highlight,
            Some("pin") => UserMarkKind::Pin,
            _ => UserMarkKind::Circle,
        };
        let option = spec.get("option").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let shot = spec.get("shot").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        self.ensure_board(window);
        let Some(c) = self.canvas.as_mut() else {
            return;
        };
        let Some(picture) = c
            .board
            .as_ref()
            .and_then(|b| b.shot(option, shot))
            .map(|s| s.picture)
        else {
            return;
        };
        let points = spec
            .get("points")
            .and_then(|p| p.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|p| Some(picture.at(p.get(0)?.as_f64()?, p.get(1)?.as_f64()?)))
                    .collect()
            })
            .unwrap_or_default();
        c.drawing = Some(Drawing { kind, points });
        self.finish_mark(window, cx);
    }

    /// "3 of 8", for the stepper under the canvas.
    pub(super) fn canvas_where(&self) -> Option<(usize, usize)> {
        let c = self.canvas.as_ref()?;
        Some((c.stop + 1, c.stops.len()))
    }

    /// The option the tour is on, for the tabs.
    pub(super) fn canvas_option(&self) -> Option<usize> {
        let c = self.canvas.as_ref()?;
        c.stops.get(c.stop)?.lit.option()
    }

    fn canvas_point(&self, at: Point<Pixels>) -> Option<(f32, f32)> {
        let b = self.canvas.as_ref()?.bounds.get()?;
        Some((f32::from(at.x - b.origin.x), f32::from(at.y - b.origin.y)))
    }

    fn canvas_pressed(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(at) = self.canvas_point(ev.position) else {
            return;
        };
        let editable = self.session.editable();
        let Some(c) = self.canvas.as_mut() else {
            return;
        };
        let cam = c.camera_now();
        c.flight = None;
        c.camera = cam;
        match c.tool.kind() {
            Some(kind) if editable => {
                c.drawing = Some(Drawing {
                    kind,
                    points: vec![cam.to_world(at)],
                });
                if kind == UserMarkKind::Pin {
                    self.finish_mark(window, cx);
                }
            }
            _ => {
                if ev.click_count >= 2 {
                    self.canvas_look_closer(cam.to_world(at), cx);
                    return;
                }
                c.drag = Some(Drag {
                    from: at,
                    camera: cam,
                });
                self.take_keys(window, cx);
            }
        }
        cx.notify();
    }

    fn canvas_moved(&mut self, ev: &MouseMoveEvent, cx: &mut Context<Self>) {
        let Some(at) = self.canvas_point(ev.position) else {
            return;
        };
        let Some(c) = self.canvas.as_mut() else {
            return;
        };
        if let Some(d) = &c.drag {
            if ev.pressed_button != Some(MouseButton::Left) {
                c.drag = None;
                return;
            }
            c.camera = d.camera.pan(at.0 - d.from.0, at.1 - d.from.1);
            c.roaming = true;
            cx.notify();
        } else if let Some(d) = c.drawing.as_mut() {
            let p = c.camera.to_world(at);
            let last = *d.points.last().unwrap_or(&p);
            if ((p.0 - last.0).powi(2) + (p.1 - last.1).powi(2)).sqrt() * c.camera.s >= 3. {
                d.points.push(p);
                cx.notify();
            }
        }
    }

    fn canvas_released(&mut self, _ev: &MouseUpEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(c) = self.canvas.as_mut() else {
            return;
        };
        c.drag = None;
        if c.drawing.is_some() {
            self.finish_mark(window, cx);
        }
    }

    fn canvas_scrolled(&mut self, ev: &ScrollEvent, cx: &mut Context<Self>) {
        let Some(at) = self.canvas_point(ev.position) else {
            return;
        };
        let Some(c) = self.canvas.as_mut() else {
            return;
        };
        let cam = c.camera_now();
        c.flight = None;
        // A mouse's wheel zooms round the pointer, as Mike asked (22 Nov),
        // whether it counts notches (lines) or pixels like his Razer; a
        // trackpad's two fingers move, and zoom with ⌘ or Control held, or by
        // pinching.
        let wheel = ev.source == ScrollSource::Wheel;
        c.camera = match ev.delta {
            ScrollDelta::Lines(l) => cam.zoom_at(at, board::wheel_zoom(l.y)),
            ScrollDelta::Pixels(p) if wheel => {
                cam.zoom_at(at, board::smooth_wheel_zoom(f32::from(p.y)))
            }
            ScrollDelta::Pixels(p) if ev.modifiers.platform || ev.modifiers.control => {
                cam.zoom_at(at, (f32::from(p.y) * 0.01).exp())
            }
            ScrollDelta::Pixels(p) => cam.pan(f32::from(p.x), f32::from(p.y)),
        };
        c.roaming = true;
        cx.stop_propagation();
        cx.notify();
    }

    fn canvas_pinched(&mut self, ev: &PinchEvent, cx: &mut Context<Self>) {
        let Some(at) = self.canvas_point(ev.position) else {
            return;
        };
        let Some(c) = self.canvas.as_mut() else {
            return;
        };
        let cam = c.camera_now();
        c.flight = None;
        c.camera = cam.zoom_at(at, 1. + ev.delta);
        c.roaming = true;
        cx.notify();
    }

    /// A double-click: fly to the picture under it, or its frame, or out to
    /// everything. Only clips and sounds play on double-click; HTML keeps its marks.
    fn canvas_look_closer(&mut self, at: (f32, f32), cx: &mut Context<Self>) {
        self.canvas_stop_playing(cx);
        let Some(c) = self.canvas.as_mut() else {
            return;
        };
        let Some(laid) = c.board.as_ref() else { return };
        if let Some(shot) = laid.shot_at(at) {
            let (option, index, rect) = (shot.option, shot.shot, shot.extent());
            let moving = self
                .session
                .review()
                .options
                .get(option)
                .map(|o| o.shot(index))
                .is_some_and(|s| s.video().is_some() || s.audio().is_some());
            c.roaming = true;
            c.fly_to(rect, board::STOP_ZOOM);
            if moving {
                self.canvas_play((option, index), cx);
                return;
            }
        } else if let Some(o) = laid.options.iter().find(|o| o.frame.contains(at)) {
            let rect = o.extent();
            c.roaming = true;
            c.fly_to(rect, board::STOP_ZOOM);
        } else {
            let rect = laid.bounds;
            c.roaming = true;
            c.fly_to(rect, board::MAX_ZOOM);
        }
        cx.notify();
    }

    // ------------------------------------------------------------ Mike's marks

    fn finish_mark(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let review = self.session.review().clone();
        let n = board::next_mark_number(&self.session.draft().marks);
        let Some(c) = self.canvas.as_mut() else {
            return;
        };
        let Some(drawing) = c.drawing.take() else {
            return;
        };
        let Some(laid) = c.board.as_ref() else { return };
        if drawing.is_scribble() {
            cx.notify();
            return;
        }
        let reach = board::pen_reach(MARKER, &c.camera);
        let Some(mark) = drawing.to_mark(laid, &review, n, reach) else {
            self.session.error = Some("Marks go on a picture.".into());
            cx.notify();
            return;
        };
        let cut_from = review
            .options
            .iter()
            .find(|o| o.id == mark.option_id)
            .map(|o| o.shot(mark.shot).image.path);
        let cut = board::cut_out_box(&mark);
        if self.session.add_mark(mark) {
            self.insert_mark_chip(n, window, cx);
            self.edited(cx);
            if let Some(path) = cut_from {
                self.cut_out_mark(n, path, cut, cx);
            }
        }
        cx.notify();
    }

    /// The picture round a mark, cut out off the main thread and copied in
    /// through the runner, to go to the agent with it.
    fn cut_out_mark(&mut self, n: u32, path: String, part: [f64; 4], cx: &mut Context<Self>) {
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let turn = cx.update(crate::fit_picture::decode_now_turn);
            let _turn = turn.await;
            let made = cx
                .background_executor()
                .spawn(async move { cut_out(&path, part) })
                .await;
            let Some(file) = made else { return };
            let result = crate::call_action(
                client,
                "media.import",
                serde_json::json!({ "path": file.to_string_lossy() }),
            )
            .await;
            let _ = std::fs::remove_file(&file);
            let Ok(value) = result else { return };
            let Some(image) = threadbear_core::reducer::ImageRef::decode(&value["image"]) else {
                return;
            };
            this.update(cx, |this, cx| {
                this.mark_chip_image(n, image.path.clone());
                if this.session.set_mark_image(n, image) {
                    this.edited(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

/// A PNG of part of a picture (fractions of it), at most 480 wide, in the
/// temporary folder; None when the picture isn't on this Mac or won't read.
fn cut_out(path: &str, part: [f64; 4]) -> Option<std::path::PathBuf> {
    // Read under the path guard and decoded within the picture budget's
    // limits (fit_picture.rs); the part is the same fraction of it shrunk.
    let piece = (0..3).find_map(|_| {
        let read = || crate::rows::markdown::checked_picture_bytes(std::path::Path::new(path)).ok();
        match crate::fit_picture::decode_now(
            read,
            |size| cut_plan(size, part),
            |picture| {
                let picture = image::DynamicImage::ImageRgba8(picture);
                let (w, h) = (f64::from(picture.width()), f64::from(picture.height()));
                let x = (part[0] * w).floor() as u32;
                let y = (part[1] * h).floor() as u32;
                let cw = (((part[2] - part[0]) * w).ceil() as u32).max(1);
                let ch = (((part[3] - part[1]) * h).ceil() as u32).max(1);
                let piece = picture.crop_imm(x, y, cw, ch);
                let piece = if piece.width() > 480 {
                    piece.resize(
                        480,
                        480 * piece.height() / piece.width().max(1),
                        image::imageops::FilterType::Triangle,
                    )
                } else {
                    piece
                };
                Some(piece)
            },
        ) {
            Ok(piece) => Some(Some(piece)),
            Err(crate::fit_picture::Missed::Failed) => Some(None),
            // No room yet (the picture on screen holds some): a while longer.
            Err(crate::fit_picture::Missed::Busy) => None,
        }
    })??;
    let file = std::env::temp_dir().join(format!(
        "threadbear-mark-{}-{}.png",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    ));
    piece.save(&file).ok()?;
    Some(file)
}

/// What `cut_out` decodes a `size` picture to: only as big as a 480-wide
/// piece of `part` needs, rather than all 32 million pixels a picture may
/// keep, and room for the piece cut and shrunk from it. An 8,192-square
/// picture on screen, with room asked for two whole copies besides, never
/// fitted the budget, so its cut-out never came (Daybreak 170, round 4).
fn cut_plan((w, h): (u32, u32), part: [f64; 4]) -> crate::fit_picture::Plan {
    // The size is the file's; a photo turned by its EXIF is shown (and cut)
    // the other way round, so plan for whichever asks more.
    let (a, b) = (cut_plan_as((w, h), part), cut_plan_as((h, w), part));
    crate::fit_picture::Plan {
        shown_pixels: a.shown_pixels.max(b.shown_pixels),
        made_bytes: a.made_bytes.max(b.made_bytes),
    }
}

fn cut_plan_as((w, h): (u32, u32), part: [f64; 4]) -> crate::fit_picture::Plan {
    let (w, h) = (f64::from(w.max(1)), f64::from(h.max(1)));
    let across = (part[2] - part[0]).clamp(1. / w, 1.);
    let down = (part[3] - part[1]).clamp(1. / h, 1.);
    // Decoded at the scale that makes the piece 480 wide, never bigger.
    let scale = (480. / (across * w)).min(1.);
    let (kw, kh) = ((w * scale).ceil(), (h * scale).ceil());
    let piece = ((across * kw).ceil() + 1.) * ((down * kh).ceil() + 1.);
    crate::fit_picture::Plan {
        shown_pixels: (kw * kh) as u64,
        // The piece, and its shrunk copy, no bigger.
        made_bytes: (piece * 4. * 2.) as u64 + (1 << 20),
    }
}

/// The agent's words without their markdown marks: on the board they're
/// drawn at any size, as plain text.
fn plain(text: &str) -> String {
    text.replace("**", "").replace('`', "")
}

/// The tour's stop for an option's picture.
fn stop_of(stops: &[Stop], option: usize, shot: usize) -> Option<usize> {
    stops.iter().position(|s| match s.lit {
        Lit::Opening(o) => o == option && shot == 0,
        Lit::Shot(o, n) => o == option && n == shot,
        _ => false,
    })
}

/// How far under the canvas's top a playing clip or page may sit: the
/// tools' row is GPUI's, and a native view would cover it.
const PLAY_TOP: f32 = 52.;
/// Smaller than this on screen, a clip or page shows its still: its
/// controls wouldn't fit.
const PLAY_SMALLEST: f32 = 160.;

/// The board's player for a clip (media_view.rs), one per window.
pub(super) fn canvas_key(path: &str) -> String {
    format!("review canvas {path}")
}

impl ReviewWindow {
    /// A clip's or a page's button on its picture: Play (or Show the page),
    /// or, while it's playing, Stop just over its top right corner (under
    /// it, with the tools' row in the way), as the player covers the picture.
    fn play_button(
        &self,
        scene: &Scene,
        index: usize,
        shot_laid: &board::BoardShot,
        option: &threadbear_core::reducer::ReviewOption,
        shot: &threadbear_core::reducer::ReviewShot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let s = scene.cam.rect(&shot_laid.picture);
        if s.w < 90. {
            return div().into_any_element();
        }
        let page = shot.page().is_some();
        let header = if page {
            let Some(header) = board::html_control_rect(s) else {
                return div().into_any_element();
            };
            Some(header)
        } else {
            None
        };
        let at = (index, shot_laid.shot);
        let playing = self.canvas.as_ref().and_then(|c| c.playing.active()) == Some(at);
        let name = threadbear_core::review::shot_tip(option, shot_laid.shot);
        let (icon, words, tip) = match (playing, page) {
            (false, false) if shot.audio().is_some() => (
                gpui_kit::assets::IconName::Music,
                "Play",
                format!("Play {name} here"),
            ),
            (false, false) => (
                gpui_kit::assets::IconName::Play,
                "Play",
                format!("Play {name} here"),
            ),
            (false, true) => (
                gpui_kit::assets::IconName::Globe,
                "Interact",
                format!("Interact with {name} here, sealed and offline"),
            ),
            (true, false) => (
                gpui_kit::assets::IconName::Square,
                "Stop",
                format!("Stop {name}"),
            ),
            (true, true) => (
                gpui_kit::assets::IconName::Close,
                "Stop",
                format!("Stop {name}"),
            ),
        };
        // Clear of the tools' row, which is drawn over the board and takes
        // a click aimed at a button under it: Stop goes under the picture
        // when there's no room over it (a sound's Stop sat under the row and
        // never stopped it, 24 Nov 2026).
        let top = if let Some(header) = header {
            header.y
        } else if !playing {
            (s.y + 8.).max(PLAY_TOP.min(s.y + s.h - 34.))
        } else if s.y - 34. >= PLAY_TOP || s.y + s.h + 34. > scene.view.1 {
            s.y - 34.
        } else {
            s.y + s.h + 8.
        };
        let button = crate::highlights::tipped(
            h_flex()
                .id(SharedString::from(format!("canvas-play-{}-{}", at.0, at.1)))
                .h(px(26.))
                .px(px(10.))
                .gap(px(6.))
                .items_center()
                .rounded(px(13.))
                .bg(hsla(0., 0., 0., 0.72))
                .hover(|d| d.bg(hsla(0., 0., 0., 0.88)))
                .text_color(white())
                .text_size(px(12.))
                .font_weight(FontWeight::SEMIBOLD)
                .cursor_pointer()
                .child(
                    gpui_kit::component::Icon::new(icon)
                        .with_size(px(12.))
                        .text_color(white()),
                )
                .child(words),
            tip,
        )
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            cx.stop_propagation();
            if playing {
                this.canvas_stop_playing(cx);
            } else {
                this.canvas_play(at, cx);
            }
        }))
        .into_any_element();
        h_flex()
            .absolute()
            .left(gpui_kit::px(s.x))
            .top(gpui_kit::px(top))
            .w(gpui_kit::px(s.w))
            .justify_end()
            .child(button)
            .into_any_element()
    }

    /// Plays the clip or shows the page of `at` where it sits on the board.
    pub(super) fn canvas_play(&mut self, at: (usize, usize), cx: &mut Context<Self>) {
        self.canvas_stop_playing(cx);
        self.stage.page_failed = None;
        self.stage.notice = None;
        // Where this window can't play a clip or a sound (Windows, Linux),
        // it opens in the app this computer plays it in, as the stage's
        // button does.
        let away = self
            .session
            .review()
            .options
            .get(at.0)
            .map(|o| o.shot(at.1))
            .and_then(|s| s.video().or(s.audio()).map(str::to_owned))
            .filter(|_| !crate::media_view::SHOWN_HERE);
        if let Some(video) = away {
            crate::open_gate::open_file(&video, threadbear_core::open_policy::Origin::ThisMac, cx);
            return;
        }
        let html = self
            .session
            .review()
            .options
            .get(at.0)
            .map(|o| o.shot(at.1))
            .is_some_and(|s| s.page().is_some());
        if let Some(c) = self.canvas.as_mut() {
            if html {
                if let (Some(rect), Some((vw, vh))) = (
                    c.board
                        .as_ref()
                        .and_then(|b| b.shot(at.0, at.1))
                        .map(|s| s.picture),
                    c.viewport(),
                ) {
                    // Leave chrome and Stop clear. Settle before mounting the native view.
                    let mut cam = Camera::fit(
                        rect,
                        vw,
                        (vh - 86.).max(1.),
                        board::STOP_PAD,
                        board::STOP_ZOOM,
                    );
                    cam.ty += 86.;
                    if !board::live_fits(c.camera.rect(&rect), (vw, vh)) {
                        c.camera = cam;
                    }
                    c.flight = None;
                    c.roaming = true;
                }
            }
            c.playing.activate(at);
            c.drag = None;
            c.start_sound = true;
            if c.tool != Tool::Move {
                c.tool = Tool::Move;
                c.drawing = None;
            }
        }
        cx.notify();
    }

    /// The shot playing on the board, while it's in sight.
    pub(super) fn canvas_playing_shot(&self) -> Option<threadbear_core::reducer::ReviewShot> {
        let (option, shot) = self.canvas.as_ref()?.playing.active()?;
        let o = self.session.review().options.get(option)?;
        (shot < o.shot_count()).then(|| o.shot(shot))
    }

    /// The clip or page playing on the board, over its picture: there while
    /// the picture's wholly in the canvas and big enough for its controls,
    /// hidden (still playing, so a music bed goes on as you move round) while
    /// it's partly out, and stopped once it's out of sight.
    fn canvas_player(
        &mut self,
        scene: &Scene,
        laid: &Board,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let (option, index) = self.canvas.as_ref()?.playing.active()?;
        let rect = laid
            .options
            .iter()
            .find(|o| o.index == option)?
            .shots
            .iter()
            .find(|s| s.shot == index)?
            .picture;
        let Some(shot) = self.canvas_playing_shot() else {
            self.canvas.as_mut()?.playing.stop();
            return None;
        };
        let editable = self.canvas.as_ref().is_some_and(|c| c.tool == Tool::Move);
        if !scene.visible(&rect) || !editable {
            self.canvas_stop_playing(cx);
            return None;
        }
        let s = scene.cam.rect(&rect);
        let (vw, vh) = scene.view;
        let whole = s.x >= 0.
            && s.y >= PLAY_TOP
            && s.x + s.w <= vw
            && s.y + s.h <= vh
            && s.w >= PLAY_SMALLEST
            && s.h >= PLAY_SMALLEST * 0.4;
        let spot = div()
            .absolute()
            .left(gpui_kit::px(s.x))
            .top(gpui_kit::px(s.y));
        let spot = if whole {
            spot.w(gpui_kit::px(s.w)).h(gpui_kit::px(s.h))
        } else {
            // A slot drawn with no size is hidden, not gone (media_view's sweep).
            spot.size_0()
        };
        if let Some(page) = shot.page() {
            if !board::live_fits(s, scene.view) || self.more_open || self.viewer.is_open() {
                self.canvas_stop_playing(cx);
                return None;
            }
            if let Some(view) = self.canvas_live_page(page, window, cx) {
                return Some(spot.child(view).into_any_element());
            }
            // A failed seal restores the snapshot and offers no browser fallback.
            if self
                .stage
                .page_failed
                .as_ref()
                .is_some_and(|(p, _)| p == page)
            {
                let page = page.to_owned();
                self.canvas.as_mut()?.playing.stop();
                self.stage.notice = Some(format!(
                    "Couldn't run {} safely.",
                    threadbear_core::highlights::last_component(&page)
                ));
                return None;
            }
            let Some(runtime) = crate::web_runtime::runtime(cx) else {
                self.canvas_stop_playing(cx);
                self.stage.notice =
                    Some("This HTML option stays a snapshot on this platform.".into());
                return None;
            };
            let r = runtime.read(cx);
            let waiting = page_waiting(&r.state, r.not_now);
            if waiting == PageWaiting::Stopped
                || matches!(r.engine, crate::web_runtime::Engine::Failed(_))
            {
                self.canvas_stop_playing(cx);
                self.stage.notice = Some("This HTML option stays a snapshot. Install or retry the web runtime in Settings to interact.".into());
                return None;
            }
            return Some(
                spot.child(
                    gpui_kit::component::v_flex()
                        .size_full()
                        .items_center()
                        .justify_center()
                        .gap(px(10.))
                        .p(px(20.))
                        .bg(hsla(0., 0., 0., 0.45))
                        .text_color(white())
                        .text_size(px(13.))
                        .children(crate::web_runtime::prompt(
                            "canvas-page-runtime",
                            "this HTML option",
                            cx,
                        ))
                        .when(waiting == PageWaiting::Opening, |d| {
                            d.child("Opening the page…")
                        }),
                )
                .into_any_element(),
            );
        }
        // A sound: its waveform stays the picture, with the pane's play bar
        // along its bottom, started at once as Play was what was pressed.
        if let Some(sound) = shot.audio().filter(|_| crate::media_view::SHOWN_HERE) {
            let key = canvas_key(sound);
            let path = sound.to_owned();
            let made = crate::media_view::slot(&key, window, |opening| {
                crate::open_gate::show_media(
                    &path,
                    threadbear_core::open_policy::Origin::ThisMac,
                    crate::media_view::Kind::PaneAudio,
                    opening,
                )
            });
            return match made {
                Ok(view) => {
                    if std::mem::take(&mut self.canvas.as_mut()?.start_sound) {
                        crate::media_view::play(&key);
                    }
                    let bar = div().absolute().left_0().right_0().bottom(px(12.));
                    let bar = if whole { bar.h(px(44.)) } else { bar.size_0() };
                    Some(spot.child(bar.child(view)).into_any_element())
                }
                Err(why) => {
                    self.stage.notice = Some(why);
                    self.canvas.as_mut()?.playing.stop();
                    None
                }
            };
        }
        let video = shot
            .video()
            .filter(|_| crate::media_view::SHOWN_HERE)?
            .to_owned();
        let view = crate::media_view::slot(&canvas_key(&video), window, |opening| {
            crate::open_gate::show_media(
                &video,
                threadbear_core::open_policy::Origin::ThisMac,
                crate::media_view::Kind::StageVideo,
                opening,
            )
        });
        match view {
            Ok(view) => Some(spot.child(view).into_any_element()),
            Err(why) => {
                self.stage.notice = Some(why);
                self.canvas.as_mut()?.playing.stop();
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::cut_plan;
    use crate::fit_picture::{BUDGET_BYTES, LIMITS};

    #[test]
    fn runtime_prompt_distinguishes_installation_opening_and_declining() {
        use super::{page_waiting, PageWaiting};
        use threadbear_core::web_runtime::State;
        for state in [
            State::Missing,
            State::Failed("download failed".into()),
            State::Downloading {
                received: 1,
                total: 10,
            },
            State::Unpacking,
        ] {
            assert_eq!(page_waiting(&state, false), PageWaiting::Prompt);
        }
        assert_eq!(page_waiting(&State::Ready, false), PageWaiting::Opening);
        for state in [State::Missing, State::Failed("no".into()), State::Ready] {
            assert_eq!(page_waiting(&state, true), PageWaiting::Stopped);
        }
        assert_eq!(
            page_waiting(&State::Unavailable, false),
            PageWaiting::Stopped
        );
        assert_eq!(page_waiting(&State::Unpacking, true), PageWaiting::Prompt);
    }

    // Daybreak 170, round 4: an 8,192-square picture on screen keeps 134 MB,
    // and its cut-out asked for 896 MB besides, so it never fitted.
    #[test]
    fn a_cut_out_asks_only_for_what_its_piece_needs() {
        let kept_on_screen = LIMITS.shown_pixels * 4;
        let small = cut_plan((8192, 8192), [0.4, 0.4, 0.45, 0.45]);
        let whole = cut_plan((8192, 8192), [0., 0., 1., 1.]);
        for plan in [&small, &whole] {
            let limits = gpui_kit::image_budget::DecodeLimits {
                shown_pixels: plan.shown_pixels.min(LIMITS.shown_pixels),
                frames: 1,
                ..LIMITS
            };
            let need =
                gpui_kit::image_budget::peak_bytes(50 << 20, Some((8192, 8192)), false, &limits)
                    + plan.made_bytes;
            assert!(kept_on_screen + need < BUDGET_BYTES, "{need}");
        }
        // The whole picture is decoded only as big as a 480-wide piece.
        assert!(whole.shown_pixels <= 481 * 481);
        // A small part keeps its detail: up to the picture's own size.
        assert!(small.shown_pixels >= 4096 * 4096);
        assert!(small.made_bytes < 8 << 20);
    }
}
