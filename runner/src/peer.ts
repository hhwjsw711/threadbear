// Which thread a process on this Mac belongs to, for the RPC server (docs/
// protocol/connection.md, "Who's really calling"). Credentials alone can't say: anything
// a thread's shell runs can read the token file or wipe its own key from the
// environment. The kernel can say what it's a child of, so the server looks at
// the far end of the connection and walks up its parents to a thread's CLI.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { lsofPath } from './handover.ts';
import { psTable, type ProcessRegistry } from './proc.ts';
import type { Logger } from './log.ts';
import { parseEnviron, parseJobs, parseProcesses, parseSnapshot, win32Helper, winAddress, type WinConnection, type WinProcess } from './win32-helper.ts';

export type PeerDeps = {
  // threadOfPid gets the process's start time where the lookup has one
  // (Windows), so a CLI's pid taken by a newer process doesn't count.
  registry: { threadOfPid(pid: number, created?: bigint): string | undefined | Promise<string | undefined> } & Partial<Pick<ProcessRegistry, 'threadOfGroup' | 'threadOfJob'>>;
  // A thread this runner or a draining one really has (a registry entry can
  // be a job's label, like models:<account>).
  known: (threadId: string) => boolean;
  log: Logger;
  // Tests pass stand-ins: the processes holding this exact client socket.
  lsof?: (sock: PeerSocket) => Promise<number[]>;
  table?: () => Promise<ProcRow[]>;
  // Windows: the helper's snapshot of a port (tests pass a stand-in).
  snapshot?: (port: number) => Promise<Snapshot>;
  platform?: NodeJS.Platform;
  // How long lsof and ps each get. Live connections keep LOOKUP_MS; the test
  // of a real lookup gives them longer, as on a loaded Mac lsof alone took
  // over 3 s (a fork, 15 Nov).
  lookupMs?: number;
  // Linux: where /proc is (tests pass a stand-in tree).
  procRoot?: string;
  // The environments of these processes, as text (keyedThreads). Tests pass
  // a stand-in; a lookup given a stand-in table or lsof and none of these
  // reads no environments, as its pids aren't real.
  envOf?: EnvsOf;
  // The thread keys and ids this runner was started under (ownThreadMarks):
  // a thread that started a dev runner is that runner's owner.
  own?: OwnMarks;
  // A thread's key as this runner makes it (threadKey with its token): a
  // key found in an environment is checked against it.
  keyOf?: (threadId: string) => string;
  // Windows: the Threadbear jobs each process is in (jobsOfHelper). Tests
  // pass a stand-in; a lookup given a stand-in snapshot and none of these
  // looks at no jobs.
  jobsOf?: JobsOf;
  // This runner's pid (tests pass a stand-in): a process under it that it
  // started for a thread (a patch's action) has the thread's id and the key's
  // variable, empty.
  self?: number;
  // The primary also identifies legacy draining owner links by the socket's
  // real holders, even when they skip hello. Never a request's claimed pid.
  includeOwnerPids?: boolean;
};

// Every process's environment it could read, by pid; one it couldn't find
// is left out.
export type EnvsOf = (pids: number[]) => Promise<Map<number, string>>;
// Each process's Threadbear jobs by name; one that has gone is left out.
export type JobsOf = (pids: number[]) => Promise<Map<number, string[]>>;

// 3 s until 23 Nov 2026. A lookup that runs out now closes the connection
// rather than letting its credential decide (Daybreak finding 175), so it
// gets longer: the app and tb wait a little on a loaded Mac instead of
// reconnecting.
const LOOKUP_MS = 6000;

// Who is at the far end of a connection, as the lookup found it: under a
// thread's CLI, or not under any (a terminal, the app, the runner's own
// jobs). A lookup that can't say either throws UnresolvedPeer (or
// AmbiguousPeer), and the server closes the connection: never "the owner"
// for want of an answer (Daybreak finding 175).
export type PeerCaller = { kind: 'thread'; threadId: string } | { kind: 'owner'; pids?: number[] };
export const OWNER_PEER: PeerCaller = Object.freeze({ kind: 'owner' });
export const threadPeer = (threadId: string): PeerCaller => ({ kind: 'thread', threadId });

// A process as the lookup sees it. created (Windows only, a FILETIME) is
// when it started: Windows keeps a process's parent id after the parent
// has gone, and gives that id to the next process, so a parent that
// started after its child isn't its parent.
export type ProcRow = { pid: number; ppid: number; pgid?: number; sid?: number; created?: bigint };

// The accepted connection, as the runner's side sees it: the client's
// address and port, and the address and port it reached. All four, because
// a port number alone isn't one socket: a client bound to 127.0.0.2 (Linux
// lets any 127/8 address be used) can share another's port, and lsof's
// `-iTCP:<port>` also lists any socket whose far end uses that number, like
// a Full thread's dev server talking to port 5432 (Daybreak finding 137).
export type PeerSocket = { remoteAddress: string; remotePort: number; localAddress: string; localPort: number };

// Thrown when the processes holding one socket sit under different threads
// (a socket handed to a child in another thread can't be told apart): the
// server refuses the connection rather than pick one.
export class AmbiguousPeer extends Error {}

// Thrown when the lookup can't place the connection at all: lsof or /proc
// failing, timing out or finding nobody holding a socket the runner has
// just accepted, or ps failing. The server closes the connection.
export class UnresolvedPeer extends Error {}

// Thrown when a connection this runner's registry finds under none of its
// threads comes from under a thread of another runner on this machine (a
// thread key in its environment or a parent's) that didn't start this
// runner. This runner can't give it that thread's limits, so it closes it
// rather than take it as the owner (Daybreak finding 177).
export class ForeignPeer extends Error {}

// The thread keys and thread ids in a process's environment as text (a
// Mac's `ps eww` with its arguments taken off, or Linux's
// /proc/<pid>/environ with its NULs), each once. The runner gives every
// thread's CLI both (restart.ts, threadEnv; a CLI started before thread
// keys has only the id, and one from before the rename only THREADBARE_'s),
// and a CLI's own environment can't be changed by anything it runs.
const KEY_IN_TEXT = /(?:^|[\s\0])THREADB(?:EAR|ARE)_THREAD_KEY=([0-9a-f]{64})(?=[\s\0]|$)/g;
const ID_IN_TEXT = /(?:^|[\s\0])THREADB(?:EAR|ARE)_THREAD_ID=([\w:.-]{1,128})(?=[\s\0]|$)/g;
// emptyKey: the key's variable is there and empty, as the runner gives a
// patch's action or a worktree's setup (threadEnv with no key); a CLI from
// before thread keys has no such variable at all.
export type ThreadMarks = { keys: string[]; ids: string[]; emptyKey: boolean };
const EMPTY_KEY = /(?:^|[\s\0])THREADB(?:EAR|ARE)_THREAD_KEY=(?=[\s\0]|$)/;
// jobs: on Windows, the Threadbear jobs this runner itself is in (a dev
// runner started from a thread's shell is in that thread's CLI's job).
export type OwnMarks = { keys: ReadonlySet<string>; ids: ReadonlySet<string>; jobs?: ReadonlySet<string> };
export function threadMarksIn(text: string): ThreadMarks {
  // Linux's (NUL-separated, from procEnvs): each entry by its exact name, so
  // a value that mentions one isn't one. A Mac's ps line can't be split
  // like that, so a value that does reads as one too: it can only add.
  if (text.startsWith('\0')) {
    const keys = new Set<string>();
    const ids = new Set<string>();
    let emptyKey = false;
    for (const entry of text.split('\0')) {
      const m = /^THREADB(?:EAR|ARE)_THREAD_(KEY|ID)=(.*)$/s.exec(entry);
      if (m?.[1] === 'KEY' && m[2] === '') emptyKey = true;
      else if (m?.[1] === 'KEY' && /^[0-9a-f]{64}$/.test(m[2]!)) keys.add(m[2]!);
      else if (m?.[1] === 'ID' && /^[\w:.-]{1,128}$/.test(m[2]!)) ids.add(m[2]!);
    }
    return { keys: [...keys], ids: [...ids], emptyKey };
  }
  return { keys: [...new Set([...text.matchAll(KEY_IN_TEXT)].map((m) => m[1]!))], ids: [...new Set([...text.matchAll(ID_IN_TEXT)].map((m) => m[1]!))], emptyKey: EMPTY_KEY.test(text) };
}

const sameKey = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// More than this in one process's environment isn't a CLI's (it has one of
// each, and the id under both names): it's turned away rather than have
// every one checked.
const MAX_KEYS = 4;
const MAX_IDS = 8;

// What lsof calls an address in a name: IPv6 in brackets, an IPv4-mapped
// one as plain IPv4 (Node's dual-stack form).
function lsofAddr(addr: string, port: number): string {
  const a = addr.startsWith('::ffff:') && addr.includes('.') ? addr.slice(7) : addr;
  return a.includes(':') ? `[${a}]:${port}` : `${a}:${port}`;
}

// A slow ps mustn't hold a connection's frames back for long (rpc.ts queues them).
function deadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('process lookup timed out')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// The processes holding the client's end of exactly this connection: a file
// whose name is client->server. `-iTCP@addr:port` only narrows what lsof
// reads; the name decides. The runner's own end (server->client) never
// matches, nor does any other socket that merely shares a port number.
function lsofPids(sock: PeerSocket, ms: number): Promise<number[]> {
  const client = lsofAddr(sock.remoteAddress, sock.remotePort);
  const want = `${client}->${lsofAddr(sock.localAddress, sock.localPort)}`;
  return new Promise((resolve, reject) => {
    execFile(lsofPath(), ['-nP', `-iTCP@${client}`, '-sTCP:ESTABLISHED', '-Fpn'], { timeout: ms }, (err, stdout) => {
      try {
        resolve(lsofAnswer(err, stdout, want));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Linux: the same from /proc, with no program to run or find. The socket
// whose local end is the client's address and port and whose far end is
// the runner's, from /proc/net/tcp and tcp6 (this network namespace's), then
// every process with a descriptor on that socket's inode. A process of
// another user can't be read; a thread's processes are this user's.
export async function procPids(sock: PeerSocket, root = '/proc', until = Infinity): Promise<number[]> {
  const client = addrBytes(sock.remoteAddress);
  const server = addrBytes(sock.localAddress);
  if (!client || !server) throw new Error(`not an address: ${sock.remoteAddress} or ${sock.localAddress}`);
  const inodes = new Set<string>();
  let tables = 0;
  for (const f of ['tcp', 'tcp6']) {
    let text: string;
    try {
      text = await fs.promises.readFile(`${root}/net/${f}`, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    tables++;
    for (const inode of socketInodes(text, client, sock.remotePort, server, sock.localPort)) inodes.add(inode);
  }
  if (tables === 0) throw new Error(`no ${root}/net/tcp`);
  if (inodes.size === 0) return [];
  const want = new Set([...inodes].map((i) => `socket:[${i}]`));
  const pids: number[] = [];
  // The fds are read synchronously, with a turn of the event loop (and a
  // look at the time) every YIELD_EVERY reads (procTable too): awaiting
  // every readlink took 3 to 4 s on Pixel (a phone's Linux) with 150 idle
  // node processes, past LOOKUP_MS once a test run loaded it, so connections
  // were dropped with 4503. This way it's about 0.2 s. Counting reads, not
  // processes, keeps one process with a great many fds from holding the
  // runner up.
  let reads = 0;
  const step = async (): Promise<void> => {
    if (++reads % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
    // Stop once its time is up, rather than go on reading after the answer
    // stopped mattering.
    if (Date.now() > until) throw new Error('reading /proc took too long');
  };
  for (const name of await fs.promises.readdir(root)) {
    if (!/^\d+$/.test(name)) continue;
    await step();
    let fds: string[];
    try {
      fds = fs.readdirSync(`${root}/${name}/fd`);
    } catch {
      continue; // gone, or not this user's
    }
    for (const fd of fds) {
      await step();
      let target: string;
      try {
        target = fs.readlinkSync(`${root}/${name}/fd/${fd}`);
      } catch {
        continue;
      }
      if (want.has(target)) {
        pids.push(Number(name));
        break;
      }
    }
  }
  if (Date.now() > until) throw new Error('reading /proc took too long');
  return pids;
}

const YIELD_EVERY = 64;

// Linux: the process table from /proc/<pid>/stat, no ps needed (Gemini's
// review: a box without /bin/ps would otherwise refuse every connection).
// The command name (field 2, in brackets) can hold spaces and brackets, so
// the fields are counted from the last ')': state, ppid, pgrp.
export async function procTable(root = '/proc'): Promise<ProcRow[]> {
  const rows: ProcRow[] = [];
  let n = 0;
  for (const name of await fs.promises.readdir(root)) {
    if (!/^\d+$/.test(name)) continue;
    if (++n % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
    let stat: string;
    try {
      stat = fs.readFileSync(`${root}/${name}/stat`, 'utf8');
    } catch {
      continue; // gone since the listing
    }
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(f[1]);
    const pgid = Number(f[2]);
    const sid = Number(f[3]);
    if (Number.isInteger(ppid) && Number.isInteger(pgid)) rows.push({ pid: Number(name), ppid, pgid, ...(Number.isInteger(sid) ? { sid } : {}) });
  }
  if (rows.length === 0) throw new Error(`no processes in ${root}`);
  return rows;
}

// The inodes of established sockets (state 01) in a /proc/net/tcp table
// whose local end is `local`:`lport` and far end `remote`:`rport`.
export function socketInodes(table: string, local: Uint8Array, lport: number, remote: Uint8Array, rport: number, little = os.endianness() === 'LE'): string[] {
  const out: string[] = [];
  for (const line of table.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '01') continue;
    const l = procAddr(f[1], little);
    const r = procAddr(f[2], little);
    if (!l || !r || l.port !== lport || r.port !== rport || !sameBytes(l.ip, local) || !sameBytes(r.ip, remote)) continue;
    if (/^\d+$/.test(f[9]) && f[9] !== '0') out.push(f[9]);
  }
  return out;
}

// "0100007F:1F90" (IPv4) or 32 hex digits and a port (IPv6): each 32-bit
// word as the kernel holds it, so byte-swapped on a little-endian machine.
function procAddr(field: string, little: boolean): { ip: Uint8Array; port: number } | undefined {
  const m = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/.exec(field);
  if (!m) return undefined;
  const bytes = new Uint8Array(m[1].length / 2);
  for (let w = 0; w < bytes.length / 4; w++) {
    for (let b = 0; b < 4; b++) {
      const hex = m[1].slice(w * 8 + b * 2, w * 8 + b * 2 + 2);
      bytes[w * 4 + (little ? 3 - b : b)] = parseInt(hex, 16);
    }
  }
  return { ip: unmapped(bytes), port: parseInt(m[2], 16) };
}

// An address as bytes: 4 for IPv4 (and IPv4-mapped IPv6), 16 for IPv6.
export function addrBytes(addr: string): Uint8Array | undefined {
  const v4 = (s: string) => {
    const parts = s.split('.');
    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) < 256)) return undefined;
    return Uint8Array.from(parts.map(Number));
  };
  if (!addr.includes(':')) return v4(addr);
  let a = addr.replace(/%.*$/, '');
  // A dotted IPv4 tail (::ffff:127.0.0.1) as its two groups.
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) {
    const b = v4(dotted[1]);
    if (!b) return undefined;
    a = `${a.slice(0, dotted.index)}:${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return undefined;
  const groups = (s: string) => (s === '' ? [] : s.split(':').map((g) => (/^[0-9A-Fa-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return undefined;
  const words: number[] = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest];
  if (words.length !== 8 || words.some((w) => !Number.isInteger(w))) return undefined;
  const bytes = new Uint8Array(16);
  words.forEach((w, i) => {
    bytes[i * 2] = w >> 8;
    bytes[i * 2 + 1] = w & 0xff;
  });
  return unmapped(bytes);
}

function unmapped(b: Uint8Array): Uint8Array {
  if (b.length === 16 && b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return b.slice(12);
  return b;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// What one lsof run says. It exits 1 when nothing matched. Anything else (another
// exit code, a signal, the time limit) is a failed look, whatever it printed
// first: a partial list could leave out a thread's holder (Codex's review of
// finding 175).
export function lsofAnswer(err: unknown, stdout: string, want: string): number[] {
  if (err && (err as { code?: unknown }).code !== 1) throw err;
  return socketOwners(stdout, want);
}

// From lsof's -F output (p<pid>, then f<fd> and n<name> per file), the pids
// with a file named exactly `want`.
export function socketOwners(out: string, want: string): number[] {
  const pids = new Set<number>();
  let pid: number | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && line.slice(1) === want && pid !== undefined && Number.isInteger(pid)) pids.add(pid);
  }
  return [...pids];
}

// The same on Windows, from the runner's helper (win32-helper.ts). Its one
// PowerShell answers a question at a time, so connections don't each ask:
// a lookup joins the next snapshot of the port (its connections and every
// process) taken after it asked, and every lookup waiting then shares it.
// Asked one each, a thread could open enough connections of its own to
// queue a stolen-credential one past its deadline (Codex's review, 18 Nov
// 2026). It's at most two snapshots' wait, whatever the number waiting.
export type Snapshot = { connections: WinConnection[]; processes: WinProcess[] };

export function coalesce<T>(take: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  let queued: Promise<T> | undefined;
  const next = (): Promise<T> => {
    if (!running) {
      running = take().finally(() => {
        running = undefined;
      });
      return running;
    }
    // One is already going, maybe from before this connection: wait for a
    // new one.
    queued ??= running.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      queued = undefined;
      return next();
    });
    return queued;
  };
  return next;
}

const snapshots = new Map<number, () => Promise<Snapshot>>();

function windowsSnapshot(port: number): Promise<Snapshot> {
  let take = snapshots.get(port);
  if (!take) {
    take = coalesce(async () => parseSnapshot(await win32Helper().ask('snapshot', { port })));
    snapshots.set(port, take);
  }
  return take();
}

// The pids holding exactly the client's end of this connection, from a
// snapshot: its own address and port are the client's, its far end the
// runner's.
export function snapshotOwners(snap: Snapshot, sock: PeerSocket): number[] {
  const pids = new Set<number>();
  for (const c of snap.connections) {
    if (winAddress(c.localAddress) !== winAddress(sock.remoteAddress) || c.localPort !== sock.remotePort) continue;
    if (winAddress(c.remoteAddress) !== winAddress(sock.localAddress) || c.remotePort !== sock.localPort) continue;
    pids.add(c.pid);
  }
  return [...pids];
}

// Who holds the client's end of this connection (PeerCaller). Every
// process holding the socket is looked at (a forked child keeps its
// parent's); if they name different threads it throws AmbiguousPeer. If
// the lookup can't say, it throws UnresolvedPeer, on every system: the
// connection is open (the runner accepted it before asking), so nobody
// holding it means the lookup didn't see what it should, not that nobody
// did (Codex's second review, 18 Nov; Daybreak finding 175). A Mac uses
// lsof at its fixed path and /bin/ps; Linux reads /proc and needs neither
// lsof nor anything on PATH; Windows asks the runner's helper.
export async function threadOfSocket(sock: PeerSocket, deps: PeerDeps): Promise<PeerCaller> {
  let pids: number[];
  let table: ProcRow[] = [];
  const platform = deps.platform ?? process.platform;
  const windows = platform === 'win32';
  const ms = deps.lookupMs ?? LOOKUP_MS;
  try {
    let holders: number[];
    if (windows && !deps.lsof) {
      const snap = await deadline((deps.snapshot ?? windowsSnapshot)(sock.localPort), ms);
      holders = snapshotOwners(snap, sock);
      table = snap.processes;
    } else {
      const find = deps.lsof ?? (platform === 'linux' ? (s: PeerSocket) => procPids(s, deps.procRoot, Date.now() + ms) : (s: PeerSocket) => lsofPids(s, ms));
      holders = await deadline(find(sock), ms);
    }
    if (holders.length === 0) throw new Error('nobody holds this connection');
    pids = holders.filter((p) => p !== process.pid);
    // Only the runner itself: its own connection, the owner's.
    if (pids.length === 0) return deps.includeOwnerPids ? { kind: 'owner', pids: [process.pid] } : OWNER_PEER;
    if (!(windows && !deps.lsof)) table = await deadline((deps.table ?? (platform === 'linux' ? () => procTable(deps.procRoot) : psTable))(), ms);
    // One that isn't in the process table has gone, or the table missed
    // it: either way its parents can't be walked.
    const live = new Set(table.map((r) => r.pid));
    const missing = pids.find((p) => !live.has(p));
    if (missing !== undefined) throw new Error(`process ${missing} isn't in the process table`);
  } catch (e) {
    deps.log.warn('could not tell which process connected to the RPC', { error: String(e) });
    throw new UnresolvedPeer(`could not tell which process connected: ${String(e)}`);
  }
  const threads = new Set<string>();
  const placed: { pid: number; thread?: string; below: number[] }[] = [];
  for (const peer of pids) {
    const found = await threadOfPid(peer, table, deps, windows);
    if (found.thread) threads.add(found.thread);
    placed.push({ pid: peer, ...found, below: found.below ?? lookedAt(peer, table, platform) });
  }
  if (threads.size > 1) throw new AmbiguousPeer(`one connection is held by processes under ${threads.size} threads`);
  // The environments say the rest (Daybreak finding 177). Under none of this
  // runner's threads isn't yet under none at all: it may be another runner's
  // thread, or one of this runner's that left its CLI's tree with its key on
  // it. And under one of its threads' CLIs may still be under another
  // runner's thread's CLI nearer: a thread of a dev runner that thread
  // started, which mustn't get the starting thread's access here.
  const envOf = deps.envOf ?? (deps.lsof || deps.table || deps.snapshot ? undefined : realEnvsOf(platform, deps.procRoot, ms));
  if (envOf) {
    const keyed = await keyedThreads(placed, envOf, deps, ms).catch((e: unknown) => {
      if (e instanceof UnresolvedPeer) deps.log.warn('could not tell which process connected to the RPC', { error: e.message });
      throw e;
    });
    if (keyed === 'foreign') {
      deps.log.warn("an RPC client is under another runner's thread; closing it", { pids });
      throw new ForeignPeer("this connection comes from under a thread of another runner on this machine, which didn't start this one");
    }
    for (const t of keyed) threads.add(t);
    if (threads.size > 1) throw new AmbiguousPeer(`one connection is held by processes under ${threads.size} threads`);
  }
  // Windows: the jobs the holders are in. A thread's CLI and everything it
  // starts are in its job and can't leave, whatever their parents say (Git
  // Bash's processes lose theirs at each exec, and its programs keep their
  // environment where the PEB doesn't show it), so this is what places a
  // process there: one of this runner's threads' jobs makes it that thread,
  // one this runner was started in is the owner's, any other is another
  // runner's thread (Daybreak finding 177).
  const jobsOf = deps.jobsOf ?? (windows && !deps.lsof && !deps.snapshot ? jobsOfHelper : undefined);
  if (jobsOf) {
    let jobs: Map<number, string[]>;
    try {
      jobs = await deadline(jobsOf(placed.map((h) => h.pid)), ms);
    } catch (e) {
      deps.log.warn('could not tell which process connected to the RPC', { error: String(e) });
      throw new UnresolvedPeer(`could not read the jobs of the processes holding it: ${String(e)}`);
    }
    const own = deps.own?.jobs ?? new Set<string>();
    for (const h of placed) {
      const names = jobs.get(h.pid);
      if (names === undefined) throw new UnresolvedPeer(`process ${h.pid} went before its jobs could be read`);
      for (const name of names) {
        const t = deps.registry.threadOfJob?.(name);
        if (t !== undefined && deps.known(t)) {
          if (h.thread !== undefined && h.thread !== t) throw new ForeignPeer(`process ${h.pid} is in another thread's job`);
          threads.add(t);
        } else if (!own.has(name)) {
          deps.log.warn("an RPC client is in another runner's thread's job; closing it", { pid: h.pid });
          throw new ForeignPeer("this connection comes from under a thread of another runner on this machine, which didn't start this one");
        }
      }
    }
    if (threads.size > 1) throw new AmbiguousPeer(`one connection is held by processes under ${threads.size} threads`);
  }
  return threads.size === 1 ? threadPeer([...threads][0]) : deps.includeOwnerPids ? { kind: 'owner', pids } : OWNER_PEER;
}

// Asks made while one is going wait for it and then go as one, for every
// pid asked for meanwhile: the helper answers one question at a time, so
// one each per connection would let a thread queue enough to push others
// past their time (Gemini's review of finding 177), as with snapshots.
export function batched<T>(ask: (pids: number[]) => Promise<Map<number, T>>): (pids: number[]) => Promise<Map<number, T>> {
  let waiting: { pids: number[]; resolve: (m: Map<number, T>) => void; reject: (e: unknown) => void }[] = [];
  let running = false;
  const run = async () => {
    running = true;
    while (waiting.length) {
      const batch = waiting;
      waiting = [];
      try {
        const answer = await ask([...new Set(batch.flatMap((w) => w.pids))]);
        for (const w of batch) w.resolve(answer);
      } catch (e) {
        for (const w of batch) w.reject(e);
      }
    }
    running = false;
  };
  return (pids) =>
    new Promise((resolve, reject) => {
      waiting.push({ pids, resolve, reject });
      if (!running) void run();
    });
}

// The Threadbear jobs these processes are in, from the runner's helper.
const jobsOfHelper: JobsOf = batched(async (pids) => parseJobs(await win32Helper().ask('jobsOf', { pids: pids.join(',') }), pids));
const environHelper: EnvsOf = batched(async (pids) => parseEnviron(await win32Helper().ask('environ', { pids: pids.join(',') }), pids));

// The environment reader for this system: a Mac's /bin/ps, Linux's /proc,
// Windows' helper (which reads each process's environment block from its
// PEB, as a debugger does; Daybreak finding 177).
function realEnvsOf(platform: NodeJS.Platform, procRoot: string | undefined, ms: number): EnvsOf | undefined {
  if (platform === 'win32') return environHelper;
  if (platform === 'linux') return (pids) => procEnvs(pids, procRoot);
  return (pids) => psEnvs(pids, ms);
}

// A Mac's: /bin/ps for them all, never one on PATH, once with their
// environments (eww) and once without, so what's read is the environment
// alone: a key or id in a process's arguments (a prompt) isn't one. ps
// writes a line break inside a value as \012, so each process is a line of
// its own, its pid first. One of another user's, or one of Apple's own
// programs (a shell), shows no environment, and has no thread key: a
// thread's CLI is neither. ps exits 1 only when none of them is there.
export async function psEnvs(pids: number[], ms = LOOKUP_MS): Promise<Map<number, string>> {
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile('/bin/ps', [...args, '-o', 'pid=,command=', '-p', pids.join(',')], { encoding: 'utf8', timeout: ms, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err && (err as { code?: unknown }).code !== 1) reject(err);
        else resolve(stdout);
      });
    });
  const [args, both] = await Promise.all([run(['-ww']), run(['eww'])]);
  return psEnvLines(both, pids, args);
}

// From `ps eww`'s lines, each process's environment: what follows its
// arguments as `ps -ww` gave them. One whose arguments don't start its line
// (changed between the two) is read whole, which can only add marks.
export function psEnvLines(out: string, pids: number[], argsOut?: string): Map<number, string> {
  const lines = (text: string) => {
    const want = new Set(pids);
    const byPid = new Map<number, string>();
    for (const line of text.split('\n')) {
      const m = /^\s*(\d+) (.*)$/.exec(line);
      if (!m || !want.has(Number(m[1]))) continue;
      // One pid twice is a listing that can't be read as one line each.
      if (byPid.has(Number(m[1]))) throw new Error(`ps listed process ${m[1]} twice`);
      byPid.set(Number(m[1]), m[2]!);
    }
    return byPid;
  };
  const both = lines(out);
  const args = argsOut === undefined ? new Map<number, string>() : lines(argsOut);
  const envs = new Map<number, string>();
  for (const [pid, text] of both) {
    const a = args.get(pid);
    // The arguments, then a space or the end: one that grew between the two
    // looks into what follows isn't cut there.
    envs.set(pid, ' ' + (a !== undefined && text.startsWith(a) && (text.length === a.length || text[a.length] === ' ') ? text.slice(a.length) : text));
  }
  return envs;
}

// Linux's, exactly as each process got it. One the kernel won't show
// (another user's, or one that made itself undumpable, as ssh's session
// process does) reads as empty: no thread's CLI is either, and what a
// thread's own process hides is only its own environment. One that's gone
// is left out.
export async function procEnvs(pids: number[], root = '/proc'): Promise<Map<number, string>> {
  const envs = new Map<number, string>();
  for (const pid of pids) {
    try {
      envs.set(pid, '\0' + (await fs.promises.readFile(`${root}/${pid}/environ`, 'latin1')) + '\0');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') envs.set(pid, '');
    }
  }
  return envs;
}

// At most this many processes are looked at for one holder: a parent chain
// is a handful.
const MAX_LOOKED_AT = 256;

// The processes whose environments say whose a holder is: its parents up to
// launchd or init, and, for each of those, its process group's leader and
// (Linux) its session's leader with theirs, which a process that has left
// its parents behind keeps (as tb-connect's tbCaller looks). A parent the
// table hasn't got is no answer (Windows aside, which keeps dead parents'
// ids). A leader that has gone is passed over: on Linux threadOfPid has
// already refused a holder whose session's leader has gone; on a Mac
// nothing is left to say whose group it was (SECURITY.md).
export function lookedAt(start: number, table: ProcRow[], platform: NodeJS.Platform): number[] {
  const rows = new Map(table.map((r) => [r.pid, r]));
  const seen = new Set<number>();
  const windows = platform === 'win32';
  const walk = (from: number): number[] => {
    const chain: number[] = [];
    for (let p: number | undefined = from; p !== undefined && p > 1 && !seen.has(p); p = parentOf(rows, p)) {
      if (!rows.has(p)) {
        if (windows) break;
        throw new UnresolvedPeer(`process ${p}, a parent of ${from}, isn't in the process table`);
      }
      if (seen.size >= MAX_LOOKED_AT) throw new UnresolvedPeer(`more than ${MAX_LOOKED_AT} processes above ${start}`);
      seen.add(p);
      chain.push(p);
    }
    return chain;
  };
  const queue = walk(start);
  for (let i = 0; i < queue.length; i++) {
    const row = rows.get(queue[i]!)!;
    for (const leader of [row.pgid, platform === 'linux' ? row.sid : undefined]) {
      if (leader !== undefined && leader > 1 && !seen.has(leader) && rows.has(leader)) queue.push(...walk(leader));
    }
  }
  return [...seen];
}

// What the thread keys and ids in the environments above these holders
// say. A holder found under one of this runner's threads (T) is looked at
// below that thread's CLI: every key there must be T's and every id T's (or
// ones this runner was started under), so a thread of another runner nearer
// than T's CLI (a dev runner's, which T started) is turned away. A holder
// under none is looked at all the way up (lookedAt): a key this runner made
// for one of its threads makes it that thread (a process that left its
// CLI's tree with its key on it, like tb land's worker on a Mac); a key this
// runner was started under is the owner's; any other key is 'foreign'. In
// an environment with no key (a CLI from before thread keys) an id is
// foreign too, unless this runner was started under it, or the key's
// variable is there but empty and the runner is itself above the holder or
// has that thread (a
// patch's action or a worktree's setup a runner started, which may have
// left its tree, as the Land chip's tb land worker does or one under a
// draining runner; such an action is the user's, trusted to read the token
// anyway). A CLI from before thread keys has no key variable at all, so
// having its thread (a draining older runner's, a --clone-real copy's) is
// no pass for it (Gemini's third review). So is an environment with more keys or ids than any CLI's. Throws
// UnresolvedPeer when it can't say: a process it has to look at has gone,
// or the look fails or runs out of time.
async function keyedThreads(placed: { pid: number; thread?: string; below: number[] }[], envOf: EnvsOf, deps: PeerDeps, ms: number): Promise<'foreign' | Set<string>> {
  const pids = new Set<number>();
  for (const h of placed) for (const p of h.below) pids.add(p);
  const threads = new Set<string>();
  if (pids.size === 0) return threads;
  let envs: Map<number, string>;
  try {
    envs = await deadline(envOf([...pids]), ms);
  } catch (e) {
    throw new UnresolvedPeer(`could not read the environments of the processes above it: ${String(e)}`);
  }
  const own = deps.own ?? { keys: new Set<string>(), ids: new Set<string>() };
  const keyOf = deps.keyOf;
  const self = deps.self ?? process.pid;
  for (const h of placed) {
    const underSelf = h.below.includes(self);
    for (const p of h.below) {
      const text = envs.get(p);
      if (text === undefined) throw new UnresolvedPeer(`process ${p} went before its environment could be read`);
      const { keys, ids, emptyKey } = threadMarksIn(text);
      if (keys.length > MAX_KEYS || ids.length > MAX_IDS) return 'foreign';
      if (h.thread !== undefined) {
        const t = h.thread;
        if (keys.some((k) => !own.keys.has(k) && !(keyOf && sameKey(keyOf(t), k)))) return 'foreign';
        if (ids.some((id) => id !== t && !own.ids.has(id))) return 'foreign';
        continue;
      }
      const mine = new Set<string>();
      for (const key of keys) {
        const t = keyOf ? ids.find((id) => deps.known(id) && sameKey(keyOf(id), key)) : undefined;
        if (t !== undefined) mine.add(t);
        else if (!own.keys.has(key)) return 'foreign';
      }
      for (const t of mine) threads.add(t);
      // Beside a key, every id must be the key's thread's or one this runner
      // was started under: a key it was started under, inherited by another
      // runner's CLI that kept it (an older runner) beside its own thread's
      // id, is no pass (Codex's second review).
      if (keys.length) {
        if (ids.some((id) => !mine.has(id) && !own.ids.has(id))) return 'foreign';
      } else if (ids.some((id) => !own.ids.has(id) && !(emptyKey && (underSelf || deps.known(id))))) return 'foreign';
    }
  }
  return threads;
}

// The thread keys and ids this runner was started under: its own
// environment's and those of its parents (and their groups' and sessions'
// leaders). A dev runner started from a thread's shell has that thread's
// (dev-runner.sh passes its key on), and that thread is its owner: anything
// under it may use this runner as the owner, as the thread could have
// started it. A runner started by launchd, systemd or a terminal has none.
// Read once, as it starts, while its parents are still there to read; a
// look that fails leaves only its own environment's.
export async function ownThreadMarks(deps: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; table?: () => Promise<ProcRow[]>; envOf?: EnvsOf; jobsOf?: JobsOf; self?: number; log?: Logger } = {}): Promise<OwnMarks> {
  const env = deps.env ?? process.env;
  const keys = new Set<string>();
  const ids = new Set<string>();
  const add = (text: string) => {
    const m = threadMarksIn(text);
    for (const k of m.keys) keys.add(k);
    for (const i of m.ids) ids.add(i);
  };
  add(['', ...MARK_NAMES.map((n) => `${n}=${env[n] ?? ''}`), ''].join('\0'));
  const platform = deps.platform ?? process.platform;
  const jobs = new Set<string>();
  if (platform === 'win32' || deps.jobsOf) {
    try {
      const self = deps.self ?? process.pid;
      // As long as a helper starting cold gets (win32-helper.ts): read once,
      // as the runner starts, before anything waits on it.
      for (const j of (await deadline((deps.jobsOf ?? jobsOfHelper)([self]), 25_000)).get(self) ?? []) jobs.add(j);
    } catch (e) {
      deps.log?.warn("could not read the runner's own jobs", { error: String(e) });
    }
  }
  const envOf = deps.envOf ?? realEnvsOf(platform, undefined, LOOKUP_MS);
  if (!envOf) return { keys, ids, jobs };
  try {
    const table = await deadline((deps.table ?? (platform === 'linux' ? () => procTable() : platform === 'win32' ? async () => parseProcesses(await win32Helper().ask('processes')) : psTable))(), LOOKUP_MS);
    const pids = lookedAtLoosely(deps.self ?? process.pid, table);
    const envs = await deadline(envOf(pids), LOOKUP_MS);
    for (const text of envs.values()) add(text);
  } catch (e) {
    deps.log?.warn("could not read the thread keys of the runner's own parents", { error: String(e) });
  }
  return { keys, ids, jobs };
}

// The variables that mark a thread's process. The runner takes them out of
// its own environment once it has read them (main.ts), so what it starts
// without a thread's own (a schedule's check) isn't taken for the thread a
// dev runner was started under.
export const MARK_NAMES = ['THREADBEAR_THREAD_KEY', 'THREADBARE_THREAD_KEY', 'THREADBEAR_THREAD_ID', 'THREADBARE_THREAD_ID'] as const;

// The same processes lookedAt takes, without its refusals: for the runner's
// own parents, where a gap means fewer keys, never more.
function lookedAtLoosely(start: number, table: ProcRow[]): number[] {
  const rows = new Map(table.map((r) => [r.pid, r]));
  const seen = new Set<number>();
  const walk = (from: number) => {
    const chain: number[] = [];
    for (let p: number | undefined = from; p !== undefined && p > 1 && rows.has(p) && !seen.has(p) && seen.size < MAX_LOOKED_AT; p = parentOf(rows, p)) {
      seen.add(p);
      chain.push(p);
    }
    return chain;
  };
  const queue = walk(start);
  for (let i = 0; i < queue.length; i++) {
    const row = rows.get(queue[i]!)!;
    for (const leader of [row.pgid, row.sid]) if (leader !== undefined && leader > 1 && !seen.has(leader) && rows.has(leader)) queue.push(...walk(leader));
  }
  return [...seen];
}

// The thread a holder is under, and when found by its parents, the
// processes below that thread's CLI (keyedThreads looks at those); found by
// its group or session, or not at all, keyedThreads looks all the way up.
async function threadOfPid(peer: number, table: ProcRow[], deps: PeerDeps, windows: boolean): Promise<{ thread?: string; below?: number[] }> {
  const rows = new Map(table.map((r) => [r.pid, r]));
  const seen = new Set<number>();
  const below: number[] = [];
  for (let p: number | undefined = peer; p !== undefined && p > 1 && !seen.has(p); p = parentOf(rows, p)) {
    // A parent the table doesn't have: the walk can't go on, so it can't
    // say this isn't under a thread (Gemini's review of finding 175). On a
    // Mac or Linux a process whose parent has gone is given another at once;
    // Windows keeps a dead parent's id (parentOf), so there it's the end.
    if (!rows.has(p) && !windows) throw new UnresolvedPeer(`process ${p}, a parent of ${peer}, isn't in the process table`);
    seen.add(p);
    const t = await deps.registry.threadOfPid(p, rows.get(p)?.created);
    if (t && deps.known(t)) return { thread: t, below };
    below.push(p);
  }
  // Left its parents behind (a nohup or a backgrounded subshell), but still
  // in a process group a thread's tool command ran in: it, or a parent of
  // it (an orphaned helper still in that group that started it in a group
  // of its own, Gemini's review of finding 177).
  const row = table.find((r) => r.pid === peer);
  for (const p of below) {
    const group = rows.get(p)?.pgid;
    const byGroup = group ? deps.registry.threadOfGroup?.(group) : undefined;
    if (byGroup && deps.known(byGroup)) return { thread: byGroup };
  }
  // Linux: still in the session its CLI leads (the runner starts every CLI
  // in its own), even in a group of its own the registry hasn't seen yet
  // (Codex's third review of finding 175).
  if (row?.sid !== undefined && row.sid > 1 && row.sid !== peer) {
    // A session whose leader has gone can't be told from a CLI's that was
    // killed after its child left the tree: no answer (Codex's fourth review).
    if (!rows.has(row.sid)) throw new UnresolvedPeer(`process ${peer}'s session leader (${row.sid}) has gone`);
    const bySession = await deps.registry.threadOfPid(row.sid, rows.get(row.sid)?.created);
    if (bySession && deps.known(bySession)) return { thread: bySession };
  }
  return {};
}

// The parent a process really has: none when the recorded parent started
// after it did (Windows: the parent died and its id went to a newer
// process, which mustn't count as its parent).
function parentOf(rows: Map<number, ProcRow>, pid: number): number | undefined {
  const row = rows.get(pid);
  if (!row) return undefined;
  const parent = rows.get(row.ppid);
  if (row.created && parent?.created && parent.created > row.created) return undefined;
  return row.ppid;
}
