import Foundation
import Testing
@testable import ThreadbearKit

/// The rows the backend's phone API returns, decoded by this kit's models
/// (shared/cases/wire-rows.json). Android decodes the same samples
/// (ModelsTest.kt), so a field one app reads and the other doesn't is
/// written down there as a difference, not found by a user.
@Suite struct WireRowsTests {
    struct Cases: Decodable {
        struct Case: Decodable {
            struct Input: Decodable {
                var kind: String
                var row: JSONValue
            }
            var name: String
            var input: Input
            var expect: [String: JSONValue]
            var differs: [String: String]?
        }
        var cases: [Case]
    }

    @Test func theSharedCases() throws {
        // ios/ThreadbearKit/Tests/ThreadbearKitTests/ -> the repo.
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = repo.appendingPathComponent("shared/cases/wire-rows.json")
        let cases = try JSONDecoder().decode(Cases.self, from: Data(contentsOf: url)).cases
        #expect(cases.count >= 20)
        for c in cases where c.differs?["ios"] == nil {
            let fields: [String: JSONValue]
            do {
                fields = try Self.fields(kind: c.input.kind, Data(c.input.row.jsonString.utf8))
            } catch {
                Issue.record("\(c.name): \(error)")
                continue
            }
            for (path, want) in c.expect.sorted(by: { $0.key < $1.key }) {
                guard let got = fields[path] else {
                    Issue.record("\(c.name): the iPhone doesn't read \(c.input.kind) \(path)")
                    continue
                }
                #expect(got == want, "\(c.name): \(path)")
            }
        }
    }

    static func fields(kind: String, _ data: Data) throws -> [String: JSONValue] {
        let decoder = JSONDecoder()
        var f: [String: JSONValue] = [:]
        switch kind {
        case "thread":
            f = thread(try decoder.decode(PhoneThread.self, from: data))
        case "message":
            f = message(try decoder.decode(PhoneMessage.self, from: data))
        case "page":
            let p = try decoder.decode(MessagePage.self, from: data)
            f["hasMore"] = .bool(p.hasMore)
            put(&f, "messages", list(p.messages) { message($0) })
            put(&f, "images", list(p.images) { (i: MessageImage) -> [String: JSONValue] in
                ["seq": n(i.seq), "src": s(i.src), "pinned": b(i.pinned), "url": .string(i.url), "width": n(i.width), "height": n(i.height), "mediaType": s(i.mediaType)]
            })
        case "detail":
            let d = try decoder.decode(ThreadDetail.self, from: data)
            put(&f, "thread", thread(d.thread))
            put(&f, "messages", list(d.messages) { message($0) })
        case "runner":
            let r = try decoder.decode(PhoneRunner.self, from: data)
            f = ["runnerId": .string(r.runnerId), "name": .string(r.name), "version": s(r.version), "lastSeenAt": ms(r.lastSeenAt),
                 "draining": b(r.draining), "placed": b(r.placed), "main": b(r.main)]
            put(&f, "usagePools", list(r.usagePools) { (p: PhoneUsagePool) -> [String: JSONValue] in
                var x: [String: JSONValue] = ["id": .string(p.id), "title": .string(p.title)]
                put(&x, "accountIds", list(p.accountIds) { (id: String) -> [String: JSONValue] in ["": .string(id)] })
                return x
            })
            if let d = r.defaults {
                f["defaults.poolId"] = s(d.poolId)
                f["defaults.accountId"] = s(d.accountId)
                for (k, v) in d.models ?? [:] { f["defaults.models.\(k)"] = .string(v) }
                for (k, v) in d.efforts ?? [:] { f["defaults.efforts.\(k)"] = .string(v) }
            }
        case "identity":
            let i = try decoder.decode(PhoneIdentity.self, from: data)
            f = ["name": .string(i.name), "expiresAt": ms(i.expiresAt), "apiVersion": n(i.apiVersion), "pushOff": b(i.pushOff), "site": s(i.site)]
        case "project":
            let p = try decoder.decode(PhoneProject.self, from: data)
            f = ["id": .string(p.id), "runnerId": s(p.runnerId), "title": .string(p.title), "archived": b(p.archived),
                 "icon.symbol": s(p.icon?.symbol), "icon.url": s(p.icon?.url?.absoluteString), "icon.by": s(p.icon?.by)]
        case "counts":
            let c = try decoder.decode(PhoneCounts.self, from: data)
            f = ["hibernating": n(c.hibernating), "den": n(c.den)]
        case "command":
            let c = try decoder.decode(CommandStatus.self, from: data)
            f = ["state": .string(c.state.rawValue), "note": s(c.note), "threadId": s(c.threadId)]
            put(&f, "commands", list(c.commands) { (x: SlashCommand) -> [String: JSONValue] in ["name": .string(x.name), "source": .string(x.source)] })
        case "waiting":
            let w = try decoder.decode(WaitingSend.self, from: data)
            f = ["commandId": .string(w.commandId), "state": .string(w.state.rawValue), "text": .string(w.text), "photos": n(w.photos), "createdAt": n(w.createdAt)]
        case "pocket":
            let p = try decoder.decode(PocketCard.self, from: data)
            f = ["id": .string(p.id), "title": .string(p.title), "text": .string(p.text), "place": s(p.place), "icon": s(p.icon),
                 "threadId": s(p.threadId), "source": s(p.source), "updatedAt": .string(p.updatedAt)]
        case "account":
            let a = try decoder.decode(PhoneAccount.self, from: data)
            f = ["id": .string(a.id), "runnerId": s(a.runnerId), "provider": .string(a.provider), "title": .string(a.title),
                 "note": s(a.note), "email": s(a.email), "plan": s(a.plan),
                 "defaultModel": s(a.defaultModel), "defaultEffort": s(a.defaultEffort),
                 "signedOut": b(a.signedOut), "planEnded": b(a.planEnded)]
            if let u = a.usage {
                put(&f, "usage.windows", list(u.windows) { (w: PhoneUsageWindow) -> [String: JSONValue] in
                    ["kind": .string(w.kind), "title": .string(w.title), "remainingPercent": n(w.remainingPercent), "resetsAt": ms(w.resetsAt)]
                })
            }
            put(&f, "models", list(a.models) { (m: PhoneModelChoice) -> [String: JSONValue] in
                var x: [String: JSONValue] = ["id": .string(m.id), "model": s(m.model), "title": .string(m.title), "description": s(m.description), "defaultEffort": s(m.defaultEffort)]
                put(&x, "effortLevels", list(m.effortLevels) { (e: String) -> [String: JSONValue] in ["": .string(e)] })
                return x
            })
        case "wake":
            let w = try decoder.decode(ScheduleWake.self, from: data)
            f = ["scheduleId": .string(w.scheduleId), "threadId": s(w.threadId), "nextRunAt": ms(w.nextRunAt)]
        case "schedule":
            let x = try decoder.decode(PhoneSchedule.self, from: data)
            f = ["id": .string(x.id), "runnerId": s(x.runnerId), "title": .string(x.title), "whenText": .string(x.whenText),
                 "threadId": s(x.threadId), "paused": .bool(x.paused), "nextRunAt": ms(x.nextRunAt), "finishedAt": ms(x.finishedAt)]
        default:
            Issue.record("no row kind \(kind)")
        }
        return f
    }

    static func thread(_ t: PhoneThread) -> [String: JSONValue] {
        var f: [String: JSONValue] = [
            "threadId": .string(t.threadId), "runnerId": .string(t.runnerId), "title": .string(t.title), "cwd": .string(t.cwd),
            "accountId": .string(t.accountId), "provider": .string(t.provider), "poolId": s(t.poolId),
            "model": s(t.model), "modelInUse": s(t.modelInUse), "effort": s(t.effort), "effortInUse": s(t.effortInUse),
            "status": .string(t.status.rawValue),
            "needsYou": .bool(t.needsYou), "unread": .bool(t.unread), "preview": .string(t.preview), "lastActivityAt": ms(t.lastActivityAt),
            "snoozedUntil": ms(t.snoozedUntil), "snoozedUntilRestart": b(t.snoozedUntilRestart), "wakeNote": s(t.wakeNote),
        ]
        f["woke.at"] = ms(t.woke?.at)
        f["woke.since"] = ms(t.woke?.since)
        f["startedBy.kind"] = s(t.startedBy?.kind)
        f["startedBy.label"] = s(t.startedBy?.label)
        f["startedBy.icon"] = s(t.startedBy?.icon)
        f["startedBy.why"] = s(t.startedBy?.why)
        f["asked"] = s(t.asked)
        f["keywords"] = s(t.keywords)
        f["archivedAt"] = ms(t.archivedAt)
        f["starredAt"] = ms(t.starredAt)
        f["costUsd"] = n(t.costUsd)
        f["working"] = s(t.working)
        f["earliestSeq"] = n(t.earliestSeq)
        f["asksSeq"] = n(t.asksSeq)
        f["needs"] = s(t.needs)
        f["pendingReviews"] = n(t.pendingReviews)
        f["waitingForRoom.until"] = s(t.waitingForRoom?.until)
        f["waitingForRoom.accountId"] = s(t.waitingForRoom?.accountId)
        f["waitingForNetwork.since"] = s(t.waitingForNetwork?.since)
        f["cardTurn"] = s(t.cardTurn)
        f["share.access"] = s(t.share?.access)
        f["share.slug"] = s(t.share?.slug)
        put(&f, "projects", list(t.projects) { (p: ProjectRef) -> [String: JSONValue] in ["id": .string(p.id), "title": .string(p.title)] })
        put(&f, "next", list(t.next) { (x: String) -> [String: JSONValue] in ["": .string(x)] })
        put(&f, "links", list(t.links) { (l: PhoneLink) -> [String: JSONValue] in ["title": .string(l.title), "url": .string(l.url), "icon": s(l.icon)] })
        put(&f, "asks", list(t.asks) { (a: PhoneAsk) -> [String: JSONValue] in
            var x: [String: JSONValue] = ["action": .string(a.action), "why": s(a.why), "suggested": n(a.suggested), "ticked": b(a.ticked)]
            put(&x, "options", list(a.options) { (o: String) -> [String: JSONValue] in ["": .string(o)] })
            put(&x, "optionNotes", list(a.optionNotes) { (o: String) -> [String: JSONValue] in ["": .string(o)] })
            put(&x, "links", list(a.links) { (l: PhoneAskLink) -> [String: JSONValue] in ["title": .string(l.title), "url": .string(l.url)] })
            return x
        })
        put(&f, "looseEnds", list(t.looseEnds) { (e: PhoneLooseEnd) -> [String: JSONValue] in
            ["kind": .string(e.kind), "text": .string(e.text), "threadId": s(e.threadId), "at": s(e.at)]
        })
        if let r = t.review {
            var x: [String: JSONValue] = ["reviewer": .string(r.reviewer), "passed": .bool(r.passed), "rounds": n(r.rounds)]
            put(&x, "findings", list(r.findings) { (g: PhoneReviewFinding) -> [String: JSONValue] in
                ["id": n(g.id), "claim": .string(g.claim), "severity": .string(g.severity)]
            })
            put(&f, "review", x)
        }
        if let p = t.pendingApproval {
            var a: [String: JSONValue] = ["id": .string(p.id)]
            switch p {
            case let .approval(_, _, _, options, _, planSeq, _):
                a["kind"] = .string("approval")
                a["planSeq"] = n(planSeq)
                put(&a, "options", list(options) { (o: ApprovalOption) -> [String: JSONValue] in ["": .string(o.rawValue)] })
            case let .question(_, questions):
                a["kind"] = .string("question")
                put(&a, "questions", list(questions) { (q: Question) -> [String: JSONValue] in
                    var x: [String: JSONValue] = ["question": .string(q.question)]
                    put(&x, "options", list(q.options) { (o: Question.Option) -> [String: JSONValue] in ["label": .string(o.label)] })
                    return x
                })
            case .secret:
                a["kind"] = .string("secret")
            case let .other(_, kind):
                a["kind"] = .string("other:" + kind)
            }
            put(&f, "pendingApproval", a)
        }
        return f
    }

    static func message(_ m: PhoneMessage) -> [String: JSONValue] {
        var f: [String: JSONValue] = [
            "seq": n(m.seq), "role": .string(m.role.rawValue), "text": .string(m.text), "origin": s(m.origin), "toolKind": s(m.toolKind),
            "summary": .bool(m.summary), "plan": .bool(m.plan), "turn": s(m.turn), "at": ms(m.at),
            "wakeReason": s(m.wakeReason),
        ]
        put(&f, "wokeBy", list(m.wokeBy) { (w: WokeTask) -> [String: JSONValue] in ["kind": .string(w.kind), "description": .string(w.description)] })
        put(&f, "buttons", list(m.buttons) { (x: MessageButton) -> [String: JSONValue] in
            ["id": .string(x.id), "title": .string(x.title), "kind": .string(x.kind.rawValue), "target": s(x.target),
             "pressedThreadId": s(x.pressedThreadId), "failed": s(x.failed)]
        })
        put(&f, "answers", list(m.answers) { (a: AskAnswer) -> [String: JSONValue] in ["action": .string(a.action), "answer": .string(a.answer)] })
        return f
    }

    // A list as `count` and `<index>.<field>` ("" for the item itself).
    static func list<T>(_ items: [T]?, _ each: (T) -> [String: JSONValue]) -> [String: JSONValue] {
        var out: [String: JSONValue] = ["count": n(items?.count ?? 0)]
        for (i, item) in (items ?? []).enumerated() {
            for (k, v) in each(item) { out[k.isEmpty ? "\(i)" : "\(i).\(k)"] = v }
        }
        return out
    }

    // Each of `fields` into `f`, under `prefix` ("" is the prefix itself).
    static func put(_ f: inout [String: JSONValue], _ prefix: String, _ fields: [String: JSONValue]) {
        for (k, v) in fields { f[k.isEmpty ? prefix : "\(prefix).\(k)"] = v }
    }

    static func s(_ v: String?) -> JSONValue { v.map { .string($0) } ?? .null }
    static func b(_ v: Bool?) -> JSONValue { v.map { .bool($0) } ?? .null }
    static func n(_ v: Double?) -> JSONValue { v.map { .number($0) } ?? .null }
    static func n(_ v: Int?) -> JSONValue { v.map { .number(Double($0)) } ?? .null }
    static func ms(_ d: Date?) -> JSONValue { d.map { .number(($0.timeIntervalSince1970 * 1000).rounded()) } ?? .null }
}
