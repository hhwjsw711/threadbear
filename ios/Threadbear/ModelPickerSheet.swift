import SwiftUI
import ThreadbearKit

/// Desktop-twin model picker bottom sheet (Option A):
/// pool strip -> provider pills -> cross-provider search -> full-width model list
/// -> inline effort bar -> collapsible Login footer.
struct ModelPickerSheet: View {
    let context: ModelPickerContext
    var now: Date = .now
    var initiallyExpandedLogin = false
    var onPickModel: (_ row: PickerModelRow, _ column: String, _ provider: String) -> Void
    var onPickEffort: (_ level: String) -> Void
    var onPickLogin: (_ accountId: String?, _ column: String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var selectedPool: String?
    @State private var selectedProvider: String?
    @State private var query = ""
    @State private var loginExpanded = false

    private var activeColumn: String {
        context.resolvePickerPool(picked: selectedPool)
    }

    private var providers: [String] {
        context.pickerProviders(for: activeColumn)
    }

    private var activeProvider: String? {
        context.resolvePickerProvider(for: activeColumn, picked: selectedProvider)
    }

    private var sections: [PickerModelSection] {
        context.sections(for: activeColumn, provider: activeProvider, query: query)
    }

    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            if context.usesPools, !context.poolTabs.isEmpty {
                poolStrip
                hairline
            }
            if !providers.isEmpty {
                providerBar
            }
            searchBox
            hairline
            modelList
            if !context.effortLevels.isEmpty {
                hairline
                effortBar
            }
            hairline
            loginFooter
        }
        .background(sheetBackground.ignoresSafeArea())
        .presentationDetents([.fraction(0.84), .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(sheetBackground)
        .onAppear {
            if initiallyExpandedLogin { loginExpanded = true }
        }
    }

    // MARK: - Pool Strip

    private var poolStrip: some View {
        let tabs = context.poolTabs
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 5) {
                ForEach(tabs) { tab in
                    if tab.isUnpooled {
                        Rectangle()
                            .fill(Color.primary.opacity(0.12))
                            .frame(width: 1, height: 16)
                            .padding(.horizontal, 2)
                    }
                    let isOn = activeColumn == tab.id
                    Button {
                        selectedPool = tab.id
                        let nextProviders = context.pickerProviders(for: tab.id)
                        if let current = selectedProvider, !nextProviders.contains(current) {
                            selectedProvider = nextProviders.first
                        }
                        UISelectionFeedbackGenerator().selectionChanged()
                    } label: {
                        HStack(spacing: 5) {
                            Text(tab.title)
                                .font(.system(size: 12.5, weight: isOn ? .semibold : .regular))
                                .foregroundStyle(isOn ? primaryText : mutedText)
                            if let meta = poolMeta(tab) {
                                Text(meta)
                                    .font(.system(size: 11.5, weight: .regular))
                                    .monospacedDigit()
                                    .foregroundStyle(poolMetaColor(tab, isOn: isOn))
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(pillBackground(isOn: isOn), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(isOn ? .isSelected : [])
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 18)
            .padding(.bottom, 9)
        }
    }

    private func poolMeta(_ tab: PickerPoolTab) -> String? {
        if let room = tab.roomWords {
            return "\(tab.count) · \(room)"
        }
        return tab.count > 0 ? "\(tab.count)" : nil
    }

    private func poolMetaColor(_ tab: PickerPoolTab, isOn: Bool) -> Color {
        if let badge = tab.badge {
            return badge.isStop ? .red : .orange
        }
        return isOn ? secondaryText : faintText
    }

    // MARK: - Provider Bar

    private var providerBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(providers, id: \.self) { provider in
                    let isOn = activeProvider == provider && !isSearching
                    Button {
                        selectedProvider = provider
                        if isSearching { query = "" }
                        UISelectionFeedbackGenerator().selectionChanged()
                    } label: {
                        HStack(spacing: 6) {
                            ProviderMark(provider: provider, size: 14)
                                .foregroundStyle(isOn ? primaryText : mutedText)
                            Text(ModelPicker.providerTitle(provider))
                                .font(.system(size: 12.5, weight: isOn ? .semibold : .regular))
                                .foregroundStyle(isOn ? primaryText : mutedText)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(pillBackground(isOn: isOn), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(isOn ? .isSelected : [])
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, context.usesPools ? 8 : 18)
            .padding(.bottom, 6)
        }
    }

    // MARK: - Search

    private var searchBox: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13.5, weight: .medium))
                .foregroundStyle(faintText)
            TextField("Search models", text: $query)
                .font(.system(size: 13.5))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(faintText)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 34)
        .background(Color.primary.opacity(colorScheme == .dark ? 0.07 : 0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 8)
    }

    // MARK: - Model List

    private var modelList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                if sections.isEmpty {
                    Text(isSearching ? "No matching models" : "No models available")
                        .font(.system(size: 13.5))
                        .foregroundStyle(faintText)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 28)
                } else {
                    ForEach(sections) { section in
                        if let title = section.title {
                            sectionHeader(title)
                        }
                        let mainRows = section.rows.filter { !$0.isOlder }
                        let olderRows = section.rows.filter(\.isOlder)
                        ForEach(mainRows) { row in
                            modelRow(row, provider: section.provider)
                        }
                        if !olderRows.isEmpty {
                            sectionHeader("Older")
                            ForEach(olderRows) { row in
                                modelRow(row, provider: section.provider)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        .scrollDismissesKeyboard(.interactively)
        .frame(maxHeight: .infinity)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11.5, weight: .medium))
            .foregroundStyle(faintText)
            .padding(.horizontal, 8)
            .padding(.top, 6)
            .padding(.bottom, 3)
    }

    private func modelRow(_ row: PickerModelRow, provider: String) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            onPickModel(row, activeColumn, provider)
            dismiss()
        } label: {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.primary.opacity(row.isSelected ? (colorScheme == .dark ? 0.13 : 0.11) : (colorScheme == .dark ? 0.07 : 0.06)))
                    ProviderMark(provider: provider, size: 14)
                        .foregroundStyle(row.isSelected ? primaryText : secondaryText)
                }
                .frame(width: 30, height: 30)
                .opacity(row.isOlder && !row.isSelected ? 0.55 : 1)

                VStack(alignment: .leading, spacing: 1) {
                    Text(row.title)
                        .font(.system(size: 14, weight: row.isOlder && !row.isSelected ? .medium : .semibold))
                        .foregroundStyle(row.isOlder && !row.isSelected ? secondaryText : primaryText)
                        .lineLimit(1)
                    if let subtitle = row.subtitle {
                        Text(subtitle)
                            .font(.system(size: 12))
                            .foregroundStyle(mutedText)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if row.isDefault || row.isSelected {
                    HStack(spacing: 7) {
                        if row.isDefault {
                            Image(systemName: "star.fill")
                                .font(.system(size: 10.5))
                                .foregroundStyle(faintText)
                                .accessibilityLabel("Default")
                        }
                        if row.isSelected {
                            Image(systemName: "checkmark")
                                .font(.system(size: 13.5, weight: .semibold))
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .background(
                row.isSelected
                    ? Color.primary.opacity(colorScheme == .dark ? 0.095 : 0.08)
                    : Color.clear,
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(row.isSelected ? .isSelected : [])
    }

    // MARK: - Effort Bar

    private var effortBar: some View {
        let levels = context.effortLevels
        let selected = context.effectiveEffort
        return HStack(spacing: 2) {
            ForEach(levels, id: \.self) { level in
                let isOn = selected == level
                Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    onPickEffort(level)
                } label: {
                    Text(effortSegmentLabel(level, totalCount: levels.count))
                        .font(.system(size: 12, weight: isOn ? .semibold : .regular))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .foregroundStyle(isOn ? primaryText : mutedText)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .padding(.horizontal, 2)
                        .background(
                            isOn ? segmentActiveBackground : Color.clear,
                            in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                        )
                        .shadow(color: isOn && colorScheme == .dark ? Color.black.opacity(0.4) : Color.black.opacity(isOn ? 0.08 : 0),
                                radius: 1.5, y: 1)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(ModelPicker.effortTitle(level)) effort")
                .accessibilityAddTraits(isOn ? .isSelected : [])
            }
        }
        .padding(2.5)
        .background(Color.primary.opacity(colorScheme == .dark ? 0.06 : 0.05), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }

    private func effortSegmentLabel(_ level: String, totalCount: Int) -> String {
        switch level {
        case "medium": return "Med"
        case "xhigh": return totalCount >= 6 ? "X-High" : "Extra high"
        default: return ModelPicker.effortTitle(level)
        }
    }

    // MARK: - Collapsible Login Footer

    private var loginFooter: some View {
        let line = context.loginLine
        let rows = context.loginRows(for: activeColumn, provider: activeProvider, now: now)
        return VStack(spacing: 0) {
            Button {
                withAnimation(.snappy(duration: 0.22)) {
                    loginExpanded.toggle()
                }
            } label: {
                HStack(spacing: 5) {
                    Text(line.primary)
                        .font(.system(size: 12.5))
                        .foregroundStyle(secondaryText)
                        .lineLimit(1)
                    if let detail = line.detail {
                        Text(detail)
                            .font(.system(size: 12.5))
                            .foregroundStyle(faintText)
                            .lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: loginExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(faintText)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if loginExpanded, !rows.isEmpty {
                hairline
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(rows) { row in
                            loginRowView(row)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.top, 6)
                    .padding(.bottom, 12)
                }
                .frame(maxHeight: 220)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
    }

    private func loginRowView(_ row: PickerLoginRow) -> some View {
        let provider = row.accountId.flatMap { context.account($0)?.provider }
        return Button {
            UISelectionFeedbackGenerator().selectionChanged()
            onPickLogin(row.accountId, activeColumn)
            withAnimation(.snappy(duration: 0.2)) {
                loginExpanded = false
            }
        } label: {
            HStack(spacing: 10) {
                Group {
                    if let provider {
                        ProviderMark(provider: provider, size: 13)
                            .foregroundStyle(row.isSelected ? primaryText : mutedText)
                    } else {
                        Image(systemName: "arrow.trianglehead.2.clockwise")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(row.isSelected ? primaryText : mutedText)
                    }
                }
                .frame(width: 18)

                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(.system(size: 13.5, weight: row.isSelected ? .semibold : .medium))
                        .foregroundStyle(primaryText)
                        .lineLimit(1)
                    if let subtitle = row.subtitle {
                        Text(subtitle)
                            .font(.system(size: 11.5))
                            .foregroundStyle(mutedText)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let room = row.room {
                    roomBar(percent: room, badge: row.badge)
                }
                if let words = row.roomWords {
                    Text(words)
                        .font(.system(size: 11.5, weight: row.badge != nil ? .semibold : .regular))
                        .monospacedDigit()
                        .foregroundStyle(loginBadgeColor(row.badge))
                }
                if row.isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(
                row.isSelected ? Color.primary.opacity(colorScheme == .dark ? 0.095 : 0.08) : Color.clear,
                in: RoundedRectangle(cornerRadius: 9, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(row.isSelected ? .isSelected : [])
    }

    private func roomBar(percent: Double, badge: ModelPicker.ChipBadge?) -> some View {
        let clamped = max(0, min(100, percent)) / 100.0
        let fill: Color = if let badge {
            badge.isStop ? .red : .orange
        } else {
            .accentColor
        }
        return GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.10))
                Capsule()
                    .fill(fill)
                    .frame(width: max(clamped > 0 ? 3 : 0, geo.size.width * clamped))
            }
        }
        .frame(width: 34, height: 4)
    }

    private func loginBadgeColor(_ badge: ModelPicker.ChipBadge?) -> Color {
        guard let badge else { return mutedText }
        return badge.isStop ? .red : .orange
    }

    // MARK: - Palette

    private var sheetBackground: Color {
        colorScheme == .dark ? Color(red: 28 / 255, green: 28 / 255, blue: 30 / 255) : Color(.secondarySystemBackground)
    }

    private var segmentActiveBackground: Color {
        colorScheme == .dark ? Color(red: 52 / 255, green: 52 / 255, blue: 56 / 255) : Color(.systemBackground)
    }

    private func pillBackground(isOn: Bool) -> Color {
        if isOn {
            return Color.primary.opacity(colorScheme == .dark ? 0.13 : 0.11)
        }
        return Color.primary.opacity(colorScheme == .dark ? 0.04 : 0.04)
    }

    private var hairline: some View {
        Rectangle()
            .fill(Color.primary.opacity(0.09))
            .frame(height: 0.5)
    }

    private var primaryText: Color {
        colorScheme == .dark ? .white : .primary
    }

    private var secondaryText: Color {
        colorScheme == .dark ? Color.white.opacity(0.72) : .primary.opacity(0.75)
    }

    private var mutedText: Color {
        colorScheme == .dark ? Color.white.opacity(0.56) : .secondary
    }

    private var faintText: Color {
        colorScheme == .dark ? Color.white.opacity(0.38) : .secondary.opacity(0.72)
    }
}
