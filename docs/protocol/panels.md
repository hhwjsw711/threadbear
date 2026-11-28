# Runner protocol: Highlights, panels and connectors

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

## Highlights

The Mac app's right-hand rail (like VS Code's secondary side bar) has a
button per panel, Patches at its foot, and Highlights at its head: what a
thread has made, shared and pinned for Mike, so it doesn't scroll away
with the transcript.

```ts
type HighlightKind = "file" | "link" | "pr" | "commit"
type Highlight = {
  id: string            // "<kind>:<path, url or sha>"
  kind: HighlightKind
  title: string         // the file's name, a link's text (else host and
                        // path), "owner/repo#12", a commit's first line
  url?: string          // link, pr
  path?: string         // file: absolute
  how: "pinned" | "written" | "opened" | "mentioned" | "created" | "committed"
  note?: string         // a pin's reason, in the agent's words
  show?: true           // no longer sent: an older runner's pin asked to be shown
  sha?: string          // commit: short sha
  branch?: string       // commit
  pushed?: true         // commit: a later git push in the thread sent its branch
  watched?: true        // pr: its auto-fix wand is on
  seq: number           // the event it was first seen in (a pin: lastSeq then)
  lastSeq: number       // the latest event that mentioned it
  at: string            // when it was first seen
}
type ThreadHighlights = {
  highlights: Highlight[] // pins first, then the rest newest first: at
                        // most 80 (pins are always kept)
  edited: string[]      // files the thread edited, absolute, newest first,
                        // at most 200
  brief?: { text: string; at: string } // the librarian's line on where
                        // the thread is up to (see Projects)
  runs?: CiRun[]        // GitHub Actions runs its pushes, dispatches or re-runs set off
}
```

The runner finds them in the thread's events, with no model, the first
time a client asks and then from where it got to:

- **Files written**: a `Write` (or Codex file change) of something Mike
  would look at rather than code: `.md`, `.html`, `.pdf`, images, video,
  `.csv`, `.txt`. Code goes in `edited`.
- **Opened**: each file or URL a command passed to `open` (`open -a App`
  skips the app). A relative path is taken from the thread's folder and
  must exist.
- **Mentioned**: links in an `assistant.text` (Markdown links and bare
  URLs) and absolute or `~/` paths of files that exist (in a link or in
  backticks). A GitHub pull request's URL is a `pr`. A URL over 2,000
  characters isn't one.
- **PRs created**: pull request URLs in the output of a command that ran
  `gh pr create`.
- **Commits**: the `[branch sha] message` line `git commit` prints. A
  later `git push` that prints `a..b branch -> branch` (or `[new branch]`)
  marks that branch's commits `pushed`.

**Pins.** An agent pins with the `pin` tool: `{ path? | url?, title?,
note?, show? }` (a path relative to its folder is fine; it must exist;
a url is at most 2,000 characters).
A pin of something already found is the same item, now pinned. `show`
asks the app to open it in the pane, so an agent shows Mike a mockup
there instead of running `open`. It's a `panelRequest` (see Showing
panels) with `panel: "highlights"` and `highlight` naming the pin, so it
opens when Mike is looking at the thread, now or later, and every pin
with `show` asks again: the same page pinned after an edit comes up
again. (It was a `show` flag on the item until 8 Nov 2026, which the app
only acted on the first time it saw it, and never for a thread it hadn't
fetched yet.) The app opens the pin as a file panel beside Highlights, fetching
the thread's highlights first if it hasn't got that one, then calls
`threads.panelShown`; one that's gone opens Highlights. The tool waits
up to 2 seconds for that, as `show_panel` does, and says which. Only the pane: a file shown this
way never opens in its app (a project file included), and a link only
opens by itself if it's a web page, where a click on it would go. `unpin { id }` takes one off
again. The tools' descriptions say when to use them.

The Windows desktop app refuses network shares and device paths before
probing a local file, including a hover card or file search. Its resolver
checks each link or junction without following it, refuses mapped network
drives, and holds checked names against replacement while
resolving. It normalizes dot segments before following links and refuses
ambiguous names ending in a dot or space. Local links to local files keep
working. Windows reads its local file previews and folder listings under
this guard, without asking the runner to resolve the raw path again; unsafe
child links remain visible by name without probing their targets. Local
pictures are decoded from a guarded byte snapshot in the background. Reads,
directory enumeration and editor saves reuse checked handles; ordinary
writers can keep a log or document open while it is previewed.
Folder thumbnails use guarded bytes too, and omit rows whose size couldn't
be checked. A Windows drag also checks the volume and file ID, so a hard
link swapped in at the same path isn't the file that was grabbed.

**The brief.** The librarian's look (see Projects) also answers with a
line or two on where the thread itself is up to, kept on the thread and
sent as `brief`. No extra model call: it's the same look.

### Worktrees

A repo can ask for each new thread to get a git worktree of its own
(docs/thread-worktrees.md has the why and the details). A patch file's
default export says so, beside its actions:

```ts
export default {
  worktree: {
    setup: "./scripts/setup.sh",    // run in the new worktree before the first turn; optional
                                    // (one script and plain words: see "Trusting a folder's patches")
    check: "./check.sh --quick",    // run by `tb land` before main moves; optional
    teardown: "./scripts/teardown.sh", // run in the worktree's root when the thread is archived
                                    // or deleted, before the cleanup; optional (as setup)
  },
}
```

The first patch in the thread's own folder chain with a `worktree` wins;
`~/.threadbear/patches/` and project folders never count. The repo is the
git toplevel of the folder holding `.threadbear/`, and its main checkout
is the one with `main` checked out. A malformed `worktree` (not an object,
or a `setup`, `check` or `teardown` that isn't a command) is the file's `error`.

A new thread in such a repo (from `threads.create`, `create_thread` or a
schedule, unless `worktree: false`) gets, before its first turn starts:
`git worktree add -b thread/<id8> <parent>/<repo>-threads/<id8> main` from
the main checkout (`<id8>` is the thread id's first 8 characters), a `cwd`
in the same subfolder of it, `setup` run in its root (an `action.run` with
`trigger: "worktree.setup"`, under the first turn; a failure is shown and
the turn goes on), and a few lines in the agent's appended system prompt
saying where it is and that `tb land` puts it on main. If the worktree
can't be made (a leftover folder or branch of that name, no checkout on
`main`), a `system.note` says why and the thread starts in the folder
asked for. The summary carries `worktree` from then on.

`tb land` rebases first (refusing straight away on a conflict), then takes
an OS lock at `threadbear-land.lock` in the repo's common git directory,
rebases again on the main it finds, and holds the lock through the check
and fast-forward. The CLI reads the patch's check after rebasing.
Other landings of that repo wait, even from
other CLI processes; exiting releases it. Those waiting are queued in
`threadbear-land-queue/` there, and the next holder checks them all
together with its own and lands them at once (docs/thread-worktrees.md,
"Landing together"). A failed grouped check prints its exit code and the
last 40 lines of output (up to 8,000 characters) before retrying smaller
groups; it only refuses an individual landing if that landing's own check
fails. A patch load error,
or a check that changes the branch or leaves changed or untracked files,
stops the landing.
The Land command action has an hour for its wait and check, rather than
the usual ten-minute command limit. The fast-forward names the checked
commit, so it cannot pick up a later, unchecked branch tip.

Hand-merges from borrowed worktrees also take this same lock before
rebasing and checking, and keep it through the fast-forward. A plain git
merge does not take the lock; it can invalidate a queued landing's check.
Rebased combinations always need validation again, even if the changed
files do not overlap. See docs/thread-worktrees.md for the command.

`tb land`, in the worktree, refuses with uncommitted changes, rebases on
main (a conflict aborts and names the files), runs `check`, then
`git merge --ff-only` in the main checkout (refused, and nothing changed,
if main's own uncommitted changes are in the way) and prints what landed.
It pushes only in a repo listed in runner.json's `pushAfterLanding`
(docs/thread-worktrees.md, "Syncing main with GitHub"). `--dry-run` stops
before main moves.

When the thread is archived or deleted, `teardown` runs first in the
worktree's root, whether or not the branch landed (an `action.run` with
`trigger: "worktree.teardown"`, outside any turn; for a deleted thread only
a notice if it didn't run or failed). It has the action timeout, past
which it's ended (SIGKILL if SIGTERM doesn't do it), and a failure is
shown but doesn't stop the cleanup. It runs once per archive, and only
while the folder is still the thread's own worktree on its branch, not a
link to somewhere else. Then a
worktree whose branch is on main
(or has nothing of its own) is removed with its branch; otherwise both stay,
with a `system.note` saying how to land or drop them. A thread whose
worktree was removed gets a fresh one with its next message, made from main
as a new thread's is (same branch name, the patch's setup run), with a note;
only if none can be made (no patch asks for one, or making it fails, which
is said) does it carry on in the main checkout. One whose
worktree stayed carries on in it, and its next turn says (to Mike and the
agent) that the teardown ran, so what setup made may be gone.

## Showing panels

An agent puts one of the app's panels in front of Mike with the
`show_panel` tool, `{ panel, where? }`, when what he should look at is a
panel rather than a file or a link (those are `pin` with `show`). It opens
the panel, or brings it to the front wherever Mike put it. It never moves
or resizes a panel that's open: Mike's layout is his.

`panel` is `highlights`, `browser` (`threadbear.browser`) or `patches` (the thread's own; Patches only when
it has patches), one of the thread's `panels` by id or title (any case),
or `usage`, `updates` or `connectors` (the app's Usage, Updates and
Connectors panels). `reload: true` loads a
web panel's page afresh as it's shown, for an agent that has just changed
it (a patch's page served from its folder, say). `where`
says where a closed one opens: `tab` (a tab beside the thread, which
closes again when the main panel moves on, as a review's does), `left`,
`right`, `top` or `bottom` (along that side of the window), or `window`
(a window of its own). Without it, a closed panel opens where the app
would put it: a thread's panels beside its other open ones, else down
the right; Usage, Updates and Connectors under the threads list. An open panel
ignores `where`.

```ts
type PanelRequest = {
  id: string            // the request's own id
  panel: string         // "highlights", "patches", "usage", "updates", "connectors", or one of the thread's panels' ids
  title: string         // the panel's name: "Highlights", "Convex"
  where?: "tab" | "left" | "right" | "top" | "bottom" | "window"
  highlight?: string    // pin with show: the pin to open (panel is "highlights")
  reload?: true         // show_panel's reload: a url panel's page is loaded
                        // afresh (from its own address) as it's shown
  at: string            // when the agent asked
}
```

The runner checks the name (an unknown one is the tool's error, listing
what the thread has), keeps the request on the thread as `panelRequest`,
replacing an older one, and sends the summary. The app shows it once Mike
is looking at the thread: the app is in front and the thread is the one
in the main panel (a thread open in a panel of its own doesn't count, as
the side panels follow the main one). That's straight away if he already
is, or else when he next opens the thread or comes back to the app. Then
the app calls `threads.panelShown`, which clears it. A message from Mike
(typed, or from his phone; not a runner, schedule or agent message)
clears it too: he has seen the reply it went with. The tool waits up to 2
seconds for `threads.panelShown`, so its answer says whether Mike has the
panel in front of him now or will when he next looks.

A request naming a pin waits for a successful highlights answer requested
for that pin before a missing pin falls back to Highlights. Other pane or
thread updates and failed fetches leave the request waiting; later fetches
from a busy turn do not hold back the answer it needed.
Transient fetch errors are retried while Mike is looking at that thread.

During a handover the request stays with the thread on the runner that
has it, and the primary passes `threads.panelShown` on as it does any
thread's request.

`tb show-panel <threadId> <panel> --json` exposes this to local tools through
the authenticated `threads.showPanel` RPC. The primary checks the Mac app's
connection before forwarding to a draining runner. An unavailable app leaves
no request. An accepted request can be pending without changing the selected
thread, and its `shown` field says whether the app already acknowledged it.
The Mac app advertises `browserPanel: true` in `hello`, as does the GPUI app
on a Mac; a Browser request
returns unavailable for older apps that cannot promise this handoff path.

BrowserBear uses this only for `handoff` of a page in the agents' browser, which
has no in-page pill: the page's window comes to the front and the Browser panel
shows it marked Your turn with Done, including when the panel wasn't previously
open. The Mac app also opens Browser when its selected thread has a tab marked
Your turn. That waiting tab survives the one-shot request being cleared by a
message, so a later return to the thread still shows the handoff.

### The Browser panel

The Mac apps' Browser panel (Swift's `AgentBrowserPanel.swift`, GPUI's
`desktop/gpui/src/agent_browser.rs`) uses BrowserBear's existing private Unix socket
(`~/Library/Application Support/BrowserBear/browserbear.sock`). It lists the
pages a thread is using, each with a still and a Show window button. It doesn't
stream pages or send input to them (since 8 Nov 2026): the page is used in its
own real window, in the agents' browser (Helium) or in one of the user's Chrome
profiles.

- `panelState` reports connected Chrome profiles and the pages in them that
  ordinary BrowserBear commands associated with threads. Pages in the agents'
  browser come from `agent/tabs.json` in BrowserBear's folder, which also names
  the browser (`browser`).
- `{cmd:"panelStill",thread,args:{tab,profile,width}}` returns
  `{data,at}`: a small base64 JPEG of the page, or `data: null` when there's
  none just now. BrowserBear refreshes it at most every 3 s in the agents'
  browser and every 20 s in a Chrome profile (its debugger keeps Chrome's
  "started debugging" bar up), and never takes one of a page handed to the user
  in their own Chrome.
- `{cmd:"panelShow",thread,args:{tab,profile}}` brings the page's real window
  to the front.
- `markDone {tab}` is the Done button for a page waiting on `handoff --wait`.

BrowserBear checks that the thread owns the page in that exact profile (the agents'
browser is `agent-chrome`), as the same tab number can be in two. Replies use
`{id,ok,result|error}`. No cookies, passwords, OAuth tokens or browser profile
files are read or imported, and stills stay in memory on this Mac. Both sides
ignore fields they don't know.

## Pull requests

A github.com PR link clicked in a reply or in Highlights opens as a dock
panel beside Highlights (panel id `threadbear.pr:<canonical url>`) rather
than in the browser. Un-moved PR panels follow their thread (closing on
switch and returning with the thread); dragging one to another group or a
window of its own keeps it open across threads. The runner reads it with
the gh CLI (`runner/src/github-pr.ts`), signed in as whoever `gh auth` is
on this Mac: `github.pr` runs `gh pr view`, `gh pr diff` and `gh repo view`
with `-R owner/repo` from the temp folder, never inside a checkout, so no
repo's git config or hooks run.

```ts
type PrView = {
  url, owner, repo: string; number: number; title, author: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  head, base: string; additions, deletions, changedFiles: number;
  body: string;            // markdown, as written
  createdAt: string; mergedAt?: string; closedAt?: string; mergedBy?: string;
  review: '' | 'approved' | 'changes' | 'required';
  mergeable: 'yes' | 'conflicts' | 'unknown';
  canMerge: boolean;       // gh's account has write access and it's open
  mergeMethods: ('rebase' | 'squash' | 'merge')[];   // what the repo allows
  checks: { name: string; state: 'passed' | 'failed' | 'running' | 'pending' | 'skipped'; url?: string; seconds?: number }[];  // failed first
  activity: { kind: 'comment' | 'review'; author, body, at: string; review?: 'approved' | 'changes' | 'commented' }[];  // oldest first
  files: { path: string; from?: string; additions, deletions: number; hunks: Hunk[]; binary?: boolean }[];
  filesError?: string;     // the diff couldn't be read
  filesCut?: number;       // lines left out past 20,000
  filesLater?: boolean;    // asked for with files: false
};
```

A big PR's diff is the slowest read (two seconds for 600 KB), so the app
asks `github.pr` with `files: false` and `github.prFiles` together, and
shows the PR while its files are on their way. A runner older than that
ignores `files` and answers `github.prFiles` with `-32601`, and the app
keeps the files the first answer brought.

`github.prStates` gives the coloured state of each PR link in a transcript,
one `gh pr list` per repo (its latest 300), kept a minute; `github.prAct`
forgets that repo's states so the icons catch up. None of these is in a
thread key's reads (rpc-gate.ts): a thread can't merge or comment through
the app's connection. Another runner's thread still opens its PRs through
this Mac's gh.

Highlights lists a thread's PRs (its `pr` highlights that aren't pinned) under
Pull requests, above Links, which no longer lists them. While that shows, the
app asks `github.prStatus` for them: one `gh api graphql` call for up to 40 PRs,
each answer kept 30 seconds (`PrStatus`: `title`, `state`, `ci`, `review`,
`mergeable`, `unresolved`, `updatedAt`). Each open PR row has an auto-fix wand
(`prWatch.set`, `prWatch.list`, kept in `pr-watch.json`). While any PR is
watched, the runner checks GitHub every minute and sends the thread a message
for new problems (conflict, failing CI, unresolved review threads, changes
requested, or new non-bot reviews/comments), asks whether to merge once
approved, and snoozes for a day while all watched PRs wait for review.

## Connectors

Mike's agents get MCP services from his Connectors gateway on Bruce
(~/dev/me/connectors) and from claude.ai's connectors on each login.
Either can need signing in again. The runner watches the gateway so the
app can show what's signed in, and turns a sign-in error in a thread into
an ask (below).

**Where the gateway is.** runner.json's `connectors.url` (any URL on it;
the base is used), else the `connectors` MCP server's `url` in the main
login's `~/.claude.json` (only that field is read). `connectors.url: ""`
or `connectors.enabled: false` turns it off, as does
`THREADBEAR_CONNECTORS_URL=off` (tests); `THREADBEAR_CONNECTORS_URL`
set to a URL wins over both. Its calls carry the gateway's token, so the
URL must be `https:`, or plain `http:` only to this machine (`localhost`,
`127.0.0.0/8`, `[::1]`), with no name or password in it
(`runner/src/secure-url.ts`). One that isn't is not used, and doesn't
fall back on the next place: the gateway stays off, `connectors.status`
says why (`error` with state `off`) and so does the log. Every request to
it (`/health` too) refuses redirects, so a 307 can't pass the call on.

**Status.** The runner asks the gateway's open `GET <base>/health` every
3 minutes, and when the app passes `refresh` to `connectors.status`
(the panel opening, or its refresh button). One ask at a time, 5
seconds at most. The app never calls the gateway itself.

```ts
type ConnectorsStatus = {
  // off: no gateway set up. checking: no answer yet. unreachable: the
  // last ask failed, and error says how in a few words.
  state: "ok" | "unreachable" | "off" | "checking"
  url?: string          // the gateway's base, https://host:port
  checkedAt?: string    // when the last ask finished
  error?: string
  version?: string      // the gateway's, from /health
  release?: string
  services: ConnectorService[]   // empty unless ok
}

type ConnectorService = {
  id: string            // "notion"
  title: string         // "Notion"; from the id when the gateway sends none
  // unknown: a state word the runner doesn't know (message says more).
  state: "connected" | "signed_out" | "connecting" | "error" | "disabled" | "unknown"
  message?: string
  connectUrl?: string   // where Mike signs it in; set on anything not connected or disabled
}
```

`/health` is read leniently: `upstreams` may be a map of id to state
word (the first gateway: `ready`, `needs_sign_in`, `idle`, `connecting`,
`error`, `disabled`) or a list of `{ id, title?, state, message?,
connectUrl? }`, and unknown fields are ignored. A service with no
`connectUrl` of its own gets `<base>/admin/connect/<id>`. A relative one
is made absolute against the base; anything but http(s) is dropped.

The app's Connectors panel lists the services with their state and a
Connect button (Reconnect for one in `error`) that opens `connectUrl` in
the browser. Its icon in the activity bar gets the accent dot while a
service is `signed_out` (only Mike can fix that), and a grey dot while the
gateway is unreachable or a service is connecting or in error (those
usually sort themselves out).

**Sign-in errors in a thread.** A sign-in problem comes from where a tool
result came from and whether the call failed, never from what the result
says: what a connector reads (an email, a Notion page) is anyone's words,
and an email saying "Gmail needs signing in again" made an ask until 5
Nov. So (`connectors.ts`, `signInSignal`):

- claude.ai's: a failed call to one of that server's own tools
  (`mcp__claude_ai_Gmail__*`) whose result starts with the CLI's auth
  error, `MCP server "claude.ai Gmail" needs you to sign in again`
  (optionally after `Error:`). The service is the name without
  `claude.ai`; the page is `https://claude.ai/settings/connectors`,
  signed in as the thread's login. A result that worked never counts.
- the gateway's: a call to a signed-out service's stub tool
  `mcp__connectors__<prefix>__sign_in`, or a failed call to any of a
  service's tools (`mcp__connectors__<prefix>__*`, not the gateway's own
  `connectors__*`). That only names candidates: the prefix, and the id in
  any `/admin/connect/<id>` link in the result (a prefix can differ from
  its id, `cf` for `cloudflare`). The runner then asks the gateway's
  `/health` afresh, and only a candidate it lists as `signed_out` is a
  problem, with `/health`'s title for it and its connect page. No gateway
  set up, or no answer from `/health`: no problem, and the agent's own
  reply is all Mike sees.

When the thread's agent calls `end_turn` and the turn so far has a
sign-in problem that no ask covers (an ask covers it when one of its
links is the page, or its action or why names the service), `end_turn`
is refused once that turn, with an error result that starts `Not ended
yet: this turn ran into`, names each service and its page, and asks for
an ask with that page as a link if the work needs it. Called again, it's
taken as it is. Nothing new reaches the app: the ask is an ordinary one.
