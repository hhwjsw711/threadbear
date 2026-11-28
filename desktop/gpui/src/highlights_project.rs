// A project's inline brief in a normal thread's Highlights: its heading (icon,
// title, folded summary, Coordinator jump and ⓘ membership popover), its live
// state, open questions and tasks (coordinator tasks/decisions plus other open
// threads' Needs you asks), other open threads, compact inline links, and its
// Notion board when present.
use crate::highlights::{icon, tipped, MenuAction, MenuItem, Palette, SidePane, LEADING, TRAILING};
use crate::{call, style};
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, StyledExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
// Shadows gpui's px, so sizes here follow the app's zoom (style.rs).
use crate::style::px;
use crate::tips::Tip as _;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use threadbear_core::chrono::{DateTime, Local};
use threadbear_core::highlights::{
    self as core, can_keep, fold, project_why, ProjectInfo, ProjectRow,
};
use threadbear_core::inbox::{Project, ThreadSummary};
use threadbear_core::project_brief::{
    self, BriefItem, BriefTarget, BriefThread, BriefUrgency, ProjectBrief,
};
use threadbear_core::sidebar as side;

/// Ephemeral per-thread expansion state for inline project briefs.
#[derive(Default)]
pub(crate) struct ProjectBriefUi {
    /// Secondary projects (`index > 0`) that the user expanded on this thread.
    pub(crate) expanded_secondary: HashSet<String>,
    /// Projects whose long State prose has been expanded via "More".
    pub(crate) state_open: HashSet<String>,
    /// Projects whose Open questions & tasks list is expanded past `ITEM_LIMIT`.
    pub(crate) all_items: HashSet<String>,
    /// Projects whose Open threads list is expanded past `THREAD_LIMIT`.
    pub(crate) all_threads: HashSet<String>,
}

impl ProjectBriefUi {
    pub(crate) fn clear(&mut self) {
        self.expanded_secondary.clear();
        self.state_open.clear();
        self.all_items.clear();
        self.all_threads.clear();
    }
}

/// The project's icon, as `ProjectIconView` draws it: a picture, else a
/// symbol, else its letter on a tile.
pub(crate) fn project_icon(project: &ProjectInfo, cx: &App) -> AnyElement {
    let picture = project
        .icon
        .as_ref()
        .and_then(|i| i.get("image"))
        .and_then(|i| i.get("path"))
        .and_then(Value::as_str)
        .map(PathBuf::from);
    if let Some(path) = picture {
        return img(crate::fit_picture::icon_source(&path.to_string_lossy()))
            .size(px(16.))
            .rounded(px(4.))
            .into_any_element();
    }
    if let Some(name) = project
        .icon
        .as_ref()
        .and_then(|i| i.get("symbol"))
        .and_then(Value::as_str)
        .filter(|s| crate::icons::try_symbol(s).is_some())
    {
        return icon(name, 12., style::secondary_text(cx)).into_any_element();
    }
    let letter = threadbear_core::sidebar::project_letter(&project.title);
    div()
        .size(px(16.))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(px(4.))
        .bg(style::primary_opacity(cx, 0.1))
        .text_size(px(10.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(style::secondary_text(cx))
        .child(letter)
        .into_any_element()
}

/// The ⓘ at the end of the project's heading.
pub(crate) fn why_button(
    row: &ProjectRow,
    p: Palette,
    cx: &mut Context<SidePane>,
) -> impl IntoElement {
    let project_id = row.project.id.clone();
    let tip = format!("Why it's in {}", row.project.title);
    let open_id = project_id.clone();
    div()
        .id(SharedString::from(format!("hl-why-{project_id}")))
        .role(Role::Button)
        .size(px(15.))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .child(icon("info.circle", 11., p.secondary))
        .tip(tip)
        .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
            let position = ev.position();
            this.project_why = match &this.project_why {
                Some((id, _)) if *id == open_id => None,
                _ => Some((open_id.clone(), position)),
            };
            cx.notify();
        }))
}

fn rgba_hsla(r: f32, g: f32, b: f32, a: f32) -> Hsla {
    Hsla::from(Rgba { r, g, b, a })
}

fn amber_row_bg(cx: &App) -> Hsla {
    if cx.theme().is_dark() {
        rgba_hsla(0.95, 0.62, 0.12, 0.07)
    } else {
        rgba_hsla(0.85, 0.48, 0.04, 0.06)
    }
}

fn amber_row_hover(cx: &App) -> Hsla {
    if cx.theme().is_dark() {
        rgba_hsla(0.95, 0.62, 0.12, 0.12)
    } else {
        rgba_hsla(0.85, 0.48, 0.04, 0.11)
    }
}

fn amber_row_border(cx: &App) -> Hsla {
    if cx.theme().is_dark() {
        rgba_hsla(0.95, 0.62, 0.12, 0.22)
    } else {
        rgba_hsla(0.78, 0.42, 0.04, 0.24)
    }
}

fn brief_card_bg(cx: &App) -> Hsla {
    style::primary_opacity(cx, if cx.theme().is_dark() { 0.025 } else { 0.02 })
}

fn brief_card_border(cx: &App) -> Hsla {
    style::primary_opacity(cx, if cx.theme().is_dark() { 0.075 } else { 0.09 })
}

fn brief_divider(cx: &App) -> Div {
    div()
        .w_full()
        .h(px(1.))
        .bg(style::primary_opacity(cx, 0.065))
}

fn dot(color: Hsla) -> Div {
    div()
        .flex_none()
        .mt(px(5.5))
        .size(px(6.))
        .rounded_full()
        .bg(color)
}

impl SidePane {
    /// Builds the live `ProjectBrief` from the app's loaded project,
    /// coordinator and thread summaries (no extra RPCs).
    fn project_brief_for(
        &self,
        project_id: &str,
        thread: &ThreadSummary,
        clock: &DateTime<Local>,
        cx: &App,
    ) -> ProjectBrief {
        let Some(app) = self.app.upgrade() else {
            return ProjectBrief::default();
        };
        let app = app.read(cx);
        let project = app.project(project_id);
        let coordinator = app.coordinator_for_project(project_id);
        ProjectBrief::build(
            project,
            coordinator,
            &thread.id,
            app.threads.values().map(|t| &**t),
            clock,
        )
    }

    fn is_project_folded(&self, key: &str, primary: bool) -> bool {
        if primary {
            self.is_folded(key)
        } else {
            self.is_folded(key) || !self.project_briefs.expanded_secondary.contains(key)
        }
    }

    fn toggle_project_fold(&mut self, key: &str, primary: bool, cx: &mut Context<Self>) {
        if primary {
            self.toggle_fold(key, cx);
            return;
        }
        if self.is_project_folded(key, false) {
            if self.collapsed.remove(key) {
                crate::highlights_store::save_collapsed(&self.collapsed);
            }
            self.project_briefs
                .expanded_secondary
                .insert(key.to_owned());
        } else {
            self.project_briefs.expanded_secondary.remove(key);
        }
        cx.notify();
    }

    /// One project's inline brief block in normal-thread Highlights (Option A):
    /// heading row, subtle bordered card with State / Open questions & tasks /
    /// Open threads / compact inline Links.
    pub(crate) fn project_block(
        &mut self,
        row: &ProjectRow,
        primary: bool,
        thread: &ThreadSummary,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project_id = row.project.id.clone();
        let key = fold::project(&project_id);
        let clock = side::local_now();
        let brief = self.project_brief_for(&project_id, thread, &clock, cx);
        let foldable = brief.has_card_content(row.project.links.len());
        let folded = foldable && self.is_project_folded(&key, primary);
        let summary = brief.collapsed_summary(row.project.links.len());

        let mut list = v_flex();
        list = list.child(self.render_project_heading(
            row,
            &key,
            primary,
            folded,
            foldable,
            brief.has_coordinator,
            summary,
            p,
            cx,
        ));

        if !folded && foldable {
            list = list.child(self.render_project_brief_card(row, &brief, p, cx));
        }
        list.into_any_element()
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "heading layout takes the resolved project row, fold flags, summary and palette directly"
    )]
    fn render_project_heading(
        &self,
        row: &ProjectRow,
        key: &str,
        primary: bool,
        folded: bool,
        foldable: bool,
        has_coordinator: bool,
        summary: Option<String>,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let group = SharedString::from(format!("hl-proj-head-{}", row.project.id));
        let hover_group = group.clone();
        let chevron_group = group.clone();
        let title_color = if folded { p.secondary } else { p.fg };
        let title_el = style::group_hover_text(
            div()
                .id(SharedString::from(format!(
                    "hl-heading-title-{}",
                    row.project.id
                )))
                .flex_none()
                .text_size(px(13.))
                .line_height(px(style::natural_line(13.)))
                .font_semibold()
                .text_color(title_color),
            hover_group,
            p.fg,
        )
        .child(row.project.title.clone());

        let top_pad = if primary { 14. } else { 12. };
        let bottom_pad = if folded { 4. } else { 8. };

        let label = h_flex()
            .group(group)
            .flex_1()
            .min_w_0()
            .gap(px(7.))
            .pl(px(LEADING))
            .pt(px(top_pad))
            .pb(px(bottom_pad))
            .items_center()
            .child(project_icon(&row.project, cx))
            .child(title_el)
            .child(div().flex_1().min_w_0().h(px(1.)).mx(px(4.)).bg(p.hairline))
            .when(folded, |s| {
                s.when_some(summary, |s, text| {
                    s.child(
                        div()
                            .flex_none()
                            .text_size(px(11.))
                            .text_color(p.faint)
                            .child(format!("{text} ·")),
                    )
                })
            })
            .when(foldable, |s| {
                s.child(
                    div()
                        .flex_none()
                        .when(!folded, |d| d.invisible())
                        .group_hover(chevron_group, |d| d.visible())
                        .child(icon(
                            if folded {
                                "chevron.right"
                            } else {
                                "chevron.down"
                            },
                            9.,
                            p.faint,
                        )),
                )
            });

        let mut head = h_flex().pr(px(TRAILING)).gap(px(6.)).items_center();
        if foldable {
            let fold_key = key.to_owned();
            let tip = format!(
                "{} {}",
                if folded { "Show" } else { "Hide" },
                row.project.title
            );
            head = head.child(
                tipped(
                    div()
                        .id(SharedString::from(format!("hl-fold-{key}")))
                        .flex_1()
                        .min_w_0()
                        .cursor_pointer()
                        .child(label),
                    tip,
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.toggle_project_fold(&fold_key, primary, cx)
                })),
            );
        } else {
            head = head.child(label);
        }

        if !folded && has_coordinator {
            let open_id = row.project.id.clone();
            let (fg, hover) = (p.fg, p.hover);
            head = head.child(
                div().pt(px(top_pad)).pb(px(bottom_pad)).child(
                    tipped(
                        div()
                            .id(SharedString::from(format!(
                                "hl-proj-coord-{}",
                                row.project.id
                            )))
                            .flex_none()
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .bg(style::primary_opacity(cx, 0.045))
                            .text_size(px(11.))
                            .line_height(px(14.))
                            .text_color(p.secondary)
                            .cursor_pointer()
                            .hover(move |s| s.bg(hover).text_color(fg))
                            .child("Coordinator →"),
                        format!("Open {}'s coordinator", row.project.title),
                    )
                    .on_click(cx.listener(
                        move |this, _: &ClickEvent, _, cx| {
                            if let Some(app) = this.app.upgrade() {
                                app.update(cx, |app, cx| {
                                    app.open_project_coordinator_home(&open_id, cx)
                                });
                            }
                        },
                    )),
                ),
            );
        }

        head.child(
            div()
                .pt(px(top_pad))
                .pb(px(bottom_pad))
                .child(why_button(row, p, cx)),
        )
        .into_any_element()
    }

    fn render_project_brief_card(
        &self,
        row: &ProjectRow,
        brief: &ProjectBrief,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut sections: Vec<AnyElement> = Vec::new();
        if let Some(state_el) = self.render_brief_state(&row.project.id, brief, p, cx) {
            sections.push(state_el);
        }
        if !brief.items.is_empty() {
            sections.push(self.render_brief_items(row, brief, p, cx));
        }
        if !brief.open_threads.is_empty() {
            sections.push(self.render_brief_threads(&row.project.id, brief, p, cx));
        }
        if !row.project.links.is_empty() {
            sections.push(self.render_brief_links(row, p, cx));
        }

        let mut card = v_flex()
            .id(SharedString::from(format!(
                "hl-proj-brief-{}",
                row.project.id
            )))
            .mx(px(12.))
            .px(px(12.))
            .pt(px(12.))
            .pb(px(10.))
            .gap(px(12.))
            .rounded(px(10.))
            .bg(brief_card_bg(cx))
            .border_1()
            .border_color(brief_card_border(cx));

        for (index, section) in sections.into_iter().enumerate() {
            if index > 0 {
                card = card.child(brief_divider(cx));
            }
            card = card.child(section);
        }
        card.into_any_element()
    }

    fn render_brief_state(
        &self,
        project_id: &str,
        brief: &ProjectBrief,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let full = brief.state.as_deref()?;
        let (preview, truncated) = brief.state_preview()?;
        let expanded = self.project_briefs.state_open.contains(project_id);
        let shown = if expanded || !truncated {
            full.to_owned()
        } else {
            preview
        };

        let header = h_flex()
            .w_full()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .child(
                div()
                    .text_size(px(11.5))
                    .font_semibold()
                    .text_color(p.secondary)
                    .child("State"),
            )
            .when_some(brief.state_updated.clone(), |row, updated| {
                row.child(div().text_size(px(11.)).text_color(p.faint).child(updated))
            });

        let mut body = v_flex().w_full().gap(px(5.)).child(header).child(
            div()
                .w_full()
                .text_size(px(12.))
                .line_height(px(18.))
                .text_color(p.fg)
                .child(shown),
        );

        if truncated {
            let toggle_id = project_id.to_owned();
            let (label, tip) = if expanded {
                ("Less", "Show less of the project state")
            } else {
                ("More", "Show the full project state")
            };
            body = body.child(
                h_flex().child(
                    tipped(
                        div()
                            .id(SharedString::from(format!(
                                "hl-proj-state-more-{project_id}"
                            )))
                            .cursor_pointer()
                            .text_size(px(11.5))
                            .text_color(style::link_text(cx))
                            .hover(|s| s.underline())
                            .child(label),
                        tip,
                    )
                    .on_click(cx.listener(
                        move |this, _: &ClickEvent, _, cx| {
                            if !this.project_briefs.state_open.remove(&toggle_id) {
                                this.project_briefs.state_open.insert(toggle_id.clone());
                            }
                            cx.notify();
                        },
                    )),
                ),
            );
        }

        Some(body.into_any_element())
    }

    fn render_brief_items(
        &self,
        row: &ProjectRow,
        brief: &ProjectBrief,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project_id = row.project.id.clone();
        let all_open = self.project_briefs.all_items.contains(&project_id);
        let (shown, more) =
            core::HighlightSections::capped(&brief.items, project_brief::ITEM_LIMIT, all_open);

        let mut header = h_flex()
            .w_full()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .child(
                div()
                    .text_size(px(11.5))
                    .font_semibold()
                    .text_color(p.secondary)
                    .child("Open questions & tasks"),
            );

        if brief.has_task_board {
            let all_label = if brief.coordinator_open_tasks > 0 {
                format!("All {} tasks →", brief.coordinator_open_tasks)
            } else {
                "All tasks →".to_owned()
            };
            let open_id = project_id.clone();
            let (fg, hover) = (p.fg, p.hover);
            header = header.child(
                tipped(
                    div()
                        .id(SharedString::from(format!(
                            "hl-proj-all-tasks-{project_id}"
                        )))
                        .flex_none()
                        .px(px(5.))
                        .py(px(1.5))
                        .rounded(px(4.))
                        .text_size(px(11.))
                        .text_color(p.faint)
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover).text_color(fg))
                        .child(all_label),
                    format!("Open all tasks in {}'s coordinator", row.project.title),
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    if let Some(app) = this.app.upgrade() {
                        app.update(cx, |app, cx| {
                            app.open_project_coordinator_tasks(&open_id, None, cx)
                        });
                    }
                })),
            );
        }

        let mut rows = v_flex().w_full();
        let mut prev_urgent = true;
        for (idx, item) in shown.iter().enumerate() {
            let urgent = item.urgency == BriefUrgency::NeedsYou;
            let show_top_rule = idx > 0 && !urgent && !prev_urgent;
            rows = rows.child(self.render_brief_item_row(
                &project_id,
                &row.project.title,
                item,
                show_top_rule,
                p,
                cx,
            ));
            prev_urgent = urgent;
        }

        if more > 0 {
            let show_id = project_id.clone();
            let total = brief.items.len();
            let fg = p.fg;
            rows = rows.child(
                h_flex().pt(px(4.)).child(
                    tipped(
                        div()
                            .id(SharedString::from(format!(
                                "hl-proj-more-items-{project_id}"
                            )))
                            .cursor_pointer()
                            .text_size(px(11.))
                            .text_color(p.faint)
                            .hover(move |s| s.text_color(fg))
                            .child(format!("Show all {total}")),
                        format!("Show all {total} open questions and tasks"),
                    )
                    .on_click(cx.listener(
                        move |this, _: &ClickEvent, _, cx| {
                            this.project_briefs.all_items.insert(show_id.clone());
                            cx.notify();
                        },
                    )),
                ),
            );
        }

        v_flex()
            .w_full()
            .gap(px(5.))
            .child(header)
            .child(rows)
            .into_any_element()
    }

    fn render_brief_item_row(
        &self,
        project_id: &str,
        project_title: &str,
        item: &BriefItem,
        top_rule: bool,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let urgent = item.urgency == BriefUrgency::NeedsYou;
        let (dot_color, tag_color) = match item.urgency {
            BriefUrgency::NeedsYou => (style::needs_you_text(cx), style::needs_you_text(cx)),
            BriefUrgency::Working => (style::status_progress(cx), style::status_progress(cx)),
            BriefUrgency::Ready => (style::added_text(cx), style::added_text(cx)),
            BriefUrgency::Waiting => (p.faint, p.faint),
        };
        let tip = match &item.target {
            BriefTarget::CoordinatorTask { .. } => format!("Open {} in Tasks", item.title),
            BriefTarget::CoordinatorHome { .. } => format!("Open {project_title}'s coordinator"),
            BriefTarget::Thread { .. } => format!("Open {}", item.title),
        };
        let target_click = item.target.clone();
        let menu_thread = match &item.target {
            BriefTarget::Thread { thread_id } => Some(thread_id.clone()),
            _ => None,
        };
        let hover_bg = if urgent { amber_row_hover(cx) } else { p.hover };

        let mut el = h_flex()
            .id(SharedString::from(format!(
                "hl-proj-item-{project_id}-{}",
                item.id
            )))
            .items_start()
            .gap(px(8.))
            .rounded(px(6.))
            .cursor_pointer()
            .when(urgent, |s| {
                s.bg(amber_row_bg(cx))
                    .border_1()
                    .border_color(amber_row_border(cx))
                    .mx(px(-4.))
                    .mb(px(4.))
                    .px(px(8.))
                    .py(px(7.))
            })
            .when(!urgent, |s| {
                s.mx(px(-6.)).px(px(6.)).py(px(6.)).when(top_rule, |s| {
                    s.border_t_1()
                        .border_color(style::primary_opacity(cx, 0.045))
                })
            })
            .hover(move |s| s.bg(hover_bg))
            .child(dot(dot_color))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(1.5))
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .font_medium()
                            .text_color(p.fg)
                            .line_clamp(2)
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(item.title.clone()),
                    )
                    .when_some(item.note.clone(), |col, note| {
                        col.child(
                            div()
                                .text_size(px(11.))
                                .line_height(px(15.))
                                .text_color(p.secondary)
                                .truncate()
                                .child(note),
                        )
                    }),
            )
            .child(
                div()
                    .flex_none()
                    .pt(px(1.))
                    .text_size(px(11.))
                    .when(urgent, |s| s.font_medium())
                    .text_color(tag_color)
                    .child(item.tag.clone()),
            )
            .tip(tip)
            .test_support()
            .role(Role::Button)
            .aria_label(SharedString::from(item.title.clone()))
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                let Some(app) = this.app.upgrade() else {
                    return;
                };
                match &target_click {
                    BriefTarget::CoordinatorTask {
                        project_id,
                        task_id,
                    } => {
                        app.update(cx, |app, cx| {
                            app.open_project_coordinator_tasks(project_id, Some(task_id), cx)
                        });
                    }
                    BriefTarget::CoordinatorHome { project_id } => {
                        app.update(cx, |app, cx| {
                            app.open_project_coordinator_home(project_id, cx)
                        });
                    }
                    BriefTarget::Thread { thread_id } => {
                        app.update(cx, |app, cx| app.open(thread_id.clone(), window, cx));
                    }
                }
            }));

        if let Some(menu_id) = menu_thread {
            el = el.on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    this.open_thread_row_menu(&menu_id, ev.position, window, cx);
                }),
            );
        }

        el.into_any_element()
    }

    fn render_brief_threads(
        &self,
        project_id: &str,
        brief: &ProjectBrief,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let total = brief.open_threads.len();
        let all_open = self.project_briefs.all_threads.contains(project_id);
        let (shown, more) = core::HighlightSections::capped(
            &brief.open_threads,
            project_brief::THREAD_LIMIT,
            all_open,
        );

        let header = h_flex()
            .w_full()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .child(
                div()
                    .text_size(px(11.5))
                    .font_semibold()
                    .text_color(p.secondary)
                    .child("Open threads"),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(p.faint)
                    .child(format!("{total} open")),
            );

        let mut rows = v_flex().w_full();
        for (idx, bt) in shown.iter().enumerate() {
            rows = rows.child(self.render_brief_thread_row(project_id, bt, idx > 0, p, cx));
        }

        if more > 0 {
            let show_id = project_id.to_owned();
            let fg = p.fg;
            rows = rows.child(
                h_flex().pt(px(4.)).child(
                    tipped(
                        div()
                            .id(SharedString::from(format!(
                                "hl-proj-more-threads-{project_id}"
                            )))
                            .cursor_pointer()
                            .text_size(px(11.))
                            .text_color(p.faint)
                            .hover(move |s| s.text_color(fg))
                            .child(format!("Show all {total}")),
                        format!("Show all {total} open threads"),
                    )
                    .on_click(cx.listener(
                        move |this, _: &ClickEvent, _, cx| {
                            this.project_briefs.all_threads.insert(show_id.clone());
                            cx.notify();
                        },
                    )),
                ),
            );
        }

        v_flex()
            .w_full()
            .gap(px(5.))
            .child(header)
            .child(rows)
            .into_any_element()
    }

    fn render_brief_thread_row(
        &self,
        project_id: &str,
        bt: &BriefThread,
        top_rule: bool,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let dot_color = if bt.running {
            style::status_progress(cx)
        } else {
            p.faint
        };
        let tag_color = if bt.running {
            style::status_progress(cx)
        } else {
            p.faint
        };
        let (open_id, menu_id) = (bt.id.clone(), bt.id.clone());
        let hover = p.hover;

        h_flex()
            .id(SharedString::from(format!(
                "hl-proj-thread-{project_id}-{}",
                bt.id
            )))
            .items_start()
            .gap(px(8.))
            .mx(px(-6.))
            .px(px(6.))
            .py(px(6.))
            .rounded(px(6.))
            .cursor_pointer()
            .when(top_rule, |s| {
                s.border_t_1()
                    .border_color(style::primary_opacity(cx, 0.045))
            })
            .hover(move |s| s.bg(hover))
            .child(dot(dot_color))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .font_medium()
                    .text_color(p.fg)
                    .child(bt.title.clone()),
            )
            .child(
                div()
                    .flex_none()
                    .pt(px(1.))
                    .text_size(px(11.))
                    .text_color(tag_color)
                    .child(bt.tag.clone()),
            )
            .tip(format!("Open {}", bt.title))
            .test_support()
            .role(Role::Button)
            .aria_label(SharedString::from(bt.title.clone()))
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                if let Some(app) = this.app.upgrade() {
                    app.update(cx, |app, cx| app.open(open_id.clone(), window, cx));
                }
            }))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    this.open_thread_row_menu(&menu_id, ev.position, window, cx);
                }),
            )
            .into_any_element()
    }

    fn render_brief_links(
        &self,
        row: &ProjectRow,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project_id = &row.project.id;
        let link_color = style::link_text(cx);
        let mut wrap = h_flex()
            .w_full()
            .flex_wrap()
            .items_center()
            .gap_x(px(5.))
            .gap_y(px(2.));

        for (i, link) in row.project.links.iter().enumerate() {
            if i > 0 {
                wrap = wrap.child(
                    div()
                        .text_size(px(11.5))
                        .line_height(px(17.))
                        .text_color(p.faint)
                        .child("·"),
                );
            }
            let address = core::text::address(&link.url);
            let url = link.url.clone();
            let menu_url = link.url.clone();
            wrap = wrap.child(
                div()
                    .id(SharedString::from(format!("hl-plink-{project_id}-{i}")))
                    .text_size(px(11.5))
                    .line_height(px(17.))
                    .text_color(link_color)
                    .cursor_pointer()
                    .hover(|s| s.underline())
                    .child(link.title.clone())
                    .tip(format!("Open {address}"))
                    .test_support()
                    .role(Role::Link)
                    .aria_label(SharedString::from(link.title.clone()))
                    .on_click(
                        cx.listener(move |this, _: &ClickEvent, _, cx| this.follow_link(&url, cx)),
                    )
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                            cx.stop_propagation();
                            this.open_link_row_menu(&menu_url, ev.position, window, cx);
                        }),
                    ),
            );
        }
        wrap.into_any_element()
    }

    fn open_thread_row_menu(
        &mut self,
        thread_id: &str,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let items = vec![
            MenuItem::action(
                "Open",
                "arrow.up.forward",
                MenuAction::OpenThread {
                    id: thread_id.to_owned(),
                },
            ),
            MenuItem::action(
                "Open in New Panel",
                "rectangle.split.2x1",
                MenuAction::OpenThreadInPanel {
                    id: thread_id.to_owned(),
                },
            ),
        ];
        self.open_menu(items, position, window, cx);
    }

    /// Automation dump for one project block in Highlights. Keeps `rows` for
    /// links (existing specs check `the "<project>" highlight "<link>"`) while
    /// also reporting the inline brief's state, open questions/tasks and open
    /// threads.
    #[cfg(feature = "automation")]
    pub(crate) fn project_brief_dump(
        &self,
        row: &ProjectRow,
        primary: bool,
        thread: &ThreadSummary,
        clock: &DateTime<Local>,
        cx: &App,
    ) -> Value {
        let key = fold::project(&row.project.id);
        let brief = self.project_brief_for(&row.project.id, thread, clock, cx);
        let foldable = brief.has_card_content(row.project.links.len());
        let folded = foldable && self.is_project_folded(&key, primary);
        let rows: Vec<Value> = if folded {
            vec![]
        } else {
            row.project
                .links
                .iter()
                .map(|l| {
                    let address = core::text::address(&l.url);
                    json!({
                        "title": l.title,
                        "detail": if address == l.title { None } else { Some(address) },
                        "symbol": "globe"
                    })
                })
                .collect()
        };
        let questions: Vec<Value> = if folded {
            vec![]
        } else {
            brief
                .items
                .iter()
                .map(|item| {
                    let kind = match &item.target {
                        BriefTarget::CoordinatorTask { .. } => "task",
                        BriefTarget::CoordinatorHome { .. } => "coordinator",
                        BriefTarget::Thread { .. } => "thread",
                    };
                    json!({
                        "id": item.id,
                        "title": item.title,
                        "note": item.note,
                        "tag": item.tag,
                        "urgent": item.urgency == BriefUrgency::NeedsYou,
                        "kind": kind,
                    })
                })
                .collect()
        };
        let open_threads: Vec<Value> = if folded {
            vec![]
        } else {
            brief
                .open_threads
                .iter()
                .map(|t| {
                    json!({
                        "id": t.id,
                        "title": t.title,
                        "running": t.running,
                        "tag": t.tag,
                    })
                })
                .collect()
        };
        json!({
            "key": key,
            "title": row.project.title,
            "count": row.project.links.len(),
            "folded": folded,
            "rows": rows,
            "hasCoordinator": brief.has_coordinator,
            "coordinatorOpenTasks": brief.coordinator_open_tasks,
            "state": if folded { None } else { brief.state.clone() },
            "stateUpdated": if folded { None } else { brief.state_updated.clone() },
            "collapsedSummary": brief.collapsed_summary(row.project.links.len()),
            "questions": questions,
            "openThreads": open_threads,
        })
    }

    /// The popover's words, the ⓘ's click and the scripted `project-why`.
    fn why_lines(&self, member: &Project) -> (Option<String>, String, bool) {
        let (who, reason) = project_why(member);
        (reason, who, can_keep(member))
    }

    /// The ⓘ's popover, when one is open. Drawn over everything at the place
    /// it was asked for, as a menu is.
    pub(crate) fn why_popover(
        &mut self,
        thread: &ThreadSummary,
        p: Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let (project_id, position) = self.project_why.clone()?;
        let member = thread
            .projects
            .as_ref()?
            .iter()
            .find(|m| m.id == project_id)?
            .clone();
        let project = self.projects.get(&project_id)?.clone();
        let (reason, who, keep) = self.why_lines(&member);
        let (bg, border) = (cx.theme().popover, p.card_border);
        let title = project.title;
        let mut buttons = h_flex().gap(px(8.)).items_center();
        if keep {
            let (id, t) = (project_id.clone(), thread.id.clone());
            buttons = buttons.child(self.why_action(
                "Keep",
                format!("Keep it in {title}, so the librarian never takes it out"),
                p,
                cx,
                move |this, cx| {
                    this.set_project_membership(t.clone(), vec![id.clone()], vec![], cx)
                },
            ));
        }
        let (id, t) = (project_id.clone(), thread.id.clone());
        buttons = buttons.child(self.why_action(
            "Take out",
            format!("Take it out of {title}; the librarian won't put it back"),
            p,
            cx,
            move |this, cx| this.set_project_membership(t.clone(), vec![], vec![id.clone()], cx),
        ));
        buttons = buttons.child(div().flex_1());
        // A link to the project's page (project_page.rs), in the main panel.
        let (open, link) = (project_id, style::link_text(cx));
        buttons = buttons.child(
            tipped(
                div()
                    .id("hl-why-open")
                    .cursor_pointer()
                    .text_size(px(style::size::DETAIL))
                    .text_color(link)
                    .hover(|s| s.underline()),
                format!("Open {title}'s page"),
            )
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.project_why = None;
                if let Some(app) = this.app.upgrade() {
                    app.update(cx, |app, cx| app.open_project_page(&open, cx));
                }
                cx.notify();
            }))
            .child("Open project"),
        );
        let card = v_flex()
            .w(px(280.))
            .p(px(14.))
            .gap(px(8.))
            .bg(bg)
            .border_1()
            .border_color(border)
            .rounded(px(8.))
            .shadow_md()
            .occlude()
            .when_some(reason, |s, r| {
                s.child(div().text_size(px(style::size::LABEL)).child(r))
            })
            .child(
                div()
                    .text_size(px(style::size::DETAIL))
                    .text_color(p.secondary)
                    .child(who),
            )
            .child(buttons);
        // A click anywhere else closes it, as a popover does (a clear
        // backdrop over the window; the card sits on top of it).
        let size = window.viewport_size();
        let backdrop = div()
            .id("why-backdrop")
            .w(size.width)
            .h(size.height)
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, _, cx| {
                    this.project_why = None;
                    cx.notify();
                }),
            )
            .child(
                anchored()
                    .position(position)
                    .snap_to_window_with_margin(px(8.))
                    .child(card),
            );
        Some(
            deferred(anchored().position(point(px(0.), px(0.))).child(backdrop))
                .with_priority(1)
                .into_any_element(),
        )
    }

    fn why_action(
        &mut self,
        label: &'static str,
        tip: String,
        p: Palette,
        cx: &mut Context<Self>,
        action: impl Fn(&mut SidePane, &mut Context<SidePane>) + 'static,
    ) -> impl IntoElement {
        tipped(
            div()
                .id(SharedString::from(format!("hl-why-{label}")))
                .px(px(8.))
                .py(px(3.))
                .rounded(px(5.))
                .bg(style::button_fill(cx))
                .border_1()
                .border_color(style::button_edge(cx))
                .cursor_pointer()
                .text_size(px(style::size::DETAIL))
                .text_color(p.fg)
                .child(label),
            tip,
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| action(this, cx)))
    }

    /// `threads.setProjects`, changing the thread's list here first
    /// (`app.setProjects`): the popover goes and the runner's answer confirms.
    fn set_project_membership(
        &mut self,
        thread_id: String,
        add: Vec<String>,
        remove: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        self.project_why = None;
        let before = self.app.upgrade().and_then(|app| {
            app.read(cx)
                .threads
                .get(&thread_id)
                .and_then(|t| t.projects.clone())
        });
        if let Some(app) = self.app.upgrade() {
            let (add2, remove2) = (add.clone(), remove.clone());
            app.update(cx, |t, cx| {
                if let Some(summary) = t.threads.get_mut(&thread_id).map(std::sync::Arc::make_mut) {
                    let list = summary.projects.get_or_insert_with(Vec::new);
                    list.retain(|m| !remove2.contains(&m.id));
                    for id in &add2 {
                        if let Some(existing) = list.iter_mut().find(|m| m.id == *id) {
                            existing.pinned = true;
                        }
                    }
                }
                cx.notify();
            });
        }
        cx.notify();
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let res = call(
                client,
                "threads.setProjects",
                json!({ "threadId": thread_id, "add": add, "remove": remove }),
            )
            .await;
            this.update(cx, |t, cx| {
                if let Err(e) = res {
                    if let Some(app) = t.app.upgrade() {
                        let id2 = thread_id.clone();
                        app.update(cx, |t, cx| {
                            if let Some(summary) =
                                t.threads.get_mut(&id2).map(std::sync::Arc::make_mut)
                            {
                                summary.projects = before;
                            }
                            cx.notify();
                        });
                    }
                    t.note_error(e.message, cx);
                }
            })
            .ok();
        })
        .detach();
    }
}

/// `project-why`: opens or closes the popover and says what's in it.
#[cfg(feature = "automation")]
pub(crate) fn project_why_command(
    side: &Entity<SidePane>,
    thread: &ThreadSummary,
    id: Option<&str>,
    cx: &mut App,
) -> Result<String, String> {
    let Some(id) = id else {
        side.update(cx, |pane, cx| {
            pane.project_why = None;
            cx.notify();
        });
        return Ok("ok closed".into());
    };
    let member = thread
        .projects
        .as_ref()
        .and_then(|list| list.iter().find(|m| m.id.starts_with(id)))
        .ok_or_else(|| format!("the open thread isn't in {id}"))?
        .clone();
    let (reason, who, keep) = side.read(cx).why_lines(&member);
    side.update(cx, |pane, cx| {
        pane.project_why = Some((member.id.clone(), point(px(600.), px(200.))));
        cx.notify();
    });
    let mut words = vec![reason.unwrap_or_else(|| "(no reason)".to_owned()), who];
    if keep {
        words.push("Keep".to_owned());
    }
    words.push("Take out".to_owned());
    words.push("Open project".to_owned());
    Ok(format!(
        "ok {}",
        serde_json::to_string(&words).unwrap_or_default()
    ))
}
