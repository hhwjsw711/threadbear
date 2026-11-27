// session/update frames as OpenCode 1.18.23 really sent them (9 Nov 2026),
// paths shortened, through the normaliser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpNormalizer, canonicalToolName } from '../../src/adapters/acp/normalize.ts';
import type { NormalizerContext } from '../../src/adapters/context.ts';

const ctx: NormalizerContext = {
  cwd: '/w',
  readFile: () => null,
  saveImage: (_d, mediaType) => ({ path: '/m/x.png', mediaType }),
  saveBlob: () => '/b',
  copyBlob: () => null,
};
const kinds = (out: { kind: string; event?: { type: string } }[]) => out.map((o) => (o.kind === 'event' ? o.event!.type : o.kind));

test('the words stream as deltas and end as one message', () => {
  const n = new AcpNormalizer(ctx);
  const a = n.handle({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: 'po' } });
  const b = n.handle({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text: 'ng' } });
  assert.deepEqual(kinds([...a, ...b]), ['delta', 'delta']);
  const end = n.flush();
  assert.deepEqual(kinds(end), ['assistant.text']);
  assert.equal((end[0] as { event: { text: string } }).event.text, 'pong');
  assert.equal(n.takeLastAssistantText(), 'pong');
});

test('a new messageId starts a new message', () => {
  const n = new AcpNormalizer(ctx);
  n.handle({ sessionUpdate: 'agent_message_chunk', messageId: 'a', content: { type: 'text', text: 'one' } });
  const out = n.handle({ sessionUpdate: 'agent_message_chunk', messageId: 'b', content: { type: 'text', text: 'two' } });
  assert.deepEqual(kinds(out), ['assistant.text', 'delta']);
});

test('thinking ends when the words begin', () => {
  const n = new AcpNormalizer(ctx);
  n.handle({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
  const out = n.handle({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
  assert.deepEqual(kinds(out), ['reasoning', 'delta']);
});

const pending = { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'write', kind: 'edit', status: 'pending', locations: [], rawInput: {} };
const running = { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress', kind: 'edit', title: 'write', locations: [{ path: '/w/a.txt' }], rawInput: { filePath: '/w/a.txt', content: 'hi' } };

test('a call that opens empty waits for its input, then one row', () => {
  const n = new AcpNormalizer(ctx);
  assert.deepEqual(n.handle(pending), []);
  const out = n.handle(running);
  assert.deepEqual(kinds(out), ['tool.call']);
  const call = (out[0] as { event: { title: string; kind: string; input: unknown } }).event;
  assert.equal(call.title, 'Edit a.txt');
  assert.equal(call.kind, 'edit');
  assert.deepEqual(n.handle({ ...running, status: 'in_progress' }), [], 'and only one row');
});

test('a permission request brings the row and the preview once a card is put up, not before', () => {
  const n = new AcpNormalizer(ctx);
  n.handle(pending);
  const seen = n.noteCall({ toolCallId: 'c1', title: '/w/a.txt', kind: 'edit', status: 'pending', locations: [{ path: '/w/a.txt' }], rawInput: { filepath: '/w/a.txt', diff: 'x' }, content: [{ type: 'diff', path: '/w/a.txt', oldText: '', newText: 'hi' }] });
  assert.deepEqual(seen.paths, ['/w/a.txt']);
  assert.equal(seen.kind, 'edit');
  assert.deepEqual(kinds(n.closeOpen('Stopped')), [], 'allowed without a card and never run: no row to leave failed');
  assert.deepEqual(kinds(n.showCall(seen.id)), ['tool.call', 'edit.diff']);
  assert.deepEqual(kinds(n.showCall(seen.id)), [], 'and only one');
});

test('a call run under another id than its request takes over the request\'s row only when it plainly is that call', () => {
  const n = new AcpNormalizer(ctx, { movesAskedCalls: true });
  const seen = n.noteCall({ toolCallId: 'ask1', title: 'Run create_file?', kind: 'edit', rawInput: { TargetFile: '/w/a.js', CodeContent: 'hi' }, content: [{ type: 'diff', path: '/w/a.js', oldText: null, newText: 'hi' }] });
  // Not yet answered, then refused: another call on the file is its own row.
  assert.equal((n.handle({ sessionUpdate: 'tool_call', toolCallId: 's:0', kind: 'edit', status: 'in_progress', rawInput: { file_path: '/w/a.js' } })[0] as { event: { itemId: string } }).event.itemId, 's:0', 'not while its card waits');
  const refused = n.noteCall({ toolCallId: 'ask0', kind: 'edit', rawInput: { TargetFile: '/w/a.js' } });
  n.answered(refused.id, false);
  assert.equal((n.handle({ sessionUpdate: 'tool_call', toolCallId: 's:00', kind: 'edit', status: 'in_progress', rawInput: { file_path: '/w/a.js' } })[0] as { event: { itemId: string } }).event.itemId, 's:00', 'nor once refused');
  n.answered(seen.id, true);
  // Another file, or a relative path, is another call.
  assert.deepEqual(kinds(n.handle({ sessionUpdate: 'tool_call', toolCallId: 's:1', kind: 'edit', status: 'in_progress', rawInput: { file_path: '/w/b.js' } })), ['tool.call']);
  assert.deepEqual(kinds(n.handle({ sessionUpdate: 'tool_call', toolCallId: 's:2', kind: 'edit', status: 'in_progress', rawInput: { file_path: 'a.js' } })), ['tool.call']);
  const run = n.handle({ sessionUpdate: 'tool_call', toolCallId: 's:3', kind: 'edit', status: 'in_progress', rawInput: { file_path: '/w/a.js' } });
  assert.deepEqual(kinds(run), ['tool.call', 'edit.diff']);
  assert.equal((run[0] as { event: { itemId: string } }).event.itemId, seen.id);
  // What the new call says stays its own, for the permission checks.
  assert.deepEqual(n.noteCall({ toolCallId: 's:3', kind: 'edit', rawInput: { file_path: '/w/a.js' } }).input, { file_path: '/w/a.js' });
  const end = n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 's:3', status: 'completed' });
  assert.deepEqual(end.map((o) => (o as { event: { itemId: string; ok: boolean } }).event).map((e) => [e.itemId, e.ok]), [[seen.id, true]]);
  // A new file's text with a patch-like line in it still matches by its file.
  const n3 = new AcpNormalizer(ctx, { movesAskedCalls: true });
  n3.noteCall({ toolCallId: 'ask3', kind: 'edit', rawInput: { TargetFile: '/w/doc.md', CodeContent: 'title\n--- section\nbody' }, content: [{ type: 'diff', path: '/w/doc.md', oldText: null, newText: 'title\n--- section\nbody' }] });
  n3.answered('ask3', true);
  assert.equal((n3.handle({ sessionUpdate: 'tool_call', toolCallId: 's:5', kind: 'edit', status: 'in_progress', rawInput: { file_path: '/w/doc.md' } })[0] as { event: { itemId: string } }).event.itemId, 'ask3');
  // A call whose first frame names no file is matched once one does, and a
  // card it asks for later names the row it shows on.
  const n4 = new AcpNormalizer(ctx, { movesAskedCalls: true });
  n4.noteCall({ toolCallId: 'ask4', kind: 'edit', rawInput: { TargetFile: '/w/b.js' } });
  n4.answered('ask4', true);
  assert.deepEqual(n4.handle({ sessionUpdate: 'tool_call', toolCallId: 's:6', kind: 'edit', status: 'pending', rawInput: {} }), []);
  assert.equal((n4.handle({ sessionUpdate: 'tool_call_update', toolCallId: 's:6', status: 'in_progress', rawInput: { file_path: '/w/b.js' } })[0] as { event: { itemId: string } }).event.itemId, 'ask4');
  assert.equal(n4.noteCall({ toolCallId: 's:6', kind: 'edit', rawInput: { file_path: '/w/b.js' } }).row, 'ask4');
  // One allowed without a card that never ran is gone at the turn's end.
  const n2 = new AcpNormalizer(ctx, { movesAskedCalls: true });
  n2.noteCall({ toolCallId: 'ask2', kind: 'edit', rawInput: { TargetFile: '/w/a.js' } });
  n2.answered('ask2', true);
  n2.closeOpen('Stopped');
  assert.equal((n2.handle({ sessionUpdate: 'tool_call', toolCallId: 's:9', kind: 'edit', status: 'in_progress', rawInput: { file_path: '/w/a.js' } })[0] as { event: { itemId: string } }).event.itemId, 's:9', 'a later turn\'s edit is its own row');
  // Taken once: a second call on the same file is a row of its own.
  assert.equal((n.handle({ sessionUpdate: 'tool_call', toolCallId: 's:4', kind: 'edit', status: 'in_progress', rawInput: { file_path: '/w/a.js' } })[0] as { event: { itemId: string } }).event.itemId, 's:4');
});

test('a rejected call fails with what was said', () => {
  const n = new AcpNormalizer(ctx);
  n.handle(pending);
  n.handle(running);
  const out = n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed', kind: 'edit', content: [{ type: 'content', content: { type: 'text', text: 'The user rejected permission to use this specific tool call.' } }], rawOutput: { error: 'x' } });
  assert.deepEqual(kinds(out), ['tool.result']);
  assert.equal((out[0] as { event: { ok: boolean; text: string } }).event.ok, false);
  assert.match((out[0] as { event: { text: string } }).event.text, /rejected/);
});

for (const status of [undefined, 'failed']) {
  test(`an earlier edit approval matches paths split across running frames when the last status is ${status}`, () => {
    const n = new AcpNormalizer(ctx, { movesAskedCalls: true });
    const locations = [{ path: '/w/a.txt' }, { path: '/w/b.txt' }];
    n.noteCall({ toolCallId: 'before', kind: 'edit', locations });
    n.answered('before', true);
    const earlier = new Set(['before']);
    n.handle({ sessionUpdate: 'tool_call', toolCallId: 'old-work', kind: 'edit', status: 'in_progress', locations: locations.slice(0, 1) });
    n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'old-work', status, locations: locations.slice(1) });
    assert.equal(n.isNewToolWork('old-work', earlier), false);
    n.handle({ sessionUpdate: 'tool_call', toolCallId: 'new-work', kind: 'edit', status: 'in_progress', locations });
    assert.equal(n.isNewToolWork('new-work', earlier), true);
  });
}

test('an edit on two files does not consume an earlier approval for one file', () => {
  const n = new AcpNormalizer(ctx, { movesAskedCalls: true });
  n.noteCall({ toolCallId: 'before', kind: 'edit', locations: [{ path: '/w/a.txt' }] });
  n.answered('before', true);
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'new-work', kind: 'edit', status: 'in_progress', locations: [{ path: '/w/b.txt' }] });
  n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'new-work', status: 'completed', locations: [{ path: '/w/a.txt' }] });
  assert.equal(n.isNewToolWork('new-work', new Set(['before'])), true);
});

test('an edit that reports only part of an earlier approval can still be old work', () => {
  const n = new AcpNormalizer(ctx, { movesAskedCalls: true });
  n.noteCall({ toolCallId: 'before', kind: 'edit', locations: [{ path: '/w/a.txt' }, { path: '/w/b.txt' }] });
  n.answered('before', true);
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'old-work', kind: 'edit', status: 'in_progress', locations: [{ path: '/w/a.txt' }] });
  n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'old-work', status: 'failed' });
  assert.equal(n.isNewToolWork('old-work', new Set(['before'])), false);
});

test('an absolute location can identify an approval after a relative input path', () => {
  const n = new AcpNormalizer(ctx, { movesAskedCalls: true });
  const locations = [{ path: '/w/a.txt' }];
  n.noteCall({ toolCallId: 'before', kind: 'edit', locations });
  n.answered('before', true);
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'old-work', kind: 'edit', rawInput: { file_path: 'a.txt' } });
  n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'old-work', status: 'completed', locations });
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'new-work', kind: 'edit', status: 'in_progress', locations });
  assert.equal(n.isNewToolWork('old-work', new Set(['before'])), false);
  assert.equal(n.isNewToolWork('new-work', new Set(['before'])), true);
});

test('a tool linked to a new approval can show recovery despite an unrelated old approval', () => {
  const n = new AcpNormalizer(ctx, { movesAskedCalls: true });
  n.noteCall({ toolCallId: 'before', kind: 'edit', locations: [{ path: '/w/a.txt' }] });
  n.answered('before', true);
  const locations = [{ path: '/w/b.txt' }];
  n.noteCall({ toolCallId: 'after', kind: 'edit', locations });
  n.answered('after', true);
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'new-work', kind: 'edit', status: 'in_progress', locations });
  assert.equal(n.isNewToolWork('new-work', new Set(['before'])), true);
});

test('output only in rawOutput still shows', () => {
  const n = new AcpNormalizer(ctx);
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls' } });
  const out = n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'completed', rawOutput: { output: 'a b' } });
  assert.equal((out[0] as { event: { text: string } }).event.text, 'a b');

  // Antigravity sends a plain string rawOutput on failed MCP calls (e.g. end_turn refusals).
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'c2s', title: 'threadbear_end_turn', status: 'in_progress', rawInput: { needs: 'nothing' } });
  const strOut = n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'c2s', status: 'failed', rawOutput: 'Not ended: please write your reply first.' });
  assert.equal((strOut[0] as { event: { ok: boolean; text: string } }).event.ok, false);
  assert.equal((strOut[0] as { event: { text: string } }).event.text, 'Not ended: please write your reply first.');

  // Array rawOutput and object rawOutput.content / message.
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'c2a', title: 'bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo hi' } });
  const arrOut = n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'c2a', status: 'completed', rawOutput: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] });
  assert.equal((arrOut[0] as { event: { text: string } }).event.text, 'first\nsecond');

  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'c2m', title: 'bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'false' } });
  const msgOut = n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'c2m', status: 'failed', rawOutput: { message: 'boom' } });
  assert.equal((msgOut[0] as { event: { text: string } }).event.text, 'boom');

  // Direct text blocks in content (without an outer { type: 'content' } wrapper).
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'c2d', title: 'bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo ok' } });
  const directOut = n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'c2d', status: 'completed', content: [{ type: 'text', text: 'direct text' }] });
  assert.equal((directOut[0] as { event: { text: string } }).event.text, 'direct text');
});

test('whatever is open closes when the agent goes', () => {
  const n = new AcpNormalizer(ctx);
  n.handle(pending);
  n.handle(running);
  const out = n.closeOpen('Interrupted');
  assert.deepEqual(kinds(out), ['tool.result']);
  assert.deepEqual(n.closeOpen('Interrupted'), [], 'once');
});

test('the threadbear tools read as they do on the other providers', () => {
  assert.equal(canonicalToolName('threadbear_end_turn'), 'mcp__threadbear__end_turn');
  assert.equal(canonicalToolName('bash'), 'bash');
  const n = new AcpNormalizer(ctx);
  const out = n.handle({ sessionUpdate: 'tool_call', toolCallId: 'c3', title: 'threadbear_end_turn', status: 'in_progress', rawInput: { summary: 'x' } });
  const call = (out[0] as { event: { name: string; kind: string } }).event;
  assert.equal(call.name, 'mcp__threadbear__end_turn');
  assert.equal(call.kind, 'mcp');
});

test('the plan, and what it does not know about', () => {
  const n = new AcpNormalizer(ctx);
  const plan = n.handle({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed', priority: 'high' }, { content: 'b', status: 'weird' }] });
  assert.deepEqual((plan[0] as { event: { entries: unknown } }).event.entries, [{ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' }]);
  assert.deepEqual(n.handle({ sessionUpdate: 'something_new', x: 1 }), []);
  assert.deepEqual(n.handle('not an object'), []);
});

// Grok's frames for end_turn through use_tool, as Grok sent them
// (16 Nov 2026, review thread 53cd067b): named only in the second frame,
// the result as an object.
test("a tool called through Grok's use_tool is that tool, with its own input and result", () => {
  const n = new AcpNormalizer(ctx);
  const input = { headline: 'h', needs: 'nothing', findings: [] };
  const meta = { 'x.ai/tool': { name: 'use_tool', kind: 'use_tool' } };
  const call = n.handle({ sessionUpdate: 'tool_call', toolCallId: 'g1', title: 'use_tool', rawInput: { tool_name: 'threadbear__end_turn', tool_input: input }, _meta: meta });
  assert.deepEqual(kinds(call), ['tool.call']);
  const ev = (call[0] as { event: { name: string; kind: string; input: unknown } }).event;
  assert.equal(ev.name, 'mcp__threadbear__end_turn');
  assert.equal(ev.kind, 'mcp');
  assert.deepEqual(ev.input, input);
  assert.deepEqual(n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'g1', kind: 'other', title: 'threadbear__end_turn', rawInput: { variant: 'UseTool', tool_name: 'threadbear__end_turn', tool_input: input } }), []);
  const out = n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'g1', status: 'completed', rawOutput: { type: 'MCP', tool_name: 'end_turn', server_name: 'threadbear', output: { OkayOutput: 'Noted: this thread is done.' } } });
  const res = (out[0] as { event: { ok: boolean; text: string } }).event;
  assert.equal(res.ok, true);
  assert.equal(res.text, 'Noted: this thread is done.');
});

test('a tool_name in some other call is not taken as the tool it names', () => {
  const n = new AcpNormalizer(ctx);
  const out = n.handle({ sessionUpdate: 'tool_call', toolCallId: 'g2', title: 'run_terminal_command', kind: 'execute', rawInput: { command: 'ls', tool_name: 'threadbear__end_turn', tool_input: {} } });
  assert.equal((out[0] as { event: { name: string } }).event.name, 'run_terminal_command');
});

test("another tool's arguments can't pass for a call through use_tool, Grok's variant included", () => {
  const n = new AcpNormalizer(ctx);
  const raw = { variant: 'UseTool', tool_name: 'threadbear__end_turn', tool_input: { needs: 'nothing', archive: true } };
  const out = n.handle({ sessionUpdate: 'tool_call', toolCallId: 'g3', title: 'mcp__echo__echo', rawInput: raw });
  assert.equal((out[0] as { event: { name: string } }).event.name, 'mcp__echo__echo');
  // Nor a later frame retitling it use_tool once its row is out.
  n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'g3', title: 'use_tool', rawInput: raw });
  const res = n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'g3', status: 'completed', rawOutput: { output: 'x' } });
  assert.deepEqual(kinds(res), ['tool.result']);
});

test("a use_tool call whose arguments stream in after it starts is still the tool it names", () => {
  const n = new AcpNormalizer(ctx);
  assert.deepEqual(n.handle({ sessionUpdate: 'tool_call', toolCallId: 'g4', title: 'use_tool', status: 'in_progress', rawInput: {} }), []);
  const out = n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'g4', rawInput: { tool_name: 'threadbear__end_turn', tool_input: { needs: 'nothing' } } });
  const ev = (out[0] as { event: { name: string; input: unknown } }).event;
  assert.equal(ev.name, 'mcp__threadbear__end_turn');
  assert.deepEqual(ev.input, { needs: 'nothing' });
});

test("Antigravity's create_file, frame by frame as 1.4.5 sends it: one row, which succeeds", () => {
  const n = new AcpNormalizer(ctx, { movesAskedCalls: true });
  const f = '/w/hello.txt';
  const proposed = { toolCallId: 'hex1', title: 'Run create_file?', kind: 'edit', status: 'pending', content: [{ path: f, newText: 'hi\n', type: 'diff' }], locations: [{ path: f }], rawInput: { CodeContent: 'hi\n', Overwrite: true, TargetFile: f } };
  const out = [...n.handle({ sessionUpdate: 'tool_call', ...proposed })];
  const seen = n.noteCall(proposed);
  n.answered(seen.id, true);
  out.push(...n.handle({ sessionUpdate: 'tool_call', toolCallId: 'sess:1', title: 'Running edit_file', kind: 'edit', status: 'in_progress', locations: [{ path: f }], rawInput: { file_path: f } }));
  out.push(...n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'sess:1', status: 'completed', rawOutput: 'Create hello.txt file' }));
  out.push(...n.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'hex1', status: 'failed', rawOutput: 'Tool call was approved but never executed.' }));
  out.push(...n.closeOpen('Stopped'));
  const evs = out.map((o) => (o as { event: { type: string; itemId: string; ok?: boolean } }).event);
  assert.deepEqual(evs.filter((e) => e.type === 'tool.call').map((e) => e.itemId), ['hex1']);
  assert.deepEqual(evs.filter((e) => e.type === 'tool.result').map((e) => [e.itemId, e.ok]), [['hex1', true]]);
});

test('a proposed call never takes an allowed request\'s row, and an agent that keeps its ids never has one taken', () => {
  const f = '/w/a.txt';
  const go = (n: AcpNormalizer) => {
    n.handle({ sessionUpdate: 'tool_call', toolCallId: 'A', kind: 'edit', status: 'pending', locations: [{ path: f }], rawInput: { TargetFile: f, CodeContent: 'one' } });
    n.answered(n.noteCall({ toolCallId: 'A', kind: 'edit', locations: [{ path: f }], rawInput: { TargetFile: f, CodeContent: 'one' } }).id, true);
  };
  const n = new AcpNormalizer(ctx, { movesAskedCalls: true });
  go(n);
  const b = n.handle({ sessionUpdate: 'tool_call', toolCallId: 'B', kind: 'edit', status: 'pending', locations: [{ path: f }], rawInput: { TargetFile: f, CodeContent: 'two' } });
  assert.equal((b.find((o) => (o as { event: { type: string } }).event.type === 'tool.call') as { event: { itemId: string } }).event.itemId, 'B');
  const other = new AcpNormalizer(ctx);
  go(other);
  const c = other.handle({ sessionUpdate: 'tool_call', toolCallId: 'C', kind: 'edit', status: 'in_progress', locations: [{ path: f }], rawInput: { file_path: f } });
  assert.equal((c.find((o) => (o as { event: { type: string } }).event.type === 'tool.call') as { event: { itemId: string } }).event.itemId, 'C');
});

test('OpenCode background shell metadata is attached on tool.result and cleared on ended status', () => {
  const n = new AcpNormalizer(ctx);
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'sh1', kind: 'execute', title: 'bash', rawInput: { command: 'npm run build', description: 'Run full build' }, status: 'in_progress' });
  const running = n.handle({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'sh1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'Command moved to the background (shell ID: sh_abc123).\nPID: 42424\nOutput is streaming to: /tmp/sh_abc123.out' } }],
    rawOutput: { metadata: { shellID: 'sh_abc123', status: 'running', pid: 42424, truncated: false } },
  });
  const res = running.find((o) => o.kind === 'event' && o.event.type === 'tool.result');
  assert.ok(res);
  assert.deepEqual(res.backgroundShell, { id: 'sh_abc123', status: 'running', pid: 42424, description: 'Run full build' });

  // Later tool result reporting the same shellID as exited/killed emits status ended.
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'sh1-stop', kind: 'execute', title: 'bash', rawInput: { command: 'stop' }, status: 'in_progress' });
  const stopped = n.handle({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'sh1-stop',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'Cancelled' } }],
    rawOutput: { metadata: { shellID: 'sh_abc123', status: 'killed' } },
  });
  const stopRes = stopped.find((o) => o.kind === 'event' && o.event.type === 'tool.result');
  assert.ok(stopRes);
  assert.deepEqual(stopRes.backgroundShell, { id: 'sh_abc123', status: 'ended' });
});

test('background shell detection requires structured execute metadata and ignores plain stdout or non-execute tools', () => {
  const n = new AcpNormalizer(ctx);
  const banner = 'Command moved to the background (shell ID: sh_txt1).\nPID: 51515\nOutput is streaming to: /tmp/sh_txt1.out';

  // Plain execute stdout matching the banner without rawOutput metadata must not register a shell.
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'execute', rawInput: { command: 'echo banner' }, status: 'in_progress' });
  const plainOut = n.handle({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: banner } }],
  });
  const plainRes = plainOut.find((o) => o.kind === 'event' && o.event.type === 'tool.result');
  assert.ok(plainRes);
  assert.equal(plainRes.backgroundShell, undefined);

  // Non-execute tools (e.g. file read) must not register running shells even with matching metadata.
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'c2', kind: 'read', rawInput: { filePath: '/tmp/log.txt' }, status: 'in_progress' });
  const readOut = n.handle({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c2',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: banner } }],
    rawOutput: { metadata: { shellID: 'sh_read1', status: 'running', pid: 51515 } },
  });
  const readRes = readOut.find((o) => o.kind === 'event' && o.event.type === 'tool.result');
  assert.ok(readRes);
  assert.equal(readRes.backgroundShell, undefined);

  // An execute call with exited metadata reports ended, not running.
  n.handle({ sessionUpdate: 'tool_call', toolCallId: 'c3', kind: 'execute', rawInput: { command: 'echo banner' }, status: 'in_progress' });
  const exitedOut = n.handle({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c3',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: banner } }],
    rawOutput: { metadata: { shellID: 'sh_exited', status: 'exited', pid: 51515 } },
  });
  const exitedRes = exitedOut.find((o) => o.kind === 'event' && o.event.type === 'tool.result');
  assert.ok(exitedRes);
  assert.deepEqual(exitedRes.backgroundShell, { id: 'sh_exited', status: 'ended' });
});
