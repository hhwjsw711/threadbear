# Runner protocol: Runner keys and virtual runners

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

## Runner keys

Added 5 Nov 2026, after a security review kept finding attacks that start
with "a holder of the shared runner key". Until then every runner on a
deployment carried the same `RUNNER_KEY`, so a second Mac (Bruce) could do
anything the main one could: rewrite any thread's runner and secret card
key, replace another runner's `rpcUrl`, read its pending commands, put a
schedule on it, and mint phone tokens. Now there are two kinds of key, and
`convex/runnerAccess.ts` says what each may do (a unit test,
`runner/test/unit/runner-access.test.ts`, checks every function in
`convex/sync.ts` against it and against the table below).

- **The owner key** is the deployment's `RUNNER_KEY`, held by the main Mac's
  runner only. It may do everything, as every key could before. A
  deployment with one runner has only this key, and nothing changes for it.
  While it's being rotated `RUNNER_KEY_NEXT` is an owner key too, so the
  main runner can move to the new one without a gap: `tb runner
  rotate-owner` on the main Mac sets a new key as `RUNNER_KEY_NEXT` (with
  its deploy key) and writes it into its `secrets/convex-key`; once its
  runner has restarted onto it, `--finish` makes it `RUNNER_KEY` and
  removes `RUNNER_KEY_NEXT`, and every copy of the old key is dead. While
  `RUNNER_KEY_NEXT` is set the owner's heartbeat answers
  `ownerKeyRotating: true`, and `tb status` and `tb runner list` say so.
  The owner's heartbeat also answers `pushFailing: { failure, since,
  failed, via: "apple" | "relay" }` while pushes to phones haven't got
  through (no send has since `since`, the latest failure in the last three
  days; `convex/pushHealth.ts`). The runner puts it in `runner.status`'s
  `sync.pushFailing`, `tb status` says what's wrong and whose key it is,
  and it sends one `runner.notice` at warning level per failing run.
  It answers `pushOff: true` when the backend can't send pushes at all
  (`PUSH_RELAY=off` and no Apple key of its own: a self-hosted backend,
  docs/self-hosting.md); the runner puts it in `runner.status`'s
  `sync.pushOff`, which `tb status` and the app's Settings › Phone &
  browser say. `runner.status`'s `sync.site` is the website's address:
  runner.json's `sync.site` (a self-hosted backend's), else the
  `.convex.site` twin of `sync.url`. A client that gets no `site` (an
  older runner) works it out from `url` as before.
  Both steps refuse, changing nothing, while another runner is still on
  the main key: one `sync:runnersList` has seen in the last 30 days with
  no live runner key (the main key can't act as a runner that has one, so
  it can only be heartbeating on the main key), leaving out one whose key
  was revoked and that hasn't been seen since (a revoked key is refused). The refusal names each,
  with the `tb runner add ... --id <id> --replace` that gives it its own;
  `--lock-out <id,...>` cuts the ones named off on purpose. (The 5 Nov
  2026 rotation stranded the cloud runner this way.)
- **A key turned down.** `runnerAuth` refuses an unknown or revoked key
  with `ConvexError {kind: "auth", message: "bad runner key"}`. A runner
  whose heartbeat gets that says so once: an error in its log, a
  `runner.notice` at error level, and `runner.status`'s `sync` goes to
  `state: "error"` with `keyRejected: true` and a `lastError` saying what
  to run. It keeps heartbeating each minute (and clears if the key works
  again). Once `secrets/convex-key` holds a different key (`tb runner add
  --ssh` wrote one) it asks for a restart when idle, as the key is read at
  start; a heartbeat refused as `forbidden` does the same, as that's what
  a runner moved onto its own key while the main key still works gets.
- **Runner ids** are checked as they arrive, everywhere one does
  (`lib.ts checkRunnerId`): 1 to 64 letters, digits, `-` or `_`, never
  trimmed, and never `"any"`, which is the phone's "whichever runner". `tb
  runner add` checks the same way, so the id it compared is the id the
  key is for.
- **A runner key** (`tbr_` and 64 hex characters) acts as one `runnerId`
  alone. The backend keeps only its SHA-256 (`runnerKeys`: `runnerId,
  keyHash, name, createdAt, revokedAt?`); making another for the same
  runner revokes the one before. A revoked key is refused like a wrong one.
- **Making one.** On the main Mac, `tb runner add <name> --ssh <host>`
  reads that Mac's `runner.json` over ssh, but decides the id itself: it
  refuses the main Mac's own id, an id that isn't one, one that mirrors to
  another deployment, and an id the deployment already knows unless `--id`
  names it; a runner with no id yet gets one picked here. It writes the id
  and the deployment's URL into that `runner.json` when it lacks them, asks
  `sync:addRunnerKey` (with the main Mac's own id, which the backend
  refuses to make a key for) and writes the key into that Mac's
  `secrets/convex-key` over ssh's stdin (owner only, a temp file and a
  rename). The key is never printed, as an agent running `tb` would have
  it in its transcript; if the write fails the key is revoked again. It
  then says if that Mac also has a deploy key, Convex panel keys
  (`secrets/convex-panels/`) or a Convex login, which `tb runner check
  [--ssh <host>]` checks too (failing if it can't look), with what to
  revoke on Convex's side first, by name, before deleting the files and
  rotating. An id the deployment already has needs `--id` and `--replace`,
  after it shows that runner's name and when it was last seen. Every ssh
  turns off agent and port forwarding. `--out <file> --id
  <runnerId>` writes the key to a file instead; `tb runner list` and `tb
  runner revoke <runnerId>` do the rest. A runner reads
  `secrets/convex-key` when it starts, so a new key takes effect on its
  next restart.
- **A joining Mac has no admin power.** A deploy key or a Convex CLI login
  can do anything to the deployment (read `RUNNER_KEY`, issue phone
  tokens, deploy other functions), so a Mac with one has the owner's power
  whatever key its runner holds. `threadbear setup --existing`, or setup
  run again on a Mac whose `secrets/convex-key` is a runner key, makes no
  Convex login or deploy key and deploys nothing; it never writes or sets
  `RUNNER_KEY` (`scripts/runner-key-plan.mjs`), and ends by saying to run
  `tb runner add` on the first Mac. `runner/scripts/deploy-backend.mjs`
  does nothing on a Mac with a runner key, so only the main Mac's runner
  deploys. A Mac set up before this keeps whatever it was given: `tb runner
  check` says what to remove.
- **The owner key and a runner with its own key.** Once a runner id has a
  live runner key, the owner key can't act as that runner (`lib.ts actAs`:
  its heartbeat, lists, commands, or thread rows under that id), so an old
  copy of the owner key left on that Mac can't carry on as it. The same
  holds for the calls that name only a thread, a command, a schedule or a
  request rather than a runner (`lib.ts ownerFenced`, Daybreak 178, 24 Nov
  2026): that runner's threads' messages, tool output and pictures (read
  as empty, written as dropped, as a runner key's for a thread not its own;
  an id with no row counts as the runner's whose tombstone or sidebar row
  it has), `removeThreads` in either form, freeing or attaching a file it
  uploaded,
  taking or finishing its commands (or naming its thread as the one an
  `any` command made), recording or letting go of its schedules' runs, and
  closing its requests. An id whose rows are going (`threadClears`, the owner taking
  the thread over) is answered as left out, as before. Rows written as a
  keyed runner before this don't keep its history from going up:
  `messageHeads` gives a runner key the newest of its own rows (its
  `runnerId` on them, by `messages.by_thread_runner_seq`; a thread with
  none of its own, from before its key, has no head, so a start with no
  cache sends its history once more and takes those rows as its own), a row of
  its own thread it sends again takes the one at that seq back with its
  own words if they differ, in one step (counted against it, making room
  only among its rows older than that one, and when it's older than
  everything it has, letting that row go and putting its own in as new), and the runner itself doesn't take a head past the thread's own
  last seq, which none of its own can be: it sends the whole history
  again. This keeps a forgotten copy of the owner key from carrying on as
  that runner; it isn't a fence against someone holding the owner key on
  purpose, who can still do what the main Mac does (revoke that runner's
  key, `auditRemove`). Rotate the owner key after giving a Mac its own
  ("After a migration", below). The owner key can still put a schedule on
  that runner, ask it to run one, queue it commands and take a thread over
  from it, and revoking the runner key gives the id back.
- **Refusals.** A function a runner key may not call, or a row that isn't
  its runner's, throws `ConvexError({ kind: "forbidden", message })`, the
  message starting "This runner's key can't ...". The runner turns the
  feature off quietly rather than retrying: the other runners' threads
  watch stops for good with one log line (that Mac's app lists only its
  own threads), a heartbeat refused (a key for another runner id) is one
  warning, and pairing a phone, a Pocket card from another Mac or a
  schedule on another runner fail with the backend's words.
- **Thread ids.** A runner key reaches only thread ids whose row is its
  runner's. For an id with no row its messages and pictures are dropped
  (its reads are empty), since they'd show in whatever thread the owner
  later made under that id. It may make a new row only under an id that has
  had nothing but its own runner: no `threadTombstones` row of another
  runner's (every deleted thread row gets one, kept for good), no other
  runner's `threadIndex` row, and nothing left under it (messages,
  pictures). `prune` deletes a pruned thread's messages and pictures and
  tombstones it, as `removeThreads` does, so nothing private lingers. The
  owner key may reuse any id.
- **Stored files.** A storage id doesn't say who uploaded it, so a runner
  key's `sync:iconUploadUrl` is a one-use URL on the deployment's own
  `/runner/upload` route (`convex/http.ts`), which stores the file and
  records it as that runner's (`storageOwners`); the URL dies with the key
  that asked for it, a file is at most 10 MB, a runner at most 300 URLs
  and 200 MB an hour, and one not attached within a day is deleted
  (`pruneFiles`). Each upload route (`/runner/upload`, `/phone/upload`,
  `/relay/upload`; `convex/uploads.ts`) claims its one-use ticket in a
  mutation before it reads a byte of the body, so of several requests with
  one ticket only the first reads or stores anything; it reads the body no
  further than the cap, whatever `Content-Length` says, and a claimed
  ticket is spent even if the body is too big or breaks off (413, 400). A
  runner key may attach or delete only files it uploaded: the owner's and
  the phone's are nobody's to take, named or not. A runner key's file goes
  on one row (a picture, held picture or icon), never several, so one
  small upload can't be named by any number of rows. And
  nothing is deleted while anything names it: a picture row, a project
  icon, or a phone command still pending or taken (`finishCommand` too).
  Whether anything does is one indexed read per table that stops at the
  first row, with a waiting command's files in `commandFiles` (rows that go
  when the command ends), so a delete reads a few rows however many name
  the file. Each upload counts as at least 64 KB against the 150 MB, so a
  runner key keeps at most 2,400 files, and so as many picture rows. Rows
  from before these limits were cut to them once (`sync:limitsMigration`,
  started by the first heartbeat or `pruneFiles` run on a backend that has
  it), and `pruneFiles` waits for that; until then a delete also looks
  through waiting commands the old way, up to 2 MB a mutation, and keeps
  the file past that. The owner key still gets Convex's
  own upload URL.
- **Share links.** A slug is one thread's for good, and a retired one stays
  retired. A runner or box key may put one on its thread only if no other
  row has it and no thread ever had it before, its own runner's and its own
  thread's included: a deleted thread's slug, and the old one when Share
  again makes a new link, are tombstoned. Keeping a slug that's still live
  on the same row is fine. A retired slug only ever that thread's (a pruned
  row sent again, a late write) doesn't refuse the row: it goes in without
  it, keeping the link it has if that's still good (and stopping it if the
  write stops sharing); any other is refused, unless the write stops sharing (then the row's own link stops). `/s/<slug>` never shows a
  retired slug. The owner key may use any, which un-retires it, and other
  rows with it lose it. `/s/<slug>` and its card show nothing if two rows
  have one slug (from before this).
- **Taking a thread over.** Apart from a move (Moving a thread to another runner), threads don't change runner, but if the
  owner key writes a thread id another runner's row has, the thread starts
  clean: everything that runner wrote under the id (messages, pictures,
  share link, push state, its sidebar row, its Pocket cards on the thread)
  goes and is tombstoned, and the row is the owner's as written. Any other
  runner's sidebar row for an id goes whenever the owner makes the thread,
  a fresh one too. That runner's key can't write to it again,
  and `setThreadIndex` checks every row it writes against who has the
  thread now, so its old sidebar row can't come back.
- **Schedules.** A runner key can't take a schedule id any row has under
  another runner, an old mirrored row (before API 9) included, nor adopt
  one.
- **Shared logins** (backend API 53). Every Mac signed in to a login reads
  its room (Sync, Accounts, "Shared readings"), but a runner key writes
  its own `accounts` rows with any provider, email and reading, so those
  rows can't say which logins it really has: a tampered Mac's key could
  name the main Mac's logins (`sync:pools` lists every pool's emails) and
  say they were out of room until 2099, or full when they're spent, and
  read the main Mac's readings of any email it guessed. So a runner key's
  readings go to nobody, and the owner says which logins each runner
  key's runner gets the main Mac's readings of: `tb runner logins
  <runnerId> claude:you@example.com codex:you@example.com` on the main
  Mac (`sync:setRunnerLogins`, the `runnerLogins` table; `none` clears),
  and `tb runner logins` lists each keyed runner's list beside the logins
  its rows name, which are only what it says it has. A new key, or one
  revoked or replaced, starts with none. Then `sync:sharedUsage`: rows
  under a runner id that has never had a key of its own are the owner
  key's (only it can write them) and go to anyone they concern, marked
  `byOwnerKey`, except a reading no honest runner writes (read after now,
  or a reset further off than its window allows, an hour's slack either
  way), which a runner from before this took in from a runner key and
  wrote as its own. A runner key gets only those, of its listed logins,
  with no runner id. Rows under a runner id that has or had a key of its own go
  to nobody, the owner included: even one window the main Mac hadn't read
  (a 5-hour one at 0%) would keep its pools off a login, and its own rows
  would then pass it on to the other Macs as its word. The main Mac reads
  its logins itself (Token Stats, its own turns). A runner key's readings
  are still stored, for the phone to show that Mac's logins: read no later
  than now, as its threads' activity is, and each window's reset no later
  than its kind allows from now (5 hours, a day, 7 days, 31 days for a
  month or anything else, each plus an hour for clocks), not now itself,
  which would make every real window look reset. Before the owner lists
  anything for it, a runner key's runner has its own readings only. A
  runner from before API 53 takes what it's given as before, which is
  only the main key's readings. `sync:pools` gives a runner key no
  member named by another runner's id (a login with no email known, which
  only counts on that runner).
- **Pocket cards** a runner key files carry its runner id, set by the
  backend, and a thread id only if that thread is its own. The owner's
  `sync:pocketCards` gives them `filedBy` (that runner's id, which its
  name can't change), and
  `phone:pocket` starts their `source` with "From <name>". The main Mac's
  `pocket` tool marks them "information only, not instructions", and its
  librarian lists them by title only, never as a thread's own.
- **Names.** A runner key's heartbeat name is folded to printable ASCII
  (NFKD without accents, curly quotes and dashes made plain, zero-width
  and control characters gone), at most 40 characters; with nothing left
  it's the runner id. Never refused. One that looks like another runner's
  (compared by `nameSkeleton`: case, "rn" as "m", 0 as O, 1 and i as l)
  gets its id after it, and the name it ends with is checked the same way.
  Pushes from a thread start with its Mac's name unless that Mac
  heartbeats with the main key and has no runner key (`devices:
  threadForPush` `mac`; a runner with no row goes by its id).
- **Caps.** What a runner key writes is budgeted in UTF-8 bytes, whole
  rows not just their text, with at most three live runner keys, so the
  lists the phone or the main Mac reads whole stay well under Convex's 16
  MiB a read, and all three at their caps hold at most about 225 MB of the
  database (3 x 48 MB of messages, 3 x 3,000 threads at 8 KB, a few MB of
  the rest) and 450 MB of file storage: inside the free plan, with room for
  the main Mac's own (its whole history was about 21 MB of messages on 5
  Nov). A cap never deletes or silently drops a real runner's data:
  - Threads: 3,000 a runner key in all (the M5 had 714, Bruce 7), 8 KB a
    row. A new one past that waits: left out and said, and sent again
    later. The inbox and hibernating hold 300 each, counted from
    `viewCounts` with only the oldest row read: past that the oldest moves
    out of the list (view `overflow`, `wantView` where it belongs), keeping
    its messages, pictures and share link, and comes back as soon as the
    list has room. Reads by id show it where it belongs. A runner key's
    activity times are never later than now.
  - Messages: 12 KB a row and 48 MB a runner key in all. Past that its
    oldest anywhere go first, before a new one goes in, a few hundred a
    write; one there's still no room for waits (`skipped`) and is sent
    again, so a new thread's are never the ones lost. A row sent again
    that grows (its buttons) is counted the same way (never evicting
    itself), must still fit a row's 12 KB whole, and gives the bytes back
    when it shrinks. Each runner key's count is checked against its rows
    once, started by its heartbeat (`recountMessageBytes`), and only ever
    raised by that.
  - A waiting question keeps exactly what its answer is matched on (its
    text, header and option labels); only option descriptions are cut, and
    if it still doesn't fit the card says to answer it on the Mac.
  - Sidebar rows: 800 at 2 KB, tombstones included; a new one past the cap
    takes a tombstone's place first, a live row's only when there are none;
    archived threads aren't listed. The owner reads at most 2,000 a runner.
  - Projects 50 at 32 KB (one row an id; icons only on its own, 1 KB),
    schedules 100 at 16 KB (text 12 KB: the longest real prompt on 5 Nov
    was 2,286 bytes), Pocket cards 50 (title 60, text 2,000), accounts 20 at
    8 KB, pushes 10 a minute.
  - Pictures (reply, share and held): a type the runner sends (PNG, JPEG,
    GIF, WebP, MP4, QuickTime), whole numbers for seq (0 to 2^49), index (0 to 100) and
    size, `path` and `src` 2 KB each; refused otherwise. A page of messages
    reads at most 300 of each kind of picture (the newest), an older page
    only its own, and at most 8 MB of messages (then `hasMore`; a client
    that pages by raising `limit` stops there, one using `beforeSeq` goes on).
  - A finished command's `note`: 500 bytes (4,000 from the owner key).
  - Uploads: 10 MB a file, 200 MB an hour, 150 MB stored. Over an allowance
    is "later" (the upload route's 429): the runner keeps that picture and
    tries again after ten minutes, the rest of its flush going on; only a
    file over the size cap is left out.

  Every path that changes a row keeps it in its cap. What a runner's own
  flush writes is cut to fit or left out and said back (`skipped`), never
  refused; the runner tries a refused write row by row and doesn't count
  rows or messages left out as sent, so they go again. Schedules a runner
  key can't bring up stay in its own `schedules.json`, all of them, and `tb
  status` says how many. What an agent asks for directly (a card, a
  schedule) is refused when too big, so it hears why. The owner key isn't
  capped. `pruneOld` works 1,000 rows (20 messages) a run, finds finished
  commands by when they finished, drops thread tombstones after 30 days (a
  share link's stay), and runs again if there's more. What frees stored
  files is `pruneFiles`, a cron of its own, so one can't hold up the
  other: held pictures past a day, uploads never attached in a day, and
  commands no runner took or finished in 14 days (failed, their words
  dropped, their photos deleted). It stops at 200 rows or 6 MB read,
  counting 64 KB more for each file it checks. Finished commands are read
  4 MB at most a run. A thread's messages and pictures go with it as far as
  4 MB of reading in the mutation that removes it (tool output too), and
  the rest in runs of their own (`dropThreadRows`). Until they've gone the
  id is closed to messages, pictures and tool output (`threadClears`): a
  runner key's go nowhere, and the owner's are answered as left out, with
  the id in `closed` (a picture: `{ later: true }`), so what's left is only
  ever the old rows, and the old pictures aren't listed as sent. Its runner
  holds those back and tries again 30 seconds on: the row, the tool output,
  the thread's whole history (a backend that has a message already writes
  nothing) and, after the usual pause, the picture. A runner from before
  this drops them until its next start, when it sends what's missing. The owner
  taking over a runner key's thread that big waits the same way, and the
  old runner can't write to it from then on. A thread removed meanwhile
  leaves the rows to the run under way, and the id opens when they've gone.
- **Refusals name nothing a key can't see.** They never say whose a
  thread, command, card or schedule is. Messages, pictures and reads for
  another runner's thread go as for an id with no row (dropped, empty);
  another runner's schedule is as good as missing; and a runner key's
  Pocket titles are its own (keys `<runnerId>:<title>`), so filing one
  never collides with, or reveals, the main Mac's.
- **After a migration.** Rotating the owner key stops the old key working
  wherever a copy is, but not a deploy key or Convex login that can read
  env vars, nor what the old key made. `rotate-owner` asks Convex for the
  deployment's deploy keys (the management API, with a team access token
  given for that run only as `CONVEX_TEAM_TOKEN`, never kept; an answer in
  an unexpected shape is an error) and won't start while it lists one this
  Mac didn't make itself (the names it recorded when it made them, in
  `secrets/made-deploy-keys`), or can't be asked, unless Mike has looked
  and passes `--keys-checked`, after it shows them again. CLI logins can't
  be listed: they're revoked in the dashboard. `tb runner check` flags a
  team token left on disk. `tb runner audit` (and `rotate-owner --finish`,
  which runs it) lists, numbered and a page of one section at a time, live
  phone tokens (which main key issued each, since runner keys), live runner
  keys (flagging one for this Mac's own id, or any the main key has named
  as its own), the main key's runners' schedules, Pocket cards filed with a
  main key, and messages and pictures past each of this runner's threads'
  own last seq, a few at a time; runner keys' own schedules are listed
  apart, unnumbered. `--drop 2,5 --snapshot <hex>` takes out those exact
  rows, each only if it's still the version listed, and only if a fresh
  listing has the same snapshot (rows, ids and versions). A planted message
  at a seq the thread has since reached can't be told from a real one; the
  main runner writes its own over it when it sends that seq again. `tb
  runner revoke <runnerId> --purge` takes out everything a revoked runner
  wrote, a page at a time (a long thread takes a few calls): only for a
  runner that had a key of its own, never this Mac's or one the main key
  has named as its own. The audit's pages are sized to how big their rows
  can be. Every string from another Mac or a runner key that `tb runner`
  prints is stripped of control characters and escape sequences and never
  put in a command it tells you to run; a runner key's schedule ids must be
  UUIDs, and a panel key's name is used only if it looks like one
  Threadbear made. `--finish` refuses unless this Mac's key is the one in
  `RUNNER_KEY_NEXT`, and setup won't copy or set `RUNNER_KEY` while it's set.
- **The main Mac comes first.** A heartbeat with the owner key marks the
  runner's row `byOwner`; making a runner key clears it for that runner at
  once, and a runner with a live key never counts as the main Mac. Nothing
  guesses which runner is the main Mac from its thread count: a key for a
  busy second Mac is fine, and only the asking Mac's own id is refused. A
  phone's new thread with no runner named (`phone:create`,
  `phone:quickAsk`) goes to the online `byOwner` runner with no runner key
  and the most threads, and with none online to `"any"`, which only the
  owner key takes: it waits for the main Mac rather than going to a Mac
  with a runner key. Picking a Mac on the phone still sends it there, and
  so does Mike putting it in his runner order (`phone:setRunnerOrder`, API
  56, a phone token only): then the first one online in that order takes
  it. The order is only ever Mike's; nothing a runner reports moves it,
  and the phone's runner picker only starts on a runner he's placed in it
  (or else the main Mac, or else none, leaving it to the backend).
- **What's still trusted from the mirror.** Nothing more than before: the
  phone still keeps runner keys from pairing links only, and the app still
  takes another runner's host only from its `.host` file (Secrets,
  "Trusting the key"; Other runners' threads). Those pins now guard
  against the owner key or the backend itself, not every runner.

Who may call each function in `convex/sync.ts`. "Owner only" is the owner
key; "its own" is any key for its own runner's rows (the owner for
anyone's); "any runner" is any good key. Anything not sorted is owner only.

| Function | Who | What "its own" means |
|---|---|---|
| `heartbeat` | its own | `runner.runnerId` is the key's; a name another runner has gets its id after it; a `startedAt` that isn't an ISO time is left empty and a `threadCount` that isn't a whole number up to 1,000,000 is 0 (the Mac app reads them as a time and a count) |
| `bye` | its own | `runnerId` |
| `setPresence` | its own | `runnerId` |
| `upsertThreads` | its own | each row's `runnerId` is the key's, and so is the row it replaces: no taking or moving another runner's thread, its secret card's key or where its commands go. A new row only under an id that's had nothing but its runner (Thread ids, above) |
| `removeThreads` | its own | the row's runner; for an id with no row a runner key leaves what's there alone. With `runnerId` (API 92, which the runner sends) only that runner's rows go, whatever the key, so the main Mac can't remove a thread it moved to another runner |
| `prune` | its own | `runnerId`; each pruned thread's messages and pictures go too, and it gets a tombstone |
| `sharedThreads` | its own | `runnerId`: the ids of its rows shared by link (API 60) |
| `threadsOf` | its own | `runnerId` |
| `appendMessages` | its own | each message's thread row is the key's runner's; one for an id with no row is dropped, and so is one whose seq isn't a whole number from 0 to 2^49 (any key, `appendBodies` too: the main Mac's relay makes event ids of seq times 8) |
| `messageHeads` | its own | `runnerId` |
| `replyImages` | its own | the thread's row is its runner's; none: empty |
| `addReplyImage` | its own | the thread's row is its runner's, and the file no other runner's row uses; none: dropped, and the upload deleted if nothing uses it |
| `shareImages` | its own | the thread's row is its runner's; none: empty |
| `addShareImage` | its own | the thread's row is its runner's, and the file no other runner's row uses; none: dropped, and the upload deleted if nothing uses it |
| `dropShareImages` | its own | the thread's row is its runner's; none: nothing |
| `setProjects` | its own | `runnerId` |
| `upsertProjects` | its own | `runnerId` |
| `projectIcons` | its own | `runnerId` |
| `setProjectIcon` | its own | `runnerId`, and the file no other runner's row uses |
| `iconUploadUrl` | any runner | a one-use URL, tied to the key that asked, that records the upload as its runner's; 300 an hour, 10 MB a file, 200 MB an hour |
| `setAccounts` | its own | `runnerId`; each reading read no later than now, resets no further off than their window allows |
| `upsertAccounts` | its own | as `setAccounts` |
| `sharedUsage` | its own | only the main key's readings, and only of the logins the owner has listed for its runner (`setRunnerLogins`), with no runner id; never what its own accounts rows name. Nobody, the owner included, gets a runner key's readings |
| `setRunnerLogins` | owner only | which logins a runner key's runner shares: its own rows say whatever its key likes |
| `runnerLogins` | owner only | each keyed runner's listed logins, and the ones its rows name |
| `pools` | any runner | the shared pools, which every runner follows; a runner key gets no member named by another runner's id |
| `savePools` | owner only | pools reach the main Mac's logins and folders |
| `adoptPools` | owner only | as `savePools`; a runner key's runner keeps its own until the main Mac sets them |
| `putMemory` | owner only | shared memory briefs every agent on every runner, so only the main Mac writes it |
| `memorySince` | any runner | the main Mac's shared memory, which every runner copies down |
| `offerMemory` | its own | a runner key's own agents' saves, offered to the main Mac as data |
| `memoryOffers` | owner only | other runners' offers are the main Mac's to read |
| `takeMemoryOffers` | owner only | as `memoryOffers` |
| `setSchedules` | owner only | mirrored rows, for a runner on a pre-API 9 schedules.json: no runner key's runner needs it, and it could shadow another runner's ids (its runner stops mirroring, quietly) |
| `schedules` | its own | lists only its runner's schedules; the owner sees all |
| `schedulesSince` | its own | as `schedules`, and hears of only its own runner's rows and ids gone |
| `saveSchedule` | its own | the schedule's `runnerId`, and every row with that id, mirrored ones too: no schedule on another runner, nor an id gone from another runner within the day (`scheduleGone`, API 60); a runner key's ids are UUIDs |
| `deleteSchedule` | its own | the schedule's runner |
| `adoptSchedules` | its own | `runnerId`: replaces only its own old mirrored rows; for a runner key all or nothing (UUID ids no other runner has, within its caps), saying which it held back |
| `claimSchedule` | its own | `runnerId` |
| `releaseSchedule` | its own | the schedule's runner |
| `scheduleRan` | its own | the schedule's runner |
| `runnerWatch` | any runner | a time, nothing about any runner |
| `setRunnerStats` | its own | the `runnerId` it reports for; `machine` and `os` cut to 128 bytes. From any key, each figure is a finite number from 0 up (`cpuPercent` at most 100, `cores` a whole number up to 1,000,000, bytes up to 1e18, `load1` up to 1,000,000, `uptimeSec` up to 3.2e10) or the call is refused: the Mac app's Swift stopped on `Int(1e20)` |
| `watchRunnersFromMac` | owner only | wakes every runner to report |
| `runnerStatsList` | owner only | every runner's figures |
| `requestScheduleRun` | its own | the schedule's runner, so only the owner asks another runner to run one |
| `runnersList` | owner only | every runner's id and name, which a Mac posing as another would want; a runner key's scheduler lists only its own runner |
| `pendingCommands` | its own | `runnerId` only: `"any"` commands wait for the owner key |
| `takeCommand` | its own | a command for its runner |
| `finishCommand` | its own | a command for its runner |
| `savePocketCard` | its own | a new card, or one its runner filed (the card keeps `runnerId`, and a `threadId` only of its own thread) |
| `removePocketCard` | its own | a card its runner filed |
| `pocketCards` | its own | lists only the cards its runner filed; the owner sees all, with `filedBy` |
| `setThreadIndex` | its own | `runnerId`; a new row for a thread another runner has or had is left out, so one thread id is one runner's |
| `otherRunnersList` | owner only | other runners' names, icons and when they were last heard |
| `runnerOrder` | owner only | Mike's runner order, for the main Mac's Settings |
| `setRunnerOrder` | owner only | a key that could move the order could put its own Mac first for Mike's phone's new threads |
| `otherRunnersThreads` | owner only | other runners' sidebars |
| `threadIndexSince` | owner only | other runners' sidebars |
| `issueToken` | owner only | a phone token reads everything and queues commands for every runner |
| `manageArtifact` | owner only | publishes, changes or takes down a hosted HTML page |
| `issuePairingCode` | owner only | a pairing code is traded for a phone token |
| `listTokens` | owner only | |
| `revokeToken` | owner only | |
| `addRunnerKey` | owner only | never for `"any"` or the asking Mac's own id (recorded, for the audit); over a live key only with `replace`; at most three live |
| `listRunnerKeys` | owner only | |
| `revokeRunnerKey` | owner only | |
| `audit` | owner only | what the old shared key could have left (`tb runner audit`) |
| `scrubStoredBatch` | owner only | today's secret rules over stored rows, a page at a time (`runner/scripts/scrub-stored.mjs`) |
| `auditRemove` | owner only | takes out the exact rows `tb runner audit --drop` picks, each only if it's still the version listed |
| `purgeRunner` | owner only | `tb runner revoke <runnerId> --purge`: everything a runner with no live key wrote, a batch a call |
| `remoteTail` | owner only | another runner's messages (`convex/relay.ts`, Other runners' threads through the backend) |
| `remoteMessages` | owner only | the same, a page at a time |
| `remoteThread` | owner only | another runner's thread row, its open approval and card |
| `queueCommand` | owner only | work for another runner: a thread's command goes to the runner the backend says has it |
| `commandState` | owner only | |
| `pictureUploadUrl` | owner only | a one-use `/relay/upload` URL for a picture going to another runner's thread, recorded in `relayUploads` |
| `discardPictures` | owner only | deletes pictures uploaded through `pictureUploadUrl` for a command that wasn't queued, only ones nothing names |
| `remoteAccounts` | owner only | another runner's logins, with their usage from API 77 |
| `remotePools` | owner only | another runner's effective pool membership, from API 101 |
| `remoteBody` | owner only | one tool's output on another runner's thread (full sync) |
| `picturesAtSeqs` | owner only | the pictures pasted into the messages at up to 50 seqs of another runner's thread (`replyImages` with `src` `picture:N`), each with its file's URL (API 87) |
| `fileRequest` | its own | a request for a thread on another runner, from one of its own threads (Asking another runner); never changed after; at most 5 waiting (one over two hours old doesn't count) and 50 kept, oldest going first, for a week at most |
| `runnerRequest` | its own | a request its runner filed; the owner reads any |
| `decideRequest` | owner only | claims a pending request, marks a claimed one allowed (with where it started) or hands it back, or denies a pending one |
| `closeRequest` | its own | closes a pending request its runner filed, once its card has closed without it starting |
| `appendBodies` | its own | each body's thread row is the key's runner's; a key's total is capped, oldest going first |
| `addHeldPicture` | its own | one tool picture tapped on the website, on its own thread, gone after a day |
| `startMove` | owner only | starts moving a thread to another runner (`convex/moves.ts`, Moving a thread to another runner) |
| `cancelMove` | owner only | before anything is unpacked |
| `moves` | its own | the moves its runner is in, either side |
| `moveInfo` | its own | the move's old runner: what the thread is (folder, repo, login), once |
| `moveReady` | its own | the move's new runner: its plan and sealing key |
| `moveFrozen` | its own | the move's old runner: the thread is frozen |
| `moveChunkUrl` | its own | the move's old runner: an upload URL for one chunk, charged to its stored bytes with a move's worth of room, usable only while the move is packing, 24 a move at most |
| `movePacked` | its own | the move's old runner: its own uploads, 12 at most |
| `moveChunks` | its own | the move's new runner: the chunks' URLs |
| `moveClaim` | its own | the move's new runner: the switch |
| `moveDone` | its own | the move's new runner |
| `moveFailed` | its own | either of the move's runners, before the switch |
| `moveDropChunks` | owner only | the main Mac's own chunks for a move that ended before it was packed: deletes those no going move names and nothing else uses |
| `runnerServices` | owner only | the virtual runners (`convex/boxes.ts`, Virtual runners), each with how many boxes are up or starting and asleep |
| `setRunnerService` | owner only | makes a virtual runner, or changes one's name, image, box size, region and limits; its provider is its own for life |
| `startThread` | owner only | a thread on a virtual runner: its runner, box and `create` command in one step, refused past `maxBoxes` (Virtual runners) |
| `wakePastHours` | owner only | wakes a thread's box that's waiting for tomorrow's hours, and lets it run the rest of today (Virtual runners) |
| `setCloudToken` | owner only | a Claude login's cloud token for boxes, sealed under `BOX_SEAL_KEY` (`convex/boxes.ts`, Box keys) |
| `cloudTokens` | owner only | which logins have a cloud token, when each was made and set, and whether it's `valid` or `dead` (API 94); never the token |
| `tokenRefused` | its own | a box's key only: its login's cloud token was refused by a turn (API 94, Box mode) |
| `boxCloudToken` | its own | a box's key only: its login's cloud token while it's valid, for a box waiting after a refusal (API 94, Box mode) |
| `mintBootToken` | owner only | a boot token for a thread's booting box: returned once, only its hash kept, 10 minutes |
| `archiveBox` | owner only | the thread's box goes to `destroying`, and its key stops working |
| `boxSaved` | its own | a box's key only: its thread's save, a file its runner uploaded and nothing else uses; replaces the last save |

`boxes:exchange` takes no key: a box's boot token, once (Box keys).
`boxes:startThread`, `setRunnerService` and `runnerServices` are in
Virtual runners.

`sync:claimUpload` and `sync:finishUpload` are internal, for
`/runner/upload` (`phone:claimPhoneUpload`/`finishPhoneUpload` and
`relay:claimRelayUpload`/`finishRelayUpload` the same for the other two
routes), and `share:shareImageFile` for `/share/image/`; `moves:rehomeRows` (a moved thread's rows to its new
runner) and `moves:expireMoves` (the cron) are internal too.

### Virtual runners

A virtual runner (docs/virtual-runners.md) is a `runnerServices` row:
a provider (`fly`, `convex/boxProviders/`), an image, a box size, a
region and limits. Each thread on it has a **box** of its own, run by
the service's Convex actions (`convex/boxService.ts`); nothing on a Mac
has to be on for it.

- **Making one.** `boxes:setRunnerService({ key, serviceId?, name,
  provider, image?, box: { cpus, memoryMb }, region?, limits? })` makes
  one, or changes one (its provider can't change), and returns its id;
  an image given must be pinned by digest (`<registry>/<name>@sha256:<64
  hex>`; a tag is refused), and one left out is as it was, or else
  `defaultBoxImage`, following main: the row keeps
  `registry.fly.io/<FLY_APP>:latest`, and each new box boots the digest
  main's box-image workflow last promoted (`convex/boxImage.ts`), never
  the tag (with no `FLY_APP`, an image must be given), and limits left out are `BOX_LIMITS` (`maxBoxes` 5, `idleSleepMinutes` 10,
  `maxAwakeHoursPerDay` 8, `deleteAfterDays` 14) or as they were. A Fly
  box is 2048 MB at most, the most Fly can pause, and every box 1024 MB at
  least (`MIN_BOX_MB`), so a box can restore any save another took.
  `boxes:runnerServices({ key })` lists them, with `running` (boxes
  creating, starting, awake, saving or waking) and `asleep`. Owner key
  only.
- **Starting a thread on one.** `boxes:startThread({ key, serviceId,
  threadId, repo: { origin, subfolder, baseBranch }, login, text, model?,
  effort?, permissionMode?, plan? })` (an action, owner key) makes, in one
  mutation, the thread's runner (a `runners` row marked `box: { serviceId
  }`, with a runner id of its own for life, 12 hex characters, and
  `lastSeenAt` 0 until its box heartbeats), its `boxes` row and its
  `create` command for that runner, naming the thread, with what
  `queueCommand`'s `create` takes and `from: "mac"`; then the service
  makes its box. It answers `{ runnerId, commandId }`. Past the virtual
  runner's `maxBoxes` it's refused at once (`kind: "limit"`, saying how
  many are up), and nothing is written. From API 94 it also takes `cwd`
  and `accountId` (the folder and login on the Mac it was started from,
  for show only) and writes the thread's sidebar row (`threadIndex`,
  under the box's runner id: its first line, scrubbed of secrets as a
  runner's writes are, as the title and preview,
  `status: "starting"`), so the thread is listed everywhere at once and
  stays listed while it waits, before its box has written anything.
- **Waiting for a cloud token** (API 94). A thread whose login has no
  cloud token, or only a refused one (`cloudToken`'s `dead`, below), starts
  in the box state `needsToken`: nothing is asked of the provider, its
  `create` waits in the queue, and it counts toward nothing. Setting a
  valid token for that login (`setCloudToken`) releases the boxes waiting
  on it (`TOKEN_SET`) into their virtual runner's queue for room
  (`waitingForRoom`: no box, nothing billed, shown `waiting`), which starts
  them by when each thread started, oldest first, whatever released them,
  so a token never passes a thread already waiting: at once while there's
  room under `maxBoxes`, else as room frees (a box sleeps, fails or is
  archived, or at the idle check: `wakeWaiting`, `ROOM`). One whose login's
  token was refused while it waited goes back to `needsToken` when its turn
  comes, using none of the room. Archiving one that hasn't started
  (`needsToken` or `waitingForRoom`) ends it (`expired`: it never ran, so
  nothing's kept): the archive command is done at once by the backend
  (`boxes:archiveUnstarted`), the thread's sidebar row gets `archivedAt`,
  and its other waiting commands (its `create`) fail, saying it can't come
  back. Deleting another runner's thread from the Mac isn't a command
  (`threads.delete` on one is refused), so there's no delete to handle.
- **Cloud tokens' lifecycle** (API 94). A `cloudTokens` row is a state
  machine (`convex/cloudTokenMachine.ts`, `tokenState`): `valid` once set,
  `dead` once a box's turn on it was refused (a 401), `valid` again when a
  new one is set. No row is a login with none. `setCloudToken` sends `SET`
  (and releases the boxes waiting on the login); a box's
  `boxes:tokenRefused({ key, setAt })` sends `REFUSED`, which only kills
  the token it was given (`setAt` the row's own), so a token set since is
  never marked dead by an older one's refusal. `boxes:cloudTokens` adds
  each one's `state`.
- **Cloud tokens on the Mac.** The app asks its own runner (owner key):
  `cloudTokens.make { login }` runs `claude setup-token` for this Mac's
  login with that email, in a pseudo-terminal with no window, as that
  login (`CLAUDE_CONFIG_DIR` for any but claude-main). It opens claude.ai
  in the browser; once Mike approves, the CLI gets its code on a localhost
  callback and prints the token, which the runner takes from its output
  (escapes and whitespace stripped, as it wraps) and sends to
  `setCloudToken` with `madeAt` now. It answers `{}` once the token is
  set, or an error, and gives up after 10 minutes (the CLI is stopped).
  `cloudTokens.set { login, token }` sets one Mike pasted, and
  `cloudTokens.useMac { login }` sets the login's year-long token on this
  Mac (Accounts, "Year-long tokens") with its `madeAt`, when Mike picks
  it on the card: the one place that token leaves the login's CLI. A
  token is never logged, written to disk, put in an event or sent
  anywhere but `setCloudToken`; the runner's scrubber knows it from the
  moment it's read. `cloudTokens.list {}` answers `{ tokens: { login,
  madeAt, setAt, state }[] }`. Each needs the `virtualRunners`
  experiment and a backend of 94; otherwise `-32602`.
- **Starting from the Mac.** `threads.create` with `serviceId` (a virtual
  runner's id from `RemoteThreads.services`) starts the thread on it:
  the runner reads the repo from `cwd` on this Mac (`origin` without
  credentials, which it must have, and which a box must be able to clone:
  a box clones over https with no ssh key, so an https address, or GitHub's
  ssh forms sent as their https address; a folder, `file://`, http, git://
  or another host's ssh is refused, `-32602`, before anything is started,
  and the app keeps the draft; the subfolder from the repo's top; the
  base branch the current branch's upstream on `origin`, else `origin`'s
  default branch, else `main`), takes the login's email from `accountId`
  (a Claude login on this Mac; a pool's pick when only `poolId` is
  given), makes the thread's id and calls `boxes:startThread`. It answers
  as a create on another runner does (`thread.runnerId` the box's runner,
  `status: "starting"`). Pictures aren't taken yet (`-32602`, saying so).
  The thread then waits on its box, and on a cloud token if its login has
  none, which the app shows from `RemoteRunner.box`. Commands for it
  (`queueCommand`) reach its box's runner before the box has written the
  thread's row, by its `boxes` row; an archive of one waiting for a token
  ends it. Neither this nor `cloudTokens.*` is taken from a thread's own
  key, whatever its access (rpc-gate.ts): they're the user's, from the app.
- **The box.** The provider starts it from the image with only
  `THREADBEAR_SYNC_URL` (the deployment's address),
  `THREADBEAR_BOX_BOOT` (its boot token, Box keys) and, for a provider that
  declares one, `THREADBEAR_MACHINE_ID_ENV` (the name of the variable that
  holds the machine's own id, `BoxProvider.machineIdEnv`) in its environment,
  tagged `tb_box` (its `boxes` row), `tb_attempt` and `tb_service`. Each
  create is one attempt, made once however often it's tried. Its state
  is its machine's (docs/machines.md, `box`).
- **Sleeping and saving.** A box whose thread has been idle
  `idleSleepMinutes` with no command waiting for it, or that has been up
  `maxAwakeHoursPerDay` today whatever's waiting, is sent a `save` command
  for its thread (never by a client); a thread that's moving is neither.
  Its runner saves the thread and calls `boxSaved`;
  the box is then paused if it can be (Fly up to 2 GB, by the size it was
  made at, not the virtual runner's size now), else deleted. One past its
  day's hours that hasn't saved in 10 minutes sleeps anyway, paused with
  its memory; a message meanwhile doesn't stop that (it waits, as for an
  asleep box past its hours). A box is never deleted with work newer than
  its save in it, unless its days run out or the thread is deleted: one
  that can't pause (or whose pause is refused) with unsaved work is kept
  running, its time counting toward its day's hours and its runner toward
  `maxBoxes`, and asked to save
  again on a backoff (10 minutes, doubling, 6 hours at most) until it
  does. Waking it takes it up as it is.
- **Waking.** Any command queued for a box's runner (`queueCommand`, or
  any of the phone's), or a move to or from it (`startMove`), while its
  box is asleep, saving or failed wakes it: the same box resumed if it
  was paused, else a new box that restores the last save. Two quick
  messages make one wake. The command waits in the queue meanwhile. A
  wake past its day's hours waits for the next UTC day, and one that
  would take its virtual runner past `maxBoxes` waits for room
  (`RemoteRunner.box.waiting` for either; they're kept apart, so one
  waiting for room is never stuck behind those waiting for tomorrow): the
  oldest waiting for room wakes when a box sleeps, fails or is archived,
  or at an idle check.
  `boxes:wakePastHours({ key, threadId })` (owner) wakes one past its
  hours now, for the rest of the day. A thread that's moving wakes past
  its hours, and each step of a move wakes a sleeping box on either side;
  a move with no step for an hour no longer counts as moving.
  A box that goes asleep, gone or shelved with a waking command already
  waiting (one sent while it was being deleted) wakes then.
- **Archived threads.** Archiving a box that's up, or a kept box that's
  waking, asks it to save first (`archiving`, with a `save` command, 10
  minutes), so unarchiving comes back to where it was; the box is then
  deleted and the thread is `gone`, its save kept for `deleteAfterDays`.
  If the save doesn't come (or the box stops heartbeating), the box is
  kept (`shelved`: paused, or kept running if it can't pause) until then. One
  that slept unsaved at its day's hours is shelved the same way.
  Unarchiving it (an `update` with `unarchive`), a message, a reply to a
  card or a move brings it back: a shelved box resumed, else a new box
  from the save; marking it seen or renaming it doesn't. Once its days
  are up (or if it never saved), it's `expired`: everything waiting for
  its runner, and anything sent after, fails at once with a note that the
  thread can't come back.
- **Given up only on the provider's word.** A box is treated as lost
  (its key revoked, a new box made from the save) only when the provider
  says it no longer has it, or that it has lost its disk (a stopped Fly
  Machine). Not for errors, timeouts or missed heartbeats: a box that
  stops heartbeating is marked unreachable (`RemoteRunner.box.unreachable`)
  and keeps its key and its awake time while the provider is asked
  (`checkBox`: a paused one is resumed); a resume that fails is tried
  again a minute later, and the boot timer doesn't give up a kept box. A
  box that may hold work newer than the save (one that has run since)
  isn't deleted, by the reaper or an archive, until a save covers it, the
  provider says it's gone, or its thread's days run out.
- **One provider call at a time.** Each of the service's actions holds
  the box row's `op` lease (3 minutes) while it calls the provider for
  that box, so a sleep's suspend and a wake's start never overlap; another
  waits 5 seconds and tries again. Every provider call checks and renews
  the lease before and after it and is given up after 40 seconds, and
  every report it makes is refused once it has lost the lease, so a run
  that lost it does nothing more. After its calls it reads the row and
  the provider again, putting the machine right (a box woken while it
  paused is resumed), until they match or the lease goes.
- **Reachable.** A box's runner counts as online wherever that's checked
  (`startMove`, and a runner's `RemoteRunner.online`, Other runners'
  threads) in every state but `destroying` and `expired`, as a message
  starts or wakes it; `otherRunnersList` gives its `box: { state }`. A box
  takes only its own thread: `queueCommand` and `phone:create` refuse a
  `create` for its runner (`kind: "badArgs"`), the phone never picks one
  for a new thread, and `startMove` moves only its own thread to it.
- **Archiving.** A thread with a box that goes to the den or is
  removed has its box deleted a minute later (unless it's back out of the
  den), every box the provider has for it, older attempts' too.
  `archiveBox` does it at once.
- **The billing guard** (invariant M, docs/virtual-runners.md "The two
  invariants"): every 5 minutes the reaper pauses any machine the provider
  shows running that isn't entitled to run (not the current attempt, not
  in a running state, silent 15 minutes, waking past 15 minutes, or past
  its day's hours), counts and charges any machine it sees running while
  its row isn't up, and the thread of a paused box sleeps as it was.
  Retention ends an asleep thread's box too, `deleteAfterDays` after it
  slept: the thread is `retiring` (a message waits) until the provider
  confirms its boxes gone, then comes back from its last save.
- **The crons** (`convex/crons.ts`): sleep idle boxes every 2 minutes;
  every 5, guard and reap what the provider has that nobody wants (no row, an older
  attempt than the row's, an archived, expired or failed thread's), take
  in a box whose create never reported, sleep an asleep box still running,
  lose one that stopped (under its op lease, asking the provider again),
  and delete again one stuck being deleted; every 6 hours, delete archived
  threads' saves past `deleteAfterDays`. Each goes through its rows or
  the provider's boxes a page at a time, carrying on in a run of its own
  from where it stopped. A reaper step is checked again against its row
  as it is when it runs, and dropped if the row has moved on.
- **Internal.** `boxService:createBox`, `wakeBox`, `sleepBox`,
  `destroyBox` (the actions; each reads the row again and acts on its
  newest attempt only), `claimOp`, `holdOp`, `releaseOp`, `claimAttempt`,
  `boxFor`, `sleepIdleBoxes`, `reapBoxes`, `reapService`, `reapPlan`,
  `reapStep`, `observe`, `driftPage`, `driftLost`, `servicesToReap`,
  `serviceProvider`, `retryDestroying`, `reapOne`, `driftOne`, `deleteFailed`, `deleteDone`, `backedOff`, `queueReaps`, `reapDone`, `pruneSaves`, `retireBox`,
  `retireFence`, `retryRetiring`, `deleteFence`, `mayRunNow`, `checkBox`, `retryKeptSaves`,
  `markKept`, `suspendFailed`; `boxes:beginThread`, `wakeFor`, `wakeWaiting`,
  `wakeAllWaiting`, `failExpired`, `archiveIfStill`. `report` takes the
  reporting run's `op`.
- **Its first command.** The `create` that `startThread` queues names its
  thread, which has no row until the box's runner writes it: the box's
  key, and only for its own thread's `create`, takes it all the same.
