// Compact when cold (runner/cold-compact.ts): a long
// Claude thread woken after its cache expired compacts first, in the same
// turn, and a warm or short one never does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { SessionNotFoundError } from '../../src/adapters/types.ts';
import { CACHE_LIFETIME_MS, COLD_COMPACT_MIN_TOKENS, COLD_MARGIN_MS, coldWake } from '../../src/runner/cold-compact.ts';

const HOUR = 60 * 60_000;

function setup() {
  const h = makeHarness(tmpDir());
  const { thread } = h.runner.create({ text: 'Build it', accountId: 'claude-main' });
  const s = h.adapter.sessions.at(-1)!;
  s.init();
  return { h, id: thread.id, s };
}

// Ends the running turn having read `tokens` of context.
function finish(s: ReturnType<typeof setup>['s'], tokens: number, cost?: number) {
  s.out({ kind: 'context', contextTokens: tokens });
  s.text(`m${Math.random()}`, 'Done.');
  s.result('completed', cost);
}

const last = (h: ReturnType<typeof setup>['h']) => h.adapter.sessions.at(-1)!;
const notes = (h: ReturnType<typeof setup>['h'], id: string) => h.events(id).filter((e) => e.type === 'system.note').map((e) => (e as { text: string }).text);

test('a long thread woken after its cache expired compacts first, then gets the message, in one turn', async () => {
  const { h, id, s } = setup();
  finish(s, 450_000, 3);
  h.clock.advance(3 * HOUR);
  const { turnId } = h.runner.send(id, 'Carry on with the port');
  await tick(8);
  const cli = last(h);
  const compact = cli.sent.at(-1)!;
  assert.match(compact.text, /^\/compact /);
  assert.match(compact.text, /decided/);
  assert.ok(!cli.sent.some((m) => m.text.includes('Carry on with the port')), 'the message waits for the compaction');
  // The CLI's own line is reworded to say why.
  cli.out({ kind: 'event', event: { type: 'system.note', text: 'Compacted the conversation' } });
  cli.result('completed', 4.2);
  await tick(8);
  assert.ok(cli.sent.at(-1)!.text.includes('Carry on with the port'));
  const st = h.runner.mustGet(id);
  assert.equal(st.rt.turn?.turnId, turnId, 'still the same turn');
  assert.equal(notes(h, id).filter((t) => /^Compacted the conversation first: it was 450k tokens and idle for 3 hours/.test(t)).length, 1);
  assert.ok(!notes(h, id).includes('Compacted the conversation'));
  finish(cli, 40_000, 5);
  await tick(8);
  const done = h.events(id).filter((e) => e.type === 'turn.completed' && e.turnId === turnId);
  assert.equal(done.length, 1);
  // The turn's cost has the compaction in it.
  assert.equal((done[0] as { costUsd?: number }).costUsd, 2);
});

// Thread c3f5af7d, 22 Nov 2026: three corrections sent during a cold
// compaction each showed a clock and waited out the whole turn.
test("Mike's messages sent while it compacts go into the same turn after the held one, in order", async () => {
  const { h, id, s } = setup();
  finish(s, 450_000);
  h.clock.advance(3 * HOUR);
  const { turnId } = h.runner.send(id, 'Carry on with the port');
  await tick(8);
  const cli = last(h);
  // While it compacts nothing goes into the CLI: they queue.
  const queued = h.runner.send(id, 'Also check the tests').turnId;
  h.runner.send(id, 'And the docs', [], { origin: 'phone' });
  const st = h.runner.mustGet(id);
  assert.ok(!cli.sent.some((m) => /Also check the tests|And the docs/.test(m.text)));
  assert.equal(st.rec.queue.length, 2);
  cli.result('completed');
  await tick(8);
  const order = ['Carry on with the port', 'Also check the tests', 'And the docs'].map((t) => cli.sent.findIndex((m) => m.text.includes(t)));
  assert.ok(order[0]! > 0 && order[0]! < order[1]! && order[1]! < order[2]!, `in order after the held one: ${order.join(',')}`);
  assert.equal(st.rec.queue.length, 0, 'taken out of the queue');
  assert.equal(st.rt.turn?.turnId, turnId, 'still the same turn');
  // Shown in the running turn, which is how the app drops their clocks.
  const shown = h.events(id).filter((e) => e.type === 'user.message' && /Also check the tests|And the docs/.test((e as { text: string }).text));
  assert.deepEqual(shown.map((e) => e.turnId), [turnId, turnId]);
  // Naming the id send gave it, which tb send --wait follows.
  assert.equal((shown[0] as { sentAs?: string }).sentAs, queued);
  // The turn ends once all three are answered, and nothing is left to start another.
  const ids = cli.sent.slice(order[0]!).map((m) => m.id!);
  cli.text('m1', 'Done.');
  cli.result('completed', undefined, undefined, { answered: ids });
  await tick(8);
  assert.equal(st.rt.turn, undefined);
  assert.equal(h.events(id).filter((e) => e.type === 'turn.started').length, 2);
});

test('after the compaction, what has to wait keeps its place in the queue', async () => {
  const { h, id, s } = setup();
  finish(s, 450_000);
  h.clock.advance(3 * HOUR);
  h.runner.send(id, 'Carry on');
  await tick(8);
  const cli = last(h);
  // A reminder doesn't hold his up, and stays for the next turn; a slash
  // command waits for the turn to end, and what came after it stays behind it.
  h.runner.send(id, 'A reminder', [], { origin: 'schedule', queue: true });
  h.runner.send(id, 'First fix');
  // A report that came in after his message isn't older than it.
  h.runner.send(id, 'A later report', [], { origin: 'runner', queue: true });
  h.runner.send(id, '/cost');
  h.runner.send(id, 'Second fix');
  cli.result('completed');
  await tick(8);
  const st = h.runner.mustGet(id);
  assert.ok(cli.sent.some((m) => m.text.includes('First fix')));
  assert.ok(!cli.sent.some((m) => /A reminder|A later report|\/cost|Second fix/.test(m.text)));
  // (Automatic ones go behind his messages in the queue, as always.)
  const auto = new Set(['A reminder', 'A later report']);
  assert.deepEqual(st.rec.queue.map((q) => q.text).filter((t) => !auto.has(t)), ['/cost', 'Second fix']);
  assert.equal(st.rec.queue.find((q) => q.text === 'A reminder')?.beforeMessage, true, 'queued before First fix');
  assert.equal(st.rec.queue.find((q) => q.text === 'A later report')?.beforeMessage, undefined, 'queued after it');
});

test('a message asked to wait, or one queued before the compaction, is not steered', async () => {
  const { h, id, s } = setup();
  finish(s, 450_000);
  h.clock.advance(3 * HOUR);
  h.runner.send(id, 'Carry on');
  await tick(8);
  const cli = last(h);
  h.runner.send(id, 'After this turn', [], { queue: true });
  h.runner.send(id, 'Later fix');
  cli.result('completed');
  await tick(8);
  const st = h.runner.mustGet(id);
  assert.ok(!cli.sent.some((m) => /After this turn|Later fix/.test(m.text)));
  assert.deepEqual(st.rec.queue.map((q) => q.text), ['After this turn', 'Later fix']);
});

test('a failed compaction, or Stop while it compacts, leaves the queue as it is', async () => {
  for (const how of ['failed', 'stop'] as const) {
    const { h, id, s } = setup();
    finish(s, 450_000);
    h.clock.advance(3 * HOUR);
    h.runner.send(id, 'Carry on');
    await tick(8);
    const cli = last(h);
    h.runner.send(id, 'A fix');
    if (how === 'stop') {
      await h.runner.interrupt(id);
      cli.result('interrupted');
    } else cli.result('failed', undefined, 'Compaction failed');
    await tick(8);
    const st = h.runner.mustGet(id);
    assert.ok(!cli.sent.some((m) => m.text.includes('A fix')), how);
    if (how === 'failed') assert.deepEqual(st.rec.queue.map((q) => q.text), ['A fix'], how);
  }
});

test("a session that can't be found while it compacts: the fresh one gets the held message, then Mike's sent meanwhile", async () => {
  const { h, id, s } = setup();
  finish(s, 450_000);
  h.clock.advance(3 * HOUR);
  h.runner.send(id, 'Carry on');
  await tick(8);
  const cli = last(h);
  h.runner.send(id, 'A fix');
  cli.sink.exited(new SessionNotFoundError('gone'));
  await tick(8);
  const fresh = last(h);
  assert.notEqual(fresh, cli);
  const at = ['Carry on', 'A fix'].map((t) => fresh.sent.findIndex((m) => m.text.includes(t)));
  assert.ok(at[0]! >= 0 && at[0]! < at[1]!, `in order: ${at.join(',')}`);
  assert.equal(h.runner.mustGet(id).rec.queue.length, 0);
});

test('a warm thread is never compacted', async () => {
  const { h, id, s } = setup();
  finish(s, 900_000);
  h.clock.advance(CACHE_LIFETIME_MS + COLD_MARGIN_MS - 60_000);
  h.runner.send(id, 'Next');
  await tick(8);
  assert.ok(last(h).sent.at(-1)!.text.includes('Next'));
  assert.ok(!last(h).sent.some((m) => m.text.startsWith('/compact')));
});

test('a short thread or a slash command: no compaction', async () => {
  for (const [tokens, text] of [[COLD_COMPACT_MIN_TOKENS - 1, 'Next'], [500_000, '/cost']] as const) {
    const { h, id, s } = setup();
    finish(s, tokens);
    h.clock.advance(5 * HOUR);
    h.runner.send(id, text);
    await tick(8);
    assert.ok(!last(h).sent.some((m) => m.text.startsWith('/compact')), `${tokens} ${text}`);
  }
});

test('Stop while it compacts ends the turn and keeps the message for the next one', async () => {
  const { h, id, s } = setup();
  finish(s, 500_000);
  h.clock.advance(2 * HOUR);
  h.runner.send(id, 'Carry on');
  await tick(8);
  const cli = last(h);
  await h.runner.interrupt(id);
  cli.result('interrupted');
  await tick(8);
  const st = h.runner.mustGet(id);
  assert.equal(st.rt.turn, undefined);
  assert.ok(!cli.sent.some((m) => m.text.includes('Carry on')));
  assert.equal(st.rec.interruptedMessages?.length, 1, 'saved for the next message');
});

test('a failed compaction says so and the message still goes', async () => {
  const { h, id, s } = setup();
  finish(s, 500_000);
  h.clock.advance(2 * HOUR);
  h.runner.send(id, 'Carry on');
  await tick(8);
  const cli = last(h);
  cli.result('failed', undefined, 'Compaction failed');
  await tick(8);
  assert.ok(cli.sent.at(-1)!.text.includes('Carry on'));
  assert.ok(notes(h, id).some((t) => t.startsWith("Couldn't compact the conversation first")));
});

test('a completed /compact without a compaction boundary never claims it compacted', async () => {
  const { h, id, s } = setup();
  finish(s, 500_000);
  h.clock.advance(2 * HOUR);
  h.runner.send(id, 'Carry on');
  await tick(8);
  const cli = last(h);
  assert.match(cli.sent.at(-1)!.text, /^\/compact /);
  cli.text('compact-refusal', 'Not enough messages to compact.');
  cli.result('completed');
  await tick(8);
  assert.ok(cli.sent.at(-1)!.text.includes('Carry on'));
  assert.ok(!notes(h, id).some((text) => text.startsWith('Compacted the conversation')));
});

test('a compaction from an unrelated CLI turn is kept separate from a skipped pre-compaction', async () => {
  for (const foreign of ['background', 'queued'] as const) {
    const { h, id, s } = setup();
    finish(s, 500_000);
    h.clock.advance(2 * HOUR);
    h.runner.send(id, 'Carry on');
    await tick(8);
    const cli = last(h);
    const compact = cli.sent.at(-1)!;
    assert.match(compact.text, /^\/compact /);

    if (foreign === 'background') cli.out({ kind: 'cliTurn' });
    else cli.out({ kind: 'messageState', id: 'other-message', state: 'started' });
    cli.out({ kind: 'event', event: { type: 'system.note', text: 'Compacted the conversation' } });
    cli.result('completed', undefined, undefined, foreign === 'background' ? { own: true } : { answered: ['other-message'] });
    assert.equal(cli.sent.at(-1)?.id, compact.id, 'the unrelated result does not release the message');
    cli.out({ kind: 'messageState', id: compact.id!, state: 'started' });
    cli.result('completed', undefined, undefined, { answered: [compact.id!] });
    await tick(8);
    assert.ok(cli.sent.at(-1)!.text.includes('Carry on'));
    assert.equal(notes(h, id).filter((text) => text === 'Compacted the conversation').length, 1);
    assert.ok(!notes(h, id).some((text) => text.startsWith('Compacted the conversation first')));
  }
});

test('a background CLI turn that finishes before /compact leaves the next boundary attributable', async () => {
  const { h, id, s } = setup();
  finish(s, 500_000);
  h.clock.advance(2 * HOUR);

  const deliver = h.runner.deliver.bind(h.runner);
  h.runner.deliver = (st, msg, live) => {
    h.runner.onOutput(st, { kind: 'cliTurn' });
    h.runner.onOutput(st, { kind: 'result', result: { outcome: 'completed', durationMs: 0, own: true } });
    return deliver(st, msg, live);
  };
  h.runner.send(id, 'Carry on');
  await tick(8);
  const cli = last(h);
  assert.match(cli.sent.at(-1)!.text, /^\/compact /);
  // An older CLI supplies the boundary and result but no started frame.
  cli.out({ kind: 'event', event: { type: 'system.note', text: 'Compacted the conversation' } });
  cli.result('completed');
  await tick(8);
  assert.ok(cli.sent.at(-1)!.text.includes('Carry on'));
  assert.ok(notes(h, id).some((text) => text.startsWith('Compacted the conversation first')));
});

test('coldWake: only a resumed Claude session past both thresholds', () => {
  const rec = { provider: 'claude', contextTokens: 300_000, sessionUsed: true };
  const now = 10 * HOUR;
  const cold = now - CACHE_LIFETIME_MS - COLD_MARGIN_MS;
  assert.deepEqual(coldWake(rec, { text: 'hi' }, cold, now), { tokens: 300_000, idleMs: CACHE_LIFETIME_MS + COLD_MARGIN_MS });
  assert.equal(coldWake(rec, { text: 'hi' }, cold + 1, now), undefined);
  assert.equal(coldWake(rec, { text: 'hi' }, undefined, now), undefined, 'unknown means not cold');
  assert.equal(coldWake({ ...rec, sessionUsed: false }, { text: 'hi' }, 0, now), undefined);
  assert.equal(coldWake({ ...rec, handoff: {} }, { text: 'hi' }, 0, now), undefined);
  assert.equal(coldWake({ ...rec, resumeAt: 'x' }, { text: 'hi' }, 0, now), undefined);
  assert.equal(coldWake(rec, { text: 'hi', editOf: 3 }, 0, now), undefined);
  assert.equal(coldWake({ ...rec, provider: 'codex' }, { text: 'hi' }, 0, now), undefined);
});

test('only the result that answers the compaction lets the message go', async () => {
  const { h, id, s } = setup();
  finish(s, 500_000);
  h.clock.advance(2 * HOUR);
  h.runner.send(id, 'Carry on');
  await tick(8);
  const cli = last(h);
  const compactId = cli.sent.at(-1)!.id!;
  assert.match(compactId, /^[0-9a-f-]{36}$/, 'a real uuid, which the SDK keeps');
  // A turn the CLI ran by itself, and one answering something else.
  cli.result('completed', undefined, undefined, { own: true });
  cli.result('completed', undefined, undefined, { answered: ['someone-else'] });
  await tick(8);
  assert.ok(!cli.sent.some((m) => m.text.includes('Carry on')));
  cli.result('completed', undefined, undefined, { answered: [compactId] });
  await tick(8);
  assert.ok(cli.sent.at(-1)!.text.includes('Carry on'));
});

test("Stop while compacting a turn another thread opened queues its message again", async () => {
  const { h, id, s } = setup();
  finish(s, 500_000);
  h.clock.advance(2 * HOUR);
  const text = '[Sent by the agent in the thread "Helper" (12345678)]\n\nThe build passed.';
  h.runner.send(id, text);
  await tick(8);
  const cli = last(h);
  assert.match(cli.sent.at(-1)!.text, /^\/compact /);
  await h.runner.interrupt(id);
  cli.result('interrupted');
  await tick(8);
  const st = h.runner.mustGet(id);
  // Queued again, as a stopped message from another thread is, so it
  // starts the next turn, going straight in this time.
  assert.ok(st.rec.queue.some((q) => q.text === text) || h.adapter.sessions.some((x) => x.sent.some((m) => m.text.includes('The build passed.'))), 'queued again, not lost');
  assert.ok(!st.rt.turn?.precompact, 'no second compaction');
});

test('the CLI dying while it compacts keeps the message', async () => {
  const { h, id, s } = setup();
  finish(s, 500_000);
  h.clock.advance(2 * HOUR);
  h.runner.send(id, 'Carry on');
  await tick(8);
  last(h).kill();
  await tick(8);
  const st = h.runner.mustGet(id);
  assert.equal(st.rt.turn, undefined);
  assert.equal(st.rec.interruptedMessages?.length, 1);
});

test("the held message can't be edited until the compaction is done", async () => {
  const { h, id, s } = setup();
  finish(s, 500_000);
  h.clock.advance(2 * HOUR);
  h.runner.send(id, 'Carry on');
  await tick(8);
  const seq = h.events(id).filter((e) => e.type === 'user.message').at(-1).seq;
  await assert.rejects(h.runner.editMessage(id, seq, 'Carry on, carefully'), /waiting while the conversation compacts/);
});

test('a message queued again after a Stop goes straight in, without a second compaction', () => {
  assert.equal(coldWake({ provider: 'claude', contextTokens: 500_000, sessionUsed: true }, { text: 'The build passed.', retryAfterInterrupt: true }, 0, 10 * HOUR), undefined);
});
