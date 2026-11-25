import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ImageRef } from './protocol.ts';
import { conversionSide, convertImage, convertImageSync } from './images.ts';
import { base64Bytes, writeBase64 } from './base64-stream.ts';

export type ImageInfo = { mediaType: string; width?: number; height?: number };

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function extForMediaType(mediaType: string): string {
  return EXT[mediaType] ?? 'bin';
}

// Reads the image type and pixel size from the file header, so the app can
// lay out thumbnails without decoding anything.
export function sniffImage(buf: Buffer): ImageInfo | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mediaType: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { mediaType: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { mediaType: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { mediaType: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && buf.length >= 30) {
      return {
        mediaType: 'image/webp',
        width: (buf.readUIntLE(24, 3) & 0xffffff) + 1,
        height: (buf.readUIntLE(27, 3) & 0xffffff) + 1,
      };
    }
    return { mediaType: 'image/webp' };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mediaType: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return { mediaType: 'image/jpeg' };
  }
  return null;
}

// An MP4 or QuickTime file's type and picture size, which the phone lays out
// from as it does a picture's. The size is optional: a file can have it
// anywhere, or not in a way this finds, and the phone then gets it on loading.
export function sniffVideo(buf: Buffer): ImageInfo | null {
  if (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') return null;
  const brand = buf.toString('ascii', 8, 12);
  // HEIC and AVIF photos are ISO boxes with a ftyp too.
  if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis)$/.test(brand)) return null;
  return { mediaType: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4', ...videoSize(buf) };
}

// moov > trak > tkhd, of the first track with a picture (audio's are 0 x 0).
function videoSize(buf: Buffer): { width?: number; height?: number } {
  for (const [start, end] of boxes(buf, 0, buf.length, 'moov')) {
    for (const [trakStart, trakEnd] of boxes(buf, start, end, 'trak')) {
      for (const [at, tkhdEnd] of boxes(buf, trakStart, trakEnd, 'tkhd')) {
        // Version 1 has 8-byte times, which moves the rest along 12.
        const shift = buf[at] === 1 ? 12 : 0;
        if (at + 84 + shift > tkhdEnd) continue;
        const width = buf.readUInt32BE(at + 76 + shift) >>> 16;
        const height = buf.readUInt32BE(at + 80 + shift) >>> 16;
        if (!width || !height) continue;
        // A phone's upright clip is stored sideways, with a rotation here.
        return buf.readInt32BE(at + 40 + shift) === 0 ? { width: height, height: width } : { width, height };
      }
    }
  }
  return {};
}

// [start, end] of the contents of each box of a type between two offsets.
function* boxes(buf: Buffer, from: number, to: number, type: string): Generator<[number, number]> {
  let i = from;
  while (i + 8 <= to) {
    let size = buf.readUInt32BE(i);
    let header = 8;
    if (size === 1 && i + 16 <= to) {
      size = Number(buf.readBigUInt64BE(i + 8));
      header = 16;
    } else if (size === 0) size = to - i;
    if (size < header || i + size > to) return;
    if (buf.toString('ascii', i + 4, i + 8) === type) yield [i + header, i + size];
    i += size;
  }
}

// Biggest image file accepted from the app.
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

export function readImageInfo(file: string): ImageInfo | null {
  let fd: number | null = null;
  try {
    // Only regular files: opening a named pipe (or a device) would block
    // the runner until something writes to it.
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
    fd = fs.openSync(file, 'r');
    // JPEG size markers can sit after big EXIF blocks, so read generously.
    const size = Math.min(fs.fstatSync(fd).size, 512 * 1024);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return sniffImage(buf);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// A video file's type and, when its header has it near the start, its
// picture size (sniffVideo). For design reviews' clips (reviews.ts).
export function readVideoInfo(file: string): ImageInfo | null {
  let fd: number | null = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(st.size, 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return sniffVideo(buf);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// A sound file's type, from its first bytes, or an MPEG-4 one's: an M4A
// brand, or any MP4 named .m4a, as some makers use isom. WAV is RIFF....WAVE.
// MP3 and AAC (ADTS) have no magic number, only frame headers, which random
// bytes can look like, so it takes two whole frames back to back, each with
// a valid header, the second where the first's length says; after an ID3v2
// tag (a real one: version 2 to 4, a synchsafe size) for an MP3 or AAC file
// that has one. Gemini's review, 27 Nov: any file starting "ID3", or two
// bytes of 0xFF sync, passed as a sound.
export function sniffAudio(buf: Buffer, name = ''): ImageInfo | null {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return { mediaType: 'audio/wav' };
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    if (/^(M4A |M4B |M4P |F4A |F4B )$/.test(buf.toString('ascii', 8, 12))) return { mediaType: 'audio/mp4' };
    return /\.m4[ab]$/i.test(name) && sniffVideo(buf) ? { mediaType: 'audio/mp4' } : null;
  }
  const tag = id3End(buf);
  if (tag === null) return null;
  return audioFramesAt(buf, tag ?? 0);
}

// Where an ID3v2 tag ends: undefined with no tag, null for one that's
// malformed (or claims "ID3" and isn't one).
export function id3End(buf: Buffer): number | undefined | null {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return undefined;
  const version = buf[3]!;
  if (version < 2 || version > 4 || buf[4] === 0xff) return null;
  // The flags' unused low bits are zero: 6 of them in v2.2, 5 in v2.3, 4 in v2.4.
  if (buf[5]! & (0xff >> (version === 2 ? 2 : version === 3 ? 3 : 4))) return null;
  for (let i = 6; i < 10; i++) if (buf[i]! >= 0x80) return null;
  const size = (buf[6]! << 21) | (buf[7]! << 14) | (buf[8]! << 7) | buf[9]!;
  // A v2.4 footer adds ten more.
  return 10 + size + (version === 4 && buf[5]! & 0x10 ? 10 : 0);
}

const MP3_KBPS: Record<string, number[]> = {
  '1-1': [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = [44100, 48000, 32000];

// An MPEG audio frame header's kind and length in bytes, or null.
function frameAt(buf: Buffer, at: number): { mediaType: string; length: number } | null {
  if (at + 7 > buf.length || buf[at] !== 0xff || (buf[at + 1]! & 0xe0) !== 0xe0) return null;
  const b1 = buf[at + 1]!, b2 = buf[at + 2]!;
  const layerBits = (b1 >> 1) & 3;
  if (layerBits === 0) {
    // ADTS: 12 sync bits, layer 0, a sampling index below 13, a length past its header.
    if ((b1 & 0xf0) !== 0xf0 || ((b2 >> 2) & 0xf) >= 13) return null;
    const length = ((buf[at + 3]! & 3) << 11) | (buf[at + 4]! << 3) | (buf[at + 5]! >> 5);
    const header = b1 & 1 ? 7 : 9;
    return length > header ? { mediaType: 'audio/aac', length } : null;
  }
  const versionBits = (b1 >> 3) & 3; // 0: 2.5, 1: reserved, 2: 2, 3: 1
  const rateIndex = (b2 >> 2) & 3;
  const kbpsIndex = b2 >> 4;
  // Free bitrate (0) has no length to check against.
  if (versionBits === 1 || rateIndex === 3 || kbpsIndex === 0 || kbpsIndex === 15) return null;
  const layer = 4 - layerBits; // 1, 2 or 3
  const mpeg1 = versionBits === 3;
  const kbps = MP3_KBPS[mpeg1 ? `1-${layer}` : layer === 1 ? '2-1' : '2-2']![kbpsIndex - 1]!;
  const rate = MP3_RATES[rateIndex]! / (mpeg1 ? 1 : versionBits === 2 ? 2 : 4);
  const pad = (b2 >> 1) & 1;
  const length = layer === 1
    ? (Math.floor((12 * kbps * 1000) / rate) + pad) * 4
    : Math.floor(((layer === 3 && !mpeg1 ? 72 : 144) * kbps * 1000) / rate) + pad;
  return { mediaType: 'audio/mpeg', length };
}

function audioFramesAt(buf: Buffer, at: number): ImageInfo | null {
  const first = frameAt(buf, at);
  if (!first) return null;
  const second = frameAt(buf, at + first.length);
  // The whole of both, not just the second's header (Codex's review).
  if (!second || second.mediaType !== first.mediaType || at + first.length + second.length > buf.length) return null;
  return { mediaType: first.mediaType };
}

// Reads the start of a file and, past an ID3 tag too big for it (cover art),
// the frames after the tag.
export function readAudioInfo(file: string): ImageInfo | null {
  let fd: number | null = null;
  try {
    if (!fs.statSync(file).isFile()) return null;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n);
    const tag = id3End(head);
    if (typeof tag === 'number' && tag + 16 * 1024 > n) {
      const after = Buffer.alloc(16 * 1024);
      const m = fs.readSync(fd, after, 0, after.length, tag);
      return audioFramesAt(after.subarray(0, m), 0);
    }
    return sniffAudio(head, file);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function imageRefFor(file: string, fallbackType?: string): ImageRef {
  const info = readImageInfo(file);
  const ref: ImageRef = { path: file, mediaType: info?.mediaType ?? fallbackType ?? 'application/octet-stream' };
  if (info?.width) ref.width = info.width;
  if (info?.height) ref.height = info.height;
  return ref;
}

// Saves base64 image data (from a tool result) into a media folder.
export type ToolImageOptions = { maxBytes?: number; reserve?: (bytes: number) => ((actualBytes: number) => void) | void };
export function saveBase64Image(dir: string, data: string, mediaType: string, hint: string, opts: ToolImageOptions = {}): ImageRef {
  if (typeof mediaType !== 'string' || mediaType.length > 128 || !/^[a-z0-9.+_-]+\/[a-z0-9.+_-]+$/i.test(mediaType)) throw new Error('Invalid image media type');
  const bytes = base64Bytes(data, Math.min(opts.maxBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES));
  opts.reserve?.(bytes);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    const { sha, head } = writeBase64(fd, data, bytes);
    const info = sniffImage(head);
    const type = info?.mediaType ?? mediaType;
    const file = path.join(dir, `${safeName(hint)}-${sha}.${extForMediaType(type)}`);
    fs.closeSync(fd);
    // A replay must not write the same content-addressed image again.
    // A link or a different-sized file is replaced rather than followed.
    const old = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!old?.isFile() || old.size !== bytes) fs.renameSync(tmp, file);
    return { path: file, mediaType: type, ...(info?.width ? { width: info.width } : {}), ...(info?.height ? { height: info.height } : {}) };
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* already closed for rename */ }
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Copies an image into a folder under a fresh name and returns its ref.
// Used by media.import (into inbox/) and when a message is sent (into the
// thread's media/ so the transcript keeps working if inbox/ is cleaned).
// HEIC (iPhone photos), TIFF and BMP are converted (images.ts) on the way in,
// since the app and the models only take the common web formats.
export function copyImageInto(dir: string, src: string): ImageRef {
  const info = readImageInfo(src);
  if (!info) {
    const why = unreadable(src);
    if (why) throw new Error(why);
    return convertImageInto(dir, src);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.${extForMediaType(info.mediaType)}`);
  fs.copyFileSync(src, file);
  const ref: ImageRef = { path: file, mediaType: info.mediaType };
  if (info.width) ref.width = info.width;
  if (info.height) ref.height = info.height;
  return ref;
}

// copyImageInto for a thread's media.import (Daybreak finding 157), in two
// steps so the quota (media-quota.ts) sizes, keys and copies the same open
// file: it can't be swapped or grown between the check and the copy, and
// nothing here holds the runner's event loop.
export type OpenedImport = { fh: fs.promises.FileHandle; st: fs.Stats; name: string };

export async function openForImport(src: string): Promise<OpenedImport> {
  const name = path.basename(src);
  let fh: fs.promises.FileHandle;
  try {
    // Non-blocking, so a named pipe can't hold the open; it's refused below.
    fh = await fs.promises.open(src, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT' ? `File not found: ${name}` : code === 'EACCES' || code === 'EPERM' ? `Threadbear isn't allowed to read ${name}` : `Couldn't read ${name}${code ? ` (${code})` : ''}`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`Not a file: ${name}`);
    if (st.size === 0) throw new Error(`${name} is empty`);
    if (st.size > MAX_IMAGE_BYTES) throw new Error(`${name} is too big to add (over 100 MB)`);
    return { fh, st, name };
  } catch (e) {
    await fh.close();
    throw e;
  }
}

// Copies an opened file into `dir`: only the bytes it had when opened, and
// only once its first bytes say it's a picture. One that needs converting is
// converted from that private copy, in the background, and refused if the
// result is over `maxOut` bytes. Leaves nothing behind when it fails. The
// caller closes the file.
export async function importOpened(dir: string, o: OpenedImport, opts: { maxOut?: number } = {}): Promise<ImageRef> {
  const { fh, st, name } = o;
  const unsupported = () => new Error(`Not a supported image: ${name}`);
  const head = Buffer.alloc(Math.min(st.size, 512 * 1024));
  const { bytesRead } = await fh.read(head, 0, head.length, 0);
  const first = head.subarray(0, bytesRead);
  const direct = sniffImage(first);
  const kind = direct ? null : convertibleKind(first);
  if (!direct && !kind) throw unsupported();
  await fs.promises.mkdir(dir, { recursive: true });
  const id = crypto.randomUUID();
  const raw = path.join(dir, `${id}.import.tmp`);
  try {
    const out = await fs.promises.open(raw, 'wx', 0o600);
    try {
      await out.write(first, 0, first.length);
      const buf = Buffer.alloc(Math.min(st.size, 1024 * 1024));
      let at = first.length;
      while (at < st.size) {
        const r = await fh.read(buf, 0, Math.min(buf.length, st.size - at), at);
        if (r.bytesRead === 0) break;
        await out.write(buf, 0, r.bytesRead);
        at += r.bytesRead;
      }
    } finally {
      await out.close();
    }
    if (direct) {
      const info = readImageInfo(raw);
      if (!info) throw unsupported();
      const file = path.join(dir, `${id}.${extForMediaType(info.mediaType)}`);
      await fs.promises.rename(raw, file);
      return refFrom(file, info);
    }
    const [format, ext] = kind === 'heic' ? (['jpeg', 'jpg'] as const) : (['png', 'png'] as const);
    const file = path.join(dir, `${id}.${ext}`);
    const tmp = `${file}.tmp.${ext}`;
    try {
      const made = await convertImage(raw, tmp, { format, ...(format === 'jpeg' ? { quality: 90 } : {}) });
      const converted = made ? readImageInfo(tmp) : null;
      if (!converted) throw unsupported();
      if ((await fs.promises.stat(tmp)).size > Math.min(opts.maxOut ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES)) throw new Error(`${name} is too big once converted`);
      await fs.promises.rename(tmp, file);
      return refFrom(file, converted);
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  } finally {
    await fs.promises.rm(raw, { force: true });
  }
}

export async function importImageInto(dir: string, src: string): Promise<ImageRef> {
  const o = await openForImport(src);
  try {
    return await importOpened(dir, o);
  } finally {
    await o.fh.close();
  }
}

// Why a file can't be read at all, or undefined when it can, so a missing or
// locked file isn't reported as "Not a supported image". A screenshot's
// floating thumbnail hands over a temp file that macOS deletes as the drop
// ends (issue #2).
function unreadable(src: string): string | undefined {
  const name = path.basename(src);
  let fd: number | null = null;
  try {
    const st = fs.statSync(src);
    if (!st.isFile()) return `Not a file: ${name}`;
    if (st.size === 0) return `${name} is empty`;
    if (st.size > MAX_IMAGE_BYTES) return `${name} is too big to add (over 100 MB)`;
    // Open it rather than ask access(): macOS privacy settings can refuse
    // the open of a file that access() says is readable.
    fd = fs.openSync(src, 'r');
    return undefined;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return `The file went away before it could be added: ${name}`;
    if (code === 'EACCES' || code === 'EPERM') return `Threadbear isn't allowed to read ${name}`;
    return `Couldn't read ${name}${code ? ` (${code})` : ''}`;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function convertImageInto(dir: string, src: string): ImageRef {
  const unsupported = new Error(`Not a supported image: ${path.basename(src)}`);
  const kind = convertibleKind(readHead(src));
  if (!kind) throw unsupported;
  fs.mkdirSync(dir, { recursive: true });
  // Photos go to JPEG: a 12 MP iPhone shot as PNG is tens of MB, and it's
  // stored twice (inbox, then the thread's media). TIFF and BMP are more
  // often screenshots or diagrams, so they stay lossless as PNG.
  const [format, ext] = kind === 'heic' ? (['jpeg', 'jpg'] as const) : (['png', 'png'] as const);
  const file = path.join(dir, `${crypto.randomUUID()}.${ext}`);
  const tmp = `${file}.tmp.${ext}`;
  try {
    convertImageSync(src, tmp, { format, ...(format === 'jpeg' ? { quality: 90 } : {}) });
    fs.renameSync(tmp, file);
  } catch {
    throw unsupported;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const info = readImageInfo(file);
  if (!info) {
    fs.rmSync(file, { force: true });
    throw unsupported;
  }
  return refFrom(file, info);
}

// The first bytes of a regular file under the size cap, or an empty buffer.
function readHead(file: string): Buffer {
  let fd: number | null = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return Buffer.alloc(0);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(st.size, 64));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf;
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// The API rejects images over about 5 MB (base64) or 8000 px. Shrink big
// ones (images.ts: sips on macOS, ImageMagick on Linux) before sending.
// Returns the bytes and media type to send; the original file stays as it was for the transcript.
export function prepareImageForModel(ref: ImageRef, tmpDir: string): { data: Buffer; mediaType: string } {
  const data = fs.readFileSync(ref.path);
  const tooBig = data.length > 3_700_000 || (ref.width ?? 0) > 7900 || (ref.height ?? 0) > 7900;
  if (!tooBig) return { data, mediaType: ref.mediaType };
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const out = path.join(tmpDir, `${crypto.randomUUID()}.jpg`);
    convertImageSync(ref.path, out, { format: 'jpeg', quality: 80, maxPx: 2048 });
    const small = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
    return { data: small, mediaType: 'image/jpeg' };
  } catch {
    return { data, mediaType: ref.mediaType };
  }
}

// Copies an image file a CLI saved or looked at (Codex's generated images,
// a file it viewed) into a media folder, named like saveBase64Image's so the
// same image always lands on the same file: a replay or a reconnect never
// duplicates it. HEIC, TIFF and BMP become PNG (images.ts), since the app
// and the models only take the common web formats. Null when it isn't a
// readable image.
export function copyImageFileInto(dir: string, src: string, hint: string, opts: ToolImageOptions = {}): ImageRef | null {
  let staged: ReturnType<typeof stageToolImage> | undefined;
  try {
    const file = localPath(src);
    if (!file) return null;
    staged = stageToolImage(file, opts);
    const { sha, head, bytes } = staged;
    const info = sniffImage(head);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (info) {
      const out = path.join(dir, `${safeName(hint)}-${sha}.${extForMediaType(info.mediaType)}`);
      const old = fs.lstatSync(out, { throwIfNoEntry: false });
      if (!old?.isFile() || old.size !== bytes) {
        const tmp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
        try { fs.copyFileSync(staged.input, tmp, fs.constants.COPYFILE_EXCL); fs.renameSync(tmp, out); }
        finally { fs.rmSync(tmp, { force: true }); }
      }
      return refFrom(out, info);
    }
    if (!convertibleKind(head)) return null;
    const out = path.join(dir, `${safeName(hint)}-${sha}.png`);
    if (!fs.lstatSync(out, { throwIfNoEntry: false })?.isFile()) {
      const converted = path.join(staged.work, 'converted.png');
      fs.closeSync(fs.openSync(converted, 'wx', 0o600));
      const maxBytes = Math.min(opts.maxBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES);
      // A PNG's pixels are bounded even before its exact output size is
      // known. Conversion runs against the captured input, never a reopened
      // path controlled by the tool, and in an owner-private random folder.
      const maxPx = conversionSide(staged.input, Math.max(1, Math.min(4096, Math.floor(Math.sqrt(maxBytes / 8)))));
      convertImageSync(staged.input, converted, { format: 'png', maxPx, decodeLimit: { side: 8192, pixels: 64 * 1024 * 1024 } });
      const size = fs.statSync(converted).size;
      if (size > maxBytes) throw new Error('Tool image is too big once converted');
      staged.adjust?.(size);
      const tmp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
      try {
        fs.copyFileSync(converted, tmp, fs.constants.COPYFILE_EXCL);
        fs.renameSync(tmp, out);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    const converted = readImageInfo(out);
    return converted ? refFrom(out, converted) : null;
  } catch {
    return null;
  } finally {
    if (staged) fs.rmSync(staged.work, { recursive: true, force: true });
  }
}

function stageToolImage(file: string, opts: ToolImageOptions): { input: string; work: string; bytes: number; sha: string; head: Buffer; adjust?: (actualBytes: number) => void } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  let work: string | undefined;
  let out: number | undefined;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > Math.min(opts.maxBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES)) throw new Error('Tool image is too big');
    const adjust = opts.reserve?.(st.size) || undefined;
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'threadbear-tool-image-'));
    const input = path.join(work, 'input');
    out = fs.openSync(input, 'wx', 0o600);
    const buf = Buffer.alloc(64 * 1024);
    const hash = crypto.createHash('sha1');
    let head = Buffer.alloc(0);
    let at = 0;
    while (at < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(st.size - at, buf.length), at);
      if (!n) throw new Error('Tool image changed while being read');
      if (!head.length) head = Buffer.from(buf.subarray(0, n));
      hash.update(buf.subarray(0, n));
      let wrote = 0;
      while (wrote < n) wrote += fs.writeSync(out, buf, wrote, n - wrote);
      at += n;
    }
    return { input, work, bytes: at, sha: hash.digest('hex').slice(0, 10), head, ...(adjust ? { adjust } : {}) };
  } catch (e) {
    if (out !== undefined) { fs.closeSync(out); out = undefined; }
    if (work) fs.rmSync(work, { recursive: true, force: true });
    throw e;
  } finally { fs.closeSync(fd); if (out !== undefined) fs.closeSync(out); }
}

// Saves a `data:<type>;base64,<data>` image into a media folder. Null when
// it isn't a base64 data URL of an image.
export function saveDataUrl(dir: string, url: string, hint: string, opts: ToolImageOptions = {}): ImageRef | null {
  const m = /^data:([\w.+-]+\/[\w.+-]+)?((?:;[\w-]+=[^;,]*)*);base64,/i.exec(url);
  if (!m) return null;
  const data = url.slice(m[0].length);
  if (!sniffImage(Buffer.from(data.slice(0, 64 * 1024), 'base64'))) return null;
  try {
    return saveBase64Image(dir, data, m[1] ?? 'image/png', hint, opts);
  } catch {
    return null;
  }
}

// A plain path, or a file:// URL as Codex's rollouts write them.
function localPath(src: string): string | null {
  if (src.startsWith('file://')) {
    try {
      return fileURLToPath(src);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(src) ? src : null;
}

// HEIC/HEIF (an ISO box with a heic-family brand), TIFF and BMP.
function convertibleKind(buf: Buffer): 'heic' | 'tiff' | 'bmp' | null {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(buf.toString('ascii', 8, 12))) return 'heic';
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0 && buf[3] === 0x2a)) return 'tiff';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return null;
}

function refFrom(file: string, info: ImageInfo): ImageRef {
  const ref: ImageRef = { path: file, mediaType: info.mediaType };
  if (info.width) ref.width = info.width;
  if (info.height) ref.height = info.height;
  return ref;
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'image';
}
