// The comparison board on the iPhone (backend API 106): a review's sounds go
// up among its pictures, and an answer from the phone carries Mike's marks,
// their cut-outs passed to the runner as a send's photos are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const MINI = 'cb921b2447ea';
const TOKEN = 'phone-token';
const SRC = `review:r1:${'a'.repeat(64)}`;

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  await b.ctx.db.insert('runners', { runnerId: MINI, name: 'mac-mini', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  const tokenId = await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'iphone', kind: 'phone', expiresAt: Date.now() + 1e9, createdAt: Date.now() });
  await call(b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ ...THREAD_BASICS, threadId: 'B', runnerId: MINI, title: 'T', view: 'inbox', needsYou: false, status: 'running' }] });
  return { b, tokenId };
}

test("a review's sound goes up as a reply picture only with a review: src at seq 0", async () => {
  const { b } = await setup();
  const own = async (id: string) => (await b.ctx.db.insert('storageOwners', { storageId: b.file(id), runnerId: MINI, at: Date.now() }), id);
  await call(b.ctx, sync.addReplyImage, { key: MINI_KEY, threadId: 'B', seq: 0, path: SRC, src: SRC, storageId: await own('snd'), mediaType: 'audio/wav' });
  assert.equal(b.rows('replyImages').length, 1);
  // Anywhere else a sound is still refused.
  assert.equal(await outcome(call(b.ctx, sync.addReplyImage, { key: MINI_KEY, threadId: 'B', seq: 3, path: 'x.wav', storageId: await own('snd2'), mediaType: 'audio/wav' })), 'badArgs');
  assert.equal(await outcome(call(b.ctx, sync.addReplyImage, { key: MINI_KEY, threadId: 'B', seq: 0, path: 'x.mp3', src: 'x.mp3', storageId: await own('snd3'), mediaType: 'audio/mpeg' })), 'badArgs');
  // The phone fetches it with the stills.
  const got = (await call(b.ctx, phone.reviewImages, { token: TOKEN, threadId: 'B', sources: [SRC] })) as { src: string }[];
  assert.deepEqual(got.map((g) => g.src), [SRC]);
});

test("a review answer's marks go to the runner, cut-outs as the command's photos by index", async () => {
  const { b, tokenId } = await setup();
  const upload = async (id: string, by = tokenId) => (await b.ctx.db.insert('phoneUploads', { ticketHash: id, tokenId: by, issuedAt: Date.now(), usedAt: Date.now(), storageId: b.file(id), bytes: 1000 }), id);
  const cut = await upload('cut1');
  const draft = {
    notes: [], reply: '[Mark 1] and [Mark 2]', pickedIds: ['A'],
    marks: [
      { n: 1, kind: 'circle', optionId: 'A', shot: 0, box: [0.1, 0.1, 0.4, 0.4], storageId: cut },
      { n: 2, kind: 'pin', optionId: 'A', shot: 1, box: [0.5, 0.5, 0.5, 0.5] },
    ],
  };
  const commandId = await call(b.ctx, phone.respondReview, { token: TOKEN, threadId: 'B', reviewId: 'r1', revision: 0, draft });
  const c = b.rows('commands').find((r) => r._id === commandId)!;
  assert.equal(c.kind, 'respondReview');
  assert.deepEqual(c.args.images, [{ storageId: cut, url: `https://files.example/${cut}` }]);
  assert.deepEqual(c.args.draft.marks, [
    { n: 1, kind: 'circle', optionId: 'A', shot: 0, box: [0.1, 0.1, 0.4, 0.4], image: 0 },
    { n: 2, kind: 'pin', optionId: 'A', shot: 1, box: [0.5, 0.5, 0.5, 0.5] },
  ]);
  // Recorded as on its way, and deleted once the runner has it.
  assert.equal(b.rows('commandFiles').length, 1);
  await call(b.ctx, sync.takeCommand, { key: MINI_KEY, commandId });
  await call(b.ctx, sync.finishCommand, { key: MINI_KEY, commandId, ok: true });
  assert.equal(b.rows('commandFiles').length, 0);

  // Without marks the command is as before.
  const plain = await call(b.ctx, phone.respondReview, { token: TOKEN, threadId: 'B', reviewId: 'r1', revision: 0, draft: { notes: [], pickedIds: ['A'] } });
  const p = b.rows('commands').find((r) => r._id === plain)!;
  assert.ok(!('images' in p.args) && !('marks' in p.args.draft));

  // A box off the picture, too many marks, or another phone's upload is refused.
  const one = (m: Record<string, unknown>) => call(b.ctx, phone.respondReview, { token: TOKEN, threadId: 'B', reviewId: 'r1', revision: 0, draft: { notes: [], marks: [{ n: 1, kind: 'pin', optionId: 'A', shot: 0, box: [0, 0, 0, 0], ...m }] } });
  await assert.rejects(one({ box: [0, 0, 1.5, 1] }));
  await assert.rejects(one({ box: [0, 0, 1] }));
  await assert.rejects(one({ n: 0 }));
  await assert.rejects(one({ shot: 8 }));
  // Any positive whole number: a Mac mark numbered 1000 leaves the phone 1001.
  await call(b.ctx, phone.respondReview, { token: TOKEN, threadId: 'B', reviewId: 'r1', revision: 0, draft: { notes: [], marks: [{ n: 1001, kind: 'pin', optionId: 'A', shot: 7, box: [0, 0, 0, 0] }] } });
  await assert.rejects(call(b.ctx, phone.respondReview, { token: TOKEN, threadId: 'B', reviewId: 'r1', revision: 0, draft: { notes: [], marks: Array.from({ length: 21 }, (_, i) => ({ n: i + 1, kind: 'pin', optionId: 'A', shot: 0, box: [0, 0, 0, 0] })) } }));
  const other = await b.ctx.db.insert('tokens', { hash: await sha256('other'), name: 'ipad', kind: 'phone', expiresAt: Date.now() + 1e9, createdAt: Date.now() });
  assert.equal(await outcome(one({ storageId: await upload('theirs', other) })), 'notFound');
});


test('review HTML uses the existing opaque media path without a backend API change', async () => {
  const { b } = await setup();
  const storageId = b.file('html');
  await b.ctx.db.insert('storageOwners', { storageId, runnerId: MINI, at: Date.now() });
  await call(b.ctx, sync.addReplyImage, { key: MINI_KEY, threadId: 'B', seq: 0, path: SRC, src: SRC, storageId, mediaType: 'text/html' });
  const got = await call(b.ctx, phone.reviewImages, { token: TOKEN, threadId: 'B', sources: [SRC] }) as { src: string; url: string }[];
  assert.equal(got.length, 1);
  assert.equal(got[0]?.src, SRC);
  assert.ok(got[0]?.url);
  assert.equal(b.rows('replyImages')[0]?.mediaType, 'text/html');
});
