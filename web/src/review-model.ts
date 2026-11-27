// A design review as the comparison board, the part with no React in it:
// what the runner sends (phone:designReviews' JSON), the answer's draft
// (picks, notes, the reply, None of them, and the browser's own marks), the
// board's layout and tour, the camera, and the agent's ink. A port of the
// iPhone's ThreadbearKit DesignReviews.swift and Threadbear/ReviewCanvas.swift,
// which port desktop/core/src/review_canvas.rs, the source of truth. The
// board is in world units, where a picture is 640 wide; the camera maps them
// to the screen (screen = world × s + t).
//
// node --test web/src/review-model.test.ts

// ------------------------------------------------------------ what the runner sends

export type AgentMark = { kind: string; box: number[]; note?: string; ink?: string };
export type ReviewShot = { src: string; title?: string; kind: string; preview?: boolean; marks?: AgentMark[]; media?: string };
export type ReviewOption = { id: string; title: string; note?: string; reference?: boolean; shots: ReviewShot[] };

// The browser's own mark: a circle, highlight or pin on part of a shot's
// still, box as fractions of it. `n` is what "[Mark n]" in the reply points
// at. `path` is the stroke as drawn, to draw it again; it isn't sent.
export type UserMark = { n: number; kind: 'circle' | 'highlight' | 'pin'; optionId: string; shot: number; box: number[]; path?: number[][] };

export type ReviewDraft = {
  pickedId?: string;
  pickedIds?: string[];
  notes: Record<string, string>;
  reply?: string;
  none?: boolean;
  // The browser's own marks, added to the Mac's saved ones. Never read from
  // the runner's draft: a Mac's marks point at its own cut-outs.
  marks?: UserMark[];
  // The highest number among the Mac's saved marks, and how many there are:
  // the browser numbers its own on from there, sharing the cap of 20.
  nextMark?: number;
  markCount?: number;
};

export type DesignReview = {
  id: string;
  title: string;
  note?: string;
  recommended?: string;
  status: string;
  revision: number;
  draft: ReviewDraft;
  options: ReviewOption[];
  // Whether this thread's runner takes marks from the phone and the website.
  canMark?: boolean;
};

export type ReviewListResult = { reviews?: { id: string; title: string }[]; review?: DesignReview; truncated?: boolean };

/** The runner refuses more marks in one answer. */
export const MAX_MARKS = 20;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readMark(v: unknown): AgentMark | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  const box = Array.isArray(m.box) ? m.box : [];
  if (typeof m.kind !== 'string' || box.length !== 4 || !box.every(finite)) return undefined;
  return { kind: m.kind, box: box as number[], ...(str(m.note) ? { note: str(m.note) } : {}), ...(str(m.ink) ? { ink: str(m.ink) } : {}) };
}

function readShot(v: unknown): ReviewShot | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as Record<string, unknown>;
  if (typeof s.src !== 'string' || typeof s.kind !== 'string') return undefined;
  // A mark the browser can't read (a newer kind's shape, a bad box) is
  // dropped rather than losing the whole review.
  const marks = Array.isArray(s.marks) ? s.marks.map(readMark).filter((m): m is AgentMark => !!m) : undefined;
  return {
    src: s.src,
    kind: s.kind,
    ...(str(s.title) ? { title: str(s.title) } : {}),
    ...(typeof s.preview === 'boolean' ? { preview: s.preview } : {}),
    ...(marks ? { marks } : {}),
    ...(str(s.media) ? { media: str(s.media) } : {}),
  };
}

function readDraft(v: unknown): ReviewDraft {
  const d = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const notes: Record<string, string> = {};
  if (d.notes && typeof d.notes === 'object' && !Array.isArray(d.notes)) {
    for (const [k, text] of Object.entries(d.notes)) if (typeof text === 'string') notes[k] = text;
  }
  const ids = Array.isArray(d.pickedIds) ? d.pickedIds.filter((x): x is string => typeof x === 'string') : undefined;
  return {
    notes,
    ...(str(d.pickedId) ? { pickedId: str(d.pickedId) } : {}),
    ...(ids ? { pickedIds: ids } : {}),
    ...(str(d.reply) !== undefined ? { reply: str(d.reply) } : {}),
    ...(d.none === true ? { none: true } : {}),
    ...(finite(d.nextMark) ? { nextMark: d.nextMark } : {}),
    ...(finite(d.markCount) ? { markCount: d.markCount } : {}),
  };
}

function readReview(v: unknown): DesignReview | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.status !== 'string' || !finite(r.revision) || !Array.isArray(r.options)) return undefined;
  const options: ReviewOption[] = [];
  for (const o of r.options) {
    if (!o || typeof o !== 'object') return undefined;
    const x = o as Record<string, unknown>;
    if (typeof x.id !== 'string' || !Array.isArray(x.shots)) return undefined;
    options.push({
      id: x.id,
      title: str(x.title) ?? x.id,
      ...(str(x.note) ? { note: str(x.note) } : {}),
      ...(x.reference === true ? { reference: true } : {}),
      shots: x.shots.map(readShot).filter((s): s is ReviewShot => !!s),
    });
  }
  return {
    id: r.id,
    title: str(r.title) ?? 'Design review',
    status: r.status,
    revision: r.revision,
    draft: readDraft(r.draft),
    options,
    ...(str(r.note) ? { note: str(r.note) } : {}),
    ...(str(r.recommended) ? { recommended: str(r.recommended) } : {}),
    ...(r.canMark === true ? { canMark: true } : {}),
  };
}

/** phone:command's result for a designReviews command: JSON text (or, from a
 * backend that parsed it, the object). Undefined when it can't be read. */
export function parseReviewResult(result: unknown): ReviewListResult | undefined {
  let v = result;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (r.review !== undefined) {
    const review = readReview(r.review);
    return review ? { review } : undefined;
  }
  if (Array.isArray(r.reviews)) {
    const reviews = r.reviews.flatMap((e) => (e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string' ? [{ id: (e as { id: string }).id, title: str((e as { title?: unknown }).title) ?? 'Design review' }] : []));
    return { reviews, ...(r.truncated === true ? { truncated: true } : {}) };
  }
  return undefined;
}

/** Every still and media src, for phone:reviewImages. */
export function reviewSources(review: DesignReview): string[] {
  return [...new Set(review.options.flatMap((o) => o.shots.flatMap((s) => (s.media && s.kind !== 'page' ? [s.src, s.media] : [s.src]))))].sort();
}

export const isPending = (review: DesignReview) => review.status === 'pending';

// ------------------------------------------------------------ the draft

export function markToken(n: number): string {
  return `[Mark ${n}]`;
}

/** The first number the browser may give a mark. */
export function firstMarkNumber(d: ReviewDraft): number {
  return Math.max(0, d.nextMark ?? 0) + 1;
}

/** How many marks the browser may have, after the Mac's. */
export function markCapacity(d: ReviewDraft): number {
  return Math.max(0, MAX_MARKS - Math.max(0, d.markCount ?? d.nextMark ?? 0));
}

/** The lowest number the browser can still give a mark, or undefined when there's no room. */
export function nextMarkNumber(d: ReviewDraft): number | undefined {
  const marks = d.marks ?? [];
  if (marks.length >= markCapacity(d)) return undefined;
  const used = new Set(marks.map((m) => m.n));
  let n = firstMarkNumber(d);
  while (used.has(n)) n++;
  return n;
}

/** How many of the browser's marks are over the cap, after the Mac added some. */
export function marksOver(d: ReviewDraft): number {
  return Math.max(0, (d.marks ?? []).length - markCapacity(d));
}

/** Takes the Mac's marks as a freshly loaded review has them. A mark of the
 * browser's whose number the Mac has since used is numbered on from the
 * Mac's, and the reply's "[Mark n]" follow it. */
export function takeMacMarks(d: ReviewDraft, fresh: ReviewDraft): ReviewDraft {
  const out: ReviewDraft = { ...d };
  if (fresh.nextMark !== undefined) out.nextMark = fresh.nextMark;
  else delete out.nextMark;
  if (fresh.markCount !== undefined) out.markCount = fresh.markCount;
  else delete out.markCount;
  const first = firstMarkNumber(out);
  const mine = [...(d.marks ?? [])];
  if (!mine.length || !mine.some((m) => m.n < first)) return out;
  mine.sort((a, b) => a.n - b.n);
  // Through placeholders, so a new number that an old one had isn't rewritten twice.
  let text = d.reply;
  mine.forEach((m, i) => {
    text = text?.split(markToken(m.n)).join(`\u0001${i}\u0001`);
  });
  out.marks = mine.map((m, i) => ({ ...m, n: first + i }));
  out.marks.forEach((m, i) => {
    text = text?.split(`\u0001${i}\u0001`).join(markToken(m.n));
  });
  if (text !== undefined) out.reply = text;
  return out;
}

/** What a freshly loaded review shows: an answered one exactly as the runner
 * keeps it; a pending one the browser's own draft if there is one (`kept`),
 * brought up to date with the Mac's marks. */
export function reopening(loaded: DesignReview, kept?: ReviewDraft): ReviewDraft {
  if (!isPending(loaded)) return loaded.draft;
  return takeMacMarks(kept ?? loaded.draft, loaded.draft);
}

export function picks(d: ReviewDraft): Set<string> {
  return new Set(d.pickedIds ?? (d.pickedId ? [d.pickedId] : []));
}

export function pick(d: ReviewDraft, id: string, selected: boolean): ReviewDraft {
  const chosen = picks(d);
  const out = { ...d };
  if (selected) {
    chosen.add(id);
    delete out.none;
  } else chosen.delete(id);
  out.pickedIds = [...chosen].sort();
  if (out.pickedIds[0] !== undefined) out.pickedId = out.pickedIds[0];
  else delete out.pickedId;
  return out;
}

export function pickNone(d: ReviewDraft, selected: boolean): ReviewDraft {
  const out = { ...d };
  if (selected) {
    out.none = true;
    delete out.pickedId;
    delete out.pickedIds;
  } else delete out.none;
  return out;
}

const blank = (s: string | undefined) => !(s ?? '').trim();

function marksFit(d: ReviewDraft, review: DesignReview): boolean {
  const marks = d.marks ?? [];
  if (!marks.length) return true;
  if (marks.length > markCapacity(d) || new Set(marks.map((m) => m.n)).size !== marks.length) return false;
  const first = firstMarkNumber(d);
  return marks.every((m) => {
    // A reference is there to compare against, not to answer on.
    const option = review.options.find((o) => o.id === m.optionId);
    return m.n >= first && !!option && !option.reference && m.shot >= 0 && m.shot < option.shots.length && m.box.length === 4 && m.box.every((x) => Number.isFinite(x) && x >= 0 && x <= 1);
  });
}

export function canSend(d: ReviewDraft, review: DesignReview): boolean {
  const known = new Set(review.options.map((o) => o.id));
  const pickable = new Set(review.options.filter((o) => !o.reference).map((o) => o.id));
  const chosen = picks(d);
  if (!isPending(review) || !Number.isSafeInteger(review.revision) || review.revision < 0) return false;
  if ([...chosen].some((id) => !pickable.has(id)) || Object.keys(d.notes).some((id) => !known.has(id))) return false;
  if (d.none && chosen.size) return false;
  if ((d.reply?.length ?? 0) > 8000 || Object.values(d.notes).some((n) => n.length > 4000)) return false;
  if (!marksFit(d, review)) return false;
  return chosen.size > 0 || d.none === true || (d.marks ?? []).length > 0 || !blank(d.reply) || Object.values(d.notes).some((n) => !blank(n));
}

/** What Send will send, as the Mac's button says it. */
export function sendLabel(d: ReviewDraft, review: DesignReview, sending: boolean): string {
  if (sending) return 'Sending…';
  const chosen = picks(d);
  const ids = review.options.map((o) => o.id).filter((id) => chosen.has(id));
  if (ids.length) return `Send ${ids.join(' + ')}`;
  if (d.none) return 'Send none of them';
  return !blank(d.reply) || (d.marks ?? []).length || Object.values(d.notes).some((n) => n) ? 'Send reply' : 'Send';
}

export type MarkArgument = { n: number; kind: UserMark['kind']; optionId: string; shot: number; box: number[]; storageId?: string };
export type DraftArgument = { pickedId?: string; pickedIds?: string[]; notes: { id: string; text: string }[]; reply?: string; none?: boolean; marks?: MarkArgument[] };

/** phone:respondReview's draft. Notes go as a list: an option id can be any
 * text, and Convex refuses an object key that isn't plain ASCII or starts
 * with "$". `cutOuts` are the uploaded cut-outs by mark number. */
export function draftArgument(d: ReviewDraft, cutOuts: Map<number, string> = new Map()): DraftArgument {
  const out: DraftArgument = { notes: Object.keys(d.notes).sort().map((id) => ({ id, text: d.notes[id] ?? '' })) };
  if (d.pickedIds) out.pickedIds = d.pickedIds;
  else if (d.pickedId) out.pickedId = d.pickedId;
  if (d.reply !== undefined) out.reply = d.reply;
  if (d.none) out.none = true;
  // Only when there are some: a backend before API 106 refuses the field.
  if (d.marks?.length) {
    out.marks = [...d.marks]
      .sort((a, b) => a.n - b.n)
      .map((m) => {
        const storageId = cutOuts.get(m.n);
        return { n: m.n, kind: m.kind, optionId: m.optionId, shot: m.shot, box: m.box, ...(storageId ? { storageId } : {}) };
      });
  }
  return out;
}

/** Adds a mark and its "[Mark n]" to the reply, at the caret if there is
 * one (`at`, a selection in the reply), else on the end. Undefined when
 * there's no room for another. Gives the new caret too. */
export function addMark(d: ReviewDraft, mark: Omit<UserMark, 'n'>, at?: { start: number; end: number }): { draft: ReviewDraft; caret: number } | undefined {
  const n = nextMarkNumber(d);
  if (n === undefined) return undefined;
  const token = markToken(n);
  const text = d.reply ?? '';
  let reply: string;
  let caret: number;
  if (at && at.start >= 0 && at.end <= text.length && at.start <= at.end) {
    const before = text[at.start - 1];
    const after = text[at.end];
    const piece = (before === undefined || before === ' ' || before === '\n' ? '' : ' ') + token + (after === ' ' ? '' : ' ');
    reply = text.slice(0, at.start) + piece + text.slice(at.end);
    caret = at.start + piece.length;
  } else {
    const gap = !text || text.endsWith(' ') || text.endsWith('\n') ? '' : ' ';
    reply = `${text}${gap}${token} `;
    caret = reply.length;
  }
  return { draft: { ...d, marks: [...(d.marks ?? []), { ...mark, n }], reply }, caret };
}

export function removeMark(d: ReviewDraft, n: number): ReviewDraft {
  const out = { ...d };
  const marks = (d.marks ?? []).filter((m) => m.n !== n);
  if (marks.length) out.marks = marks;
  else delete out.marks;
  if (d.reply !== undefined) out.reply = d.reply.split(`${markToken(n)} `).join('').split(markToken(n)).join('');
  return out;
}

/** "A. Title", unless the title already starts with its letter. */
export function optionLabel(o: ReviewOption): string {
  const t = o.title;
  return t.startsWith(`${o.id}.`) || t.startsWith(`${o.id} `) || t === o.id ? t : `${o.id}. ${t}`;
}

// ------------------------------------------------------------ the layout

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

/** Label width in world units, reserving the fixed screen-space HTML pill
 * only when its row overlaps this title/caption. */
export function htmlLabelWidth(label: Rect, picture: Rect, scale: number): number {
  const top = picture.y - 32 / scale;
  return picture.w * scale >= 210 && label.y < top + 26 / scale && label.y + label.h > top
    ? Math.min(label.w, Math.max(0, picture.w - 220 / scale)) : label.w;
}

export const M = {
  pictureWidth: 640,
  gap: 22,
  shotGap: 48,
  captionHeight: 34,
  wordsSize: 22,
  noteSize: 36,
  noteGap: 96,
  noteWidth: 330,
  gutter: 96 + 330 + 130,
  haloPad: 40,
  titleRow: 52,
  titleGap: 10,
  titleSize: 26,
  letterSize: 230,
  letterLeft: 0.62,
  letterAbove: 0.86,
  leadWidth: 440,
  stagger: [0, 130, 50, 170],
  noteSpacing: 30,
  minZoom: 0.05,
  maxZoom: 3,
  // The tour never zooms past this.
  stopZoom: 1.4,
  flightMs: 650,
} as const;

export const maxX = (r: Rect) => r.x + r.w;
export const maxY = (r: Rect) => r.y + r.h;
export const midX = (r: Rect) => r.x + r.w / 2;
export const midY = (r: Rect) => r.y + r.h / 2;

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(maxX(a), maxX(b)) - x, h: Math.max(maxY(a), maxY(b)) - y };
}

export function inset(r: Rect, d: number): Rect {
  return { x: r.x + d, y: r.y + d, w: r.w - 2 * d, h: r.h - 2 * d };
}

export function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= maxX(r) && p.y >= r.y && p.y <= maxY(r);
}

/** A point given as fractions of a rect. */
export function at(r: Rect, fx: number, fy: number): Point {
  return { x: r.x + fx * r.w, y: r.y + fy * r.h };
}

/** A mark's box on a rect, unnormalised as the Mac's is (an arrow's box runs tail to head). */
export function part(r: Rect, box: number[]): Rect {
  if (box.length !== 4) return { x: 0, y: 0, w: 0, h: 0 };
  const a = at(r, box[0]!, box[1]!);
  const b = at(r, box[2]!, box[3]!);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

/** The same rect with a positive width and height. */
export function standard(r: Rect): Rect {
  return { x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) };
}

export type Measure = {
  // The height of words at wordsSize wrapped to a width.
  words: (text: string, width: number) => number;
  // A handwritten note's size at noteSize, wrapped to noteWidth.
  note: (text: string) => { w: number; h: number };
};

export type NotePlace = { mark: number; rect: Rect; target: Point; left: boolean };
export type ShotLayout = { option: number; shot: number; picture: Rect; caption: Rect; notes: NotePlace[] };
export type OptionLayout = { index: number; frame: Rect; words?: Rect; shots: ShotLayout[]; halo: Rect; title: Rect; letter: Rect };
export type BoardLayout = { lead?: Rect; options: OptionLayout[]; bounds: Rect };

export function shotExtent(s: ShotLayout): Rect {
  return s.notes.reduce((r, n) => union(r, n.rect), union(s.picture, s.caption));
}

export function optionExtent(o: OptionLayout): Rect {
  return o.shots.reduce((r, s) => union(r, shotExtent(s)), union(o.halo, o.letter));
}

/** A note goes left of its picture when its mark is on the picture's left part. */
export function noteGoesLeft(m: AgentMark): boolean {
  return (m.box[0]! + m.box[2]!) / 2 < 0.42;
}

/** Where a mark's pointer lands, on the side its note is. */
export function markTarget(picture: Rect, m: AgentMark): Point {
  const p = part(picture, m.box);
  const left = noteGoesLeft(m);
  const edge = left ? p.x : p.x + p.w;
  const out = left ? -1 : 1;
  switch (m.kind) {
    case 'circle':
      return { x: edge + out * (p.w * 0.21 + 8), y: p.y + p.h * 0.45 };
    case 'underline':
      return { x: edge + out * 10, y: p.y + p.h };
    case 'highlight':
      return { x: edge + out * 8, y: p.y + p.h / 2 };
    default:
      return { x: p.x + p.w / 2, y: p.y + p.h / 2 };
  }
}

// Notes in a column each side of their picture, level with their mark,
// nudged up so the curl arrives from below, pushed down so none overlap.
function placeNotes(picture: Rect, marks: AgentMark[], measure: Measure): NotePlace[] {
  const order = marks
    .map((_, i) => i)
    .filter((i) => !!marks[i]!.note)
    .sort((a, b) => markTarget(picture, marks[a]!).y - markTarget(picture, marks[b]!).y);
  let floorLeft = -Infinity;
  let floorRight = -Infinity;
  const placed: NotePlace[] = [];
  for (const i of order) {
    const m = marks[i]!;
    const size = measure.note(m.note ?? '');
    const t = markTarget(picture, m);
    const left = noteGoesLeft(m);
    const y = Math.max(t.y - size.h / 2 - 10, left ? floorLeft : floorRight);
    const x = left ? picture.x - M.noteGap - size.w : maxX(picture) + M.noteGap;
    const rect = { x, y, w: size.w, h: size.h };
    if (left) floorLeft = maxY(rect) + M.noteSpacing;
    else floorRight = maxY(rect) + M.noteSpacing;
    placed.push({ mark: i, rect, target: t, left });
  }
  return placed.sort((a, b) => a.mark - b.mark);
}

function needsLeftRoom(o: ReviewOption): boolean {
  return o.shots.some((s) => (s.marks ?? []).some((m) => !!m.note && noteGoesLeft(m)));
}

function layOption(index: number, option: ReviewOption, x: number, top: number, aspect: (s: ReviewShot) => number, measure: Measure): OptionLayout {
  const w = M.pictureWidth;
  const title = { x, y: top, w, h: M.titleRow };
  let y = maxY(title) + M.titleGap;
  const shots: ShotLayout[] = [];
  option.shots.forEach((shot, i) => {
    // Later pages always have a name over them ("2 of 3" if not their own);
    // the first only when it has its own.
    const captionH = i > 0 || shot.title ? M.captionHeight : 0;
    const caption = { x, y, w, h: captionH };
    const h = w / Math.max(0.05, aspect(shot));
    const picture = { x, y: maxY(caption) + (shot.kind === 'page' ? M.shotGap : 0), w, h };
    y = maxY(picture) + M.shotGap;
    shots.push({ option: index, shot: i, picture, caption, notes: placeNotes(picture, shot.marks ?? [], measure) });
  });
  y += M.gap - M.shotGap;
  let words: Rect | undefined;
  if (option.note?.trim()) {
    words = { x, y, w, h: measure.words(option.note, w) };
    y = maxY(words);
  }
  const frame = { x, y: top, w, h: y - top };
  const halo = inset(frame, -M.haloPad);
  const first = shots[0]?.picture ?? frame;
  const size = M.letterSize;
  const letter = { x: maxX(first) - size * M.letterLeft, y: first.y - size * M.letterAbove, w: size * 0.8, h: size };
  return { index, frame, ...(words ? { words } : {}), shots, halo, title, letter };
}

/** Lays the review out: the lead at the top left, then a column for each
 * option left to right, its name over its pictures and its words under them,
 * the agent's notes beside each picture. `aspect` is a shot's width over height. */
export function layout(review: DesignReview, aspect: (s: ReviewShot) => number, measure: Measure): BoardLayout {
  const lead = review.note?.trim() ? { x: 0, y: 0, w: M.leadWidth, h: measure.words(review.note, M.leadWidth - 48) + 48 } : undefined;
  let x = lead ? maxX(lead) + 140 : 0;
  const options: OptionLayout[] = [];
  review.options.forEach((option, index) => {
    const top = M.stagger[index % M.stagger.length]!;
    if (needsLeftRoom(option)) x += M.noteGap + M.noteWidth + 40;
    const laid = layOption(index, option, x, top, aspect, measure);
    x = maxX(laid.frame) + M.gutter;
    options.push(laid);
  });
  const rects = [...options.map(optionExtent), ...(lead ? [lead] : [])];
  const bounds = rects.slice(1).reduce(union, rects[0] ?? { x: 0, y: 0, w: 0, h: 0 });
  return { ...(lead ? { lead } : {}), options, bounds };
}

export function shotAt(board: BoardLayout, p: Point): ShotLayout | undefined {
  for (const o of board.options) for (const s of o.shots) if (contains(s.picture, p)) return s;
  return undefined;
}

// ------------------------------------------------------------ the tour

// What a stop lights; the rest of the board dims while touring. `lead`: the
// agent's lead alone (on a portrait screen the Mac's opening is too small
// to read); `start`: where it opens, all of the first option, nothing dimmed.
export type Lit = { kind: 'lead' } | { kind: 'start' } | { kind: 'opening'; option: number } | { kind: 'shot'; option: number; shot: number } | { kind: 'all' };
export type Stop = { rect: Rect; lit: Lit };

export function litOption(l: Lit): number | undefined {
  return l.kind === 'opening' || l.kind === 'shot' ? l.option : undefined;
}

/** Whether this stop lights a shot. */
export function litShows(l: Lit, option: number, shot: number): boolean {
  switch (l.kind) {
    case 'all':
    case 'start':
      return true;
    case 'lead':
      return false;
    case 'opening':
      return l.option === option && shot === 0;
    case 'shot':
      return l.option === option && l.shot === shot;
  }
}

export function litShowsWords(l: Lit, option: number): boolean {
  if (l.kind === 'all' || l.kind === 'start') return true;
  if (l.kind === 'lead') return false;
  return litOption(l) === option;
}

export const litDims = (l: Lit) => l.kind !== 'all' && l.kind !== 'start';

/** The agent's order, as the Mac steps it: the lead, the first option whole,
 * each option's pictures in turn (with its name on the first and its words
 * on the last), then everything. */
export function stops(board: BoardLayout): Stop[] {
  const out: Stop[] = [];
  if (board.lead) out.push({ rect: board.lead, lit: { kind: 'lead' } });
  const first = board.options[0];
  if (first) out.push({ rect: optionExtent(first), lit: { kind: 'start' } });
  for (const o of board.options) {
    const last = o.shots.length - 1;
    for (const s of o.shots) {
      let rect = shotExtent(s);
      if (s.shot === last && o.words) rect = union(rect, o.words);
      if (s.shot === 0) out.push({ rect: union(rect, o.title), lit: { kind: 'opening', option: o.index } });
      else out.push({ rect, lit: { kind: 'shot', option: o.index, shot: s.shot } });
    }
  }
  out.push({ rect: board.bounds, lit: { kind: 'all' } });
  return out;
}

export function stopIndex(list: Stop[], option: number, shot: number): number {
  return list.findIndex((s) => (shot === 0 ? s.lit.kind === 'opening' && s.lit.option === option : s.lit.kind === 'shot' && s.lit.option === option && s.lit.shot === shot));
}

// ------------------------------------------------------------ the camera

export type Camera = { s: number; tx: number; ty: number };

export const clampZoom = (s: number) => Math.min(M.maxZoom, Math.max(M.minZoom, s));

/** Fits `rect` in `area` (screen) with `pad` round it, no closer than `top`. */
export function fit(rect: Rect, area: Rect, pad: number, top: number): Camera {
  const s = Math.min((area.w - pad * 2) / Math.max(1, rect.w), (area.h - pad * 2) / Math.max(1, rect.h));
  const c = Math.min(top, Math.max(M.minZoom, s));
  return { s: c, tx: midX(area) - midX(rect) * c, ty: midY(area) - midY(rect) * c };
}

export const toScreen = (c: Camera, p: Point): Point => ({ x: p.x * c.s + c.tx, y: p.y * c.s + c.ty });
export const toWorld = (c: Camera, p: Point): Point => ({ x: (p.x - c.tx) / c.s, y: (p.y - c.ty) / c.s });
export const screenRect = (c: Camera, r: Rect): Rect => ({ x: r.x * c.s + c.tx, y: r.y * c.s + c.ty, w: r.w * c.s, h: r.h * c.s });

/** Zooms by `factor` round a screen point, which stays where it is. */
export function zoomAt(c: Camera, p: Point, factor: number): Camera {
  const s = clampZoom(c.s * (Number.isFinite(factor) && factor > 0 ? factor : 1));
  const w = toWorld(c, p);
  return { s, tx: p.x - w.x * s, ty: p.y - w.y * s };
}

/** Partway to `to` (k already eased): zooming in even steps and moving the
 * view's centre in a straight line, so a flight neither lurches nor swings wide. */
export function toward(from: Camera, to: Camera, k: number, view: { w: number; h: number }): Camera {
  const centre = (c: Camera) => ({ x: (view.w / 2 - c.tx) / c.s, y: (view.h / 2 - c.ty) / c.s });
  const a = centre(from);
  const b = centre(to);
  const s = Math.exp(Math.log(from.s) + (Math.log(to.s) - Math.log(from.s)) * k);
  const c = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  return { s, tx: view.w / 2 - c.x * s, ty: view.h / 2 - c.y * s };
}

export function ease(k: number): number {
  const t = Math.min(1, Math.max(0, k));
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

// What a wheel event does, as the Mac's canvas: a mouse's wheel zooms round
// the pointer (Mike asked, 22 Nov), whether it counts lines or pixels; a
// trackpad's two fingers move, and zoom with ⌘ or Control held, or by
// pinching (which browsers send as a wheel with ctrlKey). Browsers don't say
// which device sent it, so a trackpad is told by its fine, two-axis deltas:
// Chrome and Safari give a trackpad's as wheelDeltaY = -3 × deltaY, a
// mouse notch as a multiple of 120.
export type WheelInput = { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; wheelDeltaY?: number };
export type WheelAction = { kind: 'zoom'; factor: number } | { kind: 'pan'; dx: number; dy: number };

const WHEEL_STEP = 0.18;
const SMOOTH_WHEEL_PIXELS = 80;

export function wheelAction(e: WheelInput): WheelAction {
  const lineY = e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * 3 : undefined;
  if (lineY !== undefined) {
    if (!lineY || !Number.isFinite(lineY)) return { kind: 'zoom', factor: 1 };
    return { kind: 'zoom', factor: Math.exp(-Math.sign(lineY) * Math.min(3, Math.max(1, Math.abs(lineY))) * WHEEL_STEP) };
  }
  if (e.ctrlKey || e.metaKey) return { kind: 'zoom', factor: Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01) };
  if (isMouseWheel(e)) return { kind: 'zoom', factor: Math.exp((-Math.max(-80, Math.min(80, e.deltaY)) * WHEEL_STEP) / SMOOTH_WHEEL_PIXELS) };
  return { kind: 'pan', dx: -e.deltaX, dy: -e.deltaY };
}

function isMouseWheel(e: WheelInput): boolean {
  if (e.deltaX !== 0) return false;
  if (e.wheelDeltaY !== undefined && e.wheelDeltaY !== 0) {
    if (e.wheelDeltaY === -3 * e.deltaY) return false;
    return e.wheelDeltaY % 120 === 0;
  }
  // Firefox, in pixels: a notch is a big round step.
  return Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY);
}

// ------------------------------------------------------------ the agent's ink

// A pen stroke: a start and cubic segments (control 1, control 2, end).
export type Stroke = { start: Point; curves: [Point, Point, Point][] };

/** A smooth stroke through points (Catmull-Rom). */
export function through(points: Point[]): Stroke {
  const start = points[0] ?? { x: 0, y: 0 };
  const curves: Stroke['curves'] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    curves.push([
      { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      p2,
    ]);
  }
  return { start, curves };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The strokes as an SVG path's d. */
export function pathData(strokes: Stroke[]): string {
  return strokes
    .map((s) => `M${r2(s.start.x)} ${r2(s.start.y)}` + s.curves.map(([a, b, c]) => `C${r2(a.x)} ${r2(a.y)} ${r2(b.x)} ${r2(b.y)} ${r2(c.x)} ${r2(c.y)}`).join(''))
    .join('');
}

/** The Mac's seeded wobble (mulberry32), so a mark draws the same every time and the same as on the Mac. */
export function wobble(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 0xffffffff;
  };
}

/** The Mac's seed for a mark's wobble: option × 97 + shot × 13 + mark + 7. */
export function seedOf(option: number, shot: number, mark: number): number {
  return (option * 97 + shot * 13 + mark + 7) >>> 0;
}

/** A loop round a box, a little more than once round, the ends crossing. */
export function circleStroke(p: Rect, seed: number): Stroke {
  const w = wobble(seed);
  const c = { x: p.x + p.w / 2, y: p.y + p.h / 2 };
  const rx = (p.w / 2) * 1.42 + 8;
  const ry = (p.h / 2) * 1.42 + 8;
  const start = -2.2 + w() * 0.6;
  const turn = 2 * Math.PI * 1.12;
  const n = 22;
  const points: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = start + (turn * i) / n;
    const k = 1 + (w() - 0.5) * 0.06 + (i / n) * 0.05;
    points.push({ x: c.x + Math.cos(t) * rx * k, y: c.y + Math.sin(t) * ry * k });
  }
  return through(points);
}

/** Two passes under a box's bottom edge, the second a touch lower. */
export function underlineStrokes(p: Rect, seed: number): Stroke[] {
  const w = wobble(seed);
  const bottom = p.y + p.h;
  return [0, 1].map((pass) => {
    const points: Point[] = [];
    for (let i = 0; i <= 6; i++) {
      const f = i / 6;
      points.push({ x: p.x - 6 + (p.w + 18) * f, y: bottom + 4 + pass * 5 + (w() - 0.5) * 3 + Math.sin(f * Math.PI) * 2 });
    }
    return through(points);
  });
}

/** A marker swipe's middle line, a little uphill; drawn as thick as the box. */
export function swipeStroke(p: Rect): Stroke {
  return through([
    { x: p.x - 6, y: p.y + p.h * 0.55 + 2 },
    { x: p.x + p.w / 2, y: p.y + p.h * 0.5 },
    { x: p.x + p.w + 6, y: p.y + p.h * 0.45 - 2 },
  ]);
}

/** The curled pointer from a note to its mark. */
export function curl(from: Point, to: Point): Stroke {
  const { x: sx, y: sy } = from;
  const { x: ex, y: ey } = to;
  const d = ex < sx ? 1 : -1;
  return {
    start: from,
    curves: [
      [{ x: sx - d * 28, y: sy - 12 }, { x: sx - d * 46, y: sy + 4 }, { x: sx - d * 36, y: sy + 22 }],
      [{ x: sx - d * 24, y: sy + 40 }, { x: sx - d * 10, y: sy + 17 }, { x: sx - d * 32, y: sy + 15 }],
      [{ x: sx - d * 46, y: sy + 13 }, { x: ex + d * 40, y: ey + 10 }, to],
    ],
  };
}

/** An open arrowhead at a stroke's end. */
export function arrowhead(s: Stroke, size: number): Stroke {
  const last = s.curves.at(-1);
  if (!last) return { start: { x: 0, y: 0 }, curves: [] };
  const end = last[2];
  const from = last[1].x !== end.x || last[1].y !== end.y ? last[1] : last[0];
  const len = Math.max(0.001, Math.hypot(end.x - from.x, end.y - from.y));
  const dx = (end.x - from.x) / len;
  const dy = (end.y - from.y) / len;
  const b = { x: end.x - dx * size, y: end.y - dy * size };
  const wing = size * 0.56;
  const one = { x: b.x - dy * wing, y: b.y + dx * wing };
  const two = { x: b.x + dy * wing, y: b.y - dx * wing };
  return { start: one, curves: [[one, end, end], [end, two, two]] };
}

/** One of the agent's marks, before its pointer. An arrow is only its pointer. */
export function markStrokes(picture: Rect, m: AgentMark, seed: number): Stroke[] {
  const p = part(picture, m.box);
  switch (m.kind) {
    case 'circle':
      return [circleStroke(p, seed)];
    case 'underline':
      return underlineStrokes(p, seed);
    case 'highlight':
      return [swipeStroke(p)];
    default:
      return [];
  }
}

/** The pointer from a note to its mark, with its head. */
export function pointerStrokes(n: NotePlace): Stroke[] {
  const mid = midY(n.rect);
  const from = n.left ? { x: maxX(n.rect) + 12, y: mid } : { x: n.rect.x - 12, y: mid };
  const shaft = curl(from, n.target);
  return [shaft, arrowhead(shaft, 16)];
}

// ------------------------------------------------------------ marking

export type Tool = 'move' | 'circle' | 'highlight' | 'pin';

/** Where a drawing ends up: the picture under its middle, its box and stroke
 * as fractions of that picture. Nothing off a picture or on a reference, nor
 * a circle or highlight too small to mean anything. `grow` is half the
 * marker's width in world units, for a highlight. */
export function finishDrawing(board: BoardLayout, review: DesignReview, tool: Exclude<Tool, 'move'>, points: Point[], grow: number): Omit<UserMark, 'n'> | undefined {
  const first = points[0];
  if (!first || (tool !== 'pin' && points.length < 3)) return undefined;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const middle = tool === 'pin' ? first : { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  const laid = shotAt(board, middle);
  const option = laid ? review.options[laid.option] : undefined;
  if (!laid || !option || option.reference) return undefined;
  const p = laid.picture;
  const frac = (q: Point) => [Math.min(1, Math.max(0, (q.x - p.x) / p.w)), Math.min(1, Math.max(0, (q.y - p.y) / p.h))];
  const g = tool === 'highlight' ? grow : 0;
  const a = frac({ x: x0 - g, y: y0 - g });
  const b = frac({ x: x1 + g, y: y1 + g });
  const box = tool === 'pin' ? [...frac(first), ...frac(first)] : [a[0]!, a[1]!, b[0]!, b[1]!];
  return { kind: tool, optionId: option.id, shot: laid.shot, box, path: points.slice(0, 200).map(frac) };
}

/** A mark's cut-out: the marked part of a still padded by 0.04 of it each
 * side, in the still's pixels, and the size to draw it at (no more than 480
 * wide). Undefined for nothing to cut. */
export function cutOutRect(box: number[], width: number, height: number): { sx: number; sy: number; sw: number; sh: number; w: number; h: number } | undefined {
  if (box.length !== 4 || width < 1 || height < 1) return undefined;
  const x0 = Math.max(0, Math.min(box[0]!, box[2]!) - 0.04);
  const x1 = Math.min(1, Math.max(box[0]!, box[2]!) + 0.04);
  const y0 = Math.max(0, Math.min(box[1]!, box[3]!) - 0.04);
  const y1 = Math.min(1, Math.max(box[1]!, box[3]!) + 0.04);
  const sx = Math.floor(x0 * width);
  const sy = Math.floor(y0 * height);
  const sw = Math.ceil(x1 * width) - sx;
  const sh = Math.ceil(y1 * height) - sy;
  if (sw < 1 || sh < 1) return undefined;
  const scale = Math.min(1, 480 / sw);
  return { sx, sy, sw, sh, w: Math.round(sw * scale), h: Math.max(1, Math.round(sh * scale)) };
}

/** Says how many of the browser's marks to remove when the Mac's leave too
 * little room, rather than Send just staying off. */
export const OVER_PREFIX = 'The Mac added marks';
export function overNote(d: ReviewDraft): string | undefined {
  const over = marksOver(d);
  return over > 0 ? `${OVER_PREFIX}, so remove ${over} of yours to send.` : undefined;
}
