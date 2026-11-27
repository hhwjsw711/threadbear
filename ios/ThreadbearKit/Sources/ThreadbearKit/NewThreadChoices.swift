import Foundation

/// A runner's usage pool (backend API 101, exposed to phones in API 107).
public struct PhoneUsagePool: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var accountIds: [String]

    public init(id: String, title: String, accountIds: [String]) {
        self.id = id
        self.title = title
        self.accountIds = accountIds
    }
}

/// The runner's default pool, login, model per provider and effort per provider (backend API 107).
public struct PhoneRunnerDefaults: Codable, Sendable, Hashable {
    public var poolId: String?
    public var accountId: String?
    public var models: [String: String]?
    public var efforts: [String: String]?

    public init(poolId: String? = nil, accountId: String? = nil, models: [String: String]? = nil, efforts: [String: String]? = nil) {
        self.poolId = poolId
        self.accountId = accountId
        self.models = models
        self.efforts = efforts
    }
}

/// One usage window on a login (5-hour, weekly, etc.).
public struct PhoneUsageWindow: Codable, Sendable, Hashable {
    public var kind: String
    public var title: String
    public var remainingPercent: Double
    @OptionalFlexibleDate public var resetsAt: Date?
    public var detail: String?

    public init(kind: String, title: String, remainingPercent: Double, resetsAt: Date? = nil, detail: String? = nil) {
        self.kind = kind
        self.title = title
        self.remainingPercent = remainingPercent
        self._resetsAt = OptionalFlexibleDate(wrappedValue: resetsAt)
        self.detail = detail
    }
}

/// A login's usage snapshot from phone:accounts.
public struct PhoneAccountUsage: Codable, Sendable, Hashable {
    public var windows: [PhoneUsageWindow]
    public var readAt: String?
    public var source: String?
    public var stale: Bool?
    public var blocked: Bool?
    public var notice: String?

    public init(windows: [PhoneUsageWindow] = [], readAt: String? = nil, source: String? = nil, stale: Bool? = nil, blocked: Bool? = nil, notice: String? = nil) {
        self.windows = windows
        self.readAt = readAt
        self.source = source
        self.stale = stale
        self.blocked = blocked
        self.notice = notice
    }

    private enum Keys: String, CodingKey { case windows, readAt, source, stale, blocked, notice }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        windows = (try? c.decodeIfPresent([PhoneUsageWindow].self, forKey: .windows)).flatMap { $0 } ?? []
        readAt = (try? c.decodeIfPresent(String.self, forKey: .readAt)).flatMap { $0 }
        source = (try? c.decodeIfPresent(String.self, forKey: .source)).flatMap { $0 }
        stale = (try? c.decodeIfPresent(Bool.self, forKey: .stale)).flatMap { $0 }
        blocked = (try? c.decodeIfPresent(Bool.self, forKey: .blocked)).flatMap { $0 }
        notice = (try? c.decodeIfPresent(String.self, forKey: .notice)).flatMap { $0 }
    }
}

/// One model an account offers (backend API 20; full model id & description since API 107),
/// as the Mac's model picker lists it: `id` is what a new thread sends.
public struct PhoneModelChoice: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    /// Full model id when `id` is a short alias ("opus" -> "claude-opus-5-5").
    public var model: String?
    public var title: String
    public var description: String?
    public var effortLevels: [String]?
    public var defaultEffort: String?

    public init(id: String, model: String? = nil, title: String, description: String? = nil, effortLevels: [String]? = nil, defaultEffort: String? = nil) {
        self.id = id
        self.model = model
        self.title = title
        self.description = description
        self.effortLevels = effortLevels
        self.defaultEffort = defaultEffort
    }
}

/// A row of phone:accounts: a login on one of the runners.
public struct PhoneAccount: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var runnerId: String?
    public var provider: String
    public var title: String
    public var note: String?
    public var email: String?
    public var plan: String?
    public var defaultModel: String?
    public var defaultEffort: String?
    public var signedOut: Bool?
    public var planEnded: Bool?
    public var usage: PhoneAccountUsage?
    public var models: [PhoneModelChoice]

    public var providerId: String {
        provider.isEmpty ? "claude" : provider
    }

    public var displayName: String {
        if let email, !email.isEmpty { return email }
        if title.hasPrefix("Codex · ") { return String(title.dropFirst("Codex · ".count)) }
        return title.isEmpty ? id : title
    }

    public init(
        id: String,
        runnerId: String? = nil,
        provider: String,
        title: String,
        note: String? = nil,
        email: String? = nil,
        plan: String? = nil,
        defaultModel: String? = nil,
        defaultEffort: String? = nil,
        signedOut: Bool? = nil,
        planEnded: Bool? = nil,
        usage: PhoneAccountUsage? = nil,
        models: [PhoneModelChoice] = []
    ) {
        self.id = id
        self.runnerId = runnerId
        self.provider = provider
        self.title = title
        self.note = note
        self.email = email
        self.plan = plan
        self.defaultModel = defaultModel
        self.defaultEffort = defaultEffort
        self.signedOut = signedOut
        self.planEnded = planEnded
        self.usage = usage
        self.models = models
    }

    private enum Keys: String, CodingKey {
        case id, runnerId, provider, title, note, email, plan, defaultModel, defaultEffort, signedOut, planEnded, usage, models
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        runnerId = (try? c.decodeIfPresent(String.self, forKey: .runnerId)).flatMap { $0 }
        provider = (try? c.decodeIfPresent(String.self, forKey: .provider)).flatMap { $0 } ?? "claude"
        title = (try? c.decodeIfPresent(String.self, forKey: .title)).flatMap { $0 } ?? id
        note = (try? c.decodeIfPresent(String.self, forKey: .note)).flatMap { $0 }
        email = (try? c.decodeIfPresent(String.self, forKey: .email)).flatMap { $0 }
        plan = (try? c.decodeIfPresent(String.self, forKey: .plan)).flatMap { $0 }
        defaultModel = (try? c.decodeIfPresent(String.self, forKey: .defaultModel)).flatMap { $0 }
        defaultEffort = (try? c.decodeIfPresent(String.self, forKey: .defaultEffort)).flatMap { $0 }
        signedOut = (try? c.decodeIfPresent(Bool.self, forKey: .signedOut)).flatMap { $0 }
        planEnded = (try? c.decodeIfPresent(Bool.self, forKey: .planEnded)).flatMap { $0 }
        usage = (try? c.decodeIfPresent(PhoneAccountUsage.self, forKey: .usage)).flatMap { $0 }
        // A backend before API 20 has no models: no pickers, not a broken row.
        models = (try? c.decodeIfPresent([PhoneModelChoice].self, forKey: .models)).flatMap { $0 } ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(runnerId, forKey: .runnerId)
        try c.encode(provider, forKey: .provider)
        try c.encode(title, forKey: .title)
        try c.encodeIfPresent(note, forKey: .note)
        try c.encodeIfPresent(email, forKey: .email)
        try c.encodeIfPresent(plan, forKey: .plan)
        try c.encodeIfPresent(defaultModel, forKey: .defaultModel)
        try c.encodeIfPresent(defaultEffort, forKey: .defaultEffort)
        try c.encodeIfPresent(signedOut, forKey: .signedOut)
        try c.encodeIfPresent(planEnded, forKey: .planEnded)
        try c.encodeIfPresent(usage, forKey: .usage)
        try c.encode(models, forKey: .models)
    }
}

/// What a new thread from the phone can name. Nil is the runner's usual.
public struct NewThreadSettings: Sendable, Hashable {
    public var poolId: String?
    public var accountId: String?
    public var provider: String?
    public var model: String?
    public var effort: String?

    public init(poolId: String? = nil, accountId: String? = nil, provider: String? = nil, model: String? = nil, effort: String? = nil) {
        self.poolId = poolId
        self.accountId = accountId
        self.provider = provider
        self.model = model
        self.effort = effort
    }
}

/// The new thread sheet's runner, model and effort pickers, from the
/// mirrored runners and accounts.
public enum NewThreadChoices {
    /// Where a new thread starts unless Mike picks another: the first runner
    /// online of those he's placed in his order (phone:runners lists them in
    /// it), or else the main Mac, to wait for. A runner he hasn't placed is
    /// never picked for him, so a Mac with a runner key only gets his words
    /// when he's said so. Nil with neither, which leaves it to the backend
    /// (phone:create's own choice). Draining ones are passed over.
    public static func runner(_ runners: [PhoneRunner], now: Date) -> PhoneRunner? {
        runners.first { $0.placed == true && $0.isOnline(at: now) && $0.draining != true }
            ?? runners.first { $0.main == true }
    }

    /// The models on offer on one runner: its own logins' (a row with no
    /// runner is anyone's). None while its logins haven't come up yet, so it
    /// starts on its own default rather than another Mac's model.
    public static func models(_ accounts: [PhoneAccount], runnerId: String?) -> [PhoneModelChoice] {
        guard let runnerId else { return models(accounts) }
        return models(accounts.filter { $0.runnerId == nil || $0.runnerId == runnerId })
    }

    /// Every model on offer, Claude's first, each once.
    public static func models(_ accounts: [PhoneAccount]) -> [PhoneModelChoice] {
        let order = ["claude", "codex"]
        let sorted = accounts.enumerated().sorted { a, b in
            let x = order.firstIndex(of: a.element.provider) ?? order.count
            let y = order.firstIndex(of: b.element.provider) ?? order.count
            return x != y ? x < y : a.offset < b.offset
        }.map(\.element)
        var seen = Set<String>()
        var out: [PhoneModelChoice] = []
        for account in sorted {
            for model in account.models where seen.insert(model.id).inserted { out.append(model) }
        }
        return out
    }

    /// The efforts a model offers, or with no model picked Claude's levels
    /// (the runner drops one the model it lands on doesn't offer).
    public static func efforts(for model: PhoneModelChoice?) -> [String] {
        let levels = model?.effortLevels ?? []
        return levels.isEmpty ? claudeLevels : levels.filter { all.contains($0) }
    }

    public static func effortTitle(_ level: String) -> String {
        titles[level] ?? level.capitalized
    }

    /// Whether a picked effort still fits once the model changes.
    public static func keeps(effort: String?, model: PhoneModelChoice?) -> Bool {
        guard let effort else { return true }
        return efforts(for: model).contains(effort)
    }

    static let all = ["low", "medium", "high", "xhigh", "max", "ultra"]
    static let claudeLevels = ["low", "medium", "high", "xhigh", "max"]
    static let titles = ["low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra high", "max": "Max", "ultra": "Ultra"]
}
