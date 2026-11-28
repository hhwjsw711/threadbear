// A worktree per thread (docs/thread-worktrees.md): a repo whose patch has
// `worktree` gives each new thread a git worktree and branch of its own,
// made from main, and `tb land` puts the branch on main once its check
// passes. This file is the git side: making one, landing one and cleaning
// one up. The runner (runner.ts) decides when, and says what happened in
// the thread; tb (cli.ts) runs land.
//
// Everything here runs real git. Nothing ever pushes.
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realPath } from './platform.ts';
import { plainShell } from './system-tools.ts';
import type { WorktreePatch } from './patches.ts';
import { inBackground } from './background.ts';
import { mainCheckoutOf as linkedMainCheckout } from './patch-trust.ts';
import { untrustedGitArgs } from './safe-git.ts';
import { carryAcross, formatChanges, crossings, mergeAcross, remakeOwn, touchesFormatted, TreeFormatter, type FormatCommit } from './format-replay.ts';
import { LAND_TIMES_FILE, isCarried, joinQueue, leaveQueue, queueDir, readEntry, readRunning, ridesFree, setRunning, typicalCheckSeconds, waiting, waitingLine, writeEntry, type QueueEntry } from './land-queue.ts';

// What a thread's record keeps about its worktree.
export type WorktreeRecord = {
  repo: string; // the repo's name: the main checkout's folder name ("threadbear")
  mainCheckout: string; // the checkout with main checked out, where it lands
  path: string; // the worktree's root
  branch: string; // "thread/<id8>"
  base: string; // main's commit when it was made
  removedAt?: string; // cleaned up when the thread was archived
  // Archived, and the cleanup hasn't had its say yet: it waits for the CLI and
  // turn-end hooks, so a runner stopping or crashing can come first. The next
  // runner does it (settleLostCleanups).
  cleanupOwed?: boolean;
  // The patch's worktree.keep: the folder is set aside for another thread
  // when this one's done with it, rather than removed (see "spares").
  keep?: string[];
  // Set aside as a spare (with removedAt): the folder is still there, but
  // it's another thread's now, or will be.
  spare?: boolean;
  // The patch that asked for the worktree, relative to `path`: its copy
  // there is where the teardown is read from. Absent in records from before
  // 9 Nov, which look for it from the thread's folder.
  patchFile?: string;
  // When the patch's teardown last ran (it runs as the cleanup starts). Each
  // archive clears it, so it runs once per archive: a delete or the next
  // runner picking the cleanup up again doesn't run it twice. The thread's
  // next turn in the worktree clears it too, saying the teardown ran.
  tornDownAt?: string;
  // Made for a thread another runner moved here (runner/moves.ts placeMove):
  // its files are that runner's work. Whether that work is held from the
  // always-trust is patch-trust-unvouched.json's to say; this lets the runner
  // work the list out again if that file is lost (settleUnvouched).
  movedIn?: true;
  // The mark a runner of 10 Nov 2026 put here instead of that file, read
  // only by settleUnvouched.
  unvouched?: true;
};

export const MAIN = 'main';

export function threadBranch(threadId: string): string {
  return `thread/${threadId.slice(0, 8)}`;
}

type GitResult = { ok: boolean; code: number; stdout: string; stderr: string };

// How long one git may take before it's killed and counts as failed. Long,
// as a land's merge can run the repo's hooks; past it, git has hung (a .git
// swapped for a fifo, say: Codex's review, 9 Nov), and an archive's cleanup
// waiting on it held up messages, actions and handovers for ever. Tests
// shorten it.
export const gitLimits = { timeoutMs: 5 * 60_000 };

// git in `cwd`. Variables that point git at some other repo (set when this
// runs from inside a git hook) are dropped, so -C always wins, and the
// repo's own config can't start an fsmonitor program (safe-git.ts). Killed
// past gitLimits, which makes it a failure (`ok: false`).
export function git(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[k];
  return new Promise((resolve) => {
    execFile('git', untrustedGitArgs(cwd, args), { env, maxBuffer: 16 * 1024 * 1024, timeout: gitLimits.timeoutMs, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      // Killed (past the limit) is -1, never 1: callers read git's own 1 as
      // an answer ("no such ref", "not an ancestor").
      const e = err as { code?: unknown; signal?: unknown } | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : e.signal ? -1 : 1;
      resolve({ ok: !err, code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function gitOut(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<string | undefined> {
  const r = await git(cwd, args, extraEnv);
  return r.ok ? r.stdout.trim() : undefined;
}

// Commits in `range` with a line starting `Important:` that git's trailer
// parser doesn't read (one line each: short hash and subject), or undefined
// when git couldn't say. Uses the same parser as the release's
// `%(trailers:key=Important)`, so what passes here is what gets flagged.
async function unreadImportant(cwd: string, range: string): Promise<string[] | undefined> {
  const r = await gitOut(cwd, ['log', '--first-parent', '--no-merges', '-i', '--grep=^Important:', '--format=%h%x1f%s%x1f%(trailers:key=Important,valueonly,separator=%x20)', range]);
  if (r === undefined) return undefined;
  return r
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\x1f'))
    .filter(([, , why]) => !why?.trim())
    .map(([hash, subject]) => `${hash} ${subject}`);
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.replace(/^(fatal|error): /, '').trim())
      .find(Boolean) ?? 'git failed'
  );
}

// The checkouts of a repo, from `git worktree list --porcelain`.
export type Checkout = { path: string; branch?: string; head?: string; locked?: string };

export async function listCheckouts(cwd: string): Promise<Checkout[] | undefined> {
  const out = await gitOut(cwd, ['worktree', 'list', '--porcelain']);
  return out === undefined ? undefined : parseCheckouts(out);
}

export function parseCheckouts(out: string): Checkout[] {
  const list: Checkout[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const c: Checkout = { path: '' };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) c.path = line.slice('worktree '.length);
      else if (line.startsWith('branch ')) c.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      else if (line.startsWith('HEAD ')) c.head = line.slice('HEAD '.length);
      else if (line === 'locked' || line.startsWith('locked ')) c.locked = line.slice('locked '.length);
    }
    if (c.path) list.push(c);
  }
  return list;
}

export async function mainCheckoutOf(cwd: string): Promise<string | undefined> {
  return (await listCheckouts(cwd))?.find((c) => c.branch === MAIN)?.path;
}

// The real form of a path, to compare two by (platform.ts: on Windows git's
// long names and a cwd's 8.3 short ones are one folder).
export function realpath(p: string): string {
  return realPath(path.resolve(p));
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// The same subfolder of `to` as `cwd` is of `from`, or `to` itself when
// that folder isn't there (it was untracked, or `cwd` was elsewhere).
export function sameSubfolder(cwd: string, from: string, to: string): string {
  const rel = path.relative(realpath(from), realpath(cwd));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return to;
  const there = path.join(to, rel);
  return isDir(there) ? there : to;
}

// --------------------------------------------------------------- making

// `patchFile`: the worktree's own copy of the patch that asked for it.
export type MadeWorktree = { ok: true; worktree: WorktreeRecord; cwd: string; patchFile: string } | { ok: false; reason: string };

// Makes the thread's worktree from main in the main checkout. A leftover
// branch of the thread's name is a reason, never overwritten.
//
// Without the patch's `keep`: `git worktree add -b thread/<id8>
// <parent>/<repo>-threads/<id8> main`, and a leftover folder of that name
// is a reason too.
//
// With `keep`: a spare, if there is one (see "spares" below), switched to
// the new branch with its kept folders left as they were; otherwise a new
// `<repo>-threads/slot-<n>`. The folder isn't named after the thread, as
// it outlives it.
//
// `inUse`: whether an open thread works in a folder (its realpath). A spare
// or slot number it says yes to is passed over: a thread that borrowed a
// slot and moved itself there stays after giving it back (lived-in.ts).
export type MakeWorktreeOptions = { cwd: string; threadId: string; patch: WorktreePatch; inUse?: (dir: string) => boolean };
export function makeWorktree(opts: MakeWorktreeOptions): Promise<MadeWorktree> {
  // One at a time, so two new threads never take the same spare or slot.
  const made = making.then(() => makeWorktreeNow(opts));
  making = made.then(
    () => undefined,
    () => undefined,
  );
  return made;
}

let making: Promise<void> = Promise.resolve();

async function makeWorktreeNow(opts: MakeWorktreeOptions): Promise<MadeWorktree> {
  const top = await gitOut(opts.patch.folder, ['rev-parse', '--show-toplevel']);
  if (!top) return { ok: false, reason: `the ${opts.patch.patch} patch asks for one, but ${opts.patch.folder} isn't in a git repo` };
  const mainCheckout = await mainCheckoutOf(top);
  if (!mainCheckout) return { ok: false, reason: `no checkout of ${path.basename(top)} has ${MAIN} checked out` };
  const repo = path.basename(mainCheckout);
  const threads = path.join(path.dirname(mainCheckout), `${repo}-threads`);
  const id8 = opts.threadId.slice(0, 8);
  const branch = threadBranch(opts.threadId);
  const keep = opts.patch.keep;
  if (!keep && fs.existsSync(path.join(threads, id8))) return { ok: false, reason: `there's already a folder at ${path.join(threads, id8)}` };
  if ((await git(mainCheckout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok) {
    return { ok: false, reason: `the branch ${branch} already exists` };
  }
  const base = await gitOut(mainCheckout, ['rev-parse', MAIN]);
  if (!base) return { ok: false, reason: `couldn't read ${MAIN} in ${mainCheckout}` };
  const patchFile = path.relative(top, realpath(opts.patch.file));
  const done = (where: string): MadeWorktree => ({
    ok: true,
    worktree: { repo, mainCheckout, path: where, branch, base, ...(keep ? { keep } : {}), patchFile },
    cwd: sameSubfolder(opts.cwd, top, where),
    patchFile: path.join(where, patchFile),
  });

  if (keep) {
    for (const spare of await spares(mainCheckout, threads)) {
      if (opts.inUse?.(realpath(spare))) continue;
      const claim = await claimSpare(spare);
      if (!claim) continue;
      if (await reuse(spare, branch, base, keep)) {
        fs.rmSync(claim, { force: true });
        return done(spare);
      }
      // Couldn't be put right: it stays unlocked, out of the pool, for
      // someone to look at, and the thread gets a new slot.
    }
  }

  fs.mkdirSync(threads, { recursive: true });
  if (!keep) {
    const where = path.join(threads, id8);
    const add = await addWorktree(mainCheckout, branch, where, base);
    return add === true ? done(where) : { ok: false, reason: `git worktree add failed: ${add}` };
  }
  // The first free slot number: no folder there, and not a path git still
  // has registered after its folder went (git refuses to add there). One
  // git refuses all the same (borrow-worktree.sh took it at that moment)
  // tries the next, a few times, as the script does. 21 Nov: a slot folder
  // removed by hand left every new thread without a worktree.
  const registered = new Set(((await listCheckouts(mainCheckout)) ?? []).map((c) => path.resolve(c.path)));
  let refused = '';
  for (let n = 1, tries = 0; tries < 5; n++) {
    const where = path.join(threads, `slot-${n}`);
    if (lexists(where) || registered.has(path.resolve(where)) || registered.has(realpath(where)) || opts.inUse?.(realpath(where))) continue;
    const add = await addWorktree(mainCheckout, branch, where, base);
    if (add === true) return done(where);
    refused = add;
    tries++;
  }
  return { ok: false, reason: `git worktree add failed: ${refused}` };
}

// `git worktree add -b`, which makes the branch before it looks at the
// folder: when it then refuses, the branch it made goes too (it was checked
// not to be there before, and is at `base` with nothing checked out), or the
// thread's next try would be refused for it. true, or why not.
async function addWorktree(mainCheckout: string, branch: string, where: string, base: string): Promise<true | string> {
  const add = await git(mainCheckout, ['worktree', 'add', '-b', branch, where, base]);
  if (add.ok) return true;
  const left = await gitOut(mainCheckout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  const checkouts = left === base ? await listCheckouts(mainCheckout) : undefined;
  // Deleted only if it's still at base as git deletes it (update-ref's old
  // value), so a branch moved on meanwhile stays (Codex's review, 21 Nov).
  if (checkouts && !checkouts.some((c) => c.branch === branch)) await git(mainCheckout, ['update-ref', '-d', `refs/heads/${branch}`, base]);
  return firstLine(add.stderr.split('\n').filter((l) => !l.startsWith('Preparing worktree')).join('\n'));
}

// Whether anything is at `p`, a link to nowhere too.
function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- spares
//
// A repo whose patch has worktree.keep (its build caches, like
// "app/.build") gets its worktrees reused: SwiftPM's cache only works in
// the folder it was built in, so every new worktree was a cold build of
// several minutes. When a thread is archived with everything landed, its
// worktree is detached, its branch deleted, and the folder locked with
// the reason below: a spare. The next new thread unlocks one, wipes
// everything git doesn't track except the kept folders, and checks out its
// branch there, so its first build only recompiles what changed.

export const SPARE = 'threadbear spare';

// How many spares a repo keeps. Each holds its build caches (a gigabyte or
// so for Threadbear's), so past this an archived thread's worktree is
// removed as before.
export const MAX_SPARES = 6;

// The repo's spares, in `threads` (its <repo>-threads folder).
async function spares(mainCheckout: string, threads: string): Promise<string[]> {
  const dir = realpath(threads);
  return ((await listCheckouts(mainCheckout)) ?? [])
    .filter((c) => c.locked === SPARE && path.dirname(realpath(c.path)) === dir && isDir(c.path))
    .map((c) => c.path)
    .sort();
}

// Takes a spare out of the pool, or says another got there first. Not
// `git worktree unlock`: two at once both read the lock, and the second
// one's unlink finding no file still counts as success, so both took the
// spare (Codex, 8 Nov). A rename of git's lock file is atomic, so only
// one claimer wins; borrow-worktree.sh claims the same way.
//
// The renamed file stays, touched, until the spare is set up, and the borrow
// sweep counts it as the folder being used (borrows.ts lastUsed): between
// the claim and the checkout the folder is detached and unlocked, which the
// sweep would otherwise take for a spare claimed and never set up, and put
// back in the pool under the thread setting it up (Codex's review, 21 Nov).
// Returns the claim's file, or undefined when another got there first.
async function claimSpare(spare: string): Promise<string | undefined> {
  const admin = await gitOut(spare, ['rev-parse', '--absolute-git-dir']);
  if (!admin) return undefined;
  const lock = path.join(admin, 'locked');
  const claimed = `${lock}${CLAIMED}${process.pid}-${Date.now()}`;
  // Touched before the rename, so it's never there with an old time.
  const now = new Date();
  try {
    fs.utimesSync(lock, now, now);
    fs.renameSync(lock, claimed);
  } catch {
    return undefined;
  }
  return claimed;
}

// What a claimed spare's lock file is renamed to: locked<CLAIMED><pid>-<ms>.
export const CLAIMED = '.claimed-';

// A claimed spare, made like new on `branch` at `base`. The kept folders
// are left as they are; everything else git doesn't track goes, ignored
// files too (an old thread's node_modules, say), and setup runs again.
//
// Not one with changes to tracked files: a spare never has them (its
// cleanup or give-back saw it clean), so someone is working there, and the
// reset would take their work (21 Nov). It stays unlocked, out of the pool.
async function reuse(where: string, branch: string, base: string, keep: string[]): Promise<boolean> {
  const status = await git(where, ['status', '--porcelain', '--untracked-files=no']);
  if (!status.ok || status.stdout.trim()) return false;
  const exclude = keep.flatMap((k) => ['-e', `/${k.replace(/^\/+|\/+$/g, '')}`]);
  for (const args of [['reset', '-q', '--hard'], ['clean', '-ffdxq', ...exclude], ['checkout', '-q', '-b', branch, base]]) {
    if (!(await git(where, args)).ok) return false;
  }
  return true;
}

// What the agent is told in its appended system prompt. The timeout: time
// queued behind another landing counts against the agent's own limit for a
// command (Claude Code's background default is 30 minutes), and on 11 Nov
// one cut a land off partway through its check that way.
export function worktreeInstructions(w: WorktreeRecord): string {
  return [
    `This thread has its own git worktree of ${w.repo} at ${w.path}, on the branch ${w.branch}, made from ${MAIN}.`,
    `Commit your work there, on that branch. Other threads work in worktrees of their own, and the main checkout at ${w.mainCheckout} isn't yours to edit.`,
    `When the work is done and checked, run \`tb land\` in the worktree: it rebases the branch on ${MAIN}, runs the repo's check and fast-forwards ${MAIN} to it. It may first wait for another thread's landing, so run it in the background with a 2-hour timeout (7200000 ms; 30 minutes isn't enough when it waits behind other landings). After landing you can carry on, and the next \`tb land\` lands only what's new.`,
  ].join(' ');
}

// --------------------------------------------------------------- landing

export type LandTarget = {
  path: string; // the worktree's root
  branch: string;
  mainCheckout: string;
  check?: string; // the patch's worktree.check
};

export type LandOptions = {
  dryRun?: boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
  // How the check runs; tests pass a plain shell.
  shell?: string[];
  // The CLI reads the patch after rebasing, including changes to the
  // required check made by a landing it just waited for.
  readCheck?: () => Promise<string | undefined>;
  // Why these files (what the landing changes, from the worktree's root)
  // can't land now, or undefined: the CLI's is a GitHub workflow that's red
  // on main (land-gate.ts). Asked after the rebase, before the check, so a
  // held landing doesn't wait out a check first.
  hold?: (root: string, files: string[]) => Promise<string | undefined>;
  // `tb land --despite-red`: this landing is the repair for what's red, so
  // `hold` isn't asked about its own files. In the queue it's a fix: it
  // goes first in any group check, outside the halving's limit (setAside
  // has the one way it's left out).
  despiteRed?: boolean;
  // `tb land --allow-format <id>`: the format commands this landing adds to
  // .git-blame-ignore-revs, or config files they run with that it changes,
  // which later landings run on this Mac, were shown and are meant
  // (formatChanges' id for exactly those). The Land chip never passes it.
  allowFormat?: string;
  // Where readCheck looks from, relative to the worktree's root (a
  // subfolder's patch can ask for its own check). Only landings that look
  // from the same place are checked together, so the check read on the
  // stack is the one each of them asks for.
  checkFrom?: string;
  // The check hosts this landing asks for: THREADBEAR_CHECK_HOST if left out.
  checkHost?: string;
  // Push main to origin once it has landed, folding GitHub's main in first
  // when that has moved too (pushMain). The CLI's comes from runner.json's
  // `pushAfterLanding`, so only the owner's own Mac pushes.
  push?: boolean;
  // The CLI's: on SIGTERM, SIGINT or SIGHUP while waiting for the landing
  // lock, leave the line, say so, and exit (land, `stopped`).
  sayWhenStopped?: boolean;
  // `tb land --full`: the whole check again, reading none of check.sh's pass
  // records (THREADBEAR_CHECK_FRESH), for a pass a record shouldn't vouch for.
  full?: boolean;
  // Called once it holds the landing lock (the CLI's worker stops listening
  // for its follower then: land-detach.ts). False: the tb that was run has
  // gone meanwhile, so it stops before its check, out of the line.
  onLocked?: () => boolean;
};

// The hosts a landing asked for, as check.sh would take them (an ssh host
// name each, comma-separated), or undefined for none.
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
function askedHosts(v: string | undefined): string[] {
  return (v ?? '').split(',').map((h) => h.trim()).filter((h) => HOST_NAME.test(h));
}
// Where a check ran, as its "Checking on" line says: a host, or a split
// check's <linux>+<mac> pair (scripts/check-remote.sh, split_run), which
// check-remote.sh takes as the host list and routes each step back to the
// host of the pair it ran on.
const CHECKED_ON = /^[A-Za-z0-9][A-Za-z0-9._@-]*(\+[A-Za-z0-9][A-Za-z0-9._@-]*)?$/;
// Whether a run of what failed went where the group's check ran it: the same
// host, or for a pair, the pair or one host of it (a run of steps of one kind
// goes only to that kind's host of the pair).
export function sameCheckHost(ran: string | undefined, groupRan: string | undefined): boolean {
  if (ran === groupRan) return true;
  if (!ran || !groupRan || !groupRan.includes('+')) return false;
  return groupRan.split('+').includes(ran);
}
// A group's check runs in the holder's tb, with the holder's environment, so
// what the others asked for went nowhere: on 13 Nov a landing that set
// THREADBEAR_CHECK_HOST=cloud to keep off Tinker Desk's long builds was
// checked there, in another thread's group. Each entry keeps what its own
// tb asked for, and the group's check gets them all, in line order after the
// holder's, as THREADBEAR_CHECK_PREFER: scripts/check-remote.sh tries those
// hosts first and keeps the rest of its list behind them, so a group that
// needs a Mac still finds one.
export function checkPreference(own: string | undefined, others: (string | undefined)[]): string | undefined {
  const all = [...askedHosts(own), ...others.flatMap(askedHosts)];
  return all.length ? [...new Set(all)].join(',') : undefined;
}

// How many lines of a failed check's output are shown.
const CHECK_TAIL_LINES = 40;

// `tb land`: refuses with uncommitted changes, rebases on main, runs the
// check, fast-forwards main in its checkout and prints what landed.
// Returns the exit code. Every refusal leaves main as it was.
//
// One landing at a time holds the repo's lock, through its check and the
// fast-forward, so main only ever moves to a commit whose check passed. But
// the ones waiting don't each wait for a check of their own (12 Nov: a dozen
// in the line, 40 minutes and more each): a landing joins the queue
// (land-queue.ts) before it waits, and whoever holds the lock checks all
// that are waiting together with its own, stacked on main in the order they
// came, and lands them all at once. A failed group check is narrowed down by
// halves (docs/thread-worktrees.md, "Landing together").
export async function land(t: LandTarget, opts: LandOptions = {}): Promise<number> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const err = opts.err ?? ((l: string) => process.stderr.write(l + '\n'));
  const commonRel = await gitOut(t.path, ['rev-parse', '--git-common-dir']);
  if (!commonRel) {
    err(`${t.path} isn't a git checkout, so there's nothing to land.`);
    return 1;
  }
  const common = path.resolve(t.path, commonRel);
  const gitDir = path.resolve(t.path, (await gitOut(t.path, ['rev-parse', '--git-dir'])) ?? commonRel);
  const timesFile = path.join(common, LAND_TIMES_FILE);
  const asked = Date.now();

  // One tb land at a time in a worktree: it rebases before taking the
  // repo's lock now, and two at once would abort each other's rebase.
  let mineOnly: () => Promise<void>;
  try {
    const now = await holdLock(path.join(gitDir, 'threadbear-land-worktree.lock'), false);
    if (now) mineOnly = now;
    else {
      out('Another tb land is running in this worktree; waiting for it to finish...');
      mineOnly = (await holdLock(path.join(gitDir, 'threadbear-land-worktree.lock'), true))!;
    }
  } catch (e) {
    err(`Couldn't lock the worktree for landing: ${(e as Error).message}`);
    return 1;
  }
  let entry: QueueEntry | undefined;
  let entryHeld: (() => Promise<void>) | undefined;
  let keepEntry = false;
  try {
    const unrecovered = await recoverDetached(t, gitDir, out, err);
    if (unrecovered !== undefined) return unrecovered;
    await recoverLandedFor(t, common, out);

    // Refusals, and conflicts with main as it is now, come straight away
    // rather than after the wait. It's done again with the lock held, as
    // main will have moved.
    const ready = await prepare(t, out, err, opts.despiteRed ? undefined : opts.hold, opts.allowFormat);
    if (typeof ready === 'number') return ready;

    // A dry run, and a branch with a merge on it (it's merged with main,
    // never replayed onto others), are never put in someone else's check.
    // The entry carries the check this branch asks for: only landings that
    // ask for the same one are checked together. Its own lock says its tb
    // is still there (a pid can be reused; a lock dies with its holder).
    if (!opts.dryRun && !ready.hasMerge) {
      try {
        const check = opts.readCheck ? await opts.readCheck() : t.check;
        const checkHost = askedHosts(opts.checkHost ?? process.env.THREADBEAR_CHECK_HOST).join(',');
        entry = joinQueue(common, {
          branch: t.branch, path: t.path, base: ready.base, commit: ready.commit, check: check ?? null, checkFrom: opts.checkFrom ?? '',
          ...(checkHost ? { checkHost } : {}),
          ...(opts.despiteRed ? { fix: true } : {}),
          // Read by scripts/sync-main.sh: only a landing that will push is
          // one it leaves GitHub's main to.
          ...(opts.push ? { push: true } : {}),
        });
        entryHeld = await holdLock(entryLockFile(common, entry.id), false);
        if (!entryHeld) throw new Error('entry lock taken');
        // An earlier tb land of this branch whose tb has gone, carried since
        // a check of it started, is this one's now: one entry for a branch,
        // so it can't be checked after this one failed (Gemini's review).
        // This one takes over its place as carried, and its limits, so it
        // isn't lost if this tb goes too (Codex's review). Not one in the
        // check running now, which may still land it or refuse it: then the
        // two never go in one group (stackWaiting), and this one's
        // recoverLandedFor or rebase finds what landed.
        const inRunning = readRunning(common)?.entries ?? [];
        for (const other of waiting(common)) {
          if (other.id === entry.id || other.branch !== t.branch || inRunning.includes(other.id) || (await ownerWaiting(common, other))) continue;
          const mine = readEntry(common, entry.id);
          // Only when it asks for just what was checked: the same commits,
          // as they were or rebased (stillAsked), and nothing more. A
          // rewritten branch, or more on top, hasn't been in a check, so
          // it earns its own mark (Codex's review).
          const count = async (e: QueueEntry): Promise<string | undefined> => gitOut(t.path, ['rev-list', '--count', `${e.base}..${e.commit}`]);
          const same = !!mine && (mine.commit === other.commit ||
            ((await stillAsked(t.path, other)) && (await count(mine)) === (await count(other))));
          if (mine && same && isCarried(other)) {
            const kept = { inCheckAt: other.inCheckAt, limit: other.limit, limitAt: other.limitAt, ordinaryAt: other.ordinaryAt };
            entry = { ...mine, ...Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== undefined)) };
            writeEntry(common, entry);
          }
          leaveQueue(common, other.id);
        }
      } catch {
        if (entry) leaveQueue(common, entry.id);
        entry = undefined; // it still lands, by itself
      }
    }
    // Left out of its group meanwhile (findBroken): it stops waiting and
    // says why now, not after the checks of everyone still in the line.
    const refused = (): QueueEntry['refused'] => (entry ? readEntry(common, entry.id)?.refused : undefined);
    const landedMeanwhile = (): QueueEntry | undefined => {
      const now = entry && readEntry(common, entry.id);
      return now?.result ? now : undefined;
    };
    let release: (() => Promise<void>) | undefined;
    // Stopped while it waits (an agent's time limit, Ctrl-C): it's out of
    // the line, as nobody would hear how its landing went, so it says so in
    // what its thread reads. On 17 Nov two waits killed by the two-hour
    // limit left their threads thinking they were still queued.
    // One already in a group check stays in the line, and the holders land
    // it once a check with it passes (isCarried, in land-queue.ts), and one
    // whose group has landed has: it says which (Codex's review).
    const stopped = (signal: NodeJS.Signals): void => {
      const now = entry && readEntry(common, entry.id);
      const running = !!now && !now.result && !now.refused && !now.alone && !!readRunning(common)?.entries?.includes(now.id);
      const inCheck = !!now && (isCarried(now) || running);
      // Marked here too, in case the holder hasn't yet.
      if (now && running && now.inCheckAt === undefined) writeEntry(common, { ...now, inCheckAt: Date.now() });
      const said = now?.result
        ? `it had already landed with its group (${now.result.landed.slice(0, 9)} on ${MAIN}); its next tb land moves ${t.branch} there.`
        : inCheck
          ? `${t.branch} stays in the line, as it was in a group check: the landings after it carry it and land it once a check with it passes, unless ${t.branch} drops those commits first. Its next tb land says whether it landed, and lands it if not.`
          : `${t.branch} is out of the line and nothing of it landed. Run tb land again to rejoin (in the background, with a 2-hour timeout).`;
      if (entry && !now?.result && !inCheck) leaveQueue(common, entry.id);
      err(`tb land was stopped (${signal}) while it waited in the landing queue: ${said}`);
      process.exit(128 + (os.constants.signals[signal] ?? 15));
    };
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
    if (opts.sayWhenStopped) for (const s of signals) process.once(s, stopped);
    try {
      // Landed with its group meanwhile: it stops waiting too. The lock had
      // nothing left for it to do (its own worktree is moved below), and on
      // 24 Nov such waits sat about an hour while other groups took the lock
      // in turn.
      release = await lockLanding(path.join(common, 'threadbear-land.lock'), out, () => waitingLine(common, timesFile, entry) + longWait(asked), () => !!refused() || !!landedMeanwhile());
    } catch (e) {
      err(`Couldn't lock the repo for landing: ${(e as Error).message}`);
      return 1;
    } finally {
      for (const s of signals) process.removeListener(s, stopped);
    }
    // Its tb gone just as the lock came: it stops before its check, unless
    // a check of it has already started (carried) or it has landed, which
    // go on as they would have (Gemini's review).
    const goesOn = (): boolean => {
      const now = entry && readEntry(common, entry.id);
      return !!now && (!!now.result || isCarried(now));
    };
    let unheard = false;
    if (release && opts.onLocked && !opts.onLocked()) unheard = true;
    if (release && unheard && !goesOn()) {
      await release();
      err(`tb land was stopped just as it got the landing lock, before its check: ${t.branch} is out of the line and nothing of it landed. Run tb land again to rejoin.`);
      return 129;
    }
    if (!release) {
      const landed = landedMeanwhile();
      if (landed) {
        // As once the lock comes: from here a stop doesn't cut moving the
        // branch short (Codex's and Gemini's reviews). It goes on even if
        // its tb has gone, as goesOn() lets a landed one.
        opts.onLocked?.();
        return await landedByAnother(t, landed, out);
      }
      err(refused()?.text ?? `${t.branch} was left out of its group's check, so nothing landed. Run tb land again.`);
      return 1;
    }
    try {
      const mine = entry && readEntry(common, entry.id);
      if (mine?.result) return await landedByAnother(t, mine, out);
      if (mine?.refused) {
        err(mine.refused.text);
        return 1;
      }
      // An earlier tb of this branch, killed, may have landed while this one
      // waited.
      await recoverLandedFor(t, common, out);
      const code = await landLocked(t, opts, { file: timesFile, waitedMs: Date.now() - asked, entryId: entry?.id }, common, gitDir, mine?.limit === undefined ? undefined : { limit: mine.limit, at: mine.limitAt });
      // Carried, with nobody to hear, and it didn't land: it stays in the
      // line for the holders after, as it would have a second earlier
      // (Gemini's review). A group it fails in refuses it in the end.
      if (code !== 0 && unheard && entry && isCarried(readEntry(common, entry.id) ?? entry)) keepEntry = true;
      return code;
    } finally {
      await release();
    }
  } finally {
    if (entry && !keepEntry) leaveQueue(common, entry.id);
    await entryHeld?.();
    if (entry) fs.rmSync(entryLockFile(common, entry.id), { force: true });
    await mineOnly();
  }
}

// What landed for a commit whose tb had gone by then (original commit ->
// landed tip), in the git common dir, so its next tb land moves its branch
// there before anything else, even if this one couldn't (the worktree was
// busy or had changes). Otherwise that tb land would rebase the original
// again, and a commit made empty on purpose would land twice.
const landedForDir = (common: string): string => path.join(common, 'threadbear-land-done');

function writeLandedFor(common: string, commit: string, landed: string): void {
  try {
    fs.mkdirSync(landedForDir(common), { recursive: true });
    fs.writeFileSync(path.join(landedForDir(common), commit), landed);
    // Old ones go: a branch moved on long since won't match them.
    const old = Date.now() - 7 * 24 * 3600_000;
    for (const f of fs.readdirSync(landedForDir(common))) {
      const file = path.join(landedForDir(common), f);
      if (fs.statSync(file).mtimeMs < old) fs.rmSync(file, { force: true });
    }
  } catch {
    // moveGoneBranch still tries.
  }
}

// Whether a note says `commit` landed, as something now on main.
async function landedFor(cwd: string, common: string, commit: string, main: string): Promise<boolean> {
  let landed: string;
  try {
    landed = fs.readFileSync(path.join(landedForDir(common), commit), 'utf8').trim();
  } catch {
    return false;
  }
  return /^[0-9a-f]{40,64}$/.test(landed) && (await git(cwd, ['merge-base', '--is-ancestor', landed, main])).ok;
}

async function recoverLandedFor(t: LandTarget, common: string, out: (line: string) => void): Promise<void> {
  const head = await gitOut(t.path, ['rev-parse', 'HEAD']);
  if (!head || !/^[0-9a-f]{40,64}$/.test(head)) return;
  const file = path.join(landedForDir(common), head);
  let landed: string;
  try {
    landed = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return;
  }
  // A note left by an older tb land for a commit that landed as it was:
  // the branch is already there.
  if (landed === head) {
    fs.rmSync(file, { force: true });
    return;
  }
  if ((await gitOut(t.path, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== t.branch) return;
  if (!(await git(t.path, ['merge-base', '--is-ancestor', landed, `refs/heads/${MAIN}`])).ok) return;
  if ((await git(t.path, ['reset', '-q', '--keep', landed])).ok) {
    out(`An earlier tb land of ${t.branch} landed while its tb was stopped; the branch is moved to what landed.`);
    fs.rmSync(file, { force: true });
  }
}

// A landed entry's branch, moved to what landed for an owner that's gone,
// with that worktree's own tb land lock held, and only while it's clean and
// still on what it asked to land.
async function moveGoneBranch(e: QueueEntry, landed: string): Promise<void> {
  const gitDir = await gitOut(e.path, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) return;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await holdLock(path.join(gitDir, 'threadbear-land-worktree.lock'), false);
  } catch {
    return;
  }
  if (!release) return; // a new tb land there sees to it
  try {
    if ((await gitOut(e.path, ['rev-parse', 'HEAD'])) === e.commit &&
        (await gitOut(e.path, ['rev-parse', '--abbrev-ref', 'HEAD'])) === e.branch &&
        (await gitOut(e.path, ['status', '--porcelain', '--untracked-files=all'])) === '') {
      // The note stays: another worktree on the same commit may still need
      // it (Codex's review, 13 Nov). Old ones go after a week.
      await git(e.path, ['reset', '-q', '--keep', landed]);
    }
  } finally {
    await release();
  }
}

const entryLockFile = (common: string, id: string): string => path.join(queueDir(common), `${id}.lock`);

// Whether an entry's tb is still waiting for its answer: it holds its
// entry's lock until it exits.
async function ownerWaiting(common: string, e: QueueEntry): Promise<boolean> {
  if (!fs.existsSync(entryLockFile(common, e.id))) return false;
  const now = readEntry(common, e.id);
  if (!now || now.result || now.refused) return false;
  try {
    const free = await holdLock(entryLockFile(common, e.id), false);
    if (!free) return true;
    await free();
    return false;
  } catch {
    return false;
  }
}

// A commit as tb land compares it across a rebase: its author, message and
// change, exactly, less only what a rebase moves (hunk positions, blob
// ids). Not git's patch id, which ignores whitespace and the message, so an
// amend that changed only those would pass for the same (Codex's review).
// Context lines that changed underneath still differ: that's then taken for
// a rewrite, which only costs a check.
async function asMade(cwd: string, c: string): Promise<string | undefined> {
  const meta = await git(cwd, ['log', '-1', '--format=%an%x00%ae%x00%B', c]);
  const diff = await git(cwd, ['diff-tree', '-p', '--binary', '--no-color', '--no-ext-diff', '--no-renames', '--no-commit-id', '--root', c]);
  if (!meta.ok || !diff.ok) return undefined;
  return `${meta.stdout}\0${diff.stdout.split('\n').filter((l) => !l.startsWith('@@') && !l.startsWith('index ')).join('\n')}`;
}

// The commits a landing asked to land, oldest first, or undefined if git
// can't say.
async function askedCommits(cwd: string, e: QueueEntry): Promise<string[] | undefined> {
  const list = await gitOut(cwd, ['rev-list', '--reverse', '--no-merges', `${e.base}..${e.commit}`]);
  return list === undefined ? undefined : list.split('\n').filter(Boolean);
}

// Whether each of `asked` was made again, as it was (asMade), among the
// commits of `range`.
async function madeAgainIn(cwd: string, asked: string[], range: string): Promise<boolean> {
  if (!asked.length) return false;
  // Subjects as git prints them, untrimmed: only commits with one of the
  // asked ones are read in full.
  const listed = await git(cwd, ['log', '--no-merges', '--format=%H%x00%s', range]);
  if (!listed.ok) return false;
  const subjects = new Map<string, string>();
  for (const c of asked) {
    const s = await git(cwd, ['log', '-1', '--format=%s', c]);
    if (!s.ok) return false;
    subjects.set(c, s.stdout.replace(/\n$/, ''));
  }
  const wantedSubjects = new Set(subjects.values());
  const candidates = listed.stdout.split('\n').map((l) => l.split('\0')).filter(([h, sub]) => h && sub !== undefined && wantedSubjects.has(sub)).map(([h]) => h);
  if (candidates.length < asked.length) return false;
  const wanted = new Map<string, number>();
  for (const c of asked) {
    const made = await asMade(cwd, c);
    if (made === undefined) return false;
    wanted.set(made, (wanted.get(made) ?? 0) + 1);
  }
  let left = asked.length;
  for (const c of candidates) {
    const made = await asMade(cwd, c);
    const n = made === undefined ? 0 : wanted.get(made) ?? 0;
    if (!n) continue;
    wanted.set(made!, n - 1);
    if (--left === 0) return true;
  }
  return false;
}

// Whether what a landing asked to land is on main already, landed by its
// next tb land or with another group: as it was, or made again on it.
async function landedOn(cwd: string, e: QueueEntry, main: string): Promise<boolean> {
  if ((await git(cwd, ['merge-base', '--is-ancestor', e.commit, main])).ok) return true;
  const asked = await askedCommits(cwd, e);
  return !!asked && (await madeAgainIn(cwd, asked, `${e.base}..${main}`));
}

// Whether a landing whose tb has gone still asks for what it asked to land:
// its branch has those commits, as they were, with more on top, or made
// again as they were (asMade). On 23 Nov two passing group checks
// landed nothing because a member's agent, its tb killed, ran tb land
// again, and that rebased the branch before it waited: the same commits on
// a newer main. One whose branch was rewritten without them (amended,
// reset) asks for something else now. Nor one rebased with a commit made
// empty on purpose: its next tb land keeps that commit, as rebase does,
// and would land it again (Codex's review). Then it's checked again
// without, as before.
async function stillAsked(cwd: string, e: QueueEntry): Promise<boolean> {
  const tip = await gitOut(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${e.branch}`]);
  if (!tip || !/^[0-9a-f]{40,64}$/.test(tip)) return false;
  if (tip === e.commit) return true;
  const asked = await askedCommits(cwd, e);
  if (!asked?.length) return false;
  // Moved at all, even with only more on top: its next tb land's rebase
  // keeps an empty commit, and no note finds the new tip (Codex's review).
  for (const c of asked) {
    const tree = await gitOut(cwd, ['rev-parse', `${c}^{tree}`]);
    if (!tree || tree === (await gitOut(cwd, ['rev-parse', `${c}^^{tree}`]))) return false;
  }
  if ((await git(cwd, ['merge-base', '--is-ancestor', e.commit, tip])).ok) return true;
  // From its base, so one of them already on main (the branch rebased
  // onto it since) still counts (Gemini's review).
  return madeAgainIn(cwd, asked, `${e.base}..${tip}`);
}

// A group check runs with HEAD detached at the stack (landLocked). This
// marker, in the worktree's own git dir, says so while it runs; a tb killed
// partway leaves it, and the next tb land in the worktree (none can be
// running: it holds the worktree's lock) puts the branch back.
const detachedMarker = (gitDir: string): string => path.join(gitDir, 'threadbear-land-checking.json');

// Back on the branch from a group check's detached HEAD, `top` (the stack).
// Commits made there meanwhile go onto the branch first, as a rebase would
// carry them: on 13 Nov an agent committed its fix there while its group
// check ran, the next tb land checked the branch out, and the fix was left
// on no branch at all, silently, so the same check failed again. One that
// won't go on cleanly leaves HEAD where it is and says how to keep them.
// `top` is unknown only in a marker from before it was written down.
async function leaveStack(t: LandTarget, gitDir: string, own: string, top: string | undefined): Promise<{ ok: true; carried?: string } | { ok: false; reason: string }> {
  const head = await gitOut(t.path, ['rev-parse', 'HEAD']);
  const detached = (await gitOut(t.path, ['rev-parse', '--abbrev-ref', 'HEAD'])) === 'HEAD';
  if (!detached || !head) {
    const back = await git(t.path, ['checkout', '-q', t.branch]);
    return back.ok ? { ok: true } : { ok: false, reason: `${t.branch} couldn't be checked out in ${t.path}: ${firstLine(back.stderr || back.stdout)}` };
  }
  // A marker from before `top` was written down can't tell the stack from
  // commits made on it, so it never checks out over them (Codex, 13 Nov).
  if (!top) {
    return { ok: false, reason: `HEAD in ${t.path} is detached at ${head.slice(0, 9)}, and tb land can't tell whether commits were made on it. If any are yours, keep them (git log there, then git cherry-pick them onto ${t.branch}); then git checkout ${t.branch} there and run tb land again.` };
  }
  // The checkout, only from `from`: HEAD is read again just before, and the
  // reflog after says what it really moved from, as a commit can be made
  // in between (Codex, 13 Nov).
  const checkoutFrom = async (from: string, carried?: string): Promise<{ ok: true; carried?: string } | { ok: false; reason: string }> => {
    const pre = carried ? `${carried}\nBut ` : '';
    const now = await gitOut(t.path, ['rev-parse', 'HEAD']);
    if (now !== from) {
      return { ok: false, reason: `${pre}HEAD in ${t.path} moved to ${now?.slice(0, 9) ?? '?'} while tb land was putting ${t.branch} back, so it's left there. Keep anything of yours on it (git cherry-pick ${from.slice(0, 9)}..${now?.slice(0, 9) ?? 'HEAD'} onto ${t.branch}), then git checkout ${t.branch} and run tb land again.` };
    }
    const back = await git(t.path, ['checkout', '-q', t.branch]);
    if (!back.ok) return { ok: false, reason: `${pre}${t.branch} couldn't be checked out in ${t.path}: ${firstLine(back.stderr || back.stdout)}. Check it out there, then run tb land again.` };
    // This checkout's own entry, not whatever is newest by now (a hook's
    // commit after it, say): detached, git names where it moved from in full.
    const log = (await gitOut(t.path, ['reflog', 'show', '-n', '20', '--format=%gs', 'HEAD'])) ?? '';
    const left = /^checkout: moving from ([0-9a-f]{40,}) to /m.exec(log)?.[1];
    if (left !== from) {
      return { ok: false, reason: `${pre}A commit was made in ${t.path} just as ${t.branch} was checked out again, and it's on no branch now: ${left?.slice(0, 9) ?? 'see git reflog'}. Keep it with git cherry-pick ${from.slice(0, 9)}..${left?.slice(0, 9) ?? '<it>'}, then run tb land again.` };
    }
    return { ok: true, ...(carried ? { carried } : {}) };
  };
  if (head === top) return checkoutFrom(head);
  const keep = `Nothing was moved, so they're safe where HEAD is. To keep them: git checkout ${t.branch}, then git cherry-pick ${top.slice(0, 9)}..${head.slice(0, 9)} in ${t.path}, then run tb land again.`;
  const made = (await git(t.path, ['merge-base', '--is-ancestor', top, head])).ok
    ? await gitOut(t.path, ['rev-list', '--reverse', `${top}..${head}`])
    : undefined;
  if (made === undefined) {
    return { ok: false, reason: `HEAD in ${t.path} was moved off the checked group (${top.slice(0, 9)}) to ${head.slice(0, 9)} while tb land had it, so ${t.branch} wasn't checked out again, in case that has work of yours on it. Check out ${t.branch} there when it's safe, then run tb land again.` };
  }
  const list = made.split('\n').filter(Boolean);
  const merges = await gitOut(t.path, ['rev-list', '--merges', `${top}..${head}`]);
  const tip = merges === '' ? await pick(t.path, list, own) : undefined;
  const ids = (await gitOut(t.path, ['log', '--oneline', '--no-decorate', `${top}..${head}`])) ?? list.join('\n');
  if (!tip) {
    return { ok: false, reason: [`Commits were made in ${t.path} on top of the checked group, which isn't ${t.branch}, and they don't go onto ${t.branch} cleanly:`, ...ids.split('\n').map((l) => `  ${l}`), keep].join('\n') };
  }
  if (!(await git(t.path, ['update-ref', `refs/heads/${t.branch}`, tip, own])).ok) {
    return { ok: false, reason: [`Commits were made in ${t.path} on top of the checked group, and ${t.branch} couldn't be moved to take them:`, ...ids.split('\n').map((l) => `  ${l}`), keep].join('\n') };
  }
  // Those are on the branch now: if the checkout below stops, the next tb
  // land carries only what's past `head` (Codex, 13 Nov).
  try {
    if (fs.existsSync(detachedMarker(gitDir))) fs.writeFileSync(detachedMarker(gitDir), JSON.stringify({ branch: t.branch, own: tip, top: head }));
  } catch {
    // Then the next one stops and says what to keep, as with an old marker.
  }
  return checkoutFrom(head, `Commits made on the checked group while tb land had this worktree were moved onto ${t.branch}, as the group itself isn't yours to land:\n${ids.split('\n').map((l) => `  ${l}`).join('\n')}`);
}

// A number is the exit code to stop with: the branch couldn't be put back.
async function recoverDetached(t: LandTarget, gitDir: string, out: (line: string) => void, err: (line: string) => void): Promise<number | undefined> {
  let m: { branch?: string; own?: string; top?: string } | undefined;
  try {
    m = JSON.parse(fs.readFileSync(detachedMarker(gitDir), 'utf8'));
  } catch {
    return undefined;
  }
  if (m?.branch === t.branch && m.own &&
      (await gitOut(t.path, ['rev-parse', '--abbrev-ref', 'HEAD'])) === 'HEAD' &&
      (await gitOut(t.path, ['rev-parse', t.branch])) === m.own) {
    const r = await leaveStack(t, gitDir, m.own, typeof m.top === 'string' ? m.top : undefined);
    if (r.ok) {
      out(`An earlier tb land was stopped during a check with others' work; ${t.branch} is checked out again${r.carried ? '.' : ' as it was.'}`);
      if (r.carried) out(r.carried);
      fs.rmSync(detachedMarker(gitDir), { force: true });
      return undefined;
    }
    // Stop, keeping the marker, rather than land the branch without
    // commits made on the stack.
    err(`An earlier tb land was stopped during a check with others' work, and left HEAD detached at it. ${r.reason}`);
    return 1;
  }
  // Only once it no longer applies: on the branch again, or the branch
  // moved on by hand. Kept while it could still put things back.
  const on = await gitOut(t.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (on !== 'HEAD' || (await gitOut(t.path, ['rev-parse', t.branch])) !== m?.own) fs.rmSync(detachedMarker(gitDir), { force: true });
  return undefined;
}

// Another landing's check took this one with it. Its branch is moved to
// the commits as they landed (rebased on the ones ahead), unless it's
// moved on since it asked: then the next tb land rebases what's new.
async function landedByAnother(t: LandTarget, e: QueueEntry, out: (line: string) => void): Promise<number> {
  const r = e.result!;
  const head = await gitOut(t.path, ['rev-parse', 'HEAD']);
  const on = await gitOut(t.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const clean = (await gitOut(t.path, ['status', '--porcelain', '--untracked-files=all'])) === '';
  out(`Landed on ${MAIN} in ${t.mainCheckout}, in one check with ${r.together.join(', ')}:`);
  out(r.commits);
  if (head === e.commit && on === t.branch && clean && (await git(t.path, ['reset', '-q', '--keep', r.landed])).ok) return 0;
  out(`${t.branch} has moved on since, so it's left as it is; the next tb land lands only what's new.`);
  return 0;
}

// Advisory locks are released by the OS, including when tb crashes. The
// holder exits when its parent's pipe closes; no PID files to go stale or
// delete under another waiter. Keep the lock file itself between runs.
// While it waits it says where it is in the line, and again every few
// minutes.
// An OS lock on `file`, held by a small child until released or this
// process exits; undefined if `wait` is false and someone else has it, or if
// `stop` fired while it waited.
const UNIX_LOCK_HOLDER = "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); process.stdout.write('locked');";

// Windows has neither flock nor lockf. Only one process can listen on a named
// pipe (libuv sets FILE_FLAG_FIRST_PIPE_INSTANCE), and Windows frees the name
// when that process ends, so listening holds the lock as flock would, with the
// same 'locked' signal and exit 75 on contention.
const WINDOWS_LOCK_HOLDER = `const [name, wait] = process.argv.slice(1);
let server;
process.stdin.resume();
process.stdin.on('end', () => {
  if (server && server.listening) server.close(() => process.exit(0));
  else process.exit(0);
});
const take = () => {
  server = require('node:net').createServer();
  server.once('error', (e) => {
    if (e.code !== 'EADDRINUSE') { process.stderr.write(e.message); process.exit(1); }
    if (wait !== '1') process.exit(75);
    setTimeout(take, 250);
  });
  server.listen(name, () => {
    process.stdout.write('locked');
  });
};
take();`;

export function windowsLockPipe(file: string): string {
  const key = crypto.createHash('sha256').update(path.win32.resolve(file).toLowerCase()).digest('hex').slice(0, 32);
  return `\\\\.\\pipe\\threadbear-lock-${key}`;
}

export function lockHolderCommand(file: string, wait: boolean, platform: NodeJS.Platform = process.platform): { bin: string; args: string[] } {
  if (platform === 'win32') {
    return { bin: process.execPath, args: ['-e', WINDOWS_LOCK_HOLDER, windowsLockPipe(file), wait ? '1' : '0'] };
  }
  const mac = platform === 'darwin';
  // 75 is EX_TEMPFAIL for lockf, and explicitly chosen for flock. A
  // nonblocking try distinguishes contention from a slow Node startup.
  const args = mac ? ['-k', ...(wait ? [] : ['-t', '0'])] : ['-x', '-E', '75', ...(wait ? [] : ['-n'])];
  return { bin: mac ? '/usr/bin/lockf' : 'flock', args: [...args, file, process.execPath, '-e', UNIX_LOCK_HOLDER] };
}

async function holdLock(file: string, wait: boolean, stop?: AbortSignal): Promise<(() => Promise<void>) | undefined> {
  const cmd = lockHolderCommand(file, wait);
  const child = spawn(cmd.bin, cmd.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let errors = '';
  child.stderr.on('data', (d) => { errors += d; });
  const giveUp = (): void => { child.kill(); };
  stop?.addEventListener('abort', giveUp);
  const acquired = await new Promise<boolean>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if ((!wait && code === 75) || stop?.aborted) resolve(false);
      else reject(new Error(errors.trim() || `landing lock exited (${code})`));
    });
    child.stdout.once('data', () => resolve(true));
  });
  // Stopped, even just as the lock came: the child was killed, and with it
  // the lock, so this must never be taken for holding it. (No await between
  // taking the listener off and asking: after this, nothing kills the child.)
  stop?.removeEventListener('abort', giveUp);
  if (stop?.aborted) {
    child.stdin.end();
    child.kill();
    await closed;
    return undefined;
  }
  if (!acquired) return undefined;
  return async () => {
    child.stdin.end();
    await closed;
  };
}

// Undefined when `gone` says, while it waits, that there's nothing to wait
// for any more.
async function lockLanding(file: string, out: (line: string) => void, where: () => string, gone: () => boolean = () => false): Promise<(() => Promise<void>) | undefined> {
  const stop = new AbortController();
  const take = (wait: boolean) => holdLock(file, wait, wait ? stop.signal : undefined);
  const release = await take(false);
  if (release) return release;
  const say = (first: boolean) => {
    let line: string;
    try {
      line = where();
    } catch {
      line = '...';
    }
    out(`${first ? 'Waiting for another landing of this repo to finish' : 'Still waiting to land'}${line}`);
  };
  say(true);
  const timer = setInterval(() => say(false), landLimits.progressMs);
  const watch = setInterval(() => {
    let is = false;
    try {
      is = gone();
    } catch {
      // Asked again next time.
    }
    if (is) stop.abort();
  }, landLimits.goneMs);
  try {
    return await take(true);
  } finally {
    clearInterval(timer);
    clearInterval(watch);
  }
}

// A wait this long is near an agent's tool time limit (two hours for Claude
// Code's longest), which stops it and takes it out of the line, so it says so
// while there's still time to plan for it (18 Nov).
function longWait(asked: number, now = Date.now()): string {
  if (now - asked < landLimits.longWaitMs) return '';
  return ` It has waited ${Math.round((now - asked) / 60_000)} min: if what ran tb land stops it before it gets the lock (an agent's tool time limit), it leaves the line and says so, and needs running again. Once its check starts, it stays in the line whatever happens to what ran it, and lands when a check with it passes, unless its branch drops those commits first.`;
}

// How often a waiting landing says where it is, and looks for having been
// left out of its group; and the longest a failed group's landings are each
// run alone for (findBroken; otherwise about one check's time). Tests
// shorten them.
export const landLimits: { progressMs: number; goneMs: number; aloneMs?: number; aloneMinMs: number; aloneGraceMs: number; longWaitMs: number } = {
  progressMs: 3 * 60_000, goneMs: 5_000, aloneMinMs: 60_000, aloneGraceMs: 30_000, longWaitMs: 90 * 60_000,
};

// A passing check prints nothing of its own, so on 9 Nov finding out where
// landings spent their time meant scraping transcripts and running timed
// checks by hand, and a test that only passed on check.sh's second run went
// unseen. So each check leaves a line in `threadbear-land-times.log`, beside
// the landing lock (docs/thread-worktrees.md, "Where a landing's time goes").
export const LAND_TIMES_MAX_BYTES = 1024 * 1024;
export const LAND_TIMES_KEEP = 1000;

type CheckStep = { name: string; status: 'ok' | 'FAIL' | 'skip'; seconds?: number; secondRun?: string[] };

// What a check's output says about where its time went, from check.sh's and
// check-remote.sh's own lines. Another repo's check just has no steps.
export function parseCheckTimes(text: string): { host?: string; copySeconds?: number; steps: CheckStep[] } {
  const found: { host?: string; copySeconds?: number; steps: CheckStep[] } = { steps: [] };
  let last: CheckStep | undefined;
  for (const line of text.split('\n')) {
    const host = /^Checking on (\S+) \((?:copied in (\d+)s)?/.exec(line);
    if (host) {
      // A run starting on a host: any steps before it are from a host that
      // dropped out partway (check-remote.sh goes to the next), not this run's.
      found.host = host[1];
      delete found.copySeconds;
      if (host[2] !== undefined) found.copySeconds = Number(host[2]);
      found.steps = [];
      last = undefined;
      continue;
    }
    // No host could take it, so check.sh runs it here (its own words): the
    // steps that follow weren't on a host, and the updater mustn't read
    // them as if they were (update.ts, passedLandCheck).
    if (/^So the checks run on this Mac instead\b/.test(line)) {
      delete found.host;
      delete found.copySeconds;
      found.steps = [];
      last = undefined;
      continue;
    }
    const step = /^(ok|FAIL|skip)\s+(\S.*?)\s+(?:(\d+)s\b|\()(.*)$/.exec(line);
    if (step) {
      last = { name: step[2], status: step[1] as CheckStep['status'] };
      if (step[3] !== undefined) last.seconds = Number(step[3]);
      if (/passed on a second run/.test(step[4])) last.secondRun = [];
      found.steps.push(last);
      continue;
    }
    const again = /^\s+✖ (.*?)(?: \([\d.]+ms\))?$/.exec(line);
    if (again && last?.secondRun) last.secondRun.push(again[1]);
  }
  return found;
}

// Never in a landing's way: anything that goes wrong here is only a line
// missing from a log. Not following a link and not waiting on a fifo, as
// opening one would hold the landing lock for good.
function logCheckTimes(file: string, entry: Record<string, unknown>): void {
  try {
    const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    const fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o644);
    try {
      if (!fs.fstatSync(fd).isFile()) return;
      fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
      if (fs.fstatSync(fd).size <= LAND_TIMES_MAX_BYTES) return;
    } finally {
      fs.closeSync(fd);
    }
    // Only one landing at a time gets here: the landing lock is held.
    const kept = fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-LAND_TIMES_KEEP);
    fs.writeFileSync(file, `${kept.join('\n')}\n`);
  } catch {
    // See above.
  }
}

// Steps 1 and 2: the worktree's on its branch and clean, the branch is on
// main (rebased, or main merged in), there's something to land and its
// Important: lines will be read. A number is the exit code to stop with.
async function prepare(
  t: LandTarget,
  out: (line: string) => void,
  err: (line: string) => void,
  hold?: LandOptions['hold'],
  allowFormat?: string,
): Promise<number | { hasMerge: boolean; base: string; commit: string; commits: string }> {
  const fail = (...lines: string[]): number => {
    err(lines.join('\n'));
    return 1;
  };

  const head = await gitOut(t.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head === undefined) return fail(`${t.path} isn't a git checkout, so there's nothing to land.`);
  if (head !== t.branch) return fail(`The worktree at ${t.path} is on ${head}, not ${t.branch}. Check out ${t.branch} there, then run tb land again.`);
  const notReady = await mainNotReady(t.mainCheckout);
  if (notReady) return fail(notReady);

  // 1. Nothing uncommitted: it wouldn't land, and a rebase could trip on it.
  const status = await gitOut(t.path, ['status', '--porcelain', '--untracked-files=all']);
  if (status === undefined) return fail(`Couldn't read git status in ${t.path}.`);
  if (status) {
    return fail(
      `There are uncommitted changes in ${t.path}, so nothing landed:`,
      ...status.split('\n').map((l) => `  ${l}`),
      'Commit them (or remove them), then run tb land again.',
    );
  }

  // 2. Rebase on main. A conflict is undone, and the files named. A branch
  // with a merge on it (Mike's release, brought in: docs/bringing-in-updates.md)
  // is never rebased, as that flattens the merge and rewrites his commits,
  // and then the copy never looks up to date with his release again. It
  // merges main in instead, when main has moved.
  // Unreadable (git timed out) is a failure, never "no merges": that would
  // rebase a merge flat (Codex's third look, 9 Nov).
  const base = await gitOut(t.path, ['rev-parse', MAIN]);
  if (!base) return fail(`Couldn't read ${MAIN} in ${t.path}, so nothing landed. Run tb land again.`);
  const merges = await gitOut(t.path, ['rev-list', '--merges', `${base}..${t.branch}`]);
  if (merges === undefined) return fail(`Couldn't read ${t.branch}'s history in ${t.path}, so nothing landed. Run tb land again.`);
  const hasMerge = Boolean(merges);
  const behind = !(await git(t.path, ['merge-base', '--is-ancestor', base, t.branch])).ok;
  // A format commit on main the branch doesn't have yet (one listed in
  // .git-blame-ignore-revs, like the whole of desktop/ through cargo fmt)
  // conflicts with every change to the files it formatted. It's crossed with
  // each commit formatted as it was made (format-replay.ts), so only real
  // conflicts are left.
  const cross = behind ? await crossings(t.path, t.branch, base).catch((): FormatCommit[] => []) : [];
  const crossHint = cross.length
    ? ` It crosses ${cross.map((f) => `${f.commit.slice(0, 10)} (${f.entry.subject})`).join(', ')}, which only reformatted files: scripts/replay-over-format.sh${hasMerge ? ` --merge ${MAIN}` : ''} in ${t.path} does that part for you and stops only at real conflicts.`
    : '';
  const crossMerge = hasMerge && cross.length > 0 && (await touchesFormatted(t.path, `${(await gitOut(t.path, ['merge-base', base, t.branch])) ?? base}..${t.branch}`, cross).catch(() => true));
  if (hasMerge && behind && crossMerge) {
    const merged = await mergeAcross(t.path, base, { message: `Merge branch '${MAIN}' into ${t.branch}` });
    for (const n of merged.notes) out(n);
    if (!merged.ok) {
      if ('conflict' in merged) {
        return fail(
          `Bringing ${MAIN} into ${t.branch} (it has a merge on it, so it isn't rebased) ran into conflicts ${merged.step}, in:`,
          ...merged.conflict.map((f) => `  ${f}`),
          `That was undone, so ${t.branch} is as it was and ${MAIN} wasn't touched.${crossHint} Sort out those files, commit, then run tb land again.`,
        );
      }
      return fail(`Couldn't bring ${MAIN} into ${t.branch}, so nothing landed: ${merged.error}`);
    }
  } else if (hasMerge && behind) {
    const merged = await git(t.path, ['merge', '--no-edit', MAIN]);
    if (!merged.ok) {
      const conflicted = (await gitOut(t.path, ['diff', '--name-only', '--diff-filter=U'])) ?? '';
      await git(t.path, ['merge', '--abort']);
      if (conflicted) {
        return fail(
          `Merging ${MAIN} into ${t.branch} (it has a merge on it, so it isn't rebased) ran into conflicts in:`,
          ...conflicted.split('\n').map((f) => `  ${f}`),
          `The merge was undone, so ${t.branch} is as it was and ${MAIN} wasn't touched. Run git merge ${MAIN} in ${t.path}, sort out those files, commit, then run tb land again.`,
        );
      }
      return fail(`git merge ${MAIN} failed in ${t.path}, so nothing landed: ${firstLine(merged.stderr || merged.stdout)}`);
    }
  } else if (!hasMerge) {
    if (cross.length) {
      const carried = await carryFormatted(t, base, cross, out);
      if (carried) return fail(...carried);
    }
    // A tool's commit of its own (format-tool: the split of docs/protocol.md)
    // is always made again on main, even where a rebase would go through:
    // a section main added since has to go where the tool puts it.
    const tool = await remadeOwn(t, base, out, true);
    if (Array.isArray(tool)) return fail(...tool);
    const rebase = tool === 'done' ? { ok: true, stdout: '', stderr: '' } : await git(t.path, ['rebase', base]);
    if (!rebase.ok) {
      const conflicted = (await gitOut(t.path, ['diff', '--name-only', '--diff-filter=U'])) ?? '';
      await git(t.path, ['rebase', '--abort']);
      // A branch bringing in a format commit of its own (the split of
      // docs/protocol.md, say) conflicts with whatever main changed since in
      // the files it rewrote: that commit is made again on main instead, by
      // its own tool (format-replay.ts, remakeOwn).
      const remade = conflicted ? await remadeOwn(t, base, out) : undefined;
      if (Array.isArray(remade)) return fail(...remade);
      if (remade !== 'done') {
        if (conflicted) {
          return fail(
            `Rebasing ${t.branch} on ${MAIN} ran into conflicts in:`,
            ...conflicted.split('\n').map((f) => `  ${f}`),
            `The rebase was undone, so ${t.branch} is as it was and ${MAIN} wasn't touched.${crossHint || ` Run git rebase ${MAIN} in ${t.path}, sort out those files and finish the rebase.`} Then run tb land again.`,
          );
        }
        return fail(`git rebase ${MAIN} failed in ${t.path}, so nothing landed: ${firstLine(rebase.stderr || rebase.stdout)}`);
      }
    }
  }

  // Unreadable is a failure, not "nothing to land".
  const commits = await gitOut(t.path, ['log', '--oneline', '--first-parent', `${base}..${t.branch}`]);
  if (commits === undefined) return fail(`Couldn't read what ${t.branch} has to land in ${t.path}, so nothing landed. Run tb land again.`);
  if (!commits) {
    out(`Nothing to land: ${t.branch} has no commits that aren't on ${MAIN}.`);
    return 0;
  }

  // 2b. An `Important:` line git doesn't read as a trailer is refused: the
  // release collects them with git's trailer parser (upstream.ts), which
  // only looks in a message's last paragraph, so one set apart from the
  // Co-Authored-By block flags nothing and forks never hear (9 Nov: seven
  // security fixes went out that way). Merged-in commits (a fork bringing
  // in Mike's release) aren't this branch's own, so first-parent only.
  const unread = await unreadImportant(t.path, `${base}..${t.branch}`);
  if (unread === undefined) return fail(`Couldn't read ${t.branch}'s commit messages in ${t.path}, so nothing landed. Run tb land again.`);
  if (unread.length) {
    return fail(
      `These commits have an Important: line that git doesn't read as a trailer, so a release wouldn't flag them and nothing landed:`,
      ...unread.map((l) => `  ${l}`),
      'Put the Important: line in the same last paragraph as Co-Authored-By (no blank line between them), or at the end of the message if there is none. Use git commit --amend or git rebase to reword, then run tb land again.',
    );
  }
  // 2b'. A format command this landing would add to main's
  // .git-blame-ignore-revs: tb land runs main's on this Mac in later
  // landings, so it lands only once it's been shown and asked for by its id
  // (Gemini's review of finding 151, 21 Nov).
  // A config file one of them runs with (a tool's own script, the
  // toolchain file) counts the same.
  const added = await formatChanges(t.path, base, t.branch).catch(() => undefined);
  if (!added) return fail(`Couldn't read ${t.branch}'s .git-blame-ignore-revs or its format config in ${t.path}, so nothing landed. Run tb land again.`);
  if ((added.entries.length || added.configs.length) && allowFormat !== added.id) {
    const q = (s: string) => JSON.stringify(s);
    return fail(
      `${t.branch} changes what later tb lands run on this Mac to format code (.git-blame-ignore-revs), so nothing landed:`,
      ...added.entries.map((e) => `  ${e.adds ? 'format-tool' : 'format-command'} ${q(e.command)} over ${e.paths.map(q).join(' ')}${e.config.length ? `, config ${e.config.map(q).join(' ')}` : ''} (${q(e.subject)})`),
      ...added.configs.map((p) => `  config file ${q(p)} changed`),
      `If that's meant, land it with tb land --allow-format ${added.id}.`,
    );
  }
  // 2c. Held while something it would set off on GitHub is red on main.
  if (hold) {
    const held = await holdFor(t.path, base, t.branch, hold);
    if (held) return fail(held);
  }

  const commit = await gitOut(t.path, ['rev-parse', 'HEAD']);
  if (!commit) return fail(`Couldn't read HEAD in ${t.path}.`);
  return { hasMerge, base, commit, commits };
}

// A branch with a format commit of its own whose rebase conflicted, with
// that commit made again on main (format-replay.ts, remakeOwn): 'done' once
// the branch is moved there, the lines to fail with on a real conflict in
// its other commits, or undefined when it has no such commit (or it
// couldn't be remade, which leaves the rebase's conflict to say).
async function remadeOwn(t: LandTarget, main: string, out: (line: string) => void, toolsOnly = false): Promise<'done' | string[] | undefined> {
  const before = await gitOut(t.path, ['rev-parse', t.branch]);
  if (!before) return undefined;
  try {
    const r = await remakeOwn(t.path, main, before, { toolsOnly });
    if (!r) return undefined;
    if (!r.ok) {
      if ('error' in r) {
        out(r.error);
        return undefined;
      }
      // A tool the branch's own list names and main's doesn't: never run
      // here, so it's made again by hand (format-replay.ts, remakeOwn).
      if ('untrusted' in r) {
        return [
          `${t.branch} brings in a format commit made by a command that ${MAIN}'s .git-blame-ignore-revs doesn't list, so it wasn't run here and nothing landed:`,
          ...r.untrusted.map((u) => `  ${u.commit.slice(0, 10)} (${JSON.stringify(u.subject)}): ${JSON.stringify(u.command)}${u.why === 'config' ? `, with config files ${t.branch} changes` : ''}`),
          `tb land only runs a format command main already lists, exactly, with config main has. In ${t.path}: git rebase ${MAIN}, keep ${MAIN}'s side of that commit's files, run the command yourself and commit it with the same subject, then run tb land again.`,
        ];
      }
      return [
        `${t.branch} brings in a format commit, made again on ${MAIN}, but ${r.at.slice(0, 10)} (${r.subject}) conflicts with ${MAIN} in:`,
        ...r.conflict.map((f) => `  ${f}`),
        `Nothing changed, so ${t.branch} is as it was. Sort out those files (git rebase ${MAIN}, and for the format commit run its tool again rather than merge it), then run tb land again.`,
      ];
    }
    const moved = await git(t.path, ['reset', '--keep', r.tip]);
    if (!moved.ok) return [`Couldn't move ${t.branch} to its remade commits in ${t.path}, so nothing landed: ${firstLine(moved.stderr || moved.stdout)}`];
    for (const n of r.notes) out(n);
    out(`Made ${r.remade.map((c) => c.slice(0, 10)).join(', ')} again on ${MAIN} with the tool its .git-blame-ignore-revs entry names, so it's that tool's output on ${MAIN} as it is now (${t.branch} was at ${before.slice(0, 10)}).`);
    return 'done';
  } catch (e) {
    out(`Couldn't make its format commit again (${e instanceof Error ? e.message : String(e)}).`);
    return undefined;
  }
}

// The branch's commits carried across the format commits main has and it
// doesn't, each formatted as they were made, onto main (format-replay.ts).
// Only when it changes something they format; otherwise a plain rebase
// can't trip on them. Undefined when that's done (or not needed, or the
// formatter can't run here, which a plain rebase then tries), or the lines
// to fail with on a real conflict. Nothing moves unless it all went on.
async function carryFormatted(t: LandTarget, main: string, cross: FormatCommit[], out: (line: string) => void): Promise<string[] | undefined> {
  const from = await gitOut(t.path, ['merge-base', main, t.branch]);
  const tip = await gitOut(t.path, ['rev-parse', t.branch]);
  if (!from || !tip) return undefined;
  const names = cross.map((f) => `${f.commit.slice(0, 10)} (${f.entry.subject})`).join(', ');
  try {
    if (!(await touchesFormatted(t.path, `${from}..${tip}`, cross))) return undefined;
    out(`Carrying ${t.branch} across ${names}, each commit formatted as that was made...`);
    const r = await carryAcross(t.path, { base: from, tip, onto: main, formatter: new TreeFormatter(t.path, cross) });
    for (const n of r.notes) out(n);
    if (r.ok) {
      const moved = await git(t.path, ['reset', '--keep', r.tip]);
      if (!moved.ok) return [`Couldn't move ${t.branch} to its carried commits in ${t.path}, so nothing landed: ${firstLine(moved.stderr || moved.stdout)}`];
      out(`Carried ${r.count} commit${r.count === 1 ? '' : 's'} across it (${t.branch} was at ${tip.slice(0, 10)}).`);
      return undefined;
    }
    if ('conflict' in r) {
      return [
        `Carrying ${t.branch} across ${names}, with each commit formatted as that was made, ran into real conflicts at ${r.at.slice(0, 10)} (${r.subject}), in:`,
        ...r.conflict.map((f) => `  ${f}`),
        `Nothing changed, so ${t.branch} is as it was and ${MAIN} wasn't touched. Run scripts/replay-over-format.sh in ${t.path}: it does the same and stops at the conflict for you to sort out (then git rebase --continue). Then run tb land again.`,
      ];
    }
    out(`Couldn't carry it across with formatting (${r.error}), so it's rebased as it is.`);
  } catch (e) {
    out(`Couldn't carry it across with formatting (${e instanceof Error ? e.message : String(e)}), so it's rebased as it is.`);
  }
  return undefined;
}

// Why what `from...to` changes can't land now (opts.hold), or undefined.
// NUL-separated: git quotes a name with other letters in it otherwise
// ("desktop/caf\303\251.rs"), which no path filter matches.
async function holdFor(cwd: string, from: string, to: string, hold: NonNullable<LandOptions['hold']>): Promise<string | undefined> {
  const changed = await git(cwd, ['diff', '--name-only', '-z', `${from}...${to}`]);
  if (!changed.ok) return `Couldn't read what ${to} changes in ${cwd}, so nothing landed. Run tb land again.`;
  return hold(cwd, changed.stdout.split('\0').filter(Boolean));
}

// Why a group's files can't land now: what each member's commits change
// as they're stacked (replayed, so a fix that moved a file ahead of it is
// followed to where the change really lands), and this one's on top,
// except a fix's: that's the repair for what's red.
async function groupHeld(
  t: LandTarget,
  main: string,
  group: { entry: QueueEntry; tip: string }[],
  top: string,
  opts: LandOptions,
): Promise<string | undefined> {
  if (!opts.hold) return undefined;
  const ranges: [string, string][] = [];
  let prev = main;
  for (const g of group) {
    if (!g.entry.fix) ranges.push([prev, g.tip]);
    prev = g.tip;
  }
  if (!opts.despiteRed) ranges.push([prev, top]);
  const files = new Set<string>();
  for (const [from, to] of ranges) {
    const changed = await git(t.path, ['diff', '--name-only', '-z', `${from}..${to}`]);
    if (!changed.ok) return `Couldn't read what ${to} changes in ${t.path}, so nothing landed. Run tb land again.`;
    for (const f of changed.stdout.split('\0').filter(Boolean)) files.add(f);
  }
  return files.size ? opts.hold(t.path, [...files]) : undefined;
}

// `from..to`'s commits (first parent, no merges) made again on `onto`, as a
// rebase would, without touching any working tree: a three-way merge of
// each one's change (git merge-tree), then a commit with its author and
// message. A change that's already there is dropped, as rebase drops it.
// Undefined on a conflict or if git can't say.
async function replay(cwd: string, from: string, to: string, onto: string): Promise<string | undefined> {
  // As rebase picks them: `from` is on `onto`, so `onto...to`'s right side
  // is from..to, less any whose change is already on `onto` (a cherry-pick
  // of it, say), as rebase leaves those out.
  if (!(await git(cwd, ['merge-base', '--is-ancestor', from, onto])).ok) return undefined;
  // A commit made empty is never one of those, as rebase keeps it.
  const marked = await gitOut(cwd, ['rev-list', '--reverse', '--right-only', '--cherry-mark', '--no-merges', `${onto}...${to}`]);
  if (marked === undefined) return undefined;
  const list: string[] = [];
  for (const line of marked.split('\n').filter(Boolean)) {
    const c = line.slice(1);
    if (line[0] === '=' && (await gitOut(cwd, ['rev-parse', `${c}^{tree}`])) !== (await gitOut(cwd, ['rev-parse', `${c}^^{tree}`]))) continue;
    list.push(c);
  }
  return pick(cwd, list, onto);
}

// replay(), except that a branch crossing a format commit on the way (one
// it doesn't have, that changes files it changes) is carried across with
// each commit formatted as that was made (format-replay.ts), as its own tb
// land would.
// `trusted` is main: `onto` may have waiting branches stacked on it that
// haven't landed, whose lists are theirs.
async function replayFormatted(cwd: string, from: string, to: string, onto: string, trusted: string): Promise<string | undefined> {
  try {
    const cross = await crossings(cwd, to, onto, trusted);
    if (cross.length && (await touchesFormatted(cwd, `${from}..${to}`, cross))) {
      if (!(await git(cwd, ['merge-base', '--is-ancestor', from, onto])).ok) return undefined;
      const r = await carryAcross(cwd, { base: from, tip: to, onto, formatter: new TreeFormatter(cwd, cross) });
      return r.ok ? r.tip : undefined;
    }
  } catch {
    // Couldn't tell: as before there were format commits.
  }
  return replay(cwd, from, to, onto);
}

// Commits `list`, oldest first, made again on `onto` without touching any
// worktree, as rebase would; undefined if one doesn't go on cleanly.
async function pick(cwd: string, list: string[], onto: string): Promise<string | undefined> {
  let tip = onto;
  for (const c of list) {
    const merged = await git(cwd, ['merge-tree', '--write-tree', `--merge-base=${c}^`, tip, c]);
    if (!merged.ok) return undefined;
    const tree = merged.stdout.split('\n')[0].trim();
    // A commit made empty is kept, as rebase keeps it; one that only
    // becomes empty here is dropped, as rebase drops it.
    const wasEmpty = (await gitOut(cwd, ['rev-parse', `${c}^{tree}`])) === (await gitOut(cwd, ['rev-parse', `${c}^^{tree}`]));
    if (!wasEmpty && tree === (await gitOut(cwd, ['rev-parse', `${tip}^{tree}`]))) continue;
    const meta = await gitOut(cwd, ['log', '-1', '--format=%an%x00%ae%x00%ad', '--date=raw', c]);
    const message = await git(cwd, ['log', '-1', '--format=%B', c]);
    if (!meta || !message.ok) return undefined;
    const [name, email, date] = meta.split('\0');
    const made = await gitOut(cwd, ['commit-tree', tree, '-p', tip, '-m', message.stdout.replace(/\n+$/, '')], {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
    });
    if (!made) return undefined;
    tip = made;
  }
  return tip;
}

// The others waiting, stacked on `main` first come first, as far as
// `limit` allows (counting this one). One that has moved on since it asked,
// or doesn't go on cleanly, is left waiting: its own tb land sees to it.
async function stackWaiting(
  t: LandTarget,
  common: string,
  main: string,
  limit: number,
  check: string | null,
  checkFrom: string,
  withFixes = true,
  includeOthers = true,
  // After a failed group's landings were each run alone (findBroken): only
  // the ones that passed go into this landing's next check. Fixes still do.
  allowed?: Set<string>,
): Promise<{ tip: string; group: { entry: QueueEntry; tip: string; commits: string }[] }> {
  let tip = main;
  let cap = limit;
  let counted = 0;
  const group: { entry: QueueEntry; tip: string; commits: string }[] = [];
  // A fix (tb land --despite-red: the repair for a main that's red) goes
  // first and isn't counted against the limit, so the halving never leaves
  // it out. On 13 Nov a group behind a broken main was halved down three
  // checks, each failing on main's own error, while the one-line repair
  // waited behind it for a group of its own.
  // Not once main has been shown to pass what a group with it failed
  // (ordinaryAt): then it's counted and halved like any other.
  const all = waiting(common);
  const free = (e: QueueEntry): boolean => ridesFree(e, main);
  const ordered = withFixes ? [...all.filter(free), ...all.filter((e) => !free(e))] : all.filter((e) => !free(e));
  for (const e of ordered) {
    if (e.pid === process.pid && e.path === t.path) continue; // this one
    if (e.alone) continue; // its own tb checks it by itself
    const asking = await ownerWaiting(common, e);
    // A carried one has no tb to be checked by itself: halved to one, it's
    // still checked with one holder, or it waits until main moves
    // (Gemini's review).
    const own = e.limit !== undefined && e.limitAt === main ? (asking ? e.limit : Math.max(2, e.limit)) : Infinity;
    const c = free(e) ? Infinity : Math.min(cap, own);
    if (!free(e) && counted + 2 > c) continue;
    if (!free(e) && !includeOthers) continue;
    if (!free(e) && allowed && !allowed.has(e.id)) continue;
    if (e.path === t.path || e.branch === t.branch) continue;
    // One branch once: a carried landing and its next tb land's, say. Its
    // next tb land moves to what the first landed, first thing, so nothing
    // (a commit made empty on purpose) lands twice (Codex's review).
    if (group.some((g) => g.entry.branch === e.branch)) continue;
    if ((e.check ?? null) !== check || (e.checkFrom ?? '') !== checkFrom) continue;
    // A landing whose tb has gone after a check of it started is carried:
    // stacked as it asked, while its branch still has those commits.
    // Dropped once it doesn't, or once they're on main by another way (its
    // next tb land landed them).
    if (asking) {
      if ((await gitOut(e.path, ['rev-parse', 'HEAD'])) !== e.commit) continue;
      // Landed already for an earlier tb of its branch: its own tb moves
      // it there first (recoverLandedFor), and stacking it again would land
      // a commit made empty on purpose twice (Gemini's review).
      if (await landedFor(t.path, common, e.commit, main)) continue;
    } else {
      if (!isCarried(e)) continue;
      if (!(await stillAsked(t.path, e)) || (await landedOn(t.path, e, main))) {
        leaveQueue(common, e.id);
        continue;
      }
    }
    if (!(await git(t.path, ['merge-base', '--is-ancestor', e.base, main])).ok) continue;
    if ((await gitOut(t.path, ['rev-list', '--merges', `${e.base}..${e.commit}`])) !== '') continue;
    const next = await replayFormatted(t.path, e.base, e.commit, tip, main);
    if (!next || next === tip) {
      // A carried one that won't go onto main itself (a conflict, or
      // nothing left of it) never will: nobody's tb would hear, so out.
      if (!asking && tip === main) leaveQueue(common, e.id);
      continue;
    }
    // One that would change what format commands main runs lands alone,
    // through its own tb land and its --allow-format, never as a rider.
    const fmt = await formatChanges(t.path, tip, next).catch(() => undefined);
    if (!fmt || fmt.entries.length || fmt.configs.length) continue;
    const commits = await gitOut(t.path, ['log', '--oneline', '--first-parent', `${tip}..${next}`]);
    if (commits === undefined) continue;
    group.push({ entry: e, tip: next, commits });
    tip = next;
    if (!free(e)) {
      counted++;
      cap = c;
    }
  }
  return { tip, group };
}

// The `./check.sh --only` a failed check ends with: what to run again to see
// the same failure, as THREADBEAR_CHECK_ONLY takes it. Undefined for a check
// that says no such thing (another repo's, or one that died before its end).
// The output of the last run in a check's: check-remote.sh runs it again on
// another host when one drops out or runs out of disk, and what the earlier
// one said (what failed, what ran) isn't this one's.
function lastRun(text: string): string {
  const starts = [...text.matchAll(/^(?:Checking on \S+ \(|So the checks run on this Mac instead\b)/gm)];
  const at = starts.at(-1)?.index;
  return at === undefined ? text : text.slice(at);
}

export function onlyFailed(text: string): string | undefined {
  text = lastRun(text);
  const said = [...text.matchAll(/^To run only what failed again: (?:\.\/check\.sh )?--only "([A-Za-z0-9 ._/=;()-]{1,4000})"$/gm)].at(-1)?.[1];
  return said && !said.startsWith('-') ? said : undefined;
}

// The steps a run with --only says it ran (check.sh's last line for one), or
// undefined when it says no such thing.
export function onlyRan(text: string): Set<string> | undefined {
  text = lastRun(text);
  const said = [...text.matchAll(/^--only ran: "([A-Za-z0-9 ._/;()-]{0,4000})"$/gm)].at(-1)?.[1];
  return said === undefined ? undefined : new Set(said.split(';').filter(Boolean));
}

// A checkout for findBroken's runs, beside the landing lock: a clone that
// borrows the repo's objects, so it's small and has the commits tb land
// makes. Not a worktree, so nothing that lists worktrees meets it, and not a
// thread's own worktree, where its agent would see another landing's files
// come and go. Kept between landings: a check host keeps a mirror of each
// checkout that sends to it, and a new one each time would copy the lot.
async function aloneCheckout(common: string): Promise<string | undefined> {
  const dir = path.join(common, 'threadbear-land-alone');
  const top = await gitOut(dir, ['rev-parse', '--show-toplevel']);
  if (top && realpath(top) === realpath(dir)) return dir;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    return undefined;
  }
  return (await git(common, ['clone', '-q', '--shared', '--no-checkout', common, dir])).ok ? dir : undefined;
}

type Alone = 'passed' | 'failed' | 'unknown';

// A group's check failed. Before it's narrowed down by halves, each with a
// whole check of its own: what failed (the steps, and for the runner's unit
// tests the files, that the check's last line names) is run on each landing
// by itself, on main without the others. That's seconds each for a few test
// files, not the 5 to 9 minutes of a check. In the four days to 17 Nov about
// a third of branches reached the line already broken, as a thread only runs
// a file or two itself, and each took its whole group's check down with it:
// 54 failed group checks, 9 hours of the check hosts, landings waiting 35
// minutes at the median on the 16th, one broken branch at the front of a
// group of eight costing four checks before anything landed.
//
// Main goes first: nobody is blamed for what main fails by itself, nor for a
// step main didn't run (exit 0 from a check that skipped what was asked
// isn't a pass; Codex's review, 17 Nov). Only then is a landing that fails
// it alone the answer for its own tb, with that run's output; one that
// passes goes into the next check. `unknown` is a run that said nothing
// either way (no host could take it, it was stopped, the time ran out
// before its turn): never a reason to refuse. Undefined when it can't tell
// anything; the halving is still there.
async function findBroken(a: {
  t: LandTarget;
  common: string;
  main: string;
  own: string;
  group: { entry: QueueEntry }[];
  check: string;
  only: string;
  // The check host the group's check failed on, when it said one. Every run
  // here goes to that host and no other: a test that fails only on the Linux
  // box (13 Nov had one) would otherwise pass for a landing run on the Mac
  // and fail for the next one run on Linux, which would be refused for it.
  // A split check's <linux>+<mac> pair goes as it is: check-remote.sh sends
  // each step back to the host of the pair it ran on.
  host?: string;
  env: NodeJS.ProcessEnv;
  shell?: string[];
  timesFile: string;
}): Promise<{ own: Alone; ownText: string; failed: Map<string, string>; passed: Set<string>; left: number; only: string; mainFailed: string[]; brokeOnMain: boolean } | 'main fails it' | undefined> {
  const dir = await aloneCheckout(a.common);
  if (!dir) return undefined;
  const started = Date.now();
  const usual = Math.max(5 * 60_000, (typicalCheckSeconds(a.timesFile) ?? 600) * 1000);
  // The time left, which each run is held to as well: one waiting in a busy
  // host's line would otherwise keep the landing lock for as long as that
  // took. At least a minute, so the last one in gets a real try.
  const leftMs = (): number => (landLimits.aloneMs ?? usual) - (Date.now() - started);
  const run = async (branch: string, commit: string, only: string, extra: NodeJS.ProcessEnv = {}): Promise<{ state: Alone; text: string }> => {
    // main is where check.sh looks for what a checkout changes, and nothing
    // of an earlier run stays (a clone of our own: nobody keeps work here).
    if (!(await git(dir, ['checkout', '-q', '-f', '--detach', commit])).ok ||
        !(await git(dir, ['update-ref', `refs/heads/${MAIN}`, a.main])).ok ||
        !(await git(dir, ['clean', '-q', '-fdx'])).ok) return { state: 'unknown', text: '' };
    const forMs = Math.max(landLimits.aloneMinMs, leftMs());
    // check-remote.sh stops at THREADBEAR_CHECK_MAX_SECS by itself, its wait
    // in the host's line included, and tidies up there; the limit on
    // runCheck is for when that didn't happen, and for other checks.
    // Fresh (check.sh reads no pass records): these runs are to see what
    // fails now, so a file is blamed or cleared by running it.
    const r = await runCheck(a.check, dir, a.shell, {
      ...(a.host ? { THREADBEAR_CHECK_HOST: a.host } : a.env),
      THREADBEAR_CHECK_ONLY: only,
      THREADBEAR_CHECK_HOST_ONLY: '1',
      THREADBEAR_CHECK_FRESH: '1',
      THREADBEAR_CHECK_MAX_SECS: String(Math.ceil(forMs / 1000)),
      ...extra,
    }, forMs + landLimits.aloneGraceMs);
    const times = parseCheckTimes(r.text);
    // `passed`, not `ok`, and neither `check` nor `intact`: nothing that
    // reads this log for whole checks (typicalCheckSeconds, the updater's
    // passedLandCheck) can take a few test files for one.
    logCheckTimes(a.timesFile, {
      at: new Date().toISOString(),
      branch,
      commit,
      alone: true,
      only,
      passed: r.ok,
      ...(r.ok ? {} : { exit: r.code }),
      seconds: Math.round(r.durationMs / 1000),
      ...times,
    });
    // One that was stopped says nothing. Nor does one whose host isn't the
    // group's: another one, or a host named by one and not the other (the
    // group's own line can be lost off the front of a long output; with no
    // host known the runs aren't sent to one, and then none may name one).
    // Nor one no host could run (out of disk, every host unreachable).
    if (r.stopped || !sameCheckHost(times.host, a.host) || r.code === CHECK_HOSTS_UNAVAILABLE) return { state: 'unknown', text: r.text };
    // Failed means the check ran to its end and named a step that failed.
    return { state: r.ok ? 'passed' : onlyFailed(r.text) ? 'failed' : 'unknown', text: r.text };
  };

  // Main runs every step asked for, changed or not (THREADBEAR_CHECK_ALL is
  // check.sh's --all): the Swift steps never run on main with nothing
  // changed, and a skip is no pass, so on 17 Nov a broken mock test was
  // never looked for alone and four hours of group checks halved instead.
  // Only the steps main passes are run on the landings: one main fails by
  // itself says nothing about them, but needn't hide another that it passes
  // (that day the group failed the desktop core tests and the mock tests).
  const base = await run(MAIN, a.main, a.only, { THREADBEAR_CHECK_ALL: '1' });
  const ran = onlyRan(base.text);
  if (base.state === 'unknown' || !ran) return undefined;
  // A main that failed says which steps it passed in check.sh's own lines.
  const okOnMain = new Set(parseCheckTimes(base.text).steps.filter((s) => s.status === 'ok').map((s) => s.name));
  const passedOnMain = (name: string): boolean => ran.has(name) && (base.state === 'passed' || okOnMain.has(name));
  // Failed, not just skipped: what says main itself is broken, so a fix in
  // the line may be its repair (landLocked lets the fixes ride free again).
  const failOnMain = new Set(parseCheckTimes(base.text).steps.filter((s) => s.status === 'FAIL').map((s) => s.name));
  const brokeOnMain = base.state === 'failed' && a.only.split(';').some((e) => ran.has(e.split('=')[0]) && failOnMain.has(e.split('=')[0]));
  const kept = a.only.split(';').filter((e) => passedOnMain(e.split('=')[0]));
  if (!kept.length) return brokeOnMain ? 'main fails it' : undefined;
  const only = kept.join(';');
  const mainFailed = a.only.split(';').map((e) => e.split('=')[0]).filter((name) => !kept.some((k) => k.split('=')[0] === name));

  const failed = new Map<string, string>();
  const passed = new Set<string>();
  let left = 0;
  const mine = leftMs() > 0 ? await run(a.t.branch, a.own, only) : { state: 'unknown' as const, text: '' };
  for (const g of a.group) {
    if (leftMs() <= 0) {
      left++;
      continue;
    }
    const alone = await replayFormatted(a.t.path, g.entry.base, g.entry.commit, a.main, a.main);
    const r = alone && alone !== a.main ? await run(g.entry.branch, alone, only) : { state: 'unknown' as const, text: '' };
    if (r.state === 'failed') failed.set(g.entry.id, r.text);
    else if (r.state === 'passed') passed.add(g.entry.id);
    else left++;
  }
  return { own: mine.state, ownText: mine.text, failed, passed, left, only, mainFailed, brokeOnMain };
}

// The landings of a group counted against the limit, as their entries are
// now: not the fixes that ride outside it (ridesFree).
const countedIn = (common: string, main: string, group: { entry: QueueEntry }[]): number =>
  group.filter((g) => !ridesFree(readEntry(common, g.entry.id) ?? g.entry, main)).length;

// The limit a failed group check leaves on its landings: half of it,
// rounded up, the holder counted.
const halvedLimit = (common: string, main: string, group: { entry: QueueEntry }[]): number =>
  Math.max(1, Math.ceil((countedIn(common, main, group) + 1) / 2));

// A group's check failed: each of its landings may be checked with at most
// half as many from now on, on this main (it lapses once main moves). Done
// at once, so it holds whatever happens to the holder's tb next: on 18 Nov
// two holders' tbs were killed just after their groups failed, the halving
// went with them, and the next holder stacked the same mix again.
// `fixesToo` counts the fixes in and halves them with the rest
// (ordinaryAt), so it holds for them too. Returns what puts each entry
// back as it was, for a failure findBroken then explains by name, where
// halving would only slow the rest down, or one main fails by itself.
export function halveGroup(common: string, main: string, group: { entry: QueueEntry }[], fixesToo: boolean): () => void {
  const before = new Map<string, Pick<QueueEntry, 'limit' | 'limitAt' | 'ordinaryAt'>>();
  const live = group.map((g) => readEntry(common, g.entry.id)).filter((e): e is QueueEntry => !!e && !e.result);
  for (const e of live) before.set(e.id, { limit: e.limit, limitAt: e.limitAt, ordinaryAt: e.ordinaryAt });
  const counted = group.filter((g) => {
    const e = readEntry(common, g.entry.id) ?? g.entry;
    return fixesToo || !ridesFree(e, main);
  }).length;
  const limit = Math.max(1, Math.ceil((counted + 1) / 2));
  for (const e of live) {
    writeEntry(common, {
      ...e,
      limit: Math.min(e.limitAt === main ? e.limit ?? Infinity : Infinity, limit),
      limitAt: main,
      ...(fixesToo && ridesFree(e, main) ? { ordinaryAt: main } : {}),
    });
  }
  return () => {
    for (const [id, was] of before) {
      const now = readEntry(common, id);
      if (!now || now.result) continue;
      const { limit: _l, limitAt: _a, ordinaryAt: _o, ...rest } = now;
      writeEntry(common, {
        ...rest,
        ...(was.limit !== undefined ? { limit: was.limit } : {}),
        ...(was.limitAt !== undefined ? { limitAt: was.limitAt } : {}),
        ...(was.ordinaryAt !== undefined ? { ordinaryAt: was.ordinaryAt } : {}),
      });
    }
  };
}

// What an --only names, each step's files one by one ("runner unit
// tests=a.ts b.ts" is two), or the step by itself where it names none.
export const lookedFor = (only: string): string[] =>
  only.split(';').flatMap((e) => {
    const [name, files] = [e.split('=')[0], e.split('=').slice(1).join('=')];
    return files.trim() ? files.trim().split(/\s+/).map((f) => `${name}=${f}`) : [name];
  });

// Main is seen to fail by itself some of what a group failed: every fix
// waiting rides free again on it, so a repair goes into the next check.
export function freeFixes(common: string, main: string): void {
  for (const e of waiting(common)) {
    if (e.ordinaryAt !== main || e.result) continue;
    const { ordinaryAt: _o, ...rest } = e;
    writeEntry(common, rest);
  }
}

// A landing passed after a group check of it failed (landLocked): those of
// that group left out of the passing one are where the failure was. One by
// itself is set aside to be checked alone, never in anyone's group again;
// so is any fix among them (a fix rides in every group outside the limit,
// so the one way it's ever left out is that a group of only fixes and the
// holder failed). It may only fail with the holder, so it isn't refused.
// The others keep the limit the halving gave them, moved onto the main
// that's just landed: the failure was in them, not in the old main, and
// starting again from whole groups lost that. On 17 Nov a broken landing
// at the front of the line went into each holder's group in turn, the
// halving narrowed every one down to the holder alone, and each landed
// only itself: over four hours, nothing else from that line.
export function setAside(common: string, oldMain: string, newMain: string, holder: string, failed: QueueEntry[], landed: Set<string>, out: (l: string) => void): void {
  const rest = failed.map((e) => readEntry(common, e.id)).filter((e): e is QueueEntry => !!e && !e.result && !e.refused && !landed.has(e.id));
  const one = rest.length === 1;
  const aside: string[] = [];
  for (const e of rest) {
    if (one || ridesFree(e, oldMain)) {
      writeEntry(common, {
        ...e,
        alone: {
          at: Date.now(),
          why: `Checking ${e.branch} by itself: a group check with it and ${holder} failed, and ${holder}'s next check without it passed.`,
        },
      });
      aside.push(e.branch);
    } else if (e.limit !== undefined && e.limitAt === oldMain) {
      writeEntry(common, { ...e, limitAt: newMain, ...(e.ordinaryAt === oldMain ? { ordinaryAt: newMain } : {}) });
    }
  }
  if (aside.length) out(`Set aside to be checked by ${aside.length > 1 ? 'themselves' : 'itself'}, as the group failed with ${aside.length > 1 ? 'them' : 'it'} and passed without: ${aside.join(', ')}.`);
}

async function landLocked(
  t: LandTarget,
  opts: LandOptions,
  times: { file: string; waitedMs: number; entryId?: string },
  common: string,
  gitDir: string,
  startLimit: { limit: number; at?: string } | undefined,
): Promise<number> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const err = opts.err ?? ((l: string) => process.stderr.write(l + '\n'));
  const fail = (...lines: string[]): number => {
    err(lines.join('\n'));
    return 1;
  };

  // Steps 1 and 2 again: main has likely moved while this waited.
  const ready = await prepare(t, out, err, opts.despiteRed ? undefined : opts.hold, opts.allowFormat);
  if (typeof ready === 'number') return ready;
  const own = ready.commit;
  const main = ready.base;
  // A limit from a failed group check only holds while main is where it
  // was: a failure on an old main (13 Nov: its own compile error) says
  // nothing about a new one, and kept every later landing checked alone.
  let limit = startLimit && startLimit.at === main ? startLimit.limit : Infinity;
  let withFixes = true;
  // Set aside by an earlier holder (setAside): checked by itself, so a
  // landing that broke the others' groups can't break one more.
  const alone = times.entryId ? readEntry(common, times.entryId)?.alone : undefined;
  if (alone) out(alone.why);
  // Once a failed group's landings have each been run alone (findBroken):
  // the ones that passed, which are all that go into this landing's checks
  // from then on. It's done once for each step that failed; a group that
  // fails after it on the same steps is halved. The steps looked for that way. A later failure of a step not among
  // them is looked into too: halving can leave a repair out and show main's
  // own failure in another step (Codex's review, 18 Nov), and only a run on
  // main says that's what it is.
  const looked = new Set<string>();
  // Once findBroken has seen main fail some of what failed by itself: then
  // a fix may be its repair, so this holder's later halvings leave the
  // fixes riding free, as before 18 Nov.
  let mainFailsToo = false;
  let allowed: Set<string> | undefined;
  // The others in this landing's last failed group check. When a later
  // check without some of them passes, those it left out are where the
  // failure was (setAside).
  let lastFailed: QueueEntry[] | undefined;

  for (;;) {
    // 3. The others waiting go on main first, then this branch on top. The
    // check runs here, on that stack, with HEAD detached at it: the branch
    // itself only moves once it has all landed, so a tb killed partway never
    // leaves other threads' unlanded work on it.
    let checked = own;
    let group: { entry: QueueEntry; tip: string; commits: string }[] = [];
    let check: string | undefined;
    try {
      check = opts.readCheck ? await opts.readCheck() : t.check;
    } catch (e) {
      return fail(`Couldn't read the repo's patches for its check: ${(e as Error).message}`);
    }
    // One that changes what format commands main runs (its --allow-format
    // covers only its own change) is checked and landed by itself, so no
    // other landing's change rides in under that yes (Gemini's third review).
    const ownFormat = await formatChanges(t.path, main, own).catch(() => undefined);
    const formatAlone = !ownFormat || ownFormat.entries.length > 0 || ownFormat.configs.length > 0;
    if (!opts.dryRun && !ready.hasMerge && !alone && !formatAlone) {
      let stacked = await stackWaiting(t, common, main, limit, check ?? null, opts.checkFrom ?? '', withFixes, true, allowed);
      let top = stacked.group.length ? await replayFormatted(t.path, main, own, stacked.tip, main) : undefined;
      // Held on GitHub for what the others change (not a fix's, which is
      // the repair): then only the fixes go with it, and the others go by
      // themselves later, each hearing why. Still held with only the fixes
      // (this one's own change, moved by one): it goes alone.
      if (opts.hold && top && (await groupHeld(t, main, stacked.group, top, opts))) {
        stacked = await stackWaiting(t, common, main, limit, check ?? null, opts.checkFrom ?? '', withFixes, false, allowed);
        top = stacked.group.length ? await replayFormatted(t.path, main, own, stacked.tip, main) : undefined;
        if (top && (await groupHeld(t, main, stacked.group, top, opts))) top = undefined;
      }
      if (stacked.group.length) {
        if (top && top !== stacked.tip) {
          try {
            fs.writeFileSync(detachedMarker(gitDir), JSON.stringify({ branch: t.branch, own, top }));
          } catch {
            // Only recovery after a crash reads it.
          }
          if ((await git(t.path, ['checkout', '-q', '--detach', top])).ok) {
            checked = top;
            group = stacked.group;
          } else {
            fs.rmSync(detachedMarker(gitDir), { force: true });
          }
        }
      }
    }
    const together = group.map((g) => g.entry.branch);
    // Back on the branch, as it was, after a group check that didn't land.
    // Commits made on the stack meanwhile go onto the branch (leaveStack),
    // and then this run stops rather than land without them: `carried`.
    let stuck = `${t.path} is left with HEAD detached at the checked group; run git checkout ${t.branch} there.`;
    let carried = false;
    const back = async (): Promise<boolean> => {
      if (!group.length) return true;
      const r = await leaveStack(t, gitDir, own, checked);
      if (!r.ok) {
        stuck = r.reason;
        return false;
      }
      fs.rmSync(detachedMarker(gitDir), { force: true });
      if (r.carried) {
        carried = true;
        out(r.carried);
      }
      return true;
    };
    const committedMeanwhile = `Commits were made in ${t.path} while it was being checked, so nothing landed; they're on ${t.branch} now. Wait for tb land to finish before committing there, and run tb land again to land them.`;

    try {
      // The stack has the others' patches too, so read it again there.
      if (group.length) check = opts.readCheck ? await opts.readCheck() : t.check;
    } catch (e) {
      await back();
      return fail(`Couldn't read the repo's patches for its check: ${(e as Error).message}`);
    }
    // Nothing to check when this landing changes no file from main (a
    // commit with only a trailer, say): a check of main's own tree finds
    // nothing new and cost a fork 10 to 30 minutes a time (Ville, 21 Nov).
    // No line in the times log either, as the updater takes a passing one as
    // proof the tests ran on that commit.
    // `check` itself stays set: pushMain checks a merge with GitHub's main
    // by it (Gemini's review). And a git that answers neither question never
    // counts as the same tree.
    let skipCheck = false;
    if (check && !group.length && !opts.dryRun) {
      const ownTree = await gitOut(t.path, ['rev-parse', `${checked}^{tree}`]);
      const mainTree = await gitOut(t.path, ['rev-parse', `${main}^{tree}`]);
      if (ownTree && /^[0-9a-f]{40,64}$/.test(ownTree) && ownTree === mainTree) {
        out('No file changes from main, so it lands without the check.');
        skipCheck = true;
      }
    }
    // From here each of the others stays in the line if its tb goes, and
    // lands once a check with it passes (isCarried, land-queue.ts). One that
    // left the line since it was stacked (stopped: it said nothing of it
    // landed) is left out: stacked again without it (Codex's and Gemini's
    // reviews). Read again after the mark, as it may leave just then.
    if (group.length) {
      const gone = async (): Promise<string[]> => {
        const left: string[] = [];
        for (const g of group) {
          const now = readEntry(common, g.entry.id);
          if (!now || (!isCarried(now) && !(await ownerWaiting(common, now)))) left.push(g.entry.branch);
        }
        return left;
      };
      // None marked unless all are still there: a mark says a check started.
      let left = await gone();
      if (!left.length) {
        for (const g of group) {
          const now = readEntry(common, g.entry.id);
          if (now && now.inCheckAt === undefined) writeEntry(common, { ...now, inCheckAt: Date.now() });
        }
        left = await gone();
      }
      if (left.length) {
        const what = `${left.join(', ')} left the line before the check started`;
        if (!(await back())) return fail(`${what}, so nothing landed. ${stuck}`);
        if (carried) return fail(committedMeanwhile);
        out(`${what}, so the others are stacked again without ${left.length > 1 ? 'them' : 'it'}.`);
        continue;
      }
    }
    if (check && !skipCheck) {
      out(group.length
        ? `Running the check, together with ${together.join(', ')}: ${check}`
        : `Running the check: ${check}`);
      setRunning(common, {
        startedAt: Date.now(), branches: [t.branch, ...together], pid: process.pid,
        entries: [...(times.entryId ? [times.entryId] : []), ...group.map((g) => g.entry.id)],
      });
      const prefer = group.length
        ? checkPreference(opts.checkHost ?? process.env.THREADBEAR_CHECK_HOST, group.map((g) => g.entry.checkHost))
        : undefined;
      // THREADBEAR_CHECK_GROUP says it's a group's check even when nobody
      // asked for a host, so check.sh never takes the holder's own (an empty
      // one would run everyone's check on this Mac; Codex's second review).
      const groupEnv: NodeJS.ProcessEnv = group.length ? { THREADBEAR_CHECK_GROUP: '1', ...(prefer ? { THREADBEAR_CHECK_PREFER: prefer } : {}) } : {};
      const r = await runCheck(check, t.path, opts.shell, { ...groupEnv, ...(opts.full ? { THREADBEAR_CHECK_FRESH: '1' } : {}) });
      setRunning(common, undefined);
      // Whether the check ran on the commit it's logged for: asked before the
      // line is written, as the runner's updater takes a passing line as
      // proof for that commit (update.ts, landChecked), and a check of files
      // edited meanwhile proves nothing about it (Codex, 13 Nov). The same
      // questions are asked again below, where they stop the landing.
      const intact = r.ok &&
        (await gitOut(t.path, ['rev-parse', 'HEAD'])) === checked &&
        (await gitOut(t.path, ['status', '--porcelain', '--untracked-files=all'])) === '';
      logCheckTimes(times.file, {
        at: new Date().toISOString(),
        branch: t.branch,
        ...(group.length ? { together } : {}),
        commit: checked,
        ok: r.ok,
        ...(r.ok ? {} : { exit: r.code }),
        seconds: Math.round(r.durationMs / 1000),
        waitedSeconds: Math.round(times.waitedMs / 1000),
        ...(opts.dryRun ? { dryRun: true } : {}),
        ...parseCheckTimes(r.text),
        // After what the check printed, so nothing it prints can be these.
        check,
        ...(intact ? { intact: true } : {}),
      });
      // No check host could run it: one ran out of disk partway (and again
      // when tried elsewhere), or none had room or answered. That's the
      // hosts' trouble, not any landing's, so nothing is halved or looked
      // for: on 20 Nov a group failed when the cloud box ran out of disk,
      // and each landing in it was checked alone for a fault none had.
      if (!r.ok && r.code === CHECK_HOSTS_UNAVAILABLE) {
        if (!(await back())) return fail(`No check host could run the check, so nothing landed. ${stuck}`);
        if (carried) return fail(committedMeanwhile);
        return fail(
          `No check host could run the check${group.length ? ` of ${group.length + 1} landings together` : ''}, so ${MAIN} wasn't touched. That's the hosts' trouble, not ${group.length ? 'any landing in it' : 'this landing'}. The last lines of its output:`,
          '',
          ...r.text.trimEnd().split('\n').slice(-CHECK_TAIL_LINES),
          '',
          'Run tb land again: the lines above say which host and why.',
        );
      }
      if (!r.ok && group.length) {
        lastFailed = group.map((g) => g.entry);
        // The halving goes on the others' entries before anything slow
        // (findBroken, the output, putting the branch back): a holder whose
        // tb dies after this (an agent's two-hour command limit, 18 Nov)
        // otherwise took the only record of the failure with it, and the
        // next holder stacked the same mix again. Twice that day a group of
        // eight or nine failed feature pairing and nothing was narrowed.
        // Put back below when findBroken explains the failure by name.
        // Fixes too (fixesToo): see below for when they ride free again.
        let unhalve = halveGroup(common, main, group, !mainFailsToo);
        // Show the group's failure now: finding the individual landing can
        // take several more checks, and its logs are already available.
        out([
          `The check failed with ${group.length + 1} landings together${r.code !== undefined ? ` (exit ${r.code})` : ''}, so ${MAIN} wasn't touched. The last lines of its output:`,
          'Wait for tb land to finish before editing this worktree.',
          '',
          r.text.trimEnd().split('\n').slice(-CHECK_TAIL_LINES).join('\n').slice(-8000),
        ].join('\n'));
        // One of them (or two together) broke it. Halve the group and go
        // again, this one with the first half; the rest wait their turn.
        // No individual landing is refused until its own check fails.
        if (!(await back())) return fail(`The check failed with ${group.length + 1} landings together, so nothing landed. ${stuck}`);
        if (carried) return fail(committedMeanwhile);
        // Which of them broke it: first by running only what failed on each
        // alone (findBroken), when the check says what that was. Not for a
        // check read from a subfolder (it runs from the root here). With a
        // fix in the group too: what main fails by itself is never blamed
        // on anyone (findBroken runs main first), and a broken "fix" is
        // found like any other. On 17 Nov half the line had landed with
        // --despite-red, so no failed group was ever looked into alone, and
        // a broken fix at the front of it failed every group for hours.
        const said = opts.checkFrom ? undefined : onlyFailed(r.text);
        // By file where it names them (the runner's unit tests): main may
        // fail one file of a step and a pair of landings another.
        const parts = said ? lookedFor(said) : [];
        const only = parts.some((k) => !looked.has(k)) ? said : undefined;
        if (only) {
          for (const k of parts) looked.add(k);
          out('Running only what failed on each of them by itself, to find which broke it.');
          setRunning(common, {
            startedAt: Date.now(), branches: [t.branch, ...together], pid: process.pid,
            entries: [...(times.entryId ? [times.entryId] : []), ...group.map((g) => g.entry.id)],
          });
          const failedOn = parseCheckTimes(r.text).host;
          const result = await findBroken({
            t, common, main, own, group, check, only, env: groupEnv, shell: opts.shell, timesFile: times.file,
            ...(failedOn && CHECKED_ON.test(failedOn) ? { host: failedOn } : {}),
          });
          const found = typeof result === 'object' ? result : undefined;
          // Main fails some of what failed by itself: a fix may be its
          // repair, so fixes ride in every group again, outside the limit,
          // as on 13 Nov. Otherwise what failed is in the landings, fixes
          // as much as any, and they stay halved with the rest.
          if (result === 'main fails it' || found?.brokeOnMain) {
            mainFailsToo = true;
            unhalve();
            // Every fix in the line, not only this group's: an earlier
            // holder that died may have halved one this group left out.
            freeFixes(common, main);
            unhalve = halveGroup(common, main, group, false);
          }
          setRunning(common, undefined);
          const tailOf = (text: string): string => text.trimEnd().split('\n').slice(-CHECK_TAIL_LINES).join('\n').slice(-8000);
          const why = (branch: string, text: string): string => [
            `The check failed with ${group.length + 1} landings together, and what failed in it fails on ${branch} by itself too (on ${MAIN} at ${main.slice(0, 9)}, without the others), so ${MAIN} wasn't touched. The last lines of that run:`,
            '',
            tailOf(text),
            '',
            'Fix it, commit, and run tb land again.',
          ].join('\n');
          if (found?.mainFailed.length) out(`${MAIN} fails ${found.mainFailed.join(', ')} by itself too, so only ${found.only.split(';').map((e) => e.split('=')[0]).join(', ')} is run on each.`);
          if (found) {
            const leftOut: string[] = [];
            for (const g of group) {
              const text = found.failed.get(g.entry.id);
              if (text === undefined) continue;
              const now = readEntry(common, g.entry.id);
              if (!now || now.result || now.refused) continue;
              writeEntry(common, { ...now, refused: { text: why(g.entry.branch, text), at: main } });
              leftOut.push(g.entry.branch);
            }
            if (leftOut.length) out(`Left out, as what failed fails on ${leftOut.length > 1 ? 'each of them' : 'it'} alone: ${leftOut.join(', ')}.`);
            if (found.own === 'failed') {
              unhalve();
              return fail(why(t.branch, found.ownText));
            }
            // Someone was left out, or the time ran out with some not yet
            // run: the next check is this one with those known to pass.
            if (found.failed.size || (found.left && found.passed.size)) {
              unhalve();
              // Found by name, so nobody is left to check alone for it.
              if (found.failed.size) lastFailed = undefined;
              allowed = found.passed;
              out(allowed.size ? 'Checking again with the ones that passed it.' : 'Checking this one again without them.');
              continue;
            }
            if (!found.left && found.own === 'passed') out('Each of them passes it alone, so it takes more than one of them (or it fails only now and then).');
            if (!found.brokeOnMain && group.some((g) => g.entry.fix)) out(`${MAIN} passes what failed by itself, so the fixes (--despite-red) in the group are halved with the rest.`);
          }
        }
        // Fixes come along outside the limit, so once it's down to this one
        // and those, they're left out next, to see whose it is.
        if (countedIn(common, main, group) === 0) withFixes = false;
        limit = halvedLimit(common, main, group);
        out('Checking them in smaller groups to find which.');
        continue;
      }
      if (!r.ok) {
        const tail = r.text.trimEnd().split('\n').slice(-CHECK_TAIL_LINES);
        return fail(
          `The check failed${r.code !== undefined ? ` (exit ${r.code})` : ''}, so ${MAIN} wasn't touched. The last lines of its output:`,
          '',
          ...tail,
          '',
          'Fix it, commit, and run tb land again.',
        );
      }
      out(`The check passed (${Math.round(r.durationMs / 1000)} s).`);
    }

    if ((await gitOut(t.path, ['rev-parse', 'HEAD'])) !== checked ||
        (await gitOut(t.path, ['rev-parse', t.branch])) !== own ||
        (await gitOut(t.path, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== (group.length ? 'HEAD' : t.branch) ||
        (await gitOut(t.path, ['status', '--porcelain', '--untracked-files=all'])) !== '') {
      if (group.length && (await gitOut(t.path, ['rev-parse', t.branch])) === own &&
          (await gitOut(t.path, ['status', '--porcelain', '--untracked-files=all'])) === '') {
        if (!(await back())) return fail(`The branch or files in ${t.path} changed while the check ran, so nothing landed. ${stuck}`);
        if (carried) return fail(committedMeanwhile);
      }
      return fail(`The branch or files in ${t.path} changed while the check ran, so nothing landed.${group.length ? ` (The check was of ${t.branch} with ${together.join(', ')}; HEAD was detached at it, so check out ${t.branch} if it still is.)` : ''} Commit the changes and run tb land again.`);
    }

    // One whose tb went during the check (killed: on 12 Nov session
    // restarts killed waiting tb lands again and again, and checking again
    // without each one meant two passing group checks in a row landed
    // nothing) still lands, as long as its branch still has what it asked
    // to land (stillAsked): that's what it asked for. Its next tb land then
    // has nothing to land. Its branch rebased by that next tb land counts:
    // on 23 Nov that alone threw away two passing checks of six and ten
    // landings. One whose branch was rewritten without them is checked
    // again without.
    if (group.length) {
      const movedOn = [];
      for (const g of group) {
        if (await ownerWaiting(common, g.entry)) continue;
        if (!(await stillAsked(t.path, g.entry))) {
          movedOn.push(g.entry.branch);
          leaveQueue(common, g.entry.id);
        }
      }
      if (movedOn.length) {
        const what = `${movedOn.join(', ')} stopped waiting and ${movedOn.length > 1 ? 'their branches no longer have' : 'its branch no longer has'} what was checked`;
        if (!(await back())) return fail(`${what}, so nothing landed. ${stuck}`);
        if (carried) return fail(committedMeanwhile);
        out(`${what}, so it's checked again without ${movedOn.length > 1 ? 'them' : 'it'}.`);
        continue;
      }
    }

    // Asked again now the check is done: a run that was going when it
    // started may have failed since. Others in the group wait their turn.
    if (opts.hold && !opts.dryRun) {
      const held = group.length ? await groupHeld(t, main, group, checked, opts) : opts.despiteRed ? undefined : await holdFor(t.path, main, checked, opts.hold);
      if (held) {
        if (!(await back())) err(stuck);
        return fail(held);
      }
    }

    if (opts.dryRun) {
      out(`Would land on ${MAIN} in ${t.mainCheckout}:`);
      out(ready.commits);
      return 0;
    }

    // 4. Fast-forward main where it's checked out. Asked again first: the
    // check took minutes, and on 12 Nov a rebase someone started in the
    // main checkout meanwhile had HEAD detached, so the merge moved that
    // instead of main, and the rebase's end set main without it.
    const unready = await mainNotReady(t.mainCheckout);
    if (unready) {
      if (!(await back())) err(stuck);
      return fail(unready);
    }
    const before = await gitOut(t.mainCheckout, ['rev-parse', `refs/heads/${MAIN}`]);
    const merge = await git(t.mainCheckout, ['merge', '--ff-only', checked]);
    if (!merge.ok) {
      if (!(await back())) err(stuck);
      const text = merge.stderr + merge.stdout;
      const files = overwrittenFiles(text);
      if (files.length) {
        return fail(
          `The main checkout at ${t.mainCheckout} has uncommitted changes in files this would change, so nothing landed:`,
          ...files.map((f) => `  ${f}`),
          `Commit or move those changes there (someone else may be working on them), then run tb land again.`,
        );
      }
      if (/fast-forward/i.test(text)) return fail(`${MAIN} moved while this ran, so nothing landed. Run tb land again.`);
      return fail(`git merge --ff-only ${t.branch} failed in ${t.mainCheckout}, so nothing landed: ${firstLine(text)}`);
    }
    // And it's main that moved, as its reflog says, not some other HEAD.
    const after = await gitOut(t.mainCheckout, ['rev-parse', `refs/heads/${MAIN}`]);
    const logged = await gitOut(t.mainCheckout, ['reflog', '-1', '--format=%H', `refs/heads/${MAIN}`]);
    const onMain = await gitOut(t.mainCheckout, ['symbolic-ref', '-q', 'HEAD']);
    if (after !== checked || logged !== checked || onMain !== `refs/heads/${MAIN}`) {
      if (!(await back())) err(stuck);
      return fail(
        `git merge --ff-only in ${t.mainCheckout} finished, but ${MAIN} is at ${after?.slice(0, 9) ?? 'nothing git can read'} (was ${before?.slice(0, 9) ?? '?'}), not the checked ${checked.slice(0, 9)}, and HEAD there is ${onMain || 'detached'}. Nothing landed.`,
        `Something else is working in the main checkout. Look at git status and git reflog there, then run tb land again.`,
      );
    }

    // 5. What landed. The others hear from their entries; this branch moves
    // to its commits as they landed.
    let mine = ready.commits;
    if (group.length) {
      for (const g of group) {
        // Asked before its result is written, as ownerWaiting reads a
        // result as gone, and a waiting tb now moves its own branch as soon
        // as it sees one, maybe before this gets there (Gemini's review).
        const waits = g.tip !== g.entry.commit && (await ownerWaiting(common, g.entry));
        const now = readEntry(common, g.entry.id);
        if (now) writeEntry(common, { ...now, result: { landed: g.tip, commits: g.commits, together: [t.branch, ...together.filter((b) => b !== g.entry.branch)] } });
        // One whose tb has gone never hears: move its branch here, as it
        // would have, or its next tb land would land a commit made empty
        // on purpose a second time (rebase keeps those).
        // Not when it landed as it was (first in the stack, so rebased to
        // the same commits, as happens within the same second): there's
        // nothing to move, and a note from a commit to itself made its next
        // tb land say it moved the branch (red on GitHub's Linux, 13 Nov).
        // The note either way: one stopped just after this asked, or left
        // dirty while it looked, has its next tb land move it.
        if (g.tip !== g.entry.commit) {
          writeLandedFor(common, g.entry.commit, g.tip);
          if (!waits) await moveGoneBranch(g.entry, g.tip);
        }
      }
      // Through leaveStack, as a commit made since the check was looked at
      // would otherwise be checked out away.
      const moved = (await git(t.path, ['update-ref', `refs/heads/${t.branch}`, checked, own])).ok
        ? await leaveStack(t, gitDir, checked, checked)
        : undefined;
      if (moved?.ok) {
        fs.rmSync(detachedMarker(gitDir), { force: true });
        if (moved.carried) out(moved.carried);
      } else if (moved) err(`It landed, and ${t.branch} is on what landed. ${moved.reason}`);
      else err(`It landed, but ${t.branch} couldn't be moved to it in ${t.path}: HEAD is detached at what landed. Run git checkout ${t.branch} there and git reset --keep ${MAIN}.`);
      mine = (await gitOut(t.path, ['log', '--oneline', '--first-parent', `${group.at(-1)!.tip}..${checked}`])) ?? mine;
    }
    out(`Landed on ${MAIN} in ${t.mainCheckout}:`);
    out(mine);
    if (group.length) out(`In the same check, and landed with it: ${together.join(', ')}.`);
    if (lastFailed) setAside(common, main, checked, t.branch, lastFailed, new Set(group.map((g) => g.entry.id)), out);
    // Still under the lock: a fold of GitHub's main moves main here too.
    // Never a reason to fail the landing, which is done.
    if (opts.push) {
      try {
        await pushMain({ mainCheckout: t.mainCheckout, common, check, shell: opts.shell, timesFile: times.file, out });
      } catch (e) {
        out(`Landed, but ${MAIN} wasn't pushed to GitHub: ${(e as Error).message}`);
      }
    }
    return 0;
  }
}

// After a landing, main goes to GitHub (`push`, from runner.json's
// pushAfterLanding). On 17 Nov main here was 36 commits ahead of GitHub's
// and GitHub's 9 hours stale: GitHub's main had three commits of its own,
// so scripts/sync-main.sh needed the landing lock, and with landings queued
// all afternoon it waited over an hour and never got it (lockf isn't a fair
// queue). The landing's own holder has the lock already, so it does it:
//
// - GitHub's main is behind this one: push.
// - GitHub's has moved too: merge it in (a merge, never a rebase, so main
//   here only ever fast-forwards and no queued landing's base is rewritten),
//   check that merge in the land-alone checkout, fast-forward main to it and
//   push. A conflict or failed check leaves main as it landed, says why, and
//   isn't tried again for the same GitHub main for a few hours, as each try
//   is a whole check with everyone waiting behind it.
const PUSH_MEMO = 'threadbear-land-push.json';
export const pushLimits = { retryMs: 6 * 3600_000 };

async function pushMain(a: {
  mainCheckout: string;
  common: string;
  check: string | undefined;
  shell?: string[];
  timesFile: string;
  out: (line: string) => void;
}): Promise<void> {
  const { mainCheckout: mc, out } = a;
  // Nobody's there to answer a password or host key prompt.
  const quiet: NodeJS.ProcessEnv = { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' };
  const notPushed = (why: string): void => out(`${MAIN} wasn't pushed to GitHub: ${why}`);
  const fetch = async (): Promise<string | undefined> => {
    const f = await git(mc, ['fetch', '-q', 'origin', MAIN], quiet);
    if (!f.ok) {
      notPushed(`fetching GitHub's failed (${firstLine(f.stderr || f.stdout)}). The next landing tries again, or run scripts/sync-main.sh.`);
      return undefined;
    }
    return gitOut(mc, ['rev-parse', `refs/remotes/origin/${MAIN}`]);
  };
  const push = async (commit: string): Promise<boolean> => (await git(mc, ['push', '-q', 'origin', `${commit}:refs/heads/${MAIN}`], quiet)).ok;
  const count = async (range: string): Promise<string> => (await gitOut(mc, ['rev-list', '--count', range])) ?? '?';

  const here = await gitOut(mc, ['rev-parse', `refs/heads/${MAIN}`]);
  if (!here) return notPushed(`couldn't read ${MAIN} in ${mc}.`);
  let there = await fetch();
  if (!there) return;
  if (there === here) return;
  if ((await git(mc, ['merge-base', '--is-ancestor', there, here])).ok) {
    const pushed = await git(mc, ['push', '-q', 'origin', `${here}:refs/heads/${MAIN}`], quiet);
    if (pushed.ok) return out(`Pushed ${MAIN} to GitHub (${await count(`${there}..${here}`)} commits).`);
    // Refused because GitHub's moved meanwhile: then it's a fold, below.
    // Anything else (credentials, a rule on the branch) is said as it is,
    // not taken for that: a fold would only make a needless merge and run a
    // whole check with the lock held (Codex, 17 Nov).
    there = await fetch();
    if (!there) return;
    if ((await git(mc, ['merge-base', '--is-ancestor', there, here])).ok) {
      return notPushed(`GitHub refused the push: ${firstLine(pushed.stderr || pushed.stdout)}`);
    }
  }
  if ((await git(mc, ['merge-base', '--is-ancestor', here, there])).ok) {
    return notPushed(`GitHub's already has it.`);
  }

  // Both have moved.
  const memoFile = path.join(a.common, PUSH_MEMO);
  let memo: { github?: string; at?: number; why?: string } | undefined;
  try {
    memo = JSON.parse(fs.readFileSync(memoFile, 'utf8'));
  } catch {
    memo = undefined;
  }
  if (memo?.github === there && typeof memo.at === 'number' && Date.now() - memo.at < pushLimits.retryMs) {
    return notPushed(`GitHub's ${MAIN} has commits this one doesn't, and bringing them in failed at ${new Date(memo.at).toLocaleTimeString()} (${memo.why ?? 'see an earlier landing'}). It's tried again when GitHub's moves or in a few hours; scripts/sync-main.sh tries now.`);
  }
  const gave = (why: string, more = ''): void => {
    try {
      fs.writeFileSync(memoFile, JSON.stringify({ github: there, at: Date.now(), why }));
    } catch {
      // Then the next landing tries again.
    }
    notPushed(`GitHub's ${MAIN} has commits this one doesn't, and ${why}, so ${MAIN} here is as it landed.${more}`);
  };
  const theirs = (await gitOut(mc, ['log', '--oneline', '--no-decorate', `${here}..${there}`])) ?? '';
  out(`GitHub's ${MAIN} has ${theirs.split('\n').filter(Boolean).length} commits this one doesn't; merging them in and checking that before pushing.`);
  const merged = await git(mc, ['merge-tree', '--write-tree', '--name-only', here, there]);
  if (!merged.ok) {
    const files = merged.stdout.split('\n\n')[0].split('\n').slice(1).filter(Boolean);
    return gave(merged.code === 1 ? `they conflict with it in ${files.join(', ') || 'some files'}` : `git couldn't merge them (${firstLine(merged.stderr)})`,
      ' Bring them together by hand (scripts/sync-main.sh says how).');
  }
  const tree = merged.stdout.split('\n')[0].trim();
  const message = `Bring in GitHub's ${MAIN}\n\nCommits made on GitHub that this Mac's ${MAIN} didn't have:\n\n${theirs}`;
  const fold = await gitOut(mc, ['commit-tree', tree, '-p', here, '-p', there, '-m', message]);
  if (!fold) return gave(`git couldn't make the merge commit`);

  if (a.check) {
    const dir = await aloneCheckout(a.common);
    // main is where check.sh looks for what changed: GitHub's commits.
    if (!dir ||
        !(await git(dir, ['checkout', '-q', '-f', '--detach', fold])).ok ||
        !(await git(dir, ['update-ref', `refs/heads/${MAIN}`, here])).ok ||
        !(await git(dir, ['clean', '-q', '-fdx'])).ok) {
      return notPushed(`there was no checkout to check GitHub's commits in. The next landing tries again.`);
    }
    out(`Running the check on the merge: ${a.check}`);
    setRunning(a.common, { startedAt: Date.now(), branches: [`GitHub's ${MAIN}`], pid: process.pid, entries: [] });
    // To the check hosts as a group's goes, never this Mac for one person's
    // THREADBEAR_CHECK_HOST.
    // From the root, as a landing's own check runs (checkFrom is only where
    // the patch was read from).
    const r = await runCheck(a.check, dir, a.shell, { THREADBEAR_CHECK_GROUP: '1' });
    // A check that changed files or moved HEAD didn't check `fold` itself,
    // as for a landing (Codex, 17 Nov).
    const intact = (await gitOut(dir, ['rev-parse', 'HEAD'])) === fold &&
      (await gitOut(dir, ['status', '--porcelain', '--untracked-files=all'])) === '';
    setRunning(a.common, undefined);
    logCheckTimes(a.timesFile, {
      at: new Date().toISOString(),
      branch: `origin/${MAIN}`,
      fold: true,
      commit: fold,
      ok: r.ok,
      ...(r.ok ? {} : { exit: r.code }),
      seconds: Math.round(r.durationMs / 1000),
      ...parseCheckTimes(r.text),
      check: a.check,
      ...(r.ok && intact ? { intact: true } : {}),
    });
    if (r.ok && !intact) return gave(`the check changed files or HEAD in ${dir} as it ran, so it didn't check the merge itself`);
    // The hosts' trouble, not the merge's: the next landing tries again,
    // rather than the merge being put off for hours as a failed one is.
    if (r.code === CHECK_HOSTS_UNAVAILABLE) return notPushed(`no check host could run the check on the merge. The next landing tries again.`);
    if (!r.ok) {
      const tail = r.text.trimEnd().split('\n').slice(-CHECK_TAIL_LINES).join('\n').slice(-8000);
      return gave(`the check failed on the merge${r.code !== undefined ? ` (exit ${r.code})` : ''}`, ` The last lines of its output:\n\n${tail}`);
    }
    out(`The check passed on the merge (${Math.round(r.durationMs / 1000)} s).`);
  }

  // As a landing moves main: only from where it was, and only main itself.
  const unready = await mainNotReady(mc);
  if (unready) return notPushed(unready);
  if ((await gitOut(mc, ['rev-parse', `refs/heads/${MAIN}`])) !== here) return notPushed(`${MAIN} moved while GitHub's was being checked. The next landing tries again.`);
  const ff = await git(mc, ['merge', '-q', '--ff-only', fold]);
  if (!ff.ok) {
    const files = overwrittenFiles(ff.stderr + ff.stdout);
    return notPushed(files.length
      ? `the main checkout at ${mc} has uncommitted changes in files GitHub's commits change (${files.join(', ')}). The next landing tries again.`
      : `git merge --ff-only failed in ${mc}: ${firstLine(ff.stderr || ff.stdout)}`);
  }
  if ((await gitOut(mc, ['rev-parse', `refs/heads/${MAIN}`])) !== fold) return notPushed(`${MAIN} didn't end up at the merge; look at git reflog in ${mc}.`);
  if (await push(fold)) {
    fs.rmSync(memoFile, { force: true });
    return out(`Brought GitHub's commits into ${MAIN}, checked, and pushed it to GitHub.`);
  }
  notPushed(`GitHub refused the push (it may have moved again). ${MAIN} here has GitHub's commits now; the next landing pushes it.`);
}

// Why tb land can't move main in the main checkout now, or undefined: HEAD
// has to be main itself (not detached) with nothing half done there, as a
// rebase, merge or cherry-pick in progress would move a detached HEAD and
// then set main without what landed (12 Nov: a sync with GitHub, by hand,
// lost a landing that way).
export async function mainNotReady(mainCheckout: string): Promise<string | undefined> {
  const head = await gitOut(mainCheckout, ['symbolic-ref', '-q', 'HEAD']);
  const gitDirRel = await gitOut(mainCheckout, ['rev-parse', '--git-dir']);
  if (!gitDirRel) return `Git couldn't read the main checkout at ${mainCheckout}, so tb land can't move ${MAIN} there.`;
  const gitDir = path.resolve(mainCheckout, gitDirRel);
  const busy: [string, string][] = [
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['MERGE_HEAD', 'a merge'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['BISECT_LOG', 'a bisect'],
    // A cherry-pick or revert of several, stopped: it's still going after
    // a hand commit takes CHERRY_PICK_HEAD away.
    ['sequencer', 'a cherry-pick or revert'],
  ];
  const found = busy.find(([f]) => fs.existsSync(path.join(gitDir, f)));
  if (found) {
    return `The main checkout at ${mainCheckout} is in the middle of ${found[1]} (${path.join(gitDir, found[0])}), so tb land can't move ${MAIN} there and nothing landed. Someone may be syncing it with GitHub: let them finish or abort it (git status there says which), then run tb land again.`;
  }
  if (head !== `refs/heads/${MAIN}`) {
    const what = head ? head.replace(/^refs\/heads\//, '') : 'a detached HEAD';
    return `The main checkout at ${mainCheckout} is on ${what}, not ${MAIN}, so tb land can't move ${MAIN} there.`;
  }
  return undefined;
}

// The files git names when a merge would overwrite local changes (or
// untracked files) in the checkout: the tab-indented lines after the
// "would be overwritten by merge:" line.
export function overwrittenFiles(text: string): string[] {
  const files: string[] = [];
  let listing = false;
  for (const line of text.split('\n')) {
    if (/would be overwritten by merge:?$/.test(line.trim())) listing = true;
    else if (listing && /^\s+\S/.test(line)) files.push(line.trim());
    else listing = false;
  }
  return files;
}

// Runs the check through a shell, keeping the end of its output (that's
// where a test runner says what failed).
// With `limitMs` (findBroken's runs), it's stopped past that, its whole
// process group, and says so: `stopped`.
// The exit a check sent to the check hosts (scripts/check-remote.sh) ends
// with when no host could run it, rather than a failed step's: none had room,
// none could be reached, or each ran out of disk partway. EX_UNAVAILABLE, as
// the runner's self-update has it (runner/scripts/deploy-steps.mjs).
export const CHECK_HOSTS_UNAVAILABLE = 69;

function runCheck(command: string, cwd: string, shell = plainShell(), extraEnv: NodeJS.ProcessEnv = {}, limitMs?: number): Promise<{ ok: boolean; code?: number; text: string; durationMs: number; stopped?: boolean }> {
  const started = Date.now();
  // At background priority: a land's check is the full quick suite.
  const [bin, args] = inBackground(shell[0], [...shell.slice(1), command]);
  const keep = 256 * 1024;
  return new Promise((resolve) => {
    let text = '';
    const take = (b: Buffer) => {
      text += b.toString('utf8');
      if (text.length > keep * 2) text = text.slice(-keep);
    };
    // Never one left over from whatever started this tb: only a group sets it.
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    if (!extraEnv.THREADBEAR_CHECK_PREFER) delete env.THREADBEAR_CHECK_PREFER;
    if (!extraEnv.THREADBEAR_CHECK_GROUP) delete env.THREADBEAR_CHECK_GROUP;
    if (!extraEnv.THREADBEAR_CHECK_ONLY) delete env.THREADBEAR_CHECK_ONLY;
    if (!extraEnv.THREADBEAR_CHECK_FRESH) delete env.THREADBEAR_CHECK_FRESH;
    if (!extraEnv.THREADBEAR_CHECK_HOST_ONLY) delete env.THREADBEAR_CHECK_HOST_ONLY;
    env.THREADBEAR_CHECK_BUSY_EXIT = extraEnv.THREADBEAR_CHECK_BUSY_EXIT ?? String(CHECK_HOSTS_UNAVAILABLE);
    // A landing's check: every landing waits while it does, so on a check
    // host it goes ahead of agents' builds and checks waiting there, and it
    // never stays in line on a busy host while another could take it
    // (scripts/host-turn.sh, check-remote.sh). 23 Nov: 2.6 hours of them.
    env.THREADBEAR_CHECK_FIRST = '1';
    if (!extraEnv.THREADBEAR_CHECK_MAX_SECS && limitMs !== undefined) delete env.THREADBEAR_CHECK_MAX_SECS;
    // A group of its own when it has a limit, so the ssh and whatever else
    // it started go with it.
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], ...(limitMs !== undefined ? { detached: true } : {}) });
    let stopped = false;
    let timers: NodeJS.Timeout[] = [];
    let finished = false;
    // `closed`: the run's own process has just ended. Past its limit,
    // whatever is left of its group goes at that moment: the shell ending on
    // SIGTERM says nothing about a child of it that ignored it, and the timer
    // that would have killed it is cleared here. Only then, and only once:
    // later the group's id may be some other group's (Codex's reviews, 17 Nov).
    const done = (r: { ok: boolean; code?: number; text: string }, closed = false): void => {
      if (finished) return;
      finished = true;
      if (closed && stopped) signal('SIGKILL');
      for (const t of timers) clearTimeout(t);
      timers = [];
      resolve({ ...r, durationMs: Date.now() - started, ...(stopped ? { stopped: true } : {}) });
    };
    const signal = (s: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, s);
      } catch {
        // Gone already.
      }
    };
    if (limitMs !== undefined) {
      timers.push(setTimeout(() => {
        stopped = true;
        signal('SIGTERM');
        timers.push(setTimeout(() => signal('SIGKILL'), 5_000));
        // Something of it may have left the group and kept the pipes open:
        // the landing lock isn't held for that.
        timers.push(setTimeout(() => done({ ok: false, text: `${text}\nStopped: it had run for ${Math.round(limitMs / 1000)} s.` }), 15_000));
      }, limitMs));
    }
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => done({ ok: false, text: `${text}\n${e.message}` }));
    child.on('close', (code) => done({ ok: code === 0 && !stopped, code: code ?? undefined, text }, true));
  });
}

// For `tb land` outside a thread (or in a thread without one of its own):
// the folder's checkout, if it's on a thread/ branch, and where main is.
// `threadId`, when tb runs in a thread: a branch made for another thread
// (thread/<its id8>) is refused, as that's another thread's work. On 8 Nov
// a borrowed worktree turned out to be shared with a thread brought back,
// and the borrower committed on that thread's branch without noticing.
// The top of the git checkout `cwd` is in, or undefined outside one.
export function checkoutTop(cwd: string): Promise<string | undefined> {
  return gitOut(cwd, ['rev-parse', '--show-toplevel']);
}

// A worktree Claude Code made for a sub-agent (Agent's worktree isolation,
// `claude --worktree`): `<repo>/.claude/worktrees/<name>` on
// `worktree-<name>`. The thread/ rule is there so a stray tb land doesn't
// put main, or a branch someone keeps by hand, onto main; these are made
// for one helper's work and thrown away, like a thread's own.
function isClaudeWorktree(top: string, branch: string): boolean {
  return branch === `worktree-${path.basename(top)}` && path.basename(path.dirname(top)) === 'worktrees' && path.basename(path.dirname(path.dirname(top))) === '.claude';
}

export async function landTargetFromGit(cwd: string, threadId?: string): Promise<{ target?: Omit<LandTarget, 'check'>; reason?: string }> {
  const top = await checkoutTop(cwd);
  if (!top) return { reason: `${cwd} isn't in a git checkout. Run tb land in a thread's worktree.` };
  let branch = await gitOut(top, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // Detached by a tb land killed during a group check: its marker names the
  // branch, and land() puts it back.
  if (branch === 'HEAD') {
    const gitDir = await gitOut(top, ['rev-parse', '--absolute-git-dir']);
    try {
      const m = gitDir ? JSON.parse(fs.readFileSync(detachedMarker(gitDir), 'utf8')) as { branch?: unknown } : undefined;
      if (typeof m?.branch === 'string' && m.branch.startsWith('thread/') &&
          (await git(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${m.branch}`])).ok) branch = m.branch;
    } catch {
      // No marker: detached some other way.
    }
  }
  if (branch === 'HEAD') {
    // A worktree borrowed before borrow-worktree.sh made a branch, or one
    // detached by hand.
    return { reason: `${top} is detached, not on a thread/ branch. tb land runs in a thread's own worktree; to land from this one, git checkout -b thread/<name> in it first.` };
  }
  if (!branch?.startsWith('thread/') && !(branch && isClaudeWorktree(top, branch))) {
    return { reason: `${top} is on ${branch ?? 'no branch'}, not a thread/ branch. tb land runs in a thread's own worktree.` };
  }
  const owner = /^thread\/([0-9a-f]{8})$/.exec(branch)?.[1];
  if (threadId && owner && owner !== threadId.slice(0, 8)) {
    return {
      reason:
        `${top} is on ${branch}, thread ${owner}'s branch, not this thread's. Another thread is working in this folder, so don't commit or land here: ` +
        `move your own commits to a branch of your own (git branch <name> <commit>), put this one back as it was, and borrow a worktree of your own. ` +
        `To land ${branch} anyway, run THREADBEAR_THREAD_ID= tb land.`,
    };
  }
  const mainCheckout = await mainCheckoutOf(top);
  if (!mainCheckout) return { reason: `No checkout of this repo has ${MAIN} checked out, so there's nowhere to land.` };
  return { target: { path: top, branch, mainCheckout } };
}

// ------------------------------------------------------------- cleaning up

// `taken`: the folder is another checkout's now (another thread's worktree,
// a spare or a borrowed one), so it was left alone; only this thread's
// landed branch, if it was still there, went.
// `branchLeft`: the folder went but its branch couldn't be deleted. Still
// removed, as the folder can be made again for someone else (Codex, 8 Nov).
export type Cleanup = { removed: true; spare?: boolean; taken?: boolean; branchLeft?: string } | { removed: false; reason: string };

// Whether a worktree the record still has is gone: its branch has, and its
// folder either has too ('gone') or is another checkout's now ('taken', a
// reused slot). Reads only, for records that missed hearing it went.
export async function worktreeGone(w: WorktreeRecord): Promise<false | 'gone' | 'taken'> {
  const branch = await git(w.mainCheckout, ['rev-parse', '--verify', '--quiet', `refs/heads/${w.branch}`]);
  // 1 is "no such ref"; anything else (no repo there) proves nothing.
  if (branch.ok || branch.code !== 1) return false;
  if (!isDir(w.path)) return 'gone';
  const checkouts = await listCheckouts(w.mainCheckout);
  if (!checkouts) return false;
  const here = realpath(w.path);
  return checkouts.some((c) => realpath(c.path) === here && c.branch === w.branch) ? false : 'taken';
}

// Whether the folder at the worktree's path is itself the worktree git made
// there: a real folder, not a link (git's own list follows one, so a folder
// swapped for a link to the main checkout passed as the worktree, and its
// teardown ran in main: Codex's review, 9 Nov), whose own .git names the
// admin folder that names it back, of this repo (patch-trust.ts checks
// that the same way for trust).
function isWorktreeItself(w: WorktreeRecord): boolean {
  try {
    if (!fs.lstatSync(w.path).isDirectory()) return false;
  } catch {
    return false;
  }
  const real = realpath(w.path);
  // No link in its last part, however the folders above it are reached.
  if (real !== path.join(realpath(path.dirname(w.path)), path.basename(w.path))) return false;
  const main = linkedMainCheckout(real);
  return main !== undefined && realpath(main) === realpath(w.mainCheckout);
}

// The start of a small file, without waiting: undefined when it isn't a
// plain file (opening a fifo would block the runner) or is over `max`.
export function readPlainFile(file: string, max = 1024 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return undefined;
    const buf = Buffer.alloc(st.size);
    const n = st.size ? fs.readSync(fd, buf, 0, st.size, 0) : 0;
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The worktree's folder, as a real path, if right now it's the worktree git
// made there (isWorktreeItself) and its own HEAD is `head`: the thread's
// branch, or the commit a cleanup detached it at. Never any HEAD at all: a
// switch to another branch while the cleanup's status ran, then removing it
// with --force, took edits made on that branch (Codex's third look, 9 Nov). Synchronous, so it can be the last
// thing before running something there or changing it, with nothing awaited
// between: checked before an await, a swap for a link to the main checkout
// while git answered passed, and the teardown ran in main (Codex's second
// look, 9 Nov). Run there by the path this returns.
export function worktreeFolderNow(w: WorktreeRecord, head = `ref: refs/heads/${w.branch}`): string | undefined {
  if (!isWorktreeItself(w)) return undefined;
  const real = realpath(w.path);
  const dotGit = readPlainFile(path.join(real, '.git'), 8192);
  const named = dotGit?.split('\n').find((l) => l.startsWith('gitdir:'))?.slice('gitdir:'.length).trim();
  if (!named) return undefined;
  const now = readPlainFile(path.join(path.resolve(real, named), 'HEAD'), 8192);
  return now?.trim() === head ? real : undefined;
}

// Whether the worktree's folder is still a checkout of its own branch, so
// what runs there (its teardown) runs in the thread's work, not in a reused
// slot that's another thread's now, nor anywhere a link leads. Checked again
// with worktreeFolderNow just before anything runs.
export async function stillCheckedOut(w: WorktreeRecord): Promise<boolean> {
  if (!isWorktreeItself(w)) return false;
  const checkouts = await listCheckouts(w.mainCheckout);
  const here = realpath(w.path);
  return Boolean(checkouts?.some((c) => realpath(c.path) === here && c.branch === w.branch));
}

// Everything on `branch` is on main: its tip is in main's history, every
// commit on it has an equal patch on main (with no merge commits in between,
// since git cherry skips merges), or merging it into main would change no
// file. The last two are for branches whose commits landed under other ids:
// tb land rebases and batches, and a thread can cherry-pick or squash
// another's commit. `merge-tree` alone misses a rebased branch once main
// later edits the same lines (28 Nov 2026: 7 of 12 stayed for that).
export async function landedOnMain(mainCheckout: string, branch: string): Promise<boolean> {
  if ((await git(mainCheckout, ['merge-base', '--is-ancestor', branch, MAIN])).ok) return true;
  const merges = await git(mainCheckout, ['rev-list', '--merges', '--count', `${MAIN}..${branch}`]);
  if (merges.ok && merges.stdout.trim() === '0') {
    const cherry = await git(mainCheckout, ['cherry', MAIN, branch]);
    const lines = cherry.ok ? cherry.stdout.split('\n').filter(Boolean) : [];
    if (lines.length > 0 && lines.every((l) => l.startsWith('- '))) return true;
  }
  const merged = await git(mainCheckout, ['merge-tree', '--write-tree', MAIN, branch]);
  if (!merged.ok) return false; // a conflict, or git couldn't tell
  const main = await gitOut(mainCheckout, ['rev-parse', `${MAIN}^{tree}`]);
  return Boolean(main) && merged.stdout.split('\n')[0].trim() === main;
}

// When its thread is archived or deleted: a worktree whose branch is all
// on main is removed with its branch (`--force` only for untracked
// files), or, with `keep` and room for another spare, set aside as one;
// otherwise both stay, and the reason says why.
export async function cleanUpWorktree(w: WorktreeRecord, stillOurs: () => boolean = () => true): Promise<Cleanup> {
  // Checked before each change: a runner handing the thread over stops
  // waiting for a slow git after a while, and from then the folder may be
  // the new runner's to use, so nothing more is changed here.
  const LET_GO: Cleanup = { removed: false, reason: 'the thread was handed to another runner' };
  // git's own 1 is "no such ref"; anything else (it timed out, no repo
  // there) says nothing, and reading it as gone would remove or pool a
  // checkout whose branch has work on it (Codex's third look, 9 Nov).
  const ref = await git(w.mainCheckout, ['rev-parse', '--verify', '--quiet', `refs/heads/${w.branch}`]);
  if (!ref.ok && ref.code !== 1) return { removed: false, reason: `git couldn't tell whether ${w.branch} is still there` };
  let branchThere = ref.ok;
  if (branchThere && !(await landedOnMain(w.mainCheckout, w.branch))) {
    return { removed: false, reason: `${w.branch} has commits that aren't on ${MAIN}` };
  }
  // The branch goes only as it is now, and only if that's all on main: a
  // commit made since the look above stays on it (Codex's review, 21 Nov:
  // -D after one look took a commit made meanwhile). Why not, or undefined.
  const dropBranch = async (): Promise<string | undefined> => {
    const at = await gitOut(w.mainCheckout, ['rev-parse', '--verify', '--quiet', `refs/heads/${w.branch}`]);
    if (!at) return `git couldn't read it`;
    if (!(await landedOnMain(w.mainCheckout, at))) return `it has commits that aren't on ${MAIN}`;
    // Not one some checkout is on (moved there with git worktree move, say):
    // update-ref, unlike branch -D, would delete it from under it.
    const using = await listCheckouts(w.mainCheckout);
    if (!using) return `git couldn't list the worktrees of ${w.mainCheckout}`;
    if (using.some((c) => c.branch === w.branch)) return 'a checkout is on it';
    const del = await git(w.mainCheckout, ['update-ref', '-d', `refs/heads/${w.branch}`, at]);
    return del.ok ? undefined : firstLine(del.stderr);
  };
  // A record can outlive its worktree without hearing (THREADBEAR-16: a
  // handover saved it while the cleanup ran), and slot folders are reused.
  // So the folder is only touched if it's still this branch's checkout:
  // otherwise it may be another thread's, and --force would take its work.
  let ours = false;
  if (fs.existsSync(w.path)) {
    const checkouts = await listCheckouts(w.mainCheckout);
    if (!checkouts) return { removed: false, reason: `git couldn't list the worktrees of ${w.mainCheckout}` };
    const here = realpath(w.path);
    // And the folder is that checkout itself, not a link to some other
    // (the main checkout, whose status and removal would be read as this).
    ours = checkouts.some((c) => realpath(c.path) === here && c.branch === w.branch) && isWorktreeItself(w);
    if (!ours) {
      if (branchThere) {
        if (!stillOurs()) return LET_GO;
        const left = await dropBranch();
        // The folder's someone else's either way, so it counts as removed.
        if (left) return { removed: true, taken: true, branchLeft: `deleting ${w.branch} failed: ${left}` };
      }
      return { removed: true, taken: true };
    }
  }
  if (ours) {
    // Each git that reads or changes the folder itself goes by the folder
    // checked just before it (worktreeFolderNow): a swap for a link to the
    // main checkout while an earlier git ran would otherwise have main's
    // status read as this one's and main's checkout detached.
    const CHANGED: Cleanup = { removed: false, reason: `its folder ${w.path} changed while it was being cleaned up, so it was left alone` };
    let head = `ref: refs/heads/${w.branch}`;
    let here = worktreeFolderNow(w, head);
    if (!here) return CHANGED;
    const status = await gitOut(here, ['status', '--porcelain', '--untracked-files=all']);
    if (status === undefined) return { removed: false, reason: `git couldn't read ${w.path}` };
    const lines = status ? status.split('\n') : [];
    const DIRTY: Cleanup = { removed: false, reason: `the worktree has uncommitted changes` };
    if (lines.some((l) => !l.startsWith('??'))) return DIRTY;
    // Read again just before the folder is pooled or removed: an edit made
    // since the look above would go into a spare, whose next taker's
    // `reset --hard` takes it, or be removed with the folder by --force
    // (21 Nov; borrows.ts does the same). If there is one, it goes back on
    // its branch, as it was, and stays: only while the folder is still
    // that checkout at that commit and the thread still this runner's, as
    // for every other change here (Codex's review, 21 Nov).
    const editedSince = async (where: string): Promise<Cleanup | undefined> => {
      const again = await gitOut(where, ['status', '--porcelain', '--untracked-files=all']);
      if (again !== undefined && !again.split('\n').some((l) => l && !l.startsWith('??'))) return undefined;
      if (head !== `ref: refs/heads/${w.branch}`) {
        if (!stillOurs()) return LET_GO;
        const back = worktreeFolderNow(w, head);
        if (!back) return CHANGED;
        await git(back, ['checkout', '-q', '-B', w.branch]);
      }
      return again === undefined ? { removed: false, reason: `git couldn't read ${w.path}` } : DIRTY;
    };
    if (w.keep && (await spares(w.mainCheckout, path.dirname(w.path))).length < MAX_SPARES) {
      // Detached where it is (no files change), so the branch can go; its
      // untracked files go when the next thread takes it.
      if (!stillOurs()) return LET_GO;
      here = worktreeFolderNow(w);
      if (!here) return CHANGED;
      const tip = await gitOut(here, ['rev-parse', 'HEAD']);
      if (!tip) return { removed: false, reason: `git couldn't read ${w.path}` };
      // What it's set aside at must be on main too: a commit made since the
      // branch was looked at would be left on no branch (Codex's review).
      if (!(await landedOnMain(w.mainCheckout, tip))) return { removed: false, reason: `${w.branch} has commits that aren't on ${MAIN}` };
      if (!stillOurs()) return LET_GO;
      if (!(here = worktreeFolderNow(w, head))) return CHANGED;
      if ((await git(here, ['checkout', '-q', '--detach'])).ok) {
        // From here it's on that commit, detached, not on the branch.
        head = tip;
        if (!stillOurs()) return LET_GO;
        if (branchThere && !(await dropBranch())) branchThere = false;
        if (!stillOurs()) return LET_GO;
        if (!branchThere) {
          if (!(here = worktreeFolderNow(w, head))) return CHANGED;
          const edited = await editedSince(here);
          if (edited) return edited;
          // Checked again after that status: a commit or a switch made while
          // it ran would otherwise go into the pool (Codex's review, 21 Nov).
          if (!stillOurs()) return LET_GO;
          if (!worktreeFolderNow(w, head)) return CHANGED;
          if ((await git(w.mainCheckout, ['worktree', 'lock', '--reason', SPARE, w.path])).ok) return { removed: true, spare: true };
        }
      }
      // Couldn't be set aside: removed instead, below.
    }
    const args = ['worktree', 'remove', ...(lines.length ? ['--force'] : []), w.path];
    if (!stillOurs()) return LET_GO;
    // On its branch still, or detached just above (a spare that couldn't be
    // locked), and nothing else.
    if (!(here = worktreeFolderNow(w, head))) return CHANGED;
    // What's checked out there is still all on main (a commit made since
    // the first look stays, with its folder). Before the last status, so
    // nothing slow comes between that and the removal.
    const at = await gitOut(here, ['rev-parse', 'HEAD']);
    if (!at || !(await landedOnMain(w.mainCheckout, at))) return { removed: false, reason: `${w.branch} has commits that aren't on ${MAIN}` };
    if (!stillOurs()) return LET_GO;
    if (!(here = worktreeFolderNow(w, head))) return CHANGED;
    const edited = await editedSince(here);
    if (edited) return edited;
    if (!stillOurs()) return LET_GO;
    if (!worktreeFolderNow(w, head)) return CHANGED;
    const rm = await git(w.mainCheckout, args);
    if (!rm.ok) return { removed: false, reason: `git worktree remove failed: ${firstLine(rm.stderr)}` };
  } else {
    if (!stillOurs()) return LET_GO;
    await git(w.mainCheckout, ['worktree', 'prune']);
  }
  if (branchThere) {
    if (!stillOurs()) return LET_GO;
    const left = await dropBranch();
    if (left) return { removed: true, branchLeft: `deleting ${w.branch} failed: ${left}` };
  }
  // The <repo>-threads folder, once it's empty.
  try {
    fs.rmdirSync(path.dirname(w.path));
  } catch {
    // Not empty, or gone.
  }
  return { removed: true };
}

// When a worktree has to stay after its thread is archived or deleted (work
// that isn't on main, uncommitted changes), its build caches (the patch's
// `keep`) go. Nothing else can use them: no other thread takes the folder
// until its branch is landed or dropped, and only a spare's caches are
// reused. On 13 Nov 2026 such slots held 39 GB of app builds on Mike's Mac,
// and he asked for them to go once no thread can use them. A thread brought
// back just builds again. Only while the folder is still this branch's own
// checkout, and only real folders inside it, never through a link to
// somewhere else. Each is renamed aside first, right after that check with
// nothing awaited between, then deleted: deleting a gigabyte or two takes a
// while, and the check can't hold for that long. Returns what went.
export async function clearBuildCaches(w: WorktreeRecord): Promise<string[]> {
  if (!w.keep?.length || !(await stillCheckedOut(w))) return [];
  const cleared: string[] = [];
  for (const k of w.keep) {
    const rel = k.replace(/^\/+|\/+$/g, '');
    if (!rel || rel.split('/').includes('..')) continue;
    const here = worktreeFolderNow(w);
    if (!here) break;
    const dir = path.join(here, rel);
    let aside: string;
    try {
      // A real folder, reached without a link anywhere in `rel`.
      if (!fs.lstatSync(dir).isDirectory() || realpath(dir) !== dir) continue;
      aside = path.join(here, `.threadbear-clearing-${rel.replace(/\//g, '-')}-${Date.now()}`);
      fs.renameSync(dir, aside);
    } catch {
      continue;
    }
    cleared.push(rel);
    await fs.promises.rm(aside, { recursive: true, force: true }).catch(() => undefined);
  }
  return cleared;
}
