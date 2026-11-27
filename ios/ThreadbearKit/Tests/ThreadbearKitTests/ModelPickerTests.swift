import Foundation
import Testing
@testable import ThreadbearKit

@Suite struct ModelPickerTests {
    private func sampleCalendar() -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        return cal
    }

    private func utc(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int = 0) -> Date {
        sampleCalendar().date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
    }

    private func fixture(now: Date) -> (pools: [PhoneUsagePool], accounts: [PhoneAccount], defaults: PhoneRunnerDefaults) {
        let claudeModels = [
            PhoneModelChoice(id: "opus", model: "claude-opus-5-5", title: "Opus 5.5", description: "Most capable for complex work", effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high"),
            PhoneModelChoice(id: "sonnet", model: "claude-sonnet-5-5", title: "Sonnet 5.5", description: "Fast and strong for everyday tasks", effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium"),
            PhoneModelChoice(id: "haiku", model: "claude-haiku-5-5", title: "Haiku 5.5", description: "Fastest for quick questions"),
            PhoneModelChoice(id: "claude-opus-4-1-20250805", model: "claude-opus-4-1-20250805", title: "Opus 4.1", description: "Previous flagship release", effortLevels: ["low", "medium", "high", "max"]),
        ]
        let codexModels = [
            PhoneModelChoice(id: "gpt-6-astra", model: "gpt-6-astra", title: "GPT-6 Astra", description: "Deep reasoning and code changes", effortLevels: ["low", "medium", "high", "xhigh", "ultra"], defaultEffort: "high"),
            PhoneModelChoice(id: "gpt-6-mini", model: "gpt-6-mini", title: "GPT-6 Mini", description: "Fast edits", effortLevels: ["low", "medium", "high"]),
        ]
        let pools = [
            PhoneUsagePool(id: "main", title: "Main", accountIds: ["claude-main", "claude-backup", "codex-main"]),
            PhoneUsagePool(id: "work", title: "Work", accountIds: ["claude-work"]),
        ]
        let accounts = [
            PhoneAccount(
                id: "claude-main", runnerId: "mac", provider: "claude", title: "alex@acme.example", email: "alex@acme.example",
                defaultModel: "opus", defaultEffort: "high",
                usage: PhoneAccountUsage(windows: [
                    PhoneUsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 95.6, resetsAt: now.addingTimeInterval(3600)),
                    PhoneUsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 80, resetsAt: now.addingTimeInterval(86_400)),
                ]),
                models: claudeModels
            ),
            PhoneAccount(
                id: "claude-backup", runnerId: "mac", provider: "claude", title: "alex@studio.example", email: "alex@studio.example",
                defaultModel: "opus", defaultEffort: "high",
                usage: PhoneAccountUsage(windows: [
                    PhoneUsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 0.4, resetsAt: now.addingTimeInterval(1800)),
                ]),
                models: claudeModels
            ),
            PhoneAccount(
                id: "codex-main", runnerId: "mac", provider: "codex", title: "Codex · alex@acme.example", email: "alex@acme.example",
                defaultModel: "gpt-6-astra", defaultEffort: "high",
                usage: PhoneAccountUsage(windows: [
                    PhoneUsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 60),
                ]),
                models: codexModels
            ),
            PhoneAccount(
                id: "claude-work", runnerId: "mac", provider: "claude", title: "alex@northwind.example", email: "alex@northwind.example",
                defaultModel: "opus",
                usage: PhoneAccountUsage(windows: [
                    PhoneUsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 18.9, resetsAt: now.addingTimeInterval(3600)),
                ]),
                models: claudeModels
            ),
            PhoneAccount(
                id: "claude-solo", runnerId: "mac", provider: "claude", title: "alex@solo.example", email: "alex@solo.example",
                defaultModel: "sonnet",
                usage: PhoneAccountUsage(windows: [
                    PhoneUsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 70),
                ]),
                models: claudeModels
            ),
        ]
        let defaults = PhoneRunnerDefaults(
            poolId: "main",
            accountId: "claude-main",
            models: ["claude": "opus", "codex": "gpt-6-astra"],
            efforts: ["claude": "high", "codex": "high"]
        )
        return (pools, accounts, defaults)
    }

    @Test func pickerRowsSplitsClaudeOlderAndFlattensOnSearch() {
        let now = utc(2026, 11, 11, 9)
        let (_, accounts, _) = fixture(now: now)
        let claudeChoices = accounts[0].models

        let browsed = ModelPicker.pickerRows(choices: claudeChoices, defaultId: "opus", selected: "opus", query: "", provider: "claude")
        #expect(browsed.filter { !$0.isOlder }.map(\.id) == ["opus", "sonnet", "haiku"])
        #expect(browsed.filter(\.isOlder).map(\.id) == ["claude-opus-4-1-20250805"])
        #expect(browsed.first?.isDefault == true)
        #expect(browsed.first?.isSelected == true)

        // Searching flattens Older and matches description too.
        let searched = ModelPicker.pickerRows(choices: claudeChoices, defaultId: "opus", selected: "opus", query: "flagship", provider: "claude")
        #expect(searched.map(\.id) == ["claude-opus-4-1-20250805"])
        #expect(searched.first?.isOlder == false)

        // Codex keeps dashed ids in main.
        let codexRows = ModelPicker.pickerRows(choices: accounts[2].models, defaultId: "gpt-6-astra", selected: nil, query: "", provider: "codex")
        #expect(codexRows.allSatisfy { !$0.isOlder })
    }

    @Test func searchCrossesProvidersInActivePoolWithActiveFirst() {
        let now = utc(2026, 11, 11, 9)
        let (pools, accounts, defaults) = fixture(now: now)
        let ctx = ModelPickerContext(
            pools: pools, accounts: accounts, defaults: defaults,
            accountId: "claude-main", provider: "claude", poolId: "main",
            model: nil, modelInUse: "opus", effort: nil, effortInUse: "high", isNew: false
        )

        // Empty query: only active provider (claude).
        let browsing = ctx.sections(for: "main", provider: "claude", query: "")
        #expect(browsing.map(\.provider) == ["claude"])

        // Non-empty query matching both claude ("Fast...") and codex ("Fast edits"): active provider first.
        let searching = ctx.sections(for: "main", provider: "claude", query: "fast")
        #expect(searching.map(\.provider) == ["claude", "codex"])
        #expect(searching[0].title == "Claude")
        #expect(searching[1].title == "Codex")
    }

    @Test func chipTitleBadgesAndPoolTabsMatchDesktop() {
        let now = utc(2026, 11, 11, 9)
        let (pools, accounts, defaults) = fixture(now: now)
        let ctx = ModelPickerContext(
            pools: pools, accounts: accounts, defaults: defaults,
            accountId: "claude-main", provider: "claude", poolId: "main",
            model: nil, modelInUse: "opus", effort: nil, effortInUse: "high", isNew: false
        )
        #expect(ctx.chipTitle == "Main · Opus 5.5 · High")
        #expect(ctx.chipBadge == nil)

        let tabs = ctx.poolTabs
        #expect(tabs.map(\.id) == ["main", "work", ModelPicker.unpooledColumn])
        #expect(tabs[0].count == 3)
        #expect(tabs[0].roomWords == "80%")
        #expect(tabs[1].badge == .low("18%"))
        #expect(tabs[2].title == "No pool")
        #expect(tabs[2].count == 1)

        // Thread on Work pool gets the orange 18% warning badge.
        let workCtx = ModelPickerContext(
            pools: pools, accounts: accounts, defaults: defaults,
            accountId: "claude-work", provider: "claude", poolId: "work",
            model: "haiku", modelInUse: nil, effort: nil, effortInUse: nil, isNew: false
        )
        #expect(workCtx.chipTitle == "Work · Haiku 5.5")
        #expect(workCtx.effortLevels.isEmpty)
        #expect(workCtx.chipBadge == .low("18%"))
    }

    @Test func loginLineAndRowsMatchDesktop() {
        let now = utc(2026, 11, 11, 9)
        let cal = sampleCalendar()
        let (pools, accounts, defaults) = fixture(now: now)

        let pooled = ModelPickerContext(
            pools: pools, accounts: accounts, defaults: defaults,
            accountId: "claude-main", provider: "claude", poolId: "main",
            model: nil, effort: nil, isNew: false
        )
        #expect(pooled.loginLine.primary == "Login: Auto")
        #expect(pooled.loginLine.detail == "(acme for now)")
        let rows = pooled.loginRows(for: "main", provider: "claude", now: now, calendar: cal)
        #expect(rows.map(\.title) == ["Auto", "acme", "studio", "Codex"])
        #expect(rows[0].isSelected == true)
        #expect(rows[1].roomWords == "80%")
        #expect(rows[2].roomWords == "limit")
        #expect(rows[2].badge == .blocked)

        let unpooled = ModelPickerContext(
            pools: pools, accounts: accounts, defaults: defaults,
            accountId: "claude-solo", provider: "claude", poolId: nil,
            model: nil, effort: nil, isNew: false
        )
        #expect(unpooled.loginLine.primary == "Login: solo")
        #expect(unpooled.loginLine.detail == "(not in a pool)")
        let unpooledRows = unpooled.loginRows(for: ModelPicker.unpooledColumn, provider: "claude", now: now, calendar: cal)
        #expect(unpooledRows.map(\.title) == ["solo"])
        #expect(unpooledRows[0].isSelected == true)
    }

    @Test func changePayloadsAndOptimisticUpdatesMatchDesktop() {
        let now = utc(2026, 11, 11, 9)
        let (pools, accounts, defaults) = fixture(now: now)
        let ctx = ModelPickerContext(
            pools: pools, accounts: accounts, defaults: defaults,
            accountId: "claude-main", provider: "claude", poolId: "main",
            model: "sonnet", modelInUse: "opus", effort: "medium", effortInUse: nil, isNew: false
        )

        // Picking default model in same pool+provider sends { model: null }.
        let opusRow = PickerModelRow(id: "opus", model: "claude-opus-5-5", title: "Opus 5.5", isDefault: true, isSelected: false, isOlder: false)
        let samePoolDefault = ctx.changeForPickingModel(row: opusRow, column: "main", provider: "claude")
        #expect(samePoolDefault == ThreadSettingsChange(model: .clear))
        #expect(samePoolDefault?.json == .object(["model": .null]))

        // Switching to another pool names the model explicitly even when starred.
        let movePool = ctx.changeForPickingModel(row: opusRow, column: "work", provider: "claude")
        #expect(movePool == ThreadSettingsChange(poolId: .set("work"), provider: "claude", model: .set("opus")))

        // Switching to No pool pins to the unpooled login and names the model.
        let moveUnpooled = ctx.changeForPickingModel(row: opusRow, column: ModelPicker.unpooledColumn, provider: "claude")
        #expect(moveUnpooled == ThreadSettingsChange(accountId: "claude-solo", model: .set("opus")))

        // Pinning login clears poolId optimistically.
        let base = PhoneThread(threadId: "t1", title: "Test", accountId: "claude-main", provider: "claude", poolId: "main", model: "sonnet", effort: "medium", lastActivityAt: now)
        let pinChange = ctx.changeForLogin(accountId: "claude-backup", column: "main")!
        #expect(pinChange == ThreadSettingsChange(accountId: "claude-backup"))
        let pinned = ctx.applyingOptimistic(pinChange, to: base, now: now)
        #expect(pinned.accountId == "claude-backup")
        #expect(pinned.poolId == nil)

        // Switching to Haiku drops effort optimistically because Haiku has no effort levels.
        let haikuRow = PickerModelRow(id: "haiku", model: "claude-haiku-5-5", title: "Haiku 5.5", isDefault: false, isSelected: false, isOlder: false)
        let haikuChange = ctx.changeForPickingModel(row: haikuRow, column: "main", provider: "claude")!
        let onHaiku = ctx.applyingOptimistic(haikuChange, to: base, now: now)
        #expect(onHaiku.model == "haiku")
        #expect(onHaiku.effort == nil)
    }

    @Test func fakeBackendAppliesSettingsChanges() async throws {
        let fake = FakeBackend(turnDelay: .zero)
        let change = ThreadSettingsChange(poolId: .set("work"), provider: "claude", model: .set("sonnet"), effort: .set("xhigh"))
        _ = try await fake.update(threadId: "a3", change: .settings(change))
        for try await detail in fake.thread("a3") {
            #expect(detail?.thread.poolId == "work")
            #expect(detail?.thread.model == "sonnet")
            #expect(detail?.thread.effort == "xhigh")
            break
        }
    }
}
