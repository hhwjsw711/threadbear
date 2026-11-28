# Runner protocol (v1)

The app and the runner talk JSON-RPC 2.0 over a WebSocket at
`ws://127.0.0.1:8797/rpc`. One JSON object per WebSocket text message.
Both sides must ignore unknown fields and unknown event types so either can be
upgraded first. Times are ISO 8601 strings in UTC. Ids are strings.
Strings are always well-formed: the runner sends half of a character past
U+FFFF (a cut through an emoji, a `\ud83e` escape on its own) as U+FFFD, since
strict JSON parsers (serde_json, Swift's) refuse the whole message over it.

Readers keep valid fields and list entries when another field or entry has
the wrong type. An unreadable identity drops that row. Routing and authorization
fields also fail closed when recovery would change the account being used or
hide what a Trust action or reply button permits. A missing login never selects
a fallback login or guesses its credential folder. Reply buttons need exactly
one readable action object; an unreadable action drops that button rather than
becoming a different action. A run's command and folder stay required and
nonempty. Other runners deliberately redact start/send briefs and destination
ids: those may be empty strings, since a press routes by the owning thread and
button ids to the runner's stored action.
Decode diagnostics name
only the type or position, never values or user text. A failed, empty or partly
unreadable local thread list is not evidence that previously listed threads were
deleted: clients keep those rows and must not run missing-thread cleanup.
Other runners' indexes carry `ready`: a fully readable remote list that is
ready may be empty after the last remote thread or runner was removed. Older
runners omit `ready` once a list has arrived.

<!-- sections: made by scripts/split-protocol.mjs from the headings below and in docs/protocol/; run it again after adding or renaming one -->
## Where each section is

The rest of the protocol is in docs/protocol/, a file per area. A section is cited by its file and name: `docs/protocol/needs-you.md, "Needs you"`.

It was all this one file once. Work made on that comes across by itself in `tb land`, each edit into the file its section went to; by hand, scripts/replay-over-format.sh does the same (docs/bringing-in-updates.md says how with an older copy of it). Never keep the old file in a conflict: put the edit in its section's file.

| File | Sections |
| --- | --- |
| this page | Ordering and reconnects, Older and newer clients |
| [connection.md](protocol/connection.md) | Auth, Requests (app to runner), Warm start, Models and effort across providers, Notifications (runner to app) |
| [types.md](protocol/types.md) | Types |
| [events.md](protocol/events.md) | Events, Design reviews, Marks: the canvas, Reviews on the phone, Reply buttons |
| [needs-you.md](protocol/needs-you.md) | Needs you, The reply phase, Wait state |
| [updates.md](protocol/updates.md) | Runner updates, Mike's releases, Your changes to the old app, Restarts, App restarts, Handovers, Stopped background work, Stuck background jobs, Background wait loops, Waiting on its own shells, A thread's CLI, Frozen CLIs, A dialog on a Mac's screen |
| [settings.md](protocol/settings.md) | ACP agents, Settings and models, Standing instructions, Shared memory, Explain, Hibernate in words, Usage history, Sandboxed threads (taken out), Pools |
| [threads.md](protocol/threads.md) | Pictures in a message, Queued calls, Plan first, Slash commands, Context breakdown, Editing a message, Who started a thread, Who archived a thread, Search, Searching Agent Archive, What Mike last asked, What Mike first asked (taken out), Loose ends, Nested threads, A quiet inbox, Inbox guess, Secrets |
| [patches.md](protocol/patches.md) | Patches, The Convex panel |
| [trust.md](protocol/trust.md) | Trusting a folder's patches, What changed, Trusting a folder's Claude Code hooks |
| [panels.md](protocol/panels.md) | Highlights, Worktrees, Showing panels, The Browser panel, Pull requests, Connectors |
| [projects.md](protocol/projects.md) | Projects, Project tasks, Schedules, Recipes, Habits, Project coordinators, Tasks and work items, Handing a project to its coordinator |
| [runners.md](protocol/runners.md) | Other runners' threads, Other runners' threads through the backend, Asking another runner, Sharing |
| [moves.md](protocol/moves.md) | Moving a thread to another runner, Sync, Devices |
| [keys.md](protocol/keys.md) | Runner keys, Virtual runners |
| [boxes.md](protocol/boxes.md) | Box keys, Box mode |
| [tools.md](protocol/tools.md) | Tools for agents |
<!-- /sections -->

## Ordering and reconnects

- Persisted events for a thread are delivered in `seq` order with no gaps.
- After a reconnect, the app calls `threads.subscribe` with the last `seq` it
  has; the runner replays the gap, then streams. `inProgress` in
  `threads.events` lets the app show a partially streamed block it missed.
  Deltas sent between a `threads.events` load and the `threads.subscribe`
  never reach the client, so it takes each streaming item's text from the
  subscribe reply's `inProgress` and appends only deltas that arrive after.
- `thread.updated` is level-triggered: the latest summary wins.
- A client that stops reading may miss transient deltas (the persisted
  event replaces them). One that falls far behind is closed with code 4408
  and should reconnect and replay from its last `seq`.

## Older and newer clients

Either side may be upgraded first, so each tolerates the other:

- An app that doesn't know an ACP agent reads `provider: "opencode"` as a
  plain string and shows it under its fallback heading.
- An app older than `hello.providers` ignores it. A newer app talking to a
  runner older than it falls back to what it knows of Claude and Codex, and
  gives a provider it doesn't know no capabilities.
- An app older than Codex support reads `provider: "codex"` as a plain
  string, an unknown tool `kind` (`image`) as `other` and `ultra` as text;
  lists Codex models under its fallback heading; and may still send a
  Claude alias for a Codex thread, which the runner corrects (above).
- A newer app talking to an older runner gets `-32601` from `clis.*` and
  leaves the CLI part out, sees no `usage` on accounts and says the numbers
  need a newer runner, and sees no Codex accounts.
- An app older than Connectors ignores `connectors.updated`, and a
  `show_panel` for `connectors` waits for Mike's next message as an
  unknown panel does. A newer app talking to an older runner gets
  `-32601` from `connectors.status` and leaves the Connectors icon out.
- An app older than Showing panels ignores `panelRequest`, so a request
  waits until Mike's next message clears it, and `show_panel` says it's
  waiting. A newer app never sees one from an older runner.
- An app older than a pin's `highlight` request opens Highlights for it,
  and no longer opens the pin by itself (the runner stopped sending
  `show`). A newer app talking to an older runner never opens a shown pin
  by itself; it's in Highlights.
- An app older than pools sends `accountId` with every `threads.create`,
  so its threads are pinned as before, and it ignores `pools`, `poolId`,
  `waitingForRoom` and `pools.updated`. A newer app talking to a runner
  older than pools sees no `pools` in `hello` (and `-32601` from
  `pools.*`), and shows logins as before.
- An app older than Devices never asks for them. A newer app talking to a
  runner older than Devices gets `-32601` from `devices.*` and says the
  Phone & browser tab needs a newer runner.
