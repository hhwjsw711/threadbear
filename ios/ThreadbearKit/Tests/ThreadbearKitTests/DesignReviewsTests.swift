import Foundation
import Testing
@testable import ThreadbearKit

struct DesignReviewsTests {
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
        draft.marks = [.init(n: 21, optionId: "A", shot: 0, box: [0.1, 0.1, 0.4, 0.4])]
        #expect(!draft.canSend(to: review))
    }

    @Test func theRunnersDraftNeverBringsMarks() throws {
        let draft = try JSONDecoder().decode(DesignReviewDraft.self, from: Data(#"{"notes":{},"marks":[{"n":1,"kind":"circle","optionId":"A","shot":0,"box":[0,0,1,1]}]}"#.utf8))
        #expect(draft.marks == nil)
    }
}
