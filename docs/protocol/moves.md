# Runner protocol: Moving threads, sync and devices

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

## Moving a thread to another runner

Added 8 Nov 2026 (docs/archive/move-plan.md) as the experiment `moveToRunner`, on
for everyone from 12 Nov (a runner from between those dates takes part only
with it on). The thread itself moves: the same id, its whole
event log, pictures and Highlights, its Claude session, and the git work in
its own worktree, from the runner that has it (S) to another (T). Exactly
one runner has it at a time. Only the main Mac's runner (the owner key, O)
starts a move, and O can be S or T. Runners still never talk to each other:
everything goes through the backend's `threadMoves` row (backend API 64).

**The row.** `{ moveId, threadId, from, to, state, cwd?, accountId?, info?,
plan?, key?, chunks?, sha256?, bytes?, note?, createdAt, updatedAt,
frozenAt? }`. `cwd` and `accountId` are what Mike picked (absent: T
chooses). `info` is S's description of the thread (below), `plan` T's
answer, `key` T's sealing key, `chunks` the sealed bundle's storage ids in
order. Each runner watches the moves it's in
(`moves:moves`: rows with `from` or `to` its own, still going or
ended in the last day) and acts on the state:

| state | who acts | then |
|---|---|---|
| `asking` | S describes the thread: `moves:moveInfo { moveId, info }`; then T checks it can take it: `moves:moveReady { moveId, plan, sealKey }` | `ready` |
| `ready` | S waits for the thread's turn and sub-agents to end, then freezes it: `moves:moveFrozen` | `packing` |
| `packing` | S packs, seals, uploads: `moves:movePacked { moveId, chunks, sha256, bytes }` | `unpacking` |
| `unpacking` | T downloads (`moves:moveChunks`, T only, the chunks' URLs), checks, opens and unpacks into staging, then `moves:moveClaim` | `claimed` |
| `claimed` | T adopts the thread and mirrors it: `moves:moveDone`. The move ends once the thread's mirrored rows have all gone to T too (`moves:rehomeRows`, a page at a time); until then it stays `claimed`, so the thread can't start another move. T takes them as its own writes are taken (Daybreak 181, 24 Nov 2026): a runner key's runner or a box (`lib.ts hasAllowance`; a box's key isn't a `runnerKeys` row, but it's charged like one) within its message and tool-output allowances, as if it had written each row when it was written: when T is full a row makes room only among T's own threads' rows older than it (a few a run), and goes itself, rather than come over, when T has none, the page running again while it gets somewhere (one that can't make any room waits for the sweep, `expireMoves`), and a picture's file only if it has room to store it, charged at its size even if it had no record (the owner's), else the backend's copy goes (T's runner sends its own again when it has room). S's rows and the thread's rows nobody was charged for all go to T. Pages are small enough to read (50 messages, 8 tool outputs, 200 pictures). A row of a thread now T's that S's own room-making meets goes to T if T has room, goes as T's own oldest would if it's older than anything T has, and otherwise waits for the rehome. T's runner sending the thread's history again before the rehome reaches a row takes it within its allowance the same way. The owner takes no allowance, as before | `done` |
| `done` | S puts its copy away (`<home>/moved/<id>`, kept 7 days), unless a later move has brought the thread back | |

Any state before `claimed` can go to `failed` (`moves:moveFailed { moveId,
note }`, by S or T, with what went wrong in a line Mike can read) or
`cancelled` (`moves:cancelMove`, owner, before `unpacking`). A move frozen
30 minutes ago and not yet claimed fails by itself, and one still `asking`
after 10 minutes from its start or S's description (T offline). One `ready` waits for S's thread to finish
its turn, so it fails only once S hasn't been heard from for 10 minutes,
or after 12 hours whatever S says, so it can't block the thread's next
move for good. On `failed` or `cancelled` S unfreezes the
thread if it froze it and T throws away its staging; the chunks are deleted
when a move ends, whichever way. A runner that restarts reads its moves
again and carries on from the state. A call refused with "The backend is
being updated" (a deploy's stepping stone, for a minute) is asked again,
only that call, rather than failing the move: 20 seconds later, then
longer each time, up to 5 minutes, for about 20 minutes in all. T's adopt
and `moveDone` at `claimed`, where there's nothing to fail, are tried again
the same way whatever went wrong. So is T's `moveClaim` once it has
placed the thread (never the placing): a claim whose reply was lost may
have gone through, and a `claimed` move can't fail; `moveClaim` answers a
claimed move as done, and one that never goes through ends at the thirty
minutes. Older runners failed the move, or left
it `claimed` until T restarted, so while the stepping stone is up
`moveDone` and `moveFailed` still go through as they did before the
machine.

In the backend a move is a state machine (`convex/moveMachine.ts`,
[machines.md](../machines.md)) on its own field, `moveState`; `state` stays
these strings, written from it. Its one state runners don't see is
`handedOver` (every row gone to T, waiting for T's `moveDone`), shown as
`claimed`.

- **Starting.** `moves:startMove { threadId, to, cwd?, accountId?, expect? }` (owner
  only; `expect` from API 83, the preview's binding below): the thread's row must be another runner's or this one's, `to` a
  different runner heard from in the last 3 minutes, and the thread in no
  other move still going. Answers `{ moveId }`.
- **S's info.** `{ title, cwd, home, provider, accountId, email?, model?,
  effort?, permissionMode, origin?, repoTop?, subdir?, worktree: boolean,
  sessionId?, schedules: number }`: what T needs to choose a folder and a
  login (`home` is S's home folder, for swapping). `origin` never carries
  a password or token (`withoutCredentials` in move-git.ts: any address
  loses its whole user part, in the URL and `user@host:path` forms alike
  (the host ending at the first `:` before any `/`, as git reads it, so an
  `@` in the path can't hide the user; one with an `@` and then a `:`
  after that, like `user:token@host:path`, can't be told from a login and
  is left out altogether), but for ssh's own `git`, and the query and
  fragment go; `host:path` with no user still clones, ssh's own config
  giving the user), and
  the backend strips one an older runner sends (`moveInfo`, and a
  `moves.preview` call's description). It's S's word, and S may be an
  extra Mac: from API 83 the backend's `moveInfo` keeps only these fields,
  each of its type, strings at most 4096 characters with no control
  characters (it refuses one that isn't), and T reads it through
  `moveInfoFrom` again, which also refuses a `subdir` that isn't plain
  names joined by `/` (no `.`, `..`, empty or %-encoded part, no
  backslash, never absolute). The preview sends T only what it
  plans from (`previewInfo` in moves.ts: no title, model, session or
  schedule count), scrubbed as sync scrubs, as a relay command isn't
  scrubbed on its way.
- **T's plan.** `{ cwd, accountId, model?, effort?, worktree?: { repo,
  subdir }, clone?: { url, to }, within?: string, leftBehind: string[] }`.
  The folder is Mike's
  pick if he made one; else, for a thread with a worktree, a new one of
  T's own in its copy of the same repo (found by `origin` URL among the
  folders T knows, or cloned from `origin` to the path S has it at, with
  S's home swapped for T's: `clone` says where); else the same repo by
  `origin` URL at the same subfolder; else the same path with the home
  swapped. T picks the place, never S (Daybreak 136): a path of S's names
  a place on T only if it's under S's `home` and, swapped, still under
  T's once normalised, and never a place that isn't plain (`plainPlace`):
  T's home itself, or a folder with any folder on the way to it hidden or
  one tools load from (`~/Library`, `node_modules`, `vendor`, `bin`,
  `site-packages` and the like), as written and links followed. Mike can
  pick one. The same goes for a repo T finds by `origin`, even one of its
  own threads' (a dotfiles repo at the home, a checkout inside a
  `node_modules`), and one found from S's path must be inside T's home,
  links followed, unless one of T's own threads works in it. A `subdir`
  in the repo that's a hidden or installed packages' folder (`.git`,
  `node_modules/x`, as written or through a link) runs the thread at the
  repo's top instead, with a note in `leftBehind`; in a fresh clone or
  worktree that's checked as made. A worktree thread's repo needs a
  worktree patch of its own: one found in a repo around it (a nested
  checkout) would make the worktree in that other repo, so the preview
  says so and placing refuses it. A clone is named for the
  repo (from `origin`, never S's folder name), goes only
  to a new folder in a plain place beside a repo one of T's own threads
  works in (its main checkout's folder, links followed), so never
  somewhere a tool loads from, and isn't
  made for a worktree thread (clone it by hand first: a worktree patch
  in a folder above a fresh clone would set it up); and the thread's
  folder must be inside its repo, Mike's pick, or T's home, links
  followed (`within`). T doesn't trust the plan the row
  gives back: placing plans again with the same checks, just before it
  clones or makes anything, refuses a plan that differs from the row's,
  and checks the folder as made (after the clone, the new worktree and
  its git work) before the thread takes it; a folder the git work didn't
  make runs at the worktree's top, with a note. The login is Mike's pick, else T's login with the same email,
  else T's default. `leftBehind` is what T already knows won't come. T
  answers `moveFailed` when there's no folder or login for it.
- **Preview binding.** A move does what its preview showed or nothing
  (Daybreak 142). The main Mac's runner, answering `threads.movePreview`
  with nothing in `problems` and a folder and login, works out a digest of
  the thread, `to`, Mike's picks, the planning half of S's description
  (`cwd`, `home`, `provider`, `email`, `origin` without credentials,
  `repoTop`, `subdir`, `worktree`, as T will have it: through
  `previewInfo` and the runner's scrubber) and T's answer (`cwd`,
  `accountId`, `worktree`, `clone` and where from) (`moveBinding` in
  moves.ts), keeps it for ten minutes under a random `previewId` it
  returns, and
  `threads.move` with that `previewId` (once only, for the same thread,
  runner and picks) starts the move with it as `expect`. Without one (the
  Swift app, an older `tb`, `move_thread`) `threads.move` looks itself and
  binds to that, refusing a move with a problem, or one that would clone
  (a clone is shown first, in the Move sheet). T works the digest out
  again from the description on the row and its own plan, at `asking`
  and again before it downloads anything, and fails the move ("changed
  since the Move sheet looked") if they differ or the row has none. T
  says it does this with `checksPreview: true` in its preview answer, and
  the main Mac's runner gives no `previewId` for a T without it (a runner
  from before this, which would do what the row says): a problem asks it
  to update first. The row's `expect` is the backend's word, so on the
  main Mac's runner, which starts every move, T also takes a move only
  with a binding its own `threads.move` used in the last day, for that one
  move (`MovePreviews.vouches`: the move `startMove` answered with, or the
  first to carry it), so a cancelled move's binding on a new move's row
  takes nothing; a restart between starting a move and taking it in fails
  it. Any runner leaves alone a move it has seen end (done, failed,
  cancelled) whose row comes back in an earlier state. Moves between two other runners are checked against the row alone.
  The main Mac's runner reads another runner's description through the
  relay, which scrubs anything shaped like a key, while the move's row
  keeps folder paths whole, so a thread whose folder name looks like a key
  fails its move as changed: it fails safe, and is left so. The GPUI app's Move to goes straight away only on a
  look with a `previewId` and no clone, and its Move sheet's Move with a
  folder or login changed since the look asks again and shows that
  first.
- **Freezing.** From S's first step (`asking`) until the move ends S starts
  no new turn on the thread: messages (the app's, the phone's, agents',
  schedules') go in its queue, which moves with it. A running turn goes on;
  holding the queue is what lets it end, so `ready` can freeze. `ready`
  waits for that with no timeout (a long turn can take hours); Mike can
  Cancel. At `moveFrozen` the CLI is released, so background shells stop.
  `ThreadSummary.moving` says so (below).
- **The bundle.** A tar, gzipped, of: `thread.json`, `events.ndjson`,
  `blobs/` and `media/` from the thread's folder; the Claude session's
  transcript and its `<sessionId>/` folder; the thread's schedules (from
  `schedules.list`); and `git.bundle` with `git.json`. Sealed to `key` as
  secrets are (X25519, HKDF-SHA256 with info `threadbear move v1
  <moveId>`, AES-256-GCM), then cut into 9 MB chunks, uploaded as any
  runner file. Over 100 MB sealed, S fails the move saying what's big.
  A runner key's chunk (`moveChunkUrl`, then `/runner/upload`) is stored
  only while the move is `packing` and the key is S's, is charged to S's
  stored bytes like a picture (with 120 MB of room on top of its 150 MB,
  so one move's worth always fits) but not the hour's allowance (the
  move's 24 tickets bound that), and is named with the move
  (`storageOwners.moveId`): when the move ends, however it ends, every
  upload made for it goes, listed in `movePacked` or not, and S gets its
  bytes back. The main Mac's own chunks are Convex uploads with no such
  record, so when its `movePacked` (or a chunk) fails because the move
  ended meanwhile, its runner names them in `moves:moveDropChunks {
  moveId, chunks }` (owner only, once the move has ended), which deletes
  each one no going move names and nothing else uses.
- **Git.** Only for a thread with a worktree of its own. `git.bundle` holds
  the branch from where it meets S's `origin/<default>` (so commits only
  on S's main come too), and one more commit, `refs/threadbear/move-wip`,
  of every uncommitted and untracked file (`.gitignore`d ones stay).
  `git.json` is `{ branch, head, wip?, base, origin?, subdir }`. T fetches
  `origin`, makes the thread's worktree as for a new thread (branch
  `thread/<id8>`, its own slot, setup), fetches the bundle into it, checks
  out the branch at `head`, then puts `wip`'s changes back as uncommitted.
  A thread in a shared checkout moves to the same repo there without its
  changes, and `leftBehind` names the files. Every git a move runs, on S
  and T, the preview's look for uncommitted changes included, goes through
  `untrustedGit` (runner/src/safe-git.ts): the repo's config is read first,
  and every filter driver it or yours names is switched off (clean, smudge
  and process blank, not required), with no hooks, fsmonitor, signing,
  diff programs or auto gc, and git never looks inside a submodule
  (`--ignore-submodules=all` on status and diff, `--no-recurse-submodules`
  on fetch, reset, read-tree and ls-files), as a submodule's own config is
  one Threadbear hasn't read, no `diff.external` (diffs are git's own), only
  the git commands a move and the done card's check use (`log`, `show`,
  `merge`, `stash`, `git submodule` and the like are refused), the old
  runner's commit ids only as full ids, and no fetching at all
  but the bundle (file only) and T's fetch of `origin` (https, ssh or
  file, git's own upload-pack, and only your own credential helpers, ssh
  command and alternates command). A repo with a filter name git's `-c`
  can't carry (one with `=`) fails the step rather than running git.
  Files cross as the disk has them, so a git-lfs file goes as its content.
  T clones only from an `https`, `ssh` or `user@host:path` origin, into a
  new folder it picks (T's plan above).
- **The switch.** `moves:moveClaim` is the one mutation where the thread
  changes hands. It sets the thread row's `runnerId` to T (clearing any
  card on it), hands T its Pocket cards on the thread and its share link,
  deletes S's sidebar row (`threadIndex`) for it, and moves its mirrored
  rows (messages, tool bodies, pictures, and the stored files they name) to
  T in runs of their own, so the thread's history stays on the phone and
  nothing is cut. From then on commands for the thread go to T, and S's
  writes under the id are refused.
- **On T.** The thread's folder goes into place with T's `cwd`, `accountId`
  and worktree, the transcript into that login's config folder under the
  new folder's name, and the thread is adopted as a handover adopts one.
  It gets a `system.note` ("Moved from M5 to cloud, in <folder>."), plus
  what was left behind; its next turn resumes the same session (Claude;
  Codex starts afresh with the handoff note). The schedules are made again
  on T for the thread, and S deletes its own once the move is `done`. T
  takes only when and what each sends (`text`, `title`, `cron` or `at`,
  `timezone`, `paused`, and `createdBy` if it's the thread itself:
  `movedSchedules` in moves.ts), as the bundle is S's word and S may be an
  extra Mac: no shell check (and the thread's note says one was left
  off), folder, login, mode or runner. The thread's `allowRules` ("Always
  allow" answers), its reply buttons and an open card's commands are
  dropped too (as it's placed, and again as it's adopted): asked or made
  again on T. Its design reviews, in the record and in `events.ndjson`'s
  `review.updated` events (which the apps draw cards from, and which
  `recoverReviews` reads back), keep only files that came in the bundle as
  `<thread id>/media/reviews/<review id>/<name>` (or a page's
  `<folder>/<name>`), regular files, not links, rewritten to T's own copy,
  with the type and size the file itself has, named as that kind of file
  and within show_options' sizes (a page called a video is a page; a file
  that's neither, or a video's bytes under another name, goes):
  any other path goes, a shot with no picture left goes, an option with
  none goes, and a review with no options left goes (a `system.note` takes
  its event's place, so seqs stay gapless; every line is parsed, so an
  escaped type is no way round it, and a thread an older runner put live
  before adopting has its live log fitted as it's adopted). A note's links
  to anything but a web page become words (every `](` not followed by a
  web address alone, with only ASCII spaces round it, becomes `]\(`), and `url` is kept only when it's http(s)
  (Daybreak 159). On the main Mac (the owner key), a thread from another
  runner arrives with at most Ask: Full or Auto becomes Ask, and so does
  the mode Plan first would go back to, with a line in its note saying
  what it had (Mike, 10 Nov 2026: the mode is that runner's word, and the
  main Mac's sidebar never showed it); a thread in Plan first there goes
  back to Ask when its plan is approved. Any runner turns a mode it
  doesn't know into Ask. All of this is applied to the record before it
  joins the live threads, and again to one a crash left there or loaded.
  A moved worktree's setup doesn't run by itself when the moved git work
  changed the patch's copy or any file its setup reaches (from the commit
  T made the worktree from): Threadbear's own checkout is always trusted,
  so nothing else would stop the old runner's script running on T. The
  thread's note says so, and the setup can be run by hand after a look.
  For the same reason, a worktree whose moved work changed anything
  patch or Claude settings trust covers (a file under any `.threadbear`
  or `.claude` folder or a `.mcp.json`, any case, or a file a patch there
  or the Claude settings reach, commands or grants), worked out from the
  move's own commits so an ignored file counts, is unvouched: listed in
  `patch-trust-unvouched.json` beside `patch-trust.json` (a file of its
  own, as an older runner finishing turns rewrites the trust file with
  only what it knows), where an always-trusted checkout's
  trust doesn't reach it, so its patches and Claude settings wait to be
  trusted in Patches like any folder's. It stays so through the thread's
  delete and cleanup and across restarts, until a worktree is made there
  afresh. It's worked out again as the move is adopted, before anything
  loads (for one placed by an older runner, from the worktree, ignored
  files included). The file is `{ "version": 2, "unvouched": [...] }`.
  When it's missing, unreadable or has no version (it moved twice on 10
  Nov 2026, from a `worktree.unvouched` mark on the thread's record to an
  `unvouched` array in `patch-trust.json` to here), the runner works the
  list out again at start, before anything loads a patch or seeds trust:
  every thread's worktree its record marks (`worktree.movedIn`, set for
  every moved worktree, or the old `unvouched`), or whose event log has
  adoption's "Moved from" note, is held, as nothing says what an old
  move brought; `patch-trust.json`'s array is taken in whenever that file
  is read. While the file can't be read, no worktree of an always-trusted
  checkout has its trust, only the checkout. A first start's seeding
  trusts none of a held worktree's patches. A thread handed over before
  start works the list out first, and a record that can't be read (about
  to be rebuilt without its worktree) holds the linked worktree its log's
  note names (security review, 11 Nov 2026). A move whose uncommitted work brings anything under a
  `node_modules` folder fails: those files would be untracked on T, which
  trust reads as installed packages and doesn't hash (one an older runner
  placed loses its untracked `node_modules` files at adopt, and setup
  installs them again). A changed symlink unvouches the worktree too. A preview's description in the backend has no title or
  session either (an older main Mac sends them).
  Queued messages are sent. T's mirror sends the thread's whole history
  again (a thread new to it), which overwrites the same seqs.

`ThreadSummary.moving?: { moveId, to, toName, state, note? }` while a move
is going on S, and for a minute after one fails there (with the note). The
main Mac's runner puts the same `moving` on another runner's row in
`remoteThreads` for the moves it knows of: one coming to it (from its own
watch, with a failure's note), and one it started between two other
runners (shown as `asking` until the thread is listed on its new runner, or
35 minutes, as it can't see that move's steps). Methods on the main Mac's
runner:

| method | params | result |
|---|---|---|
| `threads.movePreview` | `{ threadId, runnerId, cwd?, accountId? }` | `{ cwd?, accountId?, accounts: { id, provider, title, email? }[], leftBehind, problems, worktree?: true, clone?: string, cloneFrom?: string, previewId?: string, checksPreview?: true }`: T's guess for the folder and login (or for Mike's `cwd` and `accountId`, to check them), its logins of the thread's provider to pick from, what won't come at either end (`moves.describe` adds the thread's own runner's, and `sourceChecked: true` says it did: without that, an empty `leftBehind` means nothing), and what stops it (empty when it can move: no folder or login for it, the experiment off on a T from before 12 Nov, a worktree thread's repo there with no worktree patch, T not answering). `worktree`: a new worktree of its own in `cwd`'s repo; `clone`: that repo is cloned there first, from `cloneFrom`. `previewId`: the main Mac's runner's one-use id for this look, when nothing stops the move (Preview binding). Nothing is made or started. The thread is described by the runner that has it (here, or a `moves.describe` call to it), then planned by T (here, or a `moves.preview` call with that description). Both calls are on the relay's allow-list from backend API 65, owner only, and checked again on the runner. Failures come back in `problems`, not as an error |
| `threads.move` | `{ threadId, runnerId, cwd?, accountId?, previewId? }` | `{ moveId }`. `previewId` is a `threads.movePreview` answer's, asked with the same `cwd` and `accountId`: the move does what it showed or nothing. Without one the runner looks itself first (Preview binding). `-32602` with the reason when it can't start (the runner offline, a move already going, a used or stale `previewId`, a problem, or a clone without one) |
| `threads.moveCancel` | `{ threadId, moveId? }` | `{}`. `-32602` once the move is past `packing`. `moveId` (a `threads.move` answer's): that move is cancelled by its id, and `-32602` if it's already over, so a cancel that arrives late can't stop a newer one; without it, whichever this runner sees under way. A runner from before 18 Nov ignores `moveId` |

What a tampered runner key can do: as T, it only ever gets threads Mike
moved to it; as S, only its own. It can't start a move, read another
move's chunks, or claim a move that isn't to it. A runner's name is its
own word, so `move_thread` and `tb move --to` pick the runner before
anything else (`pickRunner` in moves.ts: its id, its whole name, or a
word in only one runner's name; a word that's one's whole name and part
of another's picks neither), a thread that asks first shows that runner
on its card by name and id, and the move goes to that id, refused if
the runner has gone or changed its name since (`stillRunner`).

## Sync

The runner mirrors the phone's view of its threads to Threadbear's Convex
project (docs/convex-backend.md, shape A: the runner owns the state,
Convex mirrors it, the phone asks through it). It's best effort: nothing
the runner or the Mac app does waits on it, and the runner never reads
the mirror back as state. The Mac app doesn't use it.

- **On when** `runner.json` has `sync.url` (the deployment's
  `https://<name>.convex.cloud`) and `secrets/convex-key` (0600) holds the
  key the deployment's `RUNNER_KEY` was set to (the main Mac) or this
  runner's own runner key (any other; see Runner keys). `sync.enabled: false`
  turns it off; so does `THREADBEAR_SYNC=off` in the environment, which
  check.sh sets so no test runner writes to the real project.
  `THREADBEAR_SYNC_URL` points a dev or test runner at its own deployment.
  Every post carries the key, so the URL must be `https:`, or plain `http:`
  only to this machine (a local backend, tests), with no name or password
  in it (`runner/src/secure-url.ts`); one that isn't leaves sync off, with
  the reason as `sync.reason` and in the log, rather than falling back on
  runner.json's. Posts and uploads refuse redirects, as fetch would send a
  307's body, key and all, on to wherever it points.
  `sync.name` is what the phone calls this runner (default: the Mac's
  hostname without `.local` or `.localdomain`); `sync.runnerId` is made
  once and written back to `runner.json`, so a data dir stays one runner
  across releases. `sync.icon` names an SF Symbol for the runner in lists
  (default: worked out from the Mac's model, see `RunnerInfo`); the
  heartbeat carries it to a backend of API 11 or later, and
  `sync:runnersList` gives it back.
- **Threads.** One `threads` row per thread: `threadId, runnerId, title,
  cwd, accountId, provider, model?, status, needsYou, unread, preview,
  createdAt, lastActivityAt, snoozedUntil?, snoozedUntilRestart?,
  archivedAt?, starredAt?` (API 27; a starred thread that's hibernating
  stays in view `inbox`, so the phone has it without loading Hibernating),
  `wakeNote?` (API 49: what a hibernating thread waits for when it's more
  than a time, in a few words, from runner/src/wake-note.ts: "\"Convex
  I/O\" finishes", "you talk about woodworking", "the runner updates";
  the phone's and the website's rows put "Until …" before the place),
  `costUsd?` (to the cent), `projects?: { id, title }[]`,
  `working?` (the first unfinished background task's description),
  `pendingApproval?` (below), `earliestSeq?` (Messages, below), `share?` (see Sharing; API 8),
  `asks?` and `asksSeq?` (the open card, below; API 14), `next?` (below; API 14),
  `links?: { title, url, icon? }[]` (API 28: the thread's url actions,
  past their `when`, with only an SF Symbol `icon`, so the phone shows
  them and opens them itself) and `view` (`inbox`, `hibernating` or `den`,
  worked out the way the app's lists are). Nothing else from
  `ThreadSummary`: no `lastSeq`, context, panels, other actions, hooks or
  sub-agents, and never a tool result, diff or image (full sync, below, keeps those
  in a table of their own). A `thread.updated`
  whose phone view differs from the last one written marks the thread
  dirty; dirty threads are written together, at most once every 2
  seconds, 50 to a mutation. A change only to its preview or unread waits
  until 20 seconds after that row's last write, and goes with anything else
  that changes first. A `thread.deleted` removes the row and its messages.
  What's been written is remembered between starts as hashes
  (`sync-sent.json` in the data folder), so a start writes only what changed
  (comparing 20 seconds in, once patch links have loaded);
  every 3 days, with no such file, or when `sync:heartbeat` answers
  `firstSeen`, it writes everything and prunes (keeping the threads still
  finishing on the release that handed over). A start from the file
  removes, once it has settled, the rows the file has for threads that
  aren't here (deleted while sync was off), unless they're finishing on
  the release that handed over, and only after two minutes still missing,
  as a thread between releases isn't here for a few seconds. On every
  start, from the file or not, and every hour after, it asks
  `sync:sharedThreads` (API 60) which of its rows are shared by link, and
  removes any whose thread is gone (after the same two minutes) and writes
  again any it has stopped sharing, so a stop or a delete the mirror never
  got (a write lost after it landed, a crash) can't leave a link readable.
  A thread ever shared has its row written as soon as sync starts, settling
  or not, and a share change never waits for the settle. Until the mirror's
  row has the link the thread has now (written, not just sent: a write that
  failed or was left out doesn't count, and a row with a link counts as
  there from when it's sent), none of that thread's messages go
  up, by any path (a phone's page of earlier ones included), and its row is
  tried again every minute; its whole history goes once the row is there.
  `share:view` reads the
  row's share, so a message going first was readable through a link
  already stopped.
  Each write in flight is tracked as that write's own, so a flush that
  fails after its rows went never forgets another write's row on its way,
  and a row write that fails may have landed, so the next change to that
  thread is written even if it's back to what was sent before.
- **Messages.** Each persisted `user.message` and `assistant.text` goes
  up as a `messages` row (`threadId, seq, role, text, origin?, at`), text
  cut at 8,000 characters with a note; never a delta, with one row per tool
  call (`role: "tool"`, one line), and one per `system.note` with `login` or `savedMessage`,
  or that is a move to or from Hibernating or the archive (`isPlaceNote` in
  runner/src/place-notes.ts, the Mac's `is_place_note` list)
  (`role: "note"`, since backend API 78: a thread on another runner changed
  login and nothing on the Mac said so, 13 Nov 2026). `relay:remoteTail` and
  `relay:remoteMessages` give note rows to a runner that asks with
  `notes: true` (one from before API 78 would draw a note as a tool call),
  which plays them as `system.note` again. `phone:messages` gives them to an
  app that asks the same way (API 79: the iPhone app and the website draw
  them as the Mac does; one built before can't read the role). `phone:thread`,
  the phone's search and the shared page leave them out: a note names logins. A note a
  backend from before 78 couldn't take waits on the runner and goes up once
  it can. No other note goes up. The mirror keeps every one, and each
  thread's whole history goes up once per deployment. A start sends what's
  newer than the last one it wrote (`sync-sent.json`), or asks
  `sync:messageHeads` on a full write. The row's `earliestSeq` is the seq of
  the thread's first text message. A `page` command (an old phone's
  `loadEarlier`, with `beforeSeq`) marks up to 50 text messages before that
  seq as paged (`pagedAt`), so `phone:thread` shows them for a day.
- **Approvals.** An `approval.requested` puts `{ approvalId, kind:
  "approval", name, title, options, inputSummary?, reason? }` on the thread's row
  (`inputSummary` is one line: the command, the path, or the first string
  in the input, at most 200 characters, never the whole input; `reason`,
  from backend API 113, is the event's `reason`, scrubbed as that line is,
  which the phones, the website and another Mac's relay show under the
  title as the Mac does). A card that
  line can't show all of (a command over 160 characters or on more than one
  line, a command, path or address with anything but printable ASCII in
  it, as anything else can draw differently from how a shell reads it
  (U+2028, bidi and zero-width characters, Hebrew or Arabic letters, a
  no-break space, wide characters: `REMOTE_LINE` in runner/src/tools.ts;
  the Mac's own card writes controls and format characters out by name, as
  `⟨U+2028⟩`), a path or address over 160 characters or with spaces at its
  ends, a Codex patch to more than one file or asking to write under a
  folder, in another folder or asking for the network, one scrubbing
  changed (checked again as the row goes up, after any value found since),
  an MCP tool with more than one short thing to read, any file edit (it
  shows only its path there, and Allow writes all of it), a threadbear tool's own card, Codex asking for more access) has
  only its non-allow options there, and its title names the runner whose
  app can allow it ("only the Threadbear app on bruce can allow it"); the runner
  refuses an allow or allowAlways that comes through the backend for one
  (Daybreak, 7 Nov 2026). Such a card goes up only on a runner with an
  app of its own: one connected now, or one that was in the last 14 days
  (`<home>/app-seen.json`, written on an app's hello and as it goes,
  `runner/src/app-seen.ts`). Elsewhere (a runner nobody runs an app on)
  it could only be denied, so no card is put up: the call is denied at
  once (`ToolApprovalAnswer.noApp`), a `system.note` says "Not asked:
  ...", and the agent is told to do it a way that doesn't need the OK.
  A plan's card (ExitPlanMode) still goes up, as it's also where a plan
  is sent back to be revised; a
  `question.requested` puts `{ approvalId, kind: "question", questions }`.
  `approval.resolved`, or the thread no longer waiting, takes it off.
- **End-of-turn cards** (API 14, 30 Oct 2026). The open card of asks
  (see Needs you) goes on the row as `asks` and `asksSeq`, each ask
  without `where` and with only its `http(s)` links, as the phone can't
  open a file on the Mac. While a thread is idle on a turn that said it
  needs `nothing`, `next` is that `turn.completed`'s follow-ups. An
  `assistant.text` with `summary: true` goes up with `summary: true`, so
  the phone can pick a turn's reply as the Mac does and fold the rest of
  the turn into one "Worked for" line. A `send` command may carry
  `answers` (`AskAnswer[]`), passed to `threads.send`. A backend older
  than 14 gets the rows and messages without them.
- **Projects, schedules, accounts.** Each `projects.updated`,
  `schedules.updated` and `accounts.updated` replaces that runner's rows
  of the table with the whole list (schedules only while they're the
  runner's own file: once they live in the backend, see Schedules,
  "Runners", the runner writes them there directly and these mirrored rows
  are gone) (`Project` with its icon as `icon: {
  symbol?, picture?, by }`, `picture` naming the runner's copy of the
  picture, the file name without its extension; `Schedule` without effort
  and permission mode; `Account` as `id, provider, title, note?, email?,
  plan?, defaultModel?, usage?`, never `configDir`; from backend API 90
  also `loginEndsAt?`, `signedOut?` and `yearToken?` (`{ madeAt? }`), for
  the Runners panel's logins; from backend API 104 also `resetHint?` and
  `usage.resets` (with its `readAt`), so another runner, the phone and the
  website see a Codex login's resets and the hint to use one; from backend API 20
  also `models?` (each `id, title, effortLevels?, defaultEffort?`) and
  `defaultEffort?`, for the phone's new thread pickers). The same at start,
  and the accounts again once a heartbeat first says the backend is at 20.
  From backend API 48 each project also has a small row in `projectHeads`
  (no goals, state, notes or folders), written only when what it holds
  changes apart from `updatedAt`, which `phone:projects` reads. Every project
  from before is copied there on the first heartbeat any runner sends, once
  (`backendMarks`); until then `phone:projects` reads `projects`.
  `sync:sharedUsage` takes the caller's `runnerId` and doesn't read that
  runner's rows, so it doesn't re-run for the runner's own writes.
- **Project pictures** (backend API 5). A project's picture goes to the
  deployment's file storage so the phone can show it: the runner asks
  `sync:projectIcons` once for what the mirror has, and for each project
  whose `picture` is new or changed gets an upload URL
  (`sync:iconUploadUrl`), POSTs the bytes and records the storage id
  against the project (`sync:setProjectIcon`), which replaces and deletes
  the old file. PNG, JPEG and WebP go as they are (at most 256 px, as
  the runner stores them); an SVG is drawn to a 256 px PNG with Quick
  Look first, since the phone can't draw SVG. A picture that can't be
  read is skipped with a warning and tried again when the projects next
  change. `sync:setProjects` drops the picture of a project that's gone
  or has a symbol now. Only once a heartbeat has said the backend is at
  API 5 or later; an older backend gets the project rows alone.
- **Runner.** A `runners` row for this runner (`runnerId, name, version,
  release?, startedAt, draining, threadCount, lastSeenAt`), written once a
  minute. On start every thread is written once and rows of this runner
  for threads it no longer has are pruned. A stop for good (not a restart
  or a handover) sets `lastSeenAt` to 0 so the phone shows it offline at
  once; a draining runner just stops, and the new release writes
  everything again under the same `runnerId`.
- **Runner figures** (API 45). While the website's Runners view is open it calls
  `phone:watchRunners` every 30 seconds, keeping a time in the future in
  `runnerWatch`. Each runner subscribes to that (`sync:runnerWatch`), and while
  it's in the future sends its machine's CPU, memory and disk every 10 seconds
  to a row of its own (`sync:setRunnerStats`; `runner/src/runner-stats.ts`).
  The Mac app's runner details do the same through the main Mac's runner
  (API 46, `runners.stats`): `sync:watchRunnersFromMac` and
  `sync:runnerStatsList`, owner key only. With nobody looking nothing's written. The heartbeat carries only `pressure`
  (`memory` or `disk`, looked for every 5 minutes), which rarely changes, as
  every phone's runner list re-runs when that row does.
- **Commands.** The phone's mutations (`convex/phone.ts`) add a row to
  `commands` for a runner (`runnerId`, or `"any"`). The runner holds a
  live query on its pending commands over the Convex client's WebSocket
  (it reconnects by itself; and after a pause the process didn't see, a
  wall-clock jump of more than 15 s between its 2-second ticks, such as a
  Mac waking from sleep or a box resumed, the runner drops that client and
  makes a new one with every live query on it at once, then heartbeats,
  at most once in 30 s: `runner/src/clock-jump.ts`, `reconnectNow` in
  `sync.ts`), and for each one: takes it
  (`sync:takeCommand`, which says no if it was already taken; from
  backend API 85 the runner passes `attempt`, its own id for the take, and
  the same attempt asking again after an error gets yes, so a take whose
  answer was lost runs rather than being dropped), applies
  it through the same methods the app's RPCs use (one about a thread a
  draining runner still has goes to that runner, as the app's would),
  then finishes it with
  the outcome and, for a `create` or `quickAsk`, the new thread's id
  (from API 85 a finish changes only a taken command, so a repeated or
  late one can't change how it ended, and a command taken 3 hours ago with
  no finish shows as `failed`, "Its runner never said how it went.", which
  its runner's late finish still settles; it's never handed out again). `send` and
  `create` give the `user.message` `origin: "phone"`. A `create` can name
  `accountId`, `model` and (backend API 20) `effort`, checked as
  `threads.create` checks them; an effort that isn't a level is dropped. Either can carry
  `images: { storageId, url }[]` (backend API 18), photos the phone put in
  file storage (`phone:imageUploadUrl`), when `text` may be empty: the
  runner fetches each, sends it as an ordinary `ImageRef`, and
  `sync:finishCommand` deletes them from storage, whether or not the send
  worked. The phone uploads a photo as soon as it's picked, so one that's
  never sent goes back with `phone:discardImage` (backend API 25). Since
  7 Nov 2026 the upload URL is the deployment's own `/phone/upload` with a
  one-use ticket, which records the photo as that phone token's
  (`phoneUploads`): a command takes only its own token's photos,
  `discardImage` deletes only those (and not one still in a waiting
  command), and one never sent is deleted after a day. A token gets 60
  upload URLs an hour, 300 and 300 MB a day, 10 MB a photo. The phone's text can place its photos with `[Picture N]`
  markers, in `images`' order (Pictures in a message). A message row with
  pictures no marker places gets a `[1 picture]` line, as the pictures
  themselves stay on the Mac; the ones a marker places show as chips. `update` takes one
  of `{ snooze: { until?, untilRestart? } }`, `{ wake }`, `{ archive, verdict? }` (`verdict` from API 42),
  `{ unarchive }`, `{ markSeen }`, `{ title }` or `{ star: boolean }` (API 27); `respond` is
  `approvals.respond`'s decision, message and answers; `page` is
  `{ beforeSeq }` (above). `quickAsk` (backend API 10) is
  `{ question, answer, sources: { title, url }[], askedAt }`: a quick
  ask the phone already answered out loud (from Agent Archive's
  `/api/quick/ask`, straight over Tailscale), kept as a thread so Mike
  can carry on in it. The runner makes a thread as a `create` with no
  `cwd` would (the default folder, never a worktree, the login and model
  a new thread gets) but runs no turn: it writes the question as a
  `user.message` with `origin: "phone"`, `turn.started`, the answer as an
  `assistant.text` (the sources after it as markdown links), a
  `system.note` "Answered by Ask from Agent Archive" and a
  `turn.completed` (`completed`, `needs: "nothing"`), all under one
  `turnId`, and marks it seen, since Mike has heard it. The title comes
  from the question, then a model title with the answer as the reply.
  A spoken follow-up wants a quick reply, so the thread is set to Haiku when
  the runner has a Claude login, else GPT-6-Luna at low effort with a Codex
  login, else the account's default.
  The first message sent to it starts a fresh session with a handoff
  note saying the thread began as a quick ask that a fast model answered
  (see `threads.update` for the note). Like `create`, it finishes with
  the new thread's id. `interrupt` (API 44)
  stops the thread's turn, and `call` (API 44) runs one allow-listed method
  and finishes with its answer as `result`; both come only from the main
  Mac's runner (Other runners' threads through the backend). A failed command
  gets `state: "failed"` and a readable `note`. A draining runner takes
  no commands. Finished commands go after a day.
- **Failures.** A write that fails is kept and tried again after 5
  seconds, doubling to 5 minutes, with one log line per distinct error;
  a newer state for the same thread replaces the one waiting. Rows are
  current state, so a long outage costs one write per changed thread
  when it's back.
- **Secrets.** Every mutation goes through the runner's scrubber on its way up
  (`ConvexSync.post`, `src/scrub.ts`), every free-text field at any depth, so a
  new field is covered without anyone remembering to: known values first
  (`src/secret-values.ts`), then the shape rules (`src/redaction.ts`). Identity
  fields aren't touched (`NOT_TEXT` there: ids, `key`, timestamps), the digests
  that decide what's changed are of the row before scrubbing, so a rule changing
  writes nothing by itself, and the runner's own copy never changes. A message
  or tool line is also scrubbed before it's cut short. A string whose check throws
  goes up as `HELD_BACK`, and `sync.scrub.failed` counts them. While the runner
  is still reading `.env` files, mutations other than the heartbeat wait, for up
  to a minute, then fail so the flush tries again; a folder that doesn't answer
  in 5 seconds is left for the next look and counted in `foldersUnread`. Backend API 47
  does the shape check again in every mutation that takes a runner's text, and
  on a command's `note` and a call's `result` (scrubbed as parsed JSON, so it stays
  JSON). A command's `args` are stored word for word only so they reach the runner
  intact, and are dropped when it's over, however it ended, keeping only `images`
  (`relay:queueCommand` skips the runner's scrubbing for the same reason). A
  question's `answers` may name it as
  scrubbed (`matchAnswers`). A schedule that lives in the backend comes back
  scrubbed, so one whose text holds a secret runs with `[REDACTED]`. Pictures
  aren't scrubbed. `src/withhold.ts` says which tool calls' output must never
  upload.
- **Full sync** (API 52, docs/archive/full-convex.md step 4). `sync.full: true` in
  `runner.json`, off by default and never offered (docs/archive/full-convex.md step 6); off, none of this runs. Each finished tool goes up
  as one `eventBodies` row under its call's seq, the same seq as its `messages` row
  (`sync:appendBodies`, at most 50 rows or about 512 KB a mutation, behind the
  mirror's own writes): `text`, `ok`, `truncated`, `input` and `diffs` as JSON text,
  `reasoning` from before it, `images` as a count. Reasoning with no tool after it
  goes under the next message's seq, or its own at the turn's end; nothing shows
  those yet. `src/withhold.ts`'s say-so, or a check that throws, makes the row
  `withheld` with nothing of the tool in it. Scrubbed then cut (`src/full-sync.ts`:
  96 KB of text, 48 KB of input, 64 KB of diffs, 32 KB of reasoning; `cut` says so),
  and scrubbed again in the mutation. Forward only: where each thread had got to is
  in `sync-sent.json` (`bodies`), and a start reads only threads past that, up to
  20,000 events, then goes on from now. It's sent again only after a lost reply, and
  an identical row writes nothing. `runner.status`'s `sync.full` is `{ bodies, bytes,
  withheld, unsent, pending, backendTooOld? }`, and `sync.use` is `{ sent, bodies, io,
  storage, since, warning? }`: bytes this runner sent in the last 30 days, the part
  that was tool output, and estimates of a month's I/O and of stored tool output
  against Convex's Free plan (`src/convex-use.ts`), with a `warning` (also a
  `runner.notice` on connect) past 70% of either limit unless `sync.usageWarning`
  is false. A runner can't read its team's real usage, so these are estimates of
  this runner alone. Reads: `phone:eventBody { token,
  threadId, seq }` and `sync:remoteBody { key, threadId, seq }` answer `null`, `{ state:
  "withheld", reason? }`, `{ state: "expired" }` or `{ state: "text", text, ok?, truncated?,
  input?, diffs?, reasoning?, images?, cut? }`, one query per opening, never live;
  `share:view` has none of it. `pruneBodies` deletes past 30 days, 100 rows every 15
  minutes. A runner key's rows count against `CAP.bodyBytes` (32 MB), oldest first.
- **A tool's picture** (API 52). `phone:requestPicture { token, threadId, seq, index }`
  queues a `picture` command for the thread's runner, which checks `sync.full` is on,
  the tool isn't withheld and `index` is one its result names in that thread's media
  folder, then uploads it (`sync:addHeldPicture`). `phone:heldPicture` has its URL for a
  day (`pruneFiles`). An older runner fails the command as unknown. A runner key's
  `addHeldPicture` is refused unless it has taken a `picture` command for that thread,
  seq and index and not finished it yet, so there are only as many as were asked for.
- **Status.** `runner.status` has `sync: { state: "off" | "ok" | "error",
  reason?, url?, runnerId?, name?, threads?, messages?, lastSyncAt?,
  lastError?, pending?, retryAt?, commands?: { state: "off" | "on" |
  "error", applied, failed, lastError? }, scrub?: { rulesVersion, knownValues,
  foldersUnread?, changed, failed, lastFailure?, backendChecks? } }`, and `secretCheck: { state:
  "off" | "unsupported" | "unavailable" | "on", reason?, since, checkedText,
  checkedImages, flaggedText, flaggedImages, errors, rulesAndModel, rulesOnly,
  lastRunAt?, skippedOnBattery?, file? }` (`reason` says why it's off;
  `threads` and `messages` are rows written since start; `pending`
  changes waiting), and `tb status` prints it as one line.
- **Convex side.** `convex/` at the repo root (schema, `sync.ts` for the
  runner's mutations and the command queue, `phone.ts` for the phone's
  queries and mutations, `tokens.ts` for phone tokens, `crons.ts` for
  pruning). The phone's API is in docs/convex-backend.md.

## Devices

The phones and browsers that read the mirror (Sync) each hold a phone
token (`convex/tokens.ts`): only its SHA-256 is kept, under a name, a
kind and an expiry, so each can be listed and revoked on its own. The
Settings window's Phone & browser tab issues them through the runner,
so nobody needs the Convex CLI (`ios/scripts/pair-qr.swift` and
`web/scripts/sign-in.swift` still work from a terminal).
The website address is `sync.site` in runner.json when set, including a
custom HTTP Actions domain; otherwise it is `sync.url` with `.convex.cloud`
changed to `.convex.site`. The terminal browser sign-in uses the same rule.
The phone's pairing address stays the Convex API URL (`sync.url`).
Website addresses must be HTTPS, or HTTP on loopback, without userinfo,
query, fragment, embedded whitespace, commas or semicolons. Hostnames and
default ports are normalized and trailing slashes removed. An invalid
configured site prevents browser sign-in before any code is issued; sync
continues using its API address. A blank site uses the cloud twin.

```ts
type Device = {
  id: string               // the token's row id, for devices.revoke
  kind: "phone" | "browser"
  name: string             // "iPhone", "Chrome": what the app called it when pairing
  createdAt: string
  expiresAt: string
  expired: boolean
}
```

- `devices.pair` for a browser asks the backend for a one-use sign-in
  code (`sync:issuePairingCode` with `kind: "browser"`, API 81; one use,
  ten minutes, only its SHA-256 kept) and hands the app the website's
  sign-in link, `<site>/#code=<tbp_…>`, which the app opens in the default
  browser. The `#fragment` never reaches a server; the site trades the
  code for the browser's token with `tokens:claim({ code })` and wipes it
  from the address bar. The link used to carry the browser's token itself
  (`#token=`), good for 90 days wherever the link was seen (copied,
  synced, in history, offered to another app); the site no longer keeps
  one from a link, and `sync:issueToken` refuses `kind: "browser"` too, so
  an older runner says to update. For a phone it asks for a pairing code instead
  (`sync:issuePairingCode`, API 80): one use, good for ten minutes, with
  only its SHA-256 kept. `pairingLink` is then the text the app draws as
  a QR code: `TBPAIR1_` and the base64url (no padding) of
  `url=<sync.url>&code=<tbp_…>&key=<runnerId>:<key>`. It's no link, so
  no app on the phone can claim it and the Camera opens nothing with it;
  the phone app's own scanner reads it and trades the code for the
  phone's token with `tokens:claim({ code })`, once (Daybreak finding
  127, 15 Nov 2026: the code used to be a `threadbear://pair` link with
  the 90-day token in it, and any app can register that scheme). The
  phone's token is made at the trade, so it shows in `devices.list` from
  then; the reply's `device` stands for it until then, with the code's
  id. A backend older than 80 has no pairing codes, and a phone doesn't
  pair (`-32000`, the backend deploys with the runner's next update)
  rather than getting a token in its QR code. The token and the code are
  in that reply and nowhere else: the runner never logs them, never
  writes them to disk, and no `tb` command prints them, since a thread's
  transcript can command agents. The app shows the QR code or opens the
  link, then forgets it. The phone apps no longer take an older runner's
  `threadbear://pair?url=…&token=…` from anywhere (that token may already
  have reached another app), and the backend's `sync:issueToken` refuses
  `kind: "phone"`, so an older runner can't make one: it says to update.
- A backend on this Mac only (`sync.url` on loopback: `setup
  --self-hosted --local`, docs/self-hosting.md) can't pair a phone:
  `devices.pair` with `kind: "phone"` is `-32000` saying why, before any
  token is issued. A browser still signs in, at the loopback `sync.site`.
  The app reads the same from `runner.status`'s `sync.url` and shows the
  reason in place of the button.
- `devices.list` is the backend's live list (`sync:listTokens`), never
  revoked ones; expired ones stay until revoked, so the list says why a
  phone stopped working. Nothing is cached in the runner.
- `devices.revoke` marks the token revoked (`sync:revokeToken`); the
  phone's or browser's next call fails as unauthorised and it shows its
  pairing or sign-in screen. The phone's push registration goes with it,
  so it gets no more notifications (`convex/tokens.ts`).
- With sync off, `devices.list` returns no devices and `reason` (the
  same as `runner.status`'s `sync.reason`), and `pair` and `revoke` are
  `-32000` with that reason. A backend older than API 6 has none of these
  functions: `pair`, `list` and `revoke` are `-32000` saying the backend
  deploys with the runner's next update.
