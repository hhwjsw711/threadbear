// Reads what a sub-agent did from the transcript the CLI writes for it, as
// protocol events, for threads.subagent. The CLI appends to the file as the
// sub-agent works, so reading it again picks up where it has got to. The
// file's layout isn't a documented contract: lines this doesn't know are
// skipped.
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { ImageRef } from '../../protocol.ts';
import type { EventBody } from '../../protocol.ts';
import { base64Bytes } from '../../base64-stream.ts';
import { TOOL_IMAGE_LIMITS } from '../../tool-image-quota.ts';
import { ClaudeNormalizer, realModel, type NormalizerContext } from './normalize.ts';

export type TranscriptEvent = { ts?: string; body: EventBody };

type AnyMsg = Record<string, any>;

export type SubagentRead = { events: TranscriptEvent[]; model?: string; effort?: string };
type ReadResult = { kind: 'parsed'; value: SubagentRead } | { kind: 'refused'; message: string };

// Polling a subagent reuses its parsed image refs until the CLI appends more.
// Cache limits bound retained text; the file cap bounds a fresh parse. This
// lives on one Runner, so a CLI restart doesn't multiply retained copies.
export class SubagentTranscripts {
  private entries = new Map<string, { stamp: string; result: ReadResult; bytes: number }>();
  // Import history outlives parsed-result eviction. At most 1,024 attempts
  // per thread are retained, matching its persistent image-file allowance.
  private imports = new Map<string, { images: Map<string, ImageRef | string>; bytes: number }>();
  private bytes = 0;
  private importBytes: number;

  constructor(importBytes = TOOL_IMAGE_LIMITS.threadBytes) { this.importBytes = importBytes; }

  read(file: string, ctx: NormalizerContext): SubagentRead {
    const st = fs.statSync(file, { bigint: true });
    if (!st.isFile() || st.size > 64n * 1024n * 1024n) throw new Error('The subagent transcript is too large to read');
    const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    const before = this.entries.get(file);
    if (before?.stamp === stamp) {
      if (before.result.kind === 'refused') throw new Error(before.result.message);
      return before.result.value;
    }
    const scope = ctx.imageScope ?? file;
    let history = this.imports.get(scope);
    if (!history) { history = { images: new Map(), bytes: 0 }; this.imports.set(scope, history); }
    const work = history;
    const imports = work.images;
    const importBytes = this.importBytes;
    let result: ReadResult;
    try {
      const value = readSubagentTranscript(file, { ...ctx, saveImage(data, mediaType, hint) {
      const hash = crypto.createHash('sha256').update(mediaType).update('\0').update(hint);
      for (let i = 0; i < data.length; i += 64 * 1024) hash.update(data.slice(i, i + 64 * 1024));
      const key = hash.digest('hex');
      const saved = imports.get(key);
      if (typeof saved === 'string') throw new Error(saved);
      if (saved && fs.lstatSync(saved.path, { throwIfNoEntry: false })?.isFile()) return saved;
      if (!saved && imports.size >= 1024) throw new Error('The subagent image import allowance is exhausted');
      try {
        const size = base64Bytes(data, TOOL_IMAGE_LIMITS.imageBytes);
        if (work.bytes + size > importBytes) throw new Error('The subagent image byte allowance is exhausted');
        work.bytes += size;
        const image = ctx.saveImage(data, mediaType, hint);
        imports.set(key, image);
        return image;
      } catch (e) { imports.set(key, String(e).slice(0, 500)); throw e; }
      } });
      if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new Error('The subagent transcript has too much output to show at once');
      result = { kind: 'parsed', value };
    } catch (e) {
      // Refusals retain their import state too: polling an unchanged bad
      // transcript must not decode and rewrite its pictures every time.
      result = { kind: 'refused', message: String(e).slice(0, 500) };
    }
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (before) { this.entries.delete(file); this.bytes -= before.bytes; }
    while (this.entries.size >= 32 || this.bytes + bytes > 32 * 1024 * 1024) {
      const first = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(first)!.bytes;
      this.entries.delete(first);
    }
    this.entries.set(file, { stamp, result, bytes });
    this.bytes += bytes;
    if (result.kind === 'refused') throw new Error(result.message);
    return result.value;
  }
}

export function readSubagentTranscript(file: string, ctx: NormalizerContext): SubagentRead {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 64 * 1024 * 1024) throw new Error('The subagent transcript is too large to read');
    const buf = Buffer.alloc(st.size);
    let at = 0;
    while (at < buf.length) {
      const got = fs.readSync(fd, buf, at, buf.length - at, at);
      if (!got) break;
      at += got;
    }
    const text = buf.subarray(0, at).toString('utf8');
    const metadata = subagentModel(text);
    // Budget the whole result without importing images or writing blobs.
    // Rejected reads must stay cheap even when a caller evicts every cache
    // entry. Capture any source-file reads so both passes see the same diff.
    const reads = new Map<string, string | null>();
    let readBytes = 0;
    const readFile = (p: string): string | null => {
      if (reads.has(p)) return reads.get(p) ?? null;
      const value = ctx.readFile(p);
      readBytes += value === null ? 0 : Buffer.byteLength(value);
      if (readBytes > 32 * 1024 * 1024) throw new Error('The subagent transcript needs too many source files');
      reads.set(p, value);
      return value;
    };
    const placeholder = 'x'.repeat(ctx.savedPathBudget ?? 8192);
    const preflight = subagentEvents(text, { ...ctx, readFile, beginTurn: () => {}, saveImage: (_data, mediaType) => ({ path: placeholder, mediaType, width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER }), saveBlob: () => placeholder, copyBlob: () => placeholder });
    if (Buffer.byteLength(JSON.stringify({ events: preflight, ...metadata })) > 8 * 1024 * 1024) throw new Error('The subagent transcript has too much output to show at once');
    return { events: subagentEvents(text, { ...ctx, readFile }), ...metadata };
  } finally { fs.closeSync(fd); }
}

// The model and effort level its latest reply ran at. Each assistant line
// has `message.model` and the CLI's own `effort`; the last one wins, as a
// fallback model can take over partway.
export function subagentModel(text: string): { model?: string; effort?: string } {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    let d: AnyMsg;
    try {
      d = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const model = d.type === 'assistant' ? realModel(d.message?.model) : undefined;
    if (!model) continue;
    return typeof d.effort === 'string' && d.effort ? { model, effort: d.effort } : { model };
  }
  return {};
}

export function subagentEvents(text: string, ctx: NormalizerContext): TranscriptEvent[] {
  const norm = new ClaudeNormalizer(ctx);
  const out: TranscriptEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d: AnyMsg;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // a line the CLI is still writing
    }
    if ((d.type !== 'user' && d.type !== 'assistant') || !d.message || d.isMeta) continue;
    const ts = typeof d.timestamp === 'string' ? d.timestamp : undefined;
    if (d.type === 'user') {
      // Its brief, and anything else said to it, are plain user turns; tool
      // results go through the normaliser like a thread's.
      const text = promptText(d.message.content);
      if (text) {
        ctx.beginTurn?.();
        out.push({ ts, body: { type: 'user.message', text, images: [] } });
        continue;
      }
    }
    // The transcript calls the result's details toolUseResult; the SDK's
    // messages call them tool_use_result.
    const msg: AnyMsg = { type: d.type, uuid: d.uuid, message: d.message };
    if (d.toolUseResult !== undefined) msg.tool_use_result = d.toolUseResult;
    for (const o of norm.handle(msg)) if (o.kind === 'event') out.push({ ts, body: o.event });
  }
  return out;
}

// The text of a user message that isn't tool results.
function promptText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((c: AnyMsg) => c?.type === 'tool_result')) return '';
  return (content as AnyMsg[])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}
