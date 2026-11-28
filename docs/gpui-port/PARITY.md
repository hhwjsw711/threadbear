# GPUI port: parity

What the GPUI app does compared with the Swift app, worked out from which
behaviour specs pass (`features/`). The table is written by
`node features/parity.mjs` from each machine's report. Don't edit it by hand.

A blank cell means no spec covers that yet, not that the feature is missing.
The full list of features is [features.md](features.md).

## The table

Mac picture input is covered by `features/composer-media.feature`: a
temporary screenshot deleted as the native drop ends, browser image bytes,
HEIC-only pasteboards, Photos' image data beside another file, promised
photos, URL downloads and cutting a chip while its picture loads. The actual
floating screenshot thumbnail gesture is not scripted (`@manual`); the first
scenario covers its source-file lifetime. Windows and Linux still use their own
clipboard representations and the existing file-drop scenarios.
The Mac promise check uses a real source app on Tinker Desk's desktop, with
`TB_REAL_SCREEN=1`; the bundle cases exercise the legacy receiver contract.
On 13 November, all 24 picture scenarios that do not move the pointer passed,
including a busy turn with words and a loading picture, Stop while only a
picture is loading, a delayed file open that leaves typing responsive and
uses already captured image bytes,
a protected file's image bytes,
original file bytes beside a TIFF preview, a missing file's icon,
private-network URLs and redirects,
a withdrawn promise, a working promise beside a missing path, a readable file
beside a withdrawn promise and HEIC in a
card's answer box. Rust tests cover cancellation after partial promise receipt,
late callbacks and filtering the socket addresses used for downloads. The real
cross-app promise drag also passed separately. The message-chip scenario waits
for the picture to finish importing before Return; the Windows failure at
e9903bf4d left the draft unsent because Return arrived while the picture loaded.
These focused runs do not refresh the combined table below, which records the
earlier four-platform run.

<!-- parity:start -->

125 of 329 features have a spec so far, across 225 scenarios.

Scenarios passing: Swift: 207 of 225, Mac: 214 of 225, Windows: 192 of 225, Linux: 214 of 225.


### 0. Foundations everything else needs

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `foundation.rpc` Runner RPC client | pass | pass | pass | pass |
| `foundation.zoom` Zoom | partly | pass | pass | pass |

### 1. Windows and panel dock

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `dock.layout` Layout tree | pass | pass | pass | pass |
| `dock.titlebar` No title bar | pending | pending | pending | pending |
| `dock.frame` Window frame memory | pending | pending | pending | pending |
| `dock.reset` Default layout and Reset | pass | pass | pass | pass |

### 2. Rails

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `rail.activity` Activity bar | pass | pass | pass | pass |
| `rail.dots` Rail dots | pass | pass | pass | pass |
| `rail.right` Right rail | partly | pass | partly | pass |

### 3. Sidebar and inbox

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `sidebar.sections` Sections | pass | pass | pass | pass |
| `sidebar.sort` Inbox sort | pass | pass | pass | pass |
| `sidebar.search` Thread search | pass | pass | pass | pass |
| `sidebar.newthread` New thread button | pass | pass | pass | pass |
| `sidebar.row` Thread row | pass | pass | pass | pass |
| `sidebar.row.marks` Row left marks | pass | pass | pass | pass |
| `sidebar.row.origin` Origin mark | pass | pass | pass | pass |
| `sidebar.row.status` Row right status | pass | pass | pass | pass |
| `sidebar.row.remote` Other-Mac icon | pass | pass | pass | pass |
| `sidebar.row.hoverbuttons` Hover buttons | pass | pass | pass | pass |
| `sidebar.row.menu` Row context menu | pass | pass | pass | pass |
| `sidebar.subagents` Sub-agent tree | pass | pass | pass | pass |
| `sidebar.archived.paging` Archived paging | pass | pass | pass | pass |
| `sidebar.skeleton` Loading skeleton | pass | pass | pass | pass |
| `sidebar.hibernate.presets` Hibernate presets | pass | pass | pass | pass |
| `sidebar.hibernate.pick` Pick a time | pending | pending | pending | pending |
| `sidebar.hibernate.wake` Wake when… | pass | pass | pass | pass |
| `sidebar.move` Move to another runner | pass | pass | pass | pass |

### 4. Thread header, banners, toasts

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `header.title` Title line | pass | pass | pass | pass |
| `header.backforward` Back and forward | pass | pass | pass | pass |
| `header.share` Share | pass | pass | pass | pass |
| `header.more` ... menu | pass | pass | pass | pass |
| `banner.connection` Connection banner | pass | pass | pass | pass |
| `banner.error` Error banner | pass | pass | pass | pass |
| `banner.limit` Limit banner | pending | pass | pending | pass |
| `toast.archived` Archived toast | pass | pass | pass | pass |
| `toast.inboxend` Inbox end toast | pass | pass | pass | pass |
| `thread.newpage` New-thread page | pass | pass | pass | pass |

### 5. Transcript row kinds

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `transcript.list` The transcript list | pass | pass | pass | pass |
| `transcript.user` Your bubble | pass | pass | pass | pass |
| `transcript.reply` Assistant reply | pass | pass | pass | pass |
| `transcript.thinking` Thinking line | pass | pass | pass | pass |
| `transcript.tool` Tool line | pass | pass | pass | pass |
| `transcript.tooloutput` Tool output styling | pass | pass | pass | pass |
| `transcript.diff` Diff row | pass | pass | pass | pass |
| `transcript.images` Images row | partly | pass | pass | pass |
| `transcript.approval` Approval card | pass | pass | pass | pass |
| `transcript.approval.stacked` Stacked approval | pass | pass | pass | pass |
| `transcript.approval.settled` Settled approval | pass | pass | pass | pass |
| `transcript.question` Question card | pass | pass | pass | pass |
| `transcript.secret` Secret card | pass | pass | pass | pass |
| `transcript.review` Review card | pass | pass | pass | pass |
| `transcript.turnfooter` Turn footer | pass | pass | pass | pass |
| `transcript.error` Error row | pass | pass | pass | pass |
| `transcript.workedfor` Worked-for group | pass | pass | pass | pass |
| `transcript.working` Working line | pass | pass | pass | pass |
| `transcript.changes` Changes card | pass | pass | pass | pass |
| `transcript.rowmenu` Row context menu | pass | pass | pass | pass |

### 6. Rich content inside a reply

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `rich.browserbear` BrowserBear tab handover | pending | pass | pending | pass |

### 7. Composer

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `composer.textbox` Text box | pass | pass | pass | pass |
| `composer.return` Return, Shift-Return | pass | pass | pass | pass |
| `composer.listcontinue` List continuation | pass | pass | pass | pass |
| `composer.picturechips` Picture chips | pass | pass | pass | pass |
| `composer.chiphover` Chip hover and × | pass | pass | pass | pass |
| `composer.filedrop` File path drop | pass | pass | pass | pass |
| `composer.dropanywhere` Drop anywhere on thread | pass | pass | pass | pass |
| `composer.runner` Runner chip | pass | pass | pass | pass |
| `composer.modelpicker` Model picker | pass | pass | pass | pass |
| `composer.permission` Permission chip | pass | pass | pass | pass |
| `composer.contextring` Context ring | pass | partly | partly | partly |
| `composer.send` Send and Stop | pass | pass | pass | pass |
| `composer.starting` Starting state | pass | pass | pass | pass |
| `composer.slash` Slash palette | pass | pass | pass | pass |
| `composer.slash.keys` Palette keys | pass | pass | pass | pass |

### 8. Cards in the composer

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `card.done` Done card | pass | pass | pass | pass |
| `card.needsyou` Needs you card | pass | pass | pass | pass |
| `card.collapse` Collapse | pass | pass | pass | pass |
| `card.somethingelse` Something else box | pass | pass | pass | pass |
| `card.returnflow` Return flow | pass | pass | pass | pass |
| `card.answers` Answer and follow-up state | pass | pass | pass | pass |

### 9. Highlights

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `highlights.panel` Panel and folds | pass | pass | pass | pass |
| `highlights.librarian` Librarian line | pass | pass | pass | pass |
| `highlights.projects` Project blocks | pass | pass | pass | pass |
| `highlights.scheduled` Scheduled list | pass | pass | pass | pass |
| `highlights.subagents` Sub-agents list | pass | pass | pass | pass |
| `highlights.started` Threads it started | pass | pass | pass | pass |
| `highlights.pinned` Pinned, Files, Links | pass | pass | pass | pass |
| `highlights.changes` Changes | pass | pass | pass | pass |
| `highlights.rowmenus` Row menus | pass | pass | pass | pass |

### 10. Patches panels and web panels

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `patches.list` Patches list | pass | pass | pass | pass |
| `patches.run` Patch chips run | pass | pass | pass | pass |
| `panel.list` List panel | pass | pass | pass | pass |
| `panel.image` Image panel | pass | pass | pass | pass |

### 11. Browser pane

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `browser.pages` Page list | pending | pass | pending | pass |
| `browser.show` Show window | pending | pass | pending | pass |
| `browser.handoff` Your turn and Done | pending | pass | pending | pass |

### 12. File previews and folders

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `file.host` Preview host | pass | pass | pass | pass |
| `file.picture` Picture view | pass | pass | pass | pass |
| `file.textview` Text viewer | pass | pass | pass | pass |
| `file.markdown` Markdown preview | pass | pass | pass | pass |
| `folder.list` Folder list | pass | pass | pass | pass |
| `folder.pathbar` Path bar | pass | pass | pass | pass |
| `folder.menu` Folder menu | pass | pass | pass | pass |
| `folder.filespanel` Files panel | pass | pass | pass | pass |

### 13. Terminal

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `terminal.panel` Terminal panel | pending | pending | pending | pending |
| `terminal.putcommand` Put a command in the Terminal | pending | pending | pending | pending |

### 14. Projects, Librarian, Schedules, Usage, Runners, Connectors, Updates

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `librarian.page` Librarian page | pass | pass | pending | pass |
| `librarian.log` Librarian log | pass | pass | pending | pass |
| `schedule.page` Scheduled page | pass | pass | pending | pass |
| `schedule.list` Scheduled list | pass | pass | pending | pass |
| `schedule.editor` Schedule editor | pass | pass | pending | pass |

### 15. Settings

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `settings.window` Settings window | pass | pass | pending | pass |
| `settings.general` General | pending | pass | pending | pass |
| `settings.models` Models | pending | pass | pending | pass |

### 17. Navigation, shortcuts, main menu

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `nav.history` Back/forward history | partly | pass | partly | pass |
| `nav.sidebuttons` Mouse side buttons | pass | pass | pass | pass |
| `nav.nextinbox` Next Inbox Thread | pass | pass | pass | pass |
| `menu.app` App menu | pass | pass | pass | pass |
| `menu.file` File menu | pass | pass | pass | pass |
| `menu.view` View menu | pass | pass | pass | pass |
| `menu.go` Go menu | pass | pass | pass | pass |
| `menu.thread` Thread menu | pass | pass | pass | pass |
| `menu.help` Help menu | pass | pass | pass | pass |
| `nav.shortcuts` Keyboard shortcuts | partly | pass | pass | pass |

<!-- parity:end -->

The slice log, one entry a slice with how each was checked, is [LOG.md](LOG.md).
