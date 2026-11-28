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
/// Transparent margin around the popup menu so `mac_look::shadow` (30 pt blur,
/// 10 pt y offset) fades out cleanly inside the borderless transparent panel.
#[cfg(target_os = "macos")]
const SHADOW_PAD: f32 = 36.0;

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
    fn tb_popup_reveal(panel_ns_view: *mut c_void, gen: u64);
    fn tb_popup_hide(panel_ns_view: *mut c_void);
}

/// Whether this platform hosts floating dropdown popups in a child panel.
/// Synthetic single-window Cucumber runs bypass AppKit's local event monitor,
/// so scripted test runs (unless filming) keep in-window popovers.
pub(crate) fn supported() -> bool {
    cfg!(target_os = "macos") && (!crate::scripted::scripted() || crate::scripted::filming())
}

/// Whether a floating popup menu is currently open.
pub(crate) fn is_open() -> bool {
    #[cfg(target_os = "macos")]
    {
        ACTIVE_GEN.load(Ordering::SeqCst) != 0
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
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
                cx.update(|cx| handle_native_event(gen, kind, cx));
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
static ACTIVE_INFO: Mutex<Option<(u64, String, bool)>> = Mutex::new(None);

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
#[derive(Clone, Copy, PartialEq, Eq)]
enum RevealState {
    Measuring,
    Sized { tries: u8 },
    Shown,
}

#[cfg(target_os = "macos")]
struct ActivePopup {
    gen: u64,
    tag: String,
    owner: AnyWindowHandle,
    anchor: Bounds<Pixels>,
    menu: Entity<PopupMenu>,
    _dismissed: Subscription,
    panel_size: Size<Pixels>,
    reveal: RevealState,
}

/// What the panel's layout pass asks for once it has measured the menu.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
enum LayoutStep {
    Reposition,
    Reveal,
    Wait,
}

/// Runs a `LayoutStep`. Handed to the view, so the view doesn't call the
/// functions that reach back into `HOST` and the uses run one way.
#[cfg(target_os = "macos")]
type OnLayoutStep = fn(LayoutStep, WeakEntity<PopupHostView>, u64, Size<Pixels>, &mut App);

#[cfg(target_os = "macos")]
struct PopupHostView {
    active: Option<ActivePopup>,
    on_step: OnLayoutStep,
    /// Last measured panel size per dropdown tag so re-opens already start at
    /// the exact final size with zero resize frames.
    cached_sizes: std::collections::HashMap<String, Size<Pixels>>,
}

#[cfg(target_os = "macos")]
impl PopupHostView {
    fn new(on_step: OnLayoutStep) -> Self {
        Self {
            active: None,
            on_step,
            cached_sizes: std::collections::HashMap::new(),
        }
    }

    fn remember_size(&mut self, tag: String, size: Size<Pixels>) {
        if self.cached_sizes.len() >= 64 && !self.cached_sizes.contains_key(&tag) {
            self.cached_sizes.clear();
        }
        self.cached_sizes.insert(tag, size);
    }
}

#[cfg(target_os = "macos")]
fn sizes_close(a: Size<Pixels>, b: Size<Pixels>, tol: f32) -> bool {
    (f32::from(a.width) - f32::from(b.width)).abs() <= tol
        && (f32::from(a.height) - f32::from(b.height)).abs() <= tol
}

#[cfg(target_os = "macos")]
impl Render for PopupHostView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use gpui_kit::component::ActiveTheme as _;
        window.set_rem_size(cx.theme().font_size);
        let Some(active) = &self.active else {
            return Empty.into_any_element();
        };
        let gen = active.gen;
        let menu = active.menu.clone();
        let view = cx.entity().downgrade();
        let on_step = self.on_step;
        let pad = gpui_kit::px(SHADOW_PAD);
        let box_el = div().relative().flex_none().child(menu).child(
            canvas(
                move |bounds, window, cx| {
                    let w = f32::from(bounds.size.width);
                    let h = f32::from(bounds.size.height);
                    if w < 1. || h < 1. {
                        return;
                    }
                    let target = size(
                        gpui_kit::px((w + 2. * SHADOW_PAD).ceil()),
                        gpui_kit::px((h + 2. * SHADOW_PAD).ceil()),
                    );
                    let viewport = window.viewport_size();
                    let Some(v) = view.upgrade() else {
                        return;
                    };
                    let step = v.read(cx).active.as_ref().and_then(|a| {
                        if a.gen != gen {
                            return None;
                        }
                        if !sizes_close(a.panel_size, target, 1.0) {
                            return Some(LayoutStep::Reposition);
                        }
                        match a.reveal {
                            RevealState::Shown => None,
                            RevealState::Measuring => {
                                if sizes_close(viewport, target, 2.5) {
                                    Some(LayoutStep::Reveal)
                                } else {
                                    Some(LayoutStep::Reposition)
                                }
                            }
                            RevealState::Sized { tries } => {
                                if sizes_close(viewport, target, 2.5) || tries >= 2 {
                                    Some(LayoutStep::Reveal)
                                } else {
                                    Some(LayoutStep::Wait)
                                }
                            }
                        }
                    });
                    if let Some(step) = step {
                        let view = view.clone();
                        cx.defer(move |cx| on_step(step, view, gen, target, cx));
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .inset_0(),
        );
        // No `.bg(...)`: the panel is transparent so only `PopupMenu`'s own
        // rounded card and drop shadow appear over the web page beneath.
        div()
            .size_full()
            .font_family(cx.theme().font_family.clone())
            .text_color(cx.theme().foreground)
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
    // Open directly via `cx.open_window` (not `gpui_kit::open_window`): `Root`
    // paints an opaque theme background across the window, which showed up as a
    // dark rectangle around the floating menu.
    let mut created_view = None;
    let window = cx
        .open_window(options, |_, cx| {
            let v = cx.new(|_| PopupHostView::new(run_layout_step));
            created_view = Some(v.clone());
            v
        })
        .ok()?;
    let view = created_view?;
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
fn run_layout_step(
    step: LayoutStep,
    view: WeakEntity<PopupHostView>,
    gen: u64,
    target: Size<Pixels>,
    cx: &mut App,
) {
    match step {
        LayoutStep::Reposition => reposition_active(view, gen, target, cx),
        LayoutStep::Reveal => reveal_active(view, gen, target, cx),
        LayoutStep::Wait => bump_reveal_wait(view, gen, cx),
    }
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
    let info = view.update(cx, |host, cx| {
        let active = host.active.as_mut().filter(|a| a.gen == gen)?;
        active.panel_size = target;
        if active.reveal != RevealState::Shown {
            active.reveal = RevealState::Sized { tries: 0 };
        }
        let tag = active.tag.clone();
        let out = (active.owner, active.anchor);
        host.remember_size(tag, target);
        cx.notify();
        Some(out)
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
fn bump_reveal_wait(view: WeakEntity<PopupHostView>, gen: u64, cx: &mut App) {
    if ACTIVE_GEN.load(Ordering::SeqCst) != gen {
        return;
    }
    let Some(view) = view.upgrade() else {
        return;
    };
    view.update(cx, |host, cx| {
        if let Some(active) = host.active.as_mut().filter(|a| a.gen == gen) {
            if let RevealState::Sized { tries } = &mut active.reveal {
                *tries = tries.saturating_add(1);
                cx.notify();
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn reveal_active(view: WeakEntity<PopupHostView>, gen: u64, target: Size<Pixels>, cx: &mut App) {
    if ACTIVE_GEN.load(Ordering::SeqCst) != gen {
        return;
    }
    let Some(view) = view.upgrade() else {
        return;
    };
    let should_reveal = view.update(cx, |host, _| {
        let Some(active) = host.active.as_mut().filter(|a| a.gen == gen) else {
            return false;
        };
        if active.reveal == RevealState::Shown {
            return false;
        }
        active.reveal = RevealState::Shown;
        let tag = active.tag.clone();
        host.remember_size(tag, target);
        true
    });
    if !should_reveal {
        return;
    }
    let host_window = HOST.with(|h| h.borrow().as_ref().map(|host| host.window));
    let Some(host_window) = host_window else {
        return;
    };
    let panel_view = host_window
        .update(cx, |_, w, _| crate::web_panels::native_view(w))
        .ok()
        .flatten();
    if let Some(panel_view) = panel_view {
        // SAFETY: `panel_view` is the live popup window's NSView on the main thread.
        unsafe {
            tb_popup_reveal(panel_view, gen);
        }
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
    tag: impl Into<SharedString>,
    toggle: bool,
    anchor: Bounds<Pixels>,
    min_width: Pixels,
    owner: &mut Window,
    cx: &mut App,
    build: impl FnOnce(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static,
) -> bool {
    let tag: String = tag.into().into();
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
                .is_some_and(|active| active.as_ref().is_some_and(|(_, t, _)| *t == tag));
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
        let initial_size = host_view
            .read(cx)
            .cached_sizes
            .get(&tag)
            .copied()
            .unwrap_or_else(|| {
                size(
                    gpui_kit::px((f32::from(min_width).max(200.) + 2. * SHADOW_PAD).ceil()),
                    gpui_kit::px((220. + 2. * SHADOW_PAD).ceil()),
                )
            });
        let mut build = Some(build);
        let active_tag = tag.clone();
        let placed = host_window.update(cx, |_, popup_window, cx| {
            let build = build.take()?;
            let menu = PopupMenu::build(popup_window, cx, build);
            menu.focus_handle(cx).focus(popup_window, cx);
            host_view.update(cx, |host, cx| {
                let dismissed = cx.subscribe(&menu, move |_, _, _: &DismissEvent, cx| {
                    cx.defer(move |cx| close_gen(gen, cx));
                });
                host.active = Some(ActivePopup {
                    gen,
                    tag: active_tag,
                    owner: owner_handle,
                    anchor,
                    menu,
                    _dismissed: dismissed,
                    panel_size: initial_size,
                    reveal: RevealState::Measuring,
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

/// Hosts a `Button`'s dropdown menu in the reusable floating popup window on
/// macOS so it floats cleanly above native web/media views and past narrow
/// window edges, falling back to GPUI's in-window `.dropdown_menu` elsewhere.
pub(crate) fn dropdown_button(
    tag: impl Into<SharedString>,
    button: gpui_kit::component::button::Button,
    min_width: Pixels,
    build: impl Fn(PopupMenu, AnyWindowHandle, &mut Window, &mut Context<PopupMenu>) -> PopupMenu
        + 'static,
) -> AnyElement {
    use gpui_kit::component::menu::DropdownMenu as _;
    let tag: SharedString = tag.into();
    let build = std::rc::Rc::new(build);
    if supported() {
        let bounds_cell = std::rc::Rc::new(std::cell::Cell::new(Bounds::default()));
        let capture = bounds_cell.clone();
        return div()
            .relative()
            .flex_none()
            .child(button.on_click(move |event: &ClickEvent, window, cx| {
                let mut anchor = bounds_cell.get();
                if anchor.is_empty() {
                    anchor =
                        Bounds::new(event.position(), size(gpui_kit::px(1.), gpui_kit::px(1.)));
                }
                let owner_handle = window.window_handle();
                let build = build.clone();
                open_menu(
                    tag.clone(),
                    true,
                    anchor,
                    min_width,
                    window,
                    cx,
                    move |menu, popup_window, cx| build(menu, owner_handle, popup_window, cx),
                );
            }))
            .child(
                canvas(move |bounds, _, _| capture.set(bounds), |_, _, _, _| {})
                    .absolute()
                    .inset_0(),
            )
            .into_any_element();
    }
    button
        .dropdown_menu(move |menu: PopupMenu, window, cx| {
            let owner_handle = window.window_handle();
            build(menu, owner_handle, window, cx)
        })
        .into_any_element()
}

/// Hosts a custom `Stateful<Div>` dropdown trigger (`VisibilityLabel`,
/// `ModeLabel`, `MenuLabel`) in the reusable floating popup window on macOS.
pub(crate) fn dropdown_trigger<T>(
    tag: impl Into<SharedString>,
    holder_id: impl Into<ElementId>,
    trigger: T,
    inner: Stateful<Div>,
    tip: impl Into<SharedString>,
    min_width: Pixels,
    build: impl Fn(PopupMenu, AnyWindowHandle, &mut Window, &mut Context<PopupMenu>) -> PopupMenu
        + 'static,
) -> AnyElement
where
    T: gpui_kit::component::menu::DropdownMenu,
{
    use crate::tips::Tip as _;
    use gpui_kit::base::TestSupportExt as _;
    let tag: SharedString = tag.into();
    let tip: SharedString = tip.into();
    let build = std::rc::Rc::new(build);
    if supported() {
        let bounds_cell = std::rc::Rc::new(std::cell::Cell::new(Bounds::default()));
        let capture = bounds_cell.clone();
        let trigger_el = inner.relative().child(
            canvas(move |bounds, _, _| capture.set(bounds), |_, _, _, _| {})
                .absolute()
                .inset_0(),
        );
        return crate::a11y::A11yRole::a11y_role(trigger_el.test_support(), gpui_kit::Role::Button)
            .aria_label(tip.clone())
            .tip(tip)
            .on_click(move |event: &ClickEvent, window, cx| {
                let mut anchor = bounds_cell.get();
                if anchor.is_empty() {
                    anchor =
                        Bounds::new(event.position(), size(gpui_kit::px(1.), gpui_kit::px(1.)));
                }
                let owner_handle = window.window_handle();
                let build = build.clone();
                open_menu(
                    tag.clone(),
                    true,
                    anchor,
                    min_width,
                    window,
                    cx,
                    move |menu, popup_window, cx| build(menu, owner_handle, popup_window, cx),
                );
            })
            .into_any_element();
    }
    let holder = crate::a11y::A11yRole::a11y_role(
        div().id(holder_id).flex_none().test_support(),
        gpui_kit::Role::GenericContainer,
    )
    .aria_label(tip.clone())
    .tip(tip);
    holder
        .child(trigger.dropdown_menu(move |menu: PopupMenu, window, cx| {
            let owner_handle = window.window_handle();
            build(menu, owner_handle, window, cx)
        }))
        .into_any_element()
}
