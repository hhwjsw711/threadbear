package com.mikerosoft.threadbear.android.ui

import android.graphics.BlurMaskFilter
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PointMode
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.mikerosoft.threadbear.kit.BoardLayout
import com.mikerosoft.threadbear.kit.BoardMarks
import com.mikerosoft.threadbear.kit.BoardShotLayout
import com.mikerosoft.threadbear.kit.CanvasCamera
import com.mikerosoft.threadbear.kit.CanvasDoodle
import com.mikerosoft.threadbear.kit.CanvasLit
import com.mikerosoft.threadbear.kit.CanvasMeasure
import com.mikerosoft.threadbear.kit.CanvasMetrics
import com.mikerosoft.threadbear.kit.CanvasStop
import com.mikerosoft.threadbear.kit.CanvasStroke
import com.mikerosoft.threadbear.kit.DesignReviewDraft
import com.mikerosoft.threadbear.kit.MessageImage
import com.mikerosoft.threadbear.kit.PhoneDesignReview
import com.mikerosoft.threadbear.kit.ReviewReply
import com.mikerosoft.threadbear.kit.ReviewUserMark
import com.mikerosoft.threadbear.kit.WPoint
import com.mikerosoft.threadbear.kit.WRect
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import androidx.compose.runtime.withFrameMillis

/** The longest side a still is decoded at for the board: sharp at the zoom a phone reads a picture at. */
const val REVIEW_STILL_PIXELS = 1800

enum class BoardTool(val kind: String) { MOVE(""), CIRCLE("circle"), HIGHLIGHT("highlight"), PIN("pin") }

/** World text is measured and drawn one sp to a world unit: the camera does the rest. */
private val WorldDensity = Density(1f, 1f)

/**
 * The board's camera, tour and drawing, held outside composition so the
 * gesture loop and flights read them live (the iPhone's ReviewBoard state).
 * Positions are the screen's pixels; zooms are px per world unit, so the
 * iPhone's points-per-unit limits are times the density.
 */
private class BoardState(val scope: CoroutineScope, val density: Float) {
    var camera by mutableStateOf(CanvasCamera())
    var viewW by mutableFloatStateOf(0f)
    var viewH by mutableFloatStateOf(0f)
    var topInset by mutableFloatStateOf(0f)
    var bottomEdge by mutableFloatStateOf(0f)
    var board by mutableStateOf<BoardLayout?>(null)
    var stops by mutableStateOf(emptyList<CanvasStop>())
    var stop by mutableIntStateOf(0)
    /** Moved by hand: nothing's dimmed, and the camera isn't refitted. */
    var roaming by mutableStateOf(false)
    var tool by mutableStateOf(BoardTool.MOVE)
    var drawing by mutableStateOf<List<WPoint>?>(null)
    var showNotes by mutableStateOf(true)
    var markLimitHit by mutableStateOf(false)
    var reply by mutableStateOf(TextFieldValue())
    var replyFocused by mutableStateOf(false)
    private var placedFor: Pair<Float, Float>? = null
    private var flight: Job? = null

    // What the composition last handed over, for the gesture loop.
    var review: PhoneDesignReview? = null
    var draft = DesignReviewDraft()
    var setDraft: (DesignReviewDraft) -> Unit = {}
    var busy = false
    var canMark = false

    val drawingOn get() = tool != BoardTool.MOVE && canMark && review?.pending == true && !busy
    /** The camera's zoom as points per world unit, as the iPhone's. */
    val sd get() = camera.s / density

    val area: WRect
        get() {
            val top = topInset
            val bottom = if (bottomEdge > top + 40 * density) bottomEdge else viewH
            return WRect(0f, top, viewW, max(1f, bottom - top))
        }

    fun relayout(laid: BoardLayout) {
        if (laid == board) return
        board = laid
        val fresh = laid.stops
        if (stops.isEmpty()) stop = fresh.indexOfFirst { it.lit == CanvasLit.Start }.coerceAtLeast(0)
        stops = fresh
        stop = min(stop, max(0, fresh.size - 1))
        placedFor = null
        place()
    }

    /** The opening stop once the screen's size is known, and again when it changes, unless the board's been moved by hand. */
    fun place() {
        if (viewW <= 0 || bottomEdge <= topInset || stop !in stops.indices) return
        val vp = viewW to viewH
        if (placedFor == vp && roaming) return
        val first = placedFor == null
        placedFor = vp
        if (first || !roaming) {
            flight?.cancel()
            camera = cameraFor(stops[stop])
        }
    }

    fun cameraFor(s: CanvasStop) =
        CanvasCamera.fit(s.rect, area, 12 * density, CanvasMetrics.MIN_ZOOM * density, CanvasMetrics.STOP_ZOOM * density)

    /** Flies there in 650 ms, easing in and out, as the Mac's tour does. */
    fun fly(to: CanvasCamera) {
        flight?.cancel()
        val from = camera
        flight = scope.launch {
            val start = withFrameMillis { it }
            while (true) {
                val k = (withFrameMillis { it } - start) / CanvasMetrics.FLIGHT_MS.toFloat()
                if (k >= 1f) {
                    camera = to
                    break
                }
                camera = from.toward(to, CanvasCamera.ease(k), viewW, viewH)
            }
        }
    }

    /** A hand on the board stops any flight where it is. */
    fun land() {
        flight?.cancel()
        flight = null
    }

    fun go(index: Int) {
        if (index !in stops.indices) return
        stop = index
        roaming = false
        fly(cameraFor(stops[index]))
    }

    fun stopIndex(option: Int, shot: Int): Int? = board?.stopIndex(stops, option, shot)

    /** A tap on a picture: to its stop, and if already there, closer, to the picture alone. */
    fun lookCloser(option: Int, shot: Int) {
        val i = stopIndex(option, shot) ?: return
        val picture = board?.shot(option, shot)?.picture
        if (stop == i && !roaming && picture != null) {
            roaming = true
            fly(CanvasCamera.fit(picture, area, 8 * density, CanvasMetrics.MIN_ZOOM * density, CanvasMetrics.MAX_ZOOM * density))
        } else {
            go(i)
        }
    }

    val lit: CanvasLit?
        get() = if (!roaming && stop in stops.indices && stops[stop].lit.dims) stops[stop].lit else null

    fun pinch(prev: Offset, now: Offset, zoom: Float) {
        roaming = true
        val anchor = camera.toWorld(WPoint(prev.x, prev.y))
        val s = (camera.s * zoom).coerceIn(CanvasMetrics.MIN_ZOOM * density, CanvasMetrics.MAX_ZOOM * density)
        camera = CanvasCamera(s, now.x - anchor.x * s, now.y - anchor.y * s)
    }

    fun pan(d: Offset) {
        roaming = true
        camera = camera.copy(tx = camera.tx + d.x, ty = camera.ty + d.y)
    }

    /** A finished drawing becomes a mark, its "[Mark n]" in the reply. */
    fun finish(points: List<WPoint>, tool: BoardTool) {
        val board = board ?: return
        val review = review ?: return
        if (busy || tool == BoardTool.MOVE) return
        val placed = BoardMarks.place(board, review, tool.kind, points, MARKER / 2 / sd) ?: return
        val option = review.options[placed.option]
        val (added, mark) = draft.addingMark(placed.kind, option.id, placed.shot, placed.box, placed.path) ?: run {
            markLimitHit = true
            return
        }
        setDraft(insert(added, mark.token))
    }

    /** At the reply's cursor while it's being typed in, else on the end. */
    fun insert(d: DesignReviewDraft, token: String): DesignReviewDraft {
        val text = d.reply ?: ""
        val sel = reply.selection.takeIf { replyFocused && reply.text == text }
        val (out, cursor) = ReviewReply.insert(text, token, sel?.min, sel?.max)
        reply = TextFieldValue(out, TextRange(cursor))
        return d.copy(reply = out)
    }

    /** What a tap on the board meant: a tick, an option's name, or a picture. */
    fun tap(at: Offset, titles: Map<Int, TitleHits>) {
        val review = review ?: return
        val board = board ?: return
        val p = camera.toWorld(WPoint(at.x, at.y))
        for ((i, hits) in titles) {
            val tick = hits.tick
            if (tick != null && tick.contains(p) && review.pending && !busy) {
                val id = review.options[i].id
                setDraft(draft.pick(id, id !in draft.picks))
                return
            }
            if (hits.label.contains(p)) {
                stopIndex(i, 0)?.let(::go)
                return
            }
        }
        board.shot(p)?.let { lookCloser(it.option, it.shot) }
    }

    companion object {
        /** The pen on screen, as the Mac's; a highlight is wider (points). */
        const val PEN = 3f
        const val MARKER = 22f
    }
}

/** Where an option's tick and name are, in world units, for taps. */
private class TitleHits(val tick: WRect?, val label: WRect)

/** Measured text, kept for the review: the board redraws every frame of a pinch. */
private class BoardText(private val measurer: TextMeasurer) {
    private val cache = HashMap<Triple<AnnotatedString, TextStyle, Int>, TextLayoutResult>()

    fun layout(text: AnnotatedString, style: TextStyle, width: Int = Int.MAX_VALUE): TextLayoutResult =
        cache.getOrPut(Triple(text, style, width)) {
            measurer.measure(
                text, style,
                constraints = if (width == Int.MAX_VALUE) Constraints() else Constraints(maxWidth = width),
                density = WorldDensity,
            )
        }

    fun layout(text: String, style: TextStyle, width: Int = Int.MAX_VALUE) = layout(AnnotatedString(text), style, width)
}

private val wordsStyle = TextStyle(fontSize = CanvasMetrics.WORDS_SIZE.sp, lineHeight = (CanvasMetrics.WORDS_SIZE * 1.5f).sp)
private val noteStyle = TextStyle(fontSize = CanvasMetrics.NOTE_SIZE.sp, fontFamily = BoardInk.hand, fontWeight = FontWeight.Bold)
private val titleStyle = TextStyle(fontSize = CanvasMetrics.TITLE_SIZE.sp, fontWeight = FontWeight.SemiBold)
private val smallStyle = TextStyle(fontSize = 17.sp)
private val captionStyle = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
private val letterStyle = TextStyle(fontSize = CanvasMetrics.LETTER_SIZE.sp, fontWeight = FontWeight.Black)
private val placeholderStyle = TextStyle(fontSize = 24.sp)
private val badgeStyle = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold)

/**
 * A design review as the Mac's comparison canvas (desktop/gpui/src/
 * review_window/canvas.rs and band.rs are the source of truth; the iPhone's
 * ReviewBoard.swift the port this follows): the agent's lead as a sticky,
 * then the options in one row left to right, staggered, each a column with a
 * soft glow, its big letter, its pictures and the agent's handwritten notes
 * beside them. One finger drags, two zoom; ‹ › flies along the agent's tour.
 * A shot's Play pill plays it where it is; the tools circle, highlight or
 * pin part of a picture, which the reply can point at as "[Mark n]".
 */
@Composable
fun ReviewBoard(
    review: PhoneDesignReview,
    draft: DesignReviewDraft,
    setDraft: (DesignReviewDraft) -> Unit,
    /** The stills' and media's addresses by src, only ones the phone may load. */
    pictures: Map<String, MessageImage>,
    canMark: Boolean,
    sending: Boolean,
    loading: Boolean,
    problem: String?,
    close: () -> Unit,
    allReviews: () -> Unit,
    reload: () -> Unit,
    send: () -> Unit,
) {
    val context = LocalContext.current
    val density = LocalDensity.current.density
    val scope = rememberCoroutineScope()
    val state = remember { BoardState(scope, density) }
    val playback = remember { BoardPlayback(context.applicationContext, scope) }
    val busy = sending || loading
    state.review = review
    state.draft = draft
    state.setDraft = setDraft
    state.busy = busy
    state.canMark = canMark

    // The stills, decoded for the board; a failure says so on the picture.
    val stills = remember { mutableStateMapOf<String, ImageBitmap>() }
    val failedStills = remember { mutableStateMapOf<String, Boolean>() }
    val stillUrls = review.options.flatMap { it.shots }.filter { it.preview != false }.mapNotNull { s -> pictures[s.src]?.let { s.src to it.url } }
    LaunchedEffect(stillUrls) {
        for ((src, url) in stillUrls) {
            if (stills.containsKey(src)) continue
            launch {
                try {
                    stills[src] = PictureLoader.picture(context, url, REVIEW_STILL_PIXELS).image
                    failedStills.remove(src)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    failedStills[src] = true
                }
            }
        }
    }

    val measurer = rememberTextMeasurer(cacheSize = 0)
    val texts = remember(measurer) { BoardText(measurer) }
    val inline = remember { InlineStyle(BoardInk.mine, Color.White.copy(alpha = 0.08f), onLink = null) }
    val measure = remember(texts) {
        CanvasMeasure(
            words = { text, width -> texts.layout(inline.parse(text), wordsStyle, width.toInt()).size.height.toFloat() },
            note = { text ->
                val r = texts.layout(text, noteStyle, CanvasMetrics.NOTE_WIDTH.toInt())
                val w = (0 until r.lineCount).maxOfOrNull { r.getLineRight(it) } ?: 0f
                min(CanvasMetrics.NOTE_WIDTH, kotlin.math.ceil(w)) to r.size.height.toFloat()
            },
        )
    }
    // Laid out again when the review or a picture's size changes.
    val sizes = review.options.flatMap { it.shots }.map { s ->
        val p = pictures[s.src]
        val w = p?.width ?: stills[s.src]?.width
        val h = p?.height ?: stills[s.src]?.height
        if (w != null && h != null && w > 0 && h > 0) w.toFloat() / h else 4f / 3
    }
    LaunchedEffect(review, sizes) {
        var i = 0
        val aspects = HashMap<PhoneDesignReview.Shot, Float>()
        review.options.flatMap { it.shots }.forEach { aspects[it] = sizes[i++] }
        state.relayout(BoardLayout.layout(review, { aspects[it] ?: (4f / 3) }, measure))
    }
    LaunchedEffect(state.viewW, state.viewH, state.topInset, state.bottomEdge, state.stops.size) { state.place() }
    LaunchedEffect(busy) { if (busy) state.drawing = null }
    // No room for another mark: back to moving the board.
    LaunchedEffect(draft.nextMarkNumber == null) { if (draft.nextMarkNumber == null && state.tool != BoardTool.MOVE && state.drawing == null) state.tool = BoardTool.MOVE }
    // The reply as the draft has it, when something other than typing changed it.
    LaunchedEffect(draft.reply) {
        val text = draft.reply ?: ""
        if (state.reply.text != text) {
            val sel = state.reply.selection
            state.reply = TextFieldValue(text, TextRange(min(sel.start, text.length), min(sel.end, text.length)))
        }
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val watch = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_STOP) playback.stop() }
        lifecycle.addObserver(watch)
        onDispose {
            lifecycle.removeObserver(watch)
            playback.stop()
            playback.attach(null)
        }
    }

    Box(Modifier.fillMaxSize().background(BoardInk.board)) {
        val cam = state.camera
        val board = state.board
        val lit = state.lit
        val sd = state.sd

        // The board: dots, then the world under the camera.
        Canvas(
            Modifier
                .fillMaxSize()
                .onSizeChanged { state.viewW = it.width.toFloat(); state.viewH = it.height.toFloat() }
                .semantics { contentDescription = boardDescription(review) }
                .pointerInput(state) { boardGestures(state, titleHits = { titleHitsFor(state, review, texts) }, slop = viewConfiguration.touchSlop) },
        ) {
            dots(cam, density)
            if (board == null) return@Canvas
            withTransform({
                translate(cam.tx, cam.ty)
                scale(cam.s, cam.s, Offset.Zero)
            }) {
                for (laid in board.options) backdrop(review, draft, laid.index, laid.halo, laid.letter, lit, texts)
                val lead = board.lead
                val note = review.note
                if (lead != null && note != null) leadNote(texts.layout(inline.parse(note), wordsStyle.copy(color = BoardInk.leadText), (lead.w - 48).toInt()), lead, if (lit == null || lit == CanvasLit.Lead) 1f else 0.2f, sd)
                for (laid in board.options) {
                    val option = review.options[laid.index]
                    val picked = option.id in draft.picks
                    titleRow(review, option, laid.index, laid.title, picked, sd, texts)
                    for (shot in laid.shots) {
                        val s = option.shots[shot.shot]
                        val on = if (lit?.shows(laid.index, shot.shot) ?: true) 1f else 0.2f
                        val key = ShotKey(laid.index, shot.shot)
                        still(shot, s, stills[s.src], failedStills[s.src] == true, pictures[s.src] != null, picked, on, sd, texts,
                            progress = if (playback.current == key && s.isAudio) playback.progress else null)
                        if (shot.caption.h > 0) {
                            val caption = texts.layout(s.title ?: "${shot.shot + 1} of ${option.shots.size}", captionStyle.copy(color = Color.White.copy(alpha = 0.55f)))
                            drawText(caption, topLeft = Offset(shot.caption.x, shot.caption.y), alpha = on)
                        }
                    }
                    val words = laid.words
                    val optionNote = option.note
                    if (words != null && optionNote != null) {
                        val r = texts.layout(inline.parse(optionNote), wordsStyle.copy(color = Color.White.copy(alpha = 0.88f)), words.w.toInt())
                        drawText(r, topLeft = Offset(words.x, words.y), alpha = if (lit?.showsWords(laid.index) ?: true) 1f else 0.2f)
                    }
                }
            }
        }

        // A video plays over its still, on the screen at the still's place.
        val playingVideo = playback.current?.takeIf { k -> review.options.getOrNull(k.option)?.shots?.getOrNull(k.shot)?.isVideo == true }
        val videoRect = playingVideo?.let { k -> board?.shot(k.option, k.shot)?.picture }?.let { cam.rect(it) }
        if (videoRect != null) {
            with(LocalDensity.current) {
                Box(
                    Modifier
                        .offset { IntOffset(videoRect.x.roundToInt(), videoRect.y.roundToInt()) }
                        .size(videoRect.w.toDp(), videoRect.h.toDp())
                        .clip(RoundedCornerShape((8 * cam.s).toDp())),
                ) {
                    AndroidView(
                        factory = { ctx ->
                            TextureView(ctx).apply {
                                surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                                    override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) = playback.attach(Surface(st))
                                    override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {}
                                    override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                                        playback.attach(null)
                                        return true
                                    }
                                    override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
                                }
                            }
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        }

        // Ink over the pictures (and a playing video): the agent's marks, the
        // phone's own, the one being drawn, then the phone's badges on the screen.
        Canvas(Modifier.fillMaxSize()) {
            if (board == null) return@Canvas
            withTransform({
                translate(cam.tx, cam.ty)
                scale(cam.s, cam.s, Offset.Zero)
            }) {
                if (state.showNotes) agentInk(review, board, lit, sd, texts)
                userInk(review, board, draft, state.drawing, state.tool, sd)
            }
            for (mark in draft.marks.orEmpty()) {
                val (part, points) = placeOf(review, board, mark) ?: continue
                val pin = mark.kind == "pin"
                val spot = cam.toScreen(if (pin) points.firstOrNull() ?: WPoint(part.x, part.y) else WPoint(part.x, part.y))
                badge(mark.n, pin, Offset(spot.x, spot.y), density, texts)
            }
        }

        // The play pills, on the screen at each video or sound's corner.
        if (board != null) for (laidOption in board.options) for (laid in laidOption.shots) {
            PlayPill(review, laid, cam, state, playback, pictures, density)
        }

        Column(Modifier.fillMaxSize()) {
            TopChrome(review, draft, state, canMark, busy, close, allReviews, reload)
            Spacer(Modifier.weight(1f))
            Band(review, draft, setDraft, state, busy, sending, problem, reload, send)
        }
    }
}

// MARK: - Gestures

/**
 * One finger drags the board (or draws, with a tool on), two zoom about
 * their middle and pan with it, and a tap that didn't move ticks an option,
 * goes to it, or looks closer at a picture.
 */
private suspend fun androidx.compose.ui.input.pointer.PointerInputScope.boardGestures(
    state: BoardState,
    titleHits: () -> Map<Int, TitleHits>,
    slop: Float,
) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        state.land()
        val drawTool = if (state.drawingOn) state.tool else null
        var points = if (drawTool != null) listOf(state.camera.toWorld(WPoint(down.position.x, down.position.y))) else emptyList()
        var cancelled = false
        var moved = 0f
        var multi = false
        if (drawTool != null) state.drawing = points
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Main)
            val pressed = event.changes.filter { it.pressed }
            if (pressed.isEmpty()) {
                if (drawTool != null) {
                    if (!cancelled && !state.busy) state.finish(points, drawTool)
                    state.drawing = null
                } else if (!multi && moved < slop) {
                    state.tap(event.changes.first().position, titleHits())
                }
                break
            }
            if (pressed.size >= 2) {
                multi = true
                // Only a mark being drawn is given up: two fingers move the board.
                if (drawTool != null && !cancelled) {
                    cancelled = true
                    state.drawing = null
                }
                val zoom = event.calculateZoom()
                val now = event.calculateCentroid(useCurrent = true)
                val before = event.calculateCentroid(useCurrent = false)
                if (now != Offset.Unspecified && before != Offset.Unspecified) state.pinch(before, now, zoom)
                event.changes.forEach { it.consume() }
                continue
            }
            val change = pressed[0]
            if (drawTool != null && !multi) {
                // Sending started mid-stroke: this one's off.
                if (state.busy) {
                    cancelled = true
                    state.drawing = null
                }
                if (!cancelled && drawTool != BoardTool.PIN) {
                    val p = state.camera.toWorld(WPoint(change.position.x, change.position.y))
                    val last = points.last()
                    if (hypot(p.x - last.x, p.y - last.y) * state.camera.s >= 3 * state.density && points.size < 400) {
                        points = points + p
                        state.drawing = points
                    }
                }
            } else {
                val d = change.positionChange()
                moved += d.getDistance()
                if (moved >= slop || multi) state.pan(d)
            }
            change.consume()
        }
    }
}

private fun titleHitsFor(state: BoardState, review: PhoneDesignReview, texts: BoardText): Map<Int, TitleHits> {
    val board = state.board ?: return emptyMap()
    return board.options.associate { it.index to titleHits(review, it.title, it.index, state.sd, texts) }
}

// MARK: - Drawing the board

/** How much a title row shrinks so it's never under 12 points on screen, unless the column's too small for that. */
private fun titleShrink(sd: Float): Float {
    val size = CanvasMetrics.TITLE_SIZE
    val floor = min(12f, CanvasMetrics.PICTURE_WIDTH * sd / 18)
    return min(size, max(floor, size * sd)) / (size * sd)
}

private const val TICK_BOX = 24f
private val tickScale = CanvasMetrics.TITLE_SIZE / 14 * 0.62f

private fun label(option: PhoneDesignReview.Option): String {
    val t = option.title
    return if (t.startsWith("${option.id}.") || t.startsWith("${option.id} ") || t == option.id) t else "${option.id}. $t"
}

private fun titleHits(review: PhoneDesignReview, title: WRect, index: Int, sd: Float, texts: BoardText): TitleHits {
    val option = review.options[index]
    val k = titleShrink(sd)
    val gap = CanvasMetrics.TITLE_SIZE * 0.45f
    val hasTick = !option.isReference && review.pending
    val labelW = texts.layout(label(option), titleStyle).size.width
    val midY = title.midY
    val tickW = if (hasTick) TICK_BOX + gap else 0f
    // The tick's reach, as the iPhone's 22-point margin round it.
    val tick = if (hasTick) WRect(title.x - 22 * k, midY - (TICK_BOX / 2 + 22) * k, (TICK_BOX + 44) * k, (TICK_BOX + 44) * k) else null
    val label = WRect(title.x + tickW * k, midY - CanvasMetrics.TITLE_ROW / 2 * k, labelW * k, CanvasMetrics.TITLE_ROW * k)
    return TitleHits(tick, label)
}

private fun DrawScope.dots(cam: CanvasCamera, density: Float) {
    var step = 48f
    while (step * cam.s < 18 * density) step *= 2
    while (step * cam.s > 36 * density) step /= 2
    val gap = step * cam.s
    fun rem(a: Float): Float = ((a % gap) + gap) % gap
    val points = ArrayList<Offset>()
    var y = rem(cam.ty)
    while (y < size.height) {
        var x = rem(cam.tx)
        while (x < size.width) {
            points += Offset(x, y)
            x += gap
        }
        y += gap
    }
    drawPoints(points, PointMode.Points, BoardInk.dots, strokeWidth = 2 * density, cap = StrokeCap.Square)
}

/** No box: a soft glow the column's shape, a touch green once ticked, and the option's big letter its first picture mostly hides. */
private fun DrawScope.backdrop(review: PhoneDesignReview, draft: DesignReviewDraft, index: Int, halo: WRect, letter: WRect, lit: CanvasLit?, texts: BoardText) {
    val option = review.options[index]
    val picked = option.id in draft.picks
    val mine = lit?.let { it.option == index } ?: true
    val alpha = if (mine) 1f else 0.55f
    drawIntoCanvas { canvas ->
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = (if (picked) BoardInk.haloPicked else BoardInk.halo).copy(alpha = alpha).toArgb()
            maskFilter = BlurMaskFilter(CanvasMetrics.HALO_PAD * 0.75f, BlurMaskFilter.Blur.NORMAL)
        }
        canvas.nativeCanvas.drawRoundRect(RectF(halo.minX, halo.minY, halo.maxX, halo.maxY), CanvasMetrics.HALO_PAD, CanvasMetrics.HALO_PAD, paint)
    }
    val r = texts.layout(option.id, letterStyle.copy(color = if (picked) BoardInk.picked.copy(alpha = 0.22f) else Color.White.copy(alpha = 0.065f)))
    drawText(r, topLeft = Offset(letter.minX, letter.minY - CanvasMetrics.LETTER_SIZE * 0.1f), alpha = alpha)
}

private fun DrawScope.leadNote(text: TextLayoutResult, rect: WRect, alpha: Float, sd: Float) {
    drawRoundRect(BoardInk.leadFill, Offset(rect.x, rect.y), Size(rect.w, rect.h), CornerRadius(12f), alpha = alpha)
    drawRoundRect(BoardInk.leadEdge, Offset(rect.x, rect.y), Size(rect.w, rect.h), CornerRadius(12f), alpha = alpha, style = Stroke(1 / sd))
    drawText(text, topLeft = Offset(rect.x + 24, rect.y + 24), alpha = alpha)
}

/** The tick (while the review can be answered), "A. Title" and the agent's star; sized with the board but never under 12 points on screen. */
private fun DrawScope.titleRow(review: PhoneDesignReview, option: PhoneDesignReview.Option, index: Int, title: WRect, picked: Boolean, sd: Float, texts: BoardText) {
    val k = titleShrink(sd)
    val gap = CanvasMetrics.TITLE_SIZE * 0.45f
    scale(k, k, Offset(title.x, title.midY)) {
        var x = title.x
        val midY = title.midY
        if (!option.isReference && review.pending) {
            val side = 14 * tickScale
            val tl = Offset(x + (TICK_BOX - side) / 2, midY - side / 2)
            if (picked) {
                drawRoundRect(BoardInk.accent, tl, Size(side, side), CornerRadius(3.5f * tickScale))
                val check = Path().apply {
                    moveTo(tl.x + side * 0.25f, tl.y + side * 0.52f)
                    lineTo(tl.x + side * 0.43f, tl.y + side * 0.7f)
                    lineTo(tl.x + side * 0.76f, tl.y + side * 0.32f)
                }
                drawPath(check, Color.White, style = Stroke(1.8f * tickScale, cap = StrokeCap.Round, join = StrokeJoin.Round))
            } else {
                drawRoundRect(Color.White.copy(alpha = 0.6f), tl, Size(side, side), CornerRadius(3.5f * tickScale), style = Stroke(1.2f * tickScale))
            }
            x += TICK_BOX + gap
        }
        val name = texts.layout(label(option), titleStyle.copy(color = Color.White))
        drawText(name, topLeft = Offset(x, midY - name.size.height / 2f))
        x += name.size.width + gap
        val faint = smallStyle.copy(color = Color.White.copy(alpha = 0.55f))
        if (review.recommended == option.id) {
            val star = texts.layout("★", smallStyle.copy(color = BoardInk.star))
            val rest = texts.layout("Recommended", faint)
            drawText(star, topLeft = Offset(x, midY - star.size.height / 2f))
            drawText(rest, topLeft = Offset(x + star.size.width + 5, midY - rest.size.height / 2f))
        } else if (option.isReference) {
            val r = texts.layout("Reference", faint)
            drawText(r, topLeft = Offset(x, midY - r.size.height / 2f))
        }
    }
}

private fun roundRectPath(r: WRect, radius: Float) = Path().apply {
    addRoundRect(androidx.compose.ui.geometry.RoundRect(r.x, r.y, r.maxX, r.maxY, CornerRadius(radius)))
}

private fun DrawScope.still(
    laid: BoardShotLayout,
    shot: PhoneDesignReview.Shot,
    image: ImageBitmap?,
    failed: Boolean,
    known: Boolean,
    picked: Boolean,
    alpha: Float,
    sd: Float,
    texts: BoardText,
    progress: Float?,
) {
    val p = laid.picture
    if (picked) {
        val ring = 6f
        drawRoundRect(BoardInk.picked, Offset(p.x - ring, p.y - ring), Size(p.w + ring * 2, p.h + ring * 2), CornerRadius(8 + ring), alpha = alpha, style = Stroke(2.5f / sd))
    }
    val clip = roundRectPath(p, 8f)
    clipPath(clip) {
        drawRect(BoardInk.still, Offset(p.x, p.y), Size(p.w, p.h), alpha = alpha)
        if (image != null) {
            drawIntoCanvas { canvas ->
                val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG).apply { this.alpha = (alpha * 255).roundToInt() }
                canvas.nativeCanvas.drawBitmap(image.asAndroidBitmap(), null, RectF(p.x, p.y, p.maxX, p.maxY), paint)
            }
        } else {
            drawRect(Color.White.copy(alpha = 0.04f), Offset(p.x, p.y), Size(p.w, p.h), alpha = alpha)
            val words = when {
                shot.preview == false -> "No preview on the phone. Open it on the Mac."
                failed -> "Couldn't load this picture"
                !known -> "The preview is on its way from the Mac."
                else -> "Loading the picture…"
            }
            val r = texts.layout(words, placeholderStyle.copy(color = Color.White.copy(alpha = 0.6f)), (p.w - 48).toInt().coerceAtLeast(1))
            drawText(r, topLeft = Offset(p.x + 24, p.midY - r.size.height / 2f), alpha = alpha)
        }
        if (progress != null) drawRect(BoardInk.mine, Offset(p.x, p.maxY - 4 / sd), Size(p.w * progress, 4 / sd), alpha = alpha)
    }
    drawPath(clip, Color.White.copy(alpha = 0.12f), alpha = alpha, style = Stroke(1 / sd))
}

private fun strokesPath(list: List<CanvasStroke>): Path = Path().apply {
    for (s in list) {
        moveTo(s.start.x, s.start.y)
        for (c in s.curves) cubicTo(c[0].x, c[0].y, c[1].x, c[1].y, c[2].x, c[2].y)
    }
}

/**
 * The agent's marks as the Mac draws them: a looping circle, a double
 * underline, a marker swipe, and from each note a curled pointer with an open
 * head; the notes in Caveat in the margin beside the picture.
 */
private fun DrawScope.agentInk(review: PhoneDesignReview, board: BoardLayout, lit: CanvasLit?, sd: Float, texts: BoardText) {
    val line = 3.2f * max(sd, 0.5f) / sd
    val pen = Stroke(line, cap = StrokeCap.Round, join = StrokeJoin.Round)
    for (laidOption in board.options) {
        val option = review.options[laidOption.index]
        for (laid in laidOption.shots) {
            val marks = option.shots[laid.shot].marks.orEmpty()
            val alpha = if (lit?.shows(laid.option, laid.shot) ?: true) 1f else 0.2f
            marks.forEachIndexed { m, mark ->
                val ink = BoardInk.of(mark.ink)
                val strokes = CanvasDoodle.strokes(laid.picture, mark, CanvasDoodle.seed(laid.option, laid.shot, m))
                if (strokes.isEmpty()) return@forEachIndexed
                if (mark.kind == "highlight") {
                    drawPath(strokesPath(strokes), ink.copy(alpha = 0.3f), alpha = alpha, style = Stroke(abs(laid.picture.part(mark.box).h) * 1.05f, cap = StrokeCap.Butt, join = StrokeJoin.Round))
                } else {
                    drawPath(strokesPath(strokes), ink, alpha = alpha, style = pen)
                }
            }
            for (place in laid.notes) {
                val mark = marks.getOrNull(place.mark) ?: continue
                val ink = BoardInk.of(mark.ink)
                drawPath(strokesPath(CanvasDoodle.pointer(place)), ink, alpha = alpha, style = pen)
                val r = texts.layout(mark.note ?: "", noteStyle.copy(color = ink), (place.rect.w + 4).toInt())
                drawText(r, topLeft = Offset(place.rect.x, place.rect.y), alpha = alpha)
            }
        }
    }
}

/** Where one of the phone's marks is on the board: its box and stroke. */
private fun placeOf(review: PhoneDesignReview, board: BoardLayout, mark: ReviewUserMark): Pair<WRect, List<WPoint>>? {
    val o = review.options.indexOfFirst { it.id == mark.optionId }.takeIf { it >= 0 } ?: return null
    val laid = board.shot(o, mark.shot) ?: return null
    val p = laid.picture
    val points = mark.path.orEmpty().mapNotNull { if (it.size == 2) p.at(it[0], it[1]) else null }
    return p.part(mark.box).standardized to points
}

/** The phone's own marks, drawn as they were, and the one being drawn. */
private fun DrawScope.userInk(review: PhoneDesignReview, board: BoardLayout, draft: DesignReviewDraft, drawing: List<WPoint>?, tool: BoardTool, sd: Float) {
    for (mark in draft.marks.orEmpty()) {
        if (mark.kind == "pin") continue
        val (part, points) = placeOf(review, board, mark) ?: continue
        val stroke = if (points.size > 1) CanvasStroke.through(points) else null
        when {
            mark.kind == "highlight" -> drawPath(
                strokesPath(listOf(stroke ?: CanvasDoodle.swipe(part))), BoardInk.mine.copy(alpha = 0.38f),
                style = Stroke(max(part.h * 0.85f, 4 / sd), cap = StrokeCap.Round, join = StrokeJoin.Round),
            )
            stroke != null -> drawPath(strokesPath(listOf(stroke)), BoardInk.mine, style = Stroke(BoardState.PEN / sd, cap = StrokeCap.Round, join = StrokeJoin.Round))
            else -> drawOval(BoardInk.mine, Offset(part.x, part.y), Size(part.w, part.h), style = Stroke(BoardState.PEN / sd))
        }
    }
    if (drawing != null && drawing.size > 1) {
        val marker = tool == BoardTool.HIGHLIGHT
        drawPath(
            strokesPath(listOf(CanvasStroke.through(drawing))), if (marker) BoardInk.mine.copy(alpha = 0.38f) else BoardInk.mine,
            style = Stroke((if (marker) BoardState.MARKER else BoardState.PEN) / sd, cap = StrokeCap.Round, join = StrokeJoin.Round),
        )
    }
}

/** A mark's number on the screen: a round badge, or a pin's with its point down at the spot. */
private fun DrawScope.badge(n: Int, pin: Boolean, at: Offset, density: Float, texts: BoardText) {
    val d = 26 * density
    val tl = if (pin) Offset(at.x - d / 2, at.y - d) else Offset(at.x - d / 2, at.y - d / 2)
    val shape = Path().apply {
        if (pin) {
            addRoundRect(androidx.compose.ui.geometry.RoundRect(tl.x, tl.y, tl.x + d, tl.y + d, CornerRadius(d / 2), CornerRadius(d / 2), CornerRadius(d / 2), CornerRadius(3 * density)))
        } else {
            addOval(androidx.compose.ui.geometry.Rect(tl, Size(d, d)))
        }
    }
    translate(0f, density) { drawPath(shape, Color.Black.copy(alpha = 0.35f)) }
    drawPath(shape, BoardInk.mine)
    val r = texts.layout("$n", badgeStyle.copy(color = BoardInk.mineText))
    scale(density, density, Offset(tl.x + d / 2, tl.y + d / 2)) {
        drawText(r, topLeft = Offset(tl.x + d / 2 - r.size.width / 2f, tl.y + d / 2 - r.size.height / 2f))
    }
}

private fun boardDescription(review: PhoneDesignReview): String =
    "${review.title}: " + review.options.joinToString("; ") { o ->
        val marked = o.shots.flatMap { it.marks.orEmpty() }.mapNotNull { it.note }
        "${o.id}, ${o.title}" + (if (marked.isEmpty()) "" else ". Marked: " + marked.joinToString(", "))
    }

// MARK: - On the screen, not zoomed

/** The Mac's pill at a video or sound's top right corner: Play, or Stop while it plays. It plays the shot where it is, at any zoom. */
@Composable
private fun PlayPill(
    review: PhoneDesignReview,
    laid: BoardShotLayout,
    cam: CanvasCamera,
    state: BoardState,
    playback: BoardPlayback,
    pictures: Map<String, MessageImage>,
    density: Float,
) {
    val option = review.options[laid.option]
    val shot = option.shots[laid.shot]
    if (!shot.isVideo && !shot.isAudio) return
    val r = cam.rect(laid.picture)
    if (r.w < 90 * density || r.maxX <= 0 || r.minX >= state.viewW || r.maxY <= 0 || r.minY >= state.viewH) return
    val key = ShotKey(laid.option, laid.shot)
    val url = shot.media?.let { pictures[it]?.url }
    val playing = playback.current == key && playback.playing
    val failed = url == null || key in playback.failed
    val top = state.topInset + 8 * density
    val (right, y) = if (!playing) {
        (r.maxX - 8 * density) to max(r.minY + 8 * density, min(top, r.maxY - 34 * density))
    } else if (r.minY - 34 * density >= top) {
        r.maxX to r.minY - 34 * density
    } else {
        r.maxX to r.maxY + 8 * density
    }
    var width by remember { mutableIntStateOf(0) }
    val label = when {
        failed -> "Play on the Mac"
        playing -> "Stop"
        else -> "Play"
    }
    Row(
        Modifier
            .offset { IntOffset((right - width).roundToInt(), y.roundToInt()) }
            .onSizeChanged { width = it.width }
            .height(26.dp)
            .clip(CircleShape)
            .background(Color.Black.copy(alpha = 0.72f))
            .clickable(enabled = !failed, onClickLabel = if (playing) "Stop ${option.id}" else "Play ${option.id}") {
                if (url != null) playback.toggle(key, url, shot.isVideo)
            }
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (playback.loading == key) {
            CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = Color.White)
        } else {
            val icon = when {
                failed -> Line.Laptop
                playing -> Line.Stop
                shot.isAudio -> Line.Music
                else -> Line.Play
            }
            Icon(icon, null, Modifier.size(13.dp), tint = Color.White)
        }
        Text(label, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** Top: close, the title with its menu, and the Mac's floating tools. */
@Composable
private fun TopChrome(
    review: PhoneDesignReview,
    draft: DesignReviewDraft,
    state: BoardState,
    canMark: Boolean,
    busy: Boolean,
    close: () -> Unit,
    allReviews: () -> Unit,
    reload: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .onGloballyPositioned { state.topInset = it.boundsInRoot().bottom }
            .background(androidx.compose.ui.graphics.Brush.verticalGradient(listOf(BoardInk.board.copy(alpha = 0.94f), BoardInk.board.copy(alpha = 0.94f), Color.Transparent)))
            .statusBarsPadding()
            .padding(bottom = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(34.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.1f)).clickable(onClickLabel = "Close", onClick = close),
                contentAlignment = Alignment.Center,
            ) { Icon(Line.Close, "Close", Modifier.size(16.dp), tint = Color.White) }
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                Row(
                    Modifier.clip(RoundedCornerShape(8.dp)).clickable(onClickLabel = "All reviews, reload") { menu = true }.padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(review.title, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    Icon(Line.ChevronDown, null, Modifier.size(14.dp), tint = Color.White.copy(alpha = 0.6f))
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("All reviews") }, leadingIcon = { Icon(Line.Layers, null, Modifier.size(18.dp)) }, enabled = !busy, onClick = { menu = false; allReviews() })
                    DropdownMenuItem(text = { Text("Reload review") }, leadingIcon = { Icon(Line.Reload, null, Modifier.size(18.dp)) }, enabled = !busy, onClick = { menu = false; reload() })
                }
            }
            Spacer(Modifier.size(34.dp))
        }
        Tools(review, draft, state, canMark, busy)
        val drawingOn = state.tool != BoardTool.MOVE && canMark && review.pending && !busy
        if (drawingOn || state.markLimitHit) {
            Text(
                when {
                    state.markLimitHit && draft.nextMarkNumber == null -> "That's the most marks one answer can have."
                    state.tool == BoardTool.PIN -> "Tap a picture to drop a pin."
                    state.tool == BoardTool.HIGHLIGHT -> "Drag over part of a picture to highlight it."
                    else -> "Drag round part of a picture to circle it."
                },
                color = Color.White.copy(alpha = 0.75f), fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun Tools(review: PhoneDesignReview, draft: DesignReviewDraft, state: BoardState, canMark: Boolean, busy: Boolean) {
    val marking = canMark && review.pending && (state.tool != BoardTool.MOVE || draft.nextMarkNumber != null)
    Row(
        Modifier
            .clip(RoundedCornerShape(11.dp))
            .background(BoardInk.pill.copy(alpha = 0.94f))
            .border(0.5.dp, Color.White.copy(alpha = 0.1f), RoundedCornerShape(11.dp))
            .padding(4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (marking) {
            ToolButton(state, BoardTool.MOVE, Line.Hand, "Move and zoom", busy)
            ToolButton(state, BoardTool.CIRCLE, Line.Circle, "Circle a part", busy)
            ToolButton(state, BoardTool.HIGHLIGHT, Line.Highlighter, "Highlight a part", busy)
            ToolButton(state, BoardTool.PIN, Line.Pin, "Drop a pin", busy)
            Box(Modifier.padding(horizontal = 4.dp).width(1.dp).height(20.dp).background(Color.White.copy(alpha = 0.15f)))
        }
        Row(
            Modifier.height(32.dp).clip(RoundedCornerShape(8.dp)).clickable(onClickLabel = if (state.showNotes) "Hide the agent's notes" else "Show the agent's notes") { state.showNotes = !state.showNotes }.padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Box(
                Modifier.size(28.dp, 16.dp).clip(CircleShape).background(if (state.showNotes) BoardInk.yellow else Color.White.copy(alpha = 0.2f)).padding(2.dp),
                contentAlignment = if (state.showNotes) Alignment.CenterEnd else Alignment.CenterStart,
            ) { Box(Modifier.size(12.dp).clip(CircleShape).background(Color.White)) }
            Text("Notes", color = Color.White, fontSize = 13.sp)
        }
        Box(
            Modifier.height(32.dp).clip(RoundedCornerShape(8.dp)).clickable(onClickLabel = "Fit everything on the screen") { state.go(state.stops.size - 1) }.padding(horizontal = 10.dp),
            contentAlignment = Alignment.Center,
        ) { Text("See all", color = Color.White, fontSize = 13.sp) }
    }
}

@Composable
private fun ToolButton(state: BoardState, tool: BoardTool, icon: androidx.compose.ui.graphics.vector.ImageVector, name: String, busy: Boolean) {
    val on = state.tool == tool
    val enabled = !busy || tool == BoardTool.MOVE
    Box(
        Modifier
            .size(36.dp, 32.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (on) BoardInk.mine.copy(alpha = 0.15f) else Color.Transparent)
            .clickable(enabled = enabled, onClickLabel = name) {
                state.tool = tool
                state.markLimitHit = false
            },
        contentAlignment = Alignment.Center,
    ) { Icon(icon, name, Modifier.size(17.dp), tint = (if (on) BoardInk.mine else Color.White).copy(alpha = if (enabled) 1f else 0.35f)) }
}

/** The bottom band: the tour, the phone's marks, the reply, None of them, Send. */
@Composable
private fun Band(
    review: PhoneDesignReview,
    draft: DesignReviewDraft,
    setDraft: (DesignReviewDraft) -> Unit,
    state: BoardState,
    busy: Boolean,
    sending: Boolean,
    problem: String?,
    reload: () -> Unit,
    send: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .onGloballyPositioned { state.bottomEdge = it.boundsInRoot().top }
            .background(BoardInk.band.copy(alpha = 0.97f))
            .navigationBarsPadding()
            .imePadding()
            .padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (problem != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(problem, color = BoardInk.rose, fontSize = 13.sp, modifier = Modifier.weight(1f))
                Text(
                    "Reload", color = if (busy) Color.White.copy(alpha = 0.35f) else Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable(enabled = !busy, onClick = reload).padding(8.dp),
                )
            }
        }
        val at = state.stop + 1
        val of = max(1, state.stops.size)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TourStep(Line.ChevronLeft, "Back", enabled = state.stop > 0) { state.go(state.stop - 1) }
            Text("$at of $of", color = Color.White.copy(alpha = 0.6f), fontSize = 14.sp)
            TourStep(Line.ChevronRight, "Next", enabled = state.stop < of - 1) { state.go(state.stop + 1) }
        }
        if (review.pending) {
            MarkChips(review, draft, setDraft, state, busy)
            BasicTextField(
                value = state.reply,
                onValueChange = {
                    state.reply = it
                    if ((draft.reply ?: "") != it.text) setDraft(draft.copy(reply = it.text.ifEmpty { null }))
                },
                enabled = !busy,
                textStyle = TextStyle(color = Color.White, fontSize = 15.sp),
                cursorBrush = SolidColor(BoardInk.accent),
                maxLines = 5,
                modifier = Modifier
                    .fillMaxWidth()
                    .onFocusChanged { state.replyFocused = it.isFocused }
                    .clip(RoundedCornerShape(10.dp))
                    .background(Color.Black.copy(alpha = 0.2f))
                    .border(if (state.replyFocused) 1.dp else 0.5.dp, if (state.replyFocused) BoardInk.accent else Color.White.copy(alpha = 0.12f), RoundedCornerShape(10.dp))
                    .padding(horizontal = 10.dp, vertical = 9.dp),
                decorationBox = { field ->
                    Box {
                        if (state.reply.text.isEmpty()) Text("Add a reply", color = Color.White.copy(alpha = 0.35f), fontSize = 15.sp)
                        field()
                    }
                },
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                val none = draft.none == true
                Box(
                    Modifier
                        .height(34.dp)
                        .clip(CircleShape)
                        .background(if (none) BoardInk.accent.copy(alpha = 0.25f) else Color.White.copy(alpha = 0.08f))
                        .clickable(enabled = !busy, onClickLabel = if (none) "Take back none of them" else "None of them will do") { setDraft(draft.pickNone(!none)) }
                        .padding(horizontal = 14.dp),
                    contentAlignment = Alignment.Center,
                ) { Text("None of them", color = if (none) BoardInk.accent else Color.White, fontSize = 14.sp) }
                val can = draft.canSend(review)
                Row(
                    Modifier
                        .weight(1f)
                        .height(34.dp)
                        .clip(CircleShape)
                        .background(if (can && !sending) BoardInk.accent else Color.White.copy(alpha = if (sending) 0.08f else 0.04f))
                        .clickable(enabled = !busy && can, onClick = send),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (sending) {
                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp, color = Color.White)
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        sendLabel(review, draft, sending), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
                        color = if (can && !sending) Color.White else Color.White.copy(alpha = if (sending) 0.85f else 0.35f),
                    )
                }
            }
        } else {
            Text("This review is ${review.status}. Answer it on the Mac if it's still open there.", color = Color.White.copy(alpha = 0.6f), fontSize = 13.sp)
        }
    }
}

/** What Send will send, as the Mac's button says it. */
private fun sendLabel(review: PhoneDesignReview, draft: DesignReviewDraft, sending: Boolean): String {
    if (sending) return "Sending…"
    val picks = review.options.map { it.id }.filter { it in draft.picks }
    if (picks.isNotEmpty()) return "Send " + picks.joinToString(" + ")
    if (draft.none == true) return "Send none of them"
    val said = !draft.reply.isNullOrBlank() || !draft.marks.isNullOrEmpty() || draft.notes.values.any { it.isNotEmpty() }
    return if (said) "Send reply" else "Send"
}

@Composable
private fun TourStep(icon: androidx.compose.ui.graphics.vector.ImageVector, name: String, enabled: Boolean, go: () -> Unit) {
    Box(
        Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(Color.White.copy(alpha = 0.08f))
            .border(0.5.dp, Color.White.copy(alpha = 0.12f), CircleShape)
            .clickable(enabled = enabled, onClickLabel = name, onClick = go),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, name, Modifier.size(16.dp), tint = Color.White.copy(alpha = if (enabled) 1f else 0.25f)) }
}

/** The Mac's mark chips: the number in the phone's blue, what it's on, and an x to take it off. */
@Composable
private fun MarkChips(review: PhoneDesignReview, draft: DesignReviewDraft, setDraft: (DesignReviewDraft) -> Unit, state: BoardState, busy: Boolean) {
    val marks = draft.marks.orEmpty().sortedBy { it.n }
    if (marks.isEmpty()) return
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (mark in marks) {
            Row(
                Modifier
                    .heightIn(min = 26.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(BoardInk.mine.copy(alpha = 0.14f))
                    .border(0.5.dp, BoardInk.mine.copy(alpha = 0.5f), RoundedCornerShape(6.dp)),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    Modifier
                        .clickable(onClickLabel = "Show the marked shot") {
                            review.options.indexOfFirst { it.id == mark.optionId }.takeIf { it >= 0 }?.let { state.lookCloser(it, mark.shot) }
                        }
                        .padding(start = 3.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Box(Modifier.size(16.dp).clip(CircleShape).background(BoardInk.mine), contentAlignment = Alignment.Center) {
                        Text("${mark.n}", color = BoardInk.mineText, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                    }
                    Text("on ${mark.optionId}", color = Color.White.copy(alpha = 0.7f), fontSize = 13.sp)
                }
                Box(
                    Modifier.size(24.dp, 26.dp).clickable(enabled = !busy, onClickLabel = "Remove mark ${mark.n}") {
                        setDraft(draft.removingMark(mark.n))
                    },
                    contentAlignment = Alignment.Center,
                ) { Icon(Line.Close, "Remove mark ${mark.n}", Modifier.size(11.dp), tint = Color.White.copy(alpha = 0.6f)) }
            }
        }
    }
}
