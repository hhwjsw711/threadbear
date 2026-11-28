# What Threadbear does on your Mac

Everything Threadbear installs, runs in the background, reads, and talks to
over the network. It's here so you, or the agent installing it for you, can
check the code against it before running anything. If the code does
something that isn't on this list, treat that as a problem and say so.
File references are where to look.

With the optional `coordinators` experiment on (`runner/src/coordinators.ts`),
each project coordinator uses an ordinary CLI session on any supported provider
and pool, and delegates work to hidden runner-managed helper sessions (kept out
of the inbox and readable from Activity). It keeps a durable registry in
`coordinators.json`, completed work archived in `coordinator-history.jsonl`, and
its working folder under `coordinators/<project id>/` in the runner data folder.
Shared project prose remains in `projects.json`. Helper transcripts stay in
normal thread storage hidden from lists and sync; work records retain the brief,
helper identity and latest result without copying every helper transcript into
each wake.

Project-thread completions and literal keyword matches are batched for ten
minutes. A coordinator may also set a one-shot wake time. Failed delivery waits
a minute before retrying. A helper's result is saved in the same write as its
run's end and kept until the coordinator's turn that reads it finishes, not
just until that turn starts: a crash, restart or pause that cuts the turn off
sends it again, marked as possibly repeated. Report retries keep their own
one-minute timer, apart from the event batch. There is no polling model heartbeat. After fifty
idle minutes, at a safe boundary with no helper running, a context over 100,000
tokens is compacted; over 150,000 tokens triggers a safe-boundary compaction
sooner. These are experimental thresholds, not a guarantee about cache lifetime.
Pause or turning the experiment off stops the coordinator CLI and its helpers.
No new external source is polled by this experiment. Coordinator identity is
mirrored through the existing Convex sync; its private work registry stays on
the owning runner.

With **Publish HTML previews** on, opening a local HTML preview in the desktop
app asks the local owner runner to upload that one file (UTF-8, up to 10 MB)
to your own Convex deployment's file storage, along with its title, SHA-256
digest, and a hash of its path (never the path itself). New uploads start as
**Private** so only a browser signed in to Threadbear can open them (using a
one-use HttpOnly ticket cookie via `POST /a/auth`); switching to **Anyone with
link** makes the URL public. No files beside the HTML are uploaded. Visiting
the link serves only the uploaded file in an opaque sandbox isolated from
Threadbear's sign-in, with background requests, subresources and forms blocked.
Removing the web copy deletes the row and its stored file.

## What setup and install add

Tool-result image copies use owner-private `threadbear-tool-image-*` folders
under the system temporary folder, removed after success or failure. Base64
images use private temporary files beside their final media files. Pictures
converted to PNG use `sips` on macOS (including a dimension-only query),
ImageMagick on Linux or Windows imaging, with bounded dimensions and bytes.
Subagent reads cache parsed output in memory, at most 32 MiB in all. Separate
per-thread import history keeps at most 1,024 image attempts and charges at most
1 GiB of decoded import work until the runner restarts, so evicting parsed
output cannot renew image work. Rejected oversized output imports no images.

- **Git remotes** (`scripts/setup.mjs`, "Your copy"): Mike's repo becomes
  `upstream`. If `gh` is logged in and you cloned rather than forked, setup
  forks the repo to your GitHub account (`gh repo fork --remote`).
- **Packages:** `npm ci` in the repo, in `runner/`, and in each runner
  release. esbuild and fsevents have install scripts.
- **Convex, in your own account:** a login (`~/.convex/config.json`), a
  project with a production deployment, a deploy key, and one environment
  variable (`RUNNER_KEY`). It deploys `convex/` and the `web/` site there.
  A second Mac set up with `--existing` gets none of these: its runner's
  key comes from your first Mac (`tb runner add`), which also writes the
  deployment's address into its `runner.json`.
  If that login goes missing or expires, the Convex panel's Sign in to
  Convex button runs `convex login` again from the runner, which writes
  the same file; you approve it in your browser on auth.convex.dev.
- **Or a self-hosted backend** (`setup --self-hosted`, docs/self-hosting.md;
  Convex cloud is the one we recommend): no Convex login or deploy key.
  Instead two Docker containers, `threadbear-convex` (Convex's open source
  backend) and `threadbear-convex-dashboard`, from
  `ghcr.io/convex/*` images pinned by digest (`scripts/self-hosted-plan.mjs`), with the data in the Docker volume
  `threadbear-convex-data`. They listen on this Mac's loopback only
  (ports 13210, 13211 and 16791), and `tailscale serve` puts them on your
  tailnet as `https://<this Mac>.<tailnet>.ts.net` ports 3210 (the API),
  3211 (the website) and 6791 (the dashboard), so nothing is reachable off
  your tailnet. The backend's admin key is in
  `secrets/convex-self-hosted.env`, and setup sets `PUSH_RELAY=off` on it,
  as the push relay only works with Convex cloud. runner.json gets
  `sync.site`, the website's address. With `--local` there's no
  `tailscale serve` at all: the three stay on 127.0.0.1, the API and the
  website on 13210 and 13211 inside the container as well as out, and
  only this Mac can reach them. Once setup has put them on the tailnet it
  leaves a note, `self-hosted-on-tailnet` in the data folder (the default one, whatever `--home` says, as the containers are the Mac's), so a later
  `--local` run won't finish until it has seen every one of those ports
  taken off again; it deletes the note then. With `--url`, setup keeps
  the addresses you gave it in `self-hosted-own-addresses.json` there
  (the same default folder), as a move off does with the old ones it
  finds in runner.json, so a later `--local` or `--tailnet` run asks
  each of them, from this Mac, whether it still reaches the backend through
  your proxy, and stops if one does. Setup never deletes it, as from this
  Mac it can't prove your proxy is gone: delete it yourself once those
  addresses are gone for good, and setup stops asking.
- **Apps:** `~/Applications/Threadbear GPUI.app` (the Mac app, which
  `./threadbear setup` builds and installs with
  `desktop/scripts/switch-from-swift.sh`) and
  `~/Applications/Threadbear Runner.app`, both built and signed on your Mac.
  A Mac set up before 18 Nov 2026 has the old Swift app instead,
  `~/Applications/Threadbear.app`, until you press its Start using the new
  app (or run `desktop/scripts/install-app.sh`). The new app keeps its window and panel layout in `desktop-settings.json` and
  `gpui-prefs.json` in the data folder (with the local pages you chose
  Run them for, a digest of each), what a click on a link in a reply
  does (its menu's Default) and the kinds of file you said always open in their app in `desktop-links.json` there, the side pane's
  folded headings in `desktop-highlights.json`, and how it shows files and
  folders (Preview or Markdown, list or icons, the sort, hidden files) in
  `desktop-files.json`, the section and file or folder each thread's pane
  was left on (its last 300 threads) in `desktop-pane.json`, and the deployment each Convex panel shows in
  `desktop-web-panels.json`. Every file it writes there (those, and its
  drafts, review drafts, crash and hang records) is readable by your account
  only from the moment it's made (`desktop/core/src/private_file.rs`). Both apps claim `threadbear://` links (BrowserBear's
  Open thread pill), so install-app.sh makes the GPUI app the one macOS opens
  them with (`--keep-links` leaves them where they are), and
  `desktop/scripts/thread-links.sh swift` gives them back to the Swift app.
- **Rust, for building the Mac app** (`./threadbear setup` runs
  `desktop/scripts/switch-from-swift.sh`, and so does the thread the old
  Swift app's Start using the new app starts; that thread is an agent on
  your own login, so it uses your Claude or Codex tokens like any other
  thread): the new app is built on your Mac from your checkout's `main` with the
  exact Rust `rust-toolchain.toml` pins, fetched by the build itself
  (`desktop/scripts/pinned-cargo.sh`): its three parts (rustc, cargo and
  the standard library) are downloaded once from `https://static.rust-lang.org`
  and unpacked only if each one's SHA-256 matches
  `desktop/scripts/rust-toolchain.pins`, into
  `~/Library/Caches/Threadbear/rust` (about 1 GB). It never installs or
  uses rustup, and doesn't touch `~/.cargo`, `~/.rustup` or your
  shell's startup files). The build runs at background priority, takes
  20 to 40 minutes the first time (31 on a test Mac with no Rust, 15 Nov
  2026), and keeps about 2.3 GB in
  `~/Library/Caches/Threadbear/update-desktop`, which its updates reuse. It
  checks there's room for all that before it starts. Its
  output is in setup's terminal, or that thread. Deleting
  `~/Library/Caches/Threadbear/rust` takes that Rust off again.
- **The GPUI app's web runtime, only if you install it** (its Install web
  runtime button, or Settings > General > Web runtime; nothing is fetched
  until you press one): Chromium, as CEF's official minimal build 156.0.31,
  downloaded once from Spotify's CEF builds (135 MB, checked against the
  size and hashes pinned in `desktop/core/src/web_runtime.rs` before
  anything is unpacked), into
  `~/Library/Application Support/Threadbear/web-runtime/` (about 330 MB):
  the framework and five small "Threadbear Helper" apps beside it, copies
  of the GPUI app's own `threadbear-web-helper`, in `Threadbear
  Web.bundle` in a folder named for the build; `profile/`, Chromium's own
  folder, where the web panels' sign-ins and site storage are kept between
  launches (its cookies aren't locked with a Keychain key, as Chromium
  would otherwise ask the Keychain for one: like the Swift app's WebKit
  storage, they're protected by your account's file permissions); and
  `web-runtime.log`, Chromium's warnings. The download goes through
  `download/` and is deleted once it's unpacked. Chromium runs inside the
  GPUI app's own process, started the first time something needs it, and
  its helpers as child processes of the app (its renderers, GPU and network
  processes), all stopping when the app quits. Its own process sandbox is
  off for now, as it only covers a runtime inside the app's bundle
  (`desktop/web/src/mac/host.rs`). Removing the `web-runtime` folder
  uninstalls it. The pictures it draws of ```` ```mermaid ```` and
  ```` ```html ```` blocks go in `~/Library/Caches/Threadbear/rich`, the
  same files, under the same names, as the Mac app's (below), so a block
  either app has drawn shows straight away in the other. Diagrams use the
  Pele bundled with the app, as the Mac app's do.
- **A LaunchAgent:** `~/Library/LaunchAgents/com.mikerosoft.threadbear.runner.plist`,
  which keeps the runner going while you're logged in. A runner on a Linux
  server (INSTALL.md, section 6) has a systemd user service in its place,
  `~/.config/systemd/user/com.mikerosoft.threadbear.runner.service`, and no
  apps; it converts pictures with ImageMagick and rsvg-convert, and reads
  the account's full name from `getent passwd` rather than `id -F`.
  A runner on Windows (INSTALL.md, section 7) has a Scheduled Task in its
  place, in Task Scheduler's Threadbear folder (`\Threadbear\<label>
  (<user>)`, at logon, for that user only, no admin rights), which runs
  `conhost.exe --headless` with Node and `<data folder>\runner\launch.mjs`
  so no window shows; its data folder is `%LOCALAPPDATA%\Threadbear`, with
  the task's definition as `runner\task.xml` and `bin\tb.cmd`, whose folder
  goes on the user's PATH (`runner/scripts/install-windows.mjs`). In place
  of `lsof` and `ps` it keeps one hidden `powershell.exe` running for its
  life (`runner/src/win32-helper.ps1`), which lists processes
  (`Get-CimInstance Win32_Process`) and finds who holds a connection
  (`Get-NetTCPConnection`). It also puts each CLI the runner starts in a
  Job Object of its own (`Local\threadbear-job-<random>`), with what the CLI
  had already started, gives the CLI a query-only handle to it, sets it to
  end what's in it when its last handle closes, and ends the job when the
  CLI exits, so nothing a thread started outlives it, as a CLI's process
  group does on a Mac. To see who's calling it also reads a connecting
  process's environment block from its memory (as a debugger does) and lists
  the Job Objects named `threadbear-job-*` in that process's session's
  object directory. Each start, before it writes its key there, that
  helper sets `secrets\`'s access list to you and SYSTEM only, inheriting
  nothing from `%LOCALAPPDATA%`, with everything already in it following, in
  place of the Mac's `chmod 700` (`runner/src/win-acl.ts`). The same
  helper reads how long since the keyboard or mouse was last used
  (`GetLastInputInfo`) and the battery (`GetSystemPowerStatus`), and keeps
  the computer from sleeping by itself while threads work
  (`SetThreadExecutionState`), in place of `ioreg`, `pmset` and
  `caffeinate` below. Pictures (a big pasted photo shrunk for the model, a
  HEIC paste, a phone still, a project icon) are converted by a hidden
  `powershell.exe` started for each, running `runner/src/win-image.ps1`
  with Windows' own imaging, in place of `sips`; SVG isn't drawn there.
- **A one-shot update job:** when the runner's LaunchAgent or
  Threadbear Runner.app is behind main (or you press Update it in the
  Updates panel after one failed), the runner
  writes `<data folder>/runner/reinstall/<label>.reinstall.plist` and
  loads it with `launchctl bootstrap` (it isn't in `~/Library/LaunchAgents`,
  so it never starts at login). The trusted installed-release helper verifies
  committed main into the private `<data folder>/runner/reinstall/source`
  snapshot, then runs only that snapshot's `runner/scripts/install-runner.sh
  --stage`, never the original dirty checkout. It builds a new Threadbear Runner.app
  beside the old one (`~/Applications/.Threadbear Runner.app.staged`) and
  rewrites the runner's own plist and launch.mjs without stopping
  anything (they take over at your next login, when launch.mjs moves the
  new app in), logging to
  `<data folder>/runner/reinstall.log`, and is left loaded but stopped
  until the next one replaces it. On Linux
  it's a transient `systemd-run --user` unit instead (`runner/src/reinstall.ts`).
- **Commands:** `~/.local/bin/threadbear`, a link into your clone (only where the old Swift app was installed with `app/install.sh`), and
  `~/.local/bin/tb`, a three-line script that runs the `tb` of the runner
  release this Mac runs (`runner/scripts/link-tb.sh`; it leaves a `tb` that
  isn't its own alone, and `install-runner.sh --uninstall` removes it).
- **Shells, when you open the Terminal (⌘J):** the app starts your login
  shell (`$SHELL`, else zsh) in a pseudo-terminal, one per thread you open
  it on, in that thread's folder. They're its own child processes: a
  thread's shell stops when the thread is archived or deleted, and all of
  them stop when the app quits (`app/Sources/Threadbear/Views/TerminalPanel.swift`).
  The GPUI app does the same (`desktop/gpui/src/terminal.rs`), starting it
  as `/usr/bin/env -u THREADBEAR_THREAD_ID ... $SHELL -l` so it never
  inherits a thread's id, with a reader thread per shell; a program in it
  can put text on the clipboard (OSC 52) but not read it. Clicking a Terminal
  file link reads the OS hostname to recognize a link to this same machine;
  it does not look it up on the network. Links go through the usual open gate.
- **The Mac’s text services:** the GPUI app keeps the current selected plain
  words in memory for AppKit’s Services menu and discards that snapshot when
  the window closes. Choosing Look Up, Translate, Writing Tools, Share or a
  Service hands those words to that system feature or the service you picked.
  Passwords, revealed secret fields and one-time-code fields are excluded. A
  returned edit is checked against the same field, selection and original words.
- **Display preferences:** the GPUI Mac app reads the system appearance,
  accent colour, Reduce Motion, Increase Contrast and 12/24-hour clock
  preference to draw its interface. These readings stay on this Mac.
- **Files:** the data folder `~/Library/Application Support/Threadbear`
  (threads, settings, `secrets/`, runner releases, the pinned release key
  `upstream-signers`, the Mac app's `app-drafts.json` and the GPUI app's
  `desktop-drafts.json`, what's typed but not sent in each message box and card's Something else box, so
  a quit or relaunch doesn't lose it, and
  `sync-sent.json`, hashes of what's already in your
  Convex mirror so a restart sends only what changed,
  `far-reports.json`, the threads this Mac's agents started on your other
  Macs and which thread here each one's replies go back to (ids, the last
  turn passed on and when, and the most access that thread may have when a
  reply reaches it), read from your Convex backend every 15 seconds
  while one is busy (every five minutes once it's quiet),
  `schedule-ceilings.json`, for each schedule here that sends to a thread,
  the most access that thread may have when a run reaches it (never sent
  to your backend), and `schedule-ceilings-since`, when this Mac first
  kept them, and
  `run/error-exits.json`, when the runner last restarted itself after an
  unexpected error (times only, so it can stop restarting after three in
  ten minutes),
  `sign-in-refusals.json`, the Claude logins a turn was lately refused on and
  when (ids and times), so pools still skip them after a restart,
  `shared-pools.json`, the last pools your Convex backend had, which every
  runner shares, so one starts with them while the backend can't be reached,
  `profiles/`, the last ten CPU profiles of the runner, made only when
  you run `tb profile` (code names and timings, no thread text),
  and `shortcuts.json`, the keyboard shortcuts you've changed in Settings >
  Keyboard, which the app reads and writes and never sends anywhere,
  `inbox-guess.jsonl`, only with the `inboxGuess` experiment on (off by
  default): a line for each guess at whether you needed to see a finished
  thread and for each thread you archive, with a model's one-sentence
  reason, and with `quietInboxMine` on as well, for each thread it archived
  for you and each you brought back with "Should have shown me", which
  stays on this Mac,
  `schedule-runs/`, schedule runs your Convex backend hasn't been told
  of yet, a file each, kept only until it has, `activity/`, the activity
  log, only while Keep an activity log is on in Settings > General (what
  you click, open, choose and send in the app, never what you type; a file
  a day, each deleted after 30 days, left out of Time Machine and never
  sent anywhere; the Mac app's `ActivityRecorder.swift` and the GPUI
  app's `desktop/gpui/src/activity.rs` write the same files), and
  with the standing instructions experiment on, `instructions.md`, which every
  agent is given, and `instructions.sig`, which says Settings saved it). In `secrets/`, `asked/` holds the answers you
  type into an agent's secret card, one owner-only file each with a small
  script beside it that prints it for `sudo -A`, removed after 24 hours,
  and `secret-box.key` is the key your phone seals those answers to;
  `made-deploy-keys` lists, by name, the deploy keys this Mac made (setup's
  and the Convex panel's), so `tb runner rotate-owner` can tell them from
  others;
  `convex-key` is this Mac's key for your Convex backend (the deployment's
  `RUNNER_KEY` on your first Mac, a runner key of its own on any other);
  `~/Library/Caches/Threadbear/update`;
  the GPUI app's `threadbear-paste-*` folders under the user's temporary
  folder (0700, with picture files owner-only), holding copies of dropped or pasted
  pictures until the runner imports them, then removed. A promise's partial
  copies and source folder are removed if receipt is cancelled or times out,
  even if the source app never replies. On macOS the app
  reads Photos' clipboard image data and promised files itself, while it has
  access, rather than asking the runner to open a Photos library path;
  if the app quits while a picture is loading, or crashes or is forced to quit,
  private temporary copies can remain.
  Another live app instance can own folders with the same prefix, so launching
  the app does not remove folders by name;
  `~/Library/Caches/Threadbear/drags` (a copy of a video you drag out of the
  side pane, so what you drop it on gets the file you were watching; a
  clone that takes no space where the disk can make one, cleared after a
  day);
  `~/Library/Caches/Threadbear/previews` (private, read-only snapshots of
  Office and iWork documents and PDF link hovers, so Quick Look reads the file the open gate
  checked; removed after the thumbnail is made, with interrupted copies
  cleared after a day when another preview is made);
  `~/Library/Caches/Threadbear/opened` (only for a file on a disk with no
  file references, like ExFAT or a network share), and on Windows and Linux
  `%LOCALAPPDATA%\Threadbear\opened` and `~/.cache/threadbear/opened`
  (private, read-only copies of documents and programs you open from a thread, so the app that opens one gets the file the open gate
  checked; cleared after a day when another is opened);
  `~/Library/Caches/Threadbear/prs`, and `~/.cache/threadbear/prs` on Linux
  (the last 200 GitHub pull requests the app read through gh, each as one JSON file with its description,
  comments, checks and diff, so one opened again shows at once while it's
  read again);
  `~/Library/Caches/Threadbear/rich` (pictures of the ```` ```mermaid ```` and
  ```` ```html ```` blocks in replies, and each one's page for the side pane,
  newest 900 files kept). They're drawn on this Mac in web views that load
  nothing from the network: the diagram library, [Pele](https://pele.run/),
  is bundled with the app (`shared/rich/pele.js` in the repo, MIT), and a block's
  page runs no scripts;
  `~/Library/Logs/threadbear-runner.log` and `threadbear-update.log`;
  `~/Library/Logs/Threadbear/hangs` (the last 10 times the app froze: if its
  main thread is stuck for 4 seconds it runs macOS's `sample` on itself, in
  a sandbox, and notes the main thread's priority, the Mac's load average
  and how long since the last keyboard or mouse input (just how long, never
  what); nothing else ever reads these). The installed GPUI app keeps its
  own the same way in `hangs/desktop` there (`desktop/gpui/src/hang_watch.rs`),
  and its own log in `desktop.log` there (the one before it in `.log.1`
  once that passes 2 MB): when the connection to the runner went and came
  back, requests the runner turned down or didn't answer, the runner's
  notices, and messages held while it restarted, by thread id and never
  their words (`desktop/client/src/log.rs`); on Windows that log is
  `%LOCALAPPDATA%\Threadbear\Logs\desktop.log`, with any panic's message
  in it too, as the app has no console window there (`desktop/gpui/src/app_log.rs`),
  and its last 10 panics in `~/Library/Logs/Threadbear/crashes/desktop`
  (the message with anything in quotes and any paths taken out, the file and
  line in Threadbear's code, and the names of the functions it was in), with
  `crash-reports-seen.json`, the names of macOS's own reports of its crashes
  (`~/Library/Logs/DiagnosticReports/threadbear-gpui-*.ips`) it has looked
  at: each launch reads the new ones of its own for the exception and the
  crashed thread's function names, and nothing else of them
  (`desktop/gpui/src/crash_reporting.rs`); and `~/ThreadbearThreads`, the default
  folder for new threads. A folder you open from a link in the side pane
  is listed, and watched for changes only while it's showing. On Windows,
  a picture that fails to load is retried after a second while it is visible,
  backing off to once a minute if it keeps failing,
  using the same local-file guard as its first attempt. macOS may
  ask for permission the first time that's somewhere like Documents. The runner also runs `vm_stat` and `sw_vers` on a Mac, or reads `/proc/meminfo` and `/etc/os-release` on Linux, for the memory and system figures in the website's Runners view and the Mac app's runner details (`runner/src/runner-stats.ts`), every 5 minutes and while either is open. It also runs `ps`, and `sample` (in a
  sandbox, through `sandbox-exec`) on a thread's own CLI, when a turn has been quiet for a minute,
  to tell a CLI frozen on a macOS prompt from a long job. The sample is a
  temp file, deleted straight after. Taking over from a draining runner
  older than 5 Nov 2026, it runs `lsof` on that runner's pid once, to check
  the connection it's about to send the token over is really that runner's.
  `mac-screen.json` in the data folder
  remembers what it's said about dialogs on the screen (below), and
  `app-seen.json` when a Threadbear app last connected to this runner, so
  a card only that app could allow isn't put up on a machine without one.

## What runs in the background

- **Landing work** (`runner/src/worktrees.ts`): `tb land` keeps an empty
  `threadbear-land.lock` in the repo's common git directory. It runs
  macOS's `lockf` (Linux's `flock`) with a small Node child to hold an OS
  lock from before rebasing until the check and fast-forward finish.
  Another landing waits; exiting, including a crash, releases the lock.
  Beside it, `threadbear-land-times.log` records how long each landing's
  check took (branch, commit, step times, no output), cut back at 1 MiB.
  In a repo with a GitHub workflow marked `# tb land: hold while red`
  (this one's `desktop.yml`), it runs your `gh` to ask GitHub how that
  workflow's last runs on main went, when the landing changes files it
  checks, to say in a line if it's red (`runner/src/land-gate.ts`), and
  for a cancelled run, its jobs and their annotations, to tell a timeout
  from a newer push. Nothing of the branch is sent. `tb red-watch` (run
  only by a schedule you set up) asks the same about every marked
  workflow and starts or messages a thread in that repo when one is red;
  what it knows is in `threadbear-land-gate/red-watch/` there.
  A landing waiting for the lock leaves a small JSON file in
  `threadbear-land-queue/` there (branch, worktree, commits, process id),
  removed when it's done, and the lock's holder keeps
  `threadbear-land-running.json` (what it's checking, since when, its
  process id and the queue entry ids) while its check runs. The waiting
  status checks whether that process is still alive.
  `threadbear-land-done/` there keeps, for a week, what
  landed for a landing whose `tb` was stopped before it heard.
  `tb land` runs the landing in a process of its own, so a time limit
  stopping the `tb` can't stop a check partway: it writes its output to a
  `tb-land-*` folder under `$TMPDIR`, deleted once the `tb` you ran has
  shown it (left for macOS to clear if that `tb` was stopped first).
  With no check host, the check's Rust builds (only when `desktop/`
  changed) run here through `desktop/scripts/shared-cargo/cargo`: it copies
  the worktree's files (not `node_modules` or build folders) into
  `~/.cache/threadbear-check/local-builds/shared-1/src` and builds into
  `shared-1/target` beside it, one warm target for every worktree, a few
  GB, holding `shared-1.lock` while it builds. Delete the folder to get the
  space back; the next check builds it again from cold.
  Every check (`./check.sh`, only in a checkout of Threadbear itself) keeps
  pass records in `~/Library/Caches/Threadbear/check-passes` on a Mac, or
  `~/.cache/threadbear/check-passes` (`$XDG_CACHE_HOME`) elsewhere: one
  small file per step or runner test file that passed, named by a hash of
  the files it read and holding when it passed, so the next check skips it
  (`scripts/check-cache.mjs`), and a `test-times` file of how long each
  runner test file took, so the next run starts the longest first
  (`runner/test/helpers/run-test-files.mjs`). Each record is deleted after a week. Off with
  `"checkPasses": false` in runner.json or `THREADBEAR_CHECK_PASSES=off`
  (for runs on a check host too); a check host keeps its own in
  `~/.cache/threadbear-check/passes` there.
- **Borrowed worktrees** (`runner/src/borrows.ts`): `borrow-worktree.sh`
  writes a small `threadbear-borrow` file in the borrowed worktree's git
  folder (the borrowing thread's id, a process id for a script's borrow,
  the time). Two minutes after the runner starts and then hourly, it looks
  at every repo its threads have had worktrees in, and takes back borrows
  nobody gave back: only clean ones with everything on main, nothing
  running in them (it lists processes' current folders with `lsof`, or
  `/proc` on Linux), and their borrower gone or a day unused. It locks one
  as a spare or removes it, and deletes its borrow branch. Before it lends
  a spare, `borrow-worktree.sh` reads the thread records in the runner's
  data dir (`threads/*/thread.json`, through `runner/src/lived-in.ts`) to
  pass over any slot an open thread works in.
- **Archived worktree sweep** (`runner/src/runner/worktrees.ts`): ten minutes
  after start and then daily, re-runs archive cleanup on archived threads
  whose worktree stayed (counting branches whose commits are already on
  `main` by patch id or merged tree). If a worktree still stays two days after
  its thread was archived, it starts a cleanup thread that removes safe
  leftovers automatically and archives itself, asking only about genuine
  unlanded work, tracking checked branch tips in `runner/worktree-question.json`.
- **The runner** listens on `127.0.0.1:8797` only, and needs a token
  (`runner/src/config.ts`). It starts the official `claude` and `codex`
  CLIs for your threads. Each thread's CLI gets a key of its own in its
  environment (`THREADBEAR_THREAD_KEY`), never the token. When something
  connects, the runner runs `lsof` and `ps` on that one connection to see
  which process it is and whether it's under a thread's CLI (on Linux it
  reads `/proc` instead of running `lsof`), and closes it if it can't tell
  (`runner/src/peer.ts`, docs/protocol/connection.md "Who's really calling").
  The runner also reads the environments of that process and the ones
  above it, up to its thread's CLI or, under none, all the way (`/bin/ps
  eww` and `/bin/ps -ww`, to leave the arguments out, or
  `/proc/<pid>/environ` on Linux), for another runner's thread, and reads
  its own parents' the same way once as it starts. It looks only for
  `THREADBEAR_THREAD_KEY` and `THREADBEAR_THREAD_ID` (and their old
  `THREADBARE_` names), keeps nothing from a connection's, and keeps the
  ones its own parents had (a dev runner's starting thread) in memory while
  it runs, taking them out of its own environment. On Windows its helper
  reads each such process's environment block from its memory (as a
  debugger does) and lists the Job Objects named `threadbear-job-*` in that
  process's session, to see which thread's job it's in.
  `tb runner` runs `/bin/ps` (or reads `/proc/<pid>/environ` on Linux) on
  its own parents to see whether it's in a thread's shell
  (`runner/src/tb-connect.ts`).
- **Whether each Claude login is signed in** (`runner/src/sign-in-state.ts`):
  when the runner starts, every 10 minutes, and after a turn the login
  refused, it runs `claude auth status --json` once per Claude login, in
  that login's own config folder. It reads only whether the login is signed
  in and when its sign-in ends. The CLI answers from its own files without
  going online, and the runner never reads the Keychain or the tokens.
- **Extra Codex logins share `~/.codex`** (`runner/src/codex-home-share.ts`):
  before each Codex thread starts on a login other than `~/.codex` itself
  (`codex-1`...), the runner links that login's `AGENTS.md`, `hooks.json`,
  `config.toml` and each of `skills/`'s folders to `~/.codex`'s, so the
  thread has your instructions, hooks, skills and MCP servers. It never
  replaces a file the login has of its own, except a `config.toml` holding
  only Codex's own project trust, which it renames to
  `config.toml.before-share-<date>` beside the link. `auth.json` and the
  login's sessions are left alone. The thread is also told, as config
  overrides, that the hooks you trusted in `~/.codex` are trusted there too.
  To know which, and where `~/.codex` keeps its sign-in (`config.toml` isn't
  linked if that's the Keychain), it starts `codex app-server` on `~/.codex`
  for a moment and asks (`config/read`, `hooks/list`; no thread, no model),
  again only when `~/.codex`'s `config.toml` or `hooks.json` changes.
- **A Claude login's year-long token, if you make one**
  (`runner/src/year-token.ts`, `desktop/core/src/claude_token.py`): Year-long
  token… on a Claude login's row in Usage opens Terminal on `claude
  setup-token` for that login, run by a small Python helper inside the app
  (`/usr/bin/python3`). It writes `threadbear-token.json` in that login's own
  folder (only you can read it), with the token and when it was made. The
  runner watches each Claude login's folder for that one file, so the row
  changes as soon as it's made, and reads it and gives the token to that login's Claude Code as
  `CLAUDE_CODE_OAUTH_TOKEN`, and to nothing else. Delete the file to go back
  to the login's normal sign-in. For a login on another of your machines
  (`runner/src/year-token-maker.ts`), only when you ask from the Runners
  panel on your main Mac: that machine's runner runs `claude setup-token`
  itself, under a small Python helper (`python3`) in a pseudo-terminal, and
  sends back through your Convex backend only the claude.ai page to approve
  it on and whether it worked. The code you paste goes the other way and is
  dropped from the backend once used. The helper writes the same file there;
  the token never leaves that machine. A year-long token goes somewhere
  else in two cases only: your own Convex backend, if you pick Use this
  Mac's token on a cloud token card (below), and another of your runners,
  if you switch on Use this Mac's Claude logins for it (next).
- **This Mac's Claude logins on another of your runners, if you switch it
  on** (`runner/src/login-share.ts`): Use this Mac's Claude logins on a
  runner's card in the Runners panel, on your main Mac. Its runner then
  reads the year-long token and `.claude.json` profile of each Claude login
  here that has a token (not hidden ones, ones with a note like "Convex work
  only", or ones only in pools tied to folders), asks that runner through
  your Convex backend for its public key, seals each login to it (X25519,
  HKDF-SHA256, AES-256-GCM) and sends them through the backend, which only
  ever holds the sealed bytes, and only until that runner has taken them.
  That runner opens them with the private key in its `secrets/` folder and
  makes a login folder for each in its data folder's `accounts/`
  (`claude-<n>`: the token file only you can read, a `.claude.json` that is
  its own with this login's profile, links to its own `~/.claude`'s
  `CLAUDE.md`, `settings.json` and `skills`, and a `threadbear-shared.json`
  marker). It sends again when a token here is made or renewed (looked at
  on every login change and every 10 minutes), and adds those emails to
  that runner's shared-logins list in your backend. Your main Mac keeps the
  switches in `login-share.json` in its data folder: which runners, when it
  last sent, how it went, and a digest of what was sent, never a token.
  Switched off, that runner removes the folders it made this way (the token
  deleted, the folder moved to `accounts/.removed/`), and never one you
  signed in there yourself. Only your main Mac's key can send these, and the
  runner checks so again.
- **A cloud token for virtual runners, if you make one** (the
  `virtualRunners` experiment, off unless you turn it on;
  `runner/src/virtual-runners.ts`, `runner/src/cloud-token-helper.py`): Make
  one on the card in a thread on a virtual runner has the runner run `claude
  setup-token` for that login with no window, through a small Python helper
  (`python3`, in a pseudo-terminal), which opens claude.ai in your browser to
  approve. The CLI gets its code back on a localhost callback, and the helper
  hands the token it printed to the runner, which sends it, over HTTPS, only
  to your Convex backend's `boxes:setCloudToken`, which keeps it sealed. It's
  never written to disk here or logged; the helper is stopped after 10
  minutes. Paste a token, or Use this Mac's token (that login's year-long
  token, above), send it the same way.
- **A pinned file being shown** (`desktop/gpui/src/highlights.rs`): if its
  Highlights request fails, the app retries after 1 second, then 2, then 4,
  up to 5 seconds between tries while you're looking at that thread. It
  stops retrying when you leave or the request goes away.
- **When OpenCode, Cursor or Grok's CLI is installed and logged in** it also starts the
  `opencode acp`, Cursor's `agent acp` and `grok agent --no-leader stdio` CLIs for threads on them, runs each
  with `--version` when the runner starts, and runs its own updater
  (`opencode upgrade`, `agent update`, `grok update`) only when you press Update in the app, and each
  live thread on one has a listener on `127.0.0.1` on a port the system picks,
  serving that thread's Threadbear tools, needing a random token made for it.
  Grok is started with `--plugin-dir <data dir>/grok-guard/threadbear-<random>`:
  a folder the runner makes for each start (and removes after a week),
  holding a PreToolUse hook that runs `guard-ask.mjs` (`guard-deny.mjs` for a
  small job) from `grok-guard` with the runner's own node before each of
  Grok's tool calls, so they come to you first, and a UserPromptSubmit hook
  (`seen.mjs`, which does nothing) whose running Grok reports, so a thread
  whose plugin didn't load is stopped. The guard reads
  `~/.grok/trusted_folders.toml` (`runner/src/adapters/acp/grok-guard.ts`).
- **When Google's antigravity-acp (Gemini) is set up and signed in**
  (`antigravityPath` in `runner.json`, or an `agy_acp_server.par` on your
  PATH, signed by Google), it starts that for threads on Gemini, runs
  `/usr/bin/codesign --verify` on it and the `localharness_external` beside
  it, and runs it with `--version` when the runner starts. Each session opens
  in an empty folder under your temp folder (`threadbear-acp-session-*`),
  removed when it ends, as Antigravity writes a `skills/` folder into the
  folder its session opens in. Threadbear never updates or downloads it.
  To show how much of your Google plan is left, it also starts it for a few
  seconds a minute after the runner starts, every 10 minutes after that and
  shortly after each Gemini turn (at most every 2 minutes), in an empty
  folder under your temp folder (`threadbear-acp-*`, removed after), and asks
  it `/usage`, which the server answers itself without a model turn
  (`runner/src/adapters/acp/agy-usage.ts`, `runner/src/limit-recheck.ts`).
- **New installs start threads on Auto.** On Auto, Claude runs with its
  safety check approving or blocking each action, and Codex asks before
  edits. An install set up before 9 Nov 2026 keeps starting threads on
  full access (Claude with `bypassPermissions`, Codex with
  `danger-full-access`). `"defaults": { "permissionMode": ... }` in
  `runner.json` (`"full"`, `"auto"` or `"ask"`) sets it, and each thread
  can pick its own. The threads the runner starts by itself (bringing in
  Mike's releases, fixing a failed update to main and rebuilding your
  changes to the old Mac app, all below, and a note about this Mac) start on that default too
  (`runner/src/own-threads.ts`); on Ask, or Codex's Auto, what they can't
  do without a yes waits on a card for you.
- **Your phone and browser can drive the Mac.** A paired iPhone or a
  signed-in browser can start threads in any folder, send messages and
  answer approvals, through your Convex deployment (`runner/src/sync.ts`).
  Those threads start on your default mode like any other (full access on
  an older install), and can be switched to full access from there, so
  treat a pairing like a login to the Mac, and so is admin access to your
  Convex deployment.
  Pairings last 90 days unless set otherwise, at most 365
  (`convex/tokens.ts`); Revoke in Settings › Phone & browser ends one.
- **Following your main** (`runner/src/update.ts`, `app/Sources/Threadbear/AppUpdate.swift`):
  the runner and the app watch your local `main`, and look again every 5
  minutes. Within seconds of it changing, they rebuild themselves from it
  and redeploy your backend, so whatever reaches your `main` runs, with no
  signature check; only Mike's release tags are signed (below). Turn it
  off for both with `followMain: false` in `runner.json` (ask any thread
  to; it left Settings on 2 Nov). Around each step of the runner's build
  it reads macOS's sleep count (`pmset -g stats`, which changes nothing),
  so a step that failed while the Mac slept is tried again later (up to
  three times for the same commit) rather than taken as a broken main.
  When the runner can't build your main or deploy your backend, it starts
  a thread by itself, on your default mode with your own Claude or Codex
  login, in the release's checkout (`runner/src/fix-update.ts`). That
  agent reads the output, fixes the cause, lands the fix on your `main`,
  watches the next build and archives itself once it goes through, so you
  only hear about it when it needs you (including a step its mode asks
  you about). A later failure goes to the same thread. On a machine that
  follows GitHub's main (below), it starts none: its heartbeat says which
  commit failed and the error's last lines, and your main Mac starts that
  thread itself, in its own checkout, once it finds the commit on its main.
  `followMain: false` turns this off with the rest.
  The GPUI app, once installed with `desktop/scripts/install-app.sh`,
  follows the `main` of the checkout it was installed from in the same way
  (`desktop/gpui/src/app_update.rs`): it reads main's `desktop/` tree with
  `git rev-parse` 20 seconds after it opens, every 5 minutes and within
  seconds of main changing. When that differs from what it runs, it waits
  until that tree has stayed the same for two minutes (`updateQuietMinutes`
  in `runner.json`), then runs `stage-update.sh` from its own bundle at the
  priority `jobPriority` says (`nice` unless it says otherwise;
  `desktop/scripts/stage-update.sh`). That clones the checkout into
  `~/Library/Caches/Threadbear/update-desktop`, and with `updateBuildHosts` in
  `runner.json` (never `checkHosts`), copies the clone's files (not its history) with rsync over
  ssh to the first of them that's a Mac, answers and is free, builds there under
  `~/.cache/threadbear-check/gpui` and copies the two binaries back with scp
  (`desktop/scripts/remote.sh`). Those folders must be the ssh account's own
  and closed to others, or it stops; one may be a symlink (to a bigger disk)
  only to a folder of that account's under folders only root or it can
  change (`scripts/own-folders.sh`). Remote commands and performance tools keep
  `~/.cache/threadbear-perf.lock` and `~/.cache/threadbear-check/lock` on the
  host while they run, waiting for other builds, checks and measurements.
  Everything goes in through `~/.cache/threadbear-check/gate` there first,
  checks included, so runs take their turn in line. A host with a number
  in `~/.cache/threadbear-check/builds-at-once` (written by hand on that
  host; Mike's Tinker Desk has 2) runs that many plain builds side by side
  (`remote.sh --build`, which the app's builds and `dev-app.sh` use), each
  holding one of the `~/.cache/threadbear-perf.lock.build-<n>` locks and
  the two above shared, and keeps as many shared build folders; anything
  else still has the host alone.
  Real-input test tools read process names with `ps` and, on macOS,
  executable paths through system Python's `ctypes` and `libproc`. They use
  those names to refuse input while an ffmpeg encoder is running.
  Automatic update builds go ahead of everything else waiting on the host,
  as a landing's check does: while one waits, it holds a lock on a file of
  its own in `~/.cache/threadbear-check/first` there, and other checks,
  builds and measurements (and Mike's `heavy` jobs on Tinker Desk) wait
  while such a file is locked, before they go in and again once they have
  (`scripts/host-turn.sh`, `scripts/perf-lock.pl`). It tries each trusted
  host without waiting, and with every one busy waits on the first for what
  is running there to end, then builds; a build already running finishes
  with both locks held. `THREADBEAR_UPDATE_QUEUE_AFTER` (seconds) has it
  try again at a later look instead until every host has been busy that
  long (`~/Library/Caches/Threadbear/update-desktop/deferred-since` holds
  when that began, and goes once a build runs). While a build runs or waits for a host,
  `~/Library/Caches/Threadbear/update-desktop/phase` holds one line saying
  whether it's waiting, queued (and behind how many runs) or building, and
  since when, which the app reads once a second for its Updates panel; it
  goes when the build ends. For threads waiting on the app to restart onto
  what they landed, the app also runs `git merge-base --is-ancestor` in the
  checkout, once each time those threads or its builds change, to say which
  build has each one's commit. The first has a note beside it
  (`threadbear-perf.lock.holder`: its pid, when
  it took the lock and what it's running) so a waiting run can say who it's
  waiting for. The holder deletes it when it finishes. Each waiting run keeps
  a file in `threadbear-perf.lock.waiting` until it gets the lock, so the
  others can say how many are queued ahead. An updater also checks the
  process start time, so a dead waiter's note whose pid has been reused
  cannot keep deferring updates. A deferred attempt removes its own helper
  folder on the host.
  Temporary wrappers under the run's temp folder background Cargo and Swift
  builds and are removed when the run ends. Performance runs register their
  process groups and start times in `~/.cache/threadbear-check/perf-children-*`
  until cleanup has stopped them. Registered processes also inherit an unlocked
  descriptor (197) for the registry's state file. Cleanup matches its device
  and inode through `lsof` on macOS or `/proc` on Linux to find terminal shells
  that outlived their app. It reads descriptor metadata, not process environments;
  command-line text does not count as ownership. Cleanup checks
  start times before signalling those processes and follows live ancestry for
  children that closed the descriptor. It repeats discovery until the lease's work
  stops, retaining both locks. A small sleeping process stays in each active
  group, keeping that group ID reserved even after its original
  process dies. Its PID and start time are recorded in `anchor-*` files in the
  same registry. It double-forks outside the worker's tree, holds no host lock
  or output pipe, and exits once its leader is gone and two snapshots find it
  alone. Before exiting it renames its record to `retired-*` under the
  registration gate, so reuse of that group number cannot block cleanup.
  Retirement records include the original leader start time; a new registration
  clears stale retirement and reuses an existing live holder when possible.
  It checks once a second, checking group membership every two seconds after the leader goes. It also exits if the reaper dies, with
  a start-time check every 30 seconds.
  Only a live matching anchor permits the final group kill; separate sessions
  need their descriptor or captured ancestry. The macOS descriptor probe avoids
  filesystem stats and has a two-second timeout (ten once cleanup has run
  for 30 seconds). A failed probe still allows registered work to stop
  but prevents unlocking, until the limit below. Same-user processes that
  hide their descriptors cannot be attributed after losing their ancestry.
  Every descriptor scan must also find the reaper's own close-on-exec control
  descriptor before it can declare cleanup complete. If an anchor disappears
  while its group is still active, cleanup keeps the locks rather than guess
  who owns that group.
  A cleanup still blocked after 30 seconds
  records its process IDs in `~/.cache/threadbear-check/perf-cleanup.log`
  and backs off, scanning at 1, 2, 4 and so on up to every 30 seconds instead
  of every 50 ms (33 stuck cleanups polling flat out took one Mac to a load of
  159, 20 Nov). It keeps the locks while any process it knows of is still
  running or any group's ownership is in doubt. When the only thing left is
  that the descriptor probe can't confirm the work is gone, and it has failed
  at least three times over 10 minutes (`THREADBEAR_PERF_REAP_LIMIT` seconds,
  0 for never, counted while the Mac is awake), cleanup checks every process
  and group it has known by pid rather than trusting one ps listing, then
  gives up: it logs that, removes its registry, exits with a failure and
  releases the locks. The one thing it can then miss is a process only the
  probe could find (its own process group or session, its parent gone) that
  no probe listed because the probe kept failing. The ps and lsof it starts don't
  inherit the locks. With `remote.sh --perf`, the shared warm
  target is `~/.cache/threadbear-check/gpui/perf-target`, kept out of ordinary
  cache eviction; other builds keep their own target. Source/target `.in-use`
  markers are renewed while a remote run waits and works. With update build hosts set but none
  answering it waits and tries again later, with only check hosts set it
  builds nothing and says so, and with neither it builds in that cache
  folder here. The new app is put together and signed here as
  `~/Applications/.Threadbear GPUI.app.next` and goes in when the app quits
  or restarts, the old one kept as `.Threadbear GPUI.app.old` until the next
  launch. The app restarts onto it by itself once nothing's typed and
  nothing's open that a restart would close (a menu, a dialog, a drag, a
  Terminal shell running something, a web panel used in the last minute):
  straight away while you're in another app, and with the app in front
  once you haven't touched the Mac for five seconds (it asks macOS how
  long since the last key, click or pointer move, nothing more). With its
  window on screen the restart is a handover: the new app is opened beside
  the old one (`open -n`), and the two pass three small files (ready, go,
  done) through a folder named for the old app's process,
  `$TMPDIR/threadbear-handover-<pid>`, deleted once it's over. It writes what it did and the build's output to
  `~/Library/Logs/threadbear-desktop-update.log` (the one before it in
  `.log.1` once that passes 2 MB). `followMain: false` stops it too,
  except that a build staged by hand (`desktop/scripts/stage-update.sh`) is
  still noticed and goes in the same way.
- **Idle benchmarks** (`features/tools/idle-perf.ts`), only when run explicitly:
  compile CPU counters, a window watcher and (for Swift references) an
  owned-PID activation helper into a temporary folder, removed at the end.
  A Swift reference checks its private executable path and build UUID before
  measurement and can activate that existing private app; it never launches
  the installed app. Every 250 ms during a sample, the watcher reads the foreground
  process, window bounds and stacking order, display sleep and console-session
  state. It rejects covered or inactive samples without sending Accessibility
  or automation requests to the app. Closing the benchmark's owner pipe stops
  the watcher. These helpers never run as part of the installed app.
- **Pushing main after landing** (`pushMain` in `runner/src/worktrees.ts`):
  only for repos listed in `pushAfterLanding` in `runner.json`, which
  nothing sets for you. After `tb land` moves main there, it runs `git fetch
  origin main` and `git push origin main`; when `origin` has commits main
  doesn't, it merges them in first, runs the repo's check on that, and
  pushes only if it passes. Otherwise `tb land` never pushes.
- **Following GitHub on a second machine** (`runner/src/follow-origin.ts`):
  only with `followOrigin: true` in that machine's `runner.json`, which
  nothing sets for you. Every 5 minutes the runner runs `git fetch origin
  main` in its checkout (the only network call it adds, to whatever
  `origin` is), fast-forwards that checkout's `main` when it can, and builds
  and runs `origin/main`, with no signature check. It never resets or
  rewrites anything: a commit made only there stays, and `tb status` says so.
  `tb land` refuses in that repo. If `origin` is Mike's repo rather than
  your own, leave this off.
- **Convex heartbeat** (`runner/src/sync.ts`): with sync on, the runner
  tells your deployment it is online once a minute. Before the first
  successful heartbeat, a failed request is retried after 1 second,
  doubling up to a minute. Key refusals and rate limits wait a minute.
  After the Mac wakes from sleep (the clock jumps more than 15 seconds
  between the runner's 2-second ticks, `runner/src/clock-jump.ts`), it
  opens a new connection to the deployment and heartbeats straight away,
  at most once in 30 seconds.
- **Schedule checks** (`runner/src/schedule-check.ts`): a schedule's
  check command, if it has one, runs in
  `/bin/sh` before each run, as you, for at most a minute (or up to five,
  if the schedule says). Each keeps a
  state file (and a note that a held check was told about, `<id>.held`) in `schedule-checks/` in Threadbear's data folder, and
  beside it what the check last printed (`<id>.<hash>.kept.json`, readable
  only by you) until a run carrying it has been sent, and, while a check
  runs, which runner process is running it (`<id>.running.json`).
- **Keeping the Mac awake** (`runner/src/keep-awake.ts`, on unless
  Settings > General > Sleep or `"keepAwake": false` in `runner.json`
  turns it off): while a thread is working and for 3
  minutes after, the runner runs macOS's `/usr/bin/caffeinate -i -w
  <runner pid>`, which stops idle sleep only (the display still sleeps
  and the screen still locks). While it does, it reads `pmset -g batt`
  every 2 minutes and lets go on battery below 15%.
- **Mike's releases** (`runner/src/upstream.ts`): every 6 hours (15 minutes
  after a look that failed) it lists
  `upstream`'s `release/*` tags (at its https or ssh address, with git told
  to run nothing your checkout's own git config names and to read no system
  or global config), fetches the newest few into a folder of
  their own (`<home>/runner/upstream-fetch`, deleted after each check),
  checks each with `ssh-keygen -Y verify` against the pinned key (the
  signature goes in a temp file under `$TMPDIR` for a moment), fetches
  upstream's `main` with them to check the tag's commit is on it, and
  copies the newest that passes into your checkout, as
  `refs/threadbear/upstream/`. A release's `scripts/release-signers` and
  `scripts/release-keys-revoked` can change the pinned keys
  (`<home>/upstream-signers`, `<home>/upstream-revoked`, and what's waiting
  in `<home>/upstream-keys.json`, changed by one runner at a time under
  `<home>/upstream-keys.lock`): a new key after a week, a revoked one at
  once (`runner/src/release-keys.ts`). It never changes your code by
  itself. Every 5 days, when there's one your copy doesn't have, it starts
  one thread (on your own Claude or Codex login, on your default mode) that
  works out the merge without checking it out (`scripts/merge-preview.sh`,
  in a throwaway repo under `$TMPDIR` it deletes), writes the clashing
  files to a folder of its own under `$TMPDIR` and settles them there
  (`--prepare`), tells you what it brings and asks; it runs nothing from
  the release (no checks, installs or builds) until you say go, then
  merges (`scripts/merge-prepared.sh` puts the settled files in), checks
  and lands
  (`runner/src/bring-in.ts`). A release Mike marks important starts one
  straight away. Settings › General › Updates from Mike, or
  `"releases": { "bringIn": 14 }` (or `"important"`, or `"off"`) in
  `runner.json`, changes it. It keeps what it last did in
  `runner/bring-in.json` in the data folder.
  Once a release has landed, that thread offers a check-up for Mike
  (`runner/src/checkup.ts`, `tb checkup`): a short report built from the
  runner log's own error messages (only those in Mike's code are named,
  grouped into bursts with allowlisted causes such as OS errno codes, error
  classes, reinstall exit codes, and RPC methods or `runner/src/` stack
  files that exist in Mike's release; fork-only crashes and methods are
  counted as other), coarse health flags (whether a release rolled back in
  `runner/state.json`, whether `run/error-exits.json`'s restart guard
  tripped, and free disk space only when under 10 GiB), the release tags
  (and the releases kept under `refs/threadbear/upstream/`; with a release
  key pinned, each counts only if it verifies against it), which of Mike's
  patches won't load, and how long `tb land`'s checks took
  (`.git/threadbear-land-times.log`: counts and times, step names only when
  they're `check.sh`'s, never host names). You see the
  draft; only if you say Send does it go, through your `gh`, as a comment on
  a public Discussion on `mikecann/threadbear`. It keeps the draft and what
  it sent in `runner/checkup-draft.md` and `runner/checkup.json`.
  `"releases": { "checkup": false }` turns it off.
- **A login's week going unused** (`runner/src/spare-week.ts`): every half
  hour the runner works out, from the usage readings it already has, how
  much of each login's weekly limit will be left when it resets. When a
  week resets within a day and 30% or more of it would go unused (20% in
  the last 8 hours), it starts a thread on that login that suggests work to
  spend it on and asks you before starting any. At most twice per week per
  login, and only on the main Mac's runner when there are several.
  Settings › General › Usage, or `"spareWeek": false` in `runner.json`,
  turns it off. Reset readings within a minute of one another count as
  the same window, so a rounded countdown can't repeat a nudge. It keeps
  what it last said in `runner/spare-week.json` in
  the data folder. Find work for it in the Usage panel starts the same
  thread by hand.
- **Your email, if you set it up** (`runner/src/mail-watch.ts`, the
  experiment mailWatch, off unless you turn it on and give it a command):
  every five minutes the main Mac's runner runs the command you put in
  `runner.json`'s `mailWatch.command`, which prints your new emails. The
  runner holds no mail login and reads no mailbox itself. Each new email's
  sender, subject and first 1,500 characters go to the model, with the
  titles and briefs of your recent and hibernating threads (never a private
  folder's) and the files you list in `mailWatch.decisions`. It can wake a
  thread, add an email to a thread's next turn, start a thread (to act on
  an email, or the twice-daily list) and keeps `runner/mail-watch.json` in
  the data folder (the ids it has seen and the list's emails).
- **Agent Archive, if you run it** (`runner/src/agent-archive.ts`, the
  experiment archive, off unless you turn it on): every ten minutes it
  writes `archive-sessions.json` in the data folder, saying which Claude
  or Codex session is which thread (its title, project and folder), and
  each Claude login's `projects` and Codex login's `sessions` folder, for
  Agent Archive's own sync to read. With Agent Archive installed it also
  runs that sync's `status --json` for `tb status`, and asks the archive
  server that sync sends to for its `/api/health` (no credential), for
  `tb status` too. On the Mac running the archive server, a server that
  hasn't answered twice running and isn't running under launchd is started
  with `launchctl kickstart` (never `-k`), at most once an hour. With `archive.repo`
  in `runner.json` it checks that repo's main with `git ls-remote`, and
  when main moves, builds the sync in `~/Library/Caches/Threadbear/agent-archive`
  (`git clone`, `npm ci`, a build), holding `agent-archive.lock` beside it
  so two runners never build at once, and runs the archive's own
  `install-runtime`, which replaces its runtime and restarts its service;
  then copies the build to the machines in `archive.pushTo` over ssh and
  installs it there. It remembers the last build in
  `agent-archive-update.json`. When you search threads in the app, it
  also runs the archive's own `search --json` (and `read --json` when you
  open an archived session) with your words, which the archive's command
  sends to the archive it was set up with, using its own read-only key.
  Every Claude and Codex session it starts gets the archive's MCP server,
  the archive's own command, as a tool server. It never reads the
  archive's credentials.
- **Recipes, if you turn them on** (`runner/src/recipes.ts`, the
  experiment recipes, off unless you turn it on): every 30 seconds the
  runner reads the recipes that come with Threadbear (`runner/src/recipes/`)
  and your own, in `~/ThreadbearThreads/recipes` (runner.json's
  `recipes.folder`). Nothing is fetched or sent anywhere. It keeps
  `recipes.json` in the data folder (which recipes you added, the thread that
  set each up and the schedules that are its, and for a recipe with a habit
  the habit's words as you switched them on, signed with the runner's token).
  While such a recipe is on, those words go to the agent in every thread,
  with your standing instructions. Adding a recipe makes its
  folder there and starts a thread in it; the schedules that thread makes are
  ordinary schedules. Switching one off pauses them, and for the email
  watcher's recipe turns that experiment off.
- **Your changes to the old Mac app** (`runner/src/swift-changes.ts`): a
  couple of minutes after the runner starts, then hourly, after each
  release check and when the new desktop app connects, it reads your
  checkout's git history (`git log`, nothing fetched or changed) for your
  own commits to `app/` and `dock/` that Mike's releases don't have, for
  the Updates panel's Not in the new app yet. The first time the new
  desktop app connects and there are some, it starts one thread (on your
  default mode) that asks before rebuilding them; never again after that.
  What it did and what you dismissed are in `runner/swift-changes.json` in
  the data folder. In Mike's own copy it finds nothing.
- **CLI updates** (`runner/src/updates/`): every hour it checks for new
  Claude Code and Codex versions and installs them. Claude Code is the one
  at `~/.local/bin/claude`, else the first `claude` on the runner's PATH
  (an npm or Homebrew install), unless `claudePath` in `runner.json` names
  another; its own `claude update` updates it. If you don't point it
  at your own Codex, it installs one into the data folder. It also runs
  any update commands you list under `cliUpdates.extra` in `runner.json`
  (none unless you add them), once a day each, and keeps when each last
  ran in `extra-updates.json` in the data folder.
  `THREADBEAR_CLI_UPDATES=off` stops all of this.
- **Small model calls** (`runner/src/models/`): thread titles, filing
  threads into projects (the librarian, every 5 minutes) and similar jobs
  send short excerpts of your threads to `claude -p` on your own logins.
  It also asks for a few search words for each thread, and threads from
  before that get them in batches of 15 (title, first message and last
  reply), every 2 minutes until each has some, once.
  When a project's notes pass 12,000 characters, the librarian sends them
  the same way to be rewritten shorter, and keeps the old notes in the
  data folder's `project-notes/` (the last 5 for each project).
  Mike's publishing runner also sends commit messages to Opus through its
  Claude pool when preparing a daily release, to write the plain-language release notes.
  The input includes subjects and bodies of merged commits, including pull requests.
  If that call fails, the signed release still goes out without notes.
- **Housekeeping** (`runner/src/housekeeping.ts`): trims logs, deletes
  week-old copies of pictures pasted into drafts (a sent message keeps its
  own copy) and deleted threads after 30 days in the trash. Archived
  threads keep their pictures unless you set `"archivedMediaDays": <days>`
  in `runner.json`.
- **Build cache cleanup** (`runner/src/build-cache-cleanup.ts`, the
  `buildCacheCleanup` experiment): sweeps stale build output hourly (5
  minutes after start, then every hour) and checks free disk space every 10
  minutes and before each runner update build. Removes git-ignored Cargo
  `CACHEDIR.TAG` build folders (such as `desktop/target`) in spare and
  kept-archived worktrees, and in open threads idle for 2 days (2 hours
  when free space is under 10 GiB); removes week-old `update-desktop/target`,
  `update/build`, `check-desktop-target` and non-App-Store `ios-builds/*`
  under `~/Library/Caches/Threadbear`, and week-old `shared-*` folders under
  `~/.cache/threadbear-check/local-builds`. When free space drops below 10
  GiB, clears all non-busy build caches until 20 GiB is free. Skips any
  folder with a held build lock, a live process cwd inside the worktree, or
  a write in the last 30 minutes.
- **Moving threads** (`runner/src/moves.ts`, only with the Convex
  backend): watches your Convex deployment for threads you've
  moved to or from this machine. One moving away is packed (its folder,
  its Claude transcript, its worktree's git work), sealed to the other
  machine's key, uploaded in pieces and deleted from the deployment once
  it lands; this machine keeps its old copy in `moved/` in the data folder
  for a week. One arriving is unpacked in `moves/` first, and may make a
  worktree for it, write its transcript into a login's Claude folder, and
  `git clone` its repo from `origin` if this machine has no copy.
- **Presence** (`runner/src/presence.ts`): reads how long the keyboard and
  mouse have been idle (`ioreg`), so your phone knows whether you're at
  the Mac. A runner that signs releases with a Touch ID key also reads
  whether the screen is locked (`ioreg`'s console session), as it can't
  sign until you've unlocked it. With `releases.delegate`, it keeps a
  weekly signing key and its certificate in `runner/release-delegate*` in
  the data folder, and asks for Touch ID about once a week to renew them
  (`runner/src/release-delegate.ts`).
- **Dialogs on the screen** (`runner/src/mac-screen.ts`): every 2 minutes it
  runs `osascript` to count the windows of macOS's UserNotificationCenter, so
  it can tell you when a dialog has been left waiting. It sees how many, not
  what they say. `THREADBEAR_MAC_SCREEN=off` stops it.
- **Patches** (`.threadbear/patches/`): code from a folder runs only after
  you trust that folder (`runner/src/patch-trust.ts`). A folder's Claude
  Code hooks, other commands, `env` settings and (in Ask and Auto threads)
  permission rules in its `.claude/settings*.json`, its `.mcp.json`
  servers, and hooks in its `.claude/agents`, `skills` and `commands`, are
  held back the same way (`runner/src/claude-trust.ts`): the runner reads
  those files and the scripts they reach to hash them (and lists
  `~/.nvm/versions/node` for the folders a hook may run programs from),
  runs `git ls-files` in the folder to find skills in folders under it,
  and keeps what you
  trusted in the same `patch-trust.json`. Beside it,
  `patch-trust-unvouched.json` lists worktrees a thread moved from another
  Mac changed the patches or Claude settings of, which Threadbear's own
  checkout's standing trust doesn't reach. And `patch-trust-versions.json` keeps,
  for the last few versions of each patch you trusted, the SHA-256 of each
  file and the repo's HEAD, so a patch asked about again can say what
  changed: for that it runs `git rev-list`, `git cat-file` and
  `git rev-parse` in the folder (`runner/src/patch-changes.ts`).
- **Menus on macOS 27.2** (`app/Sources/Threadbear/DragSpace.swift`): every
  5 seconds, and before a button opens a menu, the app asks the window
  server which Spaces its own windows are on, and takes them off the drag
  Space a window drag can leave them on, which hides their menus. A window
  filed under another display's Space than the one it's on (after a
  restart in the background) is put on its own display's. These are
  private window server calls, and they only touch the app's own windows.

## What it reads

- When you click a picture panel to open Simulator, the GPUI app looks up
  Apple's Simulator and runs `/usr/bin/codesign --verify --strict` with its
  Apple signature and bundle-id requirement before opening it. This runs
  off the main thread and does not launch an app with a copied bundle id.
- From your Claude and Codex logins: which account each is (the email in
  `~/.claude.json`, and whether the plan the CLI last saw there has
  lapsed: the free plan, or no billing), a few settings, and the token counts in your session
  transcripts, so it can show how much room each login has
  (`runner/src/accounts.ts`, `runner/src/token-tally.ts`;
  `THREADBEAR_TOKEN_TALLY=off` stops the counting). It never reads or
  copies login tokens or the Keychain. A Codex login that reads as out of
  room is asked for its limits every 10 minutes, by starting Codex's own
  `codex app-server` for a moment (`runner/src/limit-recheck.ts`); that
  costs no tokens. A login with no reading at all (a Codex login
  that hasn't run a turn here, or a Grok one) is asked once, a minute after
  the runner starts (hourly again if that fails). A Grok login is asked the
  same way (then every 10 minutes while it reads as out), by
  starting `grok agent --no-leader stdio` for a moment and sending Grok's
  `_x.ai/billing`, which asks Grok's billing service how much of the plan
  is used; a Grok thread asks its own process the same after a turn that
  ran out, and at most every 5 minutes after others. No session is opened
  and no tokens are spent (`runner/src/adapters/acp/grok-billing.ts`).
- Whether `~/.opencode/bin/opencode`, an
  `opencode` or `cursor-agent` on your PATH, `~/.local/bin/cursor-agent` and
  `~/.local/bin/agent` exist and where they really lead, and whether
  `~/.cursor/cli-config.json` exists (never opened). OpenCode itself reads
  `~/.config/opencode` and, as it does anywhere, your `~/.claude/skills`; a
  folder's own OpenCode config and plugins are turned off.
- Whether `~/.local/bin/grok`, `~/.grok/bin/grok` or a `grok` on your PATH
  exists and where it really leads, and whether `~/.grok/auth.json` exists
  (never opened). Grok itself reads `~/.grok`, and as it does anywhere your
  `~/.claude` settings, hooks, skills and `CLAUDE.md`; its threads run your
  own Grok and Claude hooks.
- Whether `$GEMINI_HOME/antigravity-acp/acp_token.json` (`~/.gemini` by
  default) exists (never opened). Antigravity itself reads and writes its
  own folder there (its sign-in, conversations and settings).
- With the Shared memory experiment on (off unless you turn it on): on your
  main Mac, each Claude login's `CLAUDE.md` and the memory files under
  `projects/*/memory/` for folders in your home folder, once a minute, which
  go to your Convex deployment with known secret values masked. On your other
  runners it writes those into each Claude login (`CLAUDE.md`,
  `projects/<folder>/memory/`) and Codex's `AGENTS.md`, leaving alone any file
  that was there first, and sends their own new or changed memory files back
  to your main Mac, which saves them under `memory-offers/` in its data folder.
  It keeps the main Mac's copy in `memory-cache/` and what it last synced in `memory-sync.json` there
  (`runner/src/memory-sync.ts`).
- Token Stats' files, if you have that app, and any logins you've added
  under `accounts` in its data folder (`claude-1`, `codex-1`...). With the
  claudeLogins experiment on, also each folder listed in runner.json's
  `claudeLogins`, as for those: its `.claude.json` (for the email),
  `settings.json` (the model) and `threadbear-token.json` if there is one,
  and Claude runs with `CLAUDE_CONFIG_DIR` set to it
  (`runner/src/claude-logins.ts`, `runner/src/accounts.ts`).
- The GPUI app's setup cards, the first time it opens (or from Help > Set
  Up Threadbear): which account GitHub's CLI is signed in as, by running
  `gh auth status` once, and nothing else of `gh`'s. Add on its Your agents
  card makes an empty `accounts/claude-N` folder in the data folder and
  opens Terminal on `claude auth login` there, as the guide's way of adding
  a login does; a folder that was never signed in to is taken away again
  when the cards close (`desktop/gpui/src/hello.rs`).
- Your first name, from your Mac account's full name (`id -F`), so its
  agents know what to call you (`runner/src/user-name.ts`). It stays in
  the instructions your own threads get.
- Whether it has Full Disk Access, by opening macOS's permissions database
  (`~/Library/Application Support/com.apple.TCC/TCC.db`) and closing it
  again. It never reads it. Without the access macOS refuses, with no prompt.
- Whether `Threadbear.app` is in `/Applications` or `~/Applications`, as a Mac
  without it is probably one nobody sits at.
- The GPUI app, the first time it opens on the data folder: the Mac app's
  own settings (`defaults export com.mikerosoft.threadbear`) and its unsent
  drafts (`app-drafts.json`), to fill in its own files where they have
  nothing yet (`desktop/gpui/src/swift_import.rs`). Once: `swiftImport` in
  `desktop-settings.json` says when, and neither is read again.
- The `.env*` files in the folders your threads work in (the folder, the
  folders directly inside it, and up to its repo's root; not `.env.example`
  and the like, your home folder or external drives), and everything in its
  own `secrets/` folder, to know what to take out of text before it goes to
  your Convex deployment (`runner/src/secret-values.ts`). Looked at when a
  folder first turns up, when a thread has just touched a file of secrets
  (including a `.env` in a folder of its choosing), and otherwise at most
  every 5 minutes. Kept in memory, never logged, written down or sent anywhere.

## Who it talks to

| Service | Whose | What goes there |
|---|---|---|
| A browser picture's URL | the site you drag from | When a picture dropped on the GPUI composer offers only an HTTP or HTTPS URL, the app downloads it directly without browser cookies, credentials or a proxy (30-second timeout, at most 25 MB). Only public internet addresses outside this Mac and its directly connected networks are used, including after DNS lookups and redirects. It is staged privately until the runner imports it. |
| Your Convex deployment | yours | Thread titles and status, all message text (each message cut at 8,000 characters), one line per tool call, the line a thread writes when its login runs out and it moves to another or waits (your other machines, your phone and your signed-in website are given those, never a shared page), projects, schedules, your logins' emails and usage, whether you're at the Mac, whether this machine is low on memory or disk, and the pictures you paste into a message, up to 10 MB each, so your own website and your other Macs can show them. Those go up as they are, in your deployment's file storage: unlike text, nothing can scrub a secret out of a picture, so a screenshot of something sensitive goes too. `"sync": { "pastedPictures": false }` in `runner.json` keeps them on this Mac. While someone has the website's Runners view open, this machine's CPU, memory and disk use, its processor model, operating system and time since it started, every 10 seconds; with nobody looking, none of that is sent. Photos you send from the phone, and pictures you send from the Mac app to a thread on another of your Macs, deleted once that Mac has fetched them. When the app shows a thread from another of your Macs, this runner downloads the pictures pasted into its messages from the deployment's file storage (25 MB at most each) and hands them to the app; it keeps them in memory and writes none of them to disk. Pictures and videos agents put in their replies or pin, at most 10 MB each, for the phone to show. When you open a design review on the phone, its options' stills (shrunk to fit 10 MB if need be, the copy kept beside the review's own pictures), their videos, sounds and single HTML files up to 10 MB each (HTML is stored as plain bytes and runs only in the native sealed view), the agent's marks, and its words, choices and notes; a review you never open there stays on the Mac. Marks you draw on the phone come down with a small cut-out of the picture each, kept beside the review. Other images only for threads you share by link. Other tool output and files stay on the Mac, unless you move a thread to another of your machines: then the whole thread, sealed so only that machine can open it, goes through for as long as the move takes. Text has known secrets taken out first: see below. |
| Convex (the Convex panel) | yours | Only for a thread in a Convex project, when its Convex panel opens: the runner's Convex CLI asks api.convex.dev for the project's deployments and a deploy key, the runner asks the deployment whether a kept key still works (`/api/check_admin_key`), and the panel loads Convex's embedded dashboard (dashboard-embedded.convex.dev) with that key. Sign in to Convex goes to auth.convex.dev. (`runner/src/convex-keys.ts`) |
| Your other Macs, over ssh | yours | Only when you run `tb runner add <name> --ssh <host>` or `tb runner check --ssh <host>` on your first Mac: it reads that Mac's Threadbear `runner.json`, writes its id and the deployment's address there if it hasn't them, writes its new key into that Mac's `secrets/convex-key`, and looks whether that Mac has a deploy key, Convex panel keys or a Convex login (names only, never a key), through your own ssh setup with agent and port forwarding off (`runner/src/runner-keys.ts`). `tb runner audit` asks this Mac's runner for its threads' last seqs and your deployment for what the main key made. `tb runner rotate-owner` sets env vars on your deployment with your deploy key, and, if you give it a Convex team access token for that run (`CONVEX_TEAM_TOKEN`, never kept), asks api.convex.dev for the deployment's deploy keys (their names and dates) before it rotates. |
| Your update build hosts, over ssh | yours | Only from the installed GPUI app, when `runner.json` has `updateBuildHosts` and main's `desktop/` has changed: a copy of your main's files to build it from, rsynced to `~/.cache/threadbear-check/gpui` on the first one that's a Mac and answers, and the two built binaries copied back (`desktop/scripts/stage-update.sh`) |
| threadbear.mikecann.app | Mike (the What's new page) | Only in a fork, while one of Mike's releases is waiting: at each release check (every 6 hours) the runner reads `/changelog.json` (about 20 KB, 15-second timeout, nothing sent with it), and the GPUI app then downloads the pictures of the cards its Updates panel shows (at most 4 MB each, public addresses only), once each while it runs. Nothing from it is run or merged. |
| GitHub | Mike's repo | Release tags fetched every 6 hours (15 minutes after a failed look); the fork at setup; from `tb land`, through your `gh`, a marked workflow's recent runs on main; after a thread pushes, runs `gh workflow run` or `gh run rerun`, or passes `waitForRuns` to `end_turn`, through your `gh`, the workflow runs it set off while any are queued or running (`runner/src/ci-runs.ts`); when you open a PR link or view Highlights' Pull requests in the desktop app, through your `gh`, that PR, its diff, its checks, its repo's merge settings, and the status/state of PRs a thread links to; every minute while any PR's auto-fix wand is on (`runner/src/pr-watch.ts`, state in `pr-watch.json`, optional rules in `~/.threadbear/pr-auto-fix.md`), a GraphQL look at watched PRs; a check-up comment on Mike's check-ups Discussion, through your `gh`, only after you say Send on its card (`runner/src/checkup.ts`); and only when you press its button, a merge, close, reopen, review or the comment you typed (`runner/src/github-pr.ts`) |
| index.crates.io | crates.io (Rust's package registry) | With the daily CEF check above, the installed Mac runner reads `/3/c/cef`, the list of published releases of cef-rs (CEF's Rust bindings), so the warning can say whether a newer CEF can be moved to yet. It sends nothing else and keeps only the newest version in `<home>/runner/web-runtime-check.json`. |
| cef-builds.spotifycdn.com | Spotify (CEF's official builds) | The installed Mac runner, only while a web runtime is installed, reads `/index.json` once a day, a minute after starting if due, to warn when this release's CEF pin is over 14 days behind stable (or checks fail for 3 days). Dev runners/tests do not poll; `THREADBEAR_CLI_UPDATES=off` disables it too. It sends no user content and stores the check in `<home>/runner/web-runtime-check.json`. From the GPUI app, only when you press Install web runtime: one download of the pinned build (135 MB), which nothing is sent with. Threadbear will publish its own signed copy later. Chromium itself then goes online only for the pages the GPUI app's web panels show; its own background requests are off (`--disable-background-networking`), and an agent's html and diagrams reach nothing (`desktop/web/src/mac/sealed.rs`). |
| downloads.claude.ai, registry.npmjs.org | Anthropic, npm | CLI version checks and installs; `npm ci` |
| Anthropic, OpenAI | yours | Your threads, through the official CLIs on your own logins, and small jobs' text (titles, summaries, the librarian and fuzzy Wake when…) on whichever pool and provider order you pick in Settings > Models (Claude first, then Codex by default, using isolated `codex exec` with tools disabled). An approval card in a thread on Auto, with the thread's first and latest messages, goes to Opus through the same CLI so it can decide in your place. With the `inboxGuess` experiment on (off by default), when one of your own threads finishes with nothing for you, your last message to it and the agent's reply go to Haiku and to Opus through the same CLI, each to guess whether you needed to see it (not for a thread in a private folder). Unless you turn off Settings > General > Code review (`"labReview": false`), a thread's code change, with your message and the agent's reply, goes to your other provider's CLI as a review thread, as if you'd started one (or a fresh session of the same provider, with no other login). After a turn fails because the API couldn't be reached, the runner itself opens (and straight away closes) a connection to api.anthropic.com or chatgpt.com on port 443, at most once a minute, until one opens and the thread carries on. Nothing is sent over it (`runner/src/net-probe.ts`). |
| OpenCode's Zen (opencode.ai), models.dev, and whichever providers you've logged it into | theirs | Only with a thread on OpenCode: that thread's prompts and tool output, through the official CLI, and small jobs' text when a pool with OpenCode logins is picked for them in Settings (according to your provider order, or when earlier providers in the pool are out of room) |
| Cursor (api2.cursor.sh) | theirs | Only with a thread on Cursor: the same, on your own login |
| xAI (cli-chat-proxy.grok.com and Grok's other services) | theirs | Only with a thread on Grok: the same, on your own login, and small jobs' text when a pool with Grok logins is picked for them in Settings (according to your provider order, or when earlier providers in the pool are out of room). After a Grok turn fails because the API couldn't be reached, the runner opens (and closes) a connection to cli-chat-proxy.grok.com as it does for the others |
| Google (cloudcode-pa.googleapis.com and Antigravity's other services) | theirs | With a thread on Gemini: the same, on your own Google login. When Gemini is set up, also its every-10-minute `/usage` read, which asks Google for your plan's quota. After a Gemini turn fails because the API couldn't be reached, the runner opens (and closes) a connection to cloudcode-pa.googleapis.com as it does for the others |
| Fly.io (api.machines.dev) | yours, if you set it up | Never from the Mac: only from your Convex deployment, and only once you've made a virtual runner there (`boxes:setRunnerService`, docs/virtual-runners.md) and set `FLY_API_TOKEN` and `FLY_APP` on the deployment. It makes, pauses, resumes, lists and deletes a Fly Machine for each thread on a virtual runner (`convex/boxService.ts`, `convex/boxProviders/fly.ts`), and every 10 minutes lists them to delete any nobody wants. A machine's environment holds only your deployment's address and a single-use boot token that lapses in 10 minutes, and its tags name the box's rows. |
| Mike's push relay | Mike's | Only when a paired iPhone or Android phone gets a notification (an Android phone's goes on to Google's Firebase Cloud Messaging, from the relay). It's sent from your Convex deployment, not the Mac. The text is encrypted for the phone; the relay sees the device token and thread id (`convex/push.ts`, `docs/push-relay.md`). The first time, your deployment registers with it, giving its own address; the relay keeps that address and checks it by posting a one-time code back to your deployment's `/relay/verify` (`convex/http.ts`). |
| A UnifiedPush server (ntfy.sh or whichever distributor the phone uses) | the distributor's | Only with the Android app's F-Droid build paired: each notification is posted from your Convex deployment, not the Mac, to the https address the phone's distributor gave it, encrypted so the server sees neither the text nor the thread (`convex/push.ts` `sendWebPush`, `docs/push-relay.md`, "UnifiedPush"). Private and local addresses are refused. |
| A Connectors gateway | whoever runs it | Only if one is set in `runner.json` or `~/.claude.json`. Its `/health` every few minutes (and once more at the end of a turn where a call to one of its services failed, to see if it needs signing in), and for a project with a Notion page, a Notion read or two every 5 minutes for its task board (`runner/src/notion-tasks.ts`), signed with the header the `headersHelper` command in that `connectors` entry prints, which it runs for each read |
| Agent Archive's repo, its server, and the machines you list for it, over ssh | yours | Only with the archive experiment on: every ten minutes a GET of `/api/health` on the archive server the sync is set up with, with nothing sent but the request. With `archive.repo` set: `git ls-remote` and `git fetch` of that repo every ten minutes, `npm ci` from the npm registry when its main moves, and the built sync copied over ssh to each machine in `archive.pushTo`. The runner sends nothing to the archive itself: Agent Archive's own sync does, to the archive it was set up with, and the archive's own command sends your thread search's words when you search. |
| Sentry | Mike's | Nothing from your copy. Only a copy whose `origin` is Mike's own repo reports errors or uploads the app's debug symbols (`runner/src/sentry.ts`, `app/Sources/Threadbear/CrashReporting.swift`, `app/build-app.sh`). The installed GPUI app of Mike's repo, on the real data folder, sends its panics, crashes and freezes of 15 seconds or more, each as one POST to Sentry's endpoint with the function names and nothing typed or opened (`desktop/core/src/crash_report.rs`, `desktop/gpui/src/crash_reporting.rs`); it uploads no symbols. The App Store iPhone app sends anonymous crash reports. |

Comparison HTML stays a snapshot until you press Interact in its header.
Double-click looks closer with marks still visible. Esc, tour steps and
option tabs stop interaction before moving the canvas; stopped media notices
stay separate from draft-save errors. The live page scales its desktop CSS
viewport with the snapshot instead of reflowing as the canvas zooms.

An HTML file opened in the side pane (a mockup or report an agent made,
a page in a project) talks to nothing. It loads through the app's own
`threadbear-preview:` scheme, which serves only that page and the
styles, pictures, fonts and media its markup names in its folder:
never another page, a script file, SVG, a dotfile, a symlink or a file
outside it. Its web view
blocks every other load (a WebKit content rule list, which WebKit keeps
in its own store under `~/Library/WebKit`), sends any connection it would
still make to a closed port on this Mac (127.0.0.1:9) so no name is
looked up, runs none of the page's scripts (unless you choose Run them
over that page, which turns them on for that version of the file only,
remembered by its SHA-256 in the app's settings), has WebRTC off, and doesn't
follow links away from it, submit
forms, open windows or download
(`app/Sources/Threadbear/Views/LocalPreviewSchemeHandler.swift`,
`app/Sources/ThreadbearCore/Support/LocalPreviewSite.swift`).

On the Mac itself, a web link you click in the app first goes to
BrowserBear's socket (`~/Library/Application Support/BrowserBear/browserbear.sock`),
if you have BrowserBear, to ask whether an agent's Chrome tab is already
on that page (`app/Sources/Threadbear/BrowserBear.swift`,
`desktop/gpui/src/agent_browser.rs`). Only the link goes there, and only a
web address.

When Google Chrome is your default browser and is running, a web link's
right-click menu reads Chrome's `Local State`
(`~/Library/Application Support/Google/Chrome/Local State`) for the
profiles with a window open, their names and account pictures, so it can
offer "Open in Chrome: <profile>". Choosing one runs
`/usr/bin/open -na "Google Chrome" --args --profile-directory=<profile> <link>`,
only ever for a web address (`app/Sources/Threadbear/Transcript/ChromeProfiles.swift`,
`desktop/gpui/src/open_gate.rs`). Nothing else of Chrome's is read.

The Browser panel also uses that private socket to list the pages agents
associate with threads, ask for a small still of each and bring a page's real
window to the front (`app/Sources/Threadbear/Views/AgentBrowserPanel.swift`,
`desktop/gpui/src/agent_browser.rs`), looking at `agent/tabs.json` and the
socket every 0.75 seconds while the app runs, and asking for a still every 3
seconds only while the panel is on show. A debug build run by a script never
reaches it unless `BROWSERBEAR_HOME` points somewhere (the specs use a
stand-in).
Threadbear does not read Chrome's cookie database or copy credentials, and
stills stay on this Mac, in memory, not sent to Convex. BrowserBear stores
thread/tab/profile associations in `panel-tabs.json` in its own folder (0600).

The agents' own browser (`browserbear ... --profile agent`) is Helium where it's
installed, else Google Chrome, with its own profile folder; the panel reads
`agent/tabs.json` in BrowserBear's folder for its pages. Any program on this Mac
could reach its local debugging port, so it holds only what you sign it in to.

Nothing else: no analytics, no ads, no tracking.

## Secrets and your Convex deployment

Before any text goes to your deployment, the runner takes out what it can
recognise (`runner/src/scrub.ts`): shapes of keys and tokens
(`runner/src/redaction.ts`) and the actual values in `.env` files and its own
`secrets/` folder. Your deployment does the shape check again before storing it
(`convex/redaction.ts`), so an older runner can't put a known shape there. Your
own copy on the runner keeps every word. If the check itself fails, that text
isn't sent, and `tb status` says so.

**It isn't a guarantee.** It catches shapes and values it knows, so a secret in
an unfamiliar format can get through, and it can't read pictures at all: any
picture that goes up (ones agents post or pin, and anything in a thread you
share) goes as it is. Scrubbing also can't undo a leak. A key that shows up in
a thread has already been to the AI provider, so rotate it.

**Full sync** starts off. It lets your phone, the website and your other machines
show each thread's tool output and diffs, not just its messages, even when the
machine that ran it is asleep or gone, so it only helps once there's something
other than this Mac to read them on. Threadbear never turns it on or asks about it
by itself: `tb settings full on|off` or Settings > General > Full sync sets it. An
update never changes it; a Linux
runner has whatever its own `runner.json` says. `"sync": { "full": false }` keeps tool output,
diffs and tool screenshots on that runner, and then nothing below happens. With it on, from then on (older tools aren't sent), that
runner also sends each finished tool's output, its full input, its diffs and the
reasoning before it to your deployment, after the same scrubbing, where they're
kept 30 days. This lets you read them from any device while the runner's off. It's
the same not-a-guarantee as above, over much more text. A tool whose command or file
can hold secrets (`.env` files, `env list`, key files: `runner/src/withhold.ts`) sends
nothing of itself, and a runner without an on-device model relies on these checks
alone, which `tb status` says. A tool's screenshots stay on the runner unless you tap
one on the website, which uploads that one for a day.

`runner/scripts/scrub-stored.mjs` runs today's rules over what's already stored,
and only when you run it. Convex backups and snapshot exports keep their copies.

There's also a silent on-device check, off unless `runner.json` has
`secretCheck: { enabled: true }`, on a Mac with Apple Intelligence
(`runner/src/secret-check.ts`). It's an experiment: it builds a small helper the
first time (`<data>/tools/secret-check/`), and on mains power, at background
priority, it passes a sample of tool output and pictures to Apple's on-device
model, and Apple's on-device text recognition for a picture. Nothing leaves the
Mac and it changes nothing that uploads. It keeps counts, and the thread and
sequence number of what it flagged, in `<data>/secret-check.json`. Never the text.
