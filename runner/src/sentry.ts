// Error reporting to Sentry (project `threadbear`, tag component: runner),
// for the installed runner only. Agents start dev runners, tests and
// sandbox installs all day, and an agent watcher opens a thread for what
// reaches Sentry, so only a release snapshot (release.json beside src/)
// running on the real data dir reports. Anything run from a checkout
// (scripts/dev-runner.sh, `npm start`, the tests) has no release.json, and
// a sandbox install has another home. THREADBEAR_SENTRY=off turns it off.
// And only Mike's own copies (origin is mikecann/threadbear): someone's
// fork never reports to Mike's Sentry, nor opens threads in his watcher
// (docs/on-your-mac.md).
//
// Errors only: no tracing, no breadcrumbs (CLI output and URLs can carry
// a thread's text or a token), no PII or local variables. What it sends is the
// runner's own uncaught exceptions and its ERROR and WARN log lines, by
// message (WARN as Sentry warnings). An error's own words never go, only its
// kind and stack (errorKind; Daybreak finding 155), and every event is
// scrubbed as it leaves (scrubEvent), or not sent.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultHome } from './config.ts';
import { RELEASE, readRelease } from './release.ts';
import { redactSecrets } from './redaction.ts';
import { repoKey } from './upstream.ts';

const MIKES_REPO = 'github.com/mikecann/threadbear';

// A public client key (it ships in every Sentry client); fine to commit.
const DSN = 'https://c69460318b1f938fd1703c6578a059f6@o4508736647266304.ingest.us.sentry.io/4512336956293120';

// Default integrations left out. main.ts's own handlers report every
// uncaught exception and rejection (Sentry's report only the first
// uncaught one, and may exit the process). ProcessSession sends release
// health sessions, which aren't errors. The rest only make breadcrumbs
// or read local variables. ContextLines would send the source lines around
// each frame, and a frame can be a project's own patch, run in the runner.
const LEFT_OUT = new Set(['OnUncaughtException', 'OnUnhandledRejection', 'ProcessSession', 'Console', 'Http', 'NodeFetch', 'LocalVariablesAsync', 'ContextLines']);

type SentryModule = typeof import('@sentry/node');
let sentry: SentryModule | undefined;

function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// The origin remote of the checkout this release follows, if any.
function releaseOrigin(): string | undefined {
  const checkout = readRelease()?.checkout;
  if (!checkout) return undefined;
  const r = spawnSync('git', ['-C', checkout, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

// Whether this runner reports: a release of Mike's own repo, on the real
// data dir, not switched off. Pure but for the default origin, for the tests.
export function sentryWanted(home: string, env: NodeJS.ProcessEnv = process.env, release: string | undefined = RELEASE.release, origin: string | undefined = release ? releaseOrigin() : undefined): boolean {
  if (!release) return false;
  if (env.THREADBEAR_SENTRY === 'off' || env.NODE_ENV === 'test') return false;
  if (!origin || repoKey(origin) !== MIKES_REPO) return false;
  return realPath(home) === realPath(defaultHome());
}

// What the SDK is started with; the tests start it with these too, and a
// transport of their own.
export function sentryOptions(): import('@sentry/node').NodeOptions {
  return {
    dsn: DSN,
    environment: 'production',
    release: `threadbear-runner@${RELEASE.version}`,
    // Not the Mac's own name, which the SDK sends by default.
    serverName: 'threadbear-runner',
    // v11's replacement for sendDefaultPii: false. Its defaults collect
    // all of these, local variables included (a thread's text, a token).
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    // The runtime module hooks are for tracing's instrumentation.
    enableRuntimeChannelInjection: false,
    beforeBreadcrumb: () => null,
    // v11 attaches a stack to captureMessage by default, which turns each
    // log line into a nameless exception titled after reportLogLine.
    // Without it the issue is titled with the log message.
    attachStacktrace: false,
    integrations: (all) => all.filter((i) => !LEFT_OUT.has(i.name)),
    // The last word on every event, whatever made it: its text scrubbed
    // (scrubEvent), or nothing sent if the scrub fails.
    beforeSend: (event) => scrubEvent(event),
    initialScope: { tags: { component: 'runner' } },
  };
}

// Loads the SDK only when it's wanted, so a dev runner or a test never
// even imports it. Never throws: reporting must not stop the runner.
export async function startSentry(home: string): Promise<boolean> {
  if (!sentryWanted(home)) return false;
  try {
    const S = await import('@sentry/node');
    S.init(sentryOptions());
    sentry = S;
    return true;
  } catch {
    return false;
  }
}

// What every string an event carries goes through (Daybreak finding 155).
// Errors quote what they were looking at: git's stderr names a remote with
// its token in the URL, a parse error quotes its input. So a URL's userinfo
// goes whole (a bare token before the @ is the usual leak), then the
// runner's known secret values (main.ts hands them over), then the same
// shape rules as everything sent to Convex (redaction.ts), and it's cut
// short. Throws when the check fails, for scrubEvent to drop the event.
let maskKnown: (text: string) => string = (text) => text;
// Until main.ts hands the known values over, a log line's fields other than
// numbers and the error's kind are held back (its title is the runner's own
// fixed words, scrubbed by the shape rules).
let maskReady = false;

export function useSentryMask(mask: (text: string) => string): void {
  maskKnown = mask;
  maskReady = true;
}

// The lookbehind keeps it linear on runs like "ab-ab-ab-..." (as redaction.ts's URL rule).
// Up to the last @ before the path, so a password holding an @ or a quote
// goes whole too (Gemini's review of the fix); bounded, to stay linear.
const USERINFO = /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s?#<>]{1,512}@/gi;
const MAX_TEXT = 1000;

export function scrubForSentry(text: string): string {
  const out = redactSecrets(maskKnown(text.replace(USERINFO, '$1'))).text;
  return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT)}…` : out;
}

// What an error is, without what it says: its class (TypeError, RpcError,
// AbortError) and any errno-style code (ENOENT, EACCES), the words of a fixed
// vocabulary. For the `error` field of a log line and an exception's message,
// which quote whatever they were looking at (Daybreak finding 155): the
// watcher that picks up an issue runs on this Mac and reads runner.log for the
// rest.
// Error classes by name: JavaScript's and Node's own, and the runner's (a
// unit test keeps this list up to date with the classes in src/).
export const ERROR_CLASSES: ReadonlySet<string> = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'AbortError', 'TimeoutError', 'SystemError', 'DOMException',
  'AcpExitedError', 'AcpRpcError', 'AmbiguousPeer', 'BoxBootRefused', 'BoxFolderBroken', 'CheckRefused', 'CodexExitedError', 'CodexRpcError',
  'ConvexAdminError', 'CronError', 'ForeignPeer', 'GaveUp', 'HeldLocal', 'KeysBusy', 'ModelListsPending', 'NoSwitches', 'Refused', 'RewindRefusedError',
  'RpcClientError', 'RpcError', 'RunnerJsonError', 'RunnerNotProvedError', 'SessionNotFoundError', 'SessionUsageLimitError',
  'SpawnRefused', 'SpecialFile', 'StaleProcess', 'TooBig', 'Unknown', 'UnresolvedPeer', 'Waiting',
]);
const LEADING_CLASS = /^\s*(?:Uncaught\s+)?([A-Za-z][A-Za-z0-9]{0,40})\b/;
// Codes only from the system's own errno list, so a capitals word from the
// error's text can't ride along as one.
const ERRNO_CODES: ReadonlySet<string> = new Set(Object.keys(os.constants.errno));
const CODE = /\b(E[A-Z0-9]{2,15})\b/g;

export function errorKind(text: string, type?: string): string {
  const lead = LEADING_CLASS.exec(text)?.[1];
  const cls = lead && ERROR_CLASSES.has(lead) ? lead : type && ERROR_CLASSES.has(type) ? type : 'Error';
  const code = [...text.matchAll(CODE)].map((m) => m[1]!).find((c) => ERRNO_CODES.has(c));
  return code ? `${cls} (${code})` : cls;
}

// The error to hand the SDK in place of the one thrown: its kind for a
// message, and the stack lines that come after the message, never the
// message's own lines (one could read "    at x (https://user:pw@host/)",
// which the SDK would take for a frame; Codex's review of the fix). Causes
// the same way, a few deep. A stack that doesn't start with the message as
// expected goes without its frames.
export function cleanError(e: unknown, depth = 0): Error {
  const err = e instanceof Error ? e : undefined;
  const name = err && ERROR_CLASSES.has(err.name) ? err.name : 'Error';
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const kind = err ? errorKind(`${err.name}: ${err.message}${typeof code === 'string' ? ` ${code}` : ''}`, err.name) : 'Error';
  const out = new Error(kind);
  out.name = name;
  const stack = typeof err?.stack === 'string' ? err.stack : '';
  const head = err ? (err.message ? `${err.name}: ${err.message}` : err.name) : '';
  const frames = err && stack.startsWith(head) && /^(?:\n\s+at [^\n]*)*$/.test(stack.slice(head.length)) ? stack.slice(head.length) : '';
  out.stack = `${name}: ${kind}${frames}`;
  if (err && err.cause !== undefined && depth < 4) out.cause = cleanError(err.cause, depth + 1);
  return out;
}

// A log line's title: its fixed message, a path in it (housekeeping names the
// file it couldn't tidy) taken out, then scrubbed.
const PATHS = /(?:~|(?<![\w.])\/)[^\s'"`]*\/[^\s'"`]*|\b[A-Za-z]:\\[^\s'"`]+/g;

const HOME = os.homedir();
const asPath = (p: string): string => {
  if (!p.startsWith('file://')) return p;
  try {
    return fileURLToPath(p);
  } catch {
    return p;
  }
};
// The home folder out of a frame path, matched whole (up to a separator),
// with either slash, and any case on Windows.
const withoutHome = (p: string): string => {
  const f = asPath(p);
  if (!HOME || HOME.length < 2) return f;
  const norm = (x: string) => (process.platform === 'win32' ? x.replace(/\\/g, '/').toLowerCase() : x);
  const h = norm(HOME).replace(/\/+$/, '');
  const n = norm(f);
  return n.startsWith(h) && (n.length === h.length || n[h.length] === '/' || n[h.length] === '\\') ? `~${f.slice(h.length)}` : f;
};
// The runner's own code: this package (src/, node_modules/) and Node's.
const RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTSIDE = '<outside the runner>';
const FRAME_FIELDS = new Set(['filename', 'abs_path', 'function', 'module', 'lineno', 'colno', 'in_app', 'platform']);
// A file path in a frame, made comparable: a file:// URL as a path, and on
// Windows the SDK's forward slashes and any case.
const comparable = (p: string): string => {
  const f = path.resolve(asPath(p));
  return process.platform === 'win32' ? f.toLowerCase() : f;
};
const ROOT = comparable(RUNNER_ROOT);
function ownFrame(file: string): boolean {
  // Node's own; not '<anonymous>', which is eval'd code and could be a patch's.
  if (/^node:[a-z_/]+$/.test(file)) return true;
  // A relative name (vm's evalmachine, a sourceURL) isn't a file of ours,
  // whatever folder the runner runs in.
  if (!file || file.startsWith('<') || !path.isAbsolute(asPath(file))) return false;
  const f = comparable(file);
  return f === ROOT || f.startsWith(ROOT + path.sep);
}

type Json = unknown;
function scrubDeep(v: Json, depth = 0): Json {
  if (typeof v === 'string') return scrubForSentry(v);
  if (depth > 8 || v === null || typeof v !== 'object') return typeof v === 'number' || typeof v === 'boolean' || v === null ? v : undefined;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1));
  const out: Record<string, Json> = {};
  for (const [k, x] of Object.entries(v)) out[scrubForSentry(k)] = scrubDeep(x, depth + 1);
  return out;
}

// The event as it leaves: its message, every exception's text (a cause's
// too: each is one of exception.values), the mechanism's data, extras and
// tags and a frame's source lines scrubbed; anything that could carry a
// thread's text and isn't needed (breadcrumbs, request, user, a frame's
// variables) taken out. Stacks keep their file and function names, which are
// the runner's own. Null, so
// nothing goes, if any of it fails.
type SentryEventLike = {
  message?: unknown;
  logentry?: { message?: unknown; formatted?: unknown; params?: unknown };
  contexts?: Record<string, unknown>;
  exception?: { values?: { type?: unknown; value?: unknown; mechanism?: Record<string, unknown>; stacktrace?: { frames?: Record<string, unknown>[] } }[] };
  extra?: unknown;
  tags?: unknown;
  fingerprint?: unknown;
  transaction?: unknown;
  breadcrumbs?: unknown;
  request?: unknown;
  user?: unknown;
  threads?: unknown;
};

export function scrubEvent<E>(event: E): E | null {
  try {
    const e = event as SentryEventLike;
    if (typeof e.message === 'string') e.message = scrubForSentry(e.message);
    if (e.logentry) {
      if (typeof e.logentry.message === 'string') e.logentry.message = scrubForSentry(e.logentry.message);
      if (typeof e.logentry.formatted === 'string') e.logentry.formatted = scrubForSentry(e.logentry.formatted);
      if (e.logentry.params !== undefined) e.logentry.params = scrubDeep(e.logentry.params);
    }
    for (const ex of e.exception?.values ?? []) {
      if (ex.type !== undefined) ex.type = typeof ex.type === 'string' && ERROR_CLASSES.has(ex.type) ? ex.type : 'Error';
      // An exception's message is free text (git's stderr, a parse error
      // quoting its input), so only its kind goes; runner.log has the whole of
      // it, beside the stack. The stack itself is the runner's own code.
      if (typeof ex.value === 'string') ex.value = errorKind(ex.value, typeof ex.type === 'string' ? ex.type : undefined);
      if (ex.mechanism) {
        const { type, handled, ...rest } = ex.mechanism as Record<string, unknown>;
        ex.mechanism = { ...(scrubDeep(rest) as Record<string, unknown>), ...(type !== undefined ? { type: scrubForSentry(String(type)) } : {}), ...(handled !== undefined ? { handled } : {}) };
      }
      for (const f of ex.stacktrace?.frames ?? []) {
        // Only these fields stay (no variables, no source lines, nothing
        // else the SDK might add). The runner's own files and functions go,
        // scrubbed, the home folder (the Mac account's name) taken out.
        // Anything else (a project's patch, eval'd code) goes as no more
        // than that.
        const file = typeof f.abs_path === 'string' ? f.abs_path : typeof f.filename === 'string' ? f.filename : '';
        const own = ownFrame(file);
        for (const k of Object.keys(f)) if (!FRAME_FIELDS.has(k)) delete f[k];
        for (const k of ['filename', 'abs_path', 'function', 'module'] as const) {
          if (f[k] === undefined) continue;
          f[k] = own && typeof f[k] === 'string' ? scrubForSentry(withoutHome(f[k] as string)) : OUTSIDE;
        }
      }
    }
    if (e.extra !== undefined) e.extra = scrubDeep(e.extra);
    if (e.tags !== undefined) e.tags = scrubDeep(e.tags);
    if (e.fingerprint !== undefined) e.fingerprint = scrubDeep(e.fingerprint);
    if (typeof e.transaction === 'string') e.transaction = scrubForSentry(e.transaction);
    // The SDK's own (os, runtime, app, device, culture): scrubbed, but for the
    // trace's ids, which no rule should touch.
    if (e.contexts) {
      const { trace, ...rest } = e.contexts;
      e.contexts = { ...(scrubDeep(rest) as Record<string, unknown>), ...(trace !== undefined ? { trace } : {}) };
    }
    delete e.breadcrumbs;
    delete e.request;
    delete e.user;
    delete e.threads;
    return event;
  } catch {
    return null;
  }
}

export function reportException(e: unknown, what: string): void {
  if (!sentry) return;
  try {
    sentry.captureException(cleanError(e), { tags: { what } });
  } catch {
    // never mind
  }
}

// Logged errors that main.ts reports as exceptions, with their stacks.
const REPORTED_AS_EXCEPTIONS = new Set(['uncaught exception', 'unhandled rejection']);
// Fields of a log line worth sending. Others (paths, prompts, a CLI's
// output under some other name) stay in runner.log. A name is no promise
// about what's in it, so `error` goes only as its kind (errorKind), and the
// rest, the runner's own words, are scrubbed too (scrubForSentry), here and
// again in beforeSend.
const SAFE_FIELDS = new Set(['error', 'method', 'kind', 'provider', 'commit', 'port', 'pid', 'threadId', 'reviewId']);
// One event per message an hour is plenty for the watcher, and keeps a
// failure that repeats every second from using up the month's quota.
const SAME_MESSAGE_MS = 60 * 60_000;
const lastSent = new Map<string, number>();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export type LogLevel = 'error' | 'warning';

// Log lines that aren't Threadbear bugs, so they never become issues: a
// model call failing is a login's limit or a provider being down, and
// Convex sync retries its network blips by itself.
function notOurBug(msg: string, extra: Record<string, unknown> | undefined): boolean {
  if (msg === 'model call failed') return true;
  return msg === 'convex sync failed; will retry' && /fetch failed/i.test(String(extra?.error ?? ''));
}

// What to send for one ERROR or WARN line, or null to send nothing. Grouped
// by the message (the fixed text, not the error inside it), with any thread
// or session id taken out so one fault is one issue. Pure but for the
// once-an-hour memory, for the tests.
export function logLineEvent(level: LogLevel, msg: string, extra: Record<string, unknown> | undefined, now = Date.now()) {
  if (REPORTED_AS_EXCEPTIONS.has(msg) || notOurBug(msg, extra)) return null;
  // One message can cover many causes: 'request failed' is logged for every
  // RPC method, so the method goes in the title to keep their issues apart.
  const method = typeof extra?.method === 'string' ? extra.method : undefined;
  const title = scrubForSentry((method ? `${msg} (${method})` : msg).replace(UUID, '<id>').replace(PATHS, '<path>'));
  const key = `${level} ${title}`;
  const last = lastSent.get(key);
  if (last !== undefined && now - last < SAME_MESSAGE_MS) return null;
  lastSent.set(key, now);
  return { title, level, fingerprint: ['runner-log', level, title], extra: safeFields(extra) };
}

// The logger's hooks for each ERROR and WARN line.
export function reportLoggedError(msg: string, extra?: Record<string, unknown>): void {
  reportLogLine('error', msg, extra);
}

export function reportLoggedWarning(msg: string, extra?: Record<string, unknown>): void {
  reportLogLine('warning', msg, extra);
}

function reportLogLine(level: LogLevel, msg: string, extra: Record<string, unknown> | undefined): void {
  if (!sentry) return;
  try {
    const event = logLineEvent(level, msg, extra);
    if (!event) return;
    sentry.captureMessage(event.title, { level: event.level, fingerprint: event.fingerprint, extra: event.extra });
  } catch {
    // never mind
  }
}

export function safeFields(extra: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (!SAFE_FIELDS.has(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') {
      if (k === 'error') out[k] = errorKind(v);
      else if (maskReady) out[k] = scrubForSentry(v).slice(0, 200);
    }
  }
  return out;
}

// Before a deliberate exit, so the last event goes out.
export async function flushSentry(ms = 2000): Promise<void> {
  if (!sentry) return;
  try {
    await sentry.flush(ms);
  } catch {
    // never mind
  }
}
