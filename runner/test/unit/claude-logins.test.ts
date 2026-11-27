// runner.json's claudeLogins (the claudeLogins experiment): Claude config
// folders people already sign in to by hand, as logins, their path kept as
// written so Claude Code finds the same Keychain item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeLogins } from '../../src/claude-logins.ts';
import { discoverAccounts, type DiscoveryConfig } from '../../src/accounts.ts';
import { cliEnv } from '../../src/adapters/claude/adapter.ts';
import { loadConfig } from '../../src/config.ts';
import { defaultPools } from '../../src/pools.ts';

const rootPath = process.platform === 'win32' ? 'C:/' : '/';
const H = `${rootPath}Users/someone`;
const opt = `${rootPath}opt`;
const parse = (raw: unknown) => parseClaudeLogins(raw, H);

test('the id defaults to the folder name without its dot', () => {
  assert.deepEqual(parse([{ dir: '~/.claude-personal' }]), { logins: [{ id: 'claude-personal', dir: `${H}/.claude-personal` }], errors: [] });
  assert.deepEqual(parse([{ id: 'work', dir: '~/.claude-personal' }]).logins, [{ id: 'work', dir: `${H}/.claude-personal` }]);
  assert.deepEqual(parse([{ dir: `${opt}/claude-x` }]).logins, [{ id: 'claude-x', dir: `${opt}/claude-x` }]);
});

test('only a leading tilde is expanded, the rest kept as written', () => {
  for (const [given, want] of [
    ['~/.x', `${H}/.x`],
    ['~/.x/', `${H}/.x/`],
    ['~/a//b', `${H}/a//b`],
    [`${opt}/~/x`, `${opt}/~/x`],
  ]) {
    assert.equal(parse([{ id: 'a', dir: given }]).logins[0]?.dir, want, given);
  }
  // HOME as the shell has it, trailing slash and all, as `~/x` in a shell gives.
  assert.equal(parseClaudeLogins([{ id: 'a', dir: '~/.x' }], `${H}/`).logins[0]?.dir, `${H}//.x`);
});

test('a bad entry is left out, saying why; the rest are kept', () => {
  const bad: [unknown, RegExp][] = [
    [{ id: 'claude-main', dir: '~/.a' }, /claude-main.*its own/],
    [{ id: 'claude-07', dir: '~/.a' }, /its own/],
    [{ id: 'claude-3', dir: '~/.a' }, /claude-3.*its own/],
    [{ id: 'codex-main', dir: '~/.a' }, /its own/],
    [{ id: 'codex-12', dir: '~/.a' }, /its own/],
    [{ dir: '~/.claude' }, /claude-main/],
    [{ id: 'y', dir: '~/.claude/' }, /claude-main/],
    [{ id: 'y', dir: `${H}/x/../.claude` }, /without \. or \.\./],
    [{ id: 'y', dir: '~/./.a' }, /without \. or \.\./],
    [{ id: 'cursor-main', dir: '~/.a' }, /pick another/],
    [{ id: 'opencode-main', dir: '~/.a' }, /pick another/],
    [{ id: 'y', dir: '~' }, /home folder/],
    [{ id: 'y', dir: '~/' }, /home folder/],
    [{ id: 'bad id', dir: '~/.a' }, /id should be/],
    [{ id: '../up', dir: '~/.a' }, /id should be/],
    [{ dir: rootPath }, /id should be/],
    [{ dir: '~/.claude.personal' }, /id should be/],
    [{ id: 'x'.repeat(65), dir: '~/.a' }, /id should be/],
    [{ id: 'constructor', dir: '~/.a' }, /pick another/],
    [{ id: 'toString', dir: '~/.a' }, /pick another/],
    [{ id: '__proto__', dir: '~/.a' }, /id should be|pick another/],
    [{ id: 3, dir: '~/.a' }, /"id"/],
    [{ id: '', dir: '~/.a' }, /"id"/],
    [{ id: 'x' }, /"dir"/],
    [{ id: 'x', dir: '  ' }, /"dir"/],
    [{ id: 'x', dir: 7 }, /"dir"/],
    ['nope', /"dir"/],
    [null, /"dir"/],
    [['~/.a'], /"dir"/],
    [{ id: 'x', dir: 'rel/path' }, /x \(rel\/path\).*full path/],
    [{ id: 'x', dir: '~user/.a' }, /full path/],
  ];
  for (const [entry, re] of bad) {
    const r = parse([entry, { id: 'ok', dir: '~/.ok' }]);
    assert.deepEqual(r.logins, [{ id: 'ok', dir: `${H}/.ok` }], JSON.stringify(entry));
    assert.equal(r.errors.length, 1, JSON.stringify(entry));
    assert.match(r.errors[0]!, re, JSON.stringify(entry));
  }
  assert.deepEqual(parse(undefined), { logins: [], errors: [] });
  assert.deepEqual(parse(null), { logins: [], errors: [] });
  assert.equal(parse({ id: 'a', dir: '~/.a' }).logins.length, 0);
  assert.equal(parse({ id: 'a', dir: '~/.a' }).errors.length, 1);
});

test('a repeated id or folder, however spelled, keeps only the first', () => {
  const r = parse([
    { id: 'a', dir: '~/.p' },
    { id: 'a', dir: '~/.q' },
    { id: 'b', dir: '~/.p/' },
    { id: 'c', dir: `${H}//.p` },
  ]);
  assert.deepEqual(r.logins, [{ id: 'a', dir: `${H}/.p` }]);
  assert.equal(r.errors.length, 3);
  assert.match(r.errors[0]!, /earlier entry has that id/);
  assert.match(r.errors[1]!, /^b .*earlier entry lists that folder/);
});

function setup(opts: { experiment?: boolean; claudeJson?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-claude-logins-'));
  const home = path.join(root, 'data');
  fs.mkdirSync(home);
  const experiments = opts.experiment === undefined ? {} : { experiments: { claudeLogins: opts.experiment } };
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify(experiments));
  const userHome = path.join(root, 'user');
  const dir = path.join(userHome, '.claude-personal');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude.json'), opts.claudeJson ?? JSON.stringify({ oauthAccount: { emailAddress: 'p@example.com' } }));
  const cfg: DiscoveryConfig = {
    claudeMainDir: path.join(userHome, '.claude'),
    claudeMainJson: path.join(userHome, '.claude.json'),
    tokenStatsAccountsDir: path.join(root, 'none'),
    accountsDir: path.join(home, 'accounts'),
    userHome,
    pathEnv: '',
    home,
    claudeLogins: [
      { id: 'claude-personal', dir },
      { id: 'claude-later', dir: path.join(userHome, '.claude-later') },
    ],
  };
  return { cfg, dir, root };
}

test('a listed folder is a Claude login with its email, run with its path as written', () => {
  const { cfg, dir } = setup({ experiment: true });
  const accounts = discoverAccounts(cfg);
  const a = accounts.find((x) => x.id === 'claude-personal');
  assert.ok(a);
  assert.equal(a.provider, 'claude');
  assert.equal(a.email, 'p@example.com');
  assert.equal(a.configDir, dir);
  assert.equal(accounts.some((x) => x.id === 'claude-later'), false, 'a folder that is not there yet is skipped');
  assert.equal(cliEnv(a, {}).CLAUDE_CONFIG_DIR, dir);
  fs.mkdirSync(path.join(cfg.userHome, '.claude-later'));
  assert.ok(discoverAccounts(cfg).some((x) => x.id === 'claude-later'), 'and found once it is');
});

test('a trailing slash reaches the CLI unchanged', () => {
  const { cfg, dir } = setup({ experiment: true });
  const a = discoverAccounts({ ...cfg, claudeLogins: [{ id: 'p', dir: dir + '/' }] }).find((x) => x.id === 'p');
  assert.equal(a?.configDir, dir + '/');
  assert.equal(cliEnv(a!, {}).CLAUDE_CONFIG_DIR, dir + '/');
});

test('with the experiment off or unset, the list changes nothing', () => {
  for (const experiment of [false, undefined]) {
    const { cfg } = setup({ experiment });
    const without = { ...cfg };
    delete without.claudeLogins;
    assert.deepEqual(discoverAccounts(cfg), discoverAccounts(without), String(experiment));
  }
});

test('a missing, broken or emailless .claude.json still gives the login, titled by its id', () => {
  for (const claudeJson of ['{not json', '', '[]', JSON.stringify({ oauthAccount: null })]) {
    const { cfg } = setup({ experiment: true, claudeJson });
    const a = discoverAccounts(cfg).find((x) => x.id === 'claude-personal');
    assert.equal(a?.title, 'claude-personal', claudeJson);
    assert.equal(a?.email, undefined);
  }
  const { cfg, dir } = setup({ experiment: true });
  fs.rmSync(path.join(dir, '.claude.json'));
  assert.equal(discoverAccounts(cfg).find((x) => x.id === 'claude-personal')?.title, 'claude-personal');
});

test('an id or folder another login has is skipped; notes and hiddenLogins apply', () => {
  const { cfg, dir, root } = setup({ experiment: true });
  fs.mkdirSync(path.join(cfg.accountsDir!, 'claude-1'), { recursive: true });
  fs.mkdirSync(cfg.claudeMainDir, { recursive: true });
  const codexMain = path.join(cfg.userHome, '.codex');
  fs.mkdirSync(codexMain);
  fs.writeFileSync(path.join(codexMain, 'auth.json'), '{}');
  const link = path.join(root, 'link-to-personal');
  fs.symlinkSync(dir, link);
  const base = {
    ...cfg,
    codexMainDir: codexMain,
    accountNotes: { 'claude-personal': 'personal' },
    claudeLogins: [
      { id: 'claude-personal', dir },
      { id: 'again', dir: path.join(cfg.accountsDir!, 'claude-1') + '/' },
      { id: 'main-again', dir: cfg.claudeMainDir },
      { id: 'codex-home', dir: codexMain },
      { id: 'linked', dir: link },
    ],
  };
  const accounts = discoverAccounts(base);
  assert.deepEqual(accounts.map((a) => a.id), ['claude-main', 'claude-1', 'claude-personal', 'codex-main'], 'Claude logins stay before Codex ones');
  assert.equal(accounts.find((a) => a.id === 'claude-personal')?.note, 'personal');
  assert.equal(discoverAccounts({ ...base, hiddenLogins: ['claude-personal'] }).some((a) => a.id === 'claude-personal'), false);
});

test('a link made after the list was read still cannot lead home, to ~/.claude or into an accounts folder', () => {
  const { cfg, root } = setup({ experiment: true });
  fs.mkdirSync(cfg.claudeMainDir, { recursive: true });
  const inAccounts = path.join(cfg.accountsDir!, 'personal');
  fs.mkdirSync(inAccounts, { recursive: true });
  const links = { home: cfg.userHome, main: cfg.claudeMainDir, acct: inAccounts };
  const claudeLogins = Object.entries(links).map(([id, target]) => {
    const dir = path.join(root, `link-${id}`);
    fs.symlinkSync(target, dir);
    return { id, dir };
  });
  claudeLogins.push({ id: 'direct', dir: inAccounts });
  if (process.platform !== 'win32') {
    // Unix follows the link before resolving `..`. Windows resolves `..` first.
    const sub = path.join(cfg.userHome, 'sub');
    const link = path.join(root, 'link-sub');
    fs.mkdirSync(sub);
    fs.symlinkSync(sub, link);
    claudeLogins.push({ id: 'up', dir: `${link}/..` });
  }
  const found = discoverAccounts({ ...cfg, claudeLogins, hiddenLogins: ['claude-main'] }).map((a) => a.id);
  assert.deepEqual(found, []);
});

test('runner.json: with the experiment off the key is not read at all', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-claude-logins-cfg-'));
  const load = (json: object) => {
    fs.writeFileSync(path.join(root, 'runner.json'), JSON.stringify(json));
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.join(' '));
    try {
      return { cfg: loadConfig({ HOME: H, THREADBEAR_HOME: root }), warned: warned.filter((w) => w.includes('claudeLogins')) };
    } finally {
      console.warn = warn;
    }
  };
  for (const experiments of [{}, { claudeLogins: false }]) {
    for (const claudeLogins of ['not a list', [{ dir: '~/.claude-personal' }]]) {
      const r = load({ experiments, claudeLogins });
      assert.equal(r.cfg.claudeLogins, undefined);
      assert.deepEqual(r.warned, []);
    }
  }
  const on = load({ experiments: { claudeLogins: true }, claudeLogins: [{ dir: '~/.claude-personal' }, { id: 'claude-1', dir: '~/.x' }] });
  assert.deepEqual(on.cfg.claudeLogins, [{ id: 'claude-personal', dir: `${H}/.claude-personal` }]);
  assert.equal(on.warned.length, 1);
});

test('a default pool id another pool already has is numbered on', () => {
  const acct = (id: string) => ({ id, provider: 'claude' as const, title: id, configDir: `/x/${id}` });
  const pools = defaultPools([acct('claude-2'), acct('work')], { 'claude-2': 'Work only', work: 'Work too' }, {});
  assert.deepEqual(pools.map((p) => p.id), ['work', 'work-2']);
  const plain = defaultPools([acct('claude-main'), acct('claude')], { claude: 'Claude only' }, {});
  assert.deepEqual(plain.map((p) => p.id), ['claude', 'claude-2']);
  // Another provider's name: that provider's own pool keeps it, though it comes later.
  const codex = { id: 'codex-main', provider: 'codex' as const, title: 'Codex', configDir: '/x/codex' };
  const across = defaultPools([acct('codex'), codex], { codex: 'Codex only' }, {});
  assert.deepEqual(across.map((p) => [p.id, p.accountIds]), [['codex-2', ['codex']], ['codex', ['codex-main']]]);
  // Ids that were each a pool's own stay as they were, so saved choices hold.
  const legacy = defaultPools([acct('claude-1'), acct('claude-2'), acct('claude-3')], { 'claude-1': 'claude-2 first', 'claude-2': 'claude-2 second', 'claude-3': 'claude-2-2 third' }, {});
  assert.deepEqual(legacy.map((p) => [p.id, p.accountIds[0]]), [['claude-2', 'claude-1'], ['claude-2-3', 'claude-2'], ['claude-2-2', 'claude-3']]);
});
