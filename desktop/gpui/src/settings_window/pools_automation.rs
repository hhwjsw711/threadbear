// Settings › Pools for the specs (features/settings-pools.feature): the list
// as the window really draws it, and a pool row dragged onto another's place
// through real pointer events, as the `settings` command takes it (`dragPool`
// and where to let go, below). Nothing here is part of the app: the rows,
// their order and what a drag does are pools.rs's, and this only reads them
// and moves the pointer.
use super::SettingsWindow;
use crate::app::Threadbear;
use gpui_kit::*;
use serde_json::{json, Value};
use std::cell::RefCell;

thread_local! {
    /// The pool rows on screen in the last frame the automation drew, top to
    /// bottom, by name. The window's state alone can't say what's drawn, so
    /// `note_drawn` reads it from the frame as devices.rs does for the
    /// pairing code.
    static DRAWN: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

impl SettingsWindow {
    /// The section in the dump: the pools as Settings lists them, top to
    /// bottom. Empty while another section is showing.
    pub(super) fn pools_dump(&self) -> Value {
        json!({ "rows": DRAWN.with(|drawn| drawn.borrow().clone()) })
    }
}

/// The pool rows of the frame just drawn, in the order they're drawn in. The
/// automation's `dump` calls it after drawing the Settings window.
pub(crate) fn note_drawn(view: &Entity<SettingsWindow>, window: &mut Window, cx: &mut App) {
    use gpui_kit::test::TestWindowExt as _;
    let pools = view
        .read(cx)
        .app
        .upgrade()
        .map(|app| app.read(cx).logins.pools.clone())
        .unwrap_or_default();
    let mut drawn: Vec<(Pixels, String)> = pools
        .iter()
        .filter_map(|pool| {
            window
                .try_find(SharedString::from(format!("settings-pool-{}", pool.id)))
                .map(|row| (row.bounds().origin.y, pool.title.clone()))
        })
        .collect();
    drawn.sort_by(|(a, _), (b, _)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    DRAWN.with(|rows| *rows.borrow_mut() = drawn.into_iter().map(|(_, title)| title).collect());
}

/// `dragPool` (a pool name) picks a row up through real pointer events, as
/// runners.rs does for a runner's row, and lets it go where it's told:
/// `onto` another pool's row, `past` another row and back on its own, or
/// `offRows` clear of every pool row, below the last of them. Every form
/// moves the pointer in eight steps a leg, so each one is a drag the window
/// sees as a drag, not a click.
pub(crate) fn automation(
    app: &Entity<Threadbear>,
    cmd: &Value,
    cx: &mut App,
) -> Result<Option<Value>, String> {
    use gpui_kit::test::{TestEventExt as _, TestWindowExt as _};
    let Some(from) = cmd["dragPool"].as_str() else {
        return Ok(None);
    };
    let id_of = |name: &str| {
        app.read(cx)
            .logins
            .pools
            .iter()
            .find(|p| p.title == name)
            .map(|p| p.id.clone())
            .ok_or_else(|| format!("no pool {name}"))
    };
    let dragged = id_of(from)?;
    let onto = match cmd["onto"].as_str() {
        Some(name) => Some(id_of(name)?),
        None => None,
    };
    let past = match cmd["past"].as_str() {
        Some(name) => Some(id_of(name)?),
        None => None,
    };
    let off_rows = cmd["offRows"].as_bool() == Some(true);
    if onto.is_none() && past.is_none() && !off_rows {
        return Err(
            "dragPool needs onto (another pool's row), past (over one and back) or offRows".into(),
        );
    }
    let every: Vec<String> = app
        .read(cx)
        .logins
        .pools
        .iter()
        .map(|p| p.id.clone())
        .collect();
    let handle = app
        .read(cx)
        .settings_window
        .as_ref()
        .map(|(h, _)| *h)
        .ok_or("the Settings window isn't open")?;
    handle
        .update(cx, |_, window, cx| -> Result<(), String> {
            window.render_frame(cx);
            let row = |id: &str, window: &Window| {
                window
                    .try_find(SharedString::from(format!("settings-pool-{id}")))
                    .ok_or_else(|| format!("no row for {id} on screen"))
            };
            let center = |id: &str, window: &Window| {
                row(id, window)?
                    .click_point()
                    .ok_or_else(|| format!("no row for {id} on screen"))
            };
            let p = center(&dragged, window)?;
            // Where the pointer goes while it's held, and where it lets go.
            let way: Vec<Point<Pixels>> = if let Some(onto) = &onto {
                vec![center(onto, window)?]
            } else if let Some(past) = &past {
                vec![center(past, window)?, p]
            } else {
                // Below every pool row, so it's let go over none of them.
                let lowest = every
                    .iter()
                    .filter_map(|id| row(id, window).ok())
                    .map(|r| r.bounds().bottom())
                    .fold(p.y, |low, bottom| if bottom > low { bottom } else { low });
                vec![point(p.x, lowest + gpui_kit::px(24.))]
            };
            let release = *way.last().expect("a leg to drag along");
            window.pointer_move(p, None, cx);
            window.pointer_down(p, MouseButton::Left, cx);
            let mut at = p;
            for to in way {
                for step in 1..=8 {
                    let t = step as f32 / 8.;
                    window.pointer_move(
                        point(at.x + (to.x - at.x) * t, at.y + (to.y - at.y) * t),
                        Some(MouseButton::Left),
                        cx,
                    );
                }
                at = to;
            }
            window.pointer_up(release, MouseButton::Left, cx);
            window.render_frame(cx);
            Ok(())
        })
        .map_err(|e| e.to_string())??;
    Ok(Some(json!("ok")))
}
