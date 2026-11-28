// The runner's message that brings another lab's review back, as a checklist
// (threadbear_core's review_note.rs reads it). It was a centred note of the
// whole message: the findings twice, raw markdown and the instructions for
// the agent. Mike picked this look on 25 Nov 2026: a quiet rule down the
// left, a line per finding (number, how serious, where, the claim), its case
// and the agent's note on a click, and once the agent has answered, what it
// did about each on the right (from the turn's ledger, as lab_review.rs).
// The reviewer's own reply is folded under "Full reply".
use super::lab_review::outcome;
use super::metrics::{ROW_BOTTOM, RUNNER_BOTTOM, RUNNER_TOP};
use super::row_wrap;
use crate::style::{self, size};
use crate::thread::ThreadPane;
use crate::tips::Tip as _;
use gpui_kit::base::SelectableText as _;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Icon, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::style::px;
use threadbear_core::reducer::review_note::short_place;
use threadbear_core::reducer::{LabReview, ReviewFinding, ReviewNote, Row};

/// How serious, as a dot: only a serious one is loud.
fn severity_colour(severity: &str, cx: &App) -> Hsla {
    match severity {
        "high" => style::status_failed(cx),
        "medium" => style::status_warning(cx),
        _ => style::faint_icon(cx),
    }
}

/// "2 fixed · 1 disputed" for the heading, once the agent has answered.
fn tally(findings: &[ReviewFinding]) -> Option<String> {
    let count = |word: &str| {
        findings
            .iter()
            .filter(|f| f.outcome.as_deref() == Some(word))
            .count()
    };
    let parts: Vec<String> = [
        ("fixed", "fixed"),
        ("disputed", "disputed"),
        ("left", "left for you"),
    ]
    .iter()
    .map(|(key, word)| (count(key), word))
    .filter(|(n, _)| *n > 0)
    .map(|(n, word)| format!("{n} {word}"))
    .collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn part_id(ix: usize, part: &str) -> ElementId {
    ElementId::Name(format!("review-note-{ix}-{part}").into())
}

impl ThreadPane {
    pub(crate) fn review_note_row(
        &mut self,
        ix: usize,
        row: &Row,
        note: &ReviewNote,
        ledger: Option<&LabReview>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (faint, quiet) = (style::faint_text(cx), style::quiet_text(cx));
        let (hover, secondary) = (style::hover_fill(cx), style::secondary_label(cx));
        // Each finding with what the agent did about it, when it has said.
        let findings: Vec<ReviewFinding> = note
            .findings
            .iter()
            .map(|f| {
                ledger
                    .and_then(|l| l.findings.iter().find(|g| g.id == f.id))
                    .map_or_else(
                        || f.clone(),
                        |answered| ReviewFinding {
                            outcome: answered.outcome.clone(),
                            note: answered.note.clone(),
                            ..f.clone()
                        },
                    )
            })
            .collect();
        let reply_key = format!("{}#reply", row.id);
        let reply_open = self.open_rows.contains(&reply_key);

        let mut header = h_flex()
            .w_full()
            .min_h(px(19.))
            .gap(px(6.))
            .items_center()
            .text_size(px(size::SMALL))
            .line_height(px(17.))
            .text_color(faint)
            .child(div().flex_none().child(note.heading()));
        for (n, id) in note.thread_ids.iter().enumerate() {
            let (thread, row_id) = (id.clone(), row.id.clone());
            header = header.child(
                div()
                    .id(part_id(ix, &format!("thread-{n}")))
                    .role(Role::Link)
                    .aria_label("Open the review's thread")
                    .flex_none()
                    .px(px(5.))
                    .rounded(px(4.))
                    .bg(style::chip_fill(cx))
                    .text_color(quiet)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .tip("Open the review's thread")
                    .child(id.clone())
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        this.link_clicked(&format!("thread:{thread}"), &row_id, window, cx);
                    })),
            );
        }
        header = header.child(div().flex_1());
        if let Some(tally) = tally(&findings) {
            let all_fixed = findings
                .iter()
                .all(|f| f.outcome.as_deref() == Some("fixed"));
            header = header.child(
                div()
                    .flex_none()
                    .text_color(if all_fixed {
                        style::tick_green(cx)
                    } else {
                        quiet
                    })
                    .child(tally),
            );
        }
        if !note.reply.is_empty() {
            let (key, row_id) = (reply_key, row.id.clone());
            let label = if reply_open {
                "Hide reply"
            } else {
                "Full reply ›"
            };
            header = header.child(
                div()
                    .id(part_id(ix, "reply"))
                    .role(Role::Button)
                    .aria_label(label)
                    .flex_none()
                    .text_color(quiet)
                    .cursor_pointer()
                    .hover(move |s| s.text_color(secondary))
                    .child(label)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.toggle_part(&key, &row_id, cx);
                    })),
            );
        }

        let mut column = v_flex().w_full().child(header);
        for finding in &findings {
            column = column.child(self.review_finding_line(
                ix,
                row,
                note,
                finding,
                ledger.is_some(),
                cx,
            ));
        }
        if reply_open {
            let key = format!("review-note-{}", row.id);
            let body = self.with_thread_chips(note.reply.clone(), cx);
            let body = self.with_link_marks(body, cx);
            let doc = self.markdown_state(&key, &body, cx);
            let text_style = self.reading_style(cx);
            let text = self
                .linked_text(&doc, &key, cx)
                .selectable(true)
                .style(text_style)
                .shared_code_block_highlighter(super::code_blocks(cx));
            let text = crate::reply_links::link_aware(text, ix, row, &self.summary.id, cx);
            column = column.child(
                div()
                    .mt(px(8.))
                    .text_size(px(size::LABEL))
                    .line_height(px(19.))
                    .child(text),
            );
        }
        let ruled = div()
            .w_full()
            .pt(px(RUNNER_TOP))
            .pb(px(if row.in_group {
                ROW_BOTTOM
            } else {
                RUNNER_BOTTOM
            }))
            .child(
                div()
                    .w_full()
                    .border_l_2()
                    .border_color(style::hairline(cx))
                    .pl(px(12.))
                    .py(px(2.))
                    .child(column),
            );
        row_wrap(row, ruled)
    }

    /// One finding: its number, a dot for how serious, where (opens the
    /// file), the claim, and what was done about it. A click opens its case
    /// and the agent's note.
    fn review_finding_line(
        &mut self,
        ix: usize,
        row: &Row,
        note: &ReviewNote,
        finding: &ReviewFinding,
        answered: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (faint, quiet) = (style::faint_text(cx), style::quiet_text(cx));
        let hover = style::hover_fill(cx);
        let key = format!("{}#f{}", row.id, finding.id);
        let open = self.open_rows.contains(&key);
        // A panel's findings say who found each; one reviewer's heading says it.
        let by = finding
            .by
            .as_deref()
            .filter(|_| note.thread_ids.len() > 1)
            .map(|b| b.split(" (").next().unwrap_or(b).to_owned());
        let opens = finding.case.is_some() || finding.note.is_some() || by.is_some();

        let mut line = h_flex()
            .w_full()
            .items_start()
            .gap(px(8.))
            .child(
                div()
                    .flex_none()
                    .w(px(16.))
                    .text_size(px(size::SMALL))
                    .line_height(px(19.))
                    .text_color(faint)
                    .child(finding.id.to_string()),
            )
            .child(
                div().flex_none().h(px(19.)).flex().items_center().child(
                    div()
                        .size(px(7.))
                        .rounded_full()
                        .bg(severity_colour(&finding.severity, cx)),
                ),
            );
        if let Some(place) = finding.where_.clone() {
            let row_id = row.id.clone();
            line = line.child(
                div()
                    .id(part_id(ix, &format!("place-{}", finding.id)))
                    .role(Role::Link)
                    .aria_label(format!("Open {place}"))
                    .flex_none()
                    .max_w(px(180.))
                    .truncate()
                    .font_family(cx.theme().mono_font_family.clone())
                    .text_size(px(size::SMALL + 1.))
                    .line_height(px(19.))
                    .text_color(style::link_text(cx))
                    .cursor_pointer()
                    .tip(place.clone())
                    .child(short_place(&place).to_owned())
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        cx.stop_propagation();
                        this.link_clicked(&place, &row_id, window, cx);
                    })),
            );
        }
        line = line.child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(size::LABEL))
                .line_height(px(19.))
                .text_color(style::label_text(cx))
                .child(finding.claim.clone()),
        );
        if answered {
            let (symbol, word, color) = outcome(finding, cx);
            line = line.child(
                h_flex()
                    .flex_none()
                    .h(px(19.))
                    .gap(px(4.))
                    .items_center()
                    .text_size(px(size::SMALL))
                    .text_color(color)
                    .child(Icon::from(symbol).with_size(px(12.)).text_color(color))
                    .child(word),
            );
        } else {
            line = line.child(
                div()
                    .flex_none()
                    .text_size(px(size::SMALL))
                    .line_height(px(19.))
                    .text_color(faint)
                    .child("Open"),
            );
        }

        let mut item = v_flex()
            .id(part_id(ix, &format!("finding-{}", finding.id)))
            .w_full()
            .mt(px(2.))
            .py(px(3.))
            .px(px(4.))
            .rounded(px(5.))
            .child(line);
        if opens {
            let row_id = row.id.clone();
            let tip = if open {
                "Hide the detail"
            } else {
                "Show the detail"
            };
            item = item
                .role(Role::Button)
                .aria_label(tip)
                .cursor_pointer()
                .hover(move |s| s.bg(hover))
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.toggle_part(&key, &row_id, cx);
                }));
        }
        if open {
            // Under the claim: past the number and the dot.
            let mut lines: Vec<String> = Vec::new();
            if let Some(case) = finding.case.as_deref() {
                lines.push(format!("Case: {case}"));
            }
            if let Some(n) = finding.note.as_deref().filter(|n| !n.is_empty()) {
                lines.push(format!("Agent: {n}"));
            }
            if let Some(by) = by.as_deref() {
                lines.push(format!("Found by {by}"));
            }
            let detail = v_flex()
                .pl(px(16. + 8. + 7. + 8.))
                .pt(px(2.))
                .gap(px(2.))
                .children(lines.into_iter().map(|text| {
                    div()
                        .text_size(px(size::SMALL + 1.))
                        .line_height(px(17.))
                        .text_color(quiet)
                        .child(text)
                }));
            item = item.child(detail);
        }
        item.into_any_element()
    }
}
