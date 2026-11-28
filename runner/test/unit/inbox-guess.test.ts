// The inboxGuess experiment (runner/inbox-guess.ts; docs/protocol/threads.md,
// "Inbox guess"): a model guesses which finished threads Alex didn't need
// to see, his pick from the done card's Archive menu says whether it was
// right, and nothing is archived by the guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeAccounts, FakeAdapter, makeHarness, testConfig, tmpDir } from '../helpers/fakes.ts';
import { Runner } from '../../src/runner.ts';
import { ThreadStore } from '../../src/store.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';
import type { GenerateParams, ModelResult } from '../../src/models/index.ts';
import { GUESS_CATCH_UP_MS, INBOX_GUESS_FILE, readGuess } from '../../src/runner/inbox-guess.ts';
import { AGENT_MESSAGE_PREFIX } from '../../src/protocol.ts';

const END_TURN = 'mcp__threadbear__end_turn';

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + PATIENCE_MS;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Long enough for a guess that was going to be made to have been.
const settle = () => new Promise((r) => setTimeout(r, 150));

type Answer = string | ModelResult<string>;

function setup(o: { on?: boolean; quiet?: boolean; cheap?: Answer; strong?: Answer; hold?: Promise<void> } = {}) {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { inboxGuess: o.on !== false, ...(o.quiet ? { quietInboxMine: true } : {}) } }));
  const asked: GenerateParams[] = [];
  const models = {
    generate: async (p: GenerateParams): Promise<ModelResult<string>> => {
      if (p.feature !== 'inboxGuess') return { ok: false, reason: 'off', message: 'not the guess' };
      asked.push(p);
      if (o.hold) await o.hold;
      const a = (p.strong ? o.strong : o.cheap) ?? '{"guess":"skip","why":"It only did what he picked."}';
      return typeof a === 'string' ? { ok: true, value: a, model: p.strong ? 'claude-opus-5-5' : 'claude-haiku-5-5' } : a;
    },
  };
  const h = makeHarness(home, {}, { models });
  const lines = (): Array<Record<string, unknown>> => {
    const file = path.join(home, INBOX_GUESS_FILE);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  return { ...h, asked, lines };
}

type H = ReturnType<typeof setup>;

function finish(h: H, id: string, input: Record<string, unknown> = { needs: 'nothing' }, reply = 'Landed on main, and the setting is gone.') {
  const s = h.adapter.sessions.filter((x) => x.opts.threadId === id).at(-1)!;
  s.init();
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: `e${Math.random()}`, name: END_TURN, kind: 'mcp', title: 'end_turn', input } });
  s.text(`m${Math.random()}`, reply);
  s.result('completed');
}

const mine = (h: H, text = 'Turn it on for everyone') => h.runner.create({ text, accountId: 'claude-main' }).thread.id;
const notes = (h: H, id: string) => h.events(id).filter((e) => e.type === 'system.note').map((e) => String(e.text));

test('a finished thread of his own gets a guess from each model, written down and nothing more', async () => {
  const h = setup({ strong: '{"guess":"show","why":"It landed past failing tests, which he may want to know."}' });
  const id = mine(h);
  finish(h, id);
  await until(() => h.lines().length === 1, 'the guess written down');
  const [line] = h.lines();
  assert.equal(line.kind, 'guess');
  assert.equal(line.threadId, id);
  assert.equal(typeof line.seq, 'number');
  assert.deepEqual(line.guesses, [
    { by: 'claude-haiku-5-5', skip: true, why: 'It only did what he picked.' },
    { by: 'claude-opus-5-5', skip: false, why: 'It landed past failing tests, which he may want to know.', strong: true },
  ]);
  // Each was shown what he asked and what came back, as data.
  assert.equal(h.asked.length, 2);
  assert.match(h.asked[0].prompt, /Turn it on for everyone/);
  assert.match(h.asked[0].prompt, /Landed on main, and the setting is gone\./);
  assert.equal(h.asked[0].cwd, h.runner.get(id).cwd, 'so a private folder is left alone');
  // A guess, not an act: it's still in the inbox, and the thread says nothing of it.
  await settle();
  assert.equal(h.runner.get(id).archivedAt, undefined);
  assert.deepEqual(notes(h, id), []);
});

test('a job that ended mid-turn and was read in it: guessed once the wake grace passes with no turn', async () => {
  const h = setup();
  const id = mine(h);
  const s = h.adapter.sessions.filter((x) => x.opts.threadId === id).at(-1)!;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'tb land' }] });
  s.out({ kind: 'tasks', tasks: [] });
  s.out({ kind: 'event', event: { type: 'system.note', text: 'tb land', wake: true } });
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  s.text('m1', 'Landed on main.');
  s.result('completed');
  await settle();
  assert.equal(h.lines().length, 0, 'not while a turn reading the result may still come');
  h.clock.advance(20_000);
  await until(() => h.lines().length === 1, 'the guess written down');
  assert.equal(h.lines()[0].seq, h.events(id).filter((e) => e.type === 'turn.completed').at(-1).seq);
  assert.match(h.asked[0].prompt, /Landed on main\./);
});

test('off unless the experiment is on', async () => {
  const h = setup({ on: false });
  const id = mine(h);
  finish(h, id);
  await settle();
  assert.equal(h.asked.length, 0);
  assert.deepEqual(h.lines(), []);
  h.runner.update({ threadId: id, archived: true });
  assert.deepEqual(h.lines(), [], 'and his archives are not written down either');
});

test('follow-ups are his to see, whatever a model would say: no model is asked', async () => {
  const h = setup();
  const id = mine(h);
  finish(h, id, { needs: 'nothing', next: ['Stop the Threadbear transcript jumping when a long reply arrives'] });
  await until(() => h.lines().length === 1, 'the guess written down');
  assert.deepEqual(h.lines()[0].guesses, [{ by: 'rule', skip: false, why: 'It suggested follow-ups.' }]);
  assert.equal(h.asked.length, 0);
});

test('a thread that asks him something is not guessed', async () => {
  const h = setup();
  const id = mine(h);
  finish(h, id, { needs: 'you', asks: [{ question: 'Deploy it?' }] });
  await settle();
  assert.deepEqual(h.lines(), []);
});

test("a helper thread is not guessed: it archives itself already", async () => {
  const h = setup();
  const parent = mine(h);
  const child = h.runner.create({ text: 'Fix the panel reload', accountId: 'claude-main', startedBy: { kind: 'thread', label: 'Agent', threadId: parent } }).thread.id;
  finish(h, child);
  await until(() => Boolean(h.runner.get(child).archivedAt), 'the helper archived');
  await settle();
  assert.deepEqual(h.lines(), []);
});

test('a helper that stays in his inbox, for its follow-ups, is his to see by rule', async () => {
  const h = setup();
  const parent = mine(h);
  const child = h.runner.create({ text: 'Fix the panel reload', accountId: 'claude-main', startedBy: { kind: 'thread', label: 'Agent', threadId: parent } }).thread.id;
  finish(h, child, { needs: 'nothing', next: ['Stop the Threadbear transcript jumping when a long reply arrives'] });
  await until(() => h.lines().length === 1, 'the guess written down');
  assert.equal(h.runner.get(child).archivedAt, undefined);
  assert.deepEqual(h.lines()[0].guesses, [{ by: 'rule', skip: false, why: 'It suggested follow-ups.' }]);
  assert.equal(h.asked.length, 0);
});

test("another lab's review of a change is not guessed", async () => {
  const h = setup();
  const reviewed = mine(h);
  const review = mine(h, 'Review the change');
  h.runner.threads.get(review)!.rec.reviewOf = reviewed;
  finish(h, review);
  await settle();
  assert.deepEqual(h.lines().filter((l) => l.threadId === review), []);
  assert.equal(h.asked.length, 0);
});

test("his pick from Archive's menu is kept beside the guesses it answers", async () => {
  const h = setup();
  const id = mine(h);
  finish(h, id);
  await until(() => h.lines().length === 1, 'the guess written down');
  h.runner.update({ threadId: id, archived: true, verdict: 'didntNeedToSee' });
  const t = h.runner.get(id);
  assert.equal(t.archiveVerdict, 'didntNeedToSee');
  assert.ok(notes(h, id).includes("Archived by you: didn't need to see this."));
  const line = h.lines()[1];
  assert.equal(line.kind, 'archive');
  assert.equal(line.threadId, id);
  assert.equal(line.label, 'skip');
  assert.equal(line.seq, h.lines()[0].seq, 'the same done card');
  assert.deepEqual(line.guesses, h.lines()[0].guesses);
});

test('"Glad I saw this" is the other label, and a plain archive has none', async () => {
  const h = setup();
  const a = mine(h);
  finish(h, a);
  const b = mine(h, 'How is the daily brief made?');
  finish(h, b);
  await until(() => h.lines().length === 2, 'both guesses');
  h.runner.update({ threadId: a, archived: true, verdict: 'gladISaw' });
  h.runner.update({ threadId: b, archived: true });
  const [glad, plain] = h.lines().slice(2);
  assert.equal(glad.label, 'show');
  assert.ok(notes(h, a).includes('Archived by you: glad to have seen this.'));
  assert.equal(plain.kind, 'archive');
  assert.equal(plain.threadId, b);
  assert.equal('label' in plain, false);
});

test('"Not sure" is kept as unsure, so scoring can leave it out', async () => {
  const h = setup();
  const id = mine(h);
  finish(h, id);
  await until(() => h.lines().length === 1, 'the guess written down');
  h.runner.update({ threadId: id, archived: true, verdict: 'notSure' });
  assert.equal(h.runner.get(id).archiveVerdict, 'notSure');
  assert.ok(notes(h, id).includes('Archived by you: not sure you needed to see this.'));
  const line = h.lines()[1];
  assert.equal(line.kind, 'archive');
  assert.equal(line.label, 'unsure');
  assert.deepEqual(line.guesses, h.lines()[0].guesses);
});

test('only his own archives of a finished thread are written down', async () => {
  const h = setup();
  const id = mine(h);
  finish(h, id);
  await until(() => h.lines().length === 1, 'the guess written down');
  h.runner.update({ threadId: id, archived: true, archivedBy: 'agent' });
  assert.equal(h.lines().length, 1, "an agent's archive says nothing about what he needed to see");
  // One still waiting on him: archiving it says nothing about done threads.
  const asking = mine(h);
  finish(h, asking, { needs: 'you', asks: [{ question: 'Deploy it?' }] });
  await settle();
  h.runner.update({ threadId: asking, archived: true });
  assert.equal(h.lines().length, 1);
});

test('a guess for an earlier done card is not passed off as one for the latest', async () => {
  // The cheap model is out of room for the second turn: no guess for it.
  let room = true;
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { inboxGuess: true } }));
  const models = {
    generate: async (p: GenerateParams): Promise<ModelResult<string>> =>
      room && p.feature === 'inboxGuess' ? { ok: true, value: '{"guess":"skip","why":"A receipt."}', model: 'm' } : { ok: false, reason: 'no-room', message: 'none' },
  };
  const h = makeHarness(home, {}, { models });
  const lines = () => fs.readFileSync(path.join(home, INBOX_GUESS_FILE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const id = h.runner.create({ text: 'Turn it on', accountId: 'claude-main' }).thread.id;
  const end = (reply: string) => {
    const s = h.adapter.sessions.filter((x) => x.opts.threadId === id).at(-1)!;
    s.init();
    s.out({ kind: 'event', event: { type: 'tool.call', itemId: `e${Math.random()}`, name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
    s.text(`m${Math.random()}`, reply);
    s.result('completed');
  };
  end('Done.');
  await until(() => fs.existsSync(path.join(home, INBOX_GUESS_FILE)), 'the first guess');
  room = false;
  h.runner.send(id, 'And why did the tests fail?');
  end('Because the Windows box was out of disk.');
  await settle();
  h.runner.update({ threadId: id, archived: true, verdict: 'gladISaw' });
  const last = lines().at(-1)!;
  assert.equal(last.kind, 'archive');
  assert.equal(last.label, 'show');
  assert.equal('guesses' in last, false, 'the first card’s guess is not this card’s');
});

// The runner a new release starts, on the same data folder: it loads every
// thread but `skip` (the ones the old runner is still finishing), and
// adopts each of those as it's handed over.
function next(home: string, skip: string[], answer = '{"guess":"skip","why":"A receipt."}', clock = new FakeClock()) {
  const asked: GenerateParams[] = [];
  const runner = new Runner({
    config: testConfig(home),
    store: new ThreadStore(home),
    adapters: { claude: new FakeAdapter(), codex: new FakeAdapter('codex') },
    accounts: new FakeAccounts(),
    clock,
    log: nullLogger,
    defer: (fn) => fn(),
    copyTranscript: () => false,
    models: {
      generate: async (p: GenerateParams): Promise<ModelResult<string>> => {
        if (p.feature !== 'inboxGuess') return { ok: false, reason: 'off', message: 'not the guess' };
        asked.push(p);
        return { ok: true, value: answer, model: p.strong ? 'claude-opus-5-5' : 'claude-haiku-5-5' };
      },
    },
  });
  runner.start({ skip: new Set(skip) });
  return { runner, asked };
}

// A runner whose models never answer in time: the guess is still being
// made when the thread leaves it.
function slow() {
  let answer: (() => void) | undefined;
  const hold = new Promise<void>((r) => (answer = r));
  return { ...setup({ hold }), answer: () => answer!() };
}

test('a thread that finished on a runner handing over gets its guess from the new one', async () => {
  // Seven of his first sixteen answers had no guess beside them (19 Nov):
  // each thread had finished on the old runner during a release, and was
  // handed over half a second later, before the models had answered.
  const h = slow();
  const id = mine(h);
  finish(h, id, { needs: 'nothing' }, 'Landed on main, and the setting is gone.');
  await until(() => h.asked.length === 2, 'the old runner asking');
  await h.runner.letGo(h.runner.threads.get(id)!);
  const b = next(h.home, [id]);
  assert.equal(b.asked.length, 0);
  b.runner.adopt(id);
  await until(() => h.lines().length === 1, 'the guess written down');
  const [line] = h.lines();
  assert.equal(line.kind, 'guess');
  assert.equal(line.threadId, id);
  assert.deepEqual((line.guesses as Array<{ skip: boolean }>).map((g) => g.skip), [true, true]);
  // From the log: what he asked and the whole reply.
  assert.match(b.asked[0].prompt, /Turn it on for everyone/);
  assert.match(b.asked[0].prompt, /Landed on main, and the setting is gone\./);
  // The old runner's answer, arriving after it let go, writes nothing.
  h.answer();
  await settle();
  assert.equal(h.lines().length, 1);
  // And his pick is kept beside it.
  b.runner.update({ threadId: id, archived: true, verdict: 'didntNeedToSee' });
  assert.deepEqual(h.lines()[1].guesses, line.guesses);
});

test('its follow-ups come across too: by rule, with no model asked', async () => {
  const h = setup({ on: false });
  const id = mine(h);
  finish(h, id, { needs: 'nothing', next: ['Stop the Threadbear transcript jumping when a long reply arrives'] });
  await settle();
  await h.runner.letGo(h.runner.threads.get(id)!);
  fs.writeFileSync(path.join(h.home, 'runner.json'), JSON.stringify({ experiments: { inboxGuess: true } }));
  const b = next(h.home, [id]);
  b.runner.adopt(id);
  await until(() => h.lines().length === 1, 'the guess written down');
  assert.deepEqual(h.lines()[0].guesses, [{ by: 'rule', skip: false, why: 'It suggested follow-ups.' }]);
  assert.equal(b.asked.length, 0);
});

test("one that came across with its guess, or asking him something, isn't guessed again", async () => {
  const h = setup();
  const guessed = mine(h);
  finish(h, guessed);
  await until(() => h.lines().length === 1, 'the guess written down');
  const asking = mine(h);
  finish(h, asking, { needs: 'you', asks: [{ question: 'Deploy it?' }] });
  await settle();
  await h.runner.letGo(h.runner.threads.get(guessed)!);
  await h.runner.letGo(h.runner.threads.get(asking)!);
  const b = next(h.home, [guessed, asking]);
  b.runner.adopt(guessed);
  b.runner.adopt(asking);
  await settle();
  assert.equal(b.asked.length, 0);
  assert.equal(h.lines().length, 1);
});

test('a runner starting makes the guess a just-finished thread lost, and leaves older ones alone', async () => {
  // Idle threads go to the new runner at once, with whatever was being
  // worked out about them. Not every finished thread in the inbox, though:
  // that would be a model call for each, at every start.
  const h = slow();
  const fresh = mine(h);
  finish(h, fresh);
  const old = mine(h, 'How is the daily brief made?');
  finish(h, old);
  await until(() => h.asked.length === 4, 'the old runner asking');
  const at = Date.parse(h.runner.threads.get(fresh)!.rec.finished!.at);
  await h.runner.letGo(h.runner.threads.get(fresh)!);
  await h.runner.letGo(h.runner.threads.get(old)!);
  const file = path.join(h.home, 'threads', old, 'thread.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as { finished: { at: string } };
  rec.finished.at = new Date(at - GUESS_CATCH_UP_MS - 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(rec));
  const b = next(h.home, [], undefined, new FakeClock(at + 5_000));
  await until(() => h.lines().length === 1, 'the guess written down');
  await settle();
  assert.deepEqual(h.lines().map((l) => l.threadId), [fresh]);
  assert.equal(b.asked.length, 2);
});

test('reading a model’s answer: only a clear skip or show counts', () => {
  assert.deepEqual(readGuess('{"guess":"skip","why":"A receipt."}'), { skip: true, why: 'A receipt.' });
  assert.deepEqual(readGuess('```json\n{"guess":"show","why":"He asked a question."}\n```'), { skip: false, why: 'He asked a question.' });
  assert.equal(readGuess('I think skip'), undefined);
  assert.equal(readGuess('{"guess":"maybe","why":"x"}'), undefined);
  assert.equal(readGuess('{"guess":"skip"}'), undefined, 'a guess with no reason is no use when it turns out wrong');
});

// ---- The quiet inbox for his own threads (experiment quietInboxMine) ----

const quietLines = (h: H) => h.lines().filter((l) => l.kind === 'quiet');

test("Opus's skip archives his finished thread quietly, says why, and marks it", async () => {
  const h = setup({ quiet: true, strong: '{"guess":"skip","why":"A receipt for what he asked."}' });
  const id = mine(h);
  finish(h, id);
  await until(() => Boolean(h.runner.get(id).archivedAt), 'the thread archived');
  const t = h.runner.get(id);
  assert.equal(t.archivedBy, 'threadbear');
  assert.equal(t.quietlyArchived?.why, 'A receipt for what he asked.');
  assert.equal(typeof t.quietlyArchived?.at, 'string');
  // Named, so the app can say what Quiet inbox is, with the model's reason.
  assert.ok(notes(h, id).some((n) => /^Archived by Quiet inbox on \w{3} \d+ \w{3}, \d+:\d\d [ap]m: it finished with nothing for you/.test(n) && n.endsWith('A receipt for what he asked.')), notes(h, id).join('\n'));
  const [guess, quiet] = h.lines();
  assert.equal(guess.kind, 'guess');
  assert.deepEqual({ ...quiet, at: undefined }, { at: undefined, kind: 'quiet', threadId: id, seq: guess.seq, why: 'A receipt for what he asked.' });
});

test("off without the experiment: Opus's skip is only written down", async () => {
  const h = setup({ strong: '{"guess":"skip","why":"A receipt."}' });
  const id = mine(h);
  finish(h, id);
  await until(() => h.lines().length === 1, 'the guess written down');
  await settle();
  assert.equal(h.runner.get(id).archivedAt, undefined);
  assert.deepEqual(quietLines(h), []);
});

test("Opus's show keeps it in the inbox, whatever Haiku said", async () => {
  const h = setup({ quiet: true, cheap: '{"guess":"skip","why":"A receipt."}', strong: '{"guess":"show","why":"It changed the plan."}' });
  const id = mine(h);
  finish(h, id);
  await until(() => h.lines().length === 1, 'the guess written down');
  await settle();
  assert.equal(h.runner.get(id).archivedAt, undefined);
  assert.deepEqual(quietLines(h), []);
});

test('only Haiku answering archives nothing', async () => {
  const h = setup({ quiet: true, strong: { ok: false, reason: 'no-room', message: 'none' } });
  const id = mine(h);
  finish(h, id);
  await until(() => h.lines().length === 1, 'the guess written down');
  assert.deepEqual((h.lines()[0].guesses as Array<{ by: string }>).map((g) => g.by), ['claude-haiku-5-5']);
  await settle();
  assert.equal(h.runner.get(id).archivedAt, undefined);
});

test('follow-ups (a rule) keep it in the inbox with no model asked', async () => {
  const h = setup({ quiet: true });
  const id = mine(h);
  finish(h, id, { needs: 'nothing', next: ['Stop the Threadbear transcript jumping when a long reply arrives'] });
  await until(() => h.lines().length === 1, 'the guess written down');
  await settle();
  assert.equal(h.runner.get(id).archivedAt, undefined);
  assert.equal(h.asked.length, 0);
});

test('a new message while the models think: the card is stale, so nothing is archived', async () => {
  let answer: (() => void) | undefined;
  const hold = new Promise<void>((r) => (answer = r));
  const h = setup({ quiet: true, hold });
  const id = mine(h);
  finish(h, id);
  await until(() => h.asked.length === 2, 'both models asked');
  h.runner.send(id, 'And the other one too');
  answer!();
  await settle();
  assert.equal(h.runner.get(id).archivedAt, undefined);
  assert.deepEqual(quietLines(h), []);
});

test("one he's already looked at, starred, or once brought back is his to put away", async () => {
  let answer: (() => void) | undefined;
  const hold = new Promise<void>((r) => (answer = r));
  const h = setup({ quiet: true, hold });
  const seen = mine(h);
  finish(h, seen);
  const starred = mine(h, 'Look at the deploy');
  finish(h, starred);
  await until(() => h.asked.length === 4, 'all four asked');
  h.runner.markSeen(seen, h.runner.get(seen).lastSeq);
  h.runner.update({ threadId: starred, starred: true });
  answer!();
  await until(() => h.lines().length === 2, 'both guesses');
  await settle();
  assert.equal(h.runner.get(seen).archivedAt, undefined);
  assert.equal(h.runner.get(starred).archivedAt, undefined);
  assert.deepEqual(quietLines(h), []);
});

test("a thread he asked for as its own stays, even when Opus says skip", async () => {
  const h = setup({ quiet: true, strong: '{"guess":"skip","why":"A report from another thread that went normally."}' });
  const parent = mine(h, 'The morning brief');
  // create_thread's nested: false. helperNobodyTouched leaves it for this
  // path; Quiet inbox for his own threads must not hide the answer.
  const own = h.runner.create({
    text: 'Where can I get perpetual spinach?',
    accountId: 'claude-main',
    startedBy: { kind: 'thread', label: 'Agent', threadId: parent },
    detached: true,
  }).thread.id;
  finish(h, own, { needs: 'nothing' }, 'It is leaf beet. Buy the Fothergill packet at Bunnings.');
  await until(() => h.lines().some((l) => l.threadId === own && l.kind === 'guess'), 'the guess written down');
  await settle();
  assert.equal(h.runner.get(own).archivedAt, undefined, 'a detached thread stays');
  assert.equal(quietLines(h).some((l) => l.threadId === own), false);
  // His own thread still goes, so the experiment is what would have archived it.
  const his = mine(h, 'Land the panel');
  finish(h, his);
  await until(() => Boolean(h.runner.get(his).archivedAt), 'his own thread archived');
});

test('a reminder he set himself (an X bookmark) stays in the inbox, though its guess is still written down', async () => {
  const h = setup({ quiet: true, strong: '{"guess":"skip","why":"A routine note on a post."}' });
  const bookmark = h.runner.create({ text: 'I bookmarked this X post. Write me a short note on it.', accountId: 'claude-main', startedBy: { kind: 'tool', label: 'X bookmarks', icon: 'bookmark' } }).thread.id;
  finish(h, bookmark);
  await until(() => h.lines().length === 1, 'the guess written down');
  await settle();
  assert.equal(h.runner.get(bookmark).archivedAt, undefined);
  assert.deepEqual(quietLines(h), []);
  // Another tool's thread is the model's to judge, as before.
  const other = h.runner.create({ text: 'Triage this Sentry issue', accountId: 'claude-main', startedBy: { kind: 'tool', label: 'Sentry' } }).thread.id;
  finish(h, other);
  await until(() => Boolean(h.runner.get(other).archivedAt), 'the other tool thread archived');
});

test('"Should have shown me" brings it back, writes the wrong hide down, and clears the mark', async () => {
  const h = setup({ quiet: true });
  const id = mine(h);
  finish(h, id);
  await until(() => Boolean(h.runner.get(id).quietlyArchived), 'quietly archived');
  const seq = quietLines(h)[0].seq;
  const t = h.runner.update({ threadId: id, archived: false, verdict: 'shouldHaveShown' }).thread;
  assert.equal(t.archivedAt, undefined);
  assert.equal(t.quietlyArchived, undefined);
  assert.equal(h.runner.threads.get(id)!.rec.quietlyArchived, undefined);
  // One line, saying who and why (place-notes.ts), not a second.
  const back = notes(h, id).filter((n) => n.startsWith('Brought back'));
  assert.equal(back.length, 1, back.join('\n'));
  assert.match(back[0], /^Brought back from the archive by you on .+: Quiet inbox shouldn't have hidden it\.$/);
  const line = h.lines().at(-1)!;
  assert.equal(line.kind, 'wrongHide');
  assert.equal(line.threadId, id);
  assert.equal(line.seq, seq);
  assert.equal(line.quiet, true);
  assert.deepEqual(line.guesses, h.lines()[0].guesses);
  // Brought back by hand, so its next clean finish stays in the inbox.
  h.runner.send(id, 'One more thing');
  finish(h, id);
  await until(() => h.lines().filter((l) => l.kind === 'guess').length === 2, 'the second guess');
  await settle();
  assert.equal(h.runner.get(id).archivedAt, undefined);
});

test('a plain unarchive or a new message clears the mark too, and Mike re-archiving it is his', async () => {
  const h = setup({ quiet: true });
  const a = mine(h);
  finish(h, a);
  const b = mine(h, 'Rename the panel');
  finish(h, b);
  const c = mine(h, 'Tidy the docs');
  finish(h, c);
  await until(() => [a, b, c].every((id) => Boolean(h.runner.get(id).quietlyArchived)), 'all three quietly archived');
  h.runner.update({ threadId: a, archived: false });
  assert.equal(h.runner.threads.get(a)!.rec.quietlyArchived, undefined);
  assert.equal(h.lines().some((l) => l.kind === 'wrongHide'), false, 'a plain unarchive is no label');
  h.runner.send(b, 'Now the other panel');
  assert.equal(h.runner.threads.get(b)!.rec.quietlyArchived, undefined);
  h.runner.update({ threadId: c, archived: true });
  assert.equal(h.runner.get(c).quietlyArchived, undefined);
  assert.equal(h.runner.get(c).archivedBy, 'mike');
});

test("Codex answering for Opus (a pool whose Claude login is out of room) archives it", async () => {
  const h = setup({ quiet: true, strong: { ok: true, value: '{"guess":"skip","why":"A receipt."}', model: 'codex default on codex-1' } });
  const id = mine(h);
  finish(h, id);
  await until(() => Boolean(h.runner.get(id).quietlyArchived), 'quietly archived');
  assert.equal(h.runner.get(id).archivedBy, 'threadbear');
  assert.ok(notes(h, id).some((t) => t.includes('Codex judged you didn')), 'the note says Codex judged');
});

test("another agent answering for Opus (Grok) archives nothing", async () => {
  const h = setup({ quiet: true, strong: { ok: true, value: '{"guess":"skip","why":"A receipt."}', model: 'grok default on grok-main' } });
  const id = mine(h);
  finish(h, id);
  await until(() => h.lines().length === 1, 'the guess written down');
  await settle();
  assert.equal(h.runner.get(id).archivedAt, undefined);
});

test('a design review waiting on his answer keeps it in the inbox', async () => {
  const h = setup({ quiet: true });
  const id = mine(h);
  h.runner.threads.get(id)!.rec.reviews = [{ status: 'pending' } as never];
  finish(h, id);
  await until(() => h.lines().length === 1, 'the guess written down');
  await settle();
  assert.equal(h.runner.get(id).archivedAt, undefined);
});

test('an edit under way while the models think archives nothing', async () => {
  let answer: (() => void) | undefined;
  const hold = new Promise<void>((r) => (answer = r));
  const h = setup({ quiet: true, hold });
  const id = mine(h);
  finish(h, id);
  await until(() => h.asked.length === 2, 'both models asked');
  h.runner.threads.get(id)!.rt.editing = true;
  answer!();
  await until(() => h.lines().length === 1, 'the guess written down');
  await settle();
  assert.equal(h.runner.get(id).archivedAt, undefined);
});

test('Mike writing to a quietly archived thread writes a revive line, and an agent’s send_message nothing', async () => {
  const h = setup({ quiet: true, strong: '{"guess":"skip","why":"A receipt for what he asked."}' });
  const id = mine(h);
  finish(h, id);
  await until(() => Boolean(h.runner.get(id).quietlyArchived), 'quietly archived');
  const archivedAt = h.runner.get(id).archivedAt;
  const agent = mine(h, 'Rename the panel');
  finish(h, agent);
  await until(() => Boolean(h.runner.get(agent).quietlyArchived), 'the other quietly archived');
  h.runner.send(agent, `${AGENT_MESSAGE_PREFIX}"Another thread" (abcd1234)]\n\nIt's done over here.`);
  h.runner.send(id, 'Wait, did that land on main? '.repeat(20));
  await until(() => h.lines().some((l) => l.kind === 'revive'), 'the revive line');
  await settle();
  const revives = h.lines().filter((l) => l.kind === 'revive');
  assert.equal(revives.length, 1);
  const { at, ...line } = revives[0];
  assert.equal(typeof at, 'string');
  assert.deepEqual(line, { kind: 'revive', threadId: id, from: 'archived', putAwayBy: 'quiet', putAwayAt: archivedAt, putAwayWhy: 'A receipt for what he asked.', text: 'Wait, did that land on main? '.repeat(20).slice(0, 300) });
  // One he hibernated himself: its why is the grey line that said so.
  h.runner.update({ threadId: agent, snoozedUntil: 'restart' });
  h.runner.send(agent, 'Back to this one');
  await until(() => h.lines().filter((l) => l.kind === 'revive').length === 2, 'the second revive line');
  const second = h.lines().filter((l) => l.kind === 'revive')[1];
  assert.equal(second.from, 'hibernated');
  assert.equal(second.putAwayBy, 'user');
  assert.match(String(second.putAwayWhy), /^Hibernated by you on .*, until the runner next starts\.$/);
});
