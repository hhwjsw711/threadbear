// Per-runner keys (convex/runnerAccess.ts, docs/protocol/keys.md "Runner keys"):
// the owner key does everything, a runner key acts as its own runner only.
// The plain rules, without a deployment, plus a check that every function
// in convex/sync.ts is sorted and asks the gate under its own name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { convexPoster, forbiddenText } from '../../src/sync.ts';
import { ACCESS, actsAs, badRunnerStats, BOX_CALLS, BOX_READS, callerFrom, isIsoTime, mayCall, mayClaim, mayFinish, mayTake, mayTouch, mayUseStorage, mayWrite, ownsCard, sameKey, webLinksOnly, wholeIn, type Caller } from '../../../convex/runnerAccess.ts';

const OWNER_KEY = 'owner-key-of-the-deployment';
const LAPTOP = 'laptop000001';
const MINI = 'cb921b2447ea';
const owner = callerFrom(OWNER_KEY, OWNER_KEY, null) as Caller;
const mini = callerFrom('tbr_mac-mini', OWNER_KEY, { runnerId: MINI }) as Caller;

test('the owner key is the owner; a runner key is its own runner; anything else is nobody', () => {
  assert.deepEqual(owner, { owner: true });
  assert.deepEqual(mini, { owner: false, runnerId: MINI });
  assert.equal(callerFrom('wrong', OWNER_KEY, null), null);
  assert.equal(callerFrom('', OWNER_KEY, null), null);
  // A deployment with no RUNNER_KEY set has no owner, and an empty key never matches one.
  assert.equal(callerFrom('', undefined, null), null);
  assert.equal(callerFrom(OWNER_KEY, undefined, null), null);
});

test('while RUNNER_KEY is rotated, RUNNER_KEY_NEXT is the owner too', () => {
  assert.deepEqual(callerFrom('new-owner', [OWNER_KEY, 'new-owner'], null), { owner: true });
  assert.deepEqual(callerFrom(OWNER_KEY, [OWNER_KEY, 'new-owner'], null), { owner: true });
  assert.deepEqual(callerFrom(OWNER_KEY, [OWNER_KEY, undefined], null), { owner: true });
  assert.equal(callerFrom('', [undefined, undefined], null), null);
  // Once rotated, the old one (Mac mini's copy of it, say) is nobody.
  assert.equal(callerFrom(OWNER_KEY, ['new-owner', undefined], null), null);
});

test('a revoked runner key fails', () => {
  assert.equal(callerFrom('tbr_mac-mini', OWNER_KEY, { runnerId: MINI, revokedAt: 1 }), null);
});

test('only the deployment owner can manage a hosted artifact', () => {
  assert.equal(mayCall(owner, 'manageArtifact'), true);
  assert.equal(mayCall(mini, 'manageArtifact'), false);
});

test('keys are compared whole', () => {
  assert.equal(sameKey('abc', 'abc'), true);
  assert.equal(sameKey('abc', 'abd'), false);
  assert.equal(sameKey('abc', 'abcd'), false);
  assert.equal(sameKey('', 'a'), false);
});

test("Mac mini's key can't heartbeat, prune or read commands as the laptop, and can as itself", () => {
  assert.equal(actsAs(mini, LAPTOP), false);
  assert.equal(actsAs(mini, MINI), true);
  // heartbeat, pendingCommands, prune, setPresence, bye all go by actsAs.
  for (const fn of ['heartbeat', 'pendingCommands', 'prune', 'setPresence', 'bye', 'messageHeads', 'setThreadIndex']) assert.equal(mayCall(mini, fn), true, fn);
});

test("Mac mini's key can't write, take or move the laptop's threads, and can write its own", () => {
  // Rewriting an Laptop thread as it is (its secret card's key, say).
  assert.equal(mayWrite(mini, LAPTOP, LAPTOP), false);
  // Taking it by writing it under Mac mini's id.
  assert.equal(mayWrite(mini, MINI, LAPTOP), false);
  // Moving one of its own to the laptop, or making a new one there.
  assert.equal(mayWrite(mini, LAPTOP, MINI), false);
  assert.equal(mayWrite(mini, LAPTOP, undefined), false);
  // Its own, new or already there.
  assert.equal(mayWrite(mini, MINI, undefined), true);
  assert.equal(mayWrite(mini, MINI, MINI), true);
  // Messages, pictures and removal go by the row's runner.
  assert.equal(mayTouch(mini, LAPTOP), false);
  assert.equal(mayTouch(mini, MINI), true);
  // No row: nothing a runner key may add to or take from.
  assert.equal(mayTouch(mini, undefined), false);
  assert.equal(mayTouch(owner, undefined), true);
});

test("Mac mini's key claims only ids that have had nothing but Mac mini", () => {
  assert.equal(mayClaim(mini, { claimedBy: [], leftovers: false }), true);
  assert.equal(mayClaim(mini, { claimedBy: [MINI], leftovers: false }), true);
  assert.equal(mayClaim(mini, { claimedBy: [LAPTOP], leftovers: false }), false);
  assert.equal(mayClaim(mini, { claimedBy: [MINI, LAPTOP], leftovers: false }), false);
  assert.equal(mayClaim(mini, { claimedBy: [], leftovers: true }), false);
  assert.equal(mayClaim(owner, { claimedBy: [LAPTOP, MINI], leftovers: true }), true);
});

test("Mac mini's key uses only files its runner uploaded", () => {
  assert.equal(mayUseStorage(mini, MINI), true);
  assert.equal(mayUseStorage(mini, LAPTOP), false);
  // The owner's or the phone's: no record, and nobody's to take.
  assert.equal(mayUseStorage(mini, undefined), false);
  assert.equal(mayUseStorage(owner, undefined), true);
});

test("Mac mini's key can't put a schedule on the laptop", () => {
  // A schedule is that Mac running its text with its permissions.
  assert.equal(mayWrite(mini, LAPTOP, undefined), false);
  assert.equal(mayWrite(mini, MINI, LAPTOP), false);
  assert.equal(mayTouch(mini, LAPTOP), false); // delete, release, ran, requestRun
});

test("Mac mini's key takes only its own commands: never the laptop's or \"any\"", () => {
  assert.equal(mayTake(mini, { runnerId: LAPTOP }), false);
  assert.equal(mayTake(mini, { runnerId: MINI }), true);
  assert.equal(mayTake(mini, { runnerId: 'any' }), false);
  assert.equal(mayTake(owner, { runnerId: 'any' }), true);
  assert.equal(mayFinish(mini, { runnerId: LAPTOP }), false);
  assert.equal(mayFinish(mini, { runnerId: MINI }), true);
  assert.equal(mayFinish(mini, { runnerId: 'any' }), false);
});

test("Mac mini's key can't pair a phone, manage keys or read the other runners' threads", () => {
  for (const fn of ['issueToken', 'listTokens', 'revokeToken', 'addRunnerKey', 'listRunnerKeys', 'revokeRunnerKey', 'otherRunnersList', 'threadIndexSince', 'otherRunnersThreads']) {
    assert.equal(mayCall(mini, fn), false, fn);
    assert.equal(mayCall(owner, fn), true, fn);
  }
  // A function nobody sorted is owner-only.
  assert.equal(mayCall(mini, 'somethingNew'), false);
});

test('pocket cards: a runner key has only the ones its runner filed', () => {
  assert.equal(ownsCard(mini, { runnerId: MINI }), true);
  assert.equal(ownsCard(mini, { runnerId: LAPTOP }), false);
  assert.equal(ownsCard(mini, {}), false);
  assert.equal(ownsCard(owner, {}), true);
});

test('the owner key can do everything', () => {
  for (const fn of Object.keys(ACCESS)) assert.equal(mayCall(owner, fn), true, fn);
  assert.equal(actsAs(owner, LAPTOP), true);
  assert.equal(actsAs(owner, MINI), true);
  assert.equal(mayWrite(owner, MINI, LAPTOP), true);
  assert.equal(mayTouch(owner, LAPTOP), true);
  assert.equal(mayTake(owner, { runnerId: LAPTOP }), true);
  assert.equal(mayFinish(owner, { runnerId: 'any' }), true);
});

// boxes:exchange is a box's first call: it has a boot token, not a key.
const KEYLESS = ['exchange'];

test('every function in convex/sync.ts, relay.ts, moves.ts, boxes.ts and boxService.ts is sorted, and asks the gate under its own name', () => {
  const src = ['sync.ts', 'relay.ts', 'moves.ts', 'boxes.ts', 'boxService.ts'].map((f) => fs.readFileSync(path.join(import.meta.dirname, '../../../convex', f), 'utf8')).join('\n');
  const exported = [...src.matchAll(/^export const (\w+) = (?:mutation|query|action)\(/gm)].map((m) => m[1]!);
  assert.ok(exported.length > 40, 'found the functions');
  assert.deepEqual([...exported].sort(), [...Object.keys(ACCESS), ...KEYLESS].sort());
  // Each function's body, up to the next export.
  const parts = src.split(/^(?=export )/m);
  for (const name of exported) {
    if (KEYLESS.includes(name)) continue;
    const body = parts.find((p) => p.startsWith(`export const ${name} =`))!;
    // An action has no database, so it asks the gate through a query (boxes.ts actionAuth).
    // An options argument may follow (a box's housekeeping, lib.ts runnerAuth).
    assert.match(body, new RegExp(`(runnerAuth|actionAuth)\\(ctx, key, '${name}'(, \\{[^}]*\\})?\\)`), `${name} asks runnerAuth as '${name}'`);
    assert.doesNotMatch(body, /checkRunnerKey/, `${name} doesn't use the old check`);
  }
});

// A box call that can write can make work (lib.ts keyUsed): BOX_READS is exactly its queries.
test("BOX_READS is exactly the box calls that are queries", () => {
  const src = ['sync.ts', 'relay.ts', 'moves.ts', 'boxes.ts'].map((f) => fs.readFileSync(path.join(import.meta.dirname, '../../../convex', f), 'utf8')).join('\n');
  const queries = new Set([...src.matchAll(/^export const (\w+) = query\(/gm)].map((m) => m[1]!));
  assert.deepEqual([...BOX_CALLS].filter((f) => queries.has(f)).sort(), [...BOX_READS].sort());
});

// The protocol, whole: docs/protocol.md and, once it's split, docs/protocol/.
function protocolDoc(): string {
  const docs = path.join(import.meta.dirname, '../../../docs');
  const dir = path.join(docs, 'protocol');
  const parts = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort().map((n) => path.join(dir, n)) : [];
  return [path.join(docs, 'protocol.md'), ...parts].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

test("the protocol's table lists every function as ACCESS sorts it", () => {
  const doc = protocolDoc();
  const label = { owner: 'owner only', own: 'its own', shared: 'any runner' } as const;
  for (const [fn, access] of Object.entries(ACCESS)) {
    assert.ok(new RegExp(`\\| \`${fn}\` \\| ${label[access]} \\|`).test(doc), `${fn} in the table as ${label[access]}`);
  }
});

test("the runner tells a runner key's refusal from other errors, over HTTP and from a subscription", async () => {
  const message = "This runner's key can't call issueToken: only the main Mac's key (the deployment's RUNNER_KEY) can.";
  const fetchFn = (async () =>
    new Response(JSON.stringify({ status: 'error', errorMessage: 'Uncaught ConvexError: ...', errorData: { kind: 'forbidden', message } }), { status: 400 })) as unknown as typeof fetch;
  const err = await convexPoster('https://x.convex.cloud', fetchFn)('mutation', 'sync:issueToken', {}).catch((e: unknown) => e);
  assert.equal(forbiddenText(err), message);
  // A subscription error that only has the data as JSON in its text.
  assert.equal(forbiddenText(new Error(`[Request ID: 1] Server Error Uncaught ConvexError: {"kind":"forbidden","message":"no"}`)), 'no');
  assert.equal(forbiddenText(new Error('bad runner key')), undefined);
  assert.equal(forbiddenText(Object.assign(new Error('x'), { data: { kind: 'auth', message: 'bad runner key' } })), undefined);
});

// Daybreak, 7 Nov 2026: another runner's heartbeat startedAt of
// "2026-11-05T01:00:00+////" and its stats' cores of 1e20 each stopped the
// Mac app. The backend keeps them out (sync:heartbeat, sync:setRunnerStats).
test("a runner key's startedAt has to be a time, and its figures in range", () => {
  for (const ok of ['2026-11-05T01:00:00.000Z', '2026-11-05T01:00:00Z', '2026-11-05T01:00:00+01:30', '2026-11-05T01:00:00-0130', '2026-11-05T01:00:00.123456789Z', '2026-11-05T01:00:00']) {
    assert.ok(isIsoTime(ok), ok);
  }
  for (const bad of ['2026-11-05T01:00:00+////', '2026-11-05T01:00:00+0a:00', '2026-11-05T01:00:00+24:00', '2026-13-05T01:00:00Z', 'yesterday', '', '2026-11-05T01:00:00Z ', '2026-11-05T01:00:00Z\n', `2026-11-05T01:00:00.${'1'.repeat(80)}Z`, 42]) {
    assert.ok(!isIsoTime(bad), String(bad));
  }
  assert.ok(wholeIn(3, 10) && wholeIn(0, 10) && !wholeIn(-1, 10) && !wholeIn(1.5, 10) && !wholeIn(11, 10) && !wholeIn(Infinity, 10) && !wholeIn('3', 10));
  const stats = { cpuPercent: 12, cores: 8, memUsed: 1e9, memTotal: 2e9, diskFree: 1e10, diskTotal: 2e10, load1: 1.5, uptimeSec: 3600 };
  assert.equal(badRunnerStats(stats), undefined);
  const { load1: _, ...noLoad } = stats;
  assert.equal(badRunnerStats(noLoad), undefined);
  for (const [field, value] of [['cores', 1e20], ['cores', 8.5], ['cores', -1], ['cpuPercent', 101], ['memUsed', 1e300], ['diskFree', -5], ['uptimeSec', Infinity], ['load1', NaN], ['memTotal', undefined]] as const) {
    assert.match(badRunnerStats({ ...stats, [field]: value }) ?? '', new RegExp(`stats\\.${field}`), `${field} ${value}`);
  }
});

// Box keys (docs/virtual-runners.md, decision 4): one box's, for one
// runnerId and one thread. convex/boxes.ts makes them; box-access.test.ts
// plays them against the backend.
const BOX_RUNNER = 'box0runner01';
const boxRow = { _id: 'boxes:1', runnerId: BOX_RUNNER, threadId: 'T1', boxKeyHash: 'h', boxState: { kind: 'awake' } };
const boxKey = 'tbb_' + 'a'.repeat(64);
const box = callerFrom(boxKey, OWNER_KEY, null, boxRow) as Caller;

test("a box key is its box's runner and thread, and only while the box has that key", () => {
  assert.deepEqual(box, { owner: false, runnerId: BOX_RUNNER, box: { id: 'boxes:1', threadId: 'T1', keyHash: 'h' } });
  // Replaced or revoked (the machine clears the hash), or the box is past running.
  assert.equal(callerFrom(boxKey, OWNER_KEY, null, { ...boxRow, boxKeyHash: undefined }), null);
  for (const kind of ['destroying', 'gone', 'failed']) assert.equal(callerFrom(boxKey, OWNER_KEY, null, { ...boxRow, boxState: { kind } }), null, kind);
  // Only a key that looks like a box key is ever one.
  assert.equal(callerFrom('tbr_mac-mini', OWNER_KEY, null, boxRow), null);
});

test('a box key calls only what running its one thread needs', () => {
  for (const fn of BOX_CALLS) {
    assert.ok(ACCESS[fn] === 'own' || ACCESS[fn] === 'shared', `${fn} is a runner key's too`);
    assert.equal(mayCall(box, fn), true, fn);
  }
  for (const fn of Object.keys(ACCESS).filter((f) => !BOX_CALLS.has(f))) assert.equal(mayCall(box, fn), false, fn);
  for (const fn of ['saveSchedule', 'savePocketCard', 'setAccounts', 'sharedUsage', 'pools', 'memorySince', 'offerMemory', 'setPresence', 'prune', 'setProjects', 'issueToken', 'queueCommand', 'startMove', 'setCloudToken', 'mintBootToken']) assert.equal(mayCall(box, fn), false, fn);
  assert.equal(mayCall(box, 'somethingNew'), false);
});

test("a box key reaches its own thread's rows only", () => {
  assert.equal(mayWrite(box, BOX_RUNNER, undefined, 'T1'), true);
  assert.equal(mayWrite(box, BOX_RUNNER, BOX_RUNNER, 'T1'), true);
  // Another thread under its own runner id, new or there.
  assert.equal(mayWrite(box, BOX_RUNNER, undefined, 'T2'), false);
  assert.equal(mayWrite(box, BOX_RUNNER, BOX_RUNNER, 'T2'), false);
  // A check that doesn't say which thread is refused to a box (a schedule).
  assert.equal(mayWrite(box, BOX_RUNNER, undefined), false);
  assert.equal(mayWrite(box, MINI, undefined, 'T1'), false);
  assert.equal(mayTouch(box, BOX_RUNNER, 'T1'), true);
  assert.equal(mayTouch(box, BOX_RUNNER, 'T2'), false);
  assert.equal(mayTouch(box, BOX_RUNNER), false);
  assert.equal(mayTouch(box, MINI, 'T1'), false);
  assert.equal(mayClaim(box, { claimedBy: [], leftovers: false, threadId: 'T1' }), true);
  assert.equal(mayClaim(box, { claimedBy: [], leftovers: false, threadId: 'T2' }), false);
  assert.equal(mayClaim(box, { claimedBy: [], leftovers: false }), false);
  // A runner key's rules don't change: no thread named is fine for it.
  assert.equal(mayWrite(mini, MINI, undefined), true);
  assert.equal(mayTouch(mini, MINI), true);
  assert.equal(mayClaim(mini, { claimedBy: [], leftovers: false }), true);
});

test("a box key takes its own thread's commands and its runner's, never another thread's", () => {
  assert.equal(mayTake(box, { runnerId: BOX_RUNNER, threadId: 'T1' }), true);
  assert.equal(mayTake(box, { runnerId: BOX_RUNNER }), true);
  assert.equal(mayTake(box, { runnerId: BOX_RUNNER, threadId: 'T2' }), false);
  assert.equal(mayTake(box, { runnerId: MINI, threadId: 'T1' }), false);
  assert.equal(mayTake(box, { runnerId: 'any' }), false);
  assert.equal(mayFinish(box, { runnerId: BOX_RUNNER, threadId: 'T2' }), false);
  assert.equal(actsAs(box, BOX_RUNNER), true);
  assert.equal(actsAs(box, MINI), false);
  // Its own uploads only; no Pocket cards at all.
  assert.equal(mayUseStorage(box, BOX_RUNNER), true);
  assert.equal(mayUseStorage(box, MINI), false);
  assert.equal(ownsCard(box, { runnerId: BOX_RUNNER }), false);
});

test("the protocol lists what a box key may call", () => {
  const doc = protocolDoc().replace(/\r\n/g, '\n');
  const listed = /<!-- box-calls -->\n([\s\S]*?)\n<!-- \/box-calls -->/.exec(doc)?.[1];
  assert.ok(listed, 'the protocol has the box-calls list');
  assert.deepEqual([...listed.matchAll(/`(\w+)`/g)].map((m) => m[1]).sort(), [...BOX_CALLS].sort());
});

test("a thread row keeps an ask's web, thread and review links, and nothing else", () => {
  const row = webLinksOnly({
    links: [{ title: 'Doc', url: 'https://example.com' }, { title: 'Review', url: 'review:abc' }],
    asks: [{ action: 'Pick one', links: [{ title: 'Open the mocks', url: 'review:0a7d18e2-5c14' }, { title: 'Its thread', url: 'thread:a1b2c3d4' }, { title: 'Page', url: 'https://example.com/p' }, { title: 'File', url: '/Users/x/a.png' }, { title: 'Odd', url: 'review:a/b' }] }],
  });
  // The row's own links (patch buttons) stay web pages only.
  assert.deepEqual(row.links, [{ title: 'Doc', url: 'https://example.com' }]);
  assert.deepEqual(row.asks[0].links.map((l: { url: string }) => l.url), ['review:0a7d18e2-5c14', 'thread:a1b2c3d4', 'https://example.com/p']);
});
