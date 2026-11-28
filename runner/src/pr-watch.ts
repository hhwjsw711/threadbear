// PR auto-fix (docs/protocol/panels.md, "Pull requests"):
// a PR's wand in Highlights watches it for its thread. Each look works out the
// PR's problems as keys; a key the watch hasn't seen sends the thread a
// message to fix it, keys that clear are forgotten (so a problem that comes
// back is new again), an approval asks whether to merge, and a thread whose
// watched PRs all wait for review is snoozed for a day. Ported from Ville's
// PRs patch (~/.threadbear/patches/prs/data.mjs), which he used from 11 Nov
// 2026 and asked to have in Highlights itself on 20 Nov.
//
// Pure apart from the `gh` passed to fetchWatched, so tests give a fake.
// The Runner part (runner/pr-watch.ts) keeps the state and does the actions.
import os from 'node:os';
import { parsePrUrl, graphPr, type GhGraphData, type GhGraphPr, type PrRef } from './github-pr.ts';
import type { Gh } from './land-gate.ts';

// One watched PR, by its key ("owner/repo#12").
export type PrWatchEntry = {
  url: string;
  thread: string; // the thread whose wand turned it on: it gets the messages
  since: string;
  // Problem keys already sent (or, on the first look, already there as old
  // reviews and comments).
  seen: string[];
  primed?: true; // the first look has marked the old talk seen
  sentAt?: string;
  approvedFor?: string; // the head commit an approval was told for
  snoozedFor?: string; // the PR update the thread was snoozed for
  error?: string;
};
export type PrWatchState = Record<string, PrWatchEntry>;

// What a look at GitHub found, for one PR.
export type WatchedPr = {
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  sha: string;
  ci: string; // statusCheckRollup.state, '' for none
  review: string; // reviewDecision, '' for none
  updatedAt: string;
  problems: string[];
};

// A thread as the plan needs it.
export type WatchThread = { archived: boolean; busy: boolean; snoozedUntil?: string };

export type WatchAction =
  | { kind: 'send'; key: string; thread: string; text: string; done: Partial<PrWatchEntry> }
  | { kind: 'snooze'; thread: string; keys: string[]; done: Partial<PrWatchEntry> };

export const prKey = (ref: PrRef) => `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
const short = (key: string) => key.replace(/^[^/]+\//, '');
const OLD_TALK = /^(review|comment):/;
const WORDS: Record<string, string> = { conflict: 'a merge conflict', ci: 'CI failing', thread: 'unresolved review threads', 'changes-requested': 'changes requested', review: 'new reviews', comment: 'new PR comments' };
const describe = (keys: string[]) => [...new Set(keys.map((k) => WORDS[k.split(':')[0]!] ?? k))].join(', ');

// Keys: `conflict`, `ci:<sha>` (each failing commit once), `thread:<id>` (an
// unresolved review thread), `changes-requested` (the decision), and
// `review:<id>` / `comment:<id>` (top-level words by someone else).
export function problemsOf(n: GhGraphPr, me: string): string[] {
  const out: string[] = [];
  if (n.mergeable === 'CONFLICTING') out.push('conflict');
  const ci = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  if (ci === 'FAILURE' || ci === 'ERROR') out.push(`ci:${n.headRefOid}`);
  for (const t of n.reviewThreads?.nodes ?? []) if (t && !t.isResolved) out.push(`thread:${t.id}`);
  if (n.reviewDecision === 'CHANGES_REQUESTED') out.push('changes-requested');
  const other = (a: { login?: string; __typename?: string } | null | undefined): a is { login?: string; __typename?: string } => a != null && a.login !== me;
  for (const r of n.reviews?.nodes ?? []) {
    // A bot's review (Copilot) says what its inline threads say.
    if (!r || !other(r.author) || r.author.__typename === 'Bot') continue;
    if (r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && String(r.body ?? '').trim())) out.push(`review:${r.id}`);
  }
  // Bots' PR-level comments (lint summaries, deploy notes) come again on every
  // push: they would start a fix after each one.
  for (const c of n.comments?.nodes ?? []) if (c && other(c.author) && c.author.__typename === 'User') out.push(`comment:${c.id}`);
  return out;
}

const FIELDS = 'state isDraft mergeable reviewDecision updatedAt headRefOid commits(last:1){nodes{commit{statusCheckRollup{state}}}} reviewThreads(first:100){nodes{id isResolved}} reviews(last:20){nodes{id state body author{login __typename}}} comments(last:20){nodes{id author{login __typename}}}';

/** The watched PRs as GitHub has them now, in one `gh api graphql` call. A PR
 *  it doesn't give is left out (a blip, or a repo gh can't see). */
export async function fetchWatched(urls: string[], gh: Gh): Promise<Map<string, WatchedPr>> {
  const refs = urls.map(parsePrUrl).filter((r): r is PrRef => Boolean(r)).slice(0, 40);
  const out = new Map<string, WatchedPr>();
  if (!refs.length) return out;
  const parts = refs.map((ref, i) => `p${i}:repository(owner:${JSON.stringify(ref.owner)},name:${JSON.stringify(ref.repo)}){pullRequest(number:${ref.number}){${FIELDS}}}`);
  const r = await gh(['api', 'graphql', '-f', `query={viewer{login} ${parts.join(' ')}}`], os.tmpdir());
  let data: GhGraphData | undefined;
  try {
    data = (JSON.parse(r.stdout) as { data?: GhGraphData })?.data;
  } catch {
    data = undefined;
  }
  if (!data?.viewer?.login) throw new Error(r.stderr.trim().split('\n').pop() || 'gh failed');
  const me = String(data.viewer.login);
  const d = data;
  refs.forEach((ref, i) => {
    const n = graphPr(d, i);
    if (!n) return;
    const s = String(n.state ?? '').toUpperCase();
    out.set(prKey(ref), {
      state: s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : 'open',
      draft: Boolean(n.isDraft),
      sha: String(n.headRefOid ?? ''),
      ci: String(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? ''),
      review: String(n.reviewDecision ?? ''),
      updatedAt: String(n.updatedAt ?? ''),
      problems: problemsOf(n, me),
    });
  });
  return out;
}

const fixText = (key: string, url: string, fresh: string[], rules?: string) =>
  `PR watch: ${short(key)} (${url}) has ${describe(fresh)}. Auto-fix this PR now, only this one. `
  + (rules ? `First read the rules in ${rules} and follow them. ` : '')
  + 'Read its unresolved review threads, the top-level reviews and comments, the failing checks and any merge conflict. '
  + 'Fix them in a worktree on the PR branch, push, reply, and resolve every thread. Never merge, amend or force-push. '
  + 'Then end the turn with needs "nothing" and snooze "1d", unless something needs my decision.';

const approvedText = (key: string, url: string) =>
  `PR watch: ${short(key)} (${url}) is approved and ready to merge. Do not merge it. `
  + 'Check CI is green and no review thread is open. Then end the turn with needs "you" and one ask: "Merge ' + short(key) + '?", '
  + 'with the options "Merge it" and "Not yet". Merge only if I pick "Merge it".';

const onlyTalk = (p: WatchedPr) => !p.problems.some((k) => !OLD_TALK.test(k));
const waitsForReview = (p: WatchedPr) => !p.draft && onlyTalk(p) && p.ci !== 'PENDING' && p.ci !== 'EXPECTED' && p.review === 'REVIEW_REQUIRED';

/** What to do after a look. Changes `state` for what needs no action (a PR
 *  gone, seen keys that cleared, the first look's old talk); an action's
 *  `done` goes into its entries once it has worked. */
export function plan(state: PrWatchState, prs: Map<string, WatchedPr>, threadOf: (id: string) => WatchThread | undefined, now: number, rules?: string): { actions: WatchAction[]; changed: boolean } {
  const actions: WatchAction[] = [];
  let changed = false;
  for (const [key, entry] of Object.entries(state)) {
    const p = prs.get(key);
    if (!p) continue; // not looked at this time: kept as it is
    if (p.state !== 'open') {
      delete state[key];
      changed = true;
      continue;
    }
    if (!entry.primed) {
      // Reviews and comments from before the wand was turned on aren't news.
      entry.seen = [...new Set([...entry.seen, ...p.problems.filter((k) => OLD_TALK.test(k))])];
      entry.primed = true;
      changed = true;
    }
    const seen = entry.seen.filter((k) => p.problems.includes(k));
    if (seen.length !== entry.seen.length) {
      entry.seen = seen;
      changed = true;
    }
    const t = threadOf(entry.thread);
    if (!t || t.archived || t.busy) continue; // a fix in progress isn't interrupted
    const fresh = p.problems.filter((k) => !seen.includes(k));
    if (fresh.length) {
      actions.push({ kind: 'send', key, thread: entry.thread, text: fixText(key, entry.url, fresh, rules), done: { seen: [...seen, ...fresh], sentAt: new Date(now).toISOString() } });
    } else if (p.review === 'APPROVED' && onlyTalk(p) && entry.approvedFor !== p.sha) {
      actions.push({ kind: 'send', key, thread: entry.thread, text: approvedText(key, entry.url), done: { approvedFor: p.sha, sentAt: new Date(now).toISOString() } });
    }
  }
  // A thread whose watched PRs all wait for review has nothing to do: snoozed
  // a day, once per PR update. A message for a new problem wakes it.
  const byThread = new Map<string, [string, WatchedPr, PrWatchEntry][]>();
  for (const [key, entry] of Object.entries(state)) {
    const p = prs.get(key);
    if (p) byThread.set(entry.thread, [...(byThread.get(entry.thread) ?? []), [key, p, entry]]);
  }
  for (const [thread, list] of byThread) {
    if (actions.some((a) => a.thread === thread)) continue;
    if (!list.every(([, p]) => waitsForReview(p))) continue;
    const mark = list.map(([, p]) => p.updatedAt).sort().pop()!;
    if (list.every(([, , e]) => e.snoozedFor === mark)) continue;
    const t = threadOf(thread);
    if (!t || t.archived || t.busy || (t.snoozedUntil && Date.parse(t.snoozedUntil) > now)) continue;
    actions.push({ kind: 'snooze', thread, keys: list.map(([k]) => k), done: { snoozedFor: mark } });
  }
  return { actions, changed };
}
