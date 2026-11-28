// The email watcher (experiment mailWatch, mail-watch.ts and runner/mail.ts):
// new emails wake the threads waiting on them, are kept for the threads
// they're about, are acted on when a standing decision covers them, or go
// on a pile that comes as one thread at set times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';
import type { Logger } from '../../src/log.ts';
import type { ModelResult } from '../../src/models/index.ts';
import { HELD_MAIL_HEAD } from '../../src/runner/mail.ts';
import { MailWatch, SORT_SYSTEM, UNTRUSTED, digestText, dueSlot, isBuildEmail, parseEmails, quoted, readSort, type Email, type MailThread, type MailWatchSettings } from '../../src/mail-watch.ts';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

type Call = { system: string; prompt: string; strong?: boolean };

function fakeClock(start = Date.parse('2026-11-20T01:30:00Z')) {
  let now = start;
  return { now: () => now, setTimeout: () => ({ cancel() {} }), set: (t: number) => (now = t) };
}

// A watcher over a fake host, mailbox and model.
function watcher(opts: { emails?: Email[][]; answers?: string[]; settings?: MailWatchSettings; threads?: MailThread[]; check?: boolean; on?: boolean; decisions?: string; home?: string; run?: () => Promise<string> } = {}) {
  const home = opts.home ?? tmpDir();
  const userHome = tmpDir();
  const clock = fakeClock();
  const calls: Call[] = [];
  const woke: { id: string; text: string }[] = [];
  const held: { id: string; text: string }[] = [];
  const sent: { id: string; text: string }[] = [];
  const started: { text: string; title: string; cwd: string; careful?: boolean }[] = [];
  const opened = new Set<string>();
  const mailbox = [...(opts.emails ?? [])];
  const answers = [...(opts.answers ?? [])];
  let decisionsFile: string | undefined;
  if (opts.decisions) {
    decisionsFile = path.join(userHome, 'MEMORY.md');
    fs.writeFileSync(decisionsFile, opts.decisions);
  }
  const threads = opts.threads ?? [];
  const w = new MailWatch({
    home,
    userHome,
    clock,
    log: quietLog,
    timeZone: 'Australia/Perth',
    on: () => opts.on ?? true,
    looks: () => true,
    settings: () => ({ command: 'fetch', ...(decisionsFile ? { decisions: [decisionsFile] } : {}), ...opts.settings }),
    run: opts.run ?? (async () => JSON.stringify(mailbox.shift() ?? [])),
    isPrivate: (cwd) => cwd.startsWith('/private-'),
    generate: async (p): Promise<ModelResult<string>> => {
      calls.push({ system: p.system, prompt: p.prompt, ...(p.strong ? { strong: true } : {}) });
      if (p.strong) return { ok: true, value: JSON.stringify({ ok: opts.check ?? true, why: 'covered' }), model: 'opus' };
      const a = answers.shift();
      return a === undefined ? { ok: false, reason: 'off', message: 'no model' } : { ok: true, value: a, model: 'haiku' };
    },
    host: {
      mailThreads: () => threads,
      wakeForMail: (id, text) => (woke.push({ id, text }), true),
      holdMail: (id, text) => (held.push({ id, text }), true),
      send: (id, text) => (sent.push({ id, text }), true),
      start: (r) => {
        started.push(r);
        const id = `started-${started.length}-0000-0000`;
        opened.add(id);
        return id;
      },
      open: (id) => opened.has(id),
    },
  });
  return { w, home, clock, calls, woke, held, sent, started, opened, state: () => w.read() };
}

const PETER: Email = { id: 'g:1a1f:2', account: 'mike@example.com', from: 'Peter <pb@example.com>', subject: 'Calendar voting website', text: 'Thanks Mike. 1. Everyone picks their 1st, 2nd and 3rd favourites.', threadId: '1a1f' };
const NEWSLETTER: Email = { id: 'g:9:1', from: 'News <n@example.com>', subject: 'This week in JS', text: 'Ten links' };
const APPLE: Email = { id: 'g:ap:1', from: 'App Store Connect <no-reply@apple.com>', subject: 'Walkies was rejected', text: 'Guideline 2.1' };
const PARKED: MailThread = { id: '403bb720-e49c-4011-8603-52ab5ace4fa5', title: 'Photo calendar voting website', hibernating: true, waits: 'Peter replies to the email' };
const WALKIES: MailThread = { id: '105a9cba-0000-4000-8000-000000000000', title: 'Walkies release', brief: 'Build 2611122341 in review' };

const sortAnswer = (rows: object[]) => JSON.stringify({ emails: rows });

test('mailWatch: the command prints a list of emails, and junk entries are dropped', () => {
  const list = parseEmails(JSON.stringify([PETER, { id: 'x' }, { from: 'no id' }, 'nope', { id: 'y', subject: 'ok', snippet: 'from snippet' }]));
  assert.deepEqual(list.map((e) => e.id), ['g:1a1f:2', 'y']);
  assert.equal(list[1].text, 'from snippet');
  assert.deepEqual(parseEmails(JSON.stringify({ emails: [PETER] })).map((e) => e.id), ['g:1a1f:2']);
  assert.deepEqual(parseEmails(''), []);
  assert.throws(() => parseEmails('{"nope": 1}'));
});

test('mailWatch: an email a hibernating thread waits on wakes it, with the email', async () => {
  const t = watcher({ emails: [[PETER, NEWSLETTER]], threads: [PARKED, WALKIES], answers: [sortAnswer([{ id: PETER.id, wake: ['403bb720'], tell: [], act: null, pile: null }, { id: NEWSLETTER.id, wake: [], tell: [] }])] });
  const out = await t.w.look();
  assert.equal(out?.woke, 1);
  assert.deepEqual(t.woke.map((x) => x.id), [PARKED.id]);
  assert.match(t.woke[0].text, /From: Peter <pb@example.com>/);
  assert.match(t.woke[0].text, /1st, 2nd and 3rd/);
  assert.ok(t.woke[0].text.startsWith(UNTRUSTED), 'said to be untrusted before the email');
  // The model saw the wait, and both emails; both are now seen.
  assert.match(t.calls[0].prompt, /403bb720 HIBERNATING until: Peter replies to the email/);
  assert.deepEqual(t.state().seen, [PETER.id, NEWSLETTER.id]);
  assert.equal(t.state().done.length, 1);
  assert.equal(t.state().pile.length, 0);
});

test("mailWatch: only a hibernating thread is woken, and an id the model made up does nothing", async () => {
  const t = watcher({ emails: [[PETER]], threads: [PARKED, WALKIES], answers: [sortAnswer([{ id: PETER.id, wake: ['105a9cba', 'deadbeef'] }])] });
  await t.w.look();
  assert.deepEqual(t.woke, []);
});

test('mailWatch: an email about an open thread is kept for it', async () => {
  const t = watcher({ emails: [[APPLE]], threads: [WALKIES], answers: [sortAnswer([{ id: APPLE.id, tell: ['105a9cba'] }])] });
  const out = await t.w.look();
  assert.equal(out?.held, 1);
  assert.deepEqual(t.held.map((x) => x.id), [WALKIES.id]);
});

test("mailWatch: a private folder's threads are never shown to the model", async () => {
  const t = watcher({ emails: [[APPLE]], threads: [WALKIES, { id: 'aaaaaaaa-1', title: 'Secret plans', cwd: '/private-stuff' }], answers: [sortAnswer([])] });
  await t.w.look();
  assert.doesNotMatch(t.calls[0].prompt, /Secret plans/);
  assert.match(t.calls[0].prompt, /Walkies release/);
});

test('mailWatch: emails already seen are not sorted again, and a failed model call leaves them for next time', async () => {
  const t = watcher({ emails: [[PETER], [PETER], [PETER]], threads: [PARKED], answers: [] });
  await t.w.look();
  assert.deepEqual(t.state().seen, [], 'no answer: not seen');
  t.w['d'].generate = async () => ({ ok: true, value: sortAnswer([{ id: PETER.id }]), model: 'haiku' });
  await t.w.look();
  assert.deepEqual(t.state().seen, [PETER.id]);
  const before = t.state().seen.length;
  const out = await t.w.look();
  assert.equal(out?.emails, 0);
  assert.equal(t.state().seen.length, before);
});

test('mailWatch: a failing command is noted and nothing else happens', async () => {
  const t = watcher();
  t.w['d'].run = async () => {
    throw new Error('gateway down');
  };
  const out = await t.w.look();
  assert.equal(out?.emails, 0);
  assert.match(t.state().lastError ?? '', /gateway down/);
  assert.equal(t.state().failures, 1);
});

test('mailWatch: off, or without a command, it does nothing at all', async () => {
  const off = watcher({ on: false, emails: [[PETER]] });
  assert.equal(await off.w.look(), undefined);
  const none = watcher({ emails: [[PETER]], settings: { command: '' } });
  assert.equal(await none.w.look(), undefined);
});

// THREADBEAR-2G (20 Nov 2026): a runner handing over to a new release kept
// looking beside the new one, sorting the same emails twice, and its 4 pm
// list failed, as a draining runner can't start threads. main.ts's handOver
// stops the watcher; once stopped, no new look starts.
test('mailWatch: once stopped (a runner handing over), it no longer looks', async () => {
  const t = watcher({ emails: [[PETER]], answers: [sortAnswer([{ id: PETER.id, pile: 'Reply to Peter' }])] });
  t.w.stop();
  assert.equal(await t.w.look(), undefined);
  assert.equal(t.calls.length, 0);
  assert.deepEqual(t.state().seen, []);
});

// A look already under way when the runner hands over finishes as usual,
// and stopAndWait says when, so the handover waits for it before this runner
// stops starting threads and before the new one is asked for.
test('mailWatch: stopAndWait waits for a look under way, which finishes as usual', async () => {
  let printed: (out: string) => void = () => {};
  const t = watcher({ answers: [sortAnswer([{ id: PETER.id, pile: 'Reply to Peter' }])], run: () => new Promise((resolve) => (printed = resolve)) });
  const looking = t.w.look();
  let stopped = false;
  const stopping = t.w.stopAndWait(60_000).then(() => (stopped = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, false);
  printed(JSON.stringify([PETER]));
  await stopping;
  assert.equal((await looking)?.piled, 1);
  assert.deepEqual(t.state().seen, [PETER.id]);
  // With nothing under way, it's done at once.
  await t.w.stopAndWait(60_000);
});

// One that takes too long is given up: the handover goes on, and the look
// starts, wakes, sends and saves nothing more, as the new runner looks now.
// What it had finished is saved as it's given up; an email it hadn't
// started is left unseen, for the new runner to sort. One whose action was
// being checked, already woken for, is seen, with the action on the pile.
test('mailWatch: a look given up on at handover changes nothing after', async () => {
  for (const at of ['command', 'sort', 'check'] as const) {
    let printed: (out: string) => void = () => {};
    let sorted: (out: ModelResult<string>) => void = () => {};
    let checked: (out: ModelResult<string>) => void = () => {};
    let fire: (() => void) | undefined;
    const warned: string[] = [];
    const home = tmpDir();
    const thread: MailThread = { id: '403bb720-aaaa', title: 'Peter', hibernating: true };
    const woke: string[] = [];
    const started: string[] = [];
    const sent: string[] = [];
    const userHome = tmpDir();
    fs.writeFileSync(path.join(userHome, 'MEMORY.md'), DECISIONS);
    const w = new MailWatch({
      home,
      userHome,
      clock: { now: () => Date.parse('2026-11-20T08:05:00Z'), setTimeout: (fn: () => void) => ((fire = fn), { cancel() {} }) },
      log: { ...quietLog, warn: (m: string) => void warned.push(m) } as unknown as Logger,
      timeZone: 'Australia/Perth',
      on: () => true,
      looks: () => true,
      settings: () => ({ command: 'fetch', decisions: [path.join(userHome, 'MEMORY.md')] }),
      run: () => new Promise((resolve) => (printed = resolve)),
      generate: (p) => new Promise((resolve) => (p.strong ? (checked = resolve) : (sorted = resolve))),
      host: {
        mailThreads: () => [thread],
        wakeForMail: (id) => (woke.push(id), true),
        holdMail: () => true,
        send: (id) => (sent.push(id), true),
        start: (r) => (started.push(r.title), 'started-1'),
        open: () => true,
      },
    });
    const looking = w.look();
    const tick = () => new Promise((r) => setImmediate(r));
    // Peter's email wakes its thread; Apple's is to be acted on, once checked.
    const sort = sortAnswer([
      { id: PETER.id, wake: ['403bb720'] },
      { id: APPLE.id, wake: ['403bb720'], act: { what: 'Resubmit Walkies', decision: 'Resubmit to App Review without asking' } },
    ]);
    if (at !== 'command') {
      printed(JSON.stringify([PETER, APPLE]));
      await tick();
    }
    if (at === 'check') {
      sorted({ ok: true, value: sort, model: 'haiku' });
      await tick();
      assert.deepEqual(woke, [thread.id, thread.id]);
    }
    const stopping = w.stopAndWait(180_000);
    fire?.();
    await stopping;
    assert.match(warned.join('\n'), /gave up on a look under way/, at);
    const saved = w.read();
    if (at === 'command') printed(JSON.stringify([PETER, APPLE]));
    if (at === 'sort') sorted({ ok: true, value: sort, model: 'haiku' });
    if (at === 'check') checked({ ok: true, value: JSON.stringify({ ok: true, why: 'covered' }), model: 'opus' });
    assert.equal(await looking, undefined, at);
    assert.deepEqual({ woke: woke.length, started, sent }, { woke: at === 'check' ? 2 : 0, started: [], sent: [] }, at);
    // Nothing more was saved after it was given up.
    assert.deepEqual(w.read(), saved, at);
    if (at === 'check') {
      assert.deepEqual(saved.seen, [PETER.id, APPLE.id]);
      assert.match(saved.done[0]?.line ?? '', /Woke "Peter"/);
      assert.equal(saved.acts.count, 0);
      assert.deepEqual(saved.pile.map((p) => [p.email.id, p.action]), [[APPLE.id, 'Resubmit Walkies']]);
    } else assert.deepEqual(saved.seen, [], at);
  }
});

// Saving what it had finished can fail too (a full disk): the handover
// still goes on.
test('mailWatch: a given-up look whose save fails still lets the handover go on', async () => {
  let fire: (() => void) | undefined;
  const warned: object[] = [];
  const home = tmpDir();
  // The watcher's folder is a file, so saving there fails.
  fs.writeFileSync(path.join(home, 'runner'), '');
  const w = new MailWatch({
    home,
    userHome: tmpDir(),
    clock: { now: () => Date.parse('2026-11-20T08:05:00Z'), setTimeout: (fn: () => void) => ((fire = fn), { cancel() {} }) },
    log: { ...quietLog, warn: (_m: string, f: object) => void warned.push(f) } as unknown as Logger,
    timeZone: 'Australia/Perth',
    on: () => true,
    looks: () => true,
    settings: () => ({ command: 'fetch' }),
    run: () => new Promise(() => {}),
    generate: async () => ({ ok: false, reason: 'off', message: 'no model' }),
    host: { mailThreads: () => [], wakeForMail: () => true, holdMail: () => true, send: () => true, start: () => 'x', open: () => false },
  });
  void w.look();
  const stopping = w.stopAndWait(180_000);
  fire?.();
  await stopping;
  assert.match(JSON.stringify(warned), /saveError/);
});

test('mailWatch: one that needs Mike goes on the pile, and comes as one thread at the next set time', async () => {
  const t = watcher({
    emails: [[PETER], [], [NEWSLETTER], []],
    threads: [],
    answers: [sortAnswer([{ id: PETER.id, pile: 'Reply to Peter about the voting rules' }]), sortAnswer([{ id: NEWSLETTER.id, pile: 'Read the links' }])],
  });
  // 9:30 am in Perth: the first look only notes the slot, so nothing comes yet.
  await t.w.look();
  assert.equal(t.started.length, 0);
  assert.equal(t.state().pile.length, 1);
  // 4:05 pm: the list comes, as one new thread, and the pile empties.
  t.clock.set(Date.parse('2026-11-20T08:05:00Z'));
  const out = await t.w.look();
  assert.ok(out?.digest);
  assert.equal(t.started.length, 1);
  assert.equal(t.started[0].title, 'Emails to look at');
  assert.match(t.started[0].text, /Reply to Peter about the voting rules/);
  assert.equal(t.state().pile.length, 0);
  // Later that slot: no second list.
  t.clock.set(Date.parse('2026-11-20T08:30:00Z'));
  await t.w.look();
  assert.equal(t.started.length, 1);
  // Next morning, with the first list still open: the new one goes into it.
  t.clock.set(Date.parse('2026-11-21T01:10:00Z'));
  await t.w.look();
  assert.equal(t.started.length, 1);
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0].text, /Read the links/);
});

test('mailWatch: a slot with nothing on the pile sends nothing', async () => {
  const t = watcher({ emails: [[], []] });
  await t.w.look();
  t.clock.set(Date.parse('2026-11-20T08:05:00Z'));
  const out = await t.w.look();
  assert.equal(out?.digest, undefined);
  assert.equal(t.started.length, 0);
});

const DECISIONS = '- [Resubmit to App Review without asking](app-review.md) — own iOS apps: fix, upload';

test('mailWatch: a standing decision that covers it, checked by the strong model, is acted on in its thread', async () => {
  const t = watcher({
    emails: [[APPLE]],
    threads: [WALKIES],
    decisions: DECISIONS,
    answers: [sortAnswer([{ id: APPLE.id, act: { what: 'Fix and resubmit Walkies', decision: 'Resubmit to App Review without asking', thread: '105a9cba' } }])],
  });
  const out = await t.w.look();
  assert.equal(out?.acted, 1);
  assert.equal(t.calls.filter((c) => c.strong).length, 1);
  assert.deepEqual(t.sent.map((x) => x.id), [WALKIES.id]);
  assert.match(t.sent[0].text, /standing decision of theirs: "Resubmit to App Review without asking"/);
  assert.match(t.sent[0].text, /archive: true/);
  assert.match(t.state().done[0].line, /Fix and resubmit Walkies/);
});

test('mailWatch: a decision the model made up, or one the check refuses, goes on the pile instead', async () => {
  const made = watcher({
    emails: [[APPLE]],
    decisions: DECISIONS,
    answers: [sortAnswer([{ id: APPLE.id, act: { what: 'Delete the app', decision: 'Always delete rejected apps right away' } }])],
  });
  await made.w.look();
  assert.equal(made.calls.filter((c) => c.strong).length, 0, 'not even checked');
  assert.equal(made.started.length + made.sent.length, 0);
  assert.equal(made.state().pile[0].action, 'Delete the app');

  const refused = watcher({
    emails: [[APPLE]],
    decisions: DECISIONS,
    check: false,
    answers: [sortAnswer([{ id: APPLE.id, act: { what: 'Fix and resubmit', decision: 'Resubmit to App Review without asking' }, pile: 'Look at the rejection' }])],
  });
  await refused.w.look();
  assert.equal(refused.started.length + refused.sent.length, 0);
  assert.equal(refused.state().pile[0].action, 'Look at the rejection');
});

test('mailWatch: with no decisions, or act off, it never acts', async () => {
  const none = watcher({ emails: [[APPLE]], answers: [sortAnswer([{ id: APPLE.id, act: { what: 'Fix', decision: 'Resubmit to App Review without asking' } }])] });
  await none.w.look();
  assert.match(none.calls[0].prompt, /none, so never act/);
  assert.equal(none.started.length, 0);
  const off = watcher({ emails: [[APPLE]], decisions: DECISIONS, settings: { act: false }, answers: [sortAnswer([{ id: APPLE.id, act: { what: 'Fix', decision: 'Resubmit to App Review without asking' } }])] });
  await off.w.look();
  assert.equal(off.started.length, 0);
});

test('mailWatch: at most four acts a day', async () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ ...APPLE, id: `ap${i}` }));
  const t = watcher({ emails: [many], decisions: DECISIONS, answers: [sortAnswer(many.map((e) => ({ id: e.id, act: { what: 'Resubmit', decision: 'Resubmit to App Review without asking' } })))] });
  const out = await t.w.look();
  assert.equal(out?.acted, 4);
  assert.equal(t.state().pile.length, 2);
  // No thread named: each starts one, never on full access.
  assert.equal(t.started.length, 4);
  assert.ok(t.started.every((r) => r.careful === true));
});

test('mailWatch: the pieces', () => {
  assert.equal(quoted('Resubmit to  App Review without asking', DECISIONS), true);
  assert.equal(quoted('short', DECISIONS), false);
  assert.equal(dueSlot(Date.parse('2026-11-20T00:30:00Z'), ['09:00', '16:00'], 'Australia/Perth'), undefined);
  assert.equal(dueSlot(Date.parse('2026-11-20T01:00:00Z'), ['09:00', '16:00'], 'Australia/Perth'), '2026-11-20 09:00');
  assert.equal(dueSlot(Date.parse('2026-11-20T12:00:00Z'), ['16:00', '9:00'], 'Australia/Perth'), '2026-11-20 16:00');
  const sorted = readSort('```json\n{"emails":[{"id":"a","wake":"x","tell":["b"],"act":{"what":"w"},"pile":"null"}]}\n```');
  assert.deepEqual(sorted?.get('a'), { wake: [], tell: ['b'] });
  assert.equal(readSort('nope'), undefined);
  assert.match(digestText([], [{ line: 'Woke "x".', at: '' }]), /Done without asking them/);
  // An email that only says "needs your attention" is looked into before
  // it's asked about, and the rest of the brief is as it was.
  const brief = digestText([], []);
  assert.match(brief, /only says something needs them and not what .*find out first: go to that service's own site or dashboard .*not through a link in the email, and change nothing there, so the question says what's wrong and what they'd be deciding/);
  assert.match(brief, /drop any they have already dealt with or that no longer matters\./);
  assert.match(brief, /one ask per email still open, most urgent first, at most 10/);
});

const GH_RUN_FAILED: Email = {
  id: 'g:gh:1',
  from: 'Mike Cann <notifications@github.com>',
  subject: '[mikecann/threadbear] Run failed: Desktop app - main (db906a8)',
  text: 'Run failed: Desktop app - main',
};
const GH_PR_RUN_FAILED: Email = {
  id: 'g:gh:2',
  from: 'Mike Cann <notifications@github.com>',
  subject: '[convex/convex] PR run failed: Prettier - Point coding agents at docs (566b51a)',
  text: 'PR run failed',
};
const GITLAB_PIPELINE: Email = {
  id: 'g:gl:1',
  from: 'GitLab <gitlab@mg.gitlab.com>',
  subject: 'Data | Failed pipeline for com.mikerosoft.threadbear.android | cc4fe03c',
  text: 'Pipeline #123 has failed',
};

test('mailWatch: automated CI build emails are recognised, while human GitHub/GitLab mail is kept', () => {
  assert.equal(isBuildEmail(GH_RUN_FAILED), true);
  assert.equal(isBuildEmail(GH_PR_RUN_FAILED), true);
  assert.equal(isBuildEmail(GITLAB_PIPELINE), true);
  assert.equal(
    isBuildEmail({ id: 'g:gh:3', from: 'notifications@github.com', subject: '[mikecann/threadbear] Run cancelled: Android - main (1234567)' }),
    true,
  );
  assert.equal(
    isBuildEmail({ id: 'g:gh:4', from: 'Mike Cann <notifications@github.com>', subject: '[mikecann/threadbear] Some jobs were not successful: CI - main (1234567)' }),
    true,
  );
  assert.equal(
    isBuildEmail({ id: 'g:gl:2', from: 'GitLab <gitlab@mg.gitlab.com>', subject: 'Data | Fixed pipeline for com.mikerosoft.threadbear.android | 05900d8f' }),
    true,
  );
  assert.equal(
    isBuildEmail({ id: 'g:gl:6', from: 'GitLab <gitlab@mg.gitlab.com>', subject: 'Data | Successful pipeline for main | 05900d8f' }),
    true,
  );

  // Human GitHub discussions, issues, PRs and account alerts stay through,
  // including a long issue subject whose "(Issue #42)" suffix is truncated by parseEmails.
  assert.equal(
    isBuildEmail({ id: 'g:gh:5', from: 'Wayne Sutton <notifications@github.com>', subject: "Re: [mikecann/threadbear] Check-ups from other people's copies (Discussion #85)" }),
    false,
  );
  assert.equal(
    isBuildEmail({ id: 'g:gh:6', from: 'Alice <notifications@github.com>', subject: '[org/repo] Run failed: parser crashes (Issue #42)' }),
    false,
  );
  const [longIssue, longIssueWithHash, longGitlabIssue, longGhBuild, longGitlabBuild] = parseEmails(
    JSON.stringify([
      {
        id: 'g:gh:9',
        from: 'Alice <notifications@github.com>',
        subject: `[mikecann/${'r'.repeat(50)}] Run failed: ${'x'.repeat(230)} (Issue #42)`,
      },
      {
        id: 'g:gh:10',
        from: 'Alice <notifications@github.com>',
        subject: `[mikecann/${'r'.repeat(50)}] Run failed: ${'x'.repeat(216)} (deadbee) (Issue #42)`,
      },
      {
        id: 'g:gl:9',
        from: 'Alice <gitlab@mg.gitlab.com>',
        subject: `Data | Failed pipeline for ${'x'.repeat(260)} | deadbeef (#12)`,
      },
      {
        id: 'g:gh:11',
        from: 'notifications@github.com',
        subject: `[mikecann/threadbear] Run failed: ${'x'.repeat(260)} - main (db906a8)`,
      },
      {
        id: 'g:gl:10',
        from: 'GitLab <gitlab@mg.gitlab.com>',
        subject: `Data | Failed pipeline for ${'x'.repeat(270)} | 05900d8f`,
      },
    ]),
  );
  assert.equal(isBuildEmail(longIssue), false);
  assert.equal(isBuildEmail(longIssueWithHash), false);
  assert.equal(
    isBuildEmail({
      ...longIssue,
      text: '[mikecann/threadbear] CI workflow run\n\nRepository: mikecann/threadbear\nWorkflow: CI',
    }),
    false,
  );
  assert.equal(isBuildEmail(longGitlabIssue), false);
  assert.equal(isBuildEmail(longGhBuild), true);
  assert.equal(isBuildEmail(longGitlabBuild), true);
  assert.ok((longGhBuild.subject?.length ?? 0) <= 300);
  assert.ok((longIssueWithHash.subject?.length ?? 0) <= 300);
  assert.equal(
    isBuildEmail({ id: 'g:gh:7', from: 'GitHub <noreply@github.com>', subject: 'Your token expires in 7 days' }),
    false,
  );
  assert.equal(
    isBuildEmail({ id: 'g:gh:8', from: '"notifications@github.com" <bob@example.com>', subject: '[org/repo] Run failed: CI - main (1234567)' }),
    false,
  );
  // Human GitLab issues, MRs and replies stay through even when titled like a pipeline alert.
  assert.equal(
    isBuildEmail({ id: 'g:gl:3', from: 'GitLab <gitlab@mg.gitlab.com>', subject: 'Re: Data | Crash on startup (#12)' }),
    false,
  );
  assert.equal(
    isBuildEmail({ id: 'g:gl:4', from: 'Alice <gitlab@mg.gitlab.com>', subject: 'Data | Failed pipeline for release (#12)' }),
    false,
  );
  assert.equal(
    isBuildEmail({ id: 'g:gl:5', from: 'Alice <gitlab@mg.gitlab.com>', subject: 'Re: Data | Failed pipeline for android (#12)' }),
    false,
  );
  assert.equal(
    isBuildEmail({ id: 'g:gl:7', from: 'Alice <gitlab@mg.gitlab.com>', subject: 'Data | Fixed pipeline for com.mikerosoft.threadbear.android (!45)' }),
    false,
  );
  assert.equal(
    isBuildEmail({ id: 'g:gl:8', from: 'Alice <gitlab@mg.gitlab.com>', subject: 'Re: Data | Failed pipeline for main | 05900d8f' }),
    false,
  );
  assert.equal(isBuildEmail(PETER), false);
  assert.equal(isBuildEmail(APPLE), false);
  assert.match(SORT_SYSTEM, /CI\/build/);
});

test('mailWatch: build emails already sitting in the persisted pile are dropped before the next digest, while truncated human issues stay', async () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'runner'), { recursive: true });
  // Includes normal build emails, pre-upgrade copies whose subjects were end-truncated before the hash
  // (both multi-line bodies and flattened Gmail snippets), and a pre-upgrade truncated human issue
  // that happened to end with "(deadbee)" after its "(Issue #42)" suffix was chopped at 300 chars.
  const oldTruncatedGh: Email = {
    id: 'g:gh:old',
    from: 'Mike Cann <notifications@github.com>',
    subject: `[mikecann/threadbear] Run failed: ${'x'.repeat(267)}`,
    text: '[mikecann/threadbear] CI workflow run\n\nRepository: mikecann/threadbear\nWorkflow: CI\nDuration: 3m',
  };
  const oldFlattenedGh: Email = {
    id: 'g:gh:flat',
    from: 'notifications@github.com',
    subject: `[mikecann/threadbear] Run failed: ${'x'.repeat(267)}`,
    text: '[mikecann/threadbear] CI workflow run Repository: mikecann/threadbear Workflow: CI Duration: 3m',
  };
  const oldFlattenedGl: Email = {
    id: 'g:gl:flat',
    from: 'GitLab <gitlab@mg.gitlab.com>',
    subject: `Data | Failed pipeline for ${'x'.repeat(273)}`,
    text: 'Pipeline #3096995664 has failed! Project: Data ( https://gitlab.com/mikecann/fdroiddata )',
  };
  const oldTruncatedHumanIssue: Email = {
    id: 'g:gh:human',
    from: 'Alice <notifications@github.com>',
    subject: `[mikecann/${'r'.repeat(50)}] Run failed: ${'x'.repeat(216)} (deadbee)`,
    text: 'Please review the fix.',
  };
  const oldTruncatedGitlabIssue: Email = {
    id: 'g:gl:human',
    from: 'Alice <gitlab@mg.gitlab.com>',
    subject: `Data | Failed pipeline for ${'x'.repeat(262)} | deadbeef`,
    text: 'Please review the fix.',
  };
  fs.writeFileSync(
    path.join(home, 'runner', 'mail-watch.json'),
    JSON.stringify({
      seen: [GH_RUN_FAILED.id, oldTruncatedGh.id, oldFlattenedGh.id, oldFlattenedGl.id, oldTruncatedHumanIssue.id, oldTruncatedGitlabIssue.id],
      pile: [
        { email: GH_RUN_FAILED, action: 'Fix CI', at: '2026-11-28T01:00:00Z' },
        { email: oldTruncatedGh, action: 'Fix CI', at: '2026-11-28T01:05:00Z' },
        { email: oldFlattenedGh, action: 'Fix CI', at: '2026-11-28T01:06:00Z' },
        { email: oldFlattenedGl, action: 'Fix pipeline', at: '2026-11-28T01:10:00Z' },
        { email: oldTruncatedHumanIssue, action: 'Review Alice fix', at: '2026-11-28T01:15:00Z' },
        { email: oldTruncatedGitlabIssue, action: 'Review GitLab fix', at: '2026-11-28T01:20:00Z' },
      ],
      done: [],
      digest: { slot: '2026-11-28 09:00' },
      acts: { count: 0 },
    }),
  );
  const t = watcher({ home, emails: [[]] });
  t.clock.set(Date.parse('2026-11-28T08:05:00Z')); // 16:05 Australia/Perth
  const out = await t.w.look();
  assert.ok(out?.digest);
  assert.equal(t.started.length, 1);
  assert.match(t.started[0].text, /Review Alice fix/);
  assert.match(t.started[0].text, /Review GitLab fix/);
  assert.doesNotMatch(t.started[0].text, /Fix CI/);
  assert.doesNotMatch(t.started[0].text, /Fix pipeline/);
  assert.deepEqual(t.state().pile, []);
});

test('mailWatch: build emails are marked seen without calling the model, waking, holding or piling', async () => {
  // Build emails only: model is never called, nothing woken/held/piled.
  const only = watcher({ emails: [[GH_RUN_FAILED, GITLAB_PIPELINE]], threads: [PARKED, WALKIES] });
  const onlyOut = await only.w.look();
  assert.equal(only.calls.length, 0);
  assert.equal(onlyOut?.emails, 2);
  assert.equal(onlyOut?.ignored, 2);
  assert.equal(onlyOut?.woke, 0);
  assert.equal(onlyOut?.held, 0);
  assert.equal(onlyOut?.piled, 0);
  assert.deepEqual(only.state().seen, [GH_RUN_FAILED.id, GITLAB_PIPELINE.id]);

  // Mixed with a real email: only the real email goes to the model.
  const mixed = watcher({
    emails: [[GH_RUN_FAILED, GH_PR_RUN_FAILED, PETER]],
    threads: [PARKED, WALKIES],
    answers: [sortAnswer([{ id: PETER.id, wake: ['403bb720'] }])],
  });
  const mixedOut = await mixed.w.look();
  assert.equal(mixed.calls.length, 1);
  assert.doesNotMatch(mixed.calls[0].prompt, /Run failed/);
  assert.match(mixed.calls[0].prompt, /Peter/);
  assert.equal(mixedOut?.emails, 3);
  assert.equal(mixedOut?.ignored, 2);
  assert.equal(mixedOut?.woke, 1);
  assert.deepEqual(mixed.state().seen, [GH_RUN_FAILED.id, GH_PR_RUN_FAILED.id, PETER.id]);

  // A burst of build emails does not crowd out a real email past PER_LOOK.
  const burst = Array.from({ length: 40 }, (_, i) => ({ ...GH_RUN_FAILED, id: `g:burst:${i}` }));
  const crowded = watcher({
    emails: [[...burst, PETER]],
    threads: [PARKED],
    answers: [sortAnswer([{ id: PETER.id, wake: ['403bb720'] }])],
  });
  const crowdedOut = await crowded.w.look();
  assert.equal(crowdedOut?.ignored, 40);
  assert.equal(crowdedOut?.woke, 1);
  assert.equal(crowded.calls.length, 1);
});

// ------------------------------------------------------- the runner's side

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + PATIENCE_MS;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function harness() {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { mailWatch: true } }));
  return makeHarness(home);
}

type H = ReturnType<typeof harness>;
const session = (h: H, id: string) => h.adapter.sessions.filter((x) => x.opts.threadId === id).at(-1)!;
function finish(h: H, id: string) {
  const s = session(h, id);
  s.init();
  s.text(`m${Math.random()}`, 'Done.');
  s.result('completed');
}
const sentTexts = (h: H, id: string) => h.adapter.sessions.filter((x) => x.opts.threadId === id).flatMap((s) => s.sent.map((i) => String((i as { text?: string }).text ?? '')));

test('mailWatch runner: a kept email goes before the next message its agent reads, once, and says so in the thread', async () => {
  const h = harness();
  const id = h.runner.create({ text: 'Release Walkies', accountId: 'claude-main' }).thread.id;
  finish(h, id);
  await until(() => h.runner.get(id).status === 'idle', 'idle');
  assert.equal(h.runner.holdMail(id, '---- Email ----\nFrom: Apple', 'Kept the email from Apple for this thread.'), true);
  assert.ok(h.events(id).some((e) => e.type === 'system.note' && /Kept the email from Apple/.test(String((e as { text?: string }).text))));
  // No turn started for it.
  assert.equal(h.runner.get(id).status, 'idle');
  h.runner.send(id, 'How is it going?');
  await until(() => sentTexts(h, id).some((t) => t.includes('How is it going?')), 'the message sent');
  const last = sentTexts(h, id).find((t) => t.includes('How is it going?'))!;
  assert.ok(last.startsWith(HELD_MAIL_HEAD));
  assert.match(last, /From: Apple/);
  finish(h, id);
  await until(() => h.runner.get(id).status === 'idle', 'idle again');
  h.runner.send(id, 'And now?');
  await until(() => sentTexts(h, id).some((t) => t.includes('And now?')), 'the second message');
  assert.doesNotMatch(sentTexts(h, id).find((t) => t.includes('And now?'))!, /From: Apple/);
});

test('mailWatch runner: an email wakes a hibernating thread with a turn to check it; an awake one is not woken', async () => {
  const h = harness();
  const id = h.runner.create({ text: 'Email Peter', accountId: 'claude-main' }).thread.id;
  finish(h, id);
  await until(() => h.runner.get(id).status === 'idle', 'idle');
  assert.equal(h.runner.wakeForMail(id, 'From: Peter'), false, 'not hibernating');
  h.runner.update({ threadId: id, snoozedUntil: new Date(Date.now() + 86_400_000).toISOString() });
  assert.ok(h.runner.mailThreads().find((t) => t.id === id)?.hibernating);
  assert.equal(h.runner.wakeForMail(id, '---- Email ----\nFrom: Peter'), true);
  await until(() => sentTexts(h, id).some((t) => t.includes('From: Peter')), 'the wake message');
  assert.match(sentTexts(h, id).find((t) => t.includes('From: Peter'))!, /email watcher woke it/);
  assert.ok(h.events(id).some((e) => e.type === 'system.note' && /^Woke up/.test(String((e as { text?: string }).text))));
});
