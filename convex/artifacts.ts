import { ConvexError, v } from 'convex/values';
import { env, internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import { ARTIFACT_PATH, ARTIFACT_SLUG, MAX_ARTIFACT_BYTES } from './artifactPage';
import { utf8Bytes } from './runnerAccess';

async function bySlug(ctx: QueryCtx, slug: string) {
  if (!ARTIFACT_SLUG.test(slug)) return null;
  return ctx.db.query('artifacts').withIndex('by_slug', (q) => q.eq('slug', slug)).unique();
}

function artifactUrl(slug: string) {
  return new URL(ARTIFACT_PATH + slug, env.CONVEX_SITE_URL).href;
}

async function storeArtifact(ctx: MutationCtx, title: string, html: string, slug?: string, source?: string) {
  title = title.trim();
  if (!title || title.length > 120) throw new ConvexError({ kind: 'badArgs', message: 'Use a title of 1 to 120 characters.' });
  if (!html.trim() || utf8Bytes(html) > MAX_ARTIFACT_BYTES) throw new ConvexError({ kind: 'badArgs', message: 'Use a nonempty HTML file up to 64 KiB.' });

  if (slug !== undefined) {
    const current = await bySlug(ctx, slug);
    if (!current) throw new ConvexError({ kind: 'badArgs', message: 'This artifact is unavailable.' });
    await ctx.db.patch('artifacts', current._id, { title, html });
    return artifactUrl(slug);
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const fresh = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (await bySlug(ctx, fresh)) throw new ConvexError({ kind: 'conflict', message: 'Could not make a link. Try publishing again.' });
  await ctx.db.insert('artifacts', { slug: fresh, title, html, ...(source ? { source } : {}) });
  return artifactUrl(fresh);
}

export const artifactChange = v.union(
  v.object({ action: v.literal('status') }),
  v.object({ action: v.literal('publish'), expected: v.union(v.string(), v.null()), title: v.string(), html: v.string() }),
  v.object({ action: v.literal('unpublish'), expected: v.string() }),
);

export async function manageArtifact(ctx: MutationCtx, source: string, change: typeof artifactChange.type) {
  if (!/^[0-9a-f]{64}$/.test(source)) throw new ConvexError({ kind: 'badArgs', message: 'This file could not be identified.' });
  const current = await ctx.db.query('artifacts').withIndex('by_source', (q) => q.eq('source', source)).unique();
  const url = current ? artifactUrl(current.slug) : null;
  if (change.action === 'status') return { url, changed: false };
  if (url !== change.expected) return { url, changed: false };
  if (change.action === 'unpublish' && current) {
    await ctx.db.delete('artifacts', current._id);
    return { url: null, changed: true };
  }
  if (change.action === 'publish') {
    return { url: await storeArtifact(ctx, change.title, change.html, current?.slug, source), changed: true };
  }
  return { url, changed: false };
}

// The deployment admin can still publish and manage files from the CLI.
export const publish = internalMutation({
  args: { title: v.string(), html: v.string(), slug: v.optional(v.string()) },
  returns: v.string(),
  handler: (ctx, { title, html, slug }) => storeArtifact(ctx, title, html, slug),
});

export const unpublish = internalMutation({
  args: { slug: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { slug }) => {
    const current = await bySlug(ctx, slug);
    if (!current) return false;
    await ctx.db.delete('artifacts', current._id);
    return true;
  },
});

export async function readPublished(ctx: QueryCtx, slug: string) {
  const current = await bySlug(ctx, slug);
  return current ? { title: current.title, html: current.html } : null;
}
