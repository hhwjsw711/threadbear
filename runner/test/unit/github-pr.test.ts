import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrUrl, fetchPr, fetchPrFiles, prAct, splitPatch, prStates, prStatus, forgetStates } from '../../src/github-pr.ts';
import type { Gh } from '../../src/land-gate.ts';

const view = {
  number: 72,
  title: 'Fewer approvals in forks',
  url: 'https://github.com/acme/app/pull/72',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'ian', name: 'Ian' },
  headRefName: 'approvals-fixes',
  baseRefName: 'main',
  additions: 33,
  deletions: 11,
  changedFiles: 2,
  body: 'Changes from a fork.',
  createdAt: '2026-11-17T07:00:00Z',
  mergedAt: null,
  closedAt: null,
  mergedBy: null,
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'Quick check', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-17T07:15:00Z', completedAt: '2026-11-17T07:16:04Z', detailsUrl: 'https://x/1', workflowName: 'CI' },
    { __typename: 'CheckRun', name: 'Windows', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-17T07:15:00Z', completedAt: '2026-11-17T07:22:31Z', detailsUrl: 'https://x/2', workflowName: 'Desktop' },
    { __typename: 'CheckRun', name: 'Linux', status: 'IN_PROGRESS', conclusion: '', startedAt: '2026-11-17T07:15:00Z', completedAt: null, detailsUrl: 'https://x/3', workflowName: 'Desktop' },
    { __typename: 'StatusContext', context: 'vercel', state: 'SUCCESS', targetUrl: 'https://v' },
  ],
  comments: [{ author: { login: 'mike' }, body: 'Thanks!', createdAt: '2026-11-17T09:00:00Z' }],
  reviews: [{ author: { login: 'bot' }, state: 'APPROVED', body: '', submittedAt: '2026-11-17T08:00:00Z' }],
};
const repo = { viewerPermission: 'ADMIN', rebaseMergeAllowed: true, squashMergeAllowed: true, mergeCommitAllowed: false };
const patch = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  '+more',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/old name.md b/new name.md',
  'similarity index 90%',
  'rename from old name.md',
  'rename to new name.md',
  '',
].join('\n');

function fakeGh(calls: string[][], answers: Record<string, { ok: boolean; stdout: string; stderr?: string }>): Gh {
  return async (args) => {
    calls.push(args);
    const key = Object.keys(answers).find((k) => args.join(' ').startsWith(k));
    const a = key ? answers[key] : { ok: false, stdout: '', stderr: 'unexpected' };
    return { ok: a.ok, stdout: a.stdout, stderr: a.stderr ?? '' };
  };
}

test('parsePrUrl takes github PR links and nothing else', () => {
  assert.deepEqual(parsePrUrl('https://github.com/acme/app/pull/72'), { owner: 'acme', repo: 'app', number: 72 });
  assert.deepEqual(parsePrUrl('https://github.com/acme/app/pull/72/files#diff-1'), { owner: 'acme', repo: 'app', number: 72 });
  assert.deepEqual(parsePrUrl('https://www.github.com/a.b/c-d/pull/3?x=1'), { owner: 'a.b', repo: 'c-d', number: 3 });
  assert.equal(parsePrUrl('https://github.com/acme/app/issues/72'), undefined);
  assert.equal(parsePrUrl('https://evil.com/acme/app/pull/72'), undefined);
  assert.equal(parsePrUrl('https://github.com/-x/app/pull/1'), undefined, 'no names gh would read as a flag');
  assert.equal(parsePrUrl('http://github.com/acme/app/pull/0'), undefined);
});

test('splitPatch gives each file its hunks, binary and renamed ones too', () => {
  const files = splitPatch(patch);
  assert.equal(files.length, 3);
  assert.deepEqual(files[0], { path: 'src/a.ts', additions: 2, deletions: 1, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-old', '+new', '+more'] }] });
  assert.equal(files[1].path, 'img.png');
  assert.equal(files[1].binary, true);
  assert.equal(files[2].path, 'new name.md');
  assert.equal(files[2].from, 'old name.md');
});

test('fetchPr reads the PR, its repo and its diff through gh -R, outside any repo', async () => {
  const calls: string[][] = [];
  const gh = fakeGh(calls, {
    'pr view': { ok: true, stdout: JSON.stringify(view) },
    'repo view': { ok: true, stdout: JSON.stringify(repo) },
    'pr diff': { ok: true, stdout: patch },
  });
  const pr = await fetchPr({ owner: 'acme', repo: 'app', number: 72 }, gh);
  for (const c of calls) assert.ok(c.includes('acme/app') && (c[0] === 'repo' || c.includes('-R')), c.join(' '));
  assert.equal(pr.state, 'open');
  assert.equal(pr.author, 'ian');
  assert.equal(pr.head, 'approvals-fixes');
  assert.equal(pr.mergeable, 'yes');
  assert.equal(pr.canMerge, true);
  assert.deepEqual(pr.mergeMethods, ['rebase', 'squash']);
  assert.deepEqual(
    pr.checks.map((c) => [c.name, c.state]),
    [['Windows', 'failed'], ['Linux', 'running'], ['Quick check', 'passed'], ['vercel', 'passed']],
    'failed first, then running, then passed',
  );
  assert.equal(pr.checks.find((c) => c.name === 'Quick check')?.seconds, 64);
  assert.deepEqual(pr.activity.map((a) => [a.kind, a.author]), [['review', 'bot'], ['comment', 'mike']], 'oldest first');
  assert.equal(pr.activity[0].review, 'approved');
  assert.equal(pr.files.length, 3);
});

test('fetchPr still answers when the diff or repo read fails', async () => {
  const gh = fakeGh([], { 'pr view': { ok: true, stdout: JSON.stringify({ ...view, state: 'MERGED', mergedBy: { login: 'mike' } }) } });
  const pr = await fetchPr({ owner: 'acme', repo: 'app', number: 72 }, gh);
  assert.equal(pr.state, 'merged');
  assert.equal(pr.mergedBy, 'mike');
  assert.equal(pr.canMerge, false);
  assert.deepEqual(pr.files, []);
  assert.equal(pr.filesError, 'unexpected');
});

test('without its files, fetchPr skips the diff and says they come later', async () => {
  const calls: string[][] = [];
  const gh = fakeGh(calls, {
    'pr view': { ok: true, stdout: JSON.stringify(view) },
    'repo view': { ok: true, stdout: JSON.stringify(repo) },
  });
  const pr = await fetchPr({ owner: 'acme', repo: 'app', number: 72 }, gh, { files: false });
  assert.ok(!calls.some((c) => c[1] === 'diff'), 'no gh pr diff');
  assert.deepEqual(pr.files, []);
  assert.equal(pr.filesLater, true);
  assert.equal(pr.filesError, undefined);
});

test('fetchPrFiles reads only the diff, through gh -R', async () => {
  const calls: string[][] = [];
  const gh = fakeGh(calls, { 'pr diff': { ok: true, stdout: patch } });
  const got = await fetchPrFiles({ owner: 'acme', repo: 'app', number: 72 }, gh);
  assert.deepEqual(calls, [['pr', 'diff', '72', '-R', 'acme/app']]);
  assert.deepEqual(got.files.map((f) => f.path), ['src/a.ts', 'img.png', 'new name.md']);
  const failed = await fetchPrFiles({ owner: 'acme', repo: 'app', number: 72 }, fakeGh([], {}));
  assert.deepEqual(failed, { files: [], filesError: 'unexpected' });
});

test("fetchPr's error says what gh said", async () => {
  const gh = fakeGh([], { 'pr view': { ok: false, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest' } });
  await assert.rejects(fetchPr({ owner: 'acme', repo: 'app', number: 9 }, gh), /Could not resolve/);
});

test('a draft is its own state', async () => {
  const gh = fakeGh([], { 'pr view': { ok: true, stdout: JSON.stringify({ ...view, isDraft: true }) } });
  assert.equal((await fetchPr({ owner: 'acme', repo: 'app', number: 72 }, gh)).state, 'draft');
});

test('prAct runs the matching gh command, body through a flag, never a shell', async () => {
  const ref = { owner: 'acme', repo: 'app', number: 72 };
  const calls: string[][] = [];
  const gh = fakeGh(calls, { 'pr ': { ok: true, stdout: '' } });
  await prAct(ref, { action: 'merge', method: 'rebase' }, gh);
  await prAct(ref, { action: 'merge', method: 'squash' }, gh);
  await prAct(ref, { action: 'close' }, gh);
  await prAct(ref, { action: 'reopen' }, gh);
  await prAct(ref, { action: 'comment', body: '--admin; rm -rf /' }, gh);
  await prAct(ref, { action: 'approve' }, gh);
  await prAct(ref, { action: 'requestChanges', body: 'Please rebase' }, gh);
  assert.deepEqual(calls, [
    ['pr', 'merge', '72', '-R', 'acme/app', '--rebase'],
    ['pr', 'merge', '72', '-R', 'acme/app', '--squash'],
    ['pr', 'close', '72', '-R', 'acme/app'],
    ['pr', 'reopen', '72', '-R', 'acme/app'],
    ['pr', 'comment', '72', '-R', 'acme/app', '--body=--admin; rm -rf /'],
    ['pr', 'review', '72', '-R', 'acme/app', '--approve'],
    ['pr', 'review', '72', '-R', 'acme/app', '--request-changes', '--body=Please rebase'],
  ]);
});

test('prAct refuses what it should and passes on gh errors', async () => {
  const ref = { owner: 'acme', repo: 'app', number: 72 };
  const ok = fakeGh([], { 'pr ': { ok: true, stdout: '' } });
  await assert.rejects(prAct(ref, { action: 'comment', body: '  ' }, ok), /comment is empty/);
  await assert.rejects(prAct(ref, { action: 'requestChanges' }, ok), /say what to change/);
  await assert.rejects(prAct(ref, { action: 'merge', method: 'octopus' as any }, ok), /method/);
  await assert.rejects(prAct(ref, { action: 'delete' as any }, ok), /action/);
  const no = fakeGh([], { 'pr ': { ok: false, stdout: '', stderr: 'Pull request is not mergeable' } });
  await assert.rejects(prAct(ref, { action: 'merge', method: 'rebase' }, no), /not mergeable/);
});

test('prStates asks once per repo and keeps the answer a while', async () => {
  const calls: string[][] = [];
  const gh = fakeGh(calls, {
    'pr list -R acme/app': { ok: true, stdout: JSON.stringify([{ number: 72, state: 'OPEN', isDraft: false }, { number: 44, state: 'MERGED', isDraft: false }]) },
    'pr list -R acme/other': { ok: true, stdout: JSON.stringify([{ number: 3, state: 'OPEN', isDraft: true }]) },
  });
  const urls = ['https://github.com/acme/app/pull/72', 'https://github.com/acme/app/pull/44', 'https://github.com/acme/other/pull/3', 'https://github.com/acme/app/pull/999', 'https://example.com/x'];
  const states = await prStates(urls, gh, 1000);
  assert.deepEqual(states, {
    'https://github.com/acme/app/pull/72': 'open',
    'https://github.com/acme/app/pull/44': 'merged',
    'https://github.com/acme/other/pull/3': 'draft',
  });
  assert.equal(calls.length, 2);
  await prStates(urls.slice(0, 2), gh, 1000);
  assert.equal(calls.length, 2, 'cached');
});

test('prStatus asks for every PR in one GraphQL call and keeps the answers 30 seconds', async () => {
  const calls: string[][] = [];
  const data = {
    p0: { pullRequest: { title: 'Fix invoice totals', state: 'OPEN', isDraft: false, mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED', updatedAt: '2026-11-20T08:00:00Z', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] }, reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] } } },
    p1: { pullRequest: { title: 'Retry webhooks', state: 'MERGED', isDraft: false, mergeable: 'UNKNOWN', reviewDecision: 'APPROVED', updatedAt: '2026-11-19T08:00:00Z', commits: { nodes: [{ commit: { statusCheckRollup: null } }] }, reviewThreads: { nodes: [] } } },
    p2: null,
  };
  // A repo it can't see: GraphQL answers the rest and gh exits non-zero.
  const gh = fakeGh(calls, { 'api graphql': { ok: false, stdout: JSON.stringify({ data, errors: [{ message: 'Could not resolve' }] }) } });
  const urls = ['https://github.com/acme/api/pull/4940', 'https://github.com/acme/emmi/pull/96', 'https://github.com/secret/x/pull/1', 'https://github.com/acme/api/pull/4940/files', 'https://example.com/x'];
  const out = await prStatus(urls, gh, 1000);
  assert.equal(calls.length, 1);
  const query = calls[0].at(-1)!;
  assert.match(query, /^query=\{p0:repository\(owner:"acme",name:"api"\)\{pullRequest\(number:4940\)/);
  assert.match(query, /p2:repository\(owner:"secret",name:"x"\)/);
  assert.doesNotMatch(query, /p3:/, 'the same PR linked twice is asked once');
  assert.deepEqual(out['https://github.com/acme/api/pull/4940'], { title: 'Fix invoice totals', state: 'open', ci: 'failed', review: 'changes', mergeable: 'conflicts', unresolved: 2, updatedAt: '2026-11-20T08:00:00Z' });
  assert.equal(out['https://github.com/acme/api/pull/4940/files']?.title, 'Fix invoice totals');
  assert.deepEqual(out['https://github.com/acme/emmi/pull/96'], { title: 'Retry webhooks', state: 'merged', ci: '', review: 'approved', mergeable: 'unknown', unresolved: 0, updatedAt: '2026-11-19T08:00:00Z' });
  assert.equal(out['https://github.com/secret/x/pull/1'], undefined);
  assert.equal(Object.keys(out).length, 3);

  await prStatus(urls.slice(0, 2), gh, 20_000);
  assert.equal(calls.length, 1, 'cached');
  forgetStates({ owner: 'acme', repo: 'api', number: 4940 });
  await prStatus(urls.slice(0, 2), gh, 20_000);
  assert.equal(calls.length, 2, 'a merge or close forgets it');
  assert.match(calls[1].at(-1)!, /^query=\{p0:repository\(owner:"acme",name:"api"\)[^]*\}\}\}$/);
  assert.doesNotMatch(calls[1].at(-1)!, /p1:/, 'the other is still fresh');
});

test('prStatus fails when gh answers nothing', async () => {
  const gh = fakeGh([], { 'api graphql': { ok: false, stdout: '', stderr: 'gh: To get started, run: gh auth login' } });
  await assert.rejects(prStatus(['https://github.com/acme/new/pull/1'], gh, 1000), /gh auth login/);
});

test('without gh installed, a read says to install it rather than spawn ENOENT', async () => {
  const gh = fakeGh([], { 'pr view': { ok: false, stdout: '', stderr: 'spawn gh ENOENT' } });
  await assert.rejects(fetchPr({ owner: 'acme', repo: 'app', number: 72 }, gh), /needs the gh command line tool/);
});
