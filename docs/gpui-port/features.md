# GPUI port: feature list

Every feature of the Mac app, and how each one gets to the single GPUI app for Mac, Windows and Linux. This is the source list that parity tracking builds from: each row is one thing to port, and its ID is what tracking refers to, so IDs stay stable once used. Add a row for a new feature rather than folding it into another.

It comes from reading code, not from running anything, so "(unverified)" means nobody has tried it yet.

**Decisions this list assumes**
- BearDock is rewritten for GPUI as its own crate.
- Web content uses one embedded web engine, "the web runtime" (CEF, optional), wherever a page is shown.
- Menus and popovers are drawn in-window.
- SF Symbols are replaced by a bundled icon set.

**Route**
- `kit`: gpui-kit or GPUI has it, and stock parts do most of the work.
- `build`: ours, drawn in GPUI, no OS code. Logic with no UI counts here too.
- `web`: needs the web runtime.
- `shim`: needs per-OS code, and the row says which OS.
- `hard`: a genuine risk, and the row says why.
- `drop`: not ported, and the row says why.

**Size** is the estimate of Rust lines for that feature alone, on top of section 0: S under 200, M 200 to 800, L 800 to 2500, XL more, `none` for nothing to write. **Swift** is the main files today, without the `.swift`.

## 0. Foundations everything else needs

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `foundation.rpc` | Runner RPC client | JSON-RPC, challenge sign-in, hello, reconnect | Extend `desktop/client`, which already does sign-in and reconnect, and keep the client name `threadbear-mac` or widen the runner's check for it. | build | L | `RPCClient`, `RunnerAPI`, `Transport`, `RunnerAuth`, `AppModel+Connection` |
| `foundation.protocol` | Protocol types | Every event, thread, project, schedule and review model, tolerant of unknown fields | Rust serde types that ignore unknown fields and event types. | build | XL | `Models`, `Event`, `Project`, `RemoteThreads`, `DesignReview`, `ReplyButton`, `RemoteFiles`, `Highlights`, `Schedule` |
| `foundation.reducer` | Transcript reducer | Events to rows: work folding, rewinds, replacements, pending messages | Port from `ThreadbearCore`, growing `desktop/gpui/src/transcript.rs`. | build | XL | `TranscriptReducer`, `TranscriptRow`, `WorkGroups`, `ToolPresentation`, `ThreadFeed` |
| `foundation.state` | App and session state | Selection, thread actions, loaded sessions, drafts | GPUI entities replace Swift Observation. | build | XL | `AppModel`, `AppModel+ThreadActions`, `ThreadSession`, `AppModel+Selection` |
| `foundation.inbox` | Inbox logic | Sections, sort, row text, snooze presets, decisions | Port the logic, growing `desktop/gpui/src/inbox.rs`. | build | M | `ThreadSections`, `SidebarRow`, `Decisions`, `Snooze` |
| `foundation.richtext` | Rich text engine | Selectable styled text with custom backgrounds, pills, click runs, embedded boxes | Risk: one attributed string becomes a list of block elements, which changes selection and measurement, and stock `TextView` has no known way to hold pills or embedded boxes in a text run (Ghostex forked for this). | hard | XL | `TextKit`, `Theme` |
| `foundation.markdown` | Markdown renderer | GFM to styled blocks, each block cached by its text | `TextView` for Markdown, with our own per-block cache so only the open block re-renders. | kit | L | `MarkdownRenderer`, `MarkdownBlocks`, `MarkdownNesting` |
| `foundation.highlighting` | Code highlighting | Colours code in the file pane | gpui-kit's code editor highlighter (tree-sitter or syntect). | kit | M | `TextFileView` (`CodeHighlighter`) |
| `foundation.zoom` | Zoom | ⌘= ⌘- ⌘0 scale everything together, remembered | One scale value applied to the type scale and spacing, saved in the config file. | build | S | `Theme` (`TextZoom`, `TypeScale`) |
| `foundation.theme` | Theme and appearance | Light, dark or system, picked per app; the GPUI app adds an accent (the system's or a bear colour), Roomy or Compact spacing, text size and font | Our colour tokens over gpui-kit's theme; Mac accent and Increase Contrast follow AppKit, read at launch and on return. A picked accent stands in for the system's on every system; Windows and Linux use blue otherwise. | build | M | `Theme`, `AppAppearance` |
| `foundation.icons` | Icon set | About 116 distinct literal SF Symbols (a floor, from my grep) | Bundled icon set, with a name map so each symbol use moves across. | build | M | Every view |
| `foundation.bear` | Bear glyphs | The mascot as stroked paths at any size | Not needed: Mike passed over the bears on 13 Nov. The About window draws its one bear from an SVG. | build | M | `BearGeometry`, `Bear` |
| `foundation.logos` | Provider logos | Model picker marks from SVG path data | Ship the marks as SVG assets beside the icon set. | build | S | `ProviderLogo` |
| `foundation.webruntime` | Web runtime | None to port: WebKit comes with macOS | CEF's official build fetched from Spotify's CDN the first time something needs it ("Install web runtime", with Not now), checked against its pinned size and hashes before it's unpacked into the data folder, and started in the app's own process; until then pages show their source and panels offer the browser. Mac first. | web | L | none (WebKit) |
| `foundation.tooltips` | Tooltips on every control | One app-wide tip panel, also used to name clicks in the activity log | `Tooltip` behind one project helper, and a rule check like `TipsTests`. | kit | M | `Tips` |
| `foundation.infotip` | ⓘ InfoTip | Popover on click, tip on hover, selectable text | `Popover` on click and `Tooltip` on hover. | kit | S | `Tips` (`InfoTip`) |
| `foundation.menus` | Menus with icons | Built-in-code menus, ticks, submenus, section headers | gpui-kit menus drawn in-window, which also makes the private image-visibility call unnecessary. | kit | M | `MenuItems`, `ComposerControls` |
| `foundation.popovers` | Popovers | Model picker, context, share, chip popovers | `Popover`, drawn in-window. | kit | S | `ComposerControls`, `ShareButton` |
| `foundation.dialogs` | Confirm dialogs | Delete, going back with jobs running, odd link schemes | gpui-kit dialog. | kit | S | 7 files |
| `foundation.filepicker` | Native file pickers | Attach, folder choose, project icon | GPUI path prompts. | kit | S | 6 files, `ProjectFilePicker` |
| `foundation.opengate` | Open gate | The one route to open links and files, with trust rules | Port the trust rules, then per-OS open and default-app lookup on macOS, Windows and Linux, and re-prove the security checks on each. | shim | M | `OpenGate`, `LinkPolicy` |
| `foundation.spinner` | Spinner | Turning arc run by the render server | Kit-style loaders share the display link and stay static under Reduce Motion. Working arcs keep their window layer and timer. GPUI still draws them on the main thread. | build | S | `Spinner` |
| `foundation.busy` | Busy and optimistic pattern | Every click shows at once, double click blocked | Shared busy-key helper on entities, with a rule check like `EveryClickShowsTests`. | build | S | `AppModel+Busy`, `BusyControl` |
| `foundation.firstclick` | First click counts | Clicks work with the app in the background | macOS: GPUI's window accepts the first mouse, and so do the web panels' pages (real clicks on Tinker Desk, `features/tools/first-click.ts`, 13 Nov); confirm the same on Windows and Linux. | shim | S | `FirstClick` |
| `foundation.scrollers` | Overlay scrollers | Always overlay, so the reading column stays centred | Draw our own overlay scrollbar over the list (unverified whether stock scrollbars can stay overlay; Ghostex's fork added scrollbar control). | build | S | `Spinner` (`OverlayScrollView`) |
| `foundation.rightclick` | Right-click catcher | Context menu without stealing the view's clicks | Right-button handler on the element that opens an in-window menu. | build | S | `RightClick` |
| `foundation.reorder` | Drag-to-reorder list | Row lifts, dashed slot, neighbours slide | Port `ReorderDrag` and draw the lift and slide with `Animation`. | build | M | `ReorderList`, `ReorderDrag` |
| `foundation.filewatch` | File watching | Reloads shortcuts, files and folders on change | Cross-platform file-watch crate in place of DispatchSource (unverified which). | build | S | `AppShortcuts`, `FolderBrowser`, `TextFileDocument` |
| `foundation.reducemotion` | Reduce Motion | Animations become fades or stills | Read the OS setting on macOS, Windows and Linux, as Ghostex does with a small Mac shim. | shim | S | `Juice` and others |
| `foundation.accessibility` | Accessibility labels | 53 label or element uses | AccessKit through GPUI, where a node needs a global id and a role; test early, as tools saw nothing in Ghostex and that is unexplained. | kit | M | Scattered |

## 1. Windows and panel dock

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `dock.layout` | Layout tree | Splits and tab groups, tidied and saved | Port the pure tree and its tests into the BearDock crate, with old saved layouts still loading. | build | M | `DockLayout` |
| `dock.bars` | Panel bars and tabs | Title, tabs, × to close, buttons | Drawn in the BearDock crate. | build | M | `DockView` |
| `dock.drag` | Panel drag | Title or tab drags now, elsewhere after a 350 ms hold, shrunken ghost, dashed hole, Esc | GPUI mouse events in the BearDock crate, keeping the press rules and springs with `with_spring`. | build | L | `DockController`, `DragOverlay` |
| `dock.drop` | Drop targets | Tab slot, side split, compass (arrows, tab, Swap, Window), window edge | Port the hit-test order and draw the targets in the crate. | build | M | `DockController`, `DragOverlay` |
| `dock.detached` | Detached panel windows | Drag out past the edge, drag back in with the window see-through, frames saved | Risk: GPUI's stock dock has no torn-out windows, and tracking the pointer across windows will be hard on Wayland. | hard | L | `DockWindows`, `DockView` |
| `dock.divider` | Divider resize | Drag the line between panels | Drawn in the crate with a resize cursor, 14 pt strip and 80 pt minimum. | build | S | `DockView` |
| `dock.hidetitle` | Hide Title | Panel with no bar, a thin grab strip on hover | Drawn in the crate, following the panel. | build | S | `DockView` |
| `dock.menu` | Panel context menu | Open in New Window, Put Back, Hide or Show Title | gpui-kit menu, in-window. | kit | S | `DockView` |
| `dock.titlebar` | No title bar | Traffic lights in the top-left bar, drag bar to move, double-click to zoom | gpui-kit `title-bar` (platform-dependent) and `start_window_move`, with client-side decorations on Windows and Linux (unverified how far it goes). | kit | M | `WindowDock`, `ActivityBar` (`WindowGrip`) |
| `dock.frame` | Window frame memory | Reopens where left | Save bounds in the config file and recentre an off-screen frame. | build | S | `MainWindowFrame` |
| `dock.motion` | Panels glide open and closed | A panel opening fades in where it goes as the others glide and resize to make room (`withAnimation(settle)`, a spring of 0.34 s response and 0.86 damping, with each group's `matchedGeometryEffect`); closing, it fades out as they take its room back | GPUI can't animate a flex layout: while a glide runs the dock places its groups by hand at frames worked out from the layout (`group_frames`), sampled from the spring by time. A closing panel fades out as a blank of the panel's colour, not its content. | build | S | `DockController`, `DockView` |
| `dock.reset` | Default layout and Reset | Three panels, View > Reset Panel Layout | Build the default tree in the crate. | build | S | `WindowDock` |
| `dock.threadpanel` | Thread in its own panel | Beside the main one, from the row menu | A dock panel holding a second thread view. | build | M | `ThreadPanels` |
| `dock.pin` | Pin a side panel to its thread | Pin on a patch panel's tab keeps it showing that thread's panel whichever thread is picked; Unpin puts the ordinary one back | A dock panel whose id carries the thread and panel (`threadbear.pin:<thread>:<panel>`), drawn from that thread. GPUI only: the Swift app is frozen. | build | S | none |
| `dock.openelsewhere` | Open elsewhere note | Main panel says it's open elsewhere, with Go to it and Show it here | Drawn in the thread panel. | build | S | `ThreadPanels` |
| `dock.contexttabs` | Context tabs | A review opens as a tab and closes with its context unless dragged away | Tab lifetime rule in the crate's app wiring. | build | S | `WindowDock` |
| `dock.ghost` | Dock ghost picture | Dragged transcript shown as a snapshot | Scale the panel's own elements (unverified that a live subtree can scale; `render_to_image` is a test capture), else a plain placeholder. | build | S | `TranscriptController` (`TranscriptHost`) |
| `dock.dragspace` | Drag Space workaround | macOS 27.2 bug fix for invisible menus | Not ported: menus are drawn in-window, so the system menu windows it protects aren't used. | drop | none | `DragSpace`, `MenuWatch`, `MenuPopover` |

## 2. Rails

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `rail.activity` | Activity bar | Threads with count, Scheduled, Projects, Librarian; at the foot Setup, Connectors, Runners, Updates, Usage, Settings; sliding highlight | Drawn column, with the highlight moved by `Animation`. A click bounces the icon, the lit square slides between the views and the new view settles in (`rails.rs`, `shell.rs` `render_threads_panel`; Mike picked them 13 Nov). | build | M | `ActivityBar` |
| `rail.dots` | Rail dots | Blue or grey dots saying needs you or in progress | Drawn. | build | S | `ActivityBar` |
| `rail.honeypot` | Honey pot | Usage icon filled to room left, drains, refills with a drip | Drawn path with `Animation` for level and drip. | build | M | `HoneyPot` |
| `rail.right` | Right rail | Highlights, patch panels, Browser, Files, Patches | Drawn column that opens dock panels. | build | M | `PanelsView` (`PanelRail`) |
| `rail.originbadge` | Origin badge | Corner badge saying where a panel came from | Project icons drawn as is; `.app` icons need macOS code, and Windows and Linux use a generic icon. | shim | S | `PanelsView` (`PanelOriginBadge`) |

## 3. Sidebar and inbox

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `sidebar.sections` | Sections | Starred, Coordinators, Inbox, Running, Hibernating, Archived, foldable with counts; drag any heading to reorder (open sections fold during the drag, headings slide live, order saved in `desktop-settings.json`) | Foldable headings over a gpui-kit list, from inbox logic, with heading drag-to-reorder (`section_drag.rs`). | build | M | `SidebarView` |
| `sidebar.sort` | Inbox sort | Needs you first, Newest or Oldest, from the heading arrows | gpui-kit menu on the heading. | kit | S | `SidebarView` (`InboxOrderMenu`) |
| `sidebar.search` | Thread search | Filters every section on title and last reply, opens folds | `Input` feeding a filter in the inbox logic. | kit | S | `SidebarView` (`ThreadSearch`) |
| `sidebar.search.archive` | Agent Archive in the search | Experiment `archive`: after the threads, an Agent Archive heading with the sessions that have the words (the agent's mark, title, who, folder and date, the words round the match marked), asked once typing pauses with three or more letters, a Searching the archive row meanwhile and why when it fails; a session already among the threads is left out, one with a thread opens it, any other opens read-only in the thread's place at the message that matched, with Open in the archive and New thread from this | Rows after the sections in `archive_search.rs`, rules in `core/src/archive_search.rs`. | build | M | none (GPUI only) |
| `sidebar.newthread` | New thread button | Compose icon, lit while drafting | Drawn button with `Tooltip`. | build | S | `SidebarView` |
| `sidebar.row` | Thread row | Project tile, title, project line; bold if unread or needs you | Custom row in a virtual list. | build | M | `SidebarView`, `SidebarRow` |
| `sidebar.row.marks` | Row left marks | Blue dot, tick | Drawn. The Swift app's dot pop and tick drawing on were passed over by Mike on 13 Nov. | build | S | `SidebarView` |
| `sidebar.row.origin` | Origin mark | Tool, clock, pawprint or books before the project, hover says why | Icon with `Tooltip`. | build | S | `SidebarView` |
| `sidebar.row.status` | Row right status | Working plus timer, Failed, Waiting for connection, Stopped, Waiting for room, Woke up, sub-agent spinner, time | Drawn, with the shared spinner and a ticking timer. | build | M | `SidebarView` |
| `sidebar.row.lasthover` | Last-message hover | Hover the project line for what you last said | `Tooltip`. | kit | S | `SidebarView` |
| `sidebar.row.remote` | Other-Mac icon | Machine icon on remote rows | Drawn. | build | S | `SidebarView`, `RemoteRunners` |
| `sidebar.row.hoverbuttons` | Hover buttons | Star, Hibernate, Archive or Unarchive, Trash | Drawn on hover, with the busy pattern. | build | S | `SidebarView` |
| `sidebar.row.menu` | Row context menu | Star, Hibernate, Archive, Move to, Projects, Rename, Open in New Panel, Copy thread id, Ask the librarian to look, Delete… | gpui-kit menu with submenus, in-window. | kit | M | `SidebarView` |
| `sidebar.subagents` | Sub-agent tree | Indented sub-agents with a drawn trunk, click to read | Custom rows with a drawn trunk. | build | M | `SubagentViews`, `SubagentRows` |
| `sidebar.nested` | Nested threads | Experiment `nestedThreads`: threads another thread started sit indented under it (one level, a grandchild under the top), in the section of the group's most urgent member; open by itself while one waits on Mike, folded otherwise, the starter's count ("1 needs you · 5 working") opening or folding it; a child's question in orange or where it's up to; archived ones as "N finished"; Move Out From Under and Put Back Under in the row menu; the Projects view nests the same way. Dragging rows in or out is planned, after a motion mockup | Rules in `core/src/nested.rs`; rows drawn as the inbox's own, indented with a guide line. | build | M | none (GPUI only) |
| `sidebar.quiet` | Quietly archived | Experiment `quietInboxMine`: an archived row the runner archived because a model judged Mike didn't need to see it offers "Should Have Shown Me" in its menu, bringing it back to the inbox at once, rolled back with the error if refused. (A "Quietly archived: N today" line and list at the Inbox's foot was taken out on 23 Nov: Mike checks them in a daily thread instead.) | `quiet_inbox.rs`, `MenuAction::ShouldHaveShown` in `sidebar.rs`. | build | S | none (GPUI only) |
| `sidebar.archived.paging` | Archived paging | Recent few, then Show more; the open thread is always included | Port the rule and draw a Show more row. | build | S | `SidebarView` (`ArchiveRows`) |
| `sidebar.archived.foot` | Archived pinned to foot | Not present: tried 8 Nov, undone 9 Nov (cfbf3cb3); Archived sits directly under the other sections | Not ported: the Swift app no longer has it. | drop | none | none |
| `sidebar.skeleton` | Loading skeleton | Pulsing grey rows until the first list lands | Drawn rows with `Animation`. | build | S | `SidebarView` (`LoadingRows`) |
| `sidebar.hibernate.presets` | Hibernate presets | Hour, evening, tomorrow, Monday, until restart | gpui-kit menu, from the snooze logic. | kit | S | `SidebarView`, `Snooze` |
| `sidebar.hibernate.pick` | Pick a time | Calendar and time sheet | gpui-kit sheet with a calendar and time field drawn by us (unverified that a date picker exists). | build | M | `SidebarView` (`SnoozePicker`) |
| `sidebar.hibernate.wake` | Wake when… | Free text wake condition | gpui-kit dialog with `Input`. | kit | S | `SidebarView` (`WakeWhenPrompt`) |
| `sidebar.swipe` | Swipe row to archive | Two fingers, blue backing, threshold, flick | Risk: needs scroll phases from the trackpad, GPUI's gesture hook is unverified and the data differs per OS, and these gestures passed tests but failed on a real trackpad on the Mac. | hard | M | `RowSwipe` |
| `sidebar.mousedrag` | Mouse drag to archive | Drag left past the line | GPUI mouse drag on the row, sharing the swipe's end state. | build | S | `RowSwipe` |
| `sidebar.rowmotion` | Row slide and count roll | Section changes animate | `Animation` by hand, as GPUI has no matched geometry we know of. The selection's highlight slides between rows (160 ms, `row_motion.rs` `selection_marker`), and a row archived from its button or menu slides off (`row_swipe.rs` `archive_row_sliding`). | build | M | `Juice` |
| `sidebar.starredorder` | Reorder within Starred | Not present: starred keeps star order | Not ported: the app doesn't have it. | drop | none | none |
| `sidebar.keys` | Sidebar keys | Up and down move through the threads once the list is clicked, Esc goes back to the Inbox from the Scheduled, Projects and Librarian views, and the arrows, Next Inbox Thread and a thread chip scroll the row into view | A key context on the Threads panel, which takes the keyboard when clicked, and a scroll to the row once it's laid out (`row_motion.rs`). | build | S | `SidebarView` (`ThreadList`), `ScheduledList`, `LibrarianView` |
| `sidebar.move` | Move to another runner | Sheet with login choice, Cancel Move | gpui-kit sheet. | kit | S | `MoveSheet`, `AppModel+Moves` |

## 4. Thread header, banners, toasts

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `header.title` | Title line | Title in the panel bar, click to rename inline | Text that becomes an `Input` on click. | build | S | `DetailView` (`HeaderTitle`, `ThreadTitleField`) |
| `thread.startedby` | Started by | Experiment `nestedThreads`: a thread another thread started opens with one quiet line above its transcript, "Started by <starter>" (a link that opens it) and its `startedBy.why` | A line over the transcript in `thread.rs`. | build | S | none (GPUI only) |
| `header.projectchip` | Project chip menu | In a project, take out, keep, add to another | gpui-kit menu. | kit | S | `DetailView` |
| `header.schedulechip` | Schedule chip | Booked message in the header | Drawn chip. | build | S | `DetailView` (`ScheduleChip`) |
| `header.backforward` | Back and forward | ‹ › with hover destination | Drawn buttons with `Tooltip`. | build | S | `HistoryButtons`, `Navigation`, `NavigationHistory` |
| `header.share` | Share | Popover with Anyone with the link, Only you, Copy, new link, open | `Popover` with GPUI's clipboard. | kit | S | `ShareButton` |
| `header.more` | ... menu | Copy id, Copy transcript, Open on the web, Share, Hibernate, Archive | gpui-kit menu. | kit | S | `DetailView` (`ThreadMenuButton`) |
| `header.pendingreviews` | Pending reviews button | Reaches a review older than the loaded page | Drawn button that fetches the review. | build | S | `ReviewWindow` (`PendingReviewsButton`) |
| `banner.connection` | Connection banner | Reconnecting, Start runner, Try again | Drawn banner, with Start runner going through `system.startrunner`. | build | S | `DetailView`, `Support` |
| `banner.error` | Error banner | Orange bar with Investigate, which starts a fix thread | Drawn. | build | S | `DetailView`, `InvestigateText` |
| `banner.limit` | Limit banner | Out of room, carry on with another login | Drawn. | build | S | `DetailView` |
| `banner.signin` | Sign-in banner | Sign in… opens Terminal, Send again | Open a terminal per OS: Terminal.app on macOS, and the user's terminal on Windows and Linux. | shim | S | `DetailView`, `Usage` (`SignIn`) |
| `banner.refusal` | Refusal offer | Continue with Codex Sol after a safeguards refusal | Drawn. | build | S | `RefusalOffer`, `RefusalRecovery` |
| `header.subagent` | Sub-agent header | Way back, status, no composer | Drawn. | build | S | `SubagentViews` |
| `toast.archived` | Archived toast | Undo, click to open, stays under the pointer. GPUI only (Wayne Sutton, #77): an x or a sideways swipe puts it away early, and on a Mac ⌘Z brings back the last seven archives, newest first, outside a text box or a terminal, or in an empty message box | `Toast` with an Undo action (unverified that it can stay under the pointer). | kit | S | `DetailView` |
| `toast.inboxend` | Inbox end toast | Caught up after Next Inbox Thread | `Toast`. | kit | S | `DetailView` |
| `toast.milestone` | Milestone toast | Thread count passes 100 and each thousand | `Toast`, using time since the last in-app input in place of the system idle time. | kit | S | `DetailView`, `AppModel+Milestones` |
| `thread.newpage` | New-thread page | Centred composer, heading, project chip, note, room card | Drawn page reusing the composer. | build | M | `DetailView` (`ComposerPlacement`, `NewThreadHeading`, `AccountRoomCard`) |
| `thread.loadfailure` | Load failure states | Couldn't load, Try again, no record, Nothing yet | Drawn. | build | S | `DetailView` |
| `thread.loading` | Reading a thread | A small spinner in the middle of the transcript, no words, until its rows are read | Loader over the list while the pane isn't loaded, on the shared loading-spinner clock. | build | S | `DetailView` |
| `thread.kept` | Threads kept loaded | The last 24 threads opened stay loaded, so switching back shows one at once and catches up from its last seq | `PaneCache` of panes, still subscribed; least recently shown goes first. | build | M | `AppModel+Selection` (`sessions`, `maxSessions`) |

## 5. Transcript row kinds

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `transcript.list` | The transcript list | Virtualised rows, paging in older events, scroll anchoring, streaming without jumps, per-thread scroll memory | Risk: `MessageScroller` covers the tail-following list, but anchoring across inserts, prepends and expanding rows, and pages of 500 events on a 5,000-row thread, are the first thing stage 0 tests. | hard | XL | `TranscriptController`, `Cells` |
| `transcript.user` | Your bubble | Right aligned, 80% column, with images and chips | Custom row with `TextView` inside `MessageScroller`. | build | M | `Cells` (`TextRowCell`), `RowRenderer` |
| `transcript.pending` | Pending states | Faded plus spinner, clock when queued, waiting-for-runner note | Drawn states on the bubble. | build | S | `Cells` (`PendingMark`), `PendingMessage` |
| `transcript.edit` | Edit pencil | Hover, puts text back in the composer, rewinds on send, warns on background jobs | Hover button, with a gpui-kit dialog for the warning. | build | M | `Cells`, `AppModel+ThreadActions` |
| `transcript.notes` | Runner and schedule notes | Centred quiet line, schedule name header | Drawn. | build | S | `RowRenderer` |
| `transcript.agentmessage` | Agent message card | Another thread's agent wrote it | Drawn card. | build | S | `RowRenderer` (`agentMessageText`) |
| `transcript.answered` | Answered bubble | Your picks shown as question and answer; review pick likewise | Drawn. | build | S | `RowRenderer` (`userWords`), `AnswerChips` |
| `transcript.reply` | Assistant reply | Streaming Markdown in the reading column | `TextView` in `MessageScroller` with follow-tail, as Ghostex does with `gpui::list`, re-rendering only the open block. | kit | L | `Cells` (`TextRowCell`), `RowRenderer` |
| `transcript.thinking` | Thinking line | "Thinking" or "Thought", opens to full text | Drawn row that expands. | build | S | `Cells` (`HeaderRowCell`) |
| `transcript.tool` | Tool line | One line with icon and title, opens to fields and output | Drawn row that expands, from `ToolPresentation`. | build | M | `Cells` (`HeaderRowCell`), `RowRenderer` (`toolHeader`, `toolBody`) |
| `transcript.tooloutput` | Tool output styling | Numbered lines, field lists, only error lines red | Drawn monospaced lines. | build | M | `RowRenderer` (`numbered`, `fieldsText`) |
| `transcript.heldback` | Held-back output | Fetches another runner's tool body when opened | Fetch on expand. | build | S | `TranscriptController` |
| `transcript.diff` | Diff row | +N -M line, opens with a preview, Show N more lines, up to 1500 | Drawn line fills from `DiffBuilder`, with per-line layout caching for long diffs. | build | M | `RowRenderer` (`diffText`), `DiffBuilder` |
| `transcript.images` | Images row | Layer grid, Quick Look on click, drag out | Drawn grid with decoding off the main thread, opening `file.quicklook`'s in-app viewer, and drag out through `drag.fileout`. Another Mac's pictures come through the runner (`remote_pictures.rs`) and open in the viewer from there too. | build | M | `Thumbnails` (`ImageGridView`), `Cells` |
| `transcript.approval` | Approval card | Whole command or diff, Allow, Always allow, Deny, Return allows | Drawn card with key handling. | build | M | `Cells` (`ApprovalRowCell`), `RowRenderer` |
| `transcript.approval.stacked` | Stacked approval | Several calls, tick and cross on each, Allow N, Deny all | Drawn card. | build | M | `Cells`, `RowRenderer` (`StackedApproval`) |
| `transcript.invisiblechars` | Invisible-character display | Writes `⟨U+2028⟩` in cards | Port `CardText`, a security display rule. | build | S | `CardText` |
| `transcript.approval.settled` | Settled approval | Collapses to one work line | Drawn. | build | S | `RowRenderer` (`resolvedApprovalText`) |
| `transcript.startrequest` | Start-a-thread card | Remote agent's request, Start it or Don't | Drawn card. | build | S | `Cells`, `RowRenderer` (`startRequestPayload`) |
| `transcript.question` | Question card | Options, multi or single, Something else, Send | Drawn card with `Input`. | build | M | `Cells` (`QuestionRowCell`) |
| `transcript.secret` | Secret card | Masked field, Save securely, Decline, settles to a line | `Input` in a masked mode (unverified that the mode exists) on a drawn card. | kit | M | `Cells` (`SecretRowCell`, `SecretField`) |
| `transcript.review` | Review card | Compact card to reopen a review | Drawn. | build | S | `ReviewRowCell` |
| `transcript.plan` | Plan card | Go ahead, Send back, expand, becomes a checklist | Drawn card. | build | M | `Cells` (`PlanCardCell`) |
| `transcript.plansteps` | Plan steps row | Agent's step list | Drawn. | build | S | `RowRenderer` (`planSteps`) |
| `transcript.turnfooter` | Turn footer | End-of-turn line from outcome, duration, cost and usage | Drawn. | build | S | `RowRenderer`, `Event` |
| `transcript.note` | Note row | Quiet system line, folds into groups. GPUI only: a login's move or wait ("Moved to ...", "Carrying on at ...") stays on show, in place of the limit's error | Drawn. | build | S | `RowRenderer` |
| `transcript.woke` | Woke-up note | Sleeping bear gets up on first view | Plain note: Mike passed over the waking bear on 13 Nov. | build | M | `InkLayers` (`WokenBearView`) |
| `transcript.error` | Error row | Failure text by kind | Drawn. | build | S | `RowRenderer` |
| `transcript.workedfor` | Worked-for group | One line, opens to its items indented, live while working | Drawn group that inserts rows into the list. | build | M | `Cells` (`GroupRowCell`), `WorkGroups` |
| `transcript.working` | Working line | Bear plus elapsed time | The paw and elapsed time (`rows/work.rs` `working_paw`): Mike passed over the bear on 13 Nov and asked for the paw to move instead, picking one of five at random every 2.4 s (flip, spin, knead, wave, pawprints; core's `juice::paw_pose`). Still under Reduce Motion. | build | M | `Cells` (`WorkingRowCell`), `WavingBearView` |
| `transcript.background` | Background line | N sub-agents or jobs still going | Drawn. | build | S | `Cells` (`BackgroundRowCell`), `BackgroundWork` |
| `transcript.gap` | Gap divider | "6 min later · X finished" | Drawn. | build | S | `Cells` (`GapRowCell`) |
| `transcript.changes` | Changes card | Taken out 28 Nov 2026: turns no longer emit a fallback "Edited N files" card; edits stay in the folded work group | Removed from the GPUI app; the Swift app's is frozen. | drop | none | `Cells` (`ChangesRowCell`), `RowRenderer` (`changesRender`) |
| `transcript.rowmenu` | Row context menu | Copy message, Expand or Collapse, Copy transcript, Copy debug info | gpui-kit menu with GPUI's clipboard. | kit | S | `TranscriptController`, `MarkdownExport`, `RowDebug` |
| `transcript.find` | Find in the thread | ⌘F over the transcript: counts matches as you type, ⌘G and ⇧⌘G step round, opens the folded group, tool output or thought a match is in, marks matches in replies | The file viewer's find bar (`file_find::find_bar`) over the transcript, searching the loaded rows' words joined into one text (`threadbear_core::thread_find`). GPUI only (24 Nov 2026): the Swift app is frozen. | build | M | none |
| `transcript.lightup` | Step light-up | Work link opens its group, scrolls, accent rail fades out | Scroll to the row, then fade a drawn rail with `Animation`. | build | S | `TranscriptController` (`light`) |
| `transcript.sendlift` | Send lift | New message rises from the composer, continues across row replacement | Built (`rows.rs` `send_lift`, timings in core's `juice`): from Mike's pick of 13 Nov, 14 points up as it fades in over 0.17 s, starting 0.06 s after Return, keyed by the words so the runner's row carries on with it. A 0.1 s fade under Reduce Motion. | build | S | `Juice` (`SendLift`), `TranscriptController` |
| `transcript.edgefades` | Edge fades | Top and bottom mask over content, scroller excluded | Gradient overlays drawn above the list and below the scrollbar (unverified that they match a true mask). | build | S | `TranscriptController` (`updateFade`) |
| `transcript.rewind` | Rewind line | Says how many files were put back | Comes from the reducer, drawn as a note. | build | S | `TranscriptReducer` |

## 6. Rich content inside a reply

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `rich.inline` | Inline Markdown | Bold, italic, strike, inline code pills, bare URLs | `TextView` (unverified that its inline code can match our pill). | kit | M | `MarkdownRenderer`, `TextKit` |
| `rich.blocks` | Headings, lists, quotes | Block styles and list markers | `TextView`, styled through the theme. | kit | M | `MarkdownRenderer` |
| `rich.codebox` | Code boxes | Rounded box behind code | `TextView` code blocks, with long ones capped and scrolled inside as Ghostex does. | kit | S | `MarkdownRenderer`, `TextKit` |
| `rich.table` | Tables | Natural widths, scales down to fit | TextView with our opt-in natural-width style; wide tables still fit or scroll inside the column. | kit | M | `MarkdownRenderer` (`renderTable`) |
| `rich.localpicture` | Local pictures | `![](/path)` drawn in the flow, blocked for other Macs' threads | Our own image block, keeping the block for other runners' threads. | build | M | `MarkdownRenderer` (`picture`), `ImageLayout` |
| `rich.mermaid` | Mermaid diagrams | Drawn with Pele in the app's colours, disk cached | Run `pele.js` in the web runtime and cache the picture on disk, showing the source when the runtime isn't installed; offscreen capture from CEF is (unverified). | web | L | `RichBlocks`, `RichRenderer`, `pele.js` |
| `rich.html` | HTML blocks | Static page, no scripts or network | Web runtime page with the same lockdown as `file.htmlpreview`, showing the source when the runtime isn't installed. | web | M | `RichRenderer`, `PreviewSandbox` |
| `rich.chrome` | Rich box chrome | Language label, Diagram/Source switch, copy, full size | Drawn block header. | build | M | `RichBlocks` (`RichBlockCell`) |
| `rich.fullsize` | Full-size rich window | Most of the screen | Own GPUI window holding the web runtime's page. | web | S | `RichBlockWindow` |
| `rich.draft` | Draft blocks | Slack, email, draft as it'll go out, Slack formatting | Our own block element from `DraftBlock`. | build | M | `DraftBlock`, `DraftBlockCell` |
| `rich.draft.copy` | Draft copy | Copies with links and bold, "Copied" bubble | GPUI's clipboard is simpler than this, so the HTML flavour needs code on macOS, Windows and Linux (unverified). | shim | S | `DraftBlockCell`, `CopiedBubble` |
| `rich.draft.edit` | Draft edited | Edit turns a draft into a text box; the changed draft goes with the next message for the agent to use; Undo | GPUI only (the Swift app is frozen): the change is kept on this Mac, beside the box. | build | S | none |
| `rich.draft.select` | Draft words selected | A draft's lines select like the reply's words, with the bar over them and ⌘C | Its lines as one text of the window's selection, its own in the box; a drag from outside takes the box whole. | build | S | `MarkdownRenderer.draftBlock`, `TextKit` |
| `rich.replybuttons` | Reply buttons | Agent-made pill buttons in the text, live states | Drawn pills as blocks, or inline once `foundation.richtext` settles that. | build | M | `MarkdownRenderer` (`replyButton`), `ReplyButton` |
| `rich.threadchips` | Thread chips | Ids become chips, hover card, click opens | Drawn chip with `Popover` card, depending on `foundation.richtext` for inline placement. | build | S | `ThreadChips`, `ThreadRefs` |
| `rich.threadlinkmarks` | Thread link marks | A link to another thread in a reply has a mini tile of it before it: an arc while it works, an orange badge when it needs you, red if it failed, a tick when done | Inline element from a markdown plugin (thread_link_marks.rs), live from the app's threads. GPUI only (17 Nov 2026). | build | S | none |
| `rich.cardchips` | Card chips | Notion card mentions, click opens | Drawn chip, depending on `foundation.richtext`. | build | S | `CardChips`, `CardMentions` |
| `rich.picturechips` | Picture chips | "Picture 1" in sent words, hover picture, click Quick Look | Drawn chip, `Popover` picture, and `file.quicklook`'s in-app viewer. On another Mac's thread the chip has no hover picture and opens that Mac's picture through the runner. | build | M | `PictureChips`, `InlinePictures` |
| `rich.worklinks` | Work links | ↑ link jumps to the step | Port the link parsing and scroll to the row. | build | S | `WorkLinks`, `TranscriptController` |
| `rich.filerefs` | File path refs | Paths in text become links, relative to the thread folder | Port the parsing and add click runs. | build | S | `FilePathRefs`, `TextKit` |
| `rich.textservices` | Mac text services | Look Up, Translate, Writing Tools and Services for selected words | Shared selection getter, checked undoable returns, AppKit responder proxy and system popovers. Other systems omit these Mac services. | shim | M | `ComposerTextView`, `TextKit` |
| `rich.linkpeek` | Link hover peek | File picture or page address after a pause | macOS: `QLThumbnailGenerator`; Windows and Linux: images decoded in-app and addresses only, shown in a `Popover`. | shim | M | `LinkPeek`, `ThreadChips` (`ChipCardWindow`) |
| `rich.filemenu` | File link menu | Open ways, Copy Path, Default sets the click | gpui-kit menu, with the list of apps coming from per-OS code on macOS, Windows and Linux. | shim | M | `FileLinks` |
| `rich.webmenu` | Web link menu | Browser, panel, per Chrome profile, Copy Link, Default | gpui-kit menu, with Chrome's profile list read from a per-OS path on macOS, Windows and Linux. | shim | M | `FileLinks`, `ChromeProfiles` |
| `rich.browserbear` | BrowserBear tab handover | Click brings the agent's existing tab forward | Unix socket on macOS and Linux, named pipe on Windows (inferred). | shim | S | `BrowserBear`, `BrowserBearPipe` |
| `rich.middleclick` | Middle click opens | Middle mouse opens a link | Middle-button handler on link runs. | build | S | `TextKit` |
| `rich.cmdclick` | ⌘-click | Opens in the associated app instead | Modifier check on link runs, with Ctrl on Windows and Linux. | build | S | `TextKit` |
| `rich.selection` | Selection inside a row | Native selection in one text view | `TextView` selection, and `MessageScroller` handles selection across virtualised content (unverified with custom inline runs). | kit | L | `TextKit` |
| `rich.selectionbar` | Selection bar | Explain, Quote, Copy above the selection | Drawn bar anchored to the selection, in-window. | build | S | `SelectionBar`, `TextKit` |
| `rich.copy` | Rich copy | Plain and HTML with links, cards as titles | Plain text through GPUI's clipboard, with the HTML flavour needing code on macOS, Windows and Linux (unverified). | shim | S | `SelectionHTML`, `TextKit` |
| `rich.explain` | Explain pane | Selected words explained beside the thread, follow-ups, kept out of the thread | Drawn pane with `TextView` and `Input`. | build | M | `ExplainPane`, `ExplainModel`, `Explain` |

## 7. Composer

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `composer.textbox` | Text box | Multi-line, grows, undo, wrap, per-thread drafts | `Textarea`, tested early with IME and dictation (XIM on X11, text-input on Wayland). | kit | L | `ComposerView` (`ComposerTextView`) |
| `composer.idle` | Idle text box | Keeps an untouched draft and accepts editing again | The caret stays visible after ten seconds without editing or cursor movement, then resumes on activity. | kit | S | `ComposerView` |
| `composer.spelling` | Spelling | Misspelled words marked, guesses, Ignore and Learn Spelling on right-click, autocorrect and text replacements as a word ends, the right-click menu's Spelling and Grammar, Substitutions, Transformations and Speech | The Mac's spell checker (NSSpellChecker) and speech through objc2, the marks drawn by the kit's textarea (our `set_text_marks`); none on Windows or Linux. | build | M | `ComposerView` (`ComposerTextView`, NSTextView's own) |
| `composer.return` | Return, Shift-Return | Send, new line | Key bindings on `Textarea`. | build | S | `ComposerView` |
| `composer.listcontinue` | List continuation | "2. " after "1. x", empty item ends it, one undo | Port the rule on `Textarea` (unverified that it can make one undo step). | build | S | `ComposerView` (`insertLineContinuingList`) |
| `composer.picturechips` | Picture chips | Paste, drop or + goes in at the cursor, thumbnails over the words | Stock since gpui-kit 0.9.0: inline tokens on `TextareaState` (`InlineToken`), atomic in editing and undo, drawn by our own renderer. Ghostex forked for this before they existed. The runner converts pasted HEIC and TIFF (`media.import`). | kit | L | `ComposerView`, `PictureChips` |
| `composer.chiphover` | Chip hover and × | Peek, remove chip and picture, a click opens it | `Popover` on hover and a drawn ×, on top of `composer.picturechips`; a click on a chip or thumbnail opens the viewer. | build | S | `ComposerView` |
| `composer.chipcopy` | Copy or cut chips | Paste brings the pictures back | Keep chip data in app memory, matched to the plain text on the clipboard, so no private pasteboard type is needed. | build | S | `ComposerView` |
| `composer.filedrop` | File path drop | Video, PDF, folder go in as a path, drawn as a file chip with a not-uploaded dot | GPUI file drop, on every OS. | kit | S | `ComposerView`, `DroppedFiles` |
| `composer.threadid` | Thread id paste or drop | Becomes a chip | Paste rule and an in-app drag, on top of inline chips. | build | S | `ComposerView`, `ThreadDrag` |
| `composer.threadpicker` | # thread picker | Typing # at the start of a word lists the other threads, latest first, narrowed by title, folder or the start of an id (archived ones only once something's typed); Return, Tab or a click puts the thread in as its chip, Esc closes it, and a # matching nothing leaves it shut | Drawn over the box like the slash palette (`thread_palette.rs`), rules in `core/src/thread_mentions.rs`, from the app's thread list. | build | S | none (GPUI only) |
| `composer.cardmention` | Card mention | Click on a board adds a chip | Inserts a chip, on top of inline chips. | build | S | `CardChips`, `HighlightsBoard` |
| `composer.dropanywhere` | Drop anywhere on thread | Outlined while it'll take it | GPUI file drop on the thread area, with a drawn outline. | kit | S | `ComposerView` (`ComposerDropView`) |
| `composer.plus` | + menu | Attach images or Markdown, Folder, Schedule | gpui-kit menu and GPUI path prompts. | kit | S | `ComposerControls` (`plusMenu`, `folderMenu`) |
| `composer.runner` | Runner chip | Which Mac, star sets default | gpui-kit menu. | kit | S | `ComposerControls` (`runnerMenu`) |
| `composer.account` | Account chip | When not using pools | `Popover`. | kit | M | `ComposerControls` (`AccountPickerView`) |
| `composer.modelpicker` | Model picker | Search, provider rail, logos, Older, Effort, Speed, Unpin | Custom content in a `Popover`, with `Input` for search. | build | L | `ComposerControls` (`ModelPickerView`), `ModelPicker` |
| `composer.permission` | Permission chip | Full access, Ask, Auto, Plan | gpui-kit menu. | kit | S | `ComposerControls` (`permissionMenu`) |
| `composer.contextring` | Context ring | Fill ring, orange near full, popover with tokens, login, cost; on a Claude thread, Claude's breakdown of what fills it (`threads.contextUsage`: stacked bar, a row per category, deferred tools, its age and a refresh button) | Drawn ring and `Popover`. | build | S | `ComposerControls` (`ContextRing`, `ContextPopover`) |
| `composer.send` | Send and Stop | Send, Stop (⌘.), spinner when starting | Drawn button with the busy pattern. The arrow hops 3 points as Return sends (`composer.rs` `hopping`; Mike picked it 13 Nov). | build | S | `ComposerControls` (`SendButton`) |
| `composer.schedulefromsend` | Schedule from send | Right-click Send | gpui-kit menu. | kit | S | `ComposerControls` |
| `composer.editing` | Editing banner | Cancel returns the old draft | Drawn. | build | S | `ComposerView` (`EditingBanner`) |
| `composer.starting` | Starting state | Greyed draft with spinner until the thread exists | Drawn. | build | S | `ComposerView` |
| `composer.slash` | Slash palette | Floating, categories, Recent, details pane, Open file | Drawn in-window above the composer, using `Input` and a list. | build | L | `SlashPaletteView`, `SlashPalettePanel`, `SlashCommands` |
| `composer.slash.keys` | Palette keys | Up, Down, Return, Tab, Esc, double-click runs | Key handling in the palette. | build | S | `ComposerView` (`paletteKey`) |
| `composer.slash.resize` | Palette resize | Edge and column drag, remembered, right-click default | Drawn drag handles, saved in the config file. | build | M | `SlashPalettePanel`, `SlashPaletteView` (`ResizeHandle`) |
| `composer.actionchips` | Action chips | Patch shelves on the top edge, badge, "+2" overflow | Drawn. | build | M | `ActionChips` |
| `composer.patchtrust` | Patch to trust chip | Chip above the composer | Drawn. | build | S | `ActionChips` (`WaitingPatchesChip`) |
| `composer.askformore` | Ask-for-more guard | `threadbear` no-pictures rules for other Macs | Port the rule. | build | S | `AppModel+ThreadActions` |

## 8. Cards in the composer

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `card.done` | Done card | Archive, Or carry on list, tick and ? | Drawn card with `TextView`. A card that arrives while the thread's on screen settles in from 6 points below, and the done card's tick draws itself on (`composer_card.rs` `CardArrival`, `drawn_tick`; Mike picked it 13 Nov). | build | M | `ComposerCard`, `RowRenderer` (`asksText`) |
| `card.review` | Review findings | Another lab's findings on the card, each with fixed, disputed or left, and a line opening the review thread | Added section in `card.done` and `card.needsyou`, from `turn.completed`'s `review`. | build | S | `RowRenderer` (`reviewText`) |
| `card.needsyou` | Needs you card | Outlined asks, button rows | Drawn card with blocks for each ask, holding its thread identity (a security fix). | build | L | `ComposerCard`, `RowRenderer` |
| `card.paging` | Paging | ‹ 1 of 3 ›, moves on after a pick | Drawn, with a slide from `Animation`. | build | S | `ComposerCard` (`CardDeck`) |
| `card.collapse` | Collapse | Chevron to heading | Drawn. | build | S | `ComposerCard` (`CardCollapseButton`) |
| `card.innerscroll` | Inner scroll | A tall card scrolls inside | GPUI scroll container. | kit | S | `ComposerCard` |
| `card.somethingelse` | Something else box | Mini composer per ask, placed inside the text | `Input` as a block between the ask's text blocks. | build | M | `AskAnswerBox`, `Cells` (`placeAnswerBoxes`) |
| `card.returnflow` | Return flow | Next unanswered, ⌘Return sends, beep when stuck | Key handling, with the beep sharing the ding's audio in `settings.general`. | build | S | `TranscriptController` |
| `card.answers` | Answer and follow-up state | Picks persisted until sent, ticked items sent with words | Port the logic. | build | M | `AppModel+ThreadActions`, `Decisions` |
| `card.opencomparison` | Open comparison from card | Button opens the review | Drawn. | build | S | `TranscriptController` |

## 9. Highlights

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `highlights.panel` | Panel and folds | Sections hidden when empty, fold remembered for all threads | Drawn foldable sections. | build | M | `HighlightsView`, `HighlightSections` |
| `highlights.librarian` | Librarian line | Where it's up to | Drawn. | build | S | `HighlightsView` |
| `highlights.projects` | Project blocks | Icon, links, ⓘ with Keep, Take out, Open | Drawn, with `Popover` for the ⓘ. | build | S | `HighlightsView` (`ProjectWhyButton`) |
| `highlights.scheduled` | Scheduled list | Click to change | Drawn. | build | S | `HighlightsView` |
| `highlights.subagents` | Sub-agents list | Status, click to read | Drawn. | build | S | `HighlightsView` |
| `highlights.started` | Threads it started | Ordered by state | Drawn. | build | S | `HighlightsView`, `StartedThreadRows` |
| `highlights.pinned` | Pinned, Files, Links | Rows with a note, open in pane | Drawn rows with decoded thumbnails. | build | M | `HighlightsView` (`PaneRow`) |
| `highlights.changes` | Changes | Commits, N files edited opens code | Drawn. | build | S | `HighlightsView` |
| `highlights.rowmenus` | Row menus | File and link menus, Reveal, Copy, Remove, Copy sha | gpui-kit menu, with Reveal going through the open gate. | kit | S | `HighlightsView` (`FileMenu`, `LinkMenu`) |
| `highlights.dragout` | Drag out | Files to other apps | `start_external_drag` on macOS and Wayland; Windows and X11 need our own shim. | shim | M | `FileDrag` |

## 10. Patches panels and web panels

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `patches.list` | Patches list | Trust, Not run yet, Changed, files covered, why not | Drawn. | build | M | `PanelsView` (`PatchesList`) |
| `patches.run` | Patch chips run | Runs an action, spinner, result | Drawn, with the busy pattern. | build | S | `AppModel+Chrome` (`runAction`), `ActionChips` |
| `patches.icons` | Patch icons | Image file or `.app` icon | Image files drawn as is; `.app` icons need macOS code, and Windows and Linux use a generic icon. | shim | S | `PatchImage` |
| `panel.list` | List panel | Native rows refreshed by the runner | gpui-kit list. | kit | S | `PanelsView` (`ListPanel`) |
| `panel.image` | Image panel | Refreshed picture, Open Simulator | Drawn image that refreshes. | build | S | `PanelsView` (`ImagePanel`) |
| `panel.web` | Web panel | Web view kept loaded between visits, its sound paused while it's out of sight; a link to another site opens where Default says, not over the patch's page | Web runtime page in a `CefElement`-style layout slot (Ghostex's approach), X11 only on Linux, and in-window menus can't draw over the page. | web | L | `PanelsView` (`WebPanel`, `WebPanelPool`) |
| `panel.bar` | Panel bar buttons | Reload, Open in browser, Back | Drawn in the panel's bar. | build | S | `PanelsView` (`DockPaneButtons`) |
| `panel.convex` | Convex panel | Dashboard, Dev/Prod switch, sign-in states | Web runtime page with the deploy key injected, and the sign-in states drawn in GPUI. | web | L | `PanelsView` (`ConvexPanel`, `ConvexWebPage`) |
| `panel.requests` | Panel requests | Agent opens a panel for you | Port the logic. | build | S | `PanelRequestModel`, `PanelRequests` |
| `pane.sections` | Pane sections side by side | Highlights, Files, Patches and the panels each draw their own wherever the dock puts them: side by side, stacked or torn out | A view per section over the one pane model (`side_sections.rs`); a press in one makes it the chosen one. | build | S | `PanelsView` (`DockPane`) |
| `panel.projectpage` | Project page panels | Rail on a project | Reuses the right rail. | build | S | `ProjectPage`, `PanelsView` |

## 11. Browser pane

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `browser.pages` | Page list | Agent pages, still, what it's doing | Drawn list from BrowserBear's `tabs.json`. | build | M | `AgentBrowserPanel` |
| `browser.show` | Show window | Brings the real window forward | BrowserBear socket: Unix socket on macOS and Linux, named pipe on Windows (inferred). | shim | S | `AgentBrowserPanel` |
| `browser.handoff` | Your turn and Done | Handoff marks a page | Drawn. | build | S | `AgentBrowserPanel` |
| `browser.address` | New page by address | Field at the top | `Input`. | kit | S | `AgentBrowserPanel` |
| `pane.prs` | Pull requests in the pane | A GitHub PR link opens as a tab beside the thread (Overview with branch, status, checks, description, activity and a comment box; Diff; Checks), with Review, Merge and Close that spin until GitHub answers, and Start a thread or Ask Claude to review | `pr_view.rs` over the pane as a preview (`Target::Pr`); rules in `core/src/pull_requests.rs`; the runner's `github.*` through gh. | build | M | none (GPUI only) |

## 12. File previews and folders

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `file.host` | Preview host | File or page replaces the panel, Back | Drawn pane state. | build | M | `PaneModel`, `HighlightsView` (`PreviewBody`) |
| `file.restore` | Open file kept across restarts | The file or folder open in a thread's pane, and its section, come back after a relaunch | `pane_store.rs`, `desktop-pane.json` in the data folder. | build | S | none (GPUI only) |
| `file.picture` | Picture view | Copy Image, drag out | Drawn image, with original bytes on the clipboard and drag out through `drag.fileout`. | build | S | `HighlightsView` (`FilePreviewView`) |
| `file.video` | Video view | Plays in pane | On a Mac, AVKit's player over the pane (`media_view.rs`), as the Swift pane's: the web runtime's Chromium has no H.264. Sound files (WAV, MP3, M4A, AIFF, CAF, FLAC, AAC) play in the same player, as a bar of controls; the Swift app never did. Windows and Linux open it in its app for now. | hard | L | `HighlightsView` (`FilePreviewView`) |
| `file.quicklook` | Quick Look fallback | PDFs and anything else | On a Mac, PDFKit shows PDFs and Quick Look makes read-only Office and iWork thumbnails from a private snapshot of the checked file (`media_view.rs`). Other systems offer the default app through the open gate. | hard | L | `HighlightsView` (`QuickLookView`) |
| `file.textview` | Text viewer | Selectable, coloured code | gpui-kit code editor, read-only. | kit | M | `TextFileView` |
| `file.markdown` | Markdown preview | Drawn, comfortable width, remembers mode | `TextView`. | kit | M | `TextFileView`, `HighlightsView` (`MarkdownViewMenu`) |
| `file.editor` | Text editor | Edit raw, autosave, ⌘S, line numbers | gpui-kit code editor, with autosave ours (unverified that it shows line numbers). | kit | L | `TextFileView`, `LineNumberRuler` |
| `file.find` | Find in file | Native find bar in the editor | Drawn find bar over the code editor (unverified whether the editor already has one). | build | M | `TextFileView` |
| `file.conflict` | Conflict bar | Take the file's or Keep mine | Drawn, from `TextFileDocument` and file watching. | build | S | `TextFileView` (`ConflictBar`), `TextFileDocument` |
| `file.htmlpreview` | Local HTML preview | Static page with named assets, sealed | A web runtime page in the sealed context, at an `https://<token>.preview.threadbear.invalid` address only its own view answers, from `local_preview::Site` (the Swift rules, ported); every other request cancelled, the main frame held to its page (`threadbear_web::preview_rules`). | hard | L | `LocalPreviewSchemeHandler`, `PreviewSandbox`, `LocalPreviewSite` |
| `file.runthem` | Run them | Consent bar for scripts on those bytes | Drawn consent bar over a web runtime page; the page is served only while its bytes match, with the clipboard and copy guards put in through DevTools before its scripts. | web | M | `HighlightsView` (`LocalPagePreview`), `FirstClick` (`SealedPreviewWebView`) |
| `file.publish` | Publish HTML previews | GPUI experiment | Opening a local HTML page uploads it to Convex file storage (up to 10 MB) as a private link, with Open on web, Private / Anyone with link visibility, Copy link, Update, and Remove. | web | M | GPUI only |
| `folder.list` | Folder list | Sortable columns, expand | `DataTable` with `Tree`-style expansion (unverified that the two combine). | kit | L | `FolderBrowser` |
| `folder.icons` | Folder icons | Thumbnails | macOS: `QLThumbnailGenerator`; Windows and Linux: images decoded in-app and generic icons for the rest. | shim | L | `FolderBrowser` |
| `folder.pathbar` | Path bar | Breadcrumbs, ... menu | Drawn, with a gpui-kit menu. | build | S | `FolderBrowser` (`FolderPathBar`) |
| `folder.keys` | Finder keys | Space Quick Look, ⌘↑, ⌘⇧., back | Key handling, with Space opening `file.quicklook`'s viewer. | build | S | `FolderBrowser` |
| `folder.menu` | Folder menu | Open, Reveal, Copy paths, view, Sort, hidden | gpui-kit menu, with Open and Reveal going through the open gate. | kit | S | `FolderBrowser` |
| `folder.remote` | Remote folders | Other Macs' folders, no thumbnails | Port the listing logic. | build | M | `RemoteFiles`, `FolderListing` |
| `folder.filespanel` | Files panel | Thread's folder from the rail | Reuses the folder list. | build | S | `PanelsView` |

## 13. Terminal

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `terminal.panel` | Terminal panel | Full emulator, per-thread shell, ⌘J, New Shell | `alacritty_terminal` drawn as our own GPUI element, as Ghostex does with libghostty-vt. | build | L | `TerminalPanel` |
| `cards.run` | Run on the card | Taken out 14 Nov 2026: the runAsks experiment was turned off and removed | Not ported: the Swift app's is frozen and the runner no longer offers it. | drop | none | `RowRenderer` (`appendRun`), `AppModel+ThreadActions` (`pressRunButton`) |
| `terminal.putcommand` | Put a command in the Terminal | Play icon on a shell block types it at the prompt, never presses Return, replaces its own unrun command, copies instead if the shell is busy | Icons on the code block, then the terminal's own paste. | build | S | `ShellBlockIcons`, `ShellBlock`, `TerminalPanel` (`Terminals.put`) |
| `terminal.lifecycle` | Shell lifecycle | Starts on request, stops on archive or quit | Unix pty on macOS and Linux, ConPTY on Windows. | shim | M | `TerminalPanel` (`Terminals`) |

## 14. Projects, Librarian, Schedules, Usage, Runners, Connectors, Updates

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `projects.home` | Projects home | Cards, New project, search | Drawn cards with `Input`. | build | M | `ProjectsHome`, `ProjectCards` |
| `projects.list` | Projects list | Sidebar view, Archive, Merge, Delete, copy id | gpui-kit list and menus. | kit | M | `ProjectsList`, `ProjectSections` |
| `projects.page` | Project page | Title, goals, state, notes editing, folders, threads | Drawn page using `Input` and `Textarea`. | build | L | `ProjectPage`, `Projects` |
| `projects.icon` | Project icon | Choose or librarian's | GPUI path prompt, with Reveal going through the open gate. | kit | S | `ProjectPage`, `ProjectIconView` |
| `projects.tasks` | Tasks board page | Status columns from Notion | Drawn columns. | build | M | `ProjectPage` (`TasksSection`) |
| `projects.newthread` | New thread in project | "In" chip | Drawn chip. | build | S | `DetailView` (`NewThreadProjectChip`) |
| `coordinators.home` | Project coordinator home | Experiment `coordinators`: Conversation, Activity, Tasks and Threads tabs; grouped tasks with a detail pane and the same decisions and actions in Highlights, alongside editable project goals, state and notes; one Coordinators sidebar section and Pause or Resume for the coordinator and helpers; conflicting document edits keep the draft and show the current saved text for explicit review before retrying | Drawn project page using the existing thread pane, model picker and project editor. | build | L | (GPUI only) |
| `recipes.view` | Recipes view | Experiment `recipes`: a rail button (counting the recipes on); the sidebar's New recipe, Browse recipes and each recipe added with its switch (moves at once, back with the runner's reason if it says no), and how it's going; the gallery of cards, each with its header picture or colour, its icon on the header's edge, On, Off, Setting up or + Add (spins, then opens the setup thread) and how it's been going | Drawn list and cards. | build | M | (GPUI only) |
| `recipes.page` | A recipe's page | Banner with the switch or Add, about, an example of a run, what it set up, the last 30 days as a strip, its numbers and its log; Change it with an agent and Remove | Drawn page. | build | M | (GPUI only) |
| `recipes.examples` | A recipe's examples | Its made-up runs drawn as a little thread (its title, what started it, the user's message, the agent's reply, its end card) in a box that scrolls, with dots and chevrons to flip between them; All recipes at the top of a page goes back to the gallery | Drawn page. | build | S | (GPUI only) |
| `recipes.habit` | A recipe that's a habit | A recipe whose file has a Habit: its page shows the exact words every thread's agent is told and what they add to each thread; Add is its switch, with no setup thread; when its file's wording isn't the one switched on, both show with Use the new wording | Drawn section. | build | S | (GPUI only) |
| `librarian.page` | Librarian page | Picture, tiles, Look at threads, Runs on | Drawn. | build | S | `LibrarianHome`, `HomePage` |
| `librarian.log` | Librarian log | Recent, Next, Look at everything | Drawn list. | build | M | `LibrarianView` |
| `librarian.picture` | Pokeable picture | Secret lines | Built, with its wobble on a poke (`home_page.rs`, core's `juice::wobble`): GPUI can't turn a picture, so the Swift tilt is a sway of the picture's middle, with the squash as it is. | build | S | `HomePage` |
| `schedule.page` | Scheduled page | Stats tiles | Drawn. | build | S | `ScheduledHome`, `HomePage` |
| `schedule.list` | Scheduled list | Active, Paused, Done, Run now, Edit, Delete | gpui-kit list, menus and dialog. | kit | M | `ScheduledList`, `Schedules` |
| `schedule.editor` | Schedule editor | Message, once or repeat, cron, target, model, machine | Form of `Input`, `Textarea` and menus, with the parsing ported. | build | L | `ScheduleEditor`, `ScheduleText`, `ScheduleModels` |
| `usage.spend` | Usage spend | Today, hour, week, by-hour chart, login colours | gpui-component's chart folder (unverified that it does this chart). | kit | L | `UsagePanel`, `UsageStats` |
| `usage.pools` | Usage pools | Card per pool, windows, pace, Fable week | Drawn cards. | build | L | `UsagePanel`, `AccountUsageText`, `UsageGroups`, `Pools` |
| `usage.sign-in` | Usage sign-ins | Signed out or sign-in ending in days on a login's row, with Sign in…, and a dot on the honey pot | Drawn row. GPUI only: added 16 Nov 2026, after the Swift app froze. | build | S | none |
| `usage.resets` | Usage resets | A login with a usage reset worth using (out of room, or one expiring within 3 days on a week under 70% left): its row's line and Use a reset, a dot and a tooltip line on the honey pot, and "2 resets left" with Use a reset in the login lists | Drawn row and list lines from the runner's `resetHint`. GPUI only: added 26 Nov 2026, after the Swift app froze. | build | S | none |
| `runners.panel` | Runners panel | Online, commit, threads, CPU, memory, disk, reorder | Drawn, with `foundation.reorder`. | build | M | `RunnersPanel`, `RunnersText`, `RemoteRunners` |
| `connectors.panel` | Connectors panel | Services, Connect, check again | Drawn. | build | S | `ConnectorsPanel`, `ConnectorsModel`, `ConnectorsText` |
| `updates.panel` | Updates panel | App, runner, CLIs, From Mike, Bring Them In, Discuss | Drawn. | build | M | `UpdatesPanel`, `UpdatesText` |
| `updates.popover` | Updates popover | Right-click the Updates icon: the app's update in a line, with Restart to Update once it's ready (Return takes it) or Show the Log once a build failed | Drawn popover beside the icon. | build | S | `UpdatesPanel` (`AppUpdatePopover`) |
| `updates.swiftchanges` | Not in the new app yet | A fork's own changes to the old Swift app not yet rebuilt here (protocol "Your changes to the old app"): each with its day, commit and files, Port this (a thread that rebuilds it, then opens) and Dismiss, or a link to the thread already on it | Drawn section in the Updates panel. The port's own: the Swift app has nothing to rebuild. | build | S | none |
| `pocket.phoneonly` | Pocket and phone-only items | Not on the Mac | Not ported: these are phone features. | drop | none | none |

## 15. Settings

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `settings.window` | Settings window | Tabbed, width draggable, up and down move through the sections | Own GPUI window with gpui-kit tabs and a resizable width. | kit | M | `SettingsView` |
| `settings.general` | General | Appearance, ding with sound and volume, default folder, activity log, Updates from Mike | gpui-kit form, but GPUI has no sound API, so the ding needs an audio crate or code on macOS, Windows and Linux. | shim | M | `SettingsView`, `DingPlayer`, `CompletionSound` |
| `settings.models` | Models | Small-jobs pool, private folders | gpui-kit form and GPUI path prompts. | kit | S | `SettingsView` |
| `settings.pools` | Pools | List, rename, order, icon, logins, folders | Drawn, with `foundation.reorder`. | build | L | `SettingsView`, `PoolsModel` |
| `settings.runners` | Runners | Reorder, default | Drawn, with `foundation.reorder`. | build | S | `RunnersSettings` |
| `settings.devices` | Phone & browser | QR code, paired list, Revoke, Open signed in | Drawn, with a QR crate. | build | M | `DevicesSettings`, `DevicesModel` |
| `settings.keyboard` | Keyboard | Rebinding, conflicts, Reset | Drawn capture field over GPUI key bindings, reading our own shortcut list. | build | M | `KeyboardSettings`, `AppShortcuts`, `Shortcuts` |
| `settings.instructions` | Instructions | Standing instructions, Use These, Clear | `Textarea`. | kit | S | `InstructionsSettings`, `InstructionsModel` |

## 16. Options review window

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `review.window` | Review window | Own window with options on a board | Own GPUI window, drawn. | build | L | `ReviewWindow` |
| `review.nav` | Navigation | Tour through pages, up/down options, see everything | Board tour and key handling, drawn. | build | M | `ReviewWindow` |
| `review.zoom` | Zoom and pan | Scroll or pinch to pointer, ⌘0, double-click, Esc | Scroll and keys drawn by us; pinch needs per-OS input on macOS, Windows and Linux (unverified through GPUI's gesture hook). | shim | L | `ReviewWindow` (`ReviewImageScroll`) |
| `review.minimap` | Legacy stage minimap | Jump to part in the frozen Swift viewer | Replaced by the draggable, zoomable board. | none | S | `ReviewWindow` (`ReviewMinimap`) |
| `review.holdspace` | Legacy stage comparison | Flick to today's version in the frozen Swift viewer | Reference pictures sit on the board with the options. | none | S | `ReviewWindow` |
| `review.media` | Videos, sounds and pages | Play where they sit on the board | On a Mac, Play or double-click starts one at a time on the board. Windows and Linux open clips and sounds externally; pages use the web runtime when available. | hard | L | `ReviewWindow` (`ReviewVideo`) |
| `review.picks` | Picks and notes | Tick, None, Send, drafts | Drawn, with `Textarea`. | build | M | `ReviewSession`, `ReviewWindow` |
| `review.openlive` | Open live | Tries a running option | Through the open gate. | build | S | `ReviewWindow` |
| `review.canvas` | The review as a board | Options laid out on a board to drag and zoom, the agent's handwritten notes on the pictures with a switch to hide them, a tour flying through them, and tools to circle, highlight or pin a part that drop numbered chips in the reply | GPUI-only, new in this app (the Swift app is frozen without it). `threadbear-core`'s `review_canvas` lays it out; `gpui/src/review_window/canvas.rs` draws it. | build | L | none (GPUI-only) |

## 17. Navigation, shortcuts, main menu

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `nav.history` | Back/forward history | Threads and pages | Port the logic. | build | S | `Navigation`, `NavigationHistory` |
| `nav.sidebuttons` | Mouse side buttons | Back and forward | GPUI mouse button handling (unverified for side buttons on each OS). | build | S | `Navigation` (`MouseNavigation`) |
| `nav.swipe` | Trackpad swipe nav | Card fills, follows system setting | Risk: GPUI's gesture hook is unverified, data and the system setting differ per OS, and the hand-off from web pages has to work with CEF. | hard | L | `SwipeNavigation`, `NavigationSwipe` |
| `nav.nextinbox` | Next Inbox Thread | ⌥⌘↓ | GPUI key binding. | kit | S | `AppModel+Selection` |
| `nav.openanything` | Open Anything | ⌘K or ⌘P: a box over the window that opens any thread, panel, project or page (Settings' sections too) by name, with Recent and the pages before anything's typed | GPUI-only, new in this app (the Swift app is frozen without it). `threadbear-core`'s `open_anything` for what it lists; `gpui/src/open_anything.rs` draws it and opens the pick. | build | M | none (GPUI-only) |
| `nav.hints` | Hold ⌘ hints | Keys appear beside buttons | Modifier change handler that draws the keys. | build | M | `ShortcutHints` |
| `nav.deeplink` | Deep link | `threadbear://thread/<id>` | `register_url_scheme` and `on_open_urls`. | kit | S | `ThreadbearApp`, `ThreadLink` |
| `menu.app` | App menu | About, Restart to Update, Settings…, Services | `set_menus`: NSMenu on macOS, drawn by `AppMenuBar` on Windows and Linux (inferred). | kit | S | `ThreadbearApp` |
| `menu.file` | File menu | New Thread, Close (⌘W); closing the main window quits, as the last window | `set_menus`, as `menu.app`, with Close as AppKit's `performClose:` on a Mac. | kit | S | `ThreadbearApp`, `AppDelegate` |
| `menu.edit` | Edit menu | Undo, Redo, Cut, Copy, Paste, Delete, Select All; on a Mac AppKit adds Writing Tools, AutoFill, Start Dictation and Emoji & Symbols | `set_menus` with gpui-kit's text actions, the Mac's own selectors for Cut, Copy, Paste and Select All. | kit | S | SwiftUI's standard menus |
| `menu.window` | Window menu | Minimize, Zoom, Bring All to Front; on a Mac AppKit adds Fill, Center, Move & Resize and the open windows (a panel's own too), and View's Enter Full Screen | `set_menus`, the menu named Window being AppKit's windows menu. | kit | S | SwiftUI's standard menus |
| `menu.view` | View menu | Zoom In, Out, Actual, Show Threads, Panels, Terminal, Reset | `set_menus`, as `menu.app`. | kit | S | `ThreadbearApp` |
| `menu.go` | Go menu | Back, Forward, Next Inbox Thread | `set_menus`, as `menu.app`. | kit | S | `ThreadbearApp` |
| `menu.thread` | Thread menu | Archive, Hibernate submenu, Stop, Copy Transcript, Show Inbox, Scheduled, Projects, Librarian, Hibernating, Archived | `set_menus`, as `menu.app`. | kit | S | `ThreadbearApp` |
| `menu.help` | Help menu | Take the Tour, Finish Setting Up | `set_menus`, as `menu.app`. | kit | S | `ThreadbearApp` |
| `nav.copytranscript` | Copy transcript | Markdown | Port `MarkdownExport`, with GPUI's clipboard. | build | S | `ThreadSession`, `MarkdownExport` |
| `nav.shortcuts` | Keyboard shortcuts | The 24 defaults, kept in `shortcuts.json` and watched live | `threadbear-core`'s `shortcuts` for the rules; GPUI key bindings rebound when the file changes. | build | S | `AppShortcuts`, `Shortcuts` |

**The 22 default bindings:** New Thread ⌘N, Archive ⌘E, Hibernate (none), Stop ⌘., Copy Transcript ⇧⌘C, Back ⌘[, Forward ⌘], Next Inbox ⌥⌘↓, Inbox ⌘1, Scheduled ⌘2, Projects ⌘3, Librarian ⌘4, Hibernating and Archived (none), Settings ⌘,, Zoom ⌘= ⌘- ⌘0, Threads ⌃⌘S, Panels ⌥⌘P, Terminal ⌘J, Reset Layout (none). `shortcuts.json` is watched live.

## 18. Drag and drop summary

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `drag.threadout` | Thread row out | Chip on drop, id elsewhere | In-app GPUI drag for the chip; the id reaching other apps is (unverified) and can be left out. | build | S | `ThreadDrag` |
| `drag.fileout` | File or link out | Links, tiles, Highlights rows, folder rows, pane media | `start_external_drag` on macOS and Wayland; Windows and X11 need our own shim. | shim | M | `FileDrag`, `FolderBrowser` |
| `drag.filesin` | Files in | Composer, thread, answer boxes | GPUI file drop, on every OS. | kit | S | `ComposerView`, `AskAnswerBox` |
| `drag.panel` | Panel drag | Section 1 | Counted in `dock.drag`. | build | none | `dock/` |

## 19. System integration

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `system.notifications` | Notifications | When a thread needs you, click opens it | `show_system_notification` and its response callback on all three OS (unverified that a click at cold start opens the thread). | kit | M | `Support` (`Notifier`), `ThreadbearApp` |
| `system.badge` | Dock badge | Count | GPUI has no badge API, so macOS needs `dockTile` code, Windows a taskbar overlay (unverified), and Linux has no equivalent we know of. | shim | S | `AppModel+Chrome` |
| `system.startrunner` | Start runner | launchctl kickstart | launchd on macOS, systemd on Linux, a Windows service on Windows. | shim | M | `Support` (`RunnerLauncher`) |
| `system.selfupdate` | Self-update | Builds from main, stages, swaps | Per-OS swap on macOS, Windows and Linux; Windows can't overwrite a running `.exe` and needs a toolchain to build from source. | shim | L | `AppUpdate` |
| `system.handover` | Seamless handover | New build under the old window, no flicker | `handover.rs`: a second copy started with `open -n`, its NSWindow at alpha 0 under the old one until it's loaded, files in a folder named for the old pid for ready/go/done. Mac only; elsewhere the window goes and comes back. | hard | L | `Handover` |
| `system.crash` | Crash reporting | Sentry from installed release | sentry-rust (inferred), installed releases only and no user text. | build | S | `CrashReporting` |
| `system.hangwatch` | Hang watch | Samples the stuck main thread | Watchdog thread is ours, but sampling is per OS (`sample` is macOS only), and GPUI's `profiler/hang.rs` gives tasks rather than stacks. | shim | M | `HangWatch`, `HangSample` |
| `system.applog` | App log | The connection coming and going, failed requests, notices and scripted commands, for an agent to read | A file: the installed app's `~/Library/Logs/Threadbear/desktop.log`, a scripted app's beside its automation file. | build | S | `AppLog` |
| `system.activitylog` | Activity log | What you click, off by default | GPUI event hook naming controls through the tooltip helper, off by default. | build | M | `ActivityRecorder`, `Activity` |
| `system.swiftimport` | Bringing the Swift app's settings across | Zoom, folded sections, Inbox order, appearance, panel layout, window, the ding, Ask before quitting, link clicks, file views and unsent drafts, once, with a note | Reads the Swift app's defaults with `defaults export` (macOS only, as only the Mac had the Swift app) and its `app-drafts.json`. The port's own: the Swift app has nothing to bring. | shim | S | none |
| `system.testharness` | Scripted test harness | `dev-app.sh` do, dump, shot | `#[gpui_kit::test]`, `TestAppContext` and `render_to_image` (macOS and Linux only), plus our own debug command channel and `dump`. | build | XL | `Automation`, `Automation+Commands`, `Automation+Waiting`, `AppDump`, `Screenshots`, `Perf` |

## 20. Tour, setup, about, juice

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `tour.firstrun` | First-run tour | Dim, spotlight, arrow, hands-on steps, samples | Drawn overlay with a hole, finding targets by tag wherever the dock put them. | build | L | `Tour` |
| `tour.hello` | Setup cards | First launch: one card per decision, logins found, phone, extras, first thread | Drawn over the window (hello.rs). | build | M | (GPUI only) |
| `tour.intros` | One-card intros | First open of a page, pools | Drawn. | build | S | `Tour` (`TourIntro`) |
| `tour.setup` | Finish setting up | Checklist, self-ticking | Drawn. | build | S | `SetupChecklist` |
| `tour.about` | About (the Den) | Waving bear, build, numbers | Own GPUI window, drawn. | build | S | `DenWindow` |
| `juice.archiveflight` | Archive flight | Page snapshot drops into the heading | Built (`archive_flight.rs`, the path in core's `archive_flight`): GPUI can't picture a view or scale and turn one, so a card the page's colour with a transcript's shape on it flies the Swift path, level, in a view of its own over the window, timed by the clock; the next thread fades in under it and the box bounces. Drawn on the main thread, so a stall there holds it where Core Animation's carries on. | hard | M | `ArchiveFlight`, `ArchiveFlightPath` |
| `juice.hibernateflight` | Hibernate flight | Sinks into the moon | Built with `juice.archiveflight`: sinks, dimming, into the moon, which dips as it lands. The next thread doesn't rise as it fades in (8 pt in the Swift app). | hard | S | `ArchiveFlight` |
| `juice.opening` | Threads coming in | A thread eases in as it opens, from the way the arrows walked; the new-thread page fades up; its box drops to the bottom on the first send; a new name fades in | The port's own, from mockups Mike picked on 13 Nov (`open_motion.rs`): the transcript is drawn in place from the first frame, a little faint and a few points off, easing in over 0.13 s; the box is painted where its drop has got to, as the sidebar's glides are. Off with Reduce Motion. | build | S | none |
| `juice.inboxzero` | Inbox zero bear | Rises and waves, asleep after bedtime | Not porting the bear: Mike passed over the bears on 13 Nov. Confetti instead, from his pick of 18 Nov (`juice.confetti`). | build | M | `Juice`, `InkLayers` |
| `juice.confetti` | Confetti for rare wins | (GPUI only) | A burst of coloured bits from where it happened (`confetti.rs`, the bits in core's `confetti`): the empty inbox's note when Mike archives or hibernates the Inbox's last thread, a login's Usage row when it gets a year-long token or is signed back in (or the thread's sign-in line), a thread milestone's note, and "All set." as Finish setting up's last item ticks. Mike picked it over a tick and glow and a paw stamp on 18 Nov, for rare wins only. Only from an anchor on screen; none under Reduce Motion. | build | S | none |
| `juice.pickfill` | A picked answer fills | (GPUI only) | The button fills with the accent from the left under its words and hops (`composer_card.rs` `picking_button`, core's `juice::pick_fill`); an answer in rows, and a follow-up on the done card, pop their ring as the tick draws in. GPUI can't scale a button, so no press. From Mike's pick of 18 Nov; not under Reduce Motion. | build | S | none |
| `juice.picturedrop` | A pasted picture drops in | (GPUI only) | The strip over the words eases open and the thumbnail comes down into it, a touch past and back, fading in (`composer.rs` `render_strip`, core's `juice::picture_drop`). 18 Nov; not under Reduce Motion. | build | S | none |
| `juice.replyfade` | Replies fade in | (GPUI only) | What a streaming reply adds fades in word after word (`rows/markdown.rs`, the kit's `TextViewMotion` stream fade with core's `juice::REPLY_FADE`). Only appended text fades; a row drawn whole is there at once. 18 Nov; not under Reduce Motion. | build | S | none |
| `juice.panebear` | Pane bear | Waves over new thread page | Not porting: Mike passed over the bears on 13 Nov. | build | S | `Juice` (`PaneBear`) |
| `juice.workingbear` | Working bear secrets | Waves back on hover, hops on click | Not porting the bear: Mike passed over it on 13 Nov and prefers the paw, which moves instead (`transcript.working`). | build | S | `WavingBearView` |

## Planned features

Planned and experimental work a desktop client must handle. `hello.experiments` tells a client which experiments are on, so each experiment row is gated on it. Items that are runner only, web only, phone only or just an idea are left out, as is `keepAwake`, which is runner only.

Size is `none` throughout: the planning docs don't size these, and work the app already has is sized on its own row above.

| ID | Feature | What it does | How in GPUI | Route | Size | Swift |
|---|---|---|---|---|---|---|
| `planned.cloud.sandboxes` | Cloud sandboxes | Runner in a throwaway VM, shown as a remote peer | Built as virtual runners (the `virtual.*` rows): one Runs on entry per virtual runner, never a box per thread in the runner lists. | build | none | none |
| `virtual.runs-on` | Virtual runners in Runs on | A thread started on a machine of its own in the cloud (docs/virtual-runners.md) | After the machines, one entry per virtual runner (`services`), its folder and login this Mac's, sent with `serviceId`; a box's runner is never listed as a machine (`new_thread.rs`, `remote.rs`). GPUI only: the Swift app is frozen. | build | S | none |
| `virtual.rows` | A box thread's row | Starting a machine, Waking, Asleep, Needs a cloud token | `sidebar.rs box_trailing` in core; needing a token takes the needs-you dot (`dress_box`). | build | S | none |
| `virtual.token-card` | The token card | Make one, Paste a token, or this Mac's year-long token, in the thread | On the composer, as the limit box is (`token_card.rs`). | build | M | none |
| `planned.schedule.anyrunner` | Any-runner schedules | First runner to reach it claims the run | A "no runner" option in `schedule.editor` (not confirmed as built). | build | none | none |
| `planned.runner.smarterchoice` | Smarter runner choice | Picks the runner for a new thread | Changes what `composer.runner` offers (not confirmed as built). | build | none | none |
| `planned.sync.fullconvex` | Full Convex | Drops the Tailscale link, runner tokens and pairing by token | Changes how `foundation.rpc` reaches other runners; `sync.full` exists but is off by default. | build | none | none |
| `planned.sandbox.leftovers` | Disposable sandboxes' leftovers | Keeps screenshots and bodies when a runner vanishes | Show what's kept once its runner is gone (not designed, unverified what the client gets). | build | none | none |
| `planned.acp.gaps` | ACP gaps | Usage readings, sandbox, rewind and CLI updates are missing for some providers | Hide those controls per provider, from `ProviderInfo`. | build | none | none |
| `planned.connectors.google` | Google in connectors | A guided step for Google in the connectors flow | A step in `connectors.panel` (status of this work not checked). | build | none | none |
| `planned.sync.remotebodies` | Other machines' tool output | Tool output, diffs and pictures stay on that Mac for now | `transcript.heldback` fetches them today, and `sync.full` lifts the limit. | build | none | none |
| `planned.exp.labreview` | Lab review (`labReview` setting) | Another provider reviews code changes; standard since 10 Nov, with a switch in Settings > General | The thread hibernates and a note row links the review; the settings window needs the Code review switch. | build | none | none |
| `planned.exp.richblocks` | Rich blocks | Agents are told about mermaid and html blocks (standard since 10 Nov) | Needs `rich.mermaid` and `rich.html` in the web runtime and their sandbox. | web | none | none |
| `planned.exp.schedulechecks` | Schedule checks (standard since 11 Nov) | A shell check gates a schedule run | Agents write the `check` field, and `schedule.editor` must keep it on save (unverified how saves treat a missing field). | build | none | none |
| `planned.exp.looseends` | Loose ends (`looseEnds`) | "Still open" and "Coming back" on the done card | Added sections in `card.done`. | build | none | none |
| `planned.exp.inboxguess` | Inbox guess (`inboxGuess`) | Not in the Swift app: its done card's Archive archives straight off | With the experiment on, the done card's Archive opens a menu, "Didn't need this", "Glad I saw this" or "Not sure", and sends the pick as the archive's `verdict` (`archive_from_card`). | build | none | none |
| `planned.exp.replybuttons` | Reply buttons | Pills in replies that agents create and update (standard since 11 Nov) | `rich.replybuttons`. | build | none | none |
| `planned.exp.instructions` | Standing instructions | A Settings box applied to every session (standard since 11 Nov) | `settings.instructions`. | kit | none | none |
| `planned.exp.movetorunner` | Move to runner (standard since 12 Nov) | Move a thread to another machine | `sidebar.move` plus the row menu and moving row, started only from the first Mac today. | build | none | none |
| `planned.exp.acpagents` | ACP agents (`acpAgents`) | OpenCode and Cursor threads | Drive every provider choice from `ProviderInfo` rather than hardcoding two, and don't copy the web's `modelLabel`. | build | none | none |
| `planned.exp.cardreviewer` | Card reviewer (standard since 20 Nov) | Opus pre-reviews Auto cards | No new UI: a transcript note says "Allowed by the reviewer". | build | none | none |
| `planned.exp.fastmode` | Fast mode (`fastMode`) | Standard or Fast per Claude thread, `/fast` | The Speed row in `composer.modelpicker` and a chip suffix. | build | none | none |

## Route counts

**Per route**

| Route | Inventory | Planned | All |
|---|---|---|---|
| kit | 65 | 1 | 66 |
| build | 197 | 16 | 213 |
| web | 6 | 1 | 7 |
| shim | 24 | 0 | 24 |
| hard | 13 | 0 | 13 |
| drop | 3 | 0 | 3 |
| Total | 307 | 18 | 325 |

**Per size**

| Size | Inventory | Planned | All |
|---|---|---|---|
| S | 170 | 0 | 170 |
| M | 95 | 0 | 95 |
| L | 33 | 0 | 33 |
| XL | 5 | 0 | 5 |
| none | 4 | 18 | 22 |
| Total | 307 | 18 | 325 |

**The `hard` rows**

- `foundation.richtext` (Rich text engine, XL)
- `dock.detached` (Detached panel windows, L)
- `sidebar.swipe` (Swipe row to archive, M)
- `composer.picturechips` (Picture chips, L)
- `file.video` (Video view, L)
- `file.quicklook` (Quick Look fallback, L)
- `file.htmlpreview` (Local HTML preview, L)
- `review.media` (Video and HTML shots, L)
- `nav.swipe` (Trackpad swipe nav, L)
- `system.handover` (Seamless handover, L)
- `juice.archiveflight` (Archive flight, M)
- `juice.hibernateflight` (Hibernate flight, S)
