// Where the GPUI app's update is built (desktop/scripts/stage-update.sh).
// What the build host sends back is what the main Mac runs next, so a check
// host, trusted only to run tests, must never become one by being in
// checkHosts: only updateBuildHosts names a builder (Daybreak 108, 12 Nov
// 2026). A Mac with check hosts keeps heavy builds off itself, so with no
// update build host it builds nothing at all rather than building here.
//
// The script runs for real against a tiny checkout whose remote.sh,
// make-bundle.sh and cargo are stand-ins that only note they ran. Hosts are
// .invalid names, so ssh's look at them fails at once and nothing leaves
// this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpDir } from '../helpers/fakes.ts';

const SCRIPT = path.join(import.meta.dirname, '..', '..', '..', 'desktop', 'scripts', 'stage-update.sh');

function write(file: string, text: string, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

// The pinned Rust (desktop/scripts/pinned-cargo.sh, copied into the
// checkout as main's): rust 'pinned' has it in this Mac's cache already,
// with a stand-in cargo that notes it ran and leaves the two binaries;
// 'none' has nothing there and nowhere to fetch it from. A cargo and a
// rustup on ~/.cargo/bin note it if they're ever run: they never should be.
// cargoFails: the build fails.
const PINNED_CARGO = path.join(import.meta.dirname, '..', '..', '..', 'desktop', 'scripts', 'pinned-cargo.sh');
const HOST = 'aarch64-apple-darwin';
const PINS_LINES = ['rustc', 'cargo', 'rust-std'].map((p, i) => `1.99.1 ${HOST} ${p} ${String(i + 1).repeat(64)} https://static.rust-lang.org/dist/2026-10-15/${p}-1.99.1-${HOST}.tar.xz`);
const PINS = `# version target part sha256 url\n${PINS_LINES.join('\n')}\n`;
// pinned-cargo.sh names the toolchain's folder by a hash of its pins.
const KEY = createHash('sha256').update(PINS_LINES.join('\n')).digest('hex').slice(0, 12);

function setup(config: Record<string, unknown> | null, remote?: 'busy' | 'legacy' | 'slow', rust: 'pinned' | 'none' = 'pinned', cargoFails = false, toolchain: string | null = '[toolchain]\nchannel = "1.99.1"\ncomponents = ["rustfmt", "clippy"]\n', pins: string | null = PINS) {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const marks = path.join(root, 'marks');
  fs.mkdirSync(marks, { recursive: true });
  const checkout = path.join(root, 'checkout');
  const note = (what: string) => `#!/bin/bash\necho "$*" >> '${marks}/${what}'\n`;
  write(path.join(checkout, 'desktop', 'scripts', 'remote.sh'), `${note('remote')}
cat >/dev/null
echo "try=\${THREADBEAR_REMOTE_TRY-unset} first=\${THREADBEAR_REMOTE_FIRST-unset}" >> '${marks}/remote'
[ "$1" != gone.invalid ] || exit 3
${remote === 'busy' ? '[ "$1" = free.invalid ] || [ "${THREADBEAR_REMOTE_TRY-}" != 1 ] || exit 75' : ''}
${remote === 'slow' ? `echo $$ > '${marks}/remote-pid'; trap 'echo stopped >> "${marks}/remote"; exit 143' TERM; sleep 30 & wait` : ''}
${remote === 'legacy' ? '[ "$2" = -- ] || exit 127' : ''}
echo BUILT_IN=/mock-target
`, 0o755);
  write(path.join(checkout, 'desktop', 'scripts', 'make-bundle.sh'), `${note('bundle')}echo "builtOn=\${THREADBEAR_BUILT_ON-unset}" >> '${marks}/bundle'\nmkdir -p "$2"\n`, 0o755);
  write(path.join(checkout, 'desktop', 'scripts', 'pinned-cargo.sh'), fs.readFileSync(PINNED_CARGO, 'utf8'), 0o755);
  for (const bin of ['cargo', 'rustup']) write(path.join(home, '.cargo', 'bin', bin), `${note(`stray-${bin}`)}exit 1\n`, 0o755);
  if (rust === 'pinned') {
    const prefix = path.join(home, 'Library', 'Caches', 'Threadbear', 'rust', `1.99.1-${HOST}-${KEY}`);
    write(path.join(prefix, 'bin', 'cargo'), `${note('cargo')}echo "rustc=$RUSTC" >> '${marks}/cargo'\n[ "$1" = build ] || exit 0\n${cargoFails ? 'exit 101\n' : ''}mkdir -p "$CARGO_TARGET_DIR/release"\ntouch "$CARGO_TARGET_DIR/release/threadbear-gpui" "$CARGO_TARGET_DIR/release/threadbear-web-helper"\n`, 0o755);
    write(path.join(prefix, 'pinned'), `${PINS_LINES.join('\n')}\n`);
  }
  if (toolchain !== null) write(path.join(checkout, 'rust-toolchain.toml'), toolchain);
  if (pins !== null) write(path.join(checkout, 'desktop', 'scripts', 'rust-toolchain.pins'), pins);
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  if (config) fs.writeFileSync(path.join(data, 'runner.json'), JSON.stringify(config));
  const args = [SCRIPT, checkout, '--next', path.join(root, 'next.app')];
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...process.env, ...extra, PATH: `${path.join(home, '.cargo', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, THREADBEAR_HOME: data, THREADBEAR_RUST_HOST: HOST, THREADBEAR_RUST_DIST: path.join(root, 'no-dist'),
    ...(remote ? { 'BASH_FUNC_ssh%%': '() { cat >/dev/null; echo Darwin; }', 'BASH_FUNC_ioreg%%': '() { :; }', 'BASH_FUNC_scp%%': '() { touch "${@: -1}"; }' } : {}),
  });
  const run = Object.assign((extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', args, {
      encoding: 'utf8',
      timeout: 60_000,
      // Only the system's tools beside the stand-ins: a real rustup on the
      // test machine's PATH would really install Rust.
      // Only the system's tools beside the stand-ins; bash imports the ssh
      // stand-in even though stage-update sets a system PATH.
      env: env(extra),
    });
    const marked = (what: string) => (fs.existsSync(path.join(marks, what)) ? fs.readFileSync(path.join(marks, what), 'utf8') : '');
    const deferred = path.join(home, 'Library', 'Caches', 'Threadbear', 'update-desktop', 'deferred-since');
    return { status: r.status, out: `${r.stdout}${r.stderr}`, marked, root, deferred };
  }, { start: () => ({ child: spawn('bash', args, { env: env(), stdio: 'ignore' }), marks }) });
  return run;
}

test('check hosts alone never build the update, and this Mac does not build it either', () => {
  const r = setup({ checkHost: 'checker.invalid', checkHosts: ['checker.invalid', 'cloud.invalid'] })();
  assert.equal(r.status, 5, r.out);
  assert.equal(r.marked('remote'), '', 'nothing sent to a check host to build');
  assert.equal(r.marked('cargo'), '', 'nothing built here');
  assert.equal(r.marked('bundle'), '', 'nothing staged');
  assert.match(r.out, /updateBuildHosts/);
  assert.ok(!fs.existsSync(path.join(r.root, 'next.app')));
});

// 24 Nov: the update build was put off in 1,162 of 1,350 tries behind
// agents' work on Tinker Desk. Now it goes ahead of that (first=1), and with
// every host busy it waits on the first for what's running to end.
test('a busy update host: one try, then it waits there to go next, ahead of other work', () => {
  const r = setup({ updateBuildHosts: ['builder.invalid'] }, 'busy')();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /waits its turn on builder\.invalid/);
  assert.match(r.marked('remote'), /try=1 first=1\n[^]*builder\.invalid --[^]*try=0 first=1\n$/);
  assert.match(r.marked('bundle'), /^builtOn=builder\.invalid$/m);
});

test('with a wait set, a busy update host defers without staging or marking main as broken', () => {
  const r = setup({ updateBuildHosts: ['builder.invalid'] }, 'busy')({ THREADBEAR_UPDATE_QUEUE_AFTER: '2700' });
  assert.equal(r.status, 4, r.out);
  assert.match(r.marked('remote'), /try=1/);
  assert.equal(r.marked('bundle'), '');
  assert.equal(r.marked('cargo'), '');
  assert.match(r.out, /busy|queued/i);
});

// Agents kept Tinker Desk busy all day on 18 Nov, and 63 tries built
// nothing while fixes sat on main. Busy for long enough, it queues.
test('busy hosts for long enough: the update queues for the lease instead of trying again', () => {
  const run = setup({ updateBuildHosts: ['builder.invalid'] }, 'busy');
  const first = run({ THREADBEAR_UPDATE_QUEUE_AFTER: '2700' });
  assert.equal(first.status, 4, first.out);
  const since = fs.readFileSync(first.deferred, 'utf8').trim();
  assert.match(since, /^\d+$/);
  // Still inside the grace: tries again later, and keeps when it started.
  const second = run({ THREADBEAR_UPDATE_QUEUE_AFTER: '2700' });
  assert.equal(second.status, 4, second.out);
  assert.equal(fs.readFileSync(second.deferred, 'utf8').trim(), since);
  assert.doesNotMatch(second.marked('remote'), /try=0/);
  // Past it: one try, then queued on the busy host, built and staged.
  const third = run({ THREADBEAR_UPDATE_QUEUE_AFTER: '0' });
  assert.equal(third.status, 0, third.out);
  assert.match(third.out, /waits its turn on builder\.invalid/);
  assert.match(third.marked('remote'), /try=1 first=1\n[^]*builder\.invalid --[^]*try=0 first=1\n$/);
  assert.match(third.marked('bundle'), /^builtOn=builder\.invalid$/m);
  assert.ok(!fs.existsSync(third.deferred), 'a build clears the deferral');
});

test('a host that went away after a busy one neither resets the busy clock nor stops the queueing', () => {
  const run = setup({ updateBuildHosts: ['busy.invalid', 'gone.invalid'] }, 'busy');
  const first = run({ THREADBEAR_UPDATE_QUEUE_AFTER: '2700' });
  assert.equal(first.status, 4, first.out);
  const since = fs.readFileSync(first.deferred, 'utf8').trim();
  const later = run({ THREADBEAR_UPDATE_QUEUE_AFTER: '0' });
  assert.equal(later.status, 0, later.out);
  assert.match(later.out, /waits its turn on busy\.invalid/);
  assert.match(later.marked('bundle'), /^builtOn=busy\.invalid$/m);
  assert.ok(since && !fs.existsSync(later.deferred));
});

test("the app's SIGTERM at quit stops remote.sh too, not just the script", async () => {
  const { child, marks } = setup({ updateBuildHosts: ['builder.invalid'] }, 'slow').start();
  const pidFile = path.join(marks, 'remote-pid');
  for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  child.kill('SIGTERM');
  const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
  assert.equal(code, 143);
  assert.match(fs.readFileSync(path.join(marks, 'remote'), 'utf8'), /stopped/);
  assert.throws(() => process.kill(pid, 0), 'remote.sh is gone when the script has exited');
});

test('a busy trusted host leaves the next trusted host a chance to build', () => {
  const r = setup({ updateBuildHosts: ['busy.invalid', 'free.invalid'], checkHosts: ['checker.invalid'] }, 'busy')();
  assert.equal(r.status, 0, r.out);
  assert.match(r.marked('remote'), /busy\.invalid --[^]*free\.invalid --/);
  assert.match(r.marked('bundle'), /^builtOn=free\.invalid$/m);
  assert.doesNotMatch(r.marked('remote'), /checker\.invalid/);
});

test('an installed updater can build main rolled back to a remote.sh from before --try', () => {
  const r = setup({ updateBuildHosts: ['legacy.invalid'] }, 'legacy')();
  assert.equal(r.status, 0, r.out);
  assert.match(r.marked('remote'), /^legacy\.invalid -- bash/m);
  assert.match(r.marked('bundle'), /^builtOn=legacy\.invalid$/m);
});

test('the single checkHost of a runner.json from before the list keeps this Mac from building too', () => {
  const r = setup({ checkHost: 'checker.invalid' })();
  assert.equal(r.status, 5, r.out);
  assert.equal(r.marked('cargo'), '');
  assert.equal(r.marked('remote'), '');
});

test('only the update build hosts are tried, never the check hosts beside them', () => {
  const r = setup({ checkHosts: ['checker.invalid'], updateBuildHosts: ['builder.invalid'] })();
  // builder.invalid doesn't answer: wait and try again later, no build here.
  assert.equal(r.status, 4, r.out);
  assert.match(r.out, /update build hosts \(builder\.invalid \)/);
  assert.doesNotMatch(r.out, /checker\.invalid/);
  assert.equal(r.marked('cargo'), '');
  assert.equal(r.marked('remote'), '');
});

test("a host name ssh would take as an option is never a builder", () => {
  const r = setup({ checkHosts: ['checker.invalid'], updateBuildHosts: ['-oProxyCommand=touch /tmp/tb-stage-pwned', ' spaced.invalid', 7] })();
  assert.equal(r.status, 5, r.out);
  assert.equal(r.marked('cargo'), '');
  assert.equal(r.marked('remote'), '');
});

test("someone else's copy with neither builds here, and the bundle says so", () => {
  for (const config of [null, {}, { updateBuildHosts: [] }]) {
    const r = setup(config)();
    assert.equal(r.status, 0, r.out);
    assert.notEqual(r.marked('cargo'), '', 'built here');
    assert.equal(r.marked('remote'), '');
    assert.match(r.marked('bundle'), /^builtOn=$/m, 'built on this Mac, said as ""');
  }
});

// Daybreak 173: the compiler writes the app this Mac runs next, so it's
// main's pinned Rust (pinned-cargo.sh, which has tests of its own), never
// rustup or a cargo that's on the PATH.
test("a build here uses main's pinned cargo and rustc, never rustup or the PATH's cargo", () => {
  const r = setup(null)();
  assert.equal(r.status, 0, r.out);
  assert.match(r.marked('cargo'), /^build --release -p threadbear-gpui /m);
  assert.match(r.marked('cargo'), new RegExp(`^rustc=.*/rust/1\\.99\\.1-${HOST}-${KEY}/bin/rustc$`, 'm'));
  assert.equal(r.marked('stray-cargo'), '');
  assert.equal(r.marked('stray-rustup'), '');
});

test('a toolchain file that pins no exact version, or pins that miss a part, build nothing', () => {
  const cases: [string | null | undefined, string | null][] = [
    [null, PINS],
    ['[toolchain]\nchannel = "stable"\n', PINS],
    ['[toolchain]\nchannel = "nightly-2026-11-01"\n', PINS],
    ['[toolchain]\nchannel = "1.99"\n', PINS],
    ['[toolchain]\nchannel = "1.99.1; rm -rf ~"\n', PINS],
    [undefined, null],
    [undefined, PINS.split('\n').filter((l) => !/ cargo /.test(l)).join('\n')],
    [undefined, PINS.replaceAll('1.99.1 ', '1.98.0 ')],
    [undefined, PINS.replace('https://static.rust-lang.org/', 'https://evil.example/')],
  ];
  for (const [toolchain, pins] of cases) {
    const r = setup(null, undefined, 'pinned', false, toolchain, pins)();
    assert.equal(r.status, 1, `${toolchain} ${pins}: ${r.out}`);
    assert.equal(r.marked('cargo'), '', 'nothing built');
    assert.equal(r.marked('bundle'), '');
  }
});

test("with no pinned Rust here and none to be had, nothing is built, and no other cargo stands in", () => {
  const r = setup(null, undefined, 'none')();
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.marked('stray-cargo'), '');
  assert.equal(r.marked('stray-rustup'), '');
  assert.equal(r.marked('bundle'), '');
});

test('an update build host builds with the pinned cargo too', () => {
  const r = setup({ updateBuildHosts: ['builder.invalid'] }, 'busy')();
  assert.match(r.marked('remote'), /pinned-cargo\.sh build --release/);
  assert.doesNotMatch(r.marked('remote'), /&& nice cargo /);
});

test("the repo's toolchain pins are for rust-toolchain.toml's version, every part, both kinds of Mac, from Rust's own server", () => {
  const root = path.join(import.meta.dirname, '..', '..', '..');
  const channel = /^channel = "([^"]+)"$/m.exec(fs.readFileSync(path.join(root, 'rust-toolchain.toml'), 'utf8'))![1];
  const lines = fs.readFileSync(path.join(root, 'desktop', 'scripts', 'rust-toolchain.pins'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const seen = lines.map((l) => {
    const [version, host, part, sha, url, extra] = l.split(' ');
    assert.equal(version, channel, 'move the pins with rust-toolchain.toml');
    assert.match(sha!, /^[0-9a-f]{64}$/);
    assert.equal(url, `https://static.rust-lang.org/dist/${/dist\/([0-9-]+)\//.exec(url!)?.[1]}/${part}-${version}-${host}.tar.xz`);
    assert.equal(extra, undefined);
    return `${host} ${part}`;
  });
  assert.deepEqual(seen.sort(), ['aarch64-apple-darwin', 'x86_64-apple-darwin'].flatMap((h) => ['cargo', 'rust-std', 'rustc'].map((p) => `${h} ${p}`)).sort());
});

// The scanner's last test: no script downloads something and runs it
// unchecked, and none builds the app with a Rust rustup picks.
test('no script pipes a download into a shell or asks rustup for a floating channel, and app builds use the pinned cargo', () => {
  const root = path.join(import.meta.dirname, '..', '..', '..');
  const files = ['desktop/scripts', 'scripts', 'runner/scripts', 'app', 'runner/box'].flatMap((dir) => {
    const abs = path.join(root, dir);
    return fs.existsSync(abs) ? fs.readdirSync(abs, { recursive: true }).map(String).filter((f) => /\.(sh|mjs|zsh)$|Dockerfile$/.test(f)).map((f) => path.join(dir, f)) : [];
  });
  assert.ok(files.length > 20);
  for (const rel of files) {
    const code = fs.readFileSync(path.join(root, rel), 'utf8').split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l)).join('\n');
    assert.doesNotMatch(code, /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, `${rel} pipes a download into a shell`);
    assert.doesNotMatch(code, /sh\.rustup\.rs/, rel);
    assert.doesNotMatch(code, /rustup[^\n]*\b(toolchain install|run|default)\s+(stable|beta|nightly)\b/, rel);
  }
  for (const rel of ['desktop/scripts/stage-update.sh', 'desktop/scripts/install-app.sh']) {
    const code = fs.readFileSync(path.join(root, rel), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /(^|[\s;&"(])cargo build/m, `${rel} builds with an unpinned cargo`);
    assert.match(code, /pinned-cargo\.sh"? build/, rel);
  }
});

test("a failed build says so, and nothing is bundled", () => {
  const failed = setup(null, undefined, 'pinned', true)();
  assert.equal(failed.status, 101, failed.out);
  assert.equal(failed.marked('bundle'), '');
});

// An installed app's older stage-update.sh runs from its own bundle but takes
// make-bundle.sh from main, and it built on a check host. It says nothing
// about where it built, so main's make-bundle.sh takes its binaries only if
// they're the build it made on this Mac, which it keeps beside them.
const MAKE_BUNDLE = path.join(import.meta.dirname, '..', '..', '..', 'desktop', 'scripts', 'make-bundle.sh');

test("an older updater's binaries from a check host are never made into a bundle", () => {
  const cache = tmpDir();
  const bins = path.join(cache, 'bins');
  for (const bin of ['threadbear-gpui', 'threadbear-web-helper']) write(path.join(bins, bin), 'from the check host', 0o755);
  const make = (env: Record<string, string | undefined>) => {
    const e: Record<string, string | undefined> = { ...process.env, ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
    return spawnSync('bash', [MAKE_BUNDLE, bins, path.join(cache, 'next.app')], { encoding: 'utf8', env: e as NodeJS.ProcessEnv });
  };
  // Nothing built here beside them: refused, and no bundle.
  let r = make({ THREADBEAR_BUILT_ON: undefined });
  assert.equal(r.status, 6, r.stderr);
  assert.ok(!fs.existsSync(path.join(cache, 'next.app')));
  // A different build here: still refused.
  for (const bin of ['threadbear-gpui', 'threadbear-web-helper']) write(path.join(cache, 'target', 'release', bin), 'built here', 0o755);
  r = make({ THREADBEAR_BUILT_ON: undefined });
  assert.equal(r.status, 6, r.stderr);
  // The same bytes as the build here (an older updater building on this Mac,
  // as anyone else's copy does) get past this check, as does a caller that
  // says where it built.
  for (const bin of ['threadbear-gpui', 'threadbear-web-helper']) write(path.join(bins, bin), 'built here', 0o755);
  r = make({ THREADBEAR_BUILT_ON: undefined });
  assert.notEqual(r.status, 6, r.stderr);
  for (const bin of ['threadbear-gpui', 'threadbear-web-helper']) write(path.join(bins, bin), 'from somewhere named', 0o755);
  r = make({ THREADBEAR_BUILT_ON: 'builder' });
  assert.notEqual(r.status, 6, r.stderr);
});

test('make-bundle.sh public release clears checkout/origin and writes the tag version', () => {
  if (process.platform !== 'darwin') return;
  const dir = tmpDir();
  const bins = path.join(dir, 'bins');
  const bundle = path.join(dir, 'Threadbear GPUI.app');
  for (const bin of ['threadbear-gpui', 'threadbear-web-helper']) write(path.join(bins, bin), '#!/bin/sh\nexit 0\n', 0o755);
  const r = spawnSync('bash', [MAKE_BUNDLE, bins, bundle], {
    encoding: 'utf8',
    env: {
      ...process.env,
      THREADBEAR_BUILT_ON: 'github-macos',
      THREADBEAR_PUBLIC_RELEASE: '1',
      THREADBEAR_BUNDLE_VERSION: '2026.11.27',
      THREADBEAR_BUNDLE_BUILD: '20261127',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const plist = fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>2026\.11\.27<\/string>/);
  assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>20261127<\/string>/);
  const build = JSON.parse(fs.readFileSync(path.join(bundle, 'Contents', 'Resources', 'build.json'), 'utf8')) as {
    checkout: string;
    origin: string;
    builtOn?: string;
  };
  assert.equal(build.checkout, '');
  assert.equal(build.origin, '');
  assert.equal(build.builtOn, 'github-macos');
});
