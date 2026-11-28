# Runner protocol: Types

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

## Types

```ts
// cursor, opencode, grok and antigravity (Gemini on a Google plan): ACP
// agents, where their CLIs are installed and logged in (see "ACP agents")
type Provider = "claude" | "codex" | "cursor" | "opencode" | "grok" | "antigravity"

// What a provider is called and can do, from `hello`. A client asks this
// rather than comparing provider names, so a provider it has never heard of
// still gets the right menus.
type ProviderInfo = {
  id: Provider
  name: string          // "Claude": in notes and menus
  cliName: string       // "Claude Code": the program, in notes about its versions
  loginCommand: string  // run in a Terminal to sign a login in ("claude auth login")
  effort: "claude" | "codex" | "none" // which effort levels it offers: Claude's,
                        // those plus Codex's ultra, or none of Threadbear's own
                        // (Grok: "codex"; Antigravity and OpenCode: "claude",
                        // each model's effortLevels narrowing it)
  autoMode: "classifier" | "asks"     // Auto: a classifier judges each action, or
                        // it behaves like Ask (Codex)
  rewind: boolean       // can go back to an earlier message
  smallJobs: boolean    // can run small jobs (titles, summaries)
  usageReadings: boolean // reports how much room a login has
}

type Account = {
  id: string            // "claude-main", "claude-1", "codex-main", "codex-1", ...
  provider: Provider
  title: string         // Claude: the email when known, else the id. Codex:
                        // "Codex · <email>", so an app that only reads title
                        // can tell it from a Claude login with the same address
  configDir: string
  defaultModel?: string // full id of the model a thread with no model runs on
                        // ("claude-fable-5-1"): the account's own setting
                        // (Codex: config.toml's model, else the model list's
                        // default), corrected by the first turn the runner
                        // sees. Absent until the runner knows
  models?: ModelChoice[] // what the account's CLI offers, in its own order,
                        // once the runner has asked it (a few seconds after
                        // it starts). Codex: its model list without hidden models
  defaultEffort?: EffortLevel // the account's own level (Codex: config.toml's
                        // model_reasoning_effort). Absent: each model's own
  email?: string        // the bare address, when known
  plan?: string         // "Max", "Team", "Pro Lite"
  note?: string         // Mike's own note for the account ("Convex work only")
  usage?: AccountUsage  // absent when nothing is known (and from older runners)
  signedOut?: boolean   // Claude: no turn can run on it until someone signs it
                        // in again (see "Signed out" under Pools). Pools skip it
  loginEndsAt?: string  // Claude: when this sign-in ends and can't be renewed
                        // (28 days after signing in, from Claude Code 2.1.325).
                        // Clients warn a few days ahead
  yearToken?: { madeAt?: string } // Claude: runs on a year-long token
                        // Mike made for it, not its 28-day sign-in ("Year-long
                        // tokens", below). madeAt is when; loginEndsAt is a
                        // year on. The token itself is never sent
  planEnded?: boolean   // Claude: its paid plan has lapsed. The CLI's cached
                        // claude.ai profile (oauthAccount in the login's
                        // .claude.json, fetched again at most daily while the
                        // CLI runs on it) says organizationType claude_free,
                        // or a Pro or Max plan with billingType none (a lapsed
                        // Max still cached as claude_max). The free plan has
                        // no Claude Code. Its plan and usage are
                        // left out (a stale reset would promise room that
                        // isn't coming). Pools and the default account skip
                        // it; clients say "Plan ended", and offer no sign-in
                        // or reset for it
  resetHint?: ResetHint // a usage reset worth using now (Pools, "Telling Mike
                        // about resets"). Worked out by the runner alone, so
                        // every client draws the same; absent when there's
                        // nothing to say
}

type ResetHint = {
  why: "out" | "expiring" // out: blocked, or under 1% in its 5-hour or weekly
                        // window. expiring: the soonest reset expires within 3
                        // days and the week is under 70% left. An unknown why
                        // is drawn as out
  available: number     // resets left, at least 1
  nextExpiresAt?: string // when the soonest expires
}

// "ultra" is Codex's multi-agent level. Claude never offers it.
type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra"

type ModelChoice = {
  id: string            // what to send as `model` ("opus", "claude-fable-5-1[1m]", "gpt-6-luna")
  model: string         // the full id it runs as ("claude-opus-5-5")
  title: string         // "Opus 5.5"
  description?: string
  effortLevels?: EffortLevel[] // absent when the model takes no effort level
  defaultEffort?: EffortLevel  // the model's own level, when the CLI says (Codex)
}

type UsageWindow = {
  kind: "five_hour" | "weekly" | "weekly_model" | "daily" | "monthly" | "allowance" | "other"
  title: string         // "5-hour", "Weekly", "Weekly Fable", "$250 allowance"
  remainingPercent: number // 0 to 100, may be fractional
  resetsAt?: string
  detail?: string       // "$132.79 left"
}

type AccountUsage = {
  windows: UsageWindow[]
  readAt: string        // when the newest reading in it was taken
  source: "tokenStats" | "live" // where the newest reading came from: Token
                        // Stats' limits.json, or the account's own turns
  stale?: boolean       // Token Stats hasn't written for 15 minutes and
                        // there's no live reading since
  blocked?: boolean     // the provider says this login is at its limit
  notice?: string       // Token Stats' own note ("64,390 credits · 2 limit resets available")
  resets?: { available: number, nextExpiresAt?: string, readAt?: string }
                        // Codex: the usage resets it has left, from the newest
                        // read of them on any runner (Pools, "Usage resets");
                        // readAt is when that read was. Left out once the
                        // soonest has expired
}

type CliStatus = {
  provider: Provider
  path: string          // the binary new sessions start
  managedBy: "threadbear" | "cli" | "none" // Codex: Threadbear's own copies;
                        // Claude: its own installer; "none": codexPath set by
                        // hand, never updated
  installedVersion?: string // what new sessions start on
  latestVersion?: string
  canUpdateNow?: boolean // an ACP agent: no version feed, so the row offers an
                        // update on demand (`clis.update`) and never updates by itself
  status: "current" | "behind" | "held" | "unknown" | "missing"
  policy: "auto" | "notify" | "off"
  inUse: { version: string, threadIds: string[] }[] // versions live sessions run
  previousVersion?: string  // Codex: the kept version "Go back" returns to
  checkedAt?: string
  hold?: { version: string, reason: string, missing?: string[],
          threadId?: string, investigating?: boolean } // why an
                        // update wasn't installed by itself ("the app-server
                        // protocol changed", with what it lost). A protocol
                        // hold starts a thread that looks into it (threadId;
                        // investigating while it's open), and is checked
                        // again once per runner start, so the landing that
                        // fixes it installs the version by itself
  update?: {            // the latest update, while it runs and after
    state: "waiting" | "running" | "succeeded" | "unchanged" | "failed"
    targetVersion?: string
    waitingFor?: string[]
    finishedAt?: string
    message?: string
  }
}

// A named, ordered list of logins (see Pools).
type Pool = {
  id: string            // "claude", "codex", "convex", or a slug Mike made
  title: string         // "Claude"
  accountIds: string[]  // in order; may mix providers
  folders?: string[]    // ~ allowed; a new thread under one starts on this pool
  icon?: string         // an SF Symbol name Mike picked ("leaf"); absent, the app picks one
  builtIn?: boolean     // from the code default, not runner.json
}

type ThreadStatus =
  | "idle"              // no turn running (CLI may or may not be live)
  | "starting"          // CLI spawning or resuming
  | "running"           // a turn is in progress
  | "waiting"           // blocked on an approval or a question
  | "error"             // last turn failed; can still send
  | "stopped"           // runner restarted mid-turn

type ThreadSummary = {
  id: string
  title: string
  cwd: string
  accountId: string     // the login it runs on now (a pool thread's can change; see Pools)
  poolId?: string       // the pool that picks its login. Absent: pinned to accountId
  waitingForRoom?: { until: string, accountId?: string } // every login in its
                        // pool is out of room; it carries on by itself at
                        // `until`. accountId: the login it's waiting on
  carryOnAtReset?: false // Mike turned off carrying on by itself after a
                        // limit (Pools, "Waiting"). Absent: on
  waitingForNetwork?: { since: string } // its last turn couldn't reach the
                        // API; it carries on by itself once the runner
                        // reaches it again (Pools, "A turn that lost the
                        // network"). since: when the line first went
  provider: Provider    // always the account's provider
  model?: string        // undefined means the account's default
  effort?: EffortLevel  // undefined means the model's own level
  modelInUse?: string   // full id the CLI ran the last turn on, once one has run
  effortInUse?: EffortLevel // the level the CLI reported for the last turn
  permissionMode: "full" | "ask" | "auto" | "plan"  // "plan": Plan first
  status: ThreadStatus
  live: boolean         // a CLI process is attached right now
  needsYou: boolean     // waiting, or a turn finished after lastSeenSeq
                        // that didn't end with needs "nothing", with no
                        // sub-agents still working, nor a shell job its
                        // asks wait for (Needs you)
  needs?: "you" | "nothing" // what the last completed turn said; absent
                        // when it said neither (see Needs you)
  asks?: OpenAsk[]      // that turn's asks, when needs is "you"
  asksSeq?: number      // seq of the turn.completed they came with
  asksAfterJobs?: true  // those asks wait until the thread's own shell jobs end (Needs you)
  createdAt: string
  updatedAt: string
  lastActivityAt: string
  snoozedUntil?: string
  snoozedUntilRestart?: true // hibernating until the runner next starts;
                        // snoozedUntil is then 9999-12-31T00:00:00.000Z
  snoozedUntilRelease?: true // with snoozedUntilRestart: only a start on
                        // another release than the one it went to sleep on
  wakeWhen?: { said: string, topic?: string, pending?: true, agent?: true }
                        // hibernated in Mike's words (Hibernate in words);
                        // only while snoozedUntil is set. `agent`: its own
                        // agent set it (end_turn's snooze); with an
                        // "unlanded" loose end it's waiting to land, and
                        // the sidebar puts it under Running
  waitingOn?: { threadId, title, until?, done?: true }[] // hibernating until these
                        // threads finish (end_turn's waitFor); only
                        // while snoozedUntil is set
  awaitingAppRestart?: true // hibernating until the Mac app restarts onto
                        // what this thread landed (wait_for_app_restart);
                        // only while snoozedUntil is set. With an unfinished
                        // waitingOn, the sidebar puts it under Running.
  awaitingRuns?: true   // hibernating until GitHub workflow runs finish
                        // (end_turn's waitForRuns); only while snoozedUntil
                        // is set. Under Running as "Until its GitHub workflows finish".
  awaitingApp?: { commit?, short? } // waiting to hear the app restarted onto
                        // a build with this commit (wait_for_app_restart),
                        // hibernating or not, and under a day old; {} when
                        // there's no commit to look for. The Updates panel
                        // lists these threads with whether the running,
                        // ready or building app has the commit.
  startedBy?: { kind, label, icon?, threadId?, threadTitle?, why? } // who
                        // started it when Mike didn't (Who started a thread)
  detached?: true       // a thread another thread started that doesn't
                        // nest under it in the sidebar (Nested threads)
  asked?: string        // Mike's last message to it, one line, <= 140 chars
                        // (What Mike last asked)
  keywords?: string     // the librarian's search words, lowercase and
                        // space-separated, <= 200 chars (Search)
  woke?: { at: string, since?: string } // came back from hibernating by
                        // itself (its time, a restart, a topic) at `at`,
                        // put away at `since` when known; only until Mike
                        // looks (threads.markSeen) or sends to it. The wake
                        // also adds a system.note ("Woke up after
                        // hibernating for a day.") Mirrored to the phone's
                        // row from backend API 13
  archivedAt?: string
  archivedBy?: "mike" | "agent" | "threadbear" // who archived it; only
                        // while archivedAt is set (Who archived a thread)
  archiveVerdict?: "worked" | "didntWork" | "notNeeded" | "didntNeedToSee" | "gladISaw" | "notSure" // how it went, Mike's
                        // pick from the done card's Archive menu
  quietlyArchived?: { at: string, why: string } // archived by the quiet
                        // inbox for Mike's own threads (experiment
                        // quietInboxMine): when, and the strong model's one
                        // line on why he didn't need to see it. Only while
                        // archivedAt is set and archivedBy is "threadbear"
                        // (threads.md, "Inbox guess")
  coordinatorProjectId?: string // Optional project coordinator. Nonempty project id;
                        // shown under Coordinators before Starred, even asleep.
                        // Archived still wins. Missing or malformed: ordinary thread.
                        // Mirrored in thread/index rows from backend API 102.
                        // No registry on another Mac is required to show its row.
                        // Reading leaves open questions waiting; replying uses
                        // the ordinary message and card-answer paths.
  starredAt?: string    // Mike starred it, at this time: it stays in the
                        // Starred section above the Inbox, hibernating or
                        // not, oldest star first. Kept while archived, when
                        // it's under Archived, so bringing it back stars it
  onOldRunner?: true    // finishing a turn on the runner that handed over
                        // (Handovers); moves across when the turn ends
  preview: string       // last assistant text, one line, <= 140 chars
  lastSeq: number       // seq of the newest persisted event
  lastSeenSeq: number
  nativeSessionId?: string
  contextTokens?: number
  contextWindow?: number // the model's context window, when the CLI reports it
                        // (Claude: its result's modelUsage, for the session's model)
  costUsd?: number      // total for the thread so far, if known (Codex reports none)
  panels?: Panel[]      // from the folder's patches (see Patches); absent when there are none
  actions?: Action[]    // likewise
  hooks?: Hook[]        // likewise
  patches?: PatchInfo[] // the patches that apply to the folder; absent when there are none
  background?: BackgroundTask[] // what the live CLI is still running in
                        // the background: sub-agents and shell jobs
                        // started with run_in_background, Monitor and the
                        // like, and ones just finished whose result the
                        // agent hasn't read yet. Absent when there's none.
                        // Set during a turn too; between turns it's the
                        // sign the thread is still being worked on
  subagents?: Subagent[] // the sub-agents the agent has started, foreground
                        // and background: the newest 20, oldest first.
                        // Absent when it has started none
  projects?: ThreadProject[] // the projects the thread is in (see Projects),
                        // oldest first. Absent when it's in none
  highlightsAt?: string // when its highlights last changed other than by a
                        // new event: a pin, a removal, the librarian's
                        // brief (see Highlights). A client fetches
                        // threads.highlights again when this or lastSeq moves
  sample?: true         // one of the tour's sample threads (threads.samples):
                        // made up, and threads.send refuses it
  worktree?: ThreadWorktree // the thread has a git worktree of its own
                        // (see Worktrees). Absent when it doesn't, or once
                        // it was removed
  schedule?: { id: string, title: string } // the schedule that started the
                        // thread (see Schedules), with its title as it was
                        // then. Absent for one a person or agent started
  panelRequest?: PanelRequest // a panel the agent asked to show Mike,
                        // waiting for him to look at the thread (see
                        // Showing panels). Absent when there's none
  share?: ThreadShare   // who else can read it on the website (see
                        // Sharing). Absent until it's first shared
}

// A thread's own worktree, as its summary shows it (see Worktrees).
type ThreadWorktree = {
  branch: string        // "thread/ab12cd34"
  mainCheckout: string  // the checkout with main checked out, where it lands
  path: string          // the worktree's root folder
}

// A project a thread is in, as its summary shows it.
type ThreadProject = {
  id: string
  title: string
  by: "mike" | "agent" | "librarian" // who put it there
  pinned?: boolean      // Mike put it there (or an agent was told to): the
                        // librarian won't take it out
  at: string            // when it was put there
  why?: string          // why it's there, a short line: the librarian's
                        // reason ("Shortlists photos for the calendar
                        // entry"), newest look's wins. Highlights shows it
                        // behind the project's ⓘ
}

type Action = {
  id: string            // "<patch>.<slug of the title>": "reseed.reseed-dev-db"
  title: string
  kind: "command" | "prompt" | "url"
  command?: string      // kind "command": run by `actions.run`, in `folder`
  prompt?: string       // kind "prompt": sent to the thread as a message by `actions.run`
  url?: string          // kind "url": an http or https page (normalised). The
                        // client opens it itself, on the device it was pressed
                        // on: no RPC, nothing in the transcript. The phone
                        // gets these through Sync (`links`) An older
                        // client reads the unknown kind as a command and
                        // calls `actions.run`, which opens it on the runner's
                        // Mac and answers `{ ok: true, durationMs }`
  patch: string
  folder?: string       // where the command runs: the project folder the
                        // patch came from. Absent: the thread's own folder
  projectId?: string    // the project whose folder gave it (see Projects)
  note?: string
  icon?: string         // an SF Symbol for the chip: the action's own `icon`,
                        // else its patch file's; absent: the client's default
  badge?: number        // see Patches, "Live state"
}

type Hook = {
  id: string            // "<patch>.<slug of the title>"
  title: string
  on: "turn.end"        // when it runs: after a turn the agent completed (not one it was interrupted in, or failed)
  command: string       // run in `folder`, as an action's command is
  exec?: string         // for a patch trusted by its hash: what the runner
                        // really runs, `command`'s script by absolute path
                        // (see "Trusting a folder's patches"); show `command`
  edited?: string       // only after a turn that edited a file matching this glob, relative to `folder` ("**/*.ts")
  tell: "failures" | "always" | "never"  // when its result is sent to the agent as a message (see Patches)
  patch: string
  folder?: string       // as Action's; a hook from a project folder only
                        // sees edits inside that folder
  projectId?: string
  note?: string
}

type PatchInfo = {
  id: string            // "convex", "xcode", or a patch file's name without its extension
  source: "builtin" | "home" | "project" | "claude" // claude: the thread
                        // folder's Claude Code settings, listed only while
                        // they're waiting (see "Trusting a folder's Claude
                        // Code hooks"); a client that doesn't know it shows
                        // it as a project's
  file?: string         // the module, for home and project patches
  folder?: string       // set (with projectId) when it came from one of
                        // the thread's projects' folders rather than its
                        // own: the folder holding `.threadbear/`, or a
                        // built-in's project folder
  projectId?: string
  error?: string        // the file couldn't be loaded, and gives nothing until it's fixed
  untrusted?: "new" | "changed" // a project's patch file that isn't trusted yet, so
                        // wasn't loaded and gives nothing: "new" when nothing
                        // from its folder is trusted, "changed" when an earlier
                        // version was (see "Trusting a folder's patches")
  hash?: string         // with untrusted: the version patches.trust would trust
  helpers?: string[]    // with untrusted: the local files it imports or names
                        // (absolute), whose text the hash covers too
  changes?: {          // with untrusted "changed": what differs from the version
                        // last trusted there (see "What changed"). Says only
    since?: string      // ISO time that version was trusted
    recheck?: true      // only hashes from before 6 Nov's version 3 there
    files?: { path: string; was: "changed" | "added" | "removed";
              commits?: { sha: string; subject: string }[]; moreCommits?: number;
              uncommitted?: true; diff?: string }[] // path from the folder holding
                        // .threadbear/; diff: "- ", "+ ", "  " lines, "…" between hunks
  }
  editsAsk?: string     // a patch that loads without a hash runs something
                        // Threadbear can't follow, so threads in Ask and Auto
                        // ask before every file edit: which, why, and what to
                        // change (see "Agent writes that run as code")
}

type Panel = {
  id: string            // unique within the thread: "convex.dashboard", "xcode.simulator"
  title: string         // the tab's label
  kind: "url" | "image" | "list" // a page in a web view, a picture the runner
                        // draws on request, or rows the runner gets from the
                        // patch on request (see Patches)
  url?: string          // kind "url": the page; also what Open in browser opens
  icon?: string         // an SF Symbol name for its button on the right-hand
                        // rail; absent: the client picks one by kind
  patch: string         // the patch it came from: "convex", "xcode"
  projectId?: string    // as Action's
  note?: string         // one line about it: the deployment, the project
  convex?: {            // the built-in Convex panel for a cloud deployment:
    deployment: string  // its name, "happy-otter-123"
    deploymentUrl: string // "https://happy-otter-123.convex.cloud": only
                        // ever the deployment's own <name>[.<region>].convex.cloud,
                        // as it's handed a deploy key and comes from an env
                        // file a cloned repo writes; any other URL, a custom
                        // domain included, gets no `convex`
    team?: string       // "mike" and "walkies": what `convex dev` notes
    project?: string    // after CONVEX_DEPLOYMENT in .env.local, if it did
  }                     // a client that knows it shows Convex's embedded
                        // dashboard with panels.convexKey (see "The Convex
                        // panel"); one that doesn't shows `url`
  from?: string         // a panel button's (see Reply buttons): the folder
                        // whose patch it is, as the thread isn't there
}

// One row of a `list` panel (panels.render).
type PanelItem = {
  title: string
  detail?: string       // grey, under the title, up to two lines
  url?: string          // a click opens it in the browser, or the panel if Mike set "Default"
  path?: string         // a click previews the file in the pane
  icon?: string         // an SF Symbol name
  tone?: "attention" | "failed" | "warning" | "working" | "done"
                        // each its own shape and a colour a red-green colour-blind
                        // eye tells apart (issue #67): an orange circle, a rose
                        // diamond, a yellow triangle, a turning blue arc, a blue
                        // tick; absent: plain. A client that doesn't know a tone
                        // draws the row plain
  section?: string      // a heading over this row and the ones after it with the same
                        // section, drawn where it changes ("Waiting · 1"); at most 80 characters
  trailing?: string     // short and faint at the end of the title's line, like a date
                        // ("5d"); at most 24 characters
  toggle?: {            // a switch drawn as an icon at the end of the title's line, lit
                        // when on and faint when off; a press sends panels.toggle. Only
                        // on rows of a panel whose patch has a `toggle` function (see
                        // Patches, "Row toggles"); dropped from any other panel's rows
    id: string          // what panels.toggle hands back; at most 200 characters
    on: boolean
    icon?: string       // an SF Symbol name; absent: "power"
    title?: string      // its tooltip ("Auto-fix #812"); at most 80 characters
  }
}

// A grouping above folders that carries goals, state and notes forward
// (see Projects).
type Project = {
  id: string            // "p_" and 8 hex characters
  title: string
  folders: string[]     // absolute paths, in the order patches load from them
  goals: string         // a few lines: what it's for, what done looks like
  state: string         // a few lines: where it's up to, what's next
  notes: string         // markdown: decisions, gotchas, commands, links
  links: ProjectLink[]  // the places Mike goes for it, at most 8 (see
                        // Projects, "Links"); [] from a runner before them
  createdBy: "mike" | "agent" | "librarian"
  createdByThread?: string // the thread whose agent or look made it
  titleBy?: "mike" | "agent" | "librarian" // who last named it; absent
                        // on older projects, where createdBy stands in
  createdAt: string
  updatedAt: string
  stateUpdatedAt?: string
  archived?: boolean
  icon?: ProjectIcon    // absent until the librarian has found or picked one
  threadCount: number   // threads in it, put away ones included
  lastActivityAt?: string // its newest thread's lastActivityAt
}

// A place Mike keeps going back to for a project: its live site, admin
// page, dashboard, store listing or repo.
type ProjectLink = {
  title: string         // short: "Live site", "Admin"; the host when not given
  url: string           // http or https
}

// A project's icon: a picture, else an SF Symbol (see Projects, "Icons").
// A client that can't draw either shows the title's first letter.
type ProjectIcon = {
  image?: ImageRef      // a copy in the runner's data dir (project-icons/),
                        // PNG at most 256 px, or SVG ("image/svg+xml")
  symbol?: string       // an SF Symbol name, when there's no picture
  from?: string         // the file the picture was copied from
  by: "mike" | "agent" | "librarian" // librarian: found by itself and kept
                        // up to date; mike or agent: chosen, and left alone
                        // until set back to automatic
  updatedAt: string
}

// What the librarian (see Projects) is doing, has done and will do next.
type LibrarianStatus = {
  state: "idle" | "working" | "paused" | "off"
  reason?: string       // state "off": why ("Needs a Claude pool to run
                        // on", "Every login in Claude is out of room",
                        // "Model calls are off")
  paused: boolean       // Mike paused it; looks wait in the queue
  current?: LibrarianJob & { startedAt: string } // the look under way
  queue: LibrarianJob[] // what it will look at next, soonest first
  recent: LibrarianEntry[] // what it did, newest first, the last 50
  looksToday: number
  spentTodayUsd: number // always 0 (it runs on the pool); kept for older apps
  skippedToday?: number // quiet catch-ups skipped without a model call
  tokensToday?: number  // tokens in and out, every look and icon pick
  notionalTodayUsd?: number // what the pool's calls would have cost on
                        // the API; they use logins' room, not money
}

type LibrarianReason =
  | "first-message"     // a new thread's first message came in
  | "first-turn"        // a thread's first turn ended
  | "new-folder"        // a turn edited files outside the thread's projects' folders
  | "moved"             // the thread changed folder
  | "catch-up"          // more turns since its last look (at most hourly)
  | "asked"             // librarian.run, or a backfill
  | "notes"             // a project's notes went past 12,000 characters and
                        // were rewritten shorter (an entry only: threadId is
                        // "", projectIds has the project; the old notes are
                        // kept in <data dir>/project-notes, the last 5 each)

type LibrarianJob = {
  threadId: string
  threadTitle: string
  reason: LibrarianReason
  why: string           // the reason in words: "Edited files in ~/dev/me/poddle"
  dueAt: string
}

type LibrarianEntry = {
  id: string
  at: string
  threadId: string
  threadTitle: string
  reason: LibrarianReason
  outcome: "joined" | "created" | "updated" | "left" | "nothing" | "skipped" | "failed"
  text: string          // "Put it in Threadbear", "Made Poddle and put it there",
                        // "Threadbear's state", "No key", the model's error
  projectIds?: string[]
  reasons?: Record<string, string> // why it joined each project, by id; only
                        // on a look that filed the thread somewhere
  why?: string          // that look's line overall
  costUsd?: number
}


// A sub-agent the thread's agent started (Claude's Agent tool). The runner
// follows it from the CLI's task events, so it changes while it runs: each
// change sends thread.updated. `threads.subagent` reads what it did.
type Subagent = {
  id: string            // the CLI's id for it (its task id)
  itemId?: string       // the tool.call that started it, in the thread
  parentId?: string     // the sub-agent that started this one, when it was
                        // started by a sub-agent rather than the thread's agent
  description: string   // its brief's title: "Review the runner changes"
  agentType?: string    // "general-purpose", "Explore", "fork"
  model?: string        // the model it runs on, from its own replies
                        // ("claude-opus-5-5"); absent before its first one.
                        // The latest reply's, as a fallback can take over
  effort?: string       // its effort level ("high"), filled in once
                        // threads.subagent has read its transcript
  status: "running" | "completed" | "failed" | "stopped"
                        // clients treat a status they don't know as stopped
  background: boolean   // the agent carried on while it ran
  activity?: string     // while running, what it's doing in the CLI's own
                        // words ("Running npm test")
  summary?: string      // once finished, what it reported, one line, <= 200 chars
  toolUses?: number     // tool calls so far
  startedAt: string
  endedAt?: string      // set once it's no longer running
}

type BackgroundTask = {
  kind: "agent" | "shell" | "monitor" | "other" // a sub-agent, a shell
                        // command, a Monitor, or anything else the CLI
                        // runs in the background (a workflow). Clients
                        // treat a kind they don't know as "other"
  description: string   // the CLI's own words: the sub-agent's brief, the
                        // command. May be empty
  finished?: boolean    // true once it has finished and the agent is about
                        // to start a turn of its own to read its result
                        // (the runner counts it for up to 15 s, until that
                        // turn starts)
}

type ImageRef = {
  path: string          // absolute path on this Mac
  mediaType: string     // "image/png", "image/jpeg", "image/gif", "image/webp"
  width?: number
  height?: number
}

type Schedule = {
  id: string
  title: string         // for lists; default the first line of text
  text: string          // the message it sends each time
  at?: string           // a one-off: when it runs
  cron?: string         // or repeating: a 5-field cron ("0 9 * * 1-5"), or
                        // @hourly, @daily, @weekly, @monthly, @yearly
  timezone?: string     // IANA zone the cron is read in; absent means the
                        // Mac's own zone, whatever it is at the time
  whenText: string      // "Weekdays at 9:00", "Once, Tue 28 Oct at 15:30":
                        // the runner's words for at/cron, for every client
  threadId?: string     // sends to this thread. Absent: starts a new thread
                        // each time, with the settings below
  cwd?: string          // new-thread settings, as in threads.create
  accountId?: string    // pins each thread to this login
  poolId?: string       // or this pool picks the login each run (see
                        // Pools); never both. Neither: the folder's pool,
                        // as threads.create picks it
  provider?: Provider   // with poolId only: the kind of login a pool of
                        // several kinds starts it on (threads.create's
                        // provider). Absent: the model's kind
  model?: string
  effort?: EffortLevel
  permissionMode?: "full" | "ask" | "auto" // absent: the runner's
                        // defaults.permissionMode when it runs, else full
  starThreads?: boolean // each thread it starts begins starred (Starred,
                        // above the Inbox). New-thread ones only
  defaultMode?: "full" | "ask" | "auto" | "plan" // set by the runner on a
                        // new-thread one with no permissionMode that runs
                        // here: the mode it inherits. Absent for another
                        // runner's, whose default isn't known here. An Ask or
                        // Auto thread raising a schedule's mode is checked
                        // against this; one not known counts as Ask for
                        // raising it and Full for what its runs reach.
                        // Never stored.
  paused: boolean
  createdAt: string
  updatedAt: string
  createdBy?: string    // the thread whose agent made it; absent for a person
  nextRunAt?: string    // absent while paused, or once a one-off has run
  finishedAt?: string   // a one-off that has run (kept for 7 days, then dropped)
  runs: number          // how many times it has sent its message
  lastRun?: {
    at: string
    outcome: "sent" | "skipped" | "failed"
    threadId?: string   // the thread it sent to or started
    note?: string       // why it was skipped or failed
  }
  runnerId?: string     // the runner it runs on (see Schedules, "Runners").
                        // Absent from a runner whose schedules are its own
                        // file: then it's that runner
  runnerName?: string   // that runner's name, as runners.list has it
  runnerIcon?: string   // and its icon (RunnerInfo.icon)
  runRequestedAt?: string // a schedules.run for it waits for its runner
}

// A runner Threadbear knows of, from the backend (runners.list).
type RunnerInfo = {
  id: string
  name: string          // "m5", "bruce": the Mac's hostname by default
  icon?: string         // an SF Symbol for its Mac: "laptopcomputer",
                        // "macmini", "macstudio", "macpro.gen3" or
                        // "desktopcomputer", from the model macOS names
                        // (runner/src/machine.ts), or sync.icon in
                        // runner.json. Absent from a runner before icons;
                        // a client draws a symbol it lacks as the desktop
  online: boolean       // heard from in the last 3 minutes
  lastSeenAt?: string
  self: boolean         // the runner answering
  // What its last heartbeat said, for the app's Runners panel. Absent from
  // an older runner.
  version?: string      // RUNNER_VERSION
  release?: string      // the release it runs (release.ts), when it runs one
  startedAt?: string    // when that runner process started
  draining?: boolean    // an old release finishing its threads in a handover
}

// The runner's settings, as the Settings window shows them. Everything here
// is kept in runner.json except the key, which only the runner ever reads.
type Settings = {
  defaultCwd: string    // where a new thread starts when it names no folder
  idleMinutes: number   // a CLI with no turn for this long is released
  maxLiveCLIs: number   // most CLIs kept live at once
  followMain: boolean   // build and restart onto main by itself; a change
                        // takes effect when the runner next restarts
  bulletReplies: boolean // a turn's reply is end_turn's bullets; false: the
                        // agent's own message (see "The summary")
  oneReply: boolean     // end_turn first, then the agent's message as the
                        // reply (see "Needs you", One reply); on by default
  labReview?: boolean   // review a code change on the other provider
                        // before the thread is done (Review by another
                        // lab); on unless runner.json has labReview: false.
                        // Absent from an older runner, where it was an
                        // experiment, so a client shows no switch
  labReviewers?: { provider: Provider, model?: string, effort?: EffortLevel }[]
                        // who reviews, in order (Settings > General > Code
                        // review > Every change): the first of another lab
                        // with a login that has room, on its model and
                        // effort when it names them. A provider may come
                        // more than once on different models.
                        // runner.json's labReviewers, else Codex then Claude.
                        // Absent from an older runner: no list to show
  labPanel?: { provider: Provider, model?: string, effort?: EffortLevel }[]
                        // the review panel (Code review > Big or risky
                        // changes), which reviews a big or risky change all
                        // at once (Review by another lab); [] for none.
                        // runner.json's labPanel, else the entries of an
                        // older runner.json's labReviewers ticked
                        // panel: true. Absent from an older runner, which
                        // sent those ticks in labReviewers instead
  labPanelLines?: number // lines of code that make a change big (150)
  keepAwake?: boolean   // keep the Mac out of idle sleep while threads
                        // work (keep-awake.ts); on by default, sent only by
                        // a runner on a Mac, so clients show no switch
                        // without it
  bringIn: number | "important" | "off" // a fork: how often a thread starts
                        // to bring in Mike's releases, in days (1 to 365;
                        // 5 by default), only for important ones, or never
                        // (runner.json releases.bringIn; "Mike's releases")
  spareWeek?: boolean   // a thread suggesting work when a login's week is
                        // about to go unused (runner/src/spare-week.ts);
                        // runner.json spareWeek, on unless false. Absent
                        // from an older runner: clients show no switch
  fullSync: boolean     // full sync, as runner.json's sync.full says; it
                        // takes effect when the runner next starts
                        // (docs/convex-backend.md, "Full sync"; `tb settings full on|off`)
  models: {
    pool: string | null      // the pool whose Claude logins answer small
                             // jobs; "claude" by default, null: none, so
                             // no titles or librarian
    privateFolders: string[] // folders (and everything under them) whose
                             // text is never sent; "~/" paths as written
  }
}
```
