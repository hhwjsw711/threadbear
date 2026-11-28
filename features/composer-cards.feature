Feature: The open card in the composer
  As someone an agent has finished for, or is waiting on
  I want its asks and follow-ups in the box I answer in
  So answering is one move, not a hunt through the transcript

  Background:
    Given the app is connected to a runner with the demo threads

  @card.needsyou
  Scenario: A card of asks sits in the composer
    When I open the thread "Ship the beta to TestFlight"
    Then the card in the composer says "Needs you"
    And the card in the composer asks "1. Accept the new agreement in App Store Connect"
    And the card in the composer asks "2. Check who gets the beta"

  @card.answers
  Scenario: A picked answer waits, then goes with the message
    When I open the thread "Ship the beta to TestFlight"
    And I pick answer 1 of ask 1 on the card
    Then ask 1 on the card is answered "done"
    When I send my picks
    Then the transcript shows my message "1. Accept the new agreement in App Store Connect"

  @card.somethingelse @card.answers
  Scenario: Something else takes my own words for an ask
    When I open the thread "Ship the beta to TestFlight"
    And I write "Just the internal testers" as my own answer to ask 2
    Then ask 2 on the card is answered "something else: \"Just the internal testers\""
    When I send my picks
    Then the transcript shows my message "2. Check who gets the beta"

  @card.somethingelse @swift-pending @windows-pending @linux-pending
  Scenario: A click gets back into a Something else box after the message box had the cursor
    When I open the thread "Ship the beta to TestFlight"
    And I pick answer 0 of ask 1 on the card
    And I type "Also" in the composer
    And I click into the Something else box of ask 1
    And I type "Accepted it already" where the cursor is
    Then ask 1 on the card is answered "something else: \"Accepted it already\""

  @card.somethingelse @swift-pending @windows-pending @linux-pending
  Scenario: Through AppKit, a click gets back into a Something else box after the message box had the keyboard
    When I open the thread "Ship the beta to TestFlight"
    And I pick answer 0 of ask 1 on the card
    And I type "maybe" on the keyboard
    And I press Backspace 5 times on the keyboard
    And I type "" in the composer
    And I type "Also" on the keyboard
    And I click into the Something else box of ask 1 through AppKit
    And I type "accepted" on the keyboard
    Then ask 1 on the card is answered "something else: \"accepted\""

  @card.returnflow
  Scenario: Return with picks and an ask still open goes no further
    When I open the thread "Ship the beta to TestFlight"
    And I pick answer 1 of ask 1 on the card
    And I press Return
    Then the card in the composer asks "1. Accept the new agreement in App Store Connect"
    And the transcript doesn't show my message "1. Accept the new agreement in App Store Connect"

  @card.returnflow
  Scenario: Return with every ask answered sends them
    When I open the thread "Ship the beta to TestFlight"
    And I pick answer 1 of ask 1 on the card
    And I write "Just the internal testers" as my own answer to ask 2
    And I press Return
    Then the transcript shows my message "1. Accept the new agreement in App Store Connect"

  @card.collapse
  Scenario: The card can fold to its heading
    When I open the thread "Ship the beta to TestFlight"
    And I press "collapse" on the card
    Then the card in the composer says "Needs you (collapsed)"

  @card.done
  Scenario: A done card offers the agent's follow-ups
    When I open the thread "Tidy the imports in the uploader"
    Then the card in the composer says "Done"
    And the card offers the follow-up "Turn on the lint rule that sorts imports"

  @card.done @card.answers
  Scenario: Ticked follow-ups go when I send
    When I open the thread "Tidy the imports in the uploader"
    And I tick follow-up 1 on the card
    Then the follow-up "Turn on the lint rule that sorts imports" is ticked
    When I press Return
    Then the transcript shows my message "Turn on the lint rule that sorts imports"

  # The runner's loose-ends check (protocol "Loose ends") comes on the
  # thread's summary: the GPUI app dropped it, so its done card never said
  # "Still open" when the Swift app's did (12 Nov).
  # Experiment inboxGuess (docs/protocol/threads.md, "Inbox guess"): the GPUI app
  # only. The Swift app is frozen and archives straight off.
  @card.done @planned.exp.inboxguess @inbox-guess @swift-pending
  Scenario: Archive on the done card asks whether I needed to see the thread
    When I open the thread "Tidy the imports in the uploader"
    And I press "archive" on the card
    Then the Archive menu offers "Didn't need this | Glad I saw this | Not sure"
    And the "Inbox" section lists "Tidy the imports in the uploader"
    When I pick "Didn't need this" from the Archive menu
    Then the "Archived" section lists "Tidy the imports in the uploader"
    And the runner was told I archived "Tidy the imports in the uploader" as "didntNeedToSee"

  @card.done @planned.exp.inboxguess @swift-pending
  Scenario: Without the experiment, Archive on the done card archives straight off
    When I open the thread "Tidy the imports in the uploader"
    And I press "archive" on the card
    Then the "Archived" section lists "Tidy the imports in the uploader"
    And the runner was told I archived "Tidy the imports in the uploader" as ""

  # 26 Nov: an archived thread's done card still offered Archive.
  @card.done @swift-pending
  Scenario: An archived thread's done card offers Back to Inbox
    When I open the thread "Tidy the imports in the uploader"
    And I archive the open thread
    And I click the Archived note
    Then the open thread is "Tidy the imports in the uploader"
    And the done card's button is "Unarchive this thread"
    When I press "archive" on the card
    Then the "Inbox" section lists "Tidy the imports in the uploader"
    And the done card's button is "Archive this thread"

  @card.done @planned.exp.looseends
  Scenario: A done card lists what the runner found still open
    Given the runner found "4 commits it made in convex-native-v7 aren't pushed" still open on "Tidy the imports in the uploader"
    When I open the thread "Tidy the imports in the uploader"
    Then the card in the composer says "Done"
    And the done card lists "4 commits it made in convex-native-v7 aren't pushed" as still open

  @planned.exp.looseends
  Scenario: What's still open follows the runner's check while the thread is open
    When I open the thread "Tidy the imports in the uploader"
    Then the card in the composer says "Done"
    When the runner finds "1 commit on thread/tidy isn't on main" still open on "Tidy the imports in the uploader"
    Then the done card lists "1 commit on thread/tidy isn't on main" as still open
    When the runner finds nothing left open on "Tidy the imports in the uploader"
    Then the done card lists nothing as still open

  # The Swift app swaps in the re-read list on reconnecting and resubscribes
  # an open transcript without handing it the summary's new loose ends
  # (AppModel+Connection, 12 Nov); frozen, so it stays pending there.
  @planned.exp.looseends @swift-pending
  Scenario: A check that finished while the app was away shows once it's back
    When I open the thread "Tidy the imports in the uploader"
    And the runner finds "2 files in the worktree aren't committed" still open on "Tidy the imports in the uploader" without saying so
    And the runner restarts
    Then the app is connected again
    And the done card lists "2 files in the worktree aren't committed" as still open

  @card.review @swift-pending
  Scenario: Another lab's findings show in the transcript, not on the done card
    When I open the thread "Tidy the imports in the uploader"
    And the agent there finishes a turn another lab reviewed
    Then the card in the composer says "Done"
    And the transcript's review line says "Reviewed by Codex: 1 open"
    And the card doesn't show "Reviewed by"
    # Folded to its heading as the line of work is, open findings too (28 Nov).
    And the transcript's review line is folded
    When I open the transcript's review line
    Then the transcript's review line is open
    And the transcript's review line says "#1 fixed: Drops the session on refresh."

  @card.collapse
  Scenario: Folded, the card's picks show as chips over the box, and one can be taken back
    When I open the thread "Ship the beta to TestFlight"
    And I pick answer 1 of ask 1 on the card
    And I press "collapse" on the card
    Then the box shows the picked answers "1: done"
    When I take the picked answer back
    Then the box shows no picked answers
    And the transcript doesn't show my message "1. Accept the new agreement in App Store Connect"

  @card.somethingelse
  Scenario: A picture put in a Something else box goes with that answer
    When I open the thread "Ship the beta to TestFlight"
    And I write "Like this one" as my own answer to ask 2
    And I put the picture in my own answer to ask 2
    Then ask 2 on the card is answered with 1 picture
    When I send my picks
    Then the transcript shows my message "2. Check who gets the beta" with the chip "picture: Picture 1"

  # Through the answer's own button, which moves a paged card on to the
  # next ask, so Return finds the one still open already in front.
  @card.returnflow
  Scenario: Return beeps when the ask still open is the one in front
    When I open the thread "Ship the beta to TestFlight"
    And I press answer 1 of ask 1 on the card
    And the card has had a moment to move on
    And I press Return
    Then the app beeps

  # docs/guide.md promises a peek "in a reply or on a Needs you card's
  # buttons". The Swift app shows it too (RowRenderer's AskButton peek), but
  # its `ask` has no way to rest on one.
  @card.needsyou @rich.linkpeek @swift-pending
  Scenario: Resting on a card's link button shows where it goes
    When I open the thread "Morning brief"
    And I send "decisions"
    Then the card in the composer says "Needs you"
    When I rest on link 1 of ask 1 on the card
    Then the card shows the peek "See the list of repos | github.com/alex-example?tab=repositories"
