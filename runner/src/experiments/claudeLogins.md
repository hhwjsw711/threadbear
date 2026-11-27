---
id: claudeLogins
name: Existing Claude folders
title: Existing Claude folders: runner.json's claudeLogins lists Claude config folders you sign in to by hand, as logins
added: 2026-11-27
on: false
reminder: bbea581a
---

## What it does

Lets you use a Claude config folder you already sign in to by hand, such as `~/.claude-personal`, as a login of its own, without moving it into the accounts folder. List it in `runner.json`: `"claudeLogins": [{ "id": "claude-personal", "dir": "~/.claude-personal" }]`. The id is optional and defaults to the folder's name without its leading dot. Each listed folder that exists shows up in the account menu and the Usage panel, with the email from its `.claude.json`, and Claude runs there with `CLAUDE_CONFIG_DIR` set to it. The folder is used exactly as written, with only a leading `~` expanded, because Claude Code names its Keychain item from that exact string: write it as you do when you sign in, trailing slash or not, as another spelling of the same folder reads as signed out. An id is up to 64 letters, digits, dashes or underscores. An entry is left out, with a warning in the runner's log, when its id is one Threadbear gives its own logins (`claude-main`, `codex-main`, `claude-3`, `codex-2`, or an agent's like `cursor-main`) or an earlier entry's or another login's, when its folder is `~/.claude` (that's claude-main), `~/.codex`, your home folder, a folder already listed or already a login, or one directly in an accounts folder (name it `claude-N` there instead), or when its path isn't a full one (on Windows, with its drive) or has a `.` or `..` in it. Folders are checked again on each rescan, so a link made later can't lead to one of those. The runner reads the list when it starts, so restart it after turning the experiment on or editing the list; a folder that doesn't exist yet appears once it does. `hiddenLogins` and `accountNotes` work on these logins as on any other.

## Lives in

`runner/src/claude-logins.ts` (reading the list, and which entries discovery adds); `uniqueIds` in `runner/src/pools.ts`, which numbers on a default pool id that clashes (kept when taking it out); `claudeLogins` in `runner/src/config.ts` (`Config`, `RunnerJson`, `loadConfig`); the claudeLogins block in `discoverAccounts` in `runner/src/accounts.ts`; its test `runner/test/unit/claude-logins.test.ts`.

## Taking it out

Delete `runner/src/claude-logins.ts`, `runner/test/unit/claude-logins.test.ts` and this file, the `claudeLogins` lines in `runner/src/config.ts` and the claudeLogins block in `discoverAccounts` (`runner/src/accounts.ts`), and the claudeLogins paragraphs in `docs/guide.md` and `docs/on-your-mac.md`, then run `npm run experiment-docs`. Logins people added this way go from the list; their folders are left as they are.
