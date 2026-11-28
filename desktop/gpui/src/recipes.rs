// The Recipes view (the `recipes` experiment, docs/protocol/projects.md "Recipes"):
// techniques worth keeping that an agent sets up for anyone. The sidebar
// lists the ones added, each with its switch and how it's going; the main
// panel shows them all as a gallery of cards, or one recipe's page: what it
// does, an example of a run, what it set up, its last 30 days and its log.
//
// Every click shows at once: the switch moves and goes back if the runner
// says no; Add, New recipe, Change it and Remove spin and take no second
// click until the runner has answered, then open the thread it started.
use crate::a11y::A11yRole as _;
use crate::app::Threadbear;
use crate::home_page::mode_header;
use crate::mac_switch::MacSwitch;
use crate::shell::SidebarMode;
use crate::sidebar::{icon, palette, tipped, Palette, LEADING, OUTER_INSET, TRAILING};
use crate::spinner::Spinner;
use crate::tips::Tip as _;
use crate::{call, style};
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::dialog::DialogButtonProps;
use gpui_kit::component::{
    h_flex, v_flex, ActiveTheme as _, Disableable as _, Sizable as _, StyledExt as _,
    WindowExt as _,
};
use gpui_kit::prelude::*;
use gpui_kit::*;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::style::px;
use serde_json::{json, Value};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use threadbear_core::chrono::Local;
use threadbear_core::recipes::{self as rules, Day, Recipe, RecipeDetail, RecipeState};

/// The gallery's cards: as many columns of at least this width as fit.
const CARD_MIN: f32 = 236.;
const CARD_MAX: f32 = 420.;
const CARD_GAP: f32 = 16.;
const CARD_HEADER: f32 = 92.;
const TILE: f32 = 52.;
/// The example's little thread: its box scrolls inside this.
const EXAMPLE_HEIGHT: f32 = 440.;

thread_local! {
    /// The gallery's width last frame, for this frame's columns.
    static GRID_WIDTH: Rc<Cell<f32>> = Rc::new(Cell::new(900.));
}

/// What the view holds (`Threadbear::recipes`).
pub(crate) struct RecipesState {
    /// Once `recipes.list` has answered.
    pub(crate) list: Option<Vec<Recipe>>,
    /// The recipe whose page is in the main panel; None for the gallery.
    pub(crate) open: Option<String>,
    /// `recipes.get` answers, for the pages.
    pub(crate) details: HashMap<String, RecipeDetail>,
    /// "add:<id>", "on:<id>", "remove:<id>", "change:<id>", "new" while on
    /// their way.
    pub(crate) busy: HashSet<String>,
    list_scroll: ScrollHandle,
    /// The gallery and the page; a scripted click scrolls it to what it's after.
    pub(crate) home_scroll: ScrollHandle,
    /// The example each page shows (its dots), by recipe id.
    example_at: HashMap<String, usize>,
    /// Inside the example's little thread.
    example_scroll: ScrollHandle,
}

impl RecipesState {
    pub(crate) fn new() -> Self {
        RecipesState {
            list: None,
            open: None,
            details: HashMap::new(),
            busy: HashSet::new(),
            list_scroll: ScrollHandle::new(),
            home_scroll: ScrollHandle::new(),
            example_at: HashMap::new(),
            example_scroll: ScrollHandle::new(),
        }
    }

    fn recipe(&self, id: &str) -> Option<&Recipe> {
        self.list.as_ref()?.iter().find(|r| r.id == id)
    }

    fn replace(&mut self, recipe: Recipe) {
        if let Some(list) = self.list.as_mut() {
            match list.iter_mut().find(|r| r.id == recipe.id) {
                Some(slot) => *slot = recipe.clone(),
                None => list.push(recipe.clone()),
            }
            rules::sort(list);
        }
        if let Some(d) = self.details.get_mut(&recipe.id) {
            d.recipe = recipe;
        }
    }
}

impl Threadbear {
    /// Whether the runner has the experiment on (hello's `experiments`).
    pub(crate) fn recipes_on(&self) -> bool {
        self.remote
            .experiments
            .iter()
            .any(|e| e == rules::EXPERIMENT)
    }

    /// After hello, on opening the view, and on `recipes.updated`: the list,
    /// then the page of the one open.
    pub(crate) fn load_recipes(&mut self, cx: &mut Context<Self>) {
        if !self.recipes_on() {
            return;
        }
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let Ok(v) = call(client, "recipes.list", json!({})).await else {
                return;
            };
            this.update(cx, |this, cx| {
                this.recipes.list = Some(Recipe::decode_list(&v["recipes"]));
                if let Some(open) = this.recipes.open.clone() {
                    this.load_recipe(open, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn load_recipe(&mut self, id: String, cx: &mut Context<Self>) {
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let Ok(v) = call(client, "recipes.get", json!({ "id": id })).await else {
                return;
            };
            this.update(cx, |this, cx| {
                if let Some(detail) = RecipeDetail::decode(&v["recipe"]) {
                    this.recipes
                        .details
                        .insert(detail.recipe.id.clone(), detail);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// The view, with the gallery or a recipe's page beside it.
    pub(crate) fn show_recipes(&mut self, page: Option<String>, cx: &mut Context<Self>) {
        // A page or the gallery opens at its top, not where the last was.
        if self.recipes.open != page {
            self.recipes.home_scroll.set_offset(Point::default());
            self.recipes.example_scroll.set_offset(Point::default());
        }
        self.recipes.open = page.clone();
        self.set_mode(SidebarMode::Recipes, cx);
        // set_mode leaves things be when the view's already up with its page.
        self.shows_home = true;
        self.load_recipes(cx);
        if let Some(id) = page {
            self.load_recipe(id, cx);
        }
        cx.notify();
    }

    /// The switch: moves at once, and goes back with the runner's reason if
    /// it says no.
    fn set_recipe_on(&mut self, id: String, on: bool, cx: &mut Context<Self>) {
        let key = format!("on:{id}");
        if self.recipes.busy.contains(&key) {
            return;
        }
        let Some(before) = self.recipes.recipe(&id).cloned() else {
            return;
        };
        let guess = rules::guess_on(&before, on);
        self.recipes.replace(guess.clone());
        self.recipes.busy.insert(key.clone());
        cx.notify();
        // On is agreeing to its habit's words: the ones shown here.
        let mut params = json!({ "id": id, "on": on });
        if let Some(h) = before.habit.as_ref().filter(|_| on) {
            params["habit"] = json!(h.text);
            params["name"] = json!(before.name);
        }
        let going = crate::call_action(self.client.clone(), "recipes.setOn", params);
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |this, cx| {
                this.recipes.busy.remove(&key);
                match res {
                    Ok(v) => {
                        if let Some(r) = Recipe::decode(&v["recipe"]) {
                            this.recipes.replace(r);
                        }
                    }
                    Err(e) => {
                        if this.recipes.recipe(&before.id) == Some(&guess) {
                            this.recipes.replace(before);
                        }
                        this.show_error(e.message, cx);
                        // Its wording may have changed under the click.
                        this.load_recipes(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Add, New recipe and Change it: the runner starts a thread, which opens.
    fn start_recipe_thread(
        &mut self,
        key: String,
        method: &'static str,
        params: Value,
        cx: &mut Context<Self>,
    ) {
        if !self.recipes.busy.insert(key.clone()) {
            return;
        }
        cx.notify();
        let going = crate::call_action(self.client.clone(), method, params);
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |t, cx| {
                t.recipes.busy.remove(&key);
                match res {
                    Ok(v) => {
                        let id = v["threadId"].as_str().unwrap_or_default().to_owned();
                        if id.is_empty() {
                            t.show_error(
                                "The runner didn't say what thread it started.".to_owned(),
                                cx,
                            );
                        } else {
                            // Listed now when the runner sent it, so it opens
                            // before threads.created.
                            if let Ok(thread) = serde_json::from_value::<
                                threadbear_core::inbox::ThreadSummary,
                            >(v["thread"].clone())
                            {
                                if thread.id == id {
                                    t.store_reply_summary(thread);
                                }
                            }
                            let (me, window) = (cx.entity().downgrade(), t.main_window);
                            cx.defer(move |cx| {
                                window
                                    .update(cx, |_, window, cx| {
                                        me.update(cx, |this, cx| this.open(id, window, cx)).ok()
                                    })
                                    .ok();
                            });
                        }
                        t.load_recipes(cx);
                    }
                    Err(e) => t.show_error(e.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn add_recipe(&mut self, id: String, cx: &mut Context<Self>) {
        // Only a habit: nothing to set up, so adding it is switching it on.
        if self.recipes.recipe(&id).is_some_and(|r| r.instant) {
            self.set_recipe_on(id, true, cx);
            return;
        }
        let mut params = json!({ "id": id });
        if let Some(r) = self.recipes.recipe(&id) {
            if let Some(h) = &r.habit {
                params["habit"] = json!(h.text);
                params["name"] = json!(r.name);
            }
        }
        self.start_recipe_thread(format!("add:{id}"), "recipes.add", params, cx);
    }

    fn new_recipe(&mut self, cx: &mut Context<Self>) {
        self.start_recipe_thread("new".to_owned(), "recipes.create", json!({}), cx);
    }

    fn change_recipe(&mut self, id: String, cx: &mut Context<Self>) {
        self.start_recipe_thread(
            format!("change:{id}"),
            "recipes.create",
            json!({ "editId": id }),
            cx,
        );
    }

    /// Remove, after asking: its schedules go, its files stay.
    fn remove_recipe(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(recipe) = self.recipes.recipe(&id) else {
            return;
        };
        let title = format!("Remove \u{201C}{}\u{201D}?", recipe.name);
        let entity = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let (entity, id) = (entity.clone(), id.clone());
            alert
                .title(title.clone())
                .description("Its schedules are deleted, agents stop being told its habit if it has one, and it goes back to the gallery, ready to add again. Its files stay where they are.")
                .button_props(DialogButtonProps::default().ok_text("Remove").show_cancel(true))
                .on_ok(move |_, _, cx| {
                    let id = id.clone();
                    entity.update(cx, move |this, cx| this.confirmed_remove_recipe(id, cx)).ok();
                    true
                })
        });
    }

    fn confirmed_remove_recipe(&mut self, id: String, cx: &mut Context<Self>) {
        let key = format!("remove:{id}");
        if !self.recipes.busy.insert(key.clone()) {
            return;
        }
        cx.notify();
        let going = crate::call_action(self.client.clone(), "recipes.remove", json!({ "id": id }));
        cx.spawn(async move |this, cx| {
            let res = going.await;
            this.update(cx, |this, cx| {
                this.recipes.busy.remove(&key);
                match res {
                    Ok(_) => this.load_recipes(cx),
                    Err(e) => this.show_error(e.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // ------------------------------------------------------------ sidebar

    /// The sidebar's view: New recipe, Browse recipes, then each one added
    /// with its switch and how it's going.
    pub(crate) fn render_recipes_list(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let p = palette(cx);
        let list = self.recipes.list.clone().unwrap_or_default();
        let mut rows = v_flex().px(px(OUTER_INSET)).pt(px(4.)).pb(px(32.));
        if self.recipes.list.is_none() {
            rows = rows.child(
                div()
                    .pl(px(LEADING))
                    .pt(px(10.))
                    .text_size(px(style::size::SIDEBAR_PREVIEW))
                    .text_color(p.secondary)
                    .child("Loading…"),
            );
        }
        let added = rules::added(&list);
        for recipe in &added {
            rows = rows.child(self.render_recipe_row(recipe, &p, cx));
        }
        if self.recipes.list.is_some() && added.is_empty() {
            rows = rows.child(div().pl(px(LEADING)).pr(px(TRAILING)).pt(px(10.)).text_size(px(style::size::SIDEBAR_PREVIEW)).line_height(px(17.)).text_color(p.secondary).child("None added yet. Browse them and add one, and an agent sets it up with you."));
        }
        let gallery_lit =
            self.home_page() == Some(SidebarMode::Recipes) && self.recipes.open.is_none();
        let side = p.side;
        let new_busy = self.recipes.busy.contains("new");
        v_flex()
            .relative()
            .size_full()
            .bg(p.side)
            .child(mode_header("Recipes", Some(rules::on_count(&list)), &p))
            .child(
                div()
                    .px(px(OUTER_INSET))
                    .child(sidebar_button(
                        "recipes-new",
                        "plus",
                        "New recipe",
                        "Write a recipe of your own with an agent",
                        new_busy,
                        false,
                        &p,
                        cx.listener(|this, _: &ClickEvent, _, cx| this.new_recipe(cx)),
                    ))
                    .child(sidebar_button(
                        "recipes-browse",
                        "square.grid.2x2",
                        "Browse recipes",
                        "See every recipe, added or not",
                        false,
                        gallery_lit,
                        &p,
                        cx.listener(|this, _: &ClickEvent, _, cx| this.show_recipes(None, cx)),
                    )),
            )
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(
                        div()
                            .id("recipes-list")
                            .size_full()
                            .overflow_y_scroll()
                            .track_scroll(&self.recipes.list_scroll)
                            .child(rows),
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

    /// One recipe added: its icon and name with the switch, and how it's
    /// going (its runs are on its page). One still setting up links its thread.
    fn render_recipe_row(
        &mut self,
        recipe: &Recipe,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = recipe.id.clone();
        let lit = self.home_page() == Some(SidebarMode::Recipes)
            && self.recipes.open.as_deref() == Some(id.as_str());
        let status = recipe.status_line(Local::now());
        let dot = match recipe.state {
            RecipeState::On => Some(crate::activity_panels::system_green(cx)),
            RecipeState::SettingUp => Some(style::control_accent(cx)),
            _ => None,
        };
        let switch = self.recipe_switch(recipe, "row", cx);
        let (hover, selected) = (p.hover, p.selected);
        let open_id = id.clone();
        let head = tipped!(
            v_flex()
                .gap(px(3.))
                .pl(px(LEADING))
                .pr(px(TRAILING))
                .py(px(7.))
                .rounded(px(6.))
                .when(lit, move |s| s.bg(selected))
                .when(!lit, move |s| s.hover(move |s| s.bg(hover))),
            ElementId::Name(format!("recipe-row-{id}").into()),
            format!("Open {}'s page", recipe.name),
            gpui_kit::Role::ListItem
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            this.show_recipes(Some(open_id.clone()), cx)
        }))
        .child(
            h_flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .flex_none()
                        .text_size(px(15.))
                        .child(recipe.icon.clone()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(style::size::SIDEBAR_TITLE))
                        .line_height(px(17.))
                        .font_semibold()
                        .text_color(p.fg)
                        .child(recipe.name.clone()),
                )
                .child(switch),
        )
        .child(
            h_flex()
                .items_center()
                .gap(px(6.))
                .when_some(dot, |s, c| {
                    s.child(div().flex_none().size(px(7.)).rounded_full().bg(c))
                })
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(style::size::SIDEBAR_PREVIEW))
                        .line_height(px(16.))
                        .text_color(p.secondary)
                        .child(status),
                ),
        );
        let mut row = v_flex().pt(px(4.)).child(head);
        // Setting up: its thread, to finish it.
        if let (RecipeState::SettingUp, Some(thread)) =
            (recipe.state, recipe.setup_thread_id.clone())
        {
            row = row.child(self.recipe_setup_line(
                format!("recipe-setup-{id}"),
                thread,
                "Its setup thread".to_owned(),
                "Open the thread setting it up".to_owned(),
                p,
                cx,
            ));
        }
        row.into_any_element()
    }

    /// A line under its recipe in the sidebar, behind a guide line: the
    /// thread setting it up.
    fn recipe_setup_line(
        &mut self,
        key: String,
        thread: String,
        line: String,
        tip: String,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (hover, guide) = (p.hover, p.guide);
        tipped!(
            h_flex()
                .ml(px(LEADING + 6.))
                .pl(px(10.))
                .pr(px(TRAILING))
                .py(px(4.))
                .gap(px(6.))
                .border_l_2()
                .border_color(guide)
                .hover(move |s| s.bg(hover)),
            ElementId::Name(key.into()),
            tip,
            gpui_kit::Role::Link
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
            this.open(thread.clone(), window, cx)
        }))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(style::size::SIDEBAR_PREVIEW))
                .line_height(px(16.))
                .text_color(p.secondary)
                .child(line),
        )
        .into_any_element()
    }

    /// A recipe's switch, or a spinner while its answer is on its way.
    fn recipe_switch(
        &mut self,
        recipe: &Recipe,
        place: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = recipe.id.clone();
        let busy = self.recipes.busy.contains(&format!("on:{id}"));
        let on = recipe.state.switch_on();
        let tip = match (recipe.state, on) {
            (RecipeState::SettingUp, _) => {
                "Being set up. Turn it off and it stays off once it's ready".to_owned()
            }
            (_, true) if recipe.instant => {
                "On. Turn it off and agents stop being told its habit".to_owned()
            }
            (_, false) if recipe.instant => {
                "Off. Turn it on and every thread's agent is told its habit".to_owned()
            }
            (_, true) => format!(
                "On. Turn it off to pause {}",
                if recipe.experiment.is_some() {
                    "it"
                } else {
                    "its schedules"
                }
            ),
            (_, false) => format!(
                "Off. Turn it on to {}",
                if recipe.experiment.is_some() {
                    "start it again"
                } else {
                    "resume its schedules"
                }
            ),
        };
        let me = cx.entity().downgrade();
        div()
            .id(ElementId::Name(
                format!("recipe-switch-{place}-{id}").into(),
            ))
            .flex_none()
            .test_support()
            .a11y_role(Role::GenericContainer)
            .aria_label(tip.clone())
            .tip(tip)
            // The row behind opens the page; the switch is its own.
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(|_, _, cx| cx.stop_propagation())
            .child(
                MacSwitch::new(SharedString::from(format!("recipe-on-{place}-{id}")), on)
                    .outside_form()
                    .disabled(busy)
                    .on_change(move |on, _, cx| {
                        let id = id.clone();
                        me.update(cx, |this, cx| this.set_recipe_on(id, on, cx))
                            .ok();
                    }),
            )
            .into_any_element()
    }

    // ---------------------------------------------------------- main panel

    /// The main panel: a recipe's page, or the gallery.
    pub(crate) fn render_recipes_home(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let page = self
            .recipes
            .open
            .clone()
            .and_then(|id| self.recipes.recipe(&id).cloned());
        let body = match page {
            Some(recipe) => self.render_recipe_page(recipe, cx),
            None => self.render_recipe_gallery(cx),
        };
        div()
            .id("recipes-home")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.recipes.home_scroll)
            .child(
                h_flex().w_full().justify_center().child(
                    v_flex()
                        .w_full()
                        .max_w(px(1180.))
                        .px(px(32.))
                        .pt(px(28.))
                        .pb(px(48.))
                        .gap(px(18.))
                        .child(body),
                ),
            )
            .into_any_element()
    }

    fn render_recipe_gallery(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let secondary = style::secondary_text(cx);
        let busy = self.recipes.busy.contains("new");
        let header = h_flex()
            .w_full()
            .items_start()
            .gap(px(10.))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(8.))
                    .child(div().text_size(px(24.)).line_height(px(29.)).font_semibold().child("Recipes"))
                    .child(div().text_size(px(style::size::LABEL)).line_height(px(17.)).text_color(secondary).child("Techniques worth keeping. Add one and an agent sets it up with you; switch it off and on whenever you like.")),
            )
            .child(div().mt(px(4.)).child(crate::projects_page::icon_push_button("recipes-new-home", "plus", "New recipe", "Write a recipe of your own with an agent", busy, cx, cx.listener(|this, _: &ClickEvent, _, cx| this.new_recipe(cx)))));
        let list = self.recipes.list.clone().unwrap_or_default();
        let body: AnyElement = if self.recipes.list.is_none() {
            div()
                .text_size(px(style::size::LABEL))
                .text_color(secondary)
                .child("Loading…")
                .into_any_element()
        } else if list.is_empty() {
            div()
                .text_size(px(style::size::LABEL))
                .text_color(secondary)
                .child("No recipes yet. Write one with New recipe.")
                .into_any_element()
        } else {
            self.render_recipe_cards(list, cx)
        };
        v_flex()
            .gap(px(22.))
            .child(header)
            .child(body)
            .into_any_element()
    }

    fn render_recipe_cards(&mut self, list: Vec<Recipe>, cx: &mut Context<Self>) -> AnyElement {
        let measured = GRID_WIDTH.with(|w| w.clone());
        let width = measured.get().max(CARD_MIN);
        let columns = (((width + CARD_GAP) / (CARD_MIN + CARD_GAP)).floor() as usize).clamp(1, 3);
        let card_width =
            ((width - CARD_GAP * (columns as f32 - 1.)) / columns as f32).min(CARD_MAX);
        let mut grid = h_flex()
            .w_full()
            .flex_wrap()
            .items_start()
            .gap_x(px(CARD_GAP))
            .gap_y(px(CARD_GAP));
        for recipe in list {
            grid = grid.child(self.render_recipe_card(recipe, card_width, cx));
        }
        let probe = measured;
        let notify = cx.entity().downgrade();
        div()
            .relative()
            .w_full()
            .child(grid)
            .child(
                canvas(
                    move |bounds, _, cx| {
                        let now = f32::from(bounds.size.width) / style::zoomed(1.);
                        if (probe.get() - now).abs() > 0.5 {
                            probe.set(now);
                            notify.update(cx, |_, cx| cx.notify()).ok();
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .into_any_element()
    }

    /// A card: its header with the icon on its edge, its name and tag, what
    /// it does and how it's been going. A click opens its page; + Add sets it
    /// up.
    fn render_recipe_card(
        &mut self,
        recipe: Recipe,
        width: f32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = recipe.id.clone();
        let card_bg = style::card_background(cx);
        let border = style::card_border(cx);
        let secondary = style::secondary_text(cx);
        let faint = style::faint_text(cx);
        let tag = self.recipe_tag(&recipe, "card", cx);
        let stat = recipe.stat_line();
        let open_id = id.clone();
        tipped!(
            v_flex()
                .w(px(width))
                .rounded(px(14.))
                .overflow_hidden()
                .bg(card_bg)
                .border_1()
                .border_color(border)
                .cursor_pointer(),
            ElementId::Name(format!("recipe-card-{id}").into()),
            format!("Open {}'s page", recipe.name),
            gpui_kit::Role::Button
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
            this.show_recipes(Some(open_id.clone()), cx)
        }))
        .child(
            div()
                .relative()
                .w_full()
                .h(px(CARD_HEADER))
                .child(header_fill(&recipe, 14.))
                .child(
                    icon_tile(&recipe, TILE, cx)
                        .absolute()
                        .left(px(16.))
                        .bottom(px(-TILE * 0.4)),
                ),
        )
        .child(
            v_flex()
                .px(px(16.))
                .pt(px(TILE * 0.4 + 12.))
                .pb(px(14.))
                .gap(px(6.))
                .child(
                    h_flex()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(16.))
                                .line_height(px(20.))
                                .font_semibold()
                                .child(recipe.name.clone()),
                        )
                        .child(tag),
                )
                .child(
                    div()
                        .h(px(60.))
                        .text_size(px(style::size::LABEL))
                        .line_height(px(19.))
                        .text_color(secondary)
                        .line_clamp(3)
                        .child(recipe.description.clone()),
                )
                .child(div().h(px(1.)).w_full().bg(border))
                .child(
                    div()
                        .h(px(16.))
                        .truncate()
                        .text_size(px(style::size::DETAIL))
                        .line_height(px(16.))
                        .text_color(faint)
                        .child(stat),
                ),
        )
        .into_any_element()
    }

    /// The card's tag: On, Off, Setting up, or the Add button.
    fn recipe_tag(&mut self, recipe: &Recipe, place: &str, cx: &mut Context<Self>) -> AnyElement {
        let id = recipe.id.clone();
        match recipe.state {
            RecipeState::Add => {
                let busy = self.recipes.busy.contains(&format!("add:{id}"));
                let link = style::link_text(cx);
                let tip = if recipe.instant {
                    format!(
                        "Add {}: every thread's agent is told its habit from now on",
                        recipe.name
                    )
                } else {
                    format!(
                        "Add {}: an agent sets it up with you in a new thread",
                        recipe.name
                    )
                };
                tipped!(
                    h_flex()
                        .flex_none()
                        .items_center()
                        .gap(px(4.))
                        .px(px(4.))
                        .text_size(px(style::size::LABEL))
                        .font_medium()
                        .text_color(link)
                        .when(!busy, |s| s.cursor_pointer()),
                    ElementId::Name(format!("recipe-add-{place}-{id}").into()),
                    tip
                )
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    cx.stop_propagation();
                    this.add_recipe(id.clone(), cx);
                }))
                .when(busy, |s| {
                    s.child(Spinner::new().color(link).with_size(px(11.)))
                })
                .child(if busy { "Adding" } else { "+ Add" })
                .into_any_element()
            }
            state => {
                let (color, dot) = match state {
                    RecipeState::On => (crate::activity_panels::system_green(cx), true),
                    RecipeState::SettingUp => (style::control_accent(cx), true),
                    _ => (style::faint_text(cx), false),
                };
                h_flex()
                    .flex_none()
                    .items_center()
                    .gap(px(5.))
                    .text_size(px(style::size::LABEL))
                    .text_color(color)
                    .when(dot, |s| {
                        s.child(div().size(px(7.)).rounded_full().bg(color))
                    })
                    .child(recipe.tag())
                    .into_any_element()
            }
        }
    }

    /// A recipe's page: the banner with its switch, the icon, its name and
    /// byline; what it does, an example of a run and what it set up on the
    /// left; its last 30 days and its log on the right.
    fn render_recipe_page(&mut self, recipe: Recipe, cx: &mut Context<Self>) -> AnyElement {
        let id = recipe.id.clone();
        let detail = self.recipes.details.get(&id).cloned();
        let secondary = style::secondary_text(cx);
        let faint = style::faint_text(cx);
        // The banner's corner: the switch once it's added, else Add.
        let corner: AnyElement = if recipe.state == RecipeState::Add {
            let busy = self.recipes.busy.contains(&format!("add:{id}"));
            let add_id = id.clone();
            div()
                .id("recipe-page-add")
                .test_support()
                .child(
                    Button::new("recipe-page-add-button")
                        .label("Add")
                        .primary()
                        .small()
                        .loading(busy)
                        .disabled(busy)
                        .tooltip(if recipe.instant {
                            "Every thread's agent is told its habit from now on"
                        } else {
                            "An agent sets it up with you in a new thread"
                        })
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.add_recipe(add_id.clone(), cx)),
                        ),
                )
                .into_any_element()
        } else {
            let label = if recipe.state.switch_on() {
                "On"
            } else {
                "Off"
            };
            let switch = self.recipe_switch(&recipe, "page", cx);
            h_flex()
                .items_center()
                .gap(px(8.))
                .px(px(12.))
                .py(px(6.))
                .rounded(px(10.))
                .bg(hsla(0., 0., 0., 0.35))
                .text_color(white())
                .text_size(px(style::size::LABEL))
                .child(label)
                .child(switch)
                .into_any_element()
        };
        let banner = div()
            .relative()
            .w_full()
            .h(px(170.))
            .mb(px(30.))
            .child(header_fill(&recipe, 16.))
            .child(div().absolute().top(px(16.)).right(px(16.)).child(corner))
            .child(
                icon_tile(&recipe, 84., cx)
                    .absolute()
                    .left(px(24.))
                    .bottom(px(-30.)),
            );
        let mut byline = recipe.byline();
        if byline.is_empty() {
            byline = if recipe.yours {
                "Yours".to_owned()
            } else {
                String::new()
            };
        }
        let mut left = v_flex()
            .flex_1()
            .min_w_0()
            .gap(px(10.))
            .child(
                div()
                    .text_size(px(28.))
                    .line_height(px(34.))
                    .font_semibold()
                    .child(recipe.name.clone()),
            )
            .when(!byline.is_empty(), |s| {
                s.child(
                    div()
                        .text_size(px(style::size::DETAIL))
                        .text_color(faint)
                        .child(byline.clone()),
                )
            });
        match &detail {
            Some(d) => {
                let about = if d.about.is_empty() {
                    recipe.description.clone()
                } else {
                    d.about.clone()
                };
                left = left.child(self.recipe_markdown(format!("recipe-about-{id}"), about, cx));
                if !d.examples.is_empty() {
                    // A habit doesn't run: its example is an exchange.
                    let title = if recipe.instant {
                        "What it looks like"
                    } else {
                        "What a run looks like"
                    };
                    left = left
                        .child(section_title(title))
                        .child(self.render_recipe_examples(&recipe, d, cx));
                }
            }
            None => {
                left = left.child(
                    div()
                        .text_size(px(style::size::LABEL))
                        .line_height(px(19.))
                        .text_color(secondary)
                        .child(recipe.description.clone()),
                )
            }
        }
        if recipe.habit.is_some() {
            left = left
                .child(section_title("What agents are told"))
                .child(self.render_recipe_habit(&recipe, cx));
        }
        // One that's only a habit sets nothing up and starts no threads.
        if !recipe.instant {
            left = left
                .child(section_title("What it set up"))
                .child(self.render_recipe_setup(&recipe, cx));
        }
        left = left.child(self.render_recipe_buttons(&recipe, cx));
        let right =
            (!recipe.instant).then(|| self.render_recipe_runs(&recipe, detail.as_ref(), cx));
        // Back to the gallery, from Browse or the sidebar alike.
        let back = h_flex().w_full().pb(px(12.)).child(
            tipped!(
                h_flex()
                    .items_center()
                    .gap(px(4.))
                    .px(px(6.))
                    .py(px(3.))
                    .ml(px(-6.))
                    .rounded(px(6.))
                    .text_size(px(style::size::LABEL))
                    .text_color(secondary)
                    .cursor_pointer()
                    .hover(|s| s.bg(style::hover_fill(cx))),
                "recipe-back",
                "Back to every recipe",
                gpui_kit::Role::Button
            )
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.show_recipes(None, cx)))
            .child(icon("chevron.left", 11., secondary))
            .child("All recipes"),
        );
        v_flex()
            .w_full()
            .child(back)
            .child(banner)
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .gap(px(28.))
                    .child(left)
                    .children(right),
            )
            .into_any_element()
    }

    fn recipe_markdown(&mut self, key: String, text: String, cx: &mut Context<Self>) -> AnyElement {
        let base = std::env::var("HOME").unwrap_or_default();
        crate::open_gate::reading_markdown_view(
            SharedString::from(key),
            text,
            crate::open_gate::Origin::ThisMac,
            &base,
        )
        .selectable(true)
        .style(crate::rows::reading_style(cx))
        .into_any_element()
    }

    /// Its made-up runs, one at a time, each as its thread would look: the
    /// thread's title, what the user said, the agent's reply and its card,
    /// in a box of its own that scrolls. Dots under it flip between them.
    fn render_recipe_examples(
        &mut self,
        recipe: &Recipe,
        detail: &RecipeDetail,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = recipe.id.clone();
        let count = detail.examples.len();
        let at = self
            .recipes
            .example_at
            .get(&id)
            .copied()
            .unwrap_or(0)
            .min(count.saturating_sub(1));
        let example = detail.examples[at].clone();
        let faint = style::faint_text(cx);
        let secondary = style::secondary_text(cx);
        let label = style::label_text(cx);
        let border = style::card_border(cx);
        let hairline = style::hairline(cx);
        // The thread's bar: its title, and what started it.
        let mut bar = v_flex()
            .px(px(18.))
            .py(px(10.))
            .gap(px(2.))
            .border_b_1()
            .border_color(hairline)
            .child(
                div()
                    .truncate()
                    .text_size(px(style::size::CARD_TITLE))
                    .font_semibold()
                    .text_color(label)
                    .child(example.title_or(recipe).to_owned()),
            );
        if !recipe.instant {
            bar = bar.child(
                div()
                    .text_size(px(style::size::DETAIL))
                    .text_color(faint)
                    .child("Started by its schedule"),
            );
        }
        let mut body = v_flex().px(px(18.)).pt(px(14.)).pb(px(18.)).gap(px(14.));
        if let Some(you) = example.you.clone() {
            body = body.child(
                h_flex().w_full().justify_end().child(
                    div()
                        .max_w(relative(crate::rows::metrics::BUBBLE_SHARE))
                        .px(px(crate::rows::metrics::BUBBLE_PAD_H))
                        .py(px(crate::rows::metrics::BUBBLE_PAD_V))
                        .rounded(px(crate::rows::metrics::BUBBLE_RADIUS))
                        .bg(style::bubble_background(cx))
                        .text_size(px(style::size::BODY))
                        .line_height(px(style::size::BODY_LINE))
                        .text_color(label)
                        .child(you),
                ),
            );
        }
        if !example.reply.is_empty() {
            body = body.child(
                crate::open_gate::reading_markdown_view(
                    SharedString::from(format!("recipe-example-{id}-{at}")),
                    example.reply.clone(),
                    crate::open_gate::Origin::ThisMac,
                    &std::env::var("HOME").unwrap_or_default(),
                )
                .selectable(true)
                .style(crate::rows::reading_style(cx)),
            );
        }
        if let Some(card) = example.card {
            body = body.child(example_card(card, cx));
        }
        let thread = v_flex()
            .w_full()
            .rounded(px(12.))
            .border_1()
            .border_color(border)
            .bg(style::code_background(cx))
            .overflow_hidden()
            .child(bar)
            .child(
                div()
                    .id(ElementId::Name(
                        format!("recipe-example-scroll-{id}").into(),
                    ))
                    .h(px(EXAMPLE_HEIGHT))
                    .overflow_y_scroll()
                    .track_scroll(&self.recipes.example_scroll)
                    .child(body),
            );
        // Under it: the note, and the dots with a chevron each side.
        let mut nav = h_flex().items_center().gap(px(6.));
        if count > 1 {
            let chevron = |key: &'static str,
                           symbol: &'static str,
                           tip: &'static str,
                           by: isize,
                           enabled: bool,
                           cx: &mut Context<Self>|
             -> AnyElement {
                let id = id.clone();
                let color = if enabled { secondary } else { hairline };
                tipped!(
                    div()
                        .flex_none()
                        .p(px(3.))
                        .rounded(px(4.))
                        .when(enabled, |s| s.cursor_pointer()),
                    ElementId::Name(format!("recipe-example-{key}").into()),
                    tip,
                    gpui_kit::Role::Button
                )
                .on_click(
                    cx.listener(move |this, _: &ClickEvent, _, cx| this.flip_example(&id, by, cx)),
                )
                .child(icon(symbol, 11., color))
                .into_any_element()
            };
            nav = nav.child(chevron(
                "prev",
                "chevron.left",
                "The example before",
                -1,
                at > 0,
                cx,
            ));
            for n in 0..count {
                let id = id.clone();
                let filled = n == at;
                nav =
                    nav.child(
                        tipped!(
                            div().flex_none().p(px(3.)).cursor_pointer(),
                            ElementId::Name(format!("recipe-example-dot-{n}").into()),
                            rules::example_tip(n, count),
                            gpui_kit::Role::Button
                        )
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.show_example(&id, n, cx)
                        }))
                        .child(
                            div()
                                .size(px(7.))
                                .rounded_full()
                                .when(filled, |d| d.bg(label))
                                .when(!filled, |d| d.border_1().border_color(secondary)),
                        ),
                    );
            }
            nav = nav.child(chevron(
                "next",
                "chevron.right",
                "The next example",
                1,
                at + 1 < count,
                cx,
            ));
        }
        v_flex()
            .gap(px(8.))
            .child(thread)
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(style::size::DETAIL))
                            .text_color(faint)
                            .child("An example, not yours"),
                    )
                    .child(nav),
            )
            .into_any_element()
    }

    fn show_example(&mut self, id: &str, n: usize, cx: &mut Context<Self>) {
        self.recipes.example_at.insert(id.to_owned(), n);
        self.recipes.example_scroll.set_offset(Point::default());
        cx.notify();
    }

    fn flip_example(&mut self, id: &str, by: isize, cx: &mut Context<Self>) {
        let count = self.recipes.details.get(id).map_or(0, |d| d.examples.len());
        let at = self.recipes.example_at.get(id).copied().unwrap_or(0);
        self.show_example(id, rules::step_example(at, by, count), cx);
    }

    /// Its habit, word for word, with whether agents are being told it and
    /// what it adds to every thread. When its file's wording isn't the one
    /// switched on, both show, with a button that takes the new one.
    fn render_recipe_habit(&mut self, recipe: &Recipe, cx: &mut Context<Self>) -> AnyElement {
        let Some(habit) = recipe.habit.clone() else {
            return div().into_any_element();
        };
        let id = recipe.id.clone();
        let faint = style::faint_text(cx);
        let secondary = style::secondary_text(cx);
        let border = style::card_border(cx);
        let code_bg = style::code_background(cx);
        let stale = recipe.habit_stale();
        let quote = |text: String| {
            div()
                .p(px(14.))
                .rounded(px(12.))
                .border_1()
                .border_color(border)
                .bg(code_bg)
                .text_size(px(style::size::LABEL))
                .line_height(px(19.))
                .child(text)
        };
        let mut col = v_flex()
            .id(ElementId::Name(format!("recipe-habit-{id}").into()))
            .test_support()
            .gap(px(8.));
        if let Some(old) = habit.given_text.clone().filter(|_| stale) {
            col = col
                .child(
                    div()
                        .text_size(px(style::size::DETAIL))
                        .text_color(faint)
                        .child("What agents are told now"),
                )
                .child(quote(old).text_color(secondary))
                .child(
                    div()
                        .text_size(px(style::size::DETAIL))
                        .text_color(faint)
                        .child("The new wording"),
                );
        }
        col = col.child(quote(habit.text));
        let line = recipe.habit_line().unwrap_or_default();
        let mut foot = h_flex().items_center().gap(px(10.)).child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(style::size::DETAIL))
                .line_height(px(16.))
                .text_color(if stale {
                    crate::activity_panels::system_orange(cx)
                } else {
                    faint
                })
                .child(line),
        );
        if stale {
            let busy = self.recipes.busy.contains(&format!("on:{id}"));
            let take_id = id;
            foot = foot.child(
                div().id("recipe-habit-take").test_support().child(
                    Button::new("recipe-habit-take-button")
                        .label("Use the new wording")
                        .small()
                        .secondary()
                        .loading(busy)
                        .disabled(busy)
                        .tooltip("Tell every thread's agent this wording from now on")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.set_recipe_on(take_id.clone(), true, cx)
                        })),
                ),
            );
        }
        col.child(foot).into_any_element()
    }

    /// Its schedules and its experiment, or what adding it will do.
    fn render_recipe_setup(&mut self, recipe: &Recipe, cx: &mut Context<Self>) -> AnyElement {
        let secondary = style::secondary_text(cx);
        let card_bg = style::card_background(cx);
        let card = |title: String, line: String, symbol: &'static str| {
            v_flex()
                .gap(px(4.))
                .p(px(14.))
                .rounded(px(12.))
                .bg(card_bg)
                .child(
                    h_flex()
                        .gap(px(6.))
                        .items_center()
                        .child(icon(symbol, 13., secondary))
                        .child(
                            div()
                                .text_size(px(style::size::CARD_TITLE))
                                .font_semibold()
                                .child(title),
                        ),
                )
                .child(
                    div()
                        .text_size(px(style::size::LABEL))
                        .line_height(px(18.))
                        .text_color(secondary)
                        .child(line),
                )
        };
        let mut col = v_flex().gap(px(10.));
        let now = Local::now();
        for s in &recipe.schedules {
            let next = match (s.paused, s.next_run_ms) {
                (true, _) => "paused".to_owned(),
                (false, Some(at)) => {
                    format!("next {}", threadbear_core::schedules::full_time(at, &Local))
                }
                (false, None) => "no more runs".to_owned(),
            };
            let line = if s.when_text.is_empty() {
                next
            } else {
                format!("{} · {next}", s.when_text)
            };
            col = col.child(card(
                format!(
                    "A schedule: {}",
                    if s.title.is_empty() {
                        recipe.name.clone()
                    } else {
                        s.title.clone()
                    }
                ),
                line,
                "clock",
            ));
        }
        let _ = now;
        if let Some(exp) = &recipe.experiment {
            let on = recipe.state.switch_on();
            col = col.child(card(
                "A runner feature".to_owned(),
                format!(
                    "The {exp} experiment, {} with this switch",
                    if on { "on" } else { "off" }
                ),
                "gearshape",
            ));
        }
        if recipe.schedules.is_empty() && recipe.experiment.is_none() {
            let line = match recipe.state {
                RecipeState::Add => {
                    "Nothing yet. Adding it starts a thread where an agent sets it up with you."
                }
                RecipeState::SettingUp => "Nothing yet. Its setup thread is still at it.",
                _ => "Nothing the runner knows of.",
            };
            col = col.child(
                div()
                    .text_size(px(style::size::LABEL))
                    .text_color(secondary)
                    .child(line),
            );
        }
        col.into_any_element()
    }

    fn render_recipe_buttons(&mut self, recipe: &Recipe, cx: &mut Context<Self>) -> AnyElement {
        let id = recipe.id.clone();
        let changing = self.recipes.busy.contains(&format!("change:{id}"));
        let removing = self.recipes.busy.contains(&format!("remove:{id}"));
        let change_id = id.clone();
        let mut row = h_flex().gap(px(8.)).pt(px(6.)).child(
            div().id("recipe-change").test_support().child(
                Button::new("recipe-change-button")
                    .label("Change it with an agent")
                    .small()
                    .secondary()
                    .loading(changing)
                    .disabled(changing)
                    .tooltip(if recipe.yours {
                        "Start a thread where an agent changes it with you"
                    } else {
                        "Start a thread where an agent makes a changed copy of it, yours to keep"
                    })
                    .on_click(
                        cx.listener(move |this, _, _, cx| {
                            this.change_recipe(change_id.clone(), cx)
                        }),
                    ),
            ),
        );
        if recipe.state.added() {
            let remove_id = id;
            row = row.child(
                div().id("recipe-remove").test_support().child(
                    Button::new("recipe-remove-button")
                        .label("Remove")
                        .small()
                        .secondary()
                        .loading(removing)
                        .disabled(removing)
                        .tooltip(
                            "Delete its schedules, stop its habit and take it back to the gallery. Its files stay",
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.remove_recipe(remove_id.clone(), window, cx)
                        })),
                ),
            );
        }
        row.into_any_element()
    }

    /// The right of the page: the last 30 days, its numbers and its log.
    fn render_recipe_runs(
        &mut self,
        recipe: &Recipe,
        detail: Option<&RecipeDetail>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let secondary = style::secondary_text(cx);
        let faint = style::faint_text(cx);
        let card_bg = style::card_background(cx);
        let green = crate::activity_panels::system_green(cx);
        let orange = crate::activity_panels::system_orange(cx);
        let quiet = style::hairline(cx);
        let runs = detail.map(|d| d.runs.clone()).unwrap_or_default();
        let days = rules::strip(&runs, Local::now());
        // Two rows of fifteen, oldest first, each square sharing the width.
        let mut strip = v_flex().w_full().gap(px(4.));
        for half in days.chunks(rules::DAYS / 2) {
            let mut row = h_flex().w_full().gap(px(4.));
            for day in half {
                let color = match day {
                    Day::NeededYou => orange,
                    Day::Ran => green,
                    Day::Quiet => quiet,
                };
                row = row.child(div().flex_1().h(px(18.)).rounded(px(4.)).bg(color));
            }
            strip = strip.child(row);
        }
        let key = |color: Hsla, label: &'static str| {
            h_flex()
                .gap(px(5.))
                .items_center()
                .child(div().size(px(9.)).rounded(px(2.)).bg(color))
                .child(label)
        };
        let legend = h_flex()
            .gap(px(12.))
            .text_size(px(style::size::DETAIL))
            .text_color(faint)
            .child(key(green, "ran"))
            .child(key(orange, "needed you"))
            .child(key(quiet, "no run"));
        let numbers = match detail {
            Some(d) => d.numbers(),
            None => [
                (recipe.stats.runs, "runs"),
                (recipe.stats.needed_you, "needed you"),
                (recipe.stats.seen, "you opened"),
            ],
        };
        let mut tiles = h_flex().w_full().gap(px(8.));
        for (n, label) in numbers {
            tiles = tiles.child(
                v_flex()
                    .flex_1()
                    .p(px(10.))
                    .rounded(px(10.))
                    .bg(card_bg)
                    .child(
                        div()
                            .text_size(px(20.))
                            .font_semibold()
                            .child(n.to_string()),
                    )
                    .child(
                        div()
                            .text_size(px(style::size::DETAIL))
                            .text_color(faint)
                            .child(label),
                    ),
            );
        }
        let mut log = v_flex();
        if runs.is_empty() {
            log = log.child(
                div()
                    .py(px(6.))
                    .text_size(px(style::size::LABEL))
                    .text_color(secondary)
                    .child(if recipe.state.added() {
                        "No runs in the last 30 days."
                    } else {
                        "It hasn't run here yet."
                    }),
            );
        }
        let hairline = style::hairline(cx);
        let link = style::link_text(cx);
        for run in runs.iter().take(12) {
            let thread = run.thread_id.clone();
            let line = match &run.headline {
                Some(h) => format!("{} · {h}", rules::log_time(run.at_ms)),
                None => format!("{} · {}", rules::log_time(run.at_ms), run.title),
            };
            let dot = if run.needs_you { orange } else { green };
            log = log.child(
                h_flex()
                    .py(px(7.))
                    .gap(px(8.))
                    .items_center()
                    .border_b_1()
                    .border_color(hairline)
                    .child(div().flex_none().size(px(8.)).rounded_full().bg(dot))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(style::size::LABEL))
                            .child(line),
                    )
                    .child(
                        tipped!(
                            div()
                                .flex_none()
                                .text_size(px(style::size::LABEL))
                                .text_color(link)
                                .cursor_pointer(),
                            ElementId::Name(format!("recipe-log-{}", run.thread_id).into()),
                            "Open this run's thread",
                            gpui_kit::Role::Link
                        )
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.open(thread.clone(), window, cx)
                        }))
                        .child("Open"),
                    ),
            );
        }
        v_flex()
            .w(relative(0.42))
            .flex_none()
            .gap(px(10.))
            .child(section_title("Runs, last 30 days"))
            .child(strip)
            .child(legend)
            .child(tiles)
            .child(section_title("Log"))
            .child(log)
            .into_any_element()
    }

    /// The view in the dump: the sidebar's rows, the gallery's cards or the
    /// page that's open.
    #[cfg(feature = "automation")]
    pub(crate) fn recipes_dump(&self) -> Value {
        let row = |r: &Recipe| json!({ "id": r.id, "name": r.name, "state": r.state.name(), "status": r.status_line(Local::now()), "tag": r.tag(), "stat": r.stat_line(), "habit": r.habit_line() });
        let list = self.recipes.list.clone().unwrap_or_default();
        json!({
            "loaded": self.recipes.list.is_some(),
            "onCount": rules::on_count(&list),
            "sidebar": rules::added(&list).into_iter().map(row).collect::<Vec<_>>(),
            "cards": list.iter().map(row).collect::<Vec<_>>(),
            "open": self.recipes.open,
            "busy": self.recipes.busy.iter().collect::<Vec<_>>(),
            "page": self.recipes.open.as_ref().and_then(|id| self.recipes.details.get(id)).map(|d| json!({
                "id": d.recipe.id,
                "numbers": d.numbers().iter().map(|(n, l)| json!({ "value": n, "label": l })).collect::<Vec<_>>(),
                "runs": d.runs.len(),
                "example": !d.examples.is_empty(),
                "examples": d.examples.len(),
                "exampleAt": self.recipes.example_at.get(&d.recipe.id).copied().unwrap_or(0),
            })),
        })
    }
}

/// The sidebar's buttons over the list (`SidebarButtonRow`): a plus or a
/// grid where a row's title starts.
#[expect(
    clippy::too_many_arguments,
    reason = "baselined when the lint was turned on (20 Nov 2026); take it off when this is next split up"
)]
fn sidebar_button(
    id: &'static str,
    symbol: &'static str,
    label: &'static str,
    tip: &'static str,
    busy: bool,
    lit: bool,
    p: &Palette,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let (hover, selected, secondary, fg) = (p.hover, p.selected, p.secondary, p.fg);
    let mark: AnyElement = if busy {
        Spinner::new()
            .color(secondary)
            .with_size(px(12.))
            .into_any_element()
    } else {
        icon(symbol, style::size::SIDEBAR_BUTTON, secondary).into_any_element()
    };
    tipped!(
        h_flex()
            .gap(px(8.))
            .pl(px(LEADING - 2.))
            .pr(px(TRAILING))
            .py(px(7.))
            .rounded(px(6.))
            .when(lit, move |s| s.bg(selected))
            .when(!lit, move |s| s.hover(move |s| s.bg(hover))),
        id,
        tip
    )
    .when(!busy, |s| s.on_click(on_click))
    .child(div().w(px(16.)).flex().justify_center().child(mark))
    .child(
        div()
            .text_size(px(style::size::SIDEBAR_BUTTON))
            .line_height(px(17.))
            .text_color(fg)
            .child(label),
    )
}

fn section_title(text: &'static str) -> impl IntoElement {
    div()
        .pt(px(10.))
        .text_size(px(16.))
        .line_height(px(20.))
        .font_semibold()
        .child(text)
}

/// The header: its picture when it has one on this Mac, else its colour
/// fading darker.
fn header_fill(recipe: &Recipe, radius: f32) -> AnyElement {
    let (a, b) = recipe.header_colors();
    let gradient = linear_gradient(
        135.,
        linear_color_stop(Hsla::from(rgb(a)), 0.),
        linear_color_stop(Hsla::from(rgb(b)), 1.),
    );
    let fill = div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .rounded_t(px(radius))
        .bg(gradient);
    match recipe
        .header
        .as_ref()
        .filter(|p| std::path::Path::new(p).is_file())
    {
        Some(path) => fill
            .overflow_hidden()
            .child(
                img(crate::fit_picture::icon_source(path))
                    .size_full()
                    .object_fit(ObjectFit::Cover),
            )
            .into_any_element(),
        None => fill.into_any_element(),
    }
}

/// The icon on a rounded tile, on the header's bottom edge.
fn icon_tile(recipe: &Recipe, size: f32, cx: &App) -> Div {
    let fill = if cx.theme().is_dark() {
        hsla(240. / 360., 0.04, 0.12, 1.)
    } else {
        hsla(0., 0., 0.98, 1.)
    };
    div()
        .size(px(size))
        .rounded(px(size * 0.25))
        .bg(fill)
        .shadow_md()
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(size * 0.52))
        .child(recipe.icon.clone())
}

/// An example's end card, as the thread's card draws an ask: its words, then
/// its answers in a box of rows. Only to look at here.
fn example_card(card: rules::ExampleCard, cx: &App) -> Div {
    let label = style::label_text(cx);
    let secondary = style::secondary_text(cx);
    let hairline = style::hairline(cx);
    let mut rows = v_flex()
        .mt(px(6.))
        .rounded(px(3.))
        .overflow_hidden()
        .bg(style::answer_rows_fill(cx))
        .border_1()
        .border_color(style::primary_opacity(cx, 0.05));
    for (n, option) in card.options.iter().enumerate() {
        rows = rows.child(
            h_flex()
                .w_full()
                .items_center()
                .gap(px(8.))
                .px(px(10.))
                .py(px(7.))
                .when(n > 0, |s| {
                    s.border_t_1()
                        .border_color(style::primary_opacity(cx, 0.055))
                })
                .child(
                    div()
                        .flex_none()
                        .size(px(13.))
                        .rounded_full()
                        .border_1()
                        .border_color(secondary),
                )
                .child(
                    div()
                        .text_size(px(style::size::BODY))
                        .text_color(label)
                        .child(option.clone()),
                ),
        );
    }
    let mut boxed = v_flex()
        .mt(px(4.))
        .pt(px(12.))
        .border_t_1()
        .border_color(hairline)
        .child(
            div()
                .text_size(px(style::size::BODY))
                .line_height(px(style::size::BODY_LINE))
                .font_semibold()
                .text_color(label)
                .child(card.headline),
        );
    if !card.options.is_empty() {
        boxed = boxed.child(rows);
    }
    boxed
}
