// Threads on an agent that speaks ACP (acp/agents.ts): one process per live
// thread, and everything it wants to do comes through here first.
//
// The agent is set to ask before every tool (AcpAgent.env, or for Grok the
// hook its args load: grok-guard.ts), and each request is answered from the
// thread's permission mode at that moment. So Ask, Auto and Plan never run a
// tool unguarded, and leaving Full takes effect at once, with no new process.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EFFORT_LEVELS, isEffortLevel, type Account, type EffortLevel, type ImageRef, type ModelChoice, type PermissionMode, type Question } from '../../protocol.ts';
import type { Logger } from '../../log.ts';
import type { ProcessRegistry } from '../../proc.ts';
import { cardInput, displayPath, tooLongForCard, truncateInput } from '../../tools.ts';
import { codeWriteNote, runsAsCodeByName, type CodeWrite } from '../../code-writes.ts';
import { END_TURN_FULL_NAME, END_TURN_TOOL, endTurnWantsReply } from '../../needs.ts';
import { placePictures } from '../../pictures.ts';
import { providerInfo, providerName } from '../../providers.ts';
import { firstLineSafely } from '../../safe-cut.ts';
import type { SlashCommand } from '../../slash-commands.ts';
import { cliEnv } from '../claude/adapter.ts';
import { commandRule, ruleMayCover, shellWords } from '../codex/approvals.ts';
import { toolGuidance, type ToolDefinition } from '../codex/tools.ts';
import { fileContext, truncateResultText, type NormalizerContext } from '../context.ts';
import { formContent, formQuestions, type FormSchema } from '../elicitation.ts';
import { acpCoordinatorTool, archiveReadTool, HELPER_REPORT, isHelperQuestionTool, threadbearToolName } from '../../coordinator-policy.ts';
import type { AdapterOutput, AgentAdapter, AgentSession, BackgroundTask, QuestionAnswer, SessionSink, StartSessionOptions, ToolApprovalAnswer, TurnResult, UserInput } from '../types.ts';
import { SessionNotFoundError, SessionUsageLimitError } from '../types.ts';
import type { AcpAgent } from './agents.ts';
import { AcpExitedError, AcpProcess, AcpRpcError, AUTH_REQUIRED, failureNote, genericRpcMessage, isFatalExecutionError, laterFailure, outOfUsage, textFromUpdate, type AcpTimings, type InitializeResult, type RequestId } from './connection.ts';
import { AcpMcpServer } from './mcp-http.ts';
import { AcpNormalizer, absolutePath, diffsAgreeWithInput, hasEditContent, hasOddPatchHeader, isPlainEdit, isPlainObject, requestPaths, writesFiles, type AcpBackgroundShell, type AcpOutput, type AcpToolCall } from './normalize.ts';

// Where an execute call can say it runs (OpenCode's bash tool: workdir).
const FOLDER_KEYS = ['workdir', 'cwd', 'workingDirectory', 'directory', 'dir'];
// What an execute call can carry that doesn't change what runs or where.
const BENIGN_KEYS = new Set(['description', 'timeout', 'WaitMsBeforeAsync']);

function realFolder(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

export type AcpAdapterDeps = {
  agent: AcpAgent;
  // Read for every process: runner.json's path, or wherever it's installed.
  binary: () => string | undefined;
  registry: ProcessRegistry;
  log: Logger;
  toolsFor?: (threadId: string) => ToolDefinition[];
  extraGuidance?: () => string;
  timings?: Partial<AcpTimings>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  // The runner's data dir, where an agent keeps what Threadbear gives it
  // (Grok's hook: grok-guard.ts).
  dataDir?: string;
  // Extra MCP servers for every session, for an agent that takes them
  // (AcpAgent.takesMcpServers): Agent Archive, read at each session's start.
  mcpServers?: () => Record<string, { command: string; args: string[] }>;
  // Test overrides for background shell liveness polling and unsolicited turn settle windows.
  shellPidAlive?: (pid: number) => boolean;
  backgroundShellPollMs?: number;
  unsolicitedSettleMs?: { endTurn?: number; endTurnWaitText?: number; text?: number; idle?: number; toolStall?: number };
};

// How often a login whose turns don't report its limits is read (an agent
// whose AcpAgent.limits is a usage command).
export const LIMITS_POLL_MS = 10 * 60_000;

// "Always allow" for a file edit: the thread's edits, while they aren't to
// a file that runs as code. A command's rule is the exact command in that
// folder (codex/approvals.ts).
export const EDIT_RULE = 'acp:edit';

type ConfigOption = { id?: string; category?: string; type?: string; currentValue?: unknown; options?: unknown[] };
// Grok's `models` also says each model's effort levels and its default one;
// Antigravity lists `<modelId>-<level>` entries there.
type ModelState = { availableModels?: unknown[] } | null;
type SessionResult = { sessionId?: string; configOptions?: ConfigOption[] | null; modes?: { currentModeId?: string; availableModes?: { id?: string }[] } | null; models?: ModelState };

function optionValues(options: unknown[] | undefined): string[] {
  const out: string[] = [];
  const add = (o: unknown) => {
    if (!isPlainObject(o)) return;
    if (Array.isArray(o.options)) return o.options.forEach(add);
    if (typeof o.value === 'string' && o.value) out.push(o.value);
  };
  if (Array.isArray(options)) options.forEach(add);
  return out;
}

function thoughtLevelInfo(options: ConfigOption[] | null | undefined): { levels: EffortLevel[]; defaultEffort?: EffortLevel; hasDefault: boolean } | undefined {
  const opt = options?.find((o) => o.category === 'thought_level');
  if (!opt) return undefined;
  const values = optionValues(opt.options);
  const levels = [...new Set(values.filter(isEffortLevel))].sort((a, b) => EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b));
  const hasDefault = values.includes('default');
  const defaultEffort = isEffortLevel(opt.currentValue) && levels.includes(opt.currentValue) ? opt.currentValue : undefined;
  return { levels, ...(defaultEffort ? { defaultEffort } : {}), hasDefault };
}

// The effort levels each model lists, those that are Threadbear's own, and
// the one it marks as its default: Grok's `_meta.reasoningEfforts`, or
// Antigravity's `<modelId>-<level>` entries in `models.availableModels`.
export function modelEfforts(
  models: ModelState | undefined,
  options?: ConfigOption[] | null,
  includeCurrentAsDefault = true,
): Map<string, { levels: EffortLevel[]; defaultEffort?: EffortLevel }> {
  const out = new Map<string, { levels: EffortLevel[]; defaultEffort?: EffortLevel }>();
  const available = Array.isArray(models?.availableModels) ? models.availableModels : [];
  for (const m of available) {
    if (!isPlainObject(m) || typeof m.modelId !== 'string' || !isPlainObject(m._meta) || !Array.isArray(m._meta.reasoningEfforts)) continue;
    const levels: EffortLevel[] = [];
    let defaultEffort: EffortLevel | undefined;
    for (const e of m._meta.reasoningEfforts) {
      if (!isPlainObject(e) || !isEffortLevel(e.id)) continue;
      levels.push(e.id);
      if (e.default === true) defaultEffort = e.id;
    }
    // In Threadbear's order, lowest first, whatever order the agent lists them.
    levels.sort((a, b) => EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b));
    if (levels.length) out.set(m.modelId, { levels, ...(defaultEffort ? { defaultEffort } : {}) });
  }
  const baseIds = new Set(optionValues(options?.find((o) => o.category === 'model')?.options));
  if (baseIds.size) {
    const byBase = new Map<string, Set<EffortLevel>>();
    for (const m of available) {
      if (!isPlainObject(m) || typeof m.modelId !== 'string') continue;
      const dash = m.modelId.lastIndexOf('-');
      if (dash <= 0) continue;
      const base = m.modelId.slice(0, dash);
      const level = m.modelId.slice(dash + 1);
      if (!baseIds.has(base) || out.has(base) || !isEffortLevel(level)) continue;
      const set = byBase.get(base) ?? new Set<EffortLevel>();
      set.add(level);
      byBase.set(base, set);
    }
    const currentThought = includeCurrentAsDefault ? options?.find((o) => o.category === 'thought_level')?.currentValue : undefined;
    const currentDefault = isEffortLevel(currentThought) ? currentThought : undefined;
    for (const [base, set] of byBase) {
      const levels = [...set].sort((a, b) => EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b));
      const defaultEffort = currentDefault && levels.includes(currentDefault) ? currentDefault : undefined;
      out.set(base, { levels, ...(defaultEffort ? { defaultEffort } : {}) });
    }
  }
  return out;
}

export function modelChoices(options: ConfigOption[] | null | undefined, models?: ModelState): ModelChoice[] {
  const model = options?.find((o) => o.category === 'model');
  if (!model || !Array.isArray(model.options)) return [];
  const efforts = modelEfforts(models, options);
  const out: ModelChoice[] = [];
  const add = (o: unknown) => {
    if (!isPlainObject(o)) return;
    if (Array.isArray(o.options)) return o.options.forEach(add); // a named group
    if (typeof o.value !== 'string' || !o.value) return;
    const title = typeof o.name === 'string' && o.name ? o.name : o.value;
    const e = efforts.get(o.value);
    out.push({ id: o.value, model: o.value, title, ...(e ? { effortLevels: e.levels, ...(e.defaultEffort ? { defaultEffort: e.defaultEffort } : {}) } : {}) });
  };
  model.options.forEach(add);
  return out;
}

// Grok adds the hook that asked to the title of a request it asks about
// ("Write `a.txt` — hook 'plugin/threadbear-ask/...' asks: ..."). The card
// says what the call does, not which of Threadbear's own pieces sent it.
export function withoutHookNote(call: AcpToolCall, meta: unknown): AcpToolCall {
  const hook = isPlainObject(meta) && isPlainObject(meta.hookAsk) ? meta.hookAsk.hookName : undefined;
  if (typeof hook !== 'string' || !hook || typeof call.title !== 'string') return call;
  const at = call.title.indexOf(` — hook '${hook}'`);
  return at > 0 ? { ...call, title: call.title.slice(0, at) } : call;
}

function notFound(e: unknown): boolean {
  if (e instanceof AcpRpcError && e.code === -32002) return true;
  // The agent's own message only: a reason from an error's data (a file
  // "not found" behind an "Internal error") isn't the session gone.
  const said = e instanceof AcpRpcError ? (e.rpcMessage ?? '') : e instanceof Error ? e.message : String(e);
  return /not found|no such session|does not exist/i.test(said);
}

type Limits = Extract<AdapterOutput, { kind: 'limits' }>;

// How long a read of a login's limits on a thread's own process may take.
export const TURN_LIMITS_MS = 5_000;
// A completed turn reads the login's limits at most this often per process;
// one that ran out of usage always does.
export const LIMITS_EVERY_MS = 5 * 60_000;

export class AcpAdapter implements AgentAdapter {
  readonly provider;
  readonly settingsApplyNextTurn = true;
  readonly wakesAfterTasks: boolean;
  readonly wakeGraceMs?: number;
  readonly nudgesUnreadShells?: boolean;
  // Only for an agent that can say (AcpAgent.limits): limit-recheck.ts
  // takes any adapter with one as able to read. null when the agent said
  // nothing that reads (or didn't list its usage command): never a reason
  // to show an error.
  readonly readLimits?: (account: Account) => Promise<Limits | null>;
  // An agent whose turns carry no reading (one read by a usage command,
  // Gemini): limit-recheck.ts reads it this often, and soon after its turns.
  readonly limitsPollMs?: number;
  private deps: AcpAdapterDeps;

  constructor(deps: AcpAdapterDeps) {
    this.deps = deps;
    this.provider = deps.agent.provider;
    this.wakesAfterTasks = deps.agent.wakesAfterTasks === true;
    if (this.wakesAfterTasks) {
      this.wakeGraceMs = ACP_WAKE_GRACE_MS;
      this.nudgesUnreadShells = true;
    }
    const limits = deps.agent.limits;
    if (limits && 'method' in limits) this.readLimits = (account) => this.limitsNow(account, limits);
    else if (limits) {
      this.readLimits = (account) => this.usageNow(account, limits);
      this.limitsPollMs = LIMITS_POLL_MS;
    }
  }

  private env(account: Account, binary: string, threadEnv?: Record<string, string>): Record<string, string | undefined> {
    const env = cliEnv(account, this.deps.env ?? process.env);
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CLAUDE_AGENT_SDK_CLIENT_APP;
    // Last, so a thread's own variables can't take these off.
    return { ...env, ...threadEnv, ...this.deps.agent.env({ binary }) };
  }

  private binary(): string {
    const name = providerName(this.provider);
    const bin = this.deps.binary();
    if (!bin) throw new Error(`Threadbear can't find ${name} on this Mac.`);
    return bin;
  }

  start(opts: StartSessionOptions, sink: SessionSink): AgentSession {
    const binary = this.binary();
    const refused = this.deps.agent.refuses?.({ cwd: opts.cwd, mode: opts.permissionMode, binary });
    if (refused) throw new Error(refused);
    const s = new AcpSession(opts, sink, this.deps, binary, this.env(opts.account, binary, opts.env));
    s.start();
    return s;
  }

  // What session/new offers. It makes a session in the agent's own list; a
  // folder of temp means it's in nobody's way, and it's closed where the
  // agent can. For an agent that only reports thought_level for the active
  // model (OpenCode 2), switches through each model to read its effortLevels.
  async models(account: Account, signal?: AbortSignal): Promise<ModelChoice[]> {
    return this.shortLived(
      account,
      `models:${account.id}`,
      async (p, r) => {
        const choices = modelChoices(r?.configOptions, r?.models);
        if (!r?.sessionId || !choices.length || choices.some((c) => c.effortLevels?.length)) return choices;
        if (providerInfo(this.provider).effort === 'none') return choices;
        const modelOpt = r.configOptions?.find((o) => o.category === 'model');
        if (!modelOpt?.id) return choices;
        const hasThought = Boolean(r.configOptions?.some((o) => o.category === 'thought_level'));
        if (!hasThought && !this.deps.agent.probesModelEfforts) return choices;
        const active = typeof modelOpt.currentValue === 'string' ? modelOpt.currentValue : undefined;
        const probed = new Map<string, { levels: EffortLevel[]; defaultEffort?: EffortLevel }>();
        const note = (id: string, opts: ConfigOption[] | null | undefined) => {
          const tl = thoughtLevelInfo(opts);
          if (tl?.levels.length) probed.set(id, { levels: tl.levels, ...(tl.defaultEffort ? { defaultEffort: tl.defaultEffort } : {}) });
        };
        if (active) note(active, r.configOptions);
        for (const c of choices) {
          if (c.id === active) continue;
          try {
            const next = await p.request<SessionResult>('session/set_config_option', { sessionId: r.sessionId, configId: modelOpt.id, value: c.id }, MODEL_PROBE_MS);
            note(c.id, next?.configOptions);
          } catch (e) {
            if (e instanceof AcpExitedError || (e instanceof AcpRpcError && e.code === -32601)) break;
          }
        }
        if (!probed.size) return choices;
        return choices.map((c) => {
          const e = probed.get(c.id);
          return e ? { ...c, effortLevels: e.levels, ...(e.defaultEffort ? { defaultEffort: e.defaultEffort } : {}) } : c;
        });
      },
      { deadlineMs: MODELS_DEADLINE_MS, signal },
    );
  }

  // A login's limits from the agent's own request (Grok's _x.ai/billing):
  // initialize, then the request. No session is opened, so nothing shows in
  // the agent's own list.
  private async limitsNow(account: Account, limits: Extract<NonNullable<AcpAgent['limits']>, { method: string }>): Promise<Limits | null> {
    return this.shortLived(account, `limits:${account.id}`, async (p) => limits.read(await p.request(limits.method, {})) ?? null, { session: false, noTools: true, deadlineMs: LIMITS_DEADLINE_MS });
  }

  // A login's limits from the agent's own usage command (Antigravity's
  // /usage), which it answers itself in a session with no model turn.
  private async usageNow(account: Account, limits: Extract<NonNullable<AcpAgent['limits']>, { command: string }>): Promise<Limits | null> {
    return this.shortLived(
      account,
      `usage:${account.id}`,
      async (p, r, commands) => {
        if (!r?.sessionId) return null;
        // Only a command the session lists: anything else would go to the
        // model as a prompt, and cost a turn.
        const listed = await commands(USAGE_COMMANDS_WAIT_MS);
        if (!listed.includes(limits.command)) {
          this.deps.log.info("the agent didn't list its usage command, so its plan wasn't read", { provider: this.provider });
          return null;
        }
        let text = '';
        const sessionId = r.sessionId;
        p.onNotification = (method, params) => {
          if (method !== 'session/update' || !isPlainObject(params) || params.sessionId !== sessionId || !isPlainObject(params.update)) return;
          const u = params.update;
          if (u.sessionUpdate === 'agent_message_chunk' && isPlainObject(u.content) && u.content.type === 'text' && typeof u.content.text === 'string' && text.length < USAGE_TEXT_MAX) text += u.content.text;
        };
        await p.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `/${limits.command}` }] }, USAGE_PROMPT_MS);
        // Not even the plan's name without a reading: any reading, a
        // plan-only one too, stamps the login as read now, which would hide
        // how old its windows are and drop any whose reset has passed
        // (usage.ts compute).
        const read = limits.read(text, r);
        if (!read && text) this.deps.log.info("the agent's usage answer didn't read", { provider: this.provider, chars: text.length });
        return read ?? null;
      },
      { deadlineMs: LIMITS_DEADLINE_MS },
    );
  }

  // A process of its own for a small job, in an empty temp folder: closed,
  // with its folder, however the job ends. With a session (unless session
  // is false), `commands` waits (up to ms) for the session's
  // available_commands_update, which comes just after session/new answers,
  // and says the names it listed. deadlineMs: the whole job, start to
  // close, after which its process is killed (which fails whatever it's
  // waiting on), so a hung agent never outlives the read that started it.
  private async shortLived<T>(
    account: Account,
    label: string,
    job: (p: AcpProcess, session: SessionResult | undefined, commands: (ms: number) => Promise<string[]>) => Promise<T>,
    o: { session?: boolean; noTools?: boolean; deadlineMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    o.signal?.throwIfAborted();
    const { deps } = this;
    const bin = this.binary();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'threadbear-acp-'));
    let p: AcpProcess;
    try {
      p = new AcpProcess({ binary: bin, args: deps.agent.args({ dataDir: deps.dataDir, binary: bin, ...(o.noTools ? { noTools: true } : {}) }), env: this.env(account, bin), cwd, registry: deps.registry, log: deps.log, label, timings: deps.timings });
    } catch (e) {
      removeQuietly(cwd);
      throw e;
    }
    let listed: string[] | undefined;
    let wake: (() => void) | undefined;
    p.onNotification = (method, params) => {
      if (method !== 'session/update' || !isPlainObject(params) || !isPlainObject(params.update) || params.update.sessionUpdate !== 'available_commands_update') return;
      const cmds = params.update.availableCommands;
      listed = Array.isArray(cmds) ? cmds.flatMap((c) => (isPlainObject(c) && typeof c.name === 'string' ? [c.name] : [])) : [];
      wake?.();
    };
    const commands = (ms: number): Promise<string[]> =>
      listed
        ? Promise.resolve(listed)
        : new Promise((resolve) => {
            const t = setTimeout(() => resolve(listed ?? []), ms);
            t.unref();
            wake = () => (clearTimeout(t), resolve(listed ?? []));
          });
    let r: SessionResult | undefined;
    let init: InitializeResult | undefined;
    const deadline = o.deadlineMs ? setTimeout(() => p.kill(), o.deadlineMs) : undefined;
    deadline?.unref();
    const onAbort = () => p.kill();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      init = await p.start();
      if (!deps.agent.identifies(init)) throw new Error(`The program found for ${providerName(this.provider)} isn't it.`);
      if (o.session !== false) r = await p.request<SessionResult>('session/new', { cwd, mcpServers: [] });
      return await job(p, r, commands);
    } finally {
      if (r?.sessionId && p.alive && init?.agentCapabilities?.sessionCapabilities?.close !== undefined) await p.request('session/close', { sessionId: r.sessionId }, CLOSE_SESSION_MS).catch(() => undefined);
      clearTimeout(deadline);
      await p.close().catch(() => undefined);
      o.signal?.removeEventListener('abort', onAbort);
      removeQuietly(cwd);
    }
  }
}

// How long a usage command's read waits for the session to list its
// commands, and for the command's answer (Antigravity 1.4.5 lists them with
// session/new's answer, and answers in under a second).
const USAGE_COMMANDS_WAIT_MS = 5_000;
const USAGE_PROMPT_MS = 30_000;
// A whole read of a login's limits in a process of its own, under
// limit-recheck's READ_DEADLINE_MS (60 s), so its process is gone before the
// recheck moves on. Antigravity 1.4.5's /usage takes 4 to 18 s, Grok's
// _x.ai/billing under a second.
const LIMITS_DEADLINE_MS = 50_000;
// A short-lived models() read (OpenCode 2 probes ~100 models in ~400 ms).
const MODELS_DEADLINE_MS = 20_000;
const MODEL_PROBE_MS = 5_000;
// A short-lived session's session/close: it's closed anyway after.
const CLOSE_SESSION_MS = 5_000;
// More than any answer is: what a runaway one adds past it is dropped.
const USAGE_TEXT_MAX = 64_000;
// The bridge can finish the prompt or resume work after a failed tool.
export const ANTIGRAVITY_QUOTA_GRACE_MS = 30_000;
// Give a tool that was already running time to finish, with a ceiling if
// the executor died and will never send another update for it.
export const ANTIGRAVITY_QUOTA_TOOL_GRACE_MS = 30 * 60_000;
// How often background shells reported by OpenCode are probed for liveness.
export const BACKGROUND_SHELL_POLL_MS = 1_000;
// How long the runner waits for OpenCode's own turn after a background shell
// ends (AgentAdapter.wakeGraceMs). That turn opens only when the model's first
// words arrive: 12 s for Gemini on 28 Nov 2026, and over the runner's usual 15 s
// the next time, when an update's handover then let the CLI go mid-wake.
export const ACP_WAKE_GRACE_MS = 90_000;
// OpenCode's background turn fiber streams normal session/update events with
// no session/prompt in flight and sends no end-of-turn notification when the
// woken turn finishes. Settle once all tools, cards and MCP calls are clear.
export const UNSOLICITED_END_TURN_SETTLE_MS = 5_000;
export const UNSOLICITED_END_TURN_WAIT_TEXT_MS = 15_000;
export const UNSOLICITED_TEXT_SETTLE_MS = 30_000;
export const UNSOLICITED_IDLE_SETTLE_MS = 60_000;
export const UNSOLICITED_TOOL_STALL_MS = 10 * 60_000;
const TURN_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan']);

// The executor can send its banner in one chunk and its HTTP error in the next.
export const EXECUTOR_DIAGNOSTIC_GRACE_MS = 5_000;
const EXECUTOR_BANNER = /^Agent execution terminated due to error/i;
const ANTIGRAVITY_EXECUTOR_429 = /^Agent execution terminated due to error\. \("agent executor error: Error 429\b/i;
const ANTIGRAVITY_INDIVIDUAL_QUOTA = /^, Message: Individual quota reached\./i;
const ANTIGRAVITY_EXHAUSTED_STATUS = /, Status: RESOURCE_EXHAUSTED\b/;
const ANTIGRAVITY_RATE_RETRY = /\b(?:requests?|tokens?) per (?:minute|hour)\b|\bretry in \d+(?:\.\d+)?\s*(?:s|secs?|seconds?)\b/i;

type State = 'starting' | 'ready' | 'turn' | 'closing' | 'closed';
// failure: what the agent said went wrong in the turn outside the prompt's
// answer (Grok's retry_state and turn_completed notes), with any HTTP status.
type Turn = {
  id?: string;
  startedAt: number;
  interrupted: boolean;
  dropped: string[];
  failure?: { message: string; httpStatus?: number };
  executorDiagnosticTimer?: NodeJS.Timeout;
  dispatched?: boolean;
  quota?: { message: string; earlierTools: ReadonlySet<string>; deadline?: { kind: 'idle' | 'tools'; timer: NodeJS.Timeout } };
  // Opened for an agent-initiated turn (OpenCode waking for a background shell)
  // that has no session/prompt request in flight.
  unsolicited?: boolean;
  settleTimer?: NodeJS.Timeout;
  endTurnAccepted?: boolean;
  sawText?: boolean;
  lastActivity?: 'text' | 'other';
};
// cancelled: what a cancelled turn answers it with (a form's differs).
type Pending = { abort: AbortController; options: PermissionOption[]; cancelled?: unknown };
type PermissionOption = { optionId?: string; kind?: string };

export class AcpSession implements AgentSession {
  private opts: StartSessionOptions;
  private sink: SessionSink;
  private deps: AcpAdapterDeps;
  private now: () => number;
  private proc: AcpProcess;
  private mcp?: AcpMcpServer;
  private normalizer: AcpNormalizer;
  private ctx: NormalizerContext;
  private state: State = 'starting';
  private sessionId?: string;
  private init: InitializeResult = {};
  private held: UserInput[] = [];
  private turn?: Turn;
  // When this process last read the login's limits after a turn.
  private limitsReadAt?: number;
  private pending = new Map<RequestId, Pending>();
  private rules: Set<string>;
  private mode: PermissionMode;
  private model?: string;
  private modelChanged = false;
  private effort?: EffortLevel;
  private effortChanged = false;
  // Each model's own effort level, for going back to it (Grok's list).
  private ownEfforts = new Map<string, { levels: EffortLevel[]; defaultEffort?: EffortLevel }>();
  // The threadbear tools this session's MCP server offers, as the agent names them.
  private ownTools = new Set<string>();
  // Agent Archive is the runner's own server in this session (session start).
  private archiveOurs = false;
  // Every frame of a tool call, by id, as the agent sent it: whether any said
  // it's an MCP call, and every argument list it carried. A later frame
  // can't wash out what an earlier one said (Codex's and Gemini's third
  // reviews, 20 Nov 2026). Kept for the session's life: a call can ask after
  // its turn.
  private callFrames = new Map<string, {
    mcp: boolean; confirmedMcp?: Set<string>; markedNative?: boolean; grokUseTool?: boolean; scopedInput?: Record<string, unknown>;
    ids: Set<string>; names: Set<string>; acting: number; named: Map<string, number>;
    inputs: Record<string, unknown>[]; kinds: Set<string>; paths: Set<string>;
    diffs: Record<string, unknown>[]; otherContent: unknown[]; last?: string;
  }>();
  private configOptions: ConfigOption[] = [];
  // The plugin whose hook must be reported running before the model does
  // anything in a turn (Grok's guard), and whether it has been this turn.
  private guard?: string;
  private guardSeen = false;
  // Whether the agent trusted the folder when this process started (Grok).
  private trusted = false;
  // The program this session runs, for a refusal that depends on its version.
  private binary: string;
  // What an asking mode would have been refused for when the process
  // started. It holds for the process's life: an OpenCode 1 that started in
  // Full beside a folder's plugins has imported them, whatever's on disk by
  // the time the mode is lowered (a new version, the plugins gone).
  private startRefusal?: string;
  private currentMode?: string;
  private cliCommands: SlashCommand[] = [];
  // Said once, before the first message of a new session.
  private preamble?: string;
  private replaying = false;
  private exitedCalled = false;
  // The empty folder the agent's session opens in (AcpAgent.ownSessionFolder).
  private ownFolder?: string;
  private chunkBuffer = '';
  // When our HTTP MCP server serves end_turn, it is the authoritative source
  // of mcp__threadbear__end_turn events: OpenCode 2's Code Mode calls it from
  // inside `execute` without emitting a direct ACP tool_call for it, and direct
  // ACP callers can drop error text or send wrapped JSON strings that
  // AcpMcpServer unwraps. Direct ACP end_turn rows are suppressed so the runner
  // sees each call once, with its parsed input and exact handler result.
  private mcpOwnsEndTurn = false;
  private openMcpCalls = new Map<string, Turn>();
  private suppressedToolIds = new Set<string>();
  // Live background shells reported by OpenCode (shellID -> pid + label),
  // polled until they exit so the thread stays Running and the CLI is kept live.
  private backgroundShells = new Map<string, { id: string; pid: number; description: string }>();
  private announcedDeadShells = new Set<string>();
  private shellPollTimer?: NodeJS.Timeout;
  private isShellPidAlive: (pid: number) => boolean;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(opts: StartSessionOptions, sink: SessionSink, deps: AcpAdapterDeps, binary: string, env: Record<string, string | undefined>) {
    this.opts = opts;
    this.sink = sink;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.isShellPidAlive = deps.shellPidAlive ?? ownPidAlive;
    this.mode = opts.permissionMode;
    this.model = opts.model;
    this.effort = opts.effort;
    this.rules = new Set(opts.allowRules ?? []);
    this.exitPromise = new Promise((r) => (this.resolveExit = r));
    this.ctx = fileContext(opts.cwd, opts.mediaDir, opts.blobsDir);
    this.normalizer = new AcpNormalizer(this.ctx, { movesAskedCalls: this.deps.agent.movesAskedCalls === true });
    this.trusted = deps.agent.trusts?.(opts.cwd) ?? false;
    this.binary = binary;
    this.startRefusal = deps.agent.refuses?.({ cwd: opts.cwd, mode: 'ask', trusted: this.trusted, binary });
    const args = deps.agent.args({ dataDir: deps.dataDir, trusted: this.trusted, binary });
    this.guard = deps.agent.guardName?.(args);
    this.proc = new AcpProcess({ binary, args, env, cwd: opts.cwd, registry: deps.registry, log: deps.log, label: opts.threadId, timings: deps.timings, forms: true, lowered: true, lowerAfterInit: deps.agent.lowerAfterInit === true });
    this.proc.onNotification = (method, params) => this.notification(method, params);
    this.proc.onRequest = (id, method, params) => this.request(id, method, params);
    this.proc.onExit = (err) => {
      const turn = this.turn;
      if (err && turn && (turn.quota || turn.executorDiagnosticTimer) && !turn.interrupted) {
        this.exited(new Error(this.failureFor(turn).error ?? err.message, { cause: err }));
      } else {
        this.exited(err);
      }
    };
  }

  private addRules(rules: string[]): void {
    for (const r of rules) this.rules.add(r);
    this.sink.output({ kind: 'allowRules', rules });
  }

  start(): void {
    void this.boot().catch((e: unknown) => {
      if (this.state === 'closing' || this.state === 'closed') return void this.finish();
      this.deps.log.warn('acp session did not start', { threadId: this.opts.threadId, error: String(e) });
      void this.finish(e instanceof Error ? e : new Error(String(e)));
    });
  }

  private async boot(): Promise<void> {
    const { opts, deps } = this;
    const name = providerName(deps.agent.provider);
    this.init = await this.proc.start();
    if (this.state !== 'starting') return void (await this.proc.close());
    if (!deps.agent.identifies(this.init)) {
      const said = this.init.agentInfo?.name ? ` (it says it's ${this.init.agentInfo.name})` : '';
      throw new Error(`The program found for ${name} isn't ${name}${said}, so this thread wasn't started.`);
    }
    if (this.proc.version) this.sink.output({ kind: 'cliVersion', version: this.proc.version });

    const defs = deps.toolsFor?.(opts.threadId) ?? [];
    let mcpServers: unknown[] = [];
    if (defs.length && this.init.agentCapabilities?.mcpCapabilities?.http) {
      this.mcpOwnsEndTurn = defs.some((d) => d.name === END_TURN_TOOL);
      this.mcp = new AcpMcpServer(defs, {
        log: deps.log,
        label: opts.threadId,
        requestApproval: (req) => this.sink.requestApproval(req),
        cwd: () => opts.cwd,
        mode: () => this.mode,
        rules: () => this.rules,
        addRules: (rules) => this.addRules(rules),
        onToolStart: (toolName, args) => this.mcpToolStart(toolName, args),
        onToolResult: (itemId, ok, text) => this.mcpToolResult(itemId, ok, text),
        ...(opts.coordinator
          ? {
              checkCoordinator: (fullName: string, args: Record<string, unknown>) =>
                opts.coordinator!.checkTool({ name: fullName, input: args, agentId: opts.coordinator!.role === 'helper' ? opts.threadId : undefined }),
            }
          : {}),
      });
      const url = await this.mcp.listen();
      mcpServers = [{ type: 'http', name: 'threadbear', url, headers: [{ name: 'Authorization', value: `Bearer ${this.mcp.token}` }] }];
      this.ownTools = new Set(defs.map((d) => `threadbear__${d.name}`));
    }
    if (deps.agent.takesMcpServers) {
      const own = (deps.agent.mcpConfigFiles?.(os.homedir(), opts.cwd) ?? []).flatMap((f) => {
        try {
          return [fs.readFileSync(f, 'utf8')];
        } catch {
          return [];
        }
      });
      for (const [name, s] of Object.entries(deps.mcpServers?.() ?? {})) {
        // The agent's own config names a server the same: that one could
        // answer instead, so ours isn't added, nor its calls trusted.
        if (own.some((text) => text.includes(name))) {
          deps.log.warn('acp: not adding a runner MCP server the agent config already names', { threadId: opts.threadId, name });
          continue;
        }
        mcpServers.push({ name, command: s.command, args: s.args, env: [] });
        if (name === 'agent-archive') this.archiveOurs = true;
      }
    }

    let res: SessionResult;
    try {
      res = await this.openSession(mcpServers);
    } catch (e) {
      if (e instanceof AcpRpcError && e.code === AUTH_REQUIRED) {
        const login = providerInfo(deps.agent.provider).loginCommand;
        throw Object.assign(new Error(login ? `${name} needs a sign-in. Run \`${login}\` in a terminal, then send this again.` : `${name} needs a sign-in. Sign it in again, then send this again.`), { errorKind: 'auth' });
      }
      throw e;
    }
    if (this.state !== 'starting') return;
    this.sessionId = this.sessionId ?? res.sessionId;
    if (typeof this.sessionId !== 'string' || !this.sessionId) throw new Error(`${name} started a session without an id`);
    this.noteOptions(res);
    this.ownEfforts = modelEfforts(res.models, res.configOptions, !opts.resume);
    if (!opts.resume) {
      const isHelper = opts.coordinator?.role === 'helper';
      this.preamble = [!isHelper && defs.length ? toolGuidance(defs) : '', !isHelper && defs.length ? (deps.extraGuidance?.() ?? '') : '', deps.agent.folderNote?.(opts.cwd) ?? '', opts.instructions ?? ''].filter(Boolean).join('\n\n') || undefined;
    }
    await this.applyMode();
    if (this.model) await this.applyModel(this.model);
    if (this.effort !== undefined || opts.resume) await this.applyEffort(this.effort);
    const model = this.modelNow();
    this.sink.output({ kind: 'session', nativeSessionId: this.sessionId, ...(model ? { model } : {}) });
    this.state = 'ready';
    this.next();
  }

  private openSession(mcpServers: unknown[]): Promise<SessionResult> {
    const { opts } = this;
    const caps = this.init.agentCapabilities;
    // An agent that writes into its session's folder gets an empty one, and
    // the thread's folder as an extra one (where the work is).
    if (this.deps.agent.ownSessionFolder) {
      if (this.state !== 'starting') return Promise.reject(new Error('The session ended before it opened.'));
      this.ownFolder = sessionFolder();
    }
    const where = this.ownFolder ? { cwd: this.ownFolder, additionalDirectories: [opts.cwd] } : { cwd: opts.cwd };
    if (!opts.resume) return this.proc.request<SessionResult>('session/new', { ...where, mcpServers });
    this.sessionId = opts.sessionId;
    const common = { sessionId: opts.sessionId, ...where, mcpServers };
    const opened = caps?.sessionCapabilities?.resume !== undefined
      ? this.proc.request<SessionResult>('session/resume', common)
      : caps?.loadSession
        ? this.load(common)
        : Promise.reject(new SessionNotFoundError('This agent can\'t carry on a session in a new process.'));
    return opened.catch((e: unknown) => {
      if (notFound(e)) throw new SessionNotFoundError(`The session to resume wasn't found (${(e as Error).message}).`);
      throw e;
    });
  }

  // session/load replays the old conversation as updates: already in the
  // transcript, so they're dropped.
  private async load(params: Record<string, unknown>): Promise<SessionResult> {
    this.replaying = true;
    try {
      return await this.proc.request<SessionResult>('session/load', params);
    } finally {
      this.replaying = false;
    }
  }

  private noteOptions(res: { configOptions?: ConfigOption[] | null; modes?: SessionResult['modes'] }): void {
    if (Array.isArray(res.configOptions)) this.configOptions = res.configOptions;
    const mode = this.configOptions.find((o) => o.category === 'mode');
    if (typeof mode?.currentValue === 'string') this.currentMode = mode.currentValue;
    else if (typeof res.modes?.currentModeId === 'string') this.currentMode = res.modes.currentModeId;
  }

  private modelNow(): string | undefined {
    const v = this.configOptions.find((o) => o.category === 'model')?.currentValue;
    return typeof v === 'string' ? v : undefined;
  }

  // Puts the agent in the session mode this thread's mode calls for. If it
  // can't be done, a thread that has to ask doesn't run: Cursor's read-only
  // mode is all that stands between it and its own allow-list.
  // One at a time, and until the agent is where the thread's mode is now:
  // a quick Full then Ask must not end on whichever answer came last.
  private applyMode(): Promise<void> {
    const run = this.modeChain.then(() => this.settleMode());
    this.modeChain = run.catch(() => undefined);
    return run;
  }

  private effectiveMode(): PermissionMode {
    // Cursor's agent mode runs edits without asking, so a Cursor coordinator
    // stays in ask (read-only) mode even when the thread is in Full access.
    if (this.opts.coordinator?.role === 'coordinator' && this.deps.agent.provider === 'cursor') return 'ask';
    return this.mode;
  }

  private async settleMode(): Promise<void> {
    for (let i = 0; i < 8; i++) {
      const want = this.deps.agent.modeFor(this.effectiveMode());
      if (!want || want === this.currentMode) return;
      await this.setAgentMode(want);
    }
  }

  private async setAgentMode(want: string): Promise<void> {
    try {
      const option = this.configOptions.find((o) => o.category === 'mode');
      if (option?.id) {
        const r = await this.proc.request<SessionResult>('session/set_config_option', { sessionId: this.sessionId, configId: option.id, value: want });
        this.noteOptions(r ?? {});
      } else {
        await this.proc.request('session/set_mode', { sessionId: this.sessionId, modeId: want });
        this.currentMode = want;
      }
    } catch (e) {
      if (this.effectiveMode() !== 'full') throw new Error(`Couldn't put ${providerName(this.deps.agent.provider)} in its ${want} mode, so this thread wasn't started (${(e as Error).message}).`);
      this.deps.log.info('could not set the agent mode', { threadId: this.opts.threadId, want, error: String(e) });
      return;
    }
    if (this.currentMode !== want && this.effectiveMode() !== 'full') throw new Error(`Couldn't put ${providerName(this.deps.agent.provider)} in its ${want} mode, so this thread wasn't started.`);
  }

  private modeChain: Promise<unknown> = Promise.resolve();

  private async applyModel(model: string): Promise<void> {
    const option = this.configOptions.find((o) => o.category === 'model');
    if (!option?.id) return;
    try {
      const r = await this.proc.request<SessionResult>('session/set_config_option', { sessionId: this.sessionId, configId: option.id, value: model });
      this.noteOptions(r ?? {});
    } catch (e) {
      this.deps.log.warn('could not set the model', { threadId: this.opts.threadId, model, error: String(e) });
      this.sink.output({ kind: 'event', event: { type: 'system.note', text: `${model} couldn't be picked, so this turn uses ${this.modelNow() ?? 'the default model'}.` } });
    }
  }

  // An agent that has a thought_level option (Grok's reasoning_effort,
  // Antigravity's thinking_level, OpenCode 2's effort) takes the thread's
  // effort there; undefined resets to an explicit "default" option when the
  // agent offers one, else the model's own default level.
  private async applyEffort(effort: EffortLevel | undefined): Promise<void> {
    const option = this.configOptions.find((o) => o.category === 'thought_level');
    if (!option?.id) return;
    const model = this.modelNow();
    const modelDefault = model ? (this.ownEfforts.get(model)?.defaultEffort ?? this.opts.account.models?.find((m) => m.id === model)?.defaultEffort) : undefined;
    const value: string | undefined = effort ?? (optionValues(option.options).includes('default') ? 'default' : modelDefault);
    if (!value || value === option.currentValue) return;
    try {
      const r = await this.proc.request<SessionResult>('session/set_config_option', { sessionId: this.sessionId, configId: option.id, value });
      this.noteOptions(r ?? {});
    } catch (e) {
      this.deps.log.warn('could not set the effort', { threadId: this.opts.threadId, effort: value, error: String(e) });
      this.sink.output({ kind: 'event', event: { type: 'system.note', text: `${value} effort couldn't be set, so this turn uses ${String(this.effortNow() ?? "the model's own level")}.` } });
    }
  }

  private effortNow(): EffortLevel | undefined {
    const v = this.configOptions.find((o) => o.category === 'thought_level')?.currentValue;
    return isEffortLevel(v) ? v : undefined;
  }

  // ---- From the agent

  private notification(method: string, params: unknown): void {
    if (this.guard && !this.replaying && this.checkGuard(method, params)) return;
    if (!this.replaying) this.noteFailure(method, params);
    if (this.replaying || method !== 'session/update' || !isPlainObject(params)) return;
    if (this.sessionId && params.sessionId !== undefined && params.sessionId !== this.sessionId) return;
    this.noteFrame(params.update);
    const update = this.mapInput(params.update);
    if (isPlainObject(update)) {
      if (update.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') this.currentMode = update.currentModeId;
      if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) this.noteOptions({ configOptions: update.configOptions as ConfigOption[] });
      if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) this.noteCommands(update.availableCommands);
    }
    const outputs = this.normalizer.handle(update);
    const updateKind = isPlainObject(update) && typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
    if (!this.turn && this.state === 'ready' && this.deps.agent.wakesAfterTasks && updateKind && TURN_UPDATES.has(updateKind) && outputs.length > 0) {
      this.openUnsolicitedTurn();
    }
    this.emit(outputs);
    if (this.turn?.unsolicited) {
      if (outputs.some((o) => o.kind === 'event' && o.event.type === 'tool.call' && o.event.name !== END_TURN_FULL_NAME)) {
        this.turn.endTurnAccepted = false;
        this.turn.sawText = false;
        this.turn.lastActivity = 'other';
      } else if (updateKind === 'agent_message_chunk' && outputs.some((o) => o.kind === 'delta' && o.delta.type === 'assistant.text.delta')) {
        this.turn.sawText = true;
        this.turn.lastActivity = 'text';
      } else if (outputs.some((o) => o.kind === 'delta' || o.kind === 'event')) {
        this.turn.lastActivity = 'other';
      }
      this.syncUnsolicitedSettle();
    }
    if (this.turn && this.deps.agent.provider === 'antigravity' && this.antigravityUpdate(this.turn, update, outputs)) {
      this.chunkBuffer = '';
      return;
    }
    if (isPlainObject(params.update)) {
      const u = params.update;
      if (u.sessionUpdate === 'agent_message_chunk') {
        const chunkText = isPlainObject(u.content) && typeof u.content.text === 'string' ? u.content.text : typeof u.text === 'string' ? u.text : '';
        if (chunkText && this.chunkBuffer.length < 300) {
          this.chunkBuffer += chunkText;
          if (isFatalExecutionError(this.chunkBuffer)) {
            this.failFatalDiagnostic(this.chunkBuffer, true);
            return;
          }
        }
      } else if (u.sessionUpdate === 'tool_call_update' && u.status === 'failed') {
        this.chunkBuffer = '';
        const text = textFromUpdate(u);
        if (text && isFatalExecutionError(text)) {
          this.failFatalDiagnostic(text);
          return;
        }
      } else {
        this.chunkBuffer = '';
      }
    }
  }

  // Antigravity can send the error text and the failed status in separate
  // updates. The normalizer joins them before it emits the failed result.
  private antigravityUpdate(turn: Turn, update: unknown, outputs: AdapterOutput[]): boolean {
    for (const output of outputs) {
      if (output.kind !== 'event' || output.event.type !== 'tool.result' || output.event.ok) continue;
      const message = output.event.text?.trimStart();
      if (!message || !isFatalExecutionError(message)) continue;
      const prefix = message.match(ANTIGRAVITY_EXECUTOR_429)?.[0];
      // An executor 429 can also be a transient requests-per-minute limit.
      // Only the individual-quota diagnostic warrants a watchdog.
      if (prefix && ANTIGRAVITY_INDIVIDUAL_QUOTA.test(message.slice(prefix.length)) && ANTIGRAVITY_EXHAUSTED_STATUS.test(message)) {
        turn.quota ??= { message, earlierTools: new Set(this.callFrames.keys()) };
      } else if (!prefix || !ANTIGRAVITY_RATE_RETRY.test(message) || outOfUsage({ message })) {
        this.failFatalDiagnostic(message);
      }
      this.syncQuotaDeadline();
      return true;
    }
    if (!turn.quota) return false;
    // An announcement can come before the frame that links a renamed tool
    // to an earlier approval. Wait for work with a distinct identity.
    const toolId = isPlainObject(update) && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
    const newTool = toolId && isPlainObject(update) &&
      (update.status === 'in_progress' || outputs.some((o) => o.kind === 'event' && o.event.type === 'tool.result' && o.event.ok)) &&
      this.normalizer.isNewToolWork(toolId, turn.quota.earlierTools);
    if (newTool || outputs.some((o) => o.kind === 'delta')) {
      clearTimeout(turn.quota.deadline?.timer);
      turn.quota = undefined;
    } else this.syncQuotaDeadline();
    return false;
  }

  private failFatalDiagnostic(message: string, streamed = false): void {
    const code = /(?:status|error)[:\s]+(\d{3})\b/i.exec(message)?.[1];
    const turn = this.turn;
    if (turn) {
      turn.failure = laterFailure(turn.failure, { message, ...(code ? { httpStatus: Number(code) } : {}) });
      // An executor banner alone may be the start of a billing diagnostic.
      // Keep its failure if the prompt replies, and cap the wait if it hangs.
      if (streamed && !code && EXECUTOR_BANNER.test(message.trimStart()) && !message.trimEnd().endsWith('")')) {
        turn.executorDiagnosticTimer ??= setTimeout(() => {
          if (this.turn === turn && this.state === 'turn') this.failFatal(turn.failure?.message ?? message);
        }, EXECUTOR_DIAGNOSTIC_GRACE_MS).unref();
        return;
      }
    }
    this.failFatal(message);
  }

  private syncQuotaDeadline(): void {
    const turn = this.turn;
    const quota = turn?.quota;
    if (!turn || !quota || this.state !== 'turn') return;
    if (turn.interrupted) return this.kill();
    const kind = this.pending.size ? undefined : this.normalizer.hasRunningTools() ? 'tools' : 'idle';
    if (kind === quota.deadline?.kind) return;
    clearTimeout(quota.deadline?.timer);
    quota.deadline = undefined;
    if (!kind) return;
    const timer = setTimeout(() => {
      if (this.turn === turn && turn.quota === quota && this.state === 'turn') this.failFatal(quota.message, true);
    }, kind === 'tools' ? ANTIGRAVITY_QUOTA_TOOL_GRACE_MS : ANTIGRAVITY_QUOTA_GRACE_MS);
    timer.unref();
    quota.deadline = { kind, timer };
  }

  // A fatal harness crash or agent execution termination leaves the agent's
  // background process unresponsive to session/prompt. Terminate the session
  // at once so the turn ends in error rather than hanging forever.
  private failFatal(detail: string, quotaTimedOut = false): void {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.state = 'closing';
    this.stopShellPoll();
    this.held = [];
    const fail = this.turn ? this.failureFor(this.turn, new Error(detail)) : { error: detail };
    const errorText = fail.error ?? detail;
    const err = fail.errorKind === 'usageLimit' ? new SessionUsageLimitError(errorText) : new Error(errorText);
    if (quotaTimedOut) this.deps.log.info('antigravity did not finish the prompt after reaching its quota', { threadId: this.opts.threadId });
    else this.deps.log.error('acp fatal execution error; terminating session', { threadId: this.opts.threadId, error: errorText, errorKind: fail.errorKind });
    this.proc.kill(new AcpExitedError(errorText));
    this.exited(err);
  }

  // Grok says why a turn failed in its own notes, not only in the prompt's
  // answer: a retry_state that failed ("API error (status 402 Payment
  // Required): Grok Build usage balance exhausted"), then turn_completed with
  // the error and its data. Kept for the turn, for failureFor.
  private noteFailure(method: string, params: unknown): void {
    const turn = this.turn;
    if (!turn || !isPlainObject(params)) return;
    if (this.sessionId && params.sessionId !== undefined && params.sessionId !== this.sessionId) return;
    const note = failureNote(method, params.update);
    if (note) turn.failure = laterFailure(turn.failure, note);
  }

  // Grok reports each hook it ran (hook_execution) as a prompt goes in and
  // before each tool. Threadbear's must be among them: a folder's config can
  // turn a plugin off, and then nothing would ask. Anything from the model in
  // a turn before that report, or a report without it, stops the thread
  // there, before any tool runs. True when it stopped it.
  private checkGuard(method: string, params: unknown): boolean {
    if (!isPlainObject(params) || !isPlainObject(params.update)) return false;
    const u = params.update;
    if (method.endsWith('x.ai/session_notification') && u.sessionUpdate === 'hook_execution' && (u.event_name === 'user_prompt_submit' || u.event_name === 'pre_tool_use')) {
      const ran = Array.isArray(u.runs) && u.runs.some((r) => isPlainObject(r) && typeof r.name === 'string' && r.name.startsWith(`plugin/${this.guard}/`));
      if (ran) {
        if (u.event_name === 'user_prompt_submit') this.guardSeen = true;
        return false;
      }
      return this.guardMissing();
    }
    const fromModel = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan']);
    if (method === 'session/update' && this.turn && !this.guardSeen && fromModel.has(String(u.sessionUpdate))) return this.guardMissing();
    return false;
  }

  private guardMissing(): boolean {
    if (this.state === 'closed') return true;
    const name = providerName(this.deps.agent.provider);
    this.deps.log.error('acp guard hook did not run', { threadId: this.opts.threadId, guard: this.guard });
    this.state = 'closing';
    this.proc.kill();
    this.exited(new Error(`${name} didn't run Threadbear's hook that makes it ask before using tools (a folder's .grok/config.toml can turn plugins off), so this thread was stopped before it could use any.`));
    return true;
  }

  // A tool call's arguments in the names the runner reads (AcpAgent.toolInput).
  private mapInput(u: unknown): unknown {
    if (!isPlainObject(u) || u.rawInput == null) return u;
    const frames = typeof u.toolCallId === 'string' ? this.callFrames.get(u.toolCallId) : undefined;
    const map = this.deps.agent.toolInput;
    const raw = u.rawInput;
    const input = map && isPlainObject(raw) ? map(raw, frames?.mcp ? { ...u, mcp: true } : u) : raw;
    // ACP treats omission/null as no update. An explicit empty object is
    // new input, so a helper question cannot reuse replaced arguments.
    if (this.opts.coordinator && frames) frames.scopedInput = isPlainObject(input) ? input : {};
    return input === raw ? u : { ...u, rawInput: input };
  }

  // A read the agent's own rules would allow (AcpAgent.readsInFolderGoAhead):
  // only the arguments its read tools have, each path spelled whole (no
  // `..`, which the disk reads after a link and path.resolve before it, and
  // no `~`), and inside the thread's folder as the disk has it, a link out
  // of the folder being where it goes. Anything else gets a card (Codex's
  // and Gemini's reviews, 20 Nov 2026). The file is opened by the agent
  // after this: a link swapped in between is the same race other agents'
  // own read rules have.
  private readGoesAhead(call: AcpToolCall, earlier: string[]): boolean {
    const keys = this.deps.agent.readsInFolderGoAhead;
    const raw = call.rawInput;
    if (!keys || !isPlainObject(raw) || !Object.keys(raw).length) return false;
    // Never an MCP server's tool, whatever kind it says it is, in any frame.
    const frames = typeof call.toolCallId === 'string' && call.toolCallId !== '' ? this.callFrames.get(call.toolCallId) : undefined;
    // Its history is needed: every frame must have been a read.
    if (!frames || frames.mcp || isMcpFrame(call) || [...frames.kinds].some((k) => k !== 'read')) return false;
    const plain = (o: Record<string, unknown>) => Object.entries(o).every(([k, v]) => keys.has(k) && typeof v === keys.get(k) && v !== '');
    // Its own arguments, and every argument list earlier frames carried.
    if (!plain(raw) || !frames.inputs.every(plain)) return false;
    if (!Object.keys(raw).some((k) => keys.get(k) === 'string')) return false;
    const paths = [...new Set([...earlier, ...frames.paths, ...requestPaths(call)])];
    const folder = realFolder(this.opts.cwd);
    if (!folder || !paths.length) return false;
    return paths.every((p) => {
      if (!path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) return false;
      const real = realFolder(p);
      return real !== undefined && (real === folder || real.startsWith(folder + path.sep));
    });
  }

  // Whether a file is inside the thread's folder, as the disk has it: the
  // nearest part of its path that exists, links followed.
  private inFolder(f: string): boolean {
    const folder = realFolder(this.opts.cwd);
    const whole = this.diskPlace(f);
    return Boolean(folder) && whole !== undefined && (whole === folder || whole.startsWith(folder + path.sep));
  }

  // Where a file is on the disk: its nearest part that exists with links
  // followed, plus the rest. Undefined when that can't be said for certain.
  private diskPlace(f: string): string | undefined {
    if (!path.isAbsolute(f) || f.split(/[\\/]/).includes('..')) return undefined;
    let dir = f;
    let real: string | undefined;
    for (; ; dir = path.dirname(dir)) {
      real = realFolder(dir);
      if (real !== undefined || path.dirname(dir) === dir) break;
      // There but not resolvable: a link to somewhere that doesn't exist yet
      // (or a loop), which a write would follow outside (Codex's and
      // Gemini's seventh reviews, 20 Nov 2026).
      try {
        fs.lstatSync(dir);
        return undefined;
      } catch {
        // Not there at all: a new file or folder, judged by its parent.
      }
    }
    if (real === undefined) return undefined;
    return path.join(real, path.relative(dir, f));
  }

  private noteFrame(u: unknown): void {
    if (!isPlainObject(u) || typeof u.toolCallId !== 'string' || u.toolCallId === '') return;
    const f = this.callFrames.get(u.toolCallId) ?? { mcp: false, ids: new Set<string>(), names: new Set<string>(), acting: 0, named: new Map<string, number>(), inputs: [], kinds: new Set<string>(), paths: new Set<string>(), diffs: [], otherContent: [] };
    // Which tool the frame says it is: Antigravity's _meta.mcp, or the
    // tool_name Grok's use_tool carries. A frame that carries anything (its
    // arguments, an MCP mark) counts, named or not, so a call can be taken
    // for one of Threadbear's own tools only when every such frame named it
    // (Codex's and Gemini's ninth reviews, 20 Nov 2026).
    const raw = isPlainObject(u.rawInput) ? u.rawInput : undefined;
    const grokId = this.deps.agent.provider === 'grok' && typeof raw?.tool_name === 'string' && raw.tool_name.trim() ? raw.tool_name : undefined;
    const id = mcpIdOf(u) ?? grokId;
    if (id) f.ids.add(id);
    if (this.opts.coordinator) {
      // Grok's input names the actual tool. Retain it even if the same
      // frame also claims an MCP identity in _meta.
      if (grokId) f.ids.add(grokId);
      const mcpName = this.deps.agent.mcpToolName?.(u as AcpToolCall);
      if (mcpName) (f.confirmedMcp ??= new Set<string>()).add(mcpName);
      if (this.deps.agent.provider === 'antigravity' && isPlainObject(u._meta) && u._meta.is_mcp_tool_call === false) f.markedNative = true;
      if (this.deps.agent.provider === 'grok') {
        if (u.title === 'use_tool' || u.name === 'use_tool' || raw?.variant === 'UseTool') f.grokUseTool = true;
        if (typeof raw?.variant === 'string' && raw.variant !== 'UseTool') f.markedNative = true;
      }
    }
    if (typeof u.name === 'string' && u.name) f.names.add(u.name);
    const acting =
      (raw !== undefined && Object.keys(raw).length > 0) ||
      (u.rawInput !== undefined && u.rawInput !== null && raw === undefined) ||
      isMcpFrame(u) ||
      (typeof u.name === 'string' && u.name !== '') ||
      (Array.isArray(u.locations) && u.locations.length > 0) ||
      (Array.isArray(u.content) && u.content.length > 0);
    if (acting) {
      // What its latest frame says, as a digest: a call that goes back to an
      // earlier frame while its card waits still reads as changed (frameState).
      f.last = crypto.createHash('sha256').update(JSON.stringify([u.rawInput ?? null, u.kind ?? null, id ?? null, u.name ?? null, u.locations ?? null, Array.isArray(u.content) ? u.content : null])).digest('hex');
      f.acting++;
      if (id) f.named.set(id, (f.named.get(id) ?? 0) + 1);
    }
    for (const p of requestPaths(u as AcpToolCall)) f.paths.add(p);
    if (isMcpFrame(u)) f.mcp = true;
    if (typeof u.kind === 'string') f.kinds.add(u.kind);
    // Anything but a plain list of arguments is kept as one that no rule
    // passes.
    if (isPlainObject(u.rawInput)) {
      if (Object.keys(u.rawInput).length) f.inputs.push(u.rawInput);
    } else if (u.rawInput !== undefined && u.rawInput !== null) f.inputs.push({ '': u.rawInput });
    if (Array.isArray(u.content)) {
      for (const c of u.content) {
        if (isPlainObject(c) && c.type === 'diff') f.diffs.push(c);
        else if (c !== undefined && c !== null) f.otherContent.push(c);
      }
    }
    this.callFrames.set(u.toolCallId, f);
  }

  private noteCommands(raw: unknown[]): void {
    this.cliCommands = raw.flatMap((c) => {
      if (!isPlainObject(c) || typeof c.name !== 'string' || !c.name) return [];
      return [{ name: c.name, source: 'cli' as const, ...(typeof c.description === 'string' ? { description: c.description } : {}) }];
    });
  }

  private emit(outs: AcpOutput[]): void {
    for (const o of outs) {
      if (this.mcpOwnsEndTurn && o.kind === 'event') {
        if (o.event.type === 'tool.call' && o.event.name === END_TURN_FULL_NAME) {
          this.suppressedToolIds.add(o.event.itemId);
          continue;
        }
        if (o.event.type === 'tool.result' && this.suppressedToolIds.delete(o.event.itemId)) {
          // A policy refusal here prevented end_turn from reaching MCP, so
          // there is no MCP row to explain it.
          if (o.toolRefusal) this.sink.output({ kind: 'event', event: { type: 'system.note', text: o.toolRefusal } });
          continue;
        }
      }
      if (o.kind === 'event' && o.event.type === 'tool.result' && (o.toolRefusal || o.backgroundShell)) {
        const { itemId, images } = o.event;
        if (o.toolRefusal) {
          this.sink.output({ kind: 'event', event: { type: 'tool.result', itemId, ok: false, text: o.toolRefusal, truncated: false, images } });
        } else {
          this.sink.output({ kind: 'event', event: o.event });
        }
      } else this.sink.output(o);
      if (o.backgroundShell) this.noteBackgroundShell(o.backgroundShell);
    }
  }

  private mcpToolStart(toolName: string, args: Record<string, unknown>): string | undefined {
    if (!this.mcpOwnsEndTurn || toolName !== END_TURN_TOOL) return undefined;
    const turn = this.turn;
    if (!turn || this.state !== 'turn') return undefined;
    // Before session/prompt is sent (e.g. awaiting model/effort/mode setup),
    // any end_turn belongs to a superseded background turn and must not attach
    // to the user's pending turn.
    if (!turn.unsolicited && !turn.dispatched) return undefined;
    this.emit(this.normalizer.flush());
    const itemId = `mcp-end-turn-${crypto.randomUUID()}`;
    this.openMcpCalls.set(itemId, turn);
    if (turn.unsolicited) this.syncUnsolicitedSettle();
    this.sink.output({
      kind: 'event',
      event: { type: 'tool.call', itemId, name: END_TURN_FULL_NAME, kind: 'mcp', title: END_TURN_TOOL, input: truncateInput(args) },
    });
    return itemId;
  }

  private mcpToolResult(itemId: string, ok: boolean, text: string): void {
    const turn = this.openMcpCalls.get(itemId);
    if (!turn || this.turn !== turn) {
      this.openMcpCalls.delete(itemId);
      return;
    }
    this.openMcpCalls.delete(itemId);
    this.sink.output({
      kind: 'event',
      event: { type: 'tool.result', itemId, ok, ...truncateResultText(text, itemId, this.ctx), images: [] },
    });
    if (turn.unsolicited) {
      if (ok) {
        turn.endTurnAccepted = true;
        // One-reply end_turn asks for the final message after acceptance; any
        // progress text written beforehand must not shorten that wait window.
        if (endTurnWantsReply({ ok, text })) turn.sawText = false;
      } else turn.lastActivity = 'other';
      this.syncUnsolicitedSettle();
    }
  }

  private closeOpenMcpCalls(reason: string): void {
    for (const itemId of [...this.openMcpCalls.keys()]) {
      this.openMcpCalls.delete(itemId);
      this.sink.output({
        kind: 'event',
        event: { type: 'tool.result', itemId, ok: false, text: reason, truncated: false, images: [] },
      });
    }
  }

  private request(id: RequestId, method: string, params: unknown): void {
    if (method === 'session/request_permission' && !this.replaying) {
      if (!this.turn && this.state === 'ready' && this.deps.agent.wakesAfterTasks) this.openUnsolicitedTurn();
      const p = (isPlainObject(params) ? params : {}) as { toolCall?: AcpToolCall; options?: PermissionOption[]; _meta?: unknown };
      // Its own frame counts in the call's history too, as sent.
      this.noteFrame(p.toolCall);
      const call = isPlainObject(p.toolCall) ? withoutHookNote(this.mapInput(p.toolCall) as AcpToolCall, p._meta) : p.toolCall;
      // Never left unanswered: the turn would hang with session/prompt open.
      this.permission(id, { ...p, toolCall: call }).catch((e: unknown) => {
        this.deps.log.error('acp permission handler threw', { threadId: this.opts.threadId, error: String(e) });
        this.pending.delete(id);
        this.proc.respond(id, { outcome: { outcome: 'cancelled' } });
        this.syncQuotaDeadline();
        this.syncUnsolicitedSettle();
      });
      return;
    }
    if (method === 'elicitation/create' && !this.replaying) {
      if (!this.turn && this.state === 'ready' && this.deps.agent.wakesAfterTasks) this.openUnsolicitedTurn();
      this.form(id, isPlainObject(params) ? params : {}).catch((e: unknown) => {
        this.deps.log.error('acp form handler threw', { threadId: this.opts.threadId, error: String(e) });
        this.pending.delete(id);
        this.proc.respond(id, { action: 'cancel' });
        this.syncQuotaDeadline();
        this.syncUnsolicitedSettle();
      });
      return;
    }
    // We said we offer no fs or terminal, and the extensions aren't handled
    // yet: refused at once, so nothing hangs waiting for an answer.
    this.deps.log.info('refused an ACP request', { threadId: this.opts.threadId, method });
    this.proc.respondError(id, -32601, `Threadbear doesn't handle ${method}.`);
  }

  // An option by kind: only the once kinds, as "always" would be remembered
  // by the agent, past this thread and anything Mike can see. "Always
  // allow" is kept by the runner instead (EDIT_RULE and commandRule).
  // `call`: the request's tool call id in the normalizer (noteCall), which
  // learns whether it went ahead.
  private answer(id: RequestId, options: PermissionOption[], allow: boolean, call?: string, refusal?: string): void {
    const kind = allow ? 'allow_once' : 'reject_once';
    const optionId = options.find((o) => o?.kind === kind)?.optionId;
    if (call !== undefined) this.normalizer.answered(call, allow && optionId !== undefined, refusal);
    // No plain allow or reject on offer: nothing ever goes ahead by default.
    this.proc.respond(id, optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
    this.syncQuotaDeadline();
  }

  // One of Agent Archive's read tools, by name, with every frame of the call
  // saying it was that same tool and none running or writing anything, as
  // for the threadbear tools below. A call with no history never counts.
  private archiveRead(mcpName: string | undefined, frames: ReturnType<typeof this.callFrames.get>): boolean {
    return Boolean(this.archiveOurs && this.deps.agent.trustsRunnerMcp && mcpName && archiveReadTool(mcpName) && this.sameMcpTool(mcpName, frames));
  }

  private sameMcpTool(mcpName: string, frames: ReturnType<typeof this.callFrames.get>): boolean {
    return Boolean(frames && frames.ids.size === 1 && frames.ids.has(mcpName) && frames.named.get(mcpName) === frames.acting &&
      frames.kinds.size <= 1 && ![...frames.kinds].some((k) => k === 'execute' || writesFiles(k)));
  }

  private matchesMcpName(name: string, mcpName: string): boolean {
    if (name === mcpName || name === `mcp__${mcpName}`) return true;
    // These spellings only corroborate an MCP identity already confirmed
    // by the provider. They never establish one on their own.
    if (this.deps.agent.provider === 'grok') return name === 'use_tool';
    const separator = mcpName.indexOf('__');
    if (this.deps.agent.provider !== 'antigravity' || separator < 0) return false;
    const server = mcpName.slice(0, separator);
    const tool = mcpName.slice(separator + 2);
    return name === tool || name === `${server}_${tool}` || name === `${server.replaceAll('-', '_')}_${tool}`;
  }

  private async permission(id: RequestId, p: { toolCall?: AcpToolCall; options?: PermissionOption[] }): Promise<void> {
    const options = Array.isArray(p.options) ? p.options : [];
    const frames = typeof p.toolCall?.toolCallId === 'string' && p.toolCall.toolCallId !== '' ? this.callFrames.get(p.toolCall.toolCallId) : undefined;
    const mcpCall = Boolean(frames?.mcp) || (p.toolCall !== undefined && isMcpFrame(p.toolCall));
    const coord = this.opts.coordinator;
    const mcpName = coord ? frames?.confirmedMcp?.values().next().value : p.toolCall ? this.deps.agent.mcpToolName?.(p.toolCall) : undefined;
    const ownMcp = Boolean(mcpName && this.ownTools.has(mcpName) && this.sameMcpTool(mcpName, frames));
    const seen = this.normalizer.noteCall(p.toolCall ?? {});
    this.emit(this.normalizer.flush());
    if (coord) {
      const unverifiable = 'The runner could not verify this coordinator operation.';
      const next = coord.role === 'helper' ? HELPER_REPORT : 'Delegate implementation to a helper with the coordinator tool (startHelper).';
      const inconsistent = `Its frames did not consistently identify the operation. ${next}`;
      const toolName = frames?.names.values().next().value;
      const mcpId = frames?.ids.values().next().value;
      const readOnlyMcp = this.archiveRead(mcpName, frames);
      // Even the permission request can be an id-only update. The earlier
      // name, kind and provider-confirmed MCP identity still apply, provided
      // every supplied value agrees.
      const namesAgree = mcpName === undefined ? (frames?.names.size ?? 0) <= 1 :
        Array.from(frames?.names ?? []).every((name) => this.matchesMcpName(name, mcpName));
      if (!frames || !namesAgree || frames.kinds.has('') || frames.kinds.size > 1 || frames.ids.size > 1 || (frames.confirmedMcp?.size ?? 0) > 1 ||
          (mcpName !== undefined && mcpId !== mcpName) || ((mcpCall || mcpName !== undefined) && frames.markedNative) ||
          (coord.role === 'coordinator' && frames.diffs.length > 0)) {
        return this.answer(id, options, false, seen.id, `Threadbear blocked this tool call. ${inconsistent}`);
      }
      const kind = frames.kinds.values().next().value;
      // An unconfirmed external identity can't grant a scope exception,
      // but a helper may still use external tools within its ordinary mode.
      const external = mcpCall || mcpId !== undefined || Boolean(frames.grokUseTool);
      const unverifiedThreadbear = mcpId !== undefined && threadbearToolName(mcpId) !== undefined && !ownMcp;
      const input = frames.scopedInput ?? {};
      const rawArgs = frames.grokUseTool && mcpName !== undefined && input.tool_name === mcpName && isPlainObject(input.tool_input) ? input.tool_input : input;
      const policy = acpCoordinatorTool({ role: coord.role, kind, name: toolName, mcpName, external, readOnlyMcp });
      // Antigravity can report websearch as `other`. Its name only explains
      // the refusal. Neither the name nor the query proves it is read-only.
      const unclassifiedSearch = coord.role === 'coordinator' && this.deps.agent.provider === 'antigravity' && !external &&
        (seen.name ?? seen.title) === 'websearch' && (kind === 'other' || kind === undefined);
      const policyReason = policy.reason && unclassifiedSearch
        ? 'Threadbear could not verify this web search as read-only. Delegate the lookup to a helper with the coordinator tool (startHelper).'
        : policy.reason;
      const checkName = mcpName ? `mcp__${mcpName}` : (toolName ?? kind ?? 'tool');
      let gateRefusal: string | undefined;
      try {
        gateRefusal = coord.checkTool({ name: checkName, input: rawArgs, agentId: coord.role === 'helper' ? this.opts.threadId : undefined });
      } catch {
        gateRefusal = unverifiable;
      }
      if (!gateRefusal && !external && coord.role === 'helper' && (kind === undefined || kind === 'other') && toolName && isHelperQuestionTool(toolName)) {
        const rawQs = Array.isArray(rawArgs.questions) ? rawArgs.questions : [];
        const qs: Question[] = rawQs
          .filter((q): q is Record<string, unknown> => isPlainObject(q) && typeof q.question === 'string')
          .map((q) => ({ question: String(q.question), header: typeof q.header === 'string' ? q.header : 'Helper question', options: Array.isArray(q.options) ? q.options.filter((o): o is { label: string; description?: string } => isPlainObject(o) && typeof o.label === 'string') : [], multiSelect: Boolean(q.multiSelect ?? q.is_multi_select) }));
        if (qs.length) coord.helperQuestion?.(this.opts.threadId, qs);
      }
      const refused = gateRefusal ?? policyReason ?? (unverifiedThreadbear ? inconsistent : undefined);
      if (refused) {
        // ACP has no reason field for a rejected permission. Keep the
        // reason on our row even if the agent calls it a user decision.
        return this.answer(id, options, false, seen.id, `Threadbear blocked this tool call. ${refused}`);
      }
    }
    // Read at the moment it's asked, not when the turn began.
    if (this.mode === 'full') return this.answer(id, options, true, seen.id);
    // Agent Archive only reads, so its tools go ahead in any mode.
    if (this.archiveRead(mcpName, frames)) return this.answer(id, options, true, seen.id);
    // One of this session's own threadbear tools: its MCP server asks where
    // the tool needs it (tool-gate.ts), so a card here would be a second one.
    // Grok names the tool exactly, and a name it can't find doesn't run.
    // Only when every frame of the call said it was that same tool, and one
    // kind of call: a later frame can't make another server's tool ours
    // (Codex's eighth review, 20 Nov 2026).
    // A call with no id has no history to check, so it never goes ahead this
    // way (Codex's tenth review, 20 Nov 2026).
    if (ownMcp) return this.answer(id, options, true, seen.id);

    const { kind } = seen;
    // A read of the thread's own files, for an agent whose own rules can't
    // say so (Antigravity asks before every tool).
    if (kind === 'read' && p.toolCall && !mcpName && !mcpCall && this.readGoesAhead(p.toolCall, seen.paths)) return this.answer(id, options, true, seen.id);
    // Another MCP server's tool, whatever kind it says it is: never a local
    // command or edit, so no saved rule covers it and its card shows every
    // argument as an MCP tool's does. Grok's UseTool wrapper (even with an
    // empty tool_name) is also an external/deferred call, never a plain local tool.
    const rawInEarly = isPlainObject(p.toolCall?.rawInput) ? p.toolCall.rawInput : undefined;
    const grokUseTool = this.deps.agent.provider === 'grok' && (rawInEarly?.variant === 'UseTool' || p.toolCall?.name === 'use_tool' || frames?.names.has('use_tool'));
    const external = mcpCall || mcpName !== undefined || Boolean(grokUseTool);
    // What this request names and what earlier updates to the call said:
    // more names only makes the check stricter.
    const paths = [...new Set([...seen.paths, ...(frames?.paths ?? []), ...requestPaths(p.toolCall ?? {})].map((f) => absolutePath(f, this.opts.cwd)))];
    // Arguments that aren't a list of names and values are shown as they came
    // (Codex's and Gemini's fifth reviews, 20 Nov 2026: they made an empty card).
    const rawIn = p.toolCall?.rawInput;
    const input: Record<string, unknown> = isPlainObject(rawIn) && Object.keys(rawIn).length ? rawIn : rawIn !== undefined && rawIn !== null && !isPlainObject(rawIn) ? { 'arguments as sent': rawIn } : seen.input;
    // Whether every frame of this call agrees with this request (its own
    // frame, as sent, is the last kept): each earlier one the same kind, and
    // every argument it carried here too with the same value (Grok adds
    // `variant` when it asks). If not, no saved rule covers it and no short
    // card stands for it.
    // Every frame's arguments must agree, except an edit's: its files are
    // taken from every frame and each frame must be a plain edit, as
    // OpenCode names an edit's arguments differently while it runs and when
    // it asks ({filePath, content}, then {filepath, diff}; Gemini's sixth
    // review, 20 Nov 2026).
    const last = frames?.inputs.at(-1) ?? {};
    const consistent = !frames || (frames.kinds.size <= 1 && ((writesFiles(seen.kind) && !mcpCall) || frames.inputs.every((i) => Object.entries(i).every(([k, v]) => Object.hasOwn(last, k) && JSON.stringify(v) === JSON.stringify(last[k])))));
    // A key a plain object can't hold as its own would go missing from the
    // card (cardInput): such a call is refused, never shown short.
    if (Object.hasOwn(input, '__proto__')) {
      this.sink.output({ kind: 'event', event: { type: 'system.note', text: "A tool call had an argument named __proto__, which a card can't show, so it was refused." } });
      return this.answer(id, options, false, seen.id);
    }
    const command = !external && kind === 'execute' && typeof input.command === 'string' ? input.command : '';
    const argv = command ? shellWords(command) : null;
    // A tool can name its own folder (OpenCode's workdir): the rule and the
    // card go by where the command really runs.
    // Each as the disk has it (realpath(3): a link followed before any "..",
    // as chdir does), bound to the rule that way, so `link/..` or a link
    // pointed somewhere new isn't the folder a rule was saved for. One that
    // can't be resolved, or that reads differently taken as written (as a CLI
    // that tidies the path first would use it), is somewhere unknown (Codex's
    // review, 10 Nov).
    const named = FOLDER_KEYS.map((k) => input[k]).filter((d): d is string => typeof d === 'string' && d !== '');
    const resolve = () =>
      named.map((d) => {
        // `~` is the home folder to a shell, whatever the folder holds.
        if (d.startsWith('~')) return undefined;
        const disk = realFolder(path.isAbsolute(d) ? d : `${this.opts.cwd}/${d}`);
        return disk !== undefined && disk === realFolder(absolutePath(d, this.opts.cwd)) ? disk : undefined;
      });
    const places = resolve();
    const baseReal = realFolder(this.opts.cwd);
    const said = [...new Set(places.filter((d): d is string => d !== undefined))];
    const unknownPlace = places.includes(undefined);
    const where = said[0] ?? (named[0] !== undefined ? absolutePath(named[0], this.opts.cwd) : (baseReal ?? this.opts.cwd));
    // A saved rule is for this command in this folder and nothing else. Two
    // folders that disagree, or anything else the call carries that could
    // change what runs (an env, a shell, a folder under a name not listed
    // here), and it can't be known which applies: no rule covers it, Always
    // allow isn't offered, and the card shows the lot (Daybreak, 10 Nov).
    // An agent whose session runs from a folder of its own (ownSessionFolder)
    // runs a command with no folder, or a relative one, from there, not the
    // thread's: only a whole path says where.
    const placeKnown = !this.deps.agent.ownSessionFolder || (named.length > 0 && named.every((d) => path.isAbsolute(d)));
    const exact = Boolean(command) && placeKnown && !unknownPlace && said.length <= 1 && Object.entries(input).every(([k, v]) => k === 'command' || (BENIGN_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number')) || (FOLDER_KEYS.includes(k) && (typeof v === 'string' || v === undefined)));
    // A command that also names files of its own (locations, a path among its
    // arguments) says more than its command and folder: no rule covers it,
    // and its card shows the lot (Gemini's tenth review, 20 Nov 2026). A tool
    // name doesn't change what a command runs.
    const saysMore = paths.length > 0;
    const rule = exact && consistent && !saysMore && argv?.length && ruleMayCover(argv) ? commandRule(argv, where) : null;

    let code: CodeWrite = false;
    const edits = !external && writesFiles(kind);
    let outside = false;
    // An agent whose session has a folder of its own reads a relative path
    // from there, not the thread's: which file it is isn't known.
    // Every path as the agent spelled it, before any tidying: `link/..` is
    // somewhere else on the disk than it reads, and `~` is the home folder
    // to some tools, so a path with either says no file for certain.
    const spelled = [...seen.paths, ...(frames?.paths ?? []), ...requestPaths(p.toolCall ?? {})];
    const relative = spelled.some((f) => f.split(/[\\/]/).includes('..') || f.startsWith('~')) || (Boolean(this.deps.agent.ownSessionFolder) && spelled.some((f) => !path.isAbsolute(f)));
    if (edits) {
      // An edit with no named files can't be checked: it asks every time.
      code = paths.length ? this.runsAsCode(paths) : 'unsure';
      if (!code && (!isPlainEdit(input) || !(frames?.inputs ?? []).every(isPlainEdit) || !consistent || relative)) code = 'unsure';
      // The edit rule is for the thread's own files: one outside its folder
      // always asks (Antigravity has no gate of its own for that, as
      // OpenCode's external_directory is; Gemini's sixth review).
      outside = !paths.every((f) => this.inFolder(f));
      if (!code && !outside && this.rules.has(EDIT_RULE)) return this.answer(id, options, true, seen.id);
    } else if (paths.length && kind !== 'read' && kind !== 'search' && kind !== 'fetch' && kind !== 'think') {
      // A kind that doesn't say what it does, naming a file that runs.
      code = this.runsAsCode(paths);
    }
    // A saved rule doesn't stand in for a file that runs as code.
    if (!code && rule && this.rules.has(rule)) return this.answer(id, options, true, seen.id);

    const title = command
      ? firstLineSafely(command, 200, '…')
      : edits && paths.length === 1
        ? `${kind === 'delete' ? 'Delete' : kind === 'move' ? 'Move' : 'Edit'} ${displayPath(paths[0], this.opts.cwd)}`
        : firstLineSafely(seen.title || kind || 'Use a tool', 200, '…');
    // The folder as the agent gave it goes on the card too when it reads
    // differently (a link): what the card says it resolved to is checked
    // again once it's answered, below.
    // The folder as given, when it differs from where it resolved; `cwd`
    // itself always says where it runs.
    const given = Object.fromEntries(FOLDER_KEYS.filter((k) => typeof input[k] === 'string' && input[k] !== where).map((k) => [k === 'cwd' ? 'cwd as given' : k, input[k]]));
    // A shell card shows only the command and the folder it runs in (and can
    // be allowed from the phone), so it's only for a call whose folder is
    // known and one, with nothing else that matters, each a plain value;
    // anything more shows every argument, as an MCP tool's card does
    // (Gemini's and Codex's reviews, 20 Nov 2026). Grok's `variant` names
    // its tool ("Bash").
    const reqContent = Array.isArray(p.toolCall?.content) ? p.toolCall.content : [];
    const dedup = <T,>(items: T[]): T[] => {
      const seenJson = new Set<string>();
      const out: T[] = [];
      for (const item of items) {
        const k = JSON.stringify(item);
        if (!seenJson.has(k)) {
          seenJson.add(k);
          out.push(item);
        }
      }
      return out;
    };
    const allDiffs = dedup([...(frames?.diffs ?? []), ...reqContent.filter((c): c is Record<string, unknown> => isPlainObject(c) && c.type === 'diff')]);
    const otherContent = dedup([...(frames?.otherContent ?? []), ...reqContent.filter((c) => c !== undefined && c !== null && !(isPlainObject(c) && c.type === 'diff'))]);
    const diffsAgree = edits && kind === 'edit' ? diffsAgreeWithInput(allDiffs, input, this.opts.cwd) : allDiffs.length === 0;
    const shellCard =
      Boolean(command) &&
      consistent &&
      !saysMore &&
      allDiffs.length === 0 &&
      otherContent.length === 0 &&
      placeKnown &&
      !unknownPlace &&
      said.length <= 1 &&
      Object.entries(input).every(([k, v]) => k === 'command' || (FOLDER_KEYS.includes(k) && (typeof v === 'string' || v === undefined)) || (k === 'variant' && v === 'Bash') || (BENIGN_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number')));
    // Any other command card says where it runs as a line of its own, known
    // or not, so the phone (which allows only a card whose one value is the
    // line it shows) never allows it.
    const runsIn = !placeKnown ? 'not known: its own scratch folder, unless the command says' : unknownPlace || said.length > 1 ? 'not known' : where;
    const mcpTool = (() => {
      const cleanName = mcpName && mcpName.split('__').every((s) => s.trim().length > 0) ? mcpName : undefined;
      if (cleanName) return cleanName;
      const meta = (p.toolCall as { _meta?: unknown } | undefined)?._meta;
      const m = isPlainObject(meta) && isPlainObject(meta.mcp) ? meta.mcp : undefined;
      return m && typeof m.server === 'string' && typeof m.tool === 'string' && m.server.trim() && m.tool.trim() ? `${m.server}__${m.tool}` : undefined;
    })();
    // Only two kinds of card are short: a plain shell command whose folder is
    // known (shellCard), and a plain edit of files inside the folder, where
    // every frame was a plain edit and every path is spelled whole. Every
    // other card shows the lot: which tool, its arguments as sent, whatever
    // earlier frames said differently, and every file it names as it was
    // spelled. Its arguments are an object, so the phone never allows it,
    // and nothing in it is drawn as a shell command (Codex's and Gemini's
    // eighth reviews, 20 Nov 2026: patching card shapes one at a time kept
    // leaving one short).
    const plainEdit = edits && !outside && !relative && diffsAgree && otherContent.length === 0 && isPlainEdit(input) && (frames?.inputs ?? []).every(isPlainEdit) && consistent && paths.length > 0 && !Object.hasOwn(input, 'arguments as sent');
    // An edit whose frames didn't all say the same (OpenCode's do differ)
    // shows what this request writes, as the preview may be an earlier
    // frame's.
    const editFramesDiffer = new Set((frames?.inputs ?? []).map((i) => JSON.stringify(i))).size > 1;
    const lastSent = JSON.stringify(frames?.inputs.at(-1) ?? rawIn ?? {});
    const earlier = [...new Set((frames?.inputs ?? []).map((i) => JSON.stringify(i)))].filter((i) => i !== lastSent).map((i) => JSON.parse(i) as unknown);
    const full = (): Record<string, unknown> => ({
      tool: { kind: kind ?? 'not said', ...(frames && frames.names.size ? { 'names it said': [...frames.names] } : {}), ...(frames && frames.ids.size && !external ? { 'tools it said': [...frames.ids] } : {}), ...(frames && frames.kinds.size > 1 ? { 'kinds it said': [...frames.kinds] } : {}), title: seen.title || p.toolCall?.title || 'not said', ...(typeof p.toolCall?.name === 'string' ? { name: p.toolCall.name } : {}), ...(external ? { 'MCP tool': mcpTool ?? 'not named', ...(frames && [...frames.ids].some((i) => i !== mcpTool) ? { 'MCP tools it said': [...frames.ids] } : {}) } : {}) },
      ...(command ? { command, 'runs in': runsIn } : kind === 'execute' && !external ? { 'runs in': runsIn } : {}),
      arguments: input,
      ...(allDiffs.length ? { diffs: allDiffs } : {}),
      ...(otherContent.length ? { content: otherContent } : {}),
      ...(earlier.length ? { 'said earlier': earlier } : {}),
      ...(spelled.length ? { 'files it names': [...new Set(spelled)] } : {}),
    });
    const fullData = shellCard ? undefined : full();
    const shown: Record<string, unknown> = shellCard
      ? { command, ...given, ...(typeof input.variant === 'string' ? { variant: input.variant } : {}), cwd: where }
      : plainEdit
        ? { ...(kind !== 'edit' ? { action: kind } : {}), paths, ...(editFramesDiffer ? { 'what it writes': input } : {}) }
        : fullData!;
    // Auto's card reviewer only sees what is in wholeInput. Any call whose
    // real action isn't shown whole here (an edit missing its content/diff,
    // naming files absent from rawInput, or contradicted by content diffs; a
    // binary/odd patch header; an empty command or unknown cwd; an unnamed or
    // conflicting MCP tool; or contradictory frames) goes straight to Mike.
    const rawPaths = edits && kind === 'edit' ? new Set(requestPaths({ rawInput: input }).map((f) => absolutePath(f, this.opts.cwd))) : undefined;
    // Files outside the folder once links are followed, and paths spelled
    // with `..`, `~` or relative to the agent's own folder: the reviewer
    // reads the spelling, not where it lands (a link in the folder to ~/.ssh,
    // `link/..`), so those are Mike's (Codex's and Gemini's reviews, 27 Nov).
    // A file with more than one hard link may be one outside too.
    const reachesOut = paths.some((f) => !this.inFolder(f) || (fileId(f)?.[2] ?? 1) > 1);
    const opaque =
      relative ||
      reachesOut ||
      !consistent ||
      Object.hasOwn(input, 'arguments as sent') ||
      hasOddPatchHeader(input) ||
      !diffsAgree ||
      otherContent.length > 0 ||
      (edits
        ? paths.length === 0 ||
          (kind === 'move' && paths.length < 2) ||
          (kind === 'edit' && (!hasEditContent(input) || !paths.every((f) => rawPaths!.has(f)))) ||
          (editFramesDiffer && !(frames?.inputs ?? []).every(isPlainEdit))
        : external
          ? !mcpTool || Boolean(frames && [...frames.ids].some((i) => i !== mcpTool))
          : kind === 'execute'
            ? !command.trim() || !placeKnown || unknownPlace || said.length > 1 || (named.length === 0 && !baseReal)
            : paths.length === 0 && Object.keys(input).length === 0);
    const card = cardInput(shown, plainEdit ? ['paths'] : 'all');
    if (card.tooLong) {
      this.sink.output({ kind: 'event', event: { type: 'system.note', text: tooLongForCard(card.tooLong) } });
      return this.answer(id, options, false, seen.id);
    }
    const editRule = edits && !code && !outside && paths.length > 0;
    // The card names the call's row, so the row comes first.
    this.emit(this.normalizer.showCall(seen.id));
    // What the call said and where its files are, to check again once it's
    // answered: an allow is for this, not for what it says or where its files
    // land by then (Codex's reviews, 27 Nov 2026: a frame during the card
    // reviewer's look; a parent folder swapped for a link to ~/.claude).
    const asked = frames ? frameState(frames) : '';
    // Which file each is too (device, inode, links), so one swapped for a
    // hard link to a file elsewhere reads as changed (Codex's re-check).
    const placesNow = () => JSON.stringify([paths.map((f) => [this.diskPlace(f) ?? null, fileId(f)]), this.runsAsCode(paths), paths.every((f) => this.inFolder(f))]);
    const placed = paths.length ? placesNow() : '';
    const pending: Pending = { abort: new AbortController(), options };
    this.pending.set(id, pending);
    this.syncQuotaDeadline();
    this.syncUnsolicitedSettle();
    let a: ToolApprovalAnswer;
    try {
      a = await this.sink.requestApproval({
        // The row the call shows on, which may be an earlier request's
        // (normalize.ts, askedFor).
        toolUseId: typeof p.toolCall?.toolCallId === 'string' && p.toolCall.toolCallId !== '' ? seen.row : undefined,
        // As an MCP tool's, for anything else: a card whose arguments say
        // what it does can only be allowed where all of them are shown.
        name: shellCard ? 'shell' : edits ? 'apply_patch' : `mcp__acp__${external ? 'mcp' : (kind ?? 'tool')}`,
        title: `${title}${code ? ` (${codeWriteNote(code)})` : ''}${outside || reachesOut ? " (outside this thread's folder)" : ''}`,
        input: card.input,
        wholeInput: shellCard ? shown : fullData!,
        ...(opaque ? { noReview: true as const } : {}),
        canAlwaysAllow: !code && (editRule || Boolean(rule)),
        signal: pending.abort.signal,
      });
    } catch (e) {
      this.deps.log.warn('approval request failed', { threadId: this.opts.threadId, error: String(e) });
      a = { decision: 'expired' };
    }
    // Already answered as cancelled: an interrupt, or the session ending.
    if (!this.pending.delete(id)) return;
    this.syncQuotaDeadline();
    this.syncUnsolicitedSettle();
    if (a.decision === 'expired') return void this.proc.respond(id, { outcome: { outcome: 'cancelled' } });
    const allow = a.decision === 'allow' || a.decision === 'allowAlways';
    if (allow && ((frames && frameState(frames) !== asked) || (paths.length && placesNow() !== placed))) {
      this.sink.output({ kind: 'event', event: { type: 'system.note', text: `"${firstLineSafely(title, 80, '…')}" changed while it waited for an answer (what it says, or where its files are), so it wasn't run. The agent can ask again.` } });
      return this.answer(id, options, false, seen.id);
    }
    // A link pointed somewhere else while the card waited: what was allowed
    // isn't where it would run now (Codex's second look, 10 Nov).
    if (allow && !external && kind === 'execute' && (named.length ? JSON.stringify(resolve()) !== JSON.stringify(places) : realFolder(this.opts.cwd) !== baseReal)) {
      this.sink.output({ kind: 'event', event: { type: 'system.note', text: `The folder for "${firstLineSafely(command, 80, '…')}" changed while it waited for an answer, so it wasn't run. The agent can ask again.` } });
      return this.answer(id, options, false, seen.id);
    }
    if (a.decision === 'allowAlways' && !code) {
      if (editRule) this.addRules([EDIT_RULE]);
      else if (rule) this.addRules([rule]);
    }
    this.answer(id, options, allow, seen.id);
  }

  // A form the agent wants filled in (OpenCode 2's question tool), as
  // question cards. Only form mode is offered; a URL to open is declined.
  private async form(id: RequestId, p: Record<string, unknown>): Promise<void> {
    const name = providerName(this.deps.agent.provider);
    const message = typeof p.message === 'string' ? p.message : '';
    if (p.mode !== 'form') {
      this.sink.output({ kind: 'event', event: { type: 'system.note', text: `${name} asked for something Threadbear can't show (${String(p.mode)}), so it was declined.` } });
      return void this.proc.respond(id, { action: 'decline' });
    }
    const schema = isPlainObject(p.requestedSchema) ? (p.requestedSchema as FormSchema) : undefined;
    const built = formQuestions(message, schema, name);
    if (built && 'unshown' in built) {
      this.sink.output({ kind: 'event', event: { type: 'system.note', text: `${built.unshown} It was declined.` } });
      return void this.proc.respond(id, { action: 'decline' });
    }
    const questions: Question[] = built ? built.questions : [{ question: message || `${name} has a question`, header: name.slice(0, 30), multiSelect: false, options: [{ label: 'Accept' }, { label: 'Decline' }] }];
    const pending: Pending = { abort: new AbortController(), options: [], cancelled: { action: 'cancel' } };
    this.pending.set(id, pending);
    this.syncQuotaDeadline();
    this.syncUnsolicitedSettle();
    let a: QuestionAnswer;
    try {
      a = await this.sink.requestQuestion({ toolUseId: typeof p.toolCallId === 'string' ? p.toolCallId : undefined, questions, signal: pending.abort.signal });
    } catch (e) {
      this.deps.log.warn('question request failed', { threadId: this.opts.threadId, error: String(e) });
      a = { answers: null };
    }
    // Already answered as cancelled: an interrupt, or the session ending.
    if (!this.pending.delete(id)) return;
    this.syncQuotaDeadline();
    this.syncUnsolicitedSettle();
    if (!a.answers) return void this.proc.respond(id, { action: 'decline' });
    if (!built) return void this.proc.respond(id, a.answers[questions[0].question] === 'Accept' ? { action: 'accept', content: {} } : { action: 'decline' });
    const content = formContent(built, a.answers);
    this.proc.respond(id, content ? { action: 'accept', content } : { action: 'decline' });
  }

  private runsAsCode(paths: string[]): CodeWrite {
    const kinds = paths.map((f) => runsAsCodeByName(f) || (this.opts.runsAsCode?.(f) ?? false));
    return kinds.includes(true) || (kinds.includes('unsure') ? 'unsure' : false);
  }

  // Every open request answered as cancelled, which ACP requires of a
  // client cancelling a turn. Cards close with it.
  private cancelPending(respond: boolean): void {
    for (const [id, p] of this.pending) {
      p.abort.abort();
      if (respond) this.proc.respond(id, p.cancelled ?? { outcome: { outcome: 'cancelled' } });
    }
    this.pending.clear();
  }

  // ---- Turns

  send(input: UserInput): void {
    if (this.state === 'closing' || this.state === 'closed') {
      this.deps.log.warn('a message reached an acp session that has ended', { threadId: this.opts.threadId });
      return;
    }
    // ACP has no way to add to a running turn: it's the next one.
    this.held.push(input);
    // OpenCode's session/prompt cancels any running background turn fiber, so
    // close an unsolicited turn immediately and dispatch the user's message.
    if (this.turn?.unsolicited) {
      this.cancelPending(true);
      this.finishUnsolicitedTurn(this.turn, 'completed');
      return;
    }
    this.next();
  }

  unreadMessage(): boolean {
    return this.held.length > 0 || Boolean(this.turn && !this.turn.unsolicited && !this.turn.dispatched);
  }

  private next(): void {
    if (this.state !== 'ready' || this.turn || !this.held.length) return;
    void this.runTurn(this.held.shift()!);
  }

  private promptBlocks(input: UserInput): unknown[] {
    const blocks: unknown[] = [];
    if (this.preamble) {
      blocks.push({ type: 'text', text: this.preamble });
      this.preamble = undefined;
    }
    // ACP cannot tell the agent why a permission was refused. Explain the
    // route before every turn, including in a resumed coordinator session.
    if (this.deps.agent.provider === 'antigravity' && this.opts.coordinator?.role === 'coordinator') {
      blocks.push({ type: 'text', text: 'For web search, delegate the lookup with the coordinator tool (startHelper) and ask the helper for source links. Antigravity can report web search without a read-only classification, so the runner may block it.' });
    }
    const canSee = this.init.agentCapabilities?.promptCapabilities?.image === true;
    const parts = placePictures(input.text, input.images);
    if (!parts.length) blocks.push({ type: 'text', text: input.text });
    for (const part of parts) {
      if ('text' in part) blocks.push({ type: 'text', text: part.text });
      else blocks.push(imageBlock(part.image, canSee));
    }
    return blocks;
  }

  private async runTurn(input: UserInput): Promise<void> {
    this.ctx.beginTurn?.();
    const turn: Turn = { id: input.id, startedAt: this.now(), interrupted: false, dropped: [] };
    this.turn = turn;
    this.chunkBuffer = '';
    this.state = 'turn';
    let result: TurnResult;
    let dispatched = false;
    try {
      // Between turns, so the next message takes any change made during this one.
      await this.applyMode();
      const modelChanged = this.modelChanged;
      if (this.modelChanged) {
        this.modelChanged = false;
        await this.applyModel(this.model ?? this.opts.account.defaultModel ?? '');
      }
      // Again after a new model, which may start at its own level.
      if (this.effortChanged || (modelChanged && this.effort)) {
        this.effortChanged = false;
        await this.applyEffort(this.effort);
      }
      // Stop pressed during the setup above: nothing has reached the model.
      if (turn.interrupted) throw new Error('Stopped');
      this.guardSeen = false;
      dispatched = true;
      turn.dispatched = true;
      const r = await this.proc.request<{ stopReason?: string }>('session/prompt', { sessionId: this.sessionId, prompt: this.promptBlocks(input) }, null);
      this.closeOpenMcpCalls('Stopped');
      this.emit(this.normalizer.closeOpen('Stopped'));
      this.suppressedToolIds.clear();
      result = this.resultFor(turn, r?.stopReason);
      const effort = this.effortNow();
      if (effort) this.sink.output({ kind: 'effort', level: effort });
    } catch (e) {
      if (e instanceof AcpExitedError) return; // the exit handler reports it
      this.closeOpenMcpCalls('Failed');
      this.emit(this.normalizer.closeOpen('Failed'));
      this.suppressedToolIds.clear();
      const auth = e instanceof AcpRpcError && e.code === AUTH_REQUIRED;
      result = { outcome: turn.interrupted ? 'interrupted' : 'failed', durationMs: Math.max(0, this.now() - turn.startedAt), ...(auth ? { errorKind: 'auth' as const } : {}) };
      if (!turn.interrupted) Object.assign(result, auth ? { error: (e as Error).message } : this.failureFor(turn, e));
    } finally {
      clearTimeout(turn.quota?.deadline?.timer);
      clearTimeout(turn.executorDiagnosticTimer);
    }
    if (this.turn !== turn) return;
    turn.dispatched = dispatched;
    this.turn = undefined;
    if (this.state === 'turn') this.state = 'ready';
    if (this.mode === 'plan' && result.outcome === 'completed') {
      const text = this.normalizer.takeLastAssistantText();
      if (text) this.sink.output({ kind: 'planProposed', itemId: `${turn.id ?? 'plan'}-plan`, text });
    }
    if (result.errorKind === 'usageLimit') this.held = [];
    this.reconcileBackgroundShells();
    this.sendResult(turn, result);
    // After the result, not before it: the runner records a reading under
    // the login this CLI runs on (sessionAccountId), wherever the result
    // moves the thread, and a read held before it could be lost to an exit.
    void this.limitsAfter(result);
    this.next();
  }

  private sendResult(turn: Turn, result: TurnResult): void {
    const answered = [...(turn.id ? [turn.id] : []), ...turn.dropped];
    this.sink.output({ kind: 'result', result: { ...result, ...(turn.id ? { answers: turn.id } : {}), answered, unreceived: [...(!turn.dispatched && turn.id ? [turn.id] : []), ...turn.dropped], queuedTurns: this.held.length, ...(this.normalizer.costUsd !== undefined ? { totalCostUsd: this.normalizer.costUsd } : {}) } });
  }

  // ---- Background shells & agent-initiated background turns (OpenCode 2)

  private noteBackgroundShell(shell: AcpBackgroundShell): void {
    if (!this.deps.agent.wakesAfterTasks || this.state === 'closing' || this.state === 'closed') return;
    if (shell.status === 'ended') {
      if (this.backgroundShells.delete(shell.id)) {
        if (!this.backgroundShells.size) this.stopShellPoll();
        this.emitBackgroundTasks();
      }
      return;
    }
    // Require a verifiable PID so a tracked shell can always be cleared when
    // its process exits and never leaves a thread stuck in Running.
    const pid = shell.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
    if (!this.isShellPidAlive(pid)) {
      if (this.backgroundShells.delete(shell.id)) {
        if (!this.backgroundShells.size) this.stopShellPoll();
        this.emitBackgroundTasks();
        return;
      }
      // The shell exited before its tool_call_update reached Threadbear.
      // OpenCode still wakes to deliver <background-result>, so report the
      // finished task transition once so the runner arms wake grace and wokeBy.
      if (!this.announcedDeadShells.has(shell.id)) {
        this.announcedDeadShells.add(shell.id);
        const task: BackgroundTask = { id: shell.id, type: 'opencode_shell', kind: 'shell', description: shell.description || 'shell' };
        this.sink.output({ kind: 'tasks', tasks: [...this.currentBackgroundTasks(), task] });
        this.emitBackgroundTasks();
      }
      return;
    }
    const prev = this.backgroundShells.get(shell.id);
    const next = { id: shell.id, pid, description: shell.description || 'shell' };
    this.backgroundShells.set(shell.id, next);
    if (!prev || prev.pid !== next.pid || prev.description !== next.description) this.emitBackgroundTasks();
    this.ensureShellPoll();
  }

  private ensureShellPoll(): void {
    if (this.shellPollTimer || !this.backgroundShells.size || this.state === 'closing' || this.state === 'closed') return;
    const ms = Math.max(10, this.deps.backgroundShellPollMs ?? BACKGROUND_SHELL_POLL_MS);
    this.shellPollTimer = setInterval(() => this.reconcileBackgroundShells(), ms);
    this.shellPollTimer.unref();
  }

  private stopShellPoll(): void {
    if (!this.shellPollTimer) return;
    clearInterval(this.shellPollTimer);
    this.shellPollTimer = undefined;
  }

  private reconcileBackgroundShells(): void {
    if (this.state === 'closing' || this.state === 'closed' || !this.backgroundShells.size) return;
    let changed = false;
    for (const [id, entry] of [...this.backgroundShells]) {
      if (!this.isShellPidAlive(entry.pid)) {
        this.backgroundShells.delete(id);
        changed = true;
      }
    }
    if (!changed) return;
    if (!this.backgroundShells.size) this.stopShellPoll();
    this.emitBackgroundTasks();
  }

  private currentBackgroundTasks(): BackgroundTask[] {
    return [...this.backgroundShells.values()].map((s) => ({
      id: s.id,
      type: 'opencode_shell',
      kind: 'shell',
      description: s.description,
    }));
  }

  private emitBackgroundTasks(): void {
    this.sink.output({ kind: 'tasks', tasks: this.currentBackgroundTasks() });
  }

  private openUnsolicitedTurn(): void {
    if (this.state !== 'ready' || this.turn || !this.deps.agent.wakesAfterTasks) return;
    // Prune any shell whose exit triggered this wake before cliTurn so the
    // runner attaches wokeBy and does not carry a finished shell as live.
    this.reconcileBackgroundShells();
    const turn: Turn = { startedAt: this.now(), interrupted: false, dropped: [], unsolicited: true, lastActivity: 'other' };
    this.turn = turn;
    this.chunkBuffer = '';
    this.state = 'turn';
    this.sink.output({ kind: 'cliTurn' });
    this.syncUnsolicitedSettle();
  }

  private syncUnsolicitedSettle(): void {
    const turn = this.turn;
    if (!turn?.unsolicited) return;
    clearTimeout(turn.settleTimer);
    turn.settleTimer = undefined;
    if (this.state !== 'turn') return;
    if (this.pending.size > 0 || this.openMcpCalls.size > 0) return;
    const cfg = this.deps.unsolicitedSettleMs;
    const runningTools = this.normalizer.hasRunningTools();
    const ms = runningTools
      ? (cfg?.toolStall ?? UNSOLICITED_TOOL_STALL_MS)
      : turn.endTurnAccepted
      ? (turn.sawText ? (cfg?.endTurn ?? UNSOLICITED_END_TURN_SETTLE_MS) : (cfg?.endTurnWaitText ?? UNSOLICITED_END_TURN_WAIT_TEXT_MS))
      : turn.lastActivity === 'text'
      ? (cfg?.text ?? UNSOLICITED_TEXT_SETTLE_MS)
      : (cfg?.idle ?? UNSOLICITED_IDLE_SETTLE_MS);
    turn.settleTimer = setTimeout(() => {
      if (this.turn === turn && this.state === 'turn' && !this.pending.size && !this.openMcpCalls.size && (runningTools || !this.normalizer.hasRunningTools())) {
        this.finishUnsolicitedTurn(turn, 'completed');
      }
    }, ms);
    turn.settleTimer.unref();
  }

  private finishUnsolicitedTurn(turn: Turn, outcome: 'completed' | 'interrupted'): void {
    if (this.turn !== turn) return;
    clearTimeout(turn.settleTimer);
    turn.settleTimer = undefined;
    clearTimeout(turn.quota?.deadline?.timer);
    clearTimeout(turn.executorDiagnosticTimer);
    this.closeOpenMcpCalls('Stopped');
    this.emit(this.normalizer.closeOpen('Stopped'));
    this.suppressedToolIds.clear();
    this.reconcileBackgroundShells();
    this.turn = undefined;
    if (this.state === 'turn') this.state = 'ready';
    const result: TurnResult = { outcome, own: true, durationMs: Math.max(0, this.now() - turn.startedAt) };
    if (this.mode === 'plan' && result.outcome === 'completed') {
      const text = this.normalizer.takeLastAssistantText();
      if (text) this.sink.output({ kind: 'planProposed', itemId: 'plan', text });
    }
    this.sendResult(turn, result);
    void this.limitsAfter(result);
    this.next();
  }

  // What a failed turn says, and whether it failed because the login is out
  // of usage (errorKind usageLimit: the runner marks it out and a pool
  // thread moves on, as for Claude and Codex). The agent's own words first:
  // an error's data (AcpRpcError prefers it to JSON-RPC's "Internal
  // error"), then what it said in the turn's notes.
  private failureFor(turn: Turn, e?: unknown): Pick<TurnResult, 'error' | 'errorKind'> {
    const rpc = e instanceof AcpRpcError ? e : undefined;
    const thrown = e instanceof Error ? e.message : e === undefined ? undefined : String(e);
    const fromRpc = rpc && rpc.message !== rpc.rpcMessage ? rpc.message : undefined;
    const noted = turn.failure && !genericRpcMessage(turn.failure.message) ? turn.failure.message : undefined;
    const quotaNote = (!e || (rpc && rpc.httpStatus === undefined && genericRpcMessage(rpc.message))) ? turn.quota?.message : undefined;
    const detail = fromRpc ?? noted ?? quotaNote ?? thrown ?? turn.failure?.message ?? 'The agent stopped with an error.';
    const httpStatus = rpc?.httpStatus ?? turn.failure?.httpStatus;
    if (!outOfUsage({ message: detail, httpStatus })) return { error: detail };
    const name = providerName(this.deps.agent.provider);
    return { error: `${this.opts.account.id} is out of ${name} usage, so ${name} stopped before doing anything (${detail.replace(/[.\s]+$/, '')}).`, errorKind: 'usageLimit' };
  }

  // A reading of the login's limits on this thread's own process, for an
  // agent that can say with a request (AcpAgent.limits' method, Grok; a
  // usage command would be a prompt in the thread's own session, so Gemini's
  // is read after turns by limit-recheck.ts instead): after a turn that ran out of
  // usage, and at most every LIMITS_EVERY_MS after others. It gives up
  // after TURN_LIMITS_MS, and a failure (the process gone) is only logged.
  private async limitsAfter(result: TurnResult): Promise<void> {
    const limits = this.deps.agent.limits;
    if (!limits || !('method' in limits) || !this.proc.alive || result.outcome === 'interrupted') return;
    const ran = result.errorKind === 'usageLimit';
    if (!ran && (result.outcome !== 'completed' || (this.limitsReadAt !== undefined && this.now() - this.limitsReadAt < LIMITS_EVERY_MS))) return;
    this.limitsReadAt = this.now();
    try {
      const reading = limits.read(await this.proc.request(limits.method, {}, TURN_LIMITS_MS));
      if (reading) this.sink.output(reading);
    } catch (e) {
      this.deps.log.info('could not read the login\'s limits', { threadId: this.opts.threadId, error: String(e) });
    }
  }

  private resultFor(turn: Turn, stop: string | undefined): TurnResult {
    const durationMs = Math.max(0, this.now() - turn.startedAt);
    if (turn.failure && !turn.interrupted) {
      return { outcome: 'failed', durationMs, ...this.failureFor(turn) };
    }
    switch (stop) {
      case 'cancelled':
        if (turn.quota && !turn.interrupted) return { outcome: 'failed', durationMs, ...this.failureFor(turn) };
        return { outcome: 'interrupted', durationMs };
      case 'refusal':
        return { outcome: 'failed', durationMs, error: 'The model refused to continue.' };
      case 'max_tokens':
        return { outcome: 'failed', durationMs, error: 'The reply reached the model\'s length limit.' };
      case 'max_turn_requests':
        return { outcome: 'failed', durationMs, error: 'The turn reached the agent\'s limit on steps.' };
      // Not one of ACP's, but an agent that says so means it.
      case 'error':
        return { outcome: 'failed', durationMs, ...this.failureFor(turn) };
      default:
        if (turn.quota && !turn.interrupted) return { outcome: 'failed', durationMs, ...this.failureFor(turn) };
        return { outcome: turn.interrupted ? 'interrupted' : 'completed', durationMs };
    }
  }

  async interrupt(): Promise<void> {
    if (this.state === 'closed' || this.state === 'closing') {
      if (!this.proc.alive) throw new Error('The agent has already exited.');
      return;
    }
    // Stop means stop: what's waiting for a later turn goes too.
    const dropped = this.held.map((m) => m.id).filter((x): x is string => Boolean(x));
    this.held = [];
    const turn = this.turn;
    if (!turn) {
      if (dropped.length) this.sink.output({ kind: 'result', result: { outcome: 'interrupted', durationMs: 0, answers: dropped[0], answered: dropped, unreceived: dropped, queuedTurns: 0 } });
      return;
    }
    // They end with this turn, so the runner sees one result, when it's over.
    turn.dropped.push(...dropped);
    turn.interrupted = true;
    this.cancelPending(true);
    if (turn.unsolicited) {
      // OpenCode's session/cancel only stops an active session/prompt, not its
      // background turn fiber. End the turn cleanly and stop the process so
      // background execution halts immediately; the next message resumes it.
      this.finishUnsolicitedTurn(turn, 'interrupted');
      this.kill();
      return;
    }
    this.proc.notify('session/cancel', { sessionId: this.sessionId });
    this.syncQuotaDeadline();
  }

  // ---- Settings: from the next turn (settingsApplyNextTurn), except the
  // permission mode, which every request reads as it's asked.

  async setModel(model: string | undefined): Promise<void> {
    if (model !== this.model) this.modelChanged = true;
    this.model = model;
  }

  // Only an agent with a thought_level option takes one (applyEffort).
  async setEffort(effort: EffortLevel | undefined): Promise<void> {
    if (effort !== this.effort) this.effortChanged = true;
    this.effort = effort;
  }

  // Asked for at once, as a running turn in Cursor's writable mode wouldn't
  // send a request to stop at. One that can't be made safe doesn't go on.
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    // A mode this folder can't run in (Grok's trusted folders): the process
    // goes, and the next message starts one, which says why it can't.
    const refused = this.deps.agent.refuses?.({ cwd: this.opts.cwd, mode, trusted: this.trusted, binary: this.binary }) ?? (mode !== 'full' ? this.startRefusal : undefined);
    if (refused && this.state !== 'closed' && this.state !== 'closing') {
      this.sink.output({ kind: 'event', event: { type: 'system.note', text: refused } });
      this.kill();
      return;
    }
    if (!this.sessionId || (this.state !== 'ready' && this.state !== 'turn')) return;
    try {
      await this.applyMode();
    } catch (e) {
      this.deps.log.warn('could not change the agent mode', { threadId: this.opts.threadId, error: String(e) });
      if (this.turn) {
        this.sink.output({ kind: 'event', event: { type: 'system.note', text: `Stopped this turn, as ${providerName(this.deps.agent.provider)} couldn't be switched to the mode you picked.` } });
        await this.interrupt();
      }
    }
  }

  async commands(): Promise<SlashCommand[]> {
    return this.cliCommands;
  }

  // ---- Ending

  async end(opts: { hard?: boolean } = {}): Promise<void> {
    if (this.state === 'closed') return this.exitPromise;
    this.state = 'closing';
    this.stopShellPoll();
    if (opts.hard) this.proc.kill();
    await this.finish();
  }

  kill(): void {
    if (this.state === 'closed') return;
    this.state = 'closing';
    this.stopShellPoll();
    this.proc.kill();
    this.exited();
  }

  private async finish(error?: Error): Promise<void> {
    if (this.state !== 'closed') this.state = 'closing';
    this.proc.onExit = null;
    await this.proc.close().catch(() => undefined);
    this.exited(error);
  }

  private exited(error?: Error): void {
    if (this.exitedCalled) return;
    this.exitedCalled = true;
    this.state = 'closed';
    this.stopShellPoll();
    this.backgroundShells.clear();
    this.announcedDeadShells.clear();
    this.held = [];
    this.cancelPending(false);
    this.proc.onRequest = null;
    this.mcp?.close();
    this.closeOpenMcpCalls('Interrupted');
    this.emit(this.normalizer.closeOpen('Interrupted'));
    this.suppressedToolIds.clear();
    clearTimeout(this.turn?.settleTimer);
    clearTimeout(this.turn?.quota?.deadline?.timer);
    clearTimeout(this.turn?.executorDiagnosticTimer);
    this.turn = undefined;
    if (this.ownFolder) removeQuietly(this.ownFolder);
    this.resolveExit();
    this.sink.exited(error);
  }
}

// A file's device, inode and hard link count, or undefined if it isn't there.
function fileId(f: string): [number, number, number] | undefined {
  try {
    const st = fs.lstatSync(f);
    return [st.dev, st.ino, st.nlink];
  } catch {
    return undefined;
  }
}

// What a call's frames have said, to tell whether it changed while its card
// waited: arguments, content, kinds, names, tools, files, and its latest frame.
function frameState(f: { inputs: Record<string, unknown>[]; diffs: Record<string, unknown>[]; otherContent: unknown[]; last?: string; kinds: Set<string>; paths: Set<string>; ids: Set<string>; names: Set<string>; mcp: boolean }): string {
  const distinct = (xs: unknown[]) => [...new Set(xs.map((x) => JSON.stringify(x)))];
  return JSON.stringify([distinct(f.inputs), distinct(f.diffs), distinct(f.otherContent), f.last ?? null, [...f.kinds], [...f.paths], [...f.ids], [...f.names], f.mcp]);
}

// The MCP tool a frame says it is, as <server>__<tool>.
function mcpIdOf(u: Record<string, unknown>): string | undefined {
  const m = isPlainObject(u._meta) && isPlainObject(u._meta.mcp) ? u._meta.mcp : undefined;
  return m && typeof m.server === 'string' && typeof m.tool === 'string' && m.server.trim() && m.tool.trim() ? `${m.server}__${m.tool}` : undefined;
}

// Whether a tool call's frame says it's an MCP server's (Antigravity's _meta).
function isMcpFrame(u: unknown): boolean {
  if (!isPlainObject(u) || !isPlainObject(u._meta)) return false;
  return u._meta.is_mcp_tool_call === true || isPlainObject(u._meta.mcp);
}

// A folder a session of an agent with ownSessionFolder opens in, named for
// the runner's pid. Ones left by a runner that's gone (a crash) are swept
// first.
const SESSION_PREFIX = 'threadbear-acp-session-';
function sessionFolder(): string {
  const tmp = os.tmpdir();
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith(SESSION_PREFIX)) continue;
      const pid = Number(/^(\d+)-/.exec(name.slice(SESSION_PREFIX.length))?.[1]);
      if (!pid || pid === process.pid || pidAlive(pid)) continue;
      removeQuietly(path.join(tmp, name));
    }
  } catch {
    // An unreadable temp folder only means nothing is swept.
  }
  return fs.mkdtempSync(path.join(tmp, `${SESSION_PREFIX}${process.pid}-`));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Same-user liveness check for background shells spawned by our own OpenCode
// process: EPERM means another user's process (e.g. a recycled PID), not ours.
function ownPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Removing a scratch folder never stops a session ending: whatever the agent
// left unremovable stays until the next sweep.
function removeQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Left for the next sweep.
  }
}

// A picture for the prompt: the image itself where the agent says it takes
// them, else a link to the saved file, which every ACP agent must accept.
function imageBlock(image: ImageRef, canSee: boolean): unknown {
  if (canSee) {
    try {
      return { type: 'image', data: fs.readFileSync(image.path).toString('base64'), mimeType: image.mediaType };
    } catch {
      // Gone from disk: the link says so when the agent tries it.
    }
  }
  return { type: 'resource_link', uri: `file://${image.path}`, name: path.basename(image.path), mimeType: image.mediaType };
}
