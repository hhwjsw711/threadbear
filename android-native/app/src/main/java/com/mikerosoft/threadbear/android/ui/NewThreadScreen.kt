package com.mikerosoft.threadbear.android.ui

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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mikerosoft.threadbear.android.LocalModel
import com.mikerosoft.threadbear.android.LocalSnackbar
import com.mikerosoft.threadbear.android.NewThreadDraft
import com.mikerosoft.threadbear.android.PhotoDecoding
import com.mikerosoft.threadbear.android.sent
import com.mikerosoft.threadbear.android.startUpload
import com.mikerosoft.threadbear.android.upload
import com.mikerosoft.threadbear.kit.BackendApi
import com.mikerosoft.threadbear.kit.NewThreadChoices
import com.mikerosoft.threadbear.kit.NewThreadSettings
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

/**
 * A new thread from the phone (the iPhone's NewThreadView). It starts in
 * the runner's default folder (Mike didn't want a folder picker on the
 * phone, 31 Oct); the runner, pool, login, model and effort can be picked
 * from the chip bar under the prompt card (Option A). The runner starts on
 * the first one online in Mike's order, so the Mac asleep doesn't leave the
 * phone nowhere to start one (6 Nov).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewThreadScreen(close: () -> Unit) {
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val closeScreen = close
    @Suppress("NAME_SHADOWING") val close = { keyboard?.hide(); closeScreen() }
    val model = LocalModel.current
    val context = LocalContext.current
    val colors = MaterialTheme.colorScheme
    val retry = remember { model.shell.retryDraft.value.also { model.shell.retryDraft.value = null } }
    val startText = remember { model.shell.composeText.value.also { model.shell.composeText.value = null } }
    val box = rememberPhotoBox()
    val dictation = rememberDictation()
    val scope = rememberCoroutineScope()
    val runners by model.runners.collectAsStateWithLifecycle()
    val accounts by model.accounts.collectAsStateWithLifecycle()
    val identity by model.identity.collectAsStateWithLifecycle()
    val api = identity?.apiVersion ?: 0
    val now = rememberNow(5000)
    val photosOn = api >= BackendApi.PHOTOS
    val canChooseRunner = runners.size > 1 && api >= BackendApi.RUNNER_ORDER
    val canChoosePoolAndLogin = api >= BackendApi.MOBILE_PICKER

    var runnerId by rememberSaveable { mutableStateOf(retry?.runnerId) }
    var modelId by rememberSaveable { mutableStateOf(retry?.modelId) }
    var effort by rememberSaveable { mutableStateOf(retry?.effort) }
    var poolId by rememberSaveable { mutableStateOf(retry?.poolId) }
    var accountId by rememberSaveable { mutableStateOf(retry?.accountId) }
    var provider by rememberSaveable { mutableStateOf(retry?.provider) }
    var pickerOpen by remember { mutableStateOf(false) }
    var starting by remember { mutableStateOf<Job?>(null) }
    val focus = remember { FocusRequester() }

    val activeRunnerId = if (canChooseRunner) runnerId else null
    val models = if (api >= BackendApi.MODELS) NewThreadChoices.models(accounts, activeRunnerId) else emptyList()
    val chosenRunner = runners.firstOrNull { it.runnerId == runnerId }
    val offline = if (canChooseRunner && chosenRunner != null) NewThreadChoices.offlineText(chosenRunner, now)
        else NewThreadChoices.offlineText(runners, now)

    val draftSettings = NewThreadSettings(
        model = modelId,
        effort = effort,
        poolId = if (canChoosePoolAndLogin) poolId else null,
        accountId = if (canChoosePoolAndLogin) accountId else null,
        provider = if (canChoosePoolAndLogin) provider else null,
    )
    val pickerContext = model.newThreadPickerContext(draftSettings, activeRunnerId, runners, accounts)

    LaunchedEffect(Unit) {
        if (retry != null) {
            box.restore(retry.text, retry.photos)
            retry.photos.forEach(model::startUpload)
        } else if (startText != null && box.text.text.isEmpty()) {
            box.restore(startText, emptyList())
        }
        withFrameNanos { }
        runCatching { focus.requestFocus() }
    }
    LaunchedEffect(runners, canChooseRunner) {
        if (!canChooseRunner) runnerId = null
        else if (runnerId == null || runners.none { it.runnerId == runnerId }) runnerId = NewThreadChoices.runner(runners, Instant.now())?.runnerId
    }
    val latestAccounts by rememberUpdatedState(accounts)
    val latestApi by rememberUpdatedState(api)
    val latestChoosing by rememberUpdatedState(canChooseRunner)
    fun modelsOn(runner: String?) =
        if (latestApi >= BackendApi.MODELS) NewThreadChoices.models(latestAccounts, if (latestChoosing) runner else null) else emptyList()
    LaunchedEffect(Unit) {
        snapshotFlow { runnerId }.drop(1).collect { runner ->
            val offered = modelsOn(runner)
            if (modelId != null && offered.none { it.id == modelId }) modelId = null
            if (offered.isEmpty()) effort = null
            poolId = null
            accountId = null
            provider = null
        }
    }

    fun applySettings(next: NewThreadSettings) {
        modelId = next.model
        effort = next.effort
        poolId = if (canChoosePoolAndLogin) next.poolId else null
        accountId = if (canChoosePoolAndLogin) next.accountId else null
        provider = if (canChoosePoolAndLogin) next.provider else null
    }

    fun start() {
        val backend = model.backend.value ?: return
        if (starting != null) return
        dictation.stop()
        val message = box.message
        val typed = box.text.text.toString()
        val photos = box.photos.toList()
        starting = scope.launch {
            try {
                val images = model.upload(photos)
                if (canChooseRunner && runnerId == null) runnerId = NewThreadChoices.runner(runners, Instant.now())?.runnerId
                val draft = NewThreadDraft(
                    text = typed,
                    photos = photos,
                    runnerId = if (canChooseRunner) runnerId else null,
                    modelId = modelId,
                    effort = effort,
                    poolId = if (canChoosePoolAndLogin) poolId else null,
                    accountId = if (canChoosePoolAndLogin) accountId else null,
                    provider = if (canChoosePoolAndLogin) provider else null,
                )
                val commandId = backend.create(message, draft.runnerId, null, images, draft.settings)
                sent(photos)
                model.shell.started(commandId, message, draft.runnerId, photos.size, draft)
                close()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                model.report(e)
            } finally {
                starting = null
            }
        }
    }

    val canStart = (box.message.isNotEmpty() || box.photos.isNotEmpty()) && box.photosUp && !dictation.holdsWords
    val busy = starting != null
    val mic = rememberMicStart(dictation) { dictation.start(box.text) }

    Scaffold(
        snackbarHost = { SnackbarHost(LocalSnackbar.current) },
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = { starting?.cancel(); close() }) { Icon(Line.Close, "Cancel", Modifier.size(22.dp)) }
                },
                title = { Text("New thread") },
                actions = {
                    if (busy) {
                        CircularProgressIndicator(Modifier.padding(end = 20.dp).size(20.dp), strokeWidth = 2.dp, color = colors.onSurfaceVariant)
                    } else {
                        TextButton(onClick = ::start, enabled = canStart) { Text("Start", style = MaterialTheme.typography.titleMedium) }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.background),
            )
        },
    ) { inner ->
        Column(
            Modifier.fillMaxSize().padding(inner).imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(colors.surfaceContainer).padding(start = 16.dp, end = 8.dp, top = 14.dp, bottom = 6.dp)) {
                PhotoField(
                    box, "What should it do?", TextFieldLineLimits.MultiLine(4, 12),
                    onPasteImages = if (photosOn) ({ uris -> box.add(uris.map { PhotoDecoding.fromUri(context, it, imagesOnly = true) }, model, scope) }) else null,
                    modifier = Modifier.padding(end = 8.dp),
                    readOnly = busy,
                    fieldModifier = Modifier.focusRequester(focus),
                )
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (photosOn) {
                        PhotoMenu(box) { open -> LabelButton("Add a photo", ComposeLine.Photo, enabled = !busy && box.room > 0, onClick = open) }
                    }
                    Spacer(Modifier.weight(1f))
                    if (dictation.isHearing) ListeningBar(dictation, Modifier.width(200.dp))
                    else LabelButton("Dictate", ComposeLine.Mic, enabled = !busy, onClick = mic)
                }
                dictation.problem?.let { DictationNote(it, Modifier.padding(bottom = 8.dp)) }
                if (photosOn && (box.photos.isNotEmpty() || box.adding > 0)) PhotoStrip(box, Modifier.padding(top = 4.dp, bottom = 10.dp), enabled = !busy)
            }
            if (canChooseRunner || models.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (canChooseRunner) {
                        val options = (if (runnerId == null) listOf<Pair<String?, String>>(null to "Automatic") else emptyList()) +
                            runners.map { r -> r.runnerId to (if (r.isOnline(now)) r.name else "${r.name}, offline") }
                        val chipTitle = runners.firstOrNull { it.runnerId == runnerId }?.name ?: "Automatic"
                        RunnerChip(title = chipTitle, options = options, selected = runnerId) { runnerId = it }
                    }
                    if (models.isNotEmpty()) {
                        ModelChip(
                            context = pickerContext,
                            onClick = {
                                keyboard?.hide()
                                pickerOpen = true
                            },
                        )
                    }
                }
            }
            offline?.let {
                Row(Modifier.padding(start = 4.dp, top = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Line.Moon, null, Modifier.size(16.dp), tint = colors.onSurfaceVariant)
                    Spacer(Modifier.width(8.dp))
                    Text("$it. It'll start when it's back.", style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    if (pickerOpen) {
        ModelPickerSheet(
            context = pickerContext,
            now = now,
            onDismiss = { pickerOpen = false },
            onPickModel = { row, column, pickedProvider ->
                applySettings(pickerContext.draftForPickingModel(draftSettings, row, column, pickedProvider))
            },
            onPickEffort = { level ->
                applySettings(pickerContext.draftForEffort(draftSettings, level))
            },
            onPickLogin = { pickedAccountId, column ->
                applySettings(pickerContext.draftForLogin(draftSettings, pickedAccountId, column))
            },
        )
    }
}

/** A quiet grey button with its icon, as the iPhone's Add a photo and Dictate. */
@Composable
private fun LabelButton(text: String, icon: ImageVector, enabled: Boolean, onClick: () -> Unit) {
    TextButton(onClick = onClick, enabled = enabled) {
        Icon(icon, null, Modifier.size(18.dp), tint = if (enabled) MaterialTheme.colorScheme.onSurfaceVariant else LocalSignals.current.faint)
        Spacer(Modifier.width(6.dp))
        Text(text, color = if (enabled) MaterialTheme.colorScheme.onSurfaceVariant else LocalSignals.current.faint)
    }
}

/** Compact neutral runner chip beside the accent ModelChip in New thread. */
@Composable
private fun RunnerChip(title: String, options: List<Pair<String?, String>>, selected: String?, pick: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    val signals = LocalSignals.current
    Box {
        Row(
            modifier = Modifier
                .clip(CircleShape)
                .background(colors.surfaceContainerHigh)
                .border(1.dp, colors.outlineVariant, CircleShape)
                .clickable { open = true }
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Icon(Line.Laptop, null, Modifier.size(13.dp), tint = colors.onSurfaceVariant)
            Text(
                text = title,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = colors.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Icon(Line.ChevronDown, null, Modifier.size(12.dp), tint = signals.faint)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for ((value, name) in options) {
                DropdownMenuItem(
                    text = { Text(name) },
                    trailingIcon = { if (value == selected) Icon(Line.Check, null, Modifier.size(16.dp), tint = signals.accent) },
                    onClick = { open = false; pick(value) },
                )
            }
        }
    }
}
