// A real check of every other machine's runner, through this Mac's live
// runner and Convex, the way the Mac app reaches them by default. For each
// runner online (Hetzner, bruce, the Pixel) it starts a throwaway thread
// there (Haiku when Claude can answer, otherwise another provider on that
// machine), sends it a red square, checks the agent saw red, checks the
// decision card it ends with keeps what each answer does on the way back,
// and archives the thread. Then it checks the backend is on the version this
// runner expects, that no machine says it can't follow GitHub's main, and
// on Mike's runner that releases are still going out. One line per check; exits 1 if any failed.
//
// The unit tests (scenarios.test.ts, parity.test.ts) prove the code agrees
// with itself; this proves the real machines do: a release that didn't
// build, a backend that wasn't deployed, a key that broke. It's what found
// nothing wrong by hand on 8 Nov after pictures to other runners landed.
// It costs a few turns a run; the daily schedule runs it.
//
//   node runner/scripts/canary.ts [--runner <name>]   (THREADBEAR_HOME for another data dir)
//
// The daily schedule runs it as its check: an agent starts only when it
// prints, which is only when something failed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RunnerClient } from '../src/client.ts';
import { loadConfig, readToken, runnerUrl } from '../src/config.ts';
import { makePng } from '../test/helpers/png.ts';
import { forTerminal } from '../src/terminal-text.ts';

type Ev = { seq: number; type: string; text?: string; outcome?: string; asks?: { action: string; options?: string[]; optionNotes?: string[] }[] };
type Runner = { id: string; name: string; online: boolean };
type Login = { id: string; provider: string; signedOut?: boolean; planEnded?: boolean; models?: { id: string }[]; usage?: { blocked?: boolean; windows?: { remainingPercent?: number; resetsAt?: string }[] } };

// A login's own refusal isn't Threadbear breaking. On 25 Nov every runner's
// claude-main was out for the week, and on 27 Nov the Claude subscriptions the
// RAMP card pays were past due or turned off, and all three checks failed with
// "its first turn failed". The canary takes a login that can answer (Claude
// first, then another provider on that machine) and says a refusal as a skip.
const LIMIT = /hit your (weekly|session|usage) limit|out of usage|usage limit|can't use your claude subscription|payment is past due|disabled claude subscription access/i;

// Network blips worth trying a read again for (read(), below).
const BLIP = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|aborted due to timeout/i;

// Each turn's wait; two turns per runner, all runners at once, inside a schedule check's 5 minutes.
const TURN_MS = 2 * 60_000;
const BRIEF = [
  'This is an automatic check of Threadbear (the daily canary); nobody is reading it live.',
  "Don't run any tools apart from end_turn.",
  'Reply with just the word ready, then call end_turn with needs "nothing".',
  'My next message has a picture in it. Then reply with just its colour, in one word, and call end_turn with',
  'needs "you" and asks: [{ "question": "Is that the colour?", "options": [{ "label": "Yes", "does": "It is that colour" }, { "label": "No", "does": "It is another colour" }] }].',
].join(' ');

const { values } = parseArgs({ options: { runner: { type: 'string' } } });
const results: { ok: boolean; line: string }[] = [];
const say = (ok: boolean, line: string) => {
  results.push({ ok, line });
  // Its lines hold what other runners wrote (their names, followProblem,
  // threads' replies): no escape sequences reach the terminal (tb status's
  // rule, terminal-text.ts), and each check is one line.
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${forTerminal(line).replace(/\s+/g, ' ')}`);
};

const cfg = loadConfig(process.env, { readOnly: true });
// This Mac's runner answers the sign-in within 5 s when it's well, but at
// 7:00 several schedules fire at once and on 17 Nov it missed that, so the
// canary failed before checking anything. It gets longer here and a couple
// more tries; a runner that's really down or wrong still fails all three.
const client = await connectPatiently();
try {
  await client.call('hello', { client: 'tb-canary', version: '1' });
  const status = (await read('runner.status', {})) as { sync?: { backend?: { apiVersion: number; expected: number } }; behindRunners?: { name: string; problem: string }[] };
  const backend = status.sync?.backend;
  if (backend) say(backend.apiVersion >= backend.expected, `the backend is on API ${backend.apiVersion}, this runner expects ${backend.expected}`);
  else say(false, "this runner hasn't heard the backend's version (is the Convex mirror on?)");
  // A machine that can't follow GitHub's main (follow-origin.ts): what sat
  // unnoticed on bruce and the Pixel for days before this canary found it.
  for (const r of status.behindRunners ?? []) say(false, `${r.name} isn't following GitHub's main properly: ${r.problem}`);
  if (cfg.releases?.publish) await releasesGoingOut();

  const remote = (await read('remoteThreads.list', {})) as { runners: Runner[] };
  const runners = remote.runners.filter((r) => !values.runner || r.name === values.runner || r.id === values.runner);
  if (!runners.length) say(false, values.runner ? `no runner called ${values.runner}` : 'no other runners are listed');
  // Side by side, so a run fits the 5 minutes a schedule's check may take.
  await Promise.all(
    runners.map(async (r) => {
      if (!r.online) return say(true, `${r.name}: offline, skipped`);
      await check(r).catch((e) => say(false, `${r.name}: ${(e as Error).message}`));
    }),
  );
} finally {
  client.close();
}
process.exit(results.every((x) => x.ok) ? 0 : 1);

async function check(r: Runner): Promise<void> {
  const logins = (await step("reading its logins", () => read('remoteThreads.logins', { runnerId: r.id }))) as { accounts: Login[] };
  const accounts = logins.accounts;
  const tried = new Set<string>();
  for (;;) {
    const login = pickLogin(accounts.filter((a) => !tried.has(a.id)));
    if (!login) return say(true, tried.size ? `${r.name}: skipped, its login was refused and no other one there can answer` : nowhere(r.name, accounts));
    tried.add(login.id);
    // 'done' already printed its own lines. 'refused' tries the next login.
    if ((await probe(r, login)) === 'done') return;
  }
}

// One throwaway thread on one login. 'refused' means the login itself said no
// (usage, a past-due card, org access turned off), so the caller tries another.
async function probe(r: Runner, login: Login): Promise<'done' | 'refused'> {
  const haiku = login.provider === 'claude' ? login.models?.find((m) => /haiku/i.test(m.id))?.id : undefined;
  const made = (await step('starting a thread there', () => client.call('threads.create', { runnerId: r.id, text: BRIEF, title: 'Canary: Threadbear daily check', accountId: login.id, ...(haiku ? { model: haiku } : {}) }))) as { thread: { id: string } };
  const id = made.thread.id;
  try {
    const first = await turnEnd(id, 0);
    // A failed turn is one line, not three FAILs that read as a broken
    // runner. The relay says only that it failed; the reason is in that
    // runner's thread. A refusal in the reply is the login, not the runner.
    if (first.card?.outcome === 'failed') {
      // Its usage read can be hours old, so a limit still shows up here.
      const said = reply(first.events, first.from);
      if (LIMIT.test(said)) return 'refused';
      say(false, `${r.name}: its first turn failed (thread ${id}; its events on ${r.name} say why)`);
      return 'done';
    }
    say(/\bready\b/i.test(reply(first.events, first.from)), `${r.name}: a new thread on ${login.provider} started there and answered`);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-canary-'));
    const file = path.join(dir, 'red.png');
    fs.writeFileSync(file, makePng(32, 32, [230, 20, 20]));
    const { image } = (await client.call('media.import', { path: file })) as { image: unknown };
    fs.rmSync(dir, { recursive: true, force: true });
    await client.call('threads.send', { threadId: id, text: 'What colour is this? [Picture 1]', images: [image] });
    const second = await turnEnd(id, first.end);
    const said = reply(second.events, second.from);
    say(/\bred\b/i.test(said), `${r.name}: a picture sent from here reached it (it said ${JSON.stringify(said.slice(0, 40))})`);
    const ask = second.card?.asks?.[0];
    const notes = Boolean(ask && ask.options?.length === 2 && ask.optionNotes?.filter(Boolean).length === 2);
    say(notes, `${r.name}: its decision card came back with what each answer does${notes ? '' : ` (thread ${id}, card ${JSON.stringify(second.card?.asks ?? null)})`}`);
    return 'done';
  } finally {
    await client.call('threads.update', { threadId: id, archived: true }).catch((e) => say(false, `${r.name}: couldn't archive the canary thread ${id}: ${(e as Error).message}`));
  }
}

// Mike's runner tags a release a day once GitHub's checks pass
// (src/upstream.ts). None went out from 16 to 19 Nov while main was red on
// Windows, and nobody noticed until forks were days behind. Main's changes
// waiting more than STALL_DAYS for one is said once (the newest tag is kept in
// release-stall-told), so a long stall starts one thread, not one a day.
// (Inside: a const out here isn't set yet when the checks above call this.)
async function releasesGoingOut(): Promise<void> {
  const STALL_DAYS = 2;
  const { upstream } = await read<{ upstream: { checkout?: string; held?: { commit: string; why: string } } }>('upstream.status', {});
  if (!upstream.checkout) return say(false, "releases: this runner doesn't say which checkout it publishes from");
  const tags = execFileSync('git', ['-C', upstream.checkout, 'tag', '--list', 'release/*', '--sort=-refname'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const newest = tags[0];
  if (!newest) return say(false, 'releases: no release/ tags in the checkout');
  // Counted from the oldest commit main has that the newest release doesn't:
  // a quiet main with nothing to release isn't a stall (Codex's review).
  const unreleased = execFileSync('git', ['-C', upstream.checkout, 'log', '--format=%ct', '--reverse', `${newest}..refs/heads/main`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  if (!unreleased.length) return say(true, `releases: main has nothing since ${newest}`);
  const days = Math.floor((Date.now() - Number(unreleased[0]) * 1000) / 86_400_000);
  if (days < STALL_DAYS) return say(true, `releases: the newest is ${newest}`);
  const told = path.join(cfg.home, 'runner', 'release-stall-told');
  if (fs.existsSync(told) && fs.readFileSync(told, 'utf8').trim() === newest) return say(true, `releases: none since ${newest}, already said`);
  fs.mkdirSync(path.dirname(told), { recursive: true });
  fs.writeFileSync(told, `${newest}\n`);
  const why = upstream.held ? `main (${upstream.held.commit.slice(0, 8)}) is held: ${upstream.held.why}` : "the runner hasn't said why (tb logs, 'holding back a release')";
  say(false, `releases: none has gone out since ${newest}, with ${unreleased.length} commits on main waiting for ${days} days, so forks aren't getting updates; ${why}`);
}

// A read that failed on a network blip (this Mac's runner reaching Convex)
// is tried again, so the canary doesn't cry wolf: it reports what stays
// broken. Only reads: a create or a send tried twice could do it twice.
// BLIP is up top: the checks run (and exit) before the code down here, and a
// const declared below them is still uninitialised when they call read().
async function read<T>(method: string, params: Record<string, unknown>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return (await client.call(method, params)) as T;
    } catch (e) {
      if (i >= 4 || !BLIP.test(String((e as Error)?.message))) throw e;
      await new Promise((res) => setTimeout(res, 5000 * i));
    }
  }
}

async function connectPatiently(): Promise<RunnerClient> {
  for (let i = 1; ; i++) {
    try {
      return await RunnerClient.connect(runnerUrl(cfg), readToken(cfg.home), { authTimeoutMs: 15_000 });
    } catch (e) {
      if (i >= 3 || !(e as { notProved?: boolean })?.notProved) throw e;
      await new Promise((res) => setTimeout(res, 10_000));
    }
  }
}

// A step's error says which step it was.
async function step<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`);
  }
}

// Waits for the turn ending after `after` (a seq), through the relay.
async function turnEnd(id: string, after: number): Promise<{ events: Ev[]; from: number; end: number; card?: Ev }> {
  const until = Date.now() + TURN_MS;
  while (Date.now() < until) {
    const { events } = await read<{ events: Ev[] }>('threads.events', { threadId: id });
    const end = events.find((e) => e.type === 'turn.completed' && e.seq > after);
    if (end) return { events, from: after, end: end.seq, card: end };
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`no answer within ${TURN_MS / 60_000} minutes`);
}

// When the soonest of these logins' limits ends, for the skip line.
function resets(logins: Login[]): string {
  const at = logins.flatMap((l) => (l.usage?.windows ?? []).filter((w) => w.remainingPercent === 0 && w.resetsAt).map((w) => Date.parse(w.resetsAt!))).filter(Number.isFinite);
  return at.length ? ` until ${new Date(Math.min(...at)).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
}

function reply(events: Ev[], after: number): string {
  return events
    .filter((e) => e.type === 'assistant.text' && e.seq > after)
    .map((e) => e.text ?? '')
    .join(' ')
    .trim();
}

// Claude when one can answer: that's the cheap check. Otherwise Codex, then
// whatever else on that machine still has room. A signed-out or blocked login
// is skipped here so the create doesn't land on it by default.
function openLogin(a: Login): boolean {
  return !a.signedOut && !a.planEnded && !a.usage?.blocked;
}

function pickLogin(accounts: Login[]): Login | undefined {
  const open = accounts.filter(openLogin);
  return open.find((a) => a.provider === 'claude') ?? open.find((a) => a.provider === 'codex') ?? open[0];
}

// No login can be tried. Keeps the usage line the 25 Nov skip already used.
function nowhere(name: string, accounts: Login[]): string {
  const claudes = accounts.filter((a) => a.provider === 'claude');
  if (claudes.length && claudes.every((a) => a.usage?.blocked)) return `${name}: skipped, every Claude login there is out of usage${resets(claudes)}`;
  if (accounts.length && accounts.every((a) => a.signedOut)) return `${name}: skipped, every login there is signed out`;
  return `${name}: skipped, no login there can answer`;
}
