// One app, on its own mock runner, for each scenario.
import { After, Before, setDefaultTimeout, setWorldConstructor, Status, World, type IWorldOptions } from '@cucumber/cucumber';
import fs from 'node:fs';
import path from 'node:path';
import { StandInBrowserBear } from './browserbear.ts';
import { sleep, type Driver, type Dump, type Row, type Thread } from './driver.ts';
import { GpuiDriver } from './gpui.ts';
import { longThreadFolder } from './long-thread.ts';
import { SwiftDriver } from './swift.ts';
import { removeTempFolders, tempFolder } from './temp.ts';
import { webRuntimeCleanup, webRuntimeSetup } from './web-runtime.ts';

// Whatever a person running the specs asked for (features/README.md), kept
// apart from the long-thread scenarios setting it for themselves.
const startingFixtures = process.env.TB_MOCK_FIXTURES;
const startingScriptedTurns = process.env.MOCK_SCRIPTED_TURNS;

setDefaultTimeout(90_000);

export class ThreadbearWorld extends World {
  app: Driver;
  /** Remove a scenario's files only after the app and its shells have ended. */
  /** What the last right-click on a sidebar row offered. */
  menuTitles?: string[];
  /** What the last command answered, for a step to read back. */
  lastAnswer?: string;
  /** The row a swipe under way is on (swipes.steps.ts). */
  swipedRow?: string;
  /** A row's position a scenario wants to compare with later. */
  notedIndex?: number;
  /** A row and its height, a scenario wants to compare with later. */
  notedRow?: { id: string; height: number };
  /** What the last `share` command said. */
  shareResult?: string;
  /** The thread whose page flew to its heading (archive-flight.steps.ts). */
  flownFrom?: string;
  /** The panels' layout (`dock`) just before the last ⌘J, for panel-motion.steps.ts. */
  dockBefore?: string;
  /** A stand-in BrowserBear, for @browserbear scenarios (support/browserbear.ts). */
  bear?: StandInBrowserBear;

  constructor(options: IWorldOptions) {
    super(options);
    this.app = (process.env.TB_APP ?? 'gpui') === 'swift' ? new SwiftDriver() : new GpuiDriver();
  }

  /** Waits until a dump passes `check` (it's slow to land, as everything is). */
  async until<T>(what: string, check: (d: Dump) => T | undefined | false | null | '' | 0, ms = 15_000): Promise<T> {
    const deadline = Date.now() + ms;
    let last: Dump | undefined;
    for (;;) {
      last = await this.app.dump();
      const got = check(last);
      if (got) return got;
      if (Date.now() > deadline) throw new Error(`Never saw: ${what}\n\n${describe(last)}`);
      await sleep(120);
    }
  }

  thread(d: Dump, title: string): Thread | undefined {
    for (const s of d.sidebar.sections) {
      // Or nested under the thread that started it, in its open group.
      const t = s.threads.find((x) => x.title === title) ?? s.threads.flatMap((x) => x.group?.threads ?? []).find((x) => x.title === title);
      if (t) return t;
    }
    return undefined;
  }

  /** Waits for a sidebar row with that title, wherever it is, and opens it. */
  async open(title: string): Promise<Thread> {
    const t = await this.until(`a thread called "${title}"`, (d) => this.thread(d, title));
    await this.app.do({ cmd: 'open', id: t.id });
    await this.until(`"${title}" open with its rows on screen`, (d) => d.selection?.id === t.id && d.transcript.threadId === t.id && d.transcript.state === 'loaded');
    return t;
  }
}

/** A short account of what the app showed, for a failure message. */
export function describe(d: Dump): string {
  const side = d.sidebar.sections.map((s) => `${s.name}${s.collapsed ? ' (folded)' : ''}: ${s.threads.map((t) => t.title).join(' | ') || '(none)'}`).join('\n');
  const rows = d.transcript.rows.map((r: Row) => `  ${r.kind}${r.expanded ? ' (open)' : ''}: ${r.text}`).join('\n');
  return `${d.reduceMotion ? 'Reduce Motion: on\n' : ''}connection: ${d.connection}\nbanner: ${d.banner?.text ?? '(none)'}\n${side}\nopen: ${d.selection?.title ?? '(none)'}, composer: ${JSON.stringify(d.composer.text)}\n${rows}`;
}

setWorldConstructor(ThreadbearWorld);

// The stress run's slow runner (tools/stress.mjs): every scenario's mock
// answers late by these, unless the scenario sets its own below. Defined
// first, so a tagged scenario's own delay wins, and set again each scenario
// since those After hooks delete theirs.
Before(() => {
  for (const [from, to] of [
    ['TB_STRESS_EVENTS_DELAY_MS', 'THREADBEAR_MOCK_EVENTS_DELAY_MS'],
    ['TB_STRESS_LIST_DELAY_MS', 'THREADBEAR_MOCK_LIST_DELAY_MS'],
    ['TB_STRESS_JITTER_MS', 'THREADBEAR_MOCK_JITTER_MS'],
  ]) if (process.env[from]) process.env[to] = process.env[from];
});

// A pin request must survive other pane updates while its highlights arrive.
Before({ tags: '@panel.requests and @highlights.pinned' }, () => {
  process.env.THREADBEAR_MOCK_HIGHLIGHTS_DELAY_MS = '5000';
});
After({ tags: '@panel.requests and @highlights.pinned' }, () => {
  delete process.env.THREADBEAR_MOCK_HIGHLIGHTS_DELAY_MS;
});

// The loading rows only show while the list is on its way, so that scenario's
// mock answers late. Before the app starts, hence above the Before below.
Before({ tags: '@sidebar.skeleton' }, () => {
  process.env.THREADBEAR_MOCK_LIST_DELAY_MS = '9000';
  process.env.TB_DEV_APP_NO_READY = '1';
});
After({ tags: '@sidebar.skeleton' }, () => {
  delete process.env.THREADBEAR_MOCK_LIST_DELAY_MS;
  delete process.env.TB_DEV_APP_NO_READY;
});

// A runner slow to read a thread (switching-threads.feature).
Before({ tags: '@thread.loading or @thread.kept' }, () => {
  process.env.THREADBEAR_MOCK_EVENTS_DELAY_MS = '3000';
});
After({ tags: '@thread.loading or @thread.kept' }, () => {
  delete process.env.THREADBEAR_MOCK_EVENTS_DELAY_MS;
});

// A real mock turn that can be interrupted while its picture is loading.
// Seeded "running" rows have no executing turn for Stop to interrupt.
Before({ tags: '@picture-loading' }, () => {
  const file = path.join(tempFolder('threadbear-picture-turn-'), 'turns.json');
  fs.writeFileSync(file, JSON.stringify([{ match: '^Hold the turn for picture input$', reply: 'Still working. '.repeat(100), chunk: 1, chunkMs: 250 }]));
  process.env.MOCK_SCRIPTED_TURNS = file;
});
After({ tags: '@picture-loading' }, () => {
  if (startingScriptedTurns === undefined) delete process.env.MOCK_SCRIPTED_TURNS;
  else process.env.MOCK_SCRIPTED_TURNS = startingScriptedTurns;
});

// On CI, a line per scenario as it ends: the progress dots never end their
// line, so GitHub's log showed nothing at all for a run that hit its time
// limit (17 Nov), not even which scenario it was on.
let scenarioStarted = 0;
Before(() => {
  scenarioStarted = Date.now();
});
After(({ result, pickle, willBeRetried }) => {
  if (!process.env.CI) return;
  const secs = ((Date.now() - scenarioStarted) / 1000).toFixed(1).padStart(5);
  console.log(`\n${secs}s ${result?.status ?? '?'}${willBeRetried ? ' (will retry)' : ''} ${path.basename(pickle.uri)}: ${pickle.name}`);
});

Before(async function (this: ThreadbearWorld, { pickle }) {
  // A scenario about paging needs a thread longer than one page of events.
  const long = pickle.tags.some((t) => t.name === '@long-thread');
  if (long) process.env.TB_MOCK_FIXTURES = longThreadFolder();
  else if (startingFixtures === undefined) delete process.env.TB_MOCK_FIXTURES;
  // A scenario about other machines needs the mock's mac-mini threads, which
  // both drivers leave out otherwise (TB_MOCK_NO_REMOTE in gpui.ts, swift.ts).
  if (pickle.tags.some((t) => t.name === '@remote-threads')) process.env.TB_MOCK_REMOTE = '1';
  else delete process.env.TB_MOCK_REMOTE;
  // Virtual runners: the mock's "Cloud (Fly)" and a thread on a box of it in
  // each state (MOCK_VIRTUAL_RUNNERS in its server.mjs).
  if (pickle.tags.some((t) => t.name === '@virtual-runners')) process.env.MOCK_VIRTUAL_RUNNERS = '1';
  else delete process.env.MOCK_VIRTUAL_RUNNERS;
  // Nested threads: the mock's coordinator and the threads it started, with
  // the nestedThreads experiment on, or off with @nested-threads-off.
  const nestedOff = pickle.tags.some((t) => t.name === '@nested-threads-off');
  if (nestedOff || pickle.tags.some((t) => t.name === '@nested-threads')) process.env.TB_MOCK_NESTED = '1';
  else delete process.env.TB_MOCK_NESTED;
  if (nestedOff) process.env.TB_MOCK_NESTED_OFF = '1';
  else delete process.env.TB_MOCK_NESTED_OFF;
  // The done card's Archive menu: the inboxGuess experiment on in the hello.
  if (pickle.tags.some((t) => t.name === '@inbox-guess')) process.env.TB_MOCK_INBOX_GUESS = '1';
  else delete process.env.TB_MOCK_INBOX_GUESS;
  // Its files read 3 s after the rest of it, as a big PR's are.
  if (pickle.tags.some((t) => t.name === '@slow-pr-files')) process.env.TB_MOCK_PR_FILES_MS = '3000';
  else delete process.env.TB_MOCK_PR_FILES_MS;
  // The Recipes view: the recipes experiment on, with the mock's recipes.
  if (pickle.tags.some((t) => t.name === '@recipes')) process.env.TB_MOCK_RECIPES = '1';
  else delete process.env.TB_MOCK_RECIPES;
  if (pickle.tags.some((t) => t.name === '@coordinators')) process.env.TB_MOCK_COORDINATORS = '1';
  else delete process.env.TB_MOCK_COORDINATORS;
  // Example annotations only; the review board itself is always on.
  if (pickle.tags.some((t) => t.name === '@review.canvas')) process.env.TB_MOCK_REVIEW_NOTES = '1';
  else delete process.env.TB_MOCK_REVIEW_NOTES;
  // Agent Archive in the sidebar's search: the archive experiment on, with
  // the mock's made-up sessions, and its answers slow with @slow-archive.
  if (pickle.tags.some((t) => t.name === '@archive')) process.env.TB_MOCK_ARCHIVE = '1';
  else delete process.env.TB_MOCK_ARCHIVE;
  if (pickle.tags.some((t) => t.name === '@slow-archive')) process.env.TB_MOCK_ARCHIVE_MS = '2500';
  else delete process.env.TB_MOCK_ARCHIVE_MS;
  // A stand-in BrowserBear, its folder handed to the app. Without the tag the
  // app has none: a scripted app never reaches the real one.
  if (pickle.tags.some((t) => t.name === '@browserbear')) {
    this.bear = await StandInBrowserBear.start();
    process.env.BROWSERBEAR_HOME = this.bear.home;
  } else delete process.env.BROWSERBEAR_HOME;
  // The web runtime's folder for this scenario (support/web-runtime.ts).
  if ((await webRuntimeSetup(pickle.tags.map((t) => t.name))) === 'skipped') return 'skipped';
  await this.app.start();
  // The stress run's window size and look (tools/stress.mjs), before any step.
  const size = /^(\d+)x(\d+)$/.exec(process.env.TB_STRESS_SIZE ?? '');
  if (size) await this.app.do({ cmd: 'size', w: Number(size[1]), h: Number(size[2]) });
  if (process.env.TB_STRESS_APPEARANCE) await this.app.do({ cmd: 'appearance', mode: process.env.TB_STRESS_APPEARANCE });
});

After(async function (this: ThreadbearWorld, { result, pickle }) {
  // The stress run's record (tools/stress.mjs): a line per scenario as it
  // ends, so a round cut short at its time limit still has what it ran.
  if (process.env.TB_STRESS_LOG) {
    const message = (result?.message ?? '').split('\n').slice(0, 6).join('\n');
    fs.appendFileSync(process.env.TB_STRESS_LOG, JSON.stringify({
      uri: path.basename(pickle.uri), name: pickle.name, tags: pickle.tags.map((t) => t.name),
      status: result?.status, secs: Number(((Date.now() - scenarioStarted) / 1000).toFixed(1)), message,
    }) + '\n');
  }
  if (result?.status === Status.FAILED) {
    const dir = path.resolve('reports/failures');
    fs.mkdirSync(dir, { recursive: true });
    const name = pickle.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const file = path.join(dir, `${this.app.name}-${name}.png`);
    await this.app.shot(file).catch(() => {});
    // The stress run also keeps what the app said it showed (tools/stress.mjs).
    if (process.env.TB_STRESS_LOG) {
      const dump = await this.app.dump().catch((e: Error) => ({ error: e.message }));
      fs.writeFileSync(file.replace(/\.png$/, '.dump.json'), JSON.stringify(dump, null, 1));
      fs.writeFileSync(file.replace(/\.png$/, '.log'), await this.app.appLog().catch(() => ''));
    }
    if (fs.existsSync(file)) this.attach(fs.readFileSync(file), 'image/png');
  }
  await this.app.stop();
  await this.bear?.stop();
  // Only now: Windows won't remove the folder the Terminal's shell is in.
  removeTempFolders();
  webRuntimeCleanup();
});
