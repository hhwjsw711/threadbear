// A design review for the phone (docs/protocol/events.md, "Reviews on the phone"):
// its words, choices and notes, with each still named by an opaque source
// instead of its path on this Mac. Nothing path-like goes: not the option's
// files, its live url, nor the pictures pasted into a draft on the Mac
// (ReviewDraft.images, which are absolute paths).
//
// Stills go up only once the phone opens a review (reviewStills, from the
// designReviews command in sync.ts), not as reviews are made, so a review
// nobody reads on the phone never leaves the Mac. A shot's video or sound
// goes up with them (API 106), named the same way; HTML uses the sealed live view.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentMark, DesignReview, ImageRef, ReviewDraft, ReviewUserMark } from './protocol.ts';
import { convertImage } from './images.ts';
import { maxDraftMarks } from './reviews.ts';
import { readShareImage, readShareMedia, shrinkWouldDo } from './share-images.ts';

export function reviewImageSource(reviewId: string, imagePath: string): string {
  return `review:${reviewId}:${crypto.createHash('sha256').update(imagePath).digest('hex')}`;
}

// Every shot's still, as its option lists them.
function shotsOf(option: DesignReview['options'][number]) {
  return option.shots ?? [{ image: option.image }];
}

// What the phone may see of a draft: the picks, notes and reply. Not its
// pictures, which are local paths; an answer from the phone keeps the ones
// saved on the Mac (withSavedImages in runner/reviews.ts).
export function phoneDraft(d: ReviewDraft) {
  return {
    notes: d.notes ?? {},
    ...(d.pickedId !== undefined ? { pickedId: d.pickedId } : {}),
    ...(d.pickedIds ? { pickedIds: d.pickedIds } : {}),
    ...(d.reply !== undefined ? { reply: d.reply } : {}),
    ...(d.none ? { none: true as const } : {}),
  };
}

// A shot the phone can play, or a single HTML file for its sealed live view.
function playable(media: ImageRef | undefined): media is ImageRef {
  return Boolean(media && (media.mediaType.startsWith('video/') || media.mediaType.startsWith('audio/') || media.mediaType === 'text/html'));
}

// The agent's marks as the phone draws them: ink filled in with the window's
// default, so the phone needn't know it.
function phoneMarks(marks: AgentMark[]) {
  return marks.map((m) => ({ kind: m.kind, box: m.box, ...(m.note ? { note: m.note } : {}), ink: m.ink ?? 'yellow' }));
}

// noPreview: sources whose still can't go to the phone (gone, or not a
// picture even after shrinking), so it says so rather than waiting.
// media: the sources of shots' videos, sounds and HTML files that go up (reviewStills),
// each named on its shot as `media`; any other plays only on the Mac.
//
// canMark: this runner takes the phone's own marks (mergePhoneMarks), which
// an older one would drop, so the phone offers marking only with it.
// draft.nextMark: the highest number among the marks saved on the Mac (0
// with none); the phone numbers its own from the one after, so numbers can
// go past 20. draft.markCount: how many there are, for the 20-mark limit,
// which counts marks, not numbers.
export function phoneReview(review: DesignReview, noPreview: ReadonlySet<string> = new Set(), media: ReadonlySet<string> = new Set()) {
  return {
    id: review.id, title: review.title, status: review.status, revision: review.revision,
    canMark: true as const,
    ...(review.note ? { note: review.note } : {}),
    ...(review.recommended ? { recommended: review.recommended } : {}),
    draft: { ...phoneDraft(review.response ?? review.draft), nextMark: Math.max(0, ...(review.draft.marks ?? []).map((m) => m.n)), markCount: review.draft.marks?.length ?? 0 },
    options: review.options.map((option) => ({
      id: option.id, title: option.title,
      ...(option.note ? { note: option.note } : {}),
      ...(option.reference ? { reference: true } : {}),
      shots: shotsOf(option).map((shot) => {
        const src = reviewImageSource(review.id, shot.image.path);
        const play = playable(shot.media) ? reviewImageSource(review.id, shot.media.path) : undefined;
        return {
          src,
          ...(shot.title ? { title: shot.title } : {}),
          kind: shot.media?.mediaType === 'text/html' ? 'page' : shot.media?.mediaType.startsWith('audio/') ? 'audio' : shot.media ? 'video' : 'image',
          ...(noPreview.has(src) ? { preview: false } : {}),
          ...(play && media.has(play) ? { media: play } : {}),
          ...(shot.marks?.length ? { marks: phoneMarks(shot.marks) } : {}),
        };
      }),
    })),
  };
}

// An answer from the phone, as the runner takes it. Built field by field
// from what was checked, so nothing else (pictures above all, which would
// name files on this Mac) comes in with it. Notes come as a list: an option
// id can be any text, and Convex refuses an object key that isn't plain
// ASCII or starts with "$".
//
// marks (API 106): Mike's marks drawn on the phone, each with `image`, the
// index of its cut-out in the command's photos, which the runner has
// downloaded into inbox/ (`images`, in the same order). reviews.respond
// checks the rest (reviewDraft) and keeps the cut-outs (keepReplyImages).
// Only a non-empty list goes in: an answer with none keeps the marks saved
// on the Mac (withSavedImages), as an answer from an older phone does, and
// one with some adds them to those (mergePhoneMarks).
export function draftFromPhone(raw: unknown, images: readonly ImageRef[] = []): ReviewDraft {
  const bad = () => new Error('Invalid review answer.');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad();
  const r = raw as Record<string, unknown>;
  const notes: Record<string, string> = {};
  if (!Array.isArray(r.notes)) throw bad();
  for (const n of r.notes) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || typeof n.text !== 'string') throw bad();
    // Object.create(null)-safe: an id of "__proto__" still lands as a key.
    Object.defineProperty(notes, n.id, { value: n.text, enumerable: true, writable: true, configurable: true });
  }
  const out: ReviewDraft = { notes };
  if (r.pickedId !== undefined) {
    if (typeof r.pickedId !== 'string') throw bad();
    out.pickedId = r.pickedId;
  }
  if (r.pickedIds !== undefined) {
    if (!Array.isArray(r.pickedIds) || !r.pickedIds.every((id) => typeof id === 'string')) throw bad();
    out.pickedIds = r.pickedIds as string[];
  }
  if (r.reply !== undefined) {
    if (typeof r.reply !== 'string') throw bad();
    out.reply = r.reply;
  }
  if (r.none === true) out.none = true;
  if (r.marks !== undefined) {
    if (!Array.isArray(r.marks)) throw bad();
    const marks = r.marks.map((m): ReviewUserMark => {
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad();
      const { n, kind, optionId, shot, box, image } = m as Record<string, unknown>;
      if (typeof n !== 'number' || typeof kind !== 'string' || typeof optionId !== 'string' || typeof shot !== 'number') throw bad();
      if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === 'number')) throw bad();
      let cut: ImageRef | undefined;
      if (image !== undefined) {
        if (typeof image !== 'number' || !Number.isSafeInteger(image) || !images[image]) throw bad();
        cut = images[image];
      }
      return { n, kind: kind as ReviewUserMark['kind'], optionId, shot, box: box as ReviewUserMark['box'], ...(cut ? { image: cut } : {}) };
    });
    if (marks.length) out.marks = marks;
  }
  return out;
}

// The phone's marks added to the ones saved on the Mac, which it doesn't
// see (their cut-outs are files here) and which stay. A phone mark numbered
// as a saved one is refused rather than either being lost: the phone
// numbers from nextMark + 1, so a clash means the draft changed on the Mac
// meanwhile. Errors go to the phone as the command's note, so no paths.
//
// Only a pending review is checked for clashes. Once it's answered its
// draft holds the phone's marks too, so a retry of the same answer (a lost
// reply) would clash with itself: there the phone's marks stand in for
// saved ones of the same number, and reviews.respond decides, a retry as
// the same answer (sameDraft) and anything else as already answered.
export function mergePhoneMarks(review: DesignReview, draft: ReviewDraft): ReviewDraft {
  if (!draft.marks?.length) return draft;
  const phone = draft.marks;
  const saved = review.draft.marks ?? [];
  // Not pending: never an error from here, only the answer as a retry of it
  // would be, so reviews.respond reports what's so (the same answer, or
  // answered, cancelled or superseded).
  if (review.status !== 'pending') return { ...draft, marks: [...saved.filter((s) => !phone.some((m) => m.n === s.n)), ...phone] };
  const clash = phone.find((m) => saved.some((s) => s.n === m.n));
  if (clash) throw new Error(`Mark ${clash.n} is already on this review from the Mac. Reload the review and mark again.`);
  const marks = [...saved, ...phone];
  if (marks.length > maxDraftMarks) throw new Error(`A review answer can have at most ${maxDraftMarks} marks, counting the ${saved.length} made on the Mac.`);
  return { ...draft, marks };
}

// Longest side of a still shrunk for the phone: plenty for its screen.
const PHONE_STILL_PX = 2400;

// read: the file to send; within: the folder it must be in when it's read
// (readShareImage: no links, nothing outside). The row in Convex is named by
// src alone, never the path.
// media: a video, sound or HTML file, read as one (readShareMedia), not a picture.
export type ReviewStill = { src: string; read: string; within: string; media?: true };

// A review's stills ready to go up, and the ones that can't. Only files in
// the review's own media folder (`<thread media>/reviews/<id>`, where
// createReview copies them), not links, go: a review that came across in a
// move names paths that runner chose, so a path alone proves nothing. A still
// over the reply-picture limit (10 MB; a review takes 25) or in a format the
// phone doesn't take is shrunk to a JPEG in a `phone` folder beside it once,
// and that copy goes instead.
//
// A shot's video, sound or single HTML file goes too, from the same folder and up
// to the same 10 MB; a bigger one plays only on the Mac (media lists the
// ones that go, for phoneReview).
export async function reviewStills(review: DesignReview, threadMedia: string | undefined): Promise<{ stills: ReviewStill[]; noPreview: Set<string>; media: Set<string> }> {
  const stills: ReviewStill[] = [];
  const noPreview = new Set<string>();
  const media = new Set<string>();
  const seen = new Set<string>();
  const within = threadMedia && /^[a-zA-Z0-9-]{1,200}$/.test(review.id) ? path.join(threadMedia, 'reviews', review.id) : undefined;
  for (const option of review.options) {
    for (const shot of shotsOf(option)) {
      const file = shot.image.path;
      const src = reviewImageSource(review.id, file);
      if (seen.has(src)) continue;
      seen.add(src);
      const ready = within ? await phoneStill(file, within) : undefined;
      if (ready) stills.push({ src, read: ready, within: within! });
      else noPreview.add(src);
    }
    for (const shot of shotsOf(option)) {
      if (!within || !playable(shot.media)) continue;
      const src = reviewImageSource(review.id, shot.media.path);
      if (seen.has(src)) continue;
      seen.add(src);
      // Read once here to know it will go (the right kind, in the folder,
      // not too big), and again as it goes up, through the same checks.
      let ok = false;
      try {
        ok = !('skip' in readShareMedia(shot.media.path, within));
      } catch {
        // Only "no media": the phone shows the still.
      }
      if (ok) {
        stills.push({ src, read: shot.media.path, within, media: true });
        media.add(src);
      }
    }
  }
  return { stills, noPreview, media };
}

// Nothing here throws: a failure is only "no preview", as an error's text
// would name a path on this Mac and go to the phone as the command's note.
async function phoneStill(file: string, within: string): Promise<string | undefined> {
  try {
    return await shrunkStill(file, within);
  } catch {
    return undefined;
  }
}

async function shrunkStill(file: string, within: string): Promise<string | undefined> {
  const first = readShareImage(file, within);
  if (!('skip' in first)) return file;
  if (!shrinkWouldDo(first.skip)) return undefined;
  // Named for the still's whole path, so a.png and a.webp never share one.
  const small = path.join(within, 'phone', `${crypto.createHash('sha256').update(file).digest('hex').slice(0, 16)}-${path.basename(file)}.jpg`);
  if (!fs.existsSync(small)) {
    fs.mkdirSync(path.dirname(small), { recursive: true });
    // The converter gets a copy read through the checked file's own
    // descriptor, never the name again: the file swapped for a link in
    // between would otherwise hand it a picture from anywhere.
    const copy = `${small}.source`;
    const part = `${small}.part.jpg`;
    try {
      if (!copyChecked(file, within, copy)) return undefined;
      // Made aside and renamed, so one cut short never passes for the still.
      if (!(await convertImage(copy, part, { format: 'jpeg', quality: 80, maxPx: PHONE_STILL_PX }))) return undefined;
      fs.renameSync(part, small);
    } finally {
      fs.rmSync(copy, { force: true });
      fs.rmSync(part, { force: true });
    }
  }
  return 'skip' in readShareImage(small, within) ? undefined : small;
}

// A review takes stills up to 25 MB; a little room over that.
const STILL_MAX_BYTES = 30 * 1024 * 1024;

// Copies `file` to `to` if it's a plain file inside `within` (by its real
// path), opened without following a link and read through that descriptor.
function copyChecked(file: string, within: string, to: string): boolean {
  const real = fs.realpathSync(file);
  const rel = path.relative(fs.realpathSync(within), real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    const atReal = fs.statSync(real);
    if (!st.isFile() || st.size > STILL_MAX_BYTES || st.ino !== atReal.ino || st.dev !== atReal.dev) return false;
    const bytes = Buffer.alloc(st.size);
    let got = 0;
    while (got < bytes.length) {
      const n = fs.readSync(fd, bytes, got, bytes.length - got, got);
      if (n === 0) break;
      got += n;
    }
    fs.rmSync(to, { force: true }); // one left by a run that stopped partway
    fs.writeFileSync(to, bytes.subarray(0, got), { flag: 'wx' });
    return true;
  } finally {
    fs.closeSync(fd);
  }
}
