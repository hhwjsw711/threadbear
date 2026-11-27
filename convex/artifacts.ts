import { ConvexError, v } from 'convex/values';
import { env, internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { ARTIFACT_PATH, ARTIFACT_SLUG, MAX_ARTIFACT_BYTES, slugFromUrl } from './artifactPage';
import { checkPhoneToken, sha256 } from './lib';
import { utf8Bytes } from './runnerAccess';

export const artifactVisibility = v.union(v.literal('private'), v.literal('public'));
export type ArtifactVisibility = 'private' | 'public';

const INLINE_HTML_LIMIT = 512 * 1024;
const VIEW_TICKET_MS = 30_000;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export type ArtifactStorageDeps = {
  attachStorage: (storageId: Id<'_storage'>) => Promise<void>;
  freeStorage: (storageId: Id<'_storage'>) => Promise<void>;
};

async function bySlug(ctx: QueryCtx, slug: string) {
  if (!ARTIFACT_SLUG.test(slug)) return null;
  return ctx.db.query('artifacts').withIndex('by_slug', (q) => q.eq('slug', slug)).unique();
}

function artifactUrl(slug: string) {
  return new URL(ARTIFACT_PATH + slug, env.CONVEX_SITE_URL).href;
}

function visibilityOf(row: { visibility?: ArtifactVisibility } | null): ArtifactVisibility | null {
  if (!row) return null;
  return row.visibility ?? 'public';
}

function expectedMatches(expected: string | null | undefined, current: { slug: string } | null): boolean {
  if (expected === undefined) return true;
  if (expected === null) return current === null;
  return current !== null && slugFromUrl(expected) === current.slug;
}

type Payload = {
  html?: string;
  storageId?: Id<'_storage'>;
  digest?: string;
};

type ValidatedPayload =
  | { ok: true; html?: string; storageId?: Id<'_storage'>; bytes: number; digest?: string }
  | { ok: false; error: string };

async function validatePayload(
  ctx: MutationCtx,
  payload: Payload,
  deps?: ArtifactStorageDeps,
): Promise<ValidatedPayload> {
  const digest = payload.digest;
  if (digest !== undefined && !DIGEST_RE.test(digest)) {
    if (payload.storageId && deps) await deps.freeStorage(payload.storageId);
    return { ok: false, error: 'Invalid file digest.' };
  }
  if (payload.storageId !== undefined) {
    if (deps) await deps.attachStorage(payload.storageId);
    const meta = await ctx.db.system.get('_storage', payload.storageId);
    if (!meta || meta.size <= 0 || meta.size > MAX_ARTIFACT_BYTES) {
      if (deps) await deps.freeStorage(payload.storageId);
      return { ok: false, error: 'Use a nonempty HTML file up to 10 MiB.' };
    }
    return { ok: true, storageId: payload.storageId, bytes: meta.size, ...(digest ? { digest } : {}) };
  }
  const html = payload.html;
  if (typeof html !== 'string' || !html.trim()) {
    return { ok: false, error: 'Use a nonempty HTML file up to 10 MiB.' };
  }
  const bytes = utf8Bytes(html);
  if (bytes > INLINE_HTML_LIMIT) {
    return { ok: false, error: 'Upload HTML files over 512 KiB via file storage.' };
  }
  return { ok: true, html, bytes, ...(digest ? { digest } : {}) };
}

type StoreResult =
  | { ok: true; url: string; visibility: ArtifactVisibility; digest: string | null }
  | { ok: false; error: string };

async function storeArtifact(
  ctx: MutationCtx,
  title: string,
  payload: Payload,
  opts: {
    slug?: string;
    source?: string;
    visibility?: ArtifactVisibility;
    defaultVisibility: ArtifactVisibility;
    deps?: ArtifactStorageDeps;
  },
): Promise<StoreResult> {
  title = title.trim();
  if (!title || title.length > 120) {
    if (payload.storageId && opts.deps) await opts.deps.freeStorage(payload.storageId);
    return { ok: false, error: 'Use a title of 1 to 120 characters.' };
  }
  const validated = await validatePayload(ctx, payload, opts.deps);
  if (!validated.ok) return validated;
  const now = Date.now();

  if (opts.slug !== undefined) {
    const current = await bySlug(ctx, opts.slug);
    if (!current) {
      if (validated.storageId && opts.deps) await opts.deps.freeStorage(validated.storageId);
      return { ok: false, error: 'This artifact is unavailable.' };
    }
    const oldStorageId = current.storageId;
    // Existing legacy rows without `visibility` were public; preserve that on update.
    const nextVisibility = opts.visibility ?? current.visibility ?? 'public';
    await ctx.db.patch('artifacts', current._id, {
      title,
      html: validated.html,
      storageId: validated.storageId,
      bytes: validated.bytes,
      digest: validated.digest,
      visibility: nextVisibility,
      updatedAt: now,
    });
    if (oldStorageId && oldStorageId !== validated.storageId && opts.deps) {
      await opts.deps.freeStorage(oldStorageId);
    }
    return { ok: true, url: artifactUrl(opts.slug), visibility: nextVisibility, digest: validated.digest ?? null };
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const fresh = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (await bySlug(ctx, fresh)) {
    if (validated.storageId && opts.deps) await opts.deps.freeStorage(validated.storageId);
    return { ok: false, error: 'Could not make a link. Try again.' };
  }
  const nextVisibility = opts.visibility ?? opts.defaultVisibility;
  await ctx.db.insert('artifacts', {
    slug: fresh,
    title,
    ...(validated.html !== undefined ? { html: validated.html } : {}),
    ...(validated.storageId !== undefined ? { storageId: validated.storageId } : {}),
    bytes: validated.bytes,
    ...(validated.digest !== undefined ? { digest: validated.digest } : {}),
    visibility: nextVisibility,
    ...(opts.source ? { source: opts.source } : {}),
    updatedAt: now,
  });
  return { ok: true, url: artifactUrl(fresh), visibility: nextVisibility, digest: validated.digest ?? null };
}

export const artifactChange = v.union(
  v.object({ action: v.literal('status') }),
  v.object({
    action: v.literal('sync'),
    title: v.string(),
    html: v.optional(v.string()),
    storageId: v.optional(v.id('_storage')),
    digest: v.optional(v.string()),
    visibility: v.optional(artifactVisibility),
    expected: v.optional(v.union(v.string(), v.null())),
  }),
  v.object({
    action: v.literal('setVisibility'),
    visibility: artifactVisibility,
    expected: v.optional(v.string()),
  }),
  v.object({
    action: v.literal('publish'),
    expected: v.union(v.string(), v.null()),
    title: v.string(),
    html: v.optional(v.string()),
    storageId: v.optional(v.id('_storage')),
    digest: v.optional(v.string()),
  }),
  v.object({ action: v.literal('unpublish'), expected: v.string() }),
);

export const artifactManageResult = v.object({
  url: v.union(v.string(), v.null()),
  visibility: v.union(artifactVisibility, v.null()),
  digest: v.union(v.string(), v.null()),
  changed: v.boolean(),
  error: v.optional(v.string()),
});

export async function manageArtifact(
  ctx: MutationCtx,
  source: string,
  change: typeof artifactChange.type,
  deps: ArtifactStorageDeps,
) {
  if (!DIGEST_RE.test(source)) {
    if ('storageId' in change && change.storageId) await deps.freeStorage(change.storageId);
    return { url: null, visibility: null, digest: null, changed: false, error: 'This file could not be identified.' };
  }
  const current = await ctx.db.query('artifacts').withIndex('by_source', (q) => q.eq('source', source)).unique();
  const url = current ? artifactUrl(current.slug) : null;
  const visibility = visibilityOf(current);
  const digest = current?.digest ?? null;

  if (change.action === 'status') {
    return { url, visibility, digest, changed: false };
  }

  if (!expectedMatches(change.expected, current)) {
    if ('storageId' in change && change.storageId) {
      await deps.freeStorage(change.storageId);
    }
    return { url, visibility, digest, changed: false };
  }

  if (change.action === 'unpublish') {
    if (!current) return { url: null, visibility: null, digest: null, changed: false };
    const oldStorageId = current.storageId;
    await ctx.db.delete('artifacts', current._id);
    if (oldStorageId) await deps.freeStorage(oldStorageId);
    return { url: null, visibility: null, digest: null, changed: true };
  }

  if (change.action === 'setVisibility') {
    if (!current) return { url: null, visibility: null, digest: null, changed: false };
    if (visibility === change.visibility) {
      return { url, visibility, digest, changed: true };
    }
    await ctx.db.patch('artifacts', current._id, {
      visibility: change.visibility,
      updatedAt: Date.now(),
    });
    return { url, visibility: change.visibility, digest, changed: true };
  }

  if (change.action === 'sync' || change.action === 'publish') {
    const saved = await storeArtifact(
      ctx,
      change.title,
      { html: change.html, storageId: change.storageId, digest: change.digest },
      {
        slug: current?.slug,
        source,
        visibility: change.action === 'publish' ? 'public' : change.visibility,
        defaultVisibility: change.action === 'publish' ? 'public' : 'private',
        deps,
      },
    );
    // Return validation errors instead of throwing so any freed storageId deletion commits.
    if (!saved.ok) {
      return { url, visibility, digest, changed: false, error: saved.error };
    }
    return { url: saved.url, visibility: saved.visibility, digest: saved.digest, changed: true };
  }

  return { url, visibility, digest, changed: false };
}

export async function issueViewTicket(
  ctx: MutationCtx,
  token: string,
  slug: string,
): Promise<{ ok: true; ticket: string } | { ok: false; status: 401 | 404 }> {
  try {
    await checkPhoneToken(ctx, token);
  } catch {
    return { ok: false, status: 401 };
  }
  const current = await bySlug(ctx, slug);
  if (!current) return { ok: false, status: 404 };

  const now = Date.now();
  for (const stale of await ctx.db
    .query('artifactViews')
    .withIndex('by_expiresAt', (q) => q.lt('expiresAt', now))
    .take(32)) {
    await ctx.db.delete('artifactViews', stale._id);
  }
  const raw = crypto.getRandomValues(new Uint8Array(24));
  const ticket = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
  await ctx.db.insert('artifactViews', {
    ticketHash: await sha256(ticket),
    slug,
    expiresAt: now + VIEW_TICKET_MS,
  });
  return { ok: true, ticket };
}

export async function consumeViewTicket(
  ctx: MutationCtx,
  ticket: string,
  slug: string,
): Promise<boolean> {
  const ticketHash = await sha256(ticket);
  const row = await ctx.db
    .query('artifactViews')
    .withIndex('by_ticketHash', (q) => q.eq('ticketHash', ticketHash))
    .first();
  if (!row) return false;
  await ctx.db.delete('artifactViews', row._id);
  return row.slug === slug && row.expiresAt > Date.now();
}

async function deleteUnusedArtifactBlob(ctx: MutationCtx, storageId: Id<'_storage'>) {
  if (await ctx.db.query('artifacts').withIndex('by_storageId', (q) => q.eq('storageId', storageId)).first()) return;
  if (await ctx.db.system.get('_storage', storageId)) await ctx.storage.delete(storageId);
}

// The deployment admin can still publish and manage files from the CLI.
export const publish = internalMutation({
  args: {
    title: v.string(),
    html: v.optional(v.string()),
    storageId: v.optional(v.id('_storage')),
    slug: v.optional(v.string()),
    visibility: v.optional(artifactVisibility),
  },
  returns: v.string(),
  handler: async (ctx, { title, html, storageId, slug, visibility }) => {
    const saved = await storeArtifact(
      ctx,
      title,
      { html, storageId },
      {
        slug,
        visibility,
        defaultVisibility: 'public',
        deps: {
          attachStorage: async () => {},
          freeStorage: (id) => deleteUnusedArtifactBlob(ctx, id),
        },
      },
    );
    if (!saved.ok) throw new ConvexError({ kind: 'badArgs', message: saved.error });
    return saved.url;
  },
});

export const unpublish = internalMutation({
  args: { slug: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { slug }) => {
    const current = await bySlug(ctx, slug);
    if (!current) return false;
    const oldStorageId = current.storageId;
    await ctx.db.delete('artifacts', current._id);
    if (oldStorageId) await deleteUnusedArtifactBlob(ctx, oldStorageId);
    return true;
  },
});

export async function readPublished(ctx: QueryCtx, slug: string) {
  const current = await bySlug(ctx, slug);
  if (!current) return null;
  return {
    title: current.title,
    ...(current.html !== undefined ? { html: current.html } : {}),
    ...(current.storageId !== undefined ? { storageId: current.storageId } : {}),
    visibility: current.visibility ?? 'public',
  };
}
