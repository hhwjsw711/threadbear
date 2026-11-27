// The review as a board (review-canvas.feature):
// what the open review window's `canvas` says (review_window/canvas.rs,
// `canvas_state`), and a mark drawn as the mouse would draw it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shotsReview } from '../support/review-demo.ts';
import { Then, When } from '@cucumber/cucumber';
import { okValue, sleep } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';
import { reviewId } from './review.steps.ts';

type CanvasState = { camera?: number[]; pageBounds?: number[]; on: boolean; stop: number; stops: number; lit: string; notesOn: boolean; agentMarks: number; tool: string; marks: string[]; mediaNotice?: string | null; playing?: string | null };
type WithCanvas = { status?: string; reply: string; error?: string; replyKeys?: boolean; pageKeys?: boolean; nativeKeyboard?: string; canvas?: CanvasState | null };

async function board(world: ThreadbearWorld, cmd: Record<string, unknown> = {}): Promise<WithCanvas> {
  return JSON.parse(okValue(await world.app.do({ cmd: 'review', id: reviewId(world), open: false, ...cmd }, 30))) as WithCanvas;
}

async function untilBoard(world: ThreadbearWorld, what: string, check: (s: WithCanvas) => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last: WithCanvas | string = 'no answer yet';
  for (;;) {
    try {
      last = await board(world);
      if (check(last)) return;
    } catch (e) {
      last = (e as Error).message;
    }
    if (Date.now() > deadline) throw new Error(`Never saw: ${what}\n\nThe review said: ${JSON.stringify(last)}`);
    await sleep(150);
  }
}

Then('the review is a board on stop {int} of {int}', async function (this: ThreadbearWorld, stop: number, stops: number) {
  await untilBoard(this, `the board on stop ${stop} of ${stops}`, (s) => !!s.canvas && s.canvas.on && s.canvas.stop === stop && s.canvas.stops === stops);
});

Then("the board has {int} of the agent's notes, showing", async function (this: ThreadbearWorld, count: number) {
  await untilBoard(this, `${count} notes showing`, (s) => !!s.canvas && s.canvas.agentMarks === count && s.canvas.notesOn);
});

Then("the board's notes are hidden", async function (this: ThreadbearWorld) {
  await untilBoard(this, 'the notes hidden', (s) => s.canvas?.notesOn === false);
});

When("I circle a part of option A's picture on the board", async function (this: ThreadbearWorld) {
  await board(this, { canvasMark: { kind: 'circle', option: 0, shot: 0, points: [[0.4, 0.15], [0.7, 0.14], [0.72, 0.24], [0.42, 0.25], [0.4, 0.16]] } });
});

Then('the board has my mark {string}', async function (this: ThreadbearWorld, mark: string) {
  await untilBoard(this, `my mark ${mark}`, (s) => s.canvas?.marks.includes(mark) ?? false);
});

Then("the review's reply is {string}", async function (this: ThreadbearWorld, reply: string) {
  await untilBoard(this, `the reply "${reply}"`, (s) => s.reply.trim() === reply);
});

When("I click low in the review's reply box", async function (this: ThreadbearWorld) {
  await board(this, { pressReplyLow: true });
});

Then("the review's reply box has the keys", async function (this: ThreadbearWorld) {
  await untilBoard(this, 'the keys in the reply box', (s) => s.replyKeys === true);
});

When('the board flies to option {string}', async function (this: ThreadbearWorld, id: string) {
  await board(this, { canvasGo: id });
});

// A button on the board, once it's there and the board's stopped moving:
// it may still be flying to it, and what's out of sight isn't drawn.
When('I press {string} on the board', async function (this: ThreadbearWorld, tip: string) {
  // Still, first: a click aimed at a button mid-flight lands beside it.
  let last = '';
  await untilBoard(this, 'the board still', (s) => {
    const now = JSON.stringify((s.canvas as { camera?: number[] } | null | undefined)?.camera ?? null);
    const still = now === last;
    last = now;
    return still;
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await this.app.do({ cmd: 'click', tip, review: reviewId(this) });
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await sleep(200);
    }
  }
});

When('the board flies to option {string}, shot {int}', async function (this: ThreadbearWorld, id: string, shot: number) {
  await board(this, { canvasGo: id, canvasShot: shot - 1 });
});

Then('the board plays a clip in place', async function (this: ThreadbearWorld) {
  await untilBoard(this, 'a clip playing on the board', (s) => s.canvas?.playing === 'clip');
});

Then('nothing plays on the board', async function (this: ThreadbearWorld) {
  await untilBoard(this, 'nothing playing on the board', (s) => !s.canvas?.playing);
});

Then('the board plays a sound in place', async function (this: ThreadbearWorld) {
  await untilBoard(this, 'a sound playing on the board', (s) => s.canvas?.playing === 'sound');
});

Then('the board frames option {string}, shot {int}', async function (this: ThreadbearWorld, id: string, shot: number) {
  const option = id.charCodeAt(0) - 65;
  const lit = shot === 1 ? `Opening(${option})` : `Shot(${option}, ${shot - 1})`;
  await untilBoard(this, `${id}'s shot ${shot} framed`, (s) => s.canvas?.lit === lit);
});


Then('the board runs HTML in place', async function (this: ThreadbearWorld) {
  await untilBoard(this, 'HTML running in place', (s) => s.canvas?.playing === 'page');
  const value = JSON.parse(okValue(await this.app.do({ cmd: 'review', id: reviewId(this), open: false, canvasPageJs: 'typeof document.body === "object"' })));
  if (value !== true) throw new Error('The HTML body never loaded');
});


When('I double-click HTML option {string}, shot {int} on the board', async function (this: ThreadbearWorld, id: string, shot: number) {
  await board(this, {canvasDoubleClick: [id.charCodeAt(0) - 65, shot - 1]});
});

Then('the live HTML keeps a desktop CSS viewport as the card scales', async function (this: ThreadbearWorld) {
  const inspect = async () => JSON.parse(okValue(await this.app.do({cmd: 'review', id: reviewId(this), open: false, canvasPageJs: 'window.innerWidth'}))) as number;
  const before = await inspect();
  if (Math.abs(before - 1024) > 16) throw new Error(`Expected desktop viewport, got ${before}`);
  await board(this, {canvasZoom: 0.9});
  const after = await inspect();
  if (Math.abs(after - before) > 16) throw new Error(`Viewport reflowed from ${before} to ${after}`);
});


Then('HTML input owns editing shortcuts and Stop returns the keyboard', async function (this: ThreadbearWorld) {
  const js = async (expression: string) => JSON.parse(okValue(await this.app.do({cmd: 'review', id: reviewId(this), open: false, canvasPageJs: expression})));
  const key = async (key: string, modifiers = ['cmd']) => this.app.do({cmd: 'menu-key', key, modifiers, review: reviewId(this)});
  const clipboard = JSON.parse(okValue(await this.app.do({cmd: 'clipboard'}))) as string;
  const before = await board(this);
  try {
    await js(`(() => {const input=document.createElement('input');input.id='edit-test';input.value='seed';document.body.prepend(input);input.focus();return true})()`);
    await board(this, {canvasFocusPage: true});
    await untilBoard(this, 'the native page holding keys', (s) => s.pageKeys === true);
    await this.app.do({cmd: 'clipboard', set: 'pasted locally'});
    await key('a');
    await key('v');
    if (await js(`document.getElementById('edit-test').value`) !== 'pasted locally') throw new Error('Paste missed the HTML input');
    if ((await board(this)).reply !== before.reply) throw new Error('The review reply stole paste');
    await key('z');
    if (await js(`document.getElementById('edit-test').value`) !== 'seed') throw new Error('Undo missed the HTML input');
    await key('z', ['cmd', 'shift']);
    if (await js(`document.getElementById('edit-test').value`) !== 'pasted locally') throw new Error('Redo missed the HTML input');
    await key('a');
    await key('x');
    await key('c');
    if (await js(`document.getElementById('edit-test').value`) !== 'pasted locally') throw new Error('The sealed page allowed Cut');
    await this.app.do({cmd: 'click', review: reviewId(this), tip: 'Stop B. One picker, shot 2'});
    await untilBoard(this, 'GPUI holding native keys after Stop', (s) => !s.canvas?.playing && s.nativeKeyboard === 'app');
    await key('o', []);
    await untilBoard(this, 'a marking shortcut immediately after Stop', (s) => s.canvas?.tool === 'circle');
  } finally {
    await this.app.do({cmd: 'clipboard', set: clipboard});
  }
});


Then('changing the HTML leaves a persistent dismissible media notice', async function (this: ThreadbearWorld) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-canvas-watcher-'));
  const fixture = shotsReview();
  const shot = fixture.options[1]!.shots[1]!;
  if (!('media' in shot) || !shot.media) throw new Error('The HTML fixture has no media');
  const page = shot.media;
  const original = page.path;
  page.path = path.join(dir, 'page.html');
  fs.copyFileSync(original, page.path);
  const threadId = (await this.app.dump()).selection!.id;
  try {
    await this.app.do({cmd: 'mock', method: 'review', params: {threadId, review: fixture}});
    await untilBoard(this, 'the replaced page stopped', (s) => !s.canvas?.playing);
    await board(this, {canvasGo: 'B', canvasShot: 1});
    await sleep(750);
    await this.app.do({cmd: 'click', review: reviewId(this), tip: 'Interact with B. One picker, shot 2 here, sealed and offline'});
    await untilBoard(this, 'the temporary HTML running', (s) => s.canvas?.playing === 'page');
    fs.appendFileSync(page.path, '\n<!-- changed after activation -->');
    await untilBoard(this, 'the changed page stopped with a media notice', (s) => !s.canvas?.playing && !!s.canvas?.mediaNotice?.includes('page changed'));
    // A real refresh poll must keep the notice, and must not turn it into a
    // failed draft save with a retry button.
    await sleep(5500);
    const stopped = await board(this);
    if (!stopped.canvas?.mediaNotice?.includes('page changed') || stopped.error) throw new Error(`Notice was lost or became a draft error: ${JSON.stringify(stopped)}`);
    await this.app.do({cmd: 'click', review: reviewId(this), tip: 'Dismiss this media notice'});
    if ((await board(this)).canvas?.mediaNotice) throw new Error('Dismiss kept the media notice');
  } finally {
    await this.app.do({cmd: 'mock', method: 'review', params: {threadId, review: shotsReview()}});
    await board(this);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});


Then('HTML initial load keeps its zoom without a GPUI repaint', async function (this: ThreadbearWorld) {
  await this.app.do({cmd: 'webRuntime', do: 'start', wait: 60}, 90);
  // The probe page is hidden and never belongs to GPUI's stage. It sets
  // bounds/zoom once before LoadLater commits, then only polls DevTools.
  // CEF has a 25% zoom floor: 256pt is the smallest 1024px viewport.
  for (const width of [256, 384, 640]) {
    const viewport = JSON.parse(okValue(await this.app.do({cmd: 'review', id: reviewId(this), open: false, canvasLoadZoomProbe: width}, 30))) as number;
    if (Math.abs(viewport - 1024) > 16) throw new Error(`Initial commit reset zoom: card=${width}, viewport=${viewport}`);
  }
  // Static cards may be smaller. Interact must fit one to a supported native
  // width before mounting Chromium, rather than silently reflowing its UI.
  await board(this, {canvasGo: 'B', canvasShot: 1});
  await sleep(750);
  const scale = (await board(this)).canvas?.camera?.[0];
  if (!scale) throw new Error('No canvas camera');
  await board(this, {canvasZoom: 200 / (640 * scale), canvasPan: [100, 200]});
  await this.app.do({cmd: 'click', review: reviewId(this), tip: 'Interact with B. One picker, shot 2 here, sealed and offline'});
  await untilBoard(this, 'the small card fitted before interaction', (s) => s.canvas?.playing === 'page' && (s.canvas.pageBounds?.[2] ?? 0) >= 256);
  const width = JSON.parse(okValue(await this.app.do({cmd: 'review', id: reviewId(this), open: false, canvasPageJs: 'innerWidth'}))) as number;
  if (Math.abs(width - 1024) > 16) throw new Error(`Small-card activation reflowed the page: ${width}`);
});

Then('a live HTML input cannot edit or submit the focused reply draft', async function (this: ThreadbearWorld) {
  const js = async (expression: string) => JSON.parse(okValue(await this.app.do({cmd: 'review', id: reviewId(this), open: false, canvasPageJs: expression})));
  const key = async (key: string, modifiers = ['cmd']) => this.app.do({cmd: 'menu-key', review: reviewId(this), key, modifiers});
  await board(this, {reply: 'Keep this draft', focusReply: true});
  await this.app.do({cmd: 'click', review: reviewId(this), tip: 'Interact with B. One picker, shot 2 here, sealed and offline'});
  await untilBoard(this, 'the HTML running', (s) => s.canvas?.playing === 'page');
  await js(`(() => {const input=document.createElement('input');input.id='reply-guard-test';input.value='HTML input';input.style.cssText='position:fixed;left:24px;top:24px;width:220px;height:40px;z-index:2147483647';document.body.prepend(input);return true})()`);
  // The native probe renders only before the click from reply into the
  // mounted input, then tests focus notification and shortcuts without a frame.
  const probe = JSON.parse(okValue(await this.app.do({cmd: 'review', id: reviewId(this), open: false, canvasReplyFocusProbe: true}, 30)));
  if (!probe.notified || probe.sameTickKeys !== 5 || probe.nativeShortcuts !== 2) throw new Error(`Incomplete no-repaint probe: ${JSON.stringify(probe)}`);
  const guarded = await board(this);
  if (guarded.status !== 'pending' || guarded.reply !== 'Keep this draft') throw new Error(`HTML shortcut changed the review: ${JSON.stringify(guarded)}`);
  await board(this, {focusReply: true});
  await untilBoard(this, 'reply editing restored', (s) => s.replyKeys === true && s.nativeKeyboard === 'app');
  const clipboard = JSON.parse(okValue(await this.app.do({cmd: 'clipboard'}))) as string;
  try {
    await this.app.do({cmd: 'clipboard', set: 'Edited back in the reply'});
    await key('a');
    await key('v');
    await untilBoard(this, 'normal reply editing after clicking back', (s) => s.reply === 'Edited back in the reply');
    const native = async (code: number, text: string, modifiers: number) => this.app.do({cmd: 'native-shortcut', review: reviewId(this), code, text, modifiers});
    await native(123, '\uf702', 1); // Cmd-Left, then native Cocoa kill-line.
    await native(40, 'k', 2);
    await untilBoard(this, 'Control-K still edits the genuinely focused reply', (s) => s.reply === '');
    await this.app.do({cmd: 'native-keys', review: reviewId(this), text: 'normal typing'});
    await untilBoard(this, 'native typing in the reply', (s) => s.reply === 'normal typing');
    await native(123, '\uf702', 1);
    await native(124, '\uf703', 1);
    await native(51, '\x7f', 1);
    await untilBoard(this, 'Cmd-Right and Cmd-Backspace still edit the reply', (s) => s.reply === '');
    await this.app.do({cmd: 'native-keys', review: reviewId(this), text: 'Reply submitted normally'});
    await native(36, '\r', 1);
    let submitted = false;
    for (let i = 0; i < 30; i++) {
      try { if ((await board(this, {open: true})).status === 'answered') { submitted = true; break; } } catch { /* The send closes the old window before reopening its answered record. */ }
      await sleep(100);
    }
    if (!submitted) throw new Error('Cmd-Return stopped working in the genuine reply');
  } finally { await this.app.do({cmd: 'clipboard', set: clipboard}); }
});
