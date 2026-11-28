import type { SpareWeek } from './spare-week.ts';
import { HELD_EXTRA } from './schedule-check.ts';
// The thread manager: owns threads, turns, the event log, approvals, idle
// release and snoozes. Providers plug in through AgentAdapter; the WebSocket
// server in rpc.ts is a thin layer over the public methods here.
import type { ReinstallStatus } from './reinstall.ts';
import { RELEASE } from './release.ts';
import type { StartSessionOptions, UserInput } from './adapters/types.ts';
import { INSTRUCTIONS_CLEARED, INSTRUCTIONS_REWOUND } from './instructions.ts';
import { reachable, type Reachable } from './net-probe.ts';
import type { UpstreamStatus } from './upstream.ts';
import type { SwiftChangesStatus } from './swift-changes.ts';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { fitReview, keepPictureMarkers } from './reviews.ts';
import path from 'node:path';
import { ConvexKeys, type ConvexKeysOptions } from './convex-keys.ts';
import crypto from 'node:crypto';
import type {
  Account,
  AnyEvent,
  CliPolicy,
  CliStatus,
  DeltaBody,
  DeltaType,
  DesignReview,
  ReplyButton,
  EffortLevel,
  EventBody,
  ImageRef,
  InProgressItem,
  Ask,
  AskAnswer,
  MessageOrigin,
  ShareAccess,
  PermissionMode,
  PersistedEvent,
  Pool,
  Provider,
  ProviderInfo,
  Question,
  RunnerDefaults,
  Subagent,
  ThreadStatus,
  ThreadSummary,
  TurnOutcome,
} from './protocol.ts';
import { agentsStillWorking, ErrorCode, LIMITS, PROTOCOL_VERSION, RpcError, sentByAgent } from './protocol.ts';
import { cliName, providerName, providersForHello } from './providers.ts';
import { unsupportedResetMessage } from './reset-hint.ts';
import { raises } from './access.ts';
import type { ArchivedBy, ArchiveVerdict, UnarchiveVerdict, LibrarianStatus, LooseEnd, Project, Schedule } from './protocol.ts';
import { Projects } from './projects.ts';
import type { Settings } from './settings.ts';
import type {
  AgentAdapter,
  AgentSession,
  AdapterOutput,
  BackgroundTask,
  QuestionAnswer,
  SessionSink,
  SubagentUpdate,
  ToolApprovalAnswer,
  TurnResult,
} from './adapters/types.ts';
import { MODEL_LIST_TIMEOUT_MS, SessionNotFoundError, SessionUsageLimitError } from './adapters/types.ts';
import type { UseResetOutcome } from './adapters/types.ts';
import type { EventLog, ThreadRecord, ThreadStore, QueuedSend, SubagentRecord } from './store.ts';
import { cutOut } from './store.ts';

// The presses a thread keeps for its agent to hear of (Runner.notePress).
const MAX_PRESS_NOTES = 20;
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import { LimitRecheck } from './limit-recheck.ts';
import { threadEnv } from './restart.ts';
import { worktreeInstructions } from './worktrees.ts';
import { type AccountRegistry, type LearnedAccountInfo } from './accounts.ts';
import { ACCESS_OFF_HOLD_MS, ACCESS_OFF_TEXT, type SignInState } from './sign-in-state.ts';
import { decidingWindows, MIN_ROOM_PERCENT, pickAccount as pickByRoom, type UsageReading } from './usage.ts';
import { FUNDED_DETAIL } from './adapters/acp/grok-billing.ts';
import { outOfUsage } from './adapters/acp/connection.ts';
import { RUNNER_VERSION, expandHome, paths, peekRunnerJson, type Config } from './config.ts';
import { limitWhy, loginOk, nextLogin, pickInPool, poolAccounts } from './pools.ts';
import { copyImageInto, imageRefFor, importImageInto } from './media.ts';
import { ImportQuota } from './media-quota.ts';
import { isDirectory } from './fsutil.ts';
import { commandFolders } from './tools.ts';
import { copySessionTranscript, subagentTranscriptPath } from './transcripts.ts';
import { readSubagentTranscript, SubagentTranscripts } from './adapters/claude/subagents.ts';
import { fileContext } from './adapters/claude/normalize.ts';
import type { Models } from './models/index.ts';
import { LATE_CHECK_LOST, LATE_CHECK_QUEUED, LATE_NEWS_KEPT_MS, localWhen } from './wake-when.ts';
import { parseWhen } from './when.ts';
import { SERVER_NAME } from './threadbear-mcp.ts';
import { archiveFromTool, bylineFromTool, END_TURN_TOOL, openAskState, runsFromTool, snoozeFromTool, waitForFromTool, WakeRead } from './needs.ts';
import { dropsStream, replyTurn, turnNeeds, type ReplyEvent, type ReplyMove, type ReplyOut } from './reply-phase.ts';
import { cliHears, cliOf, cliRuntime, runningSession, STALE, type CliEvent, type CliMove } from './cli-session.ts';
import type { Needs } from './needs.ts';
import { asksForAppRestart, MAX_AGE_MS as APP_RESTART_MAX_AGE_MS } from './app-restarts.ts';
import type { ConnectorsStatus } from './connectors.ts';
import type { TrustOffThread } from './trust-off-thread.ts';
import { PatchTrust, type ClaudeLook, type ClaudeVerdict, type PatchTrustStore } from './patch-trust.ts';
import { claudeOptions, claudeSettingsWithoutCommands, type ClaudeOptions } from './claude-trust.ts';
import {
  runCommand,
  simctlScreenshot,
  type CommandOutcome,
  type PatchCache,
  type PatchSet,
  type Screenshot,
  webPage,
} from './patches.ts';
import { cutSafely } from './safe-cut.ts';
import { DRAIN_AGENT_MS, DRAIN_BACKGROUND_MS, DRAIN_CHECK_MS, DRAIN_MAX_OLD_MS, DRAIN_SETTLE_MS, FOLDER_CACHE_MS, HOOK_TELL_CHARS, HOOK_TELL_LIMIT, LIVE_POLL_MS, LIVE_SHARE_MS, NO_WAKE_TIME, PATCHES_TTL_MS, SAVE_RETRY_MS, UNTIL_RESTART } from './runner/timings.ts';
export { DRAIN_AGENT_MS, DRAIN_BACKGROUND_MS, DRAIN_CHECK_MS, DRAIN_MAX_OLD_MS, DRAIN_SETTLE_MS, FOLDER_CACHE_MS, HOOK_TELL_CHARS, HOOK_TELL_LIMIT, LIVE_POLL_MS, LIVE_SHARE_MS, NO_WAKE_TIME, PATCHES_TTL_MS, SAVE_RETRY_MS, UNTIL_RESTART };
import { CARRY_ON_BACK, CARRY_ON_MOVED, CARRY_ON_NETWORK, CARRY_ON_RESTART, CARRY_ON_SIGNED_OUT, CARRY_ON_TOKEN, NET_CARRY_ON_MAX, NET_PROBE_FIRST_MS, NET_PROBE_MAX_MS, NET_WAIT_MAX_MS, STOPPED_CARRY_ON_MAX_AGE_MS, STOPPED_WORK_WAKES, STOPPED_WORK_WAKE_MAX_AGE_MS, WROTE_INSTEAD, isCarryOn, stoppedWorkMessage, unreadShellsMessage } from './runner/carry-on.ts';
export { CARRY_ON_BACK, CARRY_ON_MOVED, CARRY_ON_NETWORK, CARRY_ON_RESTART, CARRY_ON_SIGNED_OUT, CARRY_ON_TOKEN, NET_CARRY_ON_MAX, NET_PROBE_FIRST_MS, NET_PROBE_MAX_MS, NET_WAIT_MAX_MS, STOPPED_CARRY_ON_MAX_AGE_MS, STOPPED_WORK_WAKES, STOPPED_WORK_WAKE_MAX_AGE_MS, WROTE_INSTEAD, isCarryOn, stoppedWorkMessage };
import { TITLE_PROMPT, askedLine, checkImages, cleanTitle, fromMike, isAutomaticInput, matchAnswers, oneLine, scheduledMessageId, titleFrom, userMessage } from './runner/messages.ts';
export { TITLE_PROMPT, askedLine, checkImages, cleanTitle, fromMike, isAutomaticInput, matchAnswers, oneLine, scheduledMessageId, titleFrom, userMessage };
import { effortTitle, explicitModelKind, isClaudeModel, modelAccounts, modelRow, modelTitle, ModelListsPending } from './runner/models.ts';
export { effortTitle, isClaudeModel, modelRow, modelTitle };
import { newRuntime } from './runner/runtime.ts';
export { newRuntime };
import { FolderCache } from './folder-cache.ts';
import { worktreesPart, type WorktreesPart } from './runner/worktrees.ts';
import { networkPart, type NetworkPart } from './runner/network.ts';
import { poolsPart, type PoolsPart } from './runner/pools.ts';
import { handoversPart, type HandoversPart } from './runner/handovers.ts';
import { movesPart, type MovesPart } from './runner/moves.ts';
import type { ThreadMoving } from './moves.ts';
import { stoppedWorkPart, type StoppedWorkPart } from './runner/stopped-work.ts';
import { projectsHostPart, type ProjectsHostPart } from './runner/projects-host.ts';
import { approvalsPart, settleDeclined, type ApprovalsPart, type SecretAnswer } from './runner/approvals.ts';
import type { RequestAnswer } from './cross-runner.ts';
import { SecretStore } from './secrets.ts';
import { reviewsPart, type ReviewsPart } from './runner/reviews.ts';
import { buttonsPart, MAX_BUTTONS, type ButtonsPart } from './runner/buttons.ts';
import { clisPart, type ClisPart } from './runner/clis.ts';
import { editingPart, type EditingPart } from './runner/editing.ts';
import { patchesPart, type PatchesPart } from './runner/patches.ts';
import { withThreadId } from './patches.ts';
import { highlightsPart, type HighlightsPart } from './runner/highlights.ts';
import { ciRunsPart, type CiRunsPart, type CiShell } from './runner/ci-runs.ts';
import { prWatchPart, type PrWatchPart } from './runner/pr-watch.ts';
import type { PrWatchState } from './pr-watch.ts';
import type { Gh } from './land-gate.ts';
import { titlesPart, type TitlesPart } from './runner/titles.ts';
import { commandsPart, type CommandsPart } from './runner/commands.ts';
import { contextUsagePart, type ContextUsageAnswer, type ContextUsagePart } from './runner/context-usage.ts';
import type { SlashCommand } from './slash-commands.ts';
import { hibernationPart, leastAuthority, type HibernationPart } from './runner/hibernation.ts';
import { newThreadsPart, type NewThreadsPart } from './runner/new-threads.ts';
import { warmStartPart, type WarmStartPart, type Spare } from './runner/warm-start.ts';
import { LAB_REVIEW_ROUNDS, applyAnswers, fixedSinceLastRound, labReviewPart, ledgerCard, openFindings, parseVerdict, type LabReviewPart } from './runner/lab-review.ts';
import { looseEndsPart, WAITING_TO_LAND_RECHECK_MS, type LooseEndsPart } from './runner/loose-ends.ts';
import { quietInboxPart, type QuietInboxPart } from './runner/quiet-inbox.ts';
import { GUESS_CATCH_UP_MS, inboxGuessPart, type InboxGuessPart } from './runner/inbox-guess.ts';
import { nestedPart, type NestedPart } from './runner/nested.ts';
import { ceilingPart, type CeilingPart } from './runner/ceiling.ts';
import { mailPart, type MailPart } from './runner/mail.ts';
import { coldCompactPart, compactionResult, type ColdCompactPart, type Precompact } from './runner/cold-compact.ts';
import { COPIED_REFUSAL, neutraliseCopied, realCopy } from './real-copy.ts';
import type { YearTokenAnswer, YearTokenParams } from './year-token-maker.ts';
import { placeBucket, placeOf } from './place.ts';
import { allowed as waitMoveAllowed, waitStateOf, type WaitState } from './wait-state.ts';
import { archivedNote, hibernatedNote, scheduledNote, unarchivedNote, unscheduledNote, wokenNote } from './place-notes.ts';
import type { Coordinators, CoordinatorView } from './coordinators.ts';
import { COORDINATOR_TASK_WAKE } from './coordinator-asks.ts';

export type Notification =
  | { method: 'thread.updated'; params: { thread: ThreadSummary } }
  | { method: 'thread.event'; params: { threadId: string; event: AnyEvent } }
  | { method: 'thread.deleted'; params: { threadId: string } }
  | { method: 'accounts.updated'; params: { accounts: Account[] } }
  | { method: 'pools.updated'; params: { pools: Pool[] } }
  | { method: 'runner.notice'; params: { level: 'info' | 'warning' | 'error'; message: string } }
  | { method: 'schedules.updated'; params: { schedules: Schedule[] } }
  // Other runners' threads, from the backend (thread-index.ts, step 6 part 2).
  | { method: 'remoteThreads.updated'; params: import('./thread-index.ts').RemoteThreads }
  | { method: 'clis.updated'; params: { clis: CliStatus[] } }
  | { method: 'settings.updated'; params: { settings: Settings } }
  | { method: 'instructions.updated'; params: { instructions: import('./instructions.ts').StandingInstructions } }
  | { method: 'runner.updates'; params: { updates: RunnerUpdates } }
  | { method: 'projects.updated'; params: { projects: Project[] } }
  | { method: 'coordinators.updated'; params: { coordinators: CoordinatorView[] } }
  | { method: 'librarian.updated'; params: { librarian: LibrarianStatus } }
  | { method: 'connectors.updated'; params: { connectors: ConnectorsStatus } }
  | { method: 'recipes.updated'; params: Record<string, never> }
  // Only from a draining runner, to the primary (handover.ts).
  | { method: 'drain.handedOver'; params: { threadId: string } }
  | { method: 'drain.usage'; params: { accountId: string; reading: UsageReading } };

// hello's `updates` and runner.updates (docs/protocol/updates.md, "Runner updates").
export type RunnerUpdates = {
  state: 'off' | 'idle' | 'checking' | 'building' | 'waiting' | 'failed';
  commit?: string;
  subject?: string;
  reason?: string;
  oldRunners: { version: string; threads: string[] }[];
  launcherChanged?: true;
  launcherReason?: string;
  // The checkout this runner follows (install-runner.sh's), and what's
  // being done about launcherChanged (reinstall.ts).
  checkout?: string;
  reinstall?: ReinstallStatus;
  // Its reinstall stages for the next login rather than stopping everything
  // (from 15 Nov 2026).
  launcherStages?: true;
  // Mike's releases, for a fork (upstream.ts); left out while off.
  upstream?: UpstreamStatus;
  // This machine isn't following GitHub's main properly (follow-origin.ts).
  followProblem?: string;
  webRuntimeProblem?: string;
  // Behind, with nothing to do yet (waiting on cef-rs): the panel only.
  webRuntimeNote?: string;
  // The other runners that say that of themselves, on the main Mac's runner.
  behindRunners?: { name: string; problem: string }[];
  // Someone's own changes to the old Swift app not yet rebuilt in the GPUI
  // one (swift-changes.ts); left out while there are none.
  swiftChanges?: SwiftChangesStatus;
};

// What the librarian (librarian.ts) hears about threads: a turn that ended,
// and a folder move.
export type ThreadActivity =
  | { kind: 'turn.start'; threadId: string }
  // Any completed turn (its CLI's own too) in a thread another is waiting
  // on for something in particular, for the librarian to judge (met).
  | { kind: 'waited-on'; threadId: string }
  | { kind: 'turn.end'; threadId: string; outcome: TurnOutcome; edited: string[]; workedIn?: string[] }
  | { kind: 'moved'; threadId: string; from: string; to: string };

// The seams to D's and E's modules (usage.ts, updates/), as far as the
// runner uses them. They're structural so tests can pass small fakes.

// D's UsageStore, as the runner uses it: a session's `limits` output goes
// to record().
export type UsageSink = {
  record(accountId: string, reading: UsageReading): void;
  // Fired when what it knows changes enough to tell clients (UsageStore's
  // onChange). The runner then sends accounts.updated through its throttle.
  onChange?(fn: (accountIds: string[]) => void): () => void;
};

// E's CliUpdates, as the runner and rpc.ts use it.
export type CliControl = {
  list(): CliStatus[];
  check(p?: Provider): CliStatus[];
  update(p: Provider, o?: { version?: string; force?: boolean }): CliStatus[];
  setPolicy(p: Provider, policy: CliPolicy): CliStatus[];
  onChange(fn: (clis: CliStatus[]) => void): () => void;
  // Whether a session on `version` got going (its CLI reported a version)
  // or died before it did, for the "failed to start twice" warning.
  sessionStarted?(p: Provider, version: string | undefined, ok: boolean): void;
};

// What E's CliUpdates calls back into (its constructor's `hooks`).
export type CliHooks = {
  restartPending(): boolean;
  releaseIdle(p: Provider, keepVersion: string): void;
  versionsInUse(p: Provider): { version: string; threadIds: string[] }[];
  codexBinariesInUse(): string[];
};

// usage.ts's pickAccount: the account a thread made without one starts on.
export type AccountPicker = (accounts: Account[], lastUsedId: string | undefined) => string | undefined;

// AccountRegistry, plus the onChange D adds (fired when a rescan finds a
// different list).
export type AccountSource = Pick<AccountRegistry, 'list' | 'get' | 'learn'> & { onChange?(fn: () => void): () => void };
export type SignInSink = Pick<SignInState, 'noteRefused' | 'noteWorked' | 'onChange'> & Partial<Pick<SignInState, 'checkNow'>>;

// The Codex adapter reports the binaries its live processes run, so E only
// deletes version folders nothing uses. Not on AgentAdapter, since only
// Codex has it.
export type BinaryReporter = { binariesInUse?(): string[] };

// main: the card is for the agent's own tool call, so its CLI waits on it
// and reads nothing else until it's answered. A background subagent's card
// (no tool call of the agent's to point at) holds up only that subagent.
export type PendingApproval =
  // plan: the "Plan first" plan (its itemId) this approval is Claude's ExitPlanMode for.
  // macOnly: its whole input doesn't fit what the phone or another Mac's
  // view shows (tools.ts, remoteCardShowsAll), so only an allow from a
  // client that shows it all counts.
  // title: what it's asking, for telling the agent about a subagent's.
  // itemId and queued: the agent's call and the calls waiting behind it
  // on the same card (docs/protocol/threads.md, "Queued calls"), by itemId.
  | { approvalId: string; kind: 'tool'; main: boolean; title?: string; plan?: string; macOnly?: boolean; itemId?: string; queued?: Set<string>; fullAllows?: boolean; resolve: (a: ToolApprovalAnswer) => void }
  | { approvalId: string; kind: 'question'; main: boolean; title?: string; questions: Question[]; resolve: (a: QuestionAnswer) => void }
  // An agent's ask_secret (docs/protocol/threads.md, "Secrets"). The value never
  // passes through here: secrets.answer writes the file and hands this the
  // paths.
  | { approvalId: string; kind: 'secret'; main: boolean; resolve: (a: SecretAnswer) => void }
  // create_thread asking for a thread on another runner (cross-runner.ts).
  // check reads the backend's answer, which is the only one it believes.
  | { approvalId: string; kind: 'request'; main: boolean; start: { phase: 'waiting' } | { phase: 'authorized'; claims: ReadonlySet<string> }; expiresAt: number; check: () => Promise<RequestAnswer>; resolve: (a: RequestAnswer) => void };

export type Turn = {
  turnId: string;
  helperRunId?: string;
  startedAt: number;
  interruptRequested: boolean;
  // A slash command the runner answered itself (runner/commands.ts): no
  // CLI turn, and settings it changed apply from the next one.
  local?: boolean;
  // Started by a slash command the CLI runs. Its output (/cost's table,
  // /model's usage line) isn't a reply asking anything: without an
  // end_turn the turn leaves no card.
  command?: boolean;
  // A compaction or clear cannot schedule another compaction on this context.
  skipIdleCompaction?: boolean;
  // A compaction, review or clear: the CLI can't take words into it, so
  // they wait for the next turn. A skill's turn is an ordinary one.
  noSteer?: boolean;
  // A compaction sent ahead of the turn's message, which waits for it
  // (runner/cold-compact.ts).
  precompact?: Precompact;
  // Opened by the runner for work the CLI started itself (a background
  // shell or async subagent finished, or a background subagent asked for
  // approval). There's no user.message.
  auto?: boolean;
  // Shell jobs the CLI started during this turn, by id, so one it ends
  // without end_turn to wait for them stays unfinished (awaitedShells).
  shellsStarted?: Set<string>;
  // A message in it was more than the runner carrying an earlier turn on
  // (isCarryOn): new work, from Mike, a schedule, another thread or the
  // runner's own reports (settleInstructionsNews).
  newWork?: true;
  // A message in it was Mike's own: he's at the thread, so a check it does
  // or leaves owed needs no mark to tell him (completeTurn).
  byMike?: true;
  fromCoordinatorTasks?: true;
  // Already reminded this non-Mike wake turn about pending carry-on items.
  nextReminded?: true;
  // It did the check a wake gave the thread (runner/hibernation.ts,
  // wakeToCheck), so how it ends says whether Mike is needed (completeTurn).
  wakeCheck?: true;
  cliStarted?: boolean; // the CLI is running a turn for it (not just an approval)
  interruptTimer?: TimerHandle;
  // Ids of the messages the CLI has yet to answer for this turn: the one
  // that started it (none for a turn the CLI started itself), then any
  // sent while it ran, which go straight into the CLI. The turn ends when
  // the CLI has answered them all.
  messages: string[];
  modelOutput?: boolean;
  dispatched?: boolean;
  recoveredMessages?: number[];
  recoveryInput?: string;
  inputs?: Map<string, number>;
  // Each input's ceiling (runner/ceiling.ts), so one queued again after an
  // interrupted delivery keeps it.
  ceilings?: Map<string, PermissionMode>;
  deliveryKnown?: boolean;
  startedMessages?: Set<string>;
  cancelledMessages?: Set<string>;
  requeuedMessages?: Set<string>;
  foreignOutput?: boolean;
  // The most access the CLI has had in this turn (accessOf): a Codex turn
  // keeps the mode it started with when the thread is lowered mid-turn.
  access?: PermissionMode;
  // Files the turn edited, wrote or proposed to (edit.diff paths, Write
  // and Edit calls, denied ones too), for hooks that run only after a
  // change to certain files. Never trusted from: see 'wrote'.
  edited: Set<string>;
  // Folders its shell commands worked in (commandFolders), so the
  // librarian knows the repo a thread in a catch-all folder works on.
  workedIn?: Set<string>;
  // The reply phase, from endTurn to finalTexts: written only by
  // reply-phase.ts's replyTurn (Runner.reply), which says how they move.
  // The agent's own end_turn input and last text, for what the turn needs
  // from Mike (needs.ts). Never a sub-agent's.
  endTurn?: Record<string, unknown>;
  // The least access the thread had at any end_turn call this turn, for a
  // waitFor's `by` (hibernation.ts, mayHear): raised between the call and
  // the turn's end, it still asked with what it had (Codex's review of the
  // Daybreak fix, 12 Nov 2026).
  endTurnBy?: { mode: PermissionMode };
  // What endTurn was before the latest call, until that call's result says
  // whether it replaced it (a repeat doesn't).
  endTurnBefore?: Record<string, unknown>;
  // An end_turn of either form was taken (endTurnTaken): ended is only the
  // one-reply form's, and Codex's bullets form says "Noted. Now write".
  tookEndTurn?: boolean;
  lastText?: string;
  // The agent's latest end_turn call, and whether one was accepted since
  // Mike last wrote. Text after that is dropped: end_turn has already told
  // it to stop, yet an agent repeated its last line under it as a second
  // message (28 Oct 2026).
  endTurnCall?: string;
  // Its end_turn's summary is in the events as the turn's reply.
  summarized?: boolean;
  ended?: boolean;
  // The itemId of the agent's latest text when that was only a summary
  // (assistant.text with narration: a Claude narration block). The first
  // text after an accepted end_turn is then the real message, which
  // end_turn asked for (needs.ts, NARRATION_ONLY): it's kept, not dropped,
  // and takes the summary's itemId so it replaces it.
  narrationItem?: string;
  // The accepted end_turn brought bullets with no message since the last
  // step, and asked whether they stand for one not yet written (needs.ts,
  // BULLETS_ONLY): the first own text after it is that message, kept
  // rather than dropped (30 Oct 2026, thread 2a0a9c2c), when it says more
  // than the bullets, as the app takes it as the reply only then
  // (TranscriptReducer, reply(of:)): a "Done." under them is still a
  // repeat. The bullets' length, while it's owed.
  owedReply?: number;
  // One reply (docs/protocol/needs-you.md, "One reply"): the accepted end_turn said
  // the reply comes next, so the agent's text after it is kept, streamed
  // and marked `final`, the turn's reply. headline: end_turn gave one, and
  // it's the preview. replyNeeds: the reply ended in a "What I need from
  // you" section, which came off it and stands in for an end_turn with no
  // asks or follow-ups (needs.ts, splitReplySection).
  replyAfter?: boolean;
  headline?: boolean;
  replyNeeds?: Needs;
  // The Stop hook sent this turn back to call end_turn, so what it already
  // wrote is the reply (threadbear-mcp.ts, needs.ts oneReplyAlreadyWritten).
  endTurnNudged?: boolean;
  // ...or back for a card its reply asked for, after an end_turn it took:
  // the next end_turn is that card, not a repeat (needs.ts, REPLY_ASKS).
  cardReopened?: boolean;
  // The reply a one-reply turn wrote after its last end_turn (the texts
  // marked final, by item: a reply can come as several blocks), written
  // again under a reopened turn's card once it's taken (onOutput).
  finalTexts?: Map<string, string>;
  // ...for a reply that links files that aren't there (needs.ts,
  // missingLinksNudge): that end_turn asks for a whole new reply, which the
  // apps show in the first one's place, as they do after any later card.
  replyRewrite?: boolean;
  // Whether the agent has read a background task's notification that came
  // into the turn (needs.ts, WakeRead).
  wake?: WakeRead;
};

export type TurnHold = 'save' | 'setup' | 'broken' | 'token' | 'handover';

export type Runtime = {
  // On its way to another runner (runner/moves.ts): no turn starts.
  moving?: ThreadMoving;
  // Box mode (runner/moves.ts holdTurns): no turn starts while any of these
  // holds it: 'save', a box's thread saved to sleep or be archived, until
  // the backend says it may run again (box-save.ts SaveHold); 'broken', a
  // box that can't use its folder (box-mode.ts, degraded);
  // the box is resumed or sent something; 'setup', a restored worktree's
  // setup still running; 'token', its cloud token refused, until a newer
  // one comes (holdForToken). Messages wait in the queue meanwhile.
  holds?: Set<TurnHold>;
  // A restored worktree's setup running (setUpRestored): a writer a
  // stopping save waits for.
  restoreSetup?: Promise<void>;
  session?: AgentSession;
  // A CLI started ahead of this new thread (runner/warm-start.ts), until
  // its first start takes it or finds it doesn't fit.
  spare?: Spare;
  generation: number;
  closing?: Promise<void>;
  releasedGen?: number; // generation of the session being released on purpose
  resumed: boolean; // the live session was started with resume
  retriedFresh: boolean;
  // News of the standing instructions went out in this turn (settleInstructionsNews).
  instructionsNewsSent?: boolean;
  // Where the live session's transcript was carried from, if it moved
  // folder; used only if resuming the copy fails.
  carried?: ThreadRecord['handoff'];
  // The provider the live CLI runs, which a move to another provider
  // changes on the record before this CLI has gone.
  sessionProvider?: Provider;
  // The login the live CLI runs on. Changing a thread's login (update, a
  // move) sets the record's at once while this CLI finishes its turn, so
  // a reading it gives is that login's, not the record's new one.
  sessionAccountId?: string;
  deleted?: boolean; // anything the old CLI still reports is dropped
  // Deleted by Mike or an agent (delete()), not let go to another runner
  // (letGo sets deleted too): only then is a worktree still being set up
  // removed when its setup ends.
  trashed?: boolean;
  turn?: Turn;
  // When the live CLI last said anything, and whether it looks frozen
  // (frozen-cli.ts): the check's clock, and what an interrupt has to know.
  lastOutputAt?: number;
  frozen?: boolean;
  tasks: BackgroundTask[]; // background work the live CLI is running
  // The version of the CLI running the live session, from its cliVersion
  // output (Codex reports it; Claude doesn't yet).
  cliVersion?: string;
  // A CLI update came in while this session ran on the old version: it's
  // released the next time it's idle (no turn, approval, queued message,
  // background work or wake grace), and the next message resumes on the
  // new one. Background work is never stopped for it.
  versionMove?: boolean;
  // The live Claude session started without the folder's own Claude Code
  // settings, as they run commands that aren't trusted: the hash it
  // skipped (claude-trust.ts). `claudeNoted` is the last one said in the
  // thread, so a session restart doesn't say it again.
  claudeSkipped?: string;
  // A look at the folder's Claude Code settings on the trust worker for the
  // message at the front of the queue, before it starts a turn on the live
  // CLI (kickQueue). Taken before the turn exists, so the CLI's own turns
  // meanwhile (a background task waking it) go as they always did. `looks`
  // or `failed` once it's done; used only straight away, else dropped.
  // `front`, `cwd` and `grants`: the message, folder and kind it was for;
  // a look for anything else is dropped and taken again.
  preLook?: { token: object; front: string; cwd: string; grants: boolean; looks?: ClaudeLook[]; failed?: string };
  // Started in Full with the folder's settings, which hold permission
  // rules not trusted for a thread that asks first (StartSessionOptions.heldGrants).
  claudeHeldGrants?: boolean;
  claudeNoted?: string;
  // The last patch said to make every edit ask (noteEditsAsk), so it's said once.
  editsAskNoted?: string;
  // The installed version when the live session was started (what E says
  // new sessions start on), and whether it has got going since.
  startVersion?: string;
  started?: boolean;
  // Archived here while its CLI was live: archived in the CLI's own app
  // once that CLI has exited, so a second process never touches the thread
  // while the live one still has it loaded.
  archivePending?: boolean;
  // Its last save failed and it's waiting to be tried again (flush), and
  // whether nothing has changed since, so the retry tells nobody.
  saveFailed?: boolean;
  saveRetry?: boolean;
  // The archived thread's worktree cleanup while it runs: a handover waits
  // for it before saving the record, or its result is lost (THREADBEAR-16).
  cleaning?: Promise<void>;
  // A new thread's worktree being made and set up (prepareWorktree): a
  // turn started meanwhile (Stop, then a new message) waits for it, or its
  // CLI would start in the main checkout or before the setup is done; an
  // archive's or a delete's cleanup waits too, rather than remove the
  // folder from under the setup.
  preparing?: Promise<void>;
  // Background work that ended and whose result the CLI hasn't started a
  // turn to read yet. Shown as `finished` in the summary's background list
  // while wakeTimer runs; cleared when that turn starts or the grace ends.
  finished: BackgroundTask[];
  // Set when background work finished with no turn running: the CLI is
  // about to start a turn of its own to look at the result, and until it
  // does (or WAKE_GRACE_MS passes) the thread isn't idle.
  wakeTimer?: TimerHandle;
  // Background work finished while a turn was running. If the model was
  // already writing its last message, the CLI holds the notification and
  // starts a turn of its own after the result, so the wake grace starts
  // when the turn ends.
  taskEndedInTurn?: boolean;
  // Shell jobs the last turn started and then ended without end_turn, on a
  // CLI that wakes when they end: the agent is waiting on them mid-work
  // (OpenCode's "end your response; you will be resumed"), so the thread
  // isn't Mike's yet while one runs or its result is about to be read.
  // A turn that took end_turn leaves none: a shell after its card is often
  // a dev server or a watcher for Mike (agentsStillWorking). Each stays
  // until it's read: a wake turn opening drops the ended ones, and so does
  // a wake grace running out with no turn going (pruneAwaited).
  awaitedShells?: string[];
  // The runner's nudge for an awaited shell the CLI never woke for, while
  // it waits in the queue (nudgeUnreadShells): the thread is still mid-work,
  // and a late wake of the CLI's own takes it back out.
  nudgeTurnId?: string;
  // A done card that would have finished the thread (markFinished, then
  // the quiet-inbox and inbox-guess steps) but for background work that
  // ended during or just before its turn: the turn the CLI may open to read
  // that result. Mid-turn the CLI usually folds the result into the turn
  // it's in and opens none, so once the wake grace passes with no turn
  // (or the CLI exits) it finishes after all (settlePendingFinish).
  finishPending?: { seq: number; turnId: string; lastText?: string; next: boolean; owed?: { turnId: string; seq?: number; reply?: string } };
  // The helper's last result, held while a queued update, background job
  // or network retry could start another turn (settleHelperPending). Keep
  // its CLI for the same interval rather than evicting it for room.
  helperPending?: { outcome: TurnOutcome; text: string; turnId: string };
  activeAt: number; // last turn start or end, for picking which CLI to release
  approvals: Map<string, PendingApproval>;
  // Calls the card reviewer is deciding on (runner/card-review.ts), which
  // have no card yet: Stop, the turn ending or Mike writing settles them as
  // it would a card. `main`: the agent's own call, not a subagent's.
  // `stale`: a subagent's, which Mike wrote during: its verdict was made
  // without his message, so it goes to him as a card.
  reviews?: Map<string, { main: boolean; fullAllows?: boolean; cancel: (a: ToolApprovalAnswer) => void; stale?: boolean }>;
  idleTimer?: TimerHandle;
  releaseWhenIdle: boolean;
  inProgress: Map<string, InProgressItem>;
  pendingDeltas: Map<string, { type: DeltaType; text: string }>;
  deltaTimer?: TimerHandle;
  // What the folder's patches give the thread (patches.ts). Read again in
  // the background when the folder changes or PATCHES_TTL_MS has passed,
  // and a new summary goes out if anything differs, so a `convex dev` that
  // has just written .env.local, or a patch file the agent has just
  // written, shows up within seconds. Until the first read finishes the
  // built-in panels stand in.
  // `base` is the set as the files give it; `set` is that with live state
  // applied (applyLive), which is what the app sees. `live`: base has any.
  // `pressed`: each panel button's panel a press put in `set`, by the
  // `presses` count then, so a read that started before it keeps it.
  patches?: { cwd: string; key: string; at: number; base: PatchSet; set: PatchSet; refreshing: boolean; again?: boolean; read?: Promise<void>; loaded: boolean; live?: boolean; presses?: number; pressed?: Map<string, number> };
  runningActions?: Set<string>;
  // Turns in a row that a hook's message started, per hook. A hook that
  // keeps failing stops being told to the agent after HOOK_TELL_LIMIT, so
  // two can't go round for ever; a message from anyone else resets it.
  hookTurns?: Map<string, number>;
  // Turn-end hooks still running; a draining runner waits for them, since
  // one may tell the agent something and start a turn.
  hooksRunning?: number;
  // A show_panel call waiting to hear the app has shown its request
  // (threads.panelShown), for at most PANEL_ACK_WAIT_MS.
  panelWaiter?: { id: string; resolve: (shown: boolean) => void; timer: TimerHandle };
  // An edit of an earlier message is under way (editMessage): nothing
  // starts a turn until it has, and messages sent meanwhile wait.
  editing?: boolean;
  // Called when the running turn ends (endTurn), for an edit waiting on it.
  turnEndWaiters?: (() => void)[];
  // The done card's loose-ends check (runner/loose-ends.ts): which run is
  // the latest, so an older one finishing late is dropped, and when it began.
  looseEndsRun?: number;
  looseEndsAt?: number;
  // The wait state its last summary said (wait-state.ts), so a move the
  // table doesn't list is logged.
  waitState?: WaitState;
  // A loose-ends check is running: opening the thread doesn't start another.
  looseEndsBusy?: boolean;
  // That check's look at git, while it's going (LooseEndsPart.checkLooseEnds).
  looseEndsGather?: Promise<LooseEnd[]>;
  // The card (its seq) of a finished helper that would have archived
  // itself but for threads it started still going: it looks again as each
  // of them finishes (runner/quiet-inbox.ts).
  quietOnceChildrenDone?: number;
  // GitHub Actions runs (runner/ci-runs.ts): itemIds of push/workflow commands,
  // the next look timer, and whether a look is in flight.
  ciCalls?: Set<string>;
  ciTimer?: TimerHandle;
  ciChecking?: boolean;
};

export type ThreadState = { rec: ThreadRecord; rt: Runtime };

export type Drain = {
  keep: Set<string>;
  going: Set<string>; // being let go
  gone: Set<string>; // let go: the new runner's now (mustGet)
  onHandedOver: (threadId: string) => void;
  since: number;
  backgroundMs: number;
  agentMs: number;
  checkMs: number;
  checkQueued: boolean;
  ready: () => boolean;
  timer?: TimerHandle;
  // When this drain first saw each open card on a kept thread (lapseCards).
  cardsSince: Map<string, number>;
  // Threads whose cards lapsed, with their titles, told as they go across.
  lapsed: Map<string, string[]>;
  cardMs: number;
};

export type RunnerDeps = {
  // Box mode (src/box-mode.ts): the one thread this runner exists for
  // (Runner.boxThread), known before start loads anything from disk.
  boxThread?: string;
  // What holds that thread's turns from the moment it loads, before any
  // recovery or carry-on: 'setup', its restored worktree's setup still to
  // run (Runner.setUpRestored lets it go); 'broken', a box in its degraded
  // state (box-mode.ts).
  boxHolds?: TurnHold[];
  // A message that answers the thread's open card (`answers`, which only
  // the app, the phone and the website send: an agent's are taken out,
  // rpc-gate.ts), with that card's asks. For an answer the runner acts on
  // itself, like the full sync question's (main.ts).
  answered?: (threadId: string, answers: AskAnswer[], card: Ask[] | undefined) => void;
  // The release it runs, when not this code's own (tests).
  release?: string;
  // A thread's RPC credential, for its CLI's environment (rpc-auth.ts).
  // Without it (tests), a thread's tb reads the token as before.
  threadKey?: (threadId: string) => string;
  config: Config;
  store: ThreadStore;
  adapters: Record<string, AgentAdapter>;
  accounts: AccountSource;
  // D's UsageStore: live readings go to it, and its changes reach clients.
  usage?: UsageSink;
  // Which logins are signed out (sign-in-state.ts): told of refused and
  // working turns, and its changes reach clients.
  signIn?: SignInSink;
  // Year-long token… asked from another Mac (year-token-maker.ts).
  tokenMaker?: { step(account: Account, p: YearTokenParams): Promise<YearTokenAnswer>; stopAll(): void };
  // Which account a thread made without one starts on; usage.ts's
  // pickAccount (the most room) unless a test swaps it.
  pickAccount?: AccountPicker;
  clock: Clock;
  log: Logger;
  // Coalesces summary saves and thread.updated; tests pass a synchronous one.
  defer?: (fn: () => void) => void;
  // Copies a Claude session's transcript to another folder (transcripts.ts);
  // tests swap it out.
  copyTranscript?: typeof copySessionTranscript;
  // Where a sub-agent's transcript is (transcripts.ts); tests point it at a fixture.
  subagentTranscript?: typeof subagentTranscriptPath;
  // Takes the Simulator panel's screenshot (patches.ts); tests pass a fake.
  screenshot?: Screenshot;
  // Where patches stop being looked for up the folder tree (the home folder).
  panelsRoot?: string;
  // Which project patch files may load (patch-trust.ts). Defaults to
  // patch-trust.json in the data dir; tests not about trust pass TRUST_ALL.
  patchTrust?: PatchTrustStore;
  // The trust worker (trust-off-thread.ts) for the slow parts of reading a
  // folder's patches; without one they run on the main thread (tests).
  offThread?: TrustOffThread;
  // The shell command actions run through, and how long they may take;
  // tests pass /bin/sh -c and a short limit.
  actionShell?: string[];
  actionTimeoutMs?: number;
  // A worktree's setup and turn hooks run at background priority
  // (background.ts) unless this is false. Tests not about priority turn it
  // off, as a background shell can wait seconds for a core on a busy Mac.
  backgroundJobs?: boolean;
  // Opens a url action's page, for an app too old to open it itself
  // (runAction); tests pass a fake rather than starting a browser.
  openUrl?: (url: string) => Promise<void>;
  // Runs the Convex CLI for the Convex panel's deploy keys (convex-keys.ts);
  // tests pass a fake that writes the key file the CLI would.
  convexKeyRun?: (command: string, cwd: string) => Promise<CommandOutcome>;
  convexKeyOptions?: ConvexKeysOptions; // the CLI's login file, sign-in command and key check, for tests
  // The runner's own small-model calls (models/index.ts), for titles.
  // Absent in most tests, which then keep the first-line title.
  models?: Pick<Models, 'generate'>;
  // Projects (projects.ts): their folders' patches, the brief a session
  // starts with, and the summary's `projects`. Started by start().
  projects?: Projects;
  /** Mike's standing instructions for every session (instructions.ts); '' for none. */
  standingInstructions?: () => string;
  // A completed turn asked Mike to Restart to Update, by end_turn or in its
  // closing "What I need from you" (app-restarts.ts signs the thread up).
  appRestartAsked?: (threadId: string) => void;
  // Whether the thread is waiting to hear the app restarted onto a new
  // build (wait_for_app_restart), so a done turn hibernates until it has.
  awaitingAppRestart?: (threadId: string) => boolean;
  // The commit it waits for the app to have (AppRestarts.waitingFor).
  appRestartWant?: (threadId: string) => { commit?: string; short?: string } | undefined;
  // Whether Mike is at this Mac, as presence last found it (presence.ts);
  // undefined when it hasn't been checked. Only read for phone messages.
  atMac?: () => boolean | undefined;
  // Whether a provider's API can be reached (net-probe.ts), for threads
  // whose turn failed because it couldn't be; tests pass a fake.
  reachable?: Reachable;
};

// The note Mike's pick from the done card's Archive menu leaves in the
// thread (threads.update's verdict).
const ARCHIVE_NOTES: Record<ArchiveVerdict, string> = {
  worked: 'Archived by you: it worked.',
  didntWork: "Archived by you: it didn't work.",
  notNeeded: 'Archived by you: not needed any more.',
  didntNeedToSee: "Archived by you: didn't need to see this.",
  gladISaw: 'Archived by you: glad to have seen this.',
  notSure: 'Archived by you: not sure you needed to see this.',
};

const DELTA_INTERVAL_MS = 33; // at most ~30 delta flushes a second per thread
// An interrupted turn that the CLI hasn't ended by then is ended anyway, so
// a CLI that never answers can't leave a thread stuck as running.
const INTERRUPT_GRACE_MS = 10_000;
// How long notices from startup are shown to clients that connect later.
const STARTUP_NOTICE_MS = 10 * 60_000;
// How long a finished background task keeps the thread counted as busy
// while the CLI gets round to its own turn (usually well under a second).
const WAKE_GRACE_MS = 15_000;
// kickQueue's look for a turn on the live CLI, or why it couldn't look.
type LiveLook = ClaudeLook[] | { failed: string };

// The look of `looks` for this folder and kind of thread, if there is one.
function lookFor(looks: ClaudeLook[] | undefined, cwd: string, opts: ClaudeOptions): ClaudeLook | undefined {
  return looks?.find((l) => l.cwd === cwd && l.grants === (opts.grants === true));
}

// The kinds of thread (grants or not) a look must cover: the thread's own,
// and for a new CLI in Full the asking kind too (startSession's two checks).
function lookKinds(rec: ThreadRecord, forStart: boolean): boolean[] {
  return forStart && rec.permissionMode === 'full' ? [false, true] : [claudeOptions(rec).grants === true];
}

// Whether `looks` still answers for the thread as it is now: its folder and
// access may have changed while they were taken.
function looksCover(looks: ClaudeLook[] | undefined, rec: ThreadRecord, forStart: boolean): boolean {
  return lookKinds(rec, forStart).every((grants) => lookFor(looks, rec.cwd, { grants }) !== undefined);
}

// (and its models asked for) without a client asking.
const ACCOUNT_RESCAN_MS = 10_000;
// accounts.updated: the first change goes out at once, then at most one
// this often, always ending on the latest list.
const ACCOUNTS_THROTTLE_MS = 5_000;
// Parts of the Runner that live in runner/ (see each file's top).
export interface Runner extends LooseEndsPart, QuietInboxPart, InboxGuessPart, NestedPart, CeilingPart, MailPart, ColdCompactPart, LabReviewPart, NewThreadsPart, HibernationPart, TitlesPart, HighlightsPart, CiRunsPart, PrWatchPart, PatchesPart, EditingPart, ClisPart, ReviewsPart, ButtonsPart, ApprovalsPart, ProjectsHostPart, StoppedWorkPart, HandoversPart, PoolsPart, NetworkPart, WorktreesPart, CommandsPart, ContextUsagePart, MovesPart, WarmStartPart {}
export class Runner {
  // While main.ts is still starting up: waking a thread for its waits
  // (reconcileWaits) would start a CLI whose tools aren't ready, so they
  // wait for main.ts's own reconcileWaits once it's listening.
  holdWaits = false;
  // The schedules that send to a thread (main.ts sets it from the
  // Scheduler), for the done card's loose ends.
  schedulesFor?: (threadId: string) => Schedule[];
  // The schedule checks this runner runs by itself, and where (main.ts sets
  // it from the Scheduler), for writeRunsAsCode.
  scheduleChecks?: () => { command: string; cwd: string }[] & { unknown?: boolean };
  // The release this runner runs (none from a source checkout), for
  // threads hibernating until a new one (snoozedUntil "release"). Tests set it.
  release: string | undefined = RELEASE.release;
  cfg: Config;
  store: ThreadStore;
  adapters: Record<string, AgentAdapter>;
  accounts: AccountSource;
  usage?: UsageSink;
  signIn?: SignInSink;
  private tokenMaker?: RunnerDeps['tokenMaker'];
  // Each login and folder's slash commands, for the picker (runner/commands.ts).
  commandCache = new Map<string, { at: number; commands: SlashCommand[] }>();
  // threads.contextUsage asks in flight, by thread, so two at once share one.
  contextAsks = new Map<string, Promise<ContextUsageAnswer>>();
  // PR auto-fix's watch (runner/pr-watch.ts): its state once read, the next
  // look, whether one is under way, and gh (tests set a fake).
  prWatch?: PrWatchState;
  prWatchTimer?: TimerHandle;
  prWatchBusy?: boolean;
  prWatchGh?: Gh;
  // Runs `gh` and `git` for GitHub Actions runs (runner/ci-runs.ts); tests
  // set a fake.
  ciShell?: CiShell;
  pickAccount: AccountPicker;
  clis?: CliControl;
  clock: Clock;
  log: Logger;
  defer: (fn: () => void) => void;
  copyTranscript: typeof copySessionTranscript;
  subagentTranscript: typeof subagentTranscriptPath;
  screenshot: Screenshot;
  panelsRoot?: string;
  actionShell?: string[];
  actionTimeoutMs?: number;
  backgroundJobs: boolean;
  openUrl: (url: string) => Promise<void>;
  convexKeys: ConvexKeys;
  // Where answers to ask_secret go, and the key the phone seals them to.
  secrets: SecretStore;
  models?: Pick<Models, 'generate'>;
  projects?: Projects;
  standingInstructions?: () => string;
  coordinators?: Coordinators;
  activity = new Set<(a: ThreadActivity) => void>();
  patchCache: PatchCache = new Map();
  patchTrust: PatchTrustStore;
  offThread?: TrustOffThread;
  folderCache: FolderCache;
  sharedPatchSets = new Map<string, { at: number; set: Promise<PatchSet> }>();
  patchReads = new Set<Promise<void>>();
  liveRuns = new Map<string, { doneAt?: number; out: Promise<CommandOutcome> }>();
  // Each folder's Claude settings verdict for its patch list, read again
  // as often as the folders are (claudePatchInfo).
  claudeChecks = new Map<string, { at: number; look?: ClaudeLook; verdict?: ClaudeVerdict }>();
  // Bumped by forgetFolders: a look begun before it isn't kept.
  claudeChecksGen = 0;
  threads = new Map<string, ThreadState>();
  // Other runners' names by id, for what a move says (main.ts sets it).
  runnerNames?: (runnerId: string) => string | undefined;
  // True on the main Mac (the owner key): a thread moved here from another
  // runner arrives with at most Ask (runner/moves.ts capMovedMode).
  movedInAtMostAsk?: () => boolean;
  // A login's week going unused (spare-week.ts; main.ts sets it).
  spareWeek?: SpareWeek;
  // Whether a Threadbear app of this runner's own is here or was lately
  // (app-seen.ts): without one, a card only it could allow is refused at
  // once rather than put up (approvals.ts). Left out (tests), there is one.
  appCanAllow?: () => boolean;
  // This runner's name, for what such a refusal says (main.ts sets it).
  ownName?: string;
  // Box mode (src/box-mode.ts): the one thread this runner exists for. Any
  // other new thread is refused (makeThread), and that one only under its id.
  boxThread?: string;
  boxHolds: TurnHold[] = [];
  // Box mode: told when a turn is refused with the box's cloud token, to say so
  // to the backend and watch for a newer one (main.ts, box-token.ts).
  onBoxTokenRefused?: (threadId: string) => void;
  // Box mode: the version of the cloud token on the box (box.json's tokenSetAt), which a refusal records.
  boxTokenSetAt?: () => number | undefined;
  listeners = new Set<(n: Notification) => void>();
  dirty = new Set<string>();
  flushScheduled = false;
  saveRetryTimer?: TimerHandle;
  snoozeTimer?: TimerHandle;
  stopping = false;
  // Set while this runner drains after a handover (docs/protocol/updates.md,
  // "Handovers"): the threads it still keeps, and who hears when one goes.
  draining?: Drain;
  // The CLI started ahead of a new thread the app is writing
  // (runner/warm-start.ts).
  spare?: Spare;
  refusing?: string;
  startedAt = 0;
  startupNotices: { level: 'info' | 'warning' | 'error'; message: string }[] = [];
  // settleUnvouched has run: a handover's adopt can come before start.
  unvouchedSettled = false;
  // Accounts whose CLI has been asked for its models (or is being asked).
  probed = new Set<string>();
  private modelProbes = new Map<string, Promise<void>>();
  rescanTimer?: TimerHandle;
  landRecheckAt = 0;
  liveTimer?: TimerHandle;
  accountsTimer?: TimerHandle;
  accountsSentAt = -Infinity;
  accountsShown?: string; // the last list clients were sent (or got in hello's time)
  // E's last Codex status, to notice an update activating (or a first
  // copy arriving where there was none) as against E working out what's
  // installed when it starts.
  codexVersion?: string;
  codexMissing = false;
  // The version E last asked sessions to move to, per provider.
  wantedVersion: Partial<Record<Provider, string>> = {};
  unsubs: (() => void)[] = [];
  // Pools (docs/protocol/settings.md, "Pools"): the timer for threads waiting for
  // room, the list clients were last sent, and logins a turn found at
  // their limit, blocked here until the time given even when the usage
  // readings haven't caught up.
  roomTimer?: TimerHandle;
  armingRoom = false;
  poolsShown?: string;
  // Pools shared through the backend (shared-pools.ts); main.ts sets it
  // when sync is on. Without it, or until it has a list, the pools are
  // runner.json's or the built-in ones.
  sharedPools?: import('./shared-pools.ts').SharedPools;
  ranDry = new Map<string, number>();
  // Logins limit-recheck.ts read back with room after a turn ran them dry
  // (recordReading). A pool thread waiting on its own one carries on there
  // (armRoomTimer); running dry again takes it out (markRanDry).
  readBack = new Set<string>();
  // The room each of those logins read as when it ran dry (markRanDry).
  dryRoom = new Map<string, number>();
  // Threads waiting for the API to be reachable again (waitingForNetwork):
  // one timer probes for all of them, backing off from NET_PROBE_FIRST_MS.
  netTimer?: TimerHandle;
  netProbes = 0;
  probing = false;
  reachable: Reachable;
  appRestartAsked?: (threadId: string) => void;
  awaitingAppRestart?: (threadId: string) => boolean;
  appRestartWant?: (threadId: string) => { commit?: string; short?: string } | undefined;
  atMac?: () => boolean | undefined;

  private threadKey?: (threadId: string) => string;
  private answered?: RunnerDeps['answered'];
  constructor(deps: RunnerDeps) {
    if (deps.boxThread !== undefined) this.boxThread = deps.boxThread;
    this.boxHolds = deps.boxHolds ?? [];
    this.threadKey = deps.threadKey;
    this.answered = deps.answered;
    if ('release' in deps) this.release = deps.release;
    this.cfg = deps.config;
    this.store = deps.store;
    this.copyTranscript = deps.copyTranscript ?? copySessionTranscript;
    this.subagentTranscript = deps.subagentTranscript ?? subagentTranscriptPath;
    this.screenshot = deps.screenshot ?? simctlScreenshot;
    this.panelsRoot = deps.panelsRoot;
    this.patchTrust = deps.patchTrust ?? new PatchTrust({ file: path.join(deps.config.home, 'patch-trust.json') });
    this.offThread = deps.offThread;
    this.actionShell = deps.actionShell;
    this.actionTimeoutMs = deps.actionTimeoutMs;
    this.backgroundJobs = deps.backgroundJobs ?? true;
    this.openUrl = deps.openUrl ?? openInBrowser;
    this.convexKeys = new ConvexKeys(
      path.join(paths.secrets(deps.config.home), 'convex-panels'),
      deps.convexKeyRun ?? ((command, cwd) => runCommand(command, { cwd, env: { ...process.env }, shell: this.actionShell, timeoutMs: 120_000 })),
      undefined,
      deps.convexKeyOptions,
    );
    this.secrets = new SecretStore(paths.secrets(deps.config.home), () => this.clock.now());
    this.models = deps.models;
    this.projects = deps.projects;
    this.standingInstructions = deps.standingInstructions;
    this.appRestartAsked = deps.appRestartAsked;
    this.awaitingAppRestart = deps.awaitingAppRestart;
    this.appRestartWant = deps.appRestartWant;
    this.atMac = deps.atMac;
    this.adapters = deps.adapters;
    this.accounts = deps.accounts;
    this.usage = deps.usage;
    this.signIn = deps.signIn;
    this.tokenMaker = deps.tokenMaker;
    this.pickAccount = deps.pickAccount ?? pickByRoom;
    this.clock = deps.clock;
    this.folderCache = new FolderCache(FOLDER_CACHE_MS, () => this.clock.now());
    this.log = deps.log;
    this.defer = deps.defer ?? ((fn) => setImmediate(fn));
    this.reachable = deps.reachable ?? reachable;
  }

  // ---------------------------------------------------------------- startup

  // Loads threads from disk. Threads that were mid-turn when the runner
  // stopped become `stopped`; approvals they were waiting on expire.
  //
  // `skip` are threads a draining runner still has (a handover): they stay
  // on disk untouched until it hands them over and adopt() loads them.
  start(opts: { skip?: ReadonlySet<string>; deferBackground?: boolean } = {}): void {
    this.startedAt = this.clock.now();
    // A login that reads as out gets read again now and then, so a reset
    // made outside Threadbear lifts it (limit-recheck.ts).
    if (this.usage) {
      const usage = this.usage;
      this.limitRecheck = new LimitRecheck({ clock: this.clock, log: this.log, accounts: () => this.safeAccounts(), adapters: this.adapters, record: (id, r) => this.recordReading(usage, id, r), dry: (id) => (this.ranDry.get(id) ?? 0) > this.clock.now() });
      this.limitRecheck.start();
    }
    let { records, broken } = this.store.loadAll();
    // A box runs its one thread: any other record on disk is left alone
    // (not loaded, recovered, carried on or rebuilt), and said.
    if (this.boxThread !== undefined) {
      const mine = (id: string) => id === this.boxThread;
      const others = [...records.map((r) => r.id), ...broken].filter((id) => !mine(id));
      if (others.length) this.log.warn("box: left alone thread records that aren't its own", { threads: others });
      records = records.filter((r) => mine(r.id));
      broken = broken.filter(mine);
    }
    // Which worktrees the always-trust doesn't reach, before anything below
    // can read a patch or start a CLI (runner/moves.ts): every thread on
    // disk, a draining runner's included, and before a record that can't be
    // read is rebuilt without its worktree.
    this.settleUnvouched(records, broken);
    for (const id of broken) {
      if (opts.skip?.has(id)) continue;
      // One at a time too: a log that can't be rebuilt from stays as it is.
      try {
        const rec = this.rebuild(id);
        if (rec) records.push(rec);
      } catch (e) {
        this.log.error("couldn't rebuild a thread's record", { threadId: id, error: String(e) });
      }
    }
    // A dev runner on a copy of the real data dir: its threads name real
    // sessions and folders, so none of them may run (real-copy.ts).
    const copy = realCopy(this.store.home);
    if (copy) for (const rec of records) this.store.save(neutraliseCopied(rec, copy.work));
    let stopped = 0;
    for (const rec of records) {
      if (opts.skip?.has(rec.id)) continue;
      // thread.json is saved a moment after the event it follows; the log
      // is the truth for seq. Quiet archived threads keep their saved seq
      // until opened so startup doesn't open thousands of archived logs.
      const archivedQuiet =
        Boolean(rec.archivedAt) &&
        rec.status !== 'running' &&
        rec.status !== 'starting' &&
        rec.status !== 'waiting' &&
        rec.queue.length === 0 &&
        rec.pendingApprovals.length === 0 &&
        !rec.stoppedMidTurn &&
        !rec.stoppedWork &&
        !rec.reviews?.some((r) => r.status === 'pending') &&
        typeof rec.lastSeq === 'number' &&
        Number.isInteger(rec.lastSeq) &&
        rec.lastSeq >= 0;
      if (!archivedQuiet) rec.lastSeq = this.store.log(rec.id).lastSeq;
      const st: ThreadState = { rec, rt: newRuntime(Date.parse(rec.lastActivityAt) || 0) };
      // A box's restored thread: nothing starts (recovery, a carry-on, a
      // wake) until its worktree's setup has run (setUpRestored).
      if (this.boxHolds.length && rec.id === this.boxThread) st.rt.holds = new Set(this.boxHolds);
      // A box's thread still waiting for a cloud token when it stopped waits again.
      if (rec.waitingForToken && rec.id === this.boxThread) (st.rt.holds ??= new Set()).add('token');
      this.threads.set(rec.id, st);
      // One thread's record that trips something here (a field another
      // runner wrote wrong: a moved thread's `presses: {}` stopped every
      // start, security review 11 Nov 2026) costs that thread its
      // recovery, not the runner.
      try {
        if (rec.asked === undefined && !rec.archivedAt) this.backfillAsked(rec);
        this.recoverReviews(st);
        if (this.recover(st)) stopped++;
      } catch (e) {
        this.recoveryFailed(st, e);
      }
    }
    // carryOnStopped (main.ts, once listening) carries most of them on and
    // says so; this notice is for a runner that never gets that far.
    if (stopped) this.startupNotice('info', `${stopped === 1 ? 'A thread was' : `${stopped} threads were`} mid-turn when the runner stopped.`);
    // Hibernating until the runner restarts: this is the restart. Before
    // the restart's resume (main.ts), so a thread put away while its own
    // restart waited still gets carried on.
    // A wake-when still being worked out lost its answer with the old
    // runner, so it comes back too.
    this.bindOldWakeCeilings();
    for (const st of this.threads.values()) {
      try {
        if (this.wakesOnStart(st.rec)) this.wake(st, 'restart');
      } catch (e) {
        this.recoveryFailed(st, e);
      }
    }
    // Before anything reads a thread's patches. Every thread on disk,
    // including ones a draining runner still has.
    this.seedPatchTrust(records.map((r) => r.cwd));
    this.flush();
    void this.settleLostCleanups();
    // A guess the last runner was still making when it stopped or let a
    // thread go (runner/inbox-guess.ts); it catches its own errors.
    for (const st of this.threads.values()) if (!st.rec.coordinatorHelperFor) this.catchUpInboxGuess(st, GUESS_CATCH_UP_MS);
    for (const st of this.threads.values()) {
      try {
        // Coordinators start their queues when the runner is listening.
        if (!this.coordinators?.forThread(st.rec.id) && st.rec.queue.some(q => q.reviewId) && this.bucket(st.rec) === 'inbox') this.kickQueue(st);
      } catch (e) {
        this.recoveryFailed(st, e);
      }
    }
    this.armSnoozeTimer();
    // PRs whose auto-fix wand is on (runner/pr-watch.ts).
    this.armPrWatch();
    // Threads hibernating until GitHub workflow runs finish (runner/ci-runs.ts).
    this.resumeRunsWaits();
    // Waits for room are in thread.json, so they outlive a restart.
    this.armRoomTimer();
    // So are waits for the network.
    this.armNetTimer(true);
    this.log.info('runner loaded threads', { count: this.threads.size });
    this.accountsShown = accountsKey(this.safeAccounts());
    this.poolsShown = JSON.stringify(this.pools());
    if (!opts.deferBackground) this.startBackground();
  }

  // Background probes and watches started once the runner is listening (or at
  // the end of start() when deferBackground is not set).
  startBackground(): void {
    void this.probeModels();
    // Usage readings and a rescan that finds another list both reach
    // clients through the same throttle as what the probes learn.
    if (this.usage?.onChange) this.unsubs.push(this.usage.onChange(() => this.accountsChanged()));
    if (this.accounts.onChange) this.unsubs.push(this.accounts.onChange(() => this.accountsChanged()));
    if (this.signIn) this.unsubs.push(this.signIn.onChange(() => {
      this.accountsChanged();
      // A login signed back in can carry on threads waiting for room.
      this.armRoomTimer();
    }));
    this.armRescan();
  }

  // Each login has an independent, bounded read. Concurrent callers
  // share the same in-flight read for that login.
  async probeModels(only?: (a: Account) => boolean, refresh = false): Promise<void> {
    const targets = this.safeAccounts().filter((a) => !only || only(a));
    await Promise.all(targets.map(async (account) => {
      // A CLI upgrade still needs a fresh read if its old CLI was probing.
      if (refresh) await this.modelProbes.get(account.id);
      await this.probeModel(account);
    }));
  }

  private probeModel(account: Account): Promise<void> {
    const pending = this.modelProbes.get(account.id);
    if (pending) return pending;
    this.probed.add(account.id);
    const adapter = this.adapters[account.provider];
    const models = adapter?.models?.bind(adapter);
    if (this.stopping || !models) return Promise.resolve();

    const probe = Promise.resolve().then(async () => {
      if (this.stopping) {
        this.modelProbes.delete(account.id);
        return;
      }
      const abort = new AbortController();
      let timer: TimerHandle | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = this.clock.setTimeout(() => {
            const error = new Error('the model probe timed out');
            reject(error);
            abort.abort(error);
          }, MODEL_LIST_TIMEOUT_MS);
        });
        const list = await Promise.race([models(account, abort.signal), deadline]);
        this.learnAccount(account.id, { models: list });
      } catch (e) {
        this.log.warn('could not read the model list', { accountId: account.id, error: String(e) });
      } finally {
        timer?.cancel();
        this.modelProbes.delete(account.id);
      }
    });
    this.modelProbes.set(account.id, probe);
    return probe;
  }

  // The routing exception comes from drafting, before a thread or its
  // first turn exists. Re-read account and pool state after the probes.
  async createAfterModelProbe(params: Parameters<NewThreadsPart['create']>[0]): Promise<ReturnType<NewThreadsPart['create']>> {
    try {
      return this.create(params);
    } catch (e) {
      if (!(e instanceof ModelListsPending)) throw e;
      const pending = new Set(e.accountIds);
      await this.probeModels((a) => pending.has(a.id) && a.models === undefined);
      return this.create(params);
    }
  }

  learnAccount(accountId: string, info: LearnedAccountInfo): void {
    if (!this.accounts.learn(accountId, info)) return;
    this.accountsChanged();
  }

  // accounts.useReset (docs/protocol/settings.md, "Usage resets"): spends one of a
  // Codex login's usage-limit resets, on Mike's click in the limit box. The
  // reading taken after it goes into the usage store like a turn's, so the
  // block lifts and any thread waiting for room on that login carries on by
  // itself (sendAccounts arms the room timer).
  private resetting = new Set<string>();
  private limitRecheck?: LimitRecheck;

  // A draining runner leaves the logins' limits to the primary (beginDrain).
  stopLimitRecheck(): void {
    this.limitRecheck?.stop();
  }

  // accounts.findWork: the Usage panel's Find work for it (spare-week.ts).
  // The thread comes back with it, so the app can open it before
  // threads.created arrives.
  findWork(accountId: string): { threadId: string; started: boolean; thread: ThreadSummary } {
    if (!this.spareWeek) throw new RpcError(ErrorCode.methodNotFound, 'This runner has no spare week check.');
    if (!this.safeAccounts().some((a) => a.id === accountId)) throw new RpcError(ErrorCode.accountNotFound, `No login ${accountId} on this runner.`);
    const r = this.spareWeek.findWork(accountId);
    return { ...r, thread: this.get(r.threadId) };
  }

  async useReset(accountId: string): Promise<{ outcome: UseResetOutcome; account?: Account }> {
    const account = this.safeAccounts().find((a) => a.id === accountId);
    if (!account) throw new RpcError(ErrorCode.accountNotFound, `No login ${accountId} on this runner.`);
    const adapter = this.adapters[account.provider];
    if (!adapter?.useReset) throw new RpcError(ErrorCode.badParams, unsupportedResetMessage(account.provider));
    // A second click while the first is out would spend a second reset.
    if (this.resetting.has(accountId)) throw new RpcError(ErrorCode.busy, 'A reset for this login is already on its way.');
    this.resetting.add(accountId);
    try {
      const r = await adapter.useReset(account);
      this.log.info('used a usage reset', { accountId, outcome: r.outcome });
      if (r.limits) {
        const l = r.limits;
        this.usage?.record(accountId, {
          windows: l.windows,
          ...(l.blocked !== undefined ? { blocked: l.blocked } : {}),
          ...(l.plan ? { plan: l.plan } : {}),
          ...(l.resets ? { resets: l.resets } : {}),
        });
      }
      const after = this.safeAccounts().find((a) => a.id === accountId);
      return after ? { outcome: r.outcome, account: after } : { outcome: r.outcome };
    } catch (e) {
      if (e instanceof RpcError) throw e;
      this.log.warn('could not use a usage reset', { accountId, error: String(e) });
      throw new RpcError(ErrorCode.other, `Codex couldn't use the reset: ${String((e as Error)?.message ?? e)}`);
    } finally {
      this.resetting.delete(accountId);
    }
  }

  // A reading limit-recheck.ts took of a login that read as out. One that
  // says it isn't blocked, with room in every window it names (a model's
  // own week or bucket too, which a turn on that model can run dry while
  // the login's main windows have room), also ends the block the turn that
  // ran dry put on it (ranDry), so a top-up or a reset made outside
  // Threadbear lets the pools use it again before the time that block
  // guessed. Only these: a turn's reading on another of the login's
  // sessions says nothing about the model that ran out. And only with more
  // room than it read as when it ran dry: a login refused while its own
  // reading said it had room isn't back because it says so again.
  recordReading(usage: UsageSink, accountId: string, reading: UsageReading): void {
    // Only windows that can decide: Gemini's Claude and GPT group out says
    // nothing about the Gemini models its threads run on.
    const deciding = decidingWindows(reading);
    const least = deciding.length ? Math.min(...deciding.map((w) => w.remainingPercent)) : undefined;
    const was = this.dryRoom.get(accountId);
    const dryUntil = this.ranDry.get(accountId);
    // Grok running on a prepaid or on-demand balance past its plan reads as
    // the 1% floor whatever it read before; that balance is room.
    const funded = reading.windows.some((w) => w.detail === FUNDED_DETAIL);
    if (reading.blocked === false && least !== undefined && least >= MIN_ROOM_PERCENT && (was === undefined || least > was || funded)) {
      this.ranDry.delete(accountId);
      this.dryRoom.delete(accountId);
      this.readBack.add(accountId);
    } else if (dryUntil !== undefined && dryUntil > this.clock.now()) {
      // Not enough to count as back. What it read is the room to beat from
      // now on (a reading lost after the turn left none), and the store
      // keeps the block too: a login it showed as having room would get no
      // more rechecks.
      if (was !== undefined) this.dryRoom.set(accountId, Math.min(was, reading.blocked ? 0 : (least ?? was)));
      if (reading.blocked === false) reading = { ...reading, blocked: true, blockedUntil: dryUntil };
    }
    usage.record(accountId, reading);
    // A thread waiting on that login hears now, not at the reset it named.
    this.armRoomTimer();
  }

  safeAccounts(): Account[] {
    try {
      return this.accounts.list();
    } catch (e) {
      this.log.warn('could not list the accounts', { error: String(e) });
      return [];
    }
  }

  // Reads the account list again every ACCOUNT_RESCAN_MS, so a login added
  // in Token Stats shows up in the app (and gets its models asked for)
  // without a reconnect.
  armRescan(): void {
    this.rescanTimer?.cancel();
    this.rescanTimer = this.clock.setTimeout(() => {
      this.rescanTimer = undefined;
      if (this.stopping) return;
      this.rescanAccounts();
      if (this.clock.now() - this.landRecheckAt >= WAITING_TO_LAND_RECHECK_MS) {
        this.landRecheckAt = this.clock.now();
        this.recheckWaitingToLand();
      }
      this.armRescan();
    }, ACCOUNT_RESCAN_MS);
  }

  // accounts.recheck (docs/protocol.md): the app ran Terminal on a login's
  // sign-in, or made a folder for another. The list is read again (a new
  // claude-N folder) and the CLI asked about that login's sign-in now,
  // not at the next sweep (up to 10 minutes), so the setup card stops
  // spinning as soon as it's done.
  async recheckAccounts(accountId?: string): Promise<{ accounts: Account[] }> {
    this.rescanAccounts();
    await this.signIn?.checkNow?.(accountId);
    return { accounts: this.safeAccounts() };
  }

  // accounts.yearToken (docs/protocol.md): Year-long token… for one of this
  // runner's Claude logins, asked from a Mac's Runners panel.
  async yearToken(accountId: string, p: YearTokenParams): Promise<YearTokenAnswer> {
    if (!this.tokenMaker) throw new RpcError(ErrorCode.methodNotFound, "This runner can't make tokens.");
    const account = this.safeAccounts().find((a) => a.id === accountId);
    if (!account) throw new RpcError(ErrorCode.accountNotFound, `No login ${accountId} on this runner.`);
    const r = await this.tokenMaker.step(account, p);
    // The new file is seen by the folder watch; this makes it at once.
    if (r.state === 'done') this.rescanAccounts();
    return r;
  }

  rescanAccounts(): void {
    const list = this.safeAccounts();
    const fresh = new Set(list.filter((a) => !this.probed.has(a.id)).map((a) => a.id));
    if (fresh.size) void this.probeModels((a) => fresh.has(a.id));
    if (accountsKey(list) !== this.accountsShown) this.accountsChanged();
  }

  // accounts.updated, level-triggered: the first change goes out at once,
  // then at most one every ACCOUNTS_THROTTLE_MS, read when it goes so it's
  // always the latest list.
  accountsChanged(): void {
    if (this.accountsTimer || this.stopping) return;
    const wait = this.accountsSentAt + ACCOUNTS_THROTTLE_MS - this.clock.now();
    if (wait <= 0) {
      this.sendAccounts();
      return;
    }
    this.accountsTimer = this.clock.setTimeout(() => {
      this.accountsTimer = undefined;
      if (!this.stopping) this.sendAccounts();
    }, wait);
  }

  // A login's year-long token made, renewed or taken away (year-token.ts):
  // its CLIs got their token when they started, so each lets go of its
  // session (once its turn is over) and the next turn starts on the new
  // one. Else Send again after New token… runs on the old token, and its
  // refusal marks the new one out (Codex's review, 17 Nov).
  private tokenKeys = new Map<string, string>();
  // Told after each change to the login list goes out (a token made or
  // renewed, a login added, hidden or noted): login-share.ts sends again.
  onAccountsChanged?: () => void;
  renewTokens(accounts: Account[]): void {
    for (const a of accounts) {
      if (a.provider !== 'claude') continue;
      const key = JSON.stringify(a.yearToken ?? null);
      const was = this.tokenKeys.get(a.id);
      this.tokenKeys.set(a.id, key);
      if (was === undefined || was === key) continue;
      this.signIn?.noteWorked(a.id);
      for (const st of this.threads.values()) {
        if (st.rec.accountId !== a.id || !st.rt.session) continue;
        this.cli(st, { kind: 'leave' });
        if (!st.rt.turn) this.releaseSession(st);
      }
      this.log.info('a login changed its year-long token; its sessions start again on it', { accountId: a.id });
    }
  }

  sendAccounts(): void {
    // A login added, or a usage reading that shows room again, can carry
    // on a thread waiting for room in its pool.
    this.armRoomTimer();
    const accounts = this.safeAccounts();
    this.renewTokens(accounts);
    // The built-in pools follow the login list.
    const pools = this.pools(accounts);
    const poolsKey = JSON.stringify(pools);
    if (poolsKey !== this.poolsShown) {
      this.poolsShown = poolsKey;
      this.notify({ method: 'pools.updated', params: { pools } });
    }
    const key = accountsKey(accounts);
    // A change that went back to what clients already have isn't news.
    if (key === this.accountsShown) return;
    this.accountsShown = key;
    this.accountsSentAt = this.clock.now();
    this.notify({ method: 'accounts.updated', params: { accounts } });
    this.onAccountsChanged?.();
  }

  // A thread folder whose thread.json can't be read: rebuild what can be
  // read from its events, rather than have it disappear. Settings that live
  // only in thread.json (folder, account, session) fall back to defaults,
  // and the next message starts a new session with a handoff note.
  rebuild(id: string): ThreadRecord | undefined {
    const log = this.store.log(id);
    if (log.lastSeq === 0) return undefined;
    // Only events that are events: the log may be another runner's (a
    // move), and a line of `null` or a number threw here at every start.
    const events = log.read(1, log.lastSeq).filter((e) => typeof e === 'object' && e !== null && typeof (e as { type?: unknown }).type === 'string');
    if (!events.length) return undefined;
    const first = events[0];
    const last = events[events.length - 1];
    const firstMsg = events.find((e) => e.type === 'user.message');
    const lastText = [...events].reverse().find((e) => e.type === 'assistant.text');
    const lastStarted = [...events].reverse().find((e) => e.type === 'turn.started');
    const open = lastStarted && !events.some((e) => e.type === 'turn.completed' && e.turnId === lastStarted.turnId);
    const lastCompleted = [...events].reverse().find((e) => e.type === 'turn.completed');
    const rewinds = events.flatMap((e) => (e.type === 'thread.rewound' ? [{ from: e.fromSeq, to: e.toSeq }] : []));
    const accountId = this.defaultAccountId();
    const rec: ThreadRecord = {
      id,
      title: firstMsg && firstMsg.type === 'user.message' && typeof firstMsg.text === 'string' ? titleFrom(firstMsg.text) : 'Untitled',
      cwd: this.cfg.defaults.cwd,
      accountId,
      // The account's own, so a Codex default never starts the Claude CLI
      // with CLAUDE_CONFIG_DIR=~/.codex.
      provider: this.accounts.get(accountId)?.provider ?? 'claude',
      // Unknown, so the safer one.
      permissionMode: 'ask',
      status: open ? 'running' : 'idle',
      createdAt: typeof first.ts === 'string' ? first.ts : this.isoNow(),
      updatedAt: typeof last.ts === 'string' ? last.ts : this.isoNow(),
      lastActivityAt: typeof last.ts === 'string' ? last.ts : this.isoNow(),
      preview: lastText && lastText.type === 'assistant.text' && typeof lastText.text === 'string' ? oneLine(lastText.text, LIMITS.previewChars) : '',
      lastSeq: log.lastSeq,
      lastSeenSeq: log.lastSeq,
      nativeSessionId: crypto.randomUUID(),
      sessionUsed: false,
      lastTurnCompletedSeq: lastCompleted?.seq ?? 0,
      queue: [],
      pendingApprovals: [],
      handoff: { fromCwd: this.cfg.defaults.cwd, fromAccountId: accountId, rebuilt: true },
    };
    // Each only with this thread's own copies of its files, as recoverReviews
    // takes one from the log (Daybreak 159, Gemini's second review): a moved
    // thread's log is the other runner's word.
    const reviews = new Map<string, DesignReview>();
    const media = this.store.mediaDir(id);
    for (const event of events) {
      if (event.type !== 'review.updated') continue;
      const review = fitReview(event.review, { threadId: id, now: media, final: media }, true);
      if (review) reviews.set(review.id, review);
    }
    if (reviews.size) rec.reviews = [...reviews.values()];
    const buttons = new Map<string, ReplyButton>();
    for (const event of events) if (event.type === 'button.updated') buttons.set(event.button.id, event.button);
    if (buttons.size) rec.buttons = [...buttons.values()].slice(-MAX_BUTTONS);
    if (rewinds.length) rec.rewinds = rewinds;
    if (open && lastStarted) rec.turnId = lastStarted.turnId;
    this.log.warn('thread.json was unreadable; rebuilt it from the event log', { threadId: id });
    this.store.setAside(id);
    try {
      this.store.save(rec);
    } catch (e) {
      this.log.error('could not save a rebuilt thread', { threadId: id, error: String(e) });
    }
    const st: ThreadState = { rec, rt: newRuntime(0) };
    this.emit(st, {
      type: 'system.note',
      text: `This thread's settings couldn't be read, so its folder, account and permission mode were reset to ${rec.cwd}, ${accountId} and ask. The next message starts a new session.`,
    });
    return rec;
  }

  // Returns true if the thread was mid-turn.
  recover(st: ThreadState): boolean {
    const { rec } = st;
    // A sub-agent can't outlive the runner that started its CLI.
    this.stopSubagents(st);
    // Hidden coordinator helpers are owned and reconciled by Coordinators.
    if (rec.coordinatorHelperFor) {
      const mid = rec.status === 'starting' || rec.status === 'running' || rec.status === 'waiting';
      if (mid && rec.turnId) {
        const ev = this.emit(st, { type: 'turn.completed', turnId: rec.turnId, outcome: 'interrupted', durationMs: 0, error: 'The runner stopped during this turn.' }, rec.turnId);
        rec.lastTurnCompletedSeq = ev.seq;
      }
      if (mid) {
        rec.turnId = undefined;
        rec.status = 'stopped';
      }
      rec.pendingApprovals = [];
      rec.queue = [];
      // Its coordinator's registry carries it on (coordinators.ts,
      // carryOnAfterRestart), so no carry-on of its own: not the network's,
      // and not carryOnStopped's, which a clean stop's stopTurn asks for.
      // That one ran outside the registry's run, and its result went nowhere
      // (Codex's review, 26 Nov 2026).
      delete rec.waitingForNetwork;
      delete rec.netCarryOn;
      delete rec.stoppedMidTurn;
      // Nor tellStoppedWork's message: the carry-on says to check what's done.
      delete rec.stoppedWork;
      this.markDirty(st);
      return false;
    }
    // Waiting with no turn is only a subagent's card, and that subagent is
    // gone: there's no turn to pick up again.
    const onlyCards = rec.status === 'waiting' && !rec.turnId;
    if (onlyCards) rec.status = 'idle';
    const midTurn = rec.status === 'starting' || rec.status === 'running' || rec.status === 'waiting';
    // A turn the restart cut off may never have read what it was told of
    // presses (a crash, or Codex still holding the message). One that isn't
    // mid-turn settled already, unless the runner's stop ended it (stopTurn).
    if (!midTurn) this.settlePresses(rec, false);
    if (!midTurn && rec.pendingApprovals.length === 0 && rec.queue.length === 0) return false;
    // The turn may have ended on disk just before a crash stopped
    // thread.json being saved; then it only needs its status back.
    const ended = midTurn && rec.turnId ? this.findTurnCompleted(rec.id, rec.turnId) : undefined;
    // Only a turn that completed kept what it was told (Codex's second look).
    if (midTurn && ended?.type === 'turn.completed' && ended.outcome === 'completed' && rec.wakeNews?.check && rec.wakeNews.check === rec.turnId) delete rec.wakeNews;
    if (midTurn) this.settlePresses(rec, ended?.type === 'turn.completed' && ended.outcome === 'completed');
    // thread.json can be behind the log (a crash before it was saved): a card
    // may have been answered there, and a later "expired" would replace the
    // answer. A turn that ended there closed its own cards, but a subagent's
    // outlives its turn, so go by what the log says (Codex review).
    const resolved = new Set<string>();
    if (rec.pendingApprovals.length) {
      const log = this.store.log(rec.id);
      for (const e of log.read(1, log.lastSeq)) if (e.type === 'approval.resolved') resolved.add(e.approvalId);
    }
    for (const approvalId of rec.pendingApprovals) {
      if (resolved.has(approvalId)) continue;
      this.emit(st, { type: 'approval.resolved', approvalId, decision: 'expired', message: 'The runner restarted.' }, ended ? undefined : rec.turnId);
    }
    rec.pendingApprovals = [];
    if (midTurn && ended) {
      rec.lastTurnCompletedSeq = Math.max(rec.lastTurnCompletedSeq, ended.seq);
      rec.status = ended.type === 'turn.completed' && ended.outcome === 'failed' ? 'error' : 'idle';
      rec.turnId = undefined;
    } else if (midTurn) {
      if (rec.turnId) {
        const ev = this.emit(
          st,
          { type: 'turn.completed', turnId: rec.turnId, outcome: 'interrupted', durationMs: 0, error: 'The runner stopped during this turn.' },
          rec.turnId,
        );
        rec.lastTurnCompletedSeq = ev.seq;
        // When it was last doing something: a crash or a power cut leaves
        // no time of its own.
        rec.stoppedMidTurn = { turnId: rec.turnId, at: rec.lastActivityAt };
      }
      rec.turnId = undefined;
      rec.status = 'stopped';
    }
    // A snoozed or archived thread holds its queue until it comes back, and
    // nothing sends it before then anyway, so a restart (planned or not)
    // leaves it for the wake-up to send. That includes a snooze that ended
    // while the runner was down: start() wakes it straight after loading.
    // A queue held for saved user input is durable too; other unsent inputs
    // were cut off.
    if (rec.queue.length && !midTurn && (rec.snoozedUntil !== undefined || rec.archivedAt !== undefined || this.queueHeld(st))) {
      this.markDirty(st);
      return false;
    }
    const coordinator = this.coordinators?.forThread(rec.id);
    const coordinatorInput = (q: QueuedSend) => Boolean(coordinator && (q.origin === 'runner' || fromMike(q.text, q)));
    const keptQueue = rec.queue.filter(q => q.reviewId || (coordinatorInput(q) && !this.scheduledDelivery(st, q.turnId, 0, q.origin ?? null)?.started));
    // A stale thread.json may still hold an input whose receipt is already
    // in the log. It was delivered; neither replay it nor call it unsent.
    rec.queue = rec.queue.filter(q => !q.reviewId && !coordinatorInput(q));
    if (rec.queue.length) {
      const texts = rec.queue.map((q) => q.text).filter(Boolean);
      this.emit(st, {
        type: 'system.note',
        text: `The runner restarted before ${rec.queue.length === 1 ? 'a queued message was' : `${rec.queue.length} queued messages were`} sent:\n\n${texts.join('\n\n')}`,
      });
      rec.queue = [];
    }
    rec.queue.push(...keptQueue);
    this.markDirty(st);
    return midTurn && !ended;
  }

  findTurnCompleted(threadId: string, turnId: string): PersistedEvent | undefined {
    const log = this.store.log(threadId);
    return log
      .read(Math.max(1, log.lastSeq - 200), log.lastSeq)
      .reverse()
      .find((e) => e.type === 'turn.completed' && e.turnId === turnId);
  }

  // Called before the CLIs are killed. Turns in flight end the way startup
  // recovery would end them, rather than as failures when their CLI dies.
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.dropSpare('runner stopping');
    this.tokenMaker?.stopAll();
    this.snoozeTimer?.cancel();
    this.prWatchTimer?.cancel();
    this.roomTimer?.cancel();
    this.netTimer?.cancel();
    this.rescanTimer?.cancel();
    this.accountsTimer?.cancel();
    this.liveTimer?.cancel();
    this.limitRecheck?.stop();
    for (const off of this.unsubs.splice(0)) off();
    for (const st of this.threads.values()) this.prepareThreadForShutdown(st, false);
    this.flush();
  }

  private prepareThreadForShutdown(st: ThreadState, forgetCli: boolean): void {
    const { rec, rt } = st;
    rt.idleTimer?.cancel();
    rt.deltaTimer?.cancel();
    rt.ciTimer?.cancel();
    // A done card held back for the wake grace: no turn can come now, so
    // it finishes (a review it's due is owed to the next runner), or a
    // stop within those 15 s would leave it unfinished for good.
    if (!rt.turn) this.settlePendingFinish(st);
    // A shell its last turn ended waiting on has ended, and the CLI is
    // still to wake for it (a 90 s grace on OpenCode): stopping the CLI
    // loses that wake, so the next runner tells the thread, as for work
    // the stop kills (Gemini's review, 28 Nov 2026).
    if (rt.wakeTimer && !rt.turn && this.adapters[rt.sessionProvider ?? rec.provider]?.nudgesUnreadShells) {
      const going = new Set(rt.tasks.map((t) => t.id));
      const unread = (rt.awaitedShells ?? []).filter((id) => !going.has(id));
      if (unread.length) {
        const what = rt.finished.filter((t) => unread.includes(t.id)).map((t) => `${t.description || t.type} (it had finished; you hadn't read its result yet)`);
        rec.stoppedWork = { what: [...(rec.stoppedWork?.what ?? []), ...(what.length ? what : ['a background shell that had finished; you hadn\'t read its result yet'])], at: this.isoNow() };
        this.markDirty(st);
      }
    }
    rt.wakeTimer?.cancel();
    rt.wakeTimer = undefined;
    delete rt.awaitedShells;
    this.flushDeltas(st);
    // Output and exits from CLIs that are about to be killed no longer count.
    this.cli(st, { kind: 'drop', forget: forgetCli });
    if (rt.turn) this.stopTurn(st);
    else if (forgetCli) this.expireApprovals(st, 'The runner stopped.');
    // Killing the CLIs kills their background shells and subagents too.
    // Say so in the thread, as releaseSession does, or it would wait for
    // a result that never comes with nothing to say why.
    rt.finished = [];
    this.stopSubagents(st);
    if (rt.tasks.length) {
      const what = rt.tasks.map((t) => t.description || t.type).join('; ');
      this.rememberStoppedWork(st);
      this.cli(st, { kind: 'stopTasks' });
      try {
        this.emit(st, { type: 'system.note', text: `Stopped background work when the runner stopped: ${what}` });
      } catch (e) {
        this.log.error('could not save a note', { threadId: st.rec.id, error: String(e) });
      }
    }
  }

  // ------------------------------------------------------------- handovers
  // docs/protocol/updates.md, "Handovers".

  // Coordinator threads must move together with their registry. Settle any
  // active turn before closing its CLI so restart recovery can carry it on.
  async stopThreadForHandover(st: ThreadState): Promise<void> {
    this.holdTurns(st.rec.id, 'handover');
    const { session, closing, turn } = st.rt;
    if (turn && !st.rec.coordinatorHelperFor) {
      // Output can confirm the only input when this provider sends no
      // receipts. It cannot confirm a later message waiting in its queue.
      const onlyInputWasRead = !turn.auto && !turn.deliveryKnown && turn.modelOutput && turn.inputs?.size === 1;
      const unread = onlyInputWasRead ? [] : turn.messages.filter(id => !turn.startedMessages?.has(id));
      if (unread.length) {
        this.saveInterruptedMessages(st, { outcome: 'interrupted', durationMs: 0, unreceived: unread }, true);
      }
    }
    this.prepareThreadForShutdown(st, true);
    if (closing) {
      session?.kill();
      await closing;
    } else await session?.end({ hard: true });
  }

  // ---------------------------------------------------- stopped background work
  // docs/protocol/updates.md, "Stopped background work". A handover or restart stops
  // work the thread is counting on, usually a wait it promised to report
  // back from (1 Nov: Mike asked "Is this still going?" 4.5 hours later).
  // The note alone wakes nobody, so the next runner tells the thread.

  // From the moment a restart begins until the runner exits, a new turn
  // would only be cut off straight away, so sends and new threads are
  // refused with a message saying to send again in a moment.
  refuseNewTurns(message: string): void {
    this.refusing = message;
  }

  checkAccepting(): void {
    if (this.refusing) throw new RpcError(ErrorCode.busy, this.refusing);
  }

  stopTurn(st: ThreadState): void {
    const { rec, rt } = st;
    const turn = rt.turn!;
    this.keepHeldMessage(st);
    this.persistInProgress(st, turn.turnId);
    this.expireApprovals(st, 'The runner stopped.');
    const ev = this.emit(
      st,
      {
        type: 'turn.completed',
        turnId: turn.turnId,
        outcome: 'interrupted',
        durationMs: Math.max(0, this.clock.now() - turn.startedAt),
        error: turn.interruptRequested ? 'Interrupted.' : 'The runner stopped during this turn.',
      },
      turn.turnId,
    );
    turn.interruptTimer?.cancel();
    rt.turn = undefined;
    rec.turnId = undefined;
    rec.lastTurnCompletedSeq = ev.seq;
    rec.status = 'stopped';
    if (turn.interruptRequested) delete rec.stoppedMidTurn;
    else rec.stoppedMidTurn = { turnId: turn.turnId, at: this.isoNow() };
    rec.lastActivityAt = this.isoNow();
    this.markDirty(st);
  }

  // Text that streamed but never got its complete frame is kept as what the
  // user saw.
  persistInProgress(st: ThreadState, turnId: string): void {
    const { rt } = st;
    this.flushDeltas(st);
    for (const item of rt.inProgress.values()) {
      if (!item.text) continue;
      this.emit(
        st,
        item.type === 'assistant.text'
          ? { type: 'assistant.text', itemId: item.itemId, text: item.text }
          : { type: 'reasoning', itemId: item.itemId, text: item.text },
        turnId,
      );
    }
    rt.inProgress.clear();
  }

  // ------------------------------------------------------------- listeners

  onNotification(fn: (n: Notification) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // For the runner's neighbours (schedules.ts) to tell every client.
  publish(n: Notification): void {
    this.notify(n);
    // Whether a schedule will message a thread is part of its wait state.
    if (n.method === 'schedules.updated') this.recheckWaitStates();
  }

  // Re-sends each thread a schedule will now message by itself, or no longer
  // will (booked, paused or deleted): that's part of its wait state, and its
  // record didn't change. Compared with the last list, not with a summary,
  // as any summary made meanwhile would already have the new state.
  recheckWaitStates(): void {
    const now = new Set<string>();
    for (const st of this.threads.values()) if (this.hibernatesForSchedule(st.rec.id)) now.add(st.rec.id);
    // The first time, every thread a summary has said is scheduled counts
    // as before, so the first schedule removed after a start is sent too.
    // A thread adopted since (a handover) was never in the last list: what
    // its summary said counts too.
    const before = new Set([...(this.scheduledThreads ?? []), ...[...this.threads.values()].filter((st) => st.rt.waitState === 'scheduled').map((st) => st.rec.id)]);
    this.scheduledThreads = now;
    for (const id of new Set([...now, ...before])) {
      if (now.has(id) === before.has(id)) continue;
      const st = this.threads.get(id);
      if (st && !st.rt.deleted) this.markDirty(st);
    }
  }

  // The threads a schedule would message, as of the last schedules.updated.
  private scheduledThreads?: Set<string>;

  // The soonest booked schedule that will message the thread.
  nextSchedule(threadId: string): Schedule | undefined {
    return (this.schedulesFor?.(threadId) ?? [])
      .filter((x) => x.threadId === threadId && !x.paused && !x.finishedAt && x.nextRunAt && !Number.isNaN(Date.parse(x.nextRunAt)))
      .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))[0];
  }

  scheduled(threadId: string): boolean {
    return this.nextSchedule(threadId) !== undefined;
  }

  activeCoordinator(threadId: string): boolean {
    return Boolean(this.coordinators?.isActive(threadId));
  }

  // Whether a booked schedule moves this thread under Hibernating: active
  // project coordinators always stay awake (Mike, 26 Nov 2026).
  hibernatesForSchedule(threadId: string): boolean {
    return this.scheduled(threadId) && !this.activeCoordinator(threadId);
  }

  // The line for a move into or out of Hibernating for a schedule, once
  // the summary that saw it is made. Checked again, as a turn may have
  // started in between.
  sayScheduled(st: ThreadState, into: boolean): void {
    if (st.rt.deleted || this.stopping || this.refusing || this.draining) return;
    if ((st.rt.waitState === 'scheduled') !== into) return;
    const now = this.clock.now();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!into) {
      // Out for news while its schedule is still booked (a turn's reply, a
      // wake): that has its own line, and "no schedule is booked" would be
      // wrong (25 Nov 2026).
      if (this.scheduled(st.rec.id)) return;
      this.emit(st, { type: 'system.note', text: unscheduledNote({ now, timeZone }) });
      return;
    }
    const next = this.nextSchedule(st.rec.id);
    this.emit(st, { type: 'system.note', text: scheduledNote({ title: next?.title, next: next?.nextRunAt ? Date.parse(next.nextRunAt) : undefined, now, timeZone }) });
  }

  private waitState(st: ThreadState, sum: ThreadSummary): WaitState {
    // A message already taken and about to start a turn (a coordinator's
    // wake waiting on the folder's settings look, rt.preLook) isn't
    // "nothing needs you": without this the thread read as Hibernating, with
    // its line, for the moment before the turn began (Gemini's review, 26 Nov
    // 2026).
    const starting = st.rec.queue.length > 0 && !st.rt.turn;
    return waitStateOf(sum, { now: this.clock.now(), scheduled: this.hibernatesForSchedule(st.rec.id) && !starting, helpers: this.coordinators?.helpersWorking(st.rec.id) ?? 0 });
  }

  // Turn ends and folder moves, for the librarian.
  onThreadActivity(fn: (a: ThreadActivity) => void): () => void {
    this.activity.add(fn);
    return () => this.activity.delete(fn);
  }

  tellActivity(a: ThreadActivity): void {
    for (const fn of this.activity) {
      try {
        fn(a);
      } catch (e) {
        this.log.error('activity listener failed', { error: String(e) });
      }
    }
  }

  // ---------------------------------------------------- for projects.ts

  notify(n: Notification): void {
    // A kept thread's summary changing can be it becoming free to go.
    if (this.draining && n.method === 'thread.updated') this.queueHandoverCheck();
    for (const fn of this.listeners) {
      try {
        fn(n);
      } catch (e) {
        this.log.error('listener failed', { error: String(e) });
      }
    }
  }

  notice(level: 'info' | 'warning' | 'error', message: string): void {
    this.notify({ method: 'runner.notice', params: { level, message } });
  }

  // A notice about startup, also sent to clients that connect in the next
  // few minutes (the app is rarely connected while the runner starts).
  startupNotice(level: 'info' | 'warning' | 'error', message: string): void {
    this.startupNotices.push({ level, message });
    this.notice(level, message);
  }

  // Sent to each client after its hello.
  noticesForNewClient(): { level: 'info' | 'warning' | 'error'; message: string }[] {
    const out = this.clock.now() - this.startedAt < STARTUP_NOTICE_MS ? [...this.startupNotices] : [];
    if (!fs.existsSync(this.cfg.claudePath)) {
      out.push({ level: 'error', message: `The claude CLI isn't at ${this.cfg.claudePath}, so no Claude turn can start. Install Claude Code, or set claudePath in runner.json.` });
    }
    return out;
  }

  // --------------------------------------------------------------- queries

  hello(): { runnerVersion: string; protocol: number; accounts: Account[]; providers: ProviderInfo[]; pools: Pool[]; defaults: RunnerDefaults; clis?: CliStatus[] } {
    const accounts = this.accounts.list();
    const pools = this.pools(accounts);
    const defaults: RunnerDefaults = { cwd: this.cfg.defaults.cwd, accountId: this.defaultAccountId(accounts) };
    const poolId = this.defaultPoolId(pools, this.usable(accounts), defaults.accountId);
    if (poolId) defaults.poolId = poolId;
    // `model` is Claude's, for apps that predate `models`.
    const claudeModel = this.defaultModelFor('claude');
    if (claudeModel) defaults.model = claudeModel;
    if (this.cfg.defaults.models) defaults.models = { ...this.cfg.defaults.models };
    if (this.cfg.defaults.efforts) defaults.efforts = { ...this.cfg.defaults.efforts };
    // The app's composer starts a new thread on it.
    if (this.cfg.defaults.permissionMode) defaults.permissionMode = this.cfg.defaults.permissionMode;
    const out: ReturnType<Runner['hello']> = { runnerVersion: RUNNER_VERSION, protocol: PROTOCOL_VERSION, accounts, providers: providersForHello(), pools, defaults };
    const clis = this.cliList();
    if (clis) out.clis = clis;
    return out;
  }

  // The account a thread made without one starts on (tb new, create_thread,
  // schedules) and hello's defaults.accountId: the one with the most room
  // among the last-used account's provider (usage.ts, pickAccount), worked
  // out again each time so it follows usage. Without usage it's the last
  // one used.
  defaultAccountId(all = this.accounts.list()): string {
    // Only accounts this runner can start a CLI for.
    const accounts = all.filter((a) => this.adapters[a.provider]);
    const json = peekRunnerJson(this.cfg.home).defaults;
    const saved = json?.accountId ?? this.cfg.defaults.accountId;
    const last = saved && accounts.some((a) => a.id === saved) ? saved : (accounts.find((a) => a.id === 'claude-main')?.id ?? accounts[0]?.id);
    // A dev runner's keepAccount pins its login, unless that login's plan
    // has ended: every turn there fails, so the usual pick moves off it.
    if (json?.keepAccount && last && !accounts.find((a) => a.id === last)?.planEnded) return last;
    let picked: string | undefined;
    try {
      picked = this.pickAccount(accounts, last);
    } catch (e) {
      this.log.warn('could not pick an account', { error: String(e) });
    }
    if (picked && accounts.some((a) => a.id === picked)) return picked;
    return last ?? 'claude-main';
  }

  // What a thread on this provider gets when it names no model: the
  // runner's default for that provider, or for Claude the older single
  // default. Undefined means the account's own.
  defaultModelFor(provider: Provider): string | undefined {
    return this.cfg.defaults.models?.[provider] ?? (provider === 'claude' ? this.cfg.defaults.model : undefined);
  }

  defaultEffortFor(provider: Provider): EffortLevel | undefined {
    return this.cfg.defaults.efforts?.[provider];
  }

  // ------------------------------------------------------------------ pools
  // docs/protocol/settings.md, "Pools". The rules are in pools.ts; this is where
  // they meet threads.

  // With ids, only those threads (threads.list's ids): a draining runner
  // looking one up mustn't be sent all 900 (docs/protocol/updates.md, "Handovers").
  list(include: ('inbox' | 'snoozed' | 'archived')[] = ['inbox'], ids?: string[]): ThreadSummary[] {
    const want = new Set(include);
    const out: ThreadSummary[] = [];
    const states = ids ? [...new Set(ids)].flatMap((id) => this.threads.get(id) ?? []) : this.threads.values();
    for (const st of states) {
      if (st.rec.coordinatorHelperFor) continue;
      if (want.has(this.bucket(st.rec))) out.push(this.summary(st));
    }
    return sortByActivity(out);
  }

  // Non-helper thread ids across every bucket without building summaries or
  // touching patches (used by sync heartbeats, cache seeding and pruning).
  listedIds(): string[] {
    const out: string[] = [];
    for (const st of this.threads.values()) {
      if (!st.rec.coordinatorHelperFor) out.push(st.rec.id);
    }
    return out;
  }

  // Summaries only for threads that have ever been shared, so cached sync
  // startup doesn't summarise thousands of unshared archived threads.
  sharedSummaries(): ThreadSummary[] {
    const out: ThreadSummary[] = [];
    for (const st of this.threads.values()) {
      if (st.rec.coordinatorHelperFor || !st.rec.share) continue;
      out.push(this.summary(st));
    }
    return out;
  }

  // Threads a schedule or the runner itself started since `since` (ms),
  // archived ones too, for Recipes' run counts (recipes.ts): only those are
  // summarised, as it looks every 30 seconds and a runner can have thousands
  // of threads.
  recipeRunsSince(since: number): ThreadSummary[] {
    const out: ThreadSummary[] = [];
    for (const st of this.threads.values()) {
      if (st.rec.coordinatorHelperFor) continue;
      if ((st.rec.schedule || st.rec.startedBy?.kind === 'runner') && Date.parse(st.rec.createdAt) >= since) out.push(this.summary(st));
    }
    return out;
  }

  bucket(rec: ThreadRecord): 'inbox' | 'snoozed' | 'archived' {
    return placeBucket(placeOf(rec), this.clock.now());
  }

  search(query: string, limit = 50): ThreadSummary[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out: ThreadSummary[] = [];
    for (const st of this.threads.values()) {
      if (st.rec.coordinatorHelperFor) continue;
      const hay = `${st.rec.title}\n${st.rec.preview}\n${st.rec.keywords ?? ''}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push(this.summary(st));
    }
    return sortByActivity(out).slice(0, Math.max(0, Math.floor(limit)));
  }

  // For end_turn's handler: whether the Stop hook sent the running turn back
  // to call it.
  endTurnNudged(threadId: string): boolean {
    return this.threads.get(threadId)?.rt.turn?.endTurnNudged === true;
  }

  // For end_turn's handler: whether the Stop hook sent the running turn back
  // for a card its reply asked for, so this call isn't a repeat.
  cardReopened(threadId: string): boolean {
    return this.threads.get(threadId)?.rt.turn?.cardReopened === true;
  }
  // For end_turn's handler: whether the running turn was sent back to fix
  // dead file links in its reply, so it's asked for a new one whole.
  replyRewrite(threadId: string): boolean {
    return this.threads.get(threadId)?.rt.turn?.replyRewrite === true;
  }

  // For end_turn's handler: whether a message sent into the running turn is
  // one the agent can't have read when it wrote the call (needs.ts,
  // UNREAD_MESSAGE). It counts as a refusal for each (adapters/types.ts).
  unreadMessage(threadId: string): boolean {
    return this.threads.get(threadId)?.rt.session?.unreadMessage?.() === true;
  }

  // For end_turn's handler: the thread's shell jobs still running, when
  // their end wakes it, so asks can wait for them (needs.ts, JOBS_NUDGE).
  // Codex doesn't wake for them, so its asks go to Mike at once.
  shellJobs(threadId: string): string[] {
    const st = this.threads.get(threadId);
    return st ? this.wakingShells(st).map((t) => t.description || t.type) : [];
  }

  private wakes(st: ThreadState): boolean {
    return this.adapters[st.rt.sessionProvider ?? st.rec.provider]?.wakesAfterTasks !== false;
  }

  private wakingShells(st: ThreadState): ThreadState['rt']['tasks'] {
    return this.wakes(st) ? st.rt.tasks.filter((t) => t.kind === 'shell') : [];
  }

  // The jobs a turn's asks wait for: its shell jobs still running as it
  // ends, by id, so a dev server started later (or one left after the
  // landing has gone) doesn't hold them. None on a CLI that doesn't wake
  // when its jobs end (Codex): nothing would bring the asks back.
  private afterJobs(st: ThreadState, said: { afterJobs?: true }): { afterJobs?: string[] } {
    if (!said.afterJobs) return {};
    const ids = this.wakingShells(st).map((t) => t.id);
    return ids.length ? { afterJobs: ids } : {};
  }

  // For end_turn's handler: asks the last turn held back for its jobs
  // (askWhen "jobsEnd") that Mike hasn't ticked, so the turn a job's end
  // opens doesn't end with needs "nothing" and lose them (HELD_NUDGE).
  heldAsks(threadId: string): string[] {
    // Whatever turn it's from: a turn that failed since leaves the record
    // as it was, and the asks are still unseen.
    const n = this.threads.get(threadId)?.rec.needs;
    if (!n?.afterJobs) return [];
    const ticked = new Set(n.ticked);
    return (n.asks ?? []).filter((_, i) => !ticked.has(i)).map((a) => a.action);
  }

  // Whether a job the last turn's asks wait for is still going, or has just
  // finished with its result still to be read (the wake grace).
  private asksHeld(st: ThreadState): boolean {
    const { rec, rt } = st;
    const ids = rec.needs?.seq === rec.lastTurnCompletedSeq ? rec.needs.afterJobs : undefined;
    if (!ids?.length) return false;
    // All of them: the first to end opens a turn, and if none comes the
    // asks are Mike's, rather than waiting on a dev server named with it.
    const going = new Set([...rt.tasks, ...(rt.wakeTimer ? rt.finished : [])].map((t) => t.id));
    return ids.every((id) => going.has(id));
  }

  // Whether a shell the last turn left running without end_turn is still
  // going, or has just ended with its result about to be read (awaitedShells).
  // Only with no card for the last turn: asks it carried for jobs
  // (afterJobs) go by asksHeld, as the sections do.
  private awaitingShells(st: ThreadState, card: boolean): boolean {
    const { rec, rt } = st;
    if (card) return false;
    // Its nudge is queued (a draining runner's goes across first): not Mike's yet.
    if (rt.nudgeTurnId && rec.queue.some((m) => m.turnId === rt.nudgeTurnId)) return true;
    const ids = rt.awaitedShells;
    if (!ids?.length) return false;
    // One still running, or one ended and unread with its wake grace on.
    // An ended one is kept only until read (pruneAwaited), so a grace then
    // is for it, even one whose finished list a grace that ran out mid-turn
    // emptied (Gemini's review, 28 Nov 2026).
    const going = new Set(rt.tasks.map((t) => t.id));
    return ids.some((id) => going.has(id)) || (Boolean(rt.wakeTimer) && ids.some((id) => !going.has(id)));
  }

  // The awaited shells whose results have been read (a wake turn opened)
  // or never will be (the grace ran out with no turn going) come off.
  private pruneAwaited(st: ThreadState): void {
    const { rt } = st;
    if (!rt.awaitedShells) return;
    const going = new Set(rt.tasks.map((t) => t.id));
    const left = rt.awaitedShells.filter((id) => going.has(id));
    if (left.length) rt.awaitedShells = left;
    else delete rt.awaitedShells;
  }

  // For end_turn's handler: whether the thread's CLI still runs background
  // jobs or sub-agents of its own whose end wakes it (threadbear-mcp.ts,
  // projectStepNote). Codex doesn't wake for them (wakesAfterTasks).
  ownWorkRunning(threadId: string): boolean {
    const st = this.threads.get(threadId);
    if (!st || this.adapters[st.rt.sessionProvider ?? st.rec.provider]?.wakesAfterTasks === false) return false;
    return st.rt.tasks.length > 0 || Boolean(st.rec.subagents?.some((a) => a.status === 'running'));
  }

  get(threadId: string): ThreadSummary {
    return this.summary(this.mustGet(threadId));
  }

  private subagentReads = new SubagentTranscripts();

  // What a sub-agent has done so far, from the CLI's transcript of it or from
  // a hidden runner-managed coordinator helper's persisted event log.
  subagent(threadId: string, subagentId: string): { subagent?: Subagent; events: PersistedEvent[] } {
    const st = this.mustGet(threadId);
    const { rec } = st;
    const known = rec.subagents?.find((a) => a.id === subagentId);
    const helper = this.threads.get(subagentId);
    if (helper?.rec.coordinatorHelperFor === threadId) {
      const log = this.store.log(subagentId);
      const events = (log.lastSeq > 0 ? log.read(1, log.lastSeq) : []).map((e) => ({ ...e, threadId }));
      return known ? { subagent: publicSubagent(known), events } : { events };
    }
    const cwd = known?.cwd ?? rec.cwd;
    const account = this.accounts.get(known?.accountId ?? rec.accountId);
    const sessionId = known?.sessionId ?? rec.nativeSessionId;
    const file = account && sessionId ? this.subagentTranscript(account.configDir, cwd, sessionId, subagentId) : null;
    if (!file) throw new RpcError(ErrorCode.subagentNotFound, `There's no record of sub-agent ${subagentId} in this thread`);
    const ctx = fileContext(cwd, this.store.mediaDir(rec.id), path.join(this.store.blobsDir(rec.id), 'subagents'));
    let read: ReturnType<typeof readSubagentTranscript>;
    try {
      read = this.subagentReads.read(file, ctx);
    } catch (e) {
      throw new RpcError(ErrorCode.subagentNotFound, `Couldn't read sub-agent ${subagentId}'s transcript: ${String(e)}`);
    }
    const now = this.isoNow();
    const events = read.events.map((e, i) => ({ seq: i + 1, ts: e.ts ?? now, threadId, ...e.body }) as PersistedEvent);
    // The transcript is the one place that has its effort, and has its model
    // for a sub-agent the live stream didn't report one for (a resumed CLI).
    if (known && ((read.model && known.model !== read.model) || (read.effort && known.effort !== read.effort))) {
      if (read.model) known.model = read.model;
      if (read.effort) known.effort = read.effort;
      this.markDirty(st);
    }
    return known ? { subagent: publicSubagent(known), events } : { events };
  }

  events(threadId: string, opts: { afterSeq?: number; beforeSeq?: number; limit?: number } = {}) {
    const st = this.mustGet(threadId);
    const log = this.store.log(threadId);
    const last = log.lastSeq;
    if (st.rec.lastSeq !== last) st.rec.lastSeq = last;
    const limit = Math.min(Math.max(1, opts.limit ?? LIMITS.defaultEventsLimit), 10_000);
    let from: number;
    let to: number;
    if (opts.afterSeq !== undefined) {
      from = opts.afterSeq + 1;
      to = Math.min(last, opts.beforeSeq !== undefined ? opts.beforeSeq - 1 : last, from + limit - 1);
    } else if (opts.beforeSeq !== undefined) {
      to = Math.min(last, opts.beforeSeq - 1);
      from = Math.max(1, to - limit + 1);
    } else {
      to = last;
      from = Math.max(1, last - limit + 1);
    }
    const events = log.read(from, to);
    // Flush first so inProgress holds exactly what subscribers have seen.
    this.flushDeltas(st);
    return {
      events,
      firstSeq: events.length ? events[0].seq : 0,
      lastSeq: events.length ? events[events.length - 1].seq : last,
      inProgress: [...st.rt.inProgress.values()].filter((i) => i.text),
    };
  }

  // Backlog for a subscriber, read in the same tick it starts listening so
  // nothing falls between the replay and the live stream.
  backlog(threadId: string, afterSeq = 0): { events: PersistedEvent[]; inProgress: InProgressItem[] } {
    const st = this.mustGet(threadId);
    this.flushDeltas(st);
    const log = this.store.log(threadId);
    if (st.rec.lastSeq !== log.lastSeq) st.rec.lastSeq = log.lastSeq;
    return {
      events: log.read(afterSeq + 1, log.lastSeq),
      inProgress: [...st.rt.inProgress.values()].filter((i) => i.text),
    };
  }

  // ------------------------------------------------------------- mutations

  // The first user.message's text and the first assistant.text after it,
  // read a page at a time from the start: both are nearly always within
  // the first few events, and a long thread's log is large.
  opening(id: string, rec?: Pick<ThreadRecord, 'rewinds' | 'withheldSeqs'>): { text?: string; images?: number; reply?: string } {
    const log = this.store.log(id);
    let text: string | undefined;
    let images = 0;
    for (let from = 1; from <= Math.min(log.lastSeq, 500); from += 50) {
      for (const e of log.read(from, from + 49)) {
        if (rec && cutOut(rec, e.seq)) continue;
        if (text === undefined && e.type === 'user.message') {
          text = e.text;
          images = e.images?.length ?? 0;
        } else if (text !== undefined && e.type === 'assistant.text' && e.text.trim()) return { text, images, reply: e.text };
      }
    }
    return { text, images };
  }

  // origin "runner" marks a message the runner sends by itself (restart.ts),
  // "schedule" one a schedule sent (schedules.ts). `queue` keeps it out of a
  // running turn: it waits and starts its own.
  // Cache only the keys looked up. New deliveries search backwards through
  // their possible lifetime, rather than parsing the thread's whole history.
  private scheduledMessages = new WeakMap<EventLog, Map<string, { through: number; since: number; message?: ScheduledDelivery }>>();

  private scheduledMessage(st: ThreadState, messageId: string, since: number) {
    const delivery = this.scheduledDelivery(st, messageId, since);
    // A receipt acknowledges delivery without supplying a user.message row.
    return delivery && 'seq' in delivery ? delivery : undefined;
  }

  private scheduledDelivery(st: ThreadState, messageId: string, since: number, origin: MessageOrigin | null = 'schedule'): ScheduledDelivery | undefined {
    // A schedule/request may have been timestamped by another runner.
    since = Math.max(0, since - 5 * 60_000);
    const log = this.store.log(st.rec.id);
    let index = this.scheduledMessages.get(log);
    if (!index) { index = new Map(); this.scheduledMessages.set(log, index); }
    const cacheKey = `${origin}:${messageId}`;
    const cached = index.get(cacheKey);
    if (cached?.message?.started && cached.through <= log.lastSeq) return cached.message;
    if (cached?.through === log.lastSeq && cached.since <= since) return cached.message;
    const last = log.lastSeq;
    // A miss already checked the prefix for this time window. Streaming
    // after it only makes the appended suffix new work. A wider window or
    // a shorter log must search again from the beginning.
    const reuse = cached && cached.through <= last && cached.since <= since;
    const from = reuse ? cached.through + 1 : 1;
    let message = reuse ? cached.message : undefined;
    let started = message?.started ?? false;
    const finish = () => {
      const found = message?.superseded ? message : message && { ...message, started };
      index.set(cacheKey, { through: last, since, message: found });
      return found;
    };
    for (let to = last; to >= from; to -= 128) {
      const events = log.read(Math.max(from, to - 127), to);
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.type === 'system.note' && e.supersededReminder === messageId) {
          message = { superseded: true, started: true };
          started = true;
          return finish();
        }
        if (e.turnId === messageId) {
          if (e.type === 'turn.started') {
            started = true;
            if (message) return finish();
          }
          if (e.type === 'user.message' && e.origin === (origin ?? undefined)) {
            message = { seq: e.seq, started, text: e.text, images: e.images };
            return finish();
          }
        }
        if (Date.parse(e.ts) < since) return finish();
      }
    }
    return finish();
  }

  findScheduledSend(threadId: string, scheduleId: string, run?: string, since = 0, origin: MessageOrigin = 'schedule'): { turnId: string } | undefined {
    if (!run) return undefined;
    const st = this.mustGet(threadId);
    const turnId = scheduledMessageId(threadId, scheduleId, run);
    if (st.rec.queue.some((q) => q.turnId === turnId) || this.scheduledDelivery(st, turnId, since, origin)?.started) return { turnId };
    return undefined;
  }

  sendScheduled(threadId: string, text: string, scheduleId: string, run?: string, since = 0, preserve?: boolean, ceiling?: PermissionMode): { turnId: string } {
    const prior = this.findScheduledSend(threadId, scheduleId, run, since);
    if (prior) return prior;
    const messageId = run ? scheduledMessageId(threadId, scheduleId, run) : undefined;
    // Deleted while this was on its way (a handover's fallback, a retry):
    // an idle thread would start it straight away, past prepareQueue.
    if (this.wasScheduleDeleted(scheduleId)) return { turnId: messageId ?? crypto.randomUUID() };
    const logged = messageId ? this.scheduledMessage(this.mustGet(threadId), messageId, since) : undefined;
    // A partial start retries the original logged input, including its check
    // output, so the model reads exactly what the transcript shows.
    return this.send(threadId, logged?.text ?? text, logged?.images ?? [], { origin: 'schedule', scheduleId, queue: true, ...(preserve !== undefined ? { preserveSchedule: preserve } : {}), ...(messageId ? { messageId, scheduledSince: since } : {}), ...(ceiling !== undefined ? { ceiling } : {}) });
  }

  send(threadId: string, text: string, images: ImageRef[] = [], opts: SendOptions = {}): { turnId: string; held?: true } {
    const st = this.mustGet(threadId);
    this.checkAccepting();
    // A thread a draining runner is letting go of is about to be the new
    // runner's; a message queued here now would be lost on the way. The Mac
    // app sends it again on the new runner by these words
    // (AppModel.turnedAwayByRestart), so keep them.
    if (this.draining && !this.draining.keep.has(threadId)) throw new RpcError(ErrorCode.busy, 'The runner is handing over to a new one; send again in a moment.');
    if (!text && images.length === 0) throw new RpcError(ErrorCode.badParams, 'text or images required');
    // Its turn was made up; a real agent picking it up would only be lost.
    if (st.rec.sample) throw new RpcError(ErrorCode.badParams, "This is one of the tour's sample threads, so nothing can be sent to it. Start a new thread to try it for real.");
    checkImages(images);
    // A report to the thread that started the sender, kept until its other
    // threads finish (runner/nested.ts).
    if (this.holdReport(st, text, images, opts)) return { turnId: crypto.randomUUID(), held: true };
    // Another thread's message, allowed for this thread as it is now: if
    // it waits in the queue while Mike raises this thread, it's held as it
    // leaves (runner/ceiling.ts).
    // A move's `then` too: move_thread can send it to another thread.
    if (opts.ceiling === undefined && !opts.origin && sentByAgent(text)) opts = { ...opts, ceiling: this.agentCeiling(st) };
    // Mike writing: anything held goes in first, so he and it see the same.
    if (fromMike(text, opts) && st.rec.heldReports?.length) this.deliverHeld(st);
    return { turnId: this.sendTo(st, text, images, opts) };
  }

  sendTo(st: ThreadState, text: string, images: ImageRef[], opts: SendOptions = {}): string {
    const { rec, rt } = st;
    // Written with less access than it has now: Mike's to read, not its
    // agent's (runner/ceiling.ts). Checked again as it leaves the queue.
    if (!this.underCeiling(st, opts.ceiling)) {
      this.withholdMessage(st, { text, origin: opts.origin, scheduleId: opts.scheduleId, helperRunId: opts.helperRunId });
      return opts.messageId ?? crypto.randomUUID();
    }
    if (opts.answers?.length && fromMike(text, opts)) {
      this.coordinators?.checkCardAnswers(rec, opts.answers);
      if (this.answered) {
        const open = rec.needs?.needs === 'you' && rec.needs.seq === rec.lastTurnCompletedSeq ? rec.needs.asks : undefined;
        try {
          this.answered(rec.id, opts.answers, open);
        } catch (e) {
          this.log.warn('acting on an answer failed', { threadId: rec.id, error: String((e as Error)?.message ?? e) });
        }
      }
    }
    // He has had his say: a wait's checks at its latest time count from here
    // (runner/hibernation.ts, wakeAtTime).
    if (fromMike(text, opts)) delete rec.lateChecks;
    if (opts.origin !== 'runner') {
      rt.hookTurns = undefined;
      delete rec.stoppedWorkWakes;
      // A new ask: its change can be reviewed afresh. Not while a review's
      // findings wait for their answers, unless it's Mike who wrote: another
      // thread's note or a schedule's run would let the turn end without
      // them (Codex's review of the ledger, 11 Nov 2026).
      if (fromMike(text, opts) || !openFindings(rec.labReview).length) {
        delete rec.labReviews;
        delete rec.labReview;
      }
    }
    // Copy images into the thread's own media folder now, so a queued
    // message still works if inbox/ is cleaned before it's sent.
    const media = this.store.mediaDir(rec.id);
    const refs = images.map((img) => {
      if (!img?.path || !fs.existsSync(img.path)) throw new RpcError(ErrorCode.badParams, `Image not found: ${img?.path}`);
      if (path.dirname(img.path) === media) return imageRefFor(img.path, img.mediaType);
      try {
        return copyImageInto(media, img.path);
      } catch (e) {
        throw new RpcError(ErrorCode.badParams, (e as Error).message);
      }
    });
    // New work: its last finish no longer says it's done, for threads
    // waiting on it (runner/hibernation.ts).
    delete rec.finished;
    // Sending to a snoozed or archived thread brings it back. A schedule's
    // message notes it came out of the archive, so the run can put it back
    // if it ends with nothing for Mike (the end of the turn, below).
    // Answering it from his phone without opening it counts as having seen
    // it woke (place.ts, message). Mike doing it is written down first, while
    // the record still says who put it away (runner/inbox-guess.ts).
    if (fromMike(text, opts)) {
      this.noteRevive(st, text);
      if (!this.commandPlan(st, text) && rec.needs?.next?.length) {
        delete rec.needs.next;
        delete rec.needs.nextPick;
        delete rec.needs.nextSuggested;
        this.markDirty(st);
      }
    }
    if (placeOf(rec).kind !== 'inbox') this.cli(st, { kind: 'stay' });
    this.park(st, { kind: 'message', fromSchedule: opts.origin === 'schedule', fromMike: fromMike(text, opts) });
    this.supersedeReviews(st, text, opts);
    // He has seen the reply a waiting panel went with.
    if (rec.panelRequest && fromMike(text, opts)) {
      delete rec.panelRequest;
      this.endPanelWait(st, false);
      this.markDirty(st);
    }
    const turnId = opts.messageId ?? crypto.randomUUID();
    const msg: QueuedSend = { turnId, text, images: refs };
    if (opts.origin) msg.origin = opts.origin;
    if (opts.wakeReason && opts.origin === 'runner') msg.wakeReason = opts.wakeReason;
    if (opts.scheduleId) msg.scheduleId = opts.scheduleId;
    if (opts.helperRunId) msg.helperRunId = opts.helperRunId;
    if (opts.preserveSchedule !== undefined) msg.preserveSchedule = opts.preserveSchedule;
    if (opts.scheduledSince !== undefined) msg.scheduledSince = opts.scheduledSince;
    if (opts.answers?.length) msg.answers = opts.answers;
    if (opts.editOf) msg.editOf = opts.editOf;
    // Every message this release queues says its ceiling ('full' for none),
    // so one with none at all is from an older release (legacyCeiling).
    msg.ceiling = opts.ceiling ?? 'full';
    rec.lastActivityAt = this.isoNow();
    if (rt.turn && !opts.queue && fromMike(text, opts) && this.switchWaiting(st)) {
      // He picked another login (another provider, usually) during this
      // turn, then wrote: the message is for the new one, now, as in T3
      // Code. This turn stops and the message starts the next one there,
      // with the handoff. Steering it into the old CLI would answer it on
      // the model he just moved away from.
      rec.queue.push(msg);
      this.emit(st, { type: 'system.note', text: `Stopped here so ${this.modelLabel(rec)} can take over.` }, rt.turn.turnId);
      this.markDirty(st);
      this.interrupt(rec.id);
      return turnId;
    }
    // A message from Mike while a plan waits (and isn't Claude's approval,
    // which the card-declining below sends back): he's answering it in
    // words, so it goes back for another go.
    if (rec.openPlan && fromMike(text, opts) && ![...rt.approvals.values()].some((p) => p.kind === 'tool' && p.plan === rec.openPlan)) {
      this.emit(st, { type: 'plan.resolved', itemId: rec.openPlan, decision: 'revise' }, rt.turn?.turnId);
      delete rec.openPlan;
      this.markDirty(st);
    }
    if (rt.turn && rt.approvals.size && fromMike(text, opts)) {
      // He wrote instead of using the card. The CLI is parked on the card's
      // answer and won't read anything else until it has one, so a message
      // steered or queued now would sit unread behind it for good. Declining
      // the card lets the CLI move on and take the message next.
      for (const [approvalId, pending] of [...rt.approvals]) {
        if (!pending.main) continue;
        this.resolveApproval(st, approvalId, 'deny', WROTE_INSTEAD);
        settleDeclined(pending, 'deny', WROTE_INSTEAD);
      }
    }
    // The same for a call the card reviewer is still deciding on: he may be
    // taking it back, and the reviewer read the thread before he wrote.
    if (rt.reviews?.size && fromMike(text, opts)) {
      for (const r of [...rt.reviews.values()]) {
        if (r.main) r.cancel({ decision: 'deny', message: WROTE_INSTEAD });
        else r.stale = true;
      }
    }
    // A slash command waits for the turn to end rather than going into it:
    // a CLI runs one only as a message of its own, and the runner's own
    // change settings for the next turn.
    // A schedule's or the runner's own note doesn't go past one already
    // waiting either: CI's "passed again" mustn't reach the agent before the
    // "failed again" queued while it compacted (Codex's review, 25 Nov). Nor
    // past a message of Mike's a Stop left unread, as it waits for that
    // below (Gemini's review).
    const overtakes = isAutomaticInput(msg) && (rec.queue.some(isAutomaticInput) || Boolean(rec.interruptedMessages?.length));
    if (rt.turn && !opts.queue && !overtakes && this.canSteer(st) && !this.commandPlan(st, text)) {
      // Sent while a turn runs: it goes into that turn now, as typing into
      // the CLI would. The CLI takes it at its next step, or straight after
      // its reply if that was already finishing; either way the thread's
      // turn goes on until it's answered, so the caller gets that turn's id.
      this.steer(st, msg);
      return rt.turn.turnId;
    }
    // Moving to another runner (runner/moves.ts): it waits, and goes with the thread.
    if (rt.turn || rec.queue.length || this.draining || rt.editing || rt.moving || rt.holds?.size || (rec.interruptedMessages?.length && isAutomaticInput(msg))) {
      // Behind a running turn, or behind messages that couldn't start
      // earlier: they go first. On a draining runner a thread with no turn
      // is usually about to move across, and the message goes with it
      // (kickQueue starts it here if background work is holding the thread).
      // One of Mike's held back only by a cold compaction goes into the turn
      // once it has compacted (runner/cold-compact.ts).
      if (rt.turn?.precompact && !opts.queue) this.noteQueuedMeanwhile(st, msg);
      rec.queue.push(msg);
      this.markDirty(st);
      if (!this.kickQueue(st) && this.queueHeld(st)) this.scheduleIdle(st);
      return turnId;
    }
    // Onto the live CLI: it waits in the queue (shown there) while the
    // folder's Claude Code settings are looked at (kickQueue, rt.preLook).
    if (this.needsPreLook(st)) {
      rec.queue.push(msg);
      this.markDirty(st);
      this.kickQueue(st);
      return turnId;
    }
    this.startTurn(st, msg);
    return turnId;
  }

  // A message sent during a turn can go into it only while the CLI is
  // there to take it and nothing is set to change under it: not while a
  // CLI is still starting or leaving, not behind ordinary messages waiting
  // (reminders never hold up a message from Mike or another thread),
  // not once a move or a fresh CLI is due on the next turn (the message is
  // meant for that), not after Stop was pressed (the CLI would cancel it
  // with the rest), and not into a turn opened only for a card, where
  // there's no CLI turn to join.
  // deliver's looks at the folder's Claude Code settings, on the trust
  // worker's urgent lane (never shared with a look begun earlier). Only
  // with a worker: without one (tests) checkClaude looks for itself as
  // before, and the turn starts its CLI synchronously. `forStart`: both
  // kinds startSession asks about; otherwise the thread's own kind, for
  // the check on a live CLI. A look that fails or times out throws: looking
  // again on this thread could hang it on the same file (a FIFO).
  async claudeLooks(st: ThreadState, forStart: boolean): Promise<ClaudeLook[] | undefined> {
    const { rec } = st;
    if (rec.provider !== 'claude' || !this.offThread || !this.patchTrust.lookClaude) return undefined;
    const cwd = rec.cwd;
    // In Full both kinds, looked at together in one go on the worker, as
    // close together as startSession's two checks were: two calls queued
    // apart could see the folder before and after a pull.
    const kinds = lookKinds(rec, forStart);
    if (this.patchTrust.lookClaudeKinds) return await this.patchTrust.lookClaudeKinds(cwd, kinds, 'urgent');
    return await Promise.all(kinds.map((grants) => this.patchTrust.lookClaude!(cwd, { grants }, 'urgent')));
  }

  // Whether the front of the queue waits for a look before its turn starts
  // on the live CLI (rt.preLook): only with a worker to look on.
  // Not on a draining runner: a schedule handed to it must start at once
  // or be refused (handover.ts sendScheduled), so it looks as before.
  needsPreLook(st: ThreadState): boolean {
    const { rec, rt } = st;
    return rec.provider === 'claude' && Boolean(this.offThread && this.patchTrust.lookClaude) && Boolean(runningSession(rt)) && !this.draining;
  }

  // Whether the look still answers for the front of the queue as it is.
  preLookFits(st: ThreadState, pre: NonNullable<Runtime['preLook']>): boolean {
    const { rec } = st;
    return pre.front === rec.queue[0]?.turnId && pre.cwd === rec.cwd && pre.grants === (claudeOptions(rec).grants === true);
  }

  startPreLook(st: ThreadState): void {
    const { rec, rt } = st;
    const token = {};
    const pre: NonNullable<Runtime['preLook']> = { token, front: rec.queue[0]!.turnId, cwd: rec.cwd, grants: claudeOptions(rec).grants === true };
    rt.preLook = pre;
    const done = () => {
      if (rt.preLook !== pre || rt.deleted) return;
      // A snoozed or archived thread keeps its queue until it comes back.
      if (this.bucket(st.rec) === 'inbox') this.kickQueue(st);
      // Not taken (a turn started meanwhile, the thread was snoozed): it's
      // dropped, and the next kick looks again.
      if (rt.preLook === pre) rt.preLook = undefined;
    };
    this.claudeLooks(st, false).then(
      (looks) => {
        pre.looks = looks ?? [];
        done();
      },
      (e: unknown) => {
        pre.failed = e instanceof Error ? e.message : String(e);
        done();
      },
    );
  }

  // `ahead`: what's queued in front of the message, the whole queue for a
  // new one; less for one already in it (steerQueuedMeanwhile).
  canSteer(st: ThreadState, ahead: QueuedSend[] = st.rec.queue): boolean {
    const { rec, rt } = st;
    const turn = rt.turn;
    if (!turn || !runningSession(rt) || this.stopping || rt.editing) return false;
    if (ahead.some(q => !isAutomaticInput(q)) || rec.handoff || rec.moved || rt.releaseWhenIdle || turn.interruptRequested) return false;
    // Nor into a compaction or review (a skill's turn takes them).
    if (turn.noSteer || turn.local) return false;
    return !turn.auto || Boolean(turn.cliStarted);
  }

  // A move to another login is waiting for the next turn while this one
  // runs on the old login's CLI.
  switchWaiting(st: ThreadState): boolean {
    const { rec, rt } = st;
    const turn = rt.turn;
    if (!turn || !rt.session || turn.interruptRequested || (turn.auto && !turn.cliStarted) || rt.editing) return false;
    return Boolean(rec.handoff && rec.handoff.fromAccountId !== rec.accountId);
  }

  // "Opus 5.5", or the login's name when there's no model to name.
  modelLabel(rec: ThreadRecord): string {
    const account = this.accounts.get(rec.accountId);
    if (!account) return rec.accountId;
    const model = rec.model ?? account.defaultModel;
    return model ? modelTitle(account, model) : account.title;
  }

  // Shows the message in the running turn and hands it to the CLI. If the
  // event can't be written the message isn't sent, and the caller gets the
  // error (the app puts the draft back).
  // `queued`: it waited in the queue, so threads.send gave it its own id,
  // which the event names (sentAs) for anyone waiting on that id, and only
  // the automatic inputs queued before it (olderInputs) are older than it.
  steer(st: ThreadState, msg: QueuedSend, queued?: { olderInputs: ReadonlySet<string> }): void {
    const { rt } = st;
    const turn = rt.turn!;
    const event = this.emit(st, { ...userMessage(msg), ...(queued ? { sentAs: msg.turnId } : {}) }, turn.turnId);
    this.markOlderInputs(st, msg, queued?.olderInputs);
    (turn.inputs ??= new Map()).set(msg.turnId, event.seq);
    if (msg.ceiling !== undefined) (turn.ceilings ??= new Map()).set(msg.turnId, msg.ceiling);
    turn.messages.push(msg.turnId);
    if (!isCarryOn(msg)) turn.newWork = true;
    if (fromMike(msg.text, msg)) turn.byMike = true;
    if (msg.wakeReason === COORDINATOR_TASK_WAKE) turn.fromCoordinatorTasks = true;
    // He wrote again, so the turn owes him another reply; a card it was sent
    // back for (needs.ts, REPLY_ASKS) gives way to this message's own (from
    // Codex's review); an archive it asked for before reading this is off.
    this.reply(st, { kind: 'message' });
    this.markDirty(st);
    // A change reaches a running turn too, or a clear could wait out as many
    // messages as were sent into it (Codex review).
    turn.dispatched = true;
    if (!turn.deliveryKnown) turn.foreignOutput = false;
    this.sendWithInstructionsNews(st, this.withInterruptedMessages(st, msg, this.forAgent(msg)));
  }

  // A turn that had its end_turn, opened again once the agent has read a
  // background task's notification (7 Nov 2026, thread 46de9389). Unlike a
  // message (steer) nothing new is owed to Mike, but the work after it is the
  // turn's latest: its text is kept and becomes the preview, and the card
  // that was taken stands only until the next end_turn. A "What I need from
  // you" the reply had (replyNeeds) stands until then too, as the agent may
  // stop without another. A one-reply turn's text stays its reply (replyAfter,
  // marked final), so a report written after the wake shows even without a
  // new end_turn (TranscriptReducer, reply(of:), picks among them).
  seeWake(st: ThreadState, ev: { type: string; itemId?: string; wake?: true }): void {
    const turn = st.rt.turn;
    if (!turn) return;
    turn.wake ??= new WakeRead();
    if (turn.wake.see(ev)) this.reply(st, { kind: 'wakeRead' });
  }

  // Moves the running turn's reply phase (reply-phase.ts), the only way
  // its fields change. A refusal (fields that fit no phase) leaves them
  // and is logged; the event then goes as in a turn with no end_turn.
  // The thread's CLI (cli-session.ts): the only way its fields change. A
  // stale event (for an older CLI) changes nothing and says nothing; a move
  // the table says never happens is made as the old writes made it, and
  // logged, so a real one shows up.
  cli(st: ThreadState, e: CliEvent): CliMove {
    const from = cliOf(st.rt).kind;
    const res = cliRuntime(st.rt, e);
    if (!res.ok) {
      if (res.reason !== STALE) this.log.warn('refused a CLI session move', { threadId: st.rec.id, event: e.kind, from, reason: res.reason });
    } else if (res.unexpected) this.log.warn('an unexpected CLI session move', { threadId: st.rec.id, event: e.kind, from, to: res.state.kind, why: res.unexpected });
    return res;
  }

  reply(st: ThreadState, e: ReplyEvent): ReplyMove | undefined {
    const turn = st.rt.turn;
    if (!turn) return undefined;
    const res = replyTurn(turn, e);
    if (!res.ok) this.log.warn('refused a reply phase move', { threadId: st.rec.id, event: e.kind, reason: res.reason });
    return res;
  }

  private markOlderInputs(st: ThreadState, msg: QueuedSend, only?: ReadonlySet<string>): void {
    if (!isAutomaticInput(msg) || msg.retryAfterInterrupt) {
      for (const q of st.rec.queue) {
        if (only && !only.has(q.turnId)) continue;
        if (isAutomaticInput(q) && (!msg.retryAfterInterrupt || !q.retryAfterInterrupt)) q.beforeMessage = true;
      }
    }
  }

  // The text the agent gets for a message. One from the phone says so, and
  // whether he's still at the Mac, so the agent doesn't hand him a Mac-only
  // step while he's out and keeps the reply short. It goes on every phone
  // message rather than once, as he moves between the two. The transcript
  // keeps what he typed. "Phone app", not "iPhone app": the origin doesn't say
  // which, and an Android phone (android-native/, or Keith's) sends the same.
  forAgent(msg: { text: string; origin?: MessageOrigin; beforeMessage?: true }): string {
    if (msg.beforeMessage) return `${msg.text}\n\nThis ${msg.origin === 'schedule' ? 'reminder' : 'message'} was queued before a later message in this thread. Follow the later instructions, including any request to stop.`;
    if (msg.origin !== 'phone') return msg.text;
    const atMac = this.atMac?.();
    const where = atMac === true ? ', at the Mac' : atMac === false ? ', away from the Mac' : '';
    return `[Sent from the phone app${where}]\n${msg.text}`;
  }

  // Writes the turn's first events before changing any state, so if the
  // disk refuses (full, permissions) the thread is left as it was rather
  // than stuck on a turn that never started.
  // `live`: kickQueue's look at the folder for a turn on the live CLI.
  startTurn(st: ThreadState, msg: QueuedSend, live?: LiveLook): void {
    const { rec, rt } = st;
    // Only the thread's own pictures go to the agent: everything queued was
    // copied into its media folder when it was sent (sendTo, a review's
    // answer), so anything else came from a record another runner wrote (a
    // moved thread's queue, which recovery steps that throw can leave
    // unchecked) and could name any file here (Codex's review, 17 Nov).
    // Here so the transcript shows what goes; every send to the CLI checks
    // again (startSession), which covers the paths that don't come by here.
    const checked = this.ownInput(st, { text: msg.text, images: msg.images });
    if (checked.text !== msg.text || checked.images !== msg.images) msg = { ...msg, text: checked.text, images: checked.images };
    // New work (a review's answer comes this way without sendTo).
    delete rec.finished;
    // A review can be replayed after a failed turn.started append. Its
    // stable message ID keeps the original user row rather than duplicating it.
    const reviewMessage = msg.reviewId ? this.store.log(rec.id).read(1, rec.lastSeq).find(e => e.type === 'user.message' && e.reviewId === msg.reviewId && e.turnId === msg.turnId) : undefined;
    const scheduledMessage = msg.scheduledSince !== undefined ? this.scheduledMessage(st, msg.turnId, msg.scheduledSince) : undefined;
    const messageSeq = reviewMessage?.seq ?? scheduledMessage?.seq ?? this.emit(st, userMessage(msg), msg.turnId).seq;
    try {
      this.emit(st, { type: 'turn.started', turnId: msg.turnId }, msg.turnId);
      this.noteHelperStart(st, msg.turnId);
    } catch (e) {
      this.markDirty(st);
      throw e;
    }
    // Started: how this turn ends says whether it wants Mike now.
    delete rec.quietWake;
    rt.idleTimer?.cancel();
    rt.idleTimer = undefined;
    rt.turn = { turnId: msg.turnId, startedAt: this.clock.now(), interruptRequested: false, messages: [msg.turnId], edited: new Set(), access: rec.permissionMode };
    rt.turn.skipIdleCompaction = /^\/(compact|clear)(?:\s|$)/i.test(msg.text.trimStart());
    rt.turn.inputs = new Map([[msg.turnId, messageSeq]]);
    if (!isCarryOn(msg)) rt.turn.newWork = true;
    if (fromMike(msg.text, msg)) rt.turn.byMike = true;
    if (msg.wakeReason === COORDINATOR_TASK_WAKE) rt.turn.fromCoordinatorTasks = true;
    if (msg.ceiling !== undefined) rt.turn.ceilings = new Map([[msg.turnId, msg.ceiling]]);
    if (msg.helperRunId) rt.turn.helperRunId = msg.helperRunId;
    this.markOlderInputs(st, msg);
    rt.activeAt = this.clock.now();
    rec.turnId = msg.turnId;
    rec.lastActivityAt = this.isoNow();
    // Any turn ends a wait for room: a message from Mike goes through the
    // same check as the runner's own carry-on would.
    if (rec.waitingForRoom) {
      delete rec.waitingForRoom;
      this.armRoomTimer();
    }
    delete rec.limitHitTurn;
    // Likewise a wait for the network: a message from Mike goes now, and
    // if the line's still down it fails and the wait starts over. A turn
    // that isn't the runner's carry-on ends that outage's count.
    delete rec.waitingForNetwork;
    if (rec.netCarryOn && rec.netCarryOn.turnId !== msg.turnId) delete rec.netCarryOn;
    this.beforeTurn(st);
    // A subagent's card can still be open (docs/protocol/needs-you.md, "A subagent's card").
    rec.status = runningSession(rt) ? (rt.approvals.size ? 'waiting' : 'running') : 'starting';
    this.markDirty(st);
    // A message to the thread (not a turn the CLI opened by itself), so the
    // librarian can file a new thread before its first turn is over.
    if (!this.stopping) this.tellActivity({ kind: 'turn.start', threadId: rec.id });
    this.deliver(st, msg, live).catch((e: unknown) => {
      this.log.error('could not start turn', { threadId: rec.id, error: String(e) });
      this.failTurn(st, e instanceof Error ? e.message : String(e));
    });
  }

  async deliver(st: ThreadState, msg: QueuedSend, live?: LiveLook): Promise<void> {
    const { rec, rt } = st;
    // Deleted (which leaves rt.turn as it was) or interrupted meanwhile.
    const gone = () => rt.deleted || rt.turn?.turnId !== msg.turnId;
    // Looks at the folder's Claude Code settings on the trust worker, as a
    // folder outside git is walked, which held the main thread for seconds
    // at every message (19 Nov). After the look, the turn may have been
    // stopped: with a live CLI that keeps the turn for its grace period, so
    // it ends here, before anything is sent.
    const cantRead = (why: string) => new Error(`Couldn't read this folder's Claude Code settings: ${why}`);
    // A look that failed (a hung folder) fails the turn: looking again here
    // would be on the main thread, and could hang it on the same file.
    // Only while it's still a Claude thread: one moved to Codex meanwhile
    // (a pool, the account menu) doesn't read them.
    if (live && 'failed' in live && rec.provider === 'claude') throw cantRead(live.failed);
    // A look that fails while the folder or access changed is taken
    // again (the loop below), as it was of the old one.
    const look = async (): Promise<ClaudeLook[] | 'gone' | undefined> => {
      const cwd = rec.cwd;
      const kinds = lookKinds(rec, true).join();
      let looks: ClaudeLook[] | undefined;
      try {
        looks = await this.claudeLooks(st, true);
      } catch (e) {
        if (gone()) return 'gone';
        if (rec.provider !== 'claude' || rec.cwd !== cwd || lookKinds(rec, true).join() !== kinds) return [];
        throw cantRead(e instanceof Error ? e.message : String(e));
      }
      return gone() ? 'gone' : looks;
    };
    // A folder, account or settings change asked for a fresh CLI, or a CLI
    // update came in since this one started. (One already closing goes
    // anyway: the turn waits for it below.)
    if (runningSession(rt) && (rt.releaseWhenIdle || rec.handoff || (rt.versionMove && rt.tasks.length === 0))) this.releaseSession(st);
    // The folder's Claude Code hooks were trusted since the CLI started
    // without them, or new ones came that aren't (a pull): a fresh CLI
    // reads the folder's settings again.
    // Not for one already closing: the turn waits for it below, then looks
    // for the new one.
    else if (runningSession(rt) && rec.provider === 'claude' && Boolean(rt.claudeSkipped) === this.patchTrust.checkClaude(rec.cwd, claudeOptions(rec), lookFor(live && !('failed' in live) ? live : undefined, rec.cwd, claudeOptions(rec))).trusted) this.releaseSession(st);
    // Never two live CLIs on one session: wait for a releasing one to exit.
    while (rt.closing) await rt.closing;
    // An archive's worktree cleanup still running: where this turn starts
    // depends on whether it removed the folder (leaveRemovedWorktree), and
    // a CLI started there meanwhile would have the folder taken from under it.
    while (rt.cleaning) await rt.cleaning;
    if (gone()) return; // interrupted while waiting
    const local = this.runLocalCommand(st, msg);
    if (local === true || (local !== false && (await local))) return;
    // A slash command reaches the CLI as typed: anything put in front of it
    // (the phone's line, project news) would make it words to the model.
    const command = this.commandPlan(st, msg.text);
    if (command && /^\/clear\b/i.test(msg.text.trim())) {
      delete rec.interruptedMessages;
      delete rec.messageRecoveries;
    }
    if (command && rt.turn) {
      rt.turn.command = true;
      if (/^\/(compact|review|clear)\b/i.test(msg.text.trim())) rt.turn.noSteer = true;
    }
    const input = command ? { id: msg.turnId, text: msg.text, images: msg.images } : this.withInterruptedMessages(st, msg, this.forAgent(msg));
    let text = input.text;
    // Claude's CLI starts a new session for /clear, which the runner follows
    // (its next init), but says nothing.
    if (command && rec.provider === 'claude' && /^\/clear\b/i.test(msg.text.trim())) {
      this.emit(st, { type: 'system.note', text: 'Cleared the conversation. The agent starts fresh from your next message; the transcript above stays here for you.' }, msg.turnId);
      // The same CLI goes on with the system prompt it started with, and
      // whatever a message told it has gone (Codex review).
      if (rec.instructionsTold !== undefined) rec.instructionsTold = INSTRUCTIONS_REWOUND;
    }
    while (rt.preparing) await rt.preparing;
    if (gone()) return;
    // For a new CLI: looked at here, after the waits above, and used only
    // if nothing below waits again before startSession (the worktree steps
    // drop it), so it's as fresh as looking there.
    // A turn with a worktree step below waits there, so a look now would be
    // dropped: startSession looks for itself.
    let forStart = !rt.session && rec.provider === 'claude' && this.offThread && !rec.worktreePending && !this.leavesRemovedWorktree(rec) ? await look() : undefined;
    // The folder or access changed while it looked: look again (a few
    // times at most, then startSession looks for itself, as before).
    for (let i = 0; forStart && forStart !== 'gone' && !looksCover(forStart, rec, true) && i < 3; i++) forStart = await look();
    if (forStart === 'gone') return;
    if (!rt.session && rec.worktreePending) {
      forStart = undefined;
      const preparing = this.prepareWorktree(st, msg.turnId);
      const held: Promise<void> = preparing
        .catch(() => undefined)
        .finally(() => {
          if (rt.preparing !== held) return;
          rt.preparing = undefined;
          // An archive that came meanwhile goes ahead now, and a handover
          // that kept the thread for it looks again.
          this.archiveWhenGone(st);
          if (this.draining) this.queueHandoverCheck();
          // A restart waiting for it hears through thread.updated.
          this.markDirty(st);
        });
      rt.preparing = held;
      await preparing;
      if (gone()) return; // interrupted or deleted during setup
    }
    // Raised above its ceiling while it waited for any of the above: before
    // anything below takes what's kept for the next message (runner/ceiling.ts).
    if (this.heldAtDispatch(st, msg)) return;
    // A slot it works in that has since gone back to the spares or to
    // someone else (lentFolder): it never carries on there beside their
    // work. Asked after every wait above (it may have moved, or the slot
    // been lent meanwhile), and a live CLI there goes too: a give-back in its
    // own session, a Codex session moved in with setCwd.
    const inSlot = !this.leavesRemovedWorktree(rec) && Boolean(this.slotFolderOf(rec));
    let lent = inSlot ? await this.lentFolder(rec).catch(() => undefined) : undefined;
    if (gone()) return;
    // Its look was taken before that wait: looked at again.
    if (inSlot && forStart && !lent) {
      forStart = await look();
      if (forStart === 'gone') return;
      if (forStart && !looksCover(forStart, rec, true)) forStart = undefined;
      if (gone()) return;
    }
    // A slash command would reach the CLI as words with the move's notice in
    // front of it, as a thread brought back to a removed worktree's would
    // (runCommandPlan): it waits for a message, which makes the move.
    if (lent && command && rt.turn) {
      this.runCommandPlan(st, msg, { kind: 'note', text: `This thread's folder ${lent.slot} ${lent.went}, so it moves to a fresh worktree with your next message. Send one first, then ${msg.text.trim().split(/\s/)[0]} again.` });
      return;
    }
    if (lent && runningSession(rt)) {
      this.releaseSession(st);
      while (rt.closing) await rt.closing;
      if (gone()) return;
      lent = !this.leavesRemovedWorktree(rec) && this.slotFolderOf(rec) ? await this.lentFolder(rec).catch(() => undefined) : undefined;
      if (gone()) return;
    }
    if (!rt.session && (lent || this.leavesRemovedWorktree(rec))) {
      forStart = undefined;
      // Held as a new thread's worktree is, so an archive that comes
      // meanwhile waits for it rather than cleaning up under it.
      const leaving = lent ? this.leaveLentFolder(st, msg.turnId, lent) : this.leaveRemovedWorktree(st, msg.turnId);
      const held: Promise<void> = leaving
        .then(() => undefined, () => undefined)
        .finally(() => {
          if (rt.preparing !== held) return;
          rt.preparing = undefined;
          this.archiveWhenGone(st);
          if (this.draining) this.queueHandoverCheck();
          this.markDirty(st);
        });
      rt.preparing = held;
      // The notice it leaves is on the record (agentNotice), so one stopped
      // meanwhile still has it for its next message.
      await leaving;
      if (gone()) return;
      if (this.heldAtDispatch(st, msg)) return;
    } else if (!rt.session) {
      const left = this.tellTornDown(st, msg.turnId);
      if (left) text = `${left}\n\n${text}`;
    }
    if (!rt.session && typeof rec.agentNotice === 'string') {
      text = `${rec.agentNotice}\n\n${text}`;
      delete rec.agentNotice;
      this.markDirty(st);
    }
    // Emails the email watcher kept for this thread's next turn.
    const mail = this.takeHeldMail(st);
    if (mail) text = `${mail}\n\n${text}`;
    if (!rt.session) {
      const account = this.accounts.get(rec.accountId);
      if (!account) throw new Error(`Account ${rec.accountId} isn't available on this Mac.`);
      // Said in the thread as the turn's failure, so it says how to carry on.
      if (!isDirectory(rec.cwd)) throw new Error(`Folder not found: ${rec.cwd}. Pick another folder for this thread from the + menu by the message box, then send again.`);
      if (rec.handoff && this.carryTranscript(st, account)) {
        // A new folder, or another Claude login: the whole conversation
        // came along.
        const from = rec.handoff;
        const text =
          from.fromAccountId === rec.accountId
            ? `Moved to ${rec.cwd}. The session carries on there.`
            : from.fromCwd === rec.cwd
              ? `Resumed the session on ${account.title}, with the whole conversation.`
              : `Moved to ${rec.cwd} on ${account.title}. The session carries on there, with the whole conversation.`;
        this.emit(st, { type: 'system.note', text }, msg.turnId);
        rt.carried = rec.handoff;
        delete rec.handoff;
      } else if (rec.handoff) {
        // The new session gets the conversation's messages, not what went
        // in front of one: why the thread last woke is told again.
        this.retellWakeNews(rec);
        text = this.handoffNote(st, account) + text;
        // A quick ask's thread never had a session, so nothing to say.
        if (!rec.handoff.quickAsk) this.emit(st, { type: 'system.note', text: `Started a new session in ${rec.cwd} on ${account.title}.` }, msg.turnId);
        rec.nativeSessionId = crypto.randomUUID();
        rec.sessionUsed = false;
        rec.sessionCostTotal = 0;
        delete rec.handoff;
      } else if (rec.sessionUsed && !rec.moved) {
        this.emit(st, { type: 'system.note', text: 'Resumed session' }, msg.turnId);
      }
      this.makeRoomForCli(st);
      this.startSession(st, account, forStart);
    }
    // Projects the session hasn't been told about: one it was put in while
    // live, or since it last ran. A fresh session got them as instructions.
    // Kept for the next message when this one is a command.
    const news = command ? undefined : this.projectNews(rec);
    if (news) text = `${news}\n\n${text}`;
    if (rec.moved) {
      // A CLI that moves folders itself: the live session got setCwd, or a
      // released one resumes in the new folder (startSession passes it).
      this.emit(st, { type: 'system.note', text: `Moved to ${rec.cwd}. The session carries on there.` }, msg.turnId);
      delete rec.moved;
    }
    // Kept for the next message when this one is a command, as the news is.
    if (rt.turn) rt.turn.dispatched = true;
    if (command) rt.session!.send({ ...input, text });
    else if (!this.compactFirst(st, msg, () => this.sendWithInstructionsNews(st, { ...input, text }))) this.sendWithInstructionsNews(st, { ...input, text });
    if (msg.reviewId && !rec.reviewDeliveries?.includes(msg.reviewId)) {
      (rec.reviewDeliveries ??= []).push(msg.reviewId);
      // A persisted transcript row is not proof of dispatch: both initial
      // events are written before session.send. Mark receipt only afterwards.
      try { this.store.save(rec); } catch (e) {
        this.log.error('could not save review delivery', {threadId: rec.id, reviewId: msg.reviewId, error: String(e)});
      }
      this.markDirty(st);
    }
  }

  // Keeps the number of live CLIs at cfg.maxLive by releasing the one idle
  // the longest. CLIs with a turn, an approval, queued messages or
  // background work are never picked; if every other one is busy the cap
  // is passed rather than stopping work.
  // A folder move, or a move from one Claude login to another (a pool
  // move or a pick by hand), copies the session's transcript to the new
  // folder and config dir so it resumes with everything, rather than a
  // short note. Anything else (another provider, a rebuilt record, a
  // transcript that can't be found) gets the handoff note, as does a
  // resume that then fails (onExited).
  carryTranscript(st: ThreadState, account: Account): boolean {
    const { rec } = st;
    const from = rec.handoff;
    // Claude only: it copies Claude's own transcript files. Codex moves
    // folders in the same session (movesFolders) and never gets here.
    if (rec.provider !== 'claude') return false;
    if (!from || from.rebuilt) return false;
    const sameLogin = from.fromAccountId === rec.accountId;
    if (sameLogin && from.fromCwd === rec.cwd) return false;
    const fromAccount = sameLogin ? account : this.accounts.get(from.fromAccountId);
    if (fromAccount?.provider !== 'claude') return false;
    if (!rec.sessionUsed || !rec.nativeSessionId) return false;
    const ok = this.copyTranscript(fromAccount.configDir, account.configDir, from.fromCwd, rec.cwd, rec.nativeSessionId);
    if (!ok) this.log.info('could not carry the transcript across; using a handoff note', { threadId: rec.id, from: from.fromAccountId, to: rec.accountId });
    return ok;
  }

  // Threads working now: a turn, a background job or a sub-agent going,
  // for keeping the Mac awake (keep-awake.ts).
  workingThreads(): number {
    let n = 0;
    for (const { rec, rt } of this.threads.values()) {
      if (rt.deleted) continue;
      if (rt.turn || rt.tasks.length || rt.wakeTimer || rec.subagents?.some((a) => a.status === 'running')) n++;
    }
    return n;
  }

  makeRoomForCli(starting: ThreadState): void {
    const live = [...this.threads.values()].filter((t) => t !== starting && runningSession(t.rt));
    if (live.length < this.cfg.maxLive) return;
    const idle = live
      .filter((t) => !t.rt.turn && t.rt.approvals.size === 0 && t.rec.queue.length === 0 && t.rt.tasks.length === 0 && !t.rt.wakeTimer && !t.rt.helperPending)
      .sort((a, b) => a.rt.activeAt - b.rt.activeAt);
    for (const t of idle.slice(0, live.length - this.cfg.maxLive + 1)) {
      this.log.info('releasing the longest-idle CLI to stay under the cap', { threadId: t.rec.id, maxLive: this.cfg.maxLive });
      this.releaseSession(t);
    }
  }

  // What a thread's CLI starts with, for startSession and for a CLI started
  // ahead of a new thread (runner/warm-start.ts), which only fits it while
  // these come out the same.
  sessionOptions(st: ThreadState, account: Account, looks: ClaudeLook[] | undefined, resume: boolean): { opts: StartSessionOptions; claude?: ClaudeVerdict; claudeSkipped?: string; heldGrants: boolean } {
    const { rec } = st;
    // Read now, not from the patch list's cache: a pull just before this
    // message may have brought hooks.
    // One the old sandbox experiment shut in, or in a folder it named.
    const retired = this.retiredSandbox(rec.cwd, rec);
    if (retired) throw new Error(retired);
    const claude = rec.provider === 'claude' ? this.patchTrust.checkClaude(rec.cwd, claudeOptions(rec), lookFor(looks, rec.cwd, claudeOptions(rec))) : undefined;
    const claudeSkipped = claude && !claude.trusted ? claude.hash : undefined;
    const heldGrants = Boolean(claude?.trusted && rec.permissionMode === 'full' && !this.patchTrust.checkClaude(rec.cwd, { grants: true }, lookFor(looks, rec.cwd, { grants: true })).trusted);
    const id = rec.id;
    const opts: StartSessionOptions = {
      threadId: rec.id,
      cwd: rec.cwd,
      account,
      model: rec.model,
      effort: rec.effort,
      permissionMode: rec.permissionMode,
      sessionId: rec.nativeSessionId!,
      resume,
      ...(resume && rec.resumeAt ? { resumeAt: rec.resumeAt } : {}),
      mediaDir: this.store.mediaDir(rec.id),
      blobsDir: this.store.blobsDir(rec.id),
      tmpDir: path.join(paths.run(this.cfg.home), 'tmp'),
      allowRules: rec.allowRules ?? [],
      env: threadEnv(rec.id, this.cfg.home, undefined, this.threadKey?.(rec.id)),
      ...this.briefFor(rec, resume),
      ...(claudeSkipped ? { untrustedProjectSettings: claudeSettingsWithoutCommands(rec.cwd) } : {}),
      // Read at each call, from the thread's folder then (the thread's own
      // record once there is one: a CLI started ahead of it was started
      // with a stand-in).
      runsAsCode: (file) => this.writeRunsAsCode(this.threads.get(id)?.rec ?? rec, file),
      ...(heldGrants ? { heldGrants: true } : {}),
      ...(this.coordinators?.session(rec.id) ? { coordinator: this.coordinators.session(rec.id) } : {}),
    };
    return { opts, claude, claudeSkipped, heldGrants };
  }

  // `looks`: deliver's look at the folder's Claude Code settings, taken with
  // no wait since; without one, it looks here.
  startSession(st: ThreadState, account: Account, looks?: ClaudeLook[]): void {
    const { rec, rt } = st;
    const held = this.coordinators?.dispatchRefusal(rec.id);
    if (held) throw new Error(held);
    const adapter = this.adapters[rec.provider];
    if (!adapter) throw new Error(`This runner can't run ${providerName(rec.provider)} threads.`);
    // Checked here, where every way a thread runs (a send, a carry-on, a
    // wake, a review) comes through, rather than at each of them.
    if (rec.copied) throw new Error(COPIED_REFUSAL);
    if (!rec.nativeSessionId) rec.nativeSessionId = crypto.randomUUID();
    const resume = Boolean(rec.sessionUsed);
    // A new generation, so whatever an older CLI still says goes nowhere,
    // and this CLI is the fresh one anything asked for: a release asked of
    // the last one doesn't carry over to it (thread 8a971407).
    this.cli(st, { kind: 'begin', resume });
    const gen = rt.generation;
    const sink: SessionSink = {
      output: (o) => {
        if (cliHears(rt, gen) === 'stale') return;
        rt.lastOutputAt = this.clock.now();
        try {
          this.onOutput(st, o, gen);
        } catch (e) {
          // Most likely the disk (full, permissions). The CLI carries on;
          // say so rather than let the error look like a CLI crash.
          this.log.error('could not handle CLI output', { threadId: rec.id, kind: o.kind, error: String(e) });
          this.notice('error', `Couldn't save part of "${rec.title}": ${(e as Error).message}`);
        }
      },
      requestApproval: (req) => this.requestApproval(st, gen, req),
      requestQuestion: (req) => this.requestQuestion(st, gen, req),
      exited: (err) => this.onExited(st, gen, err),
    };
    rt.cliVersion = undefined;
    rt.sessionProvider = rec.provider;
    rt.sessionAccountId = account.id;
    rt.startVersion = this.cliList()?.find((c) => c.provider === rec.provider)?.installedVersion;
    const { opts, claude, claudeSkipped, heldGrants } = this.sessionOptions(st, account, looks, resume);
    rt.claudeSkipped = claudeSkipped;
    rt.claudeHeldGrants = heldGrants;
    // A CLI started ahead of this thread with these same options takes the
    // place of a new one (runner/warm-start.ts).
    const session = this.takeSpare(st, opts, sink) ?? adapter.start(opts, sink);
    this.cli(st, { kind: 'spawned', session });
    // Every input to the CLI (a turn, a steer, a retry after the session
    // went) sends only the thread's own pictures (ownInput), whichever path
    // it took (Codex's review, 17 Nov: a retry re-sent a logged message's
    // pictures as they were).
    const send = session.send.bind(session);
    session.send = (input) => send(this.ownInput(st, input));
    if (claude && !claude.trusted) this.noteClaudeSkipped(st, claude);
    this.log.info('session started', { threadId: rec.id, resume, accountId: account.id, ...(rec.resumeAt ? { resumeAt: rec.resumeAt } : {}) });
    this.markDirty(st);
  }

  // `gen`: the CLI it came from (startSession's sink drops an older one's).
  onOutput(st: ThreadState, o: AdapterOutput, gen = st.rt.generation): void {
    const { rec, rt } = st;
    if (rt.turn?.dispatched && !rt.closing && !rt.turn.foreignOutput && ((o.kind === 'delta' && o.delta.text.length > 0) ||
      (o.kind === 'event' && ['assistant.text', 'reasoning', 'tool.call', 'tool.result', 'edit.diff', 'image'].includes(o.event.type)))) {
      rt.turn.modelOutput = true;
    }
    switch (o.kind) {
      case 'messageState': {
        const turn = rt.turn;
        if (o.state === 'started' && turn?.precompact) {
          turn.foreignOutput = turn.precompact.id !== o.id;
          break;
        }
        if (!turn?.inputs?.has(o.id)) break;
        turn.deliveryKnown = true;
        if (o.state === 'started') {
          (turn.startedMessages ??= new Set()).add(o.id);
          turn.foreignOutput = false;
          if (turn.recoveryInput === o.id) this.settleInterruptedMessages(st);
        } else if (o.state === 'cancelled') (turn.cancelledMessages ??= new Set()).add(o.id);
        break;
      }
      case 'event': {
        let ev = o.event;
        this.seeWake(st, ev);
        // The CLI's own line for a compaction this runner asked for ahead of
        // the turn says why (runner/cold-compact.ts).
        const pre = rt.turn?.precompact;
        if (ev.type === 'system.note' && ev.text === 'Compacted the conversation' && pre && pre.gen === gen && !pre.compacted && !rt.turn?.foreignOutput) {
          pre.compacted = true;
          ev = { ...ev, text: this.coldNote(pre) };
        }
        // A Codex child's items carry its prefix (<child>/<id>); Claude's
        // sub-agents never reach the thread's events.
        const own = !('itemId' in ev && ev.itemId?.includes('/'));
        // The agent's own words after an accepted end_turn (reply-phase.ts):
        // dropped before they can become the preview or a second message,
        // thinking too (Opus mused "I'd already wrapped up" under its
        // summary, 29 Oct 2026). Unless it's the reply (one reply), the real
        // message a narration block's summary stood for, in its place, or
        // the message bullets stood for.
        if (own && (ev.type === 'assistant.text' || ev.type === 'reasoning')) {
          const said = this.reply(st, ev.type === 'assistant.text' ? { kind: 'text', itemId: ev.itemId, text: ev.text, ...(ev.narration ? { narration: true } : {}) } : { kind: 'reasoning', itemId: ev.itemId });
          const out = said?.ok ? said.out : undefined;
          if (out?.tookCard) this.log.info('took the card from the reply', { threadId: rec.id, needs: out.tookCard.needs, asks: out.tookCard.asks?.length ?? 0 });
          if (out?.route === 'dropped') {
            rt.inProgress.delete(ev.itemId);
            this.log.info('dropped text after end_turn', { threadId: rec.id, chars: ev.text.length });
            break;
          }
          if (out?.route === 'summaryReplaced') {
            rt.inProgress.delete(ev.itemId);
            this.log.info('replaced a summary with the text after end_turn', { threadId: rec.id, chars: ev.text.length });
          }
          if (out?.route === 'owedKept') this.log.info('kept the message after end_turn its bullets stood for', { threadId: rec.id, chars: ev.text.length });
          if (out?.text && (out.route === 'reply' || out.route === 'summaryReplaced')) ev = { type: 'assistant.text', ...out.text };
        }
        if (ev.type === 'assistant.text' || ev.type === 'reasoning') {
          this.flushDeltas(st);
          rt.inProgress.delete(ev.itemId);
          rt.pendingDeltas.delete(ev.itemId);
        }
        // Once the turn has its summary, that is the reply: Codex's final
        // answer after it folds away in the app and isn't the preview.
        if (ev.type === 'assistant.text' && !rt.turn?.summarized && !rt.turn?.headline && ev.text.trim()) rec.preview = oneLine(ev.text, LIMITS.previewChars);
        // end_turn's call and its result move the reply phase (reply-phase.ts):
        // what the result took, refused or added, and what it writes.
        let ended: ReplyOut | undefined;
        if (rt.turn) {
          if (ev.type === 'tool.call' && own && ev.name === `mcp__${SERVER_NAME}__${END_TURN_TOOL}`) {
            this.reply(st, { kind: 'call', itemId: ev.itemId, input: ev.input, by: leastAuthority(rt.turn.endTurnBy, this.authorityNow(rec.id)) });
          }
          if (ev.type === 'tool.result' && ev.itemId === rt.turn.endTurnCall) {
            const res = this.reply(st, { kind: 'result', itemId: ev.itemId, ok: ev.ok, text: ev.text });
            ended = res?.ok ? res.out : undefined;
            if (ended?.headline) rec.preview = oneLine(ended.headline, LIMITS.previewChars);
          }
          // For hooks and the librarian only, never trust: these include
          // previews (an edit.diff before approval) and edits that were
          // then denied or failed. Trust comes from 'wrote' alone.
          if (ev.type === 'edit.diff') rt.turn.edited.add(ev.path);
          else if (ev.type === 'tool.call' && (ev.kind === 'edit' || ev.kind === 'write')) {
            const file = ev.input.file_path ?? ev.input.path ?? ev.input.notebook_path;
            if (typeof file === 'string') rt.turn.edited.add(file);
          } else if (ev.type === 'tool.call' && own && ev.kind === 'command') {
            const cmd = Array.isArray(ev.input.command) ? ev.input.command.join(' ') : ev.input.command;
            if (typeof cmd === 'string') {
              rt.turn.workedIn ??= new Set();
              for (const dir of commandFolders(cmd, rec.cwd, this.panelsRoot ?? os.homedir())) rt.turn.workedIn.add(dir);
            }
          }
        }
        this.emit(st, ev, rt.turn?.turnId);
        // The reply a reopened turn wrote, again under the card it was sent
        // back for: the apps take a turn's reply from after its last card.
        if (ev.type === 'tool.result' && ended?.restate !== undefined) {
          this.emit(st, { type: 'assistant.text', itemId: `${ev.itemId}.reply`, text: ended.restate, final: true }, rt.turn?.turnId);
        }
        // end_turn's summary, written as the turn's reply straight after
        // the call it came in (docs/protocol/needs-you.md, "The summary").
        if (ev.type === 'tool.result' && ended?.summary !== undefined) {
          rec.preview = oneLine(ended.summary, LIMITS.previewChars);
          this.emit(st, { type: 'assistant.text', itemId: `${ev.itemId}.summary`, text: ended.summary, summary: true, ...(this.cfg.bulletReplies ? {} : { givesWay: true as const }) }, rt.turn?.turnId);
        }
        break;
      }
      case 'delta':
        // Streamed text after an accepted end_turn, dropped like its frame
        // above, so it doesn't flash up and vanish.
        // That includes the message an owed reply keeps (owedReply): it
        // lands whole, as a sign-off line it drops would leave a row behind.
        if (o.delta.type === 'assistant.text.delta' || o.delta.type === 'reasoning.delta') this.seeWake(st, { type: 'assistant.text', itemId: o.delta.itemId });
        if (rt.turn && dropsStream(rt.turn) && (o.delta.type === 'assistant.text.delta' || o.delta.type === 'reasoning.delta') && !o.delta.itemId.includes('/')) break;
        this.addDelta(st, o.delta);
        break;
      case 'session':
        rec.nativeSessionId = o.nativeSessionId;
        rec.sessionUsed = true;
        // This session is there, so a later one that can't be found gets
        // its own fresh start.
        this.cli(st, { kind: 'init', gen });
        if (rec.status === 'starting') rec.status = rt.approvals.size ? 'waiting' : 'running';
        if (o.model) {
          rec.modelInUse = o.model;
          // A thread with no model of its own shows what the account's
          // default really is, which the settings alone can only guess.
          if (!rec.model) this.learnAccount(rec.accountId, { defaultModel: o.model });
        }
        this.markDirty(st);
        break;
      case 'effort':
        if (rec.effortInUse !== o.level) {
          rec.effortInUse = o.level;
          this.markDirty(st);
        }
        break;
      case 'context':
        rec.contextTokens = o.contextTokens;
        // When the cache was last used (runner/cold-compact.ts).
        rec.lastModelAt = this.isoNow();
        if (o.contextWindow !== undefined) rec.contextWindow = o.contextWindow;
        this.markDirty(st);
        break;
      case 'limits': {
        // The account's usage lives in D's UsageStore, which tells clients
        // through accounts.updated when it matters.
        const id = rt.sessionAccountId ?? rec.accountId;
        // A login that just ran dry: the reading its CLI took after the turn
        // is what it ran dry at, if less than the reading before it.
        const was = this.dryRoom.get(id);
        const dry = was !== undefined && (this.ranDry.get(id) ?? 0) > this.clock.now();
        if (dry) {
          const deciding = decidingWindows(o);
          const least = o.blocked ? 0 : deciding.length ? Math.min(...deciding.map((w) => w.remainingPercent)) : was;
          this.dryRoom.set(id, Math.min(was, least));
          // And it holds until the window at its limit resets, if it says.
          const ends = deciding.filter((w) => w.remainingPercent < MIN_ROOM_PERCENT && w.resetsAt).map((w) => Date.parse(w.resetsAt!)).filter(Number.isFinite);
          if (o.blocked && ends.length) this.ranDry.set(id, Math.max(this.ranDry.get(id) ?? 0, ...ends));
        }
        try {
          this.usage?.record(id, {
            windows: o.windows,
            // While it's dry the store keeps it blocked, whatever this
            // session's reading says (a 402 while Grok still reads room, or
            // another session's), so limit-recheck goes on reading it.
            ...(dry && o.blocked !== true ? { blocked: true, blockedUntil: this.ranDry.get(id) } : o.blocked !== undefined ? { blocked: o.blocked } : {}),
            ...(o.email ? { email: o.email } : {}),
            ...(o.plan ? { plan: o.plan } : {}),
            ...(o.resets ? { resets: o.resets } : {}),
            ...(o.aside ? { aside: o.aside } : {}),
          });
        } catch (e) {
          this.log.warn('could not record a usage reading', { accountId: id, error: String(e) });
        }
        break;
      }
      case 'cliVersion': {
        rt.cliVersion = o.version;
        // Started on the version an update wants: nothing to move.
        const said = this.cli(st, { kind: 'version', gen, atWanted: this.wantedVersion[rec.provider] === o.version });
        if (said.ok && said.out.reportStart) this.tellStarted(rec.provider, o.version, true);
        if (rec.cliVersion && rec.cliVersion !== o.version) {
          this.emit(st, { type: 'system.note', text: `${cliName(rec.provider)} ${o.version} from this turn on (was ${rec.cliVersion})` }, rt.turn?.turnId);
        }
        if (rec.cliVersion !== o.version) {
          rec.cliVersion = o.version;
          this.markDirty(st);
        }
        break;
      }
      case 'cliTurn':
        if (rt.turn) rt.turn.foreignOutput = true;
        // The CLI started a turn of its own. Give it a turn in the thread so
        // its output isn't loose, the status says running, and the app
        // flags it when it ends. A message the runner already sent waits
        // in the CLI's queue; its turn takes this output too.
        if (!rt.turn) this.openCliTurn(st);
        // It reads the results that woke it, in a turn of Mike's too.
        else this.pruneAwaited(st);
        rt.turn!.cliStarted = true;
        if (o.note) this.emit(st, { type: 'system.note', text: o.note }, rt.turn!.turnId);
        break;
      case 'endTurnNudge':
        // Sent back for a card under a reply already written: that reply
        // stands, so words from here are dropped like any after end_turn.
        this.reply(st, { kind: 'nudge', reopen: o.reopen === true, rewrite: o.rewrite === true });
        break;
      case 'tasks': {
        const endedTasks = rt.tasks.filter((t) => !o.tasks.some((n) => n.id === t.id));
        if (rt.turn) {
          for (const t of o.tasks) {
            if (t.kind === 'shell' && !rt.tasks.some((b) => b.id === t.id)) (rt.turn.shellsStarted ??= new Set()).add(t.id);
          }
        }
        // Claude starts a turn of its own to read a finished task's result;
        // Codex doesn't (wakesAfterTasks: false), so there it would only
        // look busy for WAKE_GRACE_MS for nothing.
        // The live CLI's provider: a thread switched to Codex during the
        // turn still has its Claude CLI here, which wakes.
        const wakes = this.adapters[rt.sessionProvider ?? rec.provider]?.wakesAfterTasks !== false;
        const ended = endedTasks.length > 0 && wakes;
        this.cli(st, { kind: 'tasks', gen, tasks: o.tasks });
        if (wakes) rt.finished.push(...endedTasks);
        // The CLI reports the list shrinking a moment before it starts the
        // turn that reads the result. A restart in between would lose that
        // turn, so the thread stays busy until it starts.
        if (ended && !rt.turn) this.startWakeGrace(st);
        else if (ended) rt.taskEndedInTurn = true;
        // The summary's background list changed: the app shows it, and a
        // pending restart waits on background work and re-checks on
        // thread.updated.
        this.markDirty(st);
        // A done card that lists a job as still running (loose-ends.ts),
        // and its starter's, which counts it as working while one runs.
        this.recheckLooseEnds(st);
        this.recheckStarter(st);
        // Background work keeps the CLI live; once it's done the idle
        // countdown starts again.
        if (o.tasks.length) {
          rt.idleTimer?.cancel();
          rt.idleTimer = undefined;
        } else if (!rt.turn) this.scheduleIdle(st);
        break;
      }
      case 'subagent':
        this.updateSubagent(st, o.update);
        this.coordinators?.subagent(rec.id, o.update);
        break;
      case 'wrote':
        // Patch files, and helpers a trusted patch may import, an edit the
        // CLI says it made: trusted as that edit left them, and only while
        // the file still has those bytes (patch-trust.ts). Only one made on
        // Full access, by the mode recorded with the call: in Ask and Auto
        // permission to edit a file isn't permission to run it, so what it
        // wrote waits for Mike in Patches (code-writes.ts, Gautam's scan
        // F1 and F4). Only inside the thread's own folder.
        if (o.mode !== 'full') break;
        this.trustAgentPatches(
          o.files.map((f) => ({ ...f, path: path.resolve(rec.cwd, f.path) })),
          rec.cwd,
          true,
        );
        break;
      case 'planProposed':
        // A newer plan replaces one still waiting (Codex can propose
        // again in plan mode); the old card just stops offering Go ahead.
        if (rec.openPlan && rec.openPlan !== o.itemId) this.emit(st, { type: 'plan.resolved', itemId: rec.openPlan, decision: 'revise' }, rt.turn?.turnId);
        rec.openPlan = o.itemId;
        this.emit(st, { type: 'plan.proposed', itemId: o.itemId, text: o.text }, rt.turn?.turnId);
        this.markDirty(st);
        break;
      case 'approvalQueue': {
        const pending = [...rt.approvals.values()].find((p) => p.kind === 'tool' && p.itemId === o.toolUseId);
        if (pending?.kind !== 'tool') break;
        pending.queued = new Set(o.calls.map((c) => c.itemId));
        this.emit(st, { type: 'approval.queued', approvalId: pending.approvalId, calls: o.calls }, rt.turn?.turnId);
        break;
      }
      case 'allowRules': {
        const rules = new Set(rec.allowRules ?? []);
        for (const r of o.rules) rules.add(r);
        rec.allowRules = [...rules];
        this.markDirty(st);
        break;
      }
      case 'result': {
        const r = o.result;
        const turn = rt.turn;
        if (!turn) break;
        // A background turn can end before delivery starts a compaction.
        // Older CLIs will not send a started frame to clear this marker.
        if (r.own) turn.foreignOutput = false;
        // The compaction sent ahead of the message (runner/cold-compact.ts).
        // A turn the CLI ran by itself meanwhile isn't it: keep waiting.
        if (turn.precompact && cliHears(rt, turn.precompact.gen) !== 'stale') {
          if (compactionResult(turn.precompact, r)) this.compactDone(st, r);
          break;
        }
        // A folded-in message may have no started frame of its own. The
        // result's explicit receipts still mean the CLI took that input.
        if (!r.own && turn.deliveryKnown) {
          for (const id of r.answered ?? (r.answers ? [r.answers] : [])) {
            if (r.unreceived?.includes(id)) continue;
            (turn.startedMessages ??= new Set()).add(id);
            if (turn.recoveryInput === id) this.settleInterruptedMessages(st);
          }
        }
        this.saveInterruptedMessages(st, r);
        if (!r.own && !turn.deliveryKnown && !r.unreceived?.includes(turn.recoveryInput ?? '') && ((!turn.interruptRequested && r.outcome === 'completed') || turn.modelOutput || (r.usage && Object.values(r.usage).some(n => typeof n === 'number' && n > 0)))) this.settleInterruptedMessages(st);
        // Which of this turn's messages the CLI's turn answered. The CLI
        // lists them in sending order, so everything up to the last one
        // named went with it. A CLI without lifecycle frames can only say
        // whether the turn was its own; if not, it answered the one at the
        // front.
        const named = r.answered ?? (r.answers !== undefined ? [r.answers] : r.own ? [] : turn.messages.slice(0, 1));
        const last = Math.max(-1, ...named.map((id) => turn.messages.indexOf(id)));
        if (last >= 0) turn.messages.splice(0, last + 1);
        if (turn.messages.length && (r.queuedTurns === 0 || r.errorKind === 'usageLimit')) {
          // The CLI has nothing left to run, so a message sent during the
          // turn went nowhere (an error ended its queue). Say so rather than
          // wait for an answer that won't come.
          const unsaved = turn.messages.some(id => !turn.startedMessages?.has(id) && !rec.interruptedMessages?.includes(turn.inputs?.get(id) ?? -1) && !turn.requeuedMessages?.has(id));
          turn.messages = [];
          if (!turn.interruptRequested || unsaved) this.emit(st, { type: 'system.note', text: 'A message sent during this turn was dropped by the CLI. Send it again.' }, turn.turnId);
        }
        // Still something to answer: a turn the CLI ran by itself while
        // this thread's message waited in its queue, or a message sent
        // during the turn that the CLI runs next. The thread's turn goes on
        // until the CLI has answered everything, unless Stop cancelled the
        // rest. A failure in between is shown where it happened.
        if (turn.messages.length && !turn.interruptRequested && r.errorKind !== 'usageLimit') {
          this.flushDeltas(st);
          rt.inProgress.clear();
          // Any end_turn taken by the CLI turn that just finished happened
          // before the queued message(s) ran, so clear it for the next turn.
          // Its shells go with it: one it had its say over isn't awaited,
          // and one it left without one still is (Gemini's review, round 3).
          if (turn.shellsStarted?.size) {
            if (r.outcome === 'completed' && !turnNeeds(turn) && this.wakes(st)) rt.awaitedShells = [...new Set([...(rt.awaitedShells ?? []), ...turn.shellsStarted])];
            turn.shellsStarted = undefined;
          }
          if (r.outcome === 'completed' && turnNeeds(turn)) delete rt.awaitedShells;
          this.reply(st, { kind: 'message' });
          if (r.outcome === 'failed' && r.error) this.emit(st, { type: 'error', message: r.error }, turn.turnId);
          break;
        }
        this.completeTurn(st, r);
        break;
      }
    }
  }

  startWakeGrace(st: ThreadState): void {
    const { rec, rt } = st;
    rt.wakeTimer?.cancel();
    const adapter = this.adapters[rt.sessionProvider ?? rec.provider];
    const graceMs = adapter?.wakeGraceMs ?? WAKE_GRACE_MS;
    rt.wakeTimer = this.clock.setTimeout(() => {
      rt.wakeTimer = undefined;
      const finished = rt.finished;
      rt.finished = [];
      this.markDirty(st);
      // No turn came to read the result: a done card held back for one
      // stands, and a helper's held turn ends its run.
      if (!rt.turn) {
        // Shells its last turn ended on without end_turn, waiting for them,
        // that have ended unread: nudged below rather than left with Mike.
        // First, so a helper's run or a review's finish isn't settled on the
        // turn that was still waiting: a queued or started nudge holds both
        // back until its own turn ends (Codex's and Gemini's review, 28 Nov).
        const going = new Set(rt.tasks.map((t) => t.id));
        const unread = (rt.awaitedShells ?? []).filter((id) => !going.has(id));
        this.pruneAwaited(st);
        if (unread.length && adapter?.nudgesUnreadShells) this.nudgeUnreadShells(st, unread.length, finished.filter((t) => unread.includes(t.id)));
        this.settlePendingFinish(st);
        this.settleHelperPending(st);
      }
      // Mike's turn is running: the CLI may read the result after it, so it
      // counts as ended in that turn, and the grace starts again at its end
      // (Codex's review, 22 Nov 2026).
      else rt.taskEndedInTurn = true;
      // A version move, a fresh CLI, or an idle countdown that fired during
      // wake grace was waiting for the grace to end.
      if ((rt.versionMove || rt.releaseWhenIdle || this.queueHeld(st) || !rt.idleTimer) && !rt.turn) this.scheduleIdle(st);
    }, graceMs);
  }

  // The CLI never woke for a shell its last turn ended waiting on (no
  // end_turn): that turn said it would carry on, and nothing else will
  // make it, so the runner does, rather than the thread landing in Mike's
  // inbox with no card (28 Nov 2026, c2df7d18: OpenCode stopped tb land at
  // 30 minutes and its wake came after the grace, which an update's
  // handover then took as nothing coming). STOPPED_WORK_WAKES in a row at
  // most, reset by anyone else writing to the thread.
  private nudgeUnreadShells(st: ThreadState, count: number, ended: BackgroundTask[]): void {
    const { rec, rt } = st;
    // Not behind a message Mike's interrupted turn left unread: kickQueue
    // wouldn't start it, and it would go after his next one, stale.
    if (this.stopping || rt.deleted || rt.turn || rec.queue.length || rec.interruptedMessages?.length || this.bucket(rec) !== 'inbox') return;
    if (this.coordinators?.dispatchRefusal(rec.id)) return;
    const wakes = rec.stoppedWorkWakes ?? 0;
    if (wakes >= STOPPED_WORK_WAKES) return;
    const what = ended.map((t) => t.description || t.type);
    try {
      rec.stoppedWorkWakes = wakes + 1;
      rt.nudgeTurnId = this.sendTo(st, unreadShellsMessage(count, what, wakes + 1 >= STOPPED_WORK_WAKES), [], { origin: 'runner', queue: true, wakeReason: 'Its background shell ended' });
      this.log.info('nudged a thread whose CLI never woke for its shell', { threadId: rec.id, what });
    } catch (e) {
      this.log.error('could not nudge a thread whose CLI never woke for its shell', { threadId: rec.id, error: String(e) });
    }
  }

  openCliTurn(st: ThreadState): void {
    const { rec, rt } = st;
    rt.wakeTimer?.cancel();
    rt.wakeTimer = undefined;
    this.pruneAwaited(st);
    // The CLI woke after all: a nudge still queued for that wake would be
    // a second turn after it, and hold back its end_turn's archive or snooze
    // (Codex's and Gemini's review, 28 Nov 2026).
    if (rt.nudgeTurnId) {
      const at = rec.queue.findIndex((m) => m.turnId === rt.nudgeTurnId);
      if (at >= 0) {
        rec.queue.splice(at, 1);
        if (rec.stoppedWorkWakes) rec.stoppedWorkWakes--;
      }
      delete rt.nudgeTurnId;
    }
    // What finished and woke the CLI, so the transcript can mark the wait
    // between this turn and the last one with what ended it (Mike, 3 Nov:
    // "still waiting" and "it's back" read as one breath).
    const wokeBy = rt.finished.map((t) => ({ kind: t.kind, description: t.description }));
    rt.finished = [];
    // Working again, so not finished for threads waiting on it.
    delete rec.finished;
    // Nor stopped at a limit any more: a move later, or the wait's timer,
    // mustn't carry on a turn this one has moved past (startTurn's same).
    delete rec.limitHitTurn;
    if (rec.waitingForRoom) {
      delete rec.waitingForRoom;
      this.armRoomTimer();
    }
    const turnId = crypto.randomUUID();
    this.emit(st, wokeBy.length ? { type: 'turn.started', turnId, wokeBy } : { type: 'turn.started', turnId }, turnId);
    this.noteHelperStart(st, turnId);
    rt.idleTimer?.cancel();
    rt.idleTimer = undefined;
    rt.turn = { turnId, startedAt: this.clock.now(), interruptRequested: false, auto: true, messages: [], edited: new Set(), access: rec.permissionMode };
    rt.activeAt = this.clock.now();
    rec.turnId = turnId;
    rec.status = rt.approvals.size ? 'waiting' : 'running';
    rec.lastActivityAt = this.isoNow();
    this.markDirty(st);
  }

  completeTurn(st: ThreadState, r: TurnResult): void {
    const { rec, rt } = st;
    const turn = rt.turn;
    if (!turn) return;
    this.settleInstructionsNews(st, r.outcome === 'completed' && !turn.interruptRequested);
    this.flushDeltas(st);
    rt.inProgress.clear();
    // Not a subagent's card: it's waiting on Mike, not on this turn, and the
    // subagent carries on after it. Expiring them here killed two subagents
    // when their parent's next turn ended, while Mike was away, and the CLI
    // told the parent he had stopped them (7 Nov 2026, thread 7a98a6fd).
    this.expireApprovals(st, 'The turn ended.', { mainOnly: true });
    // A login whose turns bring no usage reading (Gemini) is read soon after:
    // the one the turn ran on, which a move mid-turn has taken off rec. Not
    // after a command the runner answered itself (/status), which ran nothing.
    if (!turn.local) this.limitRecheck?.afterTurn(rt.sessionAccountId ?? rec.accountId);
    let turnCost: number | undefined;
    if (r.totalCostUsd !== undefined) {
      // total_cost_usd is a running total for the native session (resume
      // carries it on); a drop means the CLI started counting again.
      const prev = rec.sessionCostTotal ?? 0;
      turnCost = r.totalCostUsd >= prev ? r.totalCostUsd - prev : r.totalCostUsd;
      rec.sessionCostTotal = r.totalCostUsd;
      rec.costUsd = round6((rec.costUsd ?? 0) + turnCost);
      turnCost = round6(turnCost);
    }
    const outcome = turn.interruptRequested && r.outcome !== 'completed' ? 'interrupted' : r.outcome;
    // The CLI resumed at the cut an edit asked for and has written a turn
    // after it, which is the conversation's end from now on. Kept until
    // then, so a CLI that died first cuts again on the next start.
    // Not a command the runner answered: no CLI resumed for it.
    if (rec.resumeAt && rt.resumed && !turn.local) delete rec.resumeAt;
    if (outcome === 'failed' && r.error) this.emit(st, { type: 'error', message: r.error }, turn.turnId);
    const body: EventBody = {
      type: 'turn.completed',
      turnId: turn.turnId,
      outcome,
      durationMs: Math.max(0, this.clock.now() - turn.startedAt),
    };
    if (turnCost !== undefined) body.costUsd = turnCost;
    if (r.usage) body.usage = r.usage;
    if (outcome === 'failed' && r.error) body.error = r.error;
    // Why it failed (a limit, a full context, the login), so the app can
    // offer the fix without reading the message.
    if (outcome === 'failed' && r.errorKind) body.errorKind = r.errorKind;
    // What it needs from Mike: its end_turn call, else its closing "What I
    // need from you". Only a turn it finished; a stopped one says nothing.
    const prevNext =
      rec.needs?.needs === 'nothing' && rec.needs.seq === rec.lastTurnCompletedSeq && rec.needs.next?.length
        ? { next: rec.needs.next, ...(rec.needs.nextPick ? { nextPick: rec.needs.nextPick } : {}), ...(rec.needs.nextSuggested !== undefined ? { nextSuggested: rec.needs.nextSuggested } : {}) }
        : undefined;
    const said = outcome === 'completed' ? turnNeeds(turn) : undefined;
    // Ended without a say (no end_turn, nothing asked in its text) while a
    // shell it started still runs: it's waiting on that, not on Mike. A wake
    // turn that reads one result and goes on waiting keeps the rest (Codex
    // and Gemini's review, 28 Nov 2026). A runner-answered command changes
    // nothing.
    if (!turn.local) {
      // Earlier ones are kept: still running, or ended with the result
      // still to be read (pruneAwaited takes them off when it is).
      const awaited = outcome === 'completed' && !said && this.wakes(st) ? new Set([...(rt.awaitedShells ?? []), ...(turn.shellsStarted ?? [])]) : new Set<string>();
      if (awaited.size) rt.awaitedShells = [...awaited];
      else delete rt.awaitedShells;
    }
    const explicitNext = Boolean(turn.endTurn && typeof turn.endTurn === 'object' && 'next' in turn.endTurn && (turn.endTurn as Record<string, unknown>).next !== undefined);
    if (outcome === 'completed' && !turn.local && !turn.byMike && said?.needs === 'nothing' && !said.next?.length && !explicitNext && prevNext) {
      said.next = prevNext.next;
      if (prevNext.nextPick) said.nextPick = prevNext.nextPick;
      if (prevNext.nextSuggested !== undefined) said.nextSuggested = prevNext.nextSuggested;
    }
    // A refused first end_turn can still supply the completion's card.
    // Keep an already open card visible and leave the rejected asks for
    // the turn that reads the background job's result.
    const deferNewAsks = said?.afterJobs && said.asks && this.coordinators?.hasOmittedAsks(rec.id, said.asks);
    if (said) {
      body.needs = deferNewAsks ? 'nothing' : said.needs;
      if (said.asks && !deferNewAsks) body.asks = said.asks;
      if (said.next) body.next = said.next;
      if (said.nextPick) body.nextPick = said.nextPick;
      if (said.nextSuggested !== undefined) body.nextSuggested = said.nextSuggested;
      body.needsFrom = said.from;
    }
    // Here rather than only in end_turn's handler: a refused end_turn
    // leaves the asks in the reply's text, and that thread never heard
    // Mike had restarted (29 Oct 2026).
    if (!deferNewAsks && said?.needs === 'you' && asksForAppRestart(said.asks)) this.appRestartAsked?.(rec.id);
    // Review by another lab (runner/lab-review.ts): a review thread's
    // verdict is kept for the thread it reviewed (deliverReview), and the
    // turn that answers a round's findings takes the ledger to its card.
    if (outcome === 'completed' && !turn.local) {
      // The latest turn's say: one that ended without a verdict (a later
      // report on tests it left running) doesn't stand on an earlier pass.
      // One with no end_turn at all (Grok's, unseen) gave none either.
      if (rec.reviewOf && (turn.endTurn || this.awaitedReview(rec))) {
        const verdict = turn.endTurn ? parseVerdict(turn.endTurn) : undefined;
        if (verdict) rec.reviewVerdict = verdict;
        else delete rec.reviewVerdict;
        this.markDirty(st);
      }
      const ledger = rec.labReview;
      if (ledger && ledger.delivered === ledger.rounds && ledger.answered !== ledger.rounds) {
        applyAnswers(ledger, turn.endTurn);
        // Fixes in the last round there is: no review will look at them.
        if (ledger.rounds >= LAB_REVIEW_ROUNDS && fixedSinceLastRound(ledger)) ledger.unchecked = true;
        body.review = ledgerCard(ledger);
        this.markDirty(st);
      }
    }
    const ev = this.emit(st, body, turn.turnId);
    // Any completed turn replaces the last one's card; one that said
    // neither leaves no card, and counts as before.
    if (outcome === 'completed') {
      if (body.needs !== undefined) {
        rec.needs = {
          seq: ev.seq,
          needs: body.needs,
          ...(body.asks ? openAskState(body.asks) : {}),
          ...(body.carriedAsks ? { carriedFrom: body.carriedAsks.seq, ticked: body.carriedAsks.ticked } : {}),
          ...(body.next?.length ? { next: body.next } : {}),
          ...(body.nextPick ? { nextPick: body.nextPick } : {}),
          ...(body.nextSuggested !== undefined ? { nextSuggested: body.nextSuggested } : {}),
          ...(said && !deferNewAsks ? this.afterJobs(st, said) : {}),
        };
      }
      // Said nothing at all (no end_turn): asks held for a job and never
      // seen stay as the card, rather than going with a "Landed".
      else if (rec.needs?.afterJobs) rec.needs = { ...rec.needs, seq: ev.seq };
      else delete rec.needs;
      // How it came out replaces why it was started, on the row of a thread
      // Mike didn't start. His own threads have no byline, so it's dropped.
      const byline = bylineFromTool(turn.endTurn);
      if (byline && rec.startedBy) rec.startedBy.why = byline;
    }
    // A pool thread whose login ran dry moves and carries on (afterTurn).
    const limitHit = outcome === 'failed' && r.errorKind === 'usageLimit' ? turn.turnId : undefined;
    // One that couldn't reach the API carries on once it's back (afterTurn).
    const netLost = outcome === 'failed' && r.errorKind === 'network' ? turn.turnId : undefined;
    // A refused login counts as signed out, and a pool thread moves off it
    // (afterTurn); a turn that went through says it's signed in.
    const signedOut = outcome === 'failed' && r.errorKind === 'auth' ? turn.turnId : undefined;
    // An org that turned Claude Code off holds the login out a day (sign-in-state.ts).
    if (signedOut) this.signIn?.noteRefused(rec.accountId, ACCESS_OFF_TEXT.test(r.error ?? '') ? ACCESS_OFF_HOLD_MS : undefined);
    else if (outcome === 'completed') this.signIn?.noteWorked(rec.accountId);
    // A turn the CLI opened by itself during a wait (a background job
    // ended) that got through ends the wait: the agent has carried on.
    if (!netLost && rec.waitingForNetwork) delete rec.waitingForNetwork;
    // The agent asked for its own thread to be archived (end_turn's
    // archive, which Mike asked it for). It can't archive itself mid-turn,
    // as that stops the CLI, so it happens here, once the turn is over.
    // Fresh messages still need an answer; automatic inputs already waiting
    // when a later ordinary message arrived may wait through its park.
    // Nor while a card is still waiting (a subagent's, which outlives the
    // turn): archiving or snoozing would hide it and stop the work behind it.
    // More likely now the runner's own threads run on the install's mode
    // (own-threads.ts; Codex review, 9 Nov 2026).
    // A turn the CLI opened by itself counts too: the one after a background
    // job ends is where an agent that waited on it says it's done. Skipping
    // those dropped its archive without a word, so a thread that said "I'm
    // archiving this thread" stayed in Mike's inbox (23 Nov 2026, df5c7153).
    // Nor while a message of Mike's that an interrupt left unread is saved
    // for later: a job ending opens a turn that never shows it, so it could
    // put the thread away past "keep this open" (Codex review).
    const away = outcome === 'completed' && said?.needs === 'nothing' && rec.queue.every(q => isAutomaticInput(q) && q.beforeMessage) && !rt.approvals.size && !rec.interruptedMessages?.length;
    // Active project coordinators stay awake (end_turn refuses archive, snooze
    // and waitFor too, but a refused first call can still sit on turn.endTurn).
    const activeCoordinator = this.activeCoordinator(rec.id);
    const archive = !activeCoordinator && away && archiveFromTool(turn.endTurn);
    // Hibernating likewise (end_turn's snooze). Archive wins if it asked for both.
    const snooze = !activeCoordinator && away && !archive ? snoozeFromTool(turn.endTurn) : undefined;
    // Waiting on other threads (end_turn's waitFor), with snooze as the
    // latest it wakes.
    const waitFor = !activeCoordinator && away && !archive ? waitForFromTool(turn.endTurn) : undefined;
    // Waiting on GitHub workflow runs (end_turn's waitForRuns), likewise.
    const forRuns = !activeCoordinator && away && !archive && !waitFor ? runsFromTool(turn.endTurn) : undefined;
    // Done for now but waiting to hear the app restarted onto its change
    // (wait_for_app_restart): it hibernates until that message wakes it,
    // a day at most as the request lapses then, rather than sitting in
    // Mike's inbox as done when it isn't (18 Nov 2026, 41324bd6).
    const forApp = !activeCoordinator && away && !archive && !snooze && !waitFor && !forRuns && !!this.awaitingAppRestart?.(rec.id);
    // Done, with nothing left running: any thread waiting on this one hears.
    // Not if it put itself away to wait too, as it hasn't finished. An auto
    // turn counts (the one after a sub-agent or background job ends is
    // often where the report is), so this reads end_turn itself, not `away`.
    // Judged before endTurn, which starts any queued message.
    // A review the reviewed thread is waiting on (runner/lab-review.ts) is
    // finished however its turn completed: with no end_turn the runner saw,
    // or a question for Mike. Its reply goes back as the findings and the
    // review is put away (deliverReview), as a review is never Mike's to
    // answer. Grok's end_turn went unseen and the thread it reviewed, and
    // the one waiting on that, slept for hours (16 Nov 2026, 53cd067b).
    // Not one waiting on threads of its own, or hibernating for something,
    // as it asked: it finishes when its next turn does. One that failed is
    // released after endTurn (releaseFailedReview).
    const reviewEnded = !turn.local && outcome === 'completed' && this.awaitedReview(rec) &&
      !waitForFromTool(turn.endTurn) && !snoozeFromTool(turn.endTurn) && !runsFromTool(turn.endTurn);
    const done = (reviewEnded || (outcome === 'completed' && said?.needs === 'nothing' && !archive && !forApp &&
      (activeCoordinator || (!snoozeFromTool(turn.endTurn) && !waitForFromTool(turn.endTurn) && !runsFromTool(turn.endTurn))))) && !rec.queue.length &&
      !rec.subagents?.some((a) => a.status === 'running') && !rt.tasks.length && !rt.approvals.size;
    // A job that ended mid-turn or just before: the CLI may open a turn to
    // read its result, so the finish waits for the wake grace to pass with
    // none (settlePendingFinish). Mid-turn it mostly reads it in this turn
    // and opens none: finishing only on a later turn left 17 done cards
    // unfinished, unguessed and their waiters asleep (19-22 Nov 2026).
    const finished = done && !rt.taskEndedInTurn && !rt.finished.length;
    this.dropPendingFinish(st);
    const holdQueue = Boolean(rec.queue.length && (archive || snooze || waitFor || forRuns || forApp));
    const loginBefore = rec.accountId;
    this.endTurn(st, ev.seq, outcome === 'failed' ? 'error' : 'idle', outcome, limitHit, netLost, holdQueue, signedOut);
    if (rec.coordinatorHelperFor) {
      if (rt.turn) this.coordinators?.noteHelperTurn(rec.id, rt.turn.turnId);
      else {
        // A queued update can be waiting on the folder check. Keep this
        // result until the queued input starts or is withheld.
        rt.helperPending = { outcome, text: turn.lastText || r.error || '', turnId: turn.turnId };
        this.settleHelperPending(st);
      }
      return;
    }
    // A pool thread refused as signed out that endTurn moved to another
    // login (afterTurn, onSignedOut) carries on there, like a limit or a
    // lost network. One that stayed put (pinned, a Codex login, nowhere to
    // go) waits on Mike's sign-in, so it counts as failed.
    const movedOff = !!signedOut && rec.accountId !== loginBefore;
    // The done card's loose ends, unless it's going
    // away now; and the card of the thread that started this one, which
    // lists this one while it's working.
    if (outcome === 'completed' && said?.needs === 'nothing' && !archive) void this.checkLooseEnds(st);
    this.recheckStarter(st);
    // Reports its starter is holding may go now; at once if this one failed
    // or was stopped (one moving login or waiting for the network carries
    // on by itself). runner/nested.ts.
    if (rec.startedBy?.kind === 'thread' && !rec.detached) this.settleHeldSoon(rec.startedBy.threadId, outcome !== 'completed' && !limitHit && !netLost && !movedOff);
    // A code change gets another lab's review before it counts as done
    // (runner/lab-review.ts, unless Settings turns it off): the thread waits on
    // the review, so anything waiting on it hears once it's been fixed.
    // One the last runner owed (a handover) is settled by the next turn to
    // complete: a finish gives this turn's change if it made one worth it,
    // else that earlier one; a turn that needs Mike, or waits, drops it,
    // as it would have stopped that review from starting too. Not a slash
    // command the runner answered itself (/model): that's no agent turn.
    // An earlier card's held finish this turn replaces gave back any review
    // it carried (dropPendingFinish, above), so it's settled here.
    const owed = outcome === 'completed' && !turn.local ? rec.labReviewOwed : undefined;
    if (owed) {
      delete rec.labReviewOwed;
      this.markDirty(st);
    }
    if (done && !finished && !turn.local) rt.finishPending = { seq: ev.seq, turnId: turn.turnId, ...(turn.lastText !== undefined ? { lastText: turn.lastText } : {}), next: Boolean(said?.next?.length), ...(owed ? { owed } : {}) };
    let review = finished && !rt.turn ? this.startLabReview(st, turn.turnId, turn.lastText) : undefined;
    if (!review && owed && finished && !rt.turn && !rec.labReviewOwed) review = this.startLabReview(st, owed.turnId, owed.reply, owed.seq);
    if (review) this.waitOnReview(st, review);
    // Owed to the next runner (a handover): finished once it's reviewed.
    else if (finished && !rec.labReviewOwed) this.markFinished(st, turn.lastText);
    // A failed review that won't carry on by itself on another login (a
    // pool move) or once the network is back: a pinned login at its limit
    // would sleep until it resets, and a refused one until Mike signs in.
    if (outcome === 'failed' && !turn.local && !netLost && rec.accountId === loginBefore) this.releaseFailedReview(st, r.error, turn.lastText);
    if (outcome === 'completed' && this.waitedOnFor(rec.id).length) this.tellActivity({ kind: 'waited-on', threadId: rec.id });
    // A schedule's message brought this thread out of the archive (sendTo).
    // A run that finishes with nothing for Mike puts it back, so a watcher he
    // archived doesn't land in his inbox each time it looks and finds
    // nothing (7 Nov 2026, a twice-daily Pebble check). One that needs him,
    // fails or is stopped stays out. One still going (a background job, a
    // sub-agent, a lab review, owed or started, a wait, a pool move or a lost
    // network) keeps the mark, so the turn that really ends the run decides;
    // a queued message decides at the end of its own turn.
    // A run that ends for good drops the mark even with another message
    // queued (endTurn may have started it already), so a later run that
    // finds nothing can't archive a question this one left for Mike.
    if (rec.unarchivedBySchedule) {
      const by = rec.unarchivedBySchedule.by;
      const goingOn = !!limitHit || !!netLost || movedOff || (outcome === 'completed' && said?.needs === 'nothing');
      if (!goingOn || rec.archivedAt || activeCoordinator) this.park(st, { kind: 'scheduleRunEnded' });
      else if (!rec.queue.length && !rt.turn && finished && !review && !rec.labReviewOwed && !this.stopping) {
        this.park(st, { kind: 'scheduleRunEnded' });
        this.emit(st, { type: 'system.note', text: 'Back in the archive: the scheduled run ended with nothing for you.' });
        this.update({ threadId: rec.id, archived: true, archivedBy: by ?? 'threadbear', noted: true });
      }
      this.markDirty(st);
    }
    // Finished for good, with nothing for Mike: a helper thread with nothing
    // left open archives itself (runner/quiet-inbox.ts). Not one a schedule
    // had out of the archive: the lines above have dealt with it.
    let settling: Promise<void> | undefined;
    if (finished && !review && !rec.labReviewOwed && !rt.turn && !rec.archivedAt && !this.stopping) {
      settling = this.settleQuietly(st, Boolean(said?.next?.length));
      void settling;
      // And a guess at whether Mike needed to see it, only written down
      // (runner/inbox-guess.ts, experiment inboxGuess).
      void this.guessInbox(st, turn.lastText ?? '', Boolean(said?.next?.length));
    }
    if (archive && !rt.turn && !rec.archivedAt && !this.stopping) {
      this.emit(st, { type: 'system.note', text: 'Archived, as the agent was asked to once it had finished.' });
      this.update({ threadId: rec.id, archived: true, archivedBy: 'agent', noted: true });
    }
    if (waitFor && !rt.turn && !rec.archivedAt && !this.stopping) this.waitOn(st, waitFor, snooze, turn.endTurnBy);
    else if (forRuns && !rt.turn && !rec.archivedAt && !this.stopping) this.waitRuns(st, forRuns, snooze);
    else if (snooze && !rt.turn && !rec.archivedAt && !this.stopping) this.snoozeAfterTurn(st, snooze, turn.endTurnBy, turn.wakeCheck);
    else if (forApp && !rt.turn && !rec.archivedAt && !this.stopping) {
      this.emit(st, { type: 'system.note', text: 'Hibernating until the Threadbear app restarts onto the new build, a day at most.' });
      this.update({ threadId: rec.id, snoozedUntil: new Date(this.clock.now() + APP_RESTART_MAX_AGE_MS).toISOString(), noted: true });
      // After update, which clears it with the rest of a wait: the app shows
      // it under Running, as its work isn't over until Mike's running it.
      this.park(st, { kind: 'forApp' });
      this.markDirty(st);
    }
    // The check a wake gave it (runner/hibernation.ts, wakeToCheck) is over
    // and it hasn't gone back to sleep: what it waited for has happened, or
    // its agent wants Mike. The wake wasn't marked unread, so this is. The
    // same when a turn ends with the check still owed and not waiting in
    // the queue (it failed, was stopped as it finished, or the CLI ran a
    // turn of its own instead): awake, and nothing else says so. Not while
    // the runner is about to carry the turn on (a full login, a lost
    // network), which may yet end asleep.
    const checkOwed = rec.wakeNews?.check;
    // Nor after a turn Mike's own message was in (he's there, and it would
    // only mark what he has just read: Gemini's review, 23 Nov 2026).
    if ((turn.wakeCheck || (checkOwed !== undefined && !rec.queue.some((q) => q.turnId === checkOwed))) && !turn.byMike && !limitHit && !netLost && !movedOff) {
      const mark = (later: boolean) => {
        if (rt.deleted || rec.archivedAt || this.bucket(rec) !== 'inbox') return;
        // Since the helper's check: a new turn, Mike has looked, or it's
        // to archive once the threads it started are done.
        if (later && (rt.turn || rec.lastSeenSeq >= rec.lastTurnCompletedSeq || rt.quietOnceChildrenDone !== undefined)) return;
        rec.forceUnread = true;
        this.markDirty(st);
      };
      // A helper thread that may archive itself now (runner/quiet-inbox.ts)
      // is marked only if it stays: its starter has its result, and a mark
      // meanwhile could reach Mike's phone (Codex's review, 23 Nov 2026).
      // One whose finish is held for a turn the CLI may open (finishPending)
      // settles, and may archive, later: left to a helper's own rules.
      const helper = (settling || rt.finishPending) && this.helperNobodyTouched(st);
      if (helper && settling) void settling.then(() => mark(true), () => mark(true));
      else if (!helper) mark(false);
    }
    // An invalid wait may leave the thread awake; do not strand its queue.
    if (holdQueue && !rt.turn && this.bucket(rec) === 'inbox') this.afterTurn(st);
    // No grace running (no live CLI to open a turn): nothing is coming.
    // One running since a job ended before this turn starts again, so the
    // CLI has the whole grace after the turn to open its own.
    if (rt.finishPending && !rt.wakeTimer) this.settlePendingFinish(st);
    else if (rt.finishPending) this.startWakeGrace(st);
    // Likewise for an awaited shell that ended before this turn and is
    // still to be read (Gemini's review, round 3).
    else if (rt.wakeTimer && !rt.turn && rt.awaitedShells?.some((id) => !rt.tasks.some((t) => t.id === id))) this.startWakeGrace(st);
  }

  // A held finish that won't happen: a review the last runner owed, which
  // completeTurn took for it, is owed again, for the turn that settles it
  // (completeTurn), as it would have been with no finish held.
  dropPendingFinish(st: ThreadState): void {
    const { rec, rt } = st;
    const owed = rt.finishPending?.owed;
    rt.finishPending = undefined;
    if (owed && !rec.labReviewOwed && !rt.deleted) {
      rec.labReviewOwed = owed;
      this.markDirty(st);
    }
  }

  // A finish completeTurn held back for a turn the CLI might open to read
  // a background result (finishPending): none came, so the done card
  // stands and the thread finishes, as completeTurn would have: a lab
  // review or markFinished (threads waiting on it hear), a schedule's run
  // back in the archive, the quiet-inbox helper and the inbox guess. A
  // runner stopping only finishes it, owing any review to the next one
  // (startLabReview), which also makes the guess (catchUpInboxGuess).
  settlePendingFinish(st: ThreadState): void {
    const { rec, rt } = st;
    const p = rt.finishPending;
    if (!p) return;
    // Going back to an earlier message (its CLI's exit lands here) undoes
    // the card rather than finishing on it (Codex's review, 22 Nov 2026).
    if (rt.turn || rt.deleted || rt.editing || rec.lastTurnCompletedSeq !== p.seq || rec.finished ||
      rec.queue.length || rt.tasks.length || rt.approvals.size || rec.subagents?.some((a) => a.status === 'running')) {
      this.dropPendingFinish(st);
      return;
    }
    rt.finishPending = undefined;
    // Put to sleep in the grace (Mike snoozing it lets the CLI go, and its
    // exit lands here): finished, but a review would hibernate it on its
    // own terms over his (Codex's review, 22 Nov 2026), so none starts.
    const asleep = this.bucket(rec) === 'snoozed';
    // A review the last runner owed waits for its next turn, as an owed one
    // found asleep does (startOwedReview), unfinished meanwhile.
    if (asleep && p.owed && !rec.labReviewOwed) {
      rec.labReviewOwed = p.owed;
      this.markDirty(st);
    }
    let review = asleep ? undefined : this.startLabReview(st, p.turnId, p.lastText);
    if (!review && !asleep && p.owed && !rec.labReviewOwed) review = this.startLabReview(st, p.owed.turnId, p.owed.reply, p.owed.seq);
    if (review) this.waitOnReview(st, review);
    else if (!rec.labReviewOwed) this.markFinished(st, p.lastText);
    if (review || rec.labReviewOwed || rec.archivedAt || asleep || this.stopping || rt.holds?.has('handover')) return;
    if (rec.unarchivedBySchedule) {
      const by = rec.unarchivedBySchedule.by;
      this.park(st, { kind: 'scheduleRunEnded' });
      if (!this.activeCoordinator(rec.id)) {
        this.emit(st, { type: 'system.note', text: 'Back in the archive: the scheduled run ended with nothing for you.' });
        this.update({ threadId: rec.id, archived: true, archivedBy: by ?? 'threadbear', noted: true });
      }
      this.markDirty(st);
      return;
    }
    void this.settleQuietly(st, p.next);
    void this.guessInbox(st, p.lastText ?? '', p.next);
  }

  // end_turn's snooze, once the turn is over: a time as update_thread
  // reads it, or else words, read as Hibernate in words reads Mike's.
  // `askedBy`: its access when its agent called end_turn (turn.endTurnBy),
  // for the ceiling of a snooze in words (runner/ceiling.ts).
  // `afterCheck`: the turn was a wake's check (wakeCheck).
  snoozeAfterTurn(st: ThreadState, when: string, askedBy?: { mode: PermissionMode }, afterCheck = false): void {
    const { rec } = st;
    let until: string | undefined;
    if (when.toLowerCase() === 'restart' || when.toLowerCase() === 'release') until = when.toLowerCase();
    else {
      try {
        until = parseWhen(when, this.clock.now());
      } catch {
        until = undefined;
      }
    }
    if (until === undefined) {
      // A failure puts the thread back in the inbox (hibernateWhen), so
      // Mike sees it, with a note saying why.
      this.hibernateWhen({ threadId: rec.id, said: when, by: 'agent', ...(askedBy ? { askedBy } : {}) }).catch((e: unknown) => {
        if (st.rt.deleted) return;
        this.emit(st, { type: 'system.note', text: `Not hibernated, as the agent was asked to: ${e instanceof Error ? e.message : String(e)}` });
        this.notHibernatedAfterCheck(st, afterCheck);
      });
      return;
    }
    if (until !== 'restart' && until !== 'release' && Date.parse(until) <= this.clock.now()) {
      this.emit(st, { type: 'system.note', text: `Not hibernated: the agent asked to wake at ${when}, which has passed.` });
      this.notHibernatedAfterCheck(st, afterCheck);
      return;
    }
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const text = until === 'restart' ? 'Hibernating until the runner next starts, as the agent was asked to.'
      : until === 'release' ? 'Hibernating until the runner starts on a new release, as the agent was asked to.' : `Hibernating until ${localWhen(Date.parse(until), timeZone)}, as the agent was asked to.`;
    this.emit(st, { type: 'system.note', text });
    this.update({ threadId: rec.id, snoozedUntil: until, noted: true, byAgent: true });
  }

  // A snooze its agent asked for that didn't take, after a check a wake
  // gave it (runner/hibernation.ts, wakeToCheck) or while its checks at a
  // latest time are counted: that wake wasn't marked unread and the turn
  // said it needs nothing, so without this the thread would sit in the
  // inbox with nothing to say Mike should look (Gemini's second review,
  // 22 Nov 2026).
  notHibernatedAfterCheck(st: ThreadState, afterCheck = false): void {
    const { rec } = st;
    if ((!afterCheck && !rec.lateChecks) || this.bucket(rec) !== 'inbox') return;
    rec.forceUnread = true;
    this.markDirty(st);
  }

  endTurn(st: ThreadState, completedSeq: number, status: ThreadStatus, outcome?: TurnOutcome, limitHit?: string, netLost?: string, holdQueue = false, signedOut?: string): void {
    const { rec, rt } = st;
    const finished = rt.turn;
    rt.turn?.interruptTimer?.cancel();
    rt.turn = undefined;
    // The turn may have added a patch file or a convex/ folder.
    this.forgetFolders();
    // The folder's turn.end hooks, after a turn the agent finished itself
    // (not one the runner opened for a background task's approval).
    if (outcome === 'completed' && finished && !finished.auto && !this.stopping) void this.runHooks(st, finished);
    // The turn may have changed what live state reads (comments resolved,
    // a handback): read it now rather than at the next poll. Through
    // rereadPatches, so a poll's read already going (which looked before
    // the turn's change) is read again once it ends, not left to stand.
    if (rt.patches?.live && !this.stopping) this.rereadPatches(st);
    if (outcome && finished && !finished.auto && !this.stopping) {
      this.tellActivity({ kind: 'turn.end', threadId: rec.id, outcome, edited: [...finished.edited].map((p) => path.resolve(rec.cwd, p)), workedIn: [...(finished.workedIn ?? [])] });
    }
    if (rt.taskEndedInTurn) {
      rt.taskEndedInTurn = false;
      // Only while the CLI is there to start that turn.
      if (runningSession(rt) && !this.stopping) this.startWakeGrace(st);
    }
    rt.activeAt = this.clock.now();
    rec.turnId = undefined;
    rec.lastTurnCompletedSeq = completedSeq;
    // A subagent's card outlives the turn (completeTurn), so the thread is
    // still waiting on Mike.
    rec.status = rt.approvals.size ? 'waiting' : status;
    rec.lastActivityAt = this.isoNow();
    this.markDirty(st);
    const waiters = rt.turnEndWaiters ?? [];
    rt.turnEndWaiters = undefined;
    for (const w of waiters) w();
    // completeTurn applies the requested wait before older queued inputs
    // can start another turn. The inputs remain durable for a later wake.
    if (!holdQueue) this.afterTurn(st, limitHit, netLost, signedOut);
  }

  // A turn that ended without a result from the CLI (spawn failure, crash).
  // A coordinator's helper starting a turn: its coordinator follows that
  // turn from now on, so the one that ends the run is the one it hears
  // about. A carry-on after the network came back starts a turn the
  // coordinator never dispatched, whose end it otherwise threw away as
  // stale, leaving the run "running" for good (Codex's review, 26 Nov 2026).
  private noteHelperStart(st: ThreadState, turnId: string): void {
    if (!st.rec.coordinatorHelperFor) return;
    // The turn its background work woke carries the run on.
    st.rt.helperPending = undefined;
    this.coordinators?.noteHelperTurn(st.rec.id, turnId);
  }

  // A helper waits to report its latest result while it may have more work
  // from a background job, the runner's queue or a network retry. The next
  // turn takes over, or queue drain and wake grace settle this result.
  settleHelperPending(st: ThreadState): void {
    const { rec, rt } = st;
    const p = rt.helperPending;
    if (!p || rt.turn || rec.queue.length || rec.waitingForNetwork || this.stopping) return;
    if (p.outcome === 'completed' && this.wakes(st) && runningSession(rt) && (rt.tasks.length > 0 || rt.wakeTimer)) return;
    if (rec.waitingForRoom) {
      delete rec.waitingForRoom;
      this.armRoomTimer();
      this.markDirty(st);
    }
    rt.helperPending = undefined;
    this.coordinators?.onHelperTurn(rec.id, p.outcome, p.text, p.turnId);
  }

  failTurn(st: ThreadState, message: string, errorKind?: 'usageLimit'): void {
    const { rec, rt } = st;
    const turn = rt.turn;
    if (!turn) return;
    // A failed turn is Mike's to see, whatever an earlier one waited on.
    delete rt.awaitedShells;
    // A message held for a compaction never reached the CLI (runner/cold-compact.ts).
    this.keepHeldMessage(st);
    this.saveInterruptedMessages(st);
    this.settleInstructionsNews(st, false);
    // A wake's check that failed before the CLI (its folder gone): unread
    // as a failed turn is, and its row says it woke.
    if (rec.wakeNews?.check && turn.inputs?.has(rec.wakeNews.check)) rec.forceUnread = true;
    this.persistInProgress(st, turn.turnId);
    this.expireApprovals(st, 'The turn ended.');
    // A crash or a Stop ends a scheduled run for good: it stays in the
    // inbox, and a later run can't put it back in the archive (the end of
    // a turn, above).
    if (rec.unarchivedBySchedule) this.park(st, { kind: 'scheduleRunEnded' });
    const interrupted = turn.interruptRequested;
    if (!interrupted) this.emit(st, { type: 'error', message }, turn.turnId);
    const limit = !interrupted && (errorKind === 'usageLimit' || outOfUsage({ message }));
    const body: EventBody = {
      type: 'turn.completed',
      turnId: turn.turnId,
      outcome: interrupted ? 'interrupted' : 'failed',
      durationMs: Math.max(0, this.clock.now() - turn.startedAt),
    };
    if (!interrupted) {
      body.error = message;
      if (limit) body.errorKind = 'usageLimit';
    }
    const ev = this.emit(st, body, turn.turnId);
    this.endTurn(st, ev.seq, interrupted ? 'idle' : 'error', interrupted ? 'interrupted' : 'failed', limit ? turn.turnId : undefined);
    // A coordinator's helper whose CLI died, wouldn't start or was stopped:
    // its coordinator hears, as it does when a helper's turn ends
    // (completeTurn). Before, the run stayed "running" for good: the
    // coordinator never woke, read as waiting on it, and refused to start
    // another helper (Codex's review, 26 Nov 2026). Not while the runner
    // stops: the next runner reconciles interrupted helpers itself.
    if (rec.coordinatorHelperFor && !this.stopping) {
      if (rt.turn) this.coordinators?.noteHelperTurn(rec.id, rt.turn.turnId);
      else {
        rt.helperPending = { outcome: interrupted ? 'interrupted' : 'failed', text: turn.lastText || message, turnId: turn.turnId };
        this.settleHelperPending(st);
      }
    }
    // A review whose CLI died or wouldn't start: the thread it reviews
    // hears, rather than sleeping a day. Not one Mike stopped.
    if (!interrupted) this.releaseFailedReview(st, message, turn.lastText);
  }

  afterTurn(st: ThreadState, limitHit?: string, netLost?: string, signedOut?: string): void {
    if (this.stopping) return;
    if (limitHit) {
      try {
        this.onUsageLimit(st, limitHit);
      } catch (e) {
        this.log.error('could not move a thread off a login at its limit', { threadId: st.rec.id, error: String(e) });
      }
    }
    // In a box, its one login's cloud token was refused: the thread waits for a newer one (box-token.ts).
    if (signedOut && this.boxThread === st.rec.id && this.onBoxTokenRefused) {
      this.holdForToken(st, signedOut);
    } else if (signedOut) {
      try {
        this.onSignedOut(st);
      } catch (e) {
        this.log.error('could not move a thread off a signed-out login', { threadId: st.rec.id, error: String(e) });
      }
    }
    if (netLost) this.onNetworkLost(st, netLost);
    // A snoozed or archived thread keeps its queue until it comes back.
    if (this.bucket(st.rec) === 'inbox' && this.kickQueue(st)) return;
    this.scheduleIdle(st);
  }

  // ------------------------------------------------------- pools: moving

  // Before a pool thread's turn starts: if its login isn't OK (blocked or
  // under the minimum room) or isn't in its pool any more, it moves first
  // (docs/protocol/settings.md, "Pools"). With nowhere better, the turn starts
  // where it is. A pinned thread (no poolId) never moves.
  beforeTurn(st: ThreadState): void {
    const { rec } = st;
    const pool = this.poolById(rec.poolId);
    if (!pool) return;
    const accounts = this.usableAccounts();
    const eligible = this.poolTurnAccounts(rec, pool, accounts);
    const current = accounts.find((a) => a.id === rec.accountId);
    const inPool = pool.accountIds.includes(rec.accountId);
    if (current && eligible.includes(current) && inPool && loginOk(current)) return;
    const now = this.clock.now();
    const next = nextLogin(pool, eligible, rec, now);
    if ('waitUntil' in next) return;
    const why = !current ? `${rec.accountId} isn't on this Mac` : !inPool ? `${current.title} isn't in ${pool.title}`
      : !eligible.includes(current) ? `${current.title} no longer lists the selected model`
        : current.planEnded ? `${current.title}'s plan has ended` : current.signedOut ? `${current.title} is signed out` : `${current.title} ${limitWhy(current, now)}`;
    this.moveLogin(st, accounts.find((a) => a.id === next.accountId)!, why);
  }

  // ------------------------------------------------- the network dropping

  onExited(st: ThreadState, gen: number, err?: Error): void {
    const { rec, rt } = st;
    // An older CLI's exit is stale: nothing moves. Else the session goes,
    // and it says whether it was asked to stop.
    // A session to resume that was missing isn't the CLI failing: it was fine.
    const missing = err && (err instanceof SessionNotFoundError || err.name === 'SessionNotFoundError' || /no conversation found/i.test(err.message));
    const exit = this.cli(st, { kind: 'exited', gen, ...(err && !missing ? { failed: true } : {}) });
    if (!exit.ok) return;
    const released = exit.out.released === true;
    // One that fell over before it got going (and wasn't asked to stop).
    if (exit.out.reportStart === false) this.tellStarted(rec.provider, rt.startVersion, false);
    rt.frozen = false;
    // Nothing's left to answer them: a subagent's card can be open with no
    // turn running, and no turn ending would close it.
    this.expireApprovals(st, 'The CLI stopped.');
    // Its background work went with it: only now, as the cards closing
    // above can look at the thread (a handover's readiness check) and must
    // still see the work.
    this.cli(st, { kind: 'stopTasks' });
    rt.finished = [];
    rt.taskEndedInTurn = false;
    delete rt.awaitedShells;
    // Native sub-agents went with this CLI. Coordinator helpers have their own sessions.
    this.stopSubagents(st, { keepCoordinatorHelpers: true });
    rt.wakeTimer?.cancel();
    rt.wakeTimer = undefined;
    // No CLI to open a turn reading a background result: a done card held
    // back for one stands, and a helper's held turn ends its run.
    if (!rt.turn) {
      this.settlePendingFinish(st);
      this.settleHelperPending(st);
    }
    rt.idleTimer?.cancel();
    rt.idleTimer = undefined;
    this.log.info('session ended', { threadId: rec.id, error: err?.message });
    if (released) {
      // A CLI we asked to stop. A turn that is waiting for it to go starts
      // the next CLI once it has. A turn it had started by itself while
      // shutting down ends with it.
      if (rt.turn?.auto) {
        rt.turn.interruptRequested = true;
        this.failTurn(st, 'The session was released.');
      }
      this.markDirty(st);
      return;
    }
    if (rt.turn) {
      // The session to resume doesn't exist. For Claude that only ever
      // meant the CLI died before its first message (it never wrote the
      // transcript); for Codex it also covers a thread deleted in Codex's
      // own app, a missing rollout or a moved CODEX_HOME, part way through
      // a conversation. Start a fresh session once.
      const notFound = err && (err instanceof SessionNotFoundError || err.name === 'SessionNotFoundError' || (/no conversation found/i.test(err.message) && rec.status === 'starting'));
      // The other way round: a session started fresh whose id the CLI
      // already has. Its first turn was cut off (a restart) after the CLI
      // wrote the transcript but before its init reached the runner, so
      // sessionUsed never got set. Resume it instead, once (4 Nov 2026).
      const inUse = Boolean(err && !rt.resumed && /Session ID \S+ is already in use/i.test(err.message));
      // Not a coordinator's helper: a fresh session would have only the
      // message resuming it (a restart's carry-on, a resumeHelper), not its
      // brief. Its turn fails instead and its coordinator hears, to start a
      // new helper from the checkpoint (Codex's review, 26 Nov 2026).
      const freshOk = !(notFound && rec.coordinatorHelperFor);
      if (((notFound && rt.resumed) || inUse) && freshOk && !rt.retriedFresh) {
        this.cli(st, { kind: 'retryFresh' });
        if (inUse) {
          rec.sessionUsed = true;
          // The old session goes on, not the fresh one the brief was for.
          if (rec.instructionsTold !== undefined) rec.instructionsTold = INSTRUCTIONS_REWOUND;
        } else {
          rec.sessionUsed = false;
          rec.nativeSessionId = crypto.randomUUID();
          rec.sessionCostTotal = 0;
          delete rec.cliVersion;
        }
        const account = this.accounts.get(rec.accountId);
        if (account && rt.turn) {
          if (!inUse) this.emit(st, { type: 'system.note', text: "Couldn't resume the earlier session, so this is a new one." }, rt.turn.turnId);
          const turn = rt.turn;
          const log = this.store.log(rec.id);
          const msgs = log.read(Math.max(1, log.lastSeq - 200), log.lastSeq).filter((e) => e.type === 'user.message' && e.turnId === turn.turnId);
          const first = msgs[0];
          // Raised above a message's ceiling since it was first sent: held
          // before anything kept for the next message is taken.
          if (first && first.type === 'user.message' && this.heldAtDispatch(st, { ...first, turnId: turn.turnId, ceiling: turn.ceilings?.get(turn.turnId), helperRunId: turn.helperRunId })) return;
          if (first && first.type === 'user.message') {
            // The fresh session starts knowing where the thread got to: a
            // transcript carried to a new folder that wouldn't resume gets
            // the move's note, any other thread with earlier turns the
            // not-found one.
            turn.deliveryKnown = false;
            turn.startedMessages = undefined;
            turn.foreignOutput = false;
            // A compaction sent to the CLI that's gone didn't happen; the
            // message goes as it is (runner/cold-compact.ts), and Mike's sent
            // while it compacted go after it (Gemini's review).
            const pre = turn.precompact;
            if (turn.precompact) {
              turn.precompact = undefined;
              turn.noSteer = false;
            }
            const input = this.withInterruptedMessages(st, { turnId: turn.turnId, text: first.text, images: first.images, origin: first.origin }, this.forAgent(first));
            const command = this.commandPlan(st, first.text);
            let text = command ? first.text : input.text;
            // What it was told of presses went with the session that's gone:
            // a new one hears all it was told, the old one going on only this
            // turn's (Codex's second look).
            const pressed = this.toldPressNews(rec, inUse ? 'turn' : 'all');
            if (pressed && !command) text = `${pressed}\n\n${text}`;
            const woke = this.toldWakeNews(rec, inUse ? 'turn' : 'all');
            if (woke && !command) text = `${woke}\n\n${text}`;
            const earlier = rec.lastTurnCompletedSeq > 0;
            if (!inUse && (rt.carried || earlier) && !(command && /^\/clear\b/i.test(first.text.trim()))) {
              rec.handoff = rt.carried ?? { fromCwd: rec.cwd, fromAccountId: rec.accountId, lost: true };
              if (command) {
                // The command must stay bare. Keep the missing session's
                // context for the next ordinary send, rather than lose it.
                rec.handoff.lost = true;
                this.retellPressesFrom(rec, 0, true);
              } else {
                text = this.handoffNote(st, account) + text;
                delete rec.handoff;
              }
            }
            rt.carried = undefined;
            this.startSession(st, account);
            rt.session!.send({ ...input, text });
            // Messages sent into the turn before the CLI went go again, in
            // order, matched to their ids when the counts agree.
            if (msgs.length === turn.messages.length) {
              msgs.slice(1).forEach((m, i) => {
                if (m.type === 'user.message') {
                  const input = this.withInterruptedMessages(st, { turnId: turn.messages[i + 1], text: m.text, images: m.images, origin: m.origin }, this.forAgent(m));
                  rt.session!.send(input);
                }
              });
            }
            if (pre) this.steerQueuedMeanwhile(st, pre);
            return;
          }
        }
      }
      this.failTurn(st, err?.message || 'The CLI stopped unexpectedly.', err instanceof SessionUsageLimitError ? 'usageLimit' : undefined);
    } else {
      this.markDirty(st);
    }
    // A CLI that exited by itself (not released) may have been all an
    // archive was waiting for.
    this.archiveWhenGone(st);
  }

  // byMike: his Stop, in the app or on the phone. Everything else that stops
  // a turn (an agent's interrupt_thread, an archive, a move) mustn't reach
  // the agent as his decision (docs/protocol/needs-you.md, "Who stopped it").
  interrupt(threadId: string, opts: { byMike?: boolean; controlCeiling?: PermissionMode } = {}): Record<string, never> {
    const st = this.mustGet(threadId);
    this.checkControlCeiling(threadId, opts.controlCeiling);
    const { rt } = st;
    const turn = rt.turn;
    const closing = { stopped: opts.byMike === true };
    // Stop with only a subagent's card open: that card is what's waiting.
    if (!turn) {
      this.expireApprovals(st, 'Interrupted.', closing);
      return {};
    }
    turn.interruptRequested = true;
    this.expireApprovals(st, 'Interrupted.', closing);
    const session = runningSession(rt);
    // Nothing is running in the CLI for a turn that was only opened for a
    // background subagent's approval, so nothing would end it.
    if (!session || (turn.auto && !turn.cliStarted)) {
      this.failTurn(st, 'Interrupted.');
      return {};
    }
    turn.interruptTimer ??= this.clock.setTimeout(() => {
      if (rt.turn !== turn) return;
      this.log.warn('the CLI did not end an interrupted turn; ending it', { threadId });
      this.failTurn(st, 'Interrupted.');
      // It'd never read the next message either.
      if (rt.frozen) session.kill();
    }, INTERRUPT_GRACE_MS);
    session.interrupt().catch((e: unknown) => {
      // Before the CLI has initialised there's nothing to interrupt; stop it.
      this.log.warn('interrupt failed, stopping the CLI', { threadId, error: String(e) });
      session.kill();
    });
    return {};
  }

  update(params: {
    threadId: string;
    controlCeiling?: PermissionMode;
    title?: string;
    // Who the title is from. Mike's (the default: the app, tb) sticks: an
    // agent can't rename it after, unless it says Mike asked it to and
    // passes 'mike' itself.
    titleBy?: 'mike' | 'agent';
    cwd?: string;
    accountId?: string;
    // null pins the thread to its current login; a pool id puts it in that
    // pool (and onto one of its logins if its current one isn't in it).
    // accountId pins it to that login, poolId or not.
    poolId?: string | null;
    model?: string | null;
    effort?: EffortLevel | null;
    permissionMode?: PermissionMode;
    snoozedUntil?: string | null; // an ISO time, 'restart' for until the runner next starts, or 'release' for until it starts on a new release
    archived?: boolean;
    // Who's archiving it: Mike (the default: the app, the phone, tb), an
    // agent (update_thread, end_turn's archive) or Threadbear itself. With
    // Mike's verdict from the done card's Archive menu, so whoever reads
    // the thread later knows it was put away on purpose, and how it went.
    archivedBy?: ArchivedBy;
    // With archived: false, 'shouldHaveShown' (quietInboxMine's "Should have
    // shown me"): he brings it back and says it was wrongly hidden.
    verdict?: ArchiveVerdict | UnarchiveVerdict;
    starred?: boolean;
    // Out from under the thread that started it in the sidebar, or back
    // (docs/protocol/threads.md, "Nested threads").
    detached?: boolean;
    // Whether a turn that hits its login's limit waits for room and
    // carries on by itself (the limit box's menu). false also ends a wait
    // under way; true starts one if the thread is stuck at its limit now.
    carryOnAtReset?: boolean;
    // With accountId, on a thread whose last turn stopped at its login's
    // limit: carry on there now, rather than wait for a message (the limit
    // box's Continue now on).
    carryOn?: boolean;
    // An agent's call (update_thread, move_thread, tb from a thread): a
    // move it makes never starts a turn by itself, as the thread may have
    // more access than the agent (send_message asks for that).
    byAgent?: boolean;
    // With poolId: the provider picked in the menu (its column), for a
    // pool with logins of both. Else the model's, else the thread's own.
    provider?: Provider;
    // The caller has already said in the thread why it's hibernating or
    // archiving it (end_turn's snooze or archive, the quiet inbox): no
    // second line from here (place-notes.ts).
    noted?: boolean;
    // Why, for that line, when the caller knows and hasn't said it.
    why?: string;
  }): { thread: ThreadSummary } {
    const st = this.mustGet(params.threadId);
    this.checkControlCeiling(params.threadId, params.controlCeiling);
    const { rec, rt } = st;
    if (params.permissionMode !== undefined) this.checkHelperPermissionChange(st, params.permissionMode);
    if (this.activeCoordinator(rec.id) && (params.archived || params.snoozedUntil)) {
      throw new RpcError(ErrorCode.badParams, 'Pause this project’s coordinator before archiving or hibernating its conversation.');
    }
    // Checked before anything changes, so a refused rename changes nothing else either.
    if (params.title !== undefined && params.titleBy === 'agent' && rec.titleByMike && params.title.trim() !== rec.title) {
      throw new RpcError(ErrorCode.badParams, `The user named this thread "${rec.title}" themselves, so it keeps that title. Only rename it if they ask you to.`);
    }
    // Continue now on can't start a turn while a restart refuses them, and
    // a carry-on put off till after it would be lost to "Carry on by itself:
    // No" or a second click (Codex's review): say so, and change nothing.
    if (params.carryOn && params.accountId !== undefined && (this.refusing || this.draining)) {
      throw new RpcError(ErrorCode.busy, 'Threadbear is restarting, so it can\'t carry on just now. Try again in a moment.');
    }
    let release = false;
    let stop = false;
    const pool = typeof params.poolId === 'string' && params.accountId === undefined ? this.poolById(params.poolId) : undefined;
    if (typeof params.poolId === 'string' && params.accountId === undefined && !pool) {
      throw new RpcError(ErrorCode.badParams, `No pool called ${params.poolId}. Pools: ${this.pools().map((p) => p.id).join(', ') || 'none'}`);
    }
    // The login to move to: the one named (which pins), or one of the pool's
    // when moving pools or picking a model from another provider in the same pool.
    const activePool = pool ?? (params.accountId === undefined && params.poolId === undefined && rec.poolId ? this.poolById(rec.poolId) : undefined);
    let toAccountId = params.accountId;
    const accounts = activePool ? this.usableAccounts() : [];
    const modelMembers = activePool && params.model
      ? modelAccounts(poolAccounts(activePool, accounts).filter((a) => !params.provider || a.provider === params.provider), params.model)
      : [];
    const wanted = params.provider ?? modelMembers.find((a) => a.provider === rec.provider)?.provider ?? modelMembers[0]?.provider;
    const otherProvider = wanted !== undefined && wanted !== rec.provider && activePool?.accountIds.some((id) => this.accounts.get(id)?.provider === wanted);
    const needsModelLogin = modelMembers.length > 0 && !modelMembers.some((a) => a.id === rec.accountId);
    if (activePool && (otherProvider || needsModelLogin || (pool && !pool.accountIds.includes(rec.accountId)))) {
      const provider = otherProvider ? wanted : rec.provider;
      const candidates = modelMembers.length ? modelMembers : accounts;
      let id = pickInPool(activePool, candidates, { provider });
      if (!id && !otherProvider && !modelMembers.length) {
        const next = nextLogin(activePool, accounts, rec, this.clock.now());
        if (!('waitUntil' in next)) id = next.accountId;
      }
      const members = poolAccounts(activePool, candidates);
      toAccountId = id ?? members.find((a) => a.provider === provider)?.id ?? members[0]?.id;
    }
    if (params.title !== undefined) {
      rec.title = cutSafely(params.title.trim(), 200) || rec.title;
      rec.titleSet = true;
      if (params.titleBy !== 'agent') rec.titleByMike = true;
    }
    if (params.cwd !== undefined && !params.cwd.trim()) throw new RpcError(ErrorCode.badParams, 'cwd must not be blank');
    const newCwd = params.cwd !== undefined ? path.resolve(expandHome(params.cwd.trim())) : undefined;
    if (newCwd !== undefined && !isDirectory(newCwd)) throw new RpcError(ErrorCode.badParams, `Folder not found: ${newCwd}`);
    const newAccount = toAccountId !== undefined ? this.accounts.get(toAccountId) : undefined;
    if (toAccountId !== undefined && !newAccount) {
      throw new RpcError(ErrorCode.accountNotFound, `No account called ${toAccountId}`);
    }
    if (newAccount && toAccountId !== rec.accountId) this.checkProvider(newAccount);
    // Pinned (an account named, or poolId null), or into a pool.
    if (params.accountId !== undefined || params.poolId === null) {
      delete rec.poolId;
      delete rec.waitingForRoom;
    } else if (pool) rec.poolId = pool.id;
    const cwdChanged = newCwd !== undefined && newCwd !== rec.cwd;
    const fromCwd = rec.cwd;
    const accountChanged = toAccountId !== undefined && toAccountId !== rec.accountId;
    const providerChanged = accountChanged && newAccount!.provider !== rec.provider;
    const adapter = this.adapters[rec.provider];
    // Changes a CLI that applies settings from its next turn only (Codex)
    // can't take into a turn that's running; the thread says so.
    const nextTurn: string[] = [];
    const sayNextTurn = () => Boolean(rt.turn) && !rt.turn?.local && Boolean(adapter?.settingsApplyNextTurn) && !release;
    if (cwdChanged && !accountChanged && !rec.handoff && adapter?.movesFolders) {
      // Same account on a CLI that moves folders itself: the same session
      // carries on in the new folder from its next turn, with no
      // transcript copy and no handoff. A live session is told now; a
      // released one gets the folder when it resumes.
      if (rec.sessionUsed || rt.session) rec.moved ??= { fromCwd: rec.cwd };
      rec.cwd = newCwd!;
      rec.cwdAt = this.isoNow();
      if (rec.moved?.fromCwd === rec.cwd) delete rec.moved;
      const session = runningSession(rt);
      if (session) {
        const gen = rt.generation;
        const fallback = () => {
          // Couldn't move the live session: a fresh CLI resumes there,
          // once any background work is done (scheduleIdle). Not one
          // started since, which started there.
          if (!this.cli(st, { kind: 'leave', gen }).ok) return;
          if (!rt.turn) this.scheduleIdle(st);
        };
        if (session.setCwd) session.setCwd(rec.cwd).catch(fallback);
        else fallback();
      }
      if (sayNextTurn()) nextTurn.push(`The move to ${rec.cwd}`);
    } else if (cwdChanged || accountChanged) {
      // Takes effect on the next turn as a new native session.
      if (rec.sessionUsed || rt.session) rec.handoff ??= { fromCwd: rec.moved?.fromCwd ?? rec.cwd, fromAccountId: rec.accountId };
      delete rec.moved;
      if (newCwd !== undefined && newCwd !== rec.cwd) {
        rec.cwd = newCwd;
        rec.cwdAt = this.isoNow();
      }
      if (toAccountId !== undefined) {
        rec.accountId = toAccountId;
        if (params.accountId !== undefined) this.rememberAccount(toAccountId);
      }
      release = true;
    }
    if (cwdChanged) this.tellActivity({ kind: 'moved', threadId: rec.id, from: fromCwd, to: rec.cwd });
    // The account the settings are checked against, after any change.
    const account = newAccount ?? this.accounts.get(rec.accountId);
    let model = rec.model;
    let effort = rec.effort;
    let touched = false;
    if (providerChanged) {
      // Another provider's CLI: its own defaults (unless this call sets
      // them), and none of the old CLI's "Always allow" rules, which are in
      // its own syntax.
      rec.provider = newAccount!.provider;
      delete rec.allowRules;
      delete rec.cliVersion;
      model = this.defaultModelFor(rec.provider);
      effort = this.defaultEffortFor(rec.provider);
      touched = true;
    }
    if (params.model !== undefined) {
      model = params.model || undefined;
      touched = true;
    }
    if (params.effort !== undefined) {
      effort = params.effort || undefined;
      touched = true;
    }
    if (touched && account) {
      const checked = this.checkSettings(account, model, effort);
      model = checked.model;
      effort = checked.effort;
      for (const text of checked.notes) this.emit(st, { type: 'system.note', text }, rt.turn?.turnId);
    }
    if (params.model !== undefined || providerChanged || model !== rec.model) {
      if (account && model && model === params.model) rec.explicitModel = explicitModelKind(account, model);
      else delete rec.explicitModel;
    }
    if (model !== rec.model) {
      if (model) rec.model = model;
      else delete rec.model;
      if (rt.session && !release) {
        const gen = rt.generation;
        rt.session.setModel(model).catch(() => {
          this.cli(st, { kind: 'leave', gen });
        });
        if (sayNextTurn()) nextTurn.push(model ? (account ? modelTitle(account, model) : model) : 'The default model');
      }
    }
    if (effort !== rec.effort) {
      if (effort) rec.effort = effort;
      else delete rec.effort;
      if (rt.session && !release) {
        const gen = rt.generation;
        rt.session.setEffort(effort).catch(() => {
          this.cli(st, { kind: 'leave', gen });
        });
        if (sayNextTurn()) nextTurn.push(effort ? `${effortTitle(effort)} effort` : "The model's own effort level");
      }
    }
    if (params.permissionMode !== undefined && params.permissionMode !== rec.permissionMode) {
      const wasMode = rec.permissionMode;
      // What approving a plan goes back to.
      if (params.permissionMode === 'plan') rec.modeBeforePlan = rec.permissionMode;
      else delete rec.modeBeforePlan;
      rec.permissionMode = params.permissionMode;
      // The turn counts as having had the most access it was given: a
      // Claude CLI takes a raise now, and a lowered Codex turn carries on
      // as it started.
      if (rt.turn) rt.turn.access = moreAccess(rt.turn.access, params.permissionMode);
      // Out of Full with the folder's untrusted permission rules loaded:
      // they stop applying now, even to a turn the CLI starts by itself,
      // and the next message gets a CLI without them.
      if (rt.session && rt.claudeHeldGrants && params.permissionMode !== 'full') {
        rt.session.askBeforeEveryTool?.();
        this.cli(st, { kind: 'leave' });
      }
      // A session on its way out (another login or folder in the same
      // call) still hears it: its turn runs on till the next message, and
      // on Full a Codex one answers its own approvals.
      if (rt.session) {
        const gen = rt.generation;
        rt.session.setPermissionMode(params.permissionMode).catch(() => {
          // A CLI started since started in this mode.
          if (!this.cli(st, { kind: 'leave', gen }).ok) return;
          if (!rt.turn) this.releaseSession(st);
        });
        // Full counts at once even on Codex: what the turn would ask, the
        // runner answers itself (codex/approvals.ts, fullAccess). Not out
        // of Plan first, whose turn keeps planning till it ends.
        if (sayNextTurn() && (params.permissionMode !== 'full' || wasMode === 'plan')) {
          nextTurn.push(params.permissionMode === 'ask' ? 'Ask before edits' : params.permissionMode === 'auto' ? 'Auto' : params.permissionMode === 'plan' ? 'Plan first' : 'Full access');
        } else if (sayNextTurn()) {
          // Its sandbox is the turn's, though: a command that fails in it
          // without asking still fails till the next turn (Codex's review).
          this.emit(st, { type: 'system.note', text: "Full access allows what this turn asks from now on. Its sandbox opens from the next turn, so a command that fails in it now may need sending again." }, rt.turn?.turnId);
        }
      }
      // The cards showing that Full wouldn't have asked: allowed now, and
      // said so on the card, rather than left waiting under a composer that
      // says Full (Ian, 13 Nov).
      if (params.permissionMode === 'full') {
        for (const p of [...rt.approvals.values()]) {
          if (p.kind === 'tool' && p.fullAllows) this.respondApproval({ threadId: rec.id, approvalId: p.approvalId, decision: 'allow', message: 'Allowed by Full access' });
        }
        for (const r of [...(rt.reviews?.values() ?? [])]) {
          if (r.fullAllows) r.cancel({ decision: 'allow', message: 'Allowed by Full access' });
        }
      }
    }
    if (nextTurn.length) {
      this.emit(
        st,
        { type: 'system.note', text: `${joinWords(nextTurn)} ${nextTurn.length === 1 ? 'applies' : 'apply'} from the next turn. This turn carries on as it started.` },
        rt.turn?.turnId,
      );
    }
    // Who it was, for the line in the thread (place-notes.ts).
    const who = params.byAgent ? 'agent' as const : 'mike' as const;
    const noteZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (params.snoozedUntil !== undefined && !params.noted) {
      if (params.snoozedUntil === null) {
        if (rec.snoozedUntil && !rec.archivedAt) this.emit(st, { type: 'system.note', text: wokenNote({ who, now: this.clock.now(), timeZone: noteZone }) });
      } else if (params.snoozedUntil === 'restart' || params.snoozedUntil === 'release' || !Number.isNaN(Date.parse(params.snoozedUntil))) {
        this.emit(st, { type: 'system.note', text: hibernatedNote({ who, until: params.snoozedUntil, now: this.clock.now(), timeZone: noteZone }) });
      }
    }
    if (params.archived !== undefined && !params.noted) {
      if (params.archived && !rec.archivedAt) {
        // A verdict from the Archive menu says it already (ARCHIVE_NOTES).
        const verdict = (params.archivedBy ?? 'mike') === 'mike' && params.verdict && params.verdict !== 'shouldHaveShown';
        if (!verdict) this.emit(st, { type: 'system.note', text: archivedNote({ by: params.archivedBy ?? who, now: this.clock.now(), timeZone: noteZone, ...(params.why ? { why: params.why } : {}) }) });
      } else if (!params.archived && rec.archivedAt) {
        // "Should have shown me", from the archived row's menu or an agent's
        // `tb unarchive --wrong-hide` (the quiet inbox's daily review).
        const wrong = params.verdict === 'shouldHaveShown' ? { why: who === 'mike' ? "Quiet inbox shouldn't have hidden it" : "you said Quiet inbox shouldn't have hidden it" } : {};
        this.emit(st, { type: 'system.note', text: unarchivedNote({ who, now: this.clock.now(), timeZone: noteZone, ...(params.why ? { why: params.why } : {}), ...wrong }) });
      }
    }
    if (params.snoozedUntil !== undefined) {
      // Any wait it had ends; a snooze from the inbox or the archive starts
      // counting from now (place.ts, snooze).
      if (params.snoozedUntil === null) this.park(st, { kind: 'unsnooze' });
      else if (params.snoozedUntil === 'restart' || params.snoozedUntil === 'release') {
        // Until a start on another release than this one. From a source
        // checkout there's no release to tell apart, so any start does.
        this.park(st, { kind: 'snooze', until: { kind: 'restart', ...(params.snoozedUntil === 'release' && this.release ? { release: this.release } : {}) } });
        stop = true;
      } else {
        const t = Date.parse(params.snoozedUntil);
        if (Number.isNaN(t)) throw new RpcError(ErrorCode.badParams, 'snoozedUntil must be an ISO time, "restart" or "release"');
        this.park(st, { kind: 'snooze', until: { kind: 'time', at: new Date(t).toISOString(), ...(params.byAgent ? { by: 'agent' as const } : {}) } });
        stop = true;
      }
      this.armSnoozeTimer();
    }
    let archiving = false;
    if (params.archived !== undefined) {
      // Mike (or an agent) archived or unarchived it himself: that settles
      // where it lives, not the schedule run that brought it back (place.ts).
      if (params.archived) {
        archiving = !rec.archivedAt;
        const by = params.archivedBy ?? 'mike';
        const verdict = by === 'mike' && params.verdict !== 'shouldHaveShown' ? params.verdict : undefined;
        // His putting away a finished thread, with or without a pick from
        // the Archive menu, is what the inbox guess is scored against.
        if (archiving && by === 'mike') this.noteInboxArchive(st, this.looseEndsCard(st), verdict);
        // Said in the thread, for the agent or a sweeper reading it later.
        if (verdict && (archiving || verdict !== rec.archiveVerdict)) this.emit(st, { type: 'system.note', text: ARCHIVE_NOTES[verdict] });
        this.park(st, { kind: 'archive', by, ...(verdict ? { verdict } : {}) });
        stop = true;
      } else {
        // "Should have shown me" on a thread the quiet inbox archived:
        // written down beside the guesses (the line above says it).
        if (params.verdict === 'shouldHaveShown' && rec.archivedAt) this.noteWrongHide(st);
        // Brought back out by hand: it stays out, however its next turn ends
        // (runner/quiet-inbox.ts).
        this.park(st, { kind: 'unarchive' });
        // A wait on workflow runs goes on, and its looks stopped while archived.
        if (rec.waitingOnRuns) queueMicrotask(() => this.kickCiRuns(st));
      }
    }
    if (archiving) {
      this.reconcileWaits();
      this.recheckStarter(st);
      this.settleHeldSoon(rec.startedBy?.threadId);
    }
    if (params.starred === true) rec.starredAt ??= this.isoNow();
    else if (params.starred === false) delete rec.starredAt;
    if (params.detached !== undefined && rec.startedBy?.kind === 'thread' && rec.startedBy.threadId) {
      if (params.detached) rec.detached = true;
      else delete rec.detached;
      // Its starter may have been holding reports for it (runner/nested.ts).
      this.settleHeldSoon(rec.startedBy.threadId);
    }
    if (params.carryOnAtReset !== undefined) this.setCarryOnAtReset(st, params.carryOnAtReset);
    if (accountChanged && rt.turn && rt.session && !stop) {
      // The turn carries on where it started; say so, or the picker reads
      // as if the new model were already doing the work.
      this.emit(st, { type: 'system.note', text: `${this.modelLabel(rec)} takes over from your next message, which stops this turn.` }, rt.turn.turnId);
    }
    if (!stop && this.bucket(rec) === 'inbox') this.kickQueue(st);
    if (stop) {
      // Snoozing or archiving stops the CLI: end any turn, then release.
      this.cli(st, { kind: 'leave' });
      if (rt.turn) this.interrupt(rec.id);
      else this.releaseSession(st);
    } else if (release) {
      // Another login or folder: the CLI goes now, or once its background
      // work is done (scheduleIdle). The next message gets the fresh one
      // either way.
      this.cli(st, { kind: 'leave' });
      if (!rt.turn) this.scheduleIdle(st);
    }
    // Its first turn on the new login releases the old CLI (deliver).
    // A thread whose last turn stopped at a usage limit carries on by
    // itself when it's moved to another login, from the model menu too,
    // not only Continue now on: picking a login with room is asking for
    // that (Ian, 13 Nov: after switching to Codex at the limit he couldn't
    // tell whether it was on the new model yet or waiting for him, and
    // the Swift limit box's Switch to promises it carries on now). Unless
    // Mike turned carrying on off for this thread, which the menu doesn't
    // ask about (Continue now on does), or an agent made the move.
    const carriesOn = accountChanged && !stop && !rt.turn && !rt.editing && !rec.queue.length && this.bucket(rec) === 'inbox' && rec.limitHitTurn !== undefined
      && (params.carryOn || (rec.carryOnAtReset !== false && !params.byAgent));
    if (carriesOn) this.carryOn(st, CARRY_ON_MOVED);
    // A wait for room was for the old login: moved anywhere else without
    // carrying on now, it ends, so its timer can't carry on later what an
    // agent's move (or "Carry on by itself: No") said waits for Mike.
    if (accountChanged && !carriesOn && rec.waitingForRoom) {
      delete rec.waitingForRoom;
      this.armRoomTimer();
    }
    if (!carriesOn && accountChanged && !stop && !rt.turn && rec.handoff) {
      // Idle, with a conversation to hand over: nothing runs until the
      // next message, so say so, or the picker reads as if the new model
      // had already picked up the thread.
      this.emit(st, { type: 'system.note', text: `${this.modelLabel(rec)} takes over from your next message.` });
    }
    // Archived here, archived in the CLI's own app too (Codex Desktop's
    // list), once the session has let go of it: a turn is interrupted
    // first, then released, so that can take a moment. Resuming unarchives.
    if (archiving) {
      rt.archivePending = true;
      // Its worktree's cleanup is owed, and its teardown due again.
      this.slot(st, { kind: 'archived' });
      this.archiveWhenGone(st);
    }
    rec.updatedAt = this.isoNow();
    this.markDirty(st);
    return { thread: this.summary(st) };
  }

  // Stops the thread's CLI, moves its folder to trash/ in the data dir (so
  // a mistake can be undone by hand) and forgets it.
  delete(threadId: string): Record<string, never> {
    const st = this.mustGet(threadId);
    if (st.rec.coordinatorHelperFor && this.coordinators?.forThread(st.rec.coordinatorHelperFor)) {
      throw new RpcError(ErrorCode.badParams, 'A coordinator helper session is managed by its project coordinator.');
    }
    this.coordinators?.forget(threadId);
    const { rec, rt } = st;
    rt.deleted = true;
    rt.trashed = true;
    this.threads.delete(threadId);
    this.waitedOnDeleted(threadId);
    this.settleHeldSoon(rec.startedBy?.threadId);
    this.dirty.delete(threadId);
    rt.idleTimer?.cancel();
    rt.deltaTimer?.cancel();
    rt.ciTimer?.cancel();
    rt.wakeTimer?.cancel();
    rt.turn?.interruptTimer?.cancel();
    // A new generation makes everything the old CLI still reports (output,
    // approvals, its exit) go nowhere; the CLI is forgotten and stopped.
    const dropped = this.cli(st, { kind: 'drop', forget: true });
    for (const [, p] of rt.approvals) {
      settleDeclined(p, 'expired', 'The thread was deleted.');
    }
    rt.approvals.clear();
    for (const r of [...(rt.reviews?.values() ?? [])]) r.cancel({ decision: 'expired', message: 'The thread was deleted.' });
    const session = dropped.ok ? dropped.out.forgot : undefined;
    const ended = session?.end({ hard: true }).catch((e: unknown) => this.log.warn('stopping a deleted thread failed', { threadId, error: String(e) }));
    this.archiveNative(st, ended ?? rt.closing);
    // Its worktree goes once the CLI has let go of the folder, and after an
    // archive's cleanup still running, rather than beside it (that one may
    // already have removed it).
    // One still being made and set up is cleaned up by prepareWorktree.
    if (rec.worktree && !rec.worktree.removedAt && !rt.preparing) {
      const cleaning = rt.cleaning;
      void Promise.resolve(ended ?? rt.closing)
        .catch(() => undefined)
        .then(() => cleaning)
        .then(() => this.cleanUpWorktree(st, true))
        .catch((e: unknown) => this.log.error('worktree cleanup failed', { threadId, error: String(e) }));
    }
    this.store.trash(threadId, this.clock.now());
    this.log.info('thread deleted', { threadId, title: rec.title });
    this.armSnoozeTimer();
    if (!rec.coordinatorHelperFor) this.notify({ method: 'thread.deleted', params: { threadId } });
    return {};
  }

  // Project identity cannot disappear while its coordinator is working.
  beforeProjectRemoval(projectId: string): void { this.coordinators?.removeProject(projectId); }

  // Ticks one of the open card's asks. Nothing goes to the agent: ticks are
  // Mike's own list, and a reply is his to write.
  tickAsk(threadId: string, asksSeq: number, index: number, ticked: boolean): { thread: ThreadSummary } {
    const st = this.mustGet(threadId);
    const { rec } = st;
    const card = rec.needs;
    if (!card?.asks || card.seq !== asksSeq || card.seq !== rec.lastTurnCompletedSeq) throw new RpcError(ErrorCode.badParams, "That isn't the thread's open card of asks.");
    if (!Number.isInteger(index) || index < 0 || index >= card.asks.length) throw new RpcError(ErrorCode.badParams, 'No such ask.');
    if (card.resolved?.includes(index)) throw new RpcError(ErrorCode.badParams, 'That decision was already handled on the task board.');
    const set = new Set(card.ticked);
    if (ticked) set.add(index);
    else set.delete(index);
    card.ticked = [...set].sort((a, b) => a - b);
    this.publishAskTicks(st, card);
    return { thread: this.summary(st) };
  }

  resolveCoordinatorAsks(st: ThreadState, indexes: number[]): void {
    const card = st.rec.needs;
    if (!card?.asks || card.seq !== st.rec.lastTurnCompletedSeq) return;
    const resolved = new Set(card.resolved);
    const count = resolved.size;
    for (const index of indexes) resolved.add(index);
    if (resolved.size === count) return;
    const previous = card.resolved;
    card.resolved = [...resolved].sort((a, b) => a - b);
    try {
      this.publishAskTicks(st, card);
    } catch (error) {
      card.resolved = previous;
      throw error;
    }
  }

  private publishAskTicks(st: ThreadState, card: NonNullable<ThreadRecord['needs']>): void {
    const { rec } = st;
    const ticked = [...new Set([...(card.ticked ?? []), ...(card.resolved ?? [])])].sort((a, b) => a - b);
    const caughtUp = rec.lastSeenSeq >= rec.lastSeq;
    const ev = this.emit(st, { type: 'asks.ticked', asksSeq: card.seq, ticked, ...(card.resolved?.length ? { resolved: card.resolved } : {}) });
    if (caughtUp) rec.lastSeenSeq = ev.seq;
    this.markDirty(st);
  }

  // A quiet wake (HibernationPart.wake) wants Mike once no schedule will
  // bring the thread back: the same test as its wait state's, so the two
  // agree, and schedules.updated looks at it again (recheckWaitStates).
  quietWakeShows(rec: ThreadRecord): boolean {
    return Boolean(rec.quietWake) && this.bucket(rec) === 'inbox' && !this.hibernatesForSchedule(rec.id);
  }

  saidNothing(rec: ThreadRecord): boolean {
    return rec.needs?.needs === 'nothing' && rec.needs.seq === rec.lastTurnCompletedSeq;
  }

  markSeen(threadId: string, seq: number): { thread: ThreadSummary } {
    const st = this.mustGet(threadId);
    const { rec } = st;
    const last = Math.max(rec.lastSeq, this.store.log(threadId).lastSeq);
    rec.lastSeenSeq = Math.max(rec.lastSeenSeq, Math.min(Math.floor(seq), last));
    rec.forceUnread = false;
    delete rec.quietWake;
    this.park(st, { kind: 'seen' });
    this.markDirty(st);
    return { thread: this.summary(st) };
  }

  // media.import from a thread's own key (Daybreak finding 157): off the
  // event loop, and below Full access metered (media-quota.ts). Whether it's
  // metered is the caller gate's call, by the thread's saved mode, as for
  // everything else it may do. The owner's imports (the app's paste and drop)
  // are importMedia's.
  readonly importQuota = new ImportQuota();

  async importMediaForThread(threadId: string, p: string, metered: boolean): Promise<{ image: ImageRef }> {
    const src = path.resolve(expandHome(p));
    const dir = paths.inbox(this.cfg.home);
    if (metered) return { image: await this.importQuota.run(threadId, src, dir) };
    try {
      return { image: await importImageInto(dir, src) };
    } catch (e) {
      throw new RpcError(ErrorCode.badParams, (e as Error).message);
    }
  }

  importMedia(p: string): { image: ImageRef } {
    const src = path.resolve(expandHome(p));
    if (!fs.existsSync(src)) throw new RpcError(ErrorCode.badParams, `File not found: ${src}`);
    try {
      return { image: copyImageInto(paths.inbox(this.cfg.home), src) };
    } catch (e) {
      throw new RpcError(ErrorCode.badParams, (e as Error).message);
    }
  }

  // ------------------------------------------------------------- approvals

  // ---------------------------------------------------------- idle release

  // ------------------------------------------------------------ CLI updates

  // Runs a pending archive once no CLI has the session: none live and none
  // closing. Skipped if the thread came back meanwhile. A turn-end hook still
  // running holds it too (runHooks comes back here): it's working in the
  // folder the cleanup would remove or hand on, and on 7 Nov a typecheck
  // lost its files that way, "failed", and woke the thread just archived.
  // Waiting also means a real failure finds the worktree still there, as
  // sendTo brings the thread back before the cleanup looks. A patch action
  // still running holds it the same way (runAction comes back here).
  archiveWhenGone(st: ThreadState): void {
    const { rec, rt } = st;
    if (!rt.archivePending || rt.session || rt.closing || rt.deleted || rt.hooksRunning || rt.runningActions?.size || rt.preparing) return;
    rt.archivePending = false;
    if (rec.archivedAt) {
      this.archiveNative(st);
      if (rec.worktree && !rec.worktree.removedAt && !rt.cleaning) {
        const cleaning = this.cleanUpWorktree(st)
          .catch((e: unknown) => this.log.error('worktree cleanup failed', { threadId: rec.id, error: String(e) }))
          .finally(() => {
            if (rt.cleaning === cleaning) rt.cleaning = undefined;
          });
        rt.cleaning = cleaning;
      }
    }
  }

  // Archives the native session in the CLI's own app (Codex Desktop) when
  // the thread is archived or deleted here, once `after` (the session
  // letting go) has settled. Best effort.
  archiveNative(st: ThreadState, after?: Promise<unknown>): void {
    const { rec } = st;
    const adapter = this.adapters[rec.provider];
    if (!adapter?.archive || !rec.sessionUsed || !rec.nativeSessionId) return;
    const account = this.accounts.get(rec.accountId);
    if (!account) return;
    const nativeId = rec.nativeSessionId;
    const threadId = rec.id;
    void Promise.resolve(after)
      .catch(() => undefined)
      .then(() => adapter.archive!(account, nativeId))
      .catch((e: unknown) => this.log.warn('could not archive the session in the CLI', { threadId, nativeSessionId: nativeId, error: String(e) }));
  }

  // ----------------------------------------------------------------- snooze

  // A zero-token interrupted result is not a receipt. Keep the original
  // log rows so their pictures and origin survive without duplicate user rows.
  saveInterruptedMessages(st: ThreadState, result?: TurnResult, forHandover = false): void {
    const { rec, rt } = st;
    const turn = rt.turn;
    if (!turn || (!turn.interruptRequested && !forHandover) || turn.local || rt.editing) return;
    const unreceived = new Set(result?.unreceived);
    const usage = result?.own ? undefined : result?.usage;
    const zero = usage?.inputTokens === 0 && usage.outputTokens === 0 &&
      !Object.values(usage).some(n => typeof n === 'number' && n > 0);
    if (!unreceived.size && !turn.deliveryKnown && (turn.modelOutput || (usage && !zero) || (!zero && rt.started && turn.dispatched))) return;
    const ids = new Set(rec.interruptedMessages);
    const before = ids.size;
    const requeuedInputs: QueuedSend[] = [];
    for (const [id, seq] of turn.inputs ?? []) {
      if (unreceived.size && !unreceived.has(id)) continue;
      if (!unreceived.has(id) && (turn.startedMessages?.has(id) || (turn.deliveryKnown && !turn.cancelledMessages?.has(id) && (turn.modelOutput || (usage && !zero))))) continue;
      const e = this.store.log(rec.id).read(seq, seq)[0];
      if (e?.type !== 'user.message' || this.commandPlan(st, e.text) || cutOut(rec, seq)) continue;
      if (fromMike(e.text, e)) ids.add(seq);
      else if (id !== turn.turnId && !isAutomaticInput(e) && !turn.requeuedMessages?.has(id)) {
        // A peer's instruction is just as current as the user's. The CLI
        // explicitly rejected it, so deliver it again before older reminders.
        const ceiling = turn.ceilings?.get(id);
        requeuedInputs.push({ turnId: crypto.randomUUID(), retryAfterInterrupt: true, text: e.text, images: e.images ?? [], seq, ...(e.origin ? { origin: e.origin } : {}), ...(ceiling !== undefined ? { ceiling } : {}) });
        (turn.requeuedMessages ??= new Set()).add(id);
      }
    }
    if (ids.size === before && !requeuedInputs.length) return;
    rec.queue.unshift(...requeuedInputs);
    if (ids.size !== before) {
      rec.interruptedMessages = [...ids];
      this.emit(st, { type: 'system.note', savedMessage: true, text: 'Your stopped message and pictures are saved for your next message.' }, turn.turnId);
    }
    if (requeuedInputs.length) this.emit(st, { type: 'system.note', text: 'Queued an unread message again after the CLI interrupted its delivery.' }, turn.turnId);
    this.markDirty(st);
  }

  settleInterruptedMessages(st: ThreadState): void {
    const recovered = st.rt.turn?.recoveredMessages;
    if (!recovered?.length) return;
    st.rec.interruptedMessages = st.rec.interruptedMessages?.filter(id => !recovered.includes(id));
    if (!st.rec.interruptedMessages?.length) delete st.rec.interruptedMessages;
    st.rt.turn!.recoveredMessages = undefined;
    st.rt.turn!.recoveryInput = undefined;
    this.markDirty(st);
  }

  withInterruptedMessages(st: ThreadState, msg: QueuedSend, text: string): UserInput {
    const { rec, rt } = st;
    if (rec.interruptedMessages?.length && !rt.turn?.recoveryInput && !isAutomaticInput(msg) && !fromMike(msg.text, msg) && !this.commandPlan(st, msg.text)) {
      return { id: msg.turnId, text: `${text}\n\n[An earlier turn stopped before a user message was read. That message remains saved for the user's next message. Keep the stopped work paused until the user writes again, even if this message asks to restart it.]`, images: msg.images };
    }
    if (!rec.interruptedMessages?.length || !fromMike(msg.text, msg) || this.commandPlan(st, msg.text) || (rt.turn?.recoveryInput && rt.turn.recoveryInput !== msg.turnId)) return { id: msg.turnId, text, images: msg.images };
    const saved = [...new Set(rec.interruptedMessages)].filter(seq => Number.isSafeInteger(seq) && seq > 0 && seq <= rec.lastSeq).sort((a, b) => a - b).flatMap(seq => this.store.log(rec.id).read(seq, seq)).filter(e => e.type === 'user.message' && fromMike(e.text, e) && !this.commandPlan(st, e.text) && !cutOut(rec, e.seq));
    const images: ImageRef[] = [];
    const parts: string[] = [];
    const append = (words: string, refs: ImageRef[]) => {
      const numbers = refs.map(ref => {
        const file = this.ownPicture(st, ref);
        if (!file) return undefined;
        images.push({ ...ref, path: file });
        return images.length;
      });
      // Give unplaced pictures a marker too, so combining messages doesn't
      // move a later message's picture ahead of the earlier one's words.
      const placed = new Set([...words.matchAll(/\[Picture (\d{1,3})\]/g)].map(m => Number(m[1])));
      const marker = (n: number) => numbers[n - 1] ? `[Picture ${numbers[n - 1]}]` : `[Picture ${n} unavailable]`;
      const unplaced = refs.flatMap((_, i) => placed.has(i + 1) ? [] : [marker(i + 1)]);
      const shifted = words.replace(/\[Picture (\d{1,3})\]/g, (_, n) => marker(Number(n)));
      parts.push([...unplaced, shifted].join('\n'));
    };
    for (const e of saved) if (e.type === 'user.message') append(this.forAgent(e), e.images ?? []);
    if (!saved.length) {
      delete rec.interruptedMessages;
      return { id: msg.turnId, text, images: msg.images };
    }
    parts.push('[Latest message. Follow any corrections or cancellation here over the earlier requests.]');
    append(text, msg.images);
    if (rt.turn) {
      rt.turn.recoveredMessages = saved.map(e => e.seq);
      rt.turn.recoveryInput = msg.turnId;
      const seq = rt.turn.inputs?.get(msg.turnId);
      if (seq !== undefined) {
        const recoveries = rec.messageRecoveries ??= [];
        if (!recoveries.some(r => r.seq === seq)) recoveries.push({ seq, messages: [...rt.turn.recoveredMessages] });
        this.markDirty(st);
      }
    }
    return { id: msg.turnId, text: '[Earlier messages stopped before a reply. Answer them along with the latest message below.]\n\n' + parts.join('\n\n'), images };
  }

  // The input with only the thread's own pictures (ownPicture), at their
  // real paths. Each [Picture N] in the words follows its picture to its new
  // number, or says "[Picture N unavailable]" for one left out, as the
  // interrupted-messages merge does; a list that isn't one is none. The same
  // input back when nothing changed.
  ownInput<T extends { text: string; images: ImageRef[] }>(st: ThreadState, input: T): T {
    const refs: unknown[] = Array.isArray(input.images) ? input.images : [];
    const numbers: (number | undefined)[] = [];
    const images: ImageRef[] = [];
    for (const ref of refs) {
      const file = this.ownPicture(st, ref as ImageRef);
      if (file) images.push({ ...(ref as ImageRef), path: file });
      numbers.push(file ? images.length : undefined);
    }
    const same = Array.isArray(input.images) && images.length === refs.length && images.every((img, i) => img.path === (refs[i] as ImageRef).path);
    if (same) return input;
    if (images.length !== refs.length) this.log.warn('left out pictures that are not the thread\'s own', { threadId: st.rec.id, left: refs.length - images.length });
    const text = keepPictureMarkers(input.text, numbers.map(Boolean));
    return { ...input, text, images };
  }

  // A picture's real path if it's this thread's own, else undefined: a
  // regular file (not a link) directly in its media folder, where a sent
  // message's pictures are copied, or in a review's reply folder there,
  // where a review answer's are (runner/reviews.ts keepReplyImages).
  ownPicture(st: ThreadState, ref: ImageRef): string | undefined {
    if (!ref || typeof ref !== 'object' || typeof ref.path !== 'string') return undefined;
    try {
      const media = fs.realpathSync(this.store.mediaDir(st.rec.id));
      if (fs.lstatSync(ref.path).isSymbolicLink()) return undefined;
      const file = fs.realpathSync(ref.path);
      if (!fs.statSync(file).isFile()) return undefined;
      const dir = path.dirname(file);
      if (dir === media) return file;
      const reply = path.relative(media, dir).split(path.sep);
      return reply.length === 3 && reply[0] === 'reviews' && /^[A-Za-z0-9_-]{1,100}$/.test(reply[1]) && reply[2] === 'reply' ? file : undefined;
    } catch {
      return undefined;
    }
  }

  // Takes back a queued message that hasn't started: the runner's own,
  // gone stale before its turn came (fix-update.ts). Whether it was there.
  unqueue(threadId: string, turnId: string): boolean {
    const st = this.threads.get(threadId);
    const i = st?.rec.queue.findIndex((q) => q.turnId === turnId) ?? -1;
    if (!st || i < 0) return false;
    st.rec.queue.splice(i, 1);
    this.markDirty(st);
    return true;
  }

  // Takes back a deleted schedule's messages still waiting for the thread,
  // each with a receipt so a retry or an old runner doesn't send it again.
  // A thread busy in a long turn otherwise got every tick's copy after
  // delete_schedule said Deleted (ae88bd2c, 20 Nov). How many it dropped.
  dropScheduled(threadId: string, scheduleId: string): number {
    // Remembered first, so a receipt that fails now is dropped again before
    // its turn would start (wasScheduleDeleted), on a draining runner too,
    // whose own scheduler has stopped.
    this.droppedSchedules.add(scheduleId);
    const st = this.threads.get(threadId);
    if (!st || st.rt.deleted) return 0;
    const gone = st.rec.queue.filter((q) => isReminder(q) && q.scheduleId === scheduleId);
    if (!gone.length) return 0;
    // Each receipt is on disk before its message leaves the queue: one that
    // can't be written (disk full) leaves the rest queued, and the error
    // goes to the caller.
    const receipted = new Set<QueuedSend>();
    try {
      for (const q of gone) {
        // One already receipted or started (put back after a failed start)
        // needs no second note.
        const known = this.scheduledMessage(st, q.turnId, q.scheduledSince ?? 0);
        if (!known?.superseded && !known?.started) this.emit(st, { type: 'system.note', text: DELETED_REMINDER, supersededReminder: q.turnId }, st.rt.turn?.turnId);
        receipted.add(q);
      }
    } finally {
      if (receipted.size) {
        st.rec.queue = st.rec.queue.filter((q) => !receipted.has(q));
        this.markDirty(st);
      }
    }
    return receipted.size;
  }

  // A saved user message must be answered before automatic redelivery.
  // This queue remains durable while its idle CLI may be released.
  queueHeld(st: ThreadState): boolean {
    return Boolean(st.rec.interruptedMessages?.length && st.rec.queue.length && st.rec.queue.every(isAutomaticInput));
  }

  // Starts the next queued message if nothing is running. Returns true if
  // one started. One that can't be written (disk full) stays at the front.
  kickQueue(st: ThreadState): boolean {
    if (this.stopping || st.rt.editing || st.rt.moving || st.rt.holds?.size) return false;
    // A paused, stopping or turned-off coordinator (or its helper) keeps
    // its queue: popping a message only to fail it at dispatch lost helper
    // reports on a pause or handover (Gemini's review, 26 Nov 2026). Resume
    // and turning coordinators back on kick it again.
    if (this.coordinators?.dispatchRefusal(st.rec.id)) return false;
    // A paused run may have left updates queued behind its old turn. A
    // later explicit resume supplies its own brief. The restart recap is
    // restored separately from the coordinator's registry.
    const queue = st.rec.queue.filter((msg) => !msg.helperRunId || this.coordinators?.helperRunActive(st.rec.id, msg.helperRunId));
    if (queue.length !== st.rec.queue.length) {
      st.rec.queue = queue;
      this.markDirty(st);
    }
    try {
      this.prepareQueue(st);
    } catch (e) {
      // Keep the queue intact and let other threads' wake/idle handling
      // continue even when a receipt cannot be saved (e.g. a full disk).
      this.log.error('could not prepare queued messages', { threadId: st.rec.id, error: String(e) });
      return false;
    }
    if (st.rt.turn) return false;
    if (st.rec.queue.length === 0) {
      this.settleHelperPending(st);
      return false;
    }
    // A draining runner hands a thread over with its queue rather than
    // start another turn on the old release; the primary starts it. Not if
    // background work is holding the thread here: that can be half an hour
    // for a shell and hours for a subagent, with the message sitting unread
    // and its card still open (Mike's "Done" on 1 Nov waited behind a
    // 20-minute watcher). Its CLI is alive, so it answers now, and the
    // thread moves across once the turn and the work are over.
    const d = this.draining;
    if (d && (st.rt.tasks.length === 0 || d.going.has(st.rec.id))) {
      this.queueHandoverCheck();
      return false;
    }
    // A saved user cancellation must be read before automatic work resumes.
    if (isAutomaticInput(st.rec.queue[0]) && st.rec.interruptedMessages?.length) return false;
    // Onto the live CLI: first a look at the folder's Claude Code settings,
    // on the trust worker, with no turn open meanwhile. It comes back here.
    let live: LiveLook | undefined;
    if (this.needsPreLook(st)) {
      const pre = st.rt.preLook;
      if (pre && !pre.looks && pre.failed === undefined) return false;
      st.rt.preLook = undefined;
      // One taken for another message (that one was taken off the queue),
      // folder or kind of thread looks again, failed or not.
      if (!pre || !this.preLookFits(st, pre) || (pre.looks && !looksCover(pre.looks, st.rec, false))) {
        this.startPreLook(st);
        return false;
      }
      live = pre.failed !== undefined ? { failed: pre.failed } : pre.looks;
    }
    const next = st.rec.queue.shift()!;
    this.markDirty(st);
    // Raised since it was queued above what wrote it (runner/ceiling.ts):
    // held back, and the next one looked at instead.
    if (next.ceiling === undefined) {
      const legacy = this.legacyCeiling(next);
      if (legacy !== undefined) next.ceiling = legacy;
    }
    if (!this.underCeiling(st, next.ceiling)) {
      this.withholdMessage(st, next);
      return this.kickQueue(st);
    }
    try {
      this.startTurn(st, next, live);
      return true;
    } catch (e) {
      st.rec.queue.unshift(next);
      this.log.error('could not start a queued message', { threadId: st.rec.id, error: String(e) });
      this.notice('error', `Couldn't start a message in "${st.rec.title}": ${(e as Error).message}`);
      return false;
    }
  }

  // A schedule's ceiling (set by main.ts from the scheduler), for a reminder
  // queued before ceilings (runner/ceiling.ts, legacyCeiling).
  scheduleCeiling?: (scheduleId: string) => PermissionMode | undefined;

  // Whether a schedule has been deleted (set by main.ts from the scheduler).
  // Its reminders still queued are dropped before any turn starts, however
  // they got here: a handover adopting a queue, a retry after a lost reply,
  // a receipt that couldn't be written the first time (ae88bd2c, 20 Nov).
  scheduleDeleted?: (scheduleId: string) => boolean;
  private droppedSchedules = new Set<string>();
  private wasScheduleDeleted(scheduleId: string): boolean {
    return this.droppedSchedules.has(scheduleId) || Boolean(this.scheduleDeleted?.(scheduleId));
  }

  // Repair queues saved by older releases as well as direct queued sends.
  // Keep ordinary messages in order ahead of reminders, and only the latest
  // reminder for each schedule. Write receipts before removing anything:
  // an old runner can have sent the slot without its primary hearing back.
  prepareQueue(st: ThreadState): void {
    const queue = st.rec.queue;
    const receipted = new Set(queue.filter(q => isReminder(q) && this.scheduledDelivery(st, q.turnId, q.scheduledSince ?? 0)?.superseded));
    const seen = new Set<string>();
    const seenText = new Set<string>();
    const superseded = new Set<QueuedSend>();
    const deleted = new Set(queue.filter(q => isReminder(q) && !receipted.has(q) && q.scheduleId && this.wasScheduleDeleted(q.scheduleId)));
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i];
      // Check output may contain new items already removed from the check's
      // storage when it was sent. Old queues have no separate check flag,
      // so preserve every reminder bearing the standard output suffix.
      if (receipted.has(q) || deleted.has(q) || !isReminder(q) || !q.scheduleId || typeof q.text !== 'string') continue;
      // A check that keeps printing the same thing while the thread is busy
      // queued one copy per tick, each delivered as its own turn (ae88bd2c,
      // 20 Nov): the same words twice say nothing new, so the newest stays.
      if (q.preserveSchedule ?? hasCheckOutput(q.text)) {
        const same = `${q.scheduleId}\n${q.text}`;
        if (seenText.has(same)) superseded.add(q);
        seenText.add(same);
        continue;
      }
      if (seen.has(q.scheduleId)) superseded.add(q);
      seen.add(q.scheduleId);
    }
    for (const q of superseded) {
      if (!this.scheduledMessage(st, q.turnId, q.scheduledSince ?? 0)?.started) {
        this.emit(st, { type: 'system.note', text: SUPERSEDED_REMINDER, supersededReminder: q.turnId }, st.rt.turn?.turnId);
      }
    }
    for (const q of deleted) {
      if (!this.scheduledMessage(st, q.turnId, q.scheduledSince ?? 0)?.started) {
        this.emit(st, { type: 'system.note', text: DELETED_REMINDER, supersededReminder: q.turnId }, st.rt.turn?.turnId);
      }
    }
    const ordered = [
      ...queue.filter(q => !isAutomaticInput(q)),
      ...queue.filter(q => isAutomaticInput(q) && !superseded.has(q) && !receipted.has(q) && !deleted.has(q)),
    ];
    if (ordered.length === queue.length && ordered.every((q, i) => q === queue[i])) return;
    st.rec.queue = ordered;
    this.markDirty(st);
  }

  // ------------------------------------------------------ editing a message

  // ---------------------------------------------------------- design reviews

  // ---------------------------------------------------------------- events

  emit(st: ThreadState, body: EventBody, turnId?: string): PersistedEvent {
    if (st.rt.deleted) throw new Error('The thread was deleted.');
    this.flushDeltas(st);
    const log = this.store.log(st.rec.id);
    if (body.type === 'turn.completed' && body.outcome === 'completed' && this.coordinators) {
      const pending = body.needs === 'you' ? body.asks ?? [] : [];
      const { asks, carriedAsks } = this.coordinators.finishAsks(st.rec.id, pending, log.lastSeq + 1);
      if (asks.length) {
        body.asks = asks;
        if (body.needs !== 'you') {
          body.needs = 'you';
          delete body.next;
          delete body.nextPick;
          delete body.nextSuggested;
        }
        if (carriedAsks) body.carriedAsks = carriedAsks;
      } else if (pending.length) {
        delete body.asks;
        body.needs = 'nothing';
      }
    }
    const event = { seq: log.lastSeq + 1, ts: this.isoNow(), threadId: st.rec.id, ...(turnId ? { turnId } : {}), ...body } as PersistedEvent;
    log.append(event);
    st.rec.lastSeq = event.seq;
    st.rec.updatedAt = event.ts;
    if (body.type === 'user.message') {
      const asked = askedLine(body, st.rec.reviews);
      if (asked) st.rec.asked = asked;
    }
    this.markDirty(st);
    this.ciRunsEvent(st, body);
    if (!st.rec.coordinatorHelperFor) this.notify({ method: 'thread.event', params: { threadId: st.rec.id, event } });
    return event;
  }

  addDelta(st: ThreadState, d: DeltaBody): void {
    const { rt } = st;
    if (d.type !== 'tool.output.delta') {
      const type = d.type === 'assistant.text.delta' ? 'assistant.text' : 'reasoning';
      const item = rt.inProgress.get(d.itemId) ?? { itemId: d.itemId, type, text: '' };
      item.text += d.text;
      rt.inProgress.set(d.itemId, item);
    }
    const pending = rt.pendingDeltas.get(d.itemId);
    if (pending) pending.text += d.text;
    else rt.pendingDeltas.set(d.itemId, { type: d.type, text: d.text });
    rt.deltaTimer ??= this.clock.setTimeout(() => {
      rt.deltaTimer = undefined;
      this.flushDeltas(st);
    }, DELTA_INTERVAL_MS);
  }

  // Sends coalesced deltas. Transient events carry the seq of the last
  // persisted event and don't consume a number.
  flushDeltas(st: ThreadState): void {
    const { rt, rec } = st;
    rt.deltaTimer?.cancel();
    rt.deltaTimer = undefined;
    if (rt.pendingDeltas.size === 0) return;
    const seq = this.store.log(rec.id).lastSeq;
    const ts = this.isoNow();
    for (const [itemId, d] of rt.pendingDeltas) {
      const event = { seq, ts, threadId: rec.id, ...(rt.turn ? { turnId: rt.turn.turnId } : {}), type: d.type, itemId, text: d.text } as AnyEvent;
      if (!rec.coordinatorHelperFor) this.notify({ method: 'thread.event', params: { threadId: rec.id, event } });
    }
    rt.pendingDeltas.clear();
  }

  // --------------------------------------------------------------- helpers

  // A sub-agent started or changed (AdapterOutput 'subagent').
  updateSubagent(st: ThreadState, u: SubagentUpdate): void {
    const { rec } = st;
    const list = (rec.subagents ??= []);
    let a = list.find((x) => x.id === u.id);
    if (!a) {
      // An update for one the list doesn't have (a resumed CLI reporting a
      // sub-agent from before) still gets a row.
      a = { id: u.id, description: '', status: 'running', background: false, startedAt: this.isoNow(), accountId: rec.accountId, cwd: rec.cwd };
      if (rec.nativeSessionId) a.sessionId = rec.nativeSessionId;
      list.push(a);
      // Keep the newest SUBAGENTS_KEPT, dropping finished ones first.
      while (list.length > SUBAGENTS_KEPT) {
        const i = list.findIndex((x) => x.status !== 'running');
        list.splice(i >= 0 ? i : 0, 1);
      }
    }
    if (u.itemId) a.itemId = u.itemId;
    if (u.parentId) a.parentId = u.parentId;
    if (u.description) a.description = u.description;
    if (u.agentType) a.agentType = u.agentType;
    if (u.model) a.model = u.model;
    if (u.background) a.background = true;
    if (u.toolUses !== undefined) a.toolUses = u.toolUses;
    if (u.summary) a.summary = u.summary;
    if (u.status) {
      if (u.status !== 'running' && a.status === 'running') a.endedAt = this.isoNow();
      a.status = u.status;
    }
    if (a.status !== 'running') delete a.activity;
    else if (u.activity) a.activity = u.activity;
    this.markDirty(st);
  }

  // Marks running sub-agents stopped when their CLI or the runner goes away.
  stopSubagents(st: ThreadState, { keepCoordinatorHelpers = false } = {}): void {
    let any = false;
    for (const a of st.rec.subagents ?? []) {
      if (a.status !== 'running') continue;
      if (keepCoordinatorHelpers && a.itemId && this.threads.get(a.id)?.rec.coordinatorHelperFor === st.rec.id &&
          this.coordinators?.helperRunActive(a.id, a.itemId)) continue;
      a.status = 'stopped';
      a.endedAt = this.isoNow();
      delete a.activity;
      any = true;
    }
    if (any) this.markDirty(st);
  }

  markDirty(st: ThreadState): void {
    if (st.rt.deleted) return;
    st.rt.saveRetry = false;
    this.dirty.add(st.rec.id);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.defer(() => this.flush());
  }

  // Saves changed thread.json files and sends thread.updated for them.
  // One that fails stays dirty and is tried again in a moment, rather than
  // waiting for the thread's next change (THREADBEAR-9: a new runner's
  // start once swept away a draining runner's temp file mid-save).
  flush(): void {
    this.flushScheduled = false;
    this.saveRetryTimer?.cancel();
    this.saveRetryTimer = undefined;
    const ids = [...this.dirty];
    this.dirty.clear();
    let failed = false;
    for (const id of ids) {
      const st = this.threads.get(id);
      if (!st) continue;
      const retry = st.rt.saveRetry;
      try {
        this.store.save(st.rec);
        st.rt.saveFailed = false;
        st.rt.saveRetry = false;
      } catch (e) {
        this.dirty.add(id);
        failed = true;
        st.rt.saveRetry = true;
        // Said once until it saves, as it reaches Sentry.
        if (!st.rt.saveFailed) this.log.error('could not save thread', { threadId: id, error: String(e) });
        st.rt.saveFailed = true;
        // A retry with nothing new: the app already has this summary.
        if (retry) continue;
      }
      // One thread whose summary can't be made (a record another runner
      // wrote wrong) doesn't stop the others' saves and news.
      let thread: ThreadSummary;
      try {
        thread = this.summary(st);
      } catch (e) {
        this.log.error("couldn't make a thread's summary", { threadId: id, error: String(e) });
        continue;
      }
      if (!st.rec.coordinatorHelperFor) this.notify({ method: 'thread.updated', params: { thread } });
    }
    if (failed && !this.stopping) this.saveRetryTimer = this.clock.setTimeout(() => this.flush(), SAVE_RETRY_MS);
  }

  summary(st: ThreadState): ThreadSummary {
    const { rec, rt } = st;
    const running = rec.status === 'running' || rec.status === 'starting';
    const background = this.background(st);
    // Not finished yet, as far as Mike's concerned: no dot, notification or
    // phone push until they're done and the agent has had its say on them.
    // Asks the agent said wait for its shell jobs count them too.
    const afterJobs = this.asksHeld(st);
    const card = rec.needs?.seq === rec.lastTurnCompletedSeq ? rec.needs : undefined;
    const unfinished = running || this.awaitingShells(st, Boolean(card)) || (this.coordinators?.forThread(rec.id) ? afterJobs : agentsStillWorking(background, afterJobs));
    const asks = card?.asks;
    const active = card && asks && this.coordinators?.activeAsks(rec.id, asks, card.seq);
    const cleared = Boolean(asks?.length && active?.length === 0);
    const pendingReviews = rec.reviews?.filter((review) => review.status === 'pending' && this.coordinators?.reviewAskVisible(rec.id, review.id) !== false);
    // A coordinator can do background work while the same decision is open.
    // Keep that attention signal steady instead of retracting and pushing it again.
    const backgroundDecision = Boolean(active?.length && this.activeCoordinator(rec.id) && rt.turn && !rt.turn.byMike && !rt.turn.fromCoordinatorTasks && !rt.turn.local && !afterJobs);
    const priorReview = backgroundDecision && pendingReviews?.some((review) => active?.some((ask) => ask.links?.some(({ url }) => url === `review:${review.id}`)));
    const attentionSeq = card?.carriedFrom ?? rec.lastTurnCompletedSeq;
    const s: ThreadSummary = {
      id: rec.id,
      title: rec.title,
      cwd: rec.cwd,
      accountId: rec.accountId,
      provider: rec.provider,
      permissionMode: rec.permissionMode,
      status: rec.status,
      live: Boolean(rt.session),
      // A finished turn that said it needs nothing isn't waiting on Mike
      // (docs/protocol/needs-you.md, "Needs you"). A pending design review only
      // counts once the turn ends: show_options doesn't block, and Mike
      // didn't want a "Needs you" (or a phone push) mid-turn.
      needsYou: (!unfinished && Boolean(pendingReviews?.length)) || Boolean(priorReview) || rec.status === 'waiting' || Boolean(rec.forceUnread) || this.quietWakeShows(rec) || ((!unfinished || backgroundDecision) && attentionSeq > rec.lastSeenSeq && !cleared && !this.saidNothing(rec)),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      lastActivityAt: rec.lastActivityAt,
      preview: rec.preview,
      lastSeq: rec.lastSeq,
      lastSeenSeq: rec.lastSeenSeq,
    };
    const coordinatorProjectId = this.coordinators?.projectForThread(rec.id);
    if (coordinatorProjectId) s.coordinatorProjectId = coordinatorProjectId;
    if (rec.poolId) s.poolId = rec.poolId;
    if (rec.waitingForRoom) s.waitingForRoom = { ...rec.waitingForRoom };
    if (rec.carryOnAtReset === false) s.carryOnAtReset = false;
    if (rec.waitingForNetwork) s.waitingForNetwork = { since: rec.waitingForNetwork.since };
    if (card) {
      s.needs = cleared ? 'nothing' : card.needs;
      if (afterJobs && !cleared) s.asksAfterJobs = true;
      if (asks && !cleared) {
        const ticked = new Set([...(card.ticked ?? []), ...(card.resolved ?? [])]);
        s.asks = asks.map((a, i) => (ticked.has(i) || (active && !active.includes(a)) ? { ...a, ticked: true as const } : a));
        s.asksSeq = card.seq;
      }
    }
    if (pendingReviews?.length) s.pendingReviews = pendingReviews.length;
    if (rec.model) s.model = rec.model;
    if (rec.effort) s.effort = rec.effort;
    if (rec.modelInUse) s.modelInUse = rec.modelInUse;
    if (rec.effortInUse) s.effortInUse = rec.effortInUse;
    if (rec.snoozedUntil) s.snoozedUntil = rec.snoozedUntil;
    if (rec.snoozedUntilRestart) s.snoozedUntilRestart = true;
    if (rec.snoozedUntilRestart && rec.untilRelease) s.snoozedUntilRelease = true;
    if (rec.wakeWhen && rec.snoozedUntil) {
      // `agent`: the thread's own agent set it (WakeWhen.by), not Mike.
      const { by, ...wakeWhen } = rec.wakeWhen;
      s.wakeWhen = { ...wakeWhen, ...(by === 'agent' ? { agent: true as const } : {}) };
    }
    if (rec.waitingOn && rec.snoozedUntil) s.waitingOn = rec.waitingOn.map((w) => ({ threadId: w.threadId, title: w.title, ...(w.until ? { until: w.until } : {}), ...(w.done ? { done: true as const } : {}) }));
    // Only while something still listens for the restart: one archived when
    // it came isn't told, and its watch is spent (Codex's review, 19 Nov).
    if (rec.hibernatedForApp && rec.snoozedUntil && this.awaitingAppRestart?.(rec.id)) s.awaitingAppRestart = true;
    if (rec.waitingOnRuns && rec.snoozedUntil) s.awaitingRuns = true;
    // Any thread waiting on the app, hibernating or not: the Updates panel
    // lists them with whether the build on its way has their commit.
    const appWant = rec.archivedAt ? undefined : this.appRestartWant?.(rec.id);
    if (appWant) s.awaitingApp = appWant;
    if (rec.woke && (rec.forceUnread || this.quietWakeShows(rec))) s.woke = { ...rec.woke };
    if (rec.archivedAt) {
      s.archivedAt = rec.archivedAt;
      // Archived before who did it was kept: nobody can say.
      if (rec.archivedBy) s.archivedBy = rec.archivedBy;
      if (rec.archiveVerdict) s.archiveVerdict = rec.archiveVerdict;
      if (rec.quietlyArchived && rec.archivedBy === 'threadbear') s.quietlyArchived = { at: rec.quietlyArchived.at, why: rec.quietlyArchived.why };
    }
    if (rec.starredAt) s.starredAt = rec.starredAt;
    if (rec.nativeSessionId && rec.sessionUsed) s.nativeSessionId = rec.nativeSessionId;
    if (rec.contextTokens !== undefined) s.contextTokens = rec.contextTokens;
    if (rec.sample) s.sample = true;
    if (rec.contextWindow !== undefined) s.contextWindow = rec.contextWindow;
    if (rec.costUsd !== undefined) s.costUsd = rec.costUsd;
    const set = this.patchSet(st);
    const actions = this.actionsOf(st, set);
    const patches = this.worktreeAction(rec) ? [...set.patches, { id: 'worktree', source: 'builtin' as const }] : set.patches;
    if (set.panels.length) s.panels = withThreadId(set.panels, rec.id);
    if (actions.length) s.actions = actions;
    if (set.hooks.length) s.hooks = set.hooks;
    if (patches.length) s.patches = patches;
    if (background.length) s.background = background;
    if (rec.subagents?.length) s.subagents = rec.subagents.map(publicSubagent);
    const projects = this.projects?.threadProjects(rec);
    if (projects) s.projects = projects;
    if (rec.highlightsAt) s.highlightsAt = rec.highlightsAt;
    if (rec.worktree && !rec.worktree.removedAt) {
      s.worktree = { branch: rec.worktree.branch, mainCheckout: rec.worktree.mainCheckout, path: rec.worktree.path };
    }
    if (rec.schedule) s.schedule = { ...rec.schedule };
    if (rec.startedBy) s.startedBy = { ...rec.startedBy };
    if (rec.detached) s.detached = true;
    if (rec.asked) s.asked = rec.asked;
    if (rec.keywords) s.keywords = rec.keywords;
    if (rec.panelRequest) s.panelRequest = { ...rec.panelRequest };
    // A record from 28 Oct may say "people" (sharing with specific people,
    // since dropped): that's not shared.
    if (rec.share) s.share = { access: rec.share.access === 'link' ? 'link' : 'off', slug: rec.share.slug, updatedAt: rec.share.updatedAt };
    // Only for the card it was checked for: a new turn's card waits for its own.
    if (rec.looseEnds && this.looseEndsCard(st) === rec.looseEnds.seq) s.looseEnds = { seq: rec.looseEnds.seq, ends: rec.looseEnds.ends.map((e) => ({ ...e })), at: rec.looseEnds.at };
    if (rt.moving) s.moving = { ...rt.moving };
    // What it's waiting on, worked out once here for every app
    // (docs/protocol/needs-you.md, "Wait state").
    const state = this.waitState(st, s);
    // Info, not a warning (which reaches Sentry): summaries are made a batch
    // at a time, so a quick turn can skip a step the table lists.
    if (rt.waitState && !waitMoveAllowed(rt.waitState, state)) this.log.info('wait state moved where the table has no move', { threadId: rec.id, from: rt.waitState, to: state });
    // Under Hibernating for a schedule, or back out when it's gone: said
    // in the thread, as nothing else there would (place-notes.ts). Not on
    // the first summary after a start, which has no state to move from.
    if (rt.waitState && rt.waitState !== state && (state === 'scheduled' || (rt.waitState === 'scheduled' && (state === 'done' || state === 'needsYou')))) {
      queueMicrotask(() => this.sayScheduled(st, state === 'scheduled'));
    }
    // Not kept until the schedules are in (main.ts sets schedulesFor just
    // after the threads load): a summary made before then has a scheduled
    // thread as done, so the next one would say it moved under Hibernating,
    // once per restart (Earshot thread, 24 Nov 2026: four lines in a row,
    // one per self-update).
    if (this.schedulesFor) rt.waitState = state;
    s.waitState = state;
    return s;
  }

  // ------------------------------------------------------------ highlights

  // ------------------------------------------------------- showing panels

  // Whether anyone with the link can read the thread on the website
  // (docs/protocol/runners.md, "Sharing"). The mirror carries it to Convex, which
  // serves the link. The slug stays when sharing goes off, so sharing
  // again brings the same link back, as a doc's sharing does; newLink
  // makes a fresh one, which stops the old link for good.
  share(threadId: string, args: { access: ShareAccess; newLink?: boolean }): { thread: ThreadSummary } {
    const st = this.mustGet(threadId);
    if (args.access !== 'off' && args.access !== 'link') throw new RpcError(ErrorCode.badParams, 'access is "off" or "link"');
    const slug = !st.rec.share || args.newLink ? crypto.randomBytes(16).toString('base64url') : st.rec.share.slug;
    st.rec.share = { access: args.access, slug, updatedAt: this.isoNow() };
    this.markDirty(st);
    return { thread: this.summary(st) };
  }


  // A thread by full id or unique prefix, for titles; undefined if unclear.
  findThread(q: string): ThreadSummary | undefined {
    const exact = this.threads.get(q);
    if (exact) return this.summary(exact);
    const hits = [...this.threads.values()].filter((t) => t.rec.id.startsWith(q));
    return hits.length === 1 ? this.summary(hits[0]) : undefined;
  }

  // The most access a thread's agent has now: its mode, or more while a
  // turn that started with (or was raised to) more is still running.
  // threadbear-mcp.ts, "Raising access", goes by it for messages.
  accessOf(threadId: string): PermissionMode {
    const { rec, rt } = this.mustGet(threadId);
    return moreAccess(rt.turn?.access, rec.permissionMode);
  }

  // A mutation carries the caller's authority, or the access approved on
  // its card, to the final sink across a handover. Never from mirror data.
  private checkControlCeiling(threadId: string, ceiling?: PermissionMode): void {
    if (ceiling !== undefined && raises(this.accessOf(threadId), ceiling)) throw new RpcError(ErrorCode.notAllowed, 'This thread has more access now. Use update_thread or interrupt_thread to ask for this exact change.');
  }

  // Why a thread can't start, from the sandboxed-threads experiment taken
  // out on 16 Nov 2026, or undefined. One that ran shut in a container
  // (ThreadRecord.confined), or one in a folder runner.json's old
  // `sandbox` still names, would now run on the machine itself, which its
  // owner didn't choose: it waits for them to say so, by moving it or
  // taking the key out of runner.json.
  retiredSandbox(cwd: string, rec?: ThreadRecord): string | undefined {
    if (rec?.confined) return `This thread ran in a sandbox, which Threadbear no longer has, so it wasn't started. To run it on this machine, start a new thread in ${cwd}${this.inRetiredSandbox(cwd) ? " after taking `sandbox` out of runner.json" : ''}.`;
    if (this.inRetiredSandbox(cwd)) return `${cwd} is in a folder runner.json's \`sandbox\` names, and Threadbear no longer has a sandbox, so it wasn't started here. Take \`sandbox\` out of runner.json to run threads there on this machine.`;
    return undefined;
  }

  private inRetiredSandbox(cwd: string): boolean {
    const folders = this.cfg.retiredSandboxFolders;
    if (!folders?.length) return false;
    const real = (p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    const at = real(cwd);
    return folders.some((f) => {
      const rel = path.relative(real(f), at);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
  }

  mustGet(threadId: string): ThreadState {
    const st = typeof threadId === 'string' ? this.threads.get(threadId) : undefined;
    if (!st) {
      // Let go by this draining runner, which still answers on the runner's
      // port until its drain port is up (main.ts handOver), a few seconds:
      // the new runner has it in a moment. The Mac app tries again there on
      // these words (AppModel.turnedAwayByRestart); Mike saw "Thread not
      // found" picking an effort in that gap (7 Nov).
      if (this.draining?.gone.has(threadId)) throw new RpcError(ErrorCode.busy, 'The runner is handing over to a new one; try again in a moment.');
      throw new RpcError(ErrorCode.threadNotFound, `Thread not found: ${threadId}`);
    }
    return st;
  }

  // What a starting session is told about the thread's projects. Only a
  // fresh session: Claude Code keeps a resumed session's system prompt and
  // ignores an appended one, so a resume hears through projectNews.
  briefFor(rec: ThreadRecord, resume: boolean): { instructions?: string } {
    if (resume) return {};
    const parts: string[] = [];
    // Mike's own standing instructions first: they're for everything.
    const standing = this.standingInstructions?.().trim() ?? '';
    if (standing) {
      rec.instructionsTold = instructionsHash(standing);
      parts.push(standingText(standing));
    } else if (rec.instructionsTold !== undefined) {
      // Not forgotten: a session id already in use goes back to the session
      // that held them (below, inUse). With none ever, nothing's written.
      rec.instructionsTold = INSTRUCTIONS_CLEARED;
    }
    if (this.projects) {
      rec.projectsTold = this.projects.briefIds(rec);
      const brief = this.projects.brief(rec);
      if (brief) parts.push(brief);
    }
    // Where its worktree is and how its work gets to main.
    if (rec.worktree && !rec.worktree.removedAt) parts.push(worktreeInstructions(rec.worktree));
    return parts.length ? { instructions: parts.join('\n\n') } : {};
  }

  // Mike's standing instructions, when they've changed since the session
  // last heard them (or it never has): a resumed Claude session keeps its
  // first system prompt, so the change comes before his next message.
  instructionsNews(rec: ThreadRecord): string | undefined {
    if (!this.standingInstructions) return undefined;
    const standing = this.standingInstructions().trim();
    const before = rec.instructionsTold;
    if (!standing) {
      // Nothing written while it never held any: with the experiment off a
      // thread record doesn't change at all.
      if (before === undefined || before === INSTRUCTIONS_CLEARED) return undefined;
      rec.instructionsTold = INSTRUCTIONS_CLEARED;
      return 'Note from Threadbear: the user cleared their standing instructions; earlier ones no longer apply.';
    }
    const hash = instructionsHash(standing);
    if (before === hash) return undefined;
    rec.instructionsTold = hash;
    return `Note from Threadbear: the user's standing instructions${before === undefined || before === INSTRUCTIONS_CLEARED ? '' : ' have changed, and replace any earlier ones'}.\n\n${standingText(standing)}`;
  }

  // A press of one of the thread's reply buttons, for its agent. The Daily
  // brief, 8 Nov 2026: Mike pressed RSVP yes, then said go ahead in his
  // reply, and the agent, which hadn't seen the press, sent the same job
  // again with send_message. The line is made now, with what was sent, as
  // the button itself can be gone by the time it's told.
  notePress(rec: ThreadRecord, b: ReplyButton): void {
    if (!b.pressed) return;
    const brief = (b.send?.text ?? b.start?.text ?? '').replace(/\s+/g, ' ').trim();
    const where = b.send ? `messaged "${b.send.threadTitle}"` : 'started a thread';
    const line = `- "${b.title}" ${where} (${b.pressed.threadId.slice(0, 8)}): ${brief.length > 200 ? `${brief.slice(0, 200)}...` : brief}`;
    const list = (rec.presses ?? []).filter((p) => p.id !== b.id);
    list.push({ id: b.id, line });
    // Bounded: of the ones a completed turn heard, the last MAX_PRESS_NOTES
    // are kept for an edit or a fresh session. Untold and in-flight ones all
    // stay (Codex's third look); each is a press of a different button, and
    // a thread keeps at most MAX_BUTTONS.
    const settled = list.filter((p) => p.told && !p.told.inFlight);
    const pending = list.filter((p) => !p.told || p.told.inFlight);
    rec.presses = [...settled.slice(-MAX_PRESS_NOTES), ...pending.slice(-MAX_BUTTONS)];
  }

  pressNewsText(lines: string[]): string {
    const one = lines.length === 1;
    return `Note from Threadbear: the user pressed ${one ? 'this button' : 'these buttons'} in your reply, so ${one ? 'that job has' : 'those jobs have'} already been sent and ${one ? 'is' : 'are'} done or under way. Don't send ${one ? 'it' : 'them'} again; if the user now asks for something different from what a button sent, do only the difference.\n${lines.join('\n')}`;
  }

  // The presses its agent hasn't heard of, as a line to go before the
  // message being sent now, marked as told by that message.
  takePressNews(st: ThreadState): string | undefined {
    const untold = st.rec.presses?.filter((p) => !p.told) ?? [];
    if (!untold.length) return undefined;
    const seq = this.store.log(st.rec.id).lastSeq;
    for (const p of untold) p.told = { seq, inFlight: true };
    this.markDirty(st);
    return this.pressNewsText(untold.map((p) => p.line));
  }

  // Why the thread last woke at a wait's latest time (runner/hibernation.ts,
  // wakeAtTime), if its agent hasn't heard: a line to go before the message
  // being sent now, marked as told by it, as a press is.
  // `messageId`: the message being sent, which may be the check itself.
  takeWakeNews(st: ThreadState, messageId: string | undefined): string | undefined {
    const { rec, rt } = st;
    const news = rec.wakeNews;
    if (!news) return undefined;
    let end = '';
    let deferred = false;
    if (news.check) {
      // The check itself, or a message into the turn it runs in: it says it all.
      if (news.check === messageId || rt.turn?.inputs?.has(news.check)) return undefined;
      deferred = rec.queue.some((q) => q.turnId === news.check);
      // Told the check was coming, and it has gone without running (it
      // failed before the CLI, a restart dropped it): told again, to check
      // now (Codex's second review, 22 Nov 2026).
      if (news.told?.deferred && !news.told.inFlight && !deferred) delete news.told;
      end = ` ${deferred ? LATE_CHECK_QUEUED : LATE_CHECK_LOST}`;
    }
    if (news.told) {
      if (this.wakeNewsStale(rec)) {
        delete rec.wakeNews;
        this.markDirty(st);
      }
      return undefined;
    }
    news.told = { seq: this.store.log(rec.id).lastSeq, inFlight: true, ...(deferred ? { deferred: true as const } : {}) };
    this.markDirty(st);
    return `${this.wakeNewsText(st, news)}${end}`;
  }

  // The same, told in the turn now going or at all, for a session that
  // replays its first message.
  toldWakeNews(rec: ThreadRecord, which: 'turn' | 'all'): string | undefined {
    const news = rec.wakeNews;
    const told = news?.told;
    if (!news || !told || this.wakeNewsStale(rec)) return undefined;
    if (which !== 'all' && !told.inFlight) return undefined;
    // As it was told: with how a check's news ended.
    const text = this.wakeNewsText(this.mustGet(rec.id), news);
    return news.check ? `${text} ${told.deferred ? LATE_CHECK_QUEUED : LATE_CHECK_LOST}` : text;
  }

  // The news as its agent may be told it: without its own snooze words if
  // it has more access now than when it wrote them (runner/ceiling.ts).
  wakeNewsText(st: ThreadState, news: NonNullable<ThreadRecord['wakeNews']>): string {
    if (this.underCeiling(st, news.ceiling)) return news.text;
    return "Note from Threadbear: this thread woke by itself, for a wait in words its agent had set (at its latest time, or as another thread looked to show it had happened). Those words aren't repeated here, as the thread has more access now than when they were written; the user can read them in the thread.";
  }

  // Heard by a completed turn, and more than LATE_NEWS_KEPT_MS ago: a
  // fresh session weeks on has no use for it (Gemini's review, 22 Nov 2026).
  wakeNewsStale(rec: ThreadRecord): boolean {
    const news = rec.wakeNews;
    return Boolean(news?.told && !news.told.inFlight && !(this.clock.now() - Date.parse(news.at ?? '') <= LATE_NEWS_KEPT_MS));
  }

  // What it was told went with a session or a turn that's gone: told again
  // with the next message, unless it's old by now.
  retellWakeNews(rec: ThreadRecord): void {
    const news = rec.wakeNews;
    if (!news?.told) return;
    if (this.wakeNewsStale(rec)) delete rec.wakeNews;
    else delete news.told;
  }

  // The presses told in the turn now going, or every one told, for a
  // session that replays its first message (startSession's retry).
  toldPressNews(rec: ThreadRecord, which: 'turn' | 'all'): string | undefined {
    const lines = rec.presses?.filter((p) => (which === 'all' ? p.told : p.told?.inFlight)).map((p) => p.line) ?? [];
    return lines.length ? this.pressNewsText(lines) : undefined;
  }

  // A thread whose recovery threw at start or on a handover: said, and
  // left as it is, mid-turn or not, rather than taking the runner down.
  recoveryFailed(st: ThreadState, e: unknown): void {
    this.log.error("couldn't recover a thread at start", { threadId: st.rec.id, error: String(e) });
    this.startupNotice('warning', `"${st.rec.title}" couldn't be picked up where it left off (${e instanceof Error ? e.message : String(e)}). The other threads started as usual.`);
  }

  // A completed turn keeps what it told; any other end (a failure, Stop, a
  // restart part way) tells it again with the next message.
  settlePresses(rec: ThreadRecord, completed: boolean): void {
    // News of a wake goes by the same rule. A turn told to do a check that
    // was lost has done it: nothing is left to tell a later session (here
    // for a turn a restart cut off: settleInstructionsNews has the rest).
    const woke = rec.wakeNews?.told;
    if (woke?.inFlight) {
      if (!completed) delete rec.wakeNews!.told;
      else if (rec.wakeNews!.check && !woke.deferred) delete rec.wakeNews;
      else delete woke.inFlight;
    }
    if (!Array.isArray(rec.presses)) return;
    for (const p of rec.presses) {
      if (!p.told?.inFlight) continue;
      if (completed) delete p.told.inFlight;
      else delete p.told;
    }
  }

  // Going back to the message at seq cuts what it and later ones told; a
  // fresh session (the cut reached its first message) heard none of them.
  retellPressesFrom(rec: ThreadRecord, seq: number, fresh = false): void {
    for (const p of rec.presses ?? []) if (p.told && (fresh || p.told.seq >= seq)) delete p.told;
    const woke = rec.wakeNews?.told;
    if (woke && (fresh || woke.seq >= seq)) this.retellWakeNews(rec);
  }

  // Sends a message with any change to the standing instructions in front.
  // They count as told only once the CLI has taken it: a send that throws
  // (a picture gone from the queue) would otherwise use up a clear that never
  // arrived (Codex review). In the transcript too, as a change anything made
  // reaches every thread, so it shouldn't only be something agents can see.
  sendWithInstructionsNews(st: ThreadState, message: UserInput): void {
    const { rec, rt } = st;
    const before = rec.instructionsTold;
    const standing = this.instructionsNews(rec);
    const presses = structuredClone(rec.presses);
    const pressed = this.takePressNews(st);
    const wokeBefore = structuredClone(rec.wakeNews);
    const woke = this.takeWakeNews(st, message.id);
    const prevNext =
      !rt.turn?.byMike &&
      !rt.turn?.nextReminded &&
      rec.needs?.needs === 'nothing' &&
      rec.needs.seq === rec.lastTurnCompletedSeq &&
      rec.needs.next?.length
        ? rec.needs
        : undefined;
    const nextNote = prevNext
      ? `[Threadbear note: your previous turn left these carry-on items for the user (${prevNext.nextPick === 'one' ? 'pick one' : 'pick any'}): ${prevNext.next!.map((s, i) => `${i + 1}. "${s}"${prevNext.nextPick === 'one' && prevNext.nextSuggested === i ? ' (recommended)' : ''}`).join('; ')}. If you end with needs "nothing" and omit next, Threadbear will keep them; pass next: [...] to replace them or next: [] to clear them.]`
      : '';
    if (nextNote && rt.turn) rt.turn.nextReminded = true;
    const lead = [standing, this.coordinators?.context(rec.id), woke, pressed, nextNote].filter(Boolean).join('\n\n');
    try {
      rt.session!.send(lead ? { ...message, text: `${lead}\n\n${message.text}` } : message);
    } catch (e) {
      if (before === undefined) delete rec.instructionsTold;
      else rec.instructionsTold = before;
      rec.presses = presses;
      if (wokeBefore) rec.wakeNews = wokeBefore;
      if (nextNote && rt.turn) delete rt.turn.nextReminded;
      throw e;
    }
    if (!standing) return;
    // A turn that ends any other way may have dropped it (a message Codex was
    // still holding when Stop came), so the turn's end looks at this.
    rt.instructionsNewsSent = true;
    // Only a note: failing here would report a message the CLI has as lost.
    try {
      this.emit(st, { type: 'system.note', text: "Told this thread's agent about a change to your standing instructions." }, message.id);
    } catch (e) {
      this.log.warn('could not note the standing instructions change', { threadId: rec.id, error: String(e) });
    }
  }

  // At a turn's end: news sent in a turn that didn't complete may never have
  // arrived, so the next message says what's current.
  settleInstructionsNews(st: ThreadState, completed: boolean): void {
    const { rec, rt } = st;
    // The check a wake sent (runner/hibernation.ts, wakeToCheck) has run,
    // in its own turn or in one told to do it as it was lost: nothing left
    // to say, and how this turn ends says whether Mike is needed.
    const news = rec.wakeNews;
    const told = news?.told;
    // (Not a turn that sent nothing: one held at dispatch, runner/ceiling.ts.)
    if (news?.check && completed && rt.turn && !rt.turn.local && (rt.turn.inputs?.has(news.check) || (told?.inFlight && !told.deferred))) {
      if (!rt.turn.byMike) rt.turn.wakeCheck = true;
      delete rec.wakeNews;
    }
    // A sleep backs off at the end of the check's own turn, or of one the
    // runner carried it on with (a lost network, a full login, a restart,
    // the CLI's own turn for a background job): a turn with new work in it
    // ending (Mike's message, a schedule's, another thread's, a report the
    // runner passes on) lets it go, unless the check still waits behind it.
    const backOff = rec.lateChecks?.backOff;
    if (backOff && rt.turn?.newWork && !rt.turn.inputs?.has(backOff) && !rec.queue.some((q) => q.turnId === backOff)) delete rec.lateChecks!.backOff;
    this.settlePresses(rec, completed);
    if (rt.instructionsNewsSent && !completed && rec.instructionsTold !== undefined) rec.instructionsTold = INSTRUCTIONS_REWOUND;
    rt.instructionsNewsSent = false;
  }

  // The thread's projects its session hasn't been told about, as lines to
  // put before its next message, or undefined. A thread whose session
  // predates projects (never told anything) gets the whole brief.
  projectNews(rec: ThreadRecord): string | undefined {
    if (!this.projects) return undefined;
    const ids = this.projects.briefIds(rec);
    const told = rec.projectsTold;
    const fresh = ids.filter((id) => !told?.includes(id));
    rec.projectsTold = ids;
    if (!fresh.length) return undefined;
    return told === undefined ? this.projects.brief(rec) : this.projects.joinedLines(fresh);
  }

  isoNow(): string {
    return new Date(this.clock.now()).toISOString();
  }

  // Test and CLI helpers.
  threadIds(): string[] {
    return [...this.threads.keys()];
  }

  isLive(threadId: string): boolean {
    return Boolean(this.threads.get(threadId)?.rt.session);
  }

  hasIdleTimer(threadId: string): boolean {
    return Boolean(this.threads.get(threadId)?.rt.idleTimer);
  }

  status(threadId: string): ThreadStatus | undefined {
    return this.threads.get(threadId)?.rec.status;
  }

  // Threads from before `asked` (3 Nov 2026) learn it from the end of
  // their log, once. Only the inbox's and hibernating ones: an archived
  // thread's row doesn't show it, and there can be thousands of those.
  backfillAsked(rec: ThreadRecord): void {
    const log = this.store.log(rec.id);
    const events = log.read(Math.max(1, log.lastSeq - 300), log.lastSeq);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const asked = e.type === 'user.message' ? askedLine(e, rec.reviews) : undefined;
      if (asked) {
        rec.asked = asked;
        return;
      }
    }
  }

  // A note outside any turn (restart.ts: "Runner restarted: ...").
  note(threadId: string, text: string): void {
    this.emit(this.mustGet(threadId), { type: 'system.note', text });
  }

  // Something about this Mac rather than any thread's work (mac-screen.ts):
  // a note in a thread of its own, in Needs you, so it reaches the other
  // Macs and the phone. No turn: nothing here needs a model. One that's been
  // archived has been dealt with, so that gets a new one.
  noticeOnMac(threadId: string | undefined, title: string, text: string): string {
    let st = threadId ? this.threads.get(threadId) : undefined;
    if (!st || st.rt.deleted || st.rec.archivedAt) st = this.makeThread({
      text,
      title,
      worktree: false,
      origin: 'runner',
      // On the install's default mode, like the runner's other threads
      // (own-threads.ts): what it says comes from this Mac, but whoever
      // answers it may ask its agent to act.
      startedBy: { kind: 'runner', label: 'Threadbear' },
    }).st;
    st.rec.forceUnread = true;
    st.rec.preview = oneLine(text, LIMITS.previewChars);
    this.emit(st, { type: 'system.note', text });
    this.markDirty(st);
    return st.rec.id;
  }

  noticeOverOnMac(threadId: string, text: string, archive: boolean): void {
    const st = this.mustGet(threadId);
    // Without archive something in the thread is still to do (a dialog
    // still up, or the access still missing), so it stays in Needs you.
    if (archive) st.rec.forceUnread = false;
    this.emit(st, { type: 'system.note', text });
    this.markDirty(st);
    if (archive && !st.rt.turn && !st.rec.archivedAt && this.opening(threadId).text === undefined) this.update({ threadId, archived: true, archivedBy: 'threadbear', noted: true });
  }
}

// The Runner's other methods live in parts under runner/, one area each;
// they go onto its prototype here, as the class's own methods would be.
for (const part of [looseEndsPart, quietInboxPart, inboxGuessPart, nestedPart, ceilingPart, mailPart, coldCompactPart, labReviewPart, newThreadsPart, hibernationPart, titlesPart, highlightsPart, ciRunsPart, prWatchPart, patchesPart, editingPart, clisPart, reviewsPart, buttonsPart, approvalsPart, projectsHostPart, stoppedWorkPart, handoversPart, poolsPart, networkPart, worktreesPart, commandsPart, contextUsagePart, movesPart, warmStartPart]) {
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(part))) {
    Object.defineProperty(Runner.prototype, key, { ...d, enumerable: false });
  }
}

// answers: the asks the message answers (AskAnswer), for the app to show.
// `wakeReason`: for a message the runner sends by itself, what happened, in a few
// words ("The app restarted"), shown on the divider before the turn it
// starts ("14 h later · The app restarted", Mike 19 Nov).
// `ceiling`: the most access the thread may have when these words reach its
// agent, for words a thread with less access wrote earlier (runner/ceiling.ts).
export type SendOptions = { ceiling?: PermissionMode; helperRunId?: string; origin?: MessageOrigin; wakeReason?: string; scheduleId?: string; preserveSchedule?: boolean; queue?: boolean; answers?: AskAnswer[]; editOf?: number; messageId?: string; scheduledSince?: number };

type ScheduledDelivery = { seq: number; started: boolean; text: string; images: ImageRef[]; superseded?: false } | { superseded: true; started: true };

const DELETED_REMINDER = 'Dropped a queued reminder because its schedule was deleted.';
const SUPERSEDED_REMINDER = 'Skipped an older queued reminder because a newer reminder from the same schedule is waiting.';

function isReminder(q: QueuedSend): boolean {
  return q.origin === 'schedule';
}

// Successful output and failure output may contain consumed items; an
// empty failure report can safely be replaced by the next reminder.
function hasCheckOutput(text: string): boolean {
  const failed = text.lastIndexOf('\n\nIts check failed (');
  return text.includes(HELD_EXTRA) || text.lastIndexOf('\n\nIts check found this:') > failed || (failed >= 0 && text.indexOf('\n\n```\n', failed) >= 0);
}

// How many sub-agents a thread keeps in its summary.
const SUBAGENTS_KEPT = 20;

function publicSubagent(a: SubagentRecord): Subagent {
  const { sessionId: _s, cwd: _c, accountId: _a, ...rest } = a;
  return rest;
}

function sortByActivity(list: ThreadSummary[]): ThreadSummary[] {
  return list.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0));
}

// "A", "A and B", "A, B and C".
function joinWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

// What clients were last told about the accounts, to tell a real change
// from a rescan that found the same list.
function accountsKey(accounts: Account[]): string {
  return JSON.stringify(accounts);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// Opens a url action's page in the default browser. No shell: the url goes
// to `open` as one argument, so nothing in it can be read as a command, and
// it's checked again here as only a web page.
function openInBrowser(url: string): Promise<void> {
  const page = webPage(url);
  if (!page) return Promise.reject(new RpcError(ErrorCode.badParams, `Not a web page: ${url}`));
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [page], (err) => (err ? reject(new RpcError(ErrorCode.other, `Couldn't open ${page}: ${err.message}`)) : resolve()));
  });
}

const ACCESS_ORDER: PermissionMode[] = ['ask', 'auto', 'full'];
function moreAccess(a: PermissionMode | undefined, b: PermissionMode): PermissionMode {
  return a && ACCESS_ORDER.indexOf(a) > ACCESS_ORDER.indexOf(b) ? a : b;
}

// Mike's standing instructions as an agent is given them.
function standingText(text: string): string {
  return `The user's standing instructions (set in Threadbear, Settings > General, the only place they can change: writing the file does nothing). Keep them in mind in everything you do for them:\n\n${text}`;
}

function instructionsHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}
