---
id: livePages
name: Live pages
title: Live pages: a page an agent shows in its reply runs in the thread, sealed, on the Mac and the phone
added: 2026-11-19
on: false
reminder: 900003ca
---

## What it does

An agent can show you something that moves or that you can turn around (a 3D model, an animation, a small simulation) as a live page: one self-contained HTML file it puts in its reply like a picture, `![Garden lights](/path/garden.html)`. The thread shows it as a card with Run, on the Mac and on the iPhone (it goes up the way pictures in replies do, at most 10 MB; the Android app and the website don't run them yet). Run starts it there in the card, for that version of the page; on the Mac it shows while the whole card is in view. It stays sealed off: it can't reach the internet or read any file but its own, and it can't open anything. A page an agent only pins stays on the Mac.

Comparison HTML has an explicit Interact action, independent of this flag.
It reuses the same sealed runtime (single file only); the flag still controls
transcript cards and their upload. Review HTML follows review media delivery,
which the backend already accepts, and runs full screen on iPhone. Website
comparisons stay static because browsers cannot enforce the native WebRTC seal.

## Lives in

`runner/src/share-images.ts` (`PAGE_TYPE`, `sniffPage`, `replyImagesInEvent`'s `pages`), `livePages()` and the upload in `runner/src/sync.ts`, `LIVE_PAGES_LINE` in `runner/src/threadbear-mcp.ts` (what agents are told, with `richGuidance` in main.ts), `REPLY_TYPES` in `convex/sync.ts` and `mediaType` in `convex/share.ts`'s `phoneImage`; the Mac's card in `desktop/gpui/src/live_pages.rs` (with `live_page` in web_panels.rs and `PreviewSite::live` in desktop/web), the iPhone's in `ios/Threadbear/LivePageView.swift`. docs/live-pages-design/README.md has the plan and what's built.

## Taking it out

Delete the file, `LIVE_PAGES_LINE` and its uses in threadbear-mcp.ts and main.ts (`richGuidance` goes back to `RICH_BLOCKS_LINE`), `PAGE_TYPE`, `sniffPage` and the `pages` argument in share-images.ts, `livePages()` in sync.ts, `text/html` from `REPLY_TYPES` in convex/sync.ts, live_pages.rs and its plugin and `markdown::live_pages` call in rows.rs, `live_page`/`close_live_pages` in web_panels.rs, `PreviewSite::live` and `workers`, LivePageView.swift and its branch in ThreadView.swift.
