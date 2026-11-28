// The phones registered for push (phone:registerDevice), as push.ts
// needs them, and the thread a push is about.
import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { relayInstall } from './machines';
import { RELAY_FRESH_MS, RELAY_REGISTER_TIMEOUT_MS, RELAY_VERIFY_SPARE_MS } from './relayInstallStates';
import { hasLiveToken, viewingThread } from './pushTargets';
import { runnerName } from './sync';
import { internal } from './_generated/api';
import { hasLiveKey, PRESENCE_FRESH_MS, presentAt } from './lib';
import { nextHealth } from './pushHealth';

// Only phones whose token is still good (pushTargets.ts): revoking deletes
// a phone's row (tokens.ts), but an expired token's phone, or an old row
// with no tokenId (from before 5 Nov 2026), is skipped here.
// `about`: the thread a push is for. A phone that has it open on screen is
// left out (pushTargets.ts viewingThread).
export const targets = internalQuery({
  args: { about: v.optional(v.string()) },
  returns: v.array(v.object({ apnsToken: v.string(), environment: v.union(v.literal('sandbox'), v.literal('production')), notify: v.union(v.literal('away'), v.literal('always'), v.literal('off')), pushKey: v.optional(v.string()), platform: v.optional(v.union(v.literal('android'), v.literal('webpush'))), webPush: v.optional(v.object({ p256dh: v.string(), auth: v.string() })) })),
  handler: async (ctx, { about }) => {
    const now = Date.now();
    const tokens = await ctx.db.query('tokens').collect();
    const out = [];
    for await (const d of ctx.db.query('devices')) {
      if (!hasLiveToken(d, tokens, now)) continue;
      if (about !== undefined && viewingThread(d, about, now)) continue;
      out.push({ apnsToken: d.apnsToken, environment: d.environment, notify: d.notify ?? ('away' as const), ...(d.pushKey ? { pushKey: d.pushKey } : {}), ...(d.platform ? { platform: d.platform } : {}), ...(d.webPush ? { webPush: d.webPush } : {}) });
    }
    return out;
  },
});

// Deletes the old rows with no tokenId, which get no pushes any more
// (pushTargets.ts); a paired phone has made itself a new one by starting
// up. Tidying only: npx convex run devices:dropUnlinked --prod
export const dropUnlinked = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    let n = 0;
    for await (const d of ctx.db.query('devices')) {
      if (d.tokenId) continue;
      await ctx.db.delete(d._id);
      n++;
    }
    return n;
  },
});

// This deployment's install with the push relay (relayInstallMachine.ts),
// for a send about to go through it (push.ts relayInstall): its id and key to
// use, or `register` (this send registers, with `attempt` as its id), or
// `wait` (another send is registering: ask again shortly, and use its key).
// `refused`: the attempt whose key the relay just refused, which is cleared
// only if it's still the one held, so a newer key another send saved since
// is used rather than replaced.
const vInstall = v.object({ attempt: v.string(), installId: v.string(), installKey: v.string() });
export const takeRelayInstall = internalMutation({
  args: { url: v.string(), attempt: v.string(), refused: v.optional(v.string()) },
  // failed: the relay turned the last registration down, and the next may only go after a while.
  returns: v.union(v.object({ use: vInstall }), v.object({ register: v.literal(true) }), v.object({ wait: v.literal(true) }), v.object({ failed: v.literal(true) })),
  handler: async (ctx, { url, attempt, refused }) => {
    let row = await relayRegistration(ctx, url);
    if (!row) {
      // The first send since relayRegistrations: an install saved before it
      // is taken over rather than registered again, and the old rows go.
      const before = await ctx.db.query('relayInstall').take(10);
      const had = before.find((r) => r.url === url);
      for (const r of before) await ctx.db.delete('relayInstall', r._id);
      const made = await relayInstall.create(ctx, { url } as never, had ? { type: 'ADOPT', attempt, installId: had.installId, installKey: had.installKey } : { type: 'REGISTER', attempt });
      if (made.status !== 'done') throw new ConvexError({ kind: 'conflict', message: `the relay install couldn't be started: ${made.reasons.join(' ')}` });
      if (!had) return { register: true as const };
      row = await ctx.db.get('relayRegistrations', made.id as Id<'relayRegistrations'>);
      if (!row) throw new ConvexError({ kind: 'conflict', message: 'the relay install went missing' });
    }
    const state = row.installState;
    if (state.kind === 'registered') {
      if (refused !== state.attempt) return { use: { attempt: state.attempt, installId: state.installId, installKey: state.installKey } };
      await relayInstall.send(ctx, row._id, { type: 'REFUSED', attempt: refused });
      // Refused as soon as it was given: the relay refuses new keys, and the install waits (RELAY_FRESH_MS).
      if (Date.now() - state.at < RELAY_FRESH_MS) return { failed: true as const };
    } else if (state.kind === 'registering' && state.giveUpAt > Date.now()) return { wait: true as const };
    else if (state.kind === 'unregistered' && state.retryAt > Date.now()) return { failed: true as const };
    const r = await relayInstall.send(ctx, row._id, { type: 'REGISTER', attempt });
    if (r.status !== 'done') throw new ConvexError({ kind: 'conflict', message: `couldn't register with the relay: ${r.reasons.join(' ')}` });
    return { register: true as const };
  },
});

// A registration's answer: the relay's id and key, kept only if this
// registration (`attempt`) still holds the install. False: another send
// took over after RELAY_REGISTER_MS, and its answer is the one kept.
export const relayRegistered = internalMutation({
  args: { url: v.string(), attempt: v.string(), installId: v.string(), installKey: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { url, ...event }) => {
    const row = await relayRegistration(ctx, url);
    if (row?.installState.kind !== 'registering' || row.installState.attempt !== event.attempt) return false;
    return (await relayInstall.send(ctx, row._id, { type: 'REGISTERED', ...event })).status === 'done';
  },
});

// A registration the relay turned down: the next send tries again after
// RELAY_FAILED_RETRY_MS.
export const relayRegisterFailed = internalMutation({
  args: { url: v.string(), attempt: v.string() },
  returns: v.null(),
  handler: async (ctx, { url, attempt }) => {
    const row = await relayRegistration(ctx, url);
    if (row?.installState.kind === 'registering' && row.installState.attempt === attempt) await relayInstall.send(ctx, row._id, { type: 'FAILED', attempt });
    return null;
  },
});

// The relay refused a key again after a send registered: cleared, if it's
// still the one held, so the next send registers (after RELAY_RETRY_MS if
// the key was new).
export const relayRefused = internalMutation({
  args: { url: v.string(), attempt: v.string() },
  returns: v.null(),
  handler: async (ctx, { url, attempt }) => {
    const row = await relayRegistration(ctx, url);
    if (row?.installState.kind === 'registered' && row.installState.attempt === attempt) await relayInstall.send(ctx, row._id, { type: 'REFUSED', attempt });
    return null;
  },
});

async function relayRegistration(ctx: MutationCtx, url: string) {
  return await ctx.db.query('relayRegistrations').withIndex('by_url', (q) => q.eq('url', url)).first();
}

// A registration with the relay starting (push.ts relayInstall). Clears
// any left from earlier ones that never finished.
// `attempt` (push.ts register): false, and nothing made, unless that
// registration holds the install with time for its whole wait and
// RELAY_VERIFY_SPARE_MS to spare (relayInstallStates.ts).
export const startRelayCheck = internalMutation({
  args: { nonce: v.string(), attempt: v.optional(v.string()) },
  returns: v.union(v.null(), v.boolean()),
  handler: async (ctx, { nonce, attempt }) => {
    for await (const row of ctx.db.query('relayChecks')) if (Date.now() - row.createdAt > RELAY_CHECK_MS) await ctx.db.delete(row._id);
    if (attempt !== undefined) {
      const s = await registeringFor(ctx, attempt);
      if (!s || s.giveUpAt - Date.now() < RELAY_REGISTER_TIMEOUT_MS + RELAY_VERIFY_SPARE_MS) return false;
    }
    await ctx.db.insert('relayChecks', { nonce, createdAt: Date.now(), ...(attempt ? { attempt } : {}) });
    return true;
  },
});

// The install's state while `attempt` is registering it, if it is.
async function registeringFor(ctx: MutationCtx, attempt: string) {
  for await (const r of ctx.db.query('relayRegistrations')) {
    const s = r.installState;
    if (s.kind === 'registering' && s.attempt === attempt) return s;
  }
  return null;
}

// The relay's check (http.ts /relay/verify): true once for a nonce this
// deployment made in the last few minutes, false for anything else.
export const takeRelayCheck = internalMutation({
  args: { nonce: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { nonce }) => {
    const row = await ctx.db
      .query('relayChecks')
      .withIndex('by_nonce', (q) => q.eq('nonce', nonce))
      .first();
    if (!row) return false;
    await ctx.db.delete(row._id);
    if (Date.now() - row.createdAt > RELAY_CHECK_MS) return false;
    if (row.attempt === undefined) return true;
    // Only while its send still waits for the answer, and still holds the
    // install: one given up on mustn't replace the key of the registration
    // that takes over (RELAY_VERIFY_SPARE_MS).
    return Date.now() - row.createdAt <= RELAY_REGISTER_TIMEOUT_MS && (await registeringFor(ctx, row.attempt)) !== null;
  },
});

const RELAY_CHECK_MS = 5 * 60_000;

// After each send (push.ts sendAlert): whether any got through
// (pushHealth.ts), for the owner runner's heartbeat to report.
export const pushOutcome = internalMutation({
  args: { sent: v.number(), failed: v.number(), failure: v.optional(v.string()), via: v.union(v.literal('apple'), v.literal('relay')) },
  returns: v.null(),
  handler: async (ctx, o) => {
    if (o.sent <= 0 && o.failed <= 0) return null;
    const row = await ctx.db.query('pushHealth').first();
    // nextHealth builds a fresh row (sent or failed is above 0 here), so
    // the old row's _id never ends up in it.
    const next = nextHealth(row ?? {}, o, Date.now());
    if (row) await ctx.db.replace(row._id, next);
    else await ctx.db.insert('pushHealth', next);
    return null;
  },
});

// Marks a thread's push as held for "away" phones while Mike is at the Mac;
// sync:setPresence sends it when he leaves. push.notify read that he was
// there, but he may have left since, and the drain his leaving started may
// be over: a push held now would wait for his next leave, maybe for good
// (Codex's review of Daybreak 148). So it asks again here, in the same
// transaction as the write, and sends it to the away phones instead. Once:
// a push that comes back here away again (`retried`, a runner flipping its
// presence between notify's read and this) is held, so no flipping can keep
// one push bouncing between notify and here (verify-fix on that change).
export const holdPush = internalMutation({
  args: { threadId: v.string(), retried: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { threadId, retried }) => {
    const t = await ctx.db
      .query('threads')
      .withIndex('by_threadId', (q) => q.eq('threadId', threadId))
      .unique();
    if (!t || !t.needsYou) return null;
    if (retried || (await presentAt(ctx, t.runnerId))) await ctx.db.patch(t._id, { pushHeldAt: Date.now() });
    else await ctx.scheduler.runAfter(0, internal.push.notify, { threadId, held: true, retried: true });
    return null;
  },
});

// push:notify delivered an alert for the thread to at least one phone: one
// clear may take it down (sync:upsertThreads wantsClear, Daybreak 169). If
// the thread stopped needing Mike while it was on its way, that clear goes
// now, as no later flip would send it.
export const alerted = internalMutation({
  args: { threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId }) => {
    const t = await ctx.db
      .query('threads')
      .withIndex('by_threadId', (q) => q.eq('threadId', threadId))
      .unique();
    if (!t) return null;
    if (t.needsYou) await ctx.db.patch(t._id, { alertedAt: Date.now() });
    else {
      // This clear takes down every alert out for it, so none is left for a
      // later flip to clear again (Gemini's review).
      if (t.alertedAt !== undefined) await ctx.db.patch(t._id, { alertedAt: undefined });
      await ctx.scheduler.runAfter(0, internal.push.clear, { threadId });
    }
    return null;
  },
});

// Apple said the token is gone (the app was removed, or it's stale).
export const drop = internalMutation({
  args: { apnsToken: v.string() },
  returns: v.null(),
  handler: async (ctx, { apnsToken }) => {
    const row = await ctx.db
      .query('devices')
      .withIndex('by_apnsToken', (q) => q.eq('apnsToken', apnsToken))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

export const threadForPush = internalQuery({
  args: { threadId: v.string() },
  // mac: the runner's name, for a thread on a Mac with a runner key of its
  // own (not byOwner), so its push can't pass for the main Mac's.
  returns: v.union(v.null(), v.object({ title: v.string(), status: v.string(), preview: v.string(), needsYou: v.boolean(), atMac: v.boolean(), mac: v.optional(v.string()), pendingApproval: v.optional(v.any()) })),
  handler: async (ctx, { threadId }) => {
    const t = await ctx.db
      .query('threads')
      .withIndex('by_threadId', (q) => q.eq('threadId', threadId))
      .unique();
    if (!t) return null;
    const runner = await ctx.db
      .query('runners')
      .withIndex('by_runnerId', (q) => q.eq('runnerId', t.runnerId))
      .unique();
    const atMac = Boolean(runner?.atMac) && Date.now() - (runner?.lastSeenAt ?? 0) < PRESENCE_FRESH_MS;
    // Named unless it's the main key's runner and has no key of its own; one
    // with no row (never heartbeated) goes by its id (runnerName).
    const mac = runner?.byOwner && !(await hasLiveKey(ctx, t.runnerId)) ? undefined : await runnerName(ctx, t.runnerId);
    return { title: t.title, status: t.status, preview: t.preview, needsYou: t.needsYou, atMac, ...(mac ? { mac } : {}), ...(t.pendingApproval ? { pendingApproval: t.pendingApproval } : {}) };
  },
});

export const list = internalQuery({
  args: {},
  returns: v.array(v.object({ platform: v.string(), environment: v.string(), tokenName: v.string(), updatedAt: v.string(), tokenTail: v.string(), notify: v.string() })),
  handler: async (ctx) => {
    const out = [];
    for await (const d of ctx.db.query('devices')) out.push({ platform: d.platform ?? 'apple', environment: d.environment, tokenName: d.tokenName, updatedAt: new Date(d.updatedAt).toISOString(), tokenTail: d.apnsToken.slice(-6), notify: d.notify ?? 'away' });
    return out;
  },
});

// This deployment's VAPID key (API 93, webPush.ts): the one that's there, or
// `candidate` (made by the caller, as a mutation can't make keys) when there's
// none yet. Two callers racing both get whichever was saved first.
export const vapidKey = internalQuery({
  args: {},
  returns: v.union(v.null(), v.object({ x: v.string(), y: v.string(), d: v.string() })),
  handler: async (ctx) => {
    const row = await ctx.db.query('webPushVapid').first();
    return row ? { x: row.x, y: row.y, d: row.d } : null;
  },
});

export const putVapidKey = internalMutation({
  args: { x: v.string(), y: v.string(), d: v.string() },
  returns: v.object({ x: v.string(), y: v.string(), d: v.string() }),
  handler: async (ctx, candidate) => {
    const row = await ctx.db.query('webPushVapid').first();
    if (row) return { x: row.x, y: row.y, d: row.d };
    await ctx.db.insert('webPushVapid', { ...candidate, createdAt: Date.now() });
    return candidate;
  },
});
