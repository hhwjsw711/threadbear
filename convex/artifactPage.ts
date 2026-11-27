import { escapeHtml } from './shareCard.ts';

export const ARTIFACT_PATH = '/a/';
export const MAX_ARTIFACT_BYTES = 64 * 1024;
export const ARTIFACT_SLUG = /^[a-f0-9]{32}$/;

export function artifactSlug(path: string): string | null {
  const slug = path.slice(ARTIFACT_PATH.length);
  return path.startsWith(ARTIFACT_PATH) && ARTIFACT_SLUG.test(slug) ? slug : null;
}

const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

export function artifactPage(artifact: { title: string; html: string } | null): Response {
  if (!artifact) {
    return new Response('This artifact is unavailable.', {
      status: 404,
      headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const title = escapeHtml(artifact.title);
  // The escaped srcdoc inherits this page's CSP. The empty sandbox also
  // gives the artifact an opaque origin and blocks top-level navigation.
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>html,body { margin: 0; height: 100%; } iframe { display: block; width: 100%; height: 100%; border: 0; }</style>
</head>
<body><iframe sandbox title="${title}" srcdoc="${escapeHtml(artifact.html)}"></iframe></body>
</html>`, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
}
