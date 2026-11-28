// Projects in the app (docs/protocol/projects.md, "Projects"), a port of the Swift app's
// Projects.swift: the list the runner keeps (`projects.list`, then
// `projects.updated`), whose page is open, and what Mike can do to a project
// by hand. Each change shows at once and goes back, with the runner's reason,
// if the runner refuses (`updateProject`); what can't be guessed (a new
// project, an icon, reading the Notion board) spins where it was asked for and
// takes no second click until it lands.
//
// Also the parts every project view shares: a project's icon
// (`ProjectIconView`), the project's menu (`ProjectMenu`) and a thread's
// Projects ▸ menu (`ThreadProjectsMenu`). The views are projects_list.rs (the
// sidebar's Projects view), projects_page.rs (the page of cards) and
// project_page.rs (a project's own page). The rules with no UI in them are
// threadbear_core::projects.
use crate::app::Threadbear;
use crate::sidebar::{MenuAction, MenuRow};
use crate::style::{self, px};
use crate::{call, icons, now_ms};
use gpui_kit::component::dialog::DialogButtonProps;
use gpui_kit::component::input::{Input, InputEvent, InputState, TextareaState};
use gpui_kit::component::{Sizable as _, WindowExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use threadbear_core::inbox::{Project as Membership, ThreadSummary};
use threadbear_core::projects::{self as rules, Project, TextField, Update};

/// The projects' state in the app (`Threadbear::projects`).
#[derive(Default)]
pub(crate) struct ProjectsState {
    /// Every project, archived ones too, newest activity first as the runner
    /// sends them, with Mike's changes shown before the runner answers.
    pub(crate) list: Vec<Project>,
    /// The project whose page is in the main panel in place of the thread
    /// (`openProjectId`). Picking a thread or another page closes it.
    pub(crate) open: Option<String>,
    /// The Projects page's search box, made the first time the page draws
    /// (it needs the window), and kept so backing out of a project finds the
    /// same results (`projectSearchQuery`).
    pub(crate) search: Option<(Entity<InputState>, Subscription)>,
    /// Work on its way with nothing to show till it lands (`BusyKey`): "new",
    /// "icon:<id>", "tasks:<id>", "librarian:<thread>".
    pub(crate) busy: HashSet<String>,
    /// The sidebar's Archived projects, unfolded.
    pub(crate) archived_open: bool,
    /// Projects whose threads are expanded in the sidebar. Projects start
    /// collapsed so the list stays compact; clicking a project's count or
    /// chevron unfolds its threads.
    pub(crate) expanded: HashSet<String>,
    /// How many archived threads each project shows in the sidebar.
    pub(crate) archived_shown: HashMap<String, usize>,
    /// What's under the pointer in the project views (a heading, a card, a
    /// page's row), for their hover looks.
    pub(crate) hovered: Option<String>,
    /// The open page's title, in a field of its own.
    pub(crate) title: Option<TitleField>,
    /// The goals, state or notes being edited on the open page.
    pub(crate) editing: Option<Editing>,
    pub(crate) list_scroll: ScrollHandle,
    /// The list's rows far out of view, drawn as gaps while it scrolls (far_rows.rs).
    pub(crate) list_far: std::rc::Rc<crate::far_rows::FarRows>,
    pub(crate) home_scroll: ScrollHandle,
    pub(crate) page_scroll: ScrollHandle,
    /// `pane_thread`'s answer on a project's page, by project, until the app
    /// next changes (the observer in app.rs clears it): the dock and the rail
    /// ask several times a frame, and finding it reads each of the project's
    /// threads' patches.
    pub(crate) pane_cache: std::cell::RefCell<Option<(String, Option<ThreadSummary>)>>,
    /// Each picture icon's blurred copy for its card's backdrop, by path;
    /// None while it's being made or when it can't be (projects_page.rs).
    pub(crate) backdrops: HashMap<String, Option<std::sync::Arc<Image>>>,
}

/// The title field on a project's page, for that project.
pub(crate) struct TitleField {
    pub(crate) project: String,
    pub(crate) input: Entity<InputState>,
    _events: Subscription,
}

/// A text section being edited, in a box with Save and Cancel.
pub(crate) struct Editing {
    pub(crate) project: String,
    pub(crate) field: TextField,
    pub(crate) input: Entity<TextareaState>,
    pub(crate) baseline: String,
    pub(crate) saving: bool,
    _events: Subscription,
}

/// What a project menu's line does (`MenuAction::Project`).
#[derive(Clone, Debug)]
pub(crate) enum ProjectAction {
    Open(String),
    Archive(String, bool),
    Notion(String),
    Merge(String, String),
    CopyId(String),
    Delete(String),
    /// A new project, with this thread in it.
    New(Option<String>),
    AskLibrarian(String),
    ChooseIcon(String),
    AutomaticIcon(String),
    RevealIcon(String),
    /// A thread row on a project's page: open the thread.
    OpenThread(String),
}

impl Threadbear {
    // ---- The list ----

    /// `projects.list`'s or `projects.updated`'s list. A page whose project
    /// was merged or deleted has nothing to show, so it closes.
    pub(crate) fn receive_projects(&mut self, value: &Value) {
        self.projects.list = Project::list(value);
        if let Some(open) = &self.projects.open {
            if !self.projects.list.iter().any(|p| &p.id == open) {
                self.projects.open = None;
            }
        }
        self.projects
            .expanded
            .retain(|id| id == rules::UNFILED_ID || self.projects.list.iter().any(|p| &p.id == id));
    }

    pub(crate) fn project(&self, id: &str) -> Option<&Project> {
        self.projects.list.iter().find(|p| p.id == id)
    }

    /// The project whose page is showing, if one is.
    pub(crate) fn open_project(&self) -> Option<&Project> {
        self.projects
            .open
            .as_deref()
            .and_then(|id| self.project(id))
    }

    /// The thread the pane and the right rail are for (`paneThread`): the open
    /// one, or on a project's page the one it borrows the project's panels
    /// from (`ProjectPane.standIn`), keeping only what came from the project:
    /// only threads have panels, as the runner works them out per thread.
    /// None on a page whose threads have nothing from it.
    pub(crate) fn pane_thread(&self) -> Option<ThreadSummary> {
        let Some(project) = self.open_project() else {
            return self.open_thread().cloned();
        };
        if let Some(coordinator) = self.coordinator_for_project(&project.id) {
            return self
                .threads
                .get(&coordinator.thread_id)
                .map(|t| (**t).clone());
        }
        if let Some((id, made)) = self.projects.pane_cache.borrow().as_ref() {
            if *id == project.id {
                return made.clone();
            }
        }
        let made = rules::stand_in(project, self.threads.values().map(|t| &**t)).map(|found| {
            let patches = rules::project_patches(project, found);
            let panels = rules::project_panels(project, found);
            let mut t = found.clone();
            t.patches = Some(
                found
                    .patches
                    .iter()
                    .flatten()
                    .filter(|v| {
                        serde_json::from_value::<threadbear_core::highlights::PatchInfo>(
                            (*v).clone(),
                        )
                        .is_ok_and(|p| patches.contains(&p))
                    })
                    .cloned()
                    .collect(),
            );
            t.panels = Some(
                found
                    .panels
                    .iter()
                    .flatten()
                    .filter(|v| {
                        v["id"]
                            .as_str()
                            .is_some_and(|id| panels.iter().any(|p| p.id == id))
                    })
                    .cloned()
                    .collect(),
            );
            t
        });
        *self.projects.pane_cache.borrow_mut() = Some((project.id.clone(), made.clone()));
        made
    }

    fn replace_project(&mut self, project: Project) {
        match self.projects.list.iter_mut().find(|p| p.id == project.id) {
            Some(slot) => *slot = project,
            None => self.projects.list.insert(0, project),
        }
    }

    /// The project's page in the main panel (`openProjectPage`). The sidebar
    /// stays where it is.
    pub(crate) fn open_project_page(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.project(id).is_none() {
            return;
        }
        if self.projects.open.as_deref() != Some(id) {
            self.projects.editing = None;
            self.refresh_task_board(id, cx);
        }
        self.projects.open = Some(id.to_owned());
        self.shows_home = false;
        self.note_navigation();
        cx.notify();
    }

    // ---- Changing a project ----

    /// Saves what's given (`updateProject`). It shows at once and goes back
    /// if the runner refuses, unless something else has changed it since; the
    /// reply goes in straight away, and `projects.updated` brings the whole
    /// list a moment later anyway.
    pub(crate) fn update_project(&mut self, id: &str, update: Update, cx: &mut Context<Self>) {
        let before = self.project(id).cloned();
        let guess = before.as_ref().map(|p| update.applied(p, now_ms()));
        if let Some(guess) = guess.clone() {
            self.replace_project(guess);
        }
        cx.notify();
        let id = id.to_owned();
        let going = crate::call_action(self.client.clone(), "projects.update", update.params(&id));
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |this, cx| {
                match res {
                    Ok(v) => {
                        if let Some(project) = Project::decode(&v["project"]) {
                            this.replace_project(project);
                        }
                    }
                    Err(e) => {
                        if let (Some(before), Some(guess)) = (before, guess) {
                            if this.project(&id) == Some(&guess) {
                                this.replace_project(before);
                            }
                        }
                        this.show_error(e.message, cx);
                        // It may have gone through and only the reply been lost.
                        this.load_projects(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Asks first: its threads leave it and its notes go (`deleteProject`).
    pub(crate) fn delete_project(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.project(id).cloned() else {
            return;
        };
        let (entity, id) = (cx.entity().downgrade(), id.to_owned());
        let title = format!("Delete \u{201C}{}\u{201D}?", project.title);
        window.open_alert_dialog(cx, move |alert, _, _| {
            let (entity, id) = (entity.clone(), id.clone());
            alert
                .title(title.clone())
                .description("Its threads leave it and its goals, state and notes are gone. The threads and folders aren't touched.")
                .button_props(DialogButtonProps::default().ok_text("Delete").show_cancel(true))
                .on_ok(move |_, _, cx| {
                    entity.update(cx, |this, cx| this.confirmed_delete_project(&id, cx)).ok();
                    true
                })
        });
    }

    /// Gone at once, and back where it was if the runner refuses.
    pub(crate) fn confirmed_delete_project(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(index) = self.projects.list.iter().position(|p| p.id == id) else {
            return;
        };
        let project = self.projects.list.remove(index);
        let was_open = self.projects.open.as_deref() == Some(id);
        if was_open {
            self.projects.open = None;
        }
        cx.notify();
        let id = id.to_owned();
        let going = crate::call_action(
            self.client.clone(),
            "projects.delete",
            json!({ "projectId": id }),
        );
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |this, cx| {
                if let Err(e) = res {
                    if this.project(&id).is_none() {
                        let at = index.min(this.projects.list.len());
                        this.projects.list.insert(at, project);
                    }
                    if was_open && this.projects.open.is_none() {
                        this.projects.open = Some(id.clone());
                    }
                    this.show_error(e.message, cx);
                    this.load_projects(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Folders and threads move over, notes are joined, and this one goes
    /// (`mergeProject`), after asking.
    pub(crate) fn merge_project(
        &mut self,
        id: &str,
        into: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(project), Some(kept)) = (self.project(id).cloned(), self.project(into).cloned())
        else {
            return;
        };
        let (entity, id, into) = (cx.entity().downgrade(), id.to_owned(), into.to_owned());
        let title = format!(
            "Merge \u{201C}{}\u{201D} into \u{201C}{}\u{201D}?",
            project.title, kept.title
        );
        let detail = format!("Its folders and threads move to {kept}, its notes are added to the end of {kept}'s, and {gone} is deleted.", kept = kept.title, gone = project.title);
        window.open_alert_dialog(cx, move |alert, _, _| {
            let (entity, id, into) = (entity.clone(), id.clone(), into.clone());
            alert
                .title(title.clone())
                .description(detail.clone())
                .button_props(
                    DialogButtonProps::default()
                        .ok_text("Merge")
                        .show_cancel(true),
                )
                .on_ok(move |_, _, cx| {
                    entity
                        .update(cx, |this, cx| this.confirmed_merge_project(&id, &into, cx))
                        .ok();
                    true
                })
        });
    }

    /// This one goes at once, and its page becomes the other's with its
    /// folders and threads counted there; the reply has the joined notes. A
    /// refusal puts both back.
    pub(crate) fn confirmed_merge_project(&mut self, id: &str, into: &str, cx: &mut Context<Self>) {
        let (Some(project), Some(kept)) = (self.project(id).cloned(), self.project(into).cloned())
        else {
            return;
        };
        let Some(index) = self.projects.list.iter().position(|p| p.id == id) else {
            return;
        };
        let mut guess = kept.clone();
        guess.folders.extend(
            project
                .folders
                .iter()
                .filter(|f| !kept.folders.contains(f))
                .cloned(),
        );
        guess.thread_count += project.thread_count;
        let was_open = self.projects.open.as_deref() == Some(id);
        self.projects.list.remove(index);
        self.replace_project(guess.clone());
        if was_open {
            self.projects.open = Some(into.to_owned());
        }
        cx.notify();
        let (client, id, into) = (self.client.clone(), id.to_owned(), into.to_owned());
        cx.spawn(async move |this, cx| {
            let res = call(
                client,
                "projects.merge",
                json!({ "projectId": id, "intoId": into }),
            )
            .await;
            this.update(cx, |this, cx| {
                match res {
                    Ok(v) => {
                        this.projects.list.retain(|p| p.id != id);
                        if let Some(kept) = Project::decode(&v["project"]) {
                            this.replace_project(kept);
                        }
                    }
                    Err(e) => {
                        if this.project(&id).is_none() {
                            let at = index.min(this.projects.list.len());
                            this.projects.list.insert(at, project);
                        }
                        if this.project(&into) == Some(&guess) {
                            this.replace_project(kept);
                        }
                        if was_open && this.projects.open.as_deref() == Some(into.as_str()) {
                            this.projects.open = Some(id.clone());
                        }
                        this.show_error(e.message, cx);
                        this.load_projects(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Asks for a name and makes a project, with the thread in it when it's
    /// asked from a thread's menu (`newProject`).
    pub(crate) fn new_project(
        &mut self,
        thread: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.projects.busy.contains("new") {
            return;
        }
        let field = cx.new(|cx| InputState::new(window, cx).placeholder("Name"));
        let (entity, typed) = (cx.entity().downgrade(), field.clone());
        window.open_alert_dialog(cx, move |dialog, _, _| {
            let (entity, field, thread) = (entity.clone(), typed.clone(), thread.clone());
            let dialog = dialog.title("New project").width(px(340.));
            let dialog = if thread.is_some() {
                dialog.description("The thread goes in it.")
            } else {
                dialog
            };
            dialog
                .child(Input::new(&typed))
                .button_props(
                    DialogButtonProps::default()
                        .ok_text("Make project")
                        .show_cancel(true),
                )
                .on_ok(move |_, window, cx| {
                    let title = field.read(cx).value().trim().to_owned();
                    if !title.is_empty() {
                        let thread = thread.clone();
                        entity
                            .update(cx, |this, cx| {
                                this.create_project(title, thread, window, cx)
                            })
                            .ok();
                    }
                    true
                })
        });
        let handle = field.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        crate::web_panels::keyboard_to_app(window);
    }

    /// Makes it, then opens its page. Its thread's folder goes in too, unless
    /// that's the default folder, which is everyone's scratch space rather
    /// than a project's. New project spins until the runner answers; from a
    /// thread's menu there's no button to spin, so a note says it's on its
    /// way, as Swift's does.
    fn create_project(
        &mut self,
        title: String,
        thread: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.projects.busy.insert("new".to_owned()) {
            return;
        }
        if thread.is_some() {
            window.push_notification(format!("Making {title}…"), cx);
        }
        let mut params = json!({ "title": title });
        if let Some(id) = &thread {
            params["threadIds"] = json!([id]);
            let cwd = self
                .threads
                .get(id)
                .map(|t| t.cwd.clone())
                .unwrap_or_default();
            let default = &self.logins.defaults.cwd;
            if !cwd.is_empty() && cwd.trim_end_matches('/') != default.trim_end_matches('/') {
                params["folders"] = json!([cwd]);
            }
        }
        cx.notify();
        let going = crate::call_action(self.client.clone(), "projects.create", params);
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |this, cx| {
                this.projects.busy.remove("new");
                match res {
                    Ok(v) => {
                        if let Some(project) = Project::decode(&v["project"]) {
                            let id = project.id.clone();
                            this.replace_project(project);
                            this.open_project_page(&id, cx);
                        }
                    }
                    Err(e) => this.show_error(e.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Asks for a folder and adds it: the project's patches load from it.
    pub(crate) fn add_project_folder(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.project(id).is_none() {
            return;
        }
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Add".into()),
        });
        let id = id.to_owned();
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(mut paths))) = paths.await {
                if let Some(path) = paths.pop() {
                    this.update(cx, |this, cx| {
                        // The project may have changed while the picker was open.
                        let Some(current) = this.project(&id).cloned() else {
                            return;
                        };
                        let path = path.to_string_lossy().trim_end_matches('/').to_owned();
                        if current.folders.contains(&path) {
                            return;
                        }
                        let mut folders = current.folders;
                        folders.push(path);
                        this.update_project(
                            &id,
                            Update {
                                folders: Some(folders),
                                ..Default::default()
                            },
                            cx,
                        );
                    })
                    .ok();
                }
            }
        })
        .detach();
    }

    pub(crate) fn remove_project_folder(&mut self, id: &str, folder: &str, cx: &mut Context<Self>) {
        let Some(project) = self.project(id) else {
            return;
        };
        let folders = project
            .folders
            .iter()
            .filter(|f| *f != folder)
            .cloned()
            .collect();
        self.update_project(
            id,
            Update {
                folders: Some(folders),
                ..Default::default()
            },
            cx,
        );
    }

    /// Asks for a picture and makes it the project's icon, which the librarian
    /// then leaves alone (`chooseProjectIcon`). The icon spins meanwhile.
    pub(crate) fn choose_project_icon(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.project(id).is_none() || self.projects.busy.contains(&format!("icon:{id}")) {
            return;
        }
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Use".into()),
        });
        let id = id.to_owned();
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(mut paths))) = paths.await {
                if let Some(path) = paths.pop() {
                    this.update(cx, |this, cx| {
                        this.set_project_icon(&id, Some(path.to_string_lossy().into_owned()), cx)
                    })
                    .ok();
                }
            }
        })
        .detach();
    }

    /// `projects.setIcon`: a picture, or none for the librarian's again.
    pub(crate) fn set_project_icon(
        &mut self,
        id: &str,
        path: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let key = format!("icon:{id}");
        if self.project(id).is_none() || !self.projects.busy.insert(key.clone()) {
            return;
        }
        cx.notify();
        let mut params = json!({ "projectId": id });
        if let Some(path) = path {
            params["path"] = json!(path);
        }
        let going = crate::call_action(self.client.clone(), "projects.setIcon", params);
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |this, cx| {
                this.projects.busy.remove(&key);
                match res {
                    Ok(v) => {
                        if let Some(project) = Project::decode(&v["project"]) {
                            this.replace_project(project);
                        }
                    }
                    Err(e) => this.show_error(e.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Reads the project's Notion board again (`refreshProjectTasks`). Quiet
    /// when it fails on its own: the board shows Notion's error itself.
    /// `force` is the refresh button, which spins, and says if the runner
    /// couldn't be asked.
    pub(crate) fn refresh_project_tasks(&mut self, id: &str, force: bool, cx: &mut Context<Self>) {
        let key = format!("tasks:{id}");
        if self.project(id).is_none_or(|p| p.notion.is_none()) || self.projects.busy.contains(&key)
        {
            return;
        }
        if force {
            self.projects.busy.insert(key.clone());
            cx.notify();
        }
        let params = json!({ "projectId": id, "force": force });
        let going = if force {
            Some(crate::call_action(
                self.client.clone(),
                "projects.refreshTasks",
                params.clone(),
            ))
        } else {
            None
        };
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let res = match going {
                Some(going) => going.await,
                None => call(client, "projects.refreshTasks", params).await,
            };
            this.update(cx, |this, cx| {
                this.projects.busy.remove(&key);
                match res {
                    Ok(v) => {
                        if let Some(project) = Project::decode(&v["project"]) {
                            this.replace_project(project);
                        }
                    }
                    Err(e) if force => this.show_error(e.message, cx),
                    Err(_) => {}
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Asks for the Notion page with the project's task board
    /// (`linkProjectNotion`); left empty, it comes off.
    pub(crate) fn link_project_notion(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.project(id).cloned() else {
            return;
        };
        let field = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("https://www.notion.so/…")
                .default_value(project.notion.clone().unwrap_or_default())
        });
        let (entity, typed, id) = (cx.entity().downgrade(), field.clone(), id.to_owned());
        let title = format!("Notion page for {}", project.title);
        window.open_alert_dialog(cx, move |dialog, _, _| {
            let (entity, field, id, was) = (entity.clone(), typed.clone(), id.clone(), project.notion.clone().unwrap_or_default());
            dialog
                .title(title.clone())
                .width(px(420.))
                .description("Paste the link to a Notion page with a Tasks database on it, or to the database itself. Leave it empty to take it off.")
                .child(Input::new(&typed))
                .button_props(DialogButtonProps::default().ok_text("Save").show_cancel(true))
                .on_ok(move |_, _, cx| {
                    let url = field.read(cx).value().trim().to_owned();
                    if url != was {
                        entity.update(cx, |this, cx| this.update_project(&id, Update { notion: Some(url), ..Default::default() }, cx)).ok();
                    }
                    true
                })
        });
        let handle = field.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        crate::web_panels::keyboard_to_app(window);
    }

    // ---- A thread's projects ----

    /// What Mike does by hand (`setProjects`): an added project is pinned (so
    /// this also keeps a thread the librarian put somewhere), and a removed one
    /// is never put back. The chips and menus change at once, and change back
    /// if the runner refuses.
    pub(crate) fn set_projects(
        &mut self,
        thread: &str,
        add: Vec<String>,
        remove: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        let before = self.threads.get(thread).and_then(|t| t.projects.clone());
        let titles: HashMap<String, String> = self
            .projects
            .list
            .iter()
            .map(|p| (p.id.clone(), p.title.clone()))
            .collect();
        let guess = rules::changing(before.as_deref().unwrap_or(&[]), &add, &remove, |id| {
            titles.get(id).cloned()
        });
        if let Some(t) = self.threads.get_mut(thread).map(std::sync::Arc::make_mut) {
            t.projects = (!guess.is_empty()).then(|| guess.clone());
        }
        cx.notify();
        let thread = thread.to_owned();
        let params = json!({ "threadId": thread, "add": add, "remove": remove });
        let going = crate::call_action(self.client.clone(), "threads.setProjects", params);
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |this, cx| {
                match res {
                    Ok(v) => {
                        if let Ok(t) = serde_json::from_value::<ThreadSummary>(v["thread"].clone())
                        {
                            this.store_reply_summary(t);
                        }
                    }
                    Err(e) => {
                        if let Some(t) = this.threads.get_mut(&thread).map(std::sync::Arc::make_mut)
                        {
                            if same_memberships(t.projects.as_deref().unwrap_or(&[]), &guess) {
                                t.projects = before;
                            }
                        }
                        this.show_error(e.message, cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A look at this thread now (`runLibrarian(threadId:)`). From a menu
    /// there's no button to spin, so a note says it's asked, and the line
    /// stays greyed until the runner has queued it.
    pub(crate) fn ask_librarian_about(
        &mut self,
        thread: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = format!("librarian:{thread}");
        if !self.projects.busy.insert(key.clone()) {
            return;
        }
        window.push_notification("Asking the librarian to look…", cx);
        cx.notify();
        let params = json!({ "threadId": thread });
        let going = crate::call_action(self.client.clone(), "librarian.run", params);
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |this, cx| {
                this.projects.busy.remove(&key);
                match res {
                    Ok(v) => {
                        this.librarian.status =
                            Some(threadbear_core::librarian::Status::decode(&v["librarian"]))
                    }
                    Err(e) => this.show_error(e.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// New Thread on a project's page (`newThread(in:)`): the new-thread box
    /// back on this Mac, in the project's first folder (the default one if it
    /// has none), the thread joining the project as it's made. The folder can
    /// still be changed there.
    pub(crate) fn new_thread_in_project(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(project) = self.project(id).cloned() else {
            return;
        };
        self.mode = crate::shell::SidebarMode::Inbox;
        self.new_thread(cx);
        // A project is this Mac's runner's: back to it the way the machine
        // menu goes, so another Mac's login and folder don't come along.
        self.choose_new_thread_runner(None, true, cx);
        self.new_thread.picks.project = Some(project.id.clone());
        // Its first folder, or the default one: never a folder left from
        // another draft.
        self.new_thread.picks.cwd = project.folders.first().cloned();
        cx.notify();
    }

    /// A thread from a project's page (`openThread`): shown in the inbox,
    /// with Archived or Hibernating unfolded for one that's put away, and
    /// open in place of the page.
    pub(crate) fn open_thread_from_page(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.reveal_thread(&id, cx);
        self.open(id, window, cx);
    }

    // ---- Menus ----

    /// `ThreadProjectsMenu`: a tick by each project the thread is in (choosing
    /// one puts it in or takes it out, by hand), a new one, and asking the
    /// librarian to look at it now.
    pub(crate) fn thread_projects_menu(&self, t: &ThreadSummary) -> MenuRow {
        let mut rows: Vec<MenuRow> = rules::live_by_title(&self.projects.list)
            .into_iter()
            .map(|p| {
                let in_it = t.projects.iter().flatten().any(|m| m.id == p.id);
                let action = MenuAction::ThreadProject {
                    thread: t.id.clone(),
                    add: (!in_it).then(|| p.id.clone()),
                    remove: in_it.then(|| p.id.clone()),
                };
                MenuRow::runner(p.title.clone(), "square.stack", in_it, false, action)
            })
            .collect();
        if !rows.is_empty() {
            rows.push(MenuRow::separator());
        }
        let mut new = MenuRow::item(
            "New project…",
            "plus",
            MenuAction::Project(ProjectAction::New(Some(t.id.clone()))),
        );
        if self.projects.busy.contains("new") {
            new = new.disabled();
        }
        rows.push(new);
        let mut ask = MenuRow::item(
            "Ask the librarian to look",
            "books.vertical",
            MenuAction::Project(ProjectAction::AskLibrarian(t.id.clone())),
        );
        if self.projects.busy.contains(&format!("librarian:{}", t.id)) {
            ask = ask.disabled();
        }
        rows.push(ask);
        MenuRow::submenu("Projects", "square.stack", rows)
    }

    /// `ProjectMenu`: archive, the Notion page, parts, merge and delete. On a
    /// card, a sidebar heading and the bar's ... over its page.
    pub(crate) fn project_menu_rows(&self, project: &Project) -> Vec<MenuRow> {
        let id = project.id.clone();
        let act = |a: ProjectAction| MenuAction::Project(a);
        let mut rows = Vec::new();
        if self.projects.open.as_deref() != Some(id.as_str()) {
            rows.push(MenuRow::item(
                "Open",
                "arrow.right.circle",
                act(ProjectAction::Open(id.clone())),
            ));
            rows.push(MenuRow::separator());
        }
        rows.push(if project.archived {
            MenuRow::item(
                "Unarchive",
                "tray.and.arrow.up",
                act(ProjectAction::Archive(id.clone(), false)),
            )
        } else {
            MenuRow::item(
                "Archive",
                "archivebox",
                act(ProjectAction::Archive(id.clone(), true)),
            )
        });
        rows.push(MenuRow::item(
            if project.notion.is_none() {
                "Add Notion Page…"
            } else {
                "Notion Page…"
            },
            "checklist",
            act(ProjectAction::Notion(id.clone())),
        ));
        let others: Vec<&Project> = self
            .projects
            .list
            .iter()
            .filter(|p| p.id != id && !p.archived)
            .collect();
        if !others.is_empty() {
            let children = others
                .into_iter()
                .map(|p| {
                    MenuRow::item(
                        p.title.clone(),
                        "square.stack",
                        act(ProjectAction::Merge(id.clone(), p.id.clone())),
                    )
                })
                .collect();
            rows.push(MenuRow::submenu(
                "Merge into",
                "arrow.triangle.merge",
                children,
            ));
        }
        rows.push(MenuRow::separator());
        rows.push(MenuRow::item(
            "Copy project id",
            "number",
            act(ProjectAction::CopyId(id.clone())),
        ));
        rows.push(MenuRow::separator());
        rows.push(MenuRow::item(
            "Delete…",
            "trash",
            act(ProjectAction::Delete(id)),
        ));
        rows
    }

    /// The menu of a project's heading, card or row, where it was clicked.
    pub(crate) fn open_project_menu(
        &mut self,
        id: &str,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // The project's menu alone: a right-click went on to the dock panel's
        // own menu (Hide Title, Open in New Window), which came up over this
        // one's Open and Archive, as it did on thread rows (12 Nov).
        cx.stop_propagation();
        let Some(project) = self.project(id).cloned() else {
            return;
        };
        let rows = self.project_menu_rows(&project);
        self.open_menu(None, rows, position, false, window, cx);
    }

    /// Runs a project menu's line.
    pub(crate) fn run_project_action(
        &mut self,
        action: ProjectAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            ProjectAction::Open(id) => self.open_project_page(&id, cx),
            ProjectAction::Archive(id, archived) => self.update_project(
                &id,
                Update {
                    archived: Some(archived),
                    ..Default::default()
                },
                cx,
            ),
            ProjectAction::Notion(id) => self.link_project_notion(&id, window, cx),
            ProjectAction::Merge(id, into) => self.merge_project(&id, &into, window, cx),
            ProjectAction::CopyId(id) => cx.write_to_clipboard(ClipboardItem::new_string(id)),
            ProjectAction::Delete(id) => self.delete_project(&id, window, cx),
            ProjectAction::New(thread) => self.new_project(thread, window, cx),
            ProjectAction::AskLibrarian(thread) => self.ask_librarian_about(&thread, window, cx),
            ProjectAction::ChooseIcon(id) => self.choose_project_icon(&id, window, cx),
            ProjectAction::AutomaticIcon(id) => self.set_project_icon(&id, None, cx),
            ProjectAction::RevealIcon(id) => {
                if let Some(from) = self
                    .project(&id)
                    .and_then(|p| p.icon.as_ref())
                    .and_then(|i| i.from.clone())
                {
                    crate::open_gate::reveal(&from, crate::open_gate::Origin::ThisMac, cx);
                }
            }
            ProjectAction::OpenThread(id) => self.open_thread_from_page(id, window, cx),
        }
        cx.notify();
    }

    // ---- The page's fields ----

    /// The open page's title field, made (or remade for another project) as
    /// the page draws. Return saves it, Escape puts it back, and leaving it
    /// saves too (`TitleField`).
    pub(crate) fn project_title_field(
        &mut self,
        project: &Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<InputState> {
        if let Some(field) = self
            .projects
            .title
            .as_ref()
            .filter(|f| f.project == project.id)
        {
            // The librarian's or an agent's new title shows, unless he's typing.
            let input = field.input.clone();
            let focused = input.read(cx).focus_handle(cx).is_focused(window);
            if !focused && input.read(cx).value() != project.title.as_str() {
                let title = project.title.clone();
                input.update(cx, |s, cx| s.set_value(title, window, cx));
            }
            // Not being typed in, it shows the project's title as it is.
            if !focused {
                crate::unsent::saved(&input, cx);
            }
            return input;
        }
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Title")
                .default_value(project.title.clone())
        });
        // A new title typed and not yet saved: an update's restart waits for it.
        crate::unsent::watch(&input, "a project's new title", cx);
        let id = project.id.clone();
        let events = cx.subscribe_in(
            &input,
            window,
            move |this, input, ev: &InputEvent, window, cx| match ev {
                InputEvent::PressEnter { .. } => {
                    this.save_project_title(&id, input.read(cx).value().to_string(), window, cx);
                    window.blur(cx);
                }
                InputEvent::Blur => {
                    this.save_project_title(&id, input.read(cx).value().to_string(), window, cx)
                }
                _ => {}
            },
        );
        self.projects.title = Some(TitleField {
            project: project.id.clone(),
            input: input.clone(),
            _events: events,
        });
        input
    }

    /// A title that's empty goes back to what it was; one that's changed is
    /// saved.
    fn save_project_title(
        &mut self,
        id: &str,
        typed: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(current) = self.project(id).map(|p| p.title.clone()) else {
            return;
        };
        let title = typed.trim().to_owned();
        if title.is_empty() {
            if let Some(field) = self.projects.title.as_ref().filter(|f| f.project == id) {
                let input = field.input.clone();
                input.update(cx, |s, cx| s.set_value(current, window, cx));
            }
            return;
        }
        if title != current {
            self.update_project(
                id,
                Update {
                    title: Some(title),
                    ..Default::default()
                },
                cx,
            );
        }
    }

    /// Escape in the title: back as it was.
    pub(crate) fn revert_project_title(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(field) = self.projects.title.as_ref() else {
            return;
        };
        let (input, id) = (field.input.clone(), field.project.clone());
        let Some(current) = self.project(&id).map(|p| p.title.clone()) else {
            return;
        };
        input.update(cx, |s, cx| s.set_value(current, window, cx));
        window.blur(cx);
    }

    /// Edit on goals, state or notes: a box with what's there now, the cursor
    /// in it. Not saved as it's typed, so the librarian's or an agent's update
    /// arriving meanwhile doesn't fight the typing.
    pub(crate) fn start_editing_project(
        &mut self,
        id: &str,
        field: TextField,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(text) = self.project(id).map(|p| field.text(p).to_owned()) else {
            return;
        };
        let rows = if field == TextField::Notes {
            (10, 30)
        } else {
            (4, 20)
        };
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(rows.0, rows.1)
                .default_value(text.clone())
        });
        // Changes not yet saved (they're saved with Save, not as typed): an
        // update's restart waits for them.
        crate::unsent::watch(&input, "a project's goals, state or notes being edited", cx);
        let events = cx.subscribe_in(&input, window, |this, _, ev: &InputEvent, window, cx| {
            // ⌘Return saves, as the Swift box's Save shortcut does.
            if let InputEvent::PressEnter {
                secondary: true, ..
            } = ev
            {
                this.finish_editing_project(true, window, cx);
            }
        });
        input.update(cx, |s, cx| s.focus(window, cx));
        crate::web_panels::keyboard_to_app(window);
        self.projects.editing = Some(Editing {
            project: id.to_owned(),
            field,
            input,
            baseline: text,
            saving: false,
            _events: events,
        });
        cx.notify();
    }

    /// Save or Cancel. A save that changes nothing sends nothing.
    pub(crate) fn finish_editing_project(
        &mut self,
        save: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(editing) = self.projects.editing.as_ref() else {
            return;
        };
        if editing.saving {
            return;
        }
        let draft = editing.input.read(cx).value().to_string();
        if !save || draft == editing.baseline {
            self.projects.editing = None;
            cx.notify();
            return;
        }
        // The current version is shown under the draft. Only its explicit
        // review action may advance the comparison used by the next save.
        if self
            .project(&editing.project)
            .is_some_and(|p| editing.field.text(p) != editing.baseline)
        {
            cx.notify();
            return;
        }
        let (project, field, baseline, input) = (
            editing.project.clone(),
            editing.field,
            editing.baseline.clone(),
            editing.input.clone(),
        );
        let mut params = field.update(draft.clone()).params(&project);
        params["ifUnchanged"] = json!({field.title().to_lowercase():baseline});
        if let Some(editing) = self.projects.editing.as_mut() {
            editing.saving = true;
        }
        let client = self.client.clone();
        let going = crate::call_action(client.clone(), "projects.update", params);
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = going.await;
            // The update notification can race the failed save. Read the
            // current version so the editor can show exactly what changed.
            let current = if result.is_err() {
                call(client, "projects.get", json!({"projectId":project}))
                    .await
                    .ok()
                    .and_then(|v| Project::decode(&v["project"]))
            } else {
                None
            };
            this.update_in(cx, |this, _, cx| {
                if let Some(project) = current {
                    this.replace_project(project);
                }
                let still_editing = this
                    .projects
                    .editing
                    .as_ref()
                    .is_some_and(|e| e.input == input);
                match result {
                    Ok(value) => {
                        if let Some(project) = Project::decode(&value["project"]) {
                            this.replace_project(project);
                            this.clear_project_edit_error();
                            if still_editing {
                                if input.read(cx).value().as_ref() == draft.as_str() {
                                    this.projects.editing = None;
                                } else if let Some(editing) = this.projects.editing.as_mut() {
                                    editing.baseline = draft;
                                    editing.saving = false;
                                }
                            }
                        } else {
                            if let Some(editing) = this.projects.editing.as_mut().filter(|e| e.input == input) {
                                editing.saving = false;
                            }
                            this.show_error("The runner did not confirm the project update. Your text is still in the editor.".to_owned(), cx);
                        }
                    }
                    Err(error) => {
                        if let Some(editing) = this.projects.editing.as_mut().filter(|e| e.input == input) {
                            editing.saving = false;
                        }
                        this.show_error(
                            format!("{} Your text is still in the editor.", error.message),
                            cx,
                        );
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn review_project_text(
        &mut self,
        project: &str,
        field: TextField,
        reviewed: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self
            .project(project)
            .is_some_and(|p| field.text(p) == reviewed)
        {
            self.show_error(
                "The saved text changed again. Review its newest version before saving.".to_owned(),
                cx,
            );
            return;
        }
        let Some(editing) = self
            .projects
            .editing
            .as_mut()
            .filter(|e| e.project == project && e.field == field && !e.saving)
        else {
            return;
        };
        editing.baseline = reviewed;
        editing
            .input
            .update(cx, |input, cx| input.focus(window, cx));
        crate::web_panels::keyboard_to_app(window);
        self.clear_project_edit_error();
        cx.notify();
    }

    fn clear_project_edit_error(&mut self) {
        if self.error_message.as_deref().is_some_and(|text| {
            text.ends_with("Your text is still in the editor.")
                || text == "The saved text changed again. Review its newest version before saving."
        }) {
            self.error_message = None;
        }
    }

    // ---- For the specs ----

    /// The open page in the dump (`AppDump.project`).
    #[cfg(feature = "automation")]
    pub(crate) fn project_page_dump(&self) -> Value {
        let Some(project) = self.open_project() else {
            return Value::Null;
        };
        let threads = rules::threads_in(&project.id, self.threads.values().map(|t| &**t));
        json!({
            "id": project.id,
            "title": project.title,
            "folders": project.folders,
            "threads": threads.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
            "patches": rules::patches_across(project, &threads).iter().map(|(p, _)| p.id.clone()).collect::<Vec<_>>(),
            "archived": project.archived,
        })
    }
}

/// Two thread memberships say the same thing (the guess is still what's
/// there, so a refusal can put back what was).
fn same_memberships(a: &[Membership], b: &[Membership]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| x.id == y.id && x.pinned == y.pinned && x.by == y.by)
}

/// `ProjectIconView`: the project's picture, else its symbol, else the title's
/// first letter on a quiet tile. `size` is in points before zoom; `title`
/// gives the letter for a project the list hasn't caught up with yet.
pub(crate) fn project_icon(
    project: Option<&Project>,
    title: &str,
    size: f32,
    cx: &App,
) -> AnyElement {
    let secondary = style::secondary_text(cx);
    let fill = style::primary_opacity(cx, 0.08);
    let letter: SharedString =
        threadbear_core::sidebar::project_letter(project.map_or(title, |p| p.title.as_str()))
            .into();
    let letter_tile = move || {
        div()
            .size(px(size))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(size * 0.26))
            .bg(fill)
            .text_size(px(size * 0.62))
            .line_height(px(size))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(secondary)
            .child(letter.clone())
            .into_any_element()
    };
    let icon = project.and_then(|p| p.icon.as_ref());
    if let Some(path) = icon.and_then(|i| i.image_path.clone()) {
        // The letter stands in if the file can't be read (a project on
        // another Mac's disk, or a picture this app can't draw).
        let fallback = letter_tile;
        return img(crate::fit_picture::icon_source(&path))
            .size(px(size))
            .flex_none()
            .rounded(px(size * 0.22))
            .object_fit(ObjectFit::Contain)
            .with_fallback(fallback)
            .into_any_element();
    }
    if let Some(symbol) = icon
        .and_then(|i| i.symbol.clone())
        .filter(|s| icons::try_symbol(s).is_some())
    {
        return div()
            .size(px(size))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .child(
                icons::symbol(&symbol)
                    .with_size(px(size * 0.78))
                    .text_color(secondary),
            )
            .into_any_element();
    }
    letter_tile()
}

/// The projects' scripted commands, the Swift app's names and shapes
/// (app/README.md): `project` opens (or with `close` shuts) a project's page,
/// by `id` or `title`, `newThread` being its New Thread; `search` with
/// `projects` types in the
/// Projects page's search and says the cards it leaves.
#[cfg(feature = "automation")]
pub(crate) fn automation(
    app: &Entity<Threadbear>,
    cmd: &Value,
    window: &mut Window,
    cx: &mut App,
) -> Result<Value, String> {
    let find = |cx: &App, key: &str| -> Option<String> {
        app.read(cx)
            .projects
            .list
            .iter()
            .find(|p| p.id == key || p.title == key)
            .map(|p| p.id.clone())
    };
    let ids = |cx: &App| {
        app.read(cx)
            .projects
            .list
            .iter()
            .map(|p| p.id.clone())
            .collect::<Vec<_>>()
            .join(", ")
    };
    match cmd["cmd"].as_str().unwrap_or("") {
        "project" => {
            if cmd["close"].as_bool() == Some(true) {
                app.update(cx, |t, cx| {
                    t.projects.open = None;
                    t.note_navigation();
                    cx.notify();
                });
                return Ok(json!("ok"));
            }
            let key = cmd["id"]
                .as_str()
                .or(cmd["title"].as_str())
                .ok_or_else(|| format!("give an id: {}", ids(cx)))?;
            let id =
                find(cx, key).ok_or_else(|| format!("no project {key}; there are {}", ids(cx)))?;
            app.update(cx, |t, cx| t.open_project_page(&id, cx));
            if cmd["newThread"].as_bool() == Some(true) {
                app.update(cx, |t, cx| t.new_thread_in_project(&id, cx));
                let t = app.read(cx);
                return Ok(json!(format!(
                    "ok new thread in {}, folder {}",
                    t.new_thread
                        .picks
                        .project
                        .clone()
                        .unwrap_or_else(|| "no project".into()),
                    t.new_thread
                        .picks
                        .cwd
                        .clone()
                        .unwrap_or_else(|| "default".into())
                )));
            }
            let _ = window;
            Ok(json!("ok"))
        }
        "search" => {
            let words = cmd["text"].as_str().unwrap_or("").to_owned();
            let search = app.update(cx, |t, cx| t.projects_search(window, cx));
            search.update(cx, |s, cx| s.set_value(words, window, cx));
            let t = app.read(cx);
            let titles = t
                .shown_project_cards(cx)
                .into_iter()
                .map(|(title, _)| title)
                .collect::<Vec<_>>();
            Ok(json!(format!(
                "ok {}",
                serde_json::to_string(&titles).unwrap_or_default()
            )))
        }
        other => Err(format!("unknown projects command {other}")),
    }
}
