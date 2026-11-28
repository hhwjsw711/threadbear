// Codex threads: one `codex app-server` process per live thread, driven over
// its JSON-RPC (appserver.ts). The session below turns the runner's
// start/send/interrupt into thread and turn requests, routes subagent
// traffic to the parent thread, answers Codex's requests (approvals.ts,
// tools.ts) and hands every notification to the normaliser (section B,
// normalize.ts), which turns it into events.
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Account, EffortLevel, ModelChoice, PermissionMode } from '../../protocol.ts';
import { isEffortLevel } from '../../protocol.ts';
import type { Logger } from '../../log.ts';
import type { ProcessRegistry } from '../../proc.ts';
import type { AdapterOutput, AgentAdapter, AgentSession, RewindRequest, RewindResult, SessionSink, StartSessionOptions, TurnResult, UseResetResult, UserInput } from '../types.ts';
import { RewindRefusedError, SessionNotFoundError } from '../types.ts';
import { fileContext, type NormalizerContext } from '../context.ts';
import {
  AppServerProcess,
  ChildThreads,
  CodexExitedError,
  OVERSIZED_LINE,
  RateLimitTracker,
  withShortLivedProcess,
  type AppServerOptions,
  type AppServerTimings,
  type OversizedLine,
} from './appserver.ts';
import { runsAsCodeByName } from '../../code-writes.ts';
import { hookTrust, sameHome, shareCodexHome, type MainHook } from '../../codex-home-share.ts';
import { CodexApprovals, type OpenMcpCall } from './approvals.ts';
import { CodexTools, dynamicToolSpecs, toolGuidance, type ToolDefinition } from './tools.ts';
import { CodexNormalizer, limitsFromAccount, limitsFromRateLimits } from './normalize.ts';
import { placePictures } from '../../pictures.ts';
import { parseCommand, type SlashCommand } from '../../slash-commands.ts';
import { ARCHIVE_READ_TOOL_NAMES } from '../../coordinator-policy.ts';
import type {
  CodexNormalizerLike,
  ConsumeAccountRateLimitResetCreditResponse,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  ModelListResponse,
  RequestId,
  SandboxPolicy,
  SkillsListResponse,
  ThreadResumeParams,
  ThreadStartParams,
  ThreadStartResponse,
  TurnNotification,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerResponse,
  UserInputItem,
} from './types.ts';

export type CodexTimings = AppServerTimings & {
  reinterruptMs: number; // while a message waits for an interrupted turn to finish
  finishWaitMs: number; // ... and how long it waits before failing
  closingRetryStartMs: number; // "is closing" retries: first wait, doubling
  closingRetryForMs: number; // ... for at most this long
  terminateMs: number; // backgroundTerminals list/terminate after an interrupt
};
export const DEFAULT_CODEX_TIMINGS: CodexTimings = {
  requestMs: 30_000,
  turnStartMs: 60_000,
  spawnRetryMs: 1000,
  spawnRetryForMs: 10_000,
  closeWaitMs: 5000,
  reinterruptMs: 10_000,
  finishWaitMs: 60_000,
  closingRetryStartMs: 250,
  closingRetryForMs: 10_000,
  terminateMs: 5000,
};

export type NormalizerFactory = (ctx: NormalizerContext, o: { threadId: string }) => CodexNormalizerLike;

// How long readLimits waits for Codex's answer before giving up.
export const READ_LIMITS_TIMEOUT_MS = 30_000;

export type CodexAdapterDeps = {
  // What the next process starts (E's codexBinary(): Threadbear's own copy,
  // codexPath, or the fallback npm copy). Called on every spawn.
  codexBinary: () => string;
  codexArgs?: string[];
  registry: ProcessRegistry;
  log: Logger;
  // The threadbear tools for a thread, given to new threads as dynamic tools.
  toolsFor?: (threadId: string) => ToolDefinition[];
  // MCP servers a thread gets besides config.toml's, read at each start or
  // resume (Agent Archive's, with its experiment on).
  mcpServers?: () => Record<string, { command: string; args: string[] }>;
  // ~/.codex: a session on any other login first has it share that
  // home's instructions, hooks, skills and config.toml, and gets the trust
  // its hooks have there (codex-home-share.ts, readyHome). Unset in tests.
  codexMainDir?: string;
  // Section B's CodexNormalizer unless a test passes its own.
  normalizer?: NormalizerFactory;
  // A runner.notice warning (configWarning: a broken config.toml).
  onNotice?: (text: string) => void;
  // More developer instructions for a new thread with tools, read at its
  // start (RICH_BLOCKS_LINE, which the in-process server has in its own
  // instructions).
  extraGuidance?: () => string;
  timings?: Partial<CodexTimings>;
  maxLineBytes?: number;
  now?: () => number;
};

// What Codex said about ~/.codex; a part it couldn't say is left out.
export type MainHomeFacts = { credentialsStore?: string; hooks?: MainHook[]; partial?: true };

export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex';
  readonly movesFolders = true;
  readonly settingsApplyNextTurn = true;
  readonly wakesAfterTasks = false;
  private deps: CodexAdapterDeps;
  private live = new Set<AppServerProcess>();
  // Subagent threads seen per Codex thread, so archive() can archive them
  // too (whether thread/archive covers them is unverified).
  private children = new Map<string, Set<string>>();
  private noticed = new Set<string>();

  constructor(deps: CodexAdapterDeps) {
    this.deps = deps;
  }

  start(opts: StartSessionOptions, sink: SessionSink): AgentSession {
    const s = new CodexSession(opts, sink, this.deps, {
      track: (p, live) => this.track(p, live),
      child: (parent, child) => {
        let set = this.children.get(parent);
        if (!set) this.children.set(parent, (set = new Set()));
        set.add(child);
      },
      notice: (text) => {
        if (this.noticed.has(text)) return;
        this.noticed.add(text);
        this.deps.onNotice?.(text);
      },
      readyHome: (account) => this.readyHome(account),
    });
    s.start();
    return s;
  }

  // The real binaries of every live process (sessions and short-lived
  // ones), so E only deletes version folders nothing runs.
  binariesInUse(): string[] {
    return [...new Set([...this.live].map((p) => p.binaryPath).filter((b): b is string => Boolean(b)))];
  }

  private track(p: AppServerProcess, live: boolean): void {
    if (live) this.live.add(p);
    else this.live.delete(p);
  }

  private shortLived(account: Account, label: string): AppServerOptions {
    const { deps } = this;
    return {
      binary: deps.codexBinary(),
      args: deps.codexArgs,
      account,
      cwd: os.tmpdir(),
      registry: deps.registry,
      log: deps.log,
      label,
      maxLineBytes: deps.maxLineBytes,
      timings: deps.timings,
    };
  }

  // What ~/.codex is, from Codex itself: where it keeps its sign-in
  // (config/read) and its hooks with their trust (hooks/list), each kept
  // apart so one failing doesn't lose the other. Asked again when its
  // config.toml, hooks.json or the Codex binary changes, and 5 minutes
  // after an answer that wasn't whole.
  private mainProbe?: { key: string; at: number; whole: boolean; facts: Promise<MainHomeFacts> };

  mainHome(mainDir: string): Promise<MainHomeFacts> {
    const stat = (p: string) => {
      try {
        const st = fs.statSync(p);
        return [fs.realpathSync(p), st.size, st.mtimeMs, st.ino];
      } catch {
        return null;
      }
    };
    const binary = this.deps.codexBinary();
    const key = JSON.stringify([mainDir, stat(binary) ?? binary, stat(path.join(mainDir, 'config.toml')), stat(path.join(mainDir, 'hooks.json'))]);
    const cached = this.mainProbe;
    if (cached && cached.key === key && (cached.whole || cached.at > this.nowMs() - 5 * 60_000)) return cached.facts;
    const entry: { key: string; at: number; whole: boolean; facts: Promise<MainHomeFacts> } = { key, at: this.nowMs(), whole: false, facts: Promise.resolve({}) };
    entry.facts = withShortLivedProcess(
      this.shortLived({ id: 'codex-main', provider: 'codex', title: 'codex-main', configDir: mainDir }, 'home:codex-main'),
      async (p) => {
        const out: MainHomeFacts = {};
        try {
          const conf = await p.request<{ config?: Record<string, unknown> }>('config/read', {});
          const store = conf?.config?.cli_auth_credentials_store;
          out.credentialsStore = typeof store === 'string' && store ? store : 'file';
        } catch (e) {
          this.deps.log.warn('could not ask Codex where ~/.codex keeps its sign-in', { error: errText(e) });
        }
        try {
          const list = await p.request<{ data?: { hooks?: MainHook[]; errors?: unknown[] }[] }>('hooks/list', { cwds: [os.tmpdir()] });
          const data = list?.data ?? [];
          out.hooks = data.flatMap((e) => e.hooks ?? []).filter((h) => typeof h?.key === 'string' && typeof h.currentHash === 'string');
          // Hooks it couldn't load: what it did list counts, but ask again.
          if (data.some((e) => Array.isArray(e.errors) && e.errors.length)) out.partial = true;
        } catch (e) {
          this.deps.log.warn("could not ask Codex about ~/.codex's hooks", { error: errText(e) });
        }
        return out;
      },
      (p, live) => this.track(p, live),
    )
      .catch((e: unknown): MainHomeFacts => {
        this.deps.log.warn('could not ask Codex about ~/.codex', { error: errText(e) });
        return {};
      })
      .then((facts) => {
        entry.whole = facts.credentialsStore !== undefined && facts.hooks !== undefined && !facts.partial;
        return facts;
      });
    this.mainProbe = entry;
    return entry.facts;
  }

  // Before a process on an extra login starts: links what it shares with
  // ~/.codex and returns the config overrides that trust its hooks. Never
  // stops a session; what went wrong is logged.
  private async readyHome(account: Account): Promise<Record<string, unknown>> {
    const main = this.deps.codexMainDir;
    try {
      if (!main || !fs.existsSync(main) || sameHome(main, account.configDir)) return {};
      const facts = await this.mainHome(main);
      const report = shareCodexHome(main, account.configDir, facts.credentialsStore);
      if (report.changes.length) this.deps.log.info('codex login shared with ~/.codex', { account: account.id, changes: report.changes });
      if (report.skipped.length) this.deps.log.debug('codex login: left as it was', { account: account.id, skipped: report.skipped });
      return hookTrust(facts.hooks ?? [], main, account.configDir);
    } catch (e) {
      this.deps.log.warn('codex login setup failed', { account: account.id, error: errText(e) });
      return {};
    }
  }

  private nowMs(): number {
    return (this.deps.now ?? Date.now)();
  }

  // The folder's skills, as the picker's commands (Codex's own commands
  // are slash-commands.ts's list).
  async commands(account: Account, cwd: string): Promise<SlashCommand[]> {
    // A login not yet shared would list only Codex's own skills.
    await this.readyHome(account);
    return withShortLivedProcess(
      { ...this.shortLived(account, `commands:${account.id}`), cwd },
      async (p) => codexSkillCommands(await p.request<SkillsListResponse>('skills/list', { cwds: [cwd] })),
      (p, live) => this.track(p, live),
    );
  }

  // model/list without hidden models, in Codex's order. With no thread
  // loaded the process starts no MCP servers.
  async models(account: Account, signal?: AbortSignal): Promise<ModelChoice[]> {
    signal?.throwIfAborted();
    // Every process on a login runs with its home as shared (readyHome).
    await this.readyHome(account);
    signal?.throwIfAborted();
    let onAbort: (() => void) | undefined;
    return withShortLivedProcess(
      this.shortLived(account, `models:${account.id}`),
      async (p) => {
        const out: ModelChoice[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 20; page++) {
          const r: ModelListResponse = await p.request<ModelListResponse>('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
          out.push(...codexModelChoices(r?.data ?? []));
          cursor = r?.nextCursor ?? null;
          if (!cursor) break;
        }
        return out;
      },
      (p, live) => {
        this.track(p, live);
        if (live) {
          onAbort = () => p.kill();
          signal?.addEventListener('abort', onAbort, { once: true });
        } else if (onAbort) signal?.removeEventListener('abort', onAbort);
      },
    );
  }

  // Spends one of the login's usage-limit resets, Codex's next to expire
  // (no creditId), then reads its limits so the block lifts at once and the
  // count goes down. Only ever on Mike's click (accounts.useReset): Codex's
  // own setting for its assistant says resets are never used by themselves.
  // One idempotency key per click, so Codex's retry of the same call can't
  // spend a second one.
  async useReset(account: Account): Promise<UseResetResult> {
    await this.readyHome(account);
    return withShortLivedProcess(
      this.shortLived(account, `reset:${account.id}`),
      async (p) => {
        const r = await p.request<ConsumeAccountRateLimitResetCreditResponse>('account/rateLimitResetCredit/consume', { idempotencyKey: crypto.randomUUID() });
        const outcome = r?.outcome;
        if (outcome !== 'reset' && outcome !== 'nothingToReset' && outcome !== 'noCredit' && outcome !== 'alreadyRedeemed') throw new Error(`Codex answered the reset with ${JSON.stringify(outcome)}`);
        const read = await p.request<GetAccountRateLimitsResponse>('account/rateLimits/read', null).catch(() => null);
        const limits = limitsFromRateLimits(read as never);
        return limits ? { outcome, limits } : { outcome };
      },
      (p, live) => this.track(p, live),
    );
  }

  // Reads the login's limits in a short-lived app-server, without a turn
  // (limit-recheck.ts): free, and how a reset done in Codex itself is seen.
  async readLimits(account: Account): Promise<Extract<AdapterOutput, { kind: 'limits' }> | null> {
    await this.readyHome(account);
    return withShortLivedProcess(
      this.shortLived(account, `limits:${account.id}`),
      async (p) => {
        // A Codex that never answers would hold its process (and the
        // recheck's pass) for good; the throw closes it (finally above).
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('account/rateLimits/read took too long')), READ_LIMITS_TIMEOUT_MS);
        });
        try {
          return limitsFromRateLimits((await Promise.race([p.request<GetAccountRateLimitsResponse>('account/rateLimits/read', null), deadline])) as never);
        } finally {
          clearTimeout(timer);
        }
      },
      (p, live) => this.track(p, live),
    );
  }

  // Archives the thread in Codex (it shows in Codex Desktop's list until
  // then), and any subagent threads this runner saw it start. Resume
  // unarchives. Best effort: the runner logs a failure.
  async archive(account: Account, nativeSessionId: string): Promise<void> {
    await this.readyHome(account);
    const kids = [...(this.children.get(nativeSessionId) ?? [])];
    await withShortLivedProcess(
      this.shortLived(account, `archive:${account.id}`),
      async (p) => {
        await p.request('thread/archive', { threadId: nativeSessionId });
        for (const id of kids) await p.request('thread/archive', { threadId: id }).catch(() => undefined);
      },
      (p, live) => this.track(p, live),
    );
    this.children.delete(nativeSessionId);
  }

  // An edit of an earlier message (docs/protocol/threads.md, "Editing a message"):
  // Codex drops the turn that message started, and every later one, from
  // the thread's history with thread/revert. It never touches files; the
  // runner reverses the thread's diffs. Every turn the runner starts
  // carries its message id as clientUserMessageId, which is how the turn is
  // found.
  async rewind(req: RewindRequest): Promise<RewindResult> {
    await this.readyHome(req.account);
    return withShortLivedProcess(
      { ...this.shortLived(req.account, `rewind:${req.threadId}`), cwd: req.cwd },
      async (p) => {
        try {
          await p.request('thread/resume', { threadId: req.sessionId, excludeTurns: true });
        } catch (e) {
          if (!/archived/i.test(errText(e))) throw e;
          await p.request('thread/unarchive', { threadId: req.sessionId });
          await p.request('thread/resume', { threadId: req.sessionId, excludeTurns: true });
        }
        const found = await findCodexTurn(p, req.sessionId, req.messageId);
        if (!found) throw new RewindRefusedError("This message isn't in the thread's current Codex session (it has moved to another login or provider since), so it can't be edited.");
        if (found.first) return { fresh: true };
        await p.request('thread/revert', { threadId: req.sessionId, beforeTurnId: found.turnId });
        return {};
      },
      (p, live) => this.track(p, live),
    );
  }
}

// The Codex turn a runner message started, newest first, and whether it's
// the thread's first. Null when no turn carries the id, or the message
// went into a turn another message started (it can't be cut out alone).
async function findCodexTurn(p: AppServerProcess, threadId: string, messageId: string): Promise<{ turnId: string; first: boolean } | null> {
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const r: { data?: { id?: string; items?: { type?: string; clientId?: string | null }[] }[]; nextCursor?: string | null } = await p.request('thread/turns/list', {
      threadId,
      sortDirection: 'desc',
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    const turns = r?.data ?? [];
    for (let i = 0; i < turns.length; i++) {
      const asked = (turns[i].items ?? []).filter((it) => it?.type === 'userMessage');
      const at = asked.findIndex((it) => it.clientId === messageId);
      if (at < 0) continue;
      if (at > 0 || typeof turns[i].id !== 'string') return null;
      return { turnId: turns[i].id!, first: i === turns.length - 1 && !r.nextCursor };
    }
    cursor = r?.nextCursor ?? null;
    if (!cursor) return null;
  }
  return null;
}

// model/list rows as the protocol's ModelChoice.
export function codexModelChoices(rows: unknown[]): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    if (!row || typeof row.id !== 'string' || !row.id || row.hidden === true) continue;
    const choice: ModelChoice = {
      id: row.id,
      model: typeof row.model === 'string' && row.model ? row.model : row.id,
      title: typeof row.displayName === 'string' && row.displayName ? row.displayName : row.id,
    };
    if (typeof row.description === 'string' && row.description) choice.description = row.description;
    if (Array.isArray(row.supportedReasoningEfforts)) {
      const levels = row.supportedReasoningEfforts.map((e) => (e as { reasoningEffort?: unknown })?.reasoningEffort).filter(isEffortLevel);
      if (levels.length) choice.effortLevels = levels;
    }
    if (isEffortLevel(row.defaultReasoningEffort)) choice.defaultEffort = row.defaultReasoningEffort;
    out.push(choice);
  }
  return out;
}

// Threadbear's two permission modes in Codex's terms (docs/archive/step4-plan.md,
// "Permission modes"). approvalsReviewer is always sent: another account's
// config.toml could route approvals to Codex's auto-reviewer instead.
export function threadPolicy(mode: PermissionMode): Pick<ThreadStartParams, 'approvalPolicy' | 'approvalsReviewer' | 'sandbox'> {
  return mode === 'full'
    ? { approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' }
    : { approvalPolicy: 'on-request', sandbox: 'read-only', approvalsReviewer: 'user' };
}

export function turnPolicy(mode: PermissionMode): Pick<TurnStartParams, 'approvalPolicy' | 'approvalsReviewer' | 'sandboxPolicy'> {
  const sandboxPolicy: SandboxPolicy = mode === 'full' ? { type: 'dangerFullAccess' } : { type: 'readOnly', networkAccess: false };
  return { approvalPolicy: mode === 'full' ? 'never' : 'on-request', sandboxPolicy, approvalsReviewer: 'user' };
}

// Sent on thread/start and on every resume: the rollout doesn't keep config
// overrides (spike 3).
export function threadConfig(threadId: string, key?: string): Record<string, unknown> {
  return {
    // Adds to config.toml's own [shell_environment_policy.set] rather than
    // replacing it (spike 3), so the commands Codex runs know their thread
    // and tb in them is limited to it (docs/protocol/connection.md, "A thread's own key").
    'shell_environment_policy.set.THREADBEAR_THREAD_ID': threadId,
    ...(key ? { 'shell_environment_policy.set.THREADBEAR_THREAD_KEY': key } : {}),
    'tools.update_plan.enabled': true,
    mcp_optional_startup_grace_ms: 10000,
    // Without it every thread notes "Under-development features enabled:
    // chronicle..." (Mike has chronicle on).
    suppress_unstable_features_warning: true,
  };
}

// A Codex coordinator stays read-only. Codex runs MCP tools without asking,
// and config.toml's servers and plugins can make changes (node_repl,
// connectors, cua-driver), so its process starts with plugins and apps off,
// every configured server but Agent Archive is switched off for its thread,
// and the session refuses to start if any other server still offers tools.
// Agent Archive is kept only when Threadbear supplies it (its own command
// and args) and config.toml's entry of that name adds nothing that changes
// how it runs (an env like NODE_OPTIONS could load other code into it), and
// then only with its read tools (Codex's review, 26 Nov 2026).
export const COORDINATOR_CODEX_ARGS = ['--disable', 'plugins', '--disable', 'apps'];
const COORDINATOR_MCP_KEEP = 'agent-archive';
const PLAIN_ARCHIVE_KEYS = new Set(['command', 'args', 'enabled', 'startup_timeout_sec', 'tool_timeout_sec']);

function plainArchiveEntry(entry: unknown): boolean {
  if (entry === undefined) return true;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  // config/read adds environment_id "local" to every entry (0.172).
  return Object.entries(entry).every(([k, v]) => PLAIN_ARCHIVE_KEYS.has(k) || (k === 'environment_id' && v === 'local') || v === null || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && Object.keys(v).length === 0));
}

// configured: config/read's mcp_servers. supplied: Threadbear's own archive
// server is in this session's config.
export function coordinatorMcpOff(configured: Record<string, unknown>, supplied: boolean): Record<string, unknown> {
  const keep = supplied && plainArchiveEntry(configured[COORDINATOR_MCP_KEEP]);
  const names = new Set([...Object.keys(configured), ...(supplied ? [COORDINATOR_MCP_KEEP] : [])]);
  return Object.fromEntries([...names].flatMap((n): [string, unknown][] => (n === COORDINATOR_MCP_KEEP && keep ? [[`mcp_servers.${n}.enabled_tools`, [...ARCHIVE_READ_TOOL_NAMES]]] : [[`mcp_servers.${n}.enabled`, false]])));
}

type McpStatus = { name?: unknown; runtimeStatus?: unknown; tools?: unknown };
export function coordinatorMcpLeaks(statuses: readonly McpStatus[], keepArchive: boolean): string[] {
  return statuses.flatMap((s) => {
    const name = typeof s.name === 'string' ? s.name : '(unnamed)';
    const tools = s.tools && typeof s.tools === 'object' ? Object.keys(s.tools) : [];
    if (name === COORDINATOR_MCP_KEEP && keepArchive) return tools.every((t) => ARCHIVE_READ_TOOL_NAMES.includes(t)) ? [] : [name];
    return s.runtimeStatus === 'disabled' && tools.length === 0 ? [] : [name];
  });
}

// Servers as config overrides, beside config.toml's own [mcp_servers].
export function mcpServerConfig(servers: Record<string, { command: string; args: string[] }> = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(servers).flatMap(([name, s]) => [[`mcp_servers.${name}.command`, s.command], [`mcp_servers.${name}.args`, s.args]]));
}

function enabledSkills(r: SkillsListResponse | undefined) {
  return (r?.data ?? []).flatMap((e) => e.skills ?? []).filter((s) => s.enabled !== false && typeof s.name === 'string' && s.name && typeof s.path === 'string');
}

export function skillMap(r: SkillsListResponse | undefined): Map<string, string> {
  return new Map(enabledSkills(r).map((s) => [s.name!, s.path!]));
}

export function codexSkillCommands(r: SkillsListResponse | undefined): SlashCommand[] {
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const s of enabledSkills(r)) {
    if (seen.has(s.name!)) continue;
    seen.add(s.name!);
    const description = s.shortDescription || s.description;
    // Codex's "repo" is the folder's, as Claude's "project".
    const scope = s.scope === 'repo' ? 'project' : s.scope;
    out.push({ name: s.name!, source: 'skill', ...(description ? { description } : {}), ...(scope ? { scope } : {}), path: s.path! });
  }
  return out;
}

function inputItems(input: UserInput): UserInputItem[] {
  // Images as the paths the runner already copied into media/, each where
  // its [Picture N] marker is in the words, or before them when nothing
  // places it (pictures.ts). Codex reads and shrinks them itself (spike 6),
  // and the model sees the path, so "edit this picture" works. No
  // `detail`: "original" costs about four times the tokens.
  const items: UserInputItem[] = placePictures(input.text, input.images).map((part) =>
    'text' in part ? { type: 'text', text: part.text, text_elements: [] } : { type: 'localImage', path: part.image.path },
  );
  if (items.length === 0) items.push({ type: 'text', text: input.text, text_elements: [] });
  return items;
}

const CLOSING_RESUME = /is closing; retry thread\/resume/i;
const CLOSING_TURN = /is closing; retry after the thread is closed/i;
const NOT_FOUND = /no rollout found|thread not found|no such thread|unknown thread|does not exist/i;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

type SessionHooks = {
  track(p: AppServerProcess, live: boolean): void;
  child(parentThreadId: string, childThreadId: string): void;
  notice(text: string): void;
  // The adapter's readyHome: an extra login's links and hook trust.
  readyHome(account: Account): Promise<Record<string, unknown>>;
};

// A Codex turn the session is in. ids are the runner messages it answers:
// the one that started it, then the ones steered into it.
type ActiveTurn = {
  codexTurnId?: string;
  ids: string[];
  own: boolean; // Codex started it by itself
  startedAt: number;
  interruptRequested: boolean;
  steerQueue: UserInput[]; // sent before the turn id was known
  steers: Promise<void>[];
  // turn/completed has arrived and the end is being worked out: a message
  // sent now can't join this turn, so it waits for the next turn/start.
  ending: boolean;
  dropped: string[]; // held messages Stop dropped
  openCommands: Set<string>;
};

type State = 'starting' | 'ready' | 'turnPending' | 'turnActive' | 'closing' | 'closed';

export class CodexSession implements AgentSession {
  private opts: StartSessionOptions;
  private sink: SessionSink;
  private deps: CodexAdapterDeps;
  private hooks: SessionHooks;
  private t: CodexTimings;
  private now: () => number;
  private proc: AppServerProcess;
  private normalizer: CodexNormalizerLike;
  private ctx: NormalizerContext;
  private approvals: CodexApprovals;
  private tools: CodexTools;
  private rateLimits = new RateLimitTracker();
  private children = new ChildThreads();
  private state: State = 'starting';
  private threadId?: string;
  private turn?: ActiveTurn;
  private held: UserInput[] = [];
  // Steered/queued messages not yet acknowledged by Codex (in held, steerQueue,
  // or with turn/steer in flight), mapped to how many end_turn calls were
  // refused for each (capped at UNREAD_REFUSALS, like ClaudeSession).
  private notDelivered = new Map<UserInput, number>();
  private early: [string, unknown][] = []; // thread traffic before the thread id is known
  private unknown = new Map<string, [string, unknown][]>(); // traffic from threads being looked up
  private resumePending = false;
  private exitedCalled = false;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private queue: (() => void | Promise<void>)[] = [];
  private draining = false;
  private waitTimers: NodeJS.Timeout[] = [];
  private rules: Set<string>;
  private itemPaths = new Map<string, string[]>();
  private openMcpCalls = new Map<string, OpenMcpCall>();
  // Settings applied on the next turn/start.
  private model?: string;
  private modelChanged = false;
  private effort?: EffortLevel;
  private effortChanged = false;
  private mode: PermissionMode;
  private cwd: string;
  private sentCwd: string;
  // The model Codex said it runs, and whether the thread is in Codex's plan
  // mode: it keeps a collaboration mode for the turns after, so leaving
  // "Plan first" has to send default once.
  private liveModel?: string;
  private inPlan = false;

  constructor(opts: StartSessionOptions, sink: SessionSink, deps: CodexAdapterDeps, hooks: SessionHooks) {
    this.opts = opts;
    this.sink = sink;
    this.deps = deps;
    this.hooks = hooks;
    this.t = { ...DEFAULT_CODEX_TIMINGS, ...deps.timings };
    this.now = deps.now ?? Date.now;
    this.model = opts.model;
    this.effort = opts.effort;
    this.mode = opts.permissionMode;
    this.cwd = opts.cwd;
    this.sentCwd = opts.cwd;
    this.rules = new Set(opts.allowRules ?? []);
    this.exitPromise = new Promise((r) => (this.resolveExit = r));
    const base = fileContext(opts.cwd, opts.mediaDir, opts.blobsDir);
    // The folder can move between turns (setCwd), so relative paths are
    // read against the current one.
    const ctx: NormalizerContext = { ...base, readFile: (p) => base.readFile(path.isAbsolute(p) ? p : path.join(ctx.cwd, p)) };
    this.ctx = ctx;
    this.normalizer = deps.normalizer ? deps.normalizer(ctx, { threadId: opts.threadId }) : new CodexNormalizer(ctx, { log: deps.log });
    this.tools = new CodexTools(deps.toolsFor?.(opts.threadId) ?? [], {
      requestApproval: (req) => this.sink.requestApproval(req),
      cwd: () => this.cwd,
      mode: () => this.mode,
      rules: () => this.rules,
      addRules: (rules) => this.addRules(rules),
      ...(opts.coordinator
        ? {
            checkCoordinator: (fullName: string, args: Record<string, unknown>) =>
              opts.coordinator!.checkTool({ name: fullName, input: args, agentId: opts.coordinator!.role === 'helper' ? opts.threadId : undefined }),
          }
        : {}),
    });
    this.proc = new AppServerProcess({
      binary: deps.codexBinary(),
      args: opts.coordinator?.role === 'coordinator' ? [...(deps.codexArgs ?? []), ...COORDINATOR_CODEX_ARGS] : deps.codexArgs,
      account: opts.account,
      env: opts.env,
      cwd: opts.cwd,
      registry: deps.registry,
      log: deps.log,
      label: opts.threadId,
      maxLineBytes: deps.maxLineBytes,
      timings: this.t,
    });
    this.approvals = new CodexApprovals({
      log: deps.log,
      label: opts.threadId,
      reply: (id, result) => this.proc.respond(id, result),
      replyError: (id, code, message) => this.proc.respondError(id, code, message),
      requestApproval: (req) => this.sink.requestApproval(req),
      requestQuestion: (req) => this.sink.requestQuestion(req),
      rules: () => this.rules,
      addRules: (rules) => this.addRules(rules),
      note: (text) => this.sink.output({ kind: 'event', event: { type: 'system.note', text } }),
      cwd: () => this.cwd,
      itemPaths: (id) => this.itemPaths.get(id),
      openMcpCalls: (server, tool) => [...this.openMcpCalls.values()].filter((c) => c.server === server && c.tool === tool),
      runsAsCode: (file) => runsAsCodeByName(file) || (opts.runsAsCode?.(file) ?? false),
      callTool: (params, o) => this.tools.call(params, o),
      now: this.now,
      fullAccess: () => this.opts.coordinator?.role !== 'coordinator' && this.mode === 'full',
      ...(opts.coordinator
        ? {
            coordinatorRole: opts.coordinator.role,
            checkCoordinator: (method: string, input: Record<string, unknown>) =>
              opts.coordinator!.checkTool({ name: method, input, agentId: opts.coordinator!.role === 'helper' ? opts.threadId : undefined }),
          }
        : {}),
    });
    this.proc.onNotification = (method, params) => this.enqueue(() => this.route(method, params));
    this.proc.onRequest = (id, method, params) => this.enqueue(() => this.request(id, method, params));
    this.proc.onOversize = (info) => this.enqueue(() => this.route(OVERSIZED_LINE, info));
    this.proc.onExit = (err) => this.enqueue(() => this.exited(err));
  }

  // "Always allow" rules, kept for the thread so they outlast a release.
  private addRules(rules: string[]): void {
    for (const r of rules) this.rules.add(r);
    this.sink.output({ kind: 'allowRules', rules });
  }

  // ---- Start

  start(): void {
    this.hooks.track(this.proc, true);
    void this.boot().catch((e: unknown) => {
      if (this.state === 'closing' || this.state === 'closed') return void this.finish();
      this.deps.log.warn('codex session did not start', { threadId: this.opts.threadId, error: errText(e) });
      void this.finish(e instanceof Error ? e : new Error(String(e)), true);
    });
  }

  private async boot(): Promise<void> {
    const { opts } = this;
    const home = await this.hooks.readyHome(opts.account);
    await this.proc.start();
    if (this.state !== 'starting') {
      // Ended while the process started: finish() may have found nothing to
      // close yet, so close what started.
      await this.proc.close();
      return;
    }
    const coordinator = opts.coordinator?.role === 'coordinator';
    const supplied = mcpServerConfig(this.deps.mcpServers?.());
    const lockdown = coordinator ? coordinatorMcpOff(await this.configuredMcpServers(opts.cwd), 'mcp_servers.agent-archive.command' in supplied) : {};
    const keepArchive = coordinator && 'mcp_servers.agent-archive.enabled_tools' in lockdown;
    if (this.state !== 'starting') return;
    const common = {
      cwd: opts.cwd,
      ...(this.model ? { model: this.model } : {}),
      ...threadPolicy(opts.coordinator?.role === 'coordinator' ? 'ask' : this.mode),
      // The thread's projects, as developer instructions: config.toml's
      // own key, set per thread like the rest of threadConfig.
      config: { ...home, ...threadConfig(opts.threadId, opts.env?.THREADBEAR_THREAD_KEY), ...supplied, ...lockdown, ...(opts.instructions ? { developer_instructions: opts.instructions } : {}) },
    };
    let res: ThreadStartResponse;
    if (opts.resume) {
      // The id is known, so the resume's own traffic (notLoaded, then idle,
      // then the restored token usage) routes as this thread's while
      // resumePending is set.
      this.threadId = opts.sessionId;
      res = await this.resume({ ...common, threadId: opts.sessionId, excludeTurns: true });
    } else {
      const defs = this.deps.toolsFor?.(opts.threadId) ?? [];
      const tools = dynamicToolSpecs(defs);
      // With tools, the guidance on using them leads the developer
      // instructions (the namespace description is too short to hold it).
      const isHelper = opts.coordinator?.role === 'helper';
      const developer = [!isHelper && tools.length ? toolGuidance(defs) : '', !isHelper && tools.length ? (this.deps.extraGuidance?.() ?? '') : '', opts.instructions ?? ''].filter(Boolean).join('\n\n');
      const config = { ...common.config, ...(developer ? { developer_instructions: developer } : {}) };
      const params: ThreadStartParams = { ...common, config, ...(tools.length ? { dynamicTools: tools } : {}) };
      res = await this.proc.request<ThreadStartResponse>('thread/start', params);
    }
    if (this.state !== 'starting') return;
    const thread = res?.thread;
    if (!thread || typeof thread.id !== 'string') throw new Error('Codex started a thread without an id');
    this.threadId = thread.id;
    if (coordinator) {
      const leaks = coordinatorMcpLeaks(await this.mcpStatuses(thread.id), keepArchive);
      if (leaks.length) throw new Error(`This project coordinator didn't start: on Codex it would still have tools from ${leaks.join(', ')}, which can make changes outside its read-only boundary.`);
      if (this.state !== 'starting') return;
    }
    this.sentCwd = opts.cwd;
    this.normalizer.setThread?.(thread.id, typeof res.model === 'string' ? res.model : undefined);
    if (typeof res.model === 'string') this.liveModel = res.model;
    this.inPlan = res.collaborationMode?.mode === 'plan';
    this.sink.output({ kind: 'session', nativeSessionId: thread.id, ...(typeof res.model === 'string' ? { model: res.model } : {}) });
    if (this.proc.version) this.sink.output({ kind: 'cliVersion', version: this.proc.version });
    if (isEffortLevel(res.reasoningEffort)) this.sink.output({ kind: 'effort', level: res.reasoningEffort });
    this.state = 'ready';
    // Traffic that came before we knew our id, through the router now.
    const early = this.early;
    this.early = [];
    for (const [m, p] of early) this.enqueue(() => this.route(m, p));
    this.readAccount();
    this.enqueue(() => this.next());
  }

  // The effective config's MCP servers for this folder, project layers
  // included. A coordinator fails closed if Codex can't say.
  private async configuredMcpServers(cwd: string): Promise<Record<string, unknown>> {
    const r = await this.proc.request<{ config?: { mcp_servers?: unknown } }>('config/read', { cwd });
    const servers = r?.config?.mcp_servers;
    return servers && typeof servers === 'object' && !Array.isArray(servers) ? (servers as Record<string, unknown>) : {};
  }

  private async mcpStatuses(threadId: string): Promise<McpStatus[]> {
    const out: McpStatus[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.proc.request<{ data?: McpStatus[]; nextCursor?: string | null }>('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(r?.data)) throw new Error("Codex didn't list this coordinator's MCP servers.");
      out.push(...r.data);
      if (!r.nextCursor) return out;
      cursor = r.nextCursor;
    }
    throw new Error("Codex listed too many MCP servers for this coordinator.");
  }

  // thread/resume, with the retries the plan asks for: unarchive once, and
  // back off on "is closing" (defensive: never seen on 0.164.0, because a
  // resume in a fresh process has nothing to wait for).
  private async resume(params: ThreadResumeParams): Promise<ThreadStartResponse> {
    this.resumePending = true;
    let unarchived = false;
    let wait = this.t.closingRetryStartMs;
    const deadline = this.now() + this.t.closingRetryForMs;
    try {
      for (;;) {
        try {
          return await this.proc.request<ThreadStartResponse>('thread/resume', params);
        } catch (e) {
          const msg = errText(e);
          if (e instanceof CodexExitedError) throw e;
          if (CLOSING_RESUME.test(msg) && this.now() + wait <= deadline) {
            await sleep(wait);
            wait *= 2;
            continue;
          }
          if (/archived/i.test(msg) && !unarchived) {
            unarchived = true;
            await this.proc.request('thread/unarchive', { threadId: params.threadId });
            continue;
          }
          if (NOT_FOUND.test(msg)) throw new SessionNotFoundError(`The Codex thread to resume wasn't found (${msg}).`);
          throw e;
        }
      }
    } finally {
      this.resumePending = false;
    }
  }

  // The account's login and limits, read once per process. The limits go
  // through the normaliser as a merged account/rateLimits/updated, so later
  // partial updates land on top of them.
  private readAccount(): void {
    this.proc
      .request<GetAccountResponse>('account/read', {})
      .then((r) => {
        const l = limitsFromAccount(r as never);
        if (l) this.enqueue(() => this.sink.output(l));
      })
      .catch((e: unknown) => this.deps.log.debug('account/read failed', { threadId: this.opts.threadId, error: errText(e) }));
    // Updates that arrive before the reply are newer than the reading.
    const since = this.rateLimits.mark();
    this.proc
      .request<GetAccountRateLimitsResponse>('account/rateLimits/read', null)
      .then((r) => this.enqueue(() => this.toNormalizer('account/rateLimits/updated', this.rateLimits.read(r, since))))
      .catch((e: unknown) => this.deps.log.debug('account/rateLimits/read failed', { threadId: this.opts.threadId, error: errText(e) }));
  }

  // ---- The inbox. Notifications and requests are handled in arrival
  // order, synchronously, except while the end of a turn waits on Codex
  // (steers settling, terminals being stopped); then the rest queue up.

  private enqueue(fn: () => void | Promise<void>): void {
    this.queue.push(fn);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length) {
        const fn = this.queue.shift()!;
        try {
          const r = fn();
          if (r && typeof (r as Promise<void>).then === 'function') await r;
        } catch (e) {
          this.deps.log.error('codex session handler failed', { threadId: this.opts.threadId, error: errText(e) });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  // ---- Routing

  private route(method: string, params: unknown): void | Promise<void> {
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    if (method === 'serverRequest/resolved') return this.approvals.resolved(p.requestId as RequestId);
    let tid = typeof p.threadId === 'string' ? p.threadId : undefined;
    if (method === 'thread/started') tid = (p.thread as { id?: string } | undefined)?.id;
    if (!tid) return this.threadless(method, p);
    if (!this.threadId) {
      this.early.push([method, params]);
      return;
    }
    if (tid === this.threadId) return this.own(method, p);
    if (this.children.has(tid)) return this.child(tid, method, p);
    return this.stranger(tid, method, p);
  }

  // configWarning, deprecationNotice, account/*, and warnings or MCP
  // statuses with a null threadId: all of them belong to this process's one
  // session.
  private threadless(method: string, p: Record<string, unknown>): void {
    if (method === 'account/rateLimits/updated') return this.toNormalizer(method, this.rateLimits.update(p));
    if (method === 'configWarning') {
      const text = [p.summary, p.details].filter((x) => typeof x === 'string' && x).join(': ');
      if (text) this.hooks.notice(`Codex config: ${text}`);
    }
    this.toNormalizer(method, p);
  }

  private own(method: string, p: Record<string, unknown>): void | Promise<void> {
    this.learnChildren(method, p);
    this.trackItem(method, p);
    switch (method) {
      case 'turn/started':
        return this.turnStarted(p as unknown as TurnNotification);
      case 'turn/completed':
        return this.turnCompleted(p as unknown as TurnNotification);
      case 'thread/closed':
        if (!this.resumePending) return this.lost('closed');
        break;
      case 'thread/status/changed':
        if ((p.status as { type?: string } | undefined)?.type === 'notLoaded' && !this.resumePending) return this.lost('notLoaded');
        break;
    }
    this.toNormalizer(method, p);
  }

  private child(childId: string, method: string, p: Record<string, unknown>): void {
    this.learnChildren(method, p);
    const outs = this.normalizer.handle(method, p, { childThreadId: childId });
    // A child's turns are never this thread's turns.
    this.emit(outs.filter((o) => o.kind !== 'result' && o.kind !== 'cliTurn'));
  }

  // A thread id the map doesn't know: a child whose spawn we missed. Its
  // turn's rootTurnId names our turn, or thread/read names its parent.
  private stranger(tid: string, method: string, p: Record<string, unknown>): void {
    const root = (p.turn as { rootTurnId?: unknown } | undefined)?.rootTurnId;
    if (method === 'turn/started' && typeof root === 'string' && root === this.turn?.codexTurnId) {
      this.addChild(tid);
      return this.child(tid, method, p);
    }
    const waiting = this.unknown.get(tid);
    if (waiting) {
      waiting.push([method, p]);
      return;
    }
    this.unknown.set(tid, [[method, p]]);
    // Nothing below can reject: .catch turns a failed read into false, and
    // enqueue catches what its handler throws.
    void this.proc
      .request<{ thread?: { parentThreadId?: unknown } }>('thread/read', { threadId: tid })
      .then((r) => {
        const parent = r?.thread?.parentThreadId;
        return typeof parent === 'string' && (parent === this.threadId || this.children.has(parent));
      })
      .catch(() => false)
      .then((ours) =>
        this.enqueue(() => {
          const buffered = this.unknown.get(tid) ?? [];
          this.unknown.delete(tid);
          if (!ours) {
            this.deps.log.debug('dropped traffic from a thread that is not this one', { threadId: this.opts.threadId, other: tid, count: buffered.length });
            return;
          }
          this.addChild(tid);
          for (const [m, q] of buffered) this.child(tid, m, q as Record<string, unknown>);
        }),
      );
  }

  private addChild(id: string): void {
    if (this.children.has(id)) return;
    this.children.add(id);
    if (this.threadId) this.hooks.child(this.threadId, id);
  }

  private learnChildren(method: string, p: Record<string, unknown>): void {
    const before = new Set(this.children.ids());
    this.children.learn(method, p, this.threadId);
    for (const id of this.children.ids()) if (!before.has(id) && this.threadId) this.hooks.child(this.threadId, id);
  }

  // What the session needs to know about its own items: which commands are
  // open (to stop them after an interrupt) and which paths an edit touches
  // (for the approval card's title).
  private trackItem(method: string, p: Record<string, unknown>): void {
    if (method !== 'item/started' && method !== 'item/completed') return;
    const item = p.item as { type?: string; id?: string; changes?: { path?: unknown; kind?: { move_path?: unknown } }[]; server?: unknown; tool?: unknown; arguments?: unknown } | undefined;
    if (!item || typeof item.id !== 'string') return;
    if (item.type === 'commandExecution') {
      if (method === 'item/started') this.turn?.openCommands.add(item.id);
      else this.turn?.openCommands.delete(item.id);
    } else if (item.type === 'fileChange' && method === 'item/started' && Array.isArray(item.changes)) {
      // A rename's new name too: a file moved to .threadbear/patches is
      // written there (code-writes.ts).
      this.itemPaths.set(item.id, item.changes.flatMap((c) => [c?.path, c?.kind?.move_path]).filter((x): x is string => typeof x === 'string' && x !== ''));
      if (this.itemPaths.size > 200) this.itemPaths.delete(this.itemPaths.keys().next().value!);
    } else if (item.type === 'mcpToolCall') {
      if (method === 'item/started') {
        if (typeof item.server === 'string' && typeof item.tool === 'string') {
          this.openMcpCalls.set(item.id, { itemId: item.id, server: item.server, tool: item.tool, arguments: item.arguments });
          if (this.openMcpCalls.size > 200) this.openMcpCalls.delete(this.openMcpCalls.keys().next().value!);
        }
      } else {
        this.openMcpCalls.delete(item.id);
      }
    }
  }

  private toNormalizer(method: string, params: unknown): void {
    this.emit(this.normalizer.handle(method, params));
  }

  // The adapter decides which turns are its own: the normaliser's cliTurn
  // is dropped and the adapter emits its own (turnStarted), and results
  // reach the sink only through finishTurn.
  private emit(outs: AdapterOutput[]): void {
    for (const o of outs) {
      if (o.kind === 'cliTurn' || o.kind === 'result') continue;
      this.sink.output(o);
    }
  }

  // ---- Requests from Codex

  private request(id: RequestId, method: string, params: unknown): void {
    const tid = (params as { threadId?: unknown } | undefined)?.threadId ?? (params as { conversationId?: unknown } | undefined)?.conversationId;
    // Everything on this connection belongs to this session; anything not
    // from its own thread came from a subagent.
    const fromChild = typeof tid === 'string' && Boolean(this.threadId) && tid !== this.threadId;
    this.approvals.handle(id, method, params, { fromChild });
  }

  // ---- Turns

  private newTurn(o: { ids: string[]; own: boolean; codexTurnId?: string }): ActiveTurn {
    return { ...o, startedAt: this.now(), interruptRequested: false, steerQueue: [], steers: [], ending: false, dropped: [], openCommands: new Set() };
  }

  // Messages waiting for a turn/start, kept in the order they were sent:
  // a steer refused late can come back after a message sent behind it.
  private sendOrder = new WeakMap<UserInput, number>();
  private sends = 0;

  private hold(input: UserInput): void {
    const mine = this.sendOrder.get(input) ?? Infinity;
    const at = this.held.findIndex((m) => (this.sendOrder.get(m) ?? Infinity) > mine);
    if (at < 0) this.held.push(input);
    else this.held.splice(at, 0, input);
  }

  private notePending(input: UserInput): void {
    this.notDelivered.set(input, 0);
    while (this.notDelivered.size > 50) this.notDelivered.delete(this.notDelivered.keys().next().value!);
  }

  // Whether a steered or queued message has not yet been acknowledged by Codex
  // (waiting in held/steerQueue or with turn/steer in flight), so an end_turn
  // written before Codex took it is refused with UNREAD_MESSAGE.
  unreadMessage(): boolean {
    let unread = false;
    for (const [input, refused] of this.notDelivered) {
      if (refused >= 2) continue;
      this.notDelivered.set(input, refused + 1);
      unread = true;
    }
    return unread;
  }

  send(input: UserInput): void {
    this.sendOrder.set(input, this.sends++);
    switch (this.state) {
      case 'closing':
      case 'closed':
        this.deps.log.warn('a message reached a codex session that has ended', { threadId: this.opts.threadId });
        return;
      case 'starting':
        this.notePending(input);
        this.held.push(input);
        return;
      case 'ready':
        // Behind any already held, and whatever is held goes now: nothing
        // may sit in `held` while the session is idle.
        this.hold(input);
        this.next();
        return;
      case 'turnPending':
      case 'turnActive': {
        this.notePending(input);
        const turn = this.turn!;
        if (turn.interruptRequested) return this.holdBehindInterrupt(input);
        if (turn.ending) {
          // Counted in this turn's queuedTurns; next() starts it.
          this.hold(input);
          return;
        }
        if (this.state === 'turnPending' || !turn.codexTurnId) turn.steerQueue.push(input);
        else this.steer(turn, input);
        return;
      }
    }
  }

  // Starts the next held message, if any, now that nothing is running.
  private next(): void {
    if (this.state !== 'ready' || this.turn || !this.held.length) return;
    const [first, ...rest] = this.held;
    this.held = [];
    this.startTurn(first, rest);
  }

  private turnParams(input: UserInput): TurnStartParams {
    const params: TurnStartParams = {
      threadId: this.threadId!,
      input: inputItems(input),
      ...turnPolicy(this.opts.coordinator?.role === 'coordinator' ? 'ask' : this.mode),
      summary: 'detailed',
    };
    if (input.id) params.clientUserMessageId = input.id;
    // Codex keeps the folder, model and effort set on a turn for the turns
    // after it, so each is sent when it's set (the folder only when it moved).
    if (realOrSelf(this.cwd) !== realOrSelf(this.sentCwd)) params.cwd = this.cwd;
    const model = this.model ?? (this.modelChanged ? this.opts.account.defaultModel : undefined);
    if (model) params.model = model;
    const effort = this.effort ?? (this.effortChanged ? this.ownEffort(model) : undefined);
    if (effort) params.effort = effort;
    // "Plan first" is Codex's plan collaboration mode (with the read-only
    // sandbox turnPolicy gives it); its settings need a model by name.
    const plan = this.mode === 'plan';
    const collabModel = model ?? this.liveModel ?? this.opts.account.defaultModel;
    if ((plan || this.inPlan) && collabModel) {
      params.collaborationMode = { mode: plan ? 'plan' : 'default', settings: { model: collabModel, reasoning_effort: effort ?? null, developer_instructions: null } };
      this.inPlan = plan;
    }
    return params;
  }

  // Back to "the model's own level" after an effort was set in this
  // session: what Codex would pick with none sent.
  private ownEffort(model: string | undefined): EffortLevel | undefined {
    const acct = this.opts.account;
    if (acct.defaultEffort) return acct.defaultEffort;
    const id = model ?? acct.defaultModel;
    return acct.models?.find((m) => m.id === id || m.model === id)?.defaultEffort;
  }

  private startTurn(input: UserInput, steerLater: UserInput[] = []): void {
    this.notDelivered.delete(input);
    const turn = this.newTurn({ ids: input.id ? [input.id] : [], own: false });
    turn.steerQueue.push(...steerLater);
    this.turn = turn;
    this.state = 'turnPending';
    const params = this.turnParams(input);
    const sentBefore = this.sentCwd;
    if (params.cwd) this.sentCwd = params.cwd;
    this.normalizer.startingTurn?.(input.id);
    this.commandOrTurn(input, params, sentBefore)
      .then((res) => this.enqueue(() => this.turnStartAnswered(turn, res)))
      .catch((e: unknown) => this.enqueue(() => this.turnStartFailed(turn, e)));
  }

  // A slash command Codex's terminal app would run, as the app-server call
  // that does it (docs/protocol/threads.md, "Slash commands"). Each still runs as a
  // turn: Codex sends turn/started and turn/completed for it. Anything else
  // is a turn/start, with the skill a /<skill> names added to it.
  // sentBefore: a folder move this turn would have carried isn't carried
  // by a compaction or review, so the next turn/start sends it.
  private async commandOrTurn(input: UserInput, params: TurnStartParams, sentBefore: string): Promise<TurnStartResponse> {
    const cmd = parseCommand(input.text);
    if (!cmd || !this.threadId) return this.turnStart(params);
    const name = cmd.name.toLowerCase();
    if (name === 'compact' && params.cwd) this.sentCwd = sentBefore;
    if (name === 'compact') {
      await this.proc.request('thread/compact/start', { threadId: this.threadId });
      // No turn in the answer; turn/started brings its id (turnStarted).
      return {} as TurnStartResponse;
    }
    // A review/start runs where Codex last was, so with a move still to
    // send it's a turn instead, which carries the move, and Codex reviews
    // as asked in words.
    if (name === 'review' && !params.cwd) {
      const target = cmd.args ? { type: 'custom', instructions: cmd.args } : { type: 'uncommittedChanges' };
      return this.proc.request<TurnStartResponse>('review/start', { threadId: this.threadId, target, delivery: 'inline' });
    }
    if (name === 'review') return this.turnStart(params);
    const skill = (await this.skillPaths()).get(cmd.name);
    if (skill) params.input = [{ type: 'skill', name: cmd.name, path: skill }, ...params.input];
    return this.turnStart(params);
  }

  // The folder's skills by name, asked for once per folder.
  private skills?: { cwd: string; paths: Promise<Map<string, string>> };
  private skillPaths(): Promise<Map<string, string>> {
    if (this.skills?.cwd !== this.cwd) {
      const paths = this.proc
        .request<SkillsListResponse>('skills/list', { cwds: [this.cwd] }, 10_000)
        .then((r) => skillMap(r))
        .catch(() => {
          // Asked again next time rather than going without for good.
          this.skills = undefined;
          return new Map<string, string>();
        });
      this.skills = { cwd: this.cwd, paths };
    }
    return this.skills.paths;
  }

  async commands(): Promise<SlashCommand[]> {
    if (this.state === 'closing' || this.state === 'closed') return [];
    const r = await this.proc.request<SkillsListResponse>('skills/list', { cwds: [this.cwd] }, 10_000);
    return codexSkillCommands(r);
  }

  // turn/start, retried on "is closing" (defensive, as for resume).
  private async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    let wait = this.t.closingRetryStartMs;
    const deadline = this.now() + this.t.closingRetryForMs;
    for (;;) {
      try {
        return await this.proc.request<TurnStartResponse>('turn/start', params);
      } catch (e) {
        if (!(e instanceof CodexExitedError) && CLOSING_TURN.test(errText(e)) && this.now() + wait <= deadline) {
          await sleep(wait);
          wait *= 2;
          continue;
        }
        throw e;
      }
    }
  }

  private turnStartAnswered(turn: ActiveTurn, res: TurnStartResponse): void {
    if (this.turn !== turn) return;
    const id = res?.turn?.id;
    if (typeof id === 'string') {
      if (!turn.codexTurnId) turn.codexTurnId = id;
      this.normalizer.turnAccepted?.(id);
    }
    // A /compact's answer has no turn: it stays pending until turn/started
    // brings the id (turnStarted), so a Stop or words sent meanwhile wait
    // for it rather than going nowhere.
    else if (!turn.codexTurnId) return;
    this.activate(turn);
  }

  private turnStartFailed(turn: ActiveTurn, e: unknown): void {
    if (this.turn !== turn || this.state === 'closing' || this.state === 'closed') return;
    if (e instanceof CodexExitedError) return; // the exit handler reports it
    for (const m of turn.steerQueue) this.notDelivered.delete(m);
    const steerIds = turn.steerQueue.map((m) => m.id).filter((x): x is string => Boolean(x));
    this.turn = undefined;
    this.state = 'ready';
    this.finishTurn(
      turn,
      { outcome: turn.interruptRequested ? 'interrupted' : 'failed', durationMs: Math.max(0, this.now() - turn.startedAt), ...(turn.interruptRequested ? {} : { error: errText(e) }) },
      steerIds,
    );
    this.next();
  }

  // The turn's id is known: it's active. Messages sent meanwhile are
  // steered into it, and a Stop pressed meanwhile is sent now.
  private activate(turn: ActiveTurn): void {
    if (this.state === 'turnPending') this.state = 'turnActive';
    const queued = turn.steerQueue;
    turn.steerQueue = [];
    if (turn.interruptRequested) {
      for (const m of queued) this.notDelivered.delete(m);
      turn.dropped.push(...queued.map((m) => m.id).filter((x): x is string => Boolean(x)));
      void this.sendInterrupt(turn).catch(() => undefined);
      return;
    }
    for (const m of queued) this.steer(turn, m);
  }

  private turnStarted(p: TurnNotification): void {
    const id = p?.turn?.id;
    const turn = this.turn;
    if (typeof id === 'string') {
      if (turn && this.state === 'turnPending' && !turn.codexTurnId) {
        // Our turn/start hasn't answered yet, but this is its turn.
        turn.codexTurnId = id;
        this.activate(turn);

      } else if (!turn) {
        // Codex started a turn by itself (a goal, background work).
        this.turn = this.newTurn({ ids: [], own: true, codexTurnId: id });
        this.state = 'turnActive';
        this.sink.output({ kind: 'cliTurn' });
      }
    }
    this.toNormalizer('turn/started', p);
  }

  // A message sent while the runner thinks it can steer: into the active
  // Codex turn with turn/steer. If Codex refuses (the turn just ended, the
  // id doesn't match, the turn can't be steered) the message is held and
  // starts the next turn as soon as this one completes, which is what
  // Claude does with a message that arrives as it finishes.
  private steer(turn: ActiveTurn, input: UserInput): void {
    const done = this.proc
      .request<TurnSteerResponse>('turn/steer', {
        threadId: this.threadId!,
        expectedTurnId: turn.codexTurnId!,
        ...(input.id ? { clientUserMessageId: input.id } : {}),
        input: inputItems(input),
      })
      .then(() => {
        this.notDelivered.delete(input);
        if (input.id) {
          turn.ids.push(input.id);
          this.normalizer.steered?.(input.id);
        }
      })
      .catch((e: unknown) => {
        this.deps.log.info('codex refused a steer; holding the message for the next turn', { threadId: this.opts.threadId, error: errText(e) });
        if (turn.interruptRequested) {
          this.notDelivered.delete(input);
          if (input.id) turn.dropped.push(input.id);
        } else {
          this.hold(input);
          // Normally the turn's end starts it; if the turn has already
          // ended, this does.
          this.enqueue(() => this.next());
        }
      });
    turn.steers.push(done);
  }

  private async turnCompleted(p: TurnNotification): Promise<void> {
    const id = p?.turn?.id;
    const turn = this.turn;
    const outs = this.normalizer.handle('turn/completed', p);
    const ours = turn && (turn.codexTurnId === id || (this.state === 'turnPending' && !turn.codexTurnId));
    if (!turn || !ours) {
      // Not a turn this session is in (it never saw it start): show what
      // it produced, but it has no runner turn to end.
      this.emit(outs);
      return;
    }
    // A steer still in flight is either in this turn or refused and held;
    // the result has to say which. No new steer starts from here on.
    turn.ending = true;
    await Promise.all(turn.steers);
    // turn/interrupt doesn't stop a running command (spike 10). Stop the
    // ones this turn left open, or end the process, which does.
    let endAfter = false;
    if (p.turn.status === 'interrupted' && turn.openCommands.size) endAfter = !(await this.stopOpenCommands(turn));
    if (this.turn !== turn) return;
    this.turn = undefined;
    this.openMcpCalls.clear();
    this.clearWaitTimers();
    const result = outs.find((o): o is Extract<AdapterOutput, { kind: 'result' }> => o.kind === 'result')?.result;
    this.emit(outs);
    if (endAfter) {
      // The runner's turn ends with the session (as interrupted, since Stop
      // was pressed), and the next message resumes in a fresh process.
      this.deps.log.warn('could not stop a command after an interrupt; ending the codex process', { threadId: this.opts.threadId });
      this.state = 'closing';
      await this.finish();
      return;
    }
    this.state = 'ready';
    this.finishTurn(turn, result ?? fallbackResult(p.turn, turn, this.now()));
    this.next();
  }

  // Fills in which runner messages the turn answered, and how many wait for
  // the next turn/start, then hands the result to the runner.
  private finishTurn(turn: ActiveTurn, base: TurnResult, extra: string[] = []): void {
    const r: TurnResult = { ...base };
    const answered = [...turn.ids, ...extra, ...turn.dropped];
    delete r.own;
    delete r.answers;
    if (turn.own) r.own = true;
    else if (turn.ids.length) r.answers = turn.ids[0];
    if (answered.length || !turn.own) r.answered = answered;
    if (turn.dropped.length) r.unreceived = [...turn.dropped];
    r.queuedTurns = this.held.length;
    this.sink.output({ kind: 'result', result: r });
  }

  // After an interrupted turn: stop the background terminals for commands
  // the turn left open. True when every one reported terminated.
  private async stopOpenCommands(turn: ActiveTurn): Promise<boolean> {
    try {
      const list = await this.proc.request<{ data?: { itemId?: string; processId?: string }[] }>(
        'thread/backgroundTerminals/list',
        { threadId: this.threadId },
        this.t.terminateMs,
      );
      const mine = (list?.data ?? []).filter((t) => typeof t.itemId === 'string' && turn.openCommands.has(t.itemId) && typeof t.processId === 'string');
      let ok = true;
      for (const term of mine) {
        const r = await this.proc
          .request<{ terminated?: boolean }>('thread/backgroundTerminals/terminate', { threadId: this.threadId, processId: term.processId }, this.t.terminateMs)
          .catch(() => ({ terminated: false }));
        if (r?.terminated !== true) ok = false;
      }
      return ok;
    } catch (e) {
      this.deps.log.info('could not list background terminals after an interrupt', { threadId: this.opts.threadId, error: errText(e) });
      return false;
    }
  }

  // A message that arrives while an interrupted turn hasn't finished yet
  // (the runner gave up waiting for it): it can't steer, and a turn/start
  // now would steer the old turn instead of starting one. So it waits,
  // asking Codex to stop again every 10 seconds, and fails after a minute.
  private holdBehindInterrupt(input: UserInput): void {
    this.held.push(input);
    if (this.waitTimers.length) return;
    const turn = this.turn!;
    const again = setInterval(() => void this.sendInterrupt(turn).catch(() => undefined), this.t.reinterruptMs);
    const fail = setTimeout(() => this.enqueue(() => this.failHeld('Codex is still finishing the last turn')), this.t.finishWaitMs);
    again.unref();
    fail.unref();
    this.waitTimers.push(again, fail);
  }

  private failHeld(error: string): void {
    this.clearWaitTimers();
    for (const m of this.held) this.notDelivered.delete(m);
    const ids = this.held.map((m) => m.id).filter((x): x is string => Boolean(x));
    this.held = [];
    if (!ids.length) return;
    this.sink.output({ kind: 'result', result: { outcome: 'failed', error, durationMs: 0, answers: ids[0], answered: ids, queuedTurns: 0 } });
  }

  private clearWaitTimers(): void {
    for (const t of this.waitTimers) clearTimeout(t);
    this.waitTimers = [];
  }

  private async sendInterrupt(turn: ActiveTurn): Promise<void> {
    if (!turn.codexTurnId || !this.threadId) return;
    try {
      await this.proc.request('turn/interrupt', { threadId: this.threadId, turnId: turn.codexTurnId });
    } catch (e) {
      if (e instanceof CodexExitedError) throw e;
      // The turn ended meanwhile; turn/completed says how.
      this.deps.log.info('turn/interrupt failed', { threadId: this.opts.threadId, error: errText(e) });
    }
  }

  // Stop means stop: messages held for a later turn/start are dropped too.
  async interrupt(): Promise<void> {
    if (this.state === 'closed' || this.state === 'closing') {
      if (!this.proc.alive) throw new Error('The Codex process has already exited.');
      return;
    }
    const droppedInputs = [...this.held, ...(this.turn?.steerQueue ?? [])];
    for (const m of droppedInputs) this.notDelivered.delete(m);
    const dropped = droppedInputs.map((m) => m.id).filter((x): x is string => Boolean(x));
    this.held = [];
    const turn = this.turn;
    if (turn) turn.steerQueue = [];
    if (!turn) {
      // Still starting, or held behind start: nothing reached Codex.
      if (dropped.length) this.sink.output({ kind: 'result', result: { outcome: 'interrupted', durationMs: 0, answers: dropped[0], answered: dropped, unreceived: dropped, queuedTurns: 0 } });
      return;
    }
    if (turn.interruptRequested) {
      // A second Stop while the old turn finishes: the messages waiting
      // behind it belonged to a newer runner turn, which ends now.
      this.clearWaitTimers();
      if (dropped.length) this.sink.output({ kind: 'result', result: { outcome: 'interrupted', durationMs: 0, answers: dropped[0], answered: dropped, unreceived: dropped, queuedTurns: 0 } });
    } else {
      turn.interruptRequested = true;
      turn.dropped.push(...dropped);
    }
    if (this.state === 'turnPending' && !turn.codexTurnId) return; // sent once turn/start answers
    if (!this.proc.alive) throw new Error('The Codex process has already exited.');
    await this.sendInterrupt(turn);
  }

  // ---- Settings: stored, and applied on the next turn/start. Codex can't
  // change sandbox or approval mid-turn, hence settingsApplyNextTurn.

  async setModel(model: string | undefined): Promise<void> {
    if (model !== this.model) this.modelChanged = true;
    this.model = model;
  }

  async setEffort(effort: EffortLevel | undefined): Promise<void> {
    if (effort !== this.effort) this.effortChanged = true;
    this.effort = effort;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
  }

  // The same Codex thread carries on in the new folder from the next turn:
  // cwd on turn/start reloads its instructions (spike 10).
  async setCwd(cwd: string): Promise<void> {
    this.cwd = cwd;
    this.ctx.cwd = cwd;
  }

  // ---- Ending

  // The thread was unloaded under us (another client's resume or delete).
  // End the process; the next message resumes instead of failing a
  // turn/start on an unloaded thread.
  private async lost(why: string): Promise<void> {
    if (this.state === 'closing' || this.state === 'closed') return;
    this.deps.log.info('codex thread was unloaded; ending the session', { threadId: this.opts.threadId, why });
    this.state = 'closing';
    await this.finish();
  }

  // No thread/unsubscribe: it never unloads a thread. Closing stdin ends the
  // process, its MCP servers and any background terminals.
  async end(opts: { hard?: boolean } = {}): Promise<void> {
    if (this.state === 'closed') return this.exitPromise;
    this.state = 'closing';
    if (opts.hard) this.proc.kill();
    await this.finish();
  }

  kill(): void {
    if (this.state === 'closed') return;
    this.state = 'closing';
    this.proc.kill();
    this.exited();
  }

  private async finish(error?: Error, failedStart = false): Promise<void> {
    if (this.state !== 'closed') this.state = 'closing';
    // This reports the exit itself, with its own error, so the process's
    // exit handler (which would report a plain close) stands down.
    this.proc.onExit = null;
    await this.proc.close().catch(() => undefined);
    this.exited(error, failedStart);
  }

  private exited(error?: Error, failedStart = false): void {
    if (this.exitedCalled) return;
    this.exitedCalled = true;
    this.state = 'closed';
    this.clearWaitTimers();
    this.approvals.cancelAll();
    // A request that still arrives (the process is closing) is refused at
    // once by the process itself.
    this.proc.onRequest = null;
    this.hooks.track(this.proc, false);
    // No turn/completed or late item/completed is coming: close whatever is
    // still open, a running turn's rows or a background terminal left from
    // an earlier turn (the process exit stopped it). The runner's turn, if
    // any, ends with exited().
    this.emit(this.normalizer.closeOpen('Interrupted'));
    this.turn = undefined;
    if (error && !(error instanceof SessionNotFoundError) && !failedStart) {
      const tail = this.proc.stderrLines().slice(-5).join('\n');
      if (tail && !error.message.includes(tail)) error = new Error(`${error.message}\n${tail}`);
    }
    this.resolveExit();
    this.sink.exited(error);
  }

  // For tests and E: the binary this session's process runs.
  get binaryPath(): string | undefined {
    return this.proc.binaryPath;
  }
}

function fallbackResult(turn: TurnNotification['turn'], t: ActiveTurn, now: number): TurnResult {
  const status = turn?.status;
  const outcome = status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'completed';
  const r: TurnResult = { outcome, durationMs: typeof turn?.durationMs === 'number' ? turn.durationMs : Math.max(0, now - t.startedAt) };
  if (outcome === 'failed' && turn?.error?.message) r.error = turn.error.message;
  return r;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-exported for the runner's wiring and the tests.
export type { OversizedLine };
