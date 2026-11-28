import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { asAgent, backgroundPid, inBackground, jobPriority, TASKPOLICY, unwrapped } from '../../src/background.ts';
import { AcpProcess } from '../../src/adapters/acp/connection.ts';
import { ACP_AGENTS } from '../../src/adapters/acp/agents.ts';
import { AppServerProcess } from '../../src/adapters/codex/appserver.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { nullLogger } from '../../src/log.ts';
import { runCommand } from '../../src/patches.ts';
import { land } from '../../src/worktrees.ts';

// Builds and tests Threadbear spawns itself run below normal priority (a
// land's check held Mike's M5 above load 24 on 6 Nov): how far is
// runner.json's jobPriority, nice by default, as background priority made a
// landing on someone else's Mac take four hours (11 Nov).

test('inBackground: taskpolicy -b for background on a Mac that has it, nice for low, as it is for normal', () => {
  const sh = ['/bin/sh', ['-c', 'x']] as const;
  const nice = ['/usr/bin/nice', ['-n', '10', '/bin/sh', '-c', 'x']];
  const run = (priority: 'background' | 'low' | 'normal', platform: NodeJS.Platform, exists: (p: string) => boolean) =>
    inBackground(sh[0], [...sh[1]], { platform, exists, priority });
  assert.deepEqual(run('background', 'darwin', () => true), [TASKPOLICY, ['-b', '/bin/sh', '-c', 'x']]);
  // No taskpolicy (Linux, or a Mac without it): background is low.
  assert.deepEqual(run('background', 'darwin', (p) => p !== TASKPOLICY), nice);
  assert.deepEqual(run('background', 'linux', () => true), nice);
  assert.deepEqual(run('low', 'darwin', () => true), nice);
  assert.deepEqual(run('low', 'linux', () => false), ['nice', ['-n', '10', '/bin/sh', '-c', 'x']]);
  assert.deepEqual(run('normal', 'darwin', () => true), ['/bin/sh', ['-c', 'x']]);
  assert.deepEqual(run('low', 'win32', () => true), ['/bin/sh', ['-c', 'x']]);
});

// The agents besides Claude start at a priority too, so what they run
// inherits it: an Antigravity review's `swift test` ran at normal priority on
// Mike's M5 (23 Nov). Codex stops at nice, for the browsers and dev servers.
test('asAgent: ACP agents at the job priority, Codex at it but never below low', () => {
  const run = (kind: 'acp' | 'codex', priority: 'background' | 'low' | 'normal', platform: NodeJS.Platform = 'darwin') =>
    asAgent(kind, '/bin/agent', ['--acp'], { platform, exists: () => true, priority });
  const nice = ['/usr/bin/nice', ['-n', '10', '/bin/agent', '--acp']];
  assert.deepEqual(run('acp', 'background'), [TASKPOLICY, ['-b', '/bin/agent', '--acp']]);
  assert.deepEqual(run('acp', 'low'), nice);
  assert.deepEqual(run('acp', 'normal'), ['/bin/agent', ['--acp']]);
  assert.deepEqual(run('acp', 'background', 'linux'), nice);
  assert.deepEqual(run('codex', 'background'), nice);
  assert.deepEqual(run('codex', 'low'), nice);
  assert.deepEqual(run('codex', 'normal'), ['/bin/agent', ['--acp']]);
  assert.deepEqual(run('codex', 'background', 'win32'), ['/bin/agent', ['--acp']]);
  // deferBackground starts an ACP agent niced (even at background priority)
  // so cold boot isn't starved by macOS taskpolicy -b before initialize.
  assert.deepEqual(asAgent('acp', '/bin/agent', ['--acp'], { platform: 'darwin', exists: () => true, priority: 'background', deferBackground: true }), nice);
  assert.deepEqual(asAgent('acp', '/bin/agent', ['--acp'], { platform: 'darwin', exists: () => true, priority: 'normal', deferBackground: true }), ['/bin/agent', ['--acp']]);
  assert.deepEqual(asAgent('acp', '/bin/agent', ['--acp'], { platform: 'win32', exists: () => true, priority: 'background', deferBackground: true }), ['/bin/agent', ['--acp']]);
});

test('backgroundPid: runs taskpolicy -b -p on macOS at background priority, checks expectedParent, skips elsewhere, catches errors', async () => {
  const calls: { file: string; args: string[]; timeout: number }[] = [];
  const run = async (file: string, args: string[], o: { timeout: number }) => {
    calls.push({ file, args, timeout: o.timeout });
  };
  assert.equal(await backgroundPid(4242, { platform: 'darwin', exists: () => true, priority: 'background', run }), 'applied');
  assert.deepEqual(calls, [{ file: TASKPOLICY, args: ['-b', '-p', '4242'], timeout: 10_000 }]);
  calls.length = 0;
  assert.equal(await backgroundPid(4242, { platform: 'darwin', exists: () => true, priority: 'background', expectedParent: 99, run }), 'applied');
  assert.equal(calls[0]?.file, '/bin/sh');
  assert.deepEqual(calls[0]?.args.slice(-2), ['4242', '99']);
  const aborted = new AbortController();
  aborted.abort();
  calls.length = 0;
  assert.equal(await backgroundPid(4242, { platform: 'darwin', exists: () => true, priority: 'background', signal: aborted.signal, run }), 'failed');
  assert.equal(calls.length, 0, 'aborted signal skips running helper');
  assert.equal(await backgroundPid(4242, { platform: 'darwin', exists: () => true, priority: 'low', run }), 'skipped');
  assert.equal(await backgroundPid(4242, { platform: 'darwin', exists: () => true, priority: 'normal', run }), 'skipped');
  assert.equal(await backgroundPid(4242, { platform: 'linux', exists: () => true, priority: 'background', run }), 'skipped');
  assert.equal(await backgroundPid(4242, { platform: 'darwin', exists: () => false, priority: 'background', run }), 'skipped');
  assert.equal(await backgroundPid(0, { platform: 'darwin', exists: () => true, priority: 'background', run }), 'skipped');
  assert.equal(
    await backgroundPid(4242, {
      platform: 'darwin',
      exists: () => true,
      priority: 'background',
      run: async () => {
        throw new Error('ESRCH');
      },
    }),
    'failed',
  );
  if (onMac) {
    // A real PID (init/launchd pid 1) whose parent is not 99999999 must fail the parent guard.
    assert.equal(await backgroundPid(1, { platform: 'darwin', priority: 'background', expectedParent: 99_999_999 }), 'failed');
  }
  assert.equal(ACP_AGENTS.antigravity.lowerAfterInit, true);
  assert.equal(Boolean(ACP_AGENTS.opencode.lowerAfterInit), false);
});

test('unwrapped: the program taskpolicy or nice runs, for the process registry', () => {
  for (const priority of ['background', 'low', 'normal'] as const) {
    for (const kind of ['acp', 'codex'] as const) {
      assert.equal(unwrapped(...asAgent(kind, '/bin/agent', ['--acp'], { platform: 'darwin', exists: () => true, priority })), '/bin/agent');
    }
    assert.equal(unwrapped(...inBackground('/bin/sh', ['-c', 'x'], { platform: 'linux', exists: () => false, priority })), '/bin/sh');
  }
});

test("jobPriority: THREADBEAR_JOB_PRIORITY, then runner.json's jobPriority, then low", () => {
  const home = tmpDir('tb-pri-');
  assert.equal(jobPriority({ THREADBEAR_HOME: home }), 'low');
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ jobPriority: 'background' }));
  assert.equal(jobPriority({ THREADBEAR_HOME: home }), 'background');
  assert.equal(jobPriority({ THREADBEAR_HOME: home, THREADBEAR_JOB_PRIORITY: 'normal' }), 'normal');
  // Nonsense in either is passed over.
  assert.equal(jobPriority({ THREADBEAR_HOME: home, THREADBEAR_JOB_PRIORITY: 'fast' }), 'background');
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ jobPriority: 'idle' }));
  assert.equal(jobPriority({ THREADBEAR_HOME: home }), 'low');
});

// The runtime tests below say which they want, whatever runner.json this
// suite's environment would find.
function withPriority(p: string): () => void {
  const was = process.env.THREADBEAR_JOB_PRIORITY;
  process.env.THREADBEAR_JOB_PRIORITY = p;
  return () => {
    if (was === undefined) delete process.env.THREADBEAR_JOB_PRIORITY;
    else process.env.THREADBEAR_JOB_PRIORITY = was;
  };
}

// A darwin-background process reports scheduling priority 4 in ps (20 is
// normal). Only the background side is checked: the suite itself may run
// under taskpolicy -b, and then everything it starts is 4 anyway.
const onMac = process.platform === 'darwin' && fs.existsSync(TASKPOLICY);
const PRI = 'ps -o pri= -p $$';

test('runCommand: background runs at background priority', { skip: !onMac }, async (t) => {
  t.after(withPriority('background'));
  const r = await runCommand(PRI, { cwd: tmpDir(), env: { PATH: '/usr/bin:/bin' }, shell: ['/bin/sh', '-c'], background: true });
  assert.equal(r.ok, true, r.text);
  assert.equal(r.text.trim(), '4');
});

async function landPriority(command: string): Promise<string> {
  const root = fs.realpathSync(tmpDir('tb-bg-'));
  const main = path.join(root, 'repo');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@example.com');
  git(main, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  const wt = path.join(root, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'thread/bg', wt);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', 'b');
  const pri = path.join(root, 'pri.txt');
  const code = await land(
    { path: wt, branch: 'thread/bg', mainCheckout: main, check: `${command} > '${pri}'` },
    { out: () => {}, err: () => {}, shell: ['/bin/sh', '-c'] },
  );
  assert.equal(code, 0);
  return fs.readFileSync(pri, 'utf8').trim();
}

test('land: the check runs at background priority when runner.json says so', { skip: !onMac }, async (t) => {
  t.after(withPriority('background'));
  assert.equal(await landPriority(PRI), '4');
});

// Ten nicer than this suite (which may itself be niced on a check host),
// up to the most there is.
test('land: the check runs niced by default', async (t) => {
  t.after(withPriority('low'));
  const own = Number(execFileSync('/bin/ps', ['-o', 'nice=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
  const got = Number(await landPriority('ps -o nice= -p $$'));
  assert.equal(got, Math.min(own + 10, process.platform === 'darwin' ? 20 : 19));
});

test('runner: a turn hook runs at background priority unless the runner is told otherwise', { skip: !onMac }, async (t) => {
  t.after(withPriority('background'));
  const pri = async (backgroundJobs: boolean): Promise<string | undefined> => {
    const root = tmpDir();
    const project = path.join(root, 'app');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    fs.mkdirSync(path.join(project, '.threadbear', 'patches'), { recursive: true });
    fs.writeFileSync(path.join(project, '.threadbear', 'patches', 'hooks.ts'), `export default { hooks: [{ title: "Pri", on: "turn.end", run: "${PRI}", tell: "never" }] };\n`);
    const h = makeHarness(undefined, {}, { panelsRoot: root, actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 20_000, backgroundJobs });
    const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: project });
    await new Promise((r) => setImmediate(r));
    await h.runner.patchesIdle();
    const s = h.adapter.last;
    s.init();
    s.result('completed');
    const runs = () => h.events(thread.id).filter((e) => e.type === 'action.run');
    for (let i = 0; i < 2000 && !runs().length; i++) await new Promise((r) => setTimeout(r, 10));
    return (runs()[0] as { text?: string } | undefined)?.text?.trim();
  };
  assert.equal(await pri(true), '4');
  // Off, it runs as the runner does: at this suite's own priority, which
  // depends on how it was started (20 under a GUI login, 31 over ssh, as
  // when ./check.sh sends it to a check host, 4 under taskpolicy -b).
  const own = execFileSync('/bin/ps', ['-o', 'pri=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
  assert.equal((await pri(false)) ?? '', own);
});

// The real spawns: a stand-in agent writes its own priority and exits, so
// start() fails, which is fine here. They only show something when this
// suite isn't itself in the background or niced to the limit, as everything
// it starts inherits that: run them under `nice -n 10`, not taskpolicy -b.
const own = (): { pri: number; nice: number } => {
  const [pri, nice] = execFileSync('/bin/ps', ['-o', 'pri=,nice=', '-p', String(process.pid)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
  return { pri, nice };
};
const inBg = onMac && own().pri === 4;
const MAX_NICE = process.platform === 'darwin' ? 20 : 19;

function agentRig(): { root: string; out: string; registry: ProcessRegistry } {
  const root = fs.realpathSync(tmpDir('tb-agent-pri-'));
  return { root, out: path.join(root, 'pri.txt'), registry: new ProcessRegistry(path.join(root, 'run'), nullLogger) };
}

async function acpPri(lowered: boolean): Promise<string> {
  const { root, out, registry } = agentRig();
  const p = new AcpProcess({ binary: '/bin/sh', args: ['-c', `${PRI} > '${out}'`], env: { PATH: '/usr/bin:/bin' }, cwd: root, registry, log: nullLogger, label: 'pri', lowered });
  await p.start().catch(() => undefined);
  return fs.readFileSync(out, 'utf8').trim();
}

test("a thread's ACP agent starts in the background at that job priority; the model list and small jobs as they are", { skip: !onMac ? 'needs taskpolicy' : inBg ? 'this suite is already in the background' : false }, async (t) => {
  t.after(withPriority('background'));
  assert.equal(await acpPri(true), '4');
  assert.notEqual(await acpPri(false), '4');
});

test('Codex starts niced, not in the background, at that job priority', { skip: process.platform === 'win32' ? 'no nice' : inBg ? 'this suite is already in the background' : own().nice + 10 > MAX_NICE ? 'this suite is niced too far to tell' : false }, async (t) => {
  t.after(withPriority('background'));
  const { root, out, registry } = agentRig();
  const bin = path.join(root, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\nps -o pri=,nice= -p $$ > '${out}'\n`, { mode: 0o755 });
  const p = new AppServerProcess({ binary: bin, account: { id: 'codex-main', provider: 'codex', title: 'Codex', configDir: root }, cwd: root, registry, log: nullLogger, label: 'pri', timings: { spawnRetryForMs: 0 } });
  await p.start().catch(() => undefined);
  const [pri, nice] = fs.readFileSync(out, 'utf8').trim().split(/\s+/).map(Number);
  assert.equal(nice, own().nice + 10);
  if (onMac) assert.notEqual(pri, 4);
});

test('AcpProcess: lowerAfterInit boots out of background during initialize, then enters background (and children inherit it)', { skip: !onMac ? 'needs taskpolicy' : inBg ? 'this suite is already in the background' : false }, async (t) => {
  t.after(withPriority('background'));
  const { root, registry } = agentRig();
  const bin = path.join(root, 'fake-acp.mjs');
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';
const pri = () => execFileSync('/bin/ps', ['-o', 'pri=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
const childPri = () => execFileSync('/bin/sh', ['-c', 'ps -o pri= -p $$'], { encoding: 'utf8' }).trim();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'antigravity-acp', version: '1.4.5' }, _meta: { initPri: pri() } } }) + '\\n');
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1', _meta: { afterPri: pri(), childPri: childPri() } } }) + '\\n');
  }
});
`,
    { mode: 0o755 },
  );
  const p = new AcpProcess({ binary: bin, args: [], env: { PATH: '/usr/bin:/bin' }, cwd: root, registry, log: nullLogger, label: 'defer-pri', lowered: true, lowerAfterInit: true });
  try {
    const init = (await p.start()) as { _meta?: { initPri?: string } };
    assert.notEqual(init._meta?.initPri, '4', 'must not be in darwin background during initialize');
    const sess = (await p.request('session/new', { cwd: root, mcpServers: [] })) as { _meta?: { afterPri?: string; childPri?: string } };
    assert.equal(sess._meta?.afterPri, '4', 'must enter darwin background right after initialize');
    assert.equal(sess._meta?.childPri, '4', 'child processes spawned in session/new must inherit darwin background');
  } finally {
    await p.close().catch(() => undefined);
  }
});

test('AcpProcess: initialize uses sessionMs rather than requestMs so a slow cold boot is not cut off at 30 s', async () => {
  const { root, registry } = agentRig();
  const bin = path.join(root, 'slow-init.mjs');
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'slow', version: '1.0' } } }) + '\\n');
    }, 120);
  }
});
`,
    { mode: 0o755 },
  );
  const p = new AcpProcess({ binary: bin, args: [], env: { PATH: '/usr/bin:/bin' }, cwd: root, registry, log: nullLogger, label: 'slow-init', timings: { requestMs: 40, sessionMs: 5_000 } });
  try {
    const init = await p.start();
    assert.equal(init.agentInfo?.name, 'slow');
  } finally {
    await p.close().catch(() => undefined);
  }
});

test('AcpProcess: lowerAfterInit retries backgroundPid once, fails closed if both fail, and aborts on close/exit', async () => {
  const { root, registry } = agentRig();
  const bin = path.join(root, 'init-agent.mjs');
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'antigravity-acp', version: '1.4.5' } } }) + '\\n');
    if (process.env.EXIT_AFTER_INIT === '1') setTimeout(() => process.exit(1), 30);
  }
});
`,
    { mode: 0o755 },
  );

  // 1. Fails once then succeeds on retry.
  let attempts = 0;
  let sawParent: number | undefined;
  const p1 = new AcpProcess({
    binary: bin,
    args: [],
    env: { PATH: '/usr/bin:/bin' },
    cwd: root,
    registry,
    log: nullLogger,
    label: 'bg-retry',
    lowered: true,
    lowerAfterInit: true,
    backgroundPid: async (_pid, o) => {
      sawParent = o?.expectedParent;
      attempts++;
      return attempts === 1 ? 'failed' : 'applied';
    },
  });
  try {
    await p1.start();
    assert.equal(attempts, 2);
    assert.equal(sawParent, process.pid);
  } finally {
    await p1.close().catch(() => undefined);
  }

  // 2. Fails twice -> fails closed rather than opening a session at the wrong priority.
  let failAttempts = 0;
  const p2 = new AcpProcess({
    binary: bin,
    args: [],
    env: { PATH: '/usr/bin:/bin' },
    cwd: root,
    registry,
    log: nullLogger,
    label: 'bg-fail',
    lowered: true,
    lowerAfterInit: true,
    backgroundPid: async () => {
      failAttempts++;
      return 'failed';
    },
  });
  try {
    await assert.rejects(() => p2.start(), /background priority/);
    assert.equal(failAttempts, 2);
  } finally {
    await p2.close().catch(() => undefined);
  }

  // 3. Agent exits while backgroundPid is pending -> signal aborts and start() rejects.
  let exitAborted = false;
  const p3 = new AcpProcess({
    binary: bin,
    args: [],
    env: { PATH: '/usr/bin:/bin', EXIT_AFTER_INIT: '1' },
    cwd: root,
    registry,
    log: nullLogger,
    label: 'bg-exit',
    lowered: true,
    lowerAfterInit: true,
    backgroundPid: (_pid, o) =>
      new Promise((resolve) => {
        o?.signal?.addEventListener('abort', () => {
          exitAborted = true;
          resolve('failed');
        });
      }),
  });
  try {
    await assert.rejects(() => p3.start(), /exited/);
    assert.equal(exitAborted, true);
  } finally {
    await p3.close().catch(() => undefined);
  }

  // 4. close() during delayed backgroundPid -> signal aborts and start() rejects cleanly.
  let closeAborted = false;
  let bgStarted!: () => void;
  const bgReady = new Promise<void>((r) => (bgStarted = r));
  const p4 = new AcpProcess({
    binary: bin,
    args: [],
    env: { PATH: '/usr/bin:/bin' },
    cwd: root,
    registry,
    log: nullLogger,
    label: 'bg-close',
    lowered: true,
    lowerAfterInit: true,
    backgroundPid: (_pid, o) => {
      bgStarted();
      return new Promise((resolve) => {
        o?.signal?.addEventListener('abort', () => {
          closeAborted = true;
          resolve('failed');
        });
      });
    },
  });
  const starting = p4.start();
  await bgReady;
  const closing = p4.close();
  await assert.rejects(() => starting, /exited|stopped/);
  await closing;
  assert.equal(closeAborted, true);
});
