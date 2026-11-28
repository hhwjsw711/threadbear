// PR auto-fix's watch (pr-watch.ts): kept in
// <home>/pr-watch.json, looked at every minute while anything is watched,
// and its messages and snoozes done here. Each method's `this` is the
// Runner; runner.ts puts them on its prototype.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import { ErrorCode, RpcError } from '../protocol.ts';
import { atomicWriteFileSync } from '../fsutil.ts';
import { gh as realGh } from '../land-gate.ts';
import { parsePrUrl } from '../github-pr.ts';
import { fetchWatched, plan, prKey, type PrWatchState } from '../pr-watch.ts';

const LOOK_MS = 60_000;
// The first look after a wand is turned on, so a problem it already has goes
// to the thread soon.
const FIRST_LOOK_MS = 2_000;
// Where the user can keep their own auto-fix rules; the fix message points
// the thread at it when it's there.
export const RULES_FILE = path.join(os.homedir(), '.threadbear', 'pr-auto-fix.md');

export const prWatchPart = {
  prWatchFile(this: Runner): string {
    return path.join(this.cfg.home, 'pr-watch.json');
  },

  prWatchState(this: Runner): PrWatchState {
    if (!this.prWatch) {
      try {
        this.prWatch = JSON.parse(fs.readFileSync(this.prWatchFile(), 'utf8')) as PrWatchState;
      } catch {
        this.prWatch = {};
      }
    }
    return this.prWatch;
  },

  savePrWatch(this: Runner): void {
    atomicWriteFileSync(this.prWatchFile(), JSON.stringify(this.prWatch ?? {}, null, 1));
  },

  /** The wand: watch `urls` for `threadId`, or stop. Returns the PR URLs
   *  watched now, for any thread. */
  setPrWatch(this: Runner, threadId: string, urls: string[], on: boolean): { watched: string[] } {
    this.mustGet(threadId);
    const state = this.prWatchState();
    for (const url of urls.slice(0, 50)) {
      const ref = parsePrUrl(url);
      if (!ref) throw new RpcError(ErrorCode.badParams, `${url} isn't a GitHub pull request link`);
      const key = prKey(ref);
      if (!on) delete state[key];
      else if (state[key]?.thread !== threadId) state[key] = { url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`, thread: threadId, since: this.isoNow(), seen: [] };
    }
    this.savePrWatch();
    this.prWatchTouched();
    if (on) this.armPrWatch(FIRST_LOOK_MS, true);
    return { watched: Object.values(state).map((e) => e.url) };
  },

  listPrWatch(this: Runner): { watches: { url: string; threadId: string; since: string; sentAt?: string; error?: string }[] } {
    return { watches: Object.values(this.prWatchState()).map((e) => ({ url: e.url, threadId: e.thread, since: e.since, ...(e.sentAt ? { sentAt: e.sentAt } : {}), ...(e.error ? { error: e.error } : {}) })) };
  },

  /** Whether a PR link is watched, for its highlight's wand. */
  prWatched(this: Runner, url: string | undefined): boolean {
    const ref = url ? parsePrUrl(url) : undefined;
    return Boolean(ref && this.prWatchState()[prKey(ref)]);
  },

  // The threads whose Highlights show a watched PR: their wands moved.
  prWatchTouched(this: Runner): void {
    for (const st of this.threads.values()) {
      if (st.rec.highlights?.items.some((h) => h.kind === 'pr')) this.highlightsChanged(st);
    }
  },

  /** Books the next look: from start(), after a wand, and after each look. */
  armPrWatch(this: Runner, ms = LOOK_MS, sooner = false): void {
    if (!Object.keys(this.prWatchState()).length) return;
    if (this.prWatchTimer && !sooner) return;
    this.prWatchTimer?.cancel();
    this.prWatchTimer = this.clock.setTimeout(() => void this.lookAtPrWatch(), ms);
  },

  async lookAtPrWatch(this: Runner): Promise<void> {
    this.prWatchTimer = undefined;
    if (this.prWatchBusy) return;
    const state = this.prWatchState();
    if (!Object.keys(state).length) return;
    this.prWatchBusy = true;
    try {
      const prs = await fetchWatched(Object.values(state).map((e) => e.url), this.prWatchGh ?? realGh);
      const threadOf = (id: string) => {
        const st = this.threads.get(id);
        if (!st || st.rt.deleted) return undefined;
        const s = st.rec.status;
        return { archived: Boolean(st.rec.archivedAt), busy: s === 'starting' || s === 'running' || s === 'waiting', ...(st.rec.snoozedUntil ? { snoozedUntil: st.rec.snoozedUntil } : {}) };
      };
      const before = Object.keys(state).length;
      const { actions, changed } = plan(state, prs, threadOf, this.clock.now(), fs.existsSync(RULES_FILE) ? RULES_FILE.replace(os.homedir(), '~') : undefined);
      let saved = changed;
      for (const a of actions) {
        const keys = a.kind === 'send' ? [a.key] : a.keys;
        try {
          if (a.kind === 'send') this.send(a.thread, a.text);
          else this.update({ threadId: a.thread, snoozedUntil: new Date(this.clock.now() + 86_400_000).toISOString() });
          for (const k of keys) if (state[k]) Object.assign(state[k], a.done, { error: undefined });
        } catch (e) {
          for (const k of keys) if (state[k]) state[k].error = String((e as Error).message ?? e).split('\n')[0];
          this.log.warn('pr watch: an action failed', { thread: a.thread, kind: a.kind, error: String(e) });
        }
        saved = true;
      }
      if (saved) this.savePrWatch();
      // A merged or closed PR's wand goes.
      if (Object.keys(state).length !== before) this.prWatchTouched();
    } catch (e) {
      this.log.warn('pr watch: looking at GitHub failed', { error: String(e) });
    } finally {
      this.prWatchBusy = false;
    }
    this.armPrWatch();
  },
};

export type PrWatchPart = RunnerPart<typeof prWatchPart>;
