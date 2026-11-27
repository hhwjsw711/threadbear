// Words written for a thread's agent earlier, by a thread with less access
// (or by one whose access can't be known here), that reach it later: a held
// report from a thread it started (runner/nested.ts), a reply from a thread
// it started on another runner (far-reports.ts), a schedule another thread
// set up for it (schedules.ts), a waited-on thread's closing reply
// (runner/hibernation.ts). Each carries a ceiling: the most access the
// receiving thread may have when the words reach its agent, as send_message
// would have let them reach it then. If Mike has raised it above that since,
// they aren't handed to its agent: he's shown the thread instead, with a
// note, and no turn (Daybreak findings 162, 163 and 164, 22 Nov 2026; the
// waits had this since 12 Nov).
//
// The check is made where the words are handed over (sendTo, for a message
// that starts or joins a turn now) and again as a queued one is taken off
// the queue (kickQueue), so a message that waited behind a busy turn while
// Mike raised the thread is held too. Each method's `this` is the Runner;
// runner.ts puts them on its prototype.
import type { Runner, ThreadState } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { PermissionMode } from '../protocol.ts';
import type { QueuedSend } from '../store.ts';
import { above, CEILING_REFUSED, ceilingMode, higherMode, lowerMode, raises, type Authority } from '../access.ts';
export { CEILING_REFUSED, ceilingMode, higherMode, lowerMode };
import { senderPrefix } from './nested.ts';
import { ErrorCode, RpcError, sentByAgent } from '../protocol.ts';

export const ceilingPart = {
  // Whether words with this ceiling may go to the agent of a thread with
  // access `me`: it has no more than the ceiling, or (`from`, a thread on
  // this runner that wrote them) the writer has as much as it has now, as
  // send_message goes by (mayTellOf). Without a ceiling, only the second.
  mayPassOn(this: Runner, me: Authority, ceiling: PermissionMode | undefined, from?: string): boolean {
    if (from && this.mayTellOf(me, from)) return true;
    return ceiling !== undefined && !above(me, { mode: ceilingMode(ceiling) });
  },

  // Whether a message with this ceiling may reach `st`'s agent now. One
  // with none isn't held to one (Mike's, a thread's own, the runner's).
  underCeiling(this: Runner, st: ThreadState, ceiling: unknown): boolean {
    if (ceiling === undefined) return true;
    return !above(this.authorityNow(st.rec.id), { mode: ceilingMode(ceiling) });
  },

  // A restricted helper update may be with the adapter while it prepares
  // the prompt. Keep that turn within its ceiling until it settles, since
  // the runner cannot tell when every provider has read the input.
  checkHelperPermissionChange(this: Runner, st: ThreadState, mode: PermissionMode): void {
    const turn = st.rt.turn;
    const ceiling = turn?.helperRunId ? turn.ceilings?.get(turn.turnId) : undefined;
    if (ceiling && raises(mode, ceiling)) {
      throw new RpcError(ErrorCode.busy, 'This helper is reading an update from its coordinator. Try raising its permissions after the turn finishes.');
    }
  },

  // The ceiling of another thread's message as it's accepted for `st`: what
  // `st` has now, which the send was allowed for (with no card, the sender
  // had as much; with one, Mike said yes at this). Not the sender's own, as
  // the line naming it is only words another Mac could have written.
  agentCeiling(this: Runner, st: ThreadState): PermissionMode {
    return ceilingMode(this.authorityNow(st.rec.id).mode);
  },

  // A queued message from before ceilings (22 Nov 2026), as it leaves the
  // queue: a schedule's goes by the schedule's own ceiling (schedules.ts,
  // "Ceilings"), another thread's by what its sender has now (as
  // send_message would), anything else (Mike's, the runner's) by none.
  legacyCeiling(this: Runner, q: Pick<QueuedSend, 'text' | 'origin' | 'scheduleId'>): PermissionMode | undefined {
    // (main.ts sets scheduleCeiling wherever a Scheduler runs.)
    if (q.origin === 'schedule') return this.scheduleCeiling ? (q.scheduleId ? this.scheduleCeiling(q.scheduleId) : 'ask') : undefined;
    // The runner's own were often another thread's words (a held report, a
    // wake with a reply, a panel's answers), so they count as Ask.
    if (q.origin === 'runner') return 'ask';
    if (q.origin || !sentByAgent(q.text)) return undefined;
    const id8 = senderPrefix(q.text);
    const hits = id8 ? [...this.threads.values()].filter((t) => !t.rt.deleted && t.rec.id.startsWith(id8)) : [];
    return hits.length === 1 ? ceilingMode(this.authoritySaved(hits[0].rec.id).mode) : 'ask';
  },

  // Just before a turn's message goes to its CLI, after whatever the turn
  // waited for (a CLI closing, a worktree, a compaction): raised above its
  // ceiling meanwhile, it isn't sent, and the turn ends there with nothing
  // sent, as a command the runner answers itself does. True if so.
  heldAtDispatch(this: Runner, st: ThreadState, msg: Pick<QueuedSend, 'turnId' | 'text' | 'origin' | 'scheduleId' | 'ceiling' | 'helperRunId'>): boolean {
    const turn = st.rt.turn;
    const ceilings = [msg.ceiling, ...(turn?.ceilings ? [...turn.ceilings.values()] : [])].filter((c) => c !== undefined);
    if (!turn || ceilings.every((c) => this.underCeiling(st, c))) return false;
    // Its row is in the transcript already: kept out of what a fresh
    // session is told the thread said (a handoff's history), and the rest.
    const seqs = [...(turn.inputs?.values() ?? [])];
    if (seqs.length) st.rec.withheldSeqs = [...new Set([...(st.rec.withheldSeqs ?? []), ...seqs])];
    this.withholdMessage(st, msg);
    turn.local = true;
    turn.messages = [];
    turn.precompact = undefined;
    this.completeTurn(st, { outcome: 'completed', durationMs: 0 });
    return true;
  },

  // The ceiling of its agent's snooze words, `said`, as they come back to
  // it (a topic wake, an email's, a check at the latest time, the note
  // about one): what it had as it wrote them, Ask if not kept for those
  // words. None for Mike's own Wake when (`by` not 'agent').
  snoozeCeiling(this: Runner, st: ThreadState, w: { said: string; by?: 'agent' } | undefined): PermissionMode | undefined {
    if (!w || w.by !== 'agent') return undefined;
    return st.rec.wakeCeiling?.said === w.said ? st.rec.wakeCeiling.ceiling : 'ask';
  },

  // Pending agent snoozes in words from before ceilings (22 Nov 2026):
  // bound at the thread's saved mode as this runner starts, as schedules
  // from before are (schedules.ts, "Ceilings").
  bindOldWakeCeilings(this: Runner): void {
    for (const st of this.threads.values()) {
      const w = st.rec.wakeWhen;
      if (!w || w.by !== 'agent' || st.rec.wakeCeiling?.said === w.said) continue;
      st.rec.wakeCeiling = { said: w.said, ceiling: ceilingMode(st.rec.permissionMode ?? 'ask') };
      this.markDirty(st);
    }
  },

  // Shown to Mike instead of its agent: a note saying what wasn't passed on
  // and where to read it, and the thread in Needs you (woken, if it was
  // hibernating). No turn: he reads it, and a message from him carries on.
  withhold(this: Runner, st: ThreadState, why: string, note: string): void {
    if (st.rec.snoozedUntil && !st.rec.archivedAt) {
      this.wake(st, { why });
      this.armSnoozeTimer();
    } else {
      st.rec.forceUnread = true;
      st.rec.updatedAt = this.isoNow();
      this.markDirty(st);
    }
    this.emit(st, { type: 'system.note', text: note });
    this.log.info('held back words from a thread with less access than this one has now', { threadId: st.rec.id, why });
  },

  // A schedule's run held by its ceiling (schedules.ts, "Ceilings"): the
  // thread it was for is shown to Mike with a note, as the schedule pauses.
  scheduleHeld(this: Runner, threadId: string, title: string, note: string): void {
    const st = this.threads.get(threadId);
    if (!st || st.rt.deleted) return;
    this.withhold(st, `the schedule "${title}" came due`, `The schedule "${title}" wasn't sent to this thread's agent. ${note}`);
  },

  // A message about to be handed to `st`'s agent whose ceiling it's above
  // now: held back, with a note saying what it was.
  withholdMessage(this: Runner, st: ThreadState, q: Pick<QueuedSend, 'text' | 'origin' | 'scheduleId' | 'seq' | 'helperRunId'>): void {
    if (q.helperRunId) this.coordinators?.helperUpdateWithheld(st.rec.id, q.helperRunId);
    // Queued again after its first showing never reached the agent: that
    // row is kept out of what an agent is told the thread said too.
    if (q.seq !== undefined) st.rec.withheldSeqs = [...new Set([...(st.rec.withheldSeqs ?? []), q.seq])];
    const first = q.text.slice(0, q.text.indexOf('\n') < 0 ? q.text.length : q.text.indexOf('\n')).trim().slice(0, 200);
    const what = q.origin === 'schedule' ? `A scheduled message (${first})` : first ? `A message (${first})` : 'A message';
    this.withhold(
      st,
      'a message came for it from a thread with less access',
      `${what} wasn't passed to this thread's agent: it was written by a thread with less access than this one has now (it was raised since). Read it where it came from, and send a message here to carry on.`,
    );
  },
};

export type CeilingPart = RunnerPart<typeof ceilingPart>;
