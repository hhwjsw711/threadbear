package com.mikerosoft.threadbear.kit

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** DesignReviewsTests.swift's cases, and the board's geometry. */
class DesignReviewsTest {
    private fun read(json: String) = PhoneDesignReview.read(parseJson(json) as JsonObject)

    private fun review() = read("""{"id":"r","title":"Layout","status":"pending","revision":0,"recommended":"A","draft":{"notes":{}},"options":[{"id":"A","title":"First","shots":[{"src":"review:r:a","kind":"page"}]},{"id":"B","title":"Today","reference":true,"shots":[]}]}""")

    private fun mark(n: Int, option: String = "A", shot: Int = 0, box: List<Double>, storageId: String? = null) =
        ReviewUserMark(n, optionId = option, shot = shot, box = box, storageId = storageId)

    @Test fun selectionAndNoneAreExclusive() {
        val review = review()
        var draft = DesignReviewDraft()
        assertFalse(draft.canSend(review))
        draft = draft.pick("A", true)
        assertTrue(draft.canSend(review))
        draft = draft.pickNone(true)
        assertTrue(draft.picks.isEmpty())
        assertTrue(draft.canSend(review))
        draft = draft.pick("A", true)
        assertNull(draft.none)
        draft = draft.pick("B", true)
        // B is a reference.
        assertFalse(draft.canSend(review))
    }

    @Test fun notesAndReadOnlyReviews() {
        var review = review()
        var draft = DesignReviewDraft(notes = mapOf("B" to "Keep this spacing"))
        assertTrue(draft.canSend(review))
        review = review.copy(status = "answered")
        assertFalse(draft.canSend(review))
        review = review.copy(status = "pending")
        draft = draft.copy(reply = "x".repeat(8001))
        assertFalse(draft.canSend(review))
    }

    @Test fun reviewCommandResultsReadWithoutBreakingSlashCommands() {
        val status = CommandStatus.read(parseJson("""{"state":"done","result":{"reviews":[{"id":"r","title":"Layout"}]}}""") as JsonObject)
        assertEquals("r", status.designReviews?.reviews?.first()?.id)
        assertNull(status.commands)
        val slash = CommandStatus.read(parseJson("""{"state":"done","result":[{"name":"/x","source":"builtin"}]}""") as JsonObject)
        assertNull(slash.designReviews)
    }

    @Test fun aReviewComesAsJSONTextWithAnyNoteKeys() {
        val inner = """{"review":{"id":"r","title":"T","status":"pending","revision":0,"draft":{"notes":{"Café":"tighter","${'$'}odd":"x"}},"options":[]}}"""
        val outer = buildJsonObject { put("state", "done"); put("result", inner) }
        val status = CommandStatus.read(outer)
        assertEquals("tighter", status.designReviews?.review?.draft?.notes?.get("Café"))
        assertEquals("x", status.designReviews?.review?.draft?.notes?.get("\$odd"))
        assertNull(status.commands)
    }

    @Test fun notesGoAsAListSoAnyOptionIdIsSafe() {
        val draft = DesignReviewDraft(notes = mapOf("Café" to "second", "\$weird" to "first"))
        assertEquals(
            JsonArray(listOf(
                buildJsonObject { put("id", "\$weird"); put("text", "first") },
                buildJsonObject { put("id", "Café"); put("text", "second") },
            )),
            draft.arguments["notes"],
        )
    }

    @Test fun aStillWithNoPreviewSaysSo() {
        val review = read("""{"id":"r","title":"T","status":"pending","revision":0,"draft":{"notes":{}},"options":[{"id":"A","title":"A","shots":[{"src":"review:r:a","kind":"image","preview":false},{"src":"review:r:b","kind":"image"}]}]}""")
        assertEquals(listOf(false, null), review.options[0].shots.map { it.preview })
    }

    @Test fun shotsReadTheAgentsMarksAndMedia() {
        val review = read("""{"id":"r","title":"T","status":"pending","revision":0,"draft":{"notes":{}},"options":[{"id":"A","title":"A","shots":[{"src":"review:r:a","kind":"video","media":"review:r:m","marks":[{"kind":"circle","box":[0.1,0.2,0.3,0.4],"note":"this","ink":"rose"},{"kind":"arrow","box":"bad"},{"kind":"underline","box":[0.1,0.2,0.3]},{"kind":"star","box":[0,0,1,1]}]},{"src":"review:r:b","kind":"page"}]}]}""")
        val shot = review.options[0].shots[0]
        assertEquals("review:r:m", shot.media)
        assertTrue(shot.isVideo)
        // A bad box is dropped, not the review; an unknown kind is kept for the board to skip.
        assertEquals(listOf("circle", "star"), shot.marks?.map { it.kind })
        assertEquals(PhoneDesignReview.AgentMark("circle", listOf(0.1, 0.2, 0.3, 0.4), "this", "rose"), shot.marks?.first())
        assertNull(review.options[0].shots[1].marks)
        assertNull(review.options[0].shots[1].media)
        assertEquals(listOf("review:r:a", "review:r:b", "review:r:m"), review.sources)
    }

    @Test fun draftArgumentsCarryMarksOnlyWhenThereAreSome() {
        val review = review()
        var draft = DesignReviewDraft(reply = "Look here")
        assertNull(draft.arguments["marks"])
        draft = draft.copy(marks = emptyList())
        assertNull(draft.arguments["marks"])
        draft = draft.copy(marks = listOf(mark(2, box = listOf(0.5, 0.5, 0.9, 0.9)), mark(1, box = listOf(0.0, 0.0, 0.2, 0.2), storageId = "kg2")))
        assertTrue(draft.canSend(review))
        assertEquals(3, draft.nextMarkNumber)
        val marks = draft.arguments["marks"] as JsonArray
        assertEquals(
            JsonArray(listOf(
                buildJsonObject {
                    put("n", 1); put("kind", "circle"); put("optionId", "A"); put("shot", 0)
                    put("box", JsonArray(listOf(0.0, 0.0, 0.2, 0.2).map(::JsonPrimitive))); put("storageId", "kg2")
                },
                buildJsonObject {
                    put("n", 2); put("kind", "circle"); put("optionId", "A"); put("shot", 0)
                    put("box", JsonArray(listOf(0.5, 0.5, 0.9, 0.9).map(::JsonPrimitive)))
                },
            )),
            marks,
        )
        assertEquals(JsonPrimitive("Look here"), draft.arguments["reply"])
    }

    @Test fun picksGoAsAListAndNoneOnlyWhenSet() {
        val args = DesignReviewDraft().pick("B", true).pick("A", true).arguments
        assertEquals(JsonArray(listOf(JsonPrimitive("A"), JsonPrimitive("B"))), args["pickedIds"])
        assertNull(args["pickedId"])
        assertNull(args["none"])
        assertEquals(JsonPrimitive(true), DesignReviewDraft().pickNone(true).arguments["none"])
        assertEquals(JsonPrimitive("A"), DesignReviewDraft(pickedId = "A").arguments["pickedId"])
    }

    @Test fun marksAloneCanBeSentButNotBadOnes() {
        val review = review()
        assertTrue(DesignReviewDraft(marks = listOf(mark(1, box = listOf(0.1, 0.1, 0.4, 0.4)))).canSend(review))
        assertFalse(DesignReviewDraft(marks = listOf(mark(1, shot = 1, box = listOf(0.1, 0.1, 0.4, 0.4)))).canSend(review))
        assertFalse(DesignReviewDraft(marks = listOf(mark(1, box = listOf(0.1, 0.1, 1.4, 0.4)))).canSend(review))
        assertFalse(DesignReviewDraft(marks = listOf(mark(0, box = listOf(0.1, 0.1, 0.4, 0.4)))).canSend(review))
        assertFalse(DesignReviewDraft(marks = listOf(mark(1, box = listOf(0.1, 0.1, 0.4)))).canSend(review))
        // Two with one number.
        assertFalse(DesignReviewDraft(marks = listOf(mark(1, box = listOf(0.1, 0.1, 0.4, 0.4)), mark(1, box = listOf(0.5, 0.5, 0.6, 0.6)))).marksFit(review))
    }

    @Test fun theRunnersDraftNeverBringsMarks() {
        val draft = DesignReviewDraft.read(parseJson("""{"notes":{},"marks":[{"n":1,"kind":"circle","optionId":"A","shot":0,"box":[0,0,1,1]}]}""") as JsonObject)
        assertNull(draft.marks)
    }

    @Test fun marksOnAReferenceAreRefused() {
        val review = read("""{"id":"r","title":"T","status":"pending","revision":0,"draft":{"notes":{}},"options":[{"id":"A","title":"A","shots":[{"src":"review:r:a","kind":"image"}]},{"id":"R","title":"Today","reference":true,"shots":[{"src":"review:r:b","kind":"image"}]}]}""")
        assertFalse(DesignReviewDraft(marks = listOf(mark(1, option = "R", box = listOf(0.1, 0.1, 0.4, 0.4)))).canSend(review))
        assertTrue(DesignReviewDraft(marks = listOf(mark(1, box = listOf(0.1, 0.1, 0.4, 0.4)))).canSend(review))
    }

    @Test fun phoneMarksNumberOnFromTheMacsAndShareTheCap() {
        val review = read("""{"id":"r","title":"T","status":"pending","revision":0,"canMark":true,"draft":{"notes":{},"nextMark":18},"options":[{"id":"A","title":"A","shots":[{"src":"review:r:a","kind":"image"}]}]}""")
        assertEquals(true, review.canMark)
        var draft = review.draft
        assertEquals(18, draft.nextMark)
        assertEquals(19, draft.nextMarkNumber)
        draft = draft.copy(marks = listOf(mark(19, box = listOf(0.0, 0.0, 0.5, 0.5))))
        assertEquals(20, draft.nextMarkNumber)
        assertTrue(draft.canSend(review))
        draft = draft.copy(marks = draft.marks!! + mark(20, box = listOf(0.5, 0.5, 1.0, 1.0)))
        assertNull(draft.nextMarkNumber)
        assertTrue(draft.canSend(review))
        // A number the Mac's marks already have.
        draft = draft.copy(marks = listOf(mark(3, box = listOf(0.0, 0.0, 0.5, 0.5))))
        assertFalse(draft.canSend(review))
        draft = draft.copy(nextMark = 20, marks = null)
        assertEquals(0, draft.markCapacity)
        assertNull(draft.nextMarkNumber)
        assertEquals(1, DesignReviewDraft().nextMarkNumber)
    }

    @Test fun canMarkIsMissingFromOlderRunners() {
        val review = review()
        assertNull(review.canMark)
        assertNull(review.draft.nextMark)
    }

    @Test fun capacityIsByCountAndNumbersCanPassTwenty() {
        val review = read("""{"id":"r","title":"T","status":"pending","revision":0,"canMark":true,"draft":{"notes":{},"nextMark":25,"markCount":18},"options":[{"id":"A","title":"A","shots":[{"src":"review:r:a","kind":"image"}]}]}""")
        var draft = review.draft
        assertEquals(18, draft.markCount)
        assertEquals(2, draft.markCapacity)
        assertEquals(26, draft.nextMarkNumber)
        draft = draft.copy(marks = listOf(mark(26, box = listOf(0.0, 0.0, 0.5, 0.5))))
        assertEquals(27, draft.nextMarkNumber)
        draft = draft.copy(marks = draft.marks!! + mark(27, box = listOf(0.5, 0.5, 1.0, 1.0)))
        assertNull(draft.nextMarkNumber)
        assertTrue(draft.canSend(review))
        draft = draft.copy(marks = draft.marks!! + mark(28, box = listOf(0.2, 0.2, 0.3, 0.3)))
        assertFalse(draft.canSend(review))
    }

    @Test fun addingAndRemovingAMarkKeepTheReplyInStep() {
        val (added, m) = assertNotNull(DesignReviewDraft(nextMark = 4).addingMark("pin", "A", 0, listOf(0.5, 0.5, 0.5, 0.5), null))
        assertEquals(5, m.n)
        assertEquals("[Mark 5]", m.token)
        val withReply = added.copy(reply = "Move [Mark 5] up")
        val removed = withReply.removingMark(5)
        assertNull(removed.marks)
        assertEquals("Move up", removed.reply)
        assertNull(DesignReviewDraft(nextMark = 20).addingMark("circle", "A", 0, listOf(0.0, 0.0, 1.0, 1.0), null))
    }

    @Test fun aMarksTokenGoesAtTheCursorOrOnTheEnd() {
        assertEquals("Look [Mark 1] " to 14, ReviewReply.insert("Look", "[Mark 1]", null, null))
        assertEquals("[Mark 1] " to 9, ReviewReply.insert("", "[Mark 1]", null, null))
        assertEquals("a [Mark 2] b" to 11, ReviewReply.insert("a b", "[Mark 2]", 2, 2))
        assertEquals("ab [Mark 2] c" to 12, ReviewReply.insert("abc", "[Mark 2]", 2, 2))
        // A stale cursor past the end goes on the end.
        assertEquals("ab [Mark 2] " to 12, ReviewReply.insert("ab", "[Mark 2]", 9, 9))
    }

    @Test fun aReloadRenumbersPhoneMarksTheMacHasSinceUsed() {
        var draft = DesignReviewDraft(
            marks = listOf(mark(2, box = listOf(0.5, 0.5, 1.0, 1.0)), mark(1, box = listOf(0.0, 0.0, 0.5, 0.5))),
            reply = "See [Mark 1] and [Mark 2], not [Mark 3]",
        )
        val fresh = DesignReviewDraft(nextMark = 2, markCount = 1)
        draft = draft.takeMacMarks(fresh)
        assertEquals(2, draft.nextMark)
        assertEquals(1, draft.markCount)
        assertEquals(listOf(3, 4), draft.marks?.map { it.n })
        assertEquals(listOf(listOf(0.0, 0.0, 0.5, 0.5), listOf(0.5, 0.5, 1.0, 1.0)), draft.marks?.map { it.box })
        // [Mark 3] was the Mac's own, so it stays as written.
        assertEquals("See [Mark 3] and [Mark 4], not [Mark 3]", draft.reply)
        // Numbers already clear of the Mac's are left alone.
        assertEquals(draft, draft.takeMacMarks(fresh))
    }

    @Test fun anAnsweredReviewReopensAsTheRunnerKeepsIt() {
        var review = review()
        val mine = DesignReviewDraft(marks = listOf(mark(1, box = listOf(0.0, 0.0, 0.5, 0.5))), reply = "[Mark 1]")
        review = review.copy(draft = review.draft.copy(nextMark = 3, markCount = 3, reply = "answered"), status = "answered")
        assertEquals(review.draft, DesignReviewDraft.reopening(review, mine))
        review = review.copy(status = "pending")
        val pending = DesignReviewDraft.reopening(review, mine)
        assertEquals(listOf(4), pending.marks?.map { it.n })
        assertEquals("[Mark 4]", pending.reply)
        assertEquals(review.draft, DesignReviewDraft.reopening(review, null))
    }

    @Test fun marksOverTheCapAfterTheMacAddsSomeAreCounted() {
        var draft = DesignReviewDraft(marks = listOf(mark(1, box = listOf(0.0, 0.0, 0.5, 0.5)), mark(2, box = listOf(0.5, 0.5, 1.0, 1.0))))
        assertEquals(0, draft.marksOver)
        draft = draft.takeMacMarks(DesignReviewDraft(nextMark = 19, markCount = 19))
        assertEquals(1, draft.marksOver)
    }

    @Test fun aCutOutIsPaddedClampedAndAtMost480Wide() {
        val crop = assertNotNull(ReviewCutOut.crop(listOf(0.5, 0.5, 0.1, 0.1), 2000, 1000))
        // Corners in either order; 0.04 each side.
        assertEquals(120, crop.x)
        assertEquals(60, crop.y)
        assertEquals(1000 - 120 + 80, crop.width)
        assertEquals(500 - 60 + 40, crop.height)
        assertEquals(480, crop.outWidth)
        val edge = assertNotNull(ReviewCutOut.crop(listOf(0.98, 0.98, 1.0, 1.0), 100, 100))
        assertEquals(94, edge.x)
        assertEquals(6, edge.width)
        assertEquals(6, edge.outWidth)
        assertNull(ReviewCutOut.crop(listOf(0.1, 0.1, 0.2), 100, 100))
    }

    @Test fun mediaTypesComeFromTheirFirstBytes() {
        fun bytes(s: String) = s.toByteArray(Charsets.ISO_8859_1)
        assertEquals("mp4", ReviewMediaType.extension(bytes("\u0000\u0000\u0000\u0018ftypisom")))
        assertEquals("mov", ReviewMediaType.extension(bytes("\u0000\u0000\u0000\u0014ftypqt  ")))
        assertEquals("m4a", ReviewMediaType.extension(bytes("\u0000\u0000\u0000 ftypM4A ")))
        assertEquals("wav", ReviewMediaType.extension(bytes("RIFF\u0000\u0000\u0000\u0000WAVE")))
        assertEquals("mp3", ReviewMediaType.extension(bytes("ID3\u0004")))
        assertEquals("mp3", ReviewMediaType.extension(byteArrayOf(0xFF.toByte(), 0xFB.toByte(), 0, 0)))
        assertEquals("aac", ReviewMediaType.extension(byteArrayOf(0xFF.toByte(), 0xF1.toByte(), 0, 0)))
        assertNull(ReviewMediaType.extension(bytes("<html>")))
        assertNull(ReviewMediaType.extension(byteArrayOf(1)))
    }

    // The board

    private val measure = CanvasMeasure(words = { _, _ -> 66f }, note = { _ -> 200f to 40f })

    private fun marked() = read("""{"id":"r","title":"T","note":"Lead words","status":"pending","revision":2,"draft":{"notes":{}},"options":[
        {"id":"A","title":"A","note":"Words","shots":[{"src":"review:r:a","kind":"image","marks":[{"kind":"circle","box":[0.1,0.1,0.2,0.2],"note":"left"},{"kind":"underline","box":[0.7,0.5,0.9,0.6],"note":"right"}]},{"src":"review:r:b","kind":"image"}]},
        {"id":"B","title":"B","shots":[{"src":"review:r:c","kind":"video"}]}]}""")

    @Test fun theTourGoesLeadStartThenEachPictureThenAll() {
        val board = BoardLayout.layout(marked(), { 4f / 3 }, measure)
        val lits = board.stops.map { it.lit }
        assertEquals(
            listOf(CanvasLit.Lead, CanvasLit.Start, CanvasLit.Opening(0), CanvasLit.Shot(0, 1), CanvasLit.Opening(1), CanvasLit.All),
            lits,
        )
        assertEquals(3, board.stopIndex(board.stops, 0, 1))
        assertEquals(board.bounds, board.stops.last().rect)
    }

    @Test fun columnsGoLeftToRightStaggeredWithRoomForLeftNotes() {
        val board = BoardLayout.layout(marked(), { 4f / 3 }, measure)
        val a = board.options[0]
        val b = board.options[1]
        // A has a note on its left, so it starts further right than the lead's gap alone.
        assertEquals(CanvasMetrics.LEAD_WIDTH + 140 + CanvasMetrics.NOTE_GAP + CanvasMetrics.NOTE_WIDTH + 40, a.frame.x)
        assertEquals(a.frame.maxX + CanvasMetrics.GUTTER, b.frame.x)
        assertEquals(CanvasMetrics.STAGGER[1], b.frame.y)
        assertEquals(480f, a.shots[0].picture.h)
        // The second picture has a caption; the first, with no title, none.
        assertEquals(0f, a.shots[0].caption.h)
        assertEquals(CanvasMetrics.CAPTION_HEIGHT, a.shots[1].caption.h)
        val notes = a.shots[0].notes
        assertEquals(listOf(true, false), notes.map { it.left })
        assertTrue(notes[0].rect.maxX < a.shots[0].picture.minX && notes[1].rect.minX > a.shots[0].picture.maxX)
    }

    @Test fun aDrawingBecomesAMarkOnThePictureUnderIt() {
        val review = marked()
        val board = BoardLayout.layout(review, { 4f / 3 }, measure)
        val p = board.options[1].shots[0].picture
        val circle = listOf(WPoint(p.x + 64, p.y + 48), WPoint(p.x + 192, p.y + 48), WPoint(p.x + 128, p.y + 144))
        val placed = assertNotNull(BoardMarks.place(board, review, "circle", circle, 0f))
        assertEquals(1, placed.option)
        assertEquals(listOf(0.1, 0.1, 0.3, 0.3), placed.box.map { Math.round(it * 1000) / 1000.0 })
        // Too short, or off every picture.
        assertNull(BoardMarks.place(board, review, "circle", circle.take(2), 0f))
        assertNull(BoardMarks.place(board, review, "pin", listOf(WPoint(-5000f, -5000f)), 0f))
        val pin = assertNotNull(BoardMarks.place(board, review, "pin", listOf(WPoint(p.midX, p.midY)), 0f))
        assertEquals(listOf(0.5, 0.5, 0.5, 0.5), pin.box)
    }

    @Test fun theCameraFitsFliesAndEases() {
        val area = WRect(0f, 100f, 1000f, 2000f)
        val cam = CanvasCamera.fit(WRect(0f, 0f, 640f, 480f), area, 12f, 0.1f, 4f)
        assertEquals((1000f - 24) / 640, cam.s, 1e-4f)
        val centre = cam.toScreen(WPoint(320f, 240f))
        assertEquals(500f, centre.x, 1e-3f)
        assertEquals(1100f, centre.y, 1e-3f)
        assertEquals(WPoint(320f, 240f).x, cam.toWorld(centre).x, 1e-3f)
        // Never past the most it may zoom.
        assertEquals(1.4f, CanvasCamera.fit(WRect(0f, 0f, 10f, 10f), area, 12f, 0.1f, 1.4f).s)
        val far = CanvasCamera(2f, -500f, 0f)
        val start = cam.toward(far, 0f, 1000f, 2200f)
        assertEquals(cam.s, start.s, 1e-5f)
        assertEquals(cam.tx, start.tx, 1e-2f)
        assertEquals(cam.ty, start.ty, 1e-2f)
        val mid = cam.toward(far, 0.5f, 1000f, 2200f)
        assertEquals(Math.sqrt((cam.s * 2f).toDouble()).toFloat(), mid.s, 1e-4f)
        assertEquals(0f, CanvasCamera.ease(0f))
        assertEquals(1f, CanvasCamera.ease(1f))
        assertEquals(0.5f, CanvasCamera.ease(0.5f))
    }

    @Test fun theWobbleIsSeededAsTheMacs() {
        // mulberry32's first draws for seed 7 (option 0, shot 0, mark 0), as the Mac and the iPhone make them.
        val w = CanvasWobble(CanvasDoodle.seed(0, 0, 0))
        assertEquals(0.0117047f, w.next(), 1e-6f)
        assertEquals(0.0619583f, w.next(), 1e-6f)
        assertEquals(CanvasDoodle.circle(WRect(0f, 0f, 100f, 50f), 7u), CanvasDoodle.circle(WRect(0f, 0f, 100f, 50f), 7u))
        assertEquals(22, CanvasDoodle.circle(WRect(0f, 0f, 100f, 50f), 7u).curves.size)
    }
}
