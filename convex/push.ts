"use node";
// Push notifications when a thread needs Mike: APNs over HTTP/2 with the
// team's token-based (ES256) auth key, the way poddle/convex/apns.ts does
// it. Env on the deployment: APNS_KEY_P8 (the .p8 contents), APNS_KEY_ID,
// APNS_TEAM_ID, APNS_TOPIC (the phone app's bundle id). Without them
// every send is a logged no-op. Each device row says whether it's a
// sandbox (Xcode) or production (TestFlight, App Store) install, and
// goes to the matching APNs host.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import http2 from 'node:http2';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, type ActionCtx } from './_generated/server';
import { failureText } from './pushHealth';
import { pushText } from './pushText';
import { seal } from './pushSeal';
import { API_VERSION } from './version';
import { RELAY_REGISTER_MS, RELAY_REGISTER_TIMEOUT_MS } from './relayInstallStates';
import { encryptWebPush, pinnedLookup, vapidAuthorization, WEB_PUSH_PLAINTEXT_MAX, type VapidKey } from './webPush';
import { endpointProblem, privateAddress } from './webPushEndpoint';

// The push relay (relay/, docs/push-relay.md): Mike's Convex project that
// holds his Apple key, for backends that don't have one. A deployment with
// its own APNS_* env (Mike's) sends directly; PUSH_RELAY=off turns the relay
// off (and so notifications, for a backend with no key of its own).
const RELAY_URL = 'https://impartial-hound-393.ap-southeast-2.convex.site';

// platform "android" (API 66): apnsToken is the phone's Firebase token, and the
// push goes through the relay to Firebase, even for a backend with an Apple
// key of its own, which has no use for Android.
// platform "webpush" (API 93, the F-Droid build): apnsToken is a UnifiedPush
// endpoint and this deployment posts to it itself (sendWebPush), relay or not.
type Target = { apnsToken: string; environment: 'sandbox' | 'production'; notify: 'away' | 'always' | 'off'; pushKey?: string; platform?: 'android' | 'webpush'; webPush?: { p256dh: string; auth: string } };

// This deployment's own site address (relay registration, the VAPID subject).
const siteUrl = (): string | undefined => process.env.CONVEX_SITE_URL;

// fresh: this send registered it, so a refusal of it isn't an old key's.
type Install = { attempt: string; installId: string; installKey: string; fresh?: boolean };

// This deployment's install with the relay: the one held, or a new one
// registered by this send, or, while another send registers, that one's once
// it has it (relayInstallMachine.ts). Registering replaces the install's key
// at the relay, so two sends registering at once would leave one of them,
// and maybe the key saved last, refused. `refused`: the attempt whose key
// the relay just refused (sendViaRelay).
async function relayInstall(ctx: ActionCtx, url: string, refused?: string): Promise<Install | { failure: string }> {
  // Long enough to wait out a registration that hangs and the one that takes over from it.
  const until = Date.now() + RELAY_WAIT_MS;
  for (;;) {
    const attempt = randomBytes(12).toString('hex');
    const took = await ctx.runMutation(internal.devices.takeRelayInstall, { url, attempt, ...(refused ? { refused } : {}) });
    if ('use' in took && took.use) return took.use;
    if ('failed' in took) return { failure: `${failureText(0)} the relay turned registering down lately; trying again in a few minutes` };
    if ('register' in took) {
      const got = await register(ctx, url, attempt);
      // Another send took over while this one registered: its key, then.
      if (!('retake' in got)) return got;
    }
    if (Date.now() >= until) return { failure: `${failureText(0)} another send is still registering with the relay` };
    await new Promise((resolve) => setTimeout(resolve, RELAY_WAIT_STEP_MS));
  }
}
const RELAY_WAIT_STEP_MS = 500;
const RELAY_WAIT_MS = 2 * RELAY_REGISTER_MS + 30_000;

async function register(ctx: ActionCtx, url: string, attempt: string): Promise<Install | { failure: string } | { retake: true }> {
  // The relay checks a registration really comes from the deployment it
  // names by posting the nonce back to that deployment's /relay/verify
  // (http.ts), so nobody can use up its allowance of new installs by
  // calling /register anonymously (relay/convex/http.ts).
  const deployment = siteUrl();
  const nonce = randomBytes(24).toString('hex');
  // Too little of its time left to wait for an answer: another send takes over (startRelayCheck).
  if (deployment && (await ctx.runMutation(internal.devices.startRelayCheck, { nonce, attempt })) === false) return { retake: true };
  // Given up on before another send may take over (RELAY_REGISTER_MS).
  const res = await fetch(`${url}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: `api-${API_VERSION}`, ...(deployment ? { deployment, nonce } : {}) }), signal: AbortSignal.timeout(RELAY_REGISTER_TIMEOUT_MS) }).catch((e: Error) => e);
  const install = res instanceof Error || !res.ok ? undefined : ((await res.json().catch(() => undefined)) as { installId?: unknown; installKey?: unknown } | undefined);
  if (typeof install?.installId !== 'string' || typeof install.installKey !== 'string') {
    const status = res instanceof Error ? 0 : res.status;
    const reason = res instanceof Error ? res.message : res.ok ? 'no install in its answer' : ((await res.json().catch(() => ({}))) as { error?: string }).error;
    console.warn(`[relay] couldn't register: ${failureText(status, reason)}`);
    // The relay said no (4xx): nothing changed there, and sends wait a
    // minute before asking again (RELAY_FAILED_RETRY_MS). Otherwise (no answer, a
    // timeout, a 5xx, an answer that isn't an install) it may still be
    // registering this one: the install stays this send's until its time is
    // up, and the relay is told no from shortly before (devices.ts
    // takeRelayCheck), so it can't replace the key of the send that
    // registers next.
    if (status >= 400 && status < 500) await ctx.runMutation(internal.devices.relayRegisterFailed, { url, attempt });
    return { failure: `${failureText(status)} couldn't register with the relay` };
  }
  const got = { attempt, installId: install.installId, installKey: install.installKey };
  // Not kept: another send took over once this one's time was up, and the
  // relay was told no to this one from before then, so the other's key is
  // the newer: this send takes that.
  if (!(await ctx.runMutation(internal.devices.relayRegistered, { url, ...got }))) return { retake: true };
  return { ...got, fresh: true };
}

// One push to one phone through the relay: the relay's HTTP status, and its answer.
async function relaySend(url: string, install: Install, alert: { title: string; body: string; threadId: string }, t: Target): Promise<{ status: number; r: { ok?: boolean; gone?: boolean; reason?: string; status?: number; error?: string } }> {
  const res = await fetch(`${url}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${install.installId}.${install.installKey}`, 'X-Threadbear-Version': `api-${API_VERSION}` },
    body: JSON.stringify({ deviceToken: t.apnsToken, environment: t.environment, threadId: alert.threadId, ...(t.platform ? { platform: t.platform } : {}), ...(t.pushKey ? { encrypted: seal(t.pushKey, JSON.stringify({ title: alert.title, body: alert.body })) } : {}) }),
  }).catch((e: Error) => ({ ok: false, status: 0, json: async () => ({ reason: e.message }) }) as unknown as Response);
  return { status: res.status, r: (await res.json().catch(() => ({}))) as { ok?: boolean; gone?: boolean; reason?: string; status?: number; error?: string } };
}

// Through the relay. A phone that sent its pushKey gets the title and text
// sealed with it, so the relay forwards only ciphertext; an older app
// without one gets the relay's plain "A thread needs you", never the text.
async function sendViaRelay(ctx: ActionCtx, alert: { title: string; body: string; threadId: string }, targets: Target[]): Promise<SendSummary> {
  if (process.env.PUSH_RELAY === 'off') return { sent: 0, failed: 0, skipped: 'relayOff' };
  const url = process.env.PUSH_RELAY_URL || RELAY_URL;
  const first = await relayInstall(ctx, url);
  if ('failure' in first) return { sent: 0, failed: targets.length, broken: targets.length, failure: first.failure };
  let install: Install = first;
  let sent = 0;
  let failed = 0;
  let broken = 0;
  let failure: string | undefined;
  // One registration per send at most, the first included, so a relay
  // refusing every key can't keep it registering.
  let renewed = install.fresh === true;
  for (const [i, t] of targets.entries()) {
    let { status, r } = await relaySend(url, install, alert, t);
    if (status === 401) {
      // The relay doesn't know this key: it forgot the install, or another
      // registration replaced it. Register again (unless another send
      // already has: its key) and send this push once more.
      const again: Install | { failure: string } | undefined = renewed ? undefined : await relayInstall(ctx, url, install.attempt);
      renewed = true;
      if (again && !('failure' in again)) {
        install = again;
        ({ status, r } = await relaySend(url, install, alert, t));
      }
      if (status === 401 || (again && 'failure' in again)) {
        // No key the relay takes: cleared (if it's still the one held, and
        // for a while if the relay refused it soon after giving it), and
        // this phone and the rest fail with why, rather than each being
        // sent with a key that can't work.
        if (status === 401) await ctx.runMutation(internal.devices.relayRefused, { url, attempt: install.attempt });
        const why = again && 'failure' in again ? again.failure : failureText(401, r.reason ?? r.error);
        console.warn(`[relay] ${why} for the ${targets.length - i} phone(s) left`);
        failed += targets.length - i;
        broken += targets.length - i;
        failure ??= why;
        break;
      }
    }
    if (r.ok) sent++;
    else {
      failed++;
      // Apple's status when the relay got that far (r.status), else the
      // relay's own HTTP status and error.
      const said = failureText(typeof r.status === 'number' ? r.status : status, r.reason ?? r.error);
      console.warn(`[relay] ${said} for …${t.apnsToken.slice(-6)}`);
      if (r.gone) await ctx.runMutation(internal.devices.drop, { apnsToken: t.apnsToken });
      else {
        broken++;
        failure ??= said;
      }
    }
  }
  return { sent, failed, broken, ...(failure ? { failure } : {}) };
}

type ApnsConfig = { key: string; keyId: string; teamId: string; topic: string };

function apnsConfig(): ApnsConfig | null {
  const { APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC } = process.env;
  if (!APNS_KEY_P8 || !APNS_KEY_ID || !APNS_TEAM_ID || !APNS_TOPIC) return null;
  return { key: toPem(APNS_KEY_P8), keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID, topic: APNS_TOPIC };
}

function toPem(raw: string): string {
  const s = raw.replace(/\\n/g, '\n').trim();
  if (s.includes('BEGIN PRIVATE KEY')) return s;
  const body = s.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

let cachedJwt: { token: string; issuedAt: number; keyId: string } | null = null;

// Apple wants the provider token refreshed at most every 20 minutes and
// at least hourly.
function providerToken(cfg: ApnsConfig, nowMs = Date.now()): string {
  if (cachedJwt && cachedJwt.keyId === cfg.keyId && nowMs - cachedJwt.issuedAt < 50 * 60_000) return cachedJwt.token;
  const iat = Math.floor(nowMs / 1000);
  const input = `${b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }))}.${b64url(JSON.stringify({ iss: cfg.teamId, iat }))}`;
  const signature = sign('sha256', Buffer.from(input), { key: createPrivateKey(cfg.key), dsaEncoding: 'ieee-p1363' });
  const token = `${input}.${b64url(signature)}`;
  cachedJwt = { token, issuedAt: nowMs, keyId: cfg.keyId };
  return token;
}

type SendResult = { token: string; status: number; reason?: string };

function sendOne(session: http2.ClientHttp2Session, cfg: ApnsConfig, jwt: string, token: string, payload: string, kind: 'alert' | 'background' = 'alert'): Promise<SendResult> {
  return new Promise((resolve) => {
    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': cfg.topic,
      // A background push (clear) must say so, at priority 5, or Apple refuses it.
      'apns-push-type': kind,
      'apns-priority': kind === 'alert' ? '10' : '5',
      'content-type': 'application/json',
    });
    let status = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('response', (headers) => (status = Number(headers[':status'] ?? 0)));
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      let reason: string | undefined;
      try {
        reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
      } catch {
        reason = body || undefined;
      }
      resolve({ token, status, reason });
    });
    req.on('error', (e) => resolve({ token, status: 0, reason: e.message }));
    req.setTimeout(10_000, () => {
      req.close();
      resolve({ token, status: 0, reason: 'timeout' });
    });
    req.end(payload);
  });
}

// For pushOutcome (pushHealth.ts), never returned by the actions: broken,
// the failures that weren't a phone Apple says is gone (that phone is
// dropped, and isn't the backend's problem), and the first one's
// "<status> <reason>".
type SendSummary = { sent: number; failed: number; skipped?: string; broken?: number; failure?: string };
const vSendResult = v.object({ sent: v.number(), failed: v.number(), skipped: v.optional(v.string()) });

// The payload the phone app expects (docs/convex-backend.md, section 6).
async function sendAlert(ctx: ActionCtx, alert: { title: string; body: string; threadId: string }, which: (notify: 'away' | 'always' | 'off') => boolean = (n) => n !== 'off'): Promise<SendSummary> {
  const viaRelay = !apnsConfig() || process.env.PUSH_VIA === 'relay';
  // A throw (a malformed APNS_KEY_P8 makes signing throw) counts as a
  // failure too, or a broken key would never be reported.
  let out: SendSummary;
  try {
    out = await deliver(ctx, alert, which);
  } catch (e) {
    console.error(`[push] send threw: ${(e as Error)?.name ?? 'Error'}`);
    out = { sent: 0, failed: 1, broken: 1, failure: '0 send threw' };
  }
  const { failure, broken, ...r } = out;
  await ctx.runMutation(internal.devices.pushOutcome, { sent: r.sent, failed: broken ?? 0, via: viaRelay ? 'relay' : 'apple', ...(failure ? { failure } : {}) });
  return r;
}

// Two sends' summaries as one.
function both(a: SendSummary, b: SendSummary): SendSummary {
  const bad = (a.broken ?? 0) + (b.broken ?? 0);
  const why = a.failure ?? b.failure;
  return { sent: a.sent + b.sent, failed: a.failed + b.failed, ...(bad ? { broken: bad } : {}), ...(why ? { failure: why } : {}) };
}

async function deliver(ctx: ActionCtx, alert: { title: string; body: string; threadId: string }, which: (notify: 'away' | 'always' | 'off') => boolean): Promise<SendSummary> {
  // Not to a phone that has this thread open on screen (phone:setViewing).
  const all: Target[] = await ctx.runQuery(internal.devices.targets, { about: alert.threadId });
  const chosen = all.filter((t) => which(t.notify));
  if (!chosen.length) return { sent: 0, failed: 0, skipped: 'noDevices' };
  // UnifiedPush phones are sent to from here, whatever else is set up.
  const web = chosen.filter((t) => t.platform === 'webpush');
  const targets = chosen.filter((t) => t.platform !== 'webpush');
  if (!targets.length) return await sendWebPush(ctx, alert, web);
  if (!web.length) return await deliverRest(ctx, alert, targets);
  // Side by side, so a slow UnifiedPush server never holds up Apple's or
  // Firebase's, and each awaited to the end even if the other throws (a bad
  // Apple key throws), so neither is cut off when the action returns.
  const threw = (e: unknown): SendSummary => (console.error(`[push] a send threw: ${(e as Error)?.name ?? 'Error'}`), { sent: 0, failed: 1, broken: 1, failure: '0 send threw' });
  const [w, rest] = await Promise.all([sendWebPush(ctx, alert, web).catch(threw), deliverRest(ctx, alert, targets).catch(threw)]);
  return both(w, rest);
}

async function deliverRest(ctx: ActionCtx, alert: { title: string; body: string; threadId: string }, targets: Target[]): Promise<SendSummary> {
  const cfg = apnsConfig();
  if (!cfg || process.env.PUSH_VIA === 'relay') return await sendViaRelay(ctx, alert, targets);
  // An Apple key is no use for an Android phone: those go through the relay,
  // to Firebase, after the Apple ones are sent.
  const apple = targets.filter((t) => t.platform !== 'android');
  const android = targets.filter((t) => t.platform === 'android');
  const payload = JSON.stringify({ aps: { alert: { title: alert.title, body: alert.body }, sound: 'default', 'thread-id': alert.threadId }, threadId: alert.threadId });
  const jwt = providerToken(cfg);
  let sent = 0;
  let failed = 0;
  let broken = 0;
  let failure: string | undefined;
  for (const env of ['sandbox', 'production'] as const) {
    const tokens = apple.filter((t) => t.environment === env).map((t) => t.apnsToken);
    if (!tokens.length) continue;
    const host = env === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    const session = http2.connect(host);
    session.on('error', (e) => console.error(`[apns] session error: ${e.message}`));
    try {
      const results = await Promise.all(tokens.map((t) => sendOne(session, cfg, jwt, t, payload)));
      for (const r of results) {
        if (r.status === 200) sent++;
        else {
          failed++;
          console.warn(`[apns] ${r.status} ${r.reason ?? ''} for …${r.token.slice(-6)}`);
          if (r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered') {
            await ctx.runMutation(internal.devices.drop, { apnsToken: r.token });
          } else {
            broken++;
            failure ??= failureText(r.status, r.reason);
          }
        }
      }
    } finally {
      session.close();
    }
  }
  const direct: SendSummary = { sent, failed, broken, ...(failure ? { failure } : {}) };
  if (!android.length) return direct;
  return both(direct, await sendViaRelay(ctx, alert, android));
}

// This deployment's VAPID key (webPushVapid), made here the first time if a
// phone never asked for it (phone:webPushKey makes it too).
async function vapid(ctx: ActionCtx): Promise<VapidKey> {
  const known = await ctx.runQuery(internal.devices.vapidKey, {});
  if (known) return known;
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  return await ctx.runMutation(internal.devices.putVapidKey, { x: jwk.x!, y: jwk.y!, d: jwk.d! });
}

// The F-Droid build's notifications (API 93): straight to each phone's
// UnifiedPush endpoint, encrypted for it (RFC 8291) and signed with this
// deployment's VAPID key (RFC 8292). What's inside is what the relay's
// Firebase message carries: the thread id and the title and text sealed with
// the phone's own key, so its distributor's server sees neither. A 404 or 410
// means the phone or its distributor dropped the registration, so the row
// goes, as a gone Apple token's does.
async function sendWebPush(ctx: ActionCtx, alert: { title: string; body: string; threadId: string }, targets: Target[]): Promise<SendSummary> {
  if (!targets.length) return { sent: 0, failed: 0 };
  const key = await vapid(ctx);
  // RFC 8292 wants an https: or mailto: subject; a dev deployment's site is http.
  const site = siteUrl();
  const subject = site?.startsWith('https://') ? site : 'https://threadbear.mikecann.app';
  // All at once (a phone token has at most 5, MAX_DEVICES_PER_TOKEN), each
  // with its own 10-second limit, so one slow server can't hold up the rest.
  const results = await Promise.all(targets.map((t) => webPushOne(t, alert, key, subject).catch((e: Error) => ({ status: 0, reason: e.message }))));
  let sent = 0;
  let failed = 0;
  let broken = 0;
  let failure: string | undefined;
  for (const [i, said] of results.entries()) {
    const t = targets[i];
    if (said.status >= 200 && said.status < 300) {
      sent++;
      continue;
    }
    failed++;
    console.warn(`[webpush] ${failureText(said.status, said.reason)} for …${t.apnsToken.slice(-6)}`);
    if (said.status === 404 || said.status === 410) await ctx.runMutation(internal.devices.drop, { apnsToken: t.apnsToken });
    else {
      broken++;
      failure ??= failureText(said.status, said.reason);
    }
  }
  return { sent, failed, broken, ...(failure ? { failure } : {}) };
}

async function webPushOne(t: Target, alert: { title: string; body: string; threadId: string }, key: VapidKey, subject: string): Promise<{ status: number; reason?: string }> {
  if (!t.webPush) return { status: 0, reason: 'no keys' };
  const problem = endpointProblem(t.apnsToken);
  if (problem) return { status: 0, reason: `endpoint is ${problem}` };
  let text = JSON.stringify({ threadId: alert.threadId, ...(t.pushKey ? { e: seal(t.pushKey, JSON.stringify({ title: alert.title, body: alert.body })) } : {}) });
  // A very long title or text: the phone shows its stand-in rather than nothing.
  if (Buffer.byteLength(text) > WEB_PUSH_PLAINTEXT_MAX) text = JSON.stringify({ threadId: alert.threadId });
  let body: Buffer;
  try {
    body = encryptWebPush(Buffer.from(text), Buffer.from(t.webPush.p256dh, 'base64url'), Buffer.from(t.webPush.auth, 'base64url'));
  } catch {
    // Keys that aren't a point on the curve: no send can ever work, so the
    // registration goes, as a dropped one does (410).
    return { status: 410, reason: 'keys unusable' };
  }
  return await postPinned(t.apnsToken, { TTL: '3600', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuthorization(t.apnsToken, key, subject) }, body, 10_000);
}

// Posts over node:https rather than fetch, so the addresses the endpoint's
// name resolves to are checked as the socket connects to them (the lookup
// below), not in a separate lookup a name could answer differently. The
// connection goes to an address that was checked, TLS still checks the
// certificate for the name, and redirects are never followed (https.request
// doesn't). `ms` covers everything, the lookup included, and at most 256
// bytes of an error's body are read.
function postPinned(endpoint: string, headers: Record<string, string>, body: Buffer, ms: number): Promise<{ status: number; reason?: string }> {
  return new Promise((resolve) => {
    const u = new URL(endpoint);
    let done = false;
    let req: ReturnType<typeof httpsRequest> | undefined;
    const finish = (r: { status: number; reason?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req?.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ status: 0, reason: 'timeout' }), ms);
    req = httpsRequest(
      {
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(body.length) },
        agent: false,
        lookup: pinnedLookup(privateAddress) as never,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          res.resume();
          return finish({ status });
        }
        let got = Buffer.alloc(0);
        res.on('data', (c: Buffer) => {
          got = Buffer.concat([got, c]).subarray(0, 256);
          if (got.length >= 256) finish({ status, reason: got.toString('utf8').slice(0, 80) });
        });
        res.on('end', () => finish({ status, reason: got.toString('utf8').slice(0, 80) || undefined }));
        res.on('error', () => finish({ status }));
      },
    );
    req.on('error', (e) => finish({ status: 0, reason: e.message }));
    req.end(body);
  });
}

// Scheduled by sync:upsertThreads when a thread starts needing Mike, and by
// sync:setPresence (held: true) when he leaves the Mac with one still
// waiting. Each phone has its own setting: "always" gets every one, "away"
// (the default) only while he isn't at the Mac (the rest are held for when
// he leaves), "off" none.
export const notify = internalAction({
  // retried: devices.holdPush found him gone and sent this back once.
  args: { threadId: v.string(), held: v.optional(v.boolean()), retried: v.optional(v.boolean()) },
  returns: vSendResult,
  handler: async (ctx, { threadId, held, retried }): Promise<SendSummary> => {
    const t: { title: string; status: string; preview: string; pendingApproval?: any; needsYou: boolean; atMac: boolean; mac?: string } | null = await ctx.runQuery(internal.devices.threadForPush, { threadId });
    // It may have been seen on the Mac in the meantime.
    if (!t || !t.needsYou) return { sent: 0, failed: 0, skipped: 'noLongerNeedsYou' };
    const alert = { ...pushText(t), threadId };
    // A held push only goes to the phones that waited for it. He may be
    // back at the Mac by now (a Mac that slept with him at it, its held
    // pushes sent by sync:sendStaleHeldPushes, woke before this ran): then
    // it's held again (Codex's review).
    // An alert some phone really got can be taken down by one clear
    // (devices:alerted, sync:upsertThreads wantsClear, Daybreak 169).
    const delivered = async (r: SendSummary): Promise<SendSummary> => {
      if (r.sent > 0) await ctx.runMutation(internal.devices.alerted, { threadId });
      return r;
    };
    if (held) {
      if (!t.atMac) return await delivered(await sendAlert(ctx, alert, (n) => n === 'away'));
      await ctx.runMutation(internal.devices.holdPush, { threadId, ...(retried ? { retried } : {}) });
      return { sent: 0, failed: 0, skipped: 'atMac' };
    }
    if (!t.atMac) return await delivered(await sendAlert(ctx, alert));
    await ctx.runMutation(internal.devices.holdPush, { threadId });
    const r = await delivered(await sendAlert(ctx, alert, (n) => n === 'always'));
    return r.skipped === 'noDevices' ? { ...r, skipped: 'atMac' } : r;
  },
});

// A test to every registered phone:
//   npx convex run push:test '{"body":"hello from Convex"}' --prod
// (PUSH_VIA=relay in the env sends through the relay even with a key.)
export const test = internalAction({
  args: { title: v.optional(v.string()), body: v.optional(v.string()) },
  returns: vSendResult,
  handler: async (ctx, { title, body }): Promise<SendSummary> => await sendAlert(ctx, { title: title ?? 'Threadbear', body: body ?? 'Test notification', threadId: 'test' }),
});

// The thread stopped needing Mike after a push went out for it (sync:upsertThreads):
// a silent push to each phone that gets them, to take its notification down,
// so the phone isn't left with ones he's already dealt with. The iPhone app
// (AppDelegate) and the Android one (ThreadbearMessagingService) read
// `clear`; apps from before it ignore it, as it has no alert and no
// `threadId`. Through the relay's /clear, which a relay from before it
// answers with a 404: then nothing happens, as before. Best effort: iOS
// may hold a background push back, and the app tidies up when it next opens
// too. Not counted in pushHealth, which is about notifications reaching him.
export const clear = internalAction({
  args: { threadId: v.string() },
  returns: v.object({ sent: v.number(), failed: v.number() }),
  handler: async (ctx, { threadId }): Promise<{ sent: number; failed: number }> => {
    // Not UnifiedPush phones (the F-Droid build) yet: they'd need a clear of
    // their own through sendWebPush, and their notifications still come down
    // when the thread is opened there.
    const targets = ((await ctx.runQuery(internal.devices.targets, {})) as Target[]).filter((t) => t.notify !== 'off' && t.platform !== 'webpush');
    if (!targets.length) return { sent: 0, failed: 0 };
    const cfg = apnsConfig();
    const direct = cfg && process.env.PUSH_VIA !== 'relay' ? targets.filter((t) => t.platform !== 'android') : [];
    const relayed = targets.filter((t) => !direct.includes(t));
    let sent = 0;
    let failed = 0;
    if (direct.length && cfg) {
      const payload = JSON.stringify({ aps: { 'content-available': 1 }, clear: threadId });
      const jwt = providerToken(cfg);
      for (const env of ['sandbox', 'production'] as const) {
        const tokens = direct.filter((t) => t.environment === env).map((t) => t.apnsToken);
        if (!tokens.length) continue;
        const session = http2.connect(env === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com');
        session.on('error', (e) => console.error(`[apns] session error: ${e.message}`));
        try {
          for (const r of await Promise.all(tokens.map((t) => sendOne(session, cfg, jwt, t, payload, 'background')))) {
            if (r.status === 200) sent++;
            else {
              failed++;
              console.warn(`[apns] clear ${failureText(r.status, r.reason)} for …${r.token.slice(-6)}`);
              // A phone Apple says is gone goes, as after a send.
              if (r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered') await ctx.runMutation(internal.devices.drop, { apnsToken: r.token });
            }
          }
        } finally {
          session.close();
        }
      }
    }
    if (relayed.length && process.env.PUSH_RELAY !== 'off') {
      const url = process.env.PUSH_RELAY_URL || RELAY_URL;
      const install = await relayInstall(ctx, url);
      if ('failure' in install) return { sent, failed: failed + relayed.length };
      for (const t of relayed) {
        const res = await fetch(`${url}/clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${install.installId}.${install.installKey}`, 'X-Threadbear-Version': `api-${API_VERSION}` },
          body: JSON.stringify({ deviceToken: t.apnsToken, environment: t.environment, threadId, ...(t.platform ? { platform: t.platform } : {}) }),
        }).catch(() => null);
        // A relay from before /clear: nothing to do, and no use trying the rest.
        if (res?.status === 404) return { sent, failed };
        const r = ((await res?.json().catch(() => ({}))) ?? {}) as { ok?: boolean; status?: number; reason?: string; gone?: boolean };
        if (r.ok) sent++;
        else {
          failed++;
          console.warn(`[relay] clear ${failureText(typeof r.status === 'number' ? r.status : (res?.status ?? 0), r.reason)} for …${t.apnsToken.slice(-6)}`);
          // A phone the relay says is gone goes, as after a send: each clear
          // to it uses up the relay's bad-token allowance (Daybreak 169).
          if (r.gone) await ctx.runMutation(internal.devices.drop, { apnsToken: t.apnsToken });
        }
      }
    }
    return { sent, failed };
  },
});
