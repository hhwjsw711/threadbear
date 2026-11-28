package com.mikerosoft.threadbear.android.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.mikerosoft.threadbear.kit.ApprovalOption
import com.mikerosoft.threadbear.kit.LooseEnds
import com.mikerosoft.threadbear.kit.PendingApproval
import com.mikerosoft.threadbear.kit.PhoneAsk
import com.mikerosoft.threadbear.kit.PhoneLooseEnd
import com.mikerosoft.threadbear.kit.Question
import com.mikerosoft.threadbear.kit.RunnerKeyPins

/** A card under the transcript: quiet, with a thin edge in what it means. */
@Composable
fun CardFrame(edge: Color? = null, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(18.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(MaterialTheme.colorScheme.surfaceContainer)
            .then(if (edge != null) Modifier.border(1.dp, edge.copy(alpha = 0.35f), shape) else Modifier)
            .animateContentSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) { content() }
}

/**
 * A pill to tap. `filled` for the one picked or the main action, `spinning`
 * once tapped until the answer lands; a spinning or disabled pill takes no taps.
 */
@Composable
fun Pill(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    filled: Boolean = false,
    tint: Color? = null,
    spinning: Boolean = false,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    star: Boolean = false,
    note: String? = null,
) {
    val colors = MaterialTheme.colorScheme
    val accent = tint ?: LocalSignals.current.accent
    val shape = RoundedCornerShape(if (note != null) 14.dp else 20.dp)
    val bg = if (filled) accent else Color.Transparent
    val fg = if (filled) Color.White else (tint ?: colors.onSurface)
    val haptics = LocalHapticFeedback.current
    Box(
        modifier.clip(shape).background(bg)
            .then(if (filled) Modifier else Modifier.border(1.dp, colors.outline, shape))
            .clickable(enabled = enabled && !spinning) { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() }
            .heightIn(min = 40.dp).padding(horizontal = 16.dp, vertical = 9.dp),
        contentAlignment = if (note != null) Alignment.CenterStart else Alignment.Center,
    ) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (spinning) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 1.5.dp, color = fg)
                    Spacer(Modifier.width(8.dp))
                } else if (icon != null) {
                    Icon(icon, null, Modifier.size(16.dp), tint = fg)
                    Spacer(Modifier.width(6.dp))
                }
                if (star && !filled) {
                    Icon(Line.StarFilled, "Recommended", Modifier.size(11.dp), tint = Color(0xFFDBB354))
                    Spacer(Modifier.width(5.dp))
                }
                Text(text, style = MaterialTheme.typography.labelLarge, color = fg.copy(alpha = if (enabled) 1f else 0.4f),
                    fontWeight = if (note != null) FontWeight.SemiBold else FontWeight.Medium)
            }
            if (note != null) Text(note, style = MaterialTheme.typography.bodySmall, color = if (filled) Color.White.copy(alpha = 0.85f) else colors.onSurfaceVariant)
        }
    }
}

/** A link in a card: accent text with an arrow, no outline. */
@Composable
private fun TextLink(title: String, onClick: () -> Unit) {
    val accent = LocalSignals.current.accent
    Row(Modifier.clip(RoundedCornerShape(6.dp)).clickable(onClick = onClick).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Icon(Line.ArrowUpRight, null, Modifier.size(15.dp), tint = accent)
        Spacer(Modifier.width(5.dp))
        Text(title, style = MaterialTheme.typography.bodyMedium, color = accent)
    }
}

/**
 * One answer in an ask's grouped list: the answer, what it does under it,
 * and a chevron (a spinner once it's on its way). Picked, it fills accent.
 */
@Composable
private fun AnswerRow(label: String, note: String, onClick: () -> Unit, picked: Boolean, star: Boolean, spinning: Boolean, faded: Boolean, enabled: Boolean) {
    val colors = MaterialTheme.colorScheme
    val accent = LocalSignals.current.accent
    val fg = if (picked) Color.White else colors.onSurface
    val haptics = LocalHapticFeedback.current
    Row(
        Modifier.fillMaxWidth().background(if (picked) accent else Color.Transparent)
            .clickable(enabled = enabled) { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() }
            .alpha(if (faded) 0.4f else 1f)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label, style = MaterialTheme.typography.labelLarge, color = fg, fontWeight = FontWeight.SemiBold)
                // The agent's pick: a small gold star and "Recommended", as on the iPhone and Mac.
                if (star && !picked) {
                    Spacer(Modifier.width(6.dp))
                    Icon(Line.StarFilled, null, Modifier.size(11.dp), tint = Color(0xFFDBB354))
                    Spacer(Modifier.width(4.dp))
                    Text("Recommended", style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
                }
            }
            if (note.isNotEmpty()) Text(note, style = MaterialTheme.typography.bodySmall, color = if (picked) Color.White.copy(alpha = 0.85f) else colors.onSurfaceVariant)
        }
        Spacer(Modifier.width(10.dp))
        Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) {
            when {
                spinning -> CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 1.5.dp, color = Color.White)
                picked -> Icon(Line.Check, "Picked", Modifier.size(16.dp), tint = Color.White)
                else -> Icon(Line.ChevronRight, null, Modifier.size(16.dp), tint = colors.onSurfaceVariant.copy(alpha = 0.6f))
            }
        }
    }
}

/** A tool waiting for permission: what it wants to do, whole, and the buttons the runner offers. */
@Composable
fun ApprovalCard(card: PendingApproval.Approval, tapped: String?, respond: (ApprovalOption) -> Unit) {
    val signals = LocalSignals.current
    CardFrame(signals.needsYou) {
        Text(card.title, style = MaterialTheme.typography.titleMedium)
        // What made it ask (backend API 113), as the Mac's card says it under the title.
        card.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        val summary = card.inputSummary
        if (!summary.isNullOrBlank()) {
            // Never cut short: Allow allows all of it.
            Text(
                summary, style = MaterialTheme.typography.bodySmall.copy(fontFamily = Mono),
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceContainerHighest).padding(10.dp),
            )
        } else if (card.name.isNotEmpty()) {
            Text(card.name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (option in card.options) {
                val label = when (option) { ApprovalOption.ALLOW -> "Allow"; ApprovalOption.ALLOW_ALWAYS -> "Always"; ApprovalOption.DENY -> "Deny" }
                Pill(
                    label, { respond(option) }, Modifier.weight(1f),
                    filled = option == ApprovalOption.ALLOW,
                    tint = if (option == ApprovalOption.DENY) signals.failed else null,
                    spinning = tapped == option.wire,
                    enabled = tapped == null,
                )
            }
        }
    }
}

/** The agent's questions: pick per question, or write something else, then Send. */
@Composable
fun QuestionCard(card: PendingApproval.Questions, tapped: String?, send: (Map<Int, Set<String>>, String) -> Unit) {
    val chosen = remember(card.id) { mutableStateMapOf<Int, Set<String>>() }
    var typed by remember(card.id) { mutableStateOf("") }
    val colors = MaterialTheme.colorScheme
    val accent = LocalSignals.current.accent
    CardFrame(LocalSignals.current.needsYou) {
        card.questions.forEachIndexed { index, q ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(q.question, style = MaterialTheme.typography.titleMedium)
                for (option in q.options) {
                    val on = chosen[index]?.contains(option.label) == true
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                            .clickable(enabled = tapped == null) { chosen[index] = toggle(q, chosen[index] ?: emptySet(), option.label) }
                            .padding(vertical = 6.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Box(
                            Modifier.padding(top = 2.dp).size(18.dp).clip(if (q.multiSelect) RoundedCornerShape(5.dp) else CircleShape)
                                .then(if (on) Modifier.background(accent) else Modifier.border(1.5.dp, colors.outline, if (q.multiSelect) RoundedCornerShape(5.dp) else CircleShape)),
                            contentAlignment = Alignment.Center,
                        ) { if (on) Icon(Line.Check, null, Modifier.size(12.dp), tint = Color.White) }
                        Spacer(Modifier.width(12.dp))
                        Column {
                            Text(option.label, style = MaterialTheme.typography.bodyLarge)
                            option.description?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant) }
                        }
                    }
                }
            }
        }
        Field(typed, { typed = it }, "Something else", enabled = tapped == null)
        val ready = chosen.values.any { it.isNotEmpty() } || typed.isNotBlank()
        Pill("Send answer", { send(chosen.toMap(), typed) }, Modifier.fillMaxWidth(), filled = ready, spinning = tapped != null, enabled = ready)
    }
}

private fun toggle(q: Question, set: Set<String>, label: String): Set<String> = when {
    q.multiSelect -> if (label in set) set - label else set + label
    label in set -> emptySet()
    else -> setOf(label)
}

/**
 * A secret the agent asked for: sealed on this phone to the Mac's key from
 * the pairing code, so the mirror only ever carries ciphertext. A key the
 * phone wasn't paired with is refused, and it's answered on the Mac.
 */
@Composable
fun SecretCard(card: PendingApproval.Secret, verdict: RunnerKeyPins.Verdict, tapped: String?, send: (String?) -> Unit) {
    var value by remember(card.id) { mutableStateOf("") }
    val colors = MaterialTheme.colorScheme
    CardFrame(LocalSignals.current.needsYou) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Line.Key, null, Modifier.size(18.dp), tint = colors.onSurfaceVariant)
            Spacer(Modifier.width(8.dp))
            Text(card.label, style = MaterialTheme.typography.titleMedium)
        }
        if (card.reason.isNotBlank()) Text(card.reason, style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
        if (verdict != RunnerKeyPins.Verdict.TRUSTED) {
            Text(
                if (verdict == RunnerKeyPins.Verdict.CHANGED) "This Mac's key has changed since pairing. Answer it on the Mac, or pair again from its code."
                else "This phone has no key for this Mac yet. Answer it on the Mac, or pair from its code.",
                style = MaterialTheme.typography.bodySmall, color = LocalSignals.current.needsYou,
            )
            Pill("Decline", { send(null) }, spinning = tapped == "decline", enabled = tapped == null)
            return@CardFrame
        }
        Field(value, { value = it }, card.placeholder ?: "Secret", secret = true, enabled = tapped == null)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Pill("Decline", { send(null) }, Modifier.weight(1f), spinning = tapped == "decline", enabled = tapped == null)
            Pill("Send", { send(value); value = "" }, Modifier.weight(1f), filled = value.isNotEmpty(), spinning = tapped == "secret",
                enabled = tapped == null && value.isNotEmpty(), icon = Line.Lock)
        }
    }
}

/**
 * The card of asks from the agent's end_turn: each ask, its answers and links,
 * then an Add details box whose words go with the picks, after them, as the
 * Mac's message box does (Decisions.message).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AsksCard(
    asks: List<PhoneAsk>,
    picks: Map<Int, Int>,
    busy: Boolean,
    pick: (Int, Int?) -> Unit,
    send: () -> Unit,
    note: String = "",
    onNote: (String) -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    // Through the thread's links, so another app's link asks first (LinkGate), as on the iPhone.
    val open = LocalThreadLink.current
    CardFrame(LocalSignals.current.needsYou) {
        asks.forEachIndexed { index, ask ->
            val ticked = ask.ticked == true
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row {
                    if (ticked) {
                        Icon(Line.Check, "Done", Modifier.size(16.dp).padding(top = 3.dp), tint = colors.onSurfaceVariant)
                        Spacer(Modifier.width(6.dp))
                    } else if (asks.size > 1) {
                        Text("${index + 1}.", style = MaterialTheme.typography.bodyLarge, color = colors.onSurfaceVariant)
                        Spacer(Modifier.width(6.dp))
                    }
                    MarkdownText(ask.paragraph, style = MaterialTheme.typography.bodyLarge.copy(color = if (ticked) colors.onSurfaceVariant else colors.onSurface))
                }
                if (!ticked) {
                    val links = ask.links.orEmpty()
                    val choose = { choice: Int ->
                        if (asks.size == 1) { pick(index, choice); send() } else pick(index, if (picks[index] == choice) null else choice)
                    }
                    if (ask.hasNotes) {
                        // Plain accent links, so they don't read as one of the answers.
                        if (links.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            links.forEach { l -> TextLink(l.title) { open(l.url, null) } }
                        }
                        // One grouped block with hairlines between, as the iPhone
                        // draws it: outlined pills on two-line answers looked
                        // heavy (Mike picked this from three mockups, 16 Nov).
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surfaceContainerHigh)) {
                            ask.choices.forEachIndexed { choice, label ->
                                if (choice > 0) Box(Modifier.padding(start = 14.dp).fillMaxWidth().height(0.5.dp).background(colors.outlineVariant))
                                val picked = picks[index] == choice
                                AnswerRow(label, ask.note(choice) ?: "", { choose(choice) }, picked = picked,
                                    star = ask.suggestedIndex == choice, spinning = picked && busy && asks.size == 1,
                                    faded = busy && !picked, enabled = !busy)
                            }
                        }
                    } else if (links.isNotEmpty() || ask.choices.isNotEmpty()) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            links.forEach { l -> Pill(l.title, { open(l.url, null) }, icon = Line.External) }
                            ask.choices.forEachIndexed { choice, label ->
                                val picked = picks[index] == choice
                                Pill(label, { choose(choice) }, filled = picked, star = ask.suggestedIndex == choice,
                                    spinning = picked && busy && asks.size == 1, enabled = !busy || picked)
                            }
                        }
                    }
                }
            }
        }
        // Under the answers, so a tap on one (a single ask's tap sends) takes it along.
        if (asks.any { it.ticked != true && it.choices.isNotEmpty() }) {
            Field(note, onNote, if (asks.size == 1) "Add details, then pick an answer" else "Add details", enabled = !busy)
        }
        if (asks.size > 1 && picks.isNotEmpty()) {
            Pill("Send", send, Modifier.fillMaxWidth(), filled = true, spinning = busy)
        }
    }
}

/**
 * A finished turn that needs nothing: archive it, or tick follow-ups to
 * carry on. What the runner found still open (loose ends) goes between,
 * under "Still open", or "Coming back" when it's only booked check-ins, as
 * on the Mac and the iPhone: plain lines, and a thread one opens that thread.
 */
@Composable
fun DoneCard(
    next: List<String>, ticked: Set<Int>, busy: Boolean, tick: (Int) -> Unit, send: () -> Unit, archive: () -> Unit,
    nextPick: String? = null, nextSuggested: Int? = null,
    looseEnds: List<PhoneLooseEnd> = emptyList(), openThread: (String) -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    val accent = LocalSignals.current.accent
    val pickOne = nextPick == "one" && next.size > 1
    CardFrame {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Line.CheckCircle, null, Modifier.size(18.dp), tint = colors.onSurfaceVariant)
            Spacer(Modifier.width(8.dp))
            Text("Done", style = MaterialTheme.typography.titleSmall, color = colors.onSurfaceVariant)
            Spacer(Modifier.weight(1f))
            Pill("Archive", archive, icon = Line.Archive)
        }
        LooseEnds.heading(looseEnds)?.let { heading ->
            val signals = LocalSignals.current
            Text(heading, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
            for (end in LooseEnds.ordered(looseEnds)) {
                val thread = end.threadId?.takeIf { it.isNotEmpty() }
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                        .then(if (thread != null) Modifier.clickable(onClickLabel = "Open the thread") { openThread(thread) } else Modifier)
                        .padding(vertical = 4.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Icon(
                        if (end.isBooked) Line.Clock else Line.AlertCircle, if (end.isBooked) "Booked" else "Still open",
                        Modifier.padding(top = 2.dp).size(18.dp), tint = if (end.isBooked) colors.onSurfaceVariant else signals.needsYou,
                    )
                    Spacer(Modifier.width(12.dp))
                    Text(LooseEnds.line(end), style = MaterialTheme.typography.bodyLarge, color = if (thread != null) signals.accent else colors.onSurface)
                }
            }
        }
        if (next.isNotEmpty()) {
            Text(if (pickOne) "Or pick one" else "Or carry on", style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
            next.forEachIndexed { i, step ->
                val on = i in ticked
                val suggested = pickOne && nextSuggested == i
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                        .semantics { selected = on }
                        .clickable(enabled = !busy, role = if (pickOne) Role.RadioButton else Role.Checkbox) { tick(i) }
                        .padding(vertical = 6.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    if (pickOne) {
                        Box(
                            Modifier.padding(top = 2.dp).size(18.dp).clip(CircleShape)
                                .border(1.5.dp, if (on) accent else colors.outline, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (on) Box(Modifier.size(8.dp).clip(CircleShape).background(accent))
                        }
                    } else {
                        Box(
                            Modifier.padding(top = 2.dp).size(18.dp).clip(CircleShape)
                                .then(if (on) Modifier.background(accent) else Modifier.border(1.5.dp, colors.outline, CircleShape)),
                            contentAlignment = Alignment.Center,
                        ) { if (on) Icon(Line.Check, null, Modifier.size(12.dp), tint = Color.White) }
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(step, style = MaterialTheme.typography.bodyLarge)
                        if (suggested) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Line.StarFilled, null, Modifier.size(11.dp), tint = Color(0xFFDBB354))
                                Spacer(Modifier.width(4.dp))
                                Text("Recommended", style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            if (ticked.isNotEmpty()) Pill("Send", send, Modifier.fillMaxWidth(), filled = true, spinning = busy)
        }
    }
}

@Composable
private fun Field(value: String, onValue: (String) -> Unit, placeholder: String, secret: Boolean = false, enabled: Boolean = true) {
    val colors = MaterialTheme.colorScheme
    Box(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surfaceContainerHighest)
            .heightIn(min = 44.dp).padding(horizontal = 14.dp, vertical = 11.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (value.isEmpty()) Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = colors.onSurfaceVariant)
        BasicTextField(
            value, onValue, enabled = enabled,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.onSurface),
            cursorBrush = SolidColor(LocalSignals.current.accent),
            singleLine = secret,
            visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            keyboardOptions = if (secret) KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false) else KeyboardOptions.Default,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
