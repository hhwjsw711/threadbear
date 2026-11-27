// What a runner's `hello` says about its logins, for the composer's chips and
// pickers: a port of RunnerLogins, Account, ModelChoice and Pool, and of what
// ThreadSettings, ModelPicker and Pools work out from them. Lenient, as the
// protocol's readers are: an unknown or missing field never fails.
use crate::composer::{effort_title, model_title, CODEX_EFFORT_LEVELS, EFFORT_LEVELS};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelChoice {
    #[serde(default, deserialize_with = "crate::wire::id")]
    pub id: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub model: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub title: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::list")]
    pub effort_levels: Vec<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub default_effort: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Account {
    #[serde(default, deserialize_with = "crate::wire::id")]
    pub id: String,
    // The provider selects the CLI and credential folder. A wrong type must
    // not turn a Codex account into Claude through provider_id's old fallback.
    #[serde(default)]
    pub provider: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub title: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub default_model: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::list")]
    pub models: Vec<ModelChoice>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub default_effort: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub email: Option<String>,
    /// "Max", "Team", "Pro Lite": the Usage panel's tip on a login.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub plan: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub note: Option<String>,
    /// Kept as it came (AccountUsage), for the badge a later slice draws.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub usage: Option<Value>,
    /// Where the login's CLI keeps its sign-in, for Sign in… (sign_in.rs).
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub config_dir: String,
    /// Claude: no turn can run on it until someone signs it in again
    /// (docs/protocol/settings.md, Pools, "Signed out"). Pools skip it.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub signed_out: bool,
    /// Claude: when this sign-in ends and can't be renewed (28 days after
    /// signing in, from Claude Code 2.1.325). The Usage panel warns ahead.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub login_ends_at: Option<String>,
    /// Claude: its paid plan has lapsed to the free one, which has no Claude
    /// Code. Pools skip it; nothing offers Sign in… or a reset for it.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub plan_ended: bool,
    /// Claude: runs on a year-long token Mike made for it (Year-long token…
    /// on its Usage row, sign_in.rs), not its 28-day sign-in. The token
    /// itself never comes to the app.
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub year_token: Option<YearToken>,
    /// A usage reset worth using now, as the runner works it out
    /// (docs/protocol/settings.md, "Telling Mike about resets"): the Usage
    /// row, the Usage button and the login lists draw it (reset_hint.rs).
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub reset_hint: Option<ResetHint>,
}

/// `Account.resetHint`: why ("out" or "expiring"), how many resets are
/// left, and when the soonest expires.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ResetHint {
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub why: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub available: u64,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub next_expires_at: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct YearToken {
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub made_at: Option<String>,
}

impl Account {
    /// The account's provider, "claude" when none is given (ProviderInfo).
    pub fn provider_id(&self) -> &str {
        if self.provider.is_empty() {
            "claude"
        } else {
            &self.provider
        }
    }

    /// AccountName.title: the bare address when the runner sends one, else
    /// the title without Codex's "Codex · " prefix, else the id.
    pub fn name(&self) -> String {
        if let Some(email) = self.email.as_deref().filter(|e| !e.is_empty()) {
            return email.to_owned();
        }
        if let Some(rest) = self.title.strip_prefix("Codex · ") {
            return rest.to_owned();
        }
        if self.title.is_empty() {
            self.id.clone()
        } else {
            self.title.clone()
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Pool {
    #[serde(default, deserialize_with = "crate::wire::id")]
    pub id: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub title: String,
    #[serde(default, deserialize_with = "crate::wire::list")]
    pub account_ids: Vec<String>,
    /// Per-login overrides; missing means backup for Grok and OpenCode.
    #[serde(default, deserialize_with = "crate::wire::map")]
    pub backup: HashMap<String, bool>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub icon: Option<String>,
    /// Folders whose threads start in this pool (`Pools.forFolder`).
    #[serde(default, deserialize_with = "crate::wire::list")]
    pub folders: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RunnerDefaults {
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub cwd: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub account_id: String,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub pool_id: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub model: Option<String>,
    #[serde(default, deserialize_with = "crate::wire::map")]
    pub models: HashMap<String, String>,
    #[serde(default, deserialize_with = "crate::wire::map")]
    pub efforts: HashMap<String, String>,
    #[serde(default, deserialize_with = "crate::wire::field")]
    pub permission_mode: Option<String>,
}

impl RunnerDefaults {
    /// The model a new thread on `provider` gets when it names none.
    pub fn model_for(&self, provider: &str) -> Option<&str> {
        self.models
            .get(provider)
            .map(String::as_str)
            .or(if provider == "claude" {
                self.model.as_deref()
            } else {
                None
            })
    }
}

/// Fields the runner reports about a provider. Options preserve the older
/// runner fallback independently for each missing or unreadable field.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderInfo {
    #[serde(deserialize_with = "crate::wire::id")]
    pub id: String,
    #[serde(deserialize_with = "crate::wire::field")]
    pub name: Option<String>,
    #[serde(deserialize_with = "crate::wire::field")]
    pub cli_name: Option<String>,
    #[serde(deserialize_with = "crate::wire::field")]
    pub effort: Option<String>,
    #[serde(deserialize_with = "crate::wire::field")]
    pub auto_mode: Option<String>,
    #[serde(deserialize_with = "crate::wire::field")]
    pub rewind: Option<bool>,
}

/// A runner's logins (RunnerLogins), filled from its `hello`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunnerLogins {
    pub accounts: Vec<Account>,
    pub providers: Vec<ProviderInfo>,
    pub pools: Vec<Pool>,
    /// Remote pools for Usage; remote creation still chooses a login.
    pub usage_pools: Option<Vec<Pool>>,
    pub defaults: RunnerDefaults,
    /// Sign-in commands declared by this runner, replaced on every hello.
    pub login_commands: HashMap<String, String>,
}

impl RunnerLogins {
    pub fn login_command(&self, provider: &str) -> &str {
        self.login_commands
            .get(provider)
            .map(String::as_str)
            .unwrap_or_else(|| crate::sign_in::login_command(provider))
    }
    pub fn from_hello(hello: &Value) -> RunnerLogins {
        let login_commands = hello["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| {
                let id = p["id"].as_str().filter(|s| !s.is_empty())?;
                let command = p["loginCommand"].as_str()?;
                Some((id.to_owned(), command.trim().to_owned()))
            })
            .collect();
        RunnerLogins {
            accounts: accounts_from(&hello["accounts"]),
            providers: lossy(&hello["providers"]),
            pools: pools_from(&hello["pools"]),
            usage_pools: hello.get("usagePools").map(pools_from),
            defaults: hello
                .get("defaults")
                .cloned()
                .and_then(crate::wire::read)
                .unwrap_or_default(),
            login_commands,
        }
    }

    pub fn provider(&self, id: &str) -> Option<&ProviderInfo> {
        let id = if id.is_empty() { "claude" } else { id };
        self.providers.iter().find(|p| p.id == id)
    }

    pub fn provider_title(&self, id: &str) -> String {
        self.provider(id)
            .and_then(|p| p.name.as_deref())
            .filter(|n| !n.trim().is_empty())
            .map_or_else(|| provider_title(id), str::to_owned)
    }

    pub fn cli_name(&self, id: &str) -> String {
        self.provider(id)
            .and_then(|p| p.cli_name.as_deref())
            .filter(|n| !n.trim().is_empty())
            .map_or_else(|| crate::slash::cli_name(id), str::to_owned)
    }

    pub fn has_auto_mode(&self, id: &str) -> bool {
        match self.provider(id).and_then(|p| p.auto_mode.as_deref()) {
            Some("classifier") => true,
            Some("asks") => false,
            _ => has_auto_mode(id),
        }
    }

    pub fn can_rewind(&self, id: &str) -> bool {
        self.provider(id)
            .and_then(|p| p.rewind)
            .unwrap_or_else(|| crate::composer::can_rewind(id))
    }

    pub fn effort_levels(
        &self,
        model: Option<&str>,
        choices: &[ModelChoice],
        provider: &str,
    ) -> Vec<String> {
        // No effort support is authoritative, even if a cached model still
        // lists levels. Otherwise the model can narrow the provider's list.
        if self.provider(provider).and_then(|p| p.effort.as_deref()) == Some("none") {
            return Vec::new();
        }
        if let Some(choice) = model.and_then(|m| choice_for(m, choices)) {
            if !choice.effort_levels.is_empty() {
                return choice.effort_levels.clone();
            }
            // When the login's model list reports effortLevels, a model that
            // omits them (Haiku 4.5, an OpenCode model with no thinking option)
            // takes no effort level.
            if choices.iter().any(|c| !c.effort_levels.is_empty()) {
                return Vec::new();
            }
        }
        match self.provider(provider).and_then(|p| p.effort.as_deref()) {
            Some("none") => Vec::new(),
            Some("claude") => EFFORT_LEVELS.iter().map(|s| s.to_string()).collect(),
            Some("codex") => CODEX_EFFORT_LEVELS.iter().map(|s| s.to_string()).collect(),
            _ => effort_levels(model, choices, provider),
        }
    }

    /// `accounts.updated`: the logins, which replace the ones from `hello`.
    pub fn set_accounts(&mut self, accounts: &Value) {
        self.accounts = accounts_from(accounts);
    }

    /// The logins given a year-long token since `before`: a first one, or a
    /// new one in place of an older. The app throws confetti from their
    /// Usage rows (confetti.rs). A login new to the list doesn't count, nor
    /// one whose token went.
    pub fn new_year_tokens(&self, before: &[Account]) -> Vec<String> {
        self.accounts
            .iter()
            .filter(|a| a.year_token.is_some())
            .filter(|a| {
                before
                    .iter()
                    .any(|b| b.id == a.id && b.year_token != a.year_token)
            })
            .map(|a| a.id.clone())
            .collect()
    }

    /// The logins signed back in since `before`: signed out then, not now.
    /// The app throws confetti for them too.
    pub fn signed_back_in(&self, before: &[Account]) -> Vec<String> {
        self.accounts
            .iter()
            .filter(|a| !a.signed_out)
            .filter(|a| before.iter().any(|b| b.id == a.id && b.signed_out))
            .map(|a| a.id.clone())
            .collect()
    }

    /// One login as the runner has it now (`accounts.useReset`'s answer),
    /// in its place; a login not in the list is left out.
    pub fn replace_account(&mut self, account: &Value) {
        for a in accounts_from(&Value::Array(vec![account.clone()])) {
            if let Some(slot) = self.accounts.iter_mut().find(|x| x.id == a.id) {
                *slot = a;
            }
        }
    }

    /// `replace_account` for an answer that may be another runner's login:
    /// only where this list has the same login, the same id, provider and
    /// email, as the same id on another runner can be another login.
    pub fn replace_same_login(&mut self, account: &Value) {
        for a in accounts_from(&Value::Array(vec![account.clone()])) {
            let email = a.email.as_deref().map(str::to_lowercase);
            if let Some(slot) = self.accounts.iter_mut().find(|x| {
                x.id == a.id
                    && x.provider_id() == a.provider_id()
                    && email.is_some()
                    && x.email.as_deref().map(str::to_lowercase) == email
            }) {
                *slot = a;
            }
        }
    }

    /// `pools.updated`: the pools, which replace the ones from `hello`.
    pub fn set_pools(&mut self, pools: &Value) {
        self.pools = pools_from(pools);
    }

    pub fn account(&self, id: &str) -> Option<&Account> {
        self.accounts.iter().find(|a| a.id == id)
    }

    pub fn pool(&self, id: &str) -> Option<&Pool> {
        self.pools.iter().find(|p| p.id == id)
    }

    /// Whether pools are in use: the rail lists them, and the login is the
    /// runner's to pick unless the thread is pinned (ThreadSettings.usesPools).
    pub fn uses_pools(&self) -> bool {
        !self.pools.is_empty()
    }

    /// The logins not belonging to any pool.
    pub fn unpooled_accounts(&self) -> Vec<&Account> {
        crate::new_thread::unpooled_logins(&self.pools, &self.accounts, None)
    }

    /// Whether `account_id` is a known login that doesn't belong to any pool.
    pub fn is_unpooled(&self, account_id: &str) -> bool {
        self.uses_pools()
            && self.account(account_id).is_some()
            && !self
                .pools
                .iter()
                .any(|p| p.account_ids.iter().any(|id| id == account_id))
    }
}

/// Sentinel pool column for the "No pool" tab when pools are in use and at
/// least one login isn't in any pool.
pub const UNPOOLED_COLUMN: &str = "@unpooled";

fn accounts_from(v: &Value) -> Vec<Account> {
    let mut accounts: Vec<Account> = lossy(v);
    for account in &mut accounts {
        for model in &mut account.models {
            // `model` and `title` fall back to the id (ModelChoice.init).
            if model.model.is_empty() {
                model.model = model.id.clone();
            }
            if model.title.is_empty() {
                model.title = model.id.clone();
            }
        }
    }
    accounts
}

fn pools_from(v: &Value) -> Vec<Pool> {
    let mut pools: Vec<Pool> = lossy(v);
    for pool in &mut pools {
        if pool.title.is_empty() {
            pool.title = pool.id.clone();
        }
    }
    pools
}

fn lossy<T: serde::de::DeserializeOwned>(v: &Value) -> Vec<T> {
    v.as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| crate::wire::read(item.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// How a provider id reads (Providers.info).
pub fn provider_title(id: &str) -> String {
    match id {
        "claude" | "" => "Claude".to_owned(),
        "codex" => "Codex".to_owned(),
        "opencode" => "OpenCode".to_owned(),
        "antigravity" => "Gemini".to_owned(),
        other => {
            let mut chars = other.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        }
    }
}

/// Whether a provider's Auto mode is a real judge (Providers autoMode
/// "classifier"), or behaves like Ask.
pub fn has_auto_mode(provider: &str) -> bool {
    provider == "claude" || provider.is_empty()
}

/// A model's row in the picker (ModelPicker.Row).
#[derive(Clone, Debug, PartialEq)]
pub struct PickerRow {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub is_default: bool,
    pub is_selected: bool,
    pub is_older: bool,
}

/// One provider's models in a picker column (ModelPicker.Section), with
/// its name over them when the column has more than one provider.
#[derive(Clone, Debug, PartialEq)]
pub struct PickerSection {
    pub provider: String,
    pub title: Option<String>,
    pub rows: Vec<PickerRow>,
}

/// ComposerChips.choice: the picker row an id belongs to.
pub fn choice_for<'a>(id: &str, choices: &'a [ModelChoice]) -> Option<&'a ModelChoice> {
    choices
        .iter()
        .find(|c| c.id == id)
        .or_else(|| choices.iter().find(|c| c.model == id))
}

/// ComposerChips.resolvedModel: the first id that's set.
pub fn resolved_model<'a>(ids: &[Option<&'a str>]) -> Option<&'a str> {
    ids.iter().find_map(|id| id.filter(|s| !s.is_empty()))
}

/// ComposerChips.modelTitle: the CLI's own title for an id when the list is
/// known, else as `model_title` formats it.
pub fn model_title_with(id: Option<&str>, choices: &[ModelChoice]) -> String {
    match id.filter(|s| !s.is_empty()) {
        None => "Default".to_owned(),
        Some(id) => {
            choice_for(id, choices).map_or_else(|| model_title(Some(id)), |c| c.title.clone())
        }
    }
}

/// ComposerChips.chipTitle: "Fable 5.1 · High".
pub fn chip_title(model: Option<&str>, effort: Option<&str>, choices: &[ModelChoice]) -> String {
    let title = model_title_with(model, choices);
    match effort.filter(|e| !e.is_empty()) {
        Some(effort) => format!("{title} · {}", effort_title(effort)),
        None => title,
    }
}

/// ModelPicker.rows: one account's list. For Claude the main rows are the
/// aliases plus whatever the default and the chosen model are; dated and old
/// full ids are older. Codex ids are all dashed, so every model is a main row.
pub fn picker_rows(
    choices: &[ModelChoice],
    default_id: Option<&str>,
    selected: Option<&str>,
    query: &str,
    provider: &str,
) -> Vec<PickerRow> {
    let codex = provider != "claude" && !provider.is_empty();
    let fallback: Vec<ModelChoice> = if codex {
        default_id
            .filter(|d| !d.is_empty())
            .map(|d| {
                vec![ModelChoice {
                    id: d.into(),
                    model: d.into(),
                    title: model_title(Some(d)),
                    ..Default::default()
                }]
            })
            .unwrap_or_default()
    } else {
        ["opus", "sonnet", "haiku"]
            .iter()
            .map(|a| ModelChoice {
                id: (*a).into(),
                model: (*a).into(),
                title: model_title(Some(a)),
                ..Default::default()
            })
            .collect()
    };
    let known: &[ModelChoice] = if choices.is_empty() {
        &fallback
    } else {
        choices
    };
    let matches = |c: &ModelChoice, id: Option<&str>| {
        id.filter(|s| !s.is_empty())
            .is_some_and(|id| c.id == id || c.model == id)
    };
    let is_main = |c: &ModelChoice| {
        codex
            || c.id.chars().all(char::is_alphabetic)
            || matches(c, default_id)
            || matches(c, selected)
    };
    let mut rows: Vec<PickerRow> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut add = |c: &ModelChoice, older: bool, rows: &mut Vec<PickerRow>| {
        if seen.insert(c.model.clone()) {
            rows.push(PickerRow {
                id: c.id.clone(),
                title: c.title.clone(),
                subtitle: c.description.clone(),
                is_default: matches(c, default_id),
                is_selected: matches(c, selected),
                is_older: older,
            });
        }
    };
    for c in known.iter().filter(|c| is_main(c)) {
        add(c, false, &mut rows);
    }
    if let Some(selected) = selected.filter(|s| !s.is_empty()) {
        if !known.iter().any(|c| matches(c, Some(selected))) {
            rows.push(PickerRow {
                id: selected.to_owned(),
                title: model_title(Some(selected)),
                subtitle: None,
                is_default: false,
                is_selected: true,
                is_older: false,
            });
        }
    }
    for c in known.iter().filter(|c| !is_main(c)) {
        add(c, true, &mut rows);
    }
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return rows;
    }
    rows.into_iter()
        .filter(|r| {
            r.title.to_lowercase().contains(&needle)
                || r.id.to_lowercase().contains(&needle)
                || r.subtitle
                    .as_deref()
                    .is_some_and(|s| s.to_lowercase().contains(&needle))
        })
        .map(|mut r| {
            r.is_older = false;
            r
        })
        .collect()
}

/// ModelPicker.effortLevels: the levels the picker offers for a model.
pub fn effort_levels(model: Option<&str>, choices: &[ModelChoice], provider: &str) -> Vec<String> {
    let provider_levels = || -> Vec<String> {
        match provider {
            "codex" => CODEX_EFFORT_LEVELS.iter().map(|s| s.to_string()).collect(),
            "claude" | "" => EFFORT_LEVELS.iter().map(|s| s.to_string()).collect(),
            _ => Vec::new(),
        }
    };
    match model.and_then(|m| choice_for(m, choices)) {
        Some(choice) if !choice.effort_levels.is_empty() => choice.effort_levels.clone(),
        Some(_) if choices.iter().any(|c| !c.effort_levels.is_empty()) => Vec::new(),
        _ => provider_levels(),
    }
}

/// ModelPicker.impliedEffort: the level a thread with none chosen runs at.
pub fn implied_effort(
    model: Option<&str>,
    choices: &[ModelChoice],
    account: Option<&Account>,
    runner_default: Option<&str>,
) -> Option<String> {
    if let Some(d) = runner_default.filter(|d| !d.is_empty()) {
        return Some(d.to_owned());
    }
    if let Some(own) = account
        .and_then(|a| a.default_effort.as_deref())
        .filter(|d| !d.is_empty())
    {
        return Some(own.to_owned());
    }
    model
        .and_then(|m| choice_for(m, choices))
        .and_then(|c| c.default_effort.clone())
}

/// What the composer's chips say about a thread, or the settings a new thread
/// starts with (ThreadSettings). All the strings the chips need, worked out
/// here so the tests can read them.
pub struct ChipSettings<'a> {
    pub logins: &'a RunnerLogins,
    pub account: String,
    pub provider: String,
    pub pool_id: Option<String>,
    pub model: Option<String>,
    pub model_in_use: Option<String>,
    pub effort: Option<String>,
    pub effort_in_use: Option<String>,
    pub permission_mode: String,
    pub cwd: String,
    /// The settings a new thread starts with, not a thread's own: its
    /// defaults come from the runner (ThreadSettings.defaultModel and
    /// effectiveEffort, which take `thread == nil` to mean this).
    pub is_new: bool,
}

impl<'a> ChipSettings<'a> {
    pub fn choices(&self) -> &'a [ModelChoice] {
        self.logins
            .account(&self.account)
            .map_or(&[], |a| a.models.as_slice())
    }

    pub fn default_model(&self) -> Option<String> {
        let runner_default = if self.is_new {
            self.logins.defaults.model_for(&self.provider)
        } else {
            self.model_in_use.as_deref()
        };
        resolved_model(&[
            runner_default,
            self.logins
                .account(&self.account)
                .and_then(|a| a.default_model.as_deref()),
        ])
        .map(str::to_owned)
    }

    pub fn effective_model(&self) -> Option<String> {
        resolved_model(&[self.model.as_deref(), self.default_model().as_deref()]).map(str::to_owned)
    }

    pub fn effective_effort(&self) -> Option<String> {
        let runner_default = if self.is_new {
            self.logins
                .defaults
                .efforts
                .get(&self.provider)
                .map(String::as_str)
        } else {
            None
        };
        self.effort
            .clone()
            .or_else(|| self.effort_in_use.clone())
            .or_else(|| {
                implied_effort(
                    self.effective_model().as_deref(),
                    self.choices(),
                    self.logins.account(&self.account),
                    runner_default,
                )
            })
    }

    pub fn uses_pools(&self) -> bool {
        self.logins.uses_pools()
    }

    pub fn pool(&self) -> Option<&'a Pool> {
        if !self.uses_pools() {
            return None;
        }
        self.pool_id.as_deref().and_then(|id| self.logins.pool(id))
    }

    /// Who runs it, at the front of the model chip (ThreadSettings.owner):
    /// the pool's title, or a pinned login's name (`AccountName.login`). None
    /// without pools.
    pub fn owner(&self) -> Option<String> {
        if !self.uses_pools() {
            return None;
        }
        match self.pool() {
            Some(pool) => Some(pool.title.clone()),
            None => self
                .logins
                .account(&self.account)
                .map(|_| crate::new_thread::login_name(&self.account, &self.logins.accounts)),
        }
    }

    /// The model chip (ThreadSettings.modelChipTitle): "Claude · Fable 5.1 · High".
    /// `ThreadSettings.modelChipBadge`: with pools, the pool's badge when
    /// every login in it is running out, or a pinned login's own.
    pub fn model_chip_badge(&self) -> Option<crate::new_thread::ChipBadge> {
        if !self.uses_pools() {
            return None;
        }
        match self.pool() {
            Some(pool) => crate::new_thread::pool_chip_badge(pool, &self.logins.accounts),
            None => crate::new_thread::chip_badge(self.logins.account(&self.account)),
        }
    }

    /// `ThreadSettings.accountBadge`: the account chip's "· 12%" or "Limit reached".
    pub fn account_badge(&self) -> Option<crate::new_thread::ChipBadge> {
        crate::new_thread::chip_badge(self.logins.account(&self.account))
    }

    pub fn model_chip_title(&self) -> String {
        let rest = chip_title(
            self.effective_model().as_deref(),
            self.effective_effort().as_deref(),
            self.choices(),
        );
        match self.owner().filter(|o| !o.is_empty()) {
            Some(owner) => format!("{owner} · {rest}"),
            None => rest,
        }
    }

    /// The chip's tooltip (ThreadSettings.modelChipHelp).
    pub fn model_chip_help(&self) -> String {
        let mut parts = Vec::new();
        if let Some(pool) = self.pool() {
            parts.push(format!("{} pool", pool.title));
        } else if self.uses_pools() {
            parts.push(format!(
                "Pinned to {}",
                self.logins
                    .account(&self.account)
                    .map_or_else(|| self.account.clone(), |a| a.name())
            ));
        }
        if let Some(model) = &self.model {
            parts.push(model.clone());
        } else if let Some(default) = self.default_model() {
            parts.push(format!("{default}, the default"));
        } else {
            parts.push("The account's default model".to_owned());
        }
        if let Some(effort) = &self.effort {
            parts.push(format!("{} effort", effort_title(effort).to_lowercase()));
        } else if let Some(level) = &self.effort_in_use {
            parts.push(format!("{level} effort, the model's own level"));
        } else if let Some(level) = self.effective_effort() {
            parts.push(format!(
                "{} effort, the default",
                effort_title(&level).to_lowercase()
            ));
        } else {
            parts.push("the model's own effort level".to_owned());
        }
        parts.join(", ")
    }

    pub fn account_chip_title(&self) -> String {
        short_account_name(&self.account, &self.logins.accounts)
    }

    pub fn account_chip_help(&self) -> String {
        self.logins.account(&self.account).map_or_else(
            || self.account.clone(),
            |a| match &a.note {
                Some(note) if !note.is_empty() => format!("{} ({note})", a.name()),
                _ => a.name(),
            },
        )
    }

    pub fn permission_title(&self) -> &'static str {
        permission_title(&self.permission_mode)
    }

    pub fn permission_help(&self) -> &'static str {
        permission_help(&self.permission_mode)
    }

    /// The modes the permission menu offers: Auto needs a provider with its
    /// own judge of each action, or a thread already on it.
    pub fn permission_modes(&self) -> Vec<&'static str> {
        if self.logins.has_auto_mode(&self.provider) || self.permission_mode == "auto" {
            vec!["full", "auto", "ask", "plan"]
        } else {
            vec!["full", "ask", "plan"]
        }
    }

    /// The model rows of a provider's column (ThreadSettings.rows).
    pub fn rows(&self, provider: &str, query: &str) -> Vec<PickerRow> {
        let own = provider == self.provider;
        let listed = if own {
            Some(self.account.as_str())
        } else {
            self.logins
                .accounts
                .iter()
                .find(|a| a.provider_id() == provider)
                .map(|a| a.id.as_str())
        };
        let Some(listed) = listed else {
            return picker_rows(&[], None, None, query, provider);
        };
        let account = self.logins.account(listed);
        let choices = account.map_or(&[][..], |a| a.models.as_slice());
        let default = if own {
            self.default_model()
        } else {
            self.logins
                .defaults
                .model_for(provider)
                .map(str::to_owned)
                .or_else(|| account.and_then(|a| a.default_model.clone()))
        };
        picker_rows(
            choices,
            default.as_deref(),
            if own { self.effective_model() } else { None }.as_deref(),
            query,
            provider,
        )
    }

    /// Whether pools are in use and at least one login isn't in any pool.
    pub fn has_unpooled(&self) -> bool {
        self.uses_pools() && !self.logins.unpooled_accounts().is_empty()
    }

    /// Whether this thread is pinned (no pool) to a login that isn't in any pool.
    pub fn is_pinned_to_unpooled(&self) -> bool {
        self.uses_pools() && self.pool().is_none() && self.logins.is_unpooled(&self.account)
    }

    fn group_provider_rows(
        &self,
        own: bool,
        logins: &[&Account],
        provider: &str,
        query: &str,
    ) -> Vec<PickerRow> {
        // The login whose list it shows: the thread's own, else (or
        // when its own lists none, signed out or not yet asked) the
        // first of the group's that lists models.
        let listing = logins
            .iter()
            .find(|a| !a.models.is_empty())
            .or(logins.first())
            .copied();
        if own {
            let choices = if self.choices().is_empty() {
                listing.map_or(&[][..], |a| a.models.as_slice())
            } else {
                self.choices()
            };
            let default = self
                .default_model()
                .or_else(|| listing.and_then(|a| a.default_model.clone()));
            let chosen =
                resolved_model(&[self.model.as_deref(), default.as_deref()]).map(str::to_owned);
            picker_rows(
                choices,
                default.as_deref(),
                chosen.as_deref(),
                query,
                provider,
            )
        } else {
            let default = self
                .logins
                .defaults
                .model_for(provider)
                .map(str::to_owned)
                .or_else(|| listing.and_then(|a| a.default_model.clone()));
            picker_rows(
                listing.map_or(&[][..], |a| a.models.as_slice()),
                default.as_deref(),
                None,
                query,
                provider,
            )
        }
    }

    fn pool_provider_rows(&self, shown: &Pool, provider: &str, query: &str) -> Vec<PickerRow> {
        let own = self.pool().is_some_and(|p| p.id == shown.id) && provider == self.provider;
        let logins = crate::new_thread::pool_logins(shown, &self.logins.accounts, Some(provider));
        self.group_provider_rows(own, &logins, provider, query)
    }

    fn unpooled_provider_rows(&self, provider: &str, query: &str) -> Vec<PickerRow> {
        let own = self.is_pinned_to_unpooled() && provider == self.provider;
        let logins = crate::new_thread::unpooled_logins(
            &self.logins.pools,
            &self.logins.accounts,
            Some(provider),
        );
        self.group_provider_rows(own, &logins, provider, query)
    }

    /// A column's models (ThreadSettings.sections). Without pools a column
    /// is one provider. A pool (or `UNPOOLED_COLUMN`) lists each of its
    /// providers' models, under the provider's name when it has more than one:
    /// a pool of Claude, Codex and OpenCode logins showed only Claude's until
    /// 20 Nov, so OpenCode's Gemini models were nowhere. The default and the
    /// tick are only for the thread's own pool (or unpooled login) and
    /// provider. Any other column (the pinned one) is the thread's own login's
    /// list.
    pub fn sections(&self, column: &str, query: &str) -> Vec<PickerSection> {
        if !self.uses_pools() {
            return vec![PickerSection {
                provider: column.to_owned(),
                title: None,
                rows: self.rows(column, query),
            }];
        }
        if column == UNPOOLED_COLUMN {
            let providers =
                crate::new_thread::unpooled_providers(&self.logins.pools, &self.logins.accounts);
            let many = providers.len() > 1;
            return providers
                .into_iter()
                .filter_map(|provider| {
                    let rows = self.unpooled_provider_rows(&provider, query);
                    if rows.is_empty() {
                        return None;
                    }
                    Some(PickerSection {
                        title: many.then(|| self.logins.provider_title(&provider)),
                        provider,
                        rows,
                    })
                })
                .collect();
        }
        let Some(shown) = self.logins.pool(column) else {
            return vec![PickerSection {
                provider: self.provider.clone(),
                title: None,
                rows: self.rows(&self.provider, query),
            }];
        };
        let providers = crate::new_thread::pool_providers(shown, &self.logins.accounts);
        let many = providers.len() > 1;
        providers
            .into_iter()
            .filter_map(|provider| {
                let rows = self.pool_provider_rows(shown, &provider, query);
                // Nothing to list (no match, or none known yet): no section,
                // so no heading with nothing under it.
                if rows.is_empty() {
                    return None;
                }
                Some(PickerSection {
                    title: many.then(|| self.logins.provider_title(&provider)),
                    provider,
                    rows,
                })
            })
            .collect()
    }

    /// The pool column the picker shows when pools are in use: `picked` when
    /// it names an existing pool, `UNPOOLED_COLUMN` when unpooled logins exist,
    /// or `pinned_column` on a thread pinned to a pooled login; otherwise the
    /// thread's own pool, `UNPOOLED_COLUMN` when pinned to an unpooled login,
    /// or `pinned_column` when pinned to a pooled login.
    pub fn resolve_picker_pool(&self, picked: Option<&str>, pinned_column: &str) -> String {
        if let Some(pool) = picked {
            if (pool == UNPOOLED_COLUMN && self.has_unpooled())
                || (pool == pinned_column && self.pool().is_none() && !self.is_pinned_to_unpooled())
                || self.logins.pool(pool).is_some()
            {
                return pool.to_owned();
            }
        }
        if let Some(pool) = self.pool() {
            pool.id.clone()
        } else if self.is_pinned_to_unpooled() {
            UNPOOLED_COLUMN.to_owned()
        } else {
            pinned_column.to_owned()
        }
    }

    /// The providers the left provider rail shows for `column`:
    /// - with pools: the providers of the selected pool, the providers of
    ///   unpooled logins for `UNPOOLED_COLUMN`, or the pinned login's own
    ///   provider when `column` is the pinned column;
    /// - without pools: every provider with a login on this runner, in order.
    pub fn picker_providers(&self, column: &str) -> Vec<String> {
        if !self.uses_pools() {
            let mut seen = Vec::new();
            for account in &self.logins.accounts {
                let provider = account.provider_id().to_owned();
                if !seen.contains(&provider) {
                    seen.push(provider);
                }
            }
            return seen;
        }
        if column == UNPOOLED_COLUMN {
            return crate::new_thread::unpooled_providers(
                &self.logins.pools,
                &self.logins.accounts,
            );
        }
        match self.logins.pool(column) {
            Some(pool) => crate::new_thread::pool_providers(pool, &self.logins.accounts),
            None => vec![self.provider.clone()],
        }
    }

    /// The provider active in the left rail for `column`: `picked` when it's
    /// in the rail, else the thread's own provider when it's in the rail, else
    /// the rail's first provider.
    pub fn resolve_picker_provider(&self, column: &str, picked: Option<&str>) -> Option<String> {
        let providers = self.picker_providers(column);
        if let Some(p) = picked {
            if providers.iter().any(|x| x == p) {
                return Some(p.to_owned());
            }
        }
        if providers.iter().any(|x| x == &self.provider) {
            return Some(self.provider.clone());
        }
        providers.into_iter().next()
    }

    /// The model sections shown in the Pool -> Provider -> Model picker:
    /// - Browsing (`query` empty): only the active `provider`'s models in
    ///   `column`, headed with the provider's title so the icon-only rail is
    ///   labelled.
    /// - Searching (`query` non-empty): searches across every provider in the
    ///   selected pool (or across all unpooled logins on `UNPOOLED_COLUMN`, or
    ///   all providers when pools aren't used), with the active provider's
    ///   matches first and every matching section headed with its provider's
    ///   title.
    pub fn sections_for(
        &self,
        column: &str,
        provider: Option<&str>,
        query: &str,
    ) -> Vec<PickerSection> {
        let searching = !query.trim().is_empty();
        if !self.uses_pools() {
            if searching {
                let mut found: Vec<PickerSection> = self
                    .picker_providers(column)
                    .into_iter()
                    .filter_map(|p| {
                        let rows = self.rows(&p, query);
                        (!rows.is_empty()).then(|| PickerSection {
                            title: Some(self.logins.provider_title(&p)),
                            provider: p,
                            rows,
                        })
                    })
                    .collect();
                if let Some(active) = provider {
                    found.sort_by_key(|s| s.provider != active);
                }
                return found;
            }
            let Some(provider) = provider else {
                return Vec::new();
            };
            let rows = self.rows(provider, "");
            if rows.is_empty() {
                return Vec::new();
            }
            return vec![PickerSection {
                title: Some(self.logins.provider_title(provider)),
                provider: provider.to_owned(),
                rows,
            }];
        }
        let is_unpooled = column == UNPOOLED_COLUMN;
        let shown = (!is_unpooled).then(|| self.logins.pool(column)).flatten();
        if !is_unpooled && shown.is_none() {
            let rows = self.rows(&self.provider, query);
            if rows.is_empty() {
                return Vec::new();
            }
            return vec![PickerSection {
                title: Some(self.logins.provider_title(&self.provider)),
                provider: self.provider.clone(),
                rows,
            }];
        }
        if searching {
            let mut found = self.sections(column, query);
            for section in &mut found {
                section.title = Some(self.logins.provider_title(&section.provider));
            }
            if let Some(active) = provider {
                found.sort_by_key(|s| s.provider != active);
            }
            return found;
        }
        let Some(provider) = provider else {
            return Vec::new();
        };
        let rows = match shown {
            Some(pool) => self.pool_provider_rows(pool, provider, ""),
            None => self.unpooled_provider_rows(provider, ""),
        };
        if rows.is_empty() {
            return Vec::new();
        }
        vec![PickerSection {
            title: Some(self.logins.provider_title(provider)),
            provider: provider.to_owned(),
            rows,
        }]
    }

    pub fn effort_levels(&self) -> Vec<String> {
        self.logins.effort_levels(
            self.effective_model().as_deref(),
            self.choices(),
            &self.provider,
        )
    }
}

/// How a mode reads on the chip (PermissionMode.composerTitle).
pub fn permission_title(mode: &str) -> &'static str {
    match mode {
        "full" => "Full access",
        "ask" => "Ask before edits",
        "auto" => "Auto",
        "plan" => "Plan first",
        "unknown" => "Access unknown",
        _ => "Unknown mode",
    }
}

pub fn permission_help(mode: &str) -> &'static str {
    match mode {
        "full" => "Edits files and runs commands without asking",
        "ask" => "Asks before editing files or running commands",
        "auto" => "A safety check approves or blocks each action, and asks only when unsure",
        "plan" => "Reads and plans, and changes nothing until you approve its plan",
        "unknown" => "Its runner doesn't say what access this thread has. Updating Threadbear there shows it",
        _ => "A mode from a newer runner that this app doesn't know. Update the app to see it. Anything made from this thread here asks before edits",
    }
}

/// What tells a login apart when another of its provider has the same
/// email (two config folders signed in to one account, issue 18): its
/// note, else its id. None when its email is its own.
pub fn twin_label(account: &Account, accounts: &[Account]) -> Option<String> {
    let email = account
        .email
        .as_deref()
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())?;
    let twin = accounts.iter().any(|a| {
        a.id != account.id
            && a.provider_id() == account.provider_id()
            && a.email
                .as_deref()
                .map(|e| e.trim().to_lowercase())
                .as_deref()
                == Some(email.as_str())
    });
    twin.then(|| {
        account
            .note
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map_or_else(|| account.id.clone(), str::to_owned)
    })
}

/// AccountName.short: the part of a Claude email before the @, unless
/// another Claude account shares it; "Codex", or "Codex sam.lee" if there
/// are several. A login whose whole email another shares goes by its note
/// or id (twin_label).
pub fn short_account_name(id: &str, accounts: &[Account]) -> String {
    let Some(account) = accounts.iter().find(|a| a.id == id) else {
        return id.to_owned();
    };
    if let Some(label) = twin_label(account, accounts) {
        return label;
    }
    let full = account.name();
    let local = |s: &str| s.split('@').next().unwrap_or(s).to_owned();
    let siblings: Vec<&Account> = accounts
        .iter()
        .filter(|a| a.id != id && a.provider_id() == account.provider_id())
        .collect();
    if account.provider_id() == "codex" {
        return if siblings.is_empty() {
            "Codex".to_owned()
        } else {
            format!("Codex {}", local(&full))
        };
    }
    if !full.contains('@') {
        return full;
    }
    let mine = local(&full);
    if siblings.iter().any(|a| local(&a.name()) == mine) {
        full
    } else {
        mine
    }
}

/// "claude-1 (mike@example.com)": both, so Mike knows which login and which
/// account to sign in as. Just the id when the name is the id.
pub fn sign_in_label(account: &Account) -> String {
    let name = account.name();
    if name == account.id || name.is_empty() {
        account.id.clone()
    } else {
        format!("{} ({name})", account.id)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_login_signed_back_in_is_one_that_was_signed_out() {
        let list = |logins: &[(&str, bool)]| -> Vec<Account> {
            logins
                .iter()
                .map(|(id, out)| Account {
                    id: (*id).into(),
                    signed_out: *out,
                    ..Default::default()
                })
                .collect()
        };
        let before = list(&[("a", true), ("b", false), ("c", true)]);
        let logins = RunnerLogins {
            accounts: list(&[("a", false), ("b", false), ("c", true), ("d", false)]),
            ..Default::default()
        };
        assert_eq!(logins.signed_back_in(&before), vec!["a".to_string()]);
        assert!(logins.signed_back_in(&logins.accounts.clone()).is_empty());
    }

    #[test]
    fn a_login_given_a_year_long_token_is_new_once() {
        let list = |tokens: &[(&str, Option<&str>)]| -> Vec<Account> {
            tokens
                .iter()
                .map(|(id, made)| Account {
                    id: (*id).into(),
                    year_token: made.map(|m| YearToken {
                        made_at: Some(m.into()),
                    }),
                    ..Default::default()
                })
                .collect()
        };
        let before = list(&[
            ("a", None),
            ("b", Some("2026-01-01")),
            ("c", Some("2026-02-01")),
        ]);
        let mut logins = RunnerLogins {
            accounts: list(&[
                ("a", Some("2026-11-18")),
                ("b", Some("2026-01-01")),
                ("c", Some("2026-11-18")),
                ("d", Some("2026-11-18")),
            ]),
            ..Default::default()
        };
        // a got its first, c a new one; b is as it was and d is new to the list.
        assert_eq!(
            logins.new_year_tokens(&before),
            vec!["a".to_string(), "c".to_string()]
        );
        let now = logins.accounts.clone();
        assert!(logins.new_year_tokens(&now).is_empty());
        logins.accounts = list(&[("a", None)]);
        assert!(logins.new_year_tokens(&now).is_empty());
    }

    use super::*;
    use serde_json::json;

    fn logins() -> RunnerLogins {
        RunnerLogins::from_hello(&json!({
            "accounts": [
                { "id": "claude-main", "provider": "claude", "email": "alex@example.com", "defaultModel": "claude-fable-5-1", "models": [
                    { "id": "opus", "model": "claude-opus-5-5", "title": "Opus 5.5", "description": "For complex work" },
                    { "id": "claude-fable-5-1", "title": "Fable 5.1" },
                    { "id": "claude-sonnet-4-5", "title": "Sonnet 4.5" }
                ]},
                { "id": "codex-main", "provider": "codex", "title": "Codex · sam@example.com", "models": [{ "id": "gpt-6.1-sol" }] }
            ],
            "pools": [{ "id": "claude", "title": "Claude", "accountIds": ["claude-main"] }],
            "defaults": { "cwd": "/x", "accountId": "claude-main", "models": { "codex": "gpt-6-luna" }, "efforts": { "codex": "low" } }
        }))
    }

    fn settings(l: &RunnerLogins) -> ChipSettings<'_> {
        ChipSettings {
            logins: l,
            account: "claude-main".into(),
            provider: "claude".into(),
            pool_id: Some("claude".into()),
            model: None,
            model_in_use: None,
            effort: Some("high".into()),
            effort_in_use: None,
            permission_mode: "full".into(),
            cwd: "/x".into(),
            is_new: false,
        }
    }

    #[test]
    fn the_chip_reads_pool_model_and_effort() {
        let l = logins();
        assert_eq!(settings(&l).model_chip_title(), "Claude · Fable 5.1 · High");
    }

    #[test]
    fn without_pools_the_chip_is_just_the_model() {
        let mut l = logins();
        l.pools.clear();
        assert_eq!(settings(&l).model_chip_title(), "Fable 5.1 · High");
    }

    #[test]
    fn rows_keep_older_ids_under_older() {
        let l = logins();
        let rows = settings(&l).rows("claude", "");
        let titles: Vec<(&str, bool, bool, bool)> = rows
            .iter()
            .map(|r| (r.title.as_str(), r.is_default, r.is_selected, r.is_older))
            .collect();
        assert_eq!(
            titles,
            vec![
                ("Opus 5.5", false, false, false),
                ("Fable 5.1", true, true, false),
                ("Sonnet 4.5", false, false, true)
            ]
        );
    }

    #[test]
    fn the_search_finds_older_models_too() {
        let l = logins();
        let rows = settings(&l).rows("claude", "sonnet");
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].is_older);
    }

    #[test]
    fn another_providers_column_is_a_plain_list() {
        let l = logins();
        let rows = settings(&l).rows("codex", "");
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].is_selected);
    }

    #[test]
    fn a_pool_of_several_providers_lists_each_ones_models() {
        let mut l = logins();
        l.accounts.push(Account {
            id: "opencode-main".into(),
            provider: "opencode".into(),
            models: vec![ModelChoice {
                id: "google/gemini-4-neon".into(),
                model: "google/gemini-4-neon".into(),
                title: "Gemini 4 Neon".into(),
                ..Default::default()
            }],
            ..Default::default()
        });
        l.pools[0].account_ids = vec![
            "claude-main".into(),
            "opencode-main".into(),
            "codex-main".into(),
        ];
        let sections = settings(&l).sections("claude", "");
        let heads: Vec<(&str, Option<&str>)> = sections
            .iter()
            .map(|s| (s.provider.as_str(), s.title.as_deref()))
            .collect();
        assert_eq!(
            heads,
            vec![
                ("claude", Some("Claude")),
                ("opencode", Some("OpenCode")),
                ("codex", Some("Codex"))
            ]
        );
        assert!(
            sections[0].rows.iter().any(|r| r.is_selected),
            "the thread's own provider has its tick"
        );
        assert_eq!(
            sections[1]
                .rows
                .iter()
                .map(|r| r.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Gemini 4 Neon"]
        );
        assert!(
            sections[1..]
                .iter()
                .flat_map(|s| &s.rows)
                .all(|r| !r.is_selected),
            "no tick on another provider"
        );
        l.accounts.push(Account {
            id: "grok-main".into(),
            provider: "grok".into(),
            ..Default::default()
        });
        l.pools[0].account_ids.push("grok-main".into());
        assert!(
            settings(&l)
                .sections("claude", "")
                .iter()
                .all(|s| s.provider != "grok"),
            "a provider with no models known has no heading"
        );
        let found = settings(&l).sections("claude", "gemini");
        assert_eq!(
            found
                .iter()
                .map(|s| s.provider.as_str())
                .collect::<Vec<_>>(),
            vec!["opencode"],
            "a search drops providers with no match"
        );
    }

    #[test]
    fn a_pool_of_one_provider_has_no_heading() {
        let l = logins();
        let sections = settings(&l).sections("claude", "");
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].title, None);
    }

    #[test]
    fn permission_modes_offer_auto_only_where_it_exists() {
        let l = logins();
        assert_eq!(
            settings(&l).permission_modes(),
            vec!["full", "auto", "ask", "plan"]
        );
        let mut s = settings(&l);
        s.provider = "codex".into();
        assert_eq!(s.permission_modes(), vec!["full", "ask", "plan"]);
    }

    #[test]
    fn account_names() {
        let l = logins();
        assert_eq!(short_account_name("claude-main", &l.accounts), "alex");
        assert_eq!(short_account_name("codex-main", &l.accounts), "Codex");
        assert_eq!(l.account("claude-main").unwrap().name(), "alex@example.com");
        assert_eq!(l.account("codex-main").unwrap().name(), "sam@example.com");
    }

    #[test]
    fn two_logins_with_one_email_go_by_note_or_id() {
        let a = |id: &str, email: &str, note: Option<&str>| Account {
            id: id.into(),
            provider: "claude".into(),
            email: Some(email.into()),
            note: note.map(Into::into),
            ..Default::default()
        };
        let accounts = vec![
            a("claude-main", "alex@example.com", None),
            a("claude-2", "Alex@Example.com", Some("Hooks")),
            a("claude-3", "sam@example.com", None),
        ];
        assert_eq!(
            twin_label(&accounts[0], &accounts).as_deref(),
            Some("claude-main")
        );
        assert_eq!(
            twin_label(&accounts[1], &accounts).as_deref(),
            Some("Hooks")
        );
        assert_eq!(twin_label(&accounts[2], &accounts), None);
        assert_eq!(short_account_name("claude-2", &accounts), "Hooks");
        assert_eq!(short_account_name("claude-3", &accounts), "sam");
    }

    #[test]
    fn picker_separates_pool_then_provider_then_models() {
        let mut l = logins();
        l.accounts.push(Account {
            id: "opencode-main".into(),
            provider: "opencode".into(),
            models: vec![ModelChoice {
                id: "google/gemini-4-neon".into(),
                model: "google/gemini-4-neon".into(),
                title: "Gemini 4 Neon".into(),
                ..Default::default()
            }],
            ..Default::default()
        });
        l.pools.push(Pool {
            id: "mixed".into(),
            title: "Mixed".into(),
            account_ids: vec![
                "codex-main".into(),
                "claude-main".into(),
                "opencode-main".into(),
            ],
            ..Default::default()
        });
        let s = settings(&l);

        // Default pool is the thread's own; stale pool id falls back to it.
        assert_eq!(s.resolve_picker_pool(None, "@pinned"), "claude");
        assert_eq!(s.resolve_picker_pool(Some("gone"), "@pinned"), "claude");
        assert_eq!(s.resolve_picker_pool(Some("mixed"), "@pinned"), "mixed");

        // In the mixed pool, providers appear in pool order, and the default
        // active provider prefers the thread's own ("claude") even when listed second.
        assert_eq!(
            s.picker_providers("mixed"),
            vec!["codex", "claude", "opencode"]
        );
        assert_eq!(
            s.resolve_picker_provider("mixed", None).as_deref(),
            Some("claude")
        );
        // Switching to a pool that lacks the previously picked provider falls
        // back to the thread's own provider or the pool's first.
        assert_eq!(
            s.resolve_picker_provider("claude", Some("opencode"))
                .as_deref(),
            Some("claude")
        );

        // Browsing shows only the active provider's models, headed with its title.
        let browsing = s.sections_for("mixed", Some("opencode"), "");
        assert_eq!(browsing.len(), 1);
        assert_eq!(browsing[0].provider, "opencode");
        assert_eq!(browsing[0].title.as_deref(), Some("OpenCode"));
        assert_eq!(browsing[0].rows[0].title, "Gemini 4 Neon");
        assert!(!browsing[0].rows[0].is_selected);

        // Searching searches across all providers in the selected pool, with
        // the active provider's matches first.
        let cross = s.sections_for("mixed", Some("claude"), "gemini");
        assert_eq!(cross.len(), 1);
        assert_eq!(cross[0].provider, "opencode");
        assert_eq!(cross[0].title.as_deref(), Some("OpenCode"));

        let active_first = s.sections_for("mixed", Some("claude"), "5");
        assert_eq!(active_first[0].provider, "claude");
    }

    #[test]
    fn picker_handles_pinned_threads_empty_pools_and_non_pool_fallback() {
        let mut l = logins();
        l.pools.push(Pool {
            id: "empty".into(),
            title: "Empty".into(),
            account_ids: vec![],
            ..Default::default()
        });

        // Pinned thread: defaults to @pinned, shows only its own login's provider.
        let mut pinned = settings(&l);
        pinned.pool_id = None;
        assert_eq!(pinned.resolve_picker_pool(None, "@pinned"), "@pinned");
        assert_eq!(pinned.picker_providers("@pinned"), vec!["claude"]);
        assert_eq!(
            pinned.resolve_picker_provider("@pinned", None).as_deref(),
            Some("claude")
        );
        let pinned_sections = pinned.sections_for("@pinned", Some("claude"), "");
        assert_eq!(pinned_sections.len(), 1);
        assert_eq!(pinned_sections[0].title.as_deref(), Some("Claude"));
        assert!(pinned_sections[0].rows.iter().any(|r| r.is_selected));

        // Once unpinned (thread has a pool again), a stale @pinned falls back.
        let unpinned = settings(&l);
        assert_eq!(
            unpinned.resolve_picker_pool(Some("@pinned"), "@pinned"),
            "claude"
        );

        // Empty pool has no providers and returns no sections.
        assert!(unpinned.picker_providers("empty").is_empty());
        assert_eq!(unpinned.resolve_picker_provider("empty", None), None);
        assert!(unpinned.sections_for("empty", None, "").is_empty());

        // Non-pool fallback: provider rail lists all accounts' providers;
        // browsing shows one provider, searching finds matches across providers.
        l.pools.clear();
        let no_pools = settings(&l);
        assert_eq!(no_pools.picker_providers(""), vec!["claude", "codex"]);
        let browse = no_pools.sections_for("", Some("claude"), "");
        assert_eq!(browse.len(), 1);
        assert_eq!(browse[0].provider, "claude");
        let search = no_pools.sections_for("", Some("claude"), "sol");
        assert_eq!(search.len(), 1);
        assert_eq!(search[0].provider, "codex");
        assert_eq!(search[0].title.as_deref(), Some("Codex"));
    }

    #[test]
    fn picker_no_pool_tab_lists_and_searches_unpooled_logins() {
        let mut l = logins();
        // In `logins()`, `codex-main` is not in any pool; add an unpooled Claude
        // and an unpooled Cursor login too.
        l.accounts.push(Account {
            id: "claude-solo".into(),
            provider: "claude".into(),
            email: Some("mike@cannstudios.co".into()),
            default_model: Some("opus".into()),
            models: vec![
                ModelChoice {
                    id: "opus".into(),
                    model: "claude-opus-5-5".into(),
                    title: "Opus 5.5".into(),
                    ..Default::default()
                },
                ModelChoice {
                    id: "sonnet".into(),
                    model: "claude-sonnet-5".into(),
                    title: "Sonnet 5".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        l.accounts.push(Account {
            id: "cursor-solo".into(),
            provider: "cursor".into(),
            models: vec![ModelChoice {
                id: "composer-2".into(),
                model: "composer-2".into(),
                title: "Composer 2".into(),
                ..Default::default()
            }],
            ..Default::default()
        });

        // A pooled thread can select UNPOOLED_COLUMN, sees unpooled providers
        // (Claude, Codex, Cursor), and no row is ticked on it.
        let pooled = settings(&l);
        assert!(pooled.has_unpooled());
        assert!(!pooled.is_pinned_to_unpooled());
        assert_eq!(
            pooled.resolve_picker_pool(Some(UNPOOLED_COLUMN), "@pinned"),
            UNPOOLED_COLUMN
        );
        assert_eq!(
            pooled.picker_providers(UNPOOLED_COLUMN),
            vec!["claude", "codex", "cursor"]
        );
        let browse = pooled.sections_for(UNPOOLED_COLUMN, Some("claude"), "");
        assert_eq!(browse.len(), 1);
        assert_eq!(browse[0].title.as_deref(), Some("Claude"));
        assert!(browse[0].rows.iter().all(|r| !r.is_selected));

        // Searching in UNPOOLED_COLUMN looks across all unpooled providers.
        let search = pooled.sections_for(UNPOOLED_COLUMN, Some("claude"), "composer");
        assert_eq!(search.len(), 1);
        assert_eq!(search[0].provider, "cursor");
        assert_eq!(search[0].rows[0].title, "Composer 2");

        // A thread pinned to an unpooled login defaults to UNPOOLED_COLUMN and
        // ticks its active model.
        let mut on_solo = settings(&l);
        on_solo.pool_id = None;
        on_solo.account = "claude-solo".into();
        on_solo.provider = "claude".into();
        on_solo.model = Some("sonnet".into());
        assert!(on_solo.is_pinned_to_unpooled());
        assert_eq!(
            on_solo.resolve_picker_pool(None, "@pinned"),
            UNPOOLED_COLUMN
        );
        let own_sections = on_solo.sections_for(UNPOOLED_COLUMN, Some("claude"), "");
        assert!(own_sections[0]
            .rows
            .iter()
            .any(|r| r.id == "sonnet" && r.is_selected));

        // Once every account is in a pool, a stale UNPOOLED_COLUMN falls back.
        l.pools[0].account_ids.extend([
            "codex-main".into(),
            "claude-solo".into(),
            "cursor-solo".into(),
        ]);
        let all_pooled = settings(&l);
        assert!(!all_pooled.has_unpooled());
        assert_eq!(
            all_pooled.resolve_picker_pool(Some(UNPOOLED_COLUMN), "@pinned"),
            "claude"
        );
    }

    #[test]
    fn effort_levels_follow_model_and_hide_for_models_without_any() {
        let l = RunnerLogins::from_hello(&json!({
            "providers": [
                { "id": "antigravity", "name": "Gemini", "effort": "claude" },
                { "id": "opencode", "name": "OpenCode", "effort": "claude" },
                { "id": "claude", "name": "Claude", "effort": "claude" }
            ],
            "accounts": [
                {
                    "id": "antigravity-main",
                    "provider": "antigravity",
                    "title": "Gemini",
                    "defaultModel": "gemini-3.8-flash",
                    "models": [
                        { "id": "gemini-4-neon", "title": "Gemini 4 Neon", "effortLevels": ["low", "medium", "high", "xhigh"], "defaultEffort": "high" },
                        { "id": "gemini-3.8-flash", "title": "Gemini 3.8 Flash", "effortLevels": ["low", "medium", "high"], "defaultEffort": "high" }
                    ]
                },
                {
                    "id": "opencode-main",
                    "provider": "opencode",
                    "title": "OpenCode",
                    "models": [
                        { "id": "opencode/gpt-6-astra", "title": "GPT-6 Astra", "effortLevels": ["low", "medium", "high", "xhigh", "max"] },
                        { "id": "opencode/big-pickle", "title": "Big Pickle" }
                    ]
                },
                {
                    "id": "claude-main",
                    "provider": "claude",
                    "title": "Claude",
                    "models": [
                        { "id": "opus", "title": "Opus 5.5", "effortLevels": ["low", "medium", "high", "xhigh", "max"] },
                        { "id": "claude-haiku-4-5-20251001", "title": "Haiku 4.5" }
                    ]
                }
            ]
        }));
        let agy = &l.account("antigravity-main").unwrap().models;
        assert_eq!(
            l.effort_levels(Some("gemini-4-neon"), agy, "antigravity"),
            vec!["low", "medium", "high", "xhigh"]
        );
        assert_eq!(
            l.effort_levels(Some("gemini-3.8-flash"), agy, "antigravity"),
            vec!["low", "medium", "high"]
        );

        let oc = &l.account("opencode-main").unwrap().models;
        assert_eq!(
            l.effort_levels(Some("opencode/gpt-6-astra"), oc, "opencode"),
            vec!["low", "medium", "high", "xhigh", "max"]
        );
        assert!(
            l.effort_levels(Some("opencode/big-pickle"), oc, "opencode")
                .is_empty(),
            "a model omitting effortLevels when sibling models list them offers none"
        );

        let claude = &l.account("claude-main").unwrap().models;
        assert!(l
            .effort_levels(Some("claude-haiku-4-5-20251001"), claude, "claude")
            .is_empty());

        // When no model on the login reports effortLevels (older CLI), fall back to the provider's levels.
        let legacy = vec![ModelChoice {
            id: "opus".into(),
            ..Default::default()
        }];
        assert_eq!(
            l.effort_levels(Some("opus"), &legacy, "claude"),
            vec!["low", "medium", "high", "xhigh", "max"]
        );
    }
    #[test]
    fn gemini_has_its_service_name_without_provider_metadata() {
        assert_eq!(provider_title("antigravity"), "Gemini");
        assert_eq!(
            RunnerLogins::default().provider_title("antigravity"),
            "Gemini"
        );
    }
}
