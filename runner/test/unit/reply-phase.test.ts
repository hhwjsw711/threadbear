// A turn's reply phase (src/reply-phase.ts): every phase against every
// event, and long random walks of a turn, checked against the hand-written
// field writes in runner.ts it replaced (kept below as the reference), and
// the fields read as a phase and written back unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPLY_FIELDS, dropsStream, moveReply, replyFields, replyOf, replyTurn, type ReplyEvent, type ReplyFields } from '../../src/reply-phase.ts';
import {
  ALREADY_ENDED, ARCHIVE_ADDED, BULLETS_ONLY, ENDED, NARRATION_ONLY, SNOOZE_ADDED, endTurnAccepted, endTurnAddedArchive, endTurnAddedSnooze,
  endTurnAsksForMessage, endTurnIsOneReply, endTurnMessageStands, endTurnOwesReply, endTurnRefusedRepeat, endTurnRefusedUnread, endTurnTaken,
  endTurnWantsReply, needsFromTool, oneReplyAccepted, oneReplyAlreadyWritten, replyWithoutRepeat, splitReplySection, summaryFromTool, summaryMarkdown,
  unreadMessageRefusal, type Needs,
} from '../../src/needs.ts';
import type { Turn } from '../../src/runner.ts';

type Rec = Record<string, unknown>;
type T = ReplyFields & Rec;
// What an event comes out as, the same for both: the text event written
// (or dropped), and what a result writes.
type Outcome = { dropped?: true; ev?: Rec; tookCard?: Needs; headline?: string; restate?: string; summary?: string };

// ---- The reference: runner.ts's writes by hand before reply-phase.ts ----
// (onOutput's text routing, lastText and end_turn blocks, steer, seeWake
// and the endTurnNudge output, as they were at 981960460), on a copy.
function byHand(t: T, e: ReplyEvent): Outcome {
  const o: Outcome = {};
  switch (e.kind) {
    case 'call':
      t.endTurnBefore = t.endTurn;
      t.endTurn = e.input;
      t.endTurnBy = e.by;
      t.endTurnCall = e.itemId;
      return o;
    case 'result': {
      const ev = { ok: e.ok, text: e.text, itemId: e.itemId };
      let restateReply: string | undefined;
      if (ev.itemId === t.endTurnCall) {
        if (endTurnRefusedRepeat(ev) || endTurnRefusedUnread(ev) || (!ev.ok && (t.ended || t.tookEndTurn))) t.endTurn = t.endTurnBefore;
        else if (endTurnTaken(ev)) {
          t.tookEndTurn = true;
          restateReply = t.cardReopened && endTurnMessageStands(ev) && t.finalTexts?.size ? [...t.finalTexts.values()].join('\n\n') : undefined;
          t.cardReopened = false;
          t.replyRewrite = false;
          if (endTurnWantsReply(ev)) t.finalTexts = undefined;
          t.replyAfter = endTurnWantsReply(ev);
        } else if (endTurnAddedArchive(ev)) t.endTurn = { ...t.endTurnBefore, archive: t.endTurn?.archive === true }; // fixed with reply-phase.ts (below)
        else if (endTurnAddedSnooze(ev)) t.endTurn = { ...t.endTurnBefore, snooze: t.endTurn?.snooze };
      }
      if (ev.itemId === t.endTurnCall && endTurnAccepted(ev)) {
        t.ended = true;
        const headline = typeof t.endTurn?.headline === 'string' ? t.endTurn.headline.trim() : '';
        if (headline) {
          t.headline = true;
          o.headline = headline;
        }
        t.replyNeeds = undefined;
        const bullets = endTurnIsOneReply(ev) ? undefined : summaryFromTool(t.endTurn);
        t.owedReply = !bullets ? undefined : endTurnAsksForMessage(ev) ? 0 : endTurnOwesReply(ev) ? summaryMarkdown(bullets).length : undefined;
      }
      if (restateReply !== undefined && ev.itemId === t.endTurnCall) o.restate = restateReply;
      if (ev.itemId === t.endTurnCall && endTurnTaken(ev)) {
        const bullets = endTurnIsOneReply(ev) ? undefined : summaryFromTool(t.endTurn);
        if (bullets) {
          const text = summaryMarkdown(bullets);
          t.summarized = true;
          t.lastText = text;
          o.summary = text;
        }
      }
      return o;
    }
    case 'text':
    case 'reasoning': {
      let ev: Rec = e.kind === 'text' ? { type: 'assistant.text', itemId: e.itemId, text: e.text, ...(e.narration ? { narration: true } : {}) } : { type: 'reasoning', itemId: e.itemId, text: '' };
      const text = () => ev.text as string;
      if (t.replyAfter) {
        if (ev.type === 'assistant.text') {
          const tool = t.endTurn ? needsFromTool(t.endTurn) : undefined;
          const split = !tool?.asks?.length && !tool?.next?.length ? splitReplySection(text()) : undefined;
          if (split?.needs) {
            t.replyNeeds = split.needs;
            o.tookCard = split.needs;
          }
          const tx = split?.needs ? split.reply : tool?.asks?.length ? replyWithoutRepeat(text(), tool) : text();
          ev = { type: 'assistant.text', itemId: ev.itemId, text: tx, final: true, ...(ev.narration ? { narration: true } : {}) };
          if (tx.trim()) (t.finalTexts ??= new Map()).set(ev.itemId as string, tx);
        }
      } else if (ev.type === 'assistant.text' && t.ended && t.narrationItem && !t.summarized && text().trim()) {
        ev = { type: 'assistant.text', itemId: t.narrationItem, text: text() };
        t.narrationItem = undefined;
      } else if (ev.type === 'assistant.text' && t.ended && t.owedReply !== undefined && text().trim().length > t.owedReply) {
        t.owedReply = undefined;
      } else if (t.ended) {
        return { dropped: true };
      }
      if (ev.type === 'assistant.text' && !t.summarized) {
        t.lastText = text();
        t.narrationItem = ev.narration ? (ev.itemId as string) : undefined;
      }
      if (ev.type === 'assistant.text') o.ev = ev;
      return o;
    }
    case 'message': {
      // Fixed with reply-phase.ts: a new message resets the reply phase to a
      // fresh working state, keeping only endTurnBy (the least access across
      // calls), so the answer cannot inherit an earlier end_turn's needs/card.
      const by = t.endTurnBy;
      for (const k of REPLY_FIELDS) delete t[k];
      if (by !== undefined) t.endTurnBy = by;
      return o;
    }
    case 'wakeRead':
      if (!(t.ended || t.tookEndTurn)) return o;
      t.ended = false;
      t.owedReply = undefined;
      t.headline = false;
      t.summarized = false;
      t.narrationItem = undefined;
      return o;
    case 'nudge':
      if (e.reopen) {
        if (!t.ended) return o;
        t.endTurnNudged = true;
        t.cardReopened = true;
        t.replyAfter = false;
        t.replyRewrite = e.rewrite;
        return o;
      }
      t.endTurnNudged = true;
      return o;
  }
}

// The same event through the module, as runner.ts's onOutput reads its out.
function viaModule(t: T, e: ReplyEvent): Outcome {
  const res = replyTurn(t as unknown as Turn, e);
  assert.ok(res.ok, `refused: ${res.ok ? '' : res.reason}`);
  const out = res.out;
  const o: Outcome = {};
  if (e.kind === 'text' || e.kind === 'reasoning') {
    if (out.route === 'dropped') return { dropped: true };
    if (e.kind === 'text') o.ev = out.text && (out.route === 'reply' || out.route === 'summaryReplaced') ? { type: 'assistant.text', ...out.text } : { type: 'assistant.text', itemId: e.itemId, text: e.text, ...(e.narration ? { narration: true } : {}) };
  }
  if (out.tookCard) o.tookCard = out.tookCard;
  if (out.headline !== undefined) o.headline = out.headline;
  if (out.restate !== undefined) o.restate = out.restate;
  if (out.summary !== undefined) o.summary = out.summary;
  return o;
}

// A flag that's off reads the same as one that's absent: every reader reads
// them by truth, and a Turn is never stored or sent.
const norm = (t: object) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined && v !== false));

// ---- The events ----

const BULLETS = ['Fixed the build', 'Found a flaky test'];
const CALLS: Record<string, Record<string, unknown>> = {
  oneReply: { headline: ' Fixed it ', needs: 'nothing' },
  asks: { needs: 'you', asks: [{ question: 'Deploy it?' }] },
  next: { needs: 'nothing', next: ['Try the new button'] },
  bullets: { needs: 'nothing', summary: BULLETS },
  bulletsAsks: { needs: 'you', summary: BULLETS, asks: [{ action: 'Say yes' }] },
  archive: { needs: 'nothing', archive: true },
  snooze: { needs: 'nothing', snooze: '2h', waitFor: ['abc12345'] },
};
const RESULTS: Record<string, { ok: boolean; text: string }> = {
  replyNext: { ok: true, text: oneReplyAccepted(false) },
  replyNextYou: { ok: true, text: oneReplyAccepted(true, '', true) },
  messageStands: { ok: true, text: oneReplyAlreadyWritten(false) },
  bulletsOwed: { ok: true, text: `${ENDED} is done. ${BULLETS_ONLY}.` },
  bulletsNarration: { ok: true, text: `${ENDED} is done. ${NARRATION_ONLY}` },
  bulletsDone: { ok: true, text: `${ENDED} is done.` },
  codexNoted: { ok: true, text: 'Noted. Now write your final answer.' },
  repeat: { ok: false, text: ALREADY_ENDED },
  unread: { ok: false, text: unreadMessageRefusal() },
  refused: { ok: false, text: 'Not ended: those arguments do not fit end_turn.' },
  archiveAdded: { ok: true, text: ARCHIVE_ADDED },
  snoozeAdded: { ok: true, text: SNOOZE_ADDED },
  okOther: { ok: true, text: 'Saved.' },
};
const TEXTS: Record<string, { text: string; narration?: true }> = {
  plain: { text: 'Here is the answer.' },
  narration: { text: 'The agent explained the plan.', narration: true },
  section: { text: 'Done it.\n\n**What I need from you:**\n1. Try the build on your phone' },
  nothing: { text: 'All set.\n\nNothing needed from you.' },
  long: { text: 'A full answer that says a good deal more than the bullets did, with the details the user asked for and more besides.' },
  short: { text: 'Done.' },
  blank: { text: '   ' },
};

// Every event, with a result for the latest call (LATEST) or another tool.
function events(latest: string | undefined): Record<string, ReplyEvent> {
  const out: Record<string, ReplyEvent> = {};
  for (const [n, input] of Object.entries(CALLS)) out[`call.${n}`] = { kind: 'call', itemId: `c-${n}`, input: structuredClone(input), by: { mode: n === 'asks' ? 'ask' : 'full' } };
  for (const [n, r] of Object.entries(RESULTS)) {
    out[`result.${n}`] = { kind: 'result', itemId: latest ?? 'c-none', ...r };
    if (n === 'replyNext') out[`result.${n}.other`] = { kind: 'result', itemId: 'some-tool', ...r };
  }
  for (const [n, x] of Object.entries(TEXTS)) out[`text.${n}`] = { kind: 'text', itemId: `x-${n}`, ...x };
  out.reasoning = { kind: 'reasoning', itemId: 'r1' };
  out.message = { kind: 'message' };
  out.wakeRead = { kind: 'wakeRead' };
  out.nudge = { kind: 'nudge', reopen: false, rewrite: false };
  out.nudgeReopen = { kind: 'nudge', reopen: true, rewrite: false };
  out.nudgeRewrite = { kind: 'nudge', reopen: true, rewrite: true };
  return out;
}

// ---- The phases, as walks from a new turn by the old code ----

function walk(...names: string[]): T {
  const t: T = {};
  for (const n of names) byHand(t, events(t.endTurnCall)[n]);
  return t;
}

const STATES: Record<string, () => T> = {
  fresh: () => ({}),
  working: () => walk('text.plain', 'reasoning'),
  workingNarration: () => walk('text.narration'),
  workingRefusedCall: () => walk('call.archive', 'result.refused'),
  workingNudged: () => walk('text.plain', 'nudge'),
  workingAfterMessage: () => walk('call.snooze', 'result.refused', 'message'),
  workingAfterBulletsMessage: () => walk('call.bullets', 'result.bulletsDone', 'message'),
  workingAfterReplyMessage: () => walk('call.oneReply', 'result.replyNext', 'text.plain', 'message'),
  ended: () => walk('text.plain', 'call.bullets', 'result.bulletsDone'),
  endedOwed: () => walk('call.bullets', 'result.bulletsOwed'),
  endedOwedAny: () => walk('text.narration', 'call.bullets', 'result.bulletsNarration'),
  endedStands: () => walk('text.plain', 'call.asks', 'result.messageStands'),
  endedHeadline: () => walk('text.narration', 'call.oneReply', 'result.messageStands'),
  endedArchived: () => walk('call.bullets', 'result.bulletsDone', 'call.archive', 'result.archiveAdded'),
  replying: () => walk('call.oneReply', 'result.replyNext'),
  replyingWrote: () => walk('call.oneReply', 'result.replyNext', 'text.plain', 'text.section'),
  replyingAsks: () => walk('call.asks', 'result.replyNextYou', 'text.section'),
  reopened: () => walk('call.oneReply', 'result.replyNext', 'text.plain', 'nudgeReopen'),
  reopenedRewrite: () => walk('call.oneReply', 'result.replyNext', 'text.long', 'nudgeRewrite'),
  reopenedOwed: () => walk('call.bullets', 'result.bulletsOwed', 'nudgeReopen'),
  openWake: () => walk('call.oneReply', 'result.replyNext', 'text.plain', 'wakeRead'),
  openReopened: () => walk('call.oneReply', 'result.replyNext', 'text.plain', 'nudgeReopen', 'wakeRead'),
  codexNoted: () => walk('call.bullets', 'result.codexNoted'),
  codexNotedAfterEnd: () => walk('call.bullets', 'result.bulletsOwed', 'call.next', 'result.codexNoted'),
};

const PHASES: Record<string, string> = {
  fresh: 'working', working: 'working', workingNarration: 'working', workingRefusedCall: 'working', workingNudged: 'working',
  workingAfterMessage: 'working', workingAfterBulletsMessage: 'working', workingAfterReplyMessage: 'working',
  ended: 'ended', endedOwed: 'ended', endedOwedAny: 'ended', endedStands: 'ended', endedHeadline: 'ended', endedArchived: 'ended',
  replying: 'replying', replyingWrote: 'replying', replyingAsks: 'replying',
  reopened: 'reopened', reopenedRewrite: 'reopened', reopenedOwed: 'reopened',
  openWake: 'open', openReopened: 'open', codexNoted: 'open', codexNotedAfterEnd: 'ended',
};

test('each phase reads as its kind', () => {
  const kinds = Object.fromEntries(Object.entries(STATES).map(([n, f]) => [n, replyOf(f()).kind]));
  assert.deepEqual(kinds, PHASES);
});

test('every phase, on every event, moves as the writes by hand did', () => {
  for (const [stateName, make] of Object.entries(STATES)) {
    for (const [eventName, e] of Object.entries(events(make().endTurnCall))) {
      const want = make();
      const got = make();
      const wantOut = byHand(want, structuredClone(e));
      const gotOut = viaModule(got, structuredClone(e));
      assert.deepEqual(norm(got), norm(want), `${stateName} + ${eventName}: the fields`);
      assert.deepEqual(gotOut, wantOut, `${stateName} + ${eventName}: what it writes`);
      assert.notEqual(replyOf(got).kind, 'odd', `${stateName} + ${eventName} moved to an odd phase`);
    }
  }
});

test('random turns move as the writes by hand did, and never reach an odd phase', () => {
  let seed = 5;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let steps = 0;
  const seen = new Set<string>();
  for (let walkNo = 0; walkNo < 3000; walkNo++) {
    const want: T = {};
    const got: T = {};
    const trail: string[] = [];
    const len = 1 + Math.floor(rand() * 14);
    for (let i = 0; i < len; i++) {
      const all = events(want.endTurnCall);
      const names = Object.keys(all);
      // Results of the latest call half the time, so walks get past it.
      const pool = rand() < 0.5 ? names.filter((n) => n.startsWith('result.') && !n.endsWith('.other')) : names;
      const name = pool[Math.floor(rand() * pool.length)];
      trail.push(name);
      const wantOut = byHand(want, structuredClone(all[name]));
      const gotOut = viaModule(got, structuredClone(all[name]));
      assert.deepEqual(norm(got), norm(want), trail.join(' > '));
      assert.deepEqual(gotOut, wantOut, `${trail.join(' > ')}: what it writes`);
      const phase = replyOf(got).kind;
      assert.notEqual(phase, 'odd', trail.join(' > '));
      seen.add(phase);
      // The delta stream drops as the old check did.
      assert.equal(dropsStream(got), Boolean(want.ended && !want.replyAfter), trail.join(' > '));
      steps++;
    }
  }
  assert.ok(steps > 15_000);
  assert.deepEqual([...seen].sort(), ['ended', 'open', 'reopened', 'replying', 'working']);
});

// Every combination of the flags that make up the phase, read and written
// back: the ones no move writes are kept as found, and refuse every event.
test('every shape of the phase fields reads as a phase and writes back as it was', () => {
  const flags = ['tookEndTurn', 'ended', 'replyAfter', 'cardReopened', 'replyRewrite'] as const;
  let odd = 0;
  for (let mask = 0; mask < 1 << (flags.length + 2); mask++) {
    const t: T = { endTurn: { needs: 'nothing' }, lastText: 'hi' };
    flags.forEach((k, i) => {
      if (mask & (1 << i)) t[k] = true;
    });
    if (mask & (1 << flags.length)) t.owedReply = 0;
    if (mask & (1 << (flags.length + 1))) t.finalTexts = new Map([['a', 'reply']]);
    const s = replyOf(t);
    const back = replyFields(s);
    for (const k of REPLY_FIELDS) assert.equal(back[k], t[k], `${k} of ${JSON.stringify(t)}`);
    const copy = { ...t };
    if (s.kind === 'odd') {
      odd++;
      const res = replyTurn(copy as unknown as Turn, { kind: 'message' });
      assert.equal(res.ok, false);
      assert.deepEqual(copy, t, 'a refused move leaves the turn');
    }
  }
  assert.ok(odd > 0 && odd < 128);
});

test('an unchanged field keeps its object', () => {
  const t = STATES.replyingWrote();
  const finals = t.finalTexts;
  const input = t.endTurn;
  replyTurn(t as unknown as Turn, { kind: 'reasoning', itemId: 'r9' });
  assert.equal(t.finalTexts, finals);
  assert.equal(t.endTurn, input);
});

test('a second end_turn that adds archive or snooze keeps the card taken', () => {
  const t = walk('call.asks', 'result.replyNextYou', 'text.plain');
  replyTurn(t as unknown as Turn, { kind: 'call', itemId: 'c2', input: { needs: 'nothing', archive: true }, by: { mode: 'full' } });
  replyTurn(t as unknown as Turn, { kind: 'result', itemId: 'c2', ...RESULTS.archiveAdded });
  assert.deepEqual(t.endTurn, { ...CALLS.asks, archive: true });
  assert.equal(replyOf(t).kind, 'replying');
});

// A new message resets the reply phase to working so an answer that finishes
// without another end_turn can't inherit the earlier end_turn's needs/archive,
// nor let an in-flight pre-message call's result restore them. Only endTurnBy
// stays (least access across the turn's end_turn calls).
test('a message clears the earlier end_turn and ignores an in-flight pre-message result, keeping only endTurnBy', () => {
  const t = walk('call.archive', 'result.bulletsDone');
  replyTurn(t as unknown as Turn, { kind: 'call', itemId: 'c2', input: { needs: 'nothing', next: ['More'] }, by: { mode: 'ask' } });
  replyTurn(t as unknown as Turn, { kind: 'message' });
  assert.equal(replyOf(t).kind, 'working');
  assert.equal(t.endTurn, undefined);
  assert.deepEqual(t.endTurnBy, { mode: 'ask' }, 'least access stays across the turn');
  replyTurn(t as unknown as Turn, { kind: 'result', itemId: 'c2', ...RESULTS.unread });
  assert.equal(t.endTurn, undefined);
  for (const [n] of [['snooze', CALLS.snooze], ['archive', CALLS.archive]] as const) {
    const u = walk(`call.${n}`, 'result.bulletsDone', 'call.next');
    replyTurn(u as unknown as Turn, { kind: 'message' });
    replyTurn(u as unknown as Turn, { kind: 'result', itemId: 'c-next', ...RESULTS.repeat });
    assert.equal(u.endTurn, undefined);
  }
  // An in-flight pre-message call whose accepted result lands after the message
  // must not end the turn or drop words written for the new message.
  const v = walk('call.oneReply');
  replyTurn(v as unknown as Turn, { kind: 'message' });
  replyTurn(v as unknown as Turn, { kind: 'result', itemId: 'c-oneReply', ...RESULTS.bulletsDone });
  assert.equal(replyOf(v).kind, 'working');
  assert.equal(v.endTurn, undefined);
  const w = replyTurn(v as unknown as Turn, { kind: 'text', itemId: 'x1', text: 'Answering the new message.' });
  assert.ok(w.ok && w.out.route === 'kept');
  // A stale reopen/rewrite nudge arriving after a message reset must not mark
  // the fresh working turn as nudged (which would make end_turn keep a dead reply).
  const n = walk('call.oneReply', 'result.replyNext', 'message');
  replyTurn(n as unknown as Turn, { kind: 'nudge', reopen: true, rewrite: true });
  assert.equal(n.endTurnNudged, undefined);
  assert.equal(n.cardReopened, undefined);
  assert.equal(n.replyRewrite, undefined);
});

// From Gemini's review: the repeat was taken as adding archive, and Mike's
// message landed before its result, which must not put archive back on.
test('a message before a repeat\'s ARCHIVE_ADDED result keeps the archive off', () => {
  const t = walk('call.next', 'result.bulletsDone', 'call.archive');
  replyTurn(t as unknown as Turn, { kind: 'message' });
  replyTurn(t as unknown as Turn, { kind: 'result', itemId: 'c-archive', ...RESULTS.archiveAdded });
  assert.equal(t.endTurn, undefined);
  const u = walk('call.next', 'result.bulletsDone', 'call.archive', 'result.archiveAdded');
  assert.equal(u.endTurn?.archive, true);
});

test('moveReply is pure', () => {
  const t = STATES.replyingWrote();
  const s = replyOf(t);
  const before = structuredClone(s);
  for (const e of Object.values(events(t.endTurnCall))) moveReply(s, e);
  assert.deepEqual(s, before);
});

// The guard: nothing outside reply-phase.ts writes these fields on a Turn.
test('only reply-phase.ts writes a turn`s reply phase', () => {
  const src = path.resolve(import.meta.dirname, '../../src');
  const fieldRe = REPLY_FIELDS.join('|');
  const write = new RegExp(`(?:delete\\s+([\\w.!?\\[\\]]+?)\\.(${fieldRe})\\b)|(?:([\\w.!?\\[\\]]+?)\\.(${fieldRe})\\s*(?:=(?!=)|\\?\\?=|\\|\\|=|&&=))`, 'g');
  // file: the receivers in it that aren't a Turn.
  const notTurns: Record<string, string[]> = {
    'adapters/claude/adapter.ts': ['this'], // the Stop hook's own end_turn tracking
  };
  const bracket = new RegExp(`(?:delete\\s+[\\w.]+\\[['"\`](?:${fieldRe})['"\`]\\])|(?:\\[['"\`](?:${fieldRe})['"\`]\\]\\s*(?:=(?!=)|\\?\\?=))`, 'g');
  const found: string[] = [];
  const walkDir = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkDir(p);
      else if (e.name.endsWith('.ts') && e.name !== 'reply-phase.ts') {
        const rel = path.relative(src, p).split(path.sep).join('/');
        // Comments out, so a line quoting the old code isn't a write.
        const text = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
        for (const m of text.matchAll(bracket)) found.push(`${rel}: ${m[0]}`);
        for (const m of text.matchAll(write)) {
          const receiver = (m[1] ?? m[3]).split('.').at(-1)!;
          if (!(notTurns[rel] ?? []).includes(receiver)) found.push(`${rel}: ${m[0]}`);
        }
      }
    }
  };
  walkDir(src);
  assert.deepEqual(found, [], `A turn's reply phase (${REPLY_FIELDS.join(', ')}) is written only by replyTurn in src/reply-phase.ts (Runner.reply). ` +
    'Send it an event (add one to ReplyEvent and moveReply if none fits) rather than setting or deleting the field. ' +
    'If the object written isn\'t a Turn, add its name to notTurns in this test.');
});
