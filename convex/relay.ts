// Other runners' threads read and steered through the backend (API 44,
// docs/protocol/runners.md "Other runners' threads through the backend"): the main
// Mac's runner reads another runner's thread from its messages and threads
// rows, and asks that runner to act on it with a `commands` row, as the
// phone does. The Mac app talks only to its own runner; runners never talk
// to each other. All owner only (runnerAccess.ts ACCESS): a runner key
// can't read another runner's threads or queue work for it.
//
// Read rules (docs/convex-backend.md, "Read rules"): the live tail is a few rows, older pages
// are read once and kept on the runner, a thread's row is one document, and
// a command's state is one get by id.
import { ConvexError, v } from 'convex/values';
import type { OrderedQuery } from 'convex/server';
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { DataModel, Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { checkRunnerId, forbidden, isSeq, MAX_SEQ, ownerFenced, pageLimit, runnerAuth, sha256, withoutCredentials } from './lib';
import { docBytes, isThreadId, mayTouch, ownThreadOnly } from './runnerAccess';
import { queued, request as requestMachine } from './machines';
import { requestStateFrom } from './requestStates';
import { steppingFor } from './stepping';
import { messageButton, usagePool } from './schema';
import { deleteIfUnused, MAX_COMMAND_FILES, MAX_RUNNER_UPLOAD_BYTES, storageInUse } from './sync';
import { UPLOAD_CLAIM_MS, newClaim } from './uploads';

// The live tail: enough for a message or two of tool rows between texts.
export const TAIL_MAX = 15;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
// What a queued command's args may be at most. A send's text is the longest.
const ARGS_MAX_BYTES = 64 * 1024;

const relayRow = v.object({
  seq: v.number(),
  // "note" (API 78): a login's note, which only this route carries.
  role: v.union(v.literal('user'), v.literal('assistant'), v.literal('tool'), v.literal('note')),
  text: v.string(),
  origin: v.optional(v.string()),
  toolKind: v.optional(v.string()),
  summary: v.optional(v.boolean()),
  plan: v.optional(v.boolean()),
  planDecision: v.optional(v.union(v.literal('go'), v.literal('revise'))),
  turn: v.optional(v.string()),
  wokeBy: v.optional(v.array(v.object({ kind: v.string(), description: v.string() }))),
  // The reply buttons its text links (API 59), as the phone gets them; the
  // relay answers buttons.list from them (API 68).
  buttons: v.optional(v.array(messageButton)),
  // How many pictures a user's message came with (API 87), so the relay
  // shows them without counting from the words.
  pictures: v.optional(v.number()),
  // The asks a user's message answered (API 89), so another Mac draws them
  // as answers.
  answers: v.optional(v.array(v.object({ action: v.string(), answer: v.string() }))),
  // Why the runner sent its own message (API 98), so another Mac heads its
  // note as that runner's own Mac does.
  wakeReason: v.optional(v.string()),
  at: v.string(),
});

type Button = { id: string; title: string; kind: 'start' | 'send'; target?: string; pressedThreadId?: string; failed?: string };
type Row = { seq: number; role: 'user' | 'assistant' | 'tool' | 'note'; text: string; origin?: string; toolKind?: string; summary?: boolean; plan?: boolean; planDecision?: 'go' | 'revise'; turn?: string; wokeBy?: { kind: string; description: string }[]; buttons?: Button[]; pictures?: number; answers?: { action: string; answer: string }[]; wakeReason?: string; at: string };
function toRow(m: Row): Row {
  return {
    seq: m.seq,
    role: m.role,
    text: m.text,
    ...(m.origin ? { origin: m.origin } : {}),
    ...(m.toolKind ? { toolKind: m.toolKind } : {}),
    ...(m.summary ? { summary: true } : {}),
    // A Plan first plan (API 72's row), which another Mac draws as its plan card.
    ...(m.plan ? { plan: true } : {}),
    // What became of it, once that runner knows (API 76).
    ...(m.plan && m.planDecision ? { planDecision: m.planDecision } : {}),
    ...(m.turn ? { turn: m.turn } : {}),
    ...(m.wokeBy ? { wokeBy: m.wokeBy } : {}),
    ...(m.buttons?.length ? { buttons: m.buttons } : {}),
    // Only a count a message could have: a runner key writes what it likes.
    ...(m.role === 'user' && Number.isSafeInteger(m.pictures) && m.pictures! >= 1 && m.pictures! <= 999 ? { pictures: m.pictures } : {}),
    ...(m.role === 'user' && m.answers?.length ? { answers: m.answers } : {}),
    ...(m.role === 'user' && m.origin === 'runner' && m.wakeReason ? { wakeReason: m.wakeReason } : {}),
    at: m.at,
  };
}

// How many login notes a page for a runner that didn't ask for them looks
// past. They come a few at a time, when a login runs out.
const NOTES_SKIPPED = 500;

/**
 * The first `want` rows of `q`, and whether there are more. A login's note
 * (role "note", API 78) only for a runner that asks with `notes`: one from
 * before draws any row it doesn't know as a tool call, and a row after the
 * last turn took that turn's card and its failure away there (Codex's
 * review, 13 Nov).
 */
async function pageOf(q: OrderedQuery<DataModel['messages']>, want: number, notes: boolean | undefined): Promise<{ rows: Doc<'messages'>[]; hasMore: boolean }> {
  const rows: Doc<'messages'>[] = [];
  let read = 0;
  for await (const m of q) {
    if (++read > want + 1 + NOTES_SKIPPED) return { rows, hasMore: true };
    // A row from before seqs were checked (lib.ts isSeq) is left out, not
    // let break the rest of the thread on the main Mac. The pages read only
    // 0 to MAX_SEQ of the index, so the infinities, negatives and huge ones
    // are never read at all (a run of them would use up NOTES_SKIPPED and
    // leave the page empty, Grok's review); fractions and NaN are skipped here.
    if ((!notes && m.role === 'note') || !isSeq(m.seq)) continue;
    if (rows.length >= want) return { rows, hasMore: true };
    rows.push(m);
  }
  return { rows, hasMore: false };
}

/** The newest rows of a thread, oldest first: the live tail. */
export const remoteTail = query({
  args: { key: v.string(), threadId: v.string(), limit: v.optional(v.number()), notes: v.optional(v.boolean()) },
  returns: v.object({ messages: v.array(relayRow), hasMore: v.boolean() }),
  handler: async (ctx, { key, threadId, limit, notes }) => {
    await runnerAuth(ctx, key, 'remoteTail');
    const want = pageLimit(limit, TAIL_MAX, TAIL_MAX);
    const { rows, hasMore } = await pageOf(ctx.db.query('messages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId).gte('seq', 0).lte('seq', MAX_SEQ)).order('desc'), want, notes);
    return { messages: rows.reverse().map(toRow), hasMore };
  },
});

/**
 * A page of a thread's rows, read once: the `limit` before `beforeSeq`, or
 * after `afterSeq` (filling what a tail skipped), or the newest. Oldest first.
 */
export const remoteMessages = query({
  args: { key: v.string(), threadId: v.string(), beforeSeq: v.optional(v.number()), afterSeq: v.optional(v.number()), limit: v.optional(v.number()), notes: v.optional(v.boolean()) },
  returns: v.object({ messages: v.array(relayRow), hasMore: v.boolean() }),
  handler: async (ctx, { key, threadId, beforeSeq, afterSeq, limit, notes }) => {
    await runnerAuth(ctx, key, 'remoteMessages');
    const want = pageLimit(limit, PAGE_DEFAULT, PAGE_MAX);
    if (afterSeq !== undefined) {
      const after = Number.isFinite(afterSeq) ? afterSeq : -1;
      const { rows, hasMore } = await pageOf(ctx.db.query('messages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId).gt('seq', after).lte('seq', MAX_SEQ)).order('asc'), want, notes);
      return { messages: rows.map(toRow), hasMore };
    }
    const { rows, hasMore } = await pageOf(
      ctx.db
        .query('messages')
        .withIndex('by_thread_seq', (q) => q.eq('threadId', threadId).gte('seq', 0).lt('seq', beforeSeq !== undefined && Number.isFinite(beforeSeq) ? Math.min(beforeSeq, MAX_SEQ + 1) : MAX_SEQ + 1))
        .order('desc'),
      want,
      notes,
    );
    return { messages: rows.reverse().map(toRow), hasMore };
  },
});

// How many messages one picturesAtSeqs reads, and pictures of each: a
// message carries at most a handful (the app pastes up to 6 into one sent
// to another runner, MAX_COMMAND_FILES), and the relay asks only for the
// ones whose words say they have some.
const PICTURE_SEQS_MAX = 50;
const PICTURES_PER_SEQ = 30;
// A pasted picture's src (runner/src/share-images.ts pastedImagesInEvent).
const PASTED = /^picture:(\d{1,3})$/;

/**
 * The pictures pasted into the messages at `seqs` of another runner's
 * thread (API 87), each with its file's URL: what that runner put up for
 * the phone and the website (replyImages with src "picture:N", N being
 * which of the message's pictures). Read by seq, so the thread's other
 * pictures are never read. Owner only: the main Mac's runner shows them in
 * the app and answers its files.read for them (runner/src/relay.ts).
 */
export const picturesAtSeqs = query({
  args: { key: v.string(), threadId: v.string(), seqs: v.array(v.number()) },
  returns: v.array(
    v.object({
      seq: v.number(),
      n: v.number(),
      path: v.string(),
      url: v.string(),
      mediaType: v.string(),
      width: v.optional(v.number()),
      height: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, { key, threadId, seqs }) => {
    await runnerAuth(ctx, key, 'picturesAtSeqs');
    const out = [];
    for (const seq of [...new Set(seqs.filter(isSeq))].sort((a, b) => a - b).slice(0, PICTURE_SEQS_MAX)) {
      const found = new Map<number, Doc<'replyImages'>>();
      // A reply's or a pinned picture at the same seq isn't one of these:
      // passed over, but counted, so a seq can't make this read without end.
      let read = 0;
      for await (const img of ctx.db.query('replyImages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId).eq('seq', seq))) {
        if (++read > PICTURES_PER_SEQ * 2 || found.size >= PICTURES_PER_SEQ) break;
        const n = Number(PASTED.exec(img.src ?? '')?.[1] ?? 0);
        if (n >= 1 && !found.has(n)) found.set(n, img);
      }
      for (const [n, img] of [...found].sort((a, b) => a[0] - b[0])) {
        const url = await ctx.storage.getUrl(img.storageId);
        if (!url) continue;
        out.push({ seq, n, path: img.path, url, mediaType: img.mediaType, ...(img.width ? { width: img.width } : {}), ...(img.height ? { height: img.height } : {}) });
      }
    }
    return out;
  },
});

/** One thread's row (its state, open approval and card), live while it's open. Null once it's gone. */
export const remoteThread = query({
  args: { key: v.string(), threadId: v.string() },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { key, threadId }) => {
    await runnerAuth(ctx, key, 'remoteThread');
    const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
    if (!t) return null;
    // The secret card's key stays: the runner seals an answer to it, as the phone does.
    const { _id, _creationTime, pushedAt: _p, pushHeldAt: _h, alertedAt: _a, ...rest } = t;
    return rest;
  },
});

// What a command from the main Mac may carry, kind by kind: only what that
// runner's apply() reads, so nothing else is stored. Each gets `from: "mac"`,
// so a message it sends isn't marked as the phone's (phone.ts never sets it).
// The modes a new thread can start on (runner/src/protocol.ts, PERMISSION_MODES).
const PERMISSION_MODES = ['full', 'ask', 'auto', 'plan'] as const;
// The effort levels a thread update may set (runner/src/protocol.ts, EFFORT_LEVELS).
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
// press and slashCommands (API 68): a reply button and the slash command
// list, as the phone sends them (phone.ts press, slashCommands).
const KINDS = ['send', 'respond', 'update', 'create', 'interrupt', 'call', 'share', 'press', 'slashCommands'] as const;
type Kind = (typeof KINDS)[number];
// Methods a `call` may run on the other runner, and nothing else: answers
// with no file contents or tool output in them (step 4 brings those, scrubbed).
// moves.describe and moves.preview (API 65) are the Mac's Move sheet
// (threads.movePreview): plans only, nothing starts.
// accounts.yearToken (API 90) is the Mac's Runners panel's Year-long token…
// for one of that runner's logins: its answer is a state and the claude.ai
// page, never a token, and its code (useless without the verifier only
// that runner's setup-token holds) goes with the args once it's finished.
// accounts.useReset (API 104) is the Mac's Use a reset for a login only that
// runner has: its answer is an outcome and the login, and it spends a reset
// only on Mike's click (the runner checks it came from the Mac).
// logins.sealKey and logins.share (API 105) are the Runners panel's Use
// this Mac's Claude logins (docs/protocol/settings.md, "This Mac's logins
// on another runner"): that runner's public sealing key, then each login
// sealed to it. Only ciphertext is held, and only until it's finished.
export const CALLS = new Set(['files.list', 'moves.describe', 'moves.preview', 'requests.confirmStart', 'accounts.yearToken', 'accounts.useReset', 'logins.sealKey', 'logins.share']);
// A logins.share's shape: an email and a sealed box (base64) each.
const SHARED_LOGINS_MAX = 20;
const SHARED_BOX_MAX = 2800;
const SHARED_EMAIL = /^[^\s@]{1,100}@[^\s@]{1,100}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// A moves.preview's thread description: only these fields, each a short
// string (or worktree and schedules), so nothing else sits in the row.
const MOVE_INFO_STRINGS = ['title', 'cwd', 'home', 'provider', 'accountId', 'email', 'model', 'effort', 'permissionMode', 'origin', 'repoTop', 'subdir', 'sessionId'];
function moveInfoArg(raw: unknown): Record<string, unknown> {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const k of MOVE_INFO_STRINGS) if (typeof o[k] === 'string' && (o[k] as string).length <= 2000) out[k] = o[k];
  // Which repo, never a password or token in its address: the runner the
  // preview asks reads this row (an older main Mac's runner sends it whole).
  if (typeof out.origin === 'string') out.origin = withoutCredentials(out.origin);
  if (out.origin === '') delete out.origin;
  // Nor what no target plans from: an older main Mac's runner sends the
  // thread's title (made from its first message) and session whole.
  if ('title' in out) out.title = '';
  delete out.sessionId;
  if (typeof o.worktree === 'boolean') out.worktree = o.worktree;
  if (typeof o.schedules === 'number' && Number.isFinite(o.schedules)) out.schedules = o.schedules;
  return out;
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}
function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export function commandArgs(kind: Kind, raw: unknown): Record<string, unknown> {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const bad = (why: string) => new ConvexError({ kind: 'badArgs', message: why });
  let out: Record<string, unknown>;
  switch (kind) {
    case 'send':
      if (str(a.text) === undefined) throw bad('a send needs text');
      out = pick(a, ['text', 'answers']);
      break;
    case 'respond':
      if (!str(a.approvalId) || !['allow', 'allowAlways', 'deny', 'answered'].includes(String(a.decision))) throw bad('a respond needs approvalId and decision');
      // A secret's answer only ever goes sealed to that runner's key.
      if (a.secret === true && a.decision === 'answered' && !a.sealed) throw bad('a secret goes sealed');
      out = pick(a, ['approvalId', 'decision', 'message', 'answers', 'secret', 'sealed']);
      break;
    case 'update':
      // A login, model or effort change (API 77; effort from API 112): the
      // composer's pickers and the limit box's Continue now on, for a thread
      // on another runner. They go together, as one threads.update there,
      // since a model picked from another provider's column moves the login
      // with it, and only with nothing else, so it reads as the one change
      // it is.
      if (['accountId', 'model', 'effort', 'carryOn'].some((k) => a[k] !== undefined)) {
        out = pick(a, ['accountId', 'model', 'effort']);
        for (const [k, x] of Object.entries(out)) {
          if (k === 'effort') {
            if (x !== null && !(typeof x === 'string' && EFFORT_LEVELS.includes(x as never))) throw bad(`effort must be one of ${EFFORT_LEVELS.join(', ')} or null`);
            continue;
          }
          // null puts the model back to the login's default.
          if (!(typeof x === 'string' && x.length > 0 && x.length <= 200) && !(x === null && k !== 'accountId')) throw bad(`${k} must be a short string`);
        }
        if (!Object.keys(out).length) throw bad('carryOn goes with accountId');
        if (a.carryOn !== undefined) {
          if (a.carryOn !== true || typeof out.accountId !== 'string') throw bad('carryOn goes with accountId');
          out.carryOn = true;
        }
        // An agent on the main Mac made it (its threadbear tools): that
        // runner keeps a sandboxed thread in its sandbox and starts no turn.
        if (a.by === 'agent') out.by = 'agent';
        const others = pick(a, ['snooze', 'wake', 'archive', 'unarchive', 'markSeen', 'title', 'star']);
        if (Object.keys(others).length) throw bad('an update changes one thing');
        break;
      }
      out = pick(a, ['snooze', 'wake', 'archive', 'unarchive', 'markSeen', 'title', 'star']);
      if (Object.keys(out).length !== 1) throw bad('an update changes one thing');
      // How it went, with an archive (API 42), as phone:update takes it.
      if (out.archive === true && ['worked', 'didntWork', 'notNeeded'].includes(String(a.verdict))) out.verdict = a.verdict;
      // An agent on the main Mac archived it (its threadbear tools), so that
      // runner says "archived by an agent", not by Mike.
      if (a.by === 'agent') out.by = 'agent';
      break;
    case 'create':
      // Pictures alone will do (API 63), as a new thread from this Mac's own composer.
      if (str(a.text) === undefined || (!str(a.text)!.trim() && !(Array.isArray(a.images) && a.images.length))) throw bad('a new thread needs text');
      out = pick(a, ['text', 'cwd', 'accountId', 'model', 'effort']);
      // Left out, the thread gets full access, so every mode is kept and an
      // unknown one refused, never dropped (Daybreak, 7 Nov 2026: Plan first
      // arrived as Full access). Plan first comes as "ask" with plan: true
      // (runner/src/protocol.ts, remoteCreateMode), which a runner from
      // before it reads as Ask.
      if (a.permissionMode !== undefined) {
        if (!PERMISSION_MODES.includes(a.permissionMode as never)) throw bad(`permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
        out.permissionMode = a.permissionMode;
      }
      if (a.plan !== undefined) {
        if (a.plan !== true || a.permissionMode !== 'ask') throw bad('plan: true goes with permissionMode "ask"');
        out.plan = true;
      }
      break;
    case 'interrupt':
      out = a.by === 'agent' ? { by: 'agent' } : {};
      break;
    case 'call':
      if (!CALLS.has(String(a.method))) throw bad(`only ${[...CALLS].join(', ')} can be asked of another runner`);
      // Only what the one allowed call reads: anything else in here would sit in
      // the row, under field names scrubbing skips.
      if (a.method === 'moves.preview') {
        const p = (a.params && typeof a.params === 'object' ? a.params : {}) as Record<string, unknown>;
        out = { method: a.method, params: { info: moveInfoArg(p.info), ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}), ...(typeof p.accountId === 'string' ? { accountId: p.accountId } : {}) } };
      } else if (a.method === 'requests.confirmStart') {
        const p = (a.params && typeof a.params === 'object' ? a.params : {}) as Record<string, unknown>;
        if (typeof p.approvalId !== 'string' || !REQUEST_ID.test(p.approvalId)
          || typeof p.docId !== 'string' || p.docId.length > 128
          || typeof p.claim !== 'string' || !CLAIM.test(p.claim)) throw bad('requests.confirmStart needs a request and claim');
        out = { method: a.method, params: { approvalId: p.approvalId, docId: p.docId, claim: p.claim, ...(p.release === true ? { release: true } : {}) } };
      } else if (a.method === 'moves.describe') {
        out = { method: a.method, params: {} };
      } else if (a.method === 'accounts.useReset') {
        const p = (a.params && typeof a.params === 'object' ? a.params : {}) as Record<string, unknown>;
        if (typeof p.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.accountId)) throw bad('accounts.useReset needs a login');
        out = { method: a.method, params: { accountId: p.accountId } };
      } else if (a.method === 'logins.sealKey') {
        out = { method: a.method, params: {} };
      } else if (a.method === 'logins.share') {
        const p = (a.params && typeof a.params === 'object' ? a.params : {}) as Record<string, unknown>;
        if (!Array.isArray(p.logins) || p.logins.length > SHARED_LOGINS_MAX) throw bad(`logins.share takes a list of at most ${SHARED_LOGINS_MAX} logins`);
        const logins = p.logins.map((l: unknown) => {
          const o = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
          if (typeof o.email !== 'string' || !SHARED_EMAIL.test(o.email)) throw bad('each shared login needs its email');
          if (typeof o.box !== 'string' || o.box.length > SHARED_BOX_MAX || !BASE64.test(o.box)) throw bad('each shared login goes sealed');
          return { email: o.email, box: o.box };
        });
        out = { method: a.method, params: { logins } };
      } else if (a.method === 'accounts.yearToken') {
        const p = (a.params && typeof a.params === 'object' ? a.params : {}) as Record<string, unknown>;
        if (typeof p.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.accountId)) throw bad('accounts.yearToken needs a login');
        if (p.code !== undefined && (typeof p.code !== 'string' || !/^[A-Za-z0-9_-]{8,512}#[A-Za-z0-9_-]{8,512}$/.test(p.code))) throw bad("that isn't a code from Claude's page");
        out = { method: a.method, params: { accountId: p.accountId, ...(typeof p.code === 'string' ? { code: p.code } : {}), ...(p.check === true ? { check: true } : {}), ...(p.cancel === true ? { cancel: true } : {}) } };
      } else {
        out = { method: a.method, params: typeof (a.params as { path?: unknown } | undefined)?.path === 'string' ? { path: (a.params as { path: string }).path } : {} };
      }
      break;
    case 'share':
      if (a.access !== 'off' && a.access !== 'link') throw bad('access is "off" or "link"');
      out = pick(a, ['access', 'newLink']);
      break;
    case 'press':
      if (typeof a.buttonId !== 'string' || !/^[a-z0-9]{8}$/.test(a.buttonId)) throw bad('no such button');
      out = { buttonId: a.buttonId };
      break;
    case 'slashCommands':
      out = {};
      break;
  }
  if (docBytes(out) > ARGS_MAX_BYTES) throw bad('too long');
  return out;
}

/**
 * Asks another runner to act on one of its threads (or, for a create or a
 * call, on itself). A thread's command goes to the runner the backend says
 * has the thread, never one the caller names, so it can't be aimed at a
 * runner that would take it for one of its own.
 */
export const queueCommand = mutation({
  args: { key: v.string(), runnerId: v.string(), threadId: v.optional(v.string()), kind: v.union(...KINDS.map((k) => v.literal(k))), args: v.any() },
  returns: v.id('commands'),
  handler: async (ctx, { key, runnerId, threadId, kind, args }) => {
    await runnerAuth(ctx, key, 'queueCommand');
    checkRunnerId(runnerId);
    const runner = await ctx.db.query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
    if (!runner) throw new ConvexError({ kind: 'notFound', message: 'no such runner' });
    if (threadId !== undefined) {
      const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
      // A thread on a virtual runner has no row until its box writes one
      // (it may be booting, or waiting for a cloud token): its box row says whose it is.
      const owner = t?.runnerId ?? (await ctx.db.query('boxes').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique())?.runnerId;
      if (owner === undefined) throw new ConvexError({ kind: 'notFound', message: 'no such thread' });
      if (owner !== runnerId) throw forbidden("queue that: the thread isn't that runner's");
    } else if (kind !== 'create' && kind !== 'call') {
      throw new ConvexError({ kind: 'badArgs', message: `a ${kind} needs a thread` });
    } else if (kind === 'create' && runner.box) {
      // A box runs its one thread: a new one on a virtual runner is boxes:startThread's.
      throw new ConvexError({ kind: 'badArgs', message: "That runner is one thread's box on a virtual runner: it takes no new threads." });
    }
    const images = kind === 'send' || kind === 'create' ? await commandPictures(ctx, (args as { images?: unknown } | null)?.images) : [];
    const commandId = await queued(ctx, { runnerId, ...(threadId !== undefined ? { threadId } : {}), kind, args: { ...commandArgs(kind, args), ...(images.length ? { images } : {}), from: 'mac' }, createdAt: Date.now() });
    // On their way, so nothing deletes them before that runner has fetched
    // them; sync:finishCommand deletes them once it has (as a phone's photos).
    for (const image of images) await ctx.db.insert('commandFiles', { storageId: image.storageId, commandId });
    return commandId;
  },
});

// ------------------------------------------------------------ pictures
// A picture pasted into a message for another runner's thread (API 63). The
// main Mac's runner uploads each one to /relay/upload (pictureUploadUrl),
// which records it (relayUploads), and names it here, and the command
// carries a URL for each, in the shape a phone's photos have, so every
// runner fetches them as it already does for the phone (runner/src/sync.ts
// withPhoneImages). They're in Convex only on their way: finishing the
// command deletes them, and one that never went out goes after a day
// (sync:pruneFiles), whatever happened to the runner meanwhile.

const RELAY_TICKET_MS = 60 * 60_000;

/** A one-use URL on /relay/upload for one picture, at most 10 MB. */
export const pictureUploadUrl = mutation({
  args: { key: v.string() },
  returns: v.string(),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'pictureUploadUrl');
    const site = process.env.CONVEX_SITE_URL;
    if (!site) throw new ConvexError({ kind: 'config', message: 'CONVEX_SITE_URL is not set' });
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const ticket = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    await ctx.db.insert('relayUploads', { ticketHash: await sha256(ticket), issuedAt: Date.now() });
    return `${site.replace(/\/+$/, '')}/relay/upload?ticket=${ticket}`;
  },
});

// Unused and under an hour old.
async function liveRelayTicket(ctx: QueryCtx | MutationCtx, ticket: string) {
  if (!/^[0-9a-f]{48}$/.test(ticket)) return null;
  const hash = await sha256(ticket);
  const row = await ctx.db.query('relayUploads').withIndex('by_hash', (q) => q.eq('ticketHash', hash)).first();
  return row && !row.usedAt && row.issuedAt > Date.now() - RELAY_TICKET_MS ? row : null;
}

// /relay/upload's first step, before it reads the body (uploads.ts
// takeUpload): the ticket is spent here, so of many requests with one
// ticket only the first reads anything.
export const claimRelayUpload = internalMutation({
  args: { ticket: v.string() },
  returns: v.union(v.object({ claim: v.string() }), v.literal(false), v.literal('later')),
  handler: async (ctx, { ticket }) => {
    const row = await liveRelayTicket(ctx, ticket);
    if (!row) return false;
    const claim = newClaim();
    await ctx.db.patch(row._id, { usedAt: Date.now(), claim });
    return { claim };
  },
});

// /relay/upload's last step: the stored file is this upload's. False (the
// route then deletes the file): not this request's claim, or no file or one
// over the cap.
export const finishRelayUpload = internalMutation({
  args: { ticket: v.string(), claim: v.string(), storageId: v.optional(v.id('_storage')), bytes: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { ticket, claim, storageId, bytes }) => {
    if (!/^[0-9a-f]{48}$/.test(ticket) || !claim) return false;
    const hash = await sha256(ticket);
    const row = await ctx.db.query('relayUploads').withIndex('by_hash', (q) => q.eq('ticketHash', hash)).first();
    if (!row || row.claim !== claim || !row.usedAt || row.usedAt <= Date.now() - UPLOAD_CLAIM_MS) return false;
    const ok = !!storageId && bytes >= 0 && bytes <= MAX_RUNNER_UPLOAD_BYTES;
    await ctx.db.patch(row._id, { claim: undefined, ...(ok ? { storageId } : {}) });
    return ok;
  },
});

// Each named file: one uploaded for this (relayUploads; a runner key's,
// a phone's or any other stored file never is), and named by nothing else,
// another command included: finishing would delete it from under that.
async function commandPictures(ctx: MutationCtx, raw: unknown): Promise<{ storageId: Id<'_storage'>; url: string }[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) throw new ConvexError({ kind: 'badArgs', message: 'images are storage ids' });
  if (raw.length > MAX_COMMAND_FILES) throw new ConvexError({ kind: 'badArgs', message: `at most ${MAX_COMMAND_FILES} pictures in a message to another Mac` });
  const out: { storageId: Id<'_storage'>; url: string }[] = [];
  for (const id of raw as Id<'_storage'>[]) {
    if (out.some((o) => o.storageId === id)) throw new ConvexError({ kind: 'badArgs', message: 'the same picture twice' });
    const url = (await stored(ctx, id)) ? await ctx.storage.getUrl(id) : null;
    if (!url) throw new ConvexError({ kind: 'notFound', message: 'that picture has gone' });
    if (!(await isRelayUpload(ctx, id)) || (await storageInUse(ctx, id))) throw forbidden('send a stored file that is something else');
    out.push({ storageId: id, url });
  }
  return out;
}

// Whether a file is there; an id that isn't one at all (Convex throws on it) isn't.
async function stored(ctx: MutationCtx, id: Id<'_storage'>): Promise<boolean> {
  try {
    return (await ctx.db.system.get(id)) !== null;
  } catch {
    return false;
  }
}

async function isRelayUpload(ctx: MutationCtx, storageId: Id<'_storage'>): Promise<boolean> {
  return (await ctx.db.query('relayUploads').withIndex('by_storageId', (q) => q.eq('storageId', storageId)).first()) !== null;
}

/**
 * Pictures the main Mac's runner uploaded for a command that then wasn't
 * queued: deleted, but only ones of its own that nothing names (one that
 * did get queued stays until its command is over).
 */
export const discardPictures = mutation({
  args: { key: v.string(), storageIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { key, storageIds }) => {
    await runnerAuth(ctx, key, 'discardPictures');
    for (const id of storageIds.slice(0, MAX_COMMAND_FILES) as Id<'_storage'>[]) {
      if (!(await stored(ctx, id)) || !(await isRelayUpload(ctx, id))) continue;
      await deleteIfUnused(ctx, id);
    }
    return null;
  },
});

/** Where a command the main Mac queued has got to, one get by id: watched until it's done or failed. */
export const commandState = query({
  args: { key: v.string(), commandId: v.id('commands') },
  returns: v.union(
    v.null(),
    v.object({ state: v.union(v.literal('pending'), v.literal('taken'), v.literal('done'), v.literal('failed')), note: v.optional(v.string()), threadId: v.optional(v.string()), result: v.optional(v.any()) }),
  ),
  handler: async (ctx, { key, commandId }) => {
    await runnerAuth(ctx, key, 'commandState');
    const c = await ctx.db.get(commandId);
    if (!c) return null;
    let result: unknown;
    try {
      result = c.result !== undefined ? JSON.parse(c.result) : undefined;
    } catch {
      result = undefined;
    }
    return { state: c.state, ...(c.note ? { note: c.note } : {}), ...(c.resultThreadId ? { threadId: c.resultThreadId } : {}), ...(result !== undefined ? { result } : {}) };
  },
});

/**
 * Another runner's logins, with their models and (API 77) how much room each
 * has, for the main Mac's pickers and its limit box on that runner's threads.
 * Without the room, that box judged a Pixel thread by the Mac's own login of
 * the same id, and offered the Mac's logins to switch it to.
 */
export const remoteAccounts = query({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, { key, runnerId }) => {
    await runnerAuth(ctx, key, 'remoteAccounts');
    const out = [];
    for (const a of await ctx.db.query('accounts').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).take(50)) {
      const { _id, _creationTime, ...rest } = a;
      out.push(rest);
    }
    return out;
  },
});

// The owning runner's effective pools, including local/default membership.
export const remotePools = query({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.union(v.null(), v.array(usagePool)),
  handler: async (ctx, { key, runnerId }) => {
    await runnerAuth(ctx, key, 'remotePools');
    const runner = await ctx.db.query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
    return runner?.usagePools ?? null;
  },
});

// ------------------------------------------------------------ requests
// A runner on a runner key asking for a new thread on another runner
// (docs/protocol/runners.md, "Asking another runner"; schema.ts runnerRequests). It
// files the request here and shows a card in its own thread; the main Mac's
// app reads the request back through its runner, shows Mike all of it, and
// on Allow its runner (the owner key) starts the thread and marks the row.
// The asking runner never queues anything for another runner: the most a
// tampered one can do is put a card in front of Mike.

const REQUEST_TEXT_MAX = 32 * 1024;
const REQUEST_FIELD_MAX = 1024;
// Waiting at once, per runner. A card waits at most an hour (the runner's
// timer), so a few is plenty, and one older than two hours is dead (its
// runner restarted, or its close never arrived) and doesn't count.
const REQUESTS_PENDING_MAX = 5;
const PENDING_LIVE_MS = 2 * 60 * 60 * 1000;
// Kept at most, per runner, whatever their state, so filing and closing
// over and over can't fill the deployment.
const REQUESTS_KEPT_MAX = 50;
// Kept a week, for "what did the cloud ask for", then swept as the runner files more.
const REQUEST_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
// The asking thread's id goes into the first line the main Mac's runner
// writes on the new thread, so nothing but an id's characters (isThreadId).
const STATES = ['pending', 'claimed', 'allowed', 'denied', 'closed'] as const;
const stateV = v.union(...STATES.map((x) => v.literal(x)));

const requestFields = {
  text: v.string(),
  title: v.optional(v.string()),
  cwd: v.optional(v.string()),
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  permissionMode: v.optional(v.string()),
  why: v.optional(v.string()),
};

const requestOut = v.object({
  // The row itself: a claim names it, so a request filed again under the
  // same id (after the first was swept) is never the one claimed.
  docId: v.string(),
  requestId: v.string(),
  runnerId: v.string(),
  runnerName: v.string(),
  threadId: v.string(),
  target: v.string(),
  ...requestFields,
  createdAt: v.number(),
  state: stateV,
  result: v.optional(v.object({ runnerId: v.string(), runnerName: v.string(), threadId: v.string() })),
  decidedAt: v.optional(v.number()),
  claim: v.optional(v.string()),
});

async function runnerNameOf(ctx: { db: any }, runnerId: string): Promise<string> {
  const r = await ctx.db.query('runners').withIndex('by_runnerId', (q: any) => q.eq('runnerId', runnerId)).unique();
  return (r?.name as string | undefined) || runnerId;
}

export const fileRequest = mutation({
  args: { key: v.string(), requestId: v.string(), threadId: v.string(), target: v.string(), request: v.object(requestFields) },
  returns: v.null(),
  handler: async (ctx, { key, requestId, threadId, target, request }) => {
    const caller = await runnerAuth(ctx, key, 'fileRequest');
    // The owner key starts threads anywhere itself; it never needs to ask.
    if (caller.owner) throw new ConvexError({ kind: 'badArgs', message: "The main Mac's runner starts threads on other runners itself." });
    const bad = (why: string) => new ConvexError({ kind: 'badArgs', message: why });
    if (!REQUEST_ID.test(requestId)) throw bad('a request id is 8 to 64 letters, digits or dashes');
    if (!request.text.trim()) throw bad('a new thread needs text');
    if (docBytes(request.text) > REQUEST_TEXT_MAX) throw bad(`the brief is over ${REQUEST_TEXT_MAX} bytes`);
    for (const f of ['title', 'cwd', 'model', 'effort', 'permissionMode', 'why'] as const) {
      if (request[f] !== undefined && docBytes(request[f]) > REQUEST_FIELD_MAX) throw bad(`${f} is too long`);
    }
    if (!target.trim() || docBytes(target) > 128) throw bad('name the runner to start it on');
    if (!isThreadId(threadId)) throw bad("that isn't a thread id");
    // Asked from one of its own threads, so the card and its answer are its own.
    const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
    if (!t || !mayTouch(caller, t.runnerId, threadId)) throw forbidden("ask for that: the thread isn't this runner's");
    if (await ctx.db.query('runnerRequests').withIndex('by_requestId', (q) => q.eq('requestId', requestId)).first()) throw bad('that request id is taken');
    const now = Date.now();
    // Oldest first: what's past a week goes, and then the oldest until
    // there's room, except one the main Mac is starting now.
    const rows = await ctx.db.query('runnerRequests').withIndex('by_runnerId', (q) => q.eq('runnerId', caller.runnerId)).take(REQUESTS_KEPT_MAX + 10);
    let kept = rows.length;
    for (const r of rows) {
      const old = now - r.createdAt > REQUEST_KEEP_MS;
      if (!old && kept < REQUESTS_KEPT_MAX) break;
      if (!old && r.state === 'claimed') continue;
      // A box makes room among its own thread's requests only.
      if (!ownThreadOnly(caller, r.threadId)) continue;
      await ctx.db.delete(r._id);
      kept--;
    }
    if (kept >= REQUESTS_KEPT_MAX) throw new ConvexError({ kind: 'tooMany', message: `A runner key may keep at most ${REQUESTS_KEPT_MAX} requests` });
    const waiting = await ctx.db.query('runnerRequests').withIndex('by_runner_state', (q) => q.eq('runnerId', caller.runnerId).eq('state', 'pending')).take(REQUESTS_KEPT_MAX);
    const pending = waiting.filter((r) => now - r.createdAt < PENDING_LIVE_MS).length;
    if (pending >= REQUESTS_PENDING_MAX) throw new ConvexError({ kind: 'tooMany', message: `A runner key may have at most ${REQUESTS_PENDING_MAX} requests waiting` });
    const made = await requestMachine.create(ctx, { requestId, runnerId: caller.runnerId, threadId, target, ...request, createdAt: now, state: 'pending' } as never, { type: 'FILE' });
    if (made.status !== 'done') throw new ConvexError({ kind: 'conflict', message: `the request couldn't be filed: ${made.reasons.join(' ')}` });
    return null;
  },
});

/** A request as it was filed, and how it went: the owner's (any) or the runner key's own. */
export const runnerRequest = query({
  args: { key: v.string(), requestId: v.string() },
  returns: v.union(v.null(), requestOut),
  handler: async (ctx, { key, requestId }) => {
    const caller = await runnerAuth(ctx, key, 'runnerRequest');
    const r = await ctx.db.query('runnerRequests').withIndex('by_requestId', (q) => q.eq('requestId', requestId)).first();
    if (!r || (!caller.owner && r.runnerId !== caller.runnerId) || !ownThreadOnly(caller, r.threadId)) return null;
    const { _id, _creationTime, requestState: _s, closeWhenHandedBack: _c, ...rest } = r;
    return { ...rest, docId: String(_id), runnerName: await runnerNameOf(ctx, r.runnerId) };
  },
});

// What the main Mac's runner may move a request to, from where, is the
// request machine's (requestMachine.ts): it claims one before starting it
// (so a retry, or another click, can't start a second), then marks it
// allowed with where it started; it hands a claim back only when starting
// failed here; it says no only to a pending one. Each `state` it asks for
// is that machine's event.
const EVENTS = { claimed: 'CLAIM', allowed: 'ALLOW', pending: 'HAND_BACK', denied: 'DENY' } as const;
const CLAIM = /^[A-Za-z0-9_-]{8,64}$/;
const CONFIRMATION_MS = 60_000;

/** Mike's answer, recorded by the main Mac's runner as it starts the thread (or he said no). */
export const decideRequest = mutation({
  args: {
    key: v.string(),
    requestId: v.string(),
    state: v.union(v.literal('claimed'), v.literal('allowed'), v.literal('pending'), v.literal('denied')),
    // The row as read (runnerRequest's docId): another row under this id isn't it.
    docId: v.string(),
    result: v.optional(v.object({ runnerId: v.string(), runnerName: v.string(), threadId: v.string() })),
    // API 85: with `claimed`, the runner's id for this claim. The same claim
    // asked again (its first answer was lost) is told yes, and nothing
    // changes; any other claim of a claimed request is refused, as before.
    claim: v.optional(v.string()),
    confirmation: v.optional(v.id('commands')),
  },
  returns: v.null(),
  handler: async (ctx, { key, requestId, state, docId, result, claim, confirmation }) => {
    await runnerAuth(ctx, key, 'decideRequest');
    if (claim !== undefined && !CLAIM.test(claim)) throw new ConvexError({ kind: 'badArgs', message: 'claim must be 8 to 64 letters, digits, - or _' });
    const r = await ctx.db.query('runnerRequests').withIndex('by_requestId', (q) => q.eq('requestId', requestId)).first();
    if (!r || String(r._id) !== docId) throw new ConvexError({ kind: 'notFound', message: 'no such request' });
    if (state === 'claimed') {
      const c = confirmation === undefined ? null : await ctx.db.get('commands', confirmation);
      const params = c?.args?.params as { approvalId?: unknown; docId?: unknown; claim?: unknown; release?: unknown } | undefined;
      if (claim === undefined || c?.commandState.kind !== 'done' || c.kind !== 'call' || c.result !== 'true'
        || c.runnerId !== r.runnerId || c.threadId !== r.threadId || c.args?.method !== 'requests.confirmStart'
        || params?.approvalId !== requestId || params.docId !== docId || params.claim !== claim || params.release === true
        || Date.now() - c.createdAt >= CONFIRMATION_MS) {
        throw new ConvexError({ kind: 'badArgs', message: 'Start it needs a fresh confirmation from the runner with the card. Update both runners and try again.' });
      }
    }
    if ((state === 'pending' || state === 'allowed') && claim !== undefined && r.claim !== claim) {
      throw new ConvexError({ kind: 'badArgs', message: 'That claim no longer holds the request.' });
    }
    if (steppingFor('requestState')) return await decideAsBefore(ctx, r, state, result, claim);
    if (state === 'allowed' && !result && r.state === 'claimed') throw new ConvexError({ kind: 'badArgs', message: 'an allowed request says where it started' });
    const type = EVENTS[state];
    const event = type === 'CLAIM' ? { type, ...(claim !== undefined ? { claim } : {}) } : type === 'ALLOW' ? { type, result: result ?? { runnerId: '', runnerName: '', threadId: '' } } : { type };
    // The same claim asking again stays claimed and is told yes; anything
    // the request's state doesn't take is refused as it always was.
    const r2 = await requestMachine.send(ctx, r._id, event);
    if (r2.status !== 'done') throw new ConvexError({ kind: 'badArgs', message: `that request is ${r.state}` });
    if (state === 'pending' && r.closeWhenHandedBack) await requestMachine.send(ctx, r._id, { type: 'CLOSE' });
    return null;
  },
});

/** The asking runner gave up on one of its own requests (its card closed without it starting). */
export const closeRequest = mutation({
  args: { key: v.string(), requestId: v.string(), afterConfirmation: v.optional(v.literal(true)) },
  returns: v.null(),
  handler: async (ctx, { key, requestId, afterConfirmation }) => {
    const caller = await runnerAuth(ctx, key, 'closeRequest');
    const r = await ctx.db.query('runnerRequests').withIndex('by_requestId', (q) => q.eq('requestId', requestId)).first();
    // The asking runner's alone: the owner key files none, and doesn't close
    // one of a runner with a live key of its own (lib.ts ownerFenced; Mike's
    // no is decideRequest's).
    if (!r || (!caller.owner && r.runnerId !== caller.runnerId) || !ownThreadOnly(caller, r.threadId) || (await ownerFenced(ctx, caller, r.runnerId))) throw new ConvexError({ kind: 'notFound', message: 'no such request' });
    // If Start it won locally, give its confirmation time to reach the
    // claim mutation. Once the proof is too old, we can close an unused row.
    if (!afterConfirmation) await closePendingRequest(ctx, r);
    else if (!r.closeWhenHandedBack && (r.state === 'pending' || r.state === 'claimed')) {
      await ctx.db.patch('runnerRequests', r._id, { closeWhenHandedBack: true });
      await ctx.scheduler.runAfter(CONFIRMATION_MS, internal.relay.closeAfterConfirmation, { docId: r._id });
    }
    return null;
  },
});

export const closeAfterConfirmation = internalMutation({
  args: { docId: v.id('runnerRequests') },
  returns: v.null(),
  handler: async (ctx, { docId }) => {
    const r = await ctx.db.get('runnerRequests', docId);
    if (r) await closePendingRequest(ctx, r);
    return null;
  },
});

async function closePendingRequest(ctx: MutationCtx, r: Doc<'runnerRequests'>): Promise<void> {
  if (r.state !== 'pending') return;
  if (steppingFor('requestState')) await asBefore(ctx, r, { state: 'closed', decidedAt: Date.now() });
  else await requestMachine.send(ctx, r._id, { type: 'CLOSE' });
}

// While the deploy's stepping stone has the machine off (stepping.ts), the
// main Mac's answer and the asking runner's close go through the way they
// did before it: a thread already started whose `allowed` was refused would
// otherwise leave its request claimed. The machine has never run on this
// deployment then, so the old fields are the request's whole story; a row
// the backfill has already reached gets its requestState again from them.
const MOVES_BEFORE: Record<string, string[]> = { claimed: ['pending'], allowed: ['claimed'], pending: ['claimed'], denied: ['pending'] };
async function decideAsBefore(ctx: MutationCtx, r: Doc<'runnerRequests'>, state: 'claimed' | 'allowed' | 'pending' | 'denied', result: Doc<'runnerRequests'>['result'], claim: string | undefined): Promise<null> {
  if (state === 'claimed' && r.state === 'claimed' && claim !== undefined && r.claim === claim) return null;
  if (!MOVES_BEFORE[state]!.includes(r.state)) throw new ConvexError({ kind: 'badArgs', message: `that request is ${r.state}` });
  if (state === 'allowed' && !result) throw new ConvexError({ kind: 'badArgs', message: 'an allowed request says where it started' });
  const next = state === 'pending' && r.closeWhenHandedBack ? 'closed' : state;
  await asBefore(ctx, r, { state: next, ...(state === 'allowed' && result ? { result } : {}), ...(state === 'claimed' ? { claim } : state === 'pending' ? { claim: undefined } : {}), decidedAt: Date.now() });
  return null;
}

async function asBefore(ctx: MutationCtx, r: Doc<'runnerRequests'>, fields: Partial<Doc<'runnerRequests'>>): Promise<void> {
  const backfilled = (r as Partial<Doc<'runnerRequests'>>).requestState !== undefined;
  await ctx.db.patch(r._id, { ...fields, ...(backfilled ? { requestState: requestStateFrom({ ...r, ...fields }) } : {}) });
}
