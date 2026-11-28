// Another lab's review as a row over the turn's reply (RowRenderer.reviewText):
// a quiet line saying who reviewed and how it came out, then each finding with
// what the agent did about it (fixed, disputed and why, left for Mike, or no
// answer), where, and, when a panel reviewed together, who found it. It was on
// the done card until 12 Nov 2026; Mike moved it into the transcript, as the
// review runs in the background and needn't draw his eye. Since 20 Nov it
// folds as the line of work does: a panel's eight answered findings ran a
// screen tall over a reply that already said what was fixed. Since 28 Nov it's
// the heading alone until clicked, open findings too: nine unanswered ones ran
// a screen tall the same way (LabReview::shown_findings). The ledger
// is `turn.completed`'s `review` (docs/protocol/needs-you.md, "Review by another lab").
use super::metrics::{ROW_BOTTOM, TITLE_INDENT};
use super::row_wrap;
use super::work::{work_line, Runs};
use crate::style::{self, size};
use crate::thread::ThreadPane;
use gpui_kit::assets::IconName;
use gpui_kit::component::{h_flex, v_flex, Icon, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::style::px;
use crate::tips::Tip as _;
use threadbear_core::reducer::{LabReview, ReviewFinding, Row};

/// A finding's mark (SF's checkmark.circle, exclamationmark.bubble,
/// person.crop.circle and circle, as Lucide draws them), its word and its
/// colour, by what was done about it.
pub(super) fn outcome(finding: &ReviewFinding, cx: &App) -> (IconName, &'static str, Hsla) {
    match finding.outcome.as_deref() {
        Some("fixed") => (IconName::CircleCheck, "Fixed", style::tick_green(cx)),
        Some("disputed") => (
            IconName::MessageSquareWarning,
            "Disputed",
            style::needs_you(cx),
        ),
        Some("left") => (IconName::CircleUser, "Left for you", style::accent(cx)),
        _ => (IconName::Circle, "No answer", style::faint_text(cx)),
    }
}

/// The line under a finding: what was done, the agent's note, how serious,
/// where, and who found it when a panel reviewed (LabReview::found_by).
fn finding_detail(finding: &ReviewFinding, word: &str, by: Option<String>) -> String {
    let mut detail = word.to_owned();
    if let Some(note) = finding.note.as_deref().filter(|n| !n.is_empty()) {
        detail.push_str(&format!(": {note}"));
    }
    if finding.severity == "high" {
        detail.push_str(" · serious");
    }
    if let Some(place) = finding.where_.as_deref().filter(|w| !w.is_empty()) {
        detail.push_str(&format!(" · {place}"));
    }
    if let Some(by) = by {
        detail.push_str(&format!(" · found by {by}"));
    }
    detail
}

impl ThreadPane {
    /// The ledger's row: a work line with the heading and its chevron, once
    /// open the findings under it small and quiet and a last line to the
    /// review's thread. A review with no findings doesn't open, so its line
    /// goes straight to the review's thread, as it always did.
    pub(crate) fn lab_review_row(
        &mut self,
        ix: usize,
        row: &Row,
        review: &LabReview,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (quiet, secondary) = (style::quiet_text(cx), style::secondary_label(cx));
        let folds = review.folds();
        let open = folds && self.row_open(row);
        let thread = review.thread_id.clone();
        let row_id = row.id.clone();
        let to_thread = (!thread.is_empty()).then(|| {
            Box::new(cx.listener(move |this, _: &ClickEvent, window, cx| {
                this.link_clicked(&format!("thread:{thread}"), &row_id, window, cx);
            })) as Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>
        });
        let runs: Runs = vec![(review.heading(), quiet)];
        let mut line = if folds {
            let tip = if open {
                "Hide the findings"
            } else {
                "Show every finding"
            };
            let toggle = self.toggle_listener(row, cx);
            work_line(
                ("lab-review", ix).into(),
                "checklist",
                style::faint_icon(cx),
                &runs,
                None,
                Some(open),
                Some(tip),
                cx,
                Some(toggle),
            )
        } else {
            let tip = to_thread.is_some().then_some("Open the review's thread");
            work_line(
                ("lab-review", ix).into(),
                "checklist",
                style::faint_icon(cx),
                &runs,
                None,
                None,
                tip,
                cx,
                None,
            )
        };
        if !folds {
            if let Some(click) = to_thread {
                let hover = style::hover_fill(cx);
                line = line
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .on_click(move |e, window, cx| click(e, window, cx));
            }
        }
        let shown = review.shown_findings(open);
        let mut column = v_flex()
            .w_full()
            .child(line)
            .when(!shown.is_empty(), |c| c.pb(px(ROW_BOTTOM)));
        for finding in shown {
            let (symbol, word, color) = outcome(finding, cx);
            column = column.child(
                h_flex()
                    .w_full()
                    .items_start()
                    .mt(px(4.))
                    .child(
                        div()
                            .flex_none()
                            .w(px(TITLE_INDENT))
                            .h(px(19.))
                            .flex()
                            .items_center()
                            .child(Icon::from(symbol).with_size(px(13.)).text_color(color)),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_size(px(size::SMALL))
                                    .line_height(px(19.))
                                    .text_color(secondary)
                                    .child(finding.claim.clone()),
                            )
                            .child(
                                div()
                                    .text_size(px(size::SMALL))
                                    .line_height(px(17.))
                                    .text_color(quiet)
                                    .child(finding_detail(finding, word, review.found_by(finding))),
                            ),
                    ),
            );
        }
        if open && !review.thread_id.is_empty() {
            let (thread, row_id) = (review.thread_id.clone(), row.id.clone());
            column = column.child(
                div()
                    .id(("lab-review-thread", ix))
                    .role(Role::Button)
                    .aria_label("Open the review's thread")
                    .mt(px(6.))
                    .ml(px(TITLE_INDENT))
                    .text_size(px(size::SMALL))
                    .line_height(px(19.))
                    .text_color(quiet)
                    .cursor_pointer()
                    .hover(move |s| s.text_color(secondary))
                    .tip("Open the review's thread")
                    .child("Open the review's thread")
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        this.link_clicked(&format!("thread:{thread}"), &row_id, window, cx);
                    })),
            );
        }
        row_wrap(row, column)
    }
}
