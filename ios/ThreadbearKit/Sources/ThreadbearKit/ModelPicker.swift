import Foundation

/// Desktop-parity model, effort, pool and login picker logic for mobile.
/// Mirrors `desktop/core/src/logins.rs`, `new_thread.rs`, `login_picker.rs`
/// and `composer.rs` so mobile shows the exact same pools, providers, models,
/// effort levels, usage warnings and login rows as the Mac app.
public enum ModelPicker {
    /// Sentinel pool column for the "No pool" tab when pools are in use and at
    /// least one login doesn't belong to any pool.
    public static let unpooledColumn = "@unpooled"
    /// Minimum remaining percent before a login is skipped in auto-pick.
    public static let pickFloor: Double = 1.0
    /// Remaining percent under which a chip or pool pill turns orange.
    public static let chipWarning: Double = 25.0
    /// Help text shown under "Auto" in the expanded Login list.
    public static let autoHelp = "The pool picks, and moves on when one runs out"

    public static let claudeEffortLevels = ["low", "medium", "high", "xhigh", "max"]
    public static let codexEffortLevels = ["low", "medium", "high", "xhigh", "max", "ultra"]

    // MARK: - Badges & Usage

    /// Orange under 25% remaining, red when blocked / signed out / plan ended.
    public enum ChipBadge: Sendable, Hashable {
        case low(String)
        case blocked
        case signedOut
        case planEnded

        public var isStop: Bool {
            switch self {
            case .low: false
            case .blocked, .signedOut, .planEnded: true
            }
        }

        public var label: String {
            switch self {
            case let .low(pct): pct
            case .blocked: "Limit reached"
            case .signedOut: "Signed out"
            case .planEnded: "Plan ended"
            }
        }
    }

    /// Effective usage for a login, treating signed-out / plan-ended as blocked.
    public static func effectiveUsage(of account: PhoneAccount) -> (windows: [PhoneUsageWindow], blocked: Bool)? {
        let hardBlocked = account.signedOut == true || account.planEnded == true
        if let usage = account.usage {
            return (usage.windows, (usage.blocked == true) || hardBlocked)
        }
        if hardBlocked {
            return ([], true)
        }
        return nil
    }

    /// The 5-hour and weekly windows, in that order.
    public static func mainWindows(of windows: [PhoneUsageWindow]) -> [PhoneUsageWindow] {
        ["five_hour", "weekly"].compactMap { kind in
            windows.first { $0.kind == kind }
        }
    }

    /// The tighter of the main windows (the first on a tie).
    public static func tightestWindow(of windows: [PhoneUsageWindow]) -> PhoneUsageWindow? {
        let main = mainWindows(of: windows)
        var best: PhoneUsageWindow?
        for w in main {
            if let current = best {
                if w.remainingPercent < current.remainingPercent { best = w }
            } else {
                best = w
            }
        }
        return best
    }

    /// Remaining percent of the tightest main window.
    public static func room(of windows: [PhoneUsageWindow]) -> Double? {
        tightestWindow(of: windows)?.remainingPercent
    }

    /// Whole-number percentage, floored so 99.6 never reads "100%".
    public static func percent(_ value: Double) -> String {
        "\(Int(floor(max(0, value))))%"
    }

    /// Whether a login is not blocked and has at least `pickFloor` remaining (or usage unknown).
    public static func hasRoom(_ account: PhoneAccount) -> Bool {
        guard let usage = effectiveUsage(of: account) else { return true }
        if usage.blocked { return false }
        if let left = room(of: usage.windows), left < pickFloor { return false }
        return true
    }

    /// Badge for a single login.
    public static func chipBadge(for account: PhoneAccount?) -> ChipBadge? {
        guard let account else { return nil }
        if account.planEnded == true { return .planEnded }
        if account.signedOut == true { return .signedOut }
        guard let usage = effectiveUsage(of: account) else { return nil }
        if usage.blocked { return .blocked }
        guard let left = room(of: usage.windows) else { return nil }
        if left < pickFloor { return .blocked }
        return left < chipWarning ? .low(percent(left)) : nil
    }

    /// Most room any login in `logins` has (a blocked login counts as 0).
    public static func bestRoom(of logins: [PhoneAccount]) -> Double? {
        var best: Double?
        for login in logins {
            guard let usage = effectiveUsage(of: login) else { continue }
            let left: Double? = usage.blocked ? 0.0 : room(of: usage.windows)
            guard let left else { continue }
            if let current = best {
                if left > current { best = left }
            } else {
                best = left
            }
        }
        return best
    }

    /// Badge for a group of logins (pool or unpooled bucket): only when every
    /// login in the group is running out or at its limit.
    public static func groupChipBadge(of logins: [PhoneAccount]) -> ChipBadge? {
        guard !logins.isEmpty else { return nil }
        let usages = logins.map { effectiveUsage(of: $0) }
        if usages.allSatisfy({ $0?.blocked == true }) {
            return .blocked
        }
        let allLow = usages.allSatisfy { u in
            guard let u else { return false }
            if u.blocked { return true }
            return room(of: u.windows).map { $0 < chipWarning } ?? false
        }
        guard allLow else { return nil }
        return bestRoom(of: logins).map { .low(percent($0)) }
    }

    public static func poolChipBadge(_ pool: PhoneUsagePool, accounts: [PhoneAccount]) -> ChipBadge? {
        groupChipBadge(of: poolLogins(pool, accounts: accounts))
    }

    private static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// "3:40 pm", "1 pm" on the hour.
    public static func clock(_ date: Date, calendar: Calendar = .current) -> String {
        let h = calendar.component(.hour, from: date)
        let m = calendar.component(.minute, from: date)
        let twelve = h % 12 == 0 ? 12 : h % 12
        let suffix = h < 12 ? "am" : "pm"
        return m == 0 ? "\(twelve) \(suffix)" : String(format: "%d:%02d %@", twelve, m, suffix)
    }

    /// "now", "3:40 pm", "tomorrow 1 pm", "Thu 1 pm", "12 Nov".
    public static func resetTime(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        if date <= now { return "now" }
        if calendar.isDate(date, inSameDayAs: now) { return clock(date, calendar: calendar) }
        let startNow = calendar.startOfDay(for: now)
        let startDate = calendar.startOfDay(for: date)
        let days = calendar.dateComponents([.day], from: startNow, to: startDate).day ?? 0
        if days == 1 { return "tomorrow \(clock(date, calendar: calendar))" }
        if days > 1 && days < 7 {
            let wd = max(1, min(7, calendar.component(.weekday, from: date))) - 1
            return "\(weekdays[wd]) \(clock(date, calendar: calendar))"
        }
        let day = calendar.component(.day, from: date)
        let month = max(1, min(12, calendar.component(.month, from: date))) - 1
        return "\(day) \(months[month])"
    }

    private static func shortWindowName(_ window: PhoneUsageWindow) -> String {
        switch window.kind {
        case "five_hour": "5h"
        case "weekly": "week"
        default: window.title
        }
    }

    /// "5h 89% · week 78%, resets Thu 1 pm" or "Limit reached, resets 3:40 pm".
    public static func menuLine(for account: PhoneAccount, now: Date = .now, calendar: Calendar = .current) -> String? {
        guard let usage = effectiveUsage(of: account) else { return nil }
        let main = mainWindows(of: usage.windows)
        if usage.blocked {
            let reset = main.filter { $0.remainingPercent < 1.0 }.compactMap(\.resetsAt).min()
                ?? main.compactMap(\.resetsAt).min()
            if let reset {
                return "Limit reached, resets \(resetTime(reset, now: now, calendar: calendar))"
            }
            return "Limit reached"
        }
        guard !main.isEmpty else { return nil }
        var line = main.map { "\(shortWindowName($0)) \(percent($0.remainingPercent))" }.joined(separator: " · ")
        if let reset = tightestWindow(of: usage.windows)?.resetsAt {
            line += ", resets \(resetTime(reset, now: now, calendar: calendar))"
        }
        return line
    }

    /// A login's subtitle: note then room line (or Plan ended / Signed out).
    public static func subtitle(for account: PhoneAccount, now: Date = .now, calendar: Calendar = .current) -> String? {
        let usageLine: String? = if account.planEnded == true {
            "Plan ended"
        } else if account.signedOut == true {
            "Signed out"
        } else {
            menuLine(for: account, now: now, calendar: calendar)
        }
        let parts = [account.note, usageLine].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: - Names

    public static func providerTitle(_ id: String) -> String {
        switch id {
        case "claude", "": "Claude"
        case "codex": "Codex"
        case "opencode": "OpenCode"
        case "gemini": "Gemini"
        case "grok": "Grok"
        default:
            id.prefix(1).uppercased() + id.dropFirst()
        }
    }

    public static func effortTitle(_ level: String) -> String {
        switch level {
        case "xhigh": "Extra high"
        case "max": "Max"
        case "": ""
        default: capitalized(level)
        }
    }

    /// Compact label for segmented control where horizontal space is tight.
    public static func effortShortTitle(_ level: String) -> String {
        switch level {
        case "xhigh": "X-High"
        case "medium": "Med"
        default: effortTitle(level)
        }
    }

    /// Desktop `composer::model_title`.
    public static func modelTitle(_ model: String?) -> String {
        guard let model, !model.isEmpty else { return "Default" }
        if model.allSatisfy(\.isLetter) { return capitalized(model) }
        if model.lowercased().hasPrefix("gpt-") {
            return model.split(separator: "-").enumerated().map { idx, part in
                idx == 0 ? part.uppercased() : capitalized(String(part))
            }.joined(separator: "-")
        }
        var parts = model.split(separator: "-").map(String.init).filter { !$0.isEmpty }
        guard parts.first == "claude" else { return model }
        parts.removeFirst()
        if let last = parts.last, last.count == 8, last.allSatisfy(\.isASCII), last.allSatisfy(\.isNumber) {
            parts.removeLast()
        }
        guard let family = parts.first,
              parts.count >= 2,
              family.allSatisfy(\.isLetter),
              parts.dropFirst().allSatisfy({ $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) })
        else { return model }
        return "\(capitalized(family)) \(parts.dropFirst().joined(separator: "."))"
    }

    private static func capitalized(_ word: String) -> String {
        guard let first = word.first else { return "" }
        return first.uppercased() + word.dropFirst().lowercased()
    }

    private static func localPart(_ address: String) -> String {
        address.split(separator: "@", maxSplits: 1).first.map(String.init) ?? address
    }

    private static func domainPart(_ address: String) -> String? {
        guard let at = address.firstIndex(of: "@") else { return nil }
        let after = address[address.index(after: at)...]
        let first = after.split(separator: ".", maxSplits: 1).first.map(String.init) ?? ""
        return first.isEmpty ? nil : first
    }

    public static func twinLabel(for account: PhoneAccount, in accounts: [PhoneAccount]) -> String? {
        guard let email = account.email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !email.isEmpty else { return nil }
        let hasTwin = accounts.contains { other in
            other.id != account.id
                && other.providerId == account.providerId
                && other.email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == email
        }
        guard hasTwin else { return nil }
        let note = account.note?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return note.isEmpty ? account.id : note
    }

    public static func shortAccountName(_ id: String, in accounts: [PhoneAccount]) -> String {
        guard let account = accounts.first(where: { $0.id == id }) else { return id }
        if let twin = twinLabel(for: account, in: accounts) { return twin }
        let full = account.displayName
        let siblings = accounts.filter { $0.id != id && $0.providerId == account.providerId }
        if account.providerId == "codex" {
            if siblings.isEmpty { return "Codex" }
            let local = localPart(full)
            if siblings.contains(where: { localPart($0.displayName) == local }) {
                return "Codex \(full)"
            }
            return "Codex \(local)"
        }
        let local = localPart(full)
        if siblings.contains(where: { localPart($0.displayName) == local }) {
            return full
        }
        return local
    }

    /// Short login name for the Login line & rows ("acme" for alex@acme.io,
    /// falling back to local part or full email on collision).
    public static func loginName(_ id: String, in accounts: [PhoneAccount]) -> String {
        guard let account = accounts.first(where: { $0.id == id }) else { return id }
        if account.providerId == "codex" { return shortAccountName(id, in: accounts) }
        let full = account.displayName
        guard let domain = domainPart(full) else { return full }
        let siblings = accounts.filter { $0.id != id && $0.providerId == account.providerId }.map(\.displayName)
        if !siblings.contains(where: { domainPart($0) == domain }) { return domain }
        let local = localPart(full)
        return siblings.contains(where: { localPart($0) == local }) ? full : local
    }

    // MARK: - Pools & Providers

    public static func poolLogins(_ pool: PhoneUsagePool, accounts: [PhoneAccount], provider: String? = nil) -> [PhoneAccount] {
        pool.accountIds.compactMap { id in accounts.first { $0.id == id } }
            .filter { a in provider.map { a.providerId == $0 } ?? true }
    }

    public static func poolProviders(_ pool: PhoneUsagePool, accounts: [PhoneAccount]) -> [String] {
        var seen: [String] = []
        for account in poolLogins(pool, accounts: accounts) {
            let p = account.providerId
            if !seen.contains(p) { seen.append(p) }
        }
        return seen
    }

    public static func unpooledLogins(pools: [PhoneUsagePool], accounts: [PhoneAccount], provider: String? = nil) -> [PhoneAccount] {
        let pooledIds = Set(pools.flatMap(\.accountIds))
        return accounts.filter { !pooledIds.contains($0.id) }
            .filter { a in provider.map { a.providerId == $0 } ?? true }
    }

    public static func unpooledProviders(pools: [PhoneUsagePool], accounts: [PhoneAccount]) -> [String] {
        var order: [String] = []
        for account in unpooledLogins(pools: pools, accounts: accounts) {
            let p = account.providerId
            if !order.contains(p) { order.append(p) }
        }
        return sortProviders(order)
    }

    private static func sortProviders(_ providers: [String]) -> [String] {
        func rank(_ p: String) -> Int {
            switch p {
            case "claude": 0
            case "codex": 1
            default: 2
            }
        }
        return providers.enumerated().sorted { a, b in
            let ra = rank(a.element), rb = rank(b.element)
            return ra != rb ? ra < rb : a.offset < b.offset
        }.map(\.element)
    }

    public static func pickUnpooledLogin(
        pools: [PhoneUsagePool],
        accounts: [PhoneAccount],
        provider: String,
        current: String? = nil
    ) -> String? {
        let own = unpooledLogins(pools: pools, accounts: accounts, provider: provider)
        if let current, own.contains(where: { $0.id == current }) { return current }
        var best: (PhoneAccount, Double)?
        for login in own where hasRoom(login) {
            guard let usage = effectiveUsage(of: login), let left = room(of: usage.windows) else { continue }
            if best == nil || left > best!.1 { best = (login, left) }
        }
        if let best { return best.0.id }
        return own.first(where: { hasRoom($0) })?.id ?? own.first?.id
    }

    private static func weeklyResetMinutes(_ account: PhoneAccount, now: Date) -> Double {
        guard let reset = effectiveUsage(of: account)?.windows.first(where: { $0.kind == "weekly" })?.resetsAt,
              reset > now else { return .infinity }
        return (reset.timeIntervalSince1970 * 1000.0 / 60_000.0).rounded()
    }

    public static func pickLogin(
        pool: PhoneUsagePool,
        accounts: [PhoneAccount],
        provider: String,
        current: String? = nil,
        now: Date = .now
    ) -> String? {
        let own = poolLogins(pool, accounts: accounts, provider: provider)
        if let current, own.contains(where: { $0.id == current && hasRoom($0) }) { return current }
        let open = own.filter { hasRoom($0) }
        var best: (id: String, room: Double, reset: Double)?
        for login in open {
            guard let usage = effectiveUsage(of: login), let left = room(of: usage.windows) else { continue }
            let reset = weeklyResetMinutes(login, now: now)
            if let have = best {
                if !(reset < have.reset || (reset == have.reset && left > have.room)) { continue }
            }
            best = (login.id, left, reset)
        }
        if let best { return best.id }
        return open.first?.id ?? own.first?.id
    }

    // MARK: - Model & Effort Helpers

    public static func choice(for id: String, in choices: [PhoneModelChoice]) -> PhoneModelChoice? {
        choices.first { $0.id == id } ?? choices.first { $0.model == id }
    }

    public static func resolvedModel(_ ids: [String?]) -> String? {
        for id in ids {
            if let id, !id.isEmpty { return id }
        }
        return nil
    }

    public static func modelTitle(id: String?, in choices: [PhoneModelChoice]) -> String {
        guard let id, !id.isEmpty else { return "Default" }
        return choice(for: id, in: choices)?.title ?? modelTitle(id)
    }

    public static func chipTitle(model: String?, effort: String?, choices: [PhoneModelChoice]) -> String {
        let title = modelTitle(id: model, in: choices)
        guard let effort, !effort.isEmpty else { return title }
        return "\(title) · \(effortTitle(effort))"
    }

    public static func effortLevels(for model: String?, choices: [PhoneModelChoice], provider: String) -> [String] {
        if let model, let found = choice(for: model, in: choices) {
            if let levels = found.effortLevels, !levels.isEmpty {
                return levels
            }
            if choices.contains(where: { !($0.effortLevels ?? []).isEmpty }) {
                return []
            }
        }
        switch provider {
        case "codex": return codexEffortLevels
        case "claude", "": return claudeEffortLevels
        default: return []
        }
    }

    public static func impliedEffort(
        model: String?,
        choices: [PhoneModelChoice],
        account: PhoneAccount?,
        runnerDefault: String?
    ) -> String? {
        if let d = runnerDefault, !d.isEmpty { return d }
        if let own = account?.defaultEffort, !own.isEmpty { return own }
        if let model { return choice(for: model, in: choices)?.defaultEffort }
        return nil
    }

    public static func pickerRows(
        choices: [PhoneModelChoice],
        defaultId: String?,
        selected: String?,
        query: String,
        provider: String
    ) -> [PickerModelRow] {
        let nonClaude = provider != "claude" && !provider.isEmpty
        let known: [PhoneModelChoice]
        if !choices.isEmpty {
            known = choices
        } else if nonClaude {
            if let defaultId, !defaultId.isEmpty {
                known = [PhoneModelChoice(id: defaultId, model: defaultId, title: modelTitle(defaultId))]
            } else {
                known = []
            }
        } else {
            known = ["opus", "sonnet", "haiku"].map {
                PhoneModelChoice(id: $0, model: $0, title: modelTitle($0))
            }
        }

        func matches(_ c: PhoneModelChoice, _ id: String?) -> Bool {
            guard let id, !id.isEmpty else { return false }
            return c.id == id || c.model == id
        }

        func isMain(_ c: PhoneModelChoice) -> Bool {
            nonClaude || c.id.allSatisfy(\.isLetter) || matches(c, defaultId) || matches(c, selected)
        }

        var rows: [PickerModelRow] = []
        var seen = Set<String>()
        func add(_ c: PhoneModelChoice, older: Bool) {
            let fullModel = (c.model?.isEmpty == false) ? c.model! : c.id
            guard seen.insert(fullModel).inserted else { return }
            rows.append(PickerModelRow(
                id: c.id,
                model: fullModel,
                title: c.title.isEmpty ? c.id : c.title,
                subtitle: c.description?.isEmpty == false ? c.description : nil,
                isDefault: matches(c, defaultId),
                isSelected: matches(c, selected),
                isOlder: older
            ))
        }

        for c in known where isMain(c) { add(c, older: false) }
        if let selected, !selected.isEmpty, !known.contains(where: { matches($0, selected) }) {
            rows.append(PickerModelRow(
                id: selected,
                model: selected,
                title: modelTitle(selected),
                subtitle: nil,
                isDefault: false,
                isSelected: true,
                isOlder: false
            ))
        }
        for c in known where !isMain(c) { add(c, older: true) }

        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return rows }
        return rows.compactMap { row in
            let hit = row.title.lowercased().contains(needle)
                || row.id.lowercased().contains(needle)
                || row.model.lowercased().contains(needle)
                || (row.subtitle?.lowercased().contains(needle) ?? false)
            guard hit else { return nil }
            var copy = row
            copy.isOlder = false
            return copy
        }
    }
}

// MARK: - View Models for the Picker Sheet

public struct PickerPoolTab: Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var count: Int
    public var bestRoom: Double?
    public var badge: ModelPicker.ChipBadge?
    public var isUnpooled: Bool

    public init(id: String, title: String, count: Int, bestRoom: Double? = nil, badge: ModelPicker.ChipBadge? = nil, isUnpooled: Bool = false) {
        self.id = id
        self.title = title
        self.count = count
        self.bestRoom = bestRoom
        self.badge = badge
        self.isUnpooled = isUnpooled
    }

    public var roomWords: String? {
        if let badge {
            switch badge {
            case .blocked: return "Limit"
            case .signedOut: return "Signed out"
            case .planEnded: return "Plan ended"
            case let .low(pct): return pct
            }
        }
        return bestRoom.map { ModelPicker.percent($0) }
    }
}

public struct PickerModelRow: Sendable, Hashable, Identifiable {
    public var id: String
    public var model: String
    public var title: String
    public var subtitle: String?
    public var isDefault: Bool
    public var isSelected: Bool
    public var isOlder: Bool

    public init(id: String, model: String, title: String, subtitle: String? = nil, isDefault: Bool = false, isSelected: Bool = false, isOlder: Bool = false) {
        self.id = id
        self.model = model
        self.title = title
        self.subtitle = subtitle
        self.isDefault = isDefault
        self.isSelected = isSelected
        self.isOlder = isOlder
    }
}

public struct PickerModelSection: Sendable, Hashable, Identifiable {
    public var id: String { provider }
    public var provider: String
    public var title: String?
    public var rows: [PickerModelRow]

    public init(provider: String, title: String? = nil, rows: [PickerModelRow]) {
        self.provider = provider
        self.title = title
        self.rows = rows
    }
}

public struct PickerLoginRow: Sendable, Hashable, Identifiable {
    public var id: String
    public var accountId: String?
    public var title: String
    public var subtitle: String?
    public var room: Double?
    public var badge: ModelPicker.ChipBadge?
    public var isSelected: Bool

    public init(id: String, accountId: String?, title: String, subtitle: String? = nil, room: Double? = nil, badge: ModelPicker.ChipBadge? = nil, isSelected: Bool = false) {
        self.id = id
        self.accountId = accountId
        self.title = title
        self.subtitle = subtitle
        self.room = room
        self.badge = badge
        self.isSelected = isSelected
    }

    public var roomWords: String? {
        if let badge {
            switch badge {
            case .blocked: return "limit"
            case .signedOut: return "signed out"
            case .planEnded: return "plan ended"
            case .low: break
            }
        }
        return room.map { ModelPicker.percent($0) }
    }
}

// MARK: - Picker Context (for both New Thread and Existing Thread)

/// Resolved model/pool/provider/effort/login state for either an existing thread
/// or a new-thread draft on a specific runner.
public struct ModelPickerContext: Sendable, Hashable {
    public var pools: [PhoneUsagePool]
    public var accounts: [PhoneAccount]
    public var defaults: PhoneRunnerDefaults?
    public var accountId: String
    public var provider: String
    public var poolId: String?
    public var model: String?
    public var modelInUse: String?
    public var effort: String?
    public var effortInUse: String?
    public var isNew: Bool

    public init(
        pools: [PhoneUsagePool],
        accounts: [PhoneAccount],
        defaults: PhoneRunnerDefaults?,
        accountId: String,
        provider: String,
        poolId: String?,
        model: String?,
        modelInUse: String? = nil,
        effort: String?,
        effortInUse: String? = nil,
        isNew: Bool
    ) {
        self.pools = pools
        self.accounts = accounts
        self.defaults = defaults
        self.accountId = accountId
        self.provider = provider.isEmpty ? "claude" : provider
        self.poolId = poolId
        self.model = model
        self.modelInUse = modelInUse
        self.effort = effort
        self.effortInUse = effortInUse
        self.isNew = isNew
    }

    /// Context for an existing thread on its runner.
    public static func forThread(_ thread: PhoneThread, runner: PhoneRunner?, accounts: [PhoneAccount]) -> ModelPickerContext {
        let runnerAccounts = accounts.filter { $0.runnerId == nil || $0.runnerId == thread.runnerId }
        return ModelPickerContext(
            pools: runner?.usagePools ?? [],
            accounts: runnerAccounts,
            defaults: runner?.defaults,
            accountId: thread.accountId,
            provider: thread.provider,
            poolId: thread.poolId,
            model: thread.model,
            modelInUse: thread.modelInUse,
            effort: thread.effort,
            effortInUse: thread.effortInUse,
            isNew: false
        )
    }

    /// Context for a new-thread draft on a chosen runner.
    public static func forNewThread(
        settings: NewThreadSettings,
        runner: PhoneRunner?,
        accounts: [PhoneAccount],
        now: Date = .now
    ) -> ModelPickerContext {
        let runnerId = runner?.runnerId
        let runnerAccounts = runnerId == nil
            ? accounts
            : accounts.filter { $0.runnerId == nil || $0.runnerId == runnerId }
        let pools = runner?.usagePools ?? []
        let defaults = runner?.defaults

        // Resolve pool & account & provider from explicit draft settings, else runner defaults.
        let resolvedPoolId: String?
        let resolvedAccountId: String
        let resolvedProvider: String

        if let explicitAccount = settings.accountId,
           let account = runnerAccounts.first(where: { $0.id == explicitAccount }) {
            resolvedPoolId = nil
            resolvedAccountId = account.id
            resolvedProvider = settings.provider ?? account.providerId
        } else if !pools.isEmpty {
            let pool = settings.poolId.flatMap { id in pools.first { $0.id == id } }
                ?? defaults?.poolId.flatMap { id in pools.first { $0.id == id } }
                ?? pools.first
            resolvedPoolId = pool?.id
            let poolProvs = pool.map { ModelPicker.poolProviders($0, accounts: runnerAccounts) } ?? []
            let defaultAccountProvider = defaults?.accountId
                .flatMap { id in runnerAccounts.first { $0.id == id }?.providerId }
            let provider = [settings.provider, defaultAccountProvider, poolProvs.first]
                .compactMap { $0 }
                .first { p in poolProvs.isEmpty || poolProvs.contains(p) }
                ?? "claude"
            resolvedProvider = provider
            resolvedAccountId = pool.flatMap {
                ModelPicker.pickLogin(pool: $0, accounts: runnerAccounts, provider: provider, current: defaults?.accountId, now: now)
            } ?? defaults?.accountId ?? runnerAccounts.first(where: { $0.providerId == provider })?.id ?? ""
        } else {
            resolvedPoolId = nil
            let account = defaults?.accountId.flatMap { id in runnerAccounts.first { $0.id == id } }
                ?? runnerAccounts.first
            resolvedAccountId = account?.id ?? ""
            resolvedProvider = settings.provider ?? account?.providerId ?? "claude"
        }

        return ModelPickerContext(
            pools: pools,
            accounts: runnerAccounts,
            defaults: defaults,
            accountId: resolvedAccountId,
            provider: resolvedProvider,
            poolId: resolvedPoolId,
            model: settings.model,
            modelInUse: nil,
            effort: settings.effort,
            effortInUse: nil,
            isNew: true
        )
    }

    public var usesPools: Bool { !pools.isEmpty }

    public var pool: PhoneUsagePool? {
        guard usesPools, let poolId else { return nil }
        return pools.first { $0.id == poolId }
    }

    public func account(_ id: String) -> PhoneAccount? {
        accounts.first { $0.id == id }
    }

    public func pool(_ id: String) -> PhoneUsagePool? {
        pools.first { $0.id == id }
    }

    public var unpooledAccounts: [PhoneAccount] {
        ModelPicker.unpooledLogins(pools: pools, accounts: accounts)
    }

    public var hasUnpooled: Bool {
        usesPools && !unpooledAccounts.isEmpty
    }

    public var isPinnedToUnpooled: Bool {
        usesPools && pool == nil && account(accountId) != nil && !pools.contains { $0.accountIds.contains(accountId) }
    }

    public var choices: [PhoneModelChoice] {
        if let own = account(accountId), !own.models.isEmpty { return own.models }
        if let pool {
            if let first = ModelPicker.poolLogins(pool, accounts: accounts, provider: provider).first(where: { !$0.models.isEmpty }) {
                return first.models
            }
        }
        return accounts.first(where: { $0.providerId == provider && !$0.models.isEmpty })?.models ?? []
    }

    public func runnerDefaultModel(for provider: String) -> String? {
        defaults?.models?[provider]
    }

    public var defaultModel: String? {
        let primary = isNew ? runnerDefaultModel(for: provider) : modelInUse
        return ModelPicker.resolvedModel([
            primary,
            account(accountId)?.defaultModel,
            runnerDefaultModel(for: provider),
        ])
    }

    public var effectiveModel: String? {
        ModelPicker.resolvedModel([model, defaultModel])
    }

    public var effectiveEffort: String? {
        let levels = effortLevels
        if levels.isEmpty { return nil }
        let runnerDefault = isNew ? defaults?.efforts?[provider] : nil
        let candidate = effort ?? effortInUse ?? ModelPicker.impliedEffort(
            model: effectiveModel,
            choices: choices,
            account: account(accountId),
            runnerDefault: runnerDefault
        )
        if let candidate, levels.contains(candidate) { return candidate }
        return candidate
    }

    public var effortLevels: [String] {
        ModelPicker.effortLevels(for: effectiveModel, choices: choices, provider: provider)
    }

    /// Pool title or pinned login name at the front of the model chip.
    public var owner: String? {
        guard usesPools else { return nil }
        if let pool { return pool.title }
        guard account(accountId) != nil else { return nil }
        return ModelPicker.loginName(accountId, in: accounts)
    }

    /// Chip title: "Main · Opus 5.5 · High" or "Opus 5.5 · High".
    public var chipTitle: String {
        let rest = ModelPicker.chipTitle(model: effectiveModel, effort: effectiveEffort, choices: choices)
        if let owner, !owner.isEmpty { return "\(owner) · \(rest)" }
        return rest
    }

    /// Chip warning badge (orange <25% or red at limit).
    public var chipBadge: ModelPicker.ChipBadge? {
        if usesPools {
            if let pool { return ModelPicker.poolChipBadge(pool, accounts: accounts) }
            return ModelPicker.chipBadge(for: account(accountId))
        }
        return ModelPicker.chipBadge(for: account(accountId))
    }

    /// Tabs for the pool strip (pools + optional "No pool" tab).
    public var poolTabs: [PickerPoolTab] {
        guard usesPools else { return [] }
        var tabs = pools.map { p in
            let logins = ModelPicker.poolLogins(p, accounts: accounts)
            return PickerPoolTab(
                id: p.id,
                title: p.title,
                count: logins.count,
                bestRoom: ModelPicker.bestRoom(of: logins),
                badge: ModelPicker.groupChipBadge(of: logins),
                isUnpooled: false
            )
        }
        if hasUnpooled {
            let unpooled = unpooledAccounts
            tabs.append(PickerPoolTab(
                id: ModelPicker.unpooledColumn,
                title: "No pool",
                count: unpooled.count,
                bestRoom: ModelPicker.bestRoom(of: unpooled),
                badge: ModelPicker.groupChipBadge(of: unpooled),
                isUnpooled: true
            ))
        }
        return tabs
    }

    /// Which pool tab should be selected initially or after state updates.
    public func resolvePickerPool(picked: String?) -> String {
        guard usesPools else { return provider }
        if let picked {
            if picked == ModelPicker.unpooledColumn, hasUnpooled { return picked }
            if pool(picked) != nil { return picked }
        }
        if let pool { return pool.id }
        if isPinnedToUnpooled { return ModelPicker.unpooledColumn }
        if let holding = pools.first(where: { $0.accountIds.contains(accountId) }) {
            return holding.id
        }
        return pools.first?.id ?? ModelPicker.unpooledColumn
    }

    /// Providers shown in the provider bar for `column`.
    public func pickerProviders(for column: String) -> [String] {
        if !usesPools {
            var seen: [String] = []
            for a in accounts {
                let p = a.providerId
                if !seen.contains(p) { seen.append(p) }
            }
            return seen.isEmpty ? [provider] : seen
        }
        if column == ModelPicker.unpooledColumn {
            return ModelPicker.unpooledProviders(pools: pools, accounts: accounts)
        }
        if let shown = pool(column) {
            return ModelPicker.poolProviders(shown, accounts: accounts)
        }
        return [provider]
    }

    /// Active provider in the provider bar for `column`.
    public func resolvePickerProvider(for column: String, picked: String?) -> String? {
        let list = pickerProviders(for: column)
        if let picked, list.contains(picked) { return picked }
        if list.contains(provider) { return provider }
        return list.first
    }

    private func groupProviderRows(own: Bool, logins: [PhoneAccount], provider: String, query: String) -> [PickerModelRow] {
        let listing = logins.first(where: { !$0.models.isEmpty }) ?? logins.first
        if own {
            let ownChoices = choices.isEmpty ? (listing?.models ?? []) : choices
            let def = defaultModel ?? listing?.defaultModel
            let chosen = ModelPicker.resolvedModel([model, def])
            return ModelPicker.pickerRows(choices: ownChoices, defaultId: def, selected: chosen, query: query, provider: provider)
        } else {
            let def = runnerDefaultModel(for: provider) ?? listing?.defaultModel
            return ModelPicker.pickerRows(choices: listing?.models ?? [], defaultId: def, selected: nil, query: query, provider: provider)
        }
    }

    private func rowsWithoutPools(for targetProvider: String, query: String) -> [PickerModelRow] {
        let own = targetProvider == provider
        let listing = own
            ? (account(accountId) ?? accounts.first(where: { $0.providerId == targetProvider }))
            : accounts.first(where: { $0.providerId == targetProvider && !$0.models.isEmpty })
                ?? accounts.first(where: { $0.providerId == targetProvider })
        let def = own ? defaultModel : (runnerDefaultModel(for: targetProvider) ?? listing?.defaultModel)
        return ModelPicker.pickerRows(
            choices: listing?.models ?? [],
            defaultId: def,
            selected: own ? effectiveModel : nil,
            query: query,
            provider: targetProvider
        )
    }

    /// Model sections for the active pool column, provider, and search query.
    /// Empty query shows only the active provider; non-empty query searches all
    /// providers in the active pool (active provider first) and flattens Older.
    public func sections(for column: String, provider activeProvider: String?, query: String) -> [PickerModelSection] {
        let searching = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if !usesPools {
            if searching {
                var found = pickerProviders(for: column).compactMap { p -> PickerModelSection? in
                    let rows = rowsWithoutPools(for: p, query: query)
                    return rows.isEmpty ? nil : PickerModelSection(provider: p, title: ModelPicker.providerTitle(p), rows: rows)
                }
                if let activeProvider {
                    found.sort { ($0.provider == activeProvider ? 0 : 1) < ($1.provider == activeProvider ? 0 : 1) }
                }
                return found
            }
            guard let activeProvider else { return [] }
            let rows = rowsWithoutPools(for: activeProvider, query: "")
            return rows.isEmpty ? [] : [PickerModelSection(provider: activeProvider, title: nil, rows: rows)]
        }

        let isUnpooled = column == ModelPicker.unpooledColumn
        let shown = isUnpooled ? nil : pool(column)
        let providers = pickerProviders(for: column)

        func rowsFor(_ targetProvider: String, query q: String) -> [PickerModelRow] {
            if isUnpooled {
                let own = isPinnedToUnpooled && targetProvider == provider
                let logins = ModelPicker.unpooledLogins(pools: pools, accounts: accounts, provider: targetProvider)
                return groupProviderRows(own: own, logins: logins, provider: targetProvider, query: q)
            }
            guard let shown else {
                return rowsWithoutPools(for: targetProvider, query: q)
            }
            let inShown = (pool?.id == shown.id) || (pool == nil && shown.accountIds.contains(accountId))
            let own = inShown && targetProvider == provider
            let logins = ModelPicker.poolLogins(shown, accounts: accounts, provider: targetProvider)
            return groupProviderRows(own: own, logins: logins, provider: targetProvider, query: q)
        }

        if searching {
            var found = providers.compactMap { p -> PickerModelSection? in
                let rows = rowsFor(p, query: query)
                return rows.isEmpty ? nil : PickerModelSection(provider: p, title: ModelPicker.providerTitle(p), rows: rows)
            }
            if let activeProvider {
                found.sort { ($0.provider == activeProvider ? 0 : 1) < ($1.provider == activeProvider ? 0 : 1) }
            }
            return found
        }

        guard let activeProvider else { return [] }
        let rows = rowsFor(activeProvider, query: "")
        return rows.isEmpty ? [] : [PickerModelSection(provider: activeProvider, title: nil, rows: rows)]
    }

    // MARK: - Login Footer

    /// Closed Login line: ("Login: Auto", "(acme for now)") or ("Login: solo", "(not in a pool)").
    public var loginLine: (primary: String, detail: String?) {
        if let pool {
            let on: String?
            if !accountId.isEmpty, pool.accountIds.contains(accountId), account(accountId) != nil {
                on = "(\(ModelPicker.loginName(accountId, in: accounts)) for now)"
            } else {
                on = nil
            }
            return ("Login: Auto", on)
        }
        let name = accountId.isEmpty ? "Default" : ModelPicker.loginName(accountId, in: accounts)
        return ("Login: \(name)", isPinnedToUnpooled ? "(not in a pool)" : nil)
    }

    private func loginRow(for account: PhoneAccount, isSelected: Bool, now: Date, calendar: Calendar) -> PickerLoginRow {
        let usage = ModelPicker.effectiveUsage(of: account)
        let left = usage.flatMap { ModelPicker.room(of: $0.windows) }
        let blocked = (usage?.blocked == true) || (left.map { $0 < ModelPicker.pickFloor } ?? false)
        let badge: ModelPicker.ChipBadge?
        if account.planEnded == true {
            badge = .planEnded
        } else if account.signedOut == true {
            badge = .signedOut
        } else if blocked {
            badge = .blocked
        } else {
            badge = ModelPicker.chipBadge(for: account)
        }
        return PickerLoginRow(
            id: account.id,
            accountId: account.id,
            title: ModelPicker.loginName(account.id, in: accounts),
            subtitle: ModelPicker.subtitle(for: account, now: now, calendar: calendar),
            room: blocked ? 0.0 : left,
            badge: badge,
            isSelected: isSelected
        )
    }

    /// Rows in the expanded Login list for `column` (and `provider` when unpooled or without pools).
    public func loginRows(for column: String, provider activeProvider: String?, now: Date = .now, calendar: Calendar = .current) -> [PickerLoginRow] {
        if !usesPools {
            let list = activeProvider.map { p in accounts.filter { $0.providerId == p } } ?? accounts
            return list.map { a in
                loginRow(for: a, isSelected: a.id == accountId, now: now, calendar: calendar)
            }
        }
        if column == ModelPicker.unpooledColumn {
            let list = ModelPicker.unpooledLogins(pools: pools, accounts: accounts, provider: activeProvider)
            return list.map { a in
                loginRow(for: a, isSelected: pool == nil && accountId == a.id, now: now, calendar: calendar)
            }
        }
        guard let shown = pool(column) else { return [] }
        var rows: [PickerLoginRow] = [
            PickerLoginRow(
                id: "@auto",
                accountId: nil,
                title: "Auto",
                subtitle: ModelPicker.autoHelp,
                room: nil,
                badge: nil,
                isSelected: pool?.id == shown.id
            )
        ]
        var logins = ModelPicker.poolLogins(shown, accounts: accounts)
        if pool == nil, let pinned = account(accountId), !logins.contains(where: { $0.id == pinned.id }) {
            logins.insert(pinned, at: 0)
        }
        for login in logins {
            rows.append(loginRow(for: login, isSelected: pool == nil && accountId == login.id, now: now, calendar: calendar))
        }
        return rows
    }

    // MARK: - Change Builders (Existing Thread)

    /// Builds the `ThreadSettingsChange` for tapping a model row, matching desktop `composer_chips.rs`.
    public func changeForPickingModel(row: PickerModelRow, column: String, provider targetProvider: String) -> ThreadSettingsChange? {
        let modelField: SettingsField = row.isDefault ? .clear : .set(row.id)
        if usesPools {
            if column == ModelPicker.unpooledColumn {
                if isPinnedToUnpooled && targetProvider == provider {
                    return ThreadSettingsChange(model: modelField)
                }
                guard let pickedAccount = ModelPicker.pickUnpooledLogin(
                    pools: pools,
                    accounts: accounts,
                    provider: targetProvider
                ) else { return nil }
                return ThreadSettingsChange(accountId: pickedAccount, model: .set(row.id))
            }
            if pool?.id == column && targetProvider == provider {
                return ThreadSettingsChange(model: modelField)
            }
            if pool == nil, let shown = pool(column), shown.accountIds.contains(accountId), targetProvider == provider {
                return ThreadSettingsChange(model: modelField)
            }
            return ThreadSettingsChange(poolId: .set(column), provider: targetProvider, model: .set(row.id))
        }
        if targetProvider == provider {
            return ThreadSettingsChange(model: modelField)
        }
        guard let targetAccount = accounts.first(where: { $0.providerId == targetProvider }) else { return nil }
        return ThreadSettingsChange(accountId: targetAccount.id, model: modelField)
    }

    /// Builds the `ThreadSettingsChange` for tapping an effort segment.
    public func changeForEffort(_ level: String) -> ThreadSettingsChange {
        ThreadSettingsChange(effort: .set(level))
    }

    /// Builds the `ThreadSettingsChange` for picking Auto (`accountId == nil`) or pinning to a login.
    public func changeForLogin(accountId targetAccountId: String?, column: String) -> ThreadSettingsChange? {
        if let targetAccountId {
            if pool == nil && accountId == targetAccountId { return nil }
            return ThreadSettingsChange(accountId: targetAccountId)
        }
        guard usesPools, pool?.id != column, pool(column) != nil else { return nil }
        return ThreadSettingsChange(poolId: .set(column))
    }

    /// Optimistically applies `change` to `thread` so the chip updates immediately.
    public func applyingOptimistic(_ change: ThreadSettingsChange, to thread: PhoneThread, now: Date = .now) -> PhoneThread {
        var next = thread
        if let newAccount = change.accountId {
            next.accountId = newAccount
            next.poolId = nil
            if let acc = account(newAccount), acc.providerId != next.provider {
                next.provider = acc.providerId
                next.model = runnerDefaultModel(for: acc.providerId)
                next.modelInUse = nil
                next.effort = defaults?.efforts?[acc.providerId]
                next.effortInUse = nil
            }
        }
        switch change.poolId {
        case .keep: break
        case .clear: next.poolId = nil
        case let .set(newPoolId):
            next.poolId = newPoolId
            let targetProvider = change.provider ?? next.provider
            if let p = pool(newPoolId) {
                let providers = ModelPicker.poolProviders(p, accounts: accounts)
                let chosenProvider = providers.contains(targetProvider) ? targetProvider : (providers.first ?? targetProvider)
                if chosenProvider != next.provider {
                    next.provider = chosenProvider
                    next.model = runnerDefaultModel(for: chosenProvider)
                    next.modelInUse = nil
                    next.effort = defaults?.efforts?[chosenProvider]
                    next.effortInUse = nil
                }
                if !p.accountIds.contains(next.accountId) || account(next.accountId)?.providerId != next.provider {
                    if let picked = ModelPicker.pickLogin(pool: p, accounts: accounts, provider: next.provider, now: now) {
                        next.accountId = picked
                    }
                }
            }
        }
        if let newProvider = change.provider, newProvider != next.provider {
            next.provider = newProvider
            next.modelInUse = nil
            next.effortInUse = nil
        }
        switch change.model {
        case .keep: break
        case .clear:
            next.model = nil
        case let .set(m):
            next.model = m
            next.modelInUse = nil
            // Drop effort if the new model doesn't support it.
            let targetChoices = account(next.accountId)?.models ?? choices
            let supported = ModelPicker.effortLevels(for: m, choices: targetChoices, provider: next.provider)
            if let eff = next.effort, !supported.contains(eff) {
                next.effort = nil
            }
        }
        switch change.effort {
        case .keep: break
        case .clear: next.effort = nil
        case let .set(e): next.effort = e
        }
        return next
    }

    // MARK: - Draft Updaters (New Thread)

    public func draftForPickingModel(
        _ current: NewThreadSettings,
        row: PickerModelRow,
        column: String,
        provider targetProvider: String
    ) -> NewThreadSettings {
        var next = current
        let sameProvider = targetProvider == provider
        if usesPools {
            if column == ModelPicker.unpooledColumn {
                if isPinnedToUnpooled && sameProvider {
                    next.model = row.isDefault ? nil : row.id
                } else if let picked = ModelPicker.pickUnpooledLogin(pools: pools, accounts: accounts, provider: targetProvider) {
                    next.poolId = nil
                    next.accountId = picked
                    next.provider = targetProvider
                    next.model = row.id
                }
            } else if pool?.id == column && sameProvider {
                next.model = row.isDefault ? nil : row.id
            } else if pool == nil, let shown = pool(column), shown.accountIds.contains(accountId), sameProvider {
                next.model = row.isDefault ? nil : row.id
            } else {
                next.poolId = column
                next.accountId = nil
                next.provider = targetProvider
                next.model = row.id
            }
        } else if sameProvider {
            next.model = row.isDefault ? nil : row.id
        } else if let targetAccount = accounts.first(where: { $0.providerId == targetProvider }) {
            next.accountId = targetAccount.id
            next.provider = targetProvider
            next.model = row.isDefault ? nil : row.id
        }
        // Clear effort if no longer valid for the newly chosen model/provider.
        let targetChoices = accounts.first(where: { $0.providerId == targetProvider && !$0.models.isEmpty })?.models ?? []
        let levels = ModelPicker.effortLevels(for: row.id, choices: targetChoices, provider: targetProvider)
        if let eff = next.effort, !levels.contains(eff) {
            next.effort = nil
        }
        return next
    }

    public func draftForEffort(_ current: NewThreadSettings, level: String) -> NewThreadSettings {
        var next = current
        next.effort = level
        return next
    }

    public func draftForLogin(_ current: NewThreadSettings, accountId targetAccountId: String?, column: String) -> NewThreadSettings {
        var next = current
        if let targetAccountId {
            next.poolId = nil
            next.accountId = targetAccountId
            if let acc = account(targetAccountId) {
                if acc.providerId != provider {
                    next.provider = acc.providerId
                    next.model = nil
                    next.effort = nil
                } else {
                    next.provider = acc.providerId
                }
            }
            return next
        }
        guard usesPools, let target = pool(column) else { return next }
        let providers = ModelPicker.poolProviders(target, accounts: accounts)
        let keeps = providers.contains(provider)
        next.poolId = column
        next.accountId = nil
        if keeps {
            next.provider = provider
        } else {
            next.provider = providers.first
            next.model = nil
            next.effort = nil
        }
        return next
    }
}
