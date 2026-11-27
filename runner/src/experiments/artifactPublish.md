---
id: artifactPublish
name: Publish HTML previews
title: Publish a local HTML preview and copy a link anyone can open
added: 2026-11-27
on: false
reminder: b5405759
---

## What it does

Open a local HTML file in the desktop app and choose **Publish**. The main runner uploads that one file to your Threadbear Convex deployment and gives you a link anyone can open. **Publish update** uses the same link. **Unpublish** takes it down. Inline styles and embedded images work. The published page runs with scripts and external requests blocked.

## Lives in

`artifacts.manage` in `runner/src/main.ts`, `sync:manageArtifact` and `convex/artifacts.ts`, and the controls in `desktop/gpui/src/files.rs`. The published view is `convex/artifactPage.ts`.

## Taking it out

Remove the desktop controls and the owner RPC, then the Convex functions and the public route. Existing links stop working when the route goes away. Delete the artifacts table once its records have been removed.
