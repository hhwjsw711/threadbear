// Settings › Pools (features/settings-pools.feature). The section's list is
// the pool rows the window really draws, top to bottom, by name, as the dump
// gives them under `settingsWindow.pools`.
import { Then, When } from '@cucumber/cucumber';
import type { Dump } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

type PoolsSection = { rows: string[] };
const section = (d: Dump) => (d as unknown as { settingsWindow?: { pools?: PoolsSection | null } | null }).settingsWindow?.pools;
const names = (words: string) => words.split(',').map((w) => w.trim());
const listed = (d: Dump) => section(d)?.rows ?? [];

Then('Settings lists the pools {string}', async function (this: ThreadbearWorld, words: string) {
  const want = names(words);
  await this.until(`Settings listing the pools ${want.join(', ')}`, (d) => JSON.stringify(listed(d)) === JSON.stringify(want)).catch(async (e) => {
    // What failed, why it matters, and what has to become true.
    throw new Error(
      `${(e as Error).message.split('\n')[0]}: it lists ${listed(await this.app.dump()).join(', ') || 'no pools'}. ` +
        'The order of the pools is the order Mike put them in, and Settings is where he reads it back. ' +
        "Settings › Pools has to draw its rows in the saved order, and a pool dropped on another's row has to take that place.",
    );
  });
});

const rowsReady = (world: ThreadbearWorld, ...wanted: string[]) =>
  world.until(`the ${wanted.join(' and ')} pool rows in Settings`, (d) => wanted.every((name) => listed(d).includes(name)));

When('I drag the {string} pool onto {string} in Settings', async function (this: ThreadbearWorld, name: string, onto: string) {
  await rowsReady(this, name, onto);
  await this.app.do({ cmd: 'settings', dragPool: name, onto });
});

// Picked up, carried over another row, brought back to its own and let go
// there, so the window sees a drag and not a click where it started.
When('I drag the {string} pool over {string} and back onto its own row in Settings', async function (this: ThreadbearWorld, name: string, past: string) {
  await rowsReady(this, name, past);
  await this.app.do({ cmd: 'settings', dragPool: name, past });
});

// Carried below the last row and let go over no pool's row at all.
When('I drag the {string} pool clear of every row and let go in Settings', async function (this: ThreadbearWorld, name: string) {
  await rowsReady(this, name);
  await this.app.do({ cmd: 'settings', dragPool: name, offRows: true });
});

When('I close the Settings window', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'settings', close: true });
  await this.until('the Settings window gone', (d) => (d as unknown as { settingsWindow?: unknown }).settingsWindow == null);
});
