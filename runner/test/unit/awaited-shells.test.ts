// A turn that ends without end_turn while a shell it started runs is waiting
// on that shell, not on Mike: no needsYou (so no notification or phone push)
// until the CLI wakes for its result or the wake grace passes without one.
// OpenCode tells the model "end your response; you will be resumed" when it
// moves a long command to the background, and Gemini did just that (27 Nov
// 2026, dafafece), landing in Mike's Inbox and on his phone mid-work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tick } from '../helpers/fakes.ts';

const END_TURN = 'mcp__threadbear__end_turn';
const SHELL = { id: 'sh_1', type: 'local_bash', kind: 'shell' as const, description: 'npm test' };

function start(h: ReturnType<typeof makeHarness>, text = 'Run the tests') {
  const id = h.runner.create({ text, accountId: 'claude-main' }).thread.id;
  const s = h.adapter.sessions.filter((x) => x.opts.threadId === id).at(-1)!;
  s.init();
  return { id, s };
}

test('a turn that ends without end_turn with its shell running stays unfinished until the shell and its wake grace are done', async () => {
  const h = makeHarness();
  const { id, s } = start(h);
  s.out({ kind: 'tasks', tasks: [SHELL] });
  s.text('m1', 'The tests are running in the background; I will check them when they finish.');
  s.result('completed');
  await tick();
  let t = h.runner.get(id);
  assert.equal(t.status, 'idle');
  assert.equal(t.needsYou, false, 'waiting on its own shell, not on Mike');
  assert.equal(t.waitState, 'job');
  // The shell ends: the CLI is about to wake for its result.
  s.out({ kind: 'tasks', tasks: [] });
  await tick();
  t = h.runner.get(id);
  assert.equal(t.needsYou, false, 'still unfinished in the wake grace');
  // No wake came: it's Mike's after all.
  h.clock.advance(16_000);
  await tick();
  t = h.runner.get(id);
  assert.equal(t.background, undefined);
  assert.equal(t.needsYou, true);
});

test('the wake turn that reads the result and ends with end_turn is what reaches Mike', async () => {
  const h = makeHarness();
  const { id, s } = start(h);
  s.out({ kind: 'tasks', tasks: [SHELL] });
  s.text('m1', 'Waiting on the tests.');
  s.result('completed');
  await tick();
  assert.equal(h.runner.get(id).needsYou, false);
  s.out({ kind: 'tasks', tasks: [] });
  s.out({ kind: 'cliTurn' });
  await tick();
  assert.equal(h.runner.get(id).status, 'running');
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'you', asks: [{ question: 'Ship it?' }] } } });
  s.text('m2', 'Tests pass.');
  s.result('completed');
  await tick();
  const t = h.runner.get(id);
  assert.equal(t.needsYou, true);
  assert.equal(t.waitState, 'needsYou');
});

test('a shell left after end_turn (a dev server for Mike) still lets the card reach him at once', async () => {
  const h = makeHarness();
  const { id, s } = start(h, 'Start the dev server');
  s.out({ kind: 'tasks', tasks: [{ ...SHELL, description: 'npm run dev' }] });
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'you', asks: [{ question: 'Does the page look right?' }] } } });
  s.text('m1', 'The dev server is up.');
  s.result('completed');
  await tick();
  const t = h.runner.get(id);
  assert.equal(t.needsYou, true);
  assert.equal(t.waitState, 'needsYou');
});

test('a shell from an earlier turn does not hold back a later turn that ends without end_turn', async () => {
  const h = makeHarness();
  const { id, s } = start(h, 'Start the dev server');
  s.out({ kind: 'tasks', tasks: [{ ...SHELL, description: 'npm run dev' }] });
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  s.text('m1', 'Running.');
  s.result('completed');
  await tick();
  h.runner.send(id, 'What port is it on?');
  await tick();
  const s2 = h.adapter.sessions.filter((x) => x.opts.threadId === id).at(-1)!;
  s2.text('m2', 'Port 5173.');
  s2.result('completed');
  await tick();
  assert.equal(h.runner.get(id).needsYou, true);
});

test('a CLI that does not wake for its jobs (Codex) leaves a no-end_turn turn with Mike', async () => {
  const h = makeHarness();
  (h.adapter as { wakesAfterTasks?: boolean }).wakesAfterTasks = false;
  const { id, s } = start(h);
  s.out({ kind: 'tasks', tasks: [SHELL] });
  s.text('m1', 'The tests are running.');
  s.result('completed');
  await tick();
  assert.equal(h.runner.get(id).needsYou, true);
});

// Codex and Gemini's review, 28 Nov 2026: a wake turn that reads one result
// and goes on waiting dropped the other shell.
test('a wake turn that reads one of two shells and ends without end_turn keeps waiting on the other', async () => {
  const h = makeHarness();
  const { id, s } = start(h, 'Build and test');
  const build = { ...SHELL, id: 'sh_build', description: 'npm run build' };
  s.out({ kind: 'tasks', tasks: [build, SHELL] });
  s.text('m1', 'Both are running.');
  s.result('completed');
  await tick();
  assert.equal(h.runner.get(id).needsYou, false);
  s.out({ kind: 'tasks', tasks: [SHELL] });
  s.out({ kind: 'cliTurn' });
  s.text('m2', 'The build passed; still waiting on the tests.');
  s.result('completed');
  await tick();
  let t = h.runner.get(id);
  assert.equal(t.status, 'idle');
  assert.equal(t.needsYou, false, 'the tests are still awaited');
  s.out({ kind: 'tasks', tasks: [] });
  h.clock.advance(16_000);
  await tick();
  t = h.runner.get(id);
  assert.equal(t.needsYou, true);
});

test("a failed turn reaches Mike even while an earlier turn's awaited shell runs", async () => {
  const h = makeHarness();
  const { id, s } = start(h);
  s.out({ kind: 'tasks', tasks: [SHELL] });
  s.text('m1', 'Waiting on the tests.');
  s.result('completed');
  await tick();
  assert.equal(h.runner.get(id).needsYou, false);
  h.runner.send(id, 'Something else meanwhile');
  await tick();
  h.runner.failTurn(h.runner.threads.get(id)!, 'it broke');
  await tick();
  const t = h.runner.get(id);
  assert.equal(t.status, 'error');
  assert.equal(t.needsYou, true);
});

test('asks carried for an earlier job stay consistent: needsYou and the Inbox agree', async () => {
  const h = makeHarness();
  const { id, s } = start(h, 'Land it');
  const landing = { ...SHELL, id: 'sh_land', description: 'tb land' };
  s.out({ kind: 'tasks', tasks: [landing] });
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'you', asks: [{ question: 'Check it?' }], askWhen: 'jobsEnd' } } });
  s.text('m1', 'Landing.');
  s.result('completed');
  await tick();
  assert.equal(h.runner.get(id).needsYou, false, 'held for the landing');
  // The landing ends and its wake starts another shell, ending without end_turn.
  s.out({ kind: 'tasks', tasks: [] });
  s.out({ kind: 'cliTurn' });
  s.out({ kind: 'tasks', tasks: [SHELL] });
  s.text('m2', 'Landed; running the tests.');
  s.result('completed');
  await tick();
  const t = h.runner.get(id);
  assert.equal(t.needs, 'you');
  assert.equal(t.needsYou, t.waitState === 'needsYou', `needsYou ${t.needsYou} but waitState ${t.waitState}`);
});

// Round 2 of the review: an awaited shell whose grace ran out stayed on the
// list, so a dev server's exit later pulled the thread back out of Needs you.
test("an awaited shell that was never woken for doesn't come back with another job's grace", async () => {
  const h = makeHarness();
  const { id, s } = start(h, 'Start the server and test');
  const dev = { ...SHELL, id: 'sh_dev', description: 'npm run dev' };
  s.out({ kind: 'tasks', tasks: [dev] });
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  s.text('m1', 'Server up.');
  s.result('completed');
  await tick();
  h.runner.send(id, 'Now run the tests');
  await tick();
  const s2 = h.adapter.sessions.filter((x) => x.opts.threadId === id).at(-1)!;
  s2.out({ kind: 'tasks', tasks: [dev, SHELL] });
  s2.text('m2', 'Tests running.');
  s2.result('completed');
  await tick();
  assert.equal(h.runner.get(id).needsYou, false);
  s2.out({ kind: 'tasks', tasks: [dev] });
  h.clock.advance(16_000);
  await tick();
  assert.equal(h.runner.get(id).needsYou, true);
  // The dev server stops: its grace isn't the tests' result.
  s2.out({ kind: 'tasks', tasks: [] });
  await tick();
  assert.equal(h.runner.get(id).needsYou, true);
});

// Round 2: a grace that ran out during Mike's next turn emptied the finished
// list, and the turn's end then dropped the shell it was still to read.
test('an awaited shell whose grace runs out during the next turn is still awaited after it', async () => {
  const h = makeHarness();
  const { id, s } = start(h);
  s.out({ kind: 'tasks', tasks: [SHELL] });
  s.text('m1', 'Waiting on the tests.');
  s.result('completed');
  await tick();
  s.out({ kind: 'tasks', tasks: [] });
  await tick();
  h.runner.send(id, 'Meanwhile, what does this do?');
  await tick();
  h.clock.advance(16_000);
  await tick();
  const s2 = h.adapter.sessions.filter((x) => x.opts.threadId === id).at(-1)!;
  s2.text('m2', 'It parses the config.');
  s2.result('completed');
  await tick();
  assert.equal(h.runner.get(id).needsYou, false, 'the grace starts again for the unread result');
  h.clock.advance(16_000);
  await tick();
  assert.equal(h.runner.get(id).needsYou, true);
});

// Round 3: the CLI reading a result while Mike's message waits in its turn
// took the shell off the list only when it opened a turn of its own.
test('a wake read during a turn of Mike\'s takes the shell off the awaited list', async () => {
  const h = makeHarness();
  const { id, s } = start(h);
  s.out({ kind: 'tasks', tasks: [SHELL] });
  s.text('m1', 'Waiting on the tests.');
  s.result('completed');
  await tick();
  s.out({ kind: 'tasks', tasks: [] });
  h.runner.send(id, 'Anything yet?');
  await tick();
  s.out({ kind: 'cliTurn' });
  await tick();
  assert.equal(h.runner.threads.get(id)!.rt.awaitedShells, undefined);
});
