Feature: The chips under the message box
  As someone choosing how a thread runs
  I want the model, access and folder right where I type
  So I can change them without leaving the box

  Background:
    Given the app is connected to a runner with the demo threads
    And I open the thread "Morning brief"

  @composer.permission
  Scenario: The permission chip says how the thread runs and changes it
    Then the "permission" menu shows "Full access" ticked
    When I pick "Ask before edits" from the "permission" menu
    Then the composer's permission mode is "ask"
    And the "permission" menu shows "Ask before edits" ticked

  @composer.modelpicker
  Scenario: The model picker lists the models, marking the default
    Then the "model" menu has a row "[x] Fable 5.1 *"
    And the "model" menu has a row "[ ] Opus 5.5"
    And the model chip says "Claude · Fable 5.1"

  @composer.modelpicker
  Scenario: Picking a model changes the chip
    When I pick "Opus 5.5" from the "model" menu
    Then the model chip says "Claude · Opus 5.5"

  # Return in the search picks the first model it lists (the Swift search's
  # onSubmit). The Swift app does this, but its automation, frozen since 12
  # Nov, can't type in the popover's search, so it's pending there.
  @composer.modelpicker @swift-pending
  Scenario: Return in the model picker's search picks the first match
    When I open the model picker
    And I search the model picker for "opus" and press Return
    Then the model chip says "Claude · Opus 5.5"

  @composer.modelpicker
  Scenario: Picking an effort level changes the chip
    When I pick "High" from the "model" menu
    Then the model chip says "Claude · Fable 5.1 · High"

  # A pool with logins of several providers lists each one's models under
  # its name (the Swift picker's sections). The GPUI picker showed only the
  # first login's provider until 20 Nov, so OpenCode's Gemini models in
  # Mike's Main pool were nowhere to be picked.
  @composer.modelpicker
  Scenario: A pool of Codex and Claude logins lists both providers' models
    Then the "model" menu has a row "## Codex"
    And the "model" menu has a row "## Claude"

  # Pool strip across the top, provider rail down the left, models on the right
  # (Mike's pick, Option A, 26 Nov): the Swift app is frozen.
  @composer.modelpicker @swift-pending
  Scenario: Picking a pool, then a provider, then a model switches the thread
    When I open the model picker
    And I click "Pool: Personal" in the model picker
    And I click "Provider: Codex" in the model picker
    And I click "GPT-6.1-Sol" in the model picker
    Then the model chip says "Personal · GPT-6.1-Sol"

  # Logins not in any pool get a "No pool" tab at the end of the pool strip
  # (Mike's pick, Option A, 26 Nov): the Swift app is frozen.
  @composer.modelpicker @swift-pending
  Scenario: The No pool tab lets a thread pick models on logins outside any pool
    Given the runner also has logins outside any pool
    When I open the model picker
    And I click "Pool: No pool" in the model picker
    And I click "Opus 5.5" in the model picker
    Then the model chip says "solo-high · Opus 5.5"
    And the "model" menu has a row "# [x] No pool"
    And the "model" menu has a row "--- Login: solo-high (not in a pool)"
    And the "model" menu has a row "[x] solo-high"
    And the "model" menu has a row "[ ] solo-low"
    And the "model" menu has no row "[ ] Auto"
    And the "model" menu has no row "[x] Auto"
    When I pick "Login: solo-low" from the "model" menu
    Then the model chip says "solo-low · Opus 5.5"
    And the "model" menu has a row "--- Login: solo-low (not in a pool)"
    When I open the model picker
    And I click "Provider: Codex" in the model picker
    And I click "GPT-6.1-Sol" in the model picker
    Then the model chip says "Codex solo-codex · GPT-6.1-Sol · Low"
    When I open the model picker
    And I click "Pool: Personal" in the model picker
    And I click "Provider: Codex" in the model picker
    And I click "GPT-6.1-Sol" in the model picker
    Then the model chip says "Personal · GPT-6.1-Sol · Low"

  # Per-model effort levels on Gemini and OpenCode, and no effort bar on a
  # model that omits them when sibling models list them (26 Nov): Swift is frozen.
  @composer.modelpicker @swift-pending
  Scenario: The model picker shows each Gemini and OpenCode model's effort levels, and hides them when a model has none
    Given the runner also has a Gemini login and an OpenCode login
    When I open the model picker
    And I click "Pool: No pool" in the model picker
    And I click "Provider: Gemini" in the model picker
    And I click "Gemini 4 Neon" in the model picker
    Then the model chip says "Gemini · Gemini 4 Neon · High"
    And the "model" menu has a row "[x] High"
    And the "model" menu has a row "[ ] Extra high"
    When I pick "Low" from the "model" menu
    Then the model chip says "Gemini · Gemini 4 Neon · Low"
    When I open the model picker
    And I click "Gemini 3.8 Flash" in the model picker
    Then the "model" menu has a row "[x] Low"
    And the "model" menu has a row "[ ] High"
    And the "model" menu has no row "[ ] Extra high"
    And the "model" menu has no row "[x] Extra high"
    When I open the model picker
    And I click "Provider: OpenCode" in the model picker
    And I click "GPT-6 Astra" in the model picker
    Then the "model" menu has a row "[ ] High"
    When I open the model picker
    And I click "Big Pickle" in the model picker
    Then the "model" menu has no row "[ ] High"
    And the "model" menu has no row "[x] High"

  # The Login line under the effort levels (Mike's pick, 12 Nov): the Swift
  # app is frozen with its "Pinned to … · Unpin" line, so these are GPUI's.
  @composer.modelpicker @swift-pending
  Scenario: A thread pinned to a login says so in the model picker, and Auto hands it back to a pool
    When I open the thread "Compare SQLite and plain files for the runner"
    Then the "model" menu has a row "# Pinned to alex+3"
    And the "model" menu has a row "--- Login: alex+3"
    And the "model" menu has a row "[x] alex+3"
    When I pick "Login: Auto" from the "model" menu
    Then the "model" menu has no row "--- Login: alex+3"
    And the "model" menu has a row "--- Login: Auto"
    And the "model" menu has a row "[x] Auto - The pool picks"

  @composer.modelpicker @swift-pending
  Scenario: A pool thread's Login line says Auto, and picking a login pins the thread to it
    Then the "model" menu has a row "--- Login: Auto"
    And the "model" menu has a row "[x] Auto - The pool picks, and moves on when one runs out"
    And the "model" menu has a row "[ ] alex+3"
    When I pick "Login: alex+3" from the "model" menu
    Then the "model" menu has no row "--- Login: Auto"
    And the "model" menu has a row "--- Login: alex+3"
    And the "model" menu has a row "[x] alex+3"
    And the "model" menu has a row "# Pinned to alex+3"

  # A login, pool or folder change can't be guessed, so the chip that shows it
  # spins and takes no clicks until the runner has made it (the every-click
  # rule). The Swift app spins them too (ComposerChip.busy), but its dump,
  # frozen since 12 Nov, doesn't say so.
  @composer.modelpicker @swift-pending
  Scenario: The model chip spins until a pool change lands
    Given the runner takes its time to change threads
    When I open the thread "Compare SQLite and plain files for the runner"
    And I pick "Unpin" from the "model" menu
    Then the composer's "model" chip is spinning
    And soon no chip in the composer is spinning

  @composer.plus @swift-pending
  Scenario: "+" spins until a folder change lands
    Given the runner takes its time to change threads
    When I pick another folder from the "+" menu
    Then the composer's "plus" chip is spinning
    And soon no chip in the composer is spinning
    And the "+" menu has that folder ticked

  # A thread in a narrow panel: the chips' titles give way, ending "…", and
  # Send stays inside the box. The Swift dump has no "chipsFit".
  @composer.modelpicker @swift-pending
  Scenario: In a narrow box the chips shrink to fit, and Send stays inside it
    When I open the thread "Compare SQLite and plain files for the runner"
    And the window is 560 points wide
    Then the chips under the box fit inside it

  # Without pools there's a login chip: another Mac's thread, as mac-mini has none.
  @composer.account @remote-threads
  Scenario: The login picker groups the logins by provider, with the room each has left
    When I open the thread "Check the photo library backup"
    Then the "account" menu has a row "# Claude"
    And the "account" menu has a row "[x] alex@example.com - week 78%, resets"
    And the "account" menu has a row "# Codex"
    And the "account" menu has a row "[ ] alex@example.com - week 64%, resets"
    And the "account" menu has a row "--- Usage from Token Stats at"

  @composer.schedulefromsend
  Scenario: Right-clicking Send offers to send the message later
    When I type "Check the backups tonight" in the composer
    Then right-clicking Send offers "Schedule…"
    When I right-click Send and choose "Schedule…"
    Then the schedule editor is open on a new schedule that sends "Check the backups tonight"

  # The arrow beside Send and its quick times are the GPUI app's; the Swift
  # app is frozen.
  @composer.schedulefromsend @swift-pending
  Scenario: The arrow beside Send offers quick times to send the message later
    When I open the Send later menu beside Send
    Then the Send later menu offers "Send tomorrow at 9 am…" and a time for when tokens reset

  @composer.schedulefromsend @swift-pending
  Scenario: Send tomorrow opens the schedule editor on Once, at 9 tomorrow morning
    When I type "Check the backups tomorrow" in the composer
    Then right-clicking Send offers "Send tomorrow at 9 am… | Schedule…"
    When I right-click Send and choose "Send tomorrow at 9 am…"
    Then the schedule editor is open on a new schedule that sends "Check the backups tomorrow"
    And the schedule is set to send once, tomorrow at 9 am

  # Morning brief is on the Claude pool, whose alex+4 is out of room until
  # its 5-hour window resets; the others have room or old readings.
  @composer.schedulefromsend @swift-pending
  Scenario: Send when tokens reset waits for the pool's first login back, plus a minute
    When I type "Run the checks after my allowance resets" in the composer
    And I choose when tokens reset from Send's right-click
    Then the schedule editor is open on a new schedule that sends "Run the checks after my allowance resets"
    And the schedule is set to send once, a minute after "claude-4"'s 5-hour window resets

  @composer.schedulefromsend @swift-pending
  Scenario: A quick time from the new-thread box saves a schedule that starts a new thread
    When I start a new thread
    And I type "Review tomorrow's build" in the composer
    And I right-click Send and choose "Send tomorrow at 9 am…"
    And I save the schedule in the editor
    And I click "Scheduled" in the activity bar
    Then the "Active" section lists "Review tomorrow's build"
    And the schedule "Review tomorrow's build" sends to "New thread in misc"

  @composer.schedulefromsend @remote-threads
  Scenario: Another Mac's thread has no Schedule… on Send, as its schedules are made there
    When I open the thread "Check the photo library backup"
    And I type "Check it again" in the composer
    Then right-clicking Send doesn't offer "Schedule…"

  @composer.contextring
  Scenario: The context ring says how full the thread is
    When I open the thread "Make uploads resume after a crash"
    Then the "context" menu says "642k of 1M tokens" and "64%"

  @composer.contextring
  Scenario: The context ring's popover says what fills a Claude thread's context
    When I open the thread "Make uploads resume after a crash"
    And I open the context ring's popover
    Then the context popover shows "64% used 642k / 1M"
    And the context popover shows "Messages 610k 61%"
    And the context popover shows "MCP tools (deferred) 173k"
    And the context popover shows "Breakdown from just now"

  # A picture's chip among the words, and its thumbnail over them, open the
  # picture as one in the transcript does: Quick Look in the Swift app, the
  # app's own viewer in GPUI, stepping through the box's other pictures. The
  # GPUI app's click on a thumbnail also checks its × is in its top right
  # corner while the pointer's on it (12 Nov).
  @composer.chiphover
  Scenario: Clicking a picture's chip opens it, among the box's other pictures
    When I paste the picture into the composer
    And I paste the picture into the composer
    And the composer holds 2 pictures
    Then clicking chip 2 opens picture 2 of 2

  @composer.chiphover
  Scenario: Clicking a picture's thumbnail over the box opens it
    When I paste the picture into the composer
    And I paste the picture into the composer
    And the composer holds 2 pictures
    Then clicking the thumbnail of picture 1 opens picture 1 of 2

  @composer.chiphover @swift-pending
  Scenario: Many pictures wrap onto more rows, and the last one can still be opened
    When the window is 1000 points wide
    And I paste the picture into the composer 8 times
    And the composer holds 8 pictures
    Then clicking the thumbnail of picture 8 opens picture 8 of 8

  # The × over a thumbnail is an edit ⌘Z takes back, and the chip it brings
  # back has to bring its picture: it came back empty, and the message then
  # went without the picture (Codex's review of the ⌘Z fix, 18 Nov).
  @composer.picturechips @swift-pending
  Scenario: Undoing a picture's × brings the picture back with its chip
    When I type "Look at this" in the composer
    And I paste the picture into the composer
    And the composer holds 1 picture
    And I remove picture 1 with its ×
    Then the composer holds 0 pictures
    When I put the cursor in the composer
    And I press ⌘Z
    Then the composer holds 1 picture
