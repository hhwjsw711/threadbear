// When Threadbear tells Mike a login has a usage reset worth using
// (docs/protocol/settings.md, Pools, "Telling Mike about resets"). On 26 Nov
// 2026 his gmail Codex login sat at 0% on every machine for days with 2
// resets unused, as only a stopped thread's limit box offered one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Account, AccountUsage, UsageWindow } from '../../src/protocol.ts';
import { RESET_EXPIRING_MS, resetHint, resetHintWords } from '../../src/reset-hint.ts';
import { UsageStore } from '../../src/usage.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { tmpDir } from '../helpers/fakes.ts';

const T0 = Date.parse('2026-11-26T05:00:00.000Z');
const DAY = 86_400_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();
const weekly = (left: number, resetsIn = 4 * DAY): UsageWindow => ({ kind: 'weekly', title: 'Weekly', remainingPercent: left, resetsAt: at(resetsIn) });
const fiveHour = (left: number): UsageWindow => ({ kind: 'five_hour', title: '5-hour', remainingPercent: left, resetsAt: at(3 * 3600_000) });
const usage = (windows: UsageWindow[], extra: Partial<AccountUsage> = {}): AccountUsage => ({ windows, readAt: at(0), source: 'live', ...extra });
const codex = (u: AccountUsage | undefined, extra: Partial<Account> = {}): Account => ({ id: 'codex-1', provider: 'codex', title: 'Codex · alex@example.net', configDir: '/tmp/codex-1', ...(u ? { usage: u } : {}), ...extra });
const two = (expiresIn = 20 * DAY) => ({ available: 2, nextExpiresAt: at(expiresIn) });

test('a login out of room with resets left gets an out hint, with the count and the soonest expiry', () => {
  assert.deepEqual(resetHint(codex(usage([weekly(0)], { blocked: true, resets: two() })), T0), { why: 'out', available: 2, nextExpiresAt: at(20 * DAY) });
  // Under 1% in a window counts though the runner hasn't flagged it blocked.
  assert.equal(resetHint(codex(usage([weekly(0.4)], { resets: two() })), T0)?.why, 'out');
  assert.equal(resetHint(codex(usage([fiveHour(0), weekly(80)], { resets: two() })), T0)?.why, 'out', 'the 5-hour window too');
  // Blocked with nothing known about its windows.
  assert.equal(resetHint(codex(usage([], { blocked: true, resets: { available: 1 } })), T0)?.why, 'out');
  assert.equal(resetHint(codex(usage([], { blocked: true, resets: { available: 1 } })), T0)?.nextExpiresAt, undefined);
});

test('a reset about to expire is worth a nudge only once the week is used enough to gain from it', () => {
  const soon = two(2 * DAY);
  assert.deepEqual(resetHint(codex(usage([weekly(55)], { resets: soon })), T0), { why: 'expiring', available: 2, nextExpiresAt: at(2 * DAY) });
  assert.equal(resetHint(codex(usage([weekly(69.9)], { resets: two(RESET_EXPIRING_MS) })), T0)?.why, 'expiring', 'exactly 3 days counts');
  assert.equal(resetHint(codex(usage([weekly(70)], { resets: soon })), T0), undefined, '70% left gains too little');
  assert.equal(resetHint(codex(usage([weekly(95)], { resets: soon })), T0), undefined);
  assert.equal(resetHint(codex(usage([weekly(40)], { resets: two(RESET_EXPIRING_MS + 60_000) })), T0), undefined, 'more than 3 days off');
  assert.equal(resetHint(codex(usage([weekly(40)], { resets: { available: 2 } })), T0), undefined, 'no expiry known');
  // A week whose reset has passed is full again.
  assert.equal(resetHint(codex(usage([weekly(10, -60_000)], { resets: soon })), T0), undefined);
});

test('no hint with no resets, an expired one, room unknown, or a login nothing can run on', () => {
  assert.equal(resetHint(codex(usage([weekly(0)], { blocked: true })), T0), undefined, 'no resets');
  assert.equal(resetHint(codex(usage([weekly(0)], { blocked: true, resets: { available: 0, nextExpiresAt: at(DAY) } })), T0), undefined, 'none left');
  assert.equal(resetHint(codex(usage([weekly(0)], { blocked: true, resets: two(-1) })), T0), undefined, 'the soonest expired since the read');
  assert.equal(resetHint(codex(usage([weekly(0)], { blocked: true, resets: two(0) })), T0), undefined, 'expiring this very moment');
  assert.equal(resetHint(codex(usage([], { resets: two(DAY) })), T0), undefined, 'room unknown');
  assert.equal(resetHint(codex(undefined), T0), undefined, 'no usage at all');
  assert.equal(resetHint(codex(usage([weekly(0)], { blocked: true, resets: two() }), { signedOut: true }), T0), undefined, 'signed out');
  assert.equal(resetHint(codex(usage([weekly(0)], { blocked: true, resets: two() }), { planEnded: true }), T0), undefined, 'plan ended');
});

test('a Claude login gets a hint when a reading includes a reset count', () => {
  const claude: Account = { id: 'claude-main', provider: 'claude', title: 'alex@example.net', configDir: '/tmp/claude', usage: usage([weekly(0)], { blocked: true }) };
  assert.equal(resetHint(claude, T0), undefined);
  claude.usage = usage([weekly(0)], { blocked: true, resets: two() });
  assert.deepEqual(resetHint(claude, T0), { why: 'out', available: 2, nextExpiresAt: at(20 * DAY) });
});

test('the hint in words, for tb and list_accounts', () => {
  const when = (iso: string) => iso.slice(0, 10);
  assert.equal(resetHintWords({ why: 'out', available: 2, nextExpiresAt: at(DAY) }, when), '2 resets left, the next expires 2026-11-27: use one to carry on now');
  assert.equal(resetHintWords({ why: 'expiring', available: 1, nextExpiresAt: at(DAY) }, when), "1 reset left, the next expires 2026-11-27: worth using one before it's lost");
  assert.equal(resetHintWords({ why: 'out', available: 1 }, when), '1 reset left: use one to carry on now');
});

// ---- the usage store: resets travel with the shared readings ----

function store() {
  const dir = tmpDir();
  const clock = new FakeClock(T0);
  const s = new UsageStore({ limitsFile: path.join(dir, 'none', 'limits.json'), dataDir: dir, clock, log: nullLogger });
  return { usage: s, clock };
}
const GMAIL = { id: 'codex-1', provider: 'codex' as const, configDir: '/tmp/codex-1', email: 'alex@example.net' };

test("another machine's read of the resets counts here, and the newest read wins", () => {
  const { usage: s, clock } = store();
  s.record('codex-1', { windows: [weekly(0)], blocked: true });
  assert.equal(s.usageFor(GMAIL)?.resets, undefined, 'this runner never read them');
  // Bruce read the login a minute ago: 2 left.
  clock.advance(5 * 60_000);
  s.setShared([{ runnerId: 'bruce', provider: 'codex', email: 'Alex@Example.net', byOwnerKey: true, usage: usage([weekly(0)], { blocked: true, readAt: at(4 * 60_000), resets: { ...two(), readAt: at(4 * 60_000) } }) }]);
  assert.equal(s.usageFor(GMAIL)?.resets?.available, 2);
  // Mike uses one here: this runner's read is newer, so 1.
  clock.advance(60_000);
  s.record('codex-1', { windows: [weekly(100)], blocked: false, resets: { available: 1, nextExpiresAt: at(20 * DAY) } });
  assert.equal(s.usageFor(GMAIL)?.resets?.available, 1);
  assert.equal(s.usageFor(GMAIL)?.resets?.readAt, at(6 * 60_000), 'stamped with when it was read');
  // Bruce's copy of an older read doesn't win back, though its row is newer.
  clock.advance(60_000);
  s.setShared([{ runnerId: 'bruce', provider: 'codex', email: 'alex@example.net', byOwnerKey: true, usage: usage([weekly(0)], { readAt: at(7 * 60_000), resets: { ...two(), readAt: at(4 * 60_000) } }) }]);
  assert.equal(s.usageFor(GMAIL)?.resets?.available, 1);
  // A reading from another machine with no resets read leaves this one's.
  s.setShared([{ runnerId: 'bruce', provider: 'codex', email: 'alex@example.net', byOwnerKey: true, usage: usage([weekly(90)], { readAt: at(7 * 60_000) }) }]);
  assert.equal(s.usageFor(GMAIL)?.resets?.available, 1);
});

test('clients hear when a reset comes within 3 days of expiring, and when it expires, with no new reading', () => {
  const { usage: s, clock } = store();
  s.start();
  try {
    s.usageFor(GMAIL);
    s.record('codex-1', { windows: [weekly(40, 10 * DAY)], resets: two(5 * DAY) });
    const heard: string[][] = [];
    s.onChange((ids) => heard.push(ids));
    assert.equal(resetHint({ usage: s.usageFor(GMAIL) }, s.now()), undefined, 'five days off');
    clock.advance(2 * DAY + 60_000);
    assert.ok(heard.some((ids) => ids.includes('codex-1')), 'told as it came within 3 days');
    assert.equal(resetHint({ usage: s.usageFor(GMAIL) }, s.now())?.why, 'expiring');
    heard.length = 0;
    clock.advance(3 * DAY);
    assert.ok(heard.some((ids) => ids.includes('codex-1')), 'told as it expired');
    assert.equal(s.usageFor(GMAIL)?.resets, undefined);
  } finally {
    s.stop();
  }
});
