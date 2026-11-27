// Pools in the runner (docs/protocol/settings.md, "Pools"), with fake adapters and
// the fake clock: picking a pool and login on create (the named model's
// provider decides), the move before a turn, the move after a usageLimit
// failure and its carry-on, the wait and its timer (across a restart),
// the spill to another provider, pinned threads, threads.update poolId,
// and pools.list / pools.save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeAccounts, FakeAdapter, makeHarness, tick, tmpDir, withCodex } from '../helpers/fakes.ts';
import { checkSummary } from '../helpers/protocol-check.ts';
import { readRunnerJson, writeRunnerJson } from '../../src/config.ts';
import type { Account, ModelChoice, Pool, Provider } from '../../src/protocol.ts';
import { RpcError } from '../../src/protocol.ts';
import { MODEL_LIST_TIMEOUT_MS } from '../../src/adapters/types.ts';
import { CallerGate } from '../../src/rpc-gate.ts';
import type { UsageReading } from '../../src/usage.ts';
import { CARRY_ON_BACK, CARRY_ON_MOVED, CARRY_ON_SIGNED_OUT, type SignInSink, type UsageSink } from '../../src/runner.ts';

const MIN = 60_000;
const START = Date.parse('2026-10-26T12:00:00.000Z');

// Usage with a 5-hour window at `pct`, resetting `resetsIn` minutes after
// the fake clock's start.
function room(pct: number, resetsIn?: number, blocked = false): Account['usage'] {
  return {
    windows: [{ kind: 'five_hour', title: '5-hour', remainingPercent: pct, ...(resetsIn !== undefined ? { resetsAt: new Date(START + resetsIn * MIN).toISOString() } : {}) }],
    readAt: new Date(START).toISOString(),
    source: 'live',
    ...(blocked ? { blocked: true } : {}),
  };
}

function poolHarness(o: { accounts?: Account[]; pools?: Pool[]; copy?: boolean; experiments?: Record<string, boolean> } = {}) {
  const fake = new FakeAccounts(o.accounts ?? withCodex());
  const records: [string, UsageReading][] = [];
  const usage: UsageSink = { record: (id, r) => void records.push([id, r]) };
  // The registry's SignInState, as far as the runner sees it: a refusal
  // marks the login signed out in the list, a turn that worked clears it.
  const signInLog: string[] = [];
  const signIn: SignInSink = {
    noteRefused: (id) => {
      signInLog.push(`refused ${id}`);
      fake.base = fake.base.map((a) => (a.id === id ? { ...a, signedOut: true } : a));
    },
    noteWorked: (id) => void signInLog.push(`worked ${id}`),
    onChange: () => () => {},
  };
  const copies: string[][] = [];
  const home = tmpDir();
  if (o.experiments) fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: o.experiments }));
  const h = makeHarness(home, o.pools ? { pools: o.pools } : {}, {
    accounts: fake,
    usage,
    signIn,
    copyTranscript: (fc, tc, f, t, sid) => (copies.push([fc, tc, f, t, sid]), o.copy ?? true),
  });
  const setUsage = (id: string, usage: Account['usage']) => {
    fake.base = fake.base.map((a) => (a.id === id ? { ...a, usage } : a));
  };
  return { ...h, fake, records, copies, setUsage, signInLog };
}

const notes = (h: { events(id: string): any[] }, id: string): string[] => h.events(id).filter((e) => e.type === 'system.note').map((e) => e.text);
const userMessages = (h: { events(id: string): any[] }, id: string) => h.events(id).filter((e) => e.type === 'user.message');
const limit = (s: { result: (...a: any[]) => void }) => s.result('failed', undefined, "You've hit your usage limit", { errorKind: 'usageLimit' });

// ------------------------------------------------------- create

test('a new thread with nothing named is a pool thread on the login with the most room', () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(40));
  h.setUsage('claude-3', room(90));
  const hello = h.runner.hello();
  assert.deepEqual(hello.pools.map((p) => [p.id, p.accountIds]), [
    ['claude', ['claude-main', 'claude-3']],
    ['codex', ['codex-main']],
  ]);
  assert.equal(hello.defaults.poolId, 'claude');
  const { thread } = h.runner.create({ text: 'x' });
  assert.deepEqual(checkSummary(thread), []);
  assert.equal(thread.poolId, 'claude');
  assert.equal(thread.accountId, 'claude-3');
  // An accountId pins, and wins over a poolId.
  const pinned = h.runner.create({ text: 'y', accountId: 'claude-main', poolId: 'codex' }).thread;
  assert.equal(pinned.poolId, undefined);
  assert.equal(pinned.accountId, 'claude-main');
  assert.throws(() => h.runner.create({ text: 'z', poolId: 'nope' }), (e: RpcError) => e.code === -32602 && /No pool called nope/.test(e.message));
});

test('naming a model picks its provider: claude-opus-5-5 with no account never lands on Codex', () => {
  const h = poolHarness();
  // Codex was last used, so its pool is the default.
  writeRunnerJson(h.home, { defaults: { accountId: 'codex-main' } });
  assert.equal(h.runner.hello().defaults.poolId, 'codex');
  const opus = h.runner.create({ text: 'x', model: 'claude-opus-5-5' }).thread;
  assert.equal(opus.provider, 'claude');
  assert.equal(opus.poolId, 'claude');
  assert.equal(opus.model, 'claude-opus-5-5', 'the model is kept');
  assert.equal(h.adapter.last.opts.model, 'claude-opus-5-5');
  assert.deepEqual(notes(h, opus.id), []);
  // Nothing named: the default pool, Codex.
  const plain = h.runner.create({ text: 'y' }).thread;
  assert.equal(plain.provider, 'codex');
  assert.equal(plain.poolId, 'codex');
  // A Codex model from a Claude default goes the other way.
  writeRunnerJson(h.home, { defaults: { accountId: 'claude-3' } });
  const luna = h.runner.create({ text: 'z', model: 'gpt-6-luna' }).thread;
  assert.equal(luna.provider, 'codex');
  assert.equal(luna.model, 'gpt-6-luna');
});

test("a mixed pool's new thread goes on the provider the picker's pick was under", () => {
  const h = poolHarness({ pools: [{ id: 'mix', title: 'Mix', accountIds: ['claude-main', 'codex-main'] }] });
  assert.equal(h.runner.create({ text: 'x', poolId: 'mix' }).thread.provider, 'claude', 'none named: the pool\'s first');
  const codex = h.runner.create({ text: 'y', poolId: 'mix', provider: 'codex' }).thread;
  assert.equal(codex.provider, 'codex');
  assert.equal(codex.accountId, 'codex-main');
  // Only with a pool: a provider alone doesn't pick one.
  assert.equal(h.runner.create({ text: 'z', provider: 'codex' }).thread.provider, 'claude');
});

function listedLogin(id: string, provider: Provider, models?: ModelChoice[], pct = 90): Account {
  return { id, provider, title: id, configDir: `/tmp/${id}`, ...(models ? { models } : {}), usage: room(pct) };
}

function modelChoice(id: string, model = id): ModelChoice {
  return { id, model, title: id };
}

test('a named model uses the login listing it even when another login of that provider has more room', () => {
  const cases = [
    ['codex', 'gpt-luna', 'gpt-sol'],
    ['claude', 'claude-fable', 'claude-opus'],
    ['grok', 'grok-4.7', 'grok-4.5'],
    ['antigravity', 'gemini-pro', 'gemini-flash'],
    ['opencode', 'gpt-open', 'open/other'],
  ] as const;
  for (const [provider, wanted, other] of cases) {
    const adapter = new FakeAdapter(provider);
    const h = makeHarness(undefined, {}, {
      adapters: { [provider]: adapter },
      accounts: new FakeAccounts([
        listedLogin('more-room', provider, [modelChoice(other)]),
        listedLogin('unknown-list', provider),
        listedLogin('offers-model', provider, [modelChoice(wanted)], 35),
      ]),
    });
    const thread = h.runner.create({ text: 'Start', model: wanted }).thread;
    assert.equal(thread.accountId, 'offers-model', provider);
    assert.equal(thread.poolId, provider);
    assert.equal(thread.model, wanted);
    assert.equal(adapter.last.opts.model, wanted);
  }
});

test('an OpenCode pool or picker hint disambiguates model ids shared with direct logins', () => {
  const gpt = modelChoice('gpt-shared');
  const claude = modelChoice('claude-shared');
  const open = new FakeAdapter('opencode');
  const h = makeHarness(undefined, { pools: [
    { id: 'mixed', title: 'Mixed', accountIds: ['claude', 'codex', 'open'] },
    { id: 'open', title: 'Open', accountIds: ['open'] },
  ] }, {
    adapters: { claude: new FakeAdapter(), codex: new FakeAdapter('codex'), opencode: open },
    accounts: new FakeAccounts([
      listedLogin('claude', 'claude', [claude]),
      listedLogin('codex', 'codex', [gpt]),
      listedLogin('open', 'opencode', [claude, gpt]),
    ]),
  });
  for (const [choice, direct] of [[gpt, 'codex'], [claude, 'claude']] as const) {
    assert.equal(h.runner.create({ text: 'Mobile', model: choice.id }).thread.accountId, direct);
    for (const selection of [{ poolId: 'open' }, { poolId: 'mixed', provider: 'opencode' as const }, { accountId: 'open' }]) {
      const thread = h.runner.create({ text: 'Mac', model: choice.id, ...selection }).thread;
      assert.equal(thread.accountId, 'open');
      assert.equal(thread.model, choice.id);
      assert.equal(open.last.opts.model, choice.id);
    }
  }
  h.runner.noteRanDry('open');
  const outOfRoom = h.runner.create({ text: 'Mac', poolId: 'mixed', provider: 'opencode', model: gpt.id }).thread;
  assert.equal(outOfRoom.accountId, 'open', 'the first turn keeps the chosen provider when there is no matching login with room');
  assert.equal(open.last.opts.model, gpt.id);
});

test('an implicit model pick can leave a pool of the right provider that has no login offering it', () => {
  const h = poolHarness({
    accounts: [listedLogin('default', 'codex', [modelChoice('gpt-default')]), listedLogin('elsewhere', 'codex', [modelChoice('gpt-special')])],
    pools: [
      { id: 'default', title: 'Default', accountIds: ['default'] },
      { id: 'elsewhere', title: 'Elsewhere', accountIds: ['elsewhere'] },
    ],
  });
  const thread = h.runner.create({ text: 'Start', model: 'gpt-special' }).thread;
  assert.equal(thread.poolId, 'elsewhere');
  assert.equal(thread.accountId, 'elsewhere');
  assert.equal(thread.model, 'gpt-special');
  const named = h.runner.create({ text: 'Start', poolId: 'default', model: 'gpt-special' }).thread;
  assert.equal(named.poolId, 'default');
  assert.equal(named.accountId, 'default');
  assert.equal(named.model, undefined);
});

test('model selection keeps folder and pool order, skips out-of-room matches and honors an explicit pool', () => {
  const cwd = tmpDir();
  const wanted = modelChoice('fable', 'claude-fable-full');
  const regular = listedLogin('regular', 'claude', [wanted], 60);
  const folder = listedLogin('folder', 'claude', [wanted], 10);
  const noModel = listedLogin('no-model', 'claude', [modelChoice('sonnet')]);
  const otherProvider = listedLogin('codex', 'codex', [modelChoice('gpt-sol')]);
  const h = poolHarness({
    accounts: [regular, folder, noModel, otherProvider],
    pools: [
      { id: 'regular', title: 'Regular', accountIds: ['no-model', 'regular'] },
      { id: 'folder', title: 'Folder', accountIds: ['no-model', 'codex', 'folder'], folders: [cwd] },
      { id: 'also', title: 'Also', accountIds: ['regular'] },
    ],
  });
  writeRunnerJson(h.home, { defaults: { poolId: 'also' } });
  const request = { text: 'Start', cwd, model: wanted.model };
  assert.equal(h.runner.create(request).thread.poolId, 'folder', 'folder wins over saved pool and room elsewhere');
  assert.equal(h.adapter.last.opts.account.id, 'folder');
  h.setUsage('folder', room(0, 30, true));
  const startsElsewhere = h.runner.create(request).thread;
  assert.equal(startsElsewhere.poolId, 'regular', 'the first other eligible pool wins');
  assert.equal(startsElsewhere.accountId, 'regular');
  const stays = h.runner.create({ ...request, poolId: 'folder' }).thread;
  assert.equal(stays.poolId, 'folder');
  assert.equal(stays.accountId, 'folder', 'the first turn keeps the only match in the named pool');
  assert.equal(h.adapter.last.opts.account.id, 'folder');
  assert.equal(h.adapter.last.opts.model, wanted.model);
});

test('matching logins keep room and last-used preference, including when a login signs out', () => {
  const wanted = modelChoice('claude-fable');
  const first = listedLogin('first', 'claude', [wanted], 40);
  const preferred = listedLogin('preferred', 'claude', [wanted], 40);
  const mostRoom = listedLogin('most-room', 'claude', [wanted], 90);
  const h = poolHarness({ accounts: [first, preferred, { ...mostRoom, signedOut: true }] });
  writeRunnerJson(h.home, { defaults: { accountId: 'preferred' } });
  const request = { text: 'Start', model: wanted.id };
  assert.equal(h.runner.create(request).thread.accountId, 'preferred');
  h.setUsage('preferred', room(0.5));
  assert.equal(h.runner.create(request).thread.accountId, 'first');
});

test('unlisted native models try an unprobed login before falling back to the pool default', () => {
  const cold = listedLogin('cold', 'codex', undefined, 20);
  const warm = listedLogin('warm', 'codex', [modelChoice('gpt-listed')]);
  const h = poolHarness({ accounts: [...withCodex().filter((a) => a.provider === 'claude'), warm, cold] });
  const request = { text: 'Start', model: 'gpt-before-probe' };
  const first = h.runner.create(request).thread;
  assert.equal(first.accountId, 'cold');
  assert.equal(first.model, 'gpt-before-probe');
  h.fake.base = h.fake.base.map((a) => a.id === 'cold' ? { ...a, models: [modelChoice('gpt-different')] } : a);
  const fallback = h.runner.create(request).thread;
  assert.equal(fallback.accountId, 'claude-main');
  assert.equal(fallback.model, undefined);
  assert.match(notes(h, fallback.id)[0], /gpt-before-probe isn't a Claude model/);
});

test('a cold OpenCode list defers ambiguous names and retries a failed probe without creating a thread', async () => {
  const open = new FakeAdapter('opencode');
  let finishProbe!: (models: ModelChoice[]) => void;
  let probes = 0;
  open.models = async () => {
    if (++probes === 1) throw new Error('CLI not ready');
    return new Promise((resolve) => { finishProbe = resolve; });
  };
  const claude = new FakeAdapter();
  const codex = new FakeAdapter('codex');
  const h = makeHarness(undefined, {}, {
    adapters: { claude, codex, opencode: open },
    accounts: new FakeAccounts([
      listedLogin('claude', 'claude', [modelChoice('opus', 'claude-open')]),
      listedLogin('claude-cold', 'claude'),
      listedLogin('codex', 'codex', [modelChoice('gpt-other')]),
      listedLogin('open', 'opencode'),
    ]),
  });
  await tick();
  const requests = ['gpt-open', 'claude-open', 'claude-cold-open'].map((model) => ({ text: 'Start', model }));
  const starts = [...requests, { ...requests[0], accountId: 'open' }].map((request) => h.runner.createAfterModelProbe(request));
  await tick();
  assert.equal(probes, 2);
  assert.equal(h.runner.list().length, 0);
  assert.equal(claude.sessions.length + codex.sessions.length + open.sessions.length, 0);
  finishProbe(requests.map(({ model }) => modelChoice(model)));
  const created = await Promise.all(starts);
  assert.deepEqual(created.map(({ thread }) => thread.accountId), ['open', 'open', 'open', 'open']);
  assert.deepEqual(created.map(({ thread }) => thread.model), [...requests.map((r) => r.model), requests[0].model]);
  assert.equal(open.sessions.length, 4);
});

test('a create waits for the OpenCode deadline before returning busy without a thread', async () => {
  const open = new FakeAdapter('opencode');
  open.models = async () => new Promise(() => {});
  const h = makeHarness(undefined, {}, {
    adapters: { claude: new FakeAdapter(), opencode: open },
    accounts: new FakeAccounts([listedLogin('claude', 'claude'), listedLogin('open', 'opencode')]),
  });
  const create = h.runner.createAfterModelProbe({ text: 'Start', model: 'gpt-open' });
  let failed = false;
  const rejects = assert.rejects(create, (e: RpcError) => {
    failed = true;
    return e.code === -32020 && /model lists/.test(e.message);
  });
  await tick();
  assert.equal(failed, false);
  h.clock.advance(MODEL_LIST_TIMEOUT_MS);
  await rejects;
  assert.equal(h.runner.list().length, 0);
  assert.equal(open.sessions.length, 0);
});

test('a successfully fetched empty list offers no models', () => {
  const h = poolHarness({
    accounts: [listedLogin('empty', 'codex', []), listedLogin('cold', 'codex', undefined, 10)],
  });
  const thread = h.runner.create({ text: 'Start', model: 'gpt-unlisted' }).thread;
  assert.equal(thread.accountId, 'cold');
  const pinned = h.runner.create({ text: 'Start', accountId: 'empty', model: 'gpt-unlisted' }).thread;
  assert.equal(pinned.model, undefined);
});

test('an unlisted ACP model is never passed through to Claude', () => {
  const grok = new FakeAdapter('grok');
  const accounts = new FakeAccounts([listedLogin('claude', 'claude'), listedLogin('grok', 'grok')]);
  const h = makeHarness(undefined, {}, { adapters: { claude: new FakeAdapter(), grok }, accounts });
  const request = { text: 'Start', model: 'grok-4' };
  assert.throws(() => h.runner.create(request), /model lists/);
  const pinned = h.runner.create({ ...request, accountId: 'claude' }).thread;
  assert.equal(pinned.model, undefined);
  accounts.learn('grok', { models: [modelChoice(request.model)] });
  assert.equal(h.runner.create(request).thread.accountId, 'grok');
  accounts.learn('grok', { models: [] });
  const stale = h.runner.create(request).thread;
  assert.equal(stale.accountId, 'claude');
  assert.equal(stale.model, undefined);
  assert.match(notes(h, stale.id)[0], /grok-4 isn't a Claude model/);
});

test('an exact picker id beats a resolved alias on a login of the same provider', () => {
  const h = poolHarness({ accounts: [
    listedLogin('alias', 'codex', [modelChoice('gpt-mini', 'gpt-special')]),
    listedLogin('exact', 'codex', [modelChoice('gpt-special', 'gpt-special-version')], 20),
  ] });
  const thread = h.runner.create({ text: 'Start', model: 'gpt-special' }).thread;
  assert.equal(thread.accountId, 'exact');
  assert.equal(h.codex.last.opts.model, 'gpt-special');
});

test('an unpooled login can run a named model after pooled matches are considered', () => {
  const model = modelChoice('gpt-special');
  const h = poolHarness({
    accounts: [
      listedLogin('pooled', 'codex', [model]),
      listedLogin('unpooled', 'codex', [model]),
      { ...listedLogin('noted', 'codex', [model]), note: 'Work only' },
      { ...listedLogin('signed-out', 'codex', [model]), signedOut: true },
    ],
    pools: [{ id: 'default', title: 'Default', accountIds: ['pooled'] }],
  });
  const request = { text: 'Start', model: model.id };
  assert.equal(h.runner.create(request).thread.accountId, 'pooled');
  h.fake.learn('pooled', { models: [modelChoice('gpt-other')] });
  const thread = h.runner.create(request).thread;
  assert.equal(thread.accountId, 'unpooled');
  assert.equal(thread.poolId, undefined);
  assert.equal(thread.model, model.id);
  assert.equal(h.runner.create({ ...request, poolId: 'default' }).thread.accountId, 'pooled');
  h.cfg.pools = [{ id: 'empty', title: 'Empty', accountIds: ['gone'] }];
  assert.equal(h.runner.create(request).thread.accountId, 'unpooled', 'works when there are no usable pools');
  h.cfg.pools = [{ id: 'default', title: 'Default', accountIds: ['pooled'] }];
  h.fake.base = h.fake.base.filter((a) => a.id !== 'unpooled');
  assert.equal(h.runner.create(request).thread.accountId, 'pooled', 'respects signed-out and work-only logins');
});

test("a folder named in a pool's folders starts its threads there; a named pool is remembered", () => {
  const convex = tmpDir();
  const pools: Pool[] = [
    { id: 'claude', title: 'Claude', accountIds: ['claude-main'] },
    { id: 'work', title: 'Work', accountIds: ['claude-3'], folders: [convex] },
    { id: 'codex', title: 'Codex', accountIds: ['codex-main'] },
  ];
  const h = poolHarness({ pools });
  const inside = path.join(convex, 'app');
  fs.mkdirSync(inside);
  const t = h.runner.create({ text: 'x', cwd: inside }).thread;
  assert.equal(t.poolId, 'work');
  assert.equal(t.accountId, 'claude-3');
  assert.equal(readRunnerJson(h.home).defaults?.poolId, undefined, "a folder's pool isn't a choice");
  h.runner.create({ text: 'y', poolId: 'codex' });
  assert.equal(readRunnerJson(h.home).defaults?.poolId, 'codex');
  assert.equal(h.runner.hello().defaults.poolId, 'codex');
  assert.equal(h.runner.create({ text: 'z' }).thread.poolId, 'codex');
});

// ------------------------------------------------------- before a turn

test('before a turn: a login under the minimum moves the thread, carrying the transcript between Claude logins', async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(40));
  h.setUsage('claude-3', room(90));
  const { thread } = h.runner.create({ text: 'x' });
  const s = h.adapter.last;
  s.init();
  s.result();
  // claude-3 drops under 1%: the next message moves first.
  h.setUsage('claude-3', room(0.5, 130));
  h.runner.send(thread.id, 'next');
  await tick();
  const s2 = h.adapter.last;
  assert.notEqual(s2, s);
  assert.equal(s2.opts.account.id, 'claude-main');
  assert.equal(s2.opts.resume, true, 'resumes the carried transcript');
  assert.equal(s2.opts.sessionId, s.opts.sessionId);
  assert.equal(s2.sent[0].text, 'next', 'no handoff note');
  assert.deepEqual(h.copies, [['/tmp/three', '/tmp/main', h.cfg.defaults.cwd, h.cfg.defaults.cwd, s.opts.sessionId]]);
  const n = notes(h, thread.id);
  assert.match(n[0], /^Moved to main@example\.com: three@example\.com hit its 5-hour limit, back at /);
  assert.equal(n[1], 'Resumed the session on main@example.com, with the whole conversation.');
  assert.equal(h.runner.get(thread.id).accountId, 'claude-main');
  assert.equal(h.runner.get(thread.id).poolId, 'claude', 'still a pool thread');
});

test('before a later turn, an explicit picker id moves only to a login offering that picker id', async () => {
  const wanted = modelChoice('gpt-special', 'gpt-special-version');
  const h = poolHarness({ accounts: [
    listedLogin('initial', 'codex', [wanted]),
    listedLogin('alias', 'codex', [modelChoice('gpt-mini', wanted.id)], 80),
    listedLogin('matching', 'codex', [wanted], 40),
  ] });
  const { thread } = h.runner.create({ text: 'Start', model: wanted.id });
  h.codex.last.init();
  h.codex.last.result();
  h.setUsage('initial', room(0));
  h.runner.send(thread.id, 'Next');
  await tick();
  assert.equal(h.runner.get(thread.id).accountId, 'matching');
  assert.equal(h.codex.last.opts.model, wanted.id);
});

test('an explicit OpenCode model waits through a usage limit and restart while Codex has room', async () => {
  const open = new FakeAdapter('opencode');
  const codex = new FakeAdapter('codex');
  const id = 'gpt-shared';
  const accounts = new FakeAccounts([
    listedLogin('codex', 'codex', [modelChoice(id)]),
    { ...listedLogin('open', 'opencode', [modelChoice(id)]), usage: room(80, 60) },
  ]);
  const h = makeHarness(undefined, { pools: [{ id: 'mix', title: 'Mix', accountIds: ['codex', 'open'] }] }, {
    adapters: { codex, opencode: open }, accounts,
  });
  const thread = h.runner.create({ text: 'Start', poolId: 'mix', provider: 'opencode', model: id }).thread;
  open.last.init();
  accounts.base[1] = { ...accounts.base[1], usage: room(0, 60, true) };
  limit(open.last);
  await tick();
  assert.equal(h.runner.get(thread.id).accountId, 'open');
  assert.equal(h.runner.get(thread.id).waitingForRoom?.accountId, 'open');
  assert.equal(codex.sessions.length, 0);
  h.runner.flush();
  const restarted = h.restart();
  restarted.clock.advance(62 * MIN);
  await tick();
  assert.equal(restarted.runner.get(thread.id).accountId, 'open');
  assert.ok(restarted.runner.get(thread.id).waitingForRoom);
  accounts.base[1] = { ...accounts.base[1], usage: room(90) };
  restarted.runner.accountsChanged();
  restarted.clock.advance(31 * MIN);
  await tick();
  assert.equal(restarted.runner.get(thread.id).waitingForRoom, undefined);
  assert.equal(restarted.runner.get(thread.id).accountId, 'open');
  assert.equal(open.last.opts.model, id);
  assert.equal(codex.sessions.length, 0);
});

test('a refused Claude login skips logins missing its explicit model', async () => {
  const wanted = modelChoice('claude-special');
  const h = poolHarness({ accounts: [
    listedLogin('initial', 'claude', [wanted]),
    listedLogin('unsupported', 'claude', [modelChoice('sonnet')], 80),
    listedLogin('matching', 'claude', [wanted], 40),
  ] });
  const { thread } = h.runner.create({ text: 'Start', model: wanted.id });
  h.adapter.last.init();
  h.adapter.last.result('failed', undefined, 'Sign in required', { errorKind: 'auth' });
  await tick();
  assert.equal(h.runner.get(thread.id).accountId, 'matching');
  assert.equal(h.adapter.last.opts.model, wanted.id);
});

for (const action of ['send', 'limit', 'auth'] as const) {
  for (const selection of ['create', 'update'] as const) {
    test(`an Opus choice made at ${selection} before catalogs load still moves after ${action}`, async () => {
      const h = poolHarness({ accounts: [
        listedLogin('initial', 'claude'),
        listedLogin('resolved-only', 'claude', undefined, 80),
        listedLogin('matching', 'claude', undefined, 40),
      ] });
      const thread = h.runner.create({ text: 'Start', ...(selection === 'create' ? { model: 'opus' } : {}) }).thread;
      h.adapter.last.init();
      if (selection === 'update') h.runner.update({ threadId: thread.id, model: 'opus' });
      const opus = modelChoice('opus', 'claude-opus-4-6');
      h.runner.learnAccount('initial', { models: [opus] });
      h.runner.learnAccount('resolved-only', { models: [modelChoice('other-picker-id', 'opus')] });
      h.runner.learnAccount('matching', { models: [opus] });
      if (action === 'send') {
        h.adapter.last.result();
        h.setUsage('initial', room(0));
        h.runner.send(thread.id, 'Next');
      } else if (action === 'limit') {
        limit(h.adapter.last);
      } else {
        h.adapter.last.result('failed', undefined, 'Sign in required', { errorKind: 'auth' });
      }
      await tick();
      assert.equal(h.runner.get(thread.id).accountId, 'matching');
      assert.equal(h.adapter.last.opts.model, 'opus');
    });
  }
}

test('choosing a model on an existing pool thread changes login, and clearing it restores default spillover', async () => {
  const wanted = modelChoice('gpt-special');
  const h = poolHarness({
    accounts: [
      listedLogin('general', 'codex', [modelChoice('gpt-general')]),
      listedLogin('special', 'codex', [wanted], 40),
    ],
  });
  const { thread } = h.runner.create({ text: 'Start' });
  h.codex.last.init();
  h.codex.last.result();
  await tick();
  const selected = h.runner.update({ threadId: thread.id, model: wanted.id }).thread;
  assert.equal(selected.accountId, 'special');
  assert.equal(selected.model, wanted.id);
  h.runner.update({ threadId: thread.id, model: null });
  h.setUsage('special', room(0));
  h.runner.send(thread.id, 'Next');
  await tick();
  assert.equal(h.runner.get(thread.id).accountId, 'general');
  assert.equal(h.codex.last.opts.model, undefined);
});

test('before a turn: a failed copy falls back to the handoff note; a login with room stays put', async () => {
  const h = poolHarness({ copy: false });
  h.setUsage('claude-main', room(40));
  h.setUsage('claude-3', room(90));
  const { thread } = h.runner.create({ text: 'x' });
  h.adapter.last.init();
  h.adapter.last.text('m1:0', 'Done.');
  h.adapter.last.result();
  // A login with less room than another but over the minimum keeps the thread.
  h.setUsage('claude-3', room(20));
  h.runner.send(thread.id, 'a');
  await tick();
  assert.equal(h.adapter.sessions.length, 1, 'same live CLI');
  h.adapter.last.result();
  h.setUsage('claude-3', room(0, 60, true));
  h.runner.send(thread.id, 'b');
  await tick();
  const s2 = h.adapter.last;
  assert.equal(s2.opts.account.id, 'claude-main');
  assert.equal(s2.opts.resume, false);
  assert.match(s2.sent[0].text, /^\[Threadbear handoff\] This conversation moved from the three@example\.com login to main@example\.com/);
  assert.match(notes(h, thread.id)[0], /three@example\.com hit its 5-hour limit, back at /);
});

test('a pinned thread never moves: at its limit it waits for its own login and carries on there', async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(90));
  const { thread } = h.runner.create({ text: 'x', accountId: 'claude-3' });
  assert.equal(thread.poolId, undefined);
  h.adapter.last.init();
  h.setUsage('claude-3', room(0, 60, true));
  limit(h.adapter.last);
  await tick();
  assert.equal(h.adapter.sessions.length, 1, 'no carry-on yet');
  const t = h.runner.get(thread.id);
  assert.deepEqual(checkSummary(t), []);
  assert.deepEqual(t.waitingForRoom, { until: new Date(START + 61 * MIN).toISOString(), accountId: 'claude-3' });
  assert.match(notes(h, thread.id).at(-1)!, /^three@example\.com hit its usage limit\. Carrying on at .* when three@example\.com is back\.$/);
  assert.deepEqual(h.records, [], 'not marked by the pool code');
  // Its login resets: it carries on there, never on claude-main.
  h.setUsage('claude-3', room(100, 360));
  h.clock.advance(62 * MIN);
  await tick();
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
  assert.equal(h.adapter.last.opts.account.id, 'claude-3');
  assert.equal(h.adapter.last.sent.at(-1)?.text, CARRY_ON_BACK);
  assert.equal(h.runner.get(thread.id).accountId, 'claude-3');
  assert.deepEqual(notes(h, thread.id).filter((t) => t.startsWith('Moved')), []);
});

test('a pinned wait whose login is still out waits again; a message from Alex ends it', async () => {
  const h = poolHarness();
  const { thread } = h.runner.create({ text: 'x', accountId: 'claude-3' });
  h.adapter.last.init();
  h.setUsage('claude-3', room(0, 30, true));
  limit(h.adapter.last);
  await tick();
  h.clock.advance(32 * MIN);
  await tick();
  assert.match(notes(h, thread.id).at(-1)!, /^three@example\.com is still at its limit\. Carrying on at /);
  assert.ok(h.runner.get(thread.id).waitingForRoom);
  assert.equal(h.adapter.sessions.length, 1);
  h.runner.send(thread.id, 'try now');
  await tick();
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
  assert.equal(h.adapter.last.sent.at(-1)?.text, 'try now');
});

test('carryOnAtReset: off ends the wait and stops the next one; on again waits while still stuck', async () => {
  const h = poolHarness();
  const { thread } = h.runner.create({ text: 'x', accountId: 'claude-3' });
  h.adapter.last.init();
  h.setUsage('claude-3', room(0, 60, true));
  limit(h.adapter.last);
  await tick();
  assert.ok(h.runner.get(thread.id).waitingForRoom);
  // Off: the wait ends, with a note, and the summary says so.
  const off = h.runner.update({ threadId: thread.id, carryOnAtReset: false }).thread;
  assert.deepEqual(checkSummary(off), []);
  assert.equal(off.carryOnAtReset, false);
  assert.equal(off.waitingForRoom, undefined);
  assert.match(notes(h, thread.id).at(-1)!, /^Won't carry on by itself\./);
  h.clock.advance(62 * MIN);
  await tick();
  assert.equal(h.adapter.sessions.length, 1, 'nothing at the reset');
  // On again while the last turn still stands at the limit: it waits.
  h.setUsage('claude-3', room(0, 120, true));
  const on = h.runner.update({ threadId: thread.id, carryOnAtReset: true }).thread;
  assert.equal(on.carryOnAtReset, undefined);
  assert.deepEqual(on.waitingForRoom, { until: new Date(START + 121 * MIN).toISOString(), accountId: 'claude-3' });
  // Off, then a turn that hits the limit doesn't wait at all.
  h.runner.update({ threadId: thread.id, carryOnAtReset: false });
  h.runner.send(thread.id, 'again');
  await tick();
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
  // A pool thread with nothing left doesn't wait either.
  const p = h.runner.create({ text: 'y', poolId: 'claude' }).thread;
  h.runner.update({ threadId: p.id, carryOnAtReset: false });
  h.setUsage('claude-main', room(0, 60, true));
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  assert.equal(h.runner.get(p.id).waitingForRoom, undefined);
});

// ------------------------------------------------------- during a turn

test('a turn that hits the limit marks the login, moves and carries on; the carry-on hitting it too with nothing left waits', async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(80, 300));
  h.setUsage('claude-3', room(40, 120));
  const { thread } = h.runner.create({ text: 'Fix the tests' });
  assert.equal(thread.accountId, 'claude-main');
  const s = h.adapter.last;
  s.init();
  limit(s);
  await tick();
  // Marked blocked until its window resets, moved, and carried on.
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0][0], 'claude-main');
  assert.equal(h.records[0][1].blocked, true);
  assert.equal(h.records[0][1].blockedUntil, START + 300 * MIN);
  const s2 = h.adapter.last;
  assert.notEqual(s2, s);
  assert.equal(s2.opts.account.id, 'claude-3');
  assert.equal(s2.opts.resume, true);
  assert.equal(s2.sent[0].text, CARRY_ON_MOVED);
  const carry = userMessages(h, thread.id).at(-1);
  assert.equal(carry.origin, 'runner');
  assert.match(notes(h, thread.id)[0], /^Moved to three@example\.com: main@example\.com hit its 5-hour limit, back at /);
  // The new login fails the same way straight away: both are marked, so
  // no loop back to main, a wait.
  s2.init();
  limit(s2);
  await tick();
  assert.equal(h.adapter.sessions.length, 2, 'no third session');
  const t = h.runner.get(thread.id);
  assert.deepEqual(checkSummary(t), []);
  assert.equal(t.waitingForRoom?.accountId, 'claude-3', 'claude-3 is back first');
  assert.equal(t.waitingForRoom?.until, new Date(START + 121 * MIN).toISOString());
  assert.match(notes(h, thread.id).at(-1)!, /^Every login in Claude is out of room\. Carrying on at .* when three@example\.com is back\.$/);
  // At that time it looks again: claude-3 has reset, so it stays and carries on.
  h.setUsage('claude-3', room(100, 420));
  h.clock.advance(122 * MIN);
  await tick();
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
  assert.equal(h.adapter.last.sent.at(-1)?.text, CARRY_ON_BACK);
  assert.equal(h.adapter.last.opts.account.id, 'claude-3');
});

test('a turn refused as signed out marks the login, moves the pool thread and carries on; a pinned thread stays put (14 Nov)', async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(80, 300));
  h.setUsage('claude-3', room(40, 120));
  const { thread } = h.runner.create({ text: 'Nightly retro' });
  assert.equal(thread.accountId, 'claude-main');
  const s = h.adapter.last;
  s.init();
  s.result('failed', undefined, 'Failed to authenticate: this login reached its time limit and cannot be renewed.', { errorKind: 'auth' });
  await tick();
  assert.deepEqual(h.signInLog, ['refused claude-main']);
  assert.equal(h.records.length, 0, 'not a usage limit');
  const s2 = h.adapter.last;
  assert.notEqual(s2, s);
  assert.equal(s2.opts.account.id, 'claude-3');
  assert.equal(s2.sent[0].text, CARRY_ON_SIGNED_OUT);
  assert.equal(notes(h, thread.id)[0], 'Moved to three@example.com: main@example.com is signed out.');
  s2.init();
  s2.result();
  await tick();
  assert.deepEqual(h.signInLog, ['refused claude-main', 'worked claude-3']);
  // A new thread never starts on the signed-out login, room or not.
  h.setUsage('claude-main', room(100, 300));
  assert.equal(h.runner.create({ text: 'y' }).thread.accountId, 'claude-3');
  // Pinned to it: no move, the banner's sign-in is the way on.
  const pinned = h.runner.create({ text: 'z', accountId: 'claude-main' }).thread;
  const p = h.adapter.last;
  p.init();
  p.result('failed', undefined, 'Not logged in', { errorKind: 'auth' });
  await tick();
  assert.equal(h.adapter.last, p);
  assert.equal(h.runner.get(pinned.id).accountId, 'claude-main');
  assert.equal(h.runner.get(pinned.id).status, 'error');
});

test('a refused Codex login leaves its pool thread where it is: only Claude refusals are remembered, so a move could bounce for ever', async () => {
  const two: Account = { id: 'codex-2', provider: 'codex', title: 'codex-two@example.com', configDir: '/tmp/codex-two' };
  const pools: Pool[] = [{ id: 'codex', title: 'Codex', accountIds: ['codex-main', 'codex-2'] }];
  const h = poolHarness({ accounts: [...withCodex(), two], pools });
  h.setUsage('codex-main', room(80, 300));
  h.setUsage('codex-2', room(60, 300));
  const { thread } = h.runner.create({ text: 'x', poolId: 'codex' });
  const was = h.runner.get(thread.id).accountId;
  const s = h.codex.last;
  s.init();
  s.result('failed', undefined, 'Not logged in', { errorKind: 'auth' });
  await tick();
  assert.equal(h.codex.last, s, 'no carry-on');
  assert.equal(h.runner.get(thread.id).accountId, was);
  assert.equal(h.runner.get(thread.id).status, 'error');
  assert.deepEqual(notes(h, thread.id), []);
});

test('a scheduled run moved off a signed-out login keeps its way back to the archive', async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(80, 300));
  h.setUsage('claude-3', room(40, 120));
  const { thread } = h.runner.create({ text: 'Check for a reply' });
  let s = h.adapter.last;
  s.init();
  s.result();
  await tick();
  h.runner.update({ threadId: thread.id, archived: true });
  h.runner.send(thread.id, 'Check for a reply', [], { origin: 'schedule', scheduleId: 'sch_1' });
  assert.equal(h.runner.get(thread.id).archivedAt, undefined, 'out for the run');
  s = h.adapter.last;
  s.init();
  s.result('failed', undefined, 'Not logged in', { errorKind: 'auth' });
  await tick();
  const s2 = h.adapter.last;
  assert.notEqual(s2, s);
  assert.equal(s2.opts.account.id, 'claude-3');
  s2.init();
  s2.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: 'mcp__threadbear__end_turn', kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  s2.text('m1', 'Nothing new.');
  s2.result();
  await tick();
  assert.ok(h.runner.get(thread.id).archivedAt, 'the carried-on run found nothing, so back it goes');
});

test("a nested thread moved off a signed-out login doesn't hand its starter the held reports early", async () => {
  const h = poolHarness({ experiments: { nestedThreads: true } });
  h.setUsage('claude-main', room(80, 300));
  h.setUsage('claude-3', room(40, 120));
  const parent = h.runner.create({ text: 'Port the app', accountId: 'claude-3' }).thread.id;
  h.adapter.last.init();
  h.adapter.last.result();
  await tick();
  const started = { kind: 'thread' as const, label: 'Agent', threadId: parent };
  const a = h.runner.create({ text: 'Build the pane', startedBy: started }).thread.id;
  const sa = h.adapter.last;
  sa.init();
  const b = h.runner.create({ text: 'Wire sign-in', accountId: 'claude-3', startedBy: started }).thread.id;
  h.adapter.last.init();
  const before = userMessages(h, parent).length;
  assert.equal(h.runner.send(parent, `[Sent by the agent in the thread "${h.runner.get(b).title}" (${b.slice(0, 8)})]\n\nHalfway there.`).held, true);
  assert.equal(h.runner.get(a).accountId, 'claude-main');
  sa.result('failed', undefined, 'Not logged in', { errorKind: 'auth' });
  await tick();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.adapter.last.opts.account.id, 'claude-3', 'a carried on on the other login');
  assert.equal(userMessages(h, parent).length, before, 'still held: a is still working');
});

test('a schedule pinned to a signed-out login runs on a pool holding it, and says so (16 Nov)', () => {
  const two: Account = { id: 'claude-2', provider: 'claude', title: 'work@example.com', configDir: '/tmp/two' };
  const pools: Pool[] = [
    { id: 'claude', title: 'Claude', accountIds: ['claude-main', 'claude-3'] },
    { id: 'work', title: 'Work', accountIds: ['claude-2'] },
  ];
  const h = poolHarness({ accounts: [...withCodex(), two], pools });
  h.setUsage('claude-main', room(80));
  h.setUsage('claude-3', room(60));
  h.fake.base = h.fake.base.map((a) => (a.id === 'claude-main' || a.id === 'claude-2' ? { ...a, signedOut: true } : a));
  const { thread } = h.runner.create({ text: 'Nightly retro', accountId: 'claude-main', model: 'opus', origin: 'schedule', scheduleId: 's1' });
  assert.equal(thread.accountId, 'claude-3');
  assert.equal(thread.poolId, 'claude');
  assert.equal(h.adapter.last.opts.account.id, 'claude-3');
  const note = h.events(thread.id).find((e) => e.type === 'system.note' && e.login);
  assert.equal(note?.text, 'Moved to three@example.com: main@example.com is signed out.');
  // Alone in its pool (Convex work only): nowhere else to go, so it stays
  // pinned and its banner offers the sign-in.
  const alone = h.runner.create({ text: 'Daily brief', accountId: 'claude-2', origin: 'schedule', scheduleId: 's2' }).thread;
  assert.equal(alone.accountId, 'claude-2');
  assert.equal(alone.poolId, undefined);
  // Mike pinning a thread himself is his call: no stand-in.
  const mine = h.runner.create({ text: 'x', accountId: 'claude-main' }).thread;
  assert.equal(mine.accountId, 'claude-main');
  // Signed in: the schedule's own login, as pinned.
  h.fake.base = h.fake.base.map((a) => (a.id === 'claude-main' ? { ...a, signedOut: undefined } : a));
  assert.equal(h.runner.create({ text: 'y', accountId: 'claude-main', origin: 'schedule', scheduleId: 's1' }).thread.accountId, 'claude-main');
});

test('before a turn: a pool thread on a signed-out login moves first', async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(80));
  h.setUsage('claude-3', room(90));
  const { thread } = h.runner.create({ text: 'x' });
  assert.equal(thread.accountId, 'claude-3');
  const s = h.adapter.last;
  s.init();
  s.result();
  h.fake.base = h.fake.base.map((a) => (a.id === 'claude-3' ? { ...a, signedOut: true } : a));
  h.runner.send(thread.id, 'next');
  await tick();
  assert.equal(h.adapter.last.opts.account.id, 'claude-main');
  assert.equal(notes(h, thread.id)[0], 'Moved to main@example.com: three@example.com is signed out.');
});

test('a carry-on that runs dry too moves on again while another login in the pool has room', async () => {
  const one: Account = { id: 'claude-1', provider: 'claude', title: 'one@example.com', configDir: '/tmp/one' };
  const pools: Pool[] = [{ id: 'claude', title: 'Claude', accountIds: ['claude-main', 'claude-3', 'claude-1'] }];
  const h = poolHarness({ accounts: [...withCodex(), one], pools });
  h.setUsage('claude-main', room(80, 300));
  h.setUsage('claude-3', room(60, 120));
  h.setUsage('claude-1', room(40, 200));
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  const first = h.runner.get(thread.id).accountId;
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  const second = h.adapter.last;
  assert.notEqual(second.opts.account.id, first);
  second.init();
  limit(second);
  await tick();
  // Mike, 12 Nov: it should just carry on while the pool has a login with room.
  const third = h.adapter.last;
  assert.equal(h.adapter.sessions.length, 3);
  const used = new Set([first, second.opts.account.id, third.opts.account.id]);
  assert.equal(used.size, 3, 'each login once');
  assert.equal(third.sent[0].text, CARRY_ON_MOVED);
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
  // The last one dry too: now it waits.
  third.init();
  limit(third);
  await tick();
  assert.equal(h.adapter.sessions.length, 3, 'no fourth session');
  assert.ok(h.runner.get(thread.id).waitingForRoom);
});

test('a waiting pool thread carries on as soon as a login with room joins the pool, not at its wait time', async () => {
  // 12 Nov: a thread's turn hit its limit on a draining runner that had
  // started before a new login joined the pool, so it set a wait for 1 pm
  // though that login had 81% left, and the runner that took it over kept
  // the wait.
  const h = poolHarness();
  h.setUsage('claude-main', room(60, 200));
  h.setUsage('claude-3', room(0.2, 90));
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  assert.ok(h.runner.get(thread.id).waitingForRoom, 'nothing has room yet');
  assert.equal(h.adapter.sessions.length, 1);
  // A new login turns up with room, and is added to the pool.
  const four: Account = { id: 'claude-4', provider: 'claude', title: 'four@example.com', configDir: '/tmp/four', usage: room(81, 300) };
  h.fake.base = [...h.fake.base, four];
  h.runner.rescanAccounts();
  await h.runner.savePools([{ id: 'claude', title: 'Claude', accountIds: ['claude-main', 'claude-3', 'claude-4'] }, { id: 'codex', title: 'Codex', accountIds: ['codex-main'] }]);
  await tick();
  const t = h.runner.get(thread.id);
  assert.equal(t.waitingForRoom, undefined, 'the wait ended early');
  assert.equal(t.accountId, 'claude-4');
  assert.equal(h.adapter.last.opts.account.id, 'claude-4');
  assert.equal(h.adapter.last.sent.at(-1)?.text, CARRY_ON_MOVED);
});

test('a waiting pool thread carries on as soon as a usage reading shows a login has room again', async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(60, 200));
  h.setUsage('claude-3', room(0.2, 90));
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  assert.ok(h.runner.get(thread.id).waitingForRoom);
  // claude-3's 5-hour window reset early, as far as the wait's guess went.
  h.setUsage('claude-3', room(100, 400));
  h.runner.sendAccounts();
  await tick();
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
  assert.equal(h.adapter.last.opts.account.id, 'claude-3');
});

test("an early carry-on leaves the login the wait is for to the timer, with its minute's grace", async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(60, 200));
  h.setUsage('claude-3', room(0.2, 90));
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  assert.equal(h.runner.get(thread.id).waitingForRoom?.until, new Date(START + 91 * MIN).toISOString());
  // At claude-3's reset the usage store says it's full again, but the
  // provider can still refuse for a few seconds: not yet.
  h.clock.advance(90 * MIN);
  h.setUsage('claude-3', room(100, 390));
  h.runner.sendAccounts();
  await tick();
  assert.equal(h.adapter.sessions.length, 1, 'not at the reset itself');
  h.clock.advance(1 * MIN);
  await tick();
  assert.equal(h.adapter.sessions.length, 2);
  assert.equal(h.adapter.last.opts.account.id, 'claude-3');
});

test('a snoozed waiting thread keeps its wait when a login has room, and carries on when the wait comes due', async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(60, 200));
  h.setUsage('claude-3', room(0.2, 90));
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  const w = h.runner.get(thread.id).waitingForRoom;
  assert.ok(w);
  h.runner.update({ threadId: thread.id, snoozedUntil: new Date(START + 60 * MIN).toISOString() });
  h.setUsage('claude-3', room(100, 400));
  h.runner.sendAccounts();
  await tick();
  assert.deepEqual(h.runner.get(thread.id).waitingForRoom, w, 'kept while snoozed');
  assert.equal(h.adapter.sessions.length, 1);
  h.clock.advance(92 * MIN);
  await tick();
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
  assert.equal(h.adapter.last.opts.account.id, 'claude-3');
});

test("the limit box's Continue now on: a login named with carryOn pins the thread there and carries on at once", async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(60, 200));
  h.setUsage('claude-3', room(0.2, 90));
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  assert.ok(h.runner.get(thread.id).waitingForRoom);
  const one: Account = { id: 'claude-1', provider: 'claude', title: 'one@example.com', configDir: '/tmp/one', usage: room(70, 300) };
  h.fake.base = [...h.fake.base, one];
  h.runner.update({ threadId: thread.id, accountId: 'claude-1', carryOn: true });
  await tick();
  const t = h.runner.get(thread.id);
  assert.equal(t.poolId, undefined, 'pinned');
  assert.equal(t.waitingForRoom, undefined);
  assert.equal(h.adapter.last.opts.account.id, 'claude-1');
  assert.equal(h.adapter.last.sent.at(-1)?.text, CARRY_ON_MOVED);
  assert.equal(userMessages(h, thread.id).at(-1).origin, 'runner');
  // Once it's going, carryOn on another switch does nothing more.
  const sessions = h.adapter.sessions.length;
  h.runner.update({ threadId: thread.id, accountId: 'claude-main', carryOn: true });
  await tick();
  assert.equal(h.adapter.sessions.length, sessions);
});

test('the model menu after a limit: moving to Codex carries on at once, on the model picked (Ian, 13 Nov)', async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(0.2, 200));
  h.setUsage('claude-3', room(0.2, 90));
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  h.adapter.last.init();
  h.adapter.last.text('m1:0', 'Half done.');
  limit(h.adapter.last);
  await tick();
  assert.ok(h.runner.get(thread.id).waitingForRoom, 'the whole Claude pool is out');
  // The Swift picker's two calls: pinned with the model, then into the pool.
  h.runner.update({ threadId: thread.id, accountId: 'codex-main', model: 'gpt-6-luna' });
  h.runner.update({ threadId: thread.id, poolId: 'codex' });
  await tick();
  const t = h.runner.get(thread.id);
  assert.equal(t.poolId, 'codex');
  assert.equal(t.waitingForRoom, undefined);
  assert.equal(h.codex.sessions.length, 1);
  assert.equal(h.codex.last.opts.model, 'gpt-6-luna');
  assert.match(h.codex.last.sent[0].text, /^\[Threadbear handoff\][\s\S]*Half done\.[\s\S]*Carry on from where you left off\.$/);
  assert.ok(!notes(h, thread.id).some((n) => /takes over from your next message/.test(n)), 'no "next message" note when it carries on now');
});

test('a move with nothing to carry on, or carrying on turned off, says the new model starts with the next message', async () => {
  const h = poolHarness();
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  h.adapter.last.init();
  h.adapter.last.result();
  await tick();
  h.runner.update({ threadId: thread.id, poolId: 'codex' });
  await tick();
  assert.equal(h.codex.sessions.length, 0, 'nothing runs till Alex writes');
  assert.match(notes(h, thread.id).at(-1)!, /takes over from your next message\.$/);

  // At a limit with "Carry on by itself: No", the menu doesn't override it.
  h.setUsage('claude-main', room(0.2, 200));
  h.setUsage('claude-3', room(0.2, 90));
  const other = h.runner.create({ text: 'y', poolId: 'claude' }).thread;
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  h.runner.update({ threadId: other.id, carryOnAtReset: false });
  h.runner.update({ threadId: other.id, poolId: 'codex' });
  await tick();
  assert.equal(h.codex.sessions.length, 0);
  assert.match(notes(h, other.id).at(-1)!, /takes over from your next message\.$/);
});

test("an agent's move after a limit never starts a turn by itself: the thread may have more access than the agent", async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(0.2, 200));
  h.setUsage('claude-3', room(0.2, 90));
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  h.runner.update({ threadId: thread.id, poolId: 'codex', byAgent: true });
  await tick();
  assert.equal(h.codex.sessions.length, 0);
  assert.match(notes(h, thread.id).at(-1)!, /takes over from your next message\.$/);
});

test('a pool with both providers: a Codex model picked from the menu goes to its Codex login and carries on there', async () => {
  const pools: Pool[] = [{ id: 'claude', title: 'Claude', accountIds: ['claude-main'] }, { id: 'mixed', title: 'Mixed', accountIds: ['codex-main', 'claude-3'] }];
  const h = poolHarness({ pools });
  h.setUsage('claude-main', room(0.2, 200));
  h.setUsage('claude-3', room(80, 200));
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  // GPUI's one call: the pool and the model.
  h.runner.update({ threadId: thread.id, poolId: 'mixed', model: 'gpt-6-luna' });
  await tick();
  const t = h.runner.get(thread.id);
  assert.equal(t.accountId, 'codex-main');
  assert.equal(t.model, 'gpt-6-luna');
  assert.equal(h.codex.sessions.length, 1);
});

test('a turn the CLI starts after a limit stop ends it: a move later starts nothing', async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(0.2, 200));
  h.setUsage('claude-3', room(0.2, 90));
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  const s = h.adapter.last;
  s.init();
  limit(s);
  await tick();
  // A background job finishes and the CLI answers it by itself.
  s.out({ kind: 'cliTurn', note: 'Background command "sleep 5" completed (exit code 0)' });
  s.result('completed', 0, undefined, { own: true });
  await tick();
  h.runner.update({ threadId: thread.id, poolId: 'codex' });
  await tick();
  assert.equal(h.codex.sessions.length, 0);
});

test("a mixed pool that already has the thread's Claude login: a Codex pick still moves it to Codex", async () => {
  const pools: Pool[] = [{ id: 'mixed', title: 'Mixed', accountIds: ['claude-3', 'codex-main'] }];
  const h = poolHarness({ pools });
  h.setUsage('claude-3', room(80, 200));
  const { thread } = h.runner.create({ text: 'x', model: 'claude-opus-5-5' });
  h.adapter.last.init();
  h.adapter.last.result();
  await tick();
  // GPUI's default row: no model, the column's provider.
  h.runner.update({ threadId: thread.id, poolId: 'mixed', model: null, provider: 'codex' });
  assert.equal(h.runner.get(thread.id).accountId, 'codex-main');
  assert.equal(h.runner.get(thread.id).provider, 'codex');
});

test('a turn the CLI starts after a limit stop also ends the wait for room: its timer starts nothing later', async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(0.2, 200));
  h.setUsage('claude-3', room(0.2, 90));
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  const s = h.adapter.last;
  s.init();
  limit(s);
  await tick();
  assert.ok(h.runner.get(thread.id).waitingForRoom);
  s.out({ kind: 'cliTurn', note: 'Background command "sleep 5" completed (exit code 0)' });
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
  s.result('completed', 0, undefined, { own: true });
  await tick();
  const sent = s.sent.length;
  h.setUsage('claude-3', room(100, 400));
  h.clock.advance(300 * MIN);
  await tick();
  assert.equal(h.adapter.sessions.length, 1);
  assert.equal(s.sent.length, sent, 'no carry-on from the old wait');
});

test("the caller gate marks any agent's move, Full access's too, so it never carries on by itself", () => {
  const h = poolHarness();
  const full = h.runner.create({ text: 'x', permissionMode: 'full' }).thread;
  const ask = h.runner.create({ text: 'y', permissionMode: 'ask' }).thread;
  const gate = new CallerGate({ runner: h.runner });
  assert.equal(gate.check(full.id, 'threads.update', { threadId: ask.id, poolId: 'codex' }).byAgent, true);
  assert.equal(gate.check(ask.id, 'threads.update', { threadId: ask.id, poolId: 'codex' }).byAgent, true);
  assert.equal(gate.check(full.id, 'threads.update', { threadId: ask.id, title: 'z' }).byAgent, undefined);
});

// Daybreak 121 (13 Nov 2026): the full sync question's thread could set it
// whatever its mode, from words any same-mode thread could send it. Now no
// thread short of Full may; Mike's pick on its card sets it (full-sync-answer.test.ts).
test("no thread short of Full sets full sync, the question's own included", () => {
  const h = poolHarness();
  const asking = h.runner.create({ text: 'q', permissionMode: 'ask' }).thread;
  const auto = h.runner.create({ text: 'o', permissionMode: 'auto' }).thread;
  const gate = new CallerGate({ runner: h.runner });
  assert.throws(() => gate.check(asking.id, 'settings.update', { fullSync: true }));
  assert.throws(() => gate.check(auto.id, 'settings.update', { fullSync: true }));
  assert.throws(() => gate.check(asking.id, 'settings.update', { defaultCwd: '/' }));
});

test("an agent's move ends the thread's wait for room, so the old timer can't carry it on later either", async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(0.2, 200));
  h.setUsage('claude-3', room(0.2, 90));
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  assert.ok(h.runner.get(thread.id).waitingForRoom);
  h.runner.update({ threadId: thread.id, poolId: 'codex', byAgent: true });
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
  h.clock.advance(300 * MIN);
  await tick();
  assert.equal(h.codex.sessions.length, 0);
});

test('after a restart an early carry-on moves to the login with room, never back to the one that ran dry', async () => {
  const pools: Pool[] = [{ id: 'claude', title: 'Claude', accountIds: ['claude-main', 'claude-3', 'claude-1'] }, { id: 'codex', title: 'Codex', accountIds: ['codex-main'] }];
  const h = poolHarness({ pools });
  h.setUsage('claude-main', room(60, 200));
  h.setUsage('claude-3', room(0.2, 90));
  const { thread } = h.runner.create({ text: 'x', poolId: 'claude' });
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  assert.ok(h.runner.get(thread.id).waitingForRoom);
  // A new runner forgets what ran dry, and a reading from another of
  // main's sessions says it has room (a model's own limit, say).
  const h2 = h.restart();
  await tick();
  assert.equal(h2.adapter.sessions.length, 0, 'not back onto main');
  const one: Account = { id: 'claude-1', provider: 'claude', title: 'one@example.com', configDir: '/tmp/one', usage: room(81, 300) };
  h.fake.base = [...h.fake.base, one];
  h2.runner.sendAccounts();
  await tick();
  assert.equal(h2.adapter.sessions.length, 1);
  assert.equal(h2.adapter.last.opts.account.id, 'claude-1');
  assert.equal(h2.runner.get(thread.id).accountId, 'claude-1');
});

test('nothing in the pool has room: the thread waits, and the wait outlives a restart', async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(60, 200));
  h.setUsage('claude-3', room(0.2, 90));
  const { thread } = h.runner.create({ text: 'x' });
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  const w = h.runner.get(thread.id).waitingForRoom;
  assert.deepEqual(w, { until: new Date(START + 91 * MIN).toISOString(), accountId: 'claude-3' });
  assert.match(notes(h, thread.id).at(-1)!, /^Every login in Claude is out of room\. Carrying on at .* when three@example\.com is back\.$/);
  assert.equal(h.adapter.sessions.length, 1);
  // The UsageStore keeps the block across the restart; the fake stands in.
  h.setUsage('claude-main', room(60, 200, true));
  // A new runner on the same data dir (its clock starts at START again).
  const h2 = h.restart();
  assert.deepEqual(h2.runner.get(thread.id).waitingForRoom, w, 'kept in thread.json');
  h2.clock.advance(80 * MIN);
  await tick();
  assert.equal(h2.adapter.sessions.length, 0, 'not yet');
  // claude-3 resets; the new runner carries on by itself.
  h.fake.base = h.fake.base.map((a) => (a.id === 'claude-3' ? { ...a, usage: room(100) } : a));
  h2.clock.advance(12 * MIN);
  await tick();
  assert.equal(h2.adapter.sessions.length, 1);
  assert.equal(h2.adapter.last.opts.account.id, 'claude-3');
  assert.equal(h2.adapter.last.sent[0].text, CARRY_ON_MOVED);
  assert.equal(h2.runner.get(thread.id).waitingForRoom, undefined);
});

test('a wait that finds no room waits again; a message from Alex ends it and goes through the before-a-turn check', async () => {
  const h = poolHarness();
  h.setUsage('claude-main', room(0, 30, true));
  h.setUsage('claude-3', room(0.3));
  const { thread } = h.runner.create({ text: 'x', accountId: undefined });
  h.adapter.last.init();
  limit(h.adapter.last);
  await tick();
  // No reset time for claude-3, claude-main's block resets at 30 min.
  assert.equal(h.runner.get(thread.id).waitingForRoom?.accountId, 'claude-main');
  h.clock.advance(32 * MIN);
  await tick();
  // Still blocked (the reading says so, and it was marked).
  assert.match(notes(h, thread.id).at(-1)!, /^Still no room in Claude\. Carrying on at /);
  assert.ok(h.runner.get(thread.id).waitingForRoom);
  assert.equal(h.adapter.sessions.length, 1);
  // Alex sends something: the wait ends and the turn starts on the best there is.
  h.setUsage('claude-main', room(70));
  h.runner.send(thread.id, 'try now');
  await tick();
  assert.equal(h.runner.get(thread.id).waitingForRoom, undefined);
  assert.equal(h.adapter.last.opts.account.id, 'claude-main');
  assert.equal(h.adapter.last.sent.at(-1)?.text, 'try now');
});

test('spill: with no Claude login left, a mixed pool moves the thread to Codex as a handoff, and it stays there', async () => {
  const pools: Pool[] = [{ id: 'mixed', title: 'Mixed', accountIds: ['claude-3', 'codex-main'] }];
  const h = poolHarness({ pools });
  h.cfg.defaults.models = { codex: 'gpt-6-luna' };
  h.setUsage('claude-3', room(50, 60));
  h.cfg.defaults.model = 'claude-opus-5-5';
  const { thread } = h.runner.create({ text: 'x' });
  assert.equal(thread.poolId, 'mixed');
  assert.equal(thread.provider, 'claude');
  h.adapter.last.init();
  h.adapter.last.text('m1:0', 'Half done.');
  limit(h.adapter.last);
  await tick();
  const t = h.runner.get(thread.id);
  assert.equal(t.provider, 'codex');
  assert.equal(t.accountId, 'codex-main');
  assert.equal(t.model, 'gpt-6-luna', "the provider's default model");
  const cx = h.codex.last;
  assert.equal(cx.opts.resume, false);
  assert.match(cx.sent[0].text, /^\[Threadbear handoff\][\s\S]*Half done\.[\s\S]*Carry on from where you left off\.$/);
  assert.match(notes(h, thread.id)[0], /^Moved to Codex · main@example\.com: three@example\.com hit its 5-hour limit, back at .*\. It's on Codex now, with GPT-6-Luna and a summary of the thread so far\.$/);
  assert.equal(h.copies.length, 0, 'no transcript copy across providers');
  // Claude has room again later: the thread doesn't move back by itself.
  cx.init('019a-1', 'gpt-6-luna');
  cx.result();
  h.setUsage('claude-3', room(100));
  h.clock.advance(120 * MIN);
  h.runner.send(thread.id, 'more');
  await tick();
  assert.equal(h.runner.get(thread.id).provider, 'codex');
  // The idle CLI was released meanwhile; the next one resumes on Codex.
  assert.equal(h.codex.last.opts.account.id, 'codex-main');
  assert.equal(h.codex.last.opts.resume, true);
  assert.equal(h.adapter.sessions.length, 1, 'no Claude session since');
});

// ------------------------------------------------------- update and pools.*

test('threads.update poolId: null pins, a pool moves onto one of its logins, accountId pins, unknown is -32602', async () => {
  const h = poolHarness();
  const { thread } = h.runner.create({ text: 'x' });
  h.adapter.last.init();
  h.adapter.last.result();
  assert.equal(thread.poolId, 'claude');
  assert.equal(h.runner.update({ threadId: thread.id, poolId: null }).thread.poolId, undefined);
  // Into Codex's pool: its current login isn't there, so it moves now.
  const moved = h.runner.update({ threadId: thread.id, poolId: 'codex' }).thread;
  assert.equal(moved.poolId, 'codex');
  assert.equal(moved.accountId, 'codex-main');
  assert.equal(moved.provider, 'codex');
  // Back into Claude's: the Codex login isn't in it either.
  const back = h.runner.update({ threadId: thread.id, poolId: 'claude' }).thread;
  assert.equal(back.provider, 'claude');
  assert.equal(back.poolId, 'claude');
  // Already in it: stays where it is.
  const was = back.accountId;
  assert.equal(h.runner.update({ threadId: thread.id, poolId: 'claude' }).thread.accountId, was);
  const pinned = h.runner.update({ threadId: thread.id, accountId: 'claude-3' }).thread;
  assert.equal(pinned.poolId, undefined);
  assert.throws(() => h.runner.update({ threadId: thread.id, poolId: 'nope' }), (e: RpcError) => e.code === -32602);
});

test('pools.save replaces the list in runner.json, checks it, and tells clients; an empty list goes back to the built-in ones', async () => {
  const h = poolHarness();
  assert.equal(h.runner.listPools().pools[0].builtIn, true);
  const mine: Pool[] = [{ id: 'all', title: 'All', accountIds: ['claude-3', 'codex-main'], folders: ['~/dev'], builtIn: true }];
  const saved = (await h.runner.savePools(mine)).pools;
  assert.deepEqual(saved, [{ id: 'all', title: 'All', accountIds: ['claude-3', 'codex-main'], folders: ['~/dev'] }]);
  assert.deepEqual(readRunnerJson(h.home).pools, saved);
  assert.deepEqual(h.runner.listPools().pools, saved);
  assert.deepEqual(h.runner.hello().pools, saved);
  const told = h.notes.filter((n) => n.method === 'pools.updated');
  assert.equal(told.length, 1);
  assert.deepEqual((told[0] as any).params.pools, saved);
  await assert.rejects(() => h.runner.savePools([{ id: 'x', title: 'X', accountIds: ['claude-9'] }]), (e: RpcError) => e.code === -32602 && /claude-9/.test(e.message));
  await assert.rejects(() => h.runner.savePools([{ id: 'x', title: 'X', accountIds: [] }]), (e: RpcError) => e.code === -32602);
  await h.runner.savePools([]);
  assert.equal(readRunnerJson(h.home).pools, undefined);
  assert.equal(h.runner.listPools().pools[0].id, 'claude');
});

test('a new login changes the built-in pools and clients hear pools.updated', () => {
  const h = poolHarness({ accounts: [withCodex()[0]] });
  h.fake.base = withCodex();
  h.runner.rescanAccounts();
  const told = h.notes.filter((n) => n.method === 'pools.updated');
  assert.equal(told.length, 1);
  assert.deepEqual((told[0] as any).params.pools.map((p: Pool) => p.id), ['claude', 'codex']);
});

test('noted logins get a pool of their own and are never picked for another', () => {
  const accounts = [...withCodex(), { id: 'claude-2', provider: 'claude' as const, title: 'two@example.com', configDir: '/tmp/two', note: 'Work only' }];
  const h = poolHarness({ accounts });
  h.setUsage('claude-2', room(100));
  h.setUsage('claude-main', room(0, 60, true));
  h.setUsage('claude-3', room(0, 60, true));
  const pools = h.runner.listPools().pools;
  assert.deepEqual(pools.find((p) => p.id === 'work')?.accountIds, ['claude-2']);
  const t = h.runner.create({ text: 'x', poolId: 'claude' }).thread;
  assert.notEqual(t.accountId, 'claude-2');
});

test('unhinted new threads prefer a main provider while explicit backup providers stay selectable', () => {
  const h = poolHarness({ pools: [{ id: 'main', title: 'Main', accountIds: ['claude-main', 'codex-main'], backup: { 'claude-main': true } }] });
  assert.equal(h.runner.pickForNew({ poolId: 'main', cwd: '/x' })?.accountId, 'codex-main');
  assert.equal(h.runner.pickForNew({ poolId: 'main', cwd: '/x', provider: 'claude' })?.accountId, 'claude-main');
  h.setUsage('codex-main', room(0, 30, true));
  assert.equal(h.runner.pickForNew({ poolId: 'main', cwd: '/x' })?.accountId, 'claude-main');
});
