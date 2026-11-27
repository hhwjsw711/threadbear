import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';
import { pane } from '../support/pane.ts';
import type { Dump } from '../support/driver.ts';

// A PR open as a dock panel (`prPanels` in the GPUI app's dump).
type PrDump = { url: string; tab?: string | null; busy?: string | null; error?: string | null; pr: { title: string; state: string; status: string; checks: string; failed?: string | null; files: string[]; filesLater?: boolean; activity: string[] } | string };
type PrPanelEntry = { id: string; url: string; title?: string | null; tip?: string | null; showing: boolean; floating: boolean; perThread: boolean; pr: PrDump };
const prPanels = (d: Dump): PrPanelEntry[] => ((d as unknown as { prPanels?: PrPanelEntry[] }).prPanels ?? []);
const pr = (d: Dump): PrDump | undefined => prPanels(d).find((p) => p.showing)?.pr;
const loaded = (d: Dump) => {
  const p = pr(d)?.pr;
  return typeof p === 'object' ? p : undefined;
};

// Followed as a click on it in a reply would be (both apps' `link`).
When('I follow the PR link {string} in the thread', async function (this: ThreadbearWorld, url: string) {
  const row = await this.until('a reply from the agent', (d) => [...d.transcript.rows].reverse().find((r) => r.kind === 'assistant'));
  await this.app.do({ cmd: 'link', row: row.id, url });
});

Then('the pane shows the PR {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`the PR "${title}" in the pane`, (d) => loaded(d)?.title === title);
});

Then("the PR's status reads {string}", async function (this: ThreadbearWorld, words: string) {
  await this.until(`the PR's status "${words}"`, (d) => loaded(d)?.status === words);
});

Then("the PR's checks read {string} with {string}", async function (this: ThreadbearWorld, words: string, failed: string) {
  await this.until(`the PR's checks "${words}"`, (d) => loaded(d)?.checks === words && loaded(d)?.failed === failed);
});

Then("the PR's activity includes {string}", async function (this: ThreadbearWorld, words: string) {
  await this.until(`"${words}" in the PR's activity`, (d) => Boolean(loaded(d)?.activity.includes(words)));
});

When('I press {string} in the PR tab', async function (this: ThreadbearWorld, tab: string) {
  await this.until('the PR read', (d) => Boolean(loaded(d)));
  await this.app.do({ cmd: 'click', tip: tab });
});

Then('the PR tab is on {string}', async function (this: ThreadbearWorld, tab: string) {
  await this.until(`the PR tab on ${tab}`, (d) => pr(d)?.tab === tab);
});

Then('the PR lists the file {string}', async function (this: ThreadbearWorld, path: string) {
  await this.until(`"${path}" in the PR`, (d) => Boolean(loaded(d)?.files.includes(path)));
});

When("I press the PR's button {string}", async function (this: ThreadbearWorld, tip: string) {
  await this.until('the PR read', (d) => Boolean(loaded(d)));
  await this.app.do({ cmd: 'click', tip });
});

Then("the PR's button {string} is busy", async function (this: ThreadbearWorld, key: string) {
  await this.until(`${key} spinning`, (d) => pr(d)?.busy === key);
});

// A PR link in a reply has a mark before it in its state's colour; the
// dump has each as "<url>: <state>" (`prMarks`).
type MarkedRow = { kind: string; id: string; prMarks?: string[]; prsRead?: string[] };
async function streamPrReply(world: ThreadbearWorld, url: string, hold: boolean) {
  const d = await world.app.dump();
  await world.app.do({ cmd: 'mock', method: 'stream', params: { threadId: d.selection?.id, text: `It's [#72](${url}) for now.`, hz: 60, hold } });
  await world.until('the reply with its PR link', (dump) => [...dump.transcript.rows].reverse().some((r) => (r as unknown as MarkedRow).prMarks?.some((m) => m.startsWith(`${url}:`))));
}

When('a reply linking the PR {string} streams in', async function (this: ThreadbearWorld, url: string) {
  await streamPrReply(this, url, false);
});

// The mock's `hold`: the reply's in, and its turn keeps working, so nothing
// reads its PRs ahead until something else does (a rest, the thread showing).
When('a reply linking the PR {string} streams in, its turn still going', async function (this: ThreadbearWorld, url: string) {
  await streamPrReply(this, url, true);
});

Then('the mark before the PR {string} says {string}', async function (this: ThreadbearWorld, url: string, state: string) {
  await this.until(`the mark "${url}: ${state}"`, (d) => [...d.transcript.rows].some((r) => (r as unknown as MarkedRow).prMarks?.includes(`${url}: ${state}`)));
});

// Resting the pointer on a link (both apps' `peek`) reads a PR link's PR
// ahead of the click; the dump has each one read or being read in the
// reply's `prsRead`.
When("I rest the pointer on the reply's link {string}", async function (this: ThreadbearWorld, words: string) {
  const row = await this.until('a reply from the agent', (d) => [...d.transcript.rows].reverse().find((r) => r.kind === 'assistant'));
  await this.app.do({ cmd: 'peek', row: row.id, words });
});

Then('the PR {string} is being read', async function (this: ThreadbearWorld, url: string) {
  await this.until(`"${url}" read ahead`, (d) => [...d.transcript.rows].some((r) => (r as unknown as MarkedRow).prsRead?.includes(url)));
});

Then("the PR {string} isn't read yet", async function (this: ThreadbearWorld, url: string) {
  // Long enough for a read started by the reply ending to show.
  await new Promise((done) => setTimeout(done, 1000));
  const d = await this.app.dump();
  const read = [...d.transcript.rows].some((r) => (r as unknown as MarkedRow).prsRead?.includes(url));
  if (read) throw new Error(`"${url}" was read before anything asked for it`);
});

// The mock's PR files come 3 s after the rest (@slow-pr-files).
Then("the PR's changes are still being read", async function (this: ThreadbearWorld) {
  await this.until('the PR read without its files', (d) => loaded(d)?.filesLater === true && loaded(d)?.files.length === 0);
});

Then('the PR {string} is open as a normal panel beside Highlights', async function (this: ThreadbearWorld, url: string) {
  await this.until(`the PR panel for "${url}" beside Highlights`, (d) => {
    const entry = prPanels(d).find((p) => p.url === url);
    const highlightsPreview = pane(d)?.previewKind;
    return Boolean(entry?.showing && entry.perThread && highlightsPreview !== 'pr' && (d.dock ?? '').includes(`pr:${url}`));
  });
});

Then('no PR panel is open', async function (this: ThreadbearWorld) {
  await this.until('no PR panels in the dock', (d) => prPanels(d).length === 0);
});

When('I move the PR panel {string} to the bottom of the window', async function (this: ThreadbearWorld, url: string) {
  await this.app.do({ cmd: 'dock-move', panel: `threadbear.pr:${url}`, edge: 'bottom' });
});

Then('the PR panel {string} stays open across threads', async function (this: ThreadbearWorld, url: string) {
  await this.until(`the moved PR panel "${url}" still showing`, (d) => {
    const entry = prPanels(d).find((p) => p.url === url);
    return Boolean(entry?.showing && !entry.perThread);
  });
});

Then('the open menu offers {string}', async function (this: ThreadbearWorld, item: string) {
  await this.until(`open menu offering "${item}"`, async () => {
    const raw = await this.app.do({ cmd: 'context-menus' });
    const menus = JSON.parse(raw.replace(/^ok\s*/, '')) as string[][];
    return menus.some((items) => items.includes(item));
  });
});
