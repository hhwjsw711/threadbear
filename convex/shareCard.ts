// A shared thread's page, /s/<slug> (http.ts): index.html with the thread's
// title and its Open Graph and Twitter card tags. Plain functions with no
// Convex imports, so runner/test/unit/share-card.test.ts can run them.

export function withCard(html: string, card: { title: string; description: string; image?: string }, url: URL): string {
  const e = escapeHtml;
  const tags = [
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="Threadbear" />`,
    `<meta property="og:title" content="${e(card.title)}" />`,
    `<meta property="og:url" content="${e(url.origin + url.pathname)}" />`,
    card.description ? `<meta property="og:description" content="${e(card.description)}" />` : '',
    card.description ? `<meta name="description" content="${e(card.description)}" />` : '',
    `<meta property="og:image" content="${e(card.image ?? `${url.origin}/icon.png`)}" />`,
    `<meta name="twitter:card" content="${card.image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${e(card.title)}" />`,
    card.description ? `<meta name="twitter:description" content="${e(card.description)}" />` : '',
  ]
    .filter(Boolean)
    .join('\n    ');
  const head = `<title>${e(card.title)} · Threadbear</title>\n    ${tags}`;
  // A function, not the string itself: as a replacement string, a `$'`,
  // `$&` or `` $` `` in the thread's title or reply would paste pieces of
  // the page into the tags (found on a fork, 14 Nov 2026).
  return html.replace(/<title>[^<]*<\/title>/, () => head);
}

// A path part as text, or '' for a bad escape (/s/%zz), so the route
// serves the plain page rather than failing with a 500.
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
