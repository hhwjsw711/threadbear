// What a thread is told when the runner carries on a turn that was cut off
// (a restart, a login out of room, the network), and when it stops background
// work. Split out of runner.ts (24 Nov 2026) so its parts under runner/ can use
// them without importing runner.ts back (mikecann-lint's no-import-cycle).
import type { MessageOrigin } from '../protocol.ts';
import { cutSafely } from '../safe-cut.ts';

// A wait started again can be stopped again by the next landing, so this
// many wakes in a row at most, reset by anyone else writing to the thread.
export const STOPPED_WORK_WAKES = 3;
// A runner that was away this long (a Mac left off for days) shouldn't wake
// every thread that had something going when it went.
export const STOPPED_WORK_WAKE_MAX_AGE_MS = 24 * 60 * 60_000;

export function stoppedWorkMessage(what: string[], last: boolean): string {
  const one = what.length === 1;
  const lines = what.map((w) => `- ${cutSafely(w, 203, '...')}`);
  return [
    `Threadbear stopped ${one ? 'this background job' : 'these background jobs'} of yours when the runner restarted onto a new release, so nothing more will come from ${one ? 'it' : 'them'}:`,
    '',
    ...lines,
    '',
    `If you said you'd report back or carry on after ${one ? 'it' : 'them'}, check how far ${one ? 'it' : 'they'} got and do that now; work running elsewhere may have finished by itself. Start ${one ? 'it' : 'them'} again only if that's still needed. An update only holds background work for about 4 hours past your last turn, so for a longer wait use schedule_message to come back and check. If it no longer matters, say so in a line.`,
    ...(last ? ['', "Threadbear won't wake this thread for this again, so if the user needs to step in, ask them in end_turn."] : []),
  ].join('\n');
}

// The runner's nudge for such a shell is marked by its wake reason, which
// the queued message keeps across a handover (Runner.withdrawNudge).
export const UNREAD_SHELLS_WAKE = 'Its background shell ended';
export function isUnreadShellsNudge(msg: { origin?: MessageOrigin; wakeReason?: string }): boolean {
  return msg.origin === 'runner' && msg.wakeReason === UNREAD_SHELLS_WAKE;
}

// When the CLI never started its own turn for a shell the last turn ended
// waiting on (Runner.nudgeUnreadShells).
export function unreadShellsMessage(count: number, what: string[], last: boolean): string {
  const one = count <= 1;
  const lines = what.map((w) => `- ${cutSafely(w, 203, '...')}`);
  return [
    `${one ? 'A background shell' : 'Background shells'} you ended your last turn waiting on ${one ? 'has' : 'have'} finished, but you weren't woken to read ${one ? 'its' : 'their'} result${lines.length ? ':' : '.'}`,
    ...(lines.length ? ['', ...lines] : []),
    '',
    `Read ${one ? 'its' : 'their'} output now and carry on from where you left off. A shell can also have been stopped by its time limit, so check whether the work it ran finished by itself before running it again. End with end_turn when you're done or need the user.`,
    ...(last ? ['', "Threadbear won't wake this thread for this again, so if the user needs to step in, ask them in end_turn."] : []),
  ].join('\n');
}

// The runner's own message carrying on a turn that was cut off (CARRY_ON_*
// below): the same work going on, not a new message to the thread.
export function isCarryOn(msg: { text: string; origin?: MessageOrigin }): boolean {
  if (msg.origin !== 'runner') return false;
  return [CARRY_ON_SIGNED_OUT, CARRY_ON_MOVED, CARRY_ON_RESTART, CARRY_ON_NETWORK, CARRY_ON_TOKEN, CARRY_ON_BACK, CARRY_ON_HELPER_RESTART].includes(msg.text)
    || msg.text.startsWith(CARRY_ON_HELPER_RESTART + '\n\n');
}

// What the agent is told when Mike writes a message while its question or
// approval card is still open (sendTo).
export const WROTE_INSTEAD = "The user didn't answer this; they wrote you a message instead, which comes next. Read it before asking again.";

// What a pool thread is told when it carries on by itself after its login
// ran dry (docs/protocol/settings.md, "Pools").
export const CARRY_ON_SIGNED_OUT = 'Your last login was signed out, so this thread has moved to another one. Carry on from where you left off.';
export const CARRY_ON_MOVED = 'Your last login hit its usage limit partway through that turn, so this thread has moved to another one. Carry on from where you left off.';
export const CARRY_ON_RESTART = 'The runner stopped partway through that turn (Threadbear or the Mac restarted) and is back now. Carry on from where you left off.';
// A project coordinator's hidden helper cut off by a restart, which the
// runner carries on itself rather than waking its coordinator (coordinators.ts).
export const CARRY_ON_HELPER_RESTART = "The runner restarted partway through that turn (a Threadbear update, or the Mac restarting) and is back now. Carry on with your brief from where you left off. Check what's already done first (commits, pushes, merges, deploys, messages sent) and don't repeat a send, merge, release or deploy that already happened.";
// Past this, a cut-off turn is left for Mike: the Mac was off for a while,
// and he may have moved on.
export const STOPPED_CARRY_ON_MAX_AGE_MS = 12 * 3_600_000;
export const CARRY_ON_NETWORK = "The connection to the API dropped partway through that turn and is back now. Carry on from where you left off.";
// How a thread waits for the network: probes 5s, 10s, 20s... apart, at
// most a minute; a carry-on that can't get through either counts as a
// try; after five, or six hours from the first failure, it's left to Mike.
export const NET_PROBE_FIRST_MS = 5_000;
export const NET_PROBE_MAX_MS = 60_000;
export const NET_CARRY_ON_MAX = 5;
export const NET_WAIT_MAX_MS = 6 * 3_600_000;
// A box's thread, after its refused cloud token was replaced (holdForToken).
export const CARRY_ON_TOKEN = "This machine's Claude token was refused partway through that turn, and a new one has been set. Carry on from where you left off.";
export const CARRY_ON_BACK = 'Your login hit its usage limit partway through that turn and has room again now. Carry on from where you left off.';
