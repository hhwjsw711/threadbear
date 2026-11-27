// A login's usage resets and the hint to use one, across machines
// (docs/protocol/settings.md, "Telling Mike about resets"): a subscription is
// one limit wherever it's signed in, so the count and the hint go up with the
// login's row (backend API 104), and Use a reset in a remote thread's login
// list spends it on this Mac's twin of that login, or else on that runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from '../helpers/convex-memory.ts';
import { RESET_HINT_API_VERSION, toAccountDoc } from '../../src/sync.ts';
import { RpcServer } from '../../src/rpc.ts';
import { RunnerClient } from '../../src/client.ts';
import { nullLogger } from '../../src/log.ts';
import { makeHarness } from '../helpers/fakes.ts';
import type { Account } from '../../src/protocol.ts';

// What the tests read back of an account row.
type Doc = { resetHint?: unknown; usage: { resets?: unknown } };

const OUT: Account = {
  id: 'codex-1',
  provider: 'codex',
  title: 'Codex · alex@example.net',
  configDir: '/tmp/codex-1',
  email: 'alex@example.net',
  usage: { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 0 }], readAt: '2026-11-26T05:00:00.000Z', source: 'live', blocked: true, resets: { available: 2, nextExpiresAt: '2026-12-10T00:00:00.000Z', readAt: '2026-11-26T05:00:00.000Z' } },
  resetHint: { why: 'out', available: 2, nextExpiresAt: '2026-12-10T00:00:00.000Z' },
};

test("a login's row carries its resets and hint only to a backend that takes them", () => {
  const doc = toAccountDoc(OUT, RESET_HINT_API_VERSION) as Doc;
  assert.deepEqual(doc.resetHint, OUT.resetHint);
  assert.deepEqual(doc.usage.resets, OUT.usage!.resets);
  const old = toAccountDoc(OUT, RESET_HINT_API_VERSION - 1) as Doc;
  assert.equal(old.resetHint, undefined);
  assert.equal(old.usage.resets, undefined);
});

test('the backend keeps the row, hands it to another runner and the Mac, and lets only the owner key queue a reset', async () => {
  const { memoryBackend, call } = await import('../helpers/convex-memory.ts');
  const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
  const sync = load('sync');
  const relay = load('relay');
  process.env.RUNNER_KEY = 'owner-key';
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  const BRUCE = 'b2c3d4e5f6a7';
  const MINI = 'cb921b2447ea';
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256('tbr_mac-mini'), name: 'mac-mini', createdAt: 1 });
  await b.ctx.db.insert('runners', { runnerId: MINI, name: 'mac-mini', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  // Bruce writes with the owner key, so its readings are shared.
  await call(b.ctx, sync.upsertAccounts, { key: 'owner-key', runnerId: BRUCE, removed: [], accounts: [toAccountDoc(OUT, RESET_HINT_API_VERSION)] });
  const rows = (await call(b.ctx, relay.remoteAccounts, { key: 'owner-key', runnerId: BRUCE })) as Doc[];
  assert.deepEqual(rows[0].resetHint, OUT.resetHint);
  const shared = (await call(b.ctx, sync.sharedUsage, { key: 'owner-key', runnerId: 'm5aaaaaaaaaa' })) as (Doc & { provider: string })[];
  assert.deepEqual(shared.find((r) => r.provider === 'codex')?.usage.resets, OUT.usage!.resets);
  // Use a reset on a login only the Mac mini has: the owner's key alone, and
  // nothing but the login goes in the row.
  const { commandArgs } = relay as { commandArgs: (kind: string, a: unknown) => Record<string, unknown> };
  assert.deepEqual(commandArgs('call', { method: 'accounts.useReset', params: { accountId: 'codex-1', extra: 'x' } }), { method: 'accounts.useReset', params: { accountId: 'codex-1' } });
  assert.throws(() => commandArgs('call', { method: 'accounts.useReset', params: { accountId: '../x' } }), /needs a login/);
  const args = { method: 'accounts.useReset', params: { accountId: 'codex-1' } };
  await assert.rejects(call(b.ctx, relay.queueCommand, { key: 'tbr_mac-mini', runnerId: MINI, kind: 'call', args }));
  const id = await call(b.ctx, relay.queueCommand, { key: 'owner-key', runnerId: MINI, kind: 'call', args });
  assert.equal((b.rows('commands') as unknown as { _id: unknown; args: { from?: string } }[]).find((c) => c._id === id)?.args.from, 'mac');
});

test("Use a reset on a remote thread's login spends it on this runner's twin, else on that runner", async () => {
  const h = makeHarness();
  const spent: string[] = [];
  const relayed: [string, string][] = [];
  const mine: Account = { ...OUT, id: 'codex-main', email: 'Alex@Example.net' };
  h.runner.safeAccounts = () => [mine];
  h.runner.useReset = async (id: string) => (spent.push(id), { outcome: 'reset' as const, account: mine });
  const relay = {
    owns: () => false,
    call: async () => undefined,
    create: async () => undefined,
    listFolder: async () => undefined,
    logins: async () => ({ accounts: [OUT, { ...OUT, id: 'codex-2', email: 'sam@example.net' }, { ...OUT, id: 'claude-main', provider: 'claude' }] }),
    useReset: async (runnerId: string, accountId: string) => (relayed.push([runnerId, accountId]), { outcome: 'reset' }),
  };
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token: 'tok', runner: h.runner, log: nullLogger, relay });
  const { port } = await server.listen();
  const c = new RunnerClient(`ws://127.0.0.1:${port}/rpc`, 'tok');
  try {
    await c.opened;
    // The same email here: one subscription, spent here.
    assert.deepEqual(await c.call('accounts.useReset', { accountId: 'codex-1', runnerId: 'bruce' }), { outcome: 'reset', account: mine });
    assert.deepEqual(spent, ['codex-main']);
    assert.deepEqual(relayed, []);
    // No twin here: on that runner, through Convex.
    assert.deepEqual(await c.call('accounts.useReset', { accountId: 'codex-2', runnerId: 'bruce' }), { outcome: 'reset' });
    assert.deepEqual(relayed, [['bruce', 'codex-2']]);
    // An older app may still ask for a remote Claude reset. The remote
    // runner needn't be online to tell the app where to use it.
    await assert.rejects(c.call('accounts.useReset', { accountId: 'claude-main', runnerId: 'bruce' }), /https:\/\/claude\.ai\/settings\/usage/);
    assert.deepEqual(relayed, [['bruce', 'codex-2']]);
    // Without a runnerId it's this runner's own login, as before.
    await c.call('accounts.useReset', { accountId: 'codex-main' });
    assert.deepEqual(spent, ['codex-main', 'codex-main']);
  } finally {
    c.close();
    await server.close();
  }
});
