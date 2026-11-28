// A turn's reply phase: what happens around end_turn, as one state type with
// every move in `moveReply`. Before 20 Nov 2026 this was seventeen loose
// fields on a Turn, written by hand at four sites in runner.ts (the text and
// end_turn handling in onOutput, a message steered in, a background job's
// notice read, the Stop hook's nudge), and end_turn bugs came from one of
// them forgetting a case (70 commits name end_turn).
//
// The Turn keeps those fields: readers that just want one (the turn's card
// at its end, the handler's questions through Runner.endTurnNudged and the
// rest) stay on the field. `replyOf` reads them as a ReplyState,
// `replyFields` writes one back, and every write goes through
// `replyTurn(turn, event)`, the only writer, which reply-phase.test.ts holds
// the rest of runner/src to. A Turn lives only in memory (never stored, sent
// or handed over: a handover waits for the turn to end), so a flag that's
// off is written as absent, never false; every reader reads them by truth.
//
// The phases (docs/protocol/needs-you.md, "The reply phase", draws them):
//
//   working   no end_turn taken yet this turn. Its text is ordinary.
//   ended     an end_turn accepted ("Noted: this thread ..."), with bullets
//             or "your message above is the reply": text after it is dropped,
//             but for the message a narration block only summarised (it takes
//             that summary's place) and one the bullets stood for (`owed`:
//             kept when longer than this, 0 for any length).
//   replying  a one-reply end_turn accepted ("Now write your reply"): text
//             after it is the reply, kept, marked final, its "What I need from
//             you" taken off as the card when end_turn brought none.
//   reopened  ended, and the Stop hook sent it back for a card its reply
//             asked for (`rewrite`: to write that reply again, for dead links):
//             text is dropped as after any end_turn; the next taken end_turn is
//             that card, and its reply is written again under it.
//   open      an end_turn taken, then the turn opened again: the agent read a
//             background job's notice, or Codex's bullets form took one with
//             "Noted. Now write your final answer". Text is ordinary again
//             (still the reply after a one-reply end_turn, `replyAfter`), and
//             another end_turn is no repeat.
//   odd       fields together that no move writes, kept as found; every event
//             on it is refused (reply-phase.test.ts shows no walk reaches one).
//
// Every state carries the latest call (its arguments, which hold the
// requests the turn's end carries out: archive, snooze, waitFor), what the
// turn has said, and from ended on, the reply's final texts by item.
//
// Events, and how each moves the phase (every one allowed in every phase but odd):
//
//   event       from                          working   ended     replying  reopened  open
//   call        own end_turn tool.call        (data: the call's arguments, the one before, the least access, its item)
//   result      that call's tool.result:
//     refused   ALREADY_ENDED, UNREAD_MESSAGE, or any error once one was taken: the arguments go back to the call before
//     accepted  "Noted: this thread"          ended or replying (one reply), with any headline, bullets, owed
//     taken     Codex's "Noted. Now write"    open      ended     ended     ended     open
//     added     ARCHIVE_ADDED, SNOOZE_ADDED   (data: the call before, plus archive or snooze)
//   text        own assistant.text            kept      dropped*  reply     dropped*  kept (reply if replyAfter)
//   reasoning   own thinking                  kept      dropped   kept      dropped   kept
//   message     Mike (or anyone) steered in,  working   working   working   working   working (fresh working; only `by` stays)
//               or a queued CLI turn starts
//   wakeRead    a job's notice read           working   open      open+     open+r    open (headline, summary marks off)
//   nudge       the Stop hook sent it back    working   reopened  reopened  reopened  open   (reopened only with reopen)
//
//   * kept when it's a narration's real message or the message the bullets
//     owed. open+: replyAfter stays. open+r: the reopened mark stays.
//
// What isn't an event: the CLI's turn result, a Stop, an error or the CLI
// dying, which end the Turn (completeTurn reads its card with `turnNeeds`,
// failTurn reads nothing); a sub-agent's or a Codex child's words and calls,
// which never move it; a deltas' stream, dropped by `dropsStream`; a
// sub-agent or background job ending later, which is a new turn's wake.
import type { Turn } from './runner.ts';
import {
  endTurnAccepted, endTurnAddedArchive, endTurnAddedSnooze, endTurnAsksForMessage, endTurnIsOneReply, endTurnMessageStands, endTurnOwesReply,
  endTurnRefusedRepeat, endTurnRefusedUnread, endTurnTaken, endTurnWantsReply, needsFromText, needsFromTool, replyWithoutRepeat, splitReplySection,
  summaryFromTool, summaryMarkdown, type Needs,
  askWhenFromTool,
} from './needs.ts';

export const REPLY_FIELDS = [
  'endTurn', 'endTurnBefore', 'endTurnBy', 'endTurnCall', 'lastText', 'narrationItem', 'summarized', 'headline', 'replyNeeds', 'endTurnNudged',
  'tookEndTurn', 'ended', 'replyAfter', 'cardReopened', 'replyRewrite', 'owedReply', 'finalTexts',
] as const;
export type ReplyField = (typeof REPLY_FIELDS)[number];
export type ReplyFields = Pick<Turn, ReplyField>;

// The fields that make up the phase, kept as found on an odd one.
type PhaseFlags = Pick<Turn, 'tookEndTurn' | 'ended' | 'replyAfter' | 'cardReopened' | 'replyRewrite' | 'owedReply' | 'finalTexts'>;

// The agent's latest end_turn call.
export type Call = {
  input?: Record<string, unknown>; // endTurn: its arguments, as they stand
  before?: Record<string, unknown>; // endTurnBefore: the ones it replaced, until its result says whether it did
  by?: Turn['endTurnBy']; // the least access the thread had at any call this turn
  itemId?: string; // endTurnCall
};

// What the turn has said.
export type Said = {
  lastText?: string; // its latest own text, or the summary bullets
  narrationItem?: string; // that text was only a narration block's summary
  summarized?: true; // end_turn's bullets are in the events as its reply
  headline?: true; // end_turn's headline is the preview
  replyNeeds?: Needs; // the reply's "What I need from you", the card
  nudged?: true; // endTurnNudged: the Stop hook sent it back to call end_turn
};

type Common = { call: Call; said: Said };
type Finals = { finals?: Map<string, string> };

export type ReplyState =
  | ({ kind: 'working' } & Common)
  | ({ kind: 'ended'; owed?: number } & Common & Finals)
  | ({ kind: 'replying' } & Common & Finals)
  | ({ kind: 'reopened'; rewrite?: true; owed?: number } & Common & Finals)
  | ({ kind: 'open'; replyAfter?: true; reopened?: { rewrite?: true } } & Common & Finals)
  | ({ kind: 'odd'; flags: PhaseFlags } & Common);

export type ReplyEvent =
  // `by`: leastAuthority of the turn's endTurnBy and the access now.
  | { kind: 'call'; itemId: string; input: Record<string, unknown>; by: Turn['endTurnBy'] }
  | { kind: 'result'; itemId: string; ok: boolean; text: string }
  | { kind: 'text'; itemId: string; text: string; narration?: true }
  | { kind: 'reasoning'; itemId: string }
  | { kind: 'message' }
  | { kind: 'wakeRead' }
  | { kind: 'nudge'; reopen: boolean; rewrite: boolean };

// What a text or reasoning event becomes, and what a result writes.
export type ReplyOut = {
  // text and reasoning: dropped, or kept as `text` says.
  route?: 'kept' | 'reply' | 'summaryReplaced' | 'owedKept' | 'dropped';
  text?: { itemId: string; text: string; final?: true; narration?: true };
  // reply: its "What I need from you" became the card.
  tookCard?: Needs;
  // result: the headline for the preview (before the result is written),
  // the reply to write again under a reopened turn's card, and the bullets
  // to write as the reply (both after it).
  headline?: string;
  restate?: string;
  summary?: string;
};

export type ReplyMove = { ok: true; state: ReplyState; out: ReplyOut } | { ok: false; reason: string };

// ---- Reading and writing the fields ----

export function replyOf(t: ReplyFields): ReplyState {
  const call: Call = {};
  if (t.endTurn !== undefined) call.input = t.endTurn;
  if (t.endTurnBefore !== undefined) call.before = t.endTurnBefore;
  if (t.endTurnBy !== undefined) call.by = t.endTurnBy;
  if (t.endTurnCall !== undefined) call.itemId = t.endTurnCall;
  const said: Said = {};
  if (t.lastText !== undefined) said.lastText = t.lastText;
  if (t.narrationItem !== undefined) said.narrationItem = t.narrationItem;
  if (t.summarized) said.summarized = true;
  if (t.headline) said.headline = true;
  if (t.replyNeeds !== undefined) said.replyNeeds = t.replyNeeds;
  if (t.endTurnNudged) said.nudged = true;
  const c = { call, said };
  const took = Boolean(t.tookEndTurn), ended = Boolean(t.ended), after = Boolean(t.replyAfter);
  const reopened = Boolean(t.cardReopened), rewrite = Boolean(t.replyRewrite), owed = t.owedReply;
  const fin: Finals = t.finalTexts !== undefined ? { finals: t.finalTexts } : {};
  const ow = owed !== undefined ? { owed } : {};
  if (!took && !ended && !after && !reopened && !rewrite && owed === undefined && t.finalTexts === undefined) return { kind: 'working', ...c };
  if (took && ended && !after && !reopened && !rewrite) return { kind: 'ended', ...ow, ...c, ...fin };
  if (took && ended && after && !reopened && !rewrite && owed === undefined) return { kind: 'replying', ...c, ...fin };
  if (took && ended && !after && reopened) return { kind: 'reopened', ...(rewrite ? { rewrite: true } : {}), ...ow, ...c, ...fin };
  if (took && !ended && owed === undefined && (reopened || !rewrite)) {
    return { kind: 'open', ...(after ? { replyAfter: true } : {}), ...(reopened ? { reopened: rewrite ? { rewrite: true } : {} } : {}), ...c, ...fin };
  }
  const flags: PhaseFlags = {};
  for (const k of ['tookEndTurn', 'ended', 'replyAfter', 'cardReopened', 'replyRewrite', 'owedReply', 'finalTexts'] as const) {
    if (t[k] !== undefined) (flags as Record<string, unknown>)[k] = t[k];
  }
  return { kind: 'odd', flags, ...c };
}

// A state as the Turn's fields: every one of REPLY_FIELDS, undefined where
// it's absent (a flag that's off included).
export function replyFields(s: ReplyState): { [K in ReplyField]: ReplyFields[K] | undefined } {
  const out = Object.fromEntries(REPLY_FIELDS.map((k) => [k, undefined])) as { [K in ReplyField]: ReplyFields[K] | undefined };
  out.endTurn = s.call.input;
  out.endTurnBefore = s.call.before;
  out.endTurnBy = s.call.by;
  out.endTurnCall = s.call.itemId;
  out.lastText = s.said.lastText;
  out.narrationItem = s.said.narrationItem;
  out.summarized = s.said.summarized;
  out.headline = s.said.headline;
  out.replyNeeds = s.said.replyNeeds;
  out.endTurnNudged = s.said.nudged;
  switch (s.kind) {
    case 'working':
      break;
    case 'ended':
      out.tookEndTurn = out.ended = true;
      out.owedReply = s.owed;
      out.finalTexts = s.finals;
      break;
    case 'replying':
      out.tookEndTurn = out.ended = out.replyAfter = true;
      out.finalTexts = s.finals;
      break;
    case 'reopened':
      out.tookEndTurn = out.ended = out.cardReopened = true;
      out.replyRewrite = s.rewrite;
      out.owedReply = s.owed;
      out.finalTexts = s.finals;
      break;
    case 'open':
      out.tookEndTurn = true;
      out.replyAfter = s.replyAfter;
      out.cardReopened = s.reopened ? true : undefined;
      out.replyRewrite = s.reopened?.rewrite;
      out.finalTexts = s.finals;
      break;
    case 'odd':
      Object.assign(out, s.flags);
      break;
    default:
      return unreachable(s);
  }
  return out;
}

// Whether the turn has an accepted end_turn standing: text after it is
// dropped, or is the reply.
function hasEnded(s: ReplyState): s is Extract<ReplyState, { kind: 'ended' | 'replying' | 'reopened' }> {
  return s.kind === 'ended' || s.kind === 'replying' || s.kind === 'reopened';
}

// Text after end_turn is the reply.
function replyAfter(s: ReplyState): boolean {
  return s.kind === 'replying' || (s.kind === 'open' && s.replyAfter === true);
}

// Whether the streamed words of the agent's own text or thinking are
// dropped as they come, like the text they make up (onOutput's delta).
export function dropsStream(t: ReplyFields): boolean {
  const s = replyOf(t);
  return s.kind === 'odd' ? Boolean(t.ended && !t.replyAfter) : hasEnded(s) && !replyAfter(s);
}

// What a completed turn needs from Mike: the "What I need from you" its
// reply had, then its end_turn call, then its last text's section, else
// nothing said (a slash command's turn says nothing without end_turn).
export function turnNeeds(turn: ReplyFields & Pick<Turn, 'command'>): (Needs & { from: 'tool' | 'text' }) | undefined {
  const tool = turn.endTurn && needsFromTool(turn.endTurn);
  // The asks came in the reply, but whether they wait for its jobs was
  // said in the call (from Codex and Gemini's review, 24 Nov).
  if (turn.replyNeeds) return { ...turn.replyNeeds, ...(askWhenFromTool(turn.endTurn) === 'jobsEnd' && turn.replyNeeds.needs === 'you' ? { afterJobs: true as const } : {}), from: 'text' };
  if (tool) return { ...tool, from: 'tool' };
  if (turn.command) return undefined;
  const text = turn.lastText && needsFromText(turn.lastText);
  return text ? { ...text, from: 'text' } : undefined;
}

// ---- The moves ----

// The one place the reply phase moves. Pure.
export function moveReply(s: ReplyState, e: ReplyEvent): ReplyMove {
  if (s.kind === 'odd') return no(`the turn's end_turn fields fit no phase (${JSON.stringify(s.flags)})`);
  switch (e.kind) {
    case 'call':
      return ok({ ...s, call: { input: e.input, before: s.call.input, by: e.by, itemId: e.itemId } });
    case 'result':
      // Only the latest call's result says anything.
      if (e.itemId !== s.call.itemId) return ok(s);
      return result(s, e);
    case 'text':
      return text(s, e);
    case 'reasoning':
      return ok(s, { route: hasEnded(s) && !replyAfter(s) ? 'dropped' : 'kept' });
    case 'message':
      // A new message (steered into the turn, or waiting for the next CLI
      // turn in it) starts a fresh reply phase: any end_turn, card, headline,
      // summary, reply or Stop-hook nudge from before it belonged to the
      // earlier message and mustn't carry into the turn's end (otherwise an
      // answer without a new end_turn inherits needs: "nothing" and never
      // notifies Mike). Only `by` stays: the least access across this turn's
      // end_turn calls.
      return ok({ kind: 'working', call: s.call.by ? { by: s.call.by } : {}, said: {} });
    case 'wakeRead': {
      // Read a background job's notice after an end_turn: the work after it
      // is the turn's latest, so its text is kept and is the preview, and the
      // card taken stands only until the next end_turn.
      if (s.kind === 'working') return ok(s);
      const { summarized: _s, headline: _h, narrationItem: _n, ...said } = s.said;
      const reopened = s.kind === 'reopened' ? { reopened: s.rewrite ? { rewrite: true as const } : {} } : s.kind === 'open' && s.reopened ? { reopened: s.reopened } : {};
      return ok({ kind: 'open', ...(replyAfter(s) ? { replyAfter: true } : {}), ...reopened, call: s.call, said, ...finals(s) });
    }
    case 'nudge': {
      // Sent back for a card under a reply already written: that reply
      // stands, so words from here are dropped like any after end_turn.
      // When nothing is ended (e.g. a message cleared it), a reopen nudge
      // has nothing to reopen and mustn't mark the fresh turn as nudged.
      if (e.reopen) {
        if (!hasEnded(s)) return ok(s);
        const owed = s.kind === 'replying' ? undefined : s.owed;
        return ok({ kind: 'reopened', ...(e.rewrite ? { rewrite: true } : {}), ...(owed !== undefined ? { owed } : {}), call: s.call, said: { ...s.said, nudged: true }, ...finals(s) });
      }
      return ok({ ...s, said: { ...s.said, nudged: true } });
    }
    default:
      return unreachable(e);
  }
}

function result(s: Exclude<ReplyState, { kind: 'odd' }>, e: Extract<ReplyEvent, { kind: 'result' }>): ReplyMove {
  const r = { ok: e.ok, text: e.text };
  const took = s.kind !== 'working';
  // A refused repeat changes nothing: its archive once took effect under a
  // result saying it hadn't. Nor any refusal after one it took (a bad snooze
  // on a repeat once turned an ask into Done), nor one refused for a message
  // it was written without: its arguments are about the turn before that
  // message. A first call refused for anything else stands as the card of a
  // turn that ends with no other.
  if (endTurnRefusedRepeat(r) || endTurnRefusedUnread(r) || (!e.ok && took)) return ok({ ...s, call: { ...s.call, input: s.call.before } });
  // A repeat that only adds archive adds only that. Unless a message came
  // between the call and its result, which turned the archive off.
  if (endTurnAddedArchive(r)) return ok({ ...s, call: { ...s.call, input: { ...s.call.before, archive: s.call.input?.archive === true } } });
  if (endTurnAddedSnooze(r)) return ok({ ...s, call: { ...s.call, input: { ...s.call.before, snooze: s.call.input?.snooze } } });
  if (!endTurnTaken(r)) return ok(s);
  const out: ReplyOut = {};
  const input = s.call.input;
  // The card a reopened turn was sent back for, told "your message above is
  // the reply": the apps take a turn's reply from after its last card, so
  // the reply is written again under it, all of its blocks.
  const fin = s.kind === 'working' ? undefined : s.finals;
  if (s.kind === 'reopened' || (s.kind === 'open' && s.reopened)) {
    if (endTurnMessageStands(r) && fin?.size) out.restate = [...fin.values()].join('\n\n');
  }
  const wants = endTurnWantsReply(r);
  // A reply asked for now is a new one.
  const kept: Finals = !wants && fin !== undefined ? { finals: fin } : {};
  let said = s.said;
  const bullets = endTurnIsOneReply(r) ? undefined : summaryFromTool(input);
  if (bullets) {
    out.summary = summaryMarkdown(bullets);
    said = { ...said, summarized: true, lastText: out.summary };
  }
  if (!endTurnAccepted(r)) {
    // Codex's bullets form, "Noted. Now write your final answer": text after
    // it is ordinary, and an accepted end_turn before it still stands.
    const c = { call: s.call, said };
    if (s.kind === 'working' || s.kind === 'open') return ok({ kind: 'open', ...c, ...kept }, out);
    const owed = s.kind === 'replying' ? undefined : s.owed;
    return ok({ kind: 'ended', ...(owed !== undefined ? { owed } : {}), ...c, ...kept }, out);
  }
  const headline = typeof input?.headline === 'string' ? input.headline.trim() : '';
  if (headline) {
    out.headline = headline;
    said = { ...said, headline: true };
  }
  // A "What I need from you" taken from a reply before a wake stands until now.
  const { replyNeeds: _, ...rest } = said;
  const c = { call: s.call, said: rest };
  if (wants) return ok({ kind: 'replying', ...c, ...kept }, out);
  // Bullets with no message since the last step: the next message is the
  // one they stood for, kept when it says more (0: any, as asked again).
  const owed = !bullets ? undefined : endTurnAsksForMessage(r) ? 0 : endTurnOwesReply(r) ? summaryMarkdown(bullets).length : undefined;
  return ok({ kind: 'ended', ...(owed !== undefined ? { owed } : {}), ...c, ...kept }, out);
}

function text(s: Exclude<ReplyState, { kind: 'odd' }>, e: Extract<ReplyEvent, { kind: 'text' }>): ReplyMove {
  let next: ReplyState = s;
  const out: ReplyOut = {};
  let ev: NonNullable<ReplyOut['text']> = { itemId: e.itemId, text: e.text, ...(e.narration ? { narration: true as const } : {}) };
  if (replyAfter(s)) {
    // One reply: this is the reply. A "What I need from you" section comes
    // off it when end_turn brought no card of its own, and becomes the card
    // (splitReplySection); when end_turn did bring asks, one repeating them
    // just comes off (replyWithoutRepeat).
    const tool = s.call.input ? needsFromTool(s.call.input) : undefined;
    const split = !tool?.asks?.length && !tool?.next?.length ? splitReplySection(e.text) : undefined;
    let said = s.said;
    if (split?.needs) {
      said = { ...said, replyNeeds: split.needs };
      out.tookCard = split.needs;
    }
    const t = split?.needs ? split.reply : tool?.asks?.length ? replyWithoutRepeat(e.text, tool) : e.text;
    ev = { itemId: e.itemId, text: t, final: true, ...(e.narration ? { narration: true as const } : {}) };
    const fin = 'finals' in s ? s.finals : undefined;
    const finalsNow = t.trim() ? new Map(fin ?? []).set(e.itemId, t) : fin;
    next = { ...s, said, ...(finalsNow ? { finals: finalsNow } : {}) } as ReplyState;
    out.route = 'reply';
  } else if (hasEnded(s) && s.said.narrationItem && !s.said.summarized && e.text.trim()) {
    // The reply was a narration block's summary: this is the real message,
    // in the summary's place.
    ev = { itemId: s.said.narrationItem, text: e.text };
    out.route = 'summaryReplaced';
  } else if ((s.kind === 'ended' || s.kind === 'reopened') && s.owed !== undefined && e.text.trim().length > s.owed) {
    // The message the bullets stood for.
    const { owed: _, ...rest } = s;
    next = rest;
    out.route = 'owedKept';
  } else if (hasEnded(s)) {
    return ok(s, { route: 'dropped' });
  } else out.route = 'kept';
  out.text = ev;
  if (!next.said.summarized) next = { ...next, said: { ...without(next.said, 'narrationItem'), lastText: ev.text, ...(ev.narration ? { narrationItem: ev.itemId } : {}) } };
  return ok(next, out);
}

// Writes an event's move onto the Turn: the one writer of REPLY_FIELDS. Only
// fields that change are touched. A refused move leaves the Turn as it was
// and says why.
export function replyTurn(turn: Turn, e: ReplyEvent): ReplyMove {
  const res = moveReply(replyOf(turn), e);
  if (!res.ok) return res;
  const fields = replyFields(res.state);
  const out = turn as Record<string, unknown>;
  for (const k of REPLY_FIELDS) {
    const v = fields[k];
    if (v === undefined) {
      if (k in out) delete out[k];
    } else if (out[k] !== v) out[k] = v;
  }
  return res;
}

// ---- Helpers ----

function finals(s: ReplyState): Finals {
  return 'finals' in s && s.finals !== undefined ? { finals: s.finals } : {};
}

function without<K extends keyof Said>(said: Said, k: K): Said {
  const out = { ...said };
  delete out[k];
  return out;
}

function ok(state: ReplyState, out: ReplyOut = {}): ReplyMove {
  return { ok: true, state, out };
}

function no(reason: string): ReplyMove {
  return { ok: false, reason };
}

function unreachable(x: never): never {
  throw new Error(`Unknown reply event or state: ${JSON.stringify(x)}`);
}
