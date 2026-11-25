import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { Projects } from '../../src/projects.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { buildThreadbearTools, type ThreadControl } from '../../src/threadbear-mcp.ts';

for (const [name, at] of [['update_thread', 1], ['update_thread', 2], ['move_thread', 1], ['interrupt_thread', 1], ['join_project', 1], ['leave_project', 1]] as const) {
  test(`${name}: a configured caller downgrade during lookup ${at} refuses the stale Full request`, async () => {
    const home = tmpDir();
    const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger });
    const h = makeHarness(home, {}, { projects });
    projects.start(h.runner);
    const me = h.runner.create({ text: 'me', permissionMode: 'full', accountId: 'claude-3' }).thread;
    h.adapter.last.init();
    const mode = name === 'update_thread' || name === 'move_thread' ? 'ask' : 'full';
    const target = h.runner.create({ text: 'target', permissionMode: mode, accountId: 'claude-3' }).thread;
    h.adapter.last.init();
    const project = projects.create({ title: 'Instructions', by: 'mike' });
    if (name === 'leave_project') projects.changeMembership(target.id, { add: [project.id], by: 'mike' });
    let reads = 0;
    const control = new Proxy(h.runner, { get(runner, key) {
      if (key === 'accessOf') return (id: string) => {
        if (++reads === at) runner.update({ threadId: me.id, permissionMode: 'ask' });
        return runner.accessOf(id);
      };
      const value = Reflect.get(runner, key);
      return typeof value === 'function' ? value.bind(runner) : value;
    } }) as ThreadControl;
    const tool = buildThreadbearTools(control, me.id, undefined, undefined, projects).find((x) => x.name === name)!;
    const out = await tool.handler({ threadId: target.id, project: project.id, ...(name === 'update_thread' ? { permissionMode: 'full' } : name === 'move_thread' ? { folder: tmpDir(), then: 'run it' } : {}) } as never, {});
    assert.equal(out.isError, true);
    assert.equal(h.runner.get(target.id).permissionMode, mode);
    assert.equal(h.runner.get(target.id).cwd, target.cwd);
    assert.equal(h.runner.get(target.id).status, 'running');
    assert.equal(Boolean(h.runner.get(target.id).projects?.some((p) => p.id === project.id)), name === 'leave_project');
  });
}
