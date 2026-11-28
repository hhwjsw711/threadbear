// Other runners' threads through the backend (docs/protocol/runners.md, "Other
// runners' threads through the backend"; full Convex step 5). The Mac app
// asks its own runner about another runner's thread as it would about one of
// this runner's, and this answers from the backend: the thread's message rows
// become transcript events, and what the app does to it (send, approve, stop,
// archive) goes to that runner as a `commands` row, as the phone's does. The
// app needs no Convex of its own and no link to the other Mac.
//
// The backend has a thread's text, one line per tool call, its open approval
// and its card. A tool row's result says the output is kept on that runner, and
// carries `heldBack: { seq }`: opening that tool in the app asks for it
// (threads.heldBody), and if that runner has full sync on (docs/archive/full-convex.md
// step 4) its output comes from the backend, once, as more events for the row.
//
// Pictures. That runner puts the pictures pasted into its messages up for
// the phone and the website (sync.ts, replyImages), and a message's row says
// how many it came with (`pictures`, API 87; an older runner's only by its
// words, pictures.ts picturesSaid). With a backend of MESSAGE_PICTURES_API or
// later the relay reads them (relay:picturesAtSeqs): the message's `images`
// are those pictures in order, each with its path on that Mac, and one not up
// yet has a place of its own (notUpPath). `files.read` with that runner's id
// and one of those paths answers with the file's bytes from file storage
// (readFile). A message is never held back for its pictures, which land
// after its row: a new one's are watched for PICTURE_WAIT_MS, and the app's
// read of one waits for it meanwhile.
//
// Seqs. The rows' seqs are the other runner's event seqs, with gaps where
// events weren't mirrored. Each row's seq s becomes eight here: 8s a
// turn.started, 8s+1 the row's own event, 8s+2 a tool's result, 8s+3 and
// 8s+4 a card from an older runner that didn't say its seq (placed after the
// newest row when first seen) and its answer (or else a fetched tool's diffs),
// 8s+5 and 8s+6 a fetched tool's real call and result, 8s+7 its turn's end. A card
// whose event seq p is known goes at 8p+1 and its answer at 8p+2 (p is never
// a row's seq). So events made up from a row sit right beside it and stay in
// order, and every one has a seq of its own. The app takes these threads' events with gaps
// and late ones (ThreadFeed's sparse mode), and pages by these seqs.
//
// Reads (docs/convex-backend.md, "Read rules"): a thread is watched only while
// an app has it subscribed, through a 15-row tail and its one threads row;
// older rows are read once by page and kept here, and a tail that skips past
// what's held reads the gap once rather than leave a hole.
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import type { Notification } from './runner.ts';
import type { RemoteThread, RemoteThreads } from './thread-index.ts';
import type { Download, Post, Subscribe, Upload } from './sync.ts';
import { picturesSaid, withoutCountLine } from './pictures.ts';
import { EFFORT_LEVELS, ErrorCode, RpcError, isEffortLevel, remoteCreateMode, type Account, type AskAnswer, type LabReviewLedger } from './protocol.ts';
import { seal } from './secrets.ts';

export const SCALE = 8;
// The greatest seq a row may have (the backend's MAX_SEQ, convex/lib.ts):
// times SCALE, plus the few added to it, still a whole number JSON and a
// double carry exactly.
export const MAX_RELAY_SEQ = 2 ** 49;

/** A row's seq is a whole number from 0 to MAX_RELAY_SEQ: anything else a runner key wrote (NaN, an infinity, a fraction) would break the order and the event ids made from it. */
export function isRelaySeq(n: unknown): n is number {
  return Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= MAX_RELAY_SEQ;
}

// A page with only the rows whose seq is one (isRelaySeq): one bad row
// leaves the rest of the thread showing (Daybreak, 15 Nov 2026). The backend
// stores none since then; this is for older rows, and older backends.
function wellFormed(p: Page): Page {
  const messages = Array.isArray(p?.messages) ? p.messages.filter((m) => isRelaySeq(m?.seq)) : [];
  return { messages, hasMore: p?.hasMore === true };
}
// The thread's row says it has stopped a moment before its last messages
// arrive (the other runner writes rows, then messages): its turn ends only
// once it has said so for this long.
const SETTLE_MS = 4000;
const TAIL = 15;
// How long a change made from here outranks the other runner's row in
// replies (Relay.changed): the row catches up within seconds.
const CHANGED_MS = 60_000;
// Reading a shared thread's link from its row: an older runner writes the
// row with its next batch rather than at once.
const SHARE_READS = 5;
const SHARE_READ_MS = 1000;
// Hibernating until that runner restarts (runner.ts's UNTIL_RESTART, not
// imported so this module doesn't load the whole runner).
const UNTIL_RESTART = '9999-12-31T00:00:00.000Z';
// Hibernated in words on that runner, its time not yet on the row (threads.hibernateWhen):
// shown put away, and satisfied by any snoozed row.
const PUT_AWAY = 'put-away';
const PAGE = 50;
// The most rows held for one thread. Past it the oldest go, and scrolling
// back reads them again. Another runner writes its thread's rows, and can
// write tens of thousands of tiny ones within its backend budget; without a
// cap a refresh held them all and rebuilt every event on each read
// (Daybreak, 12 Nov 2026).
export const MAX_HELD = 5000;
// Trimmed once it's this far past, so a long read sorts the held rows every
// twenty pages rather than every page.
const TRIM_SLACK = 1000;
// Scrolling back reads older rows only while fewer than this are held, so
// paging can't hold a whole flood either.
const MAX_SCROLLED = 2 * MAX_HELD;
// Cards held for one thread: another runner can put a new card on its row
// as often as it likes, and each answered one stayed (Codex's review of
// the Daybreak fix, 12 Nov 2026). The oldest answered ones go first.
export const MAX_CARDS = 200;
// A watch nobody has subscribed for this long stops; its rows stay a while,
// so opening the thread again reads only what's new.
const IDLE_MS = 60_000;
const FORGET_MS = 30 * 60_000;
const SWEEP_MS = 15_000;
// How long an action waits to hear the other runner took it.
const TAKE_MS = 20_000;
const CALL_MS = 30_000;
// A hibernate in words waits for that runner's model to say when (the app waits 150 s).
const HIBERNATE_MS = 120_000;
// Pictures in one message to another runner: what a command may carry
// (convex/sync.ts MAX_COMMAND_FILES), as a phone's may.
const MAX_PICTURES = 6;
// The backend that takes them (convex/relay.ts commandPictures); an older
// one drops them and sends the words alone. sync.ts RELAY_PICTURES_API_VERSION,
// not imported so this module doesn't load the whole sync.
const PICTURES_API = 63;
// From this one a thread's rows can include a login's notes (role "note"),
// for a runner that asks: one from before would draw a note as a tool call
// and take the last turn's card away, so the backend leaves them out
// unless asked (Codex's review, 13 Nov).
const LOGIN_NOTES_API = 78;
// Reply buttons and slash commands on a thread there (convex/relay.ts press,
// slashCommands, rows' buttons): an older backend refuses the commands.
const BUTTONS_API = 68;
// A login or model change for a thread there (convex/relay.ts
// commandArgs, version.ts 77): an older backend refuses the command.
const SETTINGS_API = 77;
// An effort change for a thread there (convex/relay.ts commandArgs,
// convex/sync.ts finishCommand, version.ts 112).
const EFFORT_API = 112;
// The pictures pasted into that runner's messages (convex/relay.ts
// picturesAtSeqs): an older backend hasn't the query, so messages show as
// their words alone, as before.
const MESSAGE_PICTURES_API = 87;
const PICTURES_FN = 'relay:picturesAtSeqs';
// How many messages one read names (the backend's PICTURE_SEQS_MAX).
const PICTURE_SEQS = 50;
// How long a message that has just arrived has its pictures watched live:
// that runner sends the row, then uploads each picture. One that goes up
// later than this is found when the app asks for it again (readFile), or by
// a later read (PICTURE_RETRY_MS).
export const PICTURE_WAIT_MS = 20_000;
// A message with pictures not all up is asked about again by the thread's
// later reads at most this often, for PICTURE_RETRY_FOR_MS after its first.
const PICTURE_RETRY_MS = 60_000;
const PICTURE_RETRY_FOR_MS = 10 * 60_000;
// A row a live tail brings counts as just sent if its time is within this
// of now, and waits from when it came: a row whose flush was held up there
// still waits, and a sleeping Mac's backlog doesn't.
const FRESH_MS = 5 * 60_000;
// A read that failed (Convex away) is tried again for that thread after this.
const PICTURES_AGAIN_MS = 30_000;
// The most places a message's pictures get by its words alone: a line
// typed to look like the count can't make a row of hundreds of empty tiles.
const MOST_PLACES = 50;
// files.read's own default and most (files.ts), for one of those pictures.
const FILE_DEFAULT_BYTES = 16 * 1024 * 1024;
const FILE_MOST_BYTES = 48 * 1024 * 1024;
// The path of a picture a message came with that isn't up, in the place of
// that Mac's own: its thread, its row's seq and which picture.
const NOT_UP = /^threadbear-relay:([^/]+)\/(\d{1,16})\/Picture (\d{1,3})$/;
const notUpPath = (threadId: string, seq: number, n: number) => `threadbear-relay:${threadId}/${seq}/Picture ${n}`;
const KEPT_THERE = 'Files on another runner are kept there for now.';
// A send or a new thread with pictures answers within this, as the app gives
// up on one at 120 s (RPCClient.sendTimeout) and then puts the draft back
// while it may still go, so a send again would be a second one. Uploading
// them has to be done by UPLOAD_BUDGET_MS (one more upload can start just
// before it, at most POST_TIMEOUT_MS, 15 s), and if they're not all up by
// QUEUE_BY_MS nothing is queued; every wait after that ends by
// REPLY_BUDGET_MS (Codex's review, 8 Nov).
const REPLY_BUDGET_MS = 100_000;
const UPLOAD_BUDGET_MS = 60_000;
const QUEUE_BY_MS = 75_000;
// The least a wait gets once the budget has nearly gone.
const LAST_WAIT_MS = 2_000;

// sync:remoteBody's answer: null, or one that's gone, says nothing new.
export type HeldBody =
  | { state: 'text'; text: string; ok?: boolean; truncated?: boolean; input?: string; diffs?: string; images?: number; cut?: boolean }
  | { state: 'withheld'; reason?: string }
  | { state: 'expired' }
  | null;

export type RelayRow = {
  seq: number;
  // "note": a login's note from that runner (backend API 78), played as
  // the system.note it was.
  role: 'user' | 'assistant' | 'tool' | 'note';
  text: string;
  origin?: string;
  toolKind?: string;
  summary?: boolean;
  // A Plan first plan in full (backend API 72's row; the relay's rows say so
  // from 76): drawn as its plan card, not folded into the turn's work.
  plan?: boolean;
  // What became of that plan, once its runner knows (API 76).
  planDecision?: 'go' | 'revise';
  turn?: string;
  wokeBy?: { kind: string; description: string }[];
  // The reply buttons its text links, as they are now (backend API 59; the
  // relay's rows carry them from 68).
  buttons?: RowButton[];
  // How many pictures a user's message came with (API 87, from a runner
  // that says): without it, they're counted from the words (saidOf).
  pictures?: number;
  // The asks a user's message answered (API 89).
  answers?: AskAnswer[];
  // Why the runner sent its own message (API 98): its note's header.
  wakeReason?: string;
  at: string;
};
export type RowButton = { id: string; title: string; kind: 'start' | 'send'; target?: string; pressedThreadId?: string; failed?: string };
type Page = { messages: RelayRow[]; hasMore: boolean };
// One picture pasted into a message there: `n` is which, `path` where it is
// on that runner's Mac, `url` its file in file storage.
export type RelayPicture = { n: number; path: string; url: string; mediaType: string; width?: number; height?: number };
// files.read's answer (files.ts).
export type RelayFile = { path: string; size: number; modifiedAt: string; mediaType: string; data: string; truncated: boolean };

// What a row says of its pictures, worked out once per row: how many, its
// words without the line counting them, and whether that runner said the
// count (`known`) or it's read from the words, which can name a picture
// that never was (a typed "[Picture 2]").
type Said = { count: number; words: string; known: boolean };
const saidByRow = new WeakMap<RelayRow, Said>();
function saidOf(r: RelayRow): Said {
  let s = saidByRow.get(r);
  if (!s) {
    const n = r.pictures;
    if (r.role !== 'user') s = { count: 0, words: r.text, known: true };
    else if (Number.isSafeInteger(n) && n! >= 1) s = { count: Math.min(n!, MOST_PLACES), words: withoutCountLine(r.text, n!), known: true };
    // An agent's or a schedule's message from an older runner: none,
    // whatever its words quote (one thread passing on what was typed in another).
    else if (r.origin === 'runner' || r.origin === 'schedule') s = { count: 0, words: r.text, known: false };
    else s = { ...picturesSaid(r.text), known: false };
    saidByRow.set(r, s);
  }
  return s;
}

/**
 * A message's words and pictures as the app gets them. For a row that says
 * its count, `images` has one for each, in order, so [Picture N] names
 * images[N-1]; one that isn't up has a path that names no file
 * (notUpPath), and the line counting the unplaced ones goes, as the tiles
 * show them. The words and the count of pictures are then the sender's,
 * which is how the app that sent it knows its own message (the desktop's
 * PendingMessage.is_landed_by). An older runner's row has only the pictures
 * held (with a place for any missing before the last of them), and keeps
 * its line unless every picture its words count is held.
 */
function messageWithPictures(threadId: string, r: RelayRow, held: RelayPicture[] = []): { text: string; images: { path: string; mediaType: string; width?: number; height?: number }[] } {
  const { count, words, known } = saidOf(r);
  const most = known ? count : held.length ? Math.min(Math.max(...held.map((p) => p.n)), MOST_PLACES) : 0;
  if (!most) return { text: r.text, images: [] };
  const images = [];
  for (let n = 1; n <= most; n++) {
    const p = held.find((x) => x.n === n);
    images.push(p ? { path: p.path, mediaType: p.mediaType, ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}) } : { path: notUpPath(threadId, r.seq, n), mediaType: 'image/png' });
  }
  return { text: known || held.length >= count ? words : r.text, images };
}

type Pending =
  | { approvalId: string; kind: 'approval'; seq?: number; name: string; title: string; options: string[]; inputSummary?: string; planSeq?: number; reason?: string }
  | { approvalId: string; kind: 'question'; seq?: number; questions: unknown[] }
  | { approvalId: string; kind: 'secret'; seq?: number; label: string; reason: string; placeholder?: string; key: string };
export type RelayThreadRow = {
  runnerId: string;
  status: string;
  // The thread's model in use and effort (backend API 107; not in threadIndex).
  modelInUse?: string;
  effort?: string;
  effortInUse?: string;
  needs?: 'you' | 'nothing';
  pendingApproval?: Pending;
  asks?: { action: string; why?: string; reply?: string; options?: string[]; optionNotes?: string[]; suggested?: number; links?: { title: string; url: string }[]; ticked?: boolean }[];
  asksSeq?: number;
  next?: string[];
  nextPick?: 'one';
  nextSuggested?: number;
  // The done card's loose ends (backend API 73), while that card stands.
  looseEnds?: { kind: string; text: string; threadId?: string; at?: string }[];
  // Another lab's review of the last turn (backend API 76).
  review?: LabReviewLedger;
  // The turn review and looseEnds are from (API 76): they go on its end only.
  cardTurn?: string;
  lastActivityAt?: string;
  // Whether it's shared (the threads row's `share`; the sidebar's table has none).
  share?: { access?: string; slug?: unknown };
};

// slot: the request's relay seq; the answer goes at slot + 1.
export type Card = { pending: Pending; slot: number; resolved?: { decision: string; message?: string } };
type Watch = {
  threadId: string;
  runnerId: string;
  rows: Map<number, RelayRow>;
  olderMore: boolean;
  loaded: boolean;
  row: RelayThreadRow | null;
  cards: Map<string, Card>;
  // What Mike answered from here, for the card's resolution.
  decided: Map<string, { decision: string; message?: string }>;
  // Tools opened in the app, each fetched once (threads.heldBody).
  bodies: Map<number, HeldBody>;
  // Seqs already given to the app, in pages or live.
  given: Set<number>;
  unsub: (() => void)[];
  // The tail was asked for with login notes (withNotes). A watch from before
  // this runner knew its backend had them is started again when it does.
  notes?: boolean;
  idleSince?: number;
  usedAt: number;
  filling?: Promise<void>;
  // Rows a tail skipped that couldn't all be read yet: tried again with the next tail.
  hole?: { after: number; until: number };
  // When the row last said it isn't running (SETTLE_MS), and the timer that emits then.
  stoppedAt?: number;
  settleTimer?: TimerHandle;
  // When it was last read whole (load or refresh), so an events-then-subscribe doesn't read twice.
  readAt?: number;
  // The share the app was last told of (noteRow), as JSON.
  shareSaid?: string;
  // The loose ends the app was last told of (noteLooseEnds), as JSON.
  endsSaid?: string;
  // The threads row's modelInUse/effort/effortInUse last told to the app (noteSettings), as JSON.
  settingsSaid?: string;
  // A recheckPlans read under way.
  rechecking?: boolean;
  // Pictures pasted into its messages, by row seq, in order (readPictures).
  pictures: Map<number, RelayPicture[]>;
  // Rows whose pictures have been read, and when first.
  pictureAsked: Map<number, number>;
  // Rows whose pictures are going up, watched live until when.
  pictureWait: Map<number, number>;
  // Messages a live tail brought, and when: they're watched from then.
  pictureFresh: Map<number, number>;
  // The live read of those rows' pictures, the timer for the first watch
  // to end, and the app's reads of a picture waiting on them (readFile).
  pictureSub?: { key: string; unsub: () => void; closed: boolean };
  pictureTimer?: TimerHandle;
  pictureWaiters: Set<() => void>;
  // A read of pictures under way, when one that failed may be tried again,
  // and when rows still missing some may next be asked about.
  pictureRead?: Promise<void>;
  pictureAgainAt?: number;
  pictureRetryAt?: number;
};

export type RelayEvent = { seq: number; ts: string; threadId: string; turnId?: string; type: string; [k: string]: unknown };

// A subscriber's own sparse history, never the watch's shared `given` set.
// Validate without expanding ranges: even a huge endpoint costs no memory.
function relaySeen(value: unknown, after: number): [number, number][] | undefined {
  if (value === undefined) return undefined;
  const bad = () => new RpcError(ErrorCode.badParams, 'relaySeen must be sorted, disjoint positive seq ranges at or below afterSeq (at most 20000).');
  if (!Array.isArray(value) || value.length > 20_000) throw bad();
  let end = 0;
  for (const range of value) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] <= end || range[1] < range[0] || range[1] > after) throw bad();
    end = range[1];
  }
  return value as [number, number][];
}

function hasSeen(ranges: [number, number][], seq: number): boolean {
  let lo = 0, hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const [first, last] = ranges[mid]!;
    if (seq < first) hi = mid;
    else if (seq > last) lo = mid + 1;
    else return true;
  }
  return false;
}

export type RelaySource = {
  post: Post;
  subscribe?: Subscribe;
  key: string;
  // The backend's API version, and file storage's upload, for pictures.
  apiVersion?: number;
  upload?: Upload;
  // A file in file storage by its URL: pictures pasted into another
  // runner's messages, for the app (readFile).
  download?: Download;
};
// A picture the app imported for a message (media.import), read only from
// this runner's inbox, so a client can't have any other file here posted to
// Convex by naming it.
export type ReadPicture = (file: string) => { bytes: Uint8Array; mediaType: string } | { skip: string };
export type RelayDeps = {
  // The backend, with the owner key; undefined while sync is off or the
  // backend is older than API 44 (sync.ts relaySource).
  source: () => RelaySource | undefined;
  // Other runners and their threads, as the sidebar has them (thread-index.ts).
  remote: () => RemoteThreads;
  // An in-progress move this runner knows of for a remote thread (main.ts
  // remoteMoving), kept on relayed thread.updated summaries so they don't clear it.
  movingOf?: (threadId: string, runnerId?: string) => RemoteThread['moving'];
  publish: (n: Notification) => void;
  readPicture?: ReadPicture;
  // Whether an app connection is subscribed to the thread (rpc.ts).
  subscribed: (threadId: string) => boolean;
  clock: Clock;
  log: Logger;
};

const RUNNING = new Set(['running', 'starting', 'waiting']);
const TOOL_NAMES: Record<string, string> = { command: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', search: 'Grep', web: 'WebFetch', task: 'Task' };

/**
 * What became of the plan at sorted[i]: what its row says (that runner sends
 * it again once it's resolved, backend API 76), or sent back by a newer plan
 * after it. Otherwise still waiting (undefined). Guessing from the rows after
 * it read a denied plan as gone ahead, and a schedule's message as Mike
 * sending it back (Codex's review, 12 Nov), and a guess given to the app
 * can't be taken back.
 */
export function planOutcome(plan: RelayRow, newerPlan: boolean): 'go' | 'revise' | undefined {
  if (plan.planDecision) return plan.planDecision;
  return newerPlan ? 'revise' : undefined;
}

/** A thread's held rows and row as transcript events, oldest first, in relay seqs. Pure, so a page and the live stream agree. */
export function relayEvents(threadId: string, rows: RelayRow[], row: RelayThreadRow | null, cards: Card[], olderMore: boolean, runnerName: string, settled = true, bodies?: Map<number, HeldBody>, pictures?: Map<number, RelayPicture[]>): RelayEvent[] {
  const out: RelayEvent[] = [];
  const sorted = rows.filter((r) => isRelaySeq(r.seq)).sort((a, b) => a.seq - b.seq);
  // Stopped only once it has said so for a moment (SETTLE_MS).
  const running = row ? RUNNING.has(row.status) || !settled : true;
  const env = (seq: number, r: RelayRow, body: Record<string, unknown>): RelayEvent => ({ seq, ts: r.at, threadId, ...(r.turn ? { turnId: r.turn } : {}), ...body }) as RelayEvent;
  const turnStart = new Map<string, string>();
  // The newest plan, found once: asking each plan whether one comes after it
  // copied the rest of the rows per plan, so a run of plans took quadratic
  // time on this runner (Daybreak, 12 Nov 2026).
  const lastPlanSeq = sorted.findLast((r) => r.plan)?.seq;
  // The last row of the last turn: a login's note after it (no turn of its
  // own) doesn't make the turn before it an earlier one, or its card and
  // its failure would go with the note's arrival.
  const lastTurnRow = sorted.findLastIndex((r) => r.turn !== undefined);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const base = r.seq * SCALE;
    if (r.turn && (prev ? prev.turn !== r.turn : !olderMore)) {
      out.push(env(base, r, { type: 'turn.started', turnId: r.turn, ...(r.wokeBy ? { wokeBy: r.wokeBy } : {}) }));
    }
    if (r.turn && !turnStart.has(r.turn)) turnStart.set(r.turn, r.at);
    if (r.role === 'user') {
      // Without the pictures read (an older backend), as that runner's words alone.
      const { text, images } = pictures ? messageWithPictures(threadId, r, pictures.get(r.seq)) : { text: r.text, images: [] };
      out.push(env(base + 1, r, { type: 'user.message', text, images, ...(r.answers?.length ? { answers: r.answers.map((a) => ({ action: a.action, answer: a.answer })) } : {}), ...(r.origin === 'phone' || r.origin === 'runner' || r.origin === 'schedule' ? { origin: r.origin } : {}), ...(r.origin === 'runner' && r.wakeReason ? { wakeReason: r.wakeReason } : {}) }));
    } else if (r.role === 'assistant' && r.plan) {
      // A Plan first plan: its card, as that runner's own Mac draws it. As a
      // reply it folded into the turn's work and nothing showed (12 Nov).
      const itemId = `relay-${r.seq}`;
      out.push(env(base + 1, r, { type: 'plan.proposed', itemId, text: r.text }));
      const went = planOutcome(r, lastPlanSeq !== undefined && r.seq < lastPlanSeq);
      if (went) out.push(env(base + 2, r, { type: 'plan.resolved', itemId, decision: went }));
    } else if (r.role === 'assistant') {
      out.push(env(base + 1, r, { type: 'assistant.text', itemId: `relay-${r.seq}`, text: r.text, ...(r.summary ? { summary: true } : {}) }));
    } else if (r.role === 'note') {
      // That runner's thread moved to another login, or is waiting for
      // room: the app keeps these on show (is_login_note in
      // desktop/core/src/reducer/row.rs). Saved-message notices come over too.
      out.push(env(base + 1, r, { type: 'system.note', text: r.text, login: true }));
    } else if (r.role !== 'tool') {
      // A kind of row from a newer backend than this runner knows: left
      // out, not drawn as a tool call.
    } else {
      const kind = r.toolKind ?? 'other';
      const itemId = `relay-${r.seq}`;
      out.push(env(base + 1, r, { type: 'tool.call', itemId, name: TOOL_NAMES[kind] ?? 'Tool', kind, title: r.text, input: {} }));
      // Finished once anything follows it, or its turn has ended.
      if (next || !running) {
        out.push(env(base + 2, r, { type: 'tool.result', itemId, ok: true, text: `The output is kept on ${runnerName}.`, truncated: false, images: [], heldBack: { seq: r.seq } }));
        const body = bodies?.get(r.seq);
        if (body?.state === 'withheld') {
          out.push(env(base + 6, r, { type: 'tool.result', itemId, ok: true, text: `This is kept on ${runnerName}: what this tool read or ran can hold secrets, so its output doesn't go through Convex.`, truncated: false, images: [] }));
        } else if (body?.state === 'text') {
          // The app fills in the row it has from these, by itemId.
          let input: Record<string, unknown> = {};
          try {
            const parsed = body.input ? JSON.parse(body.input) : {};
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
          } catch {
            // Shown without it.
          }
          out.push(env(base + 5, r, { type: 'tool.call', itemId, name: TOOL_NAMES[kind] ?? 'Tool', kind, title: r.text, input }));
          let diffs: { path: string; hunks: unknown[] }[] = [];
          try {
            const parsed = body.diffs ? JSON.parse(body.diffs) : [];
            if (Array.isArray(parsed)) diffs = parsed.filter((d) => typeof d?.path === 'string').map((d) => ({ path: d.path, hunks: Array.isArray(d.hunks) ? d.hunks : [] }));
          } catch {
            // Likewise.
          }
          // Two seqs for diffs, unless an old runner's card is on them. A tool that
          // changed more files says which.
          const free = [base + 3, base + 4].filter((seq) => !cards.some((c) => c.slot === seq || c.slot + 1 === seq));
          const shown = diffs.slice(0, free.length);
          shown.forEach((d, n) => out.push(env(free[n]!, r, { type: 'edit.diff', itemId, path: d.path, hunks: d.hunks })));
          const more = diffs.slice(shown.length).map((d) => d.path);
          const pictures = body.images ? `${body.images === 1 ? '1 picture is' : `${body.images} pictures are`} kept on ${runnerName}.` : '';
          const notes = [more.length ? `Also changed: ${more.join(', ')}` : '', pictures].filter(Boolean).join('\n');
          out.push(env(base + 6, r, { type: 'tool.result', itemId, ok: body.ok !== false, text: body.text + (notes ? `${body.text ? '\n\n' : ''}${notes}` : ''), truncated: body.truncated === true || body.cut === true, images: [] }));
        }
      }
    }
    // The last turn ends once that runner's row says so, with or without a
    // note after it; an earlier one, as soon as another turn's row follows.
    const ends = r.turn && (!next || next.turn !== r.turn) && (i !== lastTurnRow || (row !== null && !running));
    if (ends) {
      const started = Date.parse(turnStart.get(r.turn!) ?? r.at);
      const last = i === lastTurnRow;
      // Each with its `ticked: true`, as the summary has them: the relay
      // has no seq after the turn's end for an asks.ticked, and without
      // them a finished checklist read as outstanding again.
      const asks = last && row?.needs === 'you' && row.asks?.length ? row.asks.map(({ ticked, ...a }) => (ticked ? { ...a, ticked: true } : a)) : undefined;
      out.push(
        env(base + 7, r, {
          type: 'turn.completed',
          turnId: r.turn,
          // The row says only that the last turn failed, not why: the error
          // stays on that runner. Without this a signed-out login on bruce
          // read on this Mac as an empty reply (canary, 13 Nov).
          ...(last && row?.status === 'error' ? { outcome: 'failed', error: `The last turn failed on ${runnerName}. Open it there to see why, or send a message to try again.` } : { outcome: 'completed' }),
          durationMs: Math.max(0, Date.parse(r.at) - (Number.isFinite(started) ? started : Date.parse(r.at))),
          ...(last && row?.needs ? { needs: row.needs } : {}),
          ...(asks ? { asks } : {}),
          ...(last && row?.needs === 'nothing' && row.next?.length
            ? {
                next: row.next,
                ...(row.nextPick === 'one' && row.next.length > 1 ? { nextPick: 'one' as const } : {}),
                ...(row.nextPick === 'one' && row.next.length > 1 && typeof row.nextSuggested === 'number' && Number.isInteger(row.nextSuggested) && row.nextSuggested >= 0 && row.nextSuggested < row.next.length
                  ? { nextSuggested: row.nextSuggested }
                  : {}),
              }
            : {}),
          // Only on the turn it's from: a newer turn's row can come before its rows.
          ...(last && row?.review && row.cardTurn === r.turn ? { review: row.review } : {}),
        }),
      );
    }
  }
  // Cards go where their event was: in the turn of the row before them,
  // found by halving, not a copy of the rows per card.
  const planSeqs = new Set(sorted.filter((r) => r.plan).map((r) => r.seq));
  const rowBefore = (slot: number): RelayRow | undefined => {
    let lo = 0;
    let hi = sorted.length - 1;
    let found: RelayRow | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.seq * SCALE <= slot) {
        found = sorted[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  for (const c of cards) {
    const before = rowBefore(c.slot);
    const at = before?.at ?? row?.lastActivityAt ?? new Date(0).toISOString();
    const turn = before?.turn ? { turnId: before.turn } : {};
    const p = c.pending;
    // Claude's ExitPlanMode card goes with its plan's card, as on that
    // runner's own Mac (its itemId), once that plan's row is here as a plan:
    // without one, a card that names it would draw nothing at all.
    const plan = p.kind === 'approval' && p.planSeq !== undefined && planSeqs.has(p.planSeq) ? { itemId: `relay-${p.planSeq}` } : {};
    const body =
      p.kind === 'approval'
        ? { type: 'approval.requested', approvalId: p.approvalId, ...plan, name: p.name, title: p.title, input: p.inputSummary ? { [inputKey(p.name, p.inputSummary)]: p.inputSummary } : {}, options: p.options, ...(typeof p.reason === 'string' && p.reason.trim() ? { reason: p.reason } : {}) }
        : p.kind === 'question'
          ? { type: 'question.requested', approvalId: p.approvalId, questions: p.questions }
          : { type: 'secret.requested', approvalId: p.approvalId, label: p.label, reason: p.reason, ...(p.placeholder ? { placeholder: p.placeholder } : {}) };
    out.push({ seq: c.slot, ts: at, threadId, ...turn, ...body } as RelayEvent);
    if (c.resolved) out.push({ seq: c.slot + 1, ts: at, threadId, ...turn, type: 'approval.resolved', approvalId: p.approvalId, ...c.resolved } as RelayEvent);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Brings a tail into the held rows. `gapAfter`: the tail starts past what's held, and the rows after it must be read. */
export function mergeTail(rows: Map<number, RelayRow>, tail: Page): { gapAfter?: number } {
  const newest = rows.size ? Math.max(...rows.keys()) : undefined;
  const first = tail.messages[0]?.seq;
  const gap = tail.hasMore && first !== undefined && newest !== undefined && first > newest && !rows.has(first);
  for (const m of tail.messages) rows.set(m.seq, m);
  return gap ? { gapAfter: newest } : {};
}

/**
 * Holds at most MAX_HELD rows (and TRIM_SLACK while reading), dropping the oldest. What's dropped is read
 * again if the app scrolls back to it (olderMore), and seqs given for it
 * stop counting, so emit's oldest seq moves up with it. A card's seqs stay.
 */
export function trimHeld(w: { rows: Map<number, RelayRow>; olderMore: boolean; given: Set<number>; bodies: Map<number, unknown>; cards: Map<string, Card>; pictures?: Map<number, unknown>; pictureAsked?: Map<number, number>; pictureWait?: Map<number, number>; pictureFresh?: Map<number, number> }): void {
  if (w.rows.size <= MAX_HELD + TRIM_SLACK) return;
  const seqs = [...w.rows.keys()].sort((a, b) => a - b);
  const drop = seqs.length - MAX_HELD;
  for (let n = 0; n < drop; n++) {
    const seq = seqs[n]!;
    w.rows.delete(seq);
    w.bodies.delete(seq);
    w.pictures?.delete(seq);
    w.pictureAsked?.delete(seq);
    w.pictureWait?.delete(seq);
    w.pictureFresh?.delete(seq);
  }
  w.olderMore = true;
  const from = seqs[drop]! * SCALE;
  // Answered cards from before what's held go with their rows.
  for (const [id, c] of w.cards) if (c.resolved && c.slot < from) w.cards.delete(id);
  const cardSeqs = new Set<number>();
  for (const c of w.cards.values()) cardSeqs.add(c.slot).add(c.slot + 1);
  for (const seq of w.given) if (seq < from && !cardSeqs.has(seq)) w.given.delete(seq);
  // A seq no held row's events use, just below them, so emit still knows
  // the app has been given this thread and goes on from there: with every
  // seq it had been given dropped, it sent nothing more (Codex's review).
  w.given.add(from - 1);
}

/**
 * Holds at most MAX_CARDS cards, dropping the oldest answered ones, and
 * their seqs from what was given, which grew with every card otherwise
 * (Codex's second review). The oldest seq given stays, as emit's floor.
 */
export function trimCards(cards: Map<string, Card>, given: Set<number>): void {
  if (cards.size <= MAX_CARDS) return;
  const floor = given.size ? oldestGiven(given) : undefined;
  const answered = [...cards].filter(([, c]) => c.resolved).sort((a, b) => a[1].slot - b[1].slot);
  for (const [id, c] of answered.slice(0, cards.size - MAX_CARDS)) {
    cards.delete(id);
    given.delete(c.slot);
    given.delete(c.slot + 1);
  }
  if (floor !== undefined) given.add(floor);
}

// A loop, not Math.min(...given): a spread of that many arguments can throw.
function oldestGiven(given: Set<number>): number {
  let from = Infinity;
  for (const seq of given) if (seq < from) from = seq;
  return from;
}

// Said before anything was queued for the other runner, so nothing can
// come of it there (cross-runner.ts hands a claim back on these).
export function notSent(e: unknown): unknown {
  if (e && typeof e === 'object') (e as { notSent?: boolean }).notSent = true;
  return e;
}
export function wasNotSent(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && (e as { notSent?: boolean }).notSent);
}

type RememberedKey = keyof RemoteThread | 'effort';
type RememberedPatch = Partial<RemoteThread> & { effort?: string };
type RememberedEntry = { value: unknown; at: number; hadRow?: boolean; was?: unknown };
type RowSettings = { modelInUse?: string; effort?: string; effortInUse?: string };

export class Relay {
  private deps: RelayDeps;
  private watches = new Map<string, Watch>();
  // Threads made from here that the sidebar's list doesn't have yet.
  private made = new Map<string, RemoteThread>();
  // Changes the other runner has made for us that its backend row may not
  // show yet, kept a while so each reply carries them all: otherwise a
  // markSeen answered after an archive, from the row that isn't archived
  // yet, put the thread back in the app's inbox. Each field goes once the
  // row shows it (so a later change from the phone isn't hidden) or after
  // CHANGED_MS, whichever is first.
  private changed = new Map<string, Map<RememberedKey, RememberedEntry>>();
  private sweepTimer?: TimerHandle;
  private reads = 0;
  // What those reads brought back, as JSON bytes (about what Convex bills
  // for the rows they read), so the relay's I/O can be measured.
  private bytes = 0;

  constructor(deps: RelayDeps) {
    this.deps = deps;
  }

  stop(): void {
    this.sweepTimer?.cancel();
    this.sweepTimer = undefined;
    for (const w of this.watches.values()) this.unwatch(w);
    this.watches.clear();
  }

  /** Another runner's thread the sidebar lists, which this answers for. */
  owns(threadId: string): boolean {
    return Boolean(this.deps.source() && this.find(threadId));
  }

  /** The runner a request about the thread goes to, as `call` picks it
   * (`watch` follows the index). */
  ownerOf(threadId: string): string | undefined {
    return this.deps.source() ? this.find(threadId)?.runnerId : undefined;
  }

  private src(): RelaySource {
    const s = this.deps.source();
    if (!s) throw new RpcError(ErrorCode.other, "This Mac's runner can't reach other runners through Convex now (sync is off, or Convex hasn't updated yet).");
    return s;
  }

  status(): { watching: number; held: number; reads: number; bytes: number } {
    let held = 0;
    for (const w of this.watches.values()) held += w.rows.size;
    return { watching: [...this.watches.values()].filter((w) => w.unsub.length).length, held, reads: this.reads, bytes: this.bytes };
  }

  /** A thread started from here elsewhere (a virtual runner's, virtual-runners.ts), openable before the sidebar's list has its row. */
  noteMade(row: RemoteThread): void {
    this.made.set(row.threadId, row);
  }

  private find(threadId: string): RemoteThread | undefined {
    const listed = this.deps.remote().threads.find((t) => t.threadId === threadId);
    if (listed) {
      this.made.delete(threadId);
      return listed;
    }
    return this.made.get(threadId);
  }

  /**
   * Another runner's thread as a ThreadSummary, from its sidebar row, as the
   * app makes one (RemoteThreads.swift, `RemoteThread.summary`): no seqs in
   * the row, so an unread one is lastSeq 1 and lastSeenSeq 0.
   */
  private summary(threadId: string): Record<string, unknown> {
    const t = this.withChanges(threadId, this.find(threadId));
    const thread: Record<string, unknown> = {
      id: threadId,
      title: t.title ?? '',
      cwd: t.cwd ?? '',
      accountId: t.accountId ?? '',
      provider: t.provider || 'claude',
      status: t.status ?? 'idle',
      needsYou: t.needsYou ?? false,
      preview: t.preview ?? '',
      lastSeq: t.unread ? 1 : 0,
      lastSeenSeq: 0,
      runnerId: t.runnerId,
    };
    for (const k of ['poolId', 'model', 'modelInUse', 'effort', 'effortInUse', 'createdAt', 'lastActivityAt', 'snoozedUntil', 'archivedAt', 'starredAt', 'coordinatorProjectId', 'startedBy', 'asked', 'keywords', 'waitState'] as const) {
      if (t[k] !== undefined) thread[k] = t[k];
    }
    const moving = t.moving ?? this.deps.movingOf?.(threadId, t.runnerId);
    if (moving) thread.moving = moving;
    // Its real access, or "unknown" from a runner that doesn't say: never
    // left out, as an app reads a summary without one as Full access.
    thread.permissionMode = t.permissionMode || 'unknown';
    if (t.lastActivityAt) thread.updatedAt = t.lastActivityAt;
    if (t.snoozedUntil === UNTIL_RESTART) thread.snoozedUntilRestart = true;
    const w = this.watches.get(threadId);
    const ends = w && this.looseEndsOf(w);
    if (ends) thread.looseEnds = ends;
    return thread;
  }

  /**
   * The done card's loose ends (docs/protocol/threads.md, "Loose ends") as this
   * runner's summary has them, `{ seq, ends }`, from the thread's backend
   * row (API 73) and the seq of the turn.completed the relay gave the app
   * for that card. Only for a thread being watched: the sidebar's rows don't
   * carry them, and the card only shows in an open thread.
   */
  private looseEndsOf(w: Watch): { seq: number; ends: NonNullable<RelayThreadRow['looseEnds']> } | undefined {
    const ends = w.row?.looseEnds;
    if (!ends || w.row?.needs !== 'nothing' || !w.row.cardTurn) return undefined;
    // That turn's end, not the last one here: a newer turn's row can come
    // before its rows, and its loose ends aren't the older card's (Codex's
    // review, 12 Nov).
    const end = this.events(w).findLast((e) => e.type === 'turn.completed');
    return end && end.turnId === w.row.cardTurn ? { seq: end.seq, ends } : undefined;
  }

  /** The loose ends, said to the app as they change (thread.updated), as noteShare says the share. */
  private noteLooseEnds(w: Watch): void {
    const ends = this.looseEndsOf(w);
    const said = JSON.stringify(ends ?? null);
    if (said === w.endsSaid) return;
    const first = w.endsSaid === undefined;
    w.endsSaid = said;
    if (first && !ends) return;
    const share = w.row ? toShare(w.row.share) : undefined;
    this.deps.publish({ method: 'thread.updated', params: { thread: { ...this.summary(w.threadId), ...(share ? { share } : {}) } } } as unknown as Notification);
  }

  /** The model-in-use and effort fields carried on the watched threads row (API 107). */
  private rowSettingsOf(w: Watch | undefined): RowSettings {
    const r = w?.row;
    if (!r) return {};
    const out: RowSettings = {};
    if (typeof r.modelInUse === 'string' && r.modelInUse.length > 0 && r.modelInUse.length <= 200) out.modelInUse = r.modelInUse;
    if (isEffortLevel(r.effort)) out.effort = r.effort;
    if (isEffortLevel(r.effortInUse)) out.effortInUse = r.effortInUse;
    return out;
  }

  /** The modelInUse/effort/effortInUse values actually present on an emitted summary. */
  private settingsOf(t: Record<string, unknown>): RowSettings {
    const out: RowSettings = {};
    if (typeof t.modelInUse === 'string' && t.modelInUse.length > 0 && t.modelInUse.length <= 200) out.modelInUse = t.modelInUse;
    if (isEffortLevel(t.effort)) out.effort = t.effort;
    if (isEffortLevel(t.effortInUse)) out.effortInUse = t.effortInUse;
    return out;
  }

  /** A watched thread's modelInUse/effort/effortInUse, said to the app as they change there (thread.updated). */
  private noteSettings(w: Watch): void {
    if (!w.row) return;
    const thread = this.summary(w.threadId);
    const shown = this.settingsOf(thread);
    const said = JSON.stringify(shown);
    if (said === w.settingsSaid) return;
    const first = w.settingsSaid === undefined;
    w.settingsSaid = said;
    if (first && !shown.modelInUse && !shown.effort && !shown.effortInUse) return;
    const share = toShare(w.row.share);
    this.deps.publish({ method: 'thread.updated', params: { thread: { ...thread, ...(share ? { share } : {}) } } } as unknown as Notification);
  }

  /** The row with the changes made from here that it doesn't show yet (`changed`). */
  private withChanges<T extends Partial<RemoteThread>>(threadId: string, row: T | undefined): T & RowSettings {
    const w = this.watches.get(threadId);
    const rs = this.rowSettingsOf(w);
    const base: Record<string, unknown> = { ...row, ...rs };
    const kept = this.changed.get(threadId);
    if (!kept) return base as T & RowSettings;
    const now = this.deps.clock.now();
    const t: Record<string, unknown> = { ...base };
    for (const [k, c] of kept) {
      // effort lives on the watched threads row, never on the sidebar's
      // threadIndex row: only treat it as caught up once w.row is loaded and
      // either matches our change or moved off the pre-command value (e.g. a
      // newer change from the phone whose row skipped ours).
      const caughtUp = k === 'effort'
        ? Boolean(w?.row && (shows(k, rs.effort, c.value) || (c.hadRow && rs.effort !== c.was)))
        : Boolean(row && shows(k, row[k], c.value));
      if (now - c.at >= CHANGED_MS || caughtUp) kept.delete(k);
      else if (c.value === undefined) delete t[k];
      else t[k] = c.value === PUT_AWAY ? UNTIL_RESTART : c.value;
    }
    if (!kept.size) this.changed.delete(threadId);
    // The row's state is from before the change: without it the app's own
    // rule draws the change (Codex's review, 23 Nov). Effort never moves waitState.
    else if ([...kept.keys()].some((k) => k !== 'effort')) delete t.waitState;
    return t as T & RowSettings;
  }

  /**
   * The sidebar's list of other runners' threads (remoteThreads.list and
   * .updated) with the changes made from here on it, as the replies have
   * them: a list sent because some other thread changed, before this one's
   * row had caught up, put a thread just archived here back in the inbox.
   */
  overlay(remote: RemoteThreads): RemoteThreads {
    // And a watched thread's loose ends and row settings (effort, effortInUse,
    // modelInUse), which its sidebar row doesn't have: the app makes the
    // summary from that row, so without them here the next list took them off.
    const ends = new Map<string, unknown>();
    const watchedSettings = new Set<string>();
    for (const w of this.watches.values()) {
      const e = this.looseEndsOf(w);
      if (e) ends.set(w.threadId, e);
      const rs = this.rowSettingsOf(w);
      if (rs.modelInUse || rs.effort || rs.effortInUse) watchedSettings.add(w.threadId);
    }
    if (!this.changed.size && !ends.size && !watchedSettings.size) return remote;
    return {
      ...remote,
      threads: remote.threads.map((t) => {
        const row = this.changed.has(t.threadId) || watchedSettings.has(t.threadId) ? this.withChanges(t.threadId, t) : t;
        return ends.has(t.threadId) ? ({ ...row, looseEnds: ends.get(t.threadId) } as RemoteThread) : (row as RemoteThread);
      }),
    };
  }

  /** The thread's share as that runner's backend row has it: "people" (API 7) reads as off. */
  private async shareOf(threadId: string): Promise<Share | undefined> {
    const row = (await this.read('relay:remoteThread', { threadId })) as Pick<RelayThreadRow, 'share'> | null;
    return toShare(row?.share);
  }

  /**
   * A watched thread's share, said to the app as it changes there (the
   * website's Stop sharing or New link), and on first reading the row if
   * it's shared: the app keeps the last share it heard of through the
   * sidebar's rows, which never have one, so without this it showed a
   * dead link.
   */
  private noteShare(w: Watch): void {
    if (!w.row) return;
    const share = toShare(w.row.share);
    const said = JSON.stringify(share ?? null);
    if (said === w.shareSaid) return;
    const first = w.shareSaid === undefined;
    w.shareSaid = said;
    if (first && !share) return;
    this.deps.publish({ method: 'thread.updated', params: { thread: { ...this.summary(w.threadId), ...(share ? { share } : {}) } } } as unknown as Notification);
  }

  /** The share once the row shows it as asked, read a few times while the row catches up. */
  private async sharedAs(w: Watch, access: 'off' | 'link', notSlug?: string): Promise<Share | undefined> {
    for (let i = 0; ; i++) {
      const share = await this.shareOf(w.threadId);
      if (share && share.access === access && share.slug !== notSlug) {
        // Said in this reply, so not again when the watch sees the row.
        w.shareSaid = JSON.stringify(share);
        return share;
      }
      // Off with no link ever made: nothing to show, and nothing to wait for.
      if (access === 'off' && !share) return undefined;
      if (i >= SHARE_READS - 1) break;
      await new Promise<void>((r) => this.deps.clock.setTimeout(() => r(), SHARE_READ_MS));
    }
    // Not "done" without it: the app keeps the share it had, so an off it
    // can't confirm would still show the link as on.
    const name = this.runnerName(w.runnerId);
    throw new RpcError(ErrorCode.other, access === 'link'
      ? `${name} has shared it, but its link hasn't reached Convex yet. Open Share again in a moment.`
      : `${name} has stopped sharing it, but Convex doesn't show that yet. Open Share again in a moment.`);
  }

  /** A change the other runner has done, for replies until its row shows it (`changed`). */
  private remember(threadId: string, patch: RememberedPatch, before?: { hadRow: boolean; effort?: string }): void {
    const at = this.deps.clock.now();
    const kept = this.changed.get(threadId) ?? new Map<RememberedKey, RememberedEntry>();
    for (const [k, value] of Object.entries(patch)) {
      const entry: RememberedEntry = k === 'effort' && before?.hadRow ? { value, at, hadRow: true, was: before.effort } : { value, at };
      kept.set(k as RememberedKey, entry);
    }
    this.changed.set(threadId, kept);
  }

  private runner(runnerId: string) {
    return this.deps.remote().runners.find((r) => r.id === runnerId);
  }

  private runnerName(runnerId: string): string {
    return this.runner(runnerId)?.name ?? 'the other runner';
  }

  private watch(threadId: string): Watch {
    let w = this.watches.get(threadId);
    const t = this.find(threadId);
    if (!t) throw new RpcError(ErrorCode.threadNotFound, `No thread ${threadId}.`);
    if (!w) {
      w = { threadId, runnerId: t.runnerId, rows: new Map(), bodies: new Map(), olderMore: true, loaded: false, row: null, cards: new Map(), decided: new Map(), given: new Set(), unsub: [], usedAt: this.deps.clock.now(), pictures: new Map(), pictureAsked: new Map(), pictureWait: new Map(), pictureFresh: new Map(), pictureWaiters: new Set() };
      this.watches.set(threadId, w);
    } else if (w.runnerId !== t.runnerId) {
      // Moved to another runner while watched: its commands go to the one
      // the index lists now, the one ownerOf names (the backend refuses the
      // old one's anyway). The events are the thread's, wherever it runs.
      w.runnerId = t.runnerId;
    }
    w.usedAt = this.deps.clock.now();
    this.sweepSoon();
    return w;
  }

  private async read(fn: string, args: Record<string, unknown>): Promise<unknown> {
    this.reads++;
    const src = this.src();
    const out = await src.post('query', fn, { key: src.key, ...args });
    this.bytes += JSON.stringify(out ?? null).length;
    return out;
  }

  // Asks for the login notes among a thread's rows, of a backend that has
  // them (an older one refuses an argument it doesn't know).
  private withNotes(): { notes?: true } {
    return (this.src().apiVersion ?? 0) >= LOGIN_NOTES_API ? { notes: true } : {};
  }

  private events(w: Watch): RelayEvent[] {
    const settled = w.stoppedAt === undefined || this.deps.clock.now() - w.stoppedAt >= SETTLE_MS;
    const events = relayEvents(w.threadId, [...w.rows.values()], w.row, [...w.cards.values()], w.olderMore, this.runnerName(w.runnerId), settled, w.bodies, this.picturesOn() ? w.pictures : undefined);
    // A hole might contain the rest of this turn, or the start of the next.
    // Further tails can merge more gaps into it, so no turn marker inside
    // the whole uncertain interval is known yet. Real messages stay readable
    // and the true markers arrive late once the missing rows are known.
    const hole = w.hole;
    return hole ? events.filter((e) => !['turn.started', 'turn.completed'].includes(e.type) || e.seq < hole.after * SCALE || e.seq > hole.until * SCALE) : events;
  }

  // The row's open card, kept so it stays in the transcript once answered;
  // one that's gone from the row has been answered (here, there or on the phone).
  private noteRow(w: Watch, row: RelayThreadRow | null, live = false): void {
    const wasRunning = w.row ? RUNNING.has(w.row.status) : true;
    w.row = row;
    this.noteShare(w);
    this.noteLooseEnds(w);
    this.noteSettings(w);
    const running = row ? RUNNING.has(row.status) : true;
    // Ends its turn once its last messages have had a moment to arrive.
    if (!running && wasRunning && live) this.settle(w);
    else if (running) w.stoppedAt = undefined;
    const open = row?.pendingApproval;
    if (open && !w.cards.has(open.approvalId)) {
      // An older runner doesn't say the card's seq: after the newest row.
      // Two slots after each row (3 and 5), each with its answer one after.
      const newest = w.rows.size ? Math.max(...w.rows.keys()) : 0;
      const used = new Set([...w.cards.values()].map((c) => c.slot));
      const slot = open.seq !== undefined ? open.seq * SCALE + 1 : [3, 5].map((k) => newest * SCALE + k).find((s) => !used.has(s));
      if (slot !== undefined) w.cards.set(open.approvalId, { pending: open, slot });
    }
    for (const [id, c] of w.cards) {
      if (c.resolved || open?.approvalId === id) continue;
      c.resolved = w.decided.get(id) ?? { decision: c.pending.kind === 'approval' ? 'allow' : 'answered', message: `Answered on ${this.runnerName(w.runnerId)} or the phone.` };
    }
    trimCards(w.cards, w.given);
  }

  private async refresh(w: Watch): Promise<void> {
    const newest = w.rows.size ? Math.max(...w.rows.keys()) : 0;
    const [row] = await Promise.all([
      this.read('relay:remoteThread', { threadId: w.threadId }),
      (async () => {
        let after = newest;
        for (;;) {
          const page = wellFormed((await this.read('relay:remoteMessages', { threadId: w.threadId, afterSeq: after, limit: PAGE, ...this.withNotes() })) as Page);
          for (const m of page.messages) w.rows.set(m.seq, m);
          trimHeld(w);
          const last = page.messages[page.messages.length - 1]?.seq;
          if (last === undefined || !page.hasMore) break;
          after = last;
        }
      })(),
    ]);
    // As fresh as a live update, so a stop seen here waits SETTLE_MS too: a
    // reader that polls (the daily canary, 16 Nov) read the Pixel's turn as
    // ended before its last reply and its card had come.
    this.noteRow(w, row as RelayThreadRow | null, true);
    w.readAt = this.deps.clock.now();
  }

  private settle(w: Watch): void {
    w.stoppedAt = this.deps.clock.now();
    w.settleTimer?.cancel();
    w.settleTimer = this.deps.clock.setTimeout(() => {
      w.settleTimer = undefined;
      this.emit(w);
    }, SETTLE_MS);
  }

  private async load(w: Watch): Promise<void> {
    if (w.loaded) {
      // Not watched (nobody subscribed since): what's held may be old, so
      // read what's come since, once, as a tail would have.
      if (!w.unsub.length && this.deps.clock.now() - (w.readAt ?? 0) > 2000) await this.refresh(w);
      return;
    }
    const [row, page] = await Promise.all([this.read('relay:remoteThread', { threadId: w.threadId }), this.read('relay:remoteMessages', { threadId: w.threadId, limit: PAGE, ...this.withNotes() })]);
    const p = wellFormed(page as Page);
    for (const m of p.messages) w.rows.set(m.seq, m);
    w.olderMore = p.hasMore;
    const r = row as RelayThreadRow | null;
    this.noteRow(w, r);
    // Stopped only just now: its last messages may still be on their way.
    w.readAt = this.deps.clock.now();
    if (r && !RUNNING.has(r.status) && r.lastActivityAt && this.deps.clock.now() - Date.parse(r.lastActivityAt) < SETTLE_MS) this.settle(w);
    w.loaded = true;
  }

  // threads.events, in relay seqs.
  private async page(w: Watch, p: { afterSeq?: number; beforeSeq?: number; limit?: number }) {
    await this.load(w);
    this.retryGap(w);
    const limit = Math.max(1, Math.min(p.limit ?? 200, 2000));
    if (p.beforeSeq !== undefined) {
      // Older rows, read once each, until there are enough or none are left.
      const realBefore = Math.ceil(p.beforeSeq / SCALE);
      let have = [...w.rows.keys()].filter((s) => s < realBefore).length;
      while (have < Math.ceil(limit / 2) && w.olderMore && w.rows.size < MAX_SCROLLED) {
        const oldest = Math.min(...w.rows.keys());
        const older = wellFormed((await this.read('relay:remoteMessages', { threadId: w.threadId, beforeSeq: oldest, limit: PAGE, ...this.withNotes() })) as Page);
        for (const m of older.messages) w.rows.set(m.seq, m);
        w.olderMore = older.hasMore;
        if (!older.messages.length) break;
        have += older.messages.length;
      }
    }
    await this.readPictures(w);
    const all = this.events(w);
    this.emit(w, all);
    let events: RelayEvent[];
    if (p.afterSeq !== undefined) events = all.filter((e) => e.seq > p.afterSeq! && (p.beforeSeq === undefined || e.seq < p.beforeSeq)).slice(0, limit);
    else if (p.beforeSeq !== undefined) events = all.filter((e) => e.seq < p.beforeSeq!).slice(-limit);
    else events = all.slice(-limit);
    // Reading on one connection mustn't consume live events owed to the
    // others. A tail can be waiting on a gap read while this page is made.
    for (const e of events) w.given.add(e.seq);
    const atStart = !w.olderMore && (events.length === 0 || events[0]!.seq === all[0]?.seq);
    return {
      events,
      firstSeq: events[0]?.seq ?? 0,
      lastSeq: events.length ? events[events.length - 1]!.seq : (all[all.length - 1]?.seq ?? 0),
      inProgress: [],
      relay: { runnerId: w.runnerId, runnerName: this.runnerName(w.runnerId), ...(atStart ? { atStart: true } : {}) },
    };
  }

  private live(w: Watch): void {
    w.idleSince = undefined;
    const src = this.deps.source();
    if (w.unsub.length || !src?.subscribe) return;
    const failed = (e: Error) => this.deps.log.warn('relay watch failed', { threadId: w.threadId, error: String(e) });
    const notes = this.withNotes();
    w.notes = notes.notes === true;
    w.unsub.push(
      src.subscribe('relay:remoteTail', { key: src.key, threadId: w.threadId, limit: TAIL, ...notes }, (v) => void this.onTail(w, v as Page), failed),
      src.subscribe('relay:remoteThread', { key: src.key, threadId: w.threadId }, (v) => {
        this.reads++;
        this.bytes += JSON.stringify(v ?? null).length;
        this.noteRow(w, v as RelayThreadRow | null, true);
        this.emit(w);
      }, failed),
    );
    this.deps.log.info('relay watching', { threadId: w.threadId, runnerId: w.runnerId });
  }

  private unwatch(w: Watch): void {
    for (const u of w.unsub) u();
    w.unsub = [];
    w.settleTimer?.cancel();
    w.settleTimer = undefined;
    // Nobody is watching its messages' pictures go up either.
    w.pictureWait.clear();
    this.watchPictures(w);
  }

  private async onTail(w: Watch, given: Page): Promise<void> {
    const tail = wellFormed(given);
    this.reads++;
    this.bytes += JSON.stringify(given).length;
    // A watch started before this runner had heard its backend takes login
    // notes (a start, before the first heartbeat) asked for none and would
    // go on getting none: watched again, asking. The new watch's first
    // tail has these rows too (Codex's review, 13 Nov).
    if (!w.notes && this.withNotes().notes && w.unsub.length) {
      for (const u of w.unsub) u();
      w.unsub = [];
      this.live(w);
      return;
    }
    // New here and sent just now: its pictures are on their way, watched from now.
    const now = this.deps.clock.now();
    for (const m of tail.messages) if (m.role === 'user' && !w.rows.has(m.seq) && saidOf(m).count > 0 && Math.abs(now - Date.parse(m.at)) < FRESH_MS) w.pictureFresh.set(m.seq, now);
    const { gapAfter } = mergeTail(w.rows, tail);
    trimHeld(w);
    if (gapAfter !== undefined) {
      // More arrived than the tail covers (the Mac slept, the watch was
      // off): what's between is read once, so the transcript has no hole.
      const until = tail.messages[0]!.seq;
      w.hole = { after: Math.min(w.hole?.after ?? gapAfter, gapAfter), until: Math.max(w.hole?.until ?? until, until) };
    }
    if (w.hole && !w.filling) {
      const fill = this.fill(w);
      w.filling = fill;
      try {
        await fill;
      } finally {
        if (w.filling === fill) w.filling = undefined;
      }
    }
    if (!w.rechecking) {
      w.rechecking = true;
      try {
        await this.recheckPlans(w, tail);
      } finally {
        w.rechecking = false;
      }
    }
    await this.readPictures(w);
    this.emit(w);
  }

  /**
   * Plans held here as still waiting that the live tail no longer covers,
   * read again: their row gets its decision when they're resolved (API 76),
   * and only the tail is watched, so one answered while this Mac wasn't
   * looking, with more than a tail's rows since, would wait here for ever
   * (Codex's review, 12 Nov). Rows after a plan almost always mean it was
   * answered, so this is a read or two, not one per tail.
   */
  private async recheckPlans(w: Watch, tail: Page): Promise<void> {
    const oldest = tail.messages[0]?.seq;
    if (oldest === undefined) return;
    const sorted = [...w.rows.values()].sort((a, b) => a.seq - b.seq);
    // A newer plan after one sends it back: no need to ask.
    const lastPlan = sorted.findLast((r) => r.plan)?.seq;
    const stale = sorted.filter((r) => r.plan && !r.planDecision && r.seq < oldest && r.seq === lastPlan);
    for (const r of stale) {
      try {
        const page = wellFormed((await this.read('relay:remoteMessages', { threadId: w.threadId, afterSeq: r.seq - 1, limit: 1, ...this.withNotes() })) as Page);
        const m = page.messages[0];
        if (m?.seq === r.seq) w.rows.set(m.seq, m);
      } catch {
        // Asked again with the next tail.
      }
    }
  }

  // Reads a hole's rows page by page, however many: bounded by the thread,
  // and each read once. One that fails stays a hole, tried with the next tail.
  private async fill(w: Watch): Promise<void> {
    try {
      while (w.hole) {
        const { after, until: requestedUntil } = w.hole;
        const page = wellFormed((await this.read('relay:remoteMessages', { threadId: w.threadId, afterSeq: after, limit: PAGE, ...this.withNotes() })) as Page);
        for (const m of page.messages) w.rows.set(m.seq, m);
        trimHeld(w);
        const last = page.messages[page.messages.length - 1]?.seq;
        // Against the hole as it is now: a tail meanwhile may have made it longer.
        const until = w.hole?.until ?? 0;
        // hasMore belongs to the read's snapshot, not a newer tail. If
        // that tail grew the hole while HTTP was in flight, read again
        // after its arrival before trusting an empty/final page.
        if ((last !== undefined && last >= until) || (until <= requestedUntil && (last === undefined || !page.hasMore))) w.hole = undefined;
        else w.hole = { after: last ?? after, until };
      }
    } catch (e) {
      this.deps.log.warn('relay could not fill a gap', { threadId: w.threadId, error: String(e) });
    }
  }

  // Everything not yet given to the app from the oldest it has on: new rows,
  // and what's late (a tool's result once the next row comes, a card's answer).
  private emit(w: Watch, events?: RelayEvent[]): void {
    if (!w.loaded || !w.given.size) return;
    // Rows that came some other way than a page or a tail (a gap filled):
    // their pictures are read, and their messages go out after.
    if (!events && !w.pictureRead && this.picturesWanted(w).length) void this.readPictures(w).then(() => this.emit(w), () => {});
    const from = oldestGiven(w.given);
    for (const e of events ?? this.events(w)) {
      if (e.seq < from || w.given.has(e.seq)) continue;
      w.given.add(e.seq);
      this.deps.publish({ method: 'thread.event', params: { threadId: w.threadId, event: e } } as unknown as Notification);
    }
    // The done card's turn.completed may have come only now.
    this.noteLooseEnds(w);
  }

  // A failed fill is tried again when someone reads the thread, even if
  // the remote thread is idle and its tail never changes. Don't hold the
  // reader behind a long fill: the known messages can already be shown.
  private retryGap(w: Watch): void {
    if (!w.hole || w.filling) return;
    const filling = this.fill(w).finally(() => {
      if (w.filling === filling) w.filling = undefined;
      this.emit(w);
    });
    w.filling = filling;
  }

  private sweepSoon(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = this.deps.clock.setTimeout(() => {
      this.sweepTimer = undefined;
      this.sweep();
    }, SWEEP_MS);
  }

  private sweep(): void {
    const now = this.deps.clock.now();
    for (const [id, kept] of this.changed) {
      let effortExpired = false;
      for (const [k, c] of kept) {
        if (now - c.at >= CHANGED_MS) {
          kept.delete(k);
          if (k === 'effort') effortExpired = true;
        }
      }
      if (!kept.size) this.changed.delete(id);
      if (effortExpired) {
        const w = this.watches.get(id);
        if (w?.row) this.noteSettings(w);
      }
    }
    for (const [id, w] of this.watches) {
      if (this.deps.subscribed(id)) {
        this.retryGap(w);
        w.idleSince = undefined;
        w.usedAt = now;
        continue;
      }
      w.idleSince ??= now;
      if (w.unsub.length && now - w.idleSince >= IDLE_MS) {
        this.unwatch(w);
        this.deps.log.info('relay stopped watching', { threadId: id });
      }
      if (!w.unsub.length && now - w.usedAt >= FORGET_MS) this.watches.delete(id);
    }
    if (this.watches.size) this.sweepSoon();
  }

  // ---------------------------------------------------------------- pictures

  // Whether messages' pictures are read at all: only from a backend that has
  // the read, and with file storage to fetch them from.
  private picturesOn(): boolean {
    const src = this.deps.source();
    return Boolean(src?.download) && (src?.apiVersion ?? 0) >= MESSAGE_PICTURES_API;
  }

  /**
   * Held messages whose pictures to read: ones not read yet that say they
   * came with some, and, once a PICTURE_RETRY_MS, ones not all up, for
   * PICTURE_RETRY_FOR_MS after the first read. One that went up after its
   * watch ended (Codex's review, 18 Nov) is found that way, or when the app
   * asks for its place (readFile). An older runner's row, counted from its
   * words, is asked about the same way: its words may name a picture that
   * never was, so it costs at most those few reads, and makes no places.
   */
  private picturesWanted(w: Watch): number[] {
    const now = this.deps.clock.now();
    if (!this.picturesOn() || now < (w.pictureAgainAt ?? 0)) return [];
    const again = now >= (w.pictureRetryAt ?? 0);
    const seqs: number[] = [];
    for (const r of w.rows.values()) {
      if (r.role !== 'user') continue;
      const said = saidOf(r);
      if (!said.count) continue;
      const first = w.pictureAsked.get(r.seq);
      if (first === undefined || (again && now - first < PICTURE_RETRY_FOR_MS && !w.pictureWait.has(r.seq) && !this.hasItsPictures(w, r.seq))) seqs.push(r.seq);
    }
    return seqs.sort((a, b) => a - b);
  }

  private hasItsPictures(w: Watch, seq: number): boolean {
    const r = w.rows.get(seq);
    if (!r) return true;
    const held = w.pictures.get(seq) ?? [];
    for (let n = 1; n <= Math.min(saidOf(r).count, MOST_PLACES); n++) if (!held.some((p) => p.n === n)) return false;
    return true;
  }

  // picturesAtSeqs' rows, onto the watch: the first of each kept.
  private keepPictures(w: Watch, rows: unknown): void {
    if (!Array.isArray(rows)) return;
    const side = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined);
    for (const raw of rows as Record<string, unknown>[]) {
      const n = raw?.n;
      if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > 999 || !isRelaySeq(raw.seq) || typeof raw.path !== 'string' || typeof raw.url !== 'string' || typeof raw.mediaType !== 'string') continue;
      const list = w.pictures.get(raw.seq) ?? [];
      if (list.some((p) => p.n === n)) continue;
      const width = side(raw.width);
      const height = side(raw.height);
      list.push({ n: n as number, path: raw.path, url: raw.url, mediaType: raw.mediaType, ...(width ? { width } : {}), ...(height ? { height } : {}) });
      w.pictures.set(raw.seq, list.sort((a, b) => a.n - b.n));
    }
  }

  /**
   * Reads the pictures of the messages picturesWanted names. A message that
   * has only just arrived, its pictures not all up yet, has them watched
   * live (pictureWait); its event goes out meanwhile with a place for each
   * its runner said it has. A read that fails is tried again for that thread
   * after PICTURES_AGAIN_MS.
   */
  private async readPictures(w: Watch): Promise<void> {
    while (w.pictureRead) await w.pictureRead.catch(() => {});
    const seqs = this.picturesWanted(w);
    if (!seqs.length) return;
    const read = (async () => {
      try {
        for (let i = 0; i < seqs.length; i += PICTURE_SEQS) {
          const some = seqs.slice(i, i + PICTURE_SEQS);
          this.keepPictures(w, await this.read(PICTURES_FN, { threadId: w.threadId, seqs: some }));
          const now = this.deps.clock.now();
          for (const seq of some) {
            if (!w.pictureAsked.has(seq)) w.pictureAsked.set(seq, now);
            const fresh = w.pictureFresh.get(seq);
            w.pictureFresh.delete(seq);
            const r = w.rows.get(seq);
            if (!r || this.hasItsPictures(w, seq)) continue;
            // From when a live tail brought it, else from when it was sent by
            // that runner's clock, and never longer than the watch itself.
            const at = Date.parse(r.at);
            const until = Math.min(now, fresh ?? (Number.isFinite(at) ? at : now)) + PICTURE_WAIT_MS;
            if (until > now) w.pictureWait.set(seq, until);
          }
        }
        w.pictureRetryAt = this.deps.clock.now() + PICTURE_RETRY_MS;
      } catch (e) {
        w.pictureAgainAt = this.deps.clock.now() + PICTURES_AGAIN_MS;
        this.deps.log.warn('relay could not read pictures', { threadId: w.threadId, error: String(e) });
      }
    })();
    w.pictureRead = read;
    try {
      await read;
    } finally {
      if (w.pictureRead === read) w.pictureRead = undefined;
    }
    this.watchPictures(w);
  }

  // Watches the going-up rows' pictures live until each has them all or its
  // watch is over, and tells the app's reads waiting on them (pictureWaiters).
  private watchPictures(w: Watch): void {
    const now = this.deps.clock.now();
    for (const [seq, until] of w.pictureWait) if (until <= now || this.hasItsPictures(w, seq)) w.pictureWait.delete(seq);
    for (const wake of [...w.pictureWaiters]) wake();
    const seqs = [...w.pictureWait.keys()].sort((a, b) => a - b).slice(0, PICTURE_SEQS);
    const key = seqs.join(',');
    if (w.pictureSub && w.pictureSub.key !== key) {
      w.pictureSub.closed = true;
      w.pictureSub.unsub();
      w.pictureSub = undefined;
    }
    w.pictureTimer?.cancel();
    w.pictureTimer = undefined;
    if (!seqs.length) return;
    const src = this.deps.source();
    if (!w.pictureSub && src?.subscribe) {
      // Set before subscribing: the callback can run before subscribe returns.
      const sub = { key, unsub: () => {}, closed: false };
      w.pictureSub = sub;
      const unsub = src.subscribe(
        PICTURES_FN,
        { key: src.key, threadId: w.threadId, seqs },
        (v) => {
          if (sub.closed) return;
          this.reads++;
          this.bytes += JSON.stringify(v ?? null).length;
          this.keepPictures(w, v);
          this.watchPictures(w);
        },
        (e) => this.deps.log.debug('relay pictures watch failed', { threadId: w.threadId, error: String(e) }),
      );
      if (sub.closed) unsub();
      else sub.unsub = unsub;
    }
    const first = Math.min(...seqs.map((seq) => w.pictureWait.get(seq)!));
    w.pictureTimer = this.deps.clock.setTimeout(() => {
      w.pictureTimer = undefined;
      this.watchPictures(w);
    }, Math.max(0, first - now));
  }

  // Until picture n of the row at `seq` is held, or its row isn't watched any more.
  private untilPicture(w: Watch, seq: number, n: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (w.pictureWait.has(seq) && !w.pictures.get(seq)?.some((p) => p.n === n)) return;
        w.pictureWaiters.delete(check);
        resolve();
      };
      w.pictureWaiters.add(check);
      check();
    });
  }

  /**
   * files.read for another runner (rpc.ts): one of the pictures pasted into
   * its messages, by the path the relay gave the app for it, from file
   * storage. Only a path held for a thread that runner has now is answered,
   * from the thread used last when two hold the same path. A place for one
   * that wasn't up (notUpPath) waits while it's going up, and is otherwise
   * asked of the backend again. And a picture in this runner's own inbox:
   * the app draws a message it has just sent there with the paths it sent,
   * until that runner shows it. Any other file stays there.
   */
  async readFile(runnerId: string, path: string, maxBytes?: number): Promise<RelayFile> {
    let found: { picture: RelayPicture; at: string } | undefined;
    // By the runner the index lists each thread on now: a watch follows a move only at its next call.
    const watches = [...this.watches.values()].filter((w) => (this.find(w.threadId)?.runnerId ?? w.runnerId) === runnerId).sort((a, b) => b.usedAt - a.usedAt);
    for (const w of watches) {
      for (const [seq, list] of w.pictures) {
        const picture = list.find((p) => p.path === path);
        if (picture) found ??= { picture, at: w.rows.get(seq)?.at ?? new Date(this.deps.clock.now()).toISOString() };
      }
      if (found) break;
    }
    if (!found) {
      const m = NOT_UP.exec(path);
      if (!m) {
        const mine = this.deps.readPicture?.(path);
        if (!mine || 'skip' in mine) throw new RpcError(ErrorCode.other, KEPT_THERE);
        return fileOf(path, mine.bytes, mine.mediaType, new Date(this.deps.clock.now()).toISOString(), maxBytes);
      }
      const w = watches.find((x) => x.threadId === m[1]);
      const row = w?.rows.get(Number(m[2]));
      const n = Number(m[3]);
      if (!w || !row || !this.picturesOn() || n < 1 || n > (saidOf(row).known ? saidOf(row).count : MOST_PLACES)) throw new RpcError(ErrorCode.other, KEPT_THERE);
      const held = () => w.pictures.get(row.seq)?.find((p) => p.n === n);
      // The message can go out while its first lookup is still out (a thread
      // row's update emits), and its watch starts only once that's back
      // (Codex's second review, 18 Nov): that lookup first, then the watch.
      await this.readPictures(w);
      if (!held() && w.pictureWait.has(row.seq)) await this.untilPicture(w, row.seq, n);
      if (!held()) {
        try {
          this.keepPictures(w, await this.read(PICTURES_FN, { threadId: w.threadId, seqs: [row.seq] }));
        } catch (e) {
          this.deps.log.debug('relay could not read a picture again', { threadId: w.threadId, error: String(e) });
        }
      }
      const picture = held();
      if (!picture) throw new RpcError(ErrorCode.other, `That picture didn't reach Convex from ${this.runnerName(runnerId)}, so it's only there.`);
      found = { picture, at: row.at };
    }
    const download = this.deps.source()?.download;
    if (!download) throw new RpcError(ErrorCode.other, KEPT_THERE);
    let bytes: Uint8Array;
    try {
      bytes = await download(found.picture.url);
    } catch (e) {
      throw new RpcError(ErrorCode.other, `Couldn't get that picture from Convex: ${(e as Error)?.message ?? e}`);
    }
    return fileOf(path, bytes, found.picture.mediaType, found.at, maxBytes);
  }

  // ---------------------------------------------------------------- actions

  /**
   * Queues a command for the thread's runner and waits until it's taken
   * (or, with `done`, finished). A runner that's offline is said at once
   * rather than left to pick it up whenever it's back.
   */
  private async command(runnerId: string, threadId: string | undefined, kind: string, args: Record<string, unknown>, opts: { done?: boolean; ms?: number; settleBy?: number; anyway?: boolean } = {}): Promise<{ state: string; note?: string; threadId?: string; result?: unknown; commandId?: string }> {
    // settleBy: a send carrying pictures, and when it must answer by
    // (REPLY_BUDGET_MS). That runner marks it taken before it fetches them,
    // and a fetch that fails then fails the command, so taken isn't enough
    // to say it went: it waits for done until then, and only then takes
    // taken as a yes. Still pending at TAKE_MS is queued, as for any send
    // (Codex's review, 8 Nov).
    const name = this.runnerName(runnerId);
    // `anyway`: the caller has fresher word than the sidebar's list, which
    // stops updating while no app is open (login-share.ts).
    if (!opts.anyway) this.mustBeOnline(runnerId);
    let src: RelaySource;
    try {
      src = this.src();
    } catch (e) {
      throw notSent(e);
    }
    let commandId: unknown;
    try {
      commandId = await src.post('mutation', 'relay:queueCommand', { key: src.key, runnerId, ...(threadId ? { threadId } : {}), kind, args });
    } catch (e) {
      throw new RpcError(ErrorCode.other, `Couldn't reach ${name} through Convex: ${(e as Error)?.message ?? e}`);
    }
    const subscribe = src.subscribe;
    if (!subscribe) return { state: 'pending' };
    // With a budget, even the first wait ends by it (the queue call itself may have been slow).
    const ms = opts.settleBy !== undefined ? Math.max(LAST_WAIT_MS, Math.min(opts.ms ?? TAKE_MS, opts.settleBy - this.deps.clock.now())) : (opts.ms ?? TAKE_MS);
    return new Promise((resolve, reject) => {
      let unsub: (() => void) | undefined;
      let finished = false;
      let taken: { state: string } | undefined;
      const settleBy = opts.settleBy;
      const end = (f: () => void) => {
        if (finished) return;
        finished = true;
        timer.cancel();
        // The subscribe callback can run before subscribe returns.
        queueMicrotask(() => unsub?.());
        f();
      };
      const expire = () => {
        const left = settleBy !== undefined ? settleBy - this.deps.clock.now() : 0;
        if (taken && left > 0) {
          timer = this.deps.clock.setTimeout(expire, left);
          return;
        }
        end(() => (opts.done ? reject(new RpcError(ErrorCode.other, `${name} hasn't answered yet. It's waiting for it in Convex.`)) : resolve(taken ?? { state: 'pending' })));
      };
      let timer = this.deps.clock.setTimeout(expire, ms);
      unsub = subscribe(
        'relay:commandState',
        { key: src.key, commandId },
        (v) => {
          const s = v as { state: string; note?: string; threadId?: string; result?: unknown } | null;
          if (!s) return end(() => reject(new RpcError(ErrorCode.other, `${name} didn't get it.`)));
          if (s.state === 'failed') return end(() => reject(new RpcError(ErrorCode.other, s.note ?? `${name} couldn't do that.`)));
          if (s.state === 'taken' && settleBy !== undefined) taken = s;
          else if (s.state === 'done' || (s.state === 'taken' && !opts.done)) {
            return end(() => resolve({ ...s, ...(typeof commandId === 'string' ? { commandId } : {}) }));
          }
        },
        (e) => end(() => reject(new RpcError(ErrorCode.other, String(e)))),
      );
      if (finished) unsub();
    });
  }

  // A tool opened in the app: fetched once, for as long as this thread is held, and
  // its events go out like any late one. Nothing's there (full sync off on that
  // runner, or a tool from before it): the row goes on saying it's kept there.
  private async heldBody(w: Watch, seq: number | undefined): Promise<{ state: string | null }> {
    if (seq === undefined || !Number.isSafeInteger(seq)) throw new RpcError(ErrorCode.other, 'seq is required');
    const held = w.bodies.get(seq);
    if (held) return { state: held.state };
    let body: HeldBody = null;
    try {
      body = (await this.read('sync:remoteBody', { threadId: w.threadId, seq })) as HeldBody;
    } catch (e) {
      // A backend from before API 52, or Convex away: the stub stands.
      this.deps.log.debug('relay could not fetch a tool body', { threadId: w.threadId, seq, error: String(e) });
      return { state: null };
    }
    // Nothing yet can mean it hasn't gone up yet, and with no `ok` it hasn't answered
    // yet (a tool still running in the background): asked again next time.
    if (body && (body.state !== 'text' || body.ok !== undefined)) {
      w.bodies.set(seq, body);
      this.emit(w);
    }
    return { state: body?.state ?? null };
  }

  private mustBeOnline(runnerId: string): void {
    const runner = this.runner(runnerId);
    if (runner && !runner.online) throw notSent(new RpcError(ErrorCode.other, `${runner.name} is offline, so that can't reach it now.`));
  }

  /**
   * A message's pictures for another runner (backend API 63, convex/relay.ts
   * commandPictures): each read from this runner's inbox, where the app's
   * media.import put it, and uploaded to file storage, then `run` queues
   * the command naming them in order. The backend gives that runner a URL
   * for each, as for a phone's photos, which it fetches as it takes the
   * command, and deletes them once it's done. Ones uploaded for a command
   * that then failed are discarded; one that did get queued is kept by the
   * backend until its command is over, so discarding is always safe.
   */
  private async withPictures<T>(runnerId: string, raw: unknown, started: number, run: (images: string[]) => Promise<T>): Promise<T> {
    if (!Array.isArray(raw) || !raw.length) return run([]);
    const name = this.runnerName(runnerId);
    if (raw.length > MAX_PICTURES) throw new RpcError(ErrorCode.badParams, `At most ${MAX_PICTURES} pictures go to ${name} in one message.`);
    const files = raw.map((r) => (r && typeof r === 'object' && typeof (r as { path?: unknown }).path === 'string' ? (r as { path: string }).path : undefined));
    if (files.some((f) => f === undefined)) throw new RpcError(ErrorCode.badParams, "A picture in that message isn't one.");
    // Before uploading anything: a send to a runner that's away would fail anyway.
    this.mustBeOnline(runnerId);
    let src: RelaySource;
    try {
      src = this.src();
    } catch (e) {
      throw notSent(e);
    }
    const read = this.deps.readPicture;
    if ((src.apiVersion ?? 0) < PICTURES_API || !src.upload || !read) {
      throw new RpcError(ErrorCode.other, `Pictures can go to ${name} once your Convex backend is updated, which happens with the next runner update. Send it from this Mac for now, or without the pictures.`);
    }
    const tooSlow = () => new RpcError(ErrorCode.other, `The pictures took too long to upload to Convex, so nothing went to ${name}. Try fewer or smaller ones.`);
    const pictures = files.map((f) => {
      const r = read(f!);
      if ('skip' in r) throw new RpcError(ErrorCode.badParams, `A picture can't go to ${name}: ${r.skip}.`);
      return r;
    });
    const ids: string[] = [];
    try {
      for (const pic of pictures) {
        if (this.deps.clock.now() - started > UPLOAD_BUDGET_MS) throw tooSlow();
        // Recorded by the backend (relayUploads), so one that never goes out is swept after a day.
        const url = (await src.post('mutation', 'relay:pictureUploadUrl', { key: src.key })) as string;
        ids.push(await src.upload(url, pic.bytes, pic.mediaType));
      }
      if (this.deps.clock.now() - started > QUEUE_BY_MS) throw tooSlow();
      return await run(ids);
    } catch (e) {
      if (ids.length) {
        await src.post('mutation', 'relay:discardPictures', { key: src.key, storageIds: ids }).catch((err) => this.deps.log.warn('relay pictures not discarded', { error: String(err) }));
      }
      if (e instanceof RpcError) throw e;
      throw new RpcError(ErrorCode.other, `Couldn't send the pictures to ${name}: ${(e as Error)?.message ?? e}`);
    }
  }

  // What a backend older than `api` can't do: said, rather than queued and dropped.
  private needsBackend(w: Watch, api: number, what: string): void {
    let src: RelaySource;
    try {
      src = this.src();
    } catch (e) {
      throw notSent(e);
    }
    if ((src.apiVersion ?? 0) < api) throw new RpcError(ErrorCode.other, `${what} on ${this.runnerName(w.runnerId)} works once your Convex backend is updated, which happens with the next runner update.`);
  }

  private unsupported(w: Watch | undefined, what: string): never {
    const name = w ? this.runnerName(w.runnerId) : 'the other runner';
    throw new RpcError(ErrorCode.other, `${what} isn't possible through Convex yet. Do it on ${name}.`);
  }

  /** A thread method about another runner's thread (rpc.ts THREAD_METHODS). */
  async call(threadId: string, method: string, p: Record<string, unknown>): Promise<unknown> {
    const w = this.watch(threadId);
    switch (method) {
      case 'threads.events':
        return this.page(w, { afterSeq: num(p.afterSeq), beforeSeq: num(p.beforeSeq), limit: num(p.limit) });
      case 'threads.subscribe': {
        const after = num(p.afterSeq) ?? 0;
        const seen = relaySeen(p.relaySeen, after);
        const said = w.shareSaid;
        const settingsSaid = w.settingsSaid;
        await this.load(w);
        this.retryGap(w);
        await this.readPictures(w);
        const all = this.events(w);
        this.emit(w, all);
        // What's past the app's last seq, and anything that can come late
        // (a tool's result, a card's answer, a turn's end) from what it was
        // given before: it may have arrived while the app was away, and the
        // app takes a seq it already has as nothing.
        const from = seen ? (seen[0]?.[0] ?? after) : (w.given.size ? oldestGiven(w.given) : after);
        // Turn starts can also arrive late, after a gap's first row is known.
        const late = (seq: number) => seq % SCALE !== 1;
        const events = all.filter((e) => e.seq > after || (e.seq >= from && (seen ? !hasSeen(seen, e.seq) : late(e.seq))));
        for (const e of events) w.given.add(e.seq);
        if (!w.given.size) w.given.add(after);
        this.live(w);
        // An app subscribing may be new (relaunched) and not know the share
        // or settings the watch said before: said again, if set (unless
        // reading the row just now said them).
        if (w.shareSaid === said) {
          w.shareSaid = undefined;
          this.noteShare(w);
        }
        if (w.settingsSaid === settingsSaid) {
          w.settingsSaid = undefined;
          this.noteSettings(w);
        }
        return { events, inProgress: [] };
      }
      case 'threads.heldBody':
        return this.heldBody(w, num(p.seq));
      case 'threads.send': {
        const text = typeof p.text === 'string' ? p.text : '';
        const started = this.deps.clock.now();
        // The runner it was checked against (rpc.ts mustReachShown), held
        // through the uploads: the watch may follow a move meanwhile, and
        // the words go to that runner or nowhere (the backend refuses one
        // that no longer has the thread).
        const to = w.runnerId;
        const r = await this.withPictures(to, p.images, started, (images) =>
          this.command(to, threadId, 'send', { text, ...(Array.isArray(p.answers) && p.answers.length ? { answers: p.answers } : {}), ...(images.length ? { images } : {}) }, images.length ? { settleBy: started + REPLY_BUDGET_MS } : {}),
        );
        // Not taken in TAKE_MS: it waits in the backend for that runner.
        return { turnId: '', ...(r.state === 'pending' ? { queued: true } : {}) };
      }
      case 'threads.interrupt':
        await this.command(w.runnerId, threadId, 'interrupt', p.byAgent === true ? { by: 'agent' } : {});
        return {};
      case 'approvals.respond': {
        const approvalId = String(p.approvalId ?? '');
        const decision = String(p.decision ?? '');
        const message = typeof p.message === 'string' ? p.message : undefined;
        await this.command(w.runnerId, threadId, 'respond', { approvalId, decision, ...(message ? { message } : {}), ...(p.answers && typeof p.answers === 'object' ? { answers: p.answers } : {}) }, { done: true });
        w.decided.set(approvalId, { decision, ...(message ? { message } : {}) });
        const card = w.cards.get(approvalId);
        if (card) {
          card.resolved = { decision, ...(message ? { message } : {}) };
          this.emit(w);
        }
        return {};
      }
      case 'secrets.answer': {
        const approvalId = String(p.approvalId ?? '');
        if (p.decline === true) {
          await this.command(w.runnerId, threadId, 'respond', { approvalId, decision: 'deny', secret: true }, { done: true });
          w.decided.set(approvalId, { decision: 'deny' });
          return {};
        }
        // Sealed to that runner's key, as the phone does, so the value
        // never reaches the backend in the clear.
        if (!w.loaded) await this.load(w);
        const open = w.row?.pendingApproval;
        if (open?.kind !== 'secret' || open.approvalId !== approvalId) throw new RpcError(ErrorCode.other, 'That secret card has been answered or has gone.');
        const sealed = seal(open.key, String(p.secret ?? ''), approvalId);
        await this.command(w.runnerId, threadId, 'respond', { approvalId, decision: 'answered', secret: true, sealed }, { done: true });
        w.decided.set(approvalId, { decision: 'answered' });
        return {};
      }
      case 'threads.markSeen': {
        // A write on the other runner and the backend: only when there's something unread.
        if (this.find(threadId)?.unread) {
          await this.command(w.runnerId, threadId, 'update', { markSeen: true }).then(
            () => this.remember(threadId, { unread: false }),
            () => undefined,
          );
        }
        return { thread: this.summary(threadId) };
      }
      case 'threads.update': {
        // Each command with what it changes on the row, for the reply.
        const now = new Date(this.deps.clock.now()).toISOString();
        const t = this.find(threadId);
        const changes: [Record<string, unknown>, Partial<RemoteThread>][] = [];
        if (typeof p.title === 'string') changes.push([{ title: p.title }, { title: p.title }]);
        if (typeof p.archived === 'boolean') {
          changes.push(p.archived ? [{ archive: true, ...(typeof p.verdict === 'string' ? { verdict: p.verdict } : {}), ...(p.archivedBy === 'agent' ? { by: 'agent' } : {}) }, { archivedAt: now }] : [{ unarchive: true }, { archivedAt: undefined }]);
        }
        if (typeof p.starred === 'boolean') changes.push([{ star: p.starred }, { starredAt: p.starred ? (t?.starredAt ?? now) : undefined }]);
        if ('snoozedUntil' in p) {
          const s = p.snoozedUntil;
          changes.push(s === null ? [{ wake: true }, { snoozedUntil: undefined }] : s === 'restart' ? [{ snooze: { untilRestart: true } }, { snoozedUntil: UNTIL_RESTART }] : [{ snooze: { until: String(s) } }, { snoozedUntil: String(s) }]);
        }
        // A login, model or effort change (the composer's pickers, /effort,
        // the limit box's Continue now on): one command, on its own, as that
        // runner's threads.update takes them together. A folder, pool or mode
        // change still isn't possible this way.
        const settings = ['accountId', 'model', 'effort', 'carryOn'] as const;
        const known = new Set(['threadId', 'title', 'archived', 'verdict', 'archivedBy', 'starred', 'snoozedUntil', ...settings, 'byAgent', 'unconfine']);
        if (Object.keys(p).some((k) => !known.has(k) && p[k] !== undefined)) this.unsupported(w, 'Changing its folder, pool or mode');
        if (settings.some((k) => p[k] !== undefined)) {
          if (changes.length) throw new RpcError(ErrorCode.badParams, `Change ${this.runnerName(w.runnerId)}'s thread's login, model or effort on its own, not with anything else.`);
          if (p.effort !== undefined) {
            if (p.effort !== null && !isEffortLevel(p.effort)) throw new RpcError(ErrorCode.badParams, `effort must be one of ${EFFORT_LEVELS.join(', ')} or null`);
            this.needsBackend(w, EFFORT_API, 'Changing its effort');
          } else {
            this.needsBackend(w, SETTINGS_API, 'Changing its login or model');
          }
          const change: Record<string, unknown> = {};
          if (p.accountId !== undefined) change.accountId = reqStr(p.accountId, 'accountId');
          if (p.model !== undefined) change.model = p.model === null ? null : reqStr(p.model, 'model');
          if (p.effort !== undefined) change.effort = p.effort;
          if (p.carryOn === true) {
            if (change.accountId === undefined) throw new RpcError(ErrorCode.badParams, 'carryOn goes with accountId');
            change.carryOn = true;
          }
          // An agent's (rpc.ts: byAgent, or unconfine false from an older
          // draining runner): that runner starts no turn for it.
          if (p.byAgent === true || p.unconfine === false) change.by = 'agent';
          const hadRow = Boolean(w.row);
          const beforeEffort = hadRow ? this.rowSettingsOf(w).effort : undefined;
          const done = await this.command(w.runnerId, threadId, 'update', change, { done: true });
          // What that runner applied (sync.ts apply), not what was asked:
          // it may put its login's default in place of a model that login
          // can't run, or drop an effort the model doesn't support, and a
          // remembered request would hide that for a minute. Without its
          // answer, the login alone, which it can't change.
          const applied = (done.result && typeof done.result === 'object' ? done.result : {}) as { accountId?: unknown; model?: unknown; effort?: unknown };
          const patch: RememberedPatch = {};
          if (typeof applied.accountId === 'string') patch.accountId = applied.accountId;
          else if (typeof change.accountId === 'string') patch.accountId = change.accountId;
          if (change.accountId !== undefined) patch.poolId = undefined;
          if ('model' in applied) patch.model = typeof applied.model === 'string' ? applied.model : undefined;
          if ('effort' in applied) patch.effort = isEffortLevel(applied.effort) ? applied.effort : undefined;
          // sync.ts omits `effort` from `result` when undefined while always
          // sending `model`: treat absence alongside `model` as cleared.
          else if ('model' in applied) patch.effort = undefined;
          else if (change.effort !== undefined) patch.effort = typeof change.effort === 'string' ? change.effort : undefined;
          this.remember(threadId, patch, { hadRow, effort: beforeEffort });
          const thread = this.summary(threadId);
          if (w.row) w.settingsSaid = JSON.stringify(this.settingsOf(thread));
          const share = w.row ? toShare(w.row.share) : undefined;
          this.deps.publish({ method: 'thread.updated', params: { thread: { ...thread, ...(share ? { share } : {}) } } } as unknown as Notification);
          return { thread };
        }
        // Kept as each is done, so one failing after another went through
        // doesn't lose the one that did.
        for (const [change, patch] of changes) {
          await this.command(w.runnerId, threadId, 'update', { ...change, ...(p.byAgent === true ? { by: 'agent' } : {}) }, { done: true });
          this.remember(threadId, patch);
        }
        // The app takes `{ thread }` back, as from any runner, and decodes
        // nothing else: `{}` failed every archive of another runner's thread
        // with a "Key 'thread' not found" banner after it had gone through.
        return { thread: this.summary(threadId) };
      }
      case 'threads.hibernateWhen': {
        // An `update` with the words: that runner's hibernateWhen puts the
        // thread away at once (its row shows it) and the command is done
        // once its model has said when, or failed with why. The backend
        // keeps no result for an update, so `until`, `topic` and `why`
        // aren't answered; the row carries the time. `untilRestart` is for
        // a runner from before this, which reads only the time: it puts the
        // thread away until it next starts rather than waking it.
        const said = typeof p.said === 'string' ? p.said.trim() : '';
        if (!said) throw new RpcError(ErrorCode.badParams, 'Say when it should wake.');
        if (said.length > 300) throw new RpcError(ErrorCode.badParams, 'Say it in 300 characters or fewer.');
        const before = this.find(threadId)?.snoozedUntil;
        await this.command(w.runnerId, threadId, 'update', { snooze: { said, untilRestart: true } }, { done: true, ms: HIBERNATE_MS });
        // Done can come before the row with its wake time: wait a little
        // for it, and failing that answer it as put away, so the app
        // doesn't put an awake row over its own guess. The row's real time
        // replaces it when it comes.
        for (let i = 0; i < SHARE_READS && this.find(threadId)?.snoozedUntil === before; i++) {
          await new Promise<void>((r) => this.deps.clock.setTimeout(() => r(), SHARE_READ_MS / 4));
        }
        // Kept for the sidebar's list too, until any snoozed row comes (or
        // CHANGED_MS), so an update of the awake row can't bring it back.
        if (this.find(threadId)?.snoozedUntil === before) this.remember(threadId, { snoozedUntil: PUT_AWAY });
        return { thread: this.summary(threadId) };
      }
      case 'threads.share': {
        const access = p.access;
        if (access !== 'off' && access !== 'link') throw new RpcError(ErrorCode.badParams, 'access must be "off" or "link"');
        const newLink = p.newLink === true;
        // A new link is one whose slug isn't the old one.
        const old = newLink ? (await this.shareOf(threadId))?.slug : undefined;
        await this.command(w.runnerId, threadId, 'share', { access, ...(newLink ? { newLink: true } : {}) }, { done: true });
        // The command says nothing back, and the app shows the link from
        // the reply, so it's read from that runner's row, which it writes
        // as soon as it has shared (sync.ts, the share command).
        const share = await this.sharedAs(w, access, old);
        return { thread: { ...this.summary(threadId), ...(share ? { share } : {}) } };
      }
      case 'buttons.list': {
        // From the rows, as the phone draws them: never the brief or the
        // message behind a button, which stay on that runner.
        if (!w.loaded) await this.load(w);
        return { buttons: buttonsOf([...w.rows.values()]) };
      }
      case 'buttons.press': {
        this.needsBackend(w, BUTTONS_API, 'Pressing a reply button');
        const buttonId = String(p.buttonId ?? '');
        if (!/^[a-z0-9]{8}$/.test(buttonId)) throw new RpcError(ErrorCode.badParams, 'No such button.');
        // Pressing twice is harmless there (buttons.ts pressButton).
        const done = await this.command(w.runnerId, threadId, 'press', { buttonId }, { done: true, ms: CALL_MS });
        if (!w.loaded) await this.load(w).catch(() => undefined);
        const known = buttonsOf([...w.rows.values()]).find((b) => b.id === buttonId) ?? { id: buttonId, title: '', createdAt: '' };
        const now = new Date(this.deps.clock.now()).toISOString();
        return { button: { ...known, failed: undefined, ...(done.threadId ? { pressed: { at: now, threadId: done.threadId } } : {}) } };
      }
      case 'threads.commands': {
        this.needsBackend(w, BUTTONS_API, 'Its slash commands');
        const done = await this.command(w.runnerId, threadId, 'slashCommands', {}, { done: true, ms: CALL_MS });
        return { commands: Array.isArray(done.result) ? done.result : [] };
      }
      case 'threads.subagent':
        return this.unsupported(w, "Reading a sub-agent's work");
      default:
        return this.unsupported(w, describe(method));
    }
  }

  /** threads.create with a runnerId that's another runner's: a `create` command, answered with the new thread's id. */
  async create(runnerId: string, p: Record<string, unknown>): Promise<{ thread: Record<string, unknown> }> {
    const args: Record<string, unknown> = { text: String(p.text ?? '') };
    for (const k of ['cwd', 'accountId', 'model', 'effort']) if (typeof p[k] === 'string') args[k] = p[k];
    // Left out, that runner would give it full access, so every mode goes
    // (Plan first as Ask plus a flag, which an older runner reads as Ask)
    // and one this runner doesn't know is refused (remoteCreateMode).
    Object.assign(args, remoteCreateMode(p.permissionMode));
    const started = this.deps.clock.now();
    // With pictures, the fetch is part of the wait: whatever's left of REPLY_BUDGET_MS.
    const done = await this.withPictures(runnerId, p.images, started, (images) =>
      this.command(runnerId, undefined, 'create', { ...args, ...(images.length ? { images } : {}) }, images.length ? { done: true, ms: REPLY_BUDGET_MS, settleBy: started + REPLY_BUDGET_MS } : { done: true, ms: CALL_MS }),
    );
    if (!done.threadId) throw new RpcError(ErrorCode.other, `${this.runnerName(runnerId)} didn't say which thread it made.`);
    const now = new Date(this.deps.clock.now()).toISOString();
    // Opened at once, before the sidebar's list has its row.
    this.made.set(done.threadId, {
      runnerId,
      threadId: done.threadId,
      title: '',
      cwd: typeof p.cwd === 'string' ? p.cwd : '',
      accountId: typeof p.accountId === 'string' ? p.accountId : '',
      provider: typeof p.provider === 'string' ? p.provider : 'claude',
      status: 'starting',
      needsYou: false,
      unread: false,
      preview: '',
      createdAt: now,
      lastActivityAt: now,
    });
    return {
      thread: {
        id: done.threadId,
        title: '',
        cwd: typeof p.cwd === 'string' ? p.cwd : '',
        accountId: typeof p.accountId === 'string' ? p.accountId : '',
        provider: typeof p.provider === 'string' ? p.provider : 'claude',
        ...(typeof p.model === 'string' ? { model: p.model } : {}),
        ...(isEffortLevel(p.effort) ? { effort: p.effort } : {}),
        status: 'starting',
        needsYou: false,
        createdAt: now,
        lastActivityAt: now,
        lastSeq: 0,
        lastSeenSeq: 0,
        preview: '',
        runnerId,
      },
    };
  }

  async confirmRequestStart(runnerId: string, threadId: string, approvalId: string, docId: string, claim: string): Promise<string> {
    const params = { approvalId, docId, claim };
    const done = await this.command(runnerId, threadId, 'call', { method: 'requests.confirmStart', params }, { done: true, ms: CALL_MS });
    if (done.result !== true || !done.commandId) throw new RpcError(ErrorCode.badParams, 'That request has closed: its thread is no longer waiting for it.');
    return done.commandId;
  }

  async releaseRequestStart(runnerId: string, threadId: string, approvalId: string, docId: string, claim: string): Promise<void> {
    const params = { approvalId, docId, claim, release: true };
    await this.command(runnerId, threadId, 'call', { method: 'requests.confirmStart', params }, { done: true, ms: CALL_MS });
  }

  /** files.list on another runner, through an allow-listed `call` command. */
  async listFolder(runnerId: string, path: string): Promise<unknown> {
    const done = await this.command(runnerId, undefined, 'call', { method: 'files.list', params: { path } }, { done: true, ms: CALL_MS });
    return done.result;
  }

  /**
   * The Move sheet (threads.movePreview): the runner that has a thread
   * describes it (`moves.describe`), and a move's target says where it
   * would go (`moves.preview`). Both only plan; nothing starts.
   */
  async describeForMove(threadId: string): Promise<unknown> {
    const t = this.find(threadId);
    if (!t) throw new RpcError(ErrorCode.badParams, 'No such thread on another runner.');
    const done = await this.command(t.runnerId, threadId, 'call', { method: 'moves.describe', params: {} }, { done: true, ms: CALL_MS });
    return done.result;
  }

  async previewMove(runnerId: string, params: { info: unknown; cwd?: string; accountId?: string }): Promise<unknown> {
    const done = await this.command(runnerId, undefined, 'call', { method: 'moves.preview', params }, { done: true, ms: CALL_MS });
    return done.result;
  }

  /**
   * accounts.yearToken for one of another runner's logins (year-token-maker.ts
   * there): a `call` the backend lets only the owner key queue. Its answer is
   * a state and the claude.ai page, never a token.
   */
  async yearToken(runnerId: string, params: { accountId: string; code?: string; check?: boolean; cancel?: boolean }): Promise<unknown> {
    const p = { accountId: params.accountId, ...(params.code !== undefined ? { code: params.code } : {}), ...(params.check ? { check: true } : {}), ...(params.cancel ? { cancel: true } : {}) };
    const done = await this.command(runnerId, undefined, 'call', { method: 'accounts.yearToken', params: p }, { done: true, ms: CALL_MS });
    return done.result;
  }

  /**
   * accounts.useReset for one of another runner's logins (a `call` the
   * backend lets only the owner key queue): spent there, with its Codex.
   */
  async useReset(runnerId: string, accountId: string): Promise<unknown> {
    const done = await this.command(runnerId, undefined, 'call', { method: 'accounts.useReset', params: { accountId } }, { done: true, ms: CALL_MS });
    return done.result;
  }

  /**
   * Use this Mac's Claude logins (login-share.ts): that runner's public
   * sealing key, then the logins sealed to it. Both are `call`s the backend
   * lets only the owner key queue; only ciphertext goes, and the answers
   * carry no token.
   */
  async loginsSealKey(runnerId: string): Promise<string> {
    const done = await this.command(runnerId, undefined, 'call', { method: 'logins.sealKey', params: {} }, { done: true, ms: CALL_MS, anyway: true });
    const key = (done.result as { key?: unknown } | undefined)?.key;
    if (typeof key !== 'string' || !key) throw new RpcError(ErrorCode.other, `${this.runnerName(runnerId)} didn't give a key to seal to.`);
    return key;
  }

  async shareLogins(runnerId: string, logins: { email: string; box: string }[]): Promise<unknown> {
    const done = await this.command(runnerId, undefined, 'call', { method: 'logins.share', params: { logins } }, { done: true, ms: CALL_MS, anyway: true });
    return done.result;
  }

  /** Another runner's logins for the new-thread pickers, from the backend's accounts rows. */
  async logins(runnerId: string): Promise<{ accounts: unknown[]; pools: unknown[]; usagePools?: unknown[]; defaults: Record<string, unknown> }> {
    const rows = (await this.read('relay:remoteAccounts', { runnerId })) as (Account & { runnerId?: string })[];
    const accounts = rows.map(({ runnerId: _r, ...a }) => ({ ...a, configDir: '' }));
    const recent = this.deps.remote().threads.filter((t) => t.runnerId === runnerId).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
    const usagePools = (this.src().apiVersion ?? 0) >= 101 ? await this.read('relay:remotePools', { runnerId }) : undefined;
    return { accounts, pools: [], ...(Array.isArray(usagePools) ? { usagePools } : {}), defaults: { cwd: recent?.cwd ?? '', accountId: recent?.accountId ?? accounts[0]?.id ?? '', models: {}, efforts: {} } };
  }
}

type Share = { access: 'off' | 'link'; slug: string };

// files.read's answer: at most `maxBytes` of the file, as files.ts cuts one.
function fileOf(path: string, bytes: Uint8Array, mediaType: string, modifiedAt: string, maxBytes?: number): RelayFile {
  const most = Math.min(typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : FILE_DEFAULT_BYTES, FILE_MOST_BYTES);
  const cut = bytes.byteLength > most;
  return { path, size: bytes.byteLength, modifiedAt, mediaType, data: Buffer.from(cut ? bytes.subarray(0, most) : bytes).toString('base64'), truncated: cut };
}

// A threads row's share as the app takes it: "people" (API 7) reads as off.
function toShare(s: RelayThreadRow['share']): Share | undefined {
  if (!s || typeof s.slug !== 'string') return undefined;
  return { access: s.access === 'link' ? 'link' : 'off', slug: s.slug };
}

// Whether the other runner's row already shows a change made from here:
// its own times for archiving and starring, so only whether it's set.
function shows(k: RememberedKey, row: unknown, kept: unknown): boolean {
  if (kept === PUT_AWAY) return typeof row === 'string';
  if (k === 'archivedAt' || k === 'starredAt') return (row !== undefined) === (kept !== undefined);
  if (k === 'snoozedUntil' && typeof row === 'string' && typeof kept === 'string') return Date.parse(row) === Date.parse(kept);
  return row === kept;
}

// The row has the input as one line; the card draws it under the key a
// tool's input would have had, so a command reads as a command.
function inputKey(name: string, line: string): string {
  if (name === 'Bash') return 'command';
  if (/^[~/]/.test(line)) return 'file_path';
  return /^https?:\/\//.test(line) ? 'url' : 'input';
}

// A non-empty string param, as rpc.ts's reqString, for one sent on to another runner.
function reqStr(x: unknown, name: string): string {
  if (typeof x !== 'string' || !x.trim() || x.length > 200) throw new RpcError(ErrorCode.badParams, `${name} must be a short string`);
  return x;
}

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function describe(method: string): string {
  switch (method) {
    case 'threads.edit':
      return 'Editing a message';
    case 'threads.highlights':
    case 'threads.removeHighlight':
      return 'Its highlights';
    case 'threads.explain':
      return 'Explain';
    case 'threads.tickAsk':
      return 'Ticking an ask';
    case 'threads.delete':
      return 'Deleting it';
    default:
      return method.startsWith('panels.') || method.startsWith('actions.') || method.startsWith('patches.') ? 'Its patches' : method.startsWith('reviews.') ? 'Design reviews' : method.startsWith('buttons.') ? 'Reply buttons' : 'That';
  }
}

// A thread's reply buttons as the app's buttons.list has them, from its rows:
// the newest row's state of each, oldest first. A row only names the kind
// and where it goes, so `start`/`send` carry that and no brief.
export function buttonsOf(rows: RelayRow[]): Record<string, unknown>[] {
  const out = new Map<string, Record<string, unknown>>();
  for (const r of [...rows].sort((a, b) => a.seq - b.seq)) {
    for (const b of r.buttons ?? []) {
      out.set(b.id, {
        id: b.id,
        title: b.title,
        createdAt: r.at,
        ...(b.kind === 'start' ? { start: { text: '', cwd: b.target ?? '' } } : { send: { threadId: '', threadTitle: b.target ?? '', text: '' } }),
        ...(b.pressedThreadId ? { pressed: { at: r.at, threadId: b.pressedThreadId } } : {}),
        ...(b.failed ? { failed: { at: r.at, error: b.failed } } : {}),
      });
    }
  }
  return [...out.values()];
}
