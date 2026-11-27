// Moving a thread to another runner: this runner's side of each step
// (src/moves.ts decides when; docs/protocol/moves.md, "Moving a thread to
// another runner"). Part of the Runner (runner.ts); each method's `this` is
// the Runner.
//
// The runner it leaves (S): describe, freeze, release the CLI and gather
// its files, transcript and git work, then put its copy away once the
// other runner has it. The runner it goes to (T): plan the folder and
// login, place everything in a staging folder (and its worktree and
// transcript where they belong), then after the switch move the staging
// folder in among the live threads and adopt it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runner, ThreadState, TurnHold } from '../runner.ts';
import { CARRY_ON_TOKEN } from './carry-on.ts';
import type { ImageRef } from '../protocol.ts';
import { normaliseRecord, type ThreadRecord } from '../store.ts';
import type { RunnerPart } from './part.ts';
import { providerName } from '../providers.ts';
import { paths } from '../config.ts';
import { atomicWriteFileSync, isDirectory } from '../fsutil.ts';
import { readTree, writeTree, type PackEntry } from '../move-pack.ts';
import { changedFiles, cloneRepo, cloneableUrl, originUrl, packGit, repoKey, repoTop, unpackGit, withoutCredentials, type GitMeta } from '../move-git.ts';
import { moveInfoFrom, movedSchedules, type MoveInfo, type MovePlan, type MovePreview, type MoveRow, type MovedSchedule, type ThreadMoving } from '../moves.ts';
import { projectDirName, sessionTranscriptPath } from '../transcripts.ts';
import { findWorktreePatch } from '../patches.ts';
import { isPatchFile, mainCheckoutOf as mainCheckoutFromGit, patchHash } from '../patch-trust.ts';
import { claudeCommands } from '../claude-trust.ts';
import { untrustedGit } from '../safe-git.ts';
import { isPermissionMode } from '../protocol.ts';
import { isThreadIdShape } from '../thread-id.ts';
import { fitReview, keepPictureMarkers, type MovedMedia } from '../reviews.ts';
import { cleanUpWorktree, makeWorktree, MAIN, parseCheckouts, realpath, type WorktreeRecord } from '../worktrees.ts';
import { runningSession } from '../cli-session.ts';
import { writeSlot } from '../slot.ts';

// What T placed for a move, so adopting after a restart and throwing it
// away after a failure both know (<home>/moves/<moveId>/placed.json).
// whole: placeMove got to the end, so all that's left is the claim
// (movePlaced); expect: the preview binding of the row it placed, so a later
// row can only resume the same move as it was checked.
type Placed = { whole?: true; expect?: string; cwd: string; worktree?: WorktreeRecord; patchFile?: string; patchName?: string; transcript: string[]; leftBehind: string[]; fromName: string; schedules?: unknown[]; gitTips?: string[] };

// A moved thread's old folder is kept this long on S, in case.
const KEPT_MS = 7 * 24 * 60 * 60_000;

function stageOf(home: string, moveId: string): string {
  if (!/^[0-9a-f]{8,64}$/.test(moveId)) throw new Error('bad move id');
  return path.join(home, 'moves', moveId);
}

// A path on S under its home, as the same path under this machine's, or
// undefined for one that isn't: S's paths are its word, and that runner
// may be an extra Mac, so none outside its home names a place here, and
// none that leaves this home once normalised (`..`) does either (Daybreak
// 136, 16 Nov 2026: an absolute repoTop came through as it was).
function swapHome(p: string | undefined, fromHome: string): string | undefined {
  const home = os.homedir();
  if (!p || !path.isAbsolute(p) || path.resolve(p) !== p || !path.isAbsolute(fromHome)) return undefined;
  let out: string;
  if (p === fromHome) out = home;
  else if (p.startsWith(fromHome.endsWith('/') ? fromHome : `${fromHome}/`)) out = path.join(home, p.slice(fromHome.length));
  else return undefined;
  return lexicallyInside(out, home) ? out : undefined;
}

function lexicallyInside(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Whether `p` is `root` or a folder inside it as the disk has them, links
// followed: false if either isn't there.
function inside(p: string, root: string): boolean {
  try {
    return lexicallyInside(fs.realpathSync(p), fs.realpathSync(root));
  } catch {
    return false;
  }
}

// `subdir` (moves.ts cleanSubdir, plain names) under `top`.
function under(top: string, subdir: string): string {
  return subdir ? path.join(top, ...subdir.split('/')) : top;
}

// Whether a moving thread's repo may be cloned to `to` here: a new folder
// under this home, in a plain place (plainPlace), beside a repo one of this
// runner's own threads works in (`roots`, their main checkouts' folders as
// the disk has them). Where to clone is the old runner's word, so it only
// ever picks a name among this machine's own repos, never somewhere a tool
// would load from, such as ~/.claude/skills or a node_modules (Daybreak
// 136, 16 Nov 2026; security review, 17 Nov 2026).
function cloneSpot(to: string, roots: ReadonlySet<string>): boolean {
  const home = os.homedir();
  const parent = path.dirname(to);
  if (!lexicallyInside(to, home) || parent === home || !plainPlace(to)) return false;
  try {
    fs.lstatSync(to);
    return false;
  } catch {
    // Not there: the clone makes it.
  }
  if (!isDirectory(parent) || !inside(parent, home) || !plainPlace(parent)) return false;
  return roots.has(realpath(parent));
}

// Folder names that tools look for in every folder above where they run
// (Node's node_modules, a bin on PATH, Ruby's and Go's vendor and go), so
// a clone by one of those names beside a repo would be loaded from by that
// repo's tools (security review, 16 Nov 2026). The name is the repo's own,
// from its origin, so a real one rarely is.
const LOADED_NAMES = new Set(['node_modules', 'bin', 'sbin', 'lib', 'lib64', 'libexec', 'include', 'share', 'vendor', 'site-packages', 'dist-packages', 'go', 'pkg', 'library', 'applications']);

// Where a repo that isn't here is cloned to: beside where the old runner
// has it, under the repo's own name from its origin (never the old
// runner's folder name), so this runner names the folder.
function cloneTarget(repoTop: string | undefined, fromHome: string, origin: string): string | undefined {
  const mapped = swapHome(repoTop, fromHome);
  const key = repoKey(origin);
  const name = key.slice(key.lastIndexOf('/') + 1);
  if (!mapped || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(name)) return undefined;
  return path.join(path.dirname(mapped), name);
}

// A folder where repos and work live, not where tools keep what they load:
// not the home itself, and no folder on the way to it (from the home, or
// from / outside it) hidden (~/.claude, ~/.config, ~/.ssh) or one tools
// load from (LOADED_NAMES: ~/Library, a node_modules or vendor anywhere
// above it). As written and, when it's there, as the disk has it (a plain
// name that's a link into one of those). Even beside a repo one of this
// runner's threads works in there (a skill's own repo in ~/.claude/skills,
// a checkout inside a node_modules), a clone would be loaded as one of
// them, so S's word only ever names a plain place (Daybreak 136, 16 Nov
// 2026; security review, 17 Nov 2026).
function plainPlace(p: string): boolean {
  const plain = (dir: string, home: string) => {
    if (dir === home) return false;
    const rel = lexicallyInside(dir, home) ? path.relative(home, dir) : dir;
    return rel.split(path.sep).every((part) => part === '' || (!part.startsWith('.') && !LOADED_NAMES.has(part.toLowerCase())));
  };
  const home = os.homedir();
  return plain(path.resolve(p), home) && (!fs.existsSync(p) || plain(realpath(p), realpath(home)));
}

// Whether a worktree patch found from `repo` (in `folder`) belongs to that
// repo: makeWorktree makes the worktree from the main checkout of the repo
// the patch is in, which a patch found upward from a nested checkout isn't.
async function patchMakesIn(folder: string, repo: string): Promise<boolean> {
  const top = await repoTop(folder);
  const main = top ? ((await mainCheckoutOf(top)) ?? top) : undefined;
  return main !== undefined && realpath(main) === realpath(repo);
}

// The thread's folder inside its repo (`top`), on S's word: no folder on
// the way from the repo down to it hidden (.git, .github) or one installed
// packages live in, as written and links followed (security review, 17 Nov
// 2026). A plain `lib` or `bin` in a repo is where work happens, so only
// those packages' own folders count here.
const PACKAGE_DIRS = new Set(['node_modules', 'vendor', 'site-packages', 'dist-packages']);
function plainBelow(cwd: string, top: string): boolean {
  const plain = (rel: string) => rel.split(path.sep).every((part) => part === '' || (!part.startsWith('.') && !PACKAGE_DIRS.has(part.toLowerCase())));
  return plain(path.relative(top, cwd)) && plain(path.relative(realpath(top), realpath(cwd)));
}

// Two plans for the same move say the same: the row's plan (this runner's
// answer, as the backend gives it back) and the one placing works out again.
function samePlan(a: MovePlan, b: MovePlan): boolean {
  const k = (p: MovePlan) => JSON.stringify([p.cwd, p.accountId, p.worktree?.repo ?? null, p.worktree?.subdir ?? null, p.clone?.url ?? null, p.clone?.to ?? null, p.within ?? null]);
  return k(a) === k(b);
}

// What the moved record (the old runner's word, and that runner may be an
// extra Mac) may not bring: anything that runs or approves something here.
// "Always allow" rules were answers on the other machine, for its folder;
// reply buttons (a command to run, a thread to start with its own mode, a
// message to send) and an open card's commands were made there, for
// there. They're asked or made again on this machine. True if it changed.
function dropMovedPowers(rec: Record<string, any>): boolean {
  let changed = false;
  for (const key of ['interruptedMessages', 'messageRecoveries']) {
    if (rec[key] !== undefined) {
      delete rec[key];
      changed = true;
    }
  }
  if (rec.allowRules !== undefined) {
    delete rec.allowRules;
    changed = true;
  }
  if (rec.buttons !== undefined) {
    delete rec.buttons;
    changed = true;
  }
  for (const ask of Array.isArray(rec.needs?.asks) ? rec.needs.asks : []) {
    if (ask && typeof ask === 'object' && 'run' in ask) {
      delete ask.run;
      changed = true;
    }
  }
  // A mode this runner doesn't know compares as nothing (2 > undefined is
  // false), so every check that a thread may raise access would pass:
  // Ask. A missing return mode from Plan first means Full (leavePlan), so
  // one that isn't a mode is Ask too.
  if (!isPermissionMode(rec.permissionMode)) {
    rec.permissionMode = 'ask';
    changed = true;
  }
  if (rec.modeBeforePlan !== undefined && !isPermissionMode(rec.modeBeforePlan)) {
    rec.modeBeforePlan = 'ask';
    changed = true;
  }
  return changed;
}

// The moved record's reviews (show_options) cut to what show_options takes
// here (reviews.ts fitReview): they're the other runner's word, and the
// review window draws their notes on every render, so a note of megabytes
// would stall it (Daybreak 93, 11 Nov 2026). Their files are this thread's
// copies of the ones that came with the move, and nothing else, as the
// review window reads them as this Mac's once the thread is here (Daybreak
// 159, 21 Nov 2026). One that isn't a review at all goes. True if it changed.
function fitMovedReviews(rec: Record<string, any>, media: MovedMedia): boolean {
  if (rec.reviews === undefined) return false;
  const before = JSON.stringify(rec.reviews);
  const fitted = Array.isArray(rec.reviews) ? rec.reviews.flatMap((r: unknown) => fitReview(r, media) ?? []) : [];
  if (fitted.length) rec.reviews = fitted;
  else delete rec.reviews;
  return JSON.stringify(rec.reviews) !== before;
}

// The moved log's reviews (review.updated) fitted as the record's are: the
// apps draw a review's card in the transcript from its event, pictures and
// all, and recoverReviews reads them back (Daybreak 159, 21 Nov 2026). One
// with no pictures that came becomes a note saying so, keeping the log's
// seqs gapless. Only for a log nothing has opened yet (staging). Lines that
// aren't events stay as they are.
const LEFT_OUT_REVIEW = 'A review that came with the move was left out: none of its pictures came with it.';
type LoggedEvent = { type?: unknown; seq?: unknown; ts?: unknown; review?: unknown };
// A log line's event, or null for one that isn't JSON. Too long to read is thrown.
function parsedLine(raw: Buffer): LoggedEvent | null {
  if (!raw.length) return null;
  const text = raw.toString('utf8');
  try {
    return JSON.parse(text) as LoggedEvent | null;
  } catch {
    return null;
  }
}

function fitMovedLog(file: string, media: MovedMedia): void {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  // Line by line from the bytes, as EventLog reads it: the whole log as one
  // string fails past V8's string limit (half a gigabyte), which a bundle
  // can unpack to (Gemini's second review). A line too long to read throws,
  // and the move fails, rather than going unfitted. Only changed lines are
  // kept as pieces, the rest copied as runs of the log, so a log of a
  // hundred million empty lines costs no more (Codex's third review).
  const out: Buffer[] = [];
  let copied = 0;
  let changed = false;
  for (let start = 0; start < buf.length; ) {
    let end = buf.indexOf(0x0a, start);
    if (end < 0) end = buf.length;
    if (end > start) {
      // Every line parsed: a type written with JSON escapes (review\u002eupdated)
      // reads the same to every later reader (Codex's and Gemini's reviews).
      const raw = buf.subarray(start, end);
      const ev = parsedLine(raw);
      if (ev && typeof ev === 'object' && ev.type === 'review.updated') {
        const review = fitReview(ev.review, media);
        const next = review ? { ...ev, review } : { seq: ev.seq, ts: ev.ts, type: 'system.note', text: LEFT_OUT_REVIEW };
        const line = Buffer.from(JSON.stringify(next), 'utf8');
        if (!line.equals(raw)) {
          changed = true;
          out.push(buf.subarray(copied, start), line);
          copied = end;
        }
      }
    }
    start = end + 1;
  }
  if (!changed) return;
  // Into place whole: it may be the live log (Codex's second review).
  const tmp = `${file}.fitting-${process.pid}`;
  out.push(buf.subarray(copied));
  fs.writeFileSync(tmp, Buffer.concat(out), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// A queued answer to a review names its reply's pictures as the other
// runner's files, which here could be any file: they don't come with the
// move, as fitReview leaves them out of the reviews (Codex's review, 17
// Nov 2026). Done here, before anything on this runner reads the record,
// so no later step that fails can leave them in a queue that's sent.
function dropMovedReplyImages(rec: Record<string, any>): boolean {
  if (!Array.isArray(rec.queue)) return false;
  let changed = false;
  rec.queue = rec.queue.map((q: any) => {
    if (!q || typeof q !== 'object' || q.reviewId === undefined) return q;
    const hasResponseImages = q.reviewResponse && typeof q.reviewResponse === 'object' && 'images' in q.reviewResponse;
    // A mark's cut-out is one of the reply's pictures too.
    const markImages = q.reviewResponse && typeof q.reviewResponse === 'object' && Array.isArray(q.reviewResponse.marks) && q.reviewResponse.marks.some((m: unknown) => Boolean(m && typeof m === 'object' && 'image' in m));
    if (Array.isArray(q.images) && q.images.length === 0 && !hasResponseImages && !markImages) return q;
    changed = true;
    // The words say where they were (keepPictureMarkers).
    const gone = (list: unknown) => (Array.isArray(list) ? list : []).map(() => false);
    const next = { ...q, images: [], ...(typeof q.text === 'string' ? { text: keepPictureMarkers(q.text, gone(q.images)) } : {}) };
    if (hasResponseImages) {
      const { images, ...rest } = q.reviewResponse;
      next.reviewResponse = typeof rest.reply === 'string' ? { ...rest, reply: keepPictureMarkers(rest.reply, gone(images)) } : rest;
    }
    if (markImages) {
      const response = next.reviewResponse ?? q.reviewResponse;
      next.reviewResponse = { ...response, marks: response.marks.map((m: unknown) => {
        if (!m || typeof m !== 'object') return m;
        const { image: _, ...rest } = m as Record<string, unknown>;
        return rest;
      }) };
    }
    return next;
  });
  return changed;
}

// A moved thread's queued messages' pictures name the other runner's media
// folder, which can be at another path (another user, Linux): each that came
// with the move (a real file, not a link, in `now`, the record's media folder
// as it is) is this thread's copy here, in `final`, by its name. Anything else
// is left out when it's sent (ownInput), as it was never this thread's
// (Codex's review, 17 Nov). True if it changed any.
function rebaseQueuedPictures(rec: Record<string, any>, threadId: string, now: string, final: string): boolean {
  if (!Array.isArray(rec.queue)) return false;
  let changed = false;
  for (const q of rec.queue) {
    if (!q || typeof q !== 'object' || !Array.isArray(q.images)) continue;
    q.images = q.images.map((img: ImageRef) => {
      if (!img || typeof img !== 'object' || typeof img.path !== 'string') return img;
      const from = img.path.replace(/\\/g, '/').split('/');
      // .../<thread id>/media/<name>, as any runner keeps them.
      if (from.length < 3 || from.at(-2) !== 'media' || from.at(-3) !== threadId) return img;
      const name = from.at(-1)!;
      const here = path.join(final, name);
      if (!/^[^/\\]+$/.test(name) || name === '.' || name === '..' || here === img.path) return img;
      try {
        const st = fs.lstatSync(path.join(now, name));
        if (!st.isFile() || st.isSymbolicLink()) return img;
      } catch {
        return img;
      }
      changed = true;
      return { ...img, path: here };
    });
  }
  return changed;
}

// On the main Mac, a thread from another runner arrives with at most Ask
// (Mike, 10 Nov 2026): its mode is that runner's word, an extra Mac may be
// compromised, and the main Mac's sidebar never showed what mode the
// thread had there, so a thread that looked careful could arrive running
// anything. Full and Auto become Ask (Plan first ranks with Ask and
// stays), and so does the mode Plan first would go back to. Says what it
// was, for the thread's note, or undefined when nothing changed.
const ABOVE_ASK = new Set(['full', 'auto']);
function capMovedMode(rec: Record<string, any>): { was?: string; changed: boolean } {
  let was: string | undefined;
  let changed = false;
  if (rec.permissionMode !== 'ask' && rec.permissionMode !== 'plan') {
    if (ABOVE_ASK.has(rec.permissionMode)) was = rec.permissionMode;
    rec.permissionMode = 'ask';
    changed = true;
  }
  if (rec.permissionMode === 'plan') {
    // Approving the plan goes back to this, and to Full when it's missing
    // (leavePlan), so it's always set.
    if (rec.modeBeforePlan !== 'ask') {
      if (ABOVE_ASK.has(rec.modeBeforePlan)) was ??= rec.modeBeforePlan;
      rec.modeBeforePlan = 'ask';
      changed = true;
    }
  } else if (rec.modeBeforePlan !== undefined) {
    delete rec.modeBeforePlan;
    changed = true;
  }
  return { ...(was ? { was } : {}), changed };
}

// What its queue, held reports and waits may still reach (runner/ceiling.ts)
// is that runner's word too: at most Ask here, as its mode is, so raising
// the thread later shows them to Mike rather than its agent. True if any
// changed.
export function capMovedCeilings(rec: Record<string, unknown>): boolean {
  let changed = false;
  const items = (k: string): Record<string, unknown>[] => (Array.isArray(rec[k]) ? (rec[k] as unknown[]) : []).filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
  for (const q of items('queue')) {
    if (q.ceiling !== 'ask') {
      q.ceiling = 'ask';
      changed = true;
    }
  }
  // Who a held report is from is that runner's word too: a thread here it
  // names doesn't vouch for it (mayPassOn), so it goes by Ask alone.
  for (const h of items('heldReports')) {
    if (h.ceiling !== 'ask' || (typeof h.from === 'string' && !h.from.startsWith('moved:'))) {
      h.ceiling = 'ask';
      if (typeof h.from === 'string' && !h.from.startsWith('moved:')) h.from = `moved:${h.from}`;
      changed = true;
    }
  }
  // A wait's reply is filled in here, when the thread it waits on finishes:
  // one that came with the record is that runner's words.
  for (const w of items('waitingOn')) {
    if (w.by !== undefined && (w.by as { mode?: unknown } | null)?.mode !== 'ask') {
      w.by = { mode: 'ask' };
      changed = true;
    }
    if (w.done !== undefined) {
      delete w.done;
      changed = true;
    }
  }
  // An agent's snooze in words wakes it with them later (runner/ceiling.ts).
  const ww = rec.wakeWhen as { said?: unknown; by?: unknown } | undefined;
  const wc = rec.wakeCeiling as { said?: unknown; ceiling?: unknown } | undefined;
  if (ww && typeof ww === 'object' && typeof ww.said === 'string' && (wc?.said !== ww.said || wc?.ceiling !== 'ask')) {
    rec.wakeCeiling = { said: ww.said, ceiling: 'ask' };
    changed = true;
  } else if (wc !== undefined && !(ww && typeof ww === 'object')) {
    delete rec.wakeCeiling;
    changed = true;
  }
  return changed;
}

const MODE_WORDS: Record<string, string> = { full: 'Full access', auto: 'Auto' };
function cappedNote(was: string, from: string): string {
  return `It had ${MODE_WORDS[was] ?? was} on ${from}, so it asks before tools run here: give it more access again if you want.`;
}

// What a moved record may keep here, applied to the record wherever it is
// (staging, the live folder, or loaded already): dropMovedPowers, and on
// the main Mac capMovedMode. The note's line about the mode goes in
// `notes`; `media` is where the thread's media folder is now and will be.
// True if it changed.
function sanitizeMoved(rec: Record<string, any>, atMostAsk: boolean, from: string, notes: string[], media: MovedMedia): boolean {
  // Lists and objects the runner walks at every start in the shape it
  // expects, press notes well formed and bounded (store.ts normaliseRecord).
  let changed = normaliseRecord(rec);
  changed = dropMovedPowers(rec) || changed;
  changed = fitMovedReviews(rec, media) || changed;
  changed = dropMovedReplyImages(rec) || changed;
  if (atMostAsk) {
    changed = capMovedCeilings(rec) || changed;
    const capped = capMovedMode(rec);
    if (capped.was && !notes.some((n) => n.includes('so it asks before tools run here'))) notes.push(cappedNote(capped.was, from));
    changed ||= capped.changed;
  }
  return changed;
}

// Whether the worktree's setup would run something the moved git work
// changed: the patch's own copy, or a file it reaches, differs in the
// worktree from the commit it was made from (this runner's own main), or
// can't be followed. Threadbear's own checkout is always trusted, so for
// its worktrees nothing else would stop the old runner's version of the
// setup script running here (Codex's review, 10 Nov 2026). Says why, or
// undefined when setup can run.
export async function setupChangedByMove(w: WorktreeRecord, patchFile: string): Promise<string | undefined> {
  // placeMove keeps the absolute path (makeWorktree's patchFile); the
  // record's own is relative to the worktree.
  const copy = path.isAbsolute(patchFile) ? patchFile : path.join(w.path, patchFile);
  let reached: string[];
  try {
    const h = patchHash(copy);
    if (h.incomplete) return `what it runs can't all be followed (${h.incomplete})`;
    reached = [copy, ...h.deps.map((d) => (path.isAbsolute(d.path) ? d.path : path.resolve(path.dirname(copy), d.path))), ...h.unnamed.map((u) => (path.isAbsolute(u) ? u : path.resolve(path.dirname(copy), u)))];
  } catch (e) {
    return `its patch couldn't be read (${e instanceof Error ? e.message : String(e)})`;
  }
  const root = realpath(w.path);
  for (const file of new Set(reached)) {
    const real = realpath(file);
    const rel = path.relative(root, real);
    // Outside the worktree: the move didn't bring it.
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const there = await untrustedGit(w.path, ['cat-file', '-e', `${w.base}:${rel.split(path.sep).join('/')}`]);
    const exists = fs.existsSync(real);
    if (!there.ok) {
      if (exists) return `the moved work adds ${rel}, which it runs`;
      continue;
    }
    if (!exists) return `the moved work removes ${rel}, which it runs`;
    const same = await untrustedGit(w.path, ['diff', '--quiet', '--no-ext-diff', '--no-textconv', w.base, '--', rel.split(path.sep).join('/')]);
    if (!same.ok) return `the moved work changes ${rel}, which it runs`;
  }
  return undefined;
}

// Whether the moved git work changed anything patch or Claude settings
// trust covers in the worktree, from the commit T made it from: a file
// under any .threadbear or .claude folder, a .mcp.json, or a file a patch
// there or the Claude settings reach. Threadbear's own checkout is always
// trusted, and its worktrees with it, so without this the old runner's
// patches would load and its Claude hooks run here (Codex's review, 10 Nov
// 2026). True when it did, or when it can't tell.
// `tips`: the move's own commits (its head, and the commit of its
// uncommitted work), whose trees say exactly what it brought, ignore rules
// or not (a file this machine ignores is still written, untracked). Without
// them (one placed by a runner from before), the worktree as it is, every
// untracked file included.
export async function trustTouchedByMove(w: WorktreeRecord, home: string, tips?: readonly string[], cwd?: string): Promise<boolean> {
  const lists: { ok: boolean; stdout: string }[] = [];
  if (tips?.length) {
    for (const tip of tips) lists.push(await untrustedGit(w.path, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', w.base, tip]));
  } else {
    lists.push(await untrustedGit(w.path, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', w.base]));
    lists.push(await untrustedGit(w.path, ['ls-files', '-z', '--others']));
  }
  if (lists.some((l) => !l.ok)) return true;
  const changed = [...new Set(lists.flatMap((l) => l.stdout.split('\0')).filter(Boolean))];
  if (!changed.length) return false;
  // Without case: on the Mac .CLAUDE is .claude, and a name from a
  // case-sensitive machine can be either.
  // node_modules too: a committed package is code a patch may import.
  if (changed.some((f) => f.toLowerCase().split('/').some((part) => part === '.threadbear' || part === '.claude' || part === 'node_modules') || path.posix.basename(f).toLowerCase() === '.mcp.json')) return true;
  const touchedLower = new Set(changed.map((f) => path.join(realpath(w.path), ...f.split('/')).toLowerCase()));
  const root = realpath(w.path);
  // A changed symlink can point an unchanged patch's import at another
  // file, which the reached paths name rather than the link: any changed
  // link counts (Codex's review).
  for (const f of changed) {
    try {
      if (fs.lstatSync(path.join(w.path, ...f.split('/'))).isSymbolicLink()) return true;
    } catch {
      // Gone: a removal, compared below.
    }
  }
  const touched = new Set(changed.map((f) => path.join(root, ...f.split('/'))));
  const hit = (file: string) => {
    const real = realpath(path.isAbsolute(file) ? file : path.join(root, file));
    return touched.has(real) || touchedLower.has(real.toLowerCase());
  };
  // What the patches already there reach (a patch file itself changing
  // was caught above).
  const patches = await untrustedGit(w.path, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)**/.threadbear/patches/*']);
  if (!patches.ok) return true;
  for (const rel of patches.stdout.split('\0').filter(Boolean)) {
    const file = path.join(root, ...rel.split('/'));
    if (!isPatchFile(file)) continue;
    try {
      const h = patchHash(file);
      if (h.incomplete) return true;
      const near = (p: string) => (path.isAbsolute(p) ? p : path.resolve(path.dirname(file), p));
      if ([...h.deps.map((d) => d.path), ...h.unnamed, ...h.code.keys()].some((p) => hit(near(p)))) return true;
    } catch {
      return true;
    }
  }
  // What runs, and what lets tools run unasked (a permissions allow).
  // From the worktree's top and from the folder Claude starts in (a thread
  // in a subfolder), as Claude reads the settings above where it starts.
  for (const dir of new Set([w.path, ...(cwd ? [cwd] : [])])) {
    for (const grants of [false, true]) {
      const claude = claudeCommands(dir, home, { grants });
      if (claude && (claude.incomplete || [...claude.files, ...claude.named].some(hit))) return true;
    }
  }
  return false;
}

// Every untracked file under a node_modules folder in `dir`, removed (not
// followed: git lists a linked node_modules as the link, and leaves it).
export async function dropUntrackedPackages(dir: string): Promise<void> {
  const listed = await untrustedGit(dir, ['ls-files', '-z', '--others', '--', ':(glob)**/node_modules/**']);
  for (const rel of listed.ok ? listed.stdout.split('\0').filter(Boolean) : []) fs.rmSync(path.join(dir, ...rel.split('/')), { force: true });
}

type ThreadRecordLike = Pick<ThreadRecord, 'id' | 'worktree'>;

// The checkout with main checked out, for a repo a thread is in or the
// other runner named: through safe-git like every other git here, as the
// folder is anyone's (Muse's review, 11 Nov 2026).
async function mainCheckoutOf(top: string): Promise<string | undefined> {
  const r = await untrustedGit(top, ['worktree', 'list', '--porcelain']);
  return r.ok ? parseCheckouts(r.stdout.trim()).find((c) => c.branch === MAIN)?.path : undefined;
}

const UNVOUCHED_NOTE = "Its worktree's work changes this repo's patches or Claude Code settings, so they wait for you to trust them in Patches here.";

// The words adoptMoved has put on every thread it took in since moves
// began (8 Nov 2026), as JSON has them in its event log.
const MOVED_IN = Buffer.from('"text":"Moved from ');

// Whether the thread's event log says another runner moved it here. Read
// in pieces, as a log can be large. A log that's there but can't be read
// counts as moved: unknown is held.
export function eventsSayMovedIn(threadDir: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(path.join(threadDir, 'events.ndjson'), 'r');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  try {
    const chunk = Buffer.alloc(1 << 20);
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) return false;
      const buf = Buffer.concat([carry, chunk.subarray(0, n)]);
      if (buf.includes(MOVED_IN)) return true;
      carry = buf.subarray(Math.max(0, buf.length - MOVED_IN.length + 1));
    }
  } catch {
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

// The worktrees a thread's log says it was moved into, from each
// "Moved from <name> to <name>, in <folder>." note adoptMoved wrote. The
// note isn't parsed for its folder, as a name (the other runner's own) or
// a folder can hold ", in /" or ". " too: every "/..." after a ", in "
// up to each "." is taken, up to the top of its checkout, when that's a
// linked worktree (its .git a file). Only a
// worktree: the log came from the other runner, which could name any
// folder, and holding a checkout itself would take its trust away. Read
// in pieces, as a log can be large.
const MAX_NOTE = 64 * 1024;
const MAX_ANCHORS = 16;
const MAX_DOTS = 64;
const MAX_PATH = 1024;
export function movedInWorktrees(threadDir: string): string[] {
  const out = new Set<string>();
  const tops = new Map<string, 'worktree' | 'checkout' | 'none'>();
  const take = (line: string) => {
    let ev: { type?: unknown; text?: unknown };
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type !== 'system.note' || typeof ev.text !== 'string' || !ev.text.startsWith('Moved from ')) return;
    const text = ev.text.slice(0, MAX_NOTE);
    let anchors = 0;
    for (let at = text.indexOf(', in /'); at >= 0 && anchors++ < MAX_ANCHORS; at = text.indexOf(', in /', at + 1)) {
      const from = at + ', in '.length;
      // A path is at most PATH_MAX long, so no "." further on can end one.
      let dots = 0;
      for (let dot = text.indexOf('.', from); dot >= 0 && dot - from <= MAX_PATH && dots++ < MAX_DOTS; dot = text.indexOf('.', dot + 1)) {
        // Up from there to the first folder with a .git (a subfolder may
        // be gone since, and a candidate with words after the path ends
        // in its folder), each folder looked at once.
        for (let d = text.slice(from, dot); path.dirname(d) !== d; d = path.dirname(d)) {
          let found = tops.get(d);
          if (found === undefined) {
            try {
              found = fs.lstatSync(path.join(d, '.git')).isFile() ? 'worktree' : 'checkout';
            } catch {
              found = 'none';
            }
            tops.set(d, found);
          }
          if (found === 'none') continue;
          if (found === 'worktree') out.add(d);
          break;
        }
      }
    }
  };
  // The start of a line too long to read whole: its note's text as far as
  // it goes, from the JSON string's own start.
  const takeStart = (head: string) => {
    const at = head.indexOf('"text":"Moved from ');
    if (at < 0 || !head.slice(0, at).includes('"type":"system.note"')) return;
    let raw = head.slice(at + '"text":'.length);
    const end = /[^\\](?:\\\\)*"/.exec(raw.slice(1));
    if (end) raw = raw.slice(0, end.index + end[0].length + 1);
    else raw = raw.replace(/\\+$/, (b) => (b.length % 2 ? b.slice(1) : b)).replace(/\\u[0-9a-fA-F]{0,3}$/, '') + '"';
    try {
      take(JSON.stringify({ type: 'system.note', text: JSON.parse(raw) }));
    } catch {
      // Not readable as far as it goes.
    }
  };
  let fd: number;
  try {
    fd = fs.openSync(path.join(threadDir, 'events.ndjson'), 'r');
  } catch {
    return [];
  }
  try {
    // Split as bytes, so a character across two pieces stays whole.
    const chunk = Buffer.alloc(1 << 20);
    let rest = Buffer.alloc(0);
    let skipping = false;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      let buf = n > 0 ? Buffer.concat([rest, chunk.subarray(0, n)]) : rest;
      for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a)) {
        const line = buf.subarray(0, nl);
        if (!skipping && line.includes(MOVED_IN)) take(line.toString('utf8'));
        skipping = false;
        buf = buf.subarray(nl + 1);
      }
      if (n <= 0) {
        if (!skipping && buf.includes(MOVED_IN)) take(buf.toString('utf8'));
        break;
      }
      // A line longer than a note needs is read from its start (where the
      // folder is: the rest is what was left behind) and passed over to its
      // end, rather than copied again with each piece.
      if (!skipping && buf.length > MAX_NOTE * 4) {
        takeStart(buf.subarray(0, MAX_NOTE * 4).toString('utf8'));
        skipping = true;
        buf = Buffer.alloc(0);
      } else if (skipping) buf = Buffer.alloc(0);
      rest = Buffer.from(buf);
    }
  } catch {
    // What was read is what's held.
  } finally {
    fs.closeSync(fd);
  }
  return [...out];
}

export const movesPart = {
  // At start, before anything loads a patch or starts a CLI: the worktrees
  // the always-trust doesn't reach, worked out again from the threads when
  // patch-trust-unvouched.json can't be relied on (missing, unreadable, or
  // from before it was complete; PatchTrust.unvouchedKnown). The list moved
  // twice on 10 Nov 2026 without bringing its old forms, so an upgrade
  // trusted again what a move had held (security review, 11 Nov 2026,
  // findings 90 and 91). What's held: a worktree its record marks (this
  // runner's movedIn, an older one's `unvouched`), and one whose thread's
  // log says it was moved here, as a move finished before any mark can't
  // say whether its work changed what trust covers. A clean move is held
  // too, then: trusting its patches in Patches lets them run.
  // `broken`: threads whose record can't be read, about to be rebuilt
  // without their worktree: the worktree their log's note names is held,
  // if it's one (movedInWorktrees).
  settleUnvouched(this: Runner, records: ThreadRecordLike[], broken: string[] = []): void {
    this.unvouchedSettled = true;
    const trust = this.patchTrust;
    if (!trust.unvouchedKnown || !trust.settleUnvouched || trust.unvouchedKnown()) return;
    const live = new Set<string>();
    for (const rec of records) {
      const w = rec.worktree;
      if (w && typeof w.path === 'string' && !w.removedAt && !w.movedIn && w.unvouched !== true) live.add(realpath(w.path));
    }
    const held: string[] = [];
    for (const rec of records) {
      const w = rec.worktree;
      if (!w || typeof w.path !== 'string') continue;
      // A folder set aside and since given to a thread of this runner's
      // own is that thread's: made afresh from main.
      if (w.removedAt && live.has(realpath(w.path))) continue;
      if (w.removedAt && !fs.existsSync(w.path)) continue;
      if (w.movedIn === true || w.unvouched === true || eventsSayMovedIn(this.store.threadDir(rec.id))) held.push(w.path);
    }
    for (const id of broken) held.push(...movedInWorktrees(this.store.threadDir(id)));
    trust.settleUnvouched(held);
    this.log.info('worked out which worktrees patch trust holds', { held: held.length });
  },

  // ThreadSummary.moving, and while it's set no turn starts: messages wait
  // in the queue, which moves with the thread. Cleared, the queue goes on.
  setMoving(this: Runner, threadId: string, moving: ThreadMoving | undefined): void {
    const st = this.threads.get(threadId);
    if (!st) return;
    const was = st.rt.moving;
    st.rt.moving = moving;
    if (JSON.stringify(was) !== JSON.stringify(moving)) this.markDirty(st);
    if (!moving && was) this.kickQueue(st);
  },

  // Nothing would be cut short by packing it now. Background shells are
  // stopped (and said); sub-agents finish first.
  moveIdle(this: Runner, threadId: string): boolean {
    const st = this.threads.get(threadId);
    if (!st) return false;
    const { rt } = st;
    if (rt.turn || rt.approvals.size || rt.wakeTimer || rt.hooksRunning || rt.runningActions?.size || rt.editing || rt.cleaning || rt.preparing) return false;
    return !rt.tasks.some((t) => t.kind === 'agent') && !st.rec.subagents?.some((a) => a.status === 'running');
  },

  async describeForMove(this: Runner, threadId: string, schedules: number): Promise<MoveInfo | undefined> {
    if (this.coordinators?.forThread(threadId) || this.coordinators?.helperOwner(threadId)) throw new Error('Project coordinators stay on their owning runner in this experiment.');
    const st = this.threads.get(threadId);
    if (!st) return undefined;
    const { rec } = st;
    const account = this.accounts.list().find((a) => a.id === rec.accountId);
    const own = Boolean(rec.worktree && !rec.worktree.removedAt);
    const top = await repoTop(rec.cwd);
    // Which repo, never a password or token in its address (move-git.ts).
    const raw = top ? await originUrl(top) : undefined;
    // An address that can't be told from a login is left out ('').
    const origin = (raw ? withoutCredentials(raw) : '') || undefined;
    // As the disk has both: git gives the top with links followed, and a
    // folder reached through a link would otherwise come out as `../..`.
    const rel = top ? path.relative(realpath(top), realpath(rec.cwd)) : '';
    return {
      title: rec.title,
      cwd: rec.cwd,
      home: os.homedir(),
      provider: rec.provider,
      accountId: rec.accountId,
      ...(account?.email ? { email: account.email } : {}),
      ...(rec.model ? { model: rec.model } : {}),
      ...(rec.effort ? { effort: rec.effort } : {}),
      permissionMode: rec.permissionMode,
      ...(origin ? { origin } : {}),
      ...(top ? { repoTop: own ? rec.worktree!.mainCheckout : ((await mainCheckoutOf(top)) ?? top), subdir: rel.split(path.sep).join('/') } : {}),
      worktree: own,
      ...(rec.sessionUsed && rec.nativeSessionId ? { sessionId: rec.nativeSessionId } : {}),
      schedules,
    };
  },

  // What packForMove will leave behind, in words for before the move. Move
  // to goes straight away unless there's something here to say first.
  async leftBehindByMove(this: Runner, threadId: string): Promise<string[]> {
    const st = this.threads.get(threadId);
    if (!st) return [];
    const { rec, rt } = st;
    const out: string[] = [];
    const shells = rt.tasks.filter((t) => t.kind !== 'agent').length;
    if (shells) out.push(`${shells} background ${shells === 1 ? 'job, which gets' : 'jobs, which get'} stopped`);
    if (!rec.worktree || rec.worktree.removedAt) {
      const top = await repoTop(rec.cwd);
      const files = top ? await changedFiles(top) : [];
      if (files.length) out.push(`uncommitted changes in ${top}, as other threads share that checkout: ${files.join(', ')}`);
    }
    return out;
  },

  // Releases the CLI and gathers what goes: the thread's folder, its
  // Claude transcript, and its worktree's git work.
  async packForMove(this: Runner, threadId: string, row: MoveRow): Promise<{ entries: PackEntry[]; leftBehind: string[] }> {
    if (this.coordinators?.forThread(threadId) || this.coordinators?.helperOwner(threadId)) throw new Error('Project coordinators stay on their owning runner in this experiment.');
    const st = this.threads.get(threadId);
    if (!st) throw new Error("The thread isn't here any more.");
    const { rec, rt } = st;
    const leftBehind: string[] = [];
    const shells = rt.tasks.filter((t) => t.kind !== 'agent').length;
    if (shells) leftBehind.push(`${shells} background ${shells === 1 ? 'job was' : 'jobs were'} stopped, as they can't move.`);
    this.flushDeltas(st);
    if (runningSession(rt)) {
      this.rememberStoppedWork(st);
      this.releaseSession(st);
    }
    if (rt.closing) await rt.closing;
    this.store.save(rec);
    const entries = readTree(paths.thread(this.cfg.home, rec.id), 'thread', ['panels']);
    const account = this.accounts.list().find((a) => a.id === rec.accountId);
    if (rec.provider === 'claude' && rec.sessionUsed && rec.nativeSessionId && account) {
      const file = sessionTranscriptPath(account.configDir, rec.cwd, rec.nativeSessionId);
      if (file) {
        entries.push({ path: `transcript/${rec.nativeSessionId}.jsonl`, data: fs.readFileSync(file) });
        entries.push(...readTree(path.join(path.dirname(file), rec.nativeSessionId), `transcript/${rec.nativeSessionId}`));
      }
    }
    if (rec.worktree && !rec.worktree.removedAt) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-move-'));
      try {
        const git = await packGit(rec.worktree.path, rec.cwd, path.join(scratch, 'move.bundle'));
        if (!git.ok) throw new Error(git.reason);
        entries.push({ path: 'git/meta.json', data: Buffer.from(JSON.stringify(git.meta)) });
        if (git.bundle) entries.push({ path: 'git/move.bundle', data: fs.readFileSync(git.bundle) });
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    } else {
      const top = await repoTop(rec.cwd);
      const files = top ? await changedFiles(top) : [];
      if (files.length) leftBehind.push(`Uncommitted changes in ${top} stayed on ${this.moveRunnerName(row.from)}, as other threads share that checkout: ${files.join(', ')}.`);
    }
    return { entries, leftBehind };
  },

  // After the move: the thread is the other runner's. Its folder goes to
  // <home>/moved/ for a week, and clients see it go (their list of other
  // runners' threads brings it back as that runner's).
  async putAwayMoved(this: Runner, threadId: string): Promise<void> {
    const st = this.threads.get(threadId);
    if (st) await this.letGo(st);
    const dir = paths.thread(this.cfg.home, threadId);
    const moved = path.join(this.cfg.home, 'moved');
    fs.mkdirSync(moved, { recursive: true });
    if (fs.existsSync(dir)) fs.renameSync(dir, path.join(moved, `${threadId}-${Date.now()}`));
    for (const name of fs.readdirSync(moved)) {
      const at = Number(/-(\d+)$/.exec(name)?.[1]);
      if (at && at < Date.now() - KEPT_MS) fs.rmSync(path.join(moved, name), { recursive: true, force: true });
    }
    this.notify({ method: 'thread.deleted', params: { threadId } });
    this.log.info('moved a thread away', { threadId });
  },

  // T: where the thread will run here, and on which login, or why it can't.
  // Everything in `row.info` is the old runner's word (moves.ts
  // moveInfoFrom), so this runner picks the place: a repo of its own, a
  // clone beside one (cloneSpot), or the same folder under its home, with
  // the thread's folder inside it. placeMove plans again and checks the
  // folder as made before the thread takes it (Daybreak 136, 16 Nov 2026).
  async planMove(this: Runner, row: MoveRow): Promise<MovePlan | { problem: string }> {
    const here = this.moveRunnerName(row.to);
    const info = moveInfoFrom(row.info);
    if (!info) return { problem: `The thread's runner didn't describe it properly, so ${here} can't take it.` };
    const accounts = this.accounts.list();
    let account = row.accountId ? accounts.find((a) => a.id === row.accountId) : undefined;
    if (row.accountId && !account) return { problem: `${here} has no login ${row.accountId}.` };
    account ??=
      accounts.find((a) => a.provider === info.provider && a.email && info.email && a.email.toLowerCase() === info.email.toLowerCase()) ??
      accounts.find((a) => a.id === this.defaultAccountId() && a.provider === info.provider) ??
      accounts.find((a) => a.provider === info.provider);
    if (!account) return { problem: `${here} has no ${providerName(info.provider)} login.` };
    const leftBehind: string[] = [];
    const subdir = info.subdir ?? '';
    const home = os.homedir();
    // The folders this runner's own repos are in: where a clone may go.
    const roots = new Set<string>();
    // Those repos' own main checkouts, links followed: found from S's path,
    // a repo outside this home is the thread's only if it's one of these.
    const known = new Set<string>();

    // A repo: the same one here, by its origin.
    const findRepo = async (): Promise<string | undefined> => {
      if (!info.origin) return undefined;
      const want = repoKey(info.origin);
      const mine = new Set<string>();
      for (const t of this.threads.values()) mine.add(t.rec.worktree?.mainCheckout ?? t.rec.cwd);
      const tops = new Set<string>();
      // S's own path for it, here, only where repos live (plainPlace):
      // otherwise any repo under a hidden folder, whose origin S can name,
      // would become the thread's.
      const theirs = swapHome(info.repoTop, info.home);
      if (theirs && plainPlace(theirs) && (!fs.existsSync(theirs) || inside(theirs, home))) tops.add(theirs);
      for (const c of mine) tops.add(c);
      // This runner's own repos first, all of them, so a match found from
      // S's path is weighed against the whole set.
      for (const c of mine) {
        if (!isDirectory(c)) continue;
        const top = await repoTop(c);
        if (!top) continue;
        const main = realpath(mainCheckoutFromGit(top) ?? top);
        roots.add(realpath(path.dirname(main)));
        known.add(main);
      }
      for (const c of tops) {
        if (!isDirectory(c)) continue;
        const top = await repoTop(c);
        if (!top) continue;
        const origin = await originUrl(top);
        if (origin && repoKey(origin) === want) return (await mainCheckoutOf(top)) ?? top;
      }
      return undefined;
    };

    if (row.cwd) {
      // Mike's pick on the main Mac (startMove takes it only from its key).
      if (!isDirectory(row.cwd)) return { problem: `There's no folder ${row.cwd} on ${here}.` };
      const top = await repoTop(row.cwd);
      const origin = top ? await originUrl(top) : undefined;
      if (info.worktree && top && origin && info.origin && repoKey(origin) === repoKey(info.origin)) {
        const repo = (await mainCheckoutOf(top)) ?? top;
        return { cwd: repo, accountId: account.id, worktree: { repo, subdir }, within: repo, leftBehind };
      }
      if (info.worktree) leftBehind.push(`Its worktree's git work stays behind, as ${row.cwd} isn't a copy of ${info.origin ?? 'its repo'}.`);
      return { cwd: row.cwd, accountId: account.id, within: row.cwd, leftBehind };
    }
    if (info.origin) {
      let repo = await findRepo();
      let cloneTo: { url: string; to: string } | undefined;
      if (!repo) {
        // Both are the old runner's word: a clone only from an address git
        // can't read as an option, into a new folder this runner would
        // pick (cloneSpot).
        const to = cloneTarget(info.repoTop, info.home, info.origin);
        if (to && cloneableUrl(info.origin) && cloneSpot(to, roots)) {
          cloneTo = { url: info.origin, to };
          repo = to;
        }
      }
      if (!repo) return { problem: `${here} has no copy of ${info.origin}. Pick a folder to move it into.` };
      // One of this runner's own threads' repos can be anywhere, the home
      // itself too (a dotfiles repo, whose Library/LaunchAgents would be a
      // subdir): on S's word the thread only goes into one in a plain place.
      if (!cloneTo && (!plainPlace(repo) || !(inside(repo, home) || known.has(realpath(repo))))) return { problem: `${here}'s copy of ${info.origin} is ${repo}, the home folder or a hidden or tools' folder, so the thread only goes there if you pick it.` };
      // A worktree is made with a worktree patch, which for a fresh clone
      // could be a trusted one in a folder above it, running its setup in
      // the old runner's checkout: clone it there first, by hand.
      if (info.worktree && cloneTo) return { problem: `${here} has no copy of ${info.origin} to make the thread's worktree in. Clone it there yourself, then move it again.` };
      if (info.worktree) return { cwd: repo, accountId: account.id, worktree: { repo, subdir }, within: repo, leftBehind, ...(cloneTo ? { clone: cloneTo } : {}) };
      const cwd = under(repo, subdir);
      if (cloneTo) return { cwd, accountId: account.id, within: repo, leftBehind, clone: cloneTo };
      if (!isDirectory(cwd)) return { problem: `There's no folder ${cwd} on ${here}.` };
      if (!inside(cwd, repo)) return { problem: `${cwd} on ${here} leads out of ${repo}, so the thread can't go there. Pick a folder to move it into.` };
      if (!plainBelow(cwd, repo)) return { cwd: repo, accountId: account.id, within: repo, leftBehind: [...leftBehind, `Its folder ${cwd} is a hidden or tools' folder in the repo, so it runs at the top, in ${repo}.`] };
      return { cwd, accountId: account.id, within: repo, leftBehind };
    }
    const cwd = swapHome(info.cwd, info.home);
    if (!cwd) return { problem: `${here} has no place for ${info.cwd}, as it isn't in the home folder there. Pick a folder to move it into.` };
    if (!isDirectory(cwd)) return { problem: `There's no folder ${cwd} on ${here}. Pick one to move it into.` };
    if (!inside(cwd, home)) return { problem: `${cwd} on ${here} leads out of the home folder, so the thread can't go there. Pick a folder to move it into.` };
    // Not the home itself, a hidden folder or ~/Library (keys, settings,
    // what tools load), on the old runner's word: Mike picks those.
    if (!plainPlace(cwd)) return { problem: `${cwd} on ${here} is the home folder or a hidden, Library or tools' folder in it, so the thread only goes there if you pick it.` };
    return { cwd, accountId: account.id, within: home, leftBehind };
  },

  // T: everything in place but the thread itself, which waits in staging
  // until the switch. Throws (after undoing what it made) to fail the move.
  async placeMove(this: Runner, row: MoveRow, entries: PackEntry[]): Promise<void> {
    // The id names the thread's folder here, and the apps put it in shell
    // lines and links: only a thread id's shape (thread-id.ts).
    if (!isThreadIdShape(row.threadId)) throw new Error("The moved thread's id isn't a thread id.");
    // Planned again here rather than read from the row (which the backend
    // hands back), with every check planMove makes just before anything is
    // cloned or made, and it must be the plan this runner said it had.
    const plan = await this.planMove(row);
    if ('problem' in plan) throw new Error(plan.problem);
    if (!row.plan || !samePlan(plan, row.plan)) throw new Error(`Where the thread would go on ${this.moveRunnerName(row.to)} changed since the move was planned, so it stays where it is. Move it again.`);
    const stage = stageOf(this.cfg.home, row.moveId);
    // An earlier placing of this move that didn't finish (the runner
    // stopped partway; one that did only asks for its claim again,
    // movePlaced) is undone first, as far as it can be: its placed.json is
    // the only record of its transcript and worktree, which emptying the
    // staging folder alone left behind (Codex's review, 23 Nov 2026).
    await this.discardMove(row);
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    const placed: Placed = { cwd: plan.cwd, transcript: [], leftBehind: [...plan.leftBehind], fromName: this.moveRunnerName(row.from) };
    // Whole or not at all: a write cut short would lose the only record of
    // what to undo (Codex's review, 23 Nov 2026).
    const save = () => atomicWriteFileSync(path.join(stage, 'placed.json'), JSON.stringify(placed));
    try {
      writeTree(entries, 'thread', path.join(stage, 'thread'));
      const recFile = path.join(stage, 'thread', 'thread.json');
      const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
      if (rec.id !== row.threadId) throw new Error("The moved thread's record is for another thread.");
      fitMovedLog(path.join(stage, 'thread', 'events.ndjson'), { threadId: row.threadId, now: path.join(stage, 'thread', 'media'), final: this.store.mediaDir(row.threadId) });
      // From an older runner, a thread it ran in the sandbox experiment.
      if (rec.confined) throw new Error("A thread that ran in a sandbox can't move here: Threadbear no longer has one to run it in.");
      const manifest = entries.find((e) => e.path === 'move.json');
      if (manifest) {
        const m = JSON.parse(manifest.data.toString('utf8')) as { leftBehind?: string[]; fromName?: unknown };
        placed.leftBehind.push(...(m.leftBehind ?? []));
        // A runner on its own key doesn't hear the other runners' names, so
        // the old one says its own (the note read "Moved from 7928812d92c1").
        if (placed.fromName === row.from && typeof m.fromName === 'string' && m.fromName.trim()) placed.fromName = m.fromName.trim().slice(0, 80);
      }
      // Only when and what each sends (moves.ts movedSchedules): nothing
      // that runs or approves anything comes from the other runner.
      const schedules = entries.find((e) => e.path === 'schedules.json');
      if (schedules) {
        const { schedules: kept, dropped } = movedSchedules(JSON.parse(schedules.data.toString('utf8')), row.threadId);
        placed.schedules = kept;
        if (dropped) placed.leftBehind.push(`${dropped === 1 ? "A schedule's shell check was" : `${dropped} schedules' shell checks were`} left off here: set ${dropped === 1 ? 'it' : 'them'} again if still wanted, with a card on this machine.`);
      }
      if (plan.clone) {
        const cloned = await cloneRepo(plan.clone.url, plan.clone.to);
        if (!cloned.ok) throw new Error(cloned.reason);
        // What git made is the folder planned, not one a link leads to.
        if (realpath(plan.clone.to) !== path.join(realpath(path.dirname(plan.clone.to)), path.basename(plan.clone.to))) throw new Error(`The clone of ${plan.clone.url} didn't end up in ${plan.clone.to}.`);
      }

      if (plan.worktree) {
        const patch = await findWorktreePatch(plan.worktree.repo, this.panelsRoot, this.patchCache, undefined, this.patchTrust);
        if (!patch) throw new Error(`${plan.worktree.repo} on ${this.moveRunnerName(row.to)} has no worktree patch, so the thread's worktree has nowhere to go.`);
        // makeWorktree makes it in the repo the patch is in: the one planned
        // and previewed, never a repo around it whose patch was found by
        // looking upward (security review, 17 Nov 2026).
        if (!(await patchMakesIn(patch.folder, plan.worktree.repo))) throw new Error(`${plan.worktree.repo} on ${this.moveRunnerName(row.to)} has no worktree patch of its own, so the thread's worktree has nowhere to go.`);
        const made = await makeWorktree({ cwd: plan.worktree.repo, threadId: row.threadId, patch, inUse: this.foldersInUse(row.threadId) });
        if (!made.ok) throw new Error(`Couldn't make the thread's worktree: ${made.reason}`);
        placed.worktree = { ...made.worktree, movedIn: true };
        placed.patchFile = made.patchFile;
        placed.patchName = patch.patch;
        placed.cwd = under(made.worktree.path, plan.worktree.subdir);
        save();
        const metaEntry = entries.find((e) => e.path === 'git/meta.json');
        if (metaEntry) {
          const meta = JSON.parse(metaEntry.data.toString('utf8')) as GitMeta;
          const bundle = entries.find((e) => e.path === 'git/move.bundle');
          const bundleFile = path.join(stage, 'move.bundle');
          if (bundle) fs.writeFileSync(bundleFile, bundle.data);
          const r = await unpackGit(made.worktree.path, meta, bundle ? bundleFile : undefined);
          fs.rmSync(bundleFile, { force: true });
          if (!r.ok) throw new Error(r.reason);
          // Patches and Claude settings it changed are held to the stored
          // hashes here, even in an always-trusted checkout.
          placed.gitTips = [meta.head, ...(meta.wip ? [meta.wip] : [])];
          if (await trustTouchedByMove(placed.worktree, os.homedir(), placed.gitTips, under(made.worktree.path, plan.worktree.subdir))) {
            this.patchTrust.unvouch?.(placed.worktree.path);
            placed.leftBehind.push(UNVOUCHED_NOTE);
            save();
          }
        }
      }

      // The folder the thread will run in, as made: inside its repo (the
      // new worktree, the clone), Mike's pick or this home, links followed.
      // One its git work didn't make (an ignored folder, say) is its top.
      const within = placed.worktree?.path ?? plan.within;
      if (!within) throw new Error("The move's plan didn't say what folder the thread stays inside.");
      if (!fs.existsSync(placed.cwd) && placed.cwd !== within && isDirectory(within)) {
        placed.leftBehind.push(`Its folder ${placed.cwd} isn't in this copy, so it runs at the top, in ${within}.`);
        placed.cwd = within;
      }
      // S's subdir in a clone or a new worktree, as made: not a hidden or
      // tools' folder in it (plainBelow), unless it's Mike's own pick.
      if (placed.cwd !== row.cwd && isDirectory(placed.cwd) && inside(placed.cwd, within) && !plainBelow(placed.cwd, within)) {
        placed.leftBehind.push(`Its folder ${placed.cwd} is a hidden or tools' folder in the repo, so it runs at the top, in ${within}.`);
        placed.cwd = within;
      }
      if (!isDirectory(placed.cwd) || !inside(placed.cwd, within)) throw new Error(`${placed.cwd} on ${this.moveRunnerName(row.to)} isn't a folder inside ${within}, so the thread can't go there.`);
      save();
      const account = this.accounts.list().find((a) => a.id === plan.accountId);
      if (!account) throw new Error(`No login ${plan.accountId} here.`);
      const sid: string | undefined = rec.nativeSessionId;
      const hasTranscript = sid && entries.some((e) => e.path === `transcript/${sid}.jsonl`);
      const oldCwd = rec.cwd as string;
      const oldAccount = rec.accountId as string;
      if (account.provider === 'claude' && rec.provider === 'claude' && hasTranscript) {
        const dir = path.join(account.configDir, 'projects', projectDirName(realpath(placed.cwd)));
        const mine = entries.filter((e) => e.path.startsWith('transcript/'));
        placed.transcript = mine.map((e) => path.join(dir, ...e.path.slice('transcript/'.length).split('/')));
        save();
        writeTree(mine, 'transcript', dir);
      } else if (rec.sessionUsed) {
        // No transcript to carry on from: a fresh session with the handoff
        // note, as a move to another provider is (runner.ts carryTranscript
        // can't find S's folder or login here, so it falls back).
        rec.handoff = { fromCwd: oldCwd, fromAccountId: oldAccount };
      }
      if (account.provider !== rec.provider) {
        rec.provider = account.provider;
        delete rec.model;
        delete rec.explicitModel;
        delete rec.effort;
      }
      // Nothing that runs or approves anything comes (dropMovedPowers),
      // and on the main Mac no more than Ask (capMovedMode).
      sanitizeMoved(rec, Boolean(this.movedInAtMostAsk?.()), placed.fromName, placed.leftBehind, { threadId: row.threadId, now: path.join(stage, 'thread', 'media'), final: this.store.mediaDir(row.threadId) });
      rec.cwd = placed.cwd;
      rec.cwdAt = this.isoNow();
      rec.accountId = account.id;
      delete rec.poolId;
      delete rec.worktreePending;
      delete rec.turnId;
      delete rec.stoppedMidTurn;
      rec.pendingApprovals = [];
      writeSlot(rec, { kind: 'arrived', ...(placed.worktree ? { worktree: placed.worktree } : {}) }, Date.now());
      fs.writeFileSync(recFile, JSON.stringify(rec, null, 2));
      placed.whole = true;
      if (row.expect) placed.expect = row.expect;
      save();
    } catch (e) {
      await this.discardMove(row);
      throw e;
    }
  },

  // T: whether this move's thread is placed here whole already, by this
  // runner before it restarted, with only the claim left to ask for again
  // (moves.ts). Placing it again would empty its staging folder, and a
  // worktree that came with git work (which cleanUpWorktree won't remove)
  // would then block the new one (Grok's review, 23 Nov 2026).
  // Only for the row it was placed from: the same preview binding (which
  // names the thread, both runners and the plan), and the staged record the
  // same thread, so a row the backend changed since can't claim what's
  // staged (Codex's review, 23 Nov 2026). Otherwise it's placed afresh,
  // with every check.
  movePlaced(this: Runner, row: MoveRow): boolean {
    try {
      const stage = stageOf(this.cfg.home, row.moveId);
      const placed = JSON.parse(fs.readFileSync(path.join(stage, 'placed.json'), 'utf8')) as Placed;
      if (placed.whole !== true || !placed.expect || placed.expect !== row.expect || this.threads.has(row.threadId)) return false;
      const rec = JSON.parse(fs.readFileSync(path.join(stage, 'thread', 'thread.json'), 'utf8')) as { id?: unknown };
      return rec.id === row.threadId;
    } catch {
      return false;
    }
  },

  // T, after the switch: the staging folder joins the live threads. Safe to
  // call again (after a restart, say): once it's here there's nothing left.
  async adoptMoved(this: Runner, row: MoveRow): Promise<{ adopted: boolean; schedules?: MovedSchedule[] }> {
    // As placeMove: a move an older runner placed (and this one resumes at
    // adopting) never had its id checked, and it names the live folder.
    if (!isThreadIdShape(row.threadId)) throw new Error("The moved thread's id isn't a thread id.");
    const stage = stageOf(this.cfg.home, row.moveId);
    const placedFile = path.join(stage, 'placed.json');
    if (!fs.existsSync(placedFile)) return { adopted: false };
    const placed = JSON.parse(fs.readFileSync(placedFile, 'utf8')) as Placed;
    const dest = paths.thread(this.cfg.home, row.threadId);
    const atMostAsk = Boolean(this.movedInAtMostAsk?.());
    // The record as placeMove leaves it is clean already, but one placed by
    // a runner from before (and adopted after it updated) may not be: made
    // clean before it joins the live threads, and again wherever a crash
    // left it (the live folder, or loaded at start).
    const clean = (recFile: string) => {
      try {
        const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
        const media = { threadId: row.threadId, now: path.join(path.dirname(recFile), 'media'), final: this.store.mediaDir(row.threadId) };
        let changed = sanitizeMoved(rec, atMostAsk, placed.fromName, placed.leftBehind, media);
        // Before adopting starts its queue (Codex's review, 17 Nov).
        changed = rebaseQueuedPictures(rec, row.threadId, media.now, media.final) || changed;
        if (changed) fs.writeFileSync(recFile, JSON.stringify(rec, null, 2));
      } catch {
        // No record to read: adopt says the thread didn't load.
      }
    };
    // Worked out again here: one placed by a runner from before this
    // never was (trustTouchedByMove), and it must be before anything loads
    // the worktree's patches or starts its CLI.
    // One placed by a runner from before unpackGit refused packages in the
    // uncommitted work may have them there, untracked, which trust reads
    // as installed and doesn't hash: they go (setup installs them again).
    if (placed.worktree && !placed.gitTips) await dropUntrackedPackages(placed.worktree.path);
    // One an older runner marked (worktree.unvouched) stays held whatever this says.
    if (placed.worktree && (placed.worktree.unvouched === true || (await trustTouchedByMove(placed.worktree, os.homedir(), placed.gitTips, placed.cwd)))) {
      this.patchTrust.unvouch?.(placed.worktree.path);
      if (!placed.leftBehind.includes(UNVOUCHED_NOTE)) placed.leftBehind.push(UNVOUCHED_NOTE);
    }
    if (!fs.existsSync(dest)) {
      clean(path.join(stage, 'thread', 'thread.json'));
      // Again for one a runner from before placed (placeMove does it).
      fitMovedLog(path.join(stage, 'thread', 'events.ndjson'), { threadId: row.threadId, now: path.join(stage, 'thread', 'media'), final: this.store.mediaDir(row.threadId) });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(path.join(stage, 'thread'), dest);
    } else {
      clean(path.join(dest, 'thread.json'));
      // A runner from before placed it and put it live, then stopped: its
      // log too, and the copy of the log this runner may have opened at
      // start is read again (Codex's and Gemini's reviews).
      fitMovedLog(path.join(dest, 'events.ndjson'), { threadId: row.threadId, now: this.store.mediaDir(row.threadId), final: this.store.mediaDir(row.threadId) });
      this.store.forget(row.threadId);
    }
    this.adopt(row.threadId);
    const st = this.threads.get(row.threadId);
    if (!st) throw new Error("The moved thread didn't load.");
    const final = this.store.mediaDir(row.threadId);
    if (sanitizeMoved(st.rec as unknown as Record<string, any>, atMostAsk, placed.fromName, placed.leftBehind, { threadId: row.threadId, now: final, final })) this.store.save(st.rec);
    // Again in memory, for one loaded before this (a crash left it live),
    // for what's still queued.
    if (rebaseQueuedPictures(st.rec as unknown as Record<string, any>, row.threadId, final, final)) this.store.save(st.rec);
    const lines = [`Moved from ${placed.fromName} to ${this.moveRunnerName(row.to)}, in ${placed.cwd}.`, ...placed.leftBehind];
    this.emit(st, { type: 'system.note', text: lines.join(' ') });
    this.markDirty(st);
    fs.rmSync(stage, { recursive: true, force: true });
    if (placed.worktree && placed.patchFile && placed.patchName) {
      const patch = await findWorktreePatch(placed.worktree.mainCheckout, this.panelsRoot, this.patchCache, undefined, this.patchTrust).catch(() => undefined);
      const changed = patch?.setup ? await setupChangedByMove(placed.worktree, placed.patchFile) : undefined;
      if (changed) this.emit(st, { type: 'system.note', text: `Didn't run the worktree's setup (${patch!.setup}): ${changed}. Look at it, then run it yourself if it's right.` });
      else if (patch) await this.setUpWorktree(st, { worktree: placed.worktree, patchFile: placed.patchFile }, patch);
    }
    this.log.info('took a moved thread in', { threadId: row.threadId, from: row.from });
    // Through the same filter again: a placed.json from before it had one.
    const schedules = movedSchedules(placed.schedules ?? [], row.threadId).schedules;
    return { adopted: true, ...(schedules.length ? { schedules } : {}) };
  },

  // T: the move failed or was cancelled before the switch.
  async discardMove(this: Runner, row: MoveRow): Promise<void> {
    let stage: string;
    try {
      stage = stageOf(this.cfg.home, row.moveId);
    } catch {
      return;
    }
    const placedFile = path.join(stage, 'placed.json');
    if (fs.existsSync(placedFile) && !this.threads.has(row.threadId)) {
      const placed = JSON.parse(fs.readFileSync(placedFile, 'utf8')) as Placed;
      for (const f of placed.transcript) fs.rmSync(f, { force: true });
      if (placed.worktree) await cleanUpWorktree(placed.worktree).catch(() => undefined);
    }
    fs.rmSync(stage, { recursive: true, force: true });
  },

  // T, for the Mac's Move sheet (threads.movePreview, a `moves.preview`
  // call): planMove's guess for a thread S described, with nothing made or
  // cloned, and this runner's logins of the thread's provider to pick from.
  // What would stop the move goes in `problems` rather than throwing, so the
  // sheet can say it and still offer the pickers.
  async previewMove(this: Runner, p: { info: MoveInfo; self: string; cwd?: string; accountId?: string }): Promise<MovePreview> {
    const accounts = this.accounts
      .list()
      .filter((a) => a.provider === p.info.provider)
      .map((a) => ({ id: a.id, provider: a.provider, title: a.title, ...(a.email ? { email: a.email } : {}) }));
    const now = Date.now();
    const row: MoveRow = { moveId: 'preview', threadId: '', from: '', to: p.self, state: 'asking', info: p.info, ...(p.cwd ? { cwd: p.cwd } : {}), ...(p.accountId ? { accountId: p.accountId } : {}), createdAt: now, updatedAt: now };
    const plan = await this.planMove(row);
    if ('problem' in plan) return { accounts, leftBehind: [], problems: [plan.problem], checksPreview: true };
    const problems: string[] = [];
    // placeMove's own check, seen before Mike presses Move rather than
    // after the thread has frozen and packed. A repo still to be cloned
    // can't be looked at yet.
    if (plan.worktree && !plan.clone) {
      const patch = await findWorktreePatch(plan.worktree.repo, this.panelsRoot, this.patchCache, undefined, this.patchTrust).catch(() => undefined);
      if (!patch) problems.push(`${plan.worktree.repo} on ${this.moveRunnerName(p.self)} has no worktree patch, so the thread's worktree has nowhere to go.`);
      else if (!(await patchMakesIn(patch.folder, plan.worktree.repo))) problems.push(`${plan.worktree.repo} on ${this.moveRunnerName(p.self)} has no worktree patch of its own (the one found is another repo's), so the thread's worktree has nowhere to go.`);
    }
    return {
      cwd: plan.cwd,
      accountId: plan.accountId,
      accounts,
      leftBehind: plan.leftBehind,
      problems,
      checksPreview: true,
      ...(plan.worktree ? { worktree: true } : {}),
      ...(plan.clone ? { clone: plan.clone.to, cloneFrom: plan.clone.url } : {}),
    };
  },

  moveRunnerName(this: Runner, runnerId: string): string {
    return this.runnerNames?.(runnerId) ?? runnerId;
  },

  // No turn starts in the thread while `reason` holds it; messages wait
  // in its queue. A handover's hold belongs only to the old runner.
  holdTurns(this: Runner, threadId: string, reason: TurnHold): void {
    const st = this.threads.get(threadId);
    if (!st) return;
    (st.rt.holds ??= new Set()).add(reason);
  },

  // The hold lifted; what waited in the queue goes on.
  releaseTurns(this: Runner, threadId: string, reason: TurnHold): void {
    const st = this.threads.get(threadId);
    if (!st?.rt.holds?.delete(reason)) return;
    if (!st.rt.holds.size) st.rt.holds = undefined;
    this.kickQueue(st);
  },

  // Box mode's save (src/box-save.ts). Every save the backend asks for is a
  // stopping one (to sleep, at its day's hours, or to be archived), and
  // once it's acknowledged the backend may delete the box: so nothing may
  // change the thread's folder after the copy is taken. Turns are held, a
  // running turn is interrupted (`turnGraceMs` to end), and the CLI closed;
  // then `stopOthers` (box-procs.ts) kills every other process the box
  // started, whatever it is (a setup's background children, a teardown,
  // anything the agent left running), the runner's own work is waited for,
  // and it looks once more that nothing new started, before the record is
  // written out and returned. The hold stays whatever happens, a failure
  // here included: only the backend lets it go (box-save.ts SaveHold).
  async quiesceForSave(this: Runner, threadId: string, opts: { stopOthers?: () => Promise<unknown>; turnGraceMs?: number; waitMs?: number } = {}): Promise<ThreadRecord> {
    const st = this.threads.get(threadId);
    if (!st) throw new Error("The box's thread isn't here, so there's nothing to save.");
    const { rt } = st;
    this.holdTurns(threadId, 'save');
    if (rt.turn || rt.approvals.size) this.interrupt(threadId);
    const waitFor = async (busy: () => boolean, ms: number) => {
      for (const end = Date.now() + ms; busy(); ) {
        if (Date.now() > end) return false;
        await new Promise((r) => setTimeout(r, 50));
      }
      return true;
    };
    // The turn ends by itself if it can; if not, closing its CLI ends it.
    await waitFor(() => Boolean(rt.turn), opts.turnGraceMs ?? 30_000);
    this.flushDeltas(st);
    if (runningSession(rt)) {
      this.rememberStoppedWork(st);
      this.releaseSession(st);
    }
    await opts.stopOthers?.();
    if (rt.closing) await rt.closing;
    // And the patches' functions already being read (a live poll): no new
    // one starts while the save holds it (readPatches).
    const busy = () => Boolean(rt.turn || rt.restoreSetup || rt.hooksRunning || rt.runningActions?.size || rt.editing || rt.cleaning || rt.preparing || this.patchReads.size);
    if (!(await waitFor(busy, opts.waitMs ?? 60_000))) throw new Error("The thread's work didn't stop in time, so it wasn't saved. It stays stopped until the backend wakes it.");
    // Nothing new since: whatever the waits above let finish may have started something.
    await opts.stopOthers?.();
    this.flushDeltas(st);
    this.store.save(st.rec);
    return structuredClone(st.rec);
  },

  // Box mode, after a box restored its thread from a save (box-save.ts): the
  // worktree's setup again, as the save carries no installed packages. The
  // thread's turns are held ('setup', set as it loaded: RunnerDeps
  // boxHolds) until it's done; a setup that fails says so, and the turns go
  // ahead all the same. It's a writer a stopping save waits for
  // (rt.restoreSetup). The checkout is the box's own clone, trusted as the
  // runner's own checkout is.
  async setUpRestored(this: Runner, threadId: string): Promise<void> {
    const st = this.threads.get(threadId);
    const run = async () => {
      const w = st?.rec.worktree;
      if (!st || !w || w.removedAt || !w.patchFile) return;
      const patch = await findWorktreePatch(w.mainCheckout, this.panelsRoot, this.patchCache, undefined, this.patchTrust).catch(() => undefined);
      if (!patch) {
        this.emit(st, { type: 'system.note', text: "Couldn't find the worktree's patch after restoring this thread, so its setup didn't run again. Run it yourself if the thread needs it." });
        return;
      }
      const ok = await this.setUpWorktree(st, { worktree: w, patchFile: path.join(w.path, w.patchFile) }, patch);
      if (ok === false) this.emit(st, { type: 'system.note', text: "The worktree's setup failed after this thread was restored on a new machine. The thread carries on; run the setup yourself if it needs it." });
    };
    const going = run().catch((e: unknown) => {
      if (st) this.emit(st, { type: 'system.note', text: `The worktree's setup couldn't run after this thread was restored: ${String((e as Error)?.message ?? e)}. The thread carries on.` });
    });
    if (st) st.rt.restoreSetup = going;
    try {
      await going;
    } finally {
      if (st && st.rt.restoreSetup === going) st.rt.restoreSetup = undefined;
      this.releaseTurns(threadId, 'setup');
    }
  },

  // Box mode: a turn refused with the box's cloud token (errorKind auth). A
  // box has one login, so there's nowhere to move: the thread says so once,
  // waits with its turns held (messages queue behind), and the backend is
  // told (onBoxTokenRefused) so the token card shows on Mike's Mac.
  holdForToken(this: Runner, st: ThreadState, turnId: string): void {
    const { rec } = st;
    const already = Boolean(rec.waitingForToken);
    // Which token was refused: the one the box ran on (box.json), kept with
    // the wait so a restart says it again with that version (box-token.ts).
    const was = rec.waitingForToken;
    const refusedSetAt = was?.refusedSetAt ?? this.boxTokenSetAt?.();
    rec.waitingForToken = { since: was?.since ?? this.isoNow(), turnId, ...(refusedSetAt !== undefined ? { refusedSetAt } : {}), reported: was?.reported ?? false };
    this.holdTurns(rec.id, 'token');
    if (!already) this.emit(st, { type: 'system.note', text: "Claude refused this box's token. The thread carries on once a new one is set." });
    this.markDirty(st);
    this.onBoxTokenRefused?.(rec.id);
  },

  // The backend has heard the box's refusal (box-token.ts): kept, so a restart doesn't say it again.
  tokenRefusalReported(this: Runner, threadId: string): void {
    const st = this.threads.get(threadId);
    if (!st?.rec.waitingForToken || st.rec.waitingForToken.reported) return;
    st.rec.waitingForToken.reported = true;
    this.markDirty(st);
  },

  // A newer cloud token is on disk (box-token.ts): the CLI goes so the next
  // one starts on it, and the thread carries on by itself, unless a message
  // of Mike's waited meanwhile, which goes instead.
  tokenReplaced(this: Runner, threadId: string): void {
    const st = this.threads.get(threadId);
    if (!st?.rec.waitingForToken) return;
    delete st.rec.waitingForToken;
    this.markDirty(st);
    if (runningSession(st.rt)) this.releaseSession(st);
    const queued = st.rec.queue.length > 0;
    this.releaseTurns(threadId, 'token');
    if (!queued && this.bucket(st.rec) === 'inbox') this.carryOn(st, CARRY_ON_TOKEN);
  },

  // Box mode's degraded state (box-mode.ts): the box can't use its folder,
  // so its thread runs nothing and says why, and the box stays up holding
  // its key until a person sees to it.
  holdBroken(this: Runner, threadId: string, why: string): void {
    const st = this.threads.get(threadId);
    if (!st) return;
    this.holdTurns(threadId, 'broken');
    this.emit(st, { type: 'system.note', text: `This thread's machine can't run it: ${why} It stays up, with nothing run, until someone looks at it.` });
  },
};

export type MovesPart = RunnerPart<typeof movesPart>;
