// What the review board asks of the backend, as one small interface so a
// fixture can stand in for Convex (web/review-fixture.html, for checking the
// board with no runner). The real one runs phone:designReviews and
// phone:respondReview as commands the thread's runner answers, follows them
// with phone:command, and follows the stills with phone:reviewImages
// (docs/protocol/events.md, "Reviews on the phone").
import type { ConvexReactClient } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { COMMAND_SLOW_MS, errorText } from './command';
import { parseReviewResult, type DesignReview, type DraftArgument, type ReviewListResult } from './review-model';

export type ReviewPicture = { url: string; width?: number; height?: number };

export type ReviewBackend = {
  // The pending reviews (no id), or one (an id, or the start of one).
  load: (reviewId?: string) => Promise<ReviewListResult>;
  // Follows a review's stills and media by src as they come up from the runner.
  pictures: (sources: string[], on: (pictures: Map<string, ReviewPicture>) => void, failed: (error: string) => void) => () => void;
  // A cut-out JPEG put in file storage, by its id.
  upload: (jpeg: Blob) => Promise<string>;
  // Lets go of one that won't be sent after all.
  discard: (storageId: string) => Promise<void>;
  // 'done', or a note while the runner hasn't said yet (it lands when its
  // Mac is back). Throws with why when it's refused.
  respond: (review: DesignReview, draft: DraftArgument) => Promise<'done' | { waiting: string }>;
};

// Plain words for a runner that hasn't answered in time.
export function timedOutNote(taken: boolean): string {
  return taken ? 'The Mac has this but hasn’t said how it went yet.' : 'The Mac hasn’t picked this up. It may be asleep or offline; it runs when the Mac is back.';
}

type Outcome = { kind: 'done'; result?: unknown } | { kind: 'failed'; note: string } | { kind: 'timedOut'; taken: boolean };

// Follows one command until its runner says how it went, or COMMAND_SLOW_MS.
function outcome(client: ConvexReactClient, token: string, commandId: Id<'commands'>): Promise<Outcome> {
  const watch = client.watchQuery(api.phone.command, { token, commandId });
  return new Promise((resolve) => {
    let taken = false;
    let over = false;
    const finish = (o: Outcome) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      stop();
      resolve(o);
    };
    const check = () => {
      let r;
      try {
        r = watch.localQueryResult();
      } catch (e) {
        finish({ kind: 'failed', note: errorText(e) });
        return;
      }
      if (!r) return;
      if (r.state === 'taken') taken = true;
      if (r.state === 'done') finish({ kind: 'done', result: r.result });
      else if (r.state === 'failed') finish({ kind: 'failed', note: r.note ?? 'The Mac couldn’t do it.' });
    };
    const stop = watch.onUpdate(check);
    const timer = setTimeout(() => finish({ kind: 'timedOut', taken }), COMMAND_SLOW_MS);
    check();
  });
}

export function convexReviews(client: ConvexReactClient, token: string, threadId: string): ReviewBackend {
  return {
    async load(reviewId) {
      const id = await client.mutation(api.phone.designReviews, { token, threadId, ...(reviewId ? { reviewId } : {}) });
      const o = await outcome(client, token, id);
      if (o.kind === 'timedOut') throw new Error(timedOutNote(o.taken));
      if (o.kind === 'failed') throw new Error(o.note);
      const parsed = parseReviewResult(o.result);
      if (!parsed) throw new Error('Couldn’t read the review. Try again.');
      return parsed;
    },
    pictures(sources, on, failed) {
      if (!sources.length) return () => {};
      const watch = client.watchQuery(api.phone.reviewImages, { token, threadId, sources: sources.slice(0, 80) });
      const check = () => {
        try {
          const list = watch.localQueryResult();
          if (list) on(new Map(list.filter((p) => p.src && /^https?:/i.test(p.url)).map((p) => [p.src!, { url: p.url, ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}) }])));
        } catch (e) {
          failed(errorText(e));
        }
      };
      const stop = watch.onUpdate(check);
      check();
      return stop;
    },
    async upload(jpeg) {
      const url = await client.mutation(api.phone.imageUploadUrl, { token });
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg });
      if (!r.ok) throw new Error(r.status === 429 ? 'Too many pictures for now: try again later.' : 'A mark’s cut-out didn’t upload. Try again.');
      const { storageId } = (await r.json()) as { storageId?: string };
      if (!storageId) throw new Error('A mark’s cut-out didn’t upload. Try again.');
      return storageId;
    },
    async discard(storageId) {
      await client.mutation(api.phone.discardImage, { token, storageId: storageId as Id<'_storage'> });
    },
    async respond(review, draft) {
      const id = await client.mutation(api.phone.respondReview, {
        token,
        threadId,
        reviewId: review.id,
        revision: review.revision,
        // Cut-outs' ids are file storage ids, as phone:imageUploadUrl gave them.
        draft: draft as FunctionArgs<typeof api.phone.respondReview>['draft'],
      });
      const o = await outcome(client, token, id);
      if (o.kind === 'timedOut') return { waiting: timedOutNote(o.taken) };
      if (o.kind === 'failed') throw new Error(o.note);
      return 'done';
    },
  };
}
