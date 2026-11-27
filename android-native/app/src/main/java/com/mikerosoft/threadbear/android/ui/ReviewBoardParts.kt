package com.mikerosoft.threadbear.android.ui

import android.content.Context
import android.graphics.Bitmap
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.view.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import com.mikerosoft.threadbear.android.R
import com.mikerosoft.threadbear.kit.CappedDownload
import com.mikerosoft.threadbear.kit.ReviewCutOut
import com.mikerosoft.threadbear.kit.ReviewMediaType
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** A shot on the board: which option (by index) and which of its shots. */
data class ShotKey(val option: Int, val shot: Int)

/** The board's colours, the Mac canvas's (desktop/gpui/src/review_window/canvas.rs), as the iPhone's BoardInk. */
object BoardInk {
    val yellow = Color(0xFFF3B01C)
    val green = Color(0xFF6FD08C)
    val rose = Color(0xFFF07A9A)
    /** The phone's own marks. */
    val mine = Color(0xFF6CB8FF)
    val mineText = Color(0xFF0B1A2A)
    val board = Color(0xFF111114)
    val dots = Color(0xFF2E2E36)
    val halo = Color(0xFF16161B)
    val haloPicked = Color(0xFF131A16)
    /** A ticked option's rings, letter and tick. */
    val picked = Color(0xFF4CC38A)
    val star = Color(0.86f, 0.70f, 0.33f)
    val leadFill = Color(0xFF2A2620)
    val leadEdge = Color(0xFF4A4030)
    val leadText = Color(0xFFEFE6D6)
    val band = Color(0xFF18181C)
    val pill = Color(0xFF1E1E22)
    val still = Color(0xFF0D0D0F)
    val accent = Color(0xFF0A84FF)

    fun of(ink: String?): Color = when (ink) {
        "green" -> green
        "rose" -> rose
        else -> yellow
    }

    /** Caveat Bold, the Mac's handwriting for the agent's notes (its licence in assets/caveat-OFL.txt). */
    val hand = FontFamily(Font(R.font.caveat_bold, FontWeight.Bold))
}

/**
 * A shot's video or sound, downloaded whole with the pictures' byte cap into
 * a file named for its address, with the extension its first bytes say, as
 * MediaPlayer goes by what the file is.
 */
object ReviewMedia {
    private val files = HashMap<String, File>()
    private var swept = false

    suspend fun file(context: Context, url: String): File = withContext(Dispatchers.IO) {
        synchronized(files) { files[url]?.takeIf { it.exists() } }?.let { return@withContext it }
        if (!PictureLoader.allowed(url)) error("Not a storage address")
        val data = CappedDownload.data(url)
        val ext = ReviewMediaType.extension(data) ?: error("Not a video or sound the phone can play")
        val folder = File(context.cacheDir, "review-media")
        synchronized(files) {
            // Nothing from an earlier run is playing: start the folder afresh once a run.
            if (!swept) {
                swept = true
                folder.deleteRecursively()
            }
            folder.mkdirs()
            // Kept to a dozen; the oldest go first.
            folder.listFiles()?.sortedBy { it.lastModified() }?.dropLast(11)?.forEach { it.delete() }
        }
        val name = MessageDigest.getInstance("SHA-256").digest(url.toByteArray()).joinToString("") { "%02x".format(it) }
        val file = File(folder, "$name.$ext")
        val tmp = File(folder, "$name.$ext.part")
        tmp.writeBytes(data)
        tmp.renameTo(file)
        synchronized(files) { files[url] = file }
        file
    }
}

/**
 * The one video or sound playing on the board: starting another stops it.
 * A video's frames go to the surface the board's TextureView gives it.
 */
class BoardPlayback(private val context: Context, private val scope: CoroutineScope) {
    var current by mutableStateOf<ShotKey?>(null)
        private set
    var playing by mutableStateOf(false)
        private set
    var progress by mutableFloatStateOf(0f)
        private set
    var loading by mutableStateOf<ShotKey?>(null)
        private set
    var failed by mutableStateOf(emptySet<ShotKey>())
        private set
    private var player: MediaPlayer? = null
    private var prepared = false
    private var surface: Surface? = null
    private var ticker: Job? = null
    private var fetch: Job? = null

    fun toggle(key: ShotKey, url: String, video: Boolean) {
        val p = player
        if (current == key && p != null) {
            if (!prepared) return stop()
            if (playing) {
                p.pause()
                playing = false
            } else {
                if (progress >= 0.999f) {
                    p.seekTo(0)
                    progress = 0f
                }
                p.start()
                playing = true
                tick()
            }
            return
        }
        stop()
        loading = key
        failed = failed - key
        fetch = scope.launch {
            val file = try {
                ReviewMedia.file(context, url)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                if (loading == key) {
                    loading = null
                    failed = failed + key
                }
                return@launch
            }
            // Another shot was tapped while this came.
            if (loading != key) return@launch
            loading = null
            val mp = MediaPlayer()
            try {
                mp.setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(if (video) AudioAttributes.CONTENT_TYPE_MOVIE else AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build(),
                )
                mp.setDataSource(file.path)
                if (video) surface?.let { mp.setSurface(it) }
                mp.setOnPreparedListener {
                    if (player !== mp) return@setOnPreparedListener
                    prepared = true
                    if (playing) {
                        mp.start()
                        tick()
                    }
                }
                mp.setOnCompletionListener {
                    if (player !== mp) return@setOnCompletionListener
                    playing = false
                    progress = 1f
                }
                // One MediaPlayer can't play: back to the still, saying so, rather than a frame that never moves.
                mp.setOnErrorListener { _, _, _ ->
                    if (player === mp) {
                        stop()
                        failed = failed + key
                    }
                    true
                }
                player = mp
                current = key
                playing = true
                mp.prepareAsync()
            } catch (e: Exception) {
                mp.release()
                if (player === mp) player = null
                current = null
                playing = false
                failed = failed + key
            }
        }
    }

    /** The board's TextureView came or went. */
    fun attach(s: Surface?) {
        surface?.takeIf { it !== s }?.release()
        surface = s
        runCatching { player?.setSurface(s) }
    }

    private fun tick() {
        ticker?.cancel()
        ticker = scope.launch {
            while (isActive) {
                val p = player ?: break
                if (prepared) {
                    val d = runCatching { p.duration }.getOrDefault(0)
                    if (d > 0) progress = (runCatching { p.currentPosition }.getOrDefault(0).toFloat() / d).coerceIn(0f, 1f)
                }
                if (!playing) break
                delay(33)
            }
        }
    }

    fun stop() {
        fetch?.cancel()
        fetch = null
        ticker?.cancel()
        ticker = null
        player?.let { p ->
            runCatching { p.stop() }
            p.release()
        }
        player = null
        prepared = false
        current = null
        loading = null
        playing = false
        progress = 0f
    }
}

/** A mark's part of its still, padded, no more than 480 wide, as a JPEG for the runner to show beside the mark's line. */
fun reviewCutOut(image: ImageBitmap, box: List<Double>): ByteArray? {
    val bitmap = image.asAndroidBitmap()
    val crop = ReviewCutOut.crop(box, bitmap.width, bitmap.height) ?: return null
    val part = Bitmap.createBitmap(bitmap, crop.x, crop.y, crop.width, crop.height)
    val sized = if (crop.outWidth != crop.width || crop.outHeight != crop.height) Bitmap.createScaledBitmap(part, crop.outWidth, crop.outHeight, true) else part
    val out = ByteArrayOutputStream()
    sized.compress(Bitmap.CompressFormat.JPEG, 80, out)
    return out.toByteArray()
}
