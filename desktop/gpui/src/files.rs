// A file or page open in the pane, in place of its section: a port of the Swift
// app's PreviewBody, QuickLookView/FilePreviewView and TextFileView. What the
// file holds always comes from the runner (`files.read`), so a thread on
// another Mac works the same. A Markdown file's own text (its Markdown view)
// is the one thing read here, from a thread on this runner (file_edit.rs).
//
// A picture is drawn here with Copy Image; Markdown drawn as a page, or its
// text with the bar's Preview/Markdown menu; code and plain text in the kit's
// read-only editor, coloured by its highlighter; any text with the find bar
// over it (file_find.rs). On a Mac a video plays and a PDF shows in the
// system's own view over the pane (media_view.rs), read from this Mac's own
// file once the open gate has checked it. Office and iWork documents show a
// read-only Quick Look thumbnail. On Windows and Linux these open in their
// own app (`file.quicklook`). A
// local web page shows sealed in the web runtime, its scripts off until Run
// them (`file.htmlpreview`, `file.runthem`: web_panels.rs `local_page`).
use crate::app::Threadbear;
use crate::file_edit::{FileEdit, SaveFile};
use crate::file_find::{FindBar, FindNext, FindPrevious};
use crate::file_watch::FolderWatch;
use crate::files_store::FilePrefs;
use crate::highlights::{
    icon, palette, tipped, with_scroll_bar, Palette, PanePreview, SidePane, Target, FILES,
};
use crate::spinner::Spinner;
use crate::{call, icons, style};
use gpui_kit::base::{TestSupportExt as _, TextViewState, TextViewStyle};
use gpui_kit::component::input::{
    Editor, EditorState, GutterDecoration, GutterDecorationCollection, RangeDecoration,
    RangeDecorationCollection, RangeDecorationStyle,
};
use gpui_kit::component::menu::{DropdownMenu, PopupMenu, PopupMenuItem};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Selectable, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
// Shadows gpui's px, so sizes here follow the app's zoom (style.rs).
use crate::style::px;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::{path::Path, sync::Arc};
use threadbear_core::folders::{picture_size, FileRead};
use threadbear_core::highlights::{self as core, Viewer};
use threadbear_core::inbox::ThreadSummary;
use threadbear_core::text_file::{words, MarkdownView, LIMIT};

/// Whether the system has "Finder", for the menu's words.
#[cfg(target_os = "macos")]
pub(crate) const REVEAL_TITLE: &str = "Reveal in Finder";
#[cfg(not(target_os = "macos"))]
pub(crate) const REVEAL_TITLE: &str = "Show in folder";

pub(crate) const OPEN_IN_BROWSER: &str = "Open in Browser";

/// The bytes of a file come from the runner; this is how much a preview asks for
/// (`files.read`'s own default is 16 MB, its limit 48).
const MAX_BYTES: u64 = 32 * 1024 * 1024;

/// Past this much text, Markdown and code are shown plain: highlighting
/// a huge file line by line would stall (`TextFileController.highlightLimit`).
const HIGHLIGHT_LIMIT: usize = 400_000;

/// A line of code in the pane: the Swift text view's for its 12 point
/// monospaced font (measured, 15 apart).
pub(crate) const CODE_LINE: f32 = 15.;

/// Metadata for a file open in its own BearDock panel (`threadbear.file:<path>`).
#[derive(Clone, Debug)]
pub(crate) struct FilePanelMeta {
    pub path: String,
    pub title: String,
    pub thread_id: String,
    pub runner_id: Option<String>,
    pub remote: bool,
    pub opened: u64,
    pub editing: bool,
    pub live: bool,
    pub lines: Option<(usize, usize)>,
}

/// What a file panel is reading, keyed by panel id (`threadbear.file:<path>`).
pub(crate) struct OpenFile {
    pub path: String,
    pub opened: u64,
    pub body: FileBody,
    /// Only the start of the file came (`truncated`).
    pub truncated: bool,
    /// The whole file's size, as the runner said: past `LIMIT`, it's never
    /// shown as its raw text to work on (`TextFileView.canEdit`).
    pub size: i64,
    /// The find bar, while it's up (⌘F).
    pub find: Option<FindBar>,
    /// The file's own text being worked on: the pencil, or a Markdown file's
    /// Markdown view.
    pub edit: Option<FileEdit>,
    /// The drawn Markdown page's scroll, which the find bar moves to a match.
    pub page_scroll: ScrollHandle,
    /// This file panel's own focus handle, so ⌘F and ⌘S reach the focused panel.
    pub focus: Option<FocusHandle>,
    /// Hears the drawn page change (its parse landing) for the find bar.
    _page_watch: Option<Subscription>,
    /// The file's folder on this machine, watched so an agent's rewrite shows
    /// up by itself while it's being read (`TextFileDocument.watch`).
    _file_watch: Option<FolderWatch>,
    /// The read that follows a change, once its burst settles.
    _reread: Option<Task<()>>,
    /// Its folder heard it change while its panel wasn't showing, so the
    /// read was put off: coming back reads it again (`load_file`).
    pub changed_away: bool,
    /// Its read found no runner (a click during a restart, which is most
    /// days' updates): it's read again when the app's connected again,
    /// rather than saying "Not connected" until it's opened again. A link
    /// on an ask's card opened onto a blank pane like this (17 Nov).
    pub waiting_for_runner: bool,
    /// The opening whose lines (`a.ts:12-18`) have been tinted, so they're
    /// tinted once, not on every draw.
    lines_shown: Option<u64>,
    /// The tint and gutter mark on those lines, kept to be cleared when the
    /// file's opened again at other lines (or none), or typed in.
    line_marks: Option<(RangeDecorationCollection, GutterDecorationCollection)>,
}

impl OpenFile {
    fn new(path: String, opened: u64, body: FileBody) -> Self {
        OpenFile {
            path,
            opened,
            body,
            truncated: false,
            size: 0,
            find: None,
            edit: None,
            page_scroll: ScrollHandle::new(),
            focus: None,
            _page_watch: None,
            _file_watch: None,
            _reread: None,
            changed_away: false,
            waiting_for_runner: false,
            lines_shown: None,
            line_marks: None,
        }
    }

    /// The raw text's editor, while it's showing.
    pub(crate) fn raw_editor(&self) -> Option<Entity<EditorState>> {
        self.edit.as_ref().map(|e| e.editor.clone())
    }

    /// Text this pane shows that can be worked on as text: Markdown or code
    /// that came whole and isn't too big (`TextFileView.shows`, `canEdit`).
    fn is_whole_text(&self) -> bool {
        matches!(self.body, FileBody::Markdown { .. } | FileBody::Text { .. })
            && !self.truncated
            && self.size < LIMIT as i64
    }
}

pub(crate) struct FilesState {
    /// The file open in the pane, per thread.
    pub open: HashMap<String, OpenFile>,
    /// Paths the runner has said are folders, so a click goes to the browser.
    known_folders: HashSet<String>,
    /// The pane's own text style, built once per appearance.
    /// Keyed by appearance and zoom, as `rows`' is.
    reading_style: Option<(crate::style::ReadingStyleKey, TextViewStyle)>,
    /// How files and folders show, remembered across launches.
    pub(crate) prefs: FilePrefs,
    /// What was last looked for, which the next ⌘F starts with, as AppKit's
    /// find pasteboard has it.
    pub(crate) last_query: String,
    /// The window the pane draws in, for putting a file's text in its editor
    /// after a save or a check that came later.
    pub(crate) window: Option<AnyWindowHandle>,
    /// Each panel's latest read, so an older one finishing later (a big
    /// picture still being shrunk) doesn't replace it.
    reads: HashMap<String, u64>,
}

impl Default for FilesState {
    fn default() -> Self {
        FilesState {
            open: HashMap::new(),
            known_folders: HashSet::new(),
            reading_style: None,
            prefs: crate::files_store::load(),
            last_query: String::new(),
            window: None,
            reads: HashMap::new(),
        }
    }
}

impl FilesState {
    pub(crate) fn is_known_folder(&self, path: &str) -> bool {
        self.known_folders.contains(path)
    }
}

/// What's drawn for a file.
pub(crate) enum FileBody {
    /// A spinner would only flash for a normal file; a beat later there's a note.
    Loading,
    Failed {
        message: String,
    },
    /// Asked for while the runner was away; read again once it's back
    /// (`OpenFile::waiting_for_runner`, SidePane::connected).
    Waiting,
    Markdown {
        doc: Entity<TextViewState>,
        text: Arc<str>,
    },
    /// Code or plain text: a read-only editor, coloured for code. The editor
    /// is made at the next frame, as it needs a window.
    Text {
        editor: Option<Entity<EditorState>>,
        text: Arc<str>,
        language: Option<&'static str>,
    },
    /// `image` is the file's own bytes (Copy Image copies them), drawn
    /// through the picture budget (fit_picture.rs).
    Picture {
        image: Arc<Image>,
        size: Option<(u32, u32)>,
    },
    /// Something only its own app can show.
    Opaque {
        note: String,
    },
    /// A video or a PDF on this Mac, in the system's own view over the pane
    /// (media_view.rs). Nothing's read for it here: the view reads the real
    /// file the open gate found, as it's made.
    Media(crate::media_view::Kind),
    /// A local web page on this Mac, sealed in the web runtime (web_panels.rs
    /// `local_page`): it reads only itself and the assets it names, never the
    /// network, with its scripts off unless Mike chose Run them for these
    /// bytes (`LocalPagePreview`).
    Page(LocalPage),
}

/// A local page's file, and what the scan of it found.
#[derive(Clone, Debug)]
pub(crate) struct LocalPage {
    /// The real file the open gate found, symlinks followed.
    pub real: String,
    /// Whether it has scripts, and the digest of the bytes scanned; None
    /// until the scan's back (or a file that couldn't be scanned).
    pub scan: Option<(bool, String)>,
    /// Mike chose Run them for these bytes (`ScriptConsent`).
    pub allowed: bool,
    /// A live page opened big from its card: the card's running page shows
    /// here (live_pages::pane_view), not the file's own preview.
    pub live: bool,
    publication: Publication,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Visibility {
    Private,
    Public,
}

impl Visibility {
    fn from_wire(value: Option<&str>) -> Self {
        match value {
            Some("public") => Self::Public,
            _ => Self::Private,
        }
    }

    fn wire(self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::Public => "public",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Private => "Private",
            Self::Public => "Anyone with link",
        }
    }

    fn symbol(self) -> &'static str {
        match self {
            Self::Private => "lock",
            Self::Public => "globe",
        }
    }
}

#[derive(Clone, Debug)]
enum Publication {
    Syncing {
        url: Option<String>,
        visibility: Visibility,
    },
    Unavailable,
    Ready {
        url: Option<String>,
        visibility: Visibility,
        error: Option<String>,
        copied: bool,
    },
    Working {
        url: Option<String>,
        visibility: Visibility,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PublishAction {
    Sync,
    Publish,
    SetVisibility(Visibility),
    Unpublish,
}

impl LocalPage {
    /// The digest its scripts run for, while they're allowed.
    pub(crate) fn scripts_for(&self) -> Option<&str> {
        match &self.scan {
            Some((true, digest)) if self.allowed => Some(digest),
            _ => None,
        }
    }

    /// Whether the bar asking to run its scripts shows.
    pub(crate) fn asks(&self) -> bool {
        matches!(&self.scan, Some((true, _))) && !self.allowed
    }
}

/// Which of the system's views a file in the pane shows in, by its name: a
/// video, sound file, PDF or document thumbnail, on a Mac. None elsewhere, where they open in their app.
pub(crate) fn media_kind(path: &str) -> Option<crate::media_view::Kind> {
    use crate::media_view::Kind;
    use threadbear_core::open_policy::Media;
    if !crate::media_view::SHOWN_HERE {
        return None;
    }
    threadbear_core::open_policy::media_kind(path).map(|m| match m {
        Media::Video => Kind::PaneVideo,
        Media::Audio => Kind::PaneAudio,
        Media::Pdf => Kind::PaneDocument,
        Media::Office => Kind::PaneQuickLook,
    })
}

/// The pane's view for this thread's file, opened this many times: opened
/// again from a row, it plays again from the start, as the Swift pane's does.
pub(crate) fn media_key(panel_id: &str, path: &str, opened: u64) -> String {
    format!("pane {panel_id} {opened} {path}")
}

/// An image's format from its name, for the kit's decoder.
pub(crate) fn image_format(path: &str) -> Option<ImageFormat> {
    let ext = path.rsplit('.').next()?.to_lowercase();
    Some(match ext.as_str() {
        "png" => ImageFormat::Png,
        "jpg" | "jpeg" => ImageFormat::Jpeg,
        "gif" => ImageFormat::Gif,
        "webp" => ImageFormat::Webp,
        "bmp" => ImageFormat::Bmp,
        "tif" | "tiff" => ImageFormat::Tiff,
        "svg" => ImageFormat::Svg,
        _ => return None,
    })
}

/// `%20` and the like, in a file link.
pub(crate) fn percent_decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 1 {
            if let Some(v) = bytes
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn home_dir() -> String {
    // Windows sets USERPROFILE; HOME only exists there under Git Bash.
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

/// A web page in the browser, or an agent's BrowserBear tab already on it.
/// Only http and https: anything else is refused by the open gate, said so.
pub(crate) fn open_web(url: &str, cx: &mut App) {
    crate::open_gate::open_web_page(url, cx);
}

/// A file on this runner in its own app, through the open gate: a document
/// opens, a program asks first (OpenGate's rule).
pub(crate) fn open_file_in_app(path: &str, origin: crate::open_gate::Origin, cx: &mut App) {
    crate::open_gate::open_file(path, origin, cx);
}

pub(crate) fn reveal(path: &str, origin: crate::open_gate::Origin, cx: &mut App) {
    crate::open_gate::reveal(path, origin, cx);
}

/// A quiet line in the middle of the pane (`PaneNote`).
pub(crate) fn pane_note(text: &str, p: Palette) -> impl IntoElement {
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .p(px(24.))
        .child(
            div()
                .text_center()
                .text_size(px(style::size::LABEL))
                .text_color(p.secondary)
                .child(text.to_owned()),
        )
}

/// What the pane says for a file the runner couldn't read: one that's gone
/// (renamed away, deleted, perhaps while it showed) as the Swift app says it.
fn failed_words(message: &str) -> String {
    if message.starts_with("No such file") {
        threadbear_core::text_file::words::GONE.to_owned()
    } else {
        format!("Couldn't read it: {message}")
    }
}

/// An ask's words without their markdown (`plainAction`).
pub(crate) fn plain_markdown(text: &str) -> String {
    threadbear_core::sidebar::preview_plain(text)
}

/// Trigger for the hosted HTML visibility menu (`[lock] Private ▾` or `[globe] Anyone with link ▾`).
#[derive(IntoElement)]
struct VisibilityLabel {
    inner: Stateful<Div>,
}

impl VisibilityLabel {
    fn new(id: &'static str, visibility: Visibility, working: bool, cx: &App) -> Self {
        let dark = cx.theme().is_dark();
        let label = style::label_text(cx);
        let ink = if dark { 1. } else { 0. };
        let mut inner = div()
            .id(id)
            .flex_none()
            .h(px(26.))
            .px(px(10.))
            .flex()
            .items_center()
            .gap(px(5.))
            .rounded(px(6.))
            .bg(hsla(0., 0., ink, 0.08))
            .text_size(px(style::size::LABEL))
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap()
            .text_color(label);
        if working {
            inner = inner
                .opacity(0.65)
                .child(Spinner::new().color(label).with_size(px(11.)));
        } else {
            inner = inner
                .cursor_pointer()
                .hover(move |s| s.bg(hsla(0., 0., ink, 0.13)))
                .active(move |s| s.bg(hsla(0., 0., ink, 0.18)))
                .child(icons::symbol(visibility.symbol()).with_size(px(12.)));
        }
        inner = inner
            .child(visibility.label())
            .child(icons::symbol("chevron.down").with_size(px(style::size::SMALL - 2.)));
        VisibilityLabel { inner }
    }
}

impl RenderOnce for VisibilityLabel {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        self.inner
    }
}

impl Styled for VisibilityLabel {
    fn style(&mut self) -> &mut StyleRefinement {
        self.inner.style()
    }
}

impl InteractiveElement for VisibilityLabel {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.inner.interactivity()
    }
}

impl Selectable for VisibilityLabel {
    fn selected(self, _: bool) -> Self {
        self
    }
    fn is_selected(&self) -> bool {
        false
    }
}

impl DropdownMenu for VisibilityLabel {}

/// The label of the bar's Preview/Markdown menu (`MarkdownViewMenu`): its
/// pick and a small chevron, grey until the pointer's on it, then a rounded
/// fill behind.
#[derive(IntoElement)]
pub(crate) struct ModeLabel {
    inner: Stateful<Div>,
}

impl ModeLabel {
    fn new(id: impl Into<ElementId>, title: &str, p: Palette) -> Self {
        let (hover, fg) = (p.hover, p.fg);
        let inner = div()
            .id(id)
            .flex_none()
            .h(px(26.))
            .px(px(7.))
            .flex()
            .items_center()
            .gap(px(3.))
            .rounded(px(6.))
            .cursor_pointer()
            .text_size(px(style::size::SMALL))
            .font_weight(FontWeight::MEDIUM)
            .text_color(p.secondary)
            .hover(move |s| s.bg(hover).text_color(fg))
            .child(title.to_owned())
            .child(icons::symbol("chevron.down").with_size(px(style::size::SMALL - 2.)));
        ModeLabel { inner }
    }
}

impl RenderOnce for ModeLabel {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        self.inner
    }
}

impl Styled for ModeLabel {
    fn style(&mut self) -> &mut StyleRefinement {
        self.inner.style()
    }
}

impl InteractiveElement for ModeLabel {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.inner.interactivity()
    }
}

impl Selectable for ModeLabel {
    fn selected(self, _: bool) -> Self {
        self
    }
    fn is_selected(&self) -> bool {
        false
    }
}

impl DropdownMenu for ModeLabel {}

impl SidePane {
    /// Starts loading the preview inside a section (`Files` subfolder browsing
    /// or a web link opening in the browser). File and standalone folder
    /// previews load through `begin_file_panel` / `load_folder_panel`.
    pub(crate) fn begin_preview(&mut self, thread: &ThreadSummary, cx: &mut Context<Self>) {
        let Some(preview) = self.previews.get(&thread.id).cloned() else {
            return;
        };
        match &preview.target {
            Target::File(path) => {
                // Legacy path: promote to a normal file panel.
                let (path, title, lines, thread) = (
                    path.clone(),
                    Some(preview.title.clone()),
                    preview.lines,
                    thread.clone(),
                );
                self.previews.remove(&thread.id);
                self.preview_path_at(&path, title, lines, &thread, cx);
            }
            Target::Page(url) => {
                open_web(url, cx);
                self.previews.remove(&thread.id);
                cx.notify();
            }
            Target::Folder(_) => self.load_folder_for_preview(thread, cx),
        }
    }

    /// Initializes or refreshes a file panel's state and starts reading it.
    pub(crate) fn open_file_state(
        &mut self,
        path: &str,
        title: Option<String>,
        lines: Option<(usize, usize)>,
        live: bool,
        thread: &ThreadSummary,
        cx: &mut Context<Self>,
    ) {
        let panel_id = core::file_panel(path);
        self.stop_explaining(&thread.id);
        self.preview_opened += 1;
        let opened = self.preview_opened;
        let title = title.unwrap_or_else(|| core::last_component(path).to_owned());
        let here = !thread.is_remote();
        let editing = here
            && threadbear_core::text_file::MarkdownView::opens_raw(
                path,
                self.files.prefs.markdown_view,
            );
        self.file_panels.insert(
            panel_id.clone(),
            FilePanelMeta {
                path: path.to_owned(),
                title,
                thread_id: thread.id.clone(),
                runner_id: thread.runner_id.clone(),
                remote: thread.is_remote(),
                opened,
                editing,
                live,
                lines,
            },
        );
        self.menu = None;
        self.begin_file_panel(&panel_id, cx);
        cx.refresh_windows();
        cx.notify();
    }

    /// Ensures a file panel restored from `desktop-settings.json` has metadata
    /// and starts reading it if it hasn't loaded yet.
    pub(crate) fn ensure_file_panel_loaded(&mut self, panel_id: &str, cx: &mut Context<Self>) {
        if !self.file_panels.contains_key(panel_id) {
            let Some(path) = core::file_panel_path(panel_id).map(str::to_owned) else {
                return;
            };
            self.preview_opened += 1;
            let opened = self.preview_opened;
            let editing = threadbear_core::text_file::MarkdownView::opens_raw(
                &path,
                self.files.prefs.markdown_view,
            );
            let (thread_id, runner_id, remote) =
                self.thread(cx).map_or((String::new(), None, false), |t| {
                    let remote = t.is_remote();
                    (t.id, t.runner_id, remote)
                });
            self.file_panels.insert(
                panel_id.to_owned(),
                FilePanelMeta {
                    title: core::last_component(&path).to_owned(),
                    path,
                    thread_id,
                    runner_id,
                    remote,
                    opened,
                    editing: !remote && editing,
                    live: false,
                    lines: None,
                },
            );
        }
        if !self.files.open.contains_key(panel_id) {
            self.begin_file_panel(panel_id, cx);
        } else if self
            .files
            .open
            .get(panel_id)
            .is_some_and(|o| o.changed_away)
        {
            if let Some(open) = self.files.open.get_mut(panel_id) {
                open.changed_away = false;
            }
            self.reread_file(panel_id, cx);
        }
    }

    /// Reads the file for `panel_id` according to its viewer kind.
    pub(crate) fn begin_file_panel(&mut self, panel_id: &str, cx: &mut Context<Self>) {
        let Some(meta) = self.file_panels.get(panel_id).cloned() else {
            return;
        };
        let path = &meta.path;
        match core::viewer_for_path(path) {
            Viewer::Web if meta.remote => {
                let note = "Web pages from another Mac can't be opened from here yet.".to_owned();
                self.files.open.insert(
                    panel_id.to_owned(),
                    OpenFile::new(path.clone(), meta.opened, FileBody::Opaque { note }),
                );
                cx.notify();
            }
            Viewer::Web => self.show_local_page(panel_id, path, meta.opened, meta.live, cx),
            _ if media_kind(path).is_some() => {
                self.show_media_file(panel_id, meta.remote, path, meta.opened, cx)
            }
            _ => self.load_file(
                panel_id,
                meta.runner_id,
                meta.remote,
                path.clone(),
                meta.opened,
                cx,
            ),
        }
    }

    /// Called when the user explicitly closes a file panel: flushes any
    /// unsaved edits and drops its open state.
    pub(crate) fn drop_file_panel(&mut self, panel_id: &str, cx: &mut Context<Self>) {
        self.leave_edit(panel_id, cx);
        self.files.open.remove(panel_id);
        self.file_panels.remove(panel_id);
        self.files.reads.remove(panel_id);
        if self
            .menu
            .as_ref()
            .is_some_and(|m| m.owner.as_deref() == Some(panel_id))
        {
            self.menu = None;
        }
        cx.notify();
    }

    /// A local web page: checked by the gate, then scanned off the main
    /// thread for scripts and its digest, which decide the bar over it and
    /// whether Run them was already chosen for these bytes.
    fn show_local_page(
        &mut self,
        panel_id: &str,
        path: &str,
        opened: u64,
        live: bool,
        cx: &mut Context<Self>,
    ) {
        if self
            .files
            .open
            .get(panel_id)
            .is_some_and(|f| f.path == path && f.opened == opened)
        {
            return;
        }
        let real = match threadbear_core::local_preview::decide_page(
            path,
            crate::open_gate::Origin::ThisMac,
        ) {
            Ok(real) => real,
            Err(note) => {
                self.files.open.insert(
                    panel_id.to_owned(),
                    OpenFile::new(path.to_owned(), opened, FileBody::Opaque { note }),
                );
                cx.notify();
                return;
            }
        };
        let real_text = real.to_string_lossy().into_owned();
        if live {
            // The card's Run already checked it for scripts; still auto-sync it
            // for a web link when the experiment is on.
            let page = LocalPage {
                real: real_text,
                scan: Some((false, String::new())),
                allowed: false,
                live: true,
                publication: Publication::Syncing {
                    url: None,
                    visibility: Visibility::Private,
                },
            };
            self.files.open.insert(
                panel_id.to_owned(),
                OpenFile::new(path.to_owned(), opened, FileBody::Page(page)),
            );
            self.change_publication(panel_id, opened, PublishAction::Sync, cx);
            cx.notify();
            return;
        }
        let page = LocalPage {
            real: real_text,
            scan: None,
            allowed: false,
            live: false,
            publication: Publication::Syncing {
                url: None,
                visibility: Visibility::Private,
            },
        };
        self.files.open.insert(
            panel_id.to_owned(),
            OpenFile::new(path.to_owned(), opened, FileBody::Page(page)),
        );
        cx.notify();
        let (panel_id, path) = (panel_id.to_owned(), path.to_owned());
        cx.spawn(async move |this, cx| {
            let found = cx
                .background_executor()
                .spawn(async move { threadbear_core::local_preview::scan(&real) })
                .await;
            this.update(cx, |pane, cx| {
                // The panel may have closed, or opened it again since.
                let Some(open) = pane
                    .files
                    .open
                    .get_mut(&panel_id)
                    .filter(|f| f.path == path && f.opened == opened)
                else {
                    return;
                };
                if let FileBody::Page(page) = &mut open.body {
                    page.allowed = found.as_ref().is_some_and(|(scripts, digest)| {
                        *scripts
                            && crate::prefs::load()
                                .preview_scripts
                                .allows(&page.real, digest)
                    });
                    page.scan = found;
                    if page.scan.is_some() {
                        pane.change_publication(&panel_id, opened, PublishAction::Sync, cx);
                    } else {
                        page.publication = Publication::Unavailable;
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn change_publication(
        &mut self,
        panel_id: &str,
        opened: u64,
        action: PublishAction,
        cx: &mut Context<Self>,
    ) {
        if !self
            .file_panels
            .get(panel_id)
            .is_some_and(|meta| meta.opened == opened)
        {
            return;
        }
        let Some(open) = self
            .files
            .open
            .get_mut(panel_id)
            .filter(|file| file.opened == opened)
        else {
            return;
        };
        let FileBody::Page(page) = &mut open.body else {
            return;
        };
        if page.scan.is_none() {
            return;
        }
        let (previous_url, previous_visibility) = match (&page.publication, action) {
            (Publication::Syncing { url, visibility }, PublishAction::Sync) => {
                (url.clone(), *visibility)
            }
            (
                Publication::Ready {
                    url, visibility, ..
                },
                PublishAction::Sync,
            ) => (url.clone(), *visibility),
            (
                Publication::Ready {
                    url, visibility, ..
                },
                PublishAction::Publish,
            ) => (url.clone(), *visibility),
            (
                Publication::Ready {
                    url: Some(url),
                    visibility,
                    ..
                },
                PublishAction::SetVisibility(_),
            ) => (Some(url.clone()), *visibility),
            (
                Publication::Ready {
                    url: Some(url),
                    visibility,
                    ..
                },
                PublishAction::Unpublish,
            ) => (Some(url.clone()), *visibility),
            _ => return,
        };
        page.publication = match action {
            PublishAction::Sync if previous_url.is_none() => Publication::Syncing {
                url: None,
                visibility: previous_visibility,
            },
            PublishAction::SetVisibility(next) => Publication::Working {
                url: previous_url.clone(),
                visibility: next,
            },
            _ => Publication::Working {
                url: previous_url.clone(),
                visibility: previous_visibility,
            },
        };
        let (client, panel_id, real) =
            (self.client.clone(), panel_id.to_owned(), page.real.clone());
        cx.notify();
        cx.spawn(async move |this, cx| {
            let params = match action {
                PublishAction::Sync => match &previous_url {
                    Some(url) => json!({ "action": "sync", "path": real, "expected": url }),
                    None => json!({ "action": "sync", "path": real }),
                },
                PublishAction::Publish => json!({
                    "action": "publish",
                    "path": real,
                    "expected": previous_url,
                }),
                PublishAction::SetVisibility(visibility) => json!({
                    "action": "setVisibility",
                    "path": real,
                    "visibility": visibility.wire(),
                    "expected": previous_url,
                }),
                PublishAction::Unpublish => json!({
                    "action": "unpublish",
                    "path": real,
                    "expected": previous_url,
                }),
            };
            let result = crate::call_action(client, "artifacts.manage", params)
                .await
                .map_err(|error| error.message);
            this.update(cx, |this, cx| {
                if !this
                    .file_panels
                    .get(&panel_id)
                    .is_some_and(|meta| meta.opened == opened)
                {
                    return;
                }
                let Some(open) = this
                    .files
                    .open
                    .get_mut(&panel_id)
                    .filter(|file| file.opened == opened)
                else {
                    return;
                };
                let FileBody::Page(page) = &mut open.body else {
                    return;
                };
                page.publication = match result {
                    Ok(answer) if answer["available"] == true => {
                        let url = answer["url"].as_str().map(str::to_owned);
                        let visibility = Visibility::from_wire(answer["visibility"].as_str());
                        let conflict = matches!(
                            action,
                            PublishAction::Unpublish | PublishAction::SetVisibility(_)
                        ) && answer["changed"] != true;
                        Publication::Ready {
                            url,
                            visibility,
                            error: conflict.then(|| {
                                "The web copy changed elsewhere. Check it and try again.".into()
                            }),
                            copied: false,
                        }
                    }
                    Ok(_) => Publication::Unavailable,
                    Err(message) => Publication::Ready {
                        url: previous_url,
                        visibility: previous_visibility,
                        error: Some(message),
                        copied: false,
                    },
                };
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn artifact_visibility_menu(
        &self,
        thread_id: &str,
        opened: u64,
        visibility: Visibility,
        working: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let side = cx.entity().downgrade();
        let menu_thread = thread_id.to_owned();
        if working {
            let holder = crate::highlights::tipped_as(
                div().id("hl-page-visibility").flex_none(),
                "Change who can open this link",
                gpui_kit::Role::GenericContainer,
            );
            let trigger = VisibilityLabel::new("hl-page-visibility-label", visibility, true, cx);
            return holder.child(trigger).into_any_element();
        }
        let fill = std::rc::Rc::new(move |menu: PopupMenu| {
            let (s1, t1) = (side.clone(), menu_thread.clone());
            let (s2, t2) = (side.clone(), menu_thread.clone());
            let (s3, t3) = (side.clone(), menu_thread.clone());
            let (s4, t4) = (side.clone(), menu_thread.clone());
            menu.item(
                PopupMenuItem::new("Private")
                    .checked(visibility == Visibility::Private)
                    .icon(icons::symbol("lock"))
                    .on_click(move |_, _, cx| {
                        s1.update(cx, |this, cx| {
                            this.change_publication(
                                &t1,
                                opened,
                                PublishAction::SetVisibility(Visibility::Private),
                                cx,
                            );
                        })
                        .ok();
                    }),
            )
            .item(
                PopupMenuItem::new("Anyone with link")
                    .checked(visibility == Visibility::Public)
                    .icon(icons::symbol("globe"))
                    .on_click(move |_, _, cx| {
                        s2.update(cx, |this, cx| {
                            this.change_publication(
                                &t2,
                                opened,
                                PublishAction::SetVisibility(Visibility::Public),
                                cx,
                            );
                        })
                        .ok();
                    }),
            )
            .separator()
            .item(
                PopupMenuItem::new("Update web copy")
                    .icon(icons::symbol("arrow.clockwise"))
                    .on_click(move |_, _, cx| {
                        s3.update(cx, |this, cx| {
                            this.change_publication(&t3, opened, PublishAction::Sync, cx);
                        })
                        .ok();
                    }),
            )
            .item(
                PopupMenuItem::new("Remove web copy")
                    .icon(icons::symbol("trash"))
                    .on_click(move |_, _, cx| {
                        s4.update(cx, |this, cx| {
                            this.change_publication(&t4, opened, PublishAction::Unpublish, cx);
                        })
                        .ok();
                    }),
            )
        });
        if crate::popup_host::supported() {
            let bounds_cell = std::rc::Rc::new(std::cell::Cell::new(Bounds::default()));
            let capture = bounds_cell.clone();
            let trigger = VisibilityLabel::new("hl-page-visibility-label", visibility, false, cx)
                .inner
                .relative()
                .child(
                    canvas(move |bounds, _, _| capture.set(bounds), |_, _, _, _| {})
                        .absolute()
                        .inset_0(),
                );
            return crate::highlights::tipped(trigger, "Change who can open this link")
                .on_click(move |event: &ClickEvent, window, cx| {
                    let mut anchor = bounds_cell.get();
                    if anchor.is_empty() {
                        anchor = Bounds::new(event.position(), size(px(1.), px(1.)));
                    }
                    let fill = fill.clone();
                    crate::popup_host::open_menu(
                        "hl-page-visibility",
                        true,
                        anchor,
                        px(190.),
                        window,
                        cx,
                        move |menu, _, _| fill(menu),
                    );
                })
                .into_any_element();
        }
        let holder = crate::highlights::tipped_as(
            div().id("hl-page-visibility").flex_none(),
            "Change who can open this link",
            gpui_kit::Role::GenericContainer,
        );
        let trigger = VisibilityLabel::new("hl-page-visibility-label", visibility, false, cx);
        holder
            .child(trigger.dropdown_menu(move |menu: PopupMenu, _, _| fill(menu)))
            .into_any_element()
    }

    fn publish_bar(
        &self,
        page: &LocalPage,
        thread_id: &str,
        opened: u64,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        use crate::push_button::PushButton;
        let (url, visibility, error, copied, working, initial_sync) = match &page.publication {
            Publication::Unavailable => return None,
            Publication::Syncing { url, visibility } => {
                (url.clone(), *visibility, None, false, true, url.is_none())
            }
            Publication::Working { url, visibility } => {
                (url.clone(), *visibility, None, false, true, false)
            }
            Publication::Ready {
                url,
                visibility,
                error,
                copied,
            } => (
                url.clone(),
                *visibility,
                error.clone(),
                *copied,
                false,
                false,
            ),
        };
        if initial_sync {
            return Some(
                h_flex()
                    .flex_none()
                    .w_full()
                    .px(px(10.))
                    .py(px(6.))
                    .gap(px(6.))
                    .items_center()
                    .child(Spinner::new().color(p.secondary).with_size(px(11.)))
                    .child(
                        div()
                            .text_size(px(style::size::SMALL))
                            .text_color(p.secondary)
                            .child("Uploading web copy…"),
                    )
                    .into_any_element(),
            );
        }
        let mut row = h_flex().flex_wrap().gap(px(6.)).items_center();
        if let Some(open_link) = url {
            let open_button = crate::highlights::tipped(
                div()
                    .id("hl-page-open-web")
                    .flex_none()
                    .h(px(26.))
                    .px(px(11.))
                    .rounded(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .bg(p.accent)
                    .text_size(px(style::size::LABEL))
                    .font_weight(FontWeight::MEDIUM)
                    .whitespace_nowrap()
                    .text_color(gpui::white())
                    .cursor_pointer()
                    .hover(|s| s.opacity(0.9))
                    .active(|s| s.opacity(0.8))
                    .child(icons::symbol("arrow.up.right").with_size(px(12.)))
                    .child("Open on web"),
                "Open this page on the web",
            )
            .on_click(move |_, _, cx| open_web(&open_link, cx));
            row = row
                .child(open_button)
                .child(self.artifact_visibility_menu(thread_id, opened, visibility, working, cx));

            let copy_thread = thread_id.to_owned();
            row = row.child(
                PushButton::new(
                    "hl-page-copy-link",
                    if copied { "Copied" } else { "Copy link" },
                    "Copy the link to this page",
                )
                .render(
                    cx,
                    cx.listener(move |this, _, _, cx| {
                        if !this
                            .previews
                            .get(&copy_thread)
                            .is_some_and(|preview| preview.opened == opened)
                        {
                            return;
                        }
                        let Some(open) = this
                            .files
                            .open
                            .get_mut(&copy_thread)
                            .filter(|file| file.opened == opened)
                        else {
                            return;
                        };
                        let FileBody::Page(page) = &mut open.body else {
                            return;
                        };
                        let Publication::Ready {
                            url: Some(url),
                            copied,
                            ..
                        } = &mut page.publication
                        else {
                            return;
                        };
                        cx.write_to_clipboard(ClipboardItem::new_string(url.clone()));
                        *copied = true;
                        cx.notify();
                    }),
                ),
            );
        } else {
            let sync_thread = thread_id.to_owned();
            row = row.child(
                PushButton::new(
                    "hl-page-upload",
                    if working {
                        "Uploading…"
                    } else {
                        "Upload to web"
                    },
                    "Upload this file for a web link",
                )
                .busy(working)
                .render(
                    cx,
                    cx.listener(move |this, _, _, cx| {
                        this.change_publication(&sync_thread, opened, PublishAction::Sync, cx)
                    }),
                ),
            );
        }
        Some(
            v_flex()
                .flex_none()
                .w_full()
                .px(px(10.))
                .py(px(6.))
                .gap(px(4.))
                .child(row)
                .children(error.map(|message| {
                    div()
                        .text_size(px(style::size::SMALL))
                        .text_color(p.secondary)
                        .child(message)
                }))
                .into_any_element(),
        )
    }

    /// Run them: these bytes of this page may run their scripts, from now
    /// until the file changes; it loads again with them on.
    pub(crate) fn run_page_scripts(&mut self, thread_id: &str, cx: &mut Context<Self>) {
        let Some(open) = self.files.open.get_mut(thread_id) else {
            return;
        };
        let FileBody::Page(page) = &mut open.body else {
            return;
        };
        let Some((true, digest)) = page.scan.clone() else {
            return;
        };
        let mut prefs = crate::prefs::load();
        prefs.preview_scripts.allow(&page.real, &digest);
        crate::prefs::save(&prefs);
        page.allowed = true;
        cx.notify();
    }

    /// The bar over a page with scripts that aren't running
    /// (`LocalPagePreview`): what it is, why, and Run them.
    fn scripts_bar(&self, thread_id: &str, p: Palette, cx: &mut Context<Self>) -> AnyElement {
        use threadbear_core::local_preview::words;
        let thread_id = thread_id.to_owned();
        let run =
            cx.listener(move |this, _: &ClickEvent, _, cx| this.run_page_scripts(&thread_id, cx));
        v_flex()
            .flex_none()
            .w_full()
            .child(
                h_flex()
                    .id("hl-page-scripts")
                    .w_full()
                    .px(px(10.))
                    .py(px(6.))
                    .gap(px(6.))
                    .items_center()
                    .child(
                        div()
                            .text_size(px(style::size::SMALL))
                            .text_color(p.secondary)
                            .child(words::HAS_SCRIPTS),
                    )
                    .child(crate::highlights::tipped_as(
                        div()
                            .id("hl-page-scripts-why")
                            .flex_none()
                            .child(crate::highlights::icon("info.circle", 11., p.faint)),
                        words::EXPLANATION,
                        gpui_kit::Role::Image,
                    ))
                    .child(div().flex_1())
                    .child(
                        crate::push_button::PushButton::new(
                            "hl-page-run",
                            words::RUN_THEM,
                            words::RUN_THEM_TIP,
                        )
                        .render(cx, run),
                    ),
            )
            .child(div().h(px(1.)).w_full().bg(p.hairline))
            .into_any_element()
    }

    /// A video or a PDF: in the system's view over the pane, made as it's
    /// drawn, if the open gate's rules let it (this Mac's own, a real one);
    /// else why not, in its place.
    fn show_media_file(
        &mut self,
        panel_id: &str,
        remote: bool,
        path: &str,
        opened: u64,
        cx: &mut Context<Self>,
    ) {
        if self
            .files
            .open
            .get(panel_id)
            .is_some_and(|f| f.path == path && f.opened == opened)
        {
            return;
        }
        let Some(kind) = media_kind(path) else { return };
        let origin = if remote {
            crate::open_gate::Origin::OtherMac
        } else {
            crate::open_gate::Origin::ThisMac
        };
        let body = match threadbear_core::open_policy::decide_media(path, origin) {
            threadbear_core::open_policy::MediaVerdict::Show(_) => FileBody::Media(kind),
            threadbear_core::open_policy::MediaVerdict::Refuse(note) => FileBody::Opaque { note },
        };
        self.files.open.insert(
            panel_id.to_owned(),
            OpenFile::new(path.to_owned(), opened, body),
        );
        cx.notify();
    }

    fn load_file(
        &mut self,
        panel_id: &str,
        runner_id: Option<String>,
        remote: bool,
        path: String,
        opened: u64,
        cx: &mut Context<Self>,
    ) {
        // The same open again (a repaint, a re-select) reads nothing new;
        // opening it again from a row does (`opened` moved), and so does
        // coming back to a panel whose file changed while it was hidden.
        if let Some(open) = self
            .files
            .open
            .get_mut(panel_id)
            .filter(|f| f.path == path && f.opened == opened)
        {
            // One still waiting for the runner is read again too.
            if !open.changed_away && !open.waiting_for_runner {
                return;
            }
            open.changed_away = false;
            open.waiting_for_runner = false;
        }
        self.read_file(panel_id, runner_id, remote, path, opened, cx);
    }

    /// The file panel, read again where it is: its folder heard it change,
    /// or its own text was put away (Done).
    pub(crate) fn reread_file(&mut self, panel_id: &str, cx: &mut Context<Self>) {
        // If this file panel isn't currently docked (e.g. hidden on another
        // thread), defer reading until its thread/panel returns.
        if !self.dock_showing(panel_id, cx) {
            if let Some(open) = self.files.open.get_mut(panel_id) {
                open.changed_away = true;
            }
            return;
        }
        let Some(meta) = self.file_panels.get(panel_id).cloned() else {
            return;
        };
        let Some((path, opened)) = self
            .files
            .open
            .get(panel_id)
            .map(|f| (f.path.clone(), f.opened))
        else {
            return;
        };
        if meta.path != path {
            return;
        }
        self.read_file(panel_id, meta.runner_id, meta.remote, path, opened, cx);
    }

    /// Asks the runner for the file's bytes.
    fn read_file(
        &mut self,
        panel_id: &str,
        runner_id: Option<String>,
        remote: bool,
        path: String,
        opened: u64,
        cx: &mut Context<Self>,
    ) {
        let keep_previous = self
            .files
            .open
            .get(panel_id)
            .is_some_and(|f| f.path == path);
        let here = !remote;
        if !keep_previous {
            self.files.open.insert(
                panel_id.to_owned(),
                OpenFile::new(path.clone(), opened, FileBody::Loading),
            );
            cx.notify();
        }
        let client = self.client.clone();
        let panel_id = panel_id.to_owned();
        let read_number = {
            let n = self.files.reads.entry(panel_id.clone()).or_default();
            *n += 1;
            *n
        };
        let mut params = json!({ "path": path, "maxBytes": MAX_BYTES });
        if let Some(runner) = &runner_id {
            params["runnerId"] = json!(runner);
        }
        cx.spawn(async move |this, cx| {
            let res = call(client, "files.read", params).await;
            // Not past what was asked for, however much the runner sent.
            let read = res
                .as_ref()
                .ok()
                .map(|value| FileRead::decode_at_most(value, MAX_BYTES));
            this.update(cx, |this, cx| {
                // Panel closed or replaced while the read was in flight.
                let current = this.file_panels.get(&panel_id).map(|m| m.path.clone());
                if current.as_deref() != Some(path.as_str())
                    || this.files.reads.get(&panel_id) != Some(&read_number)
                {
                    return;
                }
                match (res, read) {
                    (Ok(_), Some(read)) => match read {
                        Some(read) => this.show_read(&panel_id, &path, opened, read, here, cx),
                        None => this.fail_file(
                            &panel_id,
                            &path,
                            opened,
                            "Couldn't read that answer from the runner.".into(),
                            cx,
                        ),
                    },
                    (Err(e), _) if e.message.starts_with("Not a file") => {
                        // A folder (e.g. on another Mac): promote this panel
                        // in place to a folder panel.
                        this.files.known_folders.insert(path.clone());
                        let meta = this.file_panels.remove(&panel_id);
                        this.files.open.remove(&panel_id);
                        if let (Some(app), Some(meta)) = (this.app.upgrade(), meta) {
                            let old_panel = panel_id.clone();
                            cx.defer(move |cx| {
                                app.update(cx, |app, cx| {
                                    app.promote_file_to_folder_panel(&old_panel, meta, cx)
                                });
                            });
                        }
                        cx.notify();
                    }
                    // No runner (not a slow one: a timeout while connected
                    // has no reconnect to wait for, so it fails as it is).
                    (Err(e), _)
                        if matches!(
                            e.code,
                            threadbear_client::runner::NOT_CONNECTED
                                | threadbear_client::runner::CLOSED
                        ) =>
                    {
                        this.wait_for_runner(&panel_id, &path, opened, cx)
                    }
                    (Err(e), _) => this.fail_file(&panel_id, &path, opened, e.message, cx),
                    (Ok(_), None) => {}
                }
            })
            .ok();
        })
        .detach();
    }

    /// No runner to read it: what was showing stays (a file read again),
    /// or the pane says it's waiting, and SidePane::connected reads it.
    fn wait_for_runner(
        &mut self,
        thread_id: &str,
        path: &str,
        opened: u64,
        cx: &mut Context<Self>,
    ) {
        let open = self
            .files
            .open
            .entry(thread_id.to_owned())
            .or_insert_with(|| OpenFile::new(path.to_owned(), opened, FileBody::Waiting));
        if matches!(open.body, FileBody::Loading | FileBody::Failed { .. }) {
            open.body = FileBody::Waiting;
        }
        open.waiting_for_runner = true;
        cx.notify();
        // The answer can land after the reconnect it should wait for: the
        // client says Connected a moment before its session's set, so the
        // sweep can run first (Codex's review, 17 Nov). Look again in half
        // a second, when a runner that's back has its session; one still
        // away is read by SidePane::connected.
        let (thread_id, client) = (thread_id.to_owned(), self.client.clone());
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(500))
                .await;
            if client.connected_session().is_none() {
                return;
            }
            this.update(cx, |this, cx| {
                if let Some(open) = this
                    .files
                    .open
                    .get_mut(&thread_id)
                    .filter(|f| f.waiting_for_runner)
                {
                    open.waiting_for_runner = false;
                    this.reread_file(&thread_id, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn fail_file(
        &mut self,
        thread_id: &str,
        path: &str,
        opened: u64,
        message: String,
        cx: &mut Context<Self>,
    ) {
        self.files.open.insert(
            thread_id.to_owned(),
            OpenFile::new(path.to_owned(), opened, FileBody::Failed { message }),
        );
        cx.notify();
    }

    fn show_read(
        &mut self,
        panel_id: &str,
        path: &str,
        opened: u64,
        read: FileRead,
        here: bool,
        cx: &mut Context<Self>,
    ) {
        let viewer = core::viewer_for_path(path);
        let is_picture = viewer == Viewer::Picture
            && (core::looks_like_picture(path) || image_format(path).is_some());
        let body = if is_picture {
            // Only its start, or more than was asked for, won't draw.
            let whole = !read.truncated && read.data.len() as u64 <= MAX_BYTES;
            match image_format(path).filter(|_| whole) {
                Some(format) => {
                    // encoded: the file's own bytes; drawn through the picture budget.
                    let image = Arc::new(Image::from_bytes(format, read.data));
                    FileBody::Picture {
                        size: crate::fit_picture::size_of(image.bytes())
                            .or_else(|| picture_size(image.bytes())),
                        image,
                    }
                }
                None if !whole => FileBody::Opaque {
                    note: "This picture is too big to show here.".into(),
                },
                None => FileBody::Opaque {
                    note: "This kind of picture opens in its own app.".into(),
                },
            }
        } else {
            let text_ok = viewer == Viewer::Text || core::looks_like_text(&read.data);
            let opaque = viewer != Viewer::Text && !core::looks_like_text(&read.data);
            if opaque || !text_ok {
                FileBody::Opaque {
                    note: "This file opens in its own app.".into(),
                }
            } else {
                match String::from_utf8(read.data) {
                    Err(_) => FileBody::Opaque {
                        note: "This file isn't text this app can read.".into(),
                    },
                    Ok(text) => self.text_body(path, text, cx),
                }
            }
        };
        // A file read again (opened again from a row, or changed on disk) keeps
        // its find bar, its own text being worked on (checked against the
        // file, as `check` does), the page where it was, and the watch on it.
        let previous = self.files.open.remove(panel_id).filter(|f| f.path == path);
        let body = match (body, previous.as_ref().map(|p| &p.body)) {
            // The same words: nothing to draw again, and nothing moves.
            (FileBody::Markdown { text, .. }, Some(FileBody::Markdown { doc, text: was }))
                if text == *was =>
            {
                FileBody::Markdown {
                    doc: doc.clone(),
                    text,
                }
            }
            (
                FileBody::Text { text, language, .. },
                Some(FileBody::Text {
                    editor, text: was, ..
                }),
            ) if text == *was => FileBody::Text {
                editor: editor.clone(),
                text,
                language,
            },
            // New words on the same page: read again where it was.
            (FileBody::Markdown { text, doc: fresh }, Some(FileBody::Markdown { doc, .. })) => {
                drop(fresh);
                let source = text.to_string();
                doc.update(cx, |s, cx| s.set_text(&source, cx));
                FileBody::Markdown {
                    doc: doc.clone(),
                    text,
                }
            }
            (body, _) => body,
        };
        let page_watch = match &body {
            // The find bar searches what the page draws, which lands after
            // its parse: it searches again when the page changes.
            FileBody::Markdown { doc, .. } => {
                let id = panel_id.to_owned();
                Some(cx.observe(doc, move |this, _, cx| this.page_changed(&id, cx)))
            }
            _ => None,
        };
        let text = matches!(body, FileBody::Markdown { .. } | FileBody::Text { .. });
        let mut open = OpenFile::new(path.to_owned(), opened, body);
        let mut had_edit = false;
        // Its own text stays only while the panel's still working on it
        // (opened again from a row, it reads, as the Swift app's does).
        let editing = self.file_panels.get(panel_id).is_some_and(|p| p.editing);
        if let Some(previous) = previous {
            open.find = previous.find;
            open.page_scroll = previous.page_scroll;
            open.focus = previous.focus;
            if editing {
                had_edit = previous.edit.is_some();
                open.edit = previous.edit;
            }
            open._file_watch = previous._file_watch;
            open.lines_shown = previous.lines_shown;
            open.line_marks = previous.line_marks;
        }
        // Text on this machine is watched, so an agent's rewrite shows up by
        // itself; another Mac's is that Mac's to say.
        if here && text && open._file_watch.is_none() {
            open._file_watch = self.watch_file(panel_id, path, cx);
        }
        open.truncated = read.truncated;
        open.size = read.size;
        open._page_watch = page_watch;
        self.files.open.insert(panel_id.to_owned(), open);
        if had_edit {
            self.check_edit(panel_id, cx);
        }
        // The new text under an open find bar.
        if self
            .files
            .open
            .get(panel_id)
            .is_some_and(|o| o.find.is_some())
        {
            self.find_changed(panel_id, cx);
        }
        // Update dock bar buttons (Markdown menu / pencil) once the body is ready.
        cx.refresh_windows();
        cx.notify();
    }

    /// A watch on the file's folder that reads the file again when it
    /// changes, a moment after the burst settles. Its own text being worked
    /// on has a watch of its own (file_edit.rs).
    fn watch_file(
        &mut self,
        thread_id: &str,
        path: &str,
        cx: &mut Context<Self>,
    ) -> Option<FolderWatch> {
        let file = std::path::Path::new(path).file_name().map(|n| n.to_owned());
        let folder = std::path::Path::new(path)
            .parent()?
            .to_string_lossy()
            .into_owned();
        let id = thread_id.to_owned();
        let mut watch = FolderWatch::new(cx, move |this: &mut SidePane, _, paths, cx| {
            if !paths.iter().any(|p| p.file_name() == file.as_deref()) {
                return;
            }
            let Some(open) = this.files.open.get_mut(&id).filter(|o| o.edit.is_none()) else {
                return;
            };
            // One read after the burst: a newer change puts the read off.
            let later = id.clone();
            open._reread = Some(cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(
                        threadbear_core::text_file::CHECK_DELAY_MS,
                    ))
                    .await;
                this.update(cx, |this, cx| this.reread_file(&later, cx))
                    .ok();
            }));
        })?;
        watch.set(&HashSet::from([folder]));
        Some(watch)
    }

    /// Markdown drawn, code coloured, text plain, all of it selectable.
    fn text_body(&mut self, path: &str, text: String, cx: &mut Context<Self>) -> FileBody {
        let text: Arc<str> = text.into();
        if core::is_markdown(path) {
            let source = text.to_string();
            let doc = cx.new(|cx| TextViewState::markdown(&source, cx));
            return FileBody::Markdown { doc, text };
        }
        let language = core::code_language(path).filter(|_| text.len() < HIGHLIGHT_LIMIT);
        // The editor is made at the next frame, with a window (render_file).
        FileBody::Text {
            editor: None,
            text,
            language,
        }
    }

    /// A previewed Markdown file, its links going through the open gate:
    /// a file it links to (from the file's own folder) previews here too,
    /// read through the runner, so a repo's page can't hand the system one
    /// of its programs; a web page opens; anything else asks.
    fn preview_text(
        &self,
        doc: &Entity<TextViewState>,
        remote: bool,
        path: &str,
        cx: &mut Context<Self>,
    ) -> gpui_kit::base::TextView {
        use threadbear_core::open_policy::{self as policy, LinkKind};
        let origin = if remote {
            crate::open_gate::Origin::OtherMac
        } else {
            crate::open_gate::Origin::ThisMac
        };
        let folder = path
            .rsplit_once(['/', '\\'])
            .map_or(String::new(), |(dir, _)| dir.to_owned());
        let side = cx.entity().downgrade();
        let base = folder.clone();
        crate::open_gate::text_view(doc, origin, &folder).on_link_click(
            move |url: &SharedString, _: &ClickEvent, _: &mut Window, cx: &mut App| {
                match policy::link_kind(url) {
                    LinkKind::File(target) => {
                        if let Some(target) = policy::absolute(&target, &base, &home_dir()) {
                            let _ = side.update(cx, |side, cx| {
                                if let Some(thread) = side.thread(cx) {
                                    side.preview_path(&target, None, &thread, cx);
                                }
                            });
                        }
                    }
                    _ => crate::open_gate::open_link(url, origin, &base, cx),
                }
            },
        )
    }

    /// Whether a file panel offers its own raw text (the Markdown menu or
    /// pencil): a whole text file on this runner's machine.
    pub(crate) fn offers_text_panel(&self, panel_id: &str) -> bool {
        let Some(meta) = self.file_panels.get(panel_id) else {
            return false;
        };
        !meta.remote
            && self
                .files
                .open
                .get(panel_id)
                .is_some_and(|f| f.path == meta.path && f.is_whole_text())
    }

    /// The bar's buttons over a preview inside `Files` (`Target::Folder`).
    /// File and standalone folder panels draw their buttons in BearDock's bar.
    pub(crate) fn preview_buttons(
        &mut self,
        preview: &PanePreview,
        thread: &ThreadSummary,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut row = h_flex().flex_none().gap(px(0.));
        if let Target::Folder(path) = &preview.target {
            row = row.child(self.folder_mode_button(p, cx));
            // Another Mac's folder has no copy here to hand over.
            if !thread.is_remote() {
                let open_path = path.clone();
                row = row.child(self.header_button(
                    "hl-open",
                    "arrow.up.right",
                    "Open in Finder".to_owned(),
                    p,
                    cx,
                    move |this, cx| this.open_externally(&open_path.clone(), cx),
                ));
            }
        }
        row
    }

    /// `MarkdownViewMenu`: Preview or Markdown, the pick remembered for the
    /// next Markdown file, drawn in BearDock's bar for `panel_id`.
    pub(crate) fn markdown_menu_for(
        &self,
        panel_id: &str,
        editing: bool,
        p: Palette,
        cx: &App,
        side: WeakEntity<SidePane>,
    ) -> AnyElement {
        let _ = cx;
        let showing = if editing {
            MarkdownView::Markdown
        } else {
            MarkdownView::Preview
        };
        let tip = showing.tip();
        let panel_key = panel_id.to_owned();
        if crate::popup_host::supported() {
            let bounds_cell = std::rc::Rc::new(std::cell::Cell::new(Bounds::default()));
            let capture = bounds_cell.clone();
            let trigger = ModeLabel::new(
                SharedString::from(format!("hl-markdown-view-label-{panel_id}")),
                showing.title(),
                p,
            )
            .inner
            .relative()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                canvas(move |bounds, _, _| capture.set(bounds), |_, _, _, _| {})
                    .absolute()
                    .inset_0(),
            );
            return crate::highlights::tipped(trigger, tip)
                .on_click(move |event: &ClickEvent, window, cx| {
                    let mut anchor = bounds_cell.get();
                    if anchor.is_empty() {
                        anchor = Bounds::new(event.position(), size(px(1.), px(1.)));
                    }
                    let owner_handle = window.window_handle();
                    let (side, panel_key) = (side.clone(), panel_key.clone());
                    crate::popup_host::open_menu(
                        "hl-markdown-view",
                        true,
                        anchor,
                        px(150.),
                        window,
                        cx,
                        move |mut menu: PopupMenu, _, _| {
                            for view in MarkdownView::ALL {
                                let (side, panel_key) = (side.clone(), panel_key.clone());
                                let item = PopupMenuItem::new(view.title())
                                    .checked(view == showing)
                                    .icon(icons::symbol(view.symbol()))
                                    .on_click(move |_, _, cx| {
                                        let (side, panel_key) = (side.clone(), panel_key.clone());
                                        cx.defer(move |cx| {
                                            let _ =
                                                owner_handle.update(cx, |_, owner_window, cx| {
                                                    side.update(cx, |this, cx| {
                                                        this.pick_markdown_view_for(
                                                            &panel_key,
                                                            view,
                                                            owner_window,
                                                            cx,
                                                        );
                                                    })
                                                    .ok();
                                                });
                                        });
                                    });
                                menu = menu.item(item);
                            }
                            menu
                        },
                    );
                })
                .into_any_element();
        }
        let holder = crate::highlights::tipped_as(
            div()
                .id(SharedString::from(format!("hl-markdown-view-{panel_id}")))
                .flex_none()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation()),
            tip,
            gpui_kit::Role::GenericContainer,
        );
        let menu = ModeLabel::new(
            SharedString::from(format!("hl-markdown-view-label-{panel_id}")),
            showing.title(),
            p,
        )
        .dropdown_menu(move |menu: PopupMenu, _, _| {
            let mut menu = menu;
            for view in MarkdownView::ALL {
                let (side, panel_key) = (side.clone(), panel_key.clone());
                let item = PopupMenuItem::new(view.title())
                    .checked(view == showing)
                    .icon(icons::symbol(view.symbol()))
                    .on_click(move |_, window, cx| {
                        side.update(cx, |this, cx| {
                            this.pick_markdown_view_for(&panel_key, view, window, cx)
                        })
                        .ok();
                    });
                menu = menu.item(item);
            }
            menu
        });
        holder.child(menu).into_any_element()
    }

    /// A pick from the Markdown menu: this file panel shows that way, and so
    /// does the next Markdown file opened (`MarkdownView.current`).
    pub(crate) fn pick_markdown_view_for(
        &mut self,
        panel_id: &str,
        view: MarkdownView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.files.prefs.markdown_view = view;
        crate::files_store::save(&self.files.prefs);
        self.set_file_panel_editing(panel_id, view == MarkdownView::Markdown, window, cx);
    }

    /// The pencil or Done, from BearDock's bar, where there's no window to
    /// hand: the change runs on the file panel's window.
    pub(crate) fn request_editing_for(
        &mut self,
        panel_id: &str,
        editing: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(handle) = self.files.window else {
            return;
        };
        let (side, panel_id) = (cx.entity().downgrade(), panel_id.to_owned());
        cx.defer(move |cx| {
            let _ = handle.update(cx, |_, window, cx| {
                side.update(cx, |this, cx| {
                    this.set_file_panel_editing(&panel_id, editing, window, cx);
                })
            });
        });
    }

    /// The file's own text, shown to type in or put away: the pencil and Done,
    /// or the Markdown menu's pick. Done while what's typed can't be saved (a
    /// conflict waiting, a file that can't take it) stays editing, so the
    /// typing is still there for the conflict bar or another try.
    pub(crate) fn set_file_panel_editing(
        &mut self,
        panel_id: &str,
        editing: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(meta) = self.file_panels.get(panel_id) else {
            return;
        };
        if meta.editing == editing {
            return;
        }
        if !editing {
            if let Some(edit) = self
                .files
                .open
                .get_mut(panel_id)
                .and_then(|o| o.edit.as_mut())
            {
                let typed = edit.editor.read(cx).value().to_string();
                if !edit.session.set_editing(false, &typed) {
                    cx.notify();
                    return;
                }
            }
        }
        if let Some(meta) = self.file_panels.get_mut(panel_id) {
            meta.editing = editing;
        }
        let had_find = self
            .files
            .open
            .get(panel_id)
            .is_some_and(|o| o.find.is_some());
        if !editing {
            let had_edit = self
                .files
                .open
                .get_mut(panel_id)
                .and_then(|o| o.edit.take())
                .is_some();
            // What was saved shows as it now reads.
            if had_edit {
                self.reread_file(panel_id, cx);
            }
        }
        self.ensure_edit_for(panel_id, window, cx);
        // The find bar stays, searching what shows now.
        if had_find {
            self.find_changed(panel_id, cx);
        }
        cx.refresh_windows();
        cx.notify();
    }

    /// The file's own text for a panel that's showing it, made once there's
    /// a window to make its editor with.
    fn ensure_edit_for(&mut self, panel_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(meta) = self.file_panels.get(panel_id).cloned() else {
            return;
        };
        if !meta.editing || !self.offers_text_panel(panel_id) {
            return;
        }
        let Some(open) = self.files.open.get(panel_id) else {
            return;
        };
        if open.edit.is_some() {
            return;
        }
        let path = open.path.clone();
        let language = core::code_language(&path).filter(|_| open.size < HIGHLIGHT_LIMIT as i64);
        let edit = FileEdit::open(panel_id, &path, language, window, cx);
        if let Some(open) = self.files.open.get_mut(panel_id) {
            open.edit = Some(edit);
        }
    }

    pub(crate) fn render_preview(
        &mut self,
        thread: &ThreadSummary,
        preview: &PanePreview,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = palette(cx);
        match &preview.target {
            Target::File(_) => pane_note("Opened in its own panel.", p).into_any_element(),
            Target::Page(url) => {
                pane_note(&format!("{url} opened in your browser."), p).into_any_element()
            }
            Target::Folder(path) => self.render_folder(thread, path, preview, window, cx),
        }
    }

    /// The lines a link named (`a.ts:12-18`), in whichever editor is showing
    /// the file (its own text up to type in, or the one to read): tinted,
    /// marked in the gutter, and scrolled to once laid out (the editor
    /// scrolls only to what it has drawn). Opened again with other lines, or
    /// none, the old tint goes; typing takes it off (`clear_line_marks`).
    /// `lines` come with the opening they were asked for.
    fn show_lines(
        &mut self,
        thread_id: &str,
        path: &str,
        lines: Option<((usize, usize), u64)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(open) = self
            .files
            .open
            .get_mut(thread_id)
            .filter(|f| f.path == path)
        else {
            return;
        };
        let editor = match (&open.edit, &open.body) {
            (Some(edit), _) => edit.editor.clone(),
            (
                None,
                FileBody::Text {
                    editor: Some(editor),
                    ..
                },
            ) => editor.clone(),
            _ => return,
        };
        let opened = open.opened;
        let wanted = lines.filter(|(_, o)| *o == opened).map(|(l, _)| l);
        if open.lines_shown == Some(opened) || (wanted.is_none() && open.line_marks.is_none()) {
            return;
        }
        open.lines_shown = Some(opened);
        // Marks made on the other editor (read, then put up to type in) go
        // with it; these are this one's.
        if let Some((fill, mark)) = open.line_marks.take() {
            fill.set(vec![], cx);
            mark.set(vec![], cx);
        }
        let Some((first, last)) = wanted else { return };
        let text = editor.read(cx).value().to_string();
        let range = threadbear_core::file_refs::line_bytes(&text, first, last);
        // Through the last line's newline, so its tint is the whole line
        // wide as the others' are.
        let range = range.start..(range.end + 1).min(text.len());
        let accent = style::accent(cx);
        let fill = RangeDecoration::new(range.clone())
            .with_style(RangeDecorationStyle::Fill)
            .with_color(accent.opacity(0.18));
        let mark = GutterDecoration::new(range.clone()).with_color(accent);
        open.line_marks = Some(editor.update(cx, |state, cx| {
            (
                state.create_range_decorations_collection(vec![fill], cx),
                state.create_gutter_decorations_collection(vec![mark], cx),
            )
        }));
        window.on_next_frame(move |_, cx| {
            editor.update(cx, |state, cx| {
                state.set_selected_range(range.start..range.start, cx)
            })
        });
    }

    /// Typing in the file takes the tint off the lines a link named: they're
    /// being changed, so it would only mislead.
    pub(crate) fn clear_line_marks(&mut self, thread_id: &str, cx: &mut App) {
        if let Some((fill, mark)) = self
            .files
            .open
            .get_mut(thread_id)
            .and_then(|o| o.line_marks.take())
        {
            fill.set(vec![], cx);
            mark.set(vec![], cx);
        }
    }

    #[expect(
        clippy::too_many_lines,
        reason = "baselined at 258 lines when the lint was turned on (20 Nov 2026); split it when it's next worked on"
    )]
    pub(crate) fn render_file_panel(
        &mut self,
        panel_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = palette(cx);
        let Some(meta) = self.file_panels.get(panel_id).cloned() else {
            return div().size_full().into_any_element();
        };
        let path = &meta.path;
        let editing = meta.editing;
        let lines = meta.lines.map(|l| (l, meta.opened));
        // A file's text that's waiting for its editor gets one now.
        if let Some(open) = self
            .files
            .open
            .get_mut(panel_id)
            .filter(|f| f.path == *path)
        {
            if let FileBody::Text {
                editor,
                text,
                language,
            } = &mut open.body
            {
                if editor.is_none() {
                    let (value, language) = (text.to_string(), *language);
                    let made = cx.new(|cx| {
                        // Reading: line numbers, so a line an agent names can
                        // be found, but no folds or guides, and ⌘F left to
                        // the pane's own find bar.
                        let state = EditorState::new(window, cx)
                            .soft_wrap(true)
                            .line_number(true)
                            .folding(false)
                            .indent_guides(false)
                            .searchable(false);
                        match language {
                            Some(language) => state.language(language),
                            None => state,
                        }
                    });
                    made.update(cx, |state, cx| state.set_value(value, window, cx));
                    *editor = Some(made);
                }
            }
        }
        if editing {
            self.ensure_edit_for(panel_id, window, cx);
        }
        self.show_lines(panel_id, path, lines, window, cx);
        self.files.window = Some(window.window_handle());
        let focus = self
            .files
            .open
            .get_mut(panel_id)
            .map(|open| open.focus.get_or_insert_with(|| cx.focus_handle()).clone())
            .unwrap_or_else(|| cx.focus_handle());
        let Some(open) = self.files.open.get(panel_id).filter(|f| f.path == *path) else {
            return div().size_full().into_any_element();
        };
        let panel_key = panel_id.to_owned();
        let menu = self
            .menu
            .as_ref()
            .filter(|m| m.owner.as_deref() == Some(panel_id))
            .map(|m| (m.position, m.view.clone()));
        if let Some(edit) = open.edit.as_ref().filter(|_| editing) {
            let body = self.render_edit(&panel_key, edit, cx);
            return self
                .file_keys(
                    div()
                        .id("hl-file")
                        .relative()
                        .size_full()
                        .track_focus(&focus)
                        .child(body),
                    &panel_key,
                    cx,
                )
                .into_any_element();
        }
        let cut = open.truncated.then(|| {
            div()
                .flex_none()
                .w_full()
                .py(px(6.))
                .text_center()
                .text_size(px(style::size::SMALL))
                .text_color(p.secondary)
                .child("Only the start of this file came from the runner.")
        });
        let body: AnyElement = match &open.body {
            // A spinner so a click shows something at once; the tab already
            // says which file it's getting.
            FileBody::Loading => div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .child(Spinner::new().with_size(px(14.)).color(p.secondary))
                .into_any_element(),
            FileBody::Failed { message } => pane_note(&failed_words(message), p).into_any_element(),
            FileBody::Waiting => {
                pane_note(threadbear_core::text_file::words::WAITING, p).into_any_element()
            }
            FileBody::Opaque { note } => pane_note(note, p).into_any_element(),
            FileBody::Page(page) => {
                let page = page.clone();
                let bar = page.asks().then(|| self.scripts_bar(&panel_key, p, cx));
                let publish = self.publish_bar(&page, &panel_key, open.opened, p, cx);
                // Until the scan's back nothing's made, so a page with scripts
                // Mike already allowed doesn't load once without them first.
                let body = if page.scan.is_none() {
                    div()
                        .size_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(Spinner::new().with_size(px(14.)).color(p.secondary))
                        .into_any_element()
                } else {
                    let main = self
                        .app
                        .upgrade()
                        .is_some_and(|app| app.read(cx).main_window == window.window_handle());
                    if page.live {
                        crate::live_pages::pane_view(&page.real, main, window, cx)
                    } else {
                        crate::web_panels::local_page(
                            &page.real,
                            page.scripts_for(),
                            open.opened,
                            main,
                            window,
                            cx,
                        )
                    }
                };
                v_flex()
                    .id("hl-page")
                    .size_full()
                    .children(bar)
                    .children(publish)
                    .child(div().flex_1().min_h_0().child(body))
                    .into_any_element()
            }
            FileBody::Media(kind) => {
                let kind = *kind;
                let origin = if meta.remote {
                    crate::open_gate::Origin::OtherMac
                } else {
                    crate::open_gate::Origin::ThisMac
                };
                let key = media_key(panel_id, path, open.opened);
                let path = path.to_owned();
                // The view's slot is the whole pane; a film narrower than it
                // sits in the middle with the pane's colour round it, as the
                // Swift pane's player does.
                match crate::media_view::slot(&key, window, |opening| {
                    crate::open_gate::show_media(&path, origin, kind, opening)
                }) {
                    // A PDF still being read off the main thread has the
                    // pane's spinner where it will be, until it's in.
                    Ok(view) if crate::media_view::state_of(&key).is_some_and(|s| s.loading) => {
                        div()
                            .id("hl-media")
                            .size_full()
                            .relative()
                            .child(view)
                            .child(
                                div()
                                    .absolute()
                                    .inset_0()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(Spinner::new().with_size(px(14.)).color(p.secondary)),
                            )
                            .into_any_element()
                    }
                    Ok(view) => div()
                        .id("hl-media")
                        .size_full()
                        .child(view)
                        .into_any_element(),
                    Err(why) => pane_note(&why, p).into_any_element(),
                }
            }
            FileBody::Picture { image, .. } => {
                let source = crate::fit_picture::file_bytes_source(image.clone());
                let (path2, menu_owner, entity) =
                    (path.to_owned(), panel_key.clone(), cx.entity().downgrade());
                // Dragged, it's the file itself, from this Mac's own threads
                // only (file_drag.rs, `FilePreviewView`'s drag).
                let drag = (!meta.remote).then(|| path.to_owned());
                crate::file_drag::FileDragExt::file_drag(div().id("hl-picture"), drag)
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .p(px(0.))
                    .on_mouse_down(MouseButton::Right, move |event, window, cx| {
                        // Copy Image, the picture's own right-click (`FilePreviewView.menu`).
                        let position = event.position;
                        let (path3, owner) = (path2.clone(), menu_owner.clone());
                        entity
                            .update(cx, |this, cx| {
                                this.open_picture_menu(&owner, path3, position, window, cx)
                            })
                            .ok();
                    })
                    // An id, which GPUI only plays a GIF's frames with (its
                    // frame and timing are kept under it). Mike, 19 Nov: "GIFs
                    // don't play in Threadbear".
                    .child(
                        img(source)
                            .id(SharedString::from(format!("hl-picture-{path}")))
                            .size_full()
                            .object_fit(ObjectFit::Contain)
                            // Over the picture budget, or refused as it's decoded.
                            .with_fallback(move || {
                                pane_note("Couldn't show this picture.", p).into_any_element()
                            }),
                    )
                    // Found by scripts, for a drag from it.
                    .test_support()
                    .into_any_element()
            }
            FileBody::Markdown { doc, .. } => {
                let key = crate::style::reading_style_key(cx);
                let style = match &self.files.reading_style {
                    Some((was, style)) if *was == key => style.clone(),
                    _ => {
                        let built = crate::rows::reading_style(cx);
                        self.files.reading_style = Some((key, built.clone()));
                        built
                    }
                };
                let scroll = open.page_scroll.clone();
                let reveal = scroll.clone();
                // A page, with margins and lines no longer than the Swift
                // app's pageWidth however wide the panel is.
                let page = div().id("hl-markdown").overflow_y_scroll().child(
                    div()
                        .max_w(px(720.))
                        .mx_auto()
                        .px(px(24.))
                        .py(px(18.))
                        .text_size(px(style::size::BODY))
                        .line_height(px(style::size::BODY_LINE))
                        .child(
                            self.preview_text(doc, meta.remote, path, cx)
                                .selectable(true)
                                .style(style)
                                .on_reveal(move |line, _, _| {
                                    // The find bar's match, scrolled into the pane.
                                    let viewport = reveal.bounds();
                                    let mut offset = reveal.offset();
                                    if line.bottom() > viewport.bottom() {
                                        offset.y -= line.bottom() - viewport.bottom();
                                    } else if line.top() < viewport.top() {
                                        offset.y += viewport.top() - line.top();
                                    }
                                    reveal.set_offset(offset);
                                }),
                        ),
                );
                with_scroll_bar(page, &scroll, "hl-markdown-bar")
                    .size_full()
                    .into_any_element()
            }
            FileBody::Text {
                editor: Some(editor),
                ..
            } => div()
                .size_full()
                .child(
                    Editor::new(editor)
                        .readonly(true)
                        .h_full()
                        .appearance(false)
                        .bordered(false)
                        .text_size(px(style::size::DETAIL))
                        // AppKit's line for the 12 point monospaced font, not the kit's 18.
                        .line_height(px(CODE_LINE))
                        .font_family(cx.theme().mono_font_family.clone()),
                )
                .into_any_element(),
            FileBody::Text { .. } => div().size_full().into_any_element(),
        };
        let find = self.render_find_bar(&panel_key, cx);
        let column = v_flex()
            .size_full()
            .when_some(cut, |s, c| s.child(c))
            .children(find)
            .child(div().flex_1().min_h_0().child(body));
        self.file_keys(
            div()
                .id("hl-file")
                .relative()
                .size_full()
                .track_focus(&focus)
                .child(column)
                .when_some(menu, |s, (position, view)| {
                    s.child(
                        deferred(
                            anchored()
                                .position(position)
                                .snap_to_window_with_margin(px(8.))
                                .child(div().occlude().child(view)),
                        )
                        .with_priority(1),
                    )
                }),
            &panel_key,
            cx,
        )
        .into_any_element()
    }

    /// The keys a file in the pane takes: ⌘F, ⌘G and ⇧⌘G for the find bar.
    /// The keys a file in the pane takes: ⌘F, ⌘G and ⇧⌘G for the find bar,
    /// ⌘S to save what's typed now rather than after the pause.
    fn file_keys(
        &self,
        el: Stateful<Div>,
        thread_id: &str,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let (find, next, previous, save) = (
            thread_id.to_owned(),
            thread_id.to_owned(),
            thread_id.to_owned(),
            thread_id.to_owned(),
        );
        let find_key = find.clone();
        el.key_context(crate::file_find::CONTEXT)
            .on_action(cx.listener(
                move |this, _: &gpui_kit::component::input::Search, window, cx| {
                    this.open_find(&find, window, cx)
                },
            ))
            // The app's ⌘F (Find in Thread) is this file's while it has the
            // keys: the thread's find bar is for the thread.
            .on_action(
                cx.listener(move |this, _: &crate::shell::FindInThread, window, cx| {
                    this.open_find(&find_key, window, cx)
                }),
            )
            .on_action(cx.listener(move |this, _: &FindNext, window, cx| {
                this.find_again(&next, false, window, cx)
            }))
            .on_action(cx.listener(move |this, _: &FindPrevious, window, cx| {
                this.find_again(&previous, true, window, cx)
            }))
            .on_action(cx.listener(move |this, _: &SaveFile, window, cx| {
                // Only while it's being worked on, as the Swift app's ⌘S.
                if this
                    .files
                    .open
                    .get(&save)
                    .is_some_and(|o| o.edit.as_ref().is_some_and(|e| e.session.takes_typing()))
                {
                    this.save_edit(&save, Some(window), cx);
                } else {
                    cx.propagate();
                }
            }))
    }

    /// `Copy Image`: the file's own bytes, not a path, so it pastes as the picture.
    fn open_picture_menu(
        &mut self,
        owner: &str,
        _path: String,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let items = vec![crate::highlights::MenuItem::picture_copy()];
        self.open_panel_menu(owner, items, position, window, cx);
    }

    /// Puts the showing picture panel on the clipboard as the file's own bytes
    /// (a PNG stays a PNG), which every app that takes a pasted picture reads
    /// (`copyImage`).
    pub(crate) fn copy_open_picture(&mut self, cx: &mut Context<Self>) -> Option<String> {
        let panel = self.active_preview_panel(cx)?;
        let open = self.files.open.get(&panel)?;
        let FileBody::Picture { image, .. } = &open.body else {
            return None;
        };
        let format = match image.format() {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpeg",
            ImageFormat::Gif => "gif",
            ImageFormat::Webp => "webp",
            ImageFormat::Bmp => "bmp",
            ImageFormat::Tiff => "tiff",
            ImageFormat::Svg => "svg",
            _ => "image",
        };
        cx.write_to_clipboard(ClipboardItem::new_image(image));
        Some(format.to_owned())
    }

    /// `dump`'s preview line (`Panels.preview`) for a section-internal preview.
    #[cfg(feature = "automation")]
    pub(crate) fn preview_line(&self, preview: &PanePreview) -> String {
        match &preview.target {
            Target::File(path) => format!(
                "file {path}{}",
                if preview.editing { " (editing)" } else { "" }
            ),
            Target::Folder(path) => format!("folder {path}"),
            Target::Page(url) => format!("page {url}"),
        }
    }

    /// `dump`'s preview line (`Panels.preview`) for an open file or folder panel.
    #[cfg(feature = "automation")]
    pub(crate) fn preview_panel_line(&self, panel_id: &str) -> Option<String> {
        if let Some(meta) = self.file_panels.get(panel_id) {
            return Some(format!(
                "file {}{}",
                meta.path,
                if meta.editing { " (editing)" } else { "" }
            ));
        }
        if let Some(meta) = self.folder_panels.get(panel_id) {
            return Some(self.preview_line(&meta.current));
        }
        if let Some(path) = core::file_panel_path(panel_id) {
            return Some(format!("file {path}"));
        }
        core::folder_panel_path(panel_id).map(|path| format!("folder {path}"))
    }

    #[cfg(feature = "automation")]
    pub(crate) fn fill_preview_dump(
        &self,
        pane: &mut serde_json::Map<String, Value>,
        preview: &PanePreview,
        _cx: &App,
    ) {
        match &preview.target {
            Target::Page(url) => {
                pane.insert("previewKind".into(), json!("page"));
                pane.insert("previewText".into(), json!(url));
            }
            Target::Folder(path) => {
                pane.insert("previewKind".into(), json!("folder"));
                pane.insert("previewText".into(), json!(path));
            }
            Target::File(path) => {
                pane.insert("previewKind".into(), json!("note"));
                pane.insert("previewText".into(), json!(path));
            }
        }
    }

    #[cfg(feature = "automation")]
    pub(crate) fn fill_preview_panel_dump(
        &self,
        pane: &mut serde_json::Map<String, Value>,
        panel_id: &str,
        cx: &App,
    ) {
        if let Some(meta) = self.folder_panels.get(panel_id) {
            if let Target::Folder(path) = &meta.current.target {
                pane.insert("previewKind".into(), json!("folder"));
                pane.insert("previewText".into(), json!(path));
                if let Some(folder) = self.folder_summary_for_path(&meta.thread_id, path, cx) {
                    pane.insert("folder".into(), json!(folder));
                }
            }
            return;
        }
        let Some(meta) = self.file_panels.get(panel_id) else {
            return;
        };
        let path = &meta.path;
        let Some(open) = self.files.open.get(panel_id).filter(|f| &f.path == path) else {
            return;
        };
        if let Some(lines) = tinted_lines(open, cx) {
            pane.insert("previewLines".into(), json!(lines));
        }
        if let Some(find) = self.find_line(panel_id, cx) {
            pane.insert("previewFind".into(), json!(find));
        }
        if self.offers_text_panel(panel_id) {
            let mode = match (core::is_markdown(path), meta.editing) {
                (true, true) => "markdown",
                (true, false) => "preview",
                (false, true) => "editing",
                (false, false) => "reading",
            };
            pane.insert("previewMode".into(), json!(mode));
        }
        if let Some(edit) = open.edit.as_ref().filter(|_| meta.editing) {
            pane.insert(
                "previewKind".into(),
                json!(
                    if core::is_markdown(path) || core::code_language(path).is_none() {
                        "text"
                    } else {
                        "code"
                    }
                ),
            );
            pane.insert(
                "previewText".into(),
                json!(edit
                    .editor
                    .read(cx)
                    .value()
                    .chars()
                    .take(4000)
                    .collect::<String>()),
            );
            let note = if edit.session.conflict.is_some() {
                Some(threadbear_core::text_file::words::CONFLICT.to_owned())
            } else {
                edit.session.note.clone()
            };
            if let Some(note) = note {
                pane.insert("previewNote".into(), json!(note));
            }
            return;
        }
        match &open.body {
            FileBody::Loading => {}
            FileBody::Failed { message } => {
                pane.insert("previewKind".into(), json!("note"));
                pane.insert("previewText".into(), json!(failed_words(message)));
            }
            FileBody::Waiting => {
                pane.insert("previewKind".into(), json!("note"));
                pane.insert(
                    "previewText".into(),
                    json!(threadbear_core::text_file::words::WAITING),
                );
            }
            FileBody::Opaque { note } => {
                pane.insert("previewKind".into(), json!("note"));
                pane.insert("previewText".into(), json!(note));
            }
            FileBody::Page(page) => {
                pane.insert("previewKind".into(), json!("web"));
                pane.insert("previewText".into(), json!(path));
                if let Publication::Ready {
                    url, visibility, ..
                } = &page.publication
                {
                    pane.insert("artifactReady".into(), json!(true));
                    pane.insert("artifactUrl".into(), json!(url));
                    pane.insert(
                        "artifactVisibility".into(),
                        json!(url.as_ref().map(|_| visibility.wire())),
                    );
                }
                pane.insert(
                    "previewScripts".into(),
                    json!(if page.scripts_for().is_some() {
                        "on"
                    } else {
                        "off"
                    }),
                );
                if page.asks() {
                    pane.insert(
                        "previewNote".into(),
                        json!(threadbear_core::local_preview::words::HAS_SCRIPTS),
                    );
                }
            }
            FileBody::Media(kind) => {
                let key = media_key(panel_id, path, open.opened);
                if let Some(why) = crate::media_view::failure_of(&key) {
                    pane.insert("previewKind".into(), json!("note"));
                    pane.insert("previewText".into(), json!(why));
                } else if *kind == crate::media_view::Kind::PaneQuickLook {
                    pane.insert("previewKind".into(), json!("quickLook"));
                    if let Some(state) = crate::media_view::state_of(&key)
                        .filter(|s| !s.loading && s.width > 0. && s.height > 0.)
                    {
                        pane.insert(
                            "previewText".into(),
                            json!(format!(
                                "Quick Look thumbnail {}x{}",
                                state.width.round(),
                                state.height.round()
                            )),
                        );
                    }
                } else if *kind == crate::media_view::Kind::PaneDocument {
                    pane.insert("previewKind".into(), json!("pdf"));
                    if let Some(state) = crate::media_view::state_of(&key).filter(|s| !s.loading) {
                        pane.insert(
                            "previewText".into(),
                            json!(format!(
                                "{} page{}",
                                state.pages,
                                if state.pages == 1 { "" } else { "s" }
                            )),
                        );
                    }
                } else if *kind == crate::media_view::Kind::PaneAudio {
                    pane.insert("previewKind".into(), json!("audio"));
                    if let Some(state) = crate::media_view::state_of(&key) {
                        pane.insert("previewVideo".into(), json!({ "playing": state.playing, "muted": state.muted, "controls": state.controls }));
                    }
                } else {
                    pane.insert("previewKind".into(), json!("video"));
                    if let Some(state) = crate::media_view::state_of(&key) {
                        if state.width > 0. && state.height > 0. {
                            pane.insert(
                                "previewText".into(),
                                json!(format!("{}x{}", state.width.round(), state.height.round())),
                            );
                        }
                        pane.insert("previewVideo".into(), json!({ "playing": state.playing, "muted": state.muted, "controls": state.controls, "looping": state.looping }));
                    }
                }
            }
            FileBody::Picture { size, .. } => {
                pane.insert("previewKind".into(), json!("picture"));
                pane.insert(
                    "previewText".into(),
                    json!(size.map(|(w, h)| format!("{w}x{h}"))),
                );
            }
            FileBody::Markdown { text, .. } => {
                pane.insert("previewKind".into(), json!("markdown"));
                pane.insert(
                    "previewText".into(),
                    json!(text.chars().take(4000).collect::<String>()),
                );
            }
            FileBody::Text { text, language, .. } => {
                pane.insert(
                    "previewKind".into(),
                    json!(if language.is_some() { "code" } else { "text" }),
                );
                pane.insert(
                    "previewText".into(),
                    json!(text.chars().take(4000).collect::<String>()),
                );
            }
        }
    }
}

// ---------------------------------------------------------------- dock panels

/// One file open as a BearDock panel (`threadbear.file:<path>`), drawing from
/// `SidePane`'s shared file state and redrawing when that file loads or edits.
pub(crate) struct FilePanelView {
    side: Entity<SidePane>,
    panel_id: String,
    _watch: Subscription,
}

impl FilePanelView {
    fn new(side: Entity<SidePane>, panel_id: String, cx: &mut Context<Self>) -> Self {
        let watch = cx.observe(&side, |_, _, cx| cx.notify());
        FilePanelView {
            side,
            panel_id,
            _watch: watch,
        }
    }
}

impl Render for FilePanelView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let needs = {
            let s = self.side.read(cx);
            !s.file_panels.contains_key(&self.panel_id)
                || !s.files.open.contains_key(&self.panel_id)
                || s.files
                    .open
                    .get(&self.panel_id)
                    .is_some_and(|o| o.changed_away)
        };
        if needs {
            let (side, panel_id) = (self.side.clone(), self.panel_id.clone());
            cx.defer(move |cx| side.update(cx, |s, cx| s.ensure_file_panel_loaded(&panel_id, cx)));
        }
        let panel_id = self.panel_id.clone();
        let body = self
            .side
            .update(cx, |s, cx| s.render_file_panel(&panel_id, window, cx));
        div().size_full().bg(cx.theme().background).child(body)
    }
}

/// Whether `path` on this Mac is an Apple iWork bundle directory (`.key`,
/// `.pages`, `.numbers`) that previews as a file thumbnail rather than a folder.
pub(crate) fn is_iwork_package(path: &str) -> bool {
    cfg!(target_os = "macos")
        && Path::new(path).extension().is_some_and(|e| {
            matches!(
                e.to_string_lossy().to_ascii_lowercase().as_str(),
                "key" | "pages" | "numbers"
            )
        })
}

impl Threadbear {
    /// Opens a file or folder path as a normal dock panel beside Highlights
    /// (or `preferred_section` when opened from `Files`).
    #[expect(
        clippy::too_many_arguments,
        reason = "mirrors the open options (title, lines, live, preferred section, thread)"
    )]
    pub(crate) fn open_preview_panel(
        &mut self,
        path: &str,
        title: Option<String>,
        lines: Option<(usize, usize)>,
        live: bool,
        preferred_section: Option<&str>,
        thread: &ThreadSummary,
        cx: &mut Context<Self>,
    ) {
        let is_folder = self.side.read(cx).files.is_known_folder(path)
            || (!thread.is_remote() && !is_iwork_package(path) && Path::new(path).is_dir());
        if is_folder {
            self.open_folder_panel(path, title, preferred_section, thread, cx);
            return;
        }
        let panel = core::file_panel(path);
        self.side.update(cx, |s, cx| {
            s.open_file_state(path, title, lines, live, thread, cx);
        });
        self.dock_thread_tab(&panel, preferred_section, cx);
        let layout = self.dock.read(cx).layout().clone();
        self.save_thread_pane_store(&layout, cx);
        cx.notify();
    }

    /// Reopens a previously-tracked file panel when returning to its thread or
    /// showing hidden panels.
    pub(crate) fn reopen_file_panel(&mut self, panel: &str, cx: &mut Context<Self>) {
        if !self.side.read(cx).file_panels.contains_key(panel) {
            if let (Some(path), Some(thread)) = (core::file_panel_path(panel), self.pane_thread()) {
                self.side.update(cx, |s, cx| {
                    s.open_file_state(path, None, None, false, &thread, cx);
                });
            }
        }
        self.dock_thread_tab(panel, None, cx);
    }

    /// Promotes a file panel to a folder panel in place when the runner reports
    /// `"Not a file"` (e.g. a folder on another Mac).
    pub(crate) fn promote_file_to_folder_panel(
        &mut self,
        old_panel: &str,
        meta: FilePanelMeta,
        cx: &mut Context<Self>,
    ) {
        let new_panel = core::folder_panel(&meta.path);
        if self.dock.read(cx).layout().contains(&new_panel) {
            self.dock.update(cx, |m, cx| {
                m.close(old_panel, cx);
                m.select(&new_panel, cx);
            });
            return;
        }
        let Some(thread) = self
            .threads
            .get(&meta.thread_id)
            .map(|t| (**t).clone())
            .or_else(|| self.pane_thread())
        else {
            return;
        };
        self.side.update(cx, |s, cx| {
            s.open_folder_panel_state(&new_panel, &meta.path, Some(meta.title), &thread, cx);
        });
        if let Some(home) = self.thread_panels.thread_tabs.remove(old_panel) {
            self.thread_panels
                .thread_tabs
                .insert(new_panel.clone(), home);
        }
        self.dock
            .update(cx, |m, cx| m.rename(old_panel, &new_panel, cx));
        let layout = self.dock.read(cx).layout().clone();
        self.save_thread_pane_store(&layout, cx);
        cx.notify();
    }

    /// Closes a file or folder panel from BearDock.
    pub(crate) fn close_preview_panel(&mut self, panel: &str, cx: &mut Context<Self>) {
        if self.dock.read(cx).layout().contains(panel) {
            self.dock.update(cx, |m, cx| m.close(panel, cx));
        }
    }

    /// Persists the current thread's un-moved file/folder panels to
    /// `desktop-pane.json` so they come back after a relaunch.
    pub(crate) fn save_thread_pane_store(
        &mut self,
        layout: &threadbear_dock::DockLayout,
        cx: &mut Context<Self>,
    ) {
        let Some(thread) = self.pane_thread() else {
            return;
        };
        let dock = self.dock.read(cx);
        let side = self.side.read(cx);
        let mut panels = Vec::new();
        let mut selected = None;
        for id in layout.panels() {
            if !self.thread_panels.thread_tabs.contains_key(&id) || !core::is_preview_panel(&id) {
                continue;
            }
            if let Some(meta) = side.file_panels.get(&id) {
                panels.push(crate::pane_store::Open {
                    path: meta.path.clone(),
                    folder: false,
                    title: meta.title.clone(),
                    from: crate::shell::HIGHLIGHTS.to_owned(),
                    back: vec![],
                });
                if dock.is_showing(&id) {
                    selected = Some(id);
                }
            } else if let Some(meta) = side.folder_panels.get(&id) {
                if let Some(mut open) = crate::highlights::remembered_open(&meta.current) {
                    open.from = crate::shell::HIGHLIGHTS.to_owned();
                    panels.push(open);
                    if dock.is_showing(&id) {
                        selected = Some(id);
                    }
                }
            }
        }
        self.side.update(cx, |s, _| {
            s.remember_panels(&thread.id, panels, selected);
        });
    }

    /// Restores the open thread's saved file/folder panels from
    /// `desktop-pane.json` once per launch.
    pub(crate) fn restore_pane_store_panels(&mut self, cx: &mut Context<Self>) {
        let Some(thread) = self.pane_thread() else {
            return;
        };
        let saved = self.side.update(cx, |s, _| {
            if !s.restored.insert(thread.id.clone()) {
                return None;
            }
            s.places.get(&thread.id).cloned()
        });
        let Some(place) = saved else {
            return;
        };
        let items: Vec<crate::pane_store::Open> = if !place.panels.is_empty() {
            place.panels
        } else {
            place.open.into_iter().collect()
        };
        if items.is_empty() {
            return;
        }
        let mut restored_ids = Vec::new();
        for open in items {
            if open.folder {
                self.open_folder_panel(&open.path, Some(open.title), None, &thread, cx);
                restored_ids.push(core::folder_panel(&open.path));
            } else {
                self.open_preview_panel(
                    &open.path,
                    Some(open.title),
                    None,
                    false,
                    None,
                    &thread,
                    cx,
                );
                restored_ids.push(core::file_panel(&open.path));
            }
        }
        if let Some(sel) = place.selected.or_else(|| restored_ids.last().cloned()) {
            if self.dock.read(cx).layout().contains(&sel) {
                self.dock.update(cx, |m, cx| m.select(&sel, cx));
            }
        }
    }

    pub(crate) fn file_panel_title(&self, panel: &str, cx: &App) -> Option<String> {
        let path = core::file_panel_path(panel)?;
        Some(
            self.side
                .read(cx)
                .file_panels
                .get(panel)
                .map(|m| m.title.clone())
                .unwrap_or_else(|| core::last_component(path).to_owned()),
        )
    }

    pub(crate) fn file_panel_tip(&self, panel: &str, _cx: &App) -> Option<String> {
        let path = core::file_panel_path(panel)?;
        let cwd = self.pane_thread().map(|t| t.cwd);
        let rel = core::text::folder(path, cwd.as_deref(), &home_dir());
        let name = core::last_component(path);
        Some(if rel.is_empty() {
            name.to_owned()
        } else {
            format!("{rel}/{name}")
        })
    }

    pub(crate) fn file_panel_icon(&self, panel: &str, cx: &App) -> Option<AnyElement> {
        let path = core::file_panel_path(panel)?;
        let color = cx.theme().muted_foreground;
        Some(
            icons::symbol(core::file_symbol(path))
                .with_size(px(13.))
                .text_color(color)
                .into_any_element(),
        )
    }

    /// Markdown menu or Edit/Done, Reveal in Finder, and Open in its app at
    /// the right end of a file panel's BearDock bar.
    pub(crate) fn file_panel_buttons(
        &mut self,
        panel: &str,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let path = core::file_panel_path(panel)?.to_owned();
        let p = palette(cx);
        let hover = p.hover;
        let fg = p.fg;
        let side = self.side.clone();
        let (editing, remote, offers_text) = {
            let s = side.read(cx);
            let meta = s.file_panels.get(panel);
            (
                meta.is_some_and(|m| m.editing),
                meta.is_some_and(|m| m.remote),
                s.offers_text_panel(panel),
            )
        };
        let mut row = h_flex().flex_none().items_center().pr(px(4.));
        if offers_text {
            if core::is_markdown(&path) {
                let weak_side = side.downgrade();
                let menu = side
                    .read(cx)
                    .markdown_menu_for(panel, editing, p, cx, weak_side);
                row = row.child(menu);
            } else {
                let (symbol, tip) = if editing {
                    ("checkmark", words::DONE_TIP)
                } else {
                    ("pencil", words::EDIT_TIP)
                };
                let (side_edit, panel_edit) = (side, panel.to_owned());
                row = row.child(
                    tipped(
                        div()
                            .id(SharedString::from(format!("hl-edit-{panel}")))
                            .size(px(26.))
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .hover(move |s| s.bg(hover).text_color(fg))
                            .cursor_pointer()
                            .child(icon(symbol, style::size::LABEL, p.secondary)),
                        tip.to_owned(),
                    )
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(move |_, _, cx| {
                        side_edit
                            .update(cx, |s, cx| s.request_editing_for(&panel_edit, !editing, cx));
                    }),
                );
            }
        }
        if !remote {
            let reveal_path = path.clone();
            row = row.child(
                tipped(
                    div()
                        .id(SharedString::from(format!("hl-reveal-{panel}")))
                        .size(px(26.))
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.))
                        .hover(move |s| s.bg(hover).text_color(fg))
                        .cursor_pointer()
                        .child(icon("folder", style::size::LABEL, p.secondary)),
                    REVEAL_TITLE.to_owned(),
                )
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(move |_, _, cx| {
                    reveal(&reveal_path, crate::open_gate::Origin::ThisMac, cx)
                }),
            );
            let open_path = path;
            row = row.child(
                tipped(
                    div()
                        .id(SharedString::from(format!("hl-open-{panel}")))
                        .size(px(26.))
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.))
                        .hover(move |s| s.bg(hover).text_color(fg))
                        .cursor_pointer()
                        .child(icon("arrow.up.right", style::size::LABEL, p.secondary)),
                    "Open in its app".to_owned(),
                )
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(move |_, _, cx| {
                    open_file_in_app(&open_path, crate::open_gate::Origin::ThisMac, cx)
                }),
            );
        }
        Some(row.into_any_element())
    }

    pub(crate) fn file_panel_view(
        &mut self,
        panel: &str,
        ghost: bool,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if ghost {
            return div()
                .size_full()
                .bg(cx.theme().background)
                .into_any_element();
        }
        let side = self.side.clone();
        let panel_id = panel.to_owned();
        let view = self
            .thread_panels
            .file_views
            .entry(panel.to_owned())
            .or_insert_with(|| cx.new(|cx| FilePanelView::new(side, panel_id, cx)))
            .clone();
        AnyView::from(view).into_any_element()
    }

    #[cfg(feature = "automation")]
    pub(crate) fn file_panels_dump(&self, cx: &App) -> Value {
        let dock = self.dock.read(cx);
        let side = self.side.read(cx);
        let list: Vec<Value> = dock
            .layout()
            .panels()
            .iter()
            .filter_map(|id| {
                let (kind, path) = if let Some(p) = core::file_panel_path(id) {
                    ("file", p.to_owned())
                } else if let Some(p) = core::folder_panel_path(id) {
                    let cur = side
                        .folder_panels
                        .get(id)
                        .and_then(|m| match &m.current.target {
                            Target::Folder(cur) => Some(cur.clone()),
                            _ => None,
                        })
                        .unwrap_or_else(|| p.to_owned());
                    ("folder", cur)
                } else {
                    return None;
                };
                let mut details = serde_json::Map::new();
                side.fill_preview_panel_dump(&mut details, id, cx);
                Some(json!({
                    "id": id,
                    "kind": kind,
                    "path": path,
                    "title": self.panel_title(id, cx),
                    "showing": dock.is_showing(id),
                    "floating": dock.layout().is_floating(id),
                    "perThread": self.thread_panels.thread_tabs.contains_key(id),
                    "pane": Value::Object(details),
                }))
            })
            .collect();
        json!(list)
    }
}

/// The `preview` automation command (`Automation.swift`). Over a text file,
/// "find" is ⌘F with those words typed in the find bar, "findNext" and
/// "findPrevious" are ⌘G and ⇧⌘G, "findDone" the bar's Done, each saying what
/// the bar has found; "markdownView" is a pick from a Markdown file's menu;
/// "edit" true or false is the pencil or Done, "insert" types text at the end
/// of the file being worked on, "save" is ⌘S, and "resolve" ("file" or
/// "mine") is the conflict bar's button, each saying how the editor and the
/// file end.
#[cfg(feature = "automation")]
pub(crate) fn preview_command(
    app: &Entity<Threadbear>,
    side: &Entity<SidePane>,
    thread: &ThreadSummary,
    cmd: &Value,
    window: &mut Window,
    cx: &mut App,
) -> Result<Value, String> {
    let active_panel = |side: &Entity<SidePane>, cx: &App| -> Option<String> {
        side.read(cx).active_preview_panel(cx)
    };
    let active_file_panel = |side: &Entity<SidePane>, cx: &App| -> Option<String> {
        active_panel(side, cx).filter(|p| core::file_panel_path(p).is_some())
    };
    if cmd["play"].as_bool() == Some(true) {
        // The film's play button, for a picture of it playing.
        let panel = active_file_panel(side, cx);
        let pane = side.read(cx);
        let key = panel.as_deref().and_then(|id| {
            pane.files
                .open
                .get(id)
                .filter(|o| {
                    matches!(
                        o.body,
                        FileBody::Media(
                            crate::media_view::Kind::PaneVideo | crate::media_view::Kind::PaneAudio
                        )
                    )
                })
                .map(|o| media_key(id, &o.path, o.opened))
        });
        return if key.is_some_and(|k| crate::media_view::play(&k)) {
            Ok(json!("ok playing"))
        } else {
            Err("no video is showing".into())
        };
    }
    if cmd["clickLink"].as_bool() == Some(true) {
        // A click on the PDF's first link, through the window as a person's
        // comes, so where it goes is PDFKit's handling and the gate's.
        let panel = active_file_panel(side, cx);
        let pane = side.read(cx);
        let key = panel.as_deref().and_then(|id| {
            pane.files
                .open
                .get(id)
                .filter(|o| {
                    matches!(
                        o.body,
                        FileBody::Media(crate::media_view::Kind::PaneDocument)
                    )
                })
                .map(|o| media_key(id, &o.path, o.opened))
        });
        return if key.is_some_and(|k| crate::media_view::click_link(&k)) {
            Ok(json!("ok clicked"))
        } else {
            Err("no PDF with a link is showing".into())
        };
    }
    if cmd["runScripts"].as_bool() == Some(true) {
        // The bar's Run them over a local page with scripts.
        let id = active_file_panel(side, cx).ok_or("no page is asking to run its scripts")?;
        let asks = side
            .read(cx)
            .files
            .open
            .get(&id)
            .is_some_and(|o| matches!(&o.body, FileBody::Page(page) if page.asks()));
        if !asks {
            return Err("no page is asking to run its scripts".into());
        }
        side.update(cx, |pane, cx| pane.run_page_scripts(&id, cx));
        return Ok(json!("ok running its scripts"));
    }
    if cmd["copyImage"].as_bool() == Some(true) {
        let format = side
            .update(cx, |pane, cx| pane.copy_open_picture(cx))
            .ok_or("no picture is showing")?;
        return Ok(json!(format!("ok copied {format}")));
    }
    if let Some(action) = cmd["artifact"].as_str() {
        let id = active_file_panel(side, cx).ok_or("no page is open")?;
        if action == "open" {
            let url = side
                .read(cx)
                .files
                .open
                .get(&id)
                .and_then(|o| match &o.body {
                    FileBody::Page(page) => match &page.publication {
                        Publication::Ready { url: Some(url), .. } => Some(url.clone()),
                        _ => None,
                    },
                    _ => None,
                })
                .ok_or("no web link is ready")?;
            open_web(&url, cx);
            return Ok(json!("ok opened artifact"));
        }
        let has_url = side.read(cx).files.open.get(&id).is_some_and(|o| {
            matches!(
                &o.body,
                FileBody::Page(page)
                    if matches!(&page.publication, Publication::Ready { url: Some(_), .. })
            )
        });
        let action = match action {
            "sync" => PublishAction::Sync,
            "public" => PublishAction::SetVisibility(Visibility::Public),
            "private" => PublishAction::SetVisibility(Visibility::Private),
            "publish" => {
                if has_url {
                    PublishAction::SetVisibility(Visibility::Public)
                } else {
                    PublishAction::Publish
                }
            }
            "unpublish" => PublishAction::Unpublish,
            _ => return Err("choose sync, publish, public, private, unpublish or open".into()),
        };
        let opened = side
            .read(cx)
            .files
            .open
            .get(&id)
            .ok_or("no page is open")?
            .opened;
        side.update(cx, |pane, cx| {
            pane.change_publication(&id, opened, action, cx)
        });
        return Ok(json!("ok artifact action"));
    }
    // How the editor and the file on disk end, as the Swift app answers.
    let ends = |side: &Entity<SidePane>, id: &str, cx: &App| -> String {
        let pane = side.read(cx);
        let Some(open) = pane.files.open.get(id) else {
            return "no file".to_owned();
        };
        let editor = open
            .edit
            .as_ref()
            .map(|e| e.editor.read(cx).value().to_string())
            .unwrap_or_default();
        let file = std::fs::read_to_string(&open.path).unwrap_or_default();
        let tail = |s: &str| {
            s.chars()
                .rev()
                .take(40)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<String>()
        };
        format!(
            "editor ends {:?}, file ends {:?}",
            tail(&editor),
            tail(&file)
        )
    };
    let editing = |side: &Entity<SidePane>, id: &str, cx: &App| {
        side.read(cx)
            .files
            .open
            .get(id)
            .is_some_and(|o| o.edit.is_some())
            && side.read(cx).file_panels.get(id).is_some_and(|p| p.editing)
    };
    if cmd["save"].as_bool() == Some(true) {
        let id = active_file_panel(side, cx).ok_or("nothing is being edited")?;
        if !editing(side, &id, cx) {
            return Err("nothing is being edited".into());
        }
        let saved = side.update(cx, |pane, cx| pane.save_edit(&id, Some(window), cx));
        let conflict = if saved == threadbear_core::text_file::Saved::Kept {
            "changed on disk, so not saved; "
        } else {
            ""
        };
        return Ok(json!(format!("ok {conflict}{}", ends(side, &id, cx))));
    }
    if let Some(text) = cmd["insert"].as_str() {
        let id = active_file_panel(side, cx).ok_or("nothing is being edited")?;
        if !editing(side, &id, cx) {
            return Err("nothing is being edited".into());
        }
        let editor = side
            .read(cx)
            .files
            .open
            .get(&id)
            .and_then(|o| o.edit.as_ref())
            .map(|e| e.editor.clone())
            .ok_or("nothing is being edited")?;
        // As keys would: at the end, then the save a moment later.
        editor.update(cx, |s, cx| {
            let value = s.value().to_string();
            let line = value.matches('\n').count() as u32;
            let column = value.rsplit('\n').next().map_or(0, |l| l.chars().count()) as u32;
            s.set_cursor_position(
                gpui_kit::component::input::Position::new(line, column),
                window,
                cx,
            );
            s.insert(text.to_owned(), window, cx);
        });
        side.update(cx, |pane, cx| pane.edit_typed(&id, cx));
        return Ok(json!(format!("ok {}", ends(side, &id, cx))));
    }
    if let Some(which) = cmd["resolve"].as_str() {
        let id = active_file_panel(side, cx).ok_or("no conflict to resolve")?;
        let waiting = side
            .read(cx)
            .files
            .open
            .get(&id)
            .and_then(|o| o.edit.as_ref())
            .is_some_and(|e| e.session.conflict.is_some());
        if !waiting {
            return Err("no conflict to resolve".into());
        }
        side.update(cx, |pane, cx| {
            if which == "file" {
                pane.take_files_side(&id, window, cx)
            } else {
                pane.keep_mine(&id, cx)
            }
        });
        return Ok(json!(format!("ok {}", ends(side, &id, cx))));
    }
    if let Some(on) = cmd["edit"].as_bool() {
        let id = active_file_panel(side, cx).ok_or("no file is open in the pane")?;
        side.update(cx, |pane, cx| {
            pane.set_file_panel_editing(&id, on, window, cx)
        });
        let shown = side.read(cx).file_panels.get(&id).map_or_else(
            || "no preview".to_owned(),
            |p| format!("showing {}", p.title),
        );
        return Ok(json!(format!("ok {shown}")));
    }
    if ["find", "findNext", "findPrevious", "findDone"]
        .iter()
        .any(|k| !cmd[*k].is_null())
    {
        let id = active_file_panel(side, cx).ok_or("no text file is showing")?;
        let showing = side.read(cx).files.open.get(&id).is_some_and(|o| {
            matches!(o.body, FileBody::Markdown { .. } | FileBody::Text { .. }) || o.edit.is_some()
        });
        if !showing {
            return Err("no text file is showing".into());
        }
        side.update(cx, |pane, cx| {
            if let Some(query) = cmd["find"].as_str() {
                pane.find_typed(&id, query, window, cx);
            }
            if cmd["findNext"].as_bool() == Some(true) {
                pane.find_again(&id, false, window, cx);
            }
            if cmd["findPrevious"].as_bool() == Some(true) {
                pane.find_again(&id, true, window, cx);
            }
            if cmd["findDone"].as_bool() == Some(true) {
                pane.close_find(&id, window, cx);
            }
        });
        let line = side
            .read(cx)
            .find_line(&id, cx)
            .unwrap_or_else(|| "no find bar".to_owned());
        return Ok(json!(format!("ok {line}")));
    }
    if let Some(name) = cmd["markdownView"].as_str() {
        let view = MarkdownView::from_name(name).ok_or("markdownView is preview or markdown")?;
        let id = active_file_panel(side, cx).ok_or("no Markdown file is open in the pane")?;
        let is_markdown = core::file_panel_path(&id).is_some_and(core::is_markdown);
        if !is_markdown {
            return Err("no Markdown file is open in the pane".into());
        }
        side.update(cx, |pane, cx| {
            pane.pick_markdown_view_for(&id, view, window, cx)
        });
    } else if cmd["close"].as_bool() == Some(true) {
        if let Some(panel) = active_panel(side, cx) {
            app.update(cx, |t, cx| t.close_preview_panel(&panel, cx));
        } else {
            side.update(cx, |pane, cx| pane.close_preview(&thread.id, cx));
        }
    } else if cmd["back"].as_bool() == Some(true) {
        if let Some(panel) = active_panel(side, cx) {
            let has_folder_back = side
                .read(cx)
                .folder_panels
                .get(&panel)
                .is_some_and(|m| !m.current.back.is_empty());
            if has_folder_back {
                side.update(cx, |pane, cx| pane.folder_panel_back(&panel, cx));
            } else {
                app.update(cx, |t, cx| t.close_preview_panel(&panel, cx));
            }
        } else {
            side.update(cx, |pane, cx| pane.preview_back(&thread.id, cx));
        }
    } else if let Some(path) = cmd["path"].as_str() {
        app.update(cx, |t, cx| {
            t.open_preview_panel(path, None, None, false, None, thread, cx)
        });
    } else if let Some(url) = cmd["url"].as_str() {
        side.update(cx, |pane, cx| {
            let section = pane.section_for(thread);
            pane.show_preview(
                PanePreview::new(
                    Target::Page(url.to_owned()),
                    core::text::address(url),
                    section,
                ),
                &thread.id,
                cx,
            );
        });
    } else {
        return Err("preview needs path, url or close".into());
    }
    let shown = active_panel(side, cx)
        .map(|p| format!("showing {}", app.read(cx).panel_title(&p, cx)))
        .or_else(|| {
            side.read(cx)
                .previews
                .get(&thread.id)
                .map(|p| format!("showing {}", p.title))
        })
        .unwrap_or_else(|| "no preview".to_owned());
    Ok(json!(format!("ok {shown}")))
}

/// The Files panel has no preview stored: its section shows the thread's folder.
pub(crate) fn files_section_preview(thread: &ThreadSummary) -> PanePreview {
    PanePreview::new(
        Target::Folder(thread.cwd.clone()),
        "Files".into(),
        FILES.to_owned(),
    )
}

/// The lines tinted for a link (`a.ts:12-18`), as they stand now: "12-18",
/// for `dump`'s `previewLines`.
#[cfg(feature = "automation")]
fn tinted_lines(open: &OpenFile, cx: &App) -> Option<String> {
    let (fill, _) = open.line_marks.as_ref()?;
    let range = fill.get_ranges(cx).into_iter().next()?;
    let editor = open
        .edit
        .as_ref()
        .map(|e| e.editor.clone())
        .or_else(|| match &open.body {
            FileBody::Text { editor, .. } => editor.clone(),
            _ => None,
        })?;
    let text = editor.read(cx).value().to_string();
    let line_of = |at: usize| {
        text.as_bytes()
            .get(..at)
            .map_or(0, |b| b.iter().filter(|&&c| c == b'\n').count())
            + 1
    };
    Some(format!(
        "{}-{}",
        line_of(range.start),
        line_of(range.end.saturating_sub(1).max(range.start))
    ))
}
