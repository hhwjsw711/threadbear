import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileContext } from '../../src/adapters/context.ts';
import { ClaudeNormalizer } from '../../src/adapters/claude/normalize.ts';
import { CodexNormalizer } from '../../src/adapters/codex/normalize.ts';
import { makePng } from '../helpers/png.ts';
import { tmpDir } from '../helpers/fakes.ts';

const png = makePng(2, 2).toString('base64');
const size = Buffer.from(png, 'base64').length;
const limits = { imageBytes: size, turnBytes: size, turnFiles: 1, threadBytes: size * 3, threadFiles: 3 };
const claudeImage = (data: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] } });
const items = [
  { type: 'mcpToolCall', server: 'test', tool: 'image', result: { content: [{ type: 'image', data: png, mimeType: 'image/png' }] } },
  { type: 'mcpToolCall', server: 'test', tool: 'resource', result: { content: [{ type: 'resource', resource: { blob: png, mimeType: 'image/png' } }] } },
  { type: 'dynamicToolCall', tool: 'image', contentItems: [{ type: 'inputImage', imageUrl: `data:image/png;base64,${png}` }], success: true },
  { type: 'imageGeneration', result: png },
];

test('Claude images count per turn and storage persists after a session restarts', () => {
  const dir = tmpDir();
  const media = path.join(dir, 'media');
  const n = new ClaudeNormalizer(fileContext(dir, media, path.join(dir, 'blobs'), limits));
  const init = () => n.handle({ type: 'system', subtype: 'init', session_id: 'session' });
  init();
  n.handle(claudeImage(png));
  const refused = n.handle(claudeImage(png));
  assert.match(JSON.stringify(refused), /image could not be saved/);
  n.handle({ type: 'result', subtype: 'success', duration_ms: 1 });
  init();
  const next = n.handle(claudeImage(png));
  assert.doesNotMatch(JSON.stringify(next), /image could not be saved/);
  assert.equal(fs.readdirSync(media).length, 1, 'repeated image uses the same file');
});

for (const item of items) {
  test(`Codex ${item.type}: rejects oversized images and counts accepted results per turn`, () => {
    const dir = tmpDir();
    const media = path.join(dir, 'media');
    const n = new CodexNormalizer(fileContext(dir, media, path.join(dir, 'blobs'), limits));
    n.setThread('th');
    const start = (id: string) => n.handle('turn/started', { threadId: 'th', turn: { id } });
    const send = (id: string) => n.handle('item/completed', { threadId: 'th', item: { id, status: 'completed', ...item } });
    start('first');
    const first = send('a');
    assert.ok(first.some((x) => x.kind === 'event' && x.event.type === 'tool.result' && x.event.images.length === 1));
    start('first');
    const denied = send('b');
    assert.ok(!denied.some((x) => x.kind === 'event' && x.event.type === 'tool.result' && x.event.images.length));
    start('next');
    assert.ok(send('c').some((x) => x.kind === 'event' && x.event.type === 'tool.result' && x.event.images.length === 1));
    assert.equal(fs.readdirSync(media).length, 1);
    const oversized = JSON.parse(JSON.stringify(item).replaceAll(png, Buffer.concat([makePng(2, 2), Buffer.from('more')]).toString('base64')));
    const out = n.handle('item/completed', { threadId: 'th', item: { id: 'large', status: 'completed', ...oversized } });
    assert.ok(!out.some((x) => x.kind === 'event' && x.event.type === 'tool.result' && x.event.images.length));
    assert.equal(fs.readdirSync(media).length, 1);
  });
}
