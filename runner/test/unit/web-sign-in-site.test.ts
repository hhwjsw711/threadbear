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
    fs.symlinkSync(path.join(root, 'runner'), path.join(dir, 'runner'), 'dir');
    fs.writeFileSync(path.join(dir, 'runner.json'), JSON.stringify({ sync: { url: 'https://demo-bear-123.convex.cloud', site: 'https://threads.example.com/' } }));
    fs.writeFileSync(path.join(dir, '.env.local'), 'CONVEX_URL=https://dev-bear-456.convex.cloud\n');
    const file = path.join(scripts, 'sign-in.swift');
    const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'runner/test/fixtures/website-urls.json'), 'utf8')) as { expected: string | null }[];
    const cases = path.join(dir, 'cases.json');
    fs.writeFileSync(cases, JSON.stringify(fixtures));
    fs.writeFileSync(file, source.slice(0, source.indexOf('let args =')) + `
print(prodURL ?? "missing")
print(devURL ?? "missing")
print(siteOf("https://demo-bear-123.convex.cloud/") ?? "missing")
let cases = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: ${JSON.stringify(cases)}))) as! [[String: Any]]
let results: [Any] = cases.map { siteOf($0["cloud"] as? String, site: $0["site"]) as Any? ?? NSNull() }
print(String(decoding: try! JSONSerialization.data(withJSONObject: results), as: UTF8.self))
`);
    const out = spawnSync('swift', [file], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, THREADBEAR_HOME: dir } });
    assert.equal(out.status, 0, out.stderr);
    const lines = out.stdout.trim().split('\n');
    assert.deepEqual(lines.slice(0, 3), ['https://threads.example.com', 'https://dev-bear-456.convex.site', 'https://demo-bear-123.convex.site']);
    assert.deepEqual(JSON.parse(lines[3]), fixtures.map((c) => c.expected));
    // Exercise the actual guard before code issuance, with a poisoned config.
    fs.writeFileSync(path.join(dir, 'runner.json'), JSON.stringify({ sync: { url: 'https://demo-bear-123.convex.cloud', site: 'https://exa mple.com' } }));
    fs.writeFileSync(file, source.slice(0, source.indexOf('var issue =')) + '\nfatalError("reached code issuance")\n');
    const refused = spawnSync('swift', [file], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, THREADBEAR_HOME: dir } });
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /website address/);
    assert.doesNotMatch(refused.stderr, /reached code issuance/);
    // Node may exit before processing the config (missing runtime/module).
    // A large setting must still fail normally rather than die on SIGPIPE.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'runner.json'), JSON.stringify({ sync: { site: 'https://site.example.com/' + 'x'.repeat(70_000) } }));
    const exited = spawnSync('swift', [file], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, THREADBEAR_HOME: dir, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.equal(exited.status, 1, exited.stderr);
    assert.equal(exited.signal, null);
    assert.match(exited.stderr, /website address/);
    assert.doesNotMatch(exited.stderr, /reached code issuance/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
