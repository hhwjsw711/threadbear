// CEF inside the GPUI app on a Mac, started the way Ghostex's Mac path and the
// gpui-web-spike branch start it (MIT; the notice is in native/appkit_hooks.m):
// the framework loaded from the data folder, GPUI's NSApplication given
// CefAppProtocol, and from a run-loop timer cef::initialize and then
// cef::run_message_loop, which nests Chromium's loop inside GPUI's for the
// rest of the process. Started the first time something needs it, not at
// launch, so a Mac that never shows a diagram never runs Chromium.
//
// Everything here runs on the main thread, which is also Chromium's UI
// thread: its callbacks arrive inside its loop, outside any GPUI update, so
// they only ever touch their own state and send on channels.
use super::sealed;
use super::status::set_status;
pub use super::status::{status, Status};
use cef::{args::Args, *};
use std::cell::RefCell;
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

unsafe extern "C" {
    fn tb_cef_install_app_hooks();
    fn tb_cef_start_message_loop();
    // Placing a page's own view in a GPUI layout slot (page.rs).
    pub(crate) fn tb_view_set_frame(view: *mut c_void, x: f64, y: f64, width: f64, height: f64);
    pub(crate) fn tb_view_set_hidden(view: *mut c_void, hidden: bool);
    // A panel's page moving between windows, and whether it has the keyboard (panel.rs).
    pub(crate) fn tb_view_set_parent(view: *mut c_void, parent: *mut c_void);
    pub(crate) fn tb_view_remove(view: *mut c_void);
    // A person's clicks and keys in a page's view, counted (panel.rs).
    pub(crate) fn tb_view_watch_input(view: *mut c_void);
    pub(crate) fn tb_view_input_count(view: *mut c_void) -> u64;
    pub(crate) fn tb_view_note_input(view: *mut c_void);
    pub(crate) fn tb_view_has_keyboard(view: *mut c_void) -> bool;
    pub(crate) fn tb_view_watch_focus(
        view: *mut c_void,
        notify: unsafe extern "C" fn(*mut c_void),
        context: *mut c_void,
    );
    pub(crate) fn tb_view_unwatch_focus(view: *mut c_void);
    // The layer Chromium shows a page's picture in, which should be the view's size (panel.rs).
    pub(crate) fn tb_view_picture_size(
        view: *mut c_void,
        width: *mut f64,
        height: *mut f64,
    ) -> bool;
    // Who has a window's keyboard, and giving it back to GPUI's view.
    fn tb_view_keyboard_holder(view: *mut c_void) -> i32;
    fn tb_view_take_keyboard(view: *mut c_void) -> bool;
    fn tb_view_send_keys(view: *mut c_void, text: *const c_char);
    fn tb_view_send_shortcut(view: *mut c_void, code: u16, text: *const c_char, modifiers: u32);
    fn tb_view_send_click(view: *mut c_void, x: f64, y: f64) -> *mut c_char;
    fn free(ptr: *mut c_void);
    fn tb_popup_menu(
        view: *mut c_void,
        x: f64,
        y: f64,
        titles: *const *const c_char,
        symbols: *const *const c_char,
        tips: *const *const c_char,
        checked: *const bool,
        count: i32,
    ) -> i32;
    fn tb_main_bundle_identifier() -> *const c_char;
}

/// One item of a native menu: an empty title is a separator.
#[derive(Clone, Debug, Default)]
pub struct MenuItem {
    pub title: String,
    /// An SF Symbol's name, beside the title.
    pub symbol: String,
    pub tip: String,
    pub checked: bool,
}

/// A native menu at (x, y) in a window's view (GPUI's coordinates), for a
/// menu over a web page's view, which GPUI's own would draw under. Blocks
/// while it's open, so call it from a task, outside any update (as the app's
/// alerts are); returns the index of the item chosen.
///
/// # Safety
///
/// `view` must be null or an `NSView` that stays alive through the call (a
/// window's content view, as `native_view` gives it), and this must run on
/// the main thread, as AppKit needs.
pub unsafe fn popup_menu(view: *mut c_void, x: f32, y: f32, items: &[MenuItem]) -> Option<usize> {
    if view.is_null() || items.is_empty() {
        return None;
    }
    let text = |s: &str| CString::new(s.replace('\0', "")).unwrap_or_default();
    let titles: Vec<CString> = items.iter().map(|i| text(&i.title)).collect();
    let symbols: Vec<CString> = items.iter().map(|i| text(&i.symbol)).collect();
    let tips: Vec<CString> = items.iter().map(|i| text(&i.tip)).collect();
    let pointers = |v: &[CString]| v.iter().map(|s| s.as_ptr()).collect::<Vec<_>>();
    let (t, s, p) = (pointers(&titles), pointers(&symbols), pointers(&tips));
    let checked: Vec<bool> = items.iter().map(|i| i.checked).collect();
    // SAFETY: the caller guarantees `view` is a live NSView (null returned
    // above) and that we're on the main thread. Each of the four arrays has
    // items.len() entries, every string pointer comes from a CString held in
    // titles/symbols/tips, and all of them outlive this blocking call.
    let chosen = unsafe {
        tb_popup_menu(
            view,
            f64::from(x),
            f64::from(y),
            t.as_ptr(),
            s.as_ptr(),
            p.as_ptr(),
            checked.as_ptr(),
            items.len() as i32,
        )
    };
    usize::try_from(chosen).ok().filter(|i| *i < items.len())
}

/// Who has the keyboard in the window GPUI's view `view` fills.
///
/// # Safety
///
/// `view` must be null or an `NSView` that stays alive through the call (a
/// window's content view, as `native_view` gives it), and this must run on
/// the main thread, as AppKit needs.
pub unsafe fn keyboard_holder(view: *mut c_void) -> crate::KeyboardHolder {
    use crate::KeyboardHolder;
    if view.is_null() {
        return KeyboardHolder::Window;
    }
    // SAFETY: the caller guarantees `view` is a live NSView (null returned
    // above) and that we're on the main thread.
    match unsafe { tb_view_keyboard_holder(view) } {
        0 => KeyboardHolder::App,
        1 => KeyboardHolder::Page,
        2 => KeyboardHolder::Window,
        3 => KeyboardHolder::HiddenPage,
        _ => KeyboardHolder::Other,
    }
}

/// Gives GPUI's view `view` its window's keyboard; true if it moved.
///
/// # Safety
///
/// `view` must be null or an `NSView` that stays alive through the call (a
/// window's content view, as `native_view` gives it), and this must run on
/// the main thread, as AppKit needs.
pub unsafe fn take_keyboard(view: *mut c_void) -> bool {
    // SAFETY: only reached when `view` isn't null, and the caller guarantees
    // it's then a live NSView and that we're on the main thread.
    !view.is_null() && unsafe { tb_view_take_keyboard(view) }
}

/// A scripted app's typing: `text`'s keys handed to the window GPUI's view
/// `view` is in, which gives them to whoever has its keyboard.
///
/// # Safety
///
/// `view` must be null or an `NSView` that stays alive through the call (a
/// window's content view, as `native_view` gives it), and this must run on
/// the main thread, as AppKit needs.
pub unsafe fn send_keys(view: *mut c_void, text: &str) {
    let Ok(text) = CString::new(text) else { return };
    if !view.is_null() {
        // SAFETY: the caller guarantees the non-null `view` is a live NSView
        // and that we're on the main thread; `text` is a NUL-terminated
        // CString that outlives the call.
        unsafe { tb_view_send_keys(view, text.as_ptr()) };
    }
}

/// Sends a shortcut through AppKit. Modifier bits: command=1, control=2,
/// shift=4, option=8; `code` is its Mac virtual key code.
///
/// # Safety
/// `view` must be null or a live NSView for this call, on the main thread.
pub unsafe fn send_shortcut(view: *mut c_void, code: u16, text: &str, modifiers: u32) {
    let Ok(text) = CString::new(text) else { return };
    if !view.is_null() {
        // SAFETY: the caller guarantees a live main-thread view, and text
        // remains a valid NUL-terminated CString through the native call.
        unsafe { tb_view_send_shortcut(view, code, text.as_ptr(), modifiers) };
    }
}

/// A scripted app's click at (`x`, `y`) in the window GPUI's view `view`
/// fills (GPUI's coordinates), through AppKit as a person's click goes, so a
/// page's view under it gets it the way it gets a real one.
/// Says what AppKit hit there and where each page view is in the window.
///
/// # Safety
///
/// `view` must be null or an `NSView` that stays alive through the call (a
/// window's content view, as `native_view` gives it), and this must run on
/// the main thread, as AppKit needs.
pub unsafe fn send_click(view: *mut c_void, x: f32, y: f32) -> String {
    if view.is_null() {
        return String::new();
    }
    // SAFETY: the caller guarantees `view` is a live NSView (null returned
    // above) and that we're on the main thread. The shim returns null or a
    // strdup'd C string, which is read once and then freed exactly once.
    unsafe {
        let said = tb_view_send_click(view, f64::from(x), f64::from(y));
        if said.is_null() {
            return String::new();
        }
        let text = CStr::from_ptr(said).to_string_lossy().into_owned();
        free(said.cast());
        text
    }
}

/// cef::initialize has been called in this process. After that a failed
/// start is final: CEF says to exit without calling anything else of its,
/// and Chromium's own start can't run twice in a process.
static INITIALIZE_CALLED: AtomicBool = AtomicBool::new(false);

/// Chromium's own start has run in this process (`retry`).
pub fn initialize_called() -> bool {
    INITIALIZE_CALLED.load(Ordering::Acquire)
}

/// After a failed start, lets the next `start` try again, if Chromium's own
/// start never ran (the framework didn't load, the profile couldn't be
/// made). False when only a new process can try again.
pub fn retry() -> bool {
    if INITIALIZE_CALLED.load(Ordering::Acquire) {
        return false;
    }
    if matches!(status(), Status::Failed(_)) {
        set_status(Status::NotStarted);
    }
    true
}

/// Puts a line of ours in Chromium's log, which says nothing when it gives
/// up early (an empty web-runtime.log on 16 Nov, when a handover's two
/// copies wanted the same profile).
fn log_line(log_file: &std::path::Path, line: &str) {
    use std::io::Write as _;
    eprintln!("threadbear-web: {line}");
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    if let Ok(mut f) = threadbear_core::private_file::append(log_file) {
        let _ = writeln!(f, "[{secs} threadbear] {line}");
    }
}

/// Why cef::initialize said no, from CEF's exit code and the profile's lock.
fn initialize_failure(profile: &std::path::Path) -> String {
    let code = get_exit_code();
    let holder = threadbear_core::web_runtime::profile_lock_pid(profile);
    let in_use = code == sys::cef_resultcode_t::CEF_RESULT_CODE_PROFILE_IN_USE as i32
        || code == sys::cef_resultcode_t::CEF_RESULT_CODE_NORMAL_EXIT_PROCESS_NOTIFIED as i32;
    match (in_use, holder) {
        (true, Some(pid)) if pid != std::process::id() => format!("its profile was in use by another process (pid {pid}, another copy of Threadbear?), exit code {code}"),
        (true, _) => format!("its profile was in use, exit code {code}"),
        _ => format!("Chromium refused to start, exit code {code}"),
    }
}

/// What Chromium needs to find: the bundle the runtime is laid out in, the
/// framework and the first helper in it (all in the data folder,
/// web_runtime::Layout), its profile and its log.
pub struct Launch {
    pub bundle: PathBuf,
    pub framework: PathBuf,
    pub helper: PathBuf,
    pub profile: PathBuf,
    pub log_file: PathBuf,
}

/// The app's bundle id, for the helpers', or None outside a bundle (a cargo
/// build the specs start).
pub fn bundle_identifier() -> Option<String> {
    // SAFETY: the shim takes no arguments and only reads NSBundle's main
    // bundle, which is safe from any thread.
    let id = unsafe { tb_main_bundle_identifier() };
    // SAFETY: a non-null result is the UTF8String of the main bundle's
    // identifier, NUL-terminated, and copied out at once. It relies on that
    // NSString (held by the main bundle) staying alive until then.
    (!id.is_null()).then(|| unsafe { CStr::from_ptr(id) }.to_string_lossy().into_owned())
}

thread_local! {
    /// The start, waiting for the run-loop timer the shim sets.
    static PENDING: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
}

fn text(s: &std::path::Path) -> CefString {
    CefString::from(s.to_string_lossy().as_ref())
}

/// Starts Chromium, once per process. Returns at once: `status()` says when
/// it's ready, which is after the sealed pages' request context is set up too.
pub fn start(launch: Launch) -> Result<(), String> {
    match status() {
        Status::NotStarted => {}
        Status::Failed(why) => return Err(why),
        Status::Starting | Status::Ready => return Ok(()),
    }
    let binary = launch.framework.join("Chromium Embedded Framework");
    let path = CString::new(binary.to_string_lossy().into_owned())
        .map_err(|_| "the runtime's path has a NUL in it".to_owned())?;
    // SAFETY: `path` is a NUL-terminated CString that outlives the call,
    // which is all cef_load_library needs.
    if unsafe { super::loader_support::cef_load_library(path.as_ptr()) } != 1 {
        let why = format!(
            "the web runtime couldn't be loaded from {}: {}",
            binary.display(),
            super::loader_support::last_load_error().unwrap_or_else(|| "no reason given".into())
        );
        log_line(&launch.log_file, &why);
        set_status(Status::Failed(why.clone()));
        return Err(why);
    }
    // Before anything else: it says which version of the API this side was
    // built against (the versioned API CEF has had since 133).
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    // Before Chromium's pump exists (Ghostex: 2026-06-14 notes).
    // SAFETY: the shim takes no arguments and swizzles NSApplication once
    // (dispatch_once); start runs on the main thread like everything here.
    unsafe { tb_cef_install_app_hooks() };

    let args = Args::new();
    let mut app = BrowserApp::new();
    if execute_process(
        Some(args.as_main_args()),
        Some(&mut app),
        std::ptr::null_mut(),
    ) >= 0
    {
        // CEF took this for one of its own helpers: it never is, as they
        // have their own binary (threadbear-web-helper).
        let why = "the web runtime thought the app was one of its helpers".to_owned();
        set_status(Status::Failed(why.clone()));
        return Err(why);
    }
    if let Err(e) = std::fs::create_dir_all(&launch.profile) {
        let why = format!("couldn't make the web runtime's profile: {e}");
        log_line(&launch.log_file, &why);
        set_status(Status::Failed(why.clone()));
        return Err(why);
    }
    let (profile, log_file) = (launch.profile.clone(), launch.log_file.clone());
    let settings = Settings {
        // Chromium's own sandbox is off. On a Mac it lets a helper read only
        // inside the app bundle macOS started (the browser's real main
        // bundle; CEF's main_bundle_path below doesn't change that), and the
        // runtime lives in the data folder, so every sandboxed helper was
        // refused the framework ("file system sandbox blocked open()") and
        // Chromium gave up. The sealed pages keep their own rules
        // (sealed.rs), an agent's html runs no script at all, and the panels
        // show the sites a patch or Convex names. Turning it on means the
        // framework inside the app (the bundled choice), which is Mike's
        // call (docs/gpui-port.md, "Choice 1").
        no_sandbox: 1,
        // Chromium's "main bundle" is the runtime's (RUNTIME_BUNDLE in
        // web_runtime.rs says why), not the app's: its helpers and the
        // framework are in it, and the sandbox lets them read only that.
        main_bundle_path: text(&launch.bundle),
        browser_subprocess_path: text(&launch.helper),
        framework_dir_path: text(&launch.framework),
        // Chromium's loop nested in GPUI's (the shim says why), not an
        // external pump, and on this thread.
        external_message_pump: 0,
        multi_threaded_message_loop: 0,
        // The transcript's pages are drawn with no window (offscreen.rs).
        windowless_rendering_enabled: 1,
        root_cache_path: text(&launch.profile),
        // The panels' sign-ins live here; the sealed pages have a context of
        // their own that keeps nothing (sealed.rs).
        cache_path: text(&launch.profile.join("panels")),
        persist_session_cookies: 1,
        log_file: text(&launch.log_file),
        log_severity: LogSeverity::WARNING,
        ..Default::default()
    };
    set_status(Status::Starting);
    PENDING.with(|p| {
        *p.borrow_mut() = Some(Box::new(move || {
            let mut app = app;
            INITIALIZE_CALLED.store(true, Ordering::Release);
            if initialize(
                Some(args.as_main_args()),
                Some(&settings),
                Some(&mut app),
                std::ptr::null_mut(),
            ) != 1
            {
                let why = initialize_failure(&profile);
                log_line(&log_file, &format!("Chromium didn't start: {why}"));
                set_status(Status::Failed(why));
                return;
            }
            run_message_loop();
            // Nothing quits this loop while the app runs.
            eprintln!("threadbear-web: Chromium's message loop returned");
        }))
    });
    // SAFETY: the shim takes no arguments and only schedules a main run-loop
    // timer, guarding against a second start; we're on the main thread.
    unsafe { tb_cef_start_message_loop() };
    Ok(())
}

/// The run-loop timer's callout (the shim).
#[no_mangle]
pub extern "C" fn tb_cef_run_message_loop() {
    if let Some(start) = PENDING.with(|p| p.borrow_mut().take()) {
        start();
    }
}

/// Switches for the browser process. Chromium's helpers inherit what they
/// need from it.
fn browser_switches(command_line: &mut CommandLine) {
    // No Keychain prompt for Chromium's "Safe Storage" key, which an app
    // signed ad hoc would raise again after every build. Cookies are then
    // kept readable by your account only, as the Swift app's WebKit keeps
    // its own (docs/on-your-mac.md).
    // No background requests of Chromium's own (updates of its components,
    // variations, and so on): it goes online for the pages it shows.
    for switch in [
        "use-mock-keychain",
        "disable-background-networking",
        "disable-component-update",
        "no-pings",
    ] {
        command_line.append_switch(Some(&CefString::from(switch)));
    }
}

wrap_app! {
    struct BrowserApp;

    impl App {
        fn on_before_command_line_processing(&self, process_type: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            let browser = process_type.is_none_or(|t| t.to_string().is_empty());
            if let (true, Some(command_line)) = (browser, command_line) {
                browser_switches(command_line);
            }
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(BrowserProcess::new())
        }
    }
}

wrap_browser_process_handler! {
    struct BrowserProcess;

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            // Ready once the sealed pages' context has its rules on it.
            sealed::create_context();
        }
    }
}
