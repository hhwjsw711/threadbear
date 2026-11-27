# Threadbear for Android (native)

A native Android app, Kotlin and Jetpack Compose, ported from the iPhone app
(`ios/`). It lives in `android-native/`, not `android/`: Keith's fork
(platima/threadbear) has a Tauri wrapper in `android/` and merges our main,
so that name is his.

Like the iPhone app it talks only to the Convex mirror (`convex/phone.ts`,
with a phone token), never to a runner, so it works with the Mac asleep.
Same deliberately small feature set: no search, no sort, no settings beyond
what the iPhone has.

- applicationId `com.mikerosoft.threadbear.android` (Keith's wrapper is
  `com.tinkerware.threadbear`), debug-signed for now.
- Convex: `dev.convex:android-convexmobile`, used at its FFI layer
  (`MobileConvexClient`) so answers stay raw JSON, as the Swift app does.
- Two flavours (below): `github`, the APK on GitHub releases, and
  `fdroid`, for the F-Droid store, with no Google code.
- Built with `android-native/build.sh` (capped memory, one Gradle worker
  pair, no Kotlin daemon), on the Hetzner box or the M5. On a Mac it takes
  the SDK from ~/Library/Android/sdk and its lock through lockf, and goes
  through `scripts/one-build.sh` like any other build there. Installs and
  screenshots go over `adb connect pixel.<tailnet>.ts.net:5555`. A box
  whose adb key the Pixel hasn't allowed keeps putting "Allow USB
  debugging?" over the app until it's disconnected (`adb disconnect`).

## Layout

- `kit/`: plain Kotlin (JVM), the port of `ios/ThreadbearKit`: the rows
  (lenient JSON reading, one bad row is skipped, not the list), the inbox
  sections and urgency, row status words and relative times, turn folding,
  waiting sends, asks and answers, pairing links, the `Backend` interface
  over a `ConvexTransport`, and a fake transport for tests. `./gradlew
  :kit:test` runs its tests on the JVM, no device.
- `app/`: the Compose app: the Convex FFI transport, the token store
  (EncryptedSharedPreferences), screens, and the view model.

## What's ported from ThreadbearKit

| iPhone (ThreadbearKit) | Android (kit) | Slice |
| --- | --- | --- |
| Models.swift (rows, statuses, approvals, ThreadChange) | `Models.kt` | 1 |
| FlexibleDate.swift | `Dates.kt` | 1 |
| Backend.swift, ConvexTransport.swift (protocol) | `Backend.kt`, `Transport.kt` | 1 |
| Inbox.swift, InboxUrgency.swift (sections, RowStatus, RelativeTime, PreviewText) | `Inbox.kt` | 1 |
| Turns.swift, TurnGap.swift (folding, worked lines, dividers) | `Turns.kt` | 1 |
| Pairing.swift (link parsing) | `Pairing.kt` | 1 |
| WaitingSends.swift | `WaitingSends.kt` | 1 |
| MarkdownBlocks.swift | `Markdown.kt` | 1 (basic), 4 |
| AskAnswer/Answers (Turns.swift, Backend.swift) | `Asks.kt` | 2 |
| Secrets.swift, PairingRequest's key pins | `Secrets.kt` | 2 |
| PushKey.swift, PushTaps.swift | `Push.kt` | 3 |
| MessageHistory.swift (older chunks, caps) | `MessageHistory.kt` | 4 |
| MarkdownBlocks.swift (all of it: rich, drafts, nested quotes, pictures) | `Markdown.kt` | 4 |
| DraftBlock.swift | `DraftBlock.kt` | 4 |
| MarkdownBlocksView's inline marks (bold, code, links) | `InlineMarks.kt`, one linear scan, links never inside links | 4 |
| InlinePictures.swift, ThreadPictures (Models.swift) | `InlinePictures.kt`, `ThreadPictures.kt` | 4 |
| PictureDownload.swift, PictureMemory.swift, PictureFraming.swift | `PictureDownload.kt`, `PictureMemory.kt`, `PictureFraming.kt` | 4 |
| ReplyButtons.swift, ThreadLinks.swift, LinkPolicy.swift | `ReplyButtons.kt`, `ThreadLinks.kt`, `LinkPolicy.kt` | 4 |
| SlashCommands.swift (the palette's logic) | `SlashCommands.kt` | 4 |
| AgentHeader.swift, CardMentions.swift, ReviewAnswer.swift | same names, `.kt` | 4 |
| PageSwipes.swift, Plans.swift | `PageSwipes.kt`, `Plans.kt` | 4 |
| PhotoUpload | | 4 |
| Pocket.swift, PocketIcon.swift | `Pocket.kt` | 5 |
| InboxMoves.swift, Tucks.swift | `InboxMoves.kt`, `Tucks.kt` | 5 |
| ThreadSearch (Inbox.swift) | `Search.kt` | 5 |
| NotifyMode, AppModel's runner order and offline line | `Settings.kt` | 5 |
| AppModel's StartingThread (new threads on their way) | `Starting.kt` | 5 |
| PendingCommand.swift, PendingCommands.swift (a command sent and waited on, and its one watcher; shared/cases/pending-commands.json) | `PendingCommand.kt`, `PendingCommands.kt` | 6 |
| DesignReviews.swift, ReviewCanvas.swift (the review, its draft and marks, the board's layout, tour, camera and doodles) | `DesignReviews.kt`, `ReviewCanvas.kt` | 8 |
| The website's ShareControl (web/src/share.tsx): the link from site and slug, what the sheet shows with a tap on its way | `Share.kt` | 7 |

Dictation uses Android's own SpeechRecognizer (on-device where the phone
has it), not Whisper; there's one recognizer, so no "Dictate with" choice.

Not ported: Quick Ask (Mike, 11 Nov: not needed), Whisper, the bear and pull-peek, the
Pocket's "here" mark (it needs location and a map search), the rows flying
between headings (RowFlight), the demo's sample data beyond what tests need.

Behind the iPhone, and written down where a test keeps it true: the backend APIs
74 (search everywhere, the librarian's keywords), 76 (lab review) and 79 (login notes), with 73 (loose ends) and 89 (answers on a message), in
`shared/cases/wire-rows.json` (its `differs`, which `WireRowsTest.kt` skips), and
tool output in docs/parity.md's Android column
(`runner/src/parity.ts`, which checks each against what the kit calls). Port one
and those tests say to take its note out.

## Flavours

One dimension, `store`, with two flavours. Everything is shared but the
few pieces that would bring Google's closed code in, which live in
`app/src/github/` and `app/src/fdroid/`, each with its own manifest.

| | `github` | `fdroid` |
| --- | --- | --- |
| Where it's sold | GitHub releases (below) | the F-Droid store (Mike's choice, 19 Nov 2026, as Keith suggested) |
| Push | Firebase, through the relay (`FirebasePush.kt`) | UnifiedPush, `org.unifiedpush.android:connector` 3.3.6 (`UnifiedPushTransport.kt`) |
| Code scanner | ML Kit's Google code scanner, no camera permission | ZXing (`com.journeyapps:zxing-android-embedded` 4.3.0), CAMERA asked at the Scan tap (`QrScanner.kt`) |
| Updates | asks GitHub (`Updates.kt`, `SELF_UPDATE` true) | none: F-Droid updates it (`SELF_UPDATE` false) |

Both flavours share `Push` (the push key, showing a notification, the
pairing lock), and each gives a `StorePush` (`PushTransport`): where the
backend reaches the phone, forgetting that on unpairing, and how far it's
set up for Settings.

Building one: `./build.sh :app:assembleGithubDebug`, `:app:assembleFdroidDebug`,
and `...Release` for each. CI builds `:app:assembleGithubDebug` and
`:app:assembleFdroidRelease` on every push and runs
`./check-fdroid-apk.sh` on the fdroid APK, which fails if any
`com.google.firebase`, `com.google.android.gms` or `com.google.mlkit` class
is in it. (Google's free libraries are fine there: Tink, which the
UnifiedPush connector decrypts with, protobuf, Gson, ZXing, and Material
Components through the Convex client.)

### UnifiedPush (fdroid)

The phone needs a UnifiedPush app, a "distributor" such as ntfy, which
holds one connection for every app that uses it. Without one push is off,
and Settings says notifications need one, with a link to
https://unifiedpush.org/users/distributors/. With more than one and no
default, Settings offers to choose. The connector makes the Web Push keys
and decrypts each message itself.

Only for a backend at API 93 or later (`BackendApi.WEB_PUSH`), on each
connect and resume as for Firebase:

1. `phone:webPushKey` (an action) gives the backend's VAPID public key,
   kept per pairing (it's fixed for a deployment).
2. `UnifiedPush.register` with it; the distributor answers with an
   endpoint in `ThreadbearPushService.onNewEndpoint`, now and whenever it
   changes.
3. `phone:registerDevice` with `platform: "webpush"`, the endpoint URL as
   `apnsToken` (https, 2048 characters at most), `pushKey` as for
   Firebase, and `webPush: { p256dh, auth }` from the connector
   (base64url, no padding). Notify me's `phone:setNotifications` takes the
   endpoint as its `apnsToken`.

The backend sends each notification as Web Push (RFC 8291 aes128gcm, with
VAPID), and the decrypted body is `{"threadId", "e"}`, `e` sealed with
the push key just as FCM's `data.e`, so `Push.show` opens it. One whose
sealed text would take the body past 3993 bytes comes without `e`, and
shows the stand-in ("A thread needs you"). The backend's `pushOff` (no
relay and no Apple key, as on a self-hosted backend) is about the relay,
so the fdroid build ignores it (`PushTransport.usesRelay`). Unpairing
unregisters from the distributor (Firebase's deleteToken, here). An older
backend gets no registration at all, and the app carries on without push.

### F-Droid

The listing's text and screenshots are in
`android-native/app/fastlane/metadata/android/en-US/`, which F-Droid reads
from the repo. Its build recipe (in F-Droid's fdroiddata repo, not here)
builds the `fdroid` flavour with the release's date as a Gradle property,
as it has no THREADBEAR_RELEASE in its environment. It writes the property
from `$$VERSION$$` in `prebuild` rather than a fixed `gradleprops` line,
since F-Droid's auto-update copies the last build block and changes only the
version and commit:

```yaml
    subdir: android-native/app
    gradle:
      - fdroid
    rm:
      - vendor
    prebuild: printf "\nthreadbearRelease=%s\n" "$$VERSION$$" >> ../gradle.properties
```

`rm: vendor` takes out the vendored state-machines tgz, which F-Droid's
source scanner refuses (the app doesn't use it). The app targets Java 17
bytecode with `jvmTarget` and `compileOptions`, not a JDK 17 toolchain, so
it builds on F-Droid's image, which only has Java 21. Tested with F-Droid's
own tools (`fdroid lint`, `fdroid build` in the buildserver image) on the
cloud box, 19 Nov 2026: it builds, and the APK has no Google classes.

The property and the environment variable both set the version; the
property wins if both are there. F-Droid's update check can't read a version
that comes from the tag, so each release's `release` job also attaches
`android-version.txt` (`versionCode=20261119`, `versionName=2026-11-19`),
which the recipe reads from `releases/latest/download/` (`UpdateCheckMode:
HTTP`), with `AutoUpdateMode: Version release/%v` to build the matching tag.
The draft recipe is in `~/dev/me/misc/threadbear-fdroid/` on Mike's M5 until
it goes to fdroiddata. F-Droid signs with its own key, so its
build and the GitHub one can't update each other: moving between them
means uninstalling (and pairing again). The Convex client (`libconvexmobile.so`)
and JNA (`libjnidispatch.so`) come from Maven Central with their native
code already built; both are Apache-2.0, but F-Droid's reviewers may ask
for them to be built from source in the recipe.

## Screens

1. Pair: Scan the code (camera: ML Kit's scanner on github, ZXing's on
   fdroid) and Paste a pairing code,
   both asking "Pair with <server>?" before keeping anything, trading the
   Mac's one-use code for a token (`tokens:claim`) and checking it with
   `phone:me`. No `threadbear://pair` link opens the app: any app can
   claim the scheme (Daybreak 127), so one sent to it outright is refused.
2. Inbox: Coordinators (when enabled), Starred, Inbox, Running, Hibernating, Archived headings (the last
   three folded at first), rows like the iPhone's: project tile, title,
   place, status word or time, unread dot. Swipe to archive, long-press for
   Star/Hibernate. Offline/connection line at the top.
3. Thread: the folded transcript, live (`phone:thread` + `phone:messages`),
   the working line while it runs, waiting sends with Cancel, the composer
   with Send turning into Stop while a turn runs, then the cards: approval,
   question, secret, asks, done. Replies draw all of MarkdownBlocks:
   tables, code (coloured by its fence language with the Mac's theme colours,
   kit CodeColours.kt: a small tokenizer, plain past 20,000 characters), nested quotes, ```slack/```email/```draft boxes with Copy,
   ```mermaid and ```html in a locked-down web view (Pele bundled in
   assets, as on the iPhone: no network, no navigation, a page's own
   scripts never run), and pictures (capped download with one deadline,
   50 MP header check, downsampled, one 96 MB cache, tap for full screen).
   Reply buttons, thread chips and links (anything but a web page asks
   first), work: links opening the turn's working, the slash palette,
   plan cards and the plan sheet, older history in chunks, and
   swipe left for Forward / right for Back. The menu's Share… opens a
   sheet like the website's Share panel: Share with a link (`phone:share`,
   backend API 8), the link with Copy and Send (Android's share sheet),
   and New link. The link is `<site>/s/<slug>`, the site from `phone:me`'s
   `site`, else a cloud deployment's `.convex.site` twin.
4. New thread (the bar's pencil): text with photos and dictation, runner,
   model and effort as the iPhone offers; it closes once the backend has it,
   a Starting row stands in, and the thread opens if it starts within a minute.
5. Settings (the bar's menu): paired server, phone, token expiry, runners
   and their order (drag by the handles), Notify me once push is on, the
   self-hosted note, Unpair with a confirm.
6. Pocket (the wallet button, with its count): the deck, a card full screen,
   swipe a card away with Undo, open its thread, "Add to my pocket".
7. Design reviews (backend API 86; the bar's Reviews button while one is
   pending, or a `review:` link): the list, then the Mac's comparison board
   in Compose (`ReviewBoard.kt`): pinch and drag, tap a picture to fly to it
   and again to look closer, the tour's ‹ n of m ›, the agent's marks with
   Caveat notes (`res/font`, OFL in `assets/caveat-OFL.txt`), Play/Stop for a
   video (MediaPlayer on a TextureView over its still) or sound, one at a
   time. From API 106, when the runner says `canMark`, circle, highlight
   and pin tools; each mark's cut-out is uploaded fresh for every Send and
   let go if it fails, as the iPhone's.

The inbox's search is always showing, and after a 300 ms pause asks Convex
for archived threads past the newest 100 (`phone:search`). Rows swipe left
to archive and right to hibernate (wake, a starred one that's asleep), and
a long press has Star, Hibernate, Archive, Mark as read and Copy Thread ID.
Archive and hibernate hide the row at once and wait for the runner
(ShellModel), as the iPhone's do.

## Slices

1. Pairing, inbox, open a thread and watch it stream, send, stop.
2. Cards: approvals, questions, secrets (sealed), asks, done card with
   follow-ups and archive.
3. Push: FCM through the relay, with Mike's own Firebase project
   (`threadbear-android`, his choice on 11 Nov) as the relay's second key
   (docs/push-relay.md); tap opens the thread. The app's
   google-services.json is kept out of git: the build reads it from
   `app/` or `~/.config/threadbear-android/`, and without it push is off.
4. The rest: hibernate/star/archive menus, new thread, photos, older
   history, reply buttons, links, markdown tables and code.

Each slice: kit tests for what it ports, screenshots from Mike's Pixel in
dark mode, pushed to `cloud/android-native`, landed from the M5. All four
plus the inbox shell (5) landed on 11 Nov, after cross-lab reviews.

## Releases

Mike chose GitHub releases over Google Play (11 Nov 2026): no Play account
or review, and how Keith ships his. For each `release/YYYY-MM-DD` tag Mike's
runner pushes, `.github/workflows/android.yml` builds a signed APK on a
standard (free) GitHub runner and attaches it to that tag's GitHub release
as `threadbear-android.apk`, so the newest is always at
https://github.com/mikecann/threadbear/releases/latest/download/threadbear-android.apk.
A release from before `android-native/` existed is skipped, and in a fork
the job doesn't run (no secrets there). The same workflow builds and tests
the app on every push to main and on PRs that touch it, so each commit has
an Android verdict for the daily tag to wait on.

- The release is two jobs, so the key never meets the build (Daybreak 123,
  15 Nov 2026): `apk` builds an unsigned APK (Gradle, with the Firebase
  config and a read-only token) and hands it on with its SHA-256;
  `release` checks those exact bytes, signs them with `apksigner` and
  publishes, with no actions, nothing checked out and no Gradle (the Gradle
  wrapper's download is pinned by its SHA-256 too). Every action in every
  workflow is pinned to a full commit SHA, with its tag in a comment;
  `runner/test/unit/workflow-pins.test.ts` fails on a tag or branch.
- The version is the tag's date (`versionName` 2026-11-12, `versionCode`
  20261112), so each release installs over the last: `THREADBEAR_RELEASE`
  in the environment, or `-PthreadbearRelease=2026-11-12` (what F-Droid
  passes). A local build is `dev`, version code 1, and never offers itself
  an update. The release job builds the github flavour
  (`:app:assembleGithubRelease`).
- The release key (`threadbear`, RSA 4096, made 11 Nov 2026, certificate
  SHA-256 `185d962a…c358`, pinned in the workflow) is a secret of the
  `android-release` environment (`ANDROID_KEYSTORE_BASE64`,
  `ANDROID_KEYSTORE_PASSWORD`, with `ANDROID_GOOGLE_SERVICES_JSON` for push),
  which only hands secrets to jobs on release/* tags; only Mike can write
  tags (the "Only Mike writes tags" ruleset). Mike's choice over keeping it
  on his Mac. A release's APK is never replaced once attached, and only
  the newest release tag is marked latest. The backup is
  `~/.config/threadbear-android/release.jks` and `release-password` on the
  M5, which a local `:app:assembleGithubRelease` (or `assembleFdroidRelease`)
  signs with. Android installs an
  update only if it's signed like the installed app, so losing the key
  means everyone uninstalling and reinstalling.
- The app asks GitHub for the latest release at most every six hours as
  it comes forward (`Updates.kt`, `AppUpdate` in the kit), release builds
  only. A newer one puts a dot on the inbox's menu, an "Update to 12 Nov"
  item in it, and the same in Settings, App; tapping it opens the APK in the
  browser, and Android asks to install.
- A debug build is signed with the build machine's debug key, so going from
  one to a release build means uninstalling (and pairing again) once.
