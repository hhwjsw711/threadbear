# The website

Threadbear in a browser, so a thread has a link you can paste anywhere:
`https://<your-deployment>.convex.site/t/<threadId>`, or your custom
HTTP Actions domain followed by `/t/<threadId>`.
Built 28 Oct 2026 (thread 66935d23).

## What it is

- `web/`: a small Vite + React app, looking like the Mac app (refreshed
  3 Nov 2026, thread c1d311fd, from design B in
  `docs/web-refresh-design/`). Signed in, it's the Mac's window: a sidebar
  (`web/src/sidebar.tsx`) you can drag wider or narrower, with Starred,
  Inbox, Running, Hibernating and Archived under headings that fold and
  show their number. Which thread goes where is `web/src/sections.ts`, the
  same rules as the Mac's ThreadSections and the phone's InboxSections, so
  change them together. Hibernating and Archived start folded and are
  loaded only while open or while searching or filtering (`phone:counts`
  has their numbers until then). The Inbox heading sorts (needs you first,
  newest, oldest); the search looks through every section's titles, last
  replies and places, with `phone:search` for archived threads past the
  newest 100; the filter beside it picks needs you, unread, shared, or one
  project or folder; and the arrow keys walk the rows. Folds, the sort and
  the width are kept in this browser's localStorage. Down the left edge
  is a rail, as on the Mac (`web/src/rail.tsx`): Threads, Scheduled and
  Projects, a tile per runner with a dot for online, then Usage and a gear
  (appearance, sign out). Each opens a list in the sidebar and a page beside
  it (`web/src/pages.tsx`, at `/scheduled`, `/projects`, `/runners`, `/usage`,
  each with `/<id>`, a project's with `/<runnerId>/<id>` as its id is only
  its runner's own), which subscribe only while they're showing. A schedule
  has Pause and Run now (`phone:schedule`); anything else, and any change to a
  project, is on the Mac or through an agent. A project's page lists all its
  threads, live then archived, newest first, from `phone:projectThreads`
  for that runner's project (Show
  more for older ones). A runner's page has its CPU, memory and disk, reported
  only while that view is open (docs/protocol/moves.md, Sync, "Runner figures"), and
  its tile an orange dot while it's low on memory or disk. The sidebar and rail
  read `phone:wakes`, not the schedules. On a phone the rail is a tab bar, with Runners and Usage under
  More. The pencil beside the search starts a thread (`/new`, `phone:create`)
  on the runner's default folder, with a model and effort picker (since 26
  Nov; `web/src/new-thread-choices.ts`, a port of the iPhone's
  `NewThreadChoices`) listing the models its runner has logins for. And a
  thread whose finished turns fold to "Worked for 4m 12s" and the reply
  (`web/src/turns.ts`, a port of the iPhone's `Turns.fold`), with the
  pending approval, the end_turn card of asks or the done card's
  follow-ups joined to the composer. Return sends; Shift-Return is a new
  line. The header's Share button and ... menu (Copy link, Star,
  Hibernate or Wake, Archive or Bring back) do the rest. Opening a thread
  marks it seen.
- It's a client of the phone's API (`convex/phone.ts`, docs/convex-backend.md
  section 6) and nothing else, so it sees exactly what the phone sees: the
  text messages and one line per tool call, with no tool output, and only
  the images an agent showed Mike or a shared thread's. Everything
  it does is a `commands` row the runner applies.
- Hosted by `@convex-dev/static-hosting` on the same Convex deployment.
  Since 3 Nov the app owns HTTP routing (`convex/http.ts`) rather than
  mounting the component's routes at `/`: `registerStaticRoutes` serves
  the site, and one route of our own, `/s/`, serves a shared thread's
  page (below). Unknown paths fall back to `index.html`, so `/t/<id>`
  works cold.
- The Mac app's thread `...` menu has **Open on the web**. It takes the site
  from `runner.status`'s `sync.site` (configured in runner.json), falling
  back to `sync.url` (`.convex.cloud` → `.convex.site`), so
  it only shows while sync is on.

## Hosted HTML artifacts

The desktop app's **Publish HTML previews** experiment uploads a preview
through the owner runner. Publishing via the deployment's signed-in
Convex CLI also works. Run these from the repo root with the deployment
selected in `.env.local`:

```sh
node scripts/artifact.mjs publish trip.html "Trip plan"
node scripts/artifact.mjs update <slug> trip.html "Trip plan"
node scripts/artifact.mjs unpublish <slug>
```

Publish prints a standalone link anyone can open. It sends the HTML file
and title to Convex through the signed-in Convex CLI. Opening or editing the
local file leaves the published version alone. Update keeps the link, and
unpublish takes it down. The slug is the last part of the published URL.

Hosted artifacts take one UTF-8 HTML file up to 10 MB, stored in Convex file
storage (`_storage`). Opening a local HTML preview in the desktop app uploads
it automatically as **Private** (viewable only when signed in to Threadbear in
that browser via a one-use HttpOnly ticket cookie) and shows **Open on web**,
a visibility menu (**Private** / **Anyone with link**), and **Copy link**.
Inline styles, embedded media and inline scripts run inside an opaque sandbox
(`sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads`,
`default-src 'none'`, `connect-src 'none'`, `form-action 'none'`, no
`allow-same-origin`), isolating Threadbear's origin/sign-in and blocking
background requests, subresources and forms. The public
route is `GET /a/<slug>`; it returns 404 for an unknown or removed link, a
sign-in gate for private links, and its responses are never cached. Only the
owner runner and deployment admins can upload, change visibility or remove
artifacts.

## Sharing

A thread can be shared by link (docs/protocol/runners.md, "Sharing"): from the
share button beside the Mac app's ... menu, Share… in a thread's menu in the
iPhone and Android apps, or from the website, where
Mike's own thread page and the shared page (when he's signed in) have a
Share button: Share with a link, Copy, Stop sharing, and on his thread
page New link. Those queue a `share` command (`phone:share`) the runner
applies, as the Mac's button does. The phones (since 22 Nov:
`ios/Threadbear/ShareThreadSheet.swift`, Android's `ShareThreadSheet.kt`)
add the system share sheet to Copy, and build the link from `phone:me`'s
`site`. Built 28-29 Oct 2026 (thread ec75fe8b,
backend APIs 7 and 8).

The link is `<site>/s/<slug>`, a page with no sign-in (`web/src/share.tsx`),
read-only and live, served by `share:view` (`convex/share.ts`), the only
function that takes no phone token. It gives the title, when the thread
started, the model, the messages (with origin, summary and turn, so the
page folds each turn as the apps do), the tool lines and the thread's
pictures, and nothing else; or `gone` for a link that isn't shared.

Whoever opens a shared link usually isn't using Threadbear, so the page
reads as a short write-up rather than a chat: a big title, a byline
(model, date, turns, time worked), then each turn as the ask set as a
quote, its work folded to one "Worked for" line, and the answer, with the
pictures from the work shown large after it. On a wide screen an outline
of the asks sits on the left and marks the one you're reading; on a
narrow one it's the "3 turns" menu in the top bar. Copy link is top
right, and "Made with Threadbear" links to the landing page.

**Link previews.** Slack, X and Messages read a page's meta tags without
running its script, so `/s/<slug>` is served by `convex/http.ts`: the
site's `index.html` with the thread's title, the start of its last reply
(`share:preview`, Markdown flattened to sentences) and its first shared
picture as Open Graph and Twitter card tags, `no-store` so a link that
stops being shared stops unfurling. Mike's Share panel shows the same
preview. With Mike's token it also answers while the
thread isn't shared, with `manage`, so his page keeps its controls.

Pictures are in file storage (`shareImages`), uploaded by the runner only
while the thread is shared and dropped when it stops, and served to
anyone with the link through `/share/image/<slug>/<id>` (`convex/http.ts`),
which checks at every request that the thread is still shared under that
link, so a saved picture URL stops with the share, and only real
pictures from the thread's media folder (attachments, tool pictures, and
what the agent copies into `THREADBEAR_MEDIA_DIR`), never its working
folder or a temp folder (docs/protocol/runners.md, "Sharing"). A picture written in
a message's Markdown (`src`) takes the place of that Markdown image; the
rest go after the row they came with. Mike's own thread page shows them
too (`phone:messages` returns them), with what he pasted into his own messages
(`src` `picture:N`, `web/src/picture-chips.ts`), which goes up for every thread as
it's sent, never for a shared page. A Markdown picture that wasn't
uploaded shows as its alt text, not a broken image.

Sharing with specific people (an emailed code, through Resend) was built
on 28 Oct and taken out on 29 Oct: Mike wanted a public link and nothing
else for now, and it needed a Resend key Threadbear doesn't have.

## Design reviews

A thread's design reviews open as the comparison board, over the whole
window (since 27 Nov 2026, thread 5e71442b): from the header's Reviews
button while the thread has pending ones, a `review:<id>` link in a reply,
or an ask's review link. It's a port of the iPhone's board
(`ios/Threadbear/ReviewBoard.swift`), which ports the Mac's: the logic
(layout, tour, camera, ink, the draft and its marks) is
`web/src/review-model.ts` with its tests, the drawing
`web/src/review-board.tsx`, and the calls `web/src/review-backend.ts`:
`phone:designReviews` and `phone:respondReview` as commands followed with
`phone:command`, the stills and media through `phone:reviewImages`, and each
mark's cut-out cropped in a canvas and uploaded with `phone:imageUploadUrl`
(fresh every attempt, discarded with `phone:discardImage` if the send
fails). The browser token works for all of these, as for the rest of
`phone:*`. The board follows the site's light or dark theme, with the Mac's
colours for each, and the notes' handwriting is Caveat, served from
`web/public/fonts/` with its licence (no font CDN).

Cut-outs read the stills from file storage on `.convex.cloud`, which
answers with CORS for the site, so the canvas stays readable. The upload
goes to `/phone/upload` on `.convex.site`, the site's own origin, so it
only works on the hosted site, not from Vite on localhost (no CORS there):
from localhost a send with marks fails and keeps the answer.

To check the board without a runner, `web/review-fixture.html` (dev only;
the build takes `index.html` alone) draws it with sample data and a
pretend backend: `npm run web:dev`, then `/review-fixture.html`
(`?fail=1`, `?answered=1`, `?id=` for the list; what it would have sent is
in `window.__reviewSent`).

## Signing in

The browser holds a browser token (`convex/tokens.ts`) in localStorage. The
Mac app gets one for it through the runner (docs/protocol/moves.md "Devices"):
Settings › Phone & browser › "Open signed in" opens the site in the default
browser with a one-use sign-in code in the link's `#fragment`, which the
page trades for the token (`tokens:claim`) and wipes from the address bar,
and the same tab lists the signed-in browsers with Revoke. Since 28 Oct
that's the usual way. The code works once, for ten minutes; the link
never holds the token (since 16 Nov: a token in a link stayed good for 90
days wherever the link was seen), and the page doesn't keep one from an
old link's `#token=`. A browser that's already signed in asks before it
trades a link's code ("Sign this browser in again?", `web/src/replace-sign-in.tsx`),
as a thread's words can link to this site with a `#code=` of their own;
until you say yes nothing is claimed, and a swap that fails keeps the
sign-in it had.

Every link the site draws from a thread (a reply's Markdown, an ask's
links, a draft's addresses, a picture shown as a link) goes through one
rule, `web/src/link-policy.ts`: a web page (http or https with a host)
opens; any other kind (`mailto:`, `slack:`, `intent:`) asks first, naming
the whole address (`web/src/link-confirm.tsx`), and has no `href` for a
middle click to take past the question; and `javascript:`, `data:`,
`file:` and the like, or an address over 2,048 characters, are just
words. The backend also keeps only web links on a thread's asks and links
(API 82).
Every page the backend serves, the shared ones (`/s/`) too, says no
other site may frame it (`X-Frame-Options: DENY`, `frame-ancestors
'none'`; `NO_FRAMES` in `convex/http.ts`), so that question can't be
clicked through from a page laid over a hidden frame.

From a terminal, by someone logged in to the Convex team:

    npm run web:sign-in                  # the default browser, prod, 90 days
    npm run web:sign-in -- --qr          # a QR code for another device
    npm run web:sign-in -- --dev         # the dev deployment's site
    npm run web:sign-in -- --local       # Vite on localhost:5181, dev data

`web/scripts/sign-in.swift` puts a one-use sign-in code
(`tokens:issueCode` with `kind: "browser"`) in the link's `#fragment`,
which browsers never send to a server; the page trades it for the token
and wipes it from the address bar. Neither is ever printed. Revoke a browser from Settings ›
Phone & browser, or with `npx convex run tokens:revoke '{"name":"web-mac"}'
--prod`; it then shows the sign-in page. The page is `noindex` and sends no referrer.

## Working on it

    VITE_CONVEX_URL=https://earnest-puffin-640.ap-southeast-2.convex.cloud npm run web:dev
    npm run web:sign-in -- --local

The dev deployment has no threads unless a dev runner mirrors to it, so for
a real look use prod data with a throwaway token (`--name web-test --days 1`,
revoke after).

**Deploying:** `npm run web:deploy` runs `convex deploy` (prod) and then
uploads `web/dist`. It asks before pushing to prod; from an agent, answer
through a pseudo-terminal (`(sleep 40; printf 'y\r') | script -q /dev/null
npm run web:deploy`). For a site-only change,
`npx static-hosting upload --build --build-command 'npm run web:build' --dist web/dist --prod`.
A plain `npm run web:build` refuses to run without `VITE_CONVEX_URL`, which
the static-hosting CLI sets: a build without it can't reach Convex.
In a thread's worktree there's no `.env.local` (it isn't in git), and the
upload says it "Could not reach component staticHosting": copy the main
checkout's in for the upload and delete it after.

## Custom domain

Add your domain in the production deployment's **Settings > Custom Domains**
with **HTTP Actions** as the request destination. Set the CNAME and verification
TXT records shown there, then wait for verification and test HTTPS before
changing any links. Override `CONVEX_SITE_URL` on that page and set `sync.site`
in each runner's runner.json to `https://<your-domain>`. Runners read that
configuration at startup. `npm run web:sign-in` uses `sync.site` too.

The iPhone and Android apps get the website address from `phone:me.site`,
which reads `CONVEX_SITE_URL`. Their Convex API address, and each runner's
`sync.url`, stay on the `.convex.cloud` endpoint: a custom HTTP Actions domain
does not serve the sync API. Keep both original domains enabled so existing
links, paired devices and browser sessions continue working.

Browser sign-in uses one-use pairing codes, with no external OAuth callback.
A new origin has its own browser storage, so open it signed in from the Mac
or with `npm run web:sign-in`. The automatic backend deploy rebuilds the
website when `sync.site` changes, adding that address to its image policy
through `VITE_CONVEX_SITE_URL`. For a manual website build, set that variable
to the custom address so shared pictures also work through the original host.
When `sync.site` is unset, the automatic deploy also honors a validated
`VITE_CONVEX_SITE_URL` from its environment. Both settings require HTTPS
(or loopback HTTP), with no userinfo, query, fragment or embedded whitespace.
Commas and semicolons are refused so an address cannot change the image policy.

## Not done

- Signing in from a browser without the Mac to hand (e.g. approve a new
  browser from the iPhone app). A QR code for another device's browser is
  still `npm run web:sign-in -- --qr`.
- Sharing from an agent's tools (the iPhone and Android apps have it,
  from a thread's menu).
