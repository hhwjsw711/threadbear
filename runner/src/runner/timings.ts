// How long the runner waits for things: draining for an update, patches,
// live state and hooks. Split out of runner.ts (24 Nov 2026) so its parts
// under runner/ can read them without importing runner.ts back
// (mikecann-lint's no-import-cycle).

// How often a draining runner looks again at threads it keeps for
// background work, since that work's limit passes without an event.
export const DRAIN_CHECK_MS = 5000;
// How long background shells and monitors hold a kept thread after its last
// turn. Most are waits that end by themselves, and the runner updates after
// every landing: at 30 minutes, nearly every long wait was cut off (1 Nov:
// a scan's wait, 4.5 hours of silence). A dev server does sit out the limit,
// but that costs one old runner process, and only one per thread that has
// work going, since a kept thread doesn't get kept again.
export const DRAIN_BACKGROUND_MS = 4 * 60 * 60_000;
// A thread in use never reaches that limit, and would stay on the old release
// for as long as its dev server ran. Past this long there, it goes across
// after a much shorter quiet spell.
export const DRAIN_MAX_OLD_MS = 12 * 60 * 60_000;
export const DRAIN_SETTLE_MS = 30 * 60_000;
// How long subagents hold a kept thread after its last turn. Long, since
// they end by themselves; only a stuck one should ever reach it.
export const DRAIN_AGENT_MS = 4 * 60 * 60_000;
// How long a kept thread may sit on an open card (approval, question,
// secret) with nothing else going before the card lapses and the thread
// goes across, told to ask again there. Without it a card nobody answered
// held an old runner open for good (26 Nov 2026: two Sentry triage threads
// kept two for 9 and 11 hours). Long enough for Mike to come back from a
// break and answer it where it is.
export const DRAIN_CARD_WAIT_MS = 30 * 60_000;
// How soon a thread.json that failed to save is tried again. Until it's
// saved, a crash or a handover would lose what changed (THREADBEAR-9).
export const SAVE_RETRY_MS = 5000;

// How long a thread's patches are kept before the folder is read again.
export const PATCHES_TTL_MS = 15_000;
// How long a folder listing (and a patch file's time, a .env) read for one
// thread's patches serves every other thread in the same folders
// (folder-cache.ts). A turn ending forgets them, as it may have added one.
export const FOLDER_CACHE_MS = 10_000;
// How often a thread whose patches have live state (when, badge) has it
// read again by itself, while it's in the inbox: comments Mike leaves in
// Tandem turn into a "Your turn" chip within this long.
export const LIVE_POLL_MS = 20_000;
// How long a live state command's output serves every thread in the same
// folder (runLiveCommand): well inside one poll, so each poll runs it again.
export const LIVE_SHARE_MS = 10_000;

// How many turns in a row one hook may start with its result.
export const HOOK_TELL_LIMIT = 2;
// How much of a hook's output goes to the agent (the transcript has it all).
export const HOOK_TELL_CHARS = 8000;
// snoozedUntil for a thread hibernating until the runner next starts: far
// enough off that everything reading snoozedUntil (the lists, the resume
// after a restart, a client older than snoozedUntilRestart) sees it as
// snoozed, and start() wakes it long before.
export const UNTIL_RESTART = '9999-12-31T00:00:00.000Z';
// snoozedUntil for a thread waiting on a topic alone (wake-when.ts), or
// while its time is worked out: the same far-off time, without the flag.
export const NO_WAKE_TIME = UNTIL_RESTART;
