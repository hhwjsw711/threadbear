// The message box under a thread: a port of the Swift app's ComposerView.swift
// and PictureChips.swift, and the send button from ComposerControls.swift. One
// Composer per thread lives on the app (Threadbear.composers), so what's typed,
// its undo and its pictures stay with the thread while others are open.
//
// Pictures are real inline tokens in gpui-kit's text input (InlineToken): one
// U+FFFC mark per chip, the chip drawn by the renderer below, and the input
// keeps them atomic through edits and undo. That mark is exactly what the
// Swift draft holds (InlinePictures), so the two apps' drafts read the same.
use crate::a11y::A11yRole as _;
use crate::app::Threadbear;
use crate::composer_card::CardState;
use crate::composer_chips::ModelPickerView;
use crate::spinner::Spinner;
use crate::style;
use crate::thread::ThreadPane;
use gpui_kit::assets::IconName;
use gpui_kit::base::A11yDisabledExt as _;
use gpui_kit::component::input::{
    Copy, Cut, Enter, Escape, IndentInline, InlineToken, InlineTokenContext, InlineTokenHoverEvent,
    InputContent, InputEvent, InputHistory, MoveDown, MoveUp, Textarea, TextareaState,
};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Icon, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::style::px;
use crate::tips::Tip as _;
use serde_json::{json, Value};
use std::cell::Cell;
use std::collections::HashMap;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;
use threadbear_client::runner::Client;
use threadbear_core::composer::{
    self, BOX_MAX_LINES, BOX_MIN_LINES, PICTURE_MARK, PICTURE_MARK_STR,
};
use threadbear_core::reducer::ImageRef;
use threadbear_core::slash::{PaletteKey, PaletteState};

/// A picture in the box: the token that draws its chip, what it came from,
/// and what the runner made of it (`media.import`).
pub(crate) struct PictureChip {
    /// The file it came from, for the thumbnail meanwhile.
    pub(crate) source: PathBuf,
    /// None while the runner is still copying it in.
    pub(crate) image: Option<ImageRef>,
    /// Just pasted, dropped or chosen: it drops into the strip
    /// (juice::picture_drop), timed from the first frame that draws it.
    /// None for one that came with a draft, and under Reduce Motion.
    pub(crate) dropping: Option<Cell<Option<Instant>>>,
}

pub struct Composer {
    /// None for the new-thread page's box.
    pub(crate) thread_id: Option<String>,
    pub(crate) client: Arc<Client>,
    pub(crate) app: WeakEntity<Threadbear>,
    /// The open thread's pane, once it has one; only ever read, or asked to
    /// send, from here (the pane never updates this composer back from those
    /// same calls, so no double lease).
    pub(crate) pane: WeakEntity<ThreadPane>,
    pub(crate) input: Entity<TextareaState>,
    /// The chips in the box, by token id, in no particular order: the box's
    /// tokens say the order (`chips`).
    pub(crate) pictures: HashMap<SharedString, PictureChip>,
    /// Its card and thread chips, by token id (composer_inline.rs).
    pub(crate) mentions: HashMap<SharedString, crate::composer_inline::MentionChip>,
    pub(crate) next_picture: u64,
    /// Each chip's place among the box's pictures, worked out each render so
    /// the renderer (which can't edit the input) can read it.
    chip_numbers: HashMap<SharedString, usize>,
    /// The chip the pointer is over, and the card showing it after a beat.
    hovered_chip: Option<(SharedString, Bounds<Pixels>)>,
    peek_shown: Option<(SharedString, Bounds<Pixels>)>,
    hover_serial: u64,
    /// What the last click on a picture opened in the viewer (its paths and
    /// the place of the one clicked), for `composer-peek` to say.
    #[cfg(feature = "automation")]
    pub(crate) debug_opened: Option<(Vec<String>, usize)>,
    /// Stop was pressed and the turn hasn't ended yet: a spinner in its place.
    /// When Stop was pressed (`still_stopping`).
    stopping: Option<i64>,
    /// When Return last sent, for the arrow's hop (`sendNudges`).
    sent_hop: Option<std::time::Instant>,
    /// A refused send's draft, to put back at the next render.
    restore: Option<RestoreDraft>,
    /// The model picker's search and column, kept while it's open.
    pub(crate) model_picker: Option<Entity<ModelPickerView>>,
    /// The same picker as the limit box's Continue now opens it, whose
    /// picks carry on at once (`carry_on_pick`).
    pub(crate) limit_picker: Option<Entity<ModelPickerView>>,
    /// Set while a pick from `limit_picker` goes out: `change_thread` adds
    /// `carryOn` to a login or pool move.
    pub(crate) carry_on_pick: bool,
    /// What's picked on the open card, and how the card's showing.
    pub(crate) card: CardState,
    /// Which card was last seen arriving, for it to settle in (composer_card.rs).
    pub(crate) card_arrival: crate::composer_card::CardArrival,
    /// The strip over the words opening for a first picture: its height
    /// eases open (juice::strip_open), timed from its first frame.
    strip_opening: Option<Cell<Option<Instant>>>,
    /// How many pictures have dropped in, for scripts (`dump`'s `juice`).
    pub(crate) pictures_dropped: usize,
    /// The card's text style, one per appearance (`card_reading_style`).
    pub(crate) card_style: Option<(crate::style::ReadingStyleKey, gpui_kit::base::TextViewStyle)>,
    shown_placeholder: SharedString,
    /// The slash palette's own state (`PaletteState`), and the list this
    /// opening of it has asked for (the thread's, or a new thread's login
    /// and folder's, which the chips can change while it's open).
    pub(crate) palette: PaletteState,
    pub(crate) palette_asked: Option<String>,
    /// The palette's list, kept so the arrows can scroll the pick into sight.
    pub(crate) palette_scroll: ScrollHandle,
    /// The # thread picker's own state and its list, to scroll
    /// (thread_palette.rs).
    pub(crate) thread_picker: threadbear_core::thread_mentions::PickerState,
    pub(crate) thread_scroll: ScrollHandle,
    /// The box's width at the last paint, for the palette's columns.
    pub(crate) card_width: Rc<Cell<f32>>,
    /// The chip row's right edge and the send button's, at the last paint:
    /// the button past the row would be chips running past the box.
    pub(crate) controls_fit: Rc<Cell<(f32, f32)>>,
    /// The box's top edge in the window at the last paint: the room the
    /// slash palette has over it (high up on the new-thread page).
    pub(crate) box_top: Rc<Cell<f32>>,
    /// One of Mike's messages being edited (`AppModel.editing`): sending
    /// replaces it and carries on from there.
    pub(crate) editing: Option<MessageEdit>,
    /// What the box is to hold at the next render (an edit sent puts back
    /// what was in it before; that needs the window).
    pending_box: Option<(String, Vec<ImageRef>)>,
    /// The box as it was before an edit that's been sent, to put back at the
    /// next render with its undo history.
    pending_saved: Option<SavedBox>,
    /// Pictures a promise delivered for a chip that's in the box an edit is
    /// holding, to go in beside it when that box comes back (Codex, 18 Nov).
    held_extras: Vec<(SharedString, WeakEntity<TextareaState>, Vec<PathBuf>)>,
    /// The box's spelling marks and the text they were found in
    /// (composer_spelling.rs).
    pub(crate) spell: crate::composer_spelling::SpellState,
    /// The token card's paste field, for that login (token_card.rs): its
    /// words go out with Set and are never kept.
    pub(crate) token_field: Option<(String, Entity<gpui_kit::component::input::InputState>)>,
    pub(crate) token_sub: Option<Subscription>,
    _subs: Vec<Subscription>,
}

/// An edit under way: the message's seq, what was in the box before, and
/// whether it's on its way.
pub(crate) struct MessageEdit {
    pub(crate) seq: i64,
    before: SavedBox,
    sending: bool,
}

/// The box exactly as it was when an edit began: its words and chips (the
/// same token ids, so `pictures` and `mentions` still answer for them, and a
/// picture still coming in settles into it), where the cursor was, and its
/// undo history. Putting back only the words lost the history, so ⌘Z after
/// Cancel couldn't bring back what was typed before (Codex, 18 Nov).
pub(crate) struct SavedBox {
    content: InputContent,
    selection: Range<usize>,
    history: InputHistory,
}

/// What a refused send gives back: the words and pictures, and the picks that
/// went with them (AppModel.restoreDraft and the `failed` closure in `send`).
#[derive(Clone)]
pub struct RestoreDraft {
    pub(crate) text: String,
    pub(crate) images: Vec<ImageRef>,
    pub(crate) card: Option<SavedPicks>,
    /// With a card's picks: the message as it went, in the box's form, for
    /// the drafts file, which keeps only words and pictures (a quit with
    /// this still waiting to be given back keeps the answers as words).
    pub(crate) as_sent: Option<(String, Vec<ImageRef>)>,
}

impl RestoreDraft {
    pub(crate) fn plain(text: String, images: Vec<ImageRef>) -> RestoreDraft {
        RestoreDraft {
            text,
            images,
            card: None,
            as_sent: None,
        }
    }

    /// Its words and pictures for the drafts file.
    pub(crate) fn for_saving(&self) -> (String, Vec<ImageRef>) {
        match (&self.card, &self.as_sent) {
            (Some(_), Some(sent)) => sent.clone(),
            _ => (self.text.clone(), self.images.clone()),
        }
    }

    fn join_parts(
        first: (String, Vec<ImageRef>),
        then: (String, Vec<ImageRef>),
    ) -> (String, Vec<ImageRef>) {
        let text = match (first.0.trim().is_empty(), then.0.trim().is_empty()) {
            (_, true) => first.0,
            (true, false) => then.0,
            (false, false) => format!("{}\n\n{}", first.0, then.0),
        };
        let mut images = first.1;
        images.extend(then.1);
        (text, images)
    }

    /// `first`'s words and pictures, then `then`'s, a blank line between
    /// (`restoreDraft`: what's given back goes before anything typed since).
    /// Pictures are marks in the words, in order, so their lists join too.
    pub(crate) fn joined(first: RestoreDraft, then: RestoreDraft) -> RestoreDraft {
        let as_sent = (first.card.is_some() || then.card.is_some())
            .then(|| Self::join_parts(first.for_saving(), then.for_saving()));
        let (text, images) = Self::join_parts((first.text, first.images), (then.text, then.images));
        RestoreDraft {
            text,
            images,
            card: first.card.or(then.card),
            as_sent,
        }
    }
}

#[derive(Clone)]
pub struct SavedPicks {
    pub(crate) source_seq: i64,
    pub(crate) picks: std::collections::BTreeMap<i64, i64>,
    pub(crate) notes: std::collections::BTreeMap<i64, threadbear_core::reducer::AskNote>,
    pub(crate) next_picks: std::collections::BTreeSet<i64>,
    pub(crate) explain: std::collections::BTreeSet<i64>,
}

impl Composer {
    pub fn new(
        thread_id: Option<String>,
        client: Arc<Client>,
        app: WeakEntity<Threadbear>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        // Two lines at least, ten at most, then it scrolls (ComposerChips.boxHeight).
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Message")
                .auto_grow(BOX_MIN_LINES, BOX_MAX_LINES)
                .submit_on_enter(true)
        });
        let sub = cx.subscribe_in(
            &input,
            window,
            |this, _, ev: &InputEvent, window, cx| match ev {
                InputEvent::PressEnter { shift: false, .. } => this.return_pressed(window, cx),
                // The send button, the picture strip and the slash palette follow
                // what's in the box.
                InputEvent::Change => {
                    this.palette_text_changed(cx);
                    this.thread_picker_text_changed(cx);
                    // Marks, and a correction as a word ends (composer_spelling.rs).
                    this.spelling_after_edit(window, cx);
                    // Kept across a quit (drafts.rs).
                    if let Some(app) = this.app.upgrade() {
                        // Not for the box emptying after a send: that would start
                        // one for a thread nobody is writing.
                        let new_thread = this.thread_id.is_none()
                            && !this.input.read(cx).value().trim().is_empty();
                        app.update(cx, |app, cx| {
                            app.drafts_changed(cx);
                            // A new thread's CLI, started again if the box's
                            // settings changed since the page opened (warm start).
                            if new_thread {
                                app.warm_new_thread(cx);
                            }
                        });
                    }
                    cx.notify();
                }
                // Leaving the box marks the word it was in, as NSTextView does.
                InputEvent::Blur => this.refresh_spelling_marks(false, false, cx),
                _ => {}
            },
        );
        crate::text_services::register_text_box(&input);
        Composer {
            thread_id,
            client,
            app,
            pane: WeakEntity::new_invalid(),
            input,
            pictures: HashMap::new(),
            mentions: HashMap::new(),
            next_picture: 0,
            chip_numbers: HashMap::new(),
            hovered_chip: None,
            peek_shown: None,
            hover_serial: 0,
            #[cfg(feature = "automation")]
            debug_opened: None,
            stopping: None,
            sent_hop: None,
            restore: None,
            model_picker: None,
            limit_picker: None,
            carry_on_pick: false,
            card: CardState::default(),
            card_arrival: Default::default(),
            strip_opening: None,
            pictures_dropped: 0,
            card_style: None,
            shown_placeholder: "Message".into(),
            editing: None,
            pending_box: None,
            pending_saved: None,
            held_extras: Vec::new(),
            token_field: None,
            token_sub: None,
            palette: PaletteState::default(),
            palette_asked: None,
            palette_scroll: ScrollHandle::new(),
            thread_picker: Default::default(),
            thread_scroll: ScrollHandle::new(),
            card_width: Rc::new(Cell::new(style::MAX_CONTENT_WIDTH)),
            controls_fit: Rc::new(Cell::new((0., 0.))),
            box_top: Rc::new(Cell::new(f32::MAX)),
            spell: Default::default(),
            _subs: vec![sub],
        }
    }

    pub fn attach(&mut self, pane: WeakEntity<ThreadPane>) {
        self.pane = pane;
    }

    /// On its way to another machine: "Moving to bruce…" in the box, which
    /// and whose card are locked until it's there (ComposerView's `moving`).
    /// Cancel Move, or a failed move, gives them back.
    pub(crate) fn moving_line(&self, cx: &App) -> Option<String> {
        let id = self.thread_id.as_ref()?;
        let app = self.app.upgrade()?;
        let t = app.read(cx);
        t.threads.get(id).and_then(|t| t.moving_line())
    }

    /// A new thread is on its way from this box (`AppModel.creatingThread`).
    fn creating(&self, cx: &App) -> bool {
        self.thread_id.is_none()
            && self
                .app
                .upgrade()
                .is_some_and(|a| a.read(cx).new_thread.creating)
    }

    pub(crate) fn can_take_pictures(&self, cx: &App) -> bool {
        !self.creating(cx) && self.moving_line(cx).is_none()
    }

    /// The thread exists: what was sent leaves the box, if it's still what
    /// the box holds (it was locked while the runner made it).
    pub(crate) fn clear_sent_draft(
        &mut self,
        stored: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.input.read(cx).value().as_ref() == stored {
            self.input.update(cx, |s, cx| s.set_value("", window, cx));
            self.forget_chips();
        }
        cx.notify();
    }

    /// What Schedule… takes from the box: its words, without the pictures'
    /// marks (a schedule sends only text), and how many pictures there are.
    pub(crate) fn schedule_draft(&self, cx: &App) -> (String, usize) {
        let (text, _) = self.draft(cx);
        (
            text.replace(PICTURE_MARK, "").trim().to_owned(),
            self.chips(cx).len(),
        )
    }

    /// The schedule's made from the box's words: they leave it. Pictures are
    /// chips in the text, so a box with any is left as it is.
    pub(crate) fn clear_scheduled_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.chips(cx).is_empty() {
            self.input.update(cx, |s, cx| s.set_value("", window, cx));
            self.forget_chips();
            cx.notify();
        }
    }

    /// `LimitBox`: the thread's login is at its limit (a pool thread's whole
    /// pool, as the runner moves it between the pool's logins by itself),
    /// or its last turn stopped on it. At the top of the box, over a line
    /// like the card of asks: what happened, Continue now, which opens the
    /// model picker on the logins with room (24 Nov, in place of a login
    /// menu of its own; 12 Nov, in place of a single Switch to / Pin to),
    /// and whether it carries on by itself once the limit resets. Mike
    /// asked for it here on 10 Nov, in place of a bar across the top of the
    /// thread that read as an error and offered only the switch.
    fn render_limit_box(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        use gpui_kit::base::TestSupportExt as _;
        use gpui_kit::component::button::{Button, ButtonVariants as _};
        use gpui_kit::component::menu::{PopupMenu, PopupMenuItem};
        use gpui_kit::component::Disableable as _;
        let thread_id = self.thread_id.clone()?;
        let app = self.app.upgrade()?;
        let (thread, advice) = {
            let t = app.read(cx);
            let thread = t.threads.get(&thread_id)?.clone();
            // While it moves to another Mac there's nothing to switch.
            if thread.moving.is_some() {
                return None;
            }
            let advice = t.limit_advice(&thread, cx)?;
            (thread, advice)
        };
        let now = threadbear_core::sidebar::local_now();
        let when = advice
            .carries_on_at
            .map(|at| threadbear_core::sidebar::carries_on_when(at, &now));
        // Waiting to carry on reads as a quiet clock, not the red gauge.
        let waiting = advice.carries_on_at.is_some() && thread.carry_on_at_reset;
        let text = match (&when, waiting) {
            (Some(when), true) => format!("{} Carries on by itself {when}.", advice.text),
            _ => advice.text.clone(),
        };
        let secondary = style::secondary_text(cx);
        let mark = if waiting {
            crate::icons::symbol("clock")
                .with_size(px(13.))
                .text_color(secondary)
        } else {
            crate::icons::symbol("gauge.with.dots.needle.100percent")
                .with_size(px(13.))
                .text_color(cx.theme().danger)
        };
        let mut column = v_flex()
            .w_full()
            .gap(px(8.))
            .px(px(style::COMPOSER_PADDING))
            .pt(px(10.))
            .pb(px(10.))
            .text_size(px(style::size::LABEL))
            .line_height(px(16.))
            .child(
                h_flex()
                    .items_start()
                    .gap(px(8.))
                    .child(div().flex_none().pt(px(1.)).child(mark))
                    .child(
                        crate::highlights::tipped_as(
                            div().id("limit-text").flex_1().min_w_0(),
                            text.clone(),
                            gpui_kit::Role::GenericContainer,
                        )
                        .child(text),
                    ),
            );
        if !advice.targets.is_empty() || advice.stopped || advice.reset.is_some() {
            // Wraps in a narrow window rather than running past the box's edge.
            let mut row = h_flex().flex_wrap().gap(px(10.)).items_center();
            if let Some((best, _)) = advice.targets.first() {
                // Continue now: the composer's own model picker, opened by
                // this button on the logins with room (Mike, 24 Nov: in place
                // of a smaller login menu of its own beside the button). A
                // pick there carries on at once, even with Carry on by
                // itself on No, as this button always has.
                let target = self.limit_picker_target(best, cx);
                let picker = self.limit_picker_state(window, cx);
                let tip = "Pick a login or model to carry on with now, from where it stopped";
                let on_open = picker.downgrade();
                let carry_on = advice.carry_on;
                row = row.child(
                    div()
                        .id("limit-switch")
                        .test_support()
                        .a11y_role(Role::GenericContainer)
                        .aria_label(tip)
                        .child(
                            gpui_kit::component::popover::Popover::new("limit-picker")
                                .anchor(Anchor::BottomLeft)
                                .trigger(
                                    Button::new("limit-switch-button")
                                        .label("Continue now")
                                        .small()
                                        .secondary()
                                        .dropdown_caret(true)
                                        .tooltip(tip),
                                )
                                .on_open_change(move |open, _, cx| {
                                    if !*open {
                                        return;
                                    }
                                    // Each time it opens: on the pool with
                                    // the login with most room, its logins
                                    // listed.
                                    let target = target.clone();
                                    on_open
                                        .update(cx, |p, cx| {
                                            p.open_for_limit(target, carry_on, cx);
                                        })
                                        .ok();
                                })
                                // To the popover's edges, as the chip's picker.
                                .content(move |_, _, _| {
                                    div().m(gpui_kit::px(-12.)).child(picker.clone())
                                }),
                        ),
                );
            }
            if let Some((account, tip)) = advice.reset.clone() {
                // A Codex login out of room with a usage reset left (16 Nov).
                // Only on Mike's click; it spins until the runner answers.
                let busy = app.read(cx).resetting.contains(&account);
                let app_r = self.app.clone();
                row = row.child(
                    div()
                        .id("limit-reset")
                        .test_support()
                        .a11y_role(Role::GenericContainer)
                        .aria_label(tip.clone())
                        .child(
                            Button::new("limit-reset-button")
                                .label("Use a reset")
                                .small()
                                .secondary()
                                .loading(busy)
                                .disabled(busy)
                                .tooltip(tip)
                                .on_click(move |_, _, cx| {
                                    app_r
                                        .update(cx, |a, cx| a.use_reset(account.clone(), cx))
                                        .ok();
                                }),
                        ),
                );
            }
            if advice.stopped {
                row = row.child(self.render_limit_carry_on(
                    &thread.id,
                    thread.carry_on_at_reset,
                    when.as_deref(),
                    secondary,
                ));
            }
            column = column.child(row);
        }
        Some(
            v_flex()
                .w_full()
                .child(column)
                .child(div().w_full().h(gpui_kit::px(1.)).bg(style::hairline(cx)))
                .into_any_element(),
        )
    }

    fn render_limit_carry_on(
        &self,
        thread_id: &str,
        on: bool,
        when: Option<&str>,
        secondary: Hsla,
    ) -> AnyElement {
        use gpui_kit::component::button::{Button, ButtonVariants as _};
        use gpui_kit::component::menu::{PopupMenu, PopupMenuItem};
        let tip: String = if on {
            format!(
                "It carries on from where it stopped {}. No to leave it until you send a message",
                when.unwrap_or("once its limit resets")
            )
        } else {
            "It waits for you to send a message. Yes to carry on from where it stopped once there's room".into()
        };
        let (app, id) = (self.app.clone(), thread_id.to_owned());
        let menu = crate::popup_host::dropdown_button(
            "limit-carry-on",
            Button::new("limit-carry-on-button")
                .label(if on { "Yes" } else { "No" })
                .small()
                .secondary()
                .dropdown_caret(true)
                .tooltip(tip.clone()),
            px(120.),
            move |menu: PopupMenu, _, _, _| {
                let mut menu = menu;
                for (label, value) in [("Yes", true), ("No", false)] {
                    let (app, id) = (app.clone(), id.clone());
                    menu = menu.item(PopupMenuItem::new(label).checked(on == value).on_click(
                        move |_, _, cx| {
                            app.update(cx, |a, cx| a.set_carry_on_at_reset(&id, value, cx))
                                .ok();
                        },
                    ));
                }
                menu
            },
        );
        h_flex()
            .gap(px(6.))
            .items_center()
            .child(div().text_color(secondary).child("Carry on by itself"))
            .child(
                div()
                    .id("limit-carry-on")
                    .test_support()
                    .a11y_role(Role::GenericContainer)
                    .aria_label(tip)
                    .child(menu),
            )
            .into_any_element()
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.input.update(cx, |s, cx| s.focus(window, cx));
        crate::web_panels::keyboard_to_app(window);
    }

    /// What the box holds as a draft (ComposerTextView.draftNow): the words,
    /// a mark for each chip whose picture is in, and those pictures in order.
    /// A chip still being copied in isn't part of it yet, nor is a stray
    /// U+FFFC pasted as text.
    /// The words and pictures in the box, for drafts.rs to keep.
    /// What to keep through a quit: what's waiting to be given back (not
    /// drawn yet), messages still held for a restarting runner, then the box.
    pub(crate) fn draft_for_saving(&self, cx: &App) -> (String, Vec<ImageRef>) {
        let (text, images) = self.draft(cx);
        let mut all = RestoreDraft::plain(text, images);
        if let Some(id) = &self.thread_id {
            for held in crate::thread::held_drafts(id, cx).into_iter().rev() {
                all = RestoreDraft::joined(held, all);
            }
        }
        if let Some(restore) = &self.restore {
            all = RestoreDraft::joined(restore.clone(), all);
        }
        all.for_saving()
    }

    /// Whether the box holds anything a restart would lose: words, or a
    /// picture, one still being copied in included (app_update.rs).
    /// A picture still being copied in: not in the draft yet (`draft`), so a
    /// handover waits for it rather than lose it.
    /// A picture still being copied in, in the box or a card's Something
    /// else box: it isn't in the drafts file until it's in.
    pub(crate) fn copying_picture(&self, cx: &App) -> bool {
        let copying = |chips: Vec<(
            std::ops::Range<usize>,
            threadbear_core::inline_chips::BoxChip,
        )>| {
            chips.iter().any(|(_, chip)| {
                matches!(chip, threadbear_core::inline_chips::BoxChip::Picture(None))
            })
        };
        copying(self.box_chips(cx))
            || self
                .card
                .answer_inputs()
                .iter()
                .any(|input| copying(self.box_chips_in(input, cx)))
    }

    /// What in this box a restart now would lose or change, though its words
    /// go across in the drafts file: as the end of "It switches in once
    /// ...", `{t}` the thread's title. Codex's review, 19 Nov.
    pub(crate) fn restart_hold(&self, cx: &App) -> Option<&'static str> {
        if self.copying_picture(cx) {
            return Some("the picture being copied in on “{t}” is in");
        }
        // The draft under the edit is kept only in memory, until it's back.
        if self.editing.is_some() || self.pending_saved.is_some() || self.pending_box.is_some() {
            return Some("the message you're editing in “{t}” is sent or put back");
        }
        // Words half composed (an input method's) would come back as typed.
        if self.input.read(cx).has_composition()
            || self
                .card
                .answer_inputs()
                .iter()
                .any(|i| i.read(cx).has_composition())
        {
            return Some("the word you're composing in “{t}” is done");
        }
        if self
            .thread_id
            .as_deref()
            .is_some_and(|id| crate::thread::sending_now(id, cx))
        {
            return Some("the message on its way in “{t}” has gone");
        }
        None
    }

    /// Anything here the drafts file would keep: the box's words or
    /// pictures, or the card's answers.
    pub(crate) fn has_draft(&self, cx: &App) -> bool {
        // Only the card still open: an answered one's state stays behind.
        let open = self
            .open_card(cx)
            .is_some_and(|c| !c.is_done() && Some(c.source_seq) == self.card.source_seq);
        self.holds_anything(cx)
            || (open
                && (!self.card.picks.is_empty()
                    || self
                        .card
                        .notes
                        .values()
                        .any(|n| !n.text.trim().is_empty() || !n.images.is_empty())))
    }

    pub(crate) fn holds_anything(&self, cx: &App) -> bool {
        let text = self.input.read(cx).value().to_string();
        threadbear_core::inline_chips::holds_anything(&text, &self.box_chips(cx))
    }

    /// A card's or thread's chip is its link in the draft (composer_inline.rs).
    fn draft(&self, cx: &App) -> (String, Vec<ImageRef>) {
        let text = self.input.read(cx).value().to_string();
        let end = text.len();
        threadbear_core::inline_chips::draft_in(&text, &self.box_chips(cx), 0..end)
    }

    /// The box's text as the Swift dump gives it: chips as the markers they'll
    /// go out as (`InlinePictures.messageText`).
    #[cfg(feature = "automation")]
    pub fn draft_text(&self, cx: &App) -> String {
        composer::message_text(&self.draft(cx).0, 1)
    }

    /// How many pictures are in the box (the dump's `composer.images`).
    #[cfg(feature = "automation")]
    pub fn draft_images(&self, cx: &App) -> usize {
        self.draft(cx).1.len()
    }

    pub(crate) fn pane(&self) -> Option<Entity<ThreadPane>> {
        self.pane.upgrade()
    }

    // ---- Keys ----

    /// Return in the box (ComposerTextView.keyDown): with nothing typed it
    /// goes to `return_when_empty`, otherwise it sends.
    fn return_pressed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.input.read(cx).value().is_empty() && self.return_when_empty(window, cx) {
            return;
        }
        self.send(window, cx);
    }

    /// ComposerView.returnWhenEmpty: Return with nothing typed allows the
    /// sole waiting approval (the ⏎ its Allow button shows). Not while a
    /// message is being edited: the box is the edit then, an empty one
    /// sends nothing, and Return there is about that message, never a card
    /// that may be off screen (Daybreak, 11 Nov: pencil, clear, Return
    /// allowed a waiting tool). Pictures are chips in the text, so an edit
    /// with only pictures left isn't empty and goes to `send`.
    fn return_when_empty(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.editing.is_some() {
            return true;
        }
        if self.return_with_picks(window, cx) {
            return true;
        }
        let Some(pane) = self.pane() else {
            return false;
        };
        pane.update(cx, |p, cx| p.allow_sole_approval(cx))
    }

    /// Shift-Return, before the input takes it: a markdown list carries on
    /// (ComposerTextView.insertLineContinuingList), through one edit so it's
    /// one undo.
    fn shift_return(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let (text, selection) = {
            let state = self.input.read(cx);
            (state.value().to_string(), state.selected_range())
        };
        let Some(edit) = composer::list_newline(&text, selection.clone()) else {
            return false;
        };
        self.input.update(cx, |s, cx| {
            if edit.range != selection {
                // An item with nothing in it: the marker comes off.
                s.set_selected_range(edit.range.clone(), cx);
            }
            s.replace(edit.text.clone(), window, cx);
        });
        true
    }

    // ---- Sending ----

    fn loading_pictures(&self, cx: &App) -> bool {
        let mut inputs = if self.editing.is_some() {
            Vec::new()
        } else {
            self.card.answer_inputs()
        };
        inputs.push(self.input.clone());
        inputs
            .iter()
            .flat_map(|input| Self::chips_in(input, cx))
            .any(|(_, id)| self.pictures.get(&id).is_some_and(|p| p.image.is_none()))
    }

    /// Whether there's anything to send (ComposerView.canSend).
    fn can_send(&self, cx: &App) -> bool {
        !self.loading_pictures(cx) && self.has_send_content(cx)
    }

    fn has_send_content(&self, cx: &App) -> bool {
        let (text, images) = self.draft(cx);
        composer::can_send(&text, images.len())
            || !self.card.picks.is_empty()
            || !self.card.next_picks.is_empty()
            || !self.card.explain.is_empty()
            // A changed draft's chip says it goes with the message, so it
            // can go on its own (composer_drafts.rs).
            || self.has_pending_drafts(cx)
    }

    /// AppModel.send: the box empties at once and the message shows dimmed
    /// at the end of the transcript until the runner has it; it comes back
    /// if the runner doesn't take it.
    pub(crate) fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.loading_pictures(cx) || self.refuse_dead_chip(cx) {
            return;
        }
        // The arrow hops as Return lands, when there's something to send
        // (Mike picked it, 13 Nov). None under Reduce Motion.
        if self.can_send(cx) && !cx.reduce_motion() {
            self.sent_hop = Some(std::time::Instant::now());
        }
        // Return still reaches here with the box locked for a move.
        if self.moving_line(cx).is_some() {
            return;
        }
        if self.thread_id.is_none() {
            return self.send_new_thread(window, cx);
        }
        if self.editing.is_some() {
            return self.send_edit(cx);
        }
        let (draft_text, images) = self.draft(cx);
        // Pictures from the asks' boxes come first, numbered as the answers
        // say, then the box's own chips, whose markers go after them.
        let boxes = self.note_images_len(cx);
        let words = composer::sent_text(&draft_text, boxes + 1)
            .trim()
            .to_string();
        // Drafts he's changed in this thread's replies go on the end, for
        // the agent to use his words (draft_boxes.rs).
        let thread = self.thread_id.clone().unwrap_or_default();
        let edits = crate::draft_boxes::unsent_edits(&thread, cx);
        let words = [words, edits.clone()]
            .into_iter()
            .filter(|w| !w.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        let (text, images_to_send, answers) = match self.card_message(&words, cx) {
            Some((message, mut note_images, answers)) => {
                note_images.extend(images.clone());
                (message, note_images, answers)
            }
            None => (words, images.clone(), Value::Null),
        };
        if text.trim().is_empty() && images_to_send.is_empty() {
            return;
        }
        let Some(pane) = self.pane() else { return };
        // No runner and no restart to wait for: the words stay in the box,
        // and the error bar says why (`send`'s guard).
        if let Some(why) = pane.read(cx).cant_send_now() {
            if let Some(app) = self.app.upgrade() {
                app.update(cx, |app, cx| app.show_connection_error(why, cx));
            }
            return;
        }
        let picks = self.saved_picks();
        self.input.update(cx, |s, cx| s.set_value("", window, cx));
        self.forget_chips();
        self.clear_picks(cx);
        let composer = cx.entity().downgrade();
        let restore = RestoreDraft {
            text: draft_text,
            images,
            card: picks,
            as_sent: None,
        };
        pane.update(cx, |p, cx| {
            p.send_message(text, images_to_send, answers, Some(restore), composer, cx)
        });
        if !edits.is_empty() {
            crate::draft_boxes::note_edits_sent(&thread, cx);
        }
        cx.notify();
    }

    /// `AppModel.send(threadId: nil)`: the new-thread page's box. The words
    /// stay (greyed, locked) until the thread exists; a failure leaves them.
    fn send_new_thread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (draft_text, images) = self.draft(cx);
        let text = composer::sent_text(&draft_text, 1).trim().to_string();
        if text.is_empty() && images.is_empty() {
            return;
        }
        let stored = self.input.read(cx).value().to_string();
        if let Some(app) = self.app.upgrade() {
            app.update(cx, |app, cx| {
                app.send_new_thread(text, images, stored, window, cx)
            });
        }
    }

    fn saved_picks(&self) -> Option<SavedPicks> {
        self.card.source_seq.map(|source_seq| SavedPicks {
            source_seq,
            picks: self.card.picks.clone(),
            notes: self.card.notes.clone(),
            next_picks: self.card.next_picks.clone(),
            explain: self.card.explain.clone(),
        })
    }

    fn note_images_len(&self, cx: &App) -> usize {
        self.open_card(cx).filter(|c| !c.is_done()).map_or(0, |c| {
            composer::note_images(&c.asks, &c.active_picks(&self.card.picks), &self.card.notes)
                .len()
        })
    }

    /// The Stop button (⌘. goes through ThreadPane::stop too).
    fn stop(&mut self, cx: &mut Context<Self>) {
        self.stopping = Some(crate::now_ms());
        if let Some(pane) = self.pane() {
            pane.update(cx, |p, cx| p.stop(cx));
        }
        // Drawn again once the spinner's time is up, in case nothing else
        // draws it (a turn that ignored Stop and went quiet).
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(
                    threadbear_core::composer::STOPPING_SHOWN_MS as u64,
                ))
                .await;
            this.update(cx, |_, cx| cx.notify()).ok();
        })
        .detach();
        cx.notify();
    }

    /// A send the runner refused: what was typed goes back in the box
    /// (AppModel.restoreDraft), unless something new has been typed since.
    /// At the next render, where there's a window to do it with.
    /// The pencil by one of Mike's messages (`startEditing`): its words and
    /// pictures go in the box, chips where their markers were, and what was
    /// in the box comes back if the edit's left.
    pub(crate) fn start_editing(
        &mut self,
        seq: i64,
        text: &str,
        images: &[ImageRef],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let before = match self.editing.take() {
            Some(edit) => edit.before,
            None => self.input.update(cx, |s, _| SavedBox {
                content: s.content(),
                selection: s.selected_range(),
                history: s.take_history(),
            }),
        };
        let (words, order) = composer::edit_draft(text, images.len());
        let pictures = order
            .iter()
            .filter_map(|i| images.get(*i).cloned())
            .collect();
        // Not `set_box`: the saved box's chips keep their entries.
        self.input.update(cx, |s, cx| s.set_value("", window, cx));
        self.apply_restore(RestoreDraft::plain(words, pictures), window, cx);
        self.editing = Some(MessageEdit {
            seq,
            before,
            sending: false,
        });
        self.focus(window, cx);
        crate::web_panels::keyboard_to_app(window);
        cx.notify();
    }

    /// Leaves the edit (`cancelEditing`): the box gets back what was in it.
    pub(crate) fn cancel_editing(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(edit) = self.editing.take() else {
            return;
        };
        self.restore_box(edit.before, window, cx);
        cx.notify();
    }

    /// The box back as `start_editing` saved it, history and all.
    fn restore_box(&mut self, saved: SavedBox, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |s, cx| {
            s.set_value(saved.content, window, cx);
            s.restore_history(saved.history);
            s.set_selected_range(saved.selection, cx);
        });
        // Pictures that came for a chip of this box while the edit was in
        // it go in beside their chip now.
        for (id, target, paths) in std::mem::take(&mut self.held_extras) {
            self.insert_promised_extra(&id, &target, paths, window, cx);
        }
    }

    /// The box holding exactly `text` from the next frame: the tour's first
    /// message, written for them.
    pub(crate) fn replace_text(&mut self, text: String, cx: &mut Context<Self>) {
        self.pending_box = Some((text, vec![]));
        cx.notify();
    }

    /// The box holding exactly `text`, its marks as chips of `images`.
    fn set_box(
        &mut self,
        text: String,
        images: Vec<ImageRef>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.input.update(cx, |s, cx| s.set_value("", window, cx));
        self.forget_chips();
        self.apply_restore(RestoreDraft::plain(text, images), window, cx);
    }

    /// Sends the edited message (`sendEdit`): the box keeps it, its banner
    /// saying it's on its way, until the runner has started the new turn;
    /// an error leaves it there to try again. Going back would stop work the
    /// agent left running, so that's asked first.
    fn send_edit(&mut self, cx: &mut Context<Self>) {
        let Some(seq) = self.editing.as_ref().filter(|e| !e.sending).map(|e| e.seq) else {
            return;
        };
        let Some(thread_id) = self.thread_id.clone() else {
            return;
        };
        let (draft_text, images) = self.draft(cx);
        let text = composer::sent_text(&draft_text, 1).trim().to_string();
        if text.is_empty() && images.is_empty() {
            return;
        }
        // The runner it's shown on, as a send says it (thread.rs, Daybreak 113).
        let Some(runner_id) = self.app.upgrade().and_then(|app| {
            app.read(cx)
                .threads
                .get(&thread_id)
                .map(|t| t.runner_id.clone())
        }) else {
            return;
        };
        if let Some(edit) = self.editing.as_mut() {
            edit.sending = true;
        }
        crate::activity::sent(Some(&thread_id), images.len(), 0, true);
        cx.notify();
        let client = self.client.clone();
        let images_json: Vec<Value> = images.iter().map(image_ref_json).collect();
        cx.spawn(async move |this, cx| {
            let mut stop_background = false;
            loop {
                let mut params = json!({ "threadId": thread_id, "seq": seq, "text": text, "stopBackground": stop_background, "runnerId": runner_id });
                if !images_json.is_empty() {
                    params["images"] = json!(images_json);
                }
                match crate::call_action(client.clone(), "threads.edit", params).await {
                    Ok(_) => {
                        this.update(cx, |this, cx| {
                            // Done with: the box gets back what was in it before,
                            // at the next render, which has the window.
                            if let Some(edit) = this.editing.take() {
                                this.pending_saved = Some(edit.before);
                            }
                            cx.notify();
                        })
                        .ok();
                    }
                    Err(e) if e.code == -32050 && !stop_background => {
                        // An upload was lost that way (4 Nov): asked first.
                        let detail = format!("{}\n\nCancel keeps it running; you can send your change as a new message instead.", e.message);
                        if crate::alert::confirm("Stop the background work?", &detail, "Stop It and Go Back", "Cancel") {
                            stop_background = true;
                            continue;
                        }
                        this.update(cx, |this, cx| {
                            if let Some(edit) = this.editing.as_mut() {
                                edit.sending = false;
                            }
                            cx.notify();
                        })
                        .ok();
                    }
                    Err(e) => {
                        this.update(cx, |this, cx| {
                            if let Some(edit) = this.editing.as_mut() {
                                edit.sending = false;
                            }
                            if let Some(pane) = this.pane() {
                                pane.update(cx, |p, cx| p.show_error(e.message, cx));
                            }
                            cx.notify();
                        })
                        .ok();
                    }
                }
                return;
            }
        })
        .detach();
    }

    /// `EditingBanner`: what sending will do, and Cancel (Esc); while it's
    /// on its way, that it's cutting back, with a spinner.
    fn render_editing_banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let edit = self.editing.as_ref()?;
        let secondary = style::secondary_text(cx);
        let text = if edit.sending {
            "Cutting the thread back to this message…"
        } else {
            "Editing a message. Sending cuts the thread back to it and undoes the agent's file changes since."
        };
        let size = px(style::size::SIDEBAR_META + 1.);
        let end: AnyElement = if edit.sending {
            Spinner::new()
                .color(secondary)
                .with_size(px(12.))
                .into_any_element()
        } else {
            crate::highlights::tipped(
                div()
                    .id("edit-cancel")
                    .flex_none()
                    .cursor_pointer()
                    .text_size(size)
                    .text_color(style::accent(cx)),
                "Stop editing and put back what was in the box (Esc)".to_owned(),
            )
            .on_click(
                cx.listener(|this, _: &ClickEvent, window, cx| this.cancel_editing(window, cx)),
            )
            .child("Cancel")
            .into_any_element()
        };
        Some(
            h_flex()
                .w_full()
                .gap(px(6.))
                .items_start()
                .child(
                    div().flex_none().pt(px(2.)).child(
                        crate::icons::symbol("pencil")
                            .with_size(px(style::size::SIDEBAR_META))
                            .text_color(secondary),
                    ),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(size)
                        .line_height(px(style::natural_line(style::size::SIDEBAR_META + 1.)))
                        .text_color(secondary)
                        .child(text),
                )
                .child(end)
                .into_any_element(),
        )
    }

    /// Puts words back in the box, once it's next drawn. Two given back
    /// before then are both kept, the older first (a held message and
    /// another, while this thread wasn't open).
    pub fn restore_draft(&mut self, draft: RestoreDraft, cx: &mut Context<Self>) {
        self.restore = Some(match self.restore.take() {
            Some(earlier) => RestoreDraft::joined(earlier, draft),
            None => draft,
        });
        cx.notify();
    }

    fn apply_restore(
        &mut self,
        restore: RestoreDraft,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A picture still on its way into the box would drop out of the
        // words joined below: wait for it, and put these back after.
        if self
            .box_chips(cx)
            .iter()
            .any(|(_, chip)| matches!(chip, threadbear_core::inline_chips::BoxChip::Picture(None)))
        {
            self.restore = Some(restore);
            return;
        }
        let RestoreDraft {
            text: draft,
            images,
            card,
            ..
        } = restore;
        if let Some(saved) = card {
            if self.card.source_seq == Some(saved.source_seq) {
                self.card.picks = saved.picks;
                self.card.notes = saved.notes;
                self.card.next_picks = saved.next_picks;
                self.card.explain = saved.explain;
                self.push_card_state(cx);
            }
        }
        // Anything typed since stays, after what's given back
        // (`restoreDraft`), rather than the words given back being lost.
        let (now_text, now_images) = self.draft(cx);
        let RestoreDraft {
            text: draft,
            images,
            ..
        } = RestoreDraft::joined(
            RestoreDraft::plain(draft, images),
            RestoreDraft::plain(now_text, now_images),
        );
        // Chips again where the marks are, each picture back in place, and
        // the cards and threads linked in the words as theirs.
        let content = self.content_for(&draft, &images);
        self.input
            .update(cx, |s, cx| s.set_value(content, window, cx));
    }

    pub(crate) fn fresh_picture_id(&mut self) -> SharedString {
        self.next_picture += 1;
        format!("picture-{}", self.next_picture).into()
    }

    // ---- Pictures ----

    /// Paste: pictures and files first, as ComposerTextView.takeImages takes
    /// them. Returns whether it took the paste; words paste as words.
    pub(crate) fn take_clipboard(
        &mut self,
        item: &ClipboardItem,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let target = self.input.clone();
        self.take_clipboard_in(&target, item, window, cx)
    }

    fn take_native_paste(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.can_take_pictures(cx) {
            return false;
        }
        let target = self.native_paste_target(window, cx);
        let Some(target) = target else { return false };
        let Some(paths) = crate::composer_media::read(false) else {
            return false;
        };
        self.take_paths_in(&target, paths, window, cx);
        true
    }

    /// A paste into `target`: the box, or one of the card's Something else
    /// boxes, which takes pictures as chips just the same (AskAnswerBox).
    pub(crate) fn take_clipboard_in(
        &mut self,
        target: &Entity<TextareaState>,
        item: &ClipboardItem,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if let Some(paths) = crate::composer_media::read(false) {
            self.take_paths_in(target, paths, window, cx);
            return true;
        }
        let mut paths = Vec::new();
        let mut images = Vec::new();
        let mut has_text = false;
        for entry in item.entries() {
            match entry {
                ClipboardEntry::ExternalPaths(p) => paths.extend(p.paths().iter().cloned()),
                ClipboardEntry::Image(image) => images.push(image.clone()),
                ClipboardEntry::String(_) => has_text = true,
            }
        }
        if !paths.is_empty() {
            self.take_paths_in(target, paths, window, cx);
            return true;
        }
        // A copy of the box's own chips with its pictures, a thread's id, a
        // card's link: chips (composer_inline.rs). Other words are words.
        if has_text && self.take_clipboard_chips(target, item, window, cx) {
            return true;
        }
        // Text with an image flavour (rich text from a browser) stays text.
        if has_text || images.is_empty() {
            return false;
        }
        let saved: Vec<PathBuf> = images.iter().filter_map(save_pasted_image).collect();
        if saved.is_empty() {
            return false;
        }
        self.insert_pictures_in(target, saved, window, cx);
        true
    }

    /// Files pasted or dropped: pictures become chips where the cursor is, and
    /// anything else goes in as its full path in backticks, for the agent to
    /// open where it is (ComposerTextView.takeImages).
    pub(crate) fn take_paths(
        &mut self,
        paths: Vec<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let target = self.input.clone();
        self.take_paths_in(&target, paths, window, cx);
    }

    pub(crate) fn take_drop_in(
        &mut self,
        target: &Entity<TextareaState>,
        paths: Vec<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.can_take_pictures(cx) {
            return;
        }
        let paths = crate::composer_media::read(true).unwrap_or(paths);
        if paths.is_empty() {
            if let Some(pane) = self.pane() {
                pane.update(cx, |p, cx| {
                    p.show_error("Couldn't read that picture".into(), cx)
                });
            }
            return;
        }
        self.take_paths_in(target, paths, window, cx);
    }

    pub(crate) fn take_paths_in(
        &mut self,
        target: &Entity<TextareaState>,
        paths: Vec<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (images, others): (Vec<_>, Vec<_>) = paths
            .into_iter()
            .map(keep_picture)
            .partition(|p| is_picture(p));
        if !others.is_empty() {
            self.insert_paths(target, others, window, cx);
        }
        if !images.is_empty() {
            self.insert_pictures_in(target, images, window, cx);
        }
    }

    /// ComposerTextView.insertPaths: the paths with a space either side,
    /// each drawn as a file's chip (its name, and a dot for "not uploaded":
    /// the agent opens it where it is). The chip's text is still the path in
    /// backticks, so the message says just what it did before; a path that
    /// doesn't read as a local file's (`chips::find_files`) stays words.
    fn insert_paths(
        &mut self,
        target: &Entity<TextareaState>,
        paths: Vec<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (text, selection) = Self::text_and_selection(target, cx);
        let mut piece = composer::path_text(
            &paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
        );
        if text[..selection.start]
            .chars()
            .next_back()
            .is_some_and(|c| !c.is_whitespace())
        {
            piece.insert(0, ' ');
        }
        if !text[selection.end..]
            .chars()
            .next()
            .is_some_and(char::is_whitespace)
        {
            piece.push(' ');
        }
        self.insert_pieces_in(
            target,
            threadbear_core::inline_chips::draft_pieces(&piece, 0),
            &[],
            window,
            cx,
        );
    }

    pub(crate) fn text_and_selection(
        target: &Entity<TextareaState>,
        cx: &App,
    ) -> (String, Range<usize>) {
        let state = target.read(cx);
        (state.value().to_string(), state.selected_range())
    }

    /// ComposerTextView.insertPictures: chips where the cursor is in
    /// `target` (the box, or a Something else box), with a space either
    /// side, each copied in through the runner as it shows, dimmed until it's
    /// in; one that can't be read goes again.
    pub(crate) fn insert_pictures_in(
        &mut self,
        target: &Entity<TextareaState>,
        paths: Vec<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.insert_pictures(target, paths, true, window, cx);
    }

    fn insert_pictures(
        &mut self,
        target: &Entity<TextareaState>,
        paths: Vec<PathBuf>,
        focus: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let ids: Vec<SharedString> = paths.iter().map(|_| self.fresh_picture_id()).collect();
        let tokens: Vec<InlineToken> = ids.iter().map(picture_token).collect();
        // Each chip's entry before its token, so no chip is ever in the box
        // without one (`has_dead_chip` would stop it sending).
        // The first picture in opens the strip for itself. The box's chips,
        // not `pictures`, say whether it's empty: entries outlive their
        // chips for Undo.
        let strip_empty = Self::chips_in(&self.input, cx).is_empty();
        for (i, (id, path)) in ids.iter().zip(&paths).enumerate() {
            let dropping = (!cx.reduce_motion()).then(|| Cell::new(None));
            if dropping.is_some() && strip_empty && i == 0 && *target == self.input {
                self.strip_opening = Some(Cell::new(None));
            }
            self.pictures_dropped += dropping.is_some() as usize;
            self.pictures.insert(
                id.clone(),
                PictureChip {
                    source: path.clone(),
                    image: None,
                    dropping,
                },
            );
        }
        let (text, selection) = Self::text_and_selection(target, cx);
        let prev_is_space = text[..selection.start]
            .chars()
            .next_back()
            .is_none_or(char::is_whitespace);
        let next_is_space = text[selection.end..]
            .chars()
            .next()
            .is_some_and(char::is_whitespace);
        target.update(cx, |s, cx| {
            if !selection.is_empty() {
                s.replace("", window, cx);
            }
            if !prev_is_space {
                s.insert(" ", window, cx);
            }
            for (i, token) in tokens.iter().enumerate() {
                if i > 0 {
                    s.insert(" ", window, cx);
                }
                let _ = s.replace_with_token(token.clone(), window, cx);
            }
            if !next_is_space {
                s.insert(" ", window, cx);
            }
            if focus {
                s.focus(window, cx);
                crate::web_panels::keyboard_to_app(window);
            }
        });
        for (id, path) in ids.into_iter().zip(paths) {
            self.import_picture(id, path, target.downgrade(), window, cx);
        }
        cx.notify();
    }

    fn import_picture(
        &mut self,
        id: SharedString,
        path: PathBuf,
        target: WeakEntity<TextareaState>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let client = self.client.clone();
        cx.spawn_in(window, async move |this, cx| {
            let mut imported = path.clone();
            let grace = cx
                .background_executor()
                .timer(std::time::Duration::from_millis(500));
            let ready = crate::composer_media::ready(&path, grace);
            let timeout = cx
                .background_executor()
                .timer(std::time::Duration::from_secs(60));
            futures::pin_mut!(ready, timeout);
            let prepared = match futures::future::select(ready, timeout).await {
                futures::future::Either::Left((result, _)) => result,
                futures::future::Either::Right(_) => {
                    Err("The picture took too long to arrive".into())
                }
            };
            let result = match prepared {
                Ok(mut prepared) => {
                    if let Some(first) = prepared.paths.first() {
                        imported = first.clone();
                    }
                    let extra = prepared.paths.split_off(1);
                    if !extra.is_empty() {
                        let discard = extra.clone();
                        if this
                            .update_in(cx, |this, window, cx| {
                                this.insert_promised_extra(&id, &target, extra, window, cx)
                            })
                            .is_err()
                        {
                            for path in discard {
                                unstage(&path);
                            }
                        }
                    }
                    crate::call_action(
                        client,
                        "media.import",
                        json!({ "path": imported.to_string_lossy() }),
                    )
                    .await
                }
                Err(message) => Err(threadbear_client::runner::RpcError {
                    code: -32602,
                    message,
                    data: None,
                }),
            };
            // The runner keeps its own copy (or said no): a pasted picture's
            // staged file goes now, whatever happens to the chip.
            unstage(&path);
            unstage(&imported);
            this.update_in(cx, |this, window, cx| {
                this.settle_picture(id, result, target, window, cx)
            })
            .ok();
        })
        .detach();
    }

    /// A legacy file promise can deliver several pictures for one item. Add
    /// the rest beside its placeholder, preserving the user's current caret
    /// and focus; a chip already deleted never makes pictures reappear.
    fn insert_promised_extra(
        &mut self,
        id: &SharedString,
        target: &WeakEntity<TextareaState>,
        paths: Vec<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(target) = target
            .upgrade()
            .filter(|target| Self::chip_range(target, id, cx).is_some())
        else {
            // Its chip is in the box an edit is holding, or one that's just
            // ended and puts it back at the next render: they wait for it.
            let saved = self
                .editing
                .as_ref()
                .map(|e| &e.before)
                .or(self.pending_saved.as_ref());
            if saved.is_some_and(|b| b.content.tokens().iter().any(|t| t.token().id() == id)) {
                self.held_extras.push((id.clone(), target.clone(), paths));
                return;
            }
            for path in paths {
                unstage(&path);
            }
            return;
        };
        let Some(at) = Self::chip_range(&target, id, cx).map(|r| r.end) else {
            return;
        };
        let (before, selection) = Self::text_and_selection(&target, cx);
        target.update(cx, |s, cx| s.set_selected_range(at..at, cx));
        self.insert_pictures(&target, paths, false, window, cx);
        let added = target.read(cx).value().len().saturating_sub(before.len());
        let moved = |offset| if offset >= at { offset + added } else { offset };
        target.update(cx, |s, cx| {
            s.set_selected_range(moved(selection.start)..moved(selection.end), cx)
        });
    }

    /// ComposerTextView.settle: a chip's picture is in, or couldn't be read.
    /// Gone from the words by then (deleted, or the box holding an edit),
    /// it's kept all the same, as Undo can bring the chip back; only a box
    /// that's gone drops it.
    fn settle_picture(
        &mut self,
        id: SharedString,
        result: Result<Value, threadbear_client::runner::RpcError>,
        target: WeakEntity<TextareaState>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(target) = target.upgrade() else {
            self.pictures.remove(&id);
            return;
        };
        let range = Self::chip_range(&target, &id, cx);
        match result {
            Ok(v) => {
                let image = ImageRef::decode(&v["image"]);
                if let (Some(chip), Some(image)) = (self.pictures.get_mut(&id), image) {
                    chip.image = Some(image);
                }
                if range.is_none() {
                    return;
                }
                // A Something else box's answer takes it now.
                if target != self.input {
                    self.answer_box_changed(&target, cx);
                }
            }
            Err(e) => {
                // Taken out, with the space that came with it. Undo bringing
                // the chip back finds no picture behind it: its tile says so,
                // and sending says to take it out (`has_dead_chip`).
                self.pictures.remove(&id);
                if let Some(range) = range {
                    Self::remove_chip_range(&target, range, window, cx);
                }
                if let Some(pane) = self.pane() {
                    pane.update(cx, |p, cx| {
                        p.show_error(format!("Couldn't add that picture: {}", e.message), cx)
                    });
                }
            }
        }
        cx.notify();
    }

    /// The token ranges of the picture chips in the box, in order: a card's
    /// or thread's chip isn't one of them.
    fn chips(&self, cx: &App) -> Vec<(Range<usize>, SharedString)> {
        Self::chips_in(&self.input, cx)
    }

    pub(crate) fn chips_in(
        target: &Entity<TextareaState>,
        cx: &App,
    ) -> Vec<(Range<usize>, SharedString)> {
        target
            .read(cx)
            .tokens()
            .iter()
            .filter(|span| !Self::is_mention_token(span.token().id()))
            .map(|span| (span.range(), span.token().id().clone()))
            .collect()
    }

    fn chip_range(
        target: &Entity<TextareaState>,
        id: &SharedString,
        cx: &App,
    ) -> Option<Range<usize>> {
        Self::chips_in(target, cx)
            .into_iter()
            .find(|(_, chip)| chip == id)
            .map(|(r, _)| r)
    }

    /// Takes a chip out with one space beside it (ComposerTextView.withSpace),
    /// keeping the cursor where it was as far as it can.
    fn remove_chip_range(
        target: &Entity<TextareaState>,
        range: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (text, selection) = Self::text_and_selection(target, cx);
        let bytes = text.as_bytes();
        let gone = if bytes.get(range.end) == Some(&b' ') {
            range.start..range.end + 1
        } else if range.start > 0 && bytes[range.start - 1] == b' ' {
            range.start - 1..range.end
        } else {
            range
        };
        let shift = |at: usize| {
            if at <= gone.start {
                at
            } else {
                at.saturating_sub(gone.len()).max(gone.start)
            }
        };
        let caret = shift(selection.start)..shift(selection.end);
        target.update(cx, |s, cx| {
            s.set_selected_range(gone.clone(), cx);
            s.replace("", window, cx);
            s.set_selected_range(caret.clone(), cx);
        });
    }

    /// The strip's × (ComposerView.removePicture): the chip goes too, and the
    /// cursor stays where it was.
    fn remove_picture(&mut self, id: SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let target = self.input.clone();
        self.remove_picture_in(&target, id, window, cx);
    }

    ///
    /// The picture stays in `pictures`, as it does for a chip deleted with
    /// Backspace: the × is an edit Undo takes back, and the chip it brings
    /// back has to have its picture, or the message went without it (Codex,
    /// 18 Nov). Sending or a new draft clears them.
    pub(crate) fn remove_picture_in(
        &mut self,
        target: &Entity<TextareaState>,
        id: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(range) = Self::chip_range(target, &id, cx) {
            Self::remove_chip_range(target, range, window, cx);
        }
        cx.notify();
    }

    /// Whether a picture's chip in what would be sent has no picture behind
    /// it: Undo bringing back one whose picture couldn't be read, say. Sent,
    /// the message would quietly go without it, so `send` refuses and says
    /// why. Taking it out again with an edit of its own made a loop Undo
    /// couldn't get past (Codex, 18 Nov).
    fn has_dead_chip(&self, cx: &App) -> bool {
        let mut inputs = if self.editing.is_some() {
            Vec::new()
        } else {
            self.card.sent_answer_inputs()
        };
        inputs.push(self.input.clone());
        inputs
            .iter()
            .flat_map(|input| Self::chips_in(input, cx))
            .any(|(_, id)| !self.pictures.contains_key(&id))
    }

    /// Says a dead chip is in the way, if one is: true when it did.
    fn refuse_dead_chip(&self, cx: &mut Context<Self>) -> bool {
        if !self.has_dead_chip(cx) {
            return false;
        }
        if let Some(pane) = self.pane() {
            pane.update(cx, |p, cx| {
                p.show_error(
                    "A picture in your message couldn't be added. Take its chip out to send."
                        .to_owned(),
                    cx,
                )
            });
        }
        true
    }

    /// The box emptied: its chips' pictures and links go too, unless an edit
    /// is holding the box from before it, whose chips still point at them
    /// (Schedule… during an edit took them, Codex, 18 Nov).
    fn forget_chips(&mut self) {
        if self.editing.is_none() {
            self.pictures.clear();
            self.mentions.clear();
        }
    }

    fn renumber_chips(&mut self, cx: &App) {
        self.chip_numbers = self
            .chips(cx)
            .into_iter()
            .enumerate()
            .map(|(i, (_, id))| (id, i + 1))
            .collect();
        // A Something else box's chips count from 1 in each box.
        for input in self.card.answer_inputs() {
            for (i, (_, id)) in Self::chips_in(&input, cx).into_iter().enumerate() {
                self.chip_numbers.insert(id, i + 1);
            }
        }
    }

    /// The hover card over a chip, after a beat, as ComposerTextView.hoverChip
    /// does (0.35 s).
    fn hover_chip(&mut self, event: &InlineTokenHoverEvent, cx: &mut Context<Self>) {
        // A card's or thread's chip has no picture to show.
        if Self::is_mention_token(event.token().id()) {
            return;
        }
        self.hover_serial += 1;
        let serial = self.hover_serial;
        self.peek_shown = None;
        self.hovered_chip = event
            .is_hovered()
            .then(|| (event.token().id().clone(), event.bounds()));
        cx.notify();
        if self.hovered_chip.is_some() {
            cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(350))
                    .await;
                this.update(cx, |this, cx| {
                    if this.hover_serial == serial {
                        this.peek_shown = this.hovered_chip.clone();
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        }
    }

    /// Shows the chip numbered `number`'s picture, as the automation's
    /// `composer-peek` does (ComposerTextView.debugHoverChip).
    #[cfg(feature = "automation")]
    pub fn debug_peek(
        &mut self,
        number: Option<usize>,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        self.hovered_chip = None;
        match number {
            None => self.peek_shown = None,
            Some(number) => {
                let chips = self.chips(cx);
                let Some((_, id)) = chips.get(number.saturating_sub(1)) else {
                    return Err(format!("no chip {number}"));
                };
                self.peek_shown = Some((id.clone(), Bounds::default()));
            }
        }
        cx.notify();
        Ok(())
    }

    /// A plain click on a picture's chip among the words, or on its thumbnail
    /// over them: the app's picture viewer on it, stepping through the other
    /// pictures in the same box (ComposerTextView.previewPicture, where it's
    /// Quick Look; Mike, 11 Nov). One still being copied in shows from the
    /// file it came from. False when it isn't a picture that opens here.
    pub(crate) fn open_picture(
        &mut self,
        target: &Entity<TextareaState>,
        id: &SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(chosen) = self
            .picture_path(id)
            .map(|p| p.to_string_lossy().into_owned())
        else {
            return false;
        };
        // The hover card goes, as Swift's mouseDown ends it: the viewer
        // comes up over everything.
        self.hover_serial += 1;
        self.hovered_chip = None;
        self.peek_shown = None;
        let paths = Self::chips_in(target, cx)
            .iter()
            .filter_map(|(_, chip)| self.picture_path(chip))
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let opened = crate::viewer::open_from_composer(paths, &chosen, window, cx);
        let ok = opened.is_some();
        #[cfg(feature = "automation")]
        {
            self.debug_opened = opened;
        }
        cx.notify();
        ok
    }

    /// `composer-peek` with `press` or `strip`, as the Swift app's
    /// debugOpenPicture: a real click (pointer events through hit testing) on
    /// chip `number` among the words, or on the strip's thumbnail `strip`
    /// (0-based), and what the viewer was handed: `(paths, index)`.
    ///
    /// The thumbnail is hovered first, and its × has to be inside the
    /// thumbnail's top right corner (it was drawn at the bottom edge over the
    /// chip under it, where it couldn't be clicked; Mike, 12 Nov). With
    /// `remove`, the × is clicked instead: the picture has to go and nothing
    /// open.
    #[cfg(feature = "automation")]
    pub(crate) fn debug_click_picture(
        this: &Entity<Self>,
        number: Option<usize>,
        strip: Option<usize>,
        remove: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> Result<serde_json::Value, String> {
        use gpui_kit::test::{TestEventExt as _, TestQueryExt as _, TestWindowExt as _};
        let click = |at: Point<Pixels>, window: &mut Window, cx: &mut App| {
            window.pointer_move(at, None, cx);
            window.render_frame(cx);
            window.pointer_down(at, MouseButton::Left, cx);
            window.pointer_up(at, MouseButton::Left, cx);
            window.render_frame(cx);
        };
        this.update(cx, |c, _| c.debug_opened = None);
        window.render_frame(cx);
        let at = match strip {
            Some(index) => {
                let label = format!("Picture {}", index + 1);
                // Its whole bounds, for where the × sits on it, and what's
                // drawn of it, for where the pointer goes: a thumbnail
                // scrolled partly out of the strip has its middle outside.
                let found = |label: &str, window: &Window| {
                    window
                        .elements()
                        .into_iter()
                        .filter(|e| e.visible() && e.label() == Some(label))
                        .next_back()
                        .map(|e| (e.bounds(), e.visible_bounds()))
                };
                let (tile, drawn) = found(&label, &*window)
                    .ok_or_else(|| format!("no thumbnail {} over the box", index + 1))?;
                window.pointer_move(drawn.center(), None, cx);
                window.render_frame(cx);
                let (x, x_drawn) = found(REMOVE_LABEL, &*window)
                    .ok_or("no × on the thumbnail while it's hovered")?;
                let corner = Bounds::from_corners(
                    point(tile.center().x, tile.origin.y),
                    point(tile.right(), tile.center().y),
                );
                if !(corner.contains(&x.origin)
                    && corner.contains(&point(
                        x.right() - gpui_kit::px(1.),
                        x.bottom() - gpui_kit::px(1.),
                    )))
                {
                    return Err(format!("the × is at {x:?}, not in the top right corner of the thumbnail at {tile:?}"));
                }
                if remove {
                    let before = this.read(cx).chips(cx).len();
                    click(x_drawn.center(), window, cx);
                    let (after, opened) = (
                        this.read(cx).chips(cx).len(),
                        this.read(cx).debug_opened.clone(),
                    );
                    if let Some((paths, _)) = opened {
                        return Err(format!("the × opened the viewer on {paths:?}"));
                    }
                    return if after + 1 == before {
                        Ok(json!("ok removed"))
                    } else {
                        Err(format!("{before} pictures before the × and {after} after"))
                    };
                }
                // Away from the × in the corner.
                point(
                    drawn.origin.x + drawn.size.width / 4.,
                    drawn.bottom() - drawn.size.height / 4.,
                )
            }
            None => {
                let number = number.ok_or("press needs a number")?;
                let composer = this.read(cx);
                let range = composer
                    .chips(cx)
                    .get(number.saturating_sub(1))
                    .map(|(r, _)| r.clone())
                    .ok_or_else(|| format!("no chip {number}"))?;
                composer
                    .input
                    .read(cx)
                    .range_to_bounds(&range)
                    .ok_or("the chip isn't on screen")?
                    .center()
            }
        };
        click(at, window, cx);
        let (paths, index) = this.read(cx).debug_opened.clone().ok_or("nothing opened")?;
        Ok(json!(format!(
            "ok quicklook {index} of {}",
            serde_json::to_string(&paths).unwrap_or_default()
        )))
    }

    // ---- Drawing ----

    fn picture_path(&self, id: &SharedString) -> Option<PathBuf> {
        self.pictures.get(id).map(|chip| {
            chip.image
                .as_ref()
                .map_or_else(|| chip.source.clone(), |i| PathBuf::from(&i.path))
        })
    }

    /// A picture's chip among the words: a small rounded tag with the
    /// thumbnail and "Picture N" (PictureChip.draw), its sizes from the font
    /// of the words around it. Dimmed until the picture's in.
    pub(crate) fn render_chip(&self, ctx: &InlineTokenContext, cx: &App) -> AnyElement {
        let id = ctx.token().id();
        if Self::is_mention_token(id) {
            return self.render_mention_chip(ctx, cx);
        }
        let chip = self.pictures.get(id);
        let number = self.chip_numbers.get(id).copied().unwrap_or(1);
        let dimmed = chip.is_none_or(|c| c.image.is_none());
        picture_chip(self.picture_path(id), number, dimmed, ctx.is_selected(), cx)
    }

    /// The strip over the words (AttachmentStrip): a thumbnail for each
    /// picture that's in, with × on hover, and a placeholder for each still
    /// being copied in, so the strip doesn't jump when it arrives.
    fn render_strip(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let chips = self.chips(cx);
        if chips.is_empty() {
            return None;
        }
        let side = px(style::size::THUMBNAIL);
        let radius = px(8.);
        let edge = style::hairline(cx);
        // Keep later attachments reachable when the composer is narrow.
        let mut row = h_flex().flex_wrap().gap(px(STRIP_GAP)).w_full();
        for (index, (_, id)) in chips.iter().enumerate() {
            let chip = self.pictures.get(id);
            let image = chip.and_then(|c| c.image.as_ref());
            let tile = div()
                .relative()
                .size(side)
                .rounded(radius)
                .border_1()
                .border_color(edge)
                .overflow_hidden()
                .bg(style::chip_fill(cx));
            let tile = match image {
                Some(image) => tile.child(
                    img(crate::rows::markdown::file_picture(&image.path))
                        .size(side)
                        .rounded(radius)
                        .object_fit(ObjectFit::Cover),
                ),
                None if chip.is_none() => tile.flex().items_center().justify_center().child(
                    crate::icons::symbol("exclamationmark.triangle")
                        .size(px(14.))
                        .text_color(style::quiet_text(cx)),
                ),
                None => tile.flex().items_center().justify_center().child(
                    Spinner::new()
                        .color(style::quiet_text(cx))
                        .with_size(px(14.)),
                ),
            };
            let dropping = chip
                .and_then(|c| c.dropping.as_ref())
                .map(|at| crate::composer_card::first_frame(at).elapsed())
                .filter(|e| threadbear_core::juice::picture_dropping(*e));
            if dropping.is_some() {
                window.request_animation_frame();
            }
            let (remove_id, open_id) = (id.clone(), id.clone());
            let remove = remove_badge(("remove-picture", index)).on_click(cx.listener(
                move |this, _: &ClickEvent, window, cx| {
                    // Not the thumbnail's click under it, which opens the picture.
                    cx.stop_propagation();
                    this.remove_picture(remove_id.clone(), window, cx);
                },
            ));
            use gpui_kit::base::TestSupportExt as _;
            let tile = div()
                .id(("strip-tile", index))
                .test_support()
                // "Picture N", as its chip among the words says, for VoiceOver
                // and for scripts (`composer-peek` with `strip`).
                .role(Role::Button)
                .aria_label(SharedString::from(format!("Picture {}", index + 1)))
                .group("tile")
                .relative()
                // Just pasted or dropped: it comes down into its place from
                // above, a touch past and back, fading in (18 Nov).
                .when_some(dropping, |tile, since| {
                    let (fade, offset) = threadbear_core::juice::picture_drop(since);
                    tile.top(px(offset)).opacity(fade)
                })
                .cursor_pointer()
                .child(tile)
                // Over the thumbnail's top right corner, 4 in, while the
                // pointer's on it (AttachmentThumbnail's overlay). The
                // layer is placed itself: placed inside a layer that sat
                // in the flow, the × came out at the thumbnail's bottom
                // edge over the chip under it, where it couldn't be clicked
                // (Mike, 12 Nov).
                .child(
                    div()
                        .absolute()
                        .top(px(4.))
                        .right(px(4.))
                        .invisible()
                        .group_hover("tile", |s| s.visible())
                        .child(remove),
                )
                .tip(crate::viewer::TILE_TIP)
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    let input = this.input.clone();
                    this.open_picture(&input, &open_id, window, cx);
                }));
            row = row.child(tile);
        }
        // The strip's first picture: its height eases open, so the box grows
        // to take it rather than jumping. The row keeps its own height and
        // shows past the opening strip; its picture is still fading in.
        if let Some(since) = self
            .strip_opening
            .as_ref()
            .map(|at| crate::composer_card::first_frame(at).elapsed())
            .filter(|e| *e < threadbear_core::juice::STRIP_OPEN)
        {
            window.request_animation_frame();
            let open = threadbear_core::juice::strip_open(since);
            return Some(
                div()
                    .h(px(style::size::THUMBNAIL * open))
                    .child(row)
                    .into_any_element(),
            );
        }
        Some(
            div()
                .id("composer-strip")
                .w_full()
                .max_h(px(strip_max_height()))
                .overflow_y_scroll()
                .child(row)
                .into_any_element(),
        )
    }

    fn render_send_button(
        &self,
        running: bool,
        creating: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // Each state named as SendButton's are, for VoiceOver and the
        // scripts that right-click it (composer_send.rs).
        use gpui_kit::base::TestSupportExt as _;
        let can_send = self.can_send(cx);
        let side = px(style::size::SEND_BUTTON);
        let circle = || {
            div()
                .flex()
                .items_center()
                .justify_center()
                .size(side)
                .rounded_full()
        };
        if self.loading_pictures(cx) && (!running || self.has_send_content(cx)) {
            return circle()
                .id("composer-loading-picture")
                .test_support()
                .role(Role::ProgressIndicator)
                .aria_label("Loading picture")
                .bg(style::send_faint_fill(cx))
                .child(
                    Spinner::new()
                        .color(style::quiet_text(cx))
                        .with_size(px(14.)),
                )
                .tip("Loading picture")
                .into_any_element();
        }
        // The runner is making the thread: a spinner in the button's place
        // until it has, however long a busy Mac makes that (SendButton).
        if creating {
            return circle()
                .id("composer-starting")
                .test_support()
                .role(Role::ProgressIndicator)
                .aria_label("Starting the thread")
                .bg(style::send_faint_fill(cx))
                .child(
                    Spinner::new()
                        .color(style::quiet_text(cx))
                        .with_size(px(14.)),
                )
                .tip("Starting the thread")
                .into_any_element();
        }
        if running && !can_send && self.stopping.is_some() {
            return circle()
                .id("composer-stopping")
                .test_support()
                .role(Role::ProgressIndicator)
                .aria_label("Stopping")
                .bg(style::send_faint_fill(cx))
                .child(
                    Spinner::new()
                        .color(style::quiet_text(cx))
                        .with_size(px(14.)),
                )
                .tip("Stopping")
                .into_any_element();
        }
        if running && !can_send {
            let (fg, bg) = (cx.theme().background, cx.theme().foreground);
            return circle()
                .id("composer-stop")
                .test_support()
                .role(Role::Button)
                .aria_label("Stop")
                .cursor_pointer()
                .bg(bg)
                // A filled square, as the Swift app's `stop.fill` at 9 pt bold:
                // Lucide's Square is only an outline (12 Nov, Mike: "This stop
                // button doesn't look quite right").
                .child(div().size(px(9.)).rounded(px(2.)).bg(fg))
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.stop(cx)))
                .tip(if cfg!(target_os = "macos") {
                    "Stop (⌘.)"
                } else {
                    "Stop (Ctrl+.)"
                })
                // Its key to the left while ⌘ is held (key_hints.rs).
                .relative()
                .children(crate::key_hints::hint(
                    self.app.upgrade().and_then(|a| {
                        a.read(cx)
                            .shortcut_display(threadbear_core::shortcuts::ShortcutCommand::Stop)
                    }),
                    crate::key_hints::Placement::Before,
                ))
                .into_any_element();
        }
        let tip = if running {
            "Send (into this turn)"
        } else {
            "Send (Return)"
        };
        let (fg, bg) = if can_send {
            (cx.theme().background, cx.theme().foreground)
        } else {
            (style::faint_text(cx), style::send_faint_fill(cx))
        };
        circle()
            .id("composer-send")
            .test_support()
            .role(Role::Button)
            .aria_label("Send")
            .when(can_send, |s| s.cursor_pointer())
            .bg(bg)
            .child(
                self.hopping(
                    Icon::from(IconName::ArrowUp)
                        .with_size(px(14.))
                        .text_color(fg)
                        .into_any_element(),
                ),
            )
            .when(can_send, |s| {
                s.on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.send(window, cx)))
            })
            .tip(tip)
            // Dimmed with nothing to send, as SendButton's `.disabled`.
            .a11y_disabled(!can_send)
            .into_any_element()
    }

    /// The send arrow, nudging up and back once after a send: 3 points in
    /// 0.05 s and home in 0.07 (`ComposerControls`' send button).
    fn hopping(&self, arrow: AnyElement) -> AnyElement {
        let Some(at) = self
            .sent_hop
            .filter(|at| at.elapsed() < threadbear_core::juice::SEND_HOP)
        else {
            return arrow;
        };
        let length = threadbear_core::juice::SEND_HOP;
        div()
            .relative()
            .child(arrow)
            .with_animation(
                SharedString::from(format!("send-hop-{at:?}")),
                Animation::new(length),
                move |el, t| {
                    el.top(px(threadbear_core::juice::send_hop(
                        t * length.as_secs_f32(),
                    )))
                },
            )
            .into_any_element()
    }

    /// The text field, at the transcript's body size and line height so a
    /// message keeps its rhythm when it's sent (ComposerTextField).
    fn render_text_field(&self, creating: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let this = cx.entity().downgrade();
        let paste_target = this.clone();
        let hover_target = this.clone();
        let click_target = this.clone();
        let token_owner = this.clone();
        let thread_drop = this.clone();
        let file_drop = this.clone();
        let drop_target = this;
        let menu_owner = cx.entity().downgrade();
        let menu_input = self.input.clone();
        self.spelling_actions(div(), cx)
            .w_full()
            // Greyed and locked while a new thread is being made from it, or
            // while its thread moves to another machine.
            .when(creating, |s| s.opacity(0.5))
            .capture_action(cx.listener(|this, action: &Enter, window, cx| {
                if (action.shift && this.shift_return(window, cx))
                    || (!action.shift && this.palette_key(PaletteKey::Enter, window, cx))
                {
                    cx.stop_propagation();
                }
            }))
            // The palette's keys, while it's open (ComposerView.paletteKey);
            // otherwise the box has them as usual.
            .capture_action(cx.listener(|this, _: &MoveUp, window, cx| {
                if this.palette_key(PaletteKey::Up, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &MoveDown, window, cx| {
                if this.palette_key(PaletteKey::Down, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &IndentInline, window, cx| {
                if this.palette_key(PaletteKey::Tab, window, cx) {
                    cx.stop_propagation();
                }
            }))
            // Copying or cutting chips keeps what they stand for
            // (composer_inline.rs); words alone are the box's to copy.
            .capture_action(cx.listener(|this, _: &Copy, window, cx| {
                if this.copy_chips(false, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &Cut, window, cx| {
                if this.copy_chips(true, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &Escape, window, cx| {
                if this.palette_key(PaletteKey::Escape, window, cx) {
                    cx.stop_propagation();
                } else if this.editing.as_ref().is_some_and(|e| !e.sending) {
                    // Esc while editing a message leaves the edit.
                    this.cancel_editing(window, cx);
                    cx.stop_propagation();
                }
            }))
            .on_drop(move |paths: &ExternalPaths, window, cx| {
                if let Some(this) = drop_target.upgrade() {
                    // Where it's let go, over the words (`performDragOperation`).
                    let at = window.mouse_position();
                    this.update(cx, |this, cx| {
                        let target = this.input.clone();
                        this.caret_to_drop(&target, at, cx);
                        this.take_drop_in(&target, paths.paths().to_vec(), window, cx);
                    });
                }
            })
            .on_drop(
                move |drag: &crate::composer_inline::DraggedThread, window, cx| {
                    if let Some(this) = thread_drop.upgrade() {
                        let at = window.mouse_position();
                        this.update(cx, |this, cx| this.take_thread_drop(drag, at, window, cx));
                    }
                },
            )
            // A file or picture dragged from inside the app (file_drag.rs).
            .on_drop(move |file: &crate::file_drag::DraggedFile, window, cx| {
                if let (Some(this), Some(real)) = (file_drop.upgrade(), file.still_grabbed()) {
                    let at = window.mouse_position();
                    this.update(cx, |this, cx| {
                        let target = this.input.clone();
                        this.caret_to_drop(&target, at, cx);
                        this.take_paths(vec![real], window, cx);
                    });
                }
            })
            .child(
                bare_textarea(Textarea::new(&self.input))
                    .disabled(creating)
                    // NSTextView's right-click menu: spelling, then Cut, Copy and
                    // Paste, then Spelling and Grammar to Speech.
                    .context_menu(move |_, window, cx| {
                        crate::composer_spelling::context_menu(&menu_owner, &menu_input, window, cx)
                    })
                    .text_size(px(style::size::COMPOSER))
                    .line_height(px(style::size::BODY_LINE))
                    .token(move |ctx, _window, cx| match token_owner.upgrade() {
                        Some(this) => this.read(cx).render_chip(ctx, cx),
                        None => div().into_any_element(),
                    })
                    .on_paste(move |item, window, cx| {
                        paste_target.upgrade().is_some_and(|this| {
                            this.update(cx, |this, cx| this.take_clipboard(item, window, cx))
                        })
                    })
                    .on_token_hover(move |event, _window, cx| {
                        if let Some(this) = hover_target.upgrade() {
                            this.update(cx, |this, cx| this.hover_chip(event, cx));
                        }
                    })
                    // A plain click on a picture's chip opens it (the kit
                    // only calls this for one, a press and a let go on the
                    // same chip; a drag from it or a Shift-click selects).
                    // A card's or thread's chip has no picture, so nothing.
                    .on_token_click(move |event, window, cx| {
                        if let Some(this) = click_target.upgrade() {
                            this.update(cx, |this, cx| {
                                if this.open_file_chip(event.token().id(), cx) {
                                    return;
                                }
                                let input = this.input.clone();
                                this.open_picture(&input, event.token().id(), window, cx);
                            });
                        }
                    }),
            )
    }

    /// The card over a chip while the pointer rests on it: the picture, to
    /// tell which is which (LinkPeekCard with pictureOnly).
    fn render_peek(&self, cx: &App) -> Option<AnyElement> {
        let (id, bounds) = self.peek_shown.as_ref()?;
        let path = self.picture_path(id)?;
        Some(
            deferred(
                anchored()
                    .position(bounds.origin)
                    .anchor(Anchor::BottomLeft)
                    .snap_to_window()
                    .offset(point(px(0.), px(-8.)))
                    .child(
                        div()
                            .p(px(4.))
                            .rounded(px(10.))
                            .bg(cx.theme().popover)
                            .border_1()
                            .border_color(style::hairline(cx))
                            .shadow_lg()
                            .child(
                                img(crate::rows::markdown::file_picture(&path.to_string_lossy()))
                                    .max_w(px(320.))
                                    .max_h(px(240.))
                                    .rounded(px(6.)),
                            ),
                    ),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }
}

impl Render for Composer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The box as it was before an edit that's just gone, first: it
        // replaces what's there, so anything given back goes after it.
        if let Some((text, images)) = self.pending_box.take() {
            self.set_box(text, images, window, cx);
        }
        if let Some(saved) = self.pending_saved.take() {
            self.restore_box(saved, window, cx);
        }
        // While an older message is being edited, what's given back waits
        // for the edit to end, rather than join it and go with it, or be
        // lost with it on Cancel (Codex's review, 12 Nov).
        if self.editing.is_none() {
            if let Some(restore) = self.restore.take() {
                self.apply_restore(restore, window, cx);
            }
        }
        self.renumber_chips(cx);
        // With answers picked the box is for anything else; under asks with
        // none picked it's the way to answer in other words.
        let moving = self.moving_line(cx);
        let placeholder: SharedString = match &moving {
            Some(line) => line.clone().into(),
            None if self.editing.is_some() => "Your message…".into(),
            None => self.card_placeholder(cx).into(),
        };
        if self.shown_placeholder != placeholder {
            self.shown_placeholder = placeholder.clone();
            self.input
                .update(cx, |s, cx| s.set_placeholder(placeholder, window, cx));
        }
        let running = self.pane().is_some_and(|p| p.read(cx).summary.busy());
        if !running || !threadbear_core::composer::still_stopping(self.stopping, crate::now_ms()) {
            self.stopping = None;
        }
        let strip = self.render_strip(window, cx);
        let creating = self.creating(cx);
        // Typing, answering and sending wait while the thread moves.
        let locked = creating || moving.is_some();
        let send_button = self.render_send_button(running, creating, cx);
        // Right-click it to send the message later (composer_send.rs).
        let send_button = self.with_send_menu(send_button, cx);
        let controls = self.render_controls(send_button, window, cx);
        // The box: the limit box and the open card, each over a line, then
        // the message.
        let limit = self.render_limit_box(window, cx);
        // A thread on a virtual runner whose login needs a cloud token
        // (token_card.rs), in the same place.
        let token_card = self.render_token_card(window, cx);
        // An edit is a message of its own: the open card waits for after it.
        let card = if self.editing.is_some() {
            None
        } else {
            self.render_card(window, cx)
        };
        // Dimmed while the thread moves, with nothing on it taking a click.
        let card = card.map(|card| match &moving {
            Some(line) => div()
                .relative()
                .child(div().opacity(0.5).child(card))
                .child(
                    div()
                        .id("composer-card-moving")
                        .absolute()
                        .inset_0()
                        .occlude()
                        .tip(line.clone()),
                )
                .into_any_element(),
            None => card,
        });
        let editing_banner = self.render_editing_banner(cx);
        // With the card folded, its picks as chips over the words, so they
        // don't go with no sign of them (composer_answers.rs).
        let answer_chips = self.render_answer_chips(cx);
        // Drafts he's changed in this thread's replies, which go with the
        // message: a chip each, so it's plain they do (composer_drafts.rs).
        let draft_chips = self.render_draft_chips(cx);
        let needs_you = self.open_card(cx).is_some_and(|c| !c.is_done());
        // The slash palette, on the box's top edge, or else the # thread
        // picker, on the text's (thread_palette.rs).
        let palette = self.render_palette(window, cx);
        let thread_picker = if palette.is_none() {
            self.render_thread_picker(window, cx)
        } else {
            None
        };
        let width = self.card_width.clone();
        let top = self.box_top.clone();
        // The folder's actions, on shelves on the box's top edge, in from its
        // rounded corner (ActionChips), as wide as the box leaves them.
        let shelves = self.pane().and_then(|pane| {
            let summary = pane.read(cx).summary.clone();
            let icons = self
                .app
                .upgrade()
                .map(|a| a.read(cx).sidebar.project_icons.clone())
                .unwrap_or_default();
            let room = (self.card_width.get() - style::zoomed(style::COMPOSER_RADIUS) * 2.).max(0.);
            crate::viewer::action_chips(&summary, room, &icons, window, cx)
        });
        // Claude refused the last turn: the offer to carry on with Codex,
        // just above the box (RefusalOffer).
        let refusal = match (&self.thread_id, self.app.upgrade()) {
            (Some(id), Some(app)) => crate::app::Threadbear::refusal_offer(&app, id, cx),
            _ => None,
        };
        let body = v_flex()
            .w_full()
            .gap(px(style::COMPOSER_GAP))
            .p(px(style::COMPOSER_PADDING))
            .children(editing_banner)
            .children(answer_chips)
            .children(draft_chips)
            .when_some(strip, |s, strip| s.child(strip))
            // The # picker hangs off the text, not the box's top: with a
            // card or chips over the text it sat a card's height away from
            // the # it was typed at (Mike, 24 Nov).
            .child(
                div()
                    .relative()
                    .w_full()
                    .child(self.render_text_field(locked, cx))
                    .children(thread_picker),
            )
            .child(controls);
        // The transcript's reading column: 780 wide at most, centred, with
        // the same side insets once the window is narrower.
        h_flex()
            // Capture above the message and the card's answer boxes: a
            // HEIC-only pasteboard can be empty to GPUI's textarea handler.
            .capture_action(
                cx.listener(|this, _: &gpui_kit::base::input::Paste, window, cx| {
                    if this.take_native_paste(window, cx) {
                        cx.stop_propagation();
                    }
                }),
            )
            .w_full()
            .justify_center()
            .px(px(style::SIDE_INSET))
            .pt(px(4.))
            .pb(px(20.))
            .child(
                v_flex()
                    .w_full()
                    .max_w(px(style::MAX_CONTENT_WIDTH))
                    .children(refusal)
                    // Overlapping the box's border, so the two read as one piece.
                    // The chips themselves measured for the tour's Patches step.
                    .when_some(shelves, |s, shelves| {
                        s.child(
                            div()
                                .px(px(style::COMPOSER_RADIUS))
                                .mb(gpui_kit::px(-0.5))
                                .child(h_flex().child(
                                    div().relative().flex_none().child(shelves).children(
                                        crate::tour::mark(
                                            threadbear_core::tour::Target::ActionChips,
                                        ),
                                    ),
                                )),
                        )
                    })
                    .child(
                        div()
                            .relative()
                            .w_full()
                            .rounded(px(style::COMPOSER_RADIUS))
                            .bg(style::composer_fill(cx))
                            .when(!cx.theme().is_dark(), |s| s.shadow_md())
                            // The edge, drawn over the box rather than taking room in
                            // it, as the Swift card's strokeBorder is: what's inside
                            // sits its 14 in from the box's own edge, and the needs-you
                            // edge (1 pt in the accent, otherwise a 0.5 hairline)
                            // moves nothing. First, so the rest draws over it.
                            .child(
                                div()
                                    .absolute()
                                    .inset_0()
                                    .rounded(px(style::COMPOSER_RADIUS))
                                    .border(px(if needs_you { 1. } else { 0.5 }))
                                    .border_color(if needs_you {
                                        style::accent(cx)
                                    } else {
                                        style::hairline(cx)
                                    }),
                            )
                            // Clicking anywhere in the box off the words (its padding,
                            // the gap over the controls, beside them) puts the cursor
                            // in the text. Claimed, or the page or pane behind it,
                            // which tracks a focus of its own, takes the focus back
                            // on the same press: GPUI focuses every focusable under a
                            // press that hasn't had prevent_default. Only the words'
                            // own rows took a click (ADEMark, 19 Nov). A control in
                            // the box still gets its click, on the let go.
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                                    if window.default_prevented() {
                                        return;
                                    }
                                    this.focus(window, cx);
                                    crate::web_panels::keyboard_to_app(window);
                                    window.prevent_default();
                                }),
                            )
                            .children(token_card)
                            .children(limit)
                            .children(card)
                            .child(body)
                            // Measures the box for the palette, which sits on its top
                            // edge, and for the shelves, which get as many chips as fit.
                            .child(
                                canvas(
                                    move |bounds, window, _| {
                                        width.set(f32::from(bounds.size.width));
                                        // A box that moved draws again, so an open palette
                                        // fits the room it has now. On the next frame: GPUI
                                        // drops a refresh asked for while it's drawing.
                                        let moved =
                                            (top.get() - f32::from(bounds.top())).abs() > 0.5;
                                        top.set(f32::from(bounds.top()));
                                        if moved {
                                            window.request_animation_frame();
                                        }
                                    },
                                    |_, _, _, _| {},
                                )
                                // Pinned to the box's corner. Absolute with no inset, it
                                // sits where it would in the flow, after the words, so it
                                // took the box's bottom for its top: the palette thought
                                // it had a box's height more room over it than it did,
                                // and ran off the top of the new-thread page.
                                .absolute()
                                .inset_0()
                                .size_full(),
                            )
                            .children(palette)
                            // The main panel's box, for the tour's first thread.
                            .children(crate::tour::mark_composer(self.thread_id.as_deref())),
                    ),
            )
            .children(self.render_peek(cx))
    }
}

/// A text box with no frame and none of the kit's padding inside it, so its
/// text starts where the box does, as an NSTextView with no inset and no
/// line fragment padding does (ComposerTextField, the Something else box).
/// The kit's smallest size still pads 4 either side (its own 4, whatever the
/// text size), so the box reaches 4 out past each side to put the text back
/// on the edge.
pub(crate) fn bare_textarea(textarea: Textarea) -> Textarea {
    textarea
        .appearance(false)
        .bordered(false)
        .xsmall()
        .mx(gpui_kit::px(-4.))
}

/// The × over a thumbnail of the box's pictures (AttachmentThumbnail's
/// remove button): 18 round, black at 0.72 with a faint white edge.
pub(crate) fn remove_badge(
    id: impl Into<ElementId>,
) -> impl StatefulInteractiveElement + ParentElement + IntoElement {
    use gpui_kit::base::TestSupportExt as _;
    div()
        .id(id)
        .test_support()
        .role(Role::Button)
        .aria_label(REMOVE_LABEL)
        .size(px(18.))
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .bg(hsla(0., 0., 0., 0.72))
        .border(gpui_kit::px(0.5))
        .border_color(hsla(0., 0., 1., 0.2))
        .cursor_pointer()
        .child(
            Icon::from(IconName::X)
                .with_size(px(9.))
                .text_color(gpui_kit::white()),
        )
        .tip("Remove")
}

/// A picture's chip among the words, here and in the review window's reply
/// (review_window/reply_pictures.rs): a small rounded tag with the thumbnail
/// and "Picture N" (PictureChip.draw), dimmed until the picture's in.
pub(crate) fn picture_chip(
    path: Option<PathBuf>,
    number: usize,
    dimmed: bool,
    selected: bool,
    cx: &App,
) -> AnyElement {
    let fill = style::chip_fill(cx);
    let edge = if selected {
        style::accent(cx)
    } else {
        style::hairline(cx)
    };
    let label_color = if dimmed {
        style::faint_text(cx)
    } else {
        style::quiet_text(cx)
    };
    h_flex()
        .h_full()
        .items_center()
        .child(
            h_flex()
                .h(px(style::size::CHIP_HEIGHT))
                // PictureChip.draw strokes half a point inside its 3 and
                // 7; here the edge takes room, so the padding gives it back.
                .pl(px(2.5))
                .pr(px(6.5))
                .gap(px(5.))
                .rounded(px(6.))
                .bg(fill)
                .border(gpui_kit::px(0.5))
                .border_color(edge)
                // A click opens the picture (`open_picture`).
                .when(path.is_some(), |s| s.cursor_pointer())
                .when_some(path, |s, path| {
                    s.child(
                        img(crate::rows::markdown::file_picture(&path.to_string_lossy()))
                            .size(px(14.))
                            .rounded(px(3.))
                            .object_fit(ObjectFit::Cover)
                            .when(dimmed, |s| s.opacity(0.5)),
                    )
                })
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(label_color)
                        .child(format!("Picture {number}")),
                ),
        )
        .into_any_element()
}

const STRIP_GAP: f32 = 8.;
const STRIP_ROWS: f32 = 3.;

/// Cap the pictures at three rows so the message stays in view.
pub(crate) fn strip_max_height() -> f32 {
    STRIP_ROWS * style::size::THUMBNAIL + (STRIP_ROWS - 1.) * STRIP_GAP
}

/// The ×'s name for VoiceOver (the Swift one's accessibilityLabel), and for
/// `composer-peek` to find it by.
pub(crate) const REMOVE_LABEL: &str = "Remove image";

/// The token a chip draws from. The token's text is the mark the draft holds
/// (InlinePictures.mark); its label is only for accessibility and measuring.
pub(crate) fn picture_token(id: &SharedString) -> InlineToken {
    InlineToken::new(id.clone(), PICTURE_MARK_STR).with_label("Picture")
}

/// Whether a dropped or pasted file is a picture, by its name
/// (ComposerTextView.isImage asks the file's type; a name is what every
/// system can tell).
pub(crate) fn is_picture(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "heif" | "tif" | "tiff" | "bmp")
    )
}

/// Whether a picked file is Markdown, which "+" takes besides pictures. It
/// goes in as its path, as a dropped document does, for the agent to read.
pub(crate) fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "markdown")
    )
}

/// A picture pasted as raw image data (a screenshot on the clipboard, say),
/// saved to a file the runner can import, as ComposerTextView.takeImages does.
/// PNG and JPEG go as they are; the runner turns TIFF and BMP into PNG
/// (`media.import`). An SVG stays out: the runner doesn't take them.
pub(crate) fn save_pasted_image(image: &gpui_kit::Image) -> Option<PathBuf> {
    let ext = match image.format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::Webp => "webp",
        ImageFormat::Gif => "gif",
        ImageFormat::Bmp => "bmp",
        ImageFormat::Tiff => "tiff",
        _ => return None,
    };
    stage_private(
        &paste_base(),
        &format!("pasted-{:x}.{ext}", image.id),
        &image.bytes,
    )
}

pub(crate) fn keep_picture(path: PathBuf) -> PathBuf {
    if !is_picture(&path) || is_staged(&path) || !transient_picture(&path) {
        return path;
    }
    capture_picture(&path).unwrap_or(path)
}

/// Read with this app's grant, rather than testing access(2) or making the
/// runner open the original. APFS clones keep the original bytes cheaply;
/// other filesystems copy at most the runner's supported 100 MB.
pub(crate) fn capture_picture(path: &Path) -> Option<PathBuf> {
    let file = threadbear_core::open_policy::local_open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    snapshot_picture(&file, path).ok()
}

pub(crate) fn snapshot_picture(file: &std::fs::File, path: &Path) -> std::io::Result<PathBuf> {
    let folder = private_folder(&paste_base())
        .ok_or_else(|| std::io::Error::other("Couldn't prepare a private picture folder"))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| std::io::Error::other("The picture has no filename"))?;
    let kept =
        threadbear_core::private_file::snapshot(file, folder.path(), name, 100 * 1024 * 1024)?;
    STAGED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push((kept.clone(), folder.keep()));
    Ok(kept)
}

pub(crate) fn transient_picture(path: &Path) -> bool {
    path.starts_with(std::env::temp_dir())
        || path.starts_with("/var/folders")
        || path.starts_with("/private/var/folders")
        || path
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains(".photoslibrary/")
}

pub(crate) fn is_staged(path: &Path) -> bool {
    STAGED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|(owned, _)| owned == path)
}

/// An asynchronous source mustn't recreate its folder after an import timed
/// out and removed it. Serialize its write with unstage's ownership check.
pub(crate) fn write_staged(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let staged = STAGED.lock().unwrap_or_else(|e| e.into_inner());
    if !staged.iter().any(|(owned, _)| owned == path) {
        return Err(std::io::Error::other(
            "The picture is no longer being imported",
        ));
    }
    threadbear_core::private_file::write(path, bytes)
}

/// Where pasted pictures wait for the runner: the session's own runtime
/// folder on Linux (`XDG_RUNTIME_DIR`, which only this user can open), else
/// the temp folder (already this user's own on a Mac and Windows; `/tmp` on
/// a Linux without one, which everyone can list).
pub(crate) fn paste_base() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|d| d.is_absolute() && d.is_dir())
        .unwrap_or_else(std::env::temp_dir)
}

/// Writes `bytes` as `name` in a folder of its own under `base`: made fresh
/// with a random name and 0700, the file new with 0600, so on a shared
/// `/tmp` nobody else can read it, list it, or make the folder first and
/// have it written into theirs (Daybreak, 10 Nov 2026, finding 63). The
/// folder goes once the runner has its own copy (`import_picture`).
pub(crate) fn stage_private(base: &std::path::Path, name: &str, bytes: &[u8]) -> Option<PathBuf> {
    // Never let a clipboard-supplied name escape its fresh private folder.
    if Path::new(name).file_name().and_then(|n| n.to_str()) != Some(name) {
        return None;
    }
    let folder = private_folder(base)?.keep();
    let path = folder.join(name);
    let written = threadbear_core::private_file::write(&path, bytes);
    if written.is_err() {
        let _ = std::fs::remove_dir_all(&folder);
        return None;
    }
    STAGED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push((path.clone(), folder));
    Some(path)
}

pub(crate) fn private_folder(base: &Path) -> Option<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("threadbear-paste-");
    // Without a mode the folder would take the umask's (0755 under 022).
    // Windows has none: a folder there takes the user's temp folder's access.
    #[cfg(unix)]
    builder.permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700));
    builder.tempdir_in(base).ok()
}

/// The folders `stage_private` made and hasn't removed: only these are
/// ever deleted, never a folder that just has the same kind of name (Codex
/// review, 10 Nov 2026: a picture dropped from `/tmp/threadbear-paste-x/`
/// would have taken that whole folder with it).
static STAGED: std::sync::Mutex<Vec<(PathBuf, PathBuf)>> = std::sync::Mutex::new(Vec::new());

/// A staged picture's folder, once the runner has copied it (or couldn't).
/// A dropped or pasted file's own folder is never touched.
pub(crate) fn unstage(path: &std::path::Path) {
    let mut staged = STAGED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(at) = staged.iter().position(|(owned, _)| owned == path) {
        let (_, folder) = staged.remove(at);
        drop(staged);
        let _ = std::fs::remove_dir_all(folder);
    }
}

/// The JSON a picture goes as (`ImageRef` in docs/protocol.md).
pub fn image_ref_json(image: &ImageRef) -> Value {
    let mut out = json!({ "path": image.path, "mediaType": image.media_type });
    if let Some(w) = image.width {
        out["width"] = json!(w);
    }
    if let Some(h) = image.height {
        out["height"] = json!(h);
    }
    out
}

#[cfg(test)]
mod paste_tests {
    use super::{keep_picture, stage_private, unstage, write_staged};
    use std::fs;

    #[test]
    fn a_screenshot_is_owned_before_the_drop_returns() {
        let source = tempfile::tempdir().unwrap();
        let original = source.path().join("Screenshot.png");
        fs::write(&original, b"screenshot").unwrap();
        let kept = keep_picture(original.clone());
        fs::remove_file(&original).unwrap(); // macOS ends the drag
        assert_eq!(fs::read(&kept).unwrap(), b"screenshot"); // runner reads later
        unstage(&kept);
        assert!(source.path().exists());
    }

    #[test]
    fn a_supported_large_screenshot_is_kept_too() {
        let source = tempfile::tempdir().unwrap();
        let original = source.path().join("large.png");
        fs::File::create(&original)
            .unwrap()
            .set_len(26 * 1024 * 1024)
            .unwrap();
        let kept = keep_picture(original.clone());
        fs::remove_file(original).unwrap();
        assert_eq!(fs::metadata(&kept).unwrap().len(), 26 * 1024 * 1024);
        unstage(&kept);
    }

    #[test]
    fn a_late_promise_cannot_recreate_a_removed_staging_folder() {
        let base = tempfile::tempdir().unwrap();
        let path = stage_private(base.path(), "promised.png", b"").unwrap();
        unstage(&path);
        assert!(write_staged(&path, b"late photo").is_err());
        assert!(!path.parent().unwrap().exists());
    }

    #[test]
    fn clipboard_names_cannot_escape_the_private_folder() {
        let base = tempfile::tempdir().unwrap();
        assert!(stage_private(base.path(), "../photo.png", b"private").is_none());
        assert!(stage_private(base.path(), "/photo.png", b"private").is_none());
        assert_eq!(fs::read_dir(base.path()).unwrap().count(), 0);
    }

    /// Finding 63: under umask 022 the old folder was 0755 and the file
    /// 0644, in a fixed `/tmp/threadbear-paste` anyone could list or make
    /// first. Each paste now gets a fresh folder only its owner can open.
    #[cfg(unix)]
    #[test]
    fn a_pasted_picture_is_kept_private() {
        use std::os::unix::fs::PermissionsExt;
        let base = tempfile::tempdir().unwrap();
        let path = stage_private(base.path(), "pasted-1.png", b"png bytes").unwrap();
        let folder = path.parent().unwrap();
        assert_eq!(
            fs::metadata(folder).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(fs::read(&path).unwrap(), b"png bytes");
        // Not a name anyone can guess: the same picture twice goes to two folders.
        let again = stage_private(base.path(), "pasted-1.png", b"png bytes").unwrap();
        assert_ne!(again.parent(), path.parent());
        assert!(
            folder.file_name().unwrap().to_string_lossy().len() > "threadbear-paste-".len() + 4
        );
    }

    /// A folder someone else made first, under the old fixed name, is never
    /// written into.
    #[test]
    fn a_folder_made_first_isnt_used() {
        let base = tempfile::tempdir().unwrap();
        let planted = base.path().join("threadbear-paste");
        fs::create_dir(&planted).unwrap();
        let path = stage_private(base.path(), "pasted-2.png", b"x").unwrap();
        assert!(!path.starts_with(&planted));
        assert_eq!(fs::read_dir(&planted).unwrap().count(), 0);
    }

    /// Once the runner has its copy, the staged folder goes, and only a
    /// folder this made: a dropped file's own folder stays, even one with
    /// the same kind of name.
    #[test]
    fn the_staged_copy_goes_after_the_import() {
        let base = tempfile::tempdir().unwrap();
        let path = stage_private(base.path(), "pasted-3.png", b"x").unwrap();
        let folder = path.parent().unwrap().to_owned();
        unstage(&path);
        assert!(!folder.exists());
        for name in ["Desktop", "threadbear-paste-project"] {
            let dropped_dir = base.path().join(name);
            fs::create_dir(&dropped_dir).unwrap();
            fs::write(dropped_dir.join("other.txt"), b"keep").unwrap();
            let dropped = dropped_dir.join("shot.png");
            fs::write(&dropped, b"x").unwrap();
            unstage(&dropped);
            assert!(
                dropped.exists() && dropped_dir.join("other.txt").exists(),
                "{name}"
            );
        }
    }
}
