// Ports of the model parts of app/Tests/ThreadbearCoreTests/NeedsYouTests.swift
// (docs/protocol/needs-you.md, "Needs you"): a finished turn's asks as a card. The
// sidebar and ThreadSummary tests in that file aren't transcript rules.
#![allow(
    non_snake_case,
    reason = "test names follow the Swift tests they mirror (testSomethingHappens)"
)]

mod support;

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use support::*;
use threadbear_core::reducer::*;

fn done_event(seq: i64, turn: &str, needs: Option<&str>, asks: Value, next: Value) -> Event {
    let mut fields = json!({"turnId": turn, "outcome": "completed", "durationMs": 1000});
    if let Some(needs) = needs {
        fields["needs"] = json!(needs);
    }
    if asks.as_array().is_some_and(|a| !a.is_empty()) {
        fields["asks"] = asks;
    }
    if next.as_array().is_some_and(|n| !n.is_empty()) {
        fields["next"] = next;
    }
    event_turn(seq, "turn.completed", fields, Some(turn))
}

fn needs_you(seq: i64, turn: &str, asks: Value) -> Event {
    done_event(seq, turn, Some("you"), asks, json!([]))
}

fn needs_nothing(seq: i64, turn: &str, next: Value) -> Event {
    done_event(seq, turn, Some("nothing"), json!([]), next)
}

fn card<'a>(model: &'a TranscriptModel, id: &str) -> Option<&'a AsksCard> {
    match model.row(id).map(|r| &r.content) {
        Some(RowContent::Asks(card)) => Some(card),
        _ => None,
    }
}

fn picks(entries: &[(i64, i64)]) -> BTreeMap<i64, i64> {
    entries.iter().copied().collect()
}

fn ticks(values: &[i64]) -> BTreeSet<i64> {
    values.iter().copied().collect()
}

#[test]
fn testCoordinatorKeepsItsOpenCardOnABackgroundWake() {
    let asks = json!([{"action": "Which room?", "taskId": "room", "options": ["Blue", "Red"]}]);
    let carried = event_turn(
        6,
        "turn.completed",
        json!({"turnId": "wake", "outcome": "completed", "needs": "you", "asks": asks,
            "carriedAsks": {"seq": 3, "ticked": [0]}}),
        Some("wake"),
    );
    let mut model = from_events(vec![needs_you(3, "first", asks)]);
    model.set_ask_picks(3, picks(&[(0, 1)]));
    model.apply(vec![
        event_turn(
            4,
            "user.message",
            json!({"text": "A check is due", "origin": "schedule"}),
            Some("wake"),
        ),
        carried.clone(),
    ]);
    assert!(card(&model, "ak:6").is_none());
    let open = card(&model, "ak:3").unwrap();
    assert!(open.is_open);
    assert_eq!(open.seq, 6);
    assert_eq!(open.source_seq, 3);
    assert_eq!(open.picks, picks(&[(0, 1)]));
    assert_eq!(open.ticked, ticks(&[0]));
    model.apply(vec![event(
        7,
        "asks.ticked",
        json!({"asksSeq": 6, "ticked": []}),
    )]);
    assert!(card(&model, "ak:3").unwrap().ticked.is_empty());
    model.apply(vec![needs_you(
        8,
        "changed",
        json!([{"action": "Which floor?"}]),
    )]);
    assert!(card(&model, "ak:3").is_none());
    assert!(card(&model, "ak:8").unwrap().is_open);
    let page = from_events(vec![carried]);
    let Some(RowContent::Asks(open)) = page.open_card().map(|row| &row.content) else {
        panic!("a carried card on a later page")
    };
    assert_eq!(open.source_seq, 3);
    assert_eq!(open.seq, 6);
    assert_eq!(open.ticked, ticks(&[0]));
}

#[test]
fn testCarryDoesNotReopenAResolvedCard() {
    let asks = json!([{"action": "Which room?", "taskId": "room", "options": ["Blue", "Red"]}]);
    let model = from_events(vec![
        needs_you(3, "first", asks.clone()),
        event(
            4,
            "asks.ticked",
            json!({"asksSeq": 3, "ticked": [0], "resolved": [0]}),
        ),
        event_turn(
            6,
            "turn.completed",
            json!({"turnId": "later", "outcome": "completed", "needs": "you", "asks": asks,
            "carriedAsks": {"seq": 3}}),
            Some("later"),
        ),
    ]);
    assert!(card(&model, "ak:3").is_none());
    assert_eq!(card(&model, "ak:6").unwrap().source_seq, 6);
}

/// A turn that needs Mike gets its card under its footer, open until the
/// next turn closes it, and keeps the picks the app gives it, through a
/// rebuild too.
#[test]
fn testATurnThatNeedsYouGetsACardThatKeepsItsPicksUntilHeReplies() {
    let mut model = from_events(vec![
        event_turn(1, "turn.started", json!({"turnId": "t1"}), Some("t1")),
        text(2, "m1", "Built it."),
        needs_you(
            3,
            "t1",
            json!([
                {"action": "Log in", "links": [{"title": "Open login", "url": "https://hf.co/login"}], "options": ["Done", "Can't"]},
                {"action": "Pick a budget"},
            ]),
        ),
    ]);
    let Some(RowContent::Footer(footer)) = model.row("f:t1").map(|r| &r.content) else {
        panic!("a footer")
    };
    assert_eq!(footer.needs.as_deref(), Some("you"));
    assert_eq!(model.rows().last().map(|r| r.id.as_str()), Some("ak:3"));
    assert_eq!(card(&model, "ak:3").map(|c| c.is_open), Some(true));
    assert_eq!(
        card(&model, "ak:3")
            .and_then(|c| c.asks.first())
            .map(|a| a.links.clone()),
        Some(vec![AskLink {
            title: "Open login".into(),
            url: "https://hf.co/login".into()
        }])
    );
    assert!(!model.set_ask_picks(3, picks(&[(0, 0)])).is_empty());
    assert_eq!(
        card(&model, "ak:3").map(|c| c.picks.clone()),
        Some(picks(&[(0, 0)]))
    );
    assert!(
        model.set_ask_picks(3, picks(&[(0, 0)])).is_empty(),
        "the same picks change nothing"
    );
    // A message from the runner (a resume) leaves it; Mike's reply closes
    // it, and a closed card isn't shown (the bubble has the answers).
    model.apply(vec![event_turn(
        4,
        "user.message",
        json!({"text": "Carry on", "images": [], "origin": "runner"}),
        Some("t2"),
    )]);
    assert_eq!(card(&model, "ak:3").map(|c| c.is_open), Some(true));
    model.apply(vec![
        event_turn(
            5,
            "user.message",
            json!({"text": "Log in\nDone", "images": []}),
            Some("t2"),
        ),
        event_turn(6, "turn.started", json!({"turnId": "t2"}), Some("t2")),
        done_event(7, "t2", None, json!([]), json!([])),
    ]);
    assert!(model.row("ak:3").is_none());
    assert!(
        from_events(model.events().to_vec()).row("ak:3").is_none(),
        "nor after a reload"
    );
}

/// Picks the app had before the transcript loaded are on the card it builds.
#[test]
fn testPicksSetBeforeTheEventsLoad() {
    let mut model = TranscriptModel::new(None);
    model.set_ask_picks(1, picks(&[(0, 1)]));
    model.load(
        vec![needs_you(
            1,
            "t1",
            json!([{"action": "a", "options": ["x", "y"]}]),
        )],
        &[],
    );
    assert_eq!(
        card(&model, "ak:1").map(|c| c.picks.clone()),
        Some(picks(&[(0, 1)]))
    );
}

/// A message that answered asks keeps them for its bubble.
#[test]
fn testAUserMessageKeepsItsAnswers() {
    let model = from_events(vec![event_turn(
        1,
        "user.message",
        json!({"text": "Log in\nDone", "images": [], "answers": [{"action": "Log in", "answer": "Done"}, {"bad": 1}]}),
        Some("t1"),
    )]);
    let Some(RowContent::User(message)) = model.row("u:1").map(|r| &r.content) else {
        panic!("a user row")
    };
    assert_eq!(
        message.answers,
        [AskAnswer {
            action: "Log in".into(),
            answer: "Done".into()
        }]
    );
}

/// A turn that needs nothing gets the done card in place of its end_turn
/// call, which isn't shown once the runner takes it; a refused one is.
#[test]
fn testADoneTurnGetsTheDoneCardAndHidesItsEndTurn() {
    let end_turn = |seq, id: &str| {
        call_with(
            seq,
            id,
            "mcp__threadbear__end_turn",
            "other",
            "end_turn",
            json!({"needs": "nothing"}),
        )
    };
    let mut model = from_events(vec![
        event_turn(1, "turn.started", json!({"turnId": "t1"}), Some("t1")),
        end_turn(2, "c1"),
        result_with(
            3,
            "c1",
            false,
            "Not ended: the user hasn't had a reply this turn.",
            json!([]),
        ),
        text(4, "m1", "Built it."),
        end_turn(5, "c2"),
        result_text(6, "c2", "Noted: this thread is done."),
        needs_nothing(7, "t1", json!([])),
    ]);
    let Some(RowContent::Group(work)) = model.row("g:t:c1").map(|r| &r.content) else {
        panic!("the turn's line of work")
    };
    assert_eq!(
        work.member_ids,
        ["t:c1"],
        "the refused call is in the turn's work; the taken one isn't shown"
    );
    assert!(model.row("t:c2").is_none());
    assert_eq!(model.rows().last().map(|r| r.id.as_str()), Some("ak:7"));
    assert_eq!(card(&model, "ak:7").map(|c| c.is_done()), Some(true));
    assert_eq!(card(&model, "ak:7").map(|c| c.is_open), Some(true));
    // Mike's next message puts it away, as it does an asks card.
    model.apply(vec![event_turn(
        8,
        "user.message",
        json!({"text": "One more thing", "images": []}),
        Some("t2"),
    )]);
    assert!(model.row("ak:7").is_none());
}

/// end_turn's follow-ups ride on the done card; one that isn't a string is
/// dropped.
#[test]
fn testTheDoneCardCarriesTheSuggestedNextSteps() {
    let model = from_events(vec![needs_nothing(
        1,
        "t1",
        json!(["Show Mac mini pictures", 7, "Start Mac mini threads"]),
    )]);
    assert_eq!(card(&model, "ak:1").map(|c| c.is_done()), Some(true));
    assert_eq!(
        card(&model, "ak:1").map(|c| c.next.clone()),
        Some(vec![
            "Show Mac mini pictures".to_owned(),
            "Start Mac mini threads".to_owned()
        ])
    );
}

/// Ticking follow-ups shows on the done card, and survives a rebuild of the
/// rows.
#[test]
fn testFollowUpsAreTickedOnTheDoneCard() {
    let mut model = from_events(vec![needs_nothing(
        1,
        "t1",
        json!(["Check the nightly", "Refresh the cache"]),
    )]);
    model.set_next_picks(1, ticks(&[0, 1]), ticks(&[]));
    assert_eq!(
        card(&model, "ak:1").map(|c| c.picked_next.clone()),
        Some(ticks(&[0, 1]))
    );
    model.set_next_picks(1, ticks(&[1]), ticks(&[]));
    assert_eq!(
        card(&model, "ak:1").map(|c| c.picked_next.clone()),
        Some(ticks(&[1]))
    );
    // Picks made before the events load (a transcript opened again).
    let mut later = TranscriptModel::new(None);
    later.set_next_picks(1, ticks(&[0]), ticks(&[]));
    later.load(
        vec![needs_nothing(1, "t1", json!(["Check the nightly"]))],
        &[],
    );
    assert_eq!(
        card(&later, "ak:1").map(|c| c.picked_next.clone()),
        Some(ticks(&[0]))
    );
}

/// The runner's loose-ends check rides on the done card it's for, follows
/// the summary, and survives a reload.
#[test]
fn testLooseEndsGoOnTheirOwnDoneCard() {
    let mut model = from_events(vec![needs_nothing(1, "t1", json!([]))]);
    assert_eq!(
        card(&model, "ak:1").and_then(|c| c.loose_ends.clone()),
        None,
        "not checked"
    );
    let open = LooseEnds {
        seq: 1,
        ends: vec![LooseEnd::new(
            "unlanded",
            "1 commit on thread/x isn't on main",
        )],
    };
    assert!(!model.set_loose_ends(Some(open.clone())).is_empty());
    assert_eq!(
        card(&model, "ak:1")
            .and_then(|c| c.loose_ends.clone())
            .map(|e| e.iter().map(|x| x.kind.clone()).collect::<Vec<_>>()),
        Some(vec!["unlanded".to_owned()])
    );
    assert!(open.any_open());
    model.set_loose_ends(Some(LooseEnds {
        seq: 1,
        ends: vec![],
    }));
    assert_eq!(
        card(&model, "ak:1").and_then(|c| c.loose_ends.clone()),
        Some(vec![]),
        "checked, nothing left"
    );
    // For another card: this one shows none.
    model.set_loose_ends(Some(LooseEnds {
        seq: 9,
        ends: vec![],
    }));
    assert_eq!(
        card(&model, "ak:1").and_then(|c| c.loose_ends.clone()),
        None
    );
    let mut later = TranscriptModel::new(None);
    later.set_loose_ends(Some(open));
    later.load(vec![needs_nothing(1, "t1", json!([]))], &[]);
    assert_eq!(
        card(&later, "ak:1")
            .and_then(|c| c.loose_ends.clone())
            .map(|e| e.len()),
        Some(1)
    );
    let booked = LooseEnds {
        seq: 1,
        ends: vec![LooseEnd {
            at: Some("2026-11-13T01:30:00Z".to_owned()),
            ..LooseEnd::new("scheduled", "Review the week")
        }],
    };
    assert!(!booked.any_open());
    let decoded = LooseEnds::decode(&json!({"seq": 1, "at": "2026-11-07T00:00:00Z", "ends": [{"kind": "thread", "text": "x", "threadId": "b"}, {"bad": 1}, {"kind": "later", "text": "y"}]})).expect("loose ends");
    assert_eq!(
        decoded
            .ends
            .iter()
            .map(|e| e.kind.clone())
            .collect::<Vec<_>>(),
        ["thread", "later"]
    );
    assert_eq!(
        decoded
            .ends
            .first()
            .and_then(|e| e.thread_id.clone())
            .as_deref(),
        Some("b")
    );
}

/// The thread's background work rides on its done cards, the one that
/// arrives while it runs included, and goes when it's over.
#[test]
fn testDoneCardsCarryTheBackgroundWork() {
    let job = vec![BackgroundTask::new(BackgroundKind::Shell, "tb land", false)];
    let mut model = from_events(vec![needs_nothing(1, "t1", json!([]))]);
    assert_eq!(card(&model, "ak:1").map(|c| c.still_running()), Some(false));
    assert!(!model.set_background(job.clone()).is_empty());
    assert_eq!(
        card(&model, "ak:1").map(|c| c.running.clone()),
        Some(job.clone())
    );
    assert_eq!(card(&model, "ak:1").map(|c| c.still_running()), Some(true));
    model.set_background(vec![]);
    assert_eq!(card(&model, "ak:1").map(|c| c.still_running()), Some(false));
    let mut later = TranscriptModel::new(None);
    later.set_background(job.clone());
    later.load(vec![needs_nothing(1, "t1", json!([]))], &[]);
    assert_eq!(card(&later, "ak:1").map(|c| c.running.clone()), Some(job));
    assert_eq!(card(&later, "ak:1").map(|c| c.still_running()), Some(true));
}

/// The check arrives on the thread's summary (`threads.list`,
/// `thread.updated`), which the GPUI app's summary used to drop on the floor:
/// the Swift app's done card said "Still open" and the GPUI one didn't (12
/// Nov, "State machines").
#[test]
fn testLooseEndsComeOnTheSummary() {
    let summary: threadbear_core::inbox::ThreadSummary = serde_json::from_value(json!({
        "id": "t", "status": "idle", "needs": "nothing",
        "looseEnds": {"seq": 1, "at": "2026-11-12T00:00:00Z", "ends": [{"kind": "unpushed", "text": "4 commits it made in convex-native-v7 aren't pushed"}]},
    }))
    .expect("summary");
    let mut model = from_events(vec![needs_nothing(1, "t1", json!([]))]);
    model.set_loose_ends(summary.loose_ends_check());
    assert_eq!(
        card(&model, "ak:1")
            .and_then(|c| c.loose_ends.clone())
            .map(|e| e.iter().map(|x| x.text.clone()).collect::<Vec<_>>()),
        Some(vec![
            "4 commits it made in convex-native-v7 aren't pushed".to_owned()
        ])
    );
    // A summary without it (a turn running, the experiment off) takes it away.
    let bare: threadbear_core::inbox::ThreadSummary =
        serde_json::from_value(json!({"id": "t", "status": "idle"})).expect("summary");
    model.set_loose_ends(bare.loose_ends_check());
    assert_eq!(
        card(&model, "ak:1").and_then(|c| c.loose_ends.clone()),
        None
    );
    // One it can't read leaves the rest of the summary standing.
    let odd: threadbear_core::inbox::ThreadSummary =
        serde_json::from_value(json!({"id": "t", "title": "Kept", "looseEnds": "what"}))
            .expect("summary");
    assert_eq!((odd.title.as_str(), odd.loose_ends_check()), ("Kept", None));
}

/// A booked check-in is the runner's `scheduled` kind: it doesn't count as
/// open, and its line says when it comes back (looseEndsText).
#[test]
fn testABookedCheckInSaysWhenItComesBack() {
    let end = LooseEnd {
        at: Some("2026-11-13T01:30:00Z".to_owned()),
        ..LooseEnd::new("scheduled", "Review the week")
    };
    assert!(end.is_booked());
    let utc = threadbear_core::chrono::Utc;
    assert_eq!(end.line(&utc), "Fri 13 Nov, 1:30 am: Review the week");
    let open = LooseEnd {
        at: Some("2026-11-13T01:30:00Z".to_owned()),
        ..LooseEnd::new("unlanded", "1 commit on thread/x isn't on main")
    };
    assert!(!open.is_booked());
    assert_eq!(open.line(&utc), "1 commit on thread/x isn't on main");
}

/// A follow-up's "?" toggles like its tick and goes with the ticks.
#[test]
fn testFollowUpsAskedAboutGoWithTheTicks() {
    let mut model = from_events(vec![needs_nothing(
        1,
        "t1",
        json!(["Check the nightly", "Refresh the cache", "Bump Node"]),
    )]);
    model.set_next_picks(1, ticks(&[0]), ticks(&[1, 2]));
    assert_eq!(
        card(&model, "ak:1").map(|c| c.picked_next.clone()),
        Some(ticks(&[0]))
    );
    assert_eq!(
        card(&model, "ak:1").map(|c| c.explain_next.clone()),
        Some(ticks(&[1, 2]))
    );
    model.set_next_picks(1, ticks(&[0]), ticks(&[]));
    assert_eq!(
        card(&model, "ak:1").map(|c| c.explain_next.clone()),
        Some(ticks(&[]))
    );
    let mut later = TranscriptModel::new(None);
    later.set_next_picks(1, ticks(&[]), ticks(&[0]));
    later.load(
        vec![needs_nothing(1, "t1", json!(["Check the nightly"]))],
        &[],
    );
    assert_eq!(
        card(&later, "ak:1").map(|c| c.explain_next.clone()),
        Some(ticks(&[0]))
    );
}

/// The open card is what the composer draws at its top, with its picks;
/// Mike's reply takes it out of the composer as well.
#[test]
fn testTheOpenCardIsTheLastTurnsUntilHeReplies() {
    let mut model = from_events(vec![needs_nothing(1, "t1", json!(["Tidy notes"]))]);
    assert_eq!(model.open_card().map(|r| r.id.as_str()), Some("ak:1"));
    model.apply(vec![
        event_turn(
            2,
            "user.message",
            json!({"text": "Tidy notes", "images": []}),
            Some("t2"),
        ),
        event_turn(3, "turn.started", json!({"turnId": "t2"}), Some("t2")),
        needs_you(
            4,
            "t2",
            json!([{"action": "Merge?", "options": ["Yes", "No"]}]),
        ),
    ]);
    assert_eq!(model.open_card().map(|r| r.id.as_str()), Some("ak:4"));
    model.set_ask_picks(4, picks(&[(0, 1)]));
    let Some(RowContent::Asks(open)) = model.open_card().map(|r| &r.content) else {
        panic!("a card")
    };
    assert_eq!(open.picks, picks(&[(0, 1)]));
    model.apply(vec![event_turn(
        5,
        "user.message",
        json!({"text": "Merge?\nNo", "images": []}),
        Some("t3"),
    )]);
    assert!(model.open_card().is_none());
    // A turn that ends without saying (an older session) has none.
    model.apply(vec![
        event_turn(6, "turn.started", json!({"turnId": "t3"}), Some("t3")),
        done_event(7, "t3", None, json!([]), json!([])),
    ]);
    assert!(model.open_card().is_none());
}

/// Asks ticked off on that runner come ticked (the relay keeps `ticked`), so
/// a finished checklist isn't outstanding.
#[test]
fn testAsksTickedOnTheRunnerComeTicked() {
    let checklist = from_events(vec![needs_you(
        3,
        "t1",
        json!([{"action": "Plug in the drive", "ticked": true}, {"action": "Say done"}]),
    )]);
    let Some(RowContent::Asks(open)) = checklist.open_card().map(|r| &r.content) else {
        panic!("a card")
    };
    assert_eq!(open.ticked, ticks(&[0]));
}

#[test]
fn task_board_resolution_keeps_other_asks_open_and_dismisses_the_last() {
    let mut model = from_events(vec![needs_you(
        3,
        "t1",
        json!([{"action": "Pick a day", "options": ["Friday", "Monday"]},
               {"action": "Pick a room", "options": ["Blue", "Red"]}]),
    )]);
    model.apply(vec![event_turn(
        4,
        "asks.ticked",
        json!({"asksSeq": 3, "ticked": [0], "resolved": [0]}),
        None,
    )]);
    let Some(RowContent::Asks(open)) = model.open_card().map(|row| &row.content) else {
        panic!("the other decision stays open");
    };
    assert!(!open.can_answer(0));
    assert!(open.can_answer(1));
    let picks = [(0, 1), (1, 0)].into_iter().collect();
    assert_eq!(open.active_picks(&picks), [(1, 0)].into_iter().collect());

    model.apply(vec![event_turn(
        5,
        "asks.ticked",
        json!({"asksSeq": 3, "ticked": [1]}),
        None,
    )]);
    let Some(RowContent::Asks(open)) = model.open_card().map(|row| &row.content) else {
        panic!("a checklist tick must not retire a decision");
    };
    assert!(!open.can_answer(0));
    assert!(open.can_answer(1));
    model.apply(vec![event_turn(
        6,
        "asks.ticked",
        json!({"asksSeq": 3, "ticked": [0, 1], "resolved": [0, 1]}),
        None,
    )]);
    assert!(model.open_card().is_none());
}

/// Sent is answered: the card doesn't wait for the runner to show the
/// message, which can sit queued for a while. A failed send brings it back.
#[test]
fn testTheOpenCardGoesOnceHisReplyIsOnItsWay() {
    let mut model = from_events(vec![needs_you(
        1,
        "t1",
        json!([{"action": "Merge?", "options": ["Yes", "No"]}]),
    )]);
    assert_eq!(model.open_card().map(|r| r.id.as_str()), Some("ak:1"));
    let reply = PendingMessage {
        answers: vec![AskAnswer {
            action: "Merge?".into(),
            answer: "Yes".into(),
        }],
        queued: true,
        ..PendingMessage::new("r1", "Merge?\nYes", 1)
    };
    model.set_pending(vec![reply]);
    assert!(model.open_card().is_none());
    model.set_pending(vec![]);
    assert_eq!(model.open_card().map(|r| r.id.as_str()), Some("ak:1"));
}

#[test]
fn an_asks_link_opens_a_page_a_file_or_a_review_and_nothing_else() {
    use threadbear_core::reducer::AskLink;
    let link = |url: &str| AskLink {
        title: "Look".into(),
        url: url.into(),
    };
    assert_eq!(
        link("https://example.com/a").target("/Users/m").as_deref(),
        Some("https://example.com/a")
    );
    assert_eq!(
        link("~/dev/notes.md").target("/Users/m").as_deref(),
        Some("/Users/m/dev/notes.md")
    );
    assert_eq!(
        link("/tmp/shot.png").target("").as_deref(),
        Some("/tmp/shot.png")
    );
    assert_eq!(
        link("review:abc123").target("").as_deref(),
        Some("review:abc123")
    );
    assert_eq!(link("review:").target(""), None);
    // An ask whose step is in another thread opens that thread.
    assert_eq!(
        link("thread:335f6ddb").target("").as_deref(),
        Some("thread:335f6ddb")
    );
    assert_eq!(link("thread:").target(""), None);
    assert_eq!(link("javascript:alert(1)").target(""), None);
    assert_eq!(link("notes.md").target("/Users/m"), None);
}

/// The turn that answered another lab's findings carries the ledger on its
/// `turn.completed`, read leniently, and it shows as a quiet row in the
/// transcript over the reply (Mike moved it off the done card, 12 Nov;
/// docs/protocol/needs-you.md, "Review by another lab").
#[test]
fn a_reviewed_turns_ledger_is_a_row_over_the_reply() {
    let review = json!({
        "reviewer": "Codex (codex-1)", "independent": true, "rounds": 2, "threadId": "rev-1", "passed": false,
        "findings": [
            {"id": 1, "round": 1, "severity": "high", "claim": "Drops the session on refresh.", "where": "auth.ts:40", "outcome": "fixed"},
            {"id": 2, "round": 2, "claim": "Keeps the old token after sign-out.", "outcome": "left"},
            {"id": 3, "claim": ""},
            "not a finding"
        ]
    });
    let mut fields =
        json!({"turnId": "t1", "outcome": "completed", "durationMs": 1000, "needs": "nothing"});
    fields["review"] = review;
    let model = from_events(vec![
        event(1, "turn.started", json!({"turnId": "t1"})),
        call(2, "c1"),
        text(3, "m1", "Fixed the refresh."),
        event_turn(4, "turn.completed", fields, Some("t1")),
    ]);
    assert_eq!(ids(&model), ["g:t:c1", "lr:t1", "a:m1", "f:t1", "ak:4"]);
    let Some(RowContent::LabReview(review)) = model.row("lr:t1").map(|r| &r.content) else {
        panic!("no review row")
    };
    assert_eq!(
        review.findings.len(),
        2,
        "a finding with no claim, or no object, isn't one"
    );
    assert_eq!(review.findings[0].severity, "high");
    assert_eq!(review.findings[1].severity, "medium", "medium by default");
    assert_eq!(review.heading(), "Reviewed by Codex, 2 rounds: 1 open");
    let fresh = LabReview {
        independent: false,
        rounds: 1,
        passed: true,
        findings: vec![],
        ..review.clone()
    };
    assert_eq!(
        fresh.heading(),
        "Reviewed by a fresh Codex session: nothing found"
    );
    assert_eq!(
        LabReview {
            unchecked: true,
            ..review.clone()
        }
        .heading(),
        "Reviewed by Codex, 2 rounds: last fixes not re-reviewed"
    );
    // With no work folded it still goes over the reply; a turn with no
    // review has no row.
    let mut asks = json!({"turnId": "t2", "outcome": "completed", "durationMs": 1000, "needs": "you", "asks": [{"action": "Sign out?"}]});
    asks["review"] = json!({"reviewer": "Codex", "findings": []});
    let model = from_events(vec![
        event_turn(
            1,
            "assistant.text",
            json!({"itemId": "m1", "text": "Over to you."}),
            Some("t2"),
        ),
        event_turn(2, "turn.completed", asks, Some("t2")),
    ]);
    assert_eq!(ids(&model)[..2], ["lr:t2", "a:m1"]);
    assert_eq!(
        model
            .row("lr:t2")
            .and_then(|r| match &r.content {
                RowContent::LabReview(r) => Some(r.heading()),
                _ => None,
            })
            .as_deref(),
        Some("Reviewed by Codex: all answered")
    );
    assert!(from_events(vec![needs_nothing(1, "t3", json!([]))])
        .row("lr:t3")
        .is_none());
    // A runner's turn carries on the stretch before it: the line goes over
    // the reviewed turn's own reply, not the earlier one's.
    let mut reviewed =
        json!({"turnId": "t2", "outcome": "completed", "durationMs": 1000, "needs": "nothing"});
    reviewed["review"] = json!({"reviewer": "Claude (claude-2)", "independent": false, "findings": [{"id": 1, "claim": "x", "outcome": "left"}]});
    let carried = from_events(vec![
        event(
            1,
            "user.message",
            json!({"text": "Tidy the imports", "images": []}),
        ),
        text(2, "m1", "Sorted them."),
        needs_nothing(3, "t1", json!([])),
        event_turn(4, "turn.started", json!({"turnId": "t2"}), Some("t2")),
        event_turn(
            5,
            "assistant.text",
            json!({"itemId": "m2", "text": "Fixed the refresh."}),
            Some("t2"),
        ),
        event_turn(6, "turn.completed", reviewed, Some("t2")),
    ]);
    let ids = ids(&carried);
    assert_eq!(
        ids.iter().position(|i| i == "lr:t2").map(|p| p + 1),
        ids.iter().position(|i| i == "a:m2"),
        "{ids:?}"
    );
}

/// The runner's message bringing a review back is a live checklist of its
/// findings while the agent works through them (review_note.rs), then folds
/// into `Worked for …` once the turn finishes so only the quiet `Reviewed by…`
/// row stays over the reply (Mike, 28 Nov 2026). Expanding `Worked for …`
/// shows the checklist indented inside the group with the turn's ledger
/// attached.
#[test]
fn a_review_note_folds_into_work_when_done_and_takes_the_ledger_when_expanded() {
    let note = "Codex reviewed the change you just made (thread 3f88a92e). Its findings, numbered:\n\n#1 [medium] disk_watch.sh:33: Empty timestamps stop snapshots. Case: A full disk.\n#2 [high] Scan misses logs.\n\nIts reply, with the detail:\n\nDetail.\n\nCheck each finding against the code: fix what holds up.";
    let note_round2 = "Codex reviewed the change you just made (thread 9a11bc02). Its findings, numbered:\n\n#3 [low] Drop unused temp file.\n\nIts reply, with the detail:\n\nRound 2 detail.\n\nCheck each finding against the code: fix what holds up.";
    let review = json!({"reviewer": "Codex (codex-1)", "threadId": "3f88a92e-0000", "findings": [
        {"id": 1, "round": 1, "severity": "medium", "claim": "Empty timestamps stop snapshots.", "outcome": "fixed"},
        {"id": 2, "round": 1, "severity": "high", "claim": "Scan misses logs.", "outcome": "disputed", "note": "Swap is watched elsewhere."}
    ]});
    let mut answered =
        json!({"turnId": "t2", "outcome": "completed", "durationMs": 1000, "needs": "nothing"});
    answered["review"] = review;
    let events = |done: Option<&Value>| {
        let mut events = vec![
            event(
                1,
                "user.message",
                json!({"text": "Fix the disk watch", "images": []}),
            ),
            text(2, "m1", "Done."),
            needs_nothing(3, "t1", json!([])),
            event_turn(4, "turn.started", json!({"turnId": "t2"}), Some("t2")),
            event_turn(
                5,
                "user.message",
                json!({"text": note, "images": [], "origin": "runner", "wakeReason": "Codex reviewed the change"}),
                Some("t2"),
            ),
            event_turn(
                6,
                "assistant.text",
                json!({"itemId": "m2", "text": "Fixed #1, #2 doesn't hold up."}),
                Some("t2"),
            ),
        ];
        if let Some(done) = done {
            events.push(event_turn(7, "turn.completed", done.clone(), Some("t2")));
        }
        events
    };
    let notes_of = |model: &TranscriptModel| -> Vec<(bool, UserMessage)> {
        model
            .rows()
            .iter()
            .filter_map(|r| match &r.content {
                RowContent::User(m) if m.review_note.is_some() => Some((r.in_group, m.clone())),
                _ => None,
            })
            .collect()
    };

    // While the agent is working through the findings, the checklist stays live.
    let running = from_events(events(None));
    let live = notes_of(&running);
    assert_eq!(live.len(), 1, "{:?}", ids(&running));
    assert!(!live[0].0, "live review note is at top level");
    let parsed = live[0].1.review_note.as_deref().unwrap();
    assert_eq!(parsed.findings.len(), 2);
    assert_eq!(parsed.heading(), "Codex · 2 findings");
    assert!(live[0].1.review_ledger.is_none(), "nothing answered yet");

    // Once the turn finishes, the checklist folds into `Worked for …` and the
    // quiet `Reviewed by…` row stays over the reply.
    let mut done = from_events(events(Some(&answered)));
    assert!(
        notes_of(&done).is_empty(),
        "finished review checklist folds into work: {:?}",
        ids(&done)
    );
    assert!(
        done.row("lr:t2").is_some(),
        "the quiet Reviewed by… row stays in the transcript: {:?}",
        ids(&done)
    );
    let group_id = done
        .rows()
        .iter()
        .find_map(|r| matches!(r.content, RowContent::Group(_)).then(|| r.id.clone()))
        .expect("a Worked for … group");

    // Expanding `Worked for …` reveals the checklist indented inside the group
    // with the turn's ledger attached.
    done.set_expanded(&group_id, true);
    let expanded = notes_of(&done);
    assert_eq!(expanded.len(), 1, "{:?}", ids(&done));
    assert!(expanded[0].0, "folded review note keeps in_group = true");
    let ledger = expanded[0]
        .1
        .review_ledger
        .as_deref()
        .expect("the ledger came to the expanded note");
    assert_eq!(ledger.findings[1].outcome.as_deref(), Some("disputed"));

    // Multi-round: while round 2 is running, round 1 is folded into work and
    // round 2 stays live; once round 2 finishes, both fold into work.
    let mut round2_events = events(Some(&answered));
    round2_events.push(event_turn(
        8,
        "turn.started",
        json!({"turnId": "t3"}),
        Some("t3"),
    ));
    round2_events.push(event_turn(
        9,
        "user.message",
        json!({"text": note_round2, "images": [], "origin": "runner", "wakeReason": "Codex reviewed the change"}),
        Some("t3"),
    ));
    let mid_round2 = from_events(round2_events.clone());
    let live_round2 = notes_of(&mid_round2);
    assert_eq!(live_round2.len(), 1, "{:?}", ids(&mid_round2));
    assert!(!live_round2[0].0);
    assert_eq!(
        live_round2[0].1.review_note.as_deref().unwrap().findings[0].id,
        3
    );

    let mut round2_done =
        json!({"turnId": "t3", "outcome": "completed", "durationMs": 500, "needs": "nothing"});
    round2_done["review"] = json!({
        "reviewer": "Codex (codex-1)",
        "rounds": 2,
        "threadId": "9a11bc02-0000",
        "passed": true,
        "findings": [
            {"id": 1, "round": 1, "severity": "medium", "claim": "Empty timestamps stop snapshots.", "outcome": "fixed"},
            {"id": 2, "round": 1, "severity": "high", "claim": "Scan misses logs.", "outcome": "disputed", "note": "Swap is watched elsewhere."},
            {"id": 3, "round": 2, "severity": "low", "claim": "Drop unused temp file.", "outcome": "fixed"}
        ]
    });
    round2_events.push(event_turn(
        10,
        "assistant.text",
        json!({"itemId": "m3", "text": "Dropped the temp file."}),
        Some("t3"),
    ));
    round2_events.push(event_turn(11, "turn.completed", round2_done, Some("t3")));

    let mut all_done = from_events(round2_events);
    assert!(
        notes_of(&all_done).is_empty(),
        "both rounds fold into work once done: {:?}",
        ids(&all_done)
    );
    assert!(all_done.row("lr:t3").is_some(), "{:?}", ids(&all_done));
    let group_id = all_done
        .rows()
        .iter()
        .find_map(|r| matches!(r.content, RowContent::Group(_)).then(|| r.id.clone()))
        .expect("a Worked for … group");
    all_done.set_expanded(&group_id, true);
    let expanded_all = notes_of(&all_done);
    assert_eq!(expanded_all.len(), 2, "{:?}", ids(&all_done));
    assert!(expanded_all.iter().all(|(in_group, _)| *in_group));
    assert!(expanded_all.iter().all(|(_, m)| m.review_ledger.is_some()));
}

#[test]
fn a_panels_ledger_names_everyone_and_who_found_each_finding() {
    let review = LabReview::decode(&json!({
        "reviewer": "Gemini (opencode-main), Codex (codex-1), Claude (claude-2)", "independent": true, "rounds": 1, "threadId": "rev-1", "passed": false,
        "panel": [
            {"reviewer": "Gemini (opencode-main)", "threadId": "rev-1", "independent": true},
            {"reviewer": "Codex (codex-1)", "threadId": "rev-2", "independent": true},
            {"reviewer": "Claude (claude-2)", "threadId": "rev-3", "independent": false},
            "not a reviewer"
        ],
        "findings": [
            {"id": 1, "claim": "Drops the session on refresh.", "outcome": "fixed", "by": "Codex (codex-1)"},
            {"id": 2, "claim": "Keeps the old token.", "outcome": "left"}
        ]
    }))
    .unwrap();
    assert_eq!(
        review.panel.as_ref().map(Vec::len),
        Some(3),
        "one that isn't an object is left out"
    );
    assert_eq!(
        review.heading(),
        "Reviewed by Gemini, Codex and a fresh Claude session: 1 open"
    );
    assert_eq!(
        review.found_by(&review.findings[0]).as_deref(),
        Some("Codex"),
        "the login is left off"
    );
    assert_eq!(
        review.found_by(&review.findings[1]),
        None,
        "the runner didn't say"
    );

    // The same provider on two models: the login tells them apart.
    let twins = LabReview::decode(&json!({
        "reviewer": "Gemini (opencode-main), Gemini (opencode-2)",
        "panel": [{"reviewer": "Gemini (opencode-main)", "threadId": "a"}, {"reviewer": "Gemini (opencode-2)", "threadId": "b"}],
        "findings": [{"id": 1, "claim": "x", "by": "Gemini (opencode-2)"}]
    }))
    .unwrap();
    assert_eq!(
        twins.found_by(&twins.findings[0]).as_deref(),
        Some("Gemini (opencode-2)")
    );

    // One reviewer: the heading already names it.
    let one = LabReview::decode(&json!({"reviewer": "Codex (codex-1)", "findings": [{"id": 1, "claim": "x", "by": "Codex (codex-1)"}]})).unwrap();
    assert!(one.panel.is_none());
    assert_eq!(one.found_by(&one.findings[0]), None);
}

/// The review row folds like the line of work: its heading alone, opening
/// to every finding. A finding still open (left for Mike, or not answered)
/// stays in sight while it's folded, as it may need him (Mike, 20 Nov 2026,
/// after a panel's eight answered findings ran a screen tall over the reply
/// that already said what was fixed).
#[test]
fn a_review_row_folds_its_answered_findings_away() {
    let finding = |id: i64, outcome: Option<&str>| {
        let mut f = json!({"id": id, "claim": format!("Finding {id}"), "by": "Codex (codex-1)"});
        if let Some(outcome) = outcome {
            f["outcome"] = json!(outcome);
        }
        f
    };
    let panel = |findings: Vec<Value>| {
        LabReview::decode(&json!({
            "reviewer": "Codex (codex-1), Grok (grok-1)", "threadId": "rev-1",
            "panel": [{"reviewer": "Codex (codex-1)", "threadId": "rev-1"}, {"reviewer": "Grok (grok-1)", "threadId": "rev-2"}],
            "findings": findings
        }))
        .unwrap()
    };
    let claims =
        |shown: Vec<&ReviewFinding>| shown.iter().map(|f| f.claim.clone()).collect::<Vec<_>>();

    // All answered: folded, it's the heading alone; open, every finding.
    let answered = panel(vec![
        finding(1, Some("fixed")),
        finding(2, Some("fixed")),
        finding(3, Some("disputed")),
    ]);
    assert_eq!(
        answered.heading(),
        "Reviewed by Codex and Grok: all answered",
        "the heading is as it was"
    );
    assert!(answered.folds());
    assert!(
        answered.shown_findings(false).is_empty(),
        "folded by default: nothing under the heading"
    );
    assert_eq!(
        claims(answered.shown_findings(true)),
        ["Finding 1", "Finding 2", "Finding 3"]
    );

    // Some still open: folded, still the heading alone, which counts them.
    let mixed = panel(vec![
        finding(1, Some("fixed")),
        finding(2, Some("left")),
        finding(3, None),
        finding(4, Some("disputed")),
    ]);
    assert_eq!(mixed.heading(), "Reviewed by Codex and Grok: 2 open");
    assert!(mixed.folds());
    assert!(
        mixed.shown_findings(false).is_empty(),
        "open findings fold away too (28 Nov)"
    );
    assert_eq!(
        claims(mixed.shown_findings(true)),
        ["Finding 1", "Finding 2", "Finding 3", "Finding 4"],
        "open, in the ledger's order"
    );

    // Every one unanswered: it still folds to the heading (a turn that
    // answered none of nine listed them all over the reply, 28 Nov).
    let open = panel(vec![finding(1, Some("left")), finding(2, None)]);
    assert_eq!(open.heading(), "Reviewed by Codex and Grok: 2 open");
    assert!(open.folds());
    assert!(open.shown_findings(false).is_empty());
    assert_eq!(
        claims(open.shown_findings(true)),
        ["Finding 1", "Finding 2"]
    );
    // None at all: nothing to fold, so no disclosure.
    assert!(!panel(vec![]).folds());
}

#[test]
fn testDoneCardPickOneFollowUpsAndRecommendation() {
    let pick_one_event = event_turn(
        2,
        "turn.completed",
        json!({
            "turnId": "t1",
            "outcome": "completed",
            "durationMs": 1000,
            "needs": "nothing",
            "next": ["Try option A", "Try option B"],
            "nextPick": "one",
            "nextSuggested": 1
        }),
        Some("t1"),
    );
    let model = from_events(vec![
        event_turn(1, "turn.started", json!({"turnId": "t1"}), Some("t1")),
        pick_one_event,
    ]);
    let c = card(&model, "ak:2").expect("done card");
    assert!(c.is_done());
    assert!(c.next_pick_one());
    assert_eq!(c.next_pick.as_deref(), Some("one"));
    assert_eq!(c.next_suggested, Some(1));
    assert_eq!(
        RowDebug::text(model.row("ak:2").unwrap()),
        "open, nothing needed, next (pick one): Try option A; Try option B *"
    );

    // A single item does not enter pick-one mode even if nextPick is "one".
    let single = from_events(vec![
        event_turn(1, "turn.started", json!({"turnId": "t1"}), Some("t1")),
        event_turn(
            2,
            "turn.completed",
            json!({
                "turnId": "t1",
                "outcome": "completed",
                "durationMs": 1000,
                "needs": "nothing",
                "next": ["Only one"],
                "nextPick": "one",
                "nextSuggested": 0
            }),
            Some("t1"),
        ),
    ]);
    let c_single = card(&single, "ak:2").expect("done card");
    assert!(!c_single.next_pick_one());
    assert_eq!(
        RowDebug::text(single.row("ak:2").unwrap()),
        "open, nothing needed, next: Only one"
    );
}
