import { ConvexError, v } from 'convex/values';
import { env, internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { ARTIFACT_PATH, ARTIFACT_SLUG, MAX_ARTIFACT_BYTES } from './artifactPage';
import { utf8Bytes } from './runnerAccess';

async function bySlug(ctx: QueryCtx, slug: string) {
  if (!ARTIFACT_SLUG.test(slug)) return null;
  return ctx.db.query('artifacts').withIndex('by_slug', (q) => q.eq('slug', slug)).unique();
}

// Prototype publishing runs through the Convex CLI. A browser token, runner
// key or public slug carries no write access.
export const publish = internalMutation({
  args: { title: v.string(), html: v.string(), slug: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, { title, html, slug }) => {
    title = title.trim();
    if (!title || title.length > 120) throw new ConvexError('Use a title of 1 to 120 characters.');
    if (!html.trim() || utf8Bytes(html) > MAX_ARTIFACT_BYTES) {
      throw new ConvexError('Use an HTML file up to 64 KiB.');
    }
    const site = env.CONVEX_SITE_URL;

    if (slug !== undefined) {
      const current = await bySlug(ctx, slug);
      if (!current) throw new ConvexError('This artifact is unavailable.');
      await ctx.db.patch('artifacts', current._id, { title, html });
      return new URL(ARTIFACT_PATH + slug, site).href;
    }

    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const fresh = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (await bySlug(ctx, fresh)) throw new ConvexError('Could not make a link. Try publishing again.');
    await ctx.db.insert('artifacts', { slug: fresh, title, html });
    return new URL(ARTIFACT_PATH + fresh, site).href;
  },
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

export const readPublished = internalQuery({
  args: { slug: v.string() },
  returns: v.union(v.null(), v.object({ title: v.string(), html: v.string() })),
  handler: async (ctx, { slug }) => {
    const current = await bySlug(ctx, slug);
    return current ? { title: current.title, html: current.html } : null;
  },
});
