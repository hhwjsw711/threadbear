# A worktree per thread

Mike, 2026-10-27: several threads work on Threadbear at once, all in the
same checkout. One thread's `git add -A` has swept another's half-done work
into a commit, merges and test runs collide, and every agent has to
remember to make its own worktree. Instead, a repo can ask for each new
thread to get a worktree of its own, and a thread lands its branch on main
when its checks pass.

## Opting in

Only repos that ask. A patch (docs/protocol/patches.md, "Patches") can say:

```ts
export default {
  worktree: {
    // Run in the new worktree before the first turn. Optional. One
    // script in the repo and plain words, as it runs by itself
    // (docs/protocol/trust.md, "Trusting a folder's patches").
    setup: "./scripts/setup.sh",
    // Run by `tb land` before main moves. Optional; a failure stops it.
    check: "./check.sh --quick",
    // Run in the worktree's root when the thread is archived or deleted,
    // before the cleanup. Optional. Held to the same trust rules as setup.
    teardown: "./scripts/teardown.sh",
  },
  // actions, panels, hooks as before
};
```

The first patch in the thread's folder chain with a `worktree` wins (home's
`~/.threadbear/patches/` never counts: worktrees are a repo's choice). The
repo is the git toplevel of the folder the patch is in, and its main
checkout is the one with `main` checked out.

`setup`, `check` and turn hooks run below normal priority, as do the
runner's own update builds, so a land's test suite doesn't take the Mac
over: `nice -n 10` by default, or as runner.json's `jobPriority` says
(`normal`, or `background` for macOS's `taskpolicy -b`, which Mike's
runners use; `runner/src/background.ts`). The GPUI app's update build goes
by it too. Action buttons you press run as normal.

## A new thread

`threads.create` (and `create_thread`, and schedules that start a thread)
for a folder inside an opted-in repo:

1. Makes `git worktree add -b thread/<id8> <parent>/<repo>-threads/<id8>
   main` from the main checkout, where `<id8>` is the first 8 characters of
   the thread id. A leftover folder or branch of that name is an error
   shown in the thread, and the thread starts in the main checkout as
   before.
2. The thread's `cwd` is the same subfolder of the worktree as the folder
   asked for (asking for `~/dev/me/threadbear/runner` gives
   `.../threadbear-threads/<id8>/runner`).
3. `setup` runs in the worktree's root before the first turn starts. Its
   output goes in the transcript as an `action.run` event (`trigger:
   "worktree.setup"`). A failure is shown and the turn starts anyway.
   It's the worktree's own copy of the patch that's read, and only when
   that copy (with the scripts it names, as they are in the worktree) is
   trusted; otherwise a note says the setup was skipped (docs/protocol/trust.md,
   "Trusting a folder's patches").
4. The record keeps `worktree: { repo, mainCheckout, path, branch, base }`
   (`base` is main's commit when it was made); the summary carries
   `worktree?: { branch, mainCheckout }` so the app can show it.
5. `threads.create` takes `worktree: false` to start in the folder as
   before.

The agent is told, in the appended system prompt: this thread has its own
worktree of `<repo>` at `<path>` on branch `thread/<id8>`, made from main;
commit there; other threads use other worktrees; when the work is done and
checked, `tb land` puts it on main.

In this repo the folder is usually an earlier thread's slot,
`<parent>/threadbear-threads/slot-<n>` (below, "Reusing worktrees"), reused
with its build caches so the app builds warm, and `worktree-setup.sh` links
its `node_modules` to the main checkout's. Changing a `package.json`?
Replace the link first: `rm runner/node_modules` (no trailing slash, so only
the link goes), then `npm ci` there.

## Landing

`tb land`, run in the thread's worktree (an agent's Bash, or Mike's Land
chip, which is a command action every opted-in thread gets):

Steps 1 and 2 run first, so a refusal or a conflict with main as it is
comes straight away. Then it takes an OS lock in the repo's common git
directory (`threadbear-land.lock`), held through the check and
fast-forward, and does steps 1 and 2 again on the main it finds. Only the
lock's holder moves main, and only to a commit its check passed. The lock
releases when the command exits, even on a crash; the empty lock file
stays. Separate repos do not block one another.

1. Refuses with uncommitted changes in the worktree (says which files).
2. `git rebase main` in the worktree. A conflict aborts the rebase and
   says which files; the agent sorts it out and runs `tb land` again. A
   branch with a merge commit on it (Mike's release brought in,
   docs/bringing-in-updates.md) is never rebased, since that would flatten
   the merge and rewrite Mike's commits: if main has moved, main is merged
   into it instead, with the same undo-and-name-the-files on a conflict.
   A format commit on main that the branch doesn't have (one that only ran
   a formatter over a folder, like `cargo fmt --all` over desktop/, listed
   in `.git-blame-ignore-revs`) would conflict with every change the branch
   made there, so when the branch changes anything it formats, each of its
   commits is made again with its tree formatted as that commit was, and
   its change in formatted terms goes onto main, the same three-way merge
   a rebase does (`runner/src/format-replay.ts`). Only real conflicts are
   left; one is named with `scripts/replay-over-format.sh`, which does the
   same in the worktree and stops at the conflict for `git rebase
   --continue`. A commit the formatter can't parse is left as it is there
   and said. Waiting landings are stacked into a group check the same way.
   The same goes for a tool that moves text between files rather than
   formatting it (`# format-tool:`, like the split of docs/protocol.md
   into docs/protocol/ by `scripts/split-protocol.mjs`): an edit made to the
   single file comes across into the file its section went to. The branch
   that brings in such a commit itself, rather than rebasing it onto a
   main that has moved on in what it rewrote, has it made again there with
   the same tool, its other commits picked as usual. Only a tool main's own
   `.git-blame-ignore-revs` already lists, command, paths and config exactly,
   is run, and only with config the branch hasn't changed: the branch's
   list is anyone's who can commit to it, and Land runs on this Mac, not a
   check host. One main doesn't list stops the landing before anything
   runs, with the command shown and how to make that commit again by hand
   (rebase, run it yourself, commit); one already made on main as it is now
   lands as a plain commit. A formatter isn't run on a tree that brings its
   own toolchain file, cargo config, mise or rtx config, a `.config` folder
   or a link where it formats (names matched without case, as a Mac's disk
   opens them), as those can change what the command runs. A group check
   crossing format commits takes their commands from main's list, never
   from the waiting branches stacked on it, nor a format commit of theirs.
   And since main's list is what later landings run, a branch that adds or
   changes a command in it, or changes a config file one runs with (the
   split tool's script, the toolchain file), stops with what changed shown,
   and lands only with `tb land --allow-format <id>`, the id it gives for
   exactly those commands and file contents (the Land chip never passes
   it; such a branch never rides in another's group check).
   Then it refuses a commit whose `Important:` line git doesn't read as a
   trailer (not in the last paragraph with `Co-Authored-By`), as a release
   would not flag it and forks wouldn't hear. And it says in a line when
   a GitHub workflow it would set off is red on main, and lands anyway
   (below, "Red on GitHub").
3. Reads the patch's `check` after rebasing, and runs it in the worktree,
   if there is one, together with everyone waiting (below). A landing that
   changes no file from main (a commit with only a trailer) skips the check
   and lands at once; it leaves no line in the times log, as it ran nothing. A patch load error or failing check stops here, with
   the last lines of its output. Changing the branch or leaving changed
   or untracked files during the check also stops it.
4. `git -C <mainCheckout> merge --ff-only <checked commit>`. If main's working
   tree has uncommitted changes in files the merge touches, git refuses;
   `tb land` says so and which files, and leaves everything as it was.
   Before it, and at the start, the main checkout has to be on
   `refs/heads/main` itself with nothing half done there (no rebase,
   merge, cherry-pick or revert sequence, or bisect in progress): a merge there would
   move a detached HEAD, and the rebase's end would set main without it.
   Afterwards it checks main and main's reflog are at the checked commit.
5. Prints what landed (`git log --oneline main@{1}..main`).

It pushes only where runner.json's `pushAfterLanding` lists the repo
(below, "Syncing main with GitHub"); otherwise main stays on this Mac. The
runner and the app follow the local main by themselves. On a machine with `followOrigin` on (docs/dev-tools.md), `tb
land` refuses in the repo the runner follows, as that main has to stay
GitHub's: push the branch as `cloud/<topic>` or hand the work to the main
Mac. On Mike's Hetzner Cloud runner (and sandboxes to come) git pushes with a
one-hour token the main Mac hands over (`~/dev/me/misc/github-app` there),
and the repo's rulesets let it write only `cloud/**` branches: `main`, other
branches and tags are refused, so push work as `cloud/<topic>` and say so.

The Land chip has an hour for waiting and checking; other command actions
keep their usual ten-minute limit. In an agent tool with its own shorter
command limit, run `tb land` in the background with a 2-hour timeout (7200000
ms) and collect its result. On 28 Nov 2026 Gemini on OpenCode gave it 30
minutes, which a landing waiting behind others outlasted, and OpenCode stopped
it: landings waiting for the lock are checked together
(below, "Landing together"), so expect up to two checks' wait. If it
refuses, it says why and what to fix: commit your changes, sort out the
conflicting files, fix the check, or wait for whoever has uncommitted
changes in main's checkout. A failed check ends with the
`./check.sh --only "..."` that runs just what failed, the quick way to see
your fix work.

### A landing outlives its tb

The `tb land` you run starts the landing in a process of its own and
follows it, copying its output and ending with its exit code
(`runner/src/land-detach.ts`). That process is started through a shell
that exits at once, so it's in no one's process group or tree: an agent's
tool time limit, the Land chip's hour or Ctrl-C stopping the `tb land`,
and everything under it, doesn't reach it. On 18 Nov a landing waited
1 h 55 min, took the lock and started the group check for nine branches,
and a few minutes in the agent's two-hour limit killed it, losing the
check for all nine.

- Stopped (SIGTERM, SIGINT, SIGHUP) before the landing holds the lock,
  the `tb land` passes the signal on, and the landing leaves the line and
  says so, as below. Killed outright, the landing notices its `tb` has
  gone within a second and does the same.
- Once it holds the lock, its check, the fast-forward and the push finish
  whatever happens to the `tb land`, which says so as it stops, with the
  folder its output goes on in (`$TMPDIR/tb-land-*`, `out` and `err`). A
  `tb land` run again in that worktree waits for it ("Another tb land is
  running in this worktree"), then says what landed.
- A landing that has waited 90 minutes or more says, each time it says
  where it is, that a time limit may stop it before it gets the lock.
- On Windows there's no `/bin/sh` to start it from, so `tb land` runs the
  landing itself, as it did before.

After landing, the branch stays and the thread can carry on: the next
`tb land` lands only what's new. `tb land --dry-run` does steps 1 to 3 and
says what would land.

### Red on GitHub

The quick check runs on Tinker Desk or the cloud box, so it can't see what
only GitHub's machines do: the Desktop app workflow (`desktop.yml`) was red
on every push of main for two days (10 to 12 Nov) while GPUI landings went
on top of it, over a Windows link error, GitHub's Macs' bash 3.2 and Linux's
words for Finder and ⌘Q. Running the behaviour specs in the quick check
wouldn't have caught any of that (they pass on Tinker Desk), and all of them
take 15 to 30 minutes a system, so GitHub's own result is watched instead.

The runner, Convex and website tests (`runner.yml`), Android (`android.yml`)
and the Xcode 26 builds (`xcode-26.yml`) are watched too since 19 Nov:
`runner.yml` was red on Windows from 16 to 19 Nov, and as the daily release
waits for every workflow to pass on one commit, none went out. And the
TypeScript lint (`lint.yml`) since 22 Nov, and the repo guards
(`guards.yml`) since 23 Nov. A workflow opts in with a line of its own in
its file (the words are from when it held landings):

```yaml
# tb land: hold while red
```

Until 24 Nov a red one held every landing that changed what it checks.
That held 31% of threads in the days before, 40% of those just went round
it with `--despite-red`, and `desktop.yml`'s runs take 40 to 80 minutes and
failed about a third of the time, so it was mostly a detour. Now red holds
nothing. Instead:

- **One thread fixes it.** `tb red-watch`, run every 10 minutes by a
  schedule's check on Mike's Mac (`tb red-watch --quiet`, which prints
  nothing unless it couldn't do its job, so the schedule never starts an
  agent), asks GitHub how each marked workflow's last finished run on main
  went (`runner/src/red-watch.ts`). The first time one is red it starts a
  thread in the repo's checkout, "Started by GitHub" like the Sentry
  watch's, with the run, the jobs and steps that failed, and to fix it and
  land. That thread is the one for the red stretch: a newer failed run is
  sent to it, never a second thread, and so is the news when the workflow
  passes again (a failed rerun of the same run counts as newer), as the
  runner's note ("Sent by the runner: main's CI failed again"), not a
  message from Mike (until 25 Nov they were stored as his). A start
  whose answer was lost is found again by its title ("Fix <name> (<file>),
  red on main") or why in that repo, so it isn't started twice. A later red stretch starts a new thread, unless the last
  one is still open (not archived), which is told instead; one that was
  deleted is left alone for the rest of its stretch. What it knows is in
  `threadbear-land-gate/red-watch/<workflow>.json`.
- **A landing says so in one line.** After rebasing, `tb land` lists what
  the branch changes, and for each marked workflow whose `on: push: paths:`
  match any of it says, when its last run on main is red, `<name>
  (<file>) is red on main (<run>, failed: <jobs>); this lands anyway, and
  fix thread <id> is on it` (or that none is yet). Then it lands as usual.
  `--despite-red` is still taken, and does nothing.

A run cancelled for a newer push, or by hand, says nothing about main and
is passed over. One cancelled because a job ran into its own
`timeout-minutes` is red: GitHub calls both `cancelled`, and only the job's
annotation ("exceeded the maximum execution time") tells them apart. From
22 Nov `runner.yml`'s Mac jobs hit their 30 minutes on every push of main
and nothing noticed. So a cancelled run has its jobs read, and each
cancelled job that ran a minute or more its annotations (every page), a
few runs a look, and what was found is kept by run and attempt in
`threadbear-land-gate/cancelled-runs.json`. Not only jobs as long as the
workflow's timeouts are now: a fix that raises one would pass over the run
that timed out, and the older green run behind it would count. A whole page of cancelled runs,
or a trigger it can't read (an alias, a list over several lines, which
counts as every file), is as before.
A watched workflow mustn't cancel its runs on main for newer pushes, or a
busy day never finishes one: `desktop.yml` cancels in progress only for
pull requests, so main's runs go one at a time, with the newest push
waiting in place of any before it.

The fix thread starts from `gh run view <id> --log-failed`; for a job that
timed out, `--log`, whose end shows how far it got: in `runner.yml` the
unit tests print a line a minute with the test files still running, and the
slowest ones at the end, `runner/test/helpers/progress-reporter.mjs`.
GitHub's answer is kept in the repo's git folder
(`threadbear-land-gate/`), shared by every worktree and `tb red-watch`:
one from the last minute is used without asking again, as a dozen threads
landing at once ran out GitHub's shared API allowance (13 Nov). When `gh`
isn't installed, isn't signed in or can't reach GitHub (a 403 for that
allowance too), an answer from the last half hour still counts; with none,
there's nothing to say and nothing is started.

The schedule is Mike's own (Scheduled view, "Red on GitHub"): to watch a
copy of your own, make one that runs every 10 minutes in the repo's folder
with `tb red-watch --quiet` as its check, sending to a thread of its own,
so only a broken check ever reaches it.

In someone else's copy it stays out of the way. Since 19 Nov every
workflow's jobs only run in `mikecann/threadbear` (or when started by hand),
as a fork's owner only builds and checks for their own system and their
pushes were running every job on Linux, Mac, Windows and Android, mostly
red. A marked workflow whose `if:` names one repo (`github.repository ==
'owner/name'`) counts only where origin is that repo; in a fork, gh reads the
`upstream` remote's runs first, so before this Mike's red Windows build held
landings that only had to work on a Mac.

### Landing together

A check takes 5 to 9 minutes on the check hosts, and on 12 Nov a dozen
threads finished at once: one check each, one after another, left several
waiting over 40 minutes, and two were killed by their agents' time limits
still in the line. So landings that have to wait don't each get a check of
their own.

- Before waiting for the lock, a landing writes an entry in
  `threadbear-land-queue/` (beside the lock): its branch, worktree, the
  main it's rebased on, its commit and the check its patch asks for
  (`runner/src/land-queue.ts`). It holds a lock on the entry while it
  waits, which is how others know it's still there.
- Whoever takes the lock next stacks everyone waiting on main, first come
  first, then its own branch on top, without touching their worktrees
  (`git merge-tree` and `commit-tree`, with rebase's rules: a change
  already on main is left out, a commit made empty is kept). It
  checks that stack once, in its own worktree with HEAD detached at it, and
  fast-forwards main to the top. Its branch moves to its commits as they
  landed; each of the others finds its result in its entry within a few
  seconds, without waiting for the lock (until 24 Nov it waited for it, an
  hour once behind other groups' checks), moves its own branch to its
  commits as they landed, prints them and which branches were in the same
  check, and exits.
- The group's check runs in the holder's landing process (its tb's, "A
  landing outlives its tb" above), with its environment, so each
  entry also keeps the check hosts its own tb asked for
  (`THREADBEAR_CHECK_HOST`). The check gets them all, the holder's first, as
  `THREADBEAR_CHECK_PREFER`: `scripts/check-remote.sh` tries those hosts
  first and keeps the rest of its list behind them, so a landing that asked
  for the cloud box gets it when it's free, and a group that needs a Mac
  still goes to one. A group's check (`THREADBEAR_CHECK_GROUP`) always goes
  to runner.json's hosts, never only the holder's own list, and never to
  this Mac just because the holder's asked for that. On 13 Nov one that asked for the cloud box was
  checked on Tinker Desk, behind its long builds, in another's group.
- An entry is left out, to see to itself later, if it asks for a
  different check (or reads it from another folder), its worktree has
  moved on since it asked, it doesn't go onto the stack cleanly, its tb
  has gone before any check of it started, or (until 24 Nov, when red
  stopped holding landings: "Red on GitHub") the group's files would be
  held by a workflow red on GitHub. A dry run and a branch with a merge on it
  are never put in anyone's check.
- One whose tb goes during the check (killed: a session restart does
  that) still lands, as long as its branch still has what it asked to
  land: as it was, with more on top, or rebased (its next `tb land`
  rebases before it waits). Its branch is moved to what landed for it
  if it's still on what it asked, or, if that worktree is busy,
  `threadbear-land-done/<commit>` (beside the lock) says what landed,
  and its next `tb land` moves it there first; one rebased meanwhile
  drops what's already on main. Either way that `tb land` then says
  there's nothing to land. Only one whose branch was rewritten without
  those commits (amended, reset) means the check runs again without it.
  On 12 Nov restarts killed waiting landings again and again, and
  checking again for each meant two passing group checks in a row landed
  nothing; on 23 Nov a rebase by a killed landing's next `tb land` threw
  away two passing checks of six and ten.
- Once a holder has put it in a check (`inCheckAt` in its entry), a
  landing stays in the line after its tb has gone, and each holder after
  carries it, until a check with it passes and it lands, it's refused or
  set aside to be checked alone, its branch drops those commits, or 12
  hours go by. So a passing check that still doesn't land (GitHub went
  red, main's checkout was busy, another's branch was rewritten) never
  loses it: on 23 Nov one killed by its agent's two-hour limit was in a
  group that passed and was then held for red, and the next holder landed
  the rest without it. Its branch's next `tb land` takes its place in the
  line (one entry per branch), carried as it was, unless it's in the
  check running then, which decides it. Halved to one, it's still checked
  with one holder, having no tb to check it alone. Commits count as the same across a rebase
  only with the same author, message and change (not git's patch id,
  which ignores whitespace), and a moved branch with a commit made empty
  on purpose counts as rewritten, as its next rebase would land that
  commit again. One that leaves the line after a holder stacked it, before
  the check starts, is left out and the rest stacked again. Older `tb`s
  (before 23 Nov) don't know `inCheckAt` and drop such an entry when they
  read the line, so until every queued landing runs this version, one may
  still be lost that way.
- A tb killed during a group check leaves its worktree detached at the
  stack (its branch is untouched) and a marker in the worktree's git dir;
  the next `tb land` there checks the branch out again. Commits made on
  the detached stack meanwhile (a fix committed while the check ran) are
  first carried onto the branch, as a rebase would, and said; if they
  don't go on cleanly, `tb land` stops with their ids and how to keep them
  (`git cherry-pick`), leaving HEAD on them. A running `tb land` does the
  same when it goes back to the branch, then stops without landing, so the
  next run lands them too. On 13 Nov a fix committed there was checked out
  away silently and the same check failed again. Two `tb land`s in
  one worktree take turns (`threadbear-land-worktree.lock` in its git dir).
- A `tb land` stopped while it waits for the lock (SIGTERM, SIGINT or
  SIGHUP: an agent's time limit, Ctrl-C) leaves the line and prints that
  it has, with how to rejoin, so its thread doesn't think it's still
  queued. Killed outright, its entry is dropped by the next reader. Either
  way it's out: nobody would hear how it went, and it may have been
  stopped on purpose. Not once a check of it has started: then it stays
  in the line, as above, and says so.
- Until 24 Nov, when red stopped holding landings (see "Red on GitHub"),
  a landing made with `tb land --despite-red` was the repair for what's
  red, so it was a fix in the queue. The flag does nothing now, so no
  landing is one, but the queue still knows them: it goes first on the stack in every
  group check, outside the group's limit, and the red hold isn't asked
  about its files (the others' still are). So a repair queued behind
  groups failing on main's own error goes into the next check with them,
  rather than waiting for the halving to finish (13 Nov: three group
  checks failed on a broken main while its one-line repair waited). That
  holds only while main may be what's broken: a failed group halves its
  fixes with the rest (`ordinaryAt` in their entries, on that main), and
  they ride free again only once main is seen to fail some of what failed
  by itself ("Finding who broke a group"). On 18 Nov GitHub's desktop
  workflow was red all day, most of a line of fourteen landed with
  `--despite-red`, and two of them that failed only together were in every
  group. If a group with only fixes and the holder fails, the fixes are
  left out next, so a broken "fix" is still found.
- When the halving narrows a holder's group and a later check without
  some of the failed group passes and lands, those left out are where the
  failure was. One by itself, and any fix among them, is set aside
  (`alone` in its entry): never stacked into anyone's group again, its own
  tb checks it by itself when its turn comes, and says so, as does its
  waiting line. It isn't refused, as it may only fail with that holder.
  Several left out keep the limit the halving gave them, moved onto the
  main that just landed, rather than lapsing.
- If a group's check fails, nothing lands. The holder first looks for the
  landing that broke it ("Finding who broke a group", below). When that
  can't say, the group is halved: the
  holder goes again with itself and the first half, and the rest wait with
  their limit halved too. Before retrying, the holder prints the exit code
  and last 40 lines of the failed check's output (up to 8,000 characters),
  including any retained log paths there. Wait for `tb land` to finish before
  editing the holder's worktree, which it still uses for retries.
  That is the group's result; an individual landing is
  only refused if its own check fails, so the one that broke it is found
  in a few checks, and the rest land. The halved limit goes on the
  others' entries as soon as the check fails, before anything slow, and
  is taken off again if the runs below name who broke it: on 18 Nov two
  holders' tbs were killed by their agents' two-hour command limit just
  after their groups failed (two landings that each passed feature
  pairing alone, but not together), the halving went with them, and the
  next holder stacked the same mix again. Those limits hold only on the main
  they were set on: once main moves, a failure on the old one says nothing
  about the new, and they lapse.
- While it waits, a landing says where it is: whose check is running and
  for how long, how many are waiting ahead of it, and roughly how long it
  has to go, from the last 20 checks in the times log below. If it is
  already in the running group, it says it is being checked and estimates
  only the rest of that check. Landings in the running group don't count
  as waiting ahead of anyone else. The status record includes the holder's
  pid and the entries being checked, so a check left by a dead holder is
  ignored, and a new landing on a branch already in the check isn't counted
  as being checked. Older holders' records still work, using their branch
  names. For a landing in the running group, a check that runs past the
  usual time says "longer than usual" instead of guessing how much longer.
  It says it again every three minutes.

So a landing waits for at most the check that's running and the next one,
unless a check fails.

The line moves only as fast as the check hosts let its checks start, as
every landing waits while one does. On 23 Nov landings' checks waited 2.6
hours in all, holding the lock, behind agents' builds, spec runs and checks
on Tinker Desk (one copied there for 949 s and then sat 36 minutes in its
line), while the cloud box could have run several. So a landing's check
(`THREADBEAR_CHECK_FIRST`, which tb land sets on every check it runs) goes
ahead of anything else waiting on its host: other checks, GPUI builds and
measurements wait while it does, and on Tinker Desk `heavy` starts no job
(`scripts/host-turn.sh`; it still waits for what's already running). And it
never stays in line on a busy host while another that can run it is free,
however long its copy there took (`scripts/check-remote.sh`, `leave_line`).
A check that needs no Mac goes to the cloud box first (runner.json's
`checkHosts` order), keeping Tinker Desk for the ones that do.

### Finding who broke a group

A thread runs a test file or two itself and leaves the whole suite to its
landing, so a fair share of branches reach the line broken: about a third
in the four days to 17 Nov. Each failed its whole group's check, and
halving then cost a whole check per step: 54 failed group checks, 9 hours
of the check hosts, a median wait of 35 minutes on 16 Nov, and four checks
before anything landed when the broken branch was the one at the front of
a group of eight.

So a failed check says what failed, and that alone is run on each landing:

- A failed `./check.sh` ends with `To run only what failed again:
  ./check.sh --only "..."`: the steps that failed, and for the runner's
  unit tests the files (when there are 8 or fewer). That command, run from
  the checkout's top (`tb land` takes no `--only`), runs just those, and says `skip ... (--only left it out)` for the rest. It's
  the quick way to see a fix work, too. A run with `--only` ends with
  `--only ran: "..."`, the steps of those asked for that it ran: exit 0
  alone doesn't tell passing a step from skipping it.
- When a group's check fails with that line, the holder runs the same check
  with `THREADBEAR_CHECK_ONLY` set to it on main first, then on each landing
  by itself: its own, then each of the others replayed onto main without
  the rest. A few test files are seconds each, plus the copy to the check
  host.
- A group check no host could run (exit 69: each host it tried ran out of
  disk during it, or none had room or answered; `scripts/check-remote.sh`)
  is nobody's failure: nothing is run alone or halved, the holder's
  `tb land` stops with the hosts' lines, and the rest go on in the line.
- Main runs it first, with every step it names run whether or not
  anything changed (`THREADBEAR_CHECK_ALL`, check.sh's `--all`: the Swift
  steps never run on main with nothing changed, and a skip is no pass).
  Only the steps main passes are run on the landings; one main fails by
  itself blames nobody, and when main passes none of them, or skipped
  one anyway, the group is halved as before. Each landing's own run is as
  check.sh would make it, so a step that runs only for what it changed
  (the Swift mock tests for the mock) runs only on the landings that
  change it, and passes on the rest.
- A fix (`--despite-red`) in the group, or as the holder, is looked for
  the same way: what main fails by itself is never blamed on anyone, and
  a broken "fix" is left out like any other. On 17 Nov half a line of
  eleven had landed with `--despite-red`, which then switched this off,
  and the halving kept the broken one (a fix, first in every group) in
  each holder's group in turn for over four hours.
- Those runs are in a checkout of tb land's own, `threadbear-land-alone/`
  beside the lock: a clone that borrows the repo's objects, not a worktree,
  so no thread's worktree has another's files come and go in it, and
  nothing that lists worktrees meets it. They go to the check host the
  group's check failed on and no other (a test that fails on the Linux box
  alone would otherwise pass for one landing on the Mac and get the next
  one refused), or nowhere (`THREADBEAR_CHECK_HOST_ONLY`): with no host,
  or a check command that itself says `--local` or `--e2e`, they say so
  (exit 4) and the group is halved as before. A run that names another
  host than the group's, or names one when the group's check named none,
  counts for nothing. A Linux host takes a run with `--only` when every
  step named is one it runs (the Node, site and cargo steps), whatever
  changed: main, where nothing has, would otherwise always need a Mac.
- A landing that fails it alone is left out and told so at once, with that
  run's output: its `tb land` stops waiting and exits 1 (`refused` in its
  queue entry). The holder's next check has itself and only the ones that
  passed alone, so it isn't failed again by someone who joined meanwhile.
- A run that says nothing either way (no host could take it, it was
  stopped) refuses nobody. If each passes alone, it takes two of them
  together, or it's a test that fails now and then: the group is halved.
- It's done once per landing for each step (or test file) that failed (a
  later failure of another step is looked into again: halving can leave a
  repair out and show main's own failure there), and for no longer than
  about one check takes. Each run is held to the time that's left
  (`THREADBEAR_CHECK_MAX_SECS`, which covers its wait in the host's line,
  and a stop of its whole process group after that), with a minute at
  least. When the time runs out, the ones seen to pass go into the next
  check and the rest wait their turn. Not with a `--despite-red` fix in
  the group, nor for a check read from a subfolder: those are halved.

Each of those runs leaves a line in the times log with `alone: true`,
`only` and `passed`, and none of `ok`, `check` and `intact`, so nothing that
reads the log for whole checks counts one.

### What passed before is skipped

On a Mac with no check host every landing's check ran from scratch: 20 to
25 minutes, mostly the runner's unit tests (Ville, 21 Nov 2026: "Keep track
of changes and only run the deltas"). So check.sh records each step, and
each runner unit test file, that passes, under a key made from what it
read (`scripts/check-cache.mjs`), and skips it while that key has a pass
from the last week. The line says ok, as it passed, and why it took no time:

```
ok    web tests               0s  (skipped: passed with the same inputs 21 Nov 17:04 on thread/4f12cc1e)
ok    runner unit tests      94s  (skipped 301 test files that passed with what they read now)
```

- The key is what the files hold and their modes (git's blob ids, and
  whether each is executable or a link), never a commit, so a
  pass counts in every worktree and in `tb land`'s own checkout, after a
  rebase, and after a release comes in. A rebase that changes nothing
  reruns nothing; a release reruns what its files reach. It holds Node's
  version and the system too, so a pass on Linux never counts on a Mac.
- A step's key holds the files it reads (a table in check-cache.mjs, a
  superset of what check.sh looks at to run it; a step not in it reads
  everything), its command line and its tool's version (cargo and rustc,
  swift, npm; asked with `RUSTUP_AUTO_INSTALL=0`, so asking never downloads
  a toolchain, and a pass isn't recorded under a version that couldn't be
  read). The TypeScript checks and lint read every code file, as
  tsc follows imports out of runner/ and lint's type-aware rules read what
  a file imports.
- A test file's key holds its imports, followed all the way, and what the
  code it reaches reads at run time: a folder or file beside it
  (`path.join(import.meta.dirname, 'experiments')`), a script it starts
  from there and that script's imports, a whole path it names, and the
  `package.json` above each module. From the tests' side (tests, their
  helpers, the scripts they run) every name counts, joined paths
  (`path.join(ROOT, 'docs', 'protocol')`), the folders a test goes through
  by name, bare names in a script's loop, and the names in data a test
  reads (AGENTS.md's). A test that runs a command in the checkout itself
  (`git grep` with `cwd: REPO`) reads everything. Comment lines, and
  another test file named, don't count. Every key also holds the runner's
  packages and lockfile, the test helpers every file loads, git's and npm's
  settings files, check.sh and check-cache.mjs: changing the check reruns
  everything. `import type` doesn't count: Node strips it, and the
  typecheck covers it.
- On 22 Nov every test file was run under strace on Linux and what each
  opened compared with its key; the rules above are what that found
  missing, and check-cache.test.ts keeps each one. A test that reads a
  file by a name it builds some other way is still missed: say so in the
  test, with the whole path in a string, or the check skips it after a
  change to that file. A record past a week doesn't count, GitHub runs
  everything on main, and `tb land --full` asks for a check that reads no
  records.
- In a fork, a test file whose every file, the check's and the test
  helpers' included, is byte for byte as in Mike's newest release already
  in HEAD (`refs/threadbear/upstream/<date>`, whose signature the runner
  checked; never a `release/` tag, which anyone can make) is skipped as
  passed there: his main takes commits only through his check. Never in
  Mike's own copy (origin is mikecann/threadbear) or one with no origin;
  `THREADBEAR_CHECK_TRUST_RELEASE=off` turns it off.
- A failed run still records the files that passed, so the next check runs
  the ones that failed and whatever changed since, with no `--only`. A
  file with a test that skipped itself (no esbuild, not a Mac) isn't
  recorded, as why it skipped isn't in its key, and nothing is recorded
  under a key whose files changed while it ran (a test run with
  `UPDATE_CONTEXT_BUDGET=1` rewrites what it checks).
- `--all` reads no records (it still writes them). Nor does `--fresh`,
  which runs no more than the check would otherwise: `tb land --full` asks
  for it (`THREADBEAR_CHECK_FRESH=1`), and so do the runs that look for who
  broke a group (above), which must see what fails now. GitHub's runs
  (`GITHUB_ACTIONS`) keep none.
- The records are each machine's own: `~/Library/Caches/Threadbear/check-passes`
  on a Mac, `~/.cache/threadbear/check-passes` elsewhere, shared by every
  checkout, and on a check host `~/.cache/threadbear-check/passes`, kept
  between runs. `THREADBEAR_CHECK_PASSES` names another folder or says
  `off`; `"checkPasses": false` in runner.json turns them off, on the check
  host too (check.sh sends `--no-records` with the run). A run with a
  `THREADBEAR_HOME` of its own (a test's) keeps none unless it names a
  folder, and no test file inherits the folder a check names.
- Beside them, `test-times` holds how long each runner unit test file took
  last, and the next run starts the longest first (`node --test` starts
  them by name, and a long file late in the alphabet held the run up). A
  file's time only orders the run: it never skips anything.

The runner's code imports itself densely (a test file reaches about 280
files on median), so a change to `runner/src` still reruns about two
thirds of the test files, and one to `convex/` most of them. A change to
desktop/, features/ or the site reruns a few dozen, mostly the tooling
tests whose scripts name those folders. This took the place of
`runner/test/tooling-tests.mjs`, which left the slow tooling tests out of
`--quick` when nothing they read changed: a pass record covers that, once
each has passed with those files on that machine.

### Where a landing's time goes

A passing check prints nothing of its own, so each one leaves a line in
`threadbear-land-times.log`, beside the lock in the repo's common git
directory (`.git/` in the main checkout), passes and failures alike:

```json
{"at":"2026-11-09T08:30:52.000Z","branch":"thread/abcd1234","commit":"9763e488...","ok":true,
 "seconds":188,"waitedSeconds":310,"host":"tinker-desk","copySeconds":2,
 "steps":[{"name":"runner unit tests","status":"ok","seconds":180}]}
```

`seconds` is the check, `waitedSeconds` the wait for the landing lock,
`check` the command, `intact` that the worktree was still at that commit
with nothing changed when the check ended,
`together` the other branches in the same check (when there were any), and
`steps` whatever check.sh printed; another repo's check just has none. A
failed one has `exit`, a dry run `dryRun: true`, and a step that only passed
when check.sh ran its failing files again has `secondRun`, naming the tests.
Past 1 MiB it's cut back to the newest 1000 lines. It stays on this Mac,
and a log that can't be written never stops a landing.

The runner's updater reads it too: a commit with a passing line here from
a check host, with the runner's typecheck and unit tests run, is built
without running them again (docs/dev-tools.md, "The runner updating
itself"). `host` and `steps` are the last run's: a host that dropped out
partway, or a run that fell back to this Mac, leaves none of its own. A
check split across a Linux host and a Mac (docs/dev-tools.md, section 4)
has both, `"host":"cloud+tinker-desk"`, and the steps of both halves; tb
land runs what failed in one on that pair, which sends each step back to
the host it ran on.

## Cleaning up

elie-h's fork, approved 9 Nov 2026: a repo whose setup makes something
outside the folder (a Convex deployment per worktree, say) needs it gone
when the thread is done, and lands through squashed GitHub PRs, which git
never counts as merged, so nothing below would ever clean it up. So the
patch's `teardown`, if it has one, runs first, in the worktree's root, on
every archive and delete, landed or not, and for a worktree kept as a
spare too (what the thread made is its own). It's the worktree's own copy
of the patch that's read, as the thread's branch has it then, and only
when that copy (with the scripts it names, as they are there) is trusted,
as for `setup`; otherwise a note says it didn't run and why, so a teardown
changed on the branch needs trusting like any other patch change. Its
output goes in the transcript as an `action.run` event (`trigger:
"worktree.teardown"`); a deleted thread has no transcript, so it gets a
notice only if the teardown didn't run or failed. It has the action
timeout (SIGTERM to everything it started, then SIGKILL two seconds on,
as for setup and hooks), and a failure is shown but never stops the
cleanup. It only runs while the folder is still a checkout of the
thread's branch (see below on reused slots).

It's part of the cleanup, so everything that waits for the cleanup (a
handover, a message sent meanwhile, an action pressed) waits for it too. It
runs once per archive (`tornDownAt` in the record): a delete after the
archive, or the next runner picking up a cleanup that was owed, doesn't run
it again. A thread brought back to a worktree that stayed carries on there
as before, and its next turn says, to Mike and the agent, that the teardown
ran, so whatever setup made may be gone and setup may need running again
(it isn't run again by itself: setups are written for a fresh worktree).
Archived again, it tears down again. Since a runner stopping partway runs
it again next time, a teardown should be safe to run twice.

When a thread with a worktree is archived or deleted: if its branch is
merged into main (or has no commits of its own), the worktree is removed
(`git worktree remove`, `--force` only for untracked files) and the branch
deleted. A branch also counts as merged when every commit on it has an equal patch on
main (`git cherry`, with no merge commits in between) or merging it into main
would change no file: its commits landed under other ids (a `tb land` rebase,
or another thread's cherry-pick or squash), even if main later edited the same
files. Its status is read again just before it's locked as a spare or
removed, and an edit made meanwhile puts it back on its branch, kept: on 21
Nov one made after the first look would have gone into the spare, for the
next thread's `reset --hard`, or out with the folder under `--force`. Otherwise both stay, with a `system.note` saying so and how to
land or drop them. Once a day (and 10 minutes after the runner starts),
archived threads whose worktree stayed get the cleanup again, so one whose
work has landed since goes. That sweep adds no note when a worktree still
stays. When a worktree still stays two days after its thread was archived,
the runner starts a cleanup thread that checks what each one holds, removes
safe leftovers automatically (work already on main in another form,
superseded, obsolete or abandoned) and archives itself, asking you only in
plain words when a worktree holds genuine unlanded work. Each branch tip is
checked once (`runner/worktree-question.json`), and nothing new starts
while that thread is open. Unarchiving a thread whose worktree was removed starts
its next turn in the main checkout, with a note.

An archive's cleanup waits for the thread's turn-end hooks, which run in that
folder: on 7 Nov a typecheck lost its files partway through, "failed", and
woke the thread just archived. A restart waits for those hooks and a handover
keeps the thread while they run, for the same reason. A hook failure told to
the agent brings the thread back in its worktree, so nothing gets removed; one
that isn't told (`tell: "never"`, or past the limit) leaves it archived and the
cleanup goes ahead. If the runner stops or crashes first, the next one does the
cleanup (`cleanupOwed` in the worktree's record). Deleting a thread doesn't
wait: nothing is left to report a hook's result to.

The folder is only removed while it's still a checkout of the thread's own
branch, and the worktree git made there itself: not a link to somewhere
else (git's own list follows one, so a link to the main checkout passed
for the worktree, Codex's review, 9 Nov), and its own `.git` names the
repo's record of it, which names it back, checked again just before
each git that reads or changes the folder and just before the teardown
starts, which then runs by the path checked, on the thread's branch (or,
for the removal, the commit the cleanup itself detached it at), never
another. Every git the cleanup runs is killed after five minutes and counts
as failed, which stops the cleanup rather than reading as an answer (a
branch that isn't there, say); `tb land` stops the same way. Slot folders are reused, and a record can miss hearing its worktree
went (THREADBEAR-16, 6 Nov: a handover saved it while the cleanup ran; a
handover now keeps that thread until the cleanup is done, for up to ten
minutes, while the rest move across). A folder that's
another checkout's now is left alone and the thread treats it as a spare's.
At start, an archived thread whose branch is gone, and whose folder is gone
or another checkout's, is marked removed. A message sent while the cleanup
runs waits for it, so the turn never starts in a folder being removed.

## Reusing worktrees

Mike, 2026-10-29: removing a sound effect took a thread 18 minutes, 17 of
them `./check.sh --app` in a worktree that had never built. SwiftPM's
`.build` only works in the folder it was built in (copying main's, even
as an APFS clone, still rebuilt everything: 297 s), so every new worktree
paid 5 to 10 minutes for its first app build, more with other threads
compiling at once.

So a patch can list its build caches:

```ts
worktree: { setup: "...", check: "...", keep: ["app/.build", "dock/.build"] },
```

With `keep`:

- New worktrees are `<repo>-threads/slot-<n>`, not `<id8>`, as the folder
  outlives the thread: the first number with no folder that git doesn't
  still have registered (its folder removed by hand), trying the next when
  git refuses one, a few times, and deleting the branch a refused add made.
  On 21 Nov a slot removed by hand would have left every new thread with no
  spare in the main checkout, and its branch refusing its next try.
- Cleaning up a landed one detaches it, deletes its branch and locks it
  (`git worktree lock --reason "threadbear spare"`): a spare. Past six
  spares (`MAX_SPARES`), it's removed as before.
- A new thread takes a spare if there is one: renaming git's `locked`
  file away is the claim, so two threads (or a thread and
  `borrow-worktree.sh`) never get the same one. (`git worktree unlock`
  isn't: two at once both succeed.) Then `git reset --hard`, `git clean -ffdx` with the kept folders
  left out (an old thread's `node_modules` goes, its build cache stays),
  and `git checkout -b thread/<id8> main`. Setup runs as for a new one.
  A spare with changes to tracked files is passed over and left unlocked,
  out of the pool: its cleanup or give-back saw it clean, so someone is
  working there, and the reset would take their work.
  `borrow-worktree.sh` does the same.
- A patch's `teardown` runs before the worktree is set aside, as for one
  that's removed: what the thread made is its own, not the next thread's.
- A worktree that has to stay (work not on main, uncommitted changes)
  can't be a spare, so no other thread will use its kept folders: they're
  deleted, with a line in the note saying so (`clearBuildCaches`). Mike, 13
  Nov 2026: such slots held 39 GB of app builds, and he asked for build
  files to go once no thread can use them. A thread brought back builds
  again. Only while the folder is still the thread's own checkout, and only
  real folders inside it, never through a link; each is renamed aside right
  after that check, then deleted.
- With the `buildCacheCleanup` experiment on (`runner/src/build-cache-cleanup.ts`),
  an hourly sweep also clears git-ignored Cargo `CACHEDIR.TAG` build folders
  (like `desktop/target`) not listed in `keep` from spare, kept-archived and
  long-idle open worktrees (plus stale shared build caches under
  `~/Library/Caches/Threadbear` and `~/.cache/threadbear-check/local-builds`),
  and sweeps aggressively whenever free disk drops below 10 GiB.
- The record keeps `keep`, and `spare: true` once it's set aside. What the
  record says of the worktree (held, cleanup owed, removed, handed on) is
  one state type in `runner/src/slot.ts`, with every write in its
  `writeSlot`; the same module says what each slot folder is on disk
  (`slotOnDisk`: a spare, a thread's, a borrow, left behind, and the
  disagreements, like a record whose folder is on another branch), which
  the borrow sweep picks from. A
  spare's thread, unarchived, never goes back into that folder even though
  it's still there: it's another thread's now. Nor does any thread whose
  worktree was removed, whatever is at that path now: on 8 Nov a removed
  slot-10 was made again by `borrow-worktree.sh`, and the thread brought
  back carried on in it beside the borrower's work. Its next message gives
  it a fresh worktree from main instead, as a new thread gets (a spare, if
  there is one), and only if that fails does it carry on in the main
  checkout. Until 16 Nov it always went to the main checkout; with helper
  threads archiving themselves and their starters writing to them again,
  24 came back there in four days and each had to borrow a worktree.

A thread started outside the repo (in `~/dev/me/misc`, say) still needs a
worktree of its own, as another thread may be editing the main checkout. It
borrows a spare by hand with `./borrow-worktree.sh` in the main checkout,
commits there, runs `tb land` in it, and gives it back with
`--give-back <dir>` so the next thread gets it. Don't `git worktree add` a
fresh one: its first app build takes 5 to 10 minutes. The
borrowed one is on a branch of its own, `thread/borrow-<slot>-<time>`,
so `tb land` in it lands it like any thread's (it only lands a `thread/`
branch); giving it back deletes that branch. It takes a branch whose
commits are all on main, by id or by patch (a group check rebases the
branch again before main moves, so main can have them under new ids),
and refuses one with any commit main hasn't got. Run in a thread, `tb land`
refuses another thread's `thread/<id8>` branch: someone else is working
in that folder (`THREADBEAR_THREAD_ID= tb land` lands it anyway).

### Borrows nobody gives back

On 17 Nov 2026 every slot up to borrow-worktree.sh's cap of 50 was taken,
25 of them by borrows landed days before and never given back (threads
that land and move on, and a `sync-main.sh` killed mid-check), so
sync-main couldn't borrow one and main wasn't pushed. Now:

- `borrow-worktree.sh` has no cap: it takes the first free slot number.
- It writes who borrowed beside git's files, `<worktree's git
  dir>/threadbear-borrow`: `thread=` (`THREADBEAR_THREAD_ID`), `home=`
  (its runner's data dir), `branch=` (the borrow branch), `pid=`
  (`THREADBEAR_BORROW_PID`, for a script that gives it back itself),
  `scratch=1` (`THREADBEAR_BORROW_SCRATCH`: what's in it may be thrown
  away once that process has gone) and `at=`. `--give-back` removes it.
- `sync-main.sh` gives its borrow back however it ends (a failure, a
  stop, success), and borrows as a scratch one under its own process id,
  so even a SIGKILL leaves nothing for long. A failed borrow fails the
  script, saying main wasn't moved or pushed.
- The runner (`runner/src/borrows.ts`), two minutes after it starts and
  then hourly, takes back a borrow in any repo its threads have had
  worktrees in when its borrower has gone: its process has ended, its
  thread is archived, or, with neither recorded (or a thread this runner
  doesn't have), nothing has happened there for a day (git's HEAD log).
  A live process's borrow and an open thread's are never taken, however
  quiet, nor one from another runner's thread (a dev runner's) while
  that runner's data dir is there. Nor is anything
  with work in it: a rebase or merge half done, changes or untracked
  files, commits not on main (on it by patch counts, as for
  `--give-back`), or a process whose current folder is
  inside, asked again after it's detached (a commit made meanwhile puts
  it back on its branch), with `branch -d` so git itself refuses a branch
  not on main, and each change made only while the folder is still the
  checkout git made there (not a link) with the same borrow record, on
  the branch it was borrowed on (a rebase's own branch counts). Its status
  is read once more just before it's locked, and its thread's state
  before each change (a thread brought back keeps it). A
  process list that can't be read in full stops the sweep. The one exception is a scratch borrow whose process has gone:
  what it left half done is aborted and reset to main first. A detached,
  unlocked slot no thread holds (a spare claimed and never set up) goes
  back the same way after a quiet day, as does a borrow left detached by a
  give-back that was stopped half way. `borrow-worktree.sh` passes over
  slot numbers git still has registered after their folder went. Taken back is what `--give-back`
  does: detached, its branch deleted, locked as a spare, or removed when
  there are six spares already. `thread/borrow-*` branches with no
  checkout and all on main are deleted too. The runner's log says what it
  took back and why.

### A folder a thread works in is never lent

A thread started outside the repo can borrow a slot and move itself there
(`move_thread`), so its folder is the slot with no worktree record of its
own. On 22 Nov 2026 the Canvas thread did that with slot-32, landed, gave
it back and stayed in it. The next morning `borrow-worktree.sh` lent
slot-32 to another thread, and a minute later the Canvas thread's next turn
committed on that borrower's branch and left its changes there. Now:

- Nothing hands out a slot an open thread's folder is in.
  `borrow-worktree.sh` asks `runner/src/lived-in.ts`, which reads every
  thread record in each runner data dir it knows of
  (`THREADBEAR_RUNNER_HOME`, `THREADBEAR_HOME`, the default), following
  links, and passes over such a spare, and a slot number whose folder went
  but that an open thread's record still names. When a record can't be
  read it takes no spare and makes a new slot. The runner's own
  `makeWorktree` does the same (`inUse`), from its threads as each folder
  is asked about and from other runners' records. An archived thread works
  nowhere, and a thread still in its own removed or handed-on worktree
  leaves it at its next turn anyway, so neither holds a slot.
- A thread with no worktree of its own whose folder is a slot that went to
  someone else after it moved there never carries on in it
  (`lentFolder` in `runner/src/runner/worktrees.ts`): a spare or one being
  claimed, a borrow of another's begun since (the borrow record's `at`), or
  the worktree of a thread that came to it since. The record's `cwdAt`
  says when it moved there (its `createdAt` for a record from before), to
  the second as borrows are stamped, a tie counting as since. Its next
  turn, after any wait, ends a live CLI there (a give-back in its own session, a Codex session
  moved in) and, like a thread brought back to a removed worktree, it
  carries on in a fresh worktree from main (the very slot, when it's a
  spare nobody else is in), or the main checkout if none can be made, and
  the thread and agent are told. That covers a thread archived in its
  borrow, the borrow taken back and lent again, and the thread brought back.
- A thread put in someone's slot after it was theirs stays: its own borrow,
  a Lab review's reviewers (made in the thread's folder with
  `worktree: false`), a helper made there, a move there. So
  does a borrow from before 17 Nov, which names nobody.

Run in a thread, `tb land` lands the thread's own worktree from that
worktree, from its repo's main checkout, or from a folder outside git.
From any other checkout the folder wins: a thread's sub-agents work in
worktrees of their own and inherit its `THREADBEAR_THREAD_ID`, and on 11
Nov one's `tb land` went for the parent's half-done branch. If that
checkout can't be landed, it says so and that the thread's own wasn't
touched. Besides `thread/` branches it takes Claude Code's own worktrees,
`.claude/worktrees/<name>` on `worktree-<name>`: they're made for one
helper's work and thrown away, which is what the `thread/` rule is
there to tell apart from main and branches kept by hand.

A hand-merge, landing without `tb land`, holds the same landing lock (a
plain `git merge` outside it wastes the queued checks).
From the worktree, on a Mac:

```sh
/usr/bin/lockf -k "$(git rev-parse --git-common-dir)/threadbear-land.lock" /bin/sh /path/to/landing-script
```

On Linux use `flock -x` in place of `/usr/bin/lockf -k`. The script must
rebase on current main, run the required checks on that combined revision,
and fast-forward main, with the lock held for the whole sequence. Stop on
any failure. Don't call `tb land` inside the script: it takes the same lock
and would wait on itself. A plain git merge outside the lock can move main
under a landing whose check is already running. A check from before a
rebase cannot validate the new combination, even when files don't overlap.

### Syncing main with GitHub

Main on this Mac moves by `tb land`; GitHub's moves by pushes and merged
PRs (CONTRIBUTING edits made on GitHub, say).

With the repo's main checkout in runner.json's `pushAfterLanding` (Mike's
lists this repo), each landing does it: once main has moved, still holding
the lock, `tb land` fetches GitHub's main and

- when GitHub's is behind, pushes;
- when GitHub's has commits of its own, merges them in (a merge commit,
  never a rebase: main here only ever fast-forwards, so no waiting
  landing's base is rewritten), runs the landing's check on that merge in
  `threadbear-land-alone/`, fast-forwards main to it and pushes. A
  conflict or a failed check leaves main as it landed and says why, and
  isn't tried again for that same GitHub main for six hours
  (`threadbear-land-push.json` beside the lock), as each try is a whole
  check with everyone waiting behind it. A check that changes files or
  moves HEAD in that checkout as it runs doesn't count. The landing itself
  has landed either way.

On 17 Nov GitHub's main had three commits of its own while landings came
all afternoon: `scripts/sync-main.sh` waited over an hour for the landing
lock and never got it (lockf isn't a fair queue), and GitHub's main was 36
commits and 9 hours behind.

`scripts/sync-main.sh` (from any checkout) does the same by hand, for a
repo without `pushAfterLanding` or when nothing is landing:

- only this Mac's has moved (the usual case): pushes main straight away,
  without waiting for the landing lock. A push moves only GitHub's main,
  as a fast-forward or not at all, so it can't race a landing; with
  landings queued, the wait for the lock was over 30 minutes (13 Nov).

- both have moved, with `pushAfterLanding` on, the lock held and a real
  landing in the queue that says it will push (a dry run never does): leaves it to that landing
  and says so, rather than wait. Not when a landing's merge of that same
  GitHub main has already failed (it won't try again for hours): then it
  waits for the lock and tries itself.

Otherwise it takes the landing lock for the rest, so no landing can move
main meanwhile, then:

- only GitHub's has moved: fast-forwards main to it;
- both have: rebases this Mac's commits onto GitHub's (merges GitHub's
  in instead when this Mac's have a merge, which a rebase would flatten) in a borrowed
  worktree, runs `./check.sh --quick` on that (a combination nobody has
  checked), and only if it passes moves main to it (`git reset --keep`,
  refusing staged changes there, which that would unstage) and pushes. A conflict or a failed check leaves main as it was, and
  says which files or what failed.

Don't rebase main in its own checkout. A rebase there leaves HEAD
detached until it ends: a landing would then move that rather than main,
so `tb land` refuses while a rebase, merge, cherry-pick, revert or bisect
is in progress there (step 4) and the landings queue behind you. And a
hand-run `lockf ... git fetch; git rebase ...` holds the lock only for
the fetch: everything has to be inside the one locked command.

## Not in v1

- Repos that aren't on `main`.
- Moving a thread with a worktree to another folder (allowed, the worktree
  just stays where it is until the thread is archived).
- Showing the branch in the app beyond the summary field.
- Projects (docs/archive/projects-design.md): when patches load from project
  folders, `worktree` still only counts from the thread's own folder chain.
