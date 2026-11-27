package com.mikerosoft.threadbear.android.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.verticalScroll
import com.mikerosoft.threadbear.kit.ModelPicker
import com.mikerosoft.threadbear.kit.ModelPickerContext
import com.mikerosoft.threadbear.kit.PickerLoginRow
import com.mikerosoft.threadbear.kit.PickerModelRow
import com.mikerosoft.threadbear.kit.PickerPoolTab
import java.time.Instant

/**
 * Desktop-twin model picker bottom sheet (Option A):
 * pool strip -> provider pills -> cross-provider search -> full-width model list
 * -> inline effort segmented bar -> collapsible Login footer.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelPickerSheet(
    context: ModelPickerContext,
    now: Instant = Instant.now(),
    onDismiss: () -> Unit,
    onPickModel: (row: PickerModelRow, column: String, provider: String) -> Unit,
    onPickEffort: (level: String) -> Unit,
    onPickLogin: (accountId: String?, column: String) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val signals = LocalSignals.current
    val haptic = LocalHapticFeedback.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    var selectedPool by remember { mutableStateOf<String?>(null) }
    var selectedProvider by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    var loginExpanded by remember { mutableStateOf(false) }

    val activeColumn = context.resolvePickerPool(selectedPool)
    val providers = context.pickerProviders(activeColumn)
    val activeProvider = context.resolvePickerProvider(activeColumn, selectedProvider)
    val sections = context.sections(activeColumn, activeProvider, query)
    val isSearching = query.trim().isNotEmpty()

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surfaceContainerLow,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.84f)
                .navigationBarsPadding()
                .imePadding(),
        ) {
            if (context.usesPools && context.poolTabs.isNotEmpty()) {
                PoolStrip(
                    tabs = context.poolTabs,
                    activeColumn = activeColumn,
                    onSelect = { tabId ->
                        selectedPool = tabId
                        val nextProviders = context.pickerProviders(tabId)
                        if (selectedProvider != null && selectedProvider !in nextProviders) {
                            selectedProvider = nextProviders.firstOrNull()
                        }
                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    },
                )
                HorizontalDivider(color = colors.outlineVariant)
            }

            if (providers.isNotEmpty()) {
                ProviderBar(
                    providers = providers,
                    activeProvider = activeProvider,
                    isSearching = isSearching,
                    onSelect = { provider ->
                        selectedProvider = provider
                        if (isSearching) query = ""
                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    },
                )
            }

            SearchBox(
                query = query,
                onQueryChange = { query = it },
            )
            HorizontalDivider(color = colors.outlineVariant)

            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .padding(horizontal = 10.dp),
            ) {
                if (sections.isEmpty()) {
                    item(key = "empty") {
                        Box(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 28.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = if (isSearching) "No matching models" else "No models available",
                                fontSize = 16.sp,
                                color = signals.faint,
                            )
                        }
                    }
                } else {
                    for (section in sections) {
                        section.title?.let { title ->
                            item(key = "hdr:${section.provider}") {
                                SectionHeader(title)
                            }
                        }
                        val mainRows = section.rows.filter { !it.isOlder }
                        val olderRows = section.rows.filter { it.isOlder }
                        items(mainRows, key = { "m:${section.provider}:${it.id}" }) { row ->
                            ModelRow(
                                row = row,
                                provider = section.provider,
                                onClick = {
                                    haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    onPickModel(row, activeColumn, section.provider)
                                    onDismiss()
                                },
                            )
                        }
                        if (olderRows.isNotEmpty()) {
                            item(key = "older:${section.provider}") {
                                SectionHeader("Older")
                            }
                            items(olderRows, key = { "o:${section.provider}:${it.id}" }) { row ->
                                ModelRow(
                                    row = row,
                                    provider = section.provider,
                                    onClick = {
                                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                        onPickModel(row, activeColumn, section.provider)
                                        onDismiss()
                                    },
                                )
                            }
                        }
                    }
                }
                item(key = "bottom-pad") { Spacer(Modifier.height(6.dp)) }
            }

            if (context.effortLevels.isNotEmpty()) {
                HorizontalDivider(color = colors.outlineVariant)
                EffortBar(
                    levels = context.effortLevels,
                    selected = context.effectiveEffort,
                    onPick = { level ->
                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        onPickEffort(level)
                    },
                )
            }

            HorizontalDivider(color = colors.outlineVariant)
            LoginFooter(
                context = context,
                activeColumn = activeColumn,
                activeProvider = activeProvider,
                now = now,
                expanded = loginExpanded,
                onToggle = {
                    loginExpanded = !loginExpanded
                    haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                },
                onPickLogin = { accountId ->
                    haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    onPickLogin(accountId, activeColumn)
                    loginExpanded = false
                },
            )
        }
    }
}

@Composable
private fun PoolStrip(
    tabs: List<PickerPoolTab>,
    activeColumn: String,
    onSelect: (String) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val signals = LocalSignals.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (tab in tabs) {
            if (tab.isUnpooled) {
                Box(
                    modifier = Modifier
                        .padding(horizontal = 2.dp)
                        .width(1.dp)
                        .height(22.dp)
                        .background(colors.outlineVariant),
                )
            }
            val isOn = activeColumn == tab.id
            val meta = when {
                tab.roomWords != null -> "${tab.count} · ${tab.roomWords}"
                tab.count > 0 -> "${tab.count}"
                else -> null
            }
            val metaColor = when (val b = tab.badge) {
                null -> if (isOn) colors.onSurfaceVariant else signals.faint
                else -> if (b.isStop) signals.failed else signals.needsYou
            }
            Row(
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .padding(vertical = 4.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (isOn) colors.surfaceContainerHighest else Color.Transparent)
                    .clickable(role = Role.Tab) { onSelect(tab.id) }
                    .semantics { selected = isOn }
                    .padding(horizontal = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = tab.title,
                    fontSize = 15.sp,
                    fontWeight = if (isOn) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (isOn) colors.onSurface else colors.onSurfaceVariant,
                    maxLines = 1,
                )
                if (meta != null) {
                    Text(
                        text = meta,
                        fontSize = 13.sp,
                        color = metaColor,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun ProviderBar(
    providers: List<String>,
    activeProvider: String?,
    isSearching: Boolean,
    onSelect: (String) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (provider in providers) {
            val isOn = activeProvider == provider && !isSearching
            val fg = if (isOn) colors.onSurface else colors.onSurfaceVariant
            Row(
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .padding(vertical = 4.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (isOn) colors.surfaceContainerHighest else Color.Transparent)
                    .clickable(role = Role.Tab) { onSelect(provider) }
                    .semantics { selected = isOn }
                    .padding(horizontal = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ProviderMark(provider = provider, tint = fg, size = 17.dp)
                Text(
                    text = ModelPicker.providerTitle(provider),
                    fontSize = 15.sp,
                    fontWeight = if (isOn) FontWeight.SemiBold else FontWeight.Normal,
                    color = fg,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun SearchBox(query: String, onQueryChange: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val signals = LocalSignals.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 10.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(colors.surfaceContainerHigh)
            .height(48.dp)
            .padding(start = 14.dp, end = if (query.isEmpty()) 14.dp else 0.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Line.Search, contentDescription = null, modifier = Modifier.size(18.dp), tint = signals.faint)
        Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (query.isEmpty()) {
                Text("Search models", fontSize = 16.sp, color = signals.faint)
            }
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                singleLine = true,
                textStyle = TextStyle(color = colors.onSurface, fontSize = 16.sp),
                cursorBrush = SolidColor(signals.accent),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (query.isNotEmpty()) {
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clickable(role = Role.Button) { onQueryChange("") },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Line.Close,
                    contentDescription = "Clear search",
                    tint = signals.faint,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(
        text = title,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        color = LocalSignals.current.faint,
        modifier = Modifier.padding(start = 10.dp, end = 10.dp, top = 10.dp, bottom = 4.dp),
    )
}

@Composable
private fun ModelRow(row: PickerModelRow, provider: String, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val signals = LocalSignals.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 1.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (row.isSelected) colors.surfaceContainerHigh else Color.Transparent)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { selected = row.isSelected }
            .heightIn(min = 60.dp)
            .padding(horizontal = 10.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(if (row.isSelected) colors.surfaceContainerHighest else colors.surfaceContainerHigh),
            contentAlignment = Alignment.Center,
        ) {
            ProviderMark(
                provider = provider,
                tint = if (row.isSelected) colors.onSurface else colors.onSurfaceVariant,
                size = 18.dp,
            )
        }
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = row.title,
                fontSize = 16.sp,
                fontWeight = if (row.isSelected) FontWeight.SemiBold else FontWeight.Medium,
                color = if (row.isOlder && !row.isSelected) colors.onSurfaceVariant else colors.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            row.subtitle?.takeIf { it.isNotEmpty() }?.let { desc ->
                Text(
                    text = desc,
                    fontSize = 14.sp,
                    color = colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (row.isDefault) {
            Icon(
                imageVector = Line.StarFilled,
                contentDescription = "Default",
                tint = signals.faint,
                modifier = Modifier.size(15.dp),
            )
        }
        if (row.isSelected) {
            Icon(
                imageVector = Line.Check,
                contentDescription = "Selected",
                tint = signals.accent,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Composable
private fun EffortBar(
    levels: List<String>,
    selected: String?,
    onPick: (String) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val signals = LocalSignals.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(colors.surfaceContainerHigh)
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        for (level in levels) {
            val isOn = selected?.lowercase() == level.lowercase()
            Box(
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 42.dp)
                    .clip(RoundedCornerShape(9.dp))
                    .background(if (isOn) colors.surfaceContainerHighest else Color.Transparent)
                    .clickable(role = Role.Tab) { onPick(level) }
                    .semantics { this.selected = isOn }
                    .padding(horizontal = 2.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = effortSegmentLabel(level, levels.size),
                    fontSize = 14.sp,
                    fontWeight = if (isOn) FontWeight.SemiBold else FontWeight.Medium,
                    color = if (isOn) colors.onSurface else signals.faint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

private fun effortSegmentLabel(level: String, count: Int): String {
    val lower = level.lowercase()
    if (lower == "medium") return "Med"
    if (lower == "xhigh" && count >= 6) return "X-High"
    return ModelPicker.effortTitle(level)
}

@Composable
private fun LoginFooter(
    context: ModelPickerContext,
    activeColumn: String,
    activeProvider: String?,
    now: Instant,
    expanded: Boolean,
    onToggle: () -> Unit,
    onPickLogin: (accountId: String?) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val signals = LocalSignals.current
    val (primary, detail) = context.loginLine
    val rows = remember(context, activeColumn, activeProvider, now) {
        context.loginRows(activeColumn, activeProvider, now)
    }

    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClick = onToggle)
                .heightIn(min = 52.dp)
                .padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = primary,
                fontSize = 15.sp,
                color = colors.onSurfaceVariant,
                maxLines = 1,
            )
            detail?.let { d ->
                Text(
                    text = d,
                    fontSize = 15.sp,
                    color = signals.faint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.weight(1f))
            Icon(
                imageVector = if (expanded) Line.ChevronDown else Line.ChevronRight,
                contentDescription = if (expanded) "Collapse logins" else "Expand logins",
                tint = signals.faint,
                modifier = Modifier.size(18.dp),
            )
        }

        AnimatedVisibility(visible = expanded && rows.isNotEmpty()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 280.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(start = 10.dp, end = 10.dp, top = 4.dp, bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                for (row in rows) {
                    val provider = row.accountId?.let { context.account(it)?.provider }
                    LoginRow(row = row, provider = provider, onClick = { onPickLogin(row.accountId) })
                }
            }
        }
    }
}

@Composable
private fun LoginRow(row: PickerLoginRow, provider: String?, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val signals = LocalSignals.current
    val meterColor = when (val b = row.badge) {
        null -> signals.accent
        else -> if (b.isStop) signals.failed else signals.needsYou
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(9.dp))
            .background(if (row.isSelected) colors.surfaceContainerHigh else Color.Transparent)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { selected = row.isSelected }
            .heightIn(min = 56.dp)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(modifier = Modifier.width(24.dp), contentAlignment = Alignment.Center) {
            if (provider != null) {
                ProviderMark(
                    provider = provider,
                    tint = if (row.isSelected) colors.onSurface else colors.onSurfaceVariant,
                    size = 17.dp,
                )
            } else {
                Icon(
                    imageVector = Line.Zap,
                    contentDescription = null,
                    tint = if (row.isSelected) colors.onSurface else colors.onSurfaceVariant,
                    modifier = Modifier.size(17.dp),
                )
            }
        }

        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                text = row.title,
                fontSize = 16.sp,
                fontWeight = if (row.isSelected) FontWeight.SemiBold else FontWeight.Medium,
                color = colors.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            row.subtitle?.let { sub ->
                Text(
                    text = sub,
                    fontSize = 13.sp,
                    color = colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        row.room?.let { pct ->
            val fraction = (pct / 100.0).coerceIn(0.0, 1.0).toFloat()
            Box(
                modifier = Modifier
                    .width(40.dp)
                    .height(5.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(colors.surfaceContainerHighest),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth(fraction)
                        .fillMaxHeight()
                        .background(meterColor),
                )
            }
        }

        row.roomWords?.let { words ->
            Text(
                text = words,
                fontSize = 13.sp,
                fontWeight = if (row.badge != null) FontWeight.SemiBold else FontWeight.Normal,
                color = if (row.badge != null) meterColor else colors.onSurfaceVariant,
                maxLines = 1,
            )
        }

        if (row.isSelected) {
            Icon(
                imageVector = Line.Check,
                contentDescription = "Selected",
                tint = signals.accent,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}
