// The sidebar's Projects view, a port of the Swift app's ProjectsList: a
// compact row per project, newest activity first, with its parts nested under
// it; each project's threads start collapsed and expand from its count/chevron
// (open threads first, then archived ones folded away a few at a time); then
// the threads in no project, and the archived projects folded away at the foot.
// Clicking a project row opens its page.
//
// A thread's row is the inbox's own (sidebar.rs), leaving out the project
// whose heading it's under, as the Swift row's `heading` does.
use crate::app::Threadbear;
use crate::home_page::mode_header;
use crate::projects::project_icon;
use crate::sidebar::{icon, palette, tipped, Palette, CORNER, LEADING, OUTER_INSET, TRAILING};
use crate::{icons, now_ms, style};
// `tipped!` (sidebar.rs) needs TestSupportExt where it's used.
use crate::spinner::Spinner;
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::{h_flex, v_flex, Sizable as _, StyledExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::sidebar::Nest;
use crate::style::px;
use serde_json::{json, Value};
use threadbear_core::inbox::ThreadSummary;
use threadbear_core::nested::{self, Nesting};
use threadbear_core::projects::{Project, Section, Sections, UNFILED_ID};
use threadbear_core::sidebar::RowLook;

/// Archived threads shown at a time.
const ARCHIVED_STEP: usize = 5;

/// Data for one project row in the sidebar.
struct HeadingRow {
    project: Project,
    count: usize,
    has_threads: bool,
    expanded: bool,
}

/// One line of the list, worked out before anything's drawn: the sections
/// borrow the app's lists, and drawing a row needs the app.
enum Item {
    Heading(HeadingRow),
    Unfiled {
        count: usize,
        expanded: bool,
    },
    /// `group` keeps a thread in two projects two rows. `nest`: the head of
    /// a group of nested threads, or one of them (nested threads).
    Row {
        thread: ThreadSummary,
        section: &'static str,
        group: String,
        nest: Nest,
    },
    ArchivedFold {
        project: String,
        count: usize,
        open: bool,
    },
    ShowMore {
        project: String,
        more: usize,
    },
    /// Breathing room below an expanded project's threads so every heading
    /// keeps a uniform height for `FarRows`.
    SectionGap(String),
    Empty,
}

impl Item {
    /// What the line is, the same from one frame to the next however the
    /// lines around it change, for keeping its height (far_rows.rs).
    fn key(&self) -> String {
        match self {
            Item::Heading(row) => format!("heading:{}", row.project.id),
            Item::Unfiled { .. } => "unfiled".into(),
            Item::Row { thread, group, .. } => format!("row:{group}:{}", thread.id),
            Item::ArchivedFold { project, .. } => format!("archived:{project}"),
            Item::ShowMore { project, .. } => format!("more:{project}"),
            Item::SectionGap(project) => format!("gap:{project}"),
            Item::Empty => "empty".into(),
        }
    }
}

/// The thread as its row under `heading` shows it: that project left out of
/// its tile and its place line, as the heading says it already.
fn under(t: &ThreadSummary, heading: &str) -> ThreadSummary {
    let mut t = t.clone();
    if let Some(projects) = t.projects.as_mut() {
        projects.retain(|m| m.id != heading);
        if projects.is_empty() {
            t.projects = None;
        }
    }
    t
}

impl Threadbear {
    /// What the list draws, top to bottom.
    fn projects_list_items(
        &self,
        sections: &Sections,
        nesting: Option<&Nesting>,
        now: i64,
    ) -> Vec<Item> {
        let mut items = Vec::new();
        for section in &sections.sections {
            self.push_project_section(&mut items, section, nesting, now);
        }
        if !sections.unfiled.is_empty() {
            let expanded = self.projects.expanded.contains(UNFILED_ID);
            items.push(Item::Unfiled {
                count: sections.unfiled.len(),
                expanded,
            });
            if expanded {
                self.push_rows(
                    &mut items,
                    &sections.unfiled,
                    UNFILED_ID,
                    nesting,
                    now,
                    |t| (*t).clone(),
                );
            }
        }
        if sections.sections.is_empty() && sections.unfiled.is_empty() {
            items.push(Item::Empty);
        }
        items
    }

    /// One project's heading, followed by its threads only while expanded.
    fn push_project_section(
        &self,
        items: &mut Vec<Item>,
        section: &Section,
        nesting: Option<&Nesting>,
        now: i64,
    ) {
        let has_threads = !section.threads.is_empty() || !section.archived.is_empty();
        let expanded = has_threads && self.projects.expanded.contains(section.id());
        items.push(Item::Heading(HeadingRow {
            project: section.project.clone(),
            count: section.threads.len(),
            has_threads,
            expanded,
        }));
        if expanded {
            self.push_section_rows(items, section, nesting, now);
            items.push(Item::SectionGap(section.id().to_owned()));
        }
    }

    /// Expands or collapses a project's threads in the Projects sidebar.
    pub(crate) fn toggle_project_expanded(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.projects.expanded.remove(id) {
            self.projects.archived_shown.remove(id);
        } else {
            self.projects.expanded.insert(id.to_owned());
        }
        cx.notify();
    }

    /// A project's open threads, then its archived ones folded away.
    fn push_section_rows(
        &self,
        items: &mut Vec<Item>,
        section: &Section,
        nesting: Option<&Nesting>,
        now: i64,
    ) {
        let id = section.id();
        self.push_rows(items, &section.threads, id, nesting, now, |t| under(t, id));
        if section.archived.is_empty() {
            return;
        }
        let shown = self.projects.archived_shown.get(id).copied().unwrap_or(0);
        items.push(Item::ArchivedFold {
            project: id.to_owned(),
            count: section.archived.len(),
            open: shown > 0,
        });
        // Their own group: a row is a section's and a thread's.
        items.extend(section.archived.iter().take(shown).map(|t| Item::Row {
            thread: under(t, id),
            section: "archived",
            group: format!("{id}/archived"),
            nest: Nest::None,
        }));
        if shown > 0 && section.archived.len() > shown {
            items.push(Item::ShowMore {
                project: id.to_owned(),
                more: ARCHIVED_STEP.min(section.archived.len() - shown),
            });
        }
    }

    /// A project's open threads as rows. With nested threads, as in the
    /// inbox: a thread whose starter is in the same project sits under it,
    /// indented, while the starter's group is open; one whose starter is
    /// elsewhere keeps its own row here.
    fn push_rows(
        &self,
        items: &mut Vec<Item>,
        threads: &[&ThreadSummary],
        group: &str,
        nesting: Option<&Nesting>,
        now: i64,
        shown: impl Fn(&ThreadSummary) -> ThreadSummary,
    ) {
        let Some(nesting) = nesting.filter(|n| !n.is_empty()) else {
            items.extend(threads.iter().map(|t| Item::Row {
                thread: shown(t),
                section: "inbox",
                group: group.to_owned(),
                nest: Nest::None,
            }));
            return;
        };
        let here: std::collections::HashMap<&str, &ThreadSummary> =
            threads.iter().map(|t| (t.id.as_str(), *t)).collect();
        for &t in threads {
            if nesting
                .top_of(&t.id)
                .is_some_and(|top| here.contains_key(top))
            {
                continue;
            }
            let Some(g) = nesting.group(&t.id) else {
                items.push(Item::Row {
                    thread: shown(t),
                    section: "inbox",
                    group: group.to_owned(),
                    nest: Nest::None,
                });
                continue;
            };
            let open = self.group_shown(&t.id, g);
            let nest = Nest::Starter {
                words: nested::group_words(g),
                tip: nested::toggle_tip(open, g),
                open,
                needs_you: g.needs_you > 0,
            };
            items.push(Item::Row {
                thread: shown(t),
                section: "inbox",
                group: group.to_owned(),
                nest,
            });
            if !open {
                continue;
            }
            for c in g.children.iter().filter_map(|id| here.get(id.as_str())) {
                let (line, question) = nested::child_line(c, now);
                let section = if c.snoozed(now) {
                    "hibernating"
                } else {
                    "running"
                };
                items.push(Item::Row {
                    thread: shown(c),
                    section,
                    group: group.to_owned(),
                    nest: Nest::Child { line, question },
                });
            }
        }
    }

    /// `ProjectsList`: the view's name and its count, New project, then the
    /// list.
    pub(crate) fn render_projects_list(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let p = palette(cx);
        let now = now_ms();
        let clock = threadbear_core::sidebar::local_now();
        // Worked out once for the count and the rows: it sorts every
        // project's threads.
        let items = {
            let sections = Sections::build(
                &self.projects.list,
                self.threads.values().map(|t| &**t),
                now,
            );
            let nesting = self.nested_threads_on().then(|| {
                Nesting::build(
                    self.threads.values(),
                    now,
                    &threadbear_core::inbox::wakes(&self.scheduled.list),
                )
            });
            (
                sections.sections.len(),
                self.projects_list_items(&sections, nesting.as_ref(), now),
            )
        };
        let (top_count, items) = items;
        let far = self.projects.list_far.clone();
        far.begin(
            self.sidebar_view.as_ref().map(|v| v.entity_id()),
            &self.projects.list_scroll,
        );
        let mut list = v_flex()
            .px(px(OUTER_INSET))
            .pt(px(6.))
            .pb(px(32.))
            .child(far.marker());
        if self.sidebar.loaded {
            for (n, item) in items.into_iter().enumerate() {
                // Far out of view it's a gap its height (far_rows.rs),
                // unless the pointer's on it.
                let key = item.key();
                let hovered = matches!(&item, Item::Row { thread, .. } if self.sidebar.hovered.as_deref() == Some(thread.id.as_str()));
                if let Some(gap) = far.far(&key).filter(|_| !hovered) {
                    list = list.child(far.row(&key, None, gap));
                    continue;
                }
                let el = match item {
                    Item::Heading(row) => self.render_project_heading(&row, &p, cx),
                    Item::Unfiled { count, expanded } => self.section_heading(
                        "projects-unfiled",
                        "Not in a project",
                        "square.dashed",
                        count,
                        !expanded,
                        true,
                        None,
                        &p,
                        |this, cx| this.toggle_project_expanded(UNFILED_ID, cx),
                        cx,
                    ),
                    Item::Row {
                        thread,
                        section,
                        group,
                        nest,
                    } => {
                        let row =
                            self.render_row_with(&thread, section, None, now, &clock, &p, nest, cx);
                        // Its own id per group, so the same thread under two
                        // projects is two rows to the window.
                        div()
                            .id(ElementId::Name(format!("projects-row-{group}-{n}").into()))
                            .child(row)
                            .into_any_element()
                    }
                    Item::ArchivedFold {
                        project,
                        count,
                        open,
                    } => self.render_archived_fold(&project, count, open, &p, cx),
                    Item::ShowMore { project, more } => {
                        self.render_archived_more(&project, more, &p, cx)
                    }
                    Item::SectionGap(_) => div().h(px(8.)).into_any_element(),
                    Item::Empty => div()
                        .pl(px(LEADING))
                        .pt(px(10.))
                        .text_size(px(style::size::SIDEBAR_PREVIEW))
                        .line_height(px(style::natural_line(style::size::SIDEBAR_PREVIEW)))
                        .text_color(p.secondary)
                        .child("No projects yet.")
                        .into_any_element(),
                };
                list = list.child(far.row(&key, Some(el), 0.));
            }
            let archived: Vec<Project> = self
                .projects
                .list
                .iter()
                .filter(|p| p.archived)
                .cloned()
                .collect();
            if !archived.is_empty() {
                list = list.child(self.render_archived_projects(&archived, &p, cx));
            }
        }
        let side = p.side;
        v_flex()
            .relative()
            .size_full()
            .bg(p.side)
            .child(mode_header("Projects", Some(top_count), &p))
            .child(
                div()
                    .px(px(OUTER_INSET))
                    .child(self.render_new_project_row(&p, cx)),
            )
            .child(
                // As the inbox's list: no scrollbar, fading out at the foot.
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(
                        div()
                            .id("projects-list")
                            .size_full()
                            .overflow_y_scroll()
                            .track_scroll(&self.projects.list_scroll)
                            .child(list),
                    )
                    .child(
                        div()
                            .absolute()
                            .left_0()
                            .right_0()
                            .bottom_0()
                            .h(px(34.))
                            .bg(linear_gradient(
                                180.,
                                linear_color_stop(side.opacity(0.), 0.),
                                linear_color_stop(side, 0.88),
                            )),
                    ),
            )
            .into_any_element()
    }

    /// `SidebarButtonRow` for New project: a spinner for its plus, and no
    /// more clicks, until the runner has made it.
    fn render_new_project_row(&mut self, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let busy = self.projects.busy.contains("new");
        let (hover, secondary, fg) = (p.hover, p.secondary, p.fg);
        let mark: AnyElement = if busy {
            Spinner::new()
                .icon(gpui_kit::assets::IconName::LoaderCircle)
                .color(secondary)
                .with_size(px(12.))
                .into_any_element()
        } else {
            icon("plus", style::size::SIDEBAR_BUTTON, secondary).into_any_element()
        };
        tipped!(
            h_flex()
                .gap(px(8.))
                .pl(px(LEADING - 2.))
                .pr(px(TRAILING))
                .py(px(7.))
                .rounded(px(CORNER))
                .when(!busy, |s| s.hover(move |s| s.bg(hover))),
            "new-project-row",
            "Make a new project"
        )
        .when(!busy, |s| {
            s.on_click(
                cx.listener(|this, _: &ClickEvent, window, cx| this.new_project(None, window, cx)),
            )
        })
        .child(div().w(px(16.)).flex().justify_center().child(mark))
        .child(
            div()
                .text_size(px(style::size::SIDEBAR_BUTTON))
                .line_height(px(17.))
                .text_color(fg)
                .child("New project"),
        )
        .into_any_element()
    }

    /// Notes the pointer over one of the view's own controls.
    fn hover_listener(
        &self,
        key: String,
        cx: &mut Context<Self>,
    ) -> Box<dyn Fn(&bool, &mut Window, &mut App) + 'static> {
        Box::new(cx.listener(move |this, hovered: &bool, window, cx| {
            if *hovered {
                crate::input_probe::input("hover", window);
                this.projects.hovered = Some(key.clone());
            } else if this.projects.hovered.as_deref() == Some(key.as_str()) {
                this.projects.hovered = None;
            }
            // Only the list draws it (the project page has hovers of its own).
            this.notify_threads_panel(cx);
        }))
    }

    /// `ProjectHeader`: a compact project row with its icon and title; clicks
    /// open its page, and the trailing count/chevron expands or collapses its
    /// threads underneath without opening the page.
    fn render_project_heading(
        &mut self,
        row: &HeadingRow,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project = &row.project;
        let id = project.id.clone();
        let key = format!("heading:{id}");
        let hovering = self.projects.hovered.as_deref() == Some(key.as_str());
        let open = self.projects.open.as_deref() == Some(id.as_str());
        let title_color = p.fg;
        let show_toggle = row.count > 0 || row.expanded || (row.has_threads && hovering);
        let trailing = show_toggle.then(|| {
            let toggle_id = id.clone();
            let expanded = row.expanded;
            let count = row.count;
            let tip = if expanded {
                format!("Hide {}'s threads", project.title)
            } else {
                format!("Show {}'s threads", project.title)
            };
            let color = if expanded { p.secondary } else { p.faint };
            let hover_bg = p.icon_hover;
            let hover_fg = p.fg;
            tipped!(
                h_flex()
                    .flex_none()
                    .items_center()
                    .gap(px(3.))
                    .px(px(5.))
                    .py(px(2.))
                    .mr(px(-5.))
                    .rounded(px(4.))
                    .text_color(color)
                    .hover(move |s| s.bg(hover_bg).text_color(hover_fg)),
                ElementId::Name(format!("project-toggle-{id}").into()),
                tip
            )
            // Not the row's own press, which opens the project page.
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                cx.stop_propagation();
                this.toggle_project_expanded(&toggle_id, cx);
            }))
            .when(count > 0, |s| {
                s.child(
                    div()
                        .text_size(px(style::size::SIDEBAR_META))
                        .line_height(px(14.))
                        .child(count.to_string()),
                )
            })
            .child(
                icons::symbol(if expanded {
                    "chevron.down"
                } else {
                    "chevron.right"
                })
                .with_size(px(8.)),
            )
            .into_any_element()
        });
        let (open_id, menu_id) = (id.clone(), id.clone());
        let heading = tipped!(
            h_flex()
                .w_full()
                .items_center()
                .gap(px(7.))
                .pl(px(LEADING))
                .pr(px(TRAILING))
                .py(px(6.))
                .rounded(px(CORNER))
                .when(open, |s| s.bg(p.selected))
                .when(!open && hovering, |s| s.bg(p.hover)),
            ElementId::Name(format!("project-heading-{id}").into()),
            format!("Open {}", project.title)
        )
        .on_hover(self.hover_listener(key, cx))
        .on_click(
            cx.listener(move |this, _: &ClickEvent, _, cx| this.open_project_page(&open_id, cx)),
        )
        .on_mouse_down(
            MouseButton::Right,
            cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                this.open_project_menu(&menu_id, ev.position, window, cx)
            }),
        )
        .child(project_icon(Some(project), "", 15., cx))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(style::size::SIDEBAR_HEADING))
                .line_height(px(16.))
                .font_semibold()
                .text_color(title_color)
                .child(project.title.clone()),
        )
        .children(trailing);
        div().py(px(1.)).child(heading).into_any_element()
    }

    /// `ArchivedFold`: under a project's open threads, how many it has
    /// archived, a click showing the newest few.
    fn render_archived_fold(
        &mut self,
        project: &str,
        count: usize,
        open: bool,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = format!("archived:{project}");
        let hovering = self.projects.hovered.as_deref() == Some(key.as_str());
        let color = if hovering { p.secondary } else { p.faint };
        let id = project.to_owned();
        tipped!(
            h_flex()
                .gap(px(5.))
                .pl(px(LEADING))
                .pr(px(TRAILING))
                .py(px(4.)),
            ElementId::Name(format!("archived-fold-{project}").into()),
            if open {
                "Hide archived threads"
            } else {
                "Show archived threads"
            }
        )
        .on_hover(self.hover_listener(key, cx))
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            if this.projects.archived_shown.remove(&id).is_none() {
                this.projects
                    .archived_shown
                    .insert(id.clone(), ARCHIVED_STEP);
            }
            cx.notify();
        }))
        .text_size(px(style::size::SIDEBAR_META))
        .line_height(px(14.))
        .text_color(color)
        .child(format!("{count} archived"))
        .child(icon(
            if open {
                "chevron.down"
            } else {
                "chevron.right"
            },
            8.,
            color,
        ))
        .into_any_element()
    }

    /// `ShowMoreRow`: after the archived threads shown so far.
    fn render_archived_more(
        &mut self,
        project: &str,
        more: usize,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = format!("more:{project}");
        let hovering = self.projects.hovered.as_deref() == Some(key.as_str());
        let id = project.to_owned();
        tipped!(
            div().pl(px(LEADING)).py(px(4.)),
            ElementId::Name(format!("archived-more-{project}").into()),
            "Show more archived threads"
        )
        .on_hover(self.hover_listener(key, cx))
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            *this.projects.archived_shown.entry(id.clone()).or_insert(0) += ARCHIVED_STEP;
            cx.notify();
        }))
        .text_size(px(style::size::SIDEBAR_META))
        .line_height(px(14.))
        .text_color(if hovering { p.secondary } else { p.faint })
        .child(format!("Show {more} more"))
        .into_any_element()
    }

    /// `ArchivedProjects`: folded away at the foot; each opens its page.
    fn render_archived_projects(
        &mut self,
        projects: &[Project],
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let open = self.projects.archived_open;
        let secondary = p.secondary;
        let fold = tipped!(
            h_flex()
                .gap(px(5.))
                .pl(px(LEADING))
                .pr(px(TRAILING))
                .pt(px(18.))
                .pb(px(6.)),
            "archived-projects",
            if open {
                "Hide archived projects"
            } else {
                "Show archived projects"
            }
        )
        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
            this.projects.archived_open = !this.projects.archived_open;
            cx.notify();
        }))
        .text_size(px(style::size::SIDEBAR_HEADING))
        .line_height(px(16.))
        .font_semibold()
        .text_color(secondary)
        .child("Archived projects")
        .child(icon(
            if open {
                "chevron.down"
            } else {
                "chevron.right"
            },
            9.,
            secondary,
        ))
        .child(div().flex_1())
        .child(projects.len().to_string());
        let mut column = v_flex().child(fold);
        if open {
            for project in projects {
                let active = self.projects.open.as_deref() == Some(project.id.as_str());
                let (hover, selected, fg) = (p.hover, p.selected, p.fg);
                let id = project.id.clone();
                column = column.child(
                    tipped!(
                        h_flex()
                            .gap(px(8.))
                            .pl(px(LEADING - 2.))
                            .pr(px(TRAILING))
                            .py(px(7.))
                            .rounded(px(CORNER))
                            .when(active, |s| s.bg(selected))
                            .when(!active, |s| s.hover(move |s| s.bg(hover))),
                        ElementId::Name(format!("archived-project-{id}").into()),
                        format!("Open {}", project.title)
                    )
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.open_project_page(&id, cx)
                    }))
                    .child(div().w(px(16.)).flex().justify_center().child(icon(
                        "archivebox",
                        style::size::SIDEBAR_BUTTON,
                        secondary,
                    )))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(style::size::SIDEBAR_BUTTON))
                            .line_height(px(17.))
                            .text_color(fg)
                            .child(project.title.clone()),
                    ),
                );
            }
        }
        column.into_any_element()
    }

    /// The Projects view in the dump, as the Swift app's has it: a section
    /// per project (parts too) in the sidebar's order, then Not in a project.
    #[cfg(feature = "automation")]
    pub(crate) fn projects_sidebar_dump(&self) -> Value {
        let sections = Sections::build(
            &self.projects.list,
            self.threads.values().map(|t| &**t),
            now_ms(),
        );
        let thread = |t: &ThreadSummary| {
            let look = RowLook::of(t, None);
            json!({
                "id": t.id, "title": t.title, "status": t.status, "needsYou": t.needs_you, "unread": look.unread,
                "hovered": self.sidebar.hover_override.as_deref() == Some(t.id.as_str()), "place": t.place(), "bold": look.emphasised,
            })
        };
        let section = |name: &str, collapsed: bool, threads: &[&ThreadSummary]| {
            json!({
                "name": name,
                "collapsed": collapsed,
                "threads": threads.iter().map(|t| thread(t)).collect::<Vec<_>>(),
            })
        };
        let mut out: Vec<Value> = sections
            .sections
            .iter()
            .map(|s| {
                section(
                    &s.project.title,
                    !self.projects.expanded.contains(s.id()),
                    &s.threads,
                )
            })
            .collect();
        out.push(section(
            "Not in a project",
            !self.projects.expanded.contains(UNFILED_ID),
            &sections.unfiled,
        ));
        Value::Array(out)
    }
}
