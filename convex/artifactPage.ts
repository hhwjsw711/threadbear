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

// Scroll bookmarks are only numbers. The opaque viewer cannot use web
// storage and Chrome can clear history.state on reload.
const positionShape = `(offset) => Array.isArray(offset) && offset.length >= 2
  && offset.length <= 34 && Number.isFinite(offset[0]) && Number.isFinite(offset[1])
  && offset.slice(2).every((item) => Array.isArray(item) && item.length === 3
    && Number.isInteger(item[0]) && item[0] >= 0 && Number.isFinite(item[1]) && Number.isFinite(item[2]))`;

// The frame reports a reader's click. It still cannot open a popup, navigate
// the top window or load external resources itself.
const artifactFrame = `(() => {
  const externalUrl = ${externalUrl};
  const positions = new Map();
  const validOffset = ${positionShape};
  // Native methods and getters bypass names supplied by the artifact.
  const scrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft').get;
  const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop').get;
  const scrollRoot = Object.getOwnPropertyDescriptor(Document.prototype, 'scrollingElement').get;
  const { scrollTo } = Element.prototype;
  const { querySelectorAll, querySelector } = Document.prototype;
  const { addEventListener } = EventTarget.prototype;
  let elements;
  const scrollers = new Set();
  let activeEntry;
  let activeFragment;
  let latestRequest = 0;

  const snapshot = () => {
    const offset = [window.scrollX, window.scrollY];
    for (const index of scrollers) {
      const left = scrollLeft.call(elements[index]);
      const top = scrollTop.call(elements[index]);
      if (left || top) offset.push([index, left, top]);
    }
    return offset;
  };

  const restore = ([left, top, ...nested]) => {
    window.scrollTo({ left, top, behavior: 'instant' });
    const wanted = new Map(nested.map(([index, x, y]) => [index, { left: x, top: y }]));
    for (const index of new Set([...scrollers, ...wanted.keys()])) {
      const element = elements[index];
      if (!element) continue;
      if (scrollers.size < 32) scrollers.add(index);
      scrollTo.call(element, { ...(wanted.get(index) ?? { left: 0, top: 0 }), behavior: 'instant' });
    }
  };

  const reportPosition = () => {
    if (window.location.hash !== activeFragment) return;
    const offset = snapshot();
    positions.set(activeEntry, offset);
    window.parent.postMessage({ artifactPosition: offset, entry: activeEntry }, '*');
  };

  addEventListener.call(document, 'scroll', (event) => {
    if (activeEntry === undefined) return;
    if (event.target instanceof Element && event.target !== scrollRoot.call(document)) {
      const index = elements.indexOf(event.target);
      if (index !== -1 && scrollers.size < 32) scrollers.add(index);
    }
    reportPosition();
  }, true);

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const { artifactFragment, entry, offset, restart } = event.data ?? {};
    if (typeof artifactFragment !== 'string' || (artifactFragment !== '' && !artifactFragment.startsWith('#'))) return;
    if (typeof entry !== 'string' || (entry === activeEntry && !restart)) return;

    elements ??= Array.from(querySelectorAll.call(document, '*'));
    const leaving = activeEntry !== undefined;
    if (leaving && window.location.hash === activeFragment) positions.set(activeEntry, snapshot());
    activeEntry = entry;
    activeFragment = artifactFragment;
    const request = ++latestRequest;
    const saved = restart ? undefined : positions.get(entry) ?? (validOffset(offset) ? offset : undefined);
    if (artifactFragment || window.location.hash || leaving) {
      // Native navigation reveals hidden ancestors and sets :target. The
      // wrapper owns the entry, so replace the frame's fragment in place.
      window.location.replace('about:srcdoc' + (artifactFragment || '#'));
    }
    requestAnimationFrame(() => {
      if (request !== latestRequest) return;
      if (saved) restore(saved);
      reportPosition();
    });
  });
  addEventListener.call(document, 'click', (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
    const xlink = 'http://www.w3.org/1999/xlink';
    const anchor = event.composedPath().find((element) =>
      (element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement || element instanceof SVGAElement)
      && (element.hasAttribute('href') || element.hasAttributeNS(xlink, 'href')));
    if (!anchor || anchor.hasAttribute('download')) return;
    const link = anchor.getAttribute('href') ?? anchor.getAttributeNS(xlink, 'href');
    const target = anchor.getAttribute('target') ?? querySelector.call(document, 'base[target]')?.getAttribute('target');
    if (link?.startsWith('#') && (!target || target.toLowerCase() === '_self')
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      window.parent.postMessage({ artifactFragmentLink: link }, '*');
      return;
    }
    const href = externalUrl(link);
    if (!href) return;
    event.preventDefault();
    window.parent.postMessage({ artifactLink: href }, '*');
  });
})();`;

const artifactViewer = `(() => {
  const externalUrl = ${externalUrl};
  const iframe = document.querySelector('iframe');
  const frame = iframe.contentWindow;
  const validOffset = ${positionShape};
  const bookmarkPrefix = 'threadbear-artifact-scroll:';
  let activeEntry;
  let activeLocation;

  const locationKey = () => {
    let key = 2166136261;
    for (const unit of window.location.pathname + window.location.hash) key = Math.imul(key ^ unit.charCodeAt(0), 16777619);
    return key;
  };
  const readOffset = () => {
    const name = window.name;
    if (!name.startsWith(bookmarkPrefix) || name.length > 4096) return;
    try {
      const [key, offset] = JSON.parse(name.slice(bookmarkPrefix.length));
      if (key === locationKey() && validOffset(offset)) return offset;
    } catch {}
  };
  const sendFragment = (offset, restart = false) => {
    let entry = history.state?.artifactEntry;
    if (!entry) {
      entry = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
      history.replaceState({ artifactEntry: entry }, '');
    }
    if (entry === activeEntry && !restart) return;
    activeEntry = entry;
    activeLocation = locationKey();
    frame.postMessage({ artifactFragment: window.location.hash, entry, offset, restart }, '*');
  };

  window.addEventListener('load', () => {
    const loadType = performance.getEntriesByType('navigation')[0]?.type;
    const offset = loadType === 'reload' || loadType === 'back_forward' ? readOffset() : undefined;
    if (loadType === 'back_forward') {
      // A cold history restore can retain the old about:srcdoc fragment
      // without the srcdoc document. Recreate the frame from the response.
      iframe.addEventListener('load', () => sendFragment(offset), { once: true });
      iframe.srcdoc = iframe.srcdoc;
    } else {
      sendFragment(offset);
    }
    window.addEventListener('popstate', () => sendFragment());
    window.addEventListener('hashchange', () => sendFragment());
  }, { once: true });
  window.addEventListener('message', (event) => {
    if (event.source !== frame || event.origin !== 'null') return;
    const offset = event.data?.artifactPosition;
    if (activeEntry !== undefined && event.data?.entry === activeEntry && validOffset(offset)) {
      const next = bookmarkPrefix + JSON.stringify([activeLocation, offset]);
      if (window.name !== next) window.name = next;
      return;
    }
    const fragment = event.data?.artifactFragmentLink;
    if (typeof fragment === 'string' && fragment.startsWith('#')) {
      const before = window.location.href;
      window.location.hash = fragment;
      if (window.location.href === before) sendFragment(undefined, true);
      return;
    }
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
