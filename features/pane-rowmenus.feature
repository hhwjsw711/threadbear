@highlights.rowmenus @swift-pending
Feature: A pane row's menu owns its right click
  Background:
    Given the app is connected to a runner with the demo threads

  @highlights.rowmenus
  Scenario: A pinned file opens its menu without the panel menu
    When I open the thread "Rebuild the three landing pages"
    And I right-click the visible pane row "home.html"
    Then exactly one context menu offers "Copy path | Remove"

  @highlights.rowmenus
  Scenario: Escape closes a pinned file's menu
    When I open the thread "Rebuild the three landing pages"
    And I right-click the visible pane row "home.html"
    Then a right-click menu is open
    When I press Escape
    Then no right-click menu is open
