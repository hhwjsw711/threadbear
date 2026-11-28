Feature: Pull requests open beside the thread
  As someone deciding on other people's pull requests
  I want a PR link to open beside the thread with its checks, diff and buttons
  So I can decide and act without going out to the browser

  # docs/protocol/panels.md, "Pull requests". The GPUI app only: the Swift
  # app is frozen and opens PR links in the browser.

  Background:
    Given the app is connected to a runner with the demo threads
    And I open the thread "Make uploads resume after a crash"

  @pane.prs @swift-pending
  Scenario: A PR link opens as a tab with what decides it
    When I follow the PR link "https://github.com/acme/app/pull/72/files" in the thread
    Then the pane shows the PR "Fewer approvals when a fork brings in a release"
    And the PR's status reads "Open"
    And the PR's checks read "1 of 2 passed" with "Windows failed"
    And the PR's activity includes "Thanks, looking now."

  # Settings > General > Panels > Open pull requests in the pane.
  @pane.prs @swift-pending @gpui-pending
  Scenario: With PR tabs off, a PR link opens like any other web link
    Given "Open pull requests in the pane" is off in Settings
    When I follow the PR link "https://github.com/acme/app/pull/72/files" in the thread
    Then the pane shows no PR tab
    And the link opens where a web link opens

  @pane.prs @swift-pending
  Scenario: The diff tab lists the changed files
    When I follow the PR link "https://github.com/acme/app/pull/72" in the thread
    And I press "Diff" in the PR tab
    Then the PR tab is on "Diff"
    And the PR lists the file "runner/src/swift-changes.ts"

  @pane.prs @swift-pending
  Scenario: Closing it shows at once, then the PR reads closed
    When I follow the PR link "https://github.com/acme/app/pull/72" in the thread
    And I press the PR's button "Closes the PR on GitHub"
    Then the PR's button "close" is busy
    And the PR's status reads "Closed"

  @pane.prs @swift-pending
  Scenario: A PR link in a reply shows whether it's open, and keeps up
    When a reply linking the PR "https://github.com/acme/app/pull/72" streams in
    Then the mark before the PR "https://github.com/acme/app/pull/72" says "Open"
    When I follow the PR link "https://github.com/acme/app/pull/72" in the thread
    And I press the PR's button "Closes the PR on GitHub"
    Then the mark before the PR "https://github.com/acme/app/pull/72" says "Closed"

  @pane.prs @swift-pending
  Scenario: Resting the pointer on a PR link starts reading it before the click
    When a reply linking the PR "https://github.com/acme/app/pull/72" streams in, its turn still going
    Then the PR "https://github.com/acme/app/pull/72" isn't read yet
    When I rest the pointer on the reply's link "#72"
    Then the PR "https://github.com/acme/app/pull/72" is being read

  @pane.prs @swift-pending
  Scenario: The PRs a turn's reply links to are read as it ends
    When a reply linking the PR "https://github.com/acme/app/pull/72" streams in
    Then the PR "https://github.com/acme/app/pull/72" is being read

  @pane.prs @swift-pending
  Scenario: The PRs a thread's last messages link to are read as it shows
    When a reply linking the PR "https://github.com/acme/app/pull/72" streams in, its turn still going
    And I open the thread "Draft the release notes for 0.4"
    And I open the thread "Make uploads resume after a crash"
    Then the PR "https://github.com/acme/app/pull/72" is being read

  @pane.prs @slow-pr-files @swift-pending
  Scenario: A PR shows before its changes are read
    When I follow the PR link "https://github.com/acme/app/pull/72" in the thread
    Then the PR's status reads "Open"
    And the PR's changes are still being read
    And the PR lists the file "runner/src/swift-changes.ts"

  @pane.prs @swift-pending
  Scenario: Open in Panel on a PR link opens its tab, not GitHub's page
    When a reply linking "the fix" to "https://github.com/acme/app/pull/72" streams in
    And I choose "Open in Panel" from the menu of the link "the fix"
    Then the pane shows the PR "Fewer approvals when a fork brings in a release"

  @pane.prs @coordinators @swift-pending
  Scenario: A PR link in a project coordinator's conversation opens beside it
    When I open the project "Threadbear"
    And a reply linking "the fix" to "https://github.com/acme/app/pull/72" streams in
    And I click the link "the fix"
    Then the pane shows the PR "Fewer approvals when a fork brings in a release"

  @pane.prs @swift-pending
  Scenario: A PR opens as a normal panel that follows its thread unless moved
    When I follow the PR link "https://github.com/acme/app/pull/72" in the thread
    Then the PR "https://github.com/acme/app/pull/72" is open as a normal panel beside Highlights
    When I press the PR's button "Approve it, or ask for changes"
    Then the open menu offers "Approve"
    When I open the thread "Draft the release notes for 0.4"
    Then no PR panel is open
    When I open the thread "Make uploads resume after a crash"
    Then the PR "https://github.com/acme/app/pull/72" is open as a normal panel beside Highlights
    When I move the PR panel "https://github.com/acme/app/pull/72" to the bottom of the window
    And I open the thread "Draft the release notes for 0.4"
    Then the PR panel "https://github.com/acme/app/pull/72" stays open across threads
