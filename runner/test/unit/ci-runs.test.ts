// GitHub Actions runs in Highlights (ci-runs.ts and runner/ci-runs.ts): the
// runs a thread's pushes and dispatches set off, asked of `gh` only while one
// is queued or running; and a thread hibernating until runs finish (end_turn's
// waitForRuns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';
import { EXPERIMENTS } from '../../src/experiments.ts';
import { addWatches, check, delayMs, emptyCiRuns, namedRun, shellQuote, statusOf, waitKeys, waitMessage, waitResult, watching } from '../../src/ci-runs.ts';
import { runsFromTool } from '../../src/needs.ts';
import { WAIT_FOR_DEFAULT_MS } from '../../src/runner/hibernation.ts';
import { checkSummary } from '../helpers/protocol-check.ts';
import { dispatchOf, emptyHighlights, observe, pushDir, pushedRepo, view } from '../../src/highlights.ts';
import type { PersistedEvent } from '../../src/protocol.ts';

const FULL = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const T0 = Date.parse('2026-11-12T10:00:00.000Z');

let seq = 0;
function ev(body: Record<string, unknown>, ts = '2026-11-12T10:00:00.000Z'): PersistedEvent {
  seq++;
  return { seq, ts, threadId: 't', ...body } as PersistedEvent;
}

const ghRun = (id: number, workflow: string, status: string, conclusion = '', at = '2026-11-12T10:00:05Z') => ({
  databaseId: id, status, conclusion, workflowName: workflow, headSha: FULL, headBranch: 'feat', url: `https://github.com/o/r/actions/runs/${id}`, event: 'push', createdAt: at,
});

test('ciRuns: standard, no longer an experiment', () => {
  assert.equal(EXPERIMENTS.find((e) => (e.id as string) === 'ciRuns'), undefined);
});

test('ciRuns: GitHub states read as queued, running, passed, failed, cancelled or skipped', () => {
  assert.equal(statusOf('queued', ''), 'queued');
  assert.equal(statusOf('pending', ''), 'queued');
  assert.equal(statusOf('waiting', ''), 'queued');
  assert.equal(statusOf('in_progress', ''), 'running');
  assert.equal(statusOf('completed', 'success'), 'passed');
  assert.equal(statusOf('completed', 'failure'), 'failed');
  assert.equal(statusOf('completed', 'timed_out'), 'failed');
  assert.equal(statusOf('completed', 'cancelled'), 'cancelled');
  assert.equal(statusOf('completed', 'skipped'), 'skipped');
  assert.equal(shellQuote(['-w', "it's ci.yml"]), `'-w' 'it'\\''s ci.yml'`);
});

test('ciRuns: the repo comes from a push to GitHub, and a dispatch from gh workflow run', () => {
  assert.equal(pushedRepo('To https://github.com/mikecann/threadbear.git\n   a..b  main -> main'), 'mikecann/threadbear');
  assert.equal(pushedRepo('To github.com:o/r.git\n'), undefined);
  assert.equal(pushedRepo('To git@github.com:o/r.git\n * [new branch] x -> x'), 'o/r');
  assert.equal(pushedRepo('To https://x-access-token@github.com/o/r\n'), 'o/r');
  assert.equal(pushedRepo('To https://gitlab.com/o/r.git\n'), undefined);
  assert.deepEqual(dispatchOf('gh workflow run deploy.yml --ref feat -f env=prod', '✓ Created workflow_dispatch event for deploy.yml at feat'), { workflow: 'deploy.yml', ref: 'feat' });
  assert.deepEqual(dispatchOf('cd app && gh workflow run "Deploy preview" -R o/r && echo ok', ''), { workflow: 'Deploy preview', repo: 'o/r' });
  assert.deepEqual(dispatchOf('gh workflow run ci.yml', 'https://github.com/o/r/actions/runs/99\n'), { workflow: 'ci.yml', runId: 99, repo: 'o/r' });
  assert.equal(dispatchOf('gh workflow list', ''), undefined);
  // A re-run is followed by its run's id.
  assert.deepEqual(dispatchOf('gh run rerun 43395974641 --failed -R o/r', '✓ Requested rerun (failed jobs) of run 43395974641'), { workflow: '', runId: 43395974641, repo: 'o/r' });
  assert.deepEqual(dispatchOf('gh run rerun https://github.com/o/r/actions/runs/77', ''), { workflow: '', runId: 77, repo: 'o/r' });
  assert.deepEqual(dispatchOf('gh run rerun --job 5 12', ''), { workflow: '', runId: 12 });
  assert.equal(dispatchOf('gh run rerun', ''), undefined, 'gh asks which run: nothing to follow');
});

test('ciRuns: pushed commits and dispatches become watches, once each', () => {
  const hl = emptyHighlights();
  observe(hl, [
    ev({ type: 'tool.call', itemId: 'c', name: 'Bash', kind: 'command', title: '', input: { command: 'git commit -m x' } }),
    ev({ type: 'tool.result', itemId: 'c', ok: true, text: '[feat a1b2c3d] Fix it\n', truncated: false, images: [] }),
    ev({ type: 'tool.call', itemId: 'u', name: 'Bash', kind: 'command', title: '', input: { command: 'git commit -m y' } }),
    ev({ type: 'tool.result', itemId: 'u', ok: true, text: '[other 0000aaa] Not pushed\n', truncated: false, images: [] }),
    ev({ type: 'tool.call', itemId: 'p', name: 'Bash', kind: 'command', title: '', input: { command: 'git push' } }),
    ev({ type: 'tool.result', itemId: 'p', ok: true, text: 'To https://github.com/o/r.git\n   0123456..a1b2c3d  feat -> feat\n', truncated: false, images: [] }, '2026-11-12T10:00:01.000Z'),
    ev({ type: 'tool.call', itemId: 'd', name: 'Bash', kind: 'command', title: '', input: { command: 'gh workflow run deploy.yml' } }),
    ev({ type: 'tool.result', itemId: 'd', ok: true, text: 'Created workflow_dispatch event\n', truncated: false, images: [] }),
  ], { cwd: '/x', home: '/h', exists: () => false });
  const commit = hl.items.find((i) => i.id === 'commit:a1b2c3d')!;
  assert.equal(commit.repo, 'o/r');
  assert.equal(commit.pushedAt, '2026-11-12T10:00:01.000Z');
  const state = emptyCiRuns();
  assert.equal(addWatches(state, hl), true);
  assert.deepEqual(state.watches.map((w) => [w.key.split(':')[0], w.sha ?? w.workflow, w.repo]), [['commit', 'a1b2c3d', 'o/r'], ['dispatch', 'deploy.yml', undefined]]);
  assert.equal(addWatches(state, hl), false);
});

test('ciRuns: asks while runs go, backs off when quiet, and stops once they finish', async () => {
  const state = emptyCiRuns();
  state.watches.push({ key: 'commit:a1b2c3d', sha: 'a1b2c3d', repo: 'o/r', since: new Date(T0).toISOString() });
  let answer = [ghRun(1, 'CI', 'queued'), ghRun(2, 'Lint', 'in_progress')];
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify(answer);
  };
  const findCommit = async () => ({ full: FULL });
  assert.equal(await check(state, gh, findCommit, T0 + 5_000), true);
  assert.deepEqual(calls[0].slice(0, 6), ['run', 'list', '-R', 'o/r', '--commit', FULL]);
  assert.deepEqual(state.runs.map((r) => [r.workflow, r.status, r.sha, r.url]), [
    ['CI', 'queued', 'a1b2c3d', 'https://github.com/o/r/actions/runs/1'],
    ['Lint', 'running', 'a1b2c3d', 'https://github.com/o/r/actions/runs/2'],
  ]);
  assert.equal(delayMs(state), 15_000);
  // Nothing new: quieter each time, up to two minutes.
  assert.equal(await check(state, gh, findCommit, T0 + 20_000), false);
  assert.equal(delayMs(state), 30_000);
  for (let i = 0; i < 5; i++) await check(state, gh, findCommit, T0 + 30_000);
  assert.equal(delayMs(state), 120_000);
  // All finished, past the settling time: done, and asked no more.
  answer = [ghRun(1, 'CI', 'completed', 'failure'), ghRun(2, 'Lint', 'completed', 'success')];
  assert.equal(await check(state, gh, findCommit, T0 + 60_000), true);
  assert.deepEqual(state.runs.map((r) => r.status), ['failed', 'passed']);
  assert.equal(watching(state), false);
});

test('ciRuns: a push with no runs is let go after three minutes; a failing gh is tried again', async () => {
  const state = emptyCiRuns();
  state.watches.push({ key: 'commit:a1b2c3d', sha: 'a1b2c3d', repo: 'o/r', since: new Date(T0).toISOString() });
  let fail = true;
  const gh = async () => {
    if (fail) throw new Error('gh: not logged in');
    return '[]';
  };
  // Not on this Mac: GitHub is asked for the full sha, and gh fails.
  await check(state, gh, async () => undefined, T0 + 10_000);
  assert.equal(watching(state), true);
  assert.equal(state.watches[0].full, undefined);
  await check(state, gh, async () => ({ full: FULL }), T0 + 10_000);
  assert.equal(watching(state), true);
  fail = false;
  await check(state, gh, async () => ({ full: FULL }), T0 + 60_000);
  assert.equal(watching(state), true);
  await check(state, gh, async () => ({ full: FULL }), T0 + 4 * 60_000);
  assert.equal(watching(state), false);
});

test('ciRuns: a commit in another repo is asked about there; one found nowhere is let go at once', async () => {
  const state = emptyCiRuns();
  state.watches.push({ key: 'commit:a1b2c3d', sha: 'a1b2c3d', dir: '/x/sub', since: new Date(T0).toISOString() });
  state.watches.push({ key: 'commit:0000aaa', sha: '0000aaa', since: new Date(T0).toISOString() });
  const asked: [string, string | undefined][] = [];
  const looked: [string, string | undefined][] = [];
  const gh = async (args: string[], dir?: string) => {
    asked.push([args.slice(0, 2).join(' '), dir]);
    return JSON.stringify([ghRun(1, 'CI', 'queued')]);
  };
  const findCommit = async (sha: string, dir?: string) => {
    looked.push([sha, dir]);
    return sha === 'a1b2c3d' ? { full: FULL, dir: '/x/repos/one' } : undefined;
  };
  await check(state, gh, findCommit, T0 + 5_000);
  assert.deepEqual(looked, [['a1b2c3d', '/x/sub'], ['0000aaa', undefined]]);
  assert.deepEqual(asked, [['run list', '/x/repos/one']]);
  assert.equal(state.watches[0].dir, '/x/repos/one');
  assert.equal(state.watches[1].done, true, 'nothing to ask, so not asked again');
  await check(state, gh, findCommit, T0 + 20_000);
  assert.equal(looked.length, 2, 'found once');
  assert.deepEqual(asked.at(-1), ['run list', '/x/repos/one']);
});

test('ciRuns: the folder a push ran in comes from its command', () => {
  assert.equal(pushDir('cd sub && git push 2>&1 | tail -2', '/x', '/h'), '/x/sub');
  assert.equal(pushDir('cd /a/b; cd c && git commit -qm x && git push -u origin feat', '/x', '/h'), '/a/b/c');
  assert.equal(pushDir('git -C ~/repo push', '/x', '/h'), '/h/repo');
  assert.equal(pushDir('git push', '/x', '/h'), undefined);
  assert.equal(pushDir('cd "$W" && git push', '/x', '/h'), undefined);
  assert.equal(pushDir('git push && cd later', '/x', '/h'), undefined);
  const hl = emptyHighlights();
  observe(hl, [
    ev({ type: 'tool.call', itemId: 'c', name: 'Bash', kind: 'command', title: '', input: { command: 'cd sub && git commit -qm x && git log --oneline -1 && git push -u origin feat 2>&1 | tail -2' } }),
    ev({ type: 'tool.result', itemId: 'c', ok: true, text: 'a1b2c3d Fix it\nbranch \'feat\' set up to track \'origin/feat\'.\n', truncated: false, images: [] }),
  ], { cwd: '/x', home: '/h', exists: () => false });
  const commit = hl.items.find((i) => i.id === 'commit:a1b2c3d')!;
  assert.equal(commit.pushed, true);
  assert.equal(commit.dir, '/x/sub');
  assert.equal(view(hl).highlights[0].dir, undefined, 'not sent to clients');
  const state = emptyCiRuns();
  addWatches(state, hl);
  assert.equal(state.watches[0].dir, '/x/sub');
});

test('ciRuns: a re-run of a finished run shows it going again, and follows it until it finishes', async () => {
  const state = emptyCiRuns();
  state.runs.push({ id: 'run:5', workflow: 'Lint', status: 'failed', url: 'https://github.com/o/r/actions/runs/5', sha: 'a1b2c3d', at: '2026-11-11T10:00:00Z' });
  const hl = emptyHighlights();
  observe(hl, [
    ev({ type: 'tool.call', itemId: 'r', name: 'Bash', kind: 'command', title: '', input: { command: 'gh run rerun 5 -R o/r' } }),
    ev({ type: 'tool.result', itemId: 'r', ok: true, text: '✓ Requested rerun of run 5\n', truncated: false, images: [] }, '2026-11-12T10:00:00.000Z'),
  ], { cwd: '/x', home: '/h', exists: () => false });
  assert.equal(addWatches(state, hl), true);
  let status = 'queued';
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ ...ghRun(5, 'Lint', status, status === 'completed' ? 'success' : ''), createdAt: '2026-11-11T10:00:00Z' });
  };
  assert.equal(await check(state, gh, async () => undefined, T0 + 5_000), true);
  assert.deepEqual(calls[0].slice(0, 5), ['run', 'view', '5', '-R', 'o/r']);
  assert.equal(state.runs[0].status, 'queued');
  status = 'completed';
  await check(state, gh, async () => undefined, T0 + 60_000);
  assert.equal(state.runs[0].status, 'passed');
  assert.equal(watching(state), false);
});

test('ciRuns: a dispatch finds its own run, then follows it by id', async () => {
  const state = emptyCiRuns();
  state.watches.push({ key: 'dispatch:4', workflow: 'deploy.yml', ref: 'feat', since: '2026-11-12T10:00:00.000Z' });
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ ...ghRun(7, 'Deploy', 'completed', 'success', '2026-11-12T10:00:03Z'), event: 'workflow_dispatch' });
    return JSON.stringify([
      { ...ghRun(8, 'Deploy', 'queued', '', '2026-11-12T10:20:00Z'), event: 'workflow_dispatch' },
      { ...ghRun(7, 'Deploy', 'queued', '', '2026-11-12T10:00:03Z'), event: 'workflow_dispatch' },
      { ...ghRun(6, 'Deploy', 'completed', 'success', '2026-11-11T09:00:00Z'), event: 'workflow_dispatch' },
    ]);
  };
  await check(state, gh, async () => undefined, T0 + 5_000);
  assert.deepEqual(calls[0], ['run', 'list', '-w', 'deploy.yml', '-e', 'workflow_dispatch', '-L', '10', '--json', calls[0][9], '-b', 'feat']);
  assert.deepEqual(state.runs.map((r) => r.id), ['run:7']);
  assert.equal(state.watches[0].runId, 7);
  await check(state, gh, async () => undefined, T0 + 60_000);
  assert.deepEqual(calls[1].slice(0, 3), ['run', 'view', '7']);
  assert.equal(state.runs[0].status, 'passed');
  assert.equal(watching(state), false);
});

async function until(ok: () => boolean, what: string): Promise<void> {
  const end = Date.now() + PATIENCE_MS;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function setup() {
  const h = makeHarness(tmpDir());
  const commands: string[] = [];
  let runs = [ghRun(1, 'CI', 'in_progress')];
  h.runner.ciShell = async (_cwd, command) => {
    commands.push(command);
    if (command.startsWith('git rev-parse')) return `${FULL}\n`;
    return JSON.stringify(runs);
  };
  const { thread } = h.runner.create({ text: 'Ship it', accountId: 'claude-main' });
  const s = h.adapter.sessions.at(-1)!;
  s.init();
  const push = () => {
    s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'c', name: 'Bash', kind: 'command', title: 'commit', input: { command: 'git commit -m "Fix it"' } } });
    s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'c', ok: true, text: '[feat a1b2c3d] Fix it\n', truncated: false, images: [] } });
    s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'p', name: 'Bash', kind: 'command', title: 'push', input: { command: 'git push' } } });
    s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'p', ok: true, text: 'To https://github.com/o/r.git\n   0123456..a1b2c3d  feat -> feat\n', truncated: false, images: [] } });
  };
  return { h, id: thread.id, push, commands, setRuns: (r: typeof runs) => (runs = r) };
}

// Lets whatever the fake clock's move set off run to its end: a look the
// runner booked would have asked by then. Tests that nothing more is asked.
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

test('ciRuns: a push in a thread shows its runs in Highlights, and the runner stops asking once they finish', async () => {
  const { h, id, push, commands, setRuns } = setup();
  push();
  await until(() => Boolean(h.runner.threads.get(id)!.rt.ciTimer), 'a look booked');
  assert.equal(commands.length, 0);
  h.clock.advance(5_000);
  await until(() => (h.runner.highlights(id).runs?.length ?? 0) > 0, 'the run');
  assert.deepEqual(h.runner.highlights(id).runs!.map((r) => [r.workflow, r.status]), [['CI', 'running']]);
  assert.ok(h.runner.get(id).highlightsAt, 'clients are told to fetch again');
  assert.match(commands.find((c) => c.startsWith('gh'))!, /^gh 'run' 'list' '-R' 'o\/r' '--commit' 'a1b2c3d4/);
  setRuns([ghRun(1, 'CI', 'completed', 'success')]);
  h.clock.advance(60_000);
  await until(() => h.runner.highlights(id).runs?.[0].status === 'passed', 'passed');
  // Past the settling time, one more look closes it.
  const rec = h.runner.threads.get(id)!;
  await until(() => !rec.rt.ciChecking && Boolean(rec.rt.ciTimer), 'the next look booked');
  h.clock.advance(2 * 60_000);
  await until(() => !rec.rt.ciChecking && !rec.rt.ciTimer, 'the watch to close');
  assert.equal(rec.rec.ciRuns?.watches.every((w) => w.done), true);
  const asked = commands.length;
  h.clock.advance(10 * 60_000);
  await settle();
  assert.equal(commands.length, asked, 'nothing more asked');
});

test('ciRuns: a thread in a folder of repos finds the one its push came from, though the push printed no repo', async () => {
  const { h, id, setRuns } = setup();
  const s = h.adapter.sessions.at(-1)!;
  const cwd = h.runner.get(id).cwd;
  const calls: [string, string][] = [];
  const runs = [ghRun(1, 'CI', 'in_progress')];
  h.runner.ciShell = async (at, command) => {
    calls.push([at, command]);
    if (command.startsWith('git rev-parse')) throw new Error('not a git repository');
    if (command.startsWith('find ')) return `./repos/one\n${FULL}\n`;
    return JSON.stringify(runs);
  };
  setRuns(runs);
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'p', name: 'Bash', kind: 'command', title: 'push', input: { command: 'git commit -qm "Fix it" && git log --oneline -1 && git push -u origin feat 2>&1 | tail -2' } } });
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'p', ok: true, text: 'a1b2c3d Fix it\nbranch \'feat\' set up to track \'origin/feat\'.\n', truncated: false, images: [] } });
  await until(() => Boolean(h.runner.threads.get(id)!.rt.ciTimer), 'a look booked');
  h.clock.advance(5_000);
  await until(() => (h.runner.highlights(id).runs?.length ?? 0) > 0, 'the run');
  const gh = calls.find(([, c]) => c.startsWith('gh'))!;
  assert.equal(gh[0], path.join(cwd, 'repos/one'));
  assert.match(gh[1], /^gh 'run' 'list' '--commit' 'a1b2c3d4/);
  assert.equal(calls.filter(([, c]) => c.startsWith('find ')).length, 1);
});

test('ciRuns: a re-run in a thread is followed even though gh prints nothing', async () => {
  const { h, id, commands, setRuns } = setup();
  setRuns([{ ...ghRun(5, 'Lint', 'queued'), createdAt: '2026-11-11T10:00:00Z' }]);
  const s = h.adapter.sessions.at(-1)!;
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'r', name: 'Bash', kind: 'command', title: 'rerun', input: { command: 'gh run rerun 5 -R o/r' } } });
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'r', ok: true, text: '', truncated: false, images: [] } });
  await until(() => Boolean(h.runner.threads.get(id)!.rt.ciTimer), 'a look booked');
  h.clock.advance(5_000);
  await until(() => h.runner.highlights(id).runs?.[0]?.id === 'run:5', 'the re-run');
  assert.match(commands.at(-1)!, /^gh 'run' 'view' '5' '-R' 'o\/r'/);
});

test('ciRuns: archived, nothing is asked', async () => {
  const on = setup();
  on.push();
  await until(() => Boolean(on.h.runner.threads.get(on.id)!.rt.ciTimer), 'a look booked');
  on.h.runner.threads.get(on.id)!.rec.archivedAt = '2026-11-12T10:00:00.000Z';
  on.h.clock.advance(60_000);
  await settle();
  assert.equal(on.commands.length, 0);
});

// ---- waitForRuns ----

const iso = (t: number) => new Date(t).toISOString();

test('waitForRuns: reads true, run links, ids and { run, repo }, only with needs "nothing"', () => {
  assert.deepEqual(namedRun('https://github.com/villelahdenvuo/threadbear/actions/runs/123/job/9'), { id: 123, repo: 'villelahdenvuo/threadbear' });
  assert.deepEqual(namedRun(456), { id: 456 });
  assert.deepEqual(namedRun({ run: '789', repo: 'o/r' }), { id: 789, repo: 'o/r' });
  assert.match(namedRun('the CI one') as string, /isn't a run id/);
  assert.match(namedRun({ run: 1, repo: 'nope' }) as string, /owner\/name/);
  assert.deepEqual(runsFromTool({ needs: 'nothing', waitForRuns: true }), { mine: true });
  assert.deepEqual(runsFromTool({ waitForRuns: [5, '5', 'junk'] }), { runs: [{ id: 5 }] });
  assert.equal(runsFromTool({ needs: 'you', asks: [{ question: 'x' }], waitForRuns: true }), undefined);
  assert.equal(runsFromTool({ needs: 'nothing', waitForRuns: [] }), undefined);
});

test('waitForRuns: waits on its open watches, or named runs as watches of their own, then says how each went', async () => {
  const state = emptyCiRuns();
  state.watches.push({ key: 'commit:a1b2c3d', sha: 'a1b2c3d', repo: 'o/r', since: iso(T0) });
  state.watches.push({ key: 'commit:0000000', sha: '0000000', since: iso(T0 - 3_600_000), done: true });
  assert.deepEqual(waitKeys(state, { mine: true }, T0), ['commit:a1b2c3d']);
  assert.deepEqual(waitKeys(state, { runs: [{ id: 42, repo: 'fork/r' }] }, T0), ['run:fork/r:42']);
  const keys = ['commit:a1b2c3d', 'run:fork/r:42'];
  let answer: Record<string, unknown>[] = [ghRun(1, 'CI', 'in_progress')];
  let fork = ghRun(42, 'Deploy', 'queued');
  const gh = async (args: string[]) => JSON.stringify(args[1] === 'view' ? { ...fork, url: 'https://github.com/fork/r/actions/runs/42' } : answer);
  await check(state, gh, async () => ({ full: FULL }), T0 + 5_000);
  assert.deepEqual(waitResult(state, keys), { pending: true });
  answer = [ghRun(1, 'CI', 'completed', 'failure')];
  fork = ghRun(42, 'Deploy', 'completed', 'success');
  await check(state, gh, async () => ({ full: FULL }), T0 + 60_000);
  const res = waitResult(state, keys);
  assert.equal(res.pending, false);
  if (res.pending) return;
  const { text, why } = waitMessage(res);
  assert.equal(why, 'a GitHub workflow failed');
  assert.match(text, /^The GitHub workflow runs you hibernated to wait on have finished:\n- CI \(feat, a1b2c3d\): failed https:\/\/github\.com\/o\/r\/actions\/runs\/1\n- Deploy \(feat, a1b2c3d\): passed https:\/\/github\.com\/fork\/r\/actions\/runs\/42/);
});

test('waitForRuns: runs still going when watching stops after two hours, or a run gh can\'t find, are said', async () => {
  const state = emptyCiRuns();
  state.watches.push({ key: 'commit:a1b2c3d', sha: 'a1b2c3d', repo: 'o/r', since: iso(T0) });
  const keys = waitKeys(state, { mine: true }, T0);
  await check(state, async () => JSON.stringify([ghRun(1, 'CI', 'in_progress')]), async () => ({ full: FULL }), T0 + 5_000);
  await check(state, async () => JSON.stringify([ghRun(1, 'CI', 'in_progress')]), async () => ({ full: FULL }), T0 + 3 * 3_600_000);
  const res = waitResult(state, keys);
  assert.equal(res.pending, false);
  if (res.pending) return;
  const { text, why } = waitMessage(res);
  assert.equal(why, 'stopped watching its GitHub workflows');
  assert.match(text, /stopped watching these after 2 hours while they were still going, so check them yourself/);

  const named = emptyCiRuns();
  const nk = waitKeys(named, { runs: [{ id: 9, repo: 'o/r' }] }, T0);
  for (let i = 0; i < 3; i++) await check(named, async () => { throw new Error('HTTP 404'); }, async () => undefined, T0 + i * 15_000);
  const gone = waitResult(named, nk);
  assert.equal(gone.pending, false);
  if (gone.pending) return;
  assert.match(waitMessage(gone).text, /gh couldn't find run 9 in o\/r/);
});

const END_TURN = 'mcp__threadbear__end_turn';

test('waitForRuns: a thread that pushed hibernates until its runs finish, under Running, and wakes with each result', async () => {
  const { h, id, push, setRuns } = setup();
  const s = h.adapter.sessions.at(-1)!;
  push();
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing', waitForRuns: true } } });
  s.text('m1', 'Pushed; waiting on CI.');
  s.result();
  let t = h.runner.get(id);
  assert.equal(t.awaitingRuns, true);
  assert.deepEqual(checkSummary(t), []);
  assert.equal(Date.parse(t.snoozedUntil!), h.clock.now() + WAIT_FOR_DEFAULT_MS);
  assert.ok(h.events(id).some((e) => e.type === 'system.note' && /^Hibernating until its GitHub workflows finish, or .+ at the latest\.$/.test(e.text)));
  h.clock.advance(5_000);
  await until(() => h.runner.highlights(id).runs?.[0]?.status === 'running', 'the run');
  assert.ok(h.runner.get(id).snoozedUntil, 'still asleep while it runs');
  setRuns([ghRun(1, 'CI', 'completed', 'success')]);
  const rec = h.runner.threads.get(id)!;
  for (let i = 0; i < 10 && h.runner.get(id).snoozedUntil; i++) {
    await until(() => !rec.rt.ciChecking && Boolean(rec.rt.ciTimer), 'the next look booked');
    h.clock.advance(2 * 60_000);
    await settle();
  }
  t = h.runner.get(id);
  assert.equal(t.snoozedUntil, undefined);
  assert.equal(t.awaitingRuns, undefined);
  const msg = h.events(id).filter((e) => e.type === 'user.message').at(-1);
  assert.equal(msg.origin, 'runner');
  assert.match(msg.text, /^The GitHub workflow runs you hibernated to wait on have finished:\n- CI \(feat, a1b2c3d\): passed https:\/\/github\.com\/o\/r\/actions\/runs\/1/);
  assert.ok(h.events(id).some((e) => e.type === 'system.note' && /^Woke up.*: its GitHub workflows finished\.$/.test(e.text)));
});

test('waitForRuns: with nothing going it doesn\'t hibernate, and the agent is told', () => {
  const { h, id } = setup();
  const s = h.adapter.sessions.at(-1)!;
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing', waitForRuns: true } } });
  s.text('m1', 'Waiting on CI.');
  s.result();
  assert.equal(h.runner.get(id).snoozedUntil, undefined);
  const msg = h.events(id).filter((e) => e.type === 'user.message').at(-1);
  assert.match(msg.text, /isn't watching any that are queued or running/);
});

test('waitForRuns: a named run on another repo is watched by id, and a restart looks again', async () => {
  const { h, id, commands, setRuns } = setup();
  setRuns([]);
  const s = h.adapter.sessions.at(-1)!;
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing', waitForRuns: ['https://github.com/fork/r/actions/runs/77'] } } });
  s.text('m1', 'Waiting on the fork run.');
  s.result();
  assert.equal(h.runner.get(id).awaitingRuns, true);
  assert.deepEqual(h.runner.threads.get(id)!.rec.waitingOnRuns, ['run:fork/r:77']);
  h.clock.advance(5_000);
  await until(() => commands.some((c) => c.startsWith("gh 'run' 'view' '77' '-R' 'fork/r'")), 'the run asked about');
});
