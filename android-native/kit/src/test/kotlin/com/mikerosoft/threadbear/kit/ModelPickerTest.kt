package com.mikerosoft.threadbear.kit

import java.time.Instant
import java.time.ZoneOffset
import java.time.ZonedDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

class ModelPickerTest {
    private fun utc(y: Int, m: Int, d: Int, h: Int, min: Int = 0): Instant =
        ZonedDateTime.of(y, m, d, h, min, 0, 0, ZoneOffset.UTC).toInstant()

    private data class Fixture(
        val pools: List<PhoneUsagePool>,
        val accounts: List<PhoneAccount>,
        val defaults: PhoneRunnerDefaults,
    )

    private fun fixture(now: Instant): Fixture {
        val claudeModels = listOf(
            PhoneModelChoice(
                id = "opus", model = "claude-opus-5-5", title = "Opus 5.5",
                description = "Most capable for complex work",
                effortLevels = listOf("low", "medium", "high", "xhigh", "max"), defaultEffort = "high",
            ),
            PhoneModelChoice(
                id = "sonnet", model = "claude-sonnet-5-5", title = "Sonnet 5.5",
                description = "Fast and strong for everyday tasks",
                effortLevels = listOf("low", "medium", "high", "xhigh", "max"), defaultEffort = "medium",
            ),
            PhoneModelChoice(
                id = "haiku", model = "claude-haiku-5-5", title = "Haiku 5.5",
                description = "Fastest for quick questions",
            ),
            PhoneModelChoice(
                id = "claude-opus-4-1-20250805", model = "claude-opus-4-1-20250805", title = "Opus 4.1",
                description = "Previous flagship release",
                effortLevels = listOf("low", "medium", "high", "max"),
            ),
        )
        val codexModels = listOf(
            PhoneModelChoice(
                id = "gpt-6-astra", model = "gpt-6-astra", title = "GPT-6 Astra",
                description = "Deep reasoning and code changes",
                effortLevels = listOf("low", "medium", "high", "xhigh", "ultra"), defaultEffort = "high",
            ),
            PhoneModelChoice(
                id = "gpt-6-mini", model = "gpt-6-mini", title = "GPT-6 Mini",
                description = "Fast edits",
                effortLevels = listOf("low", "medium", "high"),
            ),
        )
        val pools = listOf(
            PhoneUsagePool("main", "Main", listOf("claude-main", "claude-backup", "codex-main")),
            PhoneUsagePool("work", "Work", listOf("claude-work")),
        )
        val accounts = listOf(
            PhoneAccount(
                id = "claude-main", runnerId = "mac", provider = "claude",
                title = "alex@acme.example", email = "alex@acme.example",
                defaultModel = "opus", defaultEffort = "high",
                usage = PhoneAccountUsage(
                    windows = listOf(
                        PhoneUsageWindow("five_hour", "5-hour", 95.6, now.plusSeconds(3600)),
                        PhoneUsageWindow("weekly", "Weekly", 80.0, now.plusSeconds(86_400)),
                    ),
                ),
                models = claudeModels,
            ),
            PhoneAccount(
                id = "claude-backup", runnerId = "mac", provider = "claude",
                title = "alex@studio.example", email = "alex@studio.example",
                defaultModel = "opus", defaultEffort = "high",
                usage = PhoneAccountUsage(
                    windows = listOf(
                        PhoneUsageWindow("five_hour", "5-hour", 0.4, now.plusSeconds(1800)),
                    ),
                ),
                models = claudeModels,
            ),
            PhoneAccount(
                id = "codex-main", runnerId = "mac", provider = "codex",
                title = "Codex · alex@acme.example", email = "alex@acme.example",
                defaultModel = "gpt-6-astra", defaultEffort = "high",
                usage = PhoneAccountUsage(
                    windows = listOf(PhoneUsageWindow("weekly", "Weekly", 60.0)),
                ),
                models = codexModels,
            ),
            PhoneAccount(
                id = "claude-work", runnerId = "mac", provider = "claude",
                title = "alex@northwind.example", email = "alex@northwind.example",
                defaultModel = "opus",
                usage = PhoneAccountUsage(
                    windows = listOf(
                        PhoneUsageWindow("five_hour", "5-hour", 18.9, now.plusSeconds(3600)),
                    ),
                ),
                models = claudeModels,
            ),
            PhoneAccount(
                id = "claude-solo", runnerId = "mac", provider = "claude",
                title = "alex@solo.example", email = "alex@solo.example",
                defaultModel = "sonnet",
                usage = PhoneAccountUsage(
                    windows = listOf(PhoneUsageWindow("weekly", "Weekly", 70.0)),
                ),
                models = claudeModels,
            ),
        )
        val defaults = PhoneRunnerDefaults(
            poolId = "main",
            accountId = "claude-main",
            models = mapOf("claude" to "opus", "codex" to "gpt-6-astra"),
            efforts = mapOf("claude" to "high", "codex" to "high"),
        )
        return Fixture(pools, accounts, defaults)
    }

    @Test fun pickerRowsSplitsClaudeOlderAndFlattensOnSearch() {
        val now = utc(2026, 11, 11, 9)
        val (_, accounts, _) = fixture(now)
        val claudeChoices = accounts[0].models

        val browsed = ModelPicker.pickerRows(claudeChoices, defaultId = "opus", selected = "opus", query = "", provider = "claude")
        assertEquals(listOf("opus", "sonnet", "haiku"), browsed.filter { !it.isOlder }.map { it.id })
        assertEquals(listOf("claude-opus-4-1-20250805"), browsed.filter { it.isOlder }.map { it.id })
        assertTrue(browsed.first().isDefault)
        assertTrue(browsed.first().isSelected)

        // Searching flattens Older and matches description too.
        val searched = ModelPicker.pickerRows(claudeChoices, defaultId = "opus", selected = "opus", query = "flagship", provider = "claude")
        assertEquals(listOf("claude-opus-4-1-20250805"), searched.map { it.id })
        assertFalse(searched.first().isOlder)

        // Codex keeps dashed ids in main.
        val codexRows = ModelPicker.pickerRows(accounts[2].models, defaultId = "gpt-6-astra", selected = null, query = "", provider = "codex")
        assertTrue(codexRows.all { !it.isOlder })
    }

    @Test fun searchCrossesProvidersInActivePoolWithActiveFirst() {
        val now = utc(2026, 11, 11, 9)
        val (pools, accounts, defaults) = fixture(now)
        val ctx = ModelPickerContext(
            pools = pools, accounts = accounts, defaults = defaults,
            accountId = "claude-main", provider = "claude", poolId = "main",
            model = null, modelInUse = "opus", effort = null, effortInUse = "high", isNew = false,
        )

        val browsing = ctx.sections("main", "claude", "")
        assertEquals(listOf("claude"), browsing.map { it.provider })

        val searching = ctx.sections("main", "claude", "fast")
        assertEquals(listOf("claude", "codex"), searching.map { it.provider })
        assertEquals("Claude", searching[0].title)
        assertEquals("Codex", searching[1].title)
    }

    @Test fun chipTitleBadgesAndPoolTabsMatchDesktop() {
        val now = utc(2026, 11, 11, 9)
        val (pools, accounts, defaults) = fixture(now)
        val ctx = ModelPickerContext(
            pools = pools, accounts = accounts, defaults = defaults,
            accountId = "claude-main", provider = "claude", poolId = "main",
            model = null, modelInUse = "opus", effort = null, effortInUse = "high", isNew = false,
        )
        assertEquals("Main · Opus 5.5 · High", ctx.chipTitle)
        assertNull(ctx.chipBadge)

        val tabs = ctx.poolTabs
        assertEquals(listOf("main", "work", ModelPicker.UNPOOLED_COLUMN), tabs.map { it.id })
        assertEquals(3, tabs[0].count)
        assertEquals("80%", tabs[0].roomWords)
        assertEquals(ModelPicker.ChipBadge.Low("18%"), tabs[1].badge)
        assertEquals("No pool", tabs[2].title)
        assertEquals(1, tabs[2].count)

        val workCtx = ModelPickerContext(
            pools = pools, accounts = accounts, defaults = defaults,
            accountId = "claude-work", provider = "claude", poolId = "work",
            model = "haiku", modelInUse = null, effort = null, effortInUse = null, isNew = false,
        )
        assertEquals("Work · Haiku 5.5", workCtx.chipTitle)
        assertTrue(workCtx.effortLevels.isEmpty())
        assertEquals(ModelPicker.ChipBadge.Low("18%"), workCtx.chipBadge)
    }

    @Test fun loginLineAndRowsMatchDesktop() {
        val now = utc(2026, 11, 11, 9)
        val (pools, accounts, defaults) = fixture(now)

        val pooled = ModelPickerContext(
            pools = pools, accounts = accounts, defaults = defaults,
            accountId = "claude-main", provider = "claude", poolId = "main",
            model = null, effort = null, isNew = false,
        )
        assertEquals("Login: Auto", pooled.loginLine.first)
        assertEquals("(acme for now)", pooled.loginLine.second)
        val rows = pooled.loginRows("main", "claude", now, ZoneOffset.UTC)
        assertEquals(listOf("Auto", "acme", "studio", "Codex"), rows.map { it.title })
        assertTrue(rows[0].isSelected)
        assertEquals("80%", rows[1].roomWords)
        assertEquals("limit", rows[2].roomWords)
        assertEquals(ModelPicker.ChipBadge.Blocked, rows[2].badge)

        val unpooled = ModelPickerContext(
            pools = pools, accounts = accounts, defaults = defaults,
            accountId = "claude-solo", provider = "claude", poolId = null,
            model = null, effort = null, isNew = false,
        )
        assertEquals("Login: solo", unpooled.loginLine.first)
        assertEquals("(not in a pool)", unpooled.loginLine.second)
        val unpooledRows = unpooled.loginRows(ModelPicker.UNPOOLED_COLUMN, "claude", now, ZoneOffset.UTC)
        assertEquals(listOf("solo"), unpooledRows.map { it.title })
        assertTrue(unpooledRows[0].isSelected)
    }

    @Test fun changePayloadsAndOptimisticUpdatesMatchDesktop() {
        val now = utc(2026, 11, 11, 9)
        val (pools, accounts, defaults) = fixture(now)
        val ctx = ModelPickerContext(
            pools = pools, accounts = accounts, defaults = defaults,
            accountId = "claude-main", provider = "claude", poolId = "main",
            model = "sonnet", modelInUse = "opus", effort = "medium", effortInUse = null, isNew = false,
        )

        val opusRow = PickerModelRow("opus", "claude-opus-5-5", "Opus 5.5", isDefault = true, isSelected = false, isOlder = false)
        val samePoolDefault = ctx.changeForPickingModel(opusRow, "main", "claude")
        assertEquals(ThreadSettingsChange(model = SettingsField.Clear), samePoolDefault)
        assertEquals(JsonObject(mapOf("model" to JsonNull)), samePoolDefault?.json)

        val movePool = ctx.changeForPickingModel(opusRow, "work", "claude")
        assertEquals(
            ThreadSettingsChange(poolId = SettingsField.Set("work"), provider = "claude", model = SettingsField.Set("opus")),
            movePool,
        )

        val moveUnpooled = ctx.changeForPickingModel(opusRow, ModelPicker.UNPOOLED_COLUMN, "claude")
        assertEquals(
            ThreadSettingsChange(accountId = "claude-solo", model = SettingsField.Set("opus")),
            moveUnpooled,
        )

        val base = PhoneThread(
            threadId = "t1", runnerId = "mac", title = "Test", cwd = "/tmp",
            accountId = "claude-main", provider = "claude", poolId = "main",
            model = "sonnet", effort = "medium", status = ThreadStatus.IDLE,
            needsYou = false, unread = false, preview = "", lastActivityAt = now,
        )
        val pinChange = ctx.changeForLogin("claude-backup", "main")
        assertNotNull(pinChange)
        assertEquals(ThreadSettingsChange(accountId = "claude-backup"), pinChange)
        val pinned = ctx.applyingOptimistic(pinChange, base, now)
        assertEquals("claude-backup", pinned.accountId)
        assertNull(pinned.poolId)

        val haikuRow = PickerModelRow("haiku", "claude-haiku-5-5", "Haiku 5.5", isDefault = false, isSelected = false, isOlder = false)
        val haikuChange = ctx.changeForPickingModel(haikuRow, "main", "claude")
        assertNotNull(haikuChange)
        val onHaiku = ctx.applyingOptimistic(haikuChange, base, now)
        assertEquals("haiku", onHaiku.model)
        assertNull(onHaiku.effort)
    }
}
