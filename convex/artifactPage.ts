import { escapeHtml } from './shareCard.ts';

export const ARTIFACT_PATH = '/a/';
export const MAX_ARTIFACT_BYTES = 64 * 1024;
export const ARTIFACT_SLUG = /^[a-f0-9]{32}$/;

const documentOpening = /^(?:[\t\n\f\r ]|<!--.*?-->|<\?[^>]*>|<(?:!doctype|html|head)(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>)*/is;

const externalUrl = `(href) => {
  if (typeof href !== 'string') return;
  try {
    const url = new URL(href);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
  } catch {}
}`;

// The frame reports a reader's click. It still cannot open a popup, navigate
// the top window or load external resources itself.
const artifactFrame = `(() => {
  const externalUrl = ${externalUrl};
  const positions = new Map();
  const scrollers = new Set();
  let activeEntry;
  let latestRequest = 0;
  const findAnchor = (name) => document.getElementById(name)
    ?? Array.from(document.getElementsByName(name)).find((element) => element instanceof HTMLAnchorElement);
  const positionKey = (entry) => JSON.stringify([entry, window.location.hash]);
  const viewportOffset = () => ({ left: window.scrollX, top: window.scrollY });
  const scrollOptions = (offset) => ({ ...offset, behavior: 'instant' });
  const origin = { left: 0, top: 0 };
  const scrollToOffsets = (viewport, nested) => {
    window.scrollTo(scrollOptions(viewport));
    for (const element of scrollers) element.scrollTo(scrollOptions(nested?.get(element) ?? origin));
  };
  document.addEventListener('scroll', (event) => {
    if (event.target instanceof Element && event.target !== document.scrollingElement) scrollers.add(event.target);
  }, true);

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const { artifactFragment, entry, restoring, traversing } = event.data ?? {};
    if (typeof artifactFragment !== 'string' || (artifactFragment !== '' && !artifactFragment.startsWith('#'))) return;
    if (typeof entry !== 'string') return;
    const request = ++latestRequest;
    if (entry === activeEntry) return;
    // The wrapper owns share-link history. Keep each entry's scroll position
    // here without changing the iframe's URL or interrupting its own links.
    // A local anchor can move the frame through its own entries while the
    // wrapper's entry stays the same.
    const firstEntry = activeEntry === undefined;
    if (!firstEntry) {
      const nested = new Map(Array.from(scrollers, (element) => [element, { left: element.scrollLeft, top: element.scrollTop }]));
      positions.set(positionKey(activeEntry), { viewport: viewportOffset(), nested });
    }
    const applyFragment = () => {
      if (request !== latestRequest) return;
      activeEntry = entry;
      const saved = positions.get(positionKey(entry));
      if (saved) {
        scrollToOffsets(saved.viewport, saved.nested);
        return;
      }
      if (restoring && (window.scrollX || window.scrollY || window.location.hash)) return;

      const name = artifactFragment.slice(1);
      let decoded = name;
      try { decoded = decodeURIComponent(name); } catch {}
      const anchor = name && (findAnchor(name) ?? (decoded !== name ? findAnchor(decoded) : undefined));
      if (anchor) {
        anchor.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
        // A new fragment can arrive before the scroll events.
        for (let element = anchor.parentElement; element; element = element.parentElement) {
          if (element !== document.scrollingElement && (element.scrollLeft || element.scrollTop)) scrollers.add(element);
        }
      } else if ((!firstEntry && name === '') || decoded.toLowerCase() === 'top') {
        scrollToOffsets(origin);
      }
    };
    // On Back/Forward the frame's own history can change just after the
    // wrapper's hashchange. Read its current fragment after that render.
    if (traversing && !firstEntry) requestAnimationFrame(() => requestAnimationFrame(applyFragment));
    else applyFragment();
  });
  document.addEventListener('click', (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
    const xlink = 'http://www.w3.org/1999/xlink';
    const anchor = event.composedPath().find((element) =>
      (element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement || element instanceof SVGAElement)
      && (element.hasAttribute('href') || element.hasAttributeNS(xlink, 'href')));
    const href = externalUrl(anchor?.getAttribute('href') ?? anchor?.getAttributeNS(xlink, 'href'));
    if (!href || anchor.hasAttribute('download')) return;
    event.preventDefault();
    window.parent.postMessage({ artifactLink: href }, '*');
  });
})();`;

const artifactViewer = `(() => {
  const externalUrl = ${externalUrl};
  const frame = document.querySelector('iframe').contentWindow;
  const sendFragment = (restoring) => {
    let entry = history.state?.artifactEntry;
    const traversing = typeof entry === 'string';
    if (!entry) {
      entry = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
      history.replaceState({ artifactEntry: entry }, '');
    }
    frame.postMessage({ artifactFragment: window.location.hash, entry, restoring, traversing }, '*');
  };
  window.addEventListener('load', () => {
    const loadType = performance.getEntriesByType('navigation')[0]?.type;
    sendFragment(loadType === 'reload' || loadType === 'back_forward');
    window.addEventListener('hashchange', () => sendFragment(false));
  }, { once: true });
  window.addEventListener('message', (event) => {
    if (event.source !== frame || event.origin !== 'null') return;
    const href = externalUrl(event.data?.artifactLink);
    if (!href) return;
    if (navigator.userActivation?.isActive === false) {
      window.location.assign(href);
    } else {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  });
})();`;

export function artifactSlug(path: string): string | null {
  const slug = path.slice(ARTIFACT_PATH.length);
  return path.startsWith(ARTIFACT_PATH) && ARTIFACT_SLUG.test(slug) ? slug : null;
}

const contentPolicy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri about:; form-action 'none'; frame-ancestors 'none'";

const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': `${contentPolicy}; sandbox`,
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
  // The authored file cannot know this value. Unlike a fixed script hash,
  // the nonce authorizes only the two script tags made for this response.
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const srcdoc = escapeHtml(html.replace(documentOpening, (opening) => `${opening}<base href="about:srcdoc"><script nonce="${nonce}">${artifactFrame}</script>`));
  // Only the trusted wrapper may open a tab. The frame's stricter sandbox
  // still forbids the artifact from opening one itself.
  const policy = [
    contentPolicy,
    'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
    `script-src 'nonce-${nonce}'`,
    "script-src-attr 'none'",
  ].join('; ');
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>html,body { margin: 0; height: 100%; } iframe { display: block; width: 100%; height: 100%; border: 0; }</style>
</head>
<body><iframe sandbox="allow-scripts" title="${title}" srcdoc="${srcdoc}"></iframe><script nonce="${nonce}">${artifactViewer}</script></body>
</html>`, { headers: { ...headers, 'Content-Security-Policy': policy, 'Content-Type': 'text/html; charset=utf-8' } });
}
