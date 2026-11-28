// Snoozing and hibernating: when a thread wakes, by time, by topic or by restart.
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { PermissionMode, ReviewFinding, ThreadSummary } from '../protocol.ts';
import { ErrorCode, RpcError } from '../protocol.ts';
import { LATE_CHECKS_MAX, LATE_CHECK_LOST, SAID_MAX, WAKE_SYSTEM, awayFor, hibernateNote, lateCheckPrompt, lateChecksOf, lateNews, lateSleepMs, lateWait, lateWhy, localWhen, parseWakeTime, readWakeAnswer, topicCheckNews, wakePrompt, type LateWait } from '../wake-when.ts';
import type { ThreadState } from '../runner.ts';
import { NO_WAKE_TIME } from './timings.ts';
import { parseWhen } from '../when.ts';
import { parkRecord, placeOf, wakesOnStart, type PlaceEvent } from '../place.ts';
import type { WaitFor } from '../needs.ts';
import path from 'node:path';
import crypto from 'node:crypto';
import { providerName } from '../providers.ts';
import { LAB_REVIEW_REPLY_CHARS, addVerdict, addVerdicts, answerEach, findingLine, panelWake } from './lab-review.ts';
import { cutSafely, safeEnd } from '../safe-cut.ts';
import { above, LEAST, raises, type Authority } from '../threadbear-mcp.ts';
import { ceilingMode } from './ceiling.ts';


const withCeiling = (ceiling: PermissionMode | undefined): { ceiling?: PermissionMode } => (ceiling ? { ceiling } : {});

// The less of two: the lower mode, or LEAST if either is.
export function leastAuthority(a: Authority | undefined, b: Authority): Authority {
  if (!a) return b;
  if (a === LEAST || b === LEAST) return LEAST;
  return { mode: raises(a.mode, b.mode) ? b.mode : a.mode };
}

// How long a thread waiting on others sleeps at most when end_turn gave no
// snooze, so one that never hears still comes back.
export const WAIT_FOR_DEFAULT_MS = 86_400_000;
// How much of each finished thread's reply the waiting one is handed.
export const WAIT_FOR_REPLY_CHARS = 2000;

export const hibernationPart = {
  // Hibernates a thread until when Mike said, in his own words
  // (wake-when.ts), as Opus reads them: a time, a topic for the librarian
  // to listen for, or both. The thread goes away at once, as a preset
  // does, and the time follows once the model answers; if it can't say,
  // the thread comes back and the call fails with why.
  // `by: 'agent'`: its own agent asked (snoozeAfterTurn), waiting for
  // something to happen (WakeWhen.by).
  async hibernateWhen(this: Runner, params: { threadId: string; said: string; by?: 'agent'; askedBy?: Authority }): Promise<{ thread: ThreadSummary; until?: string; topic?: string; why: string }> {
    const st = this.mustGet(params.threadId);
    if (this.activeCoordinator(st.rec.id)) {
      throw new RpcError(ErrorCode.badParams, 'Pause this project’s coordinator before archiving or hibernating its conversation.');
    }
    const said = params.said.trim();
    if (!said) throw new RpcError(ErrorCode.badParams, 'Say when it should wake.');
    if (said.length > SAID_MAX) throw new RpcError(ErrorCode.badParams, `That's more than ${SAID_MAX} characters.`);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const by = params.by === 'agent' ? ('agent' as const) : undefined;
    // Plain time expressions ("tomorrow", "2h", "in 2 hours", "tonight",
    // "Friday 9am", "at the weekend", …) are worked out locally right away,
    // so they cost no tokens and still work when every login is out of room
    // or small-model calls are off. Only topics and fuzzy phrases go to the
    // model.
    const local = parseWakeTime(said, this.clock.now());
    if (local) {
      if ('error' in local) throw new RpcError(ErrorCode.other, `Couldn't work out when to wake it: ${local.error}`);
      this.update({ threadId: st.rec.id, snoozedUntil: local.until, noted: true });
      this.park(st, { kind: 'wordsAsked', said, ...(by ? { by } : {}) });
      this.park(st, { kind: 'wordsAnswered', said, until: local.until, ...(by ? { by } : {}) });
      this.markDirty(st);
      this.emit(st, { type: 'system.note', text: hibernateNote(local, said, timeZone, by) });
      this.armSnoozeTimer();
      if (by) this.recheckStarter(st);
      this.log.info('hibernated in words (local)', { threadId: st.rec.id, until: local.until });
      return { thread: this.summary(st), ...local };
    }
    const models = this.models;
    if (!models) throw new RpcError(ErrorCode.other, 'Model calls are off in this runner.');
    const gist = this.threadGist(st.rec.id, { recent: 0 });
    // Its agent's own words wake it later (wakeForTopic): kept to the access
    // it had as it wrote them (runner/ceiling.ts).
    if (by) {
      st.rec.wakeCeiling = { said, ceiling: ceilingMode(leastAuthority(params.askedBy, this.authoritySaved(st.rec.id)).mode) };
      this.markDirty(st);
    }
    const input = { said, now: this.clock.now(), timeZone, title: st.rec.title, first: gist.first, brief: st.rec.brief?.text, ...(by ? { by } : {}) };
    this.update({ threadId: st.rec.id, snoozedUntil: NO_WAKE_TIME, noted: true });
    this.park(st, { kind: 'wordsAsked', said, ...(by ? { by } : {}) });
    this.markDirty(st);
    const ask = (withThread: boolean) =>
      models.generate({
        feature: 'wake-when',
        ...(withThread ? { cwd: st.rec.cwd } : {}),
        system: WAKE_SYSTEM,
        prompt: wakePrompt(withThread ? input : { said, now: input.now, timeZone, title: '(private)', ...(by ? { by } : {}) }),
        maxTokens: 300,
        strong: true,
      });
    let res = await ask(true);
    // A private folder's thread isn't sent: his words alone are usually enough.
    if (!res.ok && res.reason === 'private') res = await ask(false);
    // Woken, hibernated another way or deleted meanwhile: that wins.
    if (st.rt.deleted || st.rec.wakeWhen?.pending !== true || st.rec.wakeWhen.said !== said) {
      throw new RpcError(ErrorCode.other, 'The thread was woken or put away again while this was worked out.');
    }
    const answer = res.ok ? readWakeAnswer(res.value, this.clock.now()) : { error: res.message || `No answer from the model (${res.reason}).` };
    if ('error' in answer) {
      this.park(st, { kind: 'wordsFailed', said });
      st.rec.updatedAt = this.isoNow();
      this.markDirty(st);
      this.armSnoozeTimer();
      if (this.bucket(st.rec) === 'inbox') this.kickQueue(st);
      if (by) this.recheckStarter(st);
      throw new RpcError(ErrorCode.other, `Couldn't work out when to wake it: ${answer.error}`);
    }
    // Back to sleep after a check at its latest time (wakeAtTime). While
    // its checks are counted the wait has a latest time even if the model
    // gives none, so they end with Mike rather than a sleep with no end
    // (also for a check finished by a carry-on after a lost network or a
    // full login, which is another turn: Codex's second review). Straight
    // after the check it is at least twice as far off as the last sleep
    // was meant to be (wake-when.ts, "The latest time passing").
    const late = by && answer.topic ? lateChecksOf(st.rec) : undefined;
    if (late) {
      const least = this.clock.now() + lateSleepMs(late.waitedMs);
      if (!answer.until || (late.backOff && Date.parse(answer.until) < least)) answer.until = new Date(least).toISOString();
      if (late.backOff) {
        st.rec.lateChecks = { n: late.n, waitedMs: late.waitedMs, since: late.since };
        this.markDirty(st);
      }
    }
    // What it already checked counts only for the same words, from its agent.
    this.park(st, { kind: 'wordsAnswered', said, ...(answer.until ? { until: answer.until } : {}), ...(answer.topic ? { topic: answer.topic } : {}), ...(by ? { by } : {}) });
    this.emit(st, { type: 'system.note', text: hibernateNote(answer, said, timeZone, by) });
    this.armSnoozeTimer();
    // Its starter's card counts it as working while it waits to land
    // (loose-ends.ts): its own loose ends may have come in first.
    if (by) this.recheckStarter(st);
    this.log.info('hibernated in words', { threadId: st.rec.id, until: answer.until, topic: answer.topic });
    return { thread: this.summary(st), ...answer };
  },

  // Threads hibernating until Mike next talks about something, or (`happened`)
  // until something their agent waits for has happened, for the librarian
  // to listen for.
  waitingTopics(this: Runner): { threadId: string; title: string; topic: string; happened?: true }[] {
    const now = this.clock.now();
    const out: { threadId: string; title: string; topic: string; happened?: true }[] = [];
    for (const { rec, rt } of this.threads.values()) {
      const topic = rec.wakeWhen?.topic;
      if (!topic || rt.deleted || rec.archivedAt || !rec.snoozedUntil || Date.parse(rec.snoozedUntil) <= now) continue;
      out.push({ threadId: rec.id, title: rec.title, topic, ...(rec.wakeWhen?.by === 'agent' ? { happened: true as const } : {}) });
    }
    return out;
  },

  // The librarian heard Mike talk about a hibernating thread's topic in
  // another thread: it wakes, unread, saying where. One its agent put to
  // sleep until something happened gets a turn as well, to check it really
  // has (the librarian reads one thread, and can be wrong) and go back to
  // sleep if not, rather than sitting in the inbox with nothing done.
  wakeForTopic(this: Runner, threadId: string, inThreadId: string, shown?: { topic: string; happened: boolean }): boolean {
    const st = this.threads.get(threadId);
    const wakeWhen = st?.rec.wakeWhen;
    const topic = wakeWhen?.topic;
    if (!st || !wakeWhen || !topic || st.rt.deleted || st.rec.archivedAt || threadId === inThreadId || this.bucket(st.rec) !== 'snoozed') return false;
    // Not the wait the librarian judged: set again while its model ran.
    if (shown && (shown.topic !== topic || shown.happened !== (wakeWhen.by === 'agent'))) return false;
    const where = this.threads.get(inThreadId)?.rec.title;
    if (wakeWhen.by !== 'agent') {
      this.wake(st, { why: `you talked about ${topic}${where ? ` in "${where}"` : ' in another thread'}` });
      this.armSnoozeTimer();
      this.log.info('woke for a topic', { threadId, inThreadId, topic });
      return true;
    }
    // Already woken from this thread for these words, and it has said
    // nothing since: the agent checked that claim and went back to sleep.
    const seq = this.threads.get(inThreadId)?.rec.lastSeq ?? 0;
    const checked = st.rec.wakeChecked?.said === wakeWhen.said ? st.rec.wakeChecked : undefined;
    if (checked && (checked.from[inThreadId] ?? -1) >= seq) return false;
    this.park(st, { kind: 'checked', threadId: inThreadId, seq });
    // Which thread, only where send_message would let it say so without a
    // card: its id is the way in to its words (read_thread).
    const tell = this.mayTellOf(this.authorityNow(st.rec.id), inThreadId);
    const seen = tell ? `another thread (${inThreadId.slice(0, 8)}) looks to show it has` : 'another thread looks to show it has';
    const said = wakeWhen.said.replace(/\s+/g, ' ').trim();
    const news = topicCheckNews({ said, topic }, Intl.DateTimeFormat().resolvedOptions().timeZone, this.clock.now());
    // Not marked unread while it checks, as a check at its latest time
    // isn't (wakeToCheck): a guess that was wrong is nothing for Mike. On
    // 20 Nov 2026 one woke a thread for 26 seconds and pinged his phone.
    const how = this.wakeToCheck(st, {
      id: crypto.randomUUID(),
      why: `to check whether ${topic}${where ? `, from "${where}"` : ''}`,
      prompt: `You hibernated this thread until: ${said}\n\nThreadbear woke it because ${seen} (${topic}), but that's a guess from reading one thread. Check for yourself that it really has${tell ? ' (read_thread on that thread, and the work itself)' : ''}. If it has, carry on with what you meant to do. If it hasn't, call end_turn with needs "nothing" and snooze "${said.replace(/"/g, "'")}" to go back to sleep, and say in a line what's still missing.`,
      news,
      unsent: `${news} ${LATE_CHECK_LOST}`,
      ceiling: this.snoozeCeiling(st, wakeWhen) ?? 'ask',
    });
    this.armSnoozeTimer();
    this.log.info('woke to check what it waited for', { threadId, inThreadId, topic, how });
    return true;
  },

  // Wakes a sleeping thread for its agent to check for itself whether what
  // it waits for has happened: at its wait's latest time (wakeAtTime), or
  // because the librarian thinks another thread shows it has (wakeForTopic).
  // The wake isn't marked unread: needing Mike notifies him and his phone,
  // and a check that goes back to sleep is nothing for him. How its turn
  // ends says whether he's needed (Runner.completeTurn, wakeCheck).
  // `news`: why it woke, for any other message until the check's turn
  // completes (Runner.takeWakeNews): the check can be lost on the way (a
  // folder that's gone, a restart while it was queued, Stop), and nothing
  // else tells the agent. Set before the send, which may start a message
  // it had queued first: that one is told the check comes after it.
  // `unsent`: the news if the check can't be sent at all. `ceiling`: of
  // its own snooze words, which come back with it (runner/ceiling.ts).
  // 'started': its turn is going. 'waiting': behind a queued message or a
  // move, or held for Mike as the thread has more access than when it
  // slept. 'unsent': the send threw. Either of those leaves it unread, as
  // any wake is, so a check that never runs isn't left unnoticed. Throws,
  // with the thread still asleep, if it can't be woken.
  wakeToCheck(this: Runner, st: ThreadState, c: { id: string; why: string; prompt: string; news: string; unsent: string; wakeReason?: string; ceiling?: PermissionMode }): 'started' | 'waiting' | 'unsent' {
    const { rec } = st;
    const had = rec.wakeNews;
    const unread = rec.forceUnread;
    const at = this.isoNow();
    rec.wakeNews = { text: c.news, at, check: c.id, ...withCeiling(c.ceiling) };
    // A mark left from before it slept (an earlier wake Mike never opened)
    // would make this one loud: nothing clears it as a thread goes to
    // sleep (Gemini's review, 23 Nov 2026).
    if (unread) rec.forceUnread = false;
    try {
      this.wake(st, { why: c.why }, true);
    } catch (e) {
      // Not woken (its log can't be written): still asleep.
      if (had) rec.wakeNews = had;
      else delete rec.wakeNews;
      if (unread) rec.forceUnread = unread;
      throw e;
    }
    let how: 'started' | 'waiting' | 'unsent' = 'waiting';
    try {
      this.sendTo(st, c.prompt, [], { origin: 'runner', queue: true, messageId: c.id, ...(c.wakeReason ? { wakeReason: c.wakeReason } : {}), ...withCeiling(c.ceiling) });
      // (Read afresh: sendTo may have started the turn.)
      const { rt } = st;
      if (rt.turn?.inputs?.has(c.id)) how = 'started';
    } catch (e) {
      // A full disk, say. The next message says why it woke.
      how = 'unsent';
      rec.wakeNews = { text: c.unsent, at, ...withCeiling(c.ceiling) };
      this.log.error('could not send a woken thread its check', { threadId: rec.id, error: String(e) });
    }
    if (how !== 'started') {
      rec.forceUnread = true;
      // The wake left what it had queued for the check's send to start.
      try {
        this.kickQueue(st);
      } catch (e) {
        this.log.error('could not start what a woken thread had queued', { threadId: rec.id, error: String(e) });
      }
    }
    this.markDirty(st);
    return how;
  },

  // end_turn's waitFor, once the turn is over: hibernates until every
  // named thread finishes a turn with nothing left (or is archived or
  // deleted), then wakes with what they said. A thread that never hears
  // wakes at the snooze time, or after a day. Before 5 Nov 2026 a thread
  // waiting on another's report could only end as done, in the inbox.
  // `askedBy`: its access when its agent asked to wait (end_turn), if it
  // has more now, as `by` is the less of the two.
  waitOn(this: Runner, st: ThreadState, waits: WaitFor[], when: string | undefined, askedBy?: Authority): boolean {
    const { rec } = st;
    const list: { threadId: string; title: string; until?: string }[] = [];
    const skipped: string[] = [];
    const ids = waits.map((w) => w.id);
    for (const { id, until } of waits) {
      const hits = [...this.threads.values()].filter((t) => !t.rt.deleted && (t.rec.id === id || t.rec.id.startsWith(id)));
      let found: { id: string; title: string; archived: boolean } | undefined;
      if (hits.length === 1) found = { id: hits[0].rec.id, title: hits[0].rec.title, archived: Boolean(hits[0].rec.archivedAt) };
      else if (!hits.length) {
        // On another runner of this Mac's (one that's draining, or the new
        // one it moved to while this turn ended): waited on all the same,
        // and checked when either comes across.
        const there = this.store.ids().filter((n) => n === id || n.startsWith(id));
        const rec = there.length === 1 && !this.threads.has(there[0]) ? this.store.load(there[0]) : undefined;
        if (rec) found = { id: rec.id, title: rec.title, archived: Boolean(rec.archivedAt) };
      }
      if (!found || found.id === rec.id || found.archived) skipped.push(id);
      else if (!list.some((x) => x.threadId === found.id)) list.push({ threadId: found.id, title: found.title, ...(until ? { until } : {}) });
    }
    if (!list.length) {
      this.emit(st, { type: 'system.note', text: `Not hibernated: none of the threads it was to wait on (${ids.join(', ')}) are here and still going.` });
      return false;
    }
    const now = this.clock.now();
    let until: string | undefined;
    if (when && !['restart', 'release'].includes(when.toLowerCase())) {
      try {
        until = parseWhen(when, now);
      } catch {
        until = undefined;
      }
    }
    if (!until || Date.parse(until) <= now) until = new Date(now + WAIT_FOR_DEFAULT_MS).toISOString();
    this.update({ threadId: rec.id, snoozedUntil: until, noted: true });
    const by = leastAuthority(askedBy, this.authorityNow(rec.id));
    // Refused only if it has woken already (its time passed meanwhile).
    if (!this.park(st, { kind: 'waitOn', waits: list.map((x) => ({ ...x, by })) })) return false;
    this.markDirty(st);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const also = skipped.length ? ` (${skipped.join(', ')} isn't a thread here that's still going, so it isn't waited on.)` : '';
    this.emit(st, { type: 'system.note', text: `Hibernating until ${waitsLine(list)}, or ${localWhen(Date.parse(until), timeZone)} at the latest.${also}` });
    // One may have finished already (while this turn was ending, or before
    // it with nothing new since): it wakes now with that reply.
    this.reconcileWaits();
    // One waited on for something may have done it already, and had its
    // look before this wait was there to be judged: one more look.
    for (const x of list) if (x.until && this.threads.has(x.threadId)) this.tellActivity({ kind: 'waited-on', threadId: x.threadId });
    return rec.waitingOn?.some((wait) => !wait.done) ?? false;
  },

  // A review of this thread's change has started (runner/lab-review.ts):
  // it hibernates until the review finishes, as end_turn's waitFor would.
  // A panel's several reviews: until every one has.
  waitOnReview(this: Runner, st: ThreadState, reviewIds: string[]): void {
    this.waitOn(st, reviewIds.map((id) => ({ id })), undefined);
    for (const w of st.rec.waitingOn ?? []) {
      if (reviewIds.includes(w.threadId)) w.review = true;
    }
    this.markDirty(st);
  },

  // A turn finished with nothing needed and nothing left running: kept with
  // its reply, then any thread waiting on it hears.
  markFinished(this: Runner, st: ThreadState, lastText: string | undefined): void {
    // A review's findings are the point, so more of them go across.
    const max = st.rec.reviewOf ? LAB_REVIEW_REPLY_CHARS : WAIT_FOR_REPLY_CHARS;
    let reply = lastText?.trim() ?? '';
    if (!reply) {
      try {
        reply = this.threadGist(st.rec.id, { recent: 1, chars: max }).recent.filter((x) => x.who === 'assistant').at(-1)?.text ?? '';
      } catch {
        reply = '';
      }
    }
    if (reply.length > max) reply = reply.slice(0, safeEnd(reply, max)) + '…';
    st.rec.finished = { at: this.isoNow(), ...(reply ? { reply } : {}) };
    this.markDirty(st);
    this.reconcileWaits();
  },

  waitedOnDeleted(this: Runner, threadId: string): void {
    for (const st of this.threads.values()) {
      for (const w of st.rec.waitingOn ?? []) {
        if (w.threadId === threadId && !w.done) {
          w.done = { at: this.isoNow(), how: 'deleted' };
          this.markDirty(st);
        }
      }
    }
    this.reconcileWaits();
  },

  // Marks each wait whose thread has finished (with no new work since) or
  // been archived, and wakes any thread whose waits are all done with their
  // replies. Run whenever that could have changed: a finish, an archive,
  // a delete, a new wait, a start and a thread coming across from a
  // draining runner. A thread not here (still on that runner) waits.
  reconcileWaits(this: Runner): void {
    if (this.holdWaits) return;
    // One thread at a time: a wait another runner wrote wrong (a moved
    // record's waitingOn) costs that thread, not the others or the start.
    for (const st of this.threads.values()) {
      try {
        this.reconcileWaitsOf(st);
      } catch (e) {
        this.recoveryFailed(st, e);
      }
    }
  },

  reconcileWaitsOf(this: Runner, st: ThreadState): void {
    {
      const waits = st.rec.waitingOn;
      if (!waits || st.rt.deleted || st.rec.archivedAt || this.bucket(st.rec) !== 'snoozed') return;
      const putAway: string[] = [];
      for (const w of waits) {
        if (w.done) {
          // One finished under the release before verdicts were kept here.
          const t = w.review && w.done.how === 'finished' && !w.done.verdict ? this.threads.get(w.threadId) : undefined;
          if (t?.rec.reviewVerdict) {
            w.done.verdict = structuredClone(t.rec.reviewVerdict);
            this.markDirty(st);
          }
          continue;
        }
        const t = this.threads.get(w.threadId);
        if (!t || t.rt.deleted) continue;
        const fin = t.rec.finished;
        // One waiting for something in particular hears from the librarian
        // (waitMet), not from any finish.
        // A review's verdict is kept with its reply, so a panel member
        // deleted while the others still work keeps its findings.
        if (fin && !w.until) {
          const edited = w.review ? [...reviewEdits(this, t)] : [];
          w.done = { at: fin.at, how: 'finished', ...(fin.reply ? { reply: fin.reply } : {}), ...(w.review && t.rec.reviewVerdict ? { verdict: structuredClone(t.rec.reviewVerdict) } : {}), ...(edited.length ? { edited } : {}) };
        }
        else if (t.rec.archivedAt) w.done = { at: t.rec.archivedAt, how: 'archived' };
        else continue;
        w.title = t.rec.title;
        this.markDirty(st);
        if (w.review && w.done.how === 'finished' && !t.rec.archivedAt && !t.rt.turn) putAway.push(t.rec.id);
      }
      if (waits.every((x) => x.done)) return this.deliverWaits(st, waits);
      // One of a review panel that's done while the rest still work is put
      // away now, as a single review is once it's back, rather than sitting
      // in the inbox (Gemini's review of the panel, 19 Nov 2026). Its wait
      // is already done, with its reply and verdict.
      for (const id of putAway) this.update({ threadId: id, archived: true, archivedBy: 'threadbear', why: 'its review went back to the thread that asked for it' });
    }
  },

  // What a thread's agent can do now (threadbear-mcp.ts, Authority).
  authorityNow(this: Runner, threadId: string): Authority {
    const st = this.threads.get(threadId);
    if (!st || st.rec.confined) return LEAST;
    return { mode: this.accessOf(threadId) };
  },

  // Whether a thread with access `me` may be handed another thread's words
  // without a card: the other has no less access (its mode), as
  // send_message goes by. One not here counts as the least.
  mayTellOf(this: Runner, me: Authority, threadId: string): boolean {
    const them = this.authoritySaved(threadId);
    if (them === LEAST) return false;
    return !above(me, them);
  },

  // What a thread's agent is held to as a sender: its saved mode, as
  // send_message goes by (threadbear-mcp.ts, restricted), not the more a
  // running turn may still have after it was lowered (Codex's review of
  // Daybreak finding 111). One not here counts as the least.
  authoritySaved(this: Runner, threadId: string): Authority {
    const st = this.threads.get(threadId);
    if (!st || st.rec.confined) return LEAST;
    return { mode: st.rec.permissionMode ?? 'ask' };
  },

  // Whether what a waited-on thread said may go to the waiting thread's
  // agent as a message, as send_message would let it without a card: the
  // waited-on thread has no less access than the waiting one has now, or the
  // waiting one's agent asked for it itself (end_turn's waitFor) and hasn't
  // been raised since. A wait the agent never asked for (`by` missing) counts
  // only the first (Daybreak, 12 Nov 2026: an Ask helper's closing reply
  // started a turn in its Full-access starter).
  // The same rule as every other word held for later (runner/ceiling.ts).
  mayHear(this: Runner, me: Authority, w: NonNullable<ThreadState['rec']['waitingOn']>[number]): boolean {
    return this.mayPassOn(me, w.by === undefined ? undefined : w.by === LEAST ? undefined : w.by.mode, w.threadId);
  },

  deliverWaits(this: Runner, st: ThreadState, waits: NonNullable<ThreadState['rec']['waitingOn']>): void {
    // Every wait, whatever it carries: a title is the waited-on thread's
    // own words too (update_thread), and a review's findings the reviewer's
    // (Codex's review of the Daybreak fix, 12 Nov 2026).
    const me = this.authorityNow(st.rec.id);
    const held = waits.filter((x) => !this.mayHear(me, x));
    if (!held.length && waits.length > 1 && waits.every((x) => x.review)) return this.deliverPanel(st, waits);
    if (!held.length && waits.length === 1 && waits[0].review) return this.deliverReview(st, waits[0]);
    if (held.length) {
      // Woken for Mike instead, with no turn: he reads them and says what next.
      const names = held.map((x) => `"${x.title}"`).join(', ');
      const one = held.length === 1;
      this.wake(st, { why: one ? `${names} finished` : 'the threads it was waiting on finished' });
      this.armSnoozeTimer();
      this.emit(st, { type: 'system.note', text: `${names} ${one ? 'has' : 'have'} less access than this thread, so what ${one ? 'it' : 'they'} said wasn't passed to this thread's agent without you. Read ${one ? 'it' : 'them'}, and send a message here to carry on.` });
      this.log.info('woke without passing on a reply from a thread with less access', { threadId: st.rec.id, held: held.map((x) => x.threadId) });
      return;
    }
    const parts = waits.map((x) => {
      const head = `"${x.title}" (thread ${x.threadId.slice(0, 8)})`;
      const said = x.done?.how === 'deleted' ? 'was deleted' : x.done?.how === 'archived' ? 'was archived'
        : x.done?.how === 'met' ? `has done what you waited for (${x.until}): ${x.done.why || 'the librarian read it so'}` : 'finished';
      return x.done?.reply ? `${head} ${said}. Its last reply:\n\n${x.done.reply}` : `${head} ${said}.`;
    });
    const one = waits.length === 1;
    const why = one ? `"${waits[0].title}" finished` : 'the threads it was waiting on finished';
    const text = `The thread${one ? '' : 's'} you hibernated to wait on ${one ? 'has' : 'have'} finished.\n\n${parts.join('\n\n')}\n\nCarry on from here. read_thread has the rest of ${one ? 'it' : 'them'}.`;
    // Reports held for it while they worked come with this wake rather than
    // as a second one (runner/nested.ts).
    const reports = this.takeHeld(st);
    this.wake(st, { why });
    this.armSnoozeTimer();
    // Checked against its access now: raised again while this waits in the
    // queue, it's held back as it leaves (runner/ceiling.ts).
    this.sendTo(st, reports ? `${text}\n\n${reports}` : text, [], { origin: 'runner', queue: true, ceiling: ceilingMode(me.mode) });
    this.log.info('woke after waiting on threads', { threadId: st.rec.id, on: waits.map((x) => x.threadId) });
  },

  // A review of this thread's change has finished (or gone): it wakes with
  // the findings and is asked to fix what holds up. The review thread is
  // archived, its job done; Mike can still open it from the link.
  deliverReview(this: Runner, st: ThreadState, w: NonNullable<ThreadState['rec']['waitingOn']>[number]): void {
    const id8 = w.threadId.slice(0, 8);
    const reviewer = this.threads.get(w.threadId);
    const who = reviewer ? providerName(reviewer.rec.provider) : 'The reviewer';
    let text: string;
    if (w.done?.how === 'finished' || w.done?.how === 'met') {
      const edited = reviewer ? [...reviewEdits(this, reviewer)] : [];
      const findings = w.done.reply?.trim() || '(It gave no reply. read_thread has what it did.)';
      const edits = edited.length ? `\n\nIt was asked not to edit files but changed ${edited.join(', ')}. Look at those changes before going on, and keep or undo them.` : '';
      // Its verdict, numbered into the ledger (lab-review.ts): the agent
      // answers each by id in end_turn, and can't end the turn without.
      const ledger = st.rec.labReview;
      const added = ledger ? addVerdict(ledger, reviewer?.rec.reviewVerdict) : [];
      if (ledger) this.markDirty(st);
      const round = ledger && ledger.rounds > 1 ? ` (review round ${ledger.rounds})` : '';
      if (ledger && !ledger.unstructured && !added.length) {
        text = `${who} reviewed the change you just made${round} (thread ${id8}) and found nothing that holds up.${edits}\n\nIts reply:\n\n${findings}\n\nSay so in a line in your reply and finish as you were.`;
      } else if (added.length) {
        text = `${who} reviewed the change you just made${round} (thread ${id8}). Its findings, numbered:\n\n${added.map(findingLine).join('\n')}\n\nIts reply, with the detail:\n\n${findings}${edits}\n\n` +
          answerEach(added[0].id);
      } else {
        text = `${who} reviewed the change you just made (thread ${id8}). Its findings:\n\n${findings}${edits}\n\n` +
          'Check each finding against the code: fix what holds up and run the tests again. In your reply, say briefly what it found, what you fixed, and anything you left and why. If it found nothing, say so in a line and finish as you were.';
      }
    } else {
      text = `The review of your change (thread ${id8}) ${w.done?.how === 'deleted' ? 'was deleted' : 'was archived'} before it finished, so it wasn't reviewed. Say so in a line in your reply and finish as you were.`;
    }
    this.wake(st, { why: `${who} reviewed the change` });
    this.armSnoozeTimer();
    // Checked against its access now (deliverWaits): raised again while it
    // waits in the queue, it's held back as it leaves (runner/ceiling.ts).
    this.sendTo(st, text, [], { origin: 'runner', queue: true, ceiling: ceilingMode(this.authorityNow(st.rec.id).mode) });
    this.log.info('woke after a lab review', { threadId: st.rec.id, reviewer: w.threadId });
    if (reviewer && !reviewer.rt.deleted && !reviewer.rec.archivedAt && !reviewer.rt.turn) {
      this.update({ threadId: w.threadId, archived: true, archivedBy: 'threadbear', why: 'its review went back to the thread that asked for it' });
    }
  },

  // A review panel has all come back (or gone): the thread wakes with every
  // reviewer's findings numbered together (lab-review.ts, addVerdicts), as
  // deliverReview does for one. Each review thread is put away.
  deliverPanel(this: Runner, st: ThreadState, waits: NonNullable<ThreadState['rec']['waitingOn']>): void {
    const ledger = st.rec.labReview;
    const parts = waits.map((w) => {
      const reviewer = this.threads.get(w.threadId);
      const by = ledger?.panel?.find((p) => p.threadId === w.threadId)?.reviewer ?? (reviewer ? providerName(reviewer.rec.provider) : 'A reviewer');
      const reviewed = w.done?.how === 'finished' || w.done?.how === 'met';
      return { w, reviewer, by, reviewed, verdict: reviewed ? (w.done?.verdict ?? reviewer?.rec.reviewVerdict) : undefined };
    });
    const done = parts.filter((x) => x.reviewed);
    // None came back: the change wasn't reviewed, and the round isn't
    // delivered, as for a single review put away first.
    const leftOut: Omit<ReviewFinding, 'id' | 'round'>[] = [];
    const added = ledger && done.length ? addVerdicts(ledger, done.map((x) => ({ by: x.by, verdict: x.verdict })), leftOut) : [];
    // One that never reviewed means the panel didn't all look: no pass.
    if (ledger && done.length && done.length < parts.length) ledger.passed = false;
    if (ledger) this.markDirty(st);
    const text = panelWake(
      parts.map((x) => ({
        by: x.by,
        threadId: x.w.threadId,
        reviewed: x.reviewed,
        reply: x.w.done?.reply,
        // As it was when it finished, kept in case it's gone since.
        edited: !x.reviewed ? [] : Array.isArray(x.w.done?.edited) ? x.w.done.edited : x.reviewer ? [...reviewEdits(this, x.reviewer)] : [],
      })),
      added,
      ledger,
      leftOut,
    );
    this.wake(st, { why: 'the review panel reviewed the change' });
    this.armSnoozeTimer();
    // Checked against its access now (deliverWaits): raised again while it
    // waits in the queue, it's held back as it leaves (runner/ceiling.ts).
    this.sendTo(st, text, [], { origin: 'runner', queue: true, ceiling: ceilingMode(this.authorityNow(st.rec.id).mode) });
    this.log.info('woke after a review panel', { threadId: st.rec.id, reviewers: waits.map((w) => w.threadId) });
    for (const { w, reviewer } of parts) {
      if (reviewer && !reviewer.rt.deleted && !reviewer.rec.archivedAt && !reviewer.rt.turn) {
        this.update({ threadId: w.threadId, archived: true, archivedBy: 'threadbear', why: 'its review went back to the thread that asked for it' });
      }
    }
  },

  // The waits on this thread for something in particular, for the
  // librarian's look at it.
  waitedOnFor(this: Runner, threadId: string): { threadId: string; title: string; until: string }[] {
    const out: { threadId: string; title: string; until: string }[] = [];
    for (const { rec, rt } of this.threads.values()) {
      if (rt.deleted || rec.archivedAt || this.bucket(rec) !== 'snoozed') continue;
      for (const w of rec.waitingOn ?? []) if (w.threadId === threadId && w.until && !w.done) out.push({ threadId: rec.id, title: rec.title, until: w.until });
    }
    return out;
  },

  // The librarian read in a look at `targetId` that what `waiterId` waits
  // for there has happened: that wait is done, with the thread's latest
  // reply, and the waiter wakes once all of its waits are.
  waitMet(this: Runner, waiterId: string, targetId: string, why: string, until: string): boolean {
    const st = this.threads.get(waiterId);
    // The same condition the look was shown, not one set since.
    const w = st?.rec.waitingOn?.find((x) => x.threadId === targetId && x.until === until && !x.done);
    if (!st || !w || st.rt.deleted || this.bucket(st.rec) !== 'snoozed') return false;
    let reply = '';
    try {
      reply = this.threadGist(targetId, { recent: 2, chars: WAIT_FOR_REPLY_CHARS }).recent.filter((x) => x.who === 'assistant').at(-1)?.text ?? '';
    } catch {
      reply = '';
    }
    w.done = { at: this.isoNow(), how: 'met', ...(reply ? { reply } : {}), ...(why ? { why: cutSafely(why, 200) } : {}) };
    this.markDirty(st);
    this.log.info('a wait was met', { waiterId, targetId, why });
    this.reconcileWaits();
    return true;
  },

  // Whether a starting runner (or one taking a thread over from a draining
  // one) wakes it: hibernating until a restart, or until a new release when
  // this isn't the one it went to sleep on, or a wake-when whose answer was
  // lost with the old runner.
  wakesOnStart(this: Runner, rec: ThreadState['rec']): boolean {
    return wakesOnStart(placeOf(rec), this.release);
  },

  armSnoozeTimer(this: Runner): void {
    this.snoozeTimer?.cancel();
    this.snoozeTimer = undefined;
    if (this.stopping) return;
    const now = this.clock.now();
    let next = Infinity;
    // A check turn starts a CLI: not while main.ts is still starting (its
    // tools aren't ready, holdWaits), nor on a runner that's handing its
    // threads over or waiting to restart (the turn belongs to the next
    // one). The thread sleeps on, its time passed, and is looked at again.
    const noTurns = this.holdWaits || Boolean(this.draining) || Boolean(this.refusing);
    for (const st of this.threads.values()) {
      if (!st.rec.snoozedUntil) continue;
      const t = Date.parse(st.rec.snoozedUntil);
      if (t > now) next = Math.min(next, t);
      else if (noTurns && this.checksAtLatest(st)) next = Math.min(next, now + 60_000);
      // Its agent's snooze, while main.ts is starting: not before the
      // schedules are in, as one booked keeps its wake quiet (wake). Looked
      // at again once it has started.
      else if (this.holdWaits && this.agentTimeSnooze(st)) next = Math.min(next, now + 60_000);
      else {
        // One thread that can't be woken (its log can't be written) doesn't
        // stop the others' wakes or the timer: it's tried again in an hour.
        try {
          this.wakeAtTime(st);
        } catch (e) {
          this.log.error("couldn't wake a thread at its time", { threadId: st.rec.id, error: String(e) });
          next = Math.min(next, now + 3_600_000);
        }
      }
    }
    if (next === Infinity) return;
    // Re-check at least hourly so long snoozes survive clock changes.
    this.snoozeTimer = this.clock.setTimeout(() => this.armSnoozeTimer(), Math.min(next - now, 3_600_000));
  },

  // A sleeping thread's wait in words with a time as well (wake-when.ts,
  // lateWait). Only a sleep that is in words and nothing else: fields an
  // older runner left together (place.ts, odd) wake as a plain snooze.
  lateWaitOf(this: Runner, rec: ThreadState['rec']): LateWait | undefined {
    const place = placeOf(rec);
    const sleep = place.kind === 'inbox' ? undefined : place.sleep;
    return sleep?.for.kind === 'words' ? lateWait(rec) : undefined;
  },

  // Whether a thread whose time has come gets a turn to check for itself:
  // its own agent's wait for something to happen, with checks left. Not
  // one archived since (its sleep ends quietly), nor one already in a turn
  // (a message queued for it started first: it's awake).
  checksAtLatest(this: Runner, st: ThreadState): boolean {
    const { rec } = st;
    if (rec.archivedAt || st.rt.turn || this.lateWaitOf(rec)?.by !== 'agent') return false;
    return (lateChecksOf(rec)?.n ?? 0) < LATE_CHECKS_MAX;
  },

  // A sleep's time has come. A plain snooze wakes as it always has. A wait
  // in words with a time as well (wake-when.ts, "The latest time passing")
  // says the time ran out with nothing seen, in the thread and to its agent
  // with the next message. One its own agent set gets a turn to check for
  // itself instead of sitting in the inbox, LATE_CHECKS_MAX times in a row.
  wakeAtTime(this: Runner, st: ThreadState): void {
    const { rec } = st;
    const wait = this.lateWaitOf(rec);
    // Archived since it went to sleep: its sleep just ends, quietly (wake).
    if (!wait || rec.archivedAt || st.rt.turn) return this.wake(st, 'time');
    const now = this.clock.now();
    const at = this.isoNow();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const before = lateChecksOf(rec);
    if (!this.checksAtLatest(st)) {
      // Mike's own, or its agent's with its checks used up: his to look at.
      const stopped = wait.by === 'agent' ? before : undefined;
      const had = rec.wakeNews;
      // Before the wake, which may start a message it had queued.
      rec.wakeNews = { text: lateNews(wait, timeZone, now, stopped ? { stopped } : undefined), at, ...withCeiling(this.snoozeCeiling(st, wait)) };
      try {
        this.wake(st, { why: lateWhy(wait, timeZone, stopped ? { stopped, now } : undefined) });
      } catch (e) {
        // Not woken (its log can't be written): still asleep, tried again.
        if (had) rec.wakeNews = had;
        else delete rec.wakeNews;
        throw e;
      }
      this.log.info('woke at the latest time of a wait in words', { threadId: rec.id, topic: wait.topic, checks: stopped?.n });
      return;
    }
    const slept = rec.snoozedAt && Date.parse(rec.snoozedAt) <= now ? rec.snoozedAt : undefined;
    // How long it meant to sleep, not how long the Mac was shut past it.
    const planned = slept ? Math.min(now, wait.latest) - Date.parse(slept) : 0;
    const check = (before?.n ?? 0) + 1;
    const had = rec.lateChecks;
    const putBack = () => {
      if (had) rec.lateChecks = had;
      else delete rec.lateChecks;
    };
    const id = crypto.randomUUID();
    // Counted, with the sleep after it to back off (hibernateWhen).
    rec.lateChecks = { n: check, waitedMs: planned > 0 ? planned : 86_400_000, since: before?.since ?? slept ?? at, backOff: id };
    let how: ReturnType<Runner['wakeToCheck']>;
    try {
      how = this.wakeToCheck(st, {
        id,
        why: lateWhy(wait, timeZone, 'checking'),
        prompt: lateCheckPrompt(wait, timeZone, check),
        news: lateNews(wait, timeZone, now, 'checking'),
        unsent: lateNews(wait, timeZone, now),
        wakeReason: 'The latest it would wait passed',
        ceiling: this.snoozeCeiling(st, wait),
      });
    } catch (e) {
      // Not woken: still asleep, not counted, tried again.
      putBack();
      throw e;
    }
    // A check that couldn't be sent isn't counted. The timer goes on.
    if (how === 'unsent') putBack();
    this.markDirty(st);
    this.log.info('woke to check at the latest time of its wait', { threadId: rec.id, topic: wait.topic, check, how });
  },

  // A thread coming back by itself (its time, a restart, a topic) says so
  // in its conversation, with how long it was away, and its row says
  // "Woke up" until Mike looks (`woke`): otherwise it just turns up in the
  // inbox with nothing to say why (30 Oct).
  // `check`: wakeToCheck's, for a turn to check: not marked unread (how the
  // turn ends says), and what it had queued starts with the check's send.
  wake(this: Runner, st: ThreadState, cause: 'time' | 'restart' | { why: string }, check = false): void {
    const { rec } = st;
    // Read before the wake ends the sleep: its agent's own plain snooze.
    const agentSnooze = cause === 'time' && this.agentTimeSnooze(st);
    // Archived since it went to sleep: its hibernation just ends, quietly.
    // Waking it there gave it a "Woke up" and an unread mark in the
    // archive, and started any message it had queued while still archived
    // (13 Nov 2026, the implicit state machines scan). Brought back later,
    // it's in the inbox, as it would have been.
    if (rec.archivedAt) {
      this.park(st, { kind: 'wake' });
      st.rec.updatedAt = this.isoNow();
      this.markDirty(st);
      return;
    }
    const now = this.clock.now();
    const since = rec.snoozedAt && Date.parse(rec.snoozedAt) <= now ? rec.snoozedAt : undefined;
    // Under a minute (a wake-when cut short by a restart) isn't worth saying.
    const ms = since ? now - Date.parse(since) : 0;
    const away = ms >= 60_000 ? ` after ${awayFor(ms)}` : '';
    const text = typeof cause === 'object'
      ? `Woke up${away}: ${cause.why}.`
      : cause === 'restart'
        ? `Woke up${away}, as the runner restarted.`
        : away ? `Woke up after hibernating for ${awayFor(ms)}.` : 'Woke up from hibernating.';
    // Its agent's fallback snooze running out isn't news while a schedule
    // will bring it back: it's marked quietWake, not
    // unread, and the summary counts it as wanting Mike only while no such
    // schedule is booked, worked out afresh from the schedules each time
    // (so a start, a move or schedules arriving late can't strand it).
    // Marked unread, it sat in the inbox all night, then dropped out the
    // moment Mike opened it (25 Nov 2026: an agent's 6 h snooze ran out
    // next to its every-10-minutes release check). Mike's own snooze, a
    // waitFor or app wait timing out, and a thread with anything else for
    // him still come back unread.
    const quiet = agentSnooze && !check && this.quietWake(st);
    // Starting "Woke up" is what gives it the bear in the app (RowContent.isWakeNote).
    // One staying under Hibernating gets the line for that instead (sayScheduled).
    if (!(quiet && this.hibernatesForSchedule(rec.id))) this.emit(st, { type: 'system.note', text });
    // Already drawn under Hibernating for its schedule (its time passed
    // while a start held the wake), so no move will say it: said here.
    else if (st.rt.waitState === 'scheduled') queueMicrotask(() => this.sayScheduled(st, true));
    // Its "Woke up" mark, until Mike looks (place.ts, wake).
    this.park(st, { kind: 'wake' });
    if (quiet) st.rec.quietWake = true;
    else if (!check) st.rec.forceUnread = true;
    st.rec.updatedAt = this.isoNow();
    this.markDirty(st);
    if (!check) this.kickQueue(st);
  },

  // It sleeps until a time its agent set, and for nothing else.
  agentTimeSnooze(this: Runner, st: ThreadState): boolean {
    const place = placeOf(st.rec);
    return place.kind !== 'inbox' && place.sleep?.for.kind === 'time' && place.sleep.for.by === 'agent';
  },

  // Nothing in it would want Mike once its sleep ends: no ask, failed
  // turn, wait for room, queued message, unread reply, pending review or
  // unread mark of its own. An unread reply that said needs nothing is no
  // news either: a turn that ends with a snooze is seldom read before it
  // sleeps (Gemini's review).
  quietWake(this: Runner, st: ThreadState): boolean {
    const { rec } = st;
    return rec.status === 'idle' && rec.needs?.needs !== 'you' && !rec.waitingForRoom && !rec.queue.length && !rec.forceUnread && !st.rt.turn
      && (rec.lastTurnCompletedSeq <= rec.lastSeenSeq || this.saidNothing(rec)) && !rec.reviews?.some((r) => r.status === 'pending');
  },

  // Moves where a thread is parked (place.ts): the only way its record's
  // snooze, wait and archive fields change. A move that doesn't apply where
  // it is (a caller checked something else) leaves it, and is logged.
  park(this: Runner, st: ThreadState, e: PlaceEvent): boolean {
    const res = parkRecord(st.rec, e, this.clock.now());
    if (!res.ok) {
      this.log.warn('a thread move refused', { threadId: st.rec.id, event: e.kind, why: res.reason });
      return false;
    }
    // A new sleep: why it last woke by itself is old news (wakeAtTime).
    if (e.kind === 'snooze') delete st.rec.wakeNews;
    // A quiet wake (wake) lasts until Mike looks, a turn starts (startTurn)
    // or it's put away again: left on a thread hibernated or archived
    // since, it would bring it back unread when its schedule went. Not on
    // a message, which may sit queued or fail to start (the reviews, 25 Nov 2026).
    if (PUT_AWAY_MOVES.has(e.kind)) delete st.rec.quietWake;
    // Put away with the runner's nudge for an unread shell still queued: it
    // would run, stale, whenever the thread next came back (the reviews,
    // 28 Nov 2026).
    if (this.bucket(st.rec) !== 'inbox') this.withdrawNudge(st);
    return true;
  },
};

export type HibernationPart = RunnerPart<typeof hibernationPart>;

// The moves that put a thread away or take it out of the archive.
const PUT_AWAY_MOVES = new Set<PlaceEvent['kind']>(['snooze', 'unsnooze', 'wordsAsked', 'wordsAnswered', 'wordsFailed', 'waitOn', 'forApp', 'archive', 'unarchive', 'scheduleRunEnded']);

// "\"Convex I/O\" finishes", "\"Convex I/O\" reports the saving", joined.
function waitsLine(list: { title: string; until?: string }[]): string {
  const one = (x: { title: string; until?: string }) => `"${x.title}" ${x.until ? `does this: ${x.until}` : 'finishes'}`;
  if (list.every((x) => !x.until)) return `${list.map((x) => `"${x.title}"`).join(list.length === 2 ? ' and ' : ', ')} ${list.length === 1 ? 'finishes' : 'finish'}`;
  return list.map(one).join('; ');
}

// The files a review thread changed, though it was told not to.
function reviewEdits(runner: Runner, st: ThreadState): Set<string> {
  const out = new Set<string>();
  const last = st.rec.lastSeq ?? 0;
  try {
    for (const e of runner.store.log(st.rec.id).read(1, last)) if (e.type === 'edit.diff') out.add(path.basename((e as unknown as { path: string }).path));
  } catch {
    // Unreadable: said as no edits.
  }
  return out;
}
