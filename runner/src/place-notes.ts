// The grey lines a thread's transcript gets when it's put away or brought
// back: hibernated, woken, archived, unarchived, or moved under Hibernating
// because a schedule will message it. Each says who did it, when, and why,
// so a thread found under Hibernating or Archived explains itself (Mike,
// 24 Nov 2026: the Omi thread sat under Hibernating with nothing in it to
// say a check-in booked for 9:45 pm had put it there).
//
// The app never folds these into a turn's work (RowContent::is_place_note
// in desktop/core, which knows them by how they start: keep it in step with
// PLACE_NOTE_STARTS below), and the phones get them as note rows (sync.ts,
// toMessageDoc), so a thread found under Hibernating or Archived on the
// phone explains itself too (Ville's fork, 23 Nov 2026).
//
// The moves an agent's own end_turn makes (snooze, waitFor, archive) and the
// ones Threadbear makes by itself (the quiet inbox, a wake) already write
// their own line with more detail; these cover the rest.
import type { ArchivedBy } from './protocol.ts';

// How a place note starts: the same list as RowContent::is_place_note.
const PLACE_NOTE_STARTS = ['Archived', 'Brought back', 'Back in the archive', 'Back in the inbox', 'Hibernated ', 'Hibernating until', 'Not hibernated', 'Woken ', 'Moved to Hibernating'];

export function isPlaceNote(text: string): boolean {
  return PLACE_NOTE_STARTS.some((s) => text.startsWith(s));
}

// "Tue 24 Nov, 3:32 pm": short, as these lines sit between messages.
export function shortWhen(t: number, timeZone: string): string {
  const d = new Date(t);
  const day = d.toLocaleDateString('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  const time = d.toLocaleTimeString('en-GB', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s?([ap])\.?m\.?/i, ' $1m');
  return `${day}, ${time}`;
}

type Who = 'mike' | 'agent' | 'threadbear';

function byWho(who: Who): string {
  return who === 'mike' ? 'by you' : who === 'agent' ? 'by an agent' : 'by Threadbear';
}

// `until`: an ISO time, 'restart' or 'release'.
export function hibernatedNote(o: { who: Who; until: string; now: number; timeZone: string }): string {
  const till = o.until === 'restart' ? 'until the runner next starts'
    : o.until === 'release' ? 'until the runner starts on a new release'
      : `until ${shortWhen(Date.parse(o.until), o.timeZone)}`;
  return `Hibernated ${byWho(o.who)} on ${shortWhen(o.now, o.timeZone)}, ${till}.`;
}

export function wokenNote(o: { who: Who; now: number; timeZone: string }): string {
  return `Woken ${byWho(o.who)} on ${shortWhen(o.now, o.timeZone)}.`;
}

export function archivedNote(o: { by: ArchivedBy; now: number; timeZone: string; why?: string }): string {
  return `Archived ${byWho(o.by)} on ${shortWhen(o.now, o.timeZone)}${o.why ? `: ${o.why}` : ''}.`;
}

export function unarchivedNote(o: { who: Who; now: number; timeZone: string; why?: string }): string {
  return `Brought back from the archive ${byWho(o.who)} on ${shortWhen(o.now, o.timeZone)}${o.why ? `: ${o.why}` : ''}.`;
}

// The quiet inbox's own (experiment quietInboxMine, runner/inbox-guess.ts):
// named, so Mike knows what moved it, with the model's reason. Hovering a
// line naming Quiet inbox says what it is (the app's QUIET_INBOX_TIP).
// `model`: who judged, Opus or Codex answering for it (inbox-guess.ts, decides).
export function quietArchivedNote(o: { why: string; now: number; timeZone: string; model?: string }): string {
  return `Archived by Quiet inbox on ${shortWhen(o.now, o.timeZone)}: it finished with nothing for you, and ${o.model ?? 'Opus'} judged you didn't need to see it. ${o.why}`;
}

// Idle with nothing for Mike and a schedule booked: the sidebar puts it
// under Hibernating (wait-state.ts, scheduled) without any snooze.
export function scheduledNote(o: { title?: string; next?: number; now: number; timeZone: string }): string {
  const what = o.title?.trim() ? ` for "${o.title.trim()}"` : '';
  const when = o.next ? ` on ${shortWhen(o.next, o.timeZone)}` : '';
  return `Moved to Hibernating on ${shortWhen(o.now, o.timeZone)}: nothing needs you, and a schedule brings it back${when}${what}.`;
}

// Its schedule was paused, finished or deleted while it sat under
// Hibernating for it.
export function unscheduledNote(o: { now: number; timeZone: string }): string {
  return `Back in the inbox on ${shortWhen(o.now, o.timeZone)}: no schedule is booked for it any more.`;
}
