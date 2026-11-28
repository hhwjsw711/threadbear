Feature: The thread's bar, banners and notes
  As someone working through threads
  I want the title and the thread's actions in its bar, and clear word when something's wrong
  So I always know what's happening

  Background:
    Given the app is connected to a runner with the demo threads

  @header.title
  Scenario: The panel's bar shows the open thread's title
    When I open the thread "Morning brief"
    Then the panel bar's title says "Morning brief"

  @header.title
  Scenario: Clicking the title renames the thread
    When I open the thread "Morning brief"
    And I start renaming the open thread
    Then the panel bar's title is a field
    When I rename the open thread to "Evening brief"
    Then the panel bar's title says "Evening brief"
    And the sidebar lists "Evening brief"

  # The demo's "Draft the release notes" is on the Weekends pool, whose only
  # login is at its limit, so the runner is holding it until there's room.
  # Since 10 Nov this is a box at the top of the message field, which says
  # when it carries on and lets Mike turn that off. Since 12 Nov it asks:
  # Continue now on, with a menu of the logins outside the pool with room.
  # Since 24 Nov that's one Continue now, which opens the model picker on
  # the pool of the login with most room, its logins listed.
  @banner.limit @swift-pending
  Scenario: A pool thread out of room says so, offers to continue now on a login outside the pool, and carries on by itself
    When I open the thread "Draft the release notes for 0.4"
    Then the limit line starts "Every login in Weekends is out of room."
    And the limit line's button says "Continue now"
    And the limit box carries on by itself
    And the model chip is marked "Limit reached"

  @banner.limit @swift-pending
  Scenario: Continue now opens the model picker on the logins with room, and a pick there carries on
    When I open the thread "Draft the release notes for 0.4"
    And I click the limit box's Continue now
    Then its picker lists the "Claude" logins, "alex" among them
    When I pick "alex" from Continue now's picker
    Then the limit box has gone

  @header.backforward
  Scenario: The back and forward buttons say where they go
    When I open the thread "Morning brief"
    And I open the thread "Rename the Settings tabs"
    Then the back button's tip says "Back to Morning brief (⌘[)"
    And the forward button's tip says "Nothing to go forward to (⌘])"

  @header.backforward
  Scenario: Clicking back opens the thread before it
    When I open the thread "Morning brief"
    And I open the thread "Rename the Settings tabs"
    And I click the back button
    Then the open thread is "Morning brief"

  @header.more
  Scenario: The ... menu copies the thread's id
    When I open the thread "Morning brief"
    And I choose Copy thread id from the ... menu
    Then the clipboard holds the open thread's id

  @header.share
  Scenario: Sharing a thread makes a link for it
    When I open the thread "Morning brief"
    And I make a share link for the open thread
    Then the share popover says the thread is shared with a link

  # The relay answers Share for another Mac's thread, and its reply names no
  # runner: stored as it came, the thread turned into one of this Mac's
  # ("Thread not found" on every send), and that Mac's next list, which says
  # nothing of sharing, put the share icon back to Only you (23 Nov review).
  @header.share @remote-threads
  Scenario: Sharing another Mac's thread keeps it on that Mac, shared
    When I open the thread "Check the photo library backup"
    And I make a share link for the open thread
    Then the share popover says the thread is shared with a link
    And the row "Check the photo library backup" is on the runner "On mac-mini"
    And the composer is on the runner "mac-mini"
    When mac-mini lists "Check the photo library backup" again
    Then the share button stays lit
    And the share popover says the thread is shared with a link
    And the row "Check the photo library backup" is on the runner "On mac-mini"

  # The Swift app's is an NSPopover, which closes on Escape by itself; its
  # script can't press a key into one.
  @header.share @swift-pending
  Scenario: Escape closes the share popover
    When I open the thread "Morning brief"
    And I click the share button
    Then the share popover is open
    When I press Escape
    Then the share popover is closed

  @banner.error
  Scenario: An error shows in a bar until it's dismissed
    When an error "Thread not found" happens
    Then the error bar says "Thread not found"
    When I dismiss the error bar
    Then there's no error bar

  @banner.connection
  Scenario: Losing the runner shows a banner until it's back
    When I open the thread "Morning brief"
    And the runner restarts
    Then the banner says the runner is restarting or reconnecting
    And there's no banner once the runner is back

  @toast.archived
  Scenario: Archiving a thread shows a note with Undo
    When I open the thread "Morning brief"
    And I archive the open thread
    Then the Archived note names "Morning brief"
    When I press Undo on the Archived note
    Then there's no Archived note
    And the "Inbox" section lists "Morning brief"
    And the open thread is "Morning brief"

  @toast.archived
  Scenario: Clicking the Archived note opens the thread in the Archived section
    When I open the thread "Morning brief"
    And I archive the open thread
    And I click the Archived note
    Then the open thread is "Morning brief"
    And the "Archived" section lists "Morning brief"

  @toast.archived @swift-pending
  Scenario: The Archived note's x puts it away, leaving the thread archived
    When I open the thread "Morning brief"
    And I archive the open thread
    And I dismiss the Archived note
    Then there's no Archived note
    And the "Archived" section lists "Morning brief"

  # ⌘Z outside a text box is bound on a Mac only: elsewhere it would be
  # Ctrl+Z, which a terminal panel needs for itself (window_menu.rs).
  @toast.archived @swift-pending @linux-pending @windows-pending
  Scenario: ⌘Z brings back the last thread archived, after its note has gone
    When I open the thread "Morning brief"
    And I archive the open thread
    And I dismiss the Archived note
    And I press ⌘Z
    Then the "Inbox" section lists "Morning brief"
    And the open thread is "Morning brief"

  @toast.archived @swift-pending @linux-pending @windows-pending
  Scenario: ⌘Z brings archived threads back newest first
    When I open the thread "Morning brief"
    And I archive the open thread
    And I open the thread "Make a poster for the meetup"
    And I archive the open thread
    And I press ⌘Z
    Then the "Inbox" section lists "Make a poster for the meetup"
    And the "Archived" section lists "Morning brief"
    When I press ⌘Z
    Then the "Inbox" section lists "Morning brief"

  @toast.archived @swift-pending
  Scenario: ⌘Z in a message box with words in it is for the words
    When I open the thread "Morning brief"
    And I archive the open thread
    And I type "half a thought" in the composer, replacing what's there
    And I press ⌘Z
    Then the "Archived" section lists "Morning brief"

  @toast.inboxend
  Scenario: Next Inbox Thread says when the inbox has run out
    When I open the last thread in the Inbox
    And I press "down" with "cmd,opt"
    Then a note says I've reached the end of the inbox

  @header.schedulechip
  Scenario: The Scheduled chip says when its schedule runs, and opens it in the editor
    When I open the thread "Export last quarter's invoices as CSV"
    And I click the header's Scheduled chip for "Quarterly invoice export"
    Then the schedule editor is open on "Export last quarter's invoices as CSV for the accountant." repeating on "0 8 1 1,4,7,10 *"

  # The mock refuses a message saying "mock refusal" as Claude's safeguards
  # do. The offer sits just above the box (RefusalOffer in ComposerView), not
  # over the transcript at the top; the Swift dump has no "offerAbove".
  @banner.refusal @swift-pending
  Scenario: A refused message offers to carry on with Codex just above the box
    When I open the thread "Morning brief"
    And I send "mock refusal please"
    Then the box has "Continue with Codex Sol" just above it
