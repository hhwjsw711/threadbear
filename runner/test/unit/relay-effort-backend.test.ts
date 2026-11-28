// Effort changes on another runner's thread from the Mac, through Convex
// (backend API 112; docs/protocol/runners.md). Before API 112, convex/relay.ts
// refused `effort` on `update` commands and sync:finishCommand only kept
// `result` when `accountId` or `model` was present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const MINI = 'cb921b2447ea';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const relay = load('relay');
const { commandArgs } = relay as { commandArgs: (kind: string, a: unknown) => Record<string, unknown> };

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07' });
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07-done' });
  await b.ctx.db.insert('runners', { runnerId: MINI, name: 'mac-mini', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  await call(b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ ...THREAD_BASICS, threadId: 'B', runnerId: MINI, title: 'T', view: 'inbox', needsYou: false }] });
  return b;
}

test('commandArgs accepts effort (and null) on update commands and rejects invalid or mixed ones', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.deepEqual(commandArgs('update', { effort: level }), { effort: level });
  }
  assert.deepEqual(commandArgs('update', { effort: null }), { effort: null });
  assert.deepEqual(commandArgs('update', { accountId: 'codex-1', model: 'gpt-6.2-sol', effort: 'high', by: 'agent' }), {
    accountId: 'codex-1',
    model: 'gpt-6.2-sol',
    effort: 'high',
    by: 'agent',
  });
  assert.throws(() => commandArgs('update', { effort: 'turbo' }), /effort must be one of/);
  assert.throws(() => commandArgs('update', { effort: 42 }), /effort must be one of/);
  assert.throws(() => commandArgs('update', { effort: 'high', title: 'rename' }), /one thing/);
  assert.throws(() => commandArgs('update', { effort: 'high', carryOn: true }), /carryOn goes with accountId/);
});

test('an effort-only update command from the main Mac keeps its applied result on finishCommand', async () => {
  const b = await setup();
  const cmd = await call(b.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'update', args: { effort: 'high' } });
  assert.deepEqual(b.rows('commands').find((c) => c._id === cmd)!.args, { effort: 'high', from: 'mac' });
  await call(b.ctx, sync.takeCommand, { key: MINI_KEY, commandId: cmd });
  await call(b.ctx, sync.finishCommand, {
    key: MINI_KEY,
    commandId: cmd,
    ok: true,
    result: JSON.stringify({ accountId: 'codex-1', model: 'gpt-6.2-sol', effort: 'high' }),
  });
  const state = await call(b.ctx, relay.commandState, { key: OWNER, commandId: cmd });
  assert.equal(state.state, 'done');
  assert.deepEqual(state.result, { accountId: 'codex-1', model: 'gpt-6.2-sol', effort: 'high' });

  // Clearing effort (null) also keeps its result (including null effort).
  const clear = await call(b.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'update', args: { effort: null } });
  await call(b.ctx, sync.takeCommand, { key: MINI_KEY, commandId: clear });
  await call(b.ctx, sync.finishCommand, {
    key: MINI_KEY,
    commandId: clear,
    ok: true,
    result: JSON.stringify({ accountId: 'codex-1', model: 'gpt-6.2-sol', effort: null }),
  });
  assert.deepEqual((await call(b.ctx, relay.commandState, { key: OWNER, commandId: clear })).result, {
    accountId: 'codex-1',
    model: 'gpt-6.2-sol',
    effort: null,
  });

  // Only the main Mac's key may queue relay commands.
  assert.equal(await outcome(call(b.ctx, relay.queueCommand, { key: MINI_KEY, runnerId: MINI, threadId: 'B', kind: 'update', args: { effort: 'high' } })), 'forbidden');
});
