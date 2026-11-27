// Focused live-canvas acceptance check and window-only evidence. Run on
// Tinker Desk's desktop through remote.sh --desk, never on Mike's screen.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyReviewMedia } from '../../runner/src/review-media.ts';
import { GpuiDriver } from '../support/gpui.ts';
import { okValue, sleep } from '../support/driver.ts';
import { runtimeParent } from '../support/web-runtime.ts';
import { assertOwnScreen, assertInFront, movePointer, pointer, recording, screenWindows } from './real-screen.ts';

const out = path.resolve(process.argv[2] ?? '/tmp/interactive-canvas');
fs.mkdirSync(out, { recursive: true });
if (process.platform !== 'darwin') throw new Error('This check needs the sealed Mac runtime');
if (os.hostname().split('.')[0] !== 'tinker-desk') throw new Error('Run through remote.sh tinker-desk --desk; this check posts real pointer events');
if (recording()) throw new Error('Another job is recording this desktop');
assertOwnScreen();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-interactive-canvas-'));
const runtime = fs.mkdtempSync(path.join(runtimeParent(), 'canvas-runtime-'));
process.env.THREADBEAR_WEB_RUNTIME_DIR = runtime;
const archive = process.env.TB_WEB_RUNTIME_ARCHIVE;
assert.ok(archive, 'TB_WEB_RUNTIME_ARCHIVE must name the pinned runtime');
const app = new GpuiDriver();
const id = 'interactive_canvas';
type State = { canvas?: { playing?: string; activeCard?: [number, number]; tool?: string; pageBounds?: [number, number, number, number] }; pageFailed?: string };
const state = async (args: Record<string, unknown> = {}): Promise<State> => JSON.parse(okValue(await app.do({ cmd: 'review', id, open: false, ...args }, 30)));
const js = async (expression: string) => JSON.parse(okValue(await app.do({ cmd: 'review', id, open: false, canvasPageJs: expression }, 30)));
let checks = 0;
function check(value: unknown, label: string): void { assert.ok(value, label); checks += 1; console.log(`PASS ${label}`); }
async function until(test: () => Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) { if (await test().catch(() => false)) return; await sleep(150); }
  throw new Error(`Timed out: ${label}; ${JSON.stringify(await state())}`);
}
async function press(tip: string): Promise<void> { await app.do({ cmd: 'click', review: id, tip }); }
async function interact(option: string): Promise<void> {
  await press(`Interact with ${option}. ${option === 'A' ? 'Workspace' : 'Preferences'} here, sealed and offline`);
  await until(async () => (await state()).canvas?.playing === 'page' && await js('document.readyState === "complete"'), 'live page loaded');
}
async function shot(name: string): Promise<void> {
  assertOwnScreen();
  await app.do({ cmd: 'front', review: id });
  await state({ present: true });
  await sleep(400);
  // CEF is a native child view: GPUI render_to_image omits it, so capture
  // this app's frontmost ordinary window, by its exact window id.
  const w = screenWindows().find((w) => w.pid === app.pid && w.layer === 0 && Math.abs(w.frame[2]! - 1500) < 20 && Math.abs(w.frame[3]! - 950) < 40);
  assert.ok(w, 'the review window is on screen');
  assertOwnScreen();
  execFileSync('screencapture', ['-x', '-o', '-l', String(w.id), path.join(out, name)]);
}
const html = (title: string) => `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:36px;background:#181b24;color:#edf1fc;font:18px system-ui}h1{font-size:32px;margin:0 0 20px}nav{display:flex;gap:20px;color:#a5b4cf;margin-bottom:26px}section{border:1px solid #394154;border-radius:16px;padding:26px;max-width:700px;background:#222735}p{line-height:1.6}button{border:0;border-radius:10px;background:#b7e1cd;color:#173a2c;padding:14px 22px;font:600 18px system-ui;cursor:pointer}#status{color:#b7e1cd;font-size:24px;font-weight:600}</style>
<h1>${title}</h1><nav><span>Overview</span><span>Activity</span><span>Settings</span></nav><section><p>Try the controls without leaving the comparison.</p><p id="status">Alerts are off</p><button onclick="document.getElementById('status').textContent='Alerts are on';this.textContent='Turn alerts off'">Turn alerts on</button></section>`;
try {
  const shots = ['Workspace', 'Preferences'].map((title, index) => {
    const file = path.join(work, `option${index}.html`);
    fs.writeFileSync(file, html(title));
    fs.writeFileSync(path.join(work, 'private.txt'), 'sibling-file-must-not-be-readable');
    const shot = copyReviewMedia(path.join(work, `media${index}`), file, 'page');
    fs.writeFileSync(path.join(path.dirname(shot.media.path), 'private.txt'), 'sibling-file-must-not-be-readable');
    return shot;
  });
  await app.start();
  let thread = '';
  await until(async () => {
    const d = await app.dump();
    thread = d.sidebar.sections.flatMap((s) => s.threads).find((t) => t.title === 'Compare account picker designs')?.id ?? '';
    return !!thread;
  }, 'demo thread');
  await app.do({ cmd: 'appearance', mode: 'dark' });
  await app.do({ cmd: 'webRuntime', do: 'install', archive, wait: 600 }, 630);
  await app.do({ cmd: 'open', id: thread });
  await sleep(500);
  const options = shots.map((shot, i) => ({ id: i ? 'B' : 'A', title: i ? 'Preferences' : 'Workspace', image: shot.image, shots: [shot] }));
  const review = { id, title: 'Try the options', status: 'pending', revision: 0, draft: { notes: {} }, options };
  await app.do({ cmd: 'mock', method: 'review', params: { threadId: thread, review } });
  await sleep(500);
  await app.do({ cmd: 'review', id });
  await app.do({ cmd: 'resize', review: id, w: 1500, h: 950 });
  await press('See everything (0)');
  await sleep(1000);
  check(!(await state()).canvas?.playing, 'HTML defaults to static snapshots');
  await shot('01-static-canvas.png');
  await interact('A');
  // This tool runs only on Tinker Desk's desktop. A real click must reach
  // Chromium without starting a canvas drag.
  await app.do({ cmd: 'front', review: id });
  const posed = await state({ present: true });
  const slot = posed.canvas?.pageBounds;
  assert.ok(slot);
  const button = await js(`(() => {const r=document.querySelector('button').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
  const w = screenWindows().find((w) => w.pid === app.pid && w.layer === 0 && Math.abs(w.frame[2]! - 1500) < 20 && Math.abs(w.frame[3]! - 950) < 40);
  assert.ok(w && app.pid);
  const point: [number, number] = [w.frame[0]! + slot[0] + button[0] * (slot[2] / 1024), w.frame[1]! + slot[1] + button[1] * (slot[2] / 1024)];
  const click = path.join(work, 'click');
  fs.writeFileSync(`${click}.swift`, `import CoreGraphics
import Foundation
let a=CommandLine.arguments
let p=CGPoint(x:Double(a[1])!,y:Double(a[2])!)
for type in [CGEventType.mouseMoved,.leftMouseDown,.leftMouseUp] {
  let e=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:p,mouseButton:.left)!
  e.setIntegerValueField(.mouseEventClickState,value:1)
  e.post(tap:.cghidEventTap)
  usleep(100_000)
}`);
  execFileSync('swiftc', ['-O', `${click}.swift`, '-o', click]);
  const savedPointer = pointer();
  try {
    assertInFront(app.pid, [point]);
    execFileSync(click, point.map(String));
    await until(async () => await js(`document.getElementById('status').textContent === 'Alerts are on'`), 'real click changes local state');
  } finally { movePointer(savedPointer); }
  check(true, 'real button click reaches HTML without canvas panning');
  await shot('02-live-in-place.png');
  const seal = await js(`(async () => {
    const denied = async u => {try {const r=await fetch(u);return !r.ok}catch{return true}};
    return {network:await denied('https://example.com/'), sibling:await denied('private.txt'),
      confirm:confirm('blocked')===false,prompt:prompt('blocked')===null,popup:window.open('https://example.com/')===null,
      rtc:typeof RTCPeerConnection==='undefined',print:(print(),true)};
  })()`);
  check(Object.values(seal).every(Boolean), `sealed runtime: ${JSON.stringify(seal)}`);
  await js(`(alert('blocked'), location.assign('https://example.com/'), true)`);
  await sleep(250);
  check((await js('location.hostname')).endsWith('.preview.threadbear.invalid'), 'external navigation is blocked');
  await press('Circle a part (O)');
  check(!(await state()).canvas?.playing, 'marking immediately restores snapshot');
  await shot('03-snapback-marking.png');
  await press('Move and zoom (V)');
  await interact('A');
  await interact('B');
  check((await state()).canvas?.activeCard?.[0] === 1, 'activating B replaces A');
  await interact('A');
  check(await js(`document.getElementById('status').textContent === 'Alerts are off'`), 'reactivating A creates a fresh runtime');
  await press('Stop A. Workspace');
  check(!(await state()).canvas?.playing, 'Stop restores snapshot');
  await interact('A');
  await state({ canvasPan: [-5000, 0] });
  check(!(await state()).canvas?.playing, 'offscreen pan destroys runtime');
  await state({ canvasGo: 'A' });
  await sleep(1000);
  await interact('A');
  await state({ canvasPan: [0, -100] });
  check(!(await state()).canvas?.playing, 'clipping into canvas tools destroys runtime');
  await state({ canvasGo: 'A' });
  await sleep(1000);
  await interact('A');
  await state({ canvasZoom: 8 });
  check(!(await state()).canvas?.playing, 'zooming beyond safe overlay bounds destroys runtime');
  await state({ canvasGo: 'A' });
  await sleep(1000);
  await interact('A');
  fs.appendFileSync(shots[0]!.media.path, '\n<!-- changed after Interact -->');
  await until(async () => !(await state()).canvas?.playing, 'changed file stops its runtime');
  check(true, 'changing HTML bytes stops the bound runtime');
  await interact('A');
  // Update the record without changing the window id.
  await app.do({ cmd: 'mock', method: 'review', params: { threadId: thread, review: { ...review, revision: 1, options: options.slice(1) } } });
  await until(async () => !(await state()).canvas?.playing, 'new option set stops old page');
  check(true, 'switching option set restores snapshots');
  await interact('B');
  await app.do({ cmd: 'review', id, close: true });
  await assert.rejects(state);
  check(true, 'closing the comparison disposes its live page');
  console.log(`PASS ${checks} checks; screenshots ${out}`);
} finally {
  await app.stop();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(runtime, { recursive: true, force: true });
}
