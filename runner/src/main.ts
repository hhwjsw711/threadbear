// Runner entry point: `node src/main.ts`. launchd runs this (see
// scripts/install-runner.sh); tests run it with THREADBEAR_HOME and
// THREADBEAR_PORT pointing at temp places.
// First, so every process the runner starts on Windows has no console window.
import './win32-hide.ts';
import { onYearToken } from './year-token.ts';
import { YearTokenMaker } from './year-token-maker.ts';
import { realCopy } from './real-copy.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readShareImage } from './share-images.ts';
import { CallerGate } from './rpc-gate.ts';
import { MARK_NAMES, ownThreadMarks, threadOfSocket } from './peer.ts';
import { threadKey as makeThreadKey } from './rpc-auth.ts';
import { makePrivate } from './win-acl.ts';
import { loadConfig, ensureHome, readToken, paths, recordListening, defaultHome, DEFAULT_CWD, RUNNER_VERSION, RunnerJsonError, peekRunnerJson, expandHome } from './config.ts';
import { startHousekeeping } from './housekeeping.ts';
import { BuildCacheCleaner } from './build-cache-cleanup.ts';
import { startBorrowSweep } from './runner/worktrees.ts';
import { win32Helper } from './win32-helper.ts';
import { RELEASE, markConfigStop, markGoodLater, onStopRequest, onSupervisorGone, ownCheckout, readRelease, readState, requestHandover, supervised, takeRollbackNotice, tellLaunchListening } from './release.ts';
import { PatchTrust } from './patch-trust.ts';
import type { RunnerUpdates } from './runner.ts';
import { dropScheduled, scheduledSendMethods, sendScheduled, Peers, PrimaryLink, ThreadRouter, drainChildrenName, peersElsewhere, phoneCommands, primaryElsewhere, primaryRemote, projectRouter, removeDrainInfo, scheduleRouter, writeDrainInfo, type CrossRunnerHooks, type Elsewhere } from './handover.ts';
import { RunnerUpdater, releaseTreeAt } from './update.ts';
import { RELEASE_NOTES_SYSTEM, SETTLE_MS, Upstream } from './upstream.ts';
import { BringIn } from './bring-in.ts';
import { SwiftChanges } from './swift-changes.ts';
import { commitBefore, commitOnMain, RemoteUpdateFixer, reportedOnDisk, UpdateFixer, type UpdateFailure } from './fix-update.ts';
import { followOriginOn } from './follow-origin.ts';
import { bringInSetting, spareWeekOn } from './settings.ts';
import { SpareWeek, looksByItself, spareWeekBinding } from './spare-week.ts';
import { MAIL_WATCH, MailWatch } from './mail-watch.ts';
import { Restarter, restartMethods } from './restart.ts';
import { AppRestarts } from './app-restarts.ts';
import { Scheduler, scheduleMethods } from './schedules.ts';
import { StuckJobs } from './stuck-jobs.ts';
import { FrozenClis } from './frozen-cli.ts';
import { KeepAwake } from './keep-awake.ts';
import { experimentOn } from './experiments.ts';
import { AgentArchive, ARCHIVE_EXPERIMENT, ARCHIVE_MCP_NAME, archiveMcpServer, archiveMethods } from './agent-archive.ts';
import { MemorySync } from './memory-sync.ts';
import { Reinstaller } from './reinstall.ts';
import { MacScreen } from './mac-screen.ts';
import { Projects, drainProjectMethods, projectMethods } from './projects.ts';
import { Coordinators, coordinatorMethods } from './coordinators.ts';
import { Librarian, librarianMethods } from './librarian.ts';
import { ConnectorsMonitor, connectorsMethods } from './connectors.ts';
import { DEFAULT_RECIPES_FOLDER, RECIPES_EXPERIMENT, Recipes, recipeMethods } from './recipes.ts';
import { TaskBoards, gatewayCaller, helperHeaders } from './notion-tasks.ts';
import { createLogger } from './log.ts';
import { hidIdleMs, isAtMac, screenLocked } from './presence.ts';
import { ThreadStore } from './store.ts';
import { AccountRegistry } from './accounts.ts';
import { ClaudeAdapter, cliEnv } from './adapters/claude/adapter.ts';
import { REFUSALS_FILE, SignInState } from './sign-in-state.ts';
import { ProcessRegistry, killGroup } from './proc.ts';
import { Runner } from './runner.ts';
import { startOwnThread } from './own-threads.ts';
import { heldBackBrief, heldBackTitle } from './updates/held-thread.ts';
import { ConvexUseTally } from './convex-use.ts';
import { CodexAdapter } from './adapters/codex/adapter.ts';
import { AcpAdapter } from './adapters/acp/adapter.ts';
import { ACP_AGENTS, ACP_PROVIDERS, type AcpProvider } from './adapters/acp/agents.ts';
import { acpAsker } from './models/acp-oneshot.ts';
import { codexAsker } from './models/codex-oneshot.ts';
import { PROVIDER_INFO } from './providers.ts';
import { resolveCodexBinary } from './adapters/codex/appserver.ts';
import { checkSurface, testedVersion } from './adapters/codex/surface.ts';
import { CliUpdates } from './updates/manager.ts';
import { ExtraUpdates } from './updates/extra.ts';
import { WebRuntimeUpdates, runtimeInstalled } from './updates/web-runtime.ts';
import { UsageStore } from './usage.ts';
import { UsageHistory } from './usage-history.ts';
import { TokenTally } from './token-tally.ts';
import { usageStatsMethods } from './usage-stats.ts';
import { Relay } from './relay.ts';
import { applyShared, LoginSharer, mergedList, openShared, type SharedLogin } from './login-share.ts';
import { VirtualRunners } from './virtual-runners.ts';
import { RpcServer } from './rpc.ts';
import { AppSeen } from './app-seen.ts';
import { realClock } from './clock.ts';
import { acquireLock } from './lock.ts';
import { isDirectory, removeTempFiles } from './fsutil.ts';
import { Models } from './models/index.ts';
import { SettingsService, modelMethods, settingsMethods } from './settings.ts';
import { SelfProfiler, profileMethods, watchStalls } from './self-profile.ts';
import { TrustOffThread } from './trust-off-thread.ts';
import { InstructionsStore, instructionsMethods } from './instructions.ts';
import { ConvexSync, convexPoster, convexUploader, defaultRunnerName, ensureRunnerId, keyRejected, readSyncKey, LIVE_REQUEST_API_VERSION, SHARE_LOGINS_API_VERSION } from './sync.ts';
import { BOX_NO_SCHEDULES, BoxFolderBroken, bootBox, readBoxSecrets, enterBoxEnv, markSetUp, prepareBoxFolder, readBoxBoot, repoFolderName, setBaseline, setSaveHold, type ActionPost, type BoxSecrets } from './box-mode.ts';
import { BoxProcesses } from './box-procs.ts';
import { asSave, closeSpawns, installSpawnGate, openSpawns } from './spawn-gate.ts';
import { isolatePatchCode } from './patches.ts';
import { SaveHold, saveThread } from './box-save.ts';
import { BoxTokenWatch } from './box-token.ts';
import { ClockJumpWatch } from './clock-jump.ts';
import { pushFailingText } from './push-failing.ts';
import { Scrubber } from './scrub.ts';
import { useScrubForCuts } from './safe-cut.ts';
import { redactSecrets } from './redaction.ts';
import { SecretCheck } from './secret-check.ts';
import { SharedPools } from './shared-pools.ts';
import { readPools } from './pools.ts';
import { machineSampler } from './runner-stats.ts';
import { machineIcon } from './machine.ts';
import { filesMethods } from './files.ts';
import { devicesMethods } from './devices.ts';
import { flushSentry, reportException, reportLoggedError, reportLoggedWarning, startSentry, useSentryMask } from './sentry.ts';
import { ERROR_EXIT_CODE, ERROR_LEAVE_DEADLINE_MS, ERROR_STOP_DEADLINE_MS, decideErrorExit, errorMode, guardHolds, guardNotice, readErrorExits, takeErrorEnv, testThrow, writeErrorExits } from './error-exits.ts';
import { ALWAYS_ASK_TOOLS, NEVER_ASK_TOOLS, LIVE_PAGES_LINE, RICH_BLOCKS_LINE, SERVER_NAME, buildThreadbearTools, threadbearMcpServer, type RemoteControl } from './threadbear-mcp.ts';
import { CrossRunner } from './cross-runner.ts';
import { FAILED_SHOWN_MS, MovePreviews, Moves, moveInfoFrom, previewInfo, stillRunner, type ThreadMoving } from './moves.ts';
import type { RemoteThreads } from './thread-index.ts';
import { FarReports, ROWS as FAR_ROWS, TICK_MS as FAR_TICK_MS, type FarRow } from './far-reports.ts';
import { ceilingMode, higherMode, lowerMode } from './runner/ceiling.ts';
import { EFFORT_LEVELS, ErrorCode, RpcError, isPermissionMode, type EffortLevel, type PermissionMode } from './protocol.ts';

// Tells launch.mjs this runner calls its listening() hook (release.ts), so
// it may stop one that hasn't started listening in time.
export const REPORTS_LISTENING = true;

// What a process start says while a box's save holds it (spawn-gate.ts).
const SAVE_HOLDS_SPAWNS = "this box's save holds it, so nothing starts until the backend says it may run again.";

async function main(): Promise<void> {
  // Windows: nothing the runner starts (a CLI, a patch's command, a hook,
  // npm's cmd.exe) runs a program from the folder it's in by name, as cmd.exe
  // otherwise does before PATH (a node.exe beside a package.json would run
  // for `node x.js`, unseen by patch trust: Codex's reviews, 18 Nov 2026).
  if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';
  // How long each part of a start takes, said once listening ('started in'),
  // so a slow restart shows where the time went.
  const bootSince = performance.now();
  // Each step's time is ms since main() began; loading the code before it
  // (Node's start and the imports) is `imports`.
  const bootSteps: Record<string, number> = {};
  const bootImports = Math.round(bootSince);
  const bootStep = (name: string) => (bootSteps[name] = Math.round(performance.now() - bootSince));
  // Box mode (box-mode.ts): a runner in a virtual runner's machine, for one
  // thread. Its boot token is read and taken out of the environment before
  // anything else, so nothing the runner starts inherits it.
  const boxBoot = readBoxBoot(process.env);
  if (boxBoot) {
    enterBoxEnv(process.env);
    // The one gate on starting processes, closed while a save holds the box (spawn-gate.ts).
    installSpawnGate();
    // And no repo's patch code in this process: each is read in a child of its own (patches.ts).
    isolatePatchCode();
  }
  const cfg = loadConfig();
  // A dev runner on a copy of the real data dir (real-copy.ts): whatever
  // came with the copy, it never syncs as Mike's runner (nor relays or
  // takes moves, which go through sync), fires schedules, has the
  // librarian send copied conversations to a model, or stops process
  // groups a copied run/ names, which are the live runner's.
  const copyOfReal = realCopy(cfg.home);
  if (copyOfReal) cfg.sync.enabled = false;
  // On Windows, the secrets folder is made private before the token is
  // written into it (win-acl.ts); chmod does that on a Mac. If Windows
  // refused (someone else's folder, a list this user can't change), the
  // runner doesn't start: its keys would go where others can read them
  // (Codex's third review). If PowerShell couldn't run at all, it starts
  // with a warning, as %LOCALAPPDATA% is this user's alone as Windows makes
  // it, and a runner that can't start can't say why in the app.
  const secretsAclProblem = await makePrivate(paths.secrets(cfg.home));
  if (secretsAclProblem?.startsWith('the helper said:')) {
    throw new Error(`The secrets folder (${paths.secrets(cfg.home)}) couldn't be made yours alone, so the runner won't keep its keys there: ${secretsAclProblem}`);
  }
  ensureHome(cfg.home);
  const log = createLogger(cfg.logFile, { echo: process.env.THREADBEAR_LOG_STDERR === '1', debug: process.env.THREADBEAR_DEBUG === '1', onError: reportLoggedError, onWarn: reportLoggedWarning });
  // Only the installed runner reports to Sentry (sentry.ts says why).
  const reporting = await startSentry(cfg.home);
  log.info('runner starting', { version: RUNNER_VERSION, home: cfg.home, port: cfg.port, pid: process.pid, sentry: reporting });
  if (secretsAclProblem) log.warn('could not make the secrets folder private', { why: secretsAclProblem });
  // After an uncaught error (error-exits.ts, onUncaught below): restarts
  // for errors lately, whether this runner is leaving after one, and the
  // code it exits with (a dev runner's says not to start it again).
  const errorEnv = takeErrorEnv(process.env);
  let errorExits = readErrorExits(cfg.home, RELEASE.release);
  // A handover after an error got as far as launch.mjs starting the new runner.
  let newRunnerUp = false;
  let leavingAfterError = false;
  let exitCode = 0;
  let stopDeadline: NodeJS.Timeout | undefined;
  const armStopDeadline = () => {
    if (stopDeadline) return;
    process.exitCode = exitCode;
    stopDeadline = setTimeout(() => {
      log.error(`the stop after an uncaught error took over ${ERROR_STOP_DEADLINE_MS / 1000} s; exiting now`);
      // The 'exit' handler stops the CLI groups still running.
      process.exit(exitCode);
    }, ERROR_STOP_DEADLINE_MS);
    // Never what keeps the process alive once everything else has gone.
    stopDeadline.unref();
  };
  // A main thread held up for a second or more says so in tb logs (self-profile.ts).
  watchStalls({ log });

  // The SDK warns when canUseTool is set in bypass mode; it's deliberate
  // (AskUserQuestion still goes through it), so keep it out of the log.
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if ((w as { code?: string }).code !== 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') log.warn('node warning', { message: w.message });
  });

  // Before anything else touches the data dir: only one runner may own it.
  const lock = acquireLock(paths.run(cfg.home));
  if ('heldBy' in lock) {
    log.error('another runner is already using this data dir', { pid: lock.heldBy, home: cfg.home });
    process.stderr.write(`Another runner (pid ${lock.heldBy}) is already using ${cfg.home}; not starting.\n`);
    process.exit(1);
  }
  process.on('exit', () => lock.release());

  // Box mode's first step, before anything else talks to the backend: the
  // boot exchange, then the thread's folder (a clone, or its last save).
  // A box that has run (not this start's own exchange), or that finds data
  // where its folder goes, never exits for a folder it can't use: on Fly an
  // exited entrypoint stops the machine and its disk is reset. It comes up
  // degraded (`broken`): heartbeating on its key, running nothing, saying
  // why on the thread, so the billing guard pauses it with its disk and a
  // person can see to it. Only a fresh box with nothing to lose exits.
  type Box = { secrets: BoxSecrets; threadKey: Buffer; checkout: string; cwd: string; restored: boolean; again?: true; broken?: string; fresh: boolean };
  const startBox = async (boot: NonNullable<typeof boxBoot>): Promise<Box> => {
    const workRoot = process.env.THREADBEAR_BOX_WORK || path.join(os.homedir(), 'work');
    let secrets: BoxSecrets | undefined;
    let fresh = true;
    try {
      const post = convexPoster(boot.syncUrl) as unknown as ActionPost;
      ({ secrets, fresh } = await bootBox({ boot, home: cfg.home, claudeDir: cfg.claudeMainDir, post, log }));
      const folder = await prepareBoxFolder({ secrets, fresh, home: cfg.home, claudeDir: cfg.claudeMainDir, workRoot, log });
      return { secrets, threadKey: Buffer.from(secrets.threadKey, 'base64'), ...folder, fresh };
    } catch (e) {
      const why = String((e as Error)?.message ?? e);
      if (secrets && (e instanceof BoxFolderBroken || !fresh)) {
        log.error('box: its folder is unusable; staying up, degraded, running nothing', { error: why });
        const checkout = secrets.prepared?.checkout ?? path.join(workRoot, repoFolderName(secrets.repo.origin));
        const cwd = secrets.prepared?.cwd && isDirectory(secrets.prepared.cwd) ? secrets.prepared.cwd : os.homedir();
        return { secrets, threadKey: Buffer.from(secrets.threadKey, 'base64'), checkout, cwd, restored: false, broken: why.replace(/^\w/, (c) => c.toLowerCase()), fresh };
      }
      log.error('box: could not start', { error: why });
      process.stderr.write(`The box's runner couldn't start: ${why}\n`);
      process.exit(1);
    }
  };
  const box = boxBoot ? await startBox(boxBoot) : undefined;
  // The provider's processes, spared when a stopping save kills everything
  // else in the box (box-procs.ts): taken once, by the first start after a
  // fresh exchange, before anything of the thread runs, and kept in
  // box.json for every start after (an agent's process that outlived a
  // restart is never in it). Linux's /proc only: a box without it can't
  // stop its processes, so it can't save.
  const boxProcs =
    box && fs.existsSync('/proc/self/stat')
      ? (() => {
          let baseline = box.secrets.baseline;
          if (!baseline && box.fresh) {
            baseline = new BoxProcesses().capture();
            setBaseline(cfg.home, baseline);
            box.secrets.baseline = baseline;
          }
          return new BoxProcesses({ baseline: baseline ?? [] });
        })()
      : undefined;
  if (box) {
    // Decision 1: its sync on the box key, the one login given, no
    // following main or keep-awake (the rest is boxEnv and the checks below).
    cfg.sync = { ...cfg.sync, enabled: true, runnerId: box.secrets.runnerId };
    if (box.secrets.login) cfg.claudeMainEmail = box.secrets.login;
    cfg.followMain = false;
    cfg.keepAwake = false;
    cfg.defaults = { ...cfg.defaults, cwd: box.cwd, accountId: 'claude-main' };
    log.info('box mode', { runnerId: box.secrets.runnerId, threadId: box.secrets.threadId, machineId: box.secrets.machineId, cwd: box.cwd, restored: box.restored });
  }

  if (!fs.existsSync(cfg.claudePath)) log.warn('claude CLI not found', { path: cfg.claudePath });
  // A sync or gateway URL that would send keys in the clear (secure-url.ts):
  // left unused, and said here as well as in tb status and the Connectors panel.
  if (cfg.sync.urlRefused) log.warn('sync URL refused, so sync is off', { reason: cfg.sync.urlRefused });
  if (cfg.connectorsRefused) log.warn('Connectors gateway URL refused, so it is off', { reason: cfg.connectorsRefused });

  // Temp files from atomic writes a crash interrupted.
  removeTempFiles(cfg.home, paths.run(cfg.home), paths.threads(cfg.home));

  const registry = new ProcessRegistry(paths.run(cfg.home), log);
  // The thread keys and ids this runner was started under (a dev runner's,
  // from a thread's shell): a connection under any other thread's that isn't
  // one of this runner's own threads is turned away (Daybreak finding 177).
  // Read now, while its parents are still there.
  const own = await ownThreadMarks({ log });
  // Read: what it starts without a thread's own environment mustn't carry
  // the starting thread's (a dev runner's tb would otherwise use that
  // thread's key here, and be refused).
  for (const n of MARK_NAMES) delete process.env[n];
  // Waits until the old CLIs are gone, so a resume never runs beside them.
  // A copy's run/ lists the live runner's CLIs: forgotten, never stopped.
  if (copyOfReal) registry.removeFile();
  bootStep('setup');
  const swept = copyOfReal ? 0 : await registry.sweepOrphans();
  bootStep('orphans');
  if (swept) log.warn('stopped process groups left from a previous run', { count: swept });

  const store = new ThreadStore(cfg.home);
  const token = readToken(cfg.home);
  // Token Stats' limits.json as a baseline, plus what the threads' own
  // turns report; the registry puts it on every account.
  // What each login shows over time, and its tokens by the hour, for the
  // Usage panel's charts (docs/protocol/settings.md, "Usage history").
  const usageHistory = new UsageHistory({ dataDir: cfg.home, clock: realClock, log });
  const usage = new UsageStore({ limitsFile: cfg.tokenStatsLimitsFile, dataDir: cfg.home, clock: realClock, log, history: usageHistory });
  usage.start();
  const accounts = new AccountRegistry(cfg, usage);
  // Which Claude logins are signed out or ending soon, from the CLI's own
  // `auth status` (sign-in-state.ts); the registry puts it on every account.
  const signIn = new SignInState({ claudePath: cfg.claudePath, accounts: () => accounts.list(), env: (a) => cliEnv(a), clock: realClock, log, file: path.join(cfg.home, REFUSALS_FILE) });
  accounts.signIn = signIn;
  signIn.start();
  // Year-long token… asked from another Mac (docs/protocol.md, accounts.yearToken).
  const tokenMaker = new YearTokenMaker({ claudePath: cfg.claudePath, env: (a) => cliEnv(a), log });
  const tally = new TokenTally({ dataDir: cfg.home, clock: realClock, log, accounts: () => accounts.list() });
  if (cfg.tokenTally !== false) tally.start();
  // Every session gets tools for driving Threadbear itself, bound to its
  // own thread. Sessions only start after the runner exists.
  let runner!: Runner;
  let scheduler!: Scheduler;
  // Threads waiting to hear the Mac app has restarted onto a new build
  // (app-restarts.ts). Made before the runner, which asks it while its
  // start() saves threads (THREADBEAR-2D), so it reaches the runner and
  // peers lazily; it only uses them once an app says hello.
  const appRestarts = new AppRestarts({
    runner: { get: (id) => runner.get(id), has: (id) => runner.has(id), note: (id, text) => runner.note(id, text), send: (...a) => runner.send(...a) },
    home: cfg.home,
    clock: realClock,
    log,
    away: (threadId) => peers.owns(threadId),
    appRepo: ownCheckout(),
  });
  // Asked for per thread, as sync is made after the runner. No tool while sync is off: the Pocket lives in the backend.
  const pocketControl = () => (sync.status().state === 'off' ? undefined : sync);
  let restarter!: Restarter;
  // Where the agent tools reach threads this runner doesn't have: draining
  // runners' (Peers) while this is the primary, the primary's once this one
  // is draining (docs/protocol/updates.md, "Handovers").
  let elsewhere: Elsewhere | undefined;
  let primaryLink: PrimaryLink | undefined;
  const router = (): ThreadRouter => (routerCache ??= new ThreadRouter(runner, () => elsewhere, () => crossHooks));
  // Other runners (cross-runner.ts), set once the relay is made.
  let crossHooks: CrossRunnerHooks | undefined;
  let routerCache: ThreadRouter | undefined;
  let updaterReady = false;
  // Set once this runner has handed over and is finishing its kept turns.
  let draining = false;
  const scheduleControl = () => scheduleRouter(scheduler, () => primaryLink);
  // Projects belong to the primary: a draining runner's agent tools change
  // them there rather than write projects.json beside it, and a kept thread
  // joins or leaves one here (docs/protocol/updates.md, "Handovers").
  const projectControl = () => projectRouter(projects, () => primaryLink, { draining: () => draining, holds: (threadId) => runner.has(threadId) });
  // Keeps both CLIs current (E). Its hooks call back into the runner and
  // the Restarter, made below; nothing calls them before start().
  const acpPaths: Record<AcpProvider, string | undefined> = { cursor: cfg.cursorPath, opencode: cfg.opencodePath, grok: cfg.grokPath, antigravity: cfg.antigravityPath };
  const acpBinary = (p: AcpProvider) => () => ACP_AGENTS[p].findBinary({ explicit: acpPaths[p], home: os.homedir(), pathEnv: process.env.PATH ?? '' });
  const updates = new CliUpdates({
    cfg,
    log,
    clock: realClock,
    hooks: {
      restartPending: () => Boolean(restarter?.status().pendingRestart),
      releaseIdle: (p, v) => runner.releaseIdle(p, v),
      versionsInUse: (p) => runner.versionsInUse(p),
      codexBinariesInUse: () => runner.codexBinariesInUse(),
      // Only where a fix can land: a checkout of its own that doesn't follow
      // GitHub's main. Elsewhere the fix reaches it from main as usual.
      heldBack: (h) => {
        const checkout = readRelease()?.checkout;
        if (!checkout || !cfg.followMain || followOriginOn(cfg.home)) return undefined;
        return startOwnThread(runner, { text: heldBackBrief(h, cfg.home), title: heldBackTitle(h), why: 'a Codex update held back by the protocol check' }, checkout);
      },
      threadState: (threadId) => {
        try {
          return runner.get(threadId).archivedAt ? 'archived' : 'open';
        } catch {
          return undefined;
        }
      },
    },
    codex: { resolve: (start) => resolveCodexBinary(start), checkSurface, testedVersion },
    notice: (level, message) => runner.notice(level, message),
    acp: { providers: ACP_PROVIDERS, binary: (p) => acpBinary(p as AcpProvider)(), updateArgs: (p) => ACP_AGENTS[p as AcpProvider].updateArgs },
  });
  // Other CLIs you use alongside Threadbear (Grok, Muse...), from runner.json.
  const extraUpdates = new ExtraUpdates({ home: cfg.home, log, clock: realClock, extra: cfg.cliUpdates.extra ?? [] });
  // The gateway's own word on which services are signed out, asked fresh
  // when a turn's gateway call failed: a sign-in ask comes only from that,
  // never from what a tool result says (connectors.ts, signInSignal).
  // `connectors` is the monitor made below; this only runs during a turn.
  // Other runners' threads for the agent tools (threadbear-mcp.ts
  // RemoteControl), through the relay made further down, as the Mac app
  // reaches them. With nothing heard yet (no app connected since the
  // runner started) the list starts the watch and waits up to 3 seconds
  // for the backend's first answer; after that it never waits.
  // Once a wait has run out (the backend not answering), the next minute's
  // calls use what's there rather than each waiting again.
  let remoteWaitSpentAt = 0;
  let drainRemote: RemoteControl | undefined;
  const remoteControl = (): RemoteControl | undefined => {
    // A draining runner has stopped its sync, so its kept turns reach
    // other runners' threads through the primary instead (primaryRemote).
    if (draining) return primaryLink ? (drainRemote ??= primaryRemote(primaryLink)) : undefined;
    const relay = relayRef;
    if (!relay || !sync.relaySource()) return undefined;
    const everyRunner = () => [{ id: syncRunnerId, name: cfg.sync.name ?? defaultRunnerName() }, ...sync.remoteThreads().runners.map((r) => ({ id: r.id, name: r.name }))];
    return {
      list: async () => {
        let r = sync.remoteThreads();
        if (!sync.remoteHeard() && Date.now() - remoteWaitSpentAt > 60_000) {
          for (let waited = 0; !sync.remoteHeard() && waited < 3000; waited += 200) {
            await new Promise((res) => setTimeout(res, 200));
          }
          if (!sync.remoteHeard()) remoteWaitSpentAt = Date.now();
          r = sync.remoteNow();
        }
        return relay.overlay(r);
      },
      call: (threadId, method, params) => relay.call(threadId, method, { threadId, ...params }),
      // move_thread with a runner: picked in threadbear-mcp.ts (moves.ts
      // pickRunner) from these, before any card, then moved by that id.
      runners: async () => everyRunner(),
      move: async ({ threadId, runnerId, runnerName, cwd, accountId }) => {
        // Again as it goes: the card showed this runner by this name.
        const to = stillRunner(runnerId, runnerName, everyRunner());
        const move = methods['threads.move'];
        if (!move) throw new Error("This runner can't move threads.");
        await move({ threadId, runnerId: to.id, ...(cwd ? { cwd } : {}), ...(accountId ? { accountId } : {}) });
        return `Moving it to ${to.name}. It goes once its turn ends, with its whole conversation and its worktree's git work, and carries on there from its next message. If it can't, it stays here and says why.`;
      },
    };
  };
  const gatewayHealth = async () => {
    const s = await connectors.refresh(true);
    return s.state === 'ok' ? s.services : undefined;
  };
  // Agent Archive's own MCP server for every thread while its experiment's
  // on (agent-archive.ts, archiveMcpServer), read at each session's start.
  const archiveServers = (): Record<string, { command: string; args: string[] }> => {
    const s = experimentOn(cfg.home, ARCHIVE_EXPERIMENT) ? archiveMcpServer() : undefined;
    return s ? { [ARCHIVE_MCP_NAME]: s } : {};
  };
  const claude = new ClaudeAdapter({
    claudePath: cfg.claudePath,
    registry,
    log,
    mcpServersFor: (threadId) => ({
      [SERVER_NAME]: threadbearMcpServer(router(), threadId, scheduleControl(), projectControl(), appRestarts, () => cfg.bulletReplies, pocketControl, () => cfg.oneReply, () => cfg.connectorsUrl, gatewayHealth, remoteControl, () => experimentOn(cfg.home, 'livePages'), () => runner.coordinators),
      ...Object.fromEntries(Object.entries(archiveServers()).map(([name, server]) => [name, { type: 'stdio' as const, ...server }])),
    }),
    oneReply: () => cfg.oneReply,
    alwaysAsk: ALWAYS_ASK_TOOLS,
    neverAsk: NEVER_ASK_TOOLS,
  });
  // The threadbear tools for an agent that isn't given them in-process.
  // What Codex and ACP agents get beside the tools: the rich blocks, and
  // live pages with that experiment on.
  const richGuidance = () => (experimentOn(cfg.home, 'livePages') ? `${RICH_BLOCKS_LINE} ${LIVE_PAGES_LINE}` : RICH_BLOCKS_LINE);
  const codexStyleTools = (threadId: string) => buildThreadbearTools(router(), threadId, Date.now, scheduleControl(), projectControl(), appRestarts, { provider: 'codex', bulletReplies: () => cfg.bulletReplies, oneReply: () => cfg.oneReply, pocket: pocketControl, gateway: () => cfg.connectorsUrl, gatewayHealth, remote: remoteControl, coordinators: () => runner.coordinators });
  // One app-server per live Codex thread, each starting what E says is
  // current, with the same threadbear tools as dynamic tools.
  const codex = new CodexAdapter({
    codexBinary: () => updates.codexBinary(),
    codexArgs: cfg.codexArgs,
    registry,
    log,
    toolsFor: codexStyleTools,
    mcpServers: archiveServers,
    // An extra Codex login gets ~/.codex's instructions, hooks, skills and
    // config.toml, linked, and the trust its hooks have there.
    codexMainDir: cfg.codexMainDir,
    onNotice: (text) => runner.notice('warning', text),
    extraGuidance: () => richGuidance(),
  });
  // One process per live thread on an agent that speaks ACP, off unless the
  // experiment is on (they find no account, and refuse to start without it).
  const acpAdapters = Object.fromEntries(
    ACP_PROVIDERS.map((p) => [
      p,
      new AcpAdapter({
        agent: ACP_AGENTS[p],
        binary: acpBinary(p),
        registry,
        log,
        toolsFor: codexStyleTools,
        extraGuidance: () => richGuidance(),
        dataDir: cfg.home,
        mcpServers: archiveServers,
      }),
    ]),
  );
  // The runner's own small-model calls, on the settings' pool.
  const models = new Models({
    home: cfg.home,
    clock: realClock,
    log,
    settings: () => cfg.models,
    claudePath: cfg.claudePath,
    registry,
    askers: {
      codex: codexAsker({ codexBinary: () => updates.codexBinary(), registry }),
      ...Object.fromEntries(ACP_PROVIDERS.filter((p) => PROVIDER_INFO[p].smallJobs).map((p) => [p, acpAsker({ agent: ACP_AGENTS[p], binary: acpBinary(p), registry, log, dataDir: cfg.home })])),
    },
    poolHost: { pool: (id) => runner.smallModelPool(id), ranDry: (id) => runner.noteRanDry(id) },
  });
  const projects = new Projects({ home: cfg.home, clock: realClock, log });
  // Presence as the Convex mirror last checked it, for the line a phone
  // message gets (Runner.forAgent). Only phone messages read it, and they
  // only come through that mirror.
  let atMac: boolean | undefined;
  // Set once Recipes is made, further down.
  let recipesHabits: (() => string) | undefined;
  const instructions = new InstructionsStore({ home: cfg.home, token, publish: (n) => runner.publish(n) });
  // Not in box mode: its spawn gate (spawn-gate.ts) holds processes on the
  // main thread only, and the look runs git.
  const trustWorker = box ? undefined : new TrustOffThread();
  runner = new Runner({
    // A box's one thread, and whether its restored worktree's setup must run
    // before any turn (runner/moves.ts setUpRestored).
    // A restored worktree's setup runs before any turn, on every start until it has (box.json's setUp).
    // A save under way or unresolved when it stopped holds it too, before anything loads (box-save.ts SaveHold).
    ...(box
      ? {
          boxThread: box.secrets.threadId,
          boxHolds: [...(box.broken ? ['broken' as const] : box.restored && !box.secrets.setUp ? ['setup' as const] : []), ...(box.secrets.saveHold ? ['save' as const] : [])],
        }
      : {}),
    threadKey: (id) => makeThreadKey(token, id),
    // His own, then the habits of the recipes that are on (recipes.ts): both
    // are for every thread, and a change to either is news the same way.
    standingInstructions: () => [instructions.given().trim(), recipesHabits?.() ?? ''].filter(Boolean).join('\n\n'),
    projects,
    atMac: () => atMac,
    config: cfg,
    store,
    adapters: { claude, codex, ...acpAdapters },
    accounts,
    // A draining runner's readings go to the primary, which owns
    // usage.json (docs/protocol/updates.md, "Handovers").
    usage: {
      record: (accountId, reading) => (draining ? runner.publish({ method: 'drain.usage', params: { accountId, reading } }) : usage.record(accountId, reading)),
      onChange: (fn) => usage.onChange(fn),
    },
    signIn,
    tokenMaker,
    clock: realClock,
    log,
    models,
    // A box's clone is its own checkout too: its repo's worktree setup runs as a new thread's would.
    // The slow looks at folders on worker threads, not the main one (trust-off-thread.ts).
    patchTrust: new PatchTrust({ file: path.join(cfg.home, 'patch-trust.json'), always: [ownCheckout(), ...(box && !box.broken ? [box.checkout] : [])], offThread: trustWorker }),
    offThread: trustWorker,
    // Keeps any text end_turn's own sign-up or wait_for_app_restart gave.
    appRestartAsked: (threadId) => {
      if (!appRestarts.isWatching(threadId)) appRestarts.watch(threadId);
    },
    awaitingAppRestart: (threadId) => appRestarts.isWatching(threadId),
    appRestartWant: (threadId) => appRestarts.waitingFor(threadId),
  });
  // Until it is listening (below): see Runner.holdWaits.
  runner.holdWaits = true;
  const settings = new SettingsService({
    config: cfg,
    publish: (n) => {
      runner.publish(n);
      // An experiment switched (virtualRunners' Runs on entries): the sidebar's watch catches up.
      if (n.method === 'settings.updated') sync.refreshIndex();
    },
    poolIds: () => runner.listPools().pools.map((p) => p.id),
  });
  // Runners still finishing turns after a handover: connected before the
  // threads load, so the ones they have are left to them. Nothing after the
  // await below yields until runner.start(), so no thread can arrive first.
  const peers = new Peers({
    home: cfg.home,
    token,
    log,
    runner: {
      adopt: (threadId, o) => {
        // Only the primary takes threads in. A draining runner has closed
        // its peers, but one already on its way in mustn't land here.
        if (draining) return undefined;
        const t = runner.adopt(threadId, o);
        restarter?.resumeAdopted(threadId);
        // Cut off mid-turn if the old runner crashed with it: carried on.
        if (o?.crashed) runner.carryOnStopped(threadId);
        // A review the old runner couldn't start (runner/lab-review.ts),
        // after the resume, which it would otherwise turn away.
        runner.startOwedReviews(threadId);
        // It may have finished on the old runner while a thread waiting on
        // it had already come across. After its own carry-ons, which are
        // new work, so a finish they replace doesn't count.
        runner.reconcileWaits();
        // Told now if the app restarted while it was over there.
        if (t) appRestarts.adopted(threadId);
        return t;
      },
      // A thread here may be waiting on one deleted over there.
      waitedOnDeleted: (threadId) => runner.waitedOnDeleted(threadId),
      publish: (n) => runner.publish(n),
    },
    usage: (accountId, reading) => usage.record(accountId, reading),
    onChange: () => publishUpdates(),
    sweep: async (pid) => {
      const theirs = new ProcessRegistry(paths.run(cfg.home), log, drainChildrenName(pid));
      const n = await theirs.sweepOrphans();
      theirs.removeFile();
      if (n) log.warn('stopped process groups a draining runner left', { pid, count: n });
    },
  });
  bootStep('before peers');
  const kept = await peers.connectAll();
  bootStep('peers');
  elsewhere = peersElsewhere(peers);
  // Before any queue is started: a reminder an older release queued goes by
  // its schedule's ceiling, Ask until the Scheduler is up (runner/ceiling.ts).
  runner.scheduleCeiling = (id) => (scheduler ? scheduler.ceilingById(id) : 'ask');
  // Load shared project memory before recovery can dispatch a coordinator.
  projects.start(runner);
  const coordinators = new Coordinators({ home: cfg.home, host: runner, projects, clock: realClock, log, enabled: () => !box && experimentOn(cfg.home, 'coordinators'), elsewhere: (id) => peers.find(id) });
  runner.coordinators = coordinators;
  runner.start({ skip: kept });
  // App-restart watches with words from before ceilings: bound now.
  appRestarts.bindOldCeilings((id) => (runner.has(id) ? runner.authoritySaved(id).mode : undefined));
  bootStep('threads');
  // Answers to ask_secret go after a day (docs/protocol/threads.md, "Secrets").
  runner.secrets.startSweeping((e) => log.warn('secret sweep failed', { error: String(e) }));
  // Its runner id and name are the mirror's (sync.ts), since that's how other
  // runners and the backend know this one (step 6, docs/archive/step6-plan.md).
  const syncRunnerId = cfg.sync.runnerId ?? ensureRunnerId(cfg.home);
  // The main Mac's logins, one share at a time (login-share.ts applyShared).
  let sharing: Promise<unknown> = Promise.resolve();
  const takeSharedLogins = (entries: { email: unknown; box: unknown }[]): Promise<unknown> => {
    const go = async () => {
      const wanted: SharedLogin[] = [];
      const failed: { email: string; message: string }[] = [];
      for (const e of entries.slice(0, 20)) {
        try {
          wanted.push(openShared((b, info) => runner.secrets.openBytes(b, info), syncRunnerId, e));
        } catch (err) {
          if (typeof e.email === 'string') failed.push({ email: e.email.toLowerCase(), message: (err as Error).message });
        }
      }
      accounts.rescanNow();
      const answer = await applyShared(
        {
          accountsDir: cfg.accountsDir ?? path.join(cfg.home, 'accounts'),
          tokenStatsAccountsDir: cfg.tokenStatsAccountsDir,
          claudeMainDir: cfg.claudeMainDir,
          claudeMainJson: cfg.claudeMainJson,
          makePrivate: (dir) => makePrivate(dir),
        },
        wanted,
        failed,
        runner.safeAccounts(),
      );
      accounts.rescanNow();
      runner.rescanAccounts();
      log.info('took logins from the main Mac', { logins: answer.logins.map((l) => `${l.email} ${l.state}`), removed: answer.removed.map((r) => r.accountId) });
      return answer;
    };
    const p = sharing.then(go, go);
    sharing = p.catch(() => undefined);
    return p;
  };
  // When this process started: the heartbeat sends it, and runners.list
  // gives it for this runner too (the app's Runners panel says "up 3h").
  const startedAt = new Date().toISOString();
  // The kind of Mac this is, for its icon in lists (machine.ts).
  const runnerIcon = cfg.sync.icon ?? (await machineIcon(paths.run(cfg.home)));
  bootStep('machine');
  scheduler = new Scheduler({
    runner,
    home: cfg.home,
    clock: realClock,
    log,
    elsewhere: (id) => peers.owns(id) || peers.isArriving(id),
    folderElsewhere: (id) => peers.find(id)?.cwd,
    sendElsewhere: (id, text, scheduleId, run, since, preserve, ceiling) => sendScheduled(runner, peers, id, text, scheduleId, run, since, preserve, ceiling),
    // A busy one may be in a turn that started with more than its saved
    // mode; its summary doesn't say, so count it as full (rpc-gate.ts).
    accessElsewhere: (id) => {
      const t = peers.find(id);
      if (!t || t.status === 'running' || t.status === 'starting' || t.status === 'waiting') return undefined;
      return t.permissionMode;
    },
    savedModeElsewhere: (id) => peers.find(id)?.permissionMode,
    dropElsewhere: (id, scheduleId) => dropScheduled(runner, peers, id, scheduleId),
    self: { id: syncRunnerId, name: cfg.sync.name ?? defaultRunnerName(), icon: runnerIcon, version: RUNNER_VERSION, release: RELEASE.release, startedAt },
    syncOn: Boolean(cfg.sync.enabled && cfg.sync.url && readSyncKey(cfg.home)),
    // A box keeps none (decision 13): every way to make, change or run one is refused.
    ...(box ? { refuse: BOX_NO_SCHEDULES } : {}),
  });
  runner.scheduleDeleted = (id) => scheduler.wasDeleted(id);
  // A box has no schedules (decision 13): they stay on the Mac and send to it.
  if (!copyOfReal && !box) scheduler.start();
  // The done card's loose ends list the check-ins booked for a thread.
  runner.schedulesFor = (id) => scheduler.list(id);
  // The list as it starts, so the first change to it re-sends the threads it moves.
  runner.recheckWaitStates();
  runner.scheduleChecks = () => scheduler.localChecks();
  // The librarian needs both the loaded projects and the recovered threads.
  if (!copyOfReal && !box) coordinators.start();
  const librarian = new Librarian({ host: runner, projects, models, clock: realClock, log, home: cfg.home, pocket: pocketControl });
  if (!copyOfReal && !box) librarian.start();
  // Background jobs that look stuck get their thread a message.
  const stuckJobs = new StuckJobs({ host: runner, clock: realClock, log, home: cfg.home });
  stuckJobs.start();
  // A CLI frozen on something only a person can answer says so in its thread.
  const frozenClis = new FrozenClis({ host: runner, clock: realClock, log, machine: cfg.sync.name ?? defaultRunnerName() });
  frozenClis.start();
  // Keeps the Mac out of idle sleep while threads work, unless Settings
  // turns it off (read each sweep, so the switch needs no restart).
  const keepAwake = new KeepAwake({ busy: () => runner.workingThreads(), on: () => cfg.keepAwake, clock: realClock, log });
  keepAwake.start();
  // A dialog waiting on this Mac's screen says so, from the installed runner
  // only: a dev runner's Mac is the one you're sat at, and a throwaway data
  // dir shouldn't get a thread about it. THREADBEAR_MAC_SCREEN=on to try it
  // on a dev runner, off to stop it.
  const macScreenSetting = process.env.THREADBEAR_MAC_SCREEN;
  const macScreen = process.platform === 'darwin' && macScreenSetting !== 'off' && (macScreenSetting === 'on' || readRelease())
    ? new MacScreen({ host: runner, clock: realClock, log, machine: cfg.sync.name ?? defaultRunnerName(), stateFile: path.join(cfg.home, 'mac-screen.json') })
    : undefined;
  macScreen?.start();
  // The Connectors gateway's /health, for the app's Connectors panel
  // (docs/protocol/panels.md, "Connectors"). Off when there's no gateway.
  const connectors = new ConnectorsMonitor({
    url: cfg.connectorsUrl,
    ...(cfg.connectorsRefused ? { offReason: cfg.connectorsRefused } : {}),
    log,
    onChange: (s) => runner.publish({ method: 'connectors.updated', params: { connectors: s } }),
  });
  connectors.start();
  // Projects' task boards in Notion, read through the same gateway
  // (notion-tasks.ts). With no gateway, a project with a Notion page
  // shows why its board is empty.
  projects.useTaskBoards(
    new TaskBoards({
      home: cfg.home,
      ...(cfg.connectorsClient ? { call: gatewayCaller({ mcpUrl: cfg.connectorsClient.mcpUrl, headers: helperHeaders(cfg.connectorsClient.headersHelper) }) } : {}),
      log,
      onChange: () => projects.boardChanged(),
    }),
  );
  // The Convex mirror the phone reads (docs/convex-backend.md). Best
  // effort: off without a URL and key, and never in the way of a turn.
  // The RPC server is made further down; presence asks it once it's there.
  let rpcServer: RpcServer | undefined;
  // Whether this runner has an app of its own lately (app-seen.ts).
  const appSeen = new AppSeen(cfg.home, () => Date.now());
  // Pools shared with the other runners through the backend, once it has
  // them (docs/protocol/settings.md, "Pools"); the last list seen is kept on disk.
  const sharedPools = new SharedPools({
    cachePath: `${cfg.home}/shared-pools.json`,
    runnerId: syncRunnerId,
    accounts: () => runner.safeAccounts(),
    // runner.json's own pools, shaped as the runner reads them.
    localPools: () => (Array.isArray(runner.cfg.pools) && runner.cfg.pools.length ? readPools({ pools: runner.cfg.pools }, runner.safeAccounts()) : undefined),
    onChange: () => runner.poolsMaybeChanged(),
    log,
  });
  const syncKey = readSyncKey(cfg.home);
  if (cfg.sync.enabled && cfg.sync.url && syncKey) {
    sharedPools.loadCache();
    runner.sharedPools = sharedPools;
  }
  const scrubber = new Scrubber({ secretsDir: paths.secrets(cfg.home), log });
  // A login's year-long token, whole and without its fixed prefix.
  onYearToken((t) => {
    scrubber.known.add(t);
    scrubber.known.add(t.replace(/^sk-ant-oat01-/, ''));
  });
  // Text cut short anywhere in the runner is cut where none of these values
  // (nor anything the rules know) is split in two (safe-cut.ts). Not counted
  // in the scrubber's status: nothing is taken out here.
  useScrubForCuts((text) => redactSecrets(scrubber.known.mask(text)).text);
  // Sentry's events lose them too (sentry.ts scrubForSentry).
  useSentryMask((text) => scrubber.known.mask(text));
  runner.secrets.onWritten = (value) => scrubber.known.add(value);
  if (box) {
    scrubber.known.add(box.secrets.boxKey);
    scrubber.known.add(box.secrets.threadKey);
  }
  // A box whose key the backend turns down has been superseded by a newer
  // box for its thread: it stops its CLI and exits, so the provider's
  // machine stops (docs/protocol/boxes.md, "Box mode"). `stop` is made further
  // down; one that comes before it waits for it.
  let stopRef: ((signal: string) => void) | undefined;
  let supersededWanted = false;
  const boxSuperseded = () => {
    if (supersededWanted) return;
    supersededWanted = true;
    log.warn("box: the backend turned this box's key down, so a newer box has the thread; stopping");
    stopRef?.('superseded');
  };
  // The backend's `save` (box-save.ts): its own calls, on the box key. Once
  // one starts, the thread runs nothing until the backend says it may (SaveHold).
  const boxPost = box ? convexPoster(boxBoot!.syncUrl) : undefined;
  const saveHold = box
    ? new SaveHold({
        hold: () => {
          runner.holdTurns(box.secrets.threadId, 'save');
          closeSpawns(SAVE_HOLDS_SPAWNS);
        },
        release: () => {
          openSpawns();
          runner.releaseTurns(box.secrets.threadId, 'save');
        },
        ...(box.secrets.saveHold ? { initial: box.secrets.saveHold } : {}),
        persist: (state) => setSaveHold(cfg.home, state),
      })
    : undefined;
  // A turn refused with the box's cloud token (box-token.ts): the backend is
  // told, and the thread carries on once a newer token is set.
  const tokenWatch =
    box && boxPost && saveHold
      ? new BoxTokenWatch({
          home: cfg.home,
          claudeDir: cfg.claudeMainDir,
          key: box.secrets.boxKey,
          post: boxPost as unknown as ActionPost,
          log,
          setTimeout: (fn, ms) => realClock.setTimeout(fn, ms),
          held: () => saveHold.held,
          waiting: () => runner.threads.get(box.secrets.threadId)?.rec.waitingForToken,
          markReported: () => runner.tokenRefusalReported(box.secrets.threadId),
          replaced: () => runner.tokenReplaced(box.secrets.threadId),
          superseded: (e) => {
            if (!keyRejected(e)) return false;
            boxSuperseded();
            return true;
          },
        })
      : undefined;
  if (tokenWatch) {
    runner.onBoxTokenRefused = () => tokenWatch.refused();
    runner.boxTokenSetAt = () => readBoxSecrets(cfg.home)?.tokenSetAt;
  }
  // The rest of the box stopped, categorically, before a save copies anything.
  const stopOthers = async () => {
    if (!boxProcs) throw new Error("This box can't see its processes (no /proc), so it can't stop them to save.");
    const n = await boxProcs.stopOthers();
    if (n) log.info("box: stopped the box's other processes for its save", { killed: n });
  };
  const saveBox = async (threadId: string) => {
    if (!box || !boxPost || !saveHold || threadId !== box.secrets.threadId) throw new Error("That isn't this box's thread.");
    // A degraded box saves nothing: what it has may be all there is of the work.
    if (box.broken) throw new Error(`This box can't save its thread: ${box.broken}`);
    try {
      return await saveThread({ home: cfg.home, claudeDir: cfg.claudeMainDir, threadId, threadKey: box.threadKey, boxKey: box.secrets.boxKey, quiesce: (id) => runner.quiesceForSave(id, { stopOthers }), hold: saveHold, asSave, beforeSaved: () => sync.flushAll(), post: boxPost, upload: convexUploader() });
    } catch (e) {
      if (keyRejected(e)) boxSuperseded();
      throw e;
    }
  };
  // Set once the relay is made, further down; sync's list goes through it.
  let relayRef: Relay | undefined;
  // Other runners' threads that are moving, as this (the main Mac's) runner
  // knows: one it started between two other runners, or one coming here
  // (docs/protocol/moves.md, "Moving a thread to another runner"). The backend's
  // sidebar rows don't carry it, so it's put on them for the app.
  // How long such a row shows a move this runner can't follow to its end
  // (one between two other runners): the backend fails a frozen move after
  // 30 minutes.
  const REMOTE_MOVING_MS = 35 * 60_000;
  const remoteMoving = new Map<string, { moving: ThreadMoving; from: string; until: number }>();
  const dressRemote = (r: RemoteThreads): RemoteThreads => {
    const o = relayRef?.overlay(r) ?? r;
    if (!remoteMoving.size) return o;
    const now = Date.now();
    for (const [id, m] of remoteMoving) {
      // Over once the thread is listed on the runner it went to, or here.
      const t = o.threads.find((x) => x.threadId === id);
      if (m.until < now || (t && t.runnerId !== m.from) || runner.threads.has(id)) remoteMoving.delete(id);
    }
    return { ...o, threads: o.threads.map((t) => (remoteMoving.has(t.threadId) ? { ...t, moving: remoteMoving.get(t.threadId)!.moving } : t)) };
  };
  const republishRemote = () => runner.publish({ method: 'remoteThreads.updated', params: dressRemote(sync.remoteThreads()) });
  // Set once moves are made, further down; sync leaves out what's moved away.
  let movesRef: Moves | undefined;
  // A thread here, as a move's other runner needs to know it (moves.ts).
  const describeMove = (id: string) => runner.describeForMove(id, scheduler.list(id).filter((sc) => sc.threadId === id && !sc.finishedAt).length);
  // For a preview: that, and what this runner would leave behind, which only
  // it can tell. The target's moveInfoFrom drops the extra field.
  const describeMovePreview = async (id: string) => {
    const info = await describeMove(id);
    if (!info) return info;
    const leftBehind = await runner.leftBehindByMove(id);
    if (scheduler.list(id).some((sc) => sc.threadId === id && !sc.finishedAt && sc.check)) leftBehind.push("its schedules' shell checks");
    return { ...info, leftBehind };
  };
  // Shared memory (memory-sync.ts, the sharedMemory experiment): the main
  // Mac's global CLAUDE.md and memory folders, on every runner.
  const memorySync = new MemorySync({
    home: os.homedir(),
    dataDir: cfg.home,
    on: () => experimentOn(cfg.home, 'sharedMemory'),
    claudeDirs: () => runner.safeAccounts().filter((a) => a.provider === 'claude').map((a) => a.configDir),
    codexDirs: () => runner.safeAccounts().filter((a) => a.provider === 'codex').map((a) => a.configDir),
    scrub: (text) => redactSecrets(scrubber.known.mask(text)).text,
    log,
  });
  // Made once the fixers are (below); the first heartbeats can come before.
  // Off with followMain, like the rest of following main.
  let reportedFailure: () => UpdateFailure | undefined = () => (cfg.followMain ? reportedOnDisk(cfg.home) : undefined);
  let remoteFixer: RemoteUpdateFixer | undefined;
  const sync = new ConvexSync({
    config: { ...cfg.sync, runnerId: syncRunnerId, icon: runnerIcon },
    use: new ConvexUseTally({ home: cfg.home }),
    key: syncKey,
    statePath: `${cfg.home}/sync-state.json`,
    cachePath: `${cfg.home}/sync-sent.json`,
    // A box has no one at it, and its key may call only what running its
    // thread needs (BOX_CALLS): no presence, logins, projects, schedules,
    // pools, shared memory or machine figures.
    ...(box ? {} : { presence: async () => (atMac = isAtMac(rpcServer?.appConnected() ?? false, await hidIdleMs())) }),
    appConnected: () => rpcServer?.appConnected() ?? false,
    // Virtual runners in Runs on (thread-index.ts services); never in a box.
    virtualRunners: () => !box && experimentOn(cfg.home, 'virtualRunners'),
    followProblem: () => (updaterReady ? updater.status().followProblem : undefined),
    updateFailed: () => reportedFailure(),
    // A thread past a move's switch is the other runner's: never written
    // from here again (runner/moves.ts).
    runner: {
      onNotification: (fn) =>
        runner.onNotification((n) => {
          // A thread.updated names its thread inside `thread`, the rest by threadId.
          const p = n.params as { threadId?: unknown; thread?: { id?: unknown } } | undefined;
          const id = p?.threadId ?? p?.thread?.id;
          // Its delete still goes through: sync forgets the thread as
          // sent then, rather than removing the other runner's row.
          if (typeof id === 'string' && movesRef?.gone(id) && n.method !== 'thread.deleted') return;
          fn(n);
        }),
      list: (include) => runner.list(include).filter((t) => !movesRef?.gone(t.id)),
      get: (id) => runner.get(id),
      events: (id, o) => runner.events(id, o),
      cuts: (id) => runner.cuts(id),
      ...(box
        ? {}
        : {
            listProjects: () => projects.list({ archived: true }),
            listSchedules: () => scheduler.list(),
            listAccounts: () => runner.hello().accounts,
            listPools: () => runner.listPools(),
            defaults: () => {
              const d = runner.hello().defaults;
              const models: Record<string, string> = { ...(d.models ?? {}) };
              if (d.model && !models.claude) models.claude = d.model;
              return {
                ...(d.poolId ? { poolId: d.poolId } : {}),
                ...(d.accountId ? { accountId: d.accountId } : {}),
                ...(Object.keys(models).length ? { models } : {}),
                ...(d.efforts && Object.keys(d.efforts).length ? { efforts: d.efforts } : {}),
              };
            },
          }),
      buttons: (id) => runner.listButtons(id).buttons,
    },
    // The phone's commands, through the same methods the app's RPCs use,
    // on whichever runner has the thread.
    commands: {
      ...phoneCommands(runner, peers),
      // A schedule's own runner gets its command, so the scheduler here is its.
      // Mike's, from his phone: resuming lifts a schedule's ceiling, as from the
      // app (schedules.ts, "Ceilings").
      schedule: ({ scheduleId, action }) => (action === 'run' ? scheduler.runNow(scheduleId, 'full') : scheduler.update({ scheduleId, paused: action === 'pause', ceiling: 'full' })),
      // The Mac's Move sheet asking, through the relay (threads.movePreview).
      moveDescribe: async (id) => {
        const info = await describeMovePreview(id);
        if (!info) throw new Error("That thread isn't on this runner.");
        return info;
      },
      movePreview: async (p) => {
        return runner.previewMove({ ...p, self: syncRunnerId });
      },
      // The Mac's Runners panel's Year-long token… (year-token-maker.ts); a
      // box's login is its cloud token, so not there.
      ...(box ? {} : { yearToken: (accountId: string, p: { code?: string; check?: boolean; cancel?: boolean }) => runner.yearToken(accountId, p) }),
      // The main Mac's Use a reset for a login here that it has no twin of.
      useReset: (accountId: string) => runner.useReset(accountId),
      // The main Mac's Use this Mac's Claude logins (login-share.ts): its
      // logins sealed to this runner's secrets key, set up in accounts/.
      // A box's login is its cloud token, so not there.
      ...(box ? {} : { loginsSealKey: () => runner.secrets.publicKey(), loginsShare: (logins: { email: unknown; box: unknown }[]) => takeSharedLogins(logins) }),
      // A box's one thread, under its own id, in its clone, on its one login.
      ...(box
        ? {
            create: (p: Parameters<typeof runner.create>[0]) => {
              if (box.broken) throw new Error(`This box can't start its thread: ${box.broken}`);
              return runner.createAfterModelProbe({ ...p, id: box.secrets.threadId, cwd: box.cwd, accountId: 'claude-main' });
            },
            save: saveBox,
          }
        : {}),
    },
    secretBox: runner.secrets,
    ...(box
      ? {
          box: {
            ...(box.secrets.machineId ? { machineId: box.secrets.machineId } : {}),
            superseded: boxSuperseded,
            // The backend's word that a box stopped by its save may run again.
            taken: (kind: string) => saveHold?.taken(kind),
            heard: (state: string, sentAt: number) => saveHold?.heard(state, sentAt),
            // Held by its save: its heartbeats and the save's finish make no work.
            held: () => saveHold?.held ?? false,
            saving: () => saveHold?.saving ?? false,
          },
        }
      : { sample: machineSampler(cfg.home), schedules: scheduler, pools: sharedPools, memory: memorySync, sharedUsage: usage }),
    // The sidebar's list carries what the relay has changed that the
    // backend's rows don't show yet (relay.ts overlay); made below.
    publish: (n) => {
      runner.publish(n.method === 'remoteThreads.updated' ? { ...n, params: dressRemote(n.params) } : n);
      // Another runner's followProblem comes in with these rows.
      if (n.method === 'remoteThreads.updated') {
        publishUpdates();
      }
    },
    home: cfg.home,
    // A key the backend turns down (sync.ts KEY_REJECTED): said in the app,
    // and once tb runner add has written a new one, a restart onto it.
    notice: (level, message) => runner.notice(level, message),
    readKey: () => readSyncKey(cfg.home),
    restart: (reason) => void restarter.request({ when: 'idle', reason }),
    scrubber,
    elsewhere: (id) => peers.owns(id) || peers.isArriving(id),
    elsewhereIds: () => [...peers.summaries(['inbox', 'snoozed', 'archived']).map((t) => t.id), ...peers.arrivingIds()],
    elsewhereThread: (id) => peers.find(id),
    movedAway: (id) => movesRef?.gone(id) ?? false,
    version: RUNNER_VERSION,
    release: RELEASE.release,
    startedAt,
    clock: realClock,
    log,
  });
  // A handover's draining runner may have threads waiting on a card, asked
  // for before this runner was listening. The sync listens from here but
  // writes nothing till they're read and back on their rows: another Mac's
  // view takes a card gone from the row as answered, and the thread would
  // sit needing Mike with nothing to answer (13 Nov, Peers.openCards).
  const handedOver = peers.status().length > 0;
  sync.start({ hold: handedOver });
  // A Mac waking from sleep, or a box resumed: a new websocket at once,
  // rather than a minute on a dead one (clock-jump.ts).
  const clockJumps = new ClockJumpWatch({
    onJump: (gapMs) => {
      log.info('the clock jumped: reconnecting', { gapMs });
      sync.reconnectNow('clock jumped');
      // Not a box's save hold: only the backend lets that go (box-save.ts SaveHold).
    },
  });
  clockJumps.start();
  if (handedOver) {
    try {
      sync.seedCards(await peers.openCards());
    } catch (e) {
      log.warn("could not read the draining runners' open cards", { error: String(e) });
    } finally {
      sync.release();
    }
  }
  // Counts only, and off unless runner.json asks (src/secret-check.ts).
  const secretCheck = new SecretCheck({ home: cfg.home, enabled: cfg.secretCheck === true, log });
  if (secretCheck.on) {
    secretCheck.start();
    runner.onNotification((n) => {
      if (n.method === 'thread.event') secretCheck.see(n.params.threadId, n.params.event as Parameters<SecretCheck['see']>[1]);
    });
  }
  if (swept) runner.startupNotice('info', `Stopped ${swept === 1 ? 'a process group' : `${swept} process groups`} left running by the previous runner.`);

  // launch.mjs went back to this release because a newer one kept crashing
  // at startup. Every client that says hello hears about it, not just the
  // first few minutes' worth.
  const rollback = takeRollbackNotice(cfg.home, log);
  const rolledBack = rollback?.message;
  // runner.restart: when it's time, stop the same way SIGTERM does and
  // exit 0 so launchd starts the runner again.
  restarter = new Restarter({
    runner,
    home: cfg.home,
    clock: realClock,
    log,
    release: RELEASE.release,
    branch: RELEASE.branch,
    logFile: cfg.logFile,
    rolledBack,
    rolledBackFrom: rollback?.from,
    restart: () => void stop('restart'),
    updateStatus: () => updater.status(),
    canHandOver: () => supervised() && !draining,
    handOver: (keeps) => void handOver(keeps),
    elsewhere: (id) => peers.owns(id),
  });
  const openThread = (threadId: string): boolean => {
    try {
      return !runner.get(threadId).archivedAt;
    } catch {
      return false;
    }
  };
  // A thread in the background when an update to main fails, in place of
  // a banner (fix-update.ts).
  const updateRelease = readRelease();
  const updateFixer = new UpdateFixer({
    home: cfg.home,
    log,
    // On the install's default mode (own-threads.ts).
    start: (r) => startOwnThread(runner, r, updateRelease?.checkout),
    open: openThread,
    // From the runner, not Mike: his message would clear a thread's review
    // findings and decline its open cards (runner.ts fromMike).
    send: (threadId, text) => runner.send(threadId, text, [], { queue: true, origin: 'runner' }).turnId,
    unqueue: (threadId, turnId) => runner.unqueue(threadId, turnId),
    followsOrigin: () => followOriginOn(cfg.home),
    checkout: updateRelease?.checkout,
    canReport: () => sync.reportsUpdates(),
    remoteAt: (commit) => remoteFixer?.openAt(commit),
  });
  reportedFailure = () => {
    if (!cfg.followMain) return undefined;
    updateFixer.overdue();
    return updateFixer.reported();
  };
  // On the main Mac: another runner's failed update gets its fix thread
  // here, as one it asked for would need a yes (fix-update.ts).
  const updateCheckout = updateRelease?.checkout;
  // followMain off turns this off with the rest (docs/on-your-mac.md).
  if (updateCheckout && cfg.followMain) {
    remoteFixer = new RemoteUpdateFixer({
      home: cfg.home,
      log,
      start: (r) => startOwnThread(runner, r, updateCheckout),
      open: openThread,
      // Another machine's words: never as Mike's (see updateFixer's send).
      send: (threadId, text) => runner.send(threadId, text, [], { queue: true, origin: 'runner' }).turnId,
      unqueue: (threadId, turnId) => runner.unqueue(threadId, turnId),
      onMain: (commit) => commitOnMain(updateCheckout, commit),
      before: (a, b) => commitBefore(updateCheckout, a, b),
      ownAt: (commit) => updateFixer.openAt(commit),
    });
    // Its own timer, not the app's list of other runners: that's watched
    // only while an app is connected.
    const fixer = remoteFixer;
    const lookAtFailures = async () => {
      // A runner handing over to its next release leaves it to that one.
      if (draining) return;
      const seen = await sync.readFailedRunners();
      if (seen && !draining) fixer.consider(seen.failed, seen.through);
    };
    setTimeout(() => void lookAtFailures(), 30_000).unref();
    setInterval(() => void lookAtFailures(), 2 * 60_000).unref();
  }
  // Stale desktop, worktree, iPhone and local-check build caches cleared
  // before the disk fills (build-cache-cleanup.ts, buildCacheCleanup experiment).
  const buildCacheCleaner = new BuildCacheCleaner({
    home: cfg.home,
    log,
    enabled: cfg.home === defaultHome() && !box,
    on: () => experimentOn(cfg.home, 'buildCacheCleanup'),
    records: () => [...runner.threads.values()].map((t) => t.rec),
  });
  // Follows main once this release has been marked good (below).
  const updater = new RunnerUpdater({
    home: cfg.home,
    release: updateRelease,
    enabled: cfg.followMain,
    clock: realClock,
    log,
    notice: (level, message) => runner.notice(level, message),
    // Only with a checkout to work in (a release that records one).
    onFailed: (f) => Boolean(updateRelease?.checkout) && (updateFixer.failed(f), true),
    onThrough: (commit) => updateFixer.through(commit),
    restart: (p) => restarter.request({ when: 'idle', ...p }),
    pendingRestart: () => Boolean(restarter.status().pendingRestart),
    followsOrigin: () => followOriginOn(cfg.home),
    beforeBuild: () => buildCacheCleaner.ifLow('before a build'),
    onChange: () => {
      // updaterReady: the first onChange can come before the reinstaller exists.
      if (updaterReady) reinstaller.consider();
      publishUpdates();
    },
  });
  // The LaunchAgent updating itself when it's behind main (reinstall.ts):
  // by itself, or again from the Updates panel's Update it after a failure.
  const reinstaller = new Reinstaller({
    home: cfg.home,
    checkout: updateRelease?.checkout,
    clock: realClock,
    log,
    behind: () => {
      const u = updater.status();
      return u.launcherChanged && u.launcherReason && u.launcherKey ? { reason: u.launcherReason, key: u.launcherKey } : undefined;
    },
    recheck: () => updater.recheckLauncher(),
    onChange: () => publishUpdates(),
  });
  // Mike's releases for a fork, and on Mike's own runner the tagging of
  // them (upstream.ts). Starts with the updater, once this release is good.
  const thisRelease = readRelease();
  const bootedAt = Date.now();
  // A thread every few days to bring Mike's releases in (bring-in.ts).
  const bringIn = new BringIn({
    home: cfg.home,
    clock: realClock,
    log,
    setting: () => bringInSetting(cfg.home),
    // On the install's default mode (own-threads.ts). It merges and runs
    // the checks in its worktree, then asks before landing.
    start: (r) => startOwnThread(runner, r, thisRelease?.checkout),
    open: openThread,
    send: (threadId, text) => void runner.send(threadId, text, [], { queue: true }),
    // The app's Bring Them In and Let's Discuss titles (UpdatesPanel).
    openByHand: () => runner.list(['inbox', 'snoozed']).find((t) => /^(Bring in|Discuss) Mike's release /.test(t.title))?.id,
  });
  // A thread suggesting work when a login's week is about to go unused, and
  // the Usage panel's Find work for it (spare-week.ts). Only the main Mac's
  // runner looks by itself, so two runners don't both start one, and not
  // while it hands over (handOver stops it too).
  const spareWeek = new SpareWeek({
    home: cfg.home,
    clock: realClock,
    log,
    on: () => spareWeekOn(cfg.home),
    looks: () => looksByItself({ draining, secondRunner: sync.secondRunner() }),
    accounts: () => runner.safeAccounts(),
    pools: () => runner.pools(),
    history: (since) => usageHistory.rows(since),
    open: openThread,
    ...spareWeekBinding(runner),
  });
  runner.spareWeek = spareWeek;
  if (!box) spareWeek.start();
  // The email watcher (experiment mailWatch, mail-watch.ts): new emails wake
  // the threads waiting on them, go to the threads they're about, or wait
  // on a pile that comes as one thread at set times. Only the main Mac's
  // runner looks, and never a copy of the real data dir's.
  const mailWatch = new MailWatch({
    home: cfg.home,
    clock: realClock,
    log,
    host: {
      mailThreads: () => runner.mailThreads(),
      wakeForMail: (id, text) => runner.wakeForMail(id, text),
      holdMail: (id, text, line) => runner.holdMail(id, text, line),
      send: (threadId, text, why) => {
        if (!openThread(threadId)) return false;
        runner.send(threadId, text, [], { origin: 'runner', queue: true, wakeReason: why });
        return true;
      },
      // A thread acting on an email runs on Auto, so Claude Code checks what it
      // does, as the email's words came from outside.
      start: (r) => runner.create({ text: r.text, title: r.title, cwd: r.cwd, ...(r.careful ? { permissionMode: 'auto' as const } : {}), startedBy: { kind: 'runner', label: 'Email', why: r.why } }).thread.id,
      open: openThread,
    },
    on: () => experimentOn(cfg.home, MAIL_WATCH),
    looks: () => !sync.secondRunner(),
    settings: () => peekRunnerJson(cfg.home).mailWatch,
    generate: (p) => models.generate(p),
    isPrivate: (cwd) => models.isPrivateFolder(cwd),
  });
  if (!box && !copyOfReal) mailWatch.start();
  // Agent Archive through Threadbear (agent-archive.ts, docs/agent-archive-plan.md).
  const agentArchive = new AgentArchive({
    home: cfg.home,
    log,
    on: () => experimentOn(cfg.home, ARCHIVE_EXPERIMENT),
    records: () => [...runner.threads.values()].map((t) => t.rec),
    projectTitles: () => new Map(projects.list({ archived: true }).map((p) => [p.id, p.title])),
    runnerName: () => cfg.sync.name ?? os.hostname(),
    loginDirs: () => accounts.list(),
    settings: () => peekRunnerJson(cfg.home).archive,
  });
  if (!box && !copyOfReal) agentArchive.start();
  // Recipes (recipes.ts): the main Mac's techniques worth keeping, each set
  // up by a thread of its own and switched on and off from the app.
  const recipes = new Recipes({
    home: cfg.home,
    folder: () => expandHome(peekRunnerJson(cfg.home).recipes?.folder || DEFAULT_RECIPES_FOLDER),
    now: () => realClock.now(),
    on: () => experimentOn(cfg.home, RECIPES_EXPERIMENT),
    sign: (text) => crypto.createHmac('sha256', token).update(text).digest('hex'),
    publish: () => runner.publish({ method: 'recipes.updated', params: {} }),
    experimentOn: (id) => experimentOn(cfg.home, id),
    setExperiment: (id, on) => settings.update({ experiments: { [id]: on } }),
    schedules: { list: () => scheduler.list(), update: (p) => scheduler.update(p), delete: (id) => scheduler.delete(id) },
    threads: (since) => runner.recipeRunsSince(since),
    start: (p) => runner.create({ text: p.text, title: p.title, cwd: p.cwd, worktree: false, startedBy: { kind: 'runner', label: 'Recipes', why: p.title } }).thread,
    log: (msg, extra) => log.warn(msg, extra),
  });
  recipesHabits = () => recipes.habits();
  if (!box && !copyOfReal) recipes.start();
  const upstream = new Upstream({
    home: cfg.home,
    checkout: thisRelease?.checkout,
    clock: realClock,
    log,
    publish: cfg.releases,
    // Main's tip is what this runner runs (its runner/ at least), and this
    // release has been marked good and up for a while.
    runningMainSettled: () => {
      if (!thisRelease?.checkout || !thisRelease.tree || thisRelease.dirty) return false;
      if (Date.now() - bootedAt < SETTLE_MS) return false;
      if (readState(cfg.home)?.lastGood !== thisRelease.id) return false;
      return releaseTreeAt(thisRelease.checkout, thisRelease.prefix ?? 'runner/', 'refs/heads/main') === thisRelease.tree;
    },
    // A release signed with a Touch ID key waits for Mike at the Mac, and
    // with it unlocked: over the lock screen the key signs nothing.
    atMac: async () => isAtMac(true, await hidIdleMs()) && !(await screenLocked()),
    // The weekly release key's reminder (release-delegate.ts): starred, so
    // Mike can't miss it.
    remind: (r) => {
      const id = startOwnThread(runner, r, thisRelease?.checkout);
      runner.update({ threadId: id, starred: true });
      return id;
    },
    isOpen: openThread,
    onChange: () => publishUpdates(),
    onChecked: (status) => {
      void bringIn.consider(status);
      // A fetch may have brought in releases with their changes.
      void swiftChanges.scan();
    },
    // Only asked on Mike's runner, once a day as it tags a release.
    writeNotes: async (commits) => {
      const res = await models.generate({ feature: 'release-notes', cwd: thisRelease?.checkout, system: RELEASE_NOTES_SYSTEM, prompt: commits, maxTokens: 800, strong: true });
      return res.ok ? res.value : undefined;
    },
  });
  // A fork's own changes to the old Swift app, for rebuilding in the GPUI
  // one (swift-changes.ts): a thread the first time the GPUI app connects,
  // and the Updates panel's "Not in the new app yet".
  const swiftChanges = new SwiftChanges({
    home: cfg.home,
    checkout: thisRelease?.checkout,
    clock: realClock,
    log,
    start: (r) => startOwnThread(runner, r, thisRelease?.checkout),
    open: openThread,
    onChange: () => publishUpdates(),
  });
  // runner.updates: sent when what hello's `updates` says changes.
  let lastUpdates = '';
  const runnerUpdates = (): RunnerUpdates => {
    const u = updater.status();
    const out: RunnerUpdates = { state: u.state, oldRunners: peers.status().map((d) => ({ version: d.version, threads: d.threads })) };
    if (u.commit) out.commit = u.commit.slice(0, 7);
    if (u.subject) out.subject = u.subject;
    if (u.reason) out.reason = u.reason;
    if (u.launcherChanged) out.launcherChanged = true;
    if (u.launcherReason) out.launcherReason = u.launcherReason;
    if (u.checkout) out.checkout = u.checkout;
    // This runner's reinstall stages (stops nothing), so the app can say so;
    // one from 14 Nov waited for idle and reinstalled.
    if (u.launcherChanged) out.launcherStages = true;
    const reinstall = reinstaller.status();
    if (reinstall) out.reinstall = reinstall;
    if (u.followProblem) out.followProblem = u.followProblem;
    const webRuntimeProblem = webRuntimeUpdates.problem();
    if (webRuntimeProblem) out.webRuntimeProblem = webRuntimeProblem;
    const webRuntimeNote = webRuntimeUpdates.note();
    if (webRuntimeNote) out.webRuntimeNote = webRuntimeNote;
    const behind = sync.behindRunners();
    if (behind.length) out.behindRunners = behind;
    const up = upstream.status();
    if (up.state !== 'off' || up.published) out.upstream = up;
    const swift = swiftChanges.status();
    if (swift.changes.length) out.swiftChanges = swift;
    return out;
  };
  function publishUpdates(): void {
    // Peers can call this before the updater exists (at startup).
    if (!updaterReady || draining) return;
    const updates = runnerUpdates();
    const key = JSON.stringify(updates);
    if (key === lastUpdates) return;
    lastUpdates = key;
    runner.publish({ method: 'runner.updates', params: { updates } });
  }
  const webRuntimeUpdates = new WebRuntimeUpdates({ home: cfg.home, clock: realClock, platform: process.arch === 'arm64' ? 'macosarm64' : 'macosx64', installed: () => runtimeInstalled(path.join(cfg.home, 'web-runtime')), changed: publishUpdates });
  updaterReady = true;

  runner.attachClis(updates);
  // The thread on a held Codex version: archiving or deleting it changes
  // what its Updates row says. (Here, as the runner is made after updates.)
  runner.onNotification((n) => {
    if (n.method === 'thread.updated') updates.threadChanged(n.params.thread.id);
    else if (n.method === 'thread.deleted') updates.threadChanged(n.params.threadId);
  });
  const methods = { ...restartMethods(restarter), ...scheduleMethods(scheduler), ...projectMethods(projects), ...coordinatorMethods(coordinators), ...drainProjectMethods(projects), ...librarianMethods(librarian), ...connectorsMethods(connectors), ...recipeMethods(recipes), ...settingsMethods(settings), ...instructionsMethods(instructions), ...modelMethods(models), ...devicesMethods(sync), ...usageStatsMethods({ tally, history: usageHistory, clock: realClock }), ...archiveMethods(agentArchive) };
  methods['artifacts.manage'] = (p) => {
    if (!experimentOn(cfg.home, 'artifactPublish')) return { available: false };
    if (typeof p.path !== 'string' || !path.isAbsolute(p.path) || !/\.html?$/i.test(p.path) || p.path.length > 4096) {
      throw new RpcError(ErrorCode.badParams, 'Choose a local HTML file.');
    }
    const source = crypto.createHash('sha256').update(p.path).digest('hex');
    if (p.action === 'status') return sync.manageArtifact(source, { action: 'status' });
    if (p.action === 'unpublish' && typeof p.expected === 'string') {
      return sync.manageArtifact(source, { action: p.action, expected: p.expected });
    }
    if (p.action === 'publish' && (p.expected === null || typeof p.expected === 'string') && typeof p.html === 'string' && Buffer.byteLength(p.html) <= 64 * 1024) {
      const title = Array.from(path.basename(p.path, path.extname(p.path))).slice(0, 60).join('').trim() || 'HTML page';
      return sync.manageArtifact(source, { action: p.action, expected: p.expected, title, html: p.html });
    }
    throw new RpcError(ErrorCode.badParams, 'Choose a UTF-8 HTML file up to 64 KiB.');
  };
  // runner.status carries the CLI statuses too (protocol, "runner.status").
  const restartStatus = methods['runner.status'];
  methods['runner.status'] = (p) => {
    const draining = peers.status();
    const behind = sync.behindRunners();
    return { ...(restartStatus(p) as Record<string, unknown>), ...(behind.length ? { behindRunners: behind } : {}), webRuntimeProblem: webRuntimeUpdates.problem(), clis: updates.list(), sync: sync.status(), secretCheck: secretCheck.status(), archive: agentArchive.status(), relay: relay.status(), upstream: upstream.status(), ...(draining.length ? { draining } : {}), ...(macScreen ? { macScreen: macScreen.status() } : {}) };
  };
  // tb profile (docs/protocol/connection.md, "runner.profile"): where this runner's CPU goes.
  Object.assign(methods, profileMethods(new SelfProfiler({ dir: path.join(cfg.home, 'profiles'), log })));
  // tb updates (docs/protocol/updates.md, "Mike's releases").
  methods['upstream.status'] = () => ({ upstream: upstream.status() });
  // The Updates panel's Update it (docs/protocol/updates.md, "Runner updates").
  methods['runner.reinstall'] = () => ({ reinstall: reinstaller.request() ?? null });
  // Other runners' threads, for the Mac app's sidebar (step 6 part 2).
  // `forTools`: a draining runner's agent tools (handover.ts primaryRemote),
  // given what this runner's own tools get, the wait for the rows included.
  methods['remoteThreads.list'] = (p) => {
    const tools = p.forTools === true ? remoteControl() : undefined;
    if (tools) return tools.list();
    return dressRemote(sync.remoteThreads());
  };
  // Every runner's machine figures, for the Mac app's Runners panel.
  methods['runners.stats'] = async () => ({ stats: await sync.runnerStats() });
  // Mike's runner order (docs/protocol/runners.md, "Other runners' threads"): every
  // runner's id, this one's too. The answer comes back as remoteThreads.updated.
  methods['runners.setOrder'] = async (p) => {
    const ids = (p as { runnerIds?: unknown } | undefined)?.runnerIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new RpcError(ErrorCode.badParams, 'runnerIds must be a list of runner ids');
    await sync.setRunnerOrder(ids);
    return {};
  };
  // A file here, for a Mac app showing one of this runner's threads from
  // another Mac (files.ts).
  Object.assign(methods, filesMethods());
  methods['upstream.check'] = async () => ({ upstream: await upstream.check() });
  // Mike's runner: today's release, tagged and signed now, Touch ID asked
  // at once (`tb updates publish`; publishOnce's `now`).
  methods['upstream.publish'] = async () => ({ tag: await upstream.publishOnce({ now: true }), upstream: upstream.status() });
  // The Updates panel's "Not in the new app yet" (docs/protocol/updates.md, "Your
  // changes to the old app").
  const swiftCommit = (p: unknown): string => {
    const c = (p as { commit?: unknown } | undefined)?.commit;
    if (typeof c !== 'string' || !/^[0-9a-f]{7,40}$/.test(c)) throw new RpcError(ErrorCode.badParams, 'commit must be a commit id');
    return c;
  };
  const swiftCall = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      throw new RpcError(ErrorCode.badParams, e instanceof Error ? e.message : String(e));
    }
  };
  methods['swiftChanges.list'] = async () => ({ swiftChanges: await swiftChanges.scan() });
  // With the thread itself, so the app can open it before its
  // threads.updated arrives (Windows lost that race on GitHub, 13 Nov).
  methods['swiftChanges.port'] = (p) =>
    swiftCall(async () => {
      const res = await swiftChanges.port(swiftCommit(p));
      let thread;
      try {
        thread = runner.get(res.threadId);
      } catch {
        thread = undefined;
      }
      return { ...res, ...(thread ? { thread } : {}) };
    });
  methods['swiftChanges.dismiss'] = (p) => swiftCall(() => swiftChanges.dismiss(swiftCommit(p), (p as { undo?: unknown } | undefined)?.undo === true));
  const codexMissing = updates.missingCodexNotice();
  if (codexMissing) log[codexMissing.level === 'info' ? 'info' : 'warn']('codex CLI not found', { path: updates.codexBinary() });
  // Other runners' threads through the backend, for the Mac app (relay.ts).
  const relay = (relayRef = new Relay({
    source: () => sync.relaySource(),
    remote: () => sync.remoteNow(),
    // Pictures for another runner's thread: only what media.import put in the inbox.
    readPicture: (file) => readShareImage(file, paths.inbox(cfg.home)),
    subscribed: (threadId) => rpcServer?.isSubscribed(threadId) ?? false,
    publish: (n) => rpcServer?.notifyClients(n),
    clock: realClock,
    log,
  }));
  // Use this Mac's Claude logins on another runner (login-share.ts): the
  // Runners panel's switches, the main Mac's key only.
  const loginSharer = new LoginSharer({
    file: path.join(cfg.home, 'login-share.json'),
    accounts: () => runner.safeAccounts(),
    pools: () => runner.pools(),
    claudeMainJson: cfg.claudeMainJson,
    blocked: () => {
      const src = sync.relaySource();
      if (!src) return 'Sharing logins needs sync on.';
      if (!sync.ownerKey()) return "Only the main Mac's runner shares its logins.";
      if (src.apiVersion < SHARE_LOGINS_API_VERSION) return `Sharing logins needs backend API ${SHARE_LOGINS_API_VERSION}; it's on ${src.apiVersion}. Deploy it from the main Mac.`;
      return undefined;
    },
    runner: (id) => {
      if (id === syncRunnerId) return { name: 'this Mac', online: true, self: true };
      const r = sync.remoteNow().runners.find((x) => x.id === id);
      return r ? { name: r.name, online: r.online, ...(r.box ? { box: true } : {}) } : undefined;
    },
    sealKey: (id) => relay.loginsSealKey(id),
    // Checked in LoginSharer (cleanAnswer): only what's that runner's word.
    share: async (id, logins) => (await relay.shareLogins(id, logins)) as never,
    online: async () => {
      const rows = (await sync.ownerCall('query', 'sync:runnersList', {})) as { runnerId: string; lastSeenAt: number }[] | null;
      return rows ? new Set(rows.filter((r) => Date.now() - r.lastSeenAt < 3 * 60_000).map((r) => r.runnerId)) : undefined;
    },
    setShared: async (id, add, remove) => {
      const rows = ((await sync.ownerCall('query', 'sync:runnerLogins', {})) ?? []) as { runnerId: string; live: boolean; shared: { provider: string; email: string }[] }[];
      const row = rows.find((r) => r.runnerId === id && r.live);
      // A runner on the main key needs no list.
      if (!row) return;
      const next = mergedList(row.shared, add, remove);
      // Handed over while that was read: the new runner writes it now.
      if (loginSharer.isStopped()) throw new Error('This runner handed over.');
      if (next) await sync.ownerCall('mutation', 'sync:setRunnerLogins', { runnerId: id, logins: next });
    },
    known: async (id) => {
      const rows = (await sync.ownerCall('query', 'sync:runnersList', {})) as { runnerId: string }[] | null;
      return rows ? rows.some((r) => r.runnerId === id) : undefined;
    },
    clock: realClock,
    log,
  });
  if (!copyOfReal) {
    runner.onAccountsChanged = () => void loginSharer.check();
    loginSharer.start();
  }
  methods['runners.sharedLogins'] = () => {
    const blocked = loginSharer.blocked();
    return { runners: loginSharer.list(), ...(blocked ? { blocked } : {}) };
  };
  methods['runners.shareLogins'] = async (p) => {
    const { runnerId, on } = (p ?? {}) as { runnerId?: unknown; on?: unknown };
    if (typeof runnerId !== 'string' || !runnerId || typeof on !== 'boolean') throw new RpcError(ErrorCode.badParams, 'runnerId and on, please');
    try {
      return await loginSharer.set(runnerId, on);
    } catch (e) {
      throw new RpcError(ErrorCode.badParams, (e as Error).message);
    }
  };
  // Virtual runners from the Mac (virtual-runners.ts): a thread started on
  // one, and a login's cloud token for its boxes, on the main Mac's key.
  const virtualRunners = new VirtualRunners({
    on: () => sync.virtualRunnersReady(),
    call: (kind, fn, args) => sync.ownerCall(kind, fn, args),
    accounts: () => runner.safeAccounts(),
    poolLogin: (poolId) => {
      const pool = runner.poolById(poolId);
      const logins = runner.safeAccounts().filter((a) => a.provider === 'claude' && pool?.accountIds.includes(a.id));
      const id = logins.length ? runner.pickAccount(logins, undefined) : undefined;
      return logins.find((a) => a.id === id);
    },
    claudePath: () => cfg.claudePath,
    made: (row) => relay.noteMade({ ...row, provider: 'claude', status: 'starting', needsYou: false, unread: false, lastActivityAt: row.createdAt }),
    log,
    now: () => Date.now(),
  });
  methods['cloudTokens.make'] = (p) => virtualRunners.make(String(p.login ?? ''));
  methods['cloudTokens.set'] = (p) => virtualRunners.set(String(p.login ?? ''), String(p.token ?? ''));
  methods['cloudTokens.useMac'] = (p) => virtualRunners.useMac(String(p.login ?? ''));
  methods['cloudTokens.list'] = () => virtualRunners.list();
  // Starting threads on other runners, and a runner key's requests for
  // that (docs/protocol/runners.md, "Asking another runner").
  // A request's mode as the card showed it: none is the default (full
  // access, as the card says), and one this runner doesn't know is refused
  // rather than dropped to that default (Daybreak, 7 Nov 2026).
  const permission = (m: string | undefined): PermissionMode | undefined => {
    if (m === undefined || m === '') return undefined;
    if (!isPermissionMode(m)) throw new RpcError(ErrorCode.badParams, `Unknown permission mode ${JSON.stringify(m)}, so the thread wasn't started.`);
    return m;
  };
  // Replies from threads started on other runners for threads here, passed
  // back to them (far-reports.ts).
  const farReports = new FarReports({
    file: path.join(cfg.home, 'far-reports.json'),
    // Straight from the backend: the relay knows a thread only once the
    // sidebar's list has it, which after a restart needs an app connected.
    row: async (threadId) => {
      const src = sync.relaySource();
      if (!src) throw new Error('sync is off');
      return (await src.post('query', 'relay:remoteThread', { key: src.key, threadId })) as { status: string; runnerId?: string; lastActivityAt?: string; title?: string } | null;
    },
    rows: async (threadId) => {
      const src = sync.relaySource();
      if (!src) throw new Error('sync is off');
      return ((await src.post('query', 'relay:remoteMessages', { key: src.key, threadId, limit: FAR_ROWS })) as { messages: FarRow[] }).messages;
    },
    self: () => syncRunnerId,
    runnerName: (id) => runnerNames.get(id),
    has: (id) => runner.has(id),
    // Held to the watch's ceiling (runner/ceiling.ts): the starter raised
    // above it since, Mike reads the reply instead.
    deliver: (starter, text, ceiling) => {
      runner.send(starter, text, [], { queue: true, ceiling });
    },
    // Not while sync is off, nor on a draining or stopping runner: its
    // replacement does it.
    active: () => !draining && !stopping && !runner.draining && Boolean(sync.relaySource()),
    log,
    now: () => Date.now(),
  });
  setInterval(() => void farReports.tick(), FAR_TICK_MS).unref();
  const cross = new CrossRunner({
    self: () => ({ id: syncRunnerId, name: cfg.sync.name ?? defaultRunnerName() }),
    backend: () => sync,
    runners: async () => (await scheduler.runners()).map((r) => ({ id: r.id, name: r.name, self: r.self, online: r.online })),
    createHere: async (p) => {
      const mode = permission(p.permissionMode);
      const r = await router().create({ text: p.text, ...(p.title ? { title: p.title } : {}), ...(p.cwd ? { cwd: p.cwd } : {}), ...(p.model ? { model: p.model } : {}), ...(p.effort && EFFORT_LEVELS.includes(p.effort as EffortLevel) ? { effort: p.effort as EffortLevel } : {}), ...(mode ? { permissionMode: mode } : {}), ...(p.startedBy ? { startedBy: p.startedBy } : {}) });
      return { id: r.thread.id };
    },
    createThere: async (runnerId, p) => {
      const r = (await relay.create(runnerId, { ...p })) as { thread: { id: string } };
      return { id: r.thread.id };
    },
    startedThere: (p) => farReports.add(p),
    // Its replies' ceiling: what the starter has as it asks, or the mode the
    // thread is started with if that's more (a card Mike allowed). Never
    // anything the other runner or the backend says later.
    // As the agent's own access is judged for what it may start (its saved
    // mode, not the more a running turn may still have after it was lowered).
    // Its mode as its card was shown, if less (raised while the card waited).
    ceilingFor: (starter, mode, askerMode) => {
      const saved = ceilingMode(runner.authoritySaved(starter).mode);
      return higherMode(askerMode ? lowerMode(ceilingMode(askerMode), saved) : saved, isPermissionMode(mode) ? ceilingMode(mode) : 'ask');
    },
    card: (threadId, c) => runner.requestCard(threadId, c),
    openCard: async (threadId) => {
      const src = sync.relaySource();
      if (!src) return undefined;
      const row = (await src.post('query', 'relay:remoteThread', { key: src.key, threadId })) as { pendingApproval?: { approvalId?: string } } | null;
      return row?.pendingApproval?.approvalId;
    },
    confirmStart: (row, claim) => {
      if ((sync.relaySource()?.apiVersion ?? 0) < LIVE_REQUEST_API_VERSION) {
        throw new RpcError(ErrorCode.other, 'Start it needs the updated Threadbear backend. Try again after it updates.');
      }
      return relay.confirmRequestStart(row.runnerId, row.threadId, row.requestId, row.docId, claim);
    },
    releaseStart: (row, claim) => relay.releaseRequestStart(row.runnerId, row.threadId, row.requestId, row.docId, claim),
    respondThere: async (threadId, approvalId, decision, message) => {
      await relay.call(threadId, 'approvals.respond', { threadId, approvalId, decision, ...(message ? { message } : {}) });
    },
    home: () => os.homedir(),
    realDir: (p) => {
      try {
        const real = fs.realpathSync(p);
        return isDirectory(real) ? real : undefined;
      } catch {
        return undefined;
      }
    },
  });
  crossHooks = {
    start: (threadId, req) => cross.start(threadId, req),
  };
  // Moving a thread to another runner (src/moves.ts, runner/moves.ts).
  let runnerNames = new Map<string, string>();
  const refreshNames = () =>
    void scheduler
      .runners()
      .then((rs) => (runnerNames = new Map(rs.map((r) => [r.id, r.name]))))
      .catch(() => undefined);
  runner.runnerNames = (id) => runnerNames.get(id);
  // The main Mac takes moved threads in at most Ask (runner/moves.ts).
  runner.movedInAtMostAsk = () => Boolean(sync.ownerKey());
  // A card only this runner's own app can allow is put up only while it
  // has one (app-seen.ts).
  runner.appCanAllow = () => (rpcServer?.appConnected() ?? false) || appSeen.recently();
  runner.ownName = cfg.sync.name ?? defaultRunnerName();
  // Previews shown (the Move sheet, tb move, move_thread), by the one-use
  // id threads.move takes (moves.ts MovePreviews; docs/protocol/moves.md,
  // "Preview binding").
  const previews = new MovePreviews();
  const moves = (movesRef = new Moves({
    self: () => syncRunnerId,
    backend: () => sync.movesBackend(),
    log,
    // The main Mac's runner starts every move (moveOn), so one coming here
    // must carry a binding it handed out itself.
    vouches: (expect, moveId) => !sync.ownerKey() || previews.vouches(expect, moveId),
    // A move coming here of a thread still on its old runner: its row in
    // the sidebar shows it, as S's own row shows a move going.
    seen: (row) => {
      if (row.to !== syncRunnerId || row.from === syncRunnerId || runner.threads.has(row.threadId)) return;
      const ended = row.state === 'done' || row.state === 'claimed' || ((row.state === 'failed' || row.state === 'cancelled') && Date.now() - row.updatedAt > FAILED_SHOWN_MS);
      if (ended) remoteMoving.delete(row.threadId);
      else {
        const moving: ThreadMoving = { moveId: row.moveId, to: row.to, toName: cfg.sync.name ?? defaultRunnerName(), state: row.state, ...(row.note && (row.state === 'failed' || row.state === 'cancelled') ? { note: row.note } : {}) };
        remoteMoving.set(row.threadId, { moving, from: row.from, until: row.state === 'failed' || row.state === 'cancelled' ? row.updatedAt + FAILED_SHOWN_MS : Date.now() + REMOTE_MOVING_MS });
      }
      republishRemote();
    },
    host: {
      describe: (id) => describeMove(id),
      idle: (id) => runner.moveIdle(id),
      setMoving: (id, m) => runner.setMoving(id, m),
      has: (id) => runner.threads.has(id),
      async pack(id, row) {
        const packed = await runner.packForMove(id, row);
        const keep = scheduler.list(id).filter((sc) => sc.threadId === id && !sc.finishedAt);
        if (keep.some((sc) => sc.check)) packed.leftBehind.push("Its schedules' shell checks stayed behind: set them again here if they're still wanted.");
        const carried = keep.map((sc) => ({ text: sc.text, title: sc.title, ...(sc.cron ? { cron: sc.cron } : { at: sc.at }), ...(sc.timezone ? { timezone: sc.timezone } : {}), ...(sc.paused ? { paused: true } : {}), ...(sc.createdBy ? { createdBy: sc.createdBy } : {}), ceiling: scheduler.ceilingById(sc.id) }));
        if (carried.length) packed.entries.push({ path: 'schedules.json', data: Buffer.from(JSON.stringify(carried)) });
        return packed;
      },
      async putAway(id) {
        for (const sc of scheduler.list(id).filter((sc) => sc.threadId === id)) await scheduler.delete(sc.id).catch(() => undefined);
        await runner.putAwayMoved(id);
      },
      plan: (row) => runner.planMove(row),
      place: (row, entries) => runner.placeMove(row, entries),
      placed: (row) => runner.movePlaced(row),
      async adopt(row) {
        const r = await runner.adoptMoved(row);
        // When and what each sends, nothing more (moves.ts movedSchedules).
        // Each held to the lower of the ceiling it had there and the
        // thread's saved mode as it arrives (schedules.ts, "Ceilings"): the
        // other Mac's word can only lower it, so raising the thread here
        // later pauses them for Mike.
        const here = ceilingMode(runner.authoritySaved(row.threadId).mode);
        for (const { ceiling: there, ...sc } of r.schedules ?? []) {
          await scheduler.create({ ...sc, threadId: row.threadId, ceiling: there ? lowerMode(there, here) : here }).catch((e) => log.warn("couldn't make a moved thread's schedule again", { threadId: row.threadId, error: String(e) }));
        }
      },
      discard: (row) => runner.discardMove(row),
      sealKey: () => runner.secrets.publicKey(),
      open: (sealed, info) => runner.secrets.openBytes(sealed, info),
      runnerName: (id) => runnerNames.get(id) ?? (id === syncRunnerId ? (cfg.sync.name ?? defaultRunnerName()) : id),
    },
  }));
  // The backend's version is known once sync has heard from it: until the
  // watch starts, it's tried again (start does nothing once it has).
  refreshNames();
  const movesTimer = setInterval(() => {
    refreshNames();
    moves.start();
  }, 30_000);
  movesTimer.unref();
  moves.start();
  const startedMoves = new Map<string, string>();
  const moveOn = () => {
    if (!sync.ownerKey()) throw new RpcError(ErrorCode.badParams, "Only the main Mac's runner can move a thread.");
  };
  // The thread described by the runner that has it, then planned by the
  // one it would go to, each here or through a relay `call`; with a
  // previewId when nothing stops it.
  const previewMove = async (threadId: string, to: string, cwd: string | undefined, accountId: string | undefined): Promise<Record<string, unknown>> => {
    const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const here = runner.threads.has(threadId);
    if (here && to === syncRunnerId) throw new RpcError(ErrorCode.badParams, 'The thread is on that runner already.');
    let info: unknown;
    try {
      if (here) info = await describeMovePreview(threadId);
      else if (relay.owns(threadId)) info = await relay.describeForMove(threadId);
      else throw new Error('No such thread.');
    } catch (e) {
      const older = /can't be asked of this runner/.test(said(e));
      return { accounts: [], leftBehind: [], problems: [older ? "The thread's runner runs a Threadbear from before moves. It updates itself within a few minutes of a new release." : said(e)] };
    }
    // The target only knows its own end of what won't come.
    const lines = (v: unknown) => (Array.isArray(v) ? v.filter((l): l is string => typeof l === 'string') : []);
    // As the target will have it: scrubbed, as the old runner's description
    // reaches the move's row through its own scrubber (sync.ts post) and the
    // preview reaches another runner through this one's, so a binding made
    // from it matches the one the target works out (security review,
    // 17 Nov 2026).
    const described = moveInfoFrom(info);
    const scrubbed = described && previewInfo(described, (v) => scrubber.doc(v));
    const parsed = scrubbed && moveInfoFrom(scrubbed);
    const withThisEnd = (answer: unknown): Record<string, unknown> => {
      const a = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
      const thisEnd = (info as { leftBehind?: unknown } | undefined)?.leftBehind;
      const out: Record<string, unknown> = { ...a, leftBehind: [...lines(a.leftBehind), ...lines(thisEnd)], ...(Array.isArray(thisEnd) ? { sourceChecked: true } : {}) };
      // A target from before moves were checked against their preview would
      // do whatever the move's row says: none to it until it updates.
      const problems = lines(a.problems);
      if (!problems.length && a.checksPreview !== true) out.problems = [`${runnerNames.get(to) ?? 'That runner'} runs a Threadbear from before moves were checked against what Move to showed. It updates itself within a few minutes of a new release.`];
      return previews.remember({ threadId, to, ...(cwd ? { cwd } : {}), ...(accountId ? { accountId } : {}) }, parsed, out);
    };
    try {
      if (!parsed || !scrubbed) throw new Error("The thread's runner didn't say enough about it.");
      if (to === syncRunnerId) return withThisEnd(await runner.previewMove({ info: parsed, self: syncRunnerId, ...(cwd ? { cwd } : {}), ...(accountId ? { accountId } : {}) }));
      // Through the relay: only what the target needs, scrubbed (moves.ts previewInfo).
      return withThisEnd(await relay.previewMove(to, { info: scrubbed, ...(cwd ? { cwd } : {}), ...(accountId ? { accountId } : {}) }));
    } catch (e) {
      // A runner from before moves turns the call down by name.
      const older = /can't be asked of this runner/.test(said(e));
      return { accounts: [], leftBehind: [], problems: [older ? `${runnerNames.get(to) ?? 'That runner'} runs a Threadbear from before moves. It updates itself within a few minutes of a new release.` : said(e)] };
    }
  };
  methods['threads.move'] = async (p) => {
    moveOn();
    const threadId = String(p.threadId ?? '');
    const to = String(p.runnerId ?? '');
    if (!threadId || !to) throw new RpcError(ErrorCode.badParams, 'threadId and runnerId are needed');
    const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : undefined;
    const accountId = typeof p.accountId === 'string' && p.accountId ? p.accountId : undefined;
    let expect: string;
    const picks = { threadId, to, ...(cwd ? { cwd } : {}), ...(accountId ? { accountId } : {}) };
    if (typeof p.previewId === 'string' && p.previewId) {
      // Once only, for the same thread, runner and picks it was asked with.
      try {
        expect = previews.take(p.previewId, picks);
      } catch (e) {
        throw new RpcError(ErrorCode.badParams, e instanceof Error ? e.message : String(e));
      }
    } else {
      // No preview named (the Swift app, an older tb, move_thread): one
      // now, bound the same way. A clone is shown first, so one that would
      // clone goes through the Move sheet.
      const look = await previewMove(threadId, to, cwd, accountId);
      const problems = Array.isArray(look.problems) ? (look.problems as string[]) : [];
      if (problems.length) throw new RpcError(ErrorCode.badParams, problems.join(' '));
      if (typeof look.clone === 'string') throw new RpcError(ErrorCode.badParams, `It would clone ${String(look.cloneFrom ?? 'its repo')} to ${look.clone} first: move it from the app's Move to, which shows that, or pick a folder.`);
      if (typeof look.previewId !== 'string') throw new RpcError(ErrorCode.badParams, "Couldn't see where the thread would go, so it stays where it is.");
      expect = previews.take(look.previewId, picks);
    }
    try {
      const moveId = await sync.startMove({ threadId, to, ...(cwd ? { cwd } : {}), ...(accountId ? { accountId } : {}), expect });
      previews.startedAs(expect, moveId);
      startedMoves.set(threadId, moveId);
      // Another runner's thread: its row says so at once, before either
      // runner has taken a step (cleared once it's listed elsewhere).
      const listed = runner.threads.has(threadId) ? undefined : sync.remoteThreads().threads.find((t) => t.threadId === threadId);
      if (listed) {
        const toName = to === syncRunnerId ? (cfg.sync.name ?? defaultRunnerName()) : (runnerNames.get(to) ?? to);
        remoteMoving.set(threadId, { moving: { moveId, to, toName, state: 'asking' }, from: listed.runnerId, until: Date.now() + REMOTE_MOVING_MS });
        republishRemote();
      }
      return { moveId };
    } catch (e) {
      throw new RpcError(ErrorCode.badParams, e instanceof Error ? e.message : String(e));
    }
  };
  // The Move sheet's guess (docs/protocol/moves.md, "Moving a thread to another
  // runner").
  methods['threads.movePreview'] = async (p) => {
    moveOn();
    const threadId = String(p.threadId ?? '');
    const to = String(p.runnerId ?? '');
    if (!threadId || !to) throw new RpcError(ErrorCode.badParams, 'threadId and runnerId are needed');
    const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : undefined;
    const accountId = typeof p.accountId === 'string' && p.accountId ? p.accountId : undefined;
    return previewMove(threadId, to, cwd, accountId);
  };
  methods['threads.moveCancel'] = async (p) => {
    moveOn();
    // One this runner is in, or one it started between two others.
    const threadId = String(p.threadId ?? '');
    // The app names the move it means when it cancelled one before its
    // threads.move answered: by the time the answer comes another may have
    // started, and this runner's view of which is under way can lag the
    // backend's, so that move itself is cancelled, by its id, and the backend
    // refuses if it's already over (Codex's reviews, 18 Nov).
    const named = typeof p.moveId === 'string' && p.moveId ? p.moveId : undefined;
    const moveId = named ?? moves.movingOf(threadId)?.moveId ?? startedMoves.get(threadId);
    if (!moveId) throw new RpcError(ErrorCode.badParams, "That thread isn't moving.");
    try {
      await sync.cancelMove(moveId);
    } catch (e) {
      throw new RpcError(ErrorCode.badParams, e instanceof Error ? e.message : String(e));
    }
    // Only this move's row: a named one may be over, with another showing.
    if (remoteMoving.get(threadId)?.moving.moveId === moveId && remoteMoving.delete(threadId)) republishRemote();
    return {};
  };
  methods['requests.get'] = (p) => cross.get(String(p.threadId ?? ''), String(p.approvalId ?? ''));
  methods['requests.answer'] = (p) => cross.answer(String(p.threadId ?? ''), String(p.approvalId ?? ''), p.allow === true, typeof p.runnerId === 'string' ? p.runnerId : undefined, typeof p.fingerprint === 'string' ? p.fingerprint : undefined);
  bootStep('services');
  const server = (rpcServer = new RpcServer({
    host: cfg.host,
    port: cfg.port,
    token,
    runner,
    relayMoving: (id) => {
      const m = remoteMoving.get(id);
      return Boolean(m && m.until >= Date.now() && m.moving.state !== 'failed' && m.moving.state !== 'cancelled');
    },
    log,
    clis: updates,
    methods,
    remote: peers,
    relay,
    virtualStart: (p) => virtualRunners.start(p),
    gate: new CallerGate({ runner, remote: peers, schedules: scheduler, images: runner.importQuota }),
    callerOf: (sock) => threadOfSocket(sock, { registry, known: (id) => runner.has(id) || peers.owns(id), log, own, keyOf: (id) => makeThreadKey(token, id) }),
    updates: () => (draining ? undefined : runnerUpdates()),
    appHello: (build, app) => appRestarts.appHello(build, app),
    appSeen: () => appSeen.mark(),
    desktopHello: () => void swiftChanges.desktopHello().catch((e) => log.warn('swift changes: first look failed', { error: String(e) })),
    helloNotices: () => {
      // Like a missing claude: said to every client, until it's there.
      const noCodex = updates.missingCodexNotice();
      // Pushes failing (sync.ts notePushFailing) is said once as it starts;
      // an app that wasn't connected then hears it here.
      const pushFailing = sync.status().pushFailing;
      // Near the Free plan's limits, as far as this runner can tell (convex-use.ts).
      const useWarning = sync.status().use?.warning;
      return [
        ...(useWarning ? [{ level: 'warning' as const, message: useWarning }] : []),
        ...(pushFailing ? [{ level: 'warning' as const, message: pushFailingText(pushFailing) }] : []),
        ...(rolledBack ? [{ level: 'warning' as const, message: rolledBack }] : []),
        ...(noCodex ? [noCodex] : []),
        // Stopped restarting after uncaught errors (error-exits.ts), until an hour passes without one.
        ...(guardHolds(errorExits, Date.now()) ? [{ level: 'warning' as const, message: guardNotice(errorExits) }] : []),
        ...restarter.helloNotices(),
        ...instructions.helloNotices(),
      ];
    },
  }));
  let port: number;
  try {
    ({ port } = await server.listen());
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const why = err.code === 'EADDRINUSE' ? `port ${cfg.port} is already in use` : err.message;
    log.error('could not listen', { port: cfg.port, error: why });
    process.stderr.write(`runner can't listen on ${cfg.host}:${cfg.port}: ${why}\n`);
    await registry.killAll(1000);
    process.exit(1);
  }
  recordListening(cfg.home, port, DEFAULT_CWD);
  log.info('runner listening', { url: `ws://${cfg.host}:${port}/rpc` });
  bootStep('listening');
  log.info('started in', { imports: bootImports, msSinceStart: bootSteps});
  // Tests read this line to know the runner is up.
  process.stdout.write(`threadbear-runner listening on ${port}\n`);
  tellLaunchListening();
  // Checks start a minute after this; installs never while a restart waits.
  updates.start();
  extraUpdates.start();
  if (process.platform === 'darwin' && cfg.home === defaultHome() && RELEASE.release && process.env.THREADBEAR_CLI_UPDATES !== 'off') webRuntimeUpdates.start();
  // The runner's log is held open by launchd too, so it's emptied in place.
  // The app's update log sits beside it, but only for the real data dir: a
  // dev runner's log is in its temp home.
  const stopHousekeeping = startHousekeeping({
    home: cfg.home,
    logs: [
      { file: cfg.logFile, inPlace: true },
      ...(cfg.home === defaultHome() ? [{ file: path.join(path.dirname(cfg.logFile), 'threadbear-update.log') }] : []),
    ],
    log,
  });
  // Borrowed worktrees nobody gave back (borrows.ts), on this Mac's real
  // data dir only: a dev runner's threads aren't the ones that borrowed.
  const stopBorrowSweep = cfg.home === defaultHome() && !box
    ? ((stops) => () => stops.forEach((stop) => stop()))([startBorrowSweep(runner, log), buildCacheCleaner.start()])
    : () => {};
  const cancelMarkGood = markGoodLater(cfg.home, RELEASE.release, log, process.env, () => {
    restarter.proven();
    // A box never updates itself or anything else: a new release is a new image.
    if (box) return;
    updater.start();
    reinstaller.consider();
    upstream.start();
    swiftChanges.start();
  });
  // Only once listening: a runner that can't listen exits, and the next
  // one should still find the resume.
  // Each step on its own: one that throws (a thread's record another runner
  // wrote wrong, past the boundaries each has per thread) is logged rather
  // than ending the start (security review, 11 Nov 2026, finding 96).
  const step = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      log.error(`startup step failed: ${name}`, { error: String(e) });
    }
  };
  step('resume after restart', () => restarter.resumeAfterRestart());
  step('tell stopped work', () => runner.tellStoppedWork());
  step('carry on stopped', () => runner.carryOnStopped());
  // Coordinators' hidden helpers a restart cut off (coordinators.ts).
  if (!copyOfReal && !box) step('carry on coordinator helpers', () => coordinators.carryOnAfterRestart());
  // A thread waited on may have finished while the runner was down. Only
  // now: waking one starts its CLI, whose tools need what's set up above.
  runner.holdWaits = false;
  step('reconcile waits', () => runner.reconcileWaits());
  // A wait whose latest time passed while the runner was down: its agent's
  // turn to check was held until now too (runner/hibernation.ts, armSnoozeTimer).
  step('late wake checks', () => runner.armSnoozeTimer());
  // Reports held for a thread whose threads finished while it was down.
  step('held reports', () => runner.settleAllHeld());
  // Reviews a runner that went away owed (runner/lab-review.ts).
  step('owed reviews', () => runner.startOwedReviews());
  // A box restored from a save: its worktree's setup again (box-save.ts).
  if (box && !box.broken && box.restored && !box.secrets.setUp) {
    void runner
      .setUpRestored(box.secrets.threadId)
      .then(() => markSetUp(cfg.home))
      .catch((e) => log.warn("box: couldn't set up the restored worktree", { error: String(e) }));
  }
  // A save that was holding the box when it stopped holds it again: no
  // process starts (the turns and patches were held as the thread loaded).
  if (box?.secrets.saveHold) closeSpawns(SAVE_HOLDS_SPAWNS);
  // A thread still waiting for a newer cloud token when the runner stopped watches for it again.
  tokenWatch?.start();
  // A degraded box says why on its thread (if it has one here) and runs nothing.
  if (box?.broken) runner.holdBroken(box.secrets.threadId, box.broken);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    // Leaving after an uncaught error: this process may be half way through
    // something, so the stop gets a deadline (error-exits.ts).
    if (leavingAfterError) armStopDeadline();
    cancelMarkGood();
    clockJumps.stop();
    loginSharer.stop();
    updater.stop();
    reinstaller.stop();
    upstream.stop();
    swiftChanges.stop();
    stopHousekeeping();
    stopBorrowSweep();
    log.info('runner stopping', { signal });
    // Whatever stopped it, a pending restart has now happened. A draining
    // runner's restart was the handover, which the new runner has taken.
    if (!draining) restarter.stopping();
    // A restart "now" stops the draining runners too (docs/protocol.md).
    if (signal === 'restart' && restarter.status().pendingRestart?.when === 'now') await peers.stopAll();
    peers.close();
    primaryLink?.close();
    scheduler.stop();
    // A check under way keeps what it prints for the next runner, but only
    // if this one is still here when it ends.
    // launch.mjs gives a runner 20 s after its own SIGTERM (STOP_GRACE_MS);
    // a restart of its own has no deadline.
    const checksDone = scheduler.settled(/^SIG|supervisor/.test(signal) || leavingAfterError ? 15_000 : undefined);
    librarian.stop();
    memorySync.stop();
    stuckJobs.stop();
    frozenClis.stop();
    macScreen?.stop();
    keepAwake.stop();
    connectors.stop();
    projects.stop();
    // Not after an uncaught error, which may have been a helper's doing
    // (coordinators.ts, start()).
    coordinators.stop({ graceful: !leavingAfterError });
    usage.stop();
    spareWeek.stop();
    mailWatch.stop();
    agentArchive.shutdown();
    recipes.stop();
    signIn.stop();
    tally.stop();
    webRuntimeUpdates.stop();
    updates.stop();
    extraUpdates.stop();
    // A restart's new release writes everything again under the same
    // runnerId; only a stop for good tells the phone this runner is gone.
    secretCheck.stop();
    // A superseded box's key is refused: there's no one to say bye to.
    await sync.stop({ bye: signal !== 'restart' && signal !== 'superseded' && !draining });
    try {
      await runner.shutdown();
      // A look still under way (a hung folder) would hold the exit for its time limit.
      trustWorker?.close();
      await server.close().catch(() => {});
      await drainServer?.close().catch(() => {});
      await registry.killAll(3000);
      if (draining) {
        // Kept when its unended jobs couldn't be handed on, so the next
        // start sweeps this runner's list as a draining runner's.
        if (registry.removeFile()) removeDrainInfo(cfg.home, process.pid);
      }
      await checksDone;
    } finally {
      log.info('runner stopped');
      // The error's report, which Sentry sends in the background.
      if (leavingAfterError) await flushSentry(2000);
      process.exit(exitCode);
    }
  };

  // ------------------------------------------------------------ handover
  // docs/protocol/updates.md, "Handovers". This runner keeps `keeps` (busy threads)
  // until their turns end and launch.mjs starts the current release beside
  // it, which takes everything else. The order matters: the new runner
  // must find this one's drain file, a free port and a free lock.
  let drainServer: RpcServer | undefined;
  let primaryHeard = false;
  let mailFirst = false;
  const handOver = async (busy: string[]) => {
    if (draining || stopping || mailFirst) return;
    // The new release looks at mail from here on, not both: a draining
    // runner can't start threads, so its lists failed (THREADBEAR-2G). A
    // look under way finishes first, while this runner is still the primary
    // in every way, and before the new runner is asked for (requestHandover,
    // below), so the two never look at once. One that hangs is given up
    // after three minutes, keeping what it had finished.
    mailFirst = true;
    await mailWatch.stopAndWait(180_000);
    mailFirst = false;
    if (draining || stopping) return;
    // A thread that look started or woke is busy now: it's kept like the rest.
    const keeps = [...new Set([...busy, ...restarter.busyThreads()])].filter((id) => !coordinators.forThread(id) && !coordinators.helperOwner(id));
    draining = true;
    log.info('starting the handover', { keeps });
    try {
      await coordinators.handover({ afterError: leavingAfterError });
      cancelMarkGood();
      // The new runner sends shared logins from here on, from the same file.
      loginSharer.stop();
      runner.onAccountsChanged = undefined;
      updater.stop();
      reinstaller.stop();
      upstream.stop();
      swiftChanges.stop();
      stopHousekeeping();
      stopBorrowSweep();
      scheduler.stop();
      // The new release looks at spare weeks from here on (THREADBEAR-2H).
      spareWeek.stop();
      // And keeps Agent Archive's list and builds its sync (THREADBEAR-2J).
      agentArchive.stop();
      librarian.stop();
      // stuckJobs goes on: background work can hold a thread here for hours,
      // and a wait that can never end should still be noticed. It only looks
      // at this runner's threads, so the primary's check doesn't cover them.
      frozenClis.stop();
      macScreen?.stop();
    keepAwake.stop();
      connectors.stop();
      projects.freeze();
      webRuntimeUpdates.stop();
      updates.stop();
      extraUpdates.stop();
      usage.stopWriting();
      tally.stopWriting();
      // The new release mirrors from here on.
      secretCheck.stop();
      // The new release syncs memory from here on, not both.
      memorySync.stop();
      void sync.stop();
      // The older runners it was connected to are the new primary's now:
      // it connects to every one of them, and each thread they hand over
      // must go only there (27 Oct: three runners adopted the same one).
      peers.close();
      elsewhere = undefined;
      // Every thread not kept lets go now; resolves once their CLIs exit.
      await runner.beginDrain(keeps, {
        // Only while a new runner is connected to hear it; otherwise it
        // would load the thread as after a crash.
        ready: () => primaryHeard && (drainServer?.connectedClients() ?? 0) > 0,
        onHandedOver: (threadId) => {
          // To the primary, over the drain port.
          runner.publish({ method: 'drain.handedOver', params: { threadId } });
          if (runner.keeping()?.length === 0) finishDrain();
        },
      });
      // Stopped meanwhile (the deadline after an uncaught error, a signal):
      // the stop has the runner now, so no drain port or new runner.
      if (stopping) return;
      // The new runner sweeps children.json; this one's CLIs are listed
      // apart so they're left alone.
      registry.moveTo(drainChildrenName(process.pid));
      drainServer = new RpcServer({
        host: '127.0.0.1',
        port: 0,
        token,
        runner,
        log,
        onlyOwn: true,
        // Its port is on disk too (drain-<pid>.json), so a thread's shell can
        // reach this one as well as the primary.
        gate: new CallerGate({ runner, schedules: scheduler, images: runner.importQuota }),
        callerOf: (sock) => threadOfSocket(sock, { registry, known: (id) => runner.has(id), log, own, keyOf: (id) => makeThreadKey(token, id) }),
        methods: {
          ...scheduledSendMethods(runner),
          'drain.hello': () => {
            primaryHeard = true;
            // After this answer, so the primary has subscribed first.
            setTimeout(() => runner.recheckHandovers(), 1000);
            return { pid: process.pid, version: RUNNER_VERSION, release: RELEASE.release, threads: runner.keeping() ?? [] };
          },
          'drain.confirmRequestStart': (p) => runner.confirmRequestStart(String(p.threadId ?? ''), String(p.approvalId ?? ''), String(p.claim ?? ''), p.release === true),
          'drain.openCards': async (p) => {
            if (typeof p.threadId !== 'string') throw new RpcError(ErrorCode.badParams, 'threadId must be a string');
            return { events: await runner.openCards(p.threadId) };
          },
          'drain.stop': () => {
            setImmediate(() => void stop('drain.stop'));
            return {};
          },
          'runner.status': (p) => ({ ...(restartStatus(p) as Record<string, unknown>), draining: true, keeping: runner.keeping() }),
        },
      });
      const { port: drainPort } = await drainServer.listen();
      if (stopping) {
        await drainServer.close().catch(() => {});
        return;
      }
      writeDrainInfo(cfg.home, { pid: process.pid, port: drainPort, version: RUNNER_VERSION, release: RELEASE.release, since: new Date().toISOString(), threads: runner.keeping() ?? [], auth: 'challenge' });
      await server.close().catch(() => {});
      lock.release();
      // The agent tools reach the new runner over the port from here.
      primaryLink = new PrimaryLink(cfg.host, cfg.port, token);
      elsewhere = primaryElsewhere(primaryLink, runner);
      log.info('draining', { port: drainPort, keeps: runner.keeping() });
    } catch (e) {
      log.error('could not hand over; restarting instead', { error: (e as Error)?.stack ?? String(e) });
      void stop('restart');
      return;
    }
    // From here launch.mjs may start the new runner, so the deadline after
    // an error leaves this handover alone.
    newRunnerUp = true;
    const reply = await requestHandover();
    if (!reply.ok) {
      // Nothing can start the new runner, and this one no longer listens on
      // the port: restart the old way, which ends the kept turns.
      log.error('launch.mjs would not start the new runner; restarting instead', { error: reply.error });
      void stop('restart');
      return;
    }
    log.info('the new runner is starting', { pid: reply.pid });
    if (runner.keeping()?.length === 0) finishDrain();
  };
  // Every kept thread has gone across: nothing left to do here.
  let finishing = false;
  const finishDrain = () => {
    if (finishing) return;
    finishing = true;
    log.info('handed every thread over; exiting');
    // A moment for the last drain.handedOver to reach the primary.
    setTimeout(() => void stop('drained'), 500);
  };
  stopRef = (signal) => void stop(signal);
  if (supersededWanted) void stop('superseded');
  // The supervisor is gone: nothing would restart this runner, and its
  // children would be orphans.
  onSupervisorGone(() => void stop('supervisor gone'));
  onStopRequest(() => void stop('asked to stop'));
  // Windows: the helper peer identity asks (win32-helper.ts) starts now,
  // so the first connection's lookup doesn't wait on PowerShell starting.
  if (process.platform === 'win32') void win32Helper().ask('ping').catch(() => {});
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGHUP', () => void stop('SIGHUP'));
  // An uncaught error: logged and reported, then the runner leaves the way a
  // planned restart does (Mike, 21 Nov 2026: after one the process may be
  // half way through something), unless nothing would start it again or
  // the guard against a restart loop holds (error-exits.ts).
  const mode = errorMode({ supervised: supervised(), devRunner: errorEnv.devRunner });
  const onUncaught = (kind: 'uncaught exception' | 'unhandled rejection', e: unknown) => {
    try {
      log.error(kind, { error: (e as Error)?.stack ?? String(e) });
      reportException(e, kind);
    } catch {
      // nothing more to say it with
    }
    try {
      leaveAfterError();
    } catch (err) {
      // Never a throw out of here, which would come straight back.
      try {
        log.error('could not act on an uncaught error', { error: String(err) });
      } catch {
        // the log is what failed
      }
      if (leavingAfterError && !stopping) void stop('restart');
    }
  };
  const leaveAfterError = () => {
    if (mode === 'carry on') {
      log.warn('nothing would start this runner again, so it carries on after the error');
      return;
    }
    // Already stopping (for this or anything else): the stop goes on, with
    // a deadline now.
    if (stopping) {
      leavingAfterError = true;
      // A dev runner's code says not to start it again, whatever stop it was.
      if (mode === 'exit') exitCode = ERROR_EXIT_CODE;
      armStopDeadline();
      log.warn('an uncaught error while stopping; the stop goes on');
      return;
    }
    // Finishing turns after a handover (a deploy's or an error's): a new
    // runner already serves everything else, and stopping now would cut
    // these turns and drop their queued messages, which a deploy keeps. The
    // drain ends as a deploy's does.
    if (draining) {
      log.warn('an uncaught error while finishing turns after a handover; the handover goes on');
      return;
    }
    // Already leaving (this error's restart or a deploy's, under way or
    // about to hand over): no new restart, and no stop that would cut the
    // turns a handover keeps. A leave that hangs has its own deadline.
    if (leavingAfterError || mailFirst || restarter.underway) {
      // Its stop still gets the deadline and Sentry's flush, and a dev
      // runner's its code.
      leavingAfterError = true;
      if (mode === 'exit') exitCode = ERROR_EXIT_CODE;
      log.warn('an uncaught error while the runner is already restarting; the restart goes on');
      return;
    }
    // A dev runner stops whatever the count, so the error is seen.
    if (mode === 'exit') {
      leavingAfterError = true;
      exitCode = ERROR_EXIT_CODE;
      log.error(`exiting after an uncaught error with code ${ERROR_EXIT_CODE}: a dev runner, so nothing starts it again`);
      void stop('uncaught error');
      return;
    }
    const d = decideErrorExit(errorExits, Date.now());
    let saved = true;
    try {
      writeErrorExits(cfg.home, d.state);
      errorExits = d.state;
    } catch (err) {
      saved = false;
      log.warn('could not save run/error-exits.json', { error: String(err) });
    }
    // Uncounted, a restart could loop for ever: launch.mjs doesn't count
    // clean exits either. So no count, no restart.
    if (!d.exit || !saved) {
      if (!saved) log.warn("carrying on after an uncaught error: the restart guard's count couldn't be saved");
      else if (d.tripped) {
        log.warn('stopped restarting for uncaught errors: too many restarts for them lately; carrying on until an hour passes without one', { restarts: d.state.exits.length });
        runner.notice('warning', guardNotice(d.state));
      } else log.warn('carrying on after an uncaught error: the restart guard holds', { errors: d.state.tripped?.errors });
      return;
    }
    leavingAfterError = true;
    log.warn('restarting after an uncaught error', { restarts: d.state.exits.length });
    // runner.restart's own path, as a deploy's: busy threads finish their
    // turns here while launch.mjs starts the new runner beside it (a
    // handover), and with none busy it stops and is started again. Exit 0,
    // as a planned restart: launch.mjs starts it again in half a second on
    // every platform, where a failing code leaves it to launchd, systemd or
    // the Scheduled Task (a minute on Windows); the guard above stands in
    // for launch.mjs's crash count.
    restarter.request({ when: 'idle', reason: 'An unexpected error (see the runner log)' });
    // A handover that never gets as far as starting the new runner (a CLI
    // that won't let go, a mail look past its time) would leave this
    // process holding the port with its services stopped: stop instead.
    setTimeout(() => {
      if (stopping || newRunnerUp) return;
      log.error(`the restart after an uncaught error hadn't begun after ${ERROR_LEAVE_DEADLINE_MS / 60_000} minutes; stopping now`);
      void stop('restart');
    }, ERROR_LEAVE_DEADLINE_MS).unref();
  };
  process.on('uncaughtException', (e) => onUncaught('uncaught exception', e));
  process.on('unhandledRejection', (e) => onUncaught('unhandled rejection', e));
  // Test-only: throws one on purpose, from a checkout on a temp data dir
  // (error-exits.ts testThrow), never on an installed runner.
  const hook = testThrow(errorEnv.hookEnv, { release: RELEASE.release, home: cfg.home, realHome: defaultHome() });
  if (hook) {
    log.warn('test hook: throwing on purpose', { kind: hook.kind, afterMs: hook.afterMs });
    setTimeout(() => {
      const e = new Error(`test: an unhandled ${hook.kind} (THREADBEAR_TEST_THROW)`);
      if (hook.kind === 'exception') throw e;
      void (async () => {
        throw e;
      })();
    }, hook.afterMs);
  }
  // Last resort if the process exits some other way: kill the CLI groups
  // synchronously so they never outlive the runner.
  process.on('exit', () => {
    for (const pid of registry.pids()) killGroup(pid, 'SIGKILL');
  });
}

main().catch(async (e) => {
  if (e instanceof RunnerJsonError) {
    // Mike's own setup to fix, not a bug: said plainly in the log (launchd
    // sends stderr there; tb logs shows it), with no stack and nothing sent
    // to Sentry, as the parse error can quote the file. EX_CONFIG.
    process.stderr.write(`${new Date().toISOString()} ERROR runner failed to start: ${e.message}\n`);
    // Under launch.mjs's child supervision it records the boot just after
    // the spawn, so wait for it; the launcher from before that runs the
    // runner in its own process and recorded it already, under this pid.
    await markConfigStop(path.dirname(e.file), process.pid, supervised() ? 3000 : 0);
    process.exit(78);
  }
  process.stderr.write(`runner failed to start: ${e?.stack ?? e}\n`);
  reportException(e, 'runner failed to start');
  await flushSentry();
  process.exit(1);
});
