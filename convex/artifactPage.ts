import { escapeHtml } from './shareCard.ts';

export const ARTIFACT_PATH = '/a/';
export const MAX_ARTIFACT_BYTES = 64 * 1024;
export const ARTIFACT_SLUG = /^[a-f0-9]{32}$/;

const documentOpening = /^(?:[\t\n\f\r ]|<!--.*?-->|<\?[^>]*>|<(?:!doctype|html|head)(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>)*/is;

export function artifactSlug(path: string): string | null {
  const slug = path.slice(ARTIFACT_PATH.length);
  return path.startsWith(ARTIFACT_PATH) && ARTIFACT_SLUG.test(slug) ? slug : null;
}

const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri about:; form-action 'none'; frame-ancestors 'none'; sandbox",
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
  // A srcdoc normally resolves #links against the wrapper URL. Set its
  // first base to its own URL so anchors scroll without loading the wrapper.
  // Keep the document's opening tags first so their attributes still apply.
  const html = artifact.html.replace(/^\uFEFF/, '');
  const srcdoc = escapeHtml(html.replace(documentOpening, (opening) => `${opening}<base href="about:srcdoc">`));
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>html,body { margin: 0; height: 100%; } iframe { display: block; width: 100%; height: 100%; border: 0; }</style>
</head>
<body><iframe sandbox title="${title}" srcdoc="${srcdoc}"></iframe></body>
</html>`, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
}
