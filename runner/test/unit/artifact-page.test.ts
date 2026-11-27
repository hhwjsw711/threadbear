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

type HistoryEntry = { artifactEntry: string };
type FragmentMessage = { artifactFragment: string; entry: string; offset?: number[] };

async function viewer(navigation = 'navigate', name = '', hash = '#cost') {
  const html = await artifactPage({ title: 'Artifact', html: '<h2 id="cost">Cost</h2>' }).text();
  const viewerScript = html.match(/<script nonce="[^"]+">([^]*?)<\/script>/)?.[1];
  assert.ok(viewerScript);

  const events = new EventTarget();
  const location = { pathname: '/a/demo', hash };
  const history = {
    state: null as HistoryEntry | null,
    replaceState(state: HistoryEntry) { history.state = state; },
  };
  const messages: FragmentMessage[] = [];
  const frame = { postMessage(data: FragmentMessage, origin: string) {
    assert.equal(origin, '*'); // A sandboxed srcdoc has an opaque origin.
    messages.push(structuredClone(data));
  } };
  const replacement = Object.assign(new EventTarget(), { contentWindow: frame });
  const iframe = Object.assign(new EventTarget(), {
    contentWindow: navigation === 'back_forward' ? { postMessage() { assert.fail('sent to the old frame'); } } : frame,
    cloneNode: () => replacement,
    replaceWith(node: EventTarget) { assert.equal(node, replacement); },
  });
  const window = { location, name, addEventListener: events.addEventListener.bind(events) };
  let nextEntry = 0;
  runInNewContext(viewerScript, {
    window,
    history,
    document: { querySelector: () => iframe },
    crypto: { getRandomValues: () => [++nextEntry] },
    performance: { getEntriesByType: () => [{ type: navigation }] },
  });

  const fire = (type: string) => events.dispatchEvent(new Event(type));
  const change = (hash: string, state: HistoryEntry | null = null) => {
    location.hash = hash;
    history.state = state;
    fire('popstate');
    fire('hashchange');
  };
  const report = (offset: number[], entry = history.state?.artifactEntry) => {
    const event = Object.assign(new Event('message'), {
      source: frame, origin: 'null', data: { entry, artifactPosition: offset },
    });
    events.dispatchEvent(event);
  };

  fire('load');
  return { history, window, messages, replacement, change, report };
}

test('the wrapper forwards same-fragment history entries and only sends each entry once', async () => {
  const { history, change, messages } = await viewer();
  const firstCostEntry = history.state;
  change('#details');
  change('#cost');
  // Back two entries changes history.state while the URL stays the same.
  change('#cost', firstCostEntry);
  assert.deepEqual(messages.map(({ artifactFragment, entry }) => [artifactFragment, entry]), [
    ['#cost', '1'],
    ['#details', '2'],
    ['#cost', '3'],
    ['#cost', '1'],
  ]);
});

test('reloading restores the current entry and keeps earlier offsets for Back', async () => {
  const first = await viewer('navigate', '', '#intro');
  const intro = first.history.state;
  assert.ok(intro);
  first.report([0, 600]);
  first.change('#cost');
  const cost = first.history.state;
  first.report([0, 1000]);
  first.report([0, 625], intro.artifactEntry); // The frame's last snapshot before leaving.

  const reloaded = await viewer('reload', first.window.name, '#cost');
  assert.equal(reloaded.history.state?.artifactEntry, cost?.artifactEntry);
  assert.deepEqual(reloaded.messages[0]?.offset, [0, 1000]);
  reloaded.change('#intro', intro);
  assert.deepEqual(reloaded.messages[1]?.offset, [0, 625]);
});

test('history changes during a cold frame reload are sent to the new frame only', async () => {
  const { change, replacement, messages } = await viewer('back_forward');
  change('#details');
  assert.deepEqual(messages, []);
  replacement.dispatchEvent(new Event('load'));
  assert.deepEqual(messages.map(({ artifactFragment }) => artifactFragment), ['#details']);
});

test('a second history change cannot save the anchor position before restoration', async () => {
  const body = await artifactPage({ title: 'Artifact', html: '<h2 id="cost">Cost</h2>' }).text();
  const encoded = body.match(/srcdoc="([^"]*)"/)?.[1];
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };
  const script = encoded?.replace(/&(amp|lt|gt|quot);/g, (_, name: string) => entities[name])
    .match(/<script nonce="[^"]+">([^]*?)<\/script>/)?.[1];
  assert.ok(script);

  class Element extends EventTarget {
    get scrollLeft() { return 0; }
    get scrollTop() { return 0; }
  }
  class Document extends EventTarget {
    get scrollingElement() { return null; }
    querySelectorAll() { return []; }
  }
  const document = new Document();
  const frames: (() => void)[] = [];
  const positions: { entry: string; artifactPosition: number[] }[] = [];
  const parent = { postMessage(info: typeof positions[number]) { positions.push(structuredClone(info)); } };
  const location = {
    hash: '',
    replace(url: string) { location.hash = new URL(url).hash; window.scrollY = 500; },
  };
  const window = Object.assign(new EventTarget(), {
    parent, location, scrollX: 0, scrollY: 0,
    scrollTo({ top }: { top: number }) { window.scrollY = top; },
  });
  runInNewContext(script, {
    document, window, EventTarget, Document, Element,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  });
  const visit = (entry: string, artifactFragment: string, offset?: number[]) => {
    const event = Object.assign(new Event('message'), { source: parent, data: { entry, artifactFragment, offset } });
    window.dispatchEvent(event);
  };

  visit('cost', '#cost', [0, 2000]);
  frames.shift()?.();
  positions.length = 0;
  visit('details', '#details');
  frames.shift()?.();
  positions.length = 0;
  visit('cost', '#cost');
  document.dispatchEvent(new Event('scroll'));
  visit('details', '#details');
  visit('cost', '#cost');
  for (const paint of frames) paint();

  assert.equal(window.scrollY, 2000);
  assert.deepEqual(positions, [
    { entry: 'details', artifactPosition: [0, 500] },
    { entry: 'cost', artifactPosition: [0, 2000] },
  ]);
});

test('missing and unpublished links return an uncached 404', async () => {
  const response = artifactPage(null);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'This artifact is unavailable.');
});
