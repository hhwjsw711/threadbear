Feature: Spelling in the message box
  As someone who types and dictates into the message box all day
  I want misspelled words marked and fixed the way any Mac text box does it
  So my messages say what I meant

  # The Mac's own spell checker, which the app doesn't have on Windows or
  # Linux. The Swift app's NSTextView did all of this, but its script has no
  # command to read the marks or the right-click menu, and that app is frozen.

  Background:
    Given the app is connected to a runner with the demo threads
    And I open the thread "Morning brief"

  @composer.spelling @swift-pending @windows-pending @linux-pending
  Scenario: A misspelled word is marked once it's typed, not while it is
    When I type "I saw teh catt" in the composer
    Then the composer marks only "teh" as misspelled

  @composer.spelling @swift-pending @windows-pending @linux-pending
  Scenario: The right-click menu offers the spell checker's guesses
    When I type "I saw teh cat" in the composer
    Then the composer's right-click menu on "teh" offers "the"
    When I choose "the" from the composer's right-click menu on "teh"
    Then the composer says "I saw the cat"

  # Mike, 20 Nov: "jank" came out as "tank". Correction is off until it's
  # switched on in this menu, whatever the Mac's Keyboard settings say.
  @composer.spelling @swift-pending @windows-pending @linux-pending
  Scenario: A misspelled word is left as typed while correction is off
    Given "Spelling and Grammar › Correct Spelling Automatically" is not ticked in the composer's right-click menu
    When I type "in the begining" in the composer
    And I type " " in the composer
    Then the composer says "in the begining "

  # Not "teh" or "recieve" in the three below: until 20 Nov the scripted app
  # told the Mac's checker about every correction these scenarios took back,
  # which it remembers for good, so Tinker Desk stopped correcting both words
  # and all three failed there. The scripted app no longer tells it.
  @composer.spelling @swift-pending @windows-pending @linux-pending
  Scenario: A misspelled word is corrected as the next word starts
    Given "Spelling and Grammar › Correct Spelling Automatically" is ticked in the composer's right-click menu
    When I type "I beleive" in the composer
    And I type " " in the composer
    Then the composer says "I believe "

  # Wayne's recording (17 Nov): the Mac's checker turned "threadbear" into
  # "threadbare" every time it was typed.
  @composer.spelling @swift-pending @windows-pending @linux-pending
  Scenario: The app's own name is never corrected or marked
    Given "Spelling and Grammar › Correct Spelling Automatically" is ticked in the composer's right-click menu
    When I type "I use threadbear" in the composer
    And I type " " in the composer
    Then the composer says "I use threadbear "
    And the composer marks nothing as misspelled

  @composer.spelling @swift-pending @windows-pending @linux-pending
  Scenario: A correction put back with Undo isn't made again
    Given "Spelling and Grammar › Correct Spelling Automatically" is ticked in the composer's right-click menu
    When I type "I beleive" in the composer
    And I type " " in the composer
    Then the composer says "I believe "
    When I undo in the composer
    Then the composer says "I beleive "
    When I type "beleive" in the composer, replacing what's there
    And I type " " in the composer
    Then the composer says "beleive "

  # Its own word: one put back stays put back while the app runs, and the
  # scenario before this one puts back "beleive" in the same app.
  @composer.spelling @swift-pending @windows-pending @linux-pending
  Scenario: A correction typed back over isn't made again
    Given "Spelling and Grammar › Correct Spelling Automatically" is ticked in the composer's right-click menu
    When I type "its definately" in the composer
    And I type " " in the composer
    Then the composer says "its definitely "
    When I press Backspace 6 times on the keyboard
    And I type "ately" in the composer
    And I type " " in the composer
    Then the composer says "its definately "

  @composer.spelling @swift-pending @windows-pending @linux-pending
  Scenario: Transformations change the word the cursor is in
    When I type "make it loud" in the composer
    And I choose "Transformations › Make Upper Case" from the composer's right-click menu on "loud"
    Then the composer says "make it LOUD"

  @composer.spelling @swift-pending @windows-pending @linux-pending
  Scenario: The right-click menu has NSTextView's submenus
    When I type "hello" in the composer
    Then the composer's right-click menu on "hello" has "Cut | Copy | Paste | Spelling and Grammar › Check Document Now | Spelling and Grammar › Check Spelling While Typing | Substitutions › Smart Quotes | Substitutions › Text Replacement | Transformations › Capitalize | Speech › Start Speaking"

  # Seed 15009 (26 Nov): a thread chip, a spelling mark and multi-byte text
  # in the composer crashed layout_token_lines when typing shifted the mark's
  # byte offset into the middle of a multi-byte character.
  @composer.spelling @composer.threadpicker @swift-pending @windows-pending @linux-pending
  Scenario: Typing multi-byte text before a spelling mark beside a chip stays responsive
    When I type "#keep" in the composer
    And I press Return
    And I type "日本語 teh " in the composer
    Then the composer marks only "teh" as misspelled
    When I press "left" with "cmd"
    And I type "a 日本語のテキスト" in the composer
    Then the composer says "a 日本語のテキスト[Stop Keep Awake asking for my password](thread:demo_keep_awake) 日本語 teh "
