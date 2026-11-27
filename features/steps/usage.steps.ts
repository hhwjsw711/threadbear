// The Usage panel and the activity bar's honey pot (features/usage.feature).
// Both apps' dumps say what each part of the panel draws, under `usage`
// (app/README.md, the `usage` command).
import { Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import type { Dump } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

type Login = { name: string; reset?: { line: string; button?: string; tip: string; expiring: boolean; busy: boolean } | null; open?: boolean; provider?: string | null; status?: string | null; logo?: string; line?: string | null; ring?: number | null; why?: string | null; signInEnds?: string | null; yearToken?: string | null; tokenButton?: boolean; findWork?: boolean; findingWork?: boolean; meters: { title: string; left: string; verdict?: string | null }[]; more: string[] };
type Usage = {
  shown: boolean;
  pools?: { id: string; backup?: Record<string, boolean> }[];
  icon: { percent: number; login?: string | null; tip: string; dot?: boolean };
  tiles: { title: string; value: string; detail?: string | null }[];
  chart?: { title: string; range: string; key: string[]; empty?: string | null } | null;
  cards: { title: string; today?: string | null; logins: Login[] }[];
  settings?: { switch: string; on: boolean } | null;
};

const usage = (d: Dump) => (d as unknown as { usage?: Usage }).usage;
const login = (d: Dump, card: string, name: string) => usage(d)?.cards.find((c) => c.title === card)?.logins.find((l) => l.name === name);
const list = (words: string) => words.split(',').map((w) => w.trim());

/** A mock call's answer, past whatever the app puts before it ("ok", or nothing). */
const answer = (out: string) => JSON.parse(out.slice(out.indexOf('{')));

When('I scroll to settings in Usage', async function (this: ThreadbearWorld) {
  await this.until('Usage has loaded its spend chart', (d) => Boolean(usage(d)?.chart?.title));
  await this.app.do({ cmd: 'usage', scrollToSettings: true });
  await this.app.dump();
});

When('I click the honey pot in the activity bar', async function (this: ThreadbearWorld) {
  // Its tooltip is "Usage", then a line for each pool once the logins have
  // come with the runner's hello.
  await this.until('the honey pot saying each pool\'s room', (d) => usage(d)?.icon.tip.includes('\n'));
  await this.app.do({ cmd: 'click', tipPrefix: 'Usage\n' });
});

// "the Usage panel is open" is _common's `the {word} panel is open`, which
// reads the dump's `usage.shown` as it does the other panels'.

Then("the Usage panel's tiles are {string}, each with a number", async function (this: ThreadbearWorld, titles: string) {
  // The numbers come with `usage.stats`, which the panel asks for as it opens.
  const tiles = await this.until('the Usage panel\'s tiles', (d) => (usage(d)?.tiles.length ? usage(d)?.tiles : undefined));
  assert.deepEqual(tiles.map((t) => t.title), list(titles));
  for (const t of tiles) assert.match(t.value, /^\d+(\.\d)?[kMB]?$/, `${t.title} says ${t.value}`);
});

Then('the Usage chart is {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`the Usage chart "${title}"`, (d) => usage(d)?.chart?.title === title);
});

When('I show the last 7 days on the Usage chart', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'usage', range: 'week' });
});

Then("the Usage chart's key names {string}", async function (this: ThreadbearWorld, names: string) {
  const key = await this.until('the Usage chart\'s key', (d) => usage(d)?.chart?.key);
  assert.deepEqual(key, list(names));
});

Then('the Usage panel has a card for each pool: {string}', async function (this: ThreadbearWorld, titles: string) {
  const cards = await this.until('the Usage panel\'s cards', (d) => (usage(d)?.cards.length ? usage(d)?.cards : undefined));
  assert.deepEqual(cards.map((c) => c.title), list(titles));
});

Then('in the {string} card, {string} has {string}', async function (this: ThreadbearWorld, card: string, name: string, meters: string) {
  const want = list(meters).join(', ');
  const got = (d: Dump) => login(d, card, name)?.meters.map((m) => `${m.title} ${m.left}`).join(', ');
  await this.until(`${name} in ${card} with ${want}`, (d) => got(d) === want).catch(async (e) => {
    throw new Error(`${(e as Error).message.split('\n')[0]}: it has ${got(await this.app.dump()) ?? 'no row there'}`);
  });
});

Then('in the {string} card, {string} says {string}', async function (this: ThreadbearWorld, card: string, name: string, status: string) {
  await this.until(`${name} in ${card} saying ${status}`, (d) => login(d, card, name)?.status === status);
});

Then('in the {string} card, {string} has the {string} logo and a ring at {int}%', async function (this: ThreadbearWorld, card: string, name: string, logo: string, ring: number) {
  await this.until(`${name} in ${card} with the ${logo} logo and ${ring}%`, (d) => login(d, card, name)?.logo === logo && login(d, card, name)?.ring === ring);
});

Then('in the {string} card, {string} has the {string} logo and no ring', async function (this: ThreadbearWorld, card: string, name: string, logo: string) {
  await this.until(`${name} in ${card} with the ${logo} logo and no ring`, (d) => login(d, card, name)?.logo === logo && login(d, card, name)?.ring == null);
});

Then("in the {string} card, {string}'s line starts {string}", async function (this: ThreadbearWorld, card: string, name: string, start: string) {
  await this.until(`${name}'s line in ${card} starting "${start}"`, (d) => Boolean(login(d, card, name)?.line?.startsWith(start)));
});

Then('in the {string} card, {string} says why: {string}', async function (this: ThreadbearWorld, card: string, name: string, why: string) {
  await this.until(`${name} in ${card} saying ${why}`, (d) => login(d, card, name)?.why === why);
});

/** A Grok login with no usage, as the runner lists one it can't read a limit for. */
When('a Grok login with no reading is added', async function (this: ThreadbearWorld) {
  const { accounts } = answer(await this.app.do({ cmd: 'mock', method: 'accounts', params: {} })) as { accounts: object[] };
  await this.app.do({ cmd: 'mock', method: 'accounts', params: { accounts: [...accounts, { id: 'grok-main', provider: 'grok', title: 'Grok', configDir: '~/.grok', models: [] }] } });
});

Then("the {string} card names each login's provider: {string}", async function (this: ThreadbearWorld, card: string, logins: string) {
  const got = await this.until(`the ${card} card`, (d) => usage(d)?.cards.find((c) => c.title === card)?.logins);
  assert.deepEqual(got.map((l) => `${l.provider}: ${l.name}`), list(logins));
});

Then('in the {string} card, {string} offers Find work for it', async function (this: ThreadbearWorld, card: string, name: string) {
  await this.until(`Find work for it on ${name}`, (d) => login(d, card, name)?.findWork === true);
});

Then("in the {string} card, {string} doesn't offer Find work for it", async function (this: ThreadbearWorld, card: string, name: string) {
  await this.until(`no Find work for it on ${name}`, (d) => login(d, card, name)?.findWork === false);
});

When('I press Find work for it on {string}', async function (this: ThreadbearWorld, account: string) {
  await this.app.do({ cmd: 'usage', findWork: account });
});

Then('the honey pot is {int}% full, for {string}', async function (this: ThreadbearWorld, percent: number, account: string) {
  await this.until(`the honey pot ${percent}% full for ${account}`, (d) => usage(d)?.icon.percent === percent && usage(d)?.icon.login === account);
});

Then("the honey pot's tooltip says {string}", async function (this: ThreadbearWorld, line: string) {
  await this.until(`"${line}" in the honey pot's tooltip`, (d) => usage(d)?.icon.tip.split('\n').includes(line));
});

/** Sets what's left of a login's week on the mock, which tells the app as the runner does (`accounts.updated`). */
async function setWeek(world: ThreadbearWorld, account: string, left: number) {
  const { accounts } = answer(await world.app.do({ cmd: 'mock', method: 'accounts', params: {} })) as { accounts: { id: string; usage?: { windows: { kind: string; remainingPercent: number }[] } }[] };
  const windows = accounts.find((a) => a.id === account)?.usage?.windows;
  const week = windows?.find((w) => w.kind === 'weekly');
  assert.ok(week, `${account} has no week on the mock`);
  week.remainingPercent = left;
  await world.app.do({ cmd: 'mock', method: 'accounts', params: { accounts } });
}

When('{string} is down to {int}% of its week', async function (this: ThreadbearWorld, account: string, left: number) {
  await setWeek(this, account, left);
});

When("{string}'s week resets", async function (this: ThreadbearWorld, account: string) {
  await setWeek(this, account, 100);
});

/** Marks a login on the mock as the runner's sign-in check would (docs/protocol/settings.md, Pools, "Signed out"). */
async function setSignIn(world: ThreadbearWorld, account: string, change: { signedOut?: boolean; loginEndsAt?: string; planEnded?: boolean; yearToken?: { madeAt: string } }) {
  const { accounts } = answer(await world.app.do({ cmd: 'mock', method: 'accounts', params: {} })) as { accounts: { id: string; signedOut?: boolean; loginEndsAt?: string }[] };
  const a = accounts.find((x) => x.id === account);
  assert.ok(a, `no ${account} on the mock`);
  Object.assign(a, change);
  await world.app.do({ cmd: 'mock', method: 'accounts', params: { accounts } });
}

When('{string} is signed out', async function (this: ThreadbearWorld, account: string) {
  await setSignIn(this, account, { signedOut: true });
});

When('{string} is signed in again', async function (this: ThreadbearWorld, account: string) {
  await setSignIn(this, account, { signedOut: false });
});

When("{string}'s plan has ended", async function (this: ThreadbearWorld, account: string) {
  await setSignIn(this, account, { planEnded: true });
});

When("{string}'s sign-in ends in {int} hours", async function (this: ThreadbearWorld, account: string, hours: number) {
  await setSignIn(this, account, { loginEndsAt: new Date(Date.now() + hours * 3_600_000).toISOString() });
});

Then('in the {string} card, {string} warns its sign-in ends', async function (this: ThreadbearWorld, card: string, name: string) {
  await this.until(`${name} in ${card} saying its sign-in ends`, (d) => /^Sign-in ends /.test(login(d, card, name)?.signInEnds ?? ''));
});

When('{string} runs on a year-long token made today', async function (this: ThreadbearWorld, account: string) {
  const made = new Date();
  await setSignIn(this, account, { yearToken: { madeAt: made.toISOString() }, loginEndsAt: new Date(made.getTime() + 365 * 86_400_000).toISOString() });
});

Then('in the {string} card, {string} offers a year-long token', async function (this: ThreadbearWorld, card: string, name: string) {
  await this.until(`${name} in ${card} offering a year-long token`, (d) => login(d, card, name)?.tokenButton === true && !login(d, card, name)?.yearToken);
});

Then('in the {string} card, {string} says it has a year-long token', async function (this: ThreadbearWorld, card: string, name: string) {
  await this.until(`${name} in ${card} saying it has a year-long token`, (d) => /^Year-long token until /.test(login(d, card, name)?.yearToken ?? '') && login(d, card, name)?.tokenButton === false);
});

Then('the honey pot has a dot', async function (this: ThreadbearWorld) {
  await this.until('a dot on the honey pot', (d) => usage(d)?.icon.dot === true);
});

Then('the honey pot has no dot', async function (this: ThreadbearWorld) {
  await this.until('no dot on the honey pot', (d) => usage(d)?.icon.dot === false);
});

Then("a line of the honey pot's tooltip starts {string}", async function (this: ThreadbearWorld, start: string) {
  await this.until(`a line starting "${start}" in the honey pot's tooltip`, (d) => !!usage(d)?.icon.tip.split('\n').some((l) => l.startsWith(start)));
});

Then('there is one thread called {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`one "${title}" in the sidebar`, (d) => d.sidebar.sections.flatMap((s) => s.threads).filter((t) => t.title === title).length === 1);
});

When("I click {string}'s row in the Usage panel", async function (this: ThreadbearWorld, account: string) {
  await this.app.do({ cmd: 'usage', open: account });
});

Then('in the {string} card, {string} is open', async function (this: ThreadbearWorld, card: string, name: string) {
  await this.until(`${name} in ${card} open`, (d) => login(d, card, name)?.open === true);
});

Then('in the {string} card, {string} is shut', async function (this: ThreadbearWorld, card: string, name: string) {
  await this.until(`${name} in ${card} shut`, (d) => login(d, card, name)?.open === false);
});

/** A Gemini login with the reading the runner takes from its /usage (agy-usage.ts). */
When("a Gemini login with its plan's usage is added", async function (this: ThreadbearWorld) {
  const { accounts } = answer(await this.app.do({ cmd: 'mock', method: 'accounts', params: {} })) as { accounts: object[] };
  const day = 86_400_000;
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const usage = {
    windows: [
      { kind: 'five_hour', title: '5-hour', remainingPercent: 91, resetsAt: at(3 * 3_600_000) },
      { kind: 'weekly', title: 'Weekly', remainingPercent: 55, resetsAt: at(5 * day) },
      { kind: 'weekly_model', title: 'Weekly Claude and GPT', remainingPercent: 100, resetsAt: at(6 * day) },
      { kind: 'other', title: '5-hour Claude and GPT', remainingPercent: 100, resetsAt: at(4 * 3_600_000) },
    ],
    readAt: new Date().toISOString(),
    source: 'live',
  };
  await this.app.do({ cmd: 'mock', method: 'accounts', params: { accounts: [...accounts, { id: 'antigravity-main', provider: 'antigravity', title: 'Gemini', plan: 'Google AI Ultra', configDir: '~/.gemini/antigravity-acp', models: [], usage }] } });
});

When('a usage thread {string} uses {string} in pool {string}', async function (this: ThreadbearWorld, title: string, accountId: string, poolId: string) {
  await this.app.do({ cmd: 'mock', method: 'thread', params: { id: `usage-${poolId}`, title, accountId, poolId } });
});

Then("the honey pot's first allowance is {string}", async function (this: ThreadbearWorld, line: string) {
  await this.until(`the first allowance is ${line}`, (d) => usage(d)?.icon.tip.split('\n')[1] === line);
});

/**
 * A Codex login's usage resets and the runner's hint to use one
 * (docs/protocol/settings.md, "Telling Mike about resets"). The mock doesn't
 * work the hint out: it's set here as the runner would send it.
 */
async function setResets(world: ThreadbearWorld, account: string, change: (a: Record<string, any>) => void) {
  const { accounts } = answer(await world.app.do({ cmd: 'mock', method: 'accounts', params: {} })) as { accounts: Record<string, any>[] };
  const a = accounts.find((x) => x.id === account);
  assert.ok(a, `no ${account} on the mock`);
  change(a);
  await world.app.do({ cmd: 'mock', method: 'accounts', params: { accounts } });
}

When('{string} is out of room with {int} resets left', async function (this: ThreadbearWorld, account: string, left: number) {
  const expires = new Date(Date.now() + 12 * 86_400_000).toISOString();
  await setResets(this, account, (a) => {
    a.usage = { ...a.usage, blocked: true, windows: a.usage.windows.map((w: any) => (w.kind === 'weekly' ? { ...w, remainingPercent: 0 } : w)), resets: { available: left, nextExpiresAt: expires } };
    a.resetHint = { why: 'out', available: left, nextExpiresAt: expires };
  });
});

When('{string} has a reset expiring in {int} days', async function (this: ThreadbearWorld, account: string, days: number) {
  const expires = new Date(Date.now() + days * 86_400_000).toISOString();
  await setResets(this, account, (a) => {
    a.usage = { ...a.usage, resets: { available: 1, nextExpiresAt: expires } };
    a.resetHint = { why: 'expiring', available: 1, nextExpiresAt: expires };
  });
});

When("{string}'s reset hint goes", async function (this: ThreadbearWorld, account: string) {
  await setResets(this, account, (a) => delete a.resetHint);
});

Then('in the {string} card, {string} offers a reset, saying {string}', async function (this: ThreadbearWorld, card: string, name: string, words: string) {
  await this.until(`${name} in ${card} offering a reset`, (d) => !!login(d, card, name)?.reset?.line.startsWith(words) && /^Restores /.test(login(d, card, name)?.reset?.tip ?? ''));
});

Then('in the {string} card, {string} offers {string}', async function (this: ThreadbearWorld, card: string, name: string, button: string) {
  await this.until(`${name} in ${card} offering ${button}`, (d) => login(d, card, name)?.reset?.button === button);
});

Then('in the {string} card, {string} offers no reset', async function (this: ThreadbearWorld, card: string, name: string) {
  await this.until(`${name} in ${card} offering no reset`, (d) => !!login(d, card, name) && !login(d, card, name)?.reset);
});

When('I use a reset on {string} in the Usage panel', async function (this: ThreadbearWorld, account: string) {
  await this.app.do({ cmd: 'usage', useReset: account });
});


When('I open Claude Usage for {string}', async function (this: ThreadbearWorld, email: string) {
  await this.app.do({ cmd: 'click', tipPrefix: `Opens Claude Usage. Check you're signed in as ${email},` });
});


When('the usage example has three Claude logins, blocked Gemini and backup Grok and OpenCode', async function (this: ThreadbearWorld) {
  const now = Date.now();
  const window = (kind: string, remainingPercent: number, hours: number) => ({ kind, title: kind === 'weekly' ? 'Weekly' : '5-hour', remainingPercent, resetsAt: new Date(now + hours * 3_600_000).toISOString() });
  const account = (id: string, provider: string, title: string, week: number, five?: number) => ({ id, provider, title, configDir: `/tmp/${id}`, models: [], usage: { windows: [...(five === undefined ? [] : [window('five_hour', five, 1)]), window('weekly', week, week === 0 ? 2 : 72)], blocked: week === 0 || five === 0, readAt: new Date(now).toISOString(), source: 'live' } });
  const accounts = [account('claude-main', 'claude', 'Claude 1', 14), account('claude-3', 'claude', 'Claude 2', 0), account('claude-4', 'claude', 'Claude 3', 0), account('gemini-main', 'antigravity', 'Gemini', 24, 0), account('grok-main', 'grok', 'Grok', 87), { id: 'opencode-main', provider: 'opencode', title: 'OpenCode', configDir: '/tmp/opencode', models: [] }];
  await this.app.do({ cmd: 'mock', method: 'accounts', params: { accounts } });
  await this.app.do({ cmd: 'mock', method: 'pools', params: { pools: [{ id: 'main', title: 'Main', accountIds: accounts.map((a) => a.id) }] } });
  await this.app.do({ cmd: 'mock', method: 'thread', params: { id: 'usage-main', title: 'Main allowance', accountId: 'claude-main', poolId: 'main' } });
});

When('I press the backup checkbox for Grok in Main', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', settings: true, tipPrefix: 'Use Grok as a backup in Main.' });
});

Then('Grok in Main is a {word} login', async function (this: ThreadbearWorld, role: string) {
  await this.until(`Grok is ${role}`, (d) => usage(d)?.pools?.find((p) => p.id === 'main')?.backup?.['grok-main'] === (role === 'backup'));
});
