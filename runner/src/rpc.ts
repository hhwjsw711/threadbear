// WebSocket JSON-RPC 2.0 server at ws://127.0.0.1:<port>/rpc.
import type { YearTokenParams } from './year-token-maker.ts';
import { EXPERIMENTS, experimentOn } from './experiments.ts';
import http from 'node:http';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import { awakeTimeout, type AwakeTimer } from './awake-timer.ts';
import { WebSocketServer, WebSocket } from 'ws';
import type { Runner, Notification, CliControl } from './runner.ts';
import type { Logger } from './log.ts';
import { ARCHIVE_VERDICTS, UNARCHIVE_VERDICTS, CLI_POLICIES, EFFORT_LEVELS, ErrorCode, PROVIDERS, RpcError, isEffortLevel, isPermissionMode, isProvider } from './protocol.ts';
import type { Account, ArchiveVerdict, UnarchiveVerdict, ApprovalDecision, AskAnswer, CliPolicy, EffortLevel, ImageRef, PermissionMode, Provider, ShareAccess, ThreadStartedBy, ThreadSummary } from './protocol.ts';
import { MAX_BYLINE } from './needs.ts';
import { isMoved, mergeSummaries, type Bucket } from './handover.ts';
import { AUTH_VERSION, authProof, isNonce, isThreadId, newNonce, proofMatches, threadKey, type AuthChannel } from './rpc-auth.ts';
import type { CallerGate } from './rpc-gate.ts';
import { ForeignPeer, type PeerCaller, type PeerSocket } from './peer.ts';
import { cutSafely } from './safe-cut.ts';
import { wellFormedJson } from './well-formed-json.ts';
import { unsupportedResetMessage } from './reset-hint.ts';
import { fetchPr, fetchPrFiles, forgetStates, parsePrUrl, prAct, prStates, prStatus, type PrAction, type PrRef } from './github-pr.ts';

type Conn = {
  id: number;
  ws: WebSocket;
  authed: boolean;
  subs: Set<string>;
  client?: string;
  // hello's version and pid, and when it connected, for the log.
  clientVersion?: string;
  clientPid?: number;
  drainLink?: boolean;
  drainMutationGuard?: boolean;
  since: number;
  browserPanel?: boolean;
  authTimer?: AwakeTimer;
  // This connection's auth.challenge nonce (docs/protocol/connection.md, "Auth").
  challenge?: string;
  // Both ends of the client's TCP connection, to find its process (callerOf).
  peer?: PeerSocket;
  // Refused after auth (its process didn't match its key): frames are dropped.
  dropped?: boolean;
  // The thread this connection acts for (docs/protocol/connection.md, "A thread's own
  // key"): undefined for the owner. Set once the process lookup is done.
  caller?: string;
  // Set only once the owner token's connection is known not to be any
  // thread's: the process lookup found it under none, or this server has no
  // lookup. Until then (and for good, if the lookup couldn't tell) an
  // undefined caller is nobody, never the owner (Daybreak finding 175).
  owner?: boolean;
  ownerPids?: number[];
  drainHelloSeen?: boolean;
  // While the process lookup runs, frames wait here so a request can't get
  // ahead of it (a stolen token's first request, say).
  identifying?: Promise<void>;
  queue: string[];
  queuedBytes?: number;
};

// Until a connection has authenticated (docs/protocol/connection.md, "Auth"), it gets
// a small frame limit, a short deadline, and only so many of them may wait
// at once: without these, anyone on the Mac could open sockets and send
// 64 MiB frames for the runner to buffer and JSON-parse before it even
// looked at the credentials.
const AUTH_TIMEOUT_MS = 3000;
const PREAUTH_MAX_PAYLOAD = 64 * 1024;
const MAX_PENDING_AUTH = 16;
// Frames that may wait for the process lookup (a few, in practice; the client
// has only just proved itself). The frame limit stays at PREAUTH_MAX_PAYLOAD
// until the lookup is done, and the queue has a byte budget too: a thread's
// key alone mustn't let it park gigabytes in the runner (Daybreak finding 158).
const MAX_QUEUED_FRAMES = 256;
const MAX_QUEUED_BYTES = 1024 * 1024;
// Process lookups a thread's key may have running at once, and all thread
// keys together.
const MAX_LOOKUPS_PER_THREAD = 4;
const MAX_THREAD_LOOKUPS = 16;
// What an authenticated client may send in one frame.
const MAX_PAYLOAD = 64 * 1024 * 1024;
// Backpressure for a client that stops reading (a hung app, a debugger):
// past SKIP_DELTAS_BYTES of unsent data, transient deltas are skipped (the
// persisted event replaces them anyway); past CLOSE_BYTES the socket is
// closed with 4408, and the client reconnects and replays from its last seq.
const SKIP_DELTAS_BYTES = 1024 * 1024;
const CLOSE_BYTES = 32 * 1024 * 1024;
// How long close() waits for clients to finish closing before dropping them.
const CLOSE_GRACE_MS = 1000;

// Requests about one thread. During a handover (docs/protocol.md) the
// primary passes these to the draining runner that has the thread, and a
// draining runner answers -32030 for one it has let go.
export const THREAD_METHODS = new Set([
  'reviews.list',
  'reviews.create',
  'reviews.get',
  'reviews.save',
  'reviews.respond',
  'reviews.cancel',
  'buttons.list',
  'buttons.press',
  'threads.send',
  'threads.edit',
  'threads.interrupt',
  'threads.update',
  'threads.delete',
  'threads.events',
  'threads.subscribe',
  'threads.heldBody',
  'threads.markSeen',
  'threads.highlights',
  'prWatch.set',
  'threads.commands',
  'threads.contextUsage',
  'threads.explain',
  'threads.hibernateWhen',
  'threads.removeHighlight',
  'threads.panelShown',
  'threads.showPanel',
  'threads.tickAsk',
  'threads.share',
  'approvals.respond',
  'plans.approve',
  'secrets.answer',
  'panels.render',
  'panels.toggle',
  'panels.convexKey',
  'panels.convexDeployments',
  'panels.convexLogin',
  'actions.run',
  'patches.trust',
  'threads.subagent',
]);

// Requests that carry Mike's words or pictures to a thread: with a
// `runnerId`, refused unless they reach the runner the app shows the thread
// on (docs/protocol.md, threads.send).
const SHOWN_ON_METHODS = new Set(['threads.send', 'threads.edit']);

// Draining runners' threads, as the primary's server sees them (handover.ts
// Peers).
export type RemoteThreads = {
  owns(threadId: string): boolean;
  call(threadId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  summaries(include: Bucket[]): ThreadSummary[];
  search(query: string, limit: number): Promise<ThreadSummary[]>;
};

// relay.ts's Relay, as the server uses it.
export type RelayHandler = {
  owns(threadId: string): boolean;
  /** The runner a relayed request about the thread would reach, if any. */
  ownerOf?(threadId: string): string | undefined;
  call(threadId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  create(runnerId: string, params: Record<string, unknown>): Promise<unknown>;
  listFolder(runnerId: string, path: string): Promise<unknown>;
  /** A picture pasted into one of another runner's messages, from the backend's file storage (relay.ts readFile); any other path is refused. */
  readFile?(runnerId: string, path: string, maxBytes?: number): Promise<unknown>;
  logins(runnerId: string): Promise<unknown>;
  /** accounts.yearToken for one of another runner's logins, through an allow-listed `call`. */
  yearToken?(runnerId: string, params: { accountId: string } & YearTokenParams): Promise<unknown>;
  /** accounts.useReset for one of another runner's logins, through an allow-listed `call`. */
  useReset?(runnerId: string, accountId: string): Promise<unknown>;
};

export type RpcServerOptions = {
  host: string;
  port: number;
  token: string;
  runner: Runner;
  log: Logger;
  // Methods served beside the runner's own (runner.status and
  // runner.restart, from restart.ts), and notices for a client that has
  // just said hello beside the runner's.
  methods?: Record<string, (params: Record<string, unknown>) => unknown>;
  helloNotices?: () => { level: 'info' | 'warning' | 'error'; message: string }[];
  // E's CliUpdates, for clis.*. Without it they answer -32601, as an older
  // runner's would.
  clis?: CliControl;
  // The primary's draining runners, whose threads it passes requests to.
  remote?: RemoteThreads;
  // A draining runner's own server: only the threads it still has.
  onlyOwn?: boolean;
  // Other runners' threads, through the backend (relay.ts). Without it, or
  // for a thread it doesn't own, they're unknown here as before.
  relay?: RelayHandler;
  // threads.create with a serviceId: a thread on a virtual runner (virtual-runners.ts).
  virtualStart?: (params: Record<string, unknown>) => Promise<unknown>;
  // Whether this runner knows of a move under way for another runner's
  // thread (main.ts remoteMoving). A relayed send or edit that doesn't say
  // which runner it's shown on is refused meanwhile (mustReachShown).
  relayMoving?: (threadId: string) => boolean;
  // hello's `updates` (docs/protocol/updates.md, "Runner updates").
  updates?: () => unknown;
  // The Mac app's hello with its build (docs/protocol/updates.md, "App restarts").
  appHello?: (build: { commit: string; short: string; tree: string }, app: 'mac' | 'desktop') => void;
  // Any hello from the GPUI app, built or not (swift-changes.ts's first look).
  desktopHello?: () => void;
  // Either Mac app said hello or went, a dev build too (app-seen.ts).
  appSeen?: () => void;
  // What a connection that belongs to a thread may do (rpc-gate.ts).
  gate?: CallerGate;
  // The thread whose CLI the process at the client's end of this exact
  // connection runs under, or none (peer.ts, docs/protocol/connection.md "Who's really
  // calling"). Rejects when it can't say (UnresolvedPeer, AmbiguousPeer):
  // the connection closes.
  callerOf?: (sock: PeerSocket) => Promise<PeerCaller>;
  isDrainingPid?: (pid: number) => boolean;
  // Tests shorten these.
  authTimeoutMs?: number;
  maxPendingAuth?: number;
  skipDeltasBytes?: number;
  closeBytes?: number;
  closeGraceMs?: number;
};

export class RpcServer {
  private opts: RpcServerOptions;
  private http: http.Server;
  private wss: WebSocketServer;
  private conns = new Set<Conn>();
  private nextId = 1;
  private unlisten: () => void;

  constructor(opts: RpcServerOptions) {
    this.opts = opts;
    this.http = http.createServer((req, res) => {
      // Unauthenticated health check for scripts; it says nothing else.
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // A socket that never finishes its request headers is let go sooner
    // than Node's minute.
    this.http.headersTimeout = 10_000;
    // The upgrade is handled here rather than by ws so a wrong header or
    // too many connections waiting to authenticate is refused before it
    // becomes a WebSocket. Every socket starts on the small pre-auth frame
    // limit; unlock() raises it once the client has authenticated.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: PREAUTH_MAX_PAYLOAD });
    this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    // The HTTP server's errors (EADDRINUSE on listen): listen() reports
    // those, and without a listener here they'd crash the process. ws used
    // to listen for them when it owned the upgrade.
    this.http.on('error', (e) => opts.log.warn('rpc server error', { error: String(e) }));
    this.wss.on('error', (e) => opts.log.warn('websocket server error', { error: String(e) }));
    this.unlisten = opts.runner.onNotification((n) => this.broadcast(n));
  }

  listen(): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.opts.port, this.opts.host, () => {
        this.http.off('error', reject);
        const addr = this.http.address();
        resolve({ port: typeof addr === 'object' && addr ? addr.port : this.opts.port });
      });
    });
  }

  // accounts.useReset for a login in another runner's list (a remote
  // thread's login list). A subscription is one limit wherever it's signed
  // in, so it's spent on this runner's login of the same provider and email
  // when there is one, which also shows here at once; else on that runner,
  // through Convex.
  private async useResetElsewhere(runnerId: string, accountId: string): Promise<unknown> {
    const relay = this.opts.relay;
    if (!relay) throw new RpcError(ErrorCode.other, "This Mac's runner can't reach other runners through Convex.");
    const theirs = ((await relay.logins(runnerId)) as { accounts?: Account[] } | undefined)?.accounts?.find((a) => a.id === accountId);
    if (theirs && theirs.provider !== 'codex') throw new RpcError(ErrorCode.badParams, unsupportedResetMessage(theirs.provider));
    const email = theirs?.email?.toLowerCase();
    const mine = email ? this.opts.runner.safeAccounts().find((a) => a.provider === 'codex' && a.email?.toLowerCase() === email && !a.signedOut && !a.planEnded) : undefined;
    if (mine) return this.opts.runner.useReset(mine.id);
    if (!relay.useReset) throw new RpcError(ErrorCode.other, "This Mac's runner can't use another runner's resets.");
    return relay.useReset(runnerId, accountId);
  }

  async close(): Promise<void> {
    this.unlisten();
    for (const c of this.conns) {
      c.authTimer?.clear();
      c.ws.close(1001, 'runner stopping');
    }
    // wss.close waits for every client to answer the close, and ws gives a
    // silent one (a suspended app, a script blocked on `launchctl kickstart
    // -k`, which waits for this very exit) 30 s. That's past launchd's
    // ExitTimeOut, which would SIGKILL the runner and leave its CLIs for the
    // next start to sweep, so cut stragglers off after a moment.
    const cutOff = setTimeout(() => {
      for (const ws of this.wss.clients) ws.terminate();
    }, this.opts.closeGraceMs ?? CLOSE_GRACE_MS);
    await new Promise<void>((r) => this.wss.close(() => r()));
    clearTimeout(cutOff);
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  // Clients that have authenticated and are still connected (a draining
  // runner's server counts the primaries listening to it).
  connectedClients(): number {
    let n = 0;
    for (const c of this.conns) if (c.authed && c.ws.readyState === WebSocket.OPEN) n++;
    return n;
  }

  /** Whether any client is subscribed to a thread (relay.ts watches only then). */
  isSubscribed(threadId: string): boolean {
    for (const c of this.conns) if (c.authed && c.subs.has(threadId) && c.ws.readyState === WebSocket.OPEN) return true;
    return false;
  }

  /** A notification for clients only, never the runner's own listeners: relay.ts's events are another runner's, which sync must not mirror as this one's. */
  notifyClients(n: Notification): void {
    this.broadcast(n);
  }

  // Whether the Mac app itself is connected (hello's client), for presence.ts.
  // The GPUI app counts too; for a browser panel, either only when its hello
  // says it has one.
  appConnected(browserPanel = false): boolean {
    for (const c of this.conns) if (c.authed && (c.client === 'threadbear-mac' || c.client === 'threadbear-desktop') && (!browserPanel || c.browserPanel) && c.ws.readyState === WebSocket.OPEN) return true;
    return false;
  }

  private tokenOk(candidate: unknown): boolean {
    if (typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.opts.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Process lookups still running (Daybreak finding 158). Each counts until
  // it settles, even after its client has gone, so connecting and leaving
  // can't start them without end. The owner token's take one of the slots
  // for clients waiting to authenticate; a thread key's have their own,
  // a few per thread, so one thread can't fill the slots the app and tb
  // need (the reviews of the fix).
  private ownerLookups = 0;
  private threadLookups = new Map<string, number>();

  private pendingAuth(): number {
    let n = this.ownerLookups;
    for (const c of this.conns) if (!c.authed) n++;
    return n;
  }

  private lookupsOf(keyThread: string | undefined): number {
    if (keyThread === undefined) return this.ownerLookups;
    return this.threadLookups.get(keyThread) ?? 0;
  }

  private countLookup(keyThread: string | undefined, by: 1 | -1): void {
    if (keyThread === undefined) {
      this.ownerLookups += by;
      return;
    }
    const n = (this.threadLookups.get(keyThread) ?? 0) + by;
    if (n > 0) this.threadLookups.set(keyThread, n);
    else this.threadLookups.delete(keyThread);
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const refuse = (status: number, text: string) => {
      if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if ((req.url ?? '').split('?')[0] !== '/rpc') return refuse(400, 'Bad Request');
    // A browser always says where the page that opened a WebSocket came
    // from; the runner's own clients (tb, the apps, another runner) never
    // do. So a page on any site that reaches 127.0.0.1 is turned away here,
    // before it can take one of the slots below and keep the apps and tb
    // out (Daybreak finding 146).
    if (req.headers.origin !== undefined) return refuse(403, 'Forbidden');
    // An old client's bearer header (docs/protocol/connection.md, "Before the
    // challenge"): right, it's in; wrong, it's refused here. No header means
    // the challenge.
    const header = req.headers.authorization;
    let authed = false;
    if (header !== undefined) {
      const m = /^Bearer\s+(.+)$/i.exec(header);
      if (!m || !this.tokenOk(m[1].trim())) return refuse(401, 'Unauthorized');
      authed = true;
    }
    // A bearer client is in, but its process lookup is still to come, so it
    // waits its turn too (Gemini's review of the fix for finding 158).
    if ((!authed || this.opts.callerOf) && this.pendingAuth() >= (this.opts.maxPendingAuth ?? MAX_PENDING_AUTH)) {
      return refuse(503, 'Service Unavailable');
    }
    const { remoteAddress, remotePort, localAddress, localPort } = req.socket;
    const peer = remoteAddress && remotePort && localAddress && localPort ? { remoteAddress, remotePort, localAddress, localPort } : undefined;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, authed, peer));
  }

  // Raises an authenticated socket's frame limit. ws has no public way to
  // change maxPayload on a live socket, so this sets its receiver's
  // (ws 8.x; rpc.test.ts fails if a ws update moves it).
  //
  // The process lookup can only ever lower what a credential gets: the owner
  // token from under a thread's CLI becomes that thread. A thread's key is
  // already a thread, so the lookup may only agree with it; naming another
  // thread (a key lifted from another thread's environment, or a lookup
  // fooled into naming someone else's process) closes the connection
  // instead of picking either (Daybreak finding 137). So does a lookup that
  // can't say which thread (AmbiguousPeer).
  //
  // A lookup that can't say who it is (it failed, ran out of time or found
  // nobody holding the socket) closes the connection too, on every system,
  // the owner token's and a key's alike: an unplaced owner token used to be
  // taken as the owner, which a thread with its key wiped could ride
  // (Daybreak finding 175). The app and tb connect again. One under another
  // runner's thread, nearer than any of this runner's (ForeignPeer), closes
  // with 4403 (Daybreak finding 177).
  private unlock(conn: Conn, keyThread?: string): void {
    conn.caller = keyThread;
    const find = this.opts.callerOf;
    // No lookup on this server (a test's): the credential decides.
    if (!find) conn.owner = keyThread === undefined;
    else if (conn.peer === undefined) {
      this.opts.log.warn("an RPC client's socket has no address to look up; closing it", { conn: conn.id });
      conn.authed = true;
      conn.authTimer?.clear();
      return this.dropConn(conn, 4503, 'could not tell which process connected');
    }
    if (find && conn.peer !== undefined) {
      let threads = 0;
      for (const n of this.threadLookups.values()) threads += n;
      if (keyThread !== undefined && (this.lookupsOf(keyThread) >= MAX_LOOKUPS_PER_THREAD || threads >= MAX_THREAD_LOOKUPS)) {
        // Left unauthenticated, so it counts as waiting until it's gone, as
        // a refused one does (refuseConn).
        conn.dropped = true;
        conn.authTimer?.clear();
        conn.ws.close(4429, 'too many connections being looked up');
        setTimeout(() => conn.ws.terminate(), 1000).unref();
        return;
      }
      this.countLookup(keyThread, 1);
      conn.identifying = find(conn.peer)
        .then((found) => {
          const t = found?.kind === 'thread' ? found.threadId : undefined;
          if (found?.kind !== 'thread' && found?.kind !== 'owner') throw new Error(`the lookup gave no answer: ${JSON.stringify(found)}`);
          if (keyThread !== undefined && t !== undefined && t !== keyThread) {
            this.opts.log.warn("an RPC client's key and its process name different threads; closing it", { conn: conn.id, key: keyThread, process: t });
            return this.dropConn(conn);
          }
          if (t) conn.caller = t;
          else if (keyThread === undefined) { conn.owner = true; conn.ownerPids = found.kind === 'owner' ? found.pids : undefined; }
        })
        .catch((e) => {
          // Under another runner's thread (Daybreak finding 177): no use
          // trying again, so 4403, not 4503.
          if (e instanceof ForeignPeer) return this.dropConn(conn, 4403, "under another runner's thread");
          this.opts.log.warn('could not tell which thread an RPC client is; closing it', { conn: conn.id, error: String(e) });
          this.dropConn(conn, 4503, 'could not tell which process connected');
        })
        .finally(() => {
          this.countLookup(keyThread, -1);
          conn.identifying = undefined;
          conn.queuedBytes = 0;
          if (conn.dropped || conn.ws.readyState !== WebSocket.OPEN) return;
          this.raiseFrameLimit(conn);
          for (const raw of conn.queue.splice(0)) this.onMessage(conn, raw);
        });
    }
    conn.authed = true;
    conn.authTimer?.clear();
    conn.challenge = undefined;
    // Only once the runner knows who it's talking to does a frame get bigger
    // than before auth (Daybreak finding 158).
    if (!conn.identifying) this.raiseFrameLimit(conn);
  }

  private raiseFrameLimit(conn: Conn): void {
    const receiver = (conn.ws as unknown as { _receiver?: { _maxPayload?: unknown } })._receiver;
    if (receiver && typeof receiver._maxPayload === 'number') receiver._maxPayload = MAX_PAYLOAD;
    else this.opts.log.warn('could not raise the frame limit for an authenticated client', { conn: conn.id });
  }

  // Closes an authenticated connection whose caller can't be trusted, before
  // any of its requests run.
  // 4403 when its process names another thread than its key, 4503 when the
  // lookup couldn't place it (a client may try again).
  private dropConn(conn: Conn, code = 4403, reason = 'caller does not match its process'): void {
    conn.dropped = true;
    conn.queue.length = 0;
    conn.ws.close(code, reason);
    setTimeout(() => conn.ws.terminate(), 1000).unref();
  }

  // Closes an unauthenticated connection with 4401, and cuts it off if it
  // doesn't answer the close within a second: ws would otherwise keep a
  // client that ignores it for 30 s. It counts as waiting until it's gone,
  // so refused sockets can't pile up past the cap.
  private refuseConn(conn: Conn): void {
    conn.authTimer?.clear();
    conn.ws.close(4401, 'unauthorized');
    setTimeout(() => conn.ws.terminate(), 1000).unref();
  }

  // What this server's proofs are bound to (docs/protocol/connection.md, "Auth"): the
  // kind of server and the port it listens on.
  private channel(): AuthChannel {
    const addr = this.http.address();
    return { server: this.opts.onlyOwn ? 'drain' : 'primary', port: typeof addr === 'object' && addr ? addr.port : this.opts.port };
  }

  private onConnection(ws: WebSocket, headerAuthed: boolean, peer?: PeerSocket): void {
    const conn: Conn = { id: this.nextId++, ws, authed: false, subs: new Set(), since: Date.now(), peer, queue: [] };
    this.conns.add(conn);
    if (headerAuthed) {
      this.unlock(conn);
    } else {
      // Awake time only, as in client.ts: a stalled runner mustn't drop
      // a client whose proof is already waiting in the socket.
      conn.authTimer = awakeTimeout(this.opts.authTimeoutMs ?? AUTH_TIMEOUT_MS, () => {
        if (!conn.authed) this.refuseConn(conn);
      });
      conn.challenge = newNonce();
      this.send(conn, { jsonrpc: '2.0', method: 'auth.challenge', params: { version: AUTH_VERSION, nonce: conn.challenge, port: this.channel().port } });
    }
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // The protocol is text only; before auth, anything else is refused.
        if (!conn.authed) this.refuseConn(conn);
        return;
      }
      this.onMessage(conn, data.toString());
    });
    ws.on('close', () => {
      conn.authTimer?.clear();
      conn.queue.length = 0;
      this.conns.delete(conn);
      // The app gone (quit, or reconnecting): the CLI it had started ahead
      // of a new thread isn't left running.
      if (conn.authed) this.opts.runner.dropSpare?.('app disconnected', conn.id);
      if (conn.authed && (conn.client === 'threadbear-mac' || conn.client === 'threadbear-desktop')) this.opts.appSeen?.();
    });
    // A protocol error (a frame over the limit, bad UTF-8): ws closes with
    // 1009 or 1002 and waits up to 30 s for the other side to answer. Cut it
    // off now; it stays counted (against the pending cap, if it hadn't
    // authenticated) until its 'close'.
    ws.on('error', () => {
      conn.authTimer?.clear();
      ws.terminate();
    });
  }

  private send(conn: Conn, obj: unknown): void {
    if (conn.ws.readyState === WebSocket.OPEN) this.write(conn, JSON.stringify(obj), false);
  }

  private write(conn: Conn, msg: string, skippable: boolean): void {
    const buffered = conn.ws.bufferedAmount;
    if (buffered > (this.opts.closeBytes ?? CLOSE_BYTES)) {
      this.opts.log.warn('client is not reading; closing it', {
        conn: conn.id, client: conn.client ?? 'no hello', version: conn.clientVersion, pid: conn.clientPid,
        subs: conn.subs.size, connectedSecs: Math.round((Date.now() - conn.since) / 1000), buffered,
      });
      conn.ws.close(4408, 'too far behind');
      this.conns.delete(conn);
      return;
    }
    if (skippable && buffered > (this.opts.skipDeltasBytes ?? SKIP_DELTAS_BYTES)) return;
    // No half emoji: the apps' JSON parsers refuse the message (well-formed-json.ts).
    conn.ws.send(wellFormedJson(msg));
  }

  private broadcast(n: Notification): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method: n.method, params: n.params });
    const transient = n.method === 'thread.event' && n.params.event.type.endsWith('.delta');
    for (const c of [...this.conns]) {
      // Not while the process lookup runs, nor after it refused (Gemini's
      // review of finding 175): it hasn't been placed yet.
      if (!c.authed || c.identifying || c.dropped || c.ws.readyState !== WebSocket.OPEN) continue;
      if (n.method === 'thread.event' && !c.subs.has(n.params.threadId)) continue;
      this.write(c, msg, transient);
    }
  }

  // The one message a connection may send before it has authenticated
  // (at most PREAUTH_MAX_PAYLOAD, so parsing it is cheap): auth.prove
  // answering this connection's challenge, or an old client's auth with
  // the token itself. Anything else closes it.
  private onAuthMessage(conn: Conn, raw: string): void {
    let msg: { id?: string | number | null; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.refuseConn(conn);
    }
    const id = msg && typeof msg === 'object' ? (msg.id ?? null) : null;
    const p = (msg && typeof msg === 'object' && msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
    if (msg?.method === 'auth.prove' && conn.challenge && isNonce(p.nonce) && p.nonce !== conn.challenge) {
      // A thread proves its own key instead of the token (docs/protocol/connection.md,
      // "A thread's own key"); an id that can't be one is simply no proof.
      const threadId = p.threadId === undefined ? undefined : isThreadId(p.threadId) ? p.threadId : null;
      const secret = threadId === null ? undefined : threadId ? threadKey(this.opts.token, threadId) : this.opts.token;
      if (secret && proofMatches(authProof(secret, 'client', conn.challenge, p.nonce, this.channel()), p.proof)) {
        const proof = authProof(secret, 'runner', conn.challenge, p.nonce, this.channel());
        this.unlock(conn, threadId ?? undefined);
        this.send(conn, { jsonrpc: '2.0', id, result: { proof } });
        return;
      }
    }
    if (msg?.method === 'auth' && this.tokenOk(p.token)) {
      this.unlock(conn);
      if (id !== null) this.send(conn, { jsonrpc: '2.0', id, result: {} });
      return;
    }
    this.refuseConn(conn);
  }

  private onMessage(conn: Conn, raw: string): void {
    if (conn.dropped) return;
    if (!conn.authed) return this.onAuthMessage(conn, raw);
    if (conn.identifying) {
      const bytes = (conn.queuedBytes ?? 0) + Buffer.byteLength(raw);
      if (conn.queue.length >= MAX_QUEUED_FRAMES || bytes > MAX_QUEUED_BYTES) {
        conn.dropped = true;
        conn.queue.length = 0;
        conn.ws.close(4408, 'too much sent before identification');
        setTimeout(() => conn.ws.terminate(), 1000).unref();
        return;
      }
      conn.queuedBytes = bytes;
      conn.queue.push(raw);
      return;
    }
    let msg: { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(conn, { jsonrpc: '2.0', id: null, error: { code: ErrorCode.parseError, message: 'Parse error' } });
    }
    const id = msg?.id ?? null;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
      return this.send(conn, { jsonrpc: '2.0', id, error: { code: ErrorCode.invalidRequest, message: 'Invalid request' } });
    }
    let result: unknown;
    let params: Record<string, unknown> | undefined;
    // take's copies of a limited thread's pictures (media-quota.ts) go once
    // the call is done with them, whichever way it ends.
    const releaseHeld = () => {
      if (conn.caller !== undefined && params?.images !== undefined) this.opts.gate?.releaseHeld(params.images);
    };
    try {
      params = this.gated(conn, msg.method, (msg.params ?? {}) as Record<string, unknown>);
      result = this.dispatch(conn, msg.method, params);
      if (result instanceof Promise) result = result.finally(releaseHeld);
      else releaseHeld();
    } catch (e) {
      releaseHeld();
      if (id === null) return;
      if (e instanceof RpcError) {
        return this.send(conn, { jsonrpc: '2.0', id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } });
      }
      this.opts.log.error('request failed', { method: msg.method, error: String(e) });
      return this.send(conn, { jsonrpc: '2.0', id, error: { code: ErrorCode.other, message: (e as Error)?.message ?? String(e) } });
    }
    // A handler that has to wait (panels.render takes a screenshot) returns
    // a promise; everything else answers in this tick.
    if (result instanceof Promise) {
      result.then(
        (value) => {
          if (id !== null) this.send(conn, { jsonrpc: '2.0', id, result: value });
        },
        (e) => {
          if (id === null) return;
          if (e instanceof RpcError) {
            this.send(conn, { jsonrpc: '2.0', id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } });
          } else {
            this.opts.log.error('request failed', { method: msg.method, error: String(e) });
            this.send(conn, { jsonrpc: '2.0', id, error: { code: ErrorCode.other, message: (e as Error)?.message ?? String(e) } });
          }
        },
      );
      return;
    }
    if (id !== null) this.send(conn, { jsonrpc: '2.0', id, result });
    // Things the app should know about that happened before it connected
    // (a missing claude binary, CLIs stopped at startup).
    if (msg.method === 'hello') {
      for (const n of [...this.opts.runner.noticesForNewClient(), ...(this.opts.helloNotices?.() ?? [])]) {
        this.send(conn, { jsonrpc: '2.0', method: 'runner.notice', params: n });
      }
    }
  }

  // A request about a draining runner's thread, passed to it. Its answer
  // comes back unchanged. A subscribe starts this client's live stream in
  // the same tick its backlog arrives: events the draining runner sent
  // before the backlog are in it, and those after come through here. If it
  // has just handed the thread over (-32030), this runner has it by then,
  // and handles the request itself.
  private forward(conn: Conn, method: string, p: Record<string, unknown>, threadId: string): Promise<unknown> {
    return this.opts.remote!.call(threadId, method, p).then(
      (res) => {
        if (method === 'threads.subscribe') conn.subs.add(threadId);
        return res;
      },
      (e) => {
        if (isMoved(e) && this.opts.runner.has(threadId)) return this.dispatch(conn, method, p);
        throw e;
      },
    );
  }

  // Throws a refusal if a thread's connection can't call this. Before
  // dispatch, so a request forwarded to a draining or another runner is
  // covered too. A server with no gate (a draining runner's own, which only
  // a primary with the token talks to) refuses a thread outright.
  private gated(conn: Conn, method: string, p: Record<string, unknown>): Record<string, unknown> {
    if (conn.caller === undefined) {
      if (conn.owner) {
        const mutation = method === 'threads.update' || method === 'threads.interrupt' || (method === 'drain.projects' && p.op === 'changeMembership');
        if (mutation) {
          const drain = conn.drainLink || conn.ownerPids?.some((pid) => this.opts.isDrainingPid?.(pid));
          if (drain) conn.drainLink = true;
          if (drain && !conn.drainMutationGuard) throw new RpcError(ErrorCode.notAllowed, 'This older runner cannot change or stop other threads safely. Wait for its turn to finish and move to the new runner.');
        }
        return p;
      }
      // Not a thread and not known to be the owner: the lookup never said
      // (unlock closes such a connection; this is the backstop).
      throw new RpcError(ErrorCode.notAllowed, "The runner couldn't tell which process this connection is from.");
    }
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('params must be an object');
    if (!this.opts.gate) throw new RpcError(ErrorCode.notAllowed, "This server doesn't take calls from threads.");
    return this.opts.gate.check(conn.caller, method, p);
  }

  /** Throws unless a request about `tid` reaches the runner the client
   * shows it on, `shown` (null for this Mac's own; undefined when it
   * doesn't say). */
  private mustReachShown(tid: string, shown: unknown): void {
    if (shown === undefined) {
      // An older client (or tb) doesn't say. It can't have been shown where
      // a moving thread is, as the apps before this took a move as arrived
      // the moment its old runner let it go: while one is under way, a
      // relayed message waits until the move is done (Codex's review).
      const r = this.opts.runner;
      if (!r.has(tid) && this.opts.remote?.owns(tid) !== true && this.opts.relay?.owns(tid) && this.opts.relayMoving?.(tid)) {
        throw new RpcError(ErrorCode.notShownThere, "That thread is moving to another runner, so this wasn't sent. Send it again once it's there.");
      }
      return;
    }
    if (shown !== null && (typeof shown !== 'string' || !shown)) throw bad('runnerId must be a runner id or null');
    // A new release taking over this Mac's threads (a handover) is still this Mac.
    const here = this.opts.runner.has(tid) || this.opts.remote?.owns(tid) === true;
    const relay = this.opts.relay;
    const reaches = here ? null : relay?.owns(tid) ? relay.ownerOf?.(tid) ?? '' : undefined;
    // Nowhere at all: it fails as it would have anyway.
    if (reaches === undefined) return;
    if (reaches !== shown) {
      throw new RpcError(ErrorCode.notShownThere, shown === null
        ? "That thread isn't on this Mac yet, so this wasn't sent. It's still on the runner it's moving from."
        : "That thread isn't on the runner it shows, so this wasn't sent. Look again once its move has settled.");
    }
  }

  private mustClis(method: string): CliControl {
    if (!this.opts.clis) throw new RpcError(ErrorCode.methodNotFound, `Unknown method ${method}`);
    return this.opts.clis;
  }

  // Every handler is synchronous, so a subscribe's replay and the start of
  // its live stream happen in the same tick and nothing can slip between.
  private dispatch(conn: Conn, method: string, p: Record<string, unknown>): unknown {
    const r = this.opts.runner;
    // A local tool needs to know whether its handoff can reach the Mac app.
    // Check on the primary, before forwarding to the runner owning the thread.
    if (method === 'threads.showPanel' && !this.opts.onlyOwn) {
      const browser = ['browser', 'threadbear.browser'].includes(String(p.panel).trim().toLowerCase());
      if (!this.appConnected(browser)) return { available: false };
    }
    const tid = typeof p.threadId === 'string' ? p.threadId : undefined;
    // The app says which runner it shows the thread on; a message or an
    // edit that would reach another is refused rather than passed on
    // (Daybreak 113). Only here on the primary: a draining runner answers
    // -32030 for one it let go, which the primary acts on.
    if (tid !== undefined && SHOWN_ON_METHODS.has(method) && !this.opts.onlyOwn) this.mustReachShown(tid, p.runnerId);
    if (tid !== undefined && THREAD_METHODS.has(method) && !r.has(tid)) {
      if (this.opts.remote?.owns(tid)) return this.forward(conn, method, p, tid);
      if (this.opts.onlyOwn) throw new RpcError(ErrorCode.moved, 'This runner has handed that thread over to the new one.');
      if (this.opts.relay?.owns(tid)) {
        return this.opts.relay.call(tid, method, p).then((res) => {
          if (method === 'threads.subscribe') conn.subs.add(tid);
          return res;
        });
      }
    }
    switch (method) {
      case 'auth':
        return {};
      case 'auth.whoami':
        return conn.caller !== undefined && this.opts.gate ? this.opts.gate.whoami(conn.caller) : {};
      case 'hello': {
        // A thread's connection isn't the Mac app, whatever it says: presence
        // and "the app is on this build" go by what it claims here.
        conn.client = conn.caller === undefined ? optString(p, 'client') : 'thread';
        conn.clientVersion = typeof p.version === 'string' ? p.version : undefined;
        conn.clientPid = typeof p.pid === 'number' ? p.pid : undefined;
        // Only the authenticated owner link may advertise this, never a
        // thread key or a target's mirrored metadata. Old MCP handlers
        // lack the internal cards, so their mutations stay closed here.
        if (!conn.drainHelloSeen) {
          conn.drainHelloSeen = true;
          conn.drainLink = conn.owner === true && (conn.client === 'threadbear-drain' || Boolean(conn.ownerPids?.some((pid) => this.opts.isDrainingPid?.(pid))));
          conn.drainMutationGuard = conn.owner === true && conn.client === 'threadbear-drain' && p.threadMutationGuard === 1;
        }
        conn.browserPanel = conn.caller === undefined && p.browserPanel === true;
        // Only the Mac apps' own builds, the Swift app's and the GPUI app's,
        // each followed on its own: a dev build has none.
        const build = p.build as Record<string, unknown> | undefined;
        const app = conn.client === 'threadbear-mac' ? 'mac' : conn.client === 'threadbear-desktop' ? 'desktop' : undefined;
        if (app && build && typeof build === 'object'
          && typeof build.commit === 'string' && typeof build.short === 'string' && typeof build.tree === 'string' && build.tree) {
          this.opts.appHello?.({ commit: build.commit, short: build.short, tree: build.tree }, app);
        }
        if (app === 'desktop') this.opts.desktopHello?.();
        if (app) this.opts.appSeen?.();
        const updates = this.opts.updates?.();
        // The experiments on here, for the app to show what's theirs (the
        // Move to menu). Read at each hello: a switch takes effect on the
        // app's next connect.
        const experiments = EXPERIMENTS.filter((x) => experimentOn(r.cfg.home, x.id)).map((x) => x.id);
        return { ...r.hello(), ...(updates ? { updates } : {}), experiments };
      }
      case 'threads.list': {
        // A bucket this runner doesn't know is left out, not refused: a
        // newer app's new one would otherwise fail its whole thread list
        // here (docs/protocol.md, both sides tolerate unknown values).
        const include = p.include === undefined ? undefined : stringArray(p, 'include').filter((x) => x === 'inbox' || x === 'snoozed' || x === 'archived');
        const ids = p.ids === undefined ? undefined : stringArray(p, 'ids');
        const local = r.list(include as Bucket[] | undefined, ids);
        const only = ids && new Set(ids);
        const remote = this.opts.remote?.summaries((include as Bucket[] | undefined) ?? ['inbox']).filter((t) => !only || only.has(t.id));
        return { threads: remote?.length ? mergeSummaries(local, remote) : local };
      }
      case 'threads.search': {
        const query = reqString(p, 'query');
        const limit = optInt(p, 'limit');
        const local = r.search(query, limit);
        const remote = this.opts.remote;
        if (!remote) return { threads: local };
        return remote.search(query, limit ?? 50).then((more) => ({ threads: mergeSummaries(local, more).slice(0, limit ?? 50) }));
      }
      case 'threads.create': {
        // On a virtual runner (docs/protocol/keys.md, Virtual runners, "Starting from the Mac").
        if (p.serviceId !== undefined) {
          if (typeof p.serviceId !== 'string' || !p.serviceId) throw bad('serviceId must be a virtual runner\'s id');
          if (!this.opts.virtualStart) throw bad("This runner can't start threads on a virtual runner.");
          return this.opts.virtualStart(p);
        }
        // On another runner (docs/protocol/runners.md, "Other runners' threads through the backend").
        if (typeof p.runnerId === 'string' && this.opts.relay) {
          return this.opts.relay.create(p.runnerId, p).then((res) => {
            // Never one of this runner's own: its requests would come here.
            const id = (res as { thread?: { id?: unknown } }).thread?.id;
            if (typeof id === 'string' && r.has(id)) throw new RpcError(ErrorCode.other, "The other runner named one of this Mac's threads as the new one.");
            return res;
          });
        }
        if (p.worktree !== undefined && typeof p.worktree !== 'boolean') throw bad('worktree must be a boolean');
        // An older runner handing over passes on a sandboxed agent's
        // create_thread this way: there's no sandbox to start it in now
        // (taken out 16 Nov 2026), and it mustn't start outside one.
        if (p.confined === true) throw bad("This asks for a thread shut in a sandbox, which Threadbear no longer has, so it wasn't started.");
        return r.createAfterModelProbe({
          text: optString(p, 'text') ?? '',
          images: optImages(p),
          cwd: optString(p, 'cwd'),
          accountId: optString(p, 'accountId'),
          poolId: optString(p, 'poolId'),
          ...optPoolProvider(p),
          model: optString(p, 'model'),
          effort: optEffort(p),
          permissionMode: optMode(p),
          title: optString(p, 'title'),
          ...(p.worktree === false ? { worktree: false } : {}),
          ...optStartedBy(p),
          // Not to nest under the thread in startedBy (Nested threads).
          ...(p.detached === true ? { detached: true } : {}),
          ...optProjectIds(p),
          // A CLI this connection had started ahead of it (threads.warm).
          ...(typeof p.warmId === 'string' ? { warmId: p.warmId } : {}),
        });
      }
      // A CLI started ahead of the new thread the app is writing
      // (docs/protocol/connection.md, "Warm start"; runner/warm-start.ts).
      case 'threads.warm': {
        if (p.cancel === true) {
          r.dropSpare('page left', conn.id);
          return {};
        }
        return r.warm({
          cwd: optString(p, 'cwd'),
          accountId: optString(p, 'accountId'),
          poolId: optString(p, 'poolId'),
          ...optPoolProvider(p),
          model: optString(p, 'model'),
          effort: optEffort(p),
          permissionMode: optMode(p),
          ...(p.worktree === false ? { worktree: false } : {}),
          ...optProjectIds(p),
        }, conn.id);
      }
      case 'threads.samples':
        return r.samples({ cwd: reqString(p, 'cwd'), remove: p.remove === true });
      case 'reviews.list':
        return r.listReviews(reqString(p, 'threadId'));
      case 'reviews.create':
        return r.createReview(reqString(p, 'threadId'), p as Parameters<Runner['createReview']>[1]);
      case 'reviews.get':
        return r.getReview(reqString(p, 'threadId'), reqString(p, 'reviewId'));
      case 'reviews.save':
        return r.saveReview(reqString(p, 'threadId'), reqString(p, 'reviewId'), p.revision as number, p.draft as Parameters<Runner['saveReview']>[3]);
      case 'reviews.respond':
        return r.respondReview(reqString(p, 'threadId'), reqString(p, 'reviewId'), p.revision as number, p.draft as Parameters<Runner['respondReview']>[3]);
      case 'reviews.cancel':
        return r.cancelReview(reqString(p, 'threadId'), reqString(p, 'reviewId'), p.revision as number);
      case 'buttons.list':
        return r.listButtons(reqString(p, 'threadId'));
      case 'buttons.press':
        return r.pressButton(reqString(p, 'threadId'), reqString(p, 'buttonId'));
      case 'threads.send':
        // `ceiling`: set by the RPC gate for a thread's own key (runner/ceiling.ts).
        return r.send(reqString(p, 'threadId'), optString(p, 'text') ?? '', optImages(p) ?? [], { ...optAnswers(p), ...optSendOrigin(p), ...(isPermissionMode(p.ceiling) ? { ceiling: p.ceiling } : {}) });
      case 'threads.edit':
        return r.editMessage(reqString(p, 'threadId'), reqNumber(p, 'seq'), optString(p, 'text') ?? '', optImages(p) ?? [], { stopBackground: p.stopBackground === true });
      case 'threads.interrupt':
        // Sent on for an agent's interrupt_thread (handover.ts), it isn't his Stop.
        return r.interrupt(reqString(p, 'threadId'), { byMike: p.byAgent !== true, ...(p.controlCeiling !== undefined ? { controlCeiling: isPermissionMode(p.controlCeiling) ? p.controlCeiling : 'ask' } : {}) });
      case 'threads.update': {
        const upd: Parameters<Runner['update']>[0] = { threadId: reqString(p, 'threadId') };
        if (p.controlCeiling !== undefined) upd.controlCeiling = isPermissionMode(p.controlCeiling) ? p.controlCeiling : 'ask';
        if (p.title !== undefined) upd.title = reqString(p, 'title');
        if (p.titleBy !== undefined) {
          if (p.titleBy !== 'mike' && p.titleBy !== 'agent') throw bad('titleBy must be "mike" or "agent"');
          upd.titleBy = p.titleBy;
        }
        if (p.cwd !== undefined) upd.cwd = reqString(p, 'cwd');
        if (p.accountId !== undefined) upd.accountId = reqString(p, 'accountId');
        if (p.poolId !== undefined) upd.poolId = p.poolId === null ? null : reqString(p, 'poolId');
        // Passed on from a thread's key (rpc-gate) or a draining runner. An
        // older one says an agent's move as `unconfine: false` (the sandbox
        // experiment's, taken out 16 Nov 2026), which still counts.
        if (p.byAgent === true || p.unconfine === false) upd.byAgent = true;
        if (p.provider !== undefined && p.poolId !== undefined) {
          if (!isProvider(p.provider)) throw bad(`provider must be one of ${PROVIDERS.join(', ')}`);
          upd.provider = p.provider as Provider;
        }
        if (p.model !== undefined) upd.model = p.model === null ? null : reqString(p, 'model');
        if (p.effort !== undefined) upd.effort = p.effort === null ? null : optEffort(p);
        if (p.permissionMode !== undefined) upd.permissionMode = optMode(p);
        if (p.snoozedUntil !== undefined) upd.snoozedUntil = p.snoozedUntil === null ? null : reqString(p, 'snoozedUntil');
        if (p.archived !== undefined) {
          if (typeof p.archived !== 'boolean') throw bad('archived must be a boolean');
          upd.archived = p.archived;
        }
        if (p.archivedBy !== undefined) {
          if (p.archivedBy !== 'mike' && p.archivedBy !== 'agent' && p.archivedBy !== 'threadbear') throw bad('archivedBy must be "mike", "agent" or "threadbear"');
          upd.archivedBy = p.archivedBy;
        }
        if (p.verdict !== undefined) {
          // An unarchive takes its own: "Should have shown me" (quietInboxMine).
          if (p.archived === false) {
            if (!UNARCHIVE_VERDICTS.includes(p.verdict as UnarchiveVerdict)) throw bad(`with archived: false, verdict must be one of ${UNARCHIVE_VERDICTS.join(', ')}`);
            upd.verdict = p.verdict as UnarchiveVerdict;
          } else {
            if (!ARCHIVE_VERDICTS.includes(p.verdict as ArchiveVerdict)) throw bad(`verdict must be one of ${ARCHIVE_VERDICTS.join(', ')}`);
            if (p.archived !== true) throw bad('verdict goes with archived: true or false');
            upd.verdict = p.verdict as ArchiveVerdict;
          }
        }
        if (p.starred !== undefined) {
          if (typeof p.starred !== 'boolean') throw bad('starred must be a boolean');
          upd.starred = p.starred;
        }
        if (p.detached !== undefined) {
          if (typeof p.detached !== 'boolean') throw bad('detached must be a boolean');
          upd.detached = p.detached;
        }
        if (p.carryOnAtReset !== undefined) {
          if (typeof p.carryOnAtReset !== 'boolean') throw bad('carryOnAtReset must be a boolean');
          upd.carryOnAtReset = p.carryOnAtReset;
        }
        if (p.carryOn !== undefined) {
          if (typeof p.carryOn !== 'boolean') throw bad('carryOn must be a boolean');
          upd.carryOn = p.carryOn;
        }
        return r.update(upd);
      }
      case 'threads.retitle': {
        if (p.dryRun !== undefined && typeof p.dryRun !== 'boolean') throw bad('dryRun must be a boolean');
        const threadIds = p.threadIds === undefined ? undefined : stringArray(p, 'threadIds');
        return r.retitle({ dryRun: p.dryRun === true, threadIds });
      }
      case 'threads.delete':
        return r.delete(reqString(p, 'threadId'));
      case 'threads.events':
        return r.events(reqString(p, 'threadId'), {
          afterSeq: optInt(p, 'afterSeq'),
          beforeSeq: optInt(p, 'beforeSeq'),
          limit: optInt(p, 'limit'),
        });
      case 'threads.subagent':
        return r.subagent(reqString(p, 'threadId'), reqString(p, 'subagentId'));
      case 'threads.subscribe': {
        const threadId = reqString(p, 'threadId');
        const backlog = r.backlog(threadId, optInt(p, 'afterSeq') ?? 0);
        conn.subs.add(threadId);
        // Opened: the done card's loose ends may have moved since (a land
        // from a terminal, another thread's turn).
        r.recheckLooseEnds(r.threads.get(threadId), true);
        return backlog;
      }
      case 'threads.unsubscribe':
        conn.subs.delete(reqString(p, 'threadId'));
        return {};
      case 'threads.markSeen':
        return r.markSeen(reqString(p, 'threadId'), reqNumber(p, 'seq'));
      case 'threads.highlights':
        return r.highlights(reqString(p, 'threadId'));
      case 'threads.explain': {
        const selection = reqString(p, 'selection');
        if (!selection.trim()) throw bad('selection is empty');
        const question = p.question === undefined ? undefined : reqString(p, 'question');
        let earlier: { question?: string; answer: string }[] | undefined;
        if (p.earlier !== undefined) {
          if (!Array.isArray(p.earlier)) throw bad('earlier must be an array');
          earlier = p.earlier.map((t: any) => {
            if (!t || typeof t.answer !== 'string' || (t.question !== undefined && typeof t.question !== 'string')) throw bad('earlier: each is { question?, answer }');
            return { question: t.question, answer: t.answer };
          });
        }
        return r.explain({ threadId: reqString(p, 'threadId'), selection, message: p.message === undefined ? undefined : reqString(p, 'message'), question, earlier });
      }
      case 'threads.commands':
        return r.threadCommands(reqString(p, 'threadId'));
      case 'threads.contextUsage':
        return r.contextUsage(reqString(p, 'threadId'));
      case 'folders.commands':
        return r.folderCommands({
          cwd: p.cwd === undefined ? undefined : reqString(p, 'cwd'),
          accountId: p.accountId === undefined ? undefined : reqString(p, 'accountId'),
          permissionMode: optMode(p),
        });
      case 'threads.hibernateWhen':
        return r.hibernateWhen({ threadId: reqString(p, 'threadId'), said: reqString(p, 'said') });
      case 'threads.removeHighlight':
        return r.removeHighlight(reqString(p, 'threadId'), reqString(p, 'highlightId'));
      case 'threads.panelShown':
        return r.panelShown(reqString(p, 'threadId'), reqString(p, 'requestId'));
      case 'threads.showPanel':
        return r.showPanel(reqString(p, 'threadId'), { panel: reqString(p, 'panel'), ...(p.reload === true ? { reload: true } : {}) }).then(result => ({ available: true, ...result }));
      case 'threads.share': {
        const access = reqString(p, 'access');
        if (access !== 'off' && access !== 'link') throw bad('access is "off" or "link"');
        if (p.newLink !== undefined && typeof p.newLink !== 'boolean') throw bad('newLink must be a boolean');
        return r.share(reqString(p, 'threadId'), { access: access as ShareAccess, ...(p.newLink ? { newLink: true } : {}) });
      }
      case 'threads.tickAsk':
        if (typeof p.ticked !== 'boolean') throw bad('ticked must be a boolean');
        return r.tickAsk(reqString(p, 'threadId'), reqNumber(p, 'asksSeq'), reqNumber(p, 'index'), p.ticked);
      case 'approvals.respond': {
        const decision = reqString(p, 'decision') as ApprovalDecision;
        if (!['allow', 'allowAlways', 'deny', 'answered'].includes(decision)) throw bad('bad decision');
        let answers: Record<string, string> | undefined;
        if (p.answers !== undefined) {
          if (!p.answers || typeof p.answers !== 'object' || Array.isArray(p.answers)) throw bad('answers must be an object');
          answers = {};
          for (const [k, v] of Object.entries(p.answers)) {
            answers[k] = Array.isArray(v) ? v.map(String).join(', ') : String(v);
          }
        }
        // Answers to the calls queued on the card (docs/protocol/threads.md, "Queued calls").
        let queued: Record<string, 'allow' | 'deny'> | undefined;
        if (p.queued !== undefined) {
          if (!p.queued || typeof p.queued !== 'object' || Array.isArray(p.queued)) throw bad('queued must be an object');
          queued = {};
          for (const [k, v] of Object.entries(p.queued)) {
            if (v !== 'allow' && v !== 'deny') throw bad('each queued answer is "allow" or "deny"');
            queued[k] = v;
          }
        }
        return r.respondApproval({
          threadId: reqString(p, 'threadId'),
          approvalId: reqString(p, 'approvalId'),
          decision,
          message: optString(p, 'message'),
          answers,
          ...(queued ? { queued } : {}),
          // A draining runner passing on the phone's answer (handover.ts):
          // it only ever narrows what counts, so any client may say it.
          ...(p.remote === true ? { remote: true } : {}),
        });
      }
      case 'plans.approve':
        return r.approvePlan({ threadId: reqString(p, 'threadId'), itemId: reqString(p, 'itemId') });
      case 'secrets.answer': {
        // docs/protocol/threads.md, "Secrets". Nothing here logs params, and the
        // errors below never quote them.
        const decline = p.decline === true;
        if (!decline && typeof p.secret !== 'string') throw bad('secret or decline is required');
        return r.answerSecret({
          threadId: reqString(p, 'threadId'),
          approvalId: reqString(p, 'approvalId'),
          ...(decline ? { decline: true } : { secret: p.secret as string }),
        });
      }
      case 'pools.list':
        return r.listPools();
      case 'pools.save':
        return r.savePools(p.pools);
      case 'media.import':
        // A thread's key gets the background import, metered below Full
        // (Daybreak finding 157); one whose client has gone by the time it's
        // done is removed at once.
        if (conn.caller === undefined) return r.importMedia(reqString(p, 'path'));
        return r.importMediaForThread(conn.caller, reqString(p, 'path'), this.opts.gate?.whoami(conn.caller).limited ?? true).then((res) => {
          if (conn.ws.readyState !== WebSocket.OPEN) {
            r.importQuota.discard(res.image);
            throw new RpcError(ErrorCode.other, 'the client went away');
          }
          return res;
        });
      case 'panels.render':
        return r.renderPanel(reqString(p, 'threadId'), reqString(p, 'panelId'));
      case 'panels.toggle':
        if (typeof p.on !== 'boolean') throw bad('on must be true or false');
        return r.togglePanel(reqString(p, 'threadId'), reqString(p, 'panelId'), reqString(p, 'toggleId'), p.on);
      case 'panels.convexKey':
        return r.convexPanelKey(reqString(p, 'threadId'), reqString(p, 'panelId'), p.renew === true, optString(p, 'deployment'));
      case 'panels.convexLogin':
        return r.convexPanelLogin(reqString(p, 'threadId'), reqString(p, 'panelId'), p.check === true, p.force === true);
      case 'panels.convexDeployments':
        return r.convexPanelDeployments(reqString(p, 'threadId'), reqString(p, 'panelId'), p.refresh === true);
      case 'patches.trust': {
        if (!Array.isArray(p.files) || !p.files.length) throw bad('files must be a non-empty array');
        const files = p.files.map((f: unknown) => {
          const o = f as { file?: unknown; hash?: unknown };
          if (!o || typeof o.file !== 'string' || typeof o.hash !== 'string') throw bad('each file needs file and hash');
          return { file: o.file, hash: o.hash };
        });
        return r.trustPatches(reqString(p, 'threadId'), files);
      }
      case 'actions.run':
        return r.runAction(reqString(p, 'threadId'), reqString(p, 'actionId'));
      // Mike's click on the limit box, a Usage row or a login list; never a
      // thread's (rpc-gate refuses it). With another runner's runnerId, the
      // same subscription here if this runner has it, else through Convex.
      case 'accounts.useReset': {
        const other = optString(p, 'runnerId');
        return other ? this.useResetElsewhere(other, reqString(p, 'accountId')) : r.useReset(reqString(p, 'accountId'));
      }
      // The Usage panel's Find work for it; never a thread's (rpc-gate).
      case 'accounts.findWork':
        return r.findWork(reqString(p, 'accountId'));
      // The app's, after its Sign in… (never a thread's: the gate refuses it).
      case 'accounts.recheck':
        return r.recheckAccounts(optString(p, 'accountId'));
      // Year-long token… for a login on this runner or, with runnerId,
      // another's through Convex (year-token-maker.ts). The app's, never a
      // thread's (the gate refuses it): it changes what a login runs as.
      case 'accounts.yearToken': {
        const accountId = reqString(p, 'accountId');
        const step = yearTokenParams(p);
        // runnerId only for another runner's login, as for threads.create.
        const other = optString(p, 'runnerId');
        if (other) {
          if (!this.opts.relay?.yearToken) throw new RpcError(ErrorCode.other, "This Mac's runner can't reach other runners through Convex.");
          return this.opts.relay.yearToken(other, { accountId, ...step });
        }
        return r.yearToken(accountId, step);
      }
      // A GitHub PR for the app's PR tab (github-pr.ts). Mike's clicks only:
      // not in rpc-gate's reads, so a thread's key can't merge or comment.
      case 'github.pr':
        return ghCall(() => fetchPr(reqPrRef(p), undefined, { files: p.files !== false }));
      case 'github.prFiles':
        return ghCall(() => fetchPrFiles(reqPrRef(p)));
      case 'github.prStates': {
        if (!Array.isArray(p.urls) || p.urls.some((u) => typeof u !== 'string')) throw bad('urls must be an array of strings');
        return ghCall(async () => ({ states: await prStates(p.urls as string[]) }));
      }
      // What decides whether each of a thread's PRs can merge, for
      // Highlights' Pull requests.
      case 'github.prStatus': {
        if (!Array.isArray(p.urls) || p.urls.some((u) => typeof u !== 'string')) throw bad('urls must be an array of strings');
        return ghCall(async () => ({ prs: await prStatus(p.urls as string[]) }));
      }
      // A PR's auto-fix wand (runner/pr-watch.ts).
      case 'prWatch.set': {
        if (!Array.isArray(p.urls) || p.urls.some((u) => typeof u !== 'string')) throw bad('urls must be an array of strings');
        if (typeof p.on !== 'boolean') throw bad('on must be true or false');
        return r.setPrWatch(reqString(p, 'threadId'), p.urls as string[], p.on);
      }
      case 'prWatch.list':
        return r.listPrWatch();
      case 'github.prAct': {
        const ref = reqPrRef(p);
        const action = { action: reqString(p, 'action'), method: optString(p, 'method'), body: optString(p, 'body') } as PrAction;
        return ghCall(async () => {
          try {
            await prAct(ref, action);
          } finally {
            forgetStates(ref);
          }
          return {};
        });
      }
      // Each starts its work and answers at once; progress comes through
      // clis.updated.
      case 'clis.list':
        return { clis: this.mustClis(method).list() };
      case 'clis.check': {
        const provider = p.provider === undefined || p.provider === null ? undefined : reqProvider(p);
        return { clis: this.mustClis(method).check(provider) };
      }
      case 'clis.update': {
        const provider = reqProvider(p);
        const o: { version?: string; force?: boolean } = {};
        const version = optString(p, 'version');
        if (version !== undefined) {
          if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw bad('version must be a version number like 0.164.0');
          o.version = version;
        }
        if (p.force !== undefined && p.force !== null) {
          if (typeof p.force !== 'boolean') throw bad('force must be a boolean');
          if (p.force) o.force = true;
        }
        return { clis: this.mustClis(method).update(provider, o) };
      }
      case 'clis.setPolicy': {
        const provider = reqProvider(p);
        const policy = p.policy;
        if (typeof policy !== 'string' || !(CLI_POLICIES as readonly string[]).includes(policy)) throw bad(`policy must be one of ${CLI_POLICIES.join(', ')}`);
        return { clis: this.mustClis(method).setPolicy(provider, policy as CliPolicy) };
      }
      default: {
        // hasOwn, so "constructor" and friends aren't methods.
        // A folder on another runner, for the folder browser on one of its threads.
        if (method === 'files.list' && typeof p.runnerId === 'string' && this.opts.relay) return this.opts.relay.listFolder(p.runnerId, reqString(p, 'path'));
        if (method === 'files.read' && typeof p.runnerId === 'string') {
          // Only a picture pasted into one of its messages that the relay holds.
          if (this.opts.relay?.readFile) return this.opts.relay.readFile(p.runnerId, reqString(p, 'path'), typeof p.maxBytes === 'number' ? p.maxBytes : undefined);
          throw new RpcError(ErrorCode.other, 'Files on another runner are kept there for now.');
        }
        if (method === 'remoteThreads.logins') {
          if (!this.opts.relay) throw new RpcError(ErrorCode.other, "This Mac's runner can't reach other runners through Convex.");
          return this.opts.relay.logins(reqString(p, 'runnerId'));
        }
        const methods = this.opts.methods;
        if (methods && Object.hasOwn(methods, method)) return methods[method](p);
        throw new RpcError(ErrorCode.methodNotFound, `Unknown method ${method}`);
      }
    }
  }
}

function reqProvider(p: Record<string, unknown>): Provider {
  if (!isProvider(p.provider)) throw bad(`provider must be one of ${PROVIDERS.join(', ')}`);
  return p.provider;
}

function reqPrRef(p: Record<string, unknown>): PrRef {
  const ref = parsePrUrl(reqString(p, 'url'));
  if (!ref) throw bad('url must be a github.com pull request link');
  return ref;
}

// gh's own words come back as the error (not signed in, not mergeable, ...).
async function ghCall<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new RpcError(ErrorCode.other, (e as Error).message || 'gh failed');
  }
}

function bad(message: string): RpcError {
  return new RpcError(ErrorCode.badParams, message);
}

function reqString(p: Record<string, unknown>, k: string): string {
  const v = p[k];
  if (typeof v !== 'string') throw bad(`${k} must be a string`);
  return v;
}

// accounts.yearToken's step: a code, a check, a cancel, or none (a start).
function yearTokenParams(p: Record<string, unknown>): YearTokenParams {
  if (p.code !== undefined && typeof p.code !== 'string') throw new RpcError(ErrorCode.badParams, 'code must be a string');
  if (typeof p.code === 'string' && p.code.length > 1100) throw new RpcError(ErrorCode.badParams, 'code is too long');
  return {
    ...(typeof p.code === 'string' ? { code: p.code } : {}),
    ...(p.check === true ? { check: true } : {}),
    ...(p.cancel === true ? { cancel: true } : {}),
  };
}

function optString(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw bad(`${k} must be a string`);
  return v;
}

function reqNumber(p: Record<string, unknown>, k: string): number {
  const v = p[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${k} must be a number`);
  return v;
}

function optNumber(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${k} must be a number`);
  return v;
}

// Seqs and limits index the event log, so they must be whole numbers.
function optInt(p: Record<string, unknown>, k: string): number | undefined {
  const v = optNumber(p, k);
  if (v !== undefined && !Number.isInteger(v)) throw bad(`${k} must be a whole number`);
  return v;
}

function stringArray(p: Record<string, unknown>, k: string): string[] {
  const v = p[k];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad(`${k} must be an array of strings`);
  return v as string[];
}

// Who started a new thread (docs/protocol/threads.md, "Who started a thread"). It's
// shown on Mike's row, so it's cut to what a row can hold, on one line.
const STARTED_BY_KINDS = new Set(['tool', 'thread', 'schedule', 'librarian', 'runner']);
function optStartedBy(p: Record<string, unknown>): { startedBy?: ThreadStartedBy } {
  const v = p.startedBy;
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object') throw bad('startedBy must be an object');
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== 'string') throw bad('startedBy.kind must be a string');
  // A kind from a newer caller: the thread starts with no byline rather
  // than not at all, as it's only what Mike's row says.
  if (!STARTED_BY_KINDS.has(o.kind)) return {};
  const words = (x: unknown, max: number) => (typeof x === 'string' ? cutSafely(x.replace(/\s+/g, ' ').trim(), max) : '');
  const label = words(o.label, 40);
  if (!label) throw bad('startedBy.label required');
  const icon = words(o.icon, 60);
  const why = words(o.why, MAX_BYLINE);
  const threadId = words(o.threadId, 60);
  return { startedBy: { kind: o.kind as ThreadStartedBy['kind'], label, ...(icon ? { icon } : {}), ...(threadId ? { threadId } : {}), ...(why ? { why } : {}) } };
}

function optMode(p: Record<string, unknown>): PermissionMode | undefined {
  const v = p.permissionMode;
  if (v === undefined || v === null) return undefined;
  if (v !== 'full' && v !== 'ask' && v !== 'auto' && v !== 'plan') throw bad('permissionMode must be "full", "ask", "auto" or "plan"');
  return v;
}


// threads.create's provider: with a poolId, which of a mixed pool's
// providers the model picker's pick was under, as a model id alone can be
// claimed by several (an OpenCode model called gpt-…).
function optPoolProvider(p: Record<string, unknown>): { provider?: Provider } {
  if (p.provider === undefined || p.poolId === undefined) return {};
  if (!isProvider(p.provider)) throw bad(`provider must be one of ${PROVIDERS.join(', ')}`);
  return { provider: p.provider as Provider };
}
function optEffort(p: Record<string, unknown>): EffortLevel | undefined {
  const v = p.effort;
  if (v === undefined || v === null) return undefined;
  if (!isEffortLevel(v)) throw bad(`effort must be one of ${EFFORT_LEVELS.join(', ')}`);
  return v;
}

// Only two say where they came from (docs/protocol/connection.md,
// threads.send): a phone command the primary passed on to a draining
// runner, and one of the runner's own tools run by the owner (tb
// red-watch's CI news), which is its note, with a few words of why.
// A thread's key can say neither (rpc-gate.ts drops them).
function optSendOrigin(p: Record<string, unknown>): { origin?: 'phone' | 'runner'; wakeReason?: string } {
  if (p.wakeReason !== undefined && p.origin !== 'runner') throw bad('wakeReason goes only with origin "runner"');
  if (p.origin === undefined) return {};
  if (p.origin === 'phone') return { origin: 'phone' };
  if (p.origin !== 'runner') throw bad('origin can only be "phone" or "runner"');
  const why = optString(p, 'wakeReason')?.trim();
  return { origin: 'runner', ...(why ? { wakeReason: why } : {}) };
}

// threads.send's answers (Needs you, Answering): short, and only for the
// app to show, so anything malformed is refused rather than half kept.
function optAnswers(p: Record<string, unknown>): { answers?: AskAnswer[] } {
  const v = p.answers;
  if (v === undefined || v === null) return {};
  if (!Array.isArray(v) || v.length > 10) throw bad('answers must be an array of at most 10');
  const answers = v.map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    if (typeof r.action !== 'string' || typeof r.answer !== 'string') throw bad('each answer needs an action and an answer');
    return { action: r.action.slice(0, 500), answer: r.answer.slice(0, 4000) };
  });
  return answers.length ? { answers } : {};
}

function optImages(p: Record<string, unknown>): ImageRef[] | undefined {
  const v = p.images;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw bad('images must be an array');
  return v.map((x) => {
    if (!x || typeof x !== 'object' || typeof (x as ImageRef).path !== 'string') throw bad('each image needs a path');
    return x as ImageRef;
  });
}

// threads.create's projectIds: project ids, the thread joining each before its first turn.
function optProjectIds(p: Record<string, unknown>): { projectIds?: string[] } {
  const v = p.projectIds;
  if (v === undefined || v === null) return {};
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) throw bad('projectIds must be a list of project ids');
  return v.length ? { projectIds: v as string[] } : {};
}
