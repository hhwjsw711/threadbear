// The window that answers an agent's `show_options` (docs/protocol/events.md, "Design
// reviews"), a port of the Swift app's ReviewWindow.swift: the option on show
// big on the stage with a mark for every shot of every option under it, then
// all of them side by side; down the right, the options with their reasons,
// a tick for as many as Mike wants, one reply box and Send. Mike picked this
// layout on 4 Nov; before, he answered most reviews by typing in the thread.
//
// The rules (what can be sent, the draft's saves and their races, where the
// stage goes next, the zoom) are threadbear_core::review, with their tests;
// this draws them, makes the calls and does the waiting. The stage is
// review_window/stage.rs and the band under it, with the options' tabs, the
// words and the answer, review_window/band.rs.
//
// Its ways in: the review card's button (rows/cards.rs), a `review:` link in a
// reply or on an ask (rows/markdown.rs), and the bar over a thread with
// reviews waiting (header.rs, `pending_reviews_bar` here).
use crate::app::Threadbear;
use crate::call;
use crate::spinner::Spinner;
use crate::style::{self, px};
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Enter, InputEvent, Paste, TextareaState};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Icon, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use threadbear_client::runner::{Client, RpcError};
use threadbear_core::reducer::DesignReview;
use threadbear_core::review::{
    self as rules, DraftCache, ReviewMode, ReviewSession, SharedDraftCache, ZoomStep,
};

mod band;
mod canvas;
mod parts;
pub(crate) use band::inline_note;
mod reply_pictures;
mod stage;

/// The title bar's height: the Swift window's, a native one with its buttons
/// up in it. Not zoomed, as a native title bar isn't.
const TITLEBAR_HEIGHT: f32 = 32.;
/// Where the title starts, past the traffic lights.
const TITLE_X: f32 = 84.;

// ---------------------------------------------------------------- the open windows

/// Every open review window by "<thread>/<review>", the drafts kept on this
/// computer, and the bar's list of reviews waiting. A global rather than the
/// app's own fields: the windows outlive any one thread being open.
pub(crate) struct Reviews {
    windows: HashMap<String, (AnyWindowHandle, Entity<ReviewWindow>)>,
    /// What's typed and not yet saved to the runner, by thread and review (the
    /// Swift app's `reviewDraft.<thread>.<review>` defaults), so a draft
    /// survives a runner that's away, a closed window and a quit.
    drafts: SharedDraftCache,
    drafts_path: Option<PathBuf>,
    /// The bar's popover, while it's open: whose, and what `reviews.list` said.
    pending: Option<PendingList>,
}

impl Global for Reviews {}

/// A review's native page owns its Edit commands, even if GPUI still thinks
/// the reply box has focus. None means this is another kind of window.
pub(crate) fn edit_page_command(handle: AnyWindowHandle, command: &str, cx: &App) -> Option<bool> {
    let (_, view) = cx
        .try_global::<Reviews>()?
        .windows
        .values()
        .find(|(w, _)| *w == handle)?;
    let review = view.read(cx);
    Some(review.stage.page.as_ref().is_some_and(|(_, page)| {
        if page.hidden() || !page.has_keyboard() {
            return false;
        }
        page.edit(command);
        true
    }))
}

/// Runs before GPUI dispatches command/control keys through its last frame's
/// focus tree. Native CEF ownership wins even if that tree still names reply.
pub(crate) fn guard_page_shortcut(key: &Keystroke, window: &mut Window, cx: &mut App) {
    if !key.modifiers.platform && !key.modifiers.control {
        return;
    }
    let handle = window.window_handle();
    let view = cx.try_global::<Reviews>().and_then(|r| {
        r.windows
            .values()
            .find(|(w, _)| *w == handle)
            .map(|(_, v)| v.clone())
    });
    if let Some(view) = view {
        view.update(cx, |this, cx| this.release_reply_keys(window, cx));
    }
}

struct PendingList {
    thread_id: String,
    loading: bool,
    reviews: Vec<DesignReview>,
    error: Option<String>,
}

fn reviews(cx: &mut App) -> &mut Reviews {
    if !cx.has_global::<Reviews>() {
        // Beside the composer's drafts (drafts.rs), this app's own file.
        let path = threadbear_client::config::RunnerConfig::from_env()
            .home
            .join("desktop-review-drafts.json");
        let cache = std::fs::read(&path)
            .ok()
            .and_then(|data| serde_json::from_slice::<Value>(&data).ok())
            .map(|v| DraftCache::decode(&v))
            .unwrap_or_default();
        cx.set_global(Reviews {
            windows: HashMap::new(),
            drafts: std::rc::Rc::new(std::cell::RefCell::new(cache)),
            drafts_path: Some(path),
            pending: None,
        });
    }
    cx.global_mut::<Reviews>()
}

fn window_key(thread_id: &str, review_id: &str) -> String {
    format!("{thread_id}/{review_id}")
}

/// Writes the drafts kept here if they've changed: whole, renamed into place
/// and readable only by Mike's account, as the composer's are. Small enough
/// to write on each keystroke, as the Swift app writes its defaults.
fn write_drafts(cx: &mut App) {
    let reviews = reviews(cx);
    if !reviews.drafts.borrow_mut().take_changed() {
        return;
    }
    let Some(path) = reviews.drafts_path.clone() else {
        return;
    };
    let cache = reviews.drafts.borrow();
    let result = if cache.is_empty() {
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    } else {
        // Only this user's, the temp file too (`private_file`).
        threadbear_core::private_file::write(
            &path,
            &serde_json::to_vec(&cache.encode()).unwrap_or_default(),
        )
    };
    if let Err(e) = result {
        eprintln!("threadbear: couldn't save the review drafts: {e}");
    }
}

/// A `review.updated` from the runner for a thread with a window open on that
/// review (`receiveReview`): the window takes the newer copy whichever thread
/// the main window is showing.
pub(crate) fn receive_event(params: &Value, cx: &mut App) {
    let event = &params["event"];
    if event["type"].as_str() != Some("review.updated") {
        return;
    }
    let (Some(thread_id), Some(review)) = (
        params["threadId"].as_str(),
        DesignReview::decode(&event["review"]),
    ) else {
        return;
    };
    if !cx.has_global::<Reviews>() {
        return;
    }
    let open = reviews(cx)
        .windows
        .get(&window_key(thread_id, &review.id))
        .map(|(_, view)| view.clone());
    if let Some(view) = open {
        view.update(cx, |v, cx| v.receive(review, cx));
    }
}

/// A call to the runner that waits out one that's restarting (`ridingOutRestart`):
/// it updates itself several times a day and is gone a few seconds each time,
/// which isn't worth an error or a second press of Send. Trying again is safe:
/// an identical answer to a review already answered returns the first one.
async fn riding_out(
    client: Arc<Client>,
    method: &'static str,
    params: Value,
    cx: &mut AsyncApp,
) -> Result<Value, RpcError> {
    let deadline = Instant::now() + Duration::from_millis(rules::RECONNECT_WAIT_MS);
    loop {
        match call(client.clone(), method, params.clone()).await {
            Err(e) if rules::runner_away(e.code) && Instant::now() < deadline => {
                cx.background_executor()
                    .timer(Duration::from_millis(250))
                    .await
            }
            other => return other,
        }
    }
}

/// Whether a script drives this app (features/): its windows stay where they
/// are, as the Swift app's tuck themselves behind, and a review opening
/// mustn't come to the front and count as Mike looking.
fn scripted() -> bool {
    cfg!(feature = "automation") && std::env::var_os("THREADBEAR_AUTOMATION").is_some()
}

/// ⌘V on the window itself, so a paste with the keys outside the reply box
/// reaches `paste_in_reply`; in the box, the box's own binding comes first.
/// Bound once, for every review window.
fn bind_keys(cx: &mut App) {
    static BOUND: std::sync::Once = std::sync::Once::new();
    let chord = if cfg!(target_os = "macos") {
        "cmd-v"
    } else {
        "ctrl-v"
    };
    BOUND.call_once(|| {
        cx.bind_keys([KeyBinding::new(chord, Paste, Some("ReviewWindow"))]);
        // The kit has Control-A/E but no Mac kill-line binding. Keep this
        // one in the reply's Input context, outside the native page's path.
        #[cfg(target_os = "macos")]
        cx.bind_keys([KeyBinding::new(
            "ctrl-k",
            gpui_kit::component::input::DeleteToEndOfLine,
            Some("ReviewWindow > Input"),
        )]);
    });
}

impl Threadbear {
    /// `openReview`: the review's card, a `review:` link, or the bar over a
    /// thread with reviews waiting.
    pub(crate) fn open_review(
        &mut self,
        thread_id: &str,
        review: DesignReview,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_review_window(thread_id, review, None, window, cx);
    }

    /// The review in a window of its own, most of the screen (Mike, 30 Oct:
    /// beside the thread as a tab the images were too small to compare), or
    /// the one already open on it brought forward with this copy. `at`: the
    /// option and shot to open on, for a picture clicked on the review's
    /// card.
    /// A review that isn't among the thread's loaded rows, fetched from the
    /// runner by id and opened; one the runner hasn't got says so.
    pub(crate) fn open_review_by_id(
        &mut self,
        thread_id: &str,
        review_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (client, thread_id, review_id) = (
            self.client.clone(),
            thread_id.to_owned(),
            review_id.to_owned(),
        );
        cx.spawn_in(window, async move |this, cx| {
            let found = call(
                client,
                "reviews.get",
                json!({ "threadId": thread_id, "reviewId": review_id }),
            )
            .await;
            this.update_in(cx, |t, window, cx| {
                match found
                    .as_ref()
                    .ok()
                    .and_then(|v| DesignReview::decode(&v["review"]))
                {
                    Some(review) => t.open_review_window(&thread_id, review, None, window, cx),
                    None => {
                        let why = match &found {
                            Err(e) => e.message.clone(),
                            Ok(_) => "the runner hasn't got it".into(),
                        };
                        t.show_error(
                            format!("Couldn't open that review ({review_id}): {why}."),
                            cx,
                        )
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn open_review_window(
        &mut self,
        thread_id: &str,
        review: DesignReview,
        at: Option<(usize, usize)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Another Mac's review: its pictures and pages are files on that Mac,
        // read here they'd be whatever this Mac has at those paths, and its
        // answers would go to this Mac's runner, which hasn't got it.
        if let Some(runner) = self
            .threads
            .get(thread_id)
            .and_then(|t| t.runner_id.clone())
        {
            let name = self.runner_name_of(&runner);
            self.show_error(
                format!("This review is on {name}. Open it there for now."),
                cx,
            );
            return;
        }
        let key = window_key(thread_id, &review.id);
        if let Some((handle, view)) = reviews(cx).windows.get(&key).cloned() {
            let fresh = review.clone();
            let alive = handle
                .update(cx, |_, window, cx| {
                    view.update(cx, |v, cx| {
                        v.receive(fresh, cx);
                        if let Some((option, shot)) = at {
                            v.enlarge(option, shot, cx);
                        }
                    });
                    if !scripted() {
                        window.activate_window();
                    }
                })
                .is_ok();
            if alive {
                return;
            }
            reviews(cx).windows.remove(&key);
        }
        // On the screen Threadbear's in, not wherever the pointer is.
        let display = window.display(cx);
        let visible = display
            .as_ref()
            .map(|d| d.visible_bounds())
            .unwrap_or(Bounds {
                origin: point(gpui_kit::px(0.), gpui_kit::px(0.)),
                size: size(gpui_kit::px(1240. / 0.9), gpui_kit::px(860. / 0.9)),
            });
        let frame = rules::window_frame(threadbear_core::zoom::Rect {
            x: f64::from(visible.origin.x),
            y: f64::from(visible.origin.y),
            width: f64::from(visible.size.width),
            height: f64::from(visible.size.height),
        });
        let bounds = Bounds {
            origin: point(gpui_kit::px(frame.x as f32), gpui_kit::px(frame.y as f32)),
            size: size(
                gpui_kit::px(frame.width as f32),
                gpui_kit::px(frame.height as f32),
            ),
        };
        let thread = self.threads.get(thread_id).cloned();
        let parts = Parts {
            app: cx.entity().downgrade(),
            main: window.window_handle(),
            client: self.client.clone(),
            thread_id: thread_id.to_owned(),
            cwd: thread.map(|t| t.cwd.clone()).unwrap_or_default(),
            cache: reviews(cx).drafts.clone(),
        };
        let title: SharedString = review.title.clone().into();
        let app = cx.entity();
        // Opened once this update is over, as Settings is: `open_window` draws
        // the first frame there and then, and its drawing reads the app.
        cx.defer(move |cx| {
            let opened = gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    // The window's own strip is its title bar, with the
                    // buttons up in it as the Swift window has them.
                    titlebar: Some(TitlebarOptions {
                        title: Some(title),
                        appears_transparent: true,
                        traffic_light_position: Some(point(gpui_kit::px(9.), gpui_kit::px(9.))),
                    }),
                    app_owns_titlebar_drag: true,
                    focus: !scripted(),
                    display_id: display.map(|d| d.id()),
                    window_min_size: Some(size(
                        gpui_kit::px(rules::REVIEW_WINDOW_LEAST.0 as f32),
                        gpui_kit::px(rules::REVIEW_WINDOW_LEAST.1 as f32),
                    )),
                    app_id: Some("threadbear".into()),
                    ..Default::default()
                },
                cx,
                move |window, cx| {
                    cx.new(|cx| {
                        let mut opened = ReviewWindow::new(parts, review, window, cx);
                        if let Some((option, shot)) = at {
                            opened.enlarge(option, shot, cx);
                        }
                        opened
                    })
                },
            );
            match opened {
                Ok((handle, view)) => {
                    reviews(cx).windows.insert(key, (handle, view));
                }
                Err(e) => app.update(cx, |app, cx| {
                    app.show_error(format!("The review didn't open: {e}"), cx)
                }),
            }
        });
    }
}

impl crate::thread::ThreadPane {
    /// The review card's button (rows/cards.rs). Once this update is over,
    /// as a link can be followed from inside the app's own update (an ask's
    /// link, a script's `link`), when the app can't be updated again.
    pub(crate) fn open_review(
        &mut self,
        review: DesignReview,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_review_at(review, None, window, cx);
    }

    /// The same on one option, for its picture on the card.
    pub(crate) fn open_review_at(
        &mut self,
        review: DesignReview,
        option: Option<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(app) = self.composer.read(cx).app.upgrade() else {
            return;
        };
        let id = self.summary.id.clone();
        window.defer(cx, move |window, cx| {
            app.update(cx, |t, cx| {
                t.open_review_window(&id, review, option.map(|o| (o, 0)), window, cx)
            })
        });
    }

    /// A `review:` link in a reply or on an ask (`openReviewLink`): the
    /// thread's review with that id, or the only one it's the start of. One
    /// that isn't among the loaded rows says so, rather than the Swift app's
    /// beep, which left Mike wondering what happened.
    pub(crate) fn open_review_link(
        &mut self,
        rest: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = rules::link_review_id(rest) else {
            return;
        };
        match rules::find_review(&id, self.feed.model().rows()).cloned() {
            Some(review) => self.open_review(review, window, cx),
            // Its card has been paged out of a long thread: the runner still
            // has it (reviews.get), so open it from there. On 27 Nov a link
            // in a reply only said its card was further up, and Mike had to
            // ask what that meant.
            None => {
                if let Some(app) = self.composer.read(cx).app.upgrade() {
                    let thread_id = self.summary.id.clone();
                    window.defer(cx, move |window, cx| {
                        app.update(cx, |t, cx| t.open_review_by_id(&thread_id, &id, window, cx))
                    });
                }
            }
        }
    }
}

/// What a window needs from the app, handed over as it opens.
struct Parts {
    app: WeakEntity<Threadbear>,
    main: AnyWindowHandle,
    client: Arc<Client>,
    thread_id: String,
    cwd: String,
    cache: SharedDraftCache,
}

// ---------------------------------------------------------------- the window

pub(crate) struct ReviewWindow {
    app: WeakEntity<Threadbear>,
    /// The main window, for Show the thread this came from.
    main: AnyWindowHandle,
    /// Its own, to close it once the reply's sent.
    handle: AnyWindowHandle,
    client: Arc<Client>,
    pub(crate) session: ReviewSession,
    /// The thread's folder: a relative link in the agent's notes is from there.
    cwd: String,
    reply: Entity<TextareaState>,
    /// The draft last put in the box. A render can run before the box's
    /// Change event, so compare drafts before replacing text being edited.
    reply_synced: String,
    /// The pictures in the reply box (reply_pictures.rs).
    reply_pictures: reply_pictures::ReplyPictures,
    /// A picture that couldn't be read, to take out of the box at the next draw.
    pending_chip_removal: Vec<SharedString>,
    /// A picture came in: the draft takes the box at the next draw.
    reply_changed: bool,
    /// How many pictures the draft had when the box and it last agreed, as
    /// `reply_synced` is its words: a change to it is from elsewhere.
    pictures_synced: usize,
    /// The picture viewer over this window: a click on a picture's chip in
    /// the reply opens it full size (viewer.rs), as one in the thread's box does.
    viewer: crate::viewer::ViewerState,
    /// Holds the keys when the reply box hasn't got them: the arrows step,
    /// Space flicks to today's version, Return and Esc go in and out.
    focus: FocusHandle,
    /// The save a moment after the last edit (`scheduleSave`).
    save_timer: Option<Task<()>>,
    /// The save, send or cancel on its way: kept, as a dropped task stops.
    call_task: Option<Task<()>>,
    save_task: Option<Task<()>>,
    /// What the stage and its row under it hold between frames (stage.rs).
    pub(crate) stage: stage::StageState,
    /// The ... menu in the title bar is open.
    more_open: bool,
    tabs_scroll: ScrollHandle,
    /// The option whose tab was last scrolled to, so the tabs follow the stage.
    tabs_follow: Option<usize>,
    /// The review as a board (canvas.rs).
    pub(crate) canvas: Option<canvas::CanvasState>,
    /// The reply box on screen, from its last paint, for scripts that click
    /// in it.
    reply_box: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    closed: bool,
    _poll: Task<()>,
    _subs: Vec<Subscription>,
}

impl ReviewWindow {
    fn new(
        parts: Parts,
        review: DesignReview,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let session = ReviewSession::new(&parts.thread_id, review, parts.cache);
        let typed = session.draft().reply.clone().unwrap_or_default();
        // Its pictures as chips where their markers are.
        let mut reply_pictures = reply_pictures::ReplyPictures::default();
        let marks = session
            .draft()
            .marks
            .iter()
            .map(|m| reply_pictures::MarkChip {
                n: m.n,
                label: threadbear_core::review_canvas::mark_label(session.review(), m),
                image: m.image.as_ref().map(|i| i.path.clone()),
            })
            .collect();
        let content = reply_pictures.content_for(&typed, &session.draft().images, marks);
        let session_pictures = session.draft().images.len();
        let reply = cx.new(|cx| {
            let mut state = TextareaState::new(window, cx)
                .placeholder("Add a reply")
                .auto_grow(1, 8);
            state.set_value(content, window, cx);
            state
        });
        let mut subs = vec![cx.subscribe_in(
            &reply,
            window,
            |this, _, ev: &InputEvent, window, cx| match ev {
                InputEvent::Change => this.reply_to_draft(window, cx),
                InputEvent::Focus | InputEvent::Blur => cx.notify(),
                _ => {}
            },
        )];
        // In front, the app is: the main window's thread still reads as Mike
        // looks at it, as with Settings (`Threadbear::looking_changed`).
        let looking_app = parts.app.clone();
        subs.push(cx.observe_window_activation(window, move |_, window, cx| {
            let (key, active) = (crate::thread::window_key(window), window.is_window_active());
            if let Some(app) = looking_app.upgrade() {
                app.update(cx, |app, cx| app.looking_changed(key, active, cx));
            }
            cx.notify();
        }));
        // Closing it keeps the draft (`windowWillClose`): what's typed is kept
        // here already, and the last edit is saved to the runner if it can be.
        let me = cx.entity().downgrade();
        window.on_window_should_close(cx, move |window, cx| {
            crate::thread::set_looking(crate::thread::window_key(window), false);
            if let Some(me) = me.upgrade() {
                me.update(cx, |this, cx| this.closing(cx));
            }
            true
        });
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        crate::web_panels::keyboard_to_app(window);
        bind_keys(cx);
        // The latest copy now, then every few seconds while it waits: replies
        // from the phone or another window, when the thread's events aren't
        // coming to this app.
        let poll = cx.spawn(async move |this, cx| loop {
            let waiting = this.update(cx, |this, cx| {
                this.refresh(cx);
                this.session.review().is_pending()
            });
            if !matches!(waiting, Ok(true)) {
                return;
            }
            cx.background_executor()
                .timer(Duration::from_millis(rules::REFRESH_EVERY_MS))
                .await;
        });
        ReviewWindow {
            app: parts.app,
            main: parts.main,
            handle: window.window_handle(),
            client: parts.client,
            session,
            cwd: parts.cwd,
            reply,
            reply_synced: typed,
            reply_pictures,
            pending_chip_removal: Vec::new(),
            reply_changed: false,
            pictures_synced: session_pictures,
            viewer: crate::viewer::ViewerState::new(cx),
            focus,
            save_timer: None,
            call_task: None,
            save_task: None,
            stage: stage::StageState::default(),
            more_open: false,
            tabs_scroll: ScrollHandle::new(),
            tabs_follow: None,
            canvas: Some(canvas::CanvasState::new()),
            reply_box: Default::default(),
            closed: false,
            _poll: poll,
            _subs: subs,
        }
    }

    fn ids(&self) -> (String, String) {
        (
            self.session.thread_id.clone(),
            self.session.review().id.clone(),
        )
    }

    // ------------------------------------------------------------ the draft

    /// The draft changed: kept here at once, saved to the runner a moment
    /// after the last change.
    fn edited(&mut self, cx: &mut Context<Self>) {
        write_drafts(cx);
        if self.session.autosaves() {
            self.save_timer = Some(cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(rules::SAVE_AFTER_MS))
                    .await;
                this.update(cx, |this, cx| this.save_now(cx)).ok();
            }));
        }
        cx.notify();
    }

    pub(crate) fn pick(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.session.pick(id) {
            self.edited(cx);
        }
    }

    pub(crate) fn toggle_none(&mut self, cx: &mut Context<Self>) {
        if self.session.toggle_none() {
            self.edited(cx);
        }
    }

    /// The reply, as a script types it: through the box, so it shows there.
    fn set_reply(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.session.set_reply(text) {
            self.edited(cx);
        }
        self.sync_reply_box(window, cx);
    }

    /// The box shows the draft's reply when something other than typing
    /// changed it: the runner's copy from another window, or an answer.
    fn sync_reply_box(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let shown = self.session.shown_draft();
        let wanted = shown.reply.clone().unwrap_or_default();
        let images = shown.images.clone();
        // A changed runner draft or answer still wins over an unreported local
        // edit; a picture added or taken away elsewhere with the same words (a
        // reply of pictures alone) does too.
        // Against what was last agreed, not the box now, which a chip being
        // typed over (IME composing) has already lost (Codex's review).
        let pictures_changed = self.pictures_synced != images.len();
        if self.reply_synced != wanted || pictures_changed {
            let same = self
                .reply_pictures
                .draft_of(self.reply.read(cx))
                .is_some_and(|(reply, now, _)| reply == wanted && now == images);
            if !same {
                let marks = self.mark_chips();
                let content = self.reply_pictures.content_for(&wanted, &images, marks);
                self.reply
                    .update(cx, |s, cx| s.set_value(content, window, cx));
            }
            self.reply_synced = wanted;
            self.pictures_synced = images.len();
        } else {
            // A save's answer names the runner's own copies of the same pictures.
            self.reply_pictures.adopt(self.reply.read(cx), &images);
        }
        let editable = self.session.editable();
        self.reply.update(cx, |s, cx| s.set_disabled(!editable, cx));
    }

    /// `saveNow`: what's here to the runner, if a save is due.
    pub(crate) fn save_now(&mut self, cx: &mut Context<Self>) {
        let Some(sent) = self.session.begin_save() else {
            return;
        };
        self.save_timer = None;
        let (thread_id, review_id) = self.ids();
        let client = self.client.clone();
        cx.notify();
        self.save_task = Some(cx.spawn(async move |this, cx| {
            let params = json!({ "threadId": thread_id, "reviewId": review_id, "revision": sent.revision, "draft": sent.draft.to_json() });
            match riding_out(client.clone(), "reviews.save", params, cx).await {
                Ok(v) => {
                    let saved = DesignReview::decode(&v["review"]);
                    this.update(cx, |this, _| match saved {
                        Some(saved) => this.session.save_done(saved),
                        None => this.session.save_failed("The runner's answer didn't make sense."),
                    })
                    .ok();
                }
                Err(e) => {
                    this.update(cx, |this, _| this.session.save_failed(&e.message)).ok();
                    let latest = call(client, "reviews.get", json!({ "threadId": thread_id, "reviewId": review_id })).await.ok().and_then(|v| DesignReview::decode(&v["review"]));
                    if let Some(latest) = latest {
                        this.update(cx, |this, _| this.session.save_failed_then_loaded(&sent, latest)).ok();
                    }
                }
            }
            this.update(cx, |this, cx| {
                write_drafts(cx);
                // A newer edit may have come while it was on its way.
                if this.session.save_again() {
                    this.edited(cx);
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Save my draft: what's here, over the copy that changed elsewhere.
    fn keep_my_draft(&mut self, cx: &mut Context<Self>) {
        if self.session.keep_my_draft() {
            self.save_now(cx);
            cx.notify();
        }
    }

    /// The latest copy from the runner. Says nothing while it's restarting:
    /// it polls again in a few seconds.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let (thread_id, review_id) = self.ids();
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let res = call(
                client,
                "reviews.get",
                json!({ "threadId": thread_id, "reviewId": review_id }),
            )
            .await;
            this.update(cx, |this, cx| {
                match res {
                    Ok(v) => {
                        if let Some(latest) = DesignReview::decode(&v["review"]) {
                            this.receive(latest, cx);
                        }
                    }
                    Err(e) => this.session.refresh_failed(e.code, &e.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A newer copy: the card's event, a poll, the window opened again.
    fn receive(&mut self, latest: DesignReview, cx: &mut Context<Self>) {
        if self.session.review().id != latest.id || self.session.review().options != latest.options
        {
            self.canvas_stop_playing(cx);
            self.canvas = Some(canvas::CanvasState::new());
            self.drop_page(cx);
        }
        self.session.receive(latest);
        write_drafts(cx);
        cx.notify();
    }

    // ------------------------------------------------------------ sending

    /// Send: nothing more can be typed or sent while it goes, and once it's
    /// sent the window gets out of the way (Mike, 28 Oct). A failed send stays
    /// open with its error and the draft kept.
    pub(crate) fn submit(&mut self, cx: &mut Context<Self>) {
        // A picture still on its way in would be left out.
        if self.reply_loading(cx) || !self.session.begin_submit() {
            return;
        }
        self.save_timer = None;
        let (thread_id, review_id) = self.ids();
        let client = self.client.clone();
        cx.notify();
        self.call_task = Some(cx.spawn(async move |this, cx| {
            // A save already on its way owns the revision.
            while this.read_with(cx, |this, _| this.session.saving()).unwrap_or(false) {
                cx.background_executor().timer(Duration::from_millis(10)).await;
            }
            let Ok(Some(sent)) = this.update(cx, |this, cx| {
                cx.notify();
                this.session.send_call()
            }) else {
                return;
            };
            let params = json!({ "threadId": thread_id, "reviewId": review_id, "revision": sent.revision, "draft": sent.draft.to_json() });
            match riding_out(client.clone(), "reviews.respond", params, cx).await {
                Ok(v) => {
                    let answered = DesignReview::decode(&v["review"]);
                    this.update(cx, |this, cx| {
                        match answered {
                            Some(answered) => this.session.submit_done(answered),
                            None => this.session.submit_failed_then_loaded(&sent, None),
                        }
                        write_drafts(cx);
                        if this.session.review().status == "answered" {
                            this.close(cx);
                        }
                        cx.notify();
                    })
                    .ok();
                }
                Err(e) => {
                    this.update(cx, |this, _| this.session.submit_failed(&e.message)).ok();
                    let latest = call(client, "reviews.get", json!({ "threadId": thread_id, "reviewId": review_id })).await.ok().and_then(|v| DesignReview::decode(&v["review"]));
                    this.update(cx, |this, cx| {
                        this.session.submit_failed_then_loaded(&sent, latest);
                        write_drafts(cx);
                        cx.notify();
                    })
                    .ok();
                }
            }
        }));
    }

    /// Cancel review, once it's been confirmed: the agent gets no reply, and
    /// the images can still be looked at.
    fn cancel_review(&mut self, cx: &mut Context<Self>) {
        if !self.session.begin_cancel() {
            return;
        }
        self.save_timer = None;
        let (thread_id, review_id) = self.ids();
        let client = self.client.clone();
        cx.notify();
        self.call_task = Some(cx.spawn(async move |this, cx| {
            while this
                .read_with(cx, |this, _| this.session.saving())
                .unwrap_or(false)
            {
                cx.background_executor()
                    .timer(Duration::from_millis(10))
                    .await;
            }
            let Ok(revision) = this.read_with(cx, |this, _| this.session.cancel_revision()) else {
                return;
            };
            let res = riding_out(
                client,
                "reviews.cancel",
                json!({ "threadId": thread_id, "reviewId": review_id, "revision": revision }),
                cx,
            )
            .await;
            this.update(cx, |this, cx| {
                match res.map(|v| DesignReview::decode(&v["review"])) {
                    Ok(Some(cancelled)) => this.session.cancel_done(cancelled),
                    Ok(None) => this
                        .session
                        .cancel_failed("The runner's answer didn't make sense."),
                    Err(e) => this.session.cancel_failed(&e.message),
                }
                write_drafts(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// Asks first, as the Swift window's confirmation does.
    fn confirm_cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.more_open = false;
        let answers = [
            PromptButton::cancel("Keep it"),
            PromptButton::new("Cancel review"),
        ];
        let answer = window.prompt(
            PromptLevel::Warning,
            "Cancel this review?",
            Some("The agent won\u{2019}t get a reply. You can still look at the images."),
            &answers,
            cx,
        );
        cx.spawn(async move |this, cx| {
            if let Ok(1) = answer.await {
                this.update(cx, |this, cx| this.cancel_review(cx)).ok();
            }
        })
        .detach();
        cx.notify();
    }

    // ------------------------------------------------------------ closing

    /// The window's going (its red button): its last edit is saved, and the
    /// window stays alive until that's done, as the save needs it.
    fn closing(&mut self, cx: &mut Context<Self>) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.canvas_stop_playing(cx);
        self.drop_page(cx);
        // Its clips stop and go with it.
        crate::media_view::close_window(self.handle.window_id());
        let key = window_key(&self.session.thread_id, &self.session.review().id);
        reviews(cx).windows.remove(&key);
        self.save_now(cx);
        write_drafts(cx);
        let keep = cx.entity();
        cx.spawn(async move |_, cx| {
            while keep.read_with(cx, |this, _| this.session.saving()) {
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
            }
            drop(keep);
        })
        .detach();
    }

    /// Closes it from here: Done, Send, a script.
    pub(crate) fn close(&mut self, cx: &mut Context<Self>) {
        self.closing(cx);
        let handle = self.handle;
        cx.defer(move |cx| {
            handle
                .update(cx, |_, window, _| {
                    crate::thread::set_looking(crate::thread::window_key(window), false);
                    window.remove_window();
                })
                .ok();
        });
    }

    /// Show the thread this came from: picked in the main window, which comes
    /// to the front.
    fn show_thread(&mut self, cx: &mut Context<Self>) {
        let (Some(app), id) = (self.app.upgrade(), self.session.thread_id.clone()) else {
            return;
        };
        let main = self.main;
        cx.defer(move |cx| {
            main.update(cx, |_, window, cx| {
                app.update(cx, |t, cx| {
                    t.reveal_thread(&id, cx);
                    t.open(id.clone(), window, cx);
                });
                if !scripted() {
                    window.activate_window();
                }
            })
            .ok();
        });
    }

    // ------------------------------------------------------------ the stage

    /// Asks the shot on show to zoom (the title bar's button, the zoom keys).
    pub(crate) fn zoom(&mut self, step: ZoomStep, cx: &mut Context<Self>) {
        self.session.zoom(step);
        self.stage.zoom_requested(step);
        self.after_zoom();
        cx.notify();
    }

    /// `session.zoomed` follows the stage, which the title bar's button and
    /// Esc read.
    fn after_zoom(&mut self) {
        self.session.zoomed = self.session.mode == ReviewMode::Single && self.stage.is_zoomed();
    }

    pub(crate) fn browse(&mut self, direction: i32, cx: &mut Context<Self>) {
        if self.on_canvas() {
            self.canvas_step(direction, cx);
            return;
        }
        self.session.browse(direction);
        self.after_move(cx);
    }

    pub(crate) fn jump(&mut self, direction: i32, cx: &mut Context<Self>) {
        if self.on_canvas() {
            self.canvas_jump(direction, cx);
            return;
        }
        self.session.jump(direction);
        self.after_move(cx);
    }

    pub(crate) fn enlarge(&mut self, index: usize, shot: usize, cx: &mut Context<Self>) {
        if self.on_canvas() {
            self.canvas_go_shot(index, shot, cx);
            return;
        }
        self.session.enlarge(index, shot);
        self.after_move(cx);
    }

    pub(crate) fn show_all(&mut self, cx: &mut Context<Self>) {
        if self.on_canvas() {
            self.canvas_everything(cx);
            return;
        }
        self.session.show_all();
        self.after_move(cx);
    }

    /// The board is what's on show, not a clip or page on the stage.
    pub(crate) fn on_canvas(&self) -> bool {
        self.canvas.is_some()
    }

    fn after_move(&mut self, cx: &mut Context<Self>) {
        self.after_zoom();
        cx.notify();
    }

    pub(crate) fn set_peeking(&mut self, on: bool, cx: &mut Context<Self>) {
        let on = on && self.session.can_peek();
        if self.session.peeking != on {
            self.session.peeking = on;
            cx.notify();
        }
    }

    /// Hide before dropping, then reclaim native focus outside this window's
    /// current borrow. A GPUI focus handle alone cannot reclaim AppKit keys.
    fn drop_page(&mut self, cx: &mut Context<Self>) {
        self.stage.page_events = None;
        if let Some((_, page)) = self.stage.page.take() {
            page.set_hidden(true);
            let handle = self.handle;
            cx.defer(move |cx| {
                handle
                    .update(cx, |_, window, _| {
                        crate::web_panels::keyboard_to_app(window)
                    })
                    .ok();
            });
        }
    }

    fn page_has_keys(&self) -> bool {
        self.stage
            .page
            .as_ref()
            .is_some_and(|(_, page)| !page.hidden() && page.has_keyboard())
    }

    /// Only GPUI focus moves: the browser retains AppKit's first responder.
    fn release_reply_keys(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.page_has_keys() && self.reply_focused(window, cx) {
            window.focus(&self.focus, cx);
            cx.notify();
        }
    }

    pub(super) fn canvas_stop_playing(&mut self, cx: &mut Context<Self>) {
        if let Some(c) = self.canvas.as_mut() {
            c.playing.stop();
        }
        self.drop_page(cx);
        cx.notify();
    }

    // ------------------------------------------------------------ keys

    /// The window's keys, outside the reply box, which keeps its own arrows
    /// and Return (`ReviewNativeWindow.keyDown`); browsing works at once,
    /// without first clicking the stage.
    fn key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let m = &ev.keystroke.modifiers;
        // ⌘W closes it, from the reply box too, as File > Close does the
        // Swift window; the draft's kept.
        if m.platform && !m.shift && !m.control && !m.alt && ev.keystroke.key == "w" {
            self.close(cx);
            cx.stop_propagation();
            return;
        }
        if self.page_has_keys() {
            self.release_reply_keys(window, cx);
            if !m.platform && !m.control && !m.alt && ev.keystroke.key == "escape" {
                self.canvas_stop_playing(cx);
                crate::web_panels::keyboard_to_app(window);
                cx.stop_propagation();
            }
            return;
        }
        if self.reply_focused(window, cx) || m.control || m.alt {
            return;
        }
        if m.platform {
            // ⌘Return sends, wherever the cursor is (the box's own is caught
            // before it makes a new line, in `render`).
            if ev.keystroke.key == "enter" && !m.shift {
                self.submit(cx);
                cx.stop_propagation();
            }
            return;
        }
        if self.on_canvas() && self.canvas_key(ev.keystroke.key.as_str(), cx) {
            cx.stop_propagation();
            return;
        }
        match ev.keystroke.key.as_str() {
            // Held, today's version over the shot on show (Mike, 4 Nov).
            "space" => {
                if !ev.is_held {
                    self.set_peeking(true, cx);
                }
            }
            "left" => self.browse(-1, cx),
            "right" => self.browse(1, cx),
            "up" => self.jump(-1, cx),
            "down" => self.jump(1, cx),
            "enter" => {
                if self.session.mode == ReviewMode::Single {
                    self.show_all(cx);
                } else {
                    self.browse(0, cx);
                }
            }
            // Out of a zoom, then out to all of them.
            "escape" if self.session.mode == ReviewMode::Single => {
                if self.stage.is_zoomed() {
                    self.zoom(ZoomStep::Fit, cx);
                } else {
                    self.show_all(cx);
                }
            }
            _ => return,
        }
        cx.stop_propagation();
    }

    fn key_up(&mut self, ev: &KeyUpEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if ev.keystroke.key == "space" {
            self.set_peeking(false, cx);
        }
    }

    /// ⌘V with the keys on the window rather than the reply box (on open,
    /// after a tick or a press on the stage) puts the words in the box, and
    /// the cursor with them. Voice Type pastes what Mike says with ⌘V into
    /// whatever has the keys, and he ticks an option and talks straight away:
    /// nothing here took the paste, so the words went nowhere (12 Nov).
    fn paste_in_reply(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // In the box already, the paste was the box's own to take.
        if self.page_has_keys() || !self.session.editable() || self.reply_focused(window, cx) {
            return;
        }
        let clipboard = cx.read_from_clipboard();
        let handle = self.reply.read(cx).focus_handle(cx);
        // A picture goes in as its chip, as it would pasted in the box.
        if self.take_reply_clipboard(clipboard.as_ref(), window, cx) {
            return;
        }
        let Some(words) = clipboard.and_then(|c| c.text()).filter(|w| !w.is_empty()) else {
            return;
        };
        window.focus(&handle, cx);
        crate::web_panels::keyboard_to_app(window);
        // Replace its selection, or insert at its cursor, as its own Paste does.
        self.reply.update(cx, |s, cx| s.replace(words, window, cx));
        // Save and Send must see the paste before the box's Change arrives.
        self.reply_to_draft(window, cx);
    }

    fn reply_focused(&self, window: &Window, cx: &App) -> bool {
        self.reply.read(cx).focus_handle(cx).is_focused(window)
    }

    /// A press on the stage takes the keys from the reply box, so the arrows
    /// step again.
    pub(crate) fn take_keys(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus.is_focused(window) {
            window.focus(&self.focus, cx);
        }
        crate::web_panels::keyboard_to_app(window);
    }

    // ------------------------------------------------------------ drawing

    fn render_titlebar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let active = window.is_window_active();
        let secondary = style::secondary_text(cx);
        let title_color = if active {
            style::label_text(cx)
        } else {
            secondary
        };
        let single = self.session.mode == ReviewMode::Single;
        let mut buttons = h_flex()
            .flex_none()
            .gap(gpui_kit::px(4.))
            .pr(gpui_kit::px(10.))
            .items_center();
        if single {
            buttons = buttons.child(titlebar_button(
                "review-see-all",
                Icon::new(IconName::LayoutGrid),
                "See them all (Esc)",
                secondary,
                cx.listener(|this, _: &ClickEvent, _, cx| this.show_all(cx)),
            ));
            // A video or a page has its own ways of moving round; zoom is for pictures.
            if self.session.shown_shot().is_some_and(|s| s.media.is_none()) {
                let zoomed = self.session.zoomed;
                let (icon, tip) = if zoomed {
                    (IconName::ZoomOut, "Fit the image in its space (\u{2318}0)")
                } else {
                    (
                        IconName::ZoomIn,
                        "Show at full size. Scroll or pinch to zoom, drag to move around",
                    )
                };
                buttons = buttons.child(titlebar_button(
                    "review-zoom",
                    Icon::new(icon),
                    tip,
                    secondary,
                    cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.zoom(
                            if zoomed {
                                ZoomStep::Fit
                            } else {
                                ZoomStep::Actual
                            },
                            cx,
                        )
                    }),
                ));
            }
        }
        buttons = buttons.child(titlebar_button(
            "review-back",
            Icon::new(IconName::ArrowUpLeft),
            "Show the thread this came from",
            secondary,
            cx.listener(|this, _: &ClickEvent, _, cx| this.show_thread(cx)),
        ));
        if self.session.review().is_pending() {
            buttons = buttons.child(titlebar_button(
                "review-more",
                Icon::new(IconName::Ellipsis),
                "More",
                secondary,
                cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.more_open = !this.more_open;
                    cx.notify();
                }),
            ));
        }
        h_flex()
            .id("review-titlebar")
            .relative()
            .flex_none()
            .w_full()
            .h(gpui_kit::px(TITLEBAR_HEIGHT))
            .items_center()
            // The strip moves the window and a double click zooms it, as a
            // title bar does.
            .on_mouse_down(MouseButton::Left, |e: &MouseDownEvent, window, _| {
                if e.click_count == 2 {
                    window.zoom_window();
                } else {
                    window.start_window_move();
                }
            })
            .child(div().flex_none().w(gpui_kit::px(TITLE_X)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(gpui_kit::px(13.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(title_color)
                    .child(self.session.review().title.clone()),
            )
            .child(buttons)
            .when(self.more_open, |s| {
                s.child(self.render_more_menu(window, cx))
            })
            .into_any_element()
    }

    /// The ... menu: Cancel review, while it's waiting.
    fn render_more_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let (bg, border) = (cx.theme().popover, cx.theme().border);
        let hover = style::hover_fill(cx);
        let red = style::failed(cx);
        // Under the ... button, its right edge on the window's 10 in.
        let at = point(
            window.viewport_size().width - gpui_kit::px(10.),
            gpui_kit::px(TITLEBAR_HEIGHT - 2.),
        );
        deferred(
            anchored().anchor(Anchor::TopRight).position(at).child(
                div().child(
                    div()
                        .id("review-more-menu")
                        .occlude()
                        .p(gpui_kit::px(5.))
                        .rounded(gpui_kit::px(8.))
                        .bg(bg)
                        .border_1()
                        .border_color(border)
                        .shadow_lg()
                        .on_mouse_down_out(cx.listener(|this, _: &MouseDownEvent, _, cx| {
                            this.more_open = false;
                            cx.notify();
                        }))
                        .child(
                            crate::highlights::tipped(
                                h_flex()
                                    .id("review-cancel")
                                    .gap(gpui_kit::px(7.))
                                    .px(gpui_kit::px(9.))
                                    .h(gpui_kit::px(24.))
                                    .items_center()
                                    .rounded(gpui_kit::px(5.))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(hover)),
                                "Close the review without a reply to the agent",
                            )
                            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                                this.confirm_cancel(window, cx)
                            }))
                            .child(
                                Icon::new(IconName::CircleX)
                                    .with_size(gpui_kit::px(13.))
                                    .text_color(red),
                            )
                            .child(
                                div()
                                    .text_size(gpui_kit::px(13.))
                                    .text_color(red)
                                    .child("Cancel review"),
                            ),
                        ),
                ),
            ),
        )
        .with_priority(2)
        .into_any_element()
    }

    /// What went wrong with a save or a send, over everything, with the way out
    /// (`session.error`): Save my draft over another copy, or try again.
    fn render_error_bar(&mut self, error: String, cx: &mut Context<Self>) -> AnyElement {
        let pending = self.session.review().is_pending();
        let saving = self.session.saving();
        let button = if self.session.conflict() && pending {
            Some((
                "review-keep-mine",
                "Save my draft",
                "Keep what you have here, over the copy that changed elsewhere",
                true,
            ))
        } else if pending {
            Some((
                "review-save-again",
                "Try saving again",
                "Save the draft to the runner again",
                false,
            ))
        } else {
            None
        };
        h_flex()
            .flex_none()
            .p(px(12.))
            .gap(px(8.))
            .items_center()
            .bg(style::needs_you(cx).opacity(0.1))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(style::size::DETAIL))
                    .line_height(px(style::natural_line(style::size::DETAIL)))
                    .child(error),
            )
            .when_some(button, |s, (id, title, tip, mine)| {
                s.child(
                    plain_button(id, title, tip, saving, cx).on_click(cx.listener(
                        move |this, _: &ClickEvent, _, cx| {
                            if mine {
                                this.keep_my_draft(cx);
                            } else {
                                this.save_now(cx);
                            }
                        },
                    )),
                )
            })
            .into_any_element()
    }

    /// Media problems survive review refreshes and never offer a draft retry.
    fn render_media_notice(&mut self, notice: String, cx: &mut Context<Self>) -> AnyElement {
        h_flex()
            .flex_none()
            .p(px(12.))
            .gap(px(8.))
            .items_center()
            .bg(style::needs_you(cx).opacity(0.1))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(style::size::DETAIL))
                    .child(notice),
            )
            .child(
                plain_button(
                    "review-dismiss-media",
                    "Dismiss",
                    "Dismiss this media notice",
                    false,
                    cx,
                )
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.stage.notice = None;
                    cx.notify();
                })),
            )
            .into_any_element()
    }

    /// No options at all (`ContentUnavailableView`).
    fn render_empty(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let secondary = style::secondary_text(cx);
        v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap(px(10.))
            .child(
                Icon::new(IconName::Image)
                    .with_size(px(36.))
                    .text_color(secondary),
            )
            .child(
                div()
                    .text_size(px(17.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("No images to compare"),
            )
            .into_any_element()
    }
}

/// One of the title bar's buttons: a grey symbol in a 26 by 24 frame.
fn titlebar_button(
    id: &'static str,
    icon: Icon,
    tip: &'static str,
    color: Hsla,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    crate::highlights::tipped(
        div()
            .id(id)
            .w(gpui_kit::px(26.))
            .h(gpui_kit::px(24.))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer(),
        tip,
    )
    // Not the strip's window move.
    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
    .on_click(on_click)
    .child(icon.with_size(gpui_kit::px(15.)).text_color(color))
    .into_any_element()
}

/// A standard push button (`Button` with no style): a rounded fill, and a
/// spinner while what it started is on its way, when it takes no clicks.
pub(crate) fn plain_button(
    id: &'static str,
    title: &str,
    tip: &'static str,
    busy: bool,
    cx: &App,
) -> gpui_kit::base::ObservedElement<Stateful<Div>> {
    let secondary = style::secondary_text(cx);
    let fill = style::primary_opacity(cx, 0.1);
    crate::highlights::tipped(
        h_flex()
            .id(id)
            .flex_none()
            .h(px(22.))
            .px(px(10.))
            .gap(px(6.))
            .items_center()
            .rounded(px(6.))
            .bg(fill)
            .text_size(px(style::size::LABEL))
            .when(!busy, |s| s.cursor_pointer())
            .when(busy, |s| {
                s.opacity(0.6)
                    .child(Spinner::new().color(secondary).with_size(px(11.)))
            }),
        tip,
    )
    .child(title.to_owned())
}

impl crate::viewer::HostsViewer for ReviewWindow {
    fn viewer_state(&mut self) -> &mut crate::viewer::ViewerState {
        &mut self.viewer
    }
    fn viewer_client(&self) -> Arc<Client> {
        self.client.clone()
    }
}

impl Render for ReviewWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // First, as it counts the frame the stage's clips are drawn in
        // (media_view.rs); they hide while the title bar's menu is up.
        // A clip on the stage is a view of its own over the window, so it
        // hides under the picture viewer as it does under the menu.
        let viewing = self.viewer.is_open();
        let clips = crate::media_view::sweeper(
            window,
            crate::media_view::Cover {
                everything: self.more_open || viewing,
                menus: Vec::new(),
            },
        );
        if std::mem::take(&mut self.reply_changed) {
            self.reply_to_draft(window, cx);
        }
        self.sync_reply_box(window, cx);
        // CEF keeps AppKit's keys; remove the reply's GPUI key context so
        // command/control shortcuts cannot edit or submit a hidden draft.
        self.release_reply_keys(window, cx);
        // A page's view goes once its shot isn't the one on show.
        let page_shown = self.session.mode == ReviewMode::Single
            && self
                .session
                .shown_shot()
                .is_some_and(|s| s.page().is_some());
        // On the board, the page is the one playing there (canvas_player).
        let page_shown = if self.on_canvas() {
            self.canvas_playing_shot()
                .is_some_and(|s| s.page().is_some())
        } else {
            page_shown
        };
        if !page_shown {
            self.drop_page(cx);
        }
        // The tab of the option on show stays in view as the stage moves:
        // the first of them is the one for all of them.
        if self.session.mode == ReviewMode::Single
            && self.tabs_follow != Some(self.session.focused())
        {
            self.tabs_follow = Some(self.session.focused());
            self.tabs_scroll.scroll_to_item(1 + self.session.focused());
        } else if self.session.mode == ReviewMode::All {
            self.tabs_follow = None;
        }
        let error = self.session.error.clone();
        // The stage across the whole window and the words under it: a wide
        // mockup is as tall as the window lets it be, so a column beside it
        // took a quarter of its size and left room over and under (Mike
        // picked this over the column and an all-at-once board, 21 Nov).
        let body = if self.session.review().options.is_empty() {
            self.render_empty(cx)
        } else if self.on_canvas() {
            v_flex()
                .flex_1()
                .min_h_0()
                .w_full()
                .child(self.render_canvas(window, cx))
                .child(
                    div()
                        .flex_none()
                        .w_full()
                        .h(gpui_kit::px(1.))
                        .bg(style::hairline(cx)),
                )
                .child(self.render_band(window, cx))
                .into_any_element()
        } else {
            v_flex()
                .flex_1()
                .min_h_0()
                .w_full()
                .child(self.render_stage(window, cx))
                .child(
                    div()
                        .flex_none()
                        .w_full()
                        .h(gpui_kit::px(1.))
                        .bg(style::hairline(cx)),
                )
                .child(self.render_band(window, cx))
                .into_any_element()
        };
        let titlebar = self.render_titlebar(window, cx);
        let notice = self.stage.notice.clone();
        v_flex()
            .id("review-window")
            .key_context("ReviewWindow")
            .track_focus(&self.focus)
            .size_full()
            .bg(cx.theme().background)
            .text_color(style::label_text(cx))
            .on_key_down(cx.listener(Self::key_down))
            .on_key_up(cx.listener(Self::key_up))
            // ⌘Return in the reply box sends rather than making a new line.
            .capture_action(cx.listener(|this, action: &Enter, window, cx| {
                if action.secondary {
                    if this.page_has_keys() {
                        this.release_reply_keys(window, cx);
                    } else {
                        this.submit(cx);
                        cx.stop_propagation();
                    }
                }
            }))
            // A paste nothing else took goes in the reply box.
            .on_action(cx.listener(|this, _: &Paste, window, cx| this.paste_in_reply(window, cx)))
            // On a shot, the View menu's zoom keys zoom the shot rather than
            // the app's text, as they do in Preview.
            .on_action(cx.listener(|this, _: &crate::shell::ZoomIn, _, cx| {
                if this.session.mode == ReviewMode::Single {
                    this.zoom(ZoomStep::Closer, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &crate::shell::ZoomOut, _, cx| {
                if this.session.mode == ReviewMode::Single {
                    this.zoom(ZoomStep::Further, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &crate::shell::ActualSize, _, cx| {
                if this.session.mode == ReviewMode::Single {
                    this.zoom(ZoomStep::Fit, cx);
                }
            }))
            // The app's own keys, which the main window handles for itself.
            .on_action(|_: &crate::shell::QuitApp, _, cx| cx.quit())
            .on_action(|_: &crate::shell::HideApp, _, cx| cx.hide())
            .on_action(|_: &crate::shell::HideOtherApps, _, cx| cx.hide_other_apps())
            .on_action(|_: &crate::shell::MinimizeWindow, window, _| window.minimize_window())
            // A drag that started on the stage follows the pointer anywhere
            // in the window.
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, window, cx| {
                this.stage_dragged(ev, window, cx)
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _: &MouseUpEvent, _, cx| this.stage_released(cx)),
            )
            .child(titlebar)
            .when_some(error, |s, e| s.child(self.render_error_bar(e, cx)))
            .when_some(notice, |s, n| s.child(self.render_media_notice(n, cx)))
            .child(body)
            .child(clips)
            .children(crate::viewer::overlay(self, window, cx))
            .child(crate::web_panels::keyboard_guard())
    }
}

// ---------------------------------------------------------------- the bar over the thread

impl Threadbear {
    /// `PendingReviewsButton`: a review can be older than the loaded page of
    /// the transcript, so the runner's list keeps it one click away without
    /// scrolling back through earlier turns.
    pub(crate) fn pending_reviews_bar(
        &mut self,
        thread: &threadbear_core::inbox::ThreadSummary,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let count = thread.pending_reviews.unwrap_or(0);
        if count == 0 {
            return None;
        }
        let secondary = style::secondary_text(cx);
        let id = thread.id.clone();
        let open = reviews(cx)
            .pending
            .as_ref()
            .is_some_and(|p| p.thread_id == id);
        let button = crate::highlights::tipped(
            h_flex()
                .id("pending-reviews")
                .relative()
                .gap(px(6.))
                .items_center()
                .cursor_pointer(),
            "Compare the images the agent made side by side, and reply",
        )
        .on_click(
            cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_pending_reviews(&id, cx)),
        )
        .child(
            Icon::new(IconName::Images)
                .with_size(px(13.))
                .text_color(secondary),
        )
        .child(
            div()
                .text_color(secondary)
                .child(rules::pending_button_title(count)),
        )
        .when(open, |s| s.child(self.render_pending_list(cx)));
        Some(
            h_flex()
                .flex_none()
                .px(px(20.))
                .py(px(9.))
                .border_b_1()
                .border_color(style::hairline(cx))
                .text_size(px(style::size::WORK))
                .line_height(px(style::natural_line(style::size::WORK)))
                .child(button)
                .into_any_element(),
        )
    }

    fn toggle_pending_reviews(&mut self, thread_id: &str, cx: &mut Context<Self>) {
        if reviews(cx)
            .pending
            .as_ref()
            .is_some_and(|p| p.thread_id == thread_id)
        {
            reviews(cx).pending = None;
            cx.notify();
            return;
        }
        reviews(cx).pending = Some(PendingList {
            thread_id: thread_id.to_owned(),
            loading: true,
            reviews: vec![],
            error: None,
        });
        cx.notify();
        let (client, id) = (self.client.clone(), thread_id.to_owned());
        cx.spawn(async move |this, cx| {
            let res = call(client, "reviews.list", json!({ "threadId": id })).await;
            this.update(cx, |_, cx| {
                if let Some(list) = reviews(cx).pending.as_mut().filter(|p| p.thread_id == id) {
                    list.loading = false;
                    match res {
                        Ok(v) => {
                            list.reviews = v["reviews"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(DesignReview::decode)
                                .collect()
                        }
                        Err(e) => list.error = Some(e.message),
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn render_pending_list(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let (bg, border, secondary) = (
            cx.theme().popover,
            cx.theme().border,
            style::secondary_text(cx),
        );
        let hover = style::hover_fill(cx);
        let Some(list) = cx.try_global::<Reviews>().and_then(|r| r.pending.as_ref()) else {
            return div().into_any_element();
        };
        let (thread_id, loading, error, shown) = (
            list.thread_id.clone(),
            list.loading,
            list.error.clone(),
            list.reviews.clone(),
        );
        let mut column = v_flex().gap(px(12.)).text_size(px(style::size::WORK));
        if loading {
            column = column.child(Spinner::new().color(secondary).with_size(px(13.)));
        }
        if let Some(error) = &error {
            column = column.child(div().text_color(secondary).child(error.clone()));
        }
        for (i, review) in shown.iter().enumerate() {
            let (open, id) = (review.clone(), thread_id.clone());
            column = column.child(
                crate::highlights::tipped(
                    h_flex()
                        .id(("pending-review", i))
                        .gap(px(18.))
                        .items_center()
                        .rounded(px(5.))
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover)),
                    "Open this review",
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    reviews(cx).pending = None;
                    this.open_review(&id, open.clone(), window, cx);
                    cx.notify();
                }))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .child(review.title.clone()),
                )
                .child(
                    div()
                        .flex_none()
                        .text_color(secondary)
                        .child(format!("{} images", review.options.len())),
                ),
            );
        }
        if !loading && shown.is_empty() && error.is_none() {
            column = column.child(div().text_color(secondary).child("No reviews waiting."));
        }
        deferred(
            anchored().child(
                div()
                    .id("pending-reviews-list")
                    .occlude()
                    .mt(px(24.))
                    .min_w(px(300.))
                    .p(px(16.))
                    .rounded(px(12.))
                    .bg(bg)
                    .border_1()
                    .border_color(border)
                    .shadow_lg()
                    .on_mouse_down_out(cx.listener(|_, _: &MouseDownEvent, _, cx| {
                        reviews(cx).pending = None;
                        cx.notify();
                    }))
                    .child(column),
            ),
        )
        .with_priority(2)
        .into_any_element()
    }
}

// ---------------------------------------------------------------- scripts

/// The window for a review, for a script's `"review": id` (a screenshot of it,
/// a click in it), as the Swift app's commands find theirs.
#[cfg(feature = "automation")]
pub(crate) fn window_for(review_id: &str, cx: &mut App) -> Option<AnyWindowHandle> {
    if !cx.has_global::<Reviews>() {
        return None;
    }
    let windows: Vec<(AnyWindowHandle, Entity<ReviewWindow>)> =
        reviews(cx).windows.values().cloned().collect();
    windows
        .into_iter()
        .find(|(_, view)| view.read(cx).session.review().id == review_id)
        .map(|(handle, _)| handle)
}

/// The Swift app's `review` command (Automation+Waiting.swift, `designReview`):
/// opens the open thread's review (the first, or `id`) as its card does, then
/// does what it's told in the same order the Swift one does, and says where
/// the window has got to. `close` closes it; `open: false` only reads one
/// that's open.
#[cfg(feature = "automation")]
pub(crate) async fn automation(
    app: &WeakEntity<Threadbear>,
    main: AnyWindowHandle,
    cmd: &Value,
    cx: &mut AsyncApp,
) -> Result<Value, String> {
    use gpui_kit::test::TestWindowExt as _;
    let wanted = cmd["id"].as_str().map(str::to_owned);
    let found = app
        .read_with(cx, |t, cx| {
            let thread_id = t.selected.clone()?;
            let pane = t.pane.as_ref()?.read(cx);
            let review = pane
                .feed
                .model()
                .rows()
                .iter()
                .filter_map(|row| match &row.content {
                    threadbear_core::reducer::RowContent::Review(review) => Some(review.clone()),
                    _ => None,
                });
            let review = review
                .filter(|r| wanted.as_ref().is_none_or(|w| &r.id == w))
                .next()?;
            Some((thread_id, review))
        })
        .map_err(|e| e.to_string())?;
    let Some((thread_id, snapshot)) = found else {
        return Err("no review in this thread".into());
    };
    let key = window_key(&thread_id, &snapshot.id);
    let open = |cx: &mut AsyncApp| {
        cx.update(|cx| reviews(cx).windows.get(&key).map(|(_, view)| view.clone()))
    };
    if cmd["close"].as_bool() == Some(true) {
        if let Some(view) = open(cx) {
            view.update(cx, |v, cx| v.close(cx));
        }
        return Ok(json!("ok closed"));
    }
    let opening = cmd["open"].as_bool() != Some(false);
    if opening {
        let app = app.upgrade().ok_or("the app has gone")?;
        cx.update_window(main, |_, window, cx| {
            app.update(cx, |t, cx| {
                t.open_review(&thread_id, snapshot.clone(), window, cx)
            })
        })
        .map_err(|e| e.to_string())?;
    }
    // The window opens once the update that asked is over.
    let mut view = open(cx);
    for _ in 0..100 {
        if view.is_some() || !opening {
            break;
        }
        cx.background_executor()
            .timer(Duration::from_millis(20))
            .await;
        view = open(cx);
    }
    let Some(view) = view else {
        return Err(if opening {
            "couldn't open the review".into()
        } else {
            "that review isn't open".into()
        });
    };
    if cmd["canvasReplyFocusProbe"].as_bool() == Some(true) {
        return reply_focus_probe(&view, cx).await;
    }
    // This probe deliberately owns a separate hidden page that GPUI never
    // places or repaints. Only CEF's load callbacks can restore its zoom.
    if let Some(width) = cmd["canvasLoadZoomProbe"].as_f64() {
        return load_zoom_probe(&view, width as f32, cx).await;
    }
    // `refresh`, as the Swift command awaits it.
    let (thread, review, client) = view.read_with(cx, |v, _| {
        (
            v.session.thread_id.clone(),
            v.session.review().id.clone(),
            v.client.clone(),
        )
    });
    if let Ok(v) = call(
        client,
        "reviews.get",
        json!({ "threadId": thread, "reviewId": review }),
    )
    .await
    {
        if let Some(latest) = DesignReview::decode(&v["review"]) {
            view.update(cx, |v, cx| v.receive(latest, cx));
        }
    }
    let handle = view.read_with(cx, |v, _| v.handle);
    cx.update_window(handle, |_, window, cx| {
        crate::thread::scripted_input(|| {
            view.update(cx, |v, cx| {
                match cmd["mode"].as_str() {
                    Some("All") => v.show_all(cx),
                    Some("Single") => v.enlarge(v.session.focused(), v.session.shot(), cx),
                    _ => {}
                }
                if let Some(show) = cmd["show"].as_u64() {
                    v.enlarge(
                        show as usize,
                        cmd["shot"].as_u64().unwrap_or(0) as usize,
                        cx,
                    );
                }
                if let Some(actual) = cmd["actual"].as_bool() {
                    v.zoom(
                        if actual {
                            ZoomStep::Actual
                        } else {
                            ZoomStep::Fit
                        },
                        cx,
                    );
                }
                if let Some(peek) = cmd["peek"].as_bool() {
                    v.set_peeking(peek, cx);
                }
                if let Some(notes) = cmd["notes"].as_object() {
                    for (id, text) in notes {
                        if v.session.set_note(text.as_str().unwrap_or(""), id) {
                            v.edited(cx);
                        }
                    }
                }
                match &cmd["pick"] {
                    Value::String(id) => v.pick(id, cx),
                    Value::Array(ids) => ids
                        .iter()
                        .filter_map(Value::as_str)
                        .for_each(|id| v.pick(id, cx)),
                    _ => {}
                }
                if cmd["none"].as_bool() == Some(true) {
                    v.toggle_none(cx);
                }
                if let Some(reply) = cmd["reply"].as_str() {
                    v.set_reply(reply, window, cx);
                }
                if let Some(browse) = cmd["browse"].as_i64() {
                    v.browse(browse as i32, cx);
                }
                // The canvas's switch for the agent's notes, and a mark drawn
                // on option `option`'s picture `shot` through the points
                // (fractions of the picture), as the mouse would draw it.
                if let Some(on) = cmd["canvasNotes"].as_bool() {
                    if v.canvas.as_ref().is_some_and(|c| c.notes_on != on) {
                        v.toggle_notes(cx);
                    }
                }
                // The board flown to an option, by its id, as a click on its
                // name does, or to its picture `canvasShot` (from 0).
                if let Some(id) = cmd["canvasGo"].as_str() {
                    let at = v.session.review().options.iter().position(|o| o.id == id);
                    let shot = cmd["canvasShot"].as_u64().unwrap_or(0) as usize;
                    if let Some(at) = at {
                        v.canvas_go_shot(at, shot, cx);
                    }
                }
                if cmd["canvasFocusPage"].as_bool() == Some(true) {
                    if let Some((_, page)) = &v.stage.page {
                        page.focus();
                    }
                }
                if let Some(at) = cmd["canvasDoubleClick"].as_array() {
                    if let (Some(option), Some(shot)) = (
                        at.first().and_then(Value::as_u64),
                        at.get(1).and_then(Value::as_u64),
                    ) {
                        v.script_canvas_double_click(option as usize, shot as usize, cx);
                    }
                }
                if let Some(factor) = cmd["canvasZoom"].as_f64() {
                    v.script_canvas_zoom(factor as f32, cx);
                }
                if let Some(pan) = cmd["canvasPan"].as_array() {
                    v.script_canvas_pan(
                        pan.first().and_then(Value::as_f64).unwrap_or(0.) as f32,
                        pan.get(1).and_then(Value::as_f64).unwrap_or(0.) as f32,
                        cx,
                    );
                }
                if let Some(mark) = cmd["canvasMark"].as_object() {
                    v.script_mark(mark, window, cx);
                }
                // The keys in the reply box, as a click in it gives them, for a
                // real ⌘V after (features/tools/real-review-paste.ts).
                if cmd["focusReply"].as_bool() == Some(true) {
                    let handle = v.reply.read(cx).focus_handle(cx);
                    window.focus(&handle, cx);
                    crate::web_panels::keyboard_to_app(window);
                }
            })
        })
    })
    .map_err(|e| e.to_string())?;
    // A real click (pointer events through hit testing) on picture chip N in
    // the reply, as `composer-peek` with `press` does in the thread's box.
    if let Some(number) = cmd["pressPicture"].as_u64() {
        let clicked = cx.update_window(handle, |_, window, cx| -> Result<(), String> {
            use gpui_kit::test::TestEventExt as _;
            window.render_frame(cx);
            let reply = view.read(cx).reply.clone();
            let range = reply
                .read(cx)
                .tokens()
                .get((number as usize).saturating_sub(1))
                .map(|span| span.range())
                .ok_or_else(|| format!("no picture chip {number} in the reply"))?;
            let at = reply
                .read(cx)
                .range_to_bounds(&range)
                .ok_or("the chip isn't on screen")?
                .center();
            window.pointer_move(at, None, cx);
            window.render_frame(cx);
            window.pointer_down(at, MouseButton::Left, cx);
            window.pointer_up(at, MouseButton::Left, cx);
            window.render_frame(cx);
            Ok(())
        });
        clicked.map_err(|e| e.to_string())??;
    }
    if cmd["closeViewer"].as_bool() == Some(true) {
        view.update(cx, crate::viewer::close);
    }
    let busy = |view: &Entity<ReviewWindow>, cx: &mut AsyncApp| {
        view.read_with(cx, |v, _| v.session.saving() || v.session.submitting())
    };
    if cmd["save"].as_bool() == Some(true) {
        view.update(cx, |v, cx| v.save_now(cx));
    }
    if cmd["submit"].as_bool() == Some(true) {
        view.update(cx, |v, cx| v.submit(cx));
    }
    if cmd["cancel"].as_bool() == Some(true) {
        view.update(cx, |v, cx| v.cancel_review(cx));
    }
    for _ in 0..1000 {
        if !busy(&view, cx) {
            break;
        }
        cx.background_executor()
            .timer(Duration::from_millis(10))
            .await;
    }
    // A frame, so a screenshot straight after shows what this did.
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        // Ask for a system frame before a native window capture. The test
        // draw consumes the invalidation without presenting its new scene.
        if cmd["present"].as_bool() == Some(true) {
            window.refresh();
        }
    })
    .ok();
    cx.background_executor()
        .timer(Duration::from_millis(250))
        .await;
    // Only the automation build can inspect the review's sealed page.
    if let Some(js) = cmd["canvasPageJs"].as_str() {
        let page = view
            .read_with(cx, |v, _| v.stage.page.as_ref().map(|(_, p)| p.clone()))
            .ok_or("no live canvas page")?;
        let answer = page
            .devtools(
                "Runtime.evaluate",
                json!({ "expression": js, "returnByValue": true, "awaitPromise": true, "userGesture": true }),
            )
            .await
            .map_err(|_| "the page went away".to_owned())??;
        if answer.get("exceptionDetails").is_some() {
            return Err(format!("page script failed: {answer}"));
        }
        return Ok(json!(format!("ok {}", answer["result"]["value"])));
    }
    let state = state_with_keys(cmd, &view, handle, cx)?;
    Ok(json!(format!("ok {state}")))
}

/// Uses the mounted browser and AppKit hit testing, not a GPUI click/focus
/// command (those render before dispatch and can hide a stale focus tree).
#[cfg(feature = "automation")]
async fn reply_focus_probe(
    view: &Entity<ReviewWindow>,
    cx: &mut AsyncApp,
) -> Result<Value, String> {
    use gpui_kit::test::TestWindowExt as _;
    let (handle, page, seed) = view.read_with(cx, |v, cx| {
        (
            v.handle,
            v.stage.page.as_ref().map(|(_, p)| p.clone()),
            v.reply.read(cx).value().to_string(),
        )
    });
    let page = page.ok_or("no mounted page for the reply focus probe")?;
    let answer = page.devtools("Runtime.evaluate", json!({"expression": "(() => {const r=document.getElementById('reply-guard-test').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()", "returnByValue":true})).await.map_err(|_| "page closed")??;
    let point = &answer["result"]["value"];
    let (x, y, width, _) = page.bounds();
    let x = x + point[0].as_f64().ok_or("no input x")? as f32 * (width / 1024.);
    let y = y + point[1].as_f64().ok_or("no input y")? as f32 * (width / 1024.);
    let prepare = |cx: &mut AsyncApp| -> Result<u64, String> {
        cx.update_window(handle, |_, window, cx| {
            let reply = view.read(cx).reply.read(cx).focus_handle(cx);
            window.focus(&reply, cx);
            crate::web_panels::keyboard_to_app(window);
            // The only forced frame is BEFORE focus transfers into CEF.
            window.render_frame(cx);
            view.read(cx).stage.focus_events
        })
        .map_err(|e| e.to_string())
    };
    let before = prepare(cx)?;
    let hit = crate::web_panels::send_click(handle, x, y, cx)?;
    let mut notified = false;
    for _ in 0..30 {
        cx.background_executor()
            .timer(Duration::from_millis(10))
            .await;
        notified = cx
            .update_window(handle, |_, window, cx| {
                let v = view.read(cx);
                v.stage.focus_events > before && v.page_has_keys() && !v.reply_focused(window, cx)
            })
            .map_err(|e| e.to_string())?;
        if notified {
            break;
        }
    }
    if !notified {
        let state = cx.update_window(handle, |_, window, cx| {
            let v = view.read(cx);
            json!({"before":before, "events":v.stage.focus_events, "pageKeys":v.page_has_keys(), "replyKeys":v.reply_focused(window, cx)})
        }).map_err(|e| e.to_string())?;
        return Err(format!(
            "native focus did not notify within 300ms: {state}; {}",
            hit.lines().next().unwrap_or("no hit")
        ));
    }
    prepare(cx)?;
    crate::web_panels::send_click(handle, x, y, cx)?;
    // No await or render between this click and the shortcuts. Force GPUI's
    // stale reply focus for each key to exercise the pre-dispatch guard even
    // if the focus event happened to arrive already.
    let keys = [
        "secondary-enter",
        "secondary-backspace",
        "secondary-left",
        "secondary-right",
        "ctrl-k",
    ];
    cx.update_window(handle, |_, window, cx| -> Result<(), String> {
        if !view.read(cx).page_has_keys() {
            return Err("native click missed the mounted HTML input".into());
        }
        for key in keys {
            let reply = view.read(cx).reply.read(cx).focus_handle(cx);
            window.focus(&reply, cx); // Deliberately leave AppKit with CEF.
            let mut key =
                Keystroke::parse_with_os(key, cx.platform_info().os).map_err(|e| e.to_string())?;
            if key.key == "enter" {
                key.key_char = Some("\n".into());
            }
            let handled = window.dispatch_keystroke(key.clone(), cx);
            window.dispatch_event(
                gpui_kit::PlatformInput::KeyUp(KeyUpEvent { keystroke: key }),
                cx,
            );
            let v = view.read(cx);
            if handled
                || v.reply.read(cx).value().to_string() != seed
                || v.session.submitting()
                || !v.session.review().is_pending()
            {
                return Err(
                    "a shortcut was swallowed or edited/submitted the reply before a repaint"
                        .into(),
                );
            }
        }
        Ok(())
    })
    .map_err(|e| e.to_string())??;
    // Real AppKit events must continue past GPUI into the mounted input.
    // Query CEF only; no GPUI frame can hide propagation or focus mistakes.
    for (code, text, expected) in [
        (
            123,
            "\u{f702}",
            "document.getElementById('reply-guard-test').selectionStart === 0",
        ),
        (
            51,
            "\u{7f}",
            "document.getElementById('reply-guard-test').value === ''",
        ),
    ] {
        let setup = "(() => {const i=document.getElementById('reply-guard-test');i.value='HTML shortcut';i.focus();i.setSelectionRange(i.value.length,i.value.length);return true})()";
        page.devtools("Runtime.evaluate", json!({"expression":setup}))
            .await
            .map_err(|_| "page closed")??;
        crate::web_panels::send_shortcut(handle, code, text, 1, cx)?;
        let mut reached = false;
        for _ in 0..30 {
            cx.background_executor()
                .timer(Duration::from_millis(10))
                .await;
            let answer = page
                .devtools(
                    "Runtime.evaluate",
                    json!({"expression":expected,"returnByValue":true}),
                )
                .await
                .map_err(|_| "page closed")??;
            if answer["result"]["value"] == true {
                reached = true;
                break;
            }
        }
        if !reached {
            return Err(format!(
                "AppKit command key {code} never reached the HTML input"
            ));
        }
        let unchanged = view.read_with(cx, |v, cx| {
            v.reply.read(cx).value().to_string() == seed
                && !v.session.submitting()
                && v.session.review().is_pending()
        });
        if !unchanged {
            return Err("AppKit shortcut changed the reply draft".into());
        }
    }
    Ok(json!(format!(
        "ok {}",
        json!({"notified":notified, "sameTickKeys":keys.len(), "nativeShortcuts":2})
    )))
}

#[cfg(feature = "automation")]
async fn load_zoom_probe(
    view: &Entity<ReviewWindow>,
    width: f32,
    cx: &mut AsyncApp,
) -> Result<Value, String> {
    let (handle, source) = view.read_with(cx, |v, _| {
        (
            v.handle,
            v.session
                .review()
                .options
                .iter()
                .flat_map(|o| o.all_shots())
                .find_map(|s| s.page().map(str::to_owned)),
        )
    });
    let source = source.ok_or("no HTML source for the load probe")?;
    let (real, digest) = crate::live_pages::prepare(&source)?;
    let site = threadbear_core::local_preview::Site::page_only(std::path::Path::new(&real), digest)
        .ok_or("the probe page couldn't be sealed")?;
    let preview = threadbear_web::PreviewSite::live(Arc::new(site));
    let page = cx
        .update_window(handle, |_, window, _| {
            let parent =
                crate::web_panels::native_view(window).ok_or("no native view for probe")?;
            let (page, _events) = threadbear_web::PanelPage::open(
                parent,
                &preview.page_url(),
                threadbear_web::PanelKind::Preview(preview),
            )?;
            page.set_hidden(true);
            page.set_bounds(
                0.,
                0.,
                width,
                300.,
                f32::from(window.viewport_size().height),
            );
            page.set_zoom_factor(threadbear_core::review_canvas::html_zoom(width));
            Ok::<_, String>(page)
        })
        .map_err(|e| e.to_string())??;
    for _ in 0..100 {
        cx.background_executor()
            .timer(Duration::from_millis(100))
            .await;
        let result = page.devtools("Runtime.evaluate", json!({"expression": "({ready:location.hostname.endsWith('.preview.threadbear.invalid') && document.readyState === 'complete', width:innerWidth})", "returnByValue":true})).await;
        if let Ok(Ok(answer)) = result {
            let value = &answer["result"]["value"];
            if value["ready"] == true {
                return Ok(json!(format!("ok {}", value["width"])));
            }
        }
    }
    Err("the HTML load probe never committed".into())
}

/// After a `pressReplyLow`, the window's state, and whether the reply box
/// has the keys: its edge goes blue and its cursor shows only then (Mike,
/// 23 Nov: after a click low in it, neither did).
#[cfg(feature = "automation")]
fn state_with_keys(
    cmd: &Value,
    view: &Entity<ReviewWindow>,
    handle: AnyWindowHandle,
    cx: &mut AsyncApp,
) -> Result<Value, String> {
    press_reply_low(cmd, view, handle, cx)?;
    let mut state = view.read_with(cx, |v, cx| v.state(cx));
    state["replyKeys"] = json!(cx
        .update_window(handle, |_, window, cx| view
            .read(cx)
            .reply_focused(window, cx))
        .unwrap_or(false));
    state["pageKeys"] = json!(view.read_with(cx, |v, _| v.page_has_keys()));
    state["nativeKeyboard"] = json!(cx
        .update_window(handle, |_, window, _| {
            // SAFETY: this open window's content view, borrowed on the main thread.
            unsafe {
                threadbear_web::keyboard_holder(
                    crate::web_panels::native_view(window).unwrap_or(std::ptr::null_mut()),
                )
            }
            .name()
        })
        .ok());
    Ok(state)
}

/// `pressReplyLow`: a real click low in the reply box, under its first line,
/// where only the box itself is: it gives the box the keys (Mike, 23 Nov).
#[cfg(feature = "automation")]
fn press_reply_low(
    cmd: &Value,
    view: &Entity<ReviewWindow>,
    handle: AnyWindowHandle,
    cx: &mut AsyncApp,
) -> Result<(), String> {
    if cmd["pressReplyLow"].as_bool() != Some(true) {
        return Ok(());
    }
    let clicked = cx.update_window(handle, |_, window, cx| -> Result<(), String> {
        use gpui_kit::test::{TestEventExt as _, TestWindowExt as _};
        window.render_frame(cx);
        let b = view
            .read(cx)
            .reply_box
            .get()
            .ok_or("the reply box isn't on screen")?;
        let at = point(
            b.origin.x + gpui_kit::px(24.),
            b.origin.y + b.size.height - gpui_kit::px(10.),
        );
        window.pointer_move(at, None, cx);
        window.render_frame(cx);
        window.pointer_down(at, MouseButton::Left, cx);
        window.pointer_up(at, MouseButton::Left, cx);
        window.render_frame(cx);
        Ok(())
    });
    clicked.map_err(|e| e.to_string())?
}

#[cfg(feature = "automation")]
impl ReviewWindow {
    /// What the Swift command answers, and a little more for the specs.
    fn state(&self, cx: &App) -> Value {
        let s = &self.session;
        let draft = s.draft();
        json!({
            "id": s.review().id,
            "window": self.handle.window_id().as_u64(),
            "status": s.review().status,
            "revision": s.review().revision,
            "mode": s.mode.name(),
            // The words under the stage: the option on show's name and
            // reasons, or the agent's lead with all of them side by side.
            "words": match (s.mode, s.focused_option()) {
                (ReviewMode::Single, Some(o)) => format!("{}\n{}", o.label(), o.note.clone().unwrap_or_default()),
                _ => s.review().note.clone().unwrap_or_default(),
            },
            "actual": s.zoomed,
            "pickedId": draft.picked_id().unwrap_or(""),
            "pickedIds": draft.picked_ids,
            "notes": draft.notes,
            "reply": draft.reply.clone().unwrap_or_default(),
            // The reply's pictures: in the draft, and chips in the box.
            "images": draft.images.len(),
            "chips": self.reply.read(cx).tokens().len(),
            // The picture viewer over the window: "" when it's closed, else
            // "<n> of <total> <file>", with " (loading)" until it's drawn.
            "viewer": self.viewer.describe(cx),
            "none": draft.none,
            "shot": s.shot(),
            "peeking": s.peeking,
            "dirty": s.dirty(),
            "error": s.error.clone().unwrap_or_default(),
            "focused": s.focused_option().map(|o| o.id.clone()).unwrap_or_default(),
            "sendLabel": s.send_label(),
            "editable": s.editable(),
            "minimap": self.stage.minimap_showing(),
            // What the stage draws: a clip playing in the system's player
            // (on a Mac), a sound's play bar on its waveform, or a page or a
            // clip that can't play as its still.
            "stage": match (s.mode, s.shown_shot()) {
                (ReviewMode::All, _) => "all",
                (_, Some(shot)) if shot.video().is_some_and(|v| crate::media_view::state_of(&stage::stage_key(v)).is_some()) => "player",
                (_, Some(shot)) if shot.audio().is_some_and(|a| crate::media_view::state_of(&stage::stage_key(a)).is_some()) => "sound",
                (_, Some(shot)) if shot.page().is_some_and(|p| self.stage.page.as_ref().is_some_and(|(shown, _)| shown == p)) => "page",
                (_, Some(shot)) if shot.media.is_some() => "still",
                _ => "picture",
            },
            // Why a page shot on show isn't in place (GPUI's own).
            "pageFailed": self.stage.page_failed_reason(),
            // What Open live would open, for the option on show.
            "live": s.shown_option().filter(|_| s.mode == ReviewMode::Single).and_then(|o| o.url.clone()).unwrap_or_default(),
            // The board: the tour's stop, the
            // notes switch, the tool, how many of the agent's notes are on
            // the pictures, and Mike's marks as "1 circle A 0".
            "canvas": self.canvas_state(),
        })
    }
}

/// The open review windows in the dump: each one's review and where it's got to.
#[cfg(feature = "automation")]
pub(crate) fn dump(cx: &App) -> Value {
    let Some(reviews) = cx.try_global::<Reviews>() else {
        return json!([]);
    };
    json!(reviews
        .windows
        .values()
        .map(|(_, view)| view.read(cx).state(cx))
        .collect::<Vec<_>>())
}
