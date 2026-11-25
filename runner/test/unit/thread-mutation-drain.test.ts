import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from '../helpers/fakes.ts';
import { RpcServer } from '../../src/rpc.ts';
import { RunnerClient } from '../../src/client.ts';
import { CallerGate } from '../../src/rpc-gate.ts';
import { threadKey } from '../../src/rpc-auth.ts';
import { nullLogger } from '../../src/log.ts';

test('old draining MCP handlers cannot forward owner mutations to the patched primary', async () => {
  const h = makeHarness();
  const token = 'test-token';
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token, runner: h.runner, log: nullLogger, gate: new CallerGate({ runner: h.runner }), callerOf: async () => ({ kind: 'owner', pids: [4242] }), isDrainingPid: (pid) => pid === 4242 });
  const { port } = await server.listen();
  const url = `ws://127.0.0.1:${port}/rpc`;
  const target = h.runner.create({ text: 'full', permissionMode: 'full', accountId: 'claude-3' }).thread;
  h.adapter.last.init();
  const old = await RunnerClient.connect(url, token);
  const fixed = await RunnerClient.connect(url, token);
  const noHello = await RunnerClient.connect(url, token);
  const me = h.runner.create({ text: 'ask', permissionMode: 'ask', accountId: 'claude-3' }).thread;
  const thread = await RunnerClient.connect(url, threadKey(token, me.id), { threadId: me.id });
  try {
    await assert.rejects(noHello.call('threads.update', { threadId: target.id, model: null, threadMutationGuard: 1 }), /older runner/);
    await noHello.call('hello', { client: 'legacy', pid: 0, threadMutationGuard: 1 });
    await assert.rejects(noHello.call('threads.interrupt', { threadId: target.id }), /older runner/);
    await old.call('hello', { client: 'threadbear-drain', version: 'old' });
    for (const method of ['threads.update', 'threads.interrupt']) {
      await assert.rejects(old.call(method, { threadId: target.id, model: null, threadMutationGuard: 1 }), /older runner/);
    }
    await old.call('hello', { client: 'threadbear-desktop', threadMutationGuard: 1 });
    await assert.rejects(old.call('threads.update', { threadId: target.id, model: null }), /older runner/, 'hello cannot rebrand an old connection');
    await fixed.call('hello', { client: 'threadbear-drain', threadMutationGuard: 1 });
    await fixed.call('threads.update', { threadId: target.id, title: 'new' });
    assert.equal(h.runner.get(target.id).title, 'new');
    await thread.call('hello', { client: 'threadbear-drain', threadMutationGuard: 1 });
    await assert.rejects(thread.call('threads.update', { threadId: target.id, model: null }), /update_thread/);
    await assert.rejects(thread.call('threads.interrupt', { threadId: target.id }), /interrupt_thread/);
    assert.equal(h.runner.get(target.id).status, 'running');
  } finally { old.close(); fixed.close(); thread.close(); noHello.close(); await server.close(); }
});
