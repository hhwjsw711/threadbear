package com.mikerosoft.threadbear.kit

import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * One model an account offers (backend API 20, enriched in API 107), as the
 * Mac's model picker lists it: `id` is what a new thread or change sends.
 */
data class PhoneModelChoice(
    val id: String,
    val title: String,
    val effortLevels: List<String>? = null,
    val defaultEffort: String? = null,
    val model: String? = null,
    val description: String? = null,
) {
    companion object {
        fun read(o: JsonObject) = PhoneModelChoice(
            id = o.needStr("id"),
            title = o.needStr("title"),
            effortLevels = o.strings("effortLevels"),
            defaultEffort = o.str("defaultEffort"),
            model = o.str("model"),
            description = o.str("description"),
        )
    }
}

/** One usage pool mirrored on a runner row (backend API 107). */
data class PhoneUsagePool(
    val id: String,
    val title: String,
    val accountIds: List<String> = emptyList(),
) {
    companion object {
        fun read(o: JsonObject) = PhoneUsagePool(
            id = o.needStr("id"),
            title = o.str("title") ?: o.needStr("id"),
            accountIds = o.strings("accountIds") ?: emptyList(),
        )
    }
}

/** A runner's default pool, login, and per-provider models & efforts (backend API 107). */
data class PhoneRunnerDefaults(
    val poolId: String? = null,
    val accountId: String? = null,
    val models: Map<String, String>? = null,
    val efforts: Map<String, String>? = null,
) {
    companion object {
        private fun stringMap(o: JsonObject?): Map<String, String>? {
            if (o == null) return null
            val out = LinkedHashMap<String, String>()
            for ((k, v) in o) {
                val s = (v as? JsonPrimitive)?.takeIf { it.isString }?.content
                if (s != null) out[k] = s
            }
            return out
        }

        fun read(o: JsonObject) = PhoneRunnerDefaults(
            poolId = o.str("poolId"),
            accountId = o.str("accountId"),
            models = stringMap(o.obj("models")),
            efforts = stringMap(o.obj("efforts")),
        )
    }
}

/** One rate-limit window on a login's usage snapshot (backend API 107). */
data class PhoneUsageWindow(
    val kind: String,
    val title: String,
    val remainingPercent: Double,
    val resetsAt: Instant? = null,
) {
    companion object {
        fun read(o: JsonObject) = PhoneUsageWindow(
            kind = o.needStr("kind"),
            title = o.str("title") ?: o.needStr("kind"),
            remainingPercent = o.needNum("remainingPercent"),
            resetsAt = o.date("resetsAt"),
        )
    }
}

/** Usage summary mirrored on a phone:accounts row (backend API 107). */
data class PhoneAccountUsage(
    val windows: List<PhoneUsageWindow> = emptyList(),
    val blocked: Boolean? = null,
) {
    companion object {
        fun read(o: JsonObject) = PhoneAccountUsage(
            windows = o.arr("windows")?.lossy { PhoneUsageWindow.read(it as JsonObject) } ?: emptyList(),
            blocked = o.bool("blocked"),
        )
    }
}

/**
 * A row of phone:accounts: a login on one of the runners.
 * Enriched in API 107 with note, email, plan, defaultModel, defaultEffort,
 * signedOut, planEnded and usage for the desktop-twin model picker.
 */
data class PhoneAccount(
    val id: String,
    val runnerId: String? = null,
    val provider: String,
    val title: String,
    val models: List<PhoneModelChoice> = emptyList(),
    val note: String? = null,
    val email: String? = null,
    val plan: String? = null,
    val defaultModel: String? = null,
    val defaultEffort: String? = null,
    val signedOut: Boolean? = null,
    val planEnded: Boolean? = null,
    val usage: PhoneAccountUsage? = null,
) {
    val providerId: String get() = provider.ifEmpty { "claude" }

    /** Desktop parity display name: non-empty email, else title, else id. */
    val displayName: String
        get() {
            val e = email?.trim()
            if (!e.isNullOrEmpty()) return e
            val t = title.trim()
            if (t.isNotEmpty()) return t
            return id
        }

    companion object {
        fun read(o: JsonObject): PhoneAccount {
            val id = o.needStr("id")
            return PhoneAccount(
                id = id,
                runnerId = o.str("runnerId"),
                provider = o.str("provider") ?: "claude",
                title = o.str("title") ?: id,
                // A backend before API 20 has no models: no pickers, not a broken row.
                models = o.arr("models")?.lossy { PhoneModelChoice.read(it as JsonObject) } ?: emptyList(),
                note = o.str("note"),
                email = o.str("email"),
                plan = o.str("plan"),
                defaultModel = o.str("defaultModel"),
                defaultEffort = o.str("defaultEffort"),
                signedOut = o.bool("signedOut"),
                planEnded = o.bool("planEnded"),
                usage = o.obj("usage")?.let { runCatching { PhoneAccountUsage.read(it) }.getOrNull() },
            )
        }
    }
}

/**
 * What a new thread from the phone can name. Null is the runner's usual.
 * API 107 adds optional `poolId`, `accountId`, and `provider` (sent with poolId).
 */
data class NewThreadSettings(
    val model: String? = null,
    val effort: String? = null,
    val poolId: String? = null,
    val accountId: String? = null,
    val provider: String? = null,
)

/**
 * The new thread screen's runner, model and effort pickers, from the
 * mirrored runners and accounts (NewThreadChoices.swift).
 */
object NewThreadChoices {
    /**
     * Where a new thread starts unless Mike picks another: the first runner
     * online of those he's placed in his order (phone:runners lists them in
     * it), or else the main Mac, to wait for. A runner he hasn't placed is
     * never picked for him, so a Mac with a runner key only gets his words
     * when he's said so. Null with neither, which leaves it to the backend
     * (phone:create's own choice). Draining ones are passed over.
     */
    fun runner(runners: List<PhoneRunner>, now: Instant): PhoneRunner? =
        runners.firstOrNull { it.placed == true && it.isOnline(now) && it.draining != true }
            ?: runners.firstOrNull { it.main == true }

    /**
     * The models on offer on one runner: its own logins' (a row with no
     * runner is anyone's). None while its logins haven't come up yet, so it
     * starts on its own default rather than another Mac's model.
     */
    fun models(accounts: List<PhoneAccount>, runnerId: String?): List<PhoneModelChoice> {
        if (runnerId == null) return models(accounts)
        return models(accounts.filter { it.runnerId == null || it.runnerId == runnerId })
    }

    /** Every model on offer, Claude's first, each once. */
    fun models(accounts: List<PhoneAccount>): List<PhoneModelChoice> {
        val order = listOf("claude", "codex")
        fun rank(a: PhoneAccount) = order.indexOf(a.provider).let { if (it < 0) order.size else it }
        // sortedBy is stable, so accounts of one provider keep their order.
        val seen = HashSet<String>()
        return accounts.sortedBy(::rank).flatMap { it.models }.filter { seen.add(it.id) }
    }

    /**
     * The efforts a model offers, or with no model picked Claude's levels
     * (the runner drops one the model it lands on doesn't offer).
     */
    fun efforts(model: PhoneModelChoice?): List<String> {
        val levels = model?.effortLevels ?: emptyList()
        return if (levels.isEmpty()) CLAUDE_LEVELS else levels.filter { it in ALL }
    }

    fun effortTitle(level: String): String =
        TITLES[level] ?: level.replaceFirstChar { it.uppercase() }

    /** Whether a picked effort still fits once the model changes. */
    fun keeps(effort: String?, model: PhoneModelChoice?): Boolean = effort == null || effort in efforts(model)

    /**
     * "Mac offline since 10:42" when no runner has checked in for three
     * minutes (AppModel.offlineText). Things done meanwhile wait until it's back.
     */
    fun offlineText(runners: List<PhoneRunner>, now: Instant): String? {
        if (runners.isEmpty() || runners.any { it.isOnline(now) }) return null
        val newest = runners.maxBy { it.lastSeenAt }
        val name = if (runners.size == 1) "Mac" else newest.name
        return "$name offline since ${RelativeTime.clock(newest.lastSeenAt, now)}"
    }

    /** With a runner picked, whether that one's asleep. */
    fun offlineText(runner: PhoneRunner, now: Instant): String? =
        if (runner.isOnline(now)) null else "${runner.name} offline since ${RelativeTime.clock(runner.lastSeenAt, now)}"

    private val ALL = listOf("low", "medium", "high", "xhigh", "max", "ultra")
    private val CLAUDE_LEVELS = listOf("low", "medium", "high", "xhigh", "max")
    private val TITLES = mapOf(
        "low" to "Low", "medium" to "Medium", "high" to "High", "xhigh" to "Extra high", "max" to "Max", "ultra" to "Ultra",
    )
}
