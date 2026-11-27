import { Given, Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { sleep } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

// A chip's menu as text lines: `composer-menu` gives the same list on both
// apps, the Swift one after "ok ".
type WithBusy = { busy?: string[] };

// A login, pool or folder change spins its chip and hides its popover until
// the runner answers, so a real click can't open or pick from it until then.
async function waitUntilChipReady(world: ThreadbearWorld, chip: string): Promise<void> {
  await world.until(`the ${chip} chip ready`, (d) => !((d.composer as WithBusy).busy ?? []).includes(chip));
}

async function menuLines(world: ThreadbearWorld, menu: string): Promise<string[]> {
  const out = await world.app.do({ cmd: 'composer-menu', menu });
  return JSON.parse(out.slice(out.indexOf('['))) as string[];
}

Then('the {string} menu shows {string} ticked', async function (this: ThreadbearWorld, menu: string, title: string) {
  let lines: string[] = [];
  for (let tries = 0; tries < 40; tries += 1) {
    lines = await menuLines(this, menu);
    if (lines.find((l) => l.includes(title))?.startsWith('[x] ')) return;
    await sleep(150);
  }
  assert.fail(`the ${menu} menu has no ticked "${title}":\n${lines.join('\n')}`);
});

Then('the {string} menu has a row {string}', async function (this: ThreadbearWorld, menu: string, row: string) {
  let lines: string[] = [];
  for (let tries = 0; tries < 40; tries += 1) {
    lines = await menuLines(this, menu);
    if (lines.some((l) => l.startsWith(row))) return;
    await sleep(150);
  }
  assert.fail(`no row "${row}" in the ${menu} menu:\n${lines.join('\n')}`);
});

// Once a pick has landed, which takes a moment.
Then('the {string} menu has no row {string}', async function (this: ThreadbearWorld, menu: string, row: string) {
  let lines: string[] = [];
  for (let tries = 0; tries < 40; tries += 1) {
    lines = await menuLines(this, menu);
    if (!lines.some((l) => l.startsWith(row))) return;
    await sleep(150);
  }
  assert.fail(`the ${menu} menu still has "${row}":\n${lines.join('\n')}`);
});

// A login's line in a login list, with what follows its usage (a usage
// reset worth using: "[2 resets left: Use a reset]"). Waits, as the list
// follows the runner's accounts.updated.
for (const [step, want] of [
  ['the {string} menu has a line ending {string}', true],
  ['the {string} menu has no line ending {string}', false],
] as const) {
  Then(step, async function (this: ThreadbearWorld, menu: string, end: string) {
    let lines: string[] = [];
    for (let tries = 0; tries < 40; tries += 1) {
      lines = await menuLines(this, menu);
      if (lines.some((l) => l.endsWith(end)) === want) return;
      await sleep(150);
    }
    assert.fail(`the ${menu} menu ${want ? 'has no' : 'still has a'} line ending "${end}":\n${lines.join('\n')}`);
  });
}

// The model chip clicked, as a person does, which opens its popover.
When('I open the model picker', async function (this: ThreadbearWorld) {
  await waitUntilChipReady(this, 'model');
  await this.app.do({ cmd: 'composer-menu', menu: 'model', show: true });
});

When('I search the model picker for {string} and press Return', async function (this: ThreadbearWorld, words: string) {
  await this.app.do({ cmd: 'composer-menu', menu: 'model', search: words });
});

When('I click {string} in the model picker', async function (this: ThreadbearWorld, title: string) {
  await this.app.do({ cmd: 'click', title });
});

When('I pick {string} from the {string} menu', async function (this: ThreadbearWorld, title: string, menu: string) {
  const chip = menu === '+' ? 'plus' : menu;
  if (chip === 'model' || chip === 'account' || chip === 'plus') {
    await waitUntilChipReady(this, chip);
  }
  await this.app.do({ cmd: 'composer-menu', menu, click: title });
});

// Adds unpooled Claude (two logins, different room) and Codex logins without
// touching the demo pools, so the "No pool" tab appears in the model picker.
Given('the runner also has logins outside any pool', async function (this: ThreadbearWorld) {
  const out = await this.app.do({ cmd: 'mock', method: 'accounts', params: {} });
  type MockAccount = { id: string; provider: string; defaultModel?: string; models?: unknown[] };
  const { accounts } = JSON.parse(out.slice(out.indexOf('{'))) as { accounts: MockAccount[] };
  const claude = accounts.find((a) => a.provider === 'claude');
  const codex = accounts.find((a) => a.provider === 'codex');
  assert.ok(claude && codex, 'expected demo Claude and Codex accounts');
  const readAt = new Date().toISOString();
  const extra = [
    {
      id: 'claude-solo-low', provider: 'claude', title: 'solo-low@example.com', email: 'solo-low@example.com',
      configDir: '~/.claude-solo-low', defaultModel: claude.defaultModel, models: claude.models,
      usage: { readAt, source: 'live', windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 15 }] },
    },
    {
      id: 'claude-solo-high', provider: 'claude', title: 'solo-high@example.com', email: 'solo-high@example.com',
      configDir: '~/.claude-solo-high', defaultModel: claude.defaultModel, models: claude.models,
      usage: { readAt, source: 'live', windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 88 }] },
    },
    {
      id: 'codex-solo', provider: 'codex', title: 'Codex · solo-codex@example.com', email: 'solo-codex@example.com',
      configDir: '~/.codex-solo', defaultModel: codex.defaultModel, models: codex.models,
      usage: { readAt, source: 'live', windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 52 }] },
    },
  ];
  await this.app.do({ cmd: 'mock', method: 'accounts', params: { accounts: [...accounts, ...extra] } });
  let lines: string[] = [];
  for (let tries = 0; tries < 40; tries += 1) {
    lines = await menuLines(this, 'model');
    if (lines.some((l) => l.startsWith('# [ ] No pool'))) return;
    await sleep(150);
  }
  assert.fail(`No pool tab didn't appear:\n${lines.join('\n')}`);
});

Given('the runner also has a Gemini login and an OpenCode login', async function (this: ThreadbearWorld) {
  const out = await this.app.do({ cmd: 'mock', method: 'accounts', params: {} });
  type MockAccount = { id: string; provider: string };
  const { accounts } = JSON.parse(out.slice(out.indexOf('{'))) as { accounts: MockAccount[] };
  const extra = [
    {
      id: 'antigravity-main',
      provider: 'antigravity',
      title: 'Gemini',
      configDir: '~/.gemini',
      defaultModel: 'gemini-4-neon',
      models: [
        { id: 'gemini-4-neon', model: 'gemini-4-neon', title: 'Gemini 4 Neon', effortLevels: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
        { id: 'gemini-3.8-flash', model: 'gemini-3.8-flash', title: 'Gemini 3.8 Flash', effortLevels: ['low', 'medium', 'high'], defaultEffort: 'high' },
      ],
    },
    {
      id: 'opencode-main',
      provider: 'opencode',
      title: 'OpenCode',
      configDir: '~/.config/opencode',
      models: [
        { id: 'opencode/gpt-6-astra', model: 'opencode/gpt-6-astra', title: 'GPT-6 Astra', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'opencode/big-pickle', model: 'opencode/big-pickle', title: 'Big Pickle' },
      ],
    },
  ];
  await this.app.do({ cmd: 'mock', method: 'accounts', params: { accounts: [...accounts, ...extra] } });
  let lines: string[] = [];
  for (let tries = 0; tries < 40; tries += 1) {
    lines = await menuLines(this, 'model');
    if (lines.some((l) => l.startsWith('# [ ] No pool'))) return;
    await sleep(150);
  }
  assert.fail(`No pool tab didn't appear:\n${lines.join('\n')}`);
});

Then('the composer\'s permission mode is {string}', async function (this: ThreadbearWorld, mode: string) {
  await this.until(`permission mode ${mode}`, (d) => (d.composer as { mode?: string }).mode === mode);
});

Then('the model chip says {string}', async function (this: ThreadbearWorld, chip: string) {
  await this.until(`the model chip saying "${chip}"`, (d) => (d.composer as { chip?: string }).chip === chip);
});

Then('the {string} menu says {string} and {string}', async function (this: ThreadbearWorld, menu: string, first: string, second: string) {
  const lines = await menuLines(this, menu);
  assert.deepEqual(lines.slice(0, 2), [first, second]);
});

// Send's right-click menu, through a real right-click on it in both apps.
async function sendMenu(world: ThreadbearWorld): Promise<string[]> {
  const out = await world.app.do({ cmd: 'composer-menu', menu: 'send' });
  return JSON.parse(out.slice(out.indexOf('['))) as string[];
}

// Among the rest: the quick times above Schedule… change with the clock
// (tonight's is gone after 9 pm) and the logins' resets.
Then('right-clicking Send offers {string}', async function (this: ThreadbearWorld, items: string) {
  const offered = await sendMenu(this);
  for (const item of items.split(' | ')) assert.ok(offered.includes(item), `no ${item} in ${offered.join(', ')}`);
});

// With nothing of its own, the right-click is the panel's (Hide Title and
// the like), in both apps.
Then('right-clicking Send doesn\'t offer {string}', async function (this: ThreadbearWorld, item: string) {
  const items = await sendMenu(this);
  assert.ok(!items.includes(item), `it offers ${item}: ${items.join(', ')}`);
});

When('I right-click Send and choose {string}', async function (this: ThreadbearWorld, item: string) {
  await this.app.do({ cmd: 'composer-menu', menu: 'send', click: item });
});

Then('the schedule editor is open on a new schedule that sends {string}', async function (this: ThreadbearWorld, text: string) {
  type Editor = { isNew: boolean; text: string };
  const editor = await this.until('the schedule editor', (d) => (d as unknown as { scheduleEditor?: Editor }).scheduleEditor);
  assert.equal(editor.isNew, true, 'it opened on a schedule that exists');
  assert.equal(editor.text, text);
});

When('I open the context ring\'s popover', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'composer-menu', menu: 'context', show: true });
});

// The breakdown comes after the runner answers, a moment after the popover
// opens, so this waits for the line.
Then('the context popover shows {string}', async function (this: ThreadbearWorld, line: string) {
  let lines: string[] = [];
  for (let tries = 0; tries < 40; tries += 1) {
    lines = await menuLines(this, 'context');
    if (lines.includes(line)) return;
    await sleep(150);
  }
  assert.fail(`the context popover has no "${line}":\n${lines.join('\n')}`);
});

// What a click on a picture in the box opened: `ok quicklook <index> of
// [paths]` from both apps' `composer-peek` (the Swift one's Quick Look is
// swapped for a note of what it would show; the GPUI one's viewer is real).
function opened(out: string, number: number, total: number): void {
  const found = /\bok quicklook (\d+) of (\[.*\])$/.exec(out);
  assert.ok(found, `the click said "${out}"`);
  assert.equal(Number(found[1]) + 1, number, `it opened picture ${Number(found[1]) + 1}, not ${number}`);
  assert.equal((JSON.parse(found[2]) as string[]).length, total, `it steps through ${found[2]}`);
}

Then('clicking chip {int} opens picture {int} of {int}', async function (this: ThreadbearWorld, chip: number, number: number, total: number) {
  opened(await this.app.do({ cmd: 'composer-peek', number: chip, press: true }), number, total);
});

Then('clicking the thumbnail of picture {int} opens picture {int} of {int}', async function (this: ThreadbearWorld, picture: number, number: number, total: number) {
  opened(await this.app.do({ cmd: 'composer-peek', strip: picture - 1 }), number, total);
});

// threads.update held a few seconds by the mock (mock.slow holds it with
// threads.send and threads.create).
Given('the runner takes its time to change threads', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'slow', params: { ms: 2500 } });
});

// One of the "+" menu's folders that isn't the thread's ("[ ] ~/dev/x").
When('I pick another folder from the {string} menu', async function (this: ThreadbearWorld & { folder?: string }, _menu: string) {
  await waitUntilChipReady(this, 'plus');
  const lines = await menuLines(this, 'plus');
  const other = lines.find((l) => l.startsWith('[ ] '));
  assert.ok(other, `no other folder in: ${lines.join(' | ')}`);
  this.folder = other.slice(4);
  await this.app.do({ cmd: 'composer-menu', menu: 'plus', click: this.folder });
});

Then('the {string} menu has that folder ticked', async function (this: ThreadbearWorld & { folder?: string }, _menu: string) {
  let lines: string[] = [];
  for (let tries = 0; tries < 40; tries += 1) {
    lines = await menuLines(this, 'plus');
    if (lines.includes(`[x] ${this.folder}`)) return;
    await sleep(150);
  }
  assert.fail(`${this.folder} isn't ticked: ${lines.join(' | ')}`);
});

Then('the composer\'s {string} chip is spinning', async function (this: ThreadbearWorld, chip: string) {
  await this.until(`the ${chip} chip spinning`, (d) => ((d.composer as WithBusy).busy ?? []).includes(chip));
});

Then('soon no chip in the composer is spinning', async function (this: ThreadbearWorld) {
  await this.until('no chip spinning', (d) => ((d.composer as WithBusy).busy ?? []).length === 0, 10_000);
});

When('the window is {int} points wide', async function (this: ThreadbearWorld, width: number) {
  await this.app.do({ cmd: 'resize', w: width, h: 800 });
  // A frame or two for the box to follow the window.
  await sleep(400);
});

Then('the chips under the box fit inside it', async function (this: ThreadbearWorld) {
  await this.until('the chips inside the box', (d) => (d.composer as { chipsFit?: boolean }).chipsFit === true);
});

// The thumbnail's × over the box, clicked through the window.
When('I remove picture {int} with its ×', async function (this: ThreadbearWorld, picture: number) {
  assert.equal(await this.app.do({ cmd: 'composer-peek', strip: picture - 1, remove: true }), 'ok removed');
});

// The quick send times (composer_send.rs). The schedule editor's dump has
// its time as `at`.
type QuickEditor = { once: boolean; at: string; preview?: string };
const quickEditor = (world: ThreadbearWorld) =>
  world.until('the schedule editor', (d) => (d as unknown as { scheduleEditor?: QuickEditor }).scheduleEditor);

Then('the schedule is set to send once, tomorrow at 9 am', async function (this: ThreadbearWorld) {
  const editor = await quickEditor(this);
  assert.equal(editor.once, true, 'it opened on a repeating schedule');
  const at = new Date(editor.at);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  assert.equal(at.toDateString(), tomorrow.toDateString());
  assert.deepEqual([at.getHours(), at.getMinutes()], [9, 0]);
});

When('I choose when tokens reset from Send\'s right-click', async function (this: ThreadbearWorld) {
  const items = await sendMenu(this);
  const item = items.find((title) => title.startsWith('Send when tokens reset ('));
  assert.ok(item && !item.includes('not known'), `no known reset: ${items.join(', ')}`);
  await this.app.do({ cmd: 'composer-menu', menu: 'send', click: item });
});

Then('the schedule is set to send once, a minute after {string}\'s 5-hour window resets', async function (this: ThreadbearWorld, account: string) {
  const out = await this.app.do({ cmd: 'mock', method: 'accounts', params: {} });
  type Window = { kind: string; resetsAt: string };
  const { accounts } = JSON.parse(out.slice(out.indexOf('{'))) as { accounts: { id: string; usage: { windows: Window[] } }[] };
  const reset = accounts.find((a) => a.id === account)?.usage.windows.find((w) => w.kind === 'five_hour')?.resetsAt;
  assert.ok(reset, `${account} has no 5-hour reset`);
  const editor = await quickEditor(this);
  assert.equal(editor.once, true, 'it opened on a repeating schedule');
  assert.equal(Date.parse(editor.at), Date.parse(reset) + 60_000);
});

When('I open the Send later menu beside Send', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', title: 'Send later' });
});

Then('the Send later menu offers {string} and a time for when tokens reset', async function (this: ThreadbearWorld, item: string) {
  const out = await this.app.do({ cmd: 'context-menus' });
  assert.ok(out.includes(item), out);
  assert.match(out, /Send when tokens reset \((?!time not known)/);
});

When('I save the schedule in the editor', async function (this: ThreadbearWorld) {
  await this.until('the schedule ready to save', (d) => Boolean((d as unknown as { scheduleEditor?: QuickEditor }).scheduleEditor?.preview));
  await this.app.do({ cmd: 'click', title: 'Schedule' });
  await this.until('the schedule saved', (d) => !(d as unknown as { scheduleEditor?: unknown }).scheduleEditor && d.composer.text === '');
});
