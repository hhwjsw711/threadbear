import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  assert.match(page, /<iframe sandbox title="/);
  assert.match(page, /srcdoc="&lt;base href=&quot;about:srcdoc&quot;&gt;&lt;p title=&quot;A &amp;amp; B&quot;&gt;C&lt;\/p&gt;"/);
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
    '&lt;head data-label=&quot;a &gt; b&quot;&gt;&lt;base href=&quot;about:srcdoc&quot;&gt;&lt;title&gt;Page',
  ));
});

test('missing and unpublished links return an uncached 404', async () => {
  const response = artifactPage(null);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'This artifact is unavailable.');
});
