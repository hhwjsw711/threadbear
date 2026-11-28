import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACP_WAKE_GRACE_MS, AcpAdapter, AcpSession } from '../../src/adapters/acp/adapter.ts';
import { AcpProcess } from '../../src/adapters/acp/connection.ts';
import { ACP_AGENTS } from '../../src/adapters/acp/agents.ts';
import type { AdapterOutput, SessionSink, ToolApprovalAnswer, ToolApprovalRequest } from '../../src/adapters/types.ts';
import type { Account } from '../../src/protocol.ts';
import { nullLogger } from '../../src/log.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { sectionOf } from '../../src/wait-state.ts';
import { FakeClock } from '../../src/clock.ts';
import { FakeAccounts, makeHarness } from '../helpers/fakes.ts';

const FAKE = path.join(import.meta.dirname, '..', 'helpers', 'fake-acp-agent.mjs');

const inheritedPath = process.env.PATH;
beforeEach(() => {
  process.env.PATH = `/usr/bin:/bin:/usr/sbin:/sbin:${path.dirname(process.execPath)}`;
});
afterEach(() => {
  if (inheritedPath === undefined) delete process.env.PATH;
  else process.env.PATH = inheritedPath;
});

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-acp-bg-')));
}

const made: string[] = [];
const sessions: { end(o?: { hard?: boolean }): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.end({ hard: true }).catch(() => undefined)));
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function sendWake(session: AcpSession, params: Record<string, unknown>): void {
  const s = session as unknown as { sessionId?: string; proc: { notify(method: string, params?: unknown): void } };
  assert.ok(s.sessionId, 'sessionId should be established before waking');
  s.proc.notify('_test/wake', { sessionId: s.sessionId, ...params });
}

function sendWakeGate(session: AcpSession, key: string): void {
  const s = session as unknown as { proc: { notify(method: string, params?: unknown): void } };
  s.proc.notify('_test/wakeGate', { key });
}

function flushImmediate(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function makeRunnerRig(o: {
  alivePids: Set<number>;
  pollMs?: number;
  settleMs?: { endTurn?: number; endTurnWaitText?: number; text?: number; idle?: number; toolStall?: number };
  idleMs?: number;
  maxLive?: number;
  withEndTurn?: boolean;
  clock?: FakeClock;
  env?: Record<string, string>;
}) {
  const root = tmp();
  made.push(root);
  const registry = new ProcessRegistry(path.join(root, 'run'), nullLogger);
  let runnerRef: ReturnType<typeof makeHarness>['runner'] | undefined;
  let lastSession: AcpSession | undefined;
  let pollCalls = 0;
  const acp = new AcpAdapter({
    agent: ACP_AGENTS.opencode,
    binary: () => FAKE,
    registry,
    log: nullLogger,
    env: { PATH: process.env.PATH, ...o.env },
    timings: { closeWaitMs: 300 },
    shellPidAlive: (pid) => {
      pollCalls++;
      return o.alivePids.has(pid);
    },
    backgroundShellPollMs: o.pollMs ?? 25,
    unsolicitedSettleMs: o.settleMs ?? { endTurn: 40, text: 80, idle: 180 },
    ...(o.withEndTurn
      ? {
          toolsFor: (threadId) =>
            buildThreadbearTools(runnerRef!, threadId, Date.now, undefined, undefined, undefined, {
              provider: 'codex',
              oneReply: () => true,
            }),
        }
      : {}),
  });
  const startAcp = acp.start.bind(acp);
  acp.start = (opts, sink) => {
    const s = startAcp(opts, sink) as AcpSession;
    lastSession = s;
    sessions.push(s);
    return s;
  };
  const account: Account = { id: 'opencode-main', provider: 'opencode', title: 'OpenCode', configDir: root };
  const h = makeHarness(
    path.join(root, 'home'),
    { ...(o.withEndTurn ? { oneReply: true } : {}), ...(o.idleMs !== undefined ? { idleMs: o.idleMs } : {}), ...(o.maxLive !== undefined ? { maxLive: o.maxLive } : {}) },
    {
      adapters: { opencode: acp },
      accounts: new FakeAccounts([account]),
      ...(o.clock ? { clock: o.clock } : {}),
    },
  );
  runnerRef = h.runner;
  return {
    root,
    registry,
    acp,
    h,
    session: () => lastSession!,
    pollCalls: () => pollCalls,
    async close() {
      await h.runner.shutdown();
      await registry.killAll(200);
    },
  };
}

test('wakesAfterTasks is true for OpenCode and false for non-waking ACP agents', () => {
  const root = tmp();
  made.push(root);
  const registry = new ProcessRegistry(path.join(root, 'run'), nullLogger);
  const make = (provider: keyof typeof ACP_AGENTS) =>
    new AcpAdapter({ agent: ACP_AGENTS[provider], binary: () => FAKE, registry, log: nullLogger });
  assert.equal(make('opencode').wakesAfterTasks, true);
  assert.equal(make('antigravity').wakesAfterTasks, false);
  assert.equal(make('cursor').wakesAfterTasks, false);
  assert.equal(make('grok').wakesAfterTasks, false);
});

test('OpenCode background shell keeps thread in Running (waitState job, not Inbox) and blocks idle release through shell + wake grace', async () => {
  const clock = new FakeClock();
  const alive = new Set([42001]);
  // idleMs (500ms) is deliberately much shorter than WAKE_GRACE_MS (15s).
  const rig = makeRunnerRig({ alivePids: alive, idleMs: 500, pollMs: 20, clock });
  try {
    const { thread } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({ shellId: 'sh_1', pid: 42001, command: 'npm test', description: 'Run test suite' })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(thread.id).status === 'idle');
    const summary = rig.h.runner.get(thread.id);
    assert.equal(summary.live, true);
    assert.equal(summary.waitState, 'job');
    assert.equal(sectionOf(summary.waitState!, false), 'running');
    assert.deepEqual(summary.background, [{ kind: 'shell', description: 'Run test suite' }]);
    // Ended without end_turn to wait for the shell: no notification or phone push yet.
    assert.equal(summary.needsYou, false);

    // Advancing well past idleMs must NOT release the OpenCode CLI while its shell runs.
    clock.advance(60_000);
    await flushImmediate();
    const still = rig.h.runner.get(thread.id);
    assert.equal(still.live, true);
    assert.equal(still.waitState, 'job');

    // Shell exits: wake grace (ACP_WAKE_GRACE_MS) must ALSO protect the CLI from the 500ms idle timer.
    alive.delete(42001);
    await until(() => rig.h.runner.get(thread.id).background?.some((b) => b.finished === true) === true);
    clock.advance(5_000);
    await flushImmediate();
    assert.equal(rig.h.runner.get(thread.id).live, true, 'idleMs must not release CLI during wake grace');
    assert.equal(rig.h.runner.get(thread.id).waitState, 'job');

    // Past Claude's 15 s, still in OpenCode's own grace: its wake turn opens
    // only with the model's first words (28 Nov 2026, c2df7d18).
    clock.advance(11_000);
    await flushImmediate();
    assert.equal(rig.h.runner.get(thread.id).waitState, 'job', 'still in OpenCode\'s longer wake grace');
    // Once wake grace expires with no wake, the runner nudges the agent to
    // read the result; that turn ending with nothing said leaves it with Mike.
    clock.advance(ACP_WAKE_GRACE_MS);
    await until(() => rig.h.events(thread.id).filter((e) => e.type === 'turn.completed').length === 2);
    assert.equal(rig.h.runner.get(thread.id).background, undefined);
    assert.equal(rig.h.runner.get(thread.id).live, true, 'CLI stays live until idleMs elapses after its turn');
    assert.equal(rig.h.runner.get(thread.id).needsYou, true, "the nudge turn said nothing either, so it's Mike's");
    clock.advance(600);
    await until(() => rig.h.runner.get(thread.id).live === false);
  } finally {
    await rig.close();
  }
});

test('background shell exit -> wake grace -> OpenCode background wake opens cliTurn with wokeBy, accepts end_turn, and transitions cleanly to Inbox', async () => {
  const alive = new Set([42002]);
  const rig = makeRunnerRig({ alivePids: alive, withEndTurn: true, pollMs: 20, settleMs: { endTurn: 40, text: 400, idle: 600 } });
  try {
    const { thread } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({ shellId: 'sh_2', pid: 42002, command: 'cargo test', description: 'Run cargo tests' })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(thread.id).status === 'idle');
    assert.equal(rig.h.runner.get(thread.id).waitState, 'job');

    // Shell finishes: poll clears live task and wake grace holds Running with finished: true.
    alive.delete(42002);
    await until(() => rig.h.runner.get(thread.id).background?.some((b) => b.finished === true) === true);
    const waking = rig.h.runner.get(thread.id);
    assert.equal(waking.waitState, 'job');
    assert.equal(sectionOf(waking.waitState!, false), 'running');

    // OpenCode wakes on its background turn fiber with tool work, final reply, and end_turn.
    const asks = [{ question: 'Ship the fix now?', suggested: 0, options: [{ label: 'Ship it', does: 'Land on main' }, { label: 'Hold off', does: 'Keep on branch' }] }];
    sendWake(rig.session(), {
      thought: 'Checking the test output.',
      tool: { command: 'tail -n 20 /tmp/sh_2.out', output: 'all 42 tests passed' },
      text: 'All 42 cargo tests passed.',
      endTurn: { headline: 'Cargo tests passed', needs: 'you', asks },
    });

    await until(() => rig.h.events(thread.id).filter((e) => e.type === 'turn.completed').length === 2);
    const evs = rig.h.events(thread.id);
    const wakeStart = evs.filter((e) => e.type === 'turn.started')[1];
    assert.deepEqual(wakeStart?.wokeBy, [{ kind: 'shell', description: 'Run cargo tests' }]);
    const wakeDone = evs.filter((e) => e.type === 'turn.completed')[1];
    assert.equal(wakeDone?.outcome, 'completed');
    assert.equal(wakeDone?.needs, 'you');
    assert.equal(wakeDone?.needsFrom, 'tool');

    const after = rig.h.runner.get(thread.id);
    assert.equal(after.status, 'idle');
    assert.equal(after.background, undefined);
    assert.equal(after.needs, 'you');
    assert.equal(after.waitState, 'needsYou');
    assert.equal(sectionOf(after.waitState!, false), 'inbox');
  } finally {
    await rig.close();
  }
});

test('OpenCode waking before the PID poll fires still prunes the finished shell and sets wokeBy', async () => {
  const alive = new Set([42003]);
  // Long poll interval so the poll cannot fire before _test/wake arrives.
  const rig = makeRunnerRig({ alivePids: alive, pollMs: 60_000, settleMs: { endTurn: 30, text: 40, idle: 100 } });
  try {
    const { thread } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({ shellId: 'sh_fast', pid: 42003, command: 'make build', description: 'Build binary' })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(thread.id).status === 'idle');
    assert.equal(rig.h.runner.get(thread.id).waitState, 'job');

    alive.delete(42003);
    sendWake(rig.session(), { text: 'Build succeeded.' });

    await until(() => rig.h.events(thread.id).filter((e) => e.type === 'turn.completed').length === 2);
    const wakeStart = rig.h.events(thread.id).filter((e) => e.type === 'turn.started')[1];
    assert.deepEqual(wakeStart?.wokeBy, [{ kind: 'shell', description: 'Build binary' }]);
    const after = rig.h.runner.get(thread.id);
    assert.equal(after.background, undefined);
    assert.equal(after.waitState, 'needsYou');
    assert.equal(sectionOf(after.waitState!, false), 'inbox');
  } finally {
    await rig.close();
  }
});

test('background shell that already exited before turn completion is pruned synchronously before turn.completed', async () => {
  // First check (when tool_call_update arrives) returns true; second check (before sendResult) returns false.
  let checks = 0;
  const root = tmp();
  made.push(root);
  const registry = new ProcessRegistry(path.join(root, 'run'), nullLogger);
  const outputs: AdapterOutput[] = [];
  const acp = new AcpAdapter({
    agent: ACP_AGENTS.opencode,
    binary: () => FAKE,
    registry,
    log: nullLogger,
    env: { PATH: process.env.PATH },
    timings: { closeWaitMs: 300 },
    backgroundShellPollMs: 60_000,
    shellPidAlive: () => ++checks === 1,
  });
  let done!: () => void;
  const resultReady = new Promise<void>((r) => (done = r));
  const sink: SessionSink = {
    output(o) {
      outputs.push(o);
      if (o.kind === 'result') done();
    },
    requestApproval: async () => ({ decision: 'allow' }),
    requestQuestion: async () => ({ answers: null }),
    exited() {},
  };
  const s = acp.start(
    {
      threadId: 't-mid',
      cwd: root,
      account: { id: 'opencode-main', provider: 'opencode', title: 'OpenCode', configDir: root },
      permissionMode: 'full',
      sessionId: 'unused',
      resume: false,
      mediaDir: path.join(root, 'media'),
      blobsDir: path.join(root, 'blobs'),
      tmpDir: root,
    },
    sink,
  );
  sessions.push(s);
  s.send({
    id: 'm1',
    text: `bg_shell ${JSON.stringify({ shellId: 'sh_mid', pid: 42004, command: 'quick-job' })}`,
    images: [],
  });
  await resultReady;
  const taskOutputs = outputs.filter((o): o is Extract<AdapterOutput, { kind: 'tasks' }> => o.kind === 'tasks');
  assert.equal(taskOutputs.length, 2);
  assert.equal(taskOutputs[0].tasks.length, 1);
  assert.deepEqual(taskOutputs[1].tasks, []);
  const lastTasksIdx = outputs.lastIndexOf(taskOutputs[1]);
  const resultIdx = outputs.findIndex((o) => o.kind === 'result');
  assert.ok(lastTasksIdx < resultIdx, 'dead shell is pruned before turn result');
  await registry.killAll(200);
});

test('unsolicited wake does not settle prematurely while a tool or permission card is open', async (t) => {
  const root = tmp();
  made.push(root);
  const registry = new ProcessRegistry(path.join(root, 'run'), nullLogger);
  const outputs: AdapterOutput[] = [];
  let resolveCard!: (a: ToolApprovalAnswer) => void;
  const cards: ToolApprovalRequest[] = [];
  const acp = new AcpAdapter({
    agent: ACP_AGENTS.opencode,
    binary: () => FAKE,
    registry,
    log: nullLogger,
    env: { PATH: process.env.PATH },
    timings: { closeWaitMs: 300 },
    unsolicitedSettleMs: { endTurn: 20, text: 30, idle: 40 },
  });
  const results: (() => void)[] = [];
  const sink: SessionSink = {
    output(o) {
      outputs.push(o);
      if (o.kind === 'result') results.splice(0).forEach((f) => f());
    },
    requestApproval(req) {
      cards.push(req);
      return new Promise<ToolApprovalAnswer>((r) => (resolveCard = r));
    },
    requestQuestion: async () => ({ answers: null }),
    exited() {},
  };
  const s = acp.start(
    {
      threadId: 't-hold',
      cwd: root,
      account: { id: 'opencode-main', provider: 'opencode', title: 'OpenCode', configDir: root },
      permissionMode: 'ask',
      sessionId: 'unused',
      resume: false,
      mediaDir: path.join(root, 'media'),
      blobsDir: path.join(root, 'blobs'),
      tmpDir: root,
    },
    sink,
  ) as AcpSession;
  sessions.push(s);

  const firstDone = new Promise<void>((r) => results.push(r));
  s.send({ id: 'm1', text: 'hello', images: [] });
  await firstDone;

  // Trigger an unsolicited wake that asks for permission and holds the tool open behind a gate.
  sendWake(s, {
    tool: { command: 'rm -f tmp.log', askPermission: true, waitGate: 'tool-finish', output: 'removed' },
    text: 'Cleaned up after the background job.',
  });

  await until(() => cards.length === 1);
  const internals = s as unknown as { turn?: { settleTimer?: unknown } };
  assert.equal(internals.turn?.settleTimer, undefined, 'no settle timer is armed while approval card is open');

  // Approve the card; tool stays running behind waitGate. Enable mock timers to tick well past idle settle (40ms).
  resolveCard({ decision: 'allow' });
  await flushImmediate();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.timers.tick(500);
  assert.equal(outputs.filter((o) => o.kind === 'result').length, 1, 'must not settle while tool is running');
  t.mock.timers.reset();

  // Release the tool gate so it completes and writes its text; turn settles cleanly afterwards.
  sendWakeGate(s, 'tool-finish');
  await until(() => outputs.filter((o) => o.kind === 'result').length === 2);
  const second = outputs.filter((o): o is Extract<AdapterOutput, { kind: 'result' }> => o.kind === 'result')[1];
  assert.equal(second.result.outcome, 'completed');
  await registry.killAll(200);
});

test('background wake spawning a second background shell stays in Running, and exits cleanly if OpenCode never wakes again', async () => {
  const clock = new FakeClock();
  const alive = new Set([42010, 42011]);
  const rig = makeRunnerRig({ alivePids: alive, pollMs: 20, settleMs: { endTurn: 20, text: 30, idle: 60 }, clock });
  try {
    const { thread } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({ shellId: 'sh_first', pid: 42010, command: 'step-1', description: 'Step 1' })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(thread.id).status === 'idle');
    assert.equal(rig.h.runner.get(thread.id).waitState, 'job');

    // Step 1 exits; wake turn spawns Step 2 in the background and settles.
    alive.delete(42010);
    await until(() => rig.h.runner.get(thread.id).background?.some((b) => b.finished === true) === true);

    sendWake(rig.session(), {
      tool: {
        kind: 'execute',
        command: 'step-2',
        rawInput: { command: 'step-2', description: 'Step 2' },
        output: 'Command moved to the background (shell ID: sh_second).\nPID: 42011\nOutput is streaming to: /tmp/sh_second.out',
        rawOutput: { metadata: { shellID: 'sh_second', status: 'running', pid: 42011, truncated: false } },
      },
      text: 'Step 1 done; started Step 2 in background.',
    });
    await until(() => rig.h.events(thread.id).filter((e) => e.type === 'turn.completed').length === 2);

    const mid = rig.h.runner.get(thread.id);
    assert.equal(mid.status, 'idle');
    assert.equal(mid.waitState, 'job');
    assert.deepEqual(mid.background, [{ kind: 'shell', description: 'Step 2' }]);

    // Step 2 exits, and OpenCode does NOT wake up: after its wake grace the
    // runner's nudge turn runs, and once it ends the thread cleanly exits Running.
    alive.delete(42011);
    await until(() => rig.h.runner.get(thread.id).background?.some((b) => b.finished === true) === true);
    clock.advance(ACP_WAKE_GRACE_MS + 1_000);
    await until(() => rig.h.events(thread.id).filter((e) => e.type === 'turn.completed').length === 3);
    const done = rig.h.runner.get(thread.id);
    assert.equal(done.background, undefined);
    assert.notEqual(done.waitState, 'job');
    assert.equal(sectionOf(done.waitState!, false), 'inbox');
  } finally {
    await rig.close();
  }
});

test('Stop (interrupt) during an unsolicited background wake cleanly interrupts the turn and stops the CLI', async () => {
  const alive = new Set([42020]);
  const rig = makeRunnerRig({ alivePids: alive, pollMs: 20, settleMs: { endTurn: 20, text: 40, idle: 100 } });
  try {
    const { thread } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({ shellId: 'sh_int', pid: 42020, command: 'long-job', description: 'Long job' })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(thread.id).status === 'idle');

    alive.delete(42020);
    sendWake(rig.session(), {
      tool: { command: 'still-working', leaveOpen: true },
    });
    await until(() => rig.h.runner.get(thread.id).status === 'running');

    rig.h.runner.interrupt(thread.id, { byMike: true });
    await until(() => rig.h.runner.get(thread.id).status === 'idle' && !rig.h.runner.get(thread.id).live);
    const evs = rig.h.events(thread.id);
    const lastDone = evs.findLast((e) => e.type === 'turn.completed');
    assert.equal(lastDone?.outcome, 'interrupted');
    const after = rig.h.runner.get(thread.id);
    assert.equal(after.background, undefined);
    assert.notEqual(after.waitState, 'job');
  } finally {
    await rig.close();
  }
});

test('session exit/kill while a background shell is running stops polling and clears background state', async () => {
  const alive = new Set([42030]);
  const rig = makeRunnerRig({ alivePids: alive, pollMs: 15 });
  try {
    const { thread } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({ shellId: 'sh_kill', pid: 42030, command: 'daemon', description: 'Watcher' })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(thread.id).status === 'idle');
    assert.equal(rig.h.runner.get(thread.id).waitState, 'job');

    rig.session().kill();
    await until(() => !rig.h.runner.get(thread.id).live);
    const after = rig.h.runner.get(thread.id);
    assert.equal(after.background, undefined);
    assert.notEqual(after.waitState, 'job');

    const internals = rig.session() as unknown as { shellPollTimer?: unknown };
    assert.equal(internals.shellPollTimer, undefined, 'poll timer is stopped on session exit');
    const callsAtExit = rig.pollCalls();
    await flushImmediate();
    assert.equal(rig.pollCalls(), callsAtExit, 'no further PID probes after exit');
  } finally {
    await rig.close();
  }
});

test('session/load replay of historical background shells does not resurrect stale tasks, and PID-less shells are not tracked', async () => {
  const root = tmp();
  made.push(root);
  const logFile = path.join(root, 'acp.log');
  const registry = new ProcessRegistry(path.join(root, 'run'), nullLogger);
  const outputs: AdapterOutput[] = [];
  const acp = new AcpAdapter({
    agent: ACP_AGENTS.opencode,
    binary: () => FAKE,
    registry,
    log: nullLogger,
    env: {
      PATH: process.env.PATH,
      FAKE_ACP_NO_RESUME: '1',
      FAKE_ACP_LOG: logFile,
      FAKE_ACP_LOAD_REPLAY_BG: JSON.stringify({ shellId: 'sh_old', pid: 99999, command: 'old-cmd' }),
    },
    timings: { closeWaitMs: 300 },
    shellPidAlive: () => true,
  });
  let done!: () => void;
  const resultReady = new Promise<void>((r) => (done = r));
  const sink: SessionSink = {
    output(o) {
      outputs.push(o);
      if (o.kind === 'result') done();
    },
    requestApproval: async () => ({ decision: 'allow' }),
    requestQuestion: async () => ({ answers: null }),
    exited() {},
  };
  const s = acp.start(
    {
      threadId: 't-replay',
      cwd: root,
      account: { id: 'opencode-main', provider: 'opencode', title: 'OpenCode', configDir: root },
      permissionMode: 'full',
      sessionId: 'ses-prev',
      resume: true,
      mediaDir: path.join(root, 'media'),
      blobsDir: path.join(root, 'blobs'),
      tmpDir: root,
    },
    sink,
  );
  sessions.push(s);
  // Also verify a PID-less shell in a live turn is ignored so it can never leak stuck in Running.
  s.send({
    id: 'm1',
    text: `bg_shell ${JSON.stringify({ shellId: 'sh_nopid', command: 'remote-job' })}`,
    images: [],
  });
  await resultReady;
  const logEntries = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(logEntries.some((l) => l.loaded === 'ses-prev'), true, 'must actually invoke session/load');
  assert.deepEqual(
    outputs.filter((o) => o.kind === 'tasks'),
    [],
    'neither replayed nor PID-less shells emit background tasks',
  );
  await registry.killAll(200);
});

test('handover drain keeps OpenCode CLI live while a background shell runs and hands over once it finishes', async () => {
  const clock = new FakeClock();
  const alive = new Set([42040]);
  const rig = makeRunnerRig({ alivePids: alive, pollMs: 20, clock });
  try {
    const { thread } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({ shellId: 'sh_drain', pid: 42040, command: 'npm run build', description: 'Build project' })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(thread.id).status === 'idle');
    assert.equal(rig.h.runner.get(thread.id).waitState, 'job');

    const handed = [] as string[];
    await rig.h.runner.beginDrain([thread.id], { onHandedOver: (id) => handed.push(id), backgroundMs: 30 * 60_000 });
    assert.equal(handed.length, 0, 'draining runner must not hand over / kill OpenCode while background shell runs');
    assert.equal(rig.h.runner.get(thread.id).live, true);

    // The shell exits: OpenCode's wake can take longer than Claude's 15 s,
    // and handing over then lost it (28 Nov 2026, c2df7d18).
    alive.delete(42040);
    await until(() => rig.h.runner.get(thread.id).background?.some((b) => b.finished === true) === true);
    clock.advance(20_000);
    await flushImmediate();
    assert.equal(handed.length, 0, 'not handed over during OpenCode\'s wake grace');
    assert.equal(rig.h.runner.get(thread.id).live, true);
    // Its grace elapses with no wake: the runner's nudge is queued and goes
    // across with the thread, for the new runner to start (as lapsed cards do).
    clock.advance(ACP_WAKE_GRACE_MS);
    await until(() => handed.includes(thread.id));
    const queued = rig.h.store.load(thread.id)?.queue ?? [];
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.origin, 'runner');
    assert.match(queued[0]!.text, /weren't woken to read its result:\n\n- Build project/);
    assert.deepEqual(handed, [thread.id]);
    assert.equal(rig.h.runner.workingThreads(), 0);
  } finally {
    await rig.close();
  }
});

test('same-buffer session/prompt response + wake tool_call opens cliTurn cleanly without closing the wake tool', async () => {
  const alive = new Set([42050]);
  const rig = makeRunnerRig({ alivePids: alive, pollMs: 20, settleMs: { endTurn: 40, text: 60, idle: 180 } });
  try {
    const { thread } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({
        shellId: 'sh_same_buf',
        pid: 42050,
        command: 'quick-bg',
        sameChunkWake: {
          toolId: 'wake-tool-1',
          command: 'inspect output',
          finishAfterMs: 40,
          output: 'clean wake result',
          text: 'Background output verified.',
        },
      })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });

    await until(() => rig.h.events(thread.id).filter((e) => e.type === 'turn.completed').length === 2);
    const evs = rig.h.events(thread.id);
    const toolResults = evs.filter((e) => e.type === 'tool.result' && e.itemId === 'wake-tool-1');
    assert.equal(toolResults.length, 1, 'wake tool should complete once cleanly');
    assert.equal(toolResults[0]?.ok, true);
    assert.match(toolResults[0]?.text ?? '', /clean wake result/);
    const wakeTurn = evs.filter((e) => e.type === 'turn.completed')[1];
    assert.equal(wakeTurn?.outcome, 'completed');
  } finally {
    await rig.close();
  }
});

test('user message sent during an unsolicited wake closes the wake immediately and does not inherit wake end_turn', async () => {
  const alive = new Set([42051]);
  const rig = makeRunnerRig({
    alivePids: alive,
    withEndTurn: true,
    pollMs: 20,
    settleMs: { endTurn: 600, endTurnWaitText: 600, text: 600, idle: 600 },
  });
  try {
    const { thread } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({ shellId: 'sh_steer', pid: 42051, command: 'sleep 30' })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(thread.id).status === 'idle');

    // Start an unsolicited wake that takes end_turn (needs: 'nothing', archive: true) and lingers.
    alive.delete(42051);
    await until(() => rig.h.runner.get(thread.id).background?.some((b) => b.finished === true) === true);
    sendWake(rig.session(), {
      text: 'Initial background update.',
      endTurn: { headline: 'Background done', needs: 'nothing', archive: true },
    });
    await until(() => rig.h.runner.get(thread.id).status === 'running');
    await until(() => rig.h.events(thread.id).some((e) => e.type === 'tool.result' && e.ok === true && /mcp-end-turn-/.test(e.itemId)));

    // Mike sends a follow-up while the wake turn is still open. It must dispatch
    // immediately (not wait for the 600ms wake settle), cancel the wake's archive
    // request, keep the follow-up's text, and let the follow-up call end_turn
    // cleanly without ALREADY_ENDED refusal.
    const t0 = Date.now();
    const followAsks = [{ question: 'Confirm the staging deploy looks good.' }];
    await rig.h.runner.send(thread.id, `direct_end_turn ${JSON.stringify({ headline: 'Follow-up answered', needs: 'you', asks: followAsks })}`);
    await until(() => rig.h.events(thread.id).filter((e) => e.type === 'turn.completed').length === 2);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `steered message should interrupt unsolicited wake immediately, took ${elapsed}ms`);

    const evs = rig.h.events(thread.id);
    const completed = evs.filter((e) => e.type === 'turn.completed')[1];
    assert.equal(completed?.outcome, 'completed');
    assert.equal(completed?.needs, 'you', 'follow-up end_turn must be accepted rather than refused as ALREADY_ENDED');
    assert.equal(rig.h.runner.get(thread.id).archivedAt, undefined, 'wake end_turn archive must not archive the thread after a follow-up message');
  } finally {
    await rig.close();
  }
});

test('maxLive cap does not evict an OpenCode thread during wake grace', async () => {
  const clock = new FakeClock();
  const alive = new Set([42052]);
  const rig = makeRunnerRig({ alivePids: alive, maxLive: 1, pollMs: 20, clock });
  try {
    const { thread: t1 } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({ shellId: 'sh_cap', pid: 42052, command: 'build' })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(t1.id).status === 'idle');
    assert.equal(rig.h.runner.get(t1.id).waitState, 'job');

    // Shell finishes and enters wake grace.
    alive.delete(42052);
    await until(() => rig.h.runner.get(t1.id).background?.some((b) => b.finished === true) === true);
    assert.equal(rig.h.runner.workingThreads(), 1, 'wake grace counts as working');

    // Starting a second thread under maxLive: 1 must NOT evict t1 during wake grace.
    const { thread: t2 } = rig.h.runner.create({
      text: 'say second thread',
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(t2.id).status === 'idle');
    assert.equal(rig.h.runner.get(t1.id).live, true, 't1 must not be evicted by maxLive during wake grace');

    // Once wake grace expires (and the runner's nudge turn has run), a third thread can evict t1 normally.
    clock.advance(ACP_WAKE_GRACE_MS + 1_000);
    await until(() => rig.h.runner.get(t1.id).background === undefined && rig.h.runner.get(t1.id).status === 'idle' && rig.h.events(t1.id).filter((e) => e.type === 'turn.completed').length === 2);
    const { thread: t3 } = rig.h.runner.create({
      text: 'say third thread',
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(t3.id).status === 'idle');
    assert.equal(rig.h.runner.get(t1.id).live, false, 't1 should be evictable once wake grace ends');
  } finally {
    await rig.close();
  }
});

test('background shell already dead when tool_call_update arrives still arms wake grace and populates wokeBy', async () => {
  const clock = new FakeClock();
  const alive = new Set<number>(); // PID 42053 is already dead before update arrives
  const rig = makeRunnerRig({ alivePids: alive, pollMs: 20, settleMs: { endTurn: 40, text: 60, idle: 180 }, clock });
  try {
    const { thread } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({ shellId: 'sh_instant', pid: 42053, command: 'fast-cmd', description: 'Instant shell' })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(thread.id).status === 'idle');
    const summary = rig.h.runner.get(thread.id);
    assert.equal(summary.waitState, 'job', 'wake grace holds thread in Running for already-exited shell');
    assert.deepEqual(summary.background, [{ kind: 'shell', description: 'Instant shell', finished: true }]);

    sendWake(rig.session(), { text: 'Saw instant shell output.' });
    await until(() => rig.h.events(thread.id).filter((e) => e.type === 'turn.completed').length === 2);
    const wakeStart = rig.h.events(thread.id).filter((e) => e.type === 'turn.started')[1];
    assert.deepEqual(wakeStart?.wokeBy, [{ kind: 'shell', description: 'Instant shell' }]);
  } finally {
    await rig.close();
  }
});

test('non-OpenCode ACP agent ignores shellID metadata and never tracks background shells', async () => {
  const root = tmp();
  made.push(root);
  const registry = new ProcessRegistry(path.join(root, 'run'), nullLogger);
  const outputs: AdapterOutput[] = [];
  const acp = new AcpAdapter({
    agent: ACP_AGENTS.cursor,
    binary: () => FAKE,
    registry,
    log: nullLogger,
    env: { PATH: process.env.PATH, FAKE_ACP_NAME: 'Cursor' },
    timings: { closeWaitMs: 300 },
    shellPidAlive: () => true,
  });
  let done!: () => void;
  const resultReady = new Promise<void>((r) => (done = r));
  const s = acp.start(
    {
      threadId: 't-cursor',
      cwd: root,
      account: { id: 'cursor-main', provider: 'cursor', title: 'Cursor', configDir: root },
      permissionMode: 'full',
      sessionId: 'ses-cursor',
      resume: false,
      mediaDir: path.join(root, 'media'),
      blobsDir: path.join(root, 'blobs'),
      tmpDir: root,
    },
    {
      output(o) {
        outputs.push(o);
        if (o.kind === 'result') done();
      },
      requestApproval: async () => ({ decision: 'allow' }),
      requestQuestion: async () => ({ answers: null }),
      exited() {},
    },
  );
  sessions.push(s);
  s.send({ id: 'm1', text: `bg_shell ${JSON.stringify({ shellId: 'sh_cursor', pid: 42054, command: 'sleep 60' })}`, images: [] });
  await resultReady;
  assert.deepEqual(outputs.filter((o) => o.kind === 'tasks'), [], 'non-waking ACP agent must ignore shellID metadata');
  await registry.killAll(200);
});

test('unsolicited wake with a stalled unclosed tool recovers via toolStall deadline and never leaks Running', async () => {
  const alive = new Set([42055]);
  const rig = makeRunnerRig({
    alivePids: alive,
    pollMs: 20,
    settleMs: { endTurn: 40, text: 60, idle: 80, toolStall: 120 },
  });
  try {
    const { thread } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({ shellId: 'sh_stall', pid: 42055, command: 'sleep 30' })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(thread.id).status === 'idle');

    alive.delete(42055);
    await until(() => rig.h.runner.get(thread.id).background?.some((b) => b.finished === true) === true);

    // Wake starts a tool that never sends a final tool_call_update.
    sendWake(rig.session(), {
      tool: { id: 'stalled-tool', command: 'hung-step', leaveOpen: true },
    });
    await until(() => rig.h.runner.get(thread.id).status === 'running');

    assert.equal(rig.h.runner.get(thread.id).status, 'running');
    await until(() => rig.h.events(thread.id).filter((e) => e.type === 'turn.completed').length === 2);
    const closed = rig.h.events(thread.id).find((e) => e.type === 'tool.result' && e.itemId === 'stalled-tool');
    assert.ok(closed, 'stalled tool should be closed on recovery');
    assert.equal(closed.ok, false);
    assert.equal(rig.h.runner.get(thread.id).status, 'idle');
    assert.equal(rig.h.runner.workingThreads(), 0);
  } finally {
    await rig.close();
  }
});

test('late wake end_turn while steered message awaits model setup is refused and does not attach to the user turn', async () => {
  const alive = new Set([42060]);
  const rig = makeRunnerRig({
    alivePids: alive,
    withEndTurn: true,
    pollMs: 20,
    settleMs: { endTurn: 600, endTurnWaitText: 600, text: 600, idle: 600 },
    env: { FAKE_ACP_SLOW_SET: '180' },
  });
  try {
    const { thread } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({ shellId: 'sh_slow_set', pid: 42060, command: 'sleep 30' })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(thread.id).status === 'idle');

    // Change model on the session so the next user prompt awaits session/set_config_option (180ms).
    await rig.session().setModel('fake/two');

    alive.delete(42060);
    await until(() => rig.h.runner.get(thread.id).background?.some((b) => b.finished === true) === true);

    // Start an unsolicited wake whose end_turn waits behind a gate, then release
    // it immediately after user send() starts awaiting the 180ms applyModel RPC.
    sendWake(rig.session(), {
      thought: 'Reading background output...',
      endTurnGate: 'late-end-turn',
      endTurn: { headline: 'Stale wake end_turn', needs: 'nothing', archive: true },
    });
    await until(() => rig.h.runner.get(thread.id).status === 'running');

    const followAsks = [{ question: 'Confirm the staging deploy looks good.' }];
    await rig.h.runner.send(thread.id, `direct_end_turn ${JSON.stringify({ headline: 'User turn done', needs: 'you', asks: followAsks })}`);
    sendWakeGate(rig.session(), 'late-end-turn');
    await until(() => rig.h.events(thread.id).filter((e) => e.type === 'turn.completed').length === 2);

    const evs = rig.h.events(thread.id);
    const endTurnCalls = evs.filter((e) => e.type === 'tool.call' && e.name === 'mcp__threadbear__end_turn');
    assert.equal(endTurnCalls.length, 1, 'stale pre-dispatch wake end_turn must not attach a tool.call to the user turn');
    assert.equal((endTurnCalls[0]?.input as Record<string, unknown>)?.headline, 'User turn done');
    const completed = evs.filter((e) => e.type === 'turn.completed')[1];
    assert.equal(completed?.needs, 'you');
    assert.equal(rig.h.runner.get(thread.id).archivedAt, undefined);
  } finally {
    await rig.close();
  }
});

test('unsolicited wake progress text before one-reply end_turn still gets the full endTurnWaitText window', async (t) => {
  const alive = new Set([42061]);
  const rig = makeRunnerRig({
    alivePids: alive,
    withEndTurn: true,
    pollMs: 20,
    settleMs: { endTurn: 50, endTurnWaitText: 350, text: 600, idle: 600 },
  });
  try {
    const { thread } = rig.h.runner.create({
      text: `bg_shell ${JSON.stringify({ shellId: 'sh_wait_txt', pid: 42061, command: 'sleep 30' })}`,
      accountId: 'opencode-main',
      permissionMode: 'full',
    });
    await until(() => rig.h.runner.get(thread.id).status === 'idle');

    alive.delete(42061);
    await until(() => rig.h.runner.get(thread.id).background?.some((b) => b.finished === true) === true);

    // Emit progress text BEFORE end_turn, hold the final reply behind a gate,
    // advance fake timers past endTurn settle (50ms) and verify the turn stays open
    // waiting for the final reply, then release the gate.
    sendWake(rig.session(), {
      text: 'Checking the test log now...',
      endTurn: { headline: 'Checks green', needs: 'nothing' },
      textAfterEndTurnGate: 'final-reply',
      textAfterEndTurn: 'All integration checks passed with zero errors.',
    });
    await until(() => rig.h.events(thread.id).some((e) => e.type === 'tool.result' && e.ok === true && /mcp-end-turn-/.test(e.itemId)));

    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.timers.tick(150);
    assert.equal(rig.h.events(thread.id).filter((e) => e.type === 'turn.completed').length, 1, 'turn must stay open past endTurn settle while waiting for final reply');
    t.mock.timers.reset();

    sendWakeGate(rig.session(), 'final-reply');
    await until(() => rig.h.events(thread.id).filter((e) => e.type === 'turn.completed').length === 2);
    const evs = rig.h.events(thread.id);
    assert.equal(evs.filter((e) => e.type === 'turn.started').length, 2, 'final reply must land in the same wake turn, not open a second one');
    const finalMsg = evs.find((e) => e.type === 'assistant.text' && e.text.includes('All integration checks passed'));
    assert.ok(finalMsg, 'final reply after one-reply end_turn must be captured');
  } finally {
    await rig.close();
  }
});

test('AcpProcess preserves response barriers when multiple responses arrive right before process exit', async () => {
  const root = tmp();
  made.push(root);
  const registry = new ProcessRegistry(path.join(root, 'run'), nullLogger);
  const script = path.join(root, 'two-resp-exit.mjs');
  fs.writeFileSync(
    script,
    [
      "import readline from 'node:readline';",
      "const seen = [];",
      "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
      "  const m = JSON.parse(line);",
      "  if (m.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } }) + '\\n');",
      "    return;",
      "  }",
      "  seen.push(m.id);",
      "  if (seen.length === 2) {",
      "    process.stdout.write(",
      "      JSON.stringify({ jsonrpc: '2.0', id: seen[0], result: { step: 1 } }) + '\\n' +",
      "      JSON.stringify({ jsonrpc: '2.0', id: seen[1], result: { step: 2 } }) + '\\n'",
      "    );",
      "    process.exit(0);",
      "  }",
      "});",
    ].join('\n'),
  );
  const proc = new AcpProcess({
    binary: process.execPath,
    args: [script],
    env: { PATH: process.env.PATH },
    cwd: root,
    registry,
    log: nullLogger,
    label: 'two-resp-exit',
  });
  await proc.start();
  const order: string[] = [];
  let exitDone!: () => void;
  const exited = new Promise<void>((r) => (exitDone = r));
  proc.onExit = () => {
    order.push('exit');
    exitDone();
  };
  const p1 = proc.request<{ step: number }>('step/one', {}).then((r) => {
    order.push(`r${r.step}`);
  });
  const p2 = proc.request<{ step: number }>('step/two', {}).then((r) => {
    order.push(`r${r.step}`);
  });
  await Promise.all([p1, p2, exited]);
  assert.deepEqual(order, ['r1', 'r2', 'exit'], 'both response continuations must run before onExit');
  await registry.killAll(200);
});
