// Where a thread is parked (src/place.ts): every place against every event,
// checked against the hand-written field writes it replaced, and the record
// fields read as a Place and written back unchanged, for every shape they
// can have on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAR_OFF, PLACE_FIELDS, movePlace, parkRecord, placeBucket, placeFields, placeOf, wakesOnStart, type PlaceEvent, type PlaceFields } from '../../src/place.ts';
import { NO_WAKE_TIME, UNTIL_RESTART } from '../../src/runner.ts';
import type { ThreadRecord } from '../../src/store.ts';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const PAST = '2026-11-19T00:00:00.000Z';
const FUTURE = '2026-11-21T00:00:00.000Z';
const EARLIER = '2026-11-18T00:00:00.000Z';
const wait = (id: string) => ({ threadId: id, title: `t ${id}` });

// Places as the record holds them, one of each shape the runner writes
// (and a few it doesn't, which have to be kept as found).
const STATES: Record<string, PlaceFields> = {
  inbox: {},
  inboxMarked: { snoozedAt: EARLIER, woke: { at: PAST, since: EARLIER }, keptOut: true, archivedBy: 'mike', archiveVerdict: 'worked' },
  inboxFromSchedule: { unarchivedBySchedule: { by: 'agent' }, archivedBy: 'agent' },
  time: { snoozedUntil: FUTURE, snoozedAt: EARLIER },
  timePassed: { snoozedUntil: PAST, snoozedAt: EARLIER },
  restart: { snoozedUntil: UNTIL_RESTART, snoozedUntilRestart: true, snoozedAt: EARLIER },
  release: { snoozedUntil: UNTIL_RESTART, snoozedUntilRestart: true, untilRelease: 'r1', snoozedAt: EARLIER },
  wordsPending: { snoozedUntil: NO_WAKE_TIME, wakeWhen: { said: 'soon', pending: true }, snoozedAt: EARLIER },
  words: { snoozedUntil: FUTURE, wakeWhen: { said: 'soon', topic: 'x', by: 'agent' }, wakeChecked: { said: 'soon', from: { a: 3 } }, snoozedAt: EARLIER },
  wordsTopicOnly: { snoozedUntil: NO_WAKE_TIME, wakeWhen: { said: 'woodwork', topic: 'woodwork' } },
  threads: { snoozedUntil: FUTURE, waitingOn: [wait('a'), wait('b')], snoozedAt: EARLIER },
  app: { snoozedUntil: FUTURE, hibernatedForApp: true },
  runs: { snoozedUntil: FUTURE, waitingOnRuns: ['commit:abc1234'] },
  oddSleep: { snoozedUntil: FUTURE, waitingOn: [wait('a')], wakeWhen: { said: 'x' }, hibernatedForApp: true },
  oddRestart: { snoozedUntil: FUTURE, snoozedUntilRestart: true },
  stray: { wakeWhen: { said: 'soon', pending: true }, untilRelease: 'r0', archivedAt: '' },
  strayRestart: { snoozedUntilRestart: true },
  archived: { archivedAt: PAST, archivedBy: 'mike', archiveVerdict: 'worked', woke: { at: PAST } },
  archivedBare: { archivedAt: PAST },
  archivedAsleep: { archivedAt: PAST, archivedBy: 'agent', snoozedUntil: FUTURE, waitingOn: [wait('a')], snoozedAt: EARLIER },
  archivedWords: { archivedAt: PAST, snoozedUntil: NO_WAKE_TIME, wakeWhen: { said: 'soon', by: 'agent' } },
};

const EVENTS: Record<string, PlaceEvent> = {
  snoozeTime: { kind: 'snooze', until: { kind: 'time', at: FUTURE } },
  snoozeTimeAgent: { kind: 'snooze', until: { kind: 'time', at: FUTURE, by: 'agent' } },
  snoozeRestart: { kind: 'snooze', until: { kind: 'restart' } },
  snoozeRelease: { kind: 'snooze', until: { kind: 'restart', release: 'r2' } },
  unsnooze: { kind: 'unsnooze' },
  wordsAsked: { kind: 'wordsAsked', said: 'soon', by: 'agent' },
  wordsAnswered: { kind: 'wordsAnswered', said: 'soon', until: FUTURE, topic: 't' },
  wordsAnsweredByAgent: { kind: 'wordsAnswered', said: 'soon', topic: 't', by: 'agent' },
  wordsFailed: { kind: 'wordsFailed', said: 'soon' },
  waitOn: { kind: 'waitOn', waits: [wait('c')] },
  forApp: { kind: 'forApp' },
  forRuns: { kind: 'forRuns', keys: ['commit:abc1234'] },
  checked: { kind: 'checked', threadId: 'b', seq: 9 },
  wake: { kind: 'wake' },
  message: { kind: 'message', fromSchedule: false, fromMike: false },
  messageFromMike: { kind: 'message', fromSchedule: false, fromMike: true },
  messageFromSchedule: { kind: 'message', fromSchedule: true, fromMike: false },
  reviewAnswered: { kind: 'reviewAnswered' },
  archive: { kind: 'archive', by: 'mike', verdict: 'notNeeded' },
  archiveByAgent: { kind: 'archive', by: 'agent' },
  unarchive: { kind: 'unarchive' },
  scheduleRunEnded: { kind: 'scheduleRunEnded' },
  seen: { kind: 'seen' },
};

// The pairs that are refused: the callers never sent them (each checks
// first), and the record is left as it was.
const REFUSED: Record<string, string[]> = {
  wordsAsked: allBut('time', 'timePassed'),
  wordsAnswered: allBut('wordsPending'),
  wordsAnsweredByAgent: allBut('wordsPending'),
  wordsFailed: allBut('wordsPending'),
  waitOn: allBut('time', 'timePassed'),
  forApp: allBut('time', 'timePassed'),
  forRuns: allBut('time', 'timePassed'),
  checked: allBut('wordsPending', 'words', 'wordsTopicOnly', 'archivedWords', 'oddSleep'),
};
function allBut(...keep: string[]): string[] {
  return Object.keys(STATES).filter((s) => !keep.includes(s));
}

type Rec = Record<string, unknown>;
// The writes as they were by hand before place.ts, at each site (runner.ts
// update, sendTo and the end of a turn, hibernation.ts, reviews.ts), on a
// copy of the fields.
function byHand(r: Rec, e: PlaceEvent): void {
  const sleepDetail = ['snoozedUntilRestart', 'untilRelease', 'wakeWhen', 'waitingOn', 'hibernatedForApp', 'waitingOnRuns', 'snoozedByAgent'];
  const bucket = () => (r.archivedAt ? 'archived' : r.snoozedUntil && Date.parse(r.snoozedUntil as string) > NOW ? 'snoozed' : 'inbox');
  const del = (...ks: string[]) => ks.forEach((k) => delete r[k]);
  switch (e.kind) {
    case 'snooze':
      if (bucket() !== 'snoozed') r.snoozedAt = ISO;
      del('woke', ...sleepDetail);
      if (e.until.kind === 'time') {
        r.snoozedUntil = e.until.at;
        if (e.until.by === 'agent') r.snoozedByAgent = true;
      }
      else {
        r.snoozedUntil = UNTIL_RESTART;
        r.snoozedUntilRestart = true;
        if (e.until.release) r.untilRelease = e.until.release;
      }
      return;
    case 'unsnooze':
      del('woke', ...sleepDetail, 'snoozedUntil');
      return;
    case 'wordsAsked':
      del('snoozedByAgent');
      r.wakeWhen = { said: e.said, pending: true, ...(e.by ? { by: e.by } : {}) };
      return;
    case 'wordsAnswered': {
      r.snoozedUntil = e.until ?? NO_WAKE_TIME;
      r.wakeWhen = { said: e.said, ...(e.topic ? { topic: e.topic } : {}), ...(e.by ? { by: e.by } : {}) };
      const c = r.wakeChecked as ThreadRecord['wakeChecked'];
      if (c && (!e.by || c.said !== e.said)) del('wakeChecked');
      return;
    }
    case 'wordsFailed':
      del('snoozedUntil', 'wakeWhen');
      return;
    case 'waitOn':
      del('snoozedByAgent');
      r.waitingOn = e.waits;
      return;
    case 'forApp':
      del('snoozedByAgent');
      r.hibernatedForApp = true;
      return;
    case 'forRuns':
      del('snoozedByAgent');
      r.waitingOnRuns = e.keys;
      return;
    case 'checked': {
      const ww = r.wakeWhen as { said: string };
      const c = r.wakeChecked as ThreadRecord['wakeChecked'];
      const checked = c?.said === ww.said ? c : undefined;
      r.wakeChecked = { said: ww.said, from: { ...checked?.from, [e.threadId]: e.seq } };
      return;
    }
    case 'wake': {
      if (!r.archivedAt) {
        const since = r.snoozedAt && Date.parse(r.snoozedAt as string) <= NOW ? r.snoozedAt : undefined;
        r.woke = { at: ISO, ...(since ? { since } : {}) };
      }
      del('snoozedAt', 'snoozedUntil', ...sleepDetail);
      return;
    }
    case 'message':
      if (r.archivedAt && e.fromSchedule) r.unarchivedBySchedule = { by: r.archivedBy };
      if (e.fromMike) del('unarchivedBySchedule');
      if (r.snoozedUntil || r.archivedAt) del('snoozedUntil', ...sleepDetail, 'archivedAt');
      if (e.fromMike) del('woke');
      return;
    case 'reviewAnswered':
      del('snoozedUntil', ...sleepDetail, 'archivedAt');
      return;
    case 'archive':
      del('unarchivedBySchedule');
      r.archivedAt = ISO;
      r.archivedBy = e.by;
      if (e.verdict) r.archiveVerdict = e.verdict;
      else del('archiveVerdict');
      return;
    case 'unarchive':
      del('unarchivedBySchedule');
      if (r.archivedAt) r.keptOut = true;
      del('archivedAt');
      return;
    case 'scheduleRunEnded':
      del('unarchivedBySchedule');
      return;
    case 'seen':
      del('woke');
      return;
  }
}

const clone = (f: PlaceFields): ThreadRecord => structuredClone(f) as unknown as ThreadRecord;
const own = (r: object) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined));

test('UNTIL_RESTART and NO_WAKE_TIME are place.ts FAR_OFF', () => {
  assert.equal(UNTIL_RESTART, FAR_OFF);
  assert.equal(NO_WAKE_TIME, FAR_OFF);
});

for (const [eventName, event] of Object.entries(EVENTS)) {
  test(`every place, on ${eventName}`, () => {
    const refused = REFUSED[eventName] ?? [];
    for (const [stateName, fields] of Object.entries(STATES)) {
      const rec = clone(fields);
      const res = parkRecord(rec, event, NOW);
      if (refused.includes(stateName)) {
        assert.equal(res.ok, false, `${stateName} + ${eventName} should be refused`);
        assert.deepEqual(rec, clone(fields), `${stateName} + ${eventName}: a refused move leaves the record`);
        continue;
      }
      assert.ok(res.ok, `${stateName} + ${eventName} refused: ${res.ok ? '' : res.reason}`);
      const want = structuredClone(fields) as Rec;
      byHand(want, event);
      assert.deepEqual(own(rec), own(want), `${stateName} + ${eventName}`);
      // What it moved to reads back as itself.
      assert.deepEqual(placeOf(rec), res.place, `${stateName} + ${eventName} reads back`);
    }
  });
}

test('where each place shows, and what a start wakes', () => {
  const where = Object.fromEntries(Object.entries(STATES).map(([n, f]) => [n, placeBucket(placeOf(f), NOW)]));
  assert.deepEqual(where, {
    inbox: 'inbox', inboxMarked: 'inbox', inboxFromSchedule: 'inbox', time: 'snoozed', timePassed: 'inbox', restart: 'snoozed', release: 'snoozed',
    wordsPending: 'snoozed', words: 'snoozed', wordsTopicOnly: 'snoozed', threads: 'snoozed', app: 'snoozed', runs: 'snoozed', oddSleep: 'snoozed', oddRestart: 'snoozed',
    stray: 'inbox', strayRestart: 'inbox', archived: 'archived', archivedBare: 'archived', archivedAsleep: 'archived', archivedWords: 'archived',
  });
  const wakes = (release: string | undefined) => Object.keys(STATES).filter((n) => wakesOnStart(placeOf(STATES[n]), release));
  assert.deepEqual(wakes('r1'), ['restart', 'wordsPending', 'oddRestart', 'stray', 'strayRestart']);
  assert.deepEqual(wakes('r2'), ['restart', 'release', 'wordsPending', 'oddRestart', 'stray', 'strayRestart']);
  // As the fields were read before (hibernation.ts, wakesOnStart).
  for (const release of ['r0', 'r1', undefined]) {
    for (const [n, r] of Object.entries(STATES)) {
      const byFields = r.wakeWhen?.pending ? true : !r.snoozedUntilRestart ? false : !r.untilRelease || r.untilRelease !== release;
      assert.equal(wakesOnStart(placeOf(r), release), byFields, `${n} on ${release}`);
    }
  }
});

test('the places read as their kinds', () => {
  const kinds = Object.fromEntries(Object.entries(STATES).map(([n, f]) => {
    const p = placeOf(f);
    const sleep = p.kind === 'inbox' ? undefined : p.sleep;
    return [n, sleep ? `${p.kind}/${sleep.for.kind}` : p.kind];
  }));
  assert.deepEqual(kinds, {
    inbox: 'inbox', inboxMarked: 'inbox', inboxFromSchedule: 'inbox', time: 'snoozed/time', timePassed: 'snoozed/time', restart: 'snoozed/restart', release: 'snoozed/restart',
    wordsPending: 'snoozed/words', words: 'snoozed/words', wordsTopicOnly: 'snoozed/words', threads: 'snoozed/threads', app: 'snoozed/app', runs: 'snoozed/runs', oddSleep: 'snoozed/odd', oddRestart: 'snoozed/odd',
    stray: 'inbox', strayRestart: 'inbox', archived: 'archived', archivedBare: 'archived', archivedAsleep: 'archived/threads', archivedWords: 'archived/words',
  });
});

// Every field's values as they can be on disk: what the runner writes, and
// odd ones (falsy, the wrong type) another runner or a hand might have.
const VALUES: { [K in keyof PlaceFields]-?: unknown[] } = {
  snoozedUntil: [FUTURE, PAST, UNTIL_RESTART, ''],
  snoozedUntilRestart: [true, false],
  untilRelease: ['r1', ''],
  wakeWhen: [{ said: 'x', pending: true }, { said: 'x', topic: 't', by: 'agent' }, 'nonsense'],
  waitingOn: [[wait('a')], [], 'x'],
  hibernatedForApp: [true, false],
  waitingOnRuns: [['commit:a'], []],
  snoozedByAgent: [true, false],
  snoozedAt: [EARLIER],
  woke: [{ at: PAST }],
  wakeChecked: [{ said: 'x', from: {} }],
  archivedAt: [PAST, ''],
  archivedBy: ['mike', 'agent'],
  archiveVerdict: ['worked'],
  unarchivedBySchedule: [{ by: 'mike' }, {}],
  keptOut: [true, false],
};

function* shapes(): Generator<PlaceFields> {
  // Every set of fields with each one's first value...
  const n = PLACE_FIELDS.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const f: Rec = {};
    PLACE_FIELDS.forEach((k, i) => {
      if (mask & (1 << i)) f[k] = VALUES[k][0];
    });
    yield f as PlaceFields;
  }
  // ...and a seeded spread over all of the values.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 10_000; i++) {
    const f: Rec = {};
    for (const k of PLACE_FIELDS) if (rand() < 0.4) f[k] = VALUES[k][Math.floor(rand() * VALUES[k].length)];
    yield f as PlaceFields;
  }
}

test('every shape of the fields reads as a Place and writes back as it was', () => {
  let count = 0;
  for (const f of shapes()) {
    const back = placeFields(placeOf(f));
    for (const k of PLACE_FIELDS) assert.equal(back[k], f[k], `${k} of ${JSON.stringify(f)}`);
    // And writing it onto the record changes nothing.
    const rec = { ...f } as unknown as ThreadRecord;
    parkRecord(rec, { kind: 'scheduleRunEnded' }, NOW);
    const want = { ...f } as Rec;
    delete want.unarchivedBySchedule;
    assert.deepEqual(rec, want);
    assert.deepEqual(Object.keys(rec), Object.keys(want), 'keys keep their order');
    count++;
  }
  assert.ok(count > 25_000);
});

// The events whose callers check first (each has a refusal in REFUSED).
const MAY_REFUSE: PlaceEvent['kind'][] = ['wordsAsked', 'wordsAnswered', 'wordsFailed', 'waitOn', 'forApp', 'forRuns', 'checked'];

test('a pending wait in words that is no boolean still wakes on a start, as before', () => {
  assert.equal(wakesOnStart(placeOf({ snoozedUntil: FAR_OFF, wakeWhen: { said: 'x', pending: 1 as unknown as true } }), 'r1'), true);
});

test('every event on every shape matches the writes by hand, or is refused', () => {
  let seed = 11;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let i = 0;
  for (const f of shapes()) {
    if (rand() > 0.12) continue;
    for (const [name, e] of Object.entries(EVENTS)) {
      const rec = clone(f);
      const res = parkRecord(rec, e, NOW);
      if (!res.ok) {
        assert.ok(MAY_REFUSE.includes(e.kind), `${name} refused on ${JSON.stringify(f)}: ${res.reason}`);
        assert.deepEqual(rec, clone(f));
        continue;
      }
      const want = structuredClone(f) as Rec;
      byHand(want, e);
      assert.deepEqual(own(rec), own(want), `${name} on ${JSON.stringify(f)}`);
      i++;
    }
  }
  assert.ok(i > 5_000);
});

test('an unchanged value keeps its object: a wait list held elsewhere stays the record`s', () => {
  const rec = clone(STATES.threads);
  const list = rec.waitingOn!;
  parkRecord(rec, { kind: 'seen' }, NOW);
  assert.equal(rec.waitingOn, list);
  const res = movePlace(placeOf(rec), { kind: 'archive', by: 'threadbear' }, NOW);
  assert.ok(res.ok && res.place.kind === 'archived' && res.place.sleep?.for.kind === 'threads' && res.place.sleep.for.waitingOn === list);
});

test('a snooze while snoozed keeps when it went away; one from the inbox or the archive starts it now', () => {
  const at = (f: PlaceFields) => {
    const rec = clone(f);
    parkRecord(rec, EVENTS.snoozeTime, NOW);
    return rec.snoozedAt;
  };
  assert.equal(at(STATES.time), EARLIER);
  assert.equal(at(STATES.timePassed), ISO);
  assert.equal(at(STATES.inboxMarked), ISO);
  assert.equal(at(STATES.archivedAsleep), ISO);
});

// The guard: nothing outside place.ts writes these fields on a thread's
// record. The objects allowed below are wire copies (summaries, Convex
// docs, RPC params), not a record.
test('only place.ts writes where a thread is parked', () => {
  const src = path.resolve(import.meta.dirname, '../../src');
  const fieldRe = PLACE_FIELDS.join('|');
  const write = new RegExp(`(?:delete\\s+([\\w.!?\\[\\]]+?)\\.(${fieldRe})\\b)|(?:([\\w.!?\\[\\]]+?)\\.(${fieldRe})\\s*(?:=(?!=)|\\?\\?=|\\|\\|=|&&=))`, 'g');
  // file: the receivers in it that aren't a thread's record.
  const notRecords: Record<string, string[]> = {
    'runner.ts': ['s'], // summary()
    'sync.ts': ['doc', 'out'], // the Convex mirror's docs
    'thread-index.ts': ['row'],
    'relay.ts': ['thread'], // another runner's summary
    'rpc.ts': ['upd'],
    'rpc-gate.ts': ['out'],
    'threadbear-mcp.ts': ['change', 'upd'],
    // Load-time clean-up of a moved record's waits, before anything reads it.
    'store.ts': ['rec'],
    // Not checked here: real-copy.ts neutraliseCopied, which deletes the
    // wait fields by a list of names from a dev runner's copy of real
    // threads (so a copy never wakes or waits), and Object.assign onto a
    // record (reviews.ts copies a record whole). Keep those to copies.
  };
  // rec['archivedAt'] = …, delete rec['woke'].
  const bracket = new RegExp(`(?:delete\\s+[\\w.]+\\[['"\`](?:${fieldRe})['"\`]\\])|(?:\\[['"\`](?:${fieldRe})['"\`]\\]\\s*(?:=(?!=)|\\?\\?=))`, 'g');
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && e.name !== 'place.ts') {
        const rel = path.relative(src, p);
        // Comments out, so a line quoting the old code isn't a write.
        const text = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
        for (const m of text.matchAll(bracket)) found.push(`${rel}: ${m[0]}`);
        for (const m of text.matchAll(write)) {
          const receiver = (m[1] ?? m[3]).split('.').at(-1)!;
          const field = m[2] ?? m[4];
          if (rel === 'store.ts' && field !== 'waitingOn') found.push(`${rel}: ${m[0]}`);
          else if (!(notRecords[rel] ?? []).includes(receiver)) found.push(`${rel}: ${m[0]}`);
        }
      }
    }
  };
  walk(src);
  assert.deepEqual(found, [], `Where a thread is parked (${PLACE_FIELDS.join(', ')}) is written only by parkRecord in src/place.ts. ` +
    'Send it an event (add one to PlaceEvent and movePlace if none fits) rather than setting or deleting the field. ' +
    'If the object written is a wire copy rather than a ThreadRecord, add its name to notRecords in this test.');
});
