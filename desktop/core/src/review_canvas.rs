//! The review as a canvas: where everything
//! sits on the board, the tour's stops, the camera, and the hand-drawn shapes
//! of the agent's notes and Mike's own marks.
//!
//! Mike, 22 Nov 2026: after an audit of how other apps show options with
//! several pictures, he asked for the review as a canvas he drags and zooms
//! around, the agent drawing "little helpful arrows pointing out things
//! visually" in the Convex Explained doodle style, a switch to hide them, and
//! tools of his own to circle, highlight or pin a part. Of three mockups he
//! took the board with the agent's tour: Next flies along the agent's order,
//! and he can still roam. The board is laid out in world units, where a
//! picture is 640 wide; the camera maps them to the window.

use crate::reducer::{
    AgentMark, DesignReview, MarkBox, MarkKind, ReviewOption, UserMark, UserMarkKind,
};
use crate::review::aspect;

/// A picture's width on the board.
pub const PICTURE_WIDTH: f32 = 640.;
/// HTML controls have their own band, clear of titles, captions and content.
pub const HTML_HEADER: f32 = SHOT_GAP;
/// Fixed screen space for Interact/Stop plus clearance beside a label.
pub const HTML_PILL_WIDTH: f32 = 110.;
/// Desktop CSS viewport used by HTML thumbnails; scale it with the card.
pub const HTML_DESIGN_WIDTH: f64 = 1024.;
/// CEF clamps native zoom to 25%; smaller live slots would reflow the page.
pub const HTML_MIN_LIVE_WIDTH: f32 = 256.;

pub fn html_zoom(width: f32) -> f64 {
    f64::from(width) / HTML_DESIGN_WIDTH
}

/// Fixed-size pill anchored to the picture, never the previous frame's viewport.
pub fn html_control_rect(picture: Rect) -> Option<Rect> {
    (picture.w >= 160. && picture.y >= 84.)
        .then(|| Rect::new(picture.x, picture.y - 32., picture.w, 26.))
}
/// Labels share the pill's row only at small scales. Reserve its screen
/// width there; at larger scales titles and captions retain the full width.
pub fn html_label_width(label: Rect, picture: Rect) -> f32 {
    if html_control_rect(picture)
        .is_some_and(|pill| label.y < pill.bottom() && label.bottom() > pill.y)
    {
        label.w.min((picture.w - HTML_PILL_WIDTH).max(0.))
    } else {
        label.w
    }
}

/// Between an option's last picture and its words.
pub const GAP: f32 = 22.;
/// Between one of an option's pictures and the next one's caption.
pub const SHOT_GAP: f32 = 48.;
/// A picture's caption, over it.
pub const CAPTION_HEIGHT: f32 = 34.;
/// The option's words, in world units: the thread's reading size when the
/// camera is at 1.
pub const WORDS_SIZE: f32 = 22.;
/// The agent's handwritten notes.
pub const NOTE_SIZE: f32 = 36.;
/// From a picture's right edge to its notes.
pub const NOTE_GAP: f32 = 96.;
/// The widest a note gets before it wraps.
pub const NOTE_WIDTH: f32 = 330.;
/// Between frames, room for the notes beside the pictures.
pub const GUTTER: f32 = NOTE_GAP + NOTE_WIDTH + 130.;
/// How far an option's halo reaches past its name, pictures and words: a
/// soft glow, not a box, so the agent's notes sit outside it on the board
/// (Mike, 23 Nov, from the Halo mockup).
pub const HALO_PAD: f32 = 40.;
/// The option's top row, over its first picture, for the tick and its name.
pub const TITLE_ROW: f32 = 52.;
/// Between that row and the first picture.
pub const TITLE_GAP: f32 = 10.;
/// The option's big letter, standing on its first picture's top right
/// corner with just its feet behind it.
pub const LETTER_SIZE: f32 = 230.;
/// How far the letter's box starts left of that corner.
const LETTER_LEFT: f32 = 0.62;
/// How far it starts above it: the glyph fills nearly all its box, so this
/// leaves only its bottom tenth or so behind the picture. At 0.62 half of it
/// was hidden, too much (Mike, 24 Nov).
const LETTER_ABOVE: f32 = 0.86;
/// The agent's lead, the sticky at the board's top left.
pub const LEAD_WIDTH: f32 = 440.;
/// How far each frame sits below the board's top, in turn: a little
/// staggered, like things laid on a table, not a grid.
const STAGGER: [f32; 4] = [0., 130., 50., 170.];
/// Between two notes beside the same picture.
const NOTE_SPACING: f32 = 30.;

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }

    pub fn right(&self) -> f32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }

    pub fn center(&self) -> (f32, f32) {
        (self.x + self.w / 2., self.y + self.h / 2.)
    }

    pub fn union(&self, other: &Rect) -> Rect {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        Rect::new(
            x,
            y,
            self.right().max(other.right()) - x,
            self.bottom().max(other.bottom()) - y,
        )
    }

    pub fn contains(&self, (x, y): (f32, f32)) -> bool {
        x >= self.x && x <= self.right() && y >= self.y && y <= self.bottom()
    }

    /// A point given as fractions of this rect.
    pub fn at(&self, fx: f64, fy: f64) -> (f32, f32) {
        (self.x + fx as f32 * self.w, self.y + fy as f32 * self.h)
    }

    /// A mark's box on this rect.
    pub fn part(&self, b: &MarkBox) -> Rect {
        let (x0, y0) = self.at(b[0], b[1]);
        let (x1, y1) = self.at(b[2], b[3]);
        Rect::new(x0, y0, x1 - x0, y1 - y0)
    }
}

/// How tall words come out at a width, and how big a note is: the window
/// measures with its fonts; tests guess.
pub trait Measure {
    /// The height of `text` at WORDS_SIZE wrapped to `width`.
    fn words(&self, text: &str, width: f32) -> f32;
    /// The size of a handwritten note at NOTE_SIZE, wrapped to NOTE_WIDTH.
    fn note(&self, text: &str) -> (f32, f32);
}

/// A rough guess at text sizes, for tests and before fonts are loaded.
pub struct Guess;

impl Measure for Guess {
    fn words(&self, text: &str, width: f32) -> f32 {
        let per_line = (width / (WORDS_SIZE * 0.5)).max(1.);
        let lines = (crate::reducer::text::count(text) as f32 / per_line)
            .ceil()
            .max(1.);
        lines * WORDS_SIZE * 1.5
    }

    fn note(&self, text: &str) -> (f32, f32) {
        let chars = crate::reducer::text::count(text) as f32;
        let per_line = NOTE_WIDTH / (NOTE_SIZE * 0.42);
        let lines = (chars / per_line).ceil().max(1.);
        let w = (chars.min(per_line) * NOTE_SIZE * 0.42).min(NOTE_WIDTH);
        (w, lines * NOTE_SIZE * 1.1)
    }
}

/// An agent's note beside a picture: where it sits and the spot its pointer
/// runs to.
#[derive(Clone, Debug, PartialEq)]
pub struct NotePlace {
    pub mark: usize,
    pub rect: Rect,
    pub target: (f32, f32),
    /// Left of the picture, for a mark on its left side: a pointer from the
    /// right would cross the whole picture.
    pub left: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoardShot {
    pub option: usize,
    pub shot: usize,
    pub picture: Rect,
    /// Over the picture; no height for a first picture with no title.
    pub caption: Rect,
    pub notes: Vec<NotePlace>,
}

impl BoardShot {
    /// The picture with its caption and notes: what the tour shows of it.
    pub fn extent(&self) -> Rect {
        self.notes
            .iter()
            .fold(self.picture.union(&self.caption), |r, n| r.union(&n.rect))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoardOption {
    pub index: usize,
    /// Its column: the name on top, the pictures one under another, the
    /// words at the bottom.
    pub frame: Rect,
    pub words: Option<Rect>,
    pub shots: Vec<BoardShot>,
    /// The soft glow behind the column, green once it's ticked. The notes
    /// are outside it.
    pub halo: Rect,
    /// The top row, with the tick and its name.
    pub title: Rect,
    /// Its big letter, its feet behind the first picture's top right corner.
    pub letter: Rect,
}

impl BoardOption {
    /// Everything of it: the halo, the letter and the notes.
    pub fn extent(&self) -> Rect {
        self.shots
            .iter()
            .fold(self.halo.union(&self.letter), |r, s| r.union(&s.extent()))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Board {
    pub lead: Option<Rect>,
    pub options: Vec<BoardOption>,
    pub bounds: Rect,
}

impl Board {
    pub fn shot(&self, option: usize, shot: usize) -> Option<&BoardShot> {
        self.options.get(option)?.shots.get(shot)
    }

    /// The picture under a point on the board, if any.
    pub fn shot_at(&self, point: (f32, f32)) -> Option<&BoardShot> {
        self.options
            .iter()
            .flat_map(|o| &o.shots)
            .find(|s| s.picture.contains(point))
    }
}

/// Lays the review out: the lead at the top left, then a column for each
/// option left to right, its name over its pictures and its words under
/// them, the agent's notes beside each picture.
pub fn layout(review: &DesignReview, measure: &dyn Measure) -> Board {
    let lead = review
        .note
        .as_deref()
        .filter(|n| !n.trim().is_empty())
        .map(|note| {
            Rect::new(
                0.,
                0.,
                LEAD_WIDTH,
                measure.words(note, LEAD_WIDTH - 48.) + 48.,
            )
        });
    let mut x = lead.map_or(0., |l| l.right() + 140.);
    let mut options = Vec::new();
    for (index, option) in review.options.iter().enumerate() {
        let top = STAGGER[index % STAGGER.len()];
        if needs_left_room(option) {
            x += NOTE_GAP + NOTE_WIDTH + 40.;
        }
        let laid = lay_option(index, option, x, top, measure);
        x = laid.frame.right() + GUTTER;
        options.push(laid);
    }
    let bounds = options
        .iter()
        .map(BoardOption::extent)
        .chain(lead)
        .reduce(|a, b| a.union(&b))
        .unwrap_or_default();
    Board {
        lead,
        options,
        bounds,
    }
}

fn lay_option(
    index: usize,
    option: &ReviewOption,
    x: f32,
    top: f32,
    measure: &dyn Measure,
) -> BoardOption {
    let title = Rect::new(x, top, PICTURE_WIDTH, TITLE_ROW);
    let mut y = title.bottom() + TITLE_GAP;
    let mut shots = Vec::new();
    for (i, shot) in option.all_shots().iter().enumerate() {
        // The pages after the first always have a name over them, theirs or
        // "2 of 3"; the first only when it has its own.
        let caption_h = if i > 0 || shot.title.is_some() {
            CAPTION_HEIGHT
        } else {
            0.
        };
        let caption = Rect::new(x, y, PICTURE_WIDTH, caption_h);
        let h = PICTURE_WIDTH / aspect(&shot.image) as f32;
        let picture = Rect::new(
            x,
            caption.bottom()
                + if shot.page().is_some() {
                    HTML_HEADER
                } else {
                    0.
                },
            PICTURE_WIDTH,
            h,
        );
        y = picture.bottom() + SHOT_GAP;
        shots.push(BoardShot {
            option: index,
            shot: i,
            picture,
            caption,
            notes: place_notes(&picture, &shot.marks, measure),
        });
    }
    y += GAP - SHOT_GAP;
    let words = option
        .note
        .as_deref()
        .filter(|n| !n.trim().is_empty())
        .map(|note| {
            let r = Rect::new(x, y, PICTURE_WIDTH, measure.words(note, PICTURE_WIDTH));
            y = r.bottom();
            r
        });
    let frame = Rect::new(x, top, PICTURE_WIDTH, y - top);
    let halo = Rect::new(
        frame.x - HALO_PAD,
        frame.y - HALO_PAD,
        frame.w + HALO_PAD * 2.,
        frame.h + HALO_PAD * 2.,
    );
    let first = shots.first().map_or(frame, |s| s.picture);
    let letter = Rect::new(
        first.right() - LETTER_SIZE * LETTER_LEFT,
        first.y - LETTER_SIZE * LETTER_ABOVE,
        LETTER_SIZE * 0.8,
        LETTER_SIZE,
    );
    BoardOption {
        index,
        frame,
        words,
        shots,
        halo,
        title,
        letter,
    }
}

/// Whether a mark's note goes left of its picture: when the mark is on the
/// picture's left part.
pub fn note_goes_left(mark: &AgentMark) -> bool {
    (mark.bbox[0] + mark.bbox[2]) / 2. < 0.42
}

/// Where a mark's pointer lands, on the side its note is: the edge of a
/// circle, the end of an underline or swipe, the middle of what an arrow
/// points at.
pub fn mark_target(picture: &Rect, mark: &AgentMark) -> (f32, f32) {
    let part = picture.part(&mark.bbox);
    let left = note_goes_left(mark);
    let (edge, out) = if left {
        (part.x, -1.)
    } else {
        (part.right(), 1.)
    };
    match mark.kind {
        MarkKind::Circle => (edge + out * (part.w * 0.21 + 8.), part.y + part.h * 0.45),
        MarkKind::Underline => (edge + out * 10., part.bottom()),
        MarkKind::Highlight => (edge + out * 8., part.y + part.h / 2.),
        MarkKind::Arrow => part.center(),
    }
}

/// Notes go in a column to the right of their picture, each level with its
/// mark and nudged up so the curl arrives from below, then pushed down so
/// none overlap, the way doodle-notes.js lays them beside code.
fn place_notes(picture: &Rect, marks: &[AgentMark], measure: &dyn Measure) -> Vec<NotePlace> {
    let mut placed: Vec<NotePlace> = Vec::new();
    let mut order: Vec<usize> = (0..marks.len())
        .filter(|&i| marks[i].note.is_some())
        .collect();
    order.sort_by(|&a, &b| {
        mark_target(picture, &marks[a])
            .1
            .total_cmp(&mark_target(picture, &marks[b]).1)
    });
    // A column each side, each stacked on its own.
    let (mut floor_left, mut floor_right) = (f32::MIN, f32::MIN);
    for i in order {
        let (w, h) = measure.note(marks[i].note.as_deref().unwrap_or_default());
        let target = mark_target(picture, &marks[i]);
        let left = note_goes_left(&marks[i]);
        let floor = if left {
            &mut floor_left
        } else {
            &mut floor_right
        };
        let y = (target.1 - h / 2. - 10.).max(*floor);
        let x = if left {
            picture.x - NOTE_GAP - w
        } else {
            picture.right() + NOTE_GAP
        };
        let rect = Rect::new(x, y, w, h);
        *floor = rect.bottom() + NOTE_SPACING;
        placed.push(NotePlace {
            mark: i,
            rect,
            target,
            left,
        });
    }
    placed.sort_by_key(|n| n.mark);
    placed
}

/// Whether any of an option's pictures has a note on its left, which then
/// needs room before the frame.
fn needs_left_room(option: &ReviewOption) -> bool {
    option
        .all_shots()
        .iter()
        .flat_map(|s| &s.marks)
        .any(|m| m.note.is_some() && note_goes_left(m))
}

// ---------------------------------------------------------------- the tour

/// One stop of the tour: what it frames and what stays lit.
#[derive(Clone, Debug, PartialEq)]
pub struct Stop {
    pub rect: Rect,
    pub lit: Lit,
    /// Where the next option's frame starts, for a stop that shows a little
    /// of it at the window's right edge, to say there's more to drag to.
    pub peek: Option<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lit {
    /// Where it opens: the agent's lead and all of the first option, with a
    /// little of the next one showing (Mike, 22 Nov: zoomed in on the lead
    /// alone, nothing said there was more to drag round).
    Start,
    /// An option's name and first picture.
    Opening(usize),
    /// Another of an option's pictures.
    Shot(usize, usize),
    /// Everything, at the end.
    All,
}

impl Lit {
    pub fn option(self) -> Option<usize> {
        match self {
            Lit::Opening(o) | Lit::Shot(o, _) => Some(o),
            Lit::Start | Lit::All => None,
        }
    }

    /// Whether this stop lights an option's picture.
    pub fn shows(self, option: usize, shot: usize) -> bool {
        match self {
            Lit::All | Lit::Start => true,
            Lit::Opening(o) => o == option && shot == 0,
            Lit::Shot(o, s) => o == option && s == shot,
        }
    }

    /// Whether this stop lights an option's words: any of its stops, as
    /// they're under its last picture.
    pub fn shows_words(self, option: usize) -> bool {
        matches!(self, Lit::All | Lit::Start) || self.option() == Some(option)
    }
}

/// The agent's order, as the window always stepped: its lead with the first
/// option, each option's words and pictures in turn, then everything.
pub fn stops(board: &Board) -> Vec<Stop> {
    let mut out = Vec::new();
    if let Some(first) = board.options.first() {
        let rect = board
            .lead
            .map_or(first.extent(), |lead| lead.union(&first.extent()));
        out.push(Stop {
            rect,
            lit: Lit::Start,
            peek: board.options.get(1).map(|o| o.extent().x),
        });
    }
    for option in &board.options {
        let last = option.shots.len().saturating_sub(1);
        for shot in &option.shots {
            let mut rect = shot.extent();
            // The words are under the last picture, so that stop shows them.
            if shot.shot == last {
                if let Some(words) = option.words {
                    rect = rect.union(&words);
                }
            }
            let lit = if shot.shot == 0 {
                rect = rect.union(&option.title);
                Lit::Opening(option.index)
            } else {
                Lit::Shot(option.index, shot.shot)
            };
            out.push(Stop {
                rect,
                lit,
                peek: None,
            });
        }
    }
    out.push(Stop {
        rect: board.bounds,
        lit: Lit::All,
        peek: None,
    });
    out
}

// ---------------------------------------------------------------- the camera

/// Screen = world × s + t.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub s: f32,
    pub tx: f32,
    pub ty: f32,
}

pub const MIN_ZOOM: f32 = 0.05;
pub const MAX_ZOOM: f32 = 3.;
/// The tour and a double-click never zoom past this: a picture's own pixels
/// get soft beyond it, and a short note would fill the window.
pub const STOP_ZOOM: f32 = 1.4;
/// Where the next option's box starts on screen at a stop that peeks at it,
/// as a share of the window's width.
pub const PEEK_AT: f32 = 0.9;

/// How much one turn of a mouse's wheel zooms, given the lines macOS says it
/// moved. A slow notch can come as a fraction of a line, so each event counts
/// as at least one notch; a fast spin counts up to three, so one flick can't
/// fly off the board.
pub fn wheel_zoom(lines: f32) -> f32 {
    if lines == 0. || !lines.is_finite() {
        return 1.;
    }
    (lines.signum() * lines.abs().clamp(1., 3.) * WHEEL_STEP).exp()
}

/// The log of the zoom one wheel notch gives: about 1.2 times.
const WHEEL_STEP: f32 = 0.18;

/// How much a wheel that reports pixels zooms, as Mike's Razer does: macOS
/// sends it as many small events, 1 to 45 pixels each, so they add up rather
/// than each counting as a notch. A notch's 20 pixels or so zoomed 1.2 times
/// at first and Mike found it too fast (23 Nov), so it takes about 80 pixels
/// for that now, and an event is capped at a notch's zoom.
pub fn smooth_wheel_zoom(pixels: f32) -> f32 {
    if !pixels.is_finite() {
        return 1.;
    }
    (pixels.clamp(-80., 80.) * WHEEL_STEP / SMOOTH_WHEEL_PIXELS).exp()
}

/// The pixels a smooth wheel turns for one notch's zoom.
const SMOOTH_WHEEL_PIXELS: f32 = 80.;

impl Default for Camera {
    fn default() -> Self {
        Camera {
            s: 0.4,
            tx: 0.,
            ty: 0.,
        }
    }
}

impl Camera {
    /// The camera that fits `rect` in a viewport `vw` × `vh` with `pad`
    /// round it, no closer than `max`.
    pub fn fit(rect: Rect, vw: f32, vh: f32, pad: f32, max: f32) -> Camera {
        let s = ((vw - pad * 2.) / rect.w.max(1.))
            .min((vh - pad * 2.) / rect.h.max(1.))
            .clamp(MIN_ZOOM, max);
        let (cx, cy) = rect.center();
        Camera {
            s,
            tx: vw / 2. - cx * s,
            ty: vh / 2. - cy * s,
        }
    }

    /// A stop's camera: it fits, and when the stop says where the next
    /// option starts, that sits just in from the right edge, so a little of
    /// it shows.
    pub fn for_stop(stop: &Stop, vw: f32, vh: f32, pad: f32, max: f32) -> Camera {
        let fitted = Camera::fit(stop.rect, vw, vh, pad, max);
        let Some(next) = stop.peek.filter(|&x| x > stop.rect.right()) else {
            return fitted;
        };
        let edge = vw * PEEK_AT;
        let s = fitted
            .s
            .min((edge - pad) / (next - stop.rect.x).max(1.))
            .max(MIN_ZOOM);
        Camera {
            s,
            tx: edge - next * s,
            ty: vh / 2. - stop.rect.center().1 * s,
        }
    }

    pub fn to_screen(&self, (x, y): (f32, f32)) -> (f32, f32) {
        (x * self.s + self.tx, y * self.s + self.ty)
    }

    pub fn rect(&self, r: &Rect) -> Rect {
        let (x, y) = self.to_screen((r.x, r.y));
        Rect::new(x, y, r.w * self.s, r.h * self.s)
    }

    pub fn to_world(&self, (x, y): (f32, f32)) -> (f32, f32) {
        ((x - self.tx) / self.s, (y - self.ty) / self.s)
    }

    /// Zoom by `factor` keeping the point under `at` (screen) still.
    pub fn zoom_at(&self, at: (f32, f32), factor: f32) -> Camera {
        let s = (self.s * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        let k = s / self.s;
        Camera {
            s,
            tx: at.0 - (at.0 - self.tx) * k,
            ty: at.1 - (at.1 - self.ty) * k,
        }
    }

    pub fn pan(&self, dx: f32, dy: f32) -> Camera {
        Camera {
            tx: self.tx + dx,
            ty: self.ty + dy,
            ..*self
        }
    }

    /// Partway from `self` to `to` (k from 0 to 1, already eased), zooming in
    /// even steps and moving the view's centre in a straight line, so a
    /// flight neither lurches nor swings wide.
    pub fn toward(&self, to: &Camera, k: f32, vw: f32, vh: f32) -> Camera {
        let centre = |c: &Camera| ((vw / 2. - c.tx) / c.s, (vh / 2. - c.ty) / c.s);
        let (ax, ay) = centre(self);
        let (bx, by) = centre(to);
        let s = (self.s.ln() + (to.s.ln() - self.s.ln()) * k).exp();
        let (cx, cy) = (ax + (bx - ax) * k, ay + (by - ay) * k);
        Camera {
            s,
            tx: vw / 2. - cx * s,
            ty: vh / 2. - cy * s,
        }
    }
}

/// Ease in and out, for flights.
pub fn ease(k: f32) -> f32 {
    let k = k.clamp(0., 1.);
    if k < 0.5 {
        4. * k * k * k
    } else {
        1. - (-2. * k + 2.).powi(3) / 2.
    }
}

// ---------------------------------------------------------------- doodles

/// A pen stroke: a start and cubic segments (c1, c2, end), all in world units.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Stroke {
    pub start: (f32, f32),
    pub curves: Vec<[(f32, f32); 3]>,
}

impl Stroke {
    /// A smooth stroke through points (Catmull-Rom).
    pub fn through(points: &[(f32, f32)]) -> Stroke {
        let Some(&start) = points.first() else {
            return Stroke::default();
        };
        let mut curves = Vec::new();
        for i in 0..points.len().saturating_sub(1) {
            let p0 = points[i.saturating_sub(1)];
            let p1 = points[i];
            let p2 = points[i + 1];
            let p3 = *points.get(i + 2).unwrap_or(&p2);
            curves.push([
                (p1.0 + (p2.0 - p0.0) / 6., p1.1 + (p2.1 - p0.1) / 6.),
                (p2.0 - (p3.0 - p1.0) / 6., p2.1 - (p3.1 - p1.1) / 6.),
                p2,
            ]);
        }
        Stroke { start, curves }
    }
}

/// A small seeded wobble, so a mark draws the same every time.
struct Wobble(u32);

impl Wobble {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f32) / (u32::MAX as f32)
    }
}

/// A loop drawn round a box, a little more than once round, the ends
/// crossing as a pen's do.
pub fn circle_round(part: &Rect, seed: u32) -> Stroke {
    let mut w = Wobble(seed);
    let (cx, cy) = part.center();
    // Round the box's corners, not through them: an ellipse holds a box
    // when it's √2 times its half-size, plus room for the pen.
    let (rx, ry) = (part.w / 2. * 1.42 + 8., part.h / 2. * 1.42 + 8.);
    let start = -2.2 + w.next() * 0.6;
    let turn = std::f32::consts::TAU * 1.12;
    let n = 22;
    let points: Vec<(f32, f32)> = (0..=n)
        .map(|i| {
            let t = start + turn * i as f32 / n as f32;
            let k = 1. + (w.next() - 0.5) * 0.06 + (i as f32 / n as f32) * 0.05;
            (cx + t.cos() * rx * k, cy + t.sin() * ry * k)
        })
        .collect();
    Stroke::through(&points)
}

/// Two passes under a box's bottom edge, the second a touch lower.
pub fn underline(part: &Rect, seed: u32) -> Vec<Stroke> {
    let mut w = Wobble(seed);
    (0..2)
        .map(|pass| {
            let points: Vec<(f32, f32)> = (0..=6)
                .map(|i| {
                    let f = i as f32 / 6.;
                    (
                        part.x - 6. + (part.w + 18.) * f,
                        part.bottom()
                            + 4.
                            + pass as f32 * 5.
                            + (w.next() - 0.5) * 3.
                            + (f * std::f32::consts::PI).sin() * 2.,
                    )
                })
                .collect();
            Stroke::through(&points)
        })
        .collect()
}

/// The middle line of a marker swipe over a box, a little uphill; it's
/// drawn as thick as the box is tall.
pub fn swipe(part: &Rect) -> Stroke {
    let h = part.h;
    Stroke::through(&[
        (part.x - 6., part.y + h * 0.55 + 2.),
        (part.x + part.w / 2., part.y + h * 0.5),
        (part.right() + 6., part.y + h * 0.45 - 2.),
    ])
}

/// The curled pointer from a note to its mark: a small loop by the note,
/// then a soft run to the spot, as doodle-notes.js draws it.
pub fn curl(from: (f32, f32), to: (f32, f32)) -> Stroke {
    let (sx, sy) = from;
    let (ex, ey) = to;
    let d = if ex < sx { 1. } else { -1. };
    Stroke {
        start: from,
        curves: vec![
            [
                (sx - d * 28., sy - 12.),
                (sx - d * 46., sy + 4.),
                (sx - d * 36., sy + 22.),
            ],
            [
                (sx - d * 24., sy + 40.),
                (sx - d * 10., sy + 17.),
                (sx - d * 32., sy + 15.),
            ],
            [(sx - d * 46., sy + 13.), (ex + d * 40., ey + 10.), to],
        ],
    }
}

/// An open arrowhead at the end of a stroke, its wings angled away from the
/// last stretch so neither disappears into the shaft.
pub fn arrowhead(stroke: &Stroke, size: f32) -> Stroke {
    let Some(last) = stroke.curves.last() else {
        return Stroke::default();
    };
    let end = last[2];
    let from = if last[1] != end { last[1] } else { last[0] };
    let len = ((end.0 - from.0).powi(2) + (end.1 - from.1).powi(2))
        .sqrt()
        .max(0.001);
    let (dx, dy) = ((end.0 - from.0) / len, (end.1 - from.1) / len);
    let (bx, by) = (end.0 - dx * size, end.1 - dy * size);
    let wing = size * 0.56;
    Stroke {
        start: (bx - dy * wing, by + dx * wing),
        curves: vec![
            [(bx - dy * wing, by + dx * wing), end, end],
            [
                end,
                (bx + dy * wing, by - dx * wing),
                (bx + dy * wing, by - dx * wing),
            ],
        ],
    }
}

/// The strokes of one of the agent's marks on a picture, before its pointer.
pub fn agent_strokes(picture: &Rect, mark: &AgentMark, seed: u32) -> Vec<Stroke> {
    let part = picture.part(&mark.bbox);
    match mark.kind {
        MarkKind::Circle => vec![circle_round(&part, seed)],
        MarkKind::Underline => underline(&part, seed),
        MarkKind::Highlight => vec![swipe(&part)],
        MarkKind::Arrow => Vec::new(),
    }
}

/// The pointer from a note to its mark, with its head.
pub fn pointer(note: &NotePlace) -> Vec<Stroke> {
    let mid = note.rect.y + note.rect.h / 2.;
    let from = if note.left {
        (note.rect.right() + 12., mid)
    } else {
        (note.rect.x - 12., mid)
    };
    let shaft = curl(from, note.target);
    let head = arrowhead(&shaft, 16.);
    vec![shaft, head]
}

// ---------------------------------------------------------------- Mike's marks

/// A mark Mike is drawing, in world units, before it's known which picture
/// it's on.
#[derive(Clone, Debug, PartialEq)]
pub struct Drawing {
    pub kind: UserMarkKind,
    pub points: Vec<(f32, f32)>,
}

impl Drawing {
    /// Too small to mean anything: a click with the circle tool.
    pub fn is_scribble(&self) -> bool {
        self.kind != UserMarkKind::Pin && self.points.len() < 3
    }

    /// Where it ends up: the option and shot of the picture under its middle,
    /// the box and stroke as fractions of that picture. None when it isn't on
    /// a picture.
    pub fn to_mark(
        &self,
        board: &Board,
        review: &DesignReview,
        n: u32,
        reach: f32,
    ) -> Option<UserMark> {
        let first = *self.points.first()?;
        let (x0, y0, x1, y1) = self.points.iter().fold(
            (first.0, first.1, first.0, first.1),
            |(a, b, c, d), &(x, y)| (a.min(x), b.min(y), c.max(x), d.max(y)),
        );
        let middle = ((x0 + x1) / 2., (y0 + y1) / 2.);
        let shot = board.shot_at(middle)?;
        let option = review.options.get(shot.option)?;
        if option.reference {
            return None;
        }
        let p = shot.picture;
        let frac = |(x, y): (f32, f32)| {
            [
                f64::from(((x - p.x) / p.w).clamp(0., 1.)),
                f64::from(((y - p.y) / p.h).clamp(0., 1.)),
            ]
        };
        let grow = if self.kind == UserMarkKind::Highlight {
            reach
        } else {
            0.
        };
        let a = frac((x0 - grow, y0 - grow));
        let b = frac((x1 + grow, y1 + grow));
        let mut path: Vec<[f64; 2]> = self.points.iter().map(|&q| frac(q)).collect();
        path.truncate(crate::reducer::REVIEW_MARK_POINTS_MAX);
        Some(UserMark {
            n,
            kind: self.kind,
            option_id: option.id.clone(),
            shot: shot.shot,
            bbox: [a[0], a[1], b[0], b[1]],
            path,
            image: None,
        })
    }
}

/// Where one of Mike's marks is on the board now, from its fractions.
pub fn mark_points(
    board: &Board,
    review: &DesignReview,
    mark: &UserMark,
) -> Option<(Rect, Vec<(f32, f32)>)> {
    let option = review.options.iter().position(|o| o.id == mark.option_id)?;
    let shot = board.shot(option, mark.shot)?;
    let p = shot.picture;
    let points = mark.path.iter().map(|q| p.at(q[0], q[1])).collect();
    Some((p.part(&mark.bbox), points))
}

/// "A · Menu open": the option and the picture a mark is on, for its chip.
pub fn mark_label(review: &DesignReview, mark: &UserMark) -> String {
    let Some(option) = review.options.iter().find(|o| o.id == mark.option_id) else {
        return mark.option_id.clone();
    };
    let shots = option.all_shots();
    match shots.get(mark.shot).and_then(|s| s.title.clone()) {
        Some(title) => format!("{} \u{00B7} {title}", option.id),
        None if shots.len() > 1 => format!("{} \u{00B7} picture {}", option.id, mark.shot + 1),
        None => option.id.clone(),
    }
}

/// The part of a picture a mark's cut-out shows: its box with a margin, in
/// fractions, so the chip shows what's round it too.
pub fn cut_out_box(mark: &UserMark) -> MarkBox {
    let pad = if mark.kind == UserMarkKind::Pin {
        0.08
    } else {
        0.04
    };
    let b = mark.bbox;
    [
        (b[0] - pad).max(0.),
        (b[1] - pad).max(0.),
        (b[2] + pad).min(1.),
        (b[3] + pad).min(1.),
    ]
}

/// The next number for a mark: one more than the highest so far, so a
/// removed mark's number isn't reused for another and a reply's "[Mark 2]"
/// never points somewhere new.
pub fn next_mark_number(marks: &[UserMark]) -> u32 {
    marks.iter().map(|m| m.n).max().unwrap_or(0) + 1
}

/// A reply's words without the markers of marks that are gone.
pub fn drop_mark_marker(reply: &str, n: u32) -> String {
    reply
        .replace(&format!("[Mark {n}] "), "")
        .replace(&format!("[Mark {n}]"), "")
}

/// Room kept round a stop when flying to it, in screen points.
pub const STOP_PAD: f32 = 56.;

/// A highlight stroke's width on the board, for a pen width on screen.
pub fn pen_reach(screen_width: f32, camera: &Camera) -> f32 {
    screen_width / camera.s / 2.
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reducer::{ImageRef, MarkInk, ReviewDraft, ReviewShot};

    #[test]
    fn every_wheel_notch_zooms_a_step_however_small_macos_says_it_was() {
        let notch = wheel_zoom(1.);
        assert!((notch - 1.197).abs() < 0.01, "{notch}");
        assert_eq!(wheel_zoom(0.1), notch);
        assert!((wheel_zoom(-0.05) * notch - 1.).abs() < 1e-5);
        assert_eq!(wheel_zoom(40.), wheel_zoom(3.));
        assert_eq!(wheel_zoom(0.), 1.);
    }

    #[test]
    fn a_smooth_wheel_zooms_by_the_pixels_it_turned() {
        // A typical 20 pixel event zooms about 5%, a slow one a little, and
        // no event more than a notch.
        let typical = smooth_wheel_zoom(20.);
        assert!(typical > 1.03 && typical < 1.07, "{typical}");
        assert!(smooth_wheel_zoom(1.) > 1. && smooth_wheel_zoom(1.) < 1.01);
        assert!((smooth_wheel_zoom(-20.) * typical - 1.).abs() < 1e-5);
        assert_eq!(smooth_wheel_zoom(500.), smooth_wheel_zoom(80.));
        assert!((smooth_wheel_zoom(80.) - wheel_zoom(1.)).abs() < 1e-5);
    }

    fn image(w: i64, h: i64) -> ImageRef {
        ImageRef {
            path: "/tmp/a.png".into(),
            media_type: "image/png".into(),
            width: Some(w),
            height: Some(h),
        }
    }

    fn shot(title: Option<&str>, marks: Vec<AgentMark>) -> ReviewShot {
        ReviewShot {
            title: title.map(str::to_owned),
            image: image(2200, 1520),
            media: None,
            marks,
        }
    }

    fn option(id: &str, note: Option<&str>, shots: Vec<ReviewShot>) -> ReviewOption {
        ReviewOption {
            id: id.into(),
            title: format!("Option {id}"),
            note: note.map(str::to_owned),
            reference: false,
            image: image(2200, 1520),
            shots,
            url: None,
        }
    }

    fn review(note: Option<&str>, options: Vec<ReviewOption>) -> DesignReview {
        DesignReview {
            id: "r1".into(),
            title: "Picker".into(),
            note: note.map(str::to_owned),
            recommended: None,
            options,
            status: "pending".into(),
            revision: 1,
            created_at: String::new(),
            updated_at: String::new(),
            draft: ReviewDraft::default(),
            response: None,
            reply_turn_id: None,
        }
    }

    fn circle(b: MarkBox, note: &str) -> AgentMark {
        AgentMark {
            kind: MarkKind::Circle,
            bbox: b,
            note: Some(note.into()),
            ink: MarkInk::Yellow,
        }
    }

    #[test]
    fn html_header_stays_clear_of_content_captions_and_titles_at_every_supported_scale() {
        let mut page = shot(None, vec![]);
        page.media = Some(ImageRef {
            path: "/tmp/index.html".into(),
            media_type: "text/html".into(),
            width: None,
            height: None,
        });
        let mut titled = page.clone();
        titled.title = Some("A second HTML state".into());
        let r = review(None, vec![option("A", None, vec![page, titled])]);
        let laid = layout(&r, &Guess);
        for scale in [0.25, 0.4, 0.6, 1., 1.4] {
            let cam = Camera {
                s: scale,
                tx: 80.,
                ty: 200.,
            };
            for shot in &laid.options[0].shots {
                let picture = cam.rect(&shot.picture);
                let header = html_control_rect(picture).unwrap();
                assert_eq!(header.right(), picture.right());
                assert_eq!(header.x, picture.x);
                assert!(header.bottom() <= picture.y - 6.);
                assert_eq!(shot.picture.y - shot.caption.bottom(), SHOT_GAP);
                for mut label in [cam.rect(&shot.caption), cam.rect(&laid.options[0].title)] {
                    if label == cam.rect(&laid.options[0].title) {
                        label.h = label.h.max(12. * 1.4);
                    }
                    let width = html_label_width(label, picture);
                    if label.y < header.bottom() && label.bottom() > header.y {
                        assert!(label.x + width <= header.right() - HTML_PILL_WIDTH);
                    } else {
                        assert_eq!(width, label.w);
                    }
                }
                // The slot depends only on this card; stale window widths,
                // first-frame defaults, and resize frames cannot move it.
                assert_eq!(html_control_rect(picture), Some(header));
            }
        }
        assert!(html_control_rect(Rect::new(20., 100., 159., 100.)).is_none());
        assert!(html_control_rect(Rect::new(20., 83., 210., 100.)).is_none());
    }

    #[test]
    fn options_sit_left_to_right_after_the_lead_without_overlapping() {
        let r = review(
            Some("Three ways to do it."),
            vec![
                option(
                    "A",
                    Some("Keep the menu."),
                    vec![shot(Some("Open"), vec![]), shot(None, vec![])],
                ),
                option("B", None, vec![]),
                option("C", Some("Pools."), vec![]),
            ],
        );
        let board = layout(&r, &Guess);
        let lead = board.lead.expect("a lead");
        assert_eq!((lead.x, lead.y), (0., 0.));
        let frames: Vec<Rect> = board.options.iter().map(|o| o.frame).collect();
        assert!(frames[0].x > lead.right());
        for pair in frames.windows(2) {
            assert!(pair[1].x >= pair[0].right() + GUTTER);
        }
        // Each option's halo holds its column, and no two touch; its name is
        // on top and its words at the bottom.
        let halos: Vec<Rect> = board.options.iter().map(|o| o.halo).collect();
        assert!(halos[0].x > lead.right());
        for pair in halos.windows(2) {
            assert!(pair[1].x > pair[0].right() + 20., "{pair:?}");
        }
        for o in &board.options {
            assert!(
                o.halo.contains((o.frame.x, o.frame.y))
                    && o.halo.contains((o.frame.right(), o.frame.bottom()))
            );
            assert!(o.title.bottom() <= o.shots[0].picture.y && o.title.y >= o.frame.y);
            // The letter stands on the first picture's top right corner, with
            // only its feet behind it: Mike found half of it hidden too much.
            let first = o.shots[0].picture;
            assert!(o.letter.contains((first.right() - 1., first.y + 1.)));
            assert!(o.letter.x < first.right());
            assert!(first.y - o.letter.y >= o.letter.h * 0.8, "{o:?}");
        }
        // An option without shots shows its one image; with two, both, one
        // under the other, each with its name over it.
        assert_eq!(board.options[1].shots.len(), 1);
        assert_eq!(board.options[1].shots[0].caption.h, 0.);
        let a = &board.options[0];
        assert!(a.shots[0].caption.bottom() <= a.shots[0].picture.y);
        assert!(a.shots[1].caption.y > a.shots[0].picture.bottom());
        assert!(a.shots[1].caption.h > 0. && a.shots[1].caption.bottom() <= a.shots[1].picture.y);
        assert!(a.words.unwrap().y > a.shots[1].picture.bottom());
        assert!(board.options[1].words.is_none());
        // The bounds hold every frame and the lead.
        for f in &frames {
            assert!(
                board.bounds.contains((f.x, f.y)) && board.bounds.contains((f.right(), f.bottom()))
            );
        }
    }

    #[test]
    fn a_picture_keeps_its_shape() {
        let r = review(None, vec![option("A", None, vec![])]);
        let p = layout(&r, &Guess).options[0].shots[0].picture;
        assert_eq!(p.w, PICTURE_WIDTH);
        assert!((p.w / p.h - 2200. / 1520.).abs() < 0.01);
    }

    #[test]
    fn notes_sit_right_of_their_picture_level_with_their_mark_and_never_overlap() {
        let marks = vec![
            circle(
                [0.4, 0.14, 0.76, 0.23],
                "auto picks the login with the most room",
            ),
            circle([0.4, 0.15, 0.7, 0.2], "and this"),
            AgentMark {
                kind: MarkKind::Underline,
                bbox: [0.39, 0.89, 0.45, 0.9],
                note: None,
                ink: MarkInk::Rose,
            },
        ];
        let r = review(None, vec![option("A", None, vec![shot(None, marks)])]);
        let board = layout(&r, &Guess);
        let s = &board.options[0].shots[0];
        assert_eq!(s.notes.len(), 2, "the underline has no note");
        for n in &s.notes {
            assert_eq!(n.rect.x, s.picture.right() + NOTE_GAP);
        }
        let (a, b) = (&s.notes[0].rect, &s.notes[1].rect);
        assert!(
            a.bottom() <= b.y || b.bottom() <= a.y,
            "notes overlap: {a:?} {b:?}"
        );
        // The board's bounds take the notes in.
        assert!(board.bounds.right() >= a.right());
    }

    #[test]
    fn a_later_page_gets_its_own_notes_outside_the_halo() {
        // Mike, 23 Nov: the agent can point things out on any page, not just
        // the first.
        let r = review(
            None,
            vec![option(
                "A",
                Some("Two pages."),
                vec![
                    shot(Some("Menu"), vec![]),
                    shot(
                        Some("Spread"),
                        vec![circle([0.6, 0.5, 0.8, 0.7], "the spread")],
                    ),
                ],
            )],
        );
        let board = layout(&r, &Guess);
        let o = &board.options[0];
        assert!(o.shots[0].notes.is_empty());
        let page = &o.shots[1];
        let note = page.notes.first().expect("a note on the second page").rect;
        assert!(
            note.y >= page.picture.y - note.h && note.bottom() <= page.picture.bottom() + note.h
        );
        assert!(
            note.x >= o.halo.right(),
            "the note is inside the halo: {note:?}"
        );
        assert!(board.bounds.right() >= note.right());
    }

    #[test]
    fn a_note_for_a_mark_on_the_left_sits_left_of_its_picture_with_room_for_it() {
        let marks = vec![
            circle([0.0, 0.06, 0.04, 0.43], "every tool its own place"),
            circle([0.25, 0.07, 0.8, 0.52], "the whole book at once"),
        ];
        let r = review(
            None,
            vec![
                option("A", None, vec![]),
                option("B", None, vec![shot(None, marks)]),
            ],
        );
        let board = layout(&r, &Guess);
        let s = &board.options[1].shots[0];
        let (left, right) = (&s.notes[0], &s.notes[1]);
        assert!(left.left && left.rect.right() < s.picture.x, "{left:?}");
        assert!(!right.left && right.rect.x > s.picture.right());
        // It doesn't reach back into the frame before.
        assert!(left.rect.x > board.options[0].extent().right());
        // Its pointer starts on its right and ends on the circle's left.
        let shaft = &pointer(left)[0];
        assert!(shaft.start.0 > left.rect.right());
        assert!(left.target.0 < s.picture.part(&r.options[1].shots[0].marks[0].bbox).x);
    }

    #[test]
    fn the_tour_goes_lead_then_each_option_shot_by_shot_then_everything() {
        let r = review(
            Some("Lead"),
            vec![
                option(
                    "A",
                    Some("Words"),
                    vec![shot(None, vec![]), shot(None, vec![])],
                ),
                option("B", None, vec![]),
            ],
        );
        let board = layout(&r, &Guess);
        let lits: Vec<Lit> = stops(&board).iter().map(|s| s.lit).collect();
        assert_eq!(
            lits,
            vec![
                Lit::Start,
                Lit::Opening(0),
                Lit::Shot(0, 1),
                Lit::Opening(1),
                Lit::All
            ]
        );
        // It starts on the lead and all of A, B peeking in at the right.
        let start = &stops(&board)[0];
        assert!(start.rect.x <= board.lead.unwrap().x);
        assert!(start.rect.right() >= board.options[0].halo.right());
        assert_eq!(start.peek, Some(board.options[1].extent().x));
        let c = Camera::for_stop(start, 1500., 900., 40., STOP_ZOOM);
        let (bx, _) = c.to_screen((board.options[1].extent().x, 0.));
        assert!((bx - 1500. * PEEK_AT).abs() < 0.5, "B starts at {bx}");
        let (ax, _) = c.to_screen((start.rect.x, 0.));
        assert!(ax >= 39.5, "the lead's cut off at {ax}");
        let opening = &stops(&board)[1];
        assert!(opening.rect.y <= board.options[0].title.y);
        assert!(Lit::Opening(0).shows(0, 0) && !Lit::Opening(0).shows(0, 1));
        assert!(Lit::All.shows(1, 0) && Lit::All.shows_words(0));
    }

    #[test]
    fn the_camera_fits_a_rect_and_zooms_round_the_pointer() {
        let r = Rect::new(100., 50., 800., 400.);
        let c = Camera::fit(r, 1000., 600., 50., 3.);
        let tl = c.to_screen((r.x, r.y));
        let br = c.to_screen((r.right(), r.bottom()));
        assert!((tl.0 - 50.).abs() < 0.01 && (br.0 - 950.).abs() < 0.01);
        assert!(tl.1 >= 49.99 && br.1 <= 550.01);
        // Never closer than asked.
        assert_eq!(
            Camera::fit(Rect::new(0., 0., 10., 10.), 1000., 600., 0., STOP_ZOOM).s,
            STOP_ZOOM
        );
        // The world point under the pointer stays put.
        let at = (300., 200.);
        let before = c.to_world(at);
        let z = c.zoom_at(at, 1.7);
        let after = z.to_world(at);
        assert!((before.0 - after.0).abs() < 0.01 && (before.1 - after.1).abs() < 0.01);
        assert!(c.zoom_at(at, 1000.).s <= MAX_ZOOM);
    }

    #[test]
    fn a_flight_starts_and_ends_where_it_should() {
        let a = Camera {
            s: 0.4,
            tx: 10.,
            ty: 20.,
        };
        let b = Camera {
            s: 1.2,
            tx: -300.,
            ty: 40.,
        };
        let start = a.toward(&b, 0., 1000., 600.);
        let end = a.toward(&b, 1., 1000., 600.);
        assert!((start.s - a.s).abs() < 1e-4 && (start.tx - a.tx).abs() < 0.01);
        assert!(
            (end.s - b.s).abs() < 1e-4
                && (end.tx - b.tx).abs() < 0.01
                && (end.ty - b.ty).abs() < 0.01
        );
        assert_eq!(ease(0.), 0.);
        assert_eq!(ease(1.), 1.);
        assert!(ease(0.25) < 0.25 && ease(0.75) > 0.75);
    }

    #[test]
    fn a_circle_goes_round_its_box_and_draws_the_same_each_time() {
        let part = Rect::new(100., 100., 200., 60.);
        let a = circle_round(&part, 7);
        assert_eq!(a, circle_round(&part, 7));
        assert_ne!(a, circle_round(&part, 8));
        for c in &a.curves {
            let (x, y) = c[2];
            assert!(
                x < part.x - 4.
                    || x > part.right() + 4.
                    || y < part.y - 4.
                    || y > part.bottom() + 4.,
                "a point on the loop sits inside the box: {x},{y}"
            );
        }
    }

    #[test]
    fn the_pointer_ends_at_its_mark_with_a_head() {
        let note = NotePlace {
            mark: 0,
            rect: Rect::new(800., 100., 200., 40.),
            target: (650., 140.),
            left: false,
        };
        let strokes = pointer(&note);
        assert_eq!(strokes[0].curves.last().unwrap()[2], note.target);
        // Both wings of the head meet at the target.
        let head = &strokes[1];
        assert_eq!(head.curves[0][2], note.target);
        assert_eq!(head.curves[1][0], note.target);
    }

    #[test]
    fn a_drawn_mark_lands_on_the_picture_under_it_as_fractions() {
        let r = review(
            None,
            vec![option(
                "A",
                None,
                vec![shot(None, vec![]), shot(Some("Open"), vec![])],
            )],
        );
        let board = layout(&r, &Guess);
        let p = board.options[0].shots[1].picture;
        let d = Drawing {
            kind: UserMarkKind::Circle,
            points: vec![p.at(0.2, 0.2), p.at(0.4, 0.25), p.at(0.3, 0.4)],
        };
        let mark = d.to_mark(&board, &r, 3, 0.).expect("on a picture");
        assert_eq!((mark.option_id.as_str(), mark.shot, mark.n), ("A", 1, 3));
        let b = mark.bbox;
        assert!((b[0] - 0.2).abs() < 1e-3 && (b[3] - 0.4).abs() < 1e-3);
        assert_eq!(mark.path.len(), 3);
        assert_eq!(mark_label(&r, &mark), "A \u{00B7} Open");
        // Back on the board where it was drawn.
        let (_, points) = mark_points(&board, &r, &mark).unwrap();
        assert!((points[1].0 - d.points[1].0).abs() < 0.5);
        // Off every picture, it's nothing.
        let off = Drawing {
            kind: UserMarkKind::Pin,
            points: vec![(-500., -500.)],
        };
        assert!(off.to_mark(&board, &r, 4, 0.).is_none());
        assert!(Drawing {
            kind: UserMarkKind::Circle,
            points: vec![(0., 0.)]
        }
        .is_scribble());
    }

    #[test]
    fn a_reference_option_takes_no_marks() {
        let mut today = option("Today", None, vec![]);
        today.reference = true;
        let r = review(None, vec![today]);
        let board = layout(&r, &Guess);
        let p = board.options[0].shots[0].picture;
        let d = Drawing {
            kind: UserMarkKind::Pin,
            points: vec![p.center()],
        };
        assert!(d.to_mark(&board, &r, 1, 0.).is_none());
    }

    #[test]
    fn mark_numbers_only_go_up_and_a_removed_one_leaves_the_reply() {
        let m = |n| UserMark {
            n,
            kind: UserMarkKind::Pin,
            option_id: "A".into(),
            shot: 0,
            bbox: [0.1, 0.1, 0.1, 0.1],
            path: vec![[0.1, 0.1]],
            image: None,
        };
        assert_eq!(next_mark_number(&[]), 1);
        assert_eq!(next_mark_number(&[m(1), m(3)]), 4);
        assert_eq!(
            drop_mark_marker("[Mark 1] bigger, and [Mark 3] gone", 3),
            "[Mark 1] bigger, and gone"
        );
        let cut = cut_out_box(&m(1));
        assert!(cut[0] < 0.1 && cut[2] > 0.1);
    }
}

/// One media card on a comparison board. Stopping discards its runtime;
/// activating another always replaces the previous card.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Playback {
    #[default]
    Static,
    Playing(usize, usize),
}

impl Playback {
    pub fn active(self) -> Option<(usize, usize)> {
        match self {
            Self::Static => None,
            Self::Playing(o, s) => Some((o, s)),
        }
    }

    pub fn activate(&mut self, at: (usize, usize)) {
        *self = Self::Playing(at.0, at.1);
    }
    pub fn stop(&mut self) {
        *self = Self::Static;
    }
}

/// A native overlay must fit wholly below the tools and above the band.
/// Reserve room above it for Stop so that the page cannot cover its exit.
pub fn live_fits(r: Rect, view: (f32, f32)) -> bool {
    [r.x, r.y, r.w, r.h, view.0, view.1]
        .iter()
        .all(|n| n.is_finite())
        && r.x >= 0.
        && r.y >= 86.
        && r.right() <= view.0
        && r.bottom() <= view.1
        && r.w >= HTML_MIN_LIVE_WIDTH
        && r.h >= 64.
}

#[cfg(test)]
mod playback_tests {
    use super::*;

    #[test]
    fn activating_another_card_replaces_the_first_and_stop_returns_to_static() {
        let mut state = Playback::default();
        assert_eq!(state.active(), None);
        state.activate((0, 1));
        assert_eq!(state.active(), Some((0, 1)));
        state.activate((2, 0));
        assert_eq!(state.active(), Some((2, 0)));
        state.stop();
        assert_eq!(state, Playback::Static);
    }

    #[test]
    fn live_bounds_reserve_tools_stop_and_band_and_reject_clipped_or_tiny_cards() {
        let fits = Rect::new(10., 100., 300., 200.);
        assert!(live_fits(fits, (800., 600.)));
        assert!(live_fits(
            Rect::new(10., 100., HTML_MIN_LIVE_WIDTH, 200.),
            (800., 600.)
        ));
        for r in [
            Rect::new(10., 100., 255., 200.),
            Rect::new(10., 100., 160., 200.),
            Rect::new(-1., 100., 300., 200.),
            Rect::new(10., 85., 300., 200.),
            Rect::new(501., 100., 300., 200.),
            Rect::new(10., 401., 300., 200.),
            Rect::new(10., 100., 159., 200.),
            Rect::new(10., 100., 300., 63.),
            Rect::new(f32::NAN, 100., 300., 200.),
        ] {
            assert!(!live_fits(r, (800., 600.)), "{r:?}");
        }
    }
}
