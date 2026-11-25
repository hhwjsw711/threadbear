import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { convertImageSync } from '../../src/images.ts';
import { makePng } from '../helpers/png.ts';
import { tmpDir } from '../helpers/fakes.ts';

function wideTiff(): Buffer {
  const fields: [number, number, number][] = [[256, 4, 9000], [257, 4, 1], [258, 3, 8], [259, 3, 1], [262, 3, 1], [273, 4, 134], [277, 3, 1], [278, 4, 1], [279, 4, 9000], [284, 3, 1]];
  const b = Buffer.alloc(134 + 9000);
  b.write('II'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4); b.writeUInt16LE(fields.length, 8);
  fields.forEach(([tag, type, value], i) => { const at = 10 + i * 12; b.writeUInt16LE(tag, at); b.writeUInt16LE(type, at + 2); b.writeUInt32LE(1, at + 4); b.writeUInt32LE(value, at + 8); });
  return b;
}

test('Windows checks source dimensions before decoding/resizing the actual image', { skip: process.platform !== 'win32' }, () => {
  const dir = tmpDir();
  const tiny = path.join(dir, 'tiny.png');
  const wide = path.join(dir, 'wide.tiff');
  fs.writeFileSync(tiny, makePng(2, 2));
  fs.writeFileSync(wide, wideTiff());
  for (const [file, decodeLimit] of [[tiny, { side: 1, pixels: 64 }], [tiny, { side: 8192, pixels: 3 }], [wide, { side: 8192, pixels: 64 * 1024 * 1024 }]] as const) {
    const out = path.join(dir, 'refused.png');
    assert.throws(() => convertImageSync(file, out, { format: 'png', maxPx: 4096, decodeLimit: { ...decodeLimit } }));
    assert.equal(fs.existsSync(out), false);
  }
  const accepted = path.join(dir, 'accepted.png');
  convertImageSync(tiny, accepted, { format: 'png', maxPx: 4096, decodeLimit: { side: 8192, pixels: 64 * 1024 * 1024 } });
  const bytes = fs.readFileSync(accepted);
  assert.equal(bytes.readUInt32BE(16), 2);
  assert.equal(bytes.readUInt32BE(20), 2);
});
