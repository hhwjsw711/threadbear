Feature: Highlights, what a thread has made and shared
  As someone keeping an eye on an agent's work
  I want what it made, shared and pinned kept beside the conversation
  So the files, links and commits don't scroll away with it

  Background:
    Given the app is connected to a runner with the demo threads

  @highlights.panel
  Scenario: A thread's highlights are grouped under their headings
    When I open the thread "Rebuild the three landing pages"
    Then Highlights has the headings "Pinned | Files | Pull requests | Links | Changes"

  @highlights.panel
  Scenario: A heading with nothing under it isn't drawn
    When I open the thread "Rebuild the three landing pages"
    Then Highlights has no heading "Needs you"
    And Highlights has no heading "Sub-agents"

  @highlights.panel
  Scenario: A thread with nothing to show says so
    When I open the thread "Set up the Cloudflare tunnel for the preview server"
    Then Highlights says "Nothing here yet. Files, links and commits from this thread show up here as it works."

  @highlights.panel
  Scenario: Folding a heading keeps its count and folds it for every thread
    Given I open the thread "Rebuild the three landing pages"
    When I fold the "links" heading in Highlights
    Then the "Links" heading in Highlights is folded and counts 2
    When I open the thread "Make uploads resume after a crash"
    Then the "Links" heading in Highlights is folded and counts 1

  @highlights.librarian
  Scenario: The librarian's line says where the thread is up to
    When I open the thread "Rebuild the three landing pages"
    Then Highlights opens with the point "The home page is rebuilt and pushed."

  @highlights.pinned
  Scenario: A pin says why, and files and links say how they turned up
    When I open the thread "Rebuild the three landing pages"
    Then the "Pinned" highlight "home.html" has the note "The new hero with the three plan cards under it. Is the headline too long?"
    And the "Pinned" highlight "home.html" sits in "mockups"
    And the "Files" highlight "copy-review.md" says "Written"
    And the "Files" highlight "copy-review.md" sits in "docs"
    And the "Links" highlight "localhost:4321" says "Opened"

  @highlights.changes
  Scenario: Commits say where they went and the edited files fold away
    When I open the thread "Rebuild the three landing pages"
    Then the "Changes" highlight "Rebuild the home page on the new hero" has the sha "9f3c2e1"
    And the "Changes" highlight "Rebuild the home page on the new hero" sits in "landing-rebuild · pushed"
    And the "Changes" highlight "5 files edited" is listed
    And Highlights doesn't list "Hero.astro"
    When I open the edited files in Highlights
    Then the "Changes" highlight "Hero.astro" sits in "src/components"

  @highlights.panel
  Scenario: A thread's asks stay on its card, not in Highlights
    When I open the thread "Ship the beta to TestFlight"
    Then Highlights has no heading "Needs you"
    And Highlights doesn't list "Accept the new agreement in App Store Connect"

  @highlights.projects
  Scenario: A project's block lists its links and says why the thread's in it
    When I open the thread "Pick a colour for the new Share button"
    Then the "Walkies" highlight "Live site" sits in "walkies.example.app"
    When I ask why the thread is in the project "Walkies"
    Then it says "Picks the share button colour for Walkies"
    And it says "The librarian put it here."
    And it offers "Keep, Take out, Open project"

  @highlights.projects @swift-pending
  Scenario: A project's inline brief shows its state, other open threads and jumps to them
    When I open the thread "Pick a colour for the new Share button"
    Then the project brief for "Walkies" shows the state "Share button colour being picked"
    And the project brief for "Walkies" lists the open thread "Add dark mode to the dashboard"
    When I click the project brief item "Add dark mode to the dashboard"
    Then the open thread is "Add dark mode to the dashboard"

  @highlights.projects @swift-pending
  Scenario: Secondary projects on a multi-project thread start folded until opened
    When I open the thread "Why is the build slow on CI?"
    Then the "Photo sync" project brief in Highlights is expanded
    And the "Threadbear" project brief in Highlights is folded
    When I press the control "Show Threadbear"
    Then the "Threadbear" project brief in Highlights is expanded

  @highlights.projects @coordinators @swift-pending
  Scenario: A coordinated project's inline brief jumps straight to its tasks and coordinator
    When I open the project "Threadbear"
    And the coordinator publishes a task board
    When I open the thread "Rename the Settings tabs"
    Then the project brief for "Threadbear" lists the open question "Reconfirm pickup with Barry"
    When I click the project brief item "Reconfirm pickup with Barry"
    Then the coordinator's "Tasks" tab is open

  @highlights.subagents
  Scenario: Sub-agents are listed with the ones still running first
    When I open the thread "Why is the build slow on CI?"
    Then the "Sub-agents" highlight "Time the test step on each commit" comes first
    And the "Sub-agents" highlight "Time the test step on each commit" is marked "circle.dashed"
    And the "Sub-agents" highlight "Compare the cache keys" is marked "checkmark"

  @highlights.started
  Scenario: A thread it started is listed with where it's up to
    When I open the thread "Make uploads resume after a crash"
    Then the "Threads it started" highlight "Rename the Settings tabs" is listed

  @highlights.scheduled
  Scenario: What will message the thread later is listed with when
    When I open the thread "Why is the build slow on CI?"
    Then the "Scheduled" highlight "Check the CI run again" is listed
    And the "Scheduled" highlight "Check the CI run again" says "in 40m"

  @highlights.scheduled
  Scenario: A Scheduled row opens its schedule in the editor, and its menu offers Edit
    When I open the thread "Why is the build slow on CI?"
    Then the menu of the Scheduled highlight "Check the CI run again" offers "Edit | Show all schedules"
    When I click the Scheduled highlight "Check the CI run again"
    Then the schedule editor is open on the schedule that sends "Check whether the cache change made the CI build faster."

  @highlights.rowmenus
  Scenario: A row's right-click menu offers what can be done with it
    When I open the thread "Rebuild the three landing pages"
    And I right-click the highlight "copy-review.md"
    Then its menu offers "Preview here | Open | Reveal in Finder | Copy path | --- | Remove"
    When I right-click the highlight "9f3c2e1"
    Then its menu offers "Copy sha | --- | Remove"
    When I right-click the highlight "alex-example/site#48"
    Then its menu offers "Copy link | Remove"

  @highlights.rowmenus
  Scenario: Remove takes a row out of Highlights
    When I open the thread "Rebuild the three landing pages"
    And I choose "Remove" from the menu of the highlight "copy-review.md"
    Then Highlights doesn't list "copy-review.md"
