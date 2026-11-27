import SwiftUI
import ThreadbearKit

/// Desktop-style model chip for New thread and the existing-thread composer (Option A).
struct ModelChip: View {
    let context: ModelPickerContext
    var pending = false
    var interactive = true
    var action: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if interactive {
                Button(action: action) {
                    chipLabel
                }
                .buttonStyle(.plain)
                .disabled(pending)
                .accessibilityLabel("Model: \(context.chipTitle)")
                .accessibilityHint("Choose pool, provider, model, effort and login")
            } else {
                chipLabel
                    .accessibilityLabel("Model: \(context.chipTitle)")
            }
        }
    }

    private var chipLabel: some View {
        HStack(spacing: 5) {
            ProviderMark(provider: context.provider, size: 15)
                .foregroundStyle(foregroundColor)
            Text(context.chipTitle)
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
                .foregroundStyle(foregroundColor)
            if let badge = context.chipBadge {
                Text("· \(badge.label)")
                    .font(.footnote.weight(.semibold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .foregroundStyle(badge.isStop ? Color.red : Color.orange)
            }
            if pending {
                ProgressView()
                    .controlSize(.small)
                    .tint(foregroundColor)
            } else if interactive {
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(chevronColor)
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 34)
        .background(backgroundColor, in: Capsule())
        .overlay(
            Capsule()
                .strokeBorder(borderColor, lineWidth: 1)
        )
        // Apple's 44pt touch target, without making the capsule itself taller.
        .padding(.vertical, 5)
        .contentShape(Rectangle())
    }

    private var foregroundColor: Color {
        colorScheme == .dark ? .white : .primary
    }

    private var chevronColor: Color {
        colorScheme == .dark ? Color.white.opacity(0.65) : Color.secondary
    }

    private var backgroundColor: Color {
        if let badge = context.chipBadge, badge.isStop {
            return Color.red.opacity(colorScheme == .dark ? 0.16 : 0.10)
        }
        return Color.accentColor.opacity(colorScheme == .dark ? 0.15 : 0.11)
    }

    private var borderColor: Color {
        if let badge = context.chipBadge, badge.isStop {
            return Color.red.opacity(0.45)
        }
        return Color.accentColor.opacity(colorScheme == .dark ? 0.45 : 0.35)
    }
}
