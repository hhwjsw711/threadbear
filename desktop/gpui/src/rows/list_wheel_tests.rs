// A smooth-scrolling mouse's glide (Mikey Mouse turns each wheel notch into
// phaseless pixel packets at 120 Hz, easing out) run into the transcript's top
// and bottom: it stops there, with no rubber band to sit out.
use gpui_kit::prelude::*;
use gpui_kit::test::{TestEventExt as _, TestWindowExt as _};
use gpui_kit::{
    base, canvas, div, list, point, px, size, AnyView, AppContext as _, Bounds, Context, Entity,
    FollowMode, InputEvent as _, IntoElement, ListAlignment, ListOffset, ListState, Modifiers,
    Point, Render, ScrollDelta, ScrollEvent, ScrollSource, StyleRefinement, TestAppContext,
    TouchPhase, Window, WindowBounds, WindowOptions,
};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::time::Duration;

const ROW: f32 = 100.;
const ROWS: usize = 20;

struct View {
    list: ListState,
    seen: Rc<RefCell<BTreeMap<usize, f32>>>,
    /// The edge bounce, on as on a Mac; off as on Windows and Linux.
    bounce: bool,
}

impl Render for View {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let seen = self.seen.clone();
        let weak = cx.weak_entity();
        let rows = list(self.list.clone(), move |ix, _, _| {
            let seen = seen.clone();
            div()
                .w_full()
                .h(px(ROW))
                .child(
                    canvas(
                        move |bounds, _, _| {
                            seen.borrow_mut().insert(ix, bounds.origin.y.as_f32());
                        },
                        |_, _, _, _| {},
                    )
                    .size_full(),
                )
                .into_any_element()
        })
        .size_full();
        // Bouncing on, as on a Mac, so the tests mean the same everywhere,
        // and the wheel eased, as the transcript has it (list.rs).
        div().size_full().child(
            base::ScrollBounce::new("bounce", &self.list, rows)
                .enabled(self.bounce)
                .smooth_wheel(true)
                // Notifying, as the transcript's does (list.rs).
                .on_scroll(move |_, cx| {
                    let _ = weak.update(cx, |_, cx| cx.notify());
                }),
        )
    }
}

/// Mikey Mouse's ScrollAnimator, one axis, at its default settings.
#[derive(Default)]
struct Glide {
    remaining: f64,
    carry: f64,
    direction: i32,
    last_tick: Option<f64>,
    smoothed: Option<f64>,
}

impl Glide {
    const PER_TICK: f64 = 64.;
    const TAU: f64 = 0.1;

    fn tick(&mut self, direction: i32, at: f64) {
        if direction != self.direction {
            *self = Glide::default();
            self.direction = direction;
        }
        if let Some(last) = self.last_tick {
            let interval = (at - last).max(0.);
            self.smoothed = if interval > 0.25 {
                None
            } else {
                Some(self.smoothed.map_or(interval, |s| (s + interval) / 2.))
            };
        }
        self.last_tick = Some(at);
        let boost = match self.smoothed {
            Some(i) if i < 0.125 => (1. + 0.5 * (0.125 / i.max(0.001) - 1.)).min(5.),
            _ => 1.,
        };
        self.remaining += direction as f64 * Self::PER_TICK * boost;
    }

    fn advance(&mut self, dt: f64) -> i32 {
        if self.remaining == 0. && self.carry == 0. {
            return 0;
        }
        let fraction = 1. - (-dt / Self::TAU).exp();
        let mut step = self.remaining * fraction;
        if (self.remaining - step).abs() < 0.5 {
            step = self.remaining;
        }
        self.remaining -= step;
        self.carry += step;
        if self.remaining == 0. {
            let whole = self.carry.round();
            self.carry = 0.;
            whole as i32
        } else {
            let whole = self.carry.trunc();
            self.carry -= whole;
            whole as i32
        }
    }
}

/// Plays `ticks` (seconds, +1 a notch toward the top) through the transcript's
/// list and bounce at 120 Hz, starting `start` px down (at the end if `None`),
/// and returns how far the content's top was painted each frame.
fn play(
    cx: &mut TestAppContext,
    start: Option<f32>,
    ticks: &[(f64, i32)],
    seconds: f64,
) -> Vec<f32> {
    let mut glide = Glide::default();
    let mut next = 0;
    packets(cx, start, seconds, |t| {
        while next < ticks.len() && ticks[next].0 <= t {
            glide.tick(ticks[next].1, t);
            next += 1;
        }
        glide.advance(1. / 120.)
    })
}

/// Sends `delta(t)` px each 120 Hz frame, as `play` does.
fn packets(
    cx: &mut TestAppContext,
    start: Option<f32>,
    seconds: f64,
    mut delta: impl FnMut(f64) -> i32,
) -> Vec<f32> {
    wheel(cx, start, seconds, |t| {
        let dy = delta(t);
        (dy != 0).then(|| ScrollDelta::Pixels(point(px(0.), px(dy as f32))))
    })
}

/// Sends the wheel event `delta(t)` gives, if any, before each 120 Hz frame,
/// and returns how far the content's top was painted each frame.
fn wheel(
    cx: &mut TestAppContext,
    start: Option<f32>,
    seconds: f64,
    delta: impl FnMut(f64) -> Option<ScrollDelta>,
) -> Vec<f32> {
    wheel_with(cx, start, seconds, true, delta, |_, _| {})
}

/// `wheel`, with the bounce on or off, and `between(frame, list)` run before
/// each frame's event.
fn wheel_with(
    cx: &mut TestAppContext,
    start: Option<f32>,
    seconds: f64,
    bounce: bool,
    mut delta: impl FnMut(f64) -> Option<ScrollDelta>,
    mut between: impl FnMut(u32, &ListState),
) -> Vec<f32> {
    cx.update(gpui_kit::init);
    let seen = Rc::new(RefCell::new(BTreeMap::new()));
    let list = ListState::new(ROWS, ListAlignment::Top, px(600.));
    list.set_follow_mode(FollowMode::Tail);
    let window = cx.update(|cx| {
        let bounds = Bounds {
            origin: Point::default(),
            size: size(px(400.), px(600.)),
        };
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            ..Default::default()
        };
        let (list, seen) = (list.clone(), seen.clone());
        gpui_kit::open_window(options, cx, move |_, cx| {
            cx.new(|_| View { list, seen, bounce })
        })
        .expect("a test window")
        .0
    });
    let draw = |cx: &mut TestAppContext| {
        cx.update_window(window, |_, window, cx| window.render_frame(cx))
            .expect("the window");
    };
    draw(cx);
    if let Some(start) = start {
        list.scroll_to(ListOffset {
            item_ix: (start / ROW) as usize,
            offset_in_item: px(start % ROW),
        });
        draw(cx);
    }
    let frame = 1. / 120.;
    let mut painted = Vec::new();
    for n in 0..(seconds * 120.).round() as u32 {
        let t = f64::from(n) / 120.;
        between(n, &list);
        let delta = delta(t);
        cx.executor().advance_clock(Duration::from_secs_f64(frame));
        cx.update_window(window, |_, window, cx| {
            if let Some(delta) = delta {
                let event = ScrollEvent {
                    position: point(px(200.), px(300.)),
                    delta,
                    modifiers: Modifiers::default(),
                    touch_phase: TouchPhase::Moved,
                    source: ScrollSource::Wheel,
                };
                window.dispatch_event(event.to_platform_input(), cx);
            }
            seen.borrow_mut().clear();
            window.render_frame(cx);
        })
        .expect("the window");
        let top = seen
            .borrow()
            .iter()
            .next()
            .map(|(&ix, &y)| y - ix as f32 * ROW);
        painted.push(top.expect("rows on screen"));
    }
    painted
}

/// The furthest end the content can be painted at: its top at 0, or its
/// bottom at the window's.
const END: f32 = -(ROWS as f32 * ROW - 600.);

#[gpui_kit::test]
fn a_mouse_wheel_stops_dead_at_the_bottom_and_leaves_it_at_once(cx: &mut TestAppContext) {
    // Already at the bottom: two notches down, then one up.
    let painted = play(cx, None, &[(0., -1), (0.08, -1), (0.4, 1)], 0.6);
    let (pushing, leaving) = painted.split_at(48);
    assert!(
        pushing.iter().all(|&top| top == END),
        "the rows never go past the bottom or ease back to it: {pushing:?}"
    );
    assert!(
        leaving[0] > END,
        "the first packet up moves the rows: {leaving:?}"
    );
    assert!(
        leaving.windows(2).all(|w| w[1] >= w[0]),
        "only ever up: {leaving:?}"
    );
}

#[gpui_kit::test]
fn a_mouse_wheel_glides_into_the_top_and_stops_there(cx: &mut TestAppContext) {
    // 150 px down, four quick notches up: the glide runs into the top.
    let painted = play(
        cx,
        Some(150.),
        &[(0., 1), (0.05, 1), (0.1, 1), (0.15, 1)],
        0.8,
    );
    assert!(
        painted.iter().all(|&top| top <= 0.),
        "never past the top: {painted:?}"
    );
    assert!(
        painted.windows(2).all(|w| w[1] >= w[0]),
        "never back: {painted:?}"
    );
    assert_eq!(painted.last(), Some(&0.));
}

#[gpui_kit::test]
fn a_slow_wheel_leaves_the_bottom_a_pixel_at_a_time(cx: &mut TestAppContext) {
    // A slow turn of a fine wheel: 1 px up a frame from the end. Each used to
    // count as still at the end, so the list took it back.
    let painted = packets(cx, None, 0.1, |_| 1);
    assert_eq!(painted.first(), Some(&(END + 1.)), "{painted:?}");
    assert_eq!(painted.last(), Some(&(END + 12.)), "{painted:?}");
}

/// One notch of Mike's Razer, as macOS reports it (logged on his Mac, 23 Nov):
/// a single precise scroll with no gesture phase, here 21 px toward the top.
fn razer_notch(dy: f32) -> Option<ScrollDelta> {
    Some(ScrollDelta::Pixels(point(px(0.), px(dy))))
}

/// The most a frame moved, and the frames it took to stop.
fn motion(painted: &[f32], from: f32) -> (f32, usize) {
    let mut last = from;
    let mut biggest: f32 = 0.;
    let mut moving = 0;
    for (n, &top) in painted.iter().enumerate() {
        biggest = biggest.max((top - last).abs());
        if top != last {
            moving = n + 1;
        }
        last = top;
    }
    (biggest, moving)
}

#[gpui_kit::test]
fn one_wheel_notch_eases_up_from_the_bottom_instead_of_jumping(cx: &mut TestAppContext) {
    // Idle at the end, one notch up. It used to move all 21 px in the first
    // frame (Mike, 27 Nov: "a single small notch still makes it jump").
    let painted = wheel(
        cx,
        None,
        0.4,
        |t| if t == 0. { razer_notch(21.) } else { None },
    );
    let (biggest, frames) = motion(&painted, END);
    assert!(
        painted[0] > END,
        "the first frame already moves: {painted:?}"
    );
    assert!(
        biggest <= 5.,
        "no frame moves much of the notch: {painted:?}"
    );
    assert!(
        painted.windows(2).all(|w| w[1] >= w[0]),
        "only ever up: {painted:?}"
    );
    assert!(
        frames > 4 && frames <= 24,
        "eases over a few frames, about a tenth of a second: {frames} {painted:?}"
    );
    let landed = painted.last().copied().unwrap_or_default();
    assert!(
        (landed - (END + 21.)).abs() < 0.01,
        "lands exactly the notch away: {painted:?}"
    );
}

/// A slow turn of Mike's Razer down, as macOS delivered it on his Mac (27 Nov):
/// ms after the first event, and px. Phaseless precise scrolls about 30 times
/// a second, the first ones big, tailing off.
const RAZER_TURN: [(f64, f32); 18] = [
    (0., -22.),
    (33., -12.),
    (67., -32.),
    (100., -22.),
    (137., -19.),
    (146., -4.),
    (161., -5.),
    (176., -4.),
    (200., -6.),
    (235., -5.),
    (271., -6.),
    (293., -2.),
    (317., -1.),
    (350., -2.),
    (385., -2.),
    (434., -1.),
    (489., -1.),
    (602., -1.),
];

#[gpui_kit::test]
fn a_real_wheel_turn_moves_steadily_not_in_jumps(cx: &mut TestAppContext) {
    // Each event used to land whole in one frame: 22 px, three frames still,
    // 12 px, four still, 32 px... on a 120 Hz screen.
    let mut next = 0;
    let painted = wheel(cx, Some(800.), 1.0, |t| {
        let mut dy = 0.;
        while next < RAZER_TURN.len() && RAZER_TURN[next].0 / 1000. <= t + 1e-9 {
            dy += RAZER_TURN[next].1;
            next += 1;
        }
        (dy != 0.).then(|| ScrollDelta::Pixels(point(px(0.), px(dy))))
    });
    let (biggest, _) = motion(&painted, -800.);
    assert!(biggest <= 8., "no frame jumps: {painted:?}");
    // Through the busy first quarter second, every frame moves.
    let mut last = -800.;
    for (n, &top) in painted.iter().take(30).enumerate() {
        assert!(top < last, "frame {n} stood still: {painted:?}");
        last = top;
    }
    assert!(
        painted.windows(2).all(|w| w[1] <= w[0]),
        "only ever down: {painted:?}"
    );
    let total: f32 = RAZER_TURN.iter().map(|e| e.1).sum();
    let landed = painted.last().copied().unwrap_or_default();
    assert!(
        (landed - (-800. + total)).abs() < 0.01,
        "lands where the wheel said: {painted:?}"
    );
}

#[gpui_kit::test]
fn one_line_notch_eases_down_mid_thread(cx: &mut TestAppContext) {
    // A wheel that counts in lines, mid-thread, one notch down.
    let painted = wheel(cx, Some(800.), 0.4, |t| {
        (t == 0.).then(|| ScrollDelta::Lines(point(0., -1.)))
    });
    let (biggest, frames) = motion(&painted, -800.);
    let landed = *painted.last().expect("frames");
    assert!(landed < -800., "it scrolled down: {painted:?}");
    assert!(
        biggest < -800. - landed,
        "over more than one frame: {painted:?}"
    );
    assert!(frames > 2, "{painted:?}");
    assert!(
        painted.windows(2).all(|w| w[1] <= w[0]),
        "only ever down: {painted:?}"
    );
}

#[gpui_kit::test]
fn a_notch_into_the_bottom_never_moves(cx: &mut TestAppContext) {
    let painted = wheel(cx, None, 0.2, |t| {
        if t == 0. {
            razer_notch(-30.)
        } else {
            None
        }
    });
    assert!(painted.iter().all(|&top| top == END), "{painted:?}");
}

#[gpui_kit::test]
fn turning_the_wheel_back_stops_the_glide_at_once(cx: &mut TestAppContext) {
    // A big notch up, then one back down two frames later: nothing more of
    // the first is left to carry the rows up.
    let painted = wheel(cx, Some(800.), 0.4, |t| match (t * 120.).round() as u32 {
        0 => razer_notch(44.),
        2 => razer_notch(-1.),
        _ => None,
    });
    let turned = painted[1];
    assert!(turned > -800., "{painted:?}");
    assert!(
        painted[2..].iter().all(|&top| top <= turned),
        "never further up after turning back: {painted:?}"
    );
}

#[gpui_kit::test]
fn the_wheel_glides_where_nothing_bounces(cx: &mut TestAppContext) {
    // Windows and Linux have no edge bounce. The glide used to be wiped with
    // the bounce's state each frame there, so the wheel did nothing at all.
    let painted = wheel_with(
        cx,
        None,
        0.4,
        false,
        |t| if t == 0. { razer_notch(21.) } else { None },
        |_, _| {},
    );
    assert!(painted[0] > END, "{painted:?}");
    let landed = painted.last().copied().unwrap_or_default();
    assert!((landed - (END + 21.)).abs() < 0.01, "{painted:?}");
}

#[gpui_kit::test]
fn a_jump_to_the_end_mid_glide_ends_the_glide(cx: &mut TestAppContext) {
    // A notch up, then sending a message jumps back to the end and follows
    // new lines (thread.rs). What was left of the notch used to carry the
    // view up again and stop it following.
    let followed = Rc::new(Cell::new(false));
    let painted = wheel_with(
        cx,
        None,
        0.4,
        true,
        |t| if t == 0. { razer_notch(44.) } else { None },
        {
            let followed = followed.clone();
            move |n, list| {
                if n == 3 {
                    list.set_follow_mode(FollowMode::Tail);
                    list.scroll_to_end();
                }
                if n > 3 {
                    followed.set(list.is_following_tail());
                }
            }
        },
    );
    assert!(painted[2] > END, "it was gliding up: {painted:?}");
    assert!(
        painted[3..].iter().all(|&top| top == END),
        "and stays at the end after the jump: {painted:?}"
    );
    assert!(followed.get(), "still following new lines");
}

/// Window root mirroring how the app nests the transcript: a cached main panel
/// holding the thread pane (`View`), which holds the bounce and list. While
/// `peek` is enabled, the root reads `pane` before `panel` renders, matching an
/// earlier render in the same frame reading a cached view's child entity.
struct Root {
    pane: Entity<View>,
    panel: Entity<Panel>,
    peek: Rc<Cell<bool>>,
}

impl Render for Root {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.peek.get() {
            let _ = self.pane.read(cx);
        }
        div()
            .size_full()
            .child(AnyView::from(self.panel.clone()).cached(StyleRefinement::default().size_full()))
    }
}

struct Panel {
    pane: Entity<View>,
}

impl Render for Panel {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.pane.clone())
    }
}

#[gpui_kit::test]
fn after_an_idle_pause_the_first_trackpad_packet_moves_a_cached_transcript(
    cx: &mut TestAppContext,
) {
    // The cached panel last rendered in a frame where `pane` had already been
    // read earlier. It still owns and renders `pane`, so `pane`'s notify must
    // still invalidate the window once the earlier read stops.
    cx.update(gpui_kit::init);
    let seen = Rc::new(RefCell::new(BTreeMap::new()));
    let peek = Rc::new(Cell::new(true));
    let list = ListState::new(ROWS, ListAlignment::Top, px(600.));
    list.set_follow_mode(FollowMode::Tail);
    let window = cx.update(|cx| {
        let bounds = Bounds {
            origin: Point::default(),
            size: size(px(400.), px(600.)),
        };
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            ..Default::default()
        };
        let (list, seen, peek) = (list.clone(), seen.clone(), peek.clone());
        gpui_kit::open_window(options, cx, move |_, cx| {
            let pane = cx.new(|_| View {
                list,
                seen,
                bounce: true,
            });
            let panel = cx.new(|_| Panel { pane: pane.clone() });
            cx.new(|_| Root { pane, panel, peek })
        })
        .expect("a test window")
        .0
    });
    let top = || {
        seen.borrow()
            .iter()
            .next()
            .map(|(&ix, &y)| y - ix as f32 * ROW)
    };
    let draw = |cx: &mut TestAppContext| {
        seen.borrow_mut().clear();
        cx.update_window(window, |_, window, cx| window.draw(cx).clear(cx))
            .expect("the window");
    };
    for _ in 0..2 {
        seen.borrow_mut().clear();
        cx.update_window(window, |_, window, cx| window.render_frame(cx))
            .expect("the window");
    }
    assert_eq!(top(), Some(END), "the panel shows the end");
    peek.set(false);
    // Idle frames where the window keeps drawing (caret/spinner) and the panel replays from cache.
    for _ in 0..3 {
        cx.executor().advance_clock(Duration::from_secs(1));
        draw(cx);
    }
    assert_eq!(top(), None, "idle frames replay the panel");

    // First trackpad packets after idle: the rows must move on the very next frame.
    seen.borrow_mut().clear();
    cx.update_window(window, |_, window, cx| {
        for (phase, dy) in [(TouchPhase::Started, 0.), (TouchPhase::Moved, 12.)] {
            let event = ScrollEvent {
                position: point(px(200.), px(300.)),
                delta: ScrollDelta::Pixels(point(px(0.), px(dy))),
                modifiers: Modifiers::default(),
                touch_phase: phase,
                source: ScrollSource::Pointer,
            };
            window.dispatch_event(event.to_platform_input(), cx);
        }
    })
    .expect("the window");
    cx.update_window(window, |_, window, cx| window.draw(cx).clear(cx))
        .expect("the window");
    assert_eq!(
        top(),
        Some(END + 12.),
        "the rows move by the packet within one frame"
    );
}
