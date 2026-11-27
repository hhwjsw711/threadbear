// The backend's functions (convex/*.ts) run against an in-memory database,
// so a test can call a mutation's handler the way a runner or phone would
// and look at what it left. Each module is loaded from its source with the
// types stripped and its imports bound to fakes (convex/values, the
// generated server) or to other modules loaded the same way. Indexes come
// from convex/schema.ts, so an index read is ordered as Convex orders it.
// Enough of the API for sync.ts, phone.ts, share.ts and lib.ts; not a
// Convex emulator.
//
// Validators are Convex's own (convex/values), and checked as a deployment
// checks them (convex-validate.ts): `call` refuses args or a return value its
// function's validators don't allow, and a row a function writes that its
// table in convex/schema.ts doesn't allow. Rows a test inserts itself aren't
// checked, as some stand for rows from before a rule on purpose.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { v } from 'convex/values';
import { objectProblem, problem } from './convex-validate.ts';

const CONVEX = path.join(import.meta.dirname, '../../../convex');
// The state machines library (convex/machines.ts), and the convex/server it
// builds on, from the repo root's node_modules, where convex/ installs it:
// the real thing, run against this database. Its schema has to be the real
// one too (defineSchema's tables, each with its validator), so the schema
// fakes below wrap Convex's own.
const rootRequire = createRequire(path.join(CONVEX, '..', 'package.json'));
const serverModule = (await import(pathToFileURL(rootRequire.resolve('convex/server')).href)) as Record<string, any>;
const realServer = (serverModule.defineTable ? serverModule : serverModule.default) as Record<string, any>;
const stateMachines = (await import(pathToFileURL(rootRequire.resolve('@convex-dev/state-machines')).href)) as Record<string, unknown>;
// The push relay's own Convex project (relay/convex), for memoryBackend(RELAY).
export const RELAY = path.join(import.meta.dirname, '../../../relay/convex');

export class ConvexError extends Error {
  data: unknown;
  constructor(data: unknown) {
    super(typeof data === 'string' ? data : JSON.stringify(data));
    this.data = data;
  }
}

// A function reference, as internal.x.y: its name as Convex gives it
// (getFunctionName: "x:y", without "internal"/"api"), for the state
// machines library's lookups.
const FUNCTION_NAME = Symbol.for('functionName');
const fnRef = (prefix: string[]): unknown =>
  new Proxy(() => prefix.join('.'), {
    get: (_, p) => {
      if (p === Symbol.toPrimitive) return () => prefix.join('.');
      if (p === FUNCTION_NAME) return `${prefix.slice(1, -1).join('/')}:${prefix.at(-1)}`;
      return fnRef([...prefix, String(p)]);
    },
  });

// defineTable keeps each table's indexes, for withIndex's order, and its
// fields (an object of validators, or one validator), for checking writes.
type V = Parameters<typeof problem>[0];
type Def = { __idx: Record<string, string[]>; __fields: unknown; index: (n: string, f: string[]) => Def; searchIndex: () => Def };
const defineTable = (fields: unknown): Def => {
  const def = realServer.defineTable(fields) as Def & Record<string, any>;
  const index = def.index.bind(def);
  def.__idx = {};
  def.__fields = fields;
  def.index = (n: string, f: string[]) => ((def.__idx[n] = f), index(n, f), def);
  return def;
};
// Per project folder (CONVEX or RELAY): each table's indexes and fields.
const schemas = new Map<string, { indexes: Record<string, Record<string, string[]>>; tableFields: Record<string, unknown> }>();

const isValidator = (x: unknown): x is V => Boolean(x && typeof x === 'object' && (x as { isConvexValidator?: unknown }).isConvexValidator);

// What's wrong with a document against fields (an object of validators, or a validator), or null.
function fitProblem(fields: unknown, doc: Record<string, unknown>): string | null {
  if (fields === undefined || fields === null) return null;
  return isValidator(fields) ? problem(fields, doc) : objectProblem(fields as Record<string, V>, doc);
}

const fakes: Record<string, Record<string, unknown>> = {
  'convex/values': { v, ConvexError },
  // An http.ts's router keeps its routes, so a test can call one's handler
  // (relay-clear.test.ts plays the relay's /clear).
  'convex/server': {
    defineSchema: (t: Record<string, Def>) => realServer.defineSchema(t),
    defineTable,
    httpRouter: () => {
      const routes: { path: string; method: string; handler: unknown }[] = [];
      return { routes, route: (r: { path: string; method: string; handler: unknown }) => void routes.push(r) };
    },
  },
  './_generated/server': { env: new Proxy({}, { get: (_, k) => process.env[String(k)] }), mutation: (x: unknown) => x, query: (x: unknown) => x, internalMutation: (x: unknown) => x, internalQuery: (x: unknown) => x, action: (x: unknown) => x, internalAction: (x: unknown) => x, httpAction: (x: unknown) => x },
  './_generated/api': { internal: fnRef(['internal']), api: fnRef(['api']), components: fnRef(['components']) },
  '@convex-dev/state-machines': stateMachines,
  '@convex-dev/static-hosting': { registerStaticRoutes: () => undefined },
};

const loaded = new Map<string, Record<string, unknown>>();

export function load(name: string, root = CONVEX): Record<string, any> {
  const key = root === CONVEX ? name : `${root}:${name}`;
  const hit = loaded.get(key);
  if (hit) return hit;
  const raw = fs.readFileSync(path.join(root, `${name}.ts`), 'utf8');
  const bound: Record<string, unknown> = {};
  for (const m of raw.matchAll(/^import (type )?\{([^}]*)\} from '([^']+)';$/gm)) {
    if (m[1]) continue;
    const from = m[3]!;
    // Relative to the importing file, as a bundler has it (boxProviders/fly.ts's './types').
    // Node's own modules as they are, for a "use node" file (push.ts).
    const mod = fakes[from] ?? (from.startsWith('node:') ? (rootRequire(from) as Record<string, unknown>) : from.startsWith('.') ? load(path.posix.join(path.posix.dirname(name), from.replace(/\.ts$/, '')), root) : undefined);
    if (!mod) throw new Error(`convex-memory: no fake for ${from} (in ${name}.ts)`);
    for (const spec of m[2]!.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (spec.startsWith('type ')) continue;
      const [orig, as] = spec.split(/\s+as\s+/);
      bound[(as ?? orig)!.trim()] = mod[orig!.trim()];
    }
  }
  const names = [...raw.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)].map((m) => m[1]!);
  let src = raw.replace(/^import [^;]*;$/gm, '').replace(/^export default /m, 'const __default = ').replace(/^export /gm, '');
  src = stripTypeScriptTypes(src, { mode: 'strip' });
  const mod = new Function(...Object.keys(bound), `${src}\nreturn { ${[...names, ...(/__default/.test(src) ? ['__default'] : [])].join(', ')} };`)(...Object.values(bound));
  loaded.set(key, mod);
  return mod;
}

function loadSchema(root: string) {
  const hit = schemas.get(root);
  if (hit) return hit;
  const schema = (load('schema', root).__default as { tables: Record<string, Def> }).tables;
  const out = {
    indexes: Object.fromEntries(Object.entries(schema).map(([t, d]) => [t, d.__idx])),
    tableFields: Object.fromEntries(Object.entries(schema).map(([t, d]) => [t, d.__fields])),
  };
  schemas.set(root, out);
  return out;
}

type Row = Record<string, any> & { _id: string; _creationTime: number };

export function memoryBackend(root = CONVEX) {
  const { indexes, tableFields } = loadSchema(root);
  const tables: Record<string, Row[]> = {};
  const files = new Set<string>();
  const fileSizes = new Map<string, number>();
  const deleted: string[] = [];
  let next = 0;
  const all = (t: string) => (tables[t] ??= []);
  const get = (row: Row, f: string) => f.split('.').reduce<any>((a, k) => a?.[k], row);
  const cmp = (a: unknown, b: unknown) => (a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : (a as any) < (b as any) ? -1 : 1);

  // Rows read by queries (what Convex's read limits count), for tests that a
  // function reads only what it should, and their bytes (as JSON, close to
  // Convex's own size), for its 16 MiB a mutation.
  const counter = { reads: 0, bytes: 0 };
  const read = (r: Row) => {
    counter.reads++;
    counter.bytes += Buffer.byteLength(JSON.stringify(r));
  };
  const find = (id: string) => Object.values(tables).flat().find((x) => x._id === id) ?? null;
  // Inside a function (call), every row written is checked against its table.
  const inCall = { depth: 0 };
  const tableOf = (id: string) => Object.keys(tables).find((t) => tables[t]!.some((r) => r._id === id));
  // (table, id): the id must be that table's, as Convex checks; (id) alone as it is.
  const byTable = (a: string, b?: string): string => {
    if (b === undefined) return a;
    if (!b.startsWith(`${a}:`)) throw new Error(`convex-memory: ${b} isn't an id of ${a}`);
    return b;
  };
  const checkRow = (table: string | undefined, row: Record<string, unknown>) => {
    if (!inCall.depth || !table) return;
    const { _id, _creationTime, ...doc } = row;
    const p = fitProblem(tableFields[table], doc);
    if (p) throw new Error(`convex-memory: a row in ${table} that convex/schema.ts doesn't allow, at ${p}`);
  };
  const db = {
    query(table: string) {
      const preds: ((r: Row) => boolean)[] = [];
      let order: string[] = [];
      let desc = false;
      const range = {
        eq: (f: string, x: unknown) => (preds.push((r) => get(r, f) === x), range),
        gt: (f: string, x: any) => (preds.push((r) => get(r, f) !== undefined && get(r, f) > x), range),
        gte: (f: string, x: any) => (preds.push((r) => get(r, f) !== undefined && get(r, f) >= x), range),
        lt: (f: string, x: any) => (preds.push((r) => get(r, f) !== undefined && get(r, f) < x), range),
        lte: (f: string, x: any) => (preds.push((r) => get(r, f) !== undefined && get(r, f) <= x), range),
      };
      const rows = () => {
        const out = all(table).filter((r) => preds.every((p) => p(r)));
        if (order.length) out.sort((a, b) => order.reduce((c, f) => c || cmp(get(a, f), get(b, f)), 0) || a._creationTime - b._creationTime);
        return desc ? out.reverse() : out;
      };
      const q = {
        withIndex(name: string, fn?: (r: typeof range) => unknown) {
          const fields = name === 'by_creation_time' ? ['_creationTime'] : indexes[table]?.[name];
          if (!fields) throw new Error(`convex-memory: no index ${table}.${name}`);
          order = fields;
          fn?.(range);
          return q;
        },
        filter(fn: (b: any) => (r: Row) => boolean) {
          const field = (f: string) => ({ field: f });
          const val = (x: any, r: Row) => (x && typeof x === 'object' && 'field' in x ? get(r, x.field) : x);
          preds.push(fn({ field, eq: (a: any, b: any) => (r: Row) => val(a, r) === val(b, r) }));
          return q;
        },
        order(d: 'asc' | 'desc') {
          desc = d === 'desc';
          return q;
        },
        async first() {
          const r = rows()[0] ?? null;
          if (r) read(r);
          return r;
        },
        async unique() {
          const r = rows();
          r.forEach(read);
          if (r.length > 1) throw new Error(`convex-memory: unique() found ${r.length} rows in ${table}`);
          return r[0] ?? null;
        },
        async collect() {
          const r = rows();
          r.forEach(read);
          return r;
        },
        async take(n: number) {
          // Convex refuses a count that isn't a whole number.
          if (!Number.isInteger(n) || n < 0) throw new Error(`convex-memory: take(${n})`);
          const r = rows().slice(0, n);
          r.forEach(read);
          return r;
        },
        // A page in the index's order, its cursor the last row's key, as
        // Convex's are: rows deleted along the way don't shift the next page.
        async paginate({ numItems, cursor }: { numItems: number; cursor: string | null }) {
          const keyOf = (r: Row) => [...order.map((f) => get(r, f)), r._creationTime];
          const after = (k: unknown[], c: unknown[]) => k.reduce<number>((acc, x, i) => acc || cmp(x, c[i]), 0) > 0;
          const last = cursor ? (JSON.parse(cursor) as unknown[]) : undefined;
          const all = rows().filter((r) => !last || after(keyOf(r), last));
          const page = all.slice(0, numItems);
          page.forEach(read);
          const end = page.at(-1);
          return { page, isDone: page.length >= all.length, continueCursor: end ? JSON.stringify(keyOf(end)) : (cursor ?? '') };
        },
        async *[Symbol.asyncIterator]() {
          for (const r of rows()) {
            read(r);
            yield r;
          }
        },
      };
      return q;
    },
    async insert(table: string, doc: Record<string, unknown>) {
      // A command row a test inserts itself stands for one on a deployment
      // today, which the backfill (migrations.ts) gave its machine state: it
      // gets it from its old fields, unless the test says commandState itself
      // (undefined, for a row from before the backfill).
      if (table === 'commands' && root === CONVEX && !inCall.depth && !('commandState' in doc)) {
        const { commandStateFrom } = load('commandStates') as { commandStateFrom: (r: unknown) => unknown };
        doc = { ...doc, commandState: commandStateFrom(doc), commandStateTimers: [] };
      }
      checkRow(table, doc);
      const _id = `${table}:${++next}`;
      all(table).push({ ...doc, _id, _creationTime: next } as Row);
      return _id;
    },
    // A get counts toward the bytes, not the rows (reads() is queries' rows).
    // Each takes (id) or, as Convex 1.31 and later do, (table, id), whose id
    // must be of that table.
    async get(a: string, b?: string) {
      const id = byTable(a, b);
      const r = find(id);
      if (r) counter.bytes += Buffer.byteLength(JSON.stringify(r));
      return r;
    },
    async patch(a: string, b: string | Record<string, unknown>, c?: Record<string, unknown>) {
      const id = typeof b === 'string' ? byTable(a, b) : a;
      const p = (typeof b === 'string' ? c : b)!;
      const row = find(id);
      if (!row) throw new Error(`convex-memory: no row ${id}`);
      const next: Record<string, unknown> = { ...row };
      for (const [k, x] of Object.entries(p)) {
        if (x === undefined) delete next[k];
        else next[k] = x;
      }
      checkRow(tableOf(id), next);
      for (const [k, x] of Object.entries(p)) {
        if (x === undefined) delete row[k];
        else row[k] = x;
      }
    },
    async replace(a: string, b: string | Record<string, unknown>, c?: Record<string, unknown>) {
      const id = typeof b === 'string' ? byTable(a, b) : a;
      const doc = (typeof b === 'string' ? c : b)!;
      const row = find(id);
      if (!row) throw new Error(`convex-memory: no row ${id}`);
      checkRow(tableOf(id), doc);
      for (const k of Object.keys(row)) if (k !== '_id' && k !== '_creationTime') delete row[k];
      Object.assign(row, doc);
    },
    async delete(a: string, b?: string) {
      const id = byTable(a, b);
      for (const t of Object.keys(tables)) tables[t] = tables[t]!.filter((r) => r._id !== id);
    },
    // (id) for a stored file, or (table, id) as the state machines library asks for its timers' jobs.
    system: {
      get: async (a: string, b?: string) => {
        if (b === undefined) return files.has(a) ? { _id: a, size: fileSizes.get(a) ?? 1024 } : null;
        if (a === '_scheduled_functions') return jobs.get(b) ?? null;
        return files.has(b) ? { _id: b, size: fileSizes.get(b) ?? 1024 } : null;
      },
      query: (table: string) => {
        if (table !== '_scheduled_functions') throw new Error(`convex-memory: no system table ${table}`);
        // Each job counts as a read, as Convex's 4,096 a function count them.
        const list = (desc: boolean) => (desc ? [...jobs.values()].reverse() : [...jobs.values()]);
        const over = (desc: boolean) => ({
          async *[Symbol.asyncIterator]() {
            for (const j of list(desc)) {
              read(j as never);
              yield j;
            }
          },
          // A page in that order, its cursor the last job's id.
          async paginate({ numItems, cursor }: { numItems: number; cursor: string | null }) {
            const rest = list(desc);
            const at = cursor ? rest.findIndex((j) => j._id === cursor) : -1;
            if (cursor && at < 0) throw new Error(`convex-memory: no job ${cursor} for a page's cursor`);
            const from = at + 1;
            const page = rest.slice(from, from + numItems);
            page.forEach((j) => read(j as never));
            return { page, isDone: from + page.length >= rest.length, continueCursor: page.at(-1)?._id ?? cursor ?? '' };
          },
        });
        return { order: (d: 'asc' | 'desc') => over(d === 'desc'), ...over(false) };
      },
      // A stored file's id is any name a test gave it (file()), or no table's row; a job's, a scheduled one's.
      normalizeId: (table: string, id: string) => (table === '_storage' ? (files.has(id) || !id.includes(':') ? id : null) : table === '_scheduled_functions' ? (jobs.has(id) ? id : null) : null),
    },
    normalizeId: (table: string, id: string) => (id.startsWith(`${table}:`) ? id : null),
  };
  const storage = {
    async generateUploadUrl() {
      return 'https://upload.example/';
    },
    async getUrl(id: string) {
      return files.has(id) ? `https://files.example/${id}` : null;
    },
    async delete(id: string) {
      deleted.push(id);
      files.delete(id);
    },
    // An HTTP action's store (convex/uploads.ts takeUpload).
    async store(blob: Blob) {
      const id = `stored${++next}`;
      files.add(id);
      fileSizes.set(id, blob.size);
      return id;
    },
  };
  const scheduled: unknown[] = [];
  // Every job by id, as _scheduled_functions has them, for the library's
  // timers: a timer is cancelled only while it's pending. runAt's go in
  // `timers` (not `scheduled`, which tests read as runAfter's), due at `at`.
  const jobs = new Map<string, { _id: string; name: string; args: unknown[]; scheduledTime: number; state: { kind: 'pending' | 'canceled' | 'success' | 'failed' } }>();
  const timers: { id: string; fn: string; args: any; at: number }[] = [];
  const job = (fn: unknown, args: unknown, at: number) => {
    const id = `_scheduled_functions:${++next}`;
    const name = (fn as Record<symbol, unknown>)[FUNCTION_NAME];
    // As _scheduled_functions keeps them: the function's name, its args in an array.
    jobs.set(id, { _id: id, name: typeof name === 'string' ? name : String(fn), args: [args], scheduledTime: at, state: { kind: 'pending' } });
    return id;
  };
  // The history component's facts (the library's one call to it per step).
  const history: Record<string, any>[] = [];
  const ctx = {
    db,
    storage,
    scheduler: {
      runAfter: async (ms: number, fn: unknown, args: unknown) => (scheduled.push({ fn: String(fn), args }), job(fn, args, Date.now() + ms)),
      runAt: async (at: number, fn: unknown, args: any) => {
        const id = job(fn, args, at);
        timers.push({ id, fn: String(fn), args, at });
        return id;
      },
      cancel: async (id: string) => {
        const j = jobs.get(id);
        if (j && j.state.kind === 'pending') j.state = { kind: 'canceled' };
      },
    },
    runMutation: async (fn: unknown, args: any) => {
      if (String(fn).endsWith('lib.record')) return (history.push(...args.facts.map((f: Record<string, unknown>) => ({ ...f, at: Date.now() }))), null);
      throw new Error(`convex-memory: runMutation(${String(fn)}) isn't faked`);
    },
    runQuery: async (fn: unknown, args: any) => {
      if (!String(fn).endsWith('lib.list')) throw new Error(`convex-memory: runQuery(${String(fn)}) isn't faked`);
      const page = history.filter((h) => h.machine === args.machine && h.subject === args.subject);
      return { page: args.order === 'desc' ? page.reverse() : page, isDone: true, continueCursor: '' };
    },
  };
  // For call: rows written meanwhile are checked.
  Object.defineProperty(ctx, CALLS, { value: inCall });
  return {
    ctx,
    rows: (t: string) => all(t),
    file: (id: string, size = 1024) => (files.add(id), fileSizes.set(id, size), id),
    hasFile: (id: string) => files.has(id),
    deleted,
    scheduled,
    history,
    // The timers still pending, due by `at` (a test runs the deliver mutation for one that's due).
    pendingTimers: () => timers.filter((t) => jobs.get(t.id)?.state.kind === 'pending'),
    timerRan: (id: string) => {
      const j = jobs.get(id);
      if (j) j.state = { kind: 'success' };
    },
    // A timer whose delivery threw, as Convex marks the job.
    timerFailed: (id: string) => {
      const j = jobs.get(id);
      if (j) j.state = { kind: 'failed' } as never;
    },
    reads: () => counter.reads,
    bytesRead: () => counter.bytes,
    resetReads: () => ((counter.reads = 0), (counter.bytes = 0)),
  };
}

const CALLS = Symbol('convex-memory calls');

// What every thread row a runner sends has (convex/schema.ts threadFields'
// required ones), for tests that only care about a few: spread it first.
const AT = '2026-11-01T00:00:00.000Z';
export const THREAD_BASICS = { cwd: '/Users/m/x', accountId: 'claude-main', provider: 'claude', status: 'idle', unread: false, preview: '', createdAt: AT, lastActivityAt: AT, lastActivityMs: Date.parse(AT) } as const;

/**
 * Calls a function as the deployment would: its args checked against its
 * validators, its handler with ctx and args, the rows it writes checked
 * against the schema, and what it returns against its `returns`.
 */
export async function call(ctx: unknown, fn: { handler: (ctx: any, args: any) => unknown; args?: unknown; returns?: unknown }, args: Record<string, unknown>): Promise<any> {
  const argsProblem = fitProblem(fn.args, args);
  if (argsProblem) throw new ArgumentValidationError(`convex-memory: args its validators don't allow, at ${argsProblem}`);
  const inCall = (ctx as Record<symbol, { depth: number } | undefined>)[CALLS];
  if (inCall) inCall.depth++;
  let out: unknown;
  try {
    out = await fn.handler(ctx, args);
  } finally {
    if (inCall) inCall.depth--;
  }
  if (isValidator(fn.returns)) {
    // Convex returns null for a handler that returned nothing.
    const p = problem(fn.returns, out === undefined ? null : out, 'the return value');
    if (p) throw new Error(`convex-memory: a return value its validator doesn't allow, at ${p}`);
  }
  return out;
}

// Thrown before the handler runs, as Convex's own argument validation is:
// not a ConvexError, so outcome() rethrows it rather than reading a kind.
export class ArgumentValidationError extends Error {}

/** The ConvexError kind a call threw, or "ok". */
export async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const kind = (e as { data?: { kind?: string } }).data?.kind;
    if (kind) return kind;
    throw e;
  }
}

/** A ticket's claim and finish, as /runner/upload, /phone/upload or /relay/upload has them, with a file already stored. */
export async function claimAndFinish(ctx: unknown, claim: any, finish: any, a: { ticket: unknown; storageId: string; bytes: number }): Promise<unknown> {
  const c = await call(ctx, claim, { ticket: a.ticket });
  if (c === false || c === 'later') return c;
  return call(ctx, finish, { ticket: a.ticket, claim: c.claim, storageId: a.storageId, bytes: a.bytes });
}
