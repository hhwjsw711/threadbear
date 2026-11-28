// Where a thread is parked: in the inbox, snoozed (hibernating) or archived,
// as one state type with every move in `movePlace`. Before 20 Nov 2026 this
// was fourteen loose fields on the thread's record, written by hand at a
// dozen sites, and bugs came from a site forgetting one of them (ebbdd07d3:
// a thread archived while it slept woke up in the archive).
//
// The record keeps those fields, as they are on disk, on the wire to the
// apps, in Convex's mirror and in older runners' and forks' hands: `placeOf`
// reads them as a Place and `placeFields` writes one back, and every write
// to them goes through `parkRecord(rec, event, now)` (the only writer, which
// place.test.ts holds the rest of runner/src to). Reads that just want one
// field stay on the field.
//
// The places, and how a thread moves between them:
//
//   inbox ──snooze──▶ snoozed ──wake / unsnooze / message──▶ inbox
//     │                 │  ▲
//     │              archive  unarchive (the sleep goes on, keptOut set)
//     │                 ▼  │
//     └──archive──▶ archived (a sleep it had goes on inside it)
//   archived ──message / reviewAnswered──▶ inbox (and the sleep ends)
//   archived ──wake──▶ archived, the sleep ended quietly (no "Woke up")
//
// A sleep is until a time, or until the runner restarts (or starts on
// another release), or until something said in words happens (a time, a
// topic or both, `pending` while the model reads them), or until other
// threads finish (with a time at the latest), or until Mike's app restarts
// onto a new build (a day at most). Each sleep has a time (snoozedUntil):
// a far-off one, UNTIL_RESTART, for a restart or for words with no time.
// Once that time has passed it still reads as a sleep here until the timer
// wakes it; `placeBucket` says where the lists show it, by the clock.
//
// Events and where they come from (each allowed in every place unless said):
//   snooze        Runner.update's snoozedUntil (Mike, the apps, update_thread,
//                 tb snooze, end_turn's snooze, a wait's or a wake-when's
//                 first step, the mail watcher through sync).
//   unsnooze      Runner.update's snoozedUntil: null.
//   wordsAsked    hibernateWhen, while the model reads the words; needs a time sleep.
//   wordsAnswered its answer; needs that pending wait, refused otherwise.
//   wordsFailed   no answer: back out; needs that pending wait.
//   waitOn        end_turn's waitFor or a lab review; needs a time sleep.
//   forApp        wait_for_app_restart; needs a time sleep.
//   checked       the librarian woke an agent's wait to check (wakeChecked);
//                 needs a sleep with words.
//   wake          by itself: its time, a restart or new release, a topic,
//                 the threads it waited on (Runner.wake).
//   message       anything sent to it (Runner.sendTo): a sleep or the archive
//                 ends; a schedule's message out of the archive is marked so
//                 the run can put it back (unarchivedBySchedule).
//   reviewAnswered  Mike answering a design review (reviews.ts).
//   archive / unarchive  Runner.update's archived (Mike, an agent, Threadbear).
//   scheduleRunEnded  the scheduled run that brought it out ended for good.
//   seen          Mike looked at it (markSeen): its "Woke up" goes.
//
// Moving a thread to another runner, a handover and a load carry the fields
// as they are: no event. A record whose fields fit no place exactly (written
// by an older runner, or by hand) is kept as found: odd sleep fields stay in
// a sleep `{ kind: 'odd' }`, and ones outside any sleep in `stray`, until an
// event that would clear them does.
import type { ArchivedBy, ArchiveVerdict } from './protocol.ts';
import type { ThreadRecord } from './store.ts';
import type { WakeWhen } from './wake-when.ts';

// runner.ts's UNTIL_RESTART and NO_WAKE_TIME (one value; place.test.ts checks).
export const FAR_OFF = '9999-12-31T00:00:00.000Z';

export const PLACE_FIELDS = [
  'snoozedUntil', 'snoozedUntilRestart', 'untilRelease', 'wakeWhen', 'waitingOn', 'hibernatedForApp', 'waitingOnRuns', 'snoozedByAgent',
  'snoozedAt', 'woke', 'wakeChecked', 'archivedAt', 'archivedBy', 'archiveVerdict', 'unarchivedBySchedule', 'keptOut',
] as const;
export type PlaceField = (typeof PLACE_FIELDS)[number];
export type PlaceFields = Pick<ThreadRecord, PlaceField>;

// The fields that make up a sleep, which every end of one clears.
const SLEEP_FIELDS = ['snoozedUntil', 'snoozedUntilRestart', 'untilRelease', 'wakeWhen', 'waitingOn', 'hibernatedForApp', 'waitingOnRuns', 'snoozedByAgent'] as const;
type SleepDetail = Pick<ThreadRecord, 'snoozedUntilRestart' | 'untilRelease' | 'wakeWhen' | 'waitingOn' | 'hibernatedForApp' | 'waitingOnRuns' | 'snoozedByAgent'>;
export type Wait = NonNullable<ThreadRecord['waitingOn']>[number];

export type SleepFor =
  // `by`: its agent hibernated it (end_turn's snooze, update_thread), not Mike.
  | { kind: 'time'; by?: 'agent' }
  // `release`: only a start on another release than this wakes it.
  | { kind: 'restart'; release?: string }
  | { kind: 'words'; wakeWhen: WakeWhen }
  | { kind: 'threads'; waitingOn: Wait[] }
  | { kind: 'app' }
  // GitHub workflow runs: the keys of the ci-runs watches it waits on.
  | { kind: 'runs'; keys: string[] }
  // Fields together that no move writes: kept as found.
  | { kind: 'odd'; fields: SleepDetail };

// `until`: snoozedUntil, an ISO time (FAR_OFF for a restart or words alone).
export type Sleep = { until: string; for: SleepFor };

// What outlives a move between places.
export type Marks = {
  snoozedAt?: string; // when it last went away; stale once awake, till it next does
  woke?: ThreadRecord['woke']; // woke by itself and not looked at yet
  wakeChecked?: ThreadRecord['wakeChecked'];
  keptOut?: boolean; // taken out of the archive by hand
  unarchivedBySchedule?: ThreadRecord['unarchivedBySchedule'];
  // Who archived it last and his verdict, left from an archive it's out of
  // (only read while archived, so nothing clears them).
  lastBy?: ArchivedBy;
  lastVerdict?: ArchiveVerdict;
  // Place fields as found that no place explains (a sleep's detail with no
  // sleep, an empty archivedAt), kept until an event clears them.
  stray?: Partial<PlaceFields>;
};

export type Place =
  | { kind: 'inbox'; marks: Marks }
  | { kind: 'snoozed'; sleep: Sleep; marks: Marks }
  | { kind: 'archived'; at: string; by?: ArchivedBy; verdict?: ArchiveVerdict; sleep?: Sleep; marks: Marks };

export type PlaceEvent =
  | { kind: 'snooze'; until: { kind: 'time'; at: string; by?: 'agent' } | { kind: 'restart'; release?: string } }
  | { kind: 'unsnooze' }
  | { kind: 'wordsAsked'; said: string; by?: 'agent' }
  | { kind: 'wordsAnswered'; said: string; until?: string; topic?: string; by?: 'agent' }
  | { kind: 'wordsFailed'; said: string }
  | { kind: 'waitOn'; waits: Wait[] }
  | { kind: 'forApp' }
  | { kind: 'forRuns'; keys: string[] }
  | { kind: 'checked'; threadId: string; seq: number }
  | { kind: 'wake' }
  | { kind: 'message'; fromSchedule: boolean; fromMike: boolean }
  | { kind: 'reviewAnswered' }
  | { kind: 'archive'; by: ArchivedBy; verdict?: ArchiveVerdict }
  | { kind: 'unarchive' }
  | { kind: 'scheduleRunEnded' }
  | { kind: 'seen' };

export type PlaceMove = { ok: true; place: Place } | { ok: false; reason: string };

// ---- Reading and writing the fields ----

// The fields, read as a Place. Truthiness, as the code reading them always
// has: an empty snoozedUntil or archivedAt is no sleep or archive.
export function placeOf(rec: PlaceFields): Place {
  const marks: Marks = {};
  const stray: Partial<PlaceFields> = {};
  if (rec.snoozedAt !== undefined) marks.snoozedAt = rec.snoozedAt;
  if (rec.woke !== undefined) marks.woke = rec.woke;
  if (rec.wakeChecked !== undefined) marks.wakeChecked = rec.wakeChecked;
  if (rec.keptOut !== undefined) marks.keptOut = rec.keptOut;
  if (rec.unarchivedBySchedule !== undefined) marks.unarchivedBySchedule = rec.unarchivedBySchedule;
  let sleep: Sleep | undefined;
  if (rec.snoozedUntil) sleep = { until: rec.snoozedUntil, for: sleepFor(rec) };
  else for (const k of SLEEP_FIELDS) if (rec[k] !== undefined) (stray as Record<string, unknown>)[k] = rec[k];
  if (rec.archivedAt) {
    if (Object.keys(stray).length) marks.stray = stray;
    return { kind: 'archived', at: rec.archivedAt, ...(rec.archivedBy !== undefined ? { by: rec.archivedBy } : {}), ...(rec.archiveVerdict !== undefined ? { verdict: rec.archiveVerdict } : {}), ...(sleep ? { sleep } : {}), marks };
  }
  if (rec.archivedAt !== undefined) stray.archivedAt = rec.archivedAt;
  if (rec.archivedBy !== undefined) marks.lastBy = rec.archivedBy;
  if (rec.archiveVerdict !== undefined) marks.lastVerdict = rec.archiveVerdict;
  if (Object.keys(stray).length) marks.stray = stray;
  return sleep ? { kind: 'snoozed', sleep, marks } : { kind: 'inbox', marks };
}

function sleepFor(rec: PlaceFields): SleepFor {
  const has = (['snoozedUntilRestart', 'untilRelease', 'wakeWhen', 'waitingOn', 'hibernatedForApp', 'waitingOnRuns', 'snoozedByAgent'] as const).filter((k) => rec[k] !== undefined);
  const only = (...ks: string[]) => has.length > 0 && has.every((k) => ks.includes(k));
  if (!has.length) return { kind: 'time' };
  if (only('snoozedByAgent') && rec.snoozedByAgent === true) return { kind: 'time', by: 'agent' };
  if (only('snoozedUntilRestart', 'untilRelease') && rec.snoozedUntilRestart === true && rec.snoozedUntil === FAR_OFF && (rec.untilRelease === undefined || typeof rec.untilRelease === 'string')) {
    return rec.untilRelease !== undefined ? { kind: 'restart', release: rec.untilRelease } : { kind: 'restart' };
  }
  if (only('wakeWhen') && isObject(rec.wakeWhen)) return { kind: 'words', wakeWhen: rec.wakeWhen };
  if (only('waitingOn') && Array.isArray(rec.waitingOn)) return { kind: 'threads', waitingOn: rec.waitingOn };
  if (only('hibernatedForApp') && rec.hibernatedForApp === true) return { kind: 'app' };
  if (only('waitingOnRuns') && Array.isArray(rec.waitingOnRuns)) return { kind: 'runs', keys: rec.waitingOnRuns };
  const fields: SleepDetail = {};
  for (const k of has) (fields as Record<string, unknown>)[k] = rec[k];
  return { kind: 'odd', fields };
}

// A Place, as the record's fields: every one of PLACE_FIELDS, undefined where
// it's absent. placeFields(placeOf(f)) gives back f's own values (the same
// objects, so a reference another part holds stays the record's).
export function placeFields(place: Place): { [K in PlaceField]: PlaceFields[K] | undefined } {
  const out = Object.fromEntries(PLACE_FIELDS.map((k) => [k, undefined])) as { [K in PlaceField]: PlaceFields[K] | undefined };
  const { marks } = place;
  Object.assign(out, marks.stray);
  out.snoozedAt = marks.snoozedAt;
  out.woke = marks.woke;
  out.wakeChecked = marks.wakeChecked;
  out.keptOut = marks.keptOut;
  out.unarchivedBySchedule = marks.unarchivedBySchedule;
  const sleep = place.kind === 'inbox' ? undefined : place.sleep;
  if (sleep) {
    out.snoozedUntil = sleep.until;
    const f = sleep.for;
    switch (f.kind) {
      case 'time':
        if (f.by === 'agent') out.snoozedByAgent = true;
        break;
      case 'restart':
        out.snoozedUntilRestart = true;
        out.untilRelease = f.release;
        break;
      case 'words':
        out.wakeWhen = f.wakeWhen;
        break;
      case 'threads':
        out.waitingOn = f.waitingOn;
        break;
      case 'app':
        out.hibernatedForApp = true;
        break;
      case 'runs':
        out.waitingOnRuns = f.keys;
        break;
      case 'odd':
        Object.assign(out, f.fields);
        break;
      default:
        return unreachable(f);
    }
  }
  if (place.kind === 'archived') {
    out.archivedAt = place.at;
    out.archivedBy = place.by;
    out.archiveVerdict = place.verdict;
  } else {
    out.archivedBy = marks.lastBy;
    out.archiveVerdict = marks.lastVerdict;
  }
  return out;
}

// Where the lists show it now: a sleep whose time has passed is in the
// inbox until the timer wakes it (Runner.bucket).
export function placeBucket(place: Place, now: number): 'inbox' | 'snoozed' | 'archived' {
  if (place.kind === 'archived') return 'archived';
  if (place.kind === 'snoozed' && Date.parse(place.sleep.until) > now) return 'snoozed';
  return 'inbox';
}

// Whether a starting runner (or one taking the thread over) wakes it: it
// sleeps until a restart, or a new release when `release` isn't the one it
// went to sleep on, or its words were still being read when the last one
// stopped (the answer went with it). An archived thread too: its sleep ends
// quietly (Runner.wake).
export function wakesOnStart(place: Place, release: string | undefined): boolean {
  const f = place.kind === 'inbox' ? undefined : place.sleep?.for;
  if (f?.kind === 'words') return Boolean(f.wakeWhen.pending);
  if (f?.kind === 'restart') return !f.release || f.release !== release;
  // Fields as found, in an odd sleep or with no sleep at all: read as they
  // always were.
  const raw: SleepDetail | undefined = f?.kind === 'odd' ? f.fields : f ? undefined : place.marks.stray;
  if (!raw) return false;
  if (raw.wakeWhen?.pending) return true;
  if (!raw.snoozedUntilRestart) return false;
  return !raw.untilRelease || raw.untilRelease !== release;
}

// ---- The moves ----

// The one place a Place moves. Pure: `now` is the clock's time.
export function movePlace(place: Place, e: PlaceEvent, now: number): PlaceMove {
  const iso = new Date(now).toISOString();
  const marks = place.marks;
  switch (e.kind) {
    case 'snooze': {
      // Kept through a change of wake time, so the note on waking counts
      // from when it first went away.
      const snoozedAt = placeBucket(place, now) === 'snoozed' ? marks.snoozedAt : iso;
      const sleep: Sleep = e.until.kind === 'time'
        ? { until: e.until.at, for: e.until.by === 'agent' ? { kind: 'time', by: 'agent' } : { kind: 'time' } }
        : { until: FAR_OFF, for: e.until.release ? { kind: 'restart', release: e.until.release } : { kind: 'restart' } };
      return ok(withSleep(place, sleep, { ...drop(marks, 'woke', 'stray'), ...keep('snoozedAt', snoozedAt), ...strayWithout(marks, SLEEP_FIELDS) }));
    }
    case 'unsnooze':
      return ok(withSleep(place, undefined, { ...drop(marks, 'woke', 'stray'), ...strayWithout(marks, SLEEP_FIELDS) }));
    case 'wordsAsked': {
      const sleep = place.kind === 'inbox' ? undefined : place.sleep;
      if (!sleep || sleep.for.kind !== 'time') return no('it has no sleep until a time to read the words in');
      return ok({ ...place, sleep: { until: sleep.until, for: { kind: 'words', wakeWhen: { said: e.said, pending: true, ...(e.by ? { by: e.by } : {}) } } } } as Place);
    }
    case 'wordsAnswered': {
      if (!pendingWords(place, e.said)) return no('it was woken or put away again while its words were read');
      const wakeWhen: WakeWhen = { said: e.said, ...(e.topic ? { topic: e.topic } : {}), ...(e.by ? { by: e.by } : {}) };
      // What it already checked counts only for the same words, from its agent.
      const stale = marks.wakeChecked && (!e.by || marks.wakeChecked.said !== e.said);
      return ok({ ...place, sleep: { until: e.until ?? FAR_OFF, for: { kind: 'words', wakeWhen } }, marks: stale ? drop(marks, 'wakeChecked') : marks } as Place);
    }
    case 'wordsFailed':
      if (!pendingWords(place, e.said)) return no('it was woken or put away again while its words were read');
      return ok(withSleep(place, undefined, marks));
    case 'waitOn':
    case 'forApp':
    case 'forRuns': {
      const sleep = place.kind === 'inbox' ? undefined : place.sleep;
      if (!sleep || sleep.for.kind !== 'time') return no('it has no sleep until a time to wait in');
      const f: SleepFor = e.kind === 'waitOn' ? { kind: 'threads', waitingOn: e.waits } : e.kind === 'forRuns' ? { kind: 'runs', keys: e.keys } : { kind: 'app' };
      return ok({ ...place, sleep: { until: sleep.until, for: f } } as Place);
    }
    case 'checked': {
      // Any sleep with words, odd ones from an older runner too, as the
      // librarian's topic wake takes them.
      const f = place.kind === 'inbox' ? undefined : place.sleep?.for;
      const wakeWhen = f?.kind === 'words' ? f.wakeWhen : f?.kind === 'odd' ? f.fields.wakeWhen : undefined;
      if (!wakeWhen || typeof wakeWhen !== 'object') return no('it has no sleep in words to check');
      const said = wakeWhen.said;
      const before = marks.wakeChecked?.said === said ? marks.wakeChecked.from : undefined;
      return ok({ ...place, marks: { ...marks, wakeChecked: { said, from: { ...before, [e.threadId]: e.seq } } } });
    }
    case 'wake': {
      const rest = { ...drop(marks, 'snoozedAt', 'stray'), ...strayWithout(marks, SLEEP_FIELDS) };
      // Archived since it went to sleep: its sleep just ends, quietly.
      if (place.kind === 'archived') return ok(withSleep(place, undefined, rest));
      const since = marks.snoozedAt && Date.parse(marks.snoozedAt) <= now ? marks.snoozedAt : undefined;
      return ok(withSleep(place, undefined, { ...rest, woke: { at: iso, ...(since ? { since } : {}) } }));
    }
    case 'message': {
      let m = marks;
      // A schedule's message out of the archive notes who had archived it,
      // so a run that ends with nothing for Mike puts it back.
      if (place.kind === 'archived' && e.fromSchedule) m = { ...m, unarchivedBySchedule: { by: place.by } };
      if (e.fromMike) m = drop(m, 'unarchivedBySchedule');
      let out: Place = place.kind === 'inbox' ? { ...place, marks: m } : bringBack(place, m);
      // Answering it from his phone without opening it counts as seeing it woke.
      if (e.fromMike) out = { ...out, marks: drop(out.marks, 'woke') };
      return ok(out);
    }
    case 'reviewAnswered':
      return ok(bringBack(place, marks));
    case 'archive': {
      const sleep = place.kind === 'inbox' ? undefined : place.sleep;
      const m = { ...drop(marks, 'unarchivedBySchedule', 'lastBy', 'lastVerdict', 'stray'), ...strayWithout(marks, ['archivedAt']) };
      return ok({ kind: 'archived', at: iso, by: e.by, ...(e.verdict ? { verdict: e.verdict } : {}), ...(sleep ? { sleep } : {}), marks: m });
    }
    case 'unarchive': {
      const m = { ...drop(marks, 'unarchivedBySchedule', 'stray'), ...strayWithout(marks, ['archivedAt']) };
      if (place.kind !== 'archived') return ok({ ...place, marks: m });
      // Brought back out by hand: it stays out, however its next turn ends
      // (runner/quiet-inbox.ts). A sleep it had goes on.
      const back = { ...m, keptOut: true, ...keep('lastBy', place.by), ...keep('lastVerdict', place.verdict) };
      return ok(place.sleep ? { kind: 'snoozed', sleep: place.sleep, marks: back } : { kind: 'inbox', marks: back });
    }
    case 'scheduleRunEnded':
      return ok({ ...place, marks: drop(marks, 'unarchivedBySchedule') });
    case 'seen':
      return ok({ ...place, marks: drop(marks, 'woke') });
    default:
      return unreachable(e);
  }
}

// Writes an event's move onto a thread's record: the one writer of
// PLACE_FIELDS. Only fields that change are touched, so an unchanged value
// keeps its object and its place in thread.json. A refused move leaves the
// record as it was and says why.
export function parkRecord(rec: ThreadRecord, e: PlaceEvent, now: number): PlaceMove {
  const res = movePlace(placeOf(rec), e, now);
  if (!res.ok) return res;
  const fields = placeFields(res.place);
  const out = rec as Record<string, unknown>;
  for (const k of PLACE_FIELDS) {
    const v = fields[k];
    if (v === undefined) {
      if (k in out) delete out[k];
    } else if (out[k] !== v) out[k] = v;
  }
  // The quiet inbox's mark (runner/inbox-guess.ts) means "archived by
  // Threadbear for this reason": anything else, and it's gone.
  if (rec.quietlyArchived && (res.place.kind !== 'archived' || res.place.by !== 'threadbear')) delete rec.quietlyArchived;
  return res;
}

// ---- Helpers ----

// A sleep and an archive end: archived, it comes back to the inbox with
// who archived it kept (only read while archived).
function bringBack(place: Place, marks: Marks): Place {
  const m = { ...drop(marks, 'stray'), ...strayWithout(marks, [...SLEEP_FIELDS, 'archivedAt']) };
  if (place.kind === 'archived') return { kind: 'inbox', marks: { ...m, ...keep('lastBy', place.by), ...keep('lastVerdict', place.verdict) } };
  return { kind: 'inbox', marks: m };
}

function withSleep(place: Place, sleep: Sleep | undefined, marks: Marks): Place {
  if (place.kind === 'archived') {
    const { sleep: _, ...rest } = place;
    return sleep ? { ...rest, sleep, marks } : { ...rest, marks };
  }
  return sleep ? { kind: 'snoozed', sleep, marks } : { kind: 'inbox', marks };
}

function pendingWords(place: Place, said: string): boolean {
  const f = place.kind === 'inbox' ? undefined : place.sleep?.for;
  return f?.kind === 'words' && f.wakeWhen.pending === true && f.wakeWhen.said === said;
}

function drop<K extends keyof Marks>(marks: Marks, ...keys: K[]): Marks {
  const out = { ...marks };
  for (const k of keys) delete out[k];
  return out;
}

function keep<K extends keyof Marks>(k: K, v: Marks[K] | undefined): Marks {
  return v === undefined ? {} : ({ [k]: v } as Marks);
}

// The stray fields, less the ones an event clears.
function strayWithout(marks: Marks, keys: readonly PlaceField[]): Marks {
  if (!marks.stray) return {};
  const stray = { ...marks.stray };
  for (const k of keys) delete stray[k];
  return Object.keys(stray).length ? { stray } : {};
}

function ok(place: Place): PlaceMove {
  return { ok: true, place };
}

function no(reason: string): PlaceMove {
  return { ok: false, reason };
}

function isObject(v: unknown): v is WakeWhen {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unreachable(x: never): never {
  throw new Error(`Unknown place event or state: ${JSON.stringify(x)}`);
}
