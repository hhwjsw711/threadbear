import Foundation

/// The runner's review, with private image sources instead of file paths.
public struct PhoneDesignReview: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var note: String?
    public var recommended: String?
    public var status: String
    public var revision: Double
    public var draft: DesignReviewDraft
    public var options: [Option]
    /// Whether this thread's runner takes the phone's marks (API 106 runners
    /// say true). A newer backend in front of an older runner would drop them.
    public var canMark: Bool?

    public struct Option: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var title: String
        public var note: String?
        public var reference: Bool?
        public var shots: [Shot]
    }

    public struct Shot: Codable, Sendable, Hashable {
        public var src: String
        public var title: String?
        public var kind: String
        /// False when the runner can't send this still (gone, or not a
        /// picture even shrunk), so the sheet says so rather than waiting.
        public var preview: Bool?
        /// The agent's marks on the still (API 106), drawn over it on the board.
        public var marks: [AgentMark]?
        /// The video, sound or HTML source (API 106), a src like the still's.
        /// Single-file HTML stays within 10 MiB for the sealed full-screen view.
        public var media: String?

        public var isVideo: Bool { kind == "video" }
        public var isAudio: Bool { kind == "audio" }
    }

    /// A mark the agent drew on a shot: `box` is x0, y0, x1, y1 as fractions
    /// of the still. For an arrow it runs from the first corner to the second.
    public struct AgentMark: Codable, Sendable, Hashable {
        public var kind: String
        public var box: [Double]
        public var note: String?
        public var ink: String?

        public init(kind: String, box: [Double], note: String? = nil, ink: String? = nil) {
            self.kind = kind
            self.box = box
            self.note = note
            self.ink = ink
        }

        public var isValid: Bool { box.count == 4 && box.allSatisfy { $0.isFinite } }
    }

    /// Every still and media src, for phone:reviewImages.
    public var sources: [String] {
        Array(Set(options.flatMap { $0.shots.flatMap { [$0.src] + ($0.media.map { [$0] } ?? []) } })).sorted()
    }
    public var pending: Bool { status == "pending" }
}

extension PhoneDesignReview.Shot {
    // By hand only so a mark the phone can't read (a newer kind's shape, a
    // bad box) is dropped rather than losing the whole review.
    private enum Keys: String, CodingKey { case src, title, kind, preview, marks, media }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        src = try c.decode(String.self, forKey: .src)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        kind = try c.decode(String.self, forKey: .kind)
        preview = try? c.decodeIfPresent(Bool.self, forKey: .preview)
        media = try? c.decodeIfPresent(String.self, forKey: .media)
        let list = (try? c.decodeIfPresent(LossyList<PhoneDesignReview.AgentMark>.self, forKey: .marks))?.elements
        marks = list?.filter(\.isValid)
    }
}

/// A mark the user drew on the phone's board (API 106): a circle round part
/// of a shot's still, `box` as fractions of it. `n` is what "[Mark n]" in the
/// reply points at. `storageId` is the uploaded cut-out of that part.
public struct ReviewUserMark: Codable, Sendable, Hashable {
    public var n: Int
    public var kind: String
    public var optionId: String
    public var shot: Int
    public var box: [Double]
    public var storageId: String?
    /// The stroke as drawn, as fractions of the still, to draw it again on
    /// the phone. Not sent: the runner takes the box.
    public var path: [[Double]]?

    public init(n: Int, kind: String = "circle", optionId: String, shot: Int, box: [Double], storageId: String? = nil, path: [[Double]]? = nil) {
        self.n = n
        self.kind = kind
        self.optionId = optionId
        self.shot = shot
        self.box = box
        self.storageId = storageId
        self.path = path
    }

    /// The runner refuses more.
    public static let maxCount = 20
    public var token: String { "[Mark \(n)]" }

    var arguments: JSONValue {
        var args: [String: JSONValue] = ["n": .number(Double(n)), "kind": .string(kind), "optionId": .string(optionId),
                                         "shot": .number(Double(shot)), "box": .array(box.map { .number($0) })]
        if let storageId { args["storageId"] = .string(storageId) }
        return .object(args)
    }
}

public struct DesignReviewDraft: Codable, Sendable, Hashable {
    public var pickedId: String?
    public var pickedIds: [String]?
    public var notes: [String: String]
    public var reply: String?
    public var none: Bool?
    /// The phone's own marks, added to the Mac's saved ones. Never read from
    /// the runner's draft: a Mac's marks point at its own cut-outs.
    public var marks: [ReviewUserMark]? = nil
    /// The highest number among the Mac's saved marks, from the runner: the
    /// phone's are numbered on from there.
    public var nextMark: Int?
    /// How many marks the Mac has saved: they and the phone's share the cap of 20.
    /// Older runners don't say, so `nextMark` stands in.
    public var markCount: Int?

    private enum CodingKeys: String, CodingKey { case pickedId, pickedIds, notes, reply, none, nextMark, markCount }

    public init() { notes = [:] }

    /// The first number the phone may give a mark.
    public var firstMarkNumber: Int { max(0, nextMark ?? 0) + 1 }

    /// How many marks the phone may have, after the Mac's.
    public var markCapacity: Int { max(0, ReviewUserMark.maxCount - max(0, markCount ?? nextMark ?? 0)) }

    /// The lowest number the phone can still give a mark, or nil when there's no room.
    public var nextMarkNumber: Int? {
        let marks = marks ?? []
        guard marks.count < markCapacity else { return nil }
        let used = Set(marks.map(\.n))
        return (firstMarkNumber...).first { !used.contains($0) }
    }

    /// What a freshly loaded review shows: an answered one exactly as the
    /// runner keeps it; a pending one the phone's own draft if there is one
    /// (`kept`), brought up to date with the Mac's marks.
    public static func reopening(_ loaded: PhoneDesignReview, kept: DesignReviewDraft?) -> DesignReviewDraft {
        guard loaded.pending else { return loaded.draft }
        var draft = kept ?? loaded.draft
        draft.takeMacMarks(from: loaded.draft)
        return draft
    }

    /// How many of the phone's marks are over the cap, after the Mac added some.
    public var marksOver: Int { max(0, (marks ?? []).count - markCapacity) }

    /// Takes the Mac's marks as a freshly loaded review has them. A phone
    /// mark whose number the Mac has since used is numbered on from the Mac's,
    /// and the reply's "[Mark n]" follow it.
    public mutating func takeMacMarks(from fresh: DesignReviewDraft) {
        nextMark = fresh.nextMark
        markCount = fresh.markCount
        guard var mine = marks, !mine.isEmpty, mine.contains(where: { $0.n < firstMarkNumber }) else { return }
        mine.sort { $0.n < $1.n }
        var text = reply
        // Through placeholders, so a new number that an old one had isn't rewritten twice.
        for (i, mark) in mine.enumerated() { text = text?.replacingOccurrences(of: mark.token, with: "\u{1}\(i)\u{1}") }
        for i in mine.indices {
            mine[i].n = firstMarkNumber + i
            text = text?.replacingOccurrences(of: "\u{1}\(i)\u{1}", with: mine[i].token)
        }
        marks = mine
        reply = text
    }
    public var picks: Set<String> { Set(pickedIds ?? pickedId.map { [$0] } ?? []) }

    public mutating func pick(_ id: String, selected: Bool) {
        var chosen = picks
        if selected { chosen.insert(id); none = nil } else { chosen.remove(id) }
        pickedIds = chosen.sorted()
        pickedId = pickedIds?.first
    }

    public mutating func pickNone(_ selected: Bool) {
        none = selected ? true : nil
        if selected { pickedId = nil; pickedIds = nil }
    }

    public func canSend(to review: PhoneDesignReview) -> Bool {
        let known = Set(review.options.map(\.id))
        let pickable = Set(review.options.filter { $0.reference != true }.map(\.id))
        guard review.pending, review.revision.isFinite, review.revision >= 0,
              review.revision.rounded() == review.revision,
              picks.isSubset(of: pickable), Set(notes.keys).isSubset(of: known),
              !(none == true && !picks.isEmpty),
              (reply?.utf16.count ?? 0) <= 8000, notes.values.allSatisfy({ $0.utf16.count <= 4000 }),
              marksFit(review) else { return false }
        return !picks.isEmpty || none == true || !(marks ?? []).isEmpty || !(reply ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            notes.values.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private func marksFit(_ review: PhoneDesignReview) -> Bool {
        let marks = marks ?? []
        guard !marks.isEmpty else { return true }
        guard marks.count <= markCapacity, Set(marks.map(\.n)).count == marks.count else { return false }
        return marks.allSatisfy { mark in
            // A reference is there to compare against, not to answer on.
            guard mark.n >= firstMarkNumber,
                  let option = review.options.first(where: { $0.id == mark.optionId }), option.reference != true,
                  option.shots.indices.contains(mark.shot), mark.box.count == 4,
                  mark.box.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }) else { return false }
            return true
        }
    }

    /// phone:respondReview's draft. Notes go as a list: an option id can be
    /// any text, and Convex refuses an object key that isn't plain ASCII or
    /// starts with "$".
    public var arguments: JSONValue {
        let noteList = notes.keys.sorted().map { JSONValue.object(["id": .string($0), "text": .string(notes[$0] ?? "")]) }
        var args: [String: JSONValue] = ["notes": .array(noteList)]
        if let pickedIds { args["pickedIds"] = .array(pickedIds.map(JSONValue.string)) }
        else if let pickedId { args["pickedId"] = .string(pickedId) }
        if let reply { args["reply"] = .string(reply) }
        if none == true { args["none"] = .bool(true) }
        // Only when there are some: a backend before API 106 refuses the field.
        if let marks, !marks.isEmpty { args["marks"] = .array(marks.sorted { $0.n < $1.n }.map(\.arguments)) }
        return .object(args)
    }
}

public struct DesignReviewResult: Codable, Sendable, Hashable {
    public struct Entry: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var title: String
    }
    public var reviews: [Entry]?
    public var review: PhoneDesignReview?
    public var truncated: Bool?
}
