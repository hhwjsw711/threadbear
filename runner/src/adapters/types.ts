// The seam between the runner and a provider CLI. The runner owns threads,
// turns, persistence and the protocol; an adapter only drives one CLI
// process per live thread and reports normalised output. Claude and Codex
// are the two implementations of AgentAdapter.
import type { SlashCommand } from '../slash-commands.ts';
import type { CodeWrite } from '../code-writes.ts';
import type {
  Account,
  BackgroundKind,
  ContextUsage,
  DeltaBody,
  EffortLevel,
  EventBody,
  ImageRef,
  ModelChoice,
  PermissionMode,
  Provider,
  Question,
  QueuedAnswers,
  QueuedCall,
  SubagentStatus,
  TurnErrorKind,
  TurnOutcome,
  UsageResets,
  UsageWindow,
} from '../protocol.ts';

export type StartSessionOptions = {
  threadId: string;
  cwd: string;
  account: Account;
  model?: string;
  effort?: EffortLevel; // undefined: the model's own level
  permissionMode: PermissionMode;
  // Native session id. With resume=false it's pre-assigned to a brand new
  // session; with resume=true the CLI loads that session's transcript.
  // Codex assigns its own ids, so it ignores this when resume=false and
  // reports the real one through the `session` output.
  sessionId: string;
  resume: boolean;
  // With resume, Claude picks the session up at this transcript entry
  // rather than at its end: an edit cut the conversation back to it
  // (docs/protocol/threads.md, "Editing a message"). Codex cuts its own history
  // in rewind(), so it never gets one.
  resumeAt?: string;
  mediaDir: string; // images from tool results are saved here
  blobsDir: string; // tool output over 64 KB is saved here
  tmpDir: string;
  // Permission rules the user chose "Always allow" for in this thread, in
  // the CLI's rule syntax ("Bash(npm test)", "Write"). Applied on start so
  // they outlast an idle release.
  allowRules?: string[];
  // Added to the CLI's environment (THREADBEAR_THREAD_ID and friends), so
  // the commands it runs know which thread they belong to.
  env?: Record<string, string>;
  // Said to the agent on top of the CLI's own system prompt: the thread's
  // projects (projects.ts). Claude appends it to the system prompt, Codex
  // takes it as developer instructions.
  instructions?: string;
  // Claude: the folder's Claude Code settings run commands it hasn't
  // trusted (claude-trust.ts), so the CLI starts without its project and
  // local settings and gets these instead: the same settings without the
  // parts that run anything.
  untrustedProjectSettings?: Record<string, unknown>;
  // Whether an edit of this file (absolute) changes code Threadbear runs
  // by itself: a patch, what a hashed patch covers, Claude settings and
  // what they name (code-writes.ts). Outside Full access such an edit
  // always asks, with no "Always allow". The adapter checks the names in
  // code-writes.ts too, so leaving this out never asks less.
  runsAsCode?: (file: string) => CodeWrite;
  // Claude, in Full with the folder's settings loaded: they hold
  // permission rules that aren't trusted for a thread that asks first, so
  // the session must be able to stop them applying if the thread leaves
  // Full (askBeforeEveryTool).
  heldGrants?: boolean;
  // The coordinator's boundary is checked by the adapter before any native
  // allow rule, including Full access. Helper identity comes from the SDK's
  // hook envelope, never tool arguments. The host owns pause and run records.
  coordinator?: {
    role: 'coordinator' | 'helper';
    context?: () => string | undefined;
    checkTool(call: { name: string; input: Record<string, unknown>; agentId?: string; toolUseId?: string }): string | undefined;
    helperQuestion?(agentId: string, questions: Question[]): void;
  };
};

export type TurnResult = {
  outcome: TurnOutcome;
  // The CLI ran this turn by itself (a background task or subagent
  // finished) rather than to answer a message the runner sent.
  own?: boolean;
  // The id (UserInput.id) of the message this turn answered, when the CLI
  // says (command_lifecycle frames). With a message folded into the turn
  // part way (sent while it ran), this is the last one folded in.
  answers?: string;
  // Every message this turn answered, in the order the CLI took them:
  // messages sent close together that ran as one turn, then any folded in
  // while it ran. Absent from CLIs that don't report it (then `answers`).
  answered?: string[];
  // Cancelled in this adapter's waiting queue, before reaching the CLI.
  unreceived?: string[];
  // Messages still waiting in the CLI's queue when this result was
  // produced, when the CLI reports it: it runs them next, without being
  // sent anything.
  queuedTurns?: number;
  durationMs: number;
  totalCostUsd?: number; // provider's running total for the native session
  usage?: Record<string, unknown>;
  error?: string;
  errorKind?: TurnErrorKind;
};

export type AdapterOutput =
  // The CLI's receipt for an input, before it asks the model. Cancelled
  // without started means the message never became the agent's to read.
  | { kind: 'messageState'; id: string; state: 'queued' | 'started' | 'cancelled' }
  | { kind: 'event'; event: EventBody }
  | { kind: 'delta'; delta: DeltaBody }
  | { kind: 'session'; nativeSessionId: string; model?: string }
  // The effort level the CLI applied to the turn that just ended.
  | { kind: 'effort'; level: EffortLevel }
  | { kind: 'context'; contextTokens: number; contextWindow?: number }
  // A rate-limit reading for the session's account (D's UsageStore keeps
  // it). email and plan come with it when the CLI reports them.
  // aside: titles of windows shown but never deciding the login's room or
  // its block (Gemini's Claude and GPT group: agy-usage.ts).
  | { kind: 'limits'; windows: UsageWindow[]; blocked?: boolean; email?: string; plan?: string; resets?: UsageResets; aside?: string[] }
  // The version of the CLI process actually running this session (not the
  // one that created it).
  | { kind: 'cliVersion'; version: string }
  // The CLI started a turn of its own; `note` says why, when it's known.
  | { kind: 'cliTurn'; note?: string }
  // The Stop hook sent a turn back to call end_turn, as its message is the
  // reply (end_turn's handler then doesn't ask for another).
  // With `reopen`, the turn had its end_turn and reply, and is sent back for
  // a card the reply asked for (needs.ts, REPLY_ASKS): the next end_turn is
  // taken, not refused as a repeat, and the reply written stands.
  // With `rewrite` too, it was sent back because its reply links files that
  // aren't there (needs.ts, missingLinksNudge): the next end_turn asks for a
  // whole new reply rather than saying the one written stands.
  | { kind: 'endTurnNudge'; reopen?: true; rewrite?: true }
  // Background work the CLI is running (shells, async subagents). Replaces
  // the previous list.
  | { kind: 'tasks'; tasks: BackgroundTask[] }
  // A sub-agent started or changed. Only the fields that changed are set;
  // the runner keeps the list and stamps the times.
  | { kind: 'subagent'; update: SubagentUpdate }
  // "Always allow" rules to keep for this thread.
  | { kind: 'allowRules'; rules: string[] }
  // The calls waiting behind the card for toolUseId, now (docs/protocol/threads.md,
  // "Queued calls").
  | { kind: 'approvalQueue'; toolUseId: string; calls: QueuedCall[] }
  // "Plan first": the agent put its plan to Mike (Claude's ExitPlanMode,
  // Codex's plan item). The runner shows it as plan.proposed.
  | { kind: 'planProposed'; itemId: string; text: string }
  // Files an Edit or Write call left, sent only for one the CLI says it
  // made, just before its successful tool.result. Never for a preview (an
  // edit.diff before approval) or a denied or failed edit: the runner
  // trusts patch files by these alone (patch-trust.ts). `sha256` is the
  // hash of the bytes the edit wrote, rebuilt from the result. Only
  // Claude's adapter sends it: a Codex patch's result doesn't say what it
  // wrote, so a patch file Codex writes waits for Mike. `mode`: the
  // thread's permission mode when the CLI let the call through, recorded
  // with the call (not read when the result comes, after a switch to Full
  // access); only 'full' trusts anything (code-writes.ts). Absent when it
  // wasn't recorded, which trusts nothing.
  | { kind: 'wrote'; itemId: string; files: AgentWrite[]; mode?: PermissionMode }
  | { kind: 'result'; result: TurnResult };

// `base`: the hash of the file an Edit or MultiEdit started from, as the
// result reports it; null when the call wrote the whole file (a Write, or
// an edit of a missing or empty one). An edit vouches only for what it
// changed, so the rest counts only when `base` was trusted (patch-trust.ts).
export type AgentWrite = { path: string; sha256: string; base: string | null };

// A background shell or subagent the CLI reports. `type` is the CLI's own
// name for it (Claude: local_bash, local_agent, ...), `kind` the protocol's.
export type BackgroundTask = { id: string; type: string; kind: BackgroundKind; description: string };

export type SubagentUpdate = {
  id: string;
  // The native task's current execution. A resumed task keeps its id but
  // gets a new runId; late events from an older run must not finish it.
  runId?: string;
  started?: boolean; // the first report of it
  itemId?: string;
  parentId?: string;
  description?: string;
  agentType?: string;
  model?: string; // the model its messages say it ran on
  status?: SubagentStatus;
  background?: boolean;
  activity?: string;
  summary?: string;
  toolUses?: number;
};

export type ToolApprovalRequest = {
  toolUseId?: string; // left out for a subagent's tools, which have no tool.call
  name: string;
  title: string;
  input: Record<string, unknown>;
  // The call's input as the CLI gave it, when `input` (what the card shows)
  // may have had parts cut short: the card reviewer reads this, as an allow
  // runs all of it (runner/card-review.ts).
  wholeInput?: Record<string, unknown>;
  canAlwaysAllow: boolean;
  signal: AbortSignal;
  // The agent's other calls waiting behind this one (docs/protocol/threads.md,
  // "Queued calls"); more can join while it waits (an approvalQueue output).
  queued?: QueuedCall[];
  // Why the CLI is asking, in a sentence for the card (askReason in the Claude adapter).
  reason?: string;
  // Full access would have let it through with no card: switching the
  // thread to Full answers it Allow (Runner.update), as a card that waits
  // under a composer saying Full is the thing Ian hit (13 Nov). Never on
  // a card every mode shows (delete_thread, a raise, a plan).
  fullAllows?: boolean;
  // Never Auto's card reviewer: what Allow does isn't shown whole here (a
  // patch whose diff arrives separately, stdin whose bytes aren't sent) or
  // hands out access lasting past the one call (Codex's turn permissions).
  noReview?: true;
};

// mode: the permission mode to switch to as the call goes ahead (approving
// a "Plan first" plan takes the thread out of plan mode).
// stopped: an expired card that Mike pressed Stop on (the Mac app or the
// phone), as opposed to one that closed unanswered for any other reason. Only then may an agent be told
// the user stopped it (docs/protocol/needs-you.md, "Who stopped it").
// queued: Mike's answers to the queued calls, answered in the same click.
// noApp: no card was put up, as only an app of this runner's own could allow
// it and it has none (app-seen.ts); `message` says what to do instead.
// `reviewer`: on a deny of a card the card reviewer left for Mike, why it did
// (runner/card-review.ts), for the agent alongside the denial.
export type ToolApprovalAnswer = { decision: 'allow' | 'allowAlways' | 'deny' | 'expired'; message?: string; reviewer?: string; mode?: PermissionMode; stopped?: boolean; queued?: QueuedAnswers; noApp?: true };

export type QuestionRequest = {
  toolUseId?: string;
  questions: Question[];
  signal: AbortSignal;
};

// answers: question text -> chosen label(s); null when dismissed or expired.
// stopped: as ToolApprovalAnswer's.
export type QuestionAnswer = { answers: Record<string, string> | null; message?: string; stopped?: boolean };

export interface SessionSink {
  output(o: AdapterOutput): void;
  requestApproval(req: ToolApprovalRequest): Promise<ToolApprovalAnswer>;
  requestQuestion(req: QuestionRequest): Promise<QuestionAnswer>;
  // The CLI process is gone (input ended, crashed or killed).
  exited(error?: Error): void;
}

// id is the runner's turnId; the CLI echoes it so its turns can be told
// apart from ones it starts by itself.
export type UserInput = { id?: string; text: string; images: ImageRef[] };

// Passed to SessionSink.exited when the session to resume doesn't
// exist (never started, deleted in the CLI's own app, a moved home): the
// runner then starts a fresh session once, with a handoff note.
export class SessionNotFoundError extends Error {
  constructor(message = 'The session to resume was not found.') {
    super(message);
    this.name = 'SessionNotFoundError';
  }
}

// A CLI that exits before returning a TurnResult can still report a usage limit.
export class SessionUsageLimitError extends Error {
  override name = 'SessionUsageLimitError';
}

export interface AgentSession {
  // Starts a turn, or, sent while one runs, goes into it (steering): the
  // CLI then lists it in TurnResult.answered or counts it in queuedTurns.
  send(input: UserInput): void;
  interrupt(): Promise<void>;
  setModel(model: string | undefined): Promise<void>;
  setEffort(effort: EffortLevel | undefined): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  // From now on every tool call goes to the approval card's check, past
  // any allow rule the CLI loaded: a session started in Full with a
  // folder's untrusted permission rules, after the thread left Full, for
  // the turns the CLI starts by itself before the next message replaces it.
  askBeforeEveryTool?(): void;
  // For end_turn's handler: whether a message sent into the running turn is
  // one the CLI hasn't handed to the agent yet, so the call being handled was
  // written without it. Each call counts as a refusal for the messages still
  // waiting, and a message is refused for twice at most: the refusal is what
  // it is handed over with. Only on an adapter whose CLI says when it hands
  // one over.
  unreadMessage?(): boolean;
  // Moves the session to another folder from its next turn, in the same
  // native session. Only on adapters with movesFolders.
  setCwd?(cwd: string): Promise<void>;
  // The slash commands this session's CLI offers (skills included), for
  // the composer's picker.
  commands?(): Promise<SlashCommand[]>;
  // What fills the session's context, in the CLI's own words, asked of the
  // running CLI (threads.contextUsage). Undefined once it has exited. Only
  // Claude's CLI says.
  contextUsage?(): Promise<Omit<ContextUsage, 'at'> | undefined>;
  // Ends the input so the CLI finishes and exits. Resolves once it has.
  // With hard set it stops the CLI straight away instead (background work
  // it is waiting for would otherwise keep it alive).
  end(opts?: { hard?: boolean }): Promise<void>;
  // Hard stop: kills the CLI's process group.
  kill(): void;
}

// Cutting a native session back to just before one of the runner's
// messages (docs/protocol/threads.md, "Editing a message"). The thread's CLI is
// never live while this runs.
export type RewindRequest = {
  threadId: string;
  account: Account;
  cwd: string;
  sessionId: string;
  messageId: string; // the id the message was sent under (its turnId)
};

export type RewindResult = {
  // Where the next start picks the session up (Claude): an entry to resume
  // at. Absent when the session itself is already cut (Codex).
  resumeAt?: string;
  // The message opened the session: start a fresh one instead.
  fresh?: boolean;
  // The files the CLI's own checkpoints put back. Absent when it has none
  // for this message, so the runner reverses the thread's diffs instead.
  files?: { undone: string[]; failed: { path: string; reason: string }[] };
};

// The session doesn't have the message (the thread moved to another login
// or provider since it was sent): there's nothing to cut back to.
export class RewindRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RewindRefusedError';
  }
}

// What spending a reset came to (accounts.useReset), in Codex's words:
// "reset", "nothingToReset" (no window is at a point a reset helps),
// "noCredit" (none left) or "alreadyRedeemed". `limits` is the login's
// reading taken straight after, when there was one.
export type UseResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';
export type UseResetResult = { outcome: UseResetOutcome; limits?: Extract<AdapterOutput, { kind: 'limits' }> };

export const MODEL_LIST_TIMEOUT_MS = 25_000;

export interface AgentAdapter {
  readonly provider: Provider;
  start(opts: StartSessionOptions, sink: SessionSink): AgentSession;
  // What the account's CLI offers as models, without starting a turn.
  // Optional: a provider without a picker leaves it out.
  models?(account: Account, signal?: AbortSignal): Promise<ModelChoice[]>;
  // Codex: spends one of the login's usage-limit resets (Mike's click on
  // the limit box, never by itself) and reads its limits after.
  useReset?(account: Account): Promise<UseResetResult>;
  // Codex, Grok and Gemini: reads the login's limits without a turn
  // (limit-recheck.ts), for a login whose last reading says it's out or
  // that has none yet, and for Gemini every limitsPollMs. null if the CLI
  // said nothing.
  readLimits?(account: Account): Promise<Extract<AdapterOutput, { kind: 'limits' }> | null>;
  // Gemini: its turns carry no reading, so readLimits is the only one, asked
  // when the last is this old, and soon after each of its turns ends.
  readonly limitsPollMs?: number;
  // The slash commands the account's CLI offers in a folder (skills
  // included), without starting a turn, for the composer's picker.
  commands?(account: Account, cwd: string, untrusted?: Record<string, unknown>): Promise<SlashCommand[]>;
  // A same-account folder change calls setCwd on a live session, or passes
  // the folder to the next start or resume, instead of copying the
  // transcript and adding a handoff (Codex).
  readonly movesFolders?: boolean;
  // Model, effort and permission changes take effect from the next turn
  // only, so the runner says so when one arrives mid-turn (Codex).
  readonly settingsApplyNextTurn?: boolean;
  // Whether the CLI starts a turn of its own when background work ends
  // (default true). Codex doesn't, so the runner skips its wake grace.
  readonly wakesAfterTasks?: boolean;
  // How long the runner waits for that turn after a job ends before taking
  // it that none is coming (default WAKE_GRACE_MS in runner.ts). OpenCode
  // opens its turn only once the model starts answering, which can be well
  // past Claude's few seconds.
  readonly wakeGraceMs?: number;
  // When that grace passes with no turn and a shell the last turn ended
  // waiting on (no end_turn) still unread, the runner sends the agent a
  // message to read it and carry on (Runner.nudgeUnreadShells). OpenCode's
  // wakes have been lost; Claude's haven't, so it isn't nudged.
  readonly nudgesUnreadShells?: boolean;
  // Archives the native session in the CLI's own app when the thread is
  // archived or deleted here. Best effort.
  archive?(account: Account, nativeSessionId: string): Promise<void>;
  // Cuts the native session back to just before a message, and puts back
  // the files the CLI checkpointed since, where it can. Throws
  // RewindRefusedError when the session doesn't have the message.
  rewind?(req: RewindRequest): Promise<RewindResult>;
}
