// GitHub Actions runs in a thread's Highlights (ci-runs.ts;
// docs/protocol/panels.md, "Highlights"), and a thread hibernating until
// runs finish (end_turn's waitForRuns: waitRuns, settleRunsWait). Looked at when a command's
// result looks like a push or a `gh workflow run`, and when a client fetches
// the thread's highlights (so a restart picks them up again). Then again on
// a timer, only while a run is queued or running, and never for an archived
// thread. Each method's `this` is the Runner; runner.ts puts them on its
// prototype.
import { execFile } from 'node:child_process';
import type { Runner, ThreadState } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { EventBody } from '../protocol.ts';
import { loginShell } from '../system-tools.ts';
import path from 'node:path';
import { addWatches, check, delayMs, emptyCiRuns, FIRST_DELAY_MS, shellQuote, waitKeys, waitMessage, waitResult, watching, type FindCommit, type Gh, type RunsWait } from '../ci-runs.ts';
import { parseWhen } from '../when.ts';
import { localWhen } from '../wake-when.ts';
import { WAIT_FOR_DEFAULT_MS } from './hibernation.ts';

// The first look waits a little: GitHub makes the runs a few seconds after
// the push.
const FIRST_LOOK_MS = 5_000;
const GH_TIMEOUT_MS = 20_000;

// A tool result that may have set off runs: git push's "a..b x -> y" or
// "[new branch]" line, or what `gh workflow run` or `gh run rerun` prints.
const MAYBE_RUNS = /->|workflow_dispatch|actions\/runs\/|[Rr]equested rerun/;
const MAYBE_RUN_COMMAND = /\bgit\b[^\n]*\bpush\b|\bgh\s+(?:workflow\s+run|run\s+rerun)\b/;

export type CiShell = (cwd: string, command: string) => Promise<string>;

// A thread in a folder of repos pushes from one of them after a `cd` in an
// earlier command, often with the push's output cut short (`| tail -2`), so
// neither its folder nor its repo is known (14 Nov 2026). The first repo or
// worktree a level or two down that has the commit: its folder, then the
// full sha. One shell, at most 300 repos, once per pushed commit.
function findInRepos(commit: string): string {
  return `find . -mindepth 2 -maxdepth 3 -name .git -not -path '*/node_modules/*' 2>/dev/null | head -n 300 | while IFS= read -r g; do d="\${g%/.git}"; f=$(git -C "$d" rev-parse --verify -q ${commit} 2>/dev/null) && { printf '%s\\n%s\\n' "$d" "$f"; break; }; done; true`;
}

function shell(cwd: string, command: string): Promise<string> {
  const [bin, ...args] = loginShell();
  return new Promise((resolve, reject) => {
    execFile(bin, [...args, command], { cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

export const ciRunsPart = {
  // From emit: the result of a command that may have set off runs (a push,
  // `gh workflow run`, `gh run rerun`), told by the command, as gh prints
  // nothing for a re-run outside a terminal, or by what it printed.
  ciRunsEvent(this: Runner, st: ThreadState, body: EventBody): void {
    if (body.type === 'tool.call') {
      const command = (body.input as { command?: unknown } | undefined)?.command;
      if (typeof command === 'string' && MAYBE_RUN_COMMAND.test(command)) (st.rt.ciCalls ??= new Set()).add(body.itemId);
      return;
    }
    if (body.type !== 'tool.result') return;
    const asked = st.rt.ciCalls?.delete(body.itemId) ?? false;
    if (!body.ok || !(asked || MAYBE_RUNS.test(body.text ?? ''))) return;
    // After this event is in the log, so catching up sees it.
    queueMicrotask(() => this.kickCiRuns(st));
  },

  // Picks up anything new to watch and makes sure a look is booked.
  kickCiRuns(this: Runner, st: ThreadState): void {
    if (st.rt.deleted || st.rec.archivedAt) return;
    this.catchUpHighlights(st);
    const state = (st.rec.ciRuns ??= emptyCiRuns());
    const added = addWatches(state, st.rec.highlights!);
    if (added) this.markDirty(st);
    if (!watching(state) || st.rt.ciChecking) return;
    if (added) st.rt.ciTimer?.cancel();
    else if (st.rt.ciTimer) return;
    st.rt.ciTimer = this.clock.setTimeout(() => void this.checkCiRuns(st), added ? FIRST_LOOK_MS : delayMs(state));
  },

  async checkCiRuns(this: Runner, st: ThreadState): Promise<void> {
    st.rt.ciTimer = undefined;
    const state = st.rec.ciRuns;
    if (!state || st.rt.deleted || st.rec.archivedAt) return;
    const run = this.ciShell ?? shell;
    const cwd = st.rec.cwd;
    const gh: Gh = (args, dir) => run(dir ?? cwd, `gh ${shellQuote(args)}`);
    const findCommit: FindCommit = async (sha, dir) => {
      if (!/^[0-9a-f]{4,40}$/.test(sha)) return undefined;
      const commit = shellQuote([`${sha}^{commit}`]);
      for (const at of dir && dir !== cwd ? [dir, cwd] : [cwd]) {
        try {
          const full = (await run(at, `git rev-parse --verify -q ${commit}`)).trim();
          if (/^[0-9a-f]{40}$/.test(full)) return at === cwd ? { full } : { full, dir: at };
        } catch {
          // Not a repo, or not this one's commit.
        }
      }
      try {
        const [found, full] = (await run(cwd, findInRepos(commit))).trim().split('\n');
        if (found && /^[0-9a-f]{40}$/.test(full ?? '')) return { full: full!, dir: path.resolve(cwd, found) };
      } catch {
        // Nothing found.
      }
      return undefined;
    };
    st.rt.ciChecking = true;
    const open = state.watches.filter((w) => !w.done).length;
    let changed = false;
    try {
      changed = await check(state, gh, findCommit, this.clock.now());
    } finally {
      st.rt.ciChecking = false;
    }
    if (st.rt.deleted) return;
    // Saved only when something moved: a quiet look sends no summary.
    if (changed) this.highlightsChanged(st);
    else if (state.watches.filter((w) => !w.done).length !== open) this.markDirty(st);
    // A push while this look ran may have added a watch.
    addWatches(state, st.rec.highlights ?? { seq: 0, items: [], edited: [] });
    if (watching(state) && !st.rec.archivedAt && !st.rt.ciTimer) {
      st.rt.ciTimer = this.clock.setTimeout(() => void this.checkCiRuns(st), delayMs(state));
    }
    this.settleRunsWait(st);
  },

  // end_turn's waitForRuns, once the turn is over: hibernates until the
  // runs are over, a day at most (or the snooze time), then wakes with how
  // each went. Before this an agent waiting on CI booked a schedule with a
  // shell check, and each raised a card the phone couldn't allow (24 Nov 2026).
  waitRuns(this: Runner, st: ThreadState, wait: RunsWait, when: string | undefined): boolean {
    const { rec } = st;
    // Picks up this turn's pushes first.
    this.kickCiRuns(st);
    const state = (rec.ciRuns ??= emptyCiRuns());
    const now = this.clock.now();
    const keys = waitKeys(state, wait, now);
    this.markDirty(st);
    if (!keys.length) {
      // Nothing of its own going: it's told so, rather than sleeping a day.
      this.emit(st, { type: 'system.note', text: 'Not hibernated: none of this thread\'s GitHub workflow runs are queued or running.' });
      const latest = state.runs.slice(0, 5).map((r) => `- ${r.workflow}: ${r.status} ${r.url}`).join('\n');
      this.sendTo(st, `You asked to hibernate until this thread's GitHub workflow runs finish, but Threadbear isn't watching any that are queued or running${latest ? `. The latest it saw:\n${latest}` : ''}.\n\nIf the run is one this thread didn't start, end the turn again with waitForRuns naming it (its link, or { run, repo }). Otherwise carry on.`, [], { origin: 'runner', queue: true });
      return false;
    }
    let until: string | undefined;
    if (when && !['restart', 'release'].includes(when.toLowerCase())) {
      try {
        until = parseWhen(when, now);
      } catch {
        until = undefined;
      }
    }
    if (!until || Date.parse(until) <= now) until = new Date(now + WAIT_FOR_DEFAULT_MS).toISOString();
    this.update({ threadId: rec.id, snoozedUntil: until, noted: true });
    if (!this.park(st, { kind: 'forRuns', keys })) return false;
    this.markDirty(st);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.emit(st, { type: 'system.note', text: `Hibernating until its GitHub workflows finish, or ${localWhen(Date.parse(until), timeZone)} at the latest.` });
    // A named run needs a look booked: it came from no push.
    if (!st.rt.ciTimer && !st.rt.ciChecking) st.rt.ciTimer = this.clock.setTimeout(() => void this.checkCiRuns(st), FIRST_LOOK_MS);
    return true;
  },

  // Wakes a thread whose awaited runs are all over, with how each went.
  settleRunsWait(this: Runner, st: ThreadState): void {
    const keys = st.rec.waitingOnRuns;
    if (!keys || st.rt.deleted || st.rec.archivedAt || this.bucket(st.rec) !== 'snoozed') return;
    const res = waitResult(st.rec.ciRuns ?? emptyCiRuns(), keys);
    if (res.pending) return;
    const { text, why } = waitMessage(res);
    this.wake(st, { why });
    this.armSnoozeTimer();
    this.sendTo(st, text, [], { origin: 'runner', queue: true });
    this.log.info('woke after waiting on workflow runs', { threadId: st.rec.id, runs: res.runs.length, unfinished: res.unfinished.length });
  },

  // A start: threads hibernating until runs finish look again, as their
  // timers went with the last runner.
  resumeRunsWaits(this: Runner): void {
    for (const st of this.threads.values()) {
      if (!st.rec.waitingOnRuns || st.rt.deleted || st.rec.archivedAt) continue;
      this.kickCiRuns(st);
      if (!st.rt.ciTimer && !st.rt.ciChecking) st.rt.ciTimer = this.clock.setTimeout(() => void this.checkCiRuns(st), FIRST_DELAY_MS);
    }
  },
};

export type CiRunsPart = RunnerPart<typeof ciRunsPart>;
