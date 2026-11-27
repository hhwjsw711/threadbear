import fs from 'node:fs';
import { TOKEN_FILE, readYearToken } from './year-token.ts';
import { acpAccounts } from './adapters/acp/agents.ts';
import path from 'node:path';
import { isEffortLevel, type Account, type EffortLevel, type ModelChoice } from './protocol.ts';
import type { UsageStore } from './usage.ts';
import { resetHint } from './reset-hint.ts';
import type { Config } from './config.ts';
import { isDirectory } from './fsutil.ts';
import { experimentOn } from './experiments.ts';
import { claudeLoginsToAdd } from './claude-logins.ts';

// What a .claude.json says about its login: oauthAccount's emailAddress,
// organizationType and billingType. Tokens live in the Keychain and are never read; this
// file only names the login and caches its claude.ai profile, which the CLI
// fetches again at most once a day while it runs on that login.
export type LoginProfile = { email?: string; planEnded?: true };

// A lapsed paid plan: the free plan has no Claude Code, so every turn would
// fail. claude-main's cancelled Max ran out on 16 Nov 2026 while the Usage
// panel still offered Sign in… and a weekly reset. The CLI's profile fetch
// that evening still cached organizationType "claude_max" (the API's own
// profile said claude_free); what changed was billingType, "none" where every
// paying login has "stripe_subscription" (Apple and Google in-app plans have
// their own values). So either says it: organizationType "claude_free", or a
// Pro or Max plan with billingType "none". Team and enterprise orgs, an older
// CLI's file without the fields, or values this doesn't know are left usable.
const PERSONAL_PAID = new Set(['claude_pro', 'claude_max']);
export function readLoginProfile(claudeJsonPath: string): LoginProfile | undefined {
  try {
    const raw = fs.readFileSync(claudeJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown; organizationType?: unknown; billingType?: unknown } };
    const o = parsed.oauthAccount;
    const out: LoginProfile = {};
    if (typeof o?.emailAddress === 'string' && o.emailAddress) out.email = o.emailAddress;
    const org = o?.organizationType;
    if (org === 'claude_free' || (typeof org === 'string' && PERSONAL_PAID.has(org) && o?.billingType === 'none')) out.planEnded = true;
    return out;
  } catch {
    return undefined;
  }
}

// The model an account's own settings.json names ("claude-fable-5-1[1m]"),
// which the CLI uses for a session that names none. Only that one key is
// read. Absent, blank or not a string: the CLI's own default.
export function readSettingsModel(settingsPath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { model?: unknown };
    return typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined;
  } catch {
    return undefined;
  }
}

// "claude-fable-5-1[1m]" is the 1M-context form of "claude-fable-5-1".
export function stripModelSuffix(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

// What the runner has learned about an account since it started: the
// CLI's model list (asked once), and the model a thread with none ran on.
export type LearnedAccountInfo = { models?: ModelChoice[]; defaultModel?: string };

// The full id a thread with no model runs on. A turn that showed it wins;
// otherwise the account's settings.json, turned into a full id through the
// CLI's model list when that's known. Nothing set: unknown, since the CLI's
// own default is only reported once it runs.
export function resolveDefaultModel(settingsModel: string | undefined, learned: LearnedAccountInfo | undefined): string | undefined {
  if (learned?.defaultModel) return learned.defaultModel;
  if (!settingsModel) return undefined;
  const row = learned?.models?.find((m) => m.id === settingsModel || m.model === settingsModel);
  return row?.model ?? stripModelSuffix(settingsModel);
}

// The top-level `key = value` lines of a Codex config.toml, before its first
// [table]. Only the named keys are kept; nothing else in the file is read
// into memory past this, and there's no TOML dependency for three strings.
export function readCodexConfig(configTomlPath: string): { model?: string; effort?: EffortLevel; credentialsStore?: string } {
  let text: string;
  try {
    text = fs.readFileSync(configTomlPath, 'utf8');
  } catch {
    return {};
  }
  const out: { model?: string; effort?: EffortLevel; credentialsStore?: string } = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const value = (m[2] ?? m[3] ?? '').trim();
    if (!value) continue;
    if (m[1] === 'model') out.model = value;
    else if (m[1] === 'model_reasoning_effort' && isEffortLevel(value)) out.effort = value;
    else if (m[1] === 'cli_auth_credentials_store') out.credentialsStore = value;
  }
  return out;
}

// A Codex home counts as a login when auth.json exists (checked, never
// opened: it holds the tokens) or config.toml keeps them in the Keychain.
export function isCodexLogin(dir: string): boolean {
  if (!isDirectory(dir)) return false;
  if (fs.existsSync(path.join(dir, 'auth.json'))) return true;
  const store = readCodexConfig(path.join(dir, 'config.toml')).credentialsStore;
  return store === 'keyring' || store === 'auto';
}

export type DiscoveryConfig = Pick<Config, 'claudeMainDir' | 'claudeMainJson' | 'tokenStatsAccountsDir' | 'userHome' | 'pathEnv'> &
  Partial<Pick<Config, 'codexMainDir' | 'accountNotes' | 'hiddenLogins' | 'claudeLogins' | 'accountsDir' | 'home' | 'cursorPath' | 'opencodePath' | 'grokPath' | 'antigravityPath' | 'claudeMainEmail'>>;

// claude-main is ~/.claude (its .claude.json sits at ~/.claude.json);
// codex-main is ~/.codex. Token Stats' Accounts folder holds claude-N and
// codex-N, each its own CLAUDE_CONFIG_DIR or CODEX_HOME. Claude accounts
// come first, so the first account is Claude's.
export function discoverAccounts(cfg: DiscoveryConfig): Account[] {
  const out: Account[] = [];
  if (isDirectory(cfg.claudeMainDir)) {
    // A box's login is given (box-mode.ts), not read: a token login has no oauthAccount.
    const own = cfg.claudeMainEmail ? { email: cfg.claudeMainEmail } : readLoginProfile(cfg.claudeMainJson);
    out.push(claudeAccount('claude-main', cfg.claudeMainDir, own?.email ? own : readLoginProfile(path.join(cfg.claudeMainDir, '.claude.json'))));
  }
  // Token Stats' folder (Mike's app), then the data dir's own accounts
  // folder, which is how anyone else adds a login; the first with an id wins.
  const dirOf = new Map<string, string>();
  for (const root of [cfg.tokenStatsAccountsDir, cfg.accountsDir]) {
    if (!root) continue;
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      names = [];
    }
    for (const n of names) if (!dirOf.has(n)) dirOf.set(n, path.join(root, n));
  }
  const numbered = (prefix: string) =>
    [...dirOf.keys()]
      .map((n) => new RegExp(`^${prefix}-(\\d+)$`).exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map((m) => ({ id: m[0], dir: dirOf.get(m[0])! }));
  for (const { id, dir } of numbered('claude')) {
    if (isDirectory(dir)) out.push(claudeAccount(id, dir, readLoginProfile(path.join(dir, '.claude.json'))));
  }
  const codex = cfg.codexMainDir ? [{ id: 'codex-main', dir: cfg.codexMainDir }] : [];
  for (const { id, dir } of [...codex, ...numbered('codex')]) {
    if (isCodexLogin(dir)) out.push(codexAccount(id, dir));
  }
  const acp = acpAccounts({ home: cfg.userHome, pathEnv: cfg.pathEnv, paths: { cursor: cfg.cursorPath, opencode: cfg.opencodePath, grok: cfg.grokPath, antigravity: cfg.antigravityPath } });
  // Folders runner.json lists (claudeLogins experiment), after the Claude
  // logins found here, so one of those always wins a clash.
  if (cfg.home && cfg.claudeLogins?.length && experimentOn(cfg.home, 'claudeLogins')) {
    const all = [...out, ...acp];
    const claudeCount = out.filter((a) => a.provider === 'claude').length;
    const added = claudeLoginsToAdd(
      cfg.claudeLogins,
      { ids: all.map((a) => a.id), dirs: all.map((a) => a.configDir) },
      {
        never: [cfg.userHome, cfg.claudeMainDir, path.join(cfg.userHome, '.claude'), path.join(cfg.userHome, '.codex'), ...(cfg.codexMainDir ? [cfg.codexMainDir] : [])],
        notIn: [cfg.tokenStatsAccountsDir, ...(cfg.accountsDir ? [cfg.accountsDir] : [])],
      },
    );
    out.splice(claudeCount, 0, ...added.map(({ id, dir }) => claudeAccount(id, dir, readLoginProfile(path.join(dir, '.claude.json')))));
  }
  out.push(...acp);
  for (const a of out) {
    const note = cfg.accountNotes?.[a.id];
    if (note) a.note = note;
  }
  const hidden = new Set(cfg.hiddenLogins ?? []);
  return hidden.size ? out.filter((a) => !hidden.has(a.id)) : out;
}

function claudeAccount(id: string, configDir: string, profile: LoginProfile | undefined): Account {
  const email = profile?.email;
  const account: Account = { id, provider: 'claude', title: email ?? id, configDir };
  if (email) account.email = email;
  if (profile?.planEnded) account.planEnded = true;
  // Only that it has one and when it was made: the token stays in its file.
  const token = readYearToken(configDir);
  if (token) account.yearToken = token.madeAt ? { madeAt: token.madeAt } : {};
  const model = resolveDefaultModel(readSettingsModel(path.join(configDir, 'settings.json')), undefined);
  if (model) account.defaultModel = model;
  return account;
}

function codexAccount(id: string, configDir: string): Account {
  const account: Account = { id, provider: 'codex', title: codexTitle(undefined, id), configDir };
  const conf = readCodexConfig(path.join(configDir, 'config.toml'));
  if (conf.model) account.defaultModel = conf.model;
  if (conf.effort) account.defaultEffort = conf.effort;
  return account;
}

// "Codex · <email>", so an app that only shows titles can tell codex-main
// from a Claude login with the same address.
function codexTitle(email: string | undefined, id: string): string {
  return `Codex · ${email ?? id}`;
}

// The model an account names for sessions that name none: Claude's
// settings.json, Codex's config.toml.
function settingsModel(account: Account): string | undefined {
  if (account.provider === 'codex') return readCodexConfig(path.join(account.configDir, 'config.toml')).model;
  return readSettingsModel(path.join(account.configDir, 'settings.json'));
}

// What the registry needs from the UsageStore (usage.ts).
// `now`, the store's clock, for the reset hint; Date.now() without it.
export type AccountUsageSource = Pick<UsageStore, 'usageFor' | 'identityFor'> & Partial<Pick<UsageStore, 'now'>>;
// What the registry needs from SignInState (sign-in-state.ts).
export type AccountSignInSource = { view(account: Account): { signedOut?: true; loginEndsAt?: string } };

export class AccountRegistry {
  private cfg: DiscoveryConfig;
  private usage?: AccountUsageSource;
  // Set once made (main.ts): it needs this registry's list itself.
  signIn?: AccountSignInSource;
  private cache: Account[] = [];
  private scanned = '';
  private at = 0;
  private learned = new Map<string, LearnedAccountInfo>();
  private listeners = new Set<(accounts: Account[]) => void>();
  // One per Claude login's folder, for its threadbear-token.json.
  private tokenWatchers = new Map<string, fs.FSWatcher>();

  constructor(cfg: DiscoveryConfig, usage?: AccountUsageSource) {
    this.cfg = cfg;
    this.usage = usage;
  }

  // Fired when a rescan finds a different list of accounts (a login added
  // or removed, a new email or default). Usage changes come from the
  // UsageStore's own onChange.
  onChange(fn: (accounts: Account[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The next list() reads the folders again: a login folder was just made or taken away. */
  rescanNow(): void {
    this.at = 0;
  }

  // Re-scans at most every 10 seconds so a newly added login shows up
  // without restarting the runner. Usage is added fresh on every call.
  list(): Account[] {
    if (Date.now() - this.at > 10_000 || this.cache.length === 0) {
      const found = discoverAccounts(this.cfg);
      const key = JSON.stringify(found);
      const changed = this.scanned !== '' && key !== this.scanned;
      this.scanned = key;
      this.cache = found.map((a) => this.enrich(a));
      this.at = Date.now();
      this.watchTokens(found);
      if (changed) {
        const list = this.cache.map((a) => this.withUsage(a));
        for (const fn of this.listeners) fn(list);
      }
    }
    return this.cache.map((a) => this.withUsage(a));
  }

  // A year-long token made, renewed or deleted shows at once, rather than
  // at the next rescan: Mike watched the row sit for about 10 seconds
  // after Year-long token… finished (18 Nov). Only the folder's top level
  // is watched, and only that file's name counts; the helper renames it
  // into place, which is one event.
  private watchTokens(found: Account[]): void {
    for (const a of found) {
      const dir = a.provider === 'claude' ? a.configDir : undefined;
      if (!dir || this.tokenWatchers.has(dir)) continue;
      try {
        const w = fs.watch(dir, { persistent: false }, (_event, file) => {
          if (file != null && String(file) !== TOKEN_FILE) return;
          this.at = 0;
          this.list();
        });
        // A folder taken away: stop, and the next scan that finds it again
        // watches it again.
        w.on('error', () => {
          w.close();
          this.tokenWatchers.delete(dir);
        });
        this.tokenWatchers.set(dir, w);
      } catch {
        // Not watchable here: the 10-second rescan still sees it.
      }
    }
  }

  close(): void {
    for (const w of this.tokenWatchers.values()) w.close();
    this.tokenWatchers.clear();
  }

  // Keeps what a probe or a turn showed about an account. Returns whether
  // anything changed, so the runner can tell its clients.
  learn(id: string, info: LearnedAccountInfo): boolean {
    const have = this.learned.get(id) ?? {};
    const next: LearnedAccountInfo = { ...have };
    if (info.models && JSON.stringify(info.models) !== JSON.stringify(have.models)) next.models = info.models;
    if (info.defaultModel && info.defaultModel !== have.defaultModel) next.defaultModel = info.defaultModel;
    if (JSON.stringify(next) === JSON.stringify(have)) return false;
    this.learned.set(id, next);
    this.cache = this.cache.map((a) => (a.id === id ? this.enrich(a) : a));
    return true;
  }

  private enrich(account: Account): Account {
    const learned = this.learned.get(account.id);
    if (!learned) return account;
    const out: Account = { ...account };
    const model = resolveDefaultModel(settingsModel(account), learned);
    if (model) out.defaultModel = model;
    else delete out.defaultModel;
    if (learned.models) out.models = learned.models;
    return out;
  }

  // Email, plan and title from Token Stats or the account's last reading
  // (they beat .claude.json, which once held a stale address), and usage.
  private withUsage(account: Account): Account {
    const out: Account = { ...account };
    const signIn = this.signIn?.view(account);
    if (signIn?.signedOut) out.signedOut = true;
    if (signIn?.loginEndsAt) out.loginEndsAt = signIn.loginEndsAt;
    if (!this.usage) return out;
    // A lapsed plan's last reading (a reset, "Max") would only promise room
    // that isn't coming, to every client, the phone and older apps
    // included, so none is sent. Pools skip it on planEnded alone.
    const ended = !!out.planEnded;
    const id = this.usage.identityFor(account);
    if (id.email) out.email = id.email;
    if (id.plan && !ended) out.plan = id.plan;
    out.title = out.provider === 'codex' ? codexTitle(out.email, out.id) : out.provider === 'claude' ? (out.email ?? out.id) : out.title;
    const usage = ended ? undefined : this.usage.usageFor(out);
    if (usage) out.usage = usage;
    const hint = resetHint(out, this.usage.now?.() ?? Date.now());
    if (hint) out.resetHint = hint;
    return out;
  }

  get(id: string): Account | undefined {
    return this.list().find((a) => a.id === id);
  }
}
