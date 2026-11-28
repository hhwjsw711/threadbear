# Runner protocol: Threads and turns

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

## Pictures in a message

A message's words can say where its pictures go. `[Picture N]` in the
`text` of `threads.send`, `threads.create` or `threads.edit` (and so in
the `user.message`) stands for `images[N-1]`, so Mike can point at two
or more pictures in one message ("this [Picture 1] should look like this
[Picture 2]"). He asked for it on 1 Nov 2026, from T3 Code, which puts a
chip in the text where a picture was pasted. The Mac app's composer does
the same: each picture pasted, dropped or added with + gets a marker
where the cursor is (where it was dropped, for a drop), drawn as a chip
with the picture's thumbnail, and his bubble draws the markers as chips
too. The pictures still show over the text, as before. The iPhone
app's composer does the same with photos pasted, taken or chosen, and
its bubbles draw any `[Picture N]` as a chip with the photo symbol. From
8 Nov 2026 the phone also draws the pictures the runner sent up (below)
over the bubble, and drops the runner's "[2 pictures]" line once every
picture it counts is there (ThreadPictures.words). The runner sends pictures pasted
into a message to the backend as they're sent, unless `sync.pastedPictures` is
false in `runner.json`, each with `src` `picture:N`; the website draws them in
place of the marker, and a chip where one didn't go up, and the main Mac's
runner gives them to the app for a thread on another Mac (backend API 87,
Other runners' threads through the backend). An ask's
Something else box on the Mac takes pictures as chips too (Needs you).

The runner hands the agent the words and pictures in that order: each
picture straight after the first marker that names it (Claude: an image
block between text blocks; Codex: a `localImage` item between text
items). The marker stays in the words, so the agent can say "picture 2"
and mean the one Mike does. A picture no marker names goes before the
words, as every picture did before (an older app's or phone's). A marker naming no picture, or one already placed, is just
words. Text left with nothing but spaces between two pictures is left
out, as the Claude API turns down a text block of only whitespace. A
message of pictures and no words sends `text: ""`, the pictures in their
order.

An older runner hands the agent the markers as words, with every picture
before them; an older app shows them as words.

## Queued calls

Claude Code asks about one tool call at a time, and only asks about the
next once the last is answered. A reply with eight edits that all ask
meant eight cards in a row, each taking the last one's place half a
second after Allow, which looked like the same card coming back (Mike,
8 Nov 2026). So one card shows them all.

- **What's queued.** While a card waits for the agent's own call, the
  runner lists the calls that came after it in the same reply, have no
  result yet and are expected to ask: in Ask mode edits, writes,
  commands, web fetches and other servers' tools; in Auto mode only
  edits of files that run as code; in Full only tools that always ask.
  The threadbear tools that never ask, questions and plans are never
  queued, nor is a call too long for a card or with an argument named
  `__proto__` (refused, as a card can't hold it). `approval.queued` carries
  the list, and again whenever a call joins it (they stream in while the
  card waits). Claude only: Codex asks about its own calls one at a time.
- **Answering.** `approvals.respond` with `queued` answers them in the
  same click. The card's own call takes `decision`; each queued one its
  entry, `allow` or `deny`. A queued call left out of `queued` asks with
  a card of its own when its turn comes, as before. A card with a queue
  offers no Always allow for the queue: only the card's own call can
  make a rule.
- **When the call comes up.** An allowed one goes through with no card.
  A denied one is refused before it runs (a PreToolUse hook, so even a
  call that wouldn't have asked, an allow rule's or Auto's classifier's,
  doesn't run), and the agent is told Mike denied it.
- **Other clients.** The phone and another Mac's view of the runner
  don't get the list: they answer the card's own call, and the rest ask
  one by one.
- **Never on a start request.** Another runner's request for a thread
  (`threadbear.start_thread`, "Asking another runner") always shows as
  this Mac's runner read it, and is answered with `requests.answer`
  alone. The app ignores an `approval.queued` for that card, and leaves
  any such call out of another card's list (it asks with its own card),
  as both come from the runner that owns the thread, which may be one
  the app doesn't trust with this Mac. For the same reason one approval
  id is one card: an `approval.requested` under an id the app already
  shows replaces that card while it waits, unless it's a start request,
  and changes nothing once it's answered.

## Plan first

`permissionMode: "plan"` ("Plan first" in the composer's permission menu)
has the agent read and plan, and change nothing until Mike approves its
plan. Mike picked a plan card in the transcript from mockups (6 Nov), for
Ayush's "Plan View UI".

- **The mode.** Claude runs in the CLI's own plan mode. Codex gets the
  plan collaboration mode on `turn/start` (experimental API) with the
  read-only sandbox, and `default` once on the turn after it leaves.
  Choosing `plan` in `threads.update` remembers the mode the thread had
  (`modeBeforePlan`); approving the plan goes back to it (`full` if none).
- **The plan.** `plan.proposed { itemId, text }` when the agent puts its
  plan: Claude's `ExitPlanMode` call (its `itemId`, and an
  `approval.requested` with that `itemId` follows, with `allow` and `deny`
  only), or Codex's `plan` item, which ends its turn. A newer plan sends
  one still waiting back.
- **Go ahead.** `plans.approve`, or `allow` on Claude's approval from
  anywhere (Return in an empty composer, the phone): the thread leaves plan
  mode and `plan.resolved` says `go`. Claude's call goes ahead in the same
  turn, its answer switching the CLI's mode. With no call waiting (Codex,
  or Claude's after a restart expired it) the runner switches the mode and
  sends "Go ahead with the plan." as Mike.
- **Send back.** Anything Mike writes while a plan waits, or `deny` on its
  approval: `plan.resolved` says `revise`, the thread stays in plan mode,
  and the agent gets his words (Claude's call is declined first, as any
  card is when he writes). The app's Send back just puts him in the
  composer.
- **The card.** The Mac app draws the plan as one card with Go ahead and
  Send back, and no separate approval card. Once approved, the steps the
  agent then works through (`plan.updated`, in the turn that goes ahead)
  fill that same card as its checklist, the plan behind Show plan. Clients
  that don't know these events still see Claude's approval as an ordinary
  one ("Finish the plan"). A thread on another Mac (Other runners'
  threads) shows its plan card too: `relay:remoteMessages` says which rows
  are plans (backend API 76), the relay sends each as `plan.proposed`
  (Claude's card for it with that `itemId`, so it folds into the plan),
  and `plan.resolved` from the plan's row: that runner's sync sends the
  row again with `planDecision` (`go` or `revise`) once it's resolved
  (API 76), and a newer plan sends an older one back. Nothing is guessed
  from the rows after it (a denied plan's revision reads files too, and a
  schedule's message isn't Mike's answer). The relay reads a plan it still
  holds as waiting again once the live tail has moved past it. A plan
  resolved before the runner had this (12 Nov 2026) has no decision on its
  row, so another Mac shows it waiting until a newer plan follows it. It can't take `plans.approve`
  yet, so the Mac offers only Send back there; writing to it still works.
- **On the phone.** Sync sends each `plan.proposed` as a message row with
  `plan: true` (backend API 72): the whole plan, scrubbed as a reply is,
  up to 24,000 characters, and from API 76 `planDecision` (`go` or
  `revise`) once it's resolved, which `phone:messages` and `share:view`
  pass on. The iPhone app draws it as a plan card that
  opens the plan in a sheet (Copy, and Share as a `.md` file), and Claude's
  `ExitPlanMode` card as "The plan is ready" with Read plan. That card's
  `planSeq` is the seq of the plan row it waits on, as the card can reach
  the phone before the row: the phone pairs the card with that row only,
  never just the newest plan. Go ahead would be `allow` on that card, but
  `remoteCardShowsAll` never passes `ExitPlanMode` (the card shows the
  plan's title, and Go ahead starts on all of it), so the runner offers
  only Deny there and Go ahead stays on the Mac; the phone shows its
  button only where the card offers Allow. The sheet's Send back is a
  message, which sends the plan back as anything Mike writes does, and
  only from the plan the waiting card names. phone:thread reads at most
  4 MB of rows an old phone paged in (`PAGED_BYTES`). A Codex plan has
  no card, so the phone only sends it back. The website shows it as a reply
  kept out of the turn's fold, and another Mac (Other runners' threads) as
  an ordinary reply. An older backend gets the plan as an ordinary reply. A runner key
  other than the main Mac's may write a plan row up to 80,000 bytes
  (`planMessage` in convex/sync.ts), against 10,000 for other messages.

## Slash commands

A message whose text starts with `/<name>` (a letter, then letters,
digits, `.`, `_`, `:` or `-`, then a space, a line break or nothing) is a
slash command; `/Users/mike` isn't one. The text in `user.message` is what
was typed, and the runner decides (`runner/src/slash-commands.ts`):

- **Threadbear's own, both providers.** `/model [model]` and `/effort
  [level|default]` are `threads.update` of the thread's model or effort,
  so the change outlives the CLI. A model is matched by picker id, full
  id or title (and for Claude, its aliases). With no argument, or one that
  doesn't match, a `system.note` says what the thread is on and the
  choices.
- **Claude.** Everything else goes to the CLI as typed, which runs its own
  commands and skills and answers the ones it can't ("isn't available in
  this environment"). `/help`, `/rewind`, `/resume`, `/login`, `/logout`,
  `/permissions`, `/exit` and `/quit` get a note on Threadbear's way
  instead. `/clear` gets a note too; the CLI's new session id comes in its
  next `init` and the runner follows it.
- **Codex.** `/compact` is `thread/compact/start` and `/review [text]` is
  `review/start` (`uncommittedChanges`, or `custom` with the text), each
  a turn Codex reports as usual. `/<skill>` adds `{ type: "skill", name,
  path }` (from `skills/list`) before the text. The runner answers
  `/clear` and `/new` (a fresh native session from the next message),
  `/status`, `/context`, `/cost` and `/usage` (model, effort, context and
  the login's limits), and its terminal app's other commands (`/mcp`,
  `/init`, `/diff`, ...) with a note. Others go to the model as words.

A command the runner answers is a turn of its own with no CLI turn:
`turn.started`, the `system.note`, `turn.completed` (outcome `completed`,
no needs). Settings it changes don't get "applies from the next turn". A
command sent during a turn waits in the queue rather than steering into
it, and nothing goes in front of its text (the phone's line, project news
wait for the next message).

`threads.commands` lists what the picker shows: Threadbear's (`/model`,
`/effort`, and Codex's mapped ones), then the CLI's for the thread's login
and folder, with Claude's terminal-only ones left out. Claude's come from
the live session's `supportedCommands()`, or a CLI started with no prompt
in the folder (a second or two); Codex's are its `skills/list`. Cached for
ten minutes per login and folder. `folders.commands` gives the same list
for a new thread's box, before there's a thread, from the login, folder
and permission mode it would start with, and shares that cache. The phone asks for the same list through
the backend: a `slashCommands` command (API 62, docs/convex-backend.md,
`phone:slashCommands`), which the runner answers with this list as the
command's result.

```ts
type SlashCommand = {
  name: string;              // without the slash: "compact", "code-review"
  description?: string;
  argumentHint?: string;     // "[model]", "<file>"
  source: 'threadbear' | 'cli' | 'skill';  // the CLI's own, or Mike's or the folder's
  aliases?: string[];        // other names that run it ("cost", "stats" for /usage)
  // Where it was defined: 'user' (the login's own), 'project' (the
  // folder's), 'plugin' (with `plugin` naming it), 'claude.ai' (synced
  // from claude.ai), 'system' (the CLI's bundled ones). Absent: unknown.
  scope?: string;
  plugin?: string;
  path?: string;             // its file on the runner's machine, when found
  // Its frontmatter says `disable-model-invocation: true`: it runs only as
  // the start of a message. Named partway through one, the agent can't run
  // it, so the picker leaves it out there. Absent: unknown, or it can.
  userOnly?: boolean;
};
```

Claude's CLI says where a command came from only as a tag at the end of
its description ("(user)", "(project)", "(claude.ai sync)", or a plugin's
name); the runner takes the tag off the description, sets `scope`, and
looks for the file: `skills/<name>/SKILL.md`, then `commands/<name>.md`
(a `:` in the name is a folder), under the login's config folder for
`user` and the thread's folder's `.claude` for `project`. Codex's
`skills/list` gives the path and scope itself (`repo` is `project`).

## Context breakdown

The composer's context ring shows `contextTokens` out of `contextWindow`.
Its popover also shows what fills that context, as Claude's `/context`
does: `threads.contextUsage`, asked when the popover opens and when its
refresh button is clicked, never on a timer.

```ts
type ContextUsage = {
  at: string;          // when Claude answered
  model?: string;
  totalTokens: number; // in the window now
  maxTokens: number;   // the window it's measured against
  categories: {
    id?: string;       // 'messages', 'memory_files', 'skills', 'custom_agents',
                       // 'system_tools', 'system_prompt', 'mcp_instructions',
                       // 'mcp_tools', 'autocompact_buffer', 'compact_buffer',
                       // 'free_space', 'mcp_tools_deferred',
                       // 'system_tools_deferred'; a later CLI may add more,
                       // and one that predates ids sends none
    name: string;      // the CLI's own words for the row
    tokens: number;
    kind: string;      // 'used' (in the window), 'buffer' (kept free for
                       // compacting), 'free', 'deferred' (tool schemas kept
                       // out of the window until loaded: not counted)
  }[];
};
```

The runner asks the thread's live Claude CLI (the Agent SDK's
`getContextUsage`, which counts each row with the token-count API and runs
no turn) and keeps the answer in the thread's `thread.json`. `live` says
whether the thread has a running CLI to ask. Without one (an idle CLI stops
after 30 minutes and is resumed by the next message), the answer is the
kept breakdown with its `at`, or no `usage`; no CLI is started for it.
A kept breakdown belongs to the native session it was asked of, so after
`/clear`, a move to another login or provider, or an edit that cuts the
conversation back, it's gone. When the CLI fails to
answer (20 seconds), `note` says so and `usage` is the kept one. Codex
says nothing like this: `{ live: false }`. Another runner's thread through
the backend is refused (`-32000`, the relay doesn't carry it), and the app
shows the totals only.

Both sides ignore fields they don't know; the app leaves out a row whose
`kind` it doesn't know, and draws a row whose `id` it doesn't know in grey
after the ones it does.

## Editing a message

Mike can go back to one of his own messages, change it and carry on from
there, as in Codex: the agent forgets everything from that message on,
the files it changed since are put back, and the edited text is sent as
if the rest had never happened (Mike, 28 Oct 2026, picked undoing files
too).

`threads.edit { threadId, seq, text, images? }`, in order:

1. **Checks.** `seq` must be a `user.message` that Mike sent (no `origin`,
   or `"phone"`; not a message from the runner, a schedule or an agent),
   that started its own turn (it comes before the `turn.started` with its
   `turnId`; one sent into a running turn went into that turn, and can't
   be cut out of it alone), and that isn't already hidden by a
   `thread.rewound`. Otherwise `-32602` saying why.
2. **Stops the thread.** A running turn is interrupted and the edit waits
   for it to end. Messages queued behind it are dropped (they came after
   the edited one); one sent while the edit is under way waits and goes
   after the edited message. The CLI is released, background work and all.
   As going back needs a fresh CLI, background shells and sub-agents
   can't survive it, even ones started turns before the edited message
   (an upload Mike lost that way, 4 Nov 2026). So while the thread has
   any (`background` in its summary), the edit is `-32050`, before
   anything is stopped or cut, with what's running in `message` and
   `data.background`; the client asks Mike and sends it again with
   `stopBackground: true` to go ahead, which stops them with a
   `system.note` saying what.
3. **Cuts the conversation.** The message's `turnId` is the id the agent
   got it under. Claude: the runner finds that id in the session's
   transcript and the next start resumes at the entry before it (the Agent
   SDK's `resumeSessionAt`), so the CLI writes the rest of the
   conversation as a new branch. Codex: `thread/revert` with
   `beforeTurnId`, the Codex turn that message started (the runner sends
   its id as `clientUserMessageId`, which Codex keeps on the turn's user
   message). A message the current native session doesn't have (the
   thread moved to another login or provider since) is `-32602`. Editing the
   session's first message starts a fresh session, with a handoff note
   when the thread has messages before it.
4. **Undoes files.** Claude sessions keep file checkpoints
   (`enableFileCheckpointing`), and the runner rewinds them to that
   message (`rewindFiles`): every file the session's Edit and Write tools
   (sub-agents' too) changed since goes back, and files they made are
   deleted (`how: "checkpoint"`). When there are no checkpoints for it (a
   session from before this, and every Codex thread), the runner reverses
   the `edit.diff` events after the message itself, newest first
   (`how: "diffs"`); a file that has changed since in a way the diff
   doesn't fit is left alone and listed in `failed` with the reason.
   Changes made by shell commands are never undone.
5. **Records it.** A `thread.rewound` event (`fromSeq` = `seq`, `toSeq`
   its own seq - 1, `files`), then the edited text starts a new turn as a
   `user.message` with `editOf: seq`. The thread's open asks, pending
   reviews and panel request from the cut range go.

Everything that reads the thread afterwards leaves the cut events out:
the app's transcript, `read_thread`, handoff notes, Highlights (its pins
stay), the librarian, and what the phone mirror sends from then on
(messages it had already sent stay on the phone for now). `threads.events` still returns them, so
a client can show what was cut if it wants to. A later edit can cut back
further, across an earlier `thread.rewound`.

## Who started a thread

A thread that turns up without Mike having started it leaves him with no
idea why it exists. `ThreadSummary.startedBy` says who did; his own threads
(the app, the phone) don't have one.

| `kind` | `label` | From |
| --- | --- | --- |
| `tool` | what the tool calls itself ("Sentry") | `tb new --from NAME [--why WORDS] [--icon SYMBOL]`; `icon` is an SF Symbol |
| `thread` | "Agent" | `create_thread`, or `tb new` from inside a thread; `threadId` and `threadTitle` name it |
| `schedule` | "Schedule" | a schedule; `ThreadSummary.schedule` has the details |
| `librarian` | "Librarian" | the librarian's fix threads, which it no longer starts (see No fix threads); older threads keep it. `threadId` and `threadTitle` name the thread Mike said it in |
| `runner` | "Threadbear" | a notice from the runner itself, such as a dialog left on a Mac's screen |

A `kind` the runner doesn't know (from a newer caller) starts the thread with
no `startedBy` rather than refusing it.

The row marks such a thread with the kind's symbol (the tool's `icon`) before
its project or folder, which every row names, and the symbol's tooltip says
who started it and `why` ("Started by Sentry (network blip, sorted)"); on the
phone that's its VoiceOver label. Until 4 Nov the line itself read "label ·
why"; Mike wanted the project back. `why` is a few words: why it was started,
from the starter, until an `end_turn` with `byline` replaces it with how it
came out. A `byline` in a thread with no `startedBy` is dropped. Threads from before
this have none, and `tb new` outside a thread with no flags could be Mike at
a terminal, so it has none either. Mirrored to the phone's row from backend
API 22, and to another runner's sidebar row on a Mac from API 23.

## Who archived a thread

A thread archived on purpose looks the same as one cleared out of the way
unless something says so, and a sweep (the nightly retro, an agent tidying
up) can't tell a thread Mike confirmed from one an agent or Threadbear put
away. So every archive records who did it, as `archivedBy`:

| `archivedBy` | From |
| --- | --- |
| `mike` | the default: the Mac app (the done card, ⌘E, a row's box, a swipe), the phone, the website, `tb archive` at a terminal |
| `agent` | `update_thread`, `end_turn`'s `archive`, `tb archive` from inside a thread |
| `threadbear` | the runner itself, such as a dialog notice archiving itself once it's gone |

An archive can also carry a `verdict` (`worked`, `didntWork`,
`notNeeded`), kept as `archiveVerdict` and said in the thread as a
`system.note` ("Archived by you: it worked."). For a day (5 to 6 Nov) the
done card's Archive opened a menu of these on the Mac, the phone and the
website; Mike went back to a plain button, so no app sends one now, but the
API still takes it and threads archived that day keep theirs. Three more,
`didntNeedToSee`, `gladISaw` and `notSure`, are the `inboxGuess` experiment's (see
"Inbox guess"): the GPUI app's done card sends one from its Archive menu
while that experiment is on, for a thread on its own runner. The Convex
relay and `phone:update` still take only the first three, and drop any
other from an archive. A verdict
from anyone but Mike is dropped. Both fields are set afresh by each archive and only reported while
`archivedAt` is set, so bringing a thread back needn't clear them; threads
archived before 5 Nov have neither. `read_thread` and `list_threads` say
them ("archived by the user: it worked").

## Search

Every search (the Mac's sidebar, `threads.search` and `list_threads`, the
phone's inbox, `phone:search`) matches a thread's title and `preview`, and
its `keywords`: up to 20 lowercase words, space-separated, at most 200
characters, that someone might type to find it and its title doesn't
have. "dentist" finds "Wisdom tooth meeting location" (Mike, 11 Nov, on
his phone). The librarian writes them: each look's answer has `keywords`,
which replace the thread's when there are some. Threads it never looks at
again (everything from before 11 Nov) get them from the keyword sweep:
every two minutes, while the librarian is idle and not paused, one small
model call for the 15 newest threads with none, from their title, first
message and last reply. A thread the model gives nothing for gets `""`, so
it isn't asked about again; one in a private folder is never sent. On the
librarian's day counts like a look, on the pool's logins.

A thread's backend row and its `threadIndex` row carry `keywords` from API
74, and the `threads` table has a search index on them. From API 74
`phone:search` also takes `everywhere: true`: threads in any list, not only
archived ones past the den's newest 100, and after the title, keyword and
preview matches, threads with the words in any of their `messages` rows
(a search index on `text`, which the message caps keep to tens of MB). The
phone keeps each thread the phone has in its own section, and puts the
rest after its archived ones. An older phone sends no `everywhere` and gets
what it did before.

## Searching Agent Archive

With the `archive` experiment on (docs/experiments.md) and Agent Archive
installed on the runner's machine, the Mac's sidebar search also searches
the archive: every word said anywhere in a session, sessions run outside
Threadbear (the terminal, Codex, T3 Code), everything from before
Threadbear, and every machine that syncs to it. The runner never holds
an archive credential: it runs the archive's own command, `agent-archive
search --json` and `read --json`, which uses the read-only key the
archive's MCP server uses, and passes the answer on. Nothing goes to the
backend, so the phone and the website don't search the archive.

```ts
type ArchiveHit = {
  threadId: string            // the archive's thread id (31 to 37 lowercase letters and digits)
  title: string               // its Threadbear thread's title when it has one, else the archive's
  agent: string               // "claude" | "codex" | "grok" | "muse"; tolerate others
  folder?: string             // the session's working folder
  machine?: string            // the archive's name for the computer it came from
  updatedAt: number           // ms
  sequence: number            // the matching message's place in the session, for archive.read's around
  snippet: string             // up to about 240 characters around the first match, one line
  threadbear?: { threadId: string, title: string }  // the Threadbear thread it belongs to, if any
}
type ArchiveThread = {
  threadId: string, title: string, agent: string, folder?: string, machine?: string,
  createdAt?: number, updatedAt: number,
  messages: number            // how many messages the session has (user and assistant)
  url?: string                // the archive reader's page for it
  threadbear?: { threadId: string, title: string }
}
type ArchiveItem = {
  sequence: number,
  role: "user" | "assistant",
  text: string                // at most 8 KB, clipped with "…"
}
```

One hit per archived session, best first. The app sends a search once
typing pauses (about 400 ms) with three or more characters, and shows its
own threads first, so the archive can't slow them down; a late answer for
older words is dropped. A hit whose Threadbear thread is in the app's
lists opens that thread, and is left out when that thread is already among
the search's own results. Any other hit opens read-only in the thread's
place: the messages from `archive.read`, the matching one in view, with
Open in the archive (the reader's `url`) and New thread from this, which
starts a new thread's message naming the archived session, so its agent
reads it with the archive's tools.

A runner without the experiment answers `{ hits: [], off: "experiment" }`,
and one where the archive's command isn't there `off: "not_installed"`;
the app then shows nothing for the archive. A runner from before answers
`-32601`, the same. A search that fails (the archive's server can't be
reached) is an error whose message says why, which the app shows under
the Agent Archive heading. The command gets 20 seconds.

With the same experiment on, every thread's agent gets the archive's tools:
the runner adds the archive's MCP server, `agent-archive`, to each Claude
and Codex session it starts, the same command Mike's own config names,
so threads on a login whose config doesn't have it (the cloud box's)
have it too.

## What Mike last asked

A thread's summary carries `asked`: the last message Mike sent it, at the
Mac or from his phone, as one line of at most 140 characters. Messages he
didn't write leave it as it was: the runner's own (`origin: "runner"`), a
schedule's, and another agent's (`sentByAgent`). A design review's reply
is his notes, joined, or "Picked <option title>" when he left none. It's
absent until he's sent something. A thread from a runner before it learns
it from the last 300 events of its log when the runner starts, unless it's
archived. The Mac app's sidebar shows it as the tooltip of the line under a
thread's title ("You: ..."). That line names the thread's projects or
folder: Mike tried `asked` there (3 Nov), then the thread's `preview`, and
went back to the project on 4 Nov. A thread's row in the backend carries
`asked` too, from API 31, and so does a `threadIndex` row, from API 32, so
a Mac's tooltip has it for another runner's threads. The phone doesn't
show it.

## What Mike first asked (taken out)

A thread's summary carried `request` from 20 to 23 Nov 2026: Mike's first
message to it as one line, for the Mac app's Feed (experiment `feed`),
which was taken out with it. Runners don't send it now, and clients ignore
it from an older one. A thread's record from then keeps it, unread. A
`threadIndex` row from a runner of backend API 96 or 97 may still carry it,
so the backend still takes it (and still cuts it to 400 bytes), but
nothing reads it.

## Loose ends

`runner/src/loose-ends.ts`, `runner/src/runner/loose-ends.ts`. Tried as
the experiment `looseEnds` from 7 Nov 2026, standard since 16 Nov (typed
asks fell to two in five days, and nine in ten archives came from the done
card's button). On 6 Nov 2026 Mike typed some form
of "anything else, or should we archive?" 27 times rather than click the
done card's Archive, which puts a thread away at once: he wanted to know
nothing was left first. The runner now checks what it can see for itself
and puts it on the done card, so Archive stays a plain button.

When a turn completes with `needs: "nothing"` (and isn't archiving
itself), the runner checks:

- `unlanded`: commits on the thread's worktree branch that `main` lacks
  (`git rev-list --count main..<branch>` in the main checkout);
- `uncommitted`: files in its worktree, tracked or untracked, that
  `git status --porcelain` lists (ignored ones don't show); and outside
  a worktree of its own (a shared checkout, another repo), the files it
  changed (its Highlights' `edited`) that git lists, per repo, never the
  rest of that checkout's status, which holds other threads' work;
- `unpushed`: commits it made (its Highlights' commits) in a repo outside
  its worktree that has a remote, which no remote branch contains;
- `unmerged`: commits it pushed there that are on an `origin` branch but
  not on `origin/HEAD` (or `origin/main`, `origin/master`), one line per
  branch, at most three. For a GitHub remote the runner asks `gh pr list
  -R <owner/repo> --head <branch>` (from a temp folder, so the repo's git
  config never runs; kept a minute): an open PR names itself ("PR #1092 in
  website is still a draft"), and a merged or closed one whose head is
  still the branch's tip drops the line, as a squash merge leaves the
  commits off main (one from before newer pushes doesn't). Every git the
  check runs (the worktree's status and commits too) goes through
  `untrustedGit`, so neither a repo's config nor a submodule's can run
  anything: it runs by itself when a turn ends, in any mode. Besides
  the repos of its `edited` files, the thread's own folder is looked in
  for its commits (a repo it reached only through a shell, elsewhere,
  isn't found). Only `origin` counts: work pushed to a fork remote isn't
  seen. At most six PR lookups per check, and opening the thread doesn't
  start one while another is running. Added 11 Nov 2026, when a thread said Done with three draft
  PRs unmerged;
- `thread`: a thread it started (`startedBy.threadId`), not archived,
  that's running or waiting on Mike, with `threadId`. One with background
  work going and no card asking Mike anything "is still working", as the
  sidebar has it under Running (since 20 Nov 2026: one whose turn ended
  with a review round running in a shell read "is waiting for you"), and
  its starter's card is checked again when that work starts or ends;
- `scheduled`: a schedule that sends to it and will run again (`at`:
  `nextRunAt`), at most three. It doesn't stop an archive: an archived
  thread comes back when one runs;
- `running`: background work its CLI is still running (a shell, a
  monitor, a sub-agent; the summary's `background`, less any that's
  finished and waiting to be read), at most three: "Still running: Land
  the fix on main. Archiving stops it.", as archiving stops the CLI and
  its jobs with it. A job's words past 100 characters are cut where no
  secret is split, and then end the line ("Still running (archiving stops
  it): <words>…"), so a key the scrub learns of later is still seen cut
  off at the end. Checked again when the list of jobs changes.

Until 13 Nov 2026 there was also `open`: up to three lines the agent wrote
itself, through an `open` argument on end_turn (added 11 Nov, offered
while the experiment was on), for what it was waiting on that the runner
can't see. Mike asked of one ("Geoff putting the portal and lights pieces
into the next newsletter"): "what can I action on with this?" Of the 14
on his cards that day none gave him anything to do or click: nine were
the thread's own job still going (seven "waiting in the landing queue"),
which `running` now says from what the runner knows, four waited on
another person, and one listed threads it had started. So the card lists
only what the runner checked. What waits on someone else goes in the
agent's reply; if there's more for it to do when they answer, it
hibernates with end_turn's `snooze`. A session from before still has the
argument: its lines are dropped, and its accepted end_turn is told so
("Your "open" lines aren't shown any more: say them in your reply
instead…"). A record's `needs.open` from those days is left where it is
and not read.

The result goes on `ThreadSummary.looseEnds`: `{ seq, ends, at }`, where
`seq` is the done card's `turn.completed`. `ends: []` means it checked and
nothing's left; the field is absent when there's no check for the
thread's current card (off, a card of asks, a turn running, the first
check still going). It's checked again, for a card that has one, after an
action runs on the thread (Land), when a client subscribes to it (at most
every 5 seconds), and when a thread it started completes a turn or is
archived. Clients show an unknown `kind` as its `text`.

The Mac app lists them under "Still open" (a `thread` one links
`thread:<id>`); `scheduled` ones alone go under "Coming back". With none
left it shows just Done (a "Nothing left open" label beside it was cut on
9 Nov). The phone and the website show them the same way on their done
cards, from the thread row's `looseEnds` (backend API 73: the summary's
`ends`, sent only while its card stands, so idle, `needs: "nothing"` and
not archived; an older backend's row goes without it). Another runner's
thread on the Mac shows them too (since 12 Nov 2026): the relay reads them
from that thread's backend row while it's open and puts them on its row in
`remoteThreads.list`/`.updated` (and a `thread.updated`) as `looseEnds:
{ seq, ends }`, `seq` being the relay's own `turn.completed` for the card,
only when the row's `cardTurn` (API 76) is that card's turn: a newer
turn's row can come before its messages.
The sidebar's rows don't carry them, so a thread nobody has open has none.

## Nested threads

Experiment `nestedThreads` (`runner/src/runner/nested.ts`, the GPUI app's
sidebar), off unless `runner.json` has `"experiments": { "nestedThreads":
true }`. On 13 Nov 2026 Mike pointed at "GPUI Port Coordinator", which had
started 25 threads in a day: its unfinished ones sat loose in his Inbox and
Running with nothing saying where they came from, and it woke 79 times in
24 hours for their reports, 47 of them only to retell a report to him. He
picked threads nesting under the thread that started them, like
sub-agents, with no "coordinator" mark (mockups in
`~/dev/me/misc/ghostex-notes/mockups/sub-*.png`).

- **Which threads nest.** One whose `startedBy` is `{ kind: "thread",
  threadId }` naming a thread the client has, that isn't `detached` and
  whose starter isn't archived or deleted. One level deep: a thread started
  by a nested thread nests under the top one of its line. Threads a tool,
  a schedule, the librarian or the runner started never nest, and nor do
  another runner's (their `startedBy` has no `threadId`).
- **Choosing at the start.** `create_thread` takes `nested` (default
  `true`); `false` is for a thread that isn't part of the starter's work
  (Mike asks for one about something else, a tooling fix in another repo).
  It reaches the runner as `threads.create`'s `detached: true`.
  `threads.update`'s `detached` changes it later: the sidebar's Move Out
  From Under and Put Back Under.
- **Where the group sits.** In the sidebar the starter's row heads the
  group and its threads sit indented under it, never with rows of their own
  elsewhere. The group goes where its most urgent member would: Inbox if
  the starter or any of its threads waits on Mike, else Running if any is
  working, else where the starter is. Archived threads of the group show
  as one "N finished" line. The group opens by itself while one of its
  threads waits on Mike and folds otherwise; Mike can open or fold it, and
  that holds while the app runs. Folded, the starter's row says how many
  are working or need him ("5 working", "1 needs you").
- **Who started it.** A thread with `startedBy.kind` `thread` opens with
  one line above its transcript: "Started by <starter's title>" (a link)
  and `startedBy.why`.
- **Reports wait for the end.** An agent's `send_message` to the thread
  that started it (not `detached`) is held, not delivered, while the
  starter isn't in a turn and any thread it started (nested, so not
  `detached`) is still working, the sender included. The sender's tool says
  it was held. Held reports go to the starter together, as one message,
  once none of its nested threads is working (a thread waiting on Mike, on
  a card, or hibernating counts as not working), or straight away when one
  of them fails or is stopped. If the starter is waiting on threads
  (`waitingOn`) and they're all done, the reports go with that wake rather
  than as a second one. A message from Mike to the starter takes the held
  reports in first. Held reports are kept on the starter's record
  (`heldReports`), so a restart doesn't lose them. Each keeps a `ceiling`,
  the starter's access as it was held (`send_message` let it reach the
  starter then). When they go, a report
  whose ceiling the starter has since been raised above (and whose sender
  hasn't been raised to match) isn't passed to its agent: the starter
  gets a `system.note` naming the sender and goes to Needs you instead,
  with no turn for those reports (`runner/src/runner/ceiling.ts`; Daybreak
  finding 164, 22 Nov 2026). One held before ceilings counts only the
  sender's access now.

Mac (GPUI) app only for now; the phone, the website and the Swift app show
threads as before.

## A quiet inbox

`runner/src/runner/quiet-inbox.ts`. On 12 Nov 2026 Mike asked why three
threads other threads had started sat in his inbox with nothing for him to
do. Tried as the experiment `quietInbox` until 16 Nov, then made standard.
The experiment also hibernated a finished thread whose only loose ends were
threads it started, waking it with their replies; that was taken out, as it
hid threads Mike wanted to read (a starred coordinator, the daily brief) and
its wakes rarely had anything to say. A wait the agent asks for itself
(end_turn's `waitFor`) is unchanged.

When a turn finishes for good (completed, `needs: "nothing"`, nothing
queued or running, no card waiting, no lab review of it started or owed,
and not putting itself away with `archive`, `snooze` or `waitFor`), and the
thread's `startedBy.kind` is `thread`, it isn't `detached`, its `next` is
empty and Mike has had nothing to do with it, the runner gathers its loose
ends as the done card does (above). A `detached` thread is left in the
inbox. `create_thread`'s `nested: false` is Mike asking for a thread of his
own about something else, and the reply is often what he wanted to read (26
Nov 2026: the daily brief started a perpetual spinach lookup that way, and
quiet inbox archived it before he saw where to buy it). If nothing is left at all
(no `scheduled` either), it's archived (`archivedBy: "threadbear"`) after a
`system.note`: "Archived: another thread started this one, and it finished
with nothing left for you." If all that's left is threads it started
(`thread` ends, working or waiting on Mike), it stays in the inbox, and
each of them finishing or being archived looks again (`recheckStarter`),
as long as the thread's done card is still the one it finished with; the
last one going archives it, with no turn of its own.

Mike has had something to do with it if there's a message of his after its
first (an answer to its card counts), a star, or it's been unarchived by
hand (`keptOut` on its record, set by any `threads.update` with
`archived: false` on an archived thread). Its first message is its
starter's brief whatever it looks like, as `tb new` from an agent's shell
has no "Sent by the agent" line.

Anything else stays in the inbox: a turn that asks, fails or is stopped,
one with follow-ups, uncommitted or unlanded work, an open PR. A message, an archive or a hibernate that arrives while git
runs wins, and a check that fails leaves the thread where it is. Threads a
tool, a schedule, the librarian or the runner started are left alone: they
are often what Mike wants to read, and no thread holds their result. A
helper its starter writes to again comes out, runs and goes back the same
way. The starter hears nothing new from this: it's woken only if it was
waiting on the helper, and the helper shows as archived under "Threads it
started" in its Highlights.

Mike's own threads join in with the experiment `quietInboxMine` (23 Nov
2026), on top of `inboxGuess`: the strong model's guess decides, and the
app counts and lists what it hid. See "Inbox guess", "Acting on it".

## Inbox guess

`runner/src/runner/inbox-guess.ts`, the experiment `inboxGuess` (18 Nov
2026). About half the threads Mike archives from his inbox are ones he
didn't need to see: he'd told the agent what to do, it did it, and the
reply is a receipt he has to load back into his head to put away. A
helper thread like that archives itself (A quiet inbox); his own don't, as
a reply is often the thing he asked for and hiding one of those is the
expensive mistake. This collects what's needed to tell the two apart
before anything acts on it. On its own it archives nothing and shows
nowhere; with `quietInboxMine` on as well, the strong model's guess
archives the thread (Acting on it, below).

**The guess.** When a turn finishes for good as in A quiet inbox, the
runner makes a guess for its done card (`seq`, the turn's `needs` event,
as loose ends use): `skip` (it could have gone straight to Archived) or
not. A turn with `next` follow-ups, or with any loose end (a booked
check-in counts), is never a skip, by rule, and no model is asked. A
helper nobody's touched gets only that rule's guess, when it stays in
the inbox; one that finishes clean archives itself and has none, and nor
does another lab's review. Otherwise `models.generate` is asked twice, Haiku and (`strong`) Opus, with `GUESS_SYSTEM` and the
thread's title, who started it, Mike's latest message, any newer message
that isn't his, and the reply (each clipped, as data between tagged
lines). A model that can't run (no pool, a private folder, no room) or
gives no clear answer has no guess. The guesses are kept on the thread's
record as `inboxGuess: { seq, guesses: [{ by, skip, why }] }` (`by` is the
model's id, or `"rule"`), which no summary carries.

**A guess lost with its runner.** A guess takes a few seconds, and a
runner handing over lets a thread go half a second after its turn ends,
so the guess being made there is dropped (seven of Mike's first sixteen
answers had none beside them, 19 Nov 2026). The runner that takes the
thread on makes it instead (`catchUpInboxGuess`): as it adopts a thread
that is `finished` with a done card and no guess for it, and at start for
such a thread that finished within the last hour (`GUESS_CATCH_UP_MS`;
not every finished thread in the inbox, which would be a model call each
at every start). The follow-ups come from the card's `turn.completed` and
the reply from the turn's last text. A runner that stopped between
writing a guess and saving the thread leaves two lines for one card; the
later one counts.

**The label.** While the experiment is on, the GPUI app's done card
Archive opens a menu for a thread on its own runner, "Didn't need this"
(`verdict: "didntNeedToSee"`), "Glad I saw this" (`"gladISaw"`) or "Not
sure" (`"notSure"`, for the in-between ones); each archives as ever, with the verdict's note. ⌘E, a row's box and a swipe
archive with no verdict.

**The file.** `<home>/inbox-guess.jsonl`, a line each:
`{ at, kind: "guess", threadId, seq, prompt?, guesses }` when a guess is made
(`prompt`: which `GUESS_SYSTEM` asked, from 2 on 22 Nov 2026; none is the first), and
`{ at, kind: "archive", threadId, seq, label?: "skip" | "show" | "unsure", guesses? }`
when Mike (`archivedBy: "mike"`) archives a thread whose last turn left a
done card, `guesses` being that card's if there were any. An `unsure` label is left out of
scoring: it's neither a thread to hide nor one a guess got wrong. Agents' and
Threadbear's archives aren't written. How long he had a thread open
before a plain archive is in the app's activity log, as a second, rougher
signal.

**Acting on it.** The experiment `quietInboxMine` ("Quiet inbox for your
threads", 23 Nov 2026, part of A quiet inbox; it needs `inboxGuess` on, as
the guess comes from there). After the guess line is written, the thread
is archived when the strong model's guess (`strong: true` on it) is a skip
and no rule's guess is among them. Opus, or Codex: a pool whose Claude
logins are out of room has another agent answer on its own default (its
`by` then says `<provider> default on <login>`), and Codex's counts (28 Nov
2026: Mike agreed with 46 of its 47 skips he labelled). When only Haiku
answered, or another agent (Grok, OpenCode), nothing happens. Nor
for a thread that's starred, `keptOut` (brought back out of the archive by
hand once), `detached` (he asked for it as its own thread; the model treats
a report from another thread as a skip, which is how the 26 Nov perpetual
spinach lookup could have been hidden again), another lab's review, has a
design review waiting on Mike, a reminder he set himself (started by the
tool `X bookmarks`: a bookmarked post is something he means to look into),
or whose done card he has already seen (`lastSeenSeq >= seq`: he had it
open as it finished). The checks `settleQuietly` makes are made again, as the
models took a moment: no turn, edit or queued message, still `finished`,
the done card still the last, the thread still in the inbox, and no thread
it started gone back to work. Then a `system.note` ("Archived by Quiet inbox on <when>: it finished
with nothing for you, and Opus judged you didn't need to see it.", naming
Codex instead when it judged, and the
model's `why`; the app explains Quiet inbox on hovering a line that names
it), an archive with `archivedBy: "threadbear"`, and
`quietlyArchived: { at, why, seq }` on the record, which the summary
carries as `quietlyArchived: { at, why }` while the thread is archived by
Threadbear. Any move that brings it out of the archive (a message, an
unarchive, a review answered) or leaves it archived by someone else (Mike
archiving it again) clears the mark (`parkRecord`). The file gets
`{ at, kind: "quiet", threadId, seq, why }`.

**Should have shown me.** `threads.update` with `archived: false,
verdict: "shouldHaveShown"` brings a thread back as any unarchive does
(so it's `keptOut` and never quietly archived again), with a
`system.note` saying who and why ("Brought back from the archive by you
on <when>: Quiet inbox shouldn't have hidden it.", or "by an agent ...: you
said Quiet inbox shouldn't have hidden it." for `byAgent`, which
`tb unarchive` run from a thread sends)
and the line `{ at, kind: "wrongHide", threadId, seq?, quiet, guesses? }`:
`seq` the card it was quietly archived for (else its last done card),
`quiet` whether it had the mark, `guesses` that card's. The GPUI app
sends it from an archived row's menu, and `tb unarchive <id>
--wrong-hide` sends it for the daily thread that asks Mike about the day's
quiet archives (`quiet` lines in the file). The Convex relay drops the verdict, so a thread on another runner
comes back unlabelled, and `phone:update` takes only a plain
`{ unarchive: true }` (a verdict there is refused); they never carry the mark
anyway.

## Secrets

Added 4 Nov 2026, after T3 Code's `request_secret` (its "Asking for a
secret" card). Before this an agent that needed a password, an API key or
a token had to stop and ask in its reply, and whatever Mike typed back
went into the transcript, the phone's mirror and Agent Archive. Codex's
own secret questions were declined (Codex approvals). Now:

- **The tool.** `ask_secret` (a threadbear tool, Claude and Codex alike)
  takes `label` (the card's title, "Mac administrator password"),
  `reason` (what it's for and where to find it), `placeholder?` and
  `timeoutMinutes?` (default 10, at most 60). It puts a card up and
  waits. The agent never gets the value: it gets a file path, an owner-only
  file under `<home>/secrets/asked/` (0600 in a 0700 folder), plus an
  askpass helper beside it (`<file>.askpass`, 0700, a two-line script that
  prints the file), so `SUDO_ASKPASS=<helper> sudo -A ...`, `SSH_ASKPASS`
  and `GIT_ASKPASS` work without the value ever being in a command line.
  Otherwise the agent reads the file inside its command
  (`TOKEN="$(cat <file>)" wrangler whoami`). The tool's text tells it
  never to print it. Declined, timed out, or the turn stopped: it says so,
  and the agent can ask again.
- **What the card promises.** The value is kept out of the chat, not out
  of the agent's reach: its commands can read the file, and a command
  that prints it puts it in the transcript. The card says so ("Kept out
  of chat, in a private file this agent's commands can read for 24
  hours"), as T3's does for its file delivery.
- **The event.** `secret.requested` (persisted): `approvalId`, `itemId?`
  (the tool call's), `label`, `reason`, `placeholder?`. It's a pending
  approval like any other (the thread is `waiting`, it's in Needs you, a
  message from Mike declines it first, Stop or a restart expires it),
  closed by `approval.resolved` with `answered`, `deny` or `expired`, never
  with a `message`. No event, log line, summary, mirror row or error ever
  carries the value.
- **Answering on a Mac.** `secrets.answer { threadId, approvalId, secret?:
  string, decline?: true }` → `{}`, over the same connection as
  everything else (loopback, or another runner's `wss://` on the
  tailnet). One of the two is required; an empty or whitespace-only secret
  is `-32602`. The runner writes the file before it resolves the card, so
  a failed write leaves the card open with the error.
- **Answering on the phone.** The Convex mirror never sees the value. The
  runner has an X25519 key pair (`secrets/secret-box.key`, 0600, made on
  first use). The thread row's `pendingApproval` for a secret is `{
  approvalId, kind: "secret", label, reason, placeholder?, key }`, `key`
  the runner's public key (raw, base64). The phone seals the value to it
  and calls `phone:secret { token, threadId, approvalId, sealed?: { epk,
  nonce, box }, decline?: true }` (backend API 35), which queues a
  `respond` command with `{ approvalId, decision: "answered" | "deny",
  sealed? }`. The runner opens it; `sync:finishCommand` drops `sealed`
  from the row whether or not that worked. A runner only puts a secret on
  the row for a backend of 35 or later (an older one's schema would refuse
  the write). A phone from before API 35 draws a card it doesn't know as
  Allow/Deny: its Deny declines the secret, and its Allow is refused with
  a note to update the app or answer on the Mac.
- **The seal.** The phone makes an ephemeral X25519 key (`epk`), agrees a
  shared secret with `key`, and derives a 32-byte key with HKDF-SHA256
  (salt `epk ‖ key`, info `threadbear secret v1 <approvalId>`), then
  AES-256-GCM with a random 12-byte `nonce`; `box` is ciphertext then
  the 16-byte tag. All base64. Binding the approval id into the key means
  a sealed answer can't be replayed onto another card.
- **Trusting the key.** A card's `runnerId` and `key` both come from the
  mirror, which the owner key can write for any runner (and, before
  runner keys, any runner's key could; see Runner keys), so the phone
  takes neither on trust. It seals only to a runner whose key it already
  keeps (keychain, by `runnerId`, per deployment), and it keeps keys only
  from the pairing link: `devices.pair` adds a `key=<runnerId>:<key>`
  item for the runner that drew the code (its `secret-box.key`, raw
  X25519, standard base64), and pairing keeps each, replacing any kept
  before for that runner. A card for a runner with no kept key is refused
  ("The phone doesn't know this Mac yet, so it won't send it secrets.
  Answer it on the Mac, or pair the phone again.") and nothing is kept
  from it. A different key from the kept one is refused with "This Mac's
  key changed. Answer it on the Mac." Keys kept before this rule (when
  the first key a card carried was kept) still count, so a phone that
  already answered a Mac's secrets goes on doing so. A pairing link from
  before keys still pairs, but its phone can't answer secrets until it's
  paired with a new code. A second Mac (one whose threads reach the phone
  through the same deployment) is trusted only on a phone that kept its
  key before, or once that Mac draws the pairing code. Every pairing
  link is asked about first, as any web page can open one: from the
  Camera, the pair screen's scanner or the clipboard, paired or not (an
  expired token leaves the phone unpaired, and that once let a link in
  unasked). The question names the server and says whether the Macs it
  may send secrets to change ("Pair with <host>?"); Cancel keeps the
  saved pairing and kept keys as they were. The phone also keeps
  the runner it first saw each thread on (keychain, by `threadId`),
  pinned when the thread first shows in a list or on a trusted secret
  card. A card on a thread whose `runnerId` differs from its pin is
  refused ("This thread's Mac changed, so the phone won't send it
  secrets. Answer it on the Mac."), since runners never take over each
  other's threads (a handover keeps the runner id). Deleting
  `secret-box.key` on purpose, or changing a runner's `sync.runnerId`,
  means pairing the phone again from that Mac.
- **Keeping.** Files and helpers go 24 hours after they're written: the
  runner sweeps the folder when it starts and hourly. Nothing else keeps
  the value: the runner holds it in memory only long enough to write it.
