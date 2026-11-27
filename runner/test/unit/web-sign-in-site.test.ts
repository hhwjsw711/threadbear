import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run the script's configuration-reading prefix, stopping before it issues a
// sign-in code or opens a browser. The fixture has a cloud API and a custom site.
test('web sign-in uses sync.site, with the cloud twin as its fallback', { skip: process.platform !== 'darwin' }, () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const source = fs.readFileSync(path.join(root, 'web/scripts/sign-in.swift'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-web-sign-in-'));
  try {
    const scripts = path.join(dir, 'web/scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runner.json'), JSON.stringify({ sync: { url: 'https://demo-bear-123.convex.cloud', site: 'https://threads.example.com/' } }));
    fs.writeFileSync(path.join(dir, '.env.local'), 'CONVEX_URL=https://dev-bear-456.convex.cloud\n');
    const file = path.join(scripts, 'sign-in.swift');
    fs.writeFileSync(file, source.slice(0, source.indexOf('let args =')) + '\nprint(prodURL ?? "missing")\nprint(devURL ?? "missing")\nprint(siteOf("https://demo-bear-123.convex.cloud/") ?? "missing")\n');
    const out = spawnSync('swift', [file], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, THREADBEAR_HOME: dir } });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.stdout.trim().split('\n'), ['https://threads.example.com', 'https://dev-bear-456.convex.site', 'https://demo-bear-123.convex.site']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
