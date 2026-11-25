import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileContext } from '../../src/adapters/context.ts';
import { SubagentTranscripts } from '../../src/adapters/claude/subagents.ts';
import { ToolImageQuota } from '../../src/tool-image-quota.ts';
import { makePng } from '../helpers/png.ts';
import { tmpDir } from '../helpers/fakes.ts';

test('deep review assets keep their separate allowance without disabling flat tool images', () => {
  const dir = tmpDir();
  const media = path.join(dir, 'media');
  const asset = path.join(media, 'reviews', 'a', ...Array(20).fill('nested'));
  fs.mkdirSync(asset, { recursive: true });
  fs.writeFileSync(path.join(asset, 'option.png'), makePng(1, 1));
  const size = makePng(1, 1).length;
  const ctx = fileContext(dir, media, path.join(dir, 'blobs'), { imageBytes: size, turnBytes: size, turnFiles: 1, threadBytes: size, threadFiles: 1 });
  assert.ok(ctx.saveImage(makePng(1, 1).toString('base64'), 'image/png', 'after-review'));
});

test('file-backed results share turn limits and copy without a whole-image allocation', (t) => {
  const dir = tmpDir();
  const source = path.join(dir, 'source.png');
  fs.writeFileSync(source, Buffer.concat([makePng(1, 1), Buffer.alloc(200_000)]));
  const size = fs.statSync(source).size;
  const limits = { imageBytes: size, turnBytes: size * 10, turnFiles: 1, threadBytes: size * 10, threadFiles: 10 };
  const ctx = fileContext(dir, path.join(dir, 'media'), path.join(dir, 'blobs'), limits);
  const original = Buffer.alloc;
  let largest = 0;
  t.mock.method(Buffer, 'alloc', (n: number) => { largest = Math.max(largest, n); return original(n); });
  assert.ok(ctx.copyImage!(source, 'a'));
  assert.equal(ctx.copyImage!(source, 'b'), null);
  assert.ok(largest <= 64 * 1024);
  ctx.beginTurn!();
  assert.ok(ctx.copyImage!(source, 'b'));
});

test('converted growth adjusts bytes without counting another picture', () => {
  const limits = { imageBytes: 100, turnBytes: 100, turnFiles: 1, threadBytes: 100, threadFiles: 1 };
  const quota = new ToolImageQuota(path.join(tmpDir(), 'media'), limits);
  const adjust = quota.reserve(20);
  assert.doesNotThrow(() => adjust(50));
  assert.throws(() => quota.reserve(1), /turn/);
});

test('subagent polling reuses unchanged transcripts and image refs when new text is appended', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'subagent.jsonl');
  const ctx = fileContext(dir, path.join(dir, 'media'), path.join(dir, 'blobs'));
  const save = ctx.saveImage;
  let saves = 0;
  ctx.saveImage = (...args) => { saves++; return save(...args); };
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'image', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: makePng(1, 1).toString('base64') } }] }] } }) + '\n');
  const reader = new SubagentTranscripts();
  const first = reader.read(file, ctx);
  assert.equal(saves, 1);
  assert.deepEqual(reader.read(file, ctx), first);
  assert.equal(saves, 1);
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'done' }] } }) + '\n');
  assert.ok(reader.read(file, ctx).events.length > first.events.length);
  assert.equal(saves, 1, 'the old image is not decoded or written again');
});

test('repeated rejected subagent reads retain image imports and the refusal', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'too-much.jsonl');
  const image = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'image', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: makePng(1, 1).toString('base64') } }] }] } };
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'a'.repeat(8 * 1024 * 1024) } }) + '\n' + JSON.stringify(image) + '\n');
  const reader = new SubagentTranscripts();
  let saves = 0;
  const context = () => {
    const ctx = fileContext(dir, path.join(dir, 'media'), path.join(dir, 'blobs'));
    const save = ctx.saveImage;
    ctx.saveImage = (...args) => { saves++; return save(...args); };
    return ctx;
  };
  assert.throws(() => reader.read(file, context()), /too much output/);
  assert.equal(saves, 0, 'output is checked before any image side effects');
  assert.throws(() => reader.read(file, context()), /too much output/);
  assert.equal(saves, 0, 'a fresh caller context does not renew rejected image work');
  // Exceed the parsed cache's entry count; imports still never happen.
  for (let i = 0; i < 33; i++) {
    const another = path.join(dir, `rejected-${i}.jsonl`);
    fs.linkSync(file, another);
    assert.throws(() => reader.read(another, context()), /too much output/);
  }
  assert.throws(() => reader.read(file, context()), /too much output/);
  assert.equal(saves, 0);
});

test('accepted transcript rotation never renews image imports when parsed results are evicted', () => {
  const dir = tmpDir();
  const source = path.join(dir, 'accepted.jsonl');
  fs.writeFileSync(source, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'image', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: makePng(1, 1).toString('base64') } }] }] } }) + '\n');
  const files = Array.from({ length: 33 }, (_, i) => path.join(dir, `accepted-${i}.jsonl`));
  for (const file of files) fs.linkSync(source, file);
  const reader = new SubagentTranscripts();
  let saves = 0;
  for (let round = 0; round < 3; round++) for (const file of files) {
    const ctx = fileContext(dir, path.join(dir, 'media'), path.join(dir, 'blobs'));
    const save = ctx.saveImage;
    ctx.saveImage = (...args) => { saves++; return save(...args); };
    assert.ok(reader.read(file, ctx).events.some((e) => e.body.type === 'tool.result'));
  }
  assert.equal(saves, 1, 'import history is shared by the thread independently of the parsed cache');
});

test('subagent import history has a decoded-work budget across fresh contexts and bounded MIME metadata', () => {
  const dir = tmpDir();
  const png = makePng(1, 1);
  const reader = new SubagentTranscripts(png.length);
  const metadataReader = new SubagentTranscripts();
  let saves = 0;
  for (let i = 0; i < 5; i++) {
    const file = path.join(dir, `metadata-${i}.jsonl`);
    const data = i < 2 ? Buffer.concat([png, Buffer.alloc(i)]).toString('base64') : 'AA==';
    const mediaType = i < 2 ? 'image/png' : `image/${'x'.repeat(128 * 1024)}${i}`;
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'image', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data } }] }] } }) + '\n');
    const ctx = fileContext(dir, path.join(dir, 'media'), path.join(dir, 'blobs'));
    const save = ctx.saveImage;
    ctx.saveImage = (...args) => { const image = save(...args); saves++; return image; };
    const result = (i < 2 ? reader : metadataReader).read(file, ctx);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096, 'untrusted MIME metadata is not retained in image refs');
  }
  assert.equal(saves, 1, 'fresh contexts cannot renew decoded import work');
});
