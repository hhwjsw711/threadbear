import { After, Then, When } from '@cucumber/cucumber';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sampleOffice } from '../support/office-document.ts';
import assert from 'node:assert/strict';
import type { ThreadbearWorld } from '../support/world.ts';
import { pane, previewLine } from '../support/pane.ts';
import { okValue } from '../support/driver.ts';

const officeFolders = new WeakMap<ThreadbearWorld, string>();
When('I open a sample Office document in the pane', async function (this: ThreadbearWorld) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-office-preview-'));
  officeFolders.set(this, folder);
  const document = sampleOffice(folder);
  await this.app.do({ cmd: 'opened' });
  await this.app.do({ cmd: 'preview', path: document });
});

After(function (this: ThreadbearWorld) {
  const folder = officeFolders.get(this);
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
});

Then('the pane shows a Quick Look thumbnail', async function (this: ThreadbearWorld) {
  await this.until('a Quick Look document thumbnail', (d) => pane(d)?.previewKind === 'quickLook' && Boolean(pane(d)?.previewText), 30_000);
});

Then('the document has not opened another app', async function (this: ThreadbearWorld) {
  const opened = await this.app.do({ cmd: 'opened' });
  const text = typeof opened === 'string' ? opened.replace(/^ok /, '') : JSON.stringify(opened);
  assert.deepEqual(JSON.parse(text), []);
});

When('I click the highlight {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`a highlight called "${title}"`, (d) => pane(d)?.sections?.some((s) => s.rows.some((r) => r.title === title)));
  await this.app.do({ cmd: 'highlight', open: title });
});

When('I open {string} in the thread\'s folder in the pane', async function (this: ThreadbearWorld, relative: string) {
  const d = await this.until('the composer to know its folder', (x) => (x.composer as unknown as { cwd?: string }).cwd && x);
  const cwd = (d.composer as unknown as { cwd: string }).cwd.replace(/\/$/, '');
  await this.app.do({ cmd: 'preview', path: `${cwd}/${relative}` });
});

Then('the pane is showing the file {string}', async function (this: ThreadbearWorld, relative: string) {
  await this.until(`the preview line to name ${relative}`, (d) => previewLine(d)?.startsWith('file ') && previewLine(d)?.endsWith(relative));
});

When('I press Back in the pane', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'preview', back: true });
});

Then('the pane shows Highlights', async function (this: ThreadbearWorld) {
  await this.until('Highlights to be showing, with no preview over it', (d) => !previewLine(d) && pane(d)?.section === 'threadbear.highlights');
});

Then('the pane shows a {string} page with the words {string}', async function (this: ThreadbearWorld, kind: string, words: string) {
  await this.until(`a ${kind} preview with "${words}"`, (d) => pane(d)?.previewKind === kind && pane(d)?.previewText?.includes(words));
});

Then('the pane\'s page has the words {string}', async function (this: ThreadbearWorld, words: string) {
  await this.until(`the page to have "${words}"`, (d) => pane(d)?.previewText?.includes(words));
});

Then('the pane\'s Markdown menu says {string}', async function (this: ThreadbearWorld, mode: string) {
  await this.until(`the bar's Markdown menu on ${mode}`, (d) => pane(d)?.previewMode === mode);
});

When('I pick {string} from the pane\'s Markdown menu', async function (this: ThreadbearWorld, view: string) {
  await this.until('the bar\'s Markdown menu', (d) => pane(d)?.previewMode);
  await this.app.do({ cmd: 'preview', markdownView: view });
});

When('I look for {string} in the pane\'s file', async function (this: ThreadbearWorld, words: string) {
  await this.until('a text file in the pane', (d) => ['markdown', 'code', 'text'].includes(pane(d)?.previewKind ?? '') && pane(d)?.previewText);
  await this.app.do({ cmd: 'preview', find: words });
});

Then('the find bar says {string}', async function (this: ThreadbearWorld, line: string) {
  await this.until(`the find bar to say "${line}"`, (d) => pane(d)?.previewFind === line);
});

When('I find the next match', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'preview', findNext: true });
});

When('I find the match before', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'preview', findPrevious: true });
});

When('I close the find bar', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'preview', findDone: true });
});

Then('the find bar is gone', async function (this: ThreadbearWorld) {
  await this.until('no find bar', (d) => pane(d)?.previewKind && !pane(d)?.previewFind);
});

Then('the pane shows a picture', async function (this: ThreadbearWorld) {
  await this.until('a picture in the pane', (d) => pane(d)?.previewKind === 'picture' && /\d+x\d+/.test(pane(d)?.previewText ?? ''));
});

// Both apps say "video" for the player in the pane, with the film's size
// once its track has said it.
Then('the pane shows a video {int} by {int}', async function (this: ThreadbearWorld, width: number, height: number) {
  await this.until(`a ${width}x${height} video in the pane`, (d) => pane(d)?.previewKind === 'video' && pane(d)?.previewText === `${width}x${height}`);
});

// The GPUI app says "audio" for a sound file in the pane's player.
Then('the pane shows a sound player', async function (this: ThreadbearWorld) {
  await this.until('a sound player in the pane', (d) => pane(d)?.previewKind === 'audio');
});

When('I press play on the sound in the pane', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'preview', play: true });
});

Then('the sound in the pane is playing', async function (this: ThreadbearWorld) {
  await this.until('the sound playing', (d) => (pane(d) as { previewVideo?: { playing?: boolean } } | undefined)?.previewVideo?.playing === true);
});

// The Swift app says "quickLook" for whatever Quick Look draws, so it's that
// there; the GPUI app's PDFKit view says "pdf" and its pages.
Then('the pane shows the PDF', async function (this: ThreadbearWorld) {
  await this.until('a PDF in the pane', (d) => pane(d)?.previewKind === 'quickLook' || (pane(d)?.previewKind === 'pdf' && pane(d)?.previewText === '1 page'));
});

type FilePanelEntry = { id: string; kind: 'file' | 'folder'; path: string; title?: string | null; showing: boolean; floating: boolean; perThread: boolean };
const filePanels = (d: unknown): FilePanelEntry[] => ((d as { filePanels?: FilePanelEntry[] }).filePanels ?? []);

When('I put Highlights in a window of its own', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'float', id: 'threadbear.highlights' });
});

When('I put the open file panel in a window of its own', async function (this: ThreadbearWorld) {
  const panel = await this.until('a showing file panel', (d) => filePanels(d).find((p) => p.kind === 'file' && p.showing));
  await this.app.do({ cmd: 'float', id: panel.id });
});

Then('the file {string} is open as a normal panel beside Highlights', async function (this: ThreadbearWorld, relative: string) {
  await this.until(`the file panel "${relative}" beside Highlights`, (d) => {
    const entry = filePanels(d).find((p) => p.kind === 'file' && p.path.replaceAll('\\', '/').endsWith(relative));
    return Boolean(entry?.showing && entry.perThread && (d.dock ?? '').includes('highlights'));
  });
});

Then('both {string} and {string} are open as normal panels', async function (this: ThreadbearWorld, first: string, second: string) {
  await this.until(`file panels "${first}" and "${second}"`, (d) => {
    const panels = filePanels(d).filter((p) => p.kind === 'file');
    return panels.some((p) => p.path.replaceAll('\\', '/').endsWith(first)) && panels.some((p) => p.path.replaceAll('\\', '/').endsWith(second));
  });
});

Then('the folder {string} is open as a normal panel beside Highlights', async function (this: ThreadbearWorld, relative: string) {
  await this.until(`the folder panel "${relative}" beside Highlights`, (d) => {
    const entry = filePanels(d).find((p) => p.kind === 'folder' && p.path.replaceAll('\\', '/').endsWith(relative));
    return Boolean(entry?.showing && entry.perThread && (d.dock ?? '').includes('highlights'));
  });
});

Then('no file or folder panel is open', async function (this: ThreadbearWorld) {
  await this.until('no file or folder panels in the dock', (d) => filePanels(d).length === 0);
});

When('I move the file panel {string} to the bottom of the window', async function (this: ThreadbearWorld, relative: string) {
  const panel = await this.until(`file panel "${relative}"`, (d) => filePanels(d).find((p) => p.kind === 'file' && p.path.replaceAll('\\', '/').endsWith(relative)));
  await this.app.do({ cmd: 'dock-move', panel: panel.id, edge: 'bottom' });
});

Then('the file panel {string} stays open across threads', async function (this: ThreadbearWorld, relative: string) {
  await this.until(`the moved file panel "${relative}" still showing`, (d) => {
    const entry = filePanels(d).find((p) => p.kind === 'file' && p.path.replaceAll('\\', '/').endsWith(relative));
    return Boolean(entry?.showing && !entry.perThread);
  });
});

// The GPUI app's list of the system's views it has up, in any window.
Then('no video or PDF view is up', async function (this: ThreadbearWorld) {
  await this.until('no video or PDF view up', (d) => Array.isArray((d as unknown as { media?: unknown[] }).media) && (d as unknown as { media: unknown[] }).media.length === 0);
  // And it stays that way: the floating window doesn't make one of its own.
  await new Promise((done) => setTimeout(done, 1000));
  const d = await this.app.dump();
  assert.deepEqual((d as unknown as { media: unknown[] }).media, []);
});

When('I click the link in the PDF in the pane', async function (this: ThreadbearWorld) {
  await this.until('a PDF in the pane', (d) => pane(d)?.previewKind === 'pdf' && pane(d)?.previewText === '1 page');
  // Placed and shown first, as a click lands only on a view that's there.
  await new Promise((done) => setTimeout(done, 500));
  await this.app.do({ cmd: 'preview', clickLink: true });
});

// What the app would have handed the system: a scripted app opens nothing
// for real (`opened`), so a link that went round the gate never shows here.
Then('{string} was opened through the app', async function (this: ThreadbearWorld, url: string) {
  const seen: string[] = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    seen.push(...(JSON.parse(okValue(await this.app.do({ cmd: 'opened' }))) as string[]));
    if (seen.includes(url)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(`it wasn't opened through the app; what was: ${JSON.stringify(seen)}`);
});

When('I copy the picture in the pane', async function (this: ThreadbearWorld) {
  this.lastAnswer = await this.app.do({ cmd: 'preview', copyImage: true });
});

Then('it was copied as a picture', function (this: ThreadbearWorld) {
  assert.match(this.lastAnswer ?? '', /copied (png|public\.png)/);
});

// A local page in the pane (file.htmlpreview, file.runthem): the bar's words
// are the dump's `previewNote`, and the page's own title, which the mock's
// page sets from what its script could fetch, is in `webPanels.pages`.
Then("the pane's page says {string}", async function (this: ThreadbearWorld, words: string) {
  await this.until(`the bar over the page to say "${words}"`, (d) => pane(d)?.previewNote === words);
});

type LocalPage = { key: string; title: string; hidden: boolean; loading: boolean };
const localPages = (d: unknown) => ((d as { webPanels?: { pages?: LocalPage[] } }).webPanels?.pages ?? []).filter((p) => p.key.startsWith('preview:'));

Then('the local page in the pane is titled {string}', { timeout: 120_000 }, async function (this: ThreadbearWorld, title: string) {
  try {
    await this.until(`a local page on show titled "${title}"`, (d) => localPages(d).some((p) => !p.hidden && !p.loading && p.title === title), 90_000);
  } catch (e) {
    // What the pool and the pane had, to say why.
    const d = await this.app.dump();
    throw new Error(`${(e as Error).message}\nwebRuntime: ${JSON.stringify((d as { webRuntime?: unknown }).webRuntime)}\nwebPanels: ${JSON.stringify((d as { webPanels?: unknown }).webPanels)}\npane: ${JSON.stringify(pane(d))}`);
  }
});

When('I press Run them over the page in the pane', async function (this: ThreadbearWorld) {
  await this.until('the bar asking to run its scripts', (d) => pane(d)?.previewNote === 'This page has scripts');
  await this.app.do({ cmd: 'preview', runScripts: true });
});

When('the owner runner can publish HTML', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'artifacts', params: {} });
});

When('I choose to {word} the preview', async function (this: ThreadbearWorld, artifact: string) {
  await this.until('the Publish controls', (d) => pane(d)?.artifactReady === true);
  await this.app.do({ cmd: 'preview', artifact });
});

Then('the preview has a {word} link', async function (this: ThreadbearWorld, visibility: string) {
  await this.until(
    `the preview to show its ${visibility} link`,
    (d) => pane(d)?.artifactUrl === 'https://example.test/a/mock-artifact' && pane(d)?.artifactVisibility === visibility,
  );
});

Then('the preview has no web link', async function (this: ThreadbearWorld) {
  await this.until('the preview to have no web link', (d) => pane(d)?.artifactReady === true && pane(d)?.artifactUrl === null);
});

// A note in place of the file (one that only opens in its app, or one waiting
// for the runner), as against the bar over a file (`the pane says`). On
// Windows the app reads this Mac's own files itself, not through the runner
// (desktop/gpui/src/main.rs `call`), so nothing waits there.
Then('the pane\'s note reads {string} on a Mac or Linux', async function (this: ThreadbearWorld, words: string) {
  if (process.platform === 'win32') return;
  await this.until(`the pane's note to read "${words}"`, (d) => pane(d)?.previewKind === 'note' && pane(d)?.previewText === words);
});
