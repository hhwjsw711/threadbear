// runner/scripts/deploy-backend.mjs with a self-hosted backend
// (docs/self-hosting.md): it deploys with the admin URL and key rather than
// a deploy key, and won't guess when both kinds of credential are here.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { testSkippedOnWindows } from '../helpers/platform.ts';

// deploy-backend.mjs deploys Mike's own Convex backend with a PATH of /usr/bin:/bin and the Mac's tools, and is not ported to Windows.
const test = testSkippedOnWindows("deploy-backend.mjs deploys Mike's own Convex backend from a Mac (its PATH is /usr/bin:/bin), and isn't ported to Windows");

const repo = path.resolve(import.meta.dirname, '../../..');

function deploy(home: string, ...args: string[]) {
  return deployWithEnv(home, {}, ...args);
}

function deployWithEnv(home: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(repo, 'runner/scripts/deploy-backend.mjs'), '--home', home, '--repo', repo, ...args], { encoding: 'utf8', env: { ...process.env, VITE_CONVEX_SITE_URL: undefined, ...env, PATH: '/usr/bin:/bin' } });
}

function selfHostedHome(): string {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, 'secrets', 'convex-key'), 'main-key\n');
  fs.writeFileSync(path.join(home, 'secrets', 'convex-self-hosted.env'), 'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:13210\nCONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|x\n');
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ sync: { url: 'https://mac.tail1.ts.net:3210', site: 'https://mac.tail1.ts.net:3211' } }));
  return home;
}

test('a self-hosted backend is deployed with its admin URL, never a deploy key', () => {
  const home = selfHostedHome();
  const r = deploy(home, '--dry-run', '--force');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /self-hosted backend at http:\/\/127\.0\.0\.1:13210/);
  assert.doesNotMatch(r.stdout + r.stderr, /convex-self-hosted\|x/, 'the admin key is never printed');
  assert.equal(fs.existsSync(path.join(home, 'backend.json')), false, 'nothing deployed');
});

test('website rebuilds compare normalized sites, including inherited configuration', () => {
  const home = selfHostedHome();
  const api = 'https://mac.tail1.ts.net:3210';
  const saved = { functions: { tree: treeOf(['convex', 'convex.json', 'package.json', 'package-lock.json', 'vendor']) }, site: { tree: treeOf(['web', 'package.json', 'package-lock.json', 'vendor']), url: api, address: 'https://site.example.com' } };
  fs.writeFileSync(path.join(home, 'backend.json'), JSON.stringify(saved));
  const config = (site?: unknown) => fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ sync: { url: api, site } }));
  const inherited = { VITE_CONVEX_SITE_URL: ' HTTPS://SITE.EXAMPLE.COM:443/// ' };
  config();
  assert.match(deployWithEnv(home, inherited, '--dry-run').stdout, /up to date/);
  assert.match(deployWithEnv(home, { VITE_CONVEX_SITE_URL: 'https://new-site.example.com' }, '--dry-run').stdout, /Would deploy the website at/);
  config(' ');
  assert.match(deployWithEnv(home, inherited, '--dry-run').stdout, /up to date/);
  config(' HTTPS://SITE.EXAMPLE.COM:443/// ');
  assert.match(deployWithEnv(home, { VITE_CONVEX_SITE_URL: 'https://ignored.example.com' }, '--dry-run').stdout, /up to date/);
  for (const bad of [123, 'https://x;sandbox']) {
    config(bad);
    const out = deployWithEnv(home, inherited, '--dry-run');
    assert.equal(out.status, 1);
    assert.match(out.stderr, /Website address/);
    assert.doesNotMatch(out.stderr, /Error:|\n\s+at |Node\.js/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'backend.json'), 'utf8')), saved);
  }
  config();
  const badInherited = deployWithEnv(home, { VITE_CONVEX_SITE_URL: 'javascript:bad' }, '--dry-run');
  assert.equal(badInherited.status, 1);
  assert.match(badInherited.stderr, /Website address/);
  assert.doesNotMatch(badInherited.stderr, /Error:|\n\s+at |Node\.js/);
});

test('a deploy key and a self-hosted key together stop the deploy', () => {
  const home = selfHostedHome();
  fs.writeFileSync(path.join(home, 'secrets', 'convex-deploy.env'), 'CONVEX_DEPLOY_KEY=prod:demo-bear-123|x\n');
  const r = deploy(home, '--dry-run', '--force');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Both .* are here/);
});

// As deploy-backend.mjs treeOf: the object hashes of the paths at HEAD, joined.
function treeOf(paths: string[]): string {
  const out = spawnSync('git', ['-C', repo, 'ls-tree', 'HEAD', '--', ...paths], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[2]).join('+');
}

test('the website is built again when the backend address changes, even with the same code', () => {
  const home = selfHostedHome();
  const functions = treeOf(['convex', 'convex.json', 'package.json', 'package-lock.json', 'vendor']);
  const site = treeOf(['web', 'package.json', 'package-lock.json', 'vendor']);
  const state = (url?: string, address: string | undefined = 'https://mac.tail1.ts.net:3211') => fs.writeFileSync(path.join(home, 'backend.json'), JSON.stringify({ functions: { tree: functions }, site: { tree: site, ...(url ? { url } : {}), address } }));
  // The same address: nothing to do.
  state('https://mac.tail1.ts.net:3210');
  assert.match(deploy(home, '--dry-run').stdout, /up to date/);
  // The custom HTTP Actions domain changed: rebuild the image policy too.
  state('https://mac.tail1.ts.net:3210', 'https://old-site.example.com');
  const changedSite = deploy(home, '--dry-run');
  assert.equal(changedSite.status, 0, changedSite.stderr);
  assert.match(changedSite.stdout, /Would deploy the website at/);
  // The Mac was renamed: the website (only) goes again.
  state('https://old-name.tail1.ts.net:3210');
  const r = deploy(home, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Would deploy the website at/);
  // A deploy from before the address was recorded isn't redone for that alone.
  state();
  assert.match(deploy(home, '--dry-run').stdout, /up to date/);
});
