import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { artifactPage, artifactSlug, MAX_ARTIFACT_BYTES } from '../../../convex/artifactPage.ts';

const slug = '8fd09e30f5903a93471048c1c6c32d33';

test('the public route takes exactly one artifact slug', () => {
  assert.equal(artifactSlug(`/a/${slug}`), slug);
  for (const path of ['/a/', '/s/' + slug, `/a/${slug}/more`, `/a/${slug}/`, '/a/%ff', '/a/Trip']) {
    assert.equal(artifactSlug(path), null, path);
  }
});

test('the artifact content and title are isolated from the wrapper markup', async () => {
  const response = artifactPage({
    title: '</title><h1>Outside?</h1>',
    html: '<p title="A &amp; B">C</p>',
  });
  const page = await response.text();
  assert.match(page, /<title>&lt;\/title&gt;&lt;h1&gt;Outside\?&lt;\/h1&gt;<\/title>/);
  assert.match(page, /<iframe sandbox="allow-scripts" title="/);
  assert.match(page, /srcdoc="&lt;base href=&quot;about:srcdoc&quot;&gt;&lt;script nonce=&quot;[^"]+&quot;&gt;[^]*&lt;\/script&gt;&lt;p title=&quot;A &amp;amp; B&quot;&gt;C&lt;\/p&gt;"/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.match(response.headers.get('content-security-policy') ?? '', /base-uri about:/);
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(MAX_ARTIFACT_BYTES, 64 * 1024);
});

test('the fragment base follows the opening tags of a full document', async () => {
  const page = await artifactPage({
    title: 'Artifact',
    html: '\uFEFF<?xml version="1.0"?><!doctype html><!-- <head> --><html lang="fr"><head data-label="a > b"><title>Page</title>',
  }).text();
  assert.ok(page.includes(
    'srcdoc="&lt;?xml version=&quot;1.0&quot;?&gt;&lt;!doctype html&gt;&lt;!-- &lt;head&gt; --&gt;&lt;html lang=&quot;fr&quot;&gt;' +
    '&lt;head data-label=&quot;a &gt; b&quot;&gt;&lt;base href=&quot;about:srcdoc&quot;&gt;&lt;script nonce=',
  ));
  assert.ok(page.includes('&lt;/script&gt;&lt;title&gt;Page'));
});

test('the browser permits only the two trusted viewer scripts', async () => {
  const artifact = { title: 'Artifact', html: '<script>console.log("Not trusted");</script>' };
  const response = artifactPage(artifact);
  const html = await response.text();
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };
  const srcdoc = html.match(/srcdoc="([^"]*)"/)?.[1].replace(/&(amp|lt|gt|quot);/g, (_, name: string) => entities[name]);
  const policy = response.headers.get('content-security-policy') ?? '';
  const nonce = policy.match(/(?:^|; )script-src 'nonce-([+/a-zA-Z0-9=]+)'(?=;|$)/)?.[1];
  assert.ok(nonce);
  assert.equal(Buffer.from(nonce, 'base64').length, 16);
  assert.notEqual(artifactPage(artifact).headers.get('content-security-policy'), policy);
  assert.deepEqual([...(srcdoc ?? '').matchAll(/<script(?: nonce="([^"]*)")?>/g)].map(([, token]) => token), [nonce, undefined]);
  assert.deepEqual([...html.matchAll(/<script nonce="([^"]*)">/g)].map(([, token]) => token), [nonce]);
  assert.match(policy, /(?:^|; )sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox(?:;|$)/);
  assert.match(policy, /(?:^|; )script-src-attr 'none'(?:;|$)/);
});

test('the wrapper forwards same-fragment history entries and only sends each entry once', async () => {
  const html = await artifactPage({ title: 'Artifact', html: '<h2 id="cost">Cost</h2>' }).text();
  const viewerScript = html.match(/<script nonce="[^"]+">([^]*?)<\/script>/)?.[1];
  assert.ok(viewerScript);

  const events = new EventTarget();
  const location = { pathname: '/a/demo', hash: '#cost' };
  const history = {
    state: null as { artifactEntry: string } | null,
    replaceState(state: { artifactEntry: string }) { history.state = state; },
  };
  const messages: { artifactFragment: string; entry: string }[] = [];
  const iframe = {
    contentWindow: { postMessage: (data: typeof messages[number], origin: string) => {
      assert.equal(origin, '*'); // A sandboxed srcdoc has an opaque origin.
      messages.push(data);
    } },
  };
  let nextEntry = 0;
  runInNewContext(viewerScript, {
    window: { location, name: '', addEventListener: events.addEventListener.bind(events) },
    history,
    document: { querySelector: () => iframe },
    crypto: { getRandomValues: () => [++nextEntry] },
    performance: { getEntriesByType: () => [{ type: 'navigate' }] },
  });

  function change(hash: string) {
    location.hash = hash;
    history.state = null; // A new fragment creates a fresh history entry.
    events.dispatchEvent(new Event('popstate'));
    events.dispatchEvent(new Event('hashchange'));
  }

  events.dispatchEvent(new Event('load'));
  const firstCostEntry = history.state;
  change('#details');
  change('#cost');

  // Back two entries changes history.state while the URL stays the same.
  history.state = firstCostEntry;
  events.dispatchEvent(new Event('popstate'));
  assert.deepEqual(messages.map(({ artifactFragment, entry }) => [artifactFragment, entry]), [
    ['#cost', '1'],
    ['#details', '2'],
    ['#cost', '3'],
    ['#cost', '1'],
  ]);
});

test('missing and unpublished links return an uncached 404', async () => {
  const response = artifactPage(null);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'This artifact is unavailable.');
});
