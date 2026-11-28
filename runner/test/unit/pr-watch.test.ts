import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWatched, plan, problemsOf, type PrWatchState, type WatchedPr, type WatchThread } from '../../src/pr-watch.ts';
import type { Gh } from '../../src/land-gate.ts';

const URL = 'https://github.com/acme/api/pull/12';
const KEY = 'acme/api#12';
const idle: WatchThread = { archived: false, busy: false };
const pr = (over: Partial<WatchedPr> = {}): WatchedPr => ({ state: 'open', draft: false, sha: 'abc', ci: 'SUCCESS', review: 'REVIEW_REQUIRED', updatedAt: '2026-11-20T10:00:00Z', problems: [], ...over });
const watch = (over = {}): PrWatchState => ({ [KEY]: { url: URL, thread: 't1', since: '2026-11-20T09:00:00Z', seen: [], ...over } });
const NOW = Date.parse('2026-11-20T12:00:00Z');

test('problemsOf reads what needs fixing, leaving out my own words and bots', () => {
  const n = {
    mergeable: 'CONFLICTING',
    headRefOid: 'abc',
    reviewDecision: 'CHANGES_REQUESTED',
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
    reviewThreads: { nodes: [{ id: 'T1', isResolved: false }, { id: 'T2', isResolved: true }] },
    reviews: { nodes: [
      { id: 'R1', state: 'CHANGES_REQUESTED', body: '', author: { login: 'ann', __typename: 'User' } },
      { id: 'R2', state: 'COMMENTED', body: 'see inline', author: { login: 'copilot', __typename: 'Bot' } },
      { id: 'R3', state: 'COMMENTED', body: 'note', author: { login: 'me', __typename: 'User' } },
    ] },
    comments: { nodes: [{ id: 'C1', author: { login: 'ann', __typename: 'User' } }, { id: 'C2', author: { login: 'lint-bot', __typename: 'Bot' } }] },
  };
  assert.deepEqual(problemsOf(n, 'me'), ['conflict', 'ci:abc', 'thread:T1', 'changes-requested', 'review:R1', 'comment:C1']);
});

test('a new problem sends its thread one fix message, once', () => {
  const state = watch({ primed: true });
  const prs = new Map([[KEY, pr({ ci: 'FAILURE', problems: ['ci:abc', 'thread:T1'] })]]);
  const { actions } = plan(state, prs, () => idle, NOW, '~/.threadbear/pr-auto-fix.md');
  assert.equal(actions.length, 1);
  const a = actions[0]!;
  assert.equal(a.kind, 'send');
  assert.equal(a.thread, 't1');
  assert.match((a as { text: string }).text, /^PR watch: api#12 \(https:\/\/github.com\/acme\/api\/pull\/12\) has CI failing, unresolved review threads\. /);
  assert.match((a as { text: string }).text, /read the rules in ~\/\.threadbear\/pr-auto-fix\.md/);
  Object.assign(state[KEY]!, a.done);
  assert.equal(plan(state, prs, () => idle, NOW).actions.length, 0, 'already sent');
});

test('the first look marks old reviews and comments seen, not old CI failures', () => {
  const state = watch();
  const prs = new Map([[KEY, pr({ ci: 'FAILURE', problems: ['review:R1', 'comment:C1', 'ci:abc'] })]]);
  const { actions } = plan(state, prs, () => idle, NOW);
  assert.match((actions[0] as { text: string }).text, /has CI failing\./);
  assert.deepEqual(state[KEY]!.seen, ['review:R1', 'comment:C1']);
});

test('a busy or archived thread is left alone, and a cleared key comes back as new', () => {
  const state = watch({ primed: true, seen: ['ci:abc'] });
  const failing = new Map([[KEY, pr({ ci: 'FAILURE', problems: ['ci:abc', 'conflict'] })]]);
  assert.equal(plan(state, failing, () => ({ archived: false, busy: true }), NOW).actions.length, 0);
  assert.equal(plan(state, failing, () => ({ archived: true, busy: false }), NOW).actions.length, 0);
  plan(state, new Map([[KEY, pr()]]), () => idle, NOW);
  assert.deepEqual(state[KEY]!.seen, [], 'cleared');
});

test('approved asks whether to merge, once per head commit', () => {
  const state = watch({ primed: true });
  const prs = new Map([[KEY, pr({ review: 'APPROVED' })]]);
  const { actions } = plan(state, prs, () => idle, NOW);
  assert.match((actions[0] as { text: string }).text, /is approved and ready to merge\. Do not merge it\./);
  Object.assign(state[KEY]!, actions[0]!.done);
  assert.equal(plan(state, prs, () => idle, NOW).actions.length, 0);
  assert.equal(plan(state, new Map([[KEY, pr({ review: 'APPROVED', sha: 'def' })]]), () => idle, NOW).actions.length, 1);
});

test('a thread whose PRs all wait for review is snoozed once per update', () => {
  const state = watch({ primed: true });
  const prs = new Map([[KEY, pr()]]);
  const { actions } = plan(state, prs, () => idle, NOW);
  assert.deepEqual(actions.map((a) => a.kind), ['snooze']);
  Object.assign(state[KEY]!, actions[0]!.done);
  assert.equal(plan(state, prs, () => idle, NOW).actions.length, 0, 'once per update');
  assert.equal(plan(watch({ primed: true }), prs, () => ({ ...idle, snoozedUntil: '2026-11-21T00:00:00Z' }), NOW).actions.length, 0, 'already snoozed');
  assert.equal(plan(watch({ primed: true }), new Map([[KEY, pr({ ci: 'PENDING' })]]), () => idle, NOW).actions.length, 0, 'CI still running');
});

test('a merged or closed PR stops being watched; one GitHub left out is kept', () => {
  const state: PrWatchState = { ...watch(), 'acme/web#3': { url: 'https://github.com/acme/web/pull/3', thread: 't1', since: '', seen: [] } };
  const { changed } = plan(state, new Map([[KEY, pr({ state: 'merged' })]]), () => idle, NOW);
  assert.ok(changed);
  assert.deepEqual(Object.keys(state), ['acme/web#3']);
});

test('fetchWatched asks for every PR and the viewer in one call', async () => {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    return { ok: true, stderr: '', stdout: JSON.stringify({ data: { viewer: { login: 'me' }, p0: { pullRequest: { state: 'OPEN', isDraft: false, headRefOid: 'abc', reviewDecision: 'REVIEW_REQUIRED', updatedAt: 'x', mergeable: 'MERGEABLE', commits: { nodes: [] }, reviewThreads: { nodes: [{ id: 'T1', isResolved: false }] }, reviews: { nodes: [] }, comments: { nodes: [] } } }, p1: null } }) };
  };
  const out = await fetchWatched([URL, 'https://github.com/acme/gone/pull/1', 'https://example.com'], gh);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.at(-1)!, /^query=\{viewer\{login\} p0:repository\(owner:"acme",name:"api"\)/);
  assert.deepEqual(out.get(KEY), { state: 'open', draft: false, sha: 'abc', ci: '', review: 'REVIEW_REQUIRED', updatedAt: 'x', problems: ['thread:T1'] });
  assert.equal(out.size, 1);
  await assert.rejects(fetchWatched([URL], async () => ({ ok: false, stdout: '', stderr: 'gh auth login' })), /gh auth login/);
});

// ---- In the runner (runner/pr-watch.ts) ----
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';
import { CallerGate } from '../../src/rpc-gate.ts';
import { ErrorCode } from '../../src/protocol.ts';

async function until(ok: () => boolean, what: string): Promise<void> {
  const end = Date.now() + PATIENCE_MS;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('a wand turned on in the runner sends the PR\'s problem to its thread and shows on its highlight', async () => {
  const home = tmpDir();
  const h = makeHarness(home);
  const asked: string[] = [];
  h.runner.prWatchGh = async (args) => {
    asked.push(args.at(-1)!);
    return { ok: true, stderr: '', stdout: JSON.stringify({ data: { viewer: { login: 'me' }, p0: { pullRequest: { state: 'OPEN', isDraft: false, headRefOid: 'abc', reviewDecision: 'REVIEW_REQUIRED', updatedAt: 'x', mergeable: 'CONFLICTING', commits: { nodes: [] }, reviewThreads: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } } } } }) };
  };
  const { thread } = h.runner.create({ text: `Opened ${URL}`, accountId: 'claude-main' });
  const s = h.adapter.sessions.at(-1)!;
  s.init();
  s.out({ kind: 'event', event: { type: 'assistant.text', itemId: 'a', text: `Opened ${URL}` } });
  s.result();
  await until(() => h.runner.get(thread.id).status === 'idle', 'the turn to end');
  assert.equal(h.runner.highlights(thread.id).highlights.find((x) => x.kind === 'pr')?.watched, undefined);

  assert.deepEqual(h.runner.setPrWatch(thread.id, [`${URL}/files`], true), { watched: [URL] });
  assert.equal(h.runner.highlights(thread.id).highlights.find((x) => x.kind === 'pr')?.watched, true);
  h.clock.advance(2_000);
  await until(() => asked.length > 0 && !h.runner.prWatchBusy, 'a look');
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'pr-watch.json'), 'utf8'));
  assert.deepEqual(saved[KEY].seen, ['conflict']);
  assert.ok(h.runner.prWatchTimer, 'the next look booked');
  assert.deepEqual(h.runner.listPrWatch().watches.map((w) => [w.url, w.threadId]), [[URL, thread.id]]);

  h.runner.setPrWatch(thread.id, [URL], false);
  assert.equal(h.runner.highlights(thread.id).highlights.find((x) => x.kind === 'pr')?.watched, undefined);
  assert.deepEqual(h.runner.listPrWatch().watches, []);
});

test("a thread on Auto sets a PR's auto-fix wand for itself only", () => {
  const h = makeHarness();
  const mine = h.runner.create({ text: 'Mine', accountId: 'claude-3', permissionMode: 'auto' }).thread;
  const other = h.runner.create({ text: 'Other', accountId: 'claude-3', permissionMode: 'auto' }).thread;
  const gate = new CallerGate({ runner: h.runner });
  const p = { threadId: mine.id, urls: ['https://github.com/o/r/pull/1'], on: true };
  assert.deepEqual(gate.check(mine.id, 'prWatch.set', p), p);
  assert.throws(() => gate.check(mine.id, 'prWatch.set', { ...p, threadId: other.id }), (e: { code?: number }) => e.code === ErrorCode.notAllowed);
});
