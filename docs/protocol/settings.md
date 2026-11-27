# Runner protocol: Agents, settings and pools

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

## ACP agents

Agents that speak the [Agent Client Protocol](https://agentclientprotocol.com)
(runner/src/adapters/acp/) run as one process per live thread, over stdio.
Where one's CLI isn't installed and logged in, no account or pool of its
appears. `runner.json`'s `cursorPath`,
`opencodePath`, `grokPath` and `antigravityPath` set a binary by hand; otherwise each is found
where it installs (Antigravity: an `agy_acp_server.par` on the PATH).

- **One login each**, per machine, ids `opencode-main`, `cursor-main`,
  `grok-main` (signed in: `~/.grok/auth.json` exists, never opened) and
  `antigravity-main` (signed in: `$GEMINI_HOME/antigravity-acp/acp_token.json`,
  `~/.gemini` by default, exists, never opened). No
  usage readings, so a pool can't move a thread by room.
- **Which program.** The process must say it's that agent in `initialize`, or
  the thread doesn't start. `agent` is a generic name: a file only counts as
  Cursor's by where it really lives (`~/.local/share/cursor-agent/...`), and
  only as Grok's when that's named `grok` or `grok-<version>...`. Antigravity's
  `agy_acp_server.par` and the `localharness_external` beside it must both be
  signed by Google (team `EQHXZ8M8AV`, checked with `codesign` on a Mac), and
  it must call itself `antigravity-acp`.
- **Asking.** Every tool comes to the runner first. OpenCode gets `*: ask` as
  inline config, with `OPENCODE_DISABLE_PROJECT_CONFIG=1` (and 2's
  `OPENCODE_CONFIG_PROJECT_DISABLE=1`), `OPENCODE_CONFIG` blanked, a config
  folder of the runner's own (`OPENCODE_CONFIG_DIR`, which on 2 replaces
  `~/.config/opencode`) and, on 1, `--pure`: a folder's `opencode.json`
  outranks inline config, and plugins are imported as a session opens, before
  any rule can turn them off. OpenCode 1 imports a folder's
  `.opencode/plugins/*.js` whatever it's told, so on 1 an asking thread or a
  small job doesn't start under a folder that has some. Each request is answered from the thread's mode when it comes
  (Full: allow; otherwise the card). Only the once options are ever chosen, as
  an agent remembers "always" past the thread; "Always allow" is the runner's
  rule (`acp:edit`, or the exact plain command in the folder it runs in: the
  call's `workdir`, `cwd`, `workingDirectory`, `directory` or `dir`, else the
  thread's, as the disk has it: links followed before any `..`, so a link
  pointed somewhere new isn't the folder its rule was for). A folder that
  isn't there, or that reads differently tidied first (`link/..`), isn't
  covered by a rule either. The card shows the folder resolved, and as the call
  gave it when that differs, and an allow is refused if it resolves somewhere
  else by the time it's answered. A command call naming two different folders, or carrying anything
  but those, `command`, `description` and `timeout` (an env, a shell), isn't
  covered by a rule and can't be always allowed, and its card shows all of it.
  An edit of a file that runs as
  code asks every time, and so does an edit whose arguments aren't the plain file
  tools' (nothing can say where else it writes). Auto acts like Ask.
- **Questions.** A thread offers forms (`clientCapabilities.elicitation.form`).
  An `elicitation/create` in form mode becomes question cards, one per field:
  its description is the question, its title the header, a list a multiple
  choice. Only the last card takes typed words, so a field with no choices goes
  last (a form with two can't be shown, and is declined with a note), and
  words typed in place of a choice go to the field's `<key>_custom`, where it
  has one. The answer is `accept` with the content, `decline` when the card is
  dismissed or a required field has no usable answer, and `cancel` when the
  turn stops; URL mode is declined with a note. OpenCode 2's question tool
  asks this way, so `question` is allowed in threads. Small jobs offer no
  forms and deny it.
- **Cursor** can't be told to always ask (its allow-list and a folder's
  `.cursor/cli.json` can approve things), so Ask, Auto and Plan first run in its
  read-only `ask` and `plan` modes; a thread that can't be put in one doesn't start.
- **Grok** has no setting a client can force: its mode comes from its config
  and from `~/.claude/settings.json` (`defaultMode: "auto"` there made 1.0.77
  run a write and a command with no request, 15 Nov 2026). So it runs as
  `grok agent --no-leader --plugin-dir <data dir>/grok-guard/threadbear-<16 hex>
  stdio`, a plugin made for that start: its PreToolUse hook (`guard-ask.mjs`,
  run by the runner's node, `failClosed`) answers `ask` for every call but a
  read (`read_file`, `list_dir`, `grep`, its tool search, its to-do list, a
  command's output) naming nothing outside the thread's folder, links
  followed, with no `..` anywhere. A hook's `ask` reaches
  `session/request_permission` whatever Grok's mode, saved grants, read-only
  commands or a folder's rules say. Leader mode ignores `--plugin-dir`, hence
  `--no-leader`. A folder can turn a plugin off by name (`[plugins] disabled`
  in its `.grok/config.toml`, untrusted too), hence the random name, and the
  plugin's UserPromptSubmit hook: Grok reports each hook it ran
  (`_x.ai/session_notification`, `hook_execution`), and a turn where the
  model says anything before that report names the plugin, or a
  `user_prompt_submit` or `pre_tool_use` report without it, ends the process
  there with an error (small jobs fail the same way). A folder Grok trusts
  (`~/.grok/trusted_folders.toml`, or one above it, and always the home folder
  and a disk's root) runs its own hooks, which can act at session start and
  rewrite a call after the guard has looked: a Grok thread there starts only
  on Full, and the guard asks for everything there. Trusted when the process
  started stays so for its life (the start's plugin passes `trusted` to the
  guard), so leaving Full stops it even if the folder has left the file since. Grok has no session modes, so nothing else changes with the
  thread's mode; in its auto mode its classifier still looks first and may
  refuse a call. Grok adds the hook to a request's title (`— hook '...'
  asks: ...`), which the card leaves off, and its MCP calls go through
  `use_tool` naming `<server>__<tool>`: one of the session's own
  `threadbear__` tools is allowed as it comes, as the MCP server gates it. A
  rejected call ends Grok's turn (`stopReason: "cancelled"`).
- **Antigravity** (Google's `antigravity-acp`, shown as Gemini) asks before
  every tool in its `default` mode, so it's never moved off it (`auto_edit`
  and `yolo` would approve by themselves), and each request is answered from
  the thread's mode. A read whose files are all inside the thread's folder
  (as the disk has them, links followed) goes ahead without a card. It writes
  `skills/system/run-workflow/SKILL.md` into the folder its session opens in,
  so each session (new or resumed) opens in an empty temp folder of its own,
  removed when the session ends, with the thread's folder in
  `additionalDirectories`, and the first message says where the work is. Its
  shell tool's `CommandLine` and `Cwd` are read as `command` and `cwd`, and
  its MCP calls say `_meta.mcp: { server, tool }`. Keys for Google's API in
  the runner's environment are blanked, so its Google sign-in is what's used.
  It has no updater, so Update does nothing for it.
- **Gemini's plan usage** (since 23 Nov 2026). Antigravity's turns carry no
  usage reading, so the runner reads the Google plan's quota itself with the
  server's own `/usage` command, which it answers in its ACP layer with no
  model turn and no quota spent: a short-lived process in an empty temp folder
  (`session/new`, then `session/prompt` with the text `/usage` only if the
  session's `available_commands_update` lists `usage`, then `session/close`).
  It's read a minute after the runner starts, whenever its last reading or
  try is 10 minutes old (`LIMITS_POLL_MS`), and 5 seconds after a Gemini turn
  ends, at most every 2 minutes (`runner/src/limit-recheck.ts`). The answer
  is markdown, not a contract (`runner/src/adapters/acp/agy-usage.ts`): the
  "Gemini Models" group's weekly and 5-hour lines become the login's
  `weekly` and `five_hour` windows (remaining percent, resets read only when
  they say UTC), which decide its room as Claude's and Codex's do, with
  `blocked` when either is under 1%. Any other group ("Claude and GPT
  models") adds a `weekly_model` window, `Weekly <group>`, and an `other`
  one, `5-hour <group>`, which never decide it: nor when a block ends, nor
  whether a login a turn ran dry is back. `plan` is session/new's
  `_meta.antigravity.tier.name` ("Google AI Ultra"), sent only with a reading. An answer that doesn't
  read, or no Gemini group (or two), is no reading: nothing is recorded and
  nothing is shown as an error. The login's token is never read.
- **Cards for ACP tools.** Every frame of a tool call (its updates and its
  permission requests) is kept by id for the session, and a call is judged
  on all of them: what it said earlier can't be washed out by a later
  frame. Only two cards are short: a plain shell command whose single
  folder is known (the phone may allow it) and a plain edit of files inside
  the folder (every frame a plain edit, every path spelled whole, no
  `..`, `~`, dangling link or unreadable patch header). Every other card
  shows which tool it is, its arguments as sent, whatever earlier frames
  said differently and every file it names as spelled; only the Mac allows
  it. A saved command rule needs every frame to agree and no files named
  beside the command; the edit rule covers only files inside the folder.
  Another server's MCP tool never counts as a local command or edit, and
  Threadbear's own MCP tools go ahead unasked only when every frame that
  carried anything named that tool.
- **Plan first** uses the agent's plan mode, and the last reply of a turn is
  proposed as the plan.
- **The threadbear tools** reach the agent as an MCP server over HTTP on
  `127.0.0.1` (a port per live session), with a random bearer token in a
  header; loopback `Host` and no `Origin` required. They go through the same
  gate as a Codex thread's, so `delete_thread` always asks.
- **Small jobs** (titles, summaries; `models.run`) run on OpenCode or Grok only when
  Settings picks a pool with no Claude login in it (never on Cursor, whose read
  tools can't be turned off), so the built-in `claude`
  pool never becomes another agent. The agent starts in an empty folder with no
  MCP servers and every tool denied (Grok: the `threadbear-deny` plugin, whose
  hook denies every call, reads too), in its read-only mode where it has one;
  every request it makes is refused, and the prompt goes over stdin, never in
  its arguments.
- **Updates.** Threadbear never updates these CLIs by itself, as they have no
  version feed to compare with: `clis.list` has a row for each, and
  `clis.update` runs the agent's own updater when asked. `clis.setPolicy` does
  nothing for them, and `THREADBEAR_CLI_UPDATES=off` turns updating off.
- **Not offered:** rewind, steering
  (a message sent during a turn runs next).

## Settings and models

The runner makes small model calls of its own (classify, extract,
summarise, generate) for features like titles, the librarian and "wake
when" (`src/models/`). Features ask for a job, not a model: `ROUTES` says
which model answers it, Haiku for everything but `decide`, which is Opus.
Every call runs on the official `claude` CLI on one of the Claude logins
in the pool `models.pool` names: the same CLI and logins as threads, so
it needs no key and costs nothing beyond the login's usage.

There used to be OpenRouter as well, with a key, a daily budget and a
spend to show. It went on 29 Oct 2026: every feature is Haiku or Opus,
which the pool runs anyway, and a key was one more thing to set up. An
older runner's `openRouterKey`, `dailyBudgetUsd`, `spentTodayUsd` and
`spentMonthUsd` in `Settings.models` are ignored by clients, and
`secrets/openrouter-key`, if there is one, is no longer read.

- **Consent.** A call sends thread text to Anthropic on Mike's own login,
  as the thread itself does.
- **The pool and provider order.** `models.pool` in `runner.json` is a
  pool id, `"claude"` when it isn't set, or `null` for none, which turns
  titles and the librarian off. `models.providers` is an optional ordered
  list of `smallJobs`-capable providers (`claude`, `codex`, `grok`,
  `opencode`), or `null` / absent for the default order: Claude first (on
  the login it ran on last while that's OK to run on, see Pools, else the
  one whose weekly window resets soonest / has the most room), then Codex,
  then any other `smallJobs`-capable logins in that same pool in pool
  order. When `models.providers` is set, only the listed providers are
  tried, in that exact order, and the next provider takes over whenever
  every login of the current one is out of room or fails. Spillover never
  leaves the chosen pool, so separate pools (such as a work pool) stay
  isolated, and providers without `smallJobs` (Cursor, Gemini) are never
  used.
  - On Claude, the CLI runs as `claude -p` at low effort in an empty
    folder (`models/cli` in the data dir), with no tools, MCP servers,
    settings, hooks, CLAUDE.md, skills or saved session (`--tools ""
    --strict-mcp-config --setting-sources "" --disable-slash-commands
    --no-session-persistence`), the job's own system prompt, and
    `--json-schema` for classify and extract.
  - On Codex (`runner/src/models/codex-oneshot.ts`), `codex exec` runs in
    the same empty folder with `--ephemeral --ignore-user-config
    --ignore-rules --skip-git-repo-check --sandbox read-only`, low
    reasoning effort, `approval_policy="never"`, `web_search="disabled"`,
    `mcp_servers={}`, tool features disabled, `--output-schema` (in a
    temporary file outside the empty folder, removed afterwards) for
    structured output, and the prompt over stdin (`-`); stdout JSONL is
    also watched so any tool-execution item kills the process and fails
    closed.
  - A login that answers that it's out of room counts as run dry, as it
    does for a turn, and the next one is tried. At most 2 calls run at
    once, and each times out after 60 seconds.
- **Private folders.** `models.privateFolders` in `runner.json` lists
  folders whose threads are never sent anywhere, for client work and the
  like. A call for a thread in one of them, or anywhere under one,
  doesn't go out.
- **Usage.** Each call that goes out adds a line to `models/usage.ndjson`
  in the data dir: `{ ts, feature, job, model, ok, ms, inputTokens?,
  outputTokens?, accountId?, notionalUsd?, error? }`. `notionalUsd` is
  what the CLI says it would have cost on the API, which isn't spent. No
  text from the call is kept.
- **Titles.** A new thread's title is the first line of its first
  message, as before; a few seconds later a small model's title replaces
  it, unless someone has set one meanwhile. Threads from before any
  model could be reached keep their first line until `threads.retitle`
  names them too. Later, the librarian renames a thread whose title no
  longer says what it's about (see Projects).
- **Failures.** A call never throws: it says why it didn't answer
  (`no-pool`: no pool, or none of its logins can run small jobs under
  `models.providers`; `no-room`: every login is out of room; `off`: this
  runner makes no model calls; private folder, timed out, error), and the
  feature falls back to what it did before there was a model to ask.

## Standing instructions

`runner/src/instructions.ts`. After Wayne Sutton's PR (7 Nov 2026); an
experiment until 11 Nov, standard since. Text Mike writes in Settings > General, given
to every session on every login, Claude and Codex alike, which a login's
`CLAUDE.md` or `AGENTS.md` can't do.

```ts
type StandingInstructions = {
  text: string    // what's saved, up to 20,000 characters; "" for none
  outside?: true  // instructions.md isn't what Settings last saved, so no
                  // agent is given it. `text` is what the file holds now
                  // ("" if it's gone or can't be read), to read and decide
}
```

- **Who's told.** A fresh session gets them first in its instructions
  (Claude's appended system prompt, Codex's developer instructions). A live
  or resumed one is told a change once, before Mike's next message that isn't
  a command, sent into a running turn too, as a resumed Claude session keeps
  its first system prompt, and the thread gets a `system.note` saying so.
  `instructionsTold` on the thread record is the hash it last heard (`cleared`
  once told they've gone; `rewound` when what it holds isn't known, so the next
  message says what's current: after going back in the session, Claude's
  `/clear`, a session id already in use, or a turn that didn't complete after
  news went out in it), set once the CLI has taken the message, and absent while
  it has never held any. With nothing ever set, nothing is added and the field isn't written.
- **Where.** `instructions.md` in the data dir, and beside it
  `instructions.sig`: the hex HMAC-SHA-256 of the file's bytes, after the line
  `threadbear-standing-instructions-v1`, keyed by the runner's RPC token as
  it was when the runner started, never the file read again.
- **Only `instructions.set` makes them count.** They reach every future
  session in every folder, Ask and Auto threads included, so a thread that can
  write a file mustn't be able to brief all the others. Each read is one read
  of the file, checked against the signature, and what's given is those bytes.
  A file that doesn't match, a signature or file that's missing while the
  other is there, a link, a FIFO or a file over 64 KB gives nothing, and
  `outside` says so. The runner says it once per version with a `runner.notice`
  (`warning`, and after `hello` while it lasts) and `instructions.updated`, and
  live sessions hear they no longer apply. Nothing comes back until Mike saves
  in Settings, which sends the text on his screen, not "trust the file". That
  text stays as it was while he reads, with a button for a newer version, so
  a file changed while he reads isn't what gets signed.
- **Agent edits.** Both files are in the data dir, so outside Full access an
  Edit, MultiEdit, Write or Codex patch of either always asks, with no "Always
  allow" ("Agent writes that run as code"). A shell write that gets past Auto's
  classifier, or any write on Full access, trips the signature instead.
- **Who can call it.** Only a client holding the runner's token. The agent
  tools have no such method, and neither the backend nor another runner can
  reach it: `relay.ts` and `sync.ts` pass only the methods they list.
- **The limit.** Writing them takes the runner's token, however it's done. A
  Full access agent runs as Mike, so one that sets out to can read
  `secrets/runner-token` and call `instructions.set` or sign a file, as it can
  call `patches.trust`. That's the line Full access already draws: this stops
  a write that leaves the credential alone, and makes anything else a deliberate
  act against it. Replacing `secrets/runner-token` needs no read of the old one,
  and picks the key from the runner's next start (the app reads the new token
  when it reconnects, so nothing asks). The same replacement hands over all of
  the runner's RPC, which isn't special to this. Nor does it stop an older signed
  pair being put back: those are Mike's own words from before. And news told by
  message, not in a fresh session's instructions, can fade in a compaction, as a
  project's joined line can.

With the `recipes` experiment on, the habits of the recipes the user has
switched on are given after these, in the same message and the same note
when either changes (projects.md, "Habits").

## Shared memory

`runner/src/memory-sync.ts`, `convex/memorySync.ts` (API 84). The
`sharedMemory` experiment, on each runner that takes part. What Claude Code
loads before the first message (the global `CLAUDE.md`, and the project's
memory folder with its `MEMORY.md`) is most of what makes a thread know
Mike, and it lived on the main Mac alone.

- **Paths.** `global/CLAUDE.md`, or `memory/~<rest>/<name>.md`, where
  `~<rest>` is Claude Code's project slug with the home folder's slug cut off
  (`-Users-m5-mike-dev-me-misc` is `~-dev-me-misc`, and lands in
  `-Users-bruce-dev-me-misc` on Bruce). Folders outside home, and under
  `~/Library`, aren't shared. Files are up to 128 KB; both sides check the
  same pattern.
- **The main Mac** (the owner key) scans each Claude login's `CLAUDE.md`
  (`~/.claude`'s first) and `projects/*/memory/*.md` once a minute, masks
  secret values it knows of, and sends what changed or went to `putMemory`.
  Each change takes the next `seq`; a deleted file stays as a `gone` row.
- **The others** read `memorySince(after)` a page at a time into
  `memory-cache/` in the data dir, then each pass make every Claude login (and
  Codex's `AGENTS.md` for the global file, where there's a Codex home) match
  it, so a login added later, or a file deleted by hand, catches up. Only
  places whose real path is inside a login's folder, a Codex home or
  `~/.agents` are written. `memory-sync.json` records, for each file on disk,
  the hash sync last wrote there:
  - missing: written; already the main Mac's version: adopted (kept up to
    date, never deleted);
  - something else there before sync wrote to it, or a file too big or not a
    plain file: left alone for good, and offered once;
  - changed since sync wrote it: offered, and kept until the main Mac has a
    newer version, which then replaces it;
  - every write and delete happens after the pass's offers have gone, and
    only if the file is still as it was read, so an edit landing in between
    waits for the next pass.
- **Offers** are a runner key's agents' new or changed files, one row per
  version (two logins' different edits of one file are two offers), at most
  200 waiting per runner (`memoryOfferCounts`). Only the owner reads them
  (`memoryOffers`, 20 at a time), and it writes each to
  `memory-offers/<runnerId>/<path>/<hash>.md` in its data dir, never into
  memory, then `takeMemoryOffers`; past 20 MB there it stops taking them, so a
  runner key can't fill its disk. Folding them in is for Mike or a scheduled
  job (the nightly retro on Mike's Mac). A runner key can't write
  `memoryFiles`, so it can't change what the main Mac's agents, or any other
  runner's, are told.
- **Sizes.** At most 50 files and 2 MB of text a call (the runner sends up to
  1 MB). A stopping or handing-over runner stops syncing first.
- **The limit.** Anything that can write a memory file on the main Mac can
  brief every runner's agents, as it already briefs every thread in that
  folder there. Memory goes to the backend in the clear, as transcripts do.

## Explain

Mike can select words in a thread's transcript and pick Explain from the
little bar that shows above them. The explanation opens in the pane beside
the transcript, with a box under it for a follow-up question. It's a mini
fork of the thread for that one thing: `threads.explain` sends the
selection, the message it came from, the thread's first message and
its last 8 messages to the small model (job `generate`, feature `explain`,
so Haiku on the pool first), and the answer goes back to the app alone.
Nothing goes into the thread's events, so the agent never sees it and its
context doesn't grow. The side conversation lives in the app (one per
thread, gone on quit); each follow-up sends the earlier answers again as
`earlier`. Private folders, the pool and the budget apply as for any
model call.

## Hibernate in words

Besides the presets and a picked time, Mike can say when a thread should
come back in his own words: "tomorrow morning", "Friday 9am", "at the
weekend", "in a few weeks", "next time I talk about woodworking". Plain
time expressions (relative durations like "2h" or "in 2 weeks", times of
day, "tomorrow", "tonight", "at the weekend", weekdays, calendar dates
and ISO timestamps) are worked out locally right away (`parseWakeTime` in
`wake-when.ts`), with no model call, so they still work when every login
is out of room or models are off. Topics, events and fuzzy phrases
hibernate the thread straight away (`snoozedUntil` 9999-12-31,
`wakeWhen: { said, pending: true }`), then ask the pool's strong model
(job `decide`: Opus on Claude first, spilling over to other small-job
providers in the pool if Claude is out of room; feature `wake-when`) with
the local time and time zone, the thread's title, first message and
brief, and his words. It answers with a time, a topic, or both:

- **A time** becomes `snoozedUntil`, and the thread wakes as any snooze
  does.
- **A topic** ("woodworking") waits for the librarian. While any thread is
  waiting on one, every look lists them, and its answer's `wake` names the
  ones Mike's own messages in the looked-at thread are about. Each wakes,
  unread, with a `system.note` saying where ("Woke up: you talked about
  woodworking in "Router table jig"."). A topic with no time has the far-off
  `snoozedUntil`; with one, whichever comes first wakes it.

The thread's own agent can ask the same in end_turn's snooze ("until the
GPUI app replaces the Swift app"). Then the model is told it's an agent
waiting for something to happen, and a topic is that thing said as done
("the GPUI app has replaced the Swift app"). The runner keeps who asked
(`by: 'agent'`, never in a `ThreadSummary`), the librarian's look lists
those separately and wakes one only when the looked-at thread shows it has
happened, not when it's planned or talked about, and the thread wakes
("Woke up: to check whether …, from "GPUI Port Coordinator".") with a
runner message giving the agent a turn to check for itself and snooze again
with the same words if it hasn't. That message names the other thread's id
only when send_message would let it without a card.

**A check is quiet.** Both wakes that give the agent a turn to check (the
librarian's, above, and one at a wait's latest time, below) go through
`Runner.wakeToCheck`. The wake doesn't mark the thread unread (no `woke`
on its summary, no notification or push): on 20 Nov 2026 a wrong guess by
the librarian woke a thread for 26 seconds and pinged Mike's phone. How
the check's turn ends says whether he's needed. Back to sleep (a snooze,
`waitFor`, an archive): nothing. Anything else leaves it in the inbox,
unread and with its "Woke up", whatever `needs` it ended with, as the
thing has happened or the agent wants him; so does a snooze that doesn't
take, and a turn that ends with the check still owed (it failed, or was
stopped as it finished). Not while the runner is about to carry the turn
on (a full login, a lost network), nor after a turn Mike's own message
was in, and a helper thread that archives itself (A quiet inbox) is marked
only if it stays. A mark left from before the thread slept is cleared as
the check wakes it. A check that can't start (behind a queued message or a move, or
held for Mike because the thread has more access than when it wrote its
words, `runner/src/runner/ceiling.ts`) is unread at once, as any wake is. Until the check's
turn completes, the record keeps why it woke as a line for the agent
(`wakeNews`, with `check`: the check's message id), which goes in front of
any other message: one that runs ahead of a check still queued is told the
check comes next, and one after a check that never reached the agent (its
folder gone, a restart while it was queued, Stop) is told to do the check
then.

**The latest time passing.** A wait in words with a time as well wakes at
that time if nothing else woke it first (`Runner.wakeAtTime`; the words
and numbers are in `wake-when.ts`):

- **Mike's own** comes back as it always has, in the inbox with no turn,
  but its `system.note` says why ("Woke up after 2 days: you haven't
  talked about woodworking, and this was the latest it would wait
  (Saturday 31 October, 9 am).").
- **Its agent's** gets a turn to check for itself, as when the librarian
  thinks it has happened: a note ("Woke up after 18 hours: still no sign
  that …, and this was the latest it would wait (…). Its agent is checking
  for itself.") and a runner message (`wakeReason` "The latest it would
  wait passed") that says the time ran out with nothing seen, to check the
  work itself, to snooze again with the same words if it hasn't happened,
  or to end the turn with no snooze and `needs: "you"` if it never will or
  Mike should chase it. It's quiet, as above. No check starts while the runner is still
  starting, handing its threads over or waiting to restart: the thread
  sleeps on, its time passed, and the next runner (or this one, a minute
  on) gives it. The record counts these (`lateChecks: { n, waitedMs,
  since, backOff? }`, never in a `ThreadSummary`) until Mike next writes to
  the thread, whatever words the agent snoozes with. A snooze in words at
  the end of the check's own turn (or of one the runner carried it on
  with) has a latest time at least twice as far off as the last sleep was
  meant to be, a week at most (the model's own when that is later). While
  checks are counted a wait in words always has a latest time, even when
  the model gives none, and a snooze that doesn't take leaves the thread
  unread. After three checks in a row the next latest time runs no turn:
  the thread lands in the inbox, its note adding how long it has waited
  and that it's Mike's to decide.
- A wake at a latest time that ran no turn is kept as a line for the agent
  (`wakeNews`, "Note from Threadbear: this thread woke by itself on …"),
  which goes in front of the thread's next message as news of a button
  press does, is told again if that turn doesn't complete or the thread
  moves to a fresh session within three days, and is dropped when the
  thread next sleeps. A check keeps one too until its turn completes, so a
  check that never reached the agent (its folder gone, a restart while it
  was queued, Stop) is said with the next message, which asks for the
  check then; a message that runs ahead of a check still queued is told
  the check comes next.

A thread archived while it slept ends its sleep quietly, as before. A
runner that was down at the latest time gives the check once it's
listening. A time alone (a preset, "2h", words read as only a time) wakes
as before.

The thread gets a `system.note` saying what was worked out ("Hibernating
until Saturday 31 October, 9 am. You said "at the weekend"."). A model
that can't say (no pool room, an answer that isn't a time or a topic)
puts the thread back and fails the call. A private folder's thread is
asked about with his words alone. Any other snooze, a wake or a message
clears `wakeWhen`, and a runner that restarts while one is pending wakes
the thread, as the answer is lost.

## Usage history

The Usage panel shows more than what's left: how many tokens each login
has spent today, how fast, and how its limits have gone down over the
week. `usage.stats` answers with what the runner has kept:

```ts
type UsageStats = {
  generatedAt: string
  // Whether the first read of the CLIs' transcripts has finished. Until it
  // has, `tokens` is partial and the app says so.
  ready: boolean
  // Per login, the hours it spent anything in, oldest first. Each hour is
  // [startMs, input, output, cacheRead, cacheWrite]: startMs is the start
  // of the hour (UTC, so the app buckets days in its own time zone).
  // Claude's input excludes cache reads and writes; Codex's input excludes
  // its cached input (counted as cacheRead).
  tokens: { accountId: string, hours: [number, number, number, number, number][] }[]
  // Per login, readings of its 5-hour and weekly windows over time, oldest
  // first: [atMs, remainingPercent]. A sample is kept when a window moves
  // by half a point or more, at a reset, and at least every 30 minutes
  // while readings keep coming, so a flat line still has points. A model's
  // own week ("Weekly Fable") is kept too, as `weekly_model` with the
  // window's `title`, one entry per title, after the main two. An app
  // matches it to the window by kind and title, and skips kinds it
  // doesn't know.
  limits: { accountId: string, kind: "five_hour" | "weekly" | "weekly_model", title?: string, samples: [number, number][] }[]
}
```

- **Tokens** come from the CLIs' own transcripts, not just Threadbear's
  threads, so turns run in a terminal or another app count too: Claude's
  `<configDir>/projects/**/*.jsonl` (assistant lines, each message id
  counted once at its biggest, as Claude Code writes a message several
  times while it streams), and Codex's `<configDir>/sessions` and
  `archived_sessions` (`token_count` events, the difference between one
  total and the last). The runner reads only what's new since its last
  look, once a minute, and keeps the hourly totals and where it got to in
  each file in `<data dir>/token-tally.json`, so a restart doesn't read
  everything again. The first read goes back 14 days and takes a while
  (`ready: false` until it's done). Hours older than 15 days are dropped.
  `THREADBEAR_TOKEN_TALLY=off` turns the reading off (dev runners and the
  e2e tests set it): `tokens` stays empty and `ready` false.
- **Limit readings** are whatever `accounts.updated` would show, sampled
  as above into `<data dir>/usage-history.json`, kept for 8 days.
- A draining runner (Handovers) keeps neither file: both are the new
  runner's to write.

## Sandboxed threads (taken out)

An experiment from 6 Nov 2026 ran a thread's Claude Code in a Docker
container when its folder was under one of `runner.json`'s `sandbox:
{ folders }`. It was taken out on 16 Nov 2026, unfinished and before
anyone relied on it. What's left fails closed for a copy that had it on:
a thread in a folder `sandbox.folders` still names, or one whose record
says it ran shut in one (`confined`), isn't started (`threads.create`
refuses, and a message to an old one gets a note saying why) rather than
running on the machine instead; taking `sandbox` out of runner.json says
that's fine. Such a thread counts as the least access there is, below
even Ask, so its title and words reach no other thread without a card
(a quiet-inbox wait), and it gets no lab review (which would run its
tests on the machine). `threads.create` with `confined: true` (an older runner
handing over a sandboxed agent's call) is refused. A thread's move still
says `unconfine: false` for an agent's to an older runner across a
handover (the phone's path too), and the runner reads `unconfine: false`
from one as `byAgent`.

## Pools

From API 111, `backup?: Record<string, boolean>` maps pool member login ids to backup choices.
Missing entries mean backup for Grok/OpenCode, main for others; `false` makes either a main login.
Older configs need no migration. Shared members use optional `backup?: boolean`, translated to local ids;
older clients omitting it preserve choices. Usage-pool heartbeats send the map from API 111;
explicit edits against older backends are refused with an update message. Older runners ignore the field.
Failover tries the same provider (main, then backup), other main providers, then backup providers in pool order;
reset-based selection within each tier stays unchanged. Unhinted new threads prefer main providers; explicit choices may use backups.
See the [Usage display](../guide.md#accounts) for the desktop fill and tooltip.

A pool is a named, ordered list of logins, of any provider. Mike picks a
pool and a model; the runner picks which login runs each turn, and moves a
thread to another login when the one it's on runs out of room.

- **The list.** Built in, worked out from the logins the runner finds: one
  pool per provider (`claude`, `codex`) holding every login of that
  provider without a note, and one per noted login, titled from its note's
  first word (`convex` for claude-2's "Convex work only", with folders
  `["~/dev/convex"]` from the code). `runner.json`'s `pools` replaces the
  whole list; `pools.save` writes it. A pool's `accountIds` order only
  decides which provider comes first; within one provider the runner goes
  by room.
- **Shared between runners** (backend API 38). With a backend, the list
  lives in its `pools` table and every runner follows it, so a pool is the
  same on each machine. A shared pool names its logins by provider and
  email (`members: [{ provider, email }]`), since login ids are each
  runner's own (`claude-main` is a different login on each machine); a
  login with no email known is named by `{ provider, runnerId, accountId }`
  and only counts on that runner. Two logins of one provider on a runner
  can share an email (two config folders signed in to one account), so
  from backend API 75 a member saved from one of those carries both,
  `{ provider, email, runnerId, accountId }`: its own runner takes it by
  id (by email if that login has gone), and every other runner by email,
  as usual. `sync:pools` gives another runner's key such a member without
  the ids. Before 75 the runner sends the email alone, as the older
  backend hid any member with a runner id from other runners' keys; a
  list saved then still reads, by email. A save on another runner keeps a
  pinned member as it was while that runner's pool still has the login it
  matches by email. Each runner turns the list into its own
  `Pool[]`, with `accountIds` its logins that match, in member order, and
  leaves out a pool none of its logins are in. `pools.list`, `hello` and
  `pools.updated` carry that, so clients see no difference. `pools.save`
  on any runner writes the shared list: the pools it was given, in that
  order, each keeping the members this runner has no login for, then the
  pools it couldn't see, unchanged. The first runner to meet API 38 with
  `pools` in its `runner.json` puts them in the table if it's empty
  (`sync:adoptPools`, first one wins); until the table has pools, each
  runner keeps its own as before. The runner keeps the last list it saw in
  `shared-pools.json` in its data folder, so it starts with it while the
  backend can't be reached. `runner.json`'s `pools` is left as it was, and
  is used again only with sync off. `defaults.poolId` stays each runner's.
- **Shared readings** (backend API 39). A subscription is one limit
  wherever it's signed in, so each runner also reads the other runners'
  latest usage readings every 5 minutes (`sync:sharedUsage`, from their
  `accounts` rows; a query on a timer, not a subscription, since that re-ran
  on every other runner's login write)
  and counts one of the same provider and email as a third source beside
  Token Stats and its own turns: the newest reading wins, window by
  window, and `usage.source` is `"shared"` when another runner's was the
  newest. A shared reading Token Stats called stale is left out, and one
  that says `blocked`, taken after this runner last read the login,
  blocks it here too until a window at its limit resets. Only readings
  marked `byOwnerKey` (backend API 53) count, the ones the main Mac's key
  wrote; a runner key's go to nobody, and a runner takes no unmarked one
  (all of them, from an older backend). Which logins a runner key's
  runner gets them for is the owner's word (Runner keys, "Shared
  logins").
- **New threads.** A `threads.create` without `accountId` picks the pool:
  `poolId` if given, else the pool whose `folders` holds `cwd` (the
  longest match), else `defaults.poolId` (`runner.json`'s, the pool last
  named in a `threads.create`; failing that, the pool holding
  `defaults.accountId`). When a `model` is named, the runner looks for
  logins listing that model. With a named pool it looks inside that pool,
  using `provider` if given. Otherwise it tries the preferred pool first,
  then the other pools in order, looking for a matching login with room.
  If every match is out of room, the first matching pool and login are
  used. If the matching logins are all outside the pools, an unnamed
  pool lets the thread pin to a signed-in login with no account note.
  A picker id takes precedence over a resolved alias. When several
  eligible providers list the same picker id, the runner gives Claude
  and Codex priority in that order, as the website and iPhone do in
  their pickers. If no list has the picker id and a candidate ACP
  login's list is still unknown, the runner waits for its model probe.
  Probes run independently. If the needed catalog stays unknown after
  an error or deadline, the request can be retried. A known empty list
  counts as loaded. With no unresolved ACP login, a native Claude or
  Codex id can use a login of that provider whose list is unknown. If
  there is still no match, the usual pool
  fallback checks the model against its chosen login and explains any
  replacement.
  Without a model the pool's provider and room rules apply as usual. A dev
  runner's `keepAccount` pins new threads to its account instead, unless
  that login's plan has ended (`planEnded`).
  `defaults.poolId` in `hello` is folder-blind: the app applies folders
  itself (`poolForFolder`, with the shared cases in
  `runner/test/fixtures/pool-folder-cases.json`).
- **Year-long tokens.** A Claude sign-in lasts about 28 days and can't be
  renewed; `claude setup-token` makes a token that lasts a year. Mike opts
  a login in with Year-long token… on its Usage row: the app opens
  Terminal on its own helper (`desktop/core/src/claude_token.py`), which
  runs `claude setup-token` for that login and writes
  `threadbear-token.json` in the login's folder (0600: `{ token, madeAt }`).
  Not settings.json's `env`, which Mike's logins share through symlinks.
  The runner watches each Claude login's folder for that file, so it
  sees it as soon as it lands (or at its 10-second rescan where a folder
  can't be watched), sets `yearToken`, and passes the token to that login's CLI as
  `CLAUDE_CODE_OAUTH_TOKEN` (cliEnv), where it takes over from the
  Keychain sign-in; never to another login, a client, Convex or the log,
  and Claude Code keeps it out of its tools' shells. `claude auth status`
  calls any token signed in, with no end, so a token login isn't asked:
  its `loginEndsAt` is `madeAt` plus 365 days, and the usual warning comes
  three days ahead, with New token…. A refused turn holds it out as for
  any login, until a new token. A token only runs models: claude.ai's own
  connectors and Remote Control don't work on it. Usage readings come from
  turns as before. Deleting the file goes back to the sign-in. When a
  login's `yearToken` changes, its CLIs let go of their sessions once
  their turns end, so the next turn runs on the new token, and a refusal
  on it is taken back. Each token read, whole and without its prefix, is
  a known value to the secret scrubbing, and the file a secrets file.
- **Year-long tokens on another runner.** The Usage panel's Terminal
  helper only reaches this Mac's logins. For another runner's (bruce,
  Tinker Desk, a Windows PC), the Runners panel's details for that runner
  list its Claude logins with Year-long token… (`accounts.yearToken`
  with its `runnerId`). That runner runs `claude setup-token` for the
  login itself, under a small Python helper in a pseudo-terminal 1000
  columns wide (`runner/src/year-token-maker.ts`), with the login's own
  environment and no token in it. The helper picks the claude.ai page
  (the one whose `redirect_uri` is `platform.claude.com`'s code page) out
  of what setup-token prints and says only that, `done` or `failed` to
  the runner, never anything else setup-token printed. The app opens the
  page in Mike's browser; after Authorize the page shows a code, which he
  copies and the app takes from the clipboard on Paste code, checking its
  state is the page's. The runner checks the code's shape and state
  again, types it in, then Enter on its own half a second later (sent
  together, setup-token shows the code and never takes it), and the
  helper writes `threadbear-token.json` (0600) from what setup-token
  prints, as the Terminal helper does. The runner's watch picks the file
  up as for any token. The token never leaves that machine: not in an
  answer, Convex, the relay, the app or the log. The code is single-use
  and worthless without the verifier only that setup-token holds; the
  backend keeps a `call`'s args only until it's finished. Through
  Convex it's the owner key's alone (`relay:queueCommand`), so a runner
  key can't start one. Needs `python3` and a Mac or Linux runner.
- **This Mac's logins on another runner** (backend API 105,
  `runner/src/login-share.ts`). A token works on any machine, so rather
  than signing in to each login on each runner, the Runners panel's
  details for another runner have a switch, Use this Mac's Claude logins
  (`runners.shareLogins`). Only the main Mac's runner (the owner key)
  does this; the switches are kept in its data folder's
  `login-share.json` (runner ids, and for each what last went: when, how
  it went, and a SHA-256 digest of what was sent, never a token).
  - **Which logins.** This Mac's Claude logins with a year-long token and
    an email, that aren't hidden (`hiddenLogins`), have no note
    (`accountNotes`, like "Convex work only"), haven't a lapsed plan, and
    aren't only in pools tied to folders (a work pool like `convex`). The
    rest stay on this Mac.
  - **Sending.** The main Mac asks that runner for its sealing key, a
    `call` of `logins.sealKey` (`{}`, answering `{ key }`: the public half
    of the X25519 key in its `secrets/`, the one the phone seals secret
    answers to). Only that runner's key can finish a command queued for
    it, so the answer is that runner's. Then it seals each login's
    `{ token, madeAt?, oauthAccount }` to that key (`sealBytes`: a fresh
    X25519 key, HKDF-SHA256 with the info `threadbear shared login v1
    <runnerId> <email>`, AES-256-GCM), and sends the whole set in one
    `call` of `logins.share`: `{ logins: [{ email, box }] }`, `box` the
    sealed bytes in base64, at most 20 logins and 2,800 characters a box
    (so 20 fit the backend's 64 KB of args): `oauthAccount` is trimmed to
    short plain values, 1,200 bytes of JSON at most. Convex only
    ever holds ciphertext, and only until the command is finished
    (finished args are dropped). Both calls are the owner key's alone
    (`relay:queueCommand`, and the command carries `from: "mac"`, which
    the runner checks again), so a runner key can't push logins to
    another runner. A box (virtual runner) refuses them. The runner refuses
    either call once it's over 5 minutes old (by the command's
    `createdAt`): one left waiting in the backend while it was away could
    otherwise put back logins switched off since.
  - **On that runner.** It opens each box with its private key (one that
    doesn't open, or isn't what it should be, is `failed` and the rest
    go on; the error never quotes it), tells the scrubber the token at
    once, and for each email:
    - a login folder it made this way for that email (its marker file,
      `threadbear-shared.json`, `{ email, sharedAt }`): the token file is
      rewritten if it differs (`updated`), else `same`;
    - another Claude login there with that email: if its
      `threadbear-token.json` holds exactly this token (copied by hand),
      it gets the marker and is taken on (`adopted`); otherwise it was
      signed in there by hand and is left alone (`here`);
    - none: a new `claude-<n>` in the data folder's `accounts/` (`n` the
      first number no login folder there or in Token Stats' folder has),
      made as a hidden temp folder and renamed into place, holding
      `threadbear-token.json` (0600, the folder made private first on
      Windows), `.claude.json` (that runner's own claude-main
      `.claude.json` with `oauthAccount` replaced by this Mac's, `{}`
      when it has none; the runner reads the email from it), links named
      `CLAUDE.md`, `settings.json` and `skills` to claude-main's folder
      (`~/.claude` on a Mac and Linux, `%USERPROFILE%\.claude` on
      Windows) where those exist, and the marker (`added`). On Windows a
      folder link is a junction; a file it can't link (no Developer Mode)
      is left out and said in the login's `message`; the login still runs.
    - Every marked folder whose email isn't in the set is removed: its
      token file deleted, then the folder moved to `accounts/.removed/
      <id>-<time>` (kept for its sessions). A folder without the marker
      is never touched, nor one that's a link or junction to a folder
      elsewhere (only real folders directly in `accounts/` are taken on,
      renewed or removed). On Windows a folder is made private (the
      helper's `privateDir`) when it's made, before any link goes in, and
      when it's taken on; one the helper refuses (it holds links) is left
      as it is (`here`, with why). A renewal doesn't ask again, as the
      links it made would fail that check. A half-made temp folder left by
      a runner that stopped partway is cleared, token first, and so is any
      token (or a cut-short copy of one) left in `accounts/.removed/`.
    The runner reads its logins again and answers `{ logins: [{ email,
    state, accountId?, message? }], removed: [{ email, accountId }] }`.
  - **Its shared list.** Then the main Mac adds `claude:<email>` to that
    runner's shared logins (Runner keys, "Shared logins") for each login
    `added`, `updated`, `same` or `adopted`, and takes out each removed,
    leaving the rest of the list as it was. Not for a runner on the main
    key, which needs none. Emails removed there that the list update
    missed are kept in `login-share.json` (`unlisted`) and taken off at
    the next try, and so are emails this listed before (`listed`) that
    aren't there now, in case a removal's answer was lost. A switch
    flipped is saved before anything is sent, or refused. A `failed` line
    comes through for any email (a removal there that didn't go keeps the
    switch trying); every other line only for an email this sent. A
    runner the backend no longer has (`sync:runnersList`) can still be
    switched off: it's just forgotten. One the backend has but the
    sidebar's list doesn't yet (just after a start) can be switched off,
    sent by the timer, but not on until the list says it isn't a box. Each email
    is recorded in `listed` before it's put on the list.
  - **Again by itself.** While the switch is on, what would be sent is
    worked out again on every accounts change (a token made or renewed,
    a login hidden or noted) and every 10 minutes, and sent when its
    digest differs from the last that landed, or the last try failed
    (that runner offline, say: it goes when it's back). Whether a runner
    is online is asked of the backend then (`sync:runnersList`, heard from
    in the last 3 minutes), as the sidebar's list stops updating while no
    app is open; nothing is queued for one that isn't, including a switch
    flipped while it's offline. The main Mac takes from the answer only
    lines for emails it sent (a runner key could name any). A runner
    handing over to a new release stops sending and takes no switch.
  - **Off.** `logins.share` with no logins: that runner removes every
    login it got this way and the main Mac takes them off its list.
  - **For the app.** `runners.sharedLogins` lists each runner's switch
    and how it went, with `blocked` when this runner can't share at all
    (the app then shows no switch); `runners.shareLogins { runnerId, on }`
    sets one and answers once the first send has landed or failed. A
    thread's key can't call `runners.shareLogins` (rpc-gate.ts): it's
    Mike's to switch.
- **Which login.** Of the pool's logins of a provider that are OK to run
  on, the one whose weekly window resets soonest, since whatever is left
  in it then is lost; the most room breaks a tie. Logins with no weekly
  reset known (or one already past) come after those with one, and a
  login with room unknown after those with room known.
- **OK to run on.** A login is OK when it isn't blocked or signed out and
  its room (the tighter of the 5-hour and weekly windows) is at least 1%,
  or its usage isn't known.
- **Before a turn** (a send, a queued message, a schedule): if the thread's
  login isn't OK, or isn't in its pool any more, it moves first. A thread
  stays on one login as long as it can, since every move costs a cold
  prompt cache.
- **Where it moves.** A thread whose request chose a specific model moves
  automatically only to logins of the same provider that list that model.
  This applies before a turn, after a limit or sign-out, and while waiting
  for room. A native choice made before its list arrived matches picker
  ids first, then resolved ids. A thread using the default model takes
  the pool's pick of its provider (Which login), leaving out the one
  it's on. If none has room,
  it uses the first other provider in pool order with a login with room:
  a cross-provider move, a handoff like any
  provider change, onto that provider's default model
  (`defaults.models[provider]`, else the account's own) and effort. A
  thread that spilled over stays there; it doesn't move back by itself. If
  nothing in the pool has room before a turn, the turn starts where it is.
- **A turn that hits the limit.** A pool thread's turn that ends `failed`
  with `errorKind: "usageLimit"` marks its login blocked (until the window
  at its limit resets, or 30 minutes if no reset is known), moves, and
  sends a runner-origin message: "Your last login hit its usage limit
  partway through that turn, so this thread has moved to another one.
  Carry on from where you left off." If that carry-on turn hits the limit
  too, it moves on again while another login has room (since 12 Nov 2026;
  it used to wait after one move). It can't loop: each login that runs dry
  stays blocked until its window resets.
- **Signed out** (since 16 Nov 2026). From Claude Code 2.1.325 a Claude
  sign-in ends 28 days after it was made, and the CLI can't renew it: every
  turn fails with `errorKind: "auth"` until someone signs in again through
  claude.ai's captcha. The runner asks each Claude login's CLI
  `claude auth status --json` (in that login's environment, never the
  Keychain) at start, every 10 minutes and after a refused turn. A login is
  `signedOut` when the CLI says `loggedIn: false`, when its
  `loginExpiresAt` has passed (the CLI goes on saying `loggedIn` for a few
  hours after, on an access token it can't renew), or for an hour after a
  turn on it was refused, unless a new sign-in (another `loginExpiresAt`)
  or a working turn is seen first. The hour is so a one-off refusal
  doesn't keep a good login out until its end date. A turn refused with "Your organization has disabled Claude subscription access for Claude Code" or "Claude Code can't use your Claude subscription, usually because a payment is past due" (org access or billing: nothing in the profile or `auth status` shows it) holds a day instead. Refusals still held are kept in the data dir's `sign-in-refusals.json` across restarts, and the dev runner's login (`runner/src/test-login.ts`) skips them. `loginEndsAt` is that `loginExpiresAt`. Pools and
  new threads skip a signed-out login whatever its room. A pool thread
  whose turn on a Claude login is refused moves like one at its limit
  (only Claude: a Codex refusal isn't remembered, so moving on it could
  bounce a thread between two refused logins), with the
  runner-origin message "Your last login was signed out, so this thread
  has moved to another one. Carry on from where you left off." and the
  note "Moved to <login>: <login> is signed out."; with nowhere to go, or
  pinned, it stays put with the app's sign-in line, which names the login.
  A signed-out login brings no wait: nothing says when it's back.
  A schedule's new thread pinned to a signed-out Claude login starts on a
  pool holding that login instead (the folder's pool first), on another
  Claude login there that's OK, with the same note marked `login`. A
  login alone in its pools has nowhere to go: its run makes its thread as
  usual, and while that thread is still out, failed, on the same login,
  later runs skip with the note "<login> is signed out. The last run's
  thread says so and offers the sign-in." A pinned thread Mike starts
  himself never stands in.
- **Waiting.** When nothing in the pool has room the thread gets
  `waitingForRoom: { until, accountId? }`: the earliest time one of the
  pool's logins is back, plus a minute (30 minutes from now if no reset
  time is known). At `until` it looks again: if a login has room it moves
  there if need be and carries on by itself; if not, it waits again. It
  also looks again, and stops waiting early, whenever the logins, their
  usage readings or the pools change, and when a thread comes over from
  another runner: `until` is only a guess from what the runner knew then
  (12 Nov 2026: a draining runner that had started before a new login
  joined the pool set a wait though that login had 81% left). Any
  message that starts a turn ends the wait (and goes through the before-a-
  turn check). The wait is kept in `thread.json`, so it survives a restart.
- **A pinned thread at its limit** (since 10 Nov 2026). A thread with no
  pool never moves, but a turn of its that ends `failed` with `errorKind:
  "usageLimit"` waits the same way for its own login: `waitingForRoom: {
  until, accountId }` with its login's id, `until` the reset of the window
  at its limit plus a minute (30 minutes from now if none is known), with a
  `system.note`. At `until` it carries on with the "has room again"
  message if its login has room, and waits again if not. Its login isn't
  marked blocked by this.
- **Usage resets** (since 16 Nov 2026). Codex hands out free "Full reset"
  credits (two at a time on Mike's Pro Lite, each expiring a month after
  it's granted) that restore a login's 5-hour and weekly limits at once.
  Each Codex read of a login's limits (`account/rateLimits/read`, at every
  app-server start) brings the count, which goes into `usage.resets`.
  Threadbear never spends one by itself, as Codex's own setting for its
  assistant promises for its resets: when a thread's limit box is up (a
  pool that's all out, or a pinned login at its limit) and a Codex login it
  would carry on with has resets left, the box offers Use a reset, and
  `accounts.useReset` spends the one that expires soonest
  (`account/rateLimitResetCredit/consume`, one idempotency key per click),
  then reads the login's limits again. That reading lifts the block like
  any other, so a thread waiting for room carries on by itself.
  A subscription is one limit wherever it's signed in, so the count travels
  with the shared readings (backend API 104): each runner keeps the newest
  read of a login's resets by its `readAt`, its own or another runner's, so
  a reset used on one machine shows as one fewer on every machine.
- **Telling Mike about resets** (since 26 Nov 2026). On 26 Nov Mike's gmail
  Codex login sat at 0% on every machine for days with 2 resets unused,
  and only the limit box of a stopped thread would have said so. So the
  runner works out `resetHint` on each login (`runner/src/reset-hint.ts`,
  the one place the rule lives) and every client draws it where Mike looks
  anyway: the Usage panel's row, the Usage button's dot and tooltip, the
  login's line in the composer's login lists, and `tb accounts`. The Mac
  offers Use a reset for Codex and Open Claude Usage for Claude. The
  latter opens Claude's Usage settings in the browser, where the user
  checks the login and confirms Reset for free. `accounts.useReset`
  is for Codex. A login gets a hint when it has a reset left (one that hasn't
  expired) and isn't signed out or plan ended, and either it's out of room
  (`why: "out"`: blocked, or under 1% in its 5-hour or weekly window) or the
  soonest reset expires within 3 days while its week is under 70% left
  (`why: "expiring"`: a reset used then still buys back at least 30% of a
  week, and unused it's lost). Room unknown is neither. No notification and
  no thread: Mike finds them annoying, and the hint stays until he uses the
  reset, the login's room comes back, or the reset expires. Threadbear
  still never spends one by itself. The hint changes on its own at the
  moment a reset comes within 3 days of expiring and when it expires, so the
  usage store wakes then and clients get `accounts.updated`.
- **Rechecking a login that's out** (since 17 Nov 2026). Readings only
  come from turns, and pools skip a login that reads as out, so a login
  reset outside Threadbear (a reset used in Codex) read 0% until its old
  reset time. Every 10 minutes (the first a minute after start) the runner
  reads each login whose reading says blocked or under 1% again, if that
  reading is 10 minutes old or more and its provider can read without a
  turn (Codex: `account/rateLimits/read` in a short-lived app-server;
  Grok: `_x.ai/billing` in a short-lived `grok agent`, since 24 Nov 2026;
  `runner/src/limit-recheck.ts`). Gemini is read this way all the time, not
  only when it's out (ACP agents, "Gemini's plan usage"). The answer goes into the usage store
  like a turn's, so room lifts the block and threads waiting for room
  carry on by themselves. A recheck that finds room in every window it
  names (but Gemini's other groups, which never decide: "Gemini's plan
  usage") also ends the block a turn that ran dry put on the login, and a
  pool thread waiting on that same login carries on there before the reset
  its wait named (a top-up, or a reset used outside Threadbear). A turn's
  own reading never does: one from another session can say the login has
  room while the model that ran out still has none. A turn's reading is
  recorded under the login its CLI runs on, even if the thread was moved
  meanwhile. While a login is held out after a turn ran it dry, the store
  keeps it blocked whatever a turn's reading says, and it's rechecked every
  10 minutes from the last recheck, however fresh the turns' readings are.
  A login counts as back only with more room than it read as when it ran
  dry (so a 402 while Grok still reads room doesn't send threads back to be
  refused), or when Grok says a prepaid or on-demand balance is carrying it.
  Signed-out and plan-ended logins aren't read. A login with no reading at
  all is read once, so a Grok login shows its room before its first turn.
- **Grok's readings** (`runner/src/adapters/acp/grok-billing.ts`). Grok's
  `_x.ai/billing` gives the share of the plan's period used
  (`creditUsagePercent`) and the period (`USAGE_PERIOD_TYPE_WEEKLY`, its
  end): one `weekly` window (`monthly`, `daily` or `other` for other
  periods), `blocked` when it's used up and no prepaid balance or on-demand
  room is left, and the tier as `plan`. A Grok thread reads it on its own
  process after a turn that ran out of usage, and at
  most every 5 minutes after completed turns, just after the turn's result
  (recorded under the login the CLI ran on). A Grok turn that fails with
  HTTP 402 or Grok's words for running out ("usage balance exhausted", "out
  of credits", "spending limit", "usage limit reached") ends `failed` with
  `errorKind: "usageLimit"`, and its `error` names the login and Grok's
  own reason, read from the JSON-RPC error's `data.message` (or Grok's
  `retry_state` and `turn_completed` notes) rather than its bare "Internal
  error" (`runner/src/adapters/acp/connection.ts`, `AcpRpcError`).
- **Carrying on by itself is Mike's to turn off**, per thread:
  `threads.update { carryOnAtReset: false }` ends any wait for room (with
  a note) and stops later limits starting one; pool moves to a login with
  room still happen. The summary has `carryOnAtReset: false` while it's
  off. `true` turns it back on and, if the thread's last turn stopped at
  the limit and nothing has started since, starts the wait then.
- **A turn that lost the network.** Not only pool threads: any turn
  that ends `failed` with `errorKind: "network"` (the CLI couldn't reach
  the API at all, after its own retries: DNS, no route, a dropped or
  refused connection) waits, with a `system.note` ("Lost the connection
  to the API partway through that turn. This thread carries on by itself
  once it's back."). The runner probes the provider's API host (a TCP
  connection to api.anthropic.com or chatgpt.com on 443, or a CONNECT
  through `HTTPS_PROXY`, over TLS with its certificate checked when that's
  an `https://` URL; each probe gets 5 seconds in all and reads at most
  1 KB of the proxy's answer) 5, 10, 20, 40 seconds apart and then every
  minute, and once it answers sends a runner-origin message: "The
  connection to the API dropped partway through that turn and is back
  now. Carry on from where you left off." A carry-on that can't get
  through either waits again, with no new note; after five carry-ons, or
  six hours from the first failure, it stops with a note saying to send
  a message. A message already queued goes instead of a carry-on, and
  any turn ends the wait. The thread's summary has
  `waitingForNetwork: { since }` while it waits, kept in `thread.json`
  so it survives a restart. Other failures never
  retry by themselves.
- **Moves in the transcript.** Each move and wait is a `system.note`:
  "Moved to mike@example.org: mike@example.net hit its 5-hour limit,
  back at 6:10 pm." or "Every login in Claude is out of room. Carrying on
  at 5:00 am when mike@studio.example is back."
- **Claude to Claude.** A move between two Claude logins copies the
  session's transcript from the old login's `projects/` folder to the new
  one's and resumes it there, so nothing is lost (a real e2e checks the
  CLI resumes another login's transcript). If the copy or the resume
  fails, the new session starts with a short handoff note instead.
- **Pinning.** A thread with no `poolId` is pinned to its `accountId` and
  never moves. Threads from before pools stay pinned. A pool's logins
  include noted ones only when it lists them, so a "Convex work only"
  login only runs threads in a pool that names it.
