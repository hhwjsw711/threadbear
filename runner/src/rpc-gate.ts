// What a thread may do over the RPC (docs/protocol/connection.md, "A thread's own key").
// The app and tb outside a thread have the runner's token and answer to
// nobody. A connection that belongs to a thread answers to the same rules as
// that thread's own threadbear tools (threadbear-mcp.ts, "Raising access"),
// read at each call, so a thread lowered to Ask loses the lot at once.
//
// Those tools can put up a card and wait; a shell command can't sensibly hold
// one open, so here anything above the caller is refused, and the refusal
// names the tool that can ask. Refusing by default is the point: a method
// that's added later is closed until someone decides it's safe here.
import type { PermissionMode } from './protocol.ts';
import { AGENT_MESSAGE_PREFIX, ErrorCode, RpcError, sentByAgent } from './protocol.ts';
import { above, MODE_NAMES, raises, scheduleModes, type Authority } from './threadbear-mcp.ts';
import { ceilingMode } from './runner/ceiling.ts';

type Params = Record<string, unknown>;

// Anyone holding a thread's key may read: these change nothing outside the
// connection. media.import is the exception: it copies a file the thread's
// shell could already read into the runner's inbox for a tb --image, so it's
// open to every thread but metered below Full access (Runner.importMediaForThread,
// media-quota.ts; Daybreak finding 157).
export const GATED_READS: ReadonlySet<string> = new Set([
  'auth',
  'auth.whoami',
  'hello',
  'threads.list',
  'threads.search',
  'threads.events',
  'threads.subscribe',
  'threads.unsubscribe',
  'threads.subagent',
  'threads.highlights',
  'prWatch.list',
  'threads.commands',
  'threads.contextUsage',
  'buttons.list',
  'reviews.list',
  'reviews.get',
  'pools.list',
  'schedules.list',
  'schedules.preview',
  'runners.list',
  'runners.stats',
  'remoteThreads.list',
  'projects.list',
  'projects.get',
  'coordinators.list',
  'coordinators.get',
  'instructions.get',
  'librarian.status',
  'settings.get',
  'runner.status',
  'upstream.status',
  'clis.list',
  'connectors.status',
  'usage.stats',
  'media.import',
]);

type ThreadLike = { permissionMode?: PermissionMode; title: string; status?: string };

export type CallerGateDeps = {
  runner: {
    has(threadId: string): boolean;
    get(threadId: string): ThreadLike;
    accessOf(threadId: string): PermissionMode;
    coordinators?: { rpcRefusal(threadId: string, method: string, p: Params): string | undefined; projectForThread?(threadId: string): string | undefined };
  };
  // Threads a draining runner still has (rpc.ts's RemoteThreads).
  remote?: { owns(threadId: string): boolean; summaries(include: ('inbox' | 'snoozed' | 'archived')[]): (ThreadLike & { id: string })[] };
  // The pictures a thread below Full may send: only ones it imported, each
  // once (media-quota.ts take), sent as the copies take makes. Without it,
  // such a thread sends none.
  images?: { take(threadId: string, images: unknown): { path: string }[]; releaseHeld(images: unknown): void };
  schedules?: {
    find(idOrPrefix: string): { id: string; title: string; threadId?: string; permissionMode?: PermissionMode; check?: string; paused?: boolean };
    list(threadId?: string): { threadId?: string; check?: string }[];
  };
};

const ALL = ['inbox', 'snoozed', 'archived'] as const;

function str(p: Params, k: string): string | undefined {
  return typeof p[k] === 'string' ? (p[k] as string) : undefined;
}

const USER_COORDINATOR_ACTIONS = new Set([
  'coordinators.pause', 'coordinators.answer', 'coordinators.closeLoop', 'coordinators.reopenLoop', 'coordinators.replyLoop',
  'coordinators.addWorkItem', 'coordinators.updateWorkItem', 'coordinators.removeWorkItem', 'coordinators.answerDecision',
  'coordinators.postponeTask', 'coordinators.markTaskDone', 'coordinators.closeTask', 'coordinators.reopenTask', 'coordinators.addToCoordinator',
]);

export class CallerGate {
  private deps: CallerGateDeps;
  constructor(deps: CallerGateDeps) {
    this.deps = deps;
  }

  // The caller's authority at this moment, or undefined for a thread the
  // runner can't place (deleted, say): that's as low as it gets, and
  // anything but a read is refused (check).
  private authority(threadId: string): Authority | undefined {
    const { runner, remote } = this.deps;
    if (runner.has(threadId)) return { mode: runner.get(threadId).permissionMode ?? 'ask' };
    const t = remote?.owns(threadId) ? remote.summaries([...ALL]).find((x) => x.id === threadId) : undefined;
    return t ? { mode: t.permissionMode ?? 'ask' } : undefined;
  }

  // What another thread's agent has, for anything that reaches it. One this
  // runner can't read counts as full, as threadbear-mcp.ts's accessOf does.
  private targetAccess(threadId: string): Authority {
    const { runner } = this.deps;
    if (runner.has(threadId)) return { mode: runner.accessOf(threadId) };
    // A draining runner's summary cannot attest to its live turn or what
    // may start before a forwarded call lands. Its tools can ask on a card.
    return { mode: 'full' };
  }

  private title(threadId: string): string {
    const { runner, remote } = this.deps;
    if (runner.has(threadId)) return `"${runner.get(threadId).title}"`;
    const t = remote?.owns(threadId) ? remote.summaries([...ALL]).find((x) => x.id === threadId) : undefined;
    return t ? `"${t.title}"` : threadId.slice(0, 8);
  }

  // After a call that took a limited thread's pictures (check), whichever
  // way it ended: take's copies go.
  releaseHeld(images: unknown): void {
    this.deps.images?.releaseHeld(images);
  }

  whoami(threadId: string): { threadId: string; mode: PermissionMode; limited: boolean } {
    const a = this.authority(threadId);
    return { threadId, mode: a?.mode ?? 'ask', limited: a?.mode !== 'full' };
  }

  // Throws a refusal, or returns the params to run with (the caller's own
  // mode filled in, what only a client with the token may say taken out).
  check(threadId: string, method: string, p: Params): Params {
    if (method === 'artifacts.manage') throw new RpcError(ErrorCode.notAllowed, 'Use Publish in the HTML preview in Threadbear.');
    // Pausing a coordinator and answering its helpers' questions are the
    // user's, from the project home. Starting one and handing it a charter
    // and to-dos is open to an ordinary thread on Full access (below it,
    // update_project's coordinator option asks on a card), never to a
    // coordinator or its helpers (rpcRefusal, next).
    if (USER_COORDINATOR_ACTIONS.has(method)) throw new RpcError(ErrorCode.notAllowed, "This coordinator action is the user's to do from the project home.");
    const coordinatorRefusal = this.deps.runner.coordinators?.rpcRefusal(threadId, method, p);
    if (coordinatorRefusal) throw new RpcError(ErrorCode.notAllowed, coordinatorRefusal);
    // Whoever hands it work is named to the coordinator as this thread, never what the call says.
    if (method === 'coordinators.start' || method === 'coordinators.addTask' || method === 'coordinators.update') p = { ...p, fromThread: threadId };
    const known = this.authority(threadId);
    // Any agent's move, Full's too: it never starts a turn by itself
    // (Runner.update's carry-on after a limit is Mike's pick from the menu).
    // A snooze too (`tb snooze` from a thread): its waking then follows the
    // agent's rules, not Mike's (HibernationPart.wake, quietWake).
    if (method === 'threads.update' && (p.cwd !== undefined || p.accountId !== undefined || p.poolId !== undefined || (p.snoozedUntil !== undefined && p.snoozedUntil !== null))) p = { ...p, byAgent: true };
    // A CLI started ahead of a new thread is for the app's new-thread page
    // (runner/warm-start.ts): a thread neither starts one nor takes the app's.
    if (method === 'threads.warm') throw new RpcError(ErrorCode.notAllowed, "Starting a CLI ahead of a new thread is the app's to do.");
    if (method === 'threads.create' && p.warmId !== undefined) {
      const { warmId: _w, ...rest } = p;
      p = rest;
    }
    // Reinstalling stops every thread's runner; an agent hands that to the
    // user (install-runner.sh refuses from a thread too), Full access or not.
    if (method === 'runner.reinstall') throw new RpcError(ErrorCode.notAllowed, "Reinstalling the runner stops every thread's turn, so it's the user's to do: Reinstall now in the app's Updates panel.");
    // A year-long token changes which Claude account a login (on any of
    // the user's runners) runs as: a thread could approve the page with an
    // account of its own choosing. Only the user's click in the app, Full
    // access or not (Codex's review, 19 Nov).
    if (method === 'accounts.yearToken') throw new RpcError(ErrorCode.notAllowed, "Making a year-long token is the user's to do: Year-long token… in the app's Usage or Runners panel.");
    // Sharing this Mac's logins puts its tokens on another machine: only the
    // user's switch in the Runners panel, Full access or not.
    if (method === 'runners.shareLogins') throw new RpcError(ErrorCode.notAllowed, "Sharing this Mac's logins with another runner is the user's to do: Use this Mac's Claude logins in the app's Runners panel.");
    // A login's cloud token, and threads on a virtual runner (a box billed by
    // the hour, holding a year-long token), are the user's own, from the app.
    if (method.startsWith('cloudTokens.')) throw new RpcError(ErrorCode.notAllowed, "A login's cloud token is the user's to set, from the card in the app.");
    if (method === 'threads.create' && p.serviceId !== undefined) throw new RpcError(ErrorCode.notAllowed, 'Starting a thread on a virtual runner is the user\'s to do, from Runs on in the app.');
    // A schedule's ceiling, and Run now's presser (schedules.ts, "Ceilings"),
    // are the caller's, never what it says: Full's is none.
    if (method === 'schedules.create' || method === 'schedules.update') {
      const { ceiling: _c, keepCeiling: _k, ...rest } = p;
      p = known?.mode === 'full' ? { ...rest, ceiling: 'full' } : rest;
    }
    if (method === 'schedules.run') {
      const { by: _b, ...rest } = p;
      p = known?.mode === 'full' ? { ...rest, by: 'full' } : rest;
    }
    // Words a thread sends are never the runner's note or the phone's, at
    // any access (Codex's review, 25 Nov): only the owner's tools say so.
    if (method === 'threads.send') {
      const { origin: _o, wakeReason: _w, ...rest } = p;
      p = rest;
    }
    const coordinatorInput = (input: Params): Params => {
      const target = str(input, 'threadId');
      if (!target || !this.deps.runner.coordinators?.projectForThread?.(target)) return input;
      const { answers: _answers, ...rest } = input;
      if (typeof input.text !== 'string' || !input.text) return rest;
      const title = this.deps.runner.has(threadId) ? this.deps.runner.get(threadId).title.replace(/\s+/g, ' ').trim() : 'Agent';
      return { ...rest, text: `${AGENT_MESSAGE_PREFIX}"${title}" (${threadId.slice(0, 8)})]\n\n${input.text}` };
    };
    if (known?.mode === 'full') return method === 'threads.send' ? coordinatorInput(p) : p;
    if (GATED_READS.has(method)) return p;
    if (!known) throw new RpcError(ErrorCode.notAllowed, "This thread isn't one the runner knows now, so it can only read. Ask the user to do it in the app.");
    const caller = known;
    const who = `This thread is on ${MODE_NAMES[caller.mode]}`;
    const needs = (what: string, tool?: string) =>
      new RpcError(ErrorCode.notAllowed, `${who}, so ${what} needs the user's OK. ${tool ? `Use the ${tool} tool, which asks them on a card.` : 'Ask them to do it in the app.'}`);
    // A picture by path would have the runner copy any file into a thread's
    // media, unmetered (Daybreak finding 157, Gemini's review of the fix), so
    // only its own imports, taken once the rest of the call is allowed.
    const takeImages = (out: Params): Params => {
      if (p.images === undefined || p.images === null || (Array.isArray(p.images) && p.images.length === 0)) return out;
      if (!this.deps.images) throw needs('sending pictures');
      // Only to a thread on this runner: to one another runner has (a
      // handover, another Mac), the copy's path would cross to a runner that
      // can't check it, after this tick (Codex's and Gemini's third reviews).
      return { ...out, images: this.deps.images.take(threadId, p.images) };
    };
    switch (method) {
      case 'threads.create': {
        // Left out, a tool's new thread takes the caller's mode, not the
        // runner's default (which may be full).
        const mode = (p.permissionMode ?? caller.mode) as PermissionMode;
        if (above({ mode }, caller)) throw needs(`starting a thread with ${MODE_NAMES[mode] ?? mode}`, 'create_thread');
        const given = p.startedBy && typeof p.startedBy === 'object' ? (p.startedBy as Params) : {};
        // `unconfine` is only ever the user's: an older runner across a
        // handover still reads it (the sandbox taken out 16 Nov 2026).
        const { unconfine: _u, ...rest } = p;
        return takeImages({ ...rest, permissionMode: mode, startedBy: { ...given, kind: 'thread', threadId, label: typeof given.label === 'string' && given.label ? given.label : 'Agent' } });
      }
      case 'threads.send': {
        const id = str(p, 'threadId');
        if (Array.isArray(p.images) && p.images.length && (!id || !this.deps.runner.has(id))) throw needs("sending pictures to a thread that isn't on this runner");
        if (id && id !== threadId) {
          const t = this.targetAccess(id);
          if (above(t, caller)) throw needs(`sending a message to ${this.title(id)}, which has ${MODE_NAMES[t.mode]}`, 'send_message');
        }
        // Only the app's Needs you answers say these; the ceiling is set below.
        const { answers: _a, ceiling: _c, ...rest } = p;
        // Words starting as another thread's message would name a sender they
        // aren't from (runner/nested.ts reads it to hold a report).
        if (typeof p.text === 'string' && sentByAgent(p.text)) throw new RpcError(ErrorCode.notAllowed, "A message from a thread can't start the way another thread's message does. Use the send_message tool, which says who it's from.");
        // Raised above what this thread could reach while it waits in the
        // queue, it's held as it leaves (runner/ceiling.ts).
        // To itself: its own words, as far as it reaches now.
        if (!id || id === threadId) return takeImages(coordinatorInput({ ...rest, ceiling: ceilingMode(caller.mode) }));
        const to = this.targetAccess(id).mode;
        return takeImages(coordinatorInput({ ...rest, ceiling: ceilingMode(raises(to, caller.mode) ? to : caller.mode) }));
      }
      case 'threads.interrupt': {
        const id = str(p, 'threadId');
        if (id === threadId) throw new RpcError(ErrorCode.notAllowed, "That's the thread this runs in. Just end the turn.");
        if (!id || above(this.targetAccess(id), caller)) throw needs(`interrupting ${id ? this.title(id) : 'a thread'}`, 'interrupt_thread');
        return { ...p, byAgent: true, controlCeiling: caller.mode };
      }
      case 'threads.update':
        return this.update(threadId, caller, p, needs);
      case 'threads.setProjects': {
        const id = str(p, 'threadId');
        if (id && id !== threadId && above(this.targetAccess(id), caller)) throw needs(`changing the projects of ${this.title(id)}`, 'join_project');
        return { ...p, by: 'agent', controlCeiling: id && id !== threadId ? caller.mode : undefined };
      }
      // A PR's auto-fix wand, for this thread only: the watch messages the thread that
      // set it, so turning it on reaches no thread but the caller's own.
      case 'prWatch.set': {
        if (str(p, 'threadId') !== threadId) throw needs("setting a PR's auto-fix wand for another thread");
        return p;
      }
      case 'threads.showPanel': {
        if (str(p, 'threadId') !== threadId) throw needs("opening another thread's panel", 'show_panel');
        return p;
      }
      case 'schedules.create':
        return this.scheduleCreate(threadId, caller, p, needs);
      case 'schedules.update':
        return this.scheduleUpdate(threadId, caller, p, needs);
      case 'schedules.run':
        return this.scheduleRun(caller, p, needs);
      case 'schedules.delete':
        return this.scheduleDelete(caller, p, needs);
      case 'coordinators.start':
      case 'coordinators.addTask':
      case 'coordinators.update':
        throw needs("starting or changing a project's coordinator", 'update_project');
      default:
        throw needs(`calling ${method}`);
    }
  }

  private update(threadId: string, caller: Authority, p: Params, needs: (what: string, tool?: string) => RpcError): Params {
    const out: Params = { ...p, byAgent: true };
    const id = str(p, 'threadId');
    if (!id) return out;
    const self = id === threadId;
    for (const k of Object.keys(p)) {
      if (!['threadId', 'title', 'titleBy', 'cwd', 'accountId', 'poolId', 'model', 'effort', 'permissionMode', 'snoozedUntil', 'archived', 'archivedBy', 'starred', 'byAgent'].includes(k)) {
        throw needs(`setting ${k} on a thread`);
      }
    }
    // Authorize the whole mutation, not selected fields: a model change,
    // Stop, wake or Archive steers the target just as a message does.
    // Unknown and busy draining targets count as Full (targetAccess).
    if (!self && above(this.targetAccess(id), caller)) throw needs(`changing ${this.title(id)}`, p.cwd !== undefined || p.accountId !== undefined ? 'move_thread' : 'update_thread');
    if (!self) out.controlCeiling = caller.mode;
    if (self && (p.archived === true || (p.snoozedUntil !== undefined && p.snoozedUntil !== null))) {
      throw new RpcError(ErrorCode.notAllowed, "Can't snooze or archive the thread this runs in from inside its own turn. Call end_turn with archive: true or a snooze instead.");
    }
    if (p.title !== undefined) {
      // Its words reach that thread's agent and others' (update_thread asks
      // the same; Daybreak finding 111).
      if (!self && above(this.targetAccess(id), caller)) throw needs(`renaming ${this.title(id)}`, 'update_thread');
      out.titleBy = 'agent';
    }
    if (p.archived === true) out.archivedBy = 'agent';
    else delete out.archivedBy;
    if (p.permissionMode !== undefined) {
      const to = p.permissionMode as PermissionMode;
      const t = this.savedMode(id);
      if (raises(to, t)) throw needs(`switching ${self ? 'this thread' : this.title(id)} to ${MODE_NAMES[to] ?? to}`, 'update_thread');
      // Lowering another thread with more access than the caller takes away
      // what Mike set up, and would make that thread's schedules look no
      // higher than the caller, so schedules.delete let them through (Daybreak
      // finding 138, OpenCode's review of the fix).
      if (!self && to !== t && above(this.targetAccess(id), caller)) throw needs(`switching ${this.title(id)} to ${MODE_NAMES[to] ?? to}`, 'update_thread');
      // The mode it already has is left out, so this write can't raise it
      // back if it lands after someone else lowers it.
      if (to === t) delete out.permissionMode;
    }
    if (p.cwd !== undefined || p.accountId !== undefined || p.poolId !== undefined) {
      if (!self && above(this.targetAccess(id), caller)) throw needs(`moving ${this.title(id)}`, 'move_thread');
      // A schedule's check runs in its thread's folder, as the user.
      if (this.deps.schedules?.list(id).some((sc) => sc.threadId === id && sc.check?.trim())) throw needs(`moving ${self ? 'this thread' : this.title(id)}, whose folder a schedule's check runs in`, 'move_thread');
      // Said to an older runner across a handover, which still reads it as
      // "not the user's move" (the sandbox taken out 16 Nov 2026).
      out.unconfine = false;
      // Nor starting a turn by itself (Runner.update's carry-on).
      out.byAgent = true;
    }
    return out;
  }

  private savedMode(threadId: string): PermissionMode {
    const { runner, remote } = this.deps;
    if (runner.has(threadId)) return runner.get(threadId).permissionMode ?? 'full';
    return (remote?.owns(threadId) ? remote.summaries([...ALL]).find((x) => x.id === threadId)?.permissionMode : undefined) ?? 'full';
  }

  private scheduleCreate(threadId: string, caller: Authority, p: Params, needs: (what: string, tool?: string) => RpcError): Params {
    if (typeof p.check === 'string' && p.check.trim()) throw needs('adding a check to a schedule (a shell command that runs by itself)', 'schedule_message');
    const target = str(p, 'threadId');
    if (target) {
      if (target !== threadId && above(this.targetAccess(target), caller)) throw needs(`scheduling a message to ${this.title(target)}`, 'schedule_message');
      return { ...p, createdBy: threadId, ceiling: ceilingMode(caller.mode) };
    }
    const mode = (p.permissionMode ?? caller.mode) as PermissionMode;
    if (above({ mode }, caller)) throw needs(`scheduling new threads with ${MODE_NAMES[mode] ?? mode}`, 'schedule_message');
    return { ...p, permissionMode: mode, createdBy: threadId };
  }

  private scheduleUpdate(_threadId: string, caller: Authority, p: Params, needs: (what: string, tool?: string) => RpcError): Params {
    const out: Params = { ...p };
    const sc = this.findSchedule(p, needs);
    const modes = scheduleModes(sc);
    const was: Authority = sc.threadId ? this.targetAccess(sc.threadId) : { mode: modes.ceiling };
    const raised = !sc.threadId && typeof p.permissionMode === 'string' && raises(p.permissionMode as PermissionMode, modes.floor);
    if (raised) throw needs(`switching the schedule "${sc.title}" to ${MODE_NAMES[p.permissionMode as PermissionMode] ?? p.permissionMode}`, 'update_schedule');
    if (typeof p.check === 'string' && p.check.trim()) throw needs('adding a check to a schedule (a shell command that runs by itself)', 'update_schedule');
    if (p.checkTimeoutSecs !== undefined && p.check === undefined && sc.check) throw needs(`changing how long the schedule "${sc.title}"'s shell command may run`, 'update_schedule');
    // Pausing never asks; what it sends, where, when, on which login or
    // model, or that it runs again do, if its runs are above the caller or it
    // has a check. A login another runner doesn't have is saved as given and
    // stops the schedule quietly, like a delete (OpenCode's review of the
    // Daybreak finding 138 fix).
    const changes = ['text', 'title', 'at', 'cron', 'cwd', 'timezone', 'accountId', 'poolId', 'provider', 'model', 'effort'].some((k) => p[k] !== undefined) || (p.paused === false && sc.paused);
    if (changes && (above(was, caller) || sc.check)) throw needs(`changing the schedule "${sc.title}"`, 'update_schedule');
    // Lowering one above the caller, or taking its check off, is free for a
    // schedule the caller could have made, but on Mike's it takes away what he
    // set up, and would let schedules.delete through next (verify-fix of
    // Daybreak finding 138). Pausing stays free: it's undone with a click.
    const protectedSc = above(was, caller) || Boolean(sc.check);
    const lowers = !sc.threadId && typeof p.permissionMode === 'string' && p.permissionMode !== sc.permissionMode;
    const dropsCheck = Boolean(sc.check) && (p.check === null || (typeof p.check === 'string' && !p.check.trim()));
    if (protectedSc && (lowers || dropsCheck)) throw needs(`${dropsCheck ? 'taking the shell command off' : 'changing the access of'} the schedule "${sc.title}"`, 'update_schedule');
    if (p.permissionMode !== undefined && !sc.threadId && p.permissionMode === sc.permissionMode) delete out.permissionMode;
    // New words from it are as far as it can reach (schedules.ts, "Ceilings"),
    // in its own thread's schedules too: they only ever lower one.
    delete out.keepCeiling;
    out.ceiling = ceilingMode(caller.mode);
    return out;
  }

  private scheduleRun(caller: Authority, p: Params, needs: (what: string, tool?: string) => RpcError): Params {
    const sc = this.findSchedule(p, needs);
    const will: Authority = sc.threadId ? this.targetAccess(sc.threadId) : { mode: scheduleModes(sc).ceiling };
    if (above(will, caller) || sc.check) throw needs(`running the schedule "${sc.title}" now`, 'update_schedule');
    return { ...p, by: ceilingMode(caller.mode) };
  }

  // Deleting takes away what Mike set up and, with a check, the approval he
  // gave its command; so like changing one, it asks when its runs have more
  // access than the caller or it has a check (Daybreak finding 138). One at
  // or below the caller, with no check, it could have made itself.
  private scheduleDelete(caller: Authority, p: Params, needs: (what: string, tool?: string) => RpcError): Params {
    const sc = this.findSchedule(p, needs, 'delete_schedule');
    const was: Authority = sc.threadId ? this.targetAccess(sc.threadId) : { mode: scheduleModes(sc).ceiling };
    if (above(was, caller) || sc.check) throw needs(`deleting the schedule "${sc.title}"`, 'delete_schedule');
    // The one compared, not a prefix that could be read again differently.
    return { ...p, scheduleId: sc.id };
  }

  private findSchedule(p: Params, needs: (what: string, tool?: string) => RpcError, tool = 'update_schedule') {
    const id = str(p, 'scheduleId');
    const s = this.deps.schedules;
    if (!id || !s) throw needs('changing a schedule', tool);
    try {
      return s.find(id);
    } catch {
      // Unknown here (another runner's): the tools can see further.
      throw needs('changing that schedule', tool);
    }
  }
}
