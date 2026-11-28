// One reusable floating popup window for dropdown menus that sit over native
// web or media views (files.rs `artifact_visibility_menu`, `markdown_menu`).
// On macOS it rides in a single hidden non-activating child `NSPanel`
// (`WindowKind::PopUp`, `native/popup_window.m`), so menus composite cleanly
// above CEF/WebKit/AVKit without hiding the page underneath, and reuse one
// Metal surface instead of allocating a window per click.
use gpui_kit::component::menu::PopupMenu;
use gpui_kit::prelude::*;
use gpui_kit::*;
#[cfg(target_os = "macos")]
use std::cell::RefCell;
#[cfg(target_os = "macos")]
use std::ffi::c_void;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};

#[cfg(target_os = "macos")]
const POPUP_MENU_BIT: u8 = 2;
#[cfg(target_os = "macos")]
const SHADOW_PAD: f32 = 12.0;

#[cfg(target_os = "macos")]
const EV_DISMISS: u32 = 0;
#[cfg(target_os = "macos")]
const EV_MOUSE_OUT: u32 = 1;
#[cfg(target_os = "macos")]
const EV_UP: u32 = 2;
#[cfg(target_os = "macos")]
const EV_DOWN: u32 = 3;
#[cfg(target_os = "macos")]
const EV_CONFIRM: u32 = 4;

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn tb_popup_place(
        panel_ns_view: *mut c_void,
        owner_ns_view: *mut c_void,
        anchor_x: f64,
        anchor_y: f64,
        anchor_w: f64,
        anchor_h: f64,
        width: f64,
        height: f64,
        pad: f64,
        gen: u64,
        swallow_toggle: bool,
        on_event: extern "C" fn(u64, u32),
    );
    fn tb_popup_reposition(
        panel_ns_view: *mut c_void,
        owner_ns_view: *mut c_void,
        anchor_x: f64,
        anchor_y: f64,
        anchor_w: f64,
        anchor_h: f64,
        width: f64,
        height: f64,
        pad: f64,
        gen: u64,
    );
    fn tb_popup_hide(panel_ns_view: *mut c_void);
}

/// Whether this platform hosts floating dropdown popups in a child panel.
pub(crate) fn supported() -> bool {
    cfg!(target_os = "macos")
}

/// The reusable popup window's id, if created, so `app_update` and `media_view`
/// ignore it when checking for in-window menus or dialogs.
pub(crate) fn window_id() -> Option<WindowId> {
    #[cfg(target_os = "macos")]
    {
        HOST.with(|h| h.borrow().as_ref().map(|host| host.window.window_id()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Menu items currently open in the floating popup window, for automation.
#[cfg(feature = "automation")]
pub(crate) fn open_menu_items(cx: &mut App) -> Vec<Vec<String>> {
    #[cfg(target_os = "macos")]
    {
        if ACTIVE_GEN.load(Ordering::SeqCst) == 0 {
            return Vec::new();
        }
        let host = HOST.with(|h| h.borrow().as_ref().map(|host| host.window));
        let Some(window) = host else {
            return Vec::new();
        };
        window
            .update(cx, |_, window, cx| {
                use gpui_kit::test::TestWindowExt as _;
                window.render_frame(cx);
                let mut menus = Vec::new();
                for index in 0..16 {
                    let items: Vec<String> = crate::reply_links::open_menu_items(window, index)
                        .into_iter()
                        .map(|(title, _)| title)
                        .collect();
                    if items.is_empty() {
                        break;
                    }
                    menus.push(items);
                }
                menus
            })
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = cx;
        Vec::new()
    }
}

/// Starts the background native-event listener once at app launch.
pub(crate) fn init(cx: &mut App) {
    #[cfg(target_os = "macos")]
    {
        use futures::StreamExt as _;
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<(u64, u32)>();
        if EVENT_TX.set(tx).is_err() {
            return;
        }
        cx.spawn(async move |cx| {
            while let Some((gen, kind)) = rx.next().await {
                let _ = cx.update(|cx| handle_native_event(gen, kind, cx));
            }
        })
        .detach();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = cx;
    }
}

#[cfg(target_os = "macos")]
static NEXT_GEN: AtomicU64 = AtomicU64::new(1);
#[cfg(target_os = "macos")]
static ACTIVE_GEN: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "macos")]
static EVENT_TX: OnceLock<futures::channel::mpsc::UnboundedSender<(u64, u32)>> = OnceLock::new();
#[cfg(target_os = "macos")]
static ACTIVE_INFO: Mutex<Option<(u64, &'static str, bool)>> = Mutex::new(None);

#[cfg(target_os = "macos")]
extern "C" fn on_native_event(gen: u64, kind: u32) {
    if let Some(tx) = EVENT_TX.get() {
        let _ = tx.unbounded_send((gen, kind));
    }
}

#[cfg(target_os = "macos")]
fn handle_native_event(gen: u64, kind: u32, cx: &mut App) {
    if ACTIVE_GEN.load(Ordering::SeqCst) != gen {
        return;
    }
    match kind {
        EV_DISMISS | EV_MOUSE_OUT => close_gen(gen, cx),
        EV_UP | EV_DOWN | EV_CONFIRM => dispatch_menu_key(gen, kind, cx),
        _ => {}
    }
}

#[cfg(target_os = "macos")]
fn dispatch_menu_key(gen: u64, kind: u32, cx: &mut App) {
    use gpui_kit::base::actions::{Confirm, SelectDown, SelectUp};
    let host = HOST.with(|h| {
        h.borrow()
            .as_ref()
            .map(|host| (host.window, host.view.clone()))
    });
    let Some((window, view)) = host else {
        return;
    };
    let _ = window.update(cx, |_, popup_window, cx| {
        let menu = view
            .read(cx)
            .active
            .as_ref()
            .filter(|a| a.gen == gen)
            .map(|a| a.menu.clone());
        let Some(menu) = menu else {
            return;
        };
        menu.focus_handle(cx).focus(popup_window, cx);
        let action: Box<dyn gpui_kit::Action> = match kind {
            EV_UP => Box::new(SelectUp),
            EV_DOWN => Box::new(SelectDown),
            _ => Box::new(Confirm { secondary: false }),
        };
        popup_window.dispatch_action(action, cx);
    });
}

#[cfg(target_os = "macos")]
struct ActivePopup {
    gen: u64,
    owner: AnyWindowHandle,
    anchor: Bounds<Pixels>,
    menu: Entity<PopupMenu>,
    _dismissed: Subscription,
    panel_size: Size<Pixels>,
}

#[cfg(target_os = "macos")]
struct PopupHostView {
    active: Option<ActivePopup>,
}

#[cfg(target_os = "macos")]
impl PopupHostView {
    fn new() -> Self {
        Self { active: None }
    }
}

#[cfg(target_os = "macos")]
impl Render for PopupHostView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(active) = &self.active else {
            return Empty.into_any_element();
        };
        let gen = active.gen;
        let menu = active.menu.clone();
        let view = cx.entity().downgrade();
        let pad = gpui_kit::px(SHADOW_PAD);
        let box_el = div().relative().flex_none().child(menu).child(
            canvas(
                move |bounds, _window, cx| {
                    let w = f32::from(bounds.size.width);
                    let h = f32::from(bounds.size.height);
                    if w < 1. || h < 1. {
                        return;
                    }
                    let target = size(
                        gpui_kit::px((w + 2. * SHADOW_PAD).ceil()),
                        gpui_kit::px((h + 2. * SHADOW_PAD).ceil()),
                    );
                    let needs_resize = view.upgrade().is_some_and(|v| {
                        v.read(cx).active.as_ref().is_some_and(|a| {
                            a.gen == gen
                                && ((f32::from(a.panel_size.width) - f32::from(target.width)).abs()
                                    > 1.
                                    || (f32::from(a.panel_size.height) - f32::from(target.height))
                                        .abs()
                                        > 1.)
                        })
                    });
                    if needs_resize {
                        let view = view.clone();
                        cx.defer(move |cx| reposition_active(view, gen, target, cx));
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .inset_0(),
        );
        div()
            .size_full()
            .flex()
            .items_start()
            .p(pad)
            .child(box_el)
            .into_any_element()
    }
}

#[cfg(target_os = "macos")]
struct ReusableHost {
    window: AnyWindowHandle,
    view: Entity<PopupHostView>,
}

#[cfg(target_os = "macos")]
thread_local! {
    static HOST: RefCell<Option<ReusableHost>> = const { RefCell::new(None) };
}

#[cfg(target_os = "macos")]
fn ensure_host(cx: &mut App) -> Option<(AnyWindowHandle, Entity<PopupHostView>)> {
    let existing = HOST.with(|h| {
        h.borrow()
            .as_ref()
            .map(|host| (host.window, host.view.clone()))
    });
    if let Some((window, view)) = existing {
        if cx
            .windows()
            .iter()
            .any(|w| w.window_id() == window.window_id())
        {
            return Some((window, view));
        }
        HOST.with(|h| *h.borrow_mut() = None);
    }
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            point(gpui_kit::px(0.), gpui_kit::px(0.)),
            size(gpui_kit::px(240.), gpui_kit::px(180.)),
        ))),
        titlebar: None,
        window_background: WindowBackgroundAppearance::Transparent,
        focus: false,
        show: false,
        kind: WindowKind::PopUp,
        is_movable: false,
        is_resizable: false,
        is_minimizable: false,
        ..Default::default()
    };
    let (window, view) =
        gpui_kit::open_window(options, cx, |_, cx| cx.new(|_| PopupHostView::new())).ok()?;
    let any_window: AnyWindowHandle = window.into();
    HOST.with(|h| {
        *h.borrow_mut() = Some(ReusableHost {
            window: any_window,
            view: view.clone(),
        });
    });
    Some((any_window, view))
}

#[cfg(target_os = "macos")]
fn reposition_active(
    view: WeakEntity<PopupHostView>,
    gen: u64,
    target: Size<Pixels>,
    cx: &mut App,
) {
    if ACTIVE_GEN.load(Ordering::SeqCst) != gen {
        return;
    }
    let Some(view) = view.upgrade() else {
        return;
    };
    let info = view.update(cx, |host, _| {
        let active = host.active.as_mut().filter(|a| a.gen == gen)?;
        active.panel_size = target;
        Some((active.owner, active.anchor))
    });
    let Some((owner_handle, anchor)) = info else {
        return;
    };
    let host_window = HOST.with(|h| h.borrow().as_ref().map(|host| host.window));
    let Some(host_window) = host_window else {
        return;
    };
    let owner_view = owner_handle
        .update(cx, |_, w, _| crate::web_panels::native_view(w))
        .ok()
        .flatten();
    let panel_view = host_window
        .update(cx, |_, w, _| crate::web_panels::native_view(w))
        .ok()
        .flatten();
    let (Some(panel_view), Some(owner_view)) = (panel_view, owner_view) else {
        close_gen(gen, cx);
        return;
    };
    // SAFETY: both NSView pointers come from live windows checked above on the main thread.
    unsafe {
        tb_popup_reposition(
            panel_view,
            owner_view,
            f32::from(anchor.origin.x) as f64,
            f32::from(anchor.origin.y) as f64,
            f32::from(anchor.size.width) as f64,
            f32::from(anchor.size.height) as f64,
            f32::from(target.width) as f64,
            f32::from(target.height) as f64,
            SHADOW_PAD as f64,
            gen,
        );
    }
}

#[cfg(target_os = "macos")]
fn close_gen(gen: u64, cx: &mut App) {
    if ACTIVE_GEN
        .compare_exchange(gen, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    close_inner(cx);
}

/// Closes whichever menu is currently open in the reusable floating popup window.
pub(crate) fn close(cx: &mut App) {
    #[cfg(target_os = "macos")]
    {
        ACTIVE_GEN.store(0, Ordering::SeqCst);
        close_inner(cx);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = cx;
    }
}

#[cfg(target_os = "macos")]
fn close_inner(cx: &mut App) {
    if let Ok(mut info) = ACTIVE_INFO.lock() {
        *info = None;
    }
    crate::tips::menu_up(POPUP_MENU_BIT, false);
    let host = HOST.with(|h| {
        h.borrow()
            .as_ref()
            .map(|host| (host.window, host.view.clone()))
    });
    let Some((window, view)) = host else {
        return;
    };
    let panel_view = window
        .update(cx, |_, w, cx| {
            view.update(cx, |host, cx| {
                host.active = None;
                cx.notify();
            });
            crate::web_panels::native_view(w)
        })
        .ok()
        .flatten();
    // SAFETY: `panel_view` is either null or the live popup window's NSView on the main thread.
    unsafe {
        tb_popup_hide(panel_view.unwrap_or(std::ptr::null_mut()));
    }
}

/// Opens a dropdown menu anchored to `anchor` (in `owner`'s viewport coordinates)
/// inside the reusable floating popup window. When `toggle` is true, clicking
/// the same `tag` while open (or right after a click-outside dismissed it)
/// closes it instead of reopening.
pub(crate) fn open_menu(
    tag: &'static str,
    toggle: bool,
    anchor: Bounds<Pixels>,
    min_width: Pixels,
    owner: &mut Window,
    cx: &mut App,
    build: impl FnOnce(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static,
) -> bool {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (tag, toggle, anchor, min_width, owner, cx, build);
        false
    }
    #[cfg(target_os = "macos")]
    {
        if toggle {
            let currently_same = ACTIVE_INFO
                .lock()
                .ok()
                .is_some_and(|active| active.is_some_and(|(_, t, _)| t == tag));
            if currently_same {
                close(cx);
                return true;
            }
        }
        let owner_handle = owner.window_handle();
        let Some(owner_view) = crate::web_panels::native_view(owner) else {
            return false;
        };
        let Some((host_window, host_view)) = ensure_host(cx) else {
            return false;
        };
        let gen = NEXT_GEN.fetch_add(1, Ordering::SeqCst);
        let initial_size = size(
            gpui_kit::px((f32::from(min_width).max(200.) + 2. * SHADOW_PAD).ceil()),
            gpui_kit::px((220. + 2. * SHADOW_PAD).ceil()),
        );
        let mut build = Some(build);
        let placed = host_window.update(cx, |_, popup_window, cx| {
            let Some(build) = build.take() else {
                return None;
            };
            let menu = PopupMenu::build(popup_window, cx, build);
            menu.focus_handle(cx).focus(popup_window, cx);
            host_view.update(cx, |host, cx| {
                let dismissed = cx.subscribe(&menu, move |_, _, _: &DismissEvent, cx| {
                    cx.defer(move |cx| close_gen(gen, cx));
                });
                host.active = Some(ActivePopup {
                    gen,
                    owner: owner_handle,
                    anchor,
                    menu,
                    _dismissed: dismissed,
                    panel_size: initial_size,
                });
                cx.notify();
            });
            crate::web_panels::native_view(popup_window)
        });
        let Ok(Some(panel_view)) = placed else {
            return false;
        };
        ACTIVE_GEN.store(gen, Ordering::SeqCst);
        if let Ok(mut info) = ACTIVE_INFO.lock() {
            *info = Some((gen, tag, toggle));
        }
        crate::tips::menu_up(POPUP_MENU_BIT, true);
        // SAFETY: `panel_view` and `owner_view` are live NSViews on the main thread.
        unsafe {
            tb_popup_place(
                panel_view,
                owner_view,
                f32::from(anchor.origin.x) as f64,
                f32::from(anchor.origin.y) as f64,
                f32::from(anchor.size.width) as f64,
                f32::from(anchor.size.height) as f64,
                f32::from(initial_size.width) as f64,
                f32::from(initial_size.height) as f64,
                SHADOW_PAD as f64,
                gen,
                toggle,
                on_native_event,
            );
        }
        true
    }
}
