// The runner's helper process on Windows: one hidden powershell.exe running
// win32-helper.ps1, kept for the runner's life, that answers what ps and
// lsof answer on a Mac (docs/gpui-port/runner-windows-plan.md, slice 5).
// A fresh powershell.exe for each question took 1.5 to 2.5 s on the Dell
// (18 Nov), longer than a connection can wait; this one answers a question
// in 100 to 250 ms once it's up.
//
// It starts on the first question. A question that gets no answer in time
// fails, and the helper is stopped and started again for the next, so a
// stuck PowerShell can't hold the runner up. Answers come back in order,
// one line each.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const HELPER_SCRIPT = path.join(import.meta.dirname, 'win32-helper.ps1');

// The script as the runner found it when it started, never run from the
// file: a thread that rewrote the file and then stopped the helper would
// otherwise get its own script started in its place, answering every
// question with "nobody" (Codex's review, 18 Nov 2026). It goes whole as
// the helper's first line on stdin (UTF-8 in base64), to a loader passed as
// -EncodedCommand (UTF-16LE in base64): the script itself passed that way
// grew past what a Windows command line holds (spawn ENAMETOOLONG, 18 Nov).
// PowerShell by its full path, for the same reason as the rest: started by
// name, Windows looks in the runner's own folder first.
let script: string | undefined;
function helperScript(): string {
  return (script ??= Buffer.from(fs.readFileSync(HELPER_SCRIPT, 'utf8'), 'utf8').toString('base64'));
}
const LOADER = "$s = [Console]::In.ReadLine(); . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))))";
function helperArgs(): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(LOADER, 'utf16le').toString('base64')];
}

// THREADBEAR_NO_POWERSHELL=1 makes it a path that isn't there, for tests of
// a machine where PowerShell can't run (test/helpers/platform.ts,
// withoutPowerShell). It can only turn PowerShell off, never point it at
// another program.
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.THREADBEAR_NO_POWERSHELL === '1') return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'no-powershell', 'powershell.exe');
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Read now, as the runner starts (main.ts asks its first question then,
// and imports this before any thread runs).
if (process.platform === 'win32') {
  try {
    helperScript();
  } catch {
    // no script: every question fails, and the lookup with it
  }
}

export type HelperDeps = {
  // What to start: tests pass a stand-in that speaks the same lines.
  command?: string;
  args?: string[];
  timeoutMs?: number;
  // For questions asked before a new helper has answered anything: PowerShell
  // starting and importing its modules took over 5 s on GitHub's Windows
  // machines (18 Nov).
  startTimeoutMs?: number;
};

type Pending = { resolve: (text: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class Win32Helper {
  private child?: ChildProcess;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private deps: HelperDeps;
  // Whether the running helper has answered yet.
  private warm = false;

  constructor(deps: HelperDeps = {}) {
    this.deps = deps;
  }

  private start(): ChildProcess {
    const command = this.deps.command ?? powershellPath();
    const args = this.deps.args ?? helperArgs();
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child = child;
    child.stdin?.on('error', () => {
      // EPIPE when PowerShell has already gone; the exit handler reports it.
    });
    // The real helper's script, ahead of any question (a stand-in has its own).
    if (!this.deps.args) {
      try {
        child.stdin!.write(helperScript() + '\n');
      } catch {
        // no script: the loader ends, and every question fails with it
      }
    }
    this.warm = false;
    readline.createInterface({ input: child.stdout! }).on('line', (line) => this.answer(line));
    // Only the current helper's end fails what's waiting: one stopped for
    // being slow exits after its replacement has been asked something.
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.failAll(new Error(why));
    };
    child.on('error', (e) => gone(`the helper couldn't start: ${e.message}`));
    child.on('exit', (code) => gone(`the helper exited (${code})`));
    // Not what keeps the runner alive.
    child.unref();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
    return child;
  }

  private answer(line: string): void {
    let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(line.replace(/^﻿/, ''));
    } catch {
      return;
    }
    this.warm = true;
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id as number);
    clearTimeout(p.timer);
    if (msg.ok === true) p.resolve(typeof msg.result === 'string' ? msg.result : '');
    else p.reject(new Error(`the helper said: ${String(msg.error ?? 'no reason')}`));
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  // One question, answered as text.
  ask(op: string, params: Record<string, string | number> = {}): Promise<string> {
    const child = this.child ?? this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the helper didn't answer ${op} in time`));
        // Stuck or too slow: the next question gets a new one.
        this.stop();
      }, this.warm ? (this.deps.timeoutMs ?? 5000) : (this.deps.startTimeoutMs ?? Math.max(20_000, this.deps.timeoutMs ?? 0)));
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ id, op, ...params }) + '\n');
    });
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.failAll(new Error('the helper was stopped'));
    child?.kill();
  }
}

// Every process: its pid, its parent's and when it started (a FILETIME, 100
// ns since 1601 UTC, 0 when Windows won't say).
export type WinProcess = { pid: number; ppid: number; created: bigint };

export function parseProcesses(text: string): WinProcess[] {
  const rows: WinProcess[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: BigInt(m[3]!) });
  }
  return rows;
}

// environ's answer (peer.ts): each process's environment as text, its
// entries between NULs with one in front (as Linux's are read), or '' for
// one Windows won't let this user read (another user's, an elevated or
// protected process: none is a thread's CLI, which runs as the runner
// does). One that has gone, or isn't in the answer, is left out.
export function parseEnviron(text: string, pids: number[]): Map<number, string> {
  const want = new Set(pids);
  const envs = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([exg]) (\d+)(?: ([A-Za-z0-9+/=]*))?\s*$/.exec(line);
    if (!m || !want.has(Number(m[2]))) continue;
    const pid = Number(m[2]);
    if (envs.has(pid)) throw new Error(`the helper named process ${pid} twice`);
    if (m[1] === 'x') envs.set(pid, '');
    // The block ends at its first empty entry: what follows in the
    // allocation can be what was there before a variable was removed.
    else if (m[1] === 'e') envs.set(pid, '\0' + Buffer.from(m[3] ?? '', 'base64').toString('utf16le').split('\0\0')[0] + '\0');
  }
  return envs;
}

// jobsOf's answer (peer.ts): the Threadbear jobs each process is in, by
// their full names (Local\threadbear-job-<hex>). One that couldn't be
// opened even to ask its session (which Windows allows for any process of
// this user, elevated or protected, so it's one that denied it to itself:
// Codex's and Gemini's reviews), has gone, isn't in the answer, or names
// something that isn't a job's name, is left out: no answer.
export function parseJobs(text: string, pids: number[]): Map<number, string[]> {
  const want = new Set(pids);
  const jobs = new Map<number, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([jxg]) (\d+)(?: (\S+))?\s*$/.exec(line);
    if (!m || !want.has(Number(m[2]))) continue;
    const pid = Number(m[2]);
    if (jobs.has(pid)) throw new Error(`the helper named process ${pid} twice`);
    if (m[1] !== 'j') continue;
    const names = m[3] ? m[3].split(',') : [];
    if (!names.every((n) => /^threadbear-job-[0-9a-f]{32}$/.test(n))) continue;
    jobs.set(pid, names.map((n) => `Local\\${n}`));
  }
  return jobs;
}

// A snapshot's answer: each connection's client end (its own address and
// port, the server's, and the pid holding it), and every process.
export type WinConnection = { localAddress: string; localPort: number; remoteAddress: string; remotePort: number; pid: number };

export function parseSnapshot(text: string): { connections: WinConnection[]; processes: WinProcess[] } {
  const connections: WinConnection[] = [];
  const processes: WinProcess[] = [];
  for (const line of text.split(/\r?\n/)) {
    const c = /^c (\S+) (\d+) (\S+) (\d+) (\d+)\s*$/.exec(line);
    if (c) connections.push({ localAddress: c[1]!, localPort: Number(c[2]), remoteAddress: c[3]!, remotePort: Number(c[4]), pid: Number(c[5]) });
    const p = /^p (\d+) (\d+) (\d+)\s*$/.exec(line);
    if (p) processes.push({ pid: Number(p[1]), ppid: Number(p[2]), created: BigInt(p[3]!) });
  }
  return { connections, processes };
}

// Windows names an IPv4-mapped address as plain IPv4 (Node's dual-stack form
// is ::ffff:127.0.0.1).
export function winAddress(addr: string): string {
  return addr.startsWith('::ffff:') && addr.includes('.') ? addr.slice(7) : addr;
}

let shared: Win32Helper | undefined;

// The runner's one helper.
export function win32Helper(): Win32Helper {
  return (shared ??= new Win32Helper());
}
