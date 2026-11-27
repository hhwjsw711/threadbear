// runner/scripts/deploy-backend.mjs on a Mac with a runner key: only the
// main Mac's runner deploys the backend, even with a deploy key left over
// from an older setup (docs/protocol/keys.md, "Runner keys").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { IS_WINDOWS } from '../helpers/platform.ts';

test("a Mac with a runner key doesn't deploy the backend, deploy key or not", () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, 'secrets', 'convex-key'), 'tbr_mine\n');
  fs.writeFileSync(path.join(home, 'secrets', 'convex-deploy.env'), 'CONVEX_DEPLOY_KEY=prod:demo-bear-123|x\n');
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ sync: { url: 'https://demo-bear-123.ap-southeast-2.convex.cloud' } }));
  const repo = path.resolve(import.meta.dirname, '../../..');
  const r = spawnSync(process.execPath, [path.join(repo, 'runner/scripts/deploy-backend.mjs'), '--home', home, '--repo', repo], { encoding: 'utf8', env: { ...process.env, ...(IS_WINDOWS ? {} : { PATH: '/usr/bin:/bin' }) } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /runner key of its own/);
  assert.equal(fs.existsSync(path.join(home, 'backend.json')), false, 'nothing deployed');
});

test('non-deploying hosts ignore invalid website settings during updates', () => {
  const repo = path.resolve(import.meta.dirname, '../../..');
  for (const runnerKey of [true, false]) {
    for (const inherited of [true, false]) {
      const home = tmpDir();
      if (runnerKey) {
        fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
        fs.writeFileSync(path.join(home, 'secrets', 'convex-key'), 'tbr_mine\n');
        fs.writeFileSync(path.join(home, 'secrets', 'convex-deploy.env'), 'CONVEX_DEPLOY_KEY=prod:demo-bear-123|x\n');
      }
      fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ sync: { url: 'https://demo-bear-123.convex.cloud', ...(!inherited ? { site: 'javascript:bad' } : {}) } }));
      const r = spawnSync(process.execPath, [path.join(repo, 'runner/scripts/deploy-backend.mjs'), '--home', home, '--repo', repo], { encoding: 'utf8', env: { ...process.env, VITE_CONVEX_SITE_URL: inherited ? 'javascript:bad' : undefined, ...(IS_WINDOWS ? {} : { PATH: '/usr/bin:/bin' }) } });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, runnerKey ? /runner key of its own/ : /No deploy key/);
      assert.doesNotMatch(r.stderr, /Website address|Error:|Node\.js/);
      assert.equal(fs.existsSync(path.join(home, 'backend.json')), false, 'nothing deployed');
    }
  }
});
