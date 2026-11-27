// Turns ACP's session/update notifications into the runner's events. Pure
// apart from NormalizerContext, so recorded agent output can be fed straight
// through it in tests.
import crypto from 'node:crypto';
import path from 'node:path';
import type { ImageRef, PlanEntry, ToolKind } from '../../protocol.ts';
import { diffLines } from '../../diff.ts';
import { displayPath, truncateInput } from '../../tools.ts';
import { firstLineSafely } from '../../safe-cut.ts';
import { truncateResultText, type NormalizerContext } from '../context.ts';
import type { AdapterOutput } from '../types.ts';

export type AcpToolCall = {
  toolCallId?: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: string;
  locations?: { path?: string }[];
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: AcpToolContent[];
};

type AcpBlock = { type?: string; text?: string; data?: string; mimeType?: string };
type AcpToolContent = { type?: string; content?: AcpBlock; path?: string; newText?: string; oldText?: string | null };

type Tool = {
  id: string;
  // The row's item id: the call's own, or the request's it took over
  // (askedFor).
  row: string;
  emitted: boolean;
  done: boolean;
  acpKind?: string;
  name?: string;
  title?: string;
  input: Record<string, unknown>;
  paths: string[];
  output: AcpToolContent[];
  rawOutput?: unknown;
  diffed: Set<string>;
  // A call through Grok's use_tool (useToolCall), and once it names the
  // tool it calls.
  wrapped?: boolean;
  resolved?: boolean;
  // Known only from a permission request so far, with the previews it
  // carried, kept apart from what the call's own updates later say.
  asked?: boolean;
  // Said by the agent to be running or over (in_progress, completed,
  // failed): a frame that only proposes it (Antigravity's pending "Run
  // create_file?") doesn't count.
  ran?: boolean;
  // Whether the request was let go ahead, once it's answered.
  allowed?: boolean;
  // The files the request named outright (namedFiles).
  askedFiles?: string[];
  askedDiffs?: AcpToolContent[];
};

function toolKind(acp: string | undefined): ToolKind {
  switch (acp) {
    case 'read':
      return 'read';
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit';
    case 'search':
      return 'search';
    case 'execute':
      return 'command';
    case 'fetch':
      return 'web';
    default:
      return 'other';
  }
}

// Every file a permission request names, from what the agent says it touches
// and from the tool's own arguments, as one could say less than the other.
// A check takes all of them: more names only makes it stricter.
const PATH_KEY = /path|file|dest|target|document|^to$|^from$/i;
const TEXT_KEY = /^(?:target|replacement|code)?content$|^instruction$|^description$/i;
// The files a patch body names: unified diffs and the `*** Update File:` kind.
const PATCH_HEADER = /^(?:\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: |\+\+\+ |--- |Index: |(?:rename|copy) (?:from|to) |diff --git )(.+)$/gm;

function pathsIn(v: unknown, key: string, out: Set<string>, depth: number): void {
  if (depth > 8) return;
  if (typeof v === 'string') {
    // A key about text (Antigravity's TargetContent, ReplacementContent,
    // Instruction) holds words, not a file, whatever else it's called.
    if (v && PATH_KEY.test(key) && !TEXT_KEY.test(key)) out.add(v);
    if (v.includes('\n')) {
      for (const m of v.matchAll(PATCH_HEADER)) {
        // A git header names two (`diff --git a/x b/y`), and git quotes a
        // name with odd characters in it: each one counts, unquoted
        // (Gemini's tenth review, 20 Nov 2026).
        const line = m[1].trim();
        const names = m[0].startsWith('diff --git ') ? line.split(/ (?=["]?b\/)/) : [line];
        for (const name of names) {
          const p = name.trim().replace(/^"(.*)"$/, '$1').replace(/^[ab]\//, '').split('\t')[0].replace(/^"(.*)"$/, '$1');
          if (p && p !== '/dev/null') out.add(p);
        }
      }
    }
  } else if (Array.isArray(v)) {
    for (const x of v) pathsIn(x, key, out, depth + 1);
  } else if (isPlainObject(v)) {
    for (const [k, x] of Object.entries(v)) pathsIn(x, k, out, depth + 1);
  }
}

// The files a call names outright: its locations and diffs, or failing
// those, every path its arguments name. Not what requestPaths finds in a
// file's new text (a `--- ` line in a Markdown file), which would keep a
// call from being matched with its request (askedFor; Gemini's review, 20
// Nov 2026).
function namedFiles(call: AcpToolCall): string[] {
  const out = new Set<string>();
  for (const l of Array.isArray(call.locations) ? call.locations : []) if (typeof l?.path === 'string' && l.path) out.add(l.path);
  for (const c of Array.isArray(call.content) ? call.content : []) if (c?.type === 'diff' && typeof c.path === 'string' && c.path) out.add(c.path);
  return out.size ? [...out] : requestPaths(call);
}

export function requestPaths(call: AcpToolCall): string[] {
  const out = new Set<string>();
  for (const l of Array.isArray(call.locations) ? call.locations : []) if (typeof l?.path === 'string' && l.path) out.add(l.path);
  for (const c of Array.isArray(call.content) ? call.content : []) if (c?.type === 'diff' && typeof c.path === 'string' && c.path) out.add(c.path);
  pathsIn(call.rawInput, '', out, 0);
  return [...out];
}

// The arguments of the plain file tools the agents have, where what's named
// is all there is. Any other shape might write somewhere nobody has found:
// such a call can't be covered by "Always allow". Grok's requests say which
// of its tools as `variant` ("Write"), which names no place.
const PLAIN_EDIT_KEYS = new Set(['filepath', 'file_path', 'path', 'content', 'oldstring', 'newstring', 'old_string', 'new_string', 'diff', 'replaceall', 'replace_all', 'description', 'variant']);

// Whether a patch among the arguments has a file header that can't be read
// for certain: a quoted or escaped name, a name with spaces in it, a tab
// right after the marker, or a `diff --git` line without a/ and b/. Such a
// patch could name a file the paths above don't (Gemini's eleventh review,
// 20 Nov 2026), so it's an edit nobody has checked.
const HEADER_LINE = /^(\*\*\* (?:Add|Update|Delete) File:|\*\*\* Move to:|\+\+\+|---|Index:|(?:rename|copy) (?:from|to)|diff --git)([ \t])(.*)$/gm;
export function hasOddPatchHeader(v: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (typeof v === 'string') {
    if (!v.includes('\n')) return false;
    for (const m of v.matchAll(HEADER_LINE)) {
      const [, marker, sep, rest] = m;
      if (marker === 'diff --git') {
        if (!/^a\/\S+ b\/\S+$/.test(rest)) return true;
        continue;
      }
      // A unified diff's name may be followed by a tab and a timestamp.
      const name = rest.split('\t')[0];
      if (sep !== ' ' || /[\s"\\]/.test(name)) return true;
    }
    return false;
  }
  if (Array.isArray(v)) return v.some((x) => hasOddPatchHeader(x, depth + 1));
  if (v && typeof v === 'object') return Object.values(v).some((x) => hasOddPatchHeader(x, depth + 1));
  return false;
}

// Grok's tool names, as `variant`, that only write the files they name.
const EDIT_VARIANTS = new Set(['Write', 'Edit', 'MultiEdit', 'StrReplace']);

export function isPlainEdit(input: Record<string, unknown>): boolean {
  if (hasOddPatchHeader(input)) return false;
  return Object.entries(input).every(([k, v]) => PLAIN_EDIT_KEYS.has(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'boolean') && (k.toLowerCase() !== 'variant' || EDIT_VARIANTS.has(String(v))));
}

// Whether an edit's rawInput actually carries what it writes (new text, a
// complete text diff, or a list of edit chunks). An edit naming only its file
// path or a binary-diff summary is opaque, like Codex's apply_patch, so Auto's
// reviewer skips it.
const EDIT_TEXT_KEYS = new Set(['content', 'codecontent', 'new_string', 'newstring', 'new_text', 'newtext', 'replacement', 'replacementcontent', 'text', 'body']);
const FULL_FILE_KEYS = new Set(['content', 'codecontent', 'text', 'body']);
const OLD_TEXT_KEYS = new Set(['old_string', 'oldstring', 'old_text', 'oldtext', 'targetcontent']);
const NEW_TEXT_KEYS = new Set(['new_string', 'newstring', 'new_text', 'newtext', 'replacement', 'replacementcontent']);
const EDIT_DIFF_KEYS = new Set(['diff', 'patch']);
const EDIT_LIST_KEYS = new Set(['edits', 'changes', 'replacementchunks']);
const BINARY_DIFF_LINE = /^(?:Binary files\b.*\bdiffer|Files\b.*\bdiffer|GIT binary patch)\s*$/m;
const UNIFIED_HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;
const DIFF_CHANGE_LINE = /^[+-](?![+-]{2})/m;
const APPLY_PATCH_BLOCK = /^\*\*\* (?:Add|Update|Delete) File: \S+/m;

export function isCompleteDiff(s: string): boolean {
  if (!s.trim() || BINARY_DIFF_LINE.test(s)) return false;
  if (UNIFIED_HUNK.test(s) && DIFF_CHANGE_LINE.test(s)) return true;
  if (APPLY_PATCH_BLOCK.test(s) && (DIFF_CHANGE_LINE.test(s) || /^\*\*\* Delete File: \S+/m.test(s))) return true;
  return false;
}

export function hasEditContent(input: Record<string, unknown>, depth = 0): boolean {
  if (depth > 4) return false;
  let found = false;
  for (const [k, v] of Object.entries(input)) {
    const lower = k.toLowerCase();
    if (EDIT_DIFF_KEYS.has(lower)) {
      if (typeof v !== 'string' || !isCompleteDiff(v)) return false;
      found = true;
    } else if (EDIT_TEXT_KEYS.has(lower) && typeof v === 'string') {
      found = true;
    } else if (EDIT_LIST_KEYS.has(lower)) {
      if (!Array.isArray(v) || v.length === 0 || !v.every((x) => isPlainObject(x) && hasEditContent(x, depth + 1))) return false;
      found = true;
    }
  }
  return found;
}

function singleReplacementMatches(oldText: string, newText: string, oldVal: string, newVal: string): boolean {
  if (!oldVal) return false;
  let idx = oldText.indexOf(oldVal);
  while (idx !== -1) {
    if (oldText.slice(0, idx) + newVal + oldText.slice(idx + oldVal.length) === newText) return true;
    idx = oldText.indexOf(oldVal, idx + 1);
  }
  return false;
}

// Whether every ACP content diff preview agrees with what rawInput says it
// writes. Contradictory or unverifiable previews bypass Auto's reviewer.
export function diffsAgreeWithInput(diffs: Record<string, unknown>[], input: Record<string, unknown>, cwd: string): boolean {
  if (!diffs.length) return true;
  const seenPaths = new Set<string>();
  for (const d of diffs) {
    if (typeof d.path !== 'string' || !d.path || typeof d.newText !== 'string') return false;
    if (d.oldText !== undefined && d.oldText !== null && typeof d.oldText !== 'string') return false;
    const abs = absolutePath(d.path, cwd);
    if (seenPaths.has(abs)) return false;
    seenPaths.add(abs);
  }
  if (diffs.length !== 1) return false;
  const d = diffs[0];
  const newText = d.newText as string;
  const oldText = typeof d.oldText === 'string' ? d.oldText : undefined;

  let fullVal: string | undefined;
  let oldVal: string | undefined;
  let newVal: string | undefined;
  let replaceAll = false;
  let fullCount = 0;
  let newCount = 0;
  let oldCount = 0;
  for (const [k, v] of Object.entries(input)) {
    const lower = k.toLowerCase();
    if (EDIT_DIFF_KEYS.has(lower) || EDIT_LIST_KEYS.has(lower)) return false;
    if (FULL_FILE_KEYS.has(lower)) {
      if (typeof v !== 'string') return false;
      fullVal = v;
      fullCount++;
    } else if (NEW_TEXT_KEYS.has(lower)) {
      if (typeof v !== 'string') return false;
      newVal = v;
      newCount++;
    } else if (OLD_TEXT_KEYS.has(lower)) {
      if (typeof v !== 'string') return false;
      oldVal = v;
      oldCount++;
    } else if (lower === 'replaceall' || lower === 'replace_all') {
      replaceAll = v === true;
    }
  }
  if (fullCount === 1 && newCount === 0 && oldCount === 0) return newText === fullVal;
  if (fullCount === 0 && newCount === 1 && oldCount === 1 && oldText !== undefined && oldVal !== undefined && newVal !== undefined) {
    if (replaceAll) return oldVal !== '' && oldText.includes(oldVal) && oldText.replaceAll(oldVal, newVal) === newText;
    return singleReplacementMatches(oldText, newText, oldVal, newVal);
  }
  return false;
}

// Kinds whose paths say what a call will change.
export function writesFiles(kind: string | undefined): boolean {
  return kind === 'edit' || kind === 'delete' || kind === 'move';
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

const firstLine = (s: string): string => firstLineSafely(s, 200, '…');

// The threadbear tools reach the agent as an MCP server; called
// `threadbear_end_turn` there, and mcp__threadbear__end_turn everywhere else.
export function canonicalToolName(name: string): string {
  const m = /^threadbear[_:.-]+(.+)$/.exec(name);
  return m ? `mcp__threadbear__${m[1]}` : name;
}

// Grok calls a deferred tool (an MCP server's, threadbear's among them)
// through its own `use_tool`, as `{ tool_name: "threadbear__end_turn",
// tool_input: {...} }`. Its first frame is titled use_tool and only a later
// one names the tool, so the shape is enough once the call has been seen as
// use_tool by its title or name. Not the shape alone, nor Grok's `variant`
// in it: any tool's arguments can say those, and would pass for end_turn
// (Codex's review, 16 Nov 2026).
function useToolCall(u: AcpToolCall, t: Tool): { name: string; input: Record<string, unknown> } | undefined {
  // Before its row is out: a call seen as something else can't become one.
  if (!t.emitted && [u.title, u.name].includes('use_tool')) t.wrapped = true;
  const raw = u.rawInput;
  if (!isPlainObject(raw) || typeof raw.tool_name !== 'string' || !raw.tool_name || !isPlainObject(raw.tool_input)) return undefined;
  if (!t.wrapped) return undefined;
  t.resolved = true;
  return { name: raw.tool_name, input: raw.tool_input };
}

export class AcpNormalizer {
  private ctx: NormalizerContext;
  private tools = new Map<string, Tool>();
  private text?: { messageId?: string; itemId: string; text: string };
  private thought?: { messageId?: string; itemId: string; text: string };
  private lastAssistant = '';
  costUsd?: number;

  private movesAskedCalls: boolean;

  constructor(ctx: NormalizerContext, o: { movesAskedCalls?: boolean } = {}) {
    this.ctx = ctx;
    this.movesAskedCalls = o.movesAskedCalls === true;
  }

  // The last reply's words, for a Plan first thread's plan card.
  takeLastAssistantText(): string {
    const t = this.lastAssistant;
    this.lastAssistant = '';
    return t;
  }

  handle(update: unknown): AdapterOutput[] {
    if (!isPlainObject(update)) return [];
    const out: AdapterOutput[] = [];
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.chunk(update, 'text', out);
        break;
      case 'agent_thought_chunk':
        this.chunk(update, 'thought', out);
        break;
      case 'tool_call':
      case 'tool_call_update':
        this.flush(out);
        this.toolUpdate(update as AcpToolCall, out);
        break;
      case 'plan':
        this.flush(out);
        if (Array.isArray(update.entries)) out.push({ kind: 'event', event: { type: 'plan.updated', entries: planEntries(update.entries) } });
        break;
      case 'usage_update':
        if (typeof update.used === 'number') out.push({ kind: 'context', contextTokens: update.used, ...(typeof update.size === 'number' ? { contextWindow: update.size } : {}) });
        if (isPlainObject(update.cost) && update.cost.currency === 'USD' && typeof update.cost.amount === 'number') this.costUsd = update.cost.amount;
        break;
      // user_message_chunk, modes, commands and anything newer: nothing to show.
    }
    return out;
  }

  private chunk(update: Record<string, unknown>, which: 'text' | 'thought', out: AdapterOutput[]): void {
    const block = (isPlainObject(update.content) ? update.content : {}) as AcpBlock;
    if (block.type !== 'text' || typeof block.text !== 'string' || !block.text) return;
    const messageId = typeof update.messageId === 'string' ? update.messageId : undefined;
    const open = which === 'text' ? this.text : this.thought;
    if (which === 'text') this.flushThought(out);
    else this.flushText(out);
    let current = open;
    if (!current || (messageId && current.messageId && current.messageId !== messageId)) {
      if (which === 'text') this.flushText(out);
      else this.flushThought(out);
      current = { messageId, itemId: crypto.randomUUID(), text: '' };
      if (which === 'text') this.text = current;
      else this.thought = current;
    }
    current.text += block.text;
    out.push({ kind: 'delta', delta: { type: which === 'text' ? 'assistant.text.delta' : 'reasoning.delta', itemId: current.itemId, text: block.text } });
  }

  private flushText(out: AdapterOutput[]): void {
    const t = this.text;
    this.text = undefined;
    if (!t?.text) return;
    this.lastAssistant = t.text;
    out.push({ kind: 'event', event: { type: 'assistant.text', itemId: t.itemId, text: t.text } });
  }

  private flushThought(out: AdapterOutput[]): void {
    const t = this.thought;
    this.thought = undefined;
    if (t?.text) out.push({ kind: 'event', event: { type: 'reasoning', itemId: t.itemId, text: t.text } });
  }

  // Closes what's being written, before a tool row or the end of a turn.
  flush(out: AdapterOutput[] = []): AdapterOutput[] {
    this.flushThought(out);
    this.flushText(out);
    return out;
  }

  private tool(id: string): Tool {
    let t = this.tools.get(id);
    if (!t) {
      t = { id, row: id, emitted: false, done: false, input: {}, paths: [], output: [], diffed: new Set() };
      this.tools.set(id, t);
      if (this.tools.size > 500) this.tools.delete(this.tools.keys().next().value!);
    }
    return t;
  }

  private merge(t: Tool, u: AcpToolCall): void {
    if (typeof u.kind === 'string') t.acpKind = u.kind;
    if (typeof u.name === 'string' && u.name) t.name = u.name;
    if (typeof u.title === 'string' && u.title) t.title = u.title;
    const wrapped = useToolCall(u, t);
    if (wrapped) {
      // The row is the tool it calls, so the runner sees end_turn as
      // end_turn: named `use_tool`, every Grok review's verdict went unseen
      // and the thread it reviewed slept on (16 Nov 2026, 53cd067b).
      t.name = wrapped.name;
      t.input = wrapped.input;
    } else if (isPlainObject(u.rawInput) && Object.keys(u.rawInput).length) t.input = u.rawInput;
    // Everything this call has ever named, however it was named.
    for (const p of requestPaths(u)) if (!t.paths.includes(p)) t.paths.push(p);
    if (Array.isArray(u.content)) t.output = u.content;
    if (u.rawOutput !== undefined) t.rawOutput = u.rawOutput;
  }

  // A permission request carries the call as the agent sees it then. Its
  // row comes out only when a card is put up (showCall), as the card names
  // it, or when the call's own updates say it runs: one allowed without a
  // card may be run under another id (Antigravity's create_file, 20 Nov
  // 2026), and a row for the request would be left open, then failed.
  noteCall(call: AcpToolCall): { id: string; row: string; paths: string[]; kind?: string; input: Record<string, unknown>; title?: string } {
    const id = typeof call.toolCallId === 'string' && call.toolCallId ? call.toolCallId : crypto.randomUUID();
    const t = this.tool(id);
    t.asked = true;
    this.merge(t, call);
    const diffs = (Array.isArray(call.content) ? call.content : []).filter((c) => c?.type === 'diff');
    if (diffs.length) t.askedDiffs = diffs;
    t.askedFiles = namedFiles(call);
    return { id, row: t.row, paths: [...t.paths], kind: t.acpKind, input: t.input, title: t.title };
  }

  // How a request was answered: only one let go ahead can be the call an
  // agent then runs under another id.
  answered(id: string, allowed: boolean): void {
    const t = this.tools.get(id);
    if (t) t.allowed = allowed;
  }

  // The row for a request that's getting a card, with its preview.
  showCall(id: string): AdapterOutput[] {
    const t = this.tools.get(id);
    if (!t) return [];
    const out: AdapterOutput[] = [];
    this.emitCall(t, out);
    this.emitDiffs(t, out);
    return out;
  }

  // A call the agent opens under a new id that is plainly the one an earlier
  // request asked about, when nothing has been said under that request's id
  // since: the same kind of file change, naming the same files, each by its
  // whole path, and the request was let go ahead. Antigravity asks for
  // create_file under one id and runs it as edit_file under its step's id,
  // with no link between the two. The new call then shows on the request's
  // row, so a card's row is the one that runs; what each call has said stays
  // its own, as the permission checks read it (Codex's review, 20 Nov 2026).
  private askedFor(u: AcpToolCall, kind = u.kind): Tool | undefined {
    // Only for an agent known to do it, and only once the new call says it
    // runs: a call that's only proposed may be another one entirely, still to
    // be asked about (Codex's third review, 20 Nov 2026).
    if (!this.movesAskedCalls || (u.status !== 'in_progress' && u.status !== 'completed')) return undefined;
    if (!writesFiles(kind)) return undefined;
    const paths = namedFiles(u);
    if (!paths.length || !paths.every((p) => path.isAbsolute(p))) return undefined;
    const same = (a: string[], b: string[]) => {
      const x = new Set(a.map((p) => path.resolve(p)));
      const y = new Set(b.map((p) => path.resolve(p)));
      return x.size === y.size && [...x].every((p) => y.has(p));
    };
    // The oldest first: an agent runs what it asked for in turn.
    const found = [...this.tools.values()].find((t) => t.asked && t.allowed === true && !t.ran && !t.done && t.acpKind === kind && (t.askedFiles ?? []).every((p) => path.isAbsolute(p)) && same(t.askedFiles ?? [], paths));
    return found;
  }

  private toolUpdate(u: AcpToolCall, out: AdapterOutput[]): void {
    if (typeof u.toolCallId !== 'string' || !u.toolCallId) return;
    // Tried again until the call's row is out, as its first frame may name
    // no file yet (Codex's review, 20 Nov 2026).
    const had = this.tools.get(u.toolCallId);
    const asked = !had ? this.askedFor(u) : !had.emitted && had.allowed === undefined && !had.done && had.row === had.id ? this.askedFor(u, typeof u.kind === 'string' ? u.kind : had.acpKind) : undefined;
    const t = this.tool(u.toolCallId);
    if (asked) {
      asked.done = true;
      t.row = asked.row;
      t.emitted = asked.emitted;
      t.diffed = asked.diffed;
      t.askedDiffs = asked.askedDiffs;
    }
    // Closed at a turn's end before it was ever shown: a row now would never
    // get its result.
    if (t.done && !t.emitted) return;
    if (u.status === 'in_progress' || u.status === 'completed' || u.status === 'failed') t.ran = true;
    this.merge(t, u);
    // Agents can open a call with nothing filled in yet (OpenCode: title
    // "write", rawInput {}), so the row waits for its input or its start.
    const over = u.status === 'completed' || u.status === 'failed';
    const under = u.status === 'in_progress' || over;
    // A use_tool call's row waits for the tool it names (its arguments can
    // stream in after it starts), or its row would be use_tool for good.
    const unnamed = t.wrapped && !t.resolved && !over;
    if (!unnamed && (Object.keys(t.input).length || under)) this.emitCall(t, out);
    if (t.emitted) this.emitDiffs(t, out);
    if ((u.status === 'completed' || u.status === 'failed') && !t.done) this.emitResult(t, u.status === 'completed', out);
  }

  private title(t: Tool): string {
    const command = typeof t.input.command === 'string' ? t.input.command : '';
    if (t.acpKind === 'execute' && command) return firstLine(command);
    if (writesFiles(t.acpKind) && t.paths.length === 1) return `Edit ${displayPath(t.paths[0], this.ctx.cwd)}`;
    return firstLine(t.title || t.name || t.acpKind || 'Tool');
  }

  private emitCall(t: Tool, out: AdapterOutput[]): void {
    if (t.emitted) return;
    t.emitted = true;
    const name = canonicalToolName(t.name || t.title || t.acpKind || 'tool');
    const kind = name.startsWith('mcp__') ? 'mcp' : toolKind(t.acpKind);
    out.push({ kind: 'event', event: { type: 'tool.call', itemId: t.row, name, kind, title: this.title(t), input: truncateInput(t.input) } });
  }

  private emitDiffs(t: Tool, out: AdapterOutput[]): void {
    for (const c of [...t.output, ...(t.askedDiffs ?? [])]) {
      if (c?.type !== 'diff' || typeof c.path !== 'string' || typeof c.newText !== 'string' || t.diffed.has(c.path)) continue;
      t.diffed.add(c.path);
      out.push({ kind: 'event', event: { type: 'edit.diff', itemId: t.row, path: c.path, hunks: diffLines(typeof c.oldText === 'string' ? c.oldText : '', c.newText) } });
    }
  }

  private emitResult(t: Tool, ok: boolean, out: AdapterOutput[]): void {
    t.done = true;
    const texts: string[] = [];
    const images: ImageRef[] = [];
    const pushContentBlock = (block: unknown): void => {
      if (!isPlainObject(block)) return;
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
        try {
          images.push(this.ctx.saveImage(block.data, block.mimeType, t.row));
        } catch {
          // Not an image this can save: the row still shows its text.
        }
      }
    };
    for (const c of t.output) {
      if (!c) continue;
      if (c.type === 'content' && c.content) pushContentBlock(c.content);
      else pushContentBlock(c);
    }
    if (!texts.length && t.rawOutput !== undefined && t.rawOutput !== null) {
      if (typeof t.rawOutput === 'string') {
        if (t.rawOutput) texts.push(t.rawOutput);
      } else if (Array.isArray(t.rawOutput)) {
        for (const item of t.rawOutput) {
          if (typeof item === 'string' && item) texts.push(item);
          else pushContentBlock(item);
        }
      } else if (isPlainObject(t.rawOutput)) {
        const said = t.rawOutput.output ?? t.rawOutput.error ?? t.rawOutput.message ?? t.rawOutput.text;
        if (typeof said === 'string' && said) texts.push(said);
        // Grok's MCP result: `output: { OkayOutput: "Noted: ..." }` (or its
        // error's). Dropped, end_turn's "Noted" never reached the runner.
        else if (isPlainObject(said)) {
          for (const v of Object.values(said)) if (typeof v === 'string' && v) texts.push(v);
        }
        if (!texts.length && Array.isArray(t.rawOutput.content)) {
          for (const item of t.rawOutput.content) pushContentBlock(item);
        }
      }
    }
    out.push({ kind: 'event', event: { type: 'tool.result', itemId: t.row, ok, ...truncateResultText(texts.join('\n'), t.row, this.ctx), images } });
  }

  hasRunningTools(): boolean {
    for (const tool of this.tools.values()) {
      if (tool.ran && !tool.done) return true;
    }
    return false;
  }

  // The turn has ended, or the agent has gone: no more updates are coming
  // for anything still open.
  closeOpen(reason: string): AdapterOutput[] {
    const out = this.flush();
    for (const t of this.tools.values()) {
      if (t.done) continue;
      t.done = true;
      // Never shown (a request allowed without a card that didn't run): no
      // row, and nothing later can take it over (askedFor).
      if (!t.emitted) continue;
      this.emitDiffs(t, out);
      out.push({ kind: 'event', event: { type: 'tool.result', itemId: t.row, ok: false, text: reason, truncated: false, images: [] } });
    }
    return out;
  }
}

function planEntries(raw: unknown[]): PlanEntry[] {
  return raw.filter(isPlainObject).map((e) => ({
    text: typeof e.content === 'string' ? e.content : '',
    status: e.status === 'in_progress' || e.status === 'completed' ? e.status : 'pending',
  }));
}

// Whether a path someone reported is inside the given folder, resolved.
export const absolutePath = (p: string, cwd: string): string => path.resolve(cwd, p);
