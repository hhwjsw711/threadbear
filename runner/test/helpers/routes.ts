// One thread, read three ways, to check they agree (scenarios.test.ts):
//
//   here    this runner's own events and summary, as the Mac app reads them
//   relay   another runner's thread from the Mac, through Convex (relay.ts)
//   phone   the iPhone app and the website, through Convex (convex/phone.ts)
//
// A real Runner with a fake CLI plays the thread. Its real ConvexSync writes
// it through the backend's real functions into the in-memory Convex
// (convex-memory.ts, which checks validators and the schema as a deployment
// does), and the relay and the phone read it back through theirs. So a field
// that one copy along the way drops (the schema, the phone's ask, the relay's
// rebuild of a card) shows as the routes disagreeing, not as a bug on Alex's
// backend. Nothing here touches the network or a model, so it's as quick and
// steady as a unit test.
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from './fakes.ts';
import { call, load, memoryBackend } from './convex-memory.ts';
import { ConvexSync } from '../../src/sync.ts';
import { Relay } from '../../src/relay.ts';
import { nullLogger } from '../../src/log.ts';
import { isPlaceNote } from '../../src/place-notes.ts';
import type { Ask, ImageRef, LabReviewLedger } from '../../src/protocol.ts';
import type { Post, Upload } from '../../src/sync.ts';

const OWNER = 'owner-key';
const TOKEN = 'phone-token';
const RUNNER = 'mini0000001';
const END_TURN = 'mcp__threadbear__end_turn';

// What a person sees of a thread, on any of the three: its card and its messages.
export type View = {
  coordinatorProjectId?: string;
  unread: boolean;
  needs?: string;
  asks: Ask[];
  next: string[];
  nextPick?: string;
  nextSuggested?: number;
  // The done card's loose ends, as their words.
  looseEnds: string[];
  // Review by another lab's ledger on the last turn's card.
  review?: unknown;
  // Plan first plans drawn as plan cards, "<first line> (waiting|go|revise)".
  plans: string[];
  messages: { role: 'user' | 'assistant'; text: string; pictures: number; origin?: string }[];
  // The lines saying the thread's login ran out and what it did about it
  // ("Moved to ...", "... Carrying on at ..."), which the Mac keeps on show.
  notes: string[];
  // Whether the last turn failed (the Mac's failed card, the website's
  // "The last turn failed"): a signed-out login on bruce read as an empty
  // reply on this Mac (canary, 13 Nov).
  failed: boolean;
  // What it's waiting on (docs/protocol/needs-you.md, "Wait state"): the
  // section, badge and order every app draws it with.
  waitState?: string;
};

export type Play = {
  /** Supply the coordinator summary hint; its service lifecycle has tests of its own. */
  coordinate(projectId: string): void;
  /** Reading a coordinator settles unread, while its open questions remain. */
  read(): void;
  /** The agent writes text. */
  say(text: string): void;
  /** The agent calls end_turn with these args, and the turn ends. */
  endTurn(input: Record<string, unknown>, answerAll?: true, carriesPreviousAsk?: true): void;
  /** Alex sends a message, with pictures (paths of real files) if any. */
  send(text: string, images?: ImageRef[]): void;
  /** Alex sends from his phone, so every surface can mark where it came from. */
  sendFromPhone(text: string): void;
  /** A reminder left in a busy thread's queue by an older runner. */
  queuedReminder(text: string, scheduleId: string): void;
  /** Alex presses Go ahead on the last plan (plans.approve). */
  approvePlan(): void;
  /** The agent puts a Plan first plan to Alex (plan.proposed). */
  proposePlan(text: string): void;
  /** Turns on the done card's loose ends, with a check-in booked for this thread. */
  looseEnds(checkIn: { title: string; at: string }): void;
  /** A review by another lab has given this ledger's findings to the
   * agent (runner/lab-review.ts), so the next end_turn answers them. */
  reviewed(ledger: LabReviewLedger): void;
  /** The turn fails with this error (a signed-out login, an overloaded API). */
  fail(error: string): void;
  /** Stop before the model received any tokens. */
  earlyStop(): void;
  /** The runner stops this turn while handing a coordinator to a new release. */
  stopForHandover(): Promise<void>;
  /** The thread's login ran out and the runner moved it to another (runner/pools.ts moveLogin). */
  loginMoved(): void;
  /** The quiet inbox archives the finished thread, as Opus guessed it a skip (runner/inbox-guess.ts quietArchive, experiment quietInboxMine). */
  quietlyArchived(why: string): void;
  /** Alex brings it back with "Should have shown me" (threads.update's unarchive verdict). */
  shouldHaveShown(): void;
};

export async function threeWays(play: (p: Play) => void | Promise<void>) {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  const mods: Record<string, Record<string, any>> = { sync: load('sync'), relay: load('relay'), phone: load('phone') };
  const refused: string[] = [];
  // One function at a time, as a deployment runs them: each is a
  // transaction there, and here two interleaved at their awaits could both
  // find a row missing and both write it. The runner now syncs while the
  // thread plays (playInto), so its flushes can overlap.
  let last: Promise<unknown> = Promise.resolve();
  const post = (_kind: string, fn: string, args: Record<string, unknown>) => {
    const [m, name] = fn.split(':');
    const f = mods[m!]?.[name!];
    const run = last.then(async () => {
      if (!f) throw new Error(`routes: no backend function ${fn}`);
      try {
        return await call(b.ctx, f, args);
      } catch (e) {
        // The runner retries or skips what fails; the scenario says so.
        refused.push(`${fn}: ${String((e as Error)?.message ?? e)}`);
        throw e;
      }
    });
    last = run.catch(() => {});
    return run;
  };
  // File storage: what the runner uploads is kept, so the backend has a URL
  // for it (convex-memory.ts getUrl) and another Mac's runner can fetch it by that.
  const stored = new Map<string, Uint8Array>();
  const upload: Upload = async (_url, bytes) => {
    const id = b.file(`st${stored.size + 1}`);
    stored.set(id, bytes);
    return id;
  };
  const download = async (url: string) => {
    const bytes = stored.get(url.replace('https://files.example/', ''));
    if (!bytes) throw new Error(`routes: nothing stored at ${url}`);
    return bytes;
  };
  const { h, sync, ids } = await playInto(post as never, { key: OWNER, runnerId: RUNNER, name: 'mac-mini' }, [play], upload);
  const thread = { id: ids[0]! };

  const id = thread.id;
  const at = new Date(h.clock.now()).toISOString();
  const remote = () => ({ runners: [{ id: RUNNER, name: 'mac-mini', online: true, lastSeenAt: at }], threads: [{ runnerId: RUNNER, threadId: id, title: 't', cwd: '/x', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: true, preview: '', createdAt: at, lastActivityAt: at }] });
  const relay = new Relay({
    source: () => ({ key: OWNER, post: post as never, apiVersion: 999, download }),
    remote,
    subscribed: () => false,
    publish: () => {},
    clock: h.clock,
    log: nullLogger,
  });
  const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
  await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'iphone', kind: 'phone', expiresAt: Date.now() + 1e9, createdAt: Date.now() });

  const here = (): View => {
    const t = h.runner.get(id);
    const events = h.runner.events(id, {}).events as Record<string, any>[];
    const end = events.filter((e) => e.type === 'turn.completed').at(-1);
    return { coordinatorProjectId: t.coordinatorProjectId, unread: t.lastSeq > t.lastSeenSeq, needs: t.needs, asks: (t.asks ?? []) as Ask[], next: lastNext(events), nextPick: end?.nextPick, nextSuggested: end?.nextSuggested, looseEnds: (t.looseEnds?.ends ?? []).map((e) => e.text), review: end?.review, plans: plansOf(events), messages: messagesOf(events), notes: loginNotes(events), failed: lastFailed(events), waitState: t.waitState };
  };
  let relayEvents: Record<string, any>[] = [];
  const viaRelay = async (): Promise<View> => {
    // A turn's end is held back until that runner's row has said so for 4 s.
    await relay.call(id, 'threads.events', { threadId: id });
    h.clock.advance(5000);
    const { events } = (await relay.call(id, 'threads.events', { threadId: id })) as { events: Record<string, any>[] };
    relayEvents = events;
    const end = events.filter((e) => e.type === 'turn.completed').at(-1);
    // The loose ends as the app gets them: on the thread's row in the
    // sidebar's list, for the done card's own seq.
    const listed = relay.overlay(remote()).threads.find((t) => t.threadId === id) as { looseEnds?: { seq: number; ends: { text: string }[] } } | undefined;
    const ends = listed?.looseEnds && end && listed.looseEnds.seq === end.seq ? listed.looseEnds.ends.map((e) => e.text) : [];
    // The state as another Mac's sidebar has it: the thread's index row.
    const indexed = ((await b.ctx.db.query('threadIndex').collect()) as unknown as { threadId: string; waitState?: string; coordinatorProjectId?: string; unread?: boolean }[]).find((r) => r.threadId === id);
    return { coordinatorProjectId: indexed?.coordinatorProjectId, unread: indexed?.unread ?? false, needs: end?.needs, asks: (end?.asks ?? []) as Ask[], next: (end?.next ?? []) as string[], nextPick: end?.nextPick, nextSuggested: end?.nextSuggested, looseEnds: ends, review: end?.review, plans: plansOf(events), messages: messagesOf(events), notes: loginNotes(events), failed: lastFailed(events), waitState: indexed?.waitState };
  };
  const viaPhone = async (): Promise<View> => {
    const r = (await call(b.ctx, mods.phone.thread!, { token: TOKEN, threadId: id })) as { thread: Record<string, any>; messages: { role: 'user' | 'assistant'; text: string; origin?: string }[] };
    const page = await call(b.ctx, mods.phone.messages!, { token: TOKEN, threadId: id, notes: true }) as { messages: { role: string; text: string; plan?: boolean; planDecision?: string }[] };
    return { coordinatorProjectId: r.thread.coordinatorProjectId, unread: r.thread.unread, needs: r.thread.needs, asks: (r.thread.asks ?? []) as Ask[], next: (r.thread.next ?? []) as string[], nextPick: r.thread.nextPick, nextSuggested: r.thread.nextSuggested, looseEnds: ((r.thread.looseEnds ?? []) as { text: string }[]).map((e) => e.text), review: r.thread.review, plans: page.messages.filter((m) => m.plan).map((m) => `${m.text.split('\n')[0]} (${m.planDecision ?? 'waiting'})`), messages: r.messages.map((m) => ({ role: m.role, text: m.text, pictures: 0, ...(m.origin ? { origin: m.origin } : {}) })), notes: page.messages.filter(m => m.role === 'note').map(m => m.text), failed: r.thread.status === 'error', waitState: r.thread.waitState };
  };
  const views = { here: here(), relay: await viaRelay(), phone: await viaPhone() };
  await sync.stop();
  return { views, refused, backend: b, threadId: id, runnerId: RUNNER, relay, relayEvents };
}

// Without a subscriber of its own a ConvexSync opens a real Convex client for its url, and
// x.convex.cloud is a real host: it accepts the websocket, sends back a FatalError ("Couldn't
// parse deployment name x") and the client throws that into whichever test is running, which
// made this file flaky on GitHub's runners. The client is made when the thread index starts
// watching the other runners' threads. Writes go through `post`, so nothing here needs that watch.
const NO_SUBSCRIBER = { subscribe: () => () => undefined, close: () => undefined };

/**
 * Plays each of `plays` as a thread on one Runner with a fake CLI, and
 * writes them all through `post` with that runner's real ConvexSync: the
 * in-memory backend here, or a real one (scripts/parity-seed.ts). Returns
 * the threads' ids in order; the caller stops `sync`.
 */
export async function playInto(post: Post, runner: { key: string; runnerId: string; name: string }, plays: ((p: Play) => void | Promise<void>)[], upload: Upload = async () => 'st') {
  const h = makeHarness();
  const sync = new ConvexSync({ config: { enabled: true, url: 'https://x.convex.cloud', name: runner.name, runnerId: runner.runnerId }, key: runner.key, home: h.cfg.home, runner: h.runner, version: '0.1.0+test', release: 'rel1', startedAt: '2026-10-27T00:00:00.000Z', clock: h.clock, log: nullLogger, post, upload, subscriber: NO_SUBSCRIBER } as never);
  const ids: string[] = [];
  // Running before the threads play, as on a real runner: a message's
  // pasted pictures go up only as it's sent, never from the log afterwards
  // (share-images.ts pastedImagesInEvent), and only once the backend has
  // said its version.
  sync.start();
  await sync.flushNow();
  for (const play of plays) {
    const { thread } = h.runner.create({ text: 'Start', accountId: 'claude-3' });
    ids.push(thread.id);
    const s = h.adapter.last;
    s.init();
    let n = 0;
    let lastPlan = '';
    await play({
      coordinate: (projectId) => {
        const summarize = h.runner.summary.bind(h.runner);
        h.runner.summary = (st) => {
          const summary = summarize(st);
          return summary.id === thread.id ? { ...summary, coordinatorProjectId: projectId } : summary;
        };
      },
      read: () => { h.runner.markSeen(thread.id, h.runner.get(thread.id).lastSeq); },
      say: (text) => s.text(`m${++n}`, text),
      proposePlan: (text) => {
        lastPlan = `p${++n}`;
        s.out({ kind: 'planProposed', itemId: lastPlan, text });
      },
      approvePlan: () => {
        h.runner.approvePlan({ threadId: thread.id, itemId: lastPlan });
        h.adapter.last.init();
      },
      endTurn: (input, answerAll, carriesPreviousAsk) => {
        const id = `e${++n}`;
        s.out({ kind: 'event', event: { type: 'tool.call', itemId: id, name: END_TURN, kind: 'mcp', title: 'threadbear: end_turn', input } });
        s.out({ kind: 'event', event: { type: 'tool.result', itemId: id, ok: true, text: 'ok', truncated: false, images: [] } });
        const answered = [...(h.runner.mustGet(thread.id).rt.turn?.messages ?? [])];
        // Coordinator lifecycle is covered in coordinators.test.ts. Let the
        // route test replay what the real coordinator adds to this event.
        const emit = h.runner.emit.bind(h.runner);
        const seq = carriesPreviousAsk ? h.runner.get(thread.id).asksSeq : undefined;
        if (seq) h.runner.emit = (st, body, turnId) => {
          if (st.rec.id === thread.id && body.type === 'turn.completed') body.carriedAsks = { seq };
          return emit(st, body, turnId);
        };
        try { s.result('completed', undefined, undefined, answerAll ? { answered } : {}); }
        finally { if (seq) h.runner.emit = emit; }
      },
      fail: (error) => s.result('failed', undefined, error),
      earlyStop: () => {
        h.runner.interrupt(thread.id, { byMike: true });
        s.result('interrupted', 0, undefined, { usage: { inputTokens: 0, outputTokens: 0 }, queuedTurns: 0 });
      },
      stopForHandover: () => h.runner.stopThreadForHandover(h.runner.mustGet(thread.id)),
      loginMoved: () => {
        const st = h.runner.threads.get(thread.id)!;
        h.runner.moveLogin(st, { id: 'claude-1', title: 'alex@example.org', provider: 'claude' } as never, 'alex@example.net hit its 5-hour limit, back at 11:30 am');
      },
      send: (text, images = []) => {
        h.runner.send(thread.id, text, images, {});
        h.adapter.last.init();
      },
      sendFromPhone: (text) => {
        h.runner.send(thread.id, text, [], { origin: 'phone' });
        h.adapter.last.init();
      },
      quietlyArchived: (why) => {
        fs.writeFileSync(path.join(h.cfg.home, 'runner.json'), JSON.stringify({ experiments: { quietInboxMine: true } }));
        const st = h.runner.threads.get(thread.id)!;
        const seq = h.runner.looseEndsCard(st);
        if (seq === undefined) throw new Error('quietlyArchived: the thread has no done card');
        h.runner.quietArchive(st, seq, [{ by: 'claude-opus-5-5', skip: true, why, strong: true }]);
      },
      shouldHaveShown: () => {
        h.runner.update({ threadId: thread.id, archived: false, verdict: 'shouldHaveShown' });
      },
      queuedReminder: (text, scheduleId) => {
        h.runner.send(thread.id, text, [], { origin: 'schedule', scheduleId, queue: true });
      },
      reviewed: (ledger) => {
        h.runner.threads.get(thread.id)!.rec.labReview = { ...ledger, delivered: ledger.rounds };
      },
      looseEnds: (checkIn) => {
        const mine = thread.id;
        const others = h.runner.schedulesFor;
        h.runner.schedulesFor = (t) => (t === mine ? [{ id: `s-${mine}`, title: checkIn.title, text: '', whenText: '', paused: false, createdAt: '', updatedAt: '', runs: 0, threadId: t, nextRunAt: checkIn.at }] : (others?.(t) ?? []));
      },
    });
  }
  // The loose ends check runs after the turn ends, off the turn's path.
  for (const id of ids) {
    const end = Date.now() + 2000;
    while (h.runner.threads.get(id)?.rec.needs?.needs === 'nothing' && !h.runner.get(id).looseEnds && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  }
  await sync.flushNow();
  await sync.flushNow();
  // The sidebar's index (thread-index.ts), which another runner lists the
  // threads from, writes on a timer of its own; the fake clock only moves
  // when told.
  for (let i = 0; i < 5; i++) {
    h.clock.advance(1500);
    await new Promise((r) => setTimeout(r, 20));
  }
  return { h, sync, ids };
}

// The Plan first plans drawn as plan cards (plan.proposed), and whether
// each is still waiting, went ahead or was sent back (plan.resolved).
function plansOf(events: Record<string, any>[]): string[] {
  return events
    .filter((e) => e.type === 'plan.proposed')
    .map((p) => {
      const r = events.find((e) => e.type === 'plan.resolved' && e.itemId === p.itemId);
      return `${String(p.text).split('\n')[0]} (${r ? r.decision : 'waiting'})`;
    });
}

// The notes that go up to the backend (a login's, a saved message's, and a
// move to or from Hibernating or the archive), as their words.
function loginNotes(events: Record<string, any>[]): string[] {
  return events.filter((e) => e.type === 'system.note' && (e.login === true || e.savedMessage === true || isPlaceNote(String(e.text)))).map((e) => String(e.text));
}

function lastFailed(events: Record<string, any>[]): boolean {
  return events.filter((e) => e.type === 'turn.completed').at(-1)?.outcome === 'failed';
}

// The done card's follow-ups: the last turn's end.
function lastNext(events: Record<string, any>[]): string[] {
  return (events.filter((e) => e.type === 'turn.completed').at(-1)?.next ?? []) as string[];
}

// Alex's messages and the agent's text, in order; tool rows left out. A
// plan is the agent's words too: the Mac draws it as its plan card, the
// phone as its own (API 72), another Mac as a reply.
function messagesOf(events: Record<string, any>[]): View['messages'] {
  return events
    .filter((e) => e.type === 'user.message' || e.type === 'assistant.text' || e.type === 'plan.proposed')
    .map((e) => ({ role: e.type === 'user.message' ? ('user' as const) : ('assistant' as const), text: String(e.text ?? ''), pictures: Array.isArray(e.images) ? e.images.length : 0, ...(e.origin ? { origin: String(e.origin) } : {}) }));
}
