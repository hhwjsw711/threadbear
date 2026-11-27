import { escapeHtml } from './shareCard.ts';

export const ARTIFACT_PATH = '/a/';
export const ARTIFACT_AUTH_PATH = '/a/auth';
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_SLUG = /^[a-f0-9]{32}$/;
export const ARTIFACT_TICKET_COOKIE = 'tb_a';
const ARTIFACT_TICKET_VALUE = /^[a-f0-9]{48}$/;

export function artifactSlug(path: string): string | null {
  const slug = path.slice(ARTIFACT_PATH.length);
  return path.startsWith(ARTIFACT_PATH) && ARTIFACT_SLUG.test(slug) ? slug : null;
}

export function slugFromUrl(value: string): string | null {
  try {
    return artifactSlug(new URL(value).pathname);
  } catch {
    return null;
  }
}

export function readArtifactTicket(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== ARTIFACT_TICKET_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (ARTIFACT_TICKET_VALUE.test(value)) return value;
  }
  return null;
}

export function artifactTicketCookie(slug: string, ticket: string, secure: boolean): string {
  return `${ARTIFACT_TICKET_COOKIE}=${ticket}; Path=${ARTIFACT_PATH}${slug}; HttpOnly; SameSite=Lax; Max-Age=30${secure ? '; Secure' : ''}`;
}

export function clearArtifactTicketCookie(slug: string, secure: boolean): string {
  return `${ARTIFACT_TICKET_COOKIE}=; Path=${ARTIFACT_PATH}${slug}; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

// Each published HTML page runs as a top-level document in an opaque sandbox
// origin (no allow-same-origin) with background requests, subresources and
// forms blocked. Authored inline scripts, styles, data/blob media, canvases
// and downloads work, while Threadbear's localStorage/cookies stay unreachable.
// Note: as a top-level document with scripts enabled, authored script can still
// navigate the tab itself to an external URL.
export const ARTIFACT_CSP = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads',
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: data:",
  "style-src 'unsafe-inline' blob: data:",
  'img-src data: blob:',
  'font-src data: blob:',
  'media-src data: blob:',
  'worker-src blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const baseHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

const missingHeaders = {
  ...baseHeaders,
  'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
  'Content-Type': 'text/plain; charset=utf-8',
} as const;

export function artifactPage(
  body: Blob | string | { title?: string; html: string } | null,
  extraHeaders?: Record<string, string>,
): Response {
  const content = body && typeof body === 'object' && !(body instanceof Blob) ? body.html : body;
  if (content === null) {
    return new Response('This artifact is unavailable.', {
      status: 404,
      headers: { ...missingHeaders, ...extraHeaders },
    });
  }
  return new Response(content, {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Security-Policy': ARTIFACT_CSP,
      'Content-Type': 'text/html; charset=utf-8',
      ...extraHeaders,
    },
  });
}

// Shown on GET /a/<slug> when an artifact is private and the request didn't
// carry a valid one-use ticket cookie. Runs on Threadbear's origin with a
// strict nonce CSP and ZERO authored HTML, checks localStorage for this
// browser's Threadbear token, trades it for a one-use HttpOnly cookie via
// POST /a/auth, and reloads the clean /a/<slug>#hash URL.
export function privateArtifactGate(slug: string, extraHeaders?: Record<string, string>): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const safeSlug = escapeHtml(slug);
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  const script = `(() => {
  const slug = ${JSON.stringify(slug)};
  const titleEl = document.getElementById('title');
  const noteEl = document.getElementById('note');
  const actionEl = document.getElementById('action');
  const show = (title, note, linkLabel, linkHref) => {
    titleEl.textContent = title;
    noteEl.textContent = note;
    if (linkLabel && linkHref) {
      actionEl.textContent = linkLabel;
      actionEl.href = linkHref;
      actionEl.hidden = false;
    } else {
      actionEl.hidden = true;
    }
  };
  let token = '';
  try { token = localStorage.getItem('threadbear.token') || ''; } catch {}
  if (!token) {
    show('This page is private', 'Sign in to Threadbear in this browser to view it, or ask the owner to share it.', 'Open Threadbear', '/');
    return;
  }
  const probeName = 'tb_a_probe';
  document.cookie = probeName + '=1; Path=/a/' + slug + '; SameSite=Lax';
  const cookiesWork = document.cookie.split(';').some((c) => c.trim() === probeName + '=1');
  document.cookie = probeName + '=; Path=/a/' + slug + '; SameSite=Lax; Max-Age=0';
  if (!cookiesWork) {
    show('Cookies are needed', 'Enable cookies for this site in your browser to view private Threadbear pages.', 'Try again', location.href);
    return;
  }
  const loopKey = 'tb_a_loop:' + slug;
  try {
    const raw = JSON.parse(sessionStorage.getItem(loopKey) || 'null');
    const now = Date.now();
    const recent = raw && typeof raw.at === 'number' && now - raw.at < 3000 ? Number(raw.count || 0) : 0;
    if (recent >= 4) {
      sessionStorage.removeItem(loopKey);
      show('Cookies are needed', 'Your browser did not send the sign-in cookie. Enable cookies for this site and try again.', 'Try again', location.href);
      return;
    }
    sessionStorage.setItem(loopKey, JSON.stringify({ at: now, count: recent + 1 }));
  } catch {}
  fetch(${JSON.stringify(ARTIFACT_AUTH_PATH)}, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ slug }),
  }).then((res) => {
    if (res.status === 204) {
      location.reload();
      return;
    }
    if (res.status === 401 || res.status === 403) {
      show('Sign in to Threadbear', 'Your sign-in on this browser has expired. Open Threadbear on your Mac and sign in to the web again.', 'Open Threadbear', '/');
      return;
    }
    if (res.status === 404) {
      show('This page is unavailable', 'It may have been removed by its owner.', 'Open Threadbear', '/');
      return;
    }
    show('Could not open this page', 'Something went wrong while checking access. Try reloading.', 'Try again', location.href);
  }).catch(() => {
    show('Could not open this page', 'Check your connection and try reloading.', 'Try again', location.href);
  });
})();`;
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Private page · Threadbear</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f6f5f1; color: #191d25; }
  @media (prefers-color-scheme: dark) { body { background: #16181a; color: #eff1ee; } .card { background: #202326; border-color: #32373c; } p { color: #a7afb8; } }
  .card { max-width: 420px; width: 100%; padding: 24px; border-radius: 14px; background: #fff; border: 1px solid #d7d9dc; }
  h1 { margin: 0 0 8px; font-size: 18px; font-weight: 650; }
  p { margin: 0; font-size: 14px; line-height: 1.5; color: #545b69; }
  a { display: inline-block; margin-top: 16px; padding: 8px 14px; border-radius: 8px; background: #2d6cdf; color: #fff; text-decoration: none; font-size: 14px; font-weight: 600; }
  a[hidden] { display: none; }
</style>
</head>
<body data-slug="${safeSlug}">
  <main class="card">
    <h1 id="title">Opening private page…</h1>
    <p id="note">Checking your Threadbear sign-in in this browser.</p>
    <a id="action" href="/" hidden>Open Threadbear</a>
  </main>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`, {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Security-Policy': policy,
      'Content-Type': 'text/html; charset=utf-8',
      ...extraHeaders,
    },
  });
}
