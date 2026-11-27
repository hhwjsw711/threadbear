import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend } from '../helpers/convex-memory.ts';
import { MAX_ARTIFACT_BYTES, slugFromUrl } from '../../../convex/artifactPage.ts';

const OWNER = 'owner-key';
const TOKEN = 'browser-token';
const SOURCE = '1'.repeat(64);
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DAY = 24 * 60 * 60_000;

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  const now = Date.now();
  await b.ctx.db.insert('tokens', {
    hash: await sha256(TOKEN),
    name: 'browser',
    kind: 'browser',
    expiresAt: now + 30 * DAY,
    createdAt: now,
  });
  return b;
}

test('sync stores large HTML in file storage as private by default, updates in place, switches visibility, and cleans up blobs', async () => {
  const b = await setup();
  const f1 = b.file('html-v1', 2 * 1024 * 1024);
  const first = await call(b.ctx, sync.manageArtifact, {
    key: OWNER,
    source: SOURCE,
    change: { action: 'sync', title: 'Phone sizes', storageId: f1, digest: DIGEST_A },
  });
  assert.equal(first.changed, true);
  assert.equal(first.visibility, 'private');
  assert.equal(first.digest, DIGEST_A);
  const slug = slugFromUrl(first.url);
  assert.ok(slug);
  assert.equal(await sync.storageInUse(b.ctx, f1), true);

  // Hosted query reports storageId and private visibility.
  const read1 = await call(b.ctx, sync.hostedArtifact, { slug });
  assert.deepEqual(read1, { title: 'Phone sizes', storageId: f1, visibility: 'private' });

  // Switch visibility to public; custom origin URL still matches by slug.
  const customUrl = `https://threadbear.example/a/${slug}`;
  const madePublic = await call(b.ctx, sync.manageArtifact, {
    key: OWNER,
    source: SOURCE,
    change: { action: 'setVisibility', visibility: 'public', expected: customUrl },
  });
  assert.equal(madePublic.changed, true);
  assert.equal(madePublic.visibility, 'public');
  assert.equal((await call(b.ctx, sync.hostedArtifact, { slug })).visibility, 'public');

  // Re-syncing new bytes keeps public visibility and deletes old blob.
  const f2 = b.file('html-v2', 3 * 1024 * 1024);
  const second = await call(b.ctx, sync.manageArtifact, {
    key: OWNER,
    source: SOURCE,
    change: { action: 'sync', title: 'Phone sizes v2', storageId: f2, digest: DIGEST_B },
  });
  assert.equal(second.url, first.url);
  assert.equal(second.visibility, 'public');
  assert.equal(second.digest, DIGEST_B);
  assert.equal(b.hasFile(f1), false);
  assert.equal(b.hasFile(f2), true);

  // Unpublish deletes row and stored file.
  const removed = await call(b.ctx, sync.manageArtifact, {
    key: OWNER,
    source: SOURCE,
    change: { action: 'unpublish', expected: customUrl },
  });
  assert.equal(removed.changed, true);
  assert.equal(removed.url, null);
  assert.equal(b.hasFile(f2), false);
  assert.equal(await call(b.ctx, sync.hostedArtifact, { slug }), null);
});

test('sync rejects files over 10 MiB without throwing so the blob deletion commits', async () => {
  const b = await setup();
  const huge = b.file('too-big', MAX_ARTIFACT_BYTES + 1);
  const res = await call(b.ctx, sync.manageArtifact, {
    key: OWNER,
    source: SOURCE,
    change: { action: 'sync', title: 'Huge', storageId: huge, digest: DIGEST_A },
  });
  assert.equal(res.changed, false);
  assert.match(res.error ?? '', /10 MiB/);
  assert.equal(b.hasFile(huge), false);
});

test('a delayed sync after unpublish does not recreate the removed artifact and frees its blob', async () => {
  const b = await setup();
  const f1 = b.file('v1', 1024);
  const first = await call(b.ctx, sync.manageArtifact, {
    key: OWNER,
    source: SOURCE,
    change: { action: 'sync', title: 'Page', storageId: f1, digest: DIGEST_A },
  });
  await call(b.ctx, sync.manageArtifact, {
    key: OWNER,
    source: SOURCE,
    change: { action: 'unpublish', expected: first.url },
  });
  const staleBlob = b.file('v2-stale', 2048);
  const late = await call(b.ctx, sync.manageArtifact, {
    key: OWNER,
    source: SOURCE,
    change: { action: 'sync', title: 'Page', storageId: staleBlob, digest: DIGEST_B, expected: first.url },
  });
  assert.equal(late.changed, false);
  assert.equal(late.url, null);
  assert.equal(b.hasFile(staleBlob), false);
});

test('legacy inline HTML rows without visibility remain public on read and when upgraded via sync', async () => {
  const b = await setup();
  const slug = 'f0c19bda392576b4eee9c2fa5dd1000a';
  await b.ctx.db.insert('artifacts', { slug, title: 'Legacy', html: '<h1>Old</h1>', source: SOURCE });
  const read = await call(b.ctx, sync.hostedArtifact, { slug });
  assert.deepEqual(read, { title: 'Legacy', html: '<h1>Old</h1>', visibility: 'public' });

  const upgradedBlob = b.file('upgraded', 4096);
  const upgraded = await call(b.ctx, sync.manageArtifact, {
    key: OWNER,
    source: SOURCE,
    change: { action: 'sync', title: 'Legacy v2', storageId: upgradedBlob, digest: DIGEST_B, expected: `https://site.example/a/${slug}` },
  });
  assert.equal(upgraded.changed, true);
  assert.equal(upgraded.visibility, 'public');
  assert.equal((await call(b.ctx, sync.hostedArtifact, { slug })).visibility, 'public');
});

test('private artifact view tickets require a valid token, match one slug, and are single-use', async () => {
  const b = await setup();
  const f1 = b.file('priv-html', 1200);
  const saved = await call(b.ctx, sync.manageArtifact, {
    key: OWNER,
    source: SOURCE,
    change: { action: 'sync', title: 'Secret', storageId: f1, digest: DIGEST_A },
  });
  const slug = slugFromUrl(saved.url)!;
  const otherSlug = '0'.repeat(32);

  // Bad token -> 401.
  assert.deepEqual(
    await call(b.ctx, sync.issueArtifactView, { token: 'wrong-token', slug }),
    { ok: false, status: 401 },
  );
  // Missing slug -> 404.
  assert.deepEqual(
    await call(b.ctx, sync.issueArtifactView, { token: TOKEN, slug: otherSlug }),
    { ok: false, status: 404 },
  );
  // Valid token + slug -> single-use ticket bound to that slug.
  const issued = await call(b.ctx, sync.issueArtifactView, { token: TOKEN, slug });
  assert.equal(issued.ok, true);
  assert.match(issued.ticket, /^[a-f0-9]{48}$/);

  // Wrong slug consumes & rejects.
  const issued2 = await call(b.ctx, sync.issueArtifactView, { token: TOKEN, slug });
  assert.equal(await call(b.ctx, sync.consumeArtifactView, { ticket: issued2.ticket, slug: otherSlug }), false);
  // Replay after wrong-slug attempt is already spent.
  assert.equal(await call(b.ctx, sync.consumeArtifactView, { ticket: issued2.ticket, slug }), false);

  // Matching slug succeeds once, then replay fails.
  assert.equal(await call(b.ctx, sync.consumeArtifactView, { ticket: issued.ticket, slug }), true);
  assert.equal(await call(b.ctx, sync.consumeArtifactView, { ticket: issued.ticket, slug }), false);
});
