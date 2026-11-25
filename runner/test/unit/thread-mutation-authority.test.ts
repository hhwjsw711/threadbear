import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallerGate } from '../../src/rpc-gate.ts';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { CodexTools, type ToolDefinition } from '../../src/adapters/codex/tools.ts';

const changes = [{ title: 'new' }, { cwd: '/tmp' }, { accountId: 'claude-3' }, { poolId: null }, { model: null }, { effort: null }, { permissionMode: 'ask' }, { snoozedUntil: null }, { snoozedUntil: '2099-01-01T00:00:00Z' }, { archived: true }, { archived: false }, { starred: true }, { starred: false }];

for (const mode of ['ask', 'auto'] as const) {
  test(`${mode}: every update and interrupt checks local, draining and unknown target authority`, () => {
    const h = makeHarness();
    const me = h.runner.create({ text: 'me', permissionMode: mode, accountId: 'claude-3' }).thread;
    const full = h.runner.create({ text: 'full', permissionMode: 'full', accountId: 'claude-3' }).thread;
    const remote = { owns: (id: string) => id === 'draining', summaries: () => [{ id: 'draining', title: 'draining', permissionMode: 'ask' as const, status: 'running' }] };
    const gate = new CallerGate({ runner: h.runner, remote });
    for (const id of [full.id, 'draining', 'unknown-remote']) {
      for (const change of changes) assert.throws(() => gate.check(me.id, 'threads.update', { threadId: id, ...change }), /update_thread|move_thread/);
      assert.throws(() => gate.check(me.id, 'threads.interrupt', { threadId: id }), /interrupt_thread/);
    }
    assert.throws(() => gate.check(me.id, 'threads.update', { threadId: me.id, futureControl: true }), /setting futureControl/);
    h.runner.update({ threadId: full.id, permissionMode: 'ask' });
    // A saved mode lowered during an active Full turn does not lower live access.
    assert.throws(() => gate.check(me.id, 'threads.update', { threadId: full.id, model: null }), /update_thread/);
  });

  test(`${mode}: saved Always rules still require one complete internal mutation card`, async () => {
    const h = makeHarness();
    const target = h.runner.create({ text: 'target', permissionMode: 'full', accountId: 'claude-3' }).thread;
    h.adapter.last.init();
    const me = h.runner.create({ text: 'me', permissionMode: mode, accountId: 'claude-3' }).thread;
    h.adapter.last.init();
    const tools = buildThreadbearTools(h.runner, me.id, () => h.clock.now());
    const codex = new CodexTools(tools as ToolDefinition[], {
      requestApproval: async () => { throw new Error('outer saved rule should cover this'); },
      cwd: () => h.home, mode: () => mode,
      rules: () => ['mcp__threadbear__update_thread', 'mcp__threadbear__interrupt_thread'], addRules: () => {},
    });
    for (const [tool, args] of [['update_thread', { threadId: target.id, title: 'visible', archived: true, model: null, effort: null }], ['interrupt_thread', { threadId: target.id }]] as const) {
      const before = h.events(me.id).length;
      const p = codex.call({ threadId: 'native', turnId: 'turn', callId: tool, namespace: 'threadbear', tool, arguments: args }, { fromChild: false, signal: new AbortController().signal });
      let card;
      for (let i = 0; i < 50 && !card; i++) { await tick(); card = h.events(me.id).slice(before).find((x) => x.type === 'approval.requested'); }
      assert.ok(card && card.type === 'approval.requested');
      assert.deepEqual(card.options, ['allow', 'deny']);
      if (tool === 'update_thread') {
        assert.equal(card.input.title, 'visible');
        assert.equal(card.input.archived, true);
        assert.equal(card.input.model, null);
        assert.equal(card.input.effort, null);
      }
      h.runner.respondApproval({ threadId: me.id, approvalId: card.approvalId, decision: 'deny' });
      await p;
      assert.equal(h.runner.get(target.id).title, 'target');
      assert.equal(h.runner.get(target.id).archivedAt, undefined);
      assert.equal(h.runner.get(target.id).status, 'running');
    }
  });
}

test('Auto interrupt of a Full thread goes to the user even when the card reviewer would allow it', async () => {
  let reviews = 0;
  const h = makeHarness(undefined, {}, { models: { generate: async (p) => {
    if (p.feature === 'cardReviewer') reviews++;
    return { ok: true, value: '{"verdict":"allow","why":"Stopping is harmless"}', model: 'test' };
  } } });
  const target = h.runner.create({ text: 'target', permissionMode: 'full', accountId: 'claude-3' }).thread;
  h.adapter.last.init();
  const me = h.runner.create({ text: 'me', permissionMode: 'auto', accountId: 'claude-3' }).thread;
  h.adapter.last.init();
  const tool = buildThreadbearTools(h.runner, me.id).find((x) => x.name === 'interrupt_thread')!;
  const p = tool.handler({ threadId: target.id } as never, {});
  let card;
  for (let i = 0; i < 50 && !card; i++) { await tick(); card = h.events(me.id).find((x) => x.type === 'approval.requested'); }
  assert.ok(card && card.type === 'approval.requested');
  assert.equal(reviews, 0);
  h.runner.respondApproval({ threadId: me.id, approvalId: card.approvalId, decision: 'deny' });
  await p;
  assert.equal(h.runner.get(target.id).status, 'running');
});
