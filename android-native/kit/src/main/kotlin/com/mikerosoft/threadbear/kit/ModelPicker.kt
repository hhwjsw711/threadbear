package com.mikerosoft.threadbear.kit

import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToLong

/**
 * Desktop-parity model, effort, pool and login picker logic for Android.
 * Mirrors `ModelPicker.swift` and desktop `logins.rs` / `composer_chips.rs`.
 */
object ModelPicker {
    /** Sentinel pool column for the "No pool" tab when pools are in use and unpooled logins exist. */
    const val UNPOOLED_COLUMN = "@unpooled"
    /** Minimum remaining percent before a login is skipped in auto-pick. */
    const val PICK_FLOOR = 1.0
    /** Remaining percent under which a chip or pool pill turns orange. */
    const val CHIP_WARNING = 25.0
    /** Help text shown under "Auto" in the expanded Login list. */
    const val AUTO_HELP = "The pool picks, and moves on when one runs out"

    val CLAUDE_EFFORT_LEVELS = listOf("low", "medium", "high", "xhigh", "max")
    val CODEX_EFFORT_LEVELS = listOf("low", "medium", "high", "xhigh", "max", "ultra")

    /** Orange under 25% remaining, red when blocked / signed out / plan ended. */
    sealed interface ChipBadge {
        val isStop: Boolean
        val label: String

        data class Low(val percent: String) : ChipBadge {
            override val isStop get() = false
            override val label get() = percent
        }

        data object Blocked : ChipBadge {
            override val isStop get() = true
            override val label get() = "Limit reached"
        }

        data object SignedOut : ChipBadge {
            override val isStop get() = true
            override val label get() = "Signed out"
        }

        data object PlanEnded : ChipBadge {
            override val isStop get() = true
            override val label get() = "Plan ended"
        }
    }

    data class EffectiveUsage(val windows: List<PhoneUsageWindow>, val blocked: Boolean)

    fun effectiveUsage(account: PhoneAccount): EffectiveUsage? {
        val hardBlocked = account.signedOut == true || account.planEnded == true
        val usage = account.usage
        if (usage != null) {
            return EffectiveUsage(usage.windows, (usage.blocked == true) || hardBlocked)
        }
        if (hardBlocked) {
            return EffectiveUsage(emptyList(), true)
        }
        return null
    }

    fun mainWindows(windows: List<PhoneUsageWindow>): List<PhoneUsageWindow> =
        listOf("five_hour", "weekly").mapNotNull { kind -> windows.firstOrNull { it.kind == kind } }

    fun tightestWindow(windows: List<PhoneUsageWindow>): PhoneUsageWindow? {
        val main = mainWindows(windows)
        var best: PhoneUsageWindow? = null
        for (w in main) {
            if (best == null || w.remainingPercent < best.remainingPercent) best = w
        }
        return best
    }

    fun room(windows: List<PhoneUsageWindow>): Double? = tightestWindow(windows)?.remainingPercent

    /** Whole-number percentage, floored so 99.6 never reads "100%". */
    fun percent(value: Double): String = "${floor(max(0.0, value)).toInt()}%"

    fun hasRoom(account: PhoneAccount): Boolean {
        val usage = effectiveUsage(account) ?: return true
        if (usage.blocked) return false
        val left = room(usage.windows)
        if (left != null && left < PICK_FLOOR) return false
        return true
    }

    fun chipBadge(account: PhoneAccount?): ChipBadge? {
        if (account == null) return null
        if (account.planEnded == true) return ChipBadge.PlanEnded
        if (account.signedOut == true) return ChipBadge.SignedOut
        val usage = effectiveUsage(account) ?: return null
        if (usage.blocked) return ChipBadge.Blocked
        val left = room(usage.windows) ?: return null
        if (left < PICK_FLOOR) return ChipBadge.Blocked
        return if (left < CHIP_WARNING) ChipBadge.Low(percent(left)) else null
    }

    fun bestRoom(logins: List<PhoneAccount>): Double? {
        var best: Double? = null
        for (login in logins) {
            val usage = effectiveUsage(login) ?: continue
            val left = if (usage.blocked) 0.0 else room(usage.windows) ?: continue
            if (best == null || left > best) best = left
        }
        return best
    }

    fun groupChipBadge(logins: List<PhoneAccount>): ChipBadge? {
        if (logins.isEmpty()) return null
        val usages = logins.map(::effectiveUsage)
        if (usages.all { it?.blocked == true }) return ChipBadge.Blocked
        val allLow = usages.all { u ->
            if (u == null) false
            else if (u.blocked) true
            else (room(u.windows) ?: Double.POSITIVE_INFINITY) < CHIP_WARNING
        }
        if (!allLow) return null
        return bestRoom(logins)?.let { ChipBadge.Low(percent(it)) }
    }

    fun poolChipBadge(pool: PhoneUsagePool, accounts: List<PhoneAccount>): ChipBadge? =
        groupChipBadge(poolLogins(pool, accounts))

    private val WEEKDAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
    private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    fun clock(instant: Instant, zone: ZoneId = ZoneId.systemDefault()): String {
        val dt = instant.atZone(zone)
        val h = dt.hour
        val m = dt.minute
        val twelve = if (h % 12 == 0) 12 else h % 12
        val suffix = if (h < 12) "am" else "pm"
        return if (m == 0) "$twelve $suffix" else "%d:%02d %s".format(twelve, m, suffix)
    }

    fun resetTime(instant: Instant, now: Instant, zone: ZoneId = ZoneId.systemDefault()): String {
        if (!instant.isAfter(now)) return "now"
        val zNow = now.atZone(zone)
        val zDate = instant.atZone(zone)
        if (zNow.toLocalDate() == zDate.toLocalDate()) return clock(instant, zone)
        val days = ChronoUnit.DAYS.between(zNow.toLocalDate(), zDate.toLocalDate())
        if (days == 1L) return "tomorrow ${clock(instant, zone)}"
        if (days in 2L..6L) {
            val wd = (zDate.dayOfWeek.value - 1).coerceIn(0, 6)
            return "${WEEKDAYS[wd]} ${clock(instant, zone)}"
        }
        val month = (zDate.monthValue - 1).coerceIn(0, 11)
        return "${zDate.dayOfMonth} ${MONTHS[month]}"
    }

    private fun shortWindowName(w: PhoneUsageWindow): String = when (w.kind) {
        "five_hour" -> "5h"
        "weekly" -> "week"
        else -> w.title
    }

    fun menuLine(account: PhoneAccount, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String? {
        val usage = effectiveUsage(account) ?: return null
        val main = mainWindows(usage.windows)
        if (usage.blocked) {
            val reset = main.filter { it.remainingPercent < 1.0 }.mapNotNull { it.resetsAt }.minOrNull()
                ?: main.mapNotNull { it.resetsAt }.minOrNull()
            return if (reset != null) "Limit reached, resets ${resetTime(reset, now, zone)}" else "Limit reached"
        }
        if (main.isEmpty()) return null
        val base = main.joinToString(" · ") { "${shortWindowName(it)} ${percent(it.remainingPercent)}" }
        val reset = tightestWindow(usage.windows)?.resetsAt
        return if (reset != null) "$base, resets ${resetTime(reset, now, zone)}" else base
    }

    fun subtitle(account: PhoneAccount, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String? {
        val usageLine = when {
            account.planEnded == true -> "Plan ended"
            account.signedOut == true -> "Signed out"
            else -> menuLine(account, now, zone)
        }
        val parts = listOfNotNull(account.note, usageLine).filter { it.isNotEmpty() }
        return if (parts.isEmpty()) null else parts.joinToString(" · ")
    }

    // Names

    fun providerTitle(id: String): String = when (id) {
        "claude", "" -> "Claude"
        "codex" -> "Codex"
        "opencode" -> "OpenCode"
        "gemini" -> "Gemini"
        "grok" -> "Grok"
        else -> id.replaceFirstChar { it.uppercase() }
    }

    fun effortTitle(level: String): String = when (level) {
        "xhigh" -> "Extra high"
        "max" -> "Max"
        "" -> ""
        else -> capitalized(level)
    }

    fun effortShortTitle(level: String): String = when (level) {
        "xhigh" -> "X-High"
        "medium" -> "Med"
        else -> effortTitle(level)
    }

    fun modelTitle(model: String?): String {
        if (model.isNullOrEmpty()) return "Default"
        if (model.all { it.isLetter() }) return capitalized(model)
        if (model.lowercase().startsWith("gpt-")) {
            return model.split('-').mapIndexed { idx, part ->
                if (idx == 0) part.uppercase() else capitalized(part)
            }.joinToString("-")
        }
        val parts = model.split('-').filter { it.isNotEmpty() }.toMutableList()
        if (parts.firstOrNull() != "claude") return model
        parts.removeAt(0)
        if (parts.lastOrNull()?.let { it.length == 8 && it.all { ch -> ch in '0'..'9' } } == true) {
            parts.removeAt(parts.lastIndex)
        }
        val family = parts.firstOrNull() ?: return model
        if (parts.size < 2 || !family.all { it.isLetter() } || !parts.drop(1).all { p -> p.all { ch -> ch in '0'..'9' } }) {
            return model
        }
        return "${capitalized(family)} ${parts.drop(1).joinToString(".")}"
    }

    private fun capitalized(word: String): String =
        if (word.isEmpty()) "" else word.first().uppercase() + word.drop(1).lowercase()

    private fun localPart(address: String): String = address.substringBefore('@')

    private fun domainPart(address: String): String? {
        val at = address.indexOf('@')
        if (at < 0) return null
        val first = address.substring(at + 1).substringBefore('.')
        return first.ifEmpty { null }
    }

    fun twinLabel(account: PhoneAccount, accounts: List<PhoneAccount>): String? {
        val email = account.email?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        val hasTwin = accounts.any { other ->
            other.id != account.id && other.providerId == account.providerId &&
                other.email?.trim()?.lowercase() == email
        }
        if (!hasTwin) return null
        val note = account.note?.trim().orEmpty()
        return note.ifEmpty { account.id }
    }

    fun shortAccountName(id: String, accounts: List<PhoneAccount>): String {
        val account = accounts.firstOrNull { it.id == id } ?: return id
        twinLabel(account, accounts)?.let { return it }
        val full = account.displayName
        val siblings = accounts.filter { it.id != id && it.providerId == account.providerId }
        if (account.providerId == "codex") {
            if (siblings.isEmpty()) return "Codex"
            val local = localPart(full)
            return if (siblings.any { localPart(it.displayName) == local }) "Codex $full" else "Codex $local"
        }
        val local = localPart(full)
        return if (siblings.any { localPart(it.displayName) == local }) full else local
    }

    fun loginName(id: String, accounts: List<PhoneAccount>): String {
        val account = accounts.firstOrNull { it.id == id } ?: return id
        if (account.providerId == "codex") return shortAccountName(id, accounts)
        val full = account.displayName
        val domain = domainPart(full) ?: return full
        val siblings = accounts.filter { it.id != id && it.providerId == account.providerId }.map { it.displayName }
        if (siblings.none { domainPart(it) == domain }) return domain
        val local = localPart(full)
        return if (siblings.any { localPart(it) == local }) full else local
    }

    // Pools & Providers

    fun poolLogins(pool: PhoneUsagePool, accounts: List<PhoneAccount>, provider: String? = null): List<PhoneAccount> =
        pool.accountIds.mapNotNull { id -> accounts.firstOrNull { it.id == id } }
            .filter { a -> provider == null || a.providerId == provider }

    fun poolProviders(pool: PhoneUsagePool, accounts: List<PhoneAccount>): List<String> {
        val seen = mutableListOf<String>()
        for (a in poolLogins(pool, accounts)) {
            if (a.providerId !in seen) seen += a.providerId
        }
        return seen
    }

    fun unpooledLogins(pools: List<PhoneUsagePool>, accounts: List<PhoneAccount>, provider: String? = null): List<PhoneAccount> {
        val pooledIds = pools.flatMap { it.accountIds }.toSet()
        return accounts.filter { it.id !in pooledIds && (provider == null || it.providerId == provider) }
    }

    fun unpooledProviders(pools: List<PhoneUsagePool>, accounts: List<PhoneAccount>): List<String> {
        val order = mutableListOf<String>()
        for (a in unpooledLogins(pools, accounts)) {
            if (a.providerId !in order) order += a.providerId
        }
        return sortProviders(order)
    }

    private fun sortProviders(providers: List<String>): List<String> {
        fun rank(p: String) = when (p) {
            "claude" -> 0
            "codex" -> 1
            else -> 2
        }
        return providers.withIndex().sortedWith(compareBy<IndexedValue<String>> { rank(it.value) }.thenBy { it.index }).map { it.value }
    }

    fun pickUnpooledLogin(
        pools: List<PhoneUsagePool>,
        accounts: List<PhoneAccount>,
        provider: String,
        current: String? = null,
    ): String? {
        val own = unpooledLogins(pools, accounts, provider)
        if (current != null && own.any { it.id == current }) return current
        var best: Pair<PhoneAccount, Double>? = null
        for (login in own) {
            if (!hasRoom(login)) continue
            val usage = effectiveUsage(login) ?: continue
            val left = room(usage.windows) ?: continue
            if (best == null || left > best.second) best = login to left
        }
        if (best != null) return best.first.id
        return own.firstOrNull { hasRoom(it) }?.id ?: own.firstOrNull()?.id
    }

    private fun weeklyResetMinutes(account: PhoneAccount, now: Instant): Double {
        val reset = effectiveUsage(account)?.windows?.firstOrNull { it.kind == "weekly" }?.resetsAt ?: return Double.POSITIVE_INFINITY
        if (!reset.isAfter(now)) return Double.POSITIVE_INFINITY
        return (reset.toEpochMilli() / 60_000.0).roundToLong().toDouble()
    }

    fun pickLogin(
        pool: PhoneUsagePool,
        accounts: List<PhoneAccount>,
        provider: String,
        current: String? = null,
        now: Instant = Instant.now(),
    ): String? {
        val own = poolLogins(pool, accounts, provider)
        if (current != null && own.any { it.id == current && hasRoom(it) }) return current
        val open = own.filter(::hasRoom)
        var bestId: String? = null
        var bestRoom = -1.0
        var bestReset = Double.POSITIVE_INFINITY
        for (login in open) {
            val usage = effectiveUsage(login) ?: continue
            val left = room(usage.windows) ?: continue
            val reset = weeklyResetMinutes(login, now)
            if (bestId != null && !(reset < bestReset || (reset == bestReset && left > bestRoom))) continue
            bestId = login.id
            bestRoom = left
            bestReset = reset
        }
        return bestId ?: open.firstOrNull()?.id ?: own.firstOrNull()?.id
    }

    // Model & Effort Helpers

    fun choice(id: String, choices: List<PhoneModelChoice>): PhoneModelChoice? =
        choices.firstOrNull { it.id == id } ?: choices.firstOrNull { it.model == id }

    fun resolvedModel(ids: List<String?>): String? = ids.firstOrNull { !it.isNullOrEmpty() }

    fun modelTitle(id: String?, choices: List<PhoneModelChoice>): String {
        if (id.isNullOrEmpty()) return "Default"
        return choice(id, choices)?.title ?: modelTitle(id)
    }

    fun chipTitle(model: String?, effort: String?, choices: List<PhoneModelChoice>): String {
        val title = modelTitle(model, choices)
        return if (effort.isNullOrEmpty()) title else "$title · ${effortTitle(effort)}"
    }

    fun effortLevels(model: String?, choices: List<PhoneModelChoice>, provider: String): List<String> {
        if (model != null) {
            val found = choice(model, choices)
            if (found != null) {
                val levels = found.effortLevels
                if (!levels.isNullOrEmpty()) return levels
                if (choices.any { !it.effortLevels.isNullOrEmpty() }) return emptyList()
            }
        }
        return when (provider) {
            "codex" -> CODEX_EFFORT_LEVELS
            "claude", "" -> CLAUDE_EFFORT_LEVELS
            else -> emptyList()
        }
    }

    fun impliedEffort(
        model: String?,
        choices: List<PhoneModelChoice>,
        account: PhoneAccount?,
        runnerDefault: String?,
    ): String? {
        if (!runnerDefault.isNullOrEmpty()) return runnerDefault
        if (!account?.defaultEffort.isNullOrEmpty()) return account?.defaultEffort
        if (model != null) return choice(model, choices)?.defaultEffort
        return null
    }

    fun pickerRows(
        choices: List<PhoneModelChoice>,
        defaultId: String?,
        selected: String?,
        query: String,
        provider: String,
    ): List<PickerModelRow> {
        val nonClaude = provider != "claude" && provider.isNotEmpty()
        val known: List<PhoneModelChoice> = when {
            choices.isNotEmpty() -> choices
            nonClaude -> if (!defaultId.isNullOrEmpty()) {
                listOf(PhoneModelChoice(id = defaultId, title = modelTitle(defaultId), model = defaultId))
            } else emptyList()
            else -> listOf("opus", "sonnet", "haiku").map {
                PhoneModelChoice(id = it, title = modelTitle(it), model = it)
            }
        }

        fun matches(c: PhoneModelChoice, id: String?): Boolean =
            !id.isNullOrEmpty() && (c.id == id || c.model == id)

        fun isMain(c: PhoneModelChoice): Boolean =
            nonClaude || c.id.all { it.isLetter() } || matches(c, defaultId) || matches(c, selected)

        val rows = mutableListOf<PickerModelRow>()
        val seen = HashSet<String>()
        fun add(c: PhoneModelChoice, older: Boolean) {
            val fullModel = c.model?.takeIf { it.isNotEmpty() } ?: c.id
            if (!seen.add(fullModel)) return
            rows += PickerModelRow(
                id = c.id,
                model = fullModel,
                title = c.title.ifEmpty { c.id },
                subtitle = c.description?.takeIf { it.isNotEmpty() },
                isDefault = matches(c, defaultId),
                isSelected = matches(c, selected),
                isOlder = older,
            )
        }

        for (c in known) if (isMain(c)) add(c, older = false)
        if (!selected.isNullOrEmpty() && known.none { matches(it, selected) }) {
            rows += PickerModelRow(
                id = selected,
                model = selected,
                title = modelTitle(selected),
                subtitle = null,
                isDefault = false,
                isSelected = true,
                isOlder = false,
            )
        }
        for (c in known) if (!isMain(c)) add(c, older = true)

        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return rows
        return rows.mapNotNull { row ->
            val hit = row.title.lowercase().contains(needle) ||
                row.id.lowercase().contains(needle) ||
                row.model.lowercase().contains(needle) ||
                (row.subtitle?.lowercase()?.contains(needle) == true)
            if (hit) row.copy(isOlder = false) else null
        }
    }
}

data class PickerPoolTab(
    val id: String,
    val title: String,
    val count: Int,
    val bestRoom: Double? = null,
    val badge: ModelPicker.ChipBadge? = null,
    val isUnpooled: Boolean = false,
) {
    val roomWords: String?
        get() = when (val b = badge) {
            ModelPicker.ChipBadge.Blocked -> "Limit"
            ModelPicker.ChipBadge.SignedOut -> "Signed out"
            ModelPicker.ChipBadge.PlanEnded -> "Plan ended"
            is ModelPicker.ChipBadge.Low -> b.percent
            null -> bestRoom?.let { ModelPicker.percent(it) }
        }
}

data class PickerModelRow(
    val id: String,
    val model: String,
    val title: String,
    val subtitle: String? = null,
    val isDefault: Boolean = false,
    val isSelected: Boolean = false,
    val isOlder: Boolean = false,
)

data class PickerModelSection(
    val provider: String,
    val title: String? = null,
    val rows: List<PickerModelRow>,
)

data class PickerLoginRow(
    val id: String,
    val accountId: String?,
    val title: String,
    val subtitle: String? = null,
    val room: Double? = null,
    val badge: ModelPicker.ChipBadge? = null,
    val isSelected: Boolean = false,
) {
    val roomWords: String?
        get() = when (badge) {
            ModelPicker.ChipBadge.Blocked -> "limit"
            ModelPicker.ChipBadge.SignedOut -> "signed out"
            ModelPicker.ChipBadge.PlanEnded -> "plan ended"
            else -> room?.let { ModelPicker.percent(it) }
        }
}

data class ModelPickerContext(
    val pools: List<PhoneUsagePool>,
    val accounts: List<PhoneAccount>,
    val defaults: PhoneRunnerDefaults?,
    val accountId: String,
    val provider: String,
    val poolId: String?,
    val model: String?,
    val modelInUse: String? = null,
    val effort: String?,
    val effortInUse: String? = null,
    val isNew: Boolean,
) {
    val usesPools: Boolean get() = pools.isNotEmpty()

    val pool: PhoneUsagePool?
        get() = if (usesPools && poolId != null) pools.firstOrNull { it.id == poolId } else null

    fun account(id: String): PhoneAccount? = accounts.firstOrNull { it.id == id }

    fun pool(id: String): PhoneUsagePool? = pools.firstOrNull { it.id == id }

    val unpooledAccounts: List<PhoneAccount>
        get() = ModelPicker.unpooledLogins(pools, accounts)

    val hasUnpooled: Boolean get() = usesPools && unpooledAccounts.isNotEmpty()

    val isPinnedToUnpooled: Boolean
        get() = usesPools && pool == null && account(accountId) != null && pools.none { accountId in it.accountIds }

    val choices: List<PhoneModelChoice>
        get() {
            account(accountId)?.models?.takeIf { it.isNotEmpty() }?.let { return it }
            pool?.let { p ->
                ModelPicker.poolLogins(p, accounts, provider).firstOrNull { it.models.isNotEmpty() }?.models?.let { return it }
            }
            return accounts.firstOrNull { it.providerId == provider && it.models.isNotEmpty() }?.models ?: emptyList()
        }

    fun runnerDefaultModel(provider: String): String? = defaults?.models?.get(provider)

    val defaultModel: String?
        get() {
            val primary = if (isNew) runnerDefaultModel(provider) else modelInUse
            return ModelPicker.resolvedModel(listOf(primary, account(accountId)?.defaultModel, runnerDefaultModel(provider)))
        }

    val effectiveModel: String?
        get() = ModelPicker.resolvedModel(listOf(model, defaultModel))

    val effortLevels: List<String>
        get() = ModelPicker.effortLevels(effectiveModel, choices, provider)

    val effectiveEffort: String?
        get() {
            val levels = effortLevels
            if (levels.isEmpty()) return null
            val runnerDefault = if (isNew) defaults?.efforts?.get(provider) else null
            return effort ?: effortInUse ?: ModelPicker.impliedEffort(effectiveModel, choices, account(accountId), runnerDefault)
        }

    val owner: String?
        get() {
            if (!usesPools) return null
            pool?.let { return it.title }
            if (account(accountId) == null) return null
            return ModelPicker.loginName(accountId, accounts)
        }

    val chipTitle: String
        get() {
            val rest = ModelPicker.chipTitle(effectiveModel, effectiveEffort, choices)
            val o = owner
            return if (!o.isNullOrEmpty()) "$o · $rest" else rest
        }

    val chipBadge: ModelPicker.ChipBadge?
        get() = if (usesPools && pool != null) ModelPicker.poolChipBadge(pool!!, accounts)
        else ModelPicker.chipBadge(account(accountId))

    val poolTabs: List<PickerPoolTab>
        get() {
            if (!usesPools) return emptyList()
            val tabs = pools.map { p ->
                val logins = ModelPicker.poolLogins(p, accounts)
                PickerPoolTab(
                    id = p.id,
                    title = p.title,
                    count = logins.size,
                    bestRoom = ModelPicker.bestRoom(logins),
                    badge = ModelPicker.groupChipBadge(logins),
                    isUnpooled = false,
                )
            }.toMutableList()
            if (hasUnpooled) {
                val unpooled = unpooledAccounts
                tabs += PickerPoolTab(
                    id = ModelPicker.UNPOOLED_COLUMN,
                    title = "No pool",
                    count = unpooled.size,
                    bestRoom = ModelPicker.bestRoom(unpooled),
                    badge = ModelPicker.groupChipBadge(unpooled),
                    isUnpooled = true,
                )
            }
            return tabs
        }

    fun resolvePickerPool(picked: String?): String {
        if (!usesPools) return provider
        if (picked != null) {
            if (picked == ModelPicker.UNPOOLED_COLUMN && hasUnpooled) return picked
            if (pool(picked) != null) return picked
        }
        pool?.let { return it.id }
        if (isPinnedToUnpooled) return ModelPicker.UNPOOLED_COLUMN
        pools.firstOrNull { accountId in it.accountIds }?.let { return it.id }
        return pools.firstOrNull()?.id ?: ModelPicker.UNPOOLED_COLUMN
    }

    fun pickerProviders(column: String): List<String> {
        if (!usesPools) {
            val seen = mutableListOf<String>()
            for (a in accounts) if (a.providerId !in seen) seen += a.providerId
            return if (seen.isEmpty()) listOf(provider) else seen
        }
        if (column == ModelPicker.UNPOOLED_COLUMN) return ModelPicker.unpooledProviders(pools, accounts)
        return pool(column)?.let { ModelPicker.poolProviders(it, accounts) } ?: listOf(provider)
    }

    fun resolvePickerProvider(column: String, picked: String?): String? {
        val list = pickerProviders(column)
        if (picked != null && picked in list) return picked
        if (provider in list) return provider
        return list.firstOrNull()
    }

    private fun groupProviderRows(own: Boolean, logins: List<PhoneAccount>, targetProvider: String, query: String): List<PickerModelRow> {
        val listing = logins.firstOrNull { it.models.isNotEmpty() } ?: logins.firstOrNull()
        return if (own) {
            val ownChoices = choices.ifEmpty { listing?.models ?: emptyList() }
            val def = defaultModel ?: listing?.defaultModel
            val chosen = ModelPicker.resolvedModel(listOf(model, def))
            ModelPicker.pickerRows(ownChoices, def, chosen, query, targetProvider)
        } else {
            val def = runnerDefaultModel(targetProvider) ?: listing?.defaultModel
            ModelPicker.pickerRows(listing?.models ?: emptyList(), def, null, query, targetProvider)
        }
    }

    private fun rowsWithoutPools(targetProvider: String, query: String): List<PickerModelRow> {
        val own = targetProvider == provider
        val listing = if (own) {
            account(accountId) ?: accounts.firstOrNull { it.providerId == targetProvider }
        } else {
            accounts.firstOrNull { it.providerId == targetProvider && it.models.isNotEmpty() }
                ?: accounts.firstOrNull { it.providerId == targetProvider }
        }
        val def = if (own) defaultModel else (runnerDefaultModel(targetProvider) ?: listing?.defaultModel)
        return ModelPicker.pickerRows(listing?.models ?: emptyList(), def, if (own) effectiveModel else null, query, targetProvider)
    }

    fun sections(column: String, activeProvider: String?, query: String): List<PickerModelSection> {
        val searching = query.trim().isNotEmpty()
        if (!usesPools) {
            if (searching) {
                val found = pickerProviders(column).mapNotNull { p ->
                    val rows = rowsWithoutPools(p, query)
                    if (rows.isEmpty()) null else PickerModelSection(p, ModelPicker.providerTitle(p), rows)
                }
                return if (activeProvider != null) found.sortedBy { if (it.provider == activeProvider) 0 else 1 } else found
            }
            if (activeProvider == null) return emptyList()
            val rows = rowsWithoutPools(activeProvider, "")
            return if (rows.isEmpty()) emptyList() else listOf(PickerModelSection(activeProvider, null, rows))
        }

        val isUnpooled = column == ModelPicker.UNPOOLED_COLUMN
        val shown = if (isUnpooled) null else pool(column)
        val providers = pickerProviders(column)

        fun rowsFor(targetProvider: String, q: String): List<PickerModelRow> {
            if (isUnpooled) {
                val own = isPinnedToUnpooled && targetProvider == provider
                val logins = ModelPicker.unpooledLogins(pools, accounts, targetProvider)
                return groupProviderRows(own, logins, targetProvider, q)
            }
            if (shown == null) return rowsWithoutPools(targetProvider, q)
            val inShown = (pool?.id == shown.id) || (pool == null && accountId in shown.accountIds)
            val own = inShown && targetProvider == provider
            val logins = ModelPicker.poolLogins(shown, accounts, targetProvider)
            return groupProviderRows(own, logins, targetProvider, q)
        }

        if (searching) {
            val found = providers.mapNotNull { p ->
                val rows = rowsFor(p, query)
                if (rows.isEmpty()) null else PickerModelSection(p, ModelPicker.providerTitle(p), rows)
            }
            return if (activeProvider != null) found.sortedBy { if (it.provider == activeProvider) 0 else 1 } else found
        }

        if (activeProvider == null) return emptyList()
        val rows = rowsFor(activeProvider, "")
        return if (rows.isEmpty()) emptyList() else listOf(PickerModelSection(activeProvider, null, rows))
    }

    val loginLine: Pair<String, String?>
        get() {
            val p = pool
            if (p != null) {
                val on = if (accountId.isNotEmpty() && accountId in p.accountIds && account(accountId) != null) {
                    "(${ModelPicker.loginName(accountId, accounts)} for now)"
                } else null
                return "Login: Auto" to on
            }
            val name = if (accountId.isEmpty()) "Default" else ModelPicker.loginName(accountId, accounts)
            return "Login: $name" to (if (isPinnedToUnpooled) "(not in a pool)" else null)
        }

    private fun loginRow(account: PhoneAccount, isSelected: Boolean, now: Instant, zone: ZoneId): PickerLoginRow {
        val usage = ModelPicker.effectiveUsage(account)
        val left = usage?.let { ModelPicker.room(it.windows) }
        val blocked = (usage?.blocked == true) || (left != null && left < ModelPicker.PICK_FLOOR)
        val badge = when {
            account.planEnded == true -> ModelPicker.ChipBadge.PlanEnded
            account.signedOut == true -> ModelPicker.ChipBadge.SignedOut
            blocked -> ModelPicker.ChipBadge.Blocked
            else -> ModelPicker.chipBadge(account)
        }
        return PickerLoginRow(
            id = account.id,
            accountId = account.id,
            title = ModelPicker.loginName(account.id, accounts),
            subtitle = ModelPicker.subtitle(account, now, zone),
            room = if (blocked) 0.0 else left,
            badge = badge,
            isSelected = isSelected,
        )
    }

    fun loginRows(column: String, activeProvider: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): List<PickerLoginRow> {
        if (!usesPools) {
            val list = if (activeProvider != null) accounts.filter { it.providerId == activeProvider } else accounts
            return list.map { loginRow(it, it.id == accountId, now, zone) }
        }
        if (column == ModelPicker.UNPOOLED_COLUMN) {
            val list = ModelPicker.unpooledLogins(pools, accounts, activeProvider)
            return list.map { loginRow(it, pool == null && accountId == it.id, now, zone) }
        }
        val shown = pool(column) ?: return emptyList()
        val rows = mutableListOf(
            PickerLoginRow(
                id = "@auto",
                accountId = null,
                title = "Auto",
                subtitle = ModelPicker.AUTO_HELP,
                room = null,
                badge = null,
                isSelected = pool?.id == shown.id,
            ),
        )
        val logins = ModelPicker.poolLogins(shown, accounts).toMutableList()
        if (pool == null) {
            val pinned = account(accountId)
            if (pinned != null && logins.none { it.id == pinned.id }) {
                logins.add(0, pinned)
            }
        }
        for (login in logins) {
            rows += loginRow(login, pool == null && accountId == login.id, now, zone)
        }
        return rows
    }

    // Existing thread change builders

    fun changeForPickingModel(row: PickerModelRow, column: String, targetProvider: String): ThreadSettingsChange? {
        val modelField = if (row.isDefault) SettingsField.Clear else SettingsField.Set(row.id)
        if (usesPools) {
            if (column == ModelPicker.UNPOOLED_COLUMN) {
                if (isPinnedToUnpooled && targetProvider == provider) {
                    return ThreadSettingsChange(model = modelField)
                }
                val picked = ModelPicker.pickUnpooledLogin(pools, accounts, targetProvider) ?: return null
                return ThreadSettingsChange(accountId = picked, model = SettingsField.Set(row.id))
            }
            if (pool?.id == column && targetProvider == provider) {
                return ThreadSettingsChange(model = modelField)
            }
            val shown = pool(column)
            if (pool == null && shown != null && accountId in shown.accountIds && targetProvider == provider) {
                return ThreadSettingsChange(model = modelField)
            }
            return ThreadSettingsChange(poolId = SettingsField.Set(column), provider = targetProvider, model = SettingsField.Set(row.id))
        }
        if (targetProvider == provider) return ThreadSettingsChange(model = modelField)
        val targetAccount = accounts.firstOrNull { it.providerId == targetProvider } ?: return null
        return ThreadSettingsChange(accountId = targetAccount.id, model = modelField)
    }

    fun changeForEffort(level: String): ThreadSettingsChange =
        ThreadSettingsChange(effort = SettingsField.Set(level))

    fun changeForLogin(targetAccountId: String?, column: String): ThreadSettingsChange? {
        if (targetAccountId != null) {
            if (pool == null && accountId == targetAccountId) return null
            return ThreadSettingsChange(accountId = targetAccountId)
        }
        if (!usesPools || pool?.id == column || pool(column) == null) return null
        return ThreadSettingsChange(poolId = SettingsField.Set(column))
    }

    fun applyingOptimistic(change: ThreadSettingsChange, thread: PhoneThread, now: Instant = Instant.now()): PhoneThread {
        var next = thread
        change.accountId?.let { newAccount ->
            next = next.copy(accountId = newAccount, poolId = null)
            val acc = account(newAccount)
            if (acc != null && acc.providerId != next.provider) {
                next = next.copy(
                    provider = acc.providerId,
                    model = runnerDefaultModel(acc.providerId),
                    modelInUse = null,
                    effort = defaults?.efforts?.get(acc.providerId),
                    effortInUse = null,
                )
            }
        }
        when (val p = change.poolId) {
            SettingsField.Keep -> {}
            SettingsField.Clear -> next = next.copy(poolId = null)
            is SettingsField.Set -> {
                next = next.copy(poolId = p.value)
                val targetProvider = change.provider ?: next.provider
                val targetPool = pool(p.value)
                if (targetPool != null) {
                    val providers = ModelPicker.poolProviders(targetPool, accounts)
                    val chosenProvider = if (targetProvider in providers) targetProvider else (providers.firstOrNull() ?: targetProvider)
                    if (chosenProvider != next.provider) {
                        next = next.copy(
                            provider = chosenProvider,
                            model = runnerDefaultModel(chosenProvider),
                            modelInUse = null,
                            effort = defaults?.efforts?.get(chosenProvider),
                            effortInUse = null,
                        )
                    }
                    if (next.accountId !in targetPool.accountIds || account(next.accountId)?.providerId != next.provider) {
                        ModelPicker.pickLogin(targetPool, accounts, next.provider, now = now)?.let { picked ->
                            next = next.copy(accountId = picked)
                        }
                    }
                }
            }
        }
        change.provider?.let { newProvider ->
            if (newProvider != next.provider) {
                next = next.copy(provider = newProvider, modelInUse = null, effortInUse = null)
            }
        }
        when (val m = change.model) {
            SettingsField.Keep -> {}
            SettingsField.Clear -> next = next.copy(model = null)
            is SettingsField.Set -> {
                next = next.copy(model = m.value, modelInUse = null)
                val targetChoices = account(next.accountId)?.models ?: choices
                val supported = ModelPicker.effortLevels(m.value, targetChoices, next.provider)
                if (next.effort != null && next.effort !in supported) {
                    next = next.copy(effort = null)
                }
            }
        }
        when (val e = change.effort) {
            SettingsField.Keep -> {}
            SettingsField.Clear -> next = next.copy(effort = null)
            is SettingsField.Set -> next = next.copy(effort = e.value)
        }
        return next
    }

    // New-thread draft updaters

    fun draftForPickingModel(current: NewThreadSettings, row: PickerModelRow, column: String, targetProvider: String): NewThreadSettings {
        var next = current
        val sameProvider = targetProvider == provider
        if (usesPools) {
            if (column == ModelPicker.UNPOOLED_COLUMN) {
                if (isPinnedToUnpooled && sameProvider) {
                    next = next.copy(model = if (row.isDefault) null else row.id)
                } else {
                    val picked = ModelPicker.pickUnpooledLogin(pools, accounts, targetProvider)
                    if (picked != null) {
                        next = next.copy(poolId = null, accountId = picked, provider = targetProvider, model = row.id)
                    }
                }
            } else if (pool?.id == column && sameProvider) {
                next = next.copy(model = if (row.isDefault) null else row.id)
            } else if (pool == null && pool(column)?.accountIds?.contains(accountId) == true && sameProvider) {
                next = next.copy(model = if (row.isDefault) null else row.id)
            } else {
                next = next.copy(poolId = column, accountId = null, provider = targetProvider, model = row.id)
            }
        } else if (sameProvider) {
            next = next.copy(model = if (row.isDefault) null else row.id)
        } else {
            val targetAccount = accounts.firstOrNull { it.providerId == targetProvider }
            if (targetAccount != null) {
                next = next.copy(accountId = targetAccount.id, provider = targetProvider, model = if (row.isDefault) null else row.id)
            }
        }
        val targetChoices = accounts.firstOrNull { it.providerId == targetProvider && it.models.isNotEmpty() }?.models ?: emptyList()
        val levels = ModelPicker.effortLevels(row.id, targetChoices, targetProvider)
        if (next.effort != null && next.effort !in levels) {
            next = next.copy(effort = null)
        }
        return next
    }

    fun draftForEffort(current: NewThreadSettings, level: String): NewThreadSettings =
        current.copy(effort = level)

    fun draftForLogin(current: NewThreadSettings, targetAccountId: String?, column: String): NewThreadSettings {
        if (targetAccountId != null) {
            val acc = account(targetAccountId)
            return if (acc != null && acc.providerId != provider) {
                current.copy(poolId = null, accountId = targetAccountId, provider = acc.providerId, model = null, effort = null)
            } else {
                current.copy(poolId = null, accountId = targetAccountId, provider = acc?.providerId ?: current.provider)
            }
        }
        if (!usesPools) return current
        val target = pool(column) ?: return current
        val providers = ModelPicker.poolProviders(target, accounts)
        return if (provider in providers) {
            current.copy(poolId = column, accountId = null, provider = provider)
        } else {
            current.copy(poolId = column, accountId = null, provider = providers.firstOrNull(), model = null, effort = null)
        }
    }

    companion object {
        fun forThread(thread: PhoneThread, runner: PhoneRunner?, accounts: List<PhoneAccount>): ModelPickerContext {
            val runnerAccounts = accounts.filter { it.runnerId == null || it.runnerId == thread.runnerId }
            return ModelPickerContext(
                pools = runner?.usagePools ?: emptyList(),
                accounts = runnerAccounts,
                defaults = runner?.defaults,
                accountId = thread.accountId,
                provider = thread.provider.ifEmpty { "claude" },
                poolId = thread.poolId,
                model = thread.model,
                modelInUse = thread.modelInUse,
                effort = thread.effort,
                effortInUse = thread.effortInUse,
                isNew = false,
            )
        }

        fun forNewThread(
            settings: NewThreadSettings,
            runner: PhoneRunner?,
            accounts: List<PhoneAccount>,
            now: Instant = Instant.now(),
        ): ModelPickerContext {
            val runnerId = runner?.runnerId
            val runnerAccounts = if (runnerId == null) accounts else accounts.filter { it.runnerId == null || it.runnerId == runnerId }
            val pools = runner?.usagePools ?: emptyList()
            val defaults = runner?.defaults

            val resolvedPoolId: String?
            val resolvedAccountId: String
            val resolvedProvider: String

            val explicitAccount = settings.accountId?.let { id -> runnerAccounts.firstOrNull { it.id == id } }
            if (explicitAccount != null) {
                resolvedPoolId = null
                resolvedAccountId = explicitAccount.id
                resolvedProvider = settings.provider ?: explicitAccount.providerId
            } else if (pools.isNotEmpty()) {
                val pool = settings.poolId?.let { id -> pools.firstOrNull { it.id == id } }
                    ?: defaults?.poolId?.let { id -> pools.firstOrNull { it.id == id } }
                    ?: pools.firstOrNull()
                resolvedPoolId = pool?.id
                val poolProvs = pool?.let { ModelPicker.poolProviders(it, runnerAccounts) } ?: emptyList()
                val defaultAccountProvider = defaults?.accountId?.let { id -> runnerAccounts.firstOrNull { it.id == id }?.providerId }
                val provider = listOfNotNull(settings.provider, defaultAccountProvider, poolProvs.firstOrNull())
                    .firstOrNull { p -> poolProvs.isEmpty() || p in poolProvs }
                    ?: "claude"
                resolvedProvider = provider
                resolvedAccountId = pool?.let { ModelPicker.pickLogin(it, runnerAccounts, provider, defaults?.accountId, now) }
                    ?: defaults?.accountId
                    ?: runnerAccounts.firstOrNull { it.providerId == provider }?.id
                    ?: ""
            } else {
                resolvedPoolId = null
                val account = defaults?.accountId?.let { id -> runnerAccounts.firstOrNull { it.id == id } }
                    ?: runnerAccounts.firstOrNull()
                resolvedAccountId = account?.id ?: ""
                resolvedProvider = settings.provider ?: account?.providerId ?: "claude"
            }

            return ModelPickerContext(
                pools = pools,
                accounts = runnerAccounts,
                defaults = defaults,
                accountId = resolvedAccountId,
                provider = resolvedProvider.ifEmpty { "claude" },
                poolId = resolvedPoolId,
                model = settings.model,
                modelInUse = null,
                effort = settings.effort,
                effortInUse = null,
                isNew = true,
            )
        }
    }
}
