// A thread as the Mac and the iPhone show it once its turns are over: the
// message that started a turn, one "Worked for 2m 13s" line holding the
// work, then the reply. A port of the iPhone's Turns.fold
// (ios/ThreadbearKit/Sources/ThreadbearKit/Turns.swift); keep the two
// picking the same reply. Tests: node --test web/src/turns.test.ts
import type { MessageButton } from './reply-buttons';

export type TurnMessage = {
  seq: number;
  // "note": the line a thread writes when its login runs out and it moves
  // to another or waits for room (backend API 79, asked for with `notes`).
  role: 'user' | 'assistant' | 'tool' | 'note';
  text: string;
  origin?: string;
  toolKind?: string;
  summary?: boolean;
  // A Plan first plan in full (API 72).
  plan?: boolean;
  // Go ahead or Send back, once the plan's card is answered (API 76).
  planDecision?: 'go' | 'revise';
  turn?: string;
  // On the first row of a turn the agent started by itself: the sub-agents
  // and jobs whose finishing woke it (API 33).
  wokeBy?: WokeTask[];
  // Why the runner sent its own message (origin "runner"), a few words:
  // "Codex answered" (API 98).
  wakeReason?: string;
  // The reply buttons its text links (API 59, reply-buttons.ts).
  buttons?: MessageButton[];
  at: string;
};

export type WokeTask = { kind: string; description: string };

// The wait before a turn the agent started by itself, or the runner's own
// message did with its reason: "6 min later · Mine the repo finished",
// "Moments later · Codex answered". The iPhone's TurnGap
// (ios/ThreadbearKit/Sources/ThreadbearKit/TurnGap.swift), from the Mac's.
export type TurnGap = { seq: number; from: string; to: string; wokeBy: WokeTask[]; runnerWake?: string };

export type Item<M extends TurnMessage = TurnMessage> =
  | { kind: 'message'; m: M }
  | { kind: 'tools'; items: M[] }
  | { kind: 'worked'; items: Item<M>[]; ms?: number; key: number }
  // The divider before a turn the agent woke up for (gapLabel).
  | { kind: 'gap'; gap: TurnGap }
  // A login's note: a quiet line of its own, never folded into the work.
  | { kind: 'note'; m: M };

export function isNote(m: TurnMessage): boolean {
  return m.role === 'note';
}

// Tool calls between two messages go together as one run.
export function group<M extends TurnMessage>(messages: M[]): Item<M>[] {
  const out: Item<M>[] = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (m.role === 'tool') {
      if (last?.kind === 'tools') last.items.push(m);
      else out.push({ kind: 'tools', items: [m] });
    } else out.push({ kind: 'message', m });
  }
  return out;
}

// A turn starts at a message from Mike, the phone, a schedule or another
// agent; one the runner sent (a restart, a resume) joins the turn before it.
export function startsTurn(m: TurnMessage): boolean {
  return m.role === 'user' && m.origin !== 'runner';
}

// A thread's items, with each login's note where it happened: after what
// was on show before it and before the first reply after it. The notes are
// taken out first, so a turn folds and picks its reply as if they weren't
// there (nothing else here knows the role), as the Mac keeps them out of
// its line of work.
export function fold<M extends TurnMessage>(messages: M[], busy: boolean): Item<M>[] {
  const notes = messages.filter(isNote);
  if (!notes.length) return foldTurns(messages, busy);
  const out = foldTurns(messages.filter((m) => !isNote(m)), busy);
  for (const m of notes) {
    const at = out.findIndex((item) => (placedSeq(item) ?? -Infinity) > m.seq);
    out.splice(at < 0 ? out.length : at, 0, { kind: 'note', m });
  }
  return out;
}

// Where an item sits among the thread's rows, for placing a note. A turn's
// folded work has no place of its own: its line goes above the turn's
// replies whichever rows it holds, so a login that ran out before doing
// anything put the note above the limit's own words, by the work that came
// after (Codex's review, 13 Nov). The note goes by the messages instead.
function placedSeq(item: Item): number | undefined {
  if (item.kind === 'worked') return undefined;
  if (item.kind === 'gap') return item.gap.seq;
  if (item.kind === 'tools') return item.items[0]?.seq;
  return item.m.seq;
}

function foldTurns<M extends TurnMessage>(messages: M[], busy: boolean): Item<M>[] {
  const turns: M[][] = [[]];
  for (const m of messages) {
    if (startsTurn(m) && turns.at(-1)!.length) turns.push([]);
    turns.at(-1)!.push(m);
  }
  const out: Item<M>[] = [];
  turns.forEach((turn, i) => {
    if (!turn.length) return;
    const starter = startsTurn(turn[0]!) ? turn[0]! : undefined;
    const body = starter ? turn.slice(1) : turn;
    if (starter) out.push({ kind: 'message', m: starter });
    // The turn still going shows its work as it comes.
    if (busy && i === turns.length - 1) {
      out.push(...shownWhole(body));
      return;
    }
    // A plan stays out of the fold wherever it is in the turn, as on the
    // phone: it's what Go ahead approves, and a sent-back one is what Mike
    // asked to change.
    const replyOnly = replies(body);
    const reply = replyOnly.length ? [...new Set([...replyOnly, ...body.flatMap((m, j) => (m.plan ? [j] : []))])] : [];
    if (!reply.length) {
      out.push(...shownWhole(body));
      return;
    }
    const keep = new Set(reply);
    const folded = body.filter((_, j) => !keep.has(j));
    // Nothing to fold (a quick answer, no tools): just the reply.
    if (folded.some((m) => m.role === 'tool' || m.role === 'assistant')) {
      const end = Date.parse(body[Math.max(...reply)]!.at);
      const ms = starter ? end - Date.parse(starter.at) : undefined;
      out.push({ kind: 'worked', items: group(folded), ms, key: folded[0]!.seq });
    } else out.push(...group(folded));
    // A wait between two of the replies gets its divider before the reply after it.
    const walls = dividers(body, new Set(reply));
    const placed = new Set<number>();
    for (const j of [...reply].sort((a, b) => a - b)) {
      const k = Math.max(-1, ...[...walls.keys()].filter((w) => w <= j));
      if (k >= 0 && !placed.has(k)) {
        placed.add(k);
        out.push({ kind: 'gap', gap: walls.get(k)! });
      }
      out.push({ kind: 'message', m: body[j]! });
    }
  });
  return out;
}

// A stretch shown as it is, every row, with a divider before each turn the
// agent woke up for.
function shownWhole<M extends TurnMessage>(body: M[]): Item<M>[] {
  const walls = dividers(body, new Set(body.keys()));
  const out: Item<M>[] = [];
  let start = 0;
  for (const k of [...walls.keys()].sort((a, b) => a - b)) {
    out.push(...group(body.slice(start, k)), { kind: 'gap', gap: walls.get(k)! });
    start = k;
  }
  return [...out, ...group(body.slice(start))];
}

// Why the runner sent this message of its own, when it says.
function runnerWake(m: TurnMessage): string | undefined {
  if (m.role !== 'user' || m.origin !== 'runner') return undefined;
  return m.wakeReason?.trim() || undefined;
}

// The wait before each turn in a stretch the agent started by itself (no
// message starts it), or the runner's own message did with its reason (API
// 98), by the index of its first row: from the row before to that one. Rows
// from before API 26 have no turn, so there are none.
function waits(body: TurnMessage[]): Map<number, TurnGap> {
  const out = new Map<number, TurnGap>();
  let i = 1;
  while (i < body.length) {
    const m = body[i]!;
    const why = runnerWake(m);
    if (m.turn === undefined || m.turn === body[i - 1]!.turn || (m.role === 'user' && !why)) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < body.length && body[end]!.turn === m.turn && body[end]!.role !== 'user') end++;
    const woke = body.slice(i, end).find((r) => r.wokeBy)?.wokeBy ?? [];
    out.set(i, { seq: m.seq, from: body[i - 1]!.at, to: m.at, wokeBy: woke, ...(why ? { runnerWake: why } : {}) });
    i = end;
  }
  return out;
}

// The waits that get a divider, as the Mac picks them: only one with
// something shown above and below it. Waits with nothing shown between
// them are one divider, from the first one's start to the last one's end.
function dividers(body: TurnMessage[], shown: Set<number>): Map<number, TurnGap> {
  const gaps = waits(body);
  const out = new Map<number, TurnGap>();
  let shownBefore = false;
  let waiting: [number, TurnGap] | undefined;
  for (let k = 0; k < body.length; k++) {
    const gap = gaps.get(k);
    if (gap && shownBefore) {
      const earlier = waiting?.[1];
      const runner = gap.runnerWake ?? earlier?.runnerWake;
      waiting = earlier ? [k, { seq: gap.seq, from: earlier.from, to: gap.to, wokeBy: [...earlier.wokeBy, ...gap.wokeBy], ...(runner ? { runnerWake: runner } : {}) }] : [k, gap];
    }
    if (!shown.has(k) || body[k]!.role === 'user') continue;
    if (waiting) out.set(waiting[0], waiting[1]);
    waiting = undefined;
    shownBefore = true;
  }
  return out;
}

// "6 min later · Mine the repo finished", as the Mac says it.
export function gapLabel(gap: TurnGap): string {
  // A time that won't parse is no time at all, as on the Mac, never "NaN days" (Gemini's review).
  const span = Date.parse(gap.to) - Date.parse(gap.from);
  const time = later(Number.isFinite(span) ? Math.max(0, span) / 1000 : 0);
  const cause = gap.runnerWake?.trim() || wakeCause(gap.wokeBy);
  return cause ? `${time} · ${cause}` : time;
}

function later(interval: number): string {
  const seconds = Math.round(interval);
  if (seconds < 60) return seconds < 2 ? 'Moments later' : `${seconds}s later`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min later`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} h later` : `${hours} h ${rest} min later`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'A day later' : `${days} days later`;
}

// Sub-agents are named over the shells they ran, as on the Mac.
function wakeCause(tasks: WokeTask[]): string | undefined {
  if (!tasks.length) return undefined;
  const agents = tasks.filter((t) => t.kind === 'agent');
  const shown = agents.length ? agents : tasks;
  const names = shown.map((t) => t.description.trim()).filter(Boolean);
  const noun = agents.length ? 'sub-agent' : 'background job';
  if (!names.length) return shown.length === 1 ? `A ${noun} finished` : `${shown.length} ${noun}s finished`;
  if (names.length === 1 && shown.length === 1) return `${names[0]} finished`;
  if (names.length === 2 && shown.length === 2) return `${names[0]} and ${names[1]} finished`;
  return `${names[0]} and ${shown.length - 1} more finished`;
}

// Which of a finished stretch's messages are its replies, as the Mac picks
// them: each turn has its own, so one the runner or the CLI started doesn't
// fold away the answer before it, unless a summary covers them. A summary
// from a wake-up doesn't.
export function replies(body: TurnMessage[]): number[] {
  const turns: [number, number][] = [];
  let start = 0;
  for (let i = 1; i < body.length; i++) {
    const newTurn = body[i]!.turn !== undefined && body[i]!.turn !== body[i - 1]!.turn;
    if (body[i]!.role === 'user' || newTurn) {
      turns.push([start, i]);
      start = i;
    }
  }
  if (body.length) turns.push([start, body.length]);
  let covers = -1;
  turns.forEach(([a, b], k) => {
    const wakeUp = a > 0 && body[a]!.role !== 'user';
    if (!wakeUp && body.slice(a, b).some((m) => m.role === 'assistant' && m.summary)) covers = k;
  });
  return turns.slice(Math.max(0, covers)).flatMap(([a, b]) => replyIndexes(body.slice(a, b)).map((j) => j + a));
}

// A finished turn's reply: the messages after its last step (and before
// the summary) when they say more than the summary's bullets; else the
// bullets; else the last thing the agent wrote.
export function replyIndexes(body: TurnMessage[]): number[] {
  const summary = lastIndex(body, (m) => m.role === 'assistant' && !!m.summary);
  const lastStep = lastIndex(body, isStep);
  if (summary >= 0 && lastStep < summary) {
    const words: number[] = [];
    for (let j = lastStep + 1; j < summary; j++) if (body[j]!.role === 'assistant' && !body[j]!.summary) words.push(j);
    const tail: number[] = [];
    for (let j = summary + 1; j < body.length; j++) if (body[j]!.role === 'assistant' && !body[j]!.summary) tail.push(j);
    const length = words.reduce((n, j) => n + body[j]!.text.length, 0);
    const base = length > body[summary]!.text.length ? words : [summary];
    return [...base, ...tail];
  }
  const last = lastIndex(body, (m) => m.role === 'assistant');
  return last >= 0 ? [last] : [];
}

// A step of work: a tool call outside Threadbear's own tools and
// ToolSearch, or a message sent into the turn.
function isStep(m: TurnMessage): boolean {
  if (m.role === 'user') return true;
  if (m.role === 'assistant') return false;
  return !(m.text.startsWith('threadbear: ') || m.text.startsWith('Find tools: '));
}

function lastIndex<T>(xs: T[], f: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i]!)) return i;
  return -1;
}

// "Worked for 2m 13s", as the Mac says it.
export function workedTitle(ms?: number): string {
  if (ms === undefined || ms < 1000) return 'Worked';
  return `Worked for ${duration(ms)}`;
}

export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 === 0 ? `${s / 60}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 3600)}h ${m}m`;
}

// To the minute, for the shared page's byline: "18m", "1h 5m".
export function roughly(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// The turns of a thread, for the shared page's outline: each starts at a
// message that starts a turn, and runs to the next. Time worked is from
// that message to the last one before the next turn.
export type Turn<M extends TurnMessage = TurnMessage> = { starter?: M; messages: M[]; ms?: number };

export function splitTurns<M extends TurnMessage>(messages: M[]): Turn<M>[] {
  const out: Turn<M>[] = [];
  for (const m of messages) {
    if (startsTurn(m) || !out.length) out.push({ starter: startsTurn(m) ? m : undefined, messages: [] });
    out.at(-1)!.messages.push(m);
  }
  for (const t of out) {
    // To the last thing said, as fold times a turn to its reply, not to a
    // tool line after it (end_turn).
    const last = [...t.messages].reverse().find((m) => m.role !== 'tool' && m.role !== 'note');
    if (t.starter && last && last !== t.starter) t.ms = Date.parse(last.at) - Date.parse(t.starter.at);
  }
  return out;
}
