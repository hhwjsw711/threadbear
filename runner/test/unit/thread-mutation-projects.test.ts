import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { Projects } from '../../src/projects.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { buildThreadbearTools, type ProjectControl } from '../../src/threadbear-mcp.ts';
import { tmpDir } from '../helpers/fakes.ts';

for (const mode of ['ask', 'auto'] as const) {
  test(`${mode}: leaving a higher-access project needs a human card and executes only the shown change`, async () => {
    const home = tmpDir();
    const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
    const h = makeHarness(home, {}, { projects });
    projects.start(h.runner);
    const me = h.runner.create({ text: 'me', permissionMode: mode, accountId: 'claude-3' }).thread;
    h.adapter.last.init();
    const target = h.runner.create({ text: 'target', permissionMode: 'full', accountId: 'claude-3' }).thread;
    h.adapter.last.init();
    const p = projects.create({ title: 'Instructions', notes: 'Keep these instructions', by: 'mike' });
    projects.changeMembership(target.id, { add: [p.id], by: 'mike' });
    const tool = buildThreadbearTools(h.runner, me.id, undefined, undefined, projects).find((t) => t.name === 'leave_project')!;
    for (const allow of [false, true]) {
      const from = h.events(me.id).length;
      const pending = tool.handler({ project: p.id, threadId: target.id } as never, {});
      let card;
      for (let i = 0; i < 50 && !card; i++) { await tick(); card = h.events(me.id).slice(from).find((e) => e.type === 'approval.requested'); }
      assert.ok(card && card.type === 'approval.requested');
      assert.equal(card.input.project, p.id);
      assert.equal(card.input.threadId, target.id);
      h.runner.respondApproval({ threadId: me.id, approvalId: card.approvalId, decision: allow ? 'allow' : 'deny' });
      await pending;
      assert.equal(Boolean(h.runner.get(target.id).projects?.some((x) => x.id === p.id)), !allow);
    }
  });
}

for (const name of ['join_project', 'leave_project']) {
  test(`${name}: final membership sink refuses a target raised while an async operation was pending`, async () => {
    const home = tmpDir();
    const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
    const h = makeHarness(home, {}, { projects });
    projects.start(h.runner);
    const me = h.runner.create({ text: 'me', permissionMode: 'ask', accountId: 'claude-3' }).thread;
    h.adapter.last.init();
    const target = h.runner.create({ text: 'target', permissionMode: 'ask', accountId: 'claude-3' }).thread;
    h.adapter.last.init();
    const p = projects.create({ title: 'Instructions', by: 'mike' });
    if (name === 'leave_project') projects.changeMembership(target.id, { add: [p.id], by: 'mike' });
    const control = new Proxy(projects, { get(obj, key) {
      if (key === 'changeMembership') return (id: string, change: Parameters<Projects['changeMembership']>[1]) => {
        h.runner.update({ threadId: id, permissionMode: 'full' });
        return obj.changeMembership(id, change);
      };
      const value = Reflect.get(obj, key);
      return typeof value === 'function' ? value.bind(obj) : value;
    } }) as ProjectControl;
    const tool = buildThreadbearTools(h.runner, me.id, undefined, undefined, control).find((t) => t.name === name)!;
    const result = await tool.handler({ project: p.id, threadId: target.id } as never, {});
    assert.equal(result.isError, true);
    assert.equal(Boolean(h.runner.get(target.id).projects?.some((x) => x.id === p.id)), name === 'leave_project');
  });
}
