// A GitHub pull request opened as a tab in the side pane
// (docs/protocol/panels.md, "Pull requests"). Mike picked this, option A
// of three mockups (18 Nov 2026), after Capy opened PRs beside the chat:
// "rather than having to farm out to a browser, it's all in line, with
// everything you need and buttons."
//
// This is the part with no drawing in it: which links are PRs, what the
// runner's `github.pr` answer holds, and the words the tab shows.

use crate::reducer::event::{DiffHunk, EditDiff};
use serde::{Deserialize, Serialize};

/// A PR panel's id starts with this, followed by the PR's canonical GitHub URL
/// (e.g. `threadbear.pr:https://github.com/owner/repo/pull/72`).
pub const PANEL_PREFIX: &str = "threadbear.pr:";

/// A PR's dock panel id for any GitHub pull request URL, normalized to its
/// canonical URL so `/files` and `#discussion` links share one panel.
pub fn panel(url: &str) -> Option<String> {
    PrRef::parse(url).map(|r| r.panel_id())
}

/// The canonical PR URL a panel id names, or `None` for any other panel.
pub fn panel_url(panel: &str) -> Option<&str> {
    let url = panel.strip_prefix(PANEL_PREFIX)?;
    PrRef::parse(url)?;
    Some(url)
}

/// The parsed repo and number a PR panel id names, or `None` for any other panel.
pub fn panel_ref(panel: &str) -> Option<PrRef> {
    PrRef::parse(panel.strip_prefix(PANEL_PREFIX)?)
}

/// A PR link's repo and number: `https://github.com/<owner>/<repo>/pull/<n>`,
/// with anything after the number (`/files`, `#discussion`) left off, as the
/// runner's `parsePrUrl` reads it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PrRef {
    pub owner: String,
    pub repo: String,
    pub number: u64,
}

impl PrRef {
    pub fn parse(url: &str) -> Option<PrRef> {
        let url = url.trim();
        let lower = url.to_ascii_lowercase();
        let rest = ["https://github.com/", "https://www.github.com/"]
            .iter()
            .find(|p| lower.starts_with(*p))
            .map(|p| &url[p.len()..])?;
        let mut parts = rest.splitn(4, '/');
        let (owner, repo, pull, tail) = (
            parts.next()?,
            parts.next()?,
            parts.next()?,
            parts.next().unwrap_or(""),
        );
        let name_ok = |s: &str| {
            !s.is_empty()
                && !s.starts_with('-')
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        };
        if !pull.eq_ignore_ascii_case("pull") || !name_ok(owner) || !name_ok(repo) {
            return None;
        }
        let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
        let after = &tail[digits.len()..];
        if !(after.is_empty() || after.starts_with(['/', '?', '#'])) {
            return None;
        }
        let number = digits.parse::<u64>().ok().filter(|n| *n > 0)?;
        Some(PrRef {
            owner: owner.to_owned(),
            repo: repo.to_owned(),
            number,
        })
    }

    /// The PR's own page, with nothing after the number: the one URL each
    /// tab and state is kept under, however the link was written.
    pub fn url(&self) -> String {
        format!(
            "https://github.com/{}/{}/pull/{}",
            self.owner, self.repo, self.number
        )
    }

    /// "#72", the tab's name.
    pub fn tab_title(&self) -> String {
        format!("#{}", self.number)
    }

    /// Its dock panel id (`threadbear.pr:<canonical url>`).
    pub fn panel_id(&self) -> String {
        format!("{PANEL_PREFIX}{}", self.url())
    }

    /// Its file's name in the app's cache of PRs read before
    /// (`CachedPr`). Owners and repos have no `~`, so no two PRs share one.
    pub fn cache_name(&self) -> String {
        format!("{}~{}~{}.json", self.owner, self.repo, self.number)
    }
}

/// A PR as the app keeps it between runs, to show at once the next time
/// while it reads it again (Mike asked for stale-while-revalidate, 19 Nov).
/// Only a whole read is kept, its files included.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPr {
    pub read_at: i64,
    pub pr: PrView,
}

/// How long a read counts as new: opening its tab again inside this shows
/// it as it is; after, it's shown and read again behind it.
pub const PR_FRESH_MS: i64 = 60_000;

/// How many of a thread's latest messages are looked at for PR links to read
/// ahead, and how many PRs at most: each read is three gh calls.
pub const RECENT_MESSAGES: usize = 4;
pub const RECENT_PRS: usize = 4;

/// The PR links in `texts` (the newest message first), newest first, once
/// each and at most `max`: the ones read as a thread shows, as the PRs a
/// thread's last replies name are the ones likely to be clicked.
pub fn recent_pr_links<'a>(texts: impl IntoIterator<Item = &'a str>, max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for text in texts {
        for url in pr_links(text) {
            if out.len() == max {
                return out;
            }
            if !out.contains(&url) {
                out.push(url);
            }
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PrState {
    #[default]
    Open,
    Draft,
    Merged,
    Closed,
}

impl PrState {
    pub fn parse(s: &str) -> Option<PrState> {
        match s {
            "open" => Some(PrState::Open),
            "draft" => Some(PrState::Draft),
            "merged" => Some(PrState::Merged),
            "closed" => Some(PrState::Closed),
            _ => None,
        }
    }

    pub fn words(self) -> &'static str {
        match self {
            PrState::Open => "Open",
            PrState::Draft => "Draft",
            PrState::Merged => "Merged",
            PrState::Closed => "Closed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckState {
    Passed,
    Failed,
    Running,
    Pending,
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct PrCheck {
    pub name: String,
    pub state: CheckState,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub seconds: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct PrActivity {
    pub kind: String,
    pub author: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub review: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrHunk {
    pub old_start: i64,
    pub old_lines: i64,
    pub new_start: i64,
    pub new_lines: i64,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct PrFile {
    pub path: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub additions: u64,
    #[serde(default)]
    pub deletions: u64,
    #[serde(default)]
    pub hunks: Vec<PrHunk>,
    #[serde(default)]
    pub binary: bool,
}

impl PrFile {
    /// The file as the transcript's edit cards take it, for the same diff view.
    pub fn edit_diff(&self, key: &str) -> EditDiff {
        EditDiff {
            item_id: key.to_owned(),
            path: self.path.clone(),
            hunks: self
                .hunks
                .iter()
                .map(|h| DiffHunk {
                    old_start: h.old_start,
                    old_lines: h.old_lines,
                    new_start: h.new_start,
                    new_lines: h.new_lines,
                    lines: h.lines.clone(),
                })
                .collect(),
        }
    }
}

/// The runner's `github.pr` answer. Fields it adds later are ignored.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrView {
    pub url: String,
    pub number: u64,
    pub title: String,
    pub author: String,
    #[serde(default)]
    pub state: PrState,
    #[serde(default)]
    pub head: String,
    #[serde(default)]
    pub base: String,
    #[serde(default)]
    pub additions: u64,
    #[serde(default)]
    pub deletions: u64,
    #[serde(default)]
    pub changed_files: u64,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub merged_at: Option<String>,
    #[serde(default)]
    pub closed_at: Option<String>,
    #[serde(default)]
    pub merged_by: Option<String>,
    #[serde(default)]
    pub review: String,
    #[serde(default)]
    pub mergeable: String,
    #[serde(default)]
    pub can_merge: bool,
    #[serde(default)]
    pub merge_methods: Vec<MergeMethod>,
    #[serde(default)]
    pub checks: Vec<PrCheck>,
    #[serde(default)]
    pub activity: Vec<PrActivity>,
    #[serde(default)]
    pub files: Vec<PrFile>,
    #[serde(default)]
    pub files_error: Option<String>,
    #[serde(default)]
    pub files_cut: Option<u64>,
    /// Read without its files (`github.pr` with `files: false`): they come
    /// from `github.prFiles`.
    #[serde(default)]
    pub files_later: bool,
}

/// A PR's files alone (`github.prFiles`), read apart from the rest as a big
/// PR's diff is the slowest read.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFiles {
    #[serde(default)]
    pub files: Vec<PrFile>,
    #[serde(default)]
    pub files_error: Option<String>,
    #[serde(default)]
    pub files_cut: Option<u64>,
}

impl PrView {
    /// Its files, as `github.prFiles` read them.
    pub fn with_files(mut self, files: PrFiles) -> Self {
        self.files = files.files;
        self.files_error = files.files_error;
        self.files_cut = files.files_cut;
        self.files_later = false;
        self
    }

    /// Read without its files, it keeps those an earlier read had until
    /// its own come: a refresh shouldn't empty the Diff tab meanwhile.
    pub fn keeping_files_of(mut self, before: &PrView) -> Self {
        if self.files_later && !before.files_later {
            self.files = before.files.clone();
            self.files_error = before.files_error.clone();
            self.files_cut = before.files_cut;
        }
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Rebase,
    Squash,
    Merge,
}

impl MergeMethod {
    pub const ALL: [MergeMethod; 3] =
        [MergeMethod::Rebase, MergeMethod::Squash, MergeMethod::Merge];

    pub fn id(self) -> &'static str {
        match self {
            MergeMethod::Rebase => "rebase",
            MergeMethod::Squash => "squash",
            MergeMethod::Merge => "merge",
        }
    }

    pub fn parse(s: &str) -> Option<MergeMethod> {
        MergeMethod::ALL.into_iter().find(|m| m.id() == s)
    }

    /// Its menu item, as GitHub names them.
    pub fn title(self) -> &'static str {
        match self {
            MergeMethod::Rebase => "Rebase and merge",
            MergeMethod::Squash => "Squash and merge",
            MergeMethod::Merge => "Create a merge commit",
        }
    }
}

/// The Merge button's method: the one Mike starred in its menu if this repo
/// allows it, else the first the repo allows.
pub fn merge_method(allowed: &[MergeMethod], starred: Option<MergeMethod>) -> Option<MergeMethod> {
    starred
        .filter(|m| allowed.contains(m))
        .or_else(|| allowed.first().copied())
}

/// The tab's three views.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum PrTab {
    #[default]
    Overview,
    Diff,
    Checks,
}

impl PrTab {
    pub const ALL: [PrTab; 3] = [PrTab::Overview, PrTab::Diff, PrTab::Checks];

    pub fn title(self) -> &'static str {
        match self {
            PrTab::Overview => "Overview",
            PrTab::Diff => "Diff",
            PrTab::Checks => "Checks",
        }
    }
}

/// The Checks row: "3 of 4 passed", "2 running", "No checks", with what
/// failed named, as few words as say it.
pub fn checks_summary(checks: &[PrCheck]) -> (String, Option<String>) {
    if checks.is_empty() {
        return ("No checks".into(), None);
    }
    let count = |s: CheckState| checks.iter().filter(|c| c.state == s).count();
    let (passed, running) = (
        count(CheckState::Passed),
        count(CheckState::Running) + count(CheckState::Pending),
    );
    let counted = checks
        .iter()
        .filter(|c| c.state != CheckState::Skipped)
        .count();
    let failed: Vec<&str> = checks
        .iter()
        .filter(|c| c.state == CheckState::Failed)
        .map(|c| c.name.as_str())
        .collect();
    let mut words = if passed == counted {
        format!("All {counted} passed")
    } else {
        format!("{passed} of {counted} passed")
    };
    if running > 0 {
        words.push_str(&format!(", {running} running"));
    }
    let bad = match failed.as_slice() {
        [] => None,
        [one] => Some(format!("{one} failed")),
        [one, rest @ ..] => Some(format!("{one} and {} more failed", rest.len())),
    };
    (words, bad)
}

/// The Status row: what decides whether it can go in.
pub fn status_words(pr: &PrView) -> String {
    match pr.state {
        PrState::Merged => match &pr.merged_by {
            Some(by) => format!("Merged by {by}"),
            None => "Merged".into(),
        },
        PrState::Closed => "Closed".into(),
        PrState::Draft => "Draft".into(),
        PrState::Open => {
            let mut words = match pr.review.as_str() {
                "approved" => "Approved".to_owned(),
                "changes" => "Changes requested".to_owned(),
                "required" => "Review required".to_owned(),
                _ => "Open".to_owned(),
            };
            if pr.mergeable == "conflicts" {
                words.push_str(" · has conflicts");
            }
            words
        }
    }
}

/// A check's time: "1m 04s", "45s".
pub fn duration(seconds: u64) -> String {
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    } else {
        format!("{}h {:02}m", seconds / 3600, (seconds % 3600) / 60)
    }
}

/// What "Ask Claude to review" sends as a new thread's first message.
pub fn review_prompt(pr: &PrView) -> String {
    format!(
        "Review this pull request: {}\n\nRead it with `gh pr view {} -R {}` and `gh pr diff`, check it out in a worktree if you need to run it, and tell me whether to merge it, with anything to ask the author. Don't merge, close or comment on it yourself.",
        pr.url,
        pr.number,
        repo_of(&pr.url).unwrap_or_default()
    )
}

/// What "Start a thread on it" sends: work on the PR, not a verdict on it.
pub fn work_prompt(pr: &PrView) -> String {
    format!(
        "Pull request {} (\"{}\" by {}). ",
        pr.url, pr.title, pr.author
    )
}

/// The link a PR's state mark is drawn for in a reply:
/// `[\u{2060}](tbpr:<url>)` just before the PR's own link, as thread links
/// get theirs (link_marks.rs). Mike expected PR links in replies to show
/// whether they're open, merged or closed (19 Nov 2026).
pub const MARK_SCHEME: &str = "tbpr:";

/// Each PR a reply links to, its tidy url, once each in order.
pub fn pr_links(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, url) in pr_link_starts(text) {
        if !out.contains(&url) {
            out.push(url);
        }
    }
    out
}

/// `text` with a state mark's link before each link to a PR, or `text` as
/// it was when there's none. Links in code are text, so they're left alone.
pub fn with_pr_marks(text: &str) -> std::borrow::Cow<'_, str> {
    let at = pr_link_starts(text);
    if at.is_empty() {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len() + at.len() * 60);
    let mut from = 0;
    for (start, url) in at {
        out.push_str(&text[from..start]);
        out.push_str(&format!("[\u{2060}]({MARK_SCHEME}{url})"));
        from = start;
    }
    out.push_str(&text[from..]);
    std::borrow::Cow::Owned(out)
}

fn pr_link_starts(text: &str) -> Vec<(usize, String)> {
    if !text.contains("github.com/") {
        return Vec::new();
    }
    let Ok(tree) = markdown::to_mdast(text, &markdown::ParseOptions::gfm()) else {
        return Vec::new();
    };
    let mut at = Vec::new();
    crate::link_marks::collect(&tree, &mut |link| {
        let Some(start) = link.position.as_ref().map(|p| p.start.offset) else {
            return;
        };
        if let Some(r) = PrRef::parse(&link.url).filter(|_| text.is_char_boundary(start)) {
            at.push((start, r.url()));
        }
    });
    at.sort_by_key(|(start, _)| *start);
    at
}

fn repo_of(url: &str) -> Option<String> {
    PrRef::parse(url).map(|r| format!("{}/{}", r.owner, r.repo))
}

// ---------------------------------------------------------------- status in Highlights

/// What decides whether a thread's PR can merge, for Highlights' Pull
/// requests (the runner's `github.prStatus`).
#[derive(Clone, Debug, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrStatus {
    pub title: String,
    pub state: PrState,
    /// passed, failed, pending, or "" with no checks.
    pub ci: String,
    /// approved, changes, required, or "".
    pub review: String,
    /// yes, conflicts or unknown.
    pub mergeable: String,
    pub unresolved: u64,
    pub updated_at: String,
}

/// A PR row's colour: red, yellow, green, or the plain icon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrTone {
    Failed,
    Blocked,
    Ready,
    Plain,
}

/// How long a PR's status counts as new: Highlights asks again after this
/// as it redraws (the runner keeps its own answer 30 seconds).
pub const PR_STATUS_FRESH_MS: i64 = 30_000;

impl PrStatus {
    pub fn decode(value: &serde_json::Value) -> Option<PrStatus> {
        serde_json::from_value(value.clone()).ok()
    }

    /// Merged or closed: hidden under Show merged.
    pub fn landed(&self) -> bool {
        matches!(self.state, PrState::Merged | PrState::Closed)
    }

    /// Red when CI failed or changes were asked for; green when it's approved
    /// (or needs no review) with nothing in the way; yellow while it waits on
    /// something; plain as a draft, merged or closed (the icon's own colour
    /// says those).
    pub fn tone(&self) -> PrTone {
        if self.landed() || self.state == PrState::Draft {
            return PrTone::Plain;
        }
        if self.ci == "failed" || self.review == "changes" {
            return PrTone::Failed;
        }
        let waiting = self.ci == "pending"
            || self.review == "required"
            || self.mergeable == "conflicts"
            || self.unresolved > 0;
        if waiting {
            PrTone::Blocked
        } else {
            PrTone::Ready
        }
    }

    /// The status line: "CI failed · Changes requested · Conflict · 2 open
    /// threads". Merged and closed say only that.
    pub fn line(&self) -> String {
        if self.landed() {
            return self.state.words().to_owned();
        }
        let mut bits: Vec<String> = vec![];
        if self.state == PrState::Draft {
            bits.push("Draft".into());
        }
        match self.ci.as_str() {
            "passed" => bits.push("CI passed".into()),
            "failed" => bits.push("CI failed".into()),
            "pending" => bits.push("CI running".into()),
            _ => {}
        }
        match self.review.as_str() {
            "approved" => bits.push("Approved".into()),
            "changes" => bits.push("Changes requested".into()),
            "required" => bits.push("Waiting for review".into()),
            _ => {}
        }
        if self.mergeable == "conflicts" {
            bits.push("Conflict".into());
        }
        match self.unresolved {
            0 => {}
            1 => bits.push("1 open thread".into()),
            n => bits.push(format!("{n} open threads")),
        }
        if bits.is_empty() {
            "Open".into()
        } else {
            bits.join(" · ")
        }
    }

    /// "2h ago": since GitHub last saw a change.
    pub fn ago(&self, now_ms: i64) -> Option<String> {
        crate::inbox::parse_ms(&self.updated_at).map(|at| crate::highlights::run_ago(at, now_ms))
    }
}

/// "api#4940": a PR's short name, the repo without its owner.
pub fn short_ref(url: &str) -> Option<String> {
    PrRef::parse(url).map(|r| format!("{}#{}", r.repo, r.number))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_mark_before_each_pr_link_in_a_reply() {
        let text = "Try [#72](https://github.com/acme/app/pull/72/files) or https://github.com/acme/app/pull/77, not `https://github.com/acme/app/pull/9` or [docs](https://github.com/acme/app).";
        assert_eq!(
            with_pr_marks(text),
            "Try [\u{2060}](tbpr:https://github.com/acme/app/pull/72)[#72](https://github.com/acme/app/pull/72/files) or [\u{2060}](tbpr:https://github.com/acme/app/pull/77)https://github.com/acme/app/pull/77, not `https://github.com/acme/app/pull/9` or [docs](https://github.com/acme/app)."
        );
        assert_eq!(
            pr_links(text),
            [
                "https://github.com/acme/app/pull/72",
                "https://github.com/acme/app/pull/77"
            ]
        );
        assert!(matches!(
            with_pr_marks("No links here"),
            std::borrow::Cow::Borrowed(_)
        ));
    }

    #[test]
    fn pr_links_and_only_pr_links() {
        let r = PrRef::parse("https://github.com/acme/app/pull/72").unwrap();
        assert_eq!(
            (r.owner.as_str(), r.repo.as_str(), r.number),
            ("acme", "app", 72)
        );
        assert_eq!(
            PrRef::parse("https://github.com/acme/app/pull/72/files#diff-1")
                .unwrap()
                .url(),
            "https://github.com/acme/app/pull/72"
        );
        assert_eq!(
            PrRef::parse("https://www.github.com/a.b/c-d/pull/3?x=1")
                .unwrap()
                .tab_title(),
            "#3"
        );
        for no in [
            "https://github.com/acme/app/issues/72",
            "https://evil.com/acme/app/pull/72",
            "http://github.com/acme/app/pull/7",
            "https://github.com/-x/app/pull/1",
            "https://github.com/acme/app/pull/0",
            "https://github.com/acme/app/pull/7x",
            "https://github.com/acme/app/pull/",
        ] {
            assert_eq!(PrRef::parse(no), None, "{no}");
        }
    }

    fn view(over: serde_json::Value) -> PrView {
        let mut v = json!({ "url": "https://github.com/acme/app/pull/72", "number": 72, "title": "Fewer approvals", "author": "ian", "state": "open", "unknownField": 1 });
        v.as_object_mut()
            .unwrap()
            .extend(over.as_object().unwrap().clone());
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn the_runners_answer_reads_with_fields_left_out() {
        let pr = view(
            json!({ "mergeMethods": ["rebase", "squash"], "files": [{ "path": "a.ts", "additions": 1, "hunks": [{ "oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1, "lines": ["-a", "+b"] }] }] }),
        );
        assert_eq!(
            pr.merge_methods,
            vec![MergeMethod::Rebase, MergeMethod::Squash]
        );
        let diff = pr.files[0].edit_diff("k");
        assert_eq!((diff.path.as_str(), diff.hunks[0].lines.len()), ("a.ts", 2));
    }

    #[test]
    fn a_pr_read_without_its_files_takes_them_when_they_come() {
        let files = |path: &str| {
            serde_json::from_value::<PrFiles>(json!({ "files": [{ "path": path }] })).unwrap()
        };
        let later = view(json!({ "files": [], "filesLater": true }));
        assert!(later.files_later && later.files.is_empty());
        let full = later.clone().with_files(files("a.ts"));
        assert!(!full.files_later);
        assert_eq!(full.files[0].path, "a.ts");
        // A refresh read without its files keeps the last ones meanwhile,
        // still waiting for its own.
        let refreshed = later.clone().keeping_files_of(&full);
        assert_eq!(
            (refreshed.files[0].path.as_str(), refreshed.files_later),
            ("a.ts", true)
        );
        assert_eq!(refreshed.with_files(files("b.ts")).files[0].path, "b.ts");
        // An older runner's answer has its files and no filesLater.
        assert!(!view(json!({ "files": [{ "path": "c.ts" }] })).files_later);
        let failed =
            serde_json::from_value::<PrFiles>(json!({ "files": [], "filesError": "HTTP 502" }))
                .unwrap();
        assert_eq!(
            later.with_files(failed).files_error.as_deref(),
            Some("HTTP 502")
        );
    }

    #[test]
    fn a_kept_pr_reads_back_as_it_was() {
        let pr = view(
            json!({ "state": "merged", "mergeMethods": ["squash"], "checks": [{ "name": "Linux", "state": "failed" }], "files": [{ "path": "a.rs", "additions": 2, "hunks": [{ "oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 2, "lines": ["-a", "+b", "+c"] }] }], "filesCut": 3 }),
        );
        let kept = serde_json::to_string(&CachedPr {
            read_at: 5,
            pr: pr.clone(),
        })
        .unwrap();
        let back: CachedPr = serde_json::from_str(&kept).unwrap();
        assert_eq!((back.read_at, back.pr), (5, pr));
        assert_eq!(
            PrRef::parse("https://github.com/acme/app.js/pull/72/files")
                .unwrap()
                .cache_name(),
            "acme~app.js~72.json"
        );
    }

    #[test]
    fn the_prs_read_ahead_are_the_latest_messages_ones() {
        let (a, b, c) = (
            "https://github.com/o/r/pull/1",
            "https://github.com/o/r/pull/2",
            "https://github.com/o/r/pull/3",
        );
        let newest = format!("see {b} and {a}/files");
        let older = format!("{a} {c}");
        assert_eq!(
            recent_pr_links([newest.as_str(), older.as_str()], 4),
            vec![b, a, c]
        );
        assert_eq!(
            recent_pr_links([newest.as_str(), older.as_str()], 2),
            vec![b, a]
        );
        assert!(recent_pr_links(["no links here"], 4).is_empty());
    }

    #[test]
    fn checks_say_what_failed() {
        let c = |name: &str, state| PrCheck {
            name: name.into(),
            state,
            url: None,
            seconds: None,
        };
        assert_eq!(checks_summary(&[]), ("No checks".into(), None));
        assert_eq!(
            checks_summary(&[c("a", CheckState::Passed), c("b", CheckState::Skipped)]),
            ("All 1 passed".into(), None)
        );
        assert_eq!(
            checks_summary(&[
                c("Windows", CheckState::Failed),
                c("b", CheckState::Passed),
                c("c", CheckState::Running)
            ]),
            (
                "1 of 3 passed, 1 running".into(),
                Some("Windows failed".into())
            )
        );
        assert_eq!(
            checks_summary(&[c("W", CheckState::Failed), c("L", CheckState::Failed)]).1,
            Some("W and 1 more failed".into())
        );
    }

    #[test]
    fn status_says_what_decides_a_merge() {
        assert_eq!(status_words(&view(json!({}))), "Open");
        assert_eq!(
            status_words(&view(
                json!({ "review": "approved", "mergeable": "conflicts" })
            )),
            "Approved · has conflicts"
        );
        assert_eq!(
            status_words(&view(json!({ "state": "merged", "mergedBy": "mike" }))),
            "Merged by mike"
        );
        assert_eq!(status_words(&view(json!({ "state": "draft" }))), "Draft");
    }

    #[test]
    fn merge_uses_the_starred_method_where_the_repo_allows_it() {
        use MergeMethod::*;
        assert_eq!(merge_method(&[Rebase, Squash], Some(Squash)), Some(Squash));
        assert_eq!(merge_method(&[Rebase, Squash], Some(Merge)), Some(Rebase));
        assert_eq!(merge_method(&[], Some(Merge)), None);
    }

    #[test]
    fn durations() {
        assert_eq!(duration(45), "45s");
        assert_eq!(duration(64), "1m 04s");
        assert_eq!(duration(3720), "1h 02m");
    }

    #[test]
    fn panel_ids_round_trip_and_normalize() {
        let id = panel("https://github.com/acme/app/pull/72/files#diff-1").unwrap();
        assert_eq!(id, "threadbear.pr:https://github.com/acme/app/pull/72");
        assert_eq!(panel_url(&id), Some("https://github.com/acme/app/pull/72"));
        let r = panel_ref(&id).unwrap();
        assert_eq!(r.tab_title(), "#72");
        assert_eq!(r.panel_id(), id);
        assert_eq!(panel_url("threadbear.pr:"), None);
        assert_eq!(panel_url("threadbear.pr:https://example.com/nope"), None);
        assert_eq!(panel_url("threadbear.highlights"), None);
    }

    fn status(v: serde_json::Value) -> PrStatus {
        PrStatus::decode(&v).expect("decodes")
    }

    #[test]
    fn a_pr_status_says_what_holds_it_up() {
        let s = status(
            json!({ "title": "Fix totals", "state": "open", "ci": "failed", "review": "changes", "mergeable": "conflicts", "unresolved": 2, "updatedAt": "2026-11-20T08:00:00Z", "later": 1 }),
        );
        assert_eq!(
            s.line(),
            "CI failed · Changes requested · Conflict · 2 open threads"
        );
        assert_eq!(s.tone(), PrTone::Failed);
        assert_eq!(
            s.ago(crate::inbox::parse_ms("2026-11-20T10:00:00Z").unwrap())
                .as_deref(),
            Some("2h ago")
        );
        assert!(!s.landed());
    }

    #[test]
    fn a_pr_status_tone_follows_the_colours() {
        let ready = status(
            json!({ "state": "open", "ci": "passed", "review": "approved", "mergeable": "yes" }),
        );
        assert_eq!(
            (ready.tone(), ready.line().as_str()),
            (PrTone::Ready, "CI passed · Approved")
        );
        let waiting = status(
            json!({ "state": "open", "ci": "passed", "review": "required", "mergeable": "yes" }),
        );
        assert_eq!(waiting.tone(), PrTone::Blocked);
        let threads = status(
            json!({ "state": "open", "ci": "passed", "review": "approved", "unresolved": 1 }),
        );
        assert_eq!(
            (threads.tone(), threads.line().as_str()),
            (PrTone::Blocked, "CI passed · Approved · 1 open thread")
        );
        let draft = status(json!({ "state": "draft", "ci": "pending" }));
        assert_eq!(
            (draft.tone(), draft.line().as_str()),
            (PrTone::Plain, "Draft · CI running")
        );
        let merged = status(json!({ "state": "merged", "ci": "failed", "review": "approved" }));
        assert_eq!(
            (merged.tone(), merged.line().as_str(), merged.landed()),
            (PrTone::Plain, "Merged", true)
        );
        assert_eq!(status(json!({ "state": "open" })).line(), "Open");
    }

    #[test]
    fn a_short_ref_leaves_the_owner_off() {
        assert_eq!(
            short_ref("https://github.com/acme/ecom-api/pull/4940/files").as_deref(),
            Some("ecom-api#4940")
        );
        assert_eq!(short_ref("https://example.com/x"), None);
    }
}
