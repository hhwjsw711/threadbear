// Validation and text for durable reviews of pictures, videos and pages.
// Files are copied only after every input has passed validation, so a bad
// final option leaves no card.
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './config.ts';
import { readAudioInfo, readImageInfo, readVideoInfo } from './media.ts';
import type { AgentMark, DesignReview, ImageRef, MarkBox, ReviewDraft, ReviewUserMark } from './protocol.ts';
import { ErrorCode, RpcError } from './protocol.ts';

// An option's pictures: `path` and then `shots`, or `shots` alone. One option
// often has several (its overview, mid-drag, a detail), which agents used to
// pass as options of their own, A2 and A3, that couldn't be picked (Mike, 4 Nov).
// kind is worked out here from the file: a picture, a video (MP4 or
// QuickTime) or an HTML page. The window plays a video and shows a page in
// place of a still, as agents had to hand Mike stills of clips that only
// made sense moving (6 Nov 2026). A sound (MP3, M4A, AAC, WAV) plays too, as
// Mike wanted to compare music beds (24 Nov 2026).
export type ReviewShotKind = 'image' | 'video' | 'audio' | 'page';
// marks: the agent's marks on the picture; an
// option's own belong to its path shot.
export type ReviewShotInput = { path: string; title?: string; kind?: ReviewShotKind; marks?: AgentMark[] };
export type ReviewInput = { title: string; note?: string; recommended?: string; options: { id: string; title: string; path?: string; shots?: ReviewShotInput[]; url?: string; note?: string; reference?: boolean; marks?: AgentMark[] }[] };
// What createReview copies: every source file, first shot first.
export type ReviewOptionSource = { id: string; title: string; note?: string; reference?: boolean; url?: string; shots: ReviewShotInput[] };
export const maxReviewShots = 8;
export const maxReviewImages = 40;
const maxImageBytes = 25 * 1024 * 1024;
const maxVideoBytes = 200 * 1024 * 1024;
const maxAudioBytes = 100 * 1024 * 1024;
const maxPageBytes = 10 * 1024 * 1024;
// All of a review's videos, sounds and pages together, as each is copied in.
export const maxReviewMediaBytes = 500 * 1024 * 1024;

function bad(message: string): never {
  throw new RpcError(ErrorCode.badParams, message);
}

function text(v: unknown, name: string, max: number, required = false): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) bad(`${name} must be ${required ? 'nonempty text' : 'text'} of at most ${max} characters.`);
  return (v as string).trim();
}

function shotFile(raw: unknown, cwd: string): { path: string; kind: ReviewShotKind; size: number } {
  const file = path.resolve(cwd, expandHome(text(raw, 'path', 8192, true)!));
  let size: number;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) bad(`Not a regular file: ${file}`);
    size = st.size;
  } catch (e) {
    if (e instanceof RpcError) throw e;
    bad(`File not found: ${file}`);
  }
  if (/\.html?$/i.test(file)) {
    if (size > maxPageBytes) bad(`An HTML page must be at most 10 MB: ${file}`);
    return { path: file, kind: 'page', size };
  }
  if (size <= maxImageBytes) {
    const info = readImageInfo(file);
    if (info?.width && info.height) return { path: file, kind: 'image', size };
  }
  // Before videos: an M4A is an MP4 with no picture.
  if (readAudioInfo(file)) {
    if (size > maxAudioBytes) bad(`A sound must be at most 100 MB: ${file}`);
    return { path: file, kind: 'audio', size };
  }
  if (readVideoInfo(file)) {
    if (size > maxVideoBytes) bad(`A video must be at most 200 MB: ${file}`);
    return { path: file, kind: 'video', size };
  }
  if (size > maxImageBytes) bad(`An image must be at most 25 MB: ${file}`);
  return bad(`Not a picture (PNG, JPEG, GIF, WebP), video (MP4, MOV), sound (MP3, M4A, AAC, WAV) or HTML page: ${file}`);
}

// Marks on the pictures (docs/protocol/events.md, "Marks: the canvas"):
// Mike, 22 Nov 2026, asked for the agent's "little helpful arrows pointing
// out things visually" on the review's pictures, and tools to circle,
// highlight or pin a part himself, each a chip in his reply.
export const maxShotMarks = 6;
export const maxReviewMarks = 30;
export const maxMarkNote = 80;
export const maxDraftMarks = 20;
export const maxMarkPoints = 400;
const MARK_KINDS: readonly string[] = ['circle', 'underline', 'highlight', 'arrow'];
const MARK_INKS: readonly string[] = ['yellow', 'green', 'rose'];
const USER_MARK_KINDS: readonly string[] = ['circle', 'highlight', 'pin'];

function markBox(v: unknown, at: string): MarkBox {
  if (!Array.isArray(v) || v.length !== 4 || v.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) || v[0] > v[2] || v[1] > v[3]) {
    bad(`${at}: box must be [x0, y0, x1, y1], fractions of the picture from 0 to 1 from its top left, with x0 <= x1 and y0 <= y1.`);
  }
  return [v[0], v[1], v[2], v[3]];
}

// The agent's marks on one picture, `where` naming it ("A, picture 2").
function agentMarks(raw: unknown, where: string): AgentMark[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return bad(`marks on ${where} must be a list.`);
  if (raw.length > maxShotMarks) bad(`${where} has ${raw.length} marks; at most ${maxShotMarks} a picture.`);
  return raw.map((m, k) => {
    const at = `marks[${k}] on ${where}`;
    if (!m || typeof m !== 'object' || Array.isArray(m)) bad(`${at} must be an object with a kind and a box.`);
    const r = m as Record<string, unknown>;
    if (typeof r.kind !== 'string' || !MARK_KINDS.includes(r.kind)) bad(`${at}: kind must be circle, underline, highlight or arrow.`);
    const box = markBox(r.box, at);
    const note = text(r.note, `${at}: note`, maxMarkNote);
    if (r.ink !== undefined && (typeof r.ink !== 'string' || !MARK_INKS.includes(r.ink))) bad(`${at}: ink must be yellow, green or rose.`);
    return { kind: r.kind as AgentMark['kind'], box, ...(note ? { note } : {}), ...(r.ink !== undefined ? { ink: r.ink as AgentMark['ink'] } : {}) };
  });
}

// A moved or recovered shot's marks, cut to what show_options takes rather
// than refused: the ones that pass, notes cut to their length.
function fitAgentMarks(raw: unknown): AgentMark[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentMark[] = [];
  for (const m of raw) {
    if (out.length >= maxShotMarks) break;
    const r = m && typeof m === 'object' && !Array.isArray(m) && typeof (m as AgentMark).note === 'string' ? { ...m, note: cutText((m as AgentMark).note!, maxMarkNote) } : m;
    try {
      out.push(...agentMarks([r], 'a picture'));
    } catch {
      // Left out.
    }
  }
  return out;
}

export function reviewInput(raw: unknown, cwd: string): { title: string; note?: string; recommended?: string; options: ReviewOptionSource[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('A review needs a title and options.');
  const p = raw as Record<string, unknown>;
  const title = text(p.title, 'title', 200, true)!;
  const note = text(p.note, 'note', 4000);
  if (!Array.isArray(p.options) || !p.options.length || p.options.length > 12) return bad('A review needs between 1 and 12 options.');
  const ids = new Set<string>();
  let images = 0;
  let mediaBytes = 0;
  let marks = 0;
  const options = p.options.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(`options[${i}] must be an object.`);
    const o = raw as Record<string, unknown>;
    const id = text(o.id, 'option id', 200, true)!;
    if (ids.has(id)) bad(`Duplicate option id: ${id}`);
    ids.add(id);
    const title = text(o.title, 'option title', 200, true)!;
    const note = text(o.note, 'option note', 4000);
    if (o.reference !== undefined && typeof o.reference !== 'boolean') bad('reference must be a boolean.');
    const url = text(o.url, 'url', 2000);
    if (url && !/^https?:\/\/\S+$/i.test(url)) bad(`url must be an http or https address: ${url}`);
    if (o.shots !== undefined && !Array.isArray(o.shots)) bad(`shots on ${id} must be a list.`);
    const shots: ReviewShotInput[] = [];
    const add = (raw: unknown, title: string | undefined, rawMarks: unknown) => {
      const file = shotFile(raw, cwd);
      if (file.kind !== 'image') mediaBytes += file.size;
      const own = agentMarks(rawMarks, `${id}, picture ${shots.length + 1}`);
      marks += own.length;
      shots.push({ path: file.path, kind: file.kind, ...(title ? { title } : {}), ...(own.length ? { marks: own } : {}) });
    };
    if ((Array.isArray(o.marks) ? o.marks.length > 0 : o.marks !== undefined) && o.path === undefined) bad(`marks on ${id} belong to its path picture, and it has none: put them on its shots.`);
    if (o.path !== undefined) add(o.path, undefined, o.marks);
    for (const [j, s] of ((o.shots as unknown[] | undefined) ?? []).entries()) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) bad(`shots[${j}] on ${id} must be an object with a path.`);
      const shot = s as Record<string, unknown>;
      add(shot.path, text(shot.title, 'shot title', 200), shot.marks);
    }
    if (!shots.length) bad(`Option ${id} needs an image, video, sound or page: a path or shots.`);
    if (shots.length > maxReviewShots) bad(`Option ${id} has ${shots.length} images; at most ${maxReviewShots}.`);
    images += shots.length;
    return { id, title, shots, ...(note ? { note } : {}), ...(o.reference === true ? { reference: true } : {}), ...(url ? { url } : {}) };
  });
  if (images > maxReviewImages) bad(`A review can have at most ${maxReviewImages} images in all; this has ${images}.`);
  if (marks > maxReviewMarks) bad(`A review can have at most ${maxReviewMarks} marks in all; this has ${marks}. Mark only what needs pointing out.`);
  if (mediaBytes > maxReviewMediaBytes) bad(`A review's videos, sounds and pages can be at most 500 MB in all; these are ${Math.ceil(mediaBytes / 1024 / 1024)} MB.`);
  // The agent's own pick, which the window marks with a star and "Recommended" as an asks card
  // does (Mike, 7 Nov: agents wrote "I'd pick C" in the middle of the note,
  // where it was hard to find).
  const recommended = text(p.recommended, 'recommended', 200) || undefined;
  if (recommended) {
    const option = options.find(o => o.id === recommended);
    if (!option) bad(`recommended must be one of the option ids: ${recommended}`);
    if (option.reference) bad('recommended cannot be a reference option.');
  }
  return { title, ...(note ? { note } : {}), ...(recommended ? { recommended } : {}), options };
}

// Where a moved thread's media is: `now`, the folder that came with the move
// as it is (staging, or the live folder), and `final`, this thread's media
// folder here, which `now` becomes.
export type MovedMedia = { threadId: string; now: string; final: string };

// A moved review's file, as this thread's copy here: only one that came with
// the move, as `<thread id>/media/reviews/<review id>/<name>` (or a page's
// `<folder>/<name>`) at any runner's path, a real file in `now` with real
// folders on the way, never a link. Anything else is undefined: a path alone
// is the other runner's word, and an extra Mac could name any file on this
// one with it, which the review window would read as this Mac's once the
// thread is here (Daybreak 159, 21 Nov 2026).
function movedReviewFile(file: unknown, reviewId: string, media: MovedMedia): { now: string; here: string } | undefined {
  if (typeof file !== 'string' || file.includes('\0')) return undefined;
  if (!/^[a-zA-Z0-9-]{1,200}$/.test(reviewId)) return undefined;
  const parts = file.replace(/\\/g, '/').split('/');
  let at = -1;
  for (let i = parts.length - 5; i >= 0; i--) {
    if (parts[i] === media.threadId && parts[i + 1] === 'media' && parts[i + 2] === 'reviews' && parts[i + 3] === reviewId) {
      at = i + 4;
      break;
    }
  }
  if (at < 0) return undefined;
  const rest = parts.slice(at);
  if (rest.length < 1 || rest.length > 2 || rest.some(p => !p || p === '.' || p === '..' || p.length > 255)) return undefined;
  try {
    let dir = media.now;
    for (const seg of ['reviews', reviewId, ...rest.slice(0, -1)]) {
      dir = path.join(dir, seg);
      if (!fs.lstatSync(dir).isDirectory()) return undefined;
    }
    if (!fs.lstatSync(path.join(dir, rest.at(-1)!)).isFile()) return undefined;
    return { now: path.join(dir, rest.at(-1)!), here: path.join(media.final, 'reviews', reviewId, ...rest) };
  } catch {
    return undefined;
  }
}

// The ImageRef as this thread's copy (movedReviewFile), or undefined. Its
// type is the file's own, as reviewInput works it out, never the other
// runner's word: a page called a video would be opened in the browser by the
// window's Play the clip, scripts and all (Gemini's review). `still` is a
// shot's picture; otherwise its video or page.
function movedRef(ref: unknown, reviewId: string, media: MovedMedia, still: boolean): ImageRef | undefined {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return undefined;
  const file = movedReviewFile((ref as ImageRef).path, reviewId, media);
  if (!file) return undefined;
  // Its kind by its name as well as its bytes, as createReview names its
  // copies, and within show_options' sizes: a file with a video's first
  // bytes called .svg or .pdf went to Play the clip too (Codex's and
  // Gemini's second reviews). Its size as the file says.
  let size: number;
  try {
    size = fs.statSync(file.now).size;
  } catch {
    return undefined;
  }
  const page = !still && /\.html?$/i.test(file.now);
  let info: { mediaType: string; width?: number; height?: number } | null;
  // A page's copy may have a charset tag more than show_options took (withCharset).
  if (page) info = size <= maxPageBytes + 1024 ? { mediaType: 'text/html' } : null;
  else if (still) info = /\.(png|jpe?g|gif|webp)$/i.test(file.now) && size <= maxImageBytes ? readImageInfo(file.now) : null;
  else if (/\.(mp3|m4a|aac|wav)$/i.test(file.now)) info = size <= maxAudioBytes ? readAudioInfo(file.now) : null;
  else info = /\.(mp4|m4v|mov)$/i.test(file.now) && size <= maxVideoBytes ? readVideoInfo(file.now) : null;
  if (!info) return undefined;
  const { width: _w, height: _h, ...rest } = ref as ImageRef;
  return { ...rest, path: file.here, mediaType: info.mediaType, ...('width' in info && info.width ? { width: info.width } : {}), ...('height' in info && info.height ? { height: info.height } : {}) };
}

// A moved note's links, but for web pages, as their words: the review window
// opens a note's link on this Mac, relative to the thread's folder here, and
// the other runner's agent wrote them (Daybreak 159). The window's parser
// makes a link only where a ] is followed straight by a ( and takes the
// address up to the next parenthesis, so every ]( not followed by a web
// address (and nothing after it up to its closing parenthesis) becomes ]\(,
// which shows the same and is no link, however the parser reads the
// brackets and code spans before it (Codex's and Gemini's reviews: a check
// of whole [words](address) runs read a code span differently). Doing it
// again changes nothing.
// Only ASCII spaces around it: JavaScript's \s takes characters (U+FEFF)
// the window's Rust trim keeps, and the address would be a file's then
// (Codex's and Gemini's second reviews).
const WEB_ADDRESS = /\([ \t\r\n]*https?:\/\/[^\s()]*[ \t\r\n]*\)/iy;
export function webLinksOnly(note: string): string {
  let out = '';
  let last = 0;
  for (let i = note.indexOf(']('); i >= 0; i = note.indexOf('](', i + 1)) {
    WEB_ADDRESS.lastIndex = i + 1;
    if (WEB_ADDRESS.test(note)) continue;
    out += note.slice(last, i + 1) + '\\';
    last = i + 1;
  }
  return out + note.slice(last);
}

// A stored review cut to what reviewInput and reviewDraft take, for one this
// runner didn't make: a moved thread's reviews are the other runner's word
// (runner/moves.ts fitMovedReviews). Its words are cut rather than refused,
// so a review that fits keeps its words exactly. Its files are this thread's
// copies of the ones that came with the move (movedReviewFile); a shot with
// none goes, an option with none left goes, and a review with no options
// left goes. Undefined for something that isn't a review. `recovering` is
// for a review recoverReviews reads from the thread's own log: its files are
// checked the same way, but its draft's and response's pictures stay (for
// ownReplyImages to check), and its notes' links stay, as they're this
// Mac's agent's (a moved log is fitted as it's placed, fitMovedLog).
export function fitReview(raw: unknown, media: MovedMedia, recovering = false): DesignReview | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = { ...(raw as Record<string, any>) };
  if (typeof r.id !== 'string' || !Array.isArray(r.options)) return undefined;
  const reviewId = r.id;
  const cut = (v: unknown, max: number) => (typeof v === 'string' ? cutText(v, max) : undefined);
  const set = (o: Record<string, any>, key: string, max: number) => {
    if (o[key] === undefined) return;
    const fitted = cut(o[key], max);
    if (fitted === undefined) delete o[key];
    else o[key] = fitted;
  };
  set(r, 'title', 200);
  set(r, 'note', 4000);
  set(r, 'recommended', 200);
  if (typeof r.note === 'string' && !recovering) r.note = webLinksOnly(r.note);
  let agentMarkCount = 0;
  r.options = r.options.slice(0, 12).flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const o = { ...(raw as Record<string, any>) };
    if (typeof o.id !== 'string') return [];
    set(o, 'title', 200);
    set(o, 'note', 4000);
    set(o, 'url', 2000);
    if (typeof o.note === 'string' && !recovering) o.note = webLinksOnly(o.note);
    // Open live is for a web page only, as show_options takes.
    if (o.url !== undefined && !/^https?:\/\/\S+$/i.test(o.url)) delete o.url;
    if (Array.isArray(o.shots)) {
      o.shots = o.shots.slice(0, maxReviewShots).flatMap((raw: unknown) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const shot: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
        const image = movedRef(shot.image, reviewId, media, true);
        if (!image) return [];
        shot.image = image;
        // Without its video or page, the shot is its still.
        if (shot.media !== undefined) {
          const m = movedRef(shot.media, reviewId, media, false);
          if (m) shot.media = m;
          else delete shot.media;
        }
        if (shot.marks !== undefined) {
          const marks = fitAgentMarks(shot.marks).slice(0, Math.max(0, maxReviewMarks - agentMarkCount));
          agentMarkCount += marks.length;
          if (marks.length) shot.marks = marks;
          else delete shot.marks;
        }
        return [shot];
      });
      if (!o.shots.length) delete o.shots;
    } else delete o.shots;
    o.image = movedRef(o.image, reviewId, media, true) ?? o.shots?.[0]?.image;
    if (!o.image) return [];
    return [o];
  });
  if (!r.options.length) return undefined;
  const ids = new Set<string>(r.options.map((o: { id: string }) => o.id));
  if (r.recommended !== undefined && !ids.has(r.recommended)) delete r.recommended;
  // A draft with notes, as the runner takes every review to have, and a
  // response only if it's one (Gemini's third review: a response with no
  // notes threw in recoverReviews).
  if (!r.draft || typeof r.draft !== 'object' || Array.isArray(r.draft)) r.draft = { notes: {} };
  if (r.response !== undefined && (!r.response || typeof r.response !== 'object' || Array.isArray(r.response))) delete r.response;
  for (const key of ['draft', 'response'] as const) {
    const d = r[key];
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    const draft = { ...d };
    if (!draft.notes || typeof draft.notes !== 'object' || Array.isArray(draft.notes)) draft.notes = {};
    set(draft, 'reply', 8000);
    // A reply's pictures name the other runner's files, which an extra Mac
    // could point anywhere on this one (Codex's review, 17 Nov): they don't
    // come with the move, and the words say so where they were.
    if (!recovering) {
      if (Array.isArray(draft.images) && typeof draft.reply === 'string') draft.reply = keepPictureMarkers(draft.reply, draft.images.map(() => false));
      delete draft.images;
    }
    // Mike's marks, the ones that still fit the options that came; a moved
    // one's cut-out goes as the reply's pictures do.
    if (draft.marks !== undefined) {
      const marks = fitUserMarks(r as DesignReview, draft.marks).map(m => {
        if (recovering || !m.image) return m;
        const { image: _, ...rest } = m;
        return rest;
      });
      if (marks.length) draft.marks = marks;
      else delete draft.marks;
    }
    if (draft.notes && typeof draft.notes === 'object' && !Array.isArray(draft.notes)) {
      const notes: Record<string, string> = Object.create(null);
      for (const [id, note] of Object.entries(draft.notes).slice(0, 12)) {
        const fitted = cut(note, 4000);
        if (fitted !== undefined && ids.has(id)) notes[id] = fitted;
      }
      draft.notes = { ...notes };
    }
    // Picks of options that didn't come go with them.
    if (Array.isArray(draft.pickedIds)) draft.pickedIds = draft.pickedIds.filter((id: unknown) => typeof id === 'string' && ids.has(id));
    if (draft.pickedId !== undefined && !ids.has(draft.pickedId)) delete draft.pickedId;
    r[key] = draft;
  }
  return r as DesignReview;
}

// At most `max` UTF-16 units, never ending on half a surrogate pair.
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1] ?? '') ? max - 1 : max;
  return text.slice(0, end);
}

export function reviewDraft(review: DesignReview, raw: unknown, answer = false): ReviewDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('draft must contain notes and optional picks.');
  const d = raw as Record<string, unknown>;
  if (!d.notes || typeof d.notes !== 'object' || Array.isArray(d.notes)) return bad('notes must be an object keyed by option ID.');
  if (d.pickedId !== undefined && typeof d.pickedId !== 'string') bad('pickedId must be an option ID.');
  if (d.pickedIds !== undefined && (!Array.isArray(d.pickedIds) || d.pickedIds.some(id => typeof id !== 'string'))) bad('pickedIds must be a list of option IDs.');
  if (d.none !== undefined && typeof d.none !== 'boolean') bad('none must be a boolean.');
  // pickedIds wins; a client from before it sends pickedId alone.
  const wanted = new Set((d.pickedIds as string[] | undefined) ?? (d.pickedId !== undefined ? [d.pickedId as string] : []));
  for (const id of wanted) {
    const option = review.options.find(o => o.id === id);
    if (!option) bad(`Unknown option: ${id}`);
    if (option.reference) bad('A reference image cannot be picked.');
  }
  // In the review's order, so the same picks always read the same.
  const picks = review.options.filter(o => wanted.has(o.id)).map(o => o.id);
  const none = d.none === true;
  if (none && picks.length) bad('Pick options or none of them, not both.');
  // Avoid prototype setters for option IDs such as __proto__.
  const notes: Record<string, string> = Object.create(null);
  for (const [id, value] of Object.entries(d.notes)) {
    if (!review.options.some(o => o.id === id)) bad(`Unknown option: ${id}`);
    if (typeof value !== 'string') bad(`Notes on ${id} must be text.`);
    const note = text(value, `Notes on ${id}`, 4000)!;
    if (note) notes[id] = note;
  }
  const reply = text(d.reply, 'reply', 8000);
  const images = replyImages(d.images);
  const marks = userMarks(review, d.marks);
  if (answer && !picks.length && !none && !reply && !images.length && !marks.length && !Object.keys(notes).length) bad('Pick an option or write a reply.');
  return {
    // pickedIds only for more than one, so a single pick saves as it always did.
    ...(picks.length ? { pickedId: picks[0] } : {}),
    ...(picks.length > 1 ? { pickedIds: picks } : {}),
    notes: { ...notes },
    ...(reply ? { reply } : {}),
    ...(images.length ? { images } : {}),
    ...(none ? { none: true as const } : {}),
    ...(marks.length ? { marks } : {}),
  };
}

// An option's pictures as the window numbers them: its shots, or its one image.
function shotsOf(option: DesignReview['options'][number]): { title?: string }[] {
  return option.shots?.length ? option.shots : [{}];
}

// Mike's marks as sent, in number order: their shape, and that each is on a
// picture an option he can pick has. Where a cut-out may come from, and
// copying it in, is the runner's, as for reply pictures (runner/reviews.ts).
function userMarks(review: DesignReview, raw: unknown): ReviewUserMark[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return bad('marks must be a list.');
  if (raw.length > maxDraftMarks) bad(`A reply can have at most ${maxDraftMarks} marks; this has ${raw.length}.`);
  const numbers = new Set<number>();
  const marks = raw.map((m, k): ReviewUserMark => {
    const at = `marks[${k}]`;
    if (!m || typeof m !== 'object' || Array.isArray(m)) bad(`${at} must be an object with n, kind, optionId, shot and box.`);
    const r = m as Record<string, unknown>;
    const n = r.n as number;
    if (!Number.isSafeInteger(n) || n < 1) bad(`${at}: n must be a whole number from 1.`);
    if (numbers.has(n)) bad(`Two marks are numbered ${n}.`);
    numbers.add(n);
    if (typeof r.kind !== 'string' || !USER_MARK_KINDS.includes(r.kind)) bad(`${at}: kind must be circle, highlight or pin.`);
    if (typeof r.optionId !== 'string') bad(`${at}: optionId must be an option ID.`);
    const option = review.options.find(o => o.id === r.optionId);
    if (!option) bad(`${at}: unknown option: ${r.optionId as string}`);
    if (option.reference) bad(`${at}: ${option.id} is a reference option, which can't be marked.`);
    const count = shotsOf(option).length;
    const shot = r.shot as number;
    if (!Number.isSafeInteger(shot) || shot < 0 || shot >= count) bad(`${at}: ${option.id} has no picture ${typeof shot === 'number' ? shot + 1 : String(shot)}; shot is 0-based, below ${count}.`);
    const box = markBox(r.box, at);
    // A stroke can run past the picture's edge: its points are kept on it.
    let points: [number, number][] | undefined;
    if (r.path !== undefined) {
      if (!Array.isArray(r.path) || r.path.length > maxMarkPoints || r.path.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => typeof v !== 'number' || !Number.isFinite(v)))) {
        bad(`${at}: path must be a list of at most ${maxMarkPoints} [x, y] points.`);
      }
      points = (r.path as [number, number][]).map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]);
    }
    const image = r.image === undefined ? undefined : imageShape(r.image, `${at}: image`);
    return { n, kind: r.kind as ReviewUserMark['kind'], optionId: option.id, shot, box, ...(points ? { path: points } : {}), ...(image ? { image } : {}) };
  });
  return marks.sort((a, b) => a.n - b.n);
}

// A stored draft's marks cut to the ones userMarks takes, for a moved or
// recovered review: the rest are left out rather than the draft.
function fitUserMarks(review: DesignReview, raw: unknown): ReviewUserMark[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewUserMark[] = [];
  for (const m of raw) {
    if (out.length >= maxDraftMarks) break;
    try {
      const [mark] = userMarks(review, [m]);
      if (!out.some(o => o.n === mark.n)) out.push(mark);
    } catch {
      // Left out.
    }
  }
  return out.sort((a, b) => a.n - b.n);
}

// The reply's pictures as sent: their shape only. Where they may come from,
// and copying them in with the review, is the runner's (runner/reviews.ts).
export const maxReplyImages = 20;
function replyImages(raw: unknown): ImageRef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return bad('images must be a list of pictures.');
  if (raw.length > maxReplyImages) bad(`A reply can have at most ${maxReplyImages} pictures; this has ${raw.length}.`);
  return raw.map((img, i) => imageShape(img, `images[${i}]`));
}

function imageShape(img: unknown, name: string): ImageRef {
  if (!img || typeof img !== 'object' || Array.isArray(img) || typeof (img as ImageRef).path !== 'string' || !(img as ImageRef).path) bad(`${name} must be a picture with a path.`);
  const { path: file, mediaType, width, height } = img as ImageRef;
  return { path: file, mediaType: typeof mediaType === 'string' ? mediaType : 'application/octet-stream', ...(typeof width === 'number' ? { width } : {}), ...(typeof height === 'number' ? { height } : {}) };
}

// Words whose pictures were cut to those `keep` marks: each [Picture N]
// follows its picture to its new number, or says "[Picture N unavailable]"
// for one left out, so a later picture never lands on an earlier one's
// marker (Codex's review, 17 Nov). A marker past the list stays as written.
export function keepPictureMarkers(text: string, keep: boolean[]): string {
  if (typeof text !== 'string' || keep.every(Boolean)) return text;
  const numbers: (number | undefined)[] = [];
  let next = 0;
  for (const k of keep) numbers.push(k ? ++next : undefined);
  return text.replace(/\[Picture (\d{1,3})\]/g, (marker, n) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= keep.length) return marker;
    return numbers[i] ? `[Picture ${numbers[i]}]` : `[Picture ${n} unavailable]`;
  });
}

export function sameDraft(a: ReviewDraft | undefined, b: ReviewDraft): boolean {
  if (!a || a.pickedId !== b.pickedId || (a.pickedIds ?? []).join('\n') !== (b.pickedIds ?? []).join('\n')) return false;
  if ((a.reply ?? '') !== (b.reply ?? '') || !!a.none !== !!b.none) return false;
  if ((a.images ?? []).map(i => i.path).join('\n') !== (b.images ?? []).map(i => i.path).join('\n')) return false;
  const marks = (d: ReviewDraft) => JSON.stringify((d.marks ?? []).map(m => [m.n, m.kind, m.optionId, m.shot, m.box, m.path ?? [], m.image?.path ?? '']));
  if (marks(a) !== marks(b)) return false;
  const ids = Object.keys(a.notes);
  return ids.length === Object.keys(b.notes).length && ids.every(id => a.notes[id] === b.notes[id]);
}

// The end of the "Passed over:" line, which the Mac, phone and GPUI bubbles
// look for to leave the line out (ReviewAnswer), so change them with it.
export const PASSED_OVER_TAIL = "Don't offer one of these later (a next step, a follow-up) as if it were new: say it's one they passed over.";

// What the agent reads. "Picked A." with one, "Picked A + D." with more, as
// the window's Send button says. The Mac and the phone read it back
// (ReviewAnswer) for Mike's bubble, so change them with it.
//
// With a pick, the last line names the options he passed over. On 10 Nov an
// agent's done card offered the option he'd turned down, in neutral words,
// as a follow-up; he ticked it without recognising it and got the big card
// he hadn't wanted. The agent writing follow-ups needs this in front of it.
export function reviewReply(review: DesignReview, draft: ReviewDraft): string {
  const lines = [`Review: ${review.title} (${review.id})`];
  const picks = draft.pickedIds ?? (draft.pickedId ? [draft.pickedId] : []);
  if (picks.length) lines.push(`Picked ${picks.join(' + ')}. ${picks.map(id => review.options.find(o => o.id === id)!.title).join(' + ')}.`);
  if (draft.none) lines.push('Picked none of them.');
  if (draft.reply) lines.push(draft.reply);
  if (draft.marks?.length) lines.push(draft.marks.map(m => markLine(review, m)).join('\n'));
  for (const o of review.options) if (Object.hasOwn(draft.notes, o.id) && draft.notes[o.id]) lines.push(`Notes on ${o.id} (${o.title}): ${draft.notes[o.id]}`);
  const passed = picks.length ? review.options.filter(o => !o.reference && !picks.includes(o.id)) : [];
  if (passed.length) lines.push(`Passed over: ${passed.map(o => `${o.id}. ${o.title}`).join('; ')}. ${PASSED_OVER_TAIL}`);
  return lines.join('\n\n');
}

// One of Mike's marks for the agent, after his reply: `[Mark 1] circle on A.
// <title>, picture 2 (<shot title>), across 36-50% and down 83-92% of it.`
// A pin's box is one spot: "across 40% and down 83%".
export function markLine(review: DesignReview, m: ReviewUserMark): string {
  const option = review.options.find(o => o.id === m.optionId);
  const shot = option ? shotsOf(option)[m.shot] : undefined;
  const span = (a: number, b: number) => {
    const [x, y] = [Math.round(a * 100), Math.round(b * 100)];
    return x === y ? `${x}%` : `${x}-${y}%`;
  };
  const on = option ? `${option.id}. ${option.title}` : m.optionId;
  return `[Mark ${m.n}] ${m.kind} on ${on}, picture ${m.shot + 1}${shot?.title ? ` (${shot.title})` : ''}, across ${span(m.box[0], m.box[2])} and down ${span(m.box[1], m.box[3])} of it.`;
}

// The answer's pictures for the agent: the reply's, then each mark's cut-out
// in mark order.
export function reviewImages(draft: ReviewDraft): ImageRef[] {
  return [...(draft.images ?? []), ...(draft.marks ?? []).flatMap(m => (m.image ? [m.image] : []))];
}
