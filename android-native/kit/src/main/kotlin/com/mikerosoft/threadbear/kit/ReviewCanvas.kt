package com.mikerosoft.threadbear.kit

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

// The review as a canvas, as the Mac lays it out: a port of the iPhone's
// ReviewCanvas.swift, itself a port of desktop/core/src/review_canvas.rs,
// which is the source of truth. The board is in world units, where a
// picture is 640 wide; the camera maps them to the screen (screen = world ×
// s + t). The app draws it; this is the geometry, so the tests can hold it.

data class WPoint(val x: Float, val y: Float)

data class WRect(val x: Float, val y: Float, val w: Float, val h: Float) {
    val minX get() = x
    val minY get() = y
    val maxX get() = x + w
    val maxY get() = y + h
    val midX get() = x + w / 2
    val midY get() = y + h / 2
    val center get() = WPoint(midX, midY)

    fun union(o: WRect): WRect {
        val l = min(minX, o.minX)
        val t = min(minY, o.minY)
        return WRect(l, t, max(maxX, o.maxX) - l, max(maxY, o.maxY) - t)
    }

    fun inset(dx: Float, dy: Float) = WRect(x + dx, y + dy, w - dx * 2, h - dy * 2)
    fun contains(p: WPoint) = p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY

    /** A point given as fractions of this rect. */
    fun at(fx: Double, fy: Double) = WPoint(x + fx.toFloat() * w, y + fy.toFloat() * h)

    /** A mark's box on this rect, unnormalised as the Mac's is (an arrow's box runs tail to head). */
    fun part(box: List<Double>): WRect {
        if (box.size != 4) return WRect(0f, 0f, 0f, 0f)
        val a = at(box[0], box[1])
        val b = at(box[2], box[3])
        return WRect(a.x, a.y, b.x - a.x, b.y - a.y)
    }

    /** With a positive width and height. */
    val standardized get() = WRect(min(x, x + w), min(y, y + h), abs(w), abs(h))

    companion object {
        val ZERO = WRect(0f, 0f, 0f, 0f)
    }
}

object CanvasMetrics {
    const val PICTURE_WIDTH = 640f
    /** Between an option's last picture and its words. */
    const val GAP = 22f
    /** Between one of an option's pictures and the next one's caption. */
    const val SHOT_GAP = 48f
    const val CAPTION_HEIGHT = 34f
    const val WORDS_SIZE = 22f
    const val NOTE_SIZE = 36f
    const val NOTE_GAP = 96f
    const val NOTE_WIDTH = 330f
    const val GUTTER = NOTE_GAP + NOTE_WIDTH + 130f
    const val HALO_PAD = 40f
    const val TITLE_ROW = 52f
    const val TITLE_GAP = 10f
    const val TITLE_SIZE = 26f
    const val LETTER_SIZE = 230f
    const val LETTER_LEFT = 0.62f
    const val LETTER_ABOVE = 0.86f
    const val LEAD_WIDTH = 440f
    val STAGGER = floatArrayOf(0f, 130f, 50f, 170f)
    const val NOTE_SPACING = 30f
    /** Zooms in points per world unit: the app multiplies by the screen's density. */
    const val MIN_ZOOM = 0.05f
    const val MAX_ZOOM = 3f
    /** The tour never zooms past this. */
    const val STOP_ZOOM = 1.4f
    const val FLIGHT_MS = 650
}

/** Text sizes as the phone's fonts set them, in world units. */
class CanvasMeasure(
    /** The height of words at WORDS_SIZE wrapped to a width. */
    val words: (String, Float) -> Float,
    /** A handwritten note's size at NOTE_SIZE, wrapped to NOTE_WIDTH. */
    val note: (String) -> Pair<Float, Float>,
)

data class NotePlace(val mark: Int, val rect: WRect, val target: WPoint, val left: Boolean)

data class BoardShotLayout(val option: Int, val shot: Int, val picture: WRect, val caption: WRect, val notes: List<NotePlace>) {
    val extent: WRect get() = notes.fold(picture.union(caption)) { r, n -> r.union(n.rect) }
}

data class BoardOptionLayout(
    val index: Int,
    val frame: WRect,
    val words: WRect?,
    val shots: List<BoardShotLayout>,
    val halo: WRect,
    val title: WRect,
    val letter: WRect,
) {
    val extent: WRect get() = shots.fold(halo.union(letter)) { r, s -> r.union(s.extent) }
}

/** What a stop lights; the rest of the board dims while touring. */
sealed interface CanvasLit {
    /** The agent's lead alone (on a portrait screen the Mac's lead-and-first-option opening is too small to read). */
    data object Lead : CanvasLit
    /** Where it opens: all of the first option. Nothing dims. */
    data object Start : CanvasLit
    data class Opening(override val option: Int) : CanvasLit
    data class Shot(override val option: Int, val shot: Int) : CanvasLit
    data object All : CanvasLit

    /** The option a stop is on, if one. */
    val option: Int? get() = null

    /** Whether this stop lights a shot. */
    fun shows(option: Int, shot: Int): Boolean = when (this) {
        All, Start -> true
        Lead -> false
        is Opening -> this.option == option && shot == 0
        is Shot -> this.option == option && this.shot == shot
    }

    fun showsWords(option: Int): Boolean = when (this) {
        All, Start -> true
        Lead -> false
        else -> this.option == option
    }

    val dims: Boolean get() = this != All && this != Start
}

data class CanvasStop(val rect: WRect, val lit: CanvasLit)

data class BoardLayout(val lead: WRect?, val options: List<BoardOptionLayout>, val bounds: WRect) {
    fun shot(option: Int, shot: Int): BoardShotLayout? = options.getOrNull(option)?.shots?.getOrNull(shot)

    fun shot(at: WPoint): BoardShotLayout? = options.asSequence().flatMap { it.shots }.firstOrNull { it.picture.contains(at) }

    /**
     * The agent's order, as the Mac steps it: the lead, the first option
     * whole, each option's pictures in turn (with its name on the first and
     * its words on the last), then everything.
     */
    val stops: List<CanvasStop>
        get() = buildList {
            lead?.let { add(CanvasStop(it, CanvasLit.Lead)) }
            options.firstOrNull()?.let { add(CanvasStop(it.extent, CanvasLit.Start)) }
            for (option in options) {
                val last = option.shots.size - 1
                for (shot in option.shots) {
                    var rect = shot.extent
                    if (shot.shot == last) option.words?.let { rect = rect.union(it) }
                    if (shot.shot == 0) add(CanvasStop(rect.union(option.title), CanvasLit.Opening(option.index)))
                    else add(CanvasStop(rect, CanvasLit.Shot(option.index, shot.shot)))
                }
            }
            add(CanvasStop(bounds, CanvasLit.All))
        }

    /** The tour stop showing this shot. */
    fun stopIndex(stops: List<CanvasStop>, option: Int, shot: Int): Int? =
        stops.indexOfFirst { it.lit == (if (shot == 0) CanvasLit.Opening(option) else CanvasLit.Shot(option, shot)) }.takeIf { it >= 0 }

    companion object {
        /**
         * Lays the review out: the lead at the top left, then a column for each
         * option left to right, its name over its pictures and its words under
         * them, the agent's notes beside each picture. `aspect` is a shot's
         * width over height.
         */
        fun layout(review: PhoneDesignReview, aspect: (PhoneDesignReview.Shot) -> Float, measure: CanvasMeasure): BoardLayout {
            val lead = review.note?.takeIf { it.isNotBlank() }?.let { note ->
                WRect(0f, 0f, CanvasMetrics.LEAD_WIDTH, measure.words(note, CanvasMetrics.LEAD_WIDTH - 48) + 48)
            }
            var x = lead?.let { it.maxX + 140 } ?: 0f
            val options = mutableListOf<BoardOptionLayout>()
            review.options.forEachIndexed { index, option ->
                val top = CanvasMetrics.STAGGER[index % CanvasMetrics.STAGGER.size]
                if (needsLeftRoom(option)) x += CanvasMetrics.NOTE_GAP + CanvasMetrics.NOTE_WIDTH + 40
                val laid = layOption(index, option, x, top, aspect, measure)
                x = laid.frame.maxX + CanvasMetrics.GUTTER
                options += laid
            }
            val rects = options.map { it.extent } + listOfNotNull(lead)
            val bounds = rects.drop(1).fold(rects.firstOrNull() ?: WRect.ZERO) { r, o -> r.union(o) }
            return BoardLayout(lead, options, bounds)
        }

        private fun layOption(
            index: Int,
            option: PhoneDesignReview.Option,
            x: Float,
            top: Float,
            aspect: (PhoneDesignReview.Shot) -> Float,
            measure: CanvasMeasure,
        ): BoardOptionLayout {
            val w = CanvasMetrics.PICTURE_WIDTH
            val title = WRect(x, top, w, CanvasMetrics.TITLE_ROW)
            var y = title.maxY + CanvasMetrics.TITLE_GAP
            val shots = option.shots.mapIndexed { i, shot ->
                // Later pages always have a name over them ("2 of 3" if not their own); the first only when it has its own.
                val captionH = if (i > 0 || shot.title != null) CanvasMetrics.CAPTION_HEIGHT else 0f
                val caption = WRect(x, y, w, captionH)
                val picture = WRect(x, caption.maxY, w, w / max(0.05f, aspect(shot)))
                y = picture.maxY + CanvasMetrics.SHOT_GAP
                BoardShotLayout(index, i, picture, caption, placeNotes(picture, shot.marks.orEmpty(), measure))
            }
            y += CanvasMetrics.GAP - CanvasMetrics.SHOT_GAP
            var words: WRect? = null
            option.note?.takeIf { it.isNotBlank() }?.let { note ->
                val r = WRect(x, y, w, measure.words(note, w))
                y = r.maxY
                words = r
            }
            val frame = WRect(x, top, w, y - top)
            val pad = CanvasMetrics.HALO_PAD
            val halo = frame.inset(-pad, -pad)
            val first = shots.firstOrNull()?.picture ?: frame
            val size = CanvasMetrics.LETTER_SIZE
            val letter = WRect(first.maxX - size * CanvasMetrics.LETTER_LEFT, first.minY - size * CanvasMetrics.LETTER_ABOVE, size * 0.8f, size)
            return BoardOptionLayout(index, frame, words, shots, halo, title, letter)
        }

        /** A note goes left of its picture when its mark is on the picture's left part. */
        fun noteGoesLeft(mark: PhoneDesignReview.AgentMark): Boolean = (mark.box[0] + mark.box[2]) / 2 < 0.42

        /** Where a mark's pointer lands, on the side its note is. */
        fun target(picture: WRect, mark: PhoneDesignReview.AgentMark): WPoint {
            val part = picture.part(mark.box)
            val left = noteGoesLeft(mark)
            val edge = if (left) part.x else part.x + part.w
            val out = if (left) -1f else 1f
            return when (mark.kind) {
                "circle" -> WPoint(edge + out * (part.w * 0.21f + 8), part.y + part.h * 0.45f)
                "underline" -> WPoint(edge + out * 10, part.y + part.h)
                "highlight" -> WPoint(edge + out * 8, part.y + part.h / 2)
                else -> WPoint(part.x + part.w / 2, part.y + part.h / 2)
            }
        }

        /** Notes in a column each side of their picture, level with their mark, nudged up so the curl arrives from below, pushed down so none overlap. */
        private fun placeNotes(picture: WRect, marks: List<PhoneDesignReview.AgentMark>, measure: CanvasMeasure): List<NotePlace> {
            val order = marks.indices.filter { !marks[it].note.isNullOrEmpty() }.sortedBy { target(picture, marks[it]).y }
            var floorLeft = -Float.MAX_VALUE
            var floorRight = -Float.MAX_VALUE
            val placed = mutableListOf<NotePlace>()
            for (i in order) {
                val (nw, nh) = measure.note(marks[i].note ?: "")
                val t = target(picture, marks[i])
                val left = noteGoesLeft(marks[i])
                val floor = if (left) floorLeft else floorRight
                val y = max(t.y - nh / 2 - 10, floor)
                val x = if (left) picture.minX - CanvasMetrics.NOTE_GAP - nw else picture.maxX + CanvasMetrics.NOTE_GAP
                val rect = WRect(x, y, nw, nh)
                if (left) floorLeft = rect.maxY + CanvasMetrics.NOTE_SPACING else floorRight = rect.maxY + CanvasMetrics.NOTE_SPACING
                placed += NotePlace(i, rect, t, left)
            }
            return placed.sortedBy { it.mark }
        }

        private fun needsLeftRoom(option: PhoneDesignReview.Option): Boolean =
            option.shots.flatMap { it.marks.orEmpty() }.any { !it.note.isNullOrEmpty() && noteGoesLeft(it) }
    }
}

/** The camera: screen = world × s + t, in the screen's pixels. */
data class CanvasCamera(val s: Float = 0.4f, val tx: Float = 0f, val ty: Float = 0f) {
    fun toScreen(p: WPoint) = WPoint(p.x * s + tx, p.y * s + ty)
    fun toWorld(p: WPoint) = WPoint((p.x - tx) / s, (p.y - ty) / s)
    fun rect(r: WRect) = WRect(r.x * s + tx, r.y * s + ty, r.w * s, r.h * s)

    /**
     * Partway to `to` (k already eased): zooming in even steps and moving the
     * view's centre in a straight line, so a flight neither lurches nor swings wide.
     */
    fun toward(to: CanvasCamera, k: Float, viewW: Float, viewH: Float): CanvasCamera {
        fun centre(c: CanvasCamera) = WPoint((viewW / 2 - c.tx) / c.s, (viewH / 2 - c.ty) / c.s)
        val a = centre(this)
        val b = centre(to)
        val s = exp(ln(s) + (ln(to.s) - ln(s)) * k)
        val cx = a.x + (b.x - a.x) * k
        val cy = a.y + (b.y - a.y) * k
        return CanvasCamera(s, viewW / 2 - cx * s, viewH / 2 - cy * s)
    }

    companion object {
        /** Fits `rect` in `area` (screen) with `pad` round it, between `least` and `most`. */
        fun fit(rect: WRect, area: WRect, pad: Float, least: Float, most: Float): CanvasCamera {
            val s = min((area.w - pad * 2) / max(1f, rect.w), (area.h - pad * 2) / max(1f, rect.h))
            val clamped = min(most, max(least, s))
            return CanvasCamera(clamped, area.midX - rect.midX * clamped, area.midY - rect.midY * clamped)
        }

        fun ease(k: Float): Float {
            val t = min(1f, max(0f, k))
            return if (t < 0.5f) 4 * t * t * t else 1 - (-2 * t + 2).pow(3) / 2
        }
    }
}

/** A pen stroke: a start and cubic segments (control 1, control 2, end). */
data class CanvasStroke(val start: WPoint, val curves: List<List<WPoint>>) {
    companion object {
        val EMPTY = CanvasStroke(WPoint(0f, 0f), emptyList())

        /** A smooth stroke through points (Catmull-Rom). */
        fun through(points: List<WPoint>): CanvasStroke {
            val start = points.firstOrNull() ?: return EMPTY
            val curves = (0 until points.size - 1).map { i ->
                val p0 = points[max(0, i - 1)]
                val p1 = points[i]
                val p2 = points[i + 1]
                val p3 = if (i + 2 < points.size) points[i + 2] else p2
                listOf(
                    WPoint(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6),
                    WPoint(p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6),
                    p2,
                )
            }
            return CanvasStroke(start, curves)
        }
    }
}

/** The Mac's seeded wobble (mulberry32), so a mark draws the same every time and the same as on the Mac. */
class CanvasWobble(private var state: UInt) {
    fun next(): Float {
        state += 0x6D2B79F5u
        var t = state
        t = (t xor (t shr 15)) * (t or 1u)
        t = t xor (t + ((t xor (t shr 7)) * (t or 61u)))
        return ((t xor (t shr 14)).toFloat() / UInt.MAX_VALUE.toFloat())
    }
}

object CanvasDoodle {
    /** The Mac's seed for a mark's wobble: option × 97 + shot × 13 + mark + 7. */
    fun seed(option: Int, shot: Int, mark: Int): UInt = (option * 97 + shot * 13 + mark + 7).toUInt()

    /** A loop round a box, a little more than once round, the ends crossing. */
    fun circle(part: WRect, seed: UInt): CanvasStroke {
        val w = CanvasWobble(seed)
        val cx = part.x + part.w / 2
        val cy = part.y + part.h / 2
        val rx = part.w / 2 * 1.42f + 8
        val ry = part.h / 2 * 1.42f + 8
        val start = -2.2f + w.next() * 0.6f
        val turn = 2 * PI.toFloat() * 1.12f
        val n = 22
        val points = (0..n).map { i ->
            val t = start + turn * i / n
            val k = 1 + (w.next() - 0.5f) * 0.06f + (i.toFloat() / n) * 0.05f
            WPoint(cx + cos(t) * rx * k, cy + sin(t) * ry * k)
        }
        return CanvasStroke.through(points)
    }

    /** Two passes under a box's bottom edge, the second a touch lower. */
    fun underline(part: WRect, seed: UInt): List<CanvasStroke> {
        val w = CanvasWobble(seed)
        val bottom = part.y + part.h
        return (0 until 2).map { pass ->
            val points = (0..6).map { i ->
                val f = i / 6f
                WPoint(part.x - 6 + (part.w + 18) * f, bottom + 4 + pass * 5 + (w.next() - 0.5f) * 3 + sin(f * PI.toFloat()) * 2)
            }
            CanvasStroke.through(points)
        }
    }

    /** A marker swipe's middle line, a little uphill; drawn as thick as the box. */
    fun swipe(part: WRect): CanvasStroke {
        val h = part.h
        val x = part.x
        val y = part.y
        return CanvasStroke.through(listOf(WPoint(x - 6, y + h * 0.55f + 2), WPoint(x + part.w / 2, y + h * 0.5f), WPoint(x + part.w + 6, y + h * 0.45f - 2)))
    }

    /** The curled pointer from a note to its mark. */
    fun curl(from: WPoint, to: WPoint): CanvasStroke {
        val sx = from.x
        val sy = from.y
        val ex = to.x
        val ey = to.y
        val d = if (ex < sx) 1f else -1f
        return CanvasStroke(
            from,
            listOf(
                listOf(WPoint(sx - d * 28, sy - 12), WPoint(sx - d * 46, sy + 4), WPoint(sx - d * 36, sy + 22)),
                listOf(WPoint(sx - d * 24, sy + 40), WPoint(sx - d * 10, sy + 17), WPoint(sx - d * 32, sy + 15)),
                listOf(WPoint(sx - d * 46, sy + 13), WPoint(ex + d * 40, ey + 10), to),
            ),
        )
    }

    /** An open arrowhead at a stroke's end. */
    fun arrowhead(stroke: CanvasStroke, size: Float): CanvasStroke {
        val last = stroke.curves.lastOrNull() ?: return CanvasStroke.EMPTY
        val end = last[2]
        val from = if (last[1] != end) last[1] else last[0]
        val len = max(0.001f, hypot(end.x - from.x, end.y - from.y))
        val dx = (end.x - from.x) / len
        val dy = (end.y - from.y) / len
        val bx = end.x - dx * size
        val by = end.y - dy * size
        val wing = size * 0.56f
        val one = WPoint(bx - dy * wing, by + dx * wing)
        val two = WPoint(bx + dy * wing, by - dx * wing)
        return CanvasStroke(one, listOf(listOf(one, end, end), listOf(end, two, two)))
    }

    /** One of the agent's marks, before its pointer. An arrow is only its pointer. */
    fun strokes(picture: WRect, mark: PhoneDesignReview.AgentMark, seed: UInt): List<CanvasStroke> {
        val part = picture.part(mark.box)
        return when (mark.kind) {
            "circle" -> listOf(circle(part, seed))
            "underline" -> underline(part, seed)
            "highlight" -> listOf(swipe(part))
            else -> emptyList()
        }
    }

    /** The pointer from a note to its mark, with its head. */
    fun pointer(note: NotePlace): List<CanvasStroke> {
        val mid = note.rect.midY
        val from = if (note.left) WPoint(note.rect.maxX + 12, mid) else WPoint(note.rect.minX - 12, mid)
        val shaft = curl(from, note.target)
        return listOf(shaft, arrowhead(shaft, 16f))
    }
}

/** Where a drawing on the board lands, as the phone's mark. */
object BoardMarks {
    data class Placed(val option: Int, val shot: Int, val kind: String, val box: List<Double>, val path: List<List<Double>>)

    /**
     * The picture under a drawing's middle, its box and stroke as fractions
     * of that picture. Nothing off a picture or on a reference, nor a circle
     * or highlight too short to mean anything. `grow` widens a highlight's
     * box by half the marker, in world units.
     */
    fun place(board: BoardLayout, review: PhoneDesignReview, kind: String, points: List<WPoint>, grow: Float): Placed? {
        val first = points.firstOrNull() ?: return null
        if (kind != "pin" && points.size < 3) return null
        val minX = points.minOf { it.x }
        val maxX = points.maxOf { it.x }
        val minY = points.minOf { it.y }
        val maxY = points.maxOf { it.y }
        val middle = if (kind == "pin") first else WPoint((minX + maxX) / 2, (minY + maxY) / 2)
        val laid = board.shot(middle) ?: return null
        if (review.options.getOrNull(laid.option)?.isReference != false) return null
        val p = laid.picture
        fun frac(q: WPoint) = listOf(((q.x - p.minX) / p.w).toDouble().coerceIn(0.0, 1.0), ((q.y - p.minY) / p.h).toDouble().coerceIn(0.0, 1.0))
        val g = if (kind == "highlight") grow else 0f
        val a = frac(WPoint(minX - g, minY - g))
        val b = frac(WPoint(maxX + g, maxY + g))
        val box = if (kind == "pin") frac(first) + frac(first) else listOf(a[0], a[1], b[0], b[1])
        return Placed(laid.option, laid.shot, kind, box, points.take(200).map(::frac))
    }
}
