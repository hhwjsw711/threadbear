// The threadbear tools for an ACP thread: its agent reaches them as an MCP
// server over HTTP, as an agent takes no in-process tools. One listener per
// live session, on 127.0.0.1, on a port the system picks.
//
// Only that thread's agent can use it: a 128-bit token on every request, a
// Host of the loopback address (so a page can't reach it by rebinding a
// name), and no browser Origin. Each call goes through the same gate as a
// Codex thread's tools (tool-gate.ts), as the agent's own permission request
// doesn't cover them. The token goes in a header rather than the URL, so it
// doesn't turn up in an agent's logs of its server list.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { Logger } from '../../log.ts';
import { gateThreadbearTool, type ToolGateDeps } from '../tool-gate.ts';
import { jsonSchema, NAMESPACE, type ToolDefinition } from '../codex/tools.ts';

const MAX_BODY = 16 * 1024 * 1024;
// Latest MCP revision this speaks: the client's own is echoed when given.
const MCP_VERSION = '2025-06-18';
const MAX_JSON_UNWRAP_PASSES = 3;

function valueAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

function setAtPath(root: Record<string, unknown>, path: readonly PropertyKey[], value: unknown): Record<string, unknown> {
  if (!path.length) return root;
  const clone = structuredClone(root);
  let cur: unknown = clone;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return clone;
    cur = (cur as Record<PropertyKey, unknown>)[path[i]!];
  }
  if (cur !== null && typeof cur === 'object') {
    (cur as Record<PropertyKey, unknown>)[path[path.length - 1]!] = value;
  }
  return clone;
}

function expectsStructured(issue: z.core.$ZodIssue): boolean {
  if (issue.code === 'invalid_type') return issue.expected === 'object' || issue.expected === 'array';
  return issue.code === 'invalid_union';
}

// Cursor CLI's CallDynamicTool wraps MCP arguments in an untyped OBJECT, and
// some models (notably Gemini) drop nested objects at depth 3+ inside arrays
// to null. Accepting JSON-encoded strings at paths where the schema expects an
// object or array lets agents send nested payloads (such as end_turn's asks
// options/links or completion.tasks) without changing published tool schemas.
function unwrapJsonStringArgs(raw: Record<string, unknown>, issues: readonly z.core.$ZodIssue[]): Record<string, unknown> | undefined {
  let next: Record<string, unknown> | undefined;
  const seen = new Set<string>();
  for (const issue of issues) {
    if (!issue.path.length || !expectsStructured(issue)) continue;
    const key = issue.path.map(String).join('.');
    if (seen.has(key)) continue;
    seen.add(key);
    const cur = valueAtPath(next ?? raw, issue.path);
    if (typeof cur !== 'string') continue;
    const trimmed = cur.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    next = setAtPath(next ?? raw, issue.path, parsed);
  }
  return next;
}

function droppedNestedNullHint(raw: Record<string, unknown>, issues: readonly z.core.$ZodIssue[]): string {
  const topFields = new Set<string>();
  for (const issue of issues) {
    if (issue.path.length < 2 || !expectsStructured(issue)) continue;
    if (valueAtPath(raw, issue.path) === null && typeof issue.path[0] === 'string') {
      topFields.add(issue.path[0]);
    }
  }
  if (!topFields.size) return '';
  return `\nIf your tool wrapper dropped nested objects to null, pass ${[...topFields].join(', ')} as a JSON-encoded string instead.`;
}

export type AcpMcpDeps = ToolGateDeps & {
  log: Logger;
  label: string;
  onToolStart?: (name: string, args: Record<string, unknown>) => string | undefined;
  onToolResult?: (itemId: string, ok: boolean, text: string) => void;
};

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n');
}

type JsonRpcRequest = { jsonrpc?: string; id?: number | string | null; method?: unknown; params?: unknown };

export class AcpMcpServer {
  readonly token = crypto.randomBytes(16).toString('hex');
  private byName = new Map<string, ToolDefinition>();
  private deps: AcpMcpDeps;
  private server?: http.Server;
  private port = 0;
  // Calls waiting for an answer, by JSON-RPC id, for notifications/cancelled.
  private open = new Map<number | string, AbortController>();

  constructor(tools: ToolDefinition[], deps: AcpMcpDeps) {
    for (const t of tools) this.byName.set(t.name, t);
    this.deps = deps;
  }

  async listen(): Promise<string> {
    const server = http.createServer((req, res) => void this.handle(req, res).catch(() => this.fail(res, 500, 'Internal error')));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    server.unref();
    this.port = (server.address() as AddressInfo).port;
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  // Calls still waiting on a card expire with it (the session is ending).
  close(): void {
    for (const a of this.open.values()) a.abort();
    this.open.clear();
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
  }

  private fail(res: http.ServerResponse, status: number, message: string): void {
    if (res.headersSent) return void res.end();
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(message);
  }

  private authorized(req: http.IncomingMessage): boolean {
    const given = Buffer.from(req.headers.authorization ?? '');
    const want = Buffer.from(`Bearer ${this.token}`);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers.host !== `127.0.0.1:${this.port}` && req.headers.host !== `localhost:${this.port}`) return this.fail(res, 403, 'Forbidden');
    if (req.headers.origin !== undefined) return this.fail(res, 403, 'Forbidden');
    if (!this.authorized(req)) return this.fail(res, 401, 'Unauthorized');
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') return this.fail(res, 404, 'Not found');
    // A GET would open a server-to-client stream, which nothing here uses.
    if (req.method !== 'POST') return this.fail(res, 405, 'Method not allowed');
    const body = await this.readBody(req);
    if (body === undefined) return this.fail(res, 413, 'Too large');
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(body) as JsonRpcRequest;
    } catch {
      return this.reply(res, null, undefined, { code: -32700, message: 'Parse error' });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this.reply(res, null, undefined, { code: -32600, message: 'Invalid request' });
    // A notification (initialized, cancelled) has no answer.
    if (msg.id === undefined || msg.id === null) {
      if (msg.method === 'notifications/cancelled') {
        const requestId = (msg.params as { requestId?: unknown } | undefined)?.requestId;
        if (typeof requestId === 'number' || typeof requestId === 'string') this.open.get(requestId)?.abort();
      }
      res.writeHead(202);
      res.end();
      return;
    }
    const ac = new AbortController();
    const callId = msg.id;
    this.open.set(callId, ac);
    // The agent gave up on the call (its own timeout, or it was stopped):
    // an unanswered card goes with it, so a late Allow runs nothing.
    res.once('close', () => {
      if (!res.writableEnded) ac.abort();
    });
    try {
      const result = await this.dispatch(msg, ac.signal);
      this.reply(res, msg.id, result);
    } catch (e) {
      this.reply(res, msg.id, undefined, { code: (e as { code?: number })?.code ?? -32603, message: (e as Error)?.message ?? 'Internal error' });
    } finally {
      if (this.open.get(callId) === ac) this.open.delete(callId);
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      let size = 0;
      req.on('data', (d: Buffer) => {
        size += d.length;
        if (size > MAX_BODY) {
          resolve(undefined);
          req.destroy();
          return;
        }
        parts.push(d);
      });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      req.on('error', reject);
    });
  }

  private reply(res: http.ServerResponse, id: number | string | null, result?: unknown, error?: { code: number; message: string }): void {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }));
  }

  private async dispatch(msg: JsonRpcRequest, signal: AbortSignal): Promise<unknown> {
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: NAMESPACE, version: '1' },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: [...this.byName.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: jsonSchema(t),
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        };
      case 'tools/call':
        return this.call(params, signal);
      default:
        throw Object.assign(new Error(`No method ${String(msg.method)}`), { code: -32601 });
    }
  }

  private text(t: string, isError: boolean): unknown {
    return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
  }

  private async call(params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const name = typeof params.name === 'string' ? params.name : '';
    const known = this.byName.get(name);
    if (!known) return this.text(`Threadbear has no tool called ${name || '(unnamed)'}. The threadbear tools it has are: ${[...this.byName.keys()].join(', ') || 'none'}.`, true);
    const raw = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    let candidate = raw;
    let tool = known.formFor?.(candidate) ?? known;
    let parsed = z.object(tool.inputSchema as z.ZodRawShape).safeParse(candidate);
    for (let pass = 0; !parsed.success && pass < MAX_JSON_UNWRAP_PASSES; pass++) {
      const unwrapped = unwrapJsonStringArgs(candidate, parsed.error.issues);
      if (!unwrapped) break;
      candidate = unwrapped;
      tool = known.formFor?.(candidate) ?? known;
      parsed = z.object(tool.inputSchema as z.ZodRawShape).safeParse(candidate);
    }
    if (!parsed.success) {
      const hint = droppedNestedNullHint(candidate, parsed.error.issues);
      return this.text(`Those arguments don't fit ${name}: ${z.prettifyError(parsed.error)}${hint}`, true);
    }
    const args = parsed.data as Record<string, unknown>;
    const gate = await gateThreadbearTool(this.deps, { fullName: `mcp__${NAMESPACE}__${name}`, readOnlyHint: tool.annotations?.readOnlyHint, args, signal });
    if (!gate.allowed) return this.text(gate.message, true);
    if (signal.aborted) return this.text('Cancelled.', true);
    const trace = this.deps.onToolStart?.(name, args);
    try {
      const result = await tool.handler(args, { signal });
      const text = contentText(result.content);
      if (trace !== undefined) this.deps.onToolResult?.(trace, !result.isError, text);
      return { content: result.content ?? [], ...(result.isError ? { isError: true } : {}) };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (trace !== undefined) this.deps.onToolResult?.(trace, false, msg);
      return this.text(msg, true);
    }
  }
}
