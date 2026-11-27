Feature: Settings › Pools
  As someone whose threads run on several pools of logins
  I want my pools in the order I choose
  So the pool I lean on most is at the top wherever Threadbear lists them

  Background:
    Given the app is connected to a runner with the demo threads

  # The list moves by a real drag, which the frozen Swift app's scripts can't
  # make without the real pointer (AGENTS.md, "Tests that need the real screen").
  @settings.pools @swift-pending
  Scenario: Dragging a pool onto another's row puts it in that place, here and in Usage
    When I open Settings on "pools"
    Then Settings lists the pools "Claude, Work, Codex, Personal, Weekends"
    When I drag the "Weekends" pool onto "Claude" in Settings
    Then Settings lists the pools "Weekends, Claude, Work, Codex, Personal"
    When I click the honey pot in the activity bar
    Then the Usage panel has a card for each pool: "Weekends, Claude, Work, Codex, Personal"
    And in the "Weekends" card, "alex+4@example.com" says "Limit reached"

  @settings.pools @swift-pending
  Scenario: A pool dropped on a row above it lands in that place, the ones below shifting down
    When I open Settings on "pools"
    And I drag the "Weekends" pool onto "Codex" in Settings
    Then Settings lists the pools "Claude, Work, Weekends, Codex, Personal"

  @settings.pools @swift-pending
  Scenario: A pool dropped on a row below it lands in that place, the ones between moving up
    When I open Settings on "pools"
    And I drag the "Claude" pool onto "Codex" in Settings
    Then Settings lists the pools "Work, Codex, Claude, Personal, Weekends"

  # The two ways a drag ends with nothing asked for. Each carries the pointer
  # well past the row it started on, so the window sees a drag; both pass
  # while nothing moves at all, and hold the order still once pools do move.
  @settings.pools @swift-pending
  Scenario: A pool carried off and put back on its own row leaves the order alone
    When I open Settings on "pools"
    And I drag the "Weekends" pool over "Codex" and back onto its own row in Settings
    And I wait a moment
    Then Settings lists the pools "Claude, Work, Codex, Personal, Weekends"

  @settings.pools @swift-pending
  Scenario: A pool let go clear of every row leaves the order alone
    When I open Settings on "pools"
    And I drag the "Weekends" pool clear of every row and let go in Settings
    And I wait a moment
    Then Settings lists the pools "Claude, Work, Codex, Personal, Weekends"

  @settings.pools @swift-pending
  Scenario: The order the pools are left in is still there next time Settings opens
    When I open Settings on "pools"
    And I drag the "Weekends" pool onto "Claude" in Settings
    And I wait a moment
    And I close the Settings window
    And I open Settings on "pools"
    Then Settings lists the pools "Weekends, Claude, Work, Codex, Personal"
    When the app is quit and opened again
    And I open Settings on "pools"
    Then Settings lists the pools "Weekends, Claude, Work, Codex, Personal"
