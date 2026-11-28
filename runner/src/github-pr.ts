// A GitHub pull request read and acted on through the gh CLI, for the app's
// PR view: a PR link clicked in a reply opens as a tab in the side pane
// (docs/protocol/panels.md, "Pull requests"). Mike asked
// for it on 18 Nov after trying Capy, which opens PRs beside the chat rather
// than sending you to the browser.
//
// Every gh call names the repo with -R and runs from the temp folder, never a
// checkout, so no repo's own git config or hooks run under it (as
// loose-ends.ts's githubPr). What's sent to GitHub is only what the person
// clicked: a merge, a close, a review, or the comment they typed.
import os from 'node:os';
import { gh as realGh, type Gh } from './land-gate.ts';
import { parseHunks } from './adapters/codex/normalize.ts';
import type { Hunk } from './protocol.ts';

export type PrRef = { owner: string; repo: string; number: number };
export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export type CheckState = 'passed' | 'failed' | 'running' | 'pending' | 'skipped';
export type MergeMethod = 'rebase' | 'squash' | 'merge';
export type PrFile = { path: string; from?: string; additions: number; deletions: number; hunks: Hunk[]; binary?: boolean };
export type PrCheck = { name: string; state: CheckState; url?: string; seconds?: number };
export type PrActivity = { kind: 'comment' | 'review'; author: string; body: string; at: string; review?: 'approved' | 'changes' | 'commented' | 'dismissed' };
export type PrView = {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  state: PrState;
  head: string;
  base: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  body: string;
  createdAt: string;
  mergedAt?: string;
  closedAt?: string;
  mergedBy?: string;
  /** GitHub's review decision: approved, changes (requested), required, or "". */
  review: string;
  /** Whether it merges cleanly: yes, conflicts, or unknown (GitHub still working it out). */
  mergeable: 'yes' | 'conflicts' | 'unknown';
  /** The signed-in gh account can merge and close it (write access or more). */
  canMerge: boolean;
  /** The merge methods the repo allows, in the order the Merge menu lists them. */
  mergeMethods: MergeMethod[];
  checks: PrCheck[];
  activity: PrActivity[];
  files: PrFile[];
  /** Why files is empty when it shouldn't be (the diff couldn't be read). */
  filesError?: string;
  /** Lines left out of a very large diff. */
  filesCut?: number;
  /** Asked for without its files: they come from `fetchPrFiles`. */
  filesLater?: boolean;
};

export type PrFiles = Pick<PrView, 'files' | 'filesError' | 'filesCut'>;

// A name gh takes as a repo: GitHub's own rules, and never starting with a
// "-" that gh would read as a flag.
const NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const PR_URL = /^https:\/\/(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)\/pull\/(\d+)(?:[/?#]|$)/i;

export function parsePrUrl(url: string): PrRef | undefined {
  const m = PR_URL.exec(url.trim());
  if (!m || !NAME.test(m[1]) || !NAME.test(m[2])) return undefined;
  const number = Number(m[3]);
  return number > 0 && Number.isSafeInteger(number) ? { owner: m[1], repo: m[2], number } : undefined;
}

const repoArg = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`;
// No gh on this Mac is a stranger's likeliest failure: say what to do about it.
const failed = (stderr: string) =>
  /\bENOENT\b/.test(stderr) ? 'Opening PRs here needs the gh command line tool: install it and run gh auth login.' : stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ') || 'gh failed';
// gh from the temp folder (see the top).
const run = (gh: Gh, args: string[]) => gh(args, os.tmpdir());

// A very large PR's diff is cut here: the pane draws every line it's given.
const MAX_DIFF_LINES = 20_000;

/** A whole-PR patch (`gh pr diff`) as files with their hunks. */
export function splitPatch(patch: string): PrFile[] {
  const files: PrFile[] = [];
  const parts = patch.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '));
  for (const part of parts) {
    const head = part.slice(0, part.indexOf('\n') === -1 ? undefined : part.indexOf('\n'));
    // "diff --git a/x b/y": the paths can hold spaces, so the rename lines
    // and +++ say it better when they're there.
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(head);
    const renameFrom = /^rename from (.*)$/m.exec(part)?.[1];
    const renameTo = /^rename to (.*)$/m.exec(part)?.[1];
    const plus = /^\+\+\+ b\/(.*)$/m.exec(part)?.[1];
    const minus = /^--- a\/(.*)$/m.exec(part)?.[1];
    const path = renameTo ?? plus ?? m?.[2] ?? minus ?? '';
    if (!path) continue;
    const hunks = parseHunks(part);
    let additions = 0;
    let deletions = 0;
    for (const h of hunks)
      for (const l of h.lines) {
        if (l.startsWith('+')) additions++;
        else if (l.startsWith('-')) deletions++;
      }
    const file: PrFile = { path, additions, deletions, hunks };
    if (renameFrom && renameFrom !== path) file.from = renameFrom;
    if (/^Binary files /m.test(part)) file.binary = true;
    files.push(file);
  }
  return files;
}

function cutFiles(files: PrFile[]): { files: PrFile[]; cut: number } {
  let left = MAX_DIFF_LINES;
  let cut = 0;
  for (const f of files)
    for (const h of f.hunks) {
      if (h.lines.length <= left) left -= h.lines.length;
      else {
        cut += h.lines.length - left;
        h.lines = h.lines.slice(0, left);
        left = 0;
      }
    }
  for (const f of files) f.hunks = f.hunks.filter((h) => h.lines.length);
  return { files, cut };
}

function checkState(c: any): CheckState {
  const s = String(c.status ?? '').toUpperCase();
  const v = String(c.conclusion || c.state || '').toUpperCase();
  if (c.__typename === 'CheckRun' && s && s !== 'COMPLETED') return s === 'IN_PROGRESS' ? 'running' : 'pending';
  if (v === 'SUCCESS' || v === 'NEUTRAL') return 'passed';
  if (v === 'SKIPPED' || v === 'CANCELLED' || v === 'STALE') return 'skipped';
  if (v === 'PENDING' || v === 'EXPECTED') return 'pending';
  if (!v) return 'pending';
  return 'failed';
}

const CHECK_ORDER: CheckState[] = ['failed', 'running', 'pending', 'passed', 'skipped'];

function checks(rollup: any[]): PrCheck[] {
  const out = rollup.map((c): PrCheck => {
    const check: PrCheck = { name: String(c.name || c.context || 'Check'), state: checkState(c) };
    const url = c.detailsUrl || c.targetUrl;
    if (typeof url === 'string' && url.startsWith('https://')) check.url = url;
    const from = Date.parse(c.startedAt);
    const to = Date.parse(c.completedAt);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from) check.seconds = Math.round((to - from) / 1000);
    return check;
  });
  // Failed first: that's what decides whether to merge. Stable within a state.
  return out.map((c, i) => [c, i] as const).sort((a, b) => CHECK_ORDER.indexOf(a[0].state) - CHECK_ORDER.indexOf(b[0].state) || a[1] - b[1]).map(([c]) => c);
}

const REVIEW: Record<string, PrActivity['review']> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'dismissed' };

function activity(comments: any[], reviews: any[]): PrActivity[] {
  const out: PrActivity[] = [];
  for (const c of comments ?? []) out.push({ kind: 'comment', author: String(c.author?.login ?? 'ghost'), body: String(c.body ?? ''), at: String(c.createdAt ?? '') });
  for (const r of reviews ?? []) {
    const review = REVIEW[String(r.state ?? '')];
    if (!review || review === 'dismissed' || (review === 'commented' && !String(r.body ?? '').trim())) continue;
    out.push({ kind: 'review', author: String(r.author?.login ?? 'ghost'), body: String(r.body ?? ''), at: String(r.submittedAt ?? ''), review });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

function prState(v: any): PrState {
  const s = String(v.state ?? '').toUpperCase();
  if (s === 'MERGED') return 'merged';
  if (s === 'CLOSED') return 'closed';
  return v.isDraft ? 'draft' : 'open';
}

const VIEW_FIELDS = 'number,title,url,state,isDraft,author,headRefName,baseRefName,additions,deletions,changedFiles,body,createdAt,mergedAt,closedAt,mergedBy,reviewDecision,mergeable,statusCheckRollup,comments,reviews';

/** A PR's files, from its whole diff. A big PR's diff is the slowest of
 *  the reads (two seconds for 600 KB, 19 Nov), so the app asks for it
 *  apart and shows the rest first. */
export async function fetchPrFiles(ref: PrRef, gh: Gh = realGh): Promise<PrFiles> {
  return prFiles(await run(gh, ['pr', 'diff', String(ref.number), '-R', repoArg(ref)]));
}

function prFiles(diffOut: { ok: boolean; stdout: string; stderr: string }): PrFiles {
  if (!diffOut.ok) return { files: [], filesError: failed(diffOut.stderr) };
  const { files, cut } = cutFiles(splitPatch(diffOut.stdout));
  return cut ? { files, filesCut: cut } : { files };
}

/** The PR. With `files: false`, without its files (`filesLater`). */
export async function fetchPr(ref: PrRef, gh: Gh = realGh, opts: { files?: boolean } = {}): Promise<PrView> {
  const R = repoArg(ref);
  const n = String(ref.number);
  const withFiles = opts.files !== false;
  const [viewOut, repoOut, files] = await Promise.all([
    run(gh, ['pr', 'view', n, '-R', R, '--json', VIEW_FIELDS]),
    run(gh, ['repo', 'view', R, '--json', 'viewerPermission,rebaseMergeAllowed,squashMergeAllowed,mergeCommitAllowed']),
    withFiles ? fetchPrFiles(ref, gh) : undefined,
  ]);
  if (!viewOut.ok) throw new Error(failed(viewOut.stderr));
  const v = JSON.parse(viewOut.stdout);
  let repo: any = {};
  try {
    if (repoOut.ok) repo = JSON.parse(repoOut.stdout);
  } catch {
    // Left out: no merge methods and no Merge, the rest still shows.
  }
  const methods: MergeMethod[] = [];
  if (repo.rebaseMergeAllowed) methods.push('rebase');
  if (repo.squashMergeAllowed) methods.push('squash');
  if (repo.mergeCommitAllowed) methods.push('merge');
  const state = prState(v);
  const pr: PrView = {
    url: String(v.url || `https://github.com/${R}/pull/${n}`),
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: String(v.title ?? ''),
    author: String(v.author?.login ?? 'ghost'),
    state,
    head: String(v.headRefName ?? ''),
    base: String(v.baseRefName ?? ''),
    additions: Number(v.additions) || 0,
    deletions: Number(v.deletions) || 0,
    changedFiles: Number(v.changedFiles) || 0,
    body: String(v.body ?? ''),
    createdAt: String(v.createdAt ?? ''),
    review: ({ APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'required' } as Record<string, string>)[String(v.reviewDecision ?? '')] ?? '',
    mergeable: v.mergeable === 'MERGEABLE' ? 'yes' : v.mergeable === 'CONFLICTING' ? 'conflicts' : 'unknown',
    canMerge: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(String(repo.viewerPermission ?? '')) && (state === 'open' || state === 'draft'),
    mergeMethods: methods,
    checks: checks(Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : []),
    activity: activity(v.comments, v.reviews),
    ...(files ?? { files: [], filesLater: true }),
  };
  if (v.mergedAt) pr.mergedAt = String(v.mergedAt);
  if (v.closedAt) pr.closedAt = String(v.closedAt);
  if (v.mergedBy?.login) pr.mergedBy = String(v.mergedBy.login);
  return pr;
}

export type PrAction =
  | { action: 'merge'; method: MergeMethod }
  | { action: 'close' }
  | { action: 'reopen' }
  | { action: 'comment'; body: string }
  | { action: 'approve'; body?: string }
  | { action: 'requestChanges'; body?: string };

/** Does what was clicked, and throws gh's own words when GitHub says no. */
export async function prAct(ref: PrRef, a: PrAction, gh: Gh = realGh): Promise<void> {
  const base = [String(ref.number), '-R', repoArg(ref)];
  const body = 'body' in a && typeof a.body === 'string' ? a.body.trim() : '';
  let args: string[];
  switch (a.action) {
    case 'merge':
      if (!['rebase', 'squash', 'merge'].includes(a.method)) throw new Error(`unknown merge method ${String(a.method)}`);
      args = ['pr', 'merge', ...base, `--${a.method}`];
      break;
    case 'close':
      args = ['pr', 'close', ...base];
      break;
    case 'reopen':
      args = ['pr', 'reopen', ...base];
      break;
    case 'comment':
      if (!body) throw new Error('the comment is empty');
      // --body=<text> in one argument, so words starting with "-" can't
      // be read as a flag of gh's.
      args = ['pr', 'comment', ...base, `--body=${body}`];
      break;
    case 'approve':
      args = ['pr', 'review', ...base, '--approve', ...(body ? [`--body=${body}`] : [])];
      break;
    case 'requestChanges':
      if (!body) throw new Error('say what to change in the comment box first');
      args = ['pr', 'review', ...base, '--request-changes', `--body=${body}`];
      break;
    default:
      throw new Error(`unknown action ${String((a as { action?: unknown }).action)}`);
  }
  const out = await run(gh, args);
  if (!out.ok) throw new Error(failed(out.stderr));
}

// Each repo's PR states, for the coloured icons on PR links in replies. One
// `gh pr list` a repo covers its latest few hundred PRs; one older than
// that just has no colour. Kept a minute, so a transcript full of links
// costs one call a repo.
const STATES_TTL_MS = 60_000;
const stateCache = new Map<string, { at: number; states: Promise<Map<number, PrState> | undefined> }>();

export async function prStates(urls: string[], gh: Gh = realGh, now = Date.now()): Promise<Record<string, PrState>> {
  const byRepo = new Map<string, { url: string; ref: PrRef }[]>();
  for (const url of urls.slice(0, 500)) {
    const ref = parsePrUrl(url);
    if (!ref) continue;
    const k = repoArg(ref).toLowerCase();
    byRepo.set(k, [...(byRepo.get(k) ?? []), { url, ref }]);
  }
  const out: Record<string, PrState> = {};
  await Promise.all(
    [...byRepo.entries()].slice(0, 20).map(async ([k, refs]) => {
      let hit = stateCache.get(k);
      if (!hit || now - hit.at >= STATES_TTL_MS) {
        const states = run(gh, ['pr', 'list', '-R', repoArg(refs[0].ref), '--state', 'all', '--limit', '300', '--json', 'number,state,isDraft']).then((r) => {
          if (!r.ok) return undefined;
          try {
            return new Map<number, PrState>((JSON.parse(r.stdout) as any[]).map((p) => [Number(p.number), prState(p)]));
          } catch {
            return undefined;
          }
        });
        hit = { at: now, states };
        stateCache.set(k, hit);
      }
      const states = await hit.states;
      for (const { url, ref } of refs) {
        const s = states?.get(ref.number);
        if (s) out[url] = s;
      }
    }),
  );
  return out;
}

/** After a merge or close, the next read of that repo's states asks again. */
export function forgetStates(ref: PrRef): void {
  stateCache.delete(repoArg(ref).toLowerCase());
  statusCache.delete(`${repoArg(ref).toLowerCase()}#${ref.number}`);
}

// ---- Status for Highlights' Pull requests ----
// Each PR a thread has linked, made or pinned, with what decides whether it
// can merge: CI, the review decision, a merge conflict and review threads
// still open. One `gh api graphql` call asks for every PR at once, and an
// answer is kept 30 seconds, so the app can ask each time Highlights draws.

export type PrCi = 'passed' | 'failed' | 'pending' | '';
/** A pull request as `gh api graphql` gives it (PR_FIELDS here, pr-watch.ts's
 *  FIELDS): GitHub can leave any field out. */
type GhAuthor = { login?: string; __typename?: string } | null;
export type GhGraphPr = {
  title?: string;
  state?: string;
  isDraft?: boolean;
  mergeable?: string;
  reviewDecision?: string;
  updatedAt?: string;
  headRefOid?: string;
  commits?: { nodes?: ({ commit?: { statusCheckRollup?: { state?: string } | null } } | null)[] };
  reviewThreads?: { nodes?: ({ id?: string; isResolved?: boolean } | null)[] };
  reviews?: { nodes?: ({ id?: string; state?: string; body?: string; author?: GhAuthor } | null)[] };
  comments?: { nodes?: ({ id?: string; author?: GhAuthor } | null)[] };
};
/** `gh api graphql`'s data, with the PRs asked for as `p<i>` parts. */
export type GhGraphData = { viewer?: { login?: string }; [part: string]: { pullRequest?: GhGraphPr | null } | { login?: string } | null | undefined };
/** The PR in part `p<i>` of an answer, if GitHub gave it. */
export function graphPr(data: GhGraphData, i: number): GhGraphPr | undefined {
  const part = data[`p${i}`];
  return (part && 'pullRequest' in part && part.pullRequest) || undefined;
}
export type PrStatus = {
  title: string;
  state: PrState;
  ci: PrCi;
  review: '' | 'approved' | 'changes' | 'required';
  mergeable: 'yes' | 'conflicts' | 'unknown';
  unresolved: number; // review threads not resolved
  updatedAt: string;
};

const STATUS_TTL_MS = 30_000;
// Highlights keeps 80 items; a thread rarely has more than a few PRs.
const STATUS_MAX = 40;
const statusCache = new Map<string, { at: number; status: PrStatus }>();

const PR_FIELDS = 'title state isDraft mergeable reviewDecision updatedAt commits(last:1){nodes{commit{statusCheckRollup{state}}}} reviewThreads(first:100){nodes{isResolved}}';

const CI: Record<string, PrCi> = { SUCCESS: 'passed', FAILURE: 'failed', ERROR: 'failed', PENDING: 'pending', EXPECTED: 'pending' };

export function prStatusOf(v: GhGraphPr | null | undefined): PrStatus {
  const threads = Array.isArray(v?.reviewThreads?.nodes) ? v.reviewThreads.nodes : [];
  return {
    title: String(v?.title ?? ''),
    state: prState(v ?? {}),
    ci: CI[String(v?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? '')] ?? '',
    review: (({ APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'required' }) as Record<string, PrStatus['review']>)[String(v?.reviewDecision ?? '')] ?? '',
    mergeable: v?.mergeable === 'MERGEABLE' ? 'yes' : v?.mergeable === 'CONFLICTING' ? 'conflicts' : 'unknown',
    unresolved: threads.filter((t) => t && t.isResolved === false).length,
    updatedAt: String(v?.updatedAt ?? ''),
  };
}

/** Each PR's status by its URL as asked. A PR GitHub doesn't give is left out. */
export async function prStatus(urls: string[], gh: Gh = realGh, now = Date.now()): Promise<Record<string, PrStatus>> {
  const out: Record<string, PrStatus> = {};
  const ask: { url: string; ref: PrRef; key: string }[] = [];
  const seen = new Set<string>();
  for (const url of urls.slice(0, 500)) {
    const ref = parsePrUrl(url);
    if (!ref) continue;
    const key = `${repoArg(ref).toLowerCase()}#${ref.number}`;
    const hit = statusCache.get(key);
    if (hit && now - hit.at < STATUS_TTL_MS) out[url] = hit.status;
    else if (!seen.has(key) && ask.length < STATUS_MAX) {
      seen.add(key);
      ask.push({ url, ref, key });
    }
  }
  if (!ask.length) return out;
  // parsePrUrl allows only GitHub's name characters, and JSON quoting is
  // GraphQL's string syntax, so nothing from a link reaches the query raw.
  const parts = ask.map(({ ref }, i) => `p${i}:repository(owner:${JSON.stringify(ref.owner)},name:${JSON.stringify(ref.repo)}){pullRequest(number:${ref.number}){${PR_FIELDS}}}`);
  const r = await run(gh, ['api', 'graphql', '-f', `query={${parts.join(' ')}}`]);
  let data: GhGraphData | undefined;
  try {
    data = (JSON.parse(r.stdout) as { data?: GhGraphData })?.data;
  } catch {
    data = undefined;
  }
  // A repo it can't see makes GraphQL say so for that one and still answer
  // the rest, with gh exiting non-zero: so only nothing at all is a failure.
  if (!data) throw new Error(failed(r.stderr));
  ask.forEach(({ url, key }, i) => {
    const pr = graphPr(data, i);
    if (!pr) return;
    const status = prStatusOf(pr);
    statusCache.set(key, { at: now, status });
    out[url] = status;
  });
  // The same PR linked two ways (".../pull/12" and ".../pull/12/files").
  for (const u of urls.slice(0, 500)) {
    const ref = out[u] ? undefined : parsePrUrl(u);
    const hit = ref && statusCache.get(`${repoArg(ref).toLowerCase()}#${ref.number}`);
    if (hit) out[u] = hit.status;
  }
  return out;
}
