import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARTIFACT_CSP,
  ARTIFACT_TICKET_COOKIE,
  MAX_ARTIFACT_BYTES,
  artifactPage,
  artifactSlug,
  artifactTicketCookie,
  clearArtifactTicketCookie,
  privateArtifactGate,
  readArtifactTicket,
  slugFromUrl,
} from '../../../convex/artifactPage.ts';

const slug = '8fd09e30f5903a93471048c1c6c32d33';
const ticket = 'a'.repeat(48);

test('the public route takes exactly one artifact slug', () => {
  assert.equal(artifactSlug(`/a/${slug}`), slug);
  assert.equal(slugFromUrl(`https://threadbear.example/a/${slug}#cost`), slug);
  assert.equal(slugFromUrl('not-a-url'), null);
  for (const path of ['/a/', '/a/auth', '/s/' + slug, `/a/${slug}/more`, `/a/${slug}/`, '/a/%ff', '/a/Trip']) {
    assert.equal(artifactSlug(path), null, path);
  }
});

test('artifacts allow up to 10 MiB and run authored scripts inside an opaque offline sandbox', async () => {
  assert.equal(MAX_ARTIFACT_BYTES, 10 * 1024 * 1024);
  const html = '<!doctype html><title>Interactive</title><script>window.ok = true;</script><p>Hi</p>';
  const response = artifactPage(html);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), html);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  const policy = response.headers.get('content-security-policy') ?? '';
  assert.equal(policy, ARTIFACT_CSP);
  assert.match(policy, /(?:^|; )sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads(?:;|$)/);
  assert.doesNotMatch(policy, /allow-same-origin/);
  assert.match(policy, /(?:^|; )default-src 'none'(?:;|$)/);
  assert.match(policy, /(?:^|; )connect-src 'none'(?:;|$)/);
  assert.match(policy, /(?:^|; )form-action 'none'(?:;|$)/);
  assert.match(policy, /(?:^|; )frame-ancestors 'none'(?:;|$)/);
  assert.match(policy, /(?:^|; )script-src 'unsafe-inline' 'unsafe-eval' blob: data:(?:;|$)/);
  assert.match(policy, /(?:^|; )media-src data: blob:(?:;|$)/);
});

test('artifactPage streams Blob bodies directly from file storage', async () => {
  const blob = new Blob(['<h1>Stored</h1>'], { type: 'application/octet-stream' });
  const response = artifactPage(blob, { 'Set-Cookie': clearArtifactTicketCookie(slug, true) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await response.text(), '<h1>Stored</h1>');
  assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/);
});

test('private artifact gate uses a fresh nonce CSP and never embeds authored HTML', async () => {
  const a = privateArtifactGate(slug);
  const b = privateArtifactGate(slug);
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('cache-control'), 'no-store');
  const policyA = a.headers.get('content-security-policy') ?? '';
  const policyB = b.headers.get('content-security-policy') ?? '';
  const nonceA = policyA.match(/script-src 'nonce-([+/a-zA-Z0-9=]+)'/)?.[1];
  assert.ok(nonceA);
  assert.equal(Buffer.from(nonceA, 'base64').length, 16);
  assert.notEqual(policyA, policyB);
  assert.match(policyA, /(?:^|; )connect-src 'self'(?:;|$)/);
  assert.match(policyA, /(?:^|; )frame-ancestors 'none'(?:;|$)/);
  const html = await a.text();
  assert.ok(html.includes(`<script nonce="${nonceA}">`));
  assert.ok(html.includes("localStorage.getItem('threadbear.token')"));
  assert.ok(html.includes('"/a/auth"'));
});

test('ticket cookie helpers format, parse, skip malformed values, and clear cleanly', () => {
  const cookie = artifactTicketCookie(slug, ticket, true);
  assert.match(cookie, new RegExp(`^${ARTIFACT_TICKET_COOKIE}=${ticket}; Path=/a/${slug}; HttpOnly; SameSite=Lax; Max-Age=30; Secure$`));
  assert.equal(readArtifactTicket(`other=1; ${ARTIFACT_TICKET_COOKIE}=bad; ${ARTIFACT_TICKET_COOKIE}=${ticket}`), ticket);
  assert.equal(readArtifactTicket(`${ARTIFACT_TICKET_COOKIE}=not-hex`), null);
  assert.equal(readArtifactTicket(null), null);
  assert.match(clearArtifactTicketCookie(slug, false), new RegExp(`^${ARTIFACT_TICKET_COOKIE}=; Path=/a/${slug}; HttpOnly; SameSite=Lax; Max-Age=0$`));
});

test('missing and unpublished links return an uncached 404', async () => {
  const response = artifactPage(null);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'This artifact is unavailable.');
});
