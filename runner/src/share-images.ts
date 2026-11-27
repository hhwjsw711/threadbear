// The pictures in a shared thread's events (docs/website.md, "Sharing"),
// which the mirror uploads to file storage so the shared page can show
// them. What Mike pasted and what agents showed him go up for his own website
// and phone too, below; the rest of an unshared thread's stay on the Mac.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PersistedEvent } from './protocol.ts';
import { absolute } from './highlights.ts';
import { sniffAudio, sniffImage, sniffVideo, type ImageInfo } from './media.ts';
import { IS_WINDOWS, isLocalPath, realPath } from './platform.ts';
import { isSpace, seeker } from './linear-text.ts';

// A picture bigger than this stays on the Mac.
export const SHARE_IMAGE_BYTES = 10 * 1024 * 1024;

export type ShareImage = {
  seq: number;
  path: string; // the file on this Mac
  src?: string; // as the agent wrote it in Markdown, for the page to swap
  mediaType: string;
  width?: number;
  height?: number;
};

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// The media type a browser can show for a file name, or undefined.
export function imageType(file: string): string | undefined {
  const ext = file.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext ? TYPES[ext] : undefined;
}

// What the phone can play as well as show (reply pictures only: a shared
// page draws its pictures with <img>).
function replyMediaType(file: string): string | undefined {
  return imageType(file) ?? (/\.(mp4|m4v|mov)$/i.test(file) ? 'video/mp4' : undefined);
}

// A live page (the livePages experiment, docs/live-pages-design): one
// self-contained HTML file an agent shows in its reply, which the phone runs
// sealed. Recorded as this type, uploaded as plain bytes (sync.ts), so its
// storage URL opened in a browser never runs it on the backend's origin.
export const PAGE_TYPE = 'text/html';
const isPageName = (file: string) => /\.html?$/i.test(file);
function replyOrPageType(file: string): string | undefined {
  return replyMediaType(file) ?? (isPageName(file) ? PAGE_TYPE : undefined);
}

// A Markdown image's address as a file on this Mac: an absolute path, a
// file:// URL or a ~ path. Undefined for a web address or anything else.
export function localImagePath(src: string, home = os.homedir(), typeOf = imageType): string | undefined {
  let p = src.trim();
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      return undefined;
    }
  } else if (p.startsWith('~/')) p = home + p.slice(1);
  // Not, on Windows, a //host/share one (platform.ts's isLocalPath): it
  // would have the runner open a network connection to a host the text picked.
  if (!path.isAbsolute(p) || p.includes('\0') || !isLocalPath(p)) return undefined;
  return typeOf(p) ? p : undefined;
}

// ![alt](src) and ![alt](<src> "title"), as CommonMark writes them.
export function markdownImages(text: string, home = os.homedir(), typeOf = imageType): { src: string; path: string }[] {
  const out: { src: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const src of markdownImageSources(text)) {
    // Each src looked up once: a reply can name the same one thousands of times.
    if (seen.has(src)) continue;
    seen.add(src);
    const p = localImagePath(src, home, typeOf);
    if (p) out.push({ src, path: p });
  }
  return out;
}

// The src of each image, as
// `/!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g` finds
// them, in time linear in the text. That regex started again at every "!["
// and scanned ahead from it, so a model's reply of "![" over and over took
// the square of its length; here every scan ahead is remembered (seeker)
// and every "]" tried once, as all that follows an image's "]" depends on
// where that "]" is.
export function markdownImageSources(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  const skipSpace = (i: number) => {
    while (i < n && isSpace(text[i])) i++;
    return i;
  };
  const closeBracket = seeker(text, (c) => c === ']');
  const angleEnd = seeker(text, (c) => c === '>' || c === '\n');
  const bareEnd = seeker(text, (c) => c === ')' || isSpace(c));
  // What may follow a src, which ends just before `at`: a "title" after
  // some whitespace, then ")". Where the image ends, or -1. One per kind of
  // src, so each one's scans only ever move forward, and several "!["
  // whose src ends at the same place ask once.
  const after = () => {
    const quoteEnd = seeker(text, (c) => c === '"');
    let lastAt = -1;
    let lastEnd = -1;
    return (at: number): number => {
      if (at === lastAt) return lastEnd;
      lastAt = at;
      return (lastEnd = imageEnd(at));
    };
    function imageEnd(at: number): number {
      const w = skipSpace(at);
      if (w > at && text[w] === '"') {
        const q = quoteEnd(w + 1);
        const c = q < 0 ? -1 : skipSpace(q + 1);
        if (c >= 0 && text[c] === ')') return c + 1;
      }
      return text[w] === ')' ? w + 1 : -1;
    }
  };
  const afterAngle = after();
  const afterBare = after();
  let failedAt = -1;
  for (let p = text.indexOf('!['); p >= 0; ) {
    const q = closeBracket(p + 2);
    if (q < 0) break; // no "]" after this "![", nor after any later one
    let end = -1;
    let src = '';
    if (q !== failedAt && text[q + 1] === '(') {
      const j = skipSpace(q + 2);
      if (text[j] === '<') {
        const g = angleEnd(j + 1);
        if (g > j + 1 && text[g] === '>') {
          end = afterAngle(g + 1);
          src = text.slice(j + 1, g);
        }
      }
      if (end < 0) {
        const e = bareEnd(j);
        const stop = e < 0 ? n : e;
        if (stop > j) {
          end = afterBare(stop);
          src = text.slice(j, stop);
        }
      }
    }
    if (end < 0) {
      failedAt = q;
      p = text.indexOf('![', p + 1);
    } else {
      out.push(src);
      p = text.indexOf('![', end);
    }
  }
  return out;
}

// What one event shows: a message's attachments, what a tool handed back
// (a screenshot, an image it read or made), and pictures the agent put in
// its text by path.
export function imagesInEvent(e: PersistedEvent, home = os.homedir()): ShareImage[] {
  if (e.type === 'user.message' || e.type === 'tool.result') {
    return (e.images ?? []).map((i) => ({
      seq: e.seq,
      path: i.path,
      mediaType: i.mediaType,
      ...(i.width ? { width: i.width } : {}),
      ...(i.height ? { height: i.height } : {}),
    }));
  }
  if (e.type === 'assistant.text') {
    return markdownImages(e.text, home).map(({ src, path }) => ({ seq: e.seq, path, src, mediaType: imageType(path)! }));
  }
  return [];
}

// A file's bytes, at most SHARE_IMAGE_BYTES, or why not. Opened without
// waiting (a FIFO named .png or .html would hold the runner up for good),
// checked to be a regular file on the open descriptor (a link to /dev/zero
// would read forever), and read no further than the cap whatever its size
// said a moment before.
function readCapped(file: string): { bytes: Uint8Array } | { skip: string } {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch {
    return { skip: 'the file is gone' };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { skip: "it can't be read" };
    if (st.size > SHARE_IMAGE_BYTES) return { skip: `it's ${Math.round(st.size / 1024 / 1024)} MB` };
    const bytes = Buffer.alloc(Math.min(st.size, SHARE_IMAGE_BYTES) + 1);
    let got = 0;
    while (got < bytes.length) {
      const n = fs.readSync(fd, bytes, got, bytes.length - got, got);
      if (n === 0) break;
      got += n;
    }
    if (got > SHARE_IMAGE_BYTES) return { skip: 'it grew past 10 MB' };
    return { bytes: new Uint8Array(bytes.subarray(0, got)) };
  } finally {
    fs.closeSync(fd);
  }
}

// A shared thread's pictures come only from its media folder in the data
// dir (`threads/<id>/media`): its attachments and the pictures tools handed
// back are copied there, and an agent that wants a picture on the page
// copies it there on purpose (THREADBEAR_MEDIA_DIR). A path in assistant
// Markdown is only text the agent wrote, maybe at a repo's or a web page's
// say, so it gives no authority to publish a file from anywhere else: not
// the thread's folder, however new the file (pictures made there since the
// thread started went, and that was still Markdown publishing a local
// file: Daybreak verify-fix, 5 Nov), and not the temp folders, which hold
// every app's screenshots. Anything else shows its caption.
function under(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// The real form of a path (platform.ts: on Windows the long names, so the
// media folder and a file in it agree however either was spelt).
function realOr(p: string): string {
  return realPath(p);
}

const OUTSIDE = "it isn't in the thread's media folder";
const NOT_A_PICTURE = "it isn't a picture";

// Whether a readShareImage skip is only about the file's size or format, so a
// shrunk JPEG of it could go instead (a design review's stills on the phone,
// phone-reviews.ts). Not one outside the folder, a link or gone.
export function shrinkWouldDo(skip: string): boolean {
  return skip === NOT_A_PICTURE || / MB$/.test(skip);
}

// The bytes of a shared thread's picture and what they really are, or why
// not. It goes to a public page, so: a file in `mediaDir` (by its real path
// too, so a folder link can't lead out), not itself a link, and really a
// picture whatever its name says. The type comes from the bytes. Read
// through one descriptor opened without following a link, and checked to
// be the file at the real path, so nothing can be swapped in between.
export function readShareImage(file: string, mediaDir: string | undefined): { bytes: Uint8Array; mediaType: string; width?: number; height?: number } | { skip: string } {
  return readShareFile(file, mediaDir, sniffImage, NOT_A_PICTURE);
}

// A design review's video, sound or single HTML file for the phone, read
// as readShareImage reads a picture, from the same folder and up to the same
// 10 MB. A sound is sniffed first, as an M4A is an MPEG-4 file too.
export function readShareMedia(file: string, mediaDir: string | undefined): { bytes: Uint8Array; mediaType: string; width?: number; height?: number } | { skip: string } {
  return readShareFile(file, mediaDir, (buf) => sniffAudio(buf, file) ?? sniffVideo(buf) ?? (isPageName(file) && sniffPage(buf) ? { mediaType: PAGE_TYPE } : null), "it isn't a video, sound or page");
}

function readShareFile(file: string, mediaDir: string | undefined, sniff: (buf: Buffer) => ImageInfo | null, notIt: string): { bytes: Uint8Array; mediaType: string; width?: number; height?: number } | { skip: string } {
  if (!mediaDir) return { skip: OUTSIDE };
  const abs = path.resolve(file);
  // (On Windows also by the file's real name: it may be given by its 8.3 short
  // one, which is the same file the media folder's long name holds.)
  if (!under(abs, mediaDir) && !under(abs, realOr(mediaDir)) && !(IS_WINDOWS && under(realOr(abs), realOr(mediaDir)))) return { skip: OUTSIDE };
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return { skip: 'the file is gone' };
  }
  if (st.isSymbolicLink()) return { skip: "it's a link" };
  if (!st.isFile()) return { skip: "it can't be read" };
  const real = realOr(abs);
  if (!under(real, realOr(mediaDir))) return { skip: OUTSIDE };
  let fd: number;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    return { skip: (e as NodeJS.ErrnoException).code === 'ELOOP' ? "it's a link" : "it can't be read" };
  }
  try {
    const open = fs.fstatSync(fd);
    let atReal: fs.Stats;
    try {
      atReal = fs.statSync(real);
    } catch {
      return { skip: 'the file is gone' };
    }
    // Against what was looked at first too: a folder on the way swapped for a link
    // after that would otherwise agree with itself.
    if (!open.isFile() || open.ino !== atReal.ino || open.dev !== atReal.dev || open.ino !== st.ino || open.dev !== st.dev) return { skip: "it can't be read" };
    if (open.size > SHARE_IMAGE_BYTES) return { skip: `it's ${Math.round(open.size / 1024 / 1024)} MB` };
    const bytes = Buffer.alloc(open.size);
    let got = 0;
    while (got < bytes.length) {
      const n = fs.readSync(fd, bytes, got, bytes.length - got, got);
      if (n === 0) break;
      got += n;
    }
    // Pictures only for a shared page: it draws them with <img>.
    const info = sniff(bytes.subarray(0, got));
    if (!info) return { skip: notIt };
    return { bytes: new Uint8Array(bytes.subarray(0, got)), mediaType: info.mediaType, ...(info.width ? { width: info.width } : {}), ...(info.height ? { height: info.height } : {}) };
  } catch {
    return { skip: "it can't be read" };
  } finally {
    fs.closeSync(fd);
  }
}

// What the phone shows of any thread, shared or not (backend API 24,
// docs/convex-backend.md): what the agent put in front of Mike on purpose,
// a picture or video in its reply, or one it pinned. Attachments and what
// tools hand back stay on the Mac, as they're many and big. The file goes as
// it is, so a GIF keeps its frames; the phone shrinks only what it draws.
export type ReplyImage = {
  seq: number;
  path: string; // the file on this Mac
  src?: string; // as the agent wrote it in Markdown, for the phone to swap
  pinned?: true; // the `pin` tool's, which goes under the turn's reply
};

export const PIN_TOOL = 'mcp__threadbear__pin';

// `pages`: live pages too, from a reply only. A pinned page (a mockup, a
// report) stays on the Mac: agents pin many, and none asked to go anywhere.
export function replyImagesInEvent(e: PersistedEvent, cwd: string | undefined, home = os.homedir(), pages = false): ReplyImage[] {
  if (e.type === 'assistant.text') return markdownImages(e.text, home, pages ? replyOrPageType : replyMediaType).map(({ src, path }) => ({ seq: e.seq, path, src }));
  if (e.type !== 'tool.call' || e.name !== PIN_TOOL || typeof e.input.path !== 'string') return [];
  // The pin tool takes a path relative to the thread's folder.
  const raw = e.input.path.trim();
  if (!raw || (!path.isAbsolute(raw) && !raw.startsWith('~') && !cwd)) return [];
  // A network path the agent names isn't opened; a relative one is in the thread's folder.
  if (path.isAbsolute(raw) && !isLocalPath(raw)) return [];
  const file = absolute(raw, cwd ?? '/', home);
  return replyMediaType(file) ? [{ seq: e.seq, path: file, pinned: true }] : [];
}

// The pictures Mike pasted into a message, for his own website (`sync.pastedPictures`
// in runner.json, on by default; docs/on-your-mac.md). `src` is picture:N, for
// the [Picture N] that stands for it (docs/protocol/threads.md, "Pictures in a message"):
// the phone draws them over Mike's bubble and keeps the chips in his words. Only as they're sent, never by looking back through the logs: nobody
// asked for what they'd already pasted to go up, and backfills are what cost.
export function pastedImagesInEvent(e: PersistedEvent): ReplyImage[] {
  if (e.type !== 'user.message') return [];
  return (e.images ?? []).map((image, i) => ({ seq: e.seq, path: image.path, src: `picture:${i + 1}` }));
}

// Whether bytes are an HTML page: UTF-8 with no NULs, starting (past a BOM
// and spaces) with markup, and a tag a page has near the top. An agent can
// name any file .html, so this keeps a key or a binary from going up as one.
const PAGE_TAGS = /<(!doctype\s+html|html|head|body|meta|title|style|script|canvas|svg|div|main|link)[\s>/]/i;
export function sniffPage(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const start = text.replace(/^\uFEFF/, '').trimStart();
  return start.startsWith('<') && PAGE_TAGS.test(start.slice(0, 4096));
}

// The bytes to upload and what they really are, or why not. An agent can
// write any path with a .png on the end, so the file has to be a picture or
// a video, or, named .html, a page.
export function readReplyImage(file: string): { bytes: Uint8Array; mediaType: string; width?: number; height?: number } | { skip: string } {
  if (!isLocalPath(file)) return { skip: "it's a network or device path" };
  let read: ReturnType<typeof readCapped>;
  try {
    read = readCapped(file);
  } catch {
    return { skip: "it can't be read" };
  }
  if ('skip' in read) return read;
  const buf = Buffer.from(read.bytes);
  if (isPageName(file)) {
    // By its real name too: x.html linked to a .xml or .plist isn't a page
    // (Gemini's second review), as the Mac's open gate has it.
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      return { skip: 'the file is gone' };
    }
    return isPageName(real) && sniffPage(read.bytes) ? { bytes: read.bytes, mediaType: PAGE_TYPE } : { skip: "it isn't a page" };
  }
  const info = sniffImage(buf) ?? sniffVideo(buf);
  if (!info) return { skip: "it isn't a picture" };
  return { bytes: read.bytes, mediaType: info.mediaType, ...(info.width ? { width: info.width } : {}), ...(info.height ? { height: info.height } : {}) };
}
