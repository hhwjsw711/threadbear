import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { saveBase64Image, saveDataUrl } from '../../src/media.ts';
import { fileContext } from '../../src/adapters/context.ts';
import { makePng } from '../helpers/png.ts';
import { tmpDir } from '../helpers/fakes.ts';

test('oversized or malformed image MIME metadata is refused before any file is created', () => {
  const dir = path.join(tmpDir(), 'media');
  for (const type of [`image/${'x'.repeat(128 * 1024)}`, 'image/png;malformed', 'not-a-type']) {
    assert.throws(() => saveBase64Image(dir, 'AA==', type, 'metadata'), /Invalid image media type/);
    assert.equal(fs.existsSync(dir), false);
  }
});

test('single-line and wrapped base64 refuse before decoding over the cap and leave no file', () => {
  const data = makePng(1, 1);
  for (const wrapped of [false, true]) {
    const dir = path.join(tmpDir(), 'media');
    const encode = (b: Buffer) => wrapped ? b.toString('base64').replace(/.{4}/g, '$&\n') : b.toString('base64');
    const maxBytes = data.length;
    assert.throws(() => saveBase64Image(dir, encode(Buffer.concat([data, Buffer.from('x')])), 'image/png', 'bad', { maxBytes }), /too big/);
    assert.ok(!fs.existsSync(dir));
    const ref = saveBase64Image(dir, encode(data), 'image/png', 'ok', { maxBytes });
    assert.deepEqual(fs.readFileSync(ref.path), data);
    assert.deepEqual(fs.readdirSync(dir), [path.basename(ref.path)]);
    if (process.platform !== 'win32') assert.equal(fs.statSync(ref.path).mode & 0o777, 0o600);
  }
});

test('streamed decode bounds each allocation and rejects malformed padding', (t) => {
  const dir = tmpDir();
  const data = Buffer.concat([makePng(1, 1), Buffer.alloc(200_000)]);
  const original = Buffer.from;
  let largest = 0;
  t.mock.method(Buffer, 'from', (...args: unknown[]) => {
    if (args[1] === 'base64' && typeof args[0] === 'string') largest = Math.max(largest, args[0].length);
    return Reflect.apply(original, Buffer, args);
  });
  const ref = saveBase64Image(dir, data.toString('base64'), 'image/png', 'chunked');
  assert.deepEqual(fs.readFileSync(ref.path), data);
  assert.ok(largest <= 64 * 1024, `largest base64 slice: ${largest}`);
  assert.throws(() => saveBase64Image(dir, 'AAAA=AAAA', 'image/png', 'bad'), /base64/);
});

test('turn totals count repeated results and thread totals survive a new context', () => {
  const dir = tmpDir();
  const media = path.join(dir, 'media');
  const png = makePng(1, 1).toString('base64');
  const size = Buffer.from(png, 'base64').length;
  const limits = { imageBytes: size, turnBytes: size * 2, turnFiles: 2, threadBytes: size * 3, threadFiles: 3 };
  const ctx = fileContext(dir, media, path.join(dir, 'blobs'), limits);
  ctx.saveImage(png, 'image/png', 'a');
  ctx.saveImage(png, 'image/png', 'b');
  assert.throws(() => ctx.saveImage(png, 'image/png', 'c'), /turn/);
  ctx.beginTurn!();
  assert.ok(ctx.saveImage(png, 'image/png', 'c'));
  const resumed = fileContext(dir, media, path.join(dir, 'blobs'), limits);
  assert.throws(() => resumed.saveImage(png, 'image/png', 'd'), /thread/);
  assert.equal(resumed.saveDataUrl!(`data:image/png;base64,${png}`, 'e'), null);
  assert.equal(fs.readdirSync(media).length, 3);
});

test('data URL uses the same decoded-size cap as direct images', () => {
  const dir = path.join(tmpDir(), 'media');
  const data = makePng(1, 1).toString('base64');
  assert.equal(saveDataUrl(dir, `data:image/png;base64,${data}`, 'bad', { maxBytes: 1 }), null);
  assert.ok(!fs.existsSync(dir));
});

test('an interrupted write removes its private temporary file', (t) => {
  const dir = tmpDir();
  t.mock.method(fs, 'writeSync', () => { throw new Error('disk full'); });
  assert.throws(() => saveBase64Image(dir, makePng(1, 1).toString('base64'), 'image/png', 'failed'), /disk full/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('aggregate byte limits apply even below the file-count limits', () => {
  const dir = tmpDir();
  const media = path.join(dir, 'media');
  const png = makePng(1, 1).toString('base64');
  const size = Buffer.from(png, 'base64').length;
  const limits = { imageBytes: size + 1, turnBytes: size, turnFiles: 20, threadBytes: size * 2, threadFiles: 20 };
  const ctx = fileContext(dir, media, path.join(dir, 'blobs'), limits);
  ctx.saveImage(png, 'image/png', 'a');
  assert.throws(() => ctx.saveImage(png, 'image/png', 'b'), /turn/);
  ctx.beginTurn!();
  ctx.saveImage(png, 'image/png', 'b');
  ctx.beginTurn!();
  assert.throws(() => ctx.saveImage(png, 'image/png', 'c'), /thread/);
  assert.equal(fs.readdirSync(media).length, 2);
});
