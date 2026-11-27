package com.mikerosoft.threadbear.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.mikerosoft.threadbear.android.AppModel
import com.mikerosoft.threadbear.android.LocalModel
import com.mikerosoft.threadbear.kit.BackendApi
import com.mikerosoft.threadbear.kit.CommandKey
import com.mikerosoft.threadbear.kit.DesignReviewDraft
import com.mikerosoft.threadbear.kit.DesignReviewResult
import com.mikerosoft.threadbear.kit.MessageImage
import com.mikerosoft.threadbear.kit.PendingCommand
import com.mikerosoft.threadbear.kit.PhoneBackend
import com.mikerosoft.threadbear.kit.PhoneDesignReview
import com.mikerosoft.threadbear.kit.ReviewUserMark
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch

/**
 * A thread's design reviews, over the thread (the iPhone's DesignReviewsView):
 * the pending list, and the wait for the runner, then a review's board.
 * `reviewId` empty opens the list. `drafts` keeps each review's answer while
 * the thread's open, so closing and opening again loses nothing.
 */
@Composable
fun DesignReviewsDialog(threadId: String, reviewId: String, drafts: MutableMap<String, DesignReviewDraft>, close: () -> Unit) {
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        DesignReviewsScreen(threadId, reviewId, drafts, close)
    }
}

private class Problem(message: String) : Exception(message)

/** The board's state of a review command: one at a time per thread, through the app's watcher. */
private suspend fun AppModel.reviewCommand(threadId: String, send: suspend () -> String): PendingCommand {
    val result = CompletableDeferred<PendingCommand>()
    val started = commands.start(CommandKey.Review(threadId), settleMs = 0, send = send, then = { if (!result.isCompleted) result.complete(it) })
    if (!started) return PendingCommand.Failed(null, "The last one is still on its way. Try again in a moment.")
    return result.await()
}

@Composable
private fun DesignReviewsScreen(threadId: String, reviewId: String, drafts: MutableMap<String, DesignReviewDraft>, close: () -> Unit) {
    val model = LocalModel.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val backend by model.backend.collectAsState()
    var entries by remember { mutableStateOf(emptyList<DesignReviewResult.Entry>()) }
    var review by remember { mutableStateOf<PhoneDesignReview?>(null) }
    var draft by remember { mutableStateOf(DesignReviewDraft()) }
    var pictures by remember { mutableStateOf(emptyList<MessageImage>()) }
    var loading by remember { mutableStateOf(true) }
    var sending by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var truncated by remember { mutableStateOf(false) }
    var imageReload by remember { mutableStateOf(0) }

    fun overNote(d: DesignReviewDraft): String? = d.marksOver.takeIf { it > 0 }?.let { "$OVER_PREFIX, so remove $it of yours to send." }

    suspend fun load(id: String?, preserveDraft: Boolean = false) {
        val b = backend ?: run {
            loading = false
            problem = "Reconnect to Threadbear to read reviews."
            return
        }
        if (model.apiVersion < BackendApi.DESIGN_REVIEWS) {
            loading = false
            problem = "Update Threadbear's backend on the Mac to read reviews here."
            return
        }
        loading = true
        if (!preserveDraft) problem = null
        try {
            val state = model.reviewCommand(threadId) { b.designReviews(threadId, id) }
            state.timedOutNote?.let { throw Problem(it) }
            val done = state as? PendingCommand.Done ?: throw Problem(state.failure("Couldn't load the review. Try again.") ?: "Couldn't load the review. Try again.")
            val result = done.result?.designReviews ?: throw Problem("Couldn't load the review. Try again.")
            val loaded = result.review
            val list = result.reviews
            if (loaded != null) {
                val kept = preserveDraft && review?.id == loaded.id
                review = loaded
                imageReload++
                // The Mac's marks as they are now, whichever draft is kept: the Mac may have added some since.
                draft = DesignReviewDraft.reopening(loaded, if (kept) draft else drafts[loaded.id])
                if (loaded.pending) overNote(draft)?.let { problem = it }
            } else if (list != null) {
                entries = list
                truncated = result.truncated == true
                review = null
            } else {
                throw Problem("Couldn't read the review. Try again.")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            problem = e.message ?: "Couldn't load the review. Try again."
        } finally {
            loading = false
        }
    }

    // Once: going back to the list mustn't reopen the review it started on.
    LaunchedEffect(Unit) { load(reviewId.ifEmpty { null }) }

    // The stills and media as the runner uploads them.
    val current = review
    LaunchedEffect(current?.id, imageReload, backend) {
        val b = backend ?: return@LaunchedEffect
        val r = current ?: return@LaunchedEffect
        pictures = emptyList()
        try {
            b.reviewImages(threadId, r.sources).collect { pictures = it }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            problem = "Couldn't load the review pictures. Your answer is still here. ${e.message ?: ""}".trim()
        }
    }

    // Only addresses the phone may load: the backend's own storage.
    val loadable = pictures.filter { it.src != null && PictureLoader.allowed(it.url) }.associateBy { it.src!! }

    /**
     * Each mark's part of its still, cut out and uploaded, for the runner to
     * show beside the mark's line. A still the phone can't read leaves the
     * mark without one: its box still goes.
     */
    suspend fun uploadCutOuts(marks: List<ReviewUserMark>, r: PhoneDesignReview, b: PhoneBackend, uploaded: MutableList<String>): List<ReviewUserMark> =
        marks.map { m ->
            val bare = m.copy(storageId = null)
            val shot = r.options.firstOrNull { it.id == m.optionId }?.shots?.getOrNull(m.shot) ?: return@map bare
            val url = loadable[shot.src]?.url ?: return@map bare
            val image = try {
                PictureLoader.picture(context, url, REVIEW_STILL_PIXELS).image
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                return@map bare
            }
            // Cropping and encoding off the main thread.
            val jpeg = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { runCatching { reviewCutOut(image, m.box) }.getOrNull() } ?: return@map bare
            val id = b.uploadPhoto(jpeg)
            uploaded += id
            bare.copy(storageId = id)
        }

    fun send(r: PhoneDesignReview) {
        val b = backend ?: return
        if (sending || !draft.canSend(r)) return
        sending = true
        problem = null
        scope.launch {
            try {
                var outgoing = draft
                // A backend before API 106, or a runner that would drop them, gets none (the tools are hidden there too).
                if (model.apiVersion < BackendApi.REVIEW_MARKS || r.canMark != true) outgoing = outgoing.copy(marks = null)
                // Fresh cut-outs every attempt, never kept in the draft: Convex deletes a
                // command's pictures when it fails or lapses, so a kept id would fail
                // every retry. Let go of this attempt's if it never got there.
                val uploaded = mutableListOf<String>()
                val state = try {
                    outgoing.marks?.takeIf { it.isNotEmpty() }?.let { outgoing = outgoing.copy(marks = uploadCutOuts(it, r, b, uploaded)) }
                    model.reviewCommand(threadId) { b.respondReview(threadId, r, outgoing) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    PendingCommand.Failed(null, e.message)
                }
                if (state is PendingCommand.Failed && state.id == null) for (id in uploaded) runCatching { b.discardPhoto(id) }
                state.timedOutNote?.let {
                    // Still on its way: it lands when the Mac is back, so nothing's reloaded over it.
                    problem = it
                    return@launch
                }
                if (state is PendingCommand.Done) {
                    drafts.remove(r.id)
                    close()
                    return@launch
                }
                problem = "${state.failure("The answer wasn't accepted.") ?: "The answer wasn't accepted."} Your answer is kept. Reload before sending again."
                // Never retry a write by itself against a newer revision.
                sending = false
                load(r.id, preserveDraft = true)
            } finally {
                sending = false
            }
        }
    }

    if (current != null) {
        val canMark = model.apiVersion >= BackendApi.REVIEW_MARKS && current.canMark == true
        ReviewBoard(
            review = current,
            draft = draft,
            setDraft = { d ->
                draft = d
                drafts[current.id] = d
                // Gone once enough marks are removed.
                val p = problem
                if (p != null && p.startsWith(OVER_PREFIX) && overNote(d) != p) problem = overNote(d)
            },
            pictures = loadable,
            canMark = canMark,
            sending = sending,
            loading = loading,
            problem = problem,
            close = close,
            allReviews = {
                drafts[current.id] = draft
                scope.launch { load(null) }
            },
            reload = { scope.launch { load(current.id, preserveDraft = true) } },
            send = { send(current) },
        )
    } else {
        ReviewList(entries, loading, problem, truncated, close, open = { id -> scope.launch { load(id) } }, reload = { scope.launch { load(reviewId.ifEmpty { null }, preserveDraft = true) } })
    }
}

private const val OVER_PREFIX = "The Mac added marks"

/** The pending reviews, and the wait for the runner before one opens. */
@Composable
private fun ReviewList(
    entries: List<DesignReviewResult.Entry>,
    loading: Boolean,
    problem: String?,
    truncated: Boolean,
    close: () -> Unit,
    open: (String) -> Unit,
    reload: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxSize().background(colors.background).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = close) { Text("Close") }
            Text("Reviews", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f).padding(end = 64.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (loading) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(10.dp))
                    Text("Waiting for the thread's runner…", color = colors.onSurfaceVariant)
                }
                Text("The runner must be online to read or answer a review.", style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
            }
            if (problem != null) {
                Text(problem, color = colors.error)
                TextButton(onClick = reload, enabled = !loading) { Text("Reload review") }
            }
            if (!loading) {
                if (entries.isEmpty() && problem == null) {
                    Column(Modifier.fillMaxWidth().padding(top = 48.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(Line.CheckCircle, null, Modifier.size(32.dp), tint = colors.onSurfaceVariant)
                        Text("No pending reviews", style = MaterialTheme.typography.titleMedium)
                    }
                }
                for (entry in entries) {
                    Row(
                        Modifier.fillMaxWidth().clickable(onClickLabel = "Open the design options") { open(entry.id) }.padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(entry.title, modifier = Modifier.weight(1f))
                        Icon(Line.ChevronRight, null, Modifier.size(16.dp), tint = colors.onSurfaceVariant)
                    }
                }
                if (truncated) Text("Showing the first 100 reviews. Answer these to see the rest.", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
