# Runner protocol: Events, design reviews and reply buttons

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

## Events

### Design reviews

`show_options` gives the calling thread a durable review of pictures,
videos, sounds and pages. It returns
promptly, with the review's id and the `review:<id>` link that opens it
from an ask or a message (see Needs you); the agent may finish its turn
while Mike reviews the options.
The app shows a compact card outside work groups. Opening it opens a
resizable, modeless window that steps through every shot of every option,
then shows the options side by side, with the options to tick, one reply
box and Send down the right; arrival never steals focus.

An option can have several shots (its overview, a state mid-interaction, a
detail) and a live `url`. Agents used to pass extra shots as options of
their own (A2, A3) that couldn't be picked; Mike also picked more than one
or none, and answered most reviews in the thread in his own words (4 Nov
2026), hence several picks, `none` and `reply`.

It's only for options that are seen or heard: images, videos, sounds, page designs. A
thread put a research shortlist in one as a page of text per option, and
Mike found comparing words there pointless (20 Nov 2026), so the tool and
the instructions send options in words to the reply instead.

`recommended` is the agent's own pick, marked with a star and "Recommended" in the rail and
over its picture, worded as an asks card marks `suggested`. Both notes are
inline markdown. Mike, 7 Nov 2026: the note was drawn raw in grey, so
backticks showed, nothing stood out, and "I'd pick C" sat halfway through
a paragraph.

```ts
// pickedIds lists every pick in the review's option order, only when there
// are two or more; pickedId is always the first pick, for older clients.
// Clients send pickedIds (it wins over pickedId); a client that sends only
// pickedId still works. none: none of them will do, never with picks.
// images: pictures pasted into the reply, each placed by a [Picture N] in
// reply, as a message's are (see Reply pictures, below).
type ReviewDraft = { pickedId?: string, pickedIds?: string[], notes: Record<string, string>, reply?: string, images?: ImageRef[], none?: true }
// media: a video (video/mp4, video/quicktime), a sound (audio/mpeg,
// audio/mp4, audio/aac, audio/wav) or an HTML page (text/html) the window
// plays or shows in place of image, which is then its still (a sound's is
// its waveform).
type ReviewShot = { title?: string, image: ImageRef, media?: ImageRef }
type DesignReview = {
  id: string
  title: string
  note?: string        // markdown (bold, code, links), drawn in the text colour
  recommended?: string // the option id the agent would pick: marked with a star and "Recommended", as on an asks card
  options: {
    id: string          // stable within this review
    title: string
    note?: string
    reference?: boolean // can have notes, cannot be picked
    image: ImageRef     // the first shot: a copy owned by the thread, never the source path
    shots?: ReviewShot[] // every shot in order, image first; only when more than one, the one has a title, media or marks (so marks always live on options[i].shots[j].marks, never on the option)
    url?: string        // http(s): where it runs live
  }[]
  status: "pending" | "answered" | "cancelled" | "superseded"
  revision: number     // optimistic concurrency for saves and submission
  createdAt: string
  updatedAt: string
  draft: ReviewDraft
  response?: ReviewDraft
  replyTurnId?: string
}
```

The following RPCs take full thread/review IDs. Unknown IDs are errors.

| method | params | result |
|---|---|---|
| `reviews.create` | `{ threadId, title, note?, options: { id, title, path?, shots?: { path, title? }[], url?, note?, reference? }[] }` | `{ review: DesignReview }` |
| `reviews.get` | `{ threadId, reviewId }` | `{ review: DesignReview }`; `reviewId` may be the start of one (8 or more characters) that names only it, among every review the thread has |
| `reviews.list` | `{ threadId }` | `{ reviews: DesignReview[] }` pending reviews only, oldest first |
| `reviews.save` | `{ threadId, reviewId, revision, draft: ReviewDraft }` | `{ review: DesignReview }` |
| `reviews.respond` | `{ threadId, reviewId, revision, draft: ReviewDraft }` | `{ review: DesignReview, turnId?: string }` |
| `reviews.cancel` | `{ threadId, reviewId, revision }` | `{ review: DesignReview }` |

Creation validates the whole request and imports supported files before
publishing the card. A shot's `path` is a picture (PNG, JPEG, GIF, WebP), a
video (MP4 or QuickTime, by its header), a sound (MP3, M4A, AAC or WAV, by
its header, or an MP4 named `.m4a`) or a page (`.html`/`.htm`). Agents
had to hand Mike stills of clips that only made sense moving (6 Nov 2026),
and Mike wanted to compare music beds and sounds as options (24 Nov 2026).
A video, sound or page is copied in as the shot's `media`, and its still, made by
Quick Look on a Mac or ffmpeg for a video elsewhere, and for a sound
ffmpeg's waveform, light on dark (a plain dark card when
none can), is its `image`, which thumbnails and older clients show. A
page comes in a folder of its own with the files it names (`src`, `href`,
`url()`, a stylesheet's own) from its folder down, at most 100 files and
50 MB; never anything above its folder, nor other pages it links to. The
Mac canvas keeps the page's static snapshot until its header's Interact
button is pressed. Double-click only looks closer, preserving marks and notes.
Interact runs that single self-contained HTML file in the sealed live-pages
runtime: scripts on, no network or sibling files, dialogs, popups, external
navigation or printing. Buttons, tabs, toggles and local state work offline.
Only one card runs per comparison window. Stop, a marking tool, a change of
review, closing the window or leaving valid canvas bounds destroys its view
and restores the original snapshot. The top tools and Stop stay outside the
native overlay. This explicit action is available independently of the
`livePages` experiment (which still gates pages in transcript replies).
The stage's ordinary page preview keeps scripts off.
The iPhone opens delivered HTML media full screen in its existing sealed
live-pages sandbox. The website keeps snapshots: browser iframes cannot
disable WebRTC as the native runtimes do, so scripts never run there. A video
loops. On the stage it has controls and plays with sound; side by side
with the others in the grid it's muted. A sound shows its waveform on the
stage with a play bar along its bottom, paused at the start, so stepping
through music beds doesn't start each; in the grid it's its waveform with a
music badge, never playing by itself. Paths can be absolute, home-relative or
relative to the thread's folder. An option's shots are `path` then
`shots`, or `shots` alone; it needs at least one. Limit: 12 options, 8
shots each and 40 in all, each image at most 25 MB, video 200 MB, sound
100 MB and page 5 MB (videos, sounds and pages 500 MB in all), nonempty unique option
IDs and titles, title/note at most 200/4000 characters, `url` http or https.
Draft notes are at most 4000 characters per option and the reply 8000;
unknown option IDs, picks of reference options and `none` with picks are
invalid. A response needs a pick, `none`, a reply, a picture or a nonblank note.
Saving an empty draft is allowed. The agent's message reads `Picked A.
<title>.` or `Picked A + D. <title> + <title>.`, or `Picked none of them.`,
then the reply as written, then any notes. With a pick, a last paragraph
names the pickable options passed over (`Passed over: B. <title>; C.
<title>.` and a fixed sentence, `PASSED_OVER_TAIL`), so the agent doesn't
later offer one as a new follow-up. The Mac, phone and GPUI apps read that
wording back for Mike's bubble (`ReviewAnswer`), leaving the passed-over
paragraph out, so change them with it.

Where the words are read (Mike, 20 and 21 Nov 2026): he went into the
window for the pictures and back out to the thread to read about them, as
the window drew each option's words at 12pt grey in a column 270pt wide, and
agents wrote the options out again in their reply. A page beside the thread
was tried for a day (the `reviewPage` experiment) and taken out: he went
back to the window, redrawn: the picture across its whole width, a tab for
each option under it, and under those the words of the option on show at
the thread's reading size beside the reply box. The review's card in the
thread shows the note and each option's small picture and name. So `show_options`' answer tells the agent
that each option's note is read there, and not to list or describe the
options again in its reply (`REVIEW_NOTE` in `runner/src/threadbear-mcp.ts`).
Nothing changed in these RPCs.

Reply pictures: a picture pasted or dropped in the window's reply box is a
chip, as in the thread's box, imported with `media.import` and sent in the
draft's `images` with `[Picture N]` markers in `reply` (Mike, 17 Nov 2026:
the box was plain text, so a pasted screenshot went in as its file path).
At most 20. Save and respond take only pictures in the runner's `inbox/`
(what `media.import` made) or ones already kept with the review, never a
link, and copy each into `media/<thread>/reviews/<id>/reply/` under a name
from its contents, so a draft outlives the inbox's week, saving the same
picture again keeps one copy, and a retried answer naming the inbox copy
is the same answer. The saved draft names those copies, and the window
takes them in place of its own. Pictures alone are an answer. The agent's
message carries them as its `images`.

#### Marks: the canvas

Mike, 22 Nov 2026: after an audit of how other apps show options with
several pictures, he asked for the review as a canvas you drag and zoom
around, with the agent drawing "little helpful arrows pointing out things
visually", in the doodle style of Convex Explained (handwritten notes, a
curled pointer, wobbly circles), a switch to hide them, and tools of his own
to circle, highlight or pin a part, each a chip in the reply he can talk
about.

The agent's marks ride on shots. In `reviews.create` (and `show_options`) a
shot may carry `marks`, and an option's own `marks` belong to its `path`
shot. Coordinates are fractions of the shot's picture (its still, for a
video or page), 0 to 1 from the top left, so they survive any size it's
drawn at. Unknown fields are ignored; clients that don't draw marks show
the pictures as before.

```ts
// kind: circle goes round box; underline runs along box's bottom edge;
// highlight is a marker swipe over box; arrow points at box's centre.
// ink: yellow points something out (the default), green is what solves
// it, rose is a cost. note: a few handwritten words beside the picture,
// joined to the mark by a curled pointer.
type ReviewMarkKind = "circle" | "underline" | "highlight" | "arrow"
type AgentMark = { kind: ReviewMarkKind, box: [number, number, number, number], note?: string, ink?: "yellow" | "green" | "rose" }
type ReviewShot = { title?: string, image: ImageRef, media?: ImageRef, marks?: AgentMark[] }
```

Limits: at most 6 marks a shot and 30 a review; `box` is four numbers in
0..1 with x0 <= x1 and y0 <= y1; a note is at most 80 characters. An
option's own `marks` need its `path`; with only `shots`, they go on a shot.
`ink` is stored only when given. `show_options` always offers marks, and
the runner validates them. A moved or recovered review keeps the marks
that pass, notes cut to 80 characters.

Mike's marks ride on the draft. Each is numbered from 1 in the order he
made it, and `reply` places each with a `[Mark N]` marker where he was
typing, as pictures are placed.

```ts
// kind: circle and highlight follow his stroke (path, fractions of the
// picture); pin is a single spot (path holds one point). box bounds the
// stroke. image: a cut-out of the picture around box, made by the app and
// imported with media.import, kept as reply pictures are.
type ReviewUserMark = { n: number, kind: "circle" | "highlight" | "pin", optionId: string, shot: number, box: [number, number, number, number], path?: [number, number][], image?: ImageRef }
type ReviewDraft = { /* as above */ marks?: ReviewUserMark[] }
```

`shot` is the 0-based index into the option's shots (its one `image` when
it has no `shots`). At most 20 marks, each `n` a whole number from 1 used
once, a path at most 400 points, each point clamped into 0..1 (a stroke can
run past the edge; `box` itself must be in 0..1). A mark whose option or
shot doesn't exist, or a reference option's, is invalid; a mark on its own
is an answer. The runner stores marks in `n` order. Like `images`, a draft
with no `marks` key keeps the saved ones (a client that doesn't draw them,
or the phone, which never sees them); `marks: []` takes them away. Draft
marks are taken whether or not the experiment is on. The agent's message,
after the reply and before the notes, has one paragraph with a line per mark
(joined by single newlines): `[Mark 1] circle on A. <title>, picture 2
(<shot title>), across 36-50% and down 83-92% of it.`; the shot title in
brackets only when it has one, and a span whose ends round the same reads as
one number (`across 40% and down 20% of it`, a pin). Each mark's cut-out
goes with the message's `images`, after the reply's pictures, in mark order.
Saved drafts keep marks, so a closed window comes back with them drawn. A
moved review keeps the draft's marks that still fit, without cut-outs.

Every change persists a `review.updated` event with `{ review: DesignReview }`.
An option's `url` is an http or https page; the Mac app drops any other
(a `file:` URL, another app's link) as it decodes one, whatever runner
sent it, and Open live opens only a web page.
Its stable card ID is the review ID; later snapshots update that card in
place even when the original event is outside the loaded transcript page.
`ThreadSummary.pendingReviews?: number` counts pending reviews and makes
`needsYou` true even after mark-read, turn-end and runner restart. It does
not hold a CLI open or prevent an update. Cancelling closes the request
without sending an agent message. A message from Mike in the thread
(from the app or the phone, not one sent by the runner, a schedule or
another thread's agent) supersedes every pending review there: he often
answers in the thread instead of the window. Each becomes `superseded`,
read-only like a cancelled one, with no agent message. Closing a window only keeps the draft.
The thread header can open pending reviews from `reviews.list`, including
requests older than the transcript's loaded event page; Mike does not need
to scroll back through earlier turns to find what still needs an answer.

Save and submit reject a stale revision with `-32602`; the client reloads
and preserves its unsaved text for retry. Answered/cancelled reviews are
read-only. Retrying an identical response to an answered review returns
the original result and never sends twice; a different response is an
error. The runner durably queues the submitted reply with its review ID
and structured response, alongside readable text naming the review and
each option. An idle agent resumes; a busy one receives it after its turn.
The queue survives restart. The response and queue are persisted together
before acknowledging submission. `user.message` may include `reviewId`
and `reviewResponse: ReviewDraft`; these identify the review that prompted
the reply. The same fields accompany queued replies on disk.

An internal delivery marker is saved after the CLI's `session.send` accepts
the reply. A crash between that call and the marker may replay the reply
after restart (at-least-once dispatch). Repeated `reviews.respond` requests
with the same response never add another reply.

Both Claude and Codex receive `threadbear.show_options` through the shared
MCP tool definitions, bound to the calling thread. Its schema matches
`reviews.create` without `threadId`; it returns the review ID and explains
that the choice/notes will arrive as a later message. The existing URL
patch panels are independent of these review windows. Reviews take
pictures, videos, sounds and pages, with a live `url` per option opened in the
browser; overlays are deferred.

#### Reviews on the phone

Backend API 86 adds `phone:designReviews(token, threadId, reviewId?)` and
`phone:respondReview(token, threadId, reviewId, revision, draft)`. Both queue
commands on the owning runner. Without an id the first returns pending
review titles (`{ reviews: [{ id, title }], truncated? }`); with an id, or
the start of one as a `review:` link gives, it returns that review, pending
or not (`{ review }`). `phone:command` carries the result, as JSON text
for the phone to parse (a draft's notes are keyed by option id, which
Convex can't take as an object key). The runner must
be online to read or answer a review. Responses use `reviews.respond`,
including its revision checks and idempotent retry behavior.

What the phone gets of a review has no paths in it: each shot's still is
named by an opaque `src` (`review:<reviewId>:<sha256 of its path>`), and the
draft or response is only `pickedId`, `pickedIds`, `notes`, `reply` and
`none`. A draft's pasted pictures (`images`, paths on the Mac) stay there,
and an answer from the phone keeps them. The answer's `notes` go as a list,
`[{ id, text }]`, as an option's id can be any text and Convex refuses an
object key that isn't plain ASCII or starts with `$`; the runner rebuilds
the draft from those fields alone.

A review's stills go up only when the phone opens that review: the
runner queues them as the `designReviews` command with an id runs, as reply
pictures at seq 0 whose `src` and `path` are both the opaque source, and `phone:reviewImages(token,
threadId, sources)` follows them as they arrive (`phone:images` leaves them
out). Only a file in the review's own media folder that isn't a link
goes (a moved review's paths are the other runner's word). One over the
reply-picture limit (10 MB) or in a format the phone
doesn't take is shrunk to a JPEG first, and one that can't be sent at all
comes with `preview: false`, so the phone says so rather than waiting.

Backend API 106 adds the comparison board. Each shot can carry the agent's
`marks` (`[{ kind, box, note?, ink }]`, as on the shot, with `ink` filled
in as `yellow` when the agent gave none) and `media`, an opaque source
named like a still's, for a video (`video/mp4`, `video/quicktime`) or
sound (`audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/wav`) of at most
10 MB in the review's own folder. The runner sends `media` only to a
backend of 106 or later, and uploads those files with the stills, as reply
pictures at seq 0 (`sync:addReplyImage` takes the sound types only for a
seq 0 row with a `review:` src); the phone fetches them with
`phone:reviewImages` (up to 80 sources a call). A page never goes. The
answer's draft can carry the phone's own `marks`, `[{ n, kind: circle |
highlight | pin, optionId, shot, box, storageId? }]`, at most 20, each box
fractions 0..1; `storageId` is the mark's cut-out (a JPEG the phone
uploaded with `phone:imageUploadUrl`), checked as a send's photos are.
Convex passes the cut-outs as the command's `images` (`[{ storageId, url
}]`) and each mark names its own by `image`, an index into them; the
runner downloads them as it does a send's photos and keeps them with the
review, so the answer reads as a Mac's does (`[Mark N]` in the reply, a
line and a cut-out per mark). The phone's marks join the ones saved on the
Mac, which stay: the review carries `canMark: true` from a runner that
does this (an older one would drop them, so the phone offers marking only
with it), `draft.nextMark`, the highest number among the Mac's saved marks
(0 with none), and `draft.markCount`, how many there are. The phone numbers
its marks from `nextMark + 1` (numbers need only be unique, so they can go
past 20) and allows `20 - markCount` more. A mark numbered as a saved one,
or more than 20 marks in all, fails the command with a note saying so. Only
a pending review is checked for that: a retry of an answer that already
went through is the same answer (a quiet success), and any other answer
to an answered review is refused as answered.

The phone's Reviews sheet opens from the pending-review button or a
`review:<id>` link. It shows reference and recommended options, each shot's
still, multiple picks, none, per-option notes and a reply. A delivered HTML
file opens full screen with Interact, using the sealed iOS live-pages
sandbox and Stop to dismiss. HTML, videos and sounds stay on the Mac before
API 106 or over 10 MB; the phone labels unavailable media's stills (a shot's `kind` is `image`, `video`, `audio` or
`page`; an unknown one reads as a still). Loading and
failed submissions keep the user's draft. A stale revision reloads the
review and requires another deliberate send. Older backends keep the
Mac-only explanation.

### Reply buttons

Standard since 11 Nov 2026 (it was the `replyButtons` experiment). Mike asked on 7 Nov 2026
for buttons partway through a long reply (the Daily brief's "Needs
attention" lines) that start a background thread with a brief the agent
wrote, or send a message to a thread that's already going, so he can set
jobs off as he reads without typing. He picked a tool that makes the
button over a link that carries the brief: the runner checks the folder,
login and target thread when the button is made, so a mistake reaches the
agent while it can still fix it, not Mike as a dead button the next
morning, and the brief lives in the thread rather than in the reply's
text.

The thread's agent calls `add_button`,
which stores a `ReplyButton` on the thread and returns its link,
`button:<id>`. The agent puts `[title](button:<id>)` in its reply where
it belongs; the apps draw that link as a button. A button the reply never
links isn't shown anywhere. Nothing runs until Mike presses it.

```ts
type ReplyButton = {
  id: string            // 8 lower-case letters and digits, unique in the thread
  title: string         // what the button says, at most 60 characters
  createdAt: string
  turnId?: string       // the turn that made it
  // Exactly one of start, send and panel.
  start?: {             // a new thread, as create_thread would make it
    text: string        // the brief, at most 20,000 characters
    title?: string
    cwd: string         // checked to be a folder when made
    accountId?: string  // checked to be a login when made
    poolId?: string     // checked to be a pool when made
    model?: string
    effort?: EffortLevel
    permissionMode: PermissionMode
    why?: string
  }
  send?: {              // a message to a thread of this runner's
    threadId: string    // checked to exist, and not to be this thread
    threadTitle: string // its title when made
    text: string        // at most 20,000 characters
  }
  panel?: {             // another folder's patch panel, opened beside this thread
    cwd: string         // the folder, checked when made
    panelId: string     // its web panel's id there, checked when made
    title: string       // its title then: "YouTube"
  }
  pressed?: { at: string, threadId: string } // the thread it started, or the one it messaged; a panel button's own thread, at its last press
  failed?: { at: string, error: string }     // the last press failed; it can be pressed again
}
```

| method | params | result |
|---|---|---|
| `buttons.press` | `{ threadId, buttonId }` | `{ button: ReplyButton }` Starts the thread or sends the message, once. A button already pressed returns as it is, with nothing run again, so a dropped reply or a second click (or a press from the phone and the Mac) never fires twice. A press that fails (the folder has gone, the target thread was deleted) is saved as `failed`, and the error comes back as `-32602`. A panel button is the exception: every press opens its panel again (below) |
| `buttons.list` | `{ threadId }` | `{ buttons: ReplyButton[] }` every button the thread has, oldest first |

**Panel buttons.** Mike asked on 18 Nov 2026 for the Daily brief's "Go
through comments" to open the YouTube patch's panel (from
`yt-channel-manager`) rather than start a thread, as he'd write his
comment replies there. A patch's panels only show for threads in its
folder, so `add_button`'s `panel: { folder, panel }` names a folder and one
of its web panels, by id or title, found as a thread there would have
them (a list panel, which the runner renders for a thread in that folder,
is refused). Pressing it adds that panel to the pressing thread's
`panels`, from then on, and asks for it to be shown as `show_panel` does
(a `panelRequest`), on every press: it opens a panel rather than doing a
job, so it's never spent, and the agent hears nothing of it. The panel's
`badge` and `summary` run in its folder whenever the thread's patches are
read, as for that folder's own threads, which is what starts a patch's
server (the YouTube patch's badge starts its page's). A press runs that
one panel's `badge` and `summary` and shows it, without waiting for the
rest of the thread's patches (on a busy runner that wait once kept the
panel away for 13 minutes, 23 Nov 2026). A client handed a `panelRequest` for a panel the summary
doesn't have yet waits for the summary that brings it. Its `id` is
`<panelId>@<8 hex of its folder's hash>` and it has `from`, its folder,
so nothing takes the thread for one of that folder's (the YouTube page
lists the threads that have its panel as ones to ask in). Its url's
`{threadId}` is left empty, for the same reason: the page sees no thread
of its own, and the YouTube page then offers its recent threads and New
thread for Ask Claude. A thread's newest press of each panel counts, so
a brief that makes the same button every day still has one panel. A
folder that has gone by the press fails it; a panel that isn't there
once the patches are read again (its patch broke, or its `when` hid it)
is saved as `failed` after the press. Only this runner's apps show it: the
phone and the website get start and send buttons only, so a panel
button's link is drawn there as its words.

Every change persists a `button.updated` event with `{ button }`; clients
keep the latest per id, as for reviews, and redraw any link to it. A
press marks the started thread as started by this thread (`startedBy`
`{ kind: "thread", label: "Button" }`) and its first message, or the message
sent, begins with the usual `[Sent by the agent in the thread ...]` line,
as the agent wrote the words and Mike only chose to send them.

The thread whose reply had the button hears of the press before Mike's
next message to it: a line from Threadbear naming each button pressed
since, the thread it started or messaged and the start of what it sent,
so its agent doesn't send the same job again (on 8 Nov 2026 the Daily
brief did, after Mike pressed RSVP yes and then said go ahead in his
reply). The line is kept on the thread (`presses` in thread.json, the
last 20) from the press, so it outlives the button. Read from disk (a
moved thread's thread.json is the old runner's), only well-formed notes
are kept, at most 220, each line at most 2,000 characters. Every list and
object in a record that the runner walks is put in the shape it expects
as it's read (`normaliseRecord` in store.ts: a `queue` that isn't a list
is empty, entries of the wrong kind go, a wait needs a thread id), a
record whose folder isn't a string is rebuilt, and every step of a start
that goes through the threads (recovery, summaries, stopped work, waits,
owed reviews) takes them one at a time: a thread that throws is said in a
notice and left as it is, rather than stopping the runner. A turn that doesn't
complete (a failure, Stop, a restart part way) hears it again, so does a
fresh session that replays the message, and so does an edit back past
the message that carried it. A run's press already tells the agent how
its command went, so it isn't in that line.

Safety. Only a thread's own agent can make its buttons: `add_button` is
bound to the calling thread like the other threadbear tools, and there's
no RPC that makes one. Pressing (Mike's click on the Mac, phone or
website) is the only thing that runs one. A thread that isn't in full
access can't make a button for more than it has: a new thread's
`permissionMode` defaults to the maker's and can't be above it, and a
message to a thread with more access is refused (send_message, which
asks first, is for that). A thread keeps its last 200 buttons.

Run on the card (asks carrying a `run` command with a Run button) was
taken out on 14 Nov 2026. `end_turn` ignores an ask's `run`, a button left
over from it (one with `run` and neither `start` nor `send`) refuses a
press, and clients ignore `run` on an ask. Backend API 71 still lets an
ask carry it, for rows written then.

On the phone and the website (Sync, backend API 59), pressing calls
`phone:press({ threadId, buttonId })`, which queues a `press` command with
`{ buttonId }` for the thread's runner; the runner calls `buttons.press`
and finishes the command with the thread it started or messaged as
`resultThreadId`, so `phone:command` hands the phone its id to open.
Each mirrored assistant message carries the state of the buttons its text
links, in the order it links them (`buttons?: { id, title, kind: "start" |
"send", target?: string, pressedThreadId?: string, failed?: string }[]`;
`target` is the new thread's folder name or the messaged thread's title,
and never the brief or message itself). A `button.updated` that presses or
fails a button sends the row that links it again (found among the thread's
recent events after a restart), and the backend changes only its
`buttons`. A link whose id the row doesn't carry is drawn as its title. A
shared page draws every button link as its title: whoever it's shared
with can't press Mike's buttons, and the share query doesn't return
`buttons`. The phone draws the buttons a line ends with as real buttons
after its words, and one partway through a line as a link that presses it.

Every persisted event has an envelope:

```ts
type Event = {
  seq: number           // 1, 2, 3 ... per thread, no gaps among persisted events
  ts: string
  threadId: string
  turnId?: string
  type: string
  // ...type-specific fields below
}
```

Persisted event types (stored in `events.ndjson`, returned by `threads.events`):

| type | fields |
|---|---|
| `user.message` | `text`, `images: ImageRef[]`, `answers?: AskAnswer[]` (the open card's asks it answers, as `threads.send` gave them: for showing, the agent only gets `text`), `origin?: "runner" \| "schedule" \| "phone"` (`runner` when the runner sent the message by itself, such as the resume after a restart, or one of its own tools did, such as `tb red-watch`'s news of CI on main (connection.md, `threads.send`); `schedule` when a schedule sent it, with `scheduleId`; `phone` when it came from the phone through the Convex mirror (Sync), and the agent then gets it after a line saying so and whether the user is at the Mac, though `text` keeps what was typed; absent for anything a person or client sent), `wakeReason?: string` (only with `origin: "runner"`: what happened, in a few words, such as "The Threadbear GPUI app restarted onto daabd88f7"; a turn the runner's message started gets the same "14 h later" divider as one background work woke, saying this, or "Threadbear woke it" without one, unless a "Woke up" note already said so), `scheduleId?`, `editOf?: number` (the seq of the message this one replaced, see Editing a message), `sentAs?: string` (the `turnId` `threads.send` returned for a message that waited in the queue and then went into this running turn, as one sent while a cold thread compacts does; `tb send --wait` follows this turn instead) |
| `assistant.text` | `itemId`, `text` (complete markdown for that block), `summary?: true` (the turn's summary, written by the runner from `end_turn`; see "Needs you"), `givesWay?: true` (on a summary, with bullet replies off: see "The summary"), `narration?: true` (Claude sent this as a narration block, whose text reaches the runner only as a short summary of what the agent wrote, not its words: see Transient events), `final?: true` (with one reply, the agent's message after `end_turn`, the turn's reply: see "Needs you", One reply), `part?: number` (queued CLI part index 1, 2, … after an earlier CLI part rolled over with queued messages left). A later `assistant.text` with the same `itemId` replaces the earlier one where it stands |
| `reasoning` | `itemId`, `text` (summary) |
| `tool.call` | `itemId`, `name` (raw tool name), `kind` (`command` \| `read` \| `edit` \| `write` \| `search` \| `web` \| `mcp` \| `task` \| `todo` \| `image` \| `other`; `image` is image generation), `title` (one line, e.g. "npm test" or "Edit src/a.ts"), `input` (object, large strings truncated to 16 KB) |
| `tool.result` | `itemId` (matches the call), `ok`, `text` (truncated to 64 KB), `truncated`, `blobPath?`, `images: ImageRef[]` |

| `edit.diff` | `itemId`, `path`, `hunks: {oldStart, oldLines, newStart, newLines, lines: string[]}[]` (lines start with " ", "-" or "+"); sent after `tool.call` for Edit/MultiEdit/Write when the runner can compute it. One event per file: a tool that changes several files (a Codex patch) has one per path. A later `edit.diff` with the same `itemId` and `path` replaces that file's diff; a new path adds one |
| `approval.requested` | `approvalId`, `itemId?` (absent for a subagent's tools, which have no `tool.call`), `name`, `title`, `input` (a command, and every argument of an MCP tool or a file edit, whole: a call with one longer than 16 KB is refused with no card; other strings cut as in `tool.call`), `options: ("allow" \| "allowAlways" \| "deny")[]`, `reason?` (why it's asking, when Claude's CLI says: Auto's safety check couldn't clear the call, a rule or a hook asks; never the permission mode itself. Clients show it under the title. A call the CLI refuses without a card, such as one Auto's check stops, is a `system.note` saying why, when it gives a reason). A subagent's card (no `itemId`) needs no turn: it can come with no `turnId`, and it outlives the turn it came in ("A subagent's card") |
| `question.requested` | `approvalId`, `itemId?` (absent for a subagent's), `questions: {question, header?, multiSelect, options: {label, description?}[]}[]` |
| `secret.requested` | `approvalId`, `itemId?`, `label`, `reason`, `placeholder?`: an agent's `ask_secret` (Secrets). Answered with `secrets.answer`, never `approvals.respond` |
| `approval.queued` | `approvalId`, `calls: {itemId, name, title, input}[]`: the agent's other tool calls from the same reply that are waiting behind this card and expected to ask too, in order, each with its input as a card would show it. A later one replaces the list (it grows as more calls stream in). A client that doesn't know it shows the card on its own, and each queued call asks with a card of its own later ("Queued calls") |
| `approval.resolved` | `approvalId`, `decision` (`allow` \| `allowAlways` \| `deny` \| `answered` \| `expired`), `message?` |
| `plan.updated` | `entries: {text, status: "pending" \| "in_progress" \| "completed"}[]` |
| `plan.proposed` | `itemId`, `text` (Markdown): a "Plan first" plan waiting for Mike (see "Plan first") |
| `plan.resolved` | `itemId`, `decision` (`go` \| `revise`): it was approved, or sent back for another go |
| `turn.started` | `turnId`, `wokeBy?: {kind, description}[]`. A turn the agent starts by itself (a background task finished) has no `user.message` before it. `wokeBy` is on such a turn when background work finishing started it: each task that had finished since the last turn, `kind` as in `BackgroundTask` (`agent` \| `shell` \| `monitor` \| `other`), its `description` possibly empty. Clients mark the time between that turn and the one before it in the transcript (a "6 min later" divider, Mike 3 Nov). A `user.message` after `turn.started` was sent while the turn ran and went into it |
| `turn.completed` | `turnId`, `outcome` (`completed` \| `interrupted` \| `failed`), `durationMs`, `costUsd?` (Codex turns have none), `usage?` (Claude: `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`; Codex: `{inputTokens, cachedInputTokens, cacheWriteTokens?, outputTokens, reasoningTokens}`), `error?`, `errorKind?` (`usageLimit` \| `contextWindow` \| `auth` \| `network`, when a failed turn's cause is known, so a client can offer the fix without reading `error`), `needs?` (`you` \| `nothing`), `asks?: Ask[]`, `next?: string[]` (with `nothing`: suggested follow-ups), `needsFrom?` (`tool` \| `text`): what a completed turn said it needs from Mike (Needs you), `review?: LabReviewLedger` (on the turn that answered a review by another lab's findings: see that) |
| `asks.ticked` | `asksSeq`, `ticked: number[]` (indexes into that turn's `asks`, the whole set now ticked) and optional `resolved: number[]` (asks retired by the coordinator's task board). Outside any turn. The latest event for an `asksSeq` gives that card's ticks. Resolved indexes stay resolved for that card |
| `system.note` | `text` (e.g. "Resumed session", "Compacted the conversation", "Patch reseed added: action Reseed dev DB."), `wake?: true` on a background task's notification that went into the running turn, which the agent reads at its next step (see "Once a turn, or once a message"), `login?: true` on a note about the thread's login running out: its move to another one, its wait for room, or that wait being called off (Pools, "Moves in the transcript"), `savedMessage?: true` when an early Stop saved a message for the next send. Login and saved-message notes, and the lines for a move to or from Hibernating or the archive, go up to the backend (Sync, "Messages"), so other Macs, the phone and the website show them |
| `error` | `message` |
| `action.run` | `actionId`, `patch`, `title`, `command`, `ok`, `exitCode?`, `text` (what it printed, truncated to 64 KB), `truncated`, `durationMs`, `trigger?` (`"turn.end"` when a hook ran it, `"worktree.setup"` for a new worktree's `setup`, `"worktree.teardown"` for an archived thread's worktree `teardown` (see Worktrees); absent for a chip or `tb run`). A command that `actions.run` or a hook ran; outside any turn unless one was running, in which case it carries that `turnId` |
| `thread.rewound` | `fromSeq`, `toSeq`, `files: { undone: string[], failed: { path, reason }[], how: "checkpoint" \| "diffs" \| "none" }`. Mike edited the message at `fromSeq` (see Editing a message): every event from `fromSeq` to `toSeq` (inclusive, always this event's `seq` - 1) is gone from the conversation, and clients hide them. Outside any turn. The edited message comes next, as a `user.message` with `editOf: fromSeq` |

Tool-result images (including base64, data URLs, generated-image fallbacks and
file-backed results) are capped at 100 MiB before copying or decoding and written
in bounded chunks through private temporary files. Each CLI turn accepts at most 64 such images or
256 MiB, including repeated results. A thread's media folder may hold at most
1,024 flat image files or 1 GiB when accepting these images; this storage check survives
restarts without following links. Review subfolders have their own allowance. File conversions
use a private captured input, bounded output dimensions and the same byte quota,
counting a conversion once. An image refused by these limits is omitted with the normal save-error
text; other tool output is kept.

Transient events are only sent to subscribers, never persisted, and carry
`seq` of the last persisted event (they don't consume a number):

| type | fields |
|---|---|
| `assistant.text.delta` | `itemId`, `text` (append) |
| `reasoning.delta` | `itemId`, `text` (append) |
| `tool.output.delta` | `itemId`, `text` (append, for long-running commands if available) |

When an item completes, its persisted event (`assistant.text`, `reasoning`)
replaces whatever the deltas built up. That can be of the other kind: Claude
at times sends its reply as a thinking block signed as narration, which
streams as `reasoning.delta` and lands as `assistant.text` with the same
`itemId` (it is the reply, so end_turn counts it). A client lets the text
take the streaming reasoning row's place.

A narration block's text is not the agent's words: with summarised
thinking (the only kind the CLI offers besides none) the API sends a
short summary of it, in the agent's voice ("I've laid out the full
setup steps..."), and the words themselves never reach the runner. On
29 Oct 2026 a numbered walkthrough reached Mike as one such paragraph,
twice (thread 66935d23). So that event carries `narration: true`. An
`end_turn` with no summary bullets, whose turn replied only in
narration, is accepted, and its
result asks for the whole message again as ordinary text with nothing
after it (a text block followed by no tool call is never narration);
the runner keeps that text, which it otherwise drops after an accepted
`end_turn`, and persists it with the summary's `itemId` and no
`narration`, so it takes the summary's place. Readers that list a
thread's messages keep only the last `assistant.text` of an `itemId`.
The Convex mirror keys messages by seq, so the phone and website show
the summary and then the reply.
