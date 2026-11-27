// The website's HTTP routes (docs/website.md). Everything is the static
// site from the static-hosting component, except a shared thread's page,
// /s/<slug>, which is the same index.html with that thread's title, the
// start of its last reply and its first picture in the meta tags, so a
// link pasted into Slack, X or iMessage unfurls as the thread rather than
// as plain "Threadbear". Link-preview bots don't run the page's script, so
// the tags have to be in the HTML itself.
import { httpRouter } from 'convex/server';
import { registerStaticRoutes } from '@convex-dev/static-hosting';
import { components, internal } from './_generated/api';
import { httpAction } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { MAX_RUNNER_UPLOAD_BYTES } from './sync';
import { PHONE_UPLOADS } from './phone';
import { takeUpload } from './uploads';
import { safeDecode, withCard } from './shareCard';
import { promoteRoute } from './boxImage';
import { cappedJson } from './httpJson';
import { ARTIFACT_PATH, artifactPage, artifactSlug } from './artifactPage';

const http = httpRouter();

http.route({
  pathPrefix: ARTIFACT_PATH,
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const slug = artifactSlug(new URL(request.url).pathname);
    return artifactPage(slug ? await ctx.runQuery(internal.artifacts.readPublished, { slug }) : null);
  }),
});

// No other site may put these pages in a frame. Framed out of sight, a
// thread's link and then the Open button of the website's own "Open this in
// another app?" question (web/src/link-confirm.tsx) could be clicked through
// a page laid over them, the address never seen: a shared page (/s/) needs
// no sign-in for that (Daybreak 139, cross-lab review, 17 Nov 2026).
// frame-ancestors has to be a header; a <meta> CSP ignores it.
export const NO_FRAMES = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" } as const;

export function noFrames(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, value] of Object.entries(NO_FRAMES)) headers.set(k, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

http.route({
  pathPrefix: '/s/',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const slug = safeDecode(url.pathname.slice('/s/'.length).replace(/\/$/, ''));
    const asset = await ctx.runQuery(components.staticHosting.lib.resolveAssetForHttp, { path: '/index.html' });
    // The page is in one of the three places the component keeps files
    // (registerStaticRoutes reads them the same way).
    let html: string | null = null;
    if (asset?.blobId) html = await text(fetch(`${url.origin}/fs/blobs/${asset.blobId}`));
    else if (asset?.storageUrl) html = await text(fetch(asset.storageUrl));
    else if (asset?.appStorageId) html = (await (await ctx.storage.get(asset.appStorageId as Id<'_storage'>))?.text()) ?? null;
    if (!html) return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    const card = slug && !slug.includes('/') ? await ctx.runQuery(internal.share.preview, { slug }) : null;
    return new Response(card ? withCard(html, card, url) : html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Sharing can stop at any time; a cached card would outlive it.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...NO_FRAMES,
      },
    });
  }),
});

// A shared thread's picture: /share/image/<slug>/<id>, the URL share:view
// and the /s/ card give anyone with the link (share.ts sharedImageUrl).
// Served only while the thread is still shared under that link, checked
// at every request (share:shareImageFile), never cached, so stopping
// sharing stops the pictures at once too (Daybreak, 15 Nov 2026).
http.route({
  pathPrefix: '/share/image/',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const gone = () => new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    const parts = new URL(request.url).pathname.slice('/share/image/'.length).split('/');
    if (parts.length !== 2) return gone();
    let slug: string;
    let id: string;
    try {
      [slug, id] = parts.map(decodeURIComponent) as [string, string];
    } catch {
      return gone();
    }
    const file = await ctx.runQuery(internal.share.shareImageFile, { slug, id });
    const blob = file ? await ctx.storage.get(file.storageId) : null;
    if (!file || !blob) return gone();
    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': file.mediaType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        // The page and link previews load it from other origins.
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    });
  }),
});

// The push relay asks here whether a /register that named this deployment
// really came from it (push.ts relayInstall, relay/convex/http.ts): it posts
// back the nonce the registration carried, which only this deployment has.
// Answers nothing else, so it tells a caller only whether a guess was right.
http.route({
  path: '/relay/verify',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const b = await cappedJson(request, 1024);
    if (b === 'tooBig') return new Response('request body too large', { status: 413 });
    const nonce = typeof b?.nonce === 'string' && /^[0-9a-f]{48}$/.test(b.nonce) ? b.nonce : null;
    const ok = nonce ? await ctx.runMutation(internal.devices.takeRelayCheck, { nonce }) : false;
    return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  }),
});

// The box-image workflow promoting the image a new box boots, with a GitHub
// Actions OIDC token (boxImage.ts says what it checks).
http.route({ path: '/box-image/promote', method: 'POST', handler: promoteRoute });

// The three upload routes below take their one-use ticket the same way
// (uploads.ts takeUpload): claimed before the body is read, the body read
// no further than the cap, and a file the finish doesn't keep deleted.

// A runner key's uploads (sync:iconUploadUrl hands out this URL with a
// one-use ticket): the file is stored here and recorded as that runner's,
// so its key can attach it, and only it (docs/protocol/keys.md, "Runner keys").
// Answers { storageId } as Convex's own upload URL does, so the runner's
// uploader is the same for both. 429: over an allowance, try again later;
// 403: this ticket won't do.
http.route({
  path: '/runner/upload',
  method: 'POST',
  handler: httpAction(async (ctx, request) =>
    takeUpload(ctx, request, { maxBytes: MAX_RUNNER_UPLOAD_BYTES, claim: internal.sync.claimUpload, finish: internal.sync.finishUpload, refused: 'upload refused: a bad or used ticket, or a revoked key' }),
  ),
});

// A picture the main Mac's runner sends to another runner's thread
// (relay:pictureUploadUrl hands out this URL with a one-use ticket): stored
// here and recorded (relayUploads), so a command can name it and one that
// never went out is found and deleted after a day.
http.route({
  path: '/relay/upload',
  method: 'POST',
  handler: httpAction(async (ctx, request) =>
    takeUpload(ctx, request, { maxBytes: MAX_RUNNER_UPLOAD_BYTES, claim: internal.relay.claimRelayUpload, finish: internal.relay.finishRelayUpload, refused: 'upload refused: a bad or used ticket' }),
  ),
});

// A phone's photo (phone:imageUploadUrl hands out this URL with a one-use
// ticket): stored here and recorded as that phone token's (phoneUploads), so
// only its own commands can send it and only it can discard it, and one
// never sent is found and deleted after a day. Answers { storageId } as
// Convex's own upload URL does, which is what the iPhone app reads.
http.route({
  path: '/phone/upload',
  method: 'POST',
  handler: httpAction(async (ctx, request) =>
    takeUpload(ctx, request, { maxBytes: PHONE_UPLOADS.maxBytes, claim: internal.phone.claimPhoneUpload, finish: internal.phone.finishPhoneUpload, refused: 'upload refused: a bad or used ticket, or a revoked phone' }),
  ),
});

// The site's own pages go out with NO_FRAMES too. registerStaticRoutes has
// no option for headers, so it registers onto this stand-in router, which
// wraps each handler it's given (an httpAction's _handler is the function it
// was made from).
registerStaticRoutes(
  {
    route: (spec: Parameters<typeof http.route>[0]) => {
      const inner = (spec.handler as unknown as { _handler?: (ctx: unknown, request: Request) => Promise<Response> })._handler;
      // A newer Convex without _handler fails the deploy here, rather than
      // serving pages without the header.
      if (typeof inner !== 'function') throw new Error("static-hosting's handler can't be wrapped: NO_FRAMES needs another way in");
      http.route({ ...spec, handler: httpAction(async (ctx, request) => noFrames(await inner(ctx, request))) });
    },
  } as unknown as typeof http,
  components.staticHosting,
);

export default http;

async function text(response: Promise<Response>): Promise<string | null> {
  const r = await response;
  return r.ok ? r.text() : null;
}
