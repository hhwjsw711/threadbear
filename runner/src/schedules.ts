// Schedules: a message sent at a set time, once (`at`) or over and over
// (`cron`), to a thread or to a new thread each time. Like Convex's
// scheduled functions and crons. Served as the schedules.* methods beside
// the runner's own (see "Schedules" in docs/protocol.md).
//
// Where they're kept depends on the backend. With sync off, or a backend
// older than API 9, they're this runner's own schedules.json, as they always
// were. Once a backend of API 9 is attached (attach(), from sync.ts), they
// live in its `schedules` table so every runner sees one list and a schedule
// can run on another runner (step 6, docs/archive/step6-plan.md): this runner moves
// its own file up once, keeps a live copy of the whole table (and a copy on
// disk for when the backend can't be reached), and sends only its own,
// each run taken with a claim first so it's sent once.
import { CheckRefused, type CheckCard } from './patch-trust.ts';
import { type KeptCheck, CHECK_TIMEOUT_MS, checkLimitMs, checkOutcome, checkRunningElsewhere, checksRunningElsewhere, clearCheckRunning, dropKeptCheck, HELD_EXTRA, HELD_SKIP, heldToldAbout, keepCheck, markCheckRunning, MAX_CHECK_CHARS, MAX_CHECK_TIMEOUT_SECS, noteHeldTold, readKeptCheck, runCheck, type CheckResult } from './schedule-check.ts';
import { forbiddenText } from './sync.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Runner } from './runner.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import type { EffortLevel, PermissionMode, Provider, Schedule } from './protocol.ts';
import { EFFORT_LEVELS, ErrorCode, PROVIDERS, RpcError, isEffortLevel, isPermissionMode, isProvider } from './protocol.ts';
import { atomicWriteFileSync, isDirectory, readJsonSync } from './fsutil.ts';
import { expandHome } from './config.ts';
import { standInFor } from './pools.ts';
import { CronError, checkZone, describeAt, describeCron, localZone, nextRun, nextRuns, parseCron } from './cron.ts';
import { cutSafely, firstLineSafely } from './safe-cut.ts';
import { CEILING_REFUSED, ceilingMode, lowerMode } from './runner/ceiling.ts';
import { raises } from './threadbear-mcp.ts';

// What a check printed, carried by a run: kept (when it was kept) and the
// command, so a sent run drops that command's kept file.
// `held`: it says a check wasn't run, for this digest of what it'd run.
type Carried = { extra: string; kept?: string; check?: string; held?: string };

// What schedules.json holds for each: everything but whenText, which is
// worked out when it's sent, and runnerName, from the backend's runners.
type ScheduleRecord = Omit<Schedule, 'whenText' | 'runnerName' | 'runnerIcon'>;

// A schedule as the backend stores it: the record with its runner and its
// words (the phone shows whenText; the backend has no cron code).
export type StoredSchedule = ScheduleRecord & { runnerId: string; whenText: string };

// What a runner the backend knows of looks like, and what runners.list
// answers with (docs/protocol.md, RunnerInfo).
// version, release, startedAt and draining are what each runner's heartbeat
// last said (sync.ts), for the app's Runners panel.
export type BackendRunner = { id: string; name: string; lastSeenAt?: number; icon?: string; version?: string; release?: string; startedAt?: string; draining?: boolean };
export type RunnerInfo = {
  id: string;
  name: string;
  icon?: string;
  online: boolean;
  lastSeenAt?: string;
  self: boolean;
  version?: string;
  release?: string;
  startedAt?: string;
  draining?: boolean;
};
// This runner, as runners.list has it first.
type SelfRunner = { id: string; name: string; icon?: string; version?: string; release?: string; startedAt?: string };

// The backend's schedules table (sync.ts makes one for Convex; tests pass a
// fake). Every call can fail when the backend can't be reached.
class HeldLocal extends Error {
  held: { id: string; why: string }[];
  constructor(held: { id: string; why: string }[]) {
    super('schedules held on this Mac');
    this.held = held;
  }
}

export type ScheduleBackend = {
  // The whole table now and whenever it changes. Returns the unsubscribe.
  subscribe(onRows: (rows: StoredSchedule[]) => void, onError: (e: Error) => void): () => void;
  save(s: StoredSchedule): Promise<void>;
  remove(scheduleId: string): Promise<void>;
  // This runner's schedules.json, moved up once. `held`: ones a runner key
  // couldn't bring up (convex/sync.ts adoptSchedules), when nothing moved.
  adopt(rows: StoredSchedule[]): Promise<void | { held?: { id: string; why: string }[] }>;
  // Takes a run: "due" at that nextRunAt, or the "request" at that
  // runRequestedAt. False when it isn't ours to send (any more).
  claim(scheduleId: string, kind: 'due' | 'request', expect: string): Promise<boolean>;
  release(scheduleId: string): Promise<void>;
  ran(p: {
    scheduleId: string;
    lastRun: NonNullable<Schedule['lastRun']>;
    sent: boolean;
    expectUpdatedAt: string;
    nextRunAt?: string;
    finishedAt?: string;
    request?: string;
  }): Promise<void>;
  requestRun(scheduleId: string, at: string): Promise<boolean>;
  runners(): Promise<BackendRunner[]>;
};

// A run this runner sent (or skipped, or couldn't send) that the backend
// hasn't heard of yet: ran()'s arguments, when it was first tried, and for a
// due run the nextRunAt it was due at (`slot`).
type RanParams = Parameters<ScheduleBackend['ran']>[0];
type UnrecordedRun = RanParams & { since: number; slot?: string };
// What only this process keeps about one: how often it's been tried, whether
// that's been warned of, and whether the backend has said yes (it's
// forgotten once a row shows it, as a yes can come with the row edited).
type HeldRun = UnrecordedRun & { tries?: number; warned?: boolean; acked?: boolean };
type Hold = { kind: 'due' | 'request'; expect: string; lost: boolean; timer?: TimerHandle };
// convex/sync.ts claimSchedule's claim lasts 2 minutes; renewed well inside it.
const CLAIM_RENEW_MS = 45_000;
const runKey = (r: RanParams) => `${r.scheduleId}\n${r.lastRun.at}\n${r.lastRun.outcome}\n${r.lastRun.threadId ?? ''}`;
// The same run: two can share a millisecond (a run now straight after one
// that failed), so the time alone doesn't say.
const sameRun = (a: Schedule['lastRun'], b: NonNullable<Schedule['lastRun']>) => !!a && a.at === b.at && a.outcome === b.outcome && a.threadId === b.threadId;
// Still not recorded after this long, it's said as a warning (it reaches
// Sentry); a blip that a retry gets past is only logged.
const UNRECORDED_WARN_MS = 30 * 60_000;

// A runner the backend hasn't heard from for this long shows as offline,
// as on the phone.
const ONLINE_MS = 3 * 60_000;
// One not heard from for this long (or that said goodbye for good) isn't
// offered in runners.list: an old install, or a test's.
const FORGET_MS = 30 * 86_400_000;

export type ScheduleRunner = Pick<Runner, 'createAfterModelProbe' | 'send' | 'sendScheduled' | 'dropScheduled' | 'get' | 'list' | 'hello' | 'onNotification' | 'publish' | 'patchTrust'> & Partial<Pick<Runner, 'accessOf' | 'scheduleHeld'>> & { cfg?: Pick<Runner['cfg'], 'defaults'> };

export type CreateScheduleParams = {
  // A card's approval of `check` (patch-trust.ts, approveCheck). Not from a client.
  checkCard?: CheckCard;
  text: string;
  title?: string;
  at?: string;
  cron?: string;
  timezone?: string;
  threadId?: string;
  cwd?: string;
  accountId?: string;
  poolId?: string;
  // With poolId: the kind of login in a pool of several kinds.
  provider?: Provider;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  // Each new thread starts starred. Only without threadId.
  starThreads?: boolean;
  // A shell command run before each run (schedule-check.ts).
  check?: string;
  // How long it may take, in seconds; absent, a minute.
  checkTimeoutSecs?: number;
  paused?: boolean;
  createdBy?: string;
  // Another runner's id or name (runners.list); absent, this one.
  runnerId?: string;
  // For one that sends to a thread: the most access that thread may have
  // when a run reaches its agent (the ceiling, "Ceilings" below). The
  // caller's, as the RPC gate or the schedule_message tool works it out;
  // left out, Mike's (full) unless another thread made it (`createdBy`),
  // then the least, Ask.
  ceiling?: PermissionMode;
};

export type UpdateScheduleParams = {
  scheduleId: string;
  // The check it must still have, compared as it saves (update_schedule
  // carrying a check to a new folder, whose card showed this one). Not
  // from a client.
  ifCheck?: string;
  title?: string;
  text?: string;
  at?: string;
  cron?: string;
  timezone?: string | null;
  paused?: boolean;
  cwd?: string;
  accountId?: string;
  // null takes it out of its pool (back to the folder's or the default).
  poolId?: string | null;
  // null: the model's kind again. A new pool or model without one drops
  // it, so it never sends a model to a login of another kind.
  provider?: Provider | null;
  model?: string | null;
  effort?: EffortLevel | null;
  permissionMode?: PermissionMode;
  starThreads?: boolean;
  // null or "" takes the check off.
  check?: string | null;
  checkCard?: CheckCard;
  // null: back to a minute.
  checkTimeoutSecs?: number | null;
  // Who's changing it, as a ceiling (CreateScheduleParams.ceiling): a new
  // text or title, or resuming it, takes the lower of this and the one it
  // had, or none for Mike's (full). Left out, the ceiling stays as it was.
  ceiling?: PermissionMode;
  // The thread it sends to changing it: its ceiling stays as it was (the
  // RPC gate and the schedule tools say so; over RPC, ceiling left out
  // would otherwise be Mike's).
  keepCeiling?: boolean;
};

// The Mac sleeps and timers stop with it, so check often rather than
// trusting one long timer to wake up on time.
const TICK_MS = 30_000;
// A one-off that has run stays in the list this long, then goes.
const KEEP_FINISHED_MS = 7 * 86_400_000;
// How soon a save that failed is tried again.
export const SAVE_RETRY_MS = 5000;
const BUSY = new Set(['starting', 'running', 'waiting']);

export class Scheduler {
  private runner: ScheduleRunner;
  private file: string;
  private clock: Clock;
  private log: Logger;
  private zone: () => string;
  private items = new Map<string, ScheduleRecord>();
  // Checks under way in this process, with where they run (localChecks).
  private runningChecks = new Map<string, { command: string; cwd: string }>();
  private timer?: TimerHandle;
  private saveRetry?: TimerHandle;
  private saveFailed = false;
  private stopped = false;
  private unlisten?: () => void;
  // This runner, as the backend knows it (sync.runnerId and its name).
  private self: SelfRunner;
  // Whether this runner has a backend to attach to at all (sync is on).
  // Without one a backend copy on disk is taken back as the runner's own.
  private syncOn: boolean;
  // "local": schedules.json is the schedules. "backend": the backend's
  // table is, and this.items is a copy of it, live once `backend` is set.
  private mode: 'local' | 'backend' = 'local';
  private held: { id: string; why: string }[] = [];
  private backend?: ScheduleBackend;
  private attaching = false;
  private unsubscribe?: () => void;
  private ticking = false;
  // A change (a new row, a run asked for) that came in mid-tick: look again
  // straight after rather than on the next regular check.
  private tickAgain = false;
  private names = new Map<string, string>();
  private icons = new Map<string, string>();
  private namesDue = false;
  // Threads a draining runner still has (docs/protocol/updates.md, "Handovers"):
  // they're real threads, just not loaded here yet.
  private elsewhere: (threadId: string) => boolean;
  private moving: (threadId: string) => string | undefined;
  private folderElsewhere?: (threadId: string) => string | undefined;
  private sendElsewhere?: (threadId: string, text: string, scheduleId: string, run: string, since: number, preserve?: boolean, ceiling?: PermissionMode) => Promise<{ turnId: string }>;
  private accessElsewhere?: (threadId: string) => PermissionMode | undefined;
  private savedModeElsewhere?: (threadId: string) => PermissionMode | undefined;
  private dropElsewhere?: (threadId: string, scheduleId: string) => Promise<number>;
  // The ids in the backend's last snapshot: only a row it has shown and then
  // left out was deleted. One this runner has just saved may not be in the
  // next snapshot yet.
  private shown = new Set<string>();
  // Schedules deleted while this runner ran: here, or gone from the
  // backend's rows after it had shown them. The runner drops any of their
  // messages still queued before a turn starts (Runner.scheduleDeleted).
  private deleted = new Set<string>();
  // Schedule checks (schedule-check.ts).
  private home: string;
  private check: (p: { command: string; cwd: string; home: string; scheduleId: string; timeoutMs?: number }) => Promise<CheckResult>;
  // Local runs waiting on their check or send, so a tick doesn't start another.
  private checking = new Set<string>();
  private sending = new Set<string>();
  // A slow draining process must hold only its own schedule, not the
  // serial backend tick (which also serves every other thread).
  private dispatching = new Set<string>();
  private runningNow = new Set<string>();
  // Every check under way, for settled(): the runner waits for them before
  // it exits, so what they print is kept for the next one.
  // Each with its time limit, so a stop waits for the longest.
  private inFlight = new Map<Promise<unknown>, number>();
  // Kept outputs this process has sent (id, command and when kept), in case the file
  // couldn't be deleted: it isn't sent again.
  private delivered = new Set<string>();
  // What a check printed that couldn't be written down (id, newline, command).
  private memKept = new Map<string, KeptCheck>();
  // Schedules whose check this process has under way.
  private checkingNow = new Set<string>();
  // Runs sent here that the backend hasn't recorded yet, by runKey, oldest
  // first, and on disk (runsDir) for the next runner process. Until it
  // has, its row still says the run is due, and once the claim lapses
  // (2 minutes) that run would be sent again: THREADBEAR-15 (9 Nov), a
  // daily schedule sent twice when the M5's network dropped as it told the
  // backend and a self-update's new runner read the row 5 minutes later.
  // Each is laid over its row (overlayUnrecorded) and tried again every tick
  // until it lands.
  private unrecorded = new Map<string, HeldRun>();
  private recording = new Set<string>();
  // Claims this process holds while it checks, sends and records a run, by
  // schedule (hold): renewed before they lapse, as a check can run longer
  // than a claim lasts.
  private holds = new Map<string, Hold>();
  // One file a run, so two runner processes in a handover never write over
  // each other's (a list in one file would need a lock).
  private runsDir: string;

  constructor(deps: {
    runner: ScheduleRunner;
    home: string;
    clock: Clock;
    log: Logger;
    zone?: () => string;
    elsewhere?: (threadId: string) => boolean;
    folderElsewhere?: (threadId: string) => string | undefined;
    sendElsewhere?: (threadId: string, text: string, scheduleId: string, run: string, since: number, preserve?: boolean, ceiling?: PermissionMode) => Promise<{ turnId: string }>;
    dropElsewhere?: (threadId: string, scheduleId: string) => Promise<number>;
    // What a thread a draining runner has may do now, if known.
    accessElsewhere?: (threadId: string) => PermissionMode | undefined;
    // Its saved mode there, busy or not (bindOld).
    savedModeElsewhere?: (threadId: string) => PermissionMode | undefined;
    self?: SelfRunner;
    syncOn?: boolean;
    runCheck?: (p: { command: string; cwd: string; home: string; scheduleId: string; timeoutMs?: number }) => Promise<CheckResult>;
    // Box mode (box-mode.ts): this runner keeps no schedules at all. Every
    // way in that would make, change or run one throws this, and nothing
    // here ever arms a timer, runs a check or touches schedules.json.
    refuse?: string;
    // Where a move of the thread has got to (moves.ts MoveState), while it's moving from here.
    moving?: (threadId: string) => string | undefined;
  }) {
    this.refuse = deps.refuse;
    this.runner = deps.runner;
    this.home = deps.home;
    this.check = deps.runCheck ?? runCheck;
    this.self = deps.self ?? { id: 'runner', name: 'this Mac' };
    this.syncOn = deps.syncOn ?? false;
    this.elsewhere = deps.elsewhere ?? (() => false);
    this.folderElsewhere = deps.folderElsewhere;
    this.sendElsewhere = deps.sendElsewhere;
    this.accessElsewhere = deps.accessElsewhere;
    this.savedModeElsewhere = deps.savedModeElsewhere;
    this.dropElsewhere = deps.dropElsewhere;
    this.ceilingsFile = path.join(deps.home, 'schedule-ceilings.json');
    this.moving = deps.moving ?? (() => undefined);
    this.file = path.join(deps.home, 'schedules.json');
    this.runsDir = path.join(deps.home, 'schedule-runs');
    this.clock = deps.clock;
    this.log = deps.log;
    this.zone = deps.zone ?? localZone;
  }

  private readonly refuse?: string;

  // ------------------------------------------------------------ ceilings
  //
  // A schedule that sends to a thread was allowed for that thread as it was
  // when it was made: a thread on Ask could set one up for another on Ask.
  // If Mike raises the thread later, its runs would reach a more powerful
  // agent than the one that wrote them could have (Daybreak finding 162,
  // 22 Nov 2026). So each keeps a ceiling, the most access its thread may
  // have when a run reaches it, and a run to a thread above it isn't sent:
  // a repeating one is paused, and Mike is shown the thread with a note,
  // to read it and resume it (his resuming or changing it lifts the
  // ceiling). Mike's own (the app, tb, a Full thread's) have none (full).
  // A thread's schedule for itself has its own mode as it made it: after a
  // /clear or a compaction its words are no longer in what the agent
  // reads, and Mike may have raised it for other work (verify-fix of 162).
  // Kept on this Mac, beside schedules.json, never in the backend's row,
  // bound to the schedule's id, creation time and thread. One with none
  // kept (made before 22 Nov 2026, or a row that only came through the
  // backend) is bound the first time this runner sees it (bindOld, at
  // start and with each snapshot) at its maker's (`createdBy`) mode then,
  // so Mike's carry on as they were (on 22 Nov all 32 of his on the M5
  // were made by threads now on Full); one whose maker is gone, or that
  // names none, at Ask.
  private readonly ceilingsFile: string;
  private ceilings?: Record<string, { createdAt: string; threadId: string; ceiling: PermissionMode }>;

  // Read again when the file changes: the other runner of a handover
  // shares it.
  private ceilingsMtime?: number;
  private readCeilings(): Record<string, { createdAt: string; threadId: string; ceiling: PermissionMode }> {
    let mtime: number | undefined;
    try {
      mtime = fs.statSync(this.ceilingsFile).mtimeMs;
    } catch {
      mtime = undefined;
    }
    if (this.ceilings && mtime === this.ceilingsMtime) return this.ceilings;
    this.ceilingsMtime = mtime;
    const out: Record<string, { createdAt: string; threadId: string; ceiling: PermissionMode }> = {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.ceilingsFile, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
          const e = v as { createdAt?: unknown; threadId?: unknown; ceiling?: unknown } | null;
          if (e && typeof e.createdAt === 'string' && typeof e.threadId === 'string') out[id] = { createdAt: e.createdAt, threadId: e.threadId, ceiling: ceilingMode(e.ceiling) };
        }
      }
    } catch {
      // None yet.
    }
    this.ceilings = out;
    return out;
  }

  private writeCeilings(): void {
    try {
      const all = this.readCeilings();
      atomicWriteFileSync(this.ceilingsFile, JSON.stringify(all));
      this.ceilingsMtime = fs.statSync(this.ceilingsFile).mtimeMs;
    } catch (e) {
      // Kept in memory meanwhile; a restart without it counts the schedule
      // as one from before (ceilingOf), which never lifts a ceiling.
      this.log.warn("couldn't save schedule-ceilings.json", { error: String((e as Error)?.message ?? e) });
    }
  }

  private setCeiling(rec: ScheduleRecord, ceiling: PermissionMode): void {
    if (!rec.threadId || this.refuse) return;
    this.readCeilings()[rec.id] = { createdAt: rec.createdAt, threadId: rec.threadId, ceiling };
    this.writeCeilings();
  }

  private dropCeiling(scheduleId: string): void {
    const all = this.readCeilings();
    if (!(scheduleId in all)) return;
    delete all[scheduleId];
    this.writeCeilings();
  }

  // A schedule's ceiling by id, for a reminder queued before ceilings
  // (runner/ceiling.ts, legacyCeiling). One that's gone counts as Ask.
  ceilingById(scheduleId: string): PermissionMode {
    const rec = this.items.get(scheduleId);
    return rec?.threadId ? this.ceilingOf(rec) : rec ? 'full' : 'ask';
  }

  // A schedule's ceiling as kept here, or one from before bound now.
  private ceilingOf(rec: ScheduleRecord): PermissionMode {
    const kept = rec.threadId ? this.readCeilings()[rec.id] : undefined;
    if (kept && kept.createdAt === rec.createdAt && kept.threadId === rec.threadId) return kept.ceiling;
    return this.bindOld(rec) ?? 'ask';
  }

  // A schedule from before ceilings, bound as "Ceilings" says. Undefined
  // (and nothing kept) when it's a thread's own and that thread's mode
  // can't be read here yet (on a draining runner that doesn't say): it's
  // tried again later, and counts as Ask meanwhile.
  private bindOld(rec: ScheduleRecord): PermissionMode | undefined {
    if (!rec.threadId || this.refuse || !this.mine(rec)) return undefined;
    // Only one made before this runner first bound any: one made since
    // has had its own from the start, so with none kept (the file lost)
    // it's Ask, never bound afresh at what its maker has now.
    const before = Date.parse(rec.createdAt) < Date.parse(this.boundSince());
    const ceiling = !before ? 'ask' : rec.createdBy !== undefined ? this.savedMode(rec.createdBy) : 'ask';
    if (ceiling === undefined) return undefined;
    this.setCeiling(rec, ceiling);
    this.log.info("bound a schedule from before ceilings", { scheduleId: rec.id, ceiling });
    return ceiling;
  }

  // When this runner first bound schedules from before ceilings, kept in
  // a file of its own beside schedule-ceilings.json.
  private boundSinceAt?: string;
  private boundSince(): string {
    if (this.boundSinceAt) return this.boundSinceAt;
    const file = path.join(this.home, 'schedule-ceilings-since');
    try {
      const at = fs.readFileSync(file, 'utf8').trim();
      if (!Number.isNaN(Date.parse(at))) return (this.boundSinceAt = at);
    } catch {
      // First time.
    }
    const now = this.iso();
    try {
      atomicWriteFileSync(file, now);
    } catch (e) {
      this.log.warn("couldn't save schedule-ceilings-since", { error: String((e as Error)?.message ?? e) });
    }
    return (this.boundSinceAt = now);
  }

  private bindAllOld(): void {
    const kept = this.readCeilings();
    for (const rec of this.items.values()) {
      const k = rec.threadId ? kept[rec.id] : undefined;
      if (rec.threadId && !rec.finishedAt && !(k && k.createdAt === rec.createdAt && k.threadId === rec.threadId)) this.bindOld(rec);
    }
  }

  // A thread's saved mode (Plan first as Ask); Ask for one that isn't
  // here, or undefined while a draining runner has it and doesn't say.
  private savedMode(threadId: string): PermissionMode | undefined {
    if (this.elsewhere(threadId)) {
      const m = this.savedModeElsewhere?.(threadId);
      return m === undefined ? undefined : ceilingMode(m);
    }
    try {
      return ceilingMode(this.runner.get(threadId).permissionMode ?? 'ask');
    } catch {
      return 'ask';
    }
  }

  // What a thread's agent may do now. One that can't be known here (on a
  // draining runner that doesn't say, or busy there, where a turn may have
  // started with more) counts as full.
  private accessNow(threadId: string): PermissionMode {
    if (this.elsewhere(threadId)) return this.accessElsewhere?.(threadId) ?? 'full';
    try {
      return this.runner.accessOf?.(threadId) ?? 'full';
    } catch {
      return 'full';
    }
  }

  // Box mode: every way to make, change or run a schedule says why not.
  private refused(): void {
    if (this.refuse) throw new RpcError(ErrorCode.badParams, this.refuse);
  }

  start(): void {
    if (this.refuse) return;
    const saved = readJsonSync<{ version?: number; schedules?: ScheduleRecord[] }>(this.file);
    if (!saved && fs.existsSync(this.file)) this.log.error('schedules.json could not be read; starting with none', { file: this.file });
    // Version 2 is the backend's copy. With sync on it stays one (nothing is
    // sent until the backend is attached and says so); with sync turned off
    // since, this runner's own come back as its own file.
    const copy = saved?.version === 2;
    if (copy && this.syncOn) this.mode = 'backend';
    for (const s of saved?.schedules ?? []) {
      if (!s || typeof s.id !== 'string') continue;
      if (copy && !this.syncOn) {
        if (s.runnerId && s.runnerId !== this.self.id) continue;
        delete s.runnerId;
        delete s.runRequestedAt;
      }
      this.items.set(s.id, s);
      // The backend's copy from last time: one missing from its first
      // snapshot now was deleted while this runner was away.
      if (copy && this.syncOn) this.shown.add(s.id);
    }
    // A thread's schedules go with it.
    this.unlisten = this.runner.onNotification((n) => {
      if (n.method !== 'thread.deleted') return;
      let gone = false;
      for (const s of [...this.items.values()]) {
        if (s.threadId !== n.params.threadId || !this.mine(s)) continue;
        this.items.delete(s.id);
        this.dropKept(s.id);
        gone = true;
        if (this.mode === 'backend') void this.backend?.remove(s.id).catch((e) => this.log.warn('could not delete a schedule from the backend', { scheduleId: s.id, error: String(e) }));
      }
      if (gone) this.changed();
    });
    for (const r of this.readRuns()) this.unrecorded.set(runKey(r), r);
    // When ceilings started here, so only schedules from before are ever
    // bound at what their maker has (bindOld).
    this.boundSince();
    if (this.mode === 'local') this.bindAllOld();
    this.log.info('schedules loaded', { count: this.items.size, mode: this.mode, ...(this.unrecorded.size ? { unrecordedRuns: this.unrecorded.size } : {}) });
    this.tick();
  }

  /** Resolves once the checks under way have finished (and kept what they printed), or after limitMs (by default the longest one's own time limit). */
  async settled(limitMs = Math.max(CHECK_TIMEOUT_MS, ...this.inFlight.values()) + 5000): Promise<void> {
    if (!this.inFlight.size) {
      this.flushMemKept();
      return;
    }
    let timer: TimerHandle | undefined;
    const limit = new Promise<void>((r) => {
      timer = this.clock.setTimeout(r, limitMs);
    });
    await Promise.race([Promise.allSettled([...this.inFlight.keys()]), limit]);
    timer?.cancel();
    this.flushMemKept();
  }

  // What couldn't be written down when its check ran gets one more try
  // before the runner exits, so the next one finds it.
  private flushMemKept(): void {
    for (const [k, kept] of [...this.memKept]) {
      try {
        keepCheck(this.home, k.slice(0, k.indexOf('\n')), kept);
        this.memKept.delete(k);
      } catch {
        // Still can't; it goes with this process.
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.saveRetry?.cancel();
    for (const id of [...this.holds.keys()]) this.letGo(id);
    this.unlisten?.();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  // ---------------------------------------------------------- the backend

  /** Whether the schedules are the backend's (sync.ts stops mirroring them). */
  inBackend(): boolean {
    return this.mode === 'backend';
  }

  // Called by sync.ts after each heartbeat from a backend of API 9 or later.
  // The first time, this runner's own schedules.json goes up (if it wasn't
  // already the backend's copy), then the live copy starts. A failure is
  // logged and tried again on the next heartbeat; meanwhile a runner still
  // on its own file keeps sending from it.
  async attach(backend: ScheduleBackend): Promise<void> {
    if (this.refuse || this.backend || this.attaching || this.stopped) return;
    this.attaching = true;
    try {
      if (this.mode === 'local') await this.moveUp(backend);
      if (this.stopped) return;
      // No await between moveUp's last look and here, so nothing made in
      // the file meanwhile is left behind.
      this.mode = 'backend';
      this.backend = backend;
      this.changed();
      this.unsubscribe = backend.subscribe(
        (rows) => this.onRows(rows),
        (e) => this.log.warn('the schedules subscription failed', { error: String(e) }),
      );
      void this.refreshNames();
    } catch (e) {
      if (e instanceof HeldLocal) {
        // Said when what's held changes, not every heartbeat.
        const said = JSON.stringify(e.held);
        if (said !== JSON.stringify(this.held)) this.log.warn("schedules stay on this Mac: this runner's key can't put some in the backend, so none move until they can", { held: e.held.map((h) => ({ id: h.id, why: h.why })) });
        this.held = e.held;
      } else this.log.warn('could not move schedules to the backend; trying again later', { error: String(e) });
    } finally {
      this.attaching = false;
    }
  }

  /** Schedules kept in this runner's own file because the backend couldn't take them (shown in tb status). */
  heldLocal(): { id: string; why: string }[] {
    return this.held;
  }

  // Moves this runner's schedules.json up. The file keeps working while the
  // calls are out, so it looks again until a pass finds nothing made,
  // changed or deleted since the last one.
  private async moveUp(backend: ScheduleBackend): Promise<void> {
    // id -> the record as sent (not updatedAt: two changes can share a
    // millisecond).
    const sent = new Map<string, string>();
    let first = true;
    for (;;) {
      const now = [...this.items.values()];
      const fresh = now.filter((r) => !sent.has(r.id));
      const changed = now.filter((r) => sent.has(r.id) && sent.get(r.id) !== JSON.stringify(r));
      const gone = [...sent.keys()].filter((id) => !this.items.has(id));
      if (!first && !fresh.length && !changed.length && !gone.length) break;
      // The first pass always goes, even with none: it clears this runner's
      // mirrored rows.
      if (first || fresh.length) await this.adopt(backend, fresh.map((r) => this.stored({ ...r, runnerId: this.self.id })));
      for (const r of changed) await backend.save(this.stored({ ...r, runnerId: this.self.id }));
      for (const id of gone) await backend.remove(id);
      for (const r of [...fresh, ...changed]) sent.set(r.id, JSON.stringify(r));
      for (const id of gone) sent.delete(id);
      first = false;
    }
    for (const r of this.items.values()) r.runnerId = this.self.id;
    this.log.info('schedules moved to the backend', { count: sent.size });
  }

  // adoptSchedules is the main key's only (it clears mirrored rows from
  // before API 9, docs/protocol/keys.md "Runner keys"): a runner key's runner
  // saves its schedules one by one instead, which is all it needs.
  // Any held back means nothing moved: the file stays this runner's copy,
  // its schedules keep running from it, and nothing is lost (HeldLocal).
  private async adopt(backend: ScheduleBackend, rows: StoredSchedule[]): Promise<void> {
    let r: Awaited<ReturnType<ScheduleBackend['adopt']>>;
    try {
      r = await backend.adopt(rows);
    } catch (e) {
      if (!forbiddenText(e)) throw e;
      for (const row of rows) await backend.save(row);
      return;
    }
    const held = (r && typeof r === 'object' && Array.isArray(r.held) ? r.held : []).filter((h) => typeof h?.id === 'string');
    if (held.length) throw new HeldLocal(held);
    this.held = [];
  }

  private onRows(rows: StoredSchedule[]): void {
    if (this.stopped) return;
    const before = new Map(this.items);
    this.items.clear();
    for (const r of rows) {
      const { whenText: _w, ...rec } = r;
      // Another schedule under the same id (gone and made again, or moved
      // to another runner): what the old one's check printed isn't this
      // one's to send (stillClaimed).
      const was = before.get(rec.id);
      if (was && (was.createdAt !== rec.createdAt || was.runnerId !== rec.runnerId)) this.dropKept(rec.id);
      this.items.set(rec.id, rec);
      if (!this.names.has(rec.runnerId)) this.namesDue = true;
    }
    // Deleted elsewhere (the phone, the website, another Mac): its
    // messages still waiting for a busy thread here go too. A one-off is
    // finished as soon as its message is queued, so only one pruned a week
    // after that is left alone.
    const now = this.clock.now();
    for (const was of before.values()) {
      if (this.shown.has(was.id) && !this.items.has(was.id) && !(was.finishedAt && now - Date.parse(was.finishedAt) > KEEP_FINISHED_MS)) {
        this.deleted.add(was.id);
        this.dropQueued(was);
      }
    }
    this.shown = new Set(rows.map((r) => r.id));
    this.bindAllOld();
    this.overlayUnrecorded();
    if (this.namesDue) void this.refreshNames();
    this.changed();
    this.tick();
  }

  // The runners' names, for runnerName on each schedule: every runner the
  // backend has, gone quiet or not, since a schedule can name any of them.
  private async refreshNames(): Promise<void> {
    const list = await this.backend?.runners().catch(() => undefined);
    // (A runner key may not list runners: then only this one has a name.)
    if (!list) return;
    const before = JSON.stringify([...this.names, ...this.icons]);
    for (const r of list) this.learn(r);
    this.namesDue = false;
    if (JSON.stringify([...this.names, ...this.icons]) !== before) this.publish();
  }

  private learn(r: BackendRunner): void {
    this.names.set(r.id, r.name);
    if (r.icon) this.icons.set(r.id, r.icon);
  }

  /** runners.list: this runner first, then the backend's others by name. */
  async runners(): Promise<RunnerInfo[]> {
    const { id, name, icon, version, release, startedAt } = this.self;
    const me: RunnerInfo = { id, name, ...(icon ? { icon } : {}), online: true, self: true, ...(version ? { version } : {}), ...(release ? { release } : {}), ...(startedAt ? { startedAt } : {}) };
    if (!this.backend) return [me];
    const now = this.clock.now();
    // Only the main key lists every runner (docs/protocol/keys.md, "Runner keys"):
    // on a runner key, this runner is the only one there is.
    let all: BackendRunner[];
    try {
      all = await this.backend.runners();
    } catch (e) {
      if (forbiddenText(e)) return [me];
      throw e;
    }
    for (const r of all) this.learn(r);
    const others = all
      .filter((r) => r.id !== this.self.id && r.lastSeenAt !== undefined && now - r.lastSeenAt < FORGET_MS)
      .map((r) => ({
        id: r.id,
        name: r.name,
        ...(r.icon ? { icon: r.icon } : {}),
        online: r.lastSeenAt !== undefined && now - r.lastSeenAt < ONLINE_MS,
        ...(r.lastSeenAt !== undefined ? { lastSeenAt: new Date(r.lastSeenAt).toISOString() } : {}),
        self: false,
        ...(r.version ? { version: r.version } : {}),
        ...(r.release ? { release: r.release } : {}),
        ...(r.startedAt ? { startedAt: r.startedAt } : {}),
        ...(r.draining ? { draining: true } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [me, ...others];
  }

  // An id or a name from runners.list, as an id.
  private async resolveRunner(idOrName: string): Promise<string> {
    const want = idOrName.trim();
    if (want === this.self.id || want.toLowerCase() === this.self.name.toLowerCase()) return this.self.id;
    if (!this.backend) {
      throw bad(this.mode === 'backend' ? "Can't reach the backend to find that runner; try again in a moment." : 'Schedules on another runner need the Convex backend (sync on, API 9 or later).');
    }
    const list = await this.runners();
    const hit = list.find((r) => r.id === want) ?? list.find((r) => r.name.toLowerCase() === want.toLowerCase());
    if (!hit) throw bad(`No runner called ${want}. Runners: ${list.map((r) => r.name).join(', ')}.`);
    return hit.id;
  }

  // Ours to send: every one while they're our own file; in the backend,
  // the ones with our runnerId.
  private mine(rec: ScheduleRecord): boolean {
    return this.mode === 'local' || rec.runnerId === this.self.id;
  }

  private stored(rec: ScheduleRecord & { runnerId: string }): StoredSchedule {
    return { ...rec, whenText: this.whenText(rec) };
  }

  // Writes a made or changed schedule: to the backend, which answers once
  // it has it, or straight into the file.
  private async put(rec: ScheduleRecord): Promise<void> {
    if (this.mode === 'backend') {
      const b = this.mustHaveBackend();
      try {
        await b.save(this.stored({ ...rec, runnerId: rec.runnerId ?? this.self.id }));
      } catch (e) {
        throw new RpcError(ErrorCode.other, `Couldn't save the schedule to the backend: ${(e as Error).message ?? e}`);
      }
    }
    this.items.set(rec.id, rec);
    this.changed();
  }

  private mustHaveBackend(): ScheduleBackend {
    if (!this.backend) throw new RpcError(ErrorCode.other, "Schedules live in the Convex backend, which this runner can't reach right now; try again in a moment.");
    return this.backend;
  }

  // ---------------------------------------------------------------- reads

  // Every check this runner may run by itself, with the folder it runs in,
  // for writeRunsAsCode: an edit of what one reaches asks outside Full
  // access (Daybreak 126). Paused and finished ones too, as Resume and Run
  // now run them again without a new approval. One whose thread is on
  // another runner isn't ours to run.
  // `unknown`: another runner process is running a check whose marker
  // doesn't say what (an older release's, in a handover).
  localChecks(): { command: string; cwd: string }[] & { unknown?: boolean } {
    // And every check still running, though its schedule was changed or
    // deleted since it started, here or in the runner handing over: its
    // shell can still open a script, and a delete mid-run doesn't stop it
    // (verify-fix on Daybreak 126).
    const elsewhere = checksRunningElsewhere(this.home, this.clock.now());
    const out: { command: string; cwd: string }[] & { unknown?: boolean } = [...this.runningChecks.values(), ...elsewhere.checks];
    if (elsewhere.unknown) out.unknown = true;
    for (const rec of this.items.values()) {
      if (!rec.check || !this.mine(rec)) continue;
      const cwd = this.checkFolder(rec);
      if (cwd) out.push({ command: rec.check, cwd });
    }
    return out;
  }

  list(threadId?: string): Schedule[] {
    return this.listRecords(threadId).map((s) => this.view(s));
  }

  private listRecords(threadId?: string): ScheduleRecord[] {
    const rank = (s: ScheduleRecord): number => (s.nextRunAt && !s.paused ? 0 : s.finishedAt ? 2 : 1);
    return [...this.items.values()]
      .filter((s) => !threadId || s.threadId === threadId || s.createdBy === threadId)
      .sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r) return r;
        if (a.nextRunAt && b.nextRunAt && !a.paused && !b.paused) return a.nextRunAt.localeCompare(b.nextRunAt);
        if (a.finishedAt && b.finishedAt) return b.finishedAt.localeCompare(a.finishedAt);
        return b.createdAt.localeCompare(a.createdAt);
      });
  }

  // Frozen for a move (waiting for its turn, packed or on its way): a run
  // now would queue a message the bundle may already have been made
  // without, and a once-only one would finish, so the pack leaves it out.
  // It waits, and runs where the thread ends up (or here, if the move fails).
  private frozenForMove(threadId: string | undefined): boolean {
    const state = threadId ? this.moving(threadId) : undefined;
    return state === 'ready' || state === 'packing' || state === 'unpacking' || state === 'claimed' || state === 'done';
  }

  // Packed already: a new one to it couldn't go with it.
  private refusePacked(threadId: string): void {
    const state = this.moving(threadId);
    if (state === 'packing' || state === 'unpacking' || state === 'claimed' || state === 'done') throw new RpcError(ErrorCode.busy, "That thread is moving to another runner and has been packed already, so a schedule made now wouldn't go with it. Make it once the move is done.");
  }

  /** What a move of this thread carries: this runner's schedules to it still to run. With the main key, list shows other runners' too, and one of those can be the copy the runner it went to has just made (18 Nov). */
  forMove(threadId: string): Schedule[] {
    return this.list(threadId).filter((s) => s.threadId === threadId && !s.finishedAt && this.mine(s));
  }

  /**
   * Once a moved thread is the other runner's: deletes this runner's
   * schedules to it, never another runner's (its own copies, made again
   * when it took the thread). Returns those that weren't in `carried`
   * (made after the pack), which are logged; with no `carried` (a restart
   * since the pack), nothing is known to be missing.
   */
  async dropMoved(threadId: string, carried?: ReadonlySet<string>): Promise<Schedule[]> {
    const left: Schedule[] = [];
    for (const sc of this.list(threadId).filter((s) => s.threadId === threadId && this.mine(s))) {
      if (carried && !carried.has(sc.id) && !sc.finishedAt) left.push(sc);
      const rec = this.items.get(sc.id);
      if (rec) await this.deleteRecord(rec).catch((e) => this.log.warn("couldn't delete a moved thread's schedule", { scheduleId: sc.id, error: String(e) }));
    }
    if (left.length) this.log.warn("a moved thread's schedules made after it was packed stayed behind and were deleted", { threadId, scheduleIds: left.map((s) => s.id) });
    return left;
  }

  find(idOrPrefix: string): Schedule {
    return this.view(this.mustGet(idOrPrefix));
  }

  preview(p: { cron?: string; at?: string; timezone?: string; count?: number }): { whenText: string; runs: string[] } {
    const count = Math.min(Math.max(p.count ?? 5, 1), 20);
    const zone = p.timezone ? this.checkedZone(p.timezone) : undefined;
    if ((p.cron === undefined) === (p.at === undefined)) throw bad('Give either cron or at.');
    if (p.at !== undefined) {
      const t = this.parseAt(p.at);
      return { whenText: describeAt(t, zone ?? this.zone(), this.clock.now()), runs: [new Date(t).toISOString()] };
    }
    const spec = this.parsedCron(p.cron!);
    const runs = nextRuns(spec, this.clock.now(), zone ?? this.zone(), count);
    if (!runs.length) throw bad(`"${p.cron}" never runs.`);
    return { whenText: describeCron(spec, zone), runs: runs.map((t) => new Date(t).toISOString()) };
  }

  // ------------------------------------------------------------ mutations

  async create(p: CreateScheduleParams): Promise<Schedule> {
    this.refused();
    const text = p.text?.trim();
    if (!text) throw bad('text is required');
    if ((p.cron === undefined) === (p.at === undefined)) throw bad('Give either at (once) or cron (repeating).');
    const runnerId = p.runnerId?.trim() ? await this.resolveRunner(p.runnerId) : this.self.id;
    const away = runnerId !== this.self.id;
    if (p.accountId && p.poolId) throw bad('Give accountId or poolId, not both: a pool picks the login.');
    if (p.provider && !p.poolId) throw bad('provider is for a schedule with a poolId: a login has its own.');
    if (away && p.threadId) throw bad("A schedule that sends to a thread runs on that thread's runner; leave runnerId out.");
    if (p.threadId && p.starThreads) throw bad("starThreads is for a schedule that starts a new thread each time; star the thread itself instead.");
    const now = this.iso();
    const rec: ScheduleRecord = {
      id: crypto.randomUUID(),
      title: p.title?.trim() ? cutSafely(p.title.trim(), 200) : firstLine(text),
      text,
      paused: Boolean(p.paused),
      createdAt: now,
      updatedAt: now,
      runs: 0,
    };
    if (p.timezone) rec.timezone = this.checkedZone(p.timezone);
    if (p.at !== undefined) rec.at = new Date(this.parseAt(p.at)).toISOString();
    else rec.cron = this.parsedCron(p.cron!).source;
    if (p.threadId) {
      // Throws thread not found for a bad id.
      rec.threadId = this.elsewhere(p.threadId) ? p.threadId : this.runner.get(p.threadId).id;
      this.refusePacked(rec.threadId);
    } else if (away) {
      // Its folder and account are that runner's, checked there when it
      // runs; no folder means its default.
      if (p.cwd?.trim()) rec.cwd = p.cwd.trim();
      if (p.accountId) rec.accountId = p.accountId;
      if (p.poolId) rec.poolId = p.poolId;
      if (p.poolId && p.provider) rec.provider = p.provider;
      if (p.model) rec.model = p.model;
      if (p.effort) rec.effort = p.effort;
      if (p.permissionMode) rec.permissionMode = p.permissionMode;
      if (p.starThreads) rec.starThreads = true;
    } else {
      rec.cwd = this.checkedFolder(p.cwd);
      if (p.accountId) rec.accountId = this.checkedAccount(p.accountId);
      if (p.poolId) rec.poolId = this.checkedPool(p.poolId);
      if (p.poolId && p.provider) rec.provider = p.provider;
      if (p.model) rec.model = p.model;
      if (p.effort) rec.effort = p.effort;
      if (p.permissionMode) rec.permissionMode = p.permissionMode;
      if (p.starThreads) rec.starThreads = true;
    }
    if (p.check?.trim()) rec.check = checkedCheck(p.check);
    if (p.checkTimeoutSecs !== undefined) rec.checkTimeoutSecs = checkedTimeout(p.checkTimeoutSecs);
    if (p.createdBy) rec.createdBy = p.createdBy;
    if (this.mode === 'backend') rec.runnerId = runnerId;
    this.plan(rec);
    if (!away) this.approveCheck(rec, p.checkCard);
    // Before it's saved, so its first run can't come without it.
    if (rec.threadId) this.setCeiling(rec, p.ceiling ?? (p.createdBy === undefined ? 'full' : p.createdBy === rec.threadId ? (this.savedMode(rec.threadId) ?? 'ask') : 'ask'));
    await this.put(rec);
    // Packed while the save was out: it isn't in the bundle, so it doesn't stay.
    if (rec.threadId && this.mine(rec)) {
      try {
        this.refusePacked(rec.threadId);
      } catch (e) {
        await this.deleteRecord(rec).catch(() => undefined);
        throw e;
      }
    }
    // An `at` that's already passed runs now rather than on the next tick.
    this.tick();
    return this.view(this.items.get(rec.id) ?? rec);
  }

  // One at a time: each copies the record as it stands, so two at once
  // would have the later save put back what the earlier one changed (a
  // rename landing after a lowering would raise the mode back).
  private updating: Promise<unknown> = Promise.resolve();

  update(p: UpdateScheduleParams): Promise<Schedule> {
    if (this.refuse) return Promise.reject(new RpcError(ErrorCode.badParams, this.refuse));
    const run = this.updating.then(() => this.updateNow(p));
    this.updating = run.catch(() => undefined);
    return run;
  }

  private async updateNow(p: UpdateScheduleParams): Promise<Schedule> {
    // A copy, so a write the backend turns down changes nothing here.
    const rec: ScheduleRecord = structuredClone(this.mustGet(p.scheduleId));
    // The bundle has it as it was: a change now wouldn't go with it.
    if (rec.threadId && this.mine(rec)) this.refusePacked(rec.threadId);
    if (p.ifCheck !== undefined && rec.check !== p.ifCheck) throw bad("The schedule's check changed while the approval card was up, so nothing changed. Look at it again and ask again.");
    const away = !this.mine(rec);
    let replan = false;
    if (p.title !== undefined) rec.title = p.title.trim() ? cutSafely(p.title.trim(), 200) : firstLine(rec.text);
    if (p.text !== undefined) {
      if (!p.text.trim()) throw bad('text cannot be empty');
      rec.text = p.text.trim();
    }
    if (p.at !== undefined && p.cron !== undefined) throw bad('Give at or cron, not both.');
    if (p.timezone !== undefined) {
      if (p.timezone === null || p.timezone === '') delete rec.timezone;
      else rec.timezone = this.checkedZone(p.timezone);
      replan = true;
    }
    if (p.at !== undefined) {
      rec.at = new Date(this.parseAt(p.at)).toISOString();
      delete rec.cron;
      delete rec.finishedAt;
      replan = true;
    }
    if (p.cron !== undefined) {
      rec.cron = this.parsedCron(p.cron).source;
      delete rec.at;
      delete rec.finishedAt;
      replan = true;
    }
    if (p.paused !== undefined && p.paused !== rec.paused) {
      rec.paused = p.paused;
      replan = true;
    }
    if (p.check !== undefined) {
      // What an earlier check kept stays with that command (readKeptCheck):
      // news no thread has seen yet is sent if that check is put back.
      if (p.check === null || !p.check.trim()) delete rec.check;
      else rec.check = checkedCheck(p.check);
    }
    if (p.checkTimeoutSecs !== undefined) {
      // Kept with the check taken off, so putting one back keeps its time.
      if (p.checkTimeoutSecs === null) delete rec.checkTimeoutSecs;
      else rec.checkTimeoutSecs = checkedTimeout(p.checkTimeoutSecs);
    }
    if (!rec.threadId) {
      if (p.cwd !== undefined) rec.cwd = away ? p.cwd.trim() || undefined : this.checkedFolder(p.cwd);
      if (rec.cwd === undefined) delete rec.cwd;
      if (p.accountId !== undefined && p.poolId) throw bad('Give accountId or poolId, not both: a pool picks the login.');
      // One or the other, as threads.update has it: a login pins it, a
      // pool picks one each run.
      if (p.accountId !== undefined) {
        rec.accountId = away ? p.accountId : this.checkedAccount(p.accountId);
        delete rec.poolId;
      }
      if (p.poolId === null || p.poolId === '') delete rec.poolId;
      else if (p.poolId !== undefined) {
        rec.poolId = away ? p.poolId : this.checkedPool(p.poolId);
        delete rec.accountId;
      }
      if (p.model !== undefined) setOrDelete(rec, 'model', p.model);
      // The kind goes with the pool and model it was picked with: one
      // changed without it is the new model's kind again, not a model of
      // one kind sent to a login of another.
      if (p.provider !== undefined) {
        if (p.provider === null) delete rec.provider;
        else rec.provider = p.provider;
      } else if (p.poolId !== undefined || p.model !== undefined || p.accountId !== undefined) delete rec.provider;
      if (!rec.poolId) {
        if (p.provider) throw bad('provider is for a schedule with a poolId: a login has its own.');
        delete rec.provider;
      }
      if (p.effort !== undefined) setOrDelete(rec, 'effort', p.effort);
      if (p.permissionMode !== undefined) rec.permissionMode = p.permissionMode;
      if (p.starThreads === true) rec.starThreads = true;
      else if (p.starThreads === false) delete rec.starThreads;
    } else if (p.starThreads) {
      throw bad("starThreads is for a schedule that starts a new thread each time; star the thread itself instead.");
    } else if ([p.cwd, p.accountId, p.poolId, p.provider, p.model, p.effort, p.permissionMode].some((x) => x !== undefined)) {
      throw bad("This schedule sends to a thread, so it has no folder, account or model of its own; change the thread's.");
    }
    rec.updatedAt = this.iso();
    if (replan) this.plan(rec);
    // New words, or resuming it, are the changer's: Mike's lift its ceiling,
    // a thread's lower it to its own if that's less ("Ceilings").
    const was = this.items.get(rec.id);
    // A new check too: what it prints goes into each run's message.
    const reworded = (p.text !== undefined && p.text.trim() !== was?.text) || (p.title !== undefined && rec.title !== was?.title) || (p.paused === false && was?.paused === true) || (p.check !== undefined && rec.check !== was?.check);
    const ceiling = rec.threadId && reworded && p.ceiling !== undefined && !p.keepCeiling ? (p.ceiling === 'full' ? 'full' : lowerMode(this.ceilingOf(rec), ceilingMode(p.ceiling))) : undefined;
    // Passing the check again approves it as it is now. Nothing else does,
    // a new folder included: approval is bound to the folder, so one moved
    // is held there until the check is passed again (from a thread that
    // asks first, a card). The apps' editors send the folder with every
    // save and show no check, so a save meant to change the title once
    // approved whatever a pull had changed the check's scripts to
    // (security review, 11 Nov 2026).
    if (!away && p.check !== undefined) this.approveCheck(rec, p.checkCard);
    // A lowered one before the save, a lifted one after it: a run in
    // between goes by the lower.
    if (ceiling !== undefined && raises(this.ceilingOf(rec), ceiling)) this.setCeiling(rec, ceiling);
    await this.put(rec);
    if (ceiling !== undefined && ceiling !== this.ceilingOf(rec)) this.setCeiling(rec, ceiling);
    this.tick();
    return this.view(rec);
  }

  async delete(scheduleId: string): Promise<Record<string, never>> {
    this.refused();
    const rec = this.mustGet(scheduleId);
    if (rec.threadId && this.mine(rec)) this.refusePacked(rec.threadId);
    return this.deleteRecord(rec);
  }

  private async deleteRecord(rec: ScheduleRecord): Promise<Record<string, never>> {
    if (this.mode === 'backend') {
      try {
        await this.mustHaveBackend().remove(rec.id);
      } catch (e) {
        if (e instanceof RpcError) throw e;
        throw new RpcError(ErrorCode.other, `Couldn't delete the schedule from the backend: ${(e as Error).message ?? e}`);
      }
    }
    this.items.delete(rec.id);
    this.dropKept(rec.id);
    this.dropCeiling(rec.id);
    this.deleted.add(rec.id);
    this.dropQueued(rec);
    this.changed();
    return {};
  }

  wasDeleted(scheduleId: string): boolean {
    return this.deleted.has(scheduleId);
  }

  // A deleted schedule's messages still waiting behind a busy turn go
  // with it, rather than arriving after delete_schedule said Deleted.
  private dropQueued(rec: ScheduleRecord): void {
    const threadId = rec.threadId;
    if (!threadId) return;
    const failed = (e: unknown) => this.log.warn("could not drop a deleted schedule's queued messages", { scheduleId: rec.id, threadId, error: String(e) });
    if (this.elsewhere(threadId)) {
      void this.dropElsewhere?.(threadId, rec.id).catch(failed);
      return;
    }
    try {
      this.runner.dropScheduled(threadId, rec.id);
    } catch (e) {
      failed(e);
    }
  }

  // Runs it now, as if it were due. A repeating one keeps its next time.
  // Another runner's is asked for through the backend, and runs there.
  // `by`: who pressed it, as a ceiling ("Ceilings"): their pressing sends
  // the words as theirs, so this run goes by the higher of that and the
  // schedule's own. Left out, Mike (full), as from the app or tb; the RPC
  // gate says a thread's own.
  async runNow(scheduleId: string, by: PermissionMode = 'full'): Promise<{ schedule: Schedule; threadId?: string; turnId?: string; queued?: boolean }> {
    this.refused();
    if (this.runningNow.has(scheduleId)) throw new RpcError(ErrorCode.busy, 'This schedule is already being run; try again in a moment.');
    this.runningNow.add(scheduleId);
    try {
      return await this.runNowOnce(scheduleId, by);
    } finally {
      this.runningNow.delete(scheduleId);
    }
  }

  private async runNowOnce(scheduleId: string, by: PermissionMode): Promise<{ schedule: Schedule; threadId?: string; turnId?: string; queued?: boolean }> {
    const rec = this.mustGet(scheduleId);
    if (this.mine(rec) && this.frozenForMove(rec.threadId)) throw new RpcError(ErrorCode.busy, 'That thread is moving to another runner; this runs once the move is done.');
    if (!this.mine(rec)) {
      const at = this.iso();
      const ok = await this.mustHaveBackend()
        .requestRun(rec.id, at)
        .catch((e) => {
          throw new RpcError(ErrorCode.other, `Couldn't ask its runner to run it: ${(e as Error).message ?? e}`);
        });
      if (!ok) throw new RpcError(ErrorCode.scheduleNotFound, `No schedule ${scheduleId}`);
      rec.runRequestedAt = at;
      this.changed();
      return { schedule: this.view(rec), queued: true };
    }
    this.notMidCheck(rec);
    const res = await this.send(rec, true, this.keptFor(rec), undefined, by);
    if (res.outcome !== 'sent') throw new RpcError(ErrorCode.other, res.note ?? "Couldn't run it.");
    // A one-off run now has used its time: that slot isn't due again.
    const slot = rec.at ? rec.nextRunAt : undefined;
    if (this.mode === 'local') this.completeLocal(rec, rec.at ?? rec.nextRunAt, true);
    else if (rec.at) this.finish(rec);
    if (this.mode === 'backend') await this.recordRun(rec, true, undefined, slot);
    this.changed();
    return { schedule: this.view(rec), threadId: res.threadId!, turnId: res.turnId! };
  }

  // Tells the backend about a run this runner sent (or skipped, or
  // couldn't send), with the schedule's next time. A run that was sent
  // stays sent; one the backend can't be told of yet is written down first
  // and tried again until it lands (`unrecorded` says why).
  // `slot`: the nextRunAt a due run was claimed at.
  private async recordRun(rec: ScheduleRecord, sent: boolean, request?: string, slot?: string): Promise<void> {
    if (!this.backend || !rec.lastRun) return;
    const run: UnrecordedRun = {
      scheduleId: rec.id,
      lastRun: { ...rec.lastRun },
      sent,
      expectUpdatedAt: rec.updatedAt,
      ...(rec.nextRunAt ? { nextRunAt: rec.nextRunAt } : {}),
      ...(rec.finishedAt ? { finishedAt: rec.finishedAt } : {}),
      ...(request ? { request } : {}),
      since: this.clock.now(),
      ...(slot ? { slot } : {}),
    };
    this.unrecorded.set(runKey(run), run);
    // On disk before it's sent: if this process goes before the backend
    // answers, the next one still knows the run happened.
    this.saveRun(run);
    await this.recordRuns(rec.id);
  }

  // Tells the backend about a schedule's unrecorded runs, oldest first,
  // stopping at the first that fails (tried again next tick).
  private async recordRuns(scheduleId: string): Promise<void> {
    const backend = this.backend;
    if (!backend) return;
    for (const [key, run] of [...this.unrecorded]) {
      if (run.scheduleId !== scheduleId || run.acked) continue;
      // Already being told (a run now while a tick is at it): in order, so
      // the rest wait for it too.
      if (this.recording.has(key)) return;
      this.recording.add(key);
      try {
        const { since: _s, slot: _sl, tries: _t, warned: _w, acked: _a, ...p } = run;
        await backend.ran(p);
        // A yes for what was sent: if an edit came in meanwhile and the run
        // took its updatedAt (overlayUnrecorded), it's told again with that.
        if (run.expectUpdatedAt === p.expectUpdatedAt) run.acked = true;
        if (run.tries) this.log.info('recorded a schedule run in the backend after retrying', { scheduleId, tries: run.tries });
      } catch (e) {
        run.tries = (run.tries ?? 0) + 1;
        const late = this.clock.now() - run.since > UNRECORDED_WARN_MS;
        if (late && !run.warned) {
          run.warned = true;
          this.log.warn('a schedule run still is not recorded in the backend', { scheduleId, tries: run.tries, error: String(e) });
        } else if (run.tries === 1) this.log.info('could not record a schedule run in the backend yet; trying again', { scheduleId, error: String(e) });
        return;
      } finally {
        this.recording.delete(key);
      }
    }
  }

  // Each unrecorded run laid over its row as the backend will have it once
  // told: its last run, its count and its next time, so the row a
  // subscription (or the next runner) brings back doesn't make it due again.
  // It's forgotten once the row shows it recorded and past its slot (or a
  // later run), or the schedule has gone, or gone to another runner.
  // A row edited elsewhere (another Mac's rename) while the run was out
  // has a new updatedAt, so scheduleRan won't take the run's next time; if
  // it still says the slot that ran, the run takes that updatedAt and is
  // told again (Codex's review). scheduleRan counts a run it has once.
  private overlayUnrecorded(): void {
    for (const [key, run] of [...this.unrecorded]) {
      const rec = this.items.get(run.scheduleId);
      if (!rec || !this.mine(rec) || (rec.lastRun && rec.lastRun.at > run.lastRun.at)) {
        this.forgetRun(key);
        continue;
      }
      const recorded = sameRun(rec.lastRun, run.lastRun);
      const stale = run.slot !== undefined && rec.nextRunAt === run.slot && !rec.paused;
      if ((recorded || run.acked) && !stale) {
        this.forgetRun(key);
        continue;
      }
      if (stale && rec.updatedAt !== run.expectUpdatedAt) {
        run.expectUpdatedAt = rec.updatedAt;
        run.acked = false;
        this.saveRun(run);
      } else if (stale && run.acked) run.acked = false;
      if (!recorded) {
        rec.lastRun = { ...run.lastRun };
        if (run.sent) rec.runs += 1;
      }
      if (run.request !== undefined && rec.runRequestedAt === run.request) delete rec.runRequestedAt;
      // As scheduleRan does: a change since worked out its own next time.
      if (rec.updatedAt === run.expectUpdatedAt) {
        if (run.nextRunAt) rec.nextRunAt = run.nextRunAt;
        else delete rec.nextRunAt;
        if (run.finishedAt) rec.finishedAt = run.finishedAt;
      }
    }
  }

  // Whether this slot of a schedule has already run here, waiting to be
  // recorded: it's never claimed again.
  private slotRan(scheduleId: string, slot: string): boolean {
    for (const r of this.unrecorded.values()) if (r.scheduleId === scheduleId && r.slot === slot) return true;
    return false;
  }

  // A claim held for a schedule (backendTick, runRequested), renewed every
  // CLAIM_RENEW_MS until it's released or a renewal says it isn't ours any
  // more: the run is recorded and its slot has moved on (or its request
  // gone), or another holder has it. Kept through a record that hasn't got
  // through, or one that left the slot due (an edit came in meanwhile, and
  // it's told again), so another process can't claim the run and send it
  // again meanwhile.
  private hold(backend: ScheduleBackend, scheduleId: string, kind: 'due' | 'request', expect: string): void {
    this.letGo(scheduleId);
    const h: Hold = { kind, expect, lost: false };
    this.holds.set(scheduleId, h);
    const renew = () => {
      h.timer = this.clock.setTimeout(() => {
        if (this.holds.get(scheduleId) !== h || this.stopped) return;
        void backend
          .claim(scheduleId, kind, expect)
          .then((ok) => {
            if (ok) return;
            h.lost = true;
            if (this.holds.get(scheduleId) === h) this.holds.delete(scheduleId);
          })
          // Not heard: kept, and tried again (confirmed asks before a send).
          .catch(() => {})
          .finally(() => {
            if (this.holds.get(scheduleId) === h) renew();
          });
      }, CLAIM_RENEW_MS);
    };
    renew();
  }

  private letGo(scheduleId: string): void {
    const h = this.holds.get(scheduleId);
    if (!h) return;
    h.timer?.cancel();
    this.holds.delete(scheduleId);
  }

  private async release(backend: ScheduleBackend, scheduleId: string): Promise<void> {
    this.letGo(scheduleId);
    await backend.release(scheduleId).catch(() => {});
  }

  // Whether the claim held for a schedule is still this process's, asked
  // of the backend just before a send. No (or no answer): it's let go and
  // the run waits for the next tick, where it's claimed afresh.
  private async confirmed(backend: ScheduleBackend, scheduleId: string): Promise<boolean> {
    const h = this.holds.get(scheduleId);
    if (!h || h.lost) return false;
    const ok = await backend.claim(scheduleId, h.kind, h.expect).catch(() => false);
    if (ok && this.holds.get(scheduleId) === h) return true;
    if (this.holds.get(scheduleId) === h) await this.release(backend, scheduleId);
    return false;
  }

  // Whether another process of this runner (the other side of a handover,
  // sharing this data folder) has already sent that run and is still
  // telling the backend: its saved run is taken on here too, so this one
  // doesn't send it again and helps record it (scheduleRan counts it once).
  private ranElsewhere(scheduleId: string, same: (r: UnrecordedRun) => boolean): boolean {
    let found = false;
    for (const r of this.readRuns()) {
      if (r.scheduleId !== scheduleId || !same(r)) continue;
      if (!this.unrecorded.has(runKey(r))) this.unrecorded.set(runKey(r), r);
      found = true;
    }
    return found;
  }

  private hasUnrecorded(scheduleId: string): boolean {
    for (const r of this.unrecorded.values()) if (r.scheduleId === scheduleId) return true;
    return false;
  }

  private forgetRun(key: string): void {
    if (!this.unrecorded.delete(key)) return;
    try {
      fs.rmSync(this.runFile(key), { force: true });
    } catch (e) {
      // Left behind, it's dropped by the next runner once it sees the row.
      this.log.warn('could not remove a recorded schedule run', { error: String(e) });
    }
  }

  private runFile(key: string): string {
    return path.join(this.runsDir, `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  }

  private saveRun(run: HeldRun): void {
    const { tries: _t, warned: _w, acked: _a, ...r } = run;
    try {
      fs.mkdirSync(this.runsDir, { recursive: true });
      atomicWriteFileSync(this.runFile(runKey(r)), `${JSON.stringify(r)}\n`);
    } catch (e) {
      // Still held here, so this process won't send it again.
      this.log.warn('could not save a schedule run waiting to be recorded', { scheduleId: r.scheduleId, error: String(e) });
    }
  }

  // Oldest first, as they're told to the backend in that order.
  private readRuns(): UnrecordedRun[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.runsDir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const runs: UnrecordedRun[] = [];
    for (const n of names) {
      const r = readJsonSync<UnrecordedRun>(path.join(this.runsDir, n));
      const ok =
        !!r && typeof r.scheduleId === 'string' && typeof r.lastRun?.at === 'string' && typeof r.lastRun?.outcome === 'string' && typeof r.sent === 'boolean' && typeof r.expectUpdatedAt === 'string' && typeof r.since === 'number';
      if (ok) runs.push(r);
    }
    return runs.sort((a, b) => a.lastRun.at.localeCompare(b.lastRun.at));
  }

  // ------------------------------------------------------------------ runs

  private tick(): void {
    if (this.refuse) return;
    if (this.mode === 'backend') {
      void this.backendTick();
      return;
    }
    this.timer?.cancel();
    this.timer = undefined;
    if (this.stopped) return;
    const now = this.clock.now();
    const changed = this.prune(now);
    // Any from before ceilings whose thread couldn't be read at start.
    this.bindAllOld();
    for (const rec of [...this.items.values()]) {
      if (rec.paused || !rec.nextRunAt || Date.parse(rec.nextRunAt) > now) continue;
      if (this.checking.has(rec.id) || this.frozenForMove(rec.threadId)) continue;
      // Keep a run in flight through its send too: a handover's RPC is
      // asynchronous, and a new tick mustn't send the same local slot again.
      this.checking.add(rec.id);
      void this.checked(rec).then(async (checked) => {
        if (this.stopped) return;
        if (!this.items.has(rec.id)) {
          this.dropKept(rec.id);
          return;
        }
        if (checked === 'later' || this.frozenForMove(rec.threadId)) return;
        const slot = rec.nextRunAt;
        const res = await this.send(rec, false, checked);
        if (res.outcome === 'retry') return;
        this.completeLocal(rec, slot);
        this.changed();
        // Replan from the next slot, rather than the old slot's retry timer.
        this.tick();
      }).finally(() => this.checking.delete(rec.id));
    }
    if (changed) this.changed();
    let next = Infinity;
    for (const rec of this.items.values()) {
      if (!rec.paused && rec.nextRunAt) next = Math.min(next, Date.parse(rec.nextRunAt));
    }
    // Something still due (waiting out a restart) is tried again on the
    // next regular check, not straight away over and over.
    const wait = next <= now ? TICK_MS : Math.min(next - now, TICK_MS);
    this.timer = this.clock.setTimeout(() => this.tick(), wait);
  }

  // An edit replaces the local record while a send waits for its reply.
  // Carry the result into that record, preserving a newly booked time.
  private completeLocal(rec: ScheduleRecord, slot: string | undefined, manual = false): void {
    const live = this.items.get(rec.id);
    if (!live || live.createdAt !== rec.createdAt) return;
    live.lastRun = rec.lastRun;
    live.runs = Math.max(live.runs, rec.runs);
    if (live.at) {
      // Pausing clears nextRunAt, but doesn't undo a send already accepted.
      if (live.at === slot) this.finish(live);
      return;
    }
    if (live.nextRunAt === slot && !manual) this.plan(live);
  }

  // The backend's version of tick: the same runs, each taken with a claim
  // before it's sent, then recorded with the next time. Also the
  // schedules.run requests other runners left for ours. Nothing is sent
  // until the backend is attached.
  private async backendTick(): Promise<void> {
    if (this.refuse) return;
    this.timer?.cancel();
    this.timer = undefined;
    if (this.stopped) return;
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    const backend = this.backend;
    if (!backend) return;
    this.ticking = true;
    this.tickAgain = false;
    try {
      const now = this.clock.now();
      for (const row of [...this.items.values()]) {
        let rec = row;
        if (!this.mine(rec)) continue;
        if (this.dispatching.has(rec.id) || this.sending.has(rec.id)) continue;
        if (rec.finishedAt && now - Date.parse(rec.finishedAt) > KEEP_FINISHED_MS) {
          await backend.remove(rec.id).catch(() => {});
          this.items.delete(rec.id);
          this.dropKept(rec.id);
          continue;
        }
        if (this.hasUnrecorded(rec.id)) await this.recordRuns(rec.id);
        if (rec.runRequestedAt && !this.frozenForMove(rec.threadId)) {
          if (rec.threadId && this.elsewhere(rec.threadId)) {
            this.dispatching.add(rec.id);
            void this.runRequested(backend, rec).catch((e) => this.log.warn('could not finish a requested schedule run', { scheduleId: rec.id, error: String(e) }))
              .finally(() => this.dispatching.delete(rec.id));
            continue;
          }
          await this.runRequested(backend, rec);
        }
        if (rec.paused || !rec.nextRunAt || Date.parse(rec.nextRunAt) > now) continue;
        if (this.frozenForMove(rec.threadId)) continue;
        if (this.slotRan(rec.id, rec.nextRunAt) || this.ranElsewhere(rec.id, (r) => r.slot === rec.nextRunAt)) continue;
        const due = rec.nextRunAt;
        const claimed = await backend.claim(rec.id, 'due', due).catch((e) => {
          this.log.warn('could not claim a schedule run', { scheduleId: rec.id, error: String(e) });
          return false;
        });
        if (!claimed || this.stopped) continue;
        this.hold(backend, rec.id, 'due', due);
        // The record as it is now: the subscription may have brought a
        // newer one (its check changed) or none (deleted, maybe by another
        // runner) while the claim was out, and again while it checked.
        const fresh = this.stillDue(backend, rec, due);
        if (!fresh) continue;
        rec = fresh;
        // What the check runs as: the record can change in place while it
        // runs and while the claim is confirmed below, and its result is
        // only for that command in that folder (Codex's review).
        const checkedAs = { command: rec.check, folder: rec.check ? this.checkFolder(rec) : undefined };
        const checked = await this.checked(rec);
        if (this.stopped) continue;
        const after = this.stillDue(backend, rec, due);
        if (!after) continue;
        rec = after;
        if (checked === 'later') {
          await this.release(backend, rec.id);
          continue;
        }
        const slot = rec.nextRunAt;
        // Still ours, just before it goes: the check may have outlasted a
        // renewal that didn't get through.
        if (!(await this.confirmed(backend, rec.id))) continue;
        // And the row as it is after that wait: paused, deleted or its
        // check changed meanwhile, it isn't sent (Codex's review).
        const sending = this.stillDue(backend, rec, due);
        if (!sending) continue;
        // Frozen for a move while its check ran: it waits (frozenForMove).
        if (this.frozenForMove(sending.threadId)) {
          await this.release(backend, rec.id);
          continue;
        }
        // Checked in one folder with one command: either changed, its
        // result isn't this run's (Codex's review).
        if (sending.check !== checkedAs.command || (sending.check && this.checkFolder(sending) !== checkedAs.folder)) {
          // What it printed was for that command in that folder: the next
          // try checks afresh rather than carry it.
          if (sending.check === checkedAs.command) this.dropKept(rec.id);
          await this.release(backend, rec.id);
          continue;
        }
        rec = sending;
        if (rec.threadId && this.elsewhere(rec.threadId)) {
          this.dispatching.add(rec.id);
          void this.send(rec, false, checked).then(async (res) => {
            if (res.outcome === 'retry') {
              await this.release(backend, rec.id);
              return;
            }
            if (rec.at) this.finish(rec);
            else this.plan(rec);
            await this.recordRun(rec, res.outcome === 'sent', undefined, slot);
            this.changed();
          }).catch((e) => this.log.warn('could not finish a scheduled send to the old runner', { scheduleId: rec.id, error: String(e) }))
            .finally(() => this.dispatching.delete(rec.id));
          continue;
        }
        const res = await this.send(rec, false, checked);
        if (res.outcome === 'retry') {
          await this.release(backend, rec.id);
          continue;
        }
        if (rec.at) this.finish(rec);
        else this.plan(rec);
        await this.recordRun(rec, res.outcome === 'sent', undefined, slot);
      }
      this.changed();
    } finally {
      this.ticking = false;
    }
    if (this.stopped) return;
    if (this.tickAgain) {
      this.timer = this.clock.setTimeout(() => this.tick(), 0);
      return;
    }
    let next = Infinity;
    const now = this.clock.now();
    for (const rec of this.items.values()) {
      if (!this.mine(rec)) continue;
      if (!rec.paused && rec.nextRunAt) next = Math.min(next, Date.parse(rec.nextRunAt));
      if (rec.runRequestedAt) next = now;
    }
    const wait = next <= now ? TICK_MS : Math.min(next - now, TICK_MS);
    this.timer = this.clock.setTimeout(() => this.tick(), wait);
  }

  // A schedules.run another runner asked for: sent as if run here.
  private async runRequested(backend: ScheduleBackend, row: ScheduleRecord): Promise<void> {
    const request = row.runRequestedAt!;
    if (this.ranElsewhere(row.id, (r) => r.request === request)) return;
    const claimed = await backend.claim(row.id, 'request', request).catch(() => false);
    if (!claimed || this.stopped) return;
    this.hold(backend, row.id, 'request', request);
    // As it is now (backendTick says why): deleted meanwhile, or no longer
    // the one claimed, it isn't sent.
    let rec = this.stillClaimed(backend, row);
    if (!rec) return;
    if (!(await this.confirmed(backend, rec.id))) return;
    // As it is after that wait (backendTick says why).
    const sending = this.stillClaimed(backend, rec);
    if (!sending || sending.runRequestedAt !== request) {
      if (sending) await this.release(backend, rec.id);
      return;
    }
    rec = sending;
    let res: Awaited<ReturnType<Scheduler['send']>>;
    try {
      this.notMidCheck(rec);
      res = await this.send(rec, true, this.keptFor(rec), `request:${request}`);
    } catch (e) {
      // Busy (a restart, or its thread finishing on the old runner): leave
      // the request for the next look.
      if (e instanceof RpcError && e.code === ErrorCode.busy) {
        await this.release(backend, rec.id);
        return;
      }
      throw e;
    }
    const slot = res.outcome === 'sent' && rec.at ? rec.nextRunAt : undefined;
    if (res.outcome === 'sent' && rec.at) this.finish(rec);
    delete rec.runRequestedAt;
    await this.recordRun(rec, res.outcome === 'sent', request, slot);
  }

  private stillDue(backend: ScheduleBackend, claimed: ScheduleRecord, slot: string): ScheduleRecord | undefined {
    const rec = this.stillClaimed(backend, claimed);
    if (!rec) return undefined;
    if (!rec.paused && !rec.finishedAt && rec.nextRunAt === slot) return rec;
    // Run now or an edit can consume this slot while its claim/check waits.
    void this.release(backend, rec.id);
    return undefined;
  }

  // The schedule a claim was taken for, as the subscription has it now, or
  // undefined when that one isn't there to send any more: deleted, moved to
  // another runner, or a different schedule under the same id. The claim
  // was the backend saying this runner may send that row; a row that came in
  // under its id meanwhile wasn't claimed. Daybreak's finding (6 Nov): the
  // owner deletes a schedule while its check runs, a runner key saves one
  // of its own under the gone id (same check, its own text, Full access),
  // and the main Mac's subscription, which has every runner's rows, handed
  // the new row to send() in place of the claimed one. So it must still be
  // this runner's (only the owner key or this runner's own can write a row
  // with our runnerId) and the same schedule (createdAt, which update
  // keeps). Its kept check output went with the old one (onRows).
  private stillClaimed(backend: ScheduleBackend, claimed: ScheduleRecord): ScheduleRecord | undefined {
    const now = this.items.get(claimed.id);
    if (now && this.mine(now) && now.createdAt === claimed.createdAt) return now;
    // Let go, in case the claim is still on a row of ours (moved away keeps
    // it): only the holder's is cleared.
    if (now) void this.release(backend, claimed.id);
    else {
      this.letGo(claimed.id);
      this.dropKept(claimed.id);
    }
    return undefined;
  }

  // Its check, when it has one and checks are on (schedule-check.ts):
  // undefined to run as usual.
  // 'later': not now, leave it due (its check is running in another runner
  // process, or the check was changed while it ran).
  private async checked(rec: ScheduleRecord): Promise<{ skip: string } | Carried | 'later' | undefined> {
    if (!rec.check) return undefined;
    const cwd = this.checkFolder(rec);
    // A handover can briefly have neither a local thread nor its peer's
    // summary. Wait for its real folder rather than run or approve in home.
    // A thread that's gone has no check to run; send records that failure.
    if (!cwd) return rec.threadId && this.elsewhere(rec.threadId) ? 'later' : undefined;
    // What it printed last time and no run has carried yet (a restart
    // refused the send, or the runner stopped mid-check): send that rather
    // than asking again, as a check that keeps state won't print it twice.
    const command = rec.check;
    const id = rec.id;
    const timeoutMs = checkLimitMs(rec.checkTimeoutSecs);
    const kept = this.keptFor(rec);
    if (kept) return kept;
    if (checkRunningElsewhere(this.home, id, this.clock.now())) return 'later';
    // Approved once, it runs unattended from then on, so it must still be
    // what was approved: the command, in this folder, reaching these bytes.
    // Read afresh now. What's in a row isn't enough, as the backend's row
    // says what to run but only this runner's own store says it was approved.
    const hold = this.heldCheck(command, cwd, id);
    if (hold) return hold;
    const runKey = `${id}\n${this.clock.now()}\n${Math.random()}`;
    this.runningChecks.set(runKey, { command, cwd });
    try {
      markCheckRunning(this.home, id, this.clock.now(), timeoutMs, { command, cwd });
    } catch {
      // It still runs; another process just can't see it is.
    }
    const run = this.check({ command, cwd, home: this.home, scheduleId: id, timeoutMs })
      .catch((e: unknown) => ({ ok: false as const, output: '', why: String(e) }))
      .then((r) => {
        const out = checkOutcome(r);
        // Deleted meanwhile: nothing to send it with.
        const now = this.items.get(id);
        if (!now) return 'later' as const;
        let res: typeof out | Carried = out;
        if ('extra' in out) {
          const kept = { check: command, at: this.iso(), extra: out.extra, cwd };
          try {
            keepCheck(this.home, id, kept);
          } catch (e) {
            // Kept in memory instead, so at least this process's next try
            // doesn't run the check again and lose it.
            this.memKept.set(`${id}\n${command}`, kept);
            this.log.warn("could not keep a schedule check's output", { scheduleId: id, error: String(e) });
          }
          res = { extra: out.extra, kept: kept.at, check: command };
        }
        // Changed or taken off while it ran: not sent under the new check
        // (kept with its own command, as update says).
        if (now.check !== command) return 'later' as const;
        return res;
      })
      .finally(() => {
        this.runningChecks.delete(runKey);
        try {
          clearCheckRunning(this.home, id);
        } catch {
          // Its time limit makes it stale anyway.
        }
      });
    this.inFlight.set(run, timeoutMs);
    this.checkingNow.add(id);
    try {
      return await run;
    } finally {
      this.inFlight.delete(run);
      this.checkingNow.delete(id);
    }
  }

  // Where a check runs: its thread's folder, its own, or the runner's.
  private checkFolder(rec: ScheduleRecord): string | undefined {
    if (rec.threadId) {
      try {
        return this.runner.get(rec.threadId).cwd;
      } catch {
        return this.folderElsewhere?.(rec.threadId);
      }
    }
    return rec.cwd ? path.resolve(expandHome(rec.cwd)) : this.home;
  }

  // Binds a schedule's check to what it runs as this is called, in this
  // runner's own store: making or changing one is what approves it (a thread
  // that asks first has had its card by now, threadbear-mcp.ts). A failure
  // only means the check is held at its next run.
  private approveCheck(rec: ScheduleRecord, card?: CheckCard): void {
    if (!rec.check) return;
    const cwd = this.checkFolder(rec);
    if (!cwd) throw bad("The thread's folder isn't available, so its check wasn't approved.");
    try {
      this.runner.patchTrust.approveCheck(rec.check, cwd, card);
    } catch (e) {
      // A card's approval that doesn't hold changes nothing, and nor does
      // one of a check nobody can approve (it writes what it runs).
      if (card || e instanceof CheckRefused) throw bad(e instanceof Error ? e.message : String(e));
      this.log.warn("could not approve a schedule's check", { scheduleId: rec.id, error: String(e) });
    }
  }

  // What to do instead of running a check that isn't approved as it is now,
  // or undefined when it is. Said once per version of what it runs, on the
  // run that's sent with it (see send), then skipped: a failed check going
  // quiet would be worse, and an agent every five minutes no better. A folder
  // that's gone counts, as the check would run somewhere else (runCheck).
  private heldCheck(command: string, cwd: string, id: string): { skip: string } | Carried | undefined {
    let hash: string;
    let why: string | undefined;
    try {
      const v = this.runner.patchTrust.checkApproved(command, cwd);
      if (v.approved && fs.existsSync(cwd)) return undefined;
      hash = v.hash;
      why = v.why;
    } catch (e) {
      hash = `unreadable: ${String(e)}`;
    }
    if (heldToldAbout(this.home, id) === hash) return { skip: why ?? HELD_SKIP };
    return { extra: why ? `\n\nIts check wasn't run: ${why}` : HELD_EXTRA, held: hash };
  }

  // Run now doesn't run the check, but sends what it kept and no thread
  // has seen, rather than leaving it to a next run a one-off won't have.
  private keptFor(rec: ScheduleRecord): Carried | undefined {
    if (!rec.check) return undefined;
    const kept = this.memKept.get(`${rec.id}\n${rec.check}`) ?? readKeptCheck(this.home, rec.id, rec.check);
    if (!kept || this.delivered.has(`${rec.id}\n${kept.check}\n${kept.at}`)) return undefined;
    // What it printed in another folder isn't this run's (the schedule was
    // moved since): it's checked afresh where it is now (Codex's review).
    if (kept.cwd !== undefined && kept.cwd !== this.checkFolder(rec)) return undefined;
    return { extra: kept.extra, kept: kept.at, check: kept.check };
  }

  // Run now waits for a check under way (here, or on the old runner in a
  // handover): sent now, it would go without what the check is about to
  // print, and finish a one-off before that has a run to carry it.
  private notMidCheck(rec: ScheduleRecord): void {
    if (!rec.check) return;
    if (this.checkingNow.has(rec.id) || checkRunningElsewhere(this.home, rec.id, this.clock.now())) {
      throw new RpcError(ErrorCode.busy, 'Its check is running; try again in a moment.');
    }
  }

  // A run carrying a check's output was sent, so it needn't be kept.
  private dropKept(scheduleId: string, check?: string): void {
    for (const k of [...this.memKept.keys()]) if (k.startsWith(`${scheduleId}\n`) && (check === undefined || k === `${scheduleId}\n${check}`)) this.memKept.delete(k);
    try {
      dropKeptCheck(this.home, scheduleId, check);
    } catch (e) {
      this.log.warn("could not clear a schedule check's kept output", { scheduleId, error: String(e) });
    }
  }

  // `by`: Run now's presser (runNow).
  private async send(rec: ScheduleRecord, manual: boolean, checked?: { skip: string } | Carried, requestedRun?: string, by?: PermissionMode): Promise<{ outcome: 'sent' | 'skipped' | 'failed' | 'retry'; threadId?: string; turnId?: string; note?: string }> {
    // Run now consumes an unfinished one-off's due slot too. A cron's
    // explicit runs have their own identity and leave the next slot alone.
    const run = rec.at && !rec.finishedAt ? `due:${rec.at}#${rec.runs}` : requestedRun ?? (manual ? `manual:${crypto.randomUUID()}` : `due:${rec.nextRunAt}`);
    const since = rec.at ? Date.parse(rec.createdAt) : requestedRun ? Date.parse(requestedRun.slice('request:'.length)) : manual ? this.clock.now() : Date.parse(rec.nextRunAt!);
    const at = this.iso();
    // Only the generated suffix carries new check data, never quoted text
    // in the reminder body. Held notices are delivered only once as well.
    const preserve = Boolean(checked && 'extra' in checked && (checked.held || checked.extra.endsWith('\n```')));
    const text = `[Scheduled: "${rec.title}", ${this.whenText(rec)}]\n\n${rec.text}${checked && 'extra' in checked ? checked.extra : ''}`;
    const record = (outcome: 'sent' | 'skipped' | 'failed', threadId?: string, note?: string) => {
      rec.lastRun = { at, outcome, ...(threadId ? { threadId } : {}), ...(note ? { note } : {}) };
      if (outcome === 'sent') rec.runs += 1;
      // Only a sent run has carried it. A skip (the last thread still
      // going), a failure or a refused send keeps it for the next run.
      if (outcome === 'sent' && checked && 'extra' in checked && checked.check) {
        this.delivered.add(`${rec.id}\n${checked.check}\n${checked.kept}`);
        this.dropKept(rec.id, checked.check);
      }
      if (outcome === 'sent' && checked && 'extra' in checked && checked.held) {
        try {
          noteHeldTold(this.home, rec.id, checked.held);
        } catch (e) {
          // Told again next run, rather than not told.
          this.log.warn('could not note that a held check was told about', { scheduleId: rec.id, error: String(e) });
        }
      }
      this.log.info('schedule ran', { scheduleId: rec.id, outcome, threadId, note });
    };
    if (checked && 'skip' in checked) {
      record('skipped', undefined, checked.skip);
      return { outcome: 'skipped', note: checked.skip };
    }
    // Its thread raised above what set it up ("Ceilings"): not sent, and a
    // repeating one paused until Mike resumes it.
    const ceiling = rec.threadId ? (by && raises(by, this.ceilingOf(rec)) ? by : this.ceilingOf(rec)) : undefined;
    // On a draining runner that doesn't say what it has (busy there, or
    // not listed yet): tried again, as that runner would refuse a busy
    // thread anyway, rather than held on a guess.
    if (rec.threadId && ceiling && ceiling !== 'full' && this.elsewhere(rec.threadId) && this.accessElsewhere?.(rec.threadId) === undefined) {
      if (manual) throw new RpcError(ErrorCode.busy, 'That thread is busy on the old runner; try again in a moment.');
      return { outcome: 'retry' };
    }
    if (rec.threadId && ceiling && raises(this.accessNow(rec.threadId), ceiling)) {
      const note = `Paused, not sent: its thread has more access now than the thread that set this up had. Read it, and resume it (or run it now) if it's still wanted.`;
      record('skipped', rec.threadId, note);
      this.heldForCeiling(rec, note);
      return { outcome: 'skipped', note };
    }
    try {
      if (rec.threadId) {
        if (this.sending.has(rec.id)) throw new RpcError(ErrorCode.busy, 'This scheduled message is being sent.');
        // A draining runner can keep a thread for hours while shells run.
        // Queue there, with the same origin as a local scheduled message.
        let turnId: string;
        if (this.elsewhere(rec.threadId)) {
          if (!this.sendElsewhere) throw new RpcError(ErrorCode.busy, 'That thread is finishing on the old runner.');
          this.sending.add(rec.id);
          try {
            ({ turnId } = await this.sendElsewhere(rec.threadId, text, rec.id, run, since, preserve, ceiling));
          } finally {
            this.sending.delete(rec.id);
          }
        } else {
          ({ turnId } = this.runner.sendScheduled(rec.threadId, text, rec.id, run, since, preserve, ceiling));
        }
        record('sent', rec.threadId);
        return { outcome: 'sent', threadId: rec.threadId, turnId };
      }
      // Don't pile up new threads behind one that's still going.
      const last = rec.lastRun?.outcome === 'sent' ? rec.lastRun.threadId : undefined;
      if (last && !manual && rec.cron && this.isBusy(last)) {
        const note = 'The thread from the last run was still going.';
        record('skipped', last, note);
        return { outcome: 'skipped', note };
      }
      const out = manual ? undefined : this.signedOutAgain(rec);
      if (out) {
        record('skipped', out.threadId, out.note);
        return { outcome: 'skipped', note: out.note };
      }
      const r = await this.runner.createAfterModelProbe({
        text,
        title: rec.title,
        // Made on another runner, the folder is as it was typed there.
        cwd: rec.cwd ? path.resolve(expandHome(rec.cwd)) : undefined,
        accountId: rec.accountId,
        poolId: rec.poolId,
        ...(rec.poolId && rec.provider ? { provider: rec.provider } : {}),
        model: rec.model,
        effort: rec.effort,
        permissionMode: rec.permissionMode,
        ...(rec.starThreads ? { starred: true } : {}),
        origin: 'schedule',
        scheduleId: rec.id,
      });
      record('sent', r.thread.id);
      return { outcome: 'sent', threadId: r.thread.id, turnId: r.turnId };
    } catch (e) {
      if (e instanceof RpcError && e.code === ErrorCode.busy) {
        if (manual) throw new RpcError(ErrorCode.busy, "Couldn't confirm this scheduled run. Check the thread before running it again.");
        return { outcome: 'retry' };
      }
      // A draining runner whose thread is above its ceiling there.
      if (e instanceof RpcError && e.code === ErrorCode.notAllowed && rec.threadId && e.message.startsWith(CEILING_REFUSED)) {
        const note = `Paused, not sent: its thread has more access now than the thread that set this up had. Read it, and resume it (or run it now) if it's still wanted.`;
        record('skipped', rec.threadId, note);
        this.heldForCeiling(rec, note);
        return { outcome: 'skipped', note };
      }
      const note = (e as Error).message ?? String(e);
      record('failed', rec.threadId, note);
      this.log.warn('schedule could not run', { scheduleId: rec.id, error: note });
      return { outcome: 'failed', note };
    }
  }

  // A run held by its ceiling: a repeating one paused (its ceiling kept, so
  // only Mike's resuming lifts it), and its thread shown to Mike with a note,
  // once, as it's paused. A one-off is finished by the run as usual; Run now
  // from the app sends it.
  private heldForCeiling(rec: ScheduleRecord, note: string): void {
    this.log.info("held a schedule's run: its thread has more access than what set it up", { scheduleId: rec.id, threadId: rec.threadId });
    if (rec.paused) return;
    if (rec.cron) {
      void this.update({ scheduleId: rec.id, paused: true }).catch((e) => this.log.warn("couldn't pause a schedule held by its ceiling", { scheduleId: rec.id, error: String(e) }));
    }
    if (rec.threadId && !this.elsewhere(rec.threadId)) {
      try {
        this.runner.scheduleHeld?.(rec.threadId, rec.title, note);
      } catch (e) {
        this.log.warn("couldn't tell a thread a schedule was held", { scheduleId: rec.id, error: String(e) });
      }
    }
  }

  // A run pinned to a signed-out login with nowhere to stand in
  // (pools.ts, standInFor) whose newest thread is still out, on that
  // login, its turn failed: that thread's banner offers the sign-in, so
  // this run skips rather than adding another failed thread to the inbox
  // each day (Mike clears his inbox; one thing needing him, not a stream).
  // The schedule's newest thread, not lastRun's: a skip or a quiet check
  // in between leaves lastRun without it (Codex's review, 16 Nov).
  private signedOutAgain(rec: ScheduleRecord): { note: string; threadId: string } | undefined {
    if (!rec.accountId || rec.poolId || rec.threadId) return undefined;
    const hello = this.runner.hello();
    const login = hello.accounts.find((a) => a.id === rec.accountId);
    if (!login?.signedOut || standInFor(hello.pools, hello.accounts, login.id, rec.cwd ? path.resolve(expandHome(rec.cwd)) : '')) return undefined;
    let newest: ReturnType<ScheduleRunner['get']> | undefined;
    for (const t of this.runner.list(['inbox', 'snoozed', 'archived'])) {
      if (t.schedule?.id === rec.id && (!newest || t.createdAt > newest.createdAt)) newest = t;
    }
    if (!newest || newest.archivedAt || newest.accountId !== login.id || newest.status !== 'error') return undefined;
    return { note: `${login.title} is signed out. The last run's thread says so and offers the sign-in.`, threadId: newest.id };
  }

  private isBusy(threadId: string): boolean {
    try {
      return BUSY.has(this.runner.get(threadId).status);
    } catch {
      return false;
    }
  }

  // Works out nextRunAt from now: a one-off's time (even if it's passed,
  // so it runs), or a cron's next time after now, however many it missed.
  private plan(rec: ScheduleRecord): void {
    delete rec.nextRunAt;
    if (rec.paused || rec.finishedAt) return;
    if (rec.at) {
      rec.nextRunAt = rec.at;
      return;
    }
    const t = nextRun(parseCron(rec.cron!), this.clock.now(), rec.timezone ?? this.zone());
    if (t !== undefined) rec.nextRunAt = new Date(t).toISOString();
  }

  private finish(rec: ScheduleRecord): void {
    rec.finishedAt = this.iso();
    delete rec.nextRunAt;
    // What its check kept stays until the schedule goes (prune): a one-off
    // whose send failed and is given a new time sends it then.
  }

  private prune(now: number): boolean {
    let gone = false;
    for (const rec of this.items.values()) {
      if (rec.finishedAt && now - Date.parse(rec.finishedAt) > KEEP_FINISHED_MS) {
        this.items.delete(rec.id);
        this.dropKept(rec.id);
        this.dropCeiling(rec.id);
        gone = true;
      }
    }
    return gone;
  }

  // -------------------------------------------------------------- helpers

  private changed(): void {
    this.save();
    this.publish();
  }

  // A save that fails is tried again in a moment, as Runner.flush does for
  // threads, rather than waiting for the next change: until it lands a
  // restart brings back the old list, so a deleted schedule could fire again
  // (THREADBEAR-1R: the cloud box's disk filled).
  private save(): void {
    this.saveRetry?.cancel();
    this.saveRetry = undefined;
    const stored = [...this.items.values()];
    const version = this.mode === 'backend' ? 2 : 1;
    try {
      atomicWriteFileSync(this.file, `${JSON.stringify({ version, schedules: stored }, null, 2)}\n`);
      this.saveFailed = false;
    } catch (e) {
      // Said once until it saves, as it reaches Sentry.
      if (!this.saveFailed) this.log.error('could not save schedules', { error: String(e) });
      this.saveFailed = true;
      if (!this.stopped) this.saveRetry = this.clock.setTimeout(() => this.save(), SAVE_RETRY_MS);
    }
  }

  private publish(): void {
    this.runner.publish({ method: 'schedules.updated', params: { schedules: this.list() } });
  }

  private view(rec: ScheduleRecord): Schedule {
    const v: Schedule = { ...rec, whenText: this.whenText(rec) };
    // What one with no mode of its own runs with, as new-threads.ts picks it
    // when it runs: so raising it is checked against that, not a guess of
    // full (Daybreak, 10 Nov: on an Ask-default runner, an Ask thread set
    // one to Auto as if lowering it). Only this runner's default is known.
    const defaults = this.runner.cfg?.defaults;
    if (!rec.threadId && !rec.permissionMode && this.mine(rec) && defaults) v.defaultMode = defaults.permissionMode ?? 'full';
    else delete v.defaultMode;
    if (rec.runnerId) {
      const own = rec.runnerId === this.self.id;
      const name = own ? this.self.name : this.names.get(rec.runnerId);
      if (name) v.runnerName = name;
      const icon = own ? this.self.icon : this.icons.get(rec.runnerId);
      if (icon) v.runnerIcon = icon;
    }
    return v;
  }

  private whenText(rec: ScheduleRecord): string {
    if (rec.at) return describeAt(Date.parse(rec.at), rec.timezone ?? this.zone(), this.clock.now());
    try {
      return describeCron(parseCron(rec.cron ?? ''), rec.timezone);
    } catch {
      return `Cron ${rec.cron}`;
    }
  }

  private mustGet(idOrPrefix: string): ScheduleRecord {
    const exact = this.items.get(idOrPrefix);
    if (exact) return exact;
    const hits = idOrPrefix ? [...this.items.values()].filter((s) => s.id.startsWith(idOrPrefix)) : [];
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw bad(`${idOrPrefix} matches ${hits.length} schedules; use more of the id.`);
    throw new RpcError(ErrorCode.scheduleNotFound, `No schedule ${idOrPrefix}`);
  }

  private parseAt(at: string): number {
    const t = Date.parse(at);
    if (Number.isNaN(t)) throw bad(`at must be an ISO time, not "${at}"`);
    return t;
  }

  private parsedCron(cron: string): ReturnType<typeof parseCron> {
    try {
      const spec = parseCron(cron);
      if (nextRun(spec, this.clock.now(), this.zone()) === undefined) throw new CronError(`"${cron}" never runs.`);
      return spec;
    } catch (e) {
      if (e instanceof CronError) throw bad(e.message);
      throw e;
    }
  }

  private checkedZone(zone: string): string {
    try {
      return checkZone(zone);
    } catch (e) {
      throw bad((e as Error).message);
    }
  }

  private checkedFolder(cwd: string | undefined): string {
    const dir = path.resolve(expandHome(cwd?.trim() ? cwd.trim() : this.runner.hello().defaults.cwd));
    if (!isDirectory(dir)) throw bad(`Folder not found: ${dir}`);
    return dir;
  }

  private checkedAccount(id: string): string {
    if (!this.runner.hello().accounts.some((a) => a.id === id)) throw new RpcError(ErrorCode.accountNotFound, `No account called ${id}`);
    return id;
  }

  private checkedPool(id: string): string {
    const pools = this.runner.hello().pools;
    if (!pools.some((x) => x.id === id)) throw bad(`No pool called ${id}. Pools: ${pools.map((x) => x.id).join(', ')}`);
    return id;
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}

function bad(message: string): RpcError {
  return new RpcError(ErrorCode.badParams, message);
}

function firstLine(text: string): string {
  return firstLineSafely(text, 80) || 'Scheduled message';
}

function checkedTimeout(secs: number): number {
  if (!Number.isInteger(secs) || secs < 1 || secs > MAX_CHECK_TIMEOUT_SECS) throw bad(`checkTimeoutSecs must be a whole number of seconds from 1 to ${MAX_CHECK_TIMEOUT_SECS}`);
  return secs;
}

function checkedCheck(command: string): string {
  const c = command.trim();
  if (c.length > MAX_CHECK_CHARS) throw bad(`check must be at most ${MAX_CHECK_CHARS} characters`);
  return c;
}

function setOrDelete<K extends 'model' | 'effort'>(rec: ScheduleRecord, key: K, v: ScheduleRecord[K] | null): void {
  if (v === null || v === undefined || v === '') delete rec[key];
  else rec[key] = v;
}

// ------------------------------------------------------------- the methods

export function scheduleMethods(s: Scheduler): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'schedules.list': (p) => ({ schedules: s.list(str(p, 'threadId')) }),
    'runners.list': async () => ({ runners: await s.runners() }),
    'schedules.create': async (p) => ({
      schedule: await s.create({
        text: str(p, 'text') ?? '',
        title: str(p, 'title'),
        at: str(p, 'at'),
        cron: str(p, 'cron'),
        timezone: str(p, 'timezone'),
        threadId: str(p, 'threadId'),
        cwd: str(p, 'cwd'),
        accountId: str(p, 'accountId'),
        poolId: str(p, 'poolId'),
        provider: provider(p.provider) ?? undefined,
        model: str(p, 'model'),
        effort: effort(p.effort) ?? undefined,
        permissionMode: mode(p.permissionMode),
        starThreads: bool(p, 'starThreads'),
        check: str(p, 'check'),
        ...checkCardOf(p),
        checkTimeoutSecs: num(p, 'checkTimeoutSecs'),
        paused: bool(p, 'paused'),
        createdBy: str(p, 'createdBy'),
        runnerId: str(p, 'runnerId'),
        // The RPC gate sets it for a thread's own key; the app and tb answer
        // to nobody.
        ceiling: ceilingParam(p.ceiling),
      }),
    }),
    'schedules.update': async (p) => {
      const scheduleId = str(p, 'scheduleId');
      if (!scheduleId) throw bad('scheduleId must be a string');
      const upd: UpdateScheduleParams = { scheduleId };
      for (const k of ['title', 'text', 'at', 'cron', 'cwd', 'accountId'] as const) {
        const v = str(p, k);
        if (v !== undefined) upd[k] = v;
      }
      if (p.timezone !== undefined) upd.timezone = p.timezone === null ? null : str(p, 'timezone');
      if (p.poolId !== undefined) upd.poolId = p.poolId === null ? null : str(p, 'poolId');
      if (p.model !== undefined) upd.model = p.model === null ? null : str(p, 'model');
      if (p.provider !== undefined) upd.provider = provider(p.provider);
      if (p.effort !== undefined) upd.effort = effort(p.effort);
      if (p.permissionMode !== undefined) upd.permissionMode = mode(p.permissionMode);
      if (p.paused !== undefined) upd.paused = bool(p, 'paused');
      if (p.starThreads !== undefined) upd.starThreads = bool(p, 'starThreads');
      if (p.check !== undefined) upd.check = p.check === null ? null : str(p, 'check');
      Object.assign(upd, checkCardOf(p));
      // Like the card, it can only refuse.
      if (p.ifCheck !== undefined) upd.ifCheck = reqStr(p, 'ifCheck');
      if (p.checkTimeoutSecs !== undefined) upd.checkTimeoutSecs = p.checkTimeoutSecs === null ? null : num(p, 'checkTimeoutSecs');
      // Left out, the app's or tb's: Mike's (the RPC gate sets a thread's,
      // or keepCeiling for the thread it sends to).
      if (p.keepCeiling === true) upd.keepCeiling = true;
      else upd.ceiling = ceilingParam(p.ceiling) ?? 'full';
      return { schedule: await s.update(upd) };
    },
    'schedules.delete': (p) => s.delete(reqStr(p, 'scheduleId')),
    'schedules.run': (p) => s.runNow(reqStr(p, 'scheduleId'), ceilingParam(p.by) ?? 'full'),
    'schedules.preview': (p) => {
      const count = p.count;
      if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count))) throw bad('count must be a whole number');
      return s.preview({ cron: str(p, 'cron'), at: str(p, 'at'), timezone: str(p, 'timezone'), count: count as number | undefined });
    },
  };
}

// A card's approval passing through from a draining runner's tool call
// (handover.ts). It can only refuse more: leaving it out approves as things
// are, which is what the app and tb do.
function checkCardOf(p: Record<string, unknown>): { checkCard?: CheckCard } {
  const c = p.checkCard;
  if (c === undefined || c === null) return {};
  if (typeof c !== 'object') throw bad('checkCard must be an object');
  const { hash, folder } = c as { hash?: unknown; folder?: unknown };
  return { checkCard: { ...(typeof hash === 'string' ? { hash } : {}), ...(typeof folder === 'string' ? { folder } : {}) } };
}

function str(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw bad(`${k} must be a string`);
  return v;
}

function reqStr(p: Record<string, unknown>, k: string): string {
  const v = str(p, k);
  if (v === undefined) throw bad(`${k} must be a string`);
  return v;
}

function bool(p: Record<string, unknown>, k: string): boolean | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw bad(`${k} must be a boolean`);
  return v;
}

function num(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number') throw bad(`${k} must be a number`);
  return v;
}

function provider(v: unknown): Provider | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!isProvider(v)) throw bad(`provider must be one of ${PROVIDERS.join(', ')}`);
  return v;
}

function effort(v: unknown): EffortLevel | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isEffortLevel(v)) throw bad(`effort must be one of ${EFFORT_LEVELS.join(', ')}`);
  return v;
}

// A ceiling as a call gives it: Plan first counts as Ask (runner/ceiling.ts).
function ceilingParam(v: unknown): PermissionMode | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isPermissionMode(v)) throw bad('ceiling must be "full", "auto", "ask" or "plan"');
  return ceilingMode(v);
}

function mode(v: unknown): PermissionMode | undefined {
  if (v === undefined || v === null) return undefined;
  if (v !== 'full' && v !== 'ask' && v !== 'auto') throw bad('permissionMode must be "full", "ask" or "auto"');
  return v;
}
