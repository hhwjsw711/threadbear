// A Grok login out of balance (23 Nov 2026, thread ce78609c): Grok made no
// model call and answered the prompt with JSON-RPC's "Internal error", the
// real reason ("API error (status 402 Payment Required): Grok Build usage
// balance exhausted", http_status 402) only in the error's data and its own
// retry_state and turn_completed notes. Threadbear showed "Internal error"
// and left the thread failed on a login with nothing left.
//
// Now the reason is what shows, the turn counts as a usage limit (errorKind
// usageLimit), so the login is marked out and a pool thread moves to a login
// with room in its own pool, and Grok's _x.ai/billing gives the login a
// reading like Claude's and Codex's (adapters/acp/grok-billing.ts).
import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpAdapter, AcpSession } from '../../src/adapters/acp/adapter.ts';
import { ACP_AGENTS, type AcpAgent } from '../../src/adapters/acp/agents.ts';
import { AcpRpcError, failureNote, laterFailure, outOfUsage } from '../../src/adapters/acp/connection.ts';
import { grokLimits } from '../../src/adapters/acp/grok-billing.ts';
import { acpAsker } from '../../src/models/acp-oneshot.ts';
import { dueForRecheck, FIRST_READ_RETRY_MS } from '../../src/limit-recheck.ts';
import type { AdapterOutput, SessionSink } from '../../src/adapters/types.ts';
import { SessionUsageLimitError } from '../../src/adapters/types.ts';
import type { Account, Pool } from '../../src/protocol.ts';
import { nullLogger } from '../../src/log.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { FakeAccounts, FakeAdapter, ACCOUNTS, makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import type { UsageReading } from '../../src/usage.ts';
import { CARRY_ON_BACK, type UsageSink } from '../../src/runner.ts';

const FAKE = path.join(import.meta.dirname, '..', 'helpers', 'fake-acp-agent.mjs');
// The pretend Grok runs under this node, with Grok's own args after it:
// Windows can't start a .mjs as a program (spawn EFTYPE).
const grok: AcpAgent = { ...ACP_AGENTS.grok, args: (run) => [FAKE, ...ACP_AGENTS.grok.args(run)] };
const NODE = () => process.execPath;
const account: Account = { id: 'grok-main', provider: 'grok', title: 'Grok', configDir: '/g' };
const SAID = 'API error (status 402 Payment Required): Grok Build usage balance exhausted';
// What _x.ai/billing said for that login the next morning.
const SPENT = {
  config: {
    creditUsagePercent: 100,
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-11-18T06:53:23.471544+00:00', end: '2026-11-25T06:53:23.471544+00:00' },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    prepaidBalance: { val: 0 },
    isUnifiedBillingUser: true,
    billingPeriodStart: '2026-11-18T06:53:23.471544+00:00',
    billingPeriodEnd: '2026-11-25T06:53:23.471544+00:00',
  },
  subscription_tier: 'X Premium+',
};

const made: string[] = [];
const live: AcpSession[] = [];
const inheritedGrokHome = process.env.GROK_HOME;
let grokHome = '';
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-grok-402-')));
  made.push(d);
  return d;
}
beforeEach(() => {
  grokHome = tmp();
  process.env.GROK_HOME = grokHome;
});
afterEach(async () => {
  if (inheritedGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = inheritedGrokHome;
  await Promise.all(live.splice(0).map((s) => s.end({ hard: true }).catch(() => undefined)));
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function adapterFor(root: string, billing?: unknown, extraEnv: Record<string, string> = {}): AcpAdapter {
  return new AcpAdapter({
    agent: grok,
    binary: NODE,
    registry: new ProcessRegistry(path.join(root, 'run'), nullLogger),
    log: nullLogger,
    env: { PATH: process.env.PATH, FAKE_ACP_NAME: 'Grok', GROK_HOME: grokHome, FAKE_ACP_LOG: path.join(root, 'agent.log'), ...(billing ? { FAKE_GROK_BILLING: JSON.stringify(billing) } : {}), ...extraEnv },
    timings: { closeWaitMs: 300 },
    dataDir: path.join(root, 'data'),
  });
}

// One turn on a real AcpSession against the pretend Grok; what it put out.
async function turnOn(text: string, billing?: unknown, extraEnv: Record<string, string> = {}): Promise<{ outputs: AdapterOutput[]; log: () => Record<string, unknown>[] }> {
  const root = tmp();
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  const outputs: AdapterOutput[] = [];
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const sink: SessionSink = {
    output(o) {
      outputs.push(o);
      if (o.kind === 'result') done();
    },
    requestApproval: async () => ({ decision: 'allow' }),
    requestQuestion: async () => ({ answers: null }),
    exited: () => done(),
  };
  const s = adapterFor(root, billing, extraEnv).start({ threadId: 't1', cwd, account, permissionMode: 'full', sessionId: 'unused', resume: false, mediaDir: path.join(root, 'media'), blobsDir: path.join(root, 'blobs'), tmpDir: root }, sink) as AcpSession;
  live.push(s);
  s.send({ id: 'm1', text, images: [] });
  await ended;
  // The login's reading comes just after the result.
  for (let i = 0; i < 40 && !outputs.some((o) => o.kind === 'limits'); i++) await new Promise((r) => setTimeout(r, 50));
  const logFile = path.join(root, 'agent.log');
  return { outputs, log: () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

// ---- The words

test("an RPC error says what its data says, not JSON-RPC's own \"Internal error\"", () => {
  const e = new AcpRpcError('session/prompt', { code: -32603, message: 'Internal error', data: { message: SAID, http_status: 402 } });
  assert.equal(e.message, SAID);
  assert.equal(e.rpcMessage, 'Internal error');
  assert.equal(e.httpStatus, 402);
  assert.equal(e.code, -32603);
  // An agent's own message stands; data in words with no message is read too.
  assert.equal(new AcpRpcError('m', { code: -32602, message: 'No such model: grok-9', data: { message: 'other' } }).message, 'No such model: grok-9');
  assert.equal(new AcpRpcError('m', { code: -32603, message: 'Internal error', data: 'disk full' }).message, 'disk full');
  assert.equal(new AcpRpcError('m', { code: -32603, message: 'Internal error' }).message, 'Internal error');
  assert.equal(new AcpRpcError('m', { code: -32603, data: { detail: 'boom' } }).message, 'boom');
  assert.equal(new AcpRpcError('m', {}).message, 'm failed');
});

test("Grok's notes: a later bare \"Internal error\" doesn't hide the reason an earlier one gave", () => {
  const retry = failureNote('_x.ai/session_notification', { sessionUpdate: 'retry_state', type: 'failed', error_type: 'api', message: SAID });
  assert.deepEqual(retry, { message: SAID });
  const bare = failureNote('_x.ai/session_notification', { sessionUpdate: 'turn_completed', stop_reason: 'error', error: { code: -32603, message: 'Internal error' } });
  assert.deepEqual(laterFailure(retry, bare!), { message: SAID });
  const full = failureNote('_x.ai/session_notification', { sessionUpdate: 'turn_completed', stop_reason: 'error', agent_result: SAID, error: { code: -32603, message: 'Internal error', data: { message: SAID, http_status: 402 } } });
  assert.deepEqual(laterFailure(retry, full!), { message: SAID, httpStatus: 402 });
  // ACP's own session/update, and other notes, aren't failures.
  assert.equal(failureNote('session/update', { sessionUpdate: 'retry_state', type: 'failed', message: SAID }), undefined);
  assert.equal(failureNote('_x.ai/session_notification', { sessionUpdate: 'retry_state', type: 'retrying', message: SAID }), undefined);
});

test('out of usage is a 402 or the words Grok uses for it, never a rate limit', () => {
  assert.equal(outOfUsage({ httpStatus: 402 }), true);
  for (const m of [SAID, "You've run out of credits", 'spending-limit reached', 'Usage limit reached for this plan', 'You hit your free usage limit.']) assert.equal(outOfUsage({ message: m }), true, m);
  assert.equal(outOfUsage({ message: 'API error (status 429 Too Many Requests): slow down', httpStatus: 429 }), false);
  assert.equal(outOfUsage({ message: 'Internal error' }), false);
});

test('out of usage recognises Gemini and Google quota exhaustion, not temporary rate limits', () => {
  const gemini429 = 'Agent execution terminated due to error. ("agent executor error: Error 429, Message: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h32m53s., Status: RESOURCE_EXHAUSTED")';
  assert.equal(outOfUsage({ message: gemini429 }), true);
  for (const m of [
    'Individual quota reached. Please upgrade your subscription to increase your limits.',
    'Please upgrade your subscription to increase your limits.',
    'Individual quota reached',
  ]) {
    assert.equal(outOfUsage({ message: m }), true, m);
  }
  // Transient rate limits and generic RESOURCE_EXHAUSTED without subscription/quota limits must not count as out of usage
  for (const m of [
    'Error 429: RESOURCE_EXHAUSTED: quota exceeded for requests per minute. Retry in 1s.',
    'Status: RESOURCE_EXHAUSTED',
    'Quota exceeded for quota metric Requests and limit Requests per minute',
    'Rate limit exceeded. Try again in 2s.',
  ]) {
    assert.equal(outOfUsage({ message: m, httpStatus: 429 }), false, m);
    assert.equal(outOfUsage({ message: m }), false, m);
  }
});

// ---- A turn on a login out of balance

test("Grok's 402 turn fails as a usage limit, saying why, with the login's reading before the result", async () => {
  const { outputs, log } = await turnOn('broke', SPENT);
  const result = outputs.find((o) => o.kind === 'result');
  assert.ok(result && result.kind === 'result');
  assert.equal(result.result.outcome, 'failed');
  assert.equal(result.result.errorKind, 'usageLimit');
  assert.equal(result.result.error, `grok-main is out of Grok usage, so Grok stopped before doing anything (${SAID}).`);
  assert.doesNotMatch(result.result.error!, /Internal error/);
  // The login's reading follows the result (the runner puts it on the
  // login the CLI runs on, wherever the result moves the thread).
  const at = outputs.findIndex((o) => o.kind === 'limits');
  assert.ok(at > outputs.indexOf(result), 'a reading, after the result');
  assert.deepEqual(outputs[at], {
    kind: 'limits',
    windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 0, resetsAt: '2026-11-25T06:53:23.471Z' }],
    blocked: true,
    plan: 'X Premium+',
  });
  assert.equal(log().filter((l) => l.billing).length, 1);
});

test("with only Grok's notes to go on (an answer with no data), the notes' reason and 402 count", async () => {
  const { outputs } = await turnOn('broke', SPENT, { FAKE_GROK_BARE_ERROR: '1' });
  const result = outputs.find((o) => o.kind === 'result');
  assert.ok(result && result.kind === 'result');
  assert.equal(result.result.errorKind, 'usageLimit');
  assert.equal(result.result.error, `grok-main is out of Grok usage, so Grok stopped before doing anything (${SAID}).`);
});

test('a completed turn reads the login too, at most every five minutes, and a reading with room says not blocked', async () => {
  const { outputs, log } = await turnOn('hello');
  const reading = outputs.find((o) => o.kind === 'limits');
  assert.deepEqual(reading, { kind: 'limits', windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 60, resetsAt: '2026-11-25T06:53:23.471Z' }], blocked: false, plan: 'X Premium+' });
  assert.equal(outputs.find((o) => o.kind === 'result')?.kind, 'result');
  assert.equal(log().filter((l) => l.billing).length, 1);
});

// ---- Reading a login without a turn

test('readLimits asks a short-lived Grok for _x.ai/billing, opening no session', async () => {
  const root = tmp();
  const adapter = adapterFor(root, SPENT);
  assert.ok(adapter.readLimits, 'Grok can say');
  const l = await adapter.readLimits(account);
  assert.equal(l?.blocked, true);
  assert.equal(l?.windows[0].remainingPercent, 0);
  const lines = fs.readFileSync(path.join(root, 'agent.log'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.ok(lines.some((x) => x.billing));
  assert.ok(!lines.some((x) => x.newSession), 'no session in Grok\'s own list');
  // Its turns read it on their own process, so it isn't polled as Gemini is.
  assert.equal(adapter.limitsPollMs, undefined);
  // An agent that can't say has no readLimits, so limit-recheck passes it by.
  assert.equal(new AcpAdapter({ agent: ACP_AGENTS.opencode, binary: () => FAKE, registry: new ProcessRegistry(path.join(root, 'run2'), nullLogger), log: nullLogger }).readLimits, undefined);
});

test("grokLimits: the share used, the period's end, the tier; money beyond the plan isn't a block", () => {
  assert.deepEqual(grokLimits({ config: { creditUsagePercent: 12.5, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: '2026-12-01T00:00:00Z' } } }), {
    kind: 'limits',
    windows: [{ kind: 'monthly', title: 'Monthly', remainingPercent: 87.5, resetsAt: '2026-12-01T00:00:00.000Z' }],
    blocked: false,
  });
  // Topped up: not blocked, and at the least room pools still use, so a
  // top-up lets the login run before its week resets.
  const prepaid = grokLimits({ ...SPENT, config: { ...SPENT.config, prepaidBalance: { val: 500 } } });
  assert.equal(prepaid?.blocked, false);
  assert.equal(prepaid?.windows[0].remainingPercent, 1);
  assert.match(prepaid?.windows[0].detail ?? '', /prepaid/);
  // A team's plan ("Usage limits are managed by your team") or another shape: no reading.
  assert.equal(grokLimits({ config: {} }), undefined);
  assert.equal(grokLimits(null), undefined);
  assert.equal(grokLimits({ config: { creditUsagePercent: 5, currentPeriod: { type: 'SOMETHING_NEW' } } })?.windows[0].kind, 'other');
});

test('a login with no reading at all is read once; one with room is left alone', () => {
  const now = Date.parse('2026-11-24T00:00:00Z');
  assert.equal(dueForRecheck(account, true, now, undefined), true);
  assert.equal(dueForRecheck(account, true, now, now - 60_000), false, 'once');
  assert.equal(dueForRecheck(account, false, now, undefined), false);
  assert.equal(dueForRecheck({ ...account, signedOut: true }, true, now, undefined), false);
  assert.equal(dueForRecheck(account, true, now, now - FIRST_READ_RETRY_MS), true, 'again an hour after a failed read');
  const fine: Account = { ...account, usage: { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 60 }], readAt: new Date(now - 86_400_000).toISOString(), source: 'live' } };
  assert.equal(dueForRecheck(fine, true, now, undefined), false);
  // Held out after a run-dry: read again on our own schedule, however fresh
  // the turns' readings are.
  const justRead: Account = { ...fine, usage: { ...fine.usage!, readAt: new Date(now - 60_000).toISOString() } };
  assert.equal(dueForRecheck(justRead, true, now, undefined, { dry: true }), true);
  assert.equal(dueForRecheck(justRead, true, now, now - 60_000, { dry: true }), false);
});

for (const bare of [false, true]) {
  test(`a small job on a login out of balance counts as a limit, so the pool tries the next login${bare ? ' (only the notes say why)' : ''}`, async () => {
    const root = tmp();
    const ask = acpAsker({ agent: grok, binary: NODE, registry: new ProcessRegistry(path.join(root, 'run'), nullLogger), log: nullLogger, env: { PATH: process.env.PATH, FAKE_ACP_NAME: 'Grok', GROK_HOME: grokHome, ...(bare ? { FAKE_GROK_BARE_ERROR: '1' } : {}) }, dataDir: path.join(root, 'data') });
    const r = await ask({ account, user: 'broke', cwd: path.join(root, 'job'), timeoutMs: 20_000 });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.limit, 'a limit');
    assert.ok(!r.ok && r.message.includes('Grok Build usage balance exhausted'));
  });
}

test("a Grok that exits while its limits are read has already given the turn's usage limit", async () => {
  const { outputs } = await turnOn('broke', SPENT, { FAKE_GROK_EXIT_ON_BILLING: '1' });
  const result = outputs.find((o) => o.kind === 'result');
  assert.ok(result && result.kind === 'result', 'the result still went out');
  assert.equal(result.result.errorKind, 'usageLimit');
  assert.equal(outputs.filter((o) => o.kind === 'result').length, 1);
});

// ---- In the runner: marked out, and a pool thread moves within its pool

const sinks = new Map<unknown, UsageSink['record']>();
const grokSink = (h: { runner: unknown }) => sinks.get(h.runner)!;
function grokHarness(pools: Pool[]) {
  const accounts = [...ACCOUNTS, account];
  const claude = new FakeAdapter();
  const grokAdapter = new FakeAdapter('grok', { settingsApplyNextTurn: true, wakesAfterTasks: false });
  const records: [string, UsageReading][] = [];
  const fake = new FakeAccounts(accounts);
  // As the UsageStore would have it: the newest windows, and blocked while it says so.
  const usage: UsageSink = {
    record: (id, r) => {
      records.push([id, r]);
      fake.base = fake.base.map((a) => (a.id !== id ? a : { ...a, usage: { windows: r.windows.length ? r.windows : (a.usage?.windows ?? []), readAt: new Date(h.clock.now()).toISOString(), source: 'live', ...((r.blocked ?? a.usage?.blocked) ? { blocked: true } : {}) } }));
    },
  };
  const h = makeHarness(tmpDir(), { pools }, { accounts: fake, adapters: { claude, grok: grokAdapter }, usage });
  sinks.set(h.runner, usage.record);
  return { ...h, claude, grok: grokAdapter, records, fake };
}
const notesOf = (h: ReturnType<typeof grokHarness>, id: string): string[] => h.events(id).filter((e) => e.type === 'system.note').map((e) => e.text);

// The outputs a real AcpSession gave for the 402 turn, played through the runner.
async function outOfBalanceOutputs(): Promise<AdapterOutput[]> {
  const { outputs } = await turnOn('broke', SPENT);
  return outputs.filter((o) => o.kind === 'limits' || o.kind === 'result');
}

test('in its pool, the thread moves off the Grok login that ran out and carries on, never to another pool', async () => {
  const played = await outOfBalanceOutputs();
  const h = grokHarness([
    { id: 'convex', title: 'Convex', accountIds: ['grok-main', 'claude-main'] },
    { id: 'own', title: 'Own', accountIds: ['claude-3'] },
  ]);
  const { thread } = h.runner.create({ text: 'Write me a note', poolId: 'convex', provider: 'grok' });
  assert.equal(thread.accountId, 'grok-main', 'the explicitly selected Grok login');
  assert.equal(thread.poolId, 'convex');
  const s = h.grok.last;
  s.init(s.opts.sessionId, 'grok-4.7');
  for (const o of played) s.out(o);
  await tick();
  // The error says why, not "Internal error".
  const errors = h.events(thread.id).filter((e) => e.type === 'error').map((e) => e.message);
  assert.deepEqual(errors, [`grok-main is out of Grok usage, so Grok stopped before doing anything (${SAID}).`]);
  const failed = h.events(thread.id).find((e) => e.type === 'turn.completed');
  assert.equal(failed.errorKind, 'usageLimit');
  // Marked out: its reading says blocked until the week resets.
  const mine = h.records.filter(([id]) => id === 'grok-main');
  assert.ok(mine.some(([, r]) => r.blocked === true), 'grok-main marked out');
  assert.equal(h.runner.usableAccounts().find((a) => a.id === 'grok-main')?.usage?.blocked, true);
  // Moved to the other login in its own pool, and carried on.
  const t = h.runner.get(thread.id);
  assert.equal(t.accountId, 'claude-main');
  assert.equal(h.claude.last.opts.account.id, 'claude-main');
  assert.match(notesOf(h, thread.id).find((n) => n.startsWith('Moved'))!, /^Moved to main@example\.com: Grok hit its usage limit\./);
});

test('with nothing else in its pool with room, it waits for room rather than going to another pool', async () => {
  const played = await outOfBalanceOutputs();
  const h = grokHarness([
    { id: 'convex', title: 'Convex', accountIds: ['grok-main'] },
    { id: 'own', title: 'Own', accountIds: ['claude-main', 'claude-3'] },
  ]);
  const { thread } = h.runner.create({ text: 'Write me a note', poolId: 'convex', provider: 'grok' });
  assert.equal(thread.accountId, 'grok-main');
  const s = h.grok.last;
  s.init(s.opts.sessionId, 'grok-4.7');
  for (const o of played) s.out(o);
  await tick();
  const t = h.runner.get(thread.id);
  assert.equal(t.accountId, 'grok-main');
  // Looked at again in 30 minutes (the reading comes after the result);
  // then the reading's reset, a minute after, is what it waits for.
  assert.ok(t.waitingForRoom);
  h.clock.advance(31 * 60_000);
  await tick();
  assert.equal(h.runner.get(thread.id).waitingForRoom?.until, new Date(Date.parse('2026-11-25T06:53:23.471Z') + 60_000).toISOString());
  assert.equal(h.claude.sessions.length, 0, 'nothing started on another pool\'s login');
});

test('a reading that says the login has room again ends the block a 402 put on it', async () => {
  const played = await outOfBalanceOutputs();
  const h = grokHarness([{ id: 'convex', title: 'Convex', accountIds: ['grok-main', 'claude-main'] }]);
  const { thread } = h.runner.create({ text: 'x', poolId: 'convex', provider: 'grok' });
  const s = h.grok.last;
  s.init(s.opts.sessionId, 'grok-4.7');
  for (const o of played) s.out(o);
  await tick();
  assert.ok(h.runner.ranDry.has('grok-main'));
  // A reading that says not blocked but names a window still out (a
  // model's own week) doesn't end it.
  h.runner.recordReading({ record: () => {} }, 'grok-main', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 60 }, { kind: 'weekly_model', title: 'Weekly Fable', remainingPercent: 0 }], blocked: false });
  assert.ok(h.runner.ranDry.has('grok-main'));
  // Topped up, and limit-recheck reads it.
  h.runner.recordReading({ record: () => {} }, 'grok-main', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 100 }], blocked: false });
  assert.equal(h.runner.ranDry.has('grok-main'), false);
  assert.ok(thread);
});

test("a window that's only shown (Gemini's Claude and GPT group) at its limit doesn't keep a dry login out", async () => {
  // Codex's and Gemini's merge reviews, 24 Nov 2026.
  const played = await outOfBalanceOutputs();
  const h = grokHarness([{ id: 'convex', title: 'Convex', accountIds: ['grok-main', 'claude-main'] }]);
  h.runner.create({ text: 'x', poolId: 'convex', provider: 'grok' });
  const s = h.grok.last;
  s.init(s.opts.sessionId, 'grok-4.7');
  for (const o of played) s.out(o);
  await tick();
  assert.ok(h.runner.ranDry.has('grok-main'));
  const aside = { kind: 'weekly_model' as const, title: 'Weekly Claude and GPT', remainingPercent: 0 };
  h.runner.recordReading({ record: () => {} }, 'grok-main', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 100 }, aside], blocked: false, aside: [aside.title] });
  assert.equal(h.runner.ranDry.has('grok-main'), false);
});

test('a thread waiting on its own Grok login carries on there once limit-recheck reads it back with room', async () => {
  const played = await outOfBalanceOutputs();
  const h = grokHarness([
    { id: 'convex', title: 'Convex', accountIds: ['grok-main'] },
    { id: 'own', title: 'Own', accountIds: ['claude-main'] },
  ]);
  const { thread } = h.runner.create({ text: 'Write me a note', poolId: 'convex', provider: 'grok' });
  const s = h.grok.last;
  s.init(s.opts.sessionId, 'grok-4.7');
  for (const o of played) s.out(o);
  await tick();
  assert.ok(h.runner.get(thread.id).waitingForRoom, 'waiting for room');
  // A top-up: limit-recheck reads it with room, through the runner's own usage sink.
  h.runner.recordReading({ record: grokSink(h) }, 'grok-main', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 100, resetsAt: '2026-11-25T06:53:23.471Z' }], blocked: false });
  await tick();
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
  assert.equal(h.runner.get(thread.id).accountId, 'grok-main');
  assert.equal(h.grok.last.opts.account.id, 'grok-main');
  assert.equal(h.grok.last.sent.at(-1)?.text, CARRY_ON_BACK, 'carried on, on grok-main');
  assert.equal(h.claude.sessions.length, 0);
});

test("a reading from a turn still running on the old login is that login's, after the thread was moved", async () => {
  const h = grokHarness([{ id: 'convex', title: 'Convex', accountIds: ['grok-main', 'claude-main'] }]);
  const { thread } = h.runner.create({ text: 'x', poolId: 'convex', provider: 'grok' });
  const s = h.grok.last;
  s.init(s.opts.sessionId, 'grok-4.7');
  // Mike moves it to claude-main mid-turn; the Grok CLI finishes its turn.
  h.runner.update({ threadId: thread.id, accountId: 'claude-main' });
  s.out({ kind: 'limits', windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 0 }], blocked: true });
  assert.deepEqual(h.records.map(([id]) => id), ['grok-main']);
});

test('a 402 while Grok still reads room: reading that same room again is no reason to send the thread back', async () => {
  const played = await outOfBalanceOutputs();
  // As if billing had said 60% left when the 402 came.
  const roomy = played.map((o) => (o.kind === 'limits' ? { ...o, windows: [{ ...o.windows[0], remainingPercent: 60 }], blocked: false } : o));
  const h = grokHarness([
    { id: 'convex', title: 'Convex', accountIds: ['grok-main'] },
    { id: 'own', title: 'Own', accountIds: ['claude-main'] },
  ]);
  const { thread } = h.runner.create({ text: 'x', poolId: 'convex', provider: 'grok' });
  const s = h.grok.last;
  s.init(s.opts.sessionId, 'grok-4.7');
  for (const o of roomy) s.out(o);
  await tick();
  assert.ok(h.runner.get(thread.id).waitingForRoom);
  // The reading after the 402 said 60%, but the store keeps it blocked, so
  // limit-recheck (which reads the store) goes on reading it.
  assert.equal(h.fake.list().find((a) => a.id === 'grok-main')?.usage?.blocked, true);
  const sent = s.sent.length;
  h.runner.recordReading({ record: grokSink(h) }, 'grok-main', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 60 }], blocked: false });
  await tick();
  assert.ok(h.runner.get(thread.id).waitingForRoom, 'still waiting');
  assert.ok(h.runner.ranDry.has('grok-main'));
  assert.equal(s.sent.length, sent, 'nothing sent');
  // The store keeps it blocked too, so limit-recheck goes on reading it.
  assert.equal(h.records.at(-1)?.[1].blocked, true);
  assert.equal(h.fake.list().find((a) => a.id === 'grok-main')?.usage?.blocked, true);
});

test('a prepaid top-up on a used-up plan (read as 1%) counts as back', async () => {
  const played = await outOfBalanceOutputs();
  const h = grokHarness([
    { id: 'convex', title: 'Convex', accountIds: ['grok-main'] },
    { id: 'own', title: 'Own', accountIds: ['claude-main'] },
  ]);
  const { thread } = h.runner.create({ text: 'x', poolId: 'convex', provider: 'grok' });
  const s = h.grok.last;
  s.init(s.opts.sessionId, 'grok-4.7');
  for (const o of played) s.out(o);
  await tick();
  const topped = grokLimits({ ...SPENT, config: { ...SPENT.config, prepaidBalance: { val: 500 } } })!;
  h.runner.recordReading({ record: grokSink(h) }, 'grok-main', { windows: topped.windows, blocked: topped.blocked });
  await tick();
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
  assert.equal(h.grok.last.sent.at(-1)?.text, CARRY_ON_BACK);
});

test('a 402 from a turn still running on the old login after Mike moved the thread marks that login, and leaves the thread where he put it', async () => {
  const played = await outOfBalanceOutputs();
  const h = grokHarness([{ id: 'convex', title: 'Convex', accountIds: ['grok-main', 'claude-main', 'claude-3'] }]);
  const { thread } = h.runner.create({ text: 'x', poolId: 'convex', provider: 'grok' });
  const s = h.grok.last;
  s.init(s.opts.sessionId, 'grok-4.7');
  h.runner.update({ threadId: thread.id, accountId: 'claude-3' });
  for (const o of played) s.out(o);
  await tick();
  assert.ok(h.runner.ranDry.has('grok-main'));
  assert.equal(h.runner.ranDry.has('claude-3'), false);
  assert.equal(h.runner.get(thread.id).accountId, 'claude-3');
});

test("with no reading after the 402 (Grok gone), a recheck's reading is the room to beat, so a top-up still counts", async () => {
  const played = (await outOfBalanceOutputs()).filter((o) => o.kind === 'result');
  const h = grokHarness([
    { id: 'convex', title: 'Convex', accountIds: ['grok-main'] },
    { id: 'own', title: 'Own', accountIds: ['claude-main'] },
  ]);
  const { thread } = h.runner.create({ text: 'x', poolId: 'convex', provider: 'grok' });
  const s = h.grok.last;
  s.init(s.opts.sessionId, 'grok-4.7');
  for (const o of played) s.out(o);
  await tick();
  assert.equal(h.runner.dryRoom.get('grok-main'), Infinity, 'nothing read yet');
  const spent = grokLimits(SPENT)!;
  h.runner.recordReading({ record: grokSink(h) }, 'grok-main', { windows: spent.windows, blocked: spent.blocked });
  assert.equal(h.runner.dryRoom.get('grok-main'), 0);
  assert.ok(h.runner.get(thread.id).waitingForRoom);
  const topped = grokLimits({ ...SPENT, config: { ...SPENT.config, prepaidBalance: { val: 500 } } })!;
  h.runner.recordReading({ record: grokSink(h) }, 'grok-main', { windows: topped.windows, blocked: topped.blocked });
  await tick();
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
});

test('a balance topped up before any recheck counts as back, whatever the login read before', async () => {
  const played = (await outOfBalanceOutputs()).filter((o) => o.kind === 'result');
  const h = grokHarness([
    { id: 'convex', title: 'Convex', accountIds: ['grok-main'] },
    { id: 'own', title: 'Own', accountIds: ['claude-main'] },
  ]);
  // Read at 60% earlier; the 402 comes and no reading follows it.
  h.fake.base = h.fake.base.map((a) => (a.id === 'grok-main' ? { ...a, usage: { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 60 }], readAt: new Date(h.clock.now()).toISOString(), source: 'live' } } : a));
  const { thread } = h.runner.create({ text: 'x', poolId: 'convex', provider: 'grok' });
  const s = h.grok.last;
  s.init(s.opts.sessionId, 'grok-4.7');
  for (const o of played) s.out(o);
  await tick();
  assert.equal(h.runner.dryRoom.get('grok-main'), 60);
  const topped = grokLimits({ ...SPENT, config: { ...SPENT.config, prepaidBalance: { val: 500 } } })!;
  h.runner.recordReading({ record: grokSink(h) }, 'grok-main', { windows: topped.windows, blocked: topped.blocked });
  await tick();
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
});

for (const [reason, error] of [
  ['an individual quota message', new Error('Agent execution terminated due to error. ("agent executor error: Error 429, Message: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h32m53s., Status: RESOURCE_EXHAUSTED")')],
  ['a typed billing error', new SessionUsageLimitError('Billing error')],
] as const) test(`in the runner: a Gemini CLI exit with ${reason} fails the turn with usageLimit and moves pool`, async () => {
  const geminiAccount: Account = { id: 'gemini-main', provider: 'antigravity', title: 'Gemini', configDir: '/tmp' };
  const claude = new FakeAdapter();
  const agyAdapter = new FakeAdapter('antigravity');
  const fake = new FakeAccounts([...ACCOUNTS, geminiAccount]);
  const h = makeHarness(tmpDir(), { pools: [{ id: 'pool-1', title: 'Pool', accountIds: ['gemini-main', 'claude-main'] }] }, { accounts: fake, adapters: { claude, antigravity: agyAdapter } });
  const { thread } = h.runner.create({ text: 'Hello', poolId: 'pool-1' });
  assert.equal(thread.accountId, 'gemini-main');
  const s = agyAdapter.last;
  s.init(s.opts.sessionId, 'gemini-4-neon');
  s.sink.exited(error);
  await tick();
  const failed = h.events(thread.id).find((e) => e.type === 'turn.completed') as { outcome?: string; errorKind?: string } | undefined;
  assert.ok(failed);
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.errorKind, 'usageLimit');
  // Moved off the limit-hit Gemini login to claude-main
  const t = h.runner.get(thread.id);
  assert.equal(t.accountId, 'claude-main');
});

