// Box mode (src/box-mode.ts, docs/protocol/boxes.md "Box mode"): a runner in a
// virtual runner's machine for one thread. Its boot exchange, the secrets
// it keeps, the environment it gives what it starts, the folder it clones,
// its one thread, the machine it names in heartbeats, and what it does when
// a newer box has the thread. A fake backend, real git in temp repos, and
// for the last test the real runner entry point (no CLI is ever spawned).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { localClone, originRepo, sh } from '../helpers/box-git.ts';
import { SaveHold } from '../../src/box-save.ts';
import { BoxTokenWatch } from '../../src/box-token.ts';
import { CARRY_ON_TOKEN } from '../../src/runner.ts';
import { call } from '../helpers/convex-memory.ts';
import { boxBackend } from '../helpers/box-backend.ts';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { nullLogger } from '../../src/log.ts';
import { readYearToken } from '../../src/year-token.ts';
import { ConvexSync, readSyncKey } from '../../src/sync.ts';
import { paths } from '../../src/config.ts';
import { load } from '../helpers/convex-memory.ts';
import { Scheduler } from '../../src/schedules.ts';
import { CrossRunner } from '../../src/cross-runner.ts';
import { BOX_NO_SCHEDULES, BOOT_ENV, BoxBootRefused, BoxFolderBroken, markSetUp, setBaseline, setSaveHold, MACHINE_ID_ENV, bootBox, boxFile, enterBoxEnv, exchangeBoot, prepareBoxFolder, readBoxBoot, readBoxSecrets, repoFolderName, writeBoxSecrets, type ActionPost, type BoxSecrets, type Cloner } from '../../src/box-mode.ts';

// The backend's gate for a box key (convex/runnerAccess.ts BOX_CALLS, run by
// lib.ts runnerAuth): a box-mode sync here may call nothing else, so a call
// the real backend would refuse (sync:prune, 19 Nov) can't hide in a fake.
const { BOX_CALLS } = load('runnerAccess') as { BOX_CALLS: ReadonlySet<string> };
const refusedCalls: string[] = [];
function onlyBoxCalls(post: (kind: 'mutation' | 'query', fn: string, args: Record<string, unknown>) => Promise<unknown>) {
  return async (kind: 'mutation' | 'query', fn: string, args: Record<string, unknown>) => {
    const name = fn.split(':')[1] ?? fn;
    if (!BOX_CALLS.has(name)) {
      refusedCalls.push(fn);
      throw Object.assign(new Error(`forbidden: ${fn}`), { data: { kind: 'forbidden', message: `call ${name}: a box's key runs its one thread, and nothing else` } });
    }
    return post(kind, fn, args);
  };
}

const BOOT = `tbt_${'a'.repeat(64)}`;
const BOX_KEY = `tbb_${'b'.repeat(64)}`;
const CLAUDE_TOKEN = `sk-ant-oat01-${'Q'.repeat(60)}`;
const THREAD = 'b0c0ffee-1111-4222-8333-444455556666';
const THREAD_KEY = Buffer.alloc(32, 9).toString('base64');
const URL = 'https://dep.convex.cloud';

function exchanged(over: Record<string, unknown> = {}) {
  return { boxKey: BOX_KEY, runnerId: 'box0thread01', threadId: THREAD, claudeToken: CLAUDE_TOKEN, threadKey: THREAD_KEY, repo: { origin: 'https://github.com/mikecann/threadbear.git', subfolder: 'runner', baseBranch: 'main' }, save: null, login: 'me@example.com', ...over };
}

test('the boot comes from the environment: the token, the backend, and the machine by the variable the service names', () => {
  assert.equal(readBoxBoot({}), undefined);
  assert.equal(readBoxBoot({ THREADBEAR_SYNC_URL: URL }), undefined);
  assert.throws(() => readBoxBoot({ [BOOT_ENV]: BOOT }), BoxBootRefused);
  // The provider's variable, as THREADBEAR_MACHINE_ID_ENV names it.
  assert.deepEqual(readBoxBoot({ [BOOT_ENV]: BOOT, THREADBEAR_SYNC_URL: URL, [MACHINE_ID_ENV]: 'BOX_ID', BOX_ID: 'm-42', FLY_MACHINE_ID: 'other' }), { bootToken: BOOT, syncUrl: URL, machineId: 'm-42' });
  // Not named: Fly's.
  assert.deepEqual(readBoxBoot({ [BOOT_ENV]: BOOT, THREADBEAR_SYNC_URL: URL, FLY_MACHINE_ID: '148e2d4b0e7d98' }), { bootToken: BOOT, syncUrl: URL, machineId: '148e2d4b0e7d98' });
  // An id the backend wouldn't take is left out, not sent.
  assert.deepEqual(readBoxBoot({ [BOOT_ENV]: BOOT, THREADBEAR_SYNC_URL: URL, FLY_MACHINE_ID: 'no spaces;' }), { bootToken: BOOT, syncUrl: URL });
});

test('box mode takes the boot token out of what the runner starts, and turns off what a box has no use for', () => {
  const env: NodeJS.ProcessEnv = { [BOOT_ENV]: BOOT, THREADBARE_BOX_BOOT: BOOT, THREADBEAR_SYNC_URL: URL, THREADBEAR_SYNC: 'off', PATH: '/bin' };
  enterBoxEnv(env);
  assert.equal(env[BOOT_ENV], undefined);
  assert.equal(env.THREADBARE_BOX_BOOT, undefined);
  assert.equal(env.IS_SANDBOX, '1');
  // No following main (self-update), no CLI updates, no Sentry, no Mac screen; the sync stays.
  assert.equal(env.THREADBEAR_FOLLOW_MAIN, '0');
  assert.equal(env.THREADBEAR_CLI_UPDATES, 'off');
  assert.equal(env.THREADBEAR_SENTRY, 'off');
  assert.equal(env.THREADBEAR_MAC_SCREEN, 'off');
  assert.equal(env.THREADBEAR_SYNC, undefined);
  assert.equal(env.THREADBEAR_SYNC_URL, URL);
  assert.ok(!JSON.stringify(env).includes(BOOT));
});

test('the exchange names the machine, and its secrets land 0600: box.json, the box key, and the login token where claude-main reads it', async () => {
  const home = tmpDir('tb-box-home-');
  fs.mkdirSync(paths.secrets(home), { recursive: true, mode: 0o700 });
  const claudeDir = path.join(tmpDir('tb-box-claude-'), '.claude');
  const calls: { kind: string; fn: string; args: Record<string, unknown> }[] = [];
  const post: ActionPost = async (kind, fn, args) => {
    calls.push({ kind, fn, args });
    return exchanged();
  };
  const { secrets: s, fresh } = await bootBox({ boot: { bootToken: BOOT, syncUrl: URL, machineId: 'm-42' }, home, claudeDir, post, log: nullLogger });
  assert.equal(fresh, true);
  // Only the hash of a key: a backend from before boxKeyHash hands back a key of its own (this one does).
  assert.match(String(calls[0]!.args.boxKeyHash), /^[0-9a-f]{64}$/);
  assert.deepEqual(calls, [{ kind: 'action', fn: 'boxes:exchange', args: { bootToken: BOOT, machineId: 'm-42', boxKeyHash: calls[0]!.args.boxKeyHash } }]);
  assert.equal(s.boxKey, BOX_KEY);
  assert.equal(s.runnerId, 'box0thread01');
  assert.equal(s.threadId, THREAD);
  assert.equal(s.threadKey, THREAD_KEY);
  assert.equal(s.login, 'me@example.com');
  assert.equal(s.machineId, 'm-42');
  assert.deepEqual(s.repo, { origin: 'https://github.com/mikecann/threadbear.git', subfolder: 'runner', baseBranch: 'main' });
  // Never the boot token itself, only its hash.
  assert.ok(!fs.readFileSync(boxFile(home), 'utf8').includes(BOOT));
  assert.deepEqual(readBoxSecrets(home), s);
  const mode = (f: string) => fs.statSync(f).mode & 0o777;
  assert.equal(mode(boxFile(home)), 0o600);
  assert.equal(mode(path.join(paths.secrets(home), 'convex-key')), 0o600);
  assert.equal(readSyncKey(home), BOX_KEY);
  const tokenFile = path.join(claudeDir, 'threadbear-token.json');
  assert.equal(mode(tokenFile), 0o600);
  // As a year-long token: the runner hands it to claude-main's CLI and nowhere else.
  assert.equal(readYearToken(claudeDir)?.token, CLAUDE_TOKEN);
  // The Claude token is nowhere in the data dir.
  for (const f of fs.readdirSync(paths.secrets(home))) assert.ok(!fs.readFileSync(path.join(paths.secrets(home), f), 'utf8').includes(CLAUDE_TOKEN));

  // Started again on the same machine (same boot token): no second exchange, as it works once.
  const again = await bootBox({ boot: { bootToken: BOOT, syncUrl: URL, machineId: 'm-42' }, home, claudeDir, post, log: nullLogger });
  assert.equal(calls.length, 1);
  assert.equal(again.secrets.boxKey, BOX_KEY);
  assert.equal(again.fresh, false);
  // A new boot token (a new attempt) trades again.
  await bootBox({ boot: { bootToken: `tbt_${'c'.repeat(64)}`, syncUrl: URL }, home, claudeDir, post, log: nullLogger });
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(calls[1]!.args).sort(), ['bootToken', 'boxKeyHash']);
});

test('a refused boot token stops the box at once; an outage or a deployment not ready yet is tried again, until the token would be dead', async () => {
  const boot = { bootToken: BOOT, syncUrl: URL };
  const err = (kind: string) => Object.assign(new Error(kind), { data: { kind, message: kind } });
  let n = 0;
  await assert.rejects(exchangeBoot({ boot, log: nullLogger, sleep: async () => {}, post: async () => { n++; throw err('auth'); } }), BoxBootRefused);
  assert.equal(n, 1);
  // A network failure, then no cloud token yet, then it works.
  const answers: (() => unknown)[] = [() => { throw new Error('fetch failed'); }, () => { throw err('noCloudToken'); }, () => exchanged()];
  const slept: number[] = [];
  const got = await exchangeBoot({ boot, log: nullLogger, sleep: async (ms) => void slept.push(ms), post: async () => answers.shift()!() });
  assert.equal(got.boxKey, BOX_KEY);
  assert.deepEqual(slept, [2000, 4000]);
  // Past the boot token's 10 minutes: given up.
  let t = 0;
  await assert.rejects(exchangeBoot({ boot, log: nullLogger, now: () => t, sleep: async (ms) => void (t += ms), post: async () => { throw err('config'); } }), /in time/);
  assert.ok(t <= 10 * 60_000);
  // An answer it can't use is refused, not written anywhere.
  await assert.rejects(exchangeBoot({ boot, log: nullLogger, post: async () => exchanged({ claudeToken: 'not a token' }) }), /Claude token/);
  await assert.rejects(exchangeBoot({ boot, log: nullLogger, post: async () => exchanged({ threadId: '../etc' }) }), /thread id/);
  await assert.rejects(exchangeBoot({ boot, log: nullLogger, post: async () => exchanged({ repo: { origin: 'x', subfolder: '../up', baseBranch: 'main' } }) }), /subfolder/);
  await assert.rejects(exchangeBoot({ boot, log: nullLogger, post: async () => exchanged({ repo: { origin: 'x', subfolder: '', baseBranch: '--upload-pack=x' } }) }), /base branch/);
});

test('the box makes its own key and sends only its hash; an answer lost on the way is asked for again with the same hash', async () => {
  const sent: Record<string, unknown>[] = [];
  let n = 0;
  const post: ActionPost = async (_kind, _fn, args) => {
    sent.push(args);
    // The first answer is lost after the backend took the token.
    if (n++ === 0) throw new Error('fetch failed: socket hang up');
    // A replay: no key in it, as the box has its own.
    const { boxKey: _, ...rest } = exchanged();
    return rest;
  };
  const got = await exchangeBoot({ boot: { bootToken: BOOT, syncUrl: URL, machineId: 'm-42' }, post, log: nullLogger, sleep: async () => {} });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1], 'the same token, machine and key hash both times');
  assert.match(got.boxKey, /^tbb_[0-9a-f]{64}$/);
  assert.equal(crypto.createHash('sha256').update(got.boxKey).digest('hex'), sent[0]!.boxKeyHash);
  assert.ok(!JSON.stringify(sent).includes(got.boxKey), 'the key itself never went');
});

function secretsFor(origin: string, over: Partial<BoxSecrets> = {}): BoxSecrets {
  return { version: 1, bootHash: 'h', syncUrl: URL, boxKey: BOX_KEY, runnerId: 'box0thread01', threadId: THREAD, threadKey: THREAD_KEY, repo: { origin, subfolder: 'runner', baseBranch: 'main' }, save: null, ...over };
}

test('with no save, the box clones its repo on the base branch and the thread starts in the subfolder; once', async () => {
  const origin = originRepo();
  assert.equal(repoFolderName(origin), 'proj');
  assert.equal(repoFolderName('git@github.com:mikecann/threadbear.git'), 'threadbear');
  const home = tmpDir('tb-box-home-');
  const workRoot = tmpDir('tb-box-work-');
  let clones = 0;
  const clone: Cloner = async (u, to) => (clones++, localClone(u, to));
  const s = secretsFor(origin, { repo: { origin, subfolder: 'runner', baseBranch: 'dev' } });
  writeBoxSecrets(home, s);
  const got = await prepareBoxFolder({ secrets: s, fresh: true, home, claudeDir: tmpDir(), workRoot, log: nullLogger, clone });
  const checkout = fs.realpathSync(path.join(workRoot, 'proj'));
  assert.deepEqual(got, { checkout, cwd: path.join(checkout, 'runner'), restored: false });
  assert.equal(sh(checkout, 'git rev-parse --abbrev-ref HEAD'), 'dev');
  assert.ok(fs.existsSync(path.join(checkout, 'dev.txt')));
  // Kept, so a runner that starts again doesn't clone over the thread's work.
  assert.deepEqual(readBoxSecrets(home)?.prepared, got);
  fs.writeFileSync(path.join(checkout, 'runner', 'work.txt'), 'uncommitted');
  assert.deepEqual(await prepareBoxFolder({ secrets: readBoxSecrets(home)!, fresh: false, home, claudeDir: tmpDir(), workRoot, log: nullLogger, clone }), { ...got, again: true });
  assert.equal(clones, 1);
  assert.ok(fs.existsSync(path.join(checkout, 'runner', 'work.txt')));
  // A subfolder the repo doesn't have says so.
  const missing = secretsFor(origin, { repo: { origin, subfolder: 'nope', baseBranch: 'main' } });
  await assert.rejects(prepareBoxFolder({ secrets: missing, fresh: true, home: tmpDir(), claudeDir: tmpDir(), workRoot: tmpDir(), log: nullLogger, clone: localClone }), /nope isn't a folder/);
});

test("an established box whose folder has gone stops, deleting nothing and never restoring its exchange's save over the work", async () => {
  const origin = originRepo();
  const home = tmpDir('tb-box-home-');
  const workRoot = tmpDir('tb-box-work-');
  const s = secretsFor(origin);
  writeBoxSecrets(home, s);
  const got = await prepareBoxFolder({ secrets: s, fresh: true, home, claudeDir: tmpDir(), workRoot, log: nullLogger, clone: localClone });
  // The thread's work, then its subfolder gone (an agent's rm -rf), and a stale save the exchange once gave.
  fs.mkdirSync(paths.thread(home, THREAD), { recursive: true });
  fs.writeFileSync(path.join(paths.thread(home, THREAD), 'thread.json'), '{"id":"keep"}');
  fs.writeFileSync(path.join(got.checkout, 'README.md'), 'newer work\n');
  fs.rmSync(got.cwd, { recursive: true });
  const kept = { ...readBoxSecrets(home)!, save: { url: 'https://dep.convex.cloud/api/storage/old', at: 1, bytes: 10 } };
  let downloads = 0;
  let clones = 0;
  await assert.rejects(
    prepareBoxFolder({ secrets: kept, fresh: false, home, claudeDir: tmpDir(), workRoot, log: nullLogger, clone: async (u, t) => (clones++, localClone(u, t)), download: async () => (downloads++, Buffer.alloc(0)) }),
    (e: unknown) => e instanceof BoxFolderBroken && /has gone/.test((e as Error).message) && /Found: the clone at .*the thread's record at/.test((e as Error).message),
  );
  assert.equal(downloads, 0);
  assert.equal(clones, 0);
  assert.equal(fs.readFileSync(path.join(got.checkout, 'README.md'), 'utf8'), 'newer work\n');
  assert.equal(fs.readFileSync(path.join(paths.thread(home, THREAD), 'thread.json'), 'utf8'), '{"id":"keep"}');
});

test('only the start that traded the token makes the folder, and only into an empty place', async () => {
  const origin = originRepo();
  // A first start that died before its folder was made: the next start (no fresh exchange) won't make it.
  const home = tmpDir('tb-box-home-');
  const workRoot = tmpDir('tb-box-work-');
  const s = secretsFor(origin);
  writeBoxSecrets(home, s);
  fs.mkdirSync(path.join(workRoot, 'proj'));
  fs.writeFileSync(path.join(workRoot, 'proj', 'half.txt'), 'half made');
  let clones = 0;
  const clone: Cloner = async (u, t) => (clones++, localClone(u, t));
  await assert.rejects(prepareBoxFolder({ secrets: s, fresh: false, home, claudeDir: tmpDir(), workRoot, log: nullLogger, clone }), /first start didn't finish/);
  // Nor does a fresh exchange over something that's there.
  await assert.rejects(prepareBoxFolder({ secrets: s, fresh: true, home, claudeDir: tmpDir(), workRoot, log: nullLogger, clone }), /isn't empty/);
  assert.equal(clones, 0);
  assert.equal(fs.readFileSync(path.join(workRoot, 'proj', 'half.txt'), 'utf8'), 'half made');
});

test("a box loads only its own thread from disk: other records are left alone, not recovered, carried on or taken in", async () => {
  const home = tmpDir('tb-box-home-');
  const first = makeHarness(home);
  const cwd = first.cfg.defaults.cwd;
  const mine = first.runner.create({ text: 'mine', cwd, accountId: 'claude-main' }).thread.id;
  const other = first.runner.create({ text: 'other', cwd, accountId: 'claude-main' }).thread.id;
  // The other one mid-turn, as a crash would leave it, and a broken record too.
  first.runner.flush();
  fs.mkdirSync(paths.thread(home, 'broken-thread'), { recursive: true });
  fs.writeFileSync(path.join(paths.thread(home, 'broken-thread'), 'events.jsonl'), '');
  const box = makeHarness(home, {}, { boxThread: mine });
  assert.deepEqual([...box.runner.threads.keys()], [mine]);
  assert.throws(() => box.runner.get(other));
  box.runner.carryOnStopped();
  assert.equal(box.adapter.sessions.filter((x) => x.opts.sessionId === first.runner.threads.get(other)!.rec.nativeSessionId).length, 0);
  // A handover or move can't bring another in either.
  assert.equal(box.runner.adopt(other), undefined);
  assert.equal(box.runner.threads.has(other), false);
});

test('a box runs one thread: its create under the id the backend gave, and nothing else', () => {
  const h = makeHarness();
  h.runner.boxThread = THREAD;
  const cwd = h.cfg.defaults.cwd;
  assert.throws(() => h.runner.create({ text: 'another', cwd, accountId: 'claude-main' }), /box for one thread/);
  assert.throws(() => h.runner.create({ text: 'another', cwd, accountId: 'claude-main', id: 'some-other-thread' }), /box for one thread/);
  const made = h.runner.create({ text: 'hi', cwd, accountId: 'claude-main', id: THREAD });
  assert.equal(made.thread.id, THREAD);
  // Once.
  assert.throws(() => h.runner.create({ text: 'again', cwd, accountId: 'claude-main', id: THREAD }), /box for one thread/);
  // A runner that isn't a box never takes an id from outside.
  const other = makeHarness();
  assert.throws(() => other.runner.create({ text: 'x', cwd: other.cfg.defaults.cwd, accountId: 'claude-main', id: THREAD }), /Only a box/);
});

test("a box's heartbeat names its machine; a key the backend turns down means it's been superseded: said once, and nothing more is sent", async () => {
  const h = makeHarness();
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  let refuse = false;
  let superseded = 0;
  const heard: { state: string; sentAt: number }[] = [];
  const before = performance.now();
  const sync = new ConvexSync({
    config: { enabled: true, url: URL, name: 'box', runnerId: 'box0thread01' },
    key: BOX_KEY,
    runner: h.runner,
    version: '0.1.0+test',
    startedAt: '2026-11-19T00:00:00.000Z',
    clock: h.clock,
    log: nullLogger,
    post: onlyBoxCalls(async (_kind, fn, args) => {
      calls.push({ fn, args });
      if (refuse) throw Object.assign(new Error('bad runner key'), { data: { kind: 'auth', message: 'bad runner key' } });
      return fn === 'sync:heartbeat' ? { apiVersion: 89, box: { state: 'awake' } } : null;
    }),
    box: { machineId: 'm-42', superseded: () => void superseded++, heard: (state, sentAt) => void heard.push({ state, sentAt }) },
  });
  sync.start();
  await tick();
  const hb = calls.find((c) => c.fn === 'sync:heartbeat')!;
  assert.equal((hb.args.runner as { machineId?: string }).machineId, 'm-42');
  assert.equal(hb.args.key, BOX_KEY);
  // What the backend says of the box goes to the save hold, with when the heartbeat was sent.
  assert.equal(heard.length, 1);
  assert.equal(heard[0]!.state, 'awake');
  assert.ok(heard[0]!.sentAt >= before && heard[0]!.sentAt <= performance.now());
  refuse = true;
  h.clock.advance(60_000);
  await tick();
  assert.equal(superseded, 1);
  const after = calls.length;
  // No heartbeat a minute later, nor anything else.
  h.clock.advance(5 * 60_000);
  await tick();
  sync.reconnectNow('clock jumped');
  await tick();
  assert.equal(calls.length, after);
  assert.equal(superseded, 1);
  await sync.stop();
});

test("a runner that isn't a box sends no machine, and a turned-down key isn't taken as superseded", async () => {
  const h = makeHarness();
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const sync = new ConvexSync({
    config: { enabled: true, url: URL, name: 'Mac', runnerId: 'r1' },
    key: 'k',
    runner: h.runner,
    version: '0.1.0+test',
    startedAt: '2026-11-19T00:00:00.000Z',
    clock: h.clock,
    log: nullLogger,
    post: async (_kind, fn, args) => {
      calls.push({ fn, args });
      throw Object.assign(new Error('bad runner key'), { data: { kind: 'auth', message: 'bad runner key' } });
    },
  });
  sync.start();
  await tick();
  assert.equal((calls.find((c) => c.fn === 'sync:heartbeat')!.args.runner as { machineId?: string }).machineId, undefined);
  h.clock.advance(60_000);
  await tick();
  // It goes on heartbeating, as an old key may come back (KEY_REJECTED).
  assert.equal(calls.filter((c) => c.fn === 'sync:heartbeat').length, 2);
  await sync.stop();
});

test("the backend's save command goes to the box's save and finishes; a runner that isn't a box refuses it", async () => {
  for (const isBox of [true, false]) {
    const h = makeHarness();
    const t = h.runner.create({ text: 'hi', cwd: h.cfg.defaults.cwd, accountId: 'claude-main' }).thread;
    const finished: Record<string, unknown>[] = [];
    let push!: (v: unknown) => void;
    const saved: string[] = [];
    let awake = 0;
    const sync = new ConvexSync({
      config: { enabled: true, url: URL, name: 'box', runnerId: 'box0thread01' },
      key: BOX_KEY,
      runner: h.runner,
      version: '0.1.0+test',
      startedAt: '2026-11-19T00:00:00.000Z',
      clock: h.clock,
      log: nullLogger,
      post: (isBox ? onlyBoxCalls : (f: Parameters<typeof onlyBoxCalls>[0]) => f)(async (_kind, fn, args) => {
        if (fn === 'sync:heartbeat') return { apiVersion: 89 };
        if (fn === 'sync:takeCommand') return true;
        if (fn === 'sync:finishCommand') finished.push(args);
        return null;
      }),
      subscriber: {
        subscribe: (fn, _args, onUpdate) => {
          if (fn === 'sync:pendingCommands') push = onUpdate;
          return () => {};
        },
        close: () => {},
      },
      commands: {
        send: () => undefined,
        respondApproval: () => undefined,
        answerSecret: () => undefined,
        update: () => undefined,
        markSeen: () => undefined,
        create: () => ({ thread: t }),
        share: () => undefined,
        quickAsk: () => ({ thread: t }),
        ...(isBox ? { save: async (id: string) => (saved.push(id), { bytes: 123 }) } : {}),
      },
      ...(isBox ? { box: { superseded: () => {}, taken: (kind: string) => void (kind !== 'save' && awake++) } } : {}),
    });
    sync.start();
    await tick();
    push([{ commandId: 'c1', kind: 'save', threadId: t.id, args: {}, createdAt: 1 }]);
    await tick(10);
    assert.equal(finished.filter((f) => f.commandId === 'c1').length, 1);
    if (isBox) {
      // A save doesn't wake a box frozen by its save; anything else taken does (Runner.releaseTurns).
      assert.equal(awake, 0);
      push([{ commandId: 'c2', kind: 'send', threadId: t.id, args: { text: 'hi' }, createdAt: 2 }]);
      await tick(10);
      assert.equal(awake, 1);
      assert.deepEqual(saved, [t.id]);
      const c1 = finished.find((f) => f.commandId === 'c1')!;
      assert.equal(c1.ok, true);
      assert.equal(c1.result, JSON.stringify({ bytes: 123 }));
    } else {
      assert.equal(finished[0]!.ok, false);
      assert.match(String(finished[0]!.note), /isn't a box/);
    }
    await sync.stop();
  }
});

// ---------------------------------------------------------------- the real runner

const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');

test('the real runner in box mode: its kept key, its machine in the heartbeat, and it exits once superseded', async () => {
  const home = tmpDir('tb-box-run-');
  const claudeDir = path.join(home, 'claude-main');
  const cwd = tmpDir('tb-box-cwd-');
  const machineId = '148e2d4b0e7d98';
  // A runner that had already booted on this machine and restarted: its
  // secrets are there under this boot token, so it doesn't exchange again.
  fs.mkdirSync(paths.secrets(home), { recursive: true, mode: 0o700 });
  const s: BoxSecrets = { ...secretsFor('https://github.com/x/y.git'), bootHash: crypto.createHash('sha256').update(BOOT).digest('hex'), machineId, prepared: { checkout: cwd, cwd, restored: false } };
  writeBoxSecrets(home, s);
  fs.writeFileSync(path.join(paths.secrets(home), 'convex-key'), BOX_KEY, { mode: 0o600 });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'threadbear-token.json'), JSON.stringify({ token: CLAUDE_TOKEN }), { mode: 0o600 });

  // A backend that has given the thread to a newer box: every call refused as a bad key.
  const seen: { path: string; args: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        const b = JSON.parse(body) as { path: string; args: Record<string, unknown> };
        seen.push(b);
      } catch {
        // not a call
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', errorMessage: 'bad runner key', errorData: { kind: 'auth', message: 'bad runner key' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  let out = '';
  const proc = spawn(process.execPath, ['src/main.ts'], {
    cwd: RUNNER_DIR,
    env: {
      ...process.env,
      THREADBEAR_HOME: home,
      THREADBEAR_PORT: '0',
      THREADBEAR_LOG: path.join(home, 'runner.log'),
      THREADBEAR_LOG_STDERR: '1',
      THREADBEAR_CLAUDE_PATH: '/nonexistent/claude',
      THREADBEAR_ACCOUNTS_DIR: path.join(home, 'no-accounts'),
      THREADBEAR_CLAUDE_MAIN_DIR: claudeDir,
      THREADBEAR_CLAUDE_MAIN_JSON: path.join(home, 'no-main.json'),
      THREADBEAR_CODEX_MAIN_DIR: path.join(home, 'no-codex-main'),
      THREADBEAR_TOKEN_STATS_LIMITS: path.join(home, 'no-limits.json'),
      THREADBEAR_SYNC_URL: `http://127.0.0.1:${port}`,
      [BOOT_ENV]: BOOT,
      FLY_MACHINE_ID: machineId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const code = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(-1);
    }, 60_000);
    proc.once('exit', (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  server.close();
  assert.equal(code, 0, out.slice(-3000));
  assert.match(out, /a newer box has the thread/);
  // No second exchange: the boot token was used up by the first start.
  assert.equal(seen.filter((c) => c.path === 'boxes:exchange').length, 0);
  const hb = seen.find((c) => c.path === 'sync:heartbeat');
  assert.ok(hb, 'it heartbeat');
  assert.equal(hb.args.key, BOX_KEY);
  assert.equal((hb.args.runner as { runnerId: string; machineId?: string }).runnerId, 'box0thread01');
  assert.equal((hb.args.runner as { machineId?: string }).machineId, machineId);
  // A superseded box says no bye: its key is refused.
  assert.equal(seen.filter((c) => c.path === 'sync:bye').length, 0);
});

test("a restored worktree's setup is remembered apart from the folder, so a start before it finished runs it again", () => {
  const home = tmpDir('tb-box-home-');
  writeBoxSecrets(home, secretsFor('https://github.com/x/proj.git', { prepared: { checkout: '/w/proj', cwd: '/w/proj', restored: true } }));
  assert.equal(readBoxSecrets(home)?.setUp, undefined);
  markSetUp(home);
  assert.equal(readBoxSecrets(home)?.setUp, true);
  assert.deepEqual(readBoxSecrets(home)?.prepared, { checkout: '/w/proj', cwd: '/w/proj', restored: true });
  // And a thread loaded with that hold runs nothing until it's let go.
  const h = makeHarness(tmpDir(), {}, { boxThread: THREAD, boxHolds: ['setup'] });
  const made = makeHarness(h.home, {}, { boxThread: THREAD });
  made.runner.create({ text: 'go', cwd: made.cfg.defaults.cwd, accountId: 'claude-main', id: THREAD });
  made.runner.flush();
  const again = makeHarness(h.home, {}, { boxThread: THREAD, boxHolds: ['setup'] });
  const before = again.adapter.sessions.length;
  again.runner.send(THREAD, 'next', []);
  assert.equal(again.adapter.sessions.length, before);
  assert.equal(again.runner.threads.get(THREAD)!.rec.queue.length, 1);
  again.runner.releaseTurns(THREAD, 'setup');
  assert.equal(again.adapter.sessions.length, before + 1);
});

test('the save hold lets go only on the backend\'s word after the outcome: a later command other than a save, or a later heartbeat finding the box awake', () => {
  let t = 100;
  const events: string[] = [];
  const hold = new SaveHold({ hold: () => events.push('hold'), release: () => events.push('release'), now: () => t });
  hold.begin();
  // While the save is going: nothing.
  hold.taken('send');
  hold.heard('awake', 200);
  assert.deepEqual(events, ['hold']);
  t = 300;
  hold.settled();
  // A heartbeat sent before the outcome was known, or finding it asleep: nothing.
  hold.heard('awake', 250);
  hold.heard('asleep', 400);
  hold.taken('save');
  assert.deepEqual(events, ['hold']);
  hold.heard('awake', 301);
  assert.deepEqual(events, ['hold', 'release']);
  assert.equal(hold.held, false);
});

test('an established box whose folder is gone stays up, degraded: heartbeating on its key, running nothing, saying why on the thread', async () => {
  const home = tmpDir('tb-box-run-');
  const claudeDir = path.join(home, 'claude-main');
  const gone = tmpDir('tb-box-cwd-');
  // The thread as the box had it, then its folder gone.
  const h = makeHarness(home, { defaults: { cwd: gone } as never }, { boxThread: THREAD });
  h.runner.create({ text: 'go', cwd: gone, accountId: 'claude-main', id: THREAD });
  h.runner.flush();
  await h.runner.shutdown();
  fs.rmSync(gone, { recursive: true });
  fs.mkdirSync(paths.secrets(home), { recursive: true, mode: 0o700 });
  writeBoxSecrets(home, { ...secretsFor('https://github.com/x/proj.git'), bootHash: crypto.createHash('sha256').update(BOOT).digest('hex'), prepared: { checkout: gone, cwd: gone, restored: false } });
  fs.writeFileSync(path.join(paths.secrets(home), 'convex-key'), BOX_KEY, { mode: 0o600 });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'threadbear-token.json'), JSON.stringify({ token: CLAUDE_TOKEN }), { mode: 0o600 });
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let fn = '';
      try {
        fn = (JSON.parse(body) as { path: string }).path;
        seen.push(fn);
      } catch {
        // not a call
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', value: fn === 'sync:heartbeat' ? { apiVersion: 89, box: { state: 'awake' } } : null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  let out = '';
  const proc = spawn(process.execPath, ['src/main.ts'], {
    cwd: RUNNER_DIR,
    env: {
      ...process.env,
      THREADBEAR_HOME: home,
      THREADBEAR_PORT: '0',
      THREADBEAR_LOG: path.join(home, 'runner.log'),
      THREADBEAR_LOG_STDERR: '1',
      THREADBEAR_CLAUDE_PATH: '/nonexistent/claude',
      THREADBEAR_ACCOUNTS_DIR: path.join(home, 'no-accounts'),
      THREADBEAR_CLAUDE_MAIN_DIR: claudeDir,
      THREADBEAR_CLAUDE_MAIN_JSON: path.join(home, 'no-main.json'),
      THREADBEAR_CODEX_MAIN_DIR: path.join(home, 'no-codex-main'),
      THREADBEAR_TOKEN_STATS_LIMITS: path.join(home, 'no-limits.json'),
      THREADBEAR_SYNC_URL: `http://127.0.0.1:${port}`,
      [BOOT_ENV]: BOOT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited: number | null | undefined;
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  proc.once('exit', (c) => (exited = c));
  try {
    const end = Date.now() + 60_000;
    while (!(seen.includes('sync:heartbeat') && /listening on/.test(out)) && exited === undefined && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.equal(exited, undefined, out.slice(-3000));
    assert.ok(seen.includes('sync:heartbeat'), 'it heartbeats on its key');
    assert.match(out, /its folder is unusable; staying up, degraded/);
    // Said on the thread, with what was found.
    // A write's temp file can be renamed away between the listing and its read: skip it.
    const said = () => fs.readdirSync(paths.thread(home, THREAD)).map((f) => {
      try {
        const file = path.join(paths.thread(home, THREAD), f);
        return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : '';
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw e;
      }
    }).join('');
    while (!/This thread's machine can't run it: its folder .* has gone/.test(said()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.match(said(), /This thread's machine can't run it: its folder .* has gone/);
    assert.match(said(), /Found: the thread's record at/);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => (exited !== undefined ? r(null) : proc.once('exit', r)));
    server.close();
  }
});

test("while a save holds the box, its heartbeats and its save's finish say `held`; other finishes and a free box's calls don't", async () => {
  const h = makeHarness();
  const t = h.runner.create({ text: 'hi', cwd: h.cfg.defaults.cwd, accountId: 'claude-main' }).thread;
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  let push!: (v: unknown) => void;
  let held = true;
  const sync = new ConvexSync({
    config: { enabled: true, url: URL, name: 'box', runnerId: 'box0thread01' },
    key: BOX_KEY,
    runner: h.runner,
    version: '0.1.0+test',
    startedAt: '2026-11-19T00:00:00.000Z',
    clock: h.clock,
    log: nullLogger,
    post: onlyBoxCalls(async (_kind, fn, args) => {
      calls.push({ fn, args });
      if (fn === 'sync:heartbeat') return { apiVersion: 89 };
      if (fn === 'sync:takeCommand') return true;
      return null;
    }),
    subscriber: { subscribe: (fn, _a, onUpdate) => ((fn === 'sync:pendingCommands' && (push = onUpdate)), () => {}), close: () => {} },
    commands: { send: () => undefined, respondApproval: () => undefined, answerSecret: () => undefined, update: () => undefined, markSeen: () => undefined, create: () => ({ thread: t }), share: () => undefined, quickAsk: () => ({ thread: t }), save: async () => ({ bytes: 1 }) },
    box: { superseded: () => {}, held: () => held },
  });
  sync.start();
  await tick();
  push([{ commandId: 'c1', kind: 'save', threadId: t.id, args: {}, createdAt: 1 }, { commandId: 'c2', kind: 'send', threadId: t.id, args: { text: 'x' }, createdAt: 2 }]);
  await tick(10);
  const finish = (id: string) => calls.find((c) => c.fn === 'sync:finishCommand' && c.args.commandId === id)!.args;
  assert.equal(calls.find((c) => c.fn === 'sync:heartbeat')!.args.held, true);
  assert.equal(finish('c1').held, true);
  assert.equal(finish('c2').held, undefined, 'only a save is housekeeping');
  held = false;
  h.clock.advance(60_000);
  await tick();
  assert.equal(calls.filter((c) => c.fn === 'sync:heartbeat').at(-1)!.args.held, undefined);
  await sync.stop();
});

test("flushAll waits for a flush already going, runs its own to the end, and fails if anything is left or it failed", async () => {
  const h = makeHarness();
  const t = h.runner.create({ text: 'hi', cwd: h.cfg.defaults.cwd, accountId: 'claude-main' }).thread;
  let release!: () => void;
  let gate: Promise<void> | undefined;
  let fail = false;
  const upserts: number[] = [];
  const sync = new ConvexSync({
    config: { enabled: true, url: URL, name: 'box', runnerId: 'box0thread01' },
    key: BOX_KEY,
    runner: h.runner,
    version: '0.1.0+test',
    startedAt: '2026-11-19T00:00:00.000Z',
    clock: h.clock,
    log: nullLogger,
    post: onlyBoxCalls(async (_kind, fn) => {
      if (fn === 'sync:heartbeat') return { apiVersion: 89 };
      if (fn === 'sync:upsertThreads') {
        upserts.push(Date.now());
        if (gate) await gate;
        if (fail) throw new Error('network down');
      }
      return null;
    }),
    box: { superseded: () => {} },
  });
  sync.start();
  await sync.flushNow();
  // A flush under way, held up; a change made meanwhile.
  gate = new Promise((r) => (release = r));
  h.runner.update({ threadId: t.id, title: 'one' });
  void sync.flushNow();
  await tick();
  h.runner.update({ threadId: t.id, title: 'two' });
  let done = false;
  const all = sync.flushAll().then(() => (done = true));
  await tick(10);
  assert.equal(done, false, 'it waits for the flush going');
  const before = upserts.length;
  gate = undefined;
  release();
  await all;
  assert.ok(upserts.length > before, 'and then runs one of its own, with the change made meanwhile');
  // A flush that fails: so does flushAll.
  fail = true;
  h.runner.update({ threadId: t.id, title: 'three' });
  await assert.rejects(sync.flushAll(), /didn't all go up before its save: network down/);
  await sync.stop();
});

test("the provider's baseline is kept in box.json, and what else writes box.json keeps it", () => {
  const home = tmpDir('tb-box-home-');
  writeBoxSecrets(home, secretsFor('https://github.com/x/proj.git'));
  const baseline = [{ pid: 1, start: '1', cmd: '/init' }, { pid: 7, start: '7', cmd: 'hallpass' }];
  setBaseline(home, baseline);
  markSetUp(home);
  setSaveHold(home, 'saving');
  setSaveHold(home, undefined);
  assert.deepEqual(readBoxSecrets(home)?.baseline, baseline);
  assert.equal(fs.statSync(boxFile(home)).mode & 0o777, 0o600);
});


test("a fresh box's first flush goes all the way under a box key (no prune, which it can't call), its index rows too, and flushAll waits for both", async () => {
  const h = makeHarness();
  h.runner.boxThread = THREAD;
  h.runner.create({ text: 'hi', cwd: h.cfg.defaults.cwd, accountId: 'claude-main', id: THREAD });
  const calls: string[] = [];
  let indexFails = 0;
  const sync = new ConvexSync({
    config: { enabled: true, url: URL, name: 'box', runnerId: 'box0thread01' },
    key: BOX_KEY,
    home: h.home,
    runner: h.runner,
    version: '0.1.0+test',
    startedAt: '2026-11-19T00:00:00.000Z',
    clock: h.clock,
    log: nullLogger,
    post: onlyBoxCalls(async (_kind, fn) => {
      calls.push(fn);
      if (fn === 'sync:heartbeat') return { apiVersion: 89 };
      if (fn === 'sync:messageHeads') return [];
      if (fn === 'sync:setThreadIndex' && indexFails-- > 0) throw new Error('network down');
      return null;
    }),
    subscriber: { subscribe: () => () => {}, close: () => {} },
    box: { superseded: () => {} },
  });
  sync.start();
  await tick(10);
  await sync.flushAll();
  assert.deepEqual(refusedCalls.splice(0), [], 'nothing a box key would be refused');
  assert.ok(!calls.includes('sync:prune'));
  assert.ok(calls.includes('sync:upsertThreads'));
  assert.ok(calls.includes('sync:appendMessages'));
  assert.ok(calls.includes('sync:setThreadIndex'), "the sidebar index's row went up before flushAll resolved");
  // An index write that fails fails flushAll, so the save does too.
  indexFails = 1;
  h.runner.update({ threadId: THREAD, title: 'renamed' });
  await assert.rejects(sync.flushAll(), /sidebar index didn't go up before its save/);
  await sync.stop();
  assert.deepEqual(refusedCalls.splice(0), []);
});

test("a box keeps no schedules: every way to make, change or run one is refused, and nothing arms a timer or writes schedules.json", async () => {
  const h = makeHarness();
  const t = h.runner.create({ text: 'hi', cwd: h.cfg.defaults.cwd, accountId: 'claude-main' }).thread;
  // A schedules.json a box should never act on (one an agent wrote by hand).
  fs.writeFileSync(path.join(h.home, 'schedules.json'), JSON.stringify({ schedules: [{ id: 'sched1', title: 'x', text: 'go', at: new Date(h.clock.now() + 1000).toISOString(), threadId: t.id, createdAt: new Date().toISOString() }] }));
  const before = h.clock.pending();
  const sched = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, refuse: BOX_NO_SCHEDULES });
  sched.start();
  assert.equal(h.clock.pending(), before, 'no timer');
  assert.deepEqual(sched.list(), []);
  const refusal = /keeps no schedules/;
  await assert.rejects(sched.create({ text: 'check in', at: new Date(h.clock.now() + 60_000).toISOString(), threadId: t.id }), refusal);
  await assert.rejects(sched.update({ scheduleId: 'sched1', paused: true }), refusal);
  await assert.rejects(sched.delete('sched1'), refusal);
  await assert.rejects(sched.runNow('sched1'), refusal);
  await sched.attach({} as never);
  h.clock.advance(10 * 60_000);
  await tick();
  assert.equal(h.clock.pending(), before);
  assert.equal(h.adapter.sessions.length, 1, 'nothing sent to the thread');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, 'schedules.json'), 'utf8')).schedules.length, 1, 'schedules.json untouched');
});

test("a box's key isn't the owner's: create_thread on another runner files a request for the main Mac to ask", async () => {
  const h = makeHarness();
  const t = h.runner.create({ text: 'hi', cwd: h.cfg.defaults.cwd, accountId: 'claude-main' }).thread;
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const sync = new ConvexSync({
    config: { enabled: true, url: URL, name: 'box', runnerId: 'box0thread01' },
    key: BOX_KEY,
    runner: h.runner,
    version: '0.1.0+test',
    startedAt: '2026-11-19T00:00:00.000Z',
    clock: h.clock,
    log: nullLogger,
    post: onlyBoxCalls(async (_kind, fn, args) => {
      calls.push({ fn, args });
      if (fn === 'sync:heartbeat') return { apiVersion: 89 };
      return null;
    }),
    box: { superseded: () => {} },
  });
  assert.equal(sync.ownerKey(), false);
  sync.start();
  await tick();
  const created: string[] = [];
  const cross = new CrossRunner({
    self: () => ({ id: 'box0thread01', name: 'box' }),
    backend: () => sync,
    runners: async () => [{ id: 'box0thread01', name: 'box', self: true }],
    createHere: async () => (created.push('here'), { id: 'x' }),
    createThere: async () => (created.push('there'), { id: 'x' }),
    card: async () => ({ status: 'declined' }),
    openCard: async () => undefined,
    confirmStart: async () => assert.fail('a runner key cannot accept an approval'),
    releaseStart: async () => {},
    respondThere: async () => {},
    home: () => h.home,
    realDir: () => undefined,
  });
  const said = await cross.start(t.id, { runner: 'main', text: 'Look into it' });
  assert.match(String(said), /The user said no/);
  const filed = calls.find((c) => c.fn === 'relay:fileRequest');
  assert.ok(filed, 'a request filed for the main Mac');
  assert.equal(filed.args.target, 'main');
  assert.deepEqual(created, [], 'nothing started directly');
  assert.deepEqual(refusedCalls.splice(0), []);
  await sync.stop();
});

test("while a box's save goes, any other command's finish waits; ones from before go up before boxSaved, and the rest once its outcome is known", async () => {
  const h = makeHarness();
  const t = h.runner.create({ text: 'hi', cwd: h.cfg.defaults.cwd, accountId: 'claude-main' }).thread;
  const finished: string[] = [];
  let push!: (v: unknown) => void;
  let saving = false;
  let failFinish = true;
  const sync = new ConvexSync({
    config: { enabled: true, url: URL, name: 'box', runnerId: 'box0thread01' },
    key: BOX_KEY,
    runner: h.runner,
    version: '0.1.0+test',
    startedAt: '2026-11-19T00:00:00.000Z',
    clock: h.clock,
    log: nullLogger,
    post: onlyBoxCalls(async (_kind, fn, args) => {
      if (fn === 'sync:heartbeat') return { apiVersion: 89 };
      if (fn === 'sync:takeCommand') return true;
      if (fn === 'sync:messageHeads') return [];
      if (fn === 'sync:finishCommand') {
        if (failFinish) throw new Error('network down');
        finished.push(String(args.commandId));
      }
      return null;
    }),
    subscriber: { subscribe: (fn, _a, onUpdate) => ((fn === 'sync:pendingCommands' && (push = onUpdate)), () => {}), close: () => {} },
    commands: { send: () => undefined, respondApproval: () => undefined, answerSecret: () => undefined, update: () => undefined, markSeen: () => undefined, create: () => ({ thread: t }), share: () => undefined, quickAsk: () => ({ thread: t }) },
    box: { superseded: () => {}, saving: () => saving },
  });
  sync.start();
  await tick();
  // c1, taken before the save; its finish lost on the way.
  push([{ commandId: 'c1', kind: 'send', threadId: t.id, args: { text: 'a' }, createdAt: 1 }]);
  await tick(10);
  assert.deepEqual(finished, []);
  // The save starts; c2 is taken during it.
  saving = true;
  failFinish = false;
  push([{ commandId: 'c2', kind: 'send', threadId: t.id, args: { text: 'b' }, createdAt: 2 }]);
  await tick(10);
  assert.deepEqual(finished, [], "c2's finish waits");
  // The save's barrier: c1 (from before) goes, c2 still waits.
  await sync.flushAll();
  assert.deepEqual(finished, ['c1']);
  // A heartbeat while it's still going doesn't send c2.
  h.clock.advance(60_000);
  await tick(10);
  assert.deepEqual(finished, ['c1']);
  // Outcome known: the next heartbeat sends it.
  saving = false;
  h.clock.advance(60_000);
  await tick(10);
  assert.deepEqual(finished, ['c1', 'c2']);
  // A finish from before that can't go fails the barrier.
  failFinish = true;
  push([{ commandId: 'c3', kind: 'send', threadId: t.id, args: { text: 'c' }, createdAt: 3 }]);
  await tick(10);
  saving = true;
  await assert.rejects(sync.flushAll(), /finish didn't go up before the thread's save/);
  assert.deepEqual(refusedCalls.splice(0), []);
  await sync.stop();
});

test("a command's finish goes once at a time: the save's barrier waits for one already on its way rather than send it again beside it", async () => {
  const h = makeHarness();
  const t = h.runner.create({ text: 'hi', cwd: h.cfg.defaults.cwd, accountId: 'claude-main' }).thread;
  const sent: string[] = [];
  let push!: (v: unknown) => void;
  let gate: Promise<void> | undefined;
  let open!: () => void;
  let fail = true;
  const sync = new ConvexSync({
    config: { enabled: true, url: URL, name: 'box', runnerId: 'box0thread01' },
    key: BOX_KEY,
    runner: h.runner,
    version: '0.1.0+test',
    startedAt: '2026-11-19T00:00:00.000Z',
    clock: h.clock,
    log: nullLogger,
    post: onlyBoxCalls(async (_kind, fn, args) => {
      if (fn === 'sync:heartbeat') return { apiVersion: 89 };
      if (fn === 'sync:takeCommand') return true;
      if (fn === 'sync:messageHeads') return [];
      if (fn === 'sync:finishCommand') {
        sent.push(String(args.commandId));
        if (gate) await gate;
        if (fail) throw new Error('network down');
      }
      return null;
    }),
    subscriber: { subscribe: (fn, _a, onUpdate) => ((fn === 'sync:pendingCommands' && (push = onUpdate)), () => {}), close: () => {} },
    commands: { send: () => undefined, respondApproval: () => undefined, answerSecret: () => undefined, update: () => undefined, markSeen: () => undefined, create: () => ({ thread: t }), share: () => undefined, quickAsk: () => ({ thread: t }) },
    box: { superseded: () => {} },
  });
  sync.start();
  await tick();
  // Its first try fails; a heartbeat's retry is then held up on its way.
  push([{ commandId: 'c1', kind: 'send', threadId: t.id, args: { text: 'a' }, createdAt: 1 }]);
  await tick(10);
  assert.deepEqual(sent, ['c1']);
  fail = false;
  gate = new Promise((r) => (open = r));
  h.clock.advance(60_000);
  await tick(10);
  assert.deepEqual(sent, ['c1', 'c1'], 'the retry is on its way');
  // The barrier starts meanwhile: it waits for that one and, as it went, sends none of its own.
  const barrier = sync.flushAll();
  await tick(10);
  assert.deepEqual(sent, ['c1', 'c1']);
  gate = undefined;
  open();
  await barrier;
  assert.deepEqual(sent, ['c1', 'c1']);
  assert.deepEqual(refusedCalls.splice(0), []);
  await sync.stop();
});


// ------------------------------------------------------------ a refused cloud token (slice 5, API 94)

test("the exchange's tokenSetAt is kept with the box's secrets; an older backend's answer has none", async () => {
  for (const [given, kept] of [[1234, 1234], [undefined, undefined]] as const) {
    const home = tmpDir('tb-box-tok-');
    const post: ActionPost = async () => exchanged(given === undefined ? {} : { tokenSetAt: given });
    const { secrets } = await bootBox({ boot: { bootToken: BOOT, syncUrl: URL }, home, claudeDir: tmpDir('tb-box-claude-'), post, log: nullLogger });
    assert.equal(secrets.tokenSetAt, kept);
    assert.equal(readBoxSecrets(home)?.tokenSetAt, kept);
  }
});

const notesOf = (h: ReturnType<typeof makeHarness>, id: string) => h.events(id).filter((e: { type: string }) => e.type === 'system.note').map((e: { text: string }) => e.text);
const sentTo = (h: ReturnType<typeof makeHarness>, id: string) => h.events(id).filter((e: { type: string }) => e.type === 'user.message').map((e: { text: string }) => e.text);

test("a box's turn refused with its cloud token: one note, the thread waits (a message queues behind it), and the backend is told", async () => {
  const h = makeHarness(tmpDir(), {}, { boxThread: THREAD });
  const told: string[] = [];
  h.runner.onBoxTokenRefused = (id) => void told.push(id);
  h.runner.create({ text: 'go', cwd: h.cfg.defaults.cwd, accountId: 'claude-main', id: THREAD });
  const s = h.adapter.last;
  s.init();
  s.result('failed', undefined, 'Invalid bearer token', { errorKind: 'auth' });
  await tick();
  const rec = h.runner.threads.get(THREAD)!.rec;
  assert.ok(rec.waitingForToken);
  assert.deepEqual(told, [THREAD]);
  assert.deepEqual(notesOf(h, THREAD).filter((n) => /refused this box's token/.test(n)).length, 1);
  assert.equal(rec.accountId, 'claude-main', 'no pool move in a box');
  // Mike's message waits rather than start a doomed turn.
  const before = h.adapter.sessions.length;
  h.runner.send(THREAD, 'are you there', []);
  assert.equal(h.adapter.sessions.length, before);
  assert.equal(rec.queue.length, 1);
  // A newer token: his message goes, not the runner's carry-on.
  h.runner.tokenReplaced(THREAD);
  assert.equal(rec.waitingForToken, undefined);
  await tick();
  assert.equal(h.adapter.sessions.length, before + 1);
  assert.deepEqual(sentTo(h, THREAD).slice(-1), ['are you there']);
});

test('with nothing queued, a newer token carries the thread on by itself, on a fresh CLI; a restart while waiting waits again', async () => {
  const home = tmpDir();
  const h = makeHarness(home, {}, { boxThread: THREAD });
  h.runner.onBoxTokenRefused = () => {};
  h.runner.create({ text: 'go', cwd: h.cfg.defaults.cwd, accountId: 'claude-main', id: THREAD });
  const s = h.adapter.last;
  s.init();
  s.result('failed', undefined, 'Invalid bearer token', { errorKind: 'auth' });
  await tick();
  h.runner.flush();
  // Started again while waiting: still held.
  const again = makeHarness(home, {}, { boxThread: THREAD });
  again.runner.onBoxTokenRefused = () => {};
  const before = again.adapter.sessions.length;
  again.runner.send(THREAD, 'hello?', []);
  assert.equal(again.adapter.sessions.length, before, 'held after a restart');
  again.runner.threads.get(THREAD)!.rec.queue.length = 0;
  again.runner.tokenReplaced(THREAD);
  await tick();
  assert.equal(again.adapter.sessions.length, before + 1);
  assert.equal(sentTo(again, THREAD).at(-1), CARRY_ON_TOKEN);
});

test("the token watch quarantines its own grant, then writes an owner-approved replacement and lets the thread go", async () => {
  const s = await boxBackend();
  const boxes = load('boxes');
  const got = await s.boot();
  const home = tmpDir('tb-box-watch-');
  const claudeDir = tmpDir('tb-box-claude-');
  writeBoxSecrets(home, { version: 1, bootHash: 'h', syncUrl: URL, boxKey: got.boxKey, runnerId: got.runnerId, threadId: got.threadId, threadKey: got.threadKey, repo: got.repo, save: null, tokenSetAt: got.tokenSetAt });
  const post = onlyBoxCalls(async (kind, fn, args) => {
    const name = fn.split(':')[1]!;
    return call((kind as string) === 'action' ? s.a : s.ctx, boxes[name], args);
  }) as unknown as ActionPost;
  const timers: { fn: () => void; ms: number }[] = [];
  let waiting: { refusedSetAt?: number; reported?: boolean } | undefined = { refusedSetAt: got.tokenSetAt, reported: false };
  let held = false;
  let replaced = 0;
  const watch = new BoxTokenWatch({ home, claudeDir, key: got.boxKey, post, log: nullLogger, setTimeout: (fn, ms) => (timers.push({ fn, ms }), { cancel: () => {} }), held: () => held, waiting: () => waiting, markReported: () => void (waiting!.reported = true), replaced: () => void replaced++ });
  watch.refused();
  await watch.tick();
  assert.equal(s.rows('cloudTokens')[0].tokenState.kind, 'valid', 'the report leaves the shared login available');
  assert.equal(s.rows('boxTokenGrants')[0].grantState.kind, 'refused', 'only this box is quarantined');
  assert.equal(replaced, 0);
  assert.equal(timers.at(-1)!.ms, 30_000, 'asks again in 30 seconds');
  // A save holding the box: nothing fetched or written.
  const fresh = `sk-ant-oat01-${'F'.repeat(60)}`;
  await s.setToken(fresh);
  await call(s.ctx, boxes.releaseForToken, { login: s.box().login });
  held = true;
  await watch.tick();
  assert.equal(replaced, 0);
  assert.equal(readYearToken(claudeDir), undefined);
  held = false;
  await watch.tick();
  assert.equal(replaced, 1);
  assert.equal(readYearToken(claudeDir)?.token, fresh);
  assert.equal(fs.statSync(path.join(claudeDir, 'threadbear-token.json')).mode & 0o777, 0o600);
  assert.ok((readBoxSecrets(home)?.tokenSetAt ?? 0) > (got.tokenSetAt ?? 0));
  assert.deepEqual(refusedCalls.filter((f) => f.startsWith('boxes:')), [], 'only calls a box key may make');
  waiting = undefined;
  watch.stop();
});

// Codex's review of slice 5, 4 and 5: the refusal is the refused token's
// version, kept on the record with whether the backend has heard, so a
// restart replays it and a token installed since (an exchange after a
// restore) lifts the hold without ever being reported.

type Waiting = { refusedSetAt?: number; reported?: boolean };
function fakeWatch(home: string, waiting: () => Waiting | undefined, post: ActionPost, extra: { reported?: () => void } = {}) {
  const timers: { fn: () => void; ms: number }[] = [];
  let replaced = 0;
  const watch = new BoxTokenWatch({ home, claudeDir: tmpDir('tb-box-claude-'), key: 'tbb_' + 'b'.repeat(64), post, log: nullLogger, setTimeout: (fn, ms) => (timers.push({ fn, ms }), { cancel: () => {} }), held: () => false, waiting, markReported: extra.reported ?? (() => {}), replaced: () => void replaced++ });
  return { watch, timers, replaced: () => replaced };
}
function boxHome(tokenSetAt: number): string {
  const home = tmpDir('tb-box-tok-');
  writeBoxSecrets(home, { version: 1, bootHash: 'h', syncUrl: URL, boxKey: 'tbb_' + 'b'.repeat(64), runnerId: 'abcdef123456', threadId: THREAD, threadKey: 'k', repo: { origin: 'https://github.com/a/b.git', subfolder: '', baseBranch: 'main' }, save: null, tokenSetAt });
  return home;
}

test('a legacy wait retries the installed token without falsely reporting a fresh exchange', async () => {
  for (const installed of [1000, 2000]) {
    const calls: string[] = [];
    const w = fakeWatch(boxHome(installed), () => ({ reported: true }), async (_kind, fn) => { calls.push(fn); return null; });
    await w.watch.tick();
    assert.equal(w.replaced(), 1, 'one retry establishes whether the installed token really fails');
    assert.deepEqual(calls, [], 'a saved refusal without a version says nothing about this exchange');
    w.watch.stop();
  }
});

test('boot secrets without a token version fetch an approved snapshot before retrying a legacy wait', async () => {
  const home = boxHome(0);
  const calls: string[] = [];
  const w = fakeWatch(home, () => ({ reported: true }), async (_kind, fn) => {
    calls.push(fn);
    return { token: `sk-ant-oat01-${'V'.repeat(60)}`, setAt: 2000 };
  });
  await w.watch.tick();
  assert.deepEqual(calls, ['boxes:boxCloudToken']);
  assert.equal(readBoxSecrets(home)?.tokenSetAt, 2000);
  assert.equal(w.replaced(), 1);
  w.watch.stop();
});

test('a hold restored from a save, on a box whose exchange already installed a newer token, lifts at start, and that token is never reported', async () => {
  const home = boxHome(2000);
  const calls: string[] = [];
  const post: ActionPost = async (_k, fn) => {
    calls.push(fn);
    return { token: `sk-ant-oat01-${'B'.repeat(60)}`, setAt: 2000 };
  };
  let waiting: Waiting | undefined = { refusedSetAt: 1000, reported: true };
  const w = fakeWatch(home, () => waiting, post);
  w.watch.start();
  await w.watch.tick();
  assert.equal(w.replaced(), 1, 'the token on the box is newer than the one refused');
  assert.ok(!calls.includes('boxes:tokenRefused'), 'B is never reported as refused');
  // Unreported too: the newer token makes the old refusal moot, and nothing kills B.
  waiting = { refusedSetAt: 1000, reported: false };
  const again = fakeWatch(home, () => waiting, post);
  again.watch.start();
  await again.watch.tick();
  assert.equal(again.replaced(), 1);
  assert.ok(!calls.includes('boxes:tokenRefused'));
});

test("a refusal the backend didn't hear before a restart is sent on the next start, with the refused token's version", async () => {
  const home = boxHome(1000);
  const sent: { fn: string; args: Record<string, unknown> }[] = [];
  let fail = true;
  const post: ActionPost = async (_k, fn, args) => {
    sent.push({ fn, args: args as Record<string, unknown> });
    if (fn === 'boxes:tokenRefused' && fail) throw new Error('network down');
    return null;
  };
  const rec: Waiting = { refusedSetAt: 1000, reported: false };
  const first = fakeWatch(home, () => rec, post, { reported: () => void (rec.reported = true) });
  first.watch.refused();
  await first.watch.tick();
  assert.equal(rec.reported, false, 'not heard: still owed');
  first.watch.stop();
  // The runner restarts: the record is all there is.
  fail = false;
  sent.length = 0;
  const second = fakeWatch(home, () => rec, post, { reported: () => void (rec.reported = true) });
  second.watch.start();
  await second.watch.tick();
  const told = sent.filter((s) => s.fn === 'boxes:tokenRefused');
  assert.equal(told.length, 1);
  assert.equal(told[0]!.args.setAt, 1000);
  assert.equal(rec.reported, true);
  // Once heard, never again.
  await second.watch.tick();
  assert.equal(sent.filter((s) => s.fn === 'boxes:tokenRefused').length, 1);
});

test("a refused turn keeps the refused token's version on the record, unreported until the watch says so, across a restart", async () => {
  const home = tmpDir();
  const h = makeHarness(home, {}, { boxThread: THREAD });
  h.runner.onBoxTokenRefused = () => {};
  h.runner.boxTokenSetAt = () => 1234;
  h.runner.create({ text: 'go', cwd: h.cfg.defaults.cwd, accountId: 'claude-main', id: THREAD });
  const s = h.adapter.last;
  s.init();
  s.result('failed', undefined, 'Invalid bearer token', { errorKind: 'auth' });
  await tick();
  const rec = h.runner.threads.get(THREAD)!.rec;
  assert.equal(rec.waitingForToken?.refusedSetAt, 1234);
  assert.equal(rec.waitingForToken?.reported, false);
  h.runner.tokenRefusalReported(THREAD);
  h.runner.flush();
  const again = makeHarness(home, {}, { boxThread: THREAD });
  assert.equal(again.runner.threads.get(THREAD)!.rec.waitingForToken?.reported, true);
  assert.equal(again.runner.threads.get(THREAD)!.rec.waitingForToken?.refusedSetAt, 1234);
});
