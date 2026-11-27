// Starting a thread on another runner from an agent's create_thread
// (docs/protocol/runners.md, "Asking another runner").
//
// The main Mac's runner holds the owner key and starts it straight away,
// through the relay. A runner on a runner key (the cloud, Bruce) may not
// queue work for another runner (Runner keys), so it asks instead: it files
// the whole request in the backend, where it can't change it afterwards,
// and shows a card in its own thread. The main Mac's app reads the request
// back through its own runner (requests.get), shows Mike all of it, and on
// Allow its runner starts the thread (requests.answer), marks the request
// allowed and answers the card. The asking runner believes only the
// backend's row, never the answer's words, so a phone or an old app that
// says "allow" without starting anything changes nothing.
import crypto from 'node:crypto';
import path from 'node:path';
import { ErrorCode, RpcError, type PermissionMode } from './protocol.ts';
import type { RunnerRequestInput, RunnerRequestRow } from './sync.ts';
import { wasNotSent } from './relay.ts';

// The card's name in approval.requested, which the Mac app draws as a
// request rather than a tool's approval.
export const START_CARD = 'threadbear.start_thread';
// How long the asking agent waits for Mike before the card expires.
export const REQUEST_WAIT_MIN = 60;

// `askerMode`: the asking thread's mode as its card was shown, for the
// ceiling of the replies (ceilingFor); never sent on.
export type StartRequest = RunnerRequestInput & { runner: string; askerMode?: PermissionMode };

export type RequestAnswer =
  | { status: 'started'; runnerId: string; runnerName: string; threadId: string }
  | { status: 'declined' | 'expired' | 'authorized'; message?: string };

export type RunnerRef = { id: string; name: string; self: boolean; online?: boolean };

export type CrossRunnerDeps = {
  self: () => { id: string; name: string };
  // The backend with this runner's key; undefined while sync is off.
  backend: () =>
    | {
        ownerKey(): boolean;
        fileRequest(p: { requestId: string; threadId: string; target: string; request: RunnerRequestInput }): Promise<void>;
        runnerRequest(requestId: string): Promise<RunnerRequestRow | null>;
        decideRequest(p: { requestId: string; docId: string; state: 'claimed' | 'allowed' | 'pending' | 'denied'; result?: { runnerId: string; runnerName: string; threadId: string }; claim?: string; confirmation?: string }): Promise<void>;
        closeRequest(requestId: string, afterConfirmation?: true): Promise<void>;
      }
    | undefined;
  // Every runner the owner key can see, this one first (schedules.ts runners()).
  runners: () => Promise<RunnerRef[]>;
  createHere: (p: RunnerRequestInput & { startedBy?: { kind: 'thread'; label: string; threadId?: string; why?: string } }) => Promise<{ id: string }>;
  createThere: (runnerId: string, p: RunnerRequestInput) => Promise<{ id: string }>;
  // A thread started there for one here, whose replies come back to it
  // (far-reports.ts).
  // `by`: ceilingFor's answer, taken before the thread was asked for.
  startedThere?: (p: { threadId: string; runnerId: string; runnerName: string; starter: string; by: PermissionMode }) => void;
  // The ceiling for its replies (far-reports.ts, Rec.by), from the starter as
  // it is when it asks and the mode it asks for: read before the request
  // goes, so Mike raising the starter while it's on its way doesn't count.
  ceilingFor?: (starter: string, mode: string | undefined, askerMode?: PermissionMode) => PermissionMode;
  // Shows the card in one of this runner's threads and waits for its answer.
  card: (threadId: string, c: { approvalId: string; title: string; input: Record<string, unknown>; minutes: number; check: () => Promise<RequestAnswer> }) => Promise<RequestAnswer>;
  // The open card on another runner's thread, as the backend's row has it.
  openCard: (threadId: string) => Promise<string | undefined>;
  // Accepts Start it on the runner with the live card. Returns the relay
  // command id, which the backend checks before letting us claim the request.
  confirmStart: (row: RunnerRequestRow, claim: string) => Promise<string>;
  releaseStart: (row: RunnerRequestRow, claim: string) => Promise<void>;
  // Answers another runner's card through the relay.
  respondThere: (threadId: string, approvalId: string, decision: 'allow' | 'deny', message?: string) => Promise<void>;
  // This Mac's home folder and disk, for the folder a request names.
  home: () => string;
  // A folder's real path (symlinks followed), or undefined for anything
  // that isn't a folder.
  realDir: (p: string) => string | undefined;
};

const bad = (m: string) => new RpcError(ErrorCode.badParams, m);
const other = (m: string) => new RpcError(ErrorCode.other, m);

// What the agent's text arrives as on the new thread: said by the main
// Mac's runner, not by the runner that asked, so the new thread knows where
// the brief came from and that its words are that runner's.
// Both come from the asking runner (its thread's id, its name), so only
// characters that can't end the line or the brackets get in.
// The backend said no, and will again (not a dropped connection).
function refused(e: unknown): boolean {
  const kind = (e as { data?: { kind?: unknown } } | null)?.data?.kind;
  if (kind === 'badArgs' || kind === 'notFound' || kind === 'forbidden') return true;
  return /"kind"\s*:\s*"(badArgs|notFound|forbidden)"/.test(String((e as Error | null)?.message ?? ''));
}

export function askedHeader(row: Pick<RunnerRequestRow, 'threadId' | 'runnerName'>): string {
  const id = row.threadId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const name = row.runnerName.replace(/[^A-Za-z0-9 _.'-]/g, '').slice(0, 40).trim() || 'another runner';
  return `[Asked for by thread ${id} on ${name}, and allowed by the user on this Mac. The brief below is that thread's. To report back, send_message to thread ${id}.]\n\n`;
}

// The first line of a thread the main Mac starts on another runner for one
// of its own. That runner's key may not reach the starter (Runner keys), so
// the main Mac passes each of its replies back (far-reports.ts), and its
// send_message to the starter says so (threadbear-mcp.ts).
export function startedHeader(starter: string, name: string): string {
  const id = starter.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const mac = name.replace(/[^A-Za-z0-9 _.'-]/g, '').slice(0, 40).trim() || 'the main Mac';
  return `[Started by thread ${id} on ${mac}. Each reply you end a turn with goes back to that thread, so put your report in your reply.]\n\n`;
}

// The starter a thread's first message names, from startedHeader.
export function starterIn(text: string): string | undefined {
  return /^\[Started by thread ([A-Za-z0-9_-]+) on /.exec(text)?.[1];
}

// What Mike read, so Start it starts only that: a request filed again
// under the same id (after the week's sweep, say) has another time and
// so another fingerprint.
// `place` is the folder it would start in on this Mac as the card showed
// it (or that it showed none was there), so Start it can't start somewhere
// else because a folder appeared or a link moved in between.
export function fingerprint(row: RunnerRequestRow, place?: Place): string {
  const fields = [row.docId, row.requestId, row.runnerId, row.threadId, row.target, row.text, row.title, row.cwd, row.model, row.effort, row.permissionMode, row.why, row.createdAt, place ?? null];
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

// A folder another machine's agent named, as a folder on this Mac, or
// undefined when it isn't one. That agent can't see this disk, so it
// guesses, and gets the home folder wrong: on 8 Nov the cloud's agent asked
// for /Users/mike/dev/me/threadbear on a Mac whose home is /Users/m5-mike.
// So one that isn't here is tried again under this Mac's home, with its own
// (~, /Users/<name>, /home/<name>) taken off. That one is given as its real
// path and must really be in the home, symlinks followed: it's a folder
// Mike didn't name, so the card shows exactly where it lands, and neither
// `..` nor a link in the home takes it out (Codex review, 8 Nov 2026). A
// folder that's here as named is left as named, as a create here does.
export function folderHere(cwd: string, home: string, realDir: (p: string) => string | undefined): string | undefined {
  const asked = cwd.trim();
  const tilde = /^~(\/.*)?$/.exec(asked);
  if (!tilde) {
    if (!path.isAbsolute(asked)) return undefined;
    const exact = path.resolve(asked);
    if (realDir(exact)) return exact;
  }
  return underHome(asked, tilde, home, realDir);
}

function underHome(asked: string, tilde: RegExpExecArray | null, home: string, realDir: (p: string) => string | undefined): string | undefined {
  const homed = tilde ?? /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(asked);
  if (!homed) return undefined;
  const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);
  const here = path.resolve(home, '.' + (homed[1] ?? ''));
  if (!inside(here, home)) return undefined;
  const real = realDir(here);
  return real && inside(real, realDir(home) ?? home) ? real : undefined;
}

// Where a request would start on this Mac, for the card and its fingerprint:
// the folder (as named, or as read under this home) and its real path, so a
// link moved between the card and Start it changes the fingerprint too.
type Place = { folder: string; real: string } | { missing: string };

export class CrossRunner {
  private deps: CrossRunnerDeps;
  // Requests being started now, so a double click starts one thread.
  private starting = new Set<string>();
  // A claim whose answer was lost, by request: asking again with it is told
  // yes if it had in fact gone through (relay:decideRequest, API 85).
  private lostClaims = new Map<string, string>();

  constructor(deps: CrossRunnerDeps) {
    this.deps = deps;
  }

  private isSelf(name: string): boolean {
    const s = this.deps.self();
    const n = name.trim().toLowerCase();
    return n === s.id.toLowerCase() || n === s.name.toLowerCase() || n === 'this' || n === 'here';
  }

  // "main", a name or an id, as a runner the owner key can see.
  async resolve(name: string): Promise<RunnerRef | undefined> {
    const list = await this.deps.runners();
    const want = name.trim().toLowerCase();
    if (!want || want === 'main' || want === 'mac' || want === 'my mac') return list.find((r) => r.self);
    return list.find((r) => r.id.toLowerCase() === want) ?? list.find((r) => r.name.toLowerCase() === want);
  }

  /**
   * An agent's create_thread with a runner. Answers with what to tell the
   * agent. A runner that's this one isn't elsewhere: the caller starts it
   * here as usual (returns undefined).
   */
  async start(threadId: string, req: StartRequest): Promise<string | undefined> {
    if (this.isSelf(req.runner)) return undefined;
    const backend = this.deps.backend();
    if (!backend) throw other("This runner isn't connected to Threadbear's Convex backend, so it can't reach another runner.");
    const { runner, askerMode, ...request } = req;
    if (backend.ownerKey()) {
      const target = await this.resolve(runner);
      if (!target) throw bad(`No runner called ${runner}. Runners: ${(await this.deps.runners()).map((r) => r.name).join(', ')}.`);
      if (target.self) return undefined;
      const by = this.deps.ceilingFor?.(threadId, request.permissionMode, askerMode) ?? 'ask';
      const t = await this.deps.createThere(target.id, { ...request, text: startedHeader(threadId, this.deps.self().name) + request.text });
      this.deps.startedThere?.({ threadId: t.id, runnerId: target.id, runnerName: target.name, starter: threadId, by });
      return `Started thread ${t.id} on ${target.name}. Each reply it ends a turn with comes back here as a message, so it needn't send_message you. Use read_thread to see how it goes.`;
    }
    const approvalId = crypto.randomUUID();
    // Plan first goes as Ask: a main runner from before Plan first dropped
    // the mode it didn't know and started the thread on full access, and
    // the request row has no room for a flag an older one would ignore
    // (Codex review, 7 Nov 2026). Ask is as careful, and works everywhere.
    if (request.permissionMode === 'plan') request.permissionMode = 'ask';
    await backend.fileRequest({ requestId: approvalId, threadId, target: runner, request });
    const input: Record<string, unknown> = { runner, ...request };
    let answer = await this.deps.card(threadId, {
      approvalId,
      title: `Start a thread on ${runner}?`,
      input,
      minutes: REQUEST_WAIT_MIN,
      check: async () => {
        const row = await backend.runnerRequest(approvalId);
        if (row?.state === 'allowed' && row.result) return { status: 'started', ...row.result };
        if (row?.state === 'denied' || row?.state === 'closed') return { status: 'declined' };
        if (row?.state === 'claimed') throw bad('The main Mac is starting it now.');
        throw bad('Answer this in the Threadbear app on the main Mac: it starts the thread from there.');
      },
    });
    // Closed here without starting (declined, expired, Mike wrote instead):
    // so it stops counting against this runner's few, and can't be started late.
    if (answer.status !== 'started') await backend.closeRequest(approvalId, answer.status === 'authorized' ? true : undefined).catch(() => {});
    if (answer.status === 'authorized') {
      // Stop, a message, or the timeout may release the tool while the main
      // Mac is still starting it. Read the result before saying what happened.
      const row = await backend.runnerRequest(approvalId).catch(() => null);
      if (row?.state === 'allowed' && row.result) answer = { status: 'started', ...row.result };
      else if (row?.state === 'closed' || row?.state === 'denied') return 'The request closed before a thread started.';
      else return 'Start was approved, but the result is still unknown. Check the other runner before asking again.';
    }
    if (answer.status === 'started') return `The user allowed it: started thread ${answer.threadId} on ${answer.runnerName}. It can report back here with send_message; this thread can't read or message it.`;
    // A reason with it (the main Mac's runner couldn't start it, or Mike
    // wrote one) is the agent's to act on; a plain no is final.
    if (answer.status === 'declined') return answer.message ? `It wasn't started: ${answer.message}` : "The user said no. Don't ask again unless they say so.";
    return answer.message && answer.message !== 'No answer in time.'
      ? `The request closed before it was accepted. ${answer.message}`
      : `Nobody answered in ${REQUEST_WAIT_MIN} minutes, so nothing was started.`;
  }

  /** requests.get, on the main Mac: the request as it was filed, and where it would start. */
  async get(threadId: string, approvalId: string): Promise<{ request: RunnerRequestRow; target?: RunnerRef; runners: RunnerRef[]; fingerprint: string; missingFolder?: string }> {
    const row = await this.row(threadId, approvalId);
    const runners = await this.deps.runners();
    const target = await this.resolve(row.target);
    // One starting here shows the folder it would really start in (the
    // app starts a request naming a machine it doesn't know here too), and
    // the fingerprint holds it, so Start it starts there or not at all.
    // The fingerprint holds the place whichever machine the card shows, so
    // Start it on another machine than the card's (`runnerId`) isn't
    // refused for that alone.
    const place = this.place(row);
    const here = !target || target.self;
    const request = here && place && 'folder' in place ? { ...row, cwd: place.folder } : row;
    const missing = here && place && 'missing' in place ? { missingFolder: place.missing } : {};
    return { request, ...(target ? { target } : {}), runners, fingerprint: fingerprint(row, place), ...missing };
  }

  private place(row: RunnerRequestRow): Place | undefined {
    if (!row.cwd) return undefined;
    const folder = folderHere(row.cwd, this.deps.home(), this.deps.realDir);
    const real = folder ? this.deps.realDir(folder) : undefined;
    return folder && real ? { folder, real } : { missing: row.cwd };
  }

  /** requests.answer, on the main Mac: start it (on `runnerId`, or the one it asked for) or say no. */
  async answer(threadId: string, approvalId: string, allow: boolean, runnerId?: string, shown?: string): Promise<{ thread?: { id: string; runnerId: string; runnerName: string } }> {
    const backend = this.mustOwn();
    // One answer to a request at a time, Start it or Don't, held from before
    // anything is read: two overlapping ones could each see a lost claim as
    // theirs and start two threads, or a Don't hand back a claim a Start was
    // still using (Codex's review, 17 Nov 2026).
    if (this.starting.has(approvalId)) throw bad('That request is already being answered.');
    this.starting.add(approvalId);
    try {
      return await this.answerNow(backend, threadId, approvalId, allow, runnerId, shown);
    } finally {
      this.starting.delete(approvalId);
    }
  }

  private async answerNow(backend: ReturnType<CrossRunner['mustOwn']>, threadId: string, approvalId: string, allow: boolean, runnerId?: string, shown?: string): Promise<{ thread?: { id: string; runnerId: string; runnerName: string } }> {
    const row = await this.row(threadId, approvalId);
    // A claim of ours whose answer never came back (a dropped connection):
    // nothing was started under it, so Start it can carry on from there.
    const ours = this.lostClaims.get(approvalId);
    const reclaim = row.state === 'claimed' && ours !== undefined && row.claim === ours;
    if (row.state !== 'pending' && !reclaim) throw bad(`That request is ${row.state === 'claimed' ? 'being started' : `already ${row.state}`}.`);
    const releaseStart = (claim: string) => this.deps.releaseStart(row, claim).catch(() => {});
    const handBack = async (claim: string) => {
      const giveBack = () => backend.decideRequest({ requestId: approvalId, docId: row.docId, state: 'pending', claim });
      try {
        await giveBack();
      } catch (e) {
        // Its answer can be lost after the transition commits. A retry
        // names the same claim, so it cannot undo a later Start it.
        if (!refused(e)) await giveBack().catch(() => {});
      } finally {
        // We know this attempt made no thread, even if the backend reply
        // was lost. Clear only this attempt's acceptance.
        await releaseStart(claim);
      }
    };
    const target = allow ? (runnerId ? (await this.deps.runners()).find((r) => r.id === runnerId) : await this.resolve(row.target)) : undefined;
    if (allow && !target) throw bad(`No runner called ${runnerId ?? row.target}. Pick one.`);
    const place = this.place(row);
    if (allow && shown !== fingerprint(row, place)) throw bad('That request has changed since the card showed it. Open the thread again to read it.');
    // The synced card is a quick check for a new answer. Recovering a lost
    // Start it uses the live confirmation below even if the mirror is stale.
    if (!(allow && reclaim) && (await this.deps.openCard(threadId)) !== approvalId) {
      if (reclaim) {
        await handBack(ours);
        this.lostClaims.delete(approvalId);
      }
      throw bad('That request has closed: its thread is no longer waiting for it.');
    }
    if (!allow) {
      // Our lost claim goes back first: only a pending request can be declined.
      if (reclaim) {
        await handBack(ours);
        this.lostClaims.delete(approvalId);
      }
      await backend.decideRequest({ requestId: approvalId, docId: row.docId, state: 'denied' });
      await this.deps.respondThere(threadId, approvalId, 'deny');
      return {};
    }
    {
      if (!target) throw bad(`No runner called ${runnerId ?? row.target}. Pick one.`);
      // Said before claiming, so it can be tried again once that Mac is back.
      if (!target.self && target.online === false) throw other(`${target.name} is offline. Try again once it's back.`);
      const { text, title, model, effort, permissionMode, why } = row;
      if (target.self && place && 'missing' in place) {
        if (reclaim) {
          await handBack(ours);
          this.lostClaims.delete(approvalId);
        }
        // Nothing Mike can pick here would make it right, and the agent
        // waits an hour for a card that can't start: it's told why
        // instead, so it can ask again with a folder that's here. Told
        // before anything is marked, so a reason that can't be sent leaves
        // the request as it was to try again; once told, its runner closes
        // the request itself, so marking it here may find it closed.
        const reason = `There's no folder ${place.missing} on ${this.deps.self().name}, the main Mac. Its home folder is ${this.deps.home()}. Ask again with a folder there.`;
        try {
          await this.deps.respondThere(threadId, approvalId, 'deny', reason);
        } catch (e) {
          throw other(`${place.missing} isn't a folder on this Mac, and couldn't tell the thread that asked (${e instanceof Error ? e.message : String(e)}). Try Start it again, or Don't.`);
        }
        await backend.decideRequest({ requestId: approvalId, docId: row.docId, state: 'denied' }).catch(() => {});
        throw bad(`${place.missing} isn't a folder on this Mac, so nothing was started. The thread that asked has been told, so it can ask again with one that is.`);
      }
      const cwd = target.self && place && 'folder' in place ? place.folder : row.cwd;
      const p: RunnerRequestInput = { text: askedHeader(row) + text, ...(title ? { title } : {}), ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(permissionMode ? { permissionMode } : {}) };
      // Claimed in the backend before anything starts, so a retry, a second
      // click or this runner restarting midway can't start it twice.
      // Kept only while the claim's own answer is unknown: once it's through,
      // something may start under it, so asking again must never reuse it.
      const claim = ours ?? crypto.randomUUID();
      const confirmation = await this.deps.confirmStart(row, claim).catch(async (e: unknown) => {
        if (reclaim) {
          // A lost claim answer never reached create. If the card can no
          // longer confirm, hand that claim back before releasing it.
          await handBack(claim);
          this.lostClaims.delete(approvalId);
        } else if (e instanceof RpcError && e.code !== ErrorCode.badParams) {
          await releaseStart(claim);
        }
        throw e;
      });
      this.lostClaims.set(approvalId, claim);
      try {
        await backend.decideRequest({ requestId: approvalId, docId: row.docId, state: 'claimed', claim, confirmation });
      } catch (e) {
        // Refused for good (another claim has it, or it was decided): not ours.
        if (refused(e)) {
          this.lostClaims.delete(approvalId);
          await releaseStart(claim);
        }
        throw e;
      }
      this.lostClaims.delete(approvalId);
      let made: { id: string };
      if (target.self) {
        try {
          made = await this.deps.createHere({ ...p, startedBy: { kind: 'thread', label: row.runnerName, threadId: row.threadId, ...(why ? { why } : {}) } });
        } catch (e) {
          // Turned down before anything was made (a folder that isn't one):
          // it can be tried again. Anything else may have made it (a
          // handover passing it to the new runner), so the claim stays.
          if (e instanceof RpcError && e.code === ErrorCode.badParams) await handBack(claim);
          throw e;
        }
      } else {
        // Another runner may still make it after a slow answer, so the
        // claim stays (never a second one), unless nothing was sent.
        made = await this.deps.createThere(target.id, p).catch(async (e: unknown) => {
          if (wasNotSent(e)) {
            await handBack(claim);
            throw e;
          }
          throw other(`${target.name} didn't say it started it (${e instanceof Error ? e.message : String(e)}). It may still: look there before asking again.`);
        });
      }
      const result = { runnerId: target.id, runnerName: target.name, threadId: made.id };
      await backend.decideRequest({ requestId: approvalId, docId: row.docId, state: 'allowed', result, claim });
      // The thread is started and marked whatever happens now: a card the
      // other runner was slow to close isn't an error to show Mike.
      await this.deps.respondThere(threadId, approvalId, 'allow').catch(() => {});
      return { thread: { id: made.id, runnerId: target.id, runnerName: target.name } };
    }
  }

  private mustOwn() {
    const backend = this.deps.backend();
    if (!backend) throw other("This runner isn't connected to Threadbear's Convex backend.");
    if (!backend.ownerKey()) throw other("Only the main Mac's runner can answer another runner's request.");
    return backend;
  }

  private async row(threadId: string, approvalId: string): Promise<RunnerRequestRow> {
    const backend = this.mustOwn();
    const row = await backend.runnerRequest(approvalId);
    // The card's thread must be the one that filed it, so a request can't
    // be answered through another thread's card.
    if (!row || row.threadId !== threadId) throw bad('No such request on that thread.');
    return row;
  }
}
