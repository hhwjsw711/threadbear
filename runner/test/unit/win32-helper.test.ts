// The runner's helper on Windows (src/win32-helper.ts and .ps1), and peer
// identity's use of it (src/peer.ts): which process holds a connection,
// walked up through its parents to a thread's CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { nullLogger } from '../../src/log.ts';
import { coalesce, snapshotOwners, threadOfSocket } from '../../src/peer.ts';
import { ProcessRegistry, StaleProcess, processInfo, startedAt } from '../../src/proc.ts';
import { tmpDir } from '../helpers/fakes.ts';
import path from 'node:path';
import { HELPER_SCRIPT, Win32Helper, parseProcesses, parseSnapshot, powershellPath, winAddress } from '../../src/win32-helper.ts';
import fs from 'node:fs';
import { PATIENCE_MS } from '../helpers/patience.ts';
import { onlyOnWindows } from '../helpers/platform.ts';

// A stand-in that speaks the helper's lines: answers ping, echoes its op
// for anything else, and never answers "hang".
const STAND_IN = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const r = JSON.parse(l);
  if (r.op === 'hang') return;
  if (r.op === 'bad') return console.log(JSON.stringify({ id: r.id, ok: false, error: 'no such thing' }));
  console.log(JSON.stringify({ id: r.id, ok: true, result: r.op === 'ping' ? 'pong' : r.op + ':' + (r.port ?? '') }));
});`;

const standIn = (timeoutMs = 2000, startTimeoutMs = timeoutMs) => new Win32Helper({ command: process.execPath, args: ['-e', STAND_IN], timeoutMs, startTimeoutMs });

test('the helper answers each question by its id, keeps running, and says why when it refuses', async () => {
  const h = standIn();
  try {
    const [a, b] = await Promise.all([h.ask('ping'), h.ask('tcpOwners', { port: 5 })]);
    assert.equal(a, 'pong');
    assert.equal(b, 'tcpOwners:5');
    await assert.rejects(h.ask('bad'), /no such thing/);
    assert.equal(await h.ask('ping'), 'pong', 'still running after a refusal');
  } finally {
    h.stop();
  }
});

// Only the warm limit is short: a new node can take seconds to start on a
// loaded machine (bruce, 26 Nov), so each new helper's first answer gets
// PATIENCE_MS, and a ping warms the first one before the hang.
test("a question it doesn't answer in time fails, and the next one gets a new helper", async () => {
  const h = standIn(300, PATIENCE_MS);
  try {
    assert.equal(await h.ask('ping'), 'pong');
    await assert.rejects(h.ask('hang'), /in time/);
    assert.equal(await h.ask('ping'), 'pong');
  } finally {
    h.stop();
  }
});

// PowerShell starting and importing its modules took over 5 s on GitHub's
// Windows machines: a new helper's first answer gets longer than the rest.
test('a new helper gets longer for its first answer than for the ones after', async () => {
  const slowStart = `setTimeout(() => { ${STAND_IN} }, 600);`;
  const h = new Win32Helper({ command: process.execPath, args: ['-e', slowStart], timeoutMs: 200, startTimeoutMs: 5000 });
  try {
    assert.equal(await h.ask('ping'), 'pong', 'the slow start is waited for');
    await assert.rejects(h.ask('hang'), /in time/, 'once warm, the short limit');
  } finally {
    h.stop();
  }
});

test("a helper that can't start fails the question rather than hanging it", async () => {
  const h = new Win32Helper({ command: '/nowhere/powershell.exe', args: [], timeoutMs: 5000 });
  await assert.rejects(h.ask('ping'), /couldn't start|exited/);
});

// PowerShell dying leaves a question's write with nowhere to go (EPIPE).
// That has to be caught on the pipe: an uncaught EPIPE restarts the runner.
// The first question is bigger than a pipe buffer, and that helper exits
// without reading it. The next one has to be answered: it only starts once
// the first has exited, so a late EPIPE from the dead pipe shows up first.
test('a question written to a helper that has already gone is not an uncaught EPIPE', async () => {
  const mark = path.join(tmpDir(), 'gone');
  const script = `
    const fs = require('fs');
    const mark = ${JSON.stringify(mark)};
    if (!fs.existsSync(mark)) { fs.writeFileSync(mark, '1'); process.exit(0); }
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', (l) => {
      const r = JSON.parse(l);
      console.log(JSON.stringify({ id: r.id, ok: true, result: 'pong' }));
    });
  `;
  const crashes: string[] = [];
  const trap = (e: NodeJS.ErrnoException) => {
    crashes.push(e?.code ?? String(e));
  };
  process.on('uncaughtException', trap);
  const h = new Win32Helper({ command: process.execPath, args: ['-e', script], timeoutMs: 5000, startTimeoutMs: PATIENCE_MS });
  try {
    await assert.rejects(h.ask('ping', { pad: 'x'.repeat(1_000_000) }), /exited/);
    assert.equal(await h.ask('ping'), 'pong');
    assert.deepEqual(crashes, []);
  } finally {
    process.off('uncaughtException', trap);
    h.stop();
  }
});

test('its text answers parse, and odd lines are dropped', () => {
  assert.deepEqual(parseProcesses('4 0 0\r\n1200 800 133761234567890123\nnot a row\n'), [
    { pid: 4, ppid: 0, created: 0n },
    { pid: 1200, ppid: 800, created: 133761234567890123n },
  ]);
  assert.deepEqual(parseSnapshot('c 127.0.0.1 50000 127.0.0.1 8797 1200\r\np 1200 800 5\nnoise\n'), {
    connections: [{ localAddress: '127.0.0.1', localPort: 50000, remoteAddress: '127.0.0.1', remotePort: 8797, pid: 1200 }],
    processes: [{ pid: 1200, ppid: 800, created: 5n }],
  });
  assert.equal(winAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(winAddress('::1'), '::1');
});

// Windows keeps a dead process's id as its children's parent id, and hands
// the id to the next process. A thread's CLI that got that id later mustn't
// count as the parent of something that started before it.
test("on Windows a parent that started after its child isn't its parent", async () => {
  const sock = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
  const registry = { threadOfPid: (p: number) => (p === 300 ? 'th1' : undefined) };
  const look = (cliStarted: bigint) =>
    threadOfSocket(sock, {
      registry,
      known: () => true,
      log: nullLogger,
      platform: 'win32',
      lsof: async () => [500],
      table: async () => [
        { pid: 500, ppid: 400, created: 2000n }, // what connected
        { pid: 400, ppid: 300, created: 1500n }, // its shell
        { pid: 300, ppid: 1, created: cliStarted }, // a thread's CLI, or a process that took a dead one's id
      ],
    });
  assert.deepEqual(await look(1000n), { kind: 'thread', threadId: 'th1' }, 'started first: its parent');
  assert.deepEqual(await look(1600n), { kind: 'owner' }, 'started after the shell: only has a dead parent\'s id');
  assert.deepEqual(await look(0n), { kind: 'thread', threadId: 'th1' }, "Windows wouldn't say when: the id stands, as on a Mac");
});

test('on Windows a real connection is found through the helper', onlyOnWindows('The helper is PowerShell, which only Windows has'), async () => {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const child = spawn(process.execPath, ['-e', `require('net').connect(${port},'127.0.0.1');setTimeout(()=>{},600000)`], { stdio: 'ignore', windowsHide: true });
  const peer = new Promise<net.Socket>((r) => server.once('connection', r));
  let s: net.Socket | undefined;
  try {
    s = await peer;
    // The child is killed at the end, which resets this end.
    s.on('error', () => {});
    const sock = { remoteAddress: s.remoteAddress!, remotePort: s.remotePort!, localAddress: s.localAddress!, localPort: s.localPort! };
    // The first question starts PowerShell, which takes a second or more on a loaded machine.
    const lookupMs = PATIENCE_MS;
    assert.deepEqual(await threadOfSocket(sock, { registry: { threadOfPid: (p) => (p === child.pid ? 'th9' : undefined) }, known: () => true, log: nullLogger, lookupMs }), { kind: 'thread', threadId: 'th9' });
    // Under another process: its parent (this test) is the CLI.
    assert.deepEqual(await threadOfSocket(sock, { registry: { threadOfPid: (p) => (p === process.pid ? 'th8' : undefined) }, known: () => true, log: nullLogger, lookupMs }), { kind: 'thread', threadId: 'th8' });
    // Under no thread: the owner.
    assert.deepEqual(await threadOfSocket(sock, { registry: { threadOfPid: () => undefined }, known: () => true, log: nullLogger, lookupMs }), { kind: 'owner' });
  } finally {
    child.kill();
    s?.destroy();
    server.close();
    (await import('../../src/win32-helper.ts')).win32Helper().stop();
  }
});

test("a snapshot names only who holds exactly the client's end of this connection", () => {
  const sock = { remoteAddress: '::ffff:127.0.0.1', remotePort: 50000, localAddress: '::ffff:127.0.0.1', localPort: 8797 };
  const snap = parseSnapshot(
    [
      'c 127.0.0.1 50000 127.0.0.1 8797 100', // this one
      'c 127.0.0.2 50000 127.0.0.1 8797 200', // the same port from another loopback address
      'c 127.0.0.1 50001 127.0.0.1 8797 300', // another connection
      'c 127.0.0.1 50000 127.0.0.1 9999 400', // the same client port to another server
    ].join('\n'),
  );
  assert.deepEqual(snapshotOwners(snap, sock), [100]);
});

// One PowerShell answers one question at a time. Lookups that each asked
// could be queued past their deadline by a thread opening connections.
test('lookups waiting together share one snapshot, taken after they asked', async () => {
  let taken = 0;
  const gates: (() => void)[] = [];
  const take = coalesce(() => new Promise<number>((r) => gates.push(() => r(++taken))));
  const first = take();
  const waiting = Array.from({ length: 50 }, () => take());
  assert.equal(gates.length, 1, 'only one at a time');
  gates.shift()!();
  assert.equal(await first, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(gates.length, 1, 'the fifty share the next one');
  gates.shift()!();
  assert.deepEqual(new Set(await Promise.all(waiting)), new Set([2]));
  assert.equal(taken, 2);
});

test('on Windows a lookup that fails or runs out of time closes the connection instead of trusting its credential', async () => {
  const sock = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
  const deps = { registry: { threadOfPid: () => undefined }, known: () => true, log: nullLogger, platform: 'win32' as const, lookupMs: 100 };
  await assert.rejects(threadOfSocket(sock, { ...deps, snapshot: async () => { throw new Error('the helper exited'); } }), /could not tell/);
  await assert.rejects(threadOfSocket(sock, { ...deps, snapshot: () => new Promise(() => {}) }), /could not tell/);
  // A snapshot without this (open) connection hasn't seen what it should.
  await assert.rejects(threadOfSocket(sock, { ...deps, snapshot: async () => parseSnapshot('p 4242 1 9') }), /could not tell/);
  // Found, and under no thread: the owner, as on a Mac.
  assert.deepEqual(await threadOfSocket(sock, { ...deps, snapshot: async () => parseSnapshot('c 127.0.0.1 1234 127.0.0.1 8797 4242\np 4242 1 9') }), { kind: 'owner' });
});

test("the helper's script is passed whole and PowerShell is run by its full path", () => {
  assert.ok(fs.readFileSync(HELPER_SCRIPT, 'utf8').includes("'snapshot'"));
  assert.equal(powershellPath({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

// A CLI that exits can have its pid taken by another thread's new CLI before
// a lookup reads the registry: the snapshot's start time says which it saw.
test("a registered CLI counts only for the process that started when it did", async () => {
  assert.equal(startedAt({ lstart: '133761234567890123' }, 133761234567890120n), true, 'within a microsecond');
  assert.equal(startedAt({ lstart: '133761234567890123' }, 133761234597890123n), false, 'three seconds later: another process');
  assert.equal(startedAt({ lstart: '~133761234567890123' }, 133761234597890123n), true, 'an estimate gets ten seconds');
  assert.equal(startedAt({ lstart: '~133761234567890123' }, 133761236567890123n), false);
  assert.equal(startedAt({}, 5n), true, 'nothing recorded: the pid stands');
  assert.equal(startedAt({ lstart: '133761234567890123' }, undefined), true, 'no time read: the pid stands');
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.add(process.pid, 'claude', 'th1');
  const lstart = processInfo(process.pid)?.lstart;
  if (lstart && /^\d+$/.test(lstart)) {
    assert.equal(await reg.threadOfPid(process.pid, BigInt(lstart)), 'th1');
    // Not "no thread", which would leave the credential to decide: the lookup fails.
    await assert.rejects(reg.threadOfPid(process.pid, BigInt(lstart) + 30_000_000n), StaleProcess);
  }
  assert.equal(await reg.threadOfPid(process.pid), 'th1');
  reg.remove(process.pid);
});

test("on Windows a CLI's recorded start matches the helper's snapshot of it", onlyOnWindows('The helper is PowerShell, which only Windows has'), async () => {
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.add(process.pid, 'claude', 'th1');
  try {
    const { win32Helper, parseSnapshot } = await import('../../src/win32-helper.ts');
    const snap = parseSnapshot(await win32Helper().ask('snapshot', { port: 1 }));
    const me = snap.processes.find((p) => p.pid === process.pid);
    assert.ok(me && me.created > 0n, 'the snapshot has this process with a start time');
    assert.equal(await reg.threadOfPid(process.pid, me.created), 'th1');
  } finally {
    reg.remove(process.pid);
    (await import('../../src/win32-helper.ts')).win32Helper().stop();
  }
});

test('on Windows a CLI pid that has gone to a newer process closes the connection, rather than meaning "no thread"', async () => {
  const sock = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.add(process.pid, 'claude', 'thB');
  try {
    const lstart = processInfo(process.pid)?.lstart ?? '';
    const recorded = /^\d+$/.test(lstart) ? BigInt(lstart) : 0n;
    if (!recorded) return; // a Mac's ps gives a date, not a FILETIME: the Windows run checks this
    // A's child (500) under a CLI whose pid this process (B's CLI) now has, from before it started.
    const snap = parseSnapshot(`c 127.0.0.1 1234 127.0.0.1 8797 500\np 500 ${process.pid} ${recorded - 5n}\np ${process.pid} 1 ${recorded - 50_000_000n}`);
    await assert.rejects(threadOfSocket(sock, { registry: reg, known: () => true, log: nullLogger, platform: 'win32', snapshot: async () => snap }), StaleProcess);
  } finally {
    reg.remove(process.pid);
  }
});

// A module of the same name earlier on PSModulePath (the user's Documents
// folder is, and a thread can write there) must not stand in for Windows'
// own (Codex's third review).
test("on Windows the helper uses Windows' own NetTCPIP, not one planted earlier on the module path", onlyOnWindows('The helper is PowerShell, which only Windows has'), async () => {
  const dir = tmpDir();
  const mod = path.join(dir, 'NetTCPIP');
  fs.mkdirSync(mod);
  fs.writeFileSync(path.join(mod, 'NetTCPIP.psm1'), "function Get-NetTCPConnection { [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 1; RemoteAddress = '127.0.0.1'; RemotePort = 1; OwningProcess = 4242 } }\nExport-ModuleMember -Function Get-NetTCPConnection\n");
  const before = process.env.PSModulePath;
  process.env.PSModulePath = `${dir};${before ?? ''}`;
  const h = new Win32Helper({ timeoutMs: PATIENCE_MS });
  try {
    const snap = parseSnapshot(await h.ask('snapshot', { port: 1 }));
    assert.ok(!snap.connections.some((c) => c.pid === 4242), 'the planted module answered');
    assert.ok(snap.processes.length > 10, 'the real process list came back');
  } finally {
    h.stop();
    process.env.PSModulePath = before;
  }
});

// A CLI whose start probe failed is recorded with an estimate, which can't
// tell two processes ten seconds apart: its start is read again, exactly,
// and only that decides (Codex's fourth review).
test("a CLI recorded with an estimate counts only once an exact reading matches the snapshot", async () => {
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  const T = 133761234567890000n;
  const read = new Map<number, string | undefined>();
  let reads = 0;
  reg.readStart = async (pid) => {
    reads++;
    return read.get(pid);
  };
  // add() records an estimate when its own probe fails.
  reg.add(4242, 'claude', 'thB');
  (reg as unknown as { entries: Map<number, { lstart?: string }> }).entries.get(4242)!.lstart = `~${T}`;
  // The snapshot saw A's CLI, 5 s before B's started with that pid: the exact reading is B's.
  read.set(4242, String(T + 3n));
  await assert.rejects(reg.threadOfPid(4242, T - 50_000_000n), StaleProcess, 'within the estimate, but not the process the snapshot saw');
  // The snapshot's process is the one there now.
  // Many connections at once share one reading.
  reads = 0;
  assert.deepEqual(await Promise.all([1, 2, 3].map(() => reg.threadOfPid(4242, T + 3n))), ['thB', 'thB', 'thB']);
  assert.equal(reads, 1);
  assert.equal((reg as unknown as { entries: Map<number, { lstart?: string }> }).entries.get(4242)!.lstart, String(T + 3n), 'the exact start replaces the estimate');
  // A reading that fails is a no (another estimate, so nothing confirmed before counts).
  (reg as unknown as { entries: Map<number, { lstart?: string }> }).entries.get(4242)!.lstart = `~${T + 1n}`;
  read.set(4242, undefined);
  await assert.rejects(reg.threadOfPid(4242, T + 3n), StaleProcess);
  reg.remove(4242);
});

// Daybreak finding 177: the runner reads the environments above a
// connection, which on Windows only a read of each process's PEB gives.
test('environ answers parse: a block, one Windows won\'t show, one gone', async () => {
  const { parseEnviron } = await import('../../src/win32-helper.ts');
  const block = Buffer.from('A=1\0THREADBEAR_THREAD_KEY=' + 'a'.repeat(64) + '\0\0', 'utf16le').toString('base64');
  const envs = parseEnviron(`e 10 ${block}\r\nx 11\ng 12\ne 99 ${block}\n`, [10, 11, 12]);
  assert.equal(envs.get(10), `\0A=1\0THREADBEAR_THREAD_KEY=${'a'.repeat(64)}\0`);
  assert.equal(envs.get(11), '', "another user's or an elevated process: nothing of a thread's");
  assert.equal(envs.has(12), false, 'gone: left out, so the lookup is no answer');
  assert.equal(envs.has(99), false, 'not asked for');
  assert.throws(() => parseEnviron('x 10\nx 10\n', [10]), /twice/);
  // What's past the block's end (a removed variable's old bytes) isn't read.
  const stale = Buffer.from('A=1\0\0THREADBEAR_THREAD_ID=gone\0\0', 'utf16le').toString('base64');
  assert.equal(parseEnviron(`e 20 ${stale}\n`, [20]).get(20), '\0A=1\0');
});

test('on Windows the helper reads another process\'s environment, and says when one has gone', onlyOnWindows('The helper is PowerShell, which only Windows has'), async () => {
  const { win32Helper, parseEnviron } = await import('../../src/win32-helper.ts');
  const { threadMarksIn } = await import('../../src/peer.ts');
  const key = 'b'.repeat(64);
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, THREADBEAR_THREAD_KEY: key, THREADBEAR_THREAD_ID: 'th1', NOTE: 'x THREADBEAR_THREAD_ID=not-me' } });
  try {
    const gone = 4_294_967_292; // a pid nothing has
    const pids = [child.pid!, gone];
    // Until the child has started far enough to have its environment.
    let envs = new Map<number, string>();
    for (const until = Date.now() + PATIENCE_MS; Date.now() < until && !threadMarksIn(envs.get(child.pid!) ?? '').keys.length; ) {
      envs = parseEnviron(await win32Helper().ask('environ', { pids: pids.join(',') }), pids);
    }
    assert.deepEqual(threadMarksIn(envs.get(child.pid!)!), { keys: [key], ids: ['th1'], emptyKey: false });
    assert.equal(envs.has(gone), false);
  } finally {
    child.kill();
    win32Helper().stop();
  }
});

test("jobsOf answers parse: each process's Threadbear jobs, or that it couldn't be opened or has gone", async () => {
  const { parseJobs } = await import('../../src/win32-helper.ts');
  const a = 'Local\\threadbear-job-' + 'a'.repeat(32);
  const jobs = parseJobs(`j 10 threadbear-job-${'a'.repeat(32)}\r\nj 11\nx 12\ng 13\nj 14 nope\n`, [10, 11, 12, 13, 14]);
  assert.deepEqual(jobs.get(10), [a]);
  assert.deepEqual(jobs.get(11), []);
  assert.equal(jobs.has(12), false, "one it can't open even to ask (it denied that to itself): no answer");
  assert.equal(jobs.has(13), false, 'gone: left out, so the lookup is no answer');
  assert.equal(jobs.has(14), false, 'a name that is no job name: no answer');
});

test("on Windows the helper finds a thread's job on what its CLI starts, whatever its parents", onlyOnWindows('The helper is PowerShell, which only Windows has'), async () => {
  const { win32Helper, parseJobs } = await import('../../src/win32-helper.ts');
  const name = `Local\\threadbear-job-${(await import('node:crypto')).randomBytes(16).toString('hex')}`;
  // The "CLI": started, put in a job, then starts a child (as a tool command would).
  const cli = spawn(process.execPath, ['-e', "process.stdin.once('data',()=>{const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{stdio:'ignore'});console.log(c.pid)});setTimeout(()=>{},600000)"], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  try {
    const notAfter = String((BigInt(Date.now() + 60_000) + 11_644_473_600_000n) * 10_000n);
    await win32Helper().ask('jobAssign', { pid: cli.pid!, name, notAfter });
    const child = await new Promise<number>((r) => { cli.stdout!.once('data', (d) => r(Number(String(d).trim()))); cli.stdin!.write('go\n'); });
    const pids = [cli.pid!, child, process.pid];
    const jobs = parseJobs(await win32Helper().ask('jobsOf', { pids: pids.join(',') }), pids);
    assert.ok(jobs.get(cli.pid!)?.includes(name), 'the CLI is in its job');
    assert.ok(jobs.get(child)?.includes(name), 'and what it started');
    assert.equal(jobs.get(process.pid)?.includes(name), false, 'and nothing else');
    // The helper stopped (a question it took too long over) and started
    // again: the CLI holds a handle to its job, so it keeps its name.
    win32Helper().stop();
    const again = parseJobs(await win32Helper().ask('jobsOf', { pids: pids.join(',') }), pids);
    assert.ok(again.get(child)?.includes(name), 'still found after the helper started again');
    // The helper gone and then the CLI: the job's last handle goes, and
    // what the CLI started goes with it rather than run on in a job with
    // no name (Codex's second review).
    win32Helper().stop();
    cli.kill();
    const alive = () => { try { process.kill(child, 0); return true; } catch { return false; } };
    for (const until = Date.now() + PATIENCE_MS; Date.now() < until && alive(); ) await new Promise((r) => setImmediate(r));
    assert.equal(alive(), false, 'what the CLI started has ended');
  } finally {
    await win32Helper().ask('jobEnd', { name }).catch(() => undefined);
    cli.kill();
    win32Helper().stop();
  }
});

// The helper's own variables (its stdin and stdout, its jobs, its kernel32
// type) are set once: an op that assigned $in took the helper's stdin away
// and it exited after its first answer (finding 177's jobsOf, caught on a
// Windows machine). PowerShell has no block scope inside a switch.
test("no op in the helper reuses the helper's own variables", () => {
  const text = fs.readFileSync(HELPER_SCRIPT, 'utf8');
  for (const name of ['in', 'out', 'jobs', 'K', 'type', 'asm', 'line', 'req']) {
    const sets = [...text.matchAll(new RegExp(`(?:^|[\\s(;])\\$${name}\\s*=(?!=)`, 'gm'))].length;
    assert.ok(sets <= 1, `$${name} is assigned ${sets} times`);
  }
});

// Codex's third review: a launcher (Codex's Node one) starts the real CLI
// before the helper has put the launcher in its job. What it started by
// then goes in with it.
test('on Windows what a CLI started before it went in its job goes in too', onlyOnWindows('The helper is PowerShell, which only Windows has'), async () => {
  const { win32Helper, parseJobs } = await import('../../src/win32-helper.ts');
  const name = `Local\\threadbear-job-${(await import('node:crypto')).randomBytes(16).toString('hex')}`;
  const cli = spawn(process.execPath, ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{stdio:'ignore'});console.log(c.pid);setTimeout(()=>{},600000)"], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  try {
    const child = await new Promise<number>((r) => cli.stdout!.once('data', (d) => r(Number(String(d).trim()))));
    const notAfter = String((BigInt(Date.now() + 60_000) + 11_644_473_600_000n) * 10_000n);
    await win32Helper().ask('jobAssign', { pid: cli.pid!, name, notAfter });
    const jobs = parseJobs(await win32Helper().ask('jobsOf', { pids: String(child) }), [child]);
    assert.ok(jobs.get(child)?.includes(name), 'the child started before the job is in it');
  } finally {
    await win32Helper().ask('jobEnd', { name }).catch(() => undefined);
    cli.kill();
    win32Helper().stop();
  }
});
