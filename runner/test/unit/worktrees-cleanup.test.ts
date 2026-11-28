// worktrees: cleaning up and teardowns (helpers/worktrees-harness.ts says why it's several files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { checkSequence, checkSummary } from '../helpers/protocol-check.ts';
import { automaticTrust, findWorktreePatch } from '../../src/patches.ts';
import { cleanUpWorktree, git, gitLimits, land, landedOnMain, makeWorktree } from '../../src/worktrees.ts';
import { PatchTrust } from '../../src/patch-trust.ts';
import { HUNG_GIT_LIMIT_MS, KEEP, PATCH, TEARDOWN, capture, commit, harness, lines, makeBranch, makeRepo, notes, sh, swapDuringGit, teardowns, threadWithWorktree, trustedTeardownRepo, until, wrapGit, write } from '../helpers/worktrees-harness.ts';

test('archiving a thread whose branch is all on main removes its worktree and branch; it comes back in a fresh one', async () => {
  const { root, main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  commit(w.path, { 'runner/b.ts': '2\n' }, 'Landed work');
  assert.equal(await land({ path: w.path, branch: w.branch, mainCheckout: main }, capture().opts), 0);
  write(w.path, { 'scratch.txt': 'untracked, so --force\n' });
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.startsWith('Removed')), 'the cleanup');
  assert.equal(notes(h, id).at(-1), `Removed this thread's worktree and its branch ${w.branch}: everything on it is on main.`);
  assert.ok(!fs.existsSync(w.path));
  assert.ok(!fs.existsSync(path.join(root, 'proj-threads')), 'the empty -threads folder goes too');
  assert.equal(sh(main, `git branch --list ${w.branch}`), '');
  const summary = h.runner.get(id);
  assert.equal(summary.worktree, undefined);
  assert.ok(!summary.actions?.some((a) => a.id === 'worktree.land'));
  assert.deepEqual(checkSummary(summary), []);

  // Main has moved on since (another thread's landing).
  commit(main, { 'README.md': 'moved on\n' }, 'Another landing');
  // Sent a message: unarchived, and on in a fresh worktree's runner/, made
  // from main as it is now, not the main checkout other threads share.
  h.runner.send(id, 'More please');
  await until(() => h.adapter.sessions.length === 2, 'a new CLI');
  const fresh = h.runner.get(id).worktree!;
  assert.ok(fresh, 'a Land chip again');
  assert.equal(fresh.branch, w.branch, "the thread's own branch name, made again");
  assert.equal(h.adapter.last.opts.cwd, path.join(fresh.path, 'runner'));
  assert.equal(h.runner.get(id).cwd, path.join(fresh.path, 'runner'));
  assert.equal(sh(fresh.path, 'git rev-parse HEAD'), sh(main, 'git rev-parse main'), 'from main as it is now');
  assert.ok(fs.existsSync(path.join(fresh.path, '.setup-ran')), 'its setup ran');
  assert.ok(notes(h, id).includes(`This thread's worktree was removed when it was archived, so it carries on in a fresh one at ${fresh.path}, on the branch ${fresh.branch}, made from main. tb land puts it on main.`));
  // At the same path, so the session resumes whole rather than handing off
  // a summary of itself to the same folder (Codex's review, 16 Nov 2026).
  assert.equal(fresh.path, w.path);
  assert.equal(h.adapter.last.opts.resume, true, 'the same session, resumed');
  assert.equal(h.runner.threads.get(id)!.rec.handoff, undefined);
  const sent = h.adapter.last.sent.at(-1)!.text;
  assert.match(sent, new RegExp(`^\\[Threadbear\\] Your worktree at ${w.path} was removed after its work landed on main\\. You're now in a fresh worktree of your own at ${fresh.path}`));
  assert.match(sent, /More please$/);
});

test('a thread stopped while its fresh worktree is set up is told of the move with its next message', async () => {
  const { main } = makeRepo(PATCH(`{ setup: "touch .setup-ran; sleep 1" }`));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.startsWith('Removed')), 'the cleanup');
  h.runner.send(id, 'More please');
  await until(() => fs.existsSync(path.join(w.path, '.setup-ran')), 'the fresh worktree');
  // Saved before setup, so a runner stopping now still tells the agent.
  assert.equal(typeof h.runner.threads.get(id)!.rec.agentNotice, 'string');
  h.runner.interrupt(id);
  await until(() => h.runner.get(id).status !== 'running' && h.runner.get(id).status !== 'starting', 'stopped');
  assert.equal(h.adapter.sessions.length, 1, 'no CLI for the stopped turn');
  await until(() => !(h.runner.threads.get(id)!.rt as any).preparing, 'setup done');
  // A slash command would become words with the notice in front of it.
  h.runner.send(id, '/compact');
  await until(() => notes(h, id).some((n) => n.includes('Send one first, then /compact again')), 'the command held');
  assert.equal(h.adapter.sessions.length, 1);
  h.runner.send(id, 'Try again');
  await until(() => h.adapter.sessions.length === 2, 'a new CLI');
  const sent = h.adapter.last.sent.at(-1)!.text;
  assert.match(sent, /^\[Threadbear\] Your worktree at .* was removed after its work landed on main\. You're now in a fresh worktree of your own/);
  assert.match(sent, /Try again$/);
  assert.equal(h.runner.threads.get(id)!.rec.agentNotice, undefined, 'told once');
});

test('a thread archived again while its fresh worktree is made owes its cleanup, and is not set up', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.startsWith('Removed')), 'the cleanup');
  const restore = wrapGit('worktree add', 'sleep 1');
  try {
    h.runner.send(id, 'More please');
    await until(() => (h.runner.threads.get(id)!.rt as any).preparing !== undefined, 'the fresh worktree being made');
    h.runner.update({ threadId: id, archived: true });
    await until(() => notes(h, id).some((n) => n.includes('carries on in a fresh one')), 'made');
  } finally {
    restore();
  }
  // The archive waited for it, then cleaned it up.
  await until(() => !fs.existsSync(w.path), 'the fresh worktree removed');
  assert.equal(h.adapter.sessions.length, 1);
});

test('a thread deleted while its fresh worktree is set up leaves no worktree behind', async () => {
  const { main } = makeRepo(PATCH(`{ setup: "touch .setup-ran; sleep 1" }`));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.startsWith('Removed')), 'the cleanup');
  h.runner.send(id, 'More please');
  // Made, and its setup running.
  await until(() => fs.existsSync(path.join(w.path, '.setup-ran')), 'the fresh worktree');
  h.runner.delete(id);
  await until(() => !fs.existsSync(w.path), 'the fresh worktree removed');
  await until(() => sh(main, `git branch --list ${w.branch}`) === '', 'its branch removed');
  assert.equal(h.adapter.sessions.length, 1, 'no CLI started for it');
});

test("archiving a thread with work that isn't on main keeps the worktree and branch, and says how to land or drop them", async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  commit(w.path, { 'runner/b.ts': '2\n' }, 'Not landed');
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.includes(' stay: ')), 'the cleanup');
  assert.equal(
    notes(h, id).at(-1),
    `This thread's worktree at ${w.path} and its branch ${w.branch} stay: ${w.branch} has commits that aren't on main. ` +
      `To land it, run tb land in ${w.path} (or bring the thread back and press Land). ` +
      `To drop it, git -C ${main} worktree remove --force ${w.path} && git -C ${main} branch -D ${w.branch}.`,
  );
  assert.ok(fs.existsSync(w.path));
  assert.ok(h.runner.get(id).worktree, 'still shown');
});

test('a worktree whose work landed under other commit ids goes, at archive or at the daily sweep', async () => {
  const { main } = makeRepo();
  const h = harness();
  // Landed as a copy (tb land's rebase, or another thread's cherry-pick)
  // before the archive, even when main later edits the same file so
  // merge-tree would conflict: removed then via git cherry.
  const a = await threadWithWorktree(h, main);
  commit(a.w.path, { 'runner/a.ts': 'a\n' }, 'Copied to main');
  sh(main, `git cherry-pick ${sh(a.w.path, 'git rev-parse HEAD')}`);
  commit(main, { 'runner/a.ts': 'a edited later on main\n', 'README.md': 'moved on\n' }, 'Another landing');
  h.runner.update({ threadId: a.id, archived: true });
  await until(() => notes(h, a.id).some((n) => n.startsWith('Removed')), "a's cleanup");
  assert.ok(!fs.existsSync(a.w.path));

  // Not on main at the archive: it stays. Copied to main later, the sweep
  // removes it, and a sweep that finds work still unlanded says nothing.
  const b = await threadWithWorktree(h, main);
  const c = await threadWithWorktree(h, main);
  commit(b.w.path, { 'runner/b.ts': 'b\n' }, 'Landed later');
  commit(c.w.path, { 'runner/c.ts': 'c\n' }, 'Never landed');
  h.runner.update({ threadId: b.id, archived: true });
  h.runner.update({ threadId: c.id, archived: true });
  await until(() => notes(h, b.id).some((n) => n.includes(' stay: ')) && notes(h, c.id).some((n) => n.includes(' stay: ')), 'the first cleanups');
  sh(main, `git cherry-pick ${sh(b.w.path, 'git rev-parse HEAD')}`);
  const cNotes = notes(h, c.id).length;
  assert.equal(await h.runner.sweepArchivedWorktrees(), 1);
  assert.ok(!fs.existsSync(b.w.path));
  assert.equal(sh(main, `git branch --list ${b.w.branch}`), '');
  assert.equal(notes(h, b.id).at(-1), `Removed this thread's worktree and its branch ${b.w.branch}: everything on it is on main.`);
  assert.ok(fs.existsSync(c.w.path));
  assert.equal(notes(h, c.id).length, cNotes, 'no second "stays" note');
  const asks = () => [...h.runner.threads.values()].filter((st) => st.rec.title?.startsWith('Clean up a leftover worktree'));
  assert.equal(asks().length, 0, 'archived just now: not checked yet');

  // Archived 3 days ago and still unlanded: a cleanup thread checks it, once.
  h.runner.threads.get(c.id)!.rec.archivedAt = new Date(Date.parse(h.runner.isoNow()) - 3 * 86_400_000).toISOString();
  await h.runner.sweepArchivedWorktrees();
  assert.equal(asks().length, 1);
  const ask = asks()[0];
  assert.equal(ask.rec.startedBy?.kind, 'runner');
  assert.equal(ask.rec.cwd, main, 'in the repo, with no worktree of its own');
  assert.equal(ask.rec.worktree, undefined);
  const first = h.adapter.sessions.find((s) => s.opts.threadId === ask.rec.id)!.sent[0].text;
  assert.ok(first.includes(`- ${c.w.path} (branch ${c.w.branch}, in ${main}), from the thread`), first);
  assert.ok(first.includes(`It stays because ${c.w.branch} has commits that aren't on main.`));
  assert.ok(first.includes('Remove every safe leftover right away without asking'));
  assert.ok(first.includes('Only if a worktree genuinely holds real unlanded work'));
  assert.ok(fs.existsSync(c.w.path), 'sweep itself did not drop unlanded work');
  await h.runner.sweepArchivedWorktrees();
  assert.equal(asks().length, 1, 'not asked twice');
  // Even once that thread is archived, the same branch tip isn't asked about again.
  h.runner.update({ threadId: ask.rec.id, archived: true });
  await h.runner.sweepArchivedWorktrees();
  assert.equal(asks().length, 1);
});

test('cleanUpWorktree keeps a worktree with uncommitted changes to tracked files', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  write(t.path, { 'README.md': 'edited\n' });
  const rec = { repo: 'proj', mainCheckout: main, path: t.path, branch: t.branch, base: sh(main, 'git rev-parse main') };
  assert.deepEqual(await cleanUpWorktree(rec), { removed: false, reason: 'the worktree has uncommitted changes' });
  assert.ok(fs.existsSync(t.path));
  sh(t.path, 'git checkout -- README.md');
  assert.deepEqual(await cleanUpWorktree(rec), { removed: true });
  assert.ok(!fs.existsSync(t.path));
  assert.equal(sh(main, `git branch --list ${t.branch}`), '');
});

test('deleting a thread removes a landed worktree; an unlanded one stays, with a notice', async () => {
  const { main } = makeRepo();
  const h = harness();
  const a = await threadWithWorktree(h, main);
  h.runner.delete(a.id);
  // The branch goes after the folder.
  await until(() => !fs.existsSync(a.w.path) && sh(main, `git branch --list ${a.w.branch}`) === '', 'the worktree and branch to go');

  const b = await threadWithWorktree(h, main);
  commit(b.w.path, { 'runner/b.ts': '2\n' }, 'Not landed');
  h.runner.delete(b.id);
  await until(() => h.notes.some((n) => n.method === 'runner.notice'), 'the notice');
  const notice = h.notes.find((n) => n.method === 'runner.notice') as { params: { message: string } };
  assert.match(notice.params.message, new RegExp(`^"Go" was deleted, but its worktree at ${b.w.path} and branch ${b.w.branch} stay: ${b.w.branch.replace('/', '\\/')} has commits that aren't on main\\. To land it, run tb land in ${b.w.path}\\. To drop it`));
  assert.ok(fs.existsSync(b.w.path));
});

test('archiving runs the teardown in the worktree root before the cleanup, landed or not', async () => {
  const log = path.join(fs.realpathSync(tmpDir('tb-td-')), 'log');
  const { main } = makeRepo(TEARDOWN(log));
  const h = harness();
  const kept = await threadWithWorktree(h, main);
  commit(kept.w.path, { 'runner/b.ts': '2\n' }, 'Not landed');
  h.runner.update({ threadId: kept.id, archived: true });
  await until(() => notes(h, kept.id).some((n) => n.includes(' stay: ')), 'the cleanup');
  const [run] = teardowns(h, kept.id);
  assert.equal(run?.title, 'Tear down the worktree');
  assert.equal(run?.patch, 'checks');
  assert.equal(run?.actionId, 'checks.worktree-teardown');
  assert.equal(run?.ok, true);
  assert.equal(run?.turnId, undefined);
  assert.match(run?.command ?? '', /^echo \$PWD/);
  assert.ok(fs.existsSync(kept.w.path), 'the unlanded worktree stays');
  assert.deepEqual(checkSequence(h.events(kept.id)), []);

  const landed = await threadWithWorktree(h, main);
  h.runner.update({ threadId: landed.id, archived: true });
  await until(() => notes(h, landed.id).some((n) => n.startsWith('Removed')), 'the cleanup');
  const events = h.events(landed.id);
  const ran = events.findIndex((e) => e.type === 'action.run' && e.trigger === 'worktree.teardown');
  const removed = events.findIndex((e) => e.type === 'system.note' && String(e.text).startsWith('Removed'));
  assert.ok(ran >= 0 && ran < removed, 'the teardown comes before the cleanup');
  assert.ok(!fs.existsSync(landed.w.path));
  assert.deepEqual(lines(log), [`${kept.w.path} there`, `${landed.w.path} there`], 'each ran in its worktree root while its files were there');
});

test('deleting a thread runs its teardown before the worktree goes; a failing one says so in a notice', async () => {
  const dir = fs.realpathSync(tmpDir('tb-td-'));
  const { main } = makeRepo(TEARDOWN(path.join(dir, 'log')));
  const h = harness();
  const a = await threadWithWorktree(h, main);
  h.runner.delete(a.id);
  await until(() => !fs.existsSync(a.w.path), 'the worktree to go');
  assert.deepEqual(lines(path.join(dir, 'log')), [`${a.w.path} there`]);
  assert.equal(h.notes.some((n) => n.method === 'runner.notice'), false, 'nothing to say when it worked');

  const failing = makeRepo(TEARDOWN(path.join(dir, 'log2'), '; echo it broke; exit 3'));
  const h2 = harness();
  const b = await threadWithWorktree(h2, failing.main);
  h2.runner.delete(b.id);
  await until(() => h2.notes.some((n) => n.method === 'runner.notice'), 'the notice');
  const notice = h2.notes.find((n) => n.method === 'runner.notice') as { params: { message: string } };
  assert.match(notice.params.message, /^"Go" was deleted, but its worktree's teardown \(echo \$PWD .*\) failed \(exit code 3\): it broke$/);
  await until(() => !fs.existsSync(b.w.path), 'the worktree to go anyway');
  assert.deepEqual(lines(path.join(dir, 'log2')), [`${b.w.path} there`]);
});

test('a failing teardown is shown and the cleanup still happens', async () => {
  const dir = fs.realpathSync(tmpDir('tb-td-'));
  const { main } = makeRepo(TEARDOWN(path.join(dir, 'log'), '; echo no deployment to remove; exit 3'));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.startsWith('Removed')), 'the cleanup');
  const [run] = teardowns(h, id);
  assert.equal(run?.ok, false);
  assert.equal(run?.exitCode, 3);
  assert.match(run?.text ?? '', /no deployment to remove/);
  assert.ok(!fs.existsSync(w.path));
  assert.equal(sh(main, `git branch --list ${w.branch}`), '');
});

test("an untrusted teardown doesn't run, and says so; a trusted one runs its hashed script", async () => {
  const dir = fs.realpathSync(tmpDir('tb-td-'));
  const log = path.join(dir, 'log');
  const { main } = makeRepo(PATCH(`{ teardown: "./teardown.sh" }`));
  commit(main, { 'teardown.sh': `#!/bin/sh\necho "torn down $PWD" >> ${log}\n` }, 'teardown');
  fs.chmodSync(path.join(main, 'teardown.sh'), 0o755);
  sh(main, 'git add -A && git commit -qm modes');
  const trust = new PatchTrust();
  trust.trustCurrent([path.join(main, '.threadbear/patches/checks.ts')]);
  const h = makeHarness(undefined, {}, { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 10_000, patchTrust: trust });

  const a = await threadWithWorktree(h, main);
  h.runner.update({ threadId: a.id, archived: true });
  await until(() => notes(h, a.id).some((n) => n.startsWith('Removed')), 'the cleanup');
  assert.equal(teardowns(h, a.id)[0]?.command, './teardown.sh');
  assert.deepEqual(lines(log), [`torn down ${a.w.path}`], 'from the worktree, which is the patch\'s folder');

  // A commit on the branch changes what the teardown runs: that's a patch
  // version nobody trusted, so it never runs by itself.
  const b = await threadWithWorktree(h, main);
  commit(b.w.path, { 'teardown.sh': `#!/bin/sh\necho evil >> ${log}\n` }, 'Change the teardown');
  h.runner.update({ threadId: b.id, archived: true });
  await until(() => notes(h, b.id).some((n) => n.includes(' stay: ')), 'the cleanup');
  assert.equal(teardowns(h, b.id).length, 0);
  assert.ok(
    notes(h, b.id).includes("Didn't run the worktree's teardown: its copy of the checks patch isn't a version you've trusted. Trust it in Patches, then run the teardown yourself if you want it."),
    notes(h, b.id).join('\n'),
  );
  assert.deepEqual(lines(log), [`torn down ${a.w.path}`]);
});

test('the teardown runs once per archive: a delete after it skips it, and a thread brought back is told and tears down again', async () => {
  const dir = fs.realpathSync(tmpDir('tb-td-'));
  const log = path.join(dir, 'log');
  const { main } = makeRepo(TEARDOWN(log));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  commit(w.path, { 'runner/b.ts': '2\n' }, 'Not landed');
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.includes(' stay: ')), 'the cleanup');
  assert.equal(lines(log).length, 1);
  assert.ok(h.store.load(id)?.worktree?.tornDownAt, 'remembered, so a runner picking the cleanup up again skips it');

  // Brought back: on in its worktree, told what the teardown may have taken.
  h.runner.send(id, 'More please');
  await until(() => h.adapter.sessions.length === 2, 'a new CLI');
  assert.equal(h.adapter.last.opts.cwd, path.join(w.path, 'runner'));
  assert.ok(notes(h, id).includes("This thread's worktree was torn down when it was archived (its patch's teardown ran), so anything its setup made outside the folder may be gone. It carries on in the worktree."));
  assert.match(h.adapter.last.sent.at(-1)!.text, /\[Threadbear\] Your worktree's teardown ran when this thread was archived/);
  assert.equal(h.store.load(id)?.worktree?.tornDownAt, undefined);
  h.adapter.last.init();
  h.adapter.last.result();

  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).filter((n) => n.includes(' stay: ')).length === 2, 'the second cleanup');
  assert.equal(lines(log).length, 2, 'archived again: torn down again');
  h.runner.delete(id);
  await until(() => h.notes.some((n) => n.method === 'runner.notice'), "the notice that the worktree stays");
  assert.equal(lines(log).length, 2, 'already torn down for this archive');
});

// Codex's review of the teardown, 9 Nov: a patch file that's a link into
// another folder was hashed with its scripts followed from the folder it's
// linked to, but its commands run from the folder holding the link. So a
// script's own `./helper.sh` ran from beside the link, unhashed. (Beside
// the repo's top it happened to be hashed anyway, which hid this from the
// first test of it.) Setup, hooks and actions are bound the same way.
test('a symlinked patch has its scripts followed from where they run, so a helper beside the link is hashed', async () => {
  const dir = fs.realpathSync(tmpDir('tb-td-'));
  const log = path.join(dir, 'log');
  const { main } = makeRepo('');
  write(main, {
    'nested/.threadbear/patches/p.ts': PATCH(`{ setup: "./cleanup.sh", teardown: "./cleanup.sh" }`),
    'nested/cleanup.sh': '#!/bin/sh\n./helper.sh\n',
    'nested/helper.sh': `#!/bin/sh\necho nested >> ${log}\n`,
    'sub/helper.sh': `#!/bin/sh\necho beside >> ${log}\n`,
  });
  for (const f of ['nested/cleanup.sh', 'nested/helper.sh', 'sub/helper.sh']) fs.chmodSync(path.join(main, f), 0o755);
  fs.mkdirSync(path.join(main, 'sub/.threadbear/patches'), { recursive: true });
  fs.symlinkSync(path.join(main, 'nested/.threadbear/patches/p.ts'), path.join(main, 'sub/.threadbear/patches/p.ts'));
  fs.symlinkSync(path.join(main, 'nested/cleanup.sh'), path.join(main, 'sub/cleanup.sh'));
  const patch = path.join(main, 'sub/.threadbear/patches/p.ts');
  const trust = new PatchTrust();
  trust.trustCurrent([patch]);
  const found = await findWorktreePatch(path.join(main, 'sub'), dir, new Map(), undefined, trust);
  assert.ok(found?.teardownRun && found.setupRun);
  // What runs is the helper beside the link, as the command runs there...
  sh(main, found.teardownRun);
  assert.deepEqual(lines(log), ['beside']);
  // ...so changing it is a version nobody trusted, and the check just
  // before a bound command runs says so too.
  fs.writeFileSync(path.join(main, 'sub/helper.sh'), `#!/bin/sh\necho evil >> ${log}\n`);
  assert.equal(await findWorktreePatch(path.join(main, 'sub'), dir, new Map(), undefined, trust), undefined);
  for (const run of [found.teardownRun, found.setupRun]) {
    const by = automaticTrust(run);
    assert.ok(by);
    assert.equal(trust.verify(by.file, by.hash), false);
  }
});

test("a worktree folder swapped for a link to the main checkout gets no teardown, and the main checkout is left alone", async () => {
  const dir = fs.realpathSync(tmpDir('tb-td-'));
  const log = path.join(dir, 'log');
  const { main, h } = trustedTeardownRepo(log);
  const { id, w } = await threadWithWorktree(h, main);
  fs.renameSync(w.path, `${w.path}-moved`);
  fs.symlinkSync(main, w.path);
  h.runner.update({ threadId: id, archived: true });
  const rt = (h.runner as any).threads.get(id).rt;
  await until(() => rt.archivePending === false && !rt.cleaning, 'the cleanup');
  assert.deepEqual(lines(log), [], 'no teardown, in the main checkout or anywhere');
  assert.equal(teardowns(h, id).length, 0);
  assert.equal(sh(main, 'git rev-parse --abbrev-ref HEAD'), 'main', 'the main checkout is still on main');
  assert.equal(sh(main, 'git status --porcelain'), '');
  assert.ok(fs.existsSync(path.join(main, 'README.md')));
  assert.ok(fs.existsSync(path.join(`${w.path}-moved`, 'runner/a.ts')), 'the moved worktree is left alone too');
});

// Codex's second look, 9 Nov: the folder was checked before an await, so a
// swap while git listed the worktrees passed, and the teardown ran in main.
test('a worktree folder swapped for a link while the cleanup waits on git gets no teardown', async () => {
  const dir = fs.realpathSync(tmpDir('tb-td-'));
  const log = path.join(dir, 'log');
  const { main, h } = trustedTeardownRepo(log);
  const { id, w } = await threadWithWorktree(h, main);
  const restore = swapDuringGit('list', w.path, main);
  try {
    h.runner.update({ threadId: id, archived: true });
    const rt = (h.runner as any).threads.get(id).rt;
    await until(() => rt.archivePending === false && !rt.cleaning, 'the cleanup');
  } finally {
    restore();
  }
  assert.ok(fs.lstatSync(w.path).isSymbolicLink(), 'the swap happened');
  assert.deepEqual(lines(log), []);
  assert.equal(teardowns(h, id).length, 0);
  assert.equal(sh(main, 'git rev-parse --abbrev-ref HEAD'), 'main');
  assert.equal(sh(main, 'git status --porcelain'), '');
});

test("a worktree folder swapped for a link while the cleanup reads its status never has main's checkout detached or removed", async () => {
  const { main } = makeRepo(PATCH(`{ keep: ["app/.build"] }`));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  const restore = swapDuringGit('status', w.path, main);
  try {
    h.runner.update({ threadId: id, archived: true });
    const rt = (h.runner as any).threads.get(id).rt;
    await until(() => rt.archivePending === false && !rt.cleaning, 'the cleanup');
  } finally {
    restore();
  }
  assert.ok(fs.lstatSync(w.path).isSymbolicLink(), 'the swap happened');
  assert.equal(sh(main, 'git rev-parse --abbrev-ref HEAD'), 'main', 'main is still checked out in the main checkout');
  assert.ok(fs.existsSync(path.join(main, 'README.md')));
  assert.equal(sh(`${w.path}-moved`, 'git rev-parse --abbrev-ref HEAD'), w.branch, 'the real worktree is left as it was');
});

// Codex's third look, 9 Nov: the removal accepted the folder on any branch,
// so a switch while status ran had --force take edits made on the new one.
test('a worktree switched to another branch while the cleanup reads its status is left alone, edits and all', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  write(t.path, { 'scratch.txt': 'untracked, so it would be --force\n' });
  const restore = wrapGit('status', `out=$("$REAL" "$@"); code=$?; "$REAL" -C '${t.path}' checkout -q -b other; echo edit > '${t.path}/after.txt'; printf '%s\\n' "$out"; exit $code`);
  let result;
  try {
    const rec = { repo: 'proj', mainCheckout: main, path: t.path, branch: t.branch, base: sh(main, 'git rev-parse main') };
    result = await cleanUpWorktree(rec);
  } finally {
    restore();
  }
  assert.deepEqual(result, { removed: false, reason: `its folder ${t.path} changed while it was being cleaned up, so it was left alone` });
  assert.equal(fs.readFileSync(path.join(t.path, 'after.txt'), 'utf8'), 'edit\n');
  assert.equal(sh(t.path, 'git rev-parse --abbrev-ref HEAD'), 'other');
});

test("a git that times out checking the branch is there stops the cleanup, rather than reading as no branch", async () => {
  const { main } = makeRepo(PATCH(`{ keep: ["app/.build"] }`));
  const t = makeBranch(main);
  commit(t.path, { 'runner/b.ts': '2\n' }, 'Not landed');
  const restore = wrapGit('--verify', 'exec sleep 30', HUNG_GIT_LIMIT_MS);
  let result;
  try {
    const rec = { repo: 'proj', mainCheckout: main, path: t.path, branch: t.branch, base: sh(main, 'git rev-parse main'), keep: ['app/.build'] };
    result = await cleanUpWorktree(rec);
  } finally {
    restore();
  }
  assert.deepEqual(result, { removed: false, reason: `git couldn't tell whether ${t.branch} is still there` });
  assert.equal(sh(t.path, 'git rev-parse --abbrev-ref HEAD'), t.branch, 'not detached or pooled');
  assert.ok(!sh(main, 'git worktree list --porcelain').includes('locked'));
});

test("tb land counts a git that times out reading what's to land as a failure, not as nothing to land", async () => {
  for (const [match, said] of [['log', /^Couldn't read what thread\/abcd1234 has to land/], ['rev-list', /^Couldn't read thread\/abcd1234's history/]] as const) {
    const { main } = makeRepo();
    const t = makeBranch(main);
    commit(t.path, { 'runner/b.ts': '2\n' }, 'Work');
    const before = sh(main, 'git rev-parse main');
    const c = capture();
    const restore = wrapGit(match, 'exec sleep 30', HUNG_GIT_LIMIT_MS);
    let code;
    try {
      code = await land(t, c.opts);
    } finally {
      restore();
    }
    assert.equal(code, 1, match);
    assert.ok(!c.out.some((l) => l.startsWith('Nothing to land')), match);
    assert.ok(c.err.some((l) => said.test(l)), `${match}: ${c.err.join('\n')}`);
    assert.equal(sh(main, 'git rev-parse main'), before, `${match}: main didn't move`);
    assert.equal(sh(t.path, 'git rev-list --count main..HEAD'), '1', `${match}: the branch is as it was`);
  }
});

test('git gives up after its time limit, and that counts as a failure', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  const realGit = sh('/', 'command -v git');
  const bin = tmpDir('tb-hang-git-');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" status "*) exec sleep 30 ;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  // Run it once first: macOS checks a new executable the first time it runs,
  // which can take seconds on a busy Mac and eat the time limit below.
  spawnSync(path.join(bin, 'git'), ['--version']);
  const before = process.env.PATH;
  const limit = gitLimits.timeoutMs;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  // Only status hangs; the real git commands around it need time on a busy Mac.
  gitLimits.timeoutMs = 3000;
  try {
    const started = Date.now();
    const r = await git(t.path, ['status', '--porcelain']);
    assert.equal(r.ok, false);
    assert.ok(Date.now() - started < 20_000);
    const rec = { repo: 'proj', mainCheckout: main, path: t.path, branch: t.branch, base: sh(main, 'git rev-parse main') };
    assert.deepEqual(await cleanUpWorktree(rec), { removed: false, reason: `git couldn't read ${t.path}` });
    assert.ok(fs.existsSync(t.path));
  } finally {
    process.env.PATH = before;
    gitLimits.timeoutMs = limit;
  }
});

test("a worktree's patch swapped for a fifo doesn't hold the runner up: the teardown is skipped, saying so, and the cleanup goes on", async () => {
  const dir = fs.realpathSync(tmpDir('tb-td-'));
  const log = path.join(dir, 'log');
  const { main, h } = trustedTeardownRepo(log);
  const { id, w } = await threadWithWorktree(h, main);
  const copy = path.join(w.path, '.threadbear/patches/checks.ts');
  fs.rmSync(copy);
  execFileSync('mkfifo', [copy]);
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.includes(' stay: ')), 'the cleanup');
  assert.ok(notes(h, id).some((n) => n.startsWith("Didn't run the worktree's teardown: ")), notes(h, id).join('\n'));
  assert.deepEqual(lines(log), []);
});

// Daybreak, 10 Nov (finding 79): the patch committed as a link to /dev/zero
// is a source with no end; reading it whole to look for "teardown" would
// fill memory and hold the runner. It's skipped as not a plain file, at once.
test("a worktree's patch swapped for a link to /dev/zero is skipped at once, without reading it", async () => {
  const dir = fs.realpathSync(tmpDir('tb-td-'));
  const log = path.join(dir, 'log');
  const { main, h } = trustedTeardownRepo(log);
  const { id, w } = await threadWithWorktree(h, main);
  const copy = path.join(w.path, '.threadbear/patches/checks.ts');
  fs.rmSync(copy);
  fs.symlinkSync('/dev/zero', copy);
  const started = process.cpuUsage();
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.includes(' stay: ')), 'the cleanup');
  const cpu = process.cpuUsage(started);
  assert.ok(notes(h, id).some((n) => n.startsWith("Didn't run the worktree's teardown: ")), notes(h, id).join('\n'));
  assert.deepEqual(lines(log), []);
  assert.ok(cpu.user + cpu.system < 2_000_000, `cpu ${cpu.user + cpu.system}us`);
});

test('a setup or teardown that ignores SIGTERM still ends at the timeout, so neither the first turn nor the cleanup waits for ever', async () => {
  const STUCK = `trap '' TERM; while :; do sleep 0.2; done`;
  const td = makeRepo(PATCH(`{ teardown: "${STUCK}" }`));
  const h = makeHarness(undefined, {}, { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 300 });
  const { id, w } = await threadWithWorktree(h, td.main);
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.startsWith('Removed')), 'the cleanup, past the teardown');
  assert.deepEqual(teardowns(h, id).map((e) => e.ok), [false]);
  assert.match(teardowns(h, id)[0].text, /Stopped after/);
  assert.ok(!fs.existsSync(w.path));

  const su = makeRepo(PATCH(`{ setup: "${STUCK}" }`));
  const h2 = makeHarness(undefined, {}, { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 300 });
  const { thread } = h2.runner.create({ text: 'Go', accountId: 'claude-3', cwd: su.main });
  await until(() => h2.adapter.sessions.length === 1, 'the first turn, past the setup');
  const setup = h2.events(thread.id).find((e) => e.type === 'action.run' && e.trigger === 'worktree.setup');
  assert.equal(setup?.ok, false);
  assert.match(setup?.text ?? '', /Stopped after/);
});

test('with keep, the teardown still runs before the worktree is kept as a spare', async () => {
  const dir = fs.realpathSync(tmpDir('tb-td-'));
  const log = path.join(dir, 'log');
  const { main } = makeRepo(PATCH(`{ teardown: "echo $PWD $(test -f runner/a.ts && echo there) >> ${log}", keep: ["app/.build"] }`));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.includes('for the next thread')), 'the cleanup');
  assert.equal(teardowns(h, id).length, 1);
  assert.deepEqual(lines(log), [`${w.path} there`]);
  assert.match(sh(main, 'git worktree list --porcelain'), /locked threadbear spare/);
});

test('a handover waits for a running teardown as part of the cleanup', async () => {
  const dir = fs.realpathSync(tmpDir('tb-td-'));
  const log = path.join(dir, 'log');
  const { main } = makeRepo(PATCH(`{ teardown: "sleep 0.4; echo $PWD >> ${log}" }`));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  h.runner.update({ threadId: id, archived: true });
  const rt = (h.runner as any).threads.get(id).rt;
  await until(() => rt.archivePending === false, 'the cleanup to start');
  assert.ok(rt.cleaning, 'the teardown counts as the cleanup');
  const handed: string[] = [];
  await h.runner.beginDrain([], { onHandedOver: (t) => handed.push(t) });
  await until(() => handed.includes(id), 'the handover');
  assert.deepEqual(lines(log), [w.path]);
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'threads', id, 'thread.json'), 'utf8'));
  assert.ok(saved.worktree.removedAt, 'saved once the cleanup after it finished');
  assert.equal(teardowns(h, id).length, 1);
});

// 21 Nov: the cleanup read the worktree's status once, then took a while
// (listing spares, detaching, deleting the branch) before it locked the
// folder as a spare or removed it with --force (for untracked files). An
// edit to a tracked file made in that time went into the spare, where the
// next thread's `git reset --hard` took it, or was removed with the folder.
// borrows.ts already read the status again just before its lock.
for (const keep of [true, false]) {
  test(`an edit made while the cleanup works is kept: the worktree is ${keep ? 'not pooled as a spare' : 'not removed with --force'}`, async () => {
    const { main } = makeRepo(keep ? KEEP : undefined);
    const patch = (await findWorktreePatch(main, path.dirname(main)))!;
    const made = await makeWorktree({ cwd: main, threadId: 'eeeeeeee-1', patch });
    assert.ok(made.ok);
    const w = made.worktree;
    write(w.path, { 'scratch.txt': 'untracked, so a removal is --force\n' });
    // The edit lands just after the cleanup's first status.
    const restore = wrapGit('status', `out=$("$REAL" "$@"); code=$?; printf 'mid-cleanup edit\\n' > '${path.join(w.path, 'README.md')}'; printf '%s\\n' "$out"; exit $code`);
    let result;
    try {
      result = await cleanUpWorktree(w);
    } finally {
      restore();
    }
    assert.equal(result.removed, false, JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(w.path, 'README.md'), 'utf8'), 'mid-cleanup edit\n', 'the edit is still there');
    assert.equal(sh(w.path, 'git rev-parse --abbrev-ref HEAD'), w.branch, 'back on its branch');
    assert.ok(!sh(main, 'git worktree list --porcelain').includes('locked threadbear spare'), 'not a spare');
    // And the next thread doesn't take it.
    const next = await makeWorktree({ cwd: main, threadId: 'ffffffff-1', patch });
    assert.ok(next.ok && next.worktree.path !== w.path);
    assert.equal(fs.readFileSync(path.join(w.path, 'README.md'), 'utf8'), 'mid-cleanup edit\n');
  });
}

// Codex's review, 21 Nov: a commit made while that last status ran (on the
// detached HEAD) left the folder clean, and it was pooled anyway; the next
// thread's checkout from main would leave the commit on no branch.
test('a commit made while the cleanup reads its status the last time keeps the worktree out of the pool', async () => {
  const { main } = makeRepo(KEEP);
  const patch = (await findWorktreePatch(main, path.dirname(main)))!;
  const made = await makeWorktree({ cwd: main, threadId: 'eeeeeeee-2', patch });
  assert.ok(made.ok);
  const w = made.worktree;
  const count = path.join(path.dirname(main), 'status-count');
  const restore = wrapGit('status', `out=$("$REAL" "$@"); code=$?; n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${count}'; if [ $n = 2 ]; then "$REAL" -C '${w.path}' commit -q --allow-empty -m late; fi; printf '%s\\n' "$out"; exit $code`);
  let result;
  try {
    result = await cleanUpWorktree(w);
  } finally {
    restore();
  }
  assert.equal(result.removed, false, JSON.stringify(result));
  assert.ok(!sh(main, 'git worktree list --porcelain').includes('locked threadbear spare'), 'not a spare');
  assert.equal(sh(w.path, 'git log -1 --format=%s'), 'late', 'the commit is still checked out');
});

// Codex's second look, 21 Nov: the branch was checked to be all on main once,
// at the start; a commit made after that was detached at, its branch deleted
// with -D, and the folder pooled (or removed), leaving it on no branch.
for (const keep of [true, false]) {
  test(`a commit made after the cleanup checked the branch stays on it: ${keep ? 'not pooled' : 'not removed'}`, async () => {
    const { main } = makeRepo(keep ? KEEP : undefined);
    const patch = (await findWorktreePatch(main, path.dirname(main)))!;
    const made = await makeWorktree({ cwd: main, threadId: 'eeeeeeee-3', patch });
    assert.ok(made.ok);
    const w = made.worktree;
    const once = path.join(path.dirname(main), 'committed');
    const restore = wrapGit('--is-ancestor', `"$REAL" "$@"; code=$?; if [ ! -e '${once}' ]; then touch '${once}'; echo late > '${path.join(w.path, 'late.txt')}'; "$REAL" -C '${w.path}' add late.txt; "$REAL" -C '${w.path}' commit -qm late; fi; exit $code`);
    let result;
    try {
      result = await cleanUpWorktree(w);
    } finally {
      restore();
    }
    assert.ok(fs.existsSync(once), 'the commit was made mid-cleanup');
    assert.equal(result.removed, false, JSON.stringify(result));
    assert.equal(sh(main, `git log -1 --format=%s ${w.branch}`), 'late', 'still on its branch');
    assert.equal(sh(w.path, 'git rev-parse --abbrev-ref HEAD'), w.branch);
    assert.ok(!sh(main, 'git worktree list --porcelain').includes('locked threadbear spare'));
  });
}

// Codex's third look, 21 Nov: the branch is deleted with update-ref (so only
// as it was checked), which unlike branch -D doesn't refuse a branch some
// checkout is on: one moved with git worktree move, its record left behind.
test('a branch a moved checkout is still on is never deleted by the old record`s cleanup', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  const moved = `${t.path}-moved`;
  sh(main, `git worktree move ${t.path} ${moved}`);
  const rec = { repo: 'proj', mainCheckout: main, path: t.path, branch: t.branch, base: sh(main, 'git rev-parse main') };
  const result = await cleanUpWorktree(rec);
  assert.equal(result.removed, true);
  assert.ok(result.removed && result.branchLeft?.includes('a checkout is on it'), JSON.stringify(result));
  assert.equal(sh(moved, 'git rev-parse --abbrev-ref HEAD'), t.branch, 'still on its branch');
});

test('landedOnMain: counts rebased commits even when main later edits the same file, but never an evil merge', async () => {
  const { main } = makeRepo();

  // Rebased/cherry-picked commit whose file main later modifies (merge-tree conflicts).
  const rebased = makeBranch(main);
  commit(rebased.path, { 'README.md': 'line 1\nline 2\n' }, 'Add line 2');
  const sha = sh(rebased.path, 'git rev-parse HEAD');
  commit(main, { 'other.txt': 'x\n' }, 'Diverge main');
  sh(main, `git cherry-pick ${sha}`);
  commit(main, { 'README.md': 'line 1\nline 2 revised on main\n' }, 'Revise line 2 on main');
  assert.equal(await landedOnMain(main, rebased.branch), true);

  // Merge commit whose own resolution changes a file not on main: git cherry skips merges,
  // so landedOnMain falls back to merge-tree and keeps it.
  const merged = makeBranch(main, 'efgh5678');
  const baseMain = sh(main, 'git rev-parse main');
  commit(main, { 'm.txt': 'from main\n' }, 'Main change');
  sh(merged.path, `git merge --no-ff --no-commit ${sh(main, 'git rev-parse main')}`);
  write(merged.path, { 'evil.txt': 'only in merge commit\n' });
  sh(merged.path, 'git add evil.txt && git commit -m "Evil merge"');
  assert.notEqual(sh(merged.path, 'git rev-parse HEAD'), baseMain);
  assert.equal(await landedOnMain(main, merged.branch), false);
});

test("a leftover worktree whose repo isn't on this machine is skipped by the question, and the rest are still asked about", async () => {
  // A thread archived on another OS (WSL, before a move to native Windows)
  // keeps a main checkout path that doesn't exist here.
  const { main } = makeRepo();
  const h = harness();
  const gone = await threadWithWorktree(h, main);
  const here = await threadWithWorktree(h, main);
  commit(gone.w.path, { 'runner/g.ts': 'g\n' }, 'Never landed');
  commit(here.w.path, { 'runner/h.ts': 'h\n' }, 'Never landed either');
  h.runner.update({ threadId: gone.id, archived: true });
  h.runner.update({ threadId: here.id, archived: true });
  await until(() => notes(h, gone.id).some((n) => n.includes(' stay: ')) && notes(h, here.id).some((n) => n.includes(' stay: ')), 'the first cleanups');
  const elsewhere = path.join(tmpDir(), 'home', 'someone', 'dev', 'repo');
  const old = new Date(Date.parse(h.runner.isoNow()) - 3 * 86_400_000).toISOString();
  for (const id of [gone.id, here.id]) h.runner.threads.get(id)!.rec.archivedAt = old;
  const g = h.runner.threads.get(gone.id)!.rec.worktree!;
  g.mainCheckout = elsewhere;
  g.path = path.join(elsewhere + '-threads', 'slot-1');
  const asks = () => [...h.runner.threads.values()].filter((st) => st.rec.title?.startsWith('Clean up a leftover worktree'));

  await h.runner.sweepArchivedWorktrees();
  assert.equal(asks().length, 1);
  const ask = asks()[0];
  assert.equal(ask.rec.title, 'Clean up a leftover worktree');
  assert.equal(ask.rec.cwd, main);
  const first = h.adapter.sessions.find((s) => s.opts.threadId === ask.rec.id)!.sent[0].text;
  assert.ok(first.includes(here.w.path), first);
  assert.ok(!first.includes(elsewhere), first);

  // Only the unreachable one left: nothing is asked, and nothing throws.
  h.runner.update({ threadId: ask.rec.id, archived: true });
  assert.equal(await h.runner.askAboutStayed([{ st: h.runner.threads.get(gone.id)!, w: g, reason: 'x' }]), undefined);
  assert.equal(asks().length, 1);
});
