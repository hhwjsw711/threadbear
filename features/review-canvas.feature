Feature: The review as a canvas
  As someone an agent shows design options to
  I want them laid out on a board I can drag and zoom, with the agent's notes on the pictures
  So I can see what it means, mark the parts I want to talk about, and say so

  # The standard GPUI review board; the Swift app is frozen.
  # Mike, 22 Nov 2026, after an audit of how
  # other apps show options with several pictures, picked the board with the
  # agent's tour from three mockups, the agent's notes in the Convex Explained
  # doodle style with a switch to hide them, and tools to circle, highlight or
  # pin a part that drop numbered chips in the reply. The demo review's option
  # A has two of the agent's notes on its picture and a second page with one
  # more (the mock's addCanvasMarks).
  Background:
    Given the app is connected to a runner with the demo threads
    When I open the thread "Compare account picker designs"

  @review.canvas @swift-pending
  Scenario: The review opens as a board, on the agent's lead and the first option
    When I open the review
    Then the review is a board on stop 1 of 7
    And the board has 3 of the agent's notes, showing

  @review.canvas @swift-pending
  Scenario: Next flies through every picture in the agent's order, then everything
    When I open the review
    And I press "Next (→)" in the review
    Then the review is a board on stop 2 of 7
    When I press "See everything (0)" in the review
    Then the review is a board on stop 7 of 7

  @review.canvas @swift-pending
  Scenario: The notes switch hides the agent's notes
    When I open the review
    And I press "Hide the agent's notes (N)" in the review
    Then the board's notes are hidden

  @review.canvas @swift-pending
  Scenario: A part circled on a picture is a chip in the reply and goes to the agent
    When I open the review
    And I circle a part of option A's picture on the board
    Then the board has my mark "1 circle A 0"
    And the review's reply is "[Mark 1]"

  # Mike, 23 Nov: a click in the reply box under its first line left no
  # cursor and no blue edge, as the window took the keys straight back.
  @review.canvas @swift-pending
  Scenario: A click anywhere in the reply box puts the cursor in it
    When I open the review
    And I click low in the review's reply box
    Then the review's reply box has the keys

  # Mike, 24 Nov 2026: comparing music beds, each option a clip, a
  # double-click took him off the board to the stage to hear one. A clip or
  # a sound now plays where it sits, with its sound and controls, one at a time.
  @review.canvas @review.media @swift-pending @windows-pending @linux-pending
  Scenario: A clip plays where it sits on the board
    Given the agent shows options with several shots each
    When I open that review
    And the board flies to option "C"
    And I press "Play C. Account pools here" on the board
    Then the board plays a clip in place
    When I press "Stop C. Account pools" on the board
    Then nothing plays on the board

  # A sound is its waveform with the pane's play bar along its bottom,
  # started by Play (on the stage it waits, paused, as you step through).
  @review.canvas @review.media @swift-pending @windows-pending @linux-pending
  Scenario: A sound plays where it sits on the board
    Given the agent shows options with several shots each
    When I open that review
    And the board flies to option "B", shot 3
    And I press "Play B. One picker, shot 3 here" on the board
    Then the board plays a sound in place
    When I press "Stop B. One picker, shot 3" on the board
    Then nothing plays on the board

  @review.canvas @review.nav @swift-pending
  Scenario: The board visits every page before the next option
    Given the agent shows options with several shots each
    When I open that review
    And the board flies to option "A"
    Then the board frames option "A", shot 1
    When I press "Next (→)" in the review
    Then the board frames option "A", shot 2
    When I press "Next (→)" in the review
    Then the board frames option "A", shot 3
    When I press "Next (→)" in the review
    Then the board frames option "B", shot 1
    When I press "Back (←)" in the review
    Then the board frames option "A", shot 3

  @review.canvas @review.nav @swift-pending
  Scenario: Arrow keys move between pages and options on the board
    Given the agent shows options with several shots each
    When I open that review
    And the board flies to option "A"
    And I press the "right" key in the review
    Then the board frames option "A", shot 2
    When I press the "down" key in the review
    Then the board frames option "B", shot 1
    When I press the "escape" key in the review
    Then the review is a board on stop 11 of 11


  @review.canvas @review.media @swift-pending @web-runtime @windows-pending @linux-pending
  Scenario: HTML stays a snapshot until Interact and marking restores it
    Given the web runtime is installed
    And the agent shows options with several shots each
    When I open that review
    And the board flies to option "B", shot 2
    Then nothing plays on the board
    When I press "Interact with B. One picker, shot 2 here, sealed and offline" on the board
    Then the board runs HTML in place
    When I press "Circle a part (O)" on the board
    Then nothing plays on the board


  @review.canvas @review.media @swift-pending
  Scenario: Double-clicking HTML only looks closer and keeps its marks
    Given the agent shows options with several shots each
    When I open that review
    And I double-click HTML option "B", shot 2 on the board
    Then nothing plays on the board

  @review.canvas @review.media @swift-pending @web-runtime @windows-pending @linux-pending
  Scenario: HTML interaction scales with the card and stops before navigation
    Given the web runtime is installed
    And the agent shows options with several shots each
    When I open that review
    And the board flies to option "B", shot 2
    And I press "Interact with B. One picker, shot 2 here, sealed and offline" on the board
    Then the board runs HTML in place
    And the live HTML keeps a desktop CSS viewport as the card scales
    When I press the "escape" key in the review
    Then nothing plays on the board
    When I press "Interact with B. One picker, shot 2 here, sealed and offline" on the board
    Then the board runs HTML in place
    When I press "Next (→)" in the review
    Then nothing plays on the board
    When the board flies to option "B", shot 2
    And I press "Interact with B. One picker, shot 2 here, sealed and offline" on the board
    Then the board runs HTML in place
    When the board flies to option "A"
    Then nothing plays on the board
    When the board flies to option "B", shot 2
    And I press "Interact with B. One picker, shot 2 here, sealed and offline" on the board
    Then the board runs HTML in place
    When I press "See everything (0)" in the review
    Then nothing plays on the board


  @review.canvas @review.media @swift-pending @web-runtime @windows-pending @linux-pending
  Scenario: Live HTML keeps native editing shortcuts and Stop returns the keys
    Given the web runtime is installed
    And the agent shows options with several shots each
    When I open that review
    And the board flies to option "B", shot 2
    And I press "Interact with B. One picker, shot 2 here, sealed and offline" on the board
    Then the board runs HTML in place
    And HTML input owns editing shortcuts and Stop returns the keyboard


  @review.canvas @review.media @swift-pending @web-runtime @windows-pending @linux-pending
  Scenario: A changed HTML file stops with a media notice that survives polling
    Given the web runtime is installed
    And the agent shows options with several shots each
    When I open that review
    And the board flies to option "B", shot 2
    And I press "Interact with B. One picker, shot 2 here, sealed and offline" on the board
    Then the board runs HTML in place
    And changing the HTML leaves a persistent dismissible media notice

  @review.canvas @review.media @swift-pending @windows-pending @linux-pending
  Scenario: Declining the runtime restores the snapshot
    Given the agent shows options with several shots each
    When I open that review
    And the board flies to option "B", shot 2
    And I press "Interact with B. One picker, shot 2 here, sealed and offline" on the board
    And I press "Show the source, and don't ask again until Threadbear restarts" on the board
    Then nothing plays on the board


  @review.canvas @review.media @swift-pending @web-runtime @windows-pending @linux-pending
  Scenario: Initial HTML navigation preserves zoom without repainting the canvas
    Given the web runtime is installed
    And the agent shows options with several shots each
    When I open that review
    Then HTML initial load keeps its zoom without a GPUI repaint

  @review.canvas @review.media @swift-pending @web-runtime @windows-pending @linux-pending
  Scenario: HTML input shortcuts leave an existing reply draft untouched
    Given the web runtime is installed
    And the agent shows options with several shots each
    When I open that review
    And the board flies to option "B", shot 2
    Then a live HTML input cannot edit or submit the focused reply draft
