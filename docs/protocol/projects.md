# Runner protocol: Projects and schedules

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

## Projects

A project groups threads above folders: it can have several folders, a
thread can be in several projects, and it keeps `goals`, `state` and
`notes` that carry forward from thread to thread. Nobody has to make one:
the librarian and the agents do. Kept in `projects.json` in the data dir;
which projects a thread is in is kept with the thread.

Projects don't nest. A `parentId` that an older runner saved, or an older
app sends to `projects.create` or `projects.update`, is dropped: projects
nested inside another until 28 Nov 2026 load as projects of their own.

**Patches.** A thread loads patches from, in this order: `~/.threadbear/`,
each folder of each of its projects (the built-in ones and the patch
files found walking up from it, each folder once), then its own folder
as before. Anything from a project folder has `folder` and `projectId`
set and runs in that folder; a hook from one only runs after a turn that
edited a file inside it, matched against its `edited` glob relative to
it. Two items that would share an id get the folder's name in front, the
later one only (`poddle:convex.dashboard`). A thread in a git worktree
reads a project folder in that repo's main checkout from the worktree's
copy of it instead, and skips it when its own folder already covers it:
the main checkout is the same repo on another branch, so loading both
gave every chip twice.

**The brief.** A session is told about its thread's projects once each.
A fresh session (a new thread, a move or account change that starts a new
native session) gets the brief as instructions: each project's title,
folders, goals and state, at most about 2,000 characters in all, and that
`read_project` has the notes. Claude gets it appended to the system
prompt, Codex as developer instructions. A live or resumed session (Claude
Code ignores new instructions on a resume) hears about a project it hasn't
been told about at the start of its next message, in a line beginning
`[Threadbear project]`; a session from before projects existed gets the
whole brief that way. An agent that joined a project itself isn't told.

**The librarian** is the runner's own background job that keeps projects
up to date, on the small model (`models.*`, feature `projects`, inside the
daily budget, never for private folders). It looks at a thread when:

- its first message comes in (`first-message`), 5 seconds later, so a
  thread is filed while a long first turn is still going; that look
  never changes a project's state;
- its first turn ends (`first-turn`), 10 seconds later;
- a turn edits files outside its folder and its projects' folders
  (`new-folder`), 10 seconds later;
- it moves folder (`moved`);
- it has had turns since the last look, 20 minutes after that look at
  the soonest (`catch-up`). A catch-up is skipped, with no model call, when
  those turns edited no files, ran no commands in a repo outside its
  folder and its projects' folders, gave no link and said fewer than 400
  characters between Mike and the agent; it counts in `skippedToday`, and
  what they said still counts towards the next one;
- someone asks (`librarian.run`, `asked`);
- another thread is hibernating until it has done something (end_turn's
  `waitFor` with `until`): after any completed turn, its CLI's own too,
  10 seconds later (`waited-on`, never skipped as quiet). The look lists
  those threads and their `until`, and its answer's `met` gives each a verdict
  (`{ "<id>": { "met": true|false, "why": "what shows it" } }`); only
  `met: true` with a `why` marks the wait done (`waitMet`), with this
  thread's latest reply; the waiter wakes once all its waits are done. A
  private folder's thread gets no looks, so a wait on one only ends at
  its time.

Those come from the runner's events, and a turn that ends in an older
runner draining after a handover is only heard there. So on start and
every 5 minutes the librarian also queues any thread active in the last
two days with a finished turn it hasn't looked at since (`first-turn` or
`catch-up`).

A thread its own agent or Mike has put in a project (`by` other than
`"librarian"`) is theirs to file: its looks still keep its line and the
state of its projects, but never add or take out a project. Every
thread's agent is told, in the Threadbear tools' instructions, to
`join_project` early and keep the state current with `update_project`.

One look at a time, the soonest due first. A look sends the model the
project list (title, folders, goals, one line of state) and the thread's
title, folder, first message, last few messages and the folders it edited
in, and gets back the projects the thread belongs in with a short reason
for each, a new project when none fits, and a new `state` for a project
the thread moved on. What it decides takes effect straight away: the
thread gets `projects` (`by: "librarian"`, `why` the reason, replaced by a
later look's) and a `system.note` saying so ("Put in Threadbear"), and
Mike can take it out (`threads.setProjects`), after which it's never put
back. It never takes out a pinned project or one an agent added.
A project the thread isn't in yet needs a reason that says it fits: an
id with no reason, or one like "Not that; ignore", is dropped and
logged, and a thread nothing clearly fits stays unfiled.

The folders it gives a project (a new one's, or `addFolders`) are only
repos no other project has, sits inside or holds, and never a folder in
a git worktree: a guessed folder pulls in every later thread that works
there. A new project whose repos all belong to other projects isn't made
(the thread is that project's work), though one with no folders at all
(a house job) still is. Mike and agents can still share a folder between
projects on purpose.

Leaving a project out of its answer doesn't take the thread out of it, so
it doesn't flap from turn to turn. A look takes the thread out of one of
its own guesses when its answer says to (`leave`, with why: "Took it out
of Convex components directory: not a components thread"), on any look,
and also when a move or an ask leaves it out. That isn't remembered as a
no the way Mike's is: a later look can put it back. Looks are listed in
`LibrarianStatus.recent`.

Looks (and icon picks) run on the Claude pool, like every small job.
Without a pool with a Claude login (`models.pool` null, or a pool with
none), or while every login in it is out of room, the queue waits
(`state: "off"`) and tries again later.

**Titles.** A look also says whether the thread's title still fits, and
gives a new one when the work has moved on or the title is only its first
message's opening words. It takes effect straight away, tidied like any
model title, and the look's entry says so ("Renamed it ..."). Never on a
`first-message` look (the title model has only just named it), never over
a title Mike or an agent set (`titleSet`), and not if the title changed
while the model was answering. A librarian title doesn't set `titleSet`,
so a later look can rename it again. No extra model call: it's the same
look.

The same look renames a project the thread is in whose name has gone out
of date: the thing it's about was renamed ("Chrome browser control" after
Paws became BrowserBear), or the work got a name of its own. The entry
says "Renamed <old> to <new>", and the project's `titleBy` becomes
`librarian`. Never on a `first-message` look, and never a project Mike
named (`titleBy`, else `createdBy`, is `mike`): one he made or renamed in
the app, or one an agent named because he asked (`update_project`'s
`mikeAsked`). The prompt marks those, and a name it sends for one anyway
is dropped. Names from the librarian or an agent can be renamed again.

**Icons.** The librarian gives each project an icon and keeps it up to
date. It looks through the project's folders for the picture the project
already has, by file name and place, no model needed: an Xcode
`AppIcon.appiconset`, an `.icns`, an `apple-touch-icon` or `icon-512.png`,
a Chrome extension's or Expo app's manifest icon, a picture named after the
project in an `icons/` folder, then favicons and logos. Wide pictures,
template (menu bar) icons, other image sets, and anything under
`node_modules`, build output, docs or tests are passed over, as is one
under a folder named for something else (`public/inventory/icon.svg` is
the inventory's). A manifest's icon counts only if it's named like a
picture and is a file of the repo's own, not a link out of it. The best is
copied in, so the app never reads a repo, and only if its bytes say it's a
picture; on Linux ImageMagick gets it with its decoder named (never one it
picks, as its MSL and MVG ones are scripts). A picture is a candidate, and is copied, only when its own
structure, read here without decoding it, says how big every picture in it
is and that's within the icon budget (`runner/src/icon-budget.ts`: 4096 px
a side, 4096 x 4096 px and 64 MB decoded in all, at most 32 pictures in an
`.ico` or `.icns`), so a small file that says it's 60,000 px square is
never decoded (Daybreak, 24 Nov). Only PNG (whole and well formed, not
animated, its compressed text and colour profile within 1 MB inflated), ICO
(PNG or uncompressed bitmaps) and ICNS (PNG and the old fixed-size
elements; no JPEG 2000 or nested sets) are icons. JPEG and WebP aren't, as
what a decoder makes of them can't be told from their headers for sure, and
nor is SVG: it's a program for its renderer more than a size, and three
review rounds each found a way past a check of its text (a picture inside
it, CDATA, namespace prefixes, CSS sizing, a mask fan-out), so it waits for
a real parser. What's copied is the one read and checked, made into a PNG
of at most 256 px (ImageMagick also told the budget), never the file as it
was: when the best picture can't be made into one here (an `.icns` on Linux) the next best is tried,
and with none the project gets a symbol. A copy an older runner kept that
isn't such a PNG (the repo's file as it was, or an SVG) is dropped as the
runner starts, before any app is sent its path, and the project goes back
to automatic (even one Mike chose); the phone is sent no picture outside
the budget. The desktop app decodes an icon (only a PNG) within the
same budget. It
looks again a few seconds after a project is made or its folders change,
and every hour at all of them, copying again when the file has changed or
a better one has turned up. A project with no picture gets an SF Symbol:
one small-model call (feature `projects`, in the budget, not while paused,
never for a private folder) choosing from a fixed list. One Mike or an
agent chose (`projects.setIcon`, `update_project`'s `icon`) is never
changed by the librarian.

**No fix threads.** From 30 Oct to 2 Nov 2026 a look could start a thread
to fix a problem Mike mentioned with his tools. It was removed before going
public: on someone else's Mac it started threads that edited and landed
code they hadn't asked for, and Mike starts those threads himself or has a
schedule look for them. A look gets a message's words but not its images,
so each message with images is marked as having some. An older
`librarian.json` may still hold `fixes`, which is ignored.

**Links.** A project keeps up to 8 links: the places Mike keeps going
back to for it (its live site, admin page, dashboard, store listing), not
one-off pages or pull requests. The app shows them at the top of each of
its threads' Highlights, under the project's icon and title. Agents set
them with `create_project` and `update_project` (`links` replaces them,
`addLinks` adds or retitles by url, `removeLinks` takes some off), and
Mike with `projects.update`. The librarian's look can add ones the
thread's messages give for a project the thread is in (`links` in its
answer): only a url that's in what it was sent, never more than 8, and it
never takes one away. Merging two projects keeps both lots.

**Agents** have tools for projects (see Tools for agents):
`list_projects`, `read_project`, `create_project`, `update_project`,
`join_project` and `leave_project` (each for their own thread by default).
An agent's join is pinned. `update_project` changes notes three ways:
`editNotes` (a list of `{ old, new }`, like Claude Code's Edit: each `old`
must be in the notes exactly once, after the edits before it, and an empty
`new` takes it out; one that doesn't match refuses the whole call),
`appendNote` (a paragraph on the end, which can follow `editNotes` in the
same call) and `notes` (all of them, for a restructure; not with
`editNotes`). The runner that keeps the projects reads, edits and saves
the notes in one step (`editNotes` on it, a `drain.projects` op too), and
after a card it refuses the call if the notes aren't the ones judged.

### Project tasks

A project can name a Notion page (`notion`) with its task board on it: a
database with a Status column, like a Notion board. The runner reads it
through the Connectors gateway (see Connectors), with the main Claude
login's `connectors` entry in `~/.claude.json` (its URL and its
`headersHelper`, which prints the Authorization header;
`runner.json`'s `connectors.headersHelper` can name another). So it's the
same Notion login the agents use, and the runner keeps no Notion key.

It finds the database on the page (the one called Tasks, else the first;
a database or a `collection://` address is used as it is) and one of its
views with no filter, then reads the rows through that view every 5
minutes, and when the project page asks (`projects.refreshTasks`):
`notion__notion-query-data-sources` in view mode, 100 a page, 300 at
most. Not rows or SQL mode: Notion caps those per workspace, and two dozen
boards used the allowance up in minutes (30 Oct); view queries don't
count. A database with only filtered views is read in rows mode. Boards are read three at a time: the gateway allows 32 calls in flight, agents' included, and 73 boards read together went past it. The
columns (`notion__notion-fetch` of the data source) are read again every
30 minutes, or when a card is in a column they don't have. The last board
is kept in `project-tasks.json` in the data dir, so a restart shows it at
once.

```ts
// On Project
notion?: string        // the page (or database) Mike or an agent set
tasks?: ProjectTasks   // with notion only

type ProjectTasks = {
  url: string          // the database to open in Notion
  columns: { name: string; kind: "todo" | "doing" | "done"; color?: string }[]
                       // the Status options in Notion's order; kind is the
                       // option's group (To do, In progress, Complete)
  items: {
    id: string; title: string; url: string
    status: string     // a column's name
    who: string[]      // a Who / Assignee / Owner multi-select or people
    due?: string; dueEnd?: string // the first date property, ISO
    thread?: string    // a text property called Thread: a thread id or prefix
  }[]
  fetchedAt?: string
  loading?: boolean    // not read yet
  error?: string       // the last read failed; the rest is the last good board
  more?: boolean       // over 300 rows
}
```

A thread's Highlights lists up to 4 open cards under each of its
projects: the one whose Thread is this thread first, then those in an
In progress column, then To do; more opens the project page.

Threadbear only shows the board; cards are moved in Notion, by people
or by agents with the Notion tools. `read_project` lists the open cards,
and a thread's brief has one line saying the board is there and how many
are open. With no gateway, `error` says so.

## Schedules

A schedule sends a message at a set time, once (`at`) or over and over
(`cron`), like Convex's scheduled functions and crons. It either sends to
a thread that already exists or starts a new thread each time. They're
kept in `schedules.json` in the data dir.

The desktop composer's quick send times (beside Send, and its right-click)
are ordinary one-off schedules with `at` filled in, made through the same
editor and `schedules.create`, with no call of their own: tonight at 21:00
and tomorrow at 09:00 in the app's zone, or a minute after a known reset.
The reset is when the box's login, or the first of its pool's logins of
the box's provider, has room again as `backAt` in `runner/src/pools.ts`
works it out (every 5-hour or weekly window under 1% has reset; blocked
with none, its tightest), or with room, the next reset of a used window.
Stale readings, a signed-out login or a missing reset give none. A pool's
schedule keeps `poolId` (and `provider`), so the run still picks its login.

- **Cron.** Five fields: minute, hour, day of month, month, day of week
  (0 or 7 is Sunday), with `*`, lists (`1,15`), ranges (`1-5`), steps
  (`*/15`, `9-17/2`) and names (`jan`, `mon`). When both day fields are
  restricted, either one matching is enough, as in standard cron. Read in
  `timezone`, or the Mac's own zone. A time that doesn't exist on a
  daylight-saving day runs at the first minute that does; one that happens
  twice runs once.
- **Ceilings.** A schedule that sends to a thread keeps a ceiling: the
  most access that thread may have when a run reaches its agent
  (`runner/src/schedules.ts`, "Ceilings"; Daybreak finding 162, 22 Nov
  2026). One a thread on Ask or Auto set up for another thread has that
  thread's own mode (or, if Mike allowed it on a card, the other thread's
  access as the card showed it), and so does one it sets up for itself
  (after a `/clear` its words are no longer in what its agent reads);
  Mike's (the app, `tb` outside a thread, the phone) and a Full thread's
  have none. A run to a thread that's above its ceiling now isn't sent: the run
  says `Paused, not sent: …`, a repeating schedule pauses, and the thread
  gets a `system.note` and goes to Needs you, with no turn. Mike resuming
  or changing its words (the app, `tb`, the phone), or his Run now, lifts
  the ceiling; a limited thread rewording, resuming or giving a new check to one (what a
  check prints goes into each run) lowers it to its
  own mode (never lifts it, even through a card, which shows only what
  changes; the thread it sends to included), and a
  limited thread's Run now goes by the higher of its mode and the
  ceiling. Over RPC, `ceiling` (and `schedules.run`'s `by`) left out is
  Mike's; the RPC gate puts a thread's own in, whatever it says. A
  schedule on another Mac is lifted on that Mac: a resume or Run now from
  this one reaches it only as the backend's row or run request, which
  carry no ceiling. Ceilings are kept on the
  Mac the schedule runs on (`schedule-ceilings.json` in the data dir,
  bound to the schedule's id, creation time and thread), never in the
  backend's row; one with none kept (made before 22 Nov 2026, or one that
  only came through the backend) is bound the first time the runner sees
  it, at its `createdBy` thread's saved mode then (Ask if that thread is
  gone or none is named), so existing ones carry on as they were. A
  moved thread's schedules take the lower of the ceiling they had on the
  Mac they came from and the thread's saved mode as it arrives. The
  ceiling goes with the queued message (and to a draining runner, as
  `drain.sendScheduled`'s `ceiling`, which that runner checks again and
  refuses rather than queue), and is checked again as the message leaves
  the queue (`runner/src/runner/ceiling.ts`). A run for a thread a
  draining runner has that doesn't say its access (busy there) is tried
  again rather than held.
- **Sending.** The message starts with a line saying which schedule sent
  it, `[Scheduled: "<title>", <whenText>]`, so the agent knows Mike didn't
  just type it, and its `user.message` has `origin: "schedule"` and
  `scheduleId`. A message for a thread that's busy waits for the running
  turn to end (it doesn't go into it), then starts its own turn. While it
  waits, only the newest queued reminder per schedule is kept,
  so rebooking a long-running job's check-in cannot build a pile. Messages
  from Mike and other threads can still join the active turn. If a message
  has to wait for a fresh CLI, it goes before scheduled reminders; other
  messages keep their order. Queued runner notifications also yield to
  ordinary messages. When an ordinary message reaches the agent, pending
  automatic inputs are marked `beforeMessage: true` in `QueuedSend`.
  If the agent then ends with archive, snooze or waitFor, those older
  inputs are held through that wait instead of overriding it. This also
  applies when ordinary input joins a background-opened CLI turn. Inputs
  arriving later still prevent putting the thread away. An older reminder
  delivered later tells the agent that newer instructions take precedence.
  An interrupted, unread peer message is queued again ahead of automatic
  inputs; saved interrupted user messages hold automatic inputs until the
  user writes again. A fresh ordinary peer message is told to keep stopped
  work paused; it never carries or settles the unread user request. Retried peer inputs carry `retryAfterInterrupt: true`
  and count as automatic redelivery, so a saved user cancellation holds them
  too. Held queues release idle CLIs and survive crash recovery. Old queues are compacted to the latest reminder
  per schedule, with a durable local note for each superseded delivery so
  retrying a lost reply cannot bring it back. Reminders carrying check output
  are preserved separately: that output may contain items no longer in the
  check's storage, except that the same text queued again from one
  schedule (a check printing the same thing every tick while the thread is
  busy) keeps only the newest copy. New queued sends carry `preserveSchedule: boolean` from
  the scheduler, so a quoted check report in the reminder's own text does
  not disable coalescing. Legacy queues infer this from the check suffix,
  conservatively retaining held-check notices too. Repeated Run now requests
  also replace a pending reminder
  from the same schedule; they cannot hold up ordinary messages. Pausing a
  schedule does not retract its already accepted message. Deleting one
  does: its reminders still queued for the thread are dropped, each with
  the same `supersededReminder` receipt, whether it was deleted here or the
  backend's rows stop showing it. A draining runner keeping the thread is
  asked with `drain.dropScheduled { threadId, scheduleId }` → `{ dropped }`
  (`moved` once the thread has come across, when the primary drops them
  itself); a draining release without the method keeps its queue. The
  runner also remembers the schedules deleted while it runs (and any its
  first backend snapshot leaves out that its saved copy had), and drops
  their reminders before a turn would start, however they reached the
  queue: adopted in a handover, a retried send, a receipt that failed. A
  thread kept by a draining runner receives it there through
  `drain.sendScheduled { threadId, text, scheduleId }` → `{ turnId }`,
  with `origin: "schedule"` and `queue: true`, once its turn ends and
  background work is all that keeps it there. Until it can start the turn
  immediately, the run stays due on the primary: recovery after an old
  runner crashes discards its unsent queue. A slow draining process holds
  only its own schedule's send, while other schedules continue.
  After 12 hours on the old release, scheduled messages wait for handover
  so recurring check-ins can't keep resetting its quiet spell.
  A draining release that
  doesn't know this method leaves the run due until its thread comes across.
  Supersession receipts are `system.note` events with
  `supersededReminder: <messageId>`. Their `turnId` is the active turn, or
  absent between turns: the discarded reminder never owned a running turn.
  Clients ignore the optional receipt metadata and fold the note normally.
  New primaries use `drain.sendScheduledOnce { threadId, text, scheduleId,
  run, since?, preserve? }` instead. Optional `preserve` carries that same
  check-data flag across handovers; older runners may omit it. `run` identifies
  the cron slot, one-off slot and
  accepted run count, or backend Run now request; rearming a consumed
  one-off time gets a new id, while manual cron runs leave its due id alone.
  `since` is its earliest possible delivery time, bounding the log lookup.
  The lookup includes five minutes before it for clocks on other runners.
  the schedule, thread and run produce a stable message/turn id. Both the
  draining runner and a primary that adopts it acknowledge an already
  logged delivery instead of sending again after a lost reply. A message
  logged before `turn.started` failed is reused when that start is retried.
  The old method remains for older primaries; a draining release without
  the keyed method leaves the run due until handover. Falling back would
  restore duplicate deliveries after a lost reply, so it isn't used.
  An archived or snoozed thread comes back to the inbox, as with any message. One it
  brought out of the archive (`unarchivedBySchedule` on the record, with who
  had archived it) goes back, archived by them again with a `system.note`,
  when that run finishes with `needs: "nothing"` and nothing left running
  or queued; one that needs Mike, fails or waits stays out. Mike writing to
  it, or archiving or unarchiving it himself, clears the mark.
- **New threads** get the schedule's title and settings and are made the
  way `threads.create` makes them; with `starThreads` each starts starred
  (`starredAt`, the Starred section). The backend stores it from API 100,
  and a runner sends it only to a backend that has it. One with a `poolId` starts on that
  pool's pick of its logins at the time (Which login), and stays in the pool.
  Unlike a thread Mike starts, it doesn't change the login or pool the
  next new thread starts on. Their summary's `schedule` says which
  schedule started them, so a client can mark them as scheduled. A repeating schedule whose last thread is
  still starting, running or waiting on Mike skips that run
  (`lastRun.outcome: "skipped"`) rather than pile up threads.
- **Late runs.** The runner checks at least every 30 seconds, so a Mac
  that was asleep (when timers stop) catches up soon after it wakes. A run
  that was due while the runner was stopped or the Mac slept happens once
  as soon as it can, however many were missed; then `nextRunAt` is the
  next time after now. While the runner is restarting, a due run waits for
  the new one.
- **Failures.** A run that can't send (the folder or account has gone)
  records `lastRun.outcome: "failed"` and a `note`, and a repeating
  schedule carries on next time. Deleting a thread deletes the schedules
  that send to it.
- **Runners.** With sync on and a backend of API 9 or later, schedules
  live in the backend's `schedules` table rather than `schedules.json`,
  so every runner sees one list and a schedule can be made for another
  runner (step 6, docs/archive/step6-plan.md). Each row names its `runnerId`, and
  only that runner sends it. The runner keeps a live subscription to the
  table (`sync:schedules`) and a copy in `schedules.json` (`version: 2`)
  for when the backend can't be reached. Its own timer finds a due run,
  as above; before sending it takes the run with `sync:claimSchedule`,
  which says no unless the row is still due at that `nextRunAt` and
  nobody holds it (a claim lasts 2 minutes), so a run is sent once even
  while two runner processes share a `runnerId` in a handover. The
  holder takes it again every 45 seconds while it checks, sends and
  records the run (a check can run 5 minutes), asks once more just before
  the send and sends nothing if it's no longer its, and keeps it until
  `sync:scheduleRan` gets through: a lapsed claim let the other process
  send the same run again. What it
  sends is the claimed schedule as it is once the claim (and its check)
  come back: still there, still this runner's, and the same schedule
  (`createdAt`), or nothing is sent and the claim is let go. The main Mac
  reads every runner's rows, so a row another runner's key saved under a
  deleted id must never be sent in place of the one it claimed. Then
  `sync:scheduleRan` records it and the next time. Until the backend has
  that, the row still says the run is due, and once the claim lapses it
  would be sent again (THREADBEAR-15: a daily schedule sent twice when the
  network dropped as it was recorded and a self-update's new runner read
  the row). So the run is written to `schedule-runs/` (a file each) first
  and tried again every tick until `scheduleRan` lands, by the next runner
  process if need be, and meanwhile laid over the row the subscription
  brings, so it isn't due again here; the `nextRunAt` it ran at is never
  claimed again. If the row was edited meanwhile but still says that time,
  the run takes the row's `updatedAt` and is told again. `scheduleRan`
  counts a run it already has (same `lastRun` time, outcome and thread)
  once, and one older than its `lastRun` (left in flight by a runner
  process that has gone) changes nothing but the claim. A runner key's
  schedule keeps 400 bytes of its 16 KB for that run record. Making, changing and
  deleting go straight to the backend and answer once it has them; with
  no backend reachable they fail with `-32000` saying so. A transport
  failure includes known network error codes or timeout/abort names from
  its causes (for example `ECONNRESET` or `TimeoutError`), without copying
  cause messages, addresses or request data.
  Saves are not retried automatically: a lost reply may follow a committed
  write. Pausing, deleting or editing a schedule leaves messages already accepted
  into a busy thread's queue as they were when sent. Nothing fires
  without the backend. After a failed first heartbeat, the runner retries
  after 1 second, doubling the delay up to a minute until it hears the
  backend, so a brief startup outage doesn't hold schedules for a minute.
  Key refusals and rate limits keep the normal minute interval. Once the
  first heartbeat succeeds, heartbeats stay a minute apart.
  The first time a runner meets a backend of API 9
  it moves its own `schedules.json` up, under its `runnerId`, and from
  then on the file is only the copy. With sync off, or an older backend,
  schedules stay the runner's own file as before.
  From backend API 45 a runner reads the table once with
  `sync:schedulesSince` and then only the rows written since, plus the ids
  gone (`scheduleGone`, kept a day), asking again from 5 seconds before the
  newest row it heard. A claim doesn't count as a write for this. An older
  runner goes on using `sync:schedules`.
- **Checks**. A schedule's `check` is a
  shell command run first, in its folder, each time it's due
  (`src/schedule-check.ts`). For a thread still on a draining runner, its
  folder comes from that runner's thread summary. If the summary isn't
  available during handover, the run waits and a new check approval is
  refused until the folder is known; it never falls back to the runner's
  data folder. It runs by itself from then on, so it's bound to
  what was approved: `checkDigest` in `src/patch-trust.ts` follows the command
  from its folder, as patch trust follows an action's, and hashes the command
  and every file it reaches, scripts outside the repo that it runs by a path
  included (each from the folder it runs in, so its `./x` is there, with its
  own repo for what's the script's own; one it sources is hashed but can't be
  followed, as it can change the shell it's sourced into). The hash goes in
  `patch-trust.json`, as `check:<hash>` in that folder's list (so a worktree
  counts as its main checkout), written only by the runner the check runs on:
  making a schedule with a check, or passing `check` to an update, approves
  it as it is then. Nothing else does: an update that only names a folder,
  the same one or another, approves nothing, so a check moved to another
  folder is held there until it's passed again (the apps' editors send the
  folder only when it changed, and show no check; security review, 11 Nov
  2026). `update_schedule` with a new folder passes the check along, so it's
  approved there as that call's card showed it, command and folder (as it
  is, from Full), and refuses if the check changed while the card was up. The backend's row says what
  to run, never that it was approved. Before each run it's worked out afresh,
  and the check doesn't run unless that hash is stored and its folder is
  there. A script changed, a link retargeted, a file that turned up, a thread
  moved, a row another client changed, or a check made for this runner from
  another all count. The first run then goes ahead without the check,
  saying so, and later ones are skipped (`lastRun.note`) until that version
  of what it runs is approved: `update_schedule` with the same check, which
  from a thread that asks first is a card as any check is. From such a
  thread a check that can't be followed all the way (`python3 x.py`, `eval`)
  is refused before any card. The card's hash and folder go with the save,
  which binds that or nothing, so scripts changed or a thread moved while the
  card was up change nothing. `schedules.create` and `schedules.update` take
  them as `checkCard`, for a draining runner's tool call: it can only refuse.
  A check that turns out to be this runner's with no folder to compare (a
  `runner` naming this one, with no `folder`) is refused too. A Full thread, the app or `tb` may still set one, as it can run
  anything anyway: it's bound to what could be followed, and what the check
  loads past that isn't. Programs on PATH and installed packages aren't
  followed, as for patches. Threadbear's own checkout binds only the command.
  A change another process makes while the check runs isn't caught.
- **Agents** make and change schedules with the `threadbear` tools
  (`schedule_message`, `list_schedules`, `update_schedule`,
  `delete_schedule`); `createdBy` is their thread. By default an agent's
  schedule sends to its own thread ("check the deploy again in 20
  minutes"). `schedule_message` takes a `runner` (a name or id from
  `runners.list`); left out, the schedule runs on the agent's own runner.

## Recipes

Behind the `recipes` experiment. A recipe is a technique someone found worth
keeping (a morning brief, a nightly look back, an email watcher), written so
an agent can set it up for anyone: one `RECIPE.md`, with an optional header
picture beside it. The format is in `runner/src/recipes/FORMAT.md`. The ones
that come with Threadbear are `runner/src/recipes/<id>/`; the user's own are
`<recipes folder>/<id>/` (`runner.json`'s `recipes.folder`, default
`~/ThreadbearThreads/recipes`), and one of theirs with a built-in's id is used
in its place. That folder is also where a recipe's working files go once it's
set up (its `TASK.md`, its `memory.md`), so a subfolder without a `RECIPE.md`
is just that and isn't listed.

What the runner remembers about each, in `recipes.json` in the data dir:
whether it's on, the thread that set it up, and the schedules that are its.
A schedule made by its setup thread (`createdBy`) becomes its own when the
runner next looks, so the setup agent needs no tool of its own. A recipe with
`experiment: <id>` is on while that experiment is: its switch is the
experiment's switch (`settings.update`'s `experiments`).

`RecipeSummary`:

```
{ id, name, icon,            // icon: an emoji
  description,               // one line, for its card
  by?,                       // who wrote it
  source: "builtin" | "yours",
  experiment?,               // the experiment it switches
  when?,                     // how often, in words: "Every day at 6:30"
  color?,                    // "#rrggbb", the header's colour when it has no picture
  header?,                   // absolute path of its header picture on this Mac
  state: "add" | "settingUp" | "on" | "off",
  setupThreadId?,
  habit?: { text, bytes, given: boolean, changed?: true, givenText? },   // see "Habits"
  instant?: true,            // only a habit: recipes.add turns it on, with no thread
  schedules: { id, title, paused, nextRunAt?, whenText }[],
  stats: { runs: number, neededYou: number, seen: number, lastRunAt?, lastHeadline? } }   // last 30 days
```

`state` is `add` until it's added; `settingUp` from `recipes.add` until it
has a schedule (or, for an experiment's, until that's on); then `on` or `off`.
`stats` count the threads its schedules started in the last 30 days: those
that ended needing the user, and those they've read (`lastSeenSeq` at
`lastSeq`).

### Habits

A recipe's file may have a `## Habit` section: a few lines every thread's
agent is given while the recipe is on, at most 800 bytes (a longer one makes
the file unreadable, and it's left out of the list like any broken file). The
runner gives them after the user's standing instructions, in the same words
at the start of a session and the same note when they change
(settings.md, "Standing instructions"), under a line saying they're habits
from recipes the user switched on. Nothing is written to the user's
`CLAUDE.md` or `AGENTS.md`, so off takes effect on every thread's next
message, and Claude and Codex sessions both hear it.

A habit steers every thread, so a recipe's file alone doesn't count, as
with the standing instructions. What's given is the wording as it was when
the user switched the recipe on (`recipes.add`, `recipes.setOn` with `on:
true`), kept in `recipes.json` with an HMAC of it keyed by the runner's
token. The line is the standing instructions' (settings.md): `recipes.*`
are refused to a thread below Full access (connection.md, "A thread's own
key"), so such a thread can neither switch one on nor sign one by writing
files. A thread on Full access can call them, as it can `instructions.set`. In `habit`, `text`
is the file's wording now and `bytes` its size; `given` says agents are
being told it; `changed` that the recipe is on but what the file says isn't
what was switched on (the file was edited, a release changed a built-in's,
or what's kept wasn't signed by this runner), with `givenText` the wording
still being given, if any. `recipes.setOn` with `on: true` on a recipe
that's already on takes the file's wording.

Switching a habit on is agreeing to its words, so a client sends the ones
it showed: `habit` (the summary's `habit.text`) and `name`, on
`recipes.add` and on `recipes.setOn` with `on: true`. The runner reads the
file again and refuses (`-32602`) unless it still says exactly those, so a
file changed between the user's look and their click isn't taken; the client
fetches the list again and shows the new wording. The name counts because
agents are told the habit under it: it's kept and signed with the wording,
at most 60 characters, and a changed name is `changed` too. Switching it off
forgets the signed wording, so nothing left in `recipes.json` can turn it
back on. Each message reads the recipes afresh, so a habit whose file or
experiment has gone stops with the next one.

A recipe that is only a habit (no "Setting it up", no "Each run", no
experiment) is `instant`: there's nothing for an agent to set up, so
`recipes.add` turns it on and answers `{ recipe }` with no thread, and
`recipes.setOn` with `on: true` adds it too. It's never `settingUp`. One
with a habit and a setup is added by its thread as usual, and its habit is
given from then while it's on.

| Method | Params | Result |
|---|---|---|
| `recipes.list` | `{}` | `{ recipes: RecipeSummary[] }`, on first, then the rest by name |
| `recipes.get` | `{ id }` | `{ recipe: RecipeSummary & { about, example?, examples: RecipeExample[], file, runs: RecipeRun[] } }`. `about` is Markdown (the file's section). `examples` are its made-up runs, each drawn as its thread would show it: `RecipeExample` is `{ title?, you?, reply, card?: { headline, options: string[] } }`, the thread's title, what the user said first (for a habit), the agent's reply in Markdown and its end card; `example` is the first one's `reply`, for a client from before `examples`; `file` is the `RECIPE.md` path. `RecipeRun` is `{ threadId, title, at, headline?, needsYou, seen, archived }`, the threads its schedules started in the last 30 days (and for a recipe whose feature starts its own threads, those: its file's `runsFrom` names the label they're started under), newest first, 60 at most |
| `recipes.add` | `{ id, habit?, name? }` | For an `instant` recipe `{ recipe }`, on from now. Otherwise `{ threadId, thread }` (`thread` its `ThreadSummary`, so a client opens it at once): starts a thread in `<recipes folder>/<id>` (made if need be), on the default pool and mode, whose message points its agent at the recipe's file and has it set the recipe up with the user. The recipe is `settingUp` from now |
| `recipes.setOn` | `{ id, on, habit?, name? }` | `{ recipe }`. Off pauses each of its schedules, stops its habit being given (and turns its experiment off); on resumes them, takes its habit as its file has it now (and turns it on). A recipe still setting up just records the choice |
| `recipes.remove` | `{ id }` | `{ removed: true }`: deletes its schedules, stops its habit, turns its experiment off and forgets it, so it's `add` again. Its files stay |
| `recipes.link` | `{ id, scheduleIds: string[] }` | `{ recipe }`: makes schedules the user already runs this recipe's own, as they are, so it isn't set up a second time beside them: it's added (or keeps the ones it has), `on` unless they're all paused, and their threads count as its runs. `-32602` for a schedule that isn't there or is another recipe's, an empty list, or a recipe that's a habit or an experiment's. `tb rpc` and a setup thread on Full access use it; the app doesn't yet |
| `recipes.create` | `{ text?, fromThreadId?, editId? }` | `{ threadId, thread }`: starts a thread in the recipes folder whose agent writes a new recipe with the user (from `text`, or from what went well in `fromThreadId`), and a header picture if it can make one. A new recipe shows as `add` until it's added. With `editId` the agent changes that recipe instead, writing a built-in's changed copy into the recipes folder as the user's own |

`recipes.updated` (notification, no params) says the list has changed: a
recipe's file, its state, its schedules or the threads they started. The
runner looks every 30 seconds and at once after its own changes; a client
fetches `recipes.list` again (and `recipes.get` for a recipe it shows). With
the experiment off every method fails with `-32601`.
## Project coordinators

The `coordinators` experiment adds one optional coordinator to a project. It is an
ordinary thread using the normal pool/model settings, and you can switch its model
or provider at will. No coordinator budget, spending limit or cost estimate is
added.

The project home has Conversation, Activity, To-dos and Threads tabs. Its right
Highlights pane pins durable Open loops above the living project brief (shared
`state`, `goals`, active work and `links`), and tucks the shared `notes` into a
collapsible Agent memory drawer at the bottom so technical agent notes stay out
of the way unless opened. These fields remain the same canonical records
`projects.get` and `projects.update` read and write. The conversation is the
audit trail. Routine work uses runner-managed hidden helper sessions (started
and resumed through the `coordinator` tool, never separate inbox threads),
shown in Activity and `threads.subagent` even when the coordinator's idle CLI
exits. The coordinator alone brings helper questions and permission requests to the user.

`projects.update` optionally takes `ifUnchanged: { goals?, state?, notes? }`.
The owning runner compares every supplied baseline before writing anything. A
conflict leaves the project unchanged and the editor keeps the user's draft.

Requests (local runner; other clients tolerate the unknown methods/notification):

| Method | Params | Reply |
| --- | --- | --- |
| `coordinators.list` | `{}` | `{ coordinators: Coordinator[] }` |
| `coordinators.get` | `{ projectId }` | `{ coordinator }` |
| `coordinators.start` | `{ projectId, accountId?, poolId?, model?, effort?, charter?, tasks?, message? }` | `{ coordinator, thread, started? }` |
| `coordinators.pause` | `{ projectId, paused }` | `{ coordinator }` |
| `coordinators.addTask` | `{ projectId, title, doneWhen }` | `{ coordinator }` |
| `coordinators.update` | `{ projectId, charter?, interests?, wakeAt? }` | `{ coordinator }` |
| `coordinators.answer` | `{ projectId, questionId, answer }` | `{ coordinator }` |
| `coordinators.closeLoop` | `{ projectId, loopId }` | `{ coordinator }` |
| `coordinators.reopenLoop` | `{ projectId, loopId }` | `{ coordinator }` |
| `coordinators.replyLoop` | `{ projectId, loopId, text, close? }` | `{ coordinator }` |

`coordinators.updated` carries `{ coordinators: Coordinator[] }`, and the app
loads `coordinators.list` again after reconnect. With the experiment off, lists
are empty and writes refuse; existing coordinator identities still retain their
tool restrictions. They cannot become unrestricted threads by turning it off.

`Coordinator` is `{ projectId, threadId, state: "active" | "paused", charter,
interests: string[], tasks, questions, loops, updatedAt, wakeAt? }`. Tasks have
`{ id, title, doneWhen, state, run? }`; task state is `todo`, `working`,
`blocked`, `review` or `done`. Run is `{ id, agentId?, nativeTaskId?,
nativeRunId?, status, summary?, updatedAt }`.
Run states are `queued`, `running`, `interrupted`, `completed`, `failed`, `stopped`.
One transition function owns the allowed moves. Starting or resuming a helper
reserves the run and starts a hidden runner-owned helper session (inheriting the
coordinator's pool/model or overriding them). Its turn outcome updates the run
and wakes the coordinator. A turn that ends with background work still going
that the CLI wakes for (a shell, a monitor, a subagent: Claude, not Codex)
doesn't end the run: the turn that work wakes carries it on, tools and all, and
its end is what the coordinator hears; if none comes once the work is done and
the wake grace has passed, or the CLI goes, the held turn's result is. Tasks are the user's list of all open work, not only helper
jobs: the coordinator is told to add one for each open step or decision (the user's
own included, done with `completeTask`), and its desk says so when none are open. The UI does not manually mark running work done.
Questions have `{ id, agentId, questions, state, answer? }`.

**Open loops.** `loops` holds durable user questions and coordinator decisions
so overlapping topics in chat cannot push earlier questions or asks out of view.
Each loop is `{ id, kind: "user_question" | "waiting_on_user", state: "open" |
"answered" | "closed", title, summary?, options?, sourceSeq?, createdAt,
updatedAt, closedAt? }`. Older coordinators without `loops` default to `[]`.
- `user_question` loops are opened or updated by the coordinator via `openLoop`
  and `updateLoop`: `open` while checking, `answered` with a short `summary`
  once answered. They stay visible until explicitly closed (`coordinators.closeLoop`
  or `closeLoop` after explicit user sign-off). `coordinators.reopenLoop` undoes
  a close.
- A `waiting_on_user` loop is the legacy backing record for an ask without a
  matching task. An ask can also bind to an existing decision task. Both appear
  as one decision on the Tasks board. A legacy `openLoop` or `updateLoop`
  still reads and writes its loop. Replying on the composer card with
  `answers` updates the matching decision. An unrelated message leaves it open.
  An unchanged card keeps its attention state on background wakes without another readability reminder.
- The desktop's Open loops pane doesn't draw `waiting_on_user` loops. It
  mirrors the coordinator thread's live `asks` instead, one read-only row each
  that takes you to the Needs you card, where they're answered. The loops stay
  in the registry for the coordinator's own context.
- `coordinators.replyLoop` sends the user's reply to the coordinator thread
  referencing the loop's title (refused while paused). For `waiting_on_user`
  (default `close: true`) it records the answer and closes the loop. A Not now
  reply postpones it until tomorrow at 9 a.m. local time. For `user_question`
  (`close: false`, follow-up) it moves the loop back to `open`.

The runner stores briefs, helper sessions and checkpoints outside model context.
`startHelper` uses an explicit `taskId` first. With a title it uses the unique
open task of that name if any supplied `doneWhen` agrees, or creates a separate
task if unmatched. With neither it uses the selected or sole ready to-do.
Each run's generation keeps late results from finishing resumed work. Helper
completion wakes the coordinator to check `doneWhen` before `completeTask`.
`archiveTask` frees an active slot and keeps the record in `coordinator-history.jsonl`.
Use `dropTask` with a `summary` of why a to-do is no longer needed. History records
`droppedAt` and `reason`. Dropping is refused while a helper is working or once the
to-do is done. Older sessions use `archiveTask` with a `summary` to drop a to-do.
`read_thread` reaches a coordinator's own hidden helpers by short id too;
`send_message` refuses hidden helpers. Its owning coordinator can use the
`resumeHelper` action with the exact `taskId` or `helperId` and a new `brief`
to pass an update to a helper already at work. The update reaches that run
as another message. The usual runner queue applies if the message cannot go
into the current turn. The run keeps its identity and the task stays in
progress, and the coordinator can still start only one helper at a time.
Model and login changes wait for a later dispatch. An update can only reach
a helper that has no more access than the coordinator has saved. The
runner keeps restricted updates in its own queue so it can check that
limit again just before sending. The helper report tells the coordinator if
a change of permissions kept an update from reaching the helper. Wait
until the turn reading a restricted update finishes before raising the
helper's permissions above that update's limit. Pausing ends that run and
a later explicit resume uses its new brief.

**Restarts.** A runner update (a handover or a plain restart), a crash or a
reboot cuts off a helper mid-turn. Coordinator and helper sessions never stay
on a draining runner, as `coordinators.json` has one writer. During a handover,
the runner saves their active turns as interrupted before closing their CLIs.
The coordinator's own turn uses the normal restart recovery. If the CLI
may still have had a user message waiting, the runner saves it for the next
user message and holds automatic work. Queued user messages survive the
restart and take priority. If a coordinator still has a user message to handle,
it checks what the helper already did before deciding whether to resume it.
A helper's run is saved
`interrupted` and marked in the registry (not in `Run`) to be carried on, and
the next runner does that by itself once it's listening (beside its own
carry-on of threads stopped mid-turn, which leaves helpers alone): the same helper session gets
the runner's message, as a new run generation like `resumeHelper`, saying the
runner restarted partway through its turn and to check what's already done
rather than repeat a send, merge, release or deploy. The coordinator isn't woken
and nothing is added to its conversation (the helper's Activity row says it's
working again); it hears as usual when the helper's turn ends. The carry-on
recaps the updates saved during that run. Delivery can be uncertain at
restart, so the helper checks what it already read or acted on before doing
anything in the recap. If its access was raised above an update's limit,
the runner leaves the work for the coordinator to reconcile. Before 26 Nov
2026 every update woke the coordinator, which then told the user it had started
the helper again. When the runner can't carry a helper on, it wakes the
coordinator to reconcile it instead, once: the helper has no session to resume,
another helper is working, the run was cut off more than 12 hours ago, the
runner went down without stopping cleanly (a crash or a power cut, not an
update or a SIGTERM) during a turn it had carried on after the last such crash, it has carried this run on 10 times, or the send is refused. A
paused coordinator's helpers aren't carried on, and Pause or Resume drops the
marks, so Resume's wake leaves them to the coordinator; with coordinators off
nothing happens until they're turned back on. A helper whose session can't be
resumed (its transcript gone) fails its turn to the coordinator rather than
starting a fresh session without its brief. That wake is the restart report, saved in the same write
that drops the run's mark and delivered like a helper's report (kept until a
coordinator turn that has it finishes), so a refused send or a crash doesn't
lose it. A known helper may be
resumed explicitly with `resumeHelper`. Otherwise a new helper starts from its
saved checkpoint. Compaction (on CLIs that support `/compact`)
waits for helpers to finish, retains the charter and rereads canonical project
records after compaction. Finishing or failing `/compact` does not schedule
another compaction, and clearing the conversation does not compact the old context. If the CLI skips a compaction before a message, the
message still goes ahead and the runner records the attempt as skipped.

### Tasks and work items

The coordinator tool offers `addWorkItem`, `updateWorkItem`, `removeWorkItem`,
`addWorkTask`, `updateWorkTask`, `moveWorkTask` and `postponeTask`.
Select rows with `taskId` or `workItemId`. Edit older questions and decisions with `updateWorkTask` and their `taskId`.
Use `moveWorkTask` with the `taskId` and a `workItemId` or `parentTaskId` for placement.
Use `updateWorkTask` to edit state, including setting unstarted helper work to `todo` before dispatch.
`addWorkTask` and `addTask` require a nonblank `title` (up to 200 characters)
and `doneWhen` (up to 1,000 characters for completion criteria). Task edits accept `title`,
`doneWhen`, `kind`, `owner`, `state`, `now`, `due`, `workItemId`,
`parentTaskId`, `decisionOptions` (objects with `label` and optional `does`),
and `recommendation` (the recommended option's label). Omitted fields keep their values.
An edit can repeat a running helper's current task state. Null clears `now`, `due`,
decision options, the recommendation, a group or a parent. Setting
`state: "postponed"` takes a trigger in `due`. The coordinator tool accepts the
structured triggers below and the strings `"Tomorrow"`, `"YYYY-MM-DD"`, and
a timestamp with an explicit offset such as `"2026-11-28T09:45:00+08:00"`.
Moving a task under a parent inherits its group, including when an edit sends
back the inherited `workItemId` shown on the board. Removing a work item
moves its tasks out of the group. Reorder with `beforeWorkItemId`, or null to move the item to the end.

The Tasks tab and Highlights use these local runner RPCs. Each returns
`{ coordinator }` with the updated board, plus `workItemId` on creation.
The same methods are available over the runner's normal RPC transports.

| Method | Params |
| --- | --- |
| `coordinators.addWorkItem` | `{ projectId, title }` |
| `coordinators.updateWorkItem` | `{ projectId, workItemId, title?, collapsed?, beforeWorkItemId? }` |
| `coordinators.removeWorkItem` | `{ projectId, workItemId }` |
| `coordinators.answerDecision` | `{ projectId, taskId, answer, asksSeq? }` |
| `coordinators.postponeTask` | `{ projectId, taskId, due, asksSeq? }` |
| `coordinators.markTaskDone` | `{ projectId, taskId }` |
| `coordinators.closeTask` | `{ projectId, taskId }` |
| `coordinators.reopenTask` | `{ projectId, taskId }` |
| `coordinators.addToCoordinator` | `{ projectId, text }` |

Input `due` is `{ type: "tomorrow" }`, `{ type: "date", date: "YYYY-MM-DD" }`,
`{ type: "after_task", taskId }`, or `{ type: "at", at }`. A decision in
a Needs you card carries `taskId` in its ask. Both surfaces answer or
postpone that ID. The runner retires the matching ask immediately through an
`asks.ticked` event with `resolved` indexes. Unresolved asks on the same card
keep their original indexes. The board exposes `needsYou: true` for published,
active decisions and `canReopen: true` for confirmations that support Undo. Card
clients may send `asksSeq` to reject a stale card. The runner records the
answer and marks the decision done, then wakes the coordinator to act on the
answer. Use a separate action task for remaining work. Postponing clears the
current ask. When the trigger is due, the runner wakes the coordinator to
reconsider and ask again with the same ID. Legacy replies keep the
`answers: [{ action, answer }]` shape. An ordinary reply can answer a decision
when it matches a choice on one active ask. Convex continues to mirror the
legacy card fields. Only a reply to the current card can resolve a task through
the legacy card route. Include new or changed decisions that are ready to ask.
The runner keeps omitted decisions on the card and in Tasks. Ask new questions
when a job finishes if they would hold that card back. Not now postpones until
9 a.m. tomorrow. Linked comparisons stay open across unrelated turns.

`markTaskDone` marks a user-owned action done. `closeTask` confirms an
agent-owned action that is ready to close, including a substantive question
the coordinator has answered. `reopenTask` undoes that confirmation and
returns the task to ready to close. Both actions wake the coordinator.
`addToCoordinator` takes a free-text
request and hands it to the coordinator to organize into work.

Coordinator responses and `coordinators.updated` can include `taskBoard`.
Existing clients and coordinator tools can keep reading `tasks`, `loops`,
`questions` and `wakeAt` with their original shapes and actions. The board is
local to the coordinator's runner. The Convex mirror still carries the thread's
optional `coordinatorProjectId`, with no backend version change.

- `taskBoard.workItems` contains `{ id, title, collapsed, progress: { done,
  total } }`. Progress counts current top-level tasks assigned to the group.
- `taskBoard.tasks` contains `{ id, title, kind, owner, state, doneWhen?,
  now?, source?, due?, workItemId?, parentTaskId?, decision?, createdAt?,
  updatedAt?, closedAt? }`. `owner` is `{ kind: "user" | "agent" }` or
  `{ kind: "person", name }`. `source` can carry `threadId`, `runId` and
  `seq`. A child inherits its parent's `workItemId` in this view. Only the
  parent stores that field. Legacy open loops appear as top-level tasks during
  the transition. A task can still have no group.
- States are `todo`, `working`, `waiting`, `postponed`, `ready_to_close` and
  `done`. Legacy blocked work maps to waiting and a finished helper awaiting
  review maps to ready to close. User questions become agent actions. An
  answered question is ready to close until the user signs off. Decisions
  waiting on the user become user-owned decisions, with any saved options as
  `{ label, does? }`. A decision can also carry a recommendation and the
  recorded answer.
- An absolute due trigger is `{ type: "at", at, preset? }` with an ISO
  timestamp. Following the runner's Tomorrow preset, date picks use 9 a.m.
  in the runner's local time. The runner rejects an absolute postpone time
  that has already been reached. The runner stores the resolved instant. An
  `{ type: "after_task", taskId }` trigger is satisfied when that task is done.
  Only postponed tasks trigger a wake. The runner clears the postponement
  and queues a durable wake together, including while the coordinator is
  paused. A postponed task returns to its underlying state when released.
  The coordinator's turn context shows the postponement and its trigger.
  Selecting, starting, resuming, completing or dropping a postponed to-do
  waits for its wake.
- Old records keep their identities, run and loop data, and coordinator wake
  times. The registry adds task details to the old records in place.
  Existing JSONL history stays append-only. The runner reads old archived,
  dropped, and removed-coordinator entries as task history without rewriting
  them. Closed loops that roll out of the old list stay on the task board.

### Handing a project to its coordinator

An ordinary thread starts a project's coordinator, or hands the one it has more
work, with the `coordinator` option of its `create_project` and `update_project`
tools (offered only where the experiment is on): `{ pool?, model?, effort?,
charter?, tasks?: { title, doneWhen }[], message? }`. A new coordinator starts
with that charter (else the default) and to-dos, and its first message names the
thread that handed it over and quotes `message`. An existing one gets the charter
in place of its own and the to-dos added, then a wake saying the same; its pool
and model stay as they are. The message goes in as quoted data from that
thread, never as the user's words. A paused coordinator or an archived project
is refused, and all of it is checked before anything is written or a card is
put up (text lengths, 100 tasks at most). `coordinators.start` with any of
`charter`, `tasks` or `message` does the same over RPC and says `started`.

A coordinator thread runs at the runner's default access and its helpers do the
work, and its charter and to-dos are read on every later turn whatever access
it has by then, so from a thread below Full access the tool always asks on a
card first. The card names the most access among the coordinator and the
helpers it could resume, shows the whole brief the coordinator will be told,
goes to the user even in Auto (never the card reviewer), and is refused if the
brief, the coordinator or its access changed while it was up. The handoff's
words carry that access as their ceiling, so they're held if the coordinator is
raised before they run. `tasks: null` is refused, not read as none.

Over a thread's key, `coordinators.start`, `coordinators.addTask` and
`coordinators.update` are open to a thread on Full access and refused below it
(pointing at `update_project`). The runner names the calling thread as the
sender (`fromThread`), whatever the call says, and tells the coordinator when
another thread changed its charter or interests. `addTask` from a thread needs
a coordinator already there; `update` checks every field before setting any,
and from a thread refuses a paused coordinator. A handoff or change the
coordinator couldn't be told of (its message refused) leaves its desk as it was.

Only the user pauses a coordinator or answers its helpers' questions
(`coordinators.pause` and `coordinators.answer` refuse every thread key). The
coordinator's `coordinator` tool may read its own registry, add tasks,
select/complete/archive tasks, start or resume hidden helpers, manage open loops
(`openLoop`, `updateLoop`, `closeLoop`), update its charter and interests, set a
wake time and use `answer` with a helper question ID from `get` under `questions`.
Read the user's recorded decisions in `get` under Tasks (`taskBoard`). Only the
user can start a side job offered with `add_button` outside the project. The
coordinator can call Agent Archive's read tools (`coordinator-policy.ts`) to look
back before asking the user something already settled: on Claude by tool name;
on Antigravity (which gets
the archive as a stdio server in `session/new`, unless its own or the folder's
config names an `agent-archive` server itself) only when every frame of the
call agrees it is that tool. Grok threads get the archive too, but its calls
ask like any other server's, as a Grok agent profile can put its own server
under that name, so a Grok coordinator has no archive. A Codex coordinator's
app-server starts with plugins and apps off, every other configured MCP server
is switched off for its thread, and it refuses to start if
`mcpServerStatus/list` shows any other server still offering tools, as Codex
runs MCP tools without asking. A coordinator and its helpers cannot start or hand work to any
coordinator (update_project refuses the option there, and their thread keys
refuse every `coordinators.*` write), and neither coordinator nor helper shells
may use thread-owned RPC to create threads or mutate other work.
Each adapter enforces coordinator read-only and helper non-escalation before Full
access. Claude uses `PreToolUse` and Codex uses its read-only sandbox and approval
refusal. ACP's `session/request_permission` checks names, kinds and MCP identities
across frames. Missing fields can retain earlier metadata. Disagreeing metadata
and coordinator file-edit previews are refused. Cursor uses `ask`. Hidden helpers
show no user approval or question cards. The runner shows ACP refusals in the
transcript even without a final tool result. ACP sends only the rejection.
Antigravity coordinators delegate web search that can be reported as `other`.
A name or query cannot verify a read-only tool. Claude has built-in Grep and Glob.

Pause blocks new dispatch and all coordinator/helper tool calls, cancels pending
wake timers and interrupts its CLI. Resume reconciles interrupted work. If a
runner is stopping or handing over, refusals say to wait for the runner to come
back. A disabled coordinator feature is reported separately. Pause does
not pause independent threads that the coordinator messages. Completion/failure
events from project threads and matching interest keywords batch for ten minutes and are deduplicated.
Local turns parked on other threads or workflow runs and helper progress do not wake it.
An explicit timer or helper question wakes it without batching. Sources remain quoted event data.

Queued coordinator updates survive runner recovery. An update already started
has a durable receipt; a still-queued update remains queued rather than becoming
an unsent-message note. Runner handover ends coordinator sessions and records
unfinished work before the replacement takes over the registry. A project with
an active coordinator cannot be deleted or merged: pause it first. An active coordinator also stays awake (never moves to `scheduled` for a booked schedule, and refuses `snooze`, `waitFor`, `archive` and `threads.hibernateWhen` until paused). Removal then
archives its conversation and execution records before removing the identity.

This version watches completed project threads and literal interest keywords.
It does not yet classify incoming email, Slack or Sentry through the librarian.
The project document follows the existing canonical project updates in place;
a browsable document-version history and per-edit source links are not included.


