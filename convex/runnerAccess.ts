// Who a runner key is, and what it may do (docs/protocol/keys.md, "Runner keys").
// Plain TypeScript with no Convex imports, so the runner's unit tests can
// check every rule without a deployment; lib.ts runnerAuth looks the key up
// and the functions in sync.ts ask these.
//
// Two kinds of key. The owner key is the deployment's RUNNER_KEY, held by
// the main runner only, and may do everything, as every key could before
// 5 Nov 2026. A runner key (the runnerKeys table, made by the owner with
// `tb runner add`) is one runner's, and acts as that runnerId alone: a
// second Mac's key can't write the main Mac's threads, read its commands,
// queue work for it or pair a phone. A deployment with one runner has only
// the owner key, and nothing changes for it.

// keyId: the runnerKeys row, so what a key starts (an upload URL) dies with it.
// A box key (docs/virtual-runners.md, decision 4) is a third kind: one box's
// on a virtual runner, for one runnerId *and* one thread. It isn't a
// runnerKeys row and doesn't count toward MAX_RUNNER_KEYS; the boxes row
// keeps its hash, and a new box for the thread replaces it (boxes.ts
// exchange), so the last box's key is refused from that moment.
export type BoxScope = { id: string; threadId: string; keyHash: string };
export type Caller = { owner: true; box?: undefined } | { owner: false; runnerId: string; keyId?: string; box?: undefined } | { owner: false; runnerId: string; box: BoxScope; keyId?: undefined };
export type RunnerKeyRow = { _id?: string; runnerId: string; revokedAt?: number };
// The boxes row whose boxKeyHash matched. Its state says whether the key is
// still good: a box being destroyed, gone or failed has none (the machine
// clears the hash too, boxMachine.ts).
export type BoxKeyRow = { _id: string; runnerId: string; threadId: string; boxKeyHash?: string; boxState: { kind: string } };
export const BOX_KEY_DEAD: readonly string[] = ['destroying', 'gone', 'expired', 'failed'];
// What a box key looks like (boxes.ts newBoxKey): only keys with this start
// are looked up among boxes, so a runner key never is.
export const BOX_KEY_PREFIX = 'tbb_';

// Compared without stopping at the first difference, so the time a wrong
// key takes says nothing about how much of it was right.
export function sameKey(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// The owner keys: RUNNER_KEY, and while it's being rotated RUNNER_KEY_NEXT
// too, so the main Mac can move to the new one with no gap (set NEXT, give
// the main runner the new key and restart it, then make it RUNNER_KEY).
export function isOwnerKey(key: string, ownerKeys: (string | undefined)[]): boolean {
  return Boolean(key) && ownerKeys.some((k) => Boolean(k) && sameKey(key, k!));
}

// `row` is the runnerKeys row whose hash matches the key, if any. Null: not
// a key this deployment knows (or a revoked one).
// `box` is the boxes row whose boxKeyHash matches the key, if any.
export function callerFrom(key: string, ownerKeys: string | undefined | (string | undefined)[], row: RunnerKeyRow | null | undefined, box?: BoxKeyRow | null): Caller | null {
  if (!key) return null;
  if (isOwnerKey(key, Array.isArray(ownerKeys) ? ownerKeys : [ownerKeys])) return { owner: true };
  if (row && !row.revokedAt) return { owner: false, runnerId: row.runnerId, ...(row._id ? { keyId: row._id } : {}) };
  if (box && box.boxKeyHash && key.startsWith(BOX_KEY_PREFIX) && !BOX_KEY_DEAD.includes(box.boxState.kind)) {
    return { owner: false, runnerId: box.runnerId, box: { id: box._id, threadId: box.threadId, keyHash: box.boxKeyHash } };
  }
  return null;
}

/**
 * A box key reaches its one thread only. `threadId` is the thread the row
 * belongs to; a check that doesn't say (a schedule, a Pocket card) is
 * refused to a box. Any other caller passes.
 */
export function ownThreadOnly(c: Caller, threadId: string | undefined): boolean {
  return c.owner || !c.box || (threadId !== undefined && threadId === c.box.threadId);
}

// A runner id as runner.json's sync.runnerId has it (ensureRunnerId makes 12
// hex characters). Checked as it arrives, never trimmed or folded: " m5 "
// must not turn into "m5" after something compared it as different.
// "any" is the phone's "whichever runner" (phone.ts mainRunner), nobody's id.
export const RUNNER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function validRunnerId(id: string): boolean {
  return RUNNER_ID.test(id) && id !== 'any';
}

/** Acting as `runnerId`: its heartbeat, its lists, its pending commands. */
export function actsAs(c: Caller, runnerId: string): boolean {
  return c.owner || c.runnerId === runnerId;
}

/**
 * Writing a row that names a runner (a thread, a schedule): it must be the
 * caller's, and so must the row it replaces. So a runner key can't take
 * another runner's thread or schedule by writing it under its own id, nor
 * put one on another runner (a schedule there is that Mac running what it
 * says, with the permissions it says).
 */
export function mayWrite(c: Caller, incomingRunnerId: string, existingRunnerId: string | undefined, threadId?: string): boolean {
  if (c.owner) return true;
  return incomingRunnerId === c.runnerId && (existingRunnerId === undefined || existingRunnerId === c.runnerId) && ownThreadOnly(c, threadId);
}

/**
 * Something keyed by a thread or schedule id (its messages, pictures,
 * claims): the row must be there and be the caller's. With no row there's
 * nothing a runner key may add to or take from: what it wrote under an id
 * nobody has yet would show once the owner made that thread, and what's
 * left under a gone one may be anyone's.
 */
export function mayTouch(c: Caller, existingRunnerId: string | undefined, threadId?: string): boolean {
  return c.owner || (existingRunnerId !== undefined && existingRunnerId === c.runnerId && ownThreadOnly(c, threadId));
}

/**
 * A thread id's shape: 1 to 64 letters, digits, `-` and `_` (a runner's are
 * UUIDs). The apps put an id into a shell line (Copy debug info) and a
 * chip's link, and the main Mac's runner into paths, so a runner key may
 * only make rows under ids of this shape (sync.ts claimable; Daybreak 87
 * and 102, 11 Nov 2026). The Mac, GPUI and runner sides check the same
 * (ThreadIds.isValid, thread_link::is_thread_id, runner/src/thread-id.ts),
 * as rows made before this are still there.
 */
export const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function isThreadId(id: unknown): id is string {
  return typeof id === 'string' && THREAD_ID.test(id);
}

/**
 * Making a row under a thread id nobody has a row for. `claimedBy` is every
 * runner that has had the id (a deleted thread's tombstone, a sidebar row);
 * `leftovers` whether anything is still stored under it (messages,
 * pictures). A runner key may only take an id that's had nothing but its
 * own runner, so it can't pick up a pruned thread's messages or put rows
 * where another runner's thread is listed.
 */
export function mayClaim(c: Caller, id: { claimedBy: string[]; leftovers: boolean; threadId?: string }): boolean {
  if (c.owner) return true;
  return !id.leftovers && id.claimedBy.every((r) => r === c.runnerId) && ownThreadOnly(c, id.threadId);
}

/**
 * Attaching a stored file to a row, or deleting one. `uploader` is the
 * runner whose runner key uploaded it (storageOwners), undefined for the
 * owner's or the phone's uploads. A runner key may only use its own, so it
 * can't attach the owner's picture or a phone's photo to a thread of its
 * own, or delete one: a file no row names yet is still nobody's to take.
 */
export function mayUseStorage(c: Caller, uploader: string | undefined): boolean {
  return c.owner || (uploader !== undefined && uploader === c.runnerId);
}

/**
 * A phone's command. A runner key takes only those for its own runner:
 * "any" (a new thread from the phone with no runner online that the
 * owner's Mac would take, phone.ts mainRunner) waits for the owner key, as
 * its text is whatever Mike said.
 */
export function mayTake(c: Caller, cmd: { runnerId: string; threadId?: string }): boolean {
  if (c.owner) return true;
  // Said outright, not left to "no key is for any" (one made before that check would be).
  if (cmd.runnerId === 'any' || cmd.runnerId !== c.runnerId) return false;
  // A box: its own thread's commands, or its runner's own (only the owner
  // and the phone queue those), never one naming another thread.
  return !c.box || cmd.threadId === undefined || cmd.threadId === c.box.threadId;
}

export function mayFinish(c: Caller, cmd: { runnerId: string; threadId?: string }): boolean {
  return mayTake(c, cmd);
}

/**
 * Pocket cards are one deck for the phone, but a runner key sees and
 * changes only the cards its own runner filed: the deck holds what Mike
 * takes out with him (addresses, booking codes). A card with no runnerId
 * was filed with the owner key, or before runner keys.
 */
export function ownsCard(c: Caller, card: { runnerId?: string }): boolean {
  // A box files no cards (BOX_CALLS), so it owns none.
  return c.owner || (!c.box && card.runnerId === c.runnerId);
}

// Every runner-facing function (sync.ts and relay.ts) and who may call it. A unit test
// checks this names exactly the functions sync.ts exports, so a new one
// can't go in without being sorted, and docs/protocol.md's table follows it.
//   owner:  the owner key only.
//   own:    any key, for its own runnerId and its own threads, schedules,
//           commands and cards (the owner for anyone's).
//   shared: any key; nothing in it is another runner's to protect.
export type Access = 'owner' | 'own' | 'shared';
export const ACCESS: Record<string, Access> = {
  manageArtifact: 'owner',
  upsertThreads: 'own',
  setPresence: 'own',
  removeThreads: 'own',
  replyImages: 'own',
  addReplyImage: 'own',
  shareImages: 'own',
  addShareImage: 'own',
  dropShareImages: 'own',
  prune: 'own',
  sharedThreads: 'own',
  heartbeat: 'own',
  bye: 'own',
  threadsOf: 'own',
  // Every runner's id and name: what a tampered Mac would need to pose as
  // another. A runner key's scheduler lists only its own runner.
  runnersList: 'owner',
  issueToken: 'owner',
  issuePairingCode: 'owner',
  listTokens: 'owner',
  revokeToken: 'owner',
  appendMessages: 'own',
  messageHeads: 'own',
  setProjects: 'own',
  upsertProjects: 'own',
  projectIcons: 'own',
  iconUploadUrl: 'shared',
  setProjectIcon: 'own',
  // Pre-API 9 compatibility, for a runner still on its own schedules.json:
  // no runner on a runner key needs it, and it can shadow other ids.
  setSchedules: 'owner',
  schedules: 'own',
  schedulesSince: 'own',
  saveSchedule: 'own',
  deleteSchedule: 'own',
  adoptSchedules: 'own',
  claimSchedule: 'own',
  releaseSchedule: 'own',
  scheduleRan: 'own',
  requestScheduleRun: 'own',
  // Someone has the website's Runners view open, which says nothing about any
  // runner; the figures are only ever its own (API 45).
  runnerWatch: 'shared',
  setRunnerStats: 'own',
  // Every runner's figures, and waking them all to report: the main Mac's.
  watchRunnersFromMac: 'owner',
  runnerStatsList: 'owner',
  setAccounts: 'own',
  upsertAccounts: 'own',
  // The main Mac's key's usage readings of the logins the owner has said
  // this runner shares (runnerLogins). Nobody gets a runner key's.
  sharedUsage: 'own',
  // Which logins each runner key's runner shares with the main Mac: the
  // owner's word, as a runner key's own accounts rows say whatever it likes.
  setRunnerLogins: 'owner',
  runnerLogins: 'owner',
  // Pools are every runner's (which logins and folders each pool has, the
  // main Mac's included): a runner key reads them to follow them, but
  // changing them is the main key's.
  pools: 'shared',
  savePools: 'owner',
  adoptPools: 'owner',
  // Shared memory (API 84, memorySync.ts): every runner reads the main
  // Mac's files, but only the main key writes them, as they brief every
  // agent everywhere. A runner key's own saves are offers, read by the
  // main key alone.
  putMemory: 'owner',
  memorySince: 'shared',
  offerMemory: 'own',
  memoryOffers: 'owner',
  takeMemoryOffers: 'owner',
  savePocketCard: 'own',
  removePocketCard: 'own',
  pocketCards: 'own',
  pendingCommands: 'own',
  takeCommand: 'own',
  finishCommand: 'own',
  setThreadIndex: 'own',
  otherRunnersList: 'owner',
  // Mike's runner order (API 58): a runner key that could move it could put
  // itself first for his new threads from the phone.
  runnerOrder: 'owner',
  setRunnerOrder: 'owner',
  threadIndexSince: 'owner',
  otherRunnersThreads: 'owner',
  addRunnerKey: 'owner',
  listRunnerKeys: 'owner',
  revokeRunnerKey: 'owner',
  audit: 'owner',
  scrubStoredBatch: 'owner',
  auditRemove: 'owner',
  purgeRunner: 'owner',
  // relay.ts (API 44): other runners' threads read and steered from the main
  // Mac. Reading another runner's messages and queueing work for it is the
  // owner's alone.
  remoteTail: 'owner',
  remoteMessages: 'owner',
  remoteThread: 'owner',
  queueCommand: 'owner',
  commandState: 'owner',
  // Pictures for another runner's thread (API 63): an upload URL, and
  // deleting ones uploaded for a command that wasn't queued.
  pictureUploadUrl: 'owner',
  discardPictures: 'owner',
  remoteAccounts: 'owner',
  remotePools: 'owner',
  // Full sync (API 52): a runner writes its own threads' tool output, and only
  // the main Mac's runner reads another runner's.
  remoteBody: 'owner',
  // The pictures pasted into another runner's messages, with their URLs (API 87).
  picturesAtSeqs: 'owner',
  // Asking another runner (relay.ts): a runner key files and reads back its
  // own requests; only the main Mac's runner reads any and answers them.
  fileRequest: 'own',
  runnerRequest: 'own',
  decideRequest: 'owner',
  closeRequest: 'own',
  appendBodies: 'own',
  addHeldPicture: 'own',
  // moves.ts (API 64): only the main Mac starts or cancels a move; each
  // step is the move's own runner on that side, which the function checks.
  startMove: 'owner',
  cancelMove: 'owner',
  moves: 'own',
  moveInfo: 'own',
  moveReady: 'own',
  moveFrozen: 'own',
  moveChunkUrl: 'own',
  movePacked: 'own',
  moveChunks: 'own',
  moveClaim: 'own',
  moveDone: 'own',
  moveFailed: 'own',
  // The main Mac's own uploads for a move that ended first (moves.ts).
  moveDropChunks: 'owner',
  // boxes.ts (docs/virtual-runners.md): the main Mac makes and lists the
  // virtual runners, starts a thread on one, sets a login's cloud token,
  // mints a box's boot token and archives a box; a box says it has saved
  // its thread. boxes:exchange takes a boot token, not a key.
  runnerServices: 'owner',
  setRunnerService: 'owner',
  startThread: 'owner',
  wakePastHours: 'owner',
  setCloudToken: 'owner',
  cloudTokens: 'owner',
  // A box's own login's token (API 94): refused by a turn, and fetched again once set.
  tokenRefused: 'own',
  boxCloudToken: 'own',
  mintBootToken: 'owner',
  archiveBox: 'owner',
  boxSaved: 'own',
};

// A runner name as lists show it, for a runner key's heartbeat: folded to
// printable ASCII, not stripped (NFKD without marks, curly quotes and
// dashes to plain ones, so "Mike’s" is "Mike's" and "Ｍ5" is "M5"), with
// zero-width and control characters gone, spaces collapsed and at most
// NAME_CHARS. Empty: nothing usable (the runner then goes by its id).
export const NAME_CHARS = 40;
const PUNCT: [RegExp, string][] = [
  [/[\u2018\u2019\u201a\u201b\u2032\u02bc]/g, "'"],
  [/[\u201c\u201d\u201e\u201f\u2033]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, '-'],
  [/\u2026/g, '...'],
  [/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' '],
];
function fold(name: string): string {
  let s = name.normalize('NFKD').replace(/\p{M}/gu, '');
  for (const [re, to] of PUNCT) s = s.replace(re, to);
  return s.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
}
export function normalName(name: string): string {
  return fold(name).slice(0, NAME_CHARS).trim();
}
// What two names look like side by side in a list, for telling look-alikes
// apart: "rn5" and "m5", "B0b" and "Bob", "1" and "l" compare the same. Of
// the whole name, never cut, so a suffix that tells two apart counts.
export function nameSkeleton(name: string): string {
  return fold(name).toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/[1i|]/g, 'l').replace(/[^a-z0-9]/g, '');
}

// Sizes are UTF-8 bytes, as Convex counts them.
const encoder = new TextEncoder();
export function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}
export function docBytes(doc: unknown): number {
  return utf8Bytes(JSON.stringify(doc));
}
// A string cut to at most `max` UTF-8 bytes, never mid-character.
export function cutBytes(s: string, max: number): string {
  if (utf8Bytes(s) <= max) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}
// What another runner writes that the Mac and iPhone apps read as a time or
// a number has to be one: their Swift stops on a date offset of "+////"
// (a byte below "0" taken from 48) or Int(1e20), and nothing can catch
// that (Daybreak, 7 Nov 2026). The apps check too, for rows from before.

// An ISO time as toISOString writes it, or with an offset: what the Mac
// app's ISO8601.parse reads.
const ISO_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)?$/;
export function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && ISO_TIME.test(value);
}
// A thread row's times held to isIsoTime, in place: the ones it must have
// stand in from lastActivityMs, the rest go. Android's took
// "+999999999-12-31T23:59:59Z" and threw drawing the row (Daybreak, 11 Nov
// 2026). On what a runner key writes, and on what phones read, for rows
// stored before and for apps from before their own check.
// What a phone reads is held more loosely than what a runner key writes:
// any time inside JavaScript's own range, in toISOString's form, so the
// owner's runner's snooze past the year 9999 ("+010000-01-01T00:00:00.000Z",
// which it takes) still shows. Android before its own check only threw past
// about 292 million years.
const WIDE_ISO_TIME = /^[+-]\d{6}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{3})?Z$/;
export function isReadableTime(value: unknown): value is string {
  return isIsoTime(value) || (typeof value === 'string' && WIDE_ISO_TIME.test(value) && Number.isFinite(Date.parse(value)));
}
// A link a thread row carries (an ask's links, its patches' url actions) is
// a web page or nothing: http or https with a host, short enough to show
// whole. A runner sends only those (runner/src/sync.ts), so anything else
// came from a runner that isn't honest or isn't this release, and it's
// dropped here rather than handed to a phone or a browser to dispatch to
// another app (Daybreak finding 139, 16 Nov 2026). The website and phones
// check again as they draw it.
export const MAX_LINK_CHARS = 2048;
export function isWebLink(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > MAX_LINK_CHARS || !/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

export function isThreadLink(url: unknown): boolean {
  return typeof url === 'string' && /^thread:[\w-]{1,64}$/i.test(url);
}

// review:<id>, a show_options review in the ask's own thread, which the phone
// opens in its Reviews sheet (the designReviews command) and the website names
// as opening on the Mac. Dropping it left a pick with nothing to tap (21 Nov
// 2026: "Which way should a waiting thread show...?", its three mocks unreachable).
export function isReviewLink(url: unknown): boolean {
  return typeof url === 'string' && /^review:[a-zA-Z0-9-]{1,200}$/.test(url);
}

/** A thread row with every link that isn't a web page (or, on an ask, another thread or its review) taken out. */
export function webLinksOnly<T extends Record<string, any>>(t: T): T {
  const out: Record<string, any> = { ...t };
  if (Array.isArray(out.links)) {
    out.links = out.links.filter((l: any) => isWebLink(l?.url));
    if (!out.links.length) delete out.links;
  }
  if (Array.isArray(out.asks)) {
    out.asks = out.asks.map((a: any) => {
      if (!Array.isArray(a?.links)) return a;
      // An ask may also link another thread (thread:<id>) or one of its own
      // thread's reviews (review:<id>), which the phone and the web open in
      // place, not as an address.
      const links = a.links.filter((l: any) => isWebLink(l?.url) || isThreadLink(l?.url) || isReviewLink(l?.url));
      const { links: _links, ...rest } = a;
      return links.length ? { ...rest, links } : rest;
    });
  }
  return out as T;
}

export function holdThreadTimes(t: Record<string, any>, ok: (value: unknown) => boolean = isIsoTime): void {
  if (!ok(t.lastActivityAt)) {
    const ms = t.lastActivityMs;
    t.lastActivityAt = new Date(Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 ? ms : Date.now()).toISOString();
  }
  if (!ok(t.createdAt)) t.createdAt = t.lastActivityAt;
  for (const f of ['snoozedUntil', 'archivedAt', 'starredAt']) if (t[f] !== undefined && !ok(t[f])) delete t[f];
  if (t.woke && !ok(t.woke.at)) delete t.woke;
  else if (t.woke?.since !== undefined && !ok(t.woke.since)) t.woke = { at: t.woke.at };
}
// A lab review's counts (rounds, a finding's id and round) are numbers a
// client turns into an Int, and 1e20 there stopped the iPhone app on its
// thread list, past any `try?` (Daybreak 109, 12 Nov 2026). Held to small
// whole numbers on a runner key's write and again on every phone read, so a
// row stored before the write was checked never reaches a phone that
// converts unchecked: a bad count becomes 1, a finding with no real id goes.
export function holdReviewNumbers(t: Record<string, any>): void {
  const r = t.review;
  if (!r || typeof r !== 'object') return;
  const count = (n: unknown) => (wholeIn(n, 1_000_000) ? n : undefined);
  t.review = {
    ...r,
    rounds: count(r.rounds) ?? 1,
    findings: Array.isArray(r.findings) ? r.findings.filter((f: any) => count(f?.id) !== undefined).map((f: any) => ({ ...f, round: count(f.round) ?? 1 })) : [],
  };
}
// A whole number from 0 to `most`.
export function wholeIn(value: unknown, most: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= most;
}
// The most each machine figure can be (sync:setRunnerStats), as the Mac
// app's RunnerMachineStats.Limits has them.
export const STATS_MOST = { cpuPercent: 100, cores: 1_000_000, memUsed: 1e18, memTotal: 1e18, diskFree: 1e18, diskTotal: 1e18, load1: 1_000_000, uptimeSec: 3.2e10 } as const;
// What's wrong with a machine's figures, or undefined: sync:setRunnerStats
// refuses them from any key, as a real machine never reports one.
export function badRunnerStats(stats: Record<string, unknown>): string | undefined {
  for (const [field, most] of Object.entries(STATS_MOST)) {
    const value = stats[field];
    if (value === undefined && field === 'load1') continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > most || (field === 'cores' && !Number.isInteger(value))) {
      return `stats.${field} must be a ${field === 'cores' ? 'whole ' : ''}number from 0 to ${most}`;
    }
  }
  return undefined;
}

// A runner key's schedule ids are what the runner makes (crypto.randomUUID),
// so none can carry text a terminal would run when an audit lists it.
export const SCHEDULE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---- shared usage readings (sync:sharedUsage, docs/protocol/keys.md "Runner keys")

// A login as two runners compare it: the same subscription wherever it's
// signed in.
export function loginKey(provider: string, email: string): string {
  return `${provider}:${email.trim().toLowerCase()}`;
}
// What setRunnerLogins takes: a provider word and something that looks
// like an email, so a listing can print it as it is.
export const LOGIN_PROVIDER = /^[a-z][a-z0-9-]{0,19}$/;
export const LOGIN_EMAIL = /^[^\s@\u0000-\u001f\u007f]{1,100}@[^\s@\u0000-\u001f\u007f]{1,150}$/;

// How far ahead a window of each kind can reset from when it was read. A
// runner key's reading of its own logins can't say one is out until 2099:
// a reset later than this is brought back to it. Not to now, which would make every real
// window look reset already (a week's resets days ahead). An hour of slack
// for clocks that differ.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const WINDOW_HORIZON_MS: Record<string, number> = { five_hour: 5 * HOUR, daily: DAY, weekly: 7 * DAY, weekly_model: 7 * DAY, monthly: 31 * DAY };
const OTHER_HORIZON_MS = 31 * DAY;
const SKEW_MS = HOUR;

type UsageWindowDoc = { kind: string; title: string; remainingPercent: number; resetsAt?: string; detail?: string };
export type UsageDoc = { windows: UsageWindowDoc[]; readAt: string; source: string; stale?: boolean; blocked?: boolean; notice?: string };

/**
 * A runner key's usage reading as it may stand: read no later than now
 * (as fitThread does with lastActivityMs, since the newest reading wins
 * on every Mac), each window's reset no further off than its kind allows,
 * room 0 to 100. A reading with no time that parses says nothing and goes.
 * These rows are that runner's own, for the phone to show its logins:
 * sharedUsage gives them to nobody.
 */
export function fitUsage(u: UsageDoc, now: number): UsageDoc | undefined {
  const read = Date.parse(u.readAt);
  if (!Number.isFinite(read)) return undefined;
  const windows: UsageWindowDoc[] = [];
  for (const w of u.windows) {
    if (!Number.isFinite(w.remainingPercent)) continue;
    const out: UsageWindowDoc = { ...w, remainingPercent: Math.max(0, Math.min(100, w.remainingPercent)) };
    if (w.resetsAt !== undefined) {
      const at = Date.parse(w.resetsAt);
      // Own keys only: a kind of "constructor" mustn't read Object's.
      const latest = now + (Object.prototype.hasOwnProperty.call(WINDOW_HORIZON_MS, w.kind) ? WINDOW_HORIZON_MS[w.kind]! : OTHER_HORIZON_MS) + SKEW_MS;
      if (!Number.isFinite(at)) delete out.resetsAt;
      else if (at > latest) out.resetsAt = new Date(latest).toISOString();
    }
    windows.push(out);
  }
  return { ...u, windows, readAt: read > now ? new Date(now).toISOString() : u.readAt };
}

/**
 * A reading no honest runner writes: read after now, or a window resetting
 * further off than its kind allows (an hour's slack for clocks either way).
 * sharedUsage leaves out such a reading even from the owner key's rows: a
 * runner from before API 53 took a runner key's 2099 reading in as the
 * newest and wrote it into its own row, where it would otherwise stay the
 * newest for good (Codex's review of Gautam's F1 fix).
 */
export function impossibleUsage(u: UsageDoc, now: number): boolean {
  const read = Date.parse(u.readAt);
  if (!Number.isFinite(read) || read > now + SKEW_MS) return true;
  const fitted = fitUsage(u, now);
  return !fitted || fitted.windows.length !== u.windows.length || fitted.windows.some((w, i) => w.resetsAt !== u.windows[i]!.resetsAt);
}

/**
 * What a box key may call (docs/virtual-runners.md, decision 4): what its
 * runner needs to run its one thread, and nothing more. Each is also 'own'
 * or 'shared' in ACCESS, and each checks the thread as the function's own
 * rule says (ownThreadOnly). Not here, so refused: everything owner-only,
 * schedules, Pocket, projects, logins and their readings (the service sets
 * a box's login), pools, shared memory (Mike's own notes, and a box runs
 * code nobody has read), presence, prune and machine figures. A new thread
 * from a box goes through fileRequest, which asks Mike with a card.
 */
export const BOX_CALLS: ReadonlySet<string> = new Set([
  'heartbeat',
  'bye',
  'upsertThreads',
  'removeThreads',
  'threadsOf',
  'sharedThreads',
  'appendMessages',
  'messageHeads',
  'appendBodies',
  'replyImages',
  'addReplyImage',
  'shareImages',
  'addShareImage',
  'dropShareImages',
  'addHeldPicture',
  'iconUploadUrl',
  'setThreadIndex',
  'pendingCommands',
  'takeCommand',
  'finishCommand',
  'fileRequest',
  'runnerRequest',
  'closeRequest',
  'moves',
  'moveInfo',
  'moveReady',
  'moveFrozen',
  'moveChunkUrl',
  'movePacked',
  'moveChunks',
  'moveClaim',
  'moveDone',
  'moveFailed',
  'boxSaved',
  'tokenRefused',
  'boxCloudToken',
]);

/**
 * The box calls that only read (queries): every other box call can make
 * work, so the box's attempt joins those that may hold work newer than its
 * save (lib.ts keyUsed). runner-access.test.ts checks this against the
 * functions themselves.
 */
export const BOX_READS: ReadonlySet<string> = new Set(['threadsOf', 'sharedThreads', 'messageHeads', 'replyImages', 'shareImages', 'pendingCommands', 'runnerRequest', 'moves', 'moveChunks']);

/** The gate at the top of every function. One not in ACCESS is owner-only; a box key has BOX_CALLS alone. */
export function mayCall(c: Caller, fn: string): boolean {
  if (c.owner) return true;
  if (c.box && !BOX_CALLS.has(fn)) return false;
  return ACCESS[fn] === 'own' || ACCESS[fn] === 'shared';
}

// What a runner key gets back from something that isn't its own. The kind
// is what the runner looks for (runner/src/sync.ts forbiddenText) to turn
// the feature off quietly rather than retrying. Never names another
// runner's id, thread or card: a refusal mustn't tell a key what it can't see.
export const FORBIDDEN = 'forbidden';
export function forbiddenMessage(what: string): string {
  return `This runner's key can't ${what}.`;
}
