// runner.json's claudeLogins (the claudeLogins experiment,
// src/experiments/claudeLogins.md): Claude config folders someone already
// signs in to by hand, such as ~/.claude-personal, run as logins of their own
// without moving them into the accounts folder.
//
// The folder is kept as the string written, with only a leading ~ swapped
// for the home folder: Claude Code names its macOS Keychain item from a hash
// of CLAUDE_CONFIG_DIR as given, so `~/.claude-personal/` or the folder's
// realpath is a different item and the login reads as signed out. Paths are
// only resolved to compare them.
import fs from 'node:fs';
import path from 'node:path';
import { isDirectory } from './fsutil.ts';
import { ACP_AGENTS } from './adapters/acp/agents.ts';

export type ClaudeLogin = { id: string; dir: string };

// The login ids the rest of Threadbear takes (convex/relay.ts checks
// accounts.useReset and accounts.yearToken against the same), safe as a file
// name and a URL part.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// The ids discovery gives on its own: claude-main, codex-main, claude-N, codex-N.
const BUILT_IN = /^(claude|codex)-(main|\d+)$/;
// And the agents' (cursor-main...), installed here or not, so one installed
// later never takes the id from a login that had it.
const ACP_IDS = new Set(Object.values(ACP_AGENTS).map((a) => a.accountId));

// The shell's own expansion of a leading ~, as a string: `~/x` is HOME + `/x`,
// so it matches what `CLAUDE_CONFIG_DIR=~/x claude` passed when it signed in.
function expandTilde(dir: string, userHome: string): string {
  if (dir === '~') return userHome;
  if (dir.startsWith('~/') || (path.sep === '\\' && dir.startsWith('~\\'))) return userHome + dir.slice(1);
  return dir;
}

// A full path: on Windows one with its drive (or a \\server\share), since
// `\x` means a different folder on each drive the CLI might start in.
function isFullPath(dir: string): boolean {
  if (path.sep === '\\') return /^[A-Za-z]:[\\/]/.test(dir) || /^[\\/]{2}[^\\/]+[\\/]/.test(dir);
  return path.isAbsolute(dir);
}

// The folder itself, for comparing: links followed where it exists.
export function sameFolderKey(dir: string): string {
  try {
    // The native one: Node's own collapses `..` before following links, so
    // `<link to ~/x>/..` would compare as the link's folder, not home.
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The list as runner.json gives it; each entry left out says why in `errors`. */
export function parseClaudeLogins(raw: unknown, userHome: string): { logins: ClaudeLogin[]; errors: string[] } {
  const logins: ClaudeLogin[] = [];
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { logins, errors };
  if (!Array.isArray(raw)) return { logins, errors: ['should be a list of { "id", "dir" } entries; ignored'] };
  const ids = new Set<string>();
  const dirs = new Set<string>();
  const home = sameFolderKey(userHome);
  const claudeMain = sameFolderKey(path.join(userHome, '.claude'));
  for (const entry of raw as unknown[]) {
    const e = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as { id?: unknown; dir?: unknown }) : undefined;
    if (!e || typeof e.dir !== 'string' || e.dir.trim() === '') {
      errors.push(`${JSON.stringify(entry)} left out: each entry needs a "dir"`);
      continue;
    }
    if (e.id !== undefined && (typeof e.id !== 'string' || e.id === '')) {
      errors.push(`${JSON.stringify(entry)} left out: "id" should be a name like "claude-personal"`);
      continue;
    }
    const dir = expandTilde(e.dir, userHome);
    const id = typeof e.id === 'string' ? e.id : path.basename(dir).replace(/^\./, '');
    const key = isFullPath(dir) ? sameFolderKey(dir) : '';
    const problem = !isFullPath(dir)
      ? 'its dir should be a full path or start with ~/'
      : dir.split(/[\\/]/).some((part) => part === '.' || part === '..')
        ? 'its dir should name the folder without . or .. in it'
      : !ID.test(id)
        ? 'its id should be up to 64 letters, digits, dashes or underscores, starting with a letter or digit'
        : BUILT_IN.test(id) || ACP_IDS.has(id) || id in Object.prototype
          ? 'its id is one Threadbear gives its own logins; pick another'
          : ids.has(id)
            ? 'an earlier entry has that id'
            : key === claudeMain
              ? '~/.claude is already the claude-main login'
              : key === home
                ? 'its dir is your home folder'
                : dirs.has(key)
                  ? 'an earlier entry lists that folder'
                  : undefined;
    if (problem) {
      errors.push(`${id || JSON.stringify(e.dir)} (${dir}) left out: ${problem}`);
      continue;
    }
    ids.add(id);
    dirs.add(key);
    logins.push({ id, dir });
  }
  return { logins, errors };
}

/**
 * The listed logins discovery should add, given the ids and folders it has
 * already found (and the ids still to come, like the ACP agents'). A folder
 * that doesn't exist yet is skipped, and shows up on a later rescan. One that
 * clashes is skipped with a warning, once per runner. The folders checked
 * when the list was read are checked again here, as a link made since could
 * lead to one: `never` (home, ~/.claude, ~/.codex) can't be one of these
 * logins, and nor can a folder directly in `notIn` (the accounts folders,
 * whose folders Threadbear names, shares and clears itself).
 */
export function claudeLoginsToAdd(
  logins: readonly ClaudeLogin[],
  taken: { ids: Iterable<string>; dirs: Iterable<string> },
  forbidden: { never?: readonly string[]; notIn?: readonly string[] } = {},
): ClaudeLogin[] {
  const ids = new Set(taken.ids);
  const dirs = new Set([...taken.dirs].map(sameFolderKey));
  const never = new Set((forbidden.never ?? []).map(sameFolderKey));
  const notIn = new Set((forbidden.notIn ?? []).map(sameFolderKey));
  const out: ClaudeLogin[] = [];
  for (const login of logins) {
    if (!isDirectory(login.dir)) continue;
    const key = sameFolderKey(login.dir);
    const clash = ids.has(login.id)
      ? 'another login has that id'
      : dirs.has(key)
        ? 'that folder is already a login'
        : never.has(key)
          ? 'that folder is your home folder or another CLI\'s own'
          : notIn.has(path.dirname(key))
            ? 'that folder is in an accounts folder; name it claude-N there instead'
            : undefined;
    if (clash) {
      warnOnce(`runner.json claudeLogins: ${login.id} (${login.dir}) left out: ${clash}`);
      continue;
    }
    ids.add(login.id);
    dirs.add(key);
    out.push(login);
  }
  return out;
}

// Discovery runs every few seconds; a clash is said once.
const warned = new Set<string>();
function warnOnce(line: string): void {
  if (warned.has(line)) return;
  warned.add(line);
  console.warn(line);
}
