import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { buildThreadbearTools, type RemoteControl, type ThreadControl, type ScheduleControl } from '../../src/threadbear-mcp.ts';
import { tmpDir } from '../helpers/fakes.ts';
import type { PermissionMode } from '../../src/protocol.ts';

function setup(mode: PermissionMode = 'ask') {
  const h = makeHarness();
  const me = h.runner.create({ text: 'me', permissionMode: mode, accountId: 'claude-3' }).thread;
  h.adapter.last.init();
  const remoteId = '12345678-1234-1234-1234-123456789012';
  const calls: unknown[] = [];
  const remote: RemoteControl = {
    list: async () => ({ runners: [], threads: [{ threadId: remoteId, runnerId: 'remote', title: 'remote full', permissionMode: 'full', status: 'running', cwd: '/work', accountId: 'claude-3', provider: 'claude', needsYou: false, unread: false, preview: '', createdAt: '', lastActivityAt: '' }] }),
    call: async (...p) => { calls.push(p); return {}; },
  };
  return { h, me, remoteId, remote, calls };
}

async function answer(s: ReturnType<typeof setup>, run: () => Promise<unknown>, allowed: boolean, waiting?: () => void) {
  const from = s.h.events(s.me.id).length;
  const promise = run();
  let card;
  for (let i = 0; i < 50 && !card; i++) { await tick(); card = s.h.events(s.me.id).slice(from).find((x) => x.type === 'approval.requested'); }
  assert.ok(card && card.type === 'approval.requested');
  waiting?.();
  s.h.runner.respondApproval({ threadId: s.me.id, approvalId: card.approvalId, decision: allowed ? 'allow' : 'deny' });
  await promise;
  return card;
}

for (const mode of ['ask', 'auto'] as const) {
  test(`${mode}: relayed interrupt, snooze and archive require their own complete card`, async () => {
    const s = setup(mode);
    const tools = buildThreadbearTools(s.h.runner, s.me.id, () => s.h.clock.now(), undefined, undefined, undefined, { remote: () => s.remote });
    const update = tools.find((x) => x.name === 'update_thread')!;
    for (const change of [{ title: 'new' }, { model: null }, { effort: null }, { pool: null }, { permissionMode: 'ask' }]) {
      const out = await update.handler({ threadId: s.remoteId, ...change } as never, {});
      assert.equal(out.isError, true, 'settings unavailable remotely must fail before dispatch');
      assert.equal(s.calls.length, 0);
    }
    for (const [name, change] of [['interrupt_thread', {}], ['update_thread', { archived: true }], ['update_thread', { archived: false }], ['update_thread', { snooze: 'off' }], ['update_thread', { snooze: '1h', archived: true }]] as const) {
      const tool = tools.find((x) => x.name === name)!;
      const call = () => tool.handler({ threadId: s.remoteId, ...change } as never, {});
      const before = s.calls.length;
      const denied = await answer(s, call, false);
      assert.equal(s.calls.length, before);
      assert.equal(denied.input.threadId, s.remoteId);
      const allowed = await answer(s, call, true);
      assert.equal(s.calls.length, before + 1);
      const sent = s.calls.at(-1) as [string, string, Record<string, unknown>];
      assert.deepEqual(sent[2], allowed.input, 'only the mutation on the card is relayed');
    }
  });
}

test('a target raised during the final caller lookup is refused by the final sink', async () => {
  const s = setup();
  const target = s.h.runner.create({ text: 'target', permissionMode: 'ask', accountId: 'claude-3' }).thread;
  s.h.adapter.last.init();
  let callerReads = 0;
  const control = new Proxy(s.h.runner, { get(runner, k) {
    if (k === 'get') return (id: string) => {
      if (id === s.me.id && ++callerReads === 2) runner.update({ threadId: target.id, permissionMode: 'full' });
      return runner.get(id);
    };
    const v = Reflect.get(runner, k);
    return typeof v === 'function' ? v.bind(runner) : v;
  } }) as ThreadControl;
  const tool = buildThreadbearTools(control, s.me.id).find((x) => x.name === 'update_thread')!;
  const out = await tool.handler({ threadId: target.id, title: 'should not change', model: null } as never, {});
  assert.equal(out.isError, true);
  assert.equal(s.h.runner.get(target.id).title, 'target');
  assert.equal(s.h.runner.get(target.id).permissionMode, 'full');
});

test('an approved combined mutation executes once even if its target changes access while the card waits', async () => {
  const s = setup();
  const target = s.h.runner.create({ text: 'target', permissionMode: 'full', accountId: 'claude-3' }).thread;
  s.h.adapter.last.init();
  const tools = buildThreadbearTools(s.h.runner, s.me.id);
  const tool = tools.find((x) => x.name === 'update_thread')!;
  const card = await answer(s, () => tool.handler({ threadId: target.id, title: 'allowed', model: null, archived: true } as never, {}), true, () => s.h.runner.update({ threadId: target.id, permissionMode: 'ask' }));
  assert.equal(card.input.archived, true);
  assert.equal(s.h.runner.get(target.id).title, 'allowed');
  assert.ok(s.h.runner.get(target.id).archivedAt);
});

test('the final sink refuses a target raised after an unapproved update was checked', async () => {
  const s = setup();
  const target = s.h.runner.create({ text: 'target', permissionMode: 'ask', accountId: 'claude-3' }).thread;
  s.h.adapter.last.init();
  const control = new Proxy(s.h.runner, { get(runner, k) {
    if (k === 'update') return (p: Parameters<typeof runner.update>[0]) => {
      runner.update({ threadId: target.id, permissionMode: 'full' });
      return runner.update(p);
    };
    const v = Reflect.get(runner, k);
    return typeof v === 'function' ? v.bind(runner) : v;
  } }) as ThreadControl;
  const tool = buildThreadbearTools(control, s.me.id).find((x) => x.name === 'update_thread')!;
  const out = await tool.handler({ threadId: target.id, title: 'should not change' } as never, {});
  assert.equal(out.isError, true);
  assert.equal(s.h.runner.get(target.id).title, 'target');
});

test('a move waiting for a draining runner’s schedule lookup cannot reach a newly Full target', async () => {
  const s = setup();
  const target = s.h.runner.create({ text: 'target', permissionMode: 'ask', accountId: 'claude-3' }).thread;
  s.h.adapter.last.init();
  const schedules = { list: async () => { s.h.runner.update({ threadId: target.id, permissionMode: 'full' }); return []; } } as unknown as ScheduleControl;
  const tool = buildThreadbearTools(s.h.runner, s.me.id, undefined, schedules).find((x) => x.name === 'move_thread')!;
  const out = await tool.handler({ threadId: target.id, folder: tmpDir() } as never, {});
  assert.equal(out.isError, true);
  assert.equal(s.h.runner.get(target.id).cwd, target.cwd);
});

test('a mode-raise card does not authorize an unrelated Full turn started while it waits', async () => {
  const s = setup();
  const target = s.h.runner.create({ text: 'target', permissionMode: 'ask', accountId: 'claude-3' }).thread;
  s.h.adapter.last.init();
  const tool = buildThreadbearTools(s.h.runner, s.me.id).find((x) => x.name === 'update_thread')!;
  let result: unknown;
  await answer(s, async () => { result = await tool.handler({ threadId: target.id, permissionMode: 'auto', archived: true, model: null } as never, {}); }, true, () => s.h.runner.update({ threadId: target.id, permissionMode: 'full' }));
  assert.equal((result as { isError: boolean }).isError, true);
  assert.equal(s.h.runner.get(target.id).permissionMode, 'full');
  assert.equal(s.h.runner.get(target.id).archivedAt, undefined);
});

test('a schedule-check move card does not authorize a target raised to Full while it waits', async () => {
  const s = setup();
  const target = s.h.runner.create({ text: 'target', permissionMode: 'ask', accountId: 'claude-3' }).thread;
  s.h.adapter.last.init();
  const schedules = { list: async () => [{ threadId: target.id, title: 'check', check: './check.sh' }] } as unknown as ScheduleControl;
  const tool = buildThreadbearTools(s.h.runner, s.me.id, undefined, schedules).find((x) => x.name === 'move_thread')!;
  let result: unknown;
  await answer(s, async () => { result = await tool.handler({ threadId: target.id, folder: tmpDir() } as never, {}); }, true, () => s.h.runner.update({ threadId: target.id, permissionMode: 'full' }));
  assert.equal((result as { isError: boolean }).isError, true);
  assert.equal(s.h.runner.get(target.id).cwd, target.cwd);
});

test('a cross-runner move explicitly asks about Full access before a concurrent target raise', async () => {
  const s = setup();
  const target = s.h.runner.create({ text: 'target', permissionMode: 'ask', accountId: 'claude-3' }).thread;
  s.h.adapter.last.init();
  s.remote.runners = async () => [{ id: 'cloud', name: 'Cloud' }];
  s.remote.move = async (p) => { s.calls.push(p); return 'Moving'; };
  const tool = buildThreadbearTools(s.h.runner, s.me.id, undefined, undefined, undefined, undefined, { remote: () => s.remote }).find((x) => x.name === 'move_thread')!;
  const run = () => tool.handler({ threadId: target.id, runner: 'cloud', folder: '/untrusted' } as never, {});
  await answer(s, run, false);
  assert.equal(s.calls.length, 0);
  const card = await answer(s, run, true, () => s.h.runner.update({ threadId: target.id, permissionMode: 'full' }));
  assert.match(card.title, /Full access/);
  assert.equal(card.input.folder, '/untrusted');
  assert.equal(s.calls.length, 1);
});
