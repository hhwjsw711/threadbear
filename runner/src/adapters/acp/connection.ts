// One ACP agent process (Agent Client Protocol, agentclientprotocol.com):
// newline-delimited JSON-RPC 2.0 over its stdio, in its own process group.
import type { ChildProcess } from 'node:child_process';
import { LineReader, MAX_LINE_BYTES, type OversizedLine } from '../codex/appserver.ts';
import { asAgent, backgroundPid, type BackgroundPidOptions, type BackgroundPidResult } from '../../background.ts';
import { RUNNER_VERSION } from '../../config.ts';
import type { Logger } from '../../log.ts';
import { groupAlive, groupSpawner, killGroup, type ProcessRegistry } from '../../proc.ts';

export type RequestId = number | string;

// Numbered as ACP's errors are; -32000 is its auth_required.
export const AUTH_REQUIRED = -32000;

// JSON-RPC's own words for its error codes, which say nothing about what
// went wrong. An agent that puts the real reason in `data` (Grok: "Internal
// error", with data.message "API error (status 402 Payment Required): Grok
// Build usage balance exhausted", 23 Nov 2026) is read from there instead.
const GENERIC_RPC_MESSAGES = new Set(['internal error', 'server error', 'invalid params', 'invalid request', 'parse error', 'method not found', 'unknown error', 'error']);
export function genericRpcMessage(m: string): boolean {
  return GENERIC_RPC_MESSAGES.has(m.trim().toLowerCase().replace(/[.!]+$/, ''));
}

// The reason an error's `data` gives, when it gives one in words: a string,
// or an object's message, error or detail.
export function rpcDataMessage(data: unknown): string | undefined {
  if (typeof data === 'string') return data.trim() || undefined;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  for (const k of ['message', 'error', 'detail']) {
    const v = d[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

// The HTTP status an error's `data` names (Grok's http_status), if any.
export function rpcDataStatus(data: unknown): number | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  const v = d.http_status ?? d.httpStatus ?? d.status;
  return typeof v === 'number' && Number.isInteger(v) && v >= 100 && v < 600 ? v : undefined;
}

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  // What the agent itself said, before `data` was preferred over it.
  readonly rpcMessage?: string;
  readonly httpStatus?: number;
  constructor(method: string, body: { code?: unknown; message?: unknown; data?: unknown }) {
    const said = typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : undefined;
    const detail = rpcDataMessage(body?.data);
    const generic = !said || genericRpcMessage(said);
    super((generic ? detail : undefined) ?? said ?? `${method} failed`);
    this.name = 'AcpRpcError';
    this.code = typeof body?.code === 'number' ? body.code : -32603;
    this.data = body?.data;
    if (said) this.rpcMessage = said;
    const status = rpcDataStatus(body?.data);
    if (status !== undefined) this.httpStatus = status;
  }
}

// Transient rate limits (RPM/TPM, requests per minute, rate limit headers)
// that pass in seconds and the agent retries with backoff.
const RATE_LIMIT = /requests? per (?:minute|hour)|tokens? per (?:minute|hour)|\b(?:rpm|tpm)\b|rate[- ]limit|too many requests|retry in \d+\s*(?:s|sec|second)|slow down/i;

// An agent's words for a login that has run out of what it pays with: a
// balance, credits, a spending cap or a usage limit (Grok 1.0.92's own
// strings for these, and its 402; Gemini/Google quota exhaustion for
// individual quota or subscription tier). Not a rate limit, which passes
// by itself in seconds and the agent retries.
const OUT_OF_USAGE = /usage balance exhausted|out of credits|run out of credits|spending[- ]limit|usage limit reached|credit limit|insufficient (?:credits|balance)|payment required|free usage limit|individual quota reached|upgrade your subscription/i;

// Fatal errors that abort the backend agent executor or harness process
// unexpectedly, leaving the ACP bridge hanging without answering session/prompt.
const FATAL_EXECUTION_ERROR = /^(?:Agent execution error:\s*)?Harness process exited unexpectedly|^Agent execution terminated due to error/i;

export function isFatalExecutionError(text: string): boolean {
  return FATAL_EXECUTION_ERROR.test(text.trim());
}

// Extracts readable text from an ACP update object (message/thought chunk,
// tool call update, or error object).
export function textFromUpdate(u: Record<string, unknown>): string {
  const texts: string[] = [];
  if (typeof u.text === 'string') texts.push(u.text);
  if (typeof u.message === 'string') texts.push(u.message);
  const pushBlock = (b: unknown) => {
    if (!b || typeof b !== 'object') return;
    const r = b as Record<string, unknown>;
    if (typeof r.text === 'string') texts.push(r.text);
    if (r.content && typeof r.content === 'object') pushBlock(r.content);
  };
  if (Array.isArray(u.content)) {
    for (const c of u.content) pushBlock(c);
  } else if (u.content && typeof u.content === 'object') {
    pushBlock(u.content);
  }
  if (typeof u.rawOutput === 'string') texts.push(u.rawOutput);
  else if (u.rawOutput && typeof u.rawOutput === 'object') {
    const msg = rpcDataMessage(u.rawOutput);
    if (msg) texts.push(msg);
  }
  if (typeof u.error === 'string') texts.push(u.error);
  else if (u.error && typeof u.error === 'object') {
    const msg = rpcDataMessage(u.error);
    if (msg) texts.push(msg);
  }
  return texts.join('\n').trim();
}

// What an agent's own note says went wrong in a turn, outside the prompt's
// answer: Grok's retry_state that failed ("API error (status 402 Payment
// Required): Grok Build usage balance exhausted") and its turn_completed with
// the error and its data, sent as _x.ai/session_notification. undefined for
// any other note.
export function failureNote(method: string, update: unknown): { message: string; httpStatus?: number } | undefined {
  if (!method.startsWith('_') || !update || typeof update !== 'object' || Array.isArray(update)) return undefined;
  const u = update as Record<string, unknown>;
  let message: string | undefined;
  let httpStatus: number | undefined;
  if (u.sessionUpdate === 'retry_state' && u.type === 'failed' && typeof u.message === 'string') message = u.message;
  else if (u.sessionUpdate === 'turn_completed' && (u.stop_reason === 'error' || (!!u.error && typeof u.error === 'object'))) {
    const err = u.error && typeof u.error === 'object' && !Array.isArray(u.error) ? (u.error as Record<string, unknown>) : {};
    message = rpcDataMessage(err.data) ?? (typeof u.agent_result === 'string' ? u.agent_result : undefined) ?? (typeof err.message === 'string' ? err.message : undefined);
    httpStatus = rpcDataStatus(err.data);
  }
  message = message?.trim();
  if (!message) return undefined;
  return httpStatus === undefined ? { message } : { message, httpStatus };
}

// Keeps the newest note's words, unless they're only JSON-RPC's "Internal
// error" after an earlier note said why, and any status an earlier one gave.
export function laterFailure(was: { message: string; httpStatus?: number } | undefined, now: { message: string; httpStatus?: number }): { message: string; httpStatus?: number } {
  const status = now.httpStatus ?? was?.httpStatus;
  const message = was && genericRpcMessage(now.message) ? was.message : now.message;
  return status === undefined ? { message } : { message, httpStatus: status };
}

// Whether an agent's failure says the login is out of usage, from its HTTP
// status (402 Payment Required) or its words.
export function outOfUsage(o: { message?: string; httpStatus?: number }): boolean {
  if (o.httpStatus === 402) return true;
  if (!o.message) return false;
  if (RATE_LIMIT.test(o.message) && !/individual quota reached|upgrade your subscription/i.test(o.message)) return false;
  return OUT_OF_USAGE.test(o.message);
}

export class AcpExitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpExitedError';
  }
}

export type InitializeResult = {
  protocolVersion?: number;
  agentCapabilities?: {
    loadSession?: boolean;
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    promptCapabilities?: { image?: boolean; embeddedContext?: boolean };
    sessionCapabilities?: { resume?: unknown; close?: unknown };
  };
  agentInfo?: { name?: string; version?: string } | null;
  authMethods?: { id?: string; name?: string }[];
  // Grok says who it is here: grokShell, and agentVersion for want of agentInfo.
  _meta?: { grokShell?: unknown; agentVersion?: unknown } | null;
};

export type AcpTimings = {
  requestMs: number; // an ordinary request
  sessionMs: number; // initialize, session/new, load and resume (cold boot and MCP servers)
  closeWaitMs: number; // after closing stdin, before killing the group
};
export const DEFAULT_ACP_TIMINGS: AcpTimings = { requestMs: 30_000, sessionMs: 90_000, closeWaitMs: 2_000 };

export type AcpProcessOptions = {
  binary: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  registry: ProcessRegistry;
  log: Logger;
  label: string; // the thread id, or "models:opencode-main", for log lines
  maxLineBytes?: number;
  timings?: Partial<AcpTimings>;
  // Offer form elicitation (questions for Mike): only a thread can show one.
  forms?: boolean;
  // A thread's agent, which runs builds and tests: started at the job
  // priority (asAgent). The model list and small jobs run nothing, so they
  // start as they are, kept clear of their timeouts on a busy Mac.
  lowered?: boolean;
  // With lowered: start niced so cold boot isn't disk-throttled by macOS
  // taskpolicy -b, then enter background priority right after initialize
  // (before session/new or any child process/tool starts).
  lowerAfterInit?: boolean;
  // Test hook for deferred backgrounding.
  backgroundPid?: (pid: number, opts?: BackgroundPidOptions) => Promise<BackgroundPidResult>;
};

// The ACP version this client speaks; initialize's answer must match it.
export const ACP_VERSION = 1;

export class AcpProcess {
  // Set by the session. A request from the agent with no handler is refused
  // at once, so the agent never waits on nobody.
  onRequest: ((id: RequestId, method: string, params: unknown) => void) | null = null;
  onNotification: ((method: string, params: unknown) => void) | null = null;
  onExit: ((error?: Error) => void) | null = null;
  version?: string;

  private opts: AcpProcessOptions;
  private t: AcpTimings;
  private child?: ChildProcess;
  private pid?: number;
  private abort?: AbortController;
  private bgAbort?: AbortController;
  private nextId = 1;
  private pending = new Map<RequestId, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  private stderrTail: string[] = [];
  private exited = true;
  private exitWaiters: (() => void)[] = [];
  private closing = false;
  private queuedLines: Buffer[] = [];
  private drainTimer?: NodeJS.Immediate;
  private pendingExit?: () => void;

  constructor(opts: AcpProcessOptions) {
    this.opts = opts;
    this.t = { ...DEFAULT_ACP_TIMINGS, ...opts.timings };
  }

  get alive(): boolean {
    return !this.exited;
  }

  stderrLines(): string[] {
    return [...this.stderrTail];
  }

  // Spawns the process and completes initialize.
  start(): Promise<InitializeResult> {
    const { opts } = this;
    this.abort = new AbortController();
    const spawn = groupSpawner(opts.registry, opts.log, (line) => this.stderr(line), opts.label);
    // At the job priority, so the builds and tests it runs are too (asAgent).
    const [command, args] = opts.lowered ? asAgent('acp', opts.binary, opts.args, { deferBackground: opts.lowerAfterInit }) : [opts.binary, opts.args];
    const child = spawn({ command, args, cwd: opts.cwd, env: opts.env, signal: this.abort.signal } as never) as unknown as ChildProcess;
    this.child = child;
    this.pid = child.pid;
    this.exited = false;
    return new Promise<InitializeResult>((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      child.on('error', (e) => {
        // ENOENT and friends: the spawn failed and no exit follows.
        this.markExited();
        fail(e);
      });
      child.stdin?.on('error', () => {
        // EPIPE when it died; the exit handler reports it.
      });
      const reader = new LineReader(
        opts.maxLineBytes ?? MAX_LINE_BYTES,
        (line) => this.enqueueLine(line),
        (info: OversizedLine) => opts.log.warn('skipped a line from an ACP agent over the size guard', { threadId: opts.label, bytes: info.bytes, method: info.method }),
      );
      child.stdout?.on('data', (d: Buffer) => reader.push(d));
      child.once('exit', (code, signal) => {
        const finishExit = () => {
          const tail = this.stderrTail.slice(-5).join('\n');
          this.markExited();
          const what = `The agent exited (${signal ?? `code ${code}`})${tail ? `\n${tail}` : ''}`;
          for (const p of this.pending.values()) {
            if (p.timer) clearTimeout(p.timer);
            p.reject(new AcpExitedError(what));
          }
          this.pending.clear();
          if (!settled) return fail(new AcpExitedError(what));
          const onExit = this.onExit;
          this.onExit = null;
          onExit?.(this.closing ? undefined : new Error(what));
        };
        if (this.drainTimer || this.queuedLines.length) {
          this.pendingExit = finishExit;
          this.scheduleDrain();
          return;
        }
        finishExit();
      });
      this.request<InitializeResult>('initialize', {
        protocolVersion: ACP_VERSION,
        // Nothing the agent could use to read or write through the client:
        // it works on the files itself, and asks first (AcpSession).
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...(opts.forms ? { elicitation: { form: {} } } : {}) },
        clientInfo: { name: 'threadbear', title: 'Threadbear', version: RUNNER_VERSION },
      })
        .then(async (init) => {
          if (init?.protocolVersion !== ACP_VERSION) {
            throw new Error(`This agent speaks ACP version ${String(init?.protocolVersion)}, and Threadbear speaks ${ACP_VERSION}.`);
          }
          if (typeof init?.agentInfo?.version === 'string') this.version = init.agentInfo.version;
          else if (typeof init?._meta?.agentVersion === 'string') this.version = init._meta.agentVersion;
          if (opts.lowered && opts.lowerAfterInit) {
            if (this.exited) throw new AcpExitedError('The agent exited during startup.');
            if (this.closing) throw new AcpExitedError('The agent stopped during startup.');
            const pid = this.pid;
            if (pid) {
              const lower = opts.backgroundPid ?? backgroundPid;
              const bg = new AbortController();
              this.bgAbort = bg;
              let outcome: BackgroundPidResult = 'skipped';
              try {
                outcome = await lower(pid, { expectedParent: process.pid, signal: bg.signal });
                if (outcome === 'failed' && !this.exited && !this.closing && !bg.signal.aborted) {
                  outcome = await lower(pid, { expectedParent: process.pid, signal: bg.signal });
                }
              } finally {
                if (this.bgAbort === bg) this.bgAbort = undefined;
              }
              if (this.exited) throw new AcpExitedError('The agent exited during startup.');
              if (this.closing) throw new AcpExitedError('The agent stopped during startup.');
              if (outcome === 'failed') {
                opts.log.warn('could not move ACP agent into background priority after initialize', { threadId: opts.label, pid });
                throw new Error('Could not move the agent into background priority after startup.');
              }
            }
          }
          if (this.exited) throw new AcpExitedError('The agent exited during startup.');
          if (this.closing) throw new AcpExitedError('The agent stopped during startup.');
          if (settled) return;
          settled = true;
          resolve(init ?? {});
        })
        .catch(fail);
    });
  }

  private markExited(): void {
    this.exited = true;
    this.bgAbort?.abort();
    const ws = this.exitWaiters;
    this.exitWaiters = [];
    ws.forEach((w) => w());
  }

  private stderr(line: string): void {
    if (!line.trim()) return;
    this.stderrTail.push(line);
    if (this.stderrTail.length > 20) this.stderrTail.shift();
    this.opts.log.debug('acp stderr', { threadId: this.opts.label, line: line.slice(0, 500) });
  }

  // Defer lines arriving behind a JSON-RPC response until promise continuations
  // for that response run (e.g. a session/prompt result followed in the same
  // stdout chunk by an agent-initiated wake notification).
  private enqueueLine(line: Buffer): void {
    if (this.drainTimer) {
      this.queuedLines.push(line);
      return;
    }
    if (this.onLine(line)) this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainTimer) return;
    this.drainTimer = setImmediate(() => {
      this.drainTimer = undefined;
      if (this.exited) {
        this.queuedLines.length = 0;
        return;
      }
      while (this.queuedLines.length) {
        const next = this.queuedLines.shift()!;
        if (this.onLine(next)) {
          this.scheduleDrain();
          return;
        }
      }
      if (this.pendingExit) {
        const done = this.pendingExit;
        this.pendingExit = undefined;
        done();
      }
    });
  }

  private onLine(line: Buffer): boolean {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line.toString('utf8'));
    } catch {
      this.opts.log.warn('unparseable line from an ACP agent', { threadId: this.opts.label, bytes: line.length });
      return false;
    }
    if (!msg || typeof msg !== 'object') return false;
    // An id can be 0: OpenCode numbers its requests from it.
    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string';
    if (typeof msg.method === 'string') {
      if (hasId) this.dispatchRequest(msg.id as RequestId, msg.method, msg.params);
      else this.safely(msg.method, () => this.onNotification?.(msg.method as string, msg.params));
      return false;
    }
    if (hasId) {
      const p = this.pending.get(msg.id as RequestId);
      if (!p) return false;
      this.pending.delete(msg.id as RequestId);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new AcpRpcError(p.method, msg.error as { code?: unknown; message?: unknown; data?: unknown }));
      else p.resolve(msg.result);
      return true;
    }
    return false;
  }

  // What the agent sends is its own to get wrong: a bad frame is logged, as
  // an exception out of a stream handler would take the runner down.
  private safely(method: string, f: () => void): void {
    try {
      f();
    } catch (e) {
      this.opts.log.error('acp notification handler threw', { threadId: this.opts.label, method, error: String(e) });
    }
  }

  private dispatchRequest(id: RequestId, method: string, params: unknown): void {
    if (this.onRequest) {
      try {
        this.onRequest(id, method, params);
      } catch (e) {
        this.opts.log.error('acp request handler threw', { threadId: this.opts.label, method, error: String(e) });
        this.respondError(id, -32603, 'Threadbear could not handle this request.');
      }
      return;
    }
    this.respondError(id, -32601, `Threadbear doesn't handle ${method} here.`);
  }

  private write(msg: Record<string, unknown>): boolean {
    const stdin = this.child?.stdin;
    if (this.exited || !stdin || stdin.destroyed || stdin.writableEnded) return false;
    stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    return true;
  }

  // timeoutMs null: no timeout (session/prompt, which lasts as long as the
  // turn does). Left out: requestMs, or sessionMs for initialize and the
  // session/ starters.
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number | null): Promise<T> {
    const id = this.nextId++;
    const starts = method === 'initialize' || method === 'session/new' || method === 'session/load' || method === 'session/resume';
    const ms = timeoutMs === undefined ? (starts ? this.t.sessionMs : this.t.requestMs) : timeoutMs;
    return new Promise<T>((resolve, reject) => {
      if (this.exited) return reject(new AcpExitedError('The agent is not running.'));
      let timer: NodeJS.Timeout | undefined;
      if (ms !== null) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`The agent didn't answer ${method} within ${Math.round(ms / 1000)} s`));
        }, ms);
        timer.unref();
      }
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      const msg: Record<string, unknown> = { id, method };
      if (params !== undefined) msg.params = params;
      if (!this.write(msg)) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(new AcpExitedError('The agent is not running.'));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: Record<string, unknown> = { method };
    if (params !== undefined) msg.params = params;
    this.write(msg);
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private waitExit(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      t.unref();
      this.exitWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  // Ends stdin; if the agent hasn't gone after closeWaitMs, its group is
  // killed. Agents that don't watch stdin (OpenCode's server loop) rely on
  // that second half.
  async close(): Promise<void> {
    this.closing = true;
    this.bgAbort?.abort();
    if (this.exited) return;
    this.child?.stdin?.end();
    if (await this.waitExit(this.t.closeWaitMs)) return;
    if (this.pid) killGroup(this.pid, 'SIGTERM');
    if (await this.waitExit(2000)) return;
    if (this.pid) killGroup(this.pid, 'SIGKILL');
    await this.waitExit(2000);
  }

  // Stops the process group straight away (SIGTERM, then SIGKILL).
  kill(error?: Error): void {
    this.closing = true;
    this.bgAbort?.abort();
    if (error) {
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
    }
    if (this.exited) return;
    if (!this.pid) return this.abort?.abort();
    const pid = this.pid;
    killGroup(pid, 'SIGTERM');
    setTimeout(() => {
      if (groupAlive(pid)) killGroup(pid, 'SIGKILL');
    }, 3000).unref();
  }
}
