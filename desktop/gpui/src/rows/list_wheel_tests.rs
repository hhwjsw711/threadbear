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
}

impl Render for View {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let seen = self.seen.clone();
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
        // Bouncing on, as on a Mac, so the tests mean the same everywhere.
        div()
            .size_full()
            .child(base::ScrollBounce::new("bounce", &self.list, rows).enabled(true))
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
        gpui_kit::open_window(options, cx, move |_, cx| cx.new(|_| View { list, seen }))
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
        let dy = delta(t);
        cx.executor().advance_clock(Duration::from_secs_f64(frame));
        cx.update_window(window, |_, window, cx| {
            if dy != 0 {
                let event = ScrollEvent {
                    position: point(px(200.), px(300.)),
                    delta: ScrollDelta::Pixels(point(px(0.), px(dy as f32))),
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
            let pane = cx.new(|_| View { list, seen });
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
