import assert from 'node:assert/strict';
import path from 'node:path';
import { AcpAdapter } from '../../src/adapters/acp/adapter.ts';
import { ACP_AGENTS } from '../../src/adapters/acp/agents.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { nullLogger } from '../../src/log.ts';
import type { AdapterOutput, SessionSink } from '../../src/adapters/types.ts';
import { tmpDir } from '../helpers/fakes.ts';
import { makePng } from '../helpers/png.ts';
import { patiently } from '../helpers/patience.ts';
import { testSkippedOnWindows } from '../helpers/platform.ts';

const test = testSkippedOnWindows('The pretend ACP agent is a #! script');

test('ACP renews its image allowance at each real prompt, not per session', async () => {
  const root = tmpDir();
  const outputs: AdapterOutput[] = [];
  let completed: (() => void) | undefined;
  const sink: SessionSink = {
    output(out) { outputs.push(out); if (out.kind === 'result') completed?.(); },
    requestApproval: async () => ({ decision: 'deny' }),
    requestQuestion: async () => ({ answers: {} }),
    exited: () => {},
  };
  const adapter = new AcpAdapter({ agent: ACP_AGENTS.opencode, binary: () => path.join(import.meta.dirname, '../helpers/fake-acp-agent.mjs'), registry: new ProcessRegistry(path.join(root, 'run'), nullLogger), log: nullLogger, env: { PATH: process.env.PATH }, timings: { closeWaitMs: 200 } });
  const session = adapter.start({ threadId: 't', cwd: root, account: { id: 'opencode-main', provider: 'opencode', title: 'test', configDir: root }, permissionMode: 'full', sessionId: 'unused', resume: false, mediaDir: path.join(root, 'media'), blobsDir: path.join(root, 'blobs'), tmpDir: root }, sink);
  try {
    await patiently(() => outputs.some((x) => x.kind === 'session'));
    for (const id of ['a', 'b']) {
      const before = outputs.length;
      const done = new Promise<void>((resolve) => { completed = resolve; });
      session.send({ id, text: `images 33 ${makePng(1, 1).toString('base64')}`, images: [] });
      await done;
      const results = outputs.slice(before).flatMap((x) => x.kind === 'event' && x.event.type === 'tool.result' ? [x.event] : []);
      assert.equal(results.length, 33);
      assert.equal(results.reduce((n, x) => n + x.images.length, 0), 33);
    }
  } finally { await session.end({ hard: true }); }
});
