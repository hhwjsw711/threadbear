import Foundation
import Observation
import SwiftUI
import ThreadbearKit
import UIKit

/// The app's live state: who it's paired with, the runners and the three
/// thread lists, each a Convex subscription kept open while the app runs.
@MainActor @Observable
final class AppModel {
    private(set) var pairing: Pairing?
    private(set) var backend: (any Backend)?
    private(set) var runners: [PhoneRunner] = []
    /// The projects by runner and id (projectKey), for the rows' icons
    /// (backend API 5 carries them). A project id is only its runner's own:
    /// another runner can use the same one, so a thread's project is looked
    /// up under the thread's own runner (Daybreak finding 141).
    private(set) var projects: [String: PhoneProject] = [:]
    /// The logins and their models (backend API 20), for the new thread pickers.
    private(set) var accounts: [PhoneAccount] = []
    /// The Pocket's cards, from the file until the backend answers, so they
    /// show with no signal.
    private(set) var pocket: [PocketCard] = []
    var showsPocket: Bool { isFake || !pocket.isEmpty || (apiVersion ?? 0) >= BackendCompatibility.pocketAPIVersion }
    /// The newest card's time when the Pocket was last open, for the badge
    /// on its button. Kept on this phone only: it's about what this phone has shown.
    private var pocketSeenUpTo = UserDefaults.standard.string(forKey: "pocketSeenUpTo")
    var pocketHasNew: Bool { PocketDeck.hasNew(pocket, seenUpTo: pocketSeenUpTo) }
    /// `-ThreadbearPocket`: start with the Pocket open, for screenshots and
    /// for checking it on the phone, where nothing can tap the button.
    var opensPocketAtLaunch = false
    var opensSettingsAtLaunch = false
    /// `-ThreadbearOpenModelPicker`: open the model picker sheet on launch, for screenshots.
    var opensModelPickerAtLaunch = false
    /// `-ThreadbearExpandLogin`: expand the Login footer inside the model picker sheet.
    var expandsLoginAtLaunch = false
    /// `-ThreadbearRunnerOrder`: Settings' runner order screen, for screenshots.
    let opensRunnerOrderAtLaunch = ProcessInfo.processInfo.arguments.contains("-ThreadbearRunnerOrder")
    private(set) var inbox: [PhoneThread] = []
    /// Optimistic thread model/pool/effort/login changes until Convex catches up or the runner refuses.
    private var pendingSettings: [String: [ThreadSettingsChange]] = [:]
    /// Every command sent from this phone and waited on (archive, hibernate,
    /// rename, star, wake, mark read, bring back, Stop, reply buttons, card
    /// answers), by what it's about: the one place a control reads whether
    /// it's on its way, done, refused or timed out (PendingCommand). An
    /// archived row stays out of the lists while its archive `holdsChange`,
    /// which waits for the Mac if it's asleep.
    let commands = PendingCommands()
    /// Rows sliding off the inbox on their way out (`archive`): the animation only.
    private(set) var slidingOff: Set<String> = []
    /// Whether a thread's page is over the inbox (InboxView says).
    @ObservationIgnored var threadOpen = false
    /// Hibernates asked for whose row hasn't started to sink yet (`hibernate`).
    @ObservationIgnored private var startingHibernate: Set<String> = []
    /// Bumped on each unpair and leaving the demo, so a hibernate waiting on
    /// its animation then lets go rather than tucking the old pairing's row.
    @ObservationIgnored private var connectionEpoch = 0
    /// Rows sinking towards the Hibernating heading on their way out (`hibernate`): the animation only.
    private(set) var sinking: Set<String> = []
    /// Hibernated from this phone, kept out of the lists and on the heading's
    /// count until Convex catches up. The command itself is in `commands`;
    /// this is the heading's count, which the lists catch up with separately.
    private(set) var tucks = Tucks()
    /// He's just taken the last row away, for the empty view to wave.
    private var inboxCleared = InboxCleared()
    var inboxJustCleared: Bool { inboxCleared.isPending(now: .now) }
    private(set) var hibernating: [PhoneThread] = []
    private(set) var den: [PhoneThread] = []
    /// For each thread a schedule will message, the one due soonest: the
    /// inbox's Waiting section.
    private(set) var wakes: [String: PhoneSchedule] = [:]
    /// How many are hibernating and archived (backend API 16), for the
    /// folded headings. Nil on an older backend.
    private(set) var counts: PhoneCounts?
    /// Which headings are folded, remembered across launches.
    private(set) var folds = SectionFolds(saved: UserDefaults.standard.stringArray(forKey: "foldedSections"))
    /// A search is on: it looks in the put-away lists too, so they load.
    private(set) var searching = false
    /// The live thread lists, one subscription per view that's wanted
    /// (`folds.views`). A folded Hibernating or Archived has none.
    private var listTasks: [ThreadsView: Task<Void, Never>] = [:]
    /// The lists that have had their first answer from Convex. Until then
    /// a list is loading, not empty: saying "Nothing in the inbox" at
    /// launch, before anything had arrived, read as if it was (Mike, 30 Oct).
    private(set) var loaded: Set<ThreadsView> = []
    private(set) var connected = true
    /// The token was refused (expired or revoked): the app shows pairing again.
    private(set) var authProblem: String?
    private(set) var lastError: String?
    /// Set when the Mac's backend is older than this app needs.
    private(set) var backendProblem: String?
    /// The backend's API version once phone:me has answered (nil before).
    private(set) var apiVersion: Int?
    /// The website's address as phone:me says it, for share links (nil
    /// before it answers, and from a backend that doesn't say).
    private var siteSaid: String?
    /// Whether threads read phone:messages (API 2) rather than phone:thread's
    /// newest 20 plus the runner's paging.
    var hasMessagePages: Bool { (apiVersion ?? 0) >= BackendCompatibility.messagePagesAPIVersion }
    /// Whether to ask for the lines a thread writes when its login runs out
    /// (role `note`): an older backend refuses the argument.
    var hasDesignReviews: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.designReviewsAPIVersion }
    /// Whether a review's answer can carry the phone's own marks (API 106).
    var hasReviewMarks: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.reviewMarksAPIVersion }
    var hasLoginNotes: Bool { (apiVersion ?? 0) >= BackendCompatibility.loginNotesAPIVersion }

    /// Archived threads past the den's newest 100 with these words in
    /// (API 16), and from API 74 any thread with one in any message. Empty
    /// from an older backend, or when the call fails: the search still
    /// shows what the phone has, so a failure isn't worth a toast.
    func searchOlderArchived(_ text: String) async -> [PhoneThread] {
        guard let backend, (apiVersion ?? 0) >= BackendCompatibility.searchAPIVersion else { return [] }
        let everywhere = (apiVersion ?? 0) >= BackendCompatibility.searchEverywhereAPIVersion
        return (try? await backend.search(text, everywhere: everywhere)) ?? []
    }
    /// When this phone is notified, kept on the phone and sent to the backend
    /// with each registration and change (API 3).
    private(set) var notifyMode: NotifyMode = NotifyMode(rawValue: UserDefaults.standard.string(forKey: "notifyMode") ?? "") ?? .away
    /// The setting shows once the backend takes it and notifications are on.
    var canChooseNotifications: Bool {
        !isFake && apnsToken != nil && (apiVersion ?? 0) >= BackendCompatibility.notificationSettingAPIVersion
    }

    /// Whether to ask for notification permission. Only a backend that says
    /// it can't send any stops it: one that can't be reached right now is
    /// asked about as ever.
    func backendSendsNotifications() async -> Bool {
        guard let backend, let identity = try? await backend.me() else { return true }
        return identity.sendsNotifications
    }

    func setNotifyMode(_ mode: NotifyMode) {
        notifyMode = mode
        UserDefaults.standard.set(mode.rawValue, forKey: "notifyMode")
        guard let backend, let apnsToken, !isFake else { return }
        Task {
            do { try await backend.setNotifications(apnsToken: apnsToken, notify: mode) } catch {
                self.lastError = "Couldn't change notifications: \(error.localizedDescription)"
            }
        }
    }
    /// The thread open on screen with the app in front, or left (`open`
    /// false): no push for it comes to this phone meanwhile (phone:setViewing).
    /// Each waits for the one before, so a clear can't overtake the open
    /// after it. Quiet on failure: at worst a push comes.
    func viewing(_ threadId: String, open: Bool) {
        guard let backend, let apnsToken, !isFake else { return }
        let before = viewingSend
        viewingSend = Task {
            await before?.value
            try? await backend.setViewing(apnsToken: apnsToken, threadId: threadId, open: open)
        }
    }
    @ObservationIgnored private var viewingSend: Task<Void, Never>?

    /// Ticks every 15 s so "5m" and "Mac offline" stay right.
    private(set) var now = Date.now
    /// A thread a notification tap asked for, for the inbox to open.
    var openThreadId: String?
    /// `-ThreadbearCompose <text>` (Debug only): open New thread with this
    /// typed in, for the screenshots.
    var composeText: String?
    /// `-ThreadbearDraft <text>` (Debug only): start the open thread's reply
    /// box with this typed in ("/co" shows the slash command palette).
    var draftText: String?
    /// `-ThreadbearClip <text>` (Debug only): plays starting a thread, for
    /// filming, as nothing can tap the simulator. New thread opens, the words
    /// type in, then Start; each step prints "CLIP <step> <time>" so taps can
    /// be drawn where they happened. NewThreadView follows these two.
    var clipTyped: String?
    var clipStartTaps = 0
    /// `-ThreadbearSearch <text>` (Debug only): start with this in the
    /// inbox's search, for the screenshots.
    var searchText: String?
    /// `-ThreadbearScrollTo <threadId>` (Debug only): start with the inbox
    /// scrolled to this row, for seeing the headings stick.
    var scrollToThreadId: String?
    /// `-ThreadbearPhoto <path>` (Debug only): start the composers with this
    /// photo, for the screenshots, as nothing can tap the system picker.
    /// With `-ThreadbearSlowPhoto` it takes a few seconds, to see the spinner tile.
    var loadSamplePhoto: (@Sendable () async -> Data?)?

    /// Whether this backend takes photos. The demo does, so App Review sees it.
    var canStar: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.starsAPIVersion }
    /// Whether a thread can be shared by link from here (backend API 8, phone:share).
    var canShare: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.shareAPIVersion }
    /// Where a shared thread's link goes: the website (ThreadSharing.site).
    var shareSite: URL? { ThreadSharing.site(said: siteSaid, deploymentURL: pairing?.deploymentURL) }
    var canSendPhotos: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.photosAPIVersion }
    /// Whether a secret card can be answered here (backend API 35, phone:secret).
    var canAnswerSecrets: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.secretsAPIVersion }
    /// Whether messages waiting for their runner can be listed and cancelled
    /// (backend API 57, phone:waiting and phone:cancel).
    var canSeeWaiting: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.waitingSendsAPIVersion }
    /// Whether the reply box's slash command palette can ask the runner
    /// for a thread's list (backend API 62, phone:slashCommands).
    var canUseSlashCommands: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.slashCommandsAPIVersion }
    var canStop: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.stopAPIVersion }
    /// Whether an existing thread's model, effort, pool or login can be changed
    /// from the phone (backend API 106).
    var canChangeThreadSettings: Bool { isFake || (apiVersion ?? 0) >= BackendCompatibility.mobilePickerAPIVersion }

    func runner(for runnerId: String?) -> PhoneRunner? {
        if let runnerId, let found = runners.first(where: { $0.runnerId == runnerId }) { return found }
        return NewThreadChoices.runner(runners, now: now) ?? runners.first
    }

    func modelPickerContext(for thread: PhoneThread) -> ModelPickerContext {
        ModelPickerContext.forThread(thread, runner: runner(for: thread.runnerId), accounts: accounts)
    }

    func newThreadPickerContext(settings: NewThreadSettings, runnerId: String?) -> ModelPickerContext {
        ModelPickerContext.forNewThread(settings: settings, runner: runner(for: runnerId), accounts: accounts, now: now)
    }

    func isChangingSettings(_ threadId: String) -> Bool {
        commands[.settings(threadId)].locked
    }

    /// Changes a thread's model, effort, pool or login optimistically (`shown`),
    /// rolling back with an error if the runner refuses it.
    func updateSettings(threadId: String, change: ThreadSettingsChange) {
        guard backend != nil, canChangeThreadSettings else { return }
        let key = CommandKey.settings(threadId)
        if commands[key].holdsChange {
            pendingSettings[threadId, default: []].append(change)
            commands.forget(key)
        } else {
            pendingSettings[threadId] = [change]
        }
        let started = commands.start(key, send: { try await $0.update(threadId: threadId, change: .settings(change)) }) { [weak self] state in
            if !state.holdsChange {
                self?.pendingSettings.removeValue(forKey: threadId)
            }
            self?.said(state, failing: "The runner couldn't change that thread's model.")
        }
        if !started {
            pendingSettings.removeValue(forKey: threadId)
        }
    }
    /// Each thread's slash commands once its runner has answered (SlashPaletteList).
    var slashCommands: [String: [SlashCommand]] = [:]
    /// Why a thread's list didn't come: its runner is away, or it failed.
    var slashCommandsProblem: [String: String] = [:]
    @ObservationIgnored private var slashLoading: Set<String> = []
    /// The commands picked from the palette lately, newest first.
    var recentSlashCommands: [String] = UserDefaults.standard.stringArray(forKey: "recentSlashCommands") ?? [] {
        didSet { UserDefaults.standard.set(recentSlashCommands, forKey: "recentSlashCommands") }
    }

    /// Asks the thread's runner for its commands when the palette opens,
    /// once at a time. Kept for the session: a folder's skills change
    /// rarely, and the runner keeps its own copy fresh. A runner that's
    /// away leaves the command waiting; after a while the palette says so.
    func loadSlashCommands(_ threadId: String) {
        guard canUseSlashCommands, let backend, slashCommands[threadId] == nil, !slashLoading.contains(threadId) else { return }
        slashLoading.insert(threadId)
        slashCommandsProblem[threadId] = nil
        Task { [weak self] in
            defer { self?.slashLoading.remove(threadId) }
            do {
                let commandId = try await backend.slashCommands(threadId: threadId)
                let list: [SlashCommand]? = try await withThrowingTaskGroup(of: [SlashCommand]?.self) { group in
                    group.addTask {
                        for try await status in backend.command(commandId) {
                            if status?.state == .done { return status?.commands ?? [] }
                            if status?.state == .failed { throw TransportError.server(status?.note ?? "The runner couldn't list them.") }
                        }
                        return nil
                    }
                    group.addTask {
                        try await Task.sleep(for: .seconds(20))
                        return nil
                    }
                    let first = try await group.next() ?? nil
                    group.cancelAll()
                    return first
                }
                if let list { self?.slashCommands[threadId] = list }
                else { self?.slashCommandsProblem[threadId] = "Its Mac hasn't answered yet. You can still type a command and send it." }
            } catch {
                self?.slashCommandsProblem[threadId] = "Couldn't get its commands: \(error.localizedDescription)"
            }
        }
    }

    /// The thread's own runner by name while it's offline. Not offlineText,
    /// which only speaks up once every runner is: with Bruce and the cloud
    /// box always up, a message to the sleeping M5 just said "Sending…".
    func offlineRunner(of thread: PhoneThread) -> String? {
        WaitingSends.offlineRunner(thread.runnerId, in: runners, at: now)
    }
    /// The demo's kept runner keys, in memory so it never writes the keychain,
    /// with the sample Mac's as if it came in a pairing link.
    private let demoRunnerKeys = MemoryRunnerKeyStore(FakeBackend.sampleRunnerKeys)
    /// Where the runner keys a secret may be sealed to are kept
    /// (docs/protocol/threads.md, "Trusting the key"), per paired deployment.
    var runnerKeys: any RunnerKeyStore {
        guard !isFake, let pairing else { return demoRunnerKeys }
        return Self.runnerKeys(for: pairing)
    }
    private static func runnerKeys(for pairing: Pairing) -> KeychainRunnerKeyStore {
        KeychainRunnerKeyStore(scope: Pairing.serverName(pairing.deploymentURL))
    }
    /// Threads whose runner is already pinned this session, so a list
    /// arriving doesn't go to the keychain for every row each time.
    private var pinnedThreads = Set<String>()

    /// Pins each listed thread's runner the first time it's seen
    /// (RunnerKeyPins.noteThreads), so a secret card on a thread the
    /// backend later moves to another runner id is refused.
    private func pinRunners(_ list: [PhoneThread]) {
        let fresh = list.filter { !pinnedThreads.contains($0.threadId) }
        guard !fresh.isEmpty else { return }
        RunnerKeyPins.noteThreads(fresh.map { ($0.threadId, $0.runnerId) }, in: runnerKeys)
        pinnedThreads.formUnion(fresh.map(\.threadId))
    }

    /// The models a new thread can start on; empty hides the pickers, as an
    /// older backend would turn an effort down.
    /// The models a new thread on this runner can start on (nil: any runner's).
    func newThreadModels(on runnerId: String?) -> [PhoneModelChoice] {
        isFake || (apiVersion ?? 0) >= BackendCompatibility.modelsAPIVersion ? NewThreadChoices.models(accounts, runnerId: runnerId) : []
    }

    /// Whether there's a runner to choose (backend API 56, which lists them
    /// in Mike's order and keeps one he sets).
    var canChooseRunner: Bool {
        runners.count > 1 && (isFake || (apiVersion ?? 0) >= BackendCompatibility.runnerOrderAPIVersion)
    }

    /// The order last dragged to, until the backend's list comes back in it:
    /// a heartbeat's update in between would otherwise snap the list back,
    /// and the next drag would move the wrong row.
    private var pendingRunnerOrder: [String]?

    /// Puts the runners in this order, here at once and then on the backend,
    /// whose list then comes back the same.
    func setRunnerOrder(_ order: [PhoneRunner]) {
        let ids = order.map(\.runnerId)
        pendingRunnerOrder = ids
        runners = order.map { var r = $0; r.placed = true; return r }
        guard let backend else { return }
        Task {
            do { try await backend.setRunnerOrder(ids) } catch {
                if self.pendingRunnerOrder == ids { self.pendingRunnerOrder = nil }
                self.lastError = "Couldn't save the runner order: \(error.localizedDescription)"
            }
        }
    }

    /// The backend's runners, kept in a dragged order it hasn't caught up with.
    private func receiveRunners(_ list: [PhoneRunner]) {
        guard let pending = pendingRunnerOrder else { runners = list; return }
        // Caught up once its own runners come back in that order; one that's
        // first heartbeated meanwhile is only added at the end.
        if list.map(\.runnerId).filter(pending.contains) == pending.filter(list.map(\.runnerId).contains) {
            pendingRunnerOrder = nil
            runners = list
            return
        }
        let rank = { (r: PhoneRunner) in pending.firstIndex(of: r.runnerId) ?? pending.count }
        runners = list.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map {
            var r = $0.element
            if pending.contains(r.runnerId) { r.placed = true }
            return r
        }
    }

    /// Starts a photo on its way to file storage, if it isn't already. Done
    /// as soon as it's picked, so that Send usually has nothing to wait for.
    /// One started on a connection that's since been replaced (comingBack)
    /// goes again, as its mutation may never answer.
    func startUpload(_ photo: PickedPhoto) {
        guard let backend, photo.upload == nil || photo.uploadConnection != connection else { return }
        let jpeg = photo.jpeg
        photo.uploadConnection = connection
        photo.upload = PhotoUpload(
            upload: { try await backend.uploadPhoto(jpeg) },
            discard: { try? await backend.discardPhoto($0) })
    }

    /// Waits for the photos to be up and returns the storage ids, in order.
    func upload(_ photos: [PickedPhoto]) async throws -> [String] {
        guard backend != nil else { throw TransportError.server("Not connected.") }
        // All of them at once, whatever's left to go.
        photos.forEach(startUpload)
        var ids: [String] = []
        for photo in photos {
            guard let upload = photo.upload else { continue }
            do {
                ids.append(try await upload.storageId)
            } catch {
                // It may have failed back when it was picked, with the signal
                // since come back, so a send gets one fresh try of its own.
                photo.upload = nil
                startUpload(photo)
                do {
                    guard let again = photo.upload else { throw error }
                    ids.append(try await again.storageId)
                } catch {
                    photo.upload = nil
                    throw error
                }
            }
        }
        return ids
    }

    /// They've gone with a message, so they're the backend's to delete now.
    func sent(_ photos: [PickedPhoto]) {
        for photo in photos { photo.upload?.keep() }
    }

    // MARK: Starting threads

    /// New threads asked for from this phone that their runner hasn't made
    /// yet, newest first. The sheet closes as soon as the backend has the
    /// request, and these stand in for them at the top of the inbox: the
    /// runner reports a new thread only once its row is in Convex, which
    /// waits behind any sync it's in the middle of, and on 7 Nov the sheet's
    /// spinner sat there 22 seconds after the M5's runner had restarted.
    private(set) var starting: [StartingThread] = []
    private var startingTasks: [String: Task<Void, Never>] = [:]
    /// A thread that started soon after it was asked for, for the inbox to
    /// open as the sheet used to. One that took longer (its Mac was asleep)
    /// just turns up in the list, rather than pulling you out of what you're on.
    var justStarted: (commandId: String, threadId: String)?
    /// A failed start's sheet, to open again as it was (AppModel.retryStarting).
    var retryDraft: NewThreadDraft?
    /// Only the newest start opens by itself: an earlier one landing while
    /// you wait on the next mustn't take its place.
    private var latestStart: String?

    func started(commandId: String, message: String, draft: NewThreadDraft) {
        starting.insert(StartingThread(id: commandId, message: message, draft: draft, startedAt: .now), at: 0)
        latestStart = commandId
        watchStarting(commandId)
    }

    /// Gone from the list: a failed one dismissed, or tapped to try again.
    func dropStarting(_ id: String) {
        startingTasks.removeValue(forKey: id)?.cancel()
        starting.removeAll { $0.id == id }
    }

    /// A failed one back in the new thread sheet as it was: words, photos,
    /// runner, model and effort. The photos go up again, as the backend
    /// deleted its copies with the failed command.
    func retryStarting(_ row: StartingThread) {
        dropStarting(row.id)
        retryDraft = row.draft
    }

    private func watchStarting(_ id: String) {
        guard let backend else { return }
        startingTasks[id]?.cancel()
        startingTasks[id] = follow(backend.command(id)) { $0.startingChanged(id, $1) }
    }

    private func startingChanged(_ id: String, _ status: CommandStatus?) {
        guard let i = starting.firstIndex(where: { $0.id == id }) else { return }
        if let threadId = status?.threadId {
            let row = starting[i]
            dropStarting(id)
            if id == latestStart, Date.now.timeIntervalSince(row.startedAt) < 60 { justStarted = (id, threadId) }
        } else if status?.state == .failed {
            starting[i].failed = status?.note ?? "The runner couldn't start it."
            for photo in starting[i].draft.photos { photo.upload = nil }
            startingTasks.removeValue(forKey: id)?.cancel()
        } else if status == nil || status?.state == .done {
            // The command's gone from the backend (pruned long after), or
            // done without saying which thread: nothing left to wait for,
            // and the thread, if any, is in the list.
            dropStarting(id)
        }
    }

    private var tasks: [Task<Void, Never>] = []
    private(set) var apnsToken: String?
    /// Bumped each time the Convex connection is rebuilt (comingBack), so
    /// views holding live queries on the old one start them again.
    private(set) var connection = 0
    private var backgroundedAt: Date?
    /// On the sample threads (FakeBackend) rather than a real deployment:
    /// the demo from the pair screen, or `-ThreadbearFake` for screenshots.
    private(set) var isFake = false

    init() {
        let args = ProcessInfo.processInfo.arguments
        opensPocketAtLaunch = args.contains("-ThreadbearPocket")
        // `-ThreadbearSettings`: start on Settings, for screenshots.
        opensSettingsAtLaunch = args.contains("-ThreadbearSettings")
        opensModelPickerAtLaunch = args.contains("-ThreadbearOpenModelPicker")
        expandsLoginAtLaunch = args.contains("-ThreadbearExpandLogin")
        if args.contains("-ThreadbearFake") {
            // -ThreadbearSlowLoad: the lists answer after a few seconds, to see the loading rows.
            // -ThreadbearPictures: and a thread with pictures, "pics".
            // -ThreadbearLoginNote: and one whose login ran out and moved, "moved".
            // -ThreadbearDiagrams: and one with a mermaid diagram and an html block.
            // -ThreadbearCode: and one with sql, ts and untagged code blocks, "code".
            // -ThreadbearLong: and a very long thread, "long".
            // -ThreadbearSecret: and a thread waiting on a secret card, "secret".
            // -ThreadbearRunners: the Mac asleep and two more runners, for the runner picker.
            // -ThreadbearOffline: the Mac's been asleep for hours, so messages wait, and a3 has two waiting.
            let offline = args.contains("-ThreadbearOffline")
            // -ThreadbearManyThreads: and a long inbox, a few more running and starred, to scroll.
            let fake = FakeBackend(runnerOnline: !offline, listDelay: args.contains("-ThreadbearSlowLoad") ? .seconds(6) : .zero, pictures: args.contains("-ThreadbearPictures"), long: args.contains("-ThreadbearLong"), secret: args.contains("-ThreadbearSecret"), diagrams: args.contains("-ThreadbearDiagrams"), code: args.contains("-ThreadbearCode"), runners: args.contains("-ThreadbearRunners"), queued: offline, many: args.contains("-ThreadbearManyThreads"), loginMoved: args.contains("-ThreadbearLoginNote"))
            // -ThreadbearSlowStart: a new thread takes a minute to start, so its Starting row stays.
            if args.contains("-ThreadbearSlowStart") { fake.startDelay = .seconds(60) }
            // -ThreadbearShortInbox: one thread in the inbox, one running, one of each put away.
            if args.contains("-ThreadbearShortInbox") { fake.keepOnly(["a4", "a5", "a6", "a7"]) }
            // -ThreadbearEmptyInbox: nothing in the inbox from the start, one running.
            if args.contains("-ThreadbearEmptyInbox") { fake.keepOnly(["a5", "a6", "a7"]) }
            // -ThreadbearFinishSoon: the running thread's turn ends after a while, to see its row move.
            // -ThreadbearSlowAnswers: answers to cards take a few seconds to reach the "runner".
            if args.contains("-ThreadbearSlowAnswers") { fake.answerDelay = .seconds(3) }
            // -ThreadbearRefuseAnswers: and it refuses them.
            if args.contains("-ThreadbearRefuseAnswers") { fake.answerDelay = .seconds(3); fake.answersFail = true }
            // -ThreadbearSlowChanges: stars, wakes, archives, reply buttons and Stop take 30 s to reach the "runner", to see them on their way.
            if args.contains("-ThreadbearSlowChanges") { fake.changeDelay = .seconds(30) }
            // -ThreadbearRefuseChanges: and it refuses them after 3 s, to see one put back with why.
            if args.contains("-ThreadbearRefuseChanges") { fake.changeDelay = .seconds(3); fake.changesFail = true }
            // -ThreadbearNeverTaken: the "runner" never takes them, as with the Mac asleep, to see them time out.
            if args.contains("-ThreadbearNeverTaken") { fake.holdsCommands = true }
            if args.contains("-ThreadbearFinishSoon") { fake.finishRunningThread(after: .seconds(14)) }
            // -ThreadbearNewReply <text> -ThreadbearNewTurn <seconds>: what a new thread's first turn says and how long it works, for filming one.
            if let reply = UserDefaults.standard.string(forKey: "ThreadbearNewReply") { fake.newThreadReply = reply }
            // -ThreadbearRunnersAwake: with -ThreadbearRunners, the MacBook Pro's online too.
            if args.contains("-ThreadbearRunnersAwake") { fake.wakeRunners() }
            let newTurn = UserDefaults.standard.double(forKey: "ThreadbearNewTurn")
            if newTurn > 0 { fake.newThreadTurn = .seconds(newTurn) }
            connect(fake, pairing: nil)
        } else if let saved = PairingStore.load() {
            connect(ConvexBackend(deploymentURL: saved.deploymentURL, token: saved.token), pairing: saved)
        }
        #if DEBUG
        // `-ThreadbearPair <link>`: pair on launch, since the simulator asks
        // "Open in Threadbear?" for links from outside and nothing can tap it.
        if let i = args.firstIndex(of: "-ThreadbearPair"), i + 1 < args.count, let offered = Pairing.parse(args[i + 1], allowLocal: Self.allowLocalPairing) {
            Task { await pair(with: offered) }
        }
        // `-ThreadbearOpen <threadId>`: start on that thread, for screenshots.
        if let i = args.firstIndex(of: "-ThreadbearOpen"), i + 1 < args.count { openThreadId = args[i + 1] }
        if let i = args.firstIndex(of: "-ThreadbearCompose"), i + 1 < args.count { composeText = args[i + 1] }
        if let i = args.firstIndex(of: "-ThreadbearDraft"), i + 1 < args.count { draftText = args[i + 1] }
        if let i = args.firstIndex(of: "-ThreadbearSearch"), i + 1 < args.count { searchText = args[i + 1] }
        // `-ThreadbearScrollTo <threadId>`: start with the inbox scrolled to that row, to see the headings stick.
        if let i = args.firstIndex(of: "-ThreadbearScrollTo"), i + 1 < args.count { scrollToThreadId = args[i + 1] }
        // `-ThreadbearStart <text>`: start a thread with it, as the sheet's Start does.
        if let i = args.firstIndex(of: "-ThreadbearStart"), i + 1 < args.count, let backend {
            let text = args[i + 1]
            Task {
                guard let id = try? await backend.create(text: text, runnerId: nil, cwd: nil, images: [], settings: NewThreadSettings(model: nil, effort: nil)) else { return }
                started(commandId: id, message: text, draft: NewThreadDraft(text: text, photos: []))
            }
        }
        if let i = args.firstIndex(of: "-ThreadbearClip"), i + 1 < args.count { playClip(args[i + 1]) }
        // `-ThreadbearDo "star <threadId>"` (or press <threadId> <buttonId>, stop <threadId>):
        // taps it a moment after launch, for shots of a control on its way,
        // as nothing can tap the simulator.
        if let i = args.firstIndex(of: "-ThreadbearDo"), i + 1 < args.count {
            let words = args[i + 1].split(separator: " ").map(String.init)
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                switch (words.first, words.count) {
                case ("star", 2): change(words[1], .star(true))
                case ("stop", 2): stop(threadId: words[1])
                case ("press", 3):
                    commands.start(.press(threadId: words[1], buttonId: words[2]), settle: nil,
                                   send: { try await $0.press(threadId: words[1], buttonId: words[2]) })
                default: break
                }
            }
        }
        if let i = args.firstIndex(of: "-ThreadbearPhoto"), i + 1 < args.count {
            let sample = FileManager.default.contents(atPath: args[i + 1])
            let slow = args.contains("-ThreadbearSlowPhoto")
            loadSamplePhoto = {
                if slow { try? await Task.sleep(for: .seconds(20)) }
                return sample
            }
        }
        #endif
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                self?.now = .now
            }
        }
    }

    var isPaired: Bool { backend != nil && authProblem == nil }

    var sections: InboxSections { sections(of: inbox) }

    private func sections(of list: [PhoneThread]) -> InboxSections {
        InboxSections.build(list.filter { !commands[.archive($0.threadId)].holdsChange && !tucks.hidden.contains($0.threadId) }.map(shown), now: now, wakes: wakes)
    }

    /// A thread as this phone shows it: with the changes tapped here that
    /// the runner hasn't made yet (a star, read, woken, back from the
    /// archive, a new title), at once and until it's done or refused.
    func shown(_ thread: PhoneThread) -> PhoneThread {
        let id = thread.threadId
        var t = thread
        if commands[.star(id)].holdsChange, let on = commands.value(.star(id)) {
            t.starredAt = on == "on" ? (t.starredAt ?? now) : nil
        }
        // Read here: it stops wanting Mike unless asks are still open, as
        // the runner will say. Woken or brought back: the runner's wait
        // state is from before, so the phone's own rule draws it until the
        // runner sends the new one (InboxSections.legacySection).
        if commands[.markSeen(id)].holdsChange {
            t.unread = false
            t.needsYou = false
            if t.wait == .needsYou, !t.waitingOnMike { t.waitState = WaitState.done.rawValue }
        }
        if commands[.wake(id)].holdsChange {
            t.snoozedUntil = nil
            t.snoozedUntilRestart = nil
            t.waitState = nil
        }
        if commands[.unarchive(id)].holdsChange {
            t.archivedAt = nil
            t.waitState = nil
        }
        if commands[.rename(id)].holdsChange, let title = commands.value(.rename(id)) { t.title = title }
        if commands[.settings(id)].holdsChange, let pending = pendingSettings[id] {
            for item in pending {
                t = modelPickerContext(for: t).applyingOptimistic(item, to: t, now: now)
            }
        }
        return t
    }

    /// Put-away threads as a search shows them: less those brought back from
    /// here, with the changes tapped here on top (`shown`).
    func searchable(_ list: [PhoneThread]) -> [PhoneThread] {
        list.filter { !commands[.wake($0.threadId)].holdsChange && !commands[.unarchive($0.threadId)].holdsChange }.map(shown)
    }

    /// A star, wake, mark read or bring back from a row, its menu or the
    /// thread's: shown at once (`shown`), put back with why if the runner
    /// refuses it, and said if the Mac hasn't picked it up in a while.
    func change(_ threadId: String, _ change: ThreadChange) {
        let key: CommandKey, value: String?, verb: String
        switch change {
        case let .star(on): (key, value, verb) = (.star(threadId), on ? "on" : "off", on ? "star" : "unstar")
        case .wake: (key, value, verb) = (.wake(threadId), nil, "wake")
        case .markSeen: (key, value, verb) = (.markSeen(threadId), nil, "mark as read")
        case .unarchive: (key, value, verb) = (.unarchive(threadId), nil, "bring back")
        case .archive, .archiveWithVerdict: return archive(threadId, change)
        case .snooze, .snoozeUntilRestart: return hibernate(threadId, change)
        case let .rename(title): return rename(threadId, to: title)
        case let .settings(settings): return updateSettings(threadId: threadId, change: settings)
        }
        // Brought back: an archive of it from here that's done but not yet let go mustn't hide it.
        if case .unarchive = change { commands.forget(.archive(threadId)) }
        // Starring again while one's on its way: the newest tap wins.
        if case .star = change, commands[key].holdsChange { commands.forget(key) }
        let started = commands.start(key, value: value, send: { try await $0.update(threadId: threadId, change: change) }) { [weak self] state in
            self?.said(state, failing: "The runner couldn't \(verb) that thread.")
        }
        if started { UISelectionFeedbackGenerator().selectionChanged() }
    }

    /// Shares a thread by link, stops sharing it, or gives it a new link: the
    /// share sheet shows it at once (ThreadSharing.shown) and puts it back
    /// with why if the runner refuses.
    func share(_ thread: PhoneThread, _ request: ShareRequest) {
        let threadId = thread.threadId
        let value = ThreadSharing.value(request, replacing: thread.share?.slug)
        let started = commands.start(.share(threadId), value: value, send: { try await $0.share(threadId: threadId, request: request) }) { [weak self] state in
            self?.said(state, failing: "The Mac couldn't change how this thread is shared.")
        }
        if started { UISelectionFeedbackGenerator().selectionChanged() }
    }

    /// The share sheet's state for a thread: its row with the tap made here on top.
    func sharing(_ thread: PhoneThread) -> SharingState {
        let key = CommandKey.share(thread.threadId)
        return ThreadSharing.shown(thread.share, site: shareSite, command: commands[key], value: commands.value(key))
    }

    /// Where a command ended, said where he's looking: a refusal always, and a
    /// time-out only when the Mac looks online (asleep, the inbox says so already).
    private func said(_ state: PendingCommand, failing fallback: String) {
        if let failure = state.failure(fallback) {
            report(TransportError.server(failure))
        } else if state.isTimedOut, state.id == nil || offlineText == nil, let note = state.timedOutNote {
            lastError = note
        }
    }

    /// A thread this phone has a row for (inbox, hibernating, archived).
    func knownThread(_ id: String) -> PhoneThread? {
        inbox.first { $0.threadId == id } ?? hibernating.first { $0.threadId == id } ?? den.first { $0.threadId == id }
    }

    /// A pasted thread id as the `[title](thread:<id>)` link it goes in as,
    /// for a thread this phone has a row for (inbox, hibernating, archived),
    /// or nil to paste the words. Same as the Mac's composer.
    func threadReference(pasted: String) -> String? {
        let known = inbox + hibernating + den
        func title(_ id: String) -> String? { known.first { $0.threadId == id }?.title }
        guard let id = CardMentions.pastedThreadId(pasted, known: { title($0) != nil }) else { return nil }
        return CardMentions.threadReference(id: id, title: title(id) ?? "")
    }

    /// Archives a thread, gone from the inbox at once. `leavingThread` is for
    /// its own page, which is popping back to the inbox: the row waits for
    /// the page to clear, then slides off where he can see it go (Mike, 31
    /// Oct). The command is only sent once the row has gone, as the runner
    /// can answer within the animation and a list update would snap it away.
    func archive(_ threadId: String, _ change: ThreadChange = .archive, leavingThread: Bool = false) {
        guard backend != nil, !commands[.archive(threadId)].locked, !slidingOff.contains(threadId) else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        // Hibernating threads can be archived from their page but have no inbox row to animate.
        let hasRow = inbox.contains { $0.threadId == threadId }
        // Kept hidden after it's done until the inbox list drops it (or half a minute).
        let start = { [weak self] in
            _ = self?.commands.start(.archive(threadId), settle: .seconds(30), send: { try await $0.update(threadId: threadId, change: change) }) { state in
                self?.said(state, failing: "The runner couldn't archive that thread.")
                // Done with the inbox already without it: nothing left to hide.
                if case .done = state, let self, !self.inbox.contains(where: { $0.threadId == threadId }) { self.commands.forget(.archive(threadId)) }
            }
        }
        Task {
            if hasRow, leavingThread {
                try? await Task.sleep(for: .milliseconds(420))
                withAnimation(.easeIn(duration: 0.24)) { _ = slidingOff.insert(threadId) }
                try? await Task.sleep(for: .milliseconds(240))
            }
            // The Mac may have archived it during the wait; an id that's not
            // in the list would never get cleared by the next list update.
            if inbox.contains(where: { $0.threadId == threadId }) {
                takeOffInbox { start() }
            } else {
                start()
            }
            slidingOff.remove(threadId)
        }
    }

    /// The button tapped on a card whose answer is on its way: kept here
    /// rather than in the card, so leaving the thread and coming back doesn't
    /// offer the buttons again meanwhile. Nil once it's let go, refused or
    /// timed out (the Mac hasn't picked it up: it can be tapped again).
    func cardAnswer(_ approvalId: String) -> String? {
        commands[.card(approvalId)].locked ? commands.value(.card(approvalId)) : nil
    }

    /// A secret card's answer that didn't go through, and which it was
    /// ("save" or "decline"), for the card to say so, even opened again later.
    func refusedSecret(_ approvalId: String) -> String? {
        commands[.card(approvalId)].isFailed ? commands.value(.card(approvalId)) : nil
    }

    /// Sends a card's answer with its button spinning. False if one's already
    /// on its way. The spinner stays until the card goes (five seconds after
    /// it's done at most); it stops if the runner refuses (ThreadView says
    /// why under the transcript, from `sent`; a secret card in its own
    /// words), or if the Mac hasn't picked it up in time, which is said, and
    /// the card can be answered again.
    @discardableResult
    func answerCard(_ approvalId: String, choice: String, secret: Bool = false,
                    send: @escaping @Sendable (any Backend) async throws -> String, sent: @escaping (String) -> Void = { _ in }) -> Bool {
        commands.start(.card(approvalId), value: choice, settle: .seconds(5), send: send, then: { [weak self] state in
            // A secret card says a refusal in its own words (refusedSecret).
            if secret, !state.isTimedOut { return }
            self?.said(state, failing: "The runner couldn't take that answer.")
        }, sent: sent)
    }

    /// Hibernates a thread, as `archive` archives one, but the row sinks rather
    /// than slides: archive goes sideways, this goes down towards its heading,
    /// whose count rolls on and whose moon bounces as the row leaves. A starred
    /// thread stays under Starred with a moon, and one only waiting on a schedule
    /// is under Hibernating already, so neither has anywhere to sink to.
    func hibernate(_ threadId: String, _ change: ThreadChange, leavingThread: Bool = false) {
        guard backend != nil, !commands[.archive(threadId)].holdsChange, !slidingOff.contains(threadId),
              !sinking.contains(threadId), !tucks.hidden.contains(threadId), !commands[.hibernate(threadId)].locked,
              !startingHibernate.contains(threadId) else { return }
        // Taken at once: a second tap in the moment before the row starts to
        // sink would tuck it twice, and the heading's count would stay one up.
        startingHibernate.insert(threadId)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        func hasRow() -> Bool { (sections.inbox + sections.running).contains { $0.threadId == threadId } }
        let sinks = hasRow()
        let pairing = connectionEpoch
        Task {
            defer { startingHibernate.remove(threadId) }
            if sinks {
                try? await Task.sleep(for: .milliseconds(280))
                if leavingThread {
                    // SwiftUI holds the page's dismiss until the dialog has
                    // gone, which can be half a second, so the wait for the
                    // page to clear starts when it really starts to leave.
                    let giveUp = Date.now.addingTimeInterval(1.5)
                    while threadOpen, Date.now < giveUp { try? await Task.sleep(for: .milliseconds(30)) }
                    try? await Task.sleep(for: .milliseconds(420))
                }
                // Unpaired or left the demo meanwhile: nothing of it stays.
                guard connectionEpoch == pairing else { return }
                withAnimation(.easeIn(duration: 0.24)) { _ = sinking.insert(threadId) }
                try? await Task.sleep(for: .milliseconds(240))
                guard connectionEpoch == pairing else { sinking.remove(threadId); return }
                // The Mac may have moved it during the wait; `tucks` only
                // lets go of an id when a list update says so.
                if hasRow() {
                    takeOffInbox { tucks.tuck(threadId) }
                }
                // Not until it's collapsed: back at full opacity, the row
                // going away would show again on its way out.
                Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    sinking.remove(threadId)
                }
            }
            commands.start(.hibernate(threadId), send: { try await $0.update(threadId: threadId, change: change) }) { [weak self] state in
                if !state.holdsChange { withAnimation(.snappy(duration: 0.25)) { self?.tucks.undo(threadId) } }
                self?.said(state, failing: "The runner couldn't hibernate that thread.")
            }
        }
    }

    /// A row he's taken away collapsing, which may be the last: only this
    /// counts as clearing the inbox, so the bear never waves at a launch or when
    /// the Mac empties it.
    private func takeOffInbox(_ change: () -> Void) {
        let before = sections
        withAnimation(.snappy(duration: 0.25)) {
            change()
            // In the same breath, as the empty view reads it when it's made.
            inboxCleared.note(before: before, after: sections, now: .now)
        }
    }

    /// Whether to wave, once: the empty view asks as it appears.
    func takeInboxCleared() -> Bool { inboxCleared.take(now: .now) }

    func toggle(_ section: PhoneSection) {
        folds.toggle(section)
        UserDefaults.standard.set(folds.saved, forKey: "foldedSections")
        followLists()
    }

    func setSearching(_ on: Bool) {
        guard on != searching else { return }
        searching = on
        followLists()
    }

    /// How many threads a folded heading hides: the list when it's loaded,
    /// else phone:counts'. Nil when neither knows.
    func count(_ section: PhoneSection) -> Int? {
        switch section {
        case .coordinators: sections.coordinators.count
        case .starred: sections.starred.count
        case .inbox: sections.inbox.count
        case .running: sections.running.count
        // Folded, the snoozed ones aren't loaded, but the scheduled ones come
        // from the inbox list, so they're added to phone:counts' number.
        case .hibernating: (loaded.contains(.hibernating) ? hibernatingRows.count : (counts?.hibernating).map { $0 + sections.scheduled.count }).map { $0 + tucks.uncounted }
        // The den list is capped at 100; the count isn't.
        case .archived: counts?.den ?? (loaded.contains(.den) ? den.count : nil)
        }
    }

    /// Under Hibernating: the threads waiting on a schedule and the snoozed
    /// ones, soonest to wake first, as on the Mac.
    var hibernatingRows: [PhoneThread] {
        InboxSections.hibernating(scheduled: sections.scheduled, snoozed: loaded.contains(.hibernating) ? hibernating.filter { !commands[.wake($0.threadId)].holdsChange && !commands[.archive($0.threadId)].holdsChange }.map(shown) : [], wakes: wakes)
    }

    func threads(_ section: PhoneSection) -> [PhoneThread] {
        switch section {
        case .coordinators: sections.coordinators
        case .starred: sections.starred
        case .inbox: sections.inbox
        case .running: sections.running
        case .hibernating: hibernatingRows
        // Brought back from here: gone from the list at once, as a swipe that
        // only snapped back looked as if it hadn't taken.
        case .archived: den.filter { !commands[.unarchive($0.threadId)].holdsChange }.map(shown)
        }
    }

    /// Rows on their way to a new heading, whose tick or dot waits until they're
    /// there: it's the row arriving that says the thread's finished.
    private(set) var landing: Set<String> = []

    /// Rows flying from one heading to another over the list (RowFlight.swift),
    /// each hiding its real row until it's there.
    private(set) var flights: [String: RowFlight] = [:]
    @ObservationIgnored let rowFrames = RowFrames()

    /// The moving rows that can fly: those on show now, or under a folded
    /// heading that is. None under Reduce Motion, or with a thread open over the
    /// list, where the change just happens.
    private func flights(for moves: [String: InboxMove], in list: [PhoneThread]) -> [String: RowFlight] {
        guard Juice.rows != nil, !threadOpen else { return [:] }
        var flights: [String: RowFlight] = [:]
        for (id, move) in moves where !(folds.isFolded(move.from) && folds.isFolded(move.to)) {
            guard let thread = list.first(where: { $0.threadId == id }) else { continue }
            if !folds.isFolded(move.from), let from = rowFrames.visible(RowFrames.row(id, under: move.from)) {
                flights[id] = RowFlight(id: id, thread: thread, move: move, from: from, fromHeading: false)
            } else if folds.isFolded(move.from), let from = rowFrames.visible(RowFrames.heading(move.from)) {
                flights[id] = RowFlight(id: id, thread: thread, move: move, from: from, fromHeading: true)
            }
        }
        return flights
    }

    /// A row's there: its real one shows in place of the picture, and its tick
    /// or dot pops in.
    func endFlight(_ id: String) {
        guard flights.removeValue(forKey: id) != nil else { return }
        withAnimation(Juice.pop) { _ = landing.remove(id) }
    }

    private func popMarksAfterLanding(flying: Set<String>) {
        Task {
            try? await Task.sleep(for: Juice.landing)
            // A row still flying pops its own when it lands.
            withAnimation(Juice.pop) { landing = landing.filter { flights[$0] != nil } }
            // However its flight went, never leave a row hidden.
            try? await Task.sleep(for: .seconds(1))
            for id in flying { endFlight(id) }
        }
    }

    /// Starts a subscription for each list now wanted and stops the rest,
    /// dropping what a stopped one had so it isn't shown stale later.
    private func followLists() {
        guard let backend else { return }
        let wanted = folds.views(searching: searching)
        for (view, task) in listTasks where !wanted.contains(view) {
            task.cancel()
            listTasks[view] = nil
            loaded.remove(view)
            switch view {
            case .inbox: inbox = []
            case .hibernating: hibernating = []
            case .den: den = []
            }
        }
        for view in wanted where listTasks[view] == nil {
            let usesChanges = view == .inbox && (apiVersion ?? 0) >= BackendCompatibility.threadChangesAPIVersion
            listTasks[view] = follow(usesChanges ? backend.inboxChanges() : backend.threads(view)) { model, list in
                model.pinRunners(list)
                switch view {
                case .inbox:
                    // Watching the phone while the Mac works, a row gliding up is
                    // a thread finishing. Only for a change of heading, and not
                    // the first answer, so a title or a working line changing
                    // leaves the list still under his thumb.
                    let (old, new) = (model.sections, model.sections(of: list))
                    let glides = model.loaded.contains(.inbox) && old.changedHeadings(to: new)
                    // Outside the animation, so the pictures are there at once,
                    // over the rows they stand in for.
                    let flying = glides ? model.flights(for: old.moves(to: new), in: list) : [:]
                    model.flights.merge(flying) { $1 }
                    withAnimation(glides ? Juice.rows : nil) {
                        model.inbox = list
                        // Gone from the list once done: let go, so a later unarchive shows.
                        let ids = Set(list.map(\.threadId))
                        model.commands.forget { key in
                            if case let .archive(id) = key, !ids.contains(id), case .done = model.commands[key] { return true }
                            return false
                        }
                        model.tucks.inboxArrived(list, now: .now)
                        if glides { model.landing.formUnion(old.landed(in: new)) }
                    }
                    if glides { model.popMarksAfterLanding(flying: Set(flying.keys)) }
                    model.inboxAnswers += 1
                    // Notifications for threads that no longer need you come down.
                    if !model.isFake {
                        let needing = Set(list.filter(\.needsYou).map(\.threadId))
                        Task { await DeliveredNotifications.keepOnly(needingYou: needing) }
                    }
                case .hibernating: model.hibernating = list
                case .den: model.den = list
                }
                model.loaded.insert(view)
            }
        }
    }

    /// "Mac offline since 10:42" when no runner has checked in for three
    /// minutes. Things done meanwhile wait until it's back.
    var offlineText: String? {
        guard !runners.isEmpty, !runners.contains(where: { $0.isOnline(at: now) }) else { return nil }
        let newest = runners.max { $0.lastSeenAt < $1.lastSeenAt }!
        let name = runners.count == 1 ? "Mac" : newest.name
        return "\(name) offline since \(RelativeTime.clock(newest.lastSeenAt, now: now))"
    }

    /// A thread's project: the one with that id on the thread's own runner.
    func project(_ id: String, runnerId: String) -> PhoneProject? { projects[Self.projectKey(runnerId: runnerId, id: id)] }

    static func projectKey(runnerId: String, id: String) -> String { "\(runnerId)\n\(id)" }

    func runnerName(_ runnerId: String) -> String? {
        runners.count > 1 ? runners.first { $0.runnerId == runnerId }?.name : nil
    }

    // MARK: Pairing

    #if DEBUG
    /// `-ThreadbearClip`'s steps: about 4 s on the inbox first, so people
    /// can see where they are, and a beat on the words before Start.
    private func playClip(_ text: String) {
        let clock = { (step: String) in print("CLIP \(step) \(Date.now.timeIntervalSince1970)") }
        Task {
            clock("launch")
            try? await Task.sleep(for: .seconds(4))
            clock("compose")
            composeText = ""
            try? await Task.sleep(for: .seconds(1.2))
            clock("type")
            for end in text.indices.dropFirst() + [text.endIndex] {
                clipTyped = String(text[..<end])
                try? await Task.sleep(for: .milliseconds(Int.random(in: 45...110)))
            }
            try? await Task.sleep(for: .seconds(1.6))
            clock("start")
            clipStartTaps += 1
        }
    }
    private static let allowLocalPairing = true // the simulator against `npx convex dev` on this Mac
    #else
    private static let allowLocalPairing = false
    #endif

    /// A pairing link waiting for Mike's yes (ThreadbearApp's alert).
    let pairingGate = PairingGate()
    /// A yes is being checked with the server, for the pair screen's spinner.
    private(set) var isPairing = false

    /// Every pairing code or link, from the pair screen's scanner, the
    /// clipboard or another app, starts here: it's held for a yes and nothing
    /// is saved yet, paired or not (an expired token used to let a link
    /// straight in). One another app opened is never taken (Daybreak 127).
    func askToPair(_ text: String, from source: PairingSource) {
        lastError = nil
        switch pairingGate.ask(text, from: source, allowLocal: Self.allowLocalPairing, current: pairing ?? PairingStore.load(),
                               keys: { Self.runnerKeys(for: $0) }) {
        case .asking: break
        case .notPairing: lastError = "That isn't a Threadbear pairing code."
        case .busy: lastError = "Answer the pairing question first, then scan the code again."
        case .oldLink: lastError = "That code is from an older Threadbear on your Mac, which puts the phone's token in it. Update Threadbear on your Mac, then show the code again."
        case .opened: lastError = "Threadbear doesn't pair from links other apps open. Scan the code on your Mac from Threadbear's own pairing screen instead."
        }
    }

    /// Mike said yes to `shown`. Synchronous, so the request is taken before
    /// the alert's dismissal cancels the gate.
    func acceptPairing(_ shown: PairingRequest) {
        pairingGate.accept(shown) { [weak self] request in await self?.pair(with: request.pairing) }
    }

    /// From a pairing Mike said yes to (or `-ThreadbearPair` in a Debug
    /// build): trades its one-use code for the token, if it has one, and
    /// checks the token works before keeping it.
    private func pair(with offered: Pairing) async {
        isPairing = true
        defer { isPairing = false }
        let transport = ConvexMobileTransport(deploymentURL: offered.deploymentURL)
        let pairing: Pairing
        do {
            pairing = try await offered.claimed(with: transport)
        } catch {
            lastError = "The server didn't take that pairing code: \(error.localizedDescription)"
            return
        }
        let backend = ConvexBackend(transport: transport, token: pairing.token)
        do {
            _ = try await backend.me()
            PairingStore.save(pairing)
            // The Macs a secret may be sealed to: only these, from the QR
            // code the Mac drew, never ones the mirror names.
            RunnerKeyPins.pinFromPairing(pairing.runnerKeys, in: Self.runnerKeys(for: pairing))
            connect(backend, pairing: pairing)
        } catch {
            lastError = "The server didn't accept that token: \(error.localizedDescription)"
        }
    }

    /// "Look around with sample threads" on the pair screen. The app is no
    /// use until it's paired with a Mac, so this is how App Review (and
    /// anyone curious) sees it working, on made-up threads that never leave
    /// the phone. Not remembered: a relaunch goes back to pairing.
    func startDemo() {
        lastError = nil
        connect(FakeBackend(), pairing: nil)
    }

    /// Back to the pair screen. A pairing saved before the demo (one whose
    /// token was refused) is left as it was.
    func leaveDemo() {
        stop()
        pocket = []
        pocketSeenUpTo = UserDefaults.standard.string(forKey: "pocketSeenUpTo")
        backend = nil
        commands.use(nil)
        connectionEpoch += 1
        slidingOff = []
        sinking = []
        starting = []
        isFake = false
        runners = []
        projects = [:]
        accounts = []
        inbox = []
        tucks = Tucks()
        hibernating = []
        den = []
        wakes = [:]
        counts = nil
        loaded = []
    }

    func markPocketSeen() {
        let seen = PocketDeck.seenUpTo(pocket, after: pocketSeenUpTo)
        guard seen != pocketSeenUpTo else { return }
        pocketSeenUpTo = seen
        // The demo's cards aren't yours, so looking at them mustn't count.
        if !isFake { UserDefaults.standard.set(seen, forKey: "pocketSeenUpTo") }
    }

    func removePocketCard(_ card: PocketCard) {
        guard let backend else { return }
        // Gone at once, and back if the backend wouldn't have it.
        let before = pocket
        pocket.removeAll { $0.id == card.id }
        Task {
            do { try await backend.removePocketCard(id: card.id) } catch {
                pocket = before
                lastError = error.localizedDescription
            }
        }
    }

    func unpair() {
        PocketStore.standard.clear()
        pocket = []
        UserDefaults.standard.removeObject(forKey: "pocketSeenUpTo")
        pocketSeenUpTo = nil
        PairingStore.clear()
        // Pairing again keeps the runner keys its link carries afresh.
        KeychainRunnerKeyStore.clearAll()
        pinnedThreads = []
        stop()
        backend = nil
        commands.use(nil)
        connectionEpoch += 1
        slidingOff = []
        sinking = []
        starting = []
        pendingSettings = [:]
        pairing = nil
        authProblem = nil
        backendProblem = nil
        apiVersion = nil
        siteSaid = nil
        runners = []
        projects = [:]
        accounts = []
        inbox = []
        tucks = Tucks()
        hibernating = []
        den = []
        wakes = [:]
        counts = nil
        loaded = []
    }

    func wentToBackground() { backgroundedAt = .now }

    /// iOS suspends the app soon after it leaves the screen, and the
    /// WebSocket under convex-swift doesn't come back from that: the lists
    /// already showing stay as they were, and anything subscribed afterwards
    /// (opening a thread) waits forever, with no "Reconnecting…" because the
    /// client still thinks it's connected. Mike, 31 Oct: the inbox showed but
    /// no thread opened, and not one phone call had reached Convex in two
    /// hours. So back from the background, a fresh client.
    func comingBack() {
        defer { backgroundedAt = nil }
        guard let since = backgroundedAt, Date.now.timeIntervalSince(since) > 5, !isFake else { return }
        freshConnection()
    }

    /// Pulling the inbox down: a fresh Convex client, as coming back from the
    /// background has, and back once the inbox has answered on it (or a few
    /// seconds have gone), so the list holds open while it really reconnects.
    /// It used to wait 400 ms and do nothing. The demo follows its sample
    /// threads again, as there's no client to replace.
    func reconnect() async {
        let answered = inboxAnswers
        guard freshConnection() else { return }
        let giveUp = Date.now.addingTimeInterval(6)
        while inboxAnswers == answered, Date.now < giveUp { try? await Task.sleep(for: .milliseconds(50)) }
    }

    /// Answers the inbox list has had, on any connection, for `reconnect`.
    @ObservationIgnored private var inboxAnswers = 0

    @discardableResult
    private func freshConnection() -> Bool {
        guard authProblem == nil, let backend else { return false }
        let kept = loaded
        if isFake {
            connect(backend, pairing: nil, registerPush: false)
        } else {
            guard let pairing else { return false }
            connect(ConvexBackend(deploymentURL: pairing.deploymentURL, token: pairing.token), pairing: pairing, registerPush: false)
        }
        // What's on screen stays until the fresh answers replace it, rather
        // than flashing the loading rows.
        loaded = kept
        connection += 1
        return true
    }

    private func connect(_ backend: any Backend, pairing: Pairing?, registerPush: Bool = true) {
        stop()
        // Another deployment (or the demo) has its own pins.
        pinnedThreads = []
        self.backend = backend
        // Commands still waiting follow on the new client (a fresh connection),
        // or let go when it's another pairing or the demo.
        if self.pairing?.deploymentURL != pairing?.deploymentURL || (backend is FakeBackend) != isFake { commands.use(nil) }
        commands.unauthorized = { [weak self] message in
            self?.authProblem = message
            // Back to pairing: nothing waits on the refused token any more.
            self?.commands.clear()
        }
        commands.use(backend)
        self.pairing = pairing
        isFake = backend is FakeBackend
        authProblem = nil
        if !isFake { pocket = PocketStore.standard.load() }
        tasks.append(follow(backend.runners()) { $0.receiveRunners($1) })
        tasks.append(follow(backend.projects()) { model, list in
            model.projects = Dictionary(list.map { (AppModel.projectKey(runnerId: $0.runnerId ?? "", id: $0.id), $0) }, uniquingKeysWith: { first, _ in first })
        })
        loaded = []
        followLists()
        tasks.append(follow(backend.accounts()) { $0.accounts = $1 })
        tasks.append(Task { [weak self] in
            for await up in backend.connectionStates() { self?.connected = up }
        })
        tasks.append(Task { [weak self] in
            guard let identity = try? await backend.me() else {
                // Can't tell how new the backend is: the whole list works on any.
                if !Task.isCancelled, let self { self.followWakes(backend, small: false) }
                return
            }
            // Once the version's known, so a backend from before 45 isn't
            // asked for phone:wakes, and one since never reads every schedule
            // whole (Backend.wakes says why).
            if !Task.isCancelled, let self { self.followWakes(backend, small: (identity.apiVersion ?? 0) >= BackendCompatibility.wakesAPIVersion) }
            self?.backendProblem = BackendCompatibility.problem(identity)
            self?.apiVersion = identity.apiVersion ?? 0
            self?.siteSaid = identity.site
            // The inbox started before this was known: over to following its
            // changes. The list on screen stays until the new one answers.
            if (identity.apiVersion ?? 0) >= BackendCompatibility.threadChangesAPIVersion, !Task.isCancelled, let self {
                self.listTasks[.inbox]?.cancel()
                self.listTasks[.inbox] = nil
                self.followLists()
            }
            // An older backend has no phone:counts, and asking would only
            // fail and retry.
            if (identity.apiVersion ?? 0) >= BackendCompatibility.countsAPIVersion, !Task.isCancelled, let self {
                self.tasks.append(self.follow(backend.counts()) { model, counts in
                    model.tucks.countsArrived(old: model.counts?.hibernating, new: counts.hibernating)
                    model.counts = counts
                })
            }
            if (identity.apiVersion ?? 0) >= BackendCompatibility.pocketAPIVersion, !Task.isCancelled, let self {
                self.tasks.append(self.follow(backend.pocket()) { model, cards in
                    model.pocket = cards
                    if !model.isFake { PocketStore.standard.save(cards) }
                })
            }
        })
        for row in starting where row.failed == nil { watchStarting(row.id) }
        if registerPush, let apnsToken { register(apnsToken) }
    }

    /// Which threads a schedule will message, for the Hibernating section.
    private func followWakes(_ backend: any Backend, small: Bool) {
        tasks.append(follow(small ? backend.wakes() : backend.schedules()) { $0.wakes = InboxSections.wakes($1) })
    }

    private func stop() {
        tasks.forEach { $0.cancel() }
        tasks = []
        // Followed again on the new connection (connect), unless it's unpairing.
        startingTasks.values.forEach { $0.cancel() }
        startingTasks = [:]
        listTasks.values.forEach { $0.cancel() }
        listTasks = [:]
    }

    /// Keeps a live query going: on a network error it waits and
    /// subscribes again; a refused token stops everything.
    private func follow<T: Sendable>(_ stream: @autoclosure @escaping () -> AsyncThrowingStream<T, Error>,
                                     _ apply: @escaping (AppModel, T) -> Void) -> Task<Void, Never> {
        Task { [weak self] in
            var delay: Duration = .seconds(1)
            while !Task.isCancelled {
                do {
                    for try await value in stream() {
                        guard let self else { return }
                        apply(self, value)
                        delay = .seconds(1)
                    }
                    return
                } catch TransportError.unauthorized(let message) {
                    self?.authProblem = message
                    return
                } catch {
                    self?.lastError = error.localizedDescription
                    try? await Task.sleep(for: delay)
                    delay = min(delay * 2, .seconds(30))
                }
            }
        }
    }

    // MARK: Push

    func didRegister(apnsToken token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        apnsToken = hex
        register(hex)
    }

    private func register(_ hex: String) {
        guard let backend, !isFake else { return }
        // A development-signed build (every install-phone.sh build) talks to
        // APNs' sandbox; an App Store build would say production.
        let environment = Bundle.main.object(forInfoDictionaryKey: "ThreadbearAPSEnvironment") as? String == "production"
            ? "production" : "sandbox"
        Task {
            // The relay key goes to a backend that takes it (API 4); an older
            // one would refuse the extra argument.
            if apiVersion == nil, let identity = try? await backend.me() { apiVersion = identity.apiVersion ?? 0 }
            let pushKey = (apiVersion ?? 0) >= BackendCompatibility.pushKeyAPIVersion ? PushKeyStore.loadOrCreate()?.base64EncodedString() : nil
            do { try await backend.registerDevice(apnsToken: hex, environment: environment, pushKey: pushKey) } catch {
                self.lastError = "Couldn't turn on notifications: \(error.localizedDescription)"
                return
            }
            // A backend before API 3 has no setting; it notifies every time.
            try? await backend.setNotifications(apnsToken: hex, notify: self.notifyMode)
        }
    }

    /// A finished quick ask, kept as a thread by the runner (backend API 10). The thread's id once
    /// it's made; nil if the runner hasn't taken it within a while (the Mac's asleep), in which
    /// case it's made when the runner's back.
    func keepQuickAsk(_ record: QuickAskRecord) async throws -> String? {
        guard let backend else { throw TransportError.server("Pair with your Mac to keep answers as threads.") }
        if let apiVersion, apiVersion < BackendCompatibility.quickAskAPIVersion {
            throw TransportError.server("Update Threadbear on your Mac to keep answers as threads.")
        }
        let commandId = try await backend.quickAsk(record)
        return try await withThrowingTaskGroup(of: String?.self) { group in
            group.addTask {
                for try await status in backend.command(commandId) {
                    if let threadId = status?.threadId { return threadId }
                    if status?.state == .failed { throw TransportError.server(status?.note ?? "The runner couldn't keep it.") }
                }
                return nil
            }
            group.addTask {
                try await Task.sleep(for: .seconds(30))
                return nil
            }
            let first = try await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /// A reply button with this phone's press on top (`commands`), kept once
    /// done: a row outside the live tail may never catch up.
    func pressLook(_ button: MessageButton, in threadId: String) -> ReplyButtons.Look {
        ReplyButtons.look(button, pending: commands[.press(threadId: threadId, buttonId: button.id)])
    }

    /// A tap on a reply button: presses it once (a second tap while it's
    /// on its way does nothing), or once pressed, opens the thread it
    /// started or messaged if this phone has a row for it.
    func tap(_ button: MessageButton, in threadId: String, pushThread: @MainActor (String) -> Void) {
        switch pressLook(button, in: threadId) {
        case .pressing:
            return
        case let .pressed(id):
            guard let id else { return }
            if (inbox + hibernating + den).contains(where: { $0.threadId == id }) { pushThread(id) } else { report(TransportError.server("That thread isn't on this phone yet.")) }
            return
        case .ready, .failed:
            break
        }
        // Kept once done, for the thread it opens.
        commands.start(.press(threadId: threadId, buttonId: button.id), settle: nil,
                       send: { try await $0.press(threadId: threadId, buttonId: button.id) })
    }

    /// Whether Stop is on its way: a spinner that takes no more taps until the
    /// thread's row says the turn is over (`stopped(_:)`, from the thread
    /// view), the runner refuses (saying why), or the Mac hasn't picked it up
    /// in time (saying so, and Stop can be tapped again).
    func isStopping(_ threadId: String) -> Bool { commands[.stop(threadId)].locked }

    /// Stop on a running thread (backend API 69).
    func stop(threadId: String) {
        // Ten seconds after it's done at most, in case the thread's page has gone.
        commands.start(.stop(threadId), settle: .seconds(10), send: { try await $0.interrupt(threadId: threadId) }) { [weak self] state in
            self?.said(state, failing: "That Mac couldn't stop it.")
        }
    }

    /// The thread's turn is over: its Stop is done.
    func stopped(_ threadId: String) {
        // However far Stop got (the turn may end before its command says
        // done): a refusal stays, to be said.
        if !commands[.stop(threadId)].isFailed { commands.forget(.stop(threadId)) }
    }

    /// A thread's title as shown here: one just typed on this phone until
    /// Convex has it, else the thread's own.
    func title(of thread: PhoneThread) -> String {
        let title = shown(thread).title
        return title.isEmpty ? "Untitled" : title
    }

    /// Renames a thread, showing the new title straight away (`shown`). The
    /// runner applies it as the Mac's rename does; a refusal puts the old one
    /// back with the error. A second rename replaces one still on its way.
    func rename(_ threadId: String, to title: String) {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard backend != nil, !title.isEmpty else { return }
        commands.forget(.rename(threadId))
        commands.start(.rename(threadId), value: title, send: { try await $0.update(threadId: threadId, change: .rename(title)) }) { [weak self] state in
            self?.said(state, failing: "The runner couldn't rename that thread.")
        }
    }

    func clearError() { lastError = nil }

    func report(_ error: Error) {
        if case let TransportError.unauthorized(message) = error { authProblem = message } else {
            lastError = error.localizedDescription
        }
    }
}

/// The pairing, in the Keychain (the token) and UserDefaults (the URL).
/// Quick Ask's lesson: a setup flow for another source overwrote its
/// Keychain token, so the token here is keyed by deployment and nothing
/// else ever writes it.
enum PairingStore {
    private static let urlKey = "pairing.deploymentURL"
    private static let service = "com.mikecann.threadbear.token"

    static func load() -> Pairing? {
        guard let raw = UserDefaults.standard.string(forKey: urlKey), let url = URL(string: raw),
              let token = Keychain.read(service: service, account: Pairing.serverName(url)) else { return nil }
        return Pairing(deploymentURL: url, token: token)
    }

    static func save(_ pairing: Pairing) {
        let account = Pairing.serverName(pairing.deploymentURL)
        Keychain.write(pairing.token, service: service, account: account)
        UserDefaults.standard.set(pairing.deploymentURL.absoluteString, forKey: urlKey)
    }

    static func clear() {
        if let pairing = load() {
            Keychain.delete(service: service, account: Pairing.serverName(pairing.deploymentURL))
        }
        UserDefaults.standard.removeObject(forKey: urlKey)
    }
}

enum Keychain {
    static func read(service: String, account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ value: String, service: String, account: String) {
        delete(service: service, account: account)
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecValueData as String: Data(value.utf8),
            // Readable after the first unlock, so a notification tap on a
            // locked-then-unlocked phone finds it.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemAdd(item as CFDictionary, nil)
    }

    static func delete(service: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// A new thread on its way (AppModel.starting): what was asked, until the
/// runner has made it, or why it couldn't.
struct StartingThread: Identifiable {
    /// The create command's id.
    let id: String
    /// What went to the runner, photos as "Picture 1" chips' text.
    let message: String
    /// The sheet as it was, for trying again if it fails.
    let draft: NewThreadDraft
    let startedAt: Date
    var failed: String?
}

/// What the new thread sheet had in it when Start was tapped.
struct NewThreadDraft {
    var text: String
    var photos: [PickedPhoto]
    /// Nil when the backend picks (only one runner).
    var runnerId: String?
    var poolId: String?
    var accountId: String?
    var provider: String?
    var modelId: String?
    var effort: String?

    var settings: NewThreadSettings {
        NewThreadSettings(poolId: poolId, accountId: accountId, provider: provider, model: modelId, effort: effort)
    }
}
