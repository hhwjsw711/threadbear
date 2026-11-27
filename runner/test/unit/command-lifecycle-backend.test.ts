// A phone command's lifecycle in the backend (convex/sync.ts, "A command's
// lifecycle"): pending -> taken -> done | failed, and nothing else. Found by
// reading the code on 17 Nov 2026 (the state machines survey): a take whose
// answer was lost made the runner's retry get false and drop the command,
// leaving it taken with nobody running it for 14 days; a finish overwrote a
// command however it had ended; and a runner that stopped mid-apply left it
// "Sending…" on the phone for two weeks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { call, load, memoryBackend, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const CLOUD_KEY = 'tbr_cloud';
const MINI = 'cb921b2447ea';
const CLOUD = 'befe8df8975c';
const TOKEN = 'phone-token';
const ATTEMPT = '3b241101-e2bb-4255-8caf-4136c566a962';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');
const relay = load('relay');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  await b.ctx.db.insert('runnerKeys', { runnerId: CLOUD, keyHash: await sha256(CLOUD_KEY), name: 'cloud', createdAt: 1 });
  for (const runnerId of [MINI, CLOUD]) await b.ctx.db.insert('runners', { runnerId, name: runnerId, version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'iphone', kind: 'phone', expiresAt: Date.now() + 1e9, createdAt: Date.now() });
  await call(b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ ...THREAD_BASICS, threadId: 'B', runnerId: MINI, title: 'T', view: 'inbox', needsYou: false }] });
  const send = async (text = 'hello') => (await call(b.ctx, phone.send, { token: TOKEN, threadId: 'B', text })) as string;
  const row = (id: string) => b.rows('commands').find((r) => r._id === id)!;
  const seen = async (id: string) => call(b.ctx, phone.command, { token: TOKEN, commandId: id });
  return { ...b, send, row, seen };
}

const machinesModule = load('machines');

// Runs what the machine scheduled (commandEnded, after an expiry or a lapse).
async function runScheduled(s: { ctx: unknown; scheduled: unknown[] }) {
  for (const job of (s.scheduled as { fn: string; args: Record<string, unknown> }[]).splice(0)) {
    if (job.fn.endsWith('commandEnded')) await call(s.ctx, sync.commandEnded, job.args);
  }
}

// Fires the machine's timers due by `at`, as Convex's scheduler would.
async function fireTimers(s: { ctx: unknown; pendingTimers: () => { id: string; args: any; at: number }[]; timerRan: (id: string) => void }, at: number) {
  for (const t of s.pendingTimers().filter((t) => t.at <= at)) {
    await later(at - Date.now(), () => call(s.ctx, machinesModule.deliver, t.args));
    s.timerRan(t.id);
  }
}

async function later<T>(ms: number, f: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await f();
  } finally {
    Date.now = realNow;
  }
}

test('a take whose answer was lost: the same attempt asking again gets it, so the command runs once', async () => {
  const s = await setup();
  const id = await s.send();
  // The first ask commits; the runner never hears its true.
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: ATTEMPT }), true);
  // Its retry with the same attempt is told it has it.
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: ATTEMPT }), true);
  // Nobody else gets it: no attempt (an older runner, or a second process), another attempt, another runner.
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id }), false);
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: 'another-attempt-id' }), false);
  assert.equal(await outcome(call(s.ctx, sync.takeCommand, { key: CLOUD_KEY, commandId: id, attempt: ATTEMPT })), 'forbidden');
  // Once it's finished, the attempt gets nothing: it can't run twice.
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: id, ok: true });
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: ATTEMPT }), false);
  assert.equal((await s.seen(id)).state, 'done');
  // An attempt has to look like one.
  const other = await s.send('again');
  assert.equal(await outcome(call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: other, attempt: 'x' })), 'badArgs');
  assert.equal(s.row(other).state, 'pending');
});

test('an older runner, with no attempt, takes a command once as before', async () => {
  const s = await setup();
  const id = await s.send();
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id }), true);
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id }), false);
  assert.equal(s.row(id).attempt, undefined);
});

test('a finish changes only a taken command: a repeated or stale one leaves how it ended', async () => {
  const s = await setup();
  // Finished once, then again with another outcome (a retry after a lost answer).
  const a = await s.send();
  await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: a });
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: a, ok: true });
  const doneAt = s.row(a).doneAt;
  await later(60_000, () => call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: a, ok: false, note: 'boom' }));
  assert.deepEqual([s.row(a).state, s.row(a).note, s.row(a).doneAt], ['done', undefined, doneAt]);
  // Cancelled on the phone before any runner took it: a finish doesn't revive it.
  const b = await s.send();
  assert.equal(await call(s.ctx, phone.cancel, { token: TOKEN, commandId: b }), true);
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: b, ok: true });
  assert.deepEqual([s.row(b).state, s.row(b).note], ['failed', 'Cancelled']);
  // Never taken: still waiting, for the take that will run it.
  const c = await s.send();
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: c, ok: true });
  assert.equal(s.row(c).state, 'pending');
});

test("a taken command whose runner never finishes it shows as failed after its lease, and isn't handed out again", async () => {
  const s = await setup();
  const id = await s.send();
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: ATTEMPT }), true);
  // Within the lease nothing happens.
  await later(sync.TAKEN_LEASE_MS - 60_000, () => call(s.ctx, sync.lapseCommands, {}));
  assert.equal((await s.seen(id)).state, 'taken');
  await later(sync.TAKEN_LEASE_MS + 60_000, () => call(s.ctx, sync.lapseCommands, {}));
  await runScheduled(s);
  assert.deepEqual(await s.seen(id), { state: 'failed', note: sync.LAPSED_NOTE });
  // The phone's list of waiting messages lets it go.
  assert.deepEqual(await call(s.ctx, phone.waiting, { token: TOKEN, threadId: 'B' }), []);
  // Nothing takes it again, not even its own attempt: it may have run.
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: ATTEMPT }), false);
  assert.deepEqual(await call(s.ctx, sync.pendingCommands, { key: MINI_KEY, runnerId: MINI }), []);
  // Its runner's late answer still says how it really went, once.
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: id, ok: true });
  assert.deepEqual(await s.seen(id), { state: 'done' });
  assert.equal(s.row(id).lapsedAt, undefined);
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: id, ok: false, note: 'late again' });
  assert.deepEqual(await s.seen(id), { state: 'done' });
});

test('lapsing goes a batch at a time, and schedules itself again while more are due', async () => {
  const s = await setup();
  const ids: string[] = [];
  for (let i = 0; i < 101; i++) {
    const id = await s.send(`m${i}`);
    await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id });
    ids.push(id);
  }
  await later(sync.TAKEN_LEASE_MS + 60_000, () => call(s.ctx, sync.lapseCommands, {}));
  assert.equal(ids.filter((id) => s.row(id).state === 'failed').length, 100);
  assert.ok(s.scheduled.some((j: any) => j.fn.endsWith('lapseCommands')));
  await later(sync.TAKEN_LEASE_MS + 60_000, () => call(s.ctx, sync.lapseCommands, {}));
  assert.equal(ids.filter((id) => s.row(id).state === 'failed').length, 101);
});

// Codex's review: a lapse dropped the args a late finish is checked by, so a
// late moves.describe answer kept its origin's ssh user, and a late login
// change's answer was thrown away.
test("a lapsed command's late finish is checked as an on-time one: a description's origin is cleaned, a login change's answer kept", async () => {
  const s = await setup();
  const describe = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'call', args: { method: 'moves.describe', params: {} } });
  const login = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'update', args: { accountId: 'claude-2' } });
  for (const id of [describe, login]) await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: ATTEMPT });
  await later(sync.TAKEN_LEASE_MS + 60_000, () => call(s.ctx, sync.lapseCommands, {}));
  await runScheduled(s);
  assert.deepEqual([s.row(describe).state, s.row(login).state], ['failed', 'failed']);
  assert.equal(s.row(describe).args.params, undefined, 'its words still go');
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: describe, ok: true, result: JSON.stringify({ title: 't', cwd: '/c', home: '/h', provider: 'claude', origin: 'ssh://UNCLASSIFIEDSSHLOGIN@example.com/owner/repo.git' }) });
  assert.ok(!String(s.row(describe).result).includes('UNCLASSIFIEDSSHLOGIN'), s.row(describe).result);
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: login, ok: true, result: JSON.stringify({ accountId: 'claude-2' }) });
  assert.equal(s.row(login).result, JSON.stringify({ accountId: 'claude-2' }));
  assert.deepEqual([s.row(describe).state, s.row(login).state], ['done', 'done']);
});

test('lapsing reads within its byte budget, so taken messages of hundreds of KB still lapse, a run at a time', async () => {
  const s = await setup();
  const big = 'x'.repeat(256 * 1024);
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const id = await s.send(big + i);
    await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id });
    ids.push(id);
  }
  let runs = 0;
  while (ids.some((id) => s.row(id).state === 'taken')) {
    s.resetReads();
    await later(sync.TAKEN_LEASE_MS + 60_000, () => call(s.ctx, sync.lapseCommands, {}));
    assert.ok(s.bytesRead() < 16 * 1024 * 1024, `read ${s.bytesRead()}`);
    assert.ok(++runs < 10);
  }
  assert.ok(runs > 1, 'more than one run');
});

// ------------------------------------------------------------ runner requests

async function confirmStart(s: Awaited<ReturnType<typeof setup>>, requestId: string, docId: string, claim: string, approved = true) {
  const confirmation = await call(s.ctx, relay.queueCommand, {
    key: OWNER, runnerId: MINI, threadId: 'B', kind: 'call',
    args: { method: 'requests.confirmStart', params: { approvalId: requestId, docId, claim } },
  });
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: confirmation, attempt: ATTEMPT }), true);
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: confirmation, ok: true, result: JSON.stringify(approved) });
  return confirmation;
}

test("a runner request's claim: the same claim asked again is told yes, any other is refused, and a handed-back claim is spent", async () => {
  const s = await setup();
  await call(s.ctx, relay.fileRequest, { key: MINI_KEY, requestId: 'req-00001', threadId: 'B', target: 'main', request: { text: 'start one' } });
  const row = () => s.rows('runnerRequests').find((r) => r.requestId === 'req-00001')!;
  const decide = (state: string, extra: Record<string, unknown> = {}) => call(s.ctx, relay.decideRequest, { key: OWNER, requestId: 'req-00001', docId: String(row()._id), state, ...extra });
  assert.equal(await outcome(decide('claimed', { claim: ATTEMPT })), 'badArgs', 'an older owner cannot claim on the synced card alone');
  const confirm = (claim: string, approved = true) => confirmStart(s, 'req-00001', String(row()._id), claim, approved);
  const refused = await confirm(ATTEMPT, false);
  assert.equal(await outcome(decide('claimed', { claim: ATTEMPT, confirmation: refused })), 'badArgs');
  const confirmation = await confirm(ATTEMPT);
  assert.equal(await outcome(decide('claimed', { claim: 'other-claim-id', confirmation })), 'badArgs');
  assert.equal(await later(60_000, () => outcome(decide('claimed', { claim: ATTEMPT, confirmation }))), 'badArgs');
  await decide('claimed', { claim: ATTEMPT, confirmation });
  assert.deepEqual([row().state, row().claim], ['claimed', ATTEMPT]);
  // Its answer was lost; asking again with the same claim is fine, and changes nothing.
  await decide('claimed', { claim: ATTEMPT, confirmation });
  // Another claim, or none (an older runner), is refused as before.
  assert.equal(await outcome(decide('claimed', { claim: 'another-claim-id', confirmation: await confirm('another-claim-id') })), 'badArgs');
  assert.equal(await outcome(decide('claimed')), 'badArgs');
  assert.equal(await outcome(decide('claimed', { claim: 'x' })), 'badArgs');
  // Handed back: the claim goes with it, so it can't be reused to skip the next claim.
  await decide('pending');
  assert.deepEqual([row().state, row().claim], ['pending', undefined]);
  await decide('claimed', { claim: 'second-claim-id', confirmation: await confirm('second-claim-id') });
  assert.equal(await outcome(decide('claimed', { claim: ATTEMPT, confirmation })), 'badArgs');
  // The asking runner reads it back with its claim (requestOut lets it through).
  assert.equal((await call(s.ctx, relay.runnerRequest, { key: OWNER, requestId: 'req-00001' })).claim, 'second-claim-id');
});

test("a runner request's machine: allowed with where it started, denied or closed only while pending, and requestState always agrees with state", async () => {
  const s = await setup();
  const file = (requestId: string) => call(s.ctx, relay.fileRequest, { key: MINI_KEY, requestId, threadId: 'B', target: 'main', request: { text: 'start one' } });
  const row = (requestId: string) => s.rows('runnerRequests').find((r) => r.requestId === requestId)!;
  const decide = (requestId: string, state: string, extra: Record<string, unknown> = {}) => call(s.ctx, relay.decideRequest, { key: OWNER, requestId, docId: String(row(requestId)._id), state, ...extra });
  const close = (requestId: string) => call(s.ctx, relay.closeRequest, { key: MINI_KEY, requestId });
  const where = { runnerId: 'laptop000001', runnerName: 'Laptop', threadId: 'new-thread' };
  for (const id of ['req-allow1', 'req-deny01', 'req-close1']) await file(id);
  assert.deepEqual(row('req-allow1').requestState, { kind: 'pending' });

  // Allowed: claimed first, and it has to say where it started.
  assert.equal(await outcome(decide('req-allow1', 'allowed', { result: where })), 'badArgs', 'not before a claim');
  const confirm = (id: string) => confirmStart(s, id, String(row(id)._id), ATTEMPT);
  const confirmation = await confirm('req-allow1');
  assert.equal(await outcome(decide('req-close1', 'claimed', { claim: ATTEMPT, confirmation })), 'badArgs', 'a proof for another request cannot claim this one');
  await decide('req-allow1', 'claimed', { claim: ATTEMPT, confirmation });
  assert.equal(await outcome(decide('req-allow1', 'allowed')), 'badArgs');
  // The asking runner can't close one that may be starting: nothing changes.
  await close('req-allow1');
  assert.equal(row('req-allow1').state, 'claimed');
  assert.equal(await outcome(decide('req-allow1', 'denied')), 'badArgs');
  await decide('req-allow1', 'allowed', { result: where });
  assert.deepEqual([row('req-allow1').state, row('req-allow1').result], ['allowed', where]);
  assert.equal(await outcome(decide('req-allow1', 'pending')), 'badArgs', 'an allowed one is never handed back');

  await decide('req-deny01', 'denied');
  assert.equal(row('req-deny01').state, 'denied');
  const closeConfirmation = await confirm('req-close1');
  await close('req-close1');
  await close('req-close1'); // again is fine
  assert.equal(row('req-close1').state, 'closed');
  assert.equal(await outcome(decide('req-close1', 'claimed', { claim: ATTEMPT, confirmation: closeConfirmation })), 'badArgs');
  for (const r of s.rows('runnerRequests')) assert.equal(r.requestState.kind, r.state, JSON.stringify(r));
  // None of the machine's own fields reach the runners.
  assert.ok(!('requestState' in (await call(s.ctx, relay.runnerRequest, { key: OWNER, requestId: 'req-allow1' }))));
});


test('closing an accepted card lets its in-flight confirmation claim the request before cleanup', async () => {
  const s = await setup();
  for (const requestId of ['req-accept1', 'req-unused1']) {
    await call(s.ctx, relay.fileRequest, { key: MINI_KEY, requestId, threadId: 'B', target: 'main', request: { text: 'start one' } });
    const row = () => s.rows('runnerRequests').find((r) => r.requestId === requestId)!;
    const docId = String(row()._id);
    const confirmation = await confirmStart(s, requestId, docId, ATTEMPT);
    await call(s.ctx, relay.closeRequest, { key: MINI_KEY, requestId, afterConfirmation: true });
    assert.equal(row().state, 'pending');
    if (requestId === 'req-accept1') {
      await call(s.ctx, relay.decideRequest, { key: OWNER, requestId, docId, state: 'claimed', claim: ATTEMPT, confirmation });
    }
    const job = (s.scheduled as { fn: string; args: Record<string, unknown> }[]).find((j) => j.fn.endsWith('closeAfterConfirmation') && j.args.docId === docId);
    assert.ok(job);
    await later(60_000, () => call(s.ctx, relay.closeAfterConfirmation, job.args));
    assert.equal(row().state, requestId === 'req-accept1' ? 'claimed' : 'closed');
    if (requestId === 'req-accept1') {
      await call(s.ctx, relay.decideRequest, { key: OWNER, requestId, docId, state: 'pending', claim: ATTEMPT });
      assert.equal(row().state, 'closed', 'a hand-back after cleanup never reopens a closed card');
      assert.equal(row().requestState.kind, 'closed');
    }
  }
});

test('the backfill gives runner requests from before requestState theirs', async () => {
  const s = await setup();
  const now = Date.now();
  const old = [
    { requestId: 'req-old-p', state: 'pending', want: { kind: 'pending' } },
    { requestId: 'req-old-c', state: 'claimed', claim: ATTEMPT, decidedAt: now - 5, want: { kind: 'claimed', claimedAt: now - 5, claim: ATTEMPT } },
    { requestId: 'req-old-a', state: 'allowed', decidedAt: now - 3, want: { kind: 'allowed', decidedAt: now - 3 } },
    { requestId: 'req-old-x', state: 'closed', want: { kind: 'closed', decidedAt: now - 10 } },
  ];
  for (const { want: _, ...r } of old) await s.ctx.db.insert('runnerRequests', { runnerId: MINI, threadId: 'B', target: 'main', text: 't', createdAt: now - 10, ...r, requestState: undefined });
  while (!(await call(s.ctx, migrations.run, { name: 'requestState' })).done);
  assert.equal(await call(s.ctx, migrations.done, { name: 'requestState' }), true);
  assert.deepEqual(old.map((o) => s.rows('runnerRequests').find((r) => r.requestId === o.requestId)!.requestState), old.map((o) => o.want));
});

// ------------------------------------------------------------ the widen (commandState)

const migrations = load('migrations');
const { legacyState } = load('commandStates') as { legacyState: (s: { kind: string }) => string };

test('every move writes commandState with state, so the two always agree', async () => {
  const s = await setup();
  const ids = [await s.send('a'), await s.send('b'), await s.send('c'), await s.send('d')];
  const [a, b, c, d] = ids as [string, string, string, string];
  await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: a, attempt: ATTEMPT });
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: a, ok: true });
  await call(s.ctx, phone.cancel, { token: TOKEN, commandId: b });
  await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: c });
  await later(sync.TAKEN_LEASE_MS + 60_000, () => call(s.ctx, sync.lapseCommands, {}));
  const kinds = Object.fromEntries(ids.map((id) => [id, s.row(id).commandState?.kind]));
  assert.deepEqual(kinds, { [a]: 'done', [b]: 'failed', [c]: 'lapsed', [d]: 'pending' });
  assert.deepEqual(s.row(a).commandState, { kind: 'done', doneAt: s.row(a).doneAt });
  for (const r of s.rows('commands')) assert.equal(legacyState(r.commandState), r.state, JSON.stringify(r));
  // The main Mac's own commands for another runner too.
  const q = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'send', args: { text: 'hi' } });
  assert.deepEqual(s.row(q).commandState, { kind: 'pending' });
});

test('the backfill gives every row from before commandState its state, a page at a time, and says when it has', async () => {
  const s = await setup();
  const now = Date.now();
  const old = [
    { state: 'pending', want: { kind: 'pending' } },
    { state: 'taken', takenAt: now - 5, attempt: ATTEMPT, want: { kind: 'taken', takenAt: now - 5, attempt: ATTEMPT } },
    { state: 'done', doneAt: now - 3, want: { kind: 'done', doneAt: now - 3 } },
    { state: 'failed', doneAt: now - 2, want: { kind: 'failed', doneAt: now - 2 } },
    { state: 'failed', doneAt: now - 1, lapsedAt: now - 1, want: { kind: 'lapsed', doneAt: now - 1, lapsedAt: now - 1 } },
  ];
  const ids: string[] = [];
  // Rows from before the backfill: no commandState at all.
  for (const { want: _, ...row } of old) ids.push(await s.ctx.db.insert('commands', { runnerId: MINI, kind: 'send', args: {}, createdAt: now - 10, ...row, commandState: undefined }));
  for (let i = 0; i < 230; i++) await s.ctx.db.insert('commands', { runnerId: MINI, kind: 'send', args: {}, createdAt: now, state: 'done', doneAt: now, commandState: undefined });
  const fresh = await s.send('already has it');
  assert.equal(await call(s.ctx, migrations.done, { name: 'commandState' }), false);
  let runs = 0;
  while (!(await call(s.ctx, migrations.run, { name: 'commandState' })).done) assert.ok(++runs < 10);
  assert.equal(runs, 2, 'three pages of 100');
  assert.equal(await call(s.ctx, migrations.done, { name: 'commandState' }), true);
  assert.deepEqual(ids.map((id) => s.row(id).commandState), old.map((o) => o.want));
  assert.ok(s.rows('commands').every((r) => r.commandState && Array.isArray(r.commandStateTimers)));
  assert.deepEqual(s.row(fresh).commandState, { kind: 'pending' });
  // Run again: nothing to do.
  assert.deepEqual(await call(s.ctx, migrations.run, { name: 'commandState' }), { done: true });
  assert.equal(await outcome(call(s.ctx, migrations.run, { name: 'nope' })), 'badArgs');
});

// ------------------------------------------------------------ the machine

test("the machine's own timers lapse a taken command and expire a pending one, and leaving a state cancels its timer", async () => {
  const s = await setup();
  const taken = await s.send('taken');
  const waiting = await s.send('waiting');
  const finished = await s.send('finished');
  assert.deepEqual(s.pendingTimers().map((t) => t.args.event).sort(), ['EXPIRED', 'EXPIRED', 'EXPIRED']);
  await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: taken, attempt: ATTEMPT });
  await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: finished });
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: finished, ok: true });
  // Taken: its expiry went and its lease began; finished: nothing left.
  assert.deepEqual(s.pendingTimers().map((t) => [t.args.id, t.args.event]).sort(), [[taken, 'LEASE_LAPSED'], [waiting, 'EXPIRED']].sort());
  assert.deepEqual(s.row(finished).commandStateTimers, []);
  await fireTimers(s, Date.now() + sync.TAKEN_LEASE_MS + 1000);
  await runScheduled(s);
  assert.deepEqual(await s.seen(taken), { state: 'failed', note: sync.LAPSED_NOTE });
  assert.equal(s.row(taken).commandState.kind, 'lapsed');
  assert.equal(s.row(waiting).state, 'pending');
  await fireTimers(s, Date.now() + sync.COMMAND_KEEP_MS + 1000);
  await runScheduled(s);
  assert.deepEqual(await s.seen(waiting), { state: 'failed', note: 'No runner took it in time.' });
  assert.equal(s.row(waiting).args.text, undefined, 'its words went');
});

test("every step is in the machine's history, and a refused one says why", async () => {
  const s = await setup();
  const id = await s.send();
  await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: ATTEMPT });
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: id, ok: true });
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: id, ok: false });
  const mine = s.history.filter((h) => h.subject === id);
  assert.deepEqual(mine.map((h) => [h.kind, h.event, h.from, h.to]).slice(0, 3), [
    ['step', 'QUEUE', 'start', 'pending'],
    ['step', 'TAKE', 'pending', 'taken'],
    ['step', 'FINISH', 'taken', 'done'],
  ]);
});

test('finished commands leave through the machine a day after they finish', async () => {
  const s = await setup();
  const id = await s.send();
  await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id });
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: id, ok: true });
  await later(25 * 60 * 60_000, () => call(s.ctx, sync.pruneOld, {}));
  assert.equal(s.rows('commands').some((r) => r._id === id), false);
  assert.equal(s.history.filter((h) => h.subject === id).at(-1)?.kind, 'purged');
});

test("the Machines page's queries answer only one of this deployment's tokens", async () => {
  const s = await setup();
  const viewer = load('viewer');
  const id = await s.send();
  await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id });
  for (const token of ['not-a-token', '']) {
    assert.equal(await call(s.ctx, viewer.overview, { token }), null);
    assert.equal(await call(s.ctx, viewer.counts, { token, machine: 'command' }), null);
    assert.equal(await call(s.ctx, viewer.row, { token, table: 'commands', id }), null);
  }
  const overview = await call(s.ctx, viewer.overview, { token: TOKEN });
  assert.deepEqual(overview.machines.map((m: { name: string }) => m.name), ['command', 'move', 'request', 'clear', 'box', 'cloudToken', 'relayInstall', 'boxTokenGrant']);
  assert.equal((await call(s.ctx, viewer.counts, { token: TOKEN, machine: 'command' })).counts.taken, 1);
  const row = await call(s.ctx, viewer.row, { token: TOKEN, table: 'commands', id });
  assert.equal(row.summary.states.command.kind, 'taken');
  // Only a machine's own tables: not tokens, keys or anything else.
  await assert.rejects(call(s.ctx, viewer.rows, { token: TOKEN, table: 'tokens' }), /isn't a machine's table/);
});

// Codex's review: a timer due while the deploy's stepping stone had the
// machine off failed its job, and nothing delivered it again.
test('timers that failed while the machine was off are delivered again after the deploy', async () => {
  const s = await setup();
  const id = await s.send();
  await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id });
  const lease = s.pendingTimers().find((t) => t.args.id === id && t.args.event === 'LEASE_LAPSED')!;
  s.timerFailed(lease.id);
  assert.deepEqual((await call(s.ctx, machinesModule.failedTimers, {})).map((t: { event: string }) => t.event), ['LEASE_LAPSED']);
  assert.equal(await call(s.ctx, machinesModule.rearmFailed, {}), null);
  await fireTimers(s, Date.now() + sync.TAKEN_LEASE_MS + 1000);
  assert.equal(s.row(id).commandState.kind, 'lapsed');
  assert.deepEqual(await call(s.ctx, machinesModule.failedTimers, {}), []);
});

// 19 Nov 2026: production had more than 4,096 scheduled jobs in its week,
// and reading them all in one mutation was over Convex's reads a function,
// so the deploy couldn't deliver the failed timers again. A page a run.
test('a failed timer behind more scheduled jobs than one function may read is still delivered again, a page a run', async () => {
  const s = await setup();
  const id = await s.send();
  await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id });
  const lease = s.pendingTimers().find((t) => t.args.id === id && t.args.event === 'LEASE_LAPSED')!;
  s.timerFailed(lease.id);
  const ctx = s.ctx as { scheduler: { runAfter: (ms: number, fn: unknown, args: unknown) => Promise<string> } };
  for (let i = 0; i < 5000; i++) s.timerRan(await ctx.scheduler.runAfter(0, 'sync:pruneOld', {}));
  let cursor: string | null = null;
  let runs = 0;
  do {
    s.resetReads();
    cursor = await call(s.ctx, machinesModule.rearmFailed, { cursor });
    assert.ok(s.reads() < 4096, `a run read ${s.reads()} rows`);
    assert.ok(++runs < 50);
  } while (cursor !== null);
  assert.ok(runs > 1);
  await fireTimers(s, Date.now() + sync.TAKEN_LEASE_MS + 1000);
  assert.equal(s.row(id).commandState.kind, 'lapsed');
});

// While the deploy's stepping stone has the request machine off, the main
// Mac's answer and the asking runner's close go through as before: a thread
// already started whose `allowed` was refused would leave its request
// claimed. A new request waits for the machine.
test('during the stepping stone, a request is answered and closed as before, keeping a backfilled one in step', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-stepping-'));
  try {
    const convex = path.join(import.meta.dirname, '../../../convex');
    for (const f of fs.readdirSync(convex)) if (f.endsWith('.ts')) fs.copyFileSync(path.join(convex, f), path.join(root, f));
    const stepping = path.join(root, 'stepping.ts');
    fs.writeFileSync(stepping, fs.readFileSync(stepping, 'utf8').replace('export const STEPPING: readonly string[] = [];', "export const STEPPING: readonly string[] = ['requestState'];"));
    process.env.RUNNER_KEY = OWNER;
    const b = memoryBackend(root);
    const relayAt = load('relay', root);
    const now = Date.now();
    const insert = (requestId: string, row: Record<string, unknown>) => b.ctx.db.insert('runnerRequests', { requestId, runnerId: MINI, threadId: 'B', target: 'main', text: 't', createdAt: now - 10, ...row });
    const row = (requestId: string) => b.rows('runnerRequests').find((r) => r.requestId === requestId)!;
    await insert('req-claimed', { state: 'claimed', claim: ATTEMPT, decidedAt: now - 5 });
    await insert('req-pend01', { state: 'pending', requestState: { kind: 'pending' } });
    const decide = (requestId: string, state: string, extra: Record<string, unknown> = {}) => call(b.ctx, relayAt.decideRequest, { key: OWNER, requestId, docId: String(row(requestId)._id), state, ...extra });
    const where = { runnerId: 'laptop000001', runnerName: 'Laptop', threadId: 'new-thread' };
    const confirmation = await b.ctx.db.insert('commands', {
      runnerId: MINI, threadId: 'B', kind: 'call', state: 'done', commandState: { kind: 'done', finishedAt: now },
      createdAt: now, result: 'true',
      args: { method: 'requests.confirmStart', params: { approvalId: 'req-claimed', docId: String(row('req-claimed')._id), claim: ATTEMPT } },
    });
    await decide('req-claimed', 'claimed', { claim: ATTEMPT, confirmation });
    await decide('req-claimed', 'allowed', { result: where });
    assert.deepEqual([row('req-claimed').state, row('req-claimed').result, row('req-claimed').requestState], ['allowed', where, undefined]);
    await call(b.ctx, relayAt.closeRequest, { key: OWNER, requestId: 'req-pend01' });
    assert.equal(row('req-pend01').state, 'closed');
    assert.equal(row('req-pend01').requestState.kind, 'closed');
    assert.equal(await outcome(decide('req-pend01', 'claimed', { claim: ATTEMPT })), 'badArgs');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
