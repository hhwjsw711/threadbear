import Foundation
import Testing
@testable import ThreadbearKit

struct DesignReviewsTests {
    @Test func deliveredHTMLKeepsItsOpaqueMediaSourceForTheSealedView() throws {
        let value = try JSONDecoder().decode(PhoneDesignReview.self, from: Data(#"{"id":"r","title":"HTML","status":"pending","revision":0,"draft":{"notes":{}},"options":[{"id":"A","title":"Try it","shots":[{"src":"review:r:still","kind":"page","media":"review:r:html"},{"src":"review:r:old","kind":"page"}]}]}"#.utf8))
        #expect(value.options[0].shots[0].media == "review:r:html")
        #expect(value.options[0].shots[0].kind == "page")
        #expect(value.options[0].shots[1].media == nil)
    }

    private func review() throws -> PhoneDesignReview {
        try JSONDecoder().decode(PhoneDesignReview.self, from: Data(#"{"id":"r","title":"Layout","status":"pending","revision":0,"recommended":"A","draft":{"notes":{}},"options":[{"id":"A","title":"First","shots":[{"src":"review:r:a","kind":"page"}]},{"id":"B","title":"Today","reference":true,"shots":[]}]}"#.utf8))
    }

    @Test func selectionAndNoneAreExclusive() throws {
        let review = try review()
        var draft = DesignReviewDraft()
        #expect(!draft.canSend(to: review))
        draft.pick("A", selected: true)
        #expect(draft.canSend(to: review))
        draft.pickNone(true)
        #expect(draft.picks.isEmpty)
        #expect(draft.canSend(to: review))
        draft.pick("A", selected: true)
        #expect(draft.none == nil)
        draft.pick("B", selected: true)
        #expect(!draft.canSend(to: review))
    }

    @Test func notesAndReadOnlyReviews() throws {
        var review = try review()
        var draft = DesignReviewDraft()
        draft.notes["B"] = "Keep this spacing"
        #expect(draft.canSend(to: review))
        review.status = "answered"
        #expect(!draft.canSend(to: review))
        review.status = "pending"
        draft.reply = String(repeating: "x", count: 8001)
        #expect(!draft.canSend(to: review))
    }

    @Test func reviewCommandResultsDecodeWithoutBreakingSlashCommands() throws {
        let status = try JSONDecoder().decode(CommandStatus.self, from: Data(#"{"state":"done","result":{"reviews":[{"id":"r","title":"Layout"}]}}"#.utf8))
        #expect(status.designReviews?.reviews?.first?.id == "r")
        #expect(status.commands == nil)
    }

    @Test func notesGoAsAListSoAnyOptionIdIsSafe() throws {
        var draft = DesignReviewDraft()
        draft.notes["$weird"] = "first"
        draft.notes["Café"] = "second"
        guard case let .object(args) = draft.arguments, case let .array(notes)? = args["notes"] else {
            Issue.record("notes aren't a list"); return
        }
        #expect(notes == [
            .object(["id": .string("$weird"), "text": .string("first")]),
            .object(["id": .string("Café"), "text": .string("second")]),
        ])
    }

    @Test func aStillWithNoPreviewSaysSo() throws {
        let review = try JSONDecoder().decode(PhoneDesignReview.self, from: Data(#"{"id":"r","title":"T","status":"pending","revision":0,"draft":{"notes":{}},"options":[{"id":"A","title":"A","shots":[{"src":"review:r:a","kind":"image","preview":false},{"src":"review:r:b","kind":"image"}]}]}"#.utf8))
        #expect(review.options[0].shots.map(\.preview) == [false, nil])
    }

    @Test func aReviewComesAsJSONTextWithAnyNoteKeys() throws {
        let inner = #"{"review":{"id":"r","title":"T","status":"pending","revision":0,"draft":{"notes":{"Café":"tighter","$odd":"x"}},"options":[]}}"#
        let outer = try JSONEncoder().encode(["state": "done", "result": inner])
        let status = try JSONDecoder().decode(CommandStatus.self, from: outer)
        #expect(status.designReviews?.review?.draft.notes["Café"] == "tighter")
        #expect(status.designReviews?.review?.draft.notes["$odd"] == "x")
        #expect(status.commands == nil)
    }

    @Test func shotsDecodeTheAgentsMarksAndMedia() throws {
        let review = try JSONDecoder().decode(PhoneDesignReview.self, from: Data(#"{"id":"r","title":"T","status":"pending","revision":0,"draft":{"notes":{}},"options":[{"id":"A","title":"A","shots":[{"src":"review:r:a","kind":"video","media":"review:r:m","marks":[{"kind":"circle","box":[0.1,0.2,0.3,0.4],"note":"this","ink":"rose"},{"kind":"arrow","box":"bad"},{"kind":"underline","box":[0.1,0.2,0.3]},{"kind":"star","box":[0,0,1,1]}]},{"src":"review:r:b","kind":"page"}]}]}"#.utf8))
        let shot = review.options[0].shots[0]
        #expect(shot.media == "review:r:m")
        #expect(shot.isVideo)
        // A bad box is dropped, not the review; an unknown kind is kept for the board to skip.
        #expect(shot.marks?.map(\.kind) == ["circle", "star"])
        #expect(shot.marks?.first == .init(kind: "circle", box: [0.1, 0.2, 0.3, 0.4], note: "this", ink: "rose"))
        #expect(review.options[0].shots[1].marks == nil && review.options[0].shots[1].media == nil)
        #expect(review.sources == ["review:r:a", "review:r:b", "review:r:m"])
    }

    @Test func draftArgumentsCarryMarksOnlyWhenThereAreSome() throws {
        let review = try review()
        var draft = DesignReviewDraft()
        draft.reply = "Look here"
        guard case let .object(plain) = draft.arguments else { Issue.record("not an object"); return }
        #expect(plain["marks"] == nil)
        draft.marks = []
        guard case let .object(empty) = draft.arguments else { Issue.record("not an object"); return }
        #expect(empty["marks"] == nil)
        draft.marks = [.init(n: 2, optionId: "A", shot: 0, box: [0.5, 0.5, 0.9, 0.9]),
                       .init(n: 1, optionId: "A", shot: 0, box: [0, 0, 0.2, 0.2], storageId: "kg2")]
        #expect(draft.canSend(to: review))
        #expect(draft.nextMarkNumber == 3)
        guard case let .object(args) = draft.arguments, case let .array(marks)? = args["marks"] else {
            Issue.record("marks aren't a list"); return
        }
        #expect(marks == [
            .object(["n": .number(1), "kind": .string("circle"), "optionId": .string("A"), "shot": .number(0),
                     "box": .array([.number(0), .number(0), .number(0.2), .number(0.2)]), "storageId": .string("kg2")]),
            .object(["n": .number(2), "kind": .string("circle"), "optionId": .string("A"), "shot": .number(0),
                     "box": .array([.number(0.5), .number(0.5), .number(0.9), .number(0.9)])]),
        ])
    }

    @Test func marksAloneCanBeSentButNotBadOnes() throws {
        let review = try review()
        var draft = DesignReviewDraft()
        draft.marks = [.init(n: 1, optionId: "A", shot: 0, box: [0.1, 0.1, 0.4, 0.4])]
        #expect(draft.canSend(to: review))
        draft.marks = [.init(n: 1, optionId: "A", shot: 1, box: [0.1, 0.1, 0.4, 0.4])]
        #expect(!draft.canSend(to: review))
        draft.marks = [.init(n: 1, optionId: "A", shot: 0, box: [0.1, 0.1, 1.4, 0.4])]
        #expect(!draft.canSend(to: review))
        draft.marks = [.init(n: 0, optionId: "A", shot: 0, box: [0.1, 0.1, 0.4, 0.4])]
        #expect(!draft.canSend(to: review))
    }

    @Test func theRunnersDraftNeverBringsMarks() throws {
        let draft = try JSONDecoder().decode(DesignReviewDraft.self, from: Data(#"{"notes":{},"marks":[{"n":1,"kind":"circle","optionId":"A","shot":0,"box":[0,0,1,1]}]}"#.utf8))
        #expect(draft.marks == nil)
    }

    @Test func marksOnAReferenceAreRefused() throws {
        let review = try JSONDecoder().decode(PhoneDesignReview.self, from: Data(#"{"id":"r","title":"T","status":"pending","revision":0,"draft":{"notes":{}},"options":[{"id":"A","title":"A","shots":[{"src":"review:r:a","kind":"image"}]},{"id":"R","title":"Today","reference":true,"shots":[{"src":"review:r:b","kind":"image"}]}]}"#.utf8))
        var draft = DesignReviewDraft()
        draft.marks = [.init(n: 1, optionId: "R", shot: 0, box: [0.1, 0.1, 0.4, 0.4])]
        #expect(!draft.canSend(to: review))
        draft.marks = [.init(n: 1, optionId: "A", shot: 0, box: [0.1, 0.1, 0.4, 0.4])]
        #expect(draft.canSend(to: review))
    }

    @Test func phoneMarksNumberOnFromTheMacsAndShareTheCap() throws {
        var review = try JSONDecoder().decode(PhoneDesignReview.self, from: Data(#"{"id":"r","title":"T","status":"pending","revision":0,"canMark":true,"draft":{"notes":{},"nextMark":18},"options":[{"id":"A","title":"A","shots":[{"src":"review:r:a","kind":"image"}]}]}"#.utf8))
        #expect(review.canMark == true)
        var draft = review.draft
        #expect(draft.nextMark == 18)
        #expect(draft.nextMarkNumber == 19)
        draft.marks = [.init(n: 19, optionId: "A", shot: 0, box: [0, 0, 0.5, 0.5])]
        #expect(draft.nextMarkNumber == 20)
        #expect(draft.canSend(to: review))
        draft.marks?.append(.init(n: 20, optionId: "A", shot: 0, box: [0.5, 0.5, 1, 1]))
        #expect(draft.nextMarkNumber == nil)
        #expect(draft.canSend(to: review))
        // A number the Mac's marks already have.
        draft.marks = [.init(n: 3, optionId: "A", shot: 0, box: [0, 0, 0.5, 0.5])]
        #expect(!draft.canSend(to: review))
        draft.nextMark = 20
        draft.marks = nil
        #expect(draft.markCapacity == 0 && draft.nextMarkNumber == nil)
        review.draft = DesignReviewDraft()
        #expect(review.draft.nextMarkNumber == 1)
    }

    @Test func canMarkIsMissingFromOlderRunners() throws {
        let review = try review()
        #expect(review.canMark == nil)
        #expect(review.draft.nextMark == nil)
    }

    @Test func capacityIsByCountAndNumbersCanPassTwenty() throws {
        let review = try JSONDecoder().decode(PhoneDesignReview.self, from: Data(#"{"id":"r","title":"T","status":"pending","revision":0,"canMark":true,"draft":{"notes":{},"nextMark":25,"markCount":18},"options":[{"id":"A","title":"A","shots":[{"src":"review:r:a","kind":"image"}]}]}"#.utf8))
        var draft = review.draft
        #expect(draft.markCount == 18 && draft.markCapacity == 2)
        #expect(draft.nextMarkNumber == 26)
        draft.marks = [.init(n: 26, optionId: "A", shot: 0, box: [0, 0, 0.5, 0.5])]
        #expect(draft.nextMarkNumber == 27)
        draft.marks?.append(.init(n: 27, optionId: "A", shot: 0, box: [0.5, 0.5, 1, 1]))
        #expect(draft.nextMarkNumber == nil)
        #expect(draft.canSend(to: review))
        draft.marks?.append(.init(n: 28, optionId: "A", shot: 0, box: [0.2, 0.2, 0.3, 0.3]))
        #expect(!draft.canSend(to: review))
    }

    @Test func aReloadRenumbersPhoneMarksTheMacHasSinceUsed() throws {
        var draft = DesignReviewDraft()
        draft.marks = [.init(n: 2, optionId: "A", shot: 0, box: [0.5, 0.5, 1, 1]),
                       .init(n: 1, optionId: "A", shot: 0, box: [0, 0, 0.5, 0.5])]
        draft.reply = "See [Mark 1] and [Mark 2], not [Mark 3]"
        var fresh = DesignReviewDraft()
        fresh.nextMark = 2
        fresh.markCount = 1
        draft.takeMacMarks(from: fresh)
        #expect(draft.nextMark == 2 && draft.markCount == 1)
        #expect(draft.marks?.map(\.n) == [3, 4])
        #expect(draft.marks?.map(\.box) == [[0, 0, 0.5, 0.5], [0.5, 0.5, 1, 1]])
        // [Mark 3] was the Mac's own, so it stays as written.
        #expect(draft.reply == "See [Mark 3] and [Mark 4], not [Mark 3]")
        // Numbers already clear of the Mac's are left alone.
        let before = draft
        draft.takeMacMarks(from: fresh)
        #expect(draft == before)
    }

    @Test func anAnsweredReviewReopensAsTheRunnerKeepsIt() throws {
        var review = try review()
        var mine = DesignReviewDraft()
        mine.marks = [.init(n: 1, optionId: "A", shot: 0, box: [0, 0, 0.5, 0.5])]
        mine.reply = "[Mark 1]"
        review.draft.nextMark = 3
        review.draft.markCount = 3
        review.draft.reply = "answered"
        review.status = "answered"
        #expect(DesignReviewDraft.reopening(review, kept: mine) == review.draft)
        review.status = "pending"
        let pending = DesignReviewDraft.reopening(review, kept: mine)
        #expect(pending.marks?.map(\.n) == [4])
        #expect(pending.reply == "[Mark 4]")
        #expect(DesignReviewDraft.reopening(review, kept: nil) == review.draft)
    }

    @Test func marksOverTheCapAfterTheMacAddsSomeAreCounted() {
        var draft = DesignReviewDraft()
        draft.marks = [.init(n: 1, optionId: "A", shot: 0, box: [0, 0, 0.5, 0.5]),
                       .init(n: 2, optionId: "A", shot: 0, box: [0.5, 0.5, 1, 1])]
        #expect(draft.marksOver == 0)
        var fresh = DesignReviewDraft()
        fresh.nextMark = 19
        fresh.markCount = 19
        draft.takeMacMarks(from: fresh)
        #expect(draft.marksOver == 1)
    }
}
