package com.mikerosoft.threadbear.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikerosoft.threadbear.kit.ModelPicker
import com.mikerosoft.threadbear.kit.ModelPickerContext

/**
 * The accent pill chip above the thread composer and in New Thread (Option A).
 * Shows the active provider mark, `<Pool · >Model< · Effort>`, an optional
 * low-room / limit badge, and a chevron when interactive.
 */
@Composable
fun ModelChip(
    context: ModelPickerContext,
    pending: Boolean = false,
    interactive: Boolean = true,
    onClick: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val signals = LocalSignals.current
    val colors = MaterialTheme.colorScheme
    val fill = if (interactive) signals.accent.copy(alpha = 0.14f) else colors.surfaceContainerHigh
    val stroke = if (interactive) signals.accent.copy(alpha = 0.30f) else colors.outlineVariant
    val fg = if (interactive) signals.accent else colors.onSurfaceVariant

    // Material's 48dp touch target around a 36dp capsule, so it sits with the link chips.
    val chipMod = modifier
        .minimumInteractiveComponentSize()
        .heightIn(min = 36.dp)
        .clip(CircleShape)
        .background(fill)
        .border(1.dp, stroke, CircleShape)
        .let { m ->
            if (interactive) m.clickable(role = Role.Button, onClickLabel = "Change model", onClick = onClick) else m
        }
        .padding(horizontal = 12.dp)

    Row(
        modifier = chipMod,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (pending) {
            CircularProgressIndicator(
                modifier = Modifier.size(15.dp),
                strokeWidth = 1.8.dp,
                color = fg,
            )
        } else {
            ProviderMark(provider = context.provider, tint = fg, size = 16.dp)
        }
        Text(
            text = context.chipTitle,
            color = fg,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        context.chipBadge?.let { badge ->
            UsageChipBadge(badge)
        }
        if (interactive) {
            Icon(
                imageVector = Line.ChevronDown,
                contentDescription = null,
                tint = fg.copy(alpha = 0.72f),
                modifier = Modifier.size(15.dp),
            )
        }
    }
}

@Composable
private fun UsageChipBadge(badge: ModelPicker.ChipBadge) {
    val signals = LocalSignals.current
    val color = if (badge.isStop) signals.failed else signals.needsYou
    val label = if (badge is ModelPicker.ChipBadge.Blocked) "limit" else badge.label
    Text(
        text = label,
        color = color,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        maxLines = 1,
        modifier = Modifier
            .clip(CircleShape)
            .background(color.copy(alpha = 0.18f))
            .padding(horizontal = 6.dp, vertical = 1.dp),
    )
}
