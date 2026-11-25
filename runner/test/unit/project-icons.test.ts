import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { Projects, projectMethods } from '../../src/projects.ts';
import { Librarian, ICON_SOON_MS, ICON_SWEEP_MS } from '../../src/librarian.ts';
import { findIcon, imageSize, phonePicture, storeIcon, SYMBOLS } from '../../src/project-icons.ts';
import { magickCommand, pictureKind, winCommand } from '../../src/images.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import type { GenerateParams, ModelResult } from '../../src/models/index.ts';
import { skipOnWindows } from '../helpers/platform.ts';

const NO_RESIZE = "Pictures are resized with sips or ImageMagick, which the Windows port doesn't use yet";

// A real PNG of one colour, so sips can read it.
function png(w: number, h: number, rgb: [number, number, number] = [200, 80, 40]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function folder(root: string, rel: string, files: Record<string, string | Buffer>): string {
  const dir = path.join(root, rel);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test("finding an icon: the app icon over favicons and logos, never another thing's", async () => {
  const root = tmpDir();
  const app = folder(root, 'pantry', {
    'App/Assets.xcassets/AppIcon.appiconset/icon-1024.png': png(1024, 1024),
    'App/Assets.xcassets/Icons/icon-gear.imageset/icon.png': png(1024, 1024),
    'web/public/favicon-32.png': png(32, 32),
    'web/public/logo.png': png(600, 120),
    'docs/mockups/app-icon.png': png(1024, 1024),
    'node_modules/x/icon.png': png(1024, 1024),
  });
  assert.equal((await findIcon([app]))?.path, path.join(app, 'App/Assets.xcassets/AppIcon.appiconset/icon-1024.png'));

  // A web app: the apple-touch-icon over the favicon and the wide logo.
  const web = folder(root, 'blog', { 'public/favicon.ico': 'x', 'public/apple-touch-icon.png': png(180, 180), 'public/logo.png': png(600, 120) });
  assert.equal((await findIcon([web]))?.path, path.join(web, 'public/apple-touch-icon.png'));

  // A Chrome extension: its manifest's biggest icon.
  const ext = folder(root, 'new-tab', {
    'manifest.json': JSON.stringify({ manifest_version: 3, icons: { '16': 'art/i16.png', '128': 'art/i128.png' } }),
    'art/i16.png': png(16, 16),
    'art/i128.png': png(128, 128),
  });
  assert.equal((await findIcon([ext]))?.path, path.join(ext, 'art/i128.png'));

  // A picture named after the project in an icons folder.
  const named = folder(root, 'threadbear', { 'app/icons/threadbear.png': png(1024, 1024) });
  assert.equal((await findIcon([named]))?.path, path.join(named, 'app/icons/threadbear.png'));

  // Under a folder named for something else, it's that thing's icon.
  const other = folder(root, 'sketchpad', { 'public/inventory/icon.svg': '<svg viewBox="0 0 512 512"></svg>' });
  assert.equal(await findIcon([other]), undefined);
  assert.equal(await findIcon([folder(root, 'nothing', { 'src/a.ts': '' })]), undefined);

  assert.deepEqual(await imageSize(path.join(other, 'public/inventory/icon.svg'), '.svg'), { width: 512, height: 512 });
  assert.ok(SYMBOLS.includes('film') && new Set(SYMBOLS).size === SYMBOLS.length);
});

function setup(models?: (p: GenerateParams) => ModelResult<string>) {
  const root = tmpDir();
  const home = tmpDir();
  const clock = new FakeClock();
  const projects = new Projects({ home, clock, log: nullLogger, userHome: root });
  const asked: GenerateParams[] = [];
  const h = makeHarness(home, {}, { projects, panelsRoot: root });
  projects.start(h.runner);
  const librarian = new Librarian({
    host: h.runner,
    projects,
    models: models && { generate: async (p: GenerateParams) => (asked.push(p), models(p)) },
    clock,
    log: nullLogger,
    home,
    userHome: root,
  });
  librarian.start();
  // Lets the icon timer fire and its run finish.
  const settle = async (ms = ICON_SOON_MS) => {
    clock.advance(ms);
    await librarian.keepIcons();
    await tick(4);
  };
  return { h, root, home, clock, projects, librarian, asked, settle };
}

test('the librarian copies a project icon in, follows the file when it changes, and takes it away with the project', skipOnWindows(NO_RESIZE), async () => {
  const s = setup();
  const app = folder(s.root, 'walkies', { 'Walkies/Assets.xcassets/AppIcon.appiconset/AppIcon.png': png(1024, 1024) });
  const p = s.projects.create({ title: 'Walkies', folders: [app], by: 'mike' });
  await s.settle();
  const icon = s.projects.list()[0].icon!;
  assert.equal(icon.by, 'librarian');
  assert.equal(icon.from, path.join(app, 'Walkies/Assets.xcassets/AppIcon.appiconset/AppIcon.png'));
  assert.equal(path.dirname(icon.image!.path), s.projects.iconDir);
  assert.equal(icon.image!.mediaType, 'image/png');
  // Made small, for a 16 pt dot.
  assert.equal(icon.image!.width, 256);
  assert.ok(!('hash' in icon), 'the hash stays in the runner');

  // Nothing changed: the same copy.
  await s.settle(ICON_SWEEP_MS);
  assert.equal(s.projects.list()[0].icon!.image!.path, icon.image!.path);

  // A new icon in the repo: the next sweep copies it, and the old copy goes.
  fs.writeFileSync(icon.from!, png(512, 512, [10, 120, 200]));
  await s.settle(ICON_SWEEP_MS);
  const next = s.projects.list()[0].icon!;
  assert.notEqual(next.image!.path, icon.image!.path);
  assert.deepEqual(fs.readdirSync(s.projects.iconDir), [path.basename(next.image!.path)]);

  s.projects.delete(p.id);
  assert.deepEqual(fs.readdirSync(s.projects.iconDir), []);
  s.librarian.stop();
});

test('a project with no picture gets a symbol from the list; a made-up one is ignored', async () => {
  let answer = 'film';
  const s = setup((p) => {
    assert.match(p.prompt, /^Project "Scheduled jobs"/);
    assert.match(p.prompt, /Symbols: app macwindow/);
    return { ok: true, value: answer, model: 'haiku' };
  });
  answer = 'not.a.symbol';
  s.projects.create({ title: 'Scheduled jobs', by: 'librarian' });
  await s.settle();
  assert.equal(s.projects.list()[0].icon, undefined);
  answer = '"calendar".';
  await s.settle(ICON_SWEEP_MS);
  assert.deepEqual([s.projects.list()[0].icon?.symbol, s.projects.list()[0].icon?.by], ['calendar', 'librarian']);
  // Once it has one, it isn't asked again.
  const n = s.asked.length;
  await s.settle(ICON_SWEEP_MS);
  assert.equal(s.asked.length, n);
  s.librarian.stop();
});

test("Alex's and agents' choices stay until set back to automatic", async () => {
  const s = setup(() => ({ ok: true, value: 'hammer', model: 'haiku' }));
  const app = folder(s.root, 'tandem', { 'icons/tandem.png': png(300, 300) });
  const mine = path.join(s.root, 'mine.png');
  fs.writeFileSync(mine, png(64, 64));
  const p = s.projects.create({ title: 'Tandem', folders: [app], by: 'mike' });
  const m = projectMethods(s.projects);

  const chosen = (await m['projects.setIcon']({ projectId: p.id, path: mine })) as { project: { icon: { by: string; from: string; image: { width: number } } } };
  assert.deepEqual([chosen.project.icon.by, chosen.project.icon.from, chosen.project.icon.image.width], ['mike', mine, 64]);
  await s.settle(ICON_SWEEP_MS);
  assert.equal(s.projects.list()[0].icon!.from, mine);

  await assert.rejects(Promise.resolve().then(() => m['projects.setIcon']({ projectId: p.id, symbol: 'Not A Symbol!' })), /Not an SF Symbol/);
  await assert.rejects(Promise.resolve().then(() => m['projects.setIcon']({ projectId: p.id, path: '/nope.png' })), /Picture not found/);

  // An agent, through update_project.
  const { thread } = s.h.runner.create({ text: 'hi', cwd: app, accountId: 'claude-3' });
  const tools = buildThreadbearTools(s.h.runner, thread.id, Date.now, undefined, s.projects);
  const update = tools.find((t) => t.name === 'update_project')!;
  await update.handler({ project: 'Tandem', icon: 'film' } as never, {} as never);
  assert.deepEqual([s.projects.list()[0].icon?.symbol, s.projects.list()[0].icon?.by], ['film', 'agent']);
  await s.settle(ICON_SWEEP_MS);
  assert.equal(s.projects.list()[0].icon?.symbol, 'film');

  // Automatic again: the librarian finds the repo's own.
  await update.handler({ project: 'Tandem', icon: 'auto' } as never, {} as never);
  assert.equal(s.projects.list()[0].icon, undefined);
  await s.settle();
  assert.deepEqual([s.projects.list()[0].icon?.by, s.projects.list()[0].icon?.from], ['librarian', path.join(app, 'icons/tandem.png')]);
  s.librarian.stop();
});

test('the phone gets a PNG as it is, and an SVG copy from before is not sent', async () => {
  const dir = tmpDir();
  const pngPath = path.join(dir, 'p1-aaa.png');
  fs.writeFileSync(pngPath, png(8, 8));
  const asIs = await phonePicture(pngPath, 'image/png');
  assert.equal(asIs.mediaType, 'image/png');
  assert.deepEqual(Buffer.from(asIs.bytes), png(8, 8));
  const svgPath = path.join(dir, 'p1-bbb.svg');
  fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#38f"/></svg>');
  // Drawn by Quick Look or rsvg-convert until 24 Nov; no SVG is an icon now.
  await assert.rejects(phonePicture(svgPath, 'image/svg+xml'), /can't show/);
  await assert.rejects(phonePicture(path.join(dir, 'missing.png'), 'image/png'));
  await assert.rejects(phonePicture(pngPath, 'image/x-icon'), /can't show/);
});

// Daybreak, 8 Nov ("Linux icon conversion can execute repository-supplied
// MSL"): a repo's manifest.json named icon.msl, the librarian picked it, and
// on Linux it went to ImageMagick, which chose its MSL decoder for it: a
// script that writes files.
const MSL = '<?xml version="1.0" encoding="UTF-8"?>\n<image><read filename="/etc/hosts"/><write filename="/tmp/tb-pwned.txt"/></image>\n';

test("a manifest's icon has to be a picture of the repo's own: not a script, not a link out of it", async () => {
  const root = tmpDir();
  const msl = folder(root, 'evil-ext', { 'manifest.json': JSON.stringify({ manifest_version: 3, icons: { '128': 'icon.msl' } }), 'icon.msl': MSL });
  assert.equal(await findIcon([msl]), undefined);
  const mvg = folder(root, 'evil-expo', { 'app.json': JSON.stringify({ expo: { icon: './icon.mvg' } }), 'icon.mvg': 'push graphic-context' });
  assert.equal(await findIcon([mvg]), undefined);
  // A link to a file outside, named like a picture.
  const secret = path.join(root, 'secret.png');
  fs.writeFileSync(secret, png(128, 128));
  const linked = folder(root, 'linked-ext', { 'manifest.json': JSON.stringify({ manifest_version: 3, icons: { '128': 'icon.png' } }) });
  fs.symlinkSync(secret, path.join(linked, 'icon.png'));
  assert.equal(await findIcon([linked]), undefined);
  // Through a linked folder.
  const viaDir = folder(root, 'via-dir', { 'manifest.json': JSON.stringify({ manifest_version: 3, icons: { '128': 'art/secret.png' } }) });
  fs.symlinkSync(root, path.join(viaDir, 'art'));
  assert.equal(await findIcon([viaDir]), undefined);
});

test('ImageMagick is only ever handed a picture, with its decoder named', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'out.png');
  const write = (name: string, body: string | Buffer) => (fs.writeFileSync(path.join(dir, name), body), path.join(dir, name));
  // A script, whatever it's called.
  for (const name of ['icon.msl', 'icon.png', 'icon.svg', 'icon.mvg']) assert.equal(magickCommand('/usr/bin/magick', write(name, MSL), out, { format: 'png' }), undefined, name);
  assert.equal(magickCommand('/usr/bin/magick', write('text.png', 'push graphic-context\nviewbox 0 0 1 1'), out, { format: 'png' }), undefined);
  // A real PNG, even one named otherwise, goes to the PNG decoder by name.
  const real = write('real.msl', png(8, 8));
  const cmd = magickCommand('/usr/bin/magick', real, out, { format: 'png', maxPx: 256 });
  assert.equal(cmd?.[1][0], `png:${real}[0]`);
  assert.equal(cmd?.[1].at(-1), `png:${out}`);
  assert.equal(pictureKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(pictureKind(Buffer.from('\0\0\0\x18ftypheic', 'latin1')), 'heic');
  assert.equal(pictureKind(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp');
  assert.equal(pictureKind(Buffer.from('<?xml', 'latin1')), undefined);
});

test("storing an icon that isn't a picture by its bytes is refused, not copied or converted", async () => {
  const dir = tmpDir();
  const src = path.join(dir, 'icon.png');
  fs.writeFileSync(src, MSL);
  await assert.rejects(storeIcon(src, path.join(dir, 'icons'), 'p1', 'h'), /Not a picture/);
  assert.ok(!fs.existsSync(path.join(dir, 'icons', 'p1-h.png')));
});

test('an SVG is never drawn by ImageMagick on Linux', { skip: process.platform === 'darwin' }, async () => {
  // In a process of its own: images.ts remembers what it found on PATH, and
  // this one's PATH has only a magick that notes it ran.
  const dir = tmpDir();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'magick'), `#!/bin/sh\ntouch ${JSON.stringify(path.join(dir, 'ran'))}\n`, { mode: 0o755 });
  const svg = path.join(dir, 'a.svg');
  fs.writeFileSync(svg, '<svg viewBox="0 0 1 1"><image href="msl:/tmp/x.msl"/></svg>');
  const images = new URL('../../src/images.ts', import.meta.url).href;
  const script = `const { svgToPng } = await import(${JSON.stringify(images)}); console.log(await svgToPng(${JSON.stringify(svg)}, ${JSON.stringify(path.join(dir, 'a.png'))}, 64));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: bin }, encoding: 'utf8' });
  assert.equal(out.trim(), 'false');
  assert.ok(!fs.existsSync(path.join(dir, 'ran')), 'ImageMagick was not run');
});

test("Windows' converter is only ever handed a picture, with what to do passed in base64 in front of its script", () => {
  const dir = tmpDir();
  const out = path.join(dir, "it's out.jpg");
  const write = (name: string, body: string | Buffer) => (fs.writeFileSync(path.join(dir, name), body), path.join(dir, name));
  assert.equal(winCommand(write('icon.png', MSL), out, { format: 'png' }, 'SCRIPT', 'ps.exe'), undefined);
  const real = write('real.png', png(8, 8));
  const cmd = winCommand(real, out, { format: 'jpeg', quality: 80, maxPx: 2048, decodeLimit: { side: 4096, pixels: 16 * 1024 * 1024 } }, 'SCRIPT', 'ps.exe');
  assert.equal(cmd?.[0], 'ps.exe');
  const at = cmd![1].indexOf('-EncodedCommand');
  const text = Buffer.from(cmd![1][at + 1]!, 'base64').toString('utf16le');
  const m = /^\$p = '([A-Za-z0-9+/=]+)'\nSCRIPT$/.exec(text);
  assert.ok(m, text);
  assert.deepEqual(Buffer.from(m[1]!, 'base64').toString('utf8').split('\0'), [real, out, 'jpeg', '80', '2048', '4096', '16777216']);
});

// Daybreak, 24 Nov ("Automatically selected project icons are decoded without
// a pixel allocation bound"): a repo's icon.png of a few hundred bytes whose
// header said 60,000 px square was picked by the hourly sweep, handed to sips,
// and when that failed copied in as it was for the desktop app to decode whole.
function pngHeader(w: number, h: number, extra: Buffer[] = [], depth = 8, colour = 2): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = colour;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra.map((e) => e), chunk('IDAT', zlib.deflateSync(Buffer.alloc(64))), chunk('IEND', Buffer.alloc(0))]);
}

// A PNG chunk with no CRC (nothing here checks one).
function rawChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function acTL(): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(8);
  return Buffer.concat([len, Buffer.from('acTL', 'latin1'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]), Buffer.alloc(4)]);
}

function ico(entries: Buffer[]): Buffer {
  const head = Buffer.alloc(6 + entries.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach((e, i) => {
    head.writeUInt32LE(e.length, 6 + i * 16 + 8);
    head.writeUInt32LE(offset, 6 + i * 16 + 12);
    offset += e.length;
  });
  return Buffer.concat([head, ...entries]);
}

function icns(elements: [string, Buffer][]): Buffer {
  const parts = elements.map(([type, data]) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'latin1');
    h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'latin1');
  h.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([h, ...parts]);
}

function jpegHeader(w: number, h: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'), sof, Buffer.from([0xff, 0xd9])]);
}

function webpVP8X(w: number, h: number, flags = 0): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8X', 8, 'latin1');
  b.writeUInt32LE(10, 16);
  b[20] = flags;
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

test('an icon is refused before anything decodes it when its header is over the budget, moves, or says no size', async () => {
  const { checkIcon, ICON_MAX_SIDE } = await import('../../src/icon-budget.ts');
  const refused: [string, Buffer, boolean?][] = [
    ['huge PNG', pngHeader(60_000, 60_000)],
    ['one side too long', pngHeader(ICON_MAX_SIDE + 1, 16)],
    ['animated PNG', pngHeader(64, 64, [acTL()])],
    // JPEG and WebP aren't icons at all: their headers can't vouch for what a
    // decoder makes of them (Gemini's review: a VP8X wrapping a bigger VP8L,
    // a JPEG whose markers a reader here and a decoder walk differently).
    ['JPEG', jpegHeader(512, 512)],
    ['WebP', webpVP8X(256, 256)],
    ['16-bit RGBA at the side limit (128 MB decoded)', pngHeader(ICON_MAX_SIDE, ICON_MAX_SIDE, [], 16, 6)],
    ['PNG with a zTXt bomb', pngHeader(16, 16, [rawChunk('zTXt', Buffer.concat([Buffer.from('Comment\0\0', 'latin1'), zlib.deflateSync(Buffer.alloc(8 * 1024 * 1024))]))])],
    ['PNG with an iCCP bomb', pngHeader(16, 16, [rawChunk('iCCP', Buffer.concat([Buffer.from('icc\0\0', 'latin1'), zlib.deflateSync(Buffer.alloc(4 * 1024 * 1024))]))])],
    ['PNG whose chunk runs past the end', Buffer.concat([pngHeader(16, 16).subarray(0, 33), rawChunk('tEXt', Buffer.alloc(8)).subarray(0, 10)])],
    ['PNG frames after its image (fdAT)', pngHeader(16, 16, [rawChunk('fdAT', Buffer.alloc(8))])],
    ['ICNS with a nested dark-mode set', icns([['is32', Buffer.alloc(32)], ['\xfd\xd9\x2f\xa8', icns([['ic10', pngHeader(40_000, 40_000)]])]])],
    ['ICNS with a nested template set', icns([['sbtp', icns([['ic10', pngHeader(1024, 1024)]])]])],
    ['ICNS with bytes past its stated end', Buffer.concat([icns([['is32', Buffer.alloc(32)]]), pngHeader(60_000, 60_000)])],
    ['ICO with a compressed bitmap', ico([Buffer.concat([Buffer.from([40, 0, 0, 0, 16, 0, 0, 0, 32, 0, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0]), Buffer.alloc(24)])])],
    ['ICO with a huge PNG in it', ico([pngHeader(16, 16), pngHeader(50_000, 50_000)])],
    ['ICO of 33 pictures', ico(Array.from({ length: 33 }, () => pngHeader(16, 16)))],
    ['ICNS with a huge PNG in it', icns([['ic10', pngHeader(40_000, 40_000)]])],
    ['ICNS with JPEG 2000', icns([['ic09', Buffer.from([0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a])]])],
    ['ICNS of an unknown kind', icns([['zzzz', Buffer.alloc(64)]])],
    ['GIF', Buffer.from('GIF89a\x10\x00\x10\x00\x00\x00\x00;', 'latin1')],
  ];
  for (const [name, bytes, svg] of refused) assert.equal(checkIcon(bytes, Boolean(svg)).ok, false, name);
  const taken: [string, Buffer, boolean?][] = [
    ['1024 PNG', pngHeader(1024, 1024)],
    ['16-bit RGBA 1024 PNG', pngHeader(1024, 1024, [], 16, 6)],
    ['PNG with an ordinary colour profile', pngHeader(256, 256, [rawChunk('iCCP', Buffer.concat([Buffer.from('sRGB\0\0', 'latin1'), zlib.deflateSync(Buffer.alloc(3144, 7))]))])],
    ['ICO of bitmaps', ico([Buffer.concat([Buffer.from([40, 0, 0, 0, 16, 0, 0, 0, 32, 0, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0]), Buffer.alloc(24)])])],
    ['ICO', ico([pngHeader(16, 16), pngHeader(256, 256)])],
    ['ICNS', icns([['TOC ', Buffer.alloc(8)], ['is32', Buffer.alloc(32)], ['ic10', pngHeader(1024, 1024)]])],
  ];
  for (const [name, bytes, svg] of taken) assert.equal(checkIcon(bytes, Boolean(svg)).ok, true, name);

  // No SVG is an icon, plain or not: three review rounds each found a way
  // past a check of SVG text (a data: PNG in an <image>, then CDATA, a
  // namespace prefix and CSS sizing, then a non-ASCII prefix, a declared
  // encoding and a mask fan-out), and each renderer reads it its own way.
  for (const svg of [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#38f"/></svg>',
    `<svg viewBox="0 0 64 64"><image width="64" height="64" href="data:image/png;base64,${pngHeader(60_000, 60_000).toString('base64')}"/></svg>`,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g xmlns:é="http://www.w3.org/2000/svg"><é:filter id="f" filterUnits="userSpaceOnUse" width="60000" height="60000"><é:feFlood/></é:filter><rect filter="url(#f)"/></g></svg>',
  ]) {
    assert.equal(checkIcon(Buffer.from(svg), true).ok, false, svg.slice(0, 60));
  }

  // Never a candidate, so the sweep picks the next best instead.
  const root = tmpDir();
  const app = folder(root, 'bomb', {
    'App/Assets.xcassets/AppIcon.appiconset/icon-1024.png': pngHeader(60_000, 60_000),
    'public/apple-touch-icon.png': png(180, 180),
  });
  assert.equal((await findIcon([app]))?.path, path.join(app, 'public/apple-touch-icon.png'));
  const ext = folder(root, 'bomb-ext', { 'manifest.json': JSON.stringify({ manifest_version: 3, icons: { '128': 'i.png' } }), 'i.png': pngHeader(60_000, 60_000) });
  assert.equal(await findIcon([ext]), undefined);

  // And storing one (Mike's or an agent's pick) refuses it before converting.
  const dir = path.join(root, 'icons');
  await assert.rejects(storeIcon(path.join(app, 'App/Assets.xcassets/AppIcon.appiconset/icon-1024.png'), dir, 'p1', 'h'), /Not taken as an icon/);
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
});

test("an icon the converter can't make a small PNG of isn't kept, never copied as it was", async () => {
  const dir = tmpDir();
  // A PNG by its header, within the budget, whose pixels aren't there.
  const src = path.join(dir, 'icon.ico');
  fs.writeFileSync(src, ico([pngHeader(512, 512)]));
  await assert.rejects(storeIcon(src, path.join(dir, 'icons'), 'p1', 'h'), /Could not make/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'icons')), []);
});

test('an icon copied as it was by an older release is made again, and the phone is sent none over the budget', skipOnWindows(NO_RESIZE), async () => {
  const { storedIconOk } = await import('../../src/project-icons.ts');
  const dir = tmpDir();
  const raw = path.join(dir, 'p1-old.png');
  fs.writeFileSync(raw, png(1024, 1024));
  assert.equal(await storedIconOk({ path: raw, mediaType: 'image/png', width: 1024, height: 1024 }), false);
  const small = path.join(dir, 'p1-new.png');
  fs.writeFileSync(small, png(256, 256));
  assert.equal(await storedIconOk({ path: small, mediaType: 'image/png', width: 256, height: 256 }), true);
  const ico1 = path.join(dir, 'p1-old.ico');
  fs.writeFileSync(ico1, ico([pngHeader(16, 16)]));
  assert.equal(await storedIconOk({ path: ico1, mediaType: 'image/x-icon' }), false);

  const bomb = path.join(dir, 'p2-old.png');
  fs.writeFileSync(bomb, pngHeader(60_000, 60_000));
  await assert.rejects(phonePicture(bomb, 'image/png'), /isn't sent to the phone/);
  const svgBomb = path.join(dir, 'p3-old.svg');
  fs.writeFileSync(svgBomb, `<svg viewBox="0 0 64 64"><image href="data:image/png;base64,${pngHeader(60_000, 60_000).toString('base64')}"/></svg>`);
  assert.equal(await storedIconOk({ path: svgBomb, mediaType: 'image/svg+xml' }), false);
  await assert.rejects(phonePicture(svgBomb, 'image/svg+xml'), /can't show/);
  // A raw .ico an older runner kept, named as a PNG, isn't sent as one.
  const icoAsPng = path.join(dir, 'p4-old.png');
  fs.writeFileSync(icoAsPng, ico([pngHeader(16, 16)]));
  await assert.rejects(phonePicture(icoAsPng, 'image/png'), /not a PNG/);

  // The librarian replaces such a copy on its next look, with the same file.
  const s = setup();
  const app = folder(s.root, 'legacy', { 'Legacy/Assets.xcassets/AppIcon.appiconset/AppIcon.png': png(1024, 1024) });
  const p = s.projects.create({ title: 'Legacy', folders: [app], by: 'mike' });
  await s.settle();
  await s.settle(ICON_SWEEP_MS);
  const first = s.projects.list()[0].icon!;
  // As an older release left it: the repo's file as it was.
  fs.copyFileSync(first.from!, first.image!.path);
  assert.equal(await storedIconOk(first.image!), false);
  await s.settle(ICON_SWEEP_MS);
  const again = s.projects.list()[0].icon!;
  assert.equal(again.image!.width, 256);
  assert.ok(await storedIconOk(again.image!));
  s.projects.delete(p.id);
  s.librarian.stop();
});

test("when the best picture can't be copied here, the librarian takes the next one, not a symbol", skipOnWindows(NO_RESIZE), async () => {
  const s = setup(() => ({ ok: true, value: 'hammer', model: 'haiku' }));
  // The app icon's header is fine but its pixels aren't there, so no
  // converter makes anything of it (as an .icns on Linux, which nothing there
  // converts: Gemini's review).
  const app = folder(s.root, 'nextbest', {
    'App/Assets.xcassets/AppIcon.appiconset/icon-1024.png': pngHeader(1024, 1024),
    'public/apple-touch-icon.png': png(180, 180),
  });
  s.projects.create({ title: 'Nextbest', folders: [app], by: 'mike' });
  await s.settle();
  const icon = s.projects.list()[0].icon!;
  assert.equal(icon.from, path.join(app, 'public/apple-touch-icon.png'));
  assert.equal(icon.image?.width, 180);
  s.librarian.stop();
});

test('a web app with an SVG favicon and a PNG gets the PNG; one with only an SVG gets a symbol', skipOnWindows(NO_RESIZE), async () => {
  const s = setup(() => ({ ok: true, value: 'globe', model: 'haiku' }));
  const both = folder(s.root, 'both', { 'public/favicon.svg': '<svg viewBox="0 0 64 64"><rect width="64" height="64"/></svg>', 'public/favicon-192.png': png(192, 192) });
  const only = folder(s.root, 'only', { 'public/favicon.svg': '<svg viewBox="0 0 64 64"><rect width="64" height="64"/></svg>' });
  s.projects.create({ title: 'Both', folders: [both], by: 'mike' });
  s.projects.create({ title: 'Only', folders: [only], by: 'mike' });
  await s.settle();
  const byTitle = Object.fromEntries(s.projects.list().map((p) => [p.title, p.icon]));
  assert.equal(byTitle.Both?.from, path.join(both, 'public/favicon-192.png'));
  assert.deepEqual([byTitle.Only?.image, byTitle.Only?.symbol], [undefined, 'globe']);
  s.librarian.stop();
});

test('a picture copy an older runner kept as the repo had it is dropped when the runner starts, before any app sees it', async () => {
  const home = tmpDir();
  const icons = path.join(home, 'project-icons');
  fs.mkdirSync(icons, { recursive: true });
  const good = path.join(icons, 'p_good-aaa.png');
  fs.writeFileSync(good, png(256, 256));
  const raw = path.join(icons, 'p_raw-bbb.png');
  fs.writeFileSync(raw, pngHeader(60_000, 60_000));
  const svg = path.join(icons, 'p_svg-ccc.svg');
  fs.writeFileSync(svg, '<svg viewBox="0 0 64 64"><rect width="64" height="64"/></svg>');
  const at = '2026-11-01T00:00:00.000Z';
  const record = (id: string, image: { path: string; mediaType: string }, by: string) => ({ id, title: id, folders: [], createdBy: 'mike', createdAt: at, updatedAt: at, icon: { image, by, updatedAt: at } });
  fs.writeFileSync(
    path.join(home, 'projects.json'),
    JSON.stringify({ projects: [record('p_good', { path: good, mediaType: 'image/png' }, 'librarian'), record('p_raw', { path: raw, mediaType: 'image/png' }, 'mike'), record('p_svg', { path: svg, mediaType: 'image/svg+xml' }, 'librarian')] }),
  );
  const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger, userHome: tmpDir() });
  const h = makeHarness(home, {}, { projects });
  projects.start(h.runner);
  const byId = Object.fromEntries(projects.list().map((p) => [p.id, p.icon]));
  assert.equal(byId.p_good?.image?.path, good);
  assert.equal(byId.p_raw, undefined);
  assert.equal(byId.p_svg, undefined);
  assert.ok(!fs.existsSync(raw) && !fs.existsSync(svg) && fs.existsSync(good));
});
