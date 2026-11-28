// What a finished turn needs from Mike (docs/protocol/needs-you.md, "Needs you"):
// the agent's end_turn call, or failing that the "What I need from you"
// section his own instructions ask every agent to end with. No model call:
// the agent that did the work is the one that knows.

import { sentByAgent, type Ask, type AskLink, type NeedsWho, type OpenAsk, type PersistedEvent } from './protocol.ts';
import { hasLineBreak, replaceLinks } from './linear-text.ts';
import { cutSafely, safeEnd } from './safe-cut.ts';
import { MAX_NAMED_RUNS, namedRun, type NamedRun, type RunsWait } from './ci-runs.ts';

// afterJobs: the asks wait until the thread's own shell jobs end (askWhen
// "jobsEnd"; docs/protocol/needs-you.md, "Needs you").
export type Needs = { needs: NeedsWho; asks?: Ask[]; next?: string[]; nextPick?: 'one'; nextSuggested?: number; afterJobs?: true };

export const END_TURN_TOOL = 'end_turn';
// As the CLIs name it: under threadbear-mcp.ts's SERVER_NAME, which lives
// here too so the adapters needn't import the server.
export const END_TURN_FULL_NAME = `mcp__threadbear__${END_TURN_TOOL}`;

// The wire card can start with some items ticked. In the live record
// keep those separately so a later untick can clear them.
export function openAskState(asks: OpenAsk[]): { asks: Ask[]; ticked?: number[] } {
  const ticked: number[] = [];
  const clean = asks.map(({ ticked: checked, ...ask }, index) => {
    if (checked) ticked.push(index);
    return ask;
  });
  return { asks: clean, ...(ticked.length ? { ticked } : {}) };
}

// Big enough for any real list; an agent that sends more is rambling.
export const MAX_ASKS = 10;
const MAX_ACTION = 500;
const MAX_SHORT = 200;
// A decision with more than this many choices is better as a question.
const MAX_OPTIONS = 6;
// A button or two to go and do the thing; past three it's a reading list.
const MAX_LINKS = 3;
const MAX_URL = 2000;
// Follow-ups on the done card: a few buttons, each a short message.
const MAX_NEXT = 3;
const MAX_NEXT_CHARS = 120;
// Web pages, paths on this Mac, and review:<id>, which opens one of the
// thread's show_options reviews (Mike, 30 Oct: "Watch A" opened the video
// but nothing opened the stills to compare). Anything else (javascript:,
// other schemes) isn't something a button should open. And thread:<id>, for
// an ask whose step is in another thread: on 17 Nov one said "Pick a
// direction ... in its own thread" with nothing to tap, and the phone had no
// way there.
const LINK_URL = /^(?:https?:\/\/|file:\/\/|\/|~\/|(?:review|thread):[\w-]+$)/i;

// Which form of end_turn a call was written for, when it shows. A Codex
// thread's tool list is fixed when it starts, so its agent may have the form
// from before One reply changed, whatever the setting says now (docs/protocol.md).
// An ask's own field comes first: a call with both, as an agent writes when
// correcting itself, has its asks in that form.
export function endTurnForm(input: unknown): 'oneReply' | 'bullets' | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  const asks: unknown[] = Array.isArray(o.asks) ? o.asks : [];
  const has = (key: string) => asks.some((a) => a !== null && typeof a === 'object' && key in a);
  if (has('question')) return 'oneReply';
  if (has('action') || has('why')) return 'bullets';
  if (o.summary !== undefined) return 'bullets';
  if (o.headline !== undefined) return 'oneReply';
  return undefined;
}

// end_turn's input, checked. Undefined when it isn't usable, so the turn
// falls back to the text.
export function needsFromTool(input: unknown): Needs | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  // Left out, it comes from the asks: agents filling in a summary forgot
  // it 2 times in 9 (29 Oct 2026). Anything else is a call to ignore.
  if (o.needs !== undefined && o.needs !== 'you' && o.needs !== 'nothing') return undefined;
  if (o.needs === 'nothing') return done(o.next, o.nextPick, o.nextSuggested);
  const asks: Ask[] = [];
  for (const a of Array.isArray(o.asks) ? o.asks : []) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    // One reply (docs/protocol/needs-you.md, "One reply") asks a question and has no
    // why; the card shows it as the ask's paragraph, so it's the action.
    const action = clipText(r.action, MAX_ACTION) ?? clipText(r.question, MAX_ACTION);
    if (!action) continue;
    const ask: Ask = { action };
    const taskId = str(r.taskId, 100);
    if (taskId) ask.taskId = taskId;
    const where = str(r.where, MAX_SHORT);
    if (where) ask.where = where;
    const reply = str(r.reply, MAX_SHORT);
    if (reply) ask.reply = reply;
    const why = clipText(r.why, MAX_ACTION);
    if (why) ask.why = why;
    // An answer is a label, or with one reply { label, does }: does says
    // what happens if Mike picks it, drawn under its label on the card.
    const answers = (Array.isArray(r.options) ? r.options : [])
      .map((o) => (o && typeof o === 'object' ? { label: str((o as Record<string, unknown>).label, MAX_SHORT), does: clipText((o as Record<string, unknown>).does, MAX_SHORT) } : { label: str(o, MAX_SHORT), does: undefined }))
      .filter((o): o is { label: string; does: string | undefined } => !!o.label)
      .slice(0, MAX_OPTIONS);
    const options = answers.map((o) => o.label);
    if (options.length) {
      ask.options = options;
      if (answers.some((o) => o.does)) ask.optionNotes = answers.map((o) => o.does ?? '');
      else {
        // The older form told agents to end why with the choices as a list,
        // so they wrote each option twice: a bullet in the text ("Followers
        // only (simplest)", "... (my pick)") and a bare button. Mike, 17 Nov
        // 2026 (thread 95e13589): the card didn't look like the usual one,
        // with what each does under its button and the pick marked. A list
        // that matches the buttons one for one becomes their notes.
        const field = ask.why !== undefined ? 'why' : 'action';
        const moved = optionNotesFromList(ask[field] ?? '', options);
        if (moved) {
          ask.optionNotes = moved.notes;
          if (moved.text) ask[field] = moved.text;
          else if (field === 'why') delete ask.why;
        }
      }
      // Only an index that points at one of them; anything else is no pick.
      const s = r.suggested;
      if (typeof s === 'number' && Number.isInteger(s) && s >= 0 && s < options.length) ask.suggested = s;
    }
    const links = linksFrom(r.links);
    if (links.length) ask.links = links;
    asks.push(ask);
    if (asks.length === MAX_ASKS) break;
  }
  if (o.needs === undefined && !asks.length) return done(o.next, o.nextPick, o.nextSuggested);
  const you: Needs = asks.length ? { needs: 'you', asks } : { needs: 'you' };
  if (askWhenFromTool(o) === 'jobsEnd') you.afterJobs = true;
  return you;
}

// end_turn's askWhen: whether asks made while a shell job of the thread's
// own is still running wait for it ("jobsEnd") or go to the user at once
// ("now"). Left out, they go at once, as they did before 24 Nov 2026.
export function askWhenFromTool(input: unknown): 'now' | 'jobsEnd' | undefined {
  const w = input && typeof input === 'object' ? (input as Record<string, unknown>).askWhen : undefined;
  return w === 'now' || w === 'jobsEnd' ? w : undefined;
}

// What end_turn says, once a turn, to asks made while a shell job of the
// thread's own is still running and the call doesn't say which it is. Mike,
// 24 Nov 2026: a thread that wrote "it's landing now, I'll confirm here once
// it's on main" also asked him about a PR, so it sat in his Inbox with its
// landing still going, and he'd asked for threads to stay out of it until
// they've finished about ten times. The runner can't tell that job from one
// he needs while he answers (a dev server) or one watching for him to do the
// step (the SD card watcher, 1 Nov), so the agent says.
export const JOBS_NUDGE = 'Not ended: you are asking the user something while a background job of yours is still running';
export function jobsNudge(jobs: string[]): string {
  const which = jobs.slice(0, 3).map((j) => `"${cutSafely(j, 80)}"`).join(', ');
  return `${JOBS_NUDGE} (${which}). Call end_turn again with askWhen: "jobsEnd" if the job has to finish before this thread is ready for them (a landing, a build, a check you are waiting on): the thread stays under Running, out of their inbox, and you get a turn when the job ends, where you end with the asks again. Use askWhen: "now" if they should be asked while it runs (a dev server they need for it, a job watching for them to do the step). This note comes once a turn.`;
}
export function jobsNudged(events: PersistedEvent[]): boolean {
  return nudgedSince(events, JOBS_NUDGE);
}

// What end_turn says, once a turn, to a turn ending with nothing for the
// user when the turn before held asks back for a job (askWhen "jobsEnd")
// that he never saw: the turn the job's end opens tends to report the job
// ("Landed") and nothing else, and its card replaces the held one (Codex
// and Gemini's review, 24 Nov 2026).
export const HELD_NUDGE = 'Not ended: last turn you held asks back until your job ended, and the user has not seen them';
export function heldNudge(asks: string[]): string {
  const which = asks.slice(0, 5).map((a) => `"${cutSafely(a, 100)}"`).join(', ');
  return `${HELD_NUDGE} (${which}). If they still stand, end with them again as asks. If they are answered or no longer apply, call end_turn again as you were: this note comes once a turn.`;
}
export function heldNudged(events: PersistedEvent[]): boolean {
  return nudgedSince(events, HELD_NUDGE);
}

// Words worth matching on: lower case, three letters or more, so "a", "an"
// and "to" don't tie a bullet to the wrong button.
function matchWords(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []);
}

// A pick said in words, which the card marks itself from suggested.
const PICK_NOTE = /\s*\((?:my pick|my recommendation|recommended|suggested)\)\s*/gi;

// The trailing markdown list in an ask's text, when it has one line per
// option and each line shares words with a different option: the text
// without it, and the lines in the options' order as their notes. Undefined
// when it isn't clearly the options again (several questions, a list of
// steps), so that list stays where the agent put it.
export function optionNotesFromList(text: string, options: string[]): { text: string; notes: string[] } | undefined {
  const lines = text.replace(/\s+$/, '').split('\n');
  let start = lines.length;
  while (start > 0 && /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(lines[start - 1])) start--;
  const items = lines.slice(start).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim());
  if (items.length !== options.length || items.length < 2) return undefined;
  const optionWords = options.map(matchWords);
  const itemWords = items.map((i) => matchWords(i.replace(PICK_NOTE, ' ')));
  const pairs: { item: number; option: number; score: number }[] = [];
  itemWords.forEach((w, item) =>
    optionWords.forEach((o, option) => {
      const score = [...o].filter((x) => w.has(x)).length;
      if (score > 0) pairs.push({ item, option, score });
    }),
  );
  // Best overlaps first; every option needs a line of its own, or it's not
  // clearly a restatement.
  pairs.sort((a, b) => b.score - a.score);
  const notes: (string | undefined)[] = options.map(() => undefined);
  const used = new Set<number>();
  for (const p of pairs) {
    if (notes[p.option] !== undefined || used.has(p.item)) continue;
    notes[p.option] = items[p.item].replace(PICK_NOTE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SHORT);
    used.add(p.item);
  }
  if (notes.some((n) => !n)) return undefined;
  return { text: lines.slice(0, start).join('\n').trim(), notes: notes as string[] };
}

// A turn that needs nothing, with any follow-ups it suggested: the done
// card's buttons (docs/protocol/needs-you.md, "Next steps"). Only here, as a card
// of asks already has its own buttons.
function done(v: unknown, pick?: unknown, suggested?: unknown): Needs {
  const seen = new Map<string, number>();
  const next: string[] = [];
  let mappedSuggested: number | undefined;
  const raw = Array.isArray(v) ? v : [];
  for (let i = 0; i < raw.length; i++) {
    const t = clipText(raw[i], MAX_NEXT_CHARS);
    if (!t) continue;
    let idx = seen.get(t);
    if (idx === undefined) {
      if (next.length === MAX_NEXT) continue;
      idx = next.length;
      seen.set(t, idx);
      next.push(t);
    }
    if (typeof suggested === 'number' && Number.isInteger(suggested) && suggested === i) {
      mappedSuggested = idx;
    }
  }
  if (!next.length) return { needs: 'nothing' };
  const out: Needs = { needs: 'nothing', next };
  if (pick === 'one' && next.length > 1) {
    out.nextPick = 'one';
    if (mappedSuggested !== undefined) out.nextSuggested = mappedSuggested;
  }
  return out;
}

// end_turn took `open` from 11 to 13 Nov 2026: lines the agent wrote for
// the done card's "Still open" list, for what it was waiting on that the
// runner can't see. Of the 14 on Mike's cards on 13 Nov none gave him
// anything to do or click ("Geoff putting the portal and lights pieces
// into the next newsletter"): nine were the thread's own job still going,
// which the runner knows (loose-ends.ts, runningLooseEnds), and the rest
// waited on other people. So the card lists only what the runner checked.
// A session from before still has the argument: its lines are dropped,
// and it's told where they go instead.
export function droppedOpenLines(input: unknown): boolean {
  const open = input && typeof input === 'object' ? (input as Record<string, unknown>).open : undefined;
  return Array.isArray(open) && open.some((l) => typeof l === 'string' && l.trim() !== '');
}

export const OPEN_GONE = ' Your "open" lines aren\'t shown any more: say them in your reply instead. If there\'s more for you to do once someone answers, call end_turn again with snooze.';

// Big enough for any turn's story; past this it's the working again.
const MAX_SUMMARY = 8;
const MAX_BULLET = 400;

// end_turn's summary bullets, tidied (docs/protocol/needs-you.md, "The summary"),
// or undefined when there are none, so the turn's own text is its reply.
export function summaryFromTool(input: unknown): string[] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>).summary;
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const b of v) {
    // The app draws them as a list, so a bullet of its own would be doubled.
    const t = typeof b === 'string' ? b.trim().replace(/^[-*•]\s+/, '').trim() : '';
    if (t) out.push(cutSafely(t, MAX_BULLET));
    if (out.length === MAX_SUMMARY) break;
  }
  return out.length ? out : undefined;
}

// The summary as the reply's text: a markdown list, one bullet a line.
export function summaryMarkdown(bullets: string[]): string {
  return bullets.map((b) => `- ${b}`).join('\n');
}

// Whether end_turn asked for its thread to be archived once the turn is
// over. Only with needs "nothing": a thread that's waiting on Mike has to
// stay where he'll see it.
export function archiveFromTool(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const o = input as Record<string, unknown>;
  return o.archive === true && needsFromTool(input)?.needs === 'nothing';
}

// When end_turn asked for its thread to hibernate once the turn is over:
// update_thread's times ("2h", "tomorrow", an ISO time, "restart"), or
// words like "when the phone arrives", read as Hibernate in words reads
// Mike's (wake-when.ts). Like archive, only with needs "nothing", as a
// hibernating thread would hide a card waiting on him. A thread can't
// snooze itself mid-turn, as that stops the CLI, so on 2 Nov 2026 "let's
// hibernate this thread until it arrives" took a helper thread.
export function snoozeFromTool(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const s = (input as Record<string, unknown>).snooze;
  if (typeof s !== 'string' || !s.trim() || s.trim().toLowerCase() === 'off') return undefined;
  return needsFromTool(input)?.needs === 'nothing' ? s.trim() : undefined;
}

// end_turn's waitFor: the threads this one hibernates until they finish
// (runner/hibernation.ts, waitOn). Like snooze, only with needs "nothing".
export const MAX_WAIT_FOR = 5;
// Each is a thread id, or { thread, until } to wait until it has done
// something in particular, which the librarian judges (librarian.ts, met).
export const MAX_UNTIL = 200;
export type WaitFor = { id: string; until?: string };
export function waitForFromTool(input: unknown): WaitFor[] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const w = (input as Record<string, unknown>).waitFor;
  if (!Array.isArray(w)) return undefined;
  const out: WaitFor[] = [];
  for (const x of w) {
    const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : undefined;
    const id = (typeof x === 'string' ? x : typeof o?.thread === 'string' ? o.thread : '').trim();
    const until = typeof o?.until === 'string' ? cutSafely(o.until.replace(/\s+/g, ' ').trim(), MAX_UNTIL) : '';
    if (!id || out.some((y) => y.id === id)) continue;
    out.push(until ? { id, until } : { id });
    if (out.length === MAX_WAIT_FOR) break;
  }
  return out.length && needsFromTool(input)?.needs === 'nothing' ? out : undefined;
}

// end_turn's waitForRuns: hibernates until GitHub workflow runs finish
// (runner/ci-runs.ts, waitRuns). true for the thread's own runs, or a list
// of runs by link, id or { run, repo }. Like waitFor, only with needs
// "nothing"; entries it can't read are dropped (the tool refused them first).
export function runsFromTool(input: unknown): RunsWait | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const w = (input as Record<string, unknown>).waitForRuns;
  if (needsFromTool(input)?.needs !== 'nothing') return undefined;
  if (w === true) return { mine: true };
  if (!Array.isArray(w)) return undefined;
  const runs: NamedRun[] = [];
  for (const x of w.slice(0, MAX_NAMED_RUNS)) {
    const n = namedRun(x);
    if (typeof n !== 'string' && !runs.some((y) => y.id === n.id && y.repo === n.repo)) runs.push(n);
  }
  return runs.length ? { runs } : undefined;
}

// end_turn's byline: a few words for the row of a thread Mike didn't start.
export const MAX_BYLINE = 80;
export function bylineFromTool(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>).byline;
  if (typeof v !== 'string') return undefined;
  return cutSafely(v.replace(/\s+/g, ' ').trim(), MAX_BYLINE) || undefined;
}

function linksFrom(v: unknown): AskLink[] {
  const out: AskLink[] = [];
  for (const l of Array.isArray(v) ? v : []) {
    if (!l || typeof l !== 'object') continue;
    const r = l as Record<string, unknown>;
    const title = str(r.title, MAX_SHORT);
    const url = str(r.url, MAX_URL);
    if (!title || !url || !LINK_URL.test(url)) continue;
    out.push({ title, url });
    if (out.length === MAX_LINKS) break;
  }
  return out;
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? cutSafely(t, max) : undefined;
}

// Words Mike reads on the card, kept to max but cut at a word with an
// ellipsis, never mid-word: a why cut at 500 characters ended "though you
// m" on 31 Oct 2026, and he couldn't tell it was cut.
function clipText(v: unknown, max: number): string | undefined {
  const t = str(v, Number.MAX_SAFE_INTEGER);
  if (!t || t.length <= max) return t;
  const end = safeEnd(t, max - 1);
  const space = t.lastIndexOf(' ', end - 1);
  // Back to a word's end is a cut too, and may be inside a value with a space in it.
  const at = space > max * 0.6 ? safeEnd(t, space) : end;
  // Taking punctuation off is a cut too (a known value can end in a full stop).
  const tidy = t.slice(0, at).replace(/[\s,;:.-]+$/, '').length;
  return `${t.slice(0, safeEnd(t, tidy))}…`;
}

// These read a model's reply, which content it read can steer, so none of
// them may backtrack: no two runs of whitespace side by side with only
// optional marks between, and a line's rest taken with `[\s\S]*`, which
// can't fail, rather than `.*$`, which a lone \r or U+2028 made fail after
// trying every split. "What I need from you" then a few thousand spaces and
// a full stop took minutes to hours (Gautam's scan, F26). headingOf and
// itemOf say no where `.*$` did, so the answers are the same.
//
// The heading starts a line, in bold or as a # heading (a plain mention in
// a sentence isn't one), with a colon either side of the ** or none.
// Text after it on the same line ("**What I need from you:** nothing right
// now") is the section's first line.
const HEADING = /^\s*(#{1,6}\s+)?(?:(\*\*)\s*)?What I need from you\s*:?\s*(\*\*)?\s*:?\s*([\s\S]*)/i;
// Without a heading, a closing "Nothing needed from you right now" says it.
const NOTHING_LINE = /(?:^\**\s*|[.!]\s+(?:\*+\s*)?|\band\s+(?:\*+\s*)?)nothing (?:else )?(?:is )?needed from you\b/i;
const ITEM = /^(\s*)(\d{1,2}[.)]|[-*•])\s+([\s\S]*)/;
const headingOf = (line: string) => noBreakInRest(HEADING.exec(line), 4);
const itemOf = (line: string) => noBreakInRest(ITEM.exec(line), 3);
function noBreakInRest(m: RegExpExecArray | null, rest: number): RegExpExecArray | null {
  return m && !hasLineBreak(m[rest]) ? m : null;
}
const NOTHING = /\bnothing\b(?:[^.\n]{0,40}\b(?:needed|from you|for you to do)\b|\s+(?:right now|for now|yet)\b)/i;
// How far from the end the heading may be: agents sometimes quote it
// earlier in a message, and the real one closes it.
const NEAR_END_LINES = 40;

// The section in a final message, or undefined when there isn't one.
export function needsFromText(text: string): Needs | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let at = -1;
  let first = '';
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - NEAR_END_LINES; i--) {
    const m = headingOf(lines[i]);
    if (m && ((m[2] && m[3]) || (m[1] && !m[2]))) {
      at = i;
      first = m[4].trim();
      break;
    }
  }
  if (at < 0) {
    const tail = lines.slice(-NEAR_END_LINES);
    const i = tail.findIndex((l) => NOTHING_LINE.test(l));
    return i < 0 ? undefined : done(nextFromList(tail.slice(i + 1)));
  }
  const body = lines.slice(at + 1);
  const items: string[] = [];
  const prose: string[] = first ? [first] : [];
  let inItem = false;
  let inFence = false;
  // The list's own kind (numbered or bulleted) and indent, from its first
  // item. A deeper item, or one of the other kind ("Pick one:" then its
  // choices), belongs to the ask above it.
  let top: { indent: number; numbered: boolean } | undefined;
  for (const line of body) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = inFence ? null : itemOf(line);
    if (m) {
      const kind = { indent: m[1].length, numbered: /\d/.test(m[2]) };
      top ??= kind;
      if (items.length && (kind.indent > top.indent || kind.numbered !== top.numbered)) items[items.length - 1] += ` ${m[3]}`;
      else items.push(m[3]);
      inItem = true;
    } else if (!line.trim()) {
      // A blank line ends an item's continuation, not the list: items are
      // often a blank line apart.
      inItem = false;
    } else if (inItem || inFence || (items.length && /^\s{2,}\S/.test(line))) {
      items[items.length - 1] += ` ${line.trim()}`;
      inItem = true;
    } else if (!items.length) {
      prose.push(line.trim());
    } else {
      // Prose after the list (what the agent will do meanwhile) isn't an ask.
      break;
    }
  }
  const para = prose.join(' ').trim();
  if (!items.length) {
    if (!para || NOTHING.test(para)) return { needs: 'nothing' };
    return { needs: 'you', asks: [askFrom(para)] };
  }
  // "Nothing right now. Worth doing next:" then a list: follow-ups, not asks.
  if (NOTHING.test(para)) return done(items.map(nextFrom));
  if (items.length === 1 && NOTHING.test(items[0])) return { needs: 'nothing' };
  return { needs: 'you', asks: items.slice(0, MAX_ASKS).map(askFrom) };
}

// Mike's instructions ask for any follow-up after "Nothing needed from you
// right now", which agents write as a list: "Two follow-ups are worth
// doing:" then a bullet each. With no end_turn to carry them, the done
// card showed none (30 Oct 2026, thread 13096d04). So a list in the lines
// after it, with at most a line of lead-in before it, is the card's next.
// Prose after the list ends it, and prose with no list is no follow-up.
function nextFromList(lines: string[]): string[] {
  return listAfter(lines).items.map(nextFrom);
}

// That list as written, whether a line of lead-in came before it, and how
// many of the lines it and its lead-in take up (0 with no list).
function listAfter(lines: string[]): { items: string[]; lead: boolean; end: number } {
  const items: string[] = [];
  let lead = 0;
  let end = 0;
  let inFence = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = inFence ? null : itemOf(line);
    if (m && (!items.length || m[1].length === 0)) items.push(m[3]);
    else if (m || (items.length && /^\s{2,}\S/.test(line))) items[items.length - 1] += ` ${line.trim()}`;
    else if (!line.trim()) continue;
    else if (items.length || inFence || ++lead > 1) break;
    if (items.length) end = i + 1;
  }
  return { items, lead: lead > 0 && items.length > 0, end };
}

// A follow-up as the message that would start it, for a row on the done
// card: "**Check your next call:** confirm Bruce used Nemotron on it. Its
// service is untested." becomes "Check your next call: confirm Bruce used
// Nemotron on it". Only the first sentence, as the rest says why.
const NEXT_LINK = { titleStopsAtNewline: false, titleMin: 1, titleMax: Infinity, targetStopsAtSpace: false, targetMin: 0 };
function nextFrom(item: string): string {
  return nextRow(item).row;
}

// ...and whether that row is the item as written: no link's address,
// second sentence or cut for length left out of it, no ** taken out
// ("src/**/*.ts" as much as bold), nor its full stop, which may not be a
// sentence's ("Run touch release.").
function nextRow(item: string): { row: string; all: boolean } {
  // A link's text: replaceLinks is `/\[([^\]]+)\]\([^)]*\)/g` read once,
  // as that was quadratic on a long run of "[" in a model's reply.
  const t = replaceLinks(item, NEXT_LINK, (title) => title)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // Each cut (the first sentence, the length, back to a word) is placed in
  // the whole text, so none is inside a secret (safe-cut.ts).
  const sentence = safeEnd(t, /^.+?[.!?](?=\s|$)/.exec(t)?.[0].length ?? t.length);
  const first = t.slice(0, safeEnd(t, t.slice(0, sentence).replace(/\.$/, '').length));
  if (first.length <= MAX_NEXT_CHARS) return { row: first, all: first === item.replace(/\s+/g, ' ').trim() };
  const end = safeEnd(t, MAX_NEXT_CHARS);
  const space = t.lastIndexOf(' ', end - 1);
  const cut = space > 0 ? safeEnd(t, space) : Math.max(end, 1);
  return { row: t.slice(0, safeEnd(t, t.slice(0, cut).replace(/[,;:]$/, '').length)), all: false };
}

// "Open X, add Y, then reply 'done'" names the words to send back.
const REPLY = /\b(?:reply|send(?: back)?|say|answer|respond)(?: with)?\s+["'“‘`]([^"'”’`\n]{1,40})["'”’`]/i;
// Each further quoted choice after it: 'Reply "filter" or "wait"', or
// 'Reply with "Land it", "Website, then land it", or what else to change'.
const MORE = /^\s*(?:,\s*(?:or\s+)?|or\s+|\/\s*)["'“‘`]([^"'”’`\n]{1,40})["'”’`]/i;

function askFrom(item: string): Ask {
  const action = cutSafely(
    item
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim(),
    MAX_ACTION,
  );
  const ask: Ask = { action };
  const reply = REPLY.exec(action);
  if (!reply) return ask;
  const choices = [reply[1].trim()];
  let rest = action.slice(reply.index + reply[0].length);
  for (let m = MORE.exec(rest); m && choices.length < MAX_OPTIONS; m = MORE.exec(rest)) {
    choices.push(m[1].trim());
    rest = rest.slice(m[0].length);
  }
  // One is the words to send back; several are a choice, each its own
  // button. Taking just the first of a list left Mike one button where
  // the agent had offered two (28 Oct 2026).
  if (choices.length > 1) ask.options = choices;
  else ask.reply = choices[0];
  return ask;
}

// end_turn's description doubles as the instructions: a resumed Claude
// session keeps the system prompt it started with, but sees every tool's
// description afresh.
const END_TURN_WHAT =
  'Ends the turn: says what it did (summary) and whether the user has to do anything (asks), so Threadbear can put the thread in Needs you or leave it as done. ';

// Mike, 29 Oct 2026, after Codex desktop: the least context to load when
// he comes back to a thread, then what's next, with links back into the
// detail. Later that day the bullets hid two answers (an explanation, a
// Sentry report), so a final message that says more than them is the
// Mac app's reply (TranscriptReducer.replyItems). In 36 test sessions, bullets asked for in the final message
// came back as prose from Opus every time; in here, as bullets every time
// (docs/end-turn-design). The links' quote-a-step rule is what models
// managed: they can't see their tool calls' ids.
const SUMMARY_BULLETS = '2 to 5 markdown bullets of what happened this turn (what you found, changed, shipped or decided, with the result), each one line of about 15 words at most, in plain words that make sense to someone who has forgotten the task. ';
const SUMMARY_STANDS_ALONE = 'Never point at something "above": the user may only see the bullets. Leave what the user has to do to the asks. If they asked a question, the first bullet answers it. ';

const END_TURN_SUMMARY_IS_THE_REPLY =
  'summary is what the user reads first when they come back to the thread, often hours later and among many others: ' +
  SUMMARY_BULLETS +
  "The preview, notifications and the phone show it as your reply. In the Mac app, what you write after your last step (before end_turn) is the reply when it says more than the bullets, and the bullets fold into your working with everything else; otherwise the bullets are the reply. So when the answer is an explanation or a report, write it as your message and make the bullets a short version that stands on its own; when it isn't, don't repeat the bullets in a message. " +
  SUMMARY_STANDS_ALONE;

// Bullet replies off (Settings > General): Mike, 30 Oct 2026, liked the
// folded working but wanted the agent's normal message as the reply. The
// bullets stay, as previews and notifications need something short.
const END_TURN_SUMMARY_IS_THE_PREVIEW =
  'Write your reply as an ordinary message, as you would with no tool to call: the result and what the user needs to know, at the length it deserves. In the Mac app that message is the reply, and the summary folds into your working with everything else. ' +
  'summary is the short version the preview, notifications and the phone show: ' +
  SUMMARY_BULLETS +
  SUMMARY_STANDS_ALONE;

const END_TURN_SUMMARY_LINKS =
  'Link each bullet to where they can check it: a web page or a file as an ordinary markdown link; another thread as [its own thread](thread:<its id from list_threads>); a step in your own working this turn as work: and a few words copied exactly from that step (the command you ran or its description, the file you edited, or a line you wrote while working), e.g. [tests pass](work:npm test), which opens your working at that step and lights it up. Links work in the asks too. ' +
  // Mike, 29 Oct: a turn that waited for the app to restart, then the
  // check after it, left two summaries. The app now shows a runner's turn
  // and the turns before it back to Mike's message as one, with the last
  // summary as the reply (docs/protocol/needs-you.md, "The summary").
  "When this turn started from a message the runner sent rather than one from the user (the app restarted, a hook ran, the resume after a restart), this summary takes the place of your last one, so cover everything since the user's last message, not just this turn; work: links can quote steps from those turns too. " +
  'Leave summary out only when the turn was a line or two of conversation, and write that as an ordinary message. ';

// How to write a follow-up row. Mike kept pressing the ? on rows like
// "Sandbox sample in the Mac app's HangWatch too" and "Stop Walkies being
// blamed for the audio wakelock" (30 Oct to 1 Nov): the agent's shorthand,
// with nothing to say why it came up. "Must make sense on its own" didn't
// help: at least 113 of the 149 cards with rows came after that line landed,
// and in replays of those turns it did no better than leaving it out. A cold reader got why a row
// was there about twice as often with this (0.31 to 0.58 on Opus), so it asks
// for the reason in the row instead of adding a field for it
// (~/dev/me/misc/end-turn-eval/next-rows). The longer rows wrap on the card.
const NEXT_ROW =
  'Each is a row on the done card that the user reads hours later, with this thread forgotten and nothing else to go on, and ticking it sends it to you as their own message. ' +
  'So write it in their voice, as an instruction: which app or thing it\'s about and what they\'d see change or get, in words they\'d use, with the reason in the same line if it isn\'t obvious. ' +
  'No names from the code or your working (a class, a file, a tool, a nickname for something); describe what it does instead. ' +
  '8 to 15 words: "Stop the Threadbear transcript jumping when a long reply arrives", not "Fix the ScrollAnchor drift". ';

// A queued remote job is still owned by this CLI. A saved continuation
// preserves the next message, not the process (thread 879afc1e, 14 Nov).
const END_TURN_BACKGROUND =
  'Archiving or hibernating stops this CLI\'s background jobs, including shell jobs waiting in a queue. Leave archive, snooze and waitFor out while they run; use schedule_message to check later. ';

// Hibernating itself, in every form's description (snoozeFromTool).
const END_TURN_SNOOZE =
  END_TURN_BACKGROUND +
  'snooze hibernates this thread once the turn is over, with needs "nothing" only, until a time ("2h", "1d", "tomorrow", an ISO time with its offset, "restart", or "release" for a new release) or words saying when ("when the phone arrives"). Use it when the user asks for this thread to be snoozed or hibernated, or when the rest waits on a message (one wakes it), until it should have come; it only brings the thread back, so a step of your own later is a schedule_message, except words for something to happen ("until X ships"), which wake you with a turn to check. waitFor names threads it waits on, which wake it when they finish. ';

// Handing a step over, in every form's description. This used to say to offer
// "Can you do it?" when the agent could plausibly do the step itself, which told
// it to ask rather than try: the user was answering that button, in those words,
// on steps like resolving a Sentry issue with the tool right there (29 Oct to
// 2 Nov 2026). The button stays for what's left after a real try.
export const TRY_IT_FIRST =
  'Before you give the user a step, try it yourself with the tools you have, including any that drive their browser, apps or phone, and if it works there is no ask. ' +
  'Hand it over only when it really needs them (a payment, something physical, a change to their credentials (~/.aws, ~/.ssh, Keychain, tokens), an approval that is theirs to give) or after a real attempt, and say in your reply what you tried and what stopped it. ' +
  'Get a key yourself when you can (one shown on a page in a signed-in browser), and use a password you set up yourself; ask with ask_secret only for one only they know, and carry on. ' +
  'If there is still something you could try, offer "Can you do it?" next to Done and say what in its answer: it lets them send the step back to you, and is no reason to skip trying. ';

// What end_turn says, once a turn, to a card handing the user a step. The
// wording alone didn't get steps tried: in replays of real turns agents still
// offered "Can you do it?" with no try at the step, and this note brought a
// real try every time (6 of 6). Forced onto a sign-in or payment card, agents
// sent the card again unchanged, paying nothing and signing in to nothing
// (~/dev/me/misc/end-turn-eval/try-first). Whether a turn tried can't be read
// from its tool calls, as nearly all of them were busy with something else (29
// Oct to 1 Nov 2026), so it asks the agent, and an agent that did try or can't
// only spends one more call.
// Until 20 Nov it came only to a card offering "Can you do it?", which an agent
// that doesn't think it can do the step never offers: on 19 Nov Mike was handed
// System Settings switches on a Mac the agent had Screen Sharing on, a long
// password it had made for him to type, and a removable-volume prompt, each
// with "Done" and "Stuck" (0b6b183c, 854d950f), and five times told it to do
// them itself. So it comes to any card that hands over a step (handsOverAStep).
// Credentials count as needing the user: on 18 Nov this note, on a "Do it for
// me / I'll do it" card about ~/.aws/config, got an agent to rewrite it
// unasked (David Clark's fork, 32cda3c2d).
export const TRY_FIRST_NUDGE = 'Not ended: this card hands the user a step to do.';
export function tryFirstNudge(): string {
  return `${TRY_FIRST_NUDGE} If you could do it yourself and haven't tried, try it now with the tools you have (a setting or dialog on a Mac you can reach with ComputerCub or Screen Sharing, a key shown on a page in a signed-in browser, a password you set for a test account, which you can type yourself), then call end_turn again with whatever is left. If you already tried, it really needs the user (a password or code only they know, a payment, something physical, a change to their credentials (~/.aws, ~/.ssh, Keychain, tokens), an approval that is theirs to give), or it's a choice rather than a step, call end_turn again as you were, and say in your reply what you tried or why it needs them: this note comes once a turn.`;
}

// An ask about another thread with no answers and no link: "Pick a
// direction for the app in its own thread" (17 Nov 2026) was a numbered line
// on the phone with nothing to press and no way to that thread. A bare ask
// is otherwise fine (the answer is typed), so only one naming a thread is
// held up, once a turn, as the agent may mean it.
export const DEAD_END_NUDGE = 'Not ended: an ask on this card points at another thread but has no link to it, so the user has no way there from the card.';
export function deadEndNudge(asks: Ask[]): string {
  const which = asks.filter(isDeadEnd).map((a) => `"${cutSafely(a.action, 80)}"`).join(', ');
  return `${DEAD_END_NUDGE} (${which}). Add a link to it, { title: "Open its thread", url: "thread:<its id from list_threads>" }, or leave it off this card and let that thread ask. If it isn't about another thread, call end_turn again as you were: this note comes once a turn.`;
}
const NAMES_A_THREAD = /\bthreads?\b/i;
function isDeadEnd(a: Ask): boolean {
  return !a.options?.length && !a.links?.length && NAMES_A_THREAD.test(`${a.action} ${a.why ?? ''}`);
}
export function hasDeadEnd(asks: Ask[]): boolean {
  return asks.some(isDeadEnd);
}
export function deadEndNudged(events: PersistedEvent[]): boolean {
  return nudgedSince(events, DEAD_END_NUDGE);
}

// An answer that hands a step back to the agent. By its label, as the wording
// asks for these words and agents keep to them: "Can you do it?", "Can you do
// it in Chrome?", "Connected, you do it", "Do it for me later".
const TAKES_IT_BACK = /\b(?:can|could|would) you\b.*\b(?:do|try|handle|run)\b|\byou do it\b|\bdo (?:it|them|this|that) for me\b|\btry it yourself\b/i;
export function offersToTakeItBack(asks: Ask[]): boolean {
  return asks.some((a) => a.options?.some((o) => TAKES_IT_BACK.test(o)));
}

// A card that hands the user a step, rather than asking them to choose: one
// offering to take it back, one with an answer saying it's done ("Done",
// "Unlocked", "Switched back", "Signed in"), or one whose ask opens with an
// instruction ("Turn on...", "On Tinker Desk, allow...", "In the tab I
// brought forward, set up prepay..."), as every card Mike was handed a step
// on did on 19 Nov. A question about what to do ("Should I...?", "How should
// we...?", "Can I log you out tonight?") is a choice, and a card that opens a
// review (show_options) is a pick: neither is held up, and nor is an
// instruction asked as a question ("Install the new Tandem now?"), which asks
// leave to do it. An ask to delete, remove, buy or pay is never held up, so
// the note never presses an agent towards one; nor do labels that are as
// often a choice ("Fixed price", "Signed URL", "Enabled") count as saying
// it's done. Codex and Gemini found those in two rounds of review (20 Nov).
// The whole answer is the done phrase, maybe with "it" or a few words after a
// comma ("Done, picked"), so "Installed apps" or "I've changed my mind" isn't.
const SAYS_DONE = /^(?:done|all (?:done|set)|did (?:it|that)|i did|it's (?:done|on|in)|i(?: have|'ve) (?:\w+ed|done|set|put|got|made|run)|finished|unlocked|switched|signed in|logged in|turned(?: (?:it|them))? (?:on|off)|added|allowed|granted|installed|pasted|typed|entered|reconnected|plugged in|restarted|rebooted|clicked|copied)(?: (?:it|them|that|this|both|all|now|in|on|off|up|back|over))*(?:\s*[-–—(,.!:;].*| to .*)?$/i;
const STEP_VERB = 'add|allow|click|connect|copy|create|drag|enable|enter|give|grant|install|log ?in(?:to)?|log (?:out|on(?:to)?)|move|open|paste|plug|press|put|reconnect|restart|reboot|run|set|sign ?in(?:to)?|sign (?:up|out)|switch|tap|tick|turn|type|unlock|unplug';
// The instruction, maybe after "Please" or "Can you" and clauses saying where
// ("On Tinker Desk, in System Settings, ").
const ASKED_TO = '(?:can|could|would) you (?:please )?';
const STARTS_WITH_A_STEP = new RegExp(`^(?:please,? |${ASKED_TO})?(?:(?:on|in|at|from|over|using|with) [^,?]{1,120}, ){0,2}(?:please,? |${ASKED_TO})?(?:${STEP_VERB})\\b`, 'i');
// Deleting, paying and the like are never pressed on an agent, whatever the card.
const NOT_TO_PRESS = /\b(?:delet(?:e|es|ed|ing|ion)|remov(?:e|es|ed|ing)|erase|wipe|uninstall|destroy|pay|paid|paying|payment|prepay|buy|purchase|checkout|subscribe|refund|(?:place|make) (?:an |the )?order|order (?:it|them|one|the|a|some)|cancel (?:the |my |your |this )?(?:subscription|plan|order|account|membership)|close (?:the |your |my )?account)\b/i;
// Curly apostrophes as typed on a phone or by some models, markdown links as
// their words, and bold or italics, so they don't hide the words.
const plain = (s: string) => s.replace(/[‘’]/g, "'").replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim();
export function handsOverAStep(asks: Ask[]): boolean {
  // An ask that opens a review is a pick; the card's other asks still count.
  const steps = asks.filter((a) => !a.links?.some((l) => l.url.startsWith('review:')) && !NOT_TO_PRESS.test(plain([a.action, a.why, ...(a.optionNotes ?? [])].join(' '))));
  return offersToTakeItBack(steps) || steps.some((a) => [...(a.options ?? []), ...(a.reply ? [a.reply] : [])].some((o) => SAYS_DONE.test(plain(o))) || givesAnInstruction(plain(a.action)));
}
// An instruction, and not a question: one ending "?" asks leave or is a
// choice ("Install the new Tandem now?", "Open PRs #38 and #41 both touch
// auth. Which first?"); "Can you ...?" is the user being asked to do it.
function givesAnInstruction(action: string): boolean {
  const first = action.split(/(?<=[.?!])\s/)[0];
  if ((first.endsWith('?') || action.endsWith('?')) && !/\b(?:can|could|would) you /i.test(first)) return false;
  return STARTS_WITH_A_STEP.test(action);
}

// What end_turn says, once a turn, to a Done card in a thread Mike started
// that's part of a project still going. On 20 Nov 2026 the calendar site's
// thread said Done twice in a row (after building the look Mike picked, then
// after fixing its review), with its own project's state saying "Next is
// Peter's review of the live site", and with three follow-ups and a question
// from earlier cards never answered (Peter's missing photos, the email to
// him, Google's sign-in screen). Mike nearly archived it. Done reads as safe
// to archive, so the note shows the project's state and those earlier items,
// and leaves it to the agent which still matter: Mike didn't want old
// questions carried forward by rule, as some no longer apply.
export const PROJECT_STEP_NUDGE = "Not ended: this card says Done, and this thread is part of a project that isn't finished.";
const PROJECT_STEP_EARLIER_HEAD = ' Earlier in this thread you asked or suggested these, and no answer to them came back: ';
const PROJECT_STEP_EARLIER_TAIL = '. Keep any that still matter, as an ask or in next, and leave out ones that were settled another way or no longer apply.';
const ACP_ERROR_PREFIX = 'Encountered error in step execution: ';
const MAX_STATE_CHARS = 400;
const MAX_OPEN_ITEMS = 6;
export function projectStepNudge(projects: { title: string; state: string }[], open: string[]): string {
  const cut = (t: string) => (t.length > MAX_STATE_CHARS ? `${t.slice(0, MAX_STATE_CHARS).replace(/\s+\S*$/, '')}…` : t);
  const which = projects.map((p) => `"${p.title}"${p.state.trim() ? ` (its state: "${cut(p.state.trim().replace(/\s+/g, ' '))}")` : ''}`).join(' and ');
  const earlier = open.length ? `${PROJECT_STEP_EARLIER_HEAD}${open.map((o) => `"${o}"`).join('; ')}${PROJECT_STEP_EARLIER_TAIL}` : '';
  return `${PROJECT_STEP_NUDGE} It's in ${which}. Done means the user can archive the thread: the whole job, not this step. If the next step is theirs (looking at what you made, sending it to someone, a decision), put it on the card as an ask with needs "you". If it's yours to do later, book it with schedule_message, which runs you then.${earlier} If this thread's part really is finished, call end_turn again as you were: this note comes once a turn.`;
}
export function projectStepNudged(events: PersistedEvent[]): boolean {
  return nudgedSince(events, PROJECT_STEP_NUDGE);
}

function isNudgeText(text: string, note: string): boolean {
  return text.startsWith(note) || text.startsWith(`${ACP_ERROR_PREFIX}${note}`);
}

function notedEarlierItems(text: string): string | undefined {
  if (!isNudgeText(text, PROJECT_STEP_NUDGE)) return undefined;
  const start = text.indexOf(PROJECT_STEP_EARLIER_HEAD);
  if (start < 0) return undefined;
  const from = start + PROJECT_STEP_EARLIER_HEAD.length;
  const end = text.indexOf(PROJECT_STEP_EARLIER_TAIL, from);
  return end < 0 ? undefined : text.slice(from, end);
}

function listedInEarlier(earlier: string, item: string): boolean {
  const quoted = `"${item}"`;
  return earlier === quoted || earlier.startsWith(`${quoted}; `) || earlier.endsWith(`; ${quoted}`) || earlier.includes(`; ${quoted}; `);
}

// The asks and follow-ups (next) on this thread's earlier cards that no
// message from Mike answered since, oldest first, at most six: the last
// few, as older ones are likelier settled. A card is what its turn ended
// with (turn.completed), so one an interrupted or reopened turn replaced,
// which Mike never saw, isn't here, and the turn still running has none
// yet. An ask counts as answered by a card answer naming it or a message
// quoting it, a follow-up by a message with its words (ticking one sends
// them) or, for an ask linking a show_options review, his pick in it,
// however late: one sent into the running turn too. Only Mike's
// messages answer (fromMike: not the runner's, a schedule's or another
// agent's), and what an edit cut out (thread.rewound) never happened.
// Items an earlier project-step note already listed before a plain Done
// turn are dropped unless raised again later: the agent saw them and
// judged them settled (e.g. answered in other words, David Clark, 24 Nov).
// What `now` already lists is left out.
const plainKey = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
export function unansweredItems(events: PersistedEvent[], now: string[] = []): string[] {
  const cuts = events.flatMap((e) => (e.type === 'thread.rewound' ? [{ from: e.fromSeq, to: e.toSeq }] : []));
  // Each open item's words, and the show_options reviews its ask links to:
  // picking in the review window answers it, with words of its own.
  const open = new Map<string, { text: string; reviews: string[] }>();
  let notedThisTurn: string[] = [];
  const endCalls = new Map<string, Record<string, unknown>>();
  let doneAfterNote = false;
  for (const e of events) {
    if (cuts.some((c) => e.seq >= c.from && e.seq <= c.to)) continue;
    if (e.type === 'turn.started') {
      notedThisTurn = [];
      endCalls.clear();
      doneAfterNote = false;
    } else if (e.type === 'tool.call' && (e.name === END_TURN_TOOL || e.name.endsWith(`__${END_TURN_TOOL}`))) {
      endCalls.set(e.itemId, e.input);
    } else if (e.type === 'tool.result') {
      if (typeof e.text === 'string') {
        const noted = notedEarlierItems(e.text);
        if (noted) notedThisTurn.push(noted);
      }
      const call = endCalls.get(e.itemId);
      if (notedThisTurn.length && call && endTurnTaken(e)) {
        const deferred = Boolean(archiveFromTool(call) || snoozeFromTool({ ...call, needs: 'nothing' }) || waitForFromTool(call)?.length || runsFromTool(call));
        const parsed = needsFromTool(call);
        if (!deferred && (!parsed || parsed.needs === 'nothing')) doneAfterNote = true;
      }
    } else if (e.type === 'turn.completed') {
      if (e.needs === 'nothing' && doneAfterNote) {
        for (const [k, item] of [...open]) {
          if (notedThisTurn.some((s) => listedInEarlier(s, item.text))) open.delete(k);
        }
      }
      notedThisTurn = [];
      endCalls.clear();
      doneAfterNote = false;
      const items = e.needs === 'you' ? (e.asks ?? []).map((a) => ({ text: a.action, reviews: (a.links ?? []).flatMap((l) => (l.url.startsWith('review:') ? [l.url.slice('review:'.length)] : [])) })) : e.needs === 'nothing' ? (e.next ?? []).map((t) => ({ text: t, reviews: [] })) : [];
      for (const item of items) {
        open.delete(plainKey(item.text));
        open.set(plainKey(item.text), item);
      }
    } else if (e.type === 'user.message') {
      notedThisTurn = [];
      endCalls.clear();
      doneAfterNote = false;
      if ((!e.origin || e.origin === 'phone') && !sentByAgent(e.text ?? '')) {
        const said = plainKey(e.text ?? '');
        const answered = new Set((e.answers ?? []).map((x) => plainKey(x.action)));
        const review = e.reviewId;
        for (const [k, item] of [...open]) {
          if (answered.has(k) || (k && said.includes(k)) || (review && item.reviews.some((r) => r.length >= 8 && review.startsWith(r)))) open.delete(k);
        }
      }
    }
  }
  for (const t of now) open.delete(plainKey(t));
  return [...open.values()].map((i) => i.text).slice(-MAX_OPEN_ITEMS);
}

export const REVIEW_NUDGE = 'Not ended: a helper finished and its task is still in review:';
export function reviewNudge(tasks: { title: string }[]): string {
  return `${REVIEW_NUDGE} ${tasks.map((task) => JSON.stringify(task.title)).join(', ')}. Check the result against doneWhen. If the user needs to decide or do something, put it to them now with options and a recommendation. Offer to get it ready or do it for them where your charter allows. If the work needs their sign-off, leave it ready to close. If it should stay in review, call end_turn again. This note comes once per helper run.`;
}

// Only the card's defer control is reserved. "Wait" and "Not yet" can
// be answers to the project's decision.
export function putsOff(answer: string): boolean {
  return /^not now[.!?]?$/i.test(answer.trim().replace(/\s+/g, ' '));
}

// Whether this turn has had the note (connectors.ts, nudgedThisTurn, is the same).
export function triedFirstNudged(events: PersistedEvent[]): boolean {
  return nudgedSince(events, TRY_FIRST_NUDGE);
}

export function plainCardNudged(events: PersistedEvent[]): boolean {
  return nudgedSince(events, PLAIN_CARD_NUDGE);
}

// Whether a note starting `note` has been sent since this turn began.
function nudgedSince(events: PersistedEvent[], note: string): boolean {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn.started') {
      start = i + 1;
      break;
    }
  }
  // Antigravity ACP prefixes thrown MCP tool errors with 'Encountered error in step execution: '.
  return events.slice(start).some((e) => e.type === 'tool.result' && typeof e.text === 'string' && isNudgeText(e.text, note));
}

// What end_turn says, once a turn, to a card with answers to pick from. Mike
// couldn't follow cards five times from 15 to 17 Nov 2026: "What's a thin
// machine? What's no machine? What's a mirror? Apple?" (8a971407), where the
// buttons were "B: thin machine", "C: no machine", "A: mirror Apple", the
// agent's names from an assessment file only the card's link opened. A line
// in the description like NEXT_ROW did nothing in replays of those turns: the
// same three labels came back 4 times in 4, and a cold reader found the
// agent's own names on 0.73 of cards with it against 0.36 without. This note
// rewrote them all 3 times ("Credits only", "No machine", "Copy Apple's
// states"), took those names to 0.11, and a cold reader could pick from the
// card alone 0.78 of the time against 0.55. Cards that read plainly came back
// much the same (~/dev/me/misc/end-turn-eval/asks). Nothing in the wording can
// be checked by rule: lettered labels are common and fine for mockups in a
// show_options review, and a card is written before the reply it could be
// checked against. A card that opens a review is left alone.
export const PLAIN_CARD_NUDGE = 'Not ended: read this card as the user will.';
export function plainCardNudge(): string {
  return `${PLAIN_CARD_NUDGE} They read it first, often on their phone, before your reply or any file it links, with this thread forgotten. Would they know what each question and button means? If a label or does uses a name you or a file coined ("plan B", "thin machine"), or a term they wouldn't use, reword it to say what that choice does in their words, then call end_turn again. If it already reads plainly, call end_turn again as it was. This note comes once a turn.`;
}
export function wantsPlainCard(asks: Ask[]): boolean {
  if (asks.some((a) => a.links?.some((l) => l.url.startsWith('review:')))) return false;
  return asks.some((a) => (a.options?.length ?? 0) > 0);
}

// A change only Mike can judge, left as a soft line at the end of a done
// reply. On 6 Nov 2026 (thread 524cd997) two turns in a row put Whisper
// dictation on his phone with needs "nothing" and ended "I haven't heard how
// Whisper does on the phone yet. If it's slow or mishears things, tell me",
// while he was in the middle of trying it; he asked why it wasn't in Needs
// you. Waiting for something to turn up later by itself stays "nothing".
// Replays: ~/dev/me/misc/end-turn-eval/needs-you.
export const ONLY_THEY_CAN_TRY =
  'When only the user can tell whether what you made works (their voice, their phone, how it feels to use) and nobody has tried it yet, trying it is an ask, with needs "you" ("Dictate a sentence on your phone and tell me what it typed"), not an "if it\'s off, tell me" line at the end of your reply. Something that will only show up later by itself (the next thread that hits it) is no ask. ';

// What to put in it, the same for both providers.
const END_TURN_ASKS =
  'needs "nothing" when the work is finished (or still going by itself) and nothing waits on the user. ' +
  'needs "you" when it does: an approval, a decision, a key, something to look at, a question. Give one ask per thing they have to do, most blocking first. ' +
  ONLY_THEY_CAN_TRY +
  'The asks are your "What I need from you" list: the user reads and answers them in a card under your message, each drawn as one paragraph of message text, its action then its why, with its buttons under it. So don\'t also list them in your message. ' +
  'Write each ask the way you would in that list, so it makes sense on its own to someone who has forgotten everything: action is its first sentence, the thing to do or the question ("Next time you leave the room, take your phone and leave the laptop idle on power."); why carries on the same paragraph with what it is about and what you want back, in a sentence or two ("It should lock within a minute of you going. Tell me whether it did, and I\'ll tune the Bluetooth cutoff."). Say where in it when it matters (System Settings › Bluetooth), and name things rather than places (not "Slack #channel", but "Your Slack draft to Emily names the automation guy Hayden; he is Pete"). When one ask is several questions, end its why with them as a short markdown list, one per line, rather than running them together; choices go in options, not the list, with suggested for your pick. ' +
  'Give links whenever there is somewhere to go to do it or judge it: the page to log in on, the Slack message (its permalink), the PR, the preview, the file or screenshot to look at, the project to open (a path opens in its own app, e.g. a .key file in Keynote), review:<id> for a show_options review in this thread (its window, to compare and pick), or thread:<id> when the step is in another thread (that thread, to answer it there). Each is a button on the ask, so title it as the action ("Open login page", "Open the Slack message", "Open Short 4 in Tandem"). ' +
  // Mike, 29 Oct: an ask said "Look at the screenshots in Highlights" in
  // plain words over a "See the tab" button for the same screenshot.
  'The paragraph is markdown, so where action or why names the thing a link opens, make those words a link to the same url ("Look at [the pairing screenshot](/Users/you/shots/pair.png) and say whether to land it."): the user can hover them for a peek or click them, and the button stays as the next step. ' +
  'Every decision or yes/no question needs options: 2 to 4 short likely answers, e.g. ["Go", "Not yet"] or ["Merge", "Test locally first"], with suggested: the index of the one you would pick. "Say go for X, or name another" is a decision too: give ["Go", ...the other candidates]. The user can always write their own answer instead, so options never box them in. ' +
  TRY_IT_FIRST +
  // Mike, 30 Oct & 26 Nov 2026: follow-ups in closing prose over a plain Done card
  // get forgotten; encourage real follow-ups and optional next-direction forks without filler.
  'next is for needs "nothing": up to 3 worthwhile follow-ups that genuinely came up (remaining work, a due check, or optional next directions); leave it out if nothing natural follows, and never invent filler. Set nextPick: "one" (with optional nextSuggested index) when they are mutually exclusive directions rather than items to tick together. ' + NEXT_ROW + 'Don\'t also list them in your message. ' +
  'archive: true archives this thread once the turn is over, with needs "nothing" only. Use it only when the user asks for this thread to be archived, or the message that started the thread says to; otherwise leave it out, as a thread that vanishes from their inbox when they hadn\'t finished with it is confusing. ' +
  END_TURN_SNOOZE +
  'If you leave sub-agents running, the thread stays under Running and your asks don\'t reach the user\'s inbox until the sub-agents finish and you\'ve ended a later turn, so don\'t leave one waiting on the user. ' +
  'Sub-agents never call this; only the thread\'s own agent does.';

export const END_TURN_DESCRIPTION =
  END_TURN_WHAT +
  'Call it once, as the very last thing in every turn, and write nothing after it. ' +
  END_TURN_SUMMARY_IS_THE_REPLY +
  END_TURN_SUMMARY_LINKS +
  "With a summary, you needn't write a message first when the bullets are the whole answer. When the user asked for something to read (details, a list, steps, a draft, an explanation), write it as your message before you call end_turn: a bullet like \"Put together the details you need\" points at nothing unless the details are in a message. Without one, it is refused until the turn has a reply: ordinary text from you after your last tool result (Threadbear's own tools aside), so the user gets a complete answer in the conversation. " +
  END_TURN_ASKS;

// Codex's: its final answer ends the turn, so nothing can be called after
// it. Told to call end_turn after its final message, Codex never once
// did; GPT-6.1-Sol wrote the call into its final answer instead, raw
// tool-call tokens and all, and Mike read them (28 Oct 2026).
const CODEX_END_TURN_HOW = 'Call it through your tools like any other; never write the call, or its result, in your message. ';

export const CODEX_END_TURN_DESCRIPTION =
  END_TURN_WHAT +
  'Call it once, as your last tool call, just before your final answer: the final answer ends the turn, so nothing can be called after it. ' +
  CODEX_END_TURN_HOW +
  END_TURN_SUMMARY_IS_THE_REPLY +
  END_TURN_SUMMARY_LINKS +
  'With a summary, your final answer can be one short line: it folds into your working, as the user reads the summary instead. ' +
  END_TURN_ASKS;

// With bullet replies off. A session sees these when its CLI starts; one
// already live goes by what end_turn's handler answers until then.
const MESSAGE_END_TURN_DESCRIPTION =
  END_TURN_WHAT +
  'Call it once, as the very last thing in every turn, and write nothing after it. ' +
  END_TURN_SUMMARY_IS_THE_PREVIEW +
  END_TURN_SUMMARY_LINKS +
  "It is refused until the turn has that message: ordinary text from you after your last tool result (Threadbear's own tools aside). " +
  END_TURN_ASKS;

const CODEX_MESSAGE_END_TURN_DESCRIPTION =
  END_TURN_WHAT +
  'Call it once, as your last tool call, just before your final answer: the final answer ends the turn, so nothing can be called after it. ' +
  CODEX_END_TURN_HOW +
  END_TURN_SUMMARY_IS_THE_PREVIEW.replace('an ordinary message', 'your final answer').replace('that message', 'that answer') +
  END_TURN_SUMMARY_LINKS +
  END_TURN_ASKS;

// One reply (docs/protocol/needs-you.md, "One reply"; docs/reply-card-design): the
// agent calls end_turn first, with the card and a headline, then writes
// its reply as its final message. Its context was written up to three
// times (message, bullets, why), each told to stand alone, and Opus sent
// the message as narration, which reaches us only paraphrased. A message
// with no tool call after it is never narration, and it's where models
// write their answer anyway: in 32 eval sessions this wording lost no
// replies (today's lost the agent's words in 6 of 16), and wrote the reply
// twice in 2 runs where putting it inside end_turn did in 9
// (~/dev/me/misc/end-turn-eval/v3). Codex already worked in this order.
// The "lost track" line: six times from 30 Oct to 5 Nov 2026 Mike had to
// ask what a piece of work was ("Sorry, I'm not really following") after a
// long turn or in a thread another agent started, as the reply reported
// only the latest step (28cee9ef: one experiment's result, never the plan
// it was for). One line, only then: he likes replies at their usual length.
// "What they asked" and "a few words on what it is": trying Ghostex's
// coordinator on 9 Nov 2026, Mike lost track of replies that answered his
// earlier question without saying which, and refused "Merge these 8 in
// this order: #38, #24, #25..." for want of what each one was and how
// serious ("I need more context on what these things are").
const ONE_REPLY_REPLY =
  'Then write your reply as ordinary text straight after it, as your final message. ' +
  'That reply is the only text the user sees from this turn: everything you write before end_turn folds away into your working, out of sight. So don\'t write your answer before calling it, and call no tools after it. ' +
  'The reply: lead with the point and keep it as short as it can be while they can act on it without reading your working. ' +
  'If they may have lost track (a long turn, work picked up from another thread, a thread they didn\'t start), open with one line on what the work is for and where it stands, before the latest step. ' +
  'If it answers something they asked earlier (a note on a card, a follow-up question), open by saying what they asked. ' +
  'A work report is a few bullets of what changed and the result, each linked to where it can be checked: [tests pass](work:npm test) quotes a few words of a step in your working (the command you ran or its description) and opens it there, lit up; [its own thread](thread:<its id from list_threads>) opens another thread; web pages and files link as usual. ' +
  'An explanation, a draft or an answer to their question is prose, at the length it needs. ' +
  'When they\'re deciding about several things (PRs, commits, findings), give each a few words on what it is, as they\'d see it, and how serious: never bare numbers or ids. A security question first says who could do what. ' +
  'When you\'re asking something, include the full draft to approve (text to send elsewhere goes in a ```slack, ```email or ```draft block, shown line for line with a Copy button) or the options to choose from in the reply. The question itself, and what each answer would do, are in the card under the reply, so don\'t repeat them. ' +
  'Never write a "What I need from you" section, a "Nothing needed from you" line or a list of follow-ups in the reply: asks and next are those. ';

// Only what the fields' own descriptions don't say (threadbear-mcp.ts):
// each field's rules sat in both until 4 Nov 2026, and every thread read
// them twice (runner/context-budget.json). Checked in the end_turn eval
// (~/dev/me/misc/end-turn-eval/v3, "trim") before landing.
const ONE_REPLY_FIELDS =
  END_TURN_BACKGROUND +
  TRY_IT_FIRST +
  ONLY_THEY_CAN_TRY +
  'next is for needs "nothing": up to 3 worthwhile follow-ups that genuinely came up (remaining work, a due check, or optional next directions) so the user can queue them in one click. Leave it out if nothing natural follows, and never invent filler. Use nextPick: "one" (with optional nextSuggested index) when the items are mutually exclusive directions rather than items they could tick together. ' +
  NEXT_ROW +
  'If you leave sub-agents running, the thread stays under Running and your asks don\'t reach the user\'s inbox until the sub-agents finish and you\'ve ended a later turn, so don\'t leave one waiting on the user. ' +
  'Sub-agents never call this; only the thread\'s own agent does.';

const ONE_REPLY_WHAT =
  'Ends the turn\'s work and sets up what the user sees under your reply: the card of asks, or the done card. ' +
  'Call it once, when the work is finished. ';

export const ONE_REPLY_DESCRIPTION = ONE_REPLY_WHAT + ONE_REPLY_REPLY + ONE_REPLY_FIELDS;
export const CODEX_ONE_REPLY_DESCRIPTION = ONE_REPLY_WHAT + CODEX_END_TURN_HOW + ONE_REPLY_REPLY.replace('your final message', 'your final answer') + ONE_REPLY_FIELDS;

export function endTurnDescription(provider: 'claude' | 'codex', bulletReplies: boolean, oneReply = false): string {
  if (oneReply) return provider === 'codex' ? CODEX_ONE_REPLY_DESCRIPTION : ONE_REPLY_DESCRIPTION;
  if (provider === 'codex') return bulletReplies ? CODEX_END_TURN_DESCRIPTION : CODEX_MESSAGE_END_TURN_DESCRIPTION;
  return bulletReplies ? END_TURN_DESCRIPTION : MESSAGE_END_TURN_DESCRIPTION;
}

// What an accepted one-reply end_turn says: the reply comes next. The
// runner knows the result by these words and keeps the text after it as
// the turn's reply (runner.ts, onOutput).
export const ONE_REPLY_NEXT = 'Now write your reply';

export function oneReplyAccepted(needsYou: boolean, restart = '', wroteFirst = false): string {
  const first = wroteFirst ? WROTE_FIRST : '';
  return needsYou
    ? `${ENDED} will wait in Needs you.${restart} ${ONE_REPLY_NEXT}: it's the only text the user sees from this turn, with the card of asks under it. ${first}${ASKS_NEED_THE_REPLY} Leave the question and button labels on the card, and write nothing after your reply.`
    : `${ENDED} is done. ${ONE_REPLY_NEXT}: it's the only text the user sees from this turn. ${first}Write nothing after it.`;
}

// Drafts and options written before end_turn are hidden with the work.
// Ask for the answer the user needs, rather than reproducing that work:
// the old "write it again in full" result immediately preceded an
// Anthropic reasoning_extraction refusal (6 Nov 2026, thread ba756ff4).
const WROTE_FIRST =
  'Give a self-contained answer with the result and supporting evidence. Include any requested draft, explanation or descriptions of choices in full. ';
const ASKS_NEED_THE_REPLY =
  'If the user needs a draft or descriptions of choices to decide, include them in full.';

// For an end_turn the Stop hook asked for, in a turn that has its message:
// the nudge said "your message above is the reply", and "Now write your reply"
// after it got a second message, which took the first's place. On 1 Nov 2026
// that was 13 of 84 one-reply turns, one trading 2,359 characters for 96, and
// a real answer folded under "The bear picture test is still waiting on you".
const MESSAGE_STANDS = 'your message above is the reply';
export function oneReplyAlreadyWritten(needsYou: boolean, restart = ''): string {
  return needsYou
    ? `${ENDED} will wait in Needs you.${restart} Stop here, with no more text: ${MESSAGE_STANDS}, the asks go in a card under it, and nothing written now reaches the user.`
    : `${ENDED} is done. Stop here, with no more text: ${MESSAGE_STANDS}, and nothing written now reaches the user.`;
}

// That answer, read back: the turn has its reply, so the Stop hook doesn't
// ask for one (adapter.ts), and any summary bullets a session on the old
// form sent don't take the message's place (runner.ts).
export function endTurnMessageStands(result: { ok: boolean; text: string }): boolean {
  return endTurnAccepted(result) && result.text.includes(MESSAGE_STANDS);
}

// An end_turn answered by the one-reply handler: the reply is a message, the
// next one or the one above, so bullets from a session on the older form
// don't stand in for it.
export function endTurnIsOneReply(result: { ok: boolean; text: string }): boolean {
  return endTurnWantsReply(result) || endTurnMessageStands(result);
}

// What a Claude end_turn that fits neither form hears. Says the shape in
// words, as the agent can't look it up: a session keeps the definition it
// first loaded, and ToolSearch shows that one too (threadbear-mcp.ts, endTurn).
// An agent on 1 Nov 2026 got a bare zod error and had to read the source
// (thread 1b770c6a).
// An ask's own fields written on end_turn itself, not inside asks. The
// schema lets unknown keys through, so they were dropped without a word: on
// 19 Nov a thread answering the reply-asks nudge sent { needs: "you", ask,
// options } and its two questions came out as a "Needs you" with no card at
// all (thread f0dd80e2). Refused, naming where they go.
const ASK_FIELDS = ['ask', 'question', 'action', 'why', 'options', 'suggested'];
export function strayAskFields(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const o = input as Record<string, unknown>;
  return ASK_FIELDS.filter((k) => o[k] !== undefined);
}
export function strayAskProblem(fields: string[], oneReply: boolean): string {
  const named = fields.map((f) => `\`${f}\``).join(', ');
  const inside = oneReply ? 'asks: [{ question, options: [{ label, does }] }]' : 'asks: [{ action, why, options: [...] }]';
  return `${named} ${fields.length === 1 ? "isn't one of end_turn's own fields" : "aren't end_turn's own fields"}, so the card would have no ask. Each ask goes inside asks, one object per thing to answer: ${inside}.`;
}

export function endTurnMisfit(problem: string, oneReply: boolean): string {
  const shape = oneReply
    ? '{ headline?, needs?, asks?: { question, options?: { label, does? }[], suggested?, links? }[], next?, nextPick?, nextSuggested?, archive?, snooze?, waitFor?, waitForRuns? }, then write your reply after it, as ordinary text: that reply is the only text the user sees from the turn.'
    : '{ needs?, summary?: string[], asks?: { action, why, reply?, options?: string[], suggested?, links? }[], next?, nextPick?, nextSuggested?, archive?, snooze?, waitFor?, waitForRuns? }, after writing your reply as ordinary text, with nothing after the call.';
  return `Not ended: those arguments don't fit end_turn.\n${problem}\nCall it with ${shape} Go by this rather than the tool's description, which can be out of date in a session this old, and reloading it won't change that.`;
}

export function endTurnWantsReply(result: { ok: boolean; text: string }): boolean {
  return endTurnAccepted(result) && result.text.includes(ONE_REPLY_NEXT);
}

// The Stop hook's nudges with one reply (adapter.ts, onStop): a turn that
// ended without end_turn already has its message, which the app shows as
// the reply; one that took end_turn and wrote nothing after it is asked
// for its reply once.
export const ONE_REPLY_END_TURN_NUDGE =
  'This turn ended without end_turn, so Threadbear has no card for it. ' +
  'Call end_turn now (load it with ToolSearch first if you need to), with needs and any asks or next follow-ups from what you just wrote. ' +
  "Your message above is the reply: don't write it again.";
export const ONE_REPLY_WRITE_NUDGE =
  'Write your reply now, as ordinary text: the user sees only what you write after end_turn, with the card under it. ' +
  'Include any requested draft, explanation or descriptions of choices in full. Leave the question and button labels on the card.';

// A reply that closes by asking the user for an answer, under an end_turn that
// said nothing was needed: the thread shows as done, with no card to answer
// on. In the week to 13 Nov 2026 two real questions went out that way among
// some 1,800 done turns ("Which do you want to start with?", thread 7a98a6fd;
// "Say go and I'll merge main into prod", 0222c475), and Mike picked a check
// over wider wording: the Stop hook sends the turn back once for the card
// (adapter.ts, onStop). Only a question or a go-ahead: an optional offer
// ("tell me if you want X and I'll set it up") stays a sentence, which he
// chose over rows on the done card. Returns the asking sentence, for the nudge
// to quote.
// A draft for someone else (a fenced block, a quote) isn't the agent asking.
const FENCE = /^\s*(?:```|~~~)/;
// Mid-paragraph, only a question that is plainly put to the user: "Why does
// this matter? Because..." is the agent talking.
const TO_THE_USER = /^(?:want me to|shall i|should i|do you want|would you like|which (?:one|of|do|would|should)|can i|may i|ok(?:ay)? (?:to|if)|is it ok(?:ay)?|are you (?:happy|ok(?:ay)?)|happy for me to|ready for me to)\b/i;
// "Say go and I'll...", "Reply yes to...", "...once you say the word". Not
// "I'd say yes", which is the agent's own view.
const GO = '(?:(?:the|a|your)\\s+)?["“\'‘`*]*(?:go(?:[- ]ahead)?|yes|ok(?:ay)?|the word|the nod)["”\'’`*]*(?=[\\s,.:;!)]|$)';
const SAY_GO = new RegExp(`^(?:just\\s+|so\\s+)?(?:say|reply|type|send|give me)\\s+${GO}|\\b(?:when|once|if|until|as soon as)\\s+you\\s+(?:say|give(?:\\s+me)?)\\s+${GO}`, 'i');

export function replyAsks(reply: string): string | undefined {
  const lines: string[] = [];
  let fenced = false;
  for (const line of reply.replace(/\r\n/g, '\n').split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      // A block breaks the paragraph around it.
      lines.push('');
    } else if (fenced || /^\s*>/.test(line)) lines.push('');
    else lines.push(line);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let from = lines.length;
  while (from > 0 && lines[from - 1].trim()) from--;
  // The closing paragraph, or the list it ends with: each line on its own, as
  // a sentence doesn't run across list items.
  const closing = lines.slice(from).slice(-12);
  const sentences = closing.flatMap((l) => sentencesOf(l));
  if (!sentences.length) return undefined;
  const last = sentences[sentences.length - 1];
  if (/\?$/.test(last)) return last;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i];
    if (SAY_GO.test(s) || (/\?$/.test(s) && TO_THE_USER.test(s))) return s;
  }
  return undefined;
}

// A line's sentences, without its list mark or the markdown around them.
function sentencesOf(line: string): string[] {
  const text = line.replace(/^\s*(?:\d{1,2}[.)]|[-*•])\s+/, '').trim().slice(-1200);
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!'.!?'.includes(text[i])) continue;
    // The end of a sentence: the marks, any closing quote or emphasis, then
    // a space or the end. Not the dot in "convex.dev" or "v1.2".
    let end = i + 1;
    while (end < text.length && '.!?"”\'’*_)`'.includes(text[end])) end++;
    if (end < text.length && !/\s/.test(text[end])) continue;
    out.push(tidy(text.slice(start, end)));
    start = end;
    i = end - 1;
  }
  if (start < text.length) out.push(tidy(text.slice(start)));
  return out.filter(Boolean);
}

// A closing quote stays on, so words the agent is quoting (someone asks "how
// is this different?") don't end in the question mark and aren't its question.
function tidy(sentence: string): string {
  return sentence.trim().replace(/^[*_`(]+/, '').replace(/[*_`)\s]+$/, '');
}

export const REPLY_ASKS = 'Your reply closes by asking the user something';
export function replyAsksNudge(sentence: string): string {
  const quoted = sentence.length > 160 ? `${sentence.slice(0, 160)}…` : sentence;
  return (
    `${REPLY_ASKS} ("${quoted}"), but your end_turn said nothing is needed, so the thread shows as done with no card to answer on. ` +
    'If you need their answer before you can go on, call end_turn again now with needs "you" and that question in asks, one entry per question, each with its likely answers: asks: [{ question, options: [{ label }] }] (a go-ahead takes "Go" and "Not yet"). ' +
    "Your message above is the reply: don't write it again, and write nothing else. " +
    'If it needs no answer from them, stop here with no more text.'
  );
}

// A reply linking files that aren't there (highlights.ts, missingFileLinks),
// sent back once by the Stop hook (adapter.ts, onStop) to find them and end
// again. The end_turn that follows is taken and asks for a whole new reply
// (runner.ts, replyRewrite), which the apps show in this one's place.
export function missingLinksNudge(paths: string[], asking = false): string {
  const listed = paths.slice(0, 5).map((p) => `\`${p}\``).join(', ');
  return (
    `Your reply links ${paths.length === 1 ? "a file that isn't" : "files that aren't"} on this Mac: ${listed}. ` +
    "Find where each one really is (or take the link off if it doesn't exist), then call end_turn again with the card you meant" +
    (asking ? ' (your reply asks the user something, so make that its ask, with needs "you")' : '') +
    ', and write your reply after it with the paths fixed. That reply takes the place of the one above.'
  );
}

// What a compaction between an accepted one-reply end_turn and its reply
// adds after the summary (adapter.ts, onCompact), with the card's
// questions, as the summary may not have them.
export function owedReplyAfterCompact(questions: string[]): string {
  const card = questions.length ? ` The card under it asks: ${questions.map((q) => `"${q}"`).join(', ')}.` : '';
  return (
    'Before this conversation was compacted you called end_turn, it was accepted, and you had not yet written your reply.' +
    card +
    " Write the reply now, as ordinary text, before any tool call: it's the only text the user sees from that turn. " +
    'Nothing you wrote before end_turn reached them, so whatever the card is about (a plan, a draft, the options) goes in it in full. Then stop.'
  );
}

// A reply that ends in a "What I need from you" section, or a "Nothing
// needed from you" line, comes apart into the reply above it and what the
// section says (needsFromText). With one reply, Sonnet wrote the section
// into its reply in 4 of 16 eval sessions and left end_turn's asks empty,
// so a turn whose end_turn has no asks or follow-ups takes its card from
// here, and the reply loses the section the card now shows. The heading
// may be a line on its own with no bold or #, as Sonnet wrote it.
// Each optional mark after it takes the whitespace before it, so no two
// runs of whitespace meet (that was O(n^4) on a run of spaces, F26).
const BARE_HEADING = /^\s*(?:#{1,6}\s+)?(?:\*\*\s*)?What I need from you(?:\s*:)?(?:\s*\*\*)?(?:\s*:)?\s*$/i;
export function splitReplySection(reply: string): { reply: string; needs?: Needs } {
  const lines = reply.replace(/\r\n/g, '\n').split('\n');
  const from = Math.max(0, lines.length - NEAR_END_LINES);
  for (let i = lines.length - 1; i >= from; i--) {
    const m = headingOf(lines[i]);
    const heading = BARE_HEADING.test(lines[i]) || (m && ((m[2] && m[3]) || (m[1] && !m[2])));
    if (!heading) continue;
    const section = lines.slice(i);
    // A bare heading becomes a bold one so needsFromText reads it.
    section[0] = `**What I need from you:** ${(m?.[4] ?? '').trim()}`.trimEnd();
    const needs = needsFromText(section.join('\n'));
    if (!needs) return { reply };
    const above = lines.slice(0, i).join('\n').trimEnd();
    // A reply that is only a section saying nothing is needed stays as
    // written (withoutNothingLine): better those words than none.
    return { reply: above.trim() || needs.needs === 'you' ? above : reply, needs };
  }
  for (let i = from; i < lines.length; i++) {
    if (!NOTHING_LINE.test(lines[i]) || !/^\W*nothing/i.test(lines[i].replace(/^[\s*_#>-]+/, ''))) continue;
    const needs = needsFromText(lines.slice(i).join('\n'));
    return needs ? withoutNothingLine(reply, lines, i, needs) : { reply };
  }
  return { reply };
}

// A reply without its closing "Nothing needed from you" line and the
// follow-ups listed under it, when that is all the line and what follows it
// are. The line used to take the rest of the reply with it, whatever that
// was: on 21 Nov 2026 (thread 649fc651) Mike asked "Anything you need from
// me here?", the reply opened "Nothing needed from you." and went on for two
// paragraphs, and all of it came off, so he got a blank answer. Some 60
// replies before it that month lost words on the line that the card never
// showed ("This will pick up again on its own on 23 Nov.", "...apart from
// posting that in Slack when you're ready.").
//
// So the section comes off only when the done card shows all of it, and
// there is a reply above it:
// - the line says no more than that, and isn't indented as code;
// - a list straight under it, with no lead-in, is the card's rows: every
//   item is one line and one row (the card holds three), and the row is
//   the item as written;
// - and nothing but blank lines comes after.
// Otherwise the reply stays as written, under the same card. A lead-in
// keeps it whole however short ("Two follow-ups are worth doing:"), as no
// rule told that from news with a list under it ("Everything is on hold
// until Ian says what's next:", "Only after the backup finishes:"): all
// ten replies that month with a list under the line had a lead-in or more
// on the line, and four of the lists weren't follow-ups at all. (Codex and
// Gemini reviewed two cuts of this that took more off, and each time
// found words still lost.)
const ONLY_NOTHING = /^nothing (?:else )?(?:is )?needed from you(?: (?:right now|for now|just now|yet|here|at the moment|at this point))?[.!]?$/i;
function withoutNothingLine(reply: string, lines: string[], i: number, needs: Needs): { reply: string; needs: Needs } {
  const line = lines[i].replace(/[*_`]+/g, '').replace(/^[\s#>-]+/, '').trimEnd();
  const list = listAfter(lines.slice(i + 1));
  const above = lines.slice(0, i).join('\n').trimEnd();
  const closes = !lines.slice(i + 1 + list.end).some((l) => l.trim());
  // A line under an item (more words, a command, an indented item) is read into it.
  const oneLineEach = lines.slice(i + 1, i + 1 + list.end).filter((l) => l.trim()).length === list.items.length;
  const shown = !list.lead && oneLineEach && needs.next?.length === list.items.length && list.items.every((item) => nextRow(item).all);
  const only = ONLY_NOTHING.test(line) && !/^(?: {4}|\t)/.test(lines[i]);
  return only && closes && (!list.items.length || shown) && above.trim() ? { reply: above, needs } : { reply, needs };
}

// A reply under a card of asks, without a closing section that writes the
// card out again. Opus does this despite the description and end_turn's result
// both saying not to, and the repeat reads as the card not having been used
// (thread 7ac017b7, 3 Nov 2026). A section listing more than the card has
// stays, as the extra ask is nowhere else: better a repeat than a lost request.
// Prose after the list stays too: three of that thread's six had a follow-up
// there, and a card of asks doesn't show follow-ups.
export function replyWithoutRepeat(reply: string, card: Needs): string {
  const whole = reply.replace(/\r\n/g, '\n');
  const split = splitReplySection(whole);
  const asked = split.needs?.needs === 'you' ? split.needs.asks?.length ?? 0 : 0;
  if (!asked || asked > (card.asks?.length ?? 0)) return reply;
  const after = proseAfterList(whole.slice(split.reply.length).split('\n'));
  return after ? `${split.reply}\n\n${after}` : split.reply;
}

// What follows a section's list, by the same reading as needsFromText, which
// stops there as it isn't an ask.
function proseAfterList(lines: string[]): string {
  let seen = false;
  let inItem = false;
  let inFence = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && itemOf(line)) seen = inItem = true;
    else if (!line.trim()) inItem = false;
    else if (seen && !inItem && !inFence && !/^\s{2,}\S/.test(line)) return lines.slice(i).join('\n').trimEnd();
  }
  return '';
}

// What end_turn says when the turn has no reply yet. An error result, so
// the CLI doesn't take the call as the end of the turn (adapter.ts,
// CLAUDE_CODE_TERMINAL_MCP_TOOLS) and the agent reads it. Ask for the whole
// answer, as a shorter reminder once got Mike only a closing line.
// Describe the result he needs: wording that asks for internal reasoning
// can trigger a provider safeguard even during ordinary work. An agent
// that believed it had written its answer read the old wording as the
// check being broken (a refused end_turn counted as its tool result),
// wrote one line about that, and Mike never got the answer (28 Oct 2026):
// so say a refusal isn't a tool result, and that an answer it thinks it
// gave never arrived.
export const NO_REPLY =
  "Not ended: the user hasn't had a reply this turn. No message text from you has reached them since their latest message and your latest tool result (a refused end_turn isn't a tool result). " +
  "If you think you already answered, they haven't seen any of it. " +
  'Please write the whole answer as ordinary text, with the result and any supporting evidence the user needs. Then call end_turn again.';

// What an accepted end_turn adds when the turn's reply reached Mike only
// as a narration block's summary (TurnReply.narrationOnly), and end_turn
// brought no summary bullets of its own. On 29 Oct 2026 a step-by-step
// walkthrough reached him as "I've resent the full step-by-step setup
// instructions...", twice (thread 66935d23): the agent had written it in
// a narration block, which the API sends only summarised. Each time the
// agent wrote the whole thing again after end_turn anyway, and the runner
// dropped it as a repeat. Now the runner keeps that text in the summary's
// place (runner.ts, onOutput), and this asks for it. A text block with no
// tool call after it is never narration, so "nothing after it" matters.
export const NARRATION_ONLY =
  'The user got only a short summary of your last message, not its words. ' +
  'Write the whole message again now, as ordinary text with nothing after it: it takes the summary\'s place.';

// What an accepted end_turn with summary bullets adds when the turn has
// no message of its own since its last step, so the bullets are all the
// user has. On 30 Oct 2026 (thread 2a0a9c2c) Mike asked for the details
// he needed for a call to Qantas, and Opus called end_turn first, with
// "Put together the details you'll need for the call" as a bullet. Told
// to stop, it wrote the details anyway, and the runner dropped them as a
// repeat, twice: he got bullets pointing at nothing. Whether the bullets
// stand for words not yet written is for the agent to say, as no wording
// gives it away ("put together", "here are", "below"). The runner keeps
// the one message that follows when it says more than the bullets
// (runner.ts, owedReply), and the app shows it as the reply
// (TranscriptReducer, reply(of:)).
// It used to ask outright whether the bullets stood for a message not
// yet written. Agents took that as "write one": all 14 bullets-only
// turns in the next four hours wrote a prose repeat of their bullets,
// which then showed in place of them (30 Oct 2026). So it only says to
// stop, in words the runner can tell apart from the other results; an
// agent that meant to write its answer after end_turn, as the Qantas one
// did when told to stop, still has it kept.
export const BULLETS_ONLY = 'Stop here, with no more text: the user has your bullets';

// Whether an accepted end_turn's result was the bullets-only one
// (BULLETS_ONLY), whose next message the runner keeps.
export function endTurnOwesReply(result: { text: string }): boolean {
  return result.text.includes(BULLETS_ONLY);
}

// With bullet replies off, a turn whose message came as a narration block
// is asked for it again even with bullets (threadbear-mcp.ts). The message
// lands under them, so any length of it is kept, as the app shows it
// whatever its length (TranscriptReducer, reply(of:)).
export function endTurnAsksForMessage(result: { text: string }): boolean {
  return result.text.includes(NARRATION_ONLY);
}

// How every accepted end_turn result starts, so the runner can tell one
// from a refusal by what it says (a refusal's ok flag is only as good as
// the provider's) and drop text written after it.
export const ENDED = 'Noted: this thread';

export function endTurnAccepted(result: { ok: boolean; text: string }): boolean {
  return result.ok && result.text.startsWith(ENDED);
}

// Added to an accepted end_turn's result while subagents wait on Mike's cards.
export function openCardsNote(titles: string[]): string {
  if (!titles.length) return '';
  const shown = titles.slice(0, 3).map((t) => `"${t.slice(0, 120)}"`).join(', ');
  const more = titles.length > 3 ? ` and ${titles.length - 3} more` : '';
  return ` ${titles.length === 1 ? 'A sub-agent of yours is' : `${titles.length} of your sub-agents are`} parked until the user answers an approval card in this thread, not working: ${shown}${more}. Say so in your reply, rather than calling them running.`;
}

// An end_turn the handler took, Claude's (ENDED) or Codex's ("Noted. Now
// write your final answer"), as opposed to one it refused.
export function endTurnTaken(result: { ok: boolean; text: string }): boolean {
  return result.ok && result.text.startsWith('Noted');
}

// The input of the end_turn this turn has already taken, so a second is
// refused: Opus once sent its card four times (29 Oct 2026). A message since
// the call opens the turn again, as it's owed an answer and maybe a card of
// its own: on 1 Nov 2026 Mike's "Archive" from the phone landed just after
// end_turn, and the agent couldn't call it again to do what he asked (thread
// cdfccbc3). The message goes in the events before the CLI gets it, so the
// agent can't have seen one that isn't there yet. One that came while the call
// ran counts too, as the agent called it without having read that message.
// A background task finishing mid-turn (a system.note with wake) opens it too,
// from when the agent has read it (wakeRead). On 7 Nov 2026 a backgrounded
// `tb land` finished just before the agent's "landing now" end_turn, and the
// real report's end_turn was refused (thread 46de9389).
export function takenEndTurn(events: PersistedEvent[], serverName = 'threadbear'): Record<string, unknown> | undefined {
  const endTurn = `mcp__${serverName}__${END_TURN_TOOL}`;
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn.started') {
      start = i + 1;
      break;
    }
  }
  const calls = new Map<string, Record<string, unknown>>();
  let taken: Record<string, unknown> | undefined;
  const wake = new WakeRead();
  for (const e of events.slice(start)) {
    if (e.type === 'user.message' || wake.see(e)) {
      calls.clear();
      taken = undefined;
    }
    if (e.type === 'tool.call' && e.name === endTurn) calls.set(e.itemId, e.input);
    if (e.type === 'tool.result' && !taken && endTurnTaken(e)) taken = calls.get(e.itemId);
  }
  // Handed over with no step of the agent's since: the SDK can run this call
  // before its own frames reach the events, so it is that step (from Codex's
  // review).
  if (wake.handed) return undefined;
  return taken;
}

// When the agent has read a background task's notification that came into
// its turn (a system.note with wake), fed the turn's events in order. The CLI
// hands it over with the next request to the model, after the next tool
// results: the text and calls of the response that was being written when it
// came weren't written with it, nor were tool results in the same batch, so
// it counts from the agent's first step after a result (see() is true then).
// Shared by takenEndTurn, the runner's turn and the Claude adapter's Stop
// hook, so all three open the turn at the same event.
export class WakeRead {
  private state: 'none' | 'unread' | 'handed' = 'none';
  // One that came while another was handed over: the request may have gone
  // to the model before it, so it waits for results of its own (from Codex's
  // review). At worst that opens the turn once more than needed.
  private next = false;
  // A result in the batch that hands it over (before or after the note) was
  // an end_turn saying "Now write your reply": the text the agent writes next
  // is that reply, not something it did about the notice, so only a tool call
  // after it opens the turn. Cleared at each of the agent's steps otherwise. On 11 Nov 2026 an
  // ffmpeg job's exit came with that answer; the reply counted as reading it,
  // the Stop hook asked for end_turn again, and the "Done." written after the
  // second one took the reply's place (thread dcdc60a3).
  private batchReply = false;
  get handed(): boolean {
    return this.state === 'handed';
  }
  // The agent's own end_turn calls, so only their results count for
  // batchReply, not a command's output that quotes one (from Codex's review).
  private endTurns = new Set<string>();
  see(e: { type: string; itemId?: string; name?: string; wake?: true; ok?: boolean; text?: string }): boolean {
    if (e.type === 'tool.call' && e.itemId && e.name?.endsWith(`__${END_TURN_TOOL}`) && !e.itemId.includes('/')) this.endTurns.add(e.itemId);
    if (e.type === 'system.note' && e.wake) {
      if (this.state === 'handed') this.next = true;
      else this.state = 'unread';
      return false;
    }
    // Any result in the batch, before the note as well as after it (from
    // Codex's review).
    if (e.type === 'tool.result' && e.itemId && this.endTurns.has(e.itemId) && typeof e.text === 'string' && endTurnWantsReply({ ok: e.ok === true, text: e.text })) this.batchReply = true;
    if (e.type === 'tool.result' && this.state === 'unread') this.state = 'handed';
    // A Codex child's items (<child>/<id>) aren't the agent's own steps.
    else if ((e.type === 'assistant.text' || e.type === 'reasoning' || e.type === 'tool.call') && !e.itemId?.includes('/')) {
      if (this.state !== 'handed') {
        this.batchReply = false;
        return false;
      }
      if (this.batchReply && e.type !== 'tool.call') return false;
      this.batchReply = false;
      this.state = this.next ? 'unread' : 'none';
      this.next = false;
      return true;
    }
    return false;
  }
  reset(): void {
    this.state = 'none';
    this.next = false;
    this.batchReply = false;
    this.endTurns.clear();
  }
}

// What end_turn says to a call the agent wrote before it could have read a
// message the user sent into the turn. The CLI holds such a message until the
// response being written is finished and its tools have run, so a card in
// that response can't be about it. On 13 Nov 2026 (thread 0222c475) Mike's
// "Should we get it into production?" landed 30 ms before the end_turn that
// closed off his last answers, with needs "nothing". The agent read it with
// "Now write your reply", thought "I've already ended my turn, so I can't ask
// him for approval", and wrote "Say go and I'll merge main into prod" over a
// done card; a second end_turn would have been refused as a repeat, as the
// message was in the events before the call. Refused, the call costs one
// more, and the card that follows covers the message too. Only Claude's CLI
// says when it hands a message over (adapter.ts, unreadMessage).
// A sub-agent's end_turn mustn't use the refusal up, so only a call that
// has reached the thread's events is checked (threadbear-mcp.ts).
export const UNREAD_MESSAGE = 'Not ended: the user sent a message while you were writing this call, and you have not read it yet.';
export function unreadMessageRefusal(): string {
  // Not "answer it": with one reply the answer comes after end_turn, and
  // one written before it is hidden with the work (from Codex's review).
  return `${UNREAD_MESSAGE} It comes with this result. Read it and do any work it asks for, then call end_turn again as you normally would, for the turn as a whole.`;
}

// That refusal, read back: the call's card was written without the message,
// so the runner doesn't keep it for a turn that ends with no other (runner.ts).
export function endTurnRefusedUnread(result: { text: string }): boolean {
  return result.text.startsWith(UNREAD_MESSAGE);
}

export function endedThisTurn(events: PersistedEvent[], serverName = 'threadbear'): boolean {
  return takenEndTurn(events, serverName) !== undefined;
}

// What the Claude adapter's Stop hook sends back, once, to a turn that
// ended without end_turn (adapter.ts, onStop). The reply already written
// stands, so it asks for the call alone: a fresh message would sit under
// the real answer as the reply.
export const END_TURN_NUDGE =
  'This turn ended without end_turn, so Threadbear has no summary or card for it. ' +
  'Call end_turn now (load it with ToolSearch first if you need to), with the summary, needs, and any asks or next follow-ups from what you just wrote. ' +
  "Your message above is the reply: don't write it again, and write nothing after end_turn.";

export const ALREADY_ENDED = 'Already ended: this turn has had its end_turn, and the user has its summary and asks. Stop here, with no more text.';

// A repeat end_turn that only adds archive: the card that was taken stands
// (runner.ts, onOutput). The repeat could always do this, by accident, under a
// result saying it had been refused. Not ENDED or "Noted": the runner would
// take it for a new end_turn, and write its summary out a second time.
export const ARCHIVE_ADDED = 'Added: this thread will be archived once the turn is over, and the rest of your end_turn stands. If you have written your reply, stop here with no more text.';

// The same for a repeat that only adds snooze (or changes when to wake).
export const SNOOZE_ADDED = 'Added: this thread will hibernate once the turn is over, and the rest of your end_turn stands. If you have written your reply, stop here with no more text.';

export function endTurnRefusedRepeat(result: { text: string }): boolean {
  return result.text.startsWith(ALREADY_ENDED);
}

export function endTurnAddedArchive(result: { ok: boolean; text: string }): boolean {
  return result.ok && result.text === ARCHIVE_ADDED;
}

export function endTurnAddedSnooze(result: { ok: boolean; text: string }): boolean {
  return result.ok && result.text === SNOOZE_ADDED;
}

// Whether the turn so far has given Mike a reply, for end_turn to check
// before it ends the turn. An agent that drafted its answer in thinking
// and went straight to end_turn left him a folded work group and a card
// of asks, twice in one thread (28 Oct 2026). Those answers, and the
// replies refused on 29 Oct, were thinking blocks signed as narration,
// which the Claude normaliser now makes assistant.text (isNarration);
// this still refuses a turn whose only words were thinking. `events` are the thread's
// recent ones, oldest first; only those after the last turn.started count.
export type TurnReply = {
  // This end_turn call has reached the events (a tool.call for it with no
  // result yet). The CLI writes a call before it runs the tool, so once it
  // is there, so is everything the agent said before it.
  landed: boolean;
  // The agent's own assistant.text after its last tool result from a tool
  // outside the threadbear server, and after the last message from Mike in
  // the turn. The thread's own tools (pin, update_project, an earlier
  // refused end_turn) say nothing he has to read, so a message, then pin,
  // then end_turn is a turn that replied.
  replied: boolean;
  // Every text that counted for `replied` was a summary (a Claude
  // narration block, which reaches the runner only as the API's summary
  // of what the agent wrote), or the last one was and nothing in words
  // followed the last tool call: Mike has a paragraph about the reply,
  // not the reply. end_turn asks for it again (NARRATION_ONLY).
  narrationOnly?: true;
};

// Tools that do nothing Mike would want told about. ToolSearch loads a
// deferred tool's schema (end_turn's, as often as not: "Hello.", then
// ToolSearch for end_turn, then end_turn was refused for having worked
// since the reply).
const PLUMBING_TOOLS = new Set(['ToolSearch']);

export function turnReply(events: PersistedEvent[], serverName = 'threadbear'): TurnReply {
  const ownPrefix = `mcp__${serverName}__`;
  const endTurn = `${ownPrefix}${END_TURN_TOOL}`;
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn.started') {
      start = i + 1;
      break;
    }
  }
  const names = new Map<string, string>();
  const open = new Set<string>(); // end_turn calls with no result yet
  let lastText = 0;
  let lastWords = 0; // the last text that wasn't a summary
  let lastWork = 0;
  let lastTool = 0; // the last result from any tool but end_turn
  let lastUser = 0;
  for (const e of events.slice(start)) {
    // A Codex child's items carry its prefix (<child>/<id>); Claude's
    // sub-agents never reach the thread's events.
    if ('itemId' in e && typeof e.itemId === 'string' && e.itemId.includes('/')) continue;
    switch (e.type) {
      case 'user.message':
        lastUser = e.seq;
        break;
      case 'assistant.text':
        lastText = e.seq;
        if (!e.narration) lastWords = e.seq;
        break;
      case 'tool.call':
        names.set(e.itemId, e.name);
        if (e.name === endTurn) open.add(e.itemId);
        break;
      case 'tool.result': {
        const name = names.get(e.itemId);
        open.delete(e.itemId);
        if (name !== undefined && !name.startsWith(ownPrefix) && !PLUMBING_TOOLS.has(name)) lastWork = e.seq;
        // ToolSearch too: a status line, ToolSearch for end_turn, then the
        // answer as narration left the status line standing as the reply
        // (Codex's review of the 5 Nov 2026 fix, below).
        if (name !== undefined && name !== endTurn) lastTool = e.seq;
        break;
      }
      default:
        break;
    }
  }
  const since = Math.max(lastWork, lastUser);
  const replied = lastText > 0 && lastText > since;
  // Or the last text was narration, with no words since the last tool of
  // any kind: on 29 Oct 2026 a status line, then read_thread, then the
  // whole explanation as narration, counted as words, so end_turn didn't
  // ask for it again, and the text after end_turn (a repeat of the card)
  // took the narration's place. Words just before the narration, with no
  // tool between, are the reply, so they still count.
  const lastIsNarration = lastText > lastWords && lastWords < lastTool;
  return { landed: open.size > 0, replied, ...(replied && (lastWords <= since || lastIsNarration) ? { narrationOnly: true as const } : {}) };
}
