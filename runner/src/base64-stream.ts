import fs from 'node:fs';
import crypto from 'node:crypto';

const CHARS = 64 * 1024;
const WHITE = /[\t\n\r ]/g;

// Count before allocating decoded bytes. MIME wrapping and URL-safe base64
// are accepted; arbitrary ignored characters and misplaced padding are not.
export function base64Bytes(data: string, maxBytes: number): number {
  if (data.length > Math.ceil(maxBytes / 3) * 4 * 1.1 + CHARS) throw new Error('Tool image is too big');
  let chars = 0;
  let padding = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || c === 32) continue;
    chars++;
    if (c === 61) padding++;
    else if (padding || !((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 45 || c === 95)) throw new Error('Invalid image base64');
  }
  if (padding > 2 || chars % 4 === 1 || (padding && chars % 4 !== 0)) throw new Error('Invalid image base64');
  const bytes = Math.floor(chars * 3 / 4) - padding;
  if (bytes > maxBytes) throw new Error('Tool image is too big');
  return bytes;
}

// At most 48 KiB decoded at once. The caller owns an exclusive private file
// and removes it on any error. No complete decoded image is kept in memory.
export function writeBase64(fd: number, data: string, expected: number): { sha: string; head: Buffer } {
  const hash = crypto.createHash('sha1');
  let carry = '';
  let bytes = 0;
  let head = Buffer.alloc(0);
  for (let i = 0; i < data.length; i += CHARS - 4) {
    const chunk = carry + data.slice(i, i + CHARS - 4).replace(WHITE, '');
    // Advance by the actual source slice, leaving room for three carried chars.
    const end = i + CHARS - 4 >= data.length ? chunk.length : chunk.length - chunk.length % 4;
    carry = chunk.slice(end);
    const buf = Buffer.from(chunk.slice(0, end), 'base64');
    bytes += buf.length;
    if (bytes > expected) throw new Error('Tool image is too big');
    if (head.length < CHARS) head = Buffer.concat([head, buf.subarray(0, CHARS - head.length)]);
    hash.update(buf);
    let wrote = 0;
    while (wrote < buf.length) wrote += fs.writeSync(fd, buf, wrote, buf.length - wrote);
  }
  if (carry || bytes !== expected) throw new Error('Invalid image base64 size');
  return { sha: hash.digest('hex').slice(0, 10), head };
}
