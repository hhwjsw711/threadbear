import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { draftFromPhone, mergePhoneMarks, phoneReview, reviewImageSource, reviewStills } from '../../src/phone-reviews.ts';
import type { DesignReview } from '../../src/protocol.ts';
import { readShareMedia, PAGE_TYPE } from '../../src/share-images.ts';
import { makePng } from '../helpers/png.ts';

const review: DesignReview = {
  id: 'review-id', title: 'Pick a layout', recommended: 'A', status: 'pending', revision: 0,
  createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z', draft: { notes: {} },
  options: [{ id: 'A', title: 'First', image: { path: '/private/first.png', mediaType: 'image/png' }, url: 'http://localhost:3000/private',
    shots: [{ title: 'Overview', image: { path: '/private/first.png', mediaType: 'image/png' }, media: { path: '/private/page.html', mediaType: 'text/html' } }] },
  { id: 'B', title: 'Today', reference: true, image: { path: '/private/ref.png', mediaType: 'image/png' } }],
};

test('phone reviews keep choices and labels without exposing local paths or HTML', () => {
  const dto = phoneReview(review);
  assert.equal(dto.recommended, 'A');
  assert.equal(dto.options[1].reference, true);
  assert.equal(dto.options[0].shots[0].kind, 'page');
  assert.equal(dto.options[0].shots[0].title, 'Overview');
  const sound = phoneReview({ ...review, options: [{ ...review.options[0], shots: [{ image: review.options[0].image, media: { path: '/private/bed.m4a', mediaType: 'audio/mp4' } }] }] });
  assert.equal(sound.options[0].shots[0].kind, 'audio');
  assert.ok(!JSON.stringify(dto).includes('/private'));
  assert.deepEqual(dto.draft, { notes: {}, nextMark: 0, markCount: 0 });
  assert.equal(dto.canMark, true);
});

test("a draft's pasted pictures, which are paths on the Mac, never reach the phone", () => {
  const withImages: DesignReview = {
    ...review,
    draft: { pickedIds: ['A'], notes: { A: 'Tighter' }, reply: 'Go', images: [{ path: '/Users/me/Library/Application Support/Threadbear/threads/t/media/reviews/r/reply/abc.png', mediaType: 'image/png' }] },
  };
  const dto = phoneReview(withImages);
  assert.deepEqual(dto.draft, { pickedIds: ['A'], notes: { A: 'Tighter' }, reply: 'Go', nextMark: 0, markCount: 0 });
  assert.ok(!JSON.stringify(dto).includes('/Users/'), JSON.stringify(dto));
  // An answered review shows its response, which is cleaned the same way.
  const answered = phoneReview({ ...withImages, status: 'answered', response: withImages.draft });
  assert.ok(!JSON.stringify(answered).includes('/Users/'));
  assert.ok(!('images' in answered.draft));
});

test("the phone's answer is rebuilt field by field, notes from a list", () => {
  const draft = draftFromPhone({ pickedIds: ['A'], notes: [{ id: '$odd', text: 'one' }, { id: 'Café', text: 'two' }, { id: '__proto__', text: 'three' }], reply: 'Go', images: [{ path: '/etc/passwd' }] });
  assert.deepEqual(Object.keys(draft.notes), ['$odd', 'Café', '__proto__']);
  assert.equal(draft.notes['__proto__'], 'three');
  assert.equal(draft.reply, 'Go');
  assert.ok(!('images' in draft), 'pictures from the phone are never taken: they would name files on this Mac');
  assert.throws(() => draftFromPhone({ notes: { A: 'object' } }));
  assert.throws(() => draftFromPhone({ notes: [], pickedIds: [1] }));
});

test("a review's stills: only files in its own folder, not links, each once", async () => {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-reviews-'));
  try {
    const dir = path.join(media, 'reviews', review.id);
    fs.mkdirSync(dir, { recursive: true });
    const good = path.join(dir, 'a.png');
    fs.writeFileSync(good, makePng(40, 30));
    const junk = path.join(dir, 'b.png');
    fs.writeFileSync(junk, 'not a picture at all');
    // A picture elsewhere on the Mac, named outright and through a link.
    const elsewhere = path.join(media, 'private.png');
    fs.writeFileSync(elsewhere, makePng(10, 10));
    const link = path.join(dir, 'link.png');
    fs.symlinkSync(elsewhere, link);
    const still = (p: string) => ({ path: p, mediaType: 'image/png' });
    const r: DesignReview = { ...review, options: [
      { id: 'A', title: 'A', image: still(good), shots: [{ image: still(good) }, { image: still(good), title: 'again' }] },
      { id: 'B', title: 'B', image: still(junk) },
      { id: 'C', title: 'C', image: still(path.join(dir, 'gone.png')) },
      { id: 'D', title: 'D', image: still(elsewhere) },
      { id: 'E', title: 'E', image: still(link) },
    ] };
    const { stills, noPreview } = await reviewStills(r, media);
    assert.deepEqual(stills, [{ src: reviewImageSource(r.id, good), read: good, within: dir }], 'the same still goes once');
    assert.deepEqual([...noPreview].sort(), [junk, path.join(dir, 'gone.png'), elsewhere, link].map((p) => reviewImageSource(r.id, p)).sort());
    const dto = phoneReview(r, noPreview);
    assert.equal(dto.options[0].shots[0].preview, undefined);
    assert.ok(dto.options.slice(1).every((o) => o.shots[0].preview === false));
    // A review id that would lead out of the folder sends nothing.
    assert.equal((await reviewStills({ ...r, id: '../x' }, media)).stills.length, 0);
  } finally {
    fs.rmSync(media, { recursive: true, force: true });
  }
});

// A BMP of noise: over the 10 MB a reply picture may be, and a format the
// phone's pictures don't take.
function bigBmp(file: string): void {
  const w = 1900, h = 1900, row = (w * 3 + 3) & ~3, size = row * h;
  const head = Buffer.alloc(54);
  head.write('BM', 0);
  head.writeUInt32LE(54 + size, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(w, 18);
  head.writeInt32LE(h, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(size, 34);
  fs.writeFileSync(file, Buffer.concat([head, crypto.randomBytes(size)]));
}

test('a still too big for the phone goes as a shrunk JPEG beside it', { skip: !['darwin', 'win32'].includes(process.platform) && 'needs sips, or Windows\' own imaging' }, async () => {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-reviews-'));
  try {
    const dir = path.join(media, 'reviews', review.id);
    fs.mkdirSync(dir, { recursive: true });
    const big = path.join(dir, 'big.bmp');
    bigBmp(big);
    assert.ok(fs.statSync(big).size > 10 * 1024 * 1024);
    const r: DesignReview = { ...review, options: [{ id: 'A', title: 'A', image: { path: big, mediaType: 'image/bmp' } }] };
    const { stills, noPreview } = await reviewStills(r, media);
    assert.equal(noPreview.size, 0);
    assert.equal(stills.length, 1);
    assert.equal(path.dirname(stills[0]!.read), path.join(dir, 'phone'));
    assert.ok(fs.statSync(stills[0]!.read).size <= 10 * 1024 * 1024);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'phone')), [path.basename(stills[0]!.read)], 'no copy or part file left behind');
    // Made once: the next open sends the same file.
    assert.deepEqual((await reviewStills(r, media)).stills, stills);
  } finally {
    fs.rmSync(media, { recursive: true, force: true });
  }
});

test("a still that can't be shrunk is only no preview, never an error naming a path", async () => {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-reviews-'));
  try {
    const dir = path.join(media, 'reviews', review.id);
    fs.mkdirSync(dir, { recursive: true });
    const big = path.join(dir, 'big.bmp');
    bigBmp(big);
    fs.writeFileSync(path.join(dir, 'phone'), 'a file where the folder goes');
    const r: DesignReview = { ...review, options: [{ id: 'A', title: 'A', image: { path: big, mediaType: 'image/bmp' } }] };
    const { stills, noPreview } = await reviewStills(r, media);
    assert.equal(stills.length, 0);
    assert.equal(noPreview.size, 1);
  } finally {
    fs.rmSync(media, { recursive: true, force: true });
  }
});

// Since API 106 the phone draws the agent's marks; Mike's own saved on the
// Mac stay there, as a cut-out's path is a file on the Mac.
test("the agent's marks reach the phone, Mike's saved ones and their paths don't", () => {
  const marked: DesignReview = {
    ...review,
    options: [{ ...review.options[0], shots: [{ ...review.options[0].shots![0], marks: [{ kind: 'circle', box: [0, 0, 0.5, 0.5], note: 'Here' }, { kind: 'arrow', box: [0.1, 0.2, 0.3, 0.4], ink: 'green' }] }] }, review.options[1]],
    draft: { notes: {}, reply: '[Mark 1]', marks: [{ n: 1, kind: 'pin', optionId: 'A', shot: 0, box: [0.2, 0.2, 0.2, 0.2], image: { path: '/Users/me/cut.png', mediaType: 'image/png' } }] },
  };
  const dto = phoneReview(marked);
  assert.deepEqual(dto.options[0].shots[0].marks, [
    { kind: 'circle', box: [0, 0, 0.5, 0.5], note: 'Here', ink: 'yellow' },
    { kind: 'arrow', box: [0.1, 0.2, 0.3, 0.4], ink: 'green' },
  ]);
  assert.equal(dto.options[1].shots[0].marks, undefined);
  // Only the number to go on from: the phone numbers its own marks after it.
  assert.deepEqual(dto.draft, { notes: {}, reply: '[Mark 1]', nextMark: 1, markCount: 1 });
  assert.ok(!JSON.stringify(dto).includes('/Users/'), JSON.stringify(dto));
  // An answer from the phone with no marks brings none in, so the Mac's stay.
  assert.ok(!('marks' in draftFromPhone({ notes: [], marks: [] })));
  assert.ok(!('marks' in draftFromPhone({ notes: [] })));
});

test("the phone's marks come in with their cut-outs, by index into the command's photos", () => {
  const cut = { path: '/tmp/inbox/phone-1.jpg', mediaType: 'image/jpeg' };
  const draft = draftFromPhone({ notes: [], reply: 'This [Mark 1] and [Mark 2]', marks: [
    { n: 1, kind: 'circle', optionId: 'A', shot: 0, box: [0.1, 0.1, 0.4, 0.3], image: 0 },
    { n: 2, kind: 'pin', optionId: 'A', shot: 0, box: [0.5, 0.5, 0.5, 0.5] },
  ] }, [cut]);
  assert.deepEqual(draft.marks, [
    { n: 1, kind: 'circle', optionId: 'A', shot: 0, box: [0.1, 0.1, 0.4, 0.3], image: cut },
    { n: 2, kind: 'pin', optionId: 'A', shot: 0, box: [0.5, 0.5, 0.5, 0.5] },
  ]);
  // A path from the phone is never taken, and an index must name a photo.
  assert.ok(!('path' in draftFromPhone({ notes: [], marks: [{ n: 1, kind: 'pin', optionId: 'A', shot: 0, box: [0, 0, 0, 0], path: [[0, 0]] }] }).marks![0]!));
  assert.throws(() => draftFromPhone({ notes: [], marks: [{ n: 1, kind: 'pin', optionId: 'A', shot: 0, box: [0, 0, 0, 0], image: 1 }] }, [cut]));
  assert.throws(() => draftFromPhone({ notes: [], marks: [{ n: 1, kind: 'pin', optionId: 'A', shot: 0, box: [0, 0, 0, 0], image: { path: '/etc/passwd' } }] }, [cut]));
  assert.throws(() => draftFromPhone({ notes: [], marks: [{ n: 1, kind: 'pin', optionId: 'A', shot: 0, box: [0, 0] }] }));
  assert.throws(() => draftFromPhone({ notes: [], marks: 'x' }));
});

// A minimal MP4's start: its size, then ftyp and a brand.
function mp4(brand = 'isom', size = 64): Buffer {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(32, 0);
  b.write('ftyp', 4);
  b.write(brand, 8);
  return b;
}

test("a shot's video, sound or single HTML file goes up with the stills, up to 10 MB", async () => {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-reviews-'));
  try {
    const dir = path.join(media, 'reviews', review.id);
    fs.mkdirSync(dir, { recursive: true });
    const still = path.join(dir, 's.png');
    fs.writeFileSync(still, makePng(20, 20));
    const clip = path.join(dir, 'clip.mp4');
    fs.writeFileSync(clip, mp4());
    const sound = path.join(dir, 'bed.wav');
    const wav = Buffer.alloc(64);
    wav.write('RIFF', 0);
    wav.write('WAVE', 8);
    fs.writeFileSync(sound, wav);
    const big = path.join(dir, 'big.mp4');
    fs.writeFileSync(big, Buffer.concat([mp4(), Buffer.alloc(10 * 1024 * 1024)]));
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, '<!doctype html><title>x</title>');
    const fake = path.join(dir, 'fake.mp4');
    fs.writeFileSync(fake, 'not a video');
    const img = { path: still, mediaType: 'image/png' };
    const r: DesignReview = { ...review, options: [{ id: 'A', title: 'A', image: img, shots: [
      { image: img, media: { path: clip, mediaType: 'video/mp4' } },
      { image: img, media: { path: sound, mediaType: 'audio/wav' } },
      { image: img, media: { path: big, mediaType: 'video/mp4' } },
      { image: img, media: { path: page, mediaType: 'text/html' } },
      { image: img, media: { path: fake, mediaType: 'video/mp4' } },
    ] }] };
    const { stills, noPreview, media: playable } = await reviewStills(r, media);
    const src = (p: string) => reviewImageSource(r.id, p);
    assert.deepEqual(stills, [
      { src: src(still), read: still, within: dir },
      { src: src(clip), read: clip, within: dir, media: true },
      { src: src(sound), read: sound, within: dir, media: true },
      { src: src(page), read: page, within: dir, media: true },
    ]);
    assert.deepEqual([...playable], [src(clip), src(sound), src(page)]);
    const dto = phoneReview(r, noPreview, playable);
    assert.deepEqual(dto.options[0].shots.map((s) => [s.kind, s.media]), [
      ['video', src(clip)], ['audio', src(sound)], ['video', undefined], ['page', src(page)], ['video', undefined],
    ]);
    assert.ok(!JSON.stringify(dto).includes(dir));
    // Without the set (an older backend), no shot names its media.
    assert.ok(phoneReview(r, noPreview).options[0].shots.every((s) => s.media === undefined));
  } finally {
    fs.rmSync(media, { recursive: true, force: true });
  }
});

test("the phone's marks join the Mac's saved ones; a clash or too many is refused", () => {
  const cut = { path: '/x/reviews/review-id/reply/cut.png', mediaType: 'image/png' };
  const saved = { n: 2, kind: 'pin' as const, optionId: 'A', shot: 0, box: [0.2, 0.2, 0.2, 0.2] as [number, number, number, number], image: cut };
  const r: DesignReview = { ...review, draft: { notes: {}, marks: [saved] } };
  const phone = (n: number) => ({ n, kind: 'circle' as const, optionId: 'A', shot: 0, box: [0, 0, 0.5, 0.5] as [number, number, number, number] });
  assert.deepEqual(mergePhoneMarks(r, { notes: {}, marks: [phone(3)] }).marks, [saved, phone(3)]);
  // No phone marks: the draft as it came, and the Mac's stay by withSavedImages.
  assert.deepEqual(mergePhoneMarks(r, { notes: {} }), { notes: {} });
  assert.throws(() => mergePhoneMarks(r, { notes: {}, marks: [phone(2)] }), /Mark 2 is already on this review from the Mac/);
  assert.throws(() => mergePhoneMarks(r, { notes: {}, marks: Array.from({ length: 20 }, (_, i) => phone(i + 3)) }), /at most 20 marks/);
  // The limit counts marks, not numbers: 19 more numbered past 20 are fine.
  assert.equal(mergePhoneMarks(r, { notes: {}, marks: Array.from({ length: 19 }, (_, i) => phone(i + 30)) }).marks!.length, 20);
  // Answered (its draft has the phone's marks now): a retry's marks stand in
  // for theirs, no clash, and reviews.respond decides.
  const answered: DesignReview = { ...r, status: 'answered', draft: { notes: {}, marks: [saved, phone(3)] } };
  assert.deepEqual(mergePhoneMarks(answered, { notes: {}, marks: [phone(3)] }).marks, [saved, phone(3)]);
  // Never an error once it isn't pending, even past 20: reviews.respond says what's so.
  assert.equal(mergePhoneMarks({ ...answered, status: 'cancelled' }, { notes: {}, marks: Array.from({ length: 25 }, (_, i) => phone(i + 2)) }).marks!.length, 25);
});


test('review HTML upload reads one confined file, rejects links, non-HTML and oversized bytes', () => {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-review-html-'));
  try {
    const within = path.join(media, 'review');
    fs.mkdirSync(within);
    const html = path.join(within, 'option.html');
    const bytes = '<!doctype html><button onclick="this.textContent=1">0</button><img src="private.txt">';
    fs.writeFileSync(html, bytes);
    fs.writeFileSync(path.join(within, 'private.txt'), 'sibling-private-data');
    const read = readShareMedia(html, within);
    assert.ok(!('skip' in read));
    assert.equal(read.mediaType, PAGE_TYPE);
    assert.equal(Buffer.from(read.bytes).toString(), bytes, 'no sibling bytes are bundled');
    const outside = path.join(media, 'outside.html');
    fs.writeFileSync(outside, bytes);
    assert.ok('skip' in readShareMedia(outside, within));
    const link = path.join(within, 'link.html');
    fs.symlinkSync(outside, link);
    assert.ok('skip' in readShareMedia(link, within));
    fs.writeFileSync(html, 'not an HTML page');
    assert.ok('skip' in readShareMedia(html, within));
    fs.writeFileSync(html, '<!doctype html>' + ' '.repeat(10 * 1024 * 1024));
    assert.ok('skip' in readShareMedia(html, within));
  } finally { fs.rmSync(media, { recursive: true, force: true }); }
});
