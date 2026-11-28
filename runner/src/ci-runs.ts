// GitHub Actions runs a thread set off (docs/protocol/panels.md,
// "Highlights", Runs), and the runs a hibernating thread waits on (end_turn's
// waitForRuns, waitKeys and waitResult below). The commits a thread pushed and the workflows it
// started with `gh workflow run` are found with its highlights
// (highlights.ts); this asks the `gh` CLI, on the user's own login, for the
// runs each one started, and keeps asking only while one is queued or
// running. Pure apart from the `gh` passed in, so tests give a fake.
import type { HighlightState } from './highlights.ts';

export type CiRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped';

export type CiRun = {
  id: string; // "run:<GitHub's run id>"
  workflow: string;
  status: CiRunStatus;
  url: string;
  sha: string; // short
  branch?: string;
  event?: string; // push, pull_request, workflow_dispatch...
  at: string; // when GitHub made it
};

// One thing that sets off runs: a pushed commit, or a `gh workflow run`.
export type CiWatch = {
  key: string; // "commit:<short sha>" or "dispatch:<seq>"
  sha?: string; // short, as the commit line printed it
  full?: string; // the full sha, once looked up
  workflow?: string; // a dispatch's workflow
  ref?: string; // a dispatch's --ref
  runId?: number; // a dispatch's run, once found
  repo?: string; // owner/name, from the push's output or -R
  dir?: string; // the folder to ask git and gh in, when not the thread's
  since: string; // when it was pushed or dispatched
  done?: true; // nothing more to ask about
  found?: string[]; // its runs' ids ("run:<id>"), as last seen
  named?: true; // a run an agent named to wait on (end_turn's waitForRuns)
  fails?: number; // looks in a row that failed, for a named run
};

export type CiRunsState = {
  watches: CiWatch[];
  runs: CiRun[];
  quiet: number; // checks in a row that found nothing new
};

// What is shown: the newest this many. Watches past WATCHES_KEPT are let go.
export const RUNS_KEPT = 30;
const WATCHES_KEPT = 20;
// Waits between checks: 15 s, doubling while nothing changes, at most 2 min.
export const FIRST_DELAY_MS = 15_000;
const MAX_DELAY_MS = 120_000;
// A push with no runs after this has none coming (no workflows, or none on
// that branch). A watch is let go after GIVE_UP_MS whatever its state.
const NO_RUNS_MS = 3 * 60_000;
const GIVE_UP_MS = 2 * 60 * 60_000;
// Runs come a few seconds after a push: all done before this may have more.
const SETTLE_MS = 30_000;
// A named run gh can't see this many looks in a row is let go.
const NAMED_FAILS = 3;

export function emptyCiRuns(): CiRunsState {
  return { watches: [], runs: [], quiet: 0 };
}

export function delayMs(state: CiRunsState): number {
  return Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** Math.min(state.quiet, 4));
}

export function watching(state: CiRunsState): boolean {
  return state.watches.some((w) => !w.done);
}

// Picks up commits the thread has pushed and workflows it dispatched since
// last time. Returns whether there is anything new to watch.
export function addWatches(state: CiRunsState, hl: HighlightState): boolean {
  let added = false;
  const have = new Set(state.watches.map((w) => w.key));
  for (const item of hl.items) {
    if (item.kind !== 'commit' || !item.pushed || !item.sha) continue;
    const key = `commit:${item.sha}`;
    if (have.has(key)) continue;
    const w: CiWatch = { key, sha: item.sha, since: item.pushedAt ?? item.at };
    if (item.repo) w.repo = item.repo;
    if (item.dir) w.dir = item.dir;
    state.watches.push(w);
    have.add(key);
    added = true;
  }
  for (const d of hl.dispatches ?? []) {
    const key = `dispatch:${d.seq}`;
    if (have.has(key)) continue;
    const w: CiWatch = { key, workflow: d.workflow, since: d.at };
    if (d.ref) w.ref = d.ref;
    if (d.repo) w.repo = d.repo;
    if (d.runId) w.runId = d.runId;
    state.watches.push(w);
    have.add(key);
    added = true;
  }
  if (added) {
    state.quiet = 0;
    state.watches = state.watches.slice(-WATCHES_KEPT);
  }
  return added;
}

// Runs `gh` with these arguments in `dir` (the thread's folder when left
// out) and resolves with what it printed; rejects when it fails.
export type Gh = (args: string[], dir?: string) => Promise<string>;
// Finds a short sha's commit in a repo on this Mac: in `dir` or the thread's
// folder, or a repo a level or two inside it (a thread working in a folder of
// repos). Its full sha, and the repo's folder when not the thread's.
export type FindCommit = (sha: string, dir?: string) => Promise<{ full: string; dir?: string } | undefined>;

export const RUN_FIELDS = 'databaseId,status,conclusion,workflowName,headSha,headBranch,url,event,createdAt';

type GhRun = { databaseId: number; status: string; conclusion: string; workflowName: string; headSha: string; headBranch?: string; url: string; event?: string; createdAt: string };

export function statusOf(status: string, conclusion: string): CiRunStatus {
  if (status !== 'completed') return status === 'in_progress' ? 'running' : 'queued';
  if (conclusion === 'success') return 'passed';
  if (conclusion === 'cancelled') return 'cancelled';
  if (conclusion === 'skipped' || conclusion === 'neutral') return 'skipped';
  return 'failed';
}

export function toRun(g: GhRun): CiRun | undefined {
  if (typeof g?.databaseId !== 'number' || typeof g.url !== 'string' || !/^https:\/\//.test(g.url)) return undefined;
  const run: CiRun = {
    id: `run:${g.databaseId}`,
    workflow: String(g.workflowName || 'Workflow'),
    status: statusOf(String(g.status ?? ''), String(g.conclusion ?? '')),
    url: g.url,
    sha: String(g.headSha ?? '').slice(0, 7),
    at: String(g.createdAt ?? ''),
  };
  if (g.headBranch) run.branch = String(g.headBranch);
  if (g.event) run.event = String(g.event);
  return run;
}

function parse(out: string): CiRun[] {
  const data: unknown = JSON.parse(out || '[]');
  const list = Array.isArray(data) ? data : [data];
  return list.map((g) => toRun(g as GhRun)).filter((r): r is CiRun => Boolean(r));
}

const finished = (r: CiRun) => r.status !== 'queued' && r.status !== 'running';
const REPO = /^[\w.-]+\/[\w.-]+$/;
const repoArgs = (w: CiWatch) => (w.repo && REPO.test(w.repo) ? ['-R', w.repo] : []);

// One look at every open watch. Returns whether the runs changed. A failing
// `gh` (not installed, not logged in, no network) is left for next time,
// and counts as a quiet check, so it backs off like one.
export async function check(state: CiRunsState, gh: Gh, findCommit: FindCommit, now: number): Promise<boolean> {
  let changed = false;
  for (const w of state.watches) {
    if (w.done) continue;
    const age = now - Date.parse(w.since);
    let found: CiRun[];
    try {
      found = await runsFor(w, gh, findCommit);
    } catch (e) {
      // A commit in no repo here and with no repo named is let go now:
      // asking again won't find it (a thread in a folder of repos was asked
      // about for two hours, 14 Nov 2026). A named run gh can't see (a
      // wrong id or repo) after a few tries likewise.
      w.fails = (w.fails ?? 0) + 1;
      if (age > GIVE_UP_MS || e === NOWHERE || (w.named && w.fails >= NAMED_FAILS)) w.done = true;
      continue;
    }
    delete w.fails;
    for (const r of found) if (merge(state, r)) changed = true;
    const mine = w.runId ? found.filter((r) => r.id === `run:${w.runId}`) : found;
    if (mine.length) w.found = [...new Set([...(w.found ?? []), ...mine.map((r) => r.id)])];
    if (age > GIVE_UP_MS) w.done = true;
    else if (!mine.length && age > NO_RUNS_MS) w.done = true;
    else if (mine.length && mine.every(finished) && age > SETTLE_MS) w.done = true;
  }
  state.runs.sort((a, b) => b.at.localeCompare(a.at));
  state.runs = state.runs.slice(0, RUNS_KEPT);
  state.quiet = changed ? 0 : state.quiet + 1;
  return changed;
}

const NOWHERE = new Error('no repo here has that commit');

async function runsFor(w: CiWatch, gh: Gh, findCommit: FindCommit): Promise<CiRun[]> {
  if (w.sha) {
    if (!w.full) {
      const found = await findCommit(w.sha, w.dir);
      if (found) {
        w.full = found.full;
        if (found.dir) w.dir = found.dir;
        else delete w.dir;
      } else if (w.repo && REPO.test(w.repo)) {
        w.full = (await gh(['api', `repos/${w.repo}/commits/${w.sha}`, '--jq', '.sha'])).trim();
      } else {
        throw NOWHERE;
      }
    }
    if (!/^[0-9a-f]{40}$/.test(w.full)) {
      delete w.full;
      throw new Error('no full sha');
    }
    return parse(await gh(['run', 'list', ...repoArgs(w), '--commit', w.full, '-L', '30', '--json', RUN_FIELDS], w.dir));
  }
  if (w.runId) return parse(await gh(['run', 'view', String(w.runId), ...repoArgs(w), '--json', RUN_FIELDS]));
  if (!w.workflow) return [];
  // The run a `gh workflow run` started, when its output didn't say: the
  // first dispatch of that workflow since (GitHub's clock may be a little
  // ahead or behind, hence the minute).
  const args = ['run', 'list', ...repoArgs(w), '-w', w.workflow, '-e', 'workflow_dispatch', '-L', '10', '--json', RUN_FIELDS];
  if (w.ref) args.push('-b', w.ref);
  const after = Date.parse(w.since) - 60_000;
  const first = parse(await gh(args)).filter((r) => Date.parse(r.at) >= after).sort((a, b) => a.at.localeCompare(b.at))[0];
  if (first) w.runId = Number(first.id.slice(4));
  return first ? [first] : [];
}

// Adds a run or updates its state. Returns whether anything shown changed.
function merge(state: CiRunsState, r: CiRun): boolean {
  const i = state.runs.findIndex((x) => x.id === r.id);
  if (i < 0) {
    state.runs.push(r);
    return true;
  }
  const old = state.runs[i];
  if (old.status === r.status && old.workflow === r.workflow) return false;
  state.runs[i] = r;
  return true;
}

// Single quotes around each argument, for the login shell `gh` runs in.
export function shellQuote(args: string[]): string {
  return args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
}

// ---- Waiting on runs (end_turn's waitForRuns) ----

// A run an agent named: its id and, when not the thread's own repo, owner/name.
export type NamedRun = { id: number; repo?: string };
// What end_turn's waitForRuns asked for: the thread's own runs, or named ones.
export type RunsWait = { mine: true } | { runs: NamedRun[] };

export const MAX_NAMED_RUNS = 5;
const RUN_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:[/?#].*)?$/;

// One entry of waitForRuns: a run's link, its id, or { run, repo }. Says
// what's wrong with one it can't read.
export function namedRun(x: unknown): NamedRun | string {
  const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : undefined;
  const raw = String(o ? (o.run ?? '') : (x ?? '')).trim();
  const repo = typeof o?.repo === 'string' ? o.repo.trim() : '';
  if (repo && !REPO.test(repo)) return `"${repo}" isn't a repo as owner/name.`;
  const url = RUN_URL.exec(raw);
  if (url) return { id: Number(url[2]), repo: url[1] };
  if (/^\d{1,15}$/.test(raw)) return repo ? { id: Number(raw), repo } : { id: Number(raw) };
  return `"${raw.slice(0, 80)}" isn't a run id or a github.com link to a run.`;
}

// The watches a wait is on. Named runs are added as watches of their own
// (or one that already has the run is watched again); for its own runs, the
// ones still open. None means there's nothing to wait on.
export function waitKeys(state: CiRunsState, wait: RunsWait, now: number): string[] {
  if ('mine' in wait) return state.watches.filter((w) => !w.done).map((w) => w.key);
  const keys: string[] = [];
  const since = new Date(now).toISOString();
  for (const n of wait.runs) {
    const key = `run:${n.repo ?? ''}:${n.id}`;
    let w = state.watches.find((x) => x.key === key || (x.runId === n.id && (x.repo ?? '') === (n.repo ?? '')));
    if (!w) {
      w = { key, runId: n.id, since, named: true };
      if (n.repo) w.repo = n.repo;
      state.watches.push(w);
    } else if (w.done) {
      // Looked at again: it may have been re-run since.
      delete w.done;
      w.since = since;
    }
    if (!keys.includes(w.key)) keys.push(w.key);
  }
  if (keys.length) {
    state.quiet = 0;
    // Never trims what it just added, as WATCHES_KEPT is well over MAX_NAMED_RUNS.
    state.watches = state.watches.slice(-WATCHES_KEPT);
  }
  return keys;
}

// How a wait stands: still going, or over with each run's result, the
// watches that found no runs, and the runs still going when watching
// stopped (after GIVE_UP_MS, or let go).
export type WaitResult =
  | { pending: true }
  | { pending: false; runs: CiRun[]; noRuns: CiWatch[]; unfinished: CiRun[]; lost: string[] };

export function waitResult(state: CiRunsState, keys: string[]): WaitResult {
  const runs: CiRun[] = [];
  const noRuns: CiWatch[] = [];
  const lost: string[] = [];
  for (const key of keys) {
    const w = state.watches.find((x) => x.key === key);
    if (!w) {
      lost.push(key);
      continue;
    }
    if (!w.done) return { pending: true };
    const mine = state.runs.filter((r) => w.found?.includes(r.id));
    if (!mine.length) noRuns.push(w);
    for (const r of mine) if (!runs.some((x) => x.id === r.id)) runs.push(r);
  }
  runs.sort((a, b) => a.at.localeCompare(b.at));
  return { pending: false, runs: runs.filter(finished), noRuns, unfinished: runs.filter((r) => !finished(r)), lost };
}

const SAID: Record<CiRunStatus, string> = { queued: 'still queued', running: 'still running', passed: 'passed', failed: 'failed', cancelled: 'cancelled', skipped: 'skipped' };

// "CI (main, abc1234): failed https://github.com/…"
export function runLine(r: CiRun): string {
  const at = [r.branch, r.sha].filter(Boolean).join(', ');
  return `- ${r.workflow}${at ? ` (${at})` : ''}: ${SAID[r.status]} ${r.url}`;
}

// The message a thread wakes with once its wait is over.
export function waitMessage(res: Extract<WaitResult, { pending: false }>): { text: string; why: string } {
  const parts: string[] = [];
  const failed = res.runs.filter((r) => r.status === 'failed').length;
  if (res.runs.length) {
    parts.push(`The GitHub workflow runs you hibernated to wait on have finished:\n${res.runs.map(runLine).join('\n')}`);
  }
  if (res.unfinished.length) {
    parts.push(`Threadbear stopped watching these after 2 hours while they were still going, so check them yourself (gh run view):\n${res.unfinished.map(runLine).join('\n')}`);
  }
  const none = res.noRuns.filter((w) => !w.named);
  if (none.length) parts.push(`No workflow runs were found for ${none.map((w) => (w.sha ? `commit ${w.sha}` : w.workflow ? `the ${w.workflow} dispatch` : w.key)).join(', ')}.`);
  const unseen = res.noRuns.filter((w) => w.named);
  if (unseen.length) parts.push(`gh couldn't find ${unseen.map((w) => `run ${w.runId}${w.repo ? ` in ${w.repo}` : ''}`).join(', ')}. Check the id and repo.`);
  if (res.lost.length && !parts.length) parts.push('Threadbear lost track of the runs you were waiting on. Check them yourself (gh run list).');
  parts.push('Carry on from here.');
  const why = res.unfinished.length ? 'stopped watching its GitHub workflows'
    : failed ? `${failed === 1 ? 'a GitHub workflow' : `${failed} GitHub workflows`} failed`
    : res.runs.length ? 'its GitHub workflows finished' : 'no GitHub workflow runs to wait on';
  return { text: parts.join('\n\n'), why };
}
