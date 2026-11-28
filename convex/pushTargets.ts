// Which registered phones still get pushes: only those whose phone token is
// still good. Revoking a phone used to stop it reading the mirror but not
// its pushes, which carry a thread's title and the start of its text
// (pushText.ts). Plain TypeScript with no Convex imports, so the runner's
// unit tests can check it.

export type DeviceLink = { tokenId?: string; tokenName: string };
export type TokenState = { _id: string; name: string; expiresAt: number; revokedAt?: number };

// The same test as lib.ts checkPhoneToken.
const live = (t: TokenState, now: number) => !t.revokedAt && t.expiresAt >= now;

// A row registered since 5 Nov 2026 has its token's id and follows that
// token. An older one only has the token's name, and gets nothing: names
// aren't unique (tokens.ts issueToken), so while a second phone was paired
// under the same name, a revoked phone's old row would have kept getting
// pushes. A paired phone registers again with its token every time it
// starts (ios/Threadbear/ThreadbearApp.swift askForNotifications), which
// gives it a row with an id.
export function hasLiveToken(device: DeviceLink, tokens: TokenState[], now: number): boolean {
  if (!device.tokenId) return false;
  return tokens.some((t) => t._id === device.tokenId && live(t, now));
}

// The rows to delete once `revoked` is revoked: the ones registered with
// it, and every older name-only row of its name, even while another live
// token has that name (the row could be either phone's).
export function tiedToRevoked(device: DeviceLink, revoked: { _id: string; name: string }): boolean {
  if (device.tokenId) return device.tokenId === revoked._id;
  return device.tokenName === revoked.name;
}

// A phone with the thread open on screen right now (phone:setViewing) gets no
// push for it: Mike is reading it already. The phone says so again every
// half minute while it stays open, so a phone that was killed, or lost its
// signal, stops counting after VIEWING_FRESH_MS and gets its pushes again.
export const VIEWING_FRESH_MS = 90_000;
export type Viewing = { threadId: string; at: number };
export function viewingThread(device: { viewing?: Viewing }, threadId: string, now: number): boolean {
  const v = device.viewing;
  return v !== undefined && v.threadId === threadId && now - v.at < VIEWING_FRESH_MS;
}
