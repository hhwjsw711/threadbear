// Handovers: draining this runner after a new release takes over, and adopting threads from the old one (docs/protocol/updates.md, "Handovers").
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import { neutraliseCopied, realCopy } from '../real-copy.ts';
import { openCardEvents } from '../open-cards.ts';
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { PersistedEvent, ThreadSummary } from '../protocol.ts';
import { ErrorCode, RpcError } from '../protocol.ts';
import type { ThreadRecord } from '../store.ts';
import type { Drain, ThreadState } from '../runner.ts';
import { DRAIN_AGENT_MS, DRAIN_BACKGROUND_MS, DRAIN_CARD_WAIT_MS, DRAIN_CHECK_MS, DRAIN_MAX_OLD_MS, DRAIN_SETTLE_MS } from './timings.ts';
import { newRuntime } from './runtime.ts';
import { runningSession } from '../cli-session.ts';

// Runner.openCards: events read from a log at once, kept small as each
// chunk is read and parsed in one go on a runner still running turns, and
// how long it reads before giving up: the primary has stopped waiting by
// then (handover.ts OPEN_CARDS_DEADLINE_MS, 5 s).
const OPEN_CARDS_CHUNK = 1_000;
export const OPEN_CARDS_SCAN_MS = 6_000;

// How long a handover waits for an archive's worktree cleanup (letGo).
// Removing a big worktree can take a while, and a git change still running
// when the wait ends can't be stopped (cleanUpWorktree's stillOurs only
// stops the next one), so this is long: past it, git has hung.
const CLEANUP_WAIT_MS = 10 * 60_000;

// What the agent is told on the new runner when its cards lapsed (lapseCards).
export function lapsedCardsMessage(titles: string[]): string {
  const one = titles.length === 1;
  return [
    `Threadbear updated while ${one ? 'this request of yours' : 'these requests of yours'} waited for an answer, so ${one ? 'it' : 'they'} lapsed unanswered and your turn was stopped:`,
    '',
    ...titles.map((t) => `- ${t}`),
    '',
    `Carry on where you left off, and ask again if you still need ${one ? 'it' : 'them'}.`,
  ].join('\n');
}

export const handoversPart = {
  // This runner is handing over to a new release. `keep` are the busy
  // threads it goes on running; every other thread is let go now (an idle
  // CLI exits, and the new runner resumes it by session id). Resolves once
  // those CLIs have gone, so the new runner never resumes a session beside
  // its old CLI. Each kept thread is let go in turn once nothing would be
  // cut short, and onHandedOver hears its id after its thread.json is saved.
  //
  // `ready` says whether the new runner is there to hear about one (it has
  // connected); until it is, threads stay here, and recheckHandovers() looks
  // again once it does.
  async beginDrain(this: Runner, keep: Iterable<string>, opts: { onHandedOver: (threadId: string) => void; backgroundMs?: number; agentMs?: number; checkMs?: number; cardMs?: number; ready?: () => boolean }): Promise<void> {
    if (this.draining) throw new Error('already draining');
    const d: Drain = {
      // A thread whose worktree cleanup is running stays until it's done
      // (letGo), as a busy one would, so the rest go now rather than wait.
      // So does one with a turn-end hook running: the restarter doesn't
      // count that as busy, but its result may start a turn, and an archive
      // waiting for it (archiveWhenGone) isn't saved anywhere to pick up.
      // And one hibernating in words whose model is still working out when
      // (readyToHandOver): the new runner would wake it. And one going back
      // to an earlier message: letting it go mid-edit saved the record from
      // before the cut, after the files had been put back (13 Nov 2026).
      keep: new Set([...keep, ...[...this.threads.values()].filter((st) => st.rt.cleaning !== undefined || st.rt.preparing !== undefined || st.rt.hooksRunning || st.rt.editing || st.rec.wakeWhen?.pending).map((st) => st.rec.id)].filter((id) => this.threads.has(id))),
      going: new Set(),
      gone: new Set(),
      onHandedOver: opts.onHandedOver,
      since: this.clock.now(),
      backgroundMs: opts.backgroundMs ?? DRAIN_BACKGROUND_MS,
      agentMs: opts.agentMs ?? DRAIN_AGENT_MS,
      checkMs: opts.checkMs ?? DRAIN_CHECK_MS,
      checkQueued: false,
      ready: opts.ready ?? (() => true),
      cardsSince: new Map(),
      lapsed: new Map(),
      cardMs: opts.cardMs ?? DRAIN_CARD_WAIT_MS,
    };
    this.draining = d;
    // New threads start on the new runner, so a CLI started ahead of one here
    // would never be used.
    this.dropSpare('handing over');
    // Accounts are the primary's to watch now, their limits too: a recheck
    // here would start a CLI beside the primary's, and its reading would
    // reach the primary's store past the primary's own ranDry rules.
    this.rescanTimer?.cancel();
    this.accountsTimer?.cancel();
    this.stopLimitRecheck();
    await Promise.all([...this.threads.values()].filter((st) => !d.keep.has(st.rec.id)).map((st) => this.letGo(st)));
    this.log.info('let go of the idle threads', { keeps: [...d.keep] });
    this.checkHandovers();
  },

  // The threads a draining runner still has; undefined when not draining.
  keeping(this: Runner): string[] | undefined {
    return this.draining ? [...this.draining.keep] : undefined;
  },

  // drain.openCards: the cards still open on one thread a draining runner
  // keeps, read from its own log here, so only those few events cross to
  // the primary rather than the log (THREADBEAR-1Z, Peers.openCards). One
  // thread a call, so a long log costs only its own thread, and each answer
  // is that thread's cards alone. A chunk at a time with a break between,
  // as this runner is still running those threads' turns.
  async openCards(this: Runner, threadId: string, opts: { chunk?: number; scanMs?: number } = {}): Promise<PersistedEvent[]> {
    const chunk = opts.chunk ?? OPEN_CARDS_CHUNK;
    const until = Date.now() + (opts.scanMs ?? OPEN_CARDS_SCAN_MS);
    if (!this.draining?.keep.has(threadId) || !this.threads.has(threadId)) throw new RpcError(ErrorCode.moved, 'This runner has handed that thread over to the new one.');
    const log = this.store.log(threadId);
    const last = log.lastSeq;
    // Only the requests still open as it goes, oldest first (openCardEvents
    // over the whole log), not every one the log has had.
    const open = new Map<string, PersistedEvent>();
    for (let from = 1; from <= last; from += chunk) {
      if (Date.now() > until) throw new RpcError(ErrorCode.busy, 'Out of time reading the thread\'s open cards.');
      for (const e of log.read(from, Math.min(last, from + chunk - 1))) {
        if (e.type === 'approval.resolved') open.delete(e.approvalId);
        else if (openCardEvents([e]).length) open.set((e as { approvalId: string }).approvalId, e);
      }
      await new Promise((r) => setImmediate(r));
    }
    return [...open.values()];
  },

  // Whether this runner has the thread (a draining one lets them go).
  has(this: Runner, threadId: string): boolean {
    return this.threads.has(threadId);
  },

  recheckHandovers(this: Runner): void {
    this.queueHandoverCheck();
  },

  queueHandoverCheck(this: Runner): void {
    const d = this.draining;
    if (!d || d.checkQueued) return;
    d.checkQueued = true;
    this.defer(() => {
      d.checkQueued = false;
      this.checkHandovers();
    });
  },

  checkHandovers(this: Runner): void {
    const d = this.draining;
    if (!d || this.stopping) return;
    d.timer?.cancel();
    d.timer = undefined;
    for (const id of d.ready() ? [...d.keep] : []) {
      const st = this.threads.get(id);
      if (!st) {
        // Deleted while kept.
        d.keep.delete(id);
        continue;
      }
      if (d.going.has(id) || this.lapseCards(st, d) || !this.readyToHandOver(st, d)) continue;
      d.going.add(id);
      const lapsed = d.lapsed.get(id);
      d.lapsed.delete(id);
      // Queued while it's going: it moves across with the thread (kickQueue).
      if (lapsed) this.sendTo(st, lapsedCardsMessage(lapsed), [], { origin: 'runner', queue: true, wakeReason: 'A request lapsed during an update' });
      void this.letGo(st).then(
        () => {
          d.going.delete(id);
          d.keep.delete(id);
          this.log.info('handed a thread over', { threadId: id, left: d.keep.size });
          d.onHandedOver(id);
        },
        (e: unknown) => {
          d.going.delete(id);
          this.log.error('could not hand a thread over', { threadId: id, error: String(e) });
        },
      );
    }
    // Background work's limit, or a card's, passes without anything else happening.
    if (d.keep.size > d.going.size) d.timer = this.clock.setTimeout(() => this.checkHandovers(), d.checkMs);
  },

  // A kept thread that has waited only on open cards for cardMs: the cards
  // lapse (closed as expired, so no app offers them and a late answer is
  // refused as no longer pending), its turn is stopped, and a message from
  // the runner queued behind it goes across with it and starts there, so
  // the agent asks again on the new release. True when it lapsed them; the
  // thread goes across once the turn has ended (background work then holds
  // it only for its own limits).
  lapseCards(this: Runner, st: ThreadState, d: Drain): boolean {
    const { rec, rt } = st;
    if (rt.approvals.size === 0) return false;
    // Start it won on this runner. Let the request hear the result or hit
    // its own timeout, instead of telling the agent to ask again.
    if ([...rt.approvals.values()].some((p) => p.kind === 'request' && p.start.phase === 'authorized')) return false;
    const now = this.clock.now();
    // Something else going (a hook, an action, an edit, setup, wake grace):
    // the wait counts again from when it ends (Codex's review, 27 Nov 2026).
    // Background work doesn't stop the count: a subagent waiting on its own
    // card is a task too, and the work keeps its own limits once across.
    const busy = rt.hooksRunning || rt.runningActions?.size || rt.editing || rt.preparing || rt.wakeTimer;
    for (const id of rt.approvals.keys()) if (busy || !d.cardsSince.has(id)) d.cardsSince.set(id, now);
    if (busy) return false;
    // The oldest card decides, so new ones coming and going can't hold an
    // old one open for good; they all lapse together.
    if (Math.min(...[...rt.approvals.keys()].map((id) => d.cardsSince.get(id)!)) > now - d.cardMs) return false;
    const pending = [...rt.approvals.values()];
    const titles = pending.map((p) => ('title' in p ? p.title : undefined) ?? (p.kind === 'secret' ? 'a secret' : p.kind === 'request' ? 'a request' : 'an approval'));
    for (const id of rt.approvals.keys()) d.cardsSince.delete(id);
    const minutes = Math.round(d.cardMs / 60_000);
    // A saved message of Mike's that a stop left unread goes first, so the
    // runner's message waits for his next one (kickQueue).
    const asksAgain = !rec.interruptedMessages?.length;
    this.emit(st, { type: 'system.note', text: `Threadbear updated while this waited ${minutes} minutes for an answer, so ${titles.length === 1 ? 'the request' : 'its requests'} lapsed${asksAgain ? ' and the agent will ask again on the new release' : '; write to it to carry on'}: ${titles.join('; ')}.` }, rt.turn?.turnId);
    this.expireApprovals(st, 'It lapsed while Threadbear updated.');
    // Stopped only when it was the turn's own card the turn waited on: a
    // subagent's card lapsing leaves a working turn alone.
    if (rt.turn && pending.some((p) => p.main)) this.interrupt(rec.id);
    // Sent as it goes across (checkHandovers), so it starts on the new
    // runner: sent now, background work holding the thread would start it
    // here (kickQueue), where it could ask and lapse again.
    d.lapsed.set(rec.id, titles);
    this.log.info('lapsed the open cards of a kept thread', { threadId: rec.id, cards: titles.length });
    return true;
  },

  // Nothing would be cut short by letting it go now: no turn, approval or
  // question, wake grace, turn-end hook or action. Queued messages go with
  // it. Background shells and monitors hold it for backgroundMs after its
  // last turn (a dev server never ends), or DRAIN_SETTLE_MS once it has
  // been here DRAIN_MAX_OLD_MS, and are then stopped with a note, and the thread told
  // on the new runner. Subagents hold it for agentMs: they
  // finish by themselves, and stopping one throws away its work (27 Oct: a
  // builder agent an agent left running was cut off after 30 minutes).
  readyToHandOver(this: Runner, st: ThreadState, d: Drain): boolean {
    const { rt } = st;
    // A new worktree still being made or set up (Stop pressed during it):
    // the next runner would start its CLI before the setup is done.
    if (rt.turn || rt.approvals.size || rt.wakeTimer || rt.hooksRunning || rt.runningActions?.size || rt.editing || rt.preparing) return false;
    // Hibernating in words: its model is still working out when. Crossing
    // now, the new runner would wake it (wakesOnStart) and this one's answer
    // would go nowhere. Not past DRAIN_MAX_OLD_MS, as for background work.
    if (st.rec.wakeWhen?.pending && this.clock.now() - d.since < DRAIN_MAX_OLD_MS) return false;
    if (rt.tasks.length === 0) return true;
    const idleFor = this.clock.now() - rt.activeAt;
    if (rt.tasks.some((t) => t.kind === 'agent')) return idleFor >= d.agentMs;
    if (this.clock.now() - d.since >= DRAIN_MAX_OLD_MS && idleFor >= DRAIN_SETTLE_MS) return true;
    return idleFor >= d.backgroundMs;
  },

  // Lets go of a thread for good: its CLI exits (background work, if any,
  // is stopped with a note), its record is saved, and anything the old CLI
  // still reports goes nowhere.
  async letGo(this: Runner, st: ThreadState): Promise<void> {
    const { rt, rec } = st;
    const hadSession = runningSession(rt);
    const hadCleanup = Boolean(rt.cleaning);
    rt.idleTimer?.cancel();
    rt.idleTimer = undefined;
    this.flushDeltas(st);
    if (hadSession) {
      this.rememberStoppedWork(st);
      this.releaseSession(st);
    }
    if (rt.closing) await rt.closing;
    // An archive's worktree cleanup, started as the CLI went: its removedAt
    // and note belong in the record saved below (THREADBEAR-16). Not for
    // ever, as git can hang (a hook): past the limit the record goes as it
    // is, and the adopting runner settles it (settleLostCleanups).
    if (rt.cleaning) {
      let timer: { cancel(): void } | undefined;
      const late = new Promise<void>((resolve) => (timer = this.clock.setTimeout(resolve, CLEANUP_WAIT_MS)));
      const finished = await Promise.race([rt.cleaning.then(() => true), late.then(() => false)]);
      timer?.cancel();
      if (!finished) this.log.warn('handed a thread over before its worktree cleanup finished', { threadId: rec.id });
    }
    // Deleted while it waited: its folder has gone to trash, and saving
    // would bring it back.
    if (rt.deleted) return;
    rt.deltaTimer?.cancel();
    rt.wakeTimer?.cancel();
    this.cli(st, { kind: 'drop', forget: false });
    if (this.dirty.has(rec.id) || !rec.archivedAt || hadSession || hadCleanup || this.store.hasLog(rec.id)) {
      this.store.saveIfChanged(rec);
    }
    rt.deleted = true;
    this.dirty.delete(rec.id);
    this.threads.delete(rec.id);
    this.draining?.gone.add(rec.id);
    this.store.forget(rec.id);
  },

  // Loads a thread a draining runner has handed over and carries on with
  // it: messages queued while it was busy there start now. `crashed`: the
  // draining runner died with it, so it's recovered as after a crash (a
  // turn in flight ends as stopped).
  adopt(this: Runner, threadId: string, opts: { crashed?: boolean } = {}): ThreadSummary | undefined {
    const had = this.threads.get(threadId);
    if (had) return this.summary(had);
    // A box takes in no thread but its own (box-mode.ts).
    if (this.boxThread !== undefined && threadId !== this.boxThread) {
      this.log.warn("box: won't take in a thread that isn't its own", { threadId });
      return undefined;
    }
    // A thread handed over while this runner is still connecting to the old
    // one comes before start: which worktrees are held is worked out first,
    // from every thread on disk, and before this one's record, if it can't
    // be read, is rebuilt without its worktree (Muse's review, 11 Nov 2026).
    if (!this.unvouchedSettled) {
      const all = this.store.loadAll();
      this.settleUnvouched(all.records, all.broken);
    }
    this.store.forget(threadId);
    let rec: ThreadRecord | undefined;
    try {
      rec = this.store.load(threadId) ?? this.rebuild(threadId);
    } catch (e) {
      this.log.error("couldn't rebuild a handed-over thread's record", { threadId, error: String(e) });
    }
    if (!rec) {
      this.log.warn('a handed-over thread is gone', { threadId });
      return undefined;
    }
    // Neutralised like the ones loaded at start (real-copy.ts).
    const copy = realCopy(this.store.home);
    if (copy) this.store.save(neutraliseCopied(rec, copy.work));
    // An old runner's mark of a worktree the always-trust doesn't reach
    // (settleUnvouched), set after this one started.
    const w = rec.worktree;
    if (w && w.unvouched === true && typeof w.path === 'string' && !w.removedAt) this.patchTrust.unvouch?.(w.path);
    rec.lastSeq = this.store.log(rec.id).lastSeq;
    const st: ThreadState = { rec, rt: newRuntime(Date.parse(rec.lastActivityAt) || 0) };
    this.threads.set(rec.id, st);
    // A thread that was busy on the old runner comes across here, not at
    // start, so it learns its "You: ..." line here too.
    // As at start, one record that trips recovery costs that thread its
    // recovery, not the handover (Runner.recoveryFailed).
    try {
      if (rec.asked === undefined && !rec.archivedAt) this.backfillAsked(rec);
      this.recoverReviews(st);
      // Handed over before its worktree cleanup finished (letGo's limit).
      void this.settleLostCleanups([st], false);
      if (opts.crashed) {
        // main.ts carries it on (carryOnStopped), after any resume of its own.
        if (this.recover(st)) this.notice('info', `The old runner stopped while "${rec.title}" was mid-turn.`);
      }
      // Hibernating until the runner restarts: for this thread, coming across
      // is the restart.
      if (this.wakesOnStart(rec)) this.wake(st, 'restart');
      else if (rec.queue.length && this.bucket(rec) === 'inbox') {
        this.kickQueue(st);
      }
      // Finished there, and let go before the guess at whether Mike needed
      // to see it was made (runner/inbox-guess.ts).
      this.catchUpInboxGuess(st);
    } catch (e) {
      this.recoveryFailed(st, e);
    }
    this.tellOneStoppedWork(st);
    this.markDirty(st);
    this.armSnoozeTimer();
    this.armRoomTimer();
    this.armNetTimer(true);
    this.log.info('adopted a thread', { threadId, crashed: Boolean(opts.crashed), queued: rec.queue.length });
    return this.summary(st);
  },
};

export type HandoversPart = RunnerPart<typeof handoversPart>;
