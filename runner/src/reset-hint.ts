// When to tell Mike about a login's usage resets (docs/protocol/settings.md,
// Pools, "Telling Mike about resets"). On 26 Nov 2026 his gmail Codex login
// sat at 0% on every machine for days with 2 resets unused: only a stopped
// thread's limit box offered one, and resets expire a month after they're
// granted. This is the one place the rule lives; the apps, the phone, the
// website and `tb accounts` draw what it says. It never spends a reset:
// only Mike's click does (accounts.useReset).
import type { Account, AccountUsage, Provider, ResetHint } from './protocol.ts';

// Out of room: under this in a window, usage.ts's MIN_ROOM_PERCENT, the
// floor pools skip a login at (not imported, as usage.ts imports this).
const OUT_PERCENT = 1;

// How close to expiring a reset has to be before it's worth a nudge.
export const RESET_EXPIRING_MS = 3 * 24 * 60 * 60_000;
// And how little of the week has to be left for using it then to gain
// something: under this, a reset buys back at least 30% of a week.
export const RESET_WORTH_PERCENT = 70;

export function resetHint(account: Pick<Account, 'usage' | 'signedOut' | 'planEnded'>, now: number): ResetHint | undefined {
  if (account.signedOut || account.planEnded) return undefined;
  const usage = account.usage;
  const resets = usage?.resets;
  if (!usage || !resets || !(resets.available > 0)) return undefined;
  const expires = resets.nextExpiresAt ? Date.parse(resets.nextExpiresAt) : NaN;
  // One that has expired since it was read can't be counted on.
  if (Number.isFinite(expires) && expires <= now) return undefined;
  const hint = (why: ResetHint['why']): ResetHint => ({ why, available: resets.available, ...(resets.nextExpiresAt ? { nextExpiresAt: resets.nextExpiresAt } : {}) });
  if (isOut(usage, now)) return hint('out');
  const week = usage.windows.find((w) => w.kind === 'weekly');
  if (Number.isFinite(expires) && expires - now <= RESET_EXPIRING_MS && week && roomNow(week, now) < RESET_WORTH_PERCENT) return hint('expiring');
  return undefined;
}

// Blocked, or under the floor in its 5-hour or weekly window. A window
// whose reset has passed is full again.
function isOut(usage: AccountUsage, now: number): boolean {
  if (usage.blocked) return true;
  return usage.windows.some((w) => (w.kind === 'five_hour' || w.kind === 'weekly') && roomNow(w, now) < OUT_PERCENT);
}

function roomNow(w: { remainingPercent: number; resetsAt?: string }, now: number): number {
  return w.resetsAt && Date.parse(w.resetsAt) <= now ? 100 : w.remainingPercent;
}

// The moments the hint can change with no new reading: when the soonest
// reset comes within RESET_EXPIRING_MS of expiring, and when it expires.
export function resetHintTimes(usage: AccountUsage | undefined): number[] {
  const at = usage?.resets?.nextExpiresAt ? Date.parse(usage.resets.nextExpiresAt) : NaN;
  return Number.isFinite(at) ? [at - RESET_EXPIRING_MS, at] : [];
}

// "2 resets left, the next expires Tue 1 Dec": the hint in words, for tb
// and list_accounts. `when` formats a time as the caller's other lines do.
export function resetHintWords(hint: ResetHint, when: (iso: string) => string): string {
  const count = `${hint.available} ${hint.available === 1 ? 'reset' : 'resets'} left`;
  const expires = hint.nextExpiresAt ? `, the next expires ${when(hint.nextExpiresAt)}` : '';
  return hint.why === 'expiring' ? `${count}${expires}: worth using one before it's lost` : `${count}${expires}: use one to carry on now`;
}

export function unsupportedResetMessage(provider: Provider): string {
  return provider === 'claude'
    ? 'To use a Claude reset, open https://claude.ai/settings/usage and choose Reset for free.'
    : 'Threadbear can only redeem Codex resets here.';
}
