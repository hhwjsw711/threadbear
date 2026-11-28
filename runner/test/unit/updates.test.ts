// CLI updates against stub installs: a fake Claude native layout (versions/
// plus a link) with a stub `claude update`, and a stub npm that lays out a
// fake @openai/codex package whose stub binary answers --version, app-server
// --help and generate-ts. Nothing here touches a real install or the
// network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ACP_CHECK_FRESH_MS, CliUpdates, type CliUpdatesHooks } from '../../src/updates/manager.ts';
import { UpdateHistory, HISTORY_MAX_LINES, OUTPUT_MAX_BYTES } from '../../src/updates/history.ts';
import { compareVersions, defaultExec, type Exec } from '../../src/updates/exec.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import type { CliStatus, Provider } from '../../src/protocol.ts';
import { testConfig, tmpDir } from '../helpers/fakes.ts';

const NATIVE = ['node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'];
const REQUIRED = ['turn/start', 'turn/steer'];

function script(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// R/share/versions/<v> and R/bin/claude -> one of them. `update` swaps the
// link to 2.1.311 unless R/locked exists, when it says another Claude holds
// the installer's lock and exits 0, as the real one does.
function fakeClaude(root: string): { claudePath: string; calls: () => number } {
  const versions = path.join(root, 'share', 'versions');
  const link = path.join(root, 'bin', 'claude');
  for (const v of ['2.1.310', '2.1.311']) {
    script(
      path.join(versions, v),
      `echo "$@" >> "${root}/claude-calls"
case "$1" in
  --version) echo "${v} (Claude Code)";;
  update)
    [ -n "$CLAUDE_CONFIG_DIR" ] && { echo "CLAUDE_CONFIG_DIR leaked" >&2; exit 3; }
    [ "$(pwd -P)" = "$(cd "${root}/home/run" && pwd -P)" ] || { echo "wrong cwd $(pwd)" >&2; exit 4; }
    if [ -f "${root}/locked" ]; then echo "Another Claude process (PID 4242) is currently running"; exit 0; fi
    ln -sfn "${versions}/2.1.311" "${link}"
    echo "Successfully updated from ${v} to version 2.1.311";;
esac`,
    );
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(versions, '2.1.310'), link);
  return { claudePath: link, calls: () => (fs.existsSync(path.join(root, 'claude-calls')) ? fs.readFileSync(path.join(root, 'claude-calls'), 'utf8').split('\n').filter((l) => l === 'update').length : 0) };
}

// R/node/bin/npm: `npm install --prefix DIR ... @openai/codex@V` lays out a
// fake package. R/fail-V makes the install fail part way; R/drop-V makes
// that version's generated schema lack turn/steer; R/add-V adds a method.
function fakeNpm(root: string): { execPath: string; installs: () => string[] } {
  const bin = path.join(root, 'node', 'bin');
  script(
    path.join(bin, 'npm'),
    `prefix=""; spec=""
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift;; @openai/codex@*) spec="$1";; esac; shift; done
v="\${spec#@openai/codex@}"
echo "$v" >> "${root}/npm-calls"
case "$prefix" in *.partial) ;; *) echo "not a .partial prefix: $prefix" >&2; exit 5;; esac
native="$prefix/${NATIVE.join('/')}"
mkdir -p "$prefix/node_modules/@openai/codex/bin" "$(dirname "$native")"
if [ -f "${root}/fail-$v" ]; then echo "npm ERR! 404 Not Found" >&2; exit 1; fi
if [ -f "${root}/unpublished-$v" ]; then echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET https://registry.npmjs.org/@openai/codex/-/codex-$v.tgz - Not found" >&2; exit 1; fi
printf '{"name":"@openai/codex","version":"%s"}\\n' "$v" > "$prefix/node_modules/@openai/codex/package.json"
echo "// launcher" > "$prefix/node_modules/@openai/codex/bin/codex.js"
cat > "$native" <<EOS
#!/bin/sh
case "\\$1" in
  --version) echo "codex-cli $v";;
  app-server)
    case "\\$2" in
      --help) echo "usage: codex app-server";;
      generate-ts) out="\\$5"; mkdir -p "\\$out"
        if [ -f "${root}/drop-$v" ]; then echo turn/start > "\\$out/methods.txt"; else printf 'turn/start\\nturn/steer\\n' > "\\$out/methods.txt"; fi
        if [ -f "${root}/add-$v" ]; then echo thread/brandNew >> "\\$out/methods.txt"; fi;;
      serve) sleep "\\$3"; echo "still $v";;
    esac;;
esac
EOS
chmod +x "$native"
echo "added 2 packages"`,
  );
  return { execPath: path.join(bin, 'node'), installs: () => (fs.existsSync(path.join(root, 'npm-calls')) ? fs.readFileSync(path.join(root, 'npm-calls'), 'utf8').split('\n').filter(Boolean) : []) };
}

// Stand-ins for A's resolver and schema gate.
const resolve = (start: string) => {
  const bin = path.join(start, ...NATIVE);
  return fs.existsSync(bin) ? { command: bin, native: true, packageRoot: path.join(start, 'node_modules', '@openai', 'codex') } : { command: start, native: false };
};
const checkSurface = (dir: string) => {
  const have = fs.readFileSync(path.join(dir, 'methods.txt'), 'utf8').split('\n').filter(Boolean);
  return { missing: REQUIRED.filter((m) => !have.includes(m)), added: have.filter((m) => !REQUIRED.includes(m)) };
};

type Hooks = CliUpdatesHooks & { released: [Provider, string][]; pending: boolean; binaries: string[] };

function setup(o: { latest?: Partial<Record<Provider, string>>; env?: NodeJS.ProcessEnv; exec?: Exec; cfg?: Partial<ReturnType<typeof testConfig>> } = {}) {
  const root = tmpDir('tb-updates-');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'run'), { recursive: true });
  const claude = fakeClaude(root);
  const npm = fakeNpm(root);
  const cfg = testConfig(home, { claudePath: claude.claudePath, claudeMainDir: path.join(root, 'claude-main'), cliUpdates: { claude: 'auto', codex: 'auto', checkMinutes: 60, keepCodexVersions: 2 }, ...o.cfg });
  const latest = { claude: '2.1.311', codex: '0.165.0', ...o.latest };
  const fetched: string[] = [];
  const fetchText = async (url: string) => {
    fetched.push(url);
    if (url === 'https://downloads.claude.ai/claude-code-releases/latest') return `${latest.claude}\n`;
    if (url === 'https://registry.npmjs.org/@openai/codex/latest') return JSON.stringify({ name: '@openai/codex', version: latest.codex });
    throw new Error(`unexpected fetch ${url}`);
  };
  const hooks: Hooks = {
    released: [],
    pending: false,
    binaries: [],
    restartPending: () => hooks.pending,
    releaseIdle: (p, v) => void hooks.released.push([p, v]),
    versionsInUse: () => [],
    codexBinariesInUse: () => hooks.binaries,
  };
  const clock = new FakeClock();
  const notices: string[] = [];
  const env = o.env ?? { PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: '/should/not/leak' };
  // No real process list unless a test brings its own: this Mac's has nothing
  // to do with these temp folders, and at background priority ps can outlast
  // cleanupCodex's 10 s limit, which skips the cleanup a test then checks (2 Nov).
  const exec: Exec = o.exec ?? ((cmd, args, opts) => (cmd === '/bin/ps' ? Promise.resolve({ code: 0, stdout: '', stderr: '' }) : defaultExec(cmd, args, opts)));
  const make = () =>
    new CliUpdates({ cfg, log: nullLogger, clock, hooks, env, execPath: npm.execPath, fetchText, exec, random: () => 0, notice: (_l, m) => void notices.push(m), codex: { resolve, checkSurface, testedVersion: '0.164.0' } });
  const u = make();
  const changes: CliStatus[][] = [];
  u.onChange((c) => changes.push(c));
  const tools = path.join(home, 'tools', 'codex');
  return { root, home, cfg, u, make, hooks, clock, claude, npm, fetched, notices, changes, latest, tools };
}

const of = (clis: CliStatus[], p: Provider) => clis.find((c) => c.provider === p)!;

test('claude: a check finds it behind; update() returns at once, then succeeds and releases idle sessions', async () => {
  const t = setup();
  t.u.check('claude');
  await t.u.settled();
  // The check installs by itself with policy auto, so this one is "notify".
  const n = setup();
  n.u.setPolicy('claude', 'notify');
  n.u.check('claude');
  await n.u.settled();
  const before = of(n.u.list(), 'claude');
  assert.deepEqual([before.installedVersion, before.latestVersion, before.status, before.managedBy, before.policy], ['2.1.310', '2.1.311', 'behind', 'cli', 'notify']);
  assert.ok(before.checkedAt);
  const now = n.u.update('claude');
  assert.equal(of(now, 'claude').update?.state, 'running', 'returns before the update has run');
  await n.u.settled();
  const after = of(n.u.list(), 'claude');
  assert.deepEqual([after.installedVersion, after.status, after.update?.state], ['2.1.311', 'current', 'succeeded']);
  assert.deepEqual(n.hooks.released, [['claude', '2.1.311']]);
  assert.ok(n.changes.some((c) => of(c, 'claude').update?.state === 'running') && n.changes.some((c) => of(c, 'claude').update?.state === 'succeeded'));
  assert.equal(fs.readlinkSync(n.claude.claudePath), path.join(n.root, 'share', 'versions', '2.1.311'));
  // The auto one did the same by itself.
  assert.equal(of(t.u.list(), 'claude').installedVersion, '2.1.311');
  assert.deepEqual(t.hooks.released, [['claude', '2.1.311']]);
  const hist = new UpdateHistory(n.home).entries();
  assert.ok(hist.some((e) => e.provider === 'claude' && e.action === 'update' && e.ok && e.version === '2.1.311'));
});

test('claude: an update that exits 0 without moving the link waits and retries, three times at most', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.root, 'locked'), '');
  t.u.update('claude');
  await t.u.settled();
  let c = of(t.u.list(), 'claude');
  assert.equal(c.update?.state, 'waiting');
  assert.deepEqual(c.update?.waitingFor, ['another Claude Code process']);
  assert.equal(t.claude.calls(), 1);
  t.clock.advance(10 * 60_000);
  await t.u.settled();
  assert.equal(t.claude.calls(), 2);
  t.clock.advance(10 * 60_000);
  await t.u.settled();
  c = of(t.u.list(), 'claude');
  assert.equal(t.claude.calls(), 3);
  assert.equal(c.update?.state, 'failed');
  assert.equal(c.installedVersion, '2.1.310');
  assert.deepEqual(t.hooks.released, []);
  // Once the lock is gone it goes through.
  fs.rmSync(path.join(t.root, 'locked'));
  t.u.update('claude');
  await t.u.settled();
  assert.equal(of(t.u.list(), 'claude').update?.state, 'succeeded');
});

test('nothing installs while a runner restart is pending; it runs once the restart is out of the way', async () => {
  const t = setup();
  t.hooks.pending = true;
  t.u.update('codex', { version: '0.165.0' });
  await t.u.settled();
  const c = of(t.u.list(), 'codex');
  assert.equal(c.update?.state, 'waiting');
  assert.deepEqual(c.update?.waitingFor, ['the runner restart']);
  assert.deepEqual(t.npm.installs(), []);
  t.hooks.pending = false;
  t.clock.advance(60_000);
  await t.u.settled();
  assert.equal(of(t.u.list(), 'codex').installedVersion, '0.165.0');
});

test('codex: the first start installs the latest into its own copy and activates it', async () => {
  const t = setup();
  assert.equal(t.u.codexBinary(), path.join(path.dirname(t.npm.execPath), 'codex'), 'the fallback until a copy exists');
  t.u.start();
  t.clock.advance(60_000);
  await t.u.settled();
  t.u.stop();
  assert.deepEqual(t.npm.installs(), ['0.165.0']);
  assert.equal(fs.readlinkSync(path.join(t.tools, 'current')), '0.165.0');
  assert.equal(t.u.codexBinary(), path.join(t.tools, 'current'));
  const c = of(t.u.list(), 'codex');
  assert.deepEqual([c.installedVersion, c.status, c.managedBy, c.update?.state, c.path], ['0.165.0', 'current', 'threadbear', 'succeeded', path.join(t.tools, 'current')]);
  assert.deepEqual(t.hooks.released.filter(([p]) => p === 'codex'), [['codex', '0.165.0']]);
  const state = JSON.parse(fs.readFileSync(path.join(t.tools, 'state.json'), 'utf8'));
  assert.equal(state.current, '0.165.0');
  assert.ok(!fs.readdirSync(t.tools).some((n) => n.endsWith('.partial')));
  // A's resolver finds the binary through `current`.
  assert.equal(resolve(t.u.codexBinary()).native, true);
});

test('codex: npm installs from public npm whatever ~/.npmrc says (a stale company token gave E401)', async () => {
  const npmArgs: string[][] = [];
  const t = setup({ exec: (cmd, args, opts) => { if (cmd.endsWith('/npm')) npmArgs.push(args); return cmd === '/bin/ps' ? Promise.resolve({ code: 0, stdout: '', stderr: '' }) : defaultExec(cmd, args, opts); } });
  t.u.start();
  t.clock.advance(60_000);
  await t.u.settled();
  t.u.stop();
  assert.equal(npmArgs.length, 1);
  const i = npmArgs[0].indexOf('--registry');
  assert.ok(i >= 0 && npmArgs[0][i + 1] === 'https://registry.npmjs.org/', npmArgs[0].join(' '));
});

test('codex: a version whose schema lacks a method we use is held; the first start falls back to the tested one; force installs it anyway', async () => {
  const t = setup({ latest: { codex: '0.166.0' } });
  fs.writeFileSync(path.join(t.root, 'drop-0.166.0'), '');
  t.u.check('codex');
  await t.u.settled();
  let c = of(t.u.list(), 'codex');
  assert.deepEqual(t.npm.installs(), ['0.166.0', '0.164.0']);
  assert.equal(c.installedVersion, '0.164.0', 'the tested version runs');
  assert.equal(c.status, 'held');
  assert.deepEqual(c.hold, { version: '0.166.0', reason: 'the app-server protocol changed', missing: ['turn/steer'] });
  assert.ok(t.changes.some((x) => of(x, 'codex').hold), 'clis.updated carried the hold');
  // An hourly check doesn't try the held version again.
  t.u.check('codex');
  await t.u.settled();
  assert.deepEqual(t.npm.installs(), ['0.166.0', '0.164.0']);
  // "Update anyway": no second download, the kept folder is activated.
  t.u.update('codex', { force: true });
  await t.u.settled();
  c = of(t.u.list(), 'codex');
  assert.deepEqual([c.installedVersion, c.status, c.hold, c.previousVersion], ['0.166.0', 'current', undefined, '0.164.0']);
  assert.deepEqual(t.npm.installs(), ['0.166.0', '0.164.0']);
});

test('codex: a protocol hold starts one thread looking into it, and a runner start whose lists now pass installs it by itself', async () => {
  const t = setup();
  t.u.update('codex', { version: '0.164.0' });
  await t.u.settled();
  const started: { version: string; current?: string; missing: string[] }[] = [];
  const threads = new Map<string, 'open' | 'archived'>();
  t.hooks.heldBack = (h) => {
    started.push(h);
    threads.set(`thread-${started.length}`, 'open');
    return `thread-${started.length}`;
  };
  t.hooks.threadState = (id) => threads.get(id);
  t.latest.codex = '0.166.0';
  fs.writeFileSync(path.join(t.root, 'drop-0.166.0'), '');
  t.u.check('codex');
  await t.u.settled();
  let c = of(t.u.list(), 'codex');
  assert.equal(c.status, 'held');
  assert.deepEqual(started, [{ version: '0.166.0', current: '0.164.0', missing: ['turn/steer'], added: [] }]);
  assert.deepEqual(c.hold, { version: '0.166.0', reason: 'the app-server protocol changed', missing: ['turn/steer'], threadId: 'thread-1', investigating: true });
  // Later checks start no second thread. Archived, it's no longer
  // "investigating" and the app hears so at once; deleted, it isn't linked.
  t.u.check('codex');
  await t.u.settled();
  assert.equal(started.length, 1);
  const sent = t.changes.length;
  t.u.threadChanged('thread-1');
  t.u.threadChanged('some-other-thread');
  assert.equal(t.changes.length, sent, 'nothing changed, nothing sent');
  threads.set('thread-1', 'archived');
  // A client reading the list first (clis.list) doesn't count as telling it.
  t.u.list();
  t.u.threadChanged('thread-1');
  assert.equal(t.changes.length, sent + 1);
  assert.deepEqual(of(t.changes.at(-1)!, 'codex').hold, { version: '0.166.0', reason: 'the app-server protocol changed', missing: ['turn/steer'], threadId: 'thread-1' });
  threads.delete('thread-1');
  t.u.threadChanged('thread-1');
  assert.equal(of(t.changes.at(-1)!, 'codex').hold?.threadId, undefined);
  // The fix lands (here: the version's schema stops lacking turn/steer) and
  // the runner restarts: its first check puts the kept copy through the gate
  // again, clears the hold and installs it, with no second download.
  fs.rmSync(path.join(t.root, 'drop-0.166.0'));
  const again = t.make();
  again.check('codex');
  await again.settled();
  c = of(again.list(), 'codex');
  assert.deepEqual([c.installedVersion, c.status, c.hold], ['0.166.0', 'current', undefined]);
  assert.deepEqual(t.npm.installs(), ['0.164.0', '0.166.0']);
  assert.equal(started.length, 1);
});

test('codex: a hold from before heldBack gets its thread at the next check, still held', async () => {
  const t = setup({ latest: { codex: '0.166.0' } });
  t.u.update('codex', { version: '0.164.0' });
  await t.u.settled();
  fs.writeFileSync(path.join(t.root, 'drop-0.166.0'), '');
  t.u.check('codex');
  await t.u.settled();
  assert.equal(of(t.u.list(), 'codex').hold?.threadId, undefined, 'no hook, no thread');
  const started: string[] = [];
  t.hooks.heldBack = (h) => (started.push(h.version), 'thread-old');
  t.hooks.threadState = () => 'open';
  const again = t.make();
  again.check('codex');
  await again.settled();
  const c = of(again.list(), 'codex');
  assert.deepEqual([c.status, c.installedVersion, c.hold?.threadId, started], ['held', '0.164.0', 'thread-old', ['0.166.0']]);
});

test('codex: an old hold a newer release has passed starts no thread, and the newer one installs', async () => {
  const t = setup({ latest: { codex: '0.166.0' } });
  t.u.update('codex', { version: '0.164.0' });
  await t.u.settled();
  fs.writeFileSync(path.join(t.root, 'drop-0.166.0'), '');
  t.u.check('codex');
  await t.u.settled();
  const started: string[] = [];
  t.hooks.heldBack = (h) => (started.push(h.version), 'thread-x');
  t.latest.codex = '0.167.0';
  const again = t.make();
  again.check('codex');
  await again.settled();
  const c = of(again.list(), 'codex');
  assert.deepEqual([c.installedVersion, c.hold, started], ['0.167.0', undefined, []]);
});

test('codex: a recheck whose gate gives no answer tries again at the next check', async () => {
  const t = setup({ latest: { codex: '0.166.0' } });
  t.u.update('codex', { version: '0.164.0' });
  await t.u.settled();
  fs.writeFileSync(path.join(t.root, 'drop-0.166.0'), '');
  t.u.check('codex');
  await t.u.settled();
  fs.rmSync(path.join(t.root, 'drop-0.166.0'));
  // The kept copy's binary fails once (a timeout, say), then works.
  const native = path.join(t.tools, '0.166.0', ...NATIVE);
  const good = fs.readFileSync(native, 'utf8');
  fs.writeFileSync(native, '#!/bin/sh\nexit 1\n');
  const again = t.make();
  again.check('codex');
  await again.settled();
  assert.equal(of(again.list(), 'codex').status, 'held');
  fs.writeFileSync(native, good);
  again.check('codex');
  await again.settled();
  const c = of(again.list(), 'codex');
  assert.deepEqual([c.installedVersion, c.hold], ['0.166.0', undefined]);
});

test('codex: a hold from going back is never cleared by a recheck', async () => {
  const t = setup();
  t.u.update('codex', { version: '0.164.0' });
  await t.u.settled();
  t.u.update('codex', { version: '0.165.0' });
  await t.u.settled();
  t.u.update('codex', { version: '0.164.0' });
  await t.u.settled();
  const again = t.make();
  again.check('codex');
  await again.settled();
  const c = of(again.list(), 'codex');
  assert.deepEqual([c.installedVersion, c.hold?.reason], ['0.164.0', 'you went back from it']);
});

test('codex: new names only still activate, and are recorded', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.root, 'add-0.165.0'), '');
  t.u.update('codex', { version: '0.165.0' });
  await t.u.settled();
  assert.equal(of(t.u.list(), 'codex').installedVersion, '0.165.0');
  const act = new UpdateHistory(t.home).entries().find((e) => e.action === 'activate');
  assert.deepEqual(act?.added, ['thread/brandNew']);
});

test('codex: "Go back" swaps current to the kept previous version with no download', async () => {
  const t = setup();
  t.u.update('codex', { version: '0.164.0' });
  await t.u.settled();
  t.u.update('codex', { version: '0.165.0' });
  await t.u.settled();
  assert.equal(of(t.u.list(), 'codex').previousVersion, '0.164.0');
  t.hooks.released.length = 0;
  t.u.update('codex', { version: '0.164.0' });
  await t.u.settled();
  const c = of(t.u.list(), 'codex');
  assert.deepEqual([c.installedVersion, c.previousVersion], ['0.164.0', '0.165.0']);
  assert.deepEqual(t.npm.installs(), ['0.164.0', '0.165.0']);
  assert.deepEqual(t.hooks.released, [['codex', '0.164.0']]);
});

test('codex: going back holds the version left behind, so a check doesn\'t put it back; a newer one or force still installs', async () => {
  const t = setup();
  t.u.update('codex', { version: '0.164.0' });
  await t.u.settled();
  t.u.update('codex', { version: '0.165.0' });
  await t.u.settled();
  t.u.update('codex', { version: '0.164.0' }); // Go back
  await t.u.settled();
  let c = of(t.u.list(), 'codex');
  assert.equal(c.installedVersion, '0.164.0');
  assert.deepEqual(c.hold, { version: '0.165.0', reason: 'you went back from it' });
  // The hourly check sees 0.165.0 as latest and leaves it.
  t.u.check('codex');
  await t.u.settled();
  c = of(t.u.list(), 'codex');
  assert.equal(c.installedVersion, '0.164.0');
  assert.equal(c.status, 'held');
  // Asked for by name without force: still held, said why.
  t.u.update('codex', { version: '0.165.0' });
  await t.u.settled();
  c = of(t.u.list(), 'codex');
  assert.equal(c.installedVersion, '0.164.0');
  assert.match(c.update?.message ?? '', /held back because you went back from it/);
  // A newer release goes through the gate as usual, and clears the hold.
  t.latest.codex = '0.166.0';
  t.u.check('codex');
  await t.u.settled();
  c = of(t.u.list(), 'codex');
  assert.equal(c.installedVersion, '0.166.0');
  assert.equal(c.hold, undefined);
  // Going back again and then "Update anyway" reinstalls it.
  t.u.update('codex', { version: '0.165.0' });
  await t.u.settled();
  assert.equal(of(t.u.list(), 'codex').hold?.version, '0.166.0');
  t.u.update('codex', { version: '0.166.0', force: true });
  await t.u.settled();
  c = of(t.u.list(), 'codex');
  assert.equal(c.installedVersion, '0.166.0');
  assert.equal(c.hold, undefined);
  // 0.165.0 was cleaned up once 0.166.0 and 0.164.0 were the two kept, so
  // going back to it downloaded it again; "Update anyway" used the kept 0.166.0.
  assert.deepEqual(t.npm.installs(), ['0.164.0', '0.165.0', '0.166.0', '0.165.0']);
});

test('codex: a release npm lists before its download is up waits for the next check, not a failure', async () => {
  const t = setup();
  t.u.update('codex', { version: '0.164.0' });
  await t.u.settled();
  fs.writeFileSync(path.join(t.root, 'unpublished-0.165.0'), '');
  t.u.update('codex', { version: '0.165.0' });
  await t.u.settled();
  let c = of(t.u.list(), 'codex');
  assert.equal(c.update?.state, 'unchanged');
  assert.match(c.update?.message ?? '', /isn't ready to download yet/);
  assert.equal(c.installedVersion, '0.164.0');
  // Once it's up, the next try installs it.
  fs.rmSync(path.join(t.root, 'unpublished-0.165.0'));
  t.u.update('codex', { version: '0.165.0' });
  await t.u.settled();
  c = of(t.u.list(), 'codex');
  assert.equal(c.installedVersion, '0.165.0');
});

test('codex: a failed install leaves no .partial folder and changes nothing', async () => {
  const t = setup();
  t.u.update('codex', { version: '0.164.0' });
  await t.u.settled();
  fs.writeFileSync(path.join(t.root, 'fail-0.165.0'), '');
  t.u.update('codex', { version: '0.165.0' });
  await t.u.settled();
  const c = of(t.u.list(), 'codex');
  assert.equal(c.update?.state, 'failed');
  assert.match(c.update?.message ?? '', /npm install failed/);
  assert.equal(c.installedVersion, '0.164.0');
  assert.deepEqual(fs.readdirSync(t.tools).filter((n) => !n.startsWith('.')).sort(), ['0.164.0', 'current', 'state.json']);
  const failed = new UpdateHistory(t.home).entries().find((e) => e.action === 'install' && !e.ok);
  assert.match(String(failed?.output), /404 Not Found/);
  // One left by a runner that died mid-install goes at the next start.
  fs.mkdirSync(path.join(t.tools, '0.170.0.partial', 'node_modules'), { recursive: true });
  t.u.start();
  t.u.stop();
  assert.ok(!fs.existsSync(path.join(t.tools, '0.170.0.partial')));
});

test('codex: an old version is deleted only once nothing runs it', async () => {
  let psOut = '';
  const exec: Exec = (cmd, args, opts) => (cmd === '/bin/ps' ? Promise.resolve({ code: 0, stdout: psOut, stderr: '' }) : defaultExec(cmd, args, opts));
  const t = setup({ exec });
  for (const v of ['0.164.0', '0.165.0']) {
    t.u.update('codex', { version: v });
    await t.u.settled();
  }
  // A live session still runs 0.164.0's binary, by its real path.
  t.hooks.binaries = [path.join(fs.realpathSync(path.join(t.tools, '0.164.0')), ...NATIVE)];
  t.u.update('codex', { version: '0.166.0' });
  await t.u.settled();
  assert.ok(fs.existsSync(path.join(t.tools, '0.164.0')), 'kept while the runner uses it');
  // Then only something else's arguments mention it.
  t.hooks.binaries = [];
  psOut = `/usr/bin/some-tool --root ${path.join(t.tools, '0.164.0')}/node_modules\n`;
  t.u.update('codex', { version: '0.165.0' });
  await t.u.settled();
  assert.ok(fs.existsSync(path.join(t.tools, '0.164.0')), 'kept while a process names it');
  psOut = '/usr/bin/other\n';
  // Going back to 0.165.0 held 0.166.0, so this is "Update anyway".
  t.u.update('codex', { version: '0.166.0', force: true });
  await t.u.settled();
  assert.ok(!fs.existsSync(path.join(t.tools, '0.164.0')), 'gone once nothing uses it');
  assert.deepEqual(fs.readdirSync(t.tools).filter((n) => /^\d/.test(n)).sort(compareVersions), ['0.165.0', '0.166.0']);
});

test('codex: a session running on the old binary carries on while the new version activates', async () => {
  const t = setup();
  t.u.update('codex', { version: '0.164.0' });
  await t.u.settled();
  // A "turn" on 0.164.0, started through current like a real session.
  const oldBinary = fs.realpathSync(resolve(t.u.codexBinary()).command);
  const child = spawn(oldBinary, ['app-server', 'serve', '1']);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on('exit', r));
  t.hooks.binaries = [oldBinary];
  t.u.update('codex', { version: '0.165.0' });
  await t.u.settled();
  assert.equal(fs.readlinkSync(path.join(t.tools, 'current')), '0.165.0');
  assert.deepEqual(t.hooks.released.at(-1), ['codex', '0.165.0'], 'idle sessions move; busy ones move after their turn (C)');
  assert.equal(await exited, 0);
  assert.equal(out.trim(), 'still 0.164.0');
  assert.ok(fs.existsSync(oldBinary));
  // A new session starts the new version.
  assert.match(fs.realpathSync(resolve(t.u.codexBinary()).command), /\/0\.165\.0\//);
});

test('policies: the app\'s choice persists; THREADBEAR_CLI_UPDATES=off and a hand-set codexPath win', async () => {
  const t = setup();
  t.u.setPolicy('codex', 'notify');
  assert.equal(of(t.make().list(), 'codex').policy, 'notify', 'kept in updates.json');
  t.u.check('codex');
  await t.u.settled();
  assert.deepEqual(t.npm.installs(), [], 'notify only reports');
  assert.equal(of(t.u.list(), 'codex').status, 'missing');

  const off = setup({ env: { PATH: '/usr/bin:/bin', THREADBEAR_CLI_UPDATES: 'off' } });
  off.u.setPolicy('claude', 'auto');
  assert.deepEqual(off.u.list().map((c) => c.policy), ['off', 'off']);
  // A copy installed earlier isn't used: tests and dev runners use the fallback.
  fs.mkdirSync(path.join(off.tools, '0.164.0', 'node_modules', '@openai', 'codex'), { recursive: true });
  fs.writeFileSync(path.join(off.tools, '0.164.0', 'node_modules', '@openai', 'codex', 'package.json'), '{}');
  fs.symlinkSync('0.164.0', path.join(off.tools, 'current'));
  assert.equal(off.u.codexBinary(), path.join(path.dirname(off.npm.execPath), 'codex'));
  off.u.start();
  off.clock.advance(60_000);
  await off.u.settled();
  off.u.stop();
  assert.deepEqual(off.fetched, [], 'no lookups with updates off');
  assert.deepEqual(off.npm.installs(), []);

  const byHand = setup({ cfg: { codexPath: '/opt/codex/bin/codex' } });
  const c = of(byHand.u.list(), 'codex');
  assert.deepEqual([c.path, c.managedBy, c.policy], ['/opt/codex/bin/codex', 'none', 'off']);
  assert.equal(byHand.u.codexBinary(), '/opt/codex/bin/codex');
});

test('no version lookups with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC; a failed lookup keeps the last value', async () => {
  const t = setup({ env: { PATH: '/usr/bin:/bin', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
  t.u.check();
  await t.u.settled();
  assert.deepEqual(t.fetched, []);
  const u = setup();
  u.u.setPolicy('claude', 'notify');
  u.u.check('claude');
  await u.u.settled();
  u.latest.claude = 'garbage';
  u.u.check('claude');
  await u.u.settled();
  assert.equal(of(u.u.list(), 'claude').latestVersion, '2.1.311');
});

test('checks run a minute after start, then hourly', async () => {
  const t = setup();
  t.u.setPolicy('claude', 'notify');
  t.u.setPolicy('codex', 'notify');
  t.u.start();
  t.clock.advance(59_000);
  await t.u.settled();
  assert.equal(t.fetched.length, 0);
  t.clock.advance(1_000);
  await t.u.settled();
  assert.equal(t.fetched.length, 2);
  t.clock.advance(60 * 60_000);
  await t.u.settled();
  assert.equal(t.fetched.length, 4);
  t.u.stop();
});

test('two failed starts on a version send one warning', () => {
  const t = setup();
  t.u.sessionStarted('codex', '0.165.0', false);
  assert.deepEqual(t.notices, []);
  t.u.sessionStarted('codex', '0.165.0', false);
  t.u.sessionStarted('codex', '0.165.0', false);
  assert.deepEqual(t.notices, ['Codex 0.165.0 failed to start twice.']);
  t.u.sessionStarted('claude', '2.1.312', false);
  t.u.sessionStarted('claude', '2.1.312', true);
  t.u.sessionStarted('claude', '2.1.312', false);
  assert.equal(t.notices.length, 1, 'a success in between resets the count');
  t.u.sessionStarted('antigravity', '1.4.5', false);
  t.u.sessionStarted('antigravity', '1.4.5', false);
  assert.equal(t.notices[1], 'Antigravity 1.4.5 failed to start twice.');
});

test('updates.ndjson keeps the last 500 lines and 10 KB of output each', () => {
  const home = tmpDir('tb-updates-hist-');
  const h = new UpdateHistory(home);
  for (let i = 0; i < HISTORY_MAX_LINES + 20; i++) h.append({ at: 'x', provider: 'codex', action: 'check', ok: true, version: `0.0.${i}` });
  const entries = h.entries();
  assert.equal(entries.length, HISTORY_MAX_LINES);
  assert.equal(entries.at(-1)?.version, `0.0.${HISTORY_MAX_LINES + 19}`);
  h.append({ at: 'x', provider: 'codex', action: 'install', ok: false, output: 'e'.repeat(50_000) + 'THE END' });
  const last = h.entries().at(-1)!;
  assert.ok(Buffer.byteLength(String(last.output)) <= OUTPUT_MAX_BYTES + 4);
  assert.ok(String(last.output).endsWith('THE END'));
});

test('a run left "running" by a stopped runner reads as failed after a restart', async () => {
  const t = setup();
  t.hooks.pending = true;
  t.u.update('claude');
  const again = t.make();
  assert.equal(of(again.list(), 'claude').update?.state, 'failed');
});

test('compareVersions orders releases and pre-releases', () => {
  const vs = ['0.165.0', '0.164.0', '0.165.0-alpha.2', '0.99.1', '0.165.0-alpha.10', '1.0.0'];
  assert.deepEqual([...vs].sort(compareVersions), ['0.99.1', '0.164.0', '0.165.0-alpha.2', '0.165.0-alpha.10', '0.165.0', '1.0.0']);
});

function acpSetup(o: { missing?: boolean; env?: NodeJS.ProcessEnv; version?: () => string; fail?: boolean } = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    if (cmd === '/bin/opencode') {
      calls.push(args);
      if (args[0] === '--version') return { code: 0, stdout: `${(o.version ?? (() => '1.0.0'))()}\n`, stderr: '' };
      return o.fail ? { code: 1, stdout: '', stderr: 'no network\n' } : { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  };
  const ctx = setup({ exec, env: o.env });
  (ctx.u as unknown as { d: Record<string, unknown> }).d.acp = { providers: ['opencode'], binary: () => (o.missing ? undefined : '/bin/opencode'), updateArgs: () => ['upgrade'] };
  return { ...ctx, calls };
}

test('an ACP agent that isn\'t installed has no row and clis.* do nothing', async () => {
  const c = acpSetup({ missing: true });
  assert.ok(!c.u.list().some((r) => r.provider === 'opencode'));
  c.u.update('opencode');
  c.u.check('opencode');
  c.u.setPolicy('opencode', 'auto');
  await c.u.settled();
  assert.deepEqual(c.calls, []);
});

test('an ACP agent shows its version, and never updates by itself', async () => {
  const c = acpSetup();
  c.u.check('opencode');
  await c.u.settled();
  const row = c.u.list().find((r) => r.provider === 'opencode')!;
  assert.equal(row.installedVersion, '1.0.0');
  assert.equal(row.policy, 'off');
  assert.equal(row.canUpdateNow, true);
  assert.deepEqual(c.calls, [['--version']]);
  c.u.setPolicy('opencode', 'auto');
  assert.equal(c.u.list().find((r) => r.provider === 'opencode')!.policy, 'off');
});

test('Update runs the agent\'s own updater and reports what happened', async () => {
  let v = '1.0.0';
  const c = acpSetup({ version: () => v });
  const exec = (c.u as unknown as { exec: Exec }).exec;
  (c.u as unknown as { exec: Exec }).exec = async (cmd, args, opts) => {
    const r = await exec(cmd, args, opts);
    if (args[0] === 'upgrade') v = '2.0.0';
    return r;
  };
  c.u.update('opencode');
  await c.u.settled();
  assert.ok(c.calls.some((a) => a[0] === 'upgrade'));
  const row = c.u.list().find((r) => r.provider === 'opencode')!;
  assert.equal(row.update?.state, 'succeeded');
  assert.equal(row.installedVersion, '2.0.0');
});

test('an Update that finds nothing newer says up to date for a day, then offers Update again', async () => {
  const c = acpSetup();
  c.u.update('opencode');
  await c.u.settled();
  let row = c.u.list().find((r) => r.provider === 'opencode')!;
  assert.equal(row.update?.state, 'unchanged');
  assert.equal(row.status, 'current');
  assert.equal(row.latestVersion, '1.0.0');
  assert.ok(row.checkedAt);
  c.clock.advance(ACP_CHECK_FRESH_MS);
  row = c.u.list().find((r) => r.provider === 'opencode')!;
  assert.equal(row.status, 'unknown');
  assert.equal(row.latestVersion, undefined);
});

test('a failed update says why', async () => {
  const c = acpSetup({ fail: true });
  c.u.update('opencode');
  await c.u.settled();
  const row = c.u.list().find((r) => r.provider === 'opencode')!;
  assert.equal(row.update?.state, 'failed');
  assert.match(String(row.update?.message), /no network/);
});

test('THREADBEAR_CLI_UPDATES=off covers them too', async () => {
  const c = acpSetup({ env: { PATH: '/usr/bin:/bin', THREADBEAR_CLI_UPDATES: 'off' } });
  c.u.update('opencode');
  await c.u.settled();
  assert.ok(!c.calls.some((a) => a[0] === 'upgrade'));
});

test('an update left running across a restart is marked failed, so it can be tried again', async () => {
  const c = acpSetup();
  (c.u as unknown as { setUpdate(p: string, u: unknown): void }).setUpdate('opencode', { state: 'running', message: 'Updating' });
  const after = c.make();
  (after as unknown as { d: Record<string, unknown> }).d.acp = { providers: ['opencode'], binary: () => '/bin/opencode', updateArgs: () => ['upgrade'] };
  assert.equal(after.list().find((r) => r.provider === 'opencode')!.update?.state, 'failed');
});

test('a routine check keeps an ACP agent\'s version', async () => {
  const c = acpSetup();
  c.u.check('opencode');
  await c.u.settled();
  await (c.u as unknown as { refreshInstalled(): Promise<void> }).refreshInstalled();
  assert.equal(c.u.list().find((r) => r.provider === 'opencode')!.installedVersion, '1.0.0');
});

test('codex: with no copy of its own yet, the first start installs one at once, not after the first check', async () => {
  const t = setup();
  t.u.start();
  await t.u.settled();
  assert.deepEqual(t.npm.installs(), ['0.165.0']);
  assert.equal(t.u.codexBinary(), path.join(t.tools, 'current'));
  // The first check a minute on finds the copy there, and installs nothing more.
  t.clock.advance(60_000);
  await t.u.settled();
  t.u.stop();
  assert.deepEqual(t.npm.installs(), ['0.165.0']);
});

test('codex: the first check landing while the first-start install still runs doesn\'t start a second one', async () => {
  const t = setup();
  t.u.start();
  // The scheduled check fires before the first-start install has even looked up the latest.
  t.clock.advance(60_000);
  t.u.check('codex');
  await t.u.settled();
  t.u.stop();
  assert.deepEqual(t.npm.installs(), ['0.165.0']);
  assert.equal(of(t.u.list(), 'codex').update?.state, 'succeeded');
});

test('codex: no install at start with a copy already there, with updates on Notify, or with codexPath set', async () => {
  const t = setup();
  t.u.update('codex', { version: '0.164.0' });
  await t.u.settled();
  const again = t.make();
  again.start();
  await again.settled();
  again.stop();
  assert.deepEqual(t.npm.installs(), ['0.164.0'], 'the copy there stays until the first check');
  const n = setup();
  n.u.setPolicy('codex', 'notify');
  n.u.start();
  await n.u.settled();
  n.u.stop();
  assert.deepEqual(n.npm.installs(), []);
  const byHand = setup({ cfg: { codexPath: '/nowhere/codex' } });
  byHand.u.start();
  await byHand.u.settled();
  byHand.u.stop();
  assert.deepEqual(byHand.npm.installs(), []);
});

test('codex: a missing CLI is only a quiet note while its own copy is on its way, and a warning once that fails (it sat in the error bar, 14 Nov)', async () => {
  const t = setup();
  const waiting = t.u.missingCodexNotice();
  assert.equal(waiting?.level, 'info');
  assert.match(waiting!.message, /installed its own copy/);
  fs.writeFileSync(path.join(t.root, 'fail-0.165.0'), '');
  fs.writeFileSync(path.join(t.root, 'fail-0.164.0'), '');
  t.u.start();
  await t.u.settled();
  assert.equal(of(t.u.list(), 'codex').update?.state, 'failed');
  assert.equal(t.u.missingCodexNotice()?.level, 'warning');
  // Apps already connected hear it too, once.
  assert.equal(t.notices.filter((m) => /codex CLI isn't at/.test(m)).length, 1);
  t.u.check('codex');
  await t.u.settled();
  assert.equal(t.notices.filter((m) => /codex CLI isn't at/.test(m)).length, 1, 'not again on every retry');
  fs.rmSync(path.join(t.root, 'fail-0.165.0'));
  t.u.update('codex', { version: '0.165.0' });
  await t.u.settled();
  t.u.stop();
  assert.equal(t.u.missingCodexNotice(), undefined, 'gone once the copy is there');
});

test('codex: a missing CLI nothing will install is a warning that says what to do', () => {
  const byHand = setup({ cfg: { codexPath: '/nowhere/codex' } });
  assert.deepEqual(byHand.u.missingCodexNotice(), { level: 'warning', message: "The codex CLI isn't at /nowhere/codex (codexPath in runner.json), so Codex threads can't start." });
  const off = setup({ cfg: { cliUpdates: { claude: 'auto', codex: 'off', checkMinutes: 60, keepCodexVersions: 2 } } });
  assert.equal(off.u.missingCodexNotice()?.level, 'warning');
  assert.match(off.u.missingCodexNotice()!.message, /Install @openai\/codex next to the runner's Node/);
  const envOff = setup({ env: { PATH: '/usr/bin:/bin', THREADBEAR_CLI_UPDATES: 'off' } });
  assert.match(envOff.u.missingCodexNotice()!.message, /Install @openai\/codex next to the runner's Node/);
  const notify = setup();
  notify.u.setPolicy('codex', 'notify');
  assert.equal(notify.u.missingCodexNotice()?.level, 'warning');
  assert.match(notify.u.missingCodexNotice()!.message, /Automatic in Usage/);
  const quiet = setup({ env: { PATH: '/usr/bin:/bin', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
  assert.equal(quiet.u.missingCodexNotice()?.level, 'warning', 'no lookups, so no first install either');
  assert.match(quiet.u.missingCodexNotice()!.message, /Install @openai\/codex next to the runner's Node/i);
});

test('codex: a first install whose latest is held and whose tested version failed tries the tested one again next time (Gemini\'s review)', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.root, 'drop-0.165.0'), '');
  fs.writeFileSync(path.join(t.root, 'fail-0.164.0'), '');
  t.u.start();
  await t.u.settled();
  assert.deepEqual(t.npm.installs(), ['0.165.0', '0.164.0']);
  assert.equal(t.u.missingCodexNotice()?.level, 'warning');
  assert.match(t.u.missingCodexNotice()!.message, /tries again at the next hourly check/);
  fs.rmSync(path.join(t.root, 'fail-0.164.0'));
  t.u.check('codex');
  await t.u.settled();
  t.u.stop();
  assert.equal(t.u.codexBinary(), path.join(t.tools, 'current'));
  assert.equal(fs.readlinkSync(path.join(t.tools, 'current')), '0.164.0');
  // A plain Update does the same (Codex's second review).
  const u = setup();
  fs.writeFileSync(path.join(u.root, 'drop-0.165.0'), '');
  fs.writeFileSync(path.join(u.root, 'fail-0.164.0'), '');
  u.u.start();
  await u.u.settled();
  fs.rmSync(path.join(u.root, 'fail-0.164.0'));
  u.u.update('codex');
  await u.u.settled();
  u.u.stop();
  assert.equal(fs.readlinkSync(path.join(u.tools, 'current')), '0.164.0');
});

test('codex: Update with no copy yet and no latest known installs the tested version, rather than failing and warning (Gemini\'s review)', async () => {
  const quiet = setup({ env: { PATH: '/usr/bin:/bin', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
  quiet.u.update('codex');
  await quiet.u.settled();
  assert.equal(of(quiet.u.list(), 'codex').installedVersion, '0.164.0');
  // Pressed while the first start's own install is still looking up the latest.
  const t = setup();
  t.u.start();
  t.u.update('codex');
  await t.u.settled();
  t.u.stop();
  assert.equal(of(t.u.list(), 'codex').update?.state, 'succeeded');
  assert.deepEqual(t.notices, []);
});

test('codex: once a first install has failed, a retry under way still reads as a warning, so an app connecting then hears it (Gemini\'s review)', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.root, 'fail-0.165.0'), '');
  fs.writeFileSync(path.join(t.root, 'fail-0.164.0'), '');
  t.u.start();
  await t.u.settled();
  t.hooks.pending = true;
  t.u.check('codex');
  await t.u.settled();
  assert.equal(of(t.u.list(), 'codex').update?.state, 'waiting');
  assert.equal(t.u.missingCodexNotice()?.level, 'warning');
  t.u.stop();
});
