import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AppServerProcess,
  ChildThreads,
  CodexExitedError,
  LineReader,
  RateLimitTracker,
  codexEnv,
  fallbackCodexPath,
  nativeBinaryFor,
  parseUserAgentVersion,
  resolveCodexBinary,
  type OversizedLine,
} from '../../src/adapters/codex/appserver.ts';
import * as surface from '../../src/adapters/codex/surface.ts';
import { limitsFromRateLimits } from '../../src/adapters/codex/normalize.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { nullLogger } from '../../src/log.ts';
import type { Account } from '../../src/protocol.ts';
import { FakeCodex } from '../helpers/fake-app-server.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';

const dirs: string[] = [];
function tmp(prefix = 'tb-cx-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
const fakes: FakeCodex[] = [];
after(async () => {
  for (const f of fakes) await f.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const account: Account = { id: 'codex-main', provider: 'codex', title: 'Codex · someone@example.com', configDir: '/work/codex-home' };

// One fake for the file: the first run of a freshly written script costs
// about 400 ms on macOS, and each test takes its own processes from it.
let shared: Promise<FakeCodex> | undefined;
function fake(): Promise<FakeCodex> {
  shared ??= FakeCodex.create().then((f) => (fakes.push(f), f));
  return shared;
}

function proc(bin: string, extra: Partial<ConstructorParameters<typeof AppServerProcess>[0]> = {}): AppServerProcess {
  return new AppServerProcess({
    binary: bin,
    account,
    cwd: os.tmpdir(),
    registry: new ProcessRegistry(tmp(), nullLogger),
    log: nullLogger,
    label: 'test',
    env: { THREADBEAR_THREAD_ID: 'tb-thread-1' },
    // The retry window runs from the first spawn, so a slow first start used
    // to use it all up and the retry a test waited for never came.
    timings: { spawnRetryMs: 100, spawnRetryForMs: PATIENCE_MS, closeWaitMs: 2000 },
    ...extra,
  });
}

// ---- Pure parts

test('the running version comes from userAgent, not the thread', () => {
  assert.equal(parseUserAgentVersion('threadbear/0.164.0 (Mac OS 26.6.2; arm64) unknown (threadbear; 0.1.0)'), '0.164.0');
  assert.equal(parseUserAgentVersion('threadbear-research/0.165.0-alpha.2 (Mac OS 26.6.2; arm64)'), '0.165.0-alpha.2');
  assert.equal(parseUserAgentVersion('nonsense'), undefined);
  assert.equal(parseUserAgentVersion(undefined), undefined);
});

test('the line reader splits chunks into lines, however they arrive', () => {
  const lines: string[] = [];
  const r = new LineReader(1024, (l) => lines.push(l.toString()), () => assert.fail('no line is over the guard'));
  r.push(Buffer.from('{"a":1}\n{"b"'));
  r.push(Buffer.from(':2}\n'));
  r.push(Buffer.from('{"c":3}\n\n{"d":4}'));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
  r.push(Buffer.from('\n'));
  assert.deepEqual(lines.at(-1), '{"d":4}');
});

test('a line over the guard is skipped to its newline and described, and the next line reads', () => {
  const lines: string[] = [];
  const big: OversizedLine[] = [];
  const r = new LineReader(200_000, (l) => lines.push(l.toString()), (i) => big.push(i));
  const huge = JSON.stringify({
    method: 'item/completed',
    params: { item: { type: 'imageGeneration', id: 'ig_1', result: 'A'.repeat(500_000) }, threadId: 'th_1', turnId: 'tu_1' },
  });
  // In pieces, as a pipe delivers it.
  const buf = Buffer.from(huge + '\n{"after":true}\n');
  for (let i = 0; i < buf.length; i += 65_536) r.push(buf.subarray(i, i + 65_536));
  assert.equal(big.length, 1);
  assert.deepEqual({ ...big[0], bytes: 0 }, { bytes: 0, method: 'item/completed', itemType: 'imageGeneration', itemId: 'ig_1', threadId: 'th_1', turnId: 'tu_1' });
  assert.equal(big[0].bytes, Buffer.byteLength(huge));
  assert.deepEqual(lines, ['{"after":true}']);
});

test('rate-limit updates are merged into the snapshot read at start', () => {
  const t = new RateLimitTracker();
  const read = t.read({
    ordinaryUsageAllowed: true,
    rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 100 }, secondary: null, credits: { balance: '1' }, planType: 'prolite', rateLimitReachedType: null, spendControlReached: false },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', limitName: null, primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 100 }, secondary: null, credits: null, planType: 'prolite', rateLimitReachedType: null },
      codex_other: { limitId: 'codex_other', limitName: 'GPT-6-Astra', primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 50 }, secondary: null, credits: null, planType: null, rateLimitReachedType: null },
    },
  });
  assert.equal(read.rateLimits.primary?.usedPercent, 5);
  // Only a read carries the resets; every reading after it repeats them.
  const counted = new RateLimitTracker();
  counted.read({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', limitName: null, primary: null, secondary: null, credits: null, planType: null, rateLimitReachedType: null }, rateLimitsByLimitId: null, rateLimitResetCredits: { availableCount: 2, credits: null } });
  assert.equal(counted.update({ rateLimits: { limitId: 'codex', primary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1 } } }).rateLimitResetCredits?.availableCount, 2);
  // An update for one bucket, with nulls for what it doesn't know.
  const u = t.update({ rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 100 }, secondary: null, credits: null, planType: 'prolite', rateLimitReachedType: null, spendControlReached: null } });
  assert.equal(u.rateLimits.primary?.usedPercent, 7);
  assert.equal(u.rateLimits.spendControlReached, null, 'an explicit null clears what was known');
  assert.equal(u.rateLimits.limitName, null);
  assert.equal(u.ordinaryUsageAllowed, true);
  assert.equal(u.rateLimitsByLimitId?.codex_other?.limitName, 'GPT-6-Astra');
  const v = t.update({ rateLimits: { limitId: 'codex_other', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 60 } } });
  assert.equal(v.rateLimitsByLimitId?.codex_other?.primary?.usedPercent, 40);
  assert.equal(v.rateLimits.primary?.usedPercent, 7, 'the main bucket is untouched');
  // Blocked, then a reset: the update's null rateLimitReachedType lifts it.
  const blocked = new RateLimitTracker();
  blocked.read({
    ordinaryUsageAllowed: false,
    rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 100 }, secondary: null, credits: null, planType: 'prolite', rateLimitReachedType: 'rate_limit_reached' },
    rateLimitsByLimitId: null,
  });
  assert.equal(limitsFromRateLimits(blocked.current())!.blocked, true);
  const lifted = blocked.update({ rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 200 }, secondary: null, credits: null, planType: 'prolite', rateLimitReachedType: null } });
  assert.equal(lifted.rateLimits.rateLimitReachedType, null);
  assert.equal(limitsFromRateLimits(lifted)!.blocked, false);
  // And an update that says ordinaryUsageAllowed outright wins.
  const said = new RateLimitTracker();
  said.read({ ordinaryUsageAllowed: false, rateLimits: { limitId: 'codex', limitName: null, primary: null, secondary: null, credits: null, planType: null, rateLimitReachedType: 'rate_limit_reached' }, rateLimitsByLimitId: null });
  assert.equal(limitsFromRateLimits(said.update({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', rateLimitReachedType: null } }))!.blocked, false);
  // A read whose reply comes after a newer update doesn't undo it.
  const raced = new RateLimitTracker();
  const since = raced.mark();
  raced.update({ rateLimits: { limitId: 'codex', primary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 100 }, secondary: null } });
  const late = raced.read({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 100 }, secondary: null, credits: { balance: '1' }, planType: 'prolite', rateLimitReachedType: null } as never, rateLimitsByLimitId: null }, since);
  assert.equal(late.rateLimits.primary?.usedPercent, 9);
  assert.deepEqual(late.rateLimits.credits, { balance: '1' }, 'what only the read knows is kept');
  // An update before any read still makes a snapshot.
  const fresh = new RateLimitTracker().update({ rateLimits: { limitId: null, primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1 }, secondary: null } });
  assert.equal(fresh.rateLimits.limitId, 'codex');
  assert.equal(fresh.rateLimits.primary?.usedPercent, 3);
});

test('children are learned from subAgentActivity, thread/started and collab receivers', () => {
  const c = new ChildThreads();
  c.learn('item/started', { item: { type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/x' } }, 'root');
  c.learn('item/started', { item: { type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child-9' } }, 'root');
  c.learn('thread/started', { thread: { id: 'child-2', parentThreadId: 'root' } }, 'root');
  c.learn('thread/started', { thread: { id: 'grandchild', parentThreadId: 'child-2' } }, 'root');
  c.learn('thread/started', { thread: { id: 'stranger', parentThreadId: 'someone-else' } }, 'root');
  c.learn('item/completed', { item: { type: 'collabAgentToolCall', receiverThreadIds: ['child-3'] } }, 'root');
  assert.deepEqual(c.ids().sort(), ['child-1', 'child-2', 'child-3', 'grandchild']);
});

test('the environment points CODEX_HOME at the account and drops inherited sessions', () => {
  const env = codexEnv(
    { ...account, configDir: '/accounts/codex-1' },
    { THREADBEAR_THREAD_ID: 't1', PATH: '/runner/bin:/usr/bin' },
    '/pkg/@openai/codex',
    { PATH: '/usr/bin', HOME: '/home/x', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/c', CODEX_THREAD_ID: 'parent', CODEX_HOME: '/elsewhere', CODEX_SANDBOX: 'seatbelt' },
  );
  assert.equal(env.CODEX_HOME, '/accounts/codex-1');
  assert.equal(env.CODEX_MANAGED_BY_NPM, '1');
  assert.equal(env.CODEX_MANAGED_PACKAGE_ROOT, '/pkg/@openai/codex');
  assert.equal(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, 'Threadbear');
  assert.equal(env.THREADBEAR_THREAD_ID, 't1');
  assert.equal(env.PATH, '/runner/bin:/usr/bin');
  assert.equal(env.HOME, '/home/x');
  for (const k of ['CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'CODEX_THREAD_ID', 'CODEX_SANDBOX']) assert.equal(env[k], undefined, k);
});

// ---- Finding the native binary

// Lays out an npm install of @openai/codex the way npm does, with the
// platform package hoisted or nested.
function npmLayout(root: string, o: { nested: boolean; version?: string }): { launcher: string; native: string; pkgRoot: string } {
  const pkgRoot = path.join(root, 'node_modules', '@openai', 'codex');
  fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: o.version ?? '0.164.0' }));
  fs.writeFileSync(path.join(pkgRoot, 'bin', 'codex.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const platBase = o.nested ? path.join(pkgRoot, 'node_modules') : path.join(root, 'node_modules');
  const plat = path.join(platBase, '@openai', 'codex-darwin-arm64');
  const native = path.join(plat, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(path.join(plat, 'package.json'), JSON.stringify({ name: '@openai/codex-darwin-arm64', version: o.version ?? '0.164.0' }));
  fs.writeFileSync(native, '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  const launcher = path.join(root, 'node_modules', '.bin', 'codex');
  fs.symlinkSync('../@openai/codex/bin/codex.js', launcher);
  return { launcher, native: fs.realpathSync(native), pkgRoot: fs.realpathSync(pkgRoot) };
}

test('the native binary is found behind the launcher, hoisted or nested', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, () => {
  for (const nested of [false, true]) {
    const root = tmp();
    const { launcher, native, pkgRoot } = npmLayout(root, { nested });
    const fromLauncher = resolveCodexBinary(launcher);
    assert.deepEqual(fromLauncher, { command: native, args: [], native: true, packageRoot: pkgRoot }, `nested: ${nested}`);
    // A prefix folder (Threadbear's own copies) and a link to one.
    assert.equal(resolveCodexBinary(root).command, native);
    const current = path.join(tmp(), 'current');
    fs.symlinkSync(root, current);
    assert.equal(resolveCodexBinary(current).command, native);
    assert.equal(nativeBinaryFor(path.join(pkgRoot, 'bin', 'codex.js')), native);
  }
});

test('without the platform package the launcher itself runs, through Node', () => {
  const root = tmp();
  const { launcher, pkgRoot } = npmLayout(root, { nested: false });
  fs.rmSync(path.join(root, 'node_modules', '@openai', 'codex-darwin-arm64'), { recursive: true });
  const r = resolveCodexBinary(launcher, '/usr/local/bin/node');
  assert.deepEqual(r, { command: '/usr/local/bin/node', args: [path.join(pkgRoot, 'bin', 'codex.js')], native: false, packageRoot: pkgRoot });
});

test('a binary set by hand, or one that is missing, is spawned as given', () => {
  const f = path.join(tmp(), 'my-codex');
  fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
  assert.deepEqual(resolveCodexBinary(f), { command: f, args: [], native: false });
  assert.deepEqual(resolveCodexBinary('/nowhere/codex'), { command: '/nowhere/codex', args: [], native: false });
  // npm's codex link beside node; on Windows the package's codex.js, as its codex.cmd needs a shell.
  assert.equal(fallbackCodexPath('/x/node/bin/node', 'darwin'), '/x/node/bin/codex');
  assert.equal(fallbackCodexPath('C:\\node\\node.exe', 'win32'), 'C:\\node\\node_modules\\@openai\\codex\\bin\\codex.js');
});

// ---- A real process

test('handshake: initialize with the opt-outs, then initialized; version and binary recorded', async () => {
  const f = await fake();
  const p = proc(f.bin, { args: ['--disable', 'memories'] });
  const started = p.start();
  const conn = await f.next();
  const init = await conn.init('0.165.0');
  const r = await started;
  assert.equal(r.codexHome, '/work/codex-home');
  assert.equal(p.version, '0.165.0');
  assert.equal(p.binaryPath, f.bin);
  assert.deepEqual(conn.hello.argv, ['app-server', '--disable', 'memories']);
  assert.equal(conn.hello.env.CODEX_HOME, '/work/codex-home');
  assert.equal(conn.hello.env.THREADBEAR_THREAD_ID, 'tb-thread-1');
  assert.equal(conn.hello.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, 'Threadbear');
  const params = init.params as { clientInfo: { name: string }; capabilities: { experimentalApi: boolean; optOutNotificationMethods: string[] } };
  assert.equal(params.clientInfo.name, 'threadbear');
  assert.equal(params.capabilities.experimentalApi, true);
  assert.deepEqual(params.capabilities.optOutNotificationMethods, ['turn/diff/updated', 'turn/moderationMetadata', 'remoteControl/status/changed']);
  assert.equal(Object.hasOwn(init, 'jsonrpc'), false, 'no "jsonrpc" field on this wire');
  await p.close();
  await conn.closed;
});

test('ids: ours count from 1, Codex numbers its own requests from 0, and emittedAtMs is ignored', async () => {
  const f = await fake();
  const p = proc(f.bin);
  const started = p.start();
  const conn = await f.next();
  const init = await conn.init();
  await started;
  assert.equal(init.id, 1);
  const notes: [string, unknown][] = [];
  p.onNotification = (m, params) => notes.push([m, params]);
  const asked: [unknown, string][] = [];
  p.onRequest = (id, method) => {
    asked.push([id, method]);
    p.respond(id, { ok: true });
  };
  const answer = await conn.serverRequest('currentTime/read', {});
  assert.deepEqual(answer, { id: 0, result: { ok: true } });
  // Our next request has id 2 even though Codex's was 0: separate spaces.
  const q = p.request('model/list', {});
  const req = await conn.request('model/list');
  assert.equal(req.id, 2);
  conn.respond(req.id, { data: [], nextCursor: null });
  assert.deepEqual(await q, { data: [], nextCursor: null });
  conn.notify('warning', { threadId: null, message: 'hi' });
  await waitFor(() => notes.length === 1);
  assert.deepEqual(notes[0], ['warning', { threadId: null, message: 'hi' }]);
  // An error reply rejects with Codex's message and code.
  const bad = p.request('thread/read', { threadId: 'x' });
  const r2 = await conn.request('thread/read');
  conn.fail(r2.id, -32600, 'no rollout found for thread id x');
  await assert.rejects(bad, (e: Error & { code?: number }) => e.message === 'no rollout found for thread id x' && e.code === -32600);
  await p.close();
});

test('a request with no session attached is refused at once', async () => {
  const f = await fake();
  const p = proc(f.bin);
  const started = p.start();
  const conn = await f.next();
  await conn.init();
  await started;
  // onRequest is null: nothing attached.
  assert.deepEqual((await conn.serverRequest('item/commandExecution/requestApproval', { threadId: 't', itemId: 'i' })).result, { decision: 'cancel' });
  assert.deepEqual((await conn.serverRequest('item/fileChange/requestApproval', { threadId: 't', itemId: 'i' })).result, { decision: 'cancel' });
  assert.deepEqual((await conn.serverRequest('mcpServer/elicitation/request', { threadId: 't' })).result, { action: 'decline', content: null, _meta: null });
  const other = await conn.serverRequest('attestation/generate', {});
  assert.equal((other.error as { code: number }).code, -32601);
  await p.close();
});

test('a 2.5 MB line reads whole; a line over the guard fails only itself', async () => {
  const f = await fake();
  const p = proc(f.bin, { maxLineBytes: 1_000_000 });
  const started = p.start();
  const conn = await f.next();
  await conn.init();
  await started;
  const notes: [string, unknown][] = [];
  const big: OversizedLine[] = [];
  p.onNotification = (m, params) => notes.push([m, params]);
  p.onOversize = (i) => big.push(i);
  const result = 'B'.repeat(900_000);
  conn.notify('item/completed', { item: { type: 'imageGeneration', id: 'ig_ok', result }, threadId: 't1', turnId: 'u1' });
  conn.notify('item/completed', { item: { type: 'imageGeneration', id: 'ig_huge', result: 'C'.repeat(2_500_000) }, threadId: 't1', turnId: 'u1' });
  conn.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed' } });
  // 3.4 MB through a pipe and JSON.parse: the default 3 s timed out in
  // ./check.sh with the Mac's load average over 500 (29 Oct 2026).
  await waitFor(() => notes.length === 2);
  assert.equal((notes[0][1] as { item: { result: string } }).item.result.length, 900_000);
  assert.equal(notes[1][0], 'turn/completed');
  assert.equal(big.length, 1);
  assert.equal(big[0].itemId, 'ig_huge');
  assert.equal(big[0].threadId, 't1');
  // Still alive and answering.
  const q = p.request('model/list', {});
  conn.respond((await conn.request('model/list')).id, { data: [] });
  await q;
  await p.close();
});

test('closing stdin ends the process; a pending request fails as exited', async () => {
  const f = await fake();
  // The kill can't come within this test's limit, so finishing in time means
  // closing stdin is what ended it, however busy the Mac is.
  const p = proc(f.bin, { timings: { spawnRetryMs: 100, spawnRetryForMs: PATIENCE_MS, closeWaitMs: PATIENCE_MS } });
  const started = p.start();
  const conn = await f.next();
  await conn.init();
  await started;
  let exitedWith: Error | undefined | null = null;
  p.onExit = (e) => (exitedWith = e);
  const pending = p.request('model/list', {});
  await conn.request('model/list');
  const t0 = Date.now();
  await p.close();
  assert.ok(Date.now() - t0 < PATIENCE_MS, 'it exits when stdin closes, without the kill');
  await assert.rejects(pending, CodexExitedError);
  assert.equal(exitedWith, undefined, 'a close on purpose reports no error');
  assert.equal(p.alive, false);
});

test('a process that dies reports its exit with the stderr tail', async () => {
  const f = await fake();
  const p = proc(f.bin);
  const started = p.start();
  const conn = await f.next();
  await conn.init();
  await started;
  const exited = new Promise<Error | undefined>((r) => (p.onExit = r));
  conn.stderr('thread panicked: something broke\n');
  await new Promise((r) => setTimeout(r, 50));
  conn.exit(101);
  const e = await exited;
  assert.match(e!.message, /code 101/);
  assert.match(e!.message, /something broke/);
});

test('spawn retry: a binary that appears a moment later', async () => {
  const f = await fake();
  const late = path.join(tmp(), 'codex-late');
  const p = proc(late);
  const started = p.start();
  await new Promise((r) => setTimeout(r, 250));
  f.install(late);
  const conn = await f.next();
  await conn.init();
  await started;
  assert.equal(p.version, '0.164.0');
  await p.close();
});

test('spawn retry: a process that exits before initialize is started again', async () => {
  const f = await fake();
  const p = proc(f.bin);
  const started = p.start();
  const first = await f.next();
  await first.request('initialize');
  first.exit(1);
  const second = await f.next();
  await second.init();
  await started;
  assert.notEqual(first.hello.pid, second.hello.pid);
  await p.close();
});

test('spawn retry gives up after its window', async () => {
  const p = proc('/nowhere/codex', { timings: { spawnRetryMs: 50, spawnRetryForMs: 200 } });
  await assert.rejects(p.start(), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
});

test('a request Codex never answers times out', async () => {
  const f = await fake();
  const p = proc(f.bin);
  const started = p.start();
  const conn = await f.next();
  await conn.init();
  await started;
  await assert.rejects(p.request('model/list', {}, 150), /didn't answer model\/list within/);
  await p.close();
});

async function waitFor(cond: () => boolean, ms = PATIENCE_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---- The protocol surface (surface.ts)

// A generated-ts folder with exactly what the lists name, so one name can
// be taken away or added at a time.
function generated(o: { drop?: string[]; addNotification?: string; addItem?: string } = {}): string {
  const dir = tmp('tb-cx-gen-');
  fs.mkdirSync(path.join(dir, 'v2'));
  const drop = new Set(o.drop ?? []);
  const union = (names: string[]) => names.filter((n) => !drop.has(n)).map((n) => `{ "method": "${n}", id: RequestId, params: P }`).join(' | ');
  const notes = [...surface.USED_NOTIFICATIONS, ...surface.IGNORED_NOTIFICATIONS, ...(o.addNotification ? [o.addNotification] : [])];
  fs.writeFileSync(path.join(dir, 'ServerNotification.ts'), `export type ServerNotification = ${notes.filter((n) => !drop.has(n)).map((n) => `{ "method": "${n}", "params": P }`).join(' | ')};`);
  fs.writeFileSync(path.join(dir, 'ClientRequest.ts'), `export type ClientRequest = ${union(surface.CLIENT_REQUESTS)};`);
  fs.writeFileSync(path.join(dir, 'ClientNotification.ts'), `export type ClientNotification = ${union(surface.CLIENT_NOTIFICATIONS)};`);
  fs.writeFileSync(path.join(dir, 'ServerRequest.ts'), `export type ServerRequest = ${union([...surface.SERVER_REQUESTS, ...surface.OPTIONAL_SERVER_REQUESTS, ...surface.REFUSED_SERVER_REQUESTS])};`);
  const items = { ...surface.ITEM_FIELDS, ...Object.fromEntries(surface.IGNORED_ITEMS.map((t) => [t, []])), ...(o.addItem ? { [o.addItem]: [] } : {}) };
  // webSearch's fields live in a file of their own, as in the real output.
  const members = Object.entries(items)
    .filter(([t]) => !drop.has(`item:${t}`))
    .map(([t, fields]) =>
      t === 'webSearch' ? `{ "type": "webSearch" } & WebSearchItem` : `{ "type": "${t}", id: string, ${fields.filter((f) => !drop.has(`${t}.${f}`)).map((f) => `${f}: string | null`).join(', ')} }`,
    );
  fs.writeFileSync(path.join(dir, 'v2', 'ThreadItem.ts'), `export type ThreadItem = ${members.join(' | ')};`);
  fs.writeFileSync(path.join(dir, 'WebSearchItem.ts'), `export type WebSearchItem = { id: string, ${drop.has('webSearch.query') ? '' : 'query: string,'} };`);
  for (const [type, fields] of Object.entries(surface.TYPE_FIELDS)) {
    if (drop.has(`type:${type}`)) continue;
    // ts-rs quotes discriminated union tag keys such as `"mode": "form"`.
    const fmt = (f: string) => (type === 'McpServerElicitationRequestParams' && f === 'mode' ? `"${f}": "form",` : `${f}?: string | null,`);
    fs.writeFileSync(path.join(dir, 'v2', `${type}.ts`), `export type ${type} = {\n/** doc */\n${fields.filter((f) => !drop.has(`${type}.${f}`)).map(fmt).join(' ')} };`);
  }
  return dir;
}

test('checkSurface: a complete schema passes', () => {
  assert.deepEqual(surface.checkSurface(generated()), { missing: [], added: [] });
  assert.equal(surface.testedVersion, '0.164.0');
});

test('checkSurface: a request Codex stops sending that loses nothing (currentTime/read, gone in 0.171.0) holds nothing back', () => {
  assert.deepEqual(surface.checkSurface(generated({ drop: ['currentTime/read'] })), { missing: [], added: [] });
  assert.ok(surface.checkSurface(generated({ drop: ['item/commandExecution/requestApproval'] })).missing.includes('server request item/commandExecution/requestApproval'), 'approvals still do');
});

test('checkSurface names what a new version lost, and what it added', () => {
  const r = surface.checkSurface(
    generated({
      drop: ['turn/steer', 'item/started', 'item/tool/call', 'item:subAgentActivity', 'imageGeneration.savedPath', 'webSearch.query', 'TurnSteerParams.expectedTurnId', 'type:ThreadBackgroundTerminal'],
      addNotification: 'thread/somethingNew',
      addItem: 'hologram',
    }),
  );
  assert.deepEqual(r.missing.sort(), [
    'field TurnSteerParams.expectedTurnId',
    'field imageGeneration.savedPath',
    'field webSearch.query',
    'item subAgentActivity',
    'notification item/started',
    'request turn/steer',
    'server request item/tool/call',
    'type ThreadBackgroundTerminal',
  ]);
  assert.deepEqual(r.added.sort(), ['item hologram', 'notification thread/somethingNew']);
});

test('checkSurface on an empty folder misses everything', () => {
  const r = surface.checkSurface(tmp('tb-cx-empty-'));
  assert.ok(r.missing.includes('request turn/steer'));
  assert.ok(r.missing.includes('item imageGeneration'));
  assert.deepEqual(r.added, []);
});

// The real 0.164.0 output, when the gitignored capture is in this checkout
// (runner/.fixtures/codex-raw/ts-exp, from `codex app-server generate-ts`).
const realSchema = path.join(import.meta.dirname, '..', '..', '.fixtures', 'codex-raw', 'ts-exp');
test('checkSurface passes on the real 0.164.0 schema', { skip: !fs.existsSync(realSchema) && 'no captured schema in .fixtures' }, () => {
  assert.deepEqual(surface.checkSurface(realSchema), { missing: [], added: [] });
});

test('close() during the spawn-retry wait never spawns again', async () => {
  const f = await fake();
  const p = proc(f.bin, { timings: { spawnRetryMs: 300, spawnRetryForMs: PATIENCE_MS, closeWaitMs: 2000 } });
  const started = p.start();
  const first = await f.next();
  await first.request('initialize');
  first.exit(1);
  await first.closed;
  // Now in the retry wait.
  await p.close();
  // Either the first exit or the close is what start() reports.
  await assert.rejects(started, CodexExitedError);
  await assert.rejects(f.next(800), /no process started/);
  assert.equal(p.alive, false);
});
