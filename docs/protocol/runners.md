# Runner protocol: Other runners' threads and sharing

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

## Other runners' threads

Step 6 part 2 (docs/archive/step6-plan.md). The Mac app lists every runner's
threads: this runner's from this runner as always, the others' from the
backend. It opens them through its own runner and the backend ("Other
runners' threads through the backend", below). Runners never talk to each
other, and the app never connects to another Mac.

- **The sidebar table.** With a backend of API 12, each runner keeps one
  `threadIndex` row per thread there: `threadId, title, cwd, accountId,
  provider, model?, status, needsYou, unread, preview, createdAt,
  lastActivityAt, snoozedUntil?, archivedAt?, startedBy?, asked?, keywords?,
  permissionMode?, coordinatorProjectId?`
  (`coordinatorProjectId` from API 102, an optional nonempty project id for
  the Coordinators section above Starred; ignored when malformed and archived
  still wins. It remains on the relay summary when that thread opens.)
  (`startedBy` from API 23, without its `threadId`; `asked` from API 32; `keywords` from API 74;
  `permissionMode` from API 88, which the backend cuts to 16 bytes for a
  runner key). Another Mac's composer shows a thread's `permissionMode` as
  it is, read-only (a mode can't be changed through the backend), and
  "Access unknown" for a row without one, never Full access. The relay's
  summary of an open thread always has `permissionMode`: the row's, or
  `"unknown"`. It writes a row when any
  of those but `preview` and `lastActivityAt` changes (those two go along
  but never cause a write), and on its first write after starting it
  drops rows for threads it no longer has. A deleted thread's row goes.
  Archived threads have rows too, so the app's Archived list has other
  machines' archived threads to open and unarchive. A runner key's rows
  are capped (`CAP.indexRows`), and past the cap its oldest archived row
  gives way before a live one; a backend before API 54 dropped a runner
  key's archived rows, and a runner sends those again once on first
  hearing 54 (its sync cache's `index.archived` says it has).
- **Thread ids.** A thread id is 1 to 64 letters, digits, `-` and `_` (a
  runner makes UUIDs). The backend lets a runner key make a thread or a
  sidebar row only under an id of that shape (`isThreadId`), and the
  runner's `remoteThreads.list` and `remoteThreads.updated`, both Mac apps'
  sidebars and a move leave out any other, as the apps put ids into a
  shell line (Copy debug info) and a reply's thread chips. The main key's
  own ids aren't checked by the backend.
- **Watching the others.** The runner subscribes to
  `sync:otherRunnersThreads` (every runner but itself, with its threads)
  and gives the result to clients as `remoteThreads.list` and
  `remoteThreads.updated`. It watches only while a Mac app is connected
  (`hello`'s client `threadbear-mac`), and for two minutes after the last
  one goes, since every re-run reads all the other runners' rows; a
  `remoteThreads.list` starts the watch at once, and the answer follows as
  `remoteThreads.updated`. Until then the list is what was last heard.
  With a backend of API 29 it watches two smaller things instead:
  `sync:otherRunnersList` (the runners, which heartbeats re-run) and
  `sync:threadIndexSince` with, per runner, the newest `updatedMs` it has
  heard (absent at first, for all of that runner's rows). Each answer moves
  that on and it subscribes again, so a re-run reads only rows written since,
  tombstones (`deleted`, kept a day) included. Watching again after a stop
  starts from all rows. The app sees the same `RemoteThreads` either way:

```ts
type RemoteThreads = {
  runners: RemoteRunner[], threads: RemoteThread[]
  ready?: boolean      // false until this watch has its backend answer;
                       // keep known rows and defer totals while false.
                       // Absent on an older runner (treat as ready).
  order?: string[]     // Mike's runner order (backend API 58, sync:runnerOrder,
                       // owner key only): every runner's id, this one's too.
                       // Left out until heard, and by an older runner
}
type RemoteRunner = {
  id: string, name: string, icon?: string  // as RunnerInfo
  online: boolean      // heard from in the last 3 minutes, or a box that
                       // a message reaches (box, below)
  lastSeenAt: string
  followProblem?: string
  box?: { state: string, waiting?: true, unreachable?: true, unsure?: true,
          service?: string, token?: "none" | "dead", login?: string } // one thread's box on a virtual
                       // runner (Virtual runners), as its machine has it:
                       // creating, starting, awake, saving, asleep, waking,
                       // retiring, failed, destroying, gone (archived, its save kept)
                       // or expired (it can't come back). Online in all but
                       // destroying and expired, as a message starts or
                       // wakes it. `waiting`: a message wants it woken but
                       // its virtual runner has maxBoxes up, so it waits
                       // (with the message) for one to sleep.
                       // `unreachable`: it hasn't heartbeated for 5
                       // minutes, but its provider still has it (show it
                       // as not answering, not as gone). `unsure`: the
                       // provider made more than one machine for it and
                       // which holds its work isn't known yet; each message
                       // tries the next (Box keys). An older runner
                       // leaves them out. From API 94: `service`, its
                       // virtual runner's id (`services` below), and
                       // `needsToken` and `waitingForRoom` (with `waiting`)
                       // among the states. `token` says its
                       // login (`login`, an email) has no cloud token
                       // ("none") or a refused one ("dead"): the thread
                       // shows the token card until one is set.
                       // A box's runner is never a machine to pick:
                       // Runs on, Move to and Settings leave it out.
}
// From API 94 with the virtualRunners experiment on, and only on the
// owner key's runner: the virtual runners (`boxes:runnerServices`), for
// Runs on's entries after the machines. Left out otherwise. Switching the
// experiment, or the backend reaching 94, takes effect in the watch at once:
// they come (or go, with a remoteThreads.updated without them) then.
type VirtualRunner = { id: string, name: string, provider: string }
// RemoteThreads gains `services?: VirtualRunner[]`.
// rpcUrl and tokenFile were the direct link between Macs (step 6 part 2),
// taken out 13 Nov 2026. An app ignores them if an older runner sends them.
type RemoteThread = { runnerId: string, threadId: string, title, cwd,
  accountId, poolId?: string, provider, model?, status: ThreadStatus, needsYou: boolean,
  unread: boolean, preview, createdAt, lastActivityAt, snoozedUntil?,
  archivedAt?, coordinatorProjectId?: string }
```

- **The direct link** (13 Nov 2026, gone). Until then the app could
  also dial another Mac's runner over Tailscale, at the `sync.rpcUrl` it
  sent in its heartbeat, with that runner's token copied in by hand
  (`tb pair`, `secrets/runners/<id>.token` and `.host`). The runner no
  longer sends `rpcUrl` or reads those files, and `tb pair` is gone. A
  backend still takes `rpcUrl` in a heartbeat from an older runner, and
  the runner drops it from what it hands the app.

## Other runners' threads through the backend

Full Convex step 5 (5 Nov 2026, backend API 44). The Mac app opens and
drives another runner's thread without connecting to that runner: it asks
its own runner, with the normal methods and the thread's id, and this
runner answers from the backend and sends what the app does to the other
runner as a `commands` row, as the phone does. The app has no Convex of its
own and no link to the other Mac; nothing reaches another runner but its
commands. Only the owner key can do this (`convex/relay.ts`, all owner
only in Runner keys), so it's the main Mac's runner that answers; a runner
on a runner key answers `-32000` for another runner's thread. This is the
only way the app opens another runner's thread.

- **Which threads.** A `THREAD_METHODS` request whose `threadId` isn't this
  runner's (nor a draining runner's) but is in its `remoteThreads` list.
  `threads.create` with a `runnerId` that's another runner's, and
  `files.list` with a `runnerId`, go there too, and so does `files.read`
  with a `runnerId` (pictures in its messages, below).
- **Reading.** `threads.events` and `threads.subscribe` answer from the
  thread's `messages` rows (Sync, Messages) and its `threads` row. The rows'
  seqs are the other runner's, with gaps where events weren't mirrored, and
  events are made up beside them, so each row's seq `s` becomes eight
  **relay seqs**: `8s` a `turn.started` (the first row of a turn), `8s+1`
  the row's own event (`user.message`, `assistant.text`, or a `tool.call`
  with the line as its title and no input), `8s+2` a tool's `tool.result`
  once anything follows it or its turn has ended, and `8s+7`
  `turn.completed` at the last row of a turn that has ended (the next row
  is another turn's, or the thread's row has said for 4 seconds that it
  isn't running, since that runner writes its rows a moment before their
  messages), with the row's `needs`, `asks` and `next` on the newest (each
  ask keeping its `ticked: true`, as there's no seq after a turn's end for
  an `asks.ticked`; the app's card starts with those ticked). An
  open approval, question or secret on the row is placed at `8p+1`, `p`
  being its event's seq (`pendingApproval.seq`, API 44; from an older
  runner, with none, at `8m+3` after the newest row `m` held when it was
  first seen), and its `approval.resolved` one after it once the row no
  longer has it (with the decision if it was answered from this Mac). A
  `threads.subscribe` takes optional `relaySeen: [first, last][]`, sorted,
  disjoint inclusive ranges of the persisted relay seqs this subscriber
  already has (at most 20,000 ranges, all at or below `afterSeq`). It sends
  what's past `afterSeq` and missing events (including late results,
  answers and turn ends) from the first range onward. An empty list means it has no events.
  This keeps another subscriber's older pages out of its reply. Older
  clients omit it and still get late events replayed from everything given
  before (turn starts too); a seq the app already has does nothing. A gap
  holds back turn markers inside its uncertain interval while messages
  stay readable; the markers arrive late when those rows are known. A
  subscribed watch retries a failed gap read on its regular sweep, even
  when the remote thread is idle and its tail never changes. Every page and
  event is in relay seqs, and so are `afterSeq` and `beforeSeq`. A page also
  has `relay: { runnerId, runnerName, atStart? }`; `atStart` says there's
  nothing older. Events can arrive with gaps and late (a tool's result
  when the next row comes, an approval's answer after later rows), so the
  app takes them as they come rather than asking for a catch-up (its
  ThreadFeed's sparse mode). No deltas: a remote thread shows finished
  messages and the working line, not live typing.
- **What's held back.** A tool's result says `The output is kept on <runner>.`
  and carries `heldBack: { seq }`, the row's own seq. Opening that tool in the app
  calls `threads.heldBody { threadId, seq }` → `{ state: "text" | "withheld" | "expired" | null }`:
  once for each tool while the thread's held, through `sync:remoteBody`. With a body
  (that runner has `sync.full` on, see Sync), its real `tool.call` goes out at 8s+5,
  its `tool.result` at 8s+6, and up to two `edit.diff`s at 8s+3 and 8s+4, unless an
  old runner's card has those; any more files are named in the result. The app fills
  the row in by `itemId`. Withheld, the result says why. Otherwise the stub stands.
  Reasoning, sub-agents and tools' pictures stay on that runner from here.
- **Wake reasons in messages** (backend API 98). A runner's own message
  row (`origin: "runner"`) from a `user.message` with `wakeReason` carries
  it, scrubbed as the text is and cut to 200 characters, and `remoteTail`
  and `remoteMessages` pass it on, so the relay's event has it and another
  Mac's divider before the turn it started says it ("Moments later · Codex
  answered") rather than the bare wait. The relay puts that message before
  its turn's `turn.started`, as its own runner wrote them. A runner sends
  it only to a backend of 98 or later.
- **Answers in messages** (backend API 89). A user's message row from a
  `user.message` with `answers` carries them (`[{ action, answer }]`, scrubbed
  as the text is), and `remoteTail` and `remoteMessages` pass them on, so the
  relay's event has them and another Mac's bubble shows the asks as answers.
  A runner sends them only to a backend of 89 or later.
- **Pictures in messages** (backend API 87). From API 87 a user's message
  row carries `pictures`, how many pictures the message came with (the owning
  runner's `toMessageDoc`; `remoteTail` and `remoteMessages` pass on a whole
  number from 1 to 999). Its pictures come from that runner's uploads
  (`replyImages` rows with `src` `picture:N`, which it writes unless its
  `sync.pastedPictures` is false), read by `relay:picturesAtSeqs { key,
  threadId, seqs }` → `[{ seq, n, path, url, mediaType, width?, height? }]`
  (at most 50 seqs a read and 30 pictures a seq, owner only). With `pictures`,
  `images` has exactly that many (at most 50): `images[N-1]` is picture N,
  `{ path, mediaType, width?, height? }`, `path` being the file's path on that
  runner's Mac, or `threadbear-relay:<threadId>/<seq>/Picture <N>` for one not
  up yet; and the `[N pictures]` line the owning runner added is taken off
  `text` (only `[1 picture]`, or `[N pictures]` for N of 2 or more, and only
  when its number is how many of them no marker places, so a typed one stays). So `text` and the count of `images` are the sender's, which is
  how the app knows its own sent message, and words that only look like a
  marker or the line never make a picture. A row without `pictures` (an older
  runner's) is read only if its words say it came with some (`[Picture N]`
  markers or the line), never one with `origin` `runner` or `schedule`; it gets
  only the pictures held (with a place for one missing before the last held),
  and its line goes only once every picture its words count is held. No
  message is held back for its pictures: the event goes out in order with a
  place for each one not up. A new one's (a row that arrived within 20 seconds
  of being sent, or a live tail brought with a time within 5 minutes of now,
  counted from then) are watched through the same query for 20 seconds. A row
  whose pictures aren't all up (an older runner's too, by its words' count)
  is asked about again by the thread's later reads, at most once a minute,
  for 10 minutes after its first read. A backend older
  than 87 is never asked, and messages show as their words. A read that fails
  is tried again for that thread 30 seconds later. `files.read { path,
  runnerId, maxBytes? }` answers `{ path, size, modifiedAt, mediaType, data,
  truncated }` (as `files.read`) for a path held this way for a thread the
  sidebar lists on that runner, with the bytes from the backend's file storage
  (25 MB at most, held in memory, never written to disk). A place for one not
  up waits for its message's first lookup if that's still out, then while
  it's watched, then is asked of the backend again, and is
  `-32000` saying it didn't reach Convex if it still isn't there (asking again
  later can find it). The same path held for two threads answers from the one
  used last. A path in this runner's own inbox (a picture the app has just
  sent to that runner, drawn in the bubble it keeps until the message shows)
  answers with that file. Any other path is `-32000`, `Files on another runner
  are kept there for now.` Pictures in replies and pinned ones stay as they
  were: only the phone and the website show them.
- **Reads.** A thread is watched only while a client is subscribed to it,
  through `relay:remoteTail` (its newest 15 rows) and `relay:remoteThread`
  (its one row); a minute after the last subscriber goes, both stop. Older
  rows are read once by page (`relay:remoteMessages`, 50 at a time) and kept
  in this runner for half an hour. A tail that starts past the newest row
  held (the Mac slept) reads the rows between once, by `afterSeq`, rather
  than leave a hole. Pictures are read by row seq, only for held messages
  that have some, 50 messages a read; a new message's are watched live for
  20 seconds. `runner.status` has `relay: { watching, held, reads, bytes }`:
  threads watched now, rows held, and since start the reads (and live
  updates) and the JSON bytes they brought back, to measure what it costs.
- **Acting.** `threads.update` takes `archivedBy: "agent"` with an
  archive (an agent's `update_thread`): the command carries `by: "agent"`,
  which `relay:queueCommand` keeps only on an archive, and that runner
  records the archive as an agent's. From an older backend it's dropped and
  the archive reads as Mike's, as before.
- `threads.send` (text, `answers` and pictures, below;
  the answer has `queued: true` when that runner hasn't taken it in the 20
  seconds),
  `threads.interrupt`, `approvals.respond`, `secrets.answer` (sealed to the
  other runner's key from its row, as the phone seals it, so the value
  never reaches the backend in the clear), `threads.markSeen` (only when
  the row is unread), `threads.update` (`title`, `archived` with its `verdict`, `starred`,
  `snoozedUntil`; or, on their own, `accountId` and `model` from backend
  API 77 with `carryOn` beside `accountId`, and `effort` (an `EffortLevel`
  or `null`) from backend API 112, which go as one `update` command that
  runner applies through its own `threads.update`, with `byAgent` when
  `by: "agent"` (an agent's change, which starts no turn), and finishes
  with the login, model and effort it applied as the command's `result`,
  which the answer's `{ thread }` and a `thread.updated` show; only the
  main Mac's commands, `from: "mac"`, can carry them; an older backend's
  runner says it works once the backend is updated; a folder, pool or mode
  change is `-32000`; a watched thread's `effort`, `effortInUse` and
  `modelInUse` come from its `threads` row, API 107+, and are carried on
  `thread.updated`, `remoteThreads.list` and `remoteThreads.updated`), `threads.hibernateWhen` (an
  `update` with `snooze: { said }`; that runner puts the thread away at once
  and the command is done once its model has said when, so the answer is
  `{ thread }` from the row, without `until`, `topic` or `why`, or the
  reason as `-32000`; it carries `untilRestart: true` too, so a runner from
  before 8 Nov 2026, which doesn't read the words, hibernates the thread
  until it next starts rather than waking it) and `threads.share` each queue
  one command with `relay:queueCommand`, which sends a thread's command to
  the runner whose row the thread is, whatever runner it was asked for, and
  `sync:takeCommand` fails a thread's command (any one's, the phone's too)
  whose thread is another runner's by the time it's taken.
  The runner watches it with `relay:commandState` (a get by id) until it's
  taken (sends, interrupts) or done (the rest), at most 20 seconds, and
  answers with the command's `note` as a `-32000` if it failed.
  `threads.update` and `threads.markSeen` answer `{ thread }` as any runner
  does: the thread's row, with each change made from here on it until the
  row shows it or for a minute at most (without them a markSeen answered
  after an archive would bring the thread back), seqs as the app makes them
  for a row. `remoteThreads.list` and `remoteThreads.updated` carry those
  same changes, so a list sent for another thread's change before this
  row caught up doesn't bring an archived thread back. `threads.share`
  answers `{ thread }` with its `share` read from that runner's row
  (`relay:remoteThread`), which the runner writes as soon as a `share`
  command is done; a new link is one whose slug isn't the old one. The row
  is read up to five times a second apart, and a share (or an off) that
  hasn't reached it by then is `-32000`. A runner writes its threads rows
  one writer at a time (a flush's batches, taken before a change, or another
  immediate write would otherwise land the old share over it). The table has
  no `share`, so the app keeps a remote thread's last known one through its
  rows, and the relay sends `thread.updated` (that summary, with `share`)
  when a watched thread's row's share changes there, and on each
  `threads.subscribe` if it's shared. The app ignores those with the direct
  link on. A runner the
  list says is offline is `-32000` at once. Commands from here carry `from:
  "mac"`, so the other runner gives the message no `origin`.
- **New threads there.** (A request from a runner key, "Asking another
  runner", files Plan first as `ask`: its row has no room for the flag.)
  `threads.create` with `runnerId` is a `create`
  command (text, `cwd`, `accountId`, `model`, `effort`, `permissionMode`
  and pictures, below; with pictures the text can be empty). Every mode goes, as a missing one is that runner's
  `defaults.permissionMode` (full access unless its `runner.json` says): Plan first as `permissionMode: "ask", plan: true`, which a runner or
  backend from before Plan first reads as Ask. A mode one of them doesn't
  know is refused, here, in the backend and by that runner, never dropped
  (Daybreak, 7 Nov 2026). It's answered with a summary of the new thread once
  that runner has made it, which this runner then answers for until the
  sidebar list has it. `remoteThreads.logins { runnerId }` gives that runner's
  logins for the pickers, from the backend's `accounts` rows (no pools;
  `defaults.cwd` is the folder of its newest thread). Since API 101 it also
  gives `usagePools?: Pool[]`, that runner's effective pools from its
  latest heartbeat, for Usage. `pools` stays empty because remote creation uses a login.
Since backend API 101, sidebar rows carry `poolId` when the owning runner
uses a pool for the thread. The desktop Usage pot follows that pool on the
owning runner; absent on older rows, it follows `accountId`. Runners leave
this field out when writing to a backend older than 101.
The API 101 heartbeat also carries `usagePools?: { id, title, accountIds }[]`,
from the owning runner's effective pools, including its local defaults.
`relay:remotePools` reads only that runner's snapshot for the owner key;
absent before its first API 101 heartbeat. It does not infer membership from
another runner's accounts or shared pools.

- **Pictures** (backend API 63, 8 Nov 2026). A `threads.send` or
  `threads.create` for another runner can carry `images`, as for this one:
  the `ImageRef`s `media.import` made, in this runner's `inbox/`. A picture
  anywhere else is `-32602` (a client can't have any other file here sent to
  Convex by naming it), and so are more than 6 or one that isn't an image.
  This runner uploads each to `/relay/upload` with a one-use ticket from
  `relay:pictureUploadUrl` (at most 10 MB; the backend records it in
  `relayUploads`) and queues the command with `images: [storageId, ...]` in
  order; `relay:queueCommand` takes only those uploads, and only ones nothing
  else names (a picture row, another command's), and stores
  `images: [{ storageId, url }]`, the shape a phone's photos have, with
  `commandFiles` rows. So the other runner fetches them as it does the
  phone's (Sync, the `send` and `create` commands), even one from before
  this, and `sync:finishCommand` deletes them once it's done, whether it went
  or failed. If the command couldn't be queued, this runner calls
  `relay:discardPictures` with the ids, which deletes only those uploads that
  nothing names; whatever's left (a lost reply, a runner that quit between
  the two) goes after a day with its `relayUploads` row (`sync:pruneFiles`).
  That runner marks a send taken before it fetches the pictures, so a send
  with pictures waits past taken for done and fails if the fetch does. It
  answers within 100 seconds of being asked, as the app gives up on a send
  at 120 and then puts the draft back while it may still go: no upload
  starts after the first minute and they must all be up by 75 seconds, or
  nothing is queued (the error says so), every wait after that ends by 100
  seconds, and taken and still not done then counts as sent. A new thread
  with pictures waits for done in the same 100 seconds. So a fetch there
  that fails after 100 seconds (six pictures each taking over 7 seconds to
  download) still looks sent here. A backend before 61 would drop them and send the words
  alone, so this runner says the backend needs updating instead (it updates
  with the runner), and an offline runner is said before anything uploads.
- **Reply buttons and slash commands** (backend API 68, 9 Nov 2026).
  `buttons.list` answers from the thread's rows' `buttons` (Sync, "Reply
  buttons"), newest state of each, oldest first, as a `ReplyButton` with
  `start: { text: "", cwd: target }` or `send: { threadId: "", threadTitle:
  target, text: "" }`: the brief and the message stay on that runner.
  `buttons.press` queues a `press` command `{ buttonId }` and waits for it to
  be done (30 seconds), answering `{ button }` with `pressed.threadId` the
  command's `resultThreadId`; a press that failed there is `-32000` with its
  note. `threads.commands` queues `slashCommands` and answers `{ commands }`
  from the command's `result`. Both commands are what the phone sends, so a
  runner from before this does them; a backend before 68 refuses them, so
  this runner says it needs updating instead.
- **Answers from another runner.** `files.list` with `runnerId` and `path`
  is a `call` command, `{ method: "files.list", params: { path } }`, which
  that runner answers in the command's `result` (at most 500 entries; JSON
  text, at most 256 KB, kept only for a `call`). Only
  methods on the allow-list (`convex/relay.ts` `CALLS`, checked again by
  the runner) can be called, and none that answers with file contents or
  tool output.
- **Everything else** about another runner's thread (editing a message,
  highlights, patches and panels, reviews, explain, hibernate-when, a
  sub-agent, ticking an ask, changing its login or model) is `-32000`
  saying to do it on that Mac.

## Asking another runner

Added 6 Nov 2026. An agent's `create_thread` takes `runner` (a name, an id,
or `main` for the main Mac) to start the thread on another of Mike's
machines, with `folder` a path there (`runner/src/cross-runner.ts`). A
runner that's this one is the usual create.

- **On the main Mac** (the owner key) it's started straight away, as the
  app's `threads.create` with a `runnerId` is (Other runners' threads
  through the backend, "New threads there").
- **On a runner key** (the cloud, Bruce) the runner may not queue work for
  another runner (Runner keys), so it asks. It files the whole request with
  `relay:fileRequest` (text, title, folder, model, effort, permission mode,
  why; the backend keeps it in `runnerRequests` under the card's id, from
  a thread of its own whose id is only letters, digits, `-` and `_`, and
  nothing can change it after), then shows an `approval.requested` in the
  asking thread named `threadbear.start_thread`, with the request as its
  `input`, and waits up to an hour, like `ask_secret`. A message from Mike
  in that thread declines an unanswered card. Its thread row's card has no `options` and
  says to answer it on the Mac: the phone can't start it.
- **The main Mac's app** draws that card from the request as filed
  (`requests.get` on its own runner), never from the card's words: who's
  asking, the machine and folder it would start in, its permissions and
  model, and the whole brief, with Start it and Don't. Return in an empty
  composer, which allows other cards, never starts one, and Start it does
  nothing until the request has been read. One naming a machine this Mac
  doesn't know starts on this Mac, and the card says so.
  **The folder.** The asking agent can't see this Mac's disk, so it
  guesses its paths, usually right but for the home folder (it asked for
  `/Users/mike/...` on 8 Nov when this Mac's was `/Users/m5-mike`). For
  one starting on this Mac, a folder that isn't one here but is under
  this Mac's home once its own home is taken off (`~/x`, `/Users/<name>/x`,
  `/home/<name>/x`) starts in that one, as its real path, which must be
  in this Mac's home with symlinks followed. `requests.get` gives that
  folder, so the card shows where it really starts, and its fingerprint
  holds it and its real path (whichever machine the card shows), so a
  folder appearing or a link moving before Start it is "changed since
  the card showed it", never a start somewhere else. The app reads the
  request again after Start it fails, so a second click answers the card
  as it is now. One
  that's still not a folder here is `missingFolder` and the card says so;
  Start it then starts nothing: it declines the card with a message
  naming the folder and this Mac's home, which the asking agent is told
  as the reason, so it can ask again with a folder that's here, then
  marks the request denied and answers `-32602` saying so. A decline that
  can't be sent leaves the request pending, to try again. Start it is
  `requests.answer` with the machine the card showed and the
  `fingerprint` `requests.get` gave (a hash of the whole filed request and
  when it was filed), so a request filed again under the same id with
  other words isn't started on the old card. The runner checks the
  fingerprint and that the asking thread's row still has that card open,
  asks the runner that holds the card to accept Start it while the card
  is still open (`requests.confirmStart` through the relay). The runner
  holding the card decides whether Start it or closing the card came first,
  including during a handover. A synced copy can still show a closed card,
  but it can't accept Start it. A card whose start was accepted can wait for
  its result until the ordinary request timeout. If it closes before the
  result arrives, the asking thread hears what is known about the start.
  The backend gives its confirmation time to reach the claim before it
  closes an unused request.
  The main Mac then claims the request (`relay:decideRequest` to `claimed`,
  owner only, from API 108 with the completed confirmation command,
  naming the row it read by its `docId`, so a retry or second click can't
  start a second, nor a click delayed past a refile claim the new row;
  from backend API 85 with a `claim` id of its own, so when the claim went
  through but its answer was lost, the next Start it asks again with the
  same id and carries on, where before the request stayed "being started"
  with nothing started; the id is forgotten as soon as the claim's answer
  arrives, so nothing can be started twice under it),
  starts the thread from the
  filed request (here, or as a `create` command for another runner), with
  a first line of its own saying which thread on which runner asked and
  that Mike allowed it (the id and name cut to characters that can't end
  that line), marks it `allowed` with where it started, then answers the
  card with `allow` through the relay. A start turned down here before
  anything was made (a folder that isn't one) hands the claim back
  (`pending`) and puts the card back to waiting for an answer, as does a
  relay refusal before anything was queued for the other runner (offline,
  sync off). Any other failure keeps the claim, as the thread may still have
  been made (another runner answering late, a handover passing it on), and
  the card says so. A machine the runner list says is offline is said
  before anything is claimed.
- **The asking runner believes only the backend.** An `allow` for this
  card reads `relay:runnerRequest`: allowed with a result, the tool says
  where the thread started; denied, the user said no; still pending (an
  old phone's Allow, or anyone's), the answer is refused and the card
  stays open. `deny` from anywhere declines an unanswered card. A message with it is
  given to the agent as why it wasn't started. A card that closes without
  starting (declined, expired, Mike wrote instead) closes its request
  (`relay:closeRequest`, its own), so it stops counting against the five
  a runner key may have waiting and can't be started late.
- **Reporting back.** The started thread is told the asking thread's id.
  The main Mac's agents can `send_message` to another runner's thread by
  its full id (through the relay); a runner key's agents can't message the
  main Mac's threads. So for a thread the main Mac starts there, its runner
  passes the replies back itself (`runner/src/far-reports.ts`, added 20 Nov
  2026, after a thread on the Pixel couldn't report to the M5 thread that
  started it): the thread's first line is `[Started by thread <id> on
  <name>. Each reply you end a turn with goes back to that thread, so put
  your report in your reply.]`, and the main Mac's runner keeps it in
  `far-reports.json` with its starter (a thread already there keeps its
  first starter) and a ceiling, `by`: the starter's saved mode as it asked
  (read before the request goes), or the mode the thread was started with
  if that's more. Taken on
  this Mac, never from the backend or the other runner. A reply that
  arrives after Mike raised the starter above `by` isn't passed to its
  agent: the starter gets a `system.note` and goes to Needs you, with no
  turn (`runner/src/runner/ceiling.ts`; Daybreak finding 163, 22 Nov 2026).
  A watch saved before that has no `by` and counts as Ask. Every 15 seconds, on a timer of its own, and not while
  sync is off or the runner is draining, it reads each such thread's row
  (`relay:remoteThread`) and newest 100 message rows
  (`relay:remoteMessages`) straight from the backend: the sidebar's list
  is only watched while an app is connected, and the relay knows a thread
  only once that list has it. A thread quiet for half an hour is read
  every five minutes. The turns (rows' `turn`) after the last one passed
  on, in order, each go to the starter, the newest only once it isn't
  running and a second look finds the same reply (the row can say the
  turn ended before its last reply reaches the backend). If one of the
  last 20 turns passed on later shows a different reply (more of it
  arrived, even with the next turn's rows), that goes again, saying so.
  A turn's reply is its last agent words, past the MCP tool calls after
  them (end_turn's, a pin: every threadbear tool's row has `toolKind`
  `mcp`), back to a message sent into the running turn; end_turn's
  summary stands in when there are none, as words before another kind of
  tool call (a command, a read, an edit) are narration. It goes queued, as an agent's
  message: `[Sent by the agent in the thread "<title>" (<id8>)]`, then
  `From <runner>, where this thread started it. Its reply as its turn
  ended, passed on by this Mac's runner (thread <id>):` and the reply. The
  title and runner name lose quotes, brackets and newlines, and the reply
  is cut at 20,000 characters. The record is saved after each send, and
  a look that finds the other runner of a handover passed on more
  meanwhile writes nothing. One moved to the main Mac is let go (its own
  `send_message` reaches the starter); one moved to another runner is
  followed there. A starter that
  isn't on this runner (a handover's other runner has it) waits, and one
  gone a day is taken as deleted; a send that fails is tried at the next
  look. At most 40 go per thread a day, as each wakes the starter. A
  thread gone from the backend, or quiet, for 30 days is forgotten. That
  thread's `send_message` to its starter (8 characters of the id or
  more), which its runner can't find, is refused saying the reply goes
  back by itself.

What a tampered runner can do with this is put a card in front of Mike:
the most it can start is what he read and allowed.

In the backend a request is a state machine (`convex/requestMachine.ts`,
[machines.md](../machines.md)) on its own field, `requestState`;
`relay:decideRequest`'s `state` is that machine's event, and `state`,
`claim`, `result` and `decidedAt` stay on the row as runners read them.

## Sharing

A thread can be shared by link on the website (docs/website.md, "Sharing"),
from the share button beside its ... menu, or from the website itself
or the iPhone and Android apps (a `share` command; see Sync). The runner keeps it on the thread's
record and the mirror carries it to Convex, which serves the link;
nothing about it is decided in Convex.

```ts
type ThreadShare = {
  access: "off" | "link"
  slug: string          // the link is <website>/s/<slug>: 16 random bytes, base64url
  updatedAt: string
}
```

- `"link"`: anyone with the link reads the thread, live as it carries on.
  `"off"` keeps the slug, so sharing again brings the same link back (as
  a doc's sharing does); `newLink` is the way to stop an old link for good.
  (Sharing with specific people, by emailed code, was there on 28 Oct and
  went on 29 Oct; a record that still says `"people"` reads as `"off"`.)
- Readers see the title, the text of each message, one line per tool
  call and the thread's pictures. Never the folder, account, model, cost,
  approvals or a composer, and never tool output.
- Pictures go up only while a thread is shared: a message's attachments,
  what a tool handed back (a screenshot, an image it read or made) and
  pictures the agent wrote into its text as Markdown with a path on the
  Mac (`![alt](/path/to/file.png)`, a `file://` URL or a `~` path).
  When the thread is shared the runner looks through its whole history,
  then sends new ones as they come; each file goes once (`sync:shareImages`
  says what's up), at most 10 MB. Stopping sharing drops them all.
  Anyone but Mike gets them as `<site>/share/image/<slug>/<id>`, which
  answers only while the thread is shared under that link (checked at
  every request, `no-store`), so stopping sharing or Share again with a
  new link stops the old URLs at once, before the runner has dropped the
  files. Mike's own token gets the files' storage URLs. The storage URLs
  pages handed out before (until 15 Nov 2026) were ended once, by copying
  every shared picture to a new file and deleting the old one
  (`shareRekey:rekeyShareImages`, from the first heartbeat after the deploy
  once the 7 Nov limits migration is done; a run that stops goes on from
  where it got to). A reply, icon or held picture on the same file moves
  to the copy with it.
- As the page is public and a path is only what the agent wrote, a file
  goes up only if it's really a PNG, JPEG, GIF or WebP by its bytes (the
  type sent is the one its bytes say, not its name's), isn't itself a
  symlink, and is, by its real path, in the thread's media folder in the
  data dir (`threads/<id>/media`, where attachments and tool pictures are
  copied). Nowhere else: a Markdown path is only text the agent wrote,
  maybe at a repo's or a web page's say, so it can't publish a file from
  the thread's folder, however new (pictures made there since the thread
  started went, and that was still Markdown publishing a local file:
  Daybreak verify-fix, 5 Nov), or from the temp folders, which hold every
  app's screenshots. The file is read through one descriptor opened
  without following a link and checked to be the file at its real path.
  Anything else stays on the Mac with a line in the runner log and shows
  on the page as its alt text. An agent that wants a picture on a shared
  page copies it into the media folder, which every CLI the runner starts
  is told as `THREADBEAR_MEDIA_DIR` (`mkdir -p` it first; it may not be
  there yet), and writes that path in its Markdown.
- The thread's row on the mirror has `share: { access, slug }` (backend
  API 8). An older backend gets the row without it, and gets it once a
  heartbeat says it's new enough.
