import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the public repo does not send forks to the owner\'s production backend', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const out = spawnSync('git', ['grep', '--untracked', '-nI', '-E', 'opulent-moose-[0-9]+|my[.]threadbear[.]mikecann[.]app', '--', '.'], { cwd: root, encoding: 'utf8' });
  assert.ifError(out.error);
  assert.equal(out.status, 1, `Use example deployment names and configurable URLs:\n${out.stdout}${out.stderr}`);
});
