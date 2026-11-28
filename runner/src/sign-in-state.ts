// Which Claude logins are signed out, and when each one's sign-in ends
// (docs/protocol/settings.md, Accounts, "Signed out").
//
// Claude Code 2.1.325 gives every sign-in a hard lifetime, 28 days. Past it
// the CLI refuses every turn ("this login reached its time limit and cannot
// be renewed") until someone signs in again through claude.ai's captcha, so
// only Mike can fix it. On 14 Nov claude-1 hit it: the nightly retro failed
// two nights running while list_accounts still showed it with 71% of its
// week left, and the banner didn't say which login it was.
//
// The runner asks the CLI itself, `claude auth status --json` (loggedIn and
// loginExpiresAt), which reads its own sign-in locally and quickly. Never
// the Keychain: tokens stay the CLI's business.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { onPath } from './adapters/acp/agents.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import type { Account } from './protocol.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import { yearTokenEnds } from './year-token.ts';

// How often every Claude login is asked again: often enough that signing
// one back in shows within minutes, and each ask is a fifth of a second.
export const CHECK_MS = 10 * 60_000;
// A sign-in ending within this long is ending soon: the Usage panel says so
// on its row and the Usage button gets a dot, so a scheduled job doesn't
// die overnight on it.
export const ENDING_SOON_MS = 3 * 24 * 3600_000;
const TIMEOUT_MS = 15_000;
// A refused turn on a login the CLI still calls signed in, with an end
// still ahead, holds it out of the pools this long and no longer: a
// one-off 401 mustn't keep a good login out until its end date. An ended
// sign-in needs no refusal to count (viewOf).
export const REFUSAL_HOLD_MS = 60 * 60_000;
// "Your organization has disabled Claude subscription access for Claude
// Code" or "Claude Code can't use your Claude subscription, usually because
// a payment is past due": signed in, and the CLI refuses turns because of org
// access or billing. Nothing in its profile or `auth status` says so, only a
// turn, and signing in again won't help: it's held out a day, then a turn may
// try it again.
export const ACCESS_OFF_TEXT = /disabled claude subscription access|can't use your claude subscription|payment is past due/i;
export const ACCESS_OFF_HOLD_MS = 24 * 3600_000;
// Refusals still held, kept in the data dir across restarts, and read by
// test-login.ts so the dev runner and e2e tests don't pick such a login.
export const REFUSALS_FILE = 'sign-in-refusals.json';
type Refusal = { endsAt?: number; at: number; holdMs?: number };

const holding = (r: Refusal, now: number) => now - r.at < (r.holdMs ?? REFUSAL_HOLD_MS);

// The logins a runner's refusals file still holds out.
export function heldRefusals(file: string, now: number): Set<string> {
  const saved = readJsonSync<Record<string, Refusal>>(file) ?? {};
  return new Set(Object.entries(saved).filter(([, r]) => typeof r?.at === 'number' && holding(r, now)).map(([id]) => id));
}

export type AuthStatus = { loggedIn: boolean; endsAt?: number };
type Reading = AuthStatus & { checkedAt: number };

// What an account shows (Account.signedOut and loginEndsAt).
export type SignInView = { signedOut?: true; loginEndsAt?: string };

export type AuthExec = (file: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) => Promise<string>;

// `claude auth status --json`'s answer. undefined when it isn't one.
export function parseAuthStatus(stdout: string): AuthStatus | undefined {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const o = v as { loggedIn?: unknown; loginExpiresAt?: unknown } | null;
  if (!o || typeof o.loggedIn !== 'boolean') return undefined;
  const t = typeof o.loginExpiresAt === 'string' ? Date.parse(o.loginExpiresAt) : NaN;
  return { loggedIn: o.loggedIn, ...(o.loggedIn && Number.isFinite(t) ? { endsAt: t } : {}) };
}

// A login is signed out when the CLI says so, when its sign-in has ended
// (the CLI still says loggedIn for a few hours after, on an access token
// that can't be renewed), or when a turn on it was refused lately
// (REFUSAL_HOLD_MS) and no new sign-in has been seen since.
export function viewOf(r: Reading | undefined, refused: boolean, now: number): SignInView {
  const ended = !!r && (!r.loggedIn || (r.endsAt !== undefined && r.endsAt <= now));
  const out: SignInView = {};
  if (ended || refused) out.signedOut = true;
  if (r?.loggedIn && r.endsAt !== undefined) out.loginEndsAt = new Date(r.endsAt).toISOString();
  return out;
}

function hasPathParts(file: string): boolean {
  return file.includes('/') || file.includes('\\') || /^[A-Za-z]:/.test(file);
}

// Resolve relative paths while the startup working directory still exists,
// before changing the child's working directory.
function resolveRelativePath(file: string): string {
  if (path.isAbsolute(file) || !hasPathParts(file)) return file;
  try {
    return path.resolve(file);
  } catch {
    return file;
  }
}

// Runs in an explicit existing directory (paths.run(home), or homedir as a
// fallback) so pruning an older runner release's folder from disk cannot break
// Claude Code's startup working-directory check. Bare executable names are
// resolved only against absolute PATH entries (onPath) so lookup can never
// fall through to cwd.
export function realExec(file: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
  let target = resolveRelativePath(file);
  if (!path.isAbsolute(target) && !hasPathParts(target)) {
    const found = onPath(target, env.PATH ?? process.env.PATH ?? '');
    if (!found) {
      const err = new Error(`spawn ${file} ENOENT`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      return Promise.reject(err);
    }
    target = found;
  }
  return new Promise((resolve, reject) => {
    execFile(target, args, { cwd: cwd ?? os.homedir(), env, timeout: TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout))));
  });
}

export type SignInOptions = {
  claudePath: string;
  accounts: () => Account[];
  // The environment a login's CLI runs in (cliEnv): claude-main with no
  // CLAUDE_CONFIG_DIR, the others with their folder.
  env: (account: Account) => NodeJS.ProcessEnv;
  clock: Clock;
  log: Logger;
  exec?: AuthExec;
  // Where refusals are kept (<data dir>/REFUSALS_FILE); none: memory only.
  file?: string;
  // Existing directory the CLI runs from (paths.run(home)); defaults to os.homedir().
  cwd?: string;
};

export class SignInState {
  private readings = new Map<string, Reading>();
  // A refused turn, with the sign-in's end as it was then: a reading with
  // another end is a new sign-in, and takes the refusal back.
  private refused = new Map<string, Refusal>();
  private listeners = new Set<() => void>();
  private timer?: TimerHandle;
  private running?: Promise<void>;
  private stopped = false;
  private o: SignInOptions;
  private claudePath: string;

  constructor(o: SignInOptions) {
    this.o = o;
    this.claudePath = resolveRelativePath(o.claudePath);
    const saved = o.file ? readJsonSync<Record<string, Refusal>>(o.file) : undefined;
    for (const [id, r] of Object.entries(saved ?? {})) if (typeof r?.at === 'number' && holding(r, o.clock.now())) this.refused.set(id, r);
  }

  private save(): void {
    if (!this.o.file || this.stopped) return;
    const now = this.o.clock.now();
    try {
      atomicWriteFileSync(this.o.file, JSON.stringify(Object.fromEntries([...this.refused].filter(([, r]) => holding(r, now))), null, 2) + '\n');
    } catch (e) {
      this.o.log.warn('sign-in: could not save refusals', { error: String(e) });
    }
  }

  start(): void {
    void this.checkAll();
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  view(account: Account): SignInView {
    if (account.provider !== 'claude') return {};
    const now = this.o.clock.now();
    const refusal = this.refused.get(account.id);
    return viewOf(this.reading(account), !!refusal && holding(refusal, now) && (!account.yearToken || refusal.endsAt === this.reading(account)?.endsAt), now);
  }

  // A year-long token's reading is the runner's own count: `auth status`
  // calls any token signed in, with no end (year-token.ts). A new token
  // has another end, so it takes a refusal back as a new sign-in does.
  private reading(account: Account): Reading | undefined {
    if (!account.yearToken) return this.readings.get(account.id);
    return { loggedIn: true, endsAt: yearTokenEnds(account.yearToken.madeAt), checkedAt: this.o.clock.now() };
  }

  // A turn on this login failed with its login refused: it counts as signed
  // out now (for holdMs, REFUSAL_HOLD_MS when not given), and the CLI is
  // asked again for its end date.
  noteRefused(accountId: string, holdMs?: number): void {
    const account = this.o.accounts().find((a) => a.id === accountId);
    const before = account ? JSON.stringify(this.view(account)) : '';
    const endsAt = account ? this.reading(account)?.endsAt : this.readings.get(accountId)?.endsAt;
    this.refused.set(accountId, { ...(endsAt !== undefined ? { endsAt } : {}), at: this.o.clock.now(), ...(holdMs ? { holdMs } : {}) });
    this.save();
    // The sweep every CHECK_MS tells listeners when the hold runs out.
    if (account && JSON.stringify(this.view(account)) !== before) this.changed();
    if (account?.provider === 'claude') void this.queue(() => this.check(account));
  }

  // A turn on it went through: whatever refused it before is over.
  noteWorked(accountId: string): void {
    if (!this.refused.delete(accountId)) return;
    this.save();
    this.changed();
  }

  // Asked now rather than at the next sweep: the app's Sign in… has just
  // run Terminal on a login's sign-in (accounts.recheck), and the setup
  // card spins until the runner sees it. One login, or every Claude one.
  async checkNow(accountId?: string): Promise<void> {
    const list = this.o.accounts().filter((a) => a.provider === 'claude' && (accountId === undefined || a.id === accountId));
    await this.queue(async () => {
      for (const a of list) {
        if (this.stopped) return;
        await this.check(a);
      }
    });
  }

  // Every Claude login, one after another, then again in CHECK_MS. A
  // passing end date is a change even with no new reading, so the timer
  // also tells listeners when the views differ.
  async checkAll(): Promise<void> {
    this.timer?.cancel();
    this.timer = undefined;
    const before = this.viewsKey();
    await this.queue(async () => {
      for (const a of this.o.accounts().filter((x) => x.provider === 'claude')) {
        if (this.stopped) return;
        await this.check(a, false);
      }
    });
    if (this.viewsKey() !== before) this.changed();
    if (!this.stopped) this.timer = this.o.clock.setTimeout(() => void this.checkAll(), CHECK_MS);
  }

  private viewsKey(): string {
    return JSON.stringify(this.o.accounts().map((a) => [a.id, this.view(a)]));
  }

  // One ask at a time, so a refusal during the sweep doesn't run two CLIs.
  private queue(fn: () => Promise<void>): Promise<void> {
    const next = (this.running ?? Promise.resolve()).then(fn, fn);
    this.running = next.catch(() => {});
    return next;
  }

  private async check(account: Account, tell = true): Promise<void> {
    if (this.stopped) return;
    // The CLI would only say "signed in" for a token (reading()).
    if (account.yearToken) return;
    let status: AuthStatus | undefined;
    try {
      status = parseAuthStatus(await (this.o.exec ?? realExec)(this.claudePath, ['auth', 'status', '--json'], this.o.env(account), this.o.cwd));
    } catch (e) {
      if (!this.stopped) this.o.log.warn('sign-in: could not ask the CLI', { accountId: account.id, error: String(e) });
      return;
    }
    if (this.stopped || !status) return;
    const before = JSON.stringify(this.view(account));
    this.readings.set(account.id, { ...status, checkedAt: this.o.clock.now() });
    // A new sign-in takes a refusal back: another end than the one known
    // when it was refused. With none known then, nothing says it's new, so
    // the refusal holds its hour (else a pool thread bounces back onto it).
    const was = this.refused.get(account.id)?.endsAt;
    if (was !== undefined && status.loggedIn && status.endsAt !== undefined && status.endsAt > this.o.clock.now() && status.endsAt !== was) {
      this.refused.delete(account.id);
      this.save();
    }
    if (tell && JSON.stringify(this.view(account)) !== before) this.changed();
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        this.o.log.warn('sign-in: a listener failed', { error: String(e) });
      }
    }
  }
}

// A login's sign-in in a few words, for list_accounts: "signed out, only
// Mike can sign it in again", "sign-in ends Tue 6 pm", or '' when there's
// nothing to say (more than ENDING_SOON_MS left).
export function signInWords(a: Pick<Account, 'signedOut' | 'loginEndsAt' | 'planEnded'>, now: number, when: (iso: string, now: number) => string): string {
  // Signing in again wouldn't help: the plan has no Claude Code.
  if (a.planEnded) return 'its paid plan has ended (free plan, no Claude Code), so pools skip it';
  if (a.signedOut) return 'signed out: only the user can sign it in again, and pools skip it';
  const t = a.loginEndsAt ? Date.parse(a.loginEndsAt) : NaN;
  if (Number.isFinite(t) && t - now < ENDING_SOON_MS) return `sign-in ends ${when(a.loginEndsAt!, now)}, then it needs the user to sign in again`;
  return '';
}
