---
id: artifactPublish
name: Publish HTML previews
title: Publish a local HTML preview and copy a link anyone can open
added: 2026-11-27
on: false
reminder: b5405759
---

## What it does

Opening a local HTML file in the desktop app uploads it automatically to Convex file storage (up to 10 MB) as a **Private** link you can open with **Open on web** when signed in to Threadbear in your browser. Use the visibility menu to switch between **Private** and **Anyone with link**, update the web copy after local edits, or remove it. Inline styles, embedded media and inline scripts run inside an opaque sandbox isolated from Threadbear's sign-in, with background requests, subresources and forms blocked.

## Lives in

`artifacts.manage` in `runner/src/main.ts`, `sync:manageArtifact` and `convex/artifacts.ts`, and the controls in `desktop/gpui/src/files.rs`. The published view is `convex/artifactPage.ts`.

## Taking it out

Remove the desktop controls and the owner RPC, then the Convex functions and the public route. Existing links stop working when the route goes away. Delete the artifacts table once its records have been removed.
