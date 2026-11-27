import Foundation

/// One command this phone sends a runner and waits on (an archive, a star, a
/// reply button, a card's answer, Stop), from the tap to the runner saying how
/// it went, as one state machine: every move is in `step`, and
/// PendingCommands (the watcher) only feeds it events. Android's kit has the
/// same type (PendingCommand.kt) and the website the same machine
/// (web/src/command.ts); shared/cases/pending-commands.json keeps all three
/// in step and says where they differ.
///
///     idle ─tap─▶ sending ─sent─▶ queued ─row taken─▶ taken ─row done─▶ done ─settle─▶ idle
///                   │                │                  └──row failed──▶ failed
///                   └─sendFailed─▶ failed
///     sending, queued and taken time out when nothing is heard in
///     `deadlineSeconds`: still listening, so a late answer lands, but the
///     control takes taps again (that's its dismiss).
public enum PendingCommand: Equatable, Sendable {
    case idle
    /// The mutation hasn't answered yet.
    case sending(since: Date)
    /// The backend has it; its runner hasn't taken it.
    case queued(id: String, since: Date)
    /// Its runner has it and hasn't said how it went.
    case taken(id: String, since: Date)
    /// The runner did it; `result` is phone:command's answer (nil once the
    /// command's gone from the backend), with the thread it made, if any.
    case done(id: String, result: CommandStatus?)
    /// The mutation threw, or the runner refused it. `reason` is what it
    /// said, nil when it said nothing, for the control to say it its own way.
    case failed(id: String?, reason: String?)
    /// Nothing heard in time: the Mac's asleep or offline, or this phone's
    /// connection is. Still listening.
    case timedOut(id: String?, taken: Bool)

    public enum Event: Equatable, Sendable {
        case tap(at: Date)
        /// The mutation answered with the command's id.
        case sent(id: String, at: Date)
        /// The mutation threw.
        case sendFailed(reason: String)
        /// phone:command's answer changed; nil once the command's gone from the backend.
        case row(CommandStatus?, at: Date)
        /// The clock.
        case deadline(at: Date)
        /// The connection dropped and came back: nothing could be heard meanwhile.
        case reconnected(at: Date)
        /// The backend took it back (phone:cancel said yes).
        case cancelled
        /// A moment after done: the row it changed has caught up.
        case settle
    }

    /// The runner takes a command within a second or two while it's online,
    /// so longer means it's asleep, offline or stuck (web's COMMAND_SLOW_MS).
    public static let deadlineSeconds: TimeInterval = 20

    /// The one place a command moves. An event that doesn't apply where it is
    /// changes nothing.
    public func step(_ event: Event, deadline: TimeInterval = PendingCommand.deadlineSeconds) -> PendingCommand {
        switch event {
        case let .tap(at):
            switch self {
            case .idle, .failed, .timedOut: return .sending(since: at)
            case .sending, .queued, .taken, .done: return self
            }
        case let .sent(id, at):
            switch self {
            case .sending, .timedOut(id: nil, taken: _): return .queued(id: id, since: at)
            case .idle, .queued, .taken, .done, .failed, .timedOut: return self
            }
        case let .sendFailed(reason):
            switch self {
            case .sending, .timedOut(id: nil, taken: _): return .failed(id: nil, reason: reason)
            case .idle, .queued, .taken, .done, .failed, .timedOut: return self
            }
        case let .row(row, at):
            let id: String, taken: Bool
            switch self {
            case let .queued(i, _): (id, taken) = (i, false)
            case let .taken(i, _): (id, taken) = (i, true)
            case let .timedOut(i?, t): (id, taken) = (i, t)
            case .idle, .sending, .done, .failed, .timedOut: return self
            }
            guard let row else { return .done(id: id, result: nil) }
            switch row.state {
            case .done: return .done(id: id, result: row)
            case .failed: return .failed(id: id, reason: row.note)
            // Taken is news: the runner is awake, so the clock starts again.
            case .taken: return taken ? self : .taken(id: id, since: at)
            case .pending: return self
            }
        case let .deadline(at):
            switch self {
            case let .sending(since) where at.timeIntervalSince(since) >= deadline: return .timedOut(id: nil, taken: false)
            case let .queued(id, since) where at.timeIntervalSince(since) >= deadline: return .timedOut(id: id, taken: false)
            case let .taken(id, since) where at.timeIntervalSince(since) >= deadline: return .timedOut(id: id, taken: true)
            case .idle, .sending, .queued, .taken, .done, .failed, .timedOut: return self
            }
        case let .reconnected(at):
            switch self {
            case let .queued(id, _): return .queued(id: id, since: at)
            case let .taken(id, _): return .taken(id: id, since: at)
            case .idle, .sending, .done, .failed, .timedOut: return self
            }
        case .cancelled:
            switch self {
            case .sending, .queued, .taken, .timedOut: return .failed(id: id, reason: PendingCommand.cancelledReason)
            case .idle, .done, .failed: return self
            }
        case .settle:
            switch self {
            case .done: return .idle
            case .idle, .sending, .queued, .taken, .failed, .timedOut: return self
            }
        }
    }

    /// What a cancelled command's failure says (the backend's own note too).
    public static let cancelledReason = "Cancelled"

    /// While the control takes no taps: on its way, or just done and waiting
    /// for the row it changed to catch up.
    public var locked: Bool {
        switch self {
        case .sending, .queued, .taken, .done: true
        case .idle, .failed, .timedOut: false
        }
    }

    /// While a change made at once on the screen should stay made: everything
    /// but nothing sent, a failure, and a send that timed out before the
    /// backend had it (it may never have gone), which put it back.
    public var holdsChange: Bool {
        switch self {
        case .sending, .queued, .taken, .done: true
        case let .timedOut(id, _): id != nil
        case .idle, .failed: false
        }
    }

    /// Still to hear how it went.
    public var isWaiting: Bool {
        switch self {
        case .sending, .queued, .taken, .timedOut: true
        case .idle, .done, .failed: false
        }
    }

    public var isTimedOut: Bool {
        if case .timedOut = self { return true }
        return false
    }

    public var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }

    /// Done or failed: nothing more will move it but a settle or a tap.
    public var isFinished: Bool {
        switch self {
        case .done, .failed: true
        case .idle, .sending, .queued, .taken, .timedOut: false
        }
    }

    /// The backend's id for it, once it has one.
    public var id: String? {
        switch self {
        case let .queued(id, _), let .taken(id, _), let .done(id, _): id
        case let .failed(id, _), let .timedOut(id, _): id
        case .idle, .sending: nil
        }
    }

    /// When the clock should next look, or nil for nothing timing.
    public func deadlineAt(_ deadline: TimeInterval = PendingCommand.deadlineSeconds) -> Date? {
        switch self {
        case let .sending(since), let .queued(_, since), let .taken(_, since): since.addingTimeInterval(deadline)
        case .idle, .done, .failed, .timedOut: nil
        }
    }

    /// The failure's words, with the control's own when it said none; nil
    /// unless it failed (a cancel isn't a failure worth saying).
    public func failure(_ fallback: String) -> String? {
        guard case let .failed(_, reason) = self, reason != PendingCommand.cancelledReason else { return nil }
        guard let reason, !reason.trimmingCharacters(in: .whitespaces).isEmpty else { return fallback }
        return reason
    }

    /// The line shown by a control that's timed out: where it's got to.
    public var timedOutNote: String? {
        guard case let .timedOut(id, taken) = self else { return nil }
        if id == nil { return "The phone couldn't reach Threadbear's server. Try again." }
        return taken ? "The Mac has this but hasn't said how it went yet." : "The Mac hasn't picked this up. It may be asleep or offline; it runs when the Mac is back."
    }
}

/// What a pending command is about, so there's one of each at a time.
public enum CommandKey: Hashable, Sendable {
    case archive(String)
    case hibernate(String)
    case rename(String)
    case star(String)
    case wake(String)
    case markSeen(String)
    case unarchive(String)
    case stop(String)
    case press(threadId: String, buttonId: String)
    /// An approval, question or secret card, by its approval id.
    case card(String)
    /// A thread's design review being read or answered.
    case review(String)
    /// The message that answered a thread's card of asks or done card.
    case answer(String)
    /// Sharing it by link: on, off or a new link.
    case share(String)
    /// Model, effort, pool or login change from the composer picker (API 107).
    case settings(String)
}
