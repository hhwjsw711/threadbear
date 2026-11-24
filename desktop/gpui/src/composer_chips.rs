// The row under the composer's text: "+" (pictures and the folder), the
// account, model and permission chips and the context ring (ComposerControls.swift).
// The numbers are the Swift app's, at 100% zoom.
use crate::app::Threadbear;
use crate::composer::Composer;
use crate::style::{self, size};
use gpui_kit::assets::IconName;
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::popover::Popover;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Icon, Selectable, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use threadbear_core::new_thread::ChipBadge;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::style::px;
use crate::tips::Tip as _;
use gpui_kit::component::WindowExt as _;
use serde_json::json;
use threadbear_core::composer::{effort_porridge, effort_title, ContextMeter};
use threadbear_core::inbox::ThreadSummary;
use threadbear_core::logins::{
    permission_help, permission_title, ChipSettings, PickerRow, PickerSection, RunnerLogins,
    UNPOOLED_COLUMN,
};

/// What a chip row needs to know, read when it's drawn.
pub(crate) struct ChipData {
    pub(crate) summary: Option<ThreadSummary>,
    pub(crate) logins: RunnerLogins,
    /// The new-thread page's box: these are what its settings start from.
    pub(crate) is_new: bool,
    /// Another runner's thread, or a new one for another runner.
    pub(crate) away: Option<AwayRunner>,
    /// That runner's id, None for this Mac's: where a Use a reset goes.
    pub(crate) runner: Option<String>,
}

/// The other runner a box's thread (or new draft) is on (`ComposerControls`).
pub(crate) struct AwayRunner {
    pub(crate) name: String,
    pub(crate) icon: &'static str,
    /// "On bruce", or "On bruce, offline".
    pub(crate) place: String,
    /// Its logins have come (`remoteLogins`); until then just its name.
    pub(crate) logins_known: bool,
    pub(crate) cwd: String,
}

impl ChipData {
    fn settings(&self) -> Option<ChipSettings<'_>> {
        let thread = self.summary.as_ref()?;
        Some(ChipSettings {
            logins: &self.logins,
            account: thread.account_id.clone(),
            provider: if thread.provider.is_empty() {
                "claude".to_owned()
            } else {
                thread.provider.clone()
            },
            pool_id: thread.pool_id.clone(),
            model: thread.model.clone(),
            model_in_use: thread.model_in_use.clone(),
            effort: thread.effort.clone(),
            effort_in_use: thread.effort_in_use.clone(),
            permission_mode: if thread.permission_mode.is_empty() {
                "full".to_owned()
            } else {
                thread.permission_mode.clone()
            },
            cwd: thread.cwd.clone(),
            is_new: self.is_new,
        })
    }
}

impl Composer {
    /// The chips for the box's thread: `app.threads` (with `update_thread`'s
    /// guess) first, as it's what a click just changed, then the pane's copy.
    /// For the new-thread page's box, what the draft is set to.
    pub(crate) fn chip_data(&self, cx: &App) -> ChipData {
        let Some(app) = self.app.upgrade() else {
            return ChipData {
                summary: None,
                logins: RunnerLogins::default(),
                is_new: self.thread_id.is_none(),
                away: None,
                runner: None,
            };
        };
        let t = app.read(cx);
        if self.thread_id.is_none() {
            let away = t.new_thread.picks.runner.clone().map(|runner| AwayRunner {
                name: t.runner_name_of(&runner),
                icon: t.runner_icon_symbol(Some(&runner)),
                place: t.runner_place_of(&runner),
                logins_known: t.remote.logins.contains_key(&runner),
                cwd: t.draft_summary().cwd,
            });
            return ChipData {
                summary: Some(t.draft_summary()),
                logins: t.draft_logins(),
                is_new: true,
                away,
                runner: t.new_thread.picks.runner.clone(),
            };
        }
        let summary = self
            .thread_id
            .as_ref()
            .and_then(|id| t.threads.get(id).map(|t| ThreadSummary::clone(t)))
            .or_else(|| self.pane.upgrade().map(|p| p.read(cx).summary.clone()));
        let runner = summary.as_ref().and_then(|s| s.runner_id.clone());
        let (logins, away) = match runner.clone() {
            None => (t.logins.clone(), None),
            // Another runner's thread: its Mac's logins, once they've come.
            Some(runner) => {
                let known = t.remote.logins.get(&runner).cloned();
                let away = AwayRunner {
                    name: t.runner_name_of(&runner),
                    icon: t.runner_icon_symbol(Some(&runner)),
                    place: t.runner_place_of(&runner),
                    logins_known: known.is_some(),
                    cwd: summary.as_ref().map_or_else(String::new, |s| s.cwd.clone()),
                };
                (known.unwrap_or_default(), Some(away))
            }
        };
        ChipData {
            summary,
            logins,
            is_new: false,
            away,
            runner,
        }
    }

    /// Whether this box's thread has a login or pool change (first) or a
    /// folder change (second) on its way to the runner.
    pub(crate) fn chips_busy(&self, cx: &App) -> (bool, bool) {
        let (Some(id), Some(app)) = (&self.thread_id, self.app.upgrade()) else {
            return (false, false);
        };
        let busy = &app.read(cx).chip_busy;
        (
            busy.contains(&format!("moving/{id}")),
            busy.contains(&format!("movingFolder/{id}")),
        )
    }

    /// `threads.update` for this box's thread, shown at once (`update_thread_from_box`);
    /// on the new-thread page's box, the draft's settings instead. The box's
    /// own thread, never the main panel's: in a thread's own panel they
    /// differ (23 Nov review).
    fn change_thread(
        &self,
        change: impl FnOnce(&mut ThreadSummary),
        params: serde_json::Value,
        cx: &mut App,
    ) {
        let thread = self.thread_id.clone();
        // A move picked from the limit box's Continue now carries on there
        // at once (`carryOn`), Carry on by itself or not, and the box goes
        // straight away. Not a model or effort change on the same login,
        // which has nothing to carry on with.
        let mut params = params;
        let moves = params
            .get("accountId")
            .is_some_and(serde_json::Value::is_string)
            || params
                .get("poolId")
                .is_some_and(serde_json::Value::is_string);
        let carry_on = self.carry_on_pick && moves && thread.is_some();
        if carry_on {
            params["carryOn"] = json!(true);
        }
        let change = move |t: &mut ThreadSummary| {
            change(t);
            if carry_on {
                t.waiting_for_room = None;
            }
        };
        if let Some(app) = self.app.upgrade() {
            app.update(cx, |app, cx| match thread {
                Some(id) => app.update_thread_from_box(&id, change, params, cx),
                None => app.change_new_draft(&params, cx),
            });
        }
    }

    pub(crate) fn set_permission(&mut self, mode: &'static str, cx: &mut App) {
        self.change_thread(
            move |t| t.permission_mode = mode.to_owned(),
            json!({ "permissionMode": mode }),
            cx,
        );
    }

    fn set_model(&self, model: Option<String>, cx: &mut App) {
        let local = model.clone();
        self.change_thread(move |t| t.model = local, json!({ "model": model }), cx);
    }

    fn set_effort(&self, level: String, cx: &mut App) {
        let local = level.clone();
        self.change_thread(
            move |t| t.effort = Some(local),
            json!({ "effort": level }),
            cx,
        );
    }

    fn set_cwd(&self, folder: String, cx: &mut App) {
        let local = folder.clone();
        self.change_thread(move |t| t.cwd = local, json!({ "cwd": folder }), cx);
    }

    pub(crate) fn set_account(&self, account: String, cx: &mut App) {
        let local = account.clone();
        self.change_thread(
            move |t| t.account_id = local,
            json!({ "accountId": account }),
            cx,
        );
    }

    /// A pick from a provider column or pool that isn't the thread's own
    /// (ThreadSettings.pick): the model moves with it. Without pools a
    /// provider's column moves the thread to that provider's account.
    fn pick_model(
        &self,
        row: &PickerRow,
        column: &str,
        provider: &str,
        data: &ChipData,
        cx: &mut App,
    ) {
        let Some(settings) = data.settings() else {
            return;
        };
        let model = (!row.is_default).then(|| row.id.clone());
        if settings.uses_pools() {
            if column == UNPOOLED_COLUMN {
                if settings.is_pinned_to_unpooled() && provider == settings.provider {
                    return self.set_model(model, cx);
                }
                let Some(account_id) = threadbear_core::new_thread::pick_unpooled_login(
                    &data.logins.pools,
                    &data.logins.accounts,
                    provider,
                    None,
                ) else {
                    return;
                };
                // Name the row's model explicitly on a move so the star
                // (runner's default for that provider) isn't cleared onto the
                // login's own default.
                let model = Some(row.id.clone());
                if data.is_new {
                    return self.change_thread(
                        |_| {},
                        json!({ "accountId": account_id, "model": model }),
                        cx,
                    );
                }
                let switched = (provider != settings.provider)
                    .then(|| provider_defaults(&data.logins, provider.to_owned()));
                let (guess_id, guess_model) = (account_id.clone(), model.clone());
                self.change_thread(
                    move |t| {
                        t.account_id = guess_id;
                        t.pool_id = None;
                        if let Some(to) = switched {
                            switch_provider(t, to);
                        }
                        t.model = guess_model;
                    },
                    json!({ "accountId": account_id, "model": model }),
                    cx,
                );
                return;
            }
            // The thread's own pool and provider, or its pinned login: just
            // the model (ThreadSettings.pick).
            if column == PINNED_COLUMN
                || (settings.pool().is_some_and(|p| p.id == column)
                    && provider == settings.provider)
            {
                return self.set_model(model, cx);
            }
            // A move names the row's model even when it's the starred one:
            // the star is the runner's default for that provider, and a null
            // model on a move clears it, so the thread would land on the
            // login's own default instead (Codex's and Gemini's review, 20 Nov).
            let model = Some(row.id.clone());
            // On a new thread the draft moves to that pool and the provider
            // of the section picked from (AppModel.choosePool); the model is
            // remembered under it.
            if data.is_new {
                return self.change_thread(
                    |_| {},
                    json!({ "poolId": column, "provider": provider, "model": model }),
                    cx,
                );
            }
            // Picks the pool, and in it the model, on the provider of the
            // section picked from: a pool with several providers' logins
            // would otherwise keep the thread's own, and model null (the
            // default row) names none.
            // A guess only on the thread's own provider: which login of
            // another one the runner picks can't be known, so its chip spins
            // as it was until the move lands, rather than pairing the new
            // pool or model with the old login's model and effort.
            let (pool, guess_pool, guess_model, same_provider) = (
                column.to_owned(),
                column.to_owned(),
                model.clone(),
                provider == settings.provider,
            );
            self.change_thread(
                move |t| {
                    if same_provider {
                        t.pool_id = Some(guess_pool);
                        t.model = guess_model;
                    }
                },
                json!({ "poolId": pool, "provider": provider, "model": model }),
                cx,
            );
            return;
        }
        let provider = settings.provider;
        if column == provider {
            return self.set_model(model, cx);
        }
        if let Some(account) = data
            .logins
            .accounts
            .iter()
            .find(|a| a.provider_id() == column)
        {
            let (id, guess_id, guess_provider, guess_model) = (
                account.id.clone(),
                account.id.clone(),
                column.to_owned(),
                model.clone(),
            );
            self.change_thread(
                move |t| {
                    t.account_id = guess_id;
                    t.provider = guess_provider;
                    t.model = guess_model;
                },
                json!({ "accountId": id, "model": model }),
                cx,
            );
        }
    }

    /// The folders "+" > Folder offers (ThreadSettings.recentFolders): this
    /// thread's, the default, then the ones most recently used, eight at most.
    /// Worked out when the menu opens, not at every render: it looks at every
    /// thread, and the box is drawn on every frame of a scroll.
    fn recent_folders(
        app: &WeakEntity<Threadbear>,
        current: &str,
        default_folder: &str,
        cx: &App,
    ) -> Vec<String> {
        let mut folders: Vec<String> = vec![current.to_owned(), default_folder.to_owned()];
        if let Some(app) = app.upgrade() {
            let mut threads: Vec<&ThreadSummary> =
                app.read(cx).threads.values().map(|t| &**t).collect();
            threads.sort_by_cached_key(|t| std::cmp::Reverse(t.activity_ms()));
            folders.extend(threads.into_iter().map(|t| t.cwd.clone()));
        }
        let mut out = Vec::new();
        for folder in folders {
            if !folder.is_empty() && !out.contains(&folder) {
                out.push(folder);
            }
            if out.len() == 8 {
                break;
            }
        }
        out
    }

    /// The "+" menu's folders for `composer-menu` (`plus`), or a click on one.
    #[cfg(feature = "automation")]
    pub(crate) fn plus_command(
        &mut self,
        click: Option<&str>,
        cx: &mut Context<Self>,
    ) -> Result<serde_json::Value, String> {
        let data = self.chip_data(cx);
        let current = data
            .summary
            .as_ref()
            .map(|t| t.cwd.clone())
            .unwrap_or_default();
        let folders = Self::recent_folders(&self.app, &current, &data.logins.defaults.cwd, cx);
        match click {
            Some(folder) => {
                let path = folders
                    .into_iter()
                    .find(|f| f == folder || abbreviate_home(f) == folder)
                    .ok_or_else(|| format!("no folder {folder} in the menu"))?;
                self.set_cwd(path, cx);
                Ok(json!("ok"))
            }
            None => Ok(json!(folders
                .iter()
                .map(|f| format!(
                    "{} {}",
                    if *f == current { "[x]" } else { "[ ]" },
                    abbreviate_home(f)
                ))
                .collect::<Vec<_>>())),
        }
    }

    /// The chips spinning on a change that hasn't landed, for the dump.
    #[cfg(feature = "automation")]
    pub(crate) fn busy_chips(&self, cx: &App) -> Vec<&'static str> {
        let (moving, folder) = self.chips_busy(cx);
        let pools = self
            .chip_data(cx)
            .settings()
            .is_some_and(|s| s.uses_pools());
        let mut out = Vec::new();
        if folder {
            out.push("plus");
        }
        if moving {
            if !pools {
                out.push("account");
            }
            out.push("model");
        }
        out
    }

    /// Picks files for "+" > Attach images or Markdown… (ComposerView.chooseImages),
    /// and for ⇧⌘A.
    pub(crate) fn attach_images(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = crate::composer_media::choose_images(window, cx);
        cx.spawn_in(window, async move |this, cx| match paths.await {
            Ok(Some(paths)) => {
                this.update_in(cx, |this, window, cx| this.take_paths(paths, window, cx))
                    .ok();
            }
            Ok(None) => {}
            Err(error) => {
                this.update_in(cx, |_, window, cx| window.push_notification(error, cx))
                    .ok();
            }
        })
        .detach();
    }

    /// "+" > Folder > Choose… (ThreadSettings.chooseFolder).
    fn choose_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(mut paths))) = paths.await {
                if let Some(path) = paths.pop() {
                    this.update_in(cx, |this, _, cx| {
                        this.set_cwd(path.to_string_lossy().into_owned(), cx)
                    })
                    .ok();
                }
            }
        })
        .detach();
    }

    // ---- The row ----

    /// The ordinary pool/model menu rendered as dialog form fields. Project
    /// coordinators belong to this runner and always use its permissions.
    pub(crate) fn render_coordinator_picker(
        &mut self,
        busy: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let data = self.chip_data(cx);
        let Some(settings) = data.settings() else {
            return div().into_any_element();
        };
        let uses_pools = settings.uses_pools();
        let field_busy = busy || self.chips_busy(cx).0;
        let label_color = style::secondary_text(cx);
        let label = move |text: &'static str| {
            div()
                .w(px(48.))
                .flex_none()
                .text_right()
                .text_size(px(size::LABEL))
                .text_color(label_color)
                .child(text)
        };
        let mut rows = v_flex().w_full().gap(px(10.));
        if !uses_pools {
            let composer = cx.entity().downgrade();
            let trigger = CoordinatorFieldTrigger {
                id: "coordinator-account-field".into(),
                title: settings.account_chip_title().into(),
                icon: Icon::from(IconName::CircleUser),
                accent_icon: false,
                tip: settings.account_chip_help().into(),
                badge: settings.account_badge(),
                busy: field_busy,
                selected: false,
            };
            let field = if field_busy {
                trigger.into_any_element()
            } else {
                Popover::new("coordinator-account")
                    .trigger_style(StyleRefinement::default().w_full().min_w_0())
                    .anchor(Anchor::BottomCenter)
                    .trigger(trigger)
                    .content(move |_, window, cx| {
                        crate::composer_account::picker(composer.clone(), window, cx)
                    })
                    .into_any_element()
            };
            rows = rows.child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap(px(12.))
                    .child(label("Login"))
                    .child(div().flex_1().min_w_0().child(field)),
            );
        }
        let model_trigger = CoordinatorFieldTrigger {
            id: "coordinator-model-field".into(),
            title: settings.model_chip_title().into(),
            icon: model_chip_icon(&settings),
            accent_icon: uses_pools && settings.pool().is_some(),
            tip: settings.model_chip_help().into(),
            badge: settings.model_chip_badge(),
            busy: field_busy,
            selected: false,
        };
        let model_field = if field_busy {
            model_trigger.into_any_element()
        } else {
            let picker = self.picker_state(window, cx);
            Popover::new("coordinator-model")
                .trigger_style(StyleRefinement::default().w_full().min_w_0())
                .anchor(Anchor::BottomCenter)
                .trigger(model_trigger)
                .content(move |_, _, _| div().m(gpui_kit::px(-12.)).child(picker.clone()))
                .into_any_element()
        };
        rows = rows
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap(px(12.))
                    .child(label("Model"))
                    .child(div().flex_1().min_w_0().child(model_field)),
            )
            .child(
                div()
                    .pl(px(60.))
                    .text_size(px(size::DETAIL))
                    .line_height(px(17.))
                    .text_color(style::quiet_text(cx))
                    .child(if uses_pools {
                        "Runs on this Mac \u{00B7} Uses the same pool and model picker as a normal thread."
                    } else {
                        "Runs on this Mac \u{00B7} Uses the same login and model picker as a normal thread."
                    }),
            );
        rows.into_any_element()
    }

    pub(crate) fn render_controls(
        &mut self,
        send_button: AnyElement,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let data = self.chip_data(cx);
        let mut row = h_flex().w_full().h(px(size::SEND_BUTTON)).gap(px(4.));
        let composer = cx.entity();
        // What leads the row depends on where the thread is (controls(remote:)
        // and its neighbours in ComposerControls.swift): this Mac's has "+".
        match (&data.away, data.is_new) {
            // Another runner's thread before its logins have come: its Mac's
            // name where the chips would be, and send (remoteControls).
            (Some(away), false) if !away.logins_known => {
                return row
                    .child(machine_slot().ml(px(-7.)).child(self.render_machine_chip(
                        &data,
                        away.name.clone(),
                        away.icon,
                        away.place.clone(),
                        &away.cwd,
                        cx,
                    )))
                    .child(div().flex_1())
                    .child(send_button)
                    .into_any_element();
            }
            // Its logins known: the machine's chip in place of "+".
            (Some(away), false) => {
                row = row
                    .child(machine_slot().ml(px(-7.)).child(self.render_machine_chip(
                        &data,
                        away.name.clone(),
                        away.icon,
                        away.place.clone(),
                        &away.cwd,
                        cx,
                    )))
                    .child(chip_divider(cx))
            }
            // A new thread for another runner, before it's said what logins
            // it has: the machine chip, and how it's going (draftWaitingControls).
            (Some(away), true) if !away.logins_known => {
                let problem = self
                    .app
                    .upgrade()
                    .and_then(|a| a.read(cx).new_thread.runner_problem.clone());
                row = row.child(div().ml(px(-7.)).child(self.render_runs_on_chip(cx)));
                row = match problem {
                    Some(problem) => row.child(
                        div()
                            .id("runner-problem")
                            .text_size(px(size::CHIP))
                            .text_color(style::secondary_text(cx))
                            .child(format!("Can't reach {}", away.name))
                            .tip(problem),
                    ),
                    None => row.child(
                        div()
                            .id("runner-waiting")
                            .child(
                                crate::spinner::Spinner::new()
                                    .color(style::quiet_text(cx))
                                    .with_size(px(14.)),
                            )
                            .tip(format!("Connecting to {}", away.name)),
                    ),
                };
                return row
                    .child(div().flex_1())
                    .child(send_button)
                    .into_any_element();
            }
            // A new thread for another runner: no pictures or folders from
            // here (paths on this Mac), so the machine chip leads.
            (Some(_), true) => {
                row = row.child(div().ml(px(-7.)).child(self.render_runs_on_chip(cx)))
            }
            // This Mac: "+", then the machine chip on a new thread.
            (None, _) => {
                row = row.child(
                    div()
                        .flex_none()
                        .ml(px(-7.))
                        .child(self.render_plus(&data, window, cx)),
                );
                let others = self.app.upgrade().is_some_and(|a| {
                    let remote = &a.read(cx).remote;
                    !remote.runners.is_empty() || !remote.services().is_empty()
                });
                if data.is_new && others {
                    row = row.child(self.render_runs_on_chip(cx));
                } else if others {
                    // This Mac's thread, once there are other machines: which
                    // one it's on, and its menu to move it (machine_menu_rows).
                    if let Some((name, icon)) = self.app.upgrade().and_then(|a| {
                        let t = a.read(cx);
                        let name = data.summary.as_ref().and_then(|s| t.runner_label(s))?;
                        Some((name, t.self_runner_symbol()))
                    }) {
                        let cwd = data
                            .summary
                            .as_ref()
                            .map_or_else(String::new, |s| s.cwd.clone());
                        row = row
                            .child(self.render_machine_chip(
                                &data,
                                name.clone(),
                                icon,
                                format!("On {name}"),
                                &cwd,
                                cx,
                            ))
                            .child(chip_divider(cx));
                    }
                }
            }
        }
        if let Some(settings) = data.settings() {
            // With pools the runner picks the login, so there's no account chip.
            if !settings.uses_pools() {
                row = row
                    .child(self.render_account_chip(&data, cx))
                    .child(chip_divider(cx));
            }
            row = row
                .child(self.render_model_chip(&data, window, cx))
                .child(chip_divider(cx));
            row = row.child(self.render_permission_chip(settings.permission_mode, &composer, cx));
        }
        row = row.child(div().flex_1());
        if let Some(meter) = data
            .summary
            .as_ref()
            .and_then(|t| ContextMeter::new(t.context_tokens, t.context_window))
        {
            row = row.child(
                div()
                    .flex_none()
                    .child(self.render_context_ring(meter, &data)),
            );
        }
        // In a narrow panel the chips' titles give way ("Claude · Fab…"),
        // never the send button, which stays inside the box (the Swift
        // chips' lineLimit and SendButton's layoutPriority).
        let fit = self.controls_fit.clone();
        let measured = self.controls_fit.clone();
        row.child(
            div().flex_none().relative().child(send_button).child(
                canvas(
                    move |bounds, _, _| fit.set((fit.get().0, f32::from(bounds.right()))),
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            ),
        )
        .child(
            canvas(
                move |bounds, _, _| measured.set((f32::from(bounds.right()), measured.get().1)),
                |_, _, _, _| {},
            )
            .absolute()
            .size_full(),
        )
        .relative()
        .into_any_element()
    }

    /// Opens a small menu: "Attach images or Markdown…" and the folder (PlusButton).
    fn render_plus(
        &self,
        data: &ChipData,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let composer = cx.entity().downgrade();
        let current = data
            .summary
            .as_ref()
            .map(|t| t.cwd.clone())
            .unwrap_or_default();
        let default_folder = data.logins.defaults.cwd.clone();
        let app = self.app.clone();
        // Not for another Mac's thread or a new one for another Mac: its
        // schedules are made there (the Swift app's Send menu says the same).
        let can_schedule = data.away.is_none()
            && self
                .app
                .upgrade()
                .is_some_and(|a| a.read(cx).schedules_supported);
        let trigger = ChipTrigger {
            busy: self.chips_busy(cx).1,
            badge: None,
            id: "composer-plus-button".into(),
            kind: TriggerKind::Plus,
            title: SharedString::default(),
            icon: None,
            tip: "Attach images or Markdown, change the folder or schedule the message".into(),
            selected: false,
        };
        // Spinning while a folder change lands, and no menu till then.
        if trigger.busy {
            return trigger.into_any_element();
        }
        style::menu::popover(Popover::new("composer-plus"), cx)
            .anchor(Anchor::BottomLeft)
            .trigger(trigger)
            .content(move |_, window, cx| {
                let folders = Self::recent_folders(&app, &current, &default_folder, cx);
                let popover = cx.entity();
                let c1 = composer.clone();
                let (popover2, c2) = (popover.clone(), composer.clone());
                v_flex()
                    .w(gpui_kit::px(260.))
                    .child(menu_row(
                        "attach",
                        Some(IconName::Image),
                        "Attach images or Markdown…",
                        None,
                        false,
                        window,
                        cx,
                        move |window, cx| {
                            popover.update(cx, |s, cx| s.dismiss(window, cx));
                            if let Some(c) = c1.upgrade() {
                                c.update(cx, |c, cx| c.attach_images(window, cx));
                            }
                        },
                    ))
                    .child(style::menu::heading("Folder", cx))
                    .children(folders.iter().enumerate().map(|(i, folder)| {
                        let (popover, c, path) = (popover2.clone(), c2.clone(), folder.clone());
                        let subtitle = (*folder == default_folder).then(|| "Default".to_owned());
                        menu_row(
                            ("folder", i),
                            Some(IconName::Folder),
                            &abbreviate_home(folder),
                            subtitle.as_deref(),
                            *folder == current,
                            window,
                            cx,
                            move |window, cx| {
                                popover.update(cx, |s, cx| s.dismiss(window, cx));
                                if let Some(c) = c.upgrade() {
                                    c.update(cx, |c, cx| c.set_cwd(path.clone(), cx));
                                }
                            },
                        )
                    }))
                    .child({
                        let (popover, c) = (popover2.clone(), c2.clone());
                        menu_row(
                            "folder-choose",
                            Some(IconName::FolderOpen),
                            "Choose…",
                            None,
                            false,
                            window,
                            cx,
                            move |window, cx| {
                                popover.update(cx, |s, cx| s.dismiss(window, cx));
                                if let Some(c) = c.upgrade() {
                                    c.update(cx, |c, cx| c.choose_folder(window, cx));
                                }
                            },
                        )
                    })
                    // Sending the message later, from what's in the box.
                    .when(can_schedule, |menu| {
                        let (popover, c) = (popover2.clone(), c2.clone());
                        menu.child(style::menu::separator(cx)).child(menu_row(
                            "schedule",
                            Some(IconName::Clock),
                            "Schedule…",
                            None,
                            false,
                            window,
                            cx,
                            move |window, cx| {
                                popover.update(cx, |s, cx| s.dismiss(window, cx));
                                if let Some(c) = c.upgrade() {
                                    let app = c.read(cx).app.clone();
                                    if let Some(app) = app.upgrade() {
                                        app.update(cx, |app, cx| {
                                            app.new_schedule_from_composer(&c, window, cx)
                                        });
                                    }
                                }
                            },
                        ))
                    })
            })
            .into_any_element()
    }

    fn render_permission_chip(
        &self,
        mode: String,
        composer: &Entity<Composer>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let title = permission_title(&mode);
        let help = permission_help(&mode);
        let icon = permission_icon(&mode);
        let composer = composer.downgrade();
        let data = self.chip_data(cx);
        let provider = data
            .summary
            .as_ref()
            .map(|t| t.provider.as_str())
            .unwrap_or_default();
        let has_auto = data.logins.has_auto_mode(provider);
        // Another runner's thread: what it really has (its row's
        // permissionMode), with no menu, as a mode can't be changed from
        // here (relay.ts refuses it): a pick would only fail.
        if let (false, Some(away)) = (data.is_new, data.away.as_ref()) {
            let tip = format!(
                "{help}. Its access can only be changed in the Threadbear app on {}",
                away.name
            );
            return ChipTrigger {
                busy: false,
                badge: None,
                id: "composer-permission-chip".into(),
                kind: TriggerKind::Label,
                title: title.into(),
                icon: Some(if mode == "full" {
                    crate::icons::symbol("lock.open")
                } else {
                    Icon::from(icon)
                }),
                tip: tip.into(),
                selected: false,
            }
            .into_any_element();
        }
        style::menu::popover(Popover::new("composer-permission"), cx)
            // Its chip's title may shrink to fit a narrow box.
            .trigger_style(StyleRefinement::default().min_w_0())
            .anchor(Anchor::BottomLeft)
            .trigger(ChipTrigger {
                busy: false,
                badge: None,
                id: "composer-permission-chip".into(),
                kind: TriggerKind::Chip,
                title: title.into(),
                icon: Some(if mode == "full" {
                    crate::icons::symbol("lock.open")
                } else {
                    Icon::from(icon)
                }),
                tip: help.into(),
                selected: false,
            })
            .content(move |_, window, cx| {
                let popover = cx.entity();
                let modes: &[&str] = if has_auto || mode == "auto" {
                    &["full", "auto", "ask", "plan"]
                } else {
                    &["full", "ask", "plan"]
                };
                v_flex()
                    .w(gpui_kit::px(320.))
                    .children(modes.iter().map(|m| {
                        let m = *m;
                        let (popover, composer) = (popover.clone(), composer.clone());
                        menu_row(
                            m,
                            Some(permission_icon(m)),
                            permission_title(m),
                            Some(permission_help(m)),
                            m == mode,
                            window,
                            cx,
                            move |window, cx| {
                                popover.update(cx, |s, cx| s.dismiss(window, cx));
                                if let Some(c) = composer.upgrade() {
                                    c.update(cx, |c, cx| c.set_permission(m, cx));
                                }
                            },
                        )
                    }))
            })
            .into_any_element()
    }

    fn render_account_chip(&self, data: &ChipData, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(settings) = data.settings() else {
            return div().into_any_element();
        };
        let title = settings.account_chip_title();
        let tip = settings.account_chip_help();
        let composer = cx.entity().downgrade();
        let trigger = ChipTrigger {
            busy: self.chips_busy(cx).0,
            badge: settings.account_badge(),
            id: "composer-account-chip".into(),
            kind: TriggerKind::Chip,
            title: title.into(),
            icon: Some(Icon::from(IconName::CircleUser)),
            tip: tip.into(),
            selected: false,
        };
        if trigger.busy {
            return trigger.into_any_element();
        }
        Popover::new("composer-account")
            // Its chip's title may shrink to fit a narrow box.
            .trigger_style(StyleRefinement::default().min_w_0())
            // Centred over its chip, as an NSPopover opens.
            .anchor(Anchor::BottomCenter)
            .trigger(trigger)
            // The logins by provider with their room (composer_account.rs),
            // read live, so a pick shows at once.
            .content(move |_, window, cx| {
                crate::composer_account::picker(composer.clone(), window, cx)
            })
            .into_any_element()
    }

    fn render_model_chip(
        &mut self,
        data: &ChipData,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let Some(settings) = data.settings() else {
            return div().into_any_element();
        };
        let title = settings.model_chip_title();
        let tip = settings.model_chip_help();
        let trigger = ChipTrigger {
            busy: self.chips_busy(cx).0,
            badge: settings.model_chip_badge(),
            id: "composer-model-chip".into(),
            kind: TriggerKind::Chip,
            title: title.into(),
            icon: Some(model_chip_icon(&settings)),
            tip: tip.into(),
            selected: false,
        };
        // A login or pool change can't be guessed: it spins till it lands.
        if trigger.busy {
            return trigger.into_any_element();
        }
        let picker = self.picker_state(window, cx);
        Popover::new("composer-model")
            // Its chip's title may shrink to fit a narrow box.
            .trigger_style(StyleRefinement::default().min_w_0())
            // Centred over its chip, as an NSPopover opens.
            .anchor(Anchor::BottomCenter)
            .trigger(trigger)
            // To the popover's edges, as the Swift picker's rail and dividers
            // go: the kit's popover pads its content 12 all round.
            .content(move |_, _, _| div().m(gpui_kit::px(-12.)).child(picker.clone()))
            .into_any_element()
    }

    fn render_context_ring(&self, meter: ContextMeter, data: &ChipData) -> impl IntoElement {
        let model = data
            .settings()
            .map(|s| {
                threadbear_core::logins::chip_title(
                    s.effective_model().as_deref(),
                    s.effective_effort().as_deref(),
                    s.choices(),
                )
            })
            .unwrap_or_default();
        let login = data
            .summary
            .as_ref()
            .map(|t| {
                data.logins
                    .account(&t.account_id)
                    .map_or_else(|| t.account_id.clone(), |a| a.name())
            })
            .unwrap_or_default();
        // Only this Mac's runner can ask a thread's CLI; another Mac's thread
        // keeps to the totals, as the Swift app's does through the backend.
        let provider = data
            .summary
            .as_ref()
            .map(|t| t.provider.clone())
            .unwrap_or_default();
        let facts = std::rc::Rc::new(crate::composer_context::ContextFacts {
            thread: data
                .summary
                .as_ref()
                .map(|t| t.id.clone())
                .unwrap_or_default(),
            provider_name: data.logins.provider_title(&provider),
            provider,
            asks: data.away.is_none(),
            meter,
            model,
            login,
            cost: data
                .summary
                .as_ref()
                .and_then(|t| t.cost_usd)
                .filter(|c| *c > 0.)
                .map(|c| format!("${c:.2}")),
            client: self.client.clone(),
        });
        let tip = meter.tip();
        let opened = facts.clone();
        Popover::new("composer-context")
            // Centred over the ring, as an NSPopover opens.
            .anchor(Anchor::BottomCenter)
            .trigger(ChipTrigger {
                busy: false,
                badge: None,
                id: "composer-context-ring".into(),
                kind: TriggerKind::Ring(meter),
                title: SharedString::default(),
                icon: None,
                tip: tip.into(),
                selected: false,
            })
            // What fills a Claude thread's context, asked each time it opens
            // (composer_context.rs).
            .on_open_change(move |open, _, cx| {
                if *open {
                    crate::composer_context::load(&opened, cx);
                }
            })
            .content(move |_, _, cx| crate::composer_context::popover(&facts, cx))
    }

    /// The machine chip on the new-thread box (`runsOnChip`): which Mac the
    /// thread will run on, its menu opening under the pointer.
    fn render_runs_on_chip(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let (icon, tip) = match self
            .app
            .upgrade()
            .and_then(|a| a.read(cx).new_thread.picks.runner.clone())
        {
            Some(runner) => {
                let app = self.app.upgrade();
                #[expect(
                    clippy::expect_used,
                    reason = "the composer lives inside the app, so the app is there while it draws"
                )]
                let t = app.as_ref().expect("the app").read(cx);
                let name = t.runner_name_of(&runner);
                let tip = if t.remote.runners.iter().any(|r| r.id == runner && !r.online) {
                    format!("Runs on {name}, offline")
                } else {
                    format!("Runs on {name}")
                };
                (t.runner_icon_symbol(Some(&runner)), tip)
            }
            None => match self.app.upgrade().and_then(|a| {
                a.read(cx)
                    .new_thread
                    .picks
                    .service
                    .clone()
                    .map(|s| a.read(cx).service_name_of(&s))
            }) {
                // A virtual runner: a machine of its own for this thread.
                Some(name) => (
                    crate::icons::VIRTUAL_RUNNER,
                    format!("Runs on {name}, a machine of its own"),
                ),
                None => (
                    self.app
                        .upgrade()
                        .map_or("desktopcomputer", |a| a.read(cx).self_runner_symbol()),
                    "Runs on this Mac".to_owned(),
                ),
            },
        };
        let app = self.app.clone();
        h_flex()
            .gap(px(4.))
            .child(
                div()
                    .id("composer-runner-chip")
                    .test_support()
                    .role(Role::Button)
                    .aria_label(tip.clone())
                    .flex()
                    .items_center()
                    .h(px(26.))
                    .px(px(7.))
                    .rounded(px(7.))
                    .cursor_pointer()
                    .hover(|s| s.bg(style::chip_hover_fill(cx)))
                    .child(
                        crate::icons::symbol(icon)
                            .with_size(px(size::CHIP - 1.))
                            .text_color(style::faint_icon(cx)),
                    )
                    .tip(tip)
                    .on_click(move |ev: &ClickEvent, window, cx| {
                        if let Some(app) = app.upgrade() {
                            let at = ev.position();
                            app.update(cx, |app, cx| {
                                app.open_runner_menu(point(at.x, at.y - px(12.)), window, cx)
                            });
                        }
                    }),
            )
            .child(chip_divider(cx))
    }

    /// The machine chip on a thread's box (`runnerChip`): the machine it's
    /// on, by icon and name, with a chevron, as there's a menu to move it
    /// (`Threadbear::machine_menu_rows`). On another runner's thread it leads
    /// the row in place of "+"; on this Mac's it comes after "+", once there
    /// are other machines. While a move's going it spins, and its menu is
    /// Cancel Move, so a second click can't start another.
    fn render_machine_chip(
        &self,
        data: &ChipData,
        name: String,
        icon: &'static str,
        place: String,
        cwd: &str,
        cx: &App,
    ) -> AnyElement {
        let thread_id = data.summary.as_ref().map(|s| s.id.clone());
        let moving = data.summary.as_ref().and_then(|s| s.moving_line());
        let tip: SharedString = match &moving {
            Some(line) => line.clone().into(),
            None => format!(
                "{place}, in {}. Click to move it to another machine",
                abbreviate_home(cwd)
            )
            .into(),
        };
        let app = self.app.clone();
        let mut chip = h_flex()
            .id("composer-runner-name")
            .test_support()
            .role(Role::Button)
            .aria_label(name.clone())
            // It gives way, its name ending "…": as flex_none it pushed Send
            // out of a 560-point box on Linux, whose font is wider
            // (composer-chips.feature, 17 Nov). But last, after the model's
            // and access's chips (MACHINE_SHRINK).
            .min_w_0();
        chip.style().flex_shrink = Some(MACHINE_SHRINK);
        chip.gap(px(4.))
            .h(px(26.))
            .px(px(7.))
            .rounded(px(7.))
            .cursor_pointer()
            .hover(|s| s.bg(style::chip_hover_fill(cx)))
            .map(|d| match &moving {
                Some(_) => d.child(
                    div().flex_none().child(
                        crate::spinner::Spinner::new()
                            .color(style::secondary_text(cx))
                            .with_size(px(size::CHIP)),
                    ),
                ),
                None => d.child(
                    div().flex_none().child(
                        crate::icons::symbol(icon)
                            .with_size(px(size::CHIP - 1.))
                            .text_color(style::faint_icon(cx)),
                    ),
                ),
            })
            .child(
                div()
                    .min_w_0()
                    .text_size(px(size::CHIP))
                    .text_color(style::quiet_text(cx))
                    .truncate()
                    .child(name),
            )
            .child(
                div().flex_none().flex().child(
                    Icon::from(IconName::ChevronDown)
                        .with_size(px(9.))
                        .text_color(style::faint_icon(cx)),
                ),
            )
            .tip(tip)
            .on_click(move |ev: &ClickEvent, window, cx| {
                let (Some(app), Some(id)) = (app.upgrade(), thread_id.clone()) else {
                    return;
                };
                let at = ev.position();
                app.update(cx, |app, cx| {
                    app.open_machine_menu(id, point(at.x, at.y - px(12.)), window, cx)
                });
            })
            .into_any_element()
    }

    /// The model picker's state lives on the composer so its search text and
    /// column stay put while it's open.
    fn picker_state(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ModelPickerView> {
        if let Some(picker) = &self.model_picker {
            return picker.clone();
        }
        let composer = cx.entity().downgrade();
        let picker = cx.new(|cx| ModelPickerView::new(composer, window, cx));
        self.model_picker = Some(picker.clone());
        picker
    }

    /// The picker as the limit box's Continue now opens it: its own, so its
    /// column and open Login list don't stay on the chip's.
    pub(crate) fn limit_picker_state(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<ModelPickerView> {
        if let Some(picker) = &self.limit_picker {
            return picker.clone();
        }
        let composer = cx.entity().downgrade();
        let picker = cx.new(|cx| {
            let mut p = ModelPickerView::new(composer, window, cx);
            p.from_limit = true;
            p.login_open = true;
            p
        });
        self.limit_picker = Some(picker.clone());
        picker
    }

    /// Where the limit box opens the picker: the pool holding `login` (the
    /// one with most room), No pool when it's in none, or without pools no
    /// pool at all; and `login`'s provider down the rail.
    pub(crate) fn limit_picker_target(&self, login: &str, cx: &App) -> LimitPickerTarget {
        let data = self.chip_data(cx);
        let provider = data
            .logins
            .account(login)
            .map(|a| a.provider_id().to_owned());
        let pool = data.settings().filter(|s| s.uses_pools()).map(|_| {
            data.logins
                .pools
                .iter()
                .find(|p| p.account_ids.iter().any(|a| a == login))
                .map_or_else(|| UNPOOLED_COLUMN.to_owned(), |p| p.id.clone())
        });
        LimitPickerTarget { pool, provider }
    }
}

/// The pool and provider the limit box's Continue now opens the picker on
/// (`Composer::limit_picker_target`).
#[derive(Clone, Default)]
pub(crate) struct LimitPickerTarget {
    pool: Option<String>,
    provider: Option<String>,
}

const PINNED_COLUMN: &str = "@pinned";

/// Runs a pick from the model picker on its composer: one that carries on
/// at once when the limit box opened the picker (`carry_on`).
fn pick_on(
    composer: &Entity<Composer>,
    carry_on: bool,
    cx: &mut App,
    pick: impl FnOnce(&mut Composer, &mut Context<Composer>),
) {
    composer.update(cx, |c, cx| {
        c.carry_on_pick = carry_on;
        pick(c, cx);
        c.carry_on_pick = false;
    });
}

/// A quiet menu chip: icon, short label and a small chevron in secondary
/// colours (ComposerChip).
enum TriggerKind {
    Chip,
    /// A chip with no menu behind it (another runner's thread's access):
    /// its words and tip, but no chevron, hover or pointer promising one.
    Label,
    Plus,
    Ring(ContextMeter),
}

#[derive(IntoElement)]
struct ChipTrigger {
    id: ElementId,
    kind: TriggerKind,
    title: SharedString,
    /// A bundled icon or one drawn from data (a provider's logo).
    icon: Option<Icon>,
    tip: SharedString,
    selected: bool,
    /// After the title: "· 12%" in orange, "Limit reached" in red
    /// (`ComposerChip.badge`). Colour only here, where it means the login,
    /// or every login in the pool, is running out.
    badge: Option<ChipBadge>,
    /// A change it shows hasn't landed: a spinner in place of its icon, and
    /// it takes no clicks (`ComposerChip.busy`, PlusButton's `.busy`).
    busy: bool,
}

impl Selectable for ChipTrigger {
    fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
    fn is_selected(&self) -> bool {
        self.selected
    }
}

impl RenderOnce for ChipTrigger {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let tip = self.tip.clone();
        // Named for VoiceOver and the automation's `click`: its words, or its
        // tip when it's an icon alone.
        let label: SharedString = if self.title.is_empty() {
            self.tip.clone()
        } else {
            self.title.clone()
        };
        let busy = self.busy;
        // A chip spinning on a change says what it's waiting for; "+" keeps
        // its own tip, as the Swift PlusButton does.
        let tip: SharedString = if busy && matches!(self.kind, TriggerKind::Chip) {
            "Moving this thread".into()
        } else {
            tip
        };
        let menu = !matches!(self.kind, TriggerKind::Label);
        let base = div()
            .id(self.id)
            .flex()
            .items_center()
            .when(!busy && menu, |d| d.cursor_pointer())
            .test_support()
            .role(Role::Button)
            .aria_label(label)
            .tip(tip);
        let spinner = |side: f32| {
            crate::spinner::Spinner::new()
                .color(style::secondary_text(cx))
                .with_size(px(side))
        };
        match self.kind {
            TriggerKind::Plus => base
                .justify_center()
                .size(px(26.))
                .rounded_full()
                .when(!busy, |d| d.hover(|s| s.bg(style::hover_fill(cx))))
                // SF's plus at 15 pt is about 11.7 across with a 1.5 stroke;
                // Lucide's comes to that at 17.5.
                .when(!busy, |d| {
                    d.child(
                        Icon::from(IconName::Plus)
                            .with_size(px(17.5))
                            .text_color(style::quiet_text(cx)),
                    )
                })
                .when(busy, |d| d.child(spinner(12.)))
                .into_any_element(),
            TriggerKind::Ring(meter) => base
                .justify_center()
                .size(px(26.))
                .rounded_full()
                .hover(|s| s.bg(style::hover_fill(cx)))
                .child(context_ring(meter, cx))
                .into_any_element(),
            TriggerKind::Chip | TriggerKind::Label => base
                .min_w_0()
                .h(px(26.))
                .px(px(7.))
                .gap(px(4.))
                .rounded(px(7.))
                .when(!busy && menu, |d| {
                    d.hover(|s| s.bg(style::chip_hover_fill(cx)))
                })
                .when(busy, |s| {
                    s.child(div().flex_none().child(spinner(size::CHIP)))
                })
                .when_some(self.icon.filter(|_| !busy), |s, icon| {
                    s.child(
                        div().flex_none().flex().child(
                            icon.with_size(px(size::CHIP - 1.))
                                .text_color(style::faint_icon(cx)),
                        ),
                    )
                })
                // Its title is what gives way, ending "…", as a SwiftUI
                // Text with lineLimit(1) does.
                .when(!self.title.is_empty(), |s| {
                    s.child(
                        div()
                            .min_w_0()
                            .text_size(px(size::CHIP))
                            .text_color(style::quiet_text(cx))
                            .truncate()
                            .child(self.title.clone()),
                    )
                })
                .when_some(self.badge.clone(), |s, badge| {
                    let color = if badge.is_stop() {
                        cx.theme().danger
                    } else {
                        style::needs_you(cx)
                    };
                    s.child(
                        div()
                            .flex_none()
                            .text_size(px(size::CHIP))
                            .text_color(color)
                            .whitespace_nowrap()
                            .child(badge_words(&badge)),
                    )
                })
                .when(menu && !self.title.is_empty(), |s| {
                    s.child(
                        div().flex_none().flex().child(
                            Icon::from(IconName::ChevronDown)
                                .with_size(px(9.))
                                .text_color(style::faint_icon(cx)),
                        ),
                    )
                })
                .into_any_element(),
        }
    }
}

/// The pool's own icon when one was picked for it, a pinned login's person,
/// else the provider's logo (`modelChipLogo`, `modelChipIcon`).
fn model_chip_icon(settings: &ChipSettings<'_>) -> Icon {
    if !settings.uses_pools() {
        return crate::icons::provider_mark(&settings.provider);
    }
    match settings.pool() {
        None => Icon::from(IconName::CircleUser),
        Some(pool) => match pool.icon.as_deref().filter(|i| !i.is_empty()) {
            Some(symbol) => {
                crate::icons::try_symbol(symbol).unwrap_or_else(|| Icon::from(IconName::Layers))
            }
            None => crate::icons::provider_mark(&settings.provider),
        },
    }
}

/// Full-width dropdown field trigger used inside the Add a coordinator dialog,
/// opening the ordinary pool/model or login popover.
#[derive(IntoElement)]
struct CoordinatorFieldTrigger {
    id: ElementId,
    title: SharedString,
    icon: Icon,
    accent_icon: bool,
    tip: SharedString,
    badge: Option<ChipBadge>,
    busy: bool,
    selected: bool,
}

impl Selectable for CoordinatorFieldTrigger {
    fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
    fn is_selected(&self) -> bool {
        self.selected
    }
}

impl RenderOnce for CoordinatorFieldTrigger {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let label: SharedString = if self.title.is_empty() {
            self.tip.clone()
        } else {
            self.title.clone()
        };
        let fill = if cx.theme().mode.is_dark() {
            style::primary_opacity(cx, 0.05)
        } else {
            style::button_fill(cx)
        };
        let icon_color = if self.accent_icon {
            style::accent(cx)
        } else {
            style::faint_icon(cx)
        };
        let title_el = if let Some((pool, model)) = self.title.split_once(" \u{00B7} ") {
            h_flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(px(5.))
                .text_size(px(size::LABEL))
                .child(
                    div()
                        .flex_none()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(cx.theme().foreground)
                        .child(pool.to_owned()),
                )
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_color(style::secondary_text(cx))
                        .child(format!("\u{00B7} {model}")),
                )
                .into_any_element()
        } else {
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(size::LABEL))
                .font_weight(FontWeight::MEDIUM)
                .text_color(cx.theme().foreground)
                .child(self.title)
                .into_any_element()
        };
        h_flex()
            .id(self.id)
            .w_full()
            .min_w_0()
            .h(px(34.))
            .px(px(10.))
            .gap(px(8.))
            .items_center()
            .rounded(px(8.))
            .border_1()
            .border_color(style::hairline(cx))
            .bg(fill)
            .when(!self.busy, |s| {
                s.cursor_pointer()
                    .hover(|h| h.bg(style::primary_opacity(cx, 0.09)))
            })
            .test_support()
            .role(Role::Button)
            .aria_label(label)
            .tip(self.tip)
            .child(div().flex_none().flex().child(if self.busy {
                crate::spinner::Spinner::new()
                    .color(style::secondary_text(cx))
                    .with_size(px(13.))
                    .into_any_element()
            } else {
                self.icon
                    .with_size(px(14.))
                    .text_color(icon_color)
                    .into_any_element()
            }))
            .child(title_el)
            .when_some(self.badge, |s, badge| {
                let color = if badge.is_stop() {
                    cx.theme().danger
                } else {
                    style::needs_you(cx)
                };
                s.child(
                    div()
                        .flex_none()
                        .text_size(px(size::DETAIL))
                        .text_color(color)
                        .whitespace_nowrap()
                        .child(badge_words(&badge)),
                )
            })
            .child(
                div().flex_none().flex().child(
                    Icon::from(IconName::ChevronDown)
                        .with_size(px(12.))
                        .text_color(style::faint_icon(cx)),
                ),
            )
    }
}

/// How readily the machine chip shrinks against the other chips' 1: a
/// machine's name is short and says where the thread is, so "laptop" stays
/// whole while "Claude · Opus 5.5" gives way to "Claude · Op…" (Mike's
/// window with Highlights open showed "la…", 18 Nov). Still above 0, so it
/// shrinks too rather than push Send out of a narrow box.
const MACHINE_SHRINK: f32 = 0.05;

/// The box another runner's machine chip sits in, giving way as late.
fn machine_slot() -> Div {
    let mut d = div().min_w_0();
    d.style().flex_shrink = Some(MACHINE_SHRINK);
    d
}

fn chip_divider(cx: &App) -> impl IntoElement {
    div()
        .flex_none()
        .w(px(1.))
        .h(px(12.))
        .bg(style::chip_divider(cx))
}

/// The ring for how full the context is (ContextRing): grey, orange near full,
/// a sliver even when nearly empty, so it reads as a meter.
fn context_ring(meter: ContextMeter, cx: &App) -> impl IntoElement {
    let track = style::chip_divider(cx);
    let color = if meter.is_nearly_full() {
        hsla(0.09, 0.9, 0.55, 1.)
    } else {
        style::quiet_text(cx)
    };
    let fraction = meter.fraction().max(0.03) as f32;
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let side = px(15.);
            let center = point(
                bounds.origin.x + bounds.size.width / 2.,
                bounds.origin.y + bounds.size.height / 2.,
            );
            let radius = side / 2. - px(1.25);
            let line = px(2.5);
            // A stroked circle, then the part of it that's used from the top,
            // clockwise. Short straight pieces, which at this size is a circle.
            let draw = |window: &mut Window, from: f32, to: f32, color: Hsla| {
                let mut builder = PathBuilder::stroke(line);
                let steps = ((to - from) * 96.).ceil().max(2.) as usize;
                for step in 0..=steps {
                    let t = from + (to - from) * step as f32 / steps as f32;
                    let angle = t * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
                    let p = point(
                        center.x + radius * angle.cos(),
                        center.y + radius * angle.sin(),
                    );
                    if step == 0 {
                        builder.move_to(p);
                    } else {
                        builder.line_to(p);
                    }
                }
                if let Ok(path) = builder.build() {
                    window.paint_path(path, color);
                }
            };
            draw(window, 0., 1., track);
            draw(window, 0., fraction, color);
        },
    )
    .size(px(26.))
}

fn permission_icon(mode: &str) -> IconName {
    match mode {
        "full" => IconName::LockOpen,
        "ask" => IconName::Lock,
        "auto" => IconName::ShieldCheck,
        "plan" => IconName::ClipboardList,
        _ => IconName::CircleQuestionMark,
    }
}

fn abbreviate_home(path: &str) -> String {
    threadbear_core::new_thread::abbreviate_home(path, &crate::files::home_dir())
}

/// A row in one of the chips' menus: an icon, a title, a line under it and a
/// tick when it's the current one (ActionMenuItem), drawn as the app's menus
/// are (style::menu).
#[expect(
    clippy::too_many_arguments,
    reason = "baselined when the lint was turned on (20 Nov 2026); take it off when this is next split up"
)]
fn menu_row(
    id: impl Into<ElementId>,
    icon: Option<IconName>,
    title: &str,
    subtitle: Option<&str>,
    checked: bool,
    window: &mut Window,
    cx: &mut App,
    action: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let _ = window;
    style::menu::row(id, icon.map(Icon::from), cx)
        // Found by its words, as scripts click a menu's line.
        .test_support()
        .role(Role::MenuItem)
        .aria_label(title.to_owned())
        .on_click(move |_, window, cx| action(window, cx))
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(div().truncate().child(title.to_owned()))
                .when_some(subtitle, |s, subtitle| {
                    s.child(
                        div()
                            .text_size(gpui_kit::px(11.))
                            .text_color(cx.theme().muted_foreground)
                            .line_clamp(2)
                            .child(subtitle.to_owned()),
                    )
                }),
        )
        .when(checked, |s| s.child(style::menu::tick(cx)))
}

/// The model picker's popover (ModelPickerView): Pool strip at the top (when
/// pools are in use), Provider icon rail down the left, then search, the
/// active provider's models, effort levels and Login line on the right.
pub(crate) struct ModelPickerView {
    composer: WeakEntity<Composer>,
    search: Entity<InputState>,
    /// Selected pool id (or PINNED_COLUMN), None for the thread's own.
    pool: Option<String>,
    /// Selected provider id in the left rail, None for the thread's own / first.
    provider: Option<String>,
    /// The Login line's list is open.
    login_open: bool,
    /// Opened by the limit box's Continue now: a move it makes carries on
    /// at once (`Composer::carry_on_pick`).
    from_limit: bool,
    _subs: Vec<Subscription>,
}

struct PickerListing {
    /// Selected pool id (or PINNED_COLUMN) when pools are on, empty otherwise.
    pool: String,
    /// Providers shown down the left rail.
    providers: Vec<String>,
    /// Active provider in the left rail, if any.
    active_provider: Option<String>,
    /// Model sections shown in the list, older rows sorted last in each.
    sections: Vec<PickerSection>,
}

impl ModelPickerView {
    fn new(composer: WeakEntity<Composer>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search models"));
        let sub = cx.subscribe_in(
            &search,
            window,
            |this: &mut Self, _, event: &InputEvent, window, cx| {
                // Return takes the first match, as the Swift search's onSubmit does.
                if let InputEvent::PressEnter { .. } = event {
                    this.pick_first(window, cx);
                }
                cx.notify();
            },
        );
        ModelPickerView {
            composer,
            search,
            pool: None,
            provider: None,
            login_open: false,
            from_limit: false,
            _subs: vec![sub],
        }
    }

    /// The limit box's Continue now opening it: on `target`'s pool and
    /// provider (the login with most room), its Login list open.
    /// `carry_on`: the thread has a stopped turn to carry on
    /// (`LimitAdvice::carry_on`).
    pub(crate) fn open_for_limit(
        &mut self,
        target: LimitPickerTarget,
        carry_on: bool,
        cx: &mut Context<Self>,
    ) {
        self.from_limit = carry_on;
        self.pool = target.pool;
        self.provider = target.provider;
        self.login_open = true;
        cx.notify();
    }

    /// Works out the active pool, provider rail and model sections for what's
    /// currently selected and typed in the search box.
    fn listed(&self, data: &ChipData, cx: &App) -> Option<PickerListing> {
        let settings = data.settings()?;
        let pool = if settings.uses_pools() {
            settings.resolve_picker_pool(self.pool.as_deref(), PINNED_COLUMN)
        } else {
            String::new()
        };
        let providers = settings.picker_providers(&pool);
        let active_provider = settings.resolve_picker_provider(&pool, self.provider.as_deref());
        let query = self.search.read(cx).value().to_string();
        let mut sections = settings.sections_for(&pool, active_provider.as_deref(), &query);
        for section in &mut sections {
            section.rows.sort_by_key(|r| r.is_older);
        }
        Some(PickerListing {
            pool,
            providers,
            active_provider,
            sections,
        })
    }

    /// Return in the search: the first model listed, as a click on it would.
    /// Nothing listed, nothing happens (the Swift guard).
    fn pick_first(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(composer) = self.composer.upgrade() else {
            return;
        };
        let data = composer.read(cx).chip_data(cx);
        let pools = data.settings().is_some_and(|s| s.uses_pools());
        let Some(listing) = self.listed(&data, cx) else {
            return;
        };
        let Some((provider, first)) = listing
            .sections
            .into_iter()
            .find_map(|s| s.rows.into_iter().next().map(|r| (s.provider, r)))
        else {
            return;
        };
        let column = if pools {
            listing.pool
        } else {
            provider.clone()
        };
        self.pool = None;
        self.provider = None;
        self.login_open = false;
        pick_on(&composer, self.from_limit, cx, |c, cx| {
            c.pick_model(&first, &column, &provider, &data, cx)
        });
        window.dispatch_action(Box::new(gpui_kit::base::actions::Cancel), cx);
    }
}

impl Render for ModelPickerView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(composer) = self.composer.upgrade() else {
            return div().into_any_element();
        };
        let data = composer.read(cx).chip_data(cx);
        let Some(settings) = data.settings() else {
            return div().into_any_element();
        };
        let pools = settings.uses_pools();
        let query = self.search.read(cx).value().to_string();
        let Some(listing) = self.listed(&data, cx) else {
            return div().into_any_element();
        };
        let levels = settings.effort_levels();
        let chosen = settings.effective_effort();
        let width = if pools { 392. } else { 380. };
        let rail = self.render_provider_rail(
            &data,
            &listing.providers,
            listing.active_provider.as_deref(),
            cx,
        );
        let list = self.render_model_list(&data, &listing, &query, cx);
        let effort = (!levels.is_empty()).then(|| self.render_effort_bar(levels, chosen, cx));
        // With pools, "Login: Auto (gmail for now)" under the effort levels,
        // opening in place to pin the thread to one of the pool's logins
        // (threadbear_core::login_picker, "The model picker's Login line").
        let login = pools.then(|| {
            self.render_login_footer(&data, &listing.pool, listing.active_provider.as_deref(), cx)
        });
        let right = v_flex()
            .flex_1()
            .min_w_0()
            .child(
                h_flex()
                    .h(px(36.))
                    .px(px(12.))
                    .gap(px(8.))
                    .border_b_1()
                    .border_color(style::hairline(cx))
                    .child(
                        Icon::from(IconName::Search)
                            .with_size(px(12.))
                            .text_color(style::faint_text(cx)),
                    )
                    .child(
                        div().flex_1().child(
                            Input::new(&self.search)
                                .appearance(false)
                                .bordered(false)
                                .text_size(px(13.)),
                        ),
                    ),
            )
            .child(
                div()
                    .id("picker-list")
                    .max_h(px(320.))
                    .overflow_y_scroll()
                    .child(list),
            )
            .children(effort.map(|e| {
                div()
                    .border_t_1()
                    .border_color(style::hairline(cx))
                    .child(e)
            }))
            .children(login.map(|l| {
                div()
                    .border_t_1()
                    .border_color(style::hairline(cx))
                    .child(l)
            }));
        // Stretched, so the provider rail and divider run down the full body
        // beside the list, search, effort and login footer.
        let body = h_flex()
            .items_stretch()
            .child(rail)
            .child(div().w(px(1.)).bg(style::hairline(cx)))
            .child(right);
        if pools {
            v_flex()
                .w(px(width))
                .child(self.render_pool_strip(&data, &listing.pool, cx))
                .child(body)
                .into_any_element()
        } else {
            body.w(px(width)).into_any_element()
        }
    }
}

impl ModelPickerView {
    /// Top pool strip: each pool's title with its login count and best room
    /// ("Main  7 · 100%"), plus a divider and "No pool" tab whenever at least
    /// one login isn't in any pool, wrapping cleanly when there are several.
    fn render_pool_strip(
        &self,
        data: &ChipData,
        active_pool: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let this = cx.entity().downgrade();
        let (fg, secondary, faint) = (
            cx.theme().foreground,
            cx.theme().muted_foreground,
            style::faint_text(cx),
        );
        let (warn, danger) = (style::needs_you(cx), cx.theme().danger);
        let (active_fill, hover_fill) = (
            style::primary_opacity(cx, 0.11),
            style::primary_opacity(cx, 0.06),
        );
        let sub_color = move |badge: Option<ChipBadge>, active: bool| match badge {
            Some(b) if b.is_stop() => danger,
            Some(ChipBadge::Low(_)) => warn,
            _ if active => secondary,
            _ => faint,
        };
        let format_sub = |count: usize, best: Option<f64>| match best {
            Some(best) => format!(
                "{count} \u{00B7} {}",
                threadbear_core::new_thread::percent(best)
            ),
            None => count.to_string(),
        };
        let unpooled = threadbear_core::new_thread::unpooled_logins(
            &data.logins.pools,
            &data.logins.accounts,
            None,
        );
        let mut strip = h_flex()
            .flex_wrap()
            .items_center()
            .gap(px(4.))
            .px(px(8.))
            .py(px(6.))
            .bg(style::primary_opacity(cx, 0.03))
            .border_b_1()
            .border_color(style::hairline(cx))
            .children(data.logins.pools.iter().enumerate().map(|(i, p)| {
                let active = p.id == active_pool;
                let pool_id = p.id.clone();
                let title = p.title.clone();
                let logins =
                    threadbear_core::new_thread::pool_logins(p, &data.logins.accounts, None);
                let subtitle = format_sub(
                    logins.len(),
                    threadbear_core::new_thread::best_room_of(&logins),
                );
                let badge = threadbear_core::new_thread::group_chip_badge(&logins);
                let pool_providers =
                    threadbear_core::new_thread::pool_providers(p, &data.logins.accounts);
                let this = this.clone();
                h_flex()
                    .id(("picker-pool", i))
                    .test_support()
                    .role(Role::Button)
                    .aria_label(SharedString::from(format!("Pool: {title}")))
                    .items_center()
                    .gap(px(6.))
                    .px(px(10.))
                    .py(px(5.))
                    .rounded(px(7.))
                    .cursor_pointer()
                    .when(active, |s| s.bg(active_fill))
                    .when(!active, |s| s.hover(move |s| s.bg(hover_fill)))
                    .tip(format!("{title}: {subtitle}"))
                    .on_click(move |_, _, cx| {
                        if let Some(this) = this.upgrade() {
                            this.update(cx, |this, cx| {
                                this.pool = Some(pool_id.clone());
                                let keep = this
                                    .provider
                                    .as_deref()
                                    .is_some_and(|p| pool_providers.iter().any(|x| x == p));
                                if !keep {
                                    this.provider = None;
                                }
                                cx.notify();
                            });
                        }
                    })
                    .child(
                        div()
                            .max_w(px(180.))
                            .truncate()
                            .text_size(px(12.))
                            .when(active, |s| s.font_weight(FontWeight::SEMIBOLD))
                            .text_color(if active { fg } else { secondary })
                            .child(title),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(sub_color(badge, active))
                            .child(subtitle),
                    )
            }));
        if !unpooled.is_empty() {
            let active = active_pool == UNPOOLED_COLUMN;
            let subtitle = format_sub(
                unpooled.len(),
                threadbear_core::new_thread::best_room_of(&unpooled),
            );
            let badge = threadbear_core::new_thread::group_chip_badge(&unpooled);
            let providers = threadbear_core::new_thread::unpooled_providers(
                &data.logins.pools,
                &data.logins.accounts,
            );
            strip = strip
                .child(
                    div()
                        .flex_none()
                        .w(px(1.))
                        .h(px(14.))
                        .mx(px(3.))
                        .bg(style::hairline(cx)),
                )
                .child(
                    h_flex()
                        .id("picker-pool-unpooled")
                        .test_support()
                        .role(Role::Button)
                        .aria_label(SharedString::from("Pool: No pool"))
                        .items_center()
                        .gap(px(6.))
                        .px(px(10.))
                        .py(px(5.))
                        .rounded(px(7.))
                        .cursor_pointer()
                        .when(active, |s| s.bg(active_fill))
                        .when(!active, |s| s.hover(move |s| s.bg(hover_fill)))
                        .tip(format!("Not in a pool: {subtitle}"))
                        .on_click(move |_, _, cx| {
                            if let Some(this) = this.upgrade() {
                                this.update(cx, |this, cx| {
                                    this.pool = Some(UNPOOLED_COLUMN.to_owned());
                                    let keep = this
                                        .provider
                                        .as_deref()
                                        .is_some_and(|p| providers.iter().any(|x| x == p));
                                    if !keep {
                                        this.provider = None;
                                    }
                                    cx.notify();
                                });
                            }
                        })
                        .child(
                            div()
                                .text_size(px(12.))
                                .when(active, |s| s.font_weight(FontWeight::SEMIBOLD))
                                .text_color(if active { fg } else { secondary })
                                .child("No pool"),
                        )
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(sub_color(badge, active))
                                .child(subtitle),
                        ),
                );
        }
        strip.into_any_element()
    }

    /// Left icon rail for the providers in the chosen pool (or on the runner
    /// when pools aren't in use).
    fn render_provider_rail(
        &self,
        data: &ChipData,
        providers: &[String],
        active_provider: Option<&str>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let this = cx.entity().downgrade();
        let (fg, secondary) = (cx.theme().foreground, cx.theme().muted_foreground);
        let (active_fill, hover_fill) = (
            style::primary_opacity(cx, 0.11),
            style::primary_opacity(cx, 0.06),
        );
        v_flex()
            .w(px(46.))
            .flex_shrink_0()
            .py(px(7.))
            .items_center()
            .gap(px(5.))
            .bg(style::primary_opacity(cx, 0.025))
            .children(providers.iter().enumerate().map(|(i, provider)| {
                let active = active_provider == Some(provider.as_str());
                let title = data.logins.provider_title(provider);
                let color = if active { fg } else { secondary };
                let provider_id = provider.clone();
                let this = this.clone();
                div()
                    .id(("picker-provider", i))
                    .test_support()
                    .role(Role::Button)
                    .aria_label(SharedString::from(format!("Provider: {title}")))
                    .size(px(32.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(7.))
                    .cursor_pointer()
                    .when(active, |s| s.bg(active_fill))
                    .when(!active, |s| s.hover(move |s| s.bg(hover_fill)))
                    .tip(title)
                    .on_click(move |_, window, cx| {
                        if let Some(this) = this.upgrade() {
                            this.update(cx, |this, cx| {
                                this.provider = Some(provider_id.clone());
                                if !this.search.read(cx).value().is_empty() {
                                    this.search
                                        .update(cx, |s, cx| s.set_value(String::new(), window, cx));
                                }
                                cx.notify();
                            });
                        }
                    })
                    .child(
                        crate::icons::provider_mark(provider)
                            .with_size(px(16.))
                            .text_color(color),
                    )
            }))
            .into_any_element()
    }

    fn render_model_list(
        &self,
        data: &ChipData,
        listing: &PickerListing,
        query: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let pools = data.settings().is_some_and(|s| s.uses_pools());
        let this = cx.entity().downgrade();
        let carry_on = self.from_limit;
        let row_view = |row: PickerRow, provider: &str, cx: &App| {
            let composer = self.composer.clone();
            let this = this.clone();
            let column = if pools {
                listing.pool.clone()
            } else {
                provider.to_owned()
            };
            let (data, picked, section) =
                (self.chip_snapshot(cx), row.clone(), provider.to_owned());
            model_row(row, provider, cx, move |window, cx| {
                if let Some(this) = this.upgrade() {
                    this.update(cx, |this, _| {
                        this.pool = None;
                        this.provider = None;
                        this.login_open = false;
                    });
                }
                if let Some(c) = composer.upgrade() {
                    pick_on(&c, carry_on, cx, |c, cx| {
                        c.pick_model(&picked, &column, &section, &data, cx)
                    });
                }
                window.dispatch_action(Box::new(gpui_kit::base::actions::Cancel), cx);
            })
        };
        let unpooled_hint = |provider: &str| -> Option<String> {
            if !pools || listing.pool != UNPOOLED_COLUMN {
                return None;
            }
            let logins = threadbear_core::new_thread::unpooled_logins(
                &data.logins.pools,
                &data.logins.accounts,
                Some(provider),
            );
            match logins.len() {
                0 => None,
                1 => Some(format!(
                    "Pins to {}",
                    threadbear_core::new_thread::login_name(&logins[0].id, &data.logins.accounts)
                )),
                n => Some(format!("{n} unpooled logins")),
            }
        };
        let heading = |text: SharedString, hint: Option<String>, top: f32, cx: &App| {
            h_flex()
                .items_center()
                .justify_between()
                .gap(px(8.))
                .px(px(10.))
                .pt(px(top))
                .pb(px(3.))
                .child(
                    div()
                        .text_size(px(11.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(style::faint_text(cx))
                        .child(text),
                )
                .when_some(hint, |s, hint| {
                    s.child(
                        div()
                            .text_size(px(10.5))
                            .text_color(style::faint_text(cx))
                            .truncate()
                            .child(hint),
                    )
                })
        };
        let mut list = v_flex().p(px(6.)).gap(px(1.));
        if listing.sections.iter().all(|s| s.rows.is_empty()) {
            if query.trim().is_empty() {
                if let Some(active) = &listing.active_provider {
                    list = list.child(heading(
                        data.logins.provider_title(active).into(),
                        unpooled_hint(active),
                        4.,
                        cx,
                    ));
                }
            }
            return list
                .child(
                    div()
                        .p(px(10.))
                        .text_size(px(13.))
                        .text_color(cx.theme().muted_foreground)
                        .child(if query.trim().is_empty() {
                            "No models listed yet"
                        } else {
                            "Nothing matches"
                        }),
                )
                .into_any_element();
        }
        for (i, section) in listing.sections.iter().cloned().enumerate() {
            if let Some(title) = section.title {
                list = list.child(heading(
                    title.into(),
                    unpooled_hint(&section.provider),
                    if i == 0 { 4. } else { 12. },
                    cx,
                ));
            }
            let (main, older): (Vec<_>, Vec<_>) =
                section.rows.into_iter().partition(|r| !r.is_older);
            list = list.children(main.into_iter().map(|r| row_view(r, &section.provider, cx)));
            if !older.is_empty() {
                list = list.child(heading("Older".into(), None, 8., cx)).children(
                    older
                        .into_iter()
                        .map(|r| row_view(r, &section.provider, cx)),
                );
            }
        }
        list.into_any_element()
    }

    fn render_effort_bar(
        &self,
        levels: Vec<String>,
        chosen: Option<String>,
        cx: &App,
    ) -> AnyElement {
        let composer_for_effort = self.composer.clone();
        h_flex()
            .mx(px(12.))
            .my(px(9.))
            .p(px(2.))
            .gap(px(2.))
            .rounded(px(7.))
            .bg(style::chip_fill(cx))
            .children(levels.into_iter().map(|level| {
                let active = chosen.as_deref() == Some(level.as_str());
                let title = effort_title(&level);
                let tip = effort_porridge(&level).unwrap_or(&title).to_owned();
                let (composer, level2) = (composer_for_effort.clone(), level.clone());
                div()
                    .id(SharedString::from(format!("effort-{level}")))
                    .role(Role::Button)
                    .flex_1()
                    .h(px(22.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(5.))
                    .cursor_pointer()
                    .text_size(px(11.))
                    .when(active, |s| {
                        s.bg(cx.theme().background)
                            .font_weight(FontWeight::SEMIBOLD)
                    })
                    .text_color(if active {
                        cx.theme().foreground
                    } else {
                        cx.theme().muted_foreground
                    })
                    .hover(|s| s.bg(style::hover_fill(cx)))
                    .child(title)
                    .tip(tip)
                    .on_click(move |_, _, cx| {
                        if let Some(c) = composer.upgrade() {
                            c.update(cx, |c, cx| c.set_effort(level2.clone(), cx));
                        }
                    })
            }))
            .into_any_element()
    }

    fn chip_snapshot(&self, cx: &App) -> ChipData {
        self.composer
            .upgrade()
            .map(|c| c.read(cx).chip_data(cx))
            .unwrap_or(ChipData {
                summary: None,
                logins: RunnerLogins::default(),
                is_new: false,
                away: None,
                runner: None,
            })
    }

    /// The Login line (option C, 12 Nov 2026): "Login: Auto (gmail for
    /// now)", or "Login: gmail" when pinned (with "(not in a pool)" when
    /// pinned to an unpooled login), and a chevron. A click opens the list in
    /// place: Auto then the pool's logins, or the unpooled logins for the
    /// active provider (with no Auto row) when browsing the "No pool" tab.
    fn render_login_footer(
        &self,
        data: &ChipData,
        column: &str,
        active_provider: Option<&str>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(settings) = data.settings() else {
            return div().into_any_element();
        };
        let accounts = &data.logins.accounts;
        let on_unpooled = column == UNPOOLED_COLUMN;
        let pinned_unpooled = settings.is_pinned_to_unpooled();
        let (line, on) = threadbear_core::login_picker::login_line_for(
            &settings.account,
            accounts,
            settings.pool(),
            pinned_unpooled,
        );
        let open = self.login_open;
        let pinned = settings.pool().is_none();
        let tip = if on_unpooled {
            if pinned_unpooled {
                "Pinned to this unpooled login. Open to pick another unpooled login"
            } else {
                "Not in a pool. Open to pick a specific unpooled login"
            }
        } else if pinned {
            "Pinned to this login. Open to pick another, or Auto to let the pool pick"
        } else {
            "Let the pool pick, or pin this thread to one login"
        };
        let header = h_flex()
            .id("picker-login")
            .test_support()
            .role(Role::Button)
            .aria_expanded(open)
            .aria_label(SharedString::from(line.clone()))
            .px(px(12.))
            .py(px(9.))
            .gap(px(4.))
            .cursor_pointer()
            .text_size(px(11.))
            .line_height(px(style::natural_line(11.)))
            .hover(|s| s.bg(style::primary_opacity(cx, 0.04)))
            .tip(tip)
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                this.login_open = !this.login_open;
                cx.notify();
            }))
            .child(div().text_color(style::secondary_label(cx)).child(line))
            .when_some(on, |s, on| {
                s.child(
                    div()
                        .truncate()
                        .text_color(style::tertiary_label(cx))
                        .child(on),
                )
            })
            .child(div().flex_1())
            .child(
                Icon::from(if open {
                    IconName::ChevronUp
                } else {
                    IconName::ChevronDown
                })
                .with_size(px(10.))
                .text_color(style::faint_icon(cx)),
            );
        if !open {
            return header.into_any_element();
        }
        let now = threadbear_core::chrono::Local::now();
        let Some((pool_id, rows)) = self.login_rows(data, column, active_provider, &now, cx) else {
            return header.into_any_element();
        };
        let Some(app) = self.composer.upgrade().map(|c| c.read(cx).app.clone()) else {
            return header.into_any_element();
        };
        let carry_on = self.from_limit;
        let list = v_flex()
            .px(px(6.))
            .pb(px(6.))
            .gap(px(1.))
            .children(rows.into_iter().map(|row| {
                let (composer, this, pool_id, login) = (
                    self.composer.clone(),
                    cx.entity().downgrade(),
                    pool_id.clone(),
                    row.id.clone(),
                );
                let reset = row.reset.as_ref().zip(row.id.clone()).map(|(offer, id)| {
                    crate::composer_account::reset_line(
                        &format!("picker-login-{id}"),
                        offer,
                        app.clone(),
                        data.runner.clone(),
                        id,
                        cx,
                    )
                });
                pool_login_row(row, reset, cx, move |window, cx| {
                    if let Some(this) = this.upgrade() {
                        this.update(cx, |this, _| {
                            this.pool = None;
                            this.provider = None;
                            this.login_open = false;
                        });
                    }
                    if let Some(c) = composer.upgrade() {
                        pick_on(&c, carry_on, cx, |c, cx| {
                            c.pick_login(login.clone(), &pool_id, cx)
                        });
                    }
                    window.dispatch_action(Box::new(gpui_kit::base::actions::Cancel), cx);
                })
            }));
        v_flex().child(header).child(list).into_any_element()
    }

    /// The opened Login list's rows and the pool they're in (empty for No
    /// pool): the unpooled logins for the active provider on the No pool
    /// tab, else Auto then the pool's logins.
    fn login_rows(
        &self,
        data: &ChipData,
        column: &str,
        active_provider: Option<&str>,
        now: &threadbear_core::chrono::DateTime<threadbear_core::chrono::Local>,
        cx: &App,
    ) -> Option<(String, Vec<threadbear_core::login_picker::PoolLoginRow>)> {
        let settings = data.settings()?;
        let accounts = &data.logins.accounts;
        let pinned = settings.pool().is_none();
        if column == UNPOOLED_COLUMN {
            let rows = threadbear_core::login_picker::unpooled_login_rows(
                &data.logins.pools,
                accounts,
                active_provider,
                settings.pool().map(|p| p.id.as_str()),
                pinned.then_some(settings.account.as_str()),
                now,
            );
            return (!rows.is_empty()).then_some((String::new(), rows));
        }
        let pool_id = self.login_list_pool(data, column, cx)?;
        let pool = data.logins.pool(&pool_id)?;
        let rows = threadbear_core::login_picker::pool_login_rows(
            pool,
            accounts,
            settings.pool().map(|p| p.id.as_str()),
            pinned.then_some(settings.account.as_str()),
            now,
        );
        Some((pool_id, rows))
    }

    /// The pool whose logins the opened Login list shows: the rail's column,
    /// or for a pinned thread's own column, the pool Auto would put it in.
    fn login_list_pool(&self, data: &ChipData, column: &str, cx: &App) -> Option<String> {
        if column != PINNED_COLUMN {
            return data.logins.pool(column).map(|p| p.id.clone());
        }
        self.composer
            .upgrade()
            .and_then(|c| c.read(cx).unpin_pool(data, cx))
    }
}

/// A row of the opened Login list (LoginRow, with the room as a bar): a
/// tick in its own column, the name and its usage line, then a small bar and
/// the room left, orange under a quarter and red at its limit.
fn pool_login_row(
    row: threadbear_core::login_picker::PoolLoginRow,
    reset: Option<AnyElement>,
    cx: &App,
    action: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let color = match row.badge {
        Some(ChipBadge::Blocked | ChipBadge::SignedOut | ChipBadge::PlanEnded) => cx.theme().danger,
        Some(ChipBadge::Low(_)) => style::needs_you(cx),
        None => style::secondary_label(cx),
    };
    let words = row.room_words();
    let fill = row.room.map(|r| (r.clamp(0., 100.) / 100.) as f32);
    let id = row.id.clone().unwrap_or_else(|| "auto".to_owned());
    let name = if row.is_selected {
        format!("{}, chosen", row.title)
    } else {
        row.title.clone()
    };
    h_flex()
        .id(SharedString::from(format!("picker-login-{id}")))
        .test_support()
        .role(Role::Button)
        .aria_label(SharedString::from(name))
        .gap(px(8.))
        .px(px(8.))
        .py(px(5.))
        .rounded(px(7.))
        .cursor_pointer()
        .when(row.is_selected, |s| s.bg(style::primary_opacity(cx, 0.1)))
        .when(!row.is_selected, |s| {
            s.hover(|s| s.bg(style::primary_opacity(cx, 0.06)))
        })
        .on_click(move |_, window, cx| action(window, cx))
        .child(
            div().flex_none().w(px(12.)).child(
                Icon::from(IconName::Check)
                    .with_size(px(12.))
                    .text_color(style::label_text(cx))
                    .when(!row.is_selected, |s| s.invisible()),
            ),
        )
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .truncate()
                        .text_size(px(12.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(style::label_text(cx))
                        .child(row.title.clone()),
                )
                .when_some(row.subtitle, |s, sub| {
                    s.child(
                        div()
                            .truncate()
                            .text_size(px(11.))
                            .text_color(style::secondary_label(cx))
                            .child(sub),
                    )
                })
                .children(reset),
        )
        .when_some(fill, |s, fill| {
            s.child(
                div()
                    .flex_none()
                    .w(px(46.))
                    .h(px(3.))
                    .rounded(px(2.))
                    .bg(style::primary_opacity(cx, 0.1))
                    .child(
                        div()
                            .h_full()
                            .rounded(px(2.))
                            .bg(color)
                            .w(px(46. * fill.max(0.04))),
                    ),
            )
        })
        .when_some(words, |s, words| {
            s.child(
                div()
                    .flex_none()
                    .w(px(34.))
                    .text_right()
                    .text_size(px(11.))
                    .text_color(color)
                    .child(words),
            )
        })
}

impl Composer {
    /// The pool Auto puts a pinned thread in (Pools.unpinTarget): one holding
    /// its login, so it stays where it is until that login runs dry; on the
    /// new-thread page, the pool a new thread starts in.
    fn unpin_pool(&self, data: &ChipData, cx: &App) -> Option<String> {
        let thread = data.summary.as_ref()?;
        let home = crate::files::home_dir();
        let last = self
            .app
            .upgrade()
            .and_then(|a| a.read(cx).new_thread.prefs.remembered.last_pool.clone());
        threadbear_core::login_picker::unpin_target(
            &data.logins.pools,
            &thread.account_id,
            &thread.cwd,
            &home,
            last.as_deref(),
        )
    }

    /// A pick from the Login list. A login pins the thread to it
    /// (`threads.update { accountId }`, which clears its pool; one of another
    /// provider moves the thread to that provider, its model and effort
    /// back to that provider's defaults). Auto puts it in `pool`, the one the
    /// list showed, unless it's already there.
    pub(crate) fn pick_login(&self, login: Option<String>, pool: &str, cx: &mut App) {
        let data = self.chip_data(cx);
        let Some(settings) = data.settings() else {
            return;
        };
        let accounts = &data.logins.accounts;
        let Some(login) = login else {
            if settings.pool().is_some_and(|p| p.id == pool) {
                return;
            }
            let Some(target) = data.logins.pool(pool) else {
                return;
            };
            // The thread's provider while the pool has it, so a mixed pool
            // keeps a Codex thread on Codex (Codex's review, 12 Nov).
            let providers = threadbear_core::new_thread::pool_providers(target, accounts);
            let keeps = providers.contains(&settings.provider);
            if data.is_new {
                // None lets the draft fall back on the provider it last
                // used in that pool, rather than overwriting it.
                let provider = keeps.then(|| settings.provider.clone());
                return self.change_thread(
                    |_| {},
                    json!({ "poolId": pool, "provider": provider }),
                    cx,
                );
            }
            // The runner moves it onto one of the pool's logins if its own
            // isn't one; guess which, so the chip is right straight away.
            // As the runner picks: the thread's provider first, then the
            // pool's others, the first with a login that has room; else the
            // first login it would try.
            let stays = target.account_ids.contains(&settings.account);
            let moved = (!stays)
                .then(|| {
                    let now_ms = threadbear_core::chrono::Local::now().timestamp_millis();
                    let order = std::iter::once(settings.provider.clone())
                        .filter(|_| keeps)
                        .chain(
                            providers
                                .iter()
                                .filter(|p| **p != settings.provider)
                                .cloned(),
                        );
                    let picks: Vec<String> = order
                        .filter_map(|p| {
                            threadbear_core::new_thread::pick_login(
                                target, accounts, &p, None, now_ms,
                            )
                        })
                        .collect();
                    picks
                        .iter()
                        .find(|id| {
                            data.logins
                                .account(id)
                                .is_some_and(threadbear_core::new_thread::has_room)
                        })
                        .or(picks.first())
                        .cloned()
                })
                .flatten();
            let provider = moved
                .as_deref()
                .and_then(|id| data.logins.account(id))
                .map_or_else(|| settings.provider.clone(), |a| a.provider_id().to_owned());
            let switched =
                (provider != settings.provider).then(|| provider_defaults(&data.logins, provider));
            let guess = (pool.to_owned(), moved, switched);
            return self.change_thread(
                move |t| {
                    let (pool, moved, switched) = guess;
                    t.pool_id = Some(pool);
                    if let Some(login) = moved {
                        t.account_id = login;
                    }
                    if let Some(to) = switched {
                        switch_provider(t, to);
                    }
                },
                json!({ "poolId": pool }),
                cx,
            );
        };
        if settings.pool().is_none() && settings.account == login {
            return;
        }
        let provider = data
            .logins
            .account(&login)
            .map(|a| a.provider_id().to_owned());
        let switched = provider
            .filter(|p| *p != settings.provider)
            .map(|p| provider_defaults(&data.logins, p));
        let guess = login.clone();
        self.change_thread(
            move |t| {
                t.account_id = guess;
                t.pool_id = None;
                if let Some(provider) = switched {
                    switch_provider(t, provider);
                }
            },
            json!({ "accountId": login }),
            cx,
        );
    }
}

/// Where a move to another provider's login leaves the model and effort:
/// the runner's defaults for that provider (`hello`'s `defaults.models` and
/// `defaults.efforts`), else the login's own.
struct ProviderSwitch {
    provider: String,
    model: Option<String>,
    effort: Option<String>,
}

fn provider_defaults(logins: &RunnerLogins, provider: String) -> ProviderSwitch {
    ProviderSwitch {
        model: logins.defaults.model_for(&provider).map(str::to_owned),
        effort: logins.defaults.efforts.get(&provider).cloned(),
        provider,
    }
}

/// The guess for that move: the runner resets the model and effort, so the
/// old provider's, in use or picked, mustn't show under the new login
/// meanwhile (Codex's review, 12 Nov).
fn switch_provider(t: &mut ThreadSummary, to: ProviderSwitch) {
    t.provider = to.provider;
    t.model = to.model;
    t.effort = to.effort;
    t.model_in_use = None;
    t.effort_in_use = None;
}

fn model_row(
    row: PickerRow,
    provider: &str,
    cx: &App,
    action: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let selected = row.is_selected;
    let (fg, secondary) = (cx.theme().foreground, cx.theme().muted_foreground);
    let (selected_fill, hover_fill) = (
        style::primary_opacity(cx, 0.09),
        style::primary_opacity(cx, 0.06),
    );
    let tile_fill = if selected {
        style::primary_opacity(cx, 0.12)
    } else {
        style::primary_opacity(cx, 0.065)
    };
    h_flex()
        .id(SharedString::from(format!("model-{provider}-{}", row.id)))
        .test_support()
        .role(Role::Button)
        .aria_label(SharedString::from(row.title.clone()))
        .gap(px(10.))
        .px(px(8.))
        .py(px(6.))
        .rounded(px(7.))
        .cursor_pointer()
        .when(selected, |s| s.bg(selected_fill))
        .when(!selected, |s| s.hover(move |s| s.bg(hover_fill)))
        .on_click(move |_, window, cx| action(window, cx))
        // `ModelRow`: the provider's logo on a faint tile.
        .child(
            div()
                .size(px(28.))
                .rounded(px(7.))
                .bg(tile_fill)
                .flex()
                .items_center()
                .justify_center()
                .when(row.is_older, |s| s.opacity(0.6))
                .child(
                    crate::icons::provider_mark(provider)
                        .with_size(px(14.))
                        .text_color(if selected { fg } else { secondary }),
                ),
        )
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(row.title.clone()),
                )
                .when_some(row.subtitle.clone().filter(|s| !s.is_empty()), |s, sub| {
                    s.child(
                        div()
                            .text_size(px(11.5))
                            .text_color(cx.theme().muted_foreground)
                            .truncate()
                            .child(sub),
                    )
                }),
        )
        .when(row.is_default || selected, |s| {
            s.child(
                h_flex()
                    .items_center()
                    .gap(px(6.))
                    .flex_shrink_0()
                    // The default, as a filled star (`star.fill`, tertiary).
                    .when(row.is_default, |s| {
                        s.child(
                            crate::icons::symbol("star.fill")
                                .with_size(px(10.))
                                .text_color(style::faint_text(cx)),
                        )
                    })
                    .when(selected, |s| {
                        s.child(
                            Icon::from(IconName::Check)
                                .with_size(px(12.))
                                .text_color(fg),
                        )
                    }),
            )
        })
}

/// The automation's search in the open model picker: `words` put in its
/// search box, which takes the keyboard, then Return pressed there.
#[cfg(feature = "automation")]
pub(crate) fn search_command(
    composer: &Entity<Composer>,
    words: &str,
    window: &mut Window,
    cx: &mut App,
) -> Result<(), String> {
    use gpui_kit::test::TestWindowExt as _;
    let picker = composer
        .read(cx)
        .model_picker
        .clone()
        .ok_or("the model picker isn't open")?;
    let search = picker.read(cx).search.clone();
    search.update(cx, |s, cx| {
        s.set_value(words.to_owned(), window, cx);
        s.focus(window, cx);
    });
    crate::web_panels::keyboard_to_app(window);
    window.render_frame(cx);
    window.press("enter", cx);
    Ok(())
}

/// The picker as text for the automation's `composer-menu` (ThreadSettings
/// pickerLines): `[x]` on the chosen row, `*` on the default, the description
/// after a dash, older rows indented, then the effort levels.
#[cfg(feature = "automation")]
pub(crate) fn picker_lines(composer: &Entity<Composer>, cx: &App) -> Vec<String> {
    let data = composer.read(cx).chip_data(cx);
    let list = login_list(composer, &data, cx);
    picker_lines_with(&data, list)
}

/// The Login line and its list (open or not) for the thread's own pool,
/// unpooled logins when pinned to an unpooled login, or a pinned thread's Auto
/// pool, as the automation reads and clicks them.
#[cfg(feature = "automation")]
fn login_list(
    composer: &Entity<Composer>,
    data: &ChipData,
    cx: &App,
) -> Option<(
    String,
    (String, Option<String>),
    Vec<threadbear_core::login_picker::PoolLoginRow>,
)> {
    let settings = data.settings()?;
    if !settings.uses_pools() {
        return None;
    }
    let accounts = &data.logins.accounts;
    let pinned_unpooled = settings.is_pinned_to_unpooled();
    let line = threadbear_core::login_picker::login_line_for(
        &settings.account,
        accounts,
        settings.pool(),
        pinned_unpooled,
    );
    let now = threadbear_core::chrono::Local::now();
    if pinned_unpooled {
        let rows = threadbear_core::login_picker::unpooled_login_rows(
            &data.logins.pools,
            accounts,
            None,
            None,
            Some(settings.account.as_str()),
            &now,
        );
        return Some((String::new(), line, rows));
    }
    let pool_id = match settings.pool() {
        Some(pool) => pool.id.clone(),
        None => composer.read(cx).unpin_pool(data, cx)?,
    };
    let pool = data.logins.pool(&pool_id)?;
    let pinned = settings.pool().is_none();
    let rows = threadbear_core::login_picker::pool_login_rows(
        pool,
        accounts,
        settings.pool().map(|p| p.id.as_str()),
        pinned.then_some(settings.account.as_str()),
        &now,
    );
    Some((pool_id, line, rows))
}

#[cfg(feature = "automation")]
fn picker_lines_with(
    data: &ChipData,
    login: Option<(
        String,
        (String, Option<String>),
        Vec<threadbear_core::login_picker::PoolLoginRow>,
    )>,
) -> Vec<String> {
    let Some(settings) = data.settings() else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    let add_rows = |rows: Vec<PickerRow>, lines: &mut Vec<String>| {
        for row in rows {
            let mut line = format!(
                "{}{}{}",
                if row.is_older { "    " } else { "" },
                if row.is_selected { "[x] " } else { "[ ] " },
                row.title
            );
            if row.is_default {
                line.push_str(" *");
            }
            if let Some(sub) = row.subtitle.filter(|s| !s.is_empty()) {
                line.push_str(&format!(" - {sub}"));
            }
            lines.push(line);
        }
    };
    // A pinned thread's own login first, as the picker opens on it (unless
    // it's pinned to an unpooled login, which opens on "# [x] No pool").
    let pinned = (settings.uses_pools()
        && settings.pool().is_none()
        && !settings.is_pinned_to_unpooled())
    .then(|| threadbear_core::login_picker::pinned_line(&settings.account, &data.logins.accounts));
    if let Some(line) = pinned {
        lines.push(format!("# {line}"));
        add_rows(settings.rows(&settings.provider, ""), &mut lines);
    }
    if settings.uses_pools() {
        for pool in &data.logins.pools {
            let is_own = settings.pool().is_some_and(|p| p.id == pool.id);
            lines.push(format!(
                "# {}{}",
                if is_own { "[x] " } else { "[ ] " },
                pool.title
            ));
            for section in settings.sections(&pool.id, "") {
                if let Some(title) = section.title {
                    lines.push(format!("## {title}"));
                }
                add_rows(section.rows, &mut lines);
            }
        }
        if settings.has_unpooled() {
            let is_own = settings.is_pinned_to_unpooled();
            lines.push(format!("# {}No pool", if is_own { "[x] " } else { "[ ] " }));
            for section in settings.sections(UNPOOLED_COLUMN, "") {
                if let Some(title) = section.title {
                    lines.push(format!("## {title}"));
                }
                add_rows(section.rows, &mut lines);
            }
        }
    } else {
        let mut seen: Vec<String> = Vec::new();
        for a in &data.logins.accounts {
            if !seen.iter().any(|p| p == a.provider_id()) {
                seen.push(a.provider_id().to_owned());
            }
        }
        for provider in seen {
            lines.push(format!("# {}", data.logins.provider_title(&provider)));
            add_rows(settings.rows(&provider, ""), &mut lines);
        }
    }
    lines.push("# Effort".to_owned());
    let chosen = settings.effective_effort();
    for level in settings.effort_levels() {
        let mut line = format!(
            "{}{}",
            if chosen.as_deref() == Some(level.as_str()) {
                "[x] "
            } else {
                "[ ] "
            },
            effort_title(&level)
        );
        if let Some(porridge) = effort_porridge(&level) {
            line.push_str(&format!(" - {porridge}"));
        }
        lines.push(line);
    }
    if let Some((_, line, rows)) = login {
        lines.extend(threadbear_core::login_picker::pool_login_lines(
            &line, &rows,
        ));
    }
    lines
}

/// A chip's badge as it reads after its title (`ComposerChip`).
pub(crate) fn badge_words(badge: &ChipBadge) -> String {
    match badge {
        ChipBadge::Low(percent) => format!("\u{00B7} {percent}"),
        ChipBadge::Blocked => "Limit reached".to_owned(),
        ChipBadge::SignedOut => "Signed out".to_owned(),
        ChipBadge::PlanEnded => "Plan ended".to_owned(),
    }
}

/// The model chip's words, for the dump's `composer.chip`.
#[cfg(feature = "automation")]
pub(crate) fn model_chip_text(data: &ChipData) -> String {
    data.settings()
        .map(|s| s.model_chip_title())
        .unwrap_or_default()
}

/// What the `account` or model chip is called (its words), for a script
/// to click it; None where that chip isn't shown.
#[cfg(feature = "automation")]
pub(crate) fn chip_title(data: &ChipData, menu: &str) -> Option<String> {
    let settings = data.settings()?;
    match menu {
        "account" => (!settings.uses_pools()).then(|| settings.account_chip_title()),
        _ => Some(settings.model_chip_title()),
    }
}

/// The model chip's badge as it reads, for the dump's `composer.chipBadge`.
#[cfg(feature = "automation")]
pub(crate) fn model_chip_badge_text(data: &ChipData) -> Option<String> {
    data.settings()
        .and_then(|s| s.model_chip_badge())
        .map(|b| badge_words(&b))
}

/// The modes the permission menu offers, in its order.
#[cfg(feature = "automation")]
pub(crate) fn permission_modes(
    summary: &ThreadSummary,
    logins: &RunnerLogins,
) -> Vec<&'static str> {
    if logins.has_auto_mode(&summary.provider) || summary.permission_mode == "auto" {
        vec!["full", "auto", "ask", "plan"]
    } else {
        vec!["full", "ask", "plan"]
    }
}

/// The permission menu as text (Automation's describe(menu)).
#[cfg(feature = "automation")]
pub(crate) fn permission_lines(summary: &ThreadSummary, logins: &RunnerLogins) -> Vec<String> {
    let current = if summary.permission_mode.is_empty() {
        "full"
    } else {
        summary.permission_mode.as_str()
    };
    permission_modes(summary, logins)
        .into_iter()
        .map(|m| {
            format!(
                "{}{} - {}",
                if m == current { "[x] " } else { "[ ] " },
                permission_title(m),
                permission_help(m)
            )
        })
        .collect()
}

/// The limit box's Continue now picker for `composer-menu` (`limit`): the
/// pool it's on and its Login list's titles, or a pick from that list as a
/// click there makes it (carrying on).
#[cfg(feature = "automation")]
pub(crate) fn limit_menu_command(
    composer: &Entity<Composer>,
    click: Option<&str>,
    cx: &mut App,
) -> Result<serde_json::Value, String> {
    let picker = composer
        .read(cx)
        .limit_picker
        .clone()
        .ok_or("Continue now hasn't been opened")?;
    let data = composer.read(cx).chip_data(cx);
    let now = threadbear_core::chrono::Local::now();
    let (pool_id, rows, carry_on) = {
        let p = picker.read(cx);
        let listing = p.listed(&data, cx).ok_or("no thread")?;
        let (pool_id, rows) = p
            .login_rows(
                &data,
                &listing.pool,
                listing.active_provider.as_deref(),
                &now,
                cx,
            )
            .ok_or("Continue now's picker has no Login list")?;
        (pool_id, rows, p.from_limit)
    };
    let pool_title = data
        .logins
        .pool(&pool_id)
        .map_or_else(|| "No pool".to_owned(), |p| p.title.clone());
    let Some(name) = click else {
        let titles: Vec<String> = rows.into_iter().map(|r| r.title).collect();
        return Ok(json!({ "pool": pool_title, "logins": titles }));
    };
    let row = rows
        .into_iter()
        .find(|r| r.title == name || r.id.as_deref() == Some(name))
        .ok_or_else(|| format!("no login {name}"))?;
    pick_on(composer, carry_on, cx, |c, cx| {
        c.pick_login(row.id, &pool_id, cx)
    });
    Ok(json!("ok"))
}

/// Picks a model row or effort level by its title, as a click would
/// (ThreadSettings.pickerClick).
#[cfg(feature = "automation")]
pub(crate) fn picker_click(
    composer: &Entity<Composer>,
    title: &str,
    cx: &mut App,
) -> Result<(), String> {
    let data = composer.read(cx).chip_data(cx);
    let settings = data.settings().ok_or("no thread")?;
    // A row of the Login list, "Login: Auto" or "Login: mike+3" (its name
    // or id), as its click does; "Unpin" is Auto on a pinned thread.
    let login = title
        .strip_prefix("Login: ")
        .or((title == "Unpin").then_some("Auto"));
    if let Some(name) = login {
        if title == "Unpin" && (!settings.uses_pools() || settings.pool().is_some()) {
            return Err("it isn't pinned".into());
        }
        let (pool, _, rows) = login_list(composer, &data, cx).ok_or("no Login line here")?;
        let row = rows
            .into_iter()
            .find(|r| r.title == name || r.id.as_deref() == Some(name))
            .ok_or_else(|| format!("no login {name}"))?;
        composer.update(cx, |c, cx| c.pick_login(row.id, &pool, cx));
        return Ok(());
    }
    let columns: Vec<String> = if settings.uses_pools() {
        let mut order: Vec<&threadbear_core::logins::Pool> = data.logins.pools.iter().collect();
        if let Some(own) = settings.pool() {
            order.sort_by_key(|p| p.id != own.id);
        }
        // A pinned thread's own login first, as the picker lists it, so a
        // pick there stays on that login rather than moving into a pool.
        let head = if settings.is_pinned_to_unpooled() {
            Some(UNPOOLED_COLUMN.to_owned())
        } else if settings.pool().is_none() {
            Some(PINNED_COLUMN.to_owned())
        } else {
            None
        };
        let tail = (settings.has_unpooled() && !settings.is_pinned_to_unpooled())
            .then(|| UNPOOLED_COLUMN.to_owned());
        head.into_iter()
            .chain(order.iter().map(|p| p.id.clone()))
            .chain(tail)
            .collect()
    } else {
        let mut providers: Vec<String> = Vec::new();
        for a in &data.logins.accounts {
            if !providers.iter().any(|p| p == a.provider_id()) {
                providers.push(a.provider_id().to_owned());
            }
        }
        providers
    };
    for column in &columns {
        // The thread's own provider first, where two list the same title.
        let mut sections = settings.sections(column, "");
        sections.sort_by_key(|s| s.provider != settings.provider);
        for section in sections {
            if let Some(row) = section.rows.into_iter().find(|r| r.title == title) {
                composer.update(cx, |c, cx| {
                    c.pick_model(&row, column, &section.provider, &data, cx)
                });
                return Ok(());
            }
        }
    }
    if let Some(level) = settings
        .effort_levels()
        .into_iter()
        .find(|l| effort_title(l) == title)
    {
        composer.update(cx, |c, cx| c.set_effort(level, cx));
        return Ok(());
    }
    Err(format!("no item {title}"))
}
