// A login's usage reset worth using now (docs/protocol/settings.md, Pools,
// "Telling Mike about resets"). On 26 Nov 2026 Mike's gmail Codex login sat
// at 0% on every machine for days with 2 resets unused, as only a stopped
// thread's limit box offered one. The runner decides when a login gets a
// hint (runner/src/reset-hint.ts); this only words it for the Usage row, the
// Usage button's tooltip and the composer's login lists. Nothing here spends
// a reset: Codex redeems it through the runner, Claude in its own settings.
use crate::inbox::parse_ms;
use crate::logins::{short_account_name, sign_in_label, Account, ResetHint};
use crate::new_thread::reset_words;
use chrono::TimeZone;

pub const CLAUDE_USAGE_URL: &str = "https://claude.ai/settings/usage";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResetAction {
    RedeemCodex,
    OpenClaudeUsage,
}

impl ResetAction {
    fn for_account(account: &Account) -> Option<Self> {
        match account.provider.as_str() {
            "codex" => Some(Self::RedeemCodex),
            "claude" => Some(Self::OpenClaudeUsage),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::RedeemCodex => "Use a reset",
            Self::OpenClaudeUsage => "Open Claude Usage",
        }
    }

    pub fn has_pending_state(self) -> bool {
        self == Self::RedeemCodex
    }
}

/// The login's hint, unless it can't be counted on any more: none left, the
/// soonest reset expired since the runner said (another runner's row that's
/// gone quiet), or a login nothing runs on.
pub fn offer(account: &Account, now: i64) -> Option<(ResetAction, &ResetHint)> {
    if account.signed_out || account.plan_ended {
        return None;
    }
    let action = ResetAction::for_account(account)?;
    let hint = account.reset_hint.as_ref().filter(|h| {
        h.available > 0
            && !h
                .next_expires_at
                .as_deref()
                .and_then(parse_ms)
                .is_some_and(|at| at <= now)
    })?;
    Some((action, hint))
}

/// Whether the runner said it's about to expire rather than that the login
/// is out. An unknown why is drawn as out.
pub fn expiring(hint: &ResetHint) -> bool {
    hint.why == "expiring"
}

/// "2 resets left", "1 reset left": the login lists' words.
pub fn count_words(hint: &ResetHint) -> String {
    match hint.available {
        1 => "1 reset left".to_owned(),
        n => format!("{n} resets left"),
    }
}

/// The Usage row's line: "2 resets left, the next expires 9 Dec" for a
/// login that's out, "2 resets left, one expires Tue 9 am" for one about to
/// lose it.
pub fn row_words<Tz: TimeZone>(hint: &ResetHint, now: i64, zone: &Tz) -> String {
    let mut words = count_words(hint);
    if let Some(at) = hint.next_expires_at.as_deref().and_then(parse_ms) {
        let when = reset_words(at, now, zone);
        if !when.is_empty() {
            words.push_str(&if expiring(hint) {
                format!(", one expires {when}")
            } else {
                format!(", the next expires {when}")
            });
        }
    }
    words
}

/// Use a reset's tip: "Restores Codex alex's 5-hour and weekly limits now. 2
/// left, the next expires 9 Dec." With one about to expire, that it's lost
/// unused then.
pub fn use_tip<Tz: TimeZone>(
    action: ResetAction,
    account: &Account,
    accounts: &[Account],
    hint: &ResetHint,
    now: i64,
    zone: &Tz,
) -> String {
    if action == ResetAction::OpenClaudeUsage {
        return format!(
            "Opens Claude Usage. Check you're signed in as {}, then choose Reset for free.",
            account.name()
        );
    }
    let name = short_account_name(&account.id, accounts);
    let when = hint
        .next_expires_at
        .as_deref()
        .and_then(parse_ms)
        .map(|at| reset_words(at, now, zone))
        .filter(|w| !w.is_empty());
    let left = match hint.available {
        1 => "1 left".to_owned(),
        n => format!("{n} left"),
    };
    match when {
        Some(when) if expiring(hint) => format!(
            "Restores {name}'s 5-hour and weekly limits now, rather than letting a reset expire unused {when}. {left}"
        ),
        Some(when) => format!(
            "Restores {name}'s 5-hour and weekly limits now. {left}, the next expires {when}"
        ),
        None => format!("Restores {name}'s 5-hour and weekly limits now. {left}"),
    }
}

/// The Usage button's tooltip lines, under the sign-ins: "codex-1
/// (alex@example.com): out of room, 2 resets left", "codex-2
/// (sam@example.com): a reset expires Tue 9 am, 2 resets left".
pub fn icon_lines<Tz: TimeZone>(accounts: &[Account], now: i64, zone: &Tz) -> Vec<String> {
    accounts
        .iter()
        .filter_map(|a| {
            let (_, h) = offer(a, now)?;
            let who = sign_in_label(a);
            let when = h
                .next_expires_at
                .as_deref()
                .and_then(parse_ms)
                .map(|at| reset_words(at, now, zone))
                .filter(|w| !w.is_empty());
            Some(match when {
                Some(when) if expiring(h) => {
                    format!("{who}: a reset expires {when}, {}", count_words(h))
                }
                _ => format!("{who}: out of room, {}", count_words(h)),
            })
        })
        .collect()
}

/// Whether any login has a hint: the Usage button's dot, as for a sign-in
/// that's ending.
pub fn any(accounts: &[Account], now: i64) -> bool {
    accounts.iter().any(|a| offer(a, now).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;
    use serde_json::json;

    const NOW: &str = "2026-11-26T05:00:00.000Z";

    fn now() -> i64 {
        parse_ms(NOW).unwrap()
    }

    fn zone() -> FixedOffset {
        FixedOffset::east_opt(8 * 3600).unwrap()
    }

    fn codex(id: &str, email: &str, hint: serde_json::Value) -> Account {
        let mut logins = crate::logins::RunnerLogins::default();
        logins.set_accounts(&json!([{ "id": id, "provider": "codex", "title": format!("Codex · {email}"), "email": email, "resetHint": hint }]));
        logins.accounts.remove(0)
    }

    #[test]
    fn a_hint_counts_until_it_expires_or_runs_out() {
        let out = codex(
            "codex-1",
            "alex@example.com",
            json!({ "why": "out", "available": 2, "nextExpiresAt": "2026-12-09T01:00:00.000Z" }),
        );
        assert_eq!(offer(&out, now()).map(|(_, h)| h.available), Some(2));
        assert!(any(std::slice::from_ref(&out), now()));
        let gone = codex(
            "codex-1",
            "alex@example.com",
            json!({ "why": "out", "available": 2, "nextExpiresAt": "2026-11-26T04:59:00.000Z" }),
        );
        assert!(
            offer(&gone, now()).is_none(),
            "expired since the runner said"
        );
        let none = codex(
            "codex-1",
            "alex@example.com",
            json!({ "why": "out", "available": 0 }),
        );
        assert!(offer(&none, now()).is_none());
        let mut signed_out = out;
        signed_out.signed_out = true;
        assert!(offer(&signed_out, now()).is_none());
        let bare = codex("codex-1", "alex@example.com", serde_json::Value::Null);
        assert!(offer(&bare, now()).is_none(), "an older runner sends none");
        let odd = codex(
            "codex-1",
            "alex@example.com",
            json!({ "why": 3, "available": "two" }),
        );
        assert!(
            offer(&odd, now()).is_none(),
            "a field of the wrong type is dropped, not a failure"
        );
    }

    #[test]
    fn the_reset_action_comes_from_the_provider() {
        let mut login = codex(
            "login",
            "alex@example.com",
            json!({ "why": "out", "available": 2 }),
        );
        assert_eq!(
            offer(&login, now()).map(|(action, _)| action),
            Some(ResetAction::RedeemCodex)
        );
        login.provider = "claude".into();
        assert_eq!(
            offer(&login, now()).map(|(action, _)| action),
            Some(ResetAction::OpenClaudeUsage)
        );
        login.provider.clear();
        assert!(offer(&login, now()).is_none());
    }

    #[test]
    fn its_words_say_how_many_and_when() {
        let out = codex(
            "codex-1",
            "alex@example.com",
            json!({ "why": "out", "available": 2, "nextExpiresAt": "2026-12-09T01:00:00.000Z" }),
        );
        let (action, h) = offer(&out, now()).unwrap();
        assert_eq!(count_words(h), "2 resets left");
        assert_eq!(
            row_words(h, now(), &zone()),
            "2 resets left, the next expires 9 Dec"
        );
        let soon = codex(
            "codex-2",
            "sam@example.com",
            json!({ "why": "expiring", "available": 1, "nextExpiresAt": "2026-11-28T01:00:00.000Z" }),
        );
        let (soon_action, s) = offer(&soon, now()).unwrap();
        assert_eq!(count_words(s), "1 reset left");
        assert_eq!(
            row_words(s, now(), &zone()),
            "1 reset left, one expires Sat 9 am"
        );
        let accounts = vec![out.clone(), soon.clone()];
        assert_eq!(
            use_tip(action, &out, &accounts, h, now(), &zone()),
            "Restores Codex alex's 5-hour and weekly limits now. 2 left, the next expires 9 Dec"
        );
        assert_eq!(
            use_tip(soon_action, &soon, &accounts, s, now(), &zone()),
            "Restores Codex sam's 5-hour and weekly limits now, rather than letting a reset expire unused Sat 9 am. 1 left"
        );
        assert_eq!(
            icon_lines(&accounts, now(), &zone()),
            vec![
                "codex-1 (alex@example.com): out of room, 2 resets left".to_owned(),
                "codex-2 (sam@example.com): a reset expires Sat 9 am, 1 reset left".to_owned(),
            ]
        );
        for line in icon_lines(&accounts, now(), &zone()) {
            assert!(!line.contains('\u{2014}'), "no em dashes: {line}");
        }
    }
}
