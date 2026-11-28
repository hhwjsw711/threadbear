// Thread worktrees: making one before a turn, its Land action, and cleaning up (docs/thread-worktrees.md).
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { Action, EventBody } from '../protocol.ts';
import type { ThreadRecord } from '../store.ts';
import { threadBinDir, threadEnv } from '../restart.ts';
import { cleanUpWorktree, clearBuildCaches, git, mainCheckoutOf, makeWorktree, readPlainFile, realpath, sameSubfolder, stillCheckedOut, worktreeFolderNow, worktreeGone, type WorktreeRecord } from '../worktrees.ts';
import { isDirectory } from '../fsutil.ts';
import { CLICKS_ONLY_NOTE } from '../platform.ts';
import { sweepBorrows } from '../borrows.ts';
import { openThreadFolders, runnerHomes } from '../lived-in.ts';
import { claimsOf, readSlots, writeSlot, type SlotEvent, type SlotMove } from '../slot.ts';
import type { Logger } from '../log.ts';
import { automaticTrust, findWorktreePatch, isInside, readWorktreePatch, runCommand, type PatchSet, type WorktreePatch, worktreePatchFiles } from '../patches.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { ThreadState } from '../runner.ts';

export const worktreesPart = {
  // ------------------------------------------------------------ worktrees
  // A worktree per thread (docs/thread-worktrees.md, worktrees.ts).

  // Whether a new thread in `cwd` might get a worktree: there's at least
  // one patch file in its own folder chain to read.
  mayWantWorktree(this: Runner, cwd: string): boolean {
    try {
      return worktreePatchFiles(cwd, this.panelsRoot).length > 0;
    } catch {
      return false;
    }
  },

  // Before a new thread's first turn: if its repo's patch asks for a
  // worktree, makes one, moves the thread into it and runs the patch's
  // setup there. Anything going wrong is said, and the thread starts
  // where it was asked to.
  async prepareWorktree(this: Runner, st: ThreadState, turnId: string): Promise<void> {
    const { rec, rt } = st;
    try {
      await this.prepareWorktreeNow(st, turnId);
    } finally {
      // Deleted meanwhile: delete() left the worktree to this (it would
      // have removed it from under the setup, or never known of it), so
      // it goes now rather than be left with no thread. Not one let go to
      // another runner, which has the worktree now (a handover keeps a
      // thread being set up, but a crash or a move may not).
      if (rt.trashed && rec.worktree && !rec.worktree.removedAt) {
        await this.cleanUpWorktree(st, true).catch((e: unknown) => this.log.error('worktree cleanup failed', { threadId: rec.id, error: String(e) }));
      }
    }
  },

  async prepareWorktreeNow(this: Runner, st: ThreadState, turnId: string): Promise<void> {
    const { rec, rt } = st;
    delete rec.worktreePending;
    this.markDirty(st);
    // A session already ran in the folder (a turn that failed later, say):
    // moving it now would leave that session behind.
    if (rec.sessionUsed || rec.worktree) return;
    let patch;
    try {
      patch = await findWorktreePatch(rec.cwd, this.panelsRoot, this.patchCache, undefined, this.patchTrust);
    } catch (e) {
      this.log.warn('could not read patches for a worktree', { threadId: rec.id, error: String(e) });
      return;
    }
    if (!patch || rt.deleted) return;
    const asked = rec.cwd;
    const made = await makeWorktree({ cwd: asked, threadId: rec.id, patch, inUse: this.foldersInUse(rec.id) });
    if (rt.deleted) {
      if (made.ok) this.slot(st, { kind: 'made', worktree: made.worktree, owed: false });
      return;
    }
    if (!made.ok) {
      this.log.warn('could not make a worktree', { threadId: rec.id, reason: made.reason });
      this.emit(st, { type: 'system.note', text: `Couldn't make a worktree for this thread: ${made.reason}. It starts in ${asked} instead.` }, turnId);
      return;
    }
    // Made afresh from main (or a spare reset to it): what a move left
    // there is gone, so the checkout's own trust reaches it again.
    this.patchTrust.vouch?.(made.worktree.path);
    // Archived while it was being made: the archive didn't know of it, so
    // its cleanup is owed (archiveWhenGone runs it once this is done).
    this.slot(st, { kind: 'made', worktree: made.worktree, owed: Boolean(rec.archivedAt) });
    rec.cwd = made.cwd;
    rec.cwdAt = this.isoNow();
    rec.updatedAt = this.isoNow();
    this.markDirty(st);
    this.log.info('made a worktree', { threadId: rec.id, path: made.worktree.path, branch: made.worktree.branch });
    this.emit(st, { type: 'system.note', text: `Working in a worktree of its own at ${made.worktree.path}, on the branch ${made.worktree.branch}. tb land puts it on main.` }, turnId);
    // Archived while it was being made (its cleanup is owed, above): no
    // point setting it up.
    if (rec.archivedAt) return;
    await this.setUpWorktree(st, made, patch, turnId);
  },

  // A new worktree's setup (the patch's `setup`), run from the worktree's
  // own copy of the patch once that's trusted. A moved thread's worktree
  // (runner/moves.ts) runs it too.
  // Whether the setup ran and passed: undefined when it didn't run.
  async setUpWorktree(this: Runner, st: ThreadState, made: { worktree: WorktreeRecord; patchFile: string }, patch: WorktreePatch, turnId?: string): Promise<boolean | undefined> {
    const { rec, rt } = st;
    if (patch.heldSetup && !patch.setup) {
      this.emit(st, { type: 'system.note', text: `Didn't run the worktree's setup (${patch.heldSetup}): ${CLICKS_ONLY_NOTE}` }, turnId);
      return;
    }
    if (!patch.setup) return;
    const copy = await this.worktreeCopy(made.patchFile, patch.patch, 'setup');
    if (rt.deleted) return;
    if ('skip' in copy) {
      this.log.warn("didn't run a worktree's setup", { threadId: rec.id, patch: made.patchFile, reason: copy.skip });
      this.emit(st, { type: 'system.note', text: `Didn't run the worktree's setup (${patch.setup}): ${copy.skip}` }, turnId);
      return;
    }
    // Trusted, but asking for no setup there: nothing to run.
    const setup = { command: copy.patch?.setup, run: copy.patch?.setupRun };
    if (!setup.command) return;
    // Bound to a hashed script, it runs from the worktree: the copy must
    // still hash to the version that approved it, read afresh just now.
    if (setup.run) {
      const by = automaticTrust(setup.run);
      if (!by || !this.patchTrust.verify(by.file, by.hash)) {
        this.emit(st, { type: 'system.note', text: `Didn't run the worktree's setup (${patch.setup}): its patch or a script it runs changed since it was checked.` }, turnId);
        return;
      }
    }
    const outcome = await runCommand(setup.run ?? setup.command, {
      cwd: made.worktree.path,
      env: { ...process.env, ...threadEnv(rec.id, this.cfg.home) },
      shell: this.actionShell,
      timeoutMs: this.actionTimeoutMs,
      background: this.backgroundJobs,
    });
    if (rt.deleted) return;
    const body: EventBody = {
      type: 'action.run',
      actionId: `${patch.patch}.worktree-setup`,
      patch: patch.patch,
      title: 'Set up the worktree',
      command: setup.command,
      ok: outcome.ok,
      text: outcome.text,
      truncated: outcome.truncated,
      durationMs: outcome.durationMs,
      trigger: 'worktree.setup',
    };
    if (outcome.exitCode !== undefined) body.exitCode = outcome.exitCode;
    this.emit(st, body, rt.turn?.turnId ?? turnId);
    this.markDirty(st);
    return outcome.ok;
  },

  // The worktree's own copy of the patch, for its setup or teardown. The
  // patch trusted in the main checkout isn't what runs there: the worktree
  // is main's commit, which can differ from the main checkout's files (an
  // uncommitted edit, a script changed on main), and by the time it's
  // archived it's the thread's branch, which anything can have changed (a
  // pull, a commit from someone else). Both run by themselves. So that copy,
  // with the scripts it names as they are in the worktree, must be a version
  // Mike trusted (Daybreak, 5 Nov). Threadbear's own worktrees count as its
  // checkout, so stay trusted. `patch` is absent when it has no `worktree`.
  async worktreeCopy(this: Runner, copy: string, id: string, what: 'setup' | 'teardown'): Promise<{ patch?: WorktreePatch } | { skip: string }> {
    let verdict;
    try {
      verdict = await this.patchTrust.check(copy, fs.statSync(copy).mtimeMs);
    } catch (e) {
      return { skip: `couldn't read its copy of the ${id} patch (${String((e as Error).message ?? e)}).` };
    }
    if (!verdict.trusted) {
      if (verdict.reason === 'unchecked') return { skip: `its copy of the ${id} patch can't be checked: ${verdict.problem}` };
      return { skip: `its copy of the ${id} patch isn't a version you've trusted. Trust it in Patches, then run the ${what} yourself if you want it.` };
    }
    let again;
    try {
      again = await readWorktreePatch(copy, this.patchCache, undefined, this.patchTrust);
    } catch (e) {
      return { skip: `couldn't load its copy of the ${id} patch (${String((e as Error).message ?? e)}).` };
    }
    // Refused as it loaded: a setup that isn't one hashed script, say.
    if (again && 'error' in again) return { skip: `its copy of the ${id} patch didn't load. ${again.error}` };
    return again ? { patch: again } : {};
  },

  // The teardown to run as a worktree is cleaned up, from the worktree's own
  // copy of the patch that asked for it, trusted as setup's is: what's there
  // now is the thread's branch, so a teardown changed on it needs trusting
  // like any other change to the patch. Undefined when there's none to run.
  async worktreeTeardownCommand(this: Runner, st: ThreadState): Promise<{ command: string; run?: string; patch: string } | { skip: string } | undefined> {
    const { rec } = st;
    const w = rec.worktree!;
    const from = isInside(rec.cwd, w.path) && isDirectory(rec.cwd) ? rec.cwd : w.path;
    // Older records don't say which patch it was: the nearest one in the
    // worktree with a `worktree`, as findWorktreePatch picks.
    const files = w.patchFile ? [path.join(w.path, w.patchFile)] : worktreePatchFiles(from, this.panelsRoot).filter((f) => isInside(f, w.path));
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const id = path.basename(file, path.extname(file));
      const copy = await this.worktreeCopy(file, id, 'teardown');
      if ('skip' in copy) {
        // An untrusted copy can't be loaded to see if it has a teardown, so
        // it's only worth a note when it looks like it might: most don't.
        // One that isn't a plain file of a sensible size (a fifo, which
        // would hold the runner up for ever: Codex's review, 9 Nov) might.
        const text = readPlainFile(file);
        if (text === undefined || /\bteardown\b/.test(text)) return { skip: copy.skip };
        continue;
      }
      if (!copy.patch) continue;
      return copy.patch.teardown ? { command: copy.patch.teardown, run: copy.patch.teardownRun, patch: copy.patch.patch } : undefined;
    }
    return undefined;
  },

  // Runs the patch's teardown in the worktree's root, on every archive and
  // delete, landed or not, before the cleanup decides what goes: what setup
  // made outside the folder (a Convex deployment per worktree) would
  // otherwise outlive the thread, and a branch landed through a squashed PR
  // never counts as merged (elie-h's fork, approved 9 Nov). A kept spare's
  // too: what the thread made is its own, not the next thread's. Once per
  // archive (tornDownAt). Its output goes in the transcript as an
  // action.run; a deleted thread has no transcript, so a notice says if it
  // didn't run or failed. A failure never stops the cleanup.
  async tearDownWorktree(this: Runner, st: ThreadState, deleted: boolean, stillOurs: () => boolean): Promise<void> {
    const { rec } = st;
    const w = rec.worktree;
    if (!w || w.removedAt || w.tornDownAt) return;
    // Only in the thread's own checkout: a slot folder can be another
    // thread's by now (THREADBEAR-16), and its teardown isn't ours to run.
    if (!(await stillCheckedOut(w)) || !stillOurs()) return;
    const say = (text: string) => {
      if (deleted) this.notice('info', `"${rec.title}" was deleted, but ${text}`);
      else if (!st.rt.deleted) {
        this.emit(st, { type: 'system.note', text });
        this.markDirty(st);
      }
    };
    let found;
    try {
      found = await this.worktreeTeardownCommand(st);
    } catch (e) {
      found = { skip: `couldn't read its patch (${String((e as Error).message ?? e)}).` };
    }
    if (!found || !stillOurs()) return;
    if ('skip' in found) {
      this.log.warn("didn't run a worktree's teardown", { threadId: rec.id, path: w.path, reason: found.skip });
      say(deleted ? `its worktree's teardown didn't run: ${found.skip}` : `Didn't run the worktree's teardown: ${found.skip}`);
      return;
    }
    // Bound to a hashed script, it runs from the worktree: the copy must
    // still hash to the version that approved it, read afresh just now.
    if (found.run) {
      const by = automaticTrust(found.run);
      if (!by || !this.patchTrust.verify(by.file, by.hash)) {
        say(deleted ? `its worktree's teardown (${found.command}) didn't run: its patch or a script it runs changed since it was checked.` : `Didn't run the worktree's teardown (${found.command}): its patch or a script it runs changed since it was checked.`);
        return;
      }
    }
    // The last check, with nothing awaited between it and the start: the
    // folder can have been swapped (for a link to the main checkout, say)
    // while the patch was read, and it runs by the path checked.
    const cwd = worktreeFolderNow(w);
    if (!cwd) {
      this.log.warn("didn't run a worktree's teardown: its folder changed", { threadId: rec.id, path: w.path });
      return;
    }
    const outcome = await runCommand(found.run ?? found.command, {
      cwd,
      env: { ...process.env, ...threadEnv(rec.id, this.cfg.home) },
      shell: this.actionShell,
      timeoutMs: this.actionTimeoutMs,
      background: this.backgroundJobs,
      // The cleanup, and everything waiting on it, waits for this: nothing
      // it leaves running can hold the pipes open past it, as for hooks.
      killGroup: true,
    });
    this.slot(st, { kind: 'tornDown' }, w);
    this.log.info('worktree teardown', { threadId: rec.id, path: w.path, ok: outcome.ok, exitCode: outcome.exitCode });
    if (deleted) {
      if (!outcome.ok) {
        const end = outcome.text.trim().split('\n').slice(-5).join('\n');
        const code = outcome.exitCode !== undefined ? ` (exit code ${outcome.exitCode})` : '';
        this.notice('info', `"${rec.title}" was deleted, but its worktree's teardown (${found.command}) failed${code}${end ? `: ${end}` : '.'}`);
      }
      return;
    }
    // Deleted meanwhile: its own cleanup skips the teardown (tornDownAt).
    if (st.rt.deleted) return;
    const body: EventBody = {
      type: 'action.run',
      actionId: `${found.patch}.worktree-teardown`,
      patch: found.patch,
      title: 'Tear down the worktree',
      command: found.command,
      ok: outcome.ok,
      text: outcome.text,
      truncated: outcome.truncated,
      durationMs: outcome.durationMs,
      trigger: 'worktree.teardown',
    };
    if (outcome.exitCode !== undefined) body.exitCode = outcome.exitCode;
    this.emit(st, body);
    this.markDirty(st);
  },

  // A thread brought back to a worktree that stayed (its work wasn't on
  // main) carries on there, as before teardowns. But its teardown ran, so
  // what setup made outside the folder may be gone: its next turn says so,
  // to Mike and the agent, rather than setup quietly running again (setup
  // is written for a fresh worktree). Returns the line for the agent.
  tellTornDown(this: Runner, st: ThreadState, turnId: string): string | undefined {
    const { rec } = st;
    const w = rec.worktree;
    if (!w?.tornDownAt || w.removedAt || !isInside(rec.cwd, w.path)) return undefined;
    this.slot(st, { kind: 'toldTornDown' }, w);
    this.markDirty(st);
    this.emit(st, { type: 'system.note', text: "This thread's worktree was torn down when it was archived (its patch's teardown ran), so anything its setup made outside the folder may be gone. It carries on in the worktree." }, turnId);
    return `[Threadbear] Your worktree's teardown ran when this thread was archived, so anything its setup made outside ${w.path} (a database, a deployment) may be gone. Run the worktree's setup again if you need it.`;
  },

  // A thread whose worktree was removed (it was archived with everything
  // landed) and has now come back gets a fresh one, made from main as a new
  // thread's is, or carries on in the main checkout if none can be made.
  // Returns a line for the agent, whose system prompt still names the old
  // worktree. Before 16 Nov 2026 it always went to the main checkout: helper
  // threads archive themselves (runner/quiet-inbox.ts) and their starters
  // often write to them again, and in four days 24 of them came back to the
  // main checkout, which other threads share, and had to borrow a worktree
  // before they could work.
  // The thread's worktree has gone since its CLI last ran, so its next
  // start moves it to the main checkout (leaveRemovedWorktree).
  // Whether a folder is at that path now says nothing: slot folders are
  // reused, so one there is a spare, another thread's or a borrowed one.
  // On 8 Nov a removed slot-10 was made again by borrow-worktree.sh, and
  // the thread brought back carried on in it, beside the borrower's work.
  leavesRemovedWorktree(this: Runner, rec: ThreadRecord): boolean {
    const w = rec.worktree;
    return Boolean(w?.removedAt && isInside(rec.cwd, w.path));
  },

  async leaveRemovedWorktree(this: Runner, st: ThreadState, turnId: string): Promise<string | undefined> {
    const { rec, rt } = st;
    try {
      return await this.leaveRemovedWorktreeNow(st, turnId);
    } finally {
      // Deleted meanwhile: delete() left the fresh worktree to this (it's
      // held under rt.preparing, as a new thread's is), so it goes now.
      if (rt.trashed && rec.worktree && !rec.worktree.removedAt) {
        await this.cleanUpWorktree(st, true).catch((e: unknown) => this.log.error('worktree cleanup failed', { threadId: rec.id, error: String(e) }));
      }
    }
  },

  async leaveRemovedWorktreeNow(this: Runner, st: ThreadState, turnId: string): Promise<string | undefined> {
    const { rec } = st;
    const w = rec.worktree;
    if (!w || !this.leavesRemovedWorktree(rec)) return undefined;
    const went = w.spare ? 'was handed on to other threads' : 'was removed';
    return this.carryOnElsewhere(st, turnId, sameSubfolder(rec.cwd, w.path, w.mainCheckout), {
      main: (to) => `This thread's worktree ${went} when it was archived, so it carries on in the main checkout, ${to}.`,
      fresh: (nw) => `This thread's worktree ${went} when it was archived, so it carries on in a fresh one at ${nw.path}, on the branch ${nw.branch}, made from main. tb land puts it on main.`,
      told: `Your worktree at ${w.path} ${went} after its work landed on main.`,
    });
  },

  // The slot a thread with no worktree of its own works in, when that slot
  // went to someone else after the thread moved there: a spare (or one being
  // claimed), a borrow of another's begun since, or the worktree of a thread
  // made since. A thread gets there by borrowing a slot and moving itself in
  // (move_thread), and stays after giving it back. On 23 Nov 2026 the Canvas
  // thread's slot-32, given back the day before, was lent to another thread,
  // and the Canvas thread's next turn committed on the borrower's branch
  // (docs/thread-worktrees.md, "A folder a thread works in is never lent").
  // undefined for anything else: its own borrow, and a thread put in
  // another's slot on purpose after it was theirs (a Lab review's reviewers,
  // a helper made with worktree: false, a move there).
  async lentFolder(this: Runner, rec: ThreadRecord): Promise<LentFolder | undefined> {
    const slot = this.slotFolderOf(rec);
    if (!slot || !isDirectory(slot)) return undefined;
    const main = await mainCheckoutOf(slot);
    if (!main) return undefined;
    const found = (await readSlots(main, claimsOf([...this.threads.values()].map((t) => t.rec))))?.find((s) => realpath(s.checkout.path) === slot);
    if (!found) return undefined;
    const is = found.is;
    // When the thread came to its folder: a record from before cwdAt says
    // only when the thread was made. To the second, as borrows are stamped:
    // one in the same second counts as after, as the safe side.
    const came = Math.floor(Date.parse(rec.cwdAt ?? rec.createdAt) / 1000) * 1000;
    const since = (at: number | undefined) => at !== undefined && Number.isFinite(at) && (!Number.isFinite(came) || at >= came);
    // When another thread came to its worktree: its own move there (cwdAt,
    // which a fresh worktree for a thread brought back sets) or its making.
    const madeAt = (id: string) => {
      const other = this.threads.get(id)?.rec;
      if (!other) return undefined;
      const times = [other.createdAt, other.cwdAt].map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite);
      return times.length ? Math.max(...times) : undefined;
    };
    let went: string;
    switch (is.kind) {
      case 'spare':
      case 'loose':
        went = 'went back to the spares other threads take';
        break;
      case 'borrowed':
        // Borrows from before 17 Nov say nobody: left as they were.
        if (!is.borrower || is.borrower.thread === rec.id || !since(is.borrower.at)) return undefined;
        went = 'was lent to another borrower';
        break;
      case 'held':
      case 'landing':
      case 'taken':
        if (is.thread === rec.id || !since(madeAt(is.thread))) return undefined;
        went = "is another thread's worktree now";
        break;
      case 'twoHolders':
        if (is.threads.includes(rec.id) || !is.threads.some((t) => since(madeAt(t)))) return undefined;
        went = "is another thread's worktree now";
        break;
      default:
        return undefined;
    }
    return { slot: found.checkout.path, main, went };
  },

  // The slot folder (the one just inside a <repo>-threads) a thread with no
  // worktree of its own works in, if it's in one. Synchronous, so a turn in
  // any other folder starts without waiting on it.
  slotFolderOf(this: Runner, rec: ThreadRecord): string | undefined {
    const w = rec.worktree;
    if (w && !w.removedAt) return undefined;
    for (let d = realpath(rec.cwd); path.dirname(d) !== d; d = path.dirname(d)) {
      if (path.basename(path.dirname(d)).endsWith('-threads')) return d;
    }
    return undefined;
  },

  // A thread whose folder is a slot that isn't its own any more (lentFolder)
  // leaves it, as one brought back to a removed worktree does.
  async leaveLentFolder(this: Runner, st: ThreadState, turnId: string, lent: LentFolder): Promise<string | undefined> {
    const { rec, rt } = st;
    try {
      if (rec.worktree && !rec.worktree.removedAt) return undefined;
      if (!isInside(realpath(rec.cwd), realpath(lent.slot))) return undefined;
      return await this.carryOnElsewhere(st, turnId, sameSubfolder(rec.cwd, lent.slot, lent.main), {
        main: (to) => `This thread's folder ${lent.slot} ${lent.went}, so it carries on in the main checkout, ${to}.`,
        fresh: (nw) => `This thread's folder ${lent.slot} ${lent.went}, so it carries on in a fresh worktree at ${nw.path}, on the branch ${nw.branch}, made from main. tb land puts it on main.`,
        told: `Your folder ${lent.slot} ${lent.went}, so it isn't yours to work in any more.`,
      });
    } finally {
      // Deleted meanwhile, as leaveRemovedWorktree.
      if (rt.trashed && rec.worktree && !rec.worktree.removedAt) {
        await this.cleanUpWorktree(st, true).catch((e: unknown) => this.log.error('worktree cleanup failed', { threadId: rec.id, error: String(e) }));
      }
    }
  },

  // Whether an open thread other than `except` works in a folder (a
  // realpath), for makeWorktree to pass over: a spare a thread still sits in
  // (lived-in.ts says why). Not a thread still in its own worktree that was
  // removed or handed on: its next turn starts elsewhere anyway. Read as each
  // folder is asked about, so a thread that moved meanwhile counts, and with
  // the threads of other runners on this Mac (a dev runner's) from their
  // records, as borrow-worktree.sh reads them.
  foldersInUse(this: Runner, except?: string): (dir: string) => boolean {
    let others: string[] | undefined;
    return (dir) => {
      for (const { rec } of this.threads.values()) {
        if (rec.id === except || rec.archivedAt || this.leavesRemovedWorktree(rec)) continue;
        if (isInside(realpath(rec.cwd), dir)) return true;
      }
      if (!others) {
        const home = realpath(this.cfg.home);
        try {
          others = openThreadFolders(runnerHomes().filter((h) => realpath(h) !== home)).map((f) => realpath(f));
        } catch (e) {
          // Its own threads, in memory, still count: answering yes to every
          // folder would leave no slot number free.
          this.log.warn("couldn't read other runners' thread records", { error: String(e) });
          others = [];
        }
      }
      return others.some((f) => isInside(f, dir));
    };
  },

  // Moves the thread from its folder to a fresh worktree made from `main`'s
  // patch, or to `main` itself when none can be made, and says so in the
  // thread and to the agent (the line returned, kept on the record too). The
  // thread has no worktree of its own (none, removed or handed on).
  async carryOnElsewhere(this: Runner, st: ThreadState, turnId: string, main: string, words: { main: (to: string) => string; fresh: (w: WorktreeRecord) => string; told: string }): Promise<string | undefined> {
    const { rec, rt } = st;
    const from = rec.cwd;
    const fresh = await this.freshWorktree(st, main, turnId);
    if (rt.deleted || rec.cwd !== from) {
      // Deleted meanwhile (the finally above removes it), or another start
      // already moved it: the fresh one is nobody's, so it goes.
      if (fresh) {
        const failed = (e: unknown) => this.log.error('worktree cleanup failed', { threadId: rec.id, error: String(e) });
        // Recorded as the thread's, so its cleanup has the record to write.
        // Not if the thread has a worktree of its own again (another start
        // made it): that one stays the record's, and this goes by itself.
        if (!this.slot(st, { kind: 'made', worktree: fresh.made.worktree, owed: false }).ok) await cleanUpWorktree(fresh.made.worktree).catch(failed);
        else if (!rt.deleted) await this.cleanUpWorktree(st).catch(failed);
      }
      return undefined;
    }
    const to = fresh ? fresh.made.cwd : main;
    // A fresh worktree at the very same path (one without `keep` is named
    // for the thread) keeps the session where it was: a handoff to the same
    // folder and login would start a new session with only a summary of the
    // conversation (carryTranscript), where the CLI can resume it whole.
    if (rec.sessionUsed && to !== from) {
      if (this.adapters[rec.provider]?.movesFolders) rec.moved ??= { fromCwd: from };
      else rec.handoff ??= { fromCwd: from, fromAccountId: rec.accountId };
    }
    // Archived again while it was being made: that archive saw the old,
    // removed worktree, so this one's cleanup is owed (archiveWhenGone runs
    // it once this is done, or settleLostCleanups after a restart).
    if (fresh) this.slot(st, { kind: 'made', worktree: fresh.made.worktree, owed: Boolean(rec.archivedAt) });
    rec.cwd = to;
    rec.cwdAt = rec.updatedAt = this.isoNow();
    this.markDirty(st);
    this.tellActivity({ kind: 'moved', threadId: rec.id, from, to });
    if (!fresh) {
      this.emit(st, { type: 'system.note', text: words.main(to) }, turnId);
      rec.agentNotice = `[Threadbear] ${words.told} You're now in the main checkout, ${to}, which other threads share: stage your own files by name.`;
      return rec.agentNotice;
    }
    const nw = fresh.made.worktree;
    this.log.info('made a fresh worktree for a thread leaving its folder', { threadId: rec.id, path: nw.path, branch: nw.branch });
    this.emit(st, { type: 'system.note', text: words.fresh(nw) }, turnId);
    // Archived again while it was being made (its cleanup is owed, above):
    // no point setting it up. As prepareWorktreeNow does.
    // Saved with the move, before setup, so a runner that stops during
    // setup still tells the agent with its next message (deliver).
    rec.agentNotice = `[Threadbear] ${words.told} You're now in a fresh worktree of your own at ${nw.path}, on the branch ${nw.branch}, made from main as it is now. Commit there and run tb land when it's done, as before.`;
    this.markDirty(st);
    if (!rec.archivedAt) await this.setUpWorktree(st, fresh.made, fresh.patch, turnId);
    // Moved to another folder during setup: the notice no longer says where
    // it is.
    if (rec.cwd !== to) delete rec.agentNotice;
    return rec.agentNotice;
  },

  // A new worktree for a thread brought back to a removed one, from the
  // main checkout's patch, or nothing (no patch asks for one, or making it
  // failed, which is said).
  async freshWorktree(this: Runner, st: ThreadState, main: string, turnId: string): Promise<{ made: Extract<Awaited<ReturnType<typeof makeWorktree>>, { ok: true }>; patch: WorktreePatch } | undefined> {
    const { rec, rt } = st;
    let patch;
    try {
      patch = await findWorktreePatch(main, this.panelsRoot, this.patchCache, undefined, this.patchTrust);
    } catch (e) {
      this.log.warn('could not read patches for a worktree', { threadId: rec.id, error: String(e) });
      return undefined;
    }
    if (!patch || rt.deleted) return undefined;
    const made = await makeWorktree({ cwd: main, threadId: rec.id, patch, inUse: this.foldersInUse(rec.id) });
    if (!made.ok) {
      this.log.warn('could not make a fresh worktree', { threadId: rec.id, reason: made.reason });
      this.emit(st, { type: 'system.note', text: `Couldn't make a fresh worktree for this thread: ${made.reason}.` }, turnId);
      return undefined;
    }
    this.patchTrust.vouch?.(made.worktree.path);
    return { made, patch };
  },

  // The Land chip, for a thread with a worktree of its own.
  worktreeAction(this: Runner, rec: ThreadRecord): Action | undefined {
    const w = rec.worktree;
    if (!w || w.removedAt) return undefined;
    // The runner's tb, in full: a login shell's PATH may not have it. The
    // current release's, as on a thread's PATH (threadBinDir says why).
    const tb = path.join(threadBinDir(), 'tb');
    const quoted = /^[\w./-]+$/.test(tb) ? tb : `'${tb.replace(/'/g, `'\\''`)}'`;
    return {
      id: 'worktree.land',
      title: 'Land',
      kind: 'command',
      command: `${quoted} land`,
      // From the worktree itself: tb land lands the checkout it runs in when
      // that isn't the thread's (a sub-agent's), and the thread's folder may
      // be another checkout by now, even one inside this (Codex, 11 Nov).
      folder: w.path,
      patch: 'worktree',
      note: `Rebase ${w.branch} on main, run the check, then move main to it`,
    };
  },

  actionsOf(this: Runner, st: ThreadState, set: PatchSet): Action[] {
    const land = this.worktreeAction(st.rec);
    return land ? [...set.actions, land] : set.actions;
  },

  // At start (and when a thread is handed over): an archived thread whose
  // worktree and branch have gone (or whose folder another thread has
  // taken) but whose record never said so (a handover saved it mid-cleanup
  // before 6 Nov, THREADBEAR-16, or the runner stopped there) is told now,
  // so it shows no Land chip and, brought back, never carries on in the
  // folder. Each check counts as the thread's cleanup, so a message sent
  // meanwhile waits for it (deliver).
  settleLostCleanups(this: Runner, threads: Iterable<ThreadState> = this.threads.values(), retry = true): Promise<void> {
    const checks = [];
    for (const st of threads) {
      const { rec, rt } = st;
      const w = rec.worktree;
      if (!rec.archivedAt || !w || w.removedAt || rt.cleaning) continue;
      // Archived, but the runner went before the cleanup ran: it's still to
      // do, not just to record. Not from a handover: one that comes with this
      // still owed gave up waiting for its git (letGo), which may still be
      // removing the folder, and a second one beside it could read that as
      // uncommitted changes. The next start does it.
      const check = (retry && w.cleanupOwed ? this.cleanUpWorktree(st) : worktreeGone(w).then((gone) => {
          if (!gone || rt.deleted || w.removedAt) return;
          this.slot(st, { kind: 'foundGone', taken: gone === 'taken' }, w);
          this.markDirty(st);
          this.log.info("recorded a worktree's removal the record missed", { threadId: rec.id, path: w.path });
        }))
        .catch((e: unknown) => this.log.warn("couldn't check an archived thread's worktree", { threadId: rec.id, error: String(e) }))
        .finally(() => {
          if (rt.cleaning === check) rt.cleaning = undefined;
        });
      rt.cleaning = check;
      checks.push(check);
    }
    return Promise.all(checks).then(() => undefined);
  },

  // Borrowed worktrees whose borrower has gone (borrows.ts). A thread's
  // worktree and the folder an open thread works in are never touched.
  async sweepBorrows(this: Runner): Promise<void> {
    const mains = new Set<string>();
    const held = new Set<string>();
    const records = [...this.threads.values()].map((st) => st.rec);
    for (const rec of records) {
      const w = rec.worktree;
      if (w) mains.add(w.mainCheckout);
      if (w && !w.removedAt) held.add(realpath(w.path));
      if (!rec.archivedAt) held.add(realpath(rec.cwd));
    }
    const thread = (id: string) => {
      const st = this.threads.get(id);
      return !st ? 'unknown' : st.rec.archivedAt ? 'archived' : 'open';
    };
    for (const main of mains) {
      if (!isDirectory(main)) continue;
      const r = await sweepBorrows(main, { thread, held, claims: claimsOf(records), home: this.cfg.home });
      for (const b of r.reclaimed) this.log.info('took back a borrowed worktree', { ...b });
      if (r.branches.length) this.log.info('deleted borrow branches with no worktree, all on main', { repo: main, branches: r.branches });
    }
  },

  // Moves the thread's worktree on in its life (slot.ts): the only writer
  // of rec.worktree and its removedAt, cleanupOwed, spare and tornDownAt.
  // `w`: the worktree the caller is working on, if not the record's own
  // now. A move the code never makes is refused there and logged here.
  slot(this: Runner, st: ThreadState, e: SlotEvent, w?: WorktreeRecord): SlotMove {
    const res = writeSlot(st.rec, e, this.clock.now(), w ?? st.rec.worktree);
    if (!res.ok) this.log.warn('unexpected worktree move', { threadId: st.rec.id, event: e.kind, reason: res.reason });
    return res;
  },

  // Archived threads whose worktree stayed get their cleanup again: what
  // kept it (work not on main yet, uncommitted changes, a git that timed
  // out) may have gone since, as their work landed through another thread
  // or under other commit ids. Quietly: a worktree that still stays says
  // nothing new in its thread. Ones that still stay after ASK_AFTER_MS
  // look abandoned, so a thread asks about them (askAboutStayed).
  // Returns how many went.
  async sweepArchivedWorktrees(this: Runner): Promise<number> {
    let removed = 0;
    const stayed: Stayed[] = [];
    for (const st of [...this.threads.values()]) {
      const { rec, rt } = st;
      const w = rec.worktree;
      if (!rec.archivedAt || !w || w.removedAt || w.cleanupOwed || rt.cleaning || rt.deleted) continue;
      const again: { reason?: string } = {};
      const cleaning: Promise<void> = this.cleanUpWorktree(st, false, again)
        .catch((e: unknown) => this.log.warn('archived worktree sweep failed', { threadId: rec.id, error: String(e) }))
        .finally(() => {
          if (rt.cleaning === cleaning) rt.cleaning = undefined;
        });
      rt.cleaning = cleaning;
      await cleaning;
      if (w.removedAt) removed++;
      else if (again.reason) stayed.push({ st, w, reason: again.reason });
    }
    if (removed) this.log.info('archived worktree sweep', { removed });
    try {
      await this.askAboutStayed(stayed);
    } catch (e) {
      this.log.warn("couldn't ask about archived threads' worktrees", { error: String(e) });
    }
    return removed;
  },

  // Worktrees the sweep can't prove are already on main by git alone, of
  // threads archived at least ASK_AFTER_MS ago: a thread checks what each
  // holds, removes safe leftovers (already on main in another form,
  // superseded, obsolete or abandoned) and archives itself, asking the user
  // only about genuine unlanded work in plain words. Each branch tip is
  // checked once; nothing new runs while that thread is still open.
  // Ville asked for the check on 20 Nov 2026; Mike asked on 28 Nov 2026
  // for safe leftovers to go automatically instead of asking about slots.
  async askAboutStayed(this: Runner, stayed: Stayed[]): Promise<string | undefined> {
    const file = path.join(this.cfg.home, 'runner', 'worktree-question.json');
    let state: { threadId?: string; asked?: string[] } = {};
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // None yet.
    }
    const open = state.threadId && this.threads.has(state.threadId) && !this.threads.get(state.threadId)!.rec.archivedAt;
    if (open) return undefined;
    const now = Date.parse(this.isoNow());
    const asked = new Set(state.asked ?? []);
    const fresh: (Stayed & { key: string })[] = [];
    for (const x of stayed) {
      if (now - Date.parse(x.st.rec.archivedAt!) < ASK_AFTER_MS) continue;
      // A repo that isn't on this machine (a thread archived under WSL
      // before the runner moved to native Windows, say): no thread can look
      // at it here, and as the asking thread's folder it'd fail them all.
      if (!isDirectory(x.w.mainCheckout)) continue;
      const tip = await git(x.w.mainCheckout, ['rev-parse', '--verify', '--quiet', x.w.branch]);
      const key = `${x.w.path}@${tip.ok ? tip.stdout.trim() : 'gone'}`;
      if (!asked.has(key)) fresh.push({ ...x, key });
    }
    if (!fresh.length) return undefined;
    const list = fresh.map(({ st, w, reason }) =>
      `- ${w.path} (branch ${w.branch}, in ${w.mainCheckout}), from the thread "${st.rec.title ?? st.rec.id}" (${st.rec.id}), archived ${st.rec.archivedAt!.slice(0, 10)}. It stays because ${reason}.`).join('\n');
    const text =
      "Threadbear's daily cleanup found worktrees of archived threads that git couldn't prove are already on main. " +
      `Each thread was archived at least ${ASK_AFTER_MS / 86_400_000} days ago:\n\n${list}\n\n` +
      'For each one, work out whether removing it would lose anything worth keeping. ' +
      'Read git log --oneline main..<branch> and git cherry -v main <branch> in its repo, ' +
      'and git status --short and git diff --stat in the worktree. ' +
      'Check whether that work is already on main in another form (rewritten, squashed, superseded or obsolete), ' +
      'and read its archived thread if it is unclear whether the work was abandoned on purpose.\n\n' +
      'Remove every safe leftover right away without asking: anything whose work is already on main in another form, ' +
      'superseded, obsolete, or intentionally abandoned, with no real uncommitted work. ' +
      'Before removing one, verify its thread is still archived and the folder is still checked out on <branch> ' +
      '(git -C <path> rev-parse --abbrev-ref HEAD), then run: ' +
      'git -C <repo> worktree remove --force <path> && git -C <repo> branch -D <branch>.\n\n' +
      'If every worktree was safe and removed, end the turn with needs "nothing", archive: true, ' +
      'and a short byline of what went.\n\n' +
      'Only if a worktree genuinely holds real unlanded work that was not abandoned (for example a fix whose landing timed out, ' +
      'or meaningful uncommitted edits not on main), leave that worktree in place and end the turn with needs "you" ' +
      'and one ask per such item. Describe the work itself in plain terms (what fix or change would be lost, ' +
      'not slot numbers or branch names), with options to land it or drop it (or keep/drop if it is half-finished). ' +
      'Act on the answers, then end the turn with needs "nothing" and archive: true.';
    const n = fresh.length;
    const threadId = this.create({
      text,
      title: n === 1 ? 'Clean up a leftover worktree' : `Clean up ${n} leftover worktrees`,
      cwd: fresh[0].w.mainCheckout,
      worktree: false,
      startedBy: { kind: 'runner', label: 'Threadbear', why: "archived threads' worktrees that the daily cleanup can't remove by git alone" },
    }).thread.id;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ threadId, asked: [...asked, ...fresh.map((x) => x.key)] }, null, 2) + '\n');
    this.log.info("started a thread to clean up archived threads' worktrees", { threadId, worktrees: fresh.map((x) => x.w.path) });
    return threadId;
  },

  // When the thread is archived or deleted: its worktree and branch go if
  // everything on them is on main; otherwise they stay, and the thread (or,
  // once it's deleted, a notice) says so and how to land or drop them.
  // `again` (the daily sweep): staying says nothing, as it said so before,
  // and why it stays goes in again.reason.
  async cleanUpWorktree(this: Runner, st: ThreadState, deleted = false, again?: { reason?: string }): Promise<void> {
    const { rec } = st;
    const w = rec.worktree;
    if (!w || w.removedAt) return;
    // A box's stopping save holds the thread (box-save.ts): its teardown and
    // cleanup would change the folder under the copy, so it's owed instead,
    // for the next start (settleLostCleanups).
    if (st.rt.holds?.has('save')) {
      this.slot(st, { kind: 'owe' }, w);
      this.markDirty(st);
      this.log.info("worktree cleanup owed: the box's save holds the thread", { threadId: rec.id });
      return;
    }
    const stillOurs = () => deleted || !st.rt.deleted;
    try {
      await this.tearDownWorktree(st, deleted, stillOurs);
    } catch (e) {
      this.log.error('worktree teardown failed', { threadId: rec.id, error: String(e) });
    }
    let result;
    try {
      result = await cleanUpWorktree(w, stillOurs);
    } catch (e) {
      result = { removed: false as const, reason: String((e as Error).message ?? e) };
    }
    this.log.info('worktree cleanup', { threadId: rec.id, path: w.path, ...result });
    // Deleted meanwhile: nothing to record it in, and emit would throw.
    if (st.rt.deleted && !deleted) return;
    // A folder that's another checkout's now counts as a spare: the
    // thread, brought back, never carries on in it (leavesRemovedWorktree).
    this.slot(st, { kind: 'cleaned', removed: result.removed, handedOn: result.removed && Boolean(result.spare || result.taken) }, w);
    if (result.removed) {
      if (deleted) return;
      const text = result.branchLeft
        ? `Removed this thread's worktree, but its branch ${w.branch} stays: ${result.branchLeft}. Everything on it is on main, so git -C ${w.mainCheckout} branch -D ${w.branch} loses nothing.`
        : result.taken
        ? `This thread's worktree had already gone, and its folder ${w.path} is another checkout's now, so it was left alone. Its branch ${w.branch} is gone too.`
        : w.spare
          ? `Deleted this thread's branch ${w.branch} (everything on it is on main) and kept its worktree, build caches and all, for the next thread.`
          : `Removed this thread's worktree and its branch ${w.branch}: everything on it is on main.`;
      this.emit(st, { type: 'system.note', text });
      this.markDirty(st);
      return;
    }
    const how =
      `To land it, run tb land in ${w.path}${deleted ? '' : ' (or bring the thread back and press Land)'}. ` +
      `To drop it, git -C ${w.mainCheckout} worktree remove --force ${w.path} && git -C ${w.mainCheckout} branch -D ${w.branch}.`;
    // Staying, it can't be a spare, so no other thread will use its build
    // caches: they go to free the space (clearBuildCaches says why).
    let cleared: string[] = [];
    if (stillOurs()) {
      try {
        cleared = await clearBuildCaches(w);
      } catch (e) {
        this.log.warn("couldn't clear a kept worktree's build caches", { threadId: rec.id, path: w.path, error: String(e) });
      }
      if (cleared.length) this.log.info("cleared a kept worktree's build caches", { threadId: rec.id, path: w.path, cleared });
    }
    const freed = cleared.length ? ` Its build caches (${cleared.join(', ')}) were cleared to save space, and get built again if it carries on.` : '';
    if (again) {
      again.reason = result.reason;
      return;
    }
    if (deleted) {
      this.notice('info', `"${rec.title}" was deleted, but its worktree at ${w.path} and branch ${w.branch} stay: ${result.reason}. ${how}${freed}`);
      return;
    }
    this.emit(st, { type: 'system.note', text: `This thread's worktree at ${w.path} and its branch ${w.branch} stay: ${result.reason}. ${how}${freed}` });
    this.markDirty(st);
  },
};

export type WorktreesPart = RunnerPart<typeof worktreesPart>;

// A worktree the daily sweep left, and why.
type Stayed = { st: ThreadState; w: WorktreeRecord; reason: string };

// How long a thread is archived before its worktree that stays is asked about.
export const ASK_AFTER_MS = 2 * 86_400_000;

// The daily cleanup: archived threads' worktrees that stayed get another
// go (sweepArchivedWorktrees). Ten minutes after start, then every day.
export function startArchivedWorktreeSweep(runner: Runner, log: Logger): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runner.sweepArchivedWorktrees();
    } catch (e) {
      log.warn('archived worktree sweep failed', { error: String(e) });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), 10 * 60_000);
  const timer = setInterval(() => void run(), 24 * 3_600_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// A slot a thread works in that isn't its own any more (lentFolder): the
// slot, its repo's main checkout, and what became of it, for the notes.
export type LentFolder = { slot: string; main: string; went: string };

// Takes back borrowed worktrees nobody gave back (borrows.ts), in every
// repo a thread here has had a worktree of. Two minutes after start, then
// hourly.
export function startBorrowSweep(runner: Runner, log: Logger): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runner.sweepBorrows();
    } catch (e) {
      log.warn('borrowed worktree sweep failed', { error: String(e) });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), 2 * 60_000);
  const timer = setInterval(() => void run(), 3_600_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
