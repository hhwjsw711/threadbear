package com.mikerosoft.threadbear.kit

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull

/**
 * A design review as the runner sends it to a phone (DesignReviews.swift),
 * with private image sources instead of file paths.
 */
data class PhoneDesignReview(
    val id: String,
    val title: String,
    val note: String? = null,
    val recommended: String? = null,
    val status: String,
    val revision: Double,
    val draft: DesignReviewDraft,
    val options: List<Option>,
    /**
     * Whether this thread's runner takes the phone's marks (API 106 runners
     * say true). A newer backend in front of an older runner would drop them.
     */
    val canMark: Boolean? = null,
) {
    data class Option(
        val id: String,
        val title: String,
        val note: String? = null,
        val reference: Boolean? = null,
        val shots: List<Shot>,
    ) {
        val isReference get() = reference == true

        companion object {
            fun read(o: JsonObject) = Option(
                id = o.needStr("id"),
                title = o.needStr("title"),
                note = o.str("note"),
                reference = o.bool("reference"),
                // Strict: a mark points at a shot by its place in this list.
                shots = (o.arr("shots") ?: throw BadRow("No shots")).map { Shot.read(it as? JsonObject ?: throw BadRow("Not a shot")) },
            )
        }
    }

    data class Shot(
        val src: String,
        val title: String? = null,
        val kind: String,
        /** False when the runner can't send this still, so the board says so rather than waiting. */
        val preview: Boolean? = null,
        /** The agent's marks on the still (API 106). */
        val marks: List<AgentMark>? = null,
        /** The video or sound itself (API 106), a src like the still's, for one of 10 MB or less. */
        val media: String? = null,
    ) {
        val isVideo get() = kind == "video"
        val isAudio get() = kind == "audio"

        companion object {
            fun read(o: JsonObject) = Shot(
                src = o.needStr("src"),
                title = o.str("title"),
                kind = o.needStr("kind"),
                preview = o.bool("preview"),
                // One the phone can't read (a newer kind's shape, a bad box) is dropped, not the review.
                marks = o.arr("marks")?.lossy { AgentMark.read(it as JsonObject) }?.filter { it.isValid },
                media = o.str("media"),
            )
        }
    }

    /** A mark the agent drew on a shot: `box` is x0, y0, x1, y1 as fractions of the still; an arrow runs first corner to second. */
    data class AgentMark(val kind: String, val box: List<Double>, val note: String? = null, val ink: String? = null) {
        val isValid get() = box.size == 4 && box.all { it.isFinite() }

        companion object {
            fun read(o: JsonObject) = AgentMark(
                kind = o.needStr("kind"),
                box = (o.arr("box") ?: throw BadRow("No box")).map { (it as? JsonPrimitive)?.takeIf { p -> !p.isString }?.doubleOrNull ?: throw BadRow("Bad box") },
                note = o.str("note"),
                ink = o.str("ink"),
            )
        }
    }

    /** Every still and media src, for phone:reviewImages. */
    val sources: List<String> get() = options.flatMap { o -> o.shots.flatMap { listOfNotNull(it.src, it.media) } }.toSortedSet().toList()
    val pending get() = status == "pending"

    companion object {
        fun read(o: JsonObject) = PhoneDesignReview(
            id = o.needStr("id"),
            title = o.needStr("title"),
            note = o.str("note"),
            recommended = o.str("recommended"),
            status = o.needStr("status"),
            revision = o.needNum("revision"),
            draft = DesignReviewDraft.read(o.obj("draft") ?: throw BadRow("No draft")),
            options = (o.arr("options") ?: throw BadRow("No options")).map { Option.read(it as? JsonObject ?: throw BadRow("Not an option")) },
            canMark = o.bool("canMark"),
        )
    }
}

/**
 * A mark drawn on the phone's board (API 106): a circle, highlight or pin
 * on part of a shot's still, `box` as fractions of it. `n` is what
 * "[Mark n]" in the reply points at; `storageId` the uploaded cut-out.
 */
data class ReviewUserMark(
    val n: Int,
    val kind: String = "circle",
    val optionId: String,
    val shot: Int,
    val box: List<Double>,
    val storageId: String? = null,
    /** The stroke as drawn, as fractions of the still, to draw it again here. Not sent: the runner takes the box. */
    val path: List<List<Double>>? = null,
) {
    val token get() = "[Mark $n]"

    val arguments: JsonObject get() = buildJsonObject {
        put("n", JsonPrimitive(n))
        put("kind", JsonPrimitive(kind))
        put("optionId", JsonPrimitive(optionId))
        put("shot", JsonPrimitive(shot))
        put("box", JsonArray(box.map(::JsonPrimitive)))
        storageId?.let { put("storageId", JsonPrimitive(it)) }
    }

    companion object {
        /** The runner refuses more. */
        const val MAX_COUNT = 20
    }
}

/** An answer being written: picks, notes, the reply, None of them, and the phone's own marks. */
data class DesignReviewDraft(
    val pickedId: String? = null,
    val pickedIds: List<String>? = null,
    val notes: Map<String, String> = emptyMap(),
    val reply: String? = null,
    val none: Boolean? = null,
    /** The phone's own marks, added to the Mac's saved ones. Never read from the runner: a Mac's marks point at its own cut-outs. */
    val marks: List<ReviewUserMark>? = null,
    /** The highest number among the Mac's saved marks: the phone's number on from there. */
    val nextMark: Int? = null,
    /** How many marks the Mac has saved: theirs and the phone's share the cap. Older runners don't say, so nextMark stands in. */
    val markCount: Int? = null,
) {
    val picks: Set<String> get() = (pickedIds ?: listOfNotNull(pickedId)).toSet()

    /** The first number the phone may give a mark. */
    val firstMarkNumber: Int get() = maxOf(0, nextMark ?: 0) + 1

    /** How many marks the phone may have, after the Mac's. */
    val markCapacity: Int get() = maxOf(0, ReviewUserMark.MAX_COUNT - maxOf(0, markCount ?: nextMark ?: 0))

    /** The lowest number the phone can still give a mark, or null when there's no room. */
    val nextMarkNumber: Int?
        get() {
            val mine = marks.orEmpty()
            if (mine.size >= markCapacity) return null
            val used = mine.map { it.n }.toSet()
            return generateSequence(firstMarkNumber) { it + 1 }.first { it !in used }
        }

    /** How many of the phone's marks are over the cap, after the Mac added some. */
    val marksOver: Int get() = maxOf(0, marks.orEmpty().size - markCapacity)

    fun pick(id: String, selected: Boolean): DesignReviewDraft {
        val chosen = picks.toMutableSet()
        if (selected) chosen += id else chosen -= id
        val sorted = chosen.sorted()
        return copy(pickedIds = sorted, pickedId = sorted.firstOrNull(), none = if (selected) null else none)
    }

    fun pickNone(selected: Boolean): DesignReviewDraft =
        if (selected) copy(none = true, pickedId = null, pickedIds = null) else copy(none = null)

    /**
     * Takes the Mac's marks as a freshly loaded review has them. A phone mark
     * whose number the Mac has since used is numbered on from the Mac's, and
     * the reply's "[Mark n]" follow it.
     */
    fun takeMacMarks(fresh: DesignReviewDraft): DesignReviewDraft {
        val taken = copy(nextMark = fresh.nextMark, markCount = fresh.markCount)
        val first = taken.firstMarkNumber
        val mine = marks?.sortedBy { it.n } ?: return taken
        if (mine.none { it.n < first }) return taken
        var text = reply
        // Through placeholders, so a new number an old one had isn't rewritten twice.
        mine.forEachIndexed { i, m -> text = text?.replace(m.token, "\u0001$i\u0001") }
        val renumbered = mine.mapIndexed { i, m -> m.copy(n = first + i) }
        renumbered.forEachIndexed { i, m -> text = text?.replace("\u0001$i\u0001", m.token) }
        return taken.copy(marks = renumbered, reply = text)
    }

    /** Adds a mark with the next free number, its token on the reply's end; null when there's no room. */
    fun addingMark(kind: String, optionId: String, shot: Int, box: List<Double>, path: List<List<Double>>?): Pair<DesignReviewDraft, ReviewUserMark>? {
        val n = nextMarkNumber ?: return null
        val mark = ReviewUserMark(n, kind, optionId, shot, box, path = path)
        return copy(marks = marks.orEmpty() + mark) to mark
    }

    /** Takes a mark off, and its token out of the reply. */
    fun removingMark(n: Int): DesignReviewDraft {
        val mark = marks?.firstOrNull { it.n == n } ?: return this
        val left = marks.filter { it.n != n }
        return copy(
            marks = left.ifEmpty { null },
            reply = reply?.replace(mark.token + " ", "")?.replace(mark.token, ""),
        )
    }

    fun canSend(review: PhoneDesignReview): Boolean {
        val known = review.options.map { it.id }.toSet()
        val pickable = review.options.filter { !it.isReference }.map { it.id }.toSet()
        val p = picks
        if (!review.pending || !review.revision.isFinite() || review.revision < 0 || Math.rint(review.revision) != review.revision) return false
        if (!pickable.containsAll(p) || !known.containsAll(notes.keys)) return false
        if (none == true && p.isNotEmpty()) return false
        if ((reply?.length ?: 0) > 8000 || notes.values.any { it.length > 4000 }) return false
        if (!marksFit(review)) return false
        return p.isNotEmpty() || none == true || !marks.isNullOrEmpty() || !reply.isNullOrBlank() || notes.values.any { it.isNotBlank() }
    }

    /** The phone's marks are within the cap, numbered clear of the Mac's and each other, on real shots of answerable options. */
    fun marksFit(review: PhoneDesignReview): Boolean {
        val mine = marks.orEmpty()
        if (mine.isEmpty()) return true
        if (mine.size > markCapacity || mine.map { it.n }.toSet().size != mine.size) return false
        return mine.all { mark ->
            // A reference is there to compare against, not to answer on.
            val option = review.options.firstOrNull { it.id == mark.optionId }
            mark.n >= firstMarkNumber && option != null && !option.isReference &&
                mark.shot in option.shots.indices && mark.box.size == 4 &&
                mark.box.all { it.isFinite() && it in 0.0..1.0 }
        }
    }

    /**
     * phone:respondReview's draft. Notes go as a list: an option id can be any
     * text, and Convex refuses an object key that isn't plain ASCII or starts with "$".
     */
    val arguments: JsonObject get() = buildJsonObject {
        put("notes", JsonArray(notes.keys.sorted().map { buildJsonObject { put("id", JsonPrimitive(it)); put("text", JsonPrimitive(notes[it] ?: "")) } }))
        if (pickedIds != null) put("pickedIds", JsonArray(pickedIds.map(::JsonPrimitive)))
        else if (pickedId != null) put("pickedId", JsonPrimitive(pickedId))
        reply?.let { put("reply", JsonPrimitive(it)) }
        if (none == true) put("none", JsonPrimitive(true))
        // Only when there are some: a backend before API 106 refuses the field.
        if (!marks.isNullOrEmpty()) put("marks", JsonArray(marks.sortedBy { it.n }.map { it.arguments }))
    }

    companion object {
        /** The runner's draft. Its marks are never read. */
        fun read(o: JsonObject) = DesignReviewDraft(
            pickedId = o.str("pickedId"),
            pickedIds = o.strings("pickedIds"),
            notes = o.obj("notes")?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.takeIf { it.isString }?.let { k to it.content } }?.toMap() ?: emptyMap(),
            reply = o.str("reply"),
            none = o.bool("none"),
            nextMark = o.num("nextMark")?.wholeCount(),
            markCount = o.num("markCount")?.wholeCount(),
        )

        /**
         * What a freshly loaded review shows: an answered one exactly as the
         * runner keeps it; a pending one the phone's own draft if there is one
         * (`kept`), brought up to date with the Mac's marks.
         */
        fun reopening(loaded: PhoneDesignReview, kept: DesignReviewDraft?): DesignReviewDraft {
            if (!loaded.pending) return loaded.draft
            return (kept ?: loaded.draft).takeMacMarks(loaded.draft)
        }
    }
}

/** A designReviews command's answer: the pending list, or one review. */
data class DesignReviewResult(val reviews: List<Entry>? = null, val review: PhoneDesignReview? = null, val truncated: Boolean? = null) {
    data class Entry(val id: String, val title: String)

    companion object {
        fun read(o: JsonObject) = DesignReviewResult(
            reviews = o.arr("reviews")?.lossy { val e = it as JsonObject; Entry(e.needStr("id"), e.needStr("title")) },
            review = o.obj("review")?.let { runCatching { PhoneDesignReview.read(it) }.getOrNull() },
            truncated = o.bool("truncated"),
        )

        /**
         * phone:command's `result`: a review comes as JSON text (API 86), as its
         * notes' keys are option ids Convex can't take as object keys; an
         * object is read too. Anything else (a slash command list) is none.
         */
        fun fromResult(result: JsonElement?): DesignReviewResult? = when {
            result is JsonPrimitive && result.isString -> runCatching { (parseJson(result.content) as? JsonObject)?.let(::read) }.getOrNull()
            result is JsonObject -> runCatching { read(result) }.getOrNull()
            else -> null
        }
    }
}

/** The marked part of a still as a pixel rect, padded by 0.04 of it each side, and the size it's sent at (no more than 480 wide). */
object ReviewCutOut {
    data class Crop(val x: Int, val y: Int, val width: Int, val height: Int, val outWidth: Int, val outHeight: Int)

    fun crop(box: List<Double>, width: Int, height: Int): Crop? {
        if (box.size != 4 || width < 1 || height < 1) return null
        val w = width.toDouble()
        val h = height.toDouble()
        val x0 = maxOf(0.0, minOf(box[0], box[2]) - 0.04)
        val x1 = minOf(1.0, maxOf(box[0], box[2]) + 0.04)
        val y0 = maxOf(0.0, minOf(box[1], box[3]) - 0.04)
        val y1 = minOf(1.0, maxOf(box[1], box[3]) + 0.04)
        // Integral, as CGRect.integral: out to whole pixels.
        val left = Math.floor(x0 * w).toInt().coerceIn(0, width)
        val top = Math.floor(y0 * h).toInt().coerceIn(0, height)
        val right = Math.ceil(x1 * w).toInt().coerceIn(0, width)
        val bottom = Math.ceil(y1 * h).toInt().coerceIn(0, height)
        val cw = right - left
        val ch = bottom - top
        if (cw < 1 || ch < 1) return null
        val scale = minOf(1.0, 480.0 / cw)
        return Crop(left, top, cw, ch, Math.round(cw * scale).toInt().coerceAtLeast(1), Math.round(ch * scale).toInt().coerceAtLeast(1))
    }
}

/** A review video or sound's file type, from its first bytes, as the address says nothing (ReviewMedia.fileExtension). */
object ReviewMediaType {
    fun extension(data: ByteArray): String? {
        val bytes = data.copyOf(minOf(12, data.size))
        if (bytes.size < 4) return null
        fun ascii(from: Int, to: Int) = String(bytes, from, to - from, Charsets.ISO_8859_1)
        if (bytes.size >= 12 && ascii(4, 8) == "ftyp") {
            return when (ascii(8, 12)) {
                "qt  " -> "mov"
                "M4A ", "M4B " -> "m4a"
                else -> "mp4"
            }
        }
        if (bytes.size >= 12 && ascii(0, 4) == "RIFF" && ascii(8, 12) == "WAVE") return "wav"
        if (ascii(0, 3) == "ID3") return "mp3"
        if (ascii(0, 4) == "caff") return "caf"
        if (ascii(0, 4) == "OggS") return "ogg"
        val b0 = bytes[0].toInt() and 0xFF
        val b1 = bytes[1].toInt() and 0xFF
        if (b0 == 0xFF) {
            if (b1 and 0xF6 == 0xF0) return "aac"
            if (b1 and 0xE0 == 0xE0) return "mp3"
        }
        return null
    }
}

/** Putting a mark's "[Mark n]" into the reply. */
object ReviewReply {
    /**
     * At the cursor (`start` to `end`) while the reply's being typed in, with
     * a space either side where it needs one, else on the end. The text and
     * where the cursor goes after it.
     */
    fun insert(text: String, token: String, start: Int?, end: Int?): Pair<String, Int> {
        if (start != null && end != null && start in 0..text.length && end in start..text.length) {
            val before = text.getOrNull(start - 1)
            val after = text.getOrNull(end)
            val piece = (if (before == null || before == ' ' || before == '\n') "" else " ") + token + (if (after == ' ') "" else " ")
            return text.replaceRange(start, end, piece) to start + piece.length
        }
        val gap = if (text.isEmpty() || text.endsWith(" ") || text.endsWith("\n")) "" else " "
        val out = text + gap + token + " "
        return out to out.length
    }
}
