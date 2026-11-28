# Agent guidance for threadbear

Threadbear is Mike's own agent app: a runner driving the official Claude Code and Codex
CLIs, and apps that talk to it. This file is the traps to avoid; each job's how-to is in
the doc that owns it ("Doing X? Read Y"). Put detail there and link it, not here.

- `runner/`: the runner (runner/README.md). The contract between it and the apps is
  docs/protocol/, a file per area; `docs/protocol.md` says which section is in which.
- `desktop/`: the GPUI app for Mac, Windows and Linux, the one Mike uses
  (desktop/README.md, docs/gpui-port.md). `app/` and `dock/`: the SwiftUI Mac app and
  BearDock, frozen (app/README.md). `features/`: their behaviour specs.
- `convex/`: the mirror other runners, the iPhone app (`ios/`) and the website (`web/`)
  read (docs/convex-backend.md, ios/README.md, docs/website.md). `site/`: the landing
  page, its own package; each release gets a What's new entry (docs/changelog.md).
- `docs/guide.md` is the user guide. `docs/archive/` holds finished plans, as history.
  The app was called Threadbare until 27 Oct 2026; old `THREADBARE_*` names still work.

This is written for Mike's copy. The machines it names (the M5, `bruce`, `cloud`,
`tinker-desk`) and paths under `~/dev/me` are his: in anyone else's copy (`origin` isn't
mikecann/threadbear) they don't exist, so check `origin` before any ssh or path here,
skip those steps and ask the user what they use. There, a release of
Mike's comes in through docs/bringing-in-updates.md, never a plain `git merge
upstream/main` (it skips the checks, and the release's new checks then fail every other
landing); one change they ask for by name can be cherry-picked.

## Never

- Never read or copy OAuth tokens or Keychain credentials; only spawn the official
  `claude` and `codex` binaries under Mike's own logins. Exception: a login's year-long
  token (`threadbear-token.json`) goes to that login's CLI, to Convex in the clear only when
  Mike picks it on a cloud token card (`cloudTokens.useMac`), and to another runner only
  sealed to that runner's key, when Mike switches on Use this Mac's Claude logins
  (`login-share.ts`). A Make one cloud token goes only to `boxes:setCloudToken`, never to
  disk or the log.
- Never kill processes you didn't start: T3 Code and other threads run the same CLIs.
- Never restart the live runner (`deploy-runner.sh --now`, `install-runner.sh`,
  `tb restart` on it, `launchctl kickstart`, stopping its node): it ends your turn and
  stops other threads' work. If one is needed, tell Mike the exact command.
- Never run `app/restart.sh` or `app/install.sh`: they relaunch Mike's app in front of
  his work and throw away what he's typed.
- Transcripts, fixtures from real sessions, `tb export`s and shots of them, and
  `tb activity` are private: out of git (`.fixtures/` is ignored) and out of anything
  posted or sent, and deleted when done.
- Sentry hears only from what Mike really runs (installed apps, the runner's release on
  the real data dir, App Store and TestFlight iPhone builds), never from debug, dev, test or scripted
  runs, and never with user text. `THREADBEAR_SENTRY=off` turns it off; convex/ has none.
- No heavy work on Mike's Mac. Run the one test file you're on
  (`node --test test/unit/<name>.test.ts` in `runner/`); whole suites go through
  `./check.sh`, which sends them to a check host (a hook blocks `npm test` here). Rust
  builds and spec runs go through `desktop/scripts/remote.sh`; a build that must run
  here waits its turn in `scripts/one-build.sh`, so give it a longer timeout.
- Tests that hit a real model use the cheapest model, tiny prompts, a temp working
  folder and a temp runner data dir, never the real one.

## Tests that need the real screen

Anything needing the real pointer, keys or a window in front (a drag, a gesture, a cursor
check) never runs on the Mac Mike's working on: it takes his pointer, and a stray drop
lands in whatever's on top. There, use `dev-app.sh`'s automation commands; run the real
thing on Tinker Desk's desktop from a throwaway copy (`ssh tinker-desk
'~/.local/bin/desk "<cmd>"'`), removed after. How: features/README.md, "Real screen".
`app/Tools/perf-run.sh` and `run-mock.sh` take the front too: ask Mike first.

## Where work goes

- Work in a worktree of your own, never the main checkout: a thread started here gets
  one; one started elsewhere borrows a spare with `./borrow-worktree.sh` (never
  `git worktree add`) and gives it back with `--give-back <dir>` once landed. In a shared
  checkout, stage your own paths by name, never `git add -A`.
- Land through `tb land` in your worktree (`runner/bin/tb` if `tb` isn't found), in the
  background with a 2-hour timeout (7200000 ms: a landing waiting in the queue outlasts
  30 minutes). Never push main or merge by hand. If it refuses,
  it says what to fix (docs/thread-worktrees.md).
- On Mike's Hetzner Cloud runner git may push only `cloud/**` branches: push your work as
  `cloud/<topic>` and say so. Landing happens from the main Mac.
- The live runner and installed apps follow main by themselves. After landing an app
  change, don't ask Mike to restart or check it: call `wait_for_app_restart`, end the
  turn with needs "nothing", and check it yourself when the runner messages you.
- Editing `runner/` doesn't change the live runner (it runs a release). Try a change on
  `runner/scripts/dev-runner.sh` with its `<dev home>/tb` (a bare `tb` is the live one),
  `--clone-real` for real data, never `--home` on a copy of it, and stop it with the
  `kill <pid>` it prints (never `pkill`) before you deploy or end your turn.
- After landing an `ios/` change, install it on Mike's phone yourself (ios/README.md). That's
  how his phone stays current: no TestFlight builds (he dropped them on 22 Nov as confusing).
  Uploading for App Store review needs him to ask. Use only your worktree's own
  simulator (`ios/scripts/sim.sh`), never one picked from `simctl list`.
- A security or data fix other copies should take soon gets an `Important: <why, plainly>`
  trailer beside Co-Authored-By (`runner/src/bring-in.ts`). Rarely, or it means nothing.

## Changing behaviour

- Test first for anything non-trivial.
- The protocol is the contract: change its file in docs/protocol/ first, then both sides, and keep
  both sides tolerant of unknown fields and event types.
- Changing a threadbear tool's arguments: keep taking the old ones. A resumed session
  keeps the definition it first loaded and goes on calling the old form
  (docs/protocol/needs-you.md, "One reply").
- What every agent is handed (the threadbear tools, the standing instructions) has a byte
  budget, `runner/context-budget.json` (`context-budget.test.ts`). Before accepting
  growth, see if it can be shorter or go behind something agents look up.
- A thread is reached four ways: on this runner, another runner's through Convex
  (`runner/src/relay.ts`), the iPhone and the website (`convex/phone.ts`), and features
  have gone missing on all but the first. A new thread request needs a row in
  `runner/src/parity.ts`, a new kind of thing the desktop draws one in
  `runner/src/draw-parity.ts`; a change to what a thread shows (a card's field, a message, the
  done card) needs a scenario in `runner/test/unit/scenarios.test.ts`.
- A change to what the desktop app does gets a spec in `features/`; one to how the
  transcript folds keeps both golden test sets happy (`desktop/core/tests/golden`).
- Keep true: `docs/guide.md` (what a user sees or does); `docs/on-your-mac.md` (files
  outside the repo, timers, what it reads, network calls: a stranger's agent checks the
  code against it); `docs/forking.md` (where features live, anything of Mike's in the
  code; what only his setup needs goes in his runner.json). Patches here show in every
  fork: a chip for Mike's accounts needs a `when` only his Mac passes.
- Rust in `desktop/`: `cd desktop && cargo fmt --all` before committing (light, fine
  here). Clippy runs with `-D warnings`; an exception is `#[expect(clippy::x, reason =
  "...")]`, never a bare `allow` (desktop/README.md, "Lints").
- A branch from before a format commit (`.git-blame-ignore-revs`) lands across it by
  itself; on a real conflict, `scripts/replay-over-format.sh`.
- TypeScript: a promise is awaited, ends in `.catch`, or is marked `void` only when its
  failure truly doesn't matter. Don't hand-edit `eslint-suppressions.json`: `npx eslint
  <files> --suppress-rule <rule>` adds, `--prune-suppressions` removes.
- When Mike asks for a button or panel for a project, write a `.threadbear/patches/*.ts`
  patch (docs/protocol/patches.md, "Patches") with Edit or Write, not the shell, so it's trusted.

## The GPUI port

Mike uses the GPUI app every day, so the Swift app (`app/`, `dock/`) is frozen: changes go
in `desktop/`, never in both. `scripts/swift-freeze.sh` refuses edits there in Mike's
copy; its comment lists what stays open and how to let a change through when he asks.

## UI

- Assume every action is slow to land (Convex hops, a busy runner). Every click shows the
  result at once (optimistic, rolled back with the error if refused) or a spinner that
  takes no more clicks until it lands. Never an idle-looking button clicked twice.
- Every control gets a tooltip, through the tip helper (`tips_source.rs` checks it).
- UI copy: plain words, no eyebrow or kicker labels, no em dashes.
- A menu that picks one of several things with a default (a machine, a link's action,
  the browser) also sets the default from that same menu and marks it with a star.
- Animations: anything longer than a hover fade must keep moving with the main thread
  busy; try it with a temporary sleep after the click (docs/gpui-port.md, "Animations").
- Screenshots: the app window only (by window id), deleted when done unless for a PR;
  dark mode for anything others see unless Mike asks (`--appearance dark`, `--dark`).
- A UI idea that moves or is felt (an animation, a drag, a gesture): mock it and show Mike
  a short clip in motion before building it (show_options for several), not words.
- Building a design Mike picked: before landing, put a shot of the build beside the
  mockup and check the layout matches, not just the wording.
- A feature Mike uses: once it's live on his app, show it working before calling it done,
  with a real example he can try there and then (a show_options with a clip, a small
  thread offering the new button, a patch panel with sample rows) plus a clip or shot.
- Files and links for Mike go in the thread's Highlights with `pin` (`show: true` opens
  it), not `open`; the app's own panels with `show_panel`.

## Experiments

A new feature Mike is still trying out lands as an experiment: off by default, on for him.
Give it `runner/src/experiments/<id>.md`, check `experimentOn` where it starts, turn it on
in his runner.json, run `npm run experiment-docs`, and book a check-in about four days
out. When he says make it standard, take the flag out entirely, its key in his runner.json on
the M5, `ssh bruce` and `ssh cloud` too. Bug fixes and polish go
straight in. Each step: docs/experiments.md, "Adding one, and ending one".

## Other people's PRs and forks

Before starting on a GitHub issue, check `gh pr list` again. Merge with `gh pr merge
--rebase`, credit rewritten work with `Co-Authored-By:`, and send any comment past Mike
first. A fork's commit isn't an offer: only the fork watch schedule or Mike naming it
brings one in. CONTRIBUTING.md, "How my agents take PRs and forks".

## Doing X? Read Y

- Landing, borrowing, red on GitHub, syncing main, `package.json`: docs/thread-worktrees.md.
- `./check.sh` (check hosts, lint, a stuck `--desk` run), the dev runner, builds here:
  docs/dev-tools.md section 4. `tb` and its commands: section 3.
- Shipping a runner change, deploys, rollbacks, the launcher app: docs/dev-tools.md, "The
  runner updating itself". Driving the desktop app, real-thread and cursor bugs, freezes:
  desktop/README.md. The Swift app: app/README.md, "Rules for changing it". The iPhone
  app: ios/README.md. Real-screen tests: features/README.md. Parity: docs/parity.md, and the nightly screenshot run (Mike's only): docs/parity-run.md.
