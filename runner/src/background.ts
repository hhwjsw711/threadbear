import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defaultHome, expandHome, peekRunnerJson } from './config.ts';

// Builds and tests Threadbear starts itself (the land's check, a new
// worktree's setup, turn hooks like the runner typecheck, the release
// builds) run at a lower priority than what you're doing, so a land's check
// doesn't take the Mac over: one once held Mike's M5 above load 24 for ten
// minutes (6 Nov). The agent-side hook only lowers commands an agent runs
// itself, not what the runner or `tb land` spawns; agents with no such hook
// start at a priority from it too (asAgent, below).
//
// How much lower is runner.json's `jobPriority` (or THREADBEAR_JOB_PRIORITY):
//   background  macOS's background priority, `taskpolicy -b`: efficiency
//               cores only, throttled disk. Mike's own rule for his Macs
//               ("Heavy compute" in his CLAUDE.md), so his runner.json says
//               it. Everything it starts inherits it.
//   low         `nice -n 10`, the default: full speed on an idle Mac, below
//               what you're using on a busy one.
//   normal      as it is.
// Background was everyone's default until 11 Nov. On Ville's Mac it made
// one landing take four hours: a quick check went past half an hour, and
// timing tests failed on the efficiency cores. Under nice it passed in
// under ten minutes. Without taskpolicy (Linux), background is low.
export const TASKPOLICY = '/usr/sbin/taskpolicy';
export type JobPriority = 'background' | 'low' | 'normal';
export const DEFAULT_JOB_PRIORITY: JobPriority = 'low';

export function jobPriorityOf(v: unknown): JobPriority | undefined {
  return v === 'background' || v === 'low' || v === 'normal' ? v : undefined;
}

// Read each time, so a change to runner.json needs no restart, and from
// the THREADBEAR_HOME of whoever asks (tb land in a thread has the
// runner's). An unreadable file is the default.
export function jobPriority(env: NodeJS.ProcessEnv = process.env): JobPriority {
  const fromEnv = jobPriorityOf(env.THREADBEAR_JOB_PRIORITY);
  if (fromEnv) return fromEnv;
  try {
    const home = path.resolve(expandHome(env.THREADBEAR_HOME || env.THREADBEAR_DATA_DIR || defaultHome()));
    return jobPriorityOf((peekRunnerJson(home) as { jobPriority?: unknown }).jobPriority) ?? DEFAULT_JOB_PRIORITY;
  } catch {
    return DEFAULT_JOB_PRIORITY;
  }
}

export function inBackground(
  bin: string,
  args: string[],
  opts: { platform?: NodeJS.Platform; exists?: (p: string) => boolean; priority?: JobPriority } = {},
): [string, string[]] {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? fs.existsSync;
  const priority = opts.priority ?? jobPriority();
  if (priority === 'normal' || platform === 'win32') return [bin, args];
  if (priority === 'background' && platform === 'darwin' && exists(TASKPOLICY)) return [TASKPOLICY, ['-b', bin, ...args]];
  // nice is /usr/bin/nice on macOS and every Linux; found on the PATH if not.
  return [exists('/usr/bin/nice') ? '/usr/bin/nice' : 'nice', ['-n', '10', bin, ...args]];
}

// The agents Threadbear starts besides Claude: their process, and so every
// build and test they run, starts at a priority from jobPriority. On 23 Nov
// an Antigravity review ran `swift test` on Mike's M5 with about 18
// swift-frontends at normal priority. Claude needs none of this: Mike's
// heavy-compute hook puts just the builds and tests it runs at background.
//
// One priority covers everything the agent starts, the browsers and dev
// servers too, and those break under background: a headless browser drops
// from 120 frames a second to 5, and a dev server misses Convex's one-second
// limits and fails like an app bug.
//   acp    the job priority as it is. Antigravity, Grok, OpenCode and the
//          rest have no hook at all, and their threads are mostly reviews
//          and second opinions, which run tests far more than dev servers.
//   codex  low at most. Codex threads are everyday work with dev servers and
//          browsers, and Codex reads the same hook (Mike's ~/.codex has it),
//          which puts its builds at background itself.
export type AgentKind = 'acp' | 'codex';

export function asAgent(
  kind: AgentKind,
  bin: string,
  args: string[],
  opts: { platform?: NodeJS.Platform; exists?: (p: string) => boolean; priority?: JobPriority; deferBackground?: boolean } = {},
): [string, string[]] {
  const priority = opts.priority ?? jobPriority();
  const defer = opts.deferBackground === true && kind === 'acp';
  return inBackground(bin, args, { ...opts, priority: (kind === 'codex' || defer) && priority === 'background' ? 'low' : priority });
}

export type BackgroundPidResult = 'applied' | 'skipped' | 'failed';
export type BackgroundPidOptions = {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  priority?: JobPriority;
  // Require the target process's current parent PID to match before applying
  // taskpolicy, guarding against a recycled PID if the child was reaped mid-flight.
  expectedParent?: number;
  signal?: AbortSignal;
  run?: (file: string, args: string[], o: { timeout: number; signal?: AbortSignal }) => Promise<void>;
};

// Moves an already-running process into macOS background priority (taskpolicy
// -b -p <pid>) when the job priority is background. Used for Antigravity,
// whose 171 MB Python PAR cold boot gets starved past 30 s under taskpolicy -b
// (E-cores + IOPOL_THROTTLE) while builds or runner restarts run; it spawns no
// children until session/new, so lowering it right after initialize keeps boot
// fast while still putting localharness_external and every tool it runs into
// background priority.
export async function backgroundPid(pid: number, opts: BackgroundPidOptions = {}): Promise<BackgroundPidResult> {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? fs.existsSync;
  const priority = opts.priority ?? jobPriority();
  if (priority !== 'background' || platform !== 'darwin' || !exists(TASKPOLICY)) return 'skipped';
  if (!Number.isInteger(pid) || pid <= 0) return 'skipped';
  if (opts.signal?.aborted) return 'failed';
  const run =
    opts.run ??
    ((file, args, o) =>
      new Promise<void>((resolve, reject) => {
        execFile(file, args, { timeout: o.timeout, signal: o.signal }, (err) => (err ? reject(err) : resolve()));
      }));
  const [file, args]: [string, string[]] =
    opts.expectedParent !== undefined && Number.isInteger(opts.expectedParent) && opts.expectedParent > 0
      ? ['/bin/sh', ['-c', '[ "$(/bin/ps -o ppid= -p "$1" 2>/dev/null)" -eq "$2" ] 2>/dev/null && exec /usr/sbin/taskpolicy -b -p "$1"', '_', String(pid), String(opts.expectedParent)]]
      : [TASKPOLICY, ['-b', '-p', String(pid)]];
  try {
    await run(file, args, { timeout: 10_000, signal: opts.signal });
    return 'applied';
  } catch {
    return 'failed';
  }
}

// The program a command from inBackground or asAgent runs: what the process
// is once taskpolicy or nice has exec'd it, for the process registry's
// fallback match by name (proc.ts).
export function unwrapped(command: string, args: readonly string[]): string {
  if (command === TASKPOLICY && args[0] === '-b' && args.length > 1) return args[1];
  if (command === TASKPOLICY && args[0] === '-c' && args.length > 2) return args[2];
  if (path.basename(command) === 'nice' && args[0] === '-n' && args.length > 2) return args[2];
  return command;
}
