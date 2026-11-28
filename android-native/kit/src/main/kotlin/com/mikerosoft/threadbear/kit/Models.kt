package com.mikerosoft.threadbear.kit

import java.time.Instant
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// The rows convex/phone.ts returns, as ThreadbearKit's Models.swift reads
// them. Field names follow the runner's ThreadSummary.

enum class ThreadStatus {
    IDLE, STARTING, RUNNING, WAITING, ERROR, STOPPED,
    /** A status a newer runner sends that this build doesn't know. */
    UNKNOWN;

    companion object {
        fun of(raw: String?): ThreadStatus = when (raw) {
            "idle" -> IDLE
            "starting" -> STARTING
            "running" -> RUNNING
            "waiting" -> WAITING
            "error" -> ERROR
            "stopped" -> STOPPED
            else -> UNKNOWN
        }
    }
}

enum class ApprovalOption(val wire: String) {
    ALLOW("allow"), ALLOW_ALWAYS("allowAlways"), DENY("deny");

    companion object {
        fun of(raw: String): ApprovalOption? = entries.firstOrNull { it.wire == raw }
    }
}

data class QuestionOption(val label: String, val description: String? = null)

data class Question(
    val question: String,
    val header: String? = null,
    val multiSelect: Boolean = false,
    val options: List<QuestionOption>,
) {
    companion object {
        fun read(o: JsonObject) = Question(
            question = o.needStr("question"),
            header = o.str("header"),
            multiSelect = o.bool("multiSelect") ?: false,
            options = o.arr("options")?.lossy { e ->
                val x = e as JsonObject
                QuestionOption(x.needStr("label"), x.str("description"))
            } ?: emptyList(),
        )
    }
}

/** What a thread is stuck on: a tool wanting permission, questions, or a secret. */
sealed class PendingApproval {
    abstract val id: String

    data class Approval(
        override val id: String,
        val name: String,
        val title: String,
        val options: List<ApprovalOption>,
        val inputSummary: String?,
        /** On Claude's ExitPlanMode card: the seq of the plan row it waits on (backend API 72). */
        val planSeq: Int? = null,
        /** What made it ask, in a sentence (backend API 113): Auto's safety check, a rule, a hook. */
        val reason: String? = null,
    ) : PendingApproval()

    data class Questions(override val id: String, val questions: List<Question>) : PendingApproval()

    /** `key`: the runner's X25519 public key (base64) the value is sealed to. */
    data class Secret(
        override val id: String,
        val label: String,
        val reason: String,
        val placeholder: String?,
        val key: String,
    ) : PendingApproval()

    /** A kind this build doesn't know: answer it on the Mac. */
    data class Other(override val id: String, val kind: String) : PendingApproval()

    companion object {
        fun read(o: JsonObject): PendingApproval {
            val id = o.needStr("approvalId")
            return when (val kind = o.str("kind")) {
                "question" -> Questions(id, o.arr("questions")?.lossy { Question.read(it as JsonObject) } ?: throw BadRow("No questions"))
                "secret" -> {
                    val key = o.str("key") ?: return Other(id, "secret")
                    Secret(id, o.str("label") ?: "A secret", o.str("reason") ?: "", o.str("placeholder"), key)
                }
                null, "approval" -> Approval(
                    id = id,
                    name = o.str("name") ?: "",
                    title = o.str("title") ?: "Permission",
                    options = (o.strings("options") ?: listOf("allow", "deny")).mapNotNull(ApprovalOption::of),
                    inputSummary = o.str("inputSummary"),
                    planSeq = o.num("planSeq")?.wholeCount(),
                    reason = o.str("reason")?.takeIf { it.isNotBlank() },
                )
                else -> Other(id, kind)
            }
        }
    }
}

data class ProjectRef(val id: String, val title: String)

data class PhoneProjectIcon(val symbol: String? = null, val url: String? = null, val by: String? = null) {
    companion object {
        fun read(o: JsonObject) = PhoneProjectIcon(
            symbol = o.str("symbol")?.takeIf { it.isNotEmpty() },
            url = o.str("url")?.takeIf { it.startsWith("https://") || it.startsWith("http://") },
            by = o.str("by"),
        )
    }
}

data class PhoneProject(
    val id: String,
    val runnerId: String? = null,
    val title: String,
    val archived: Boolean? = null,
    val icon: PhoneProjectIcon? = null,
) {
    companion object {
        fun read(o: JsonObject) = PhoneProject(
            id = o.needStr("id"),
            runnerId = o.str("runnerId"),
            title = o.str("title") ?: "",
            archived = o.bool("archived"),
            icon = o.obj("icon")?.let(PhoneProjectIcon::read),
        )
    }
}

/**
 * The projects by runner and id. A project id is only its runner's own, and
 * another runner can use the same one, so a thread's project is looked up
 * under the thread's own runner (Daybreak finding 141), never by id alone.
 */
class ProjectsByRunner(projects: List<PhoneProject>) {
    private val byKey = projects.associateBy { key(it.runnerId ?: "", it.id) }

    /** The project `id` on the runner `runnerId`, if that runner has it. */
    fun find(runnerId: String, id: String): PhoneProject? = byKey[key(runnerId, id)]

    private fun key(runnerId: String, id: String) = "$runnerId\n$id"
}

/** "C" for "Convex docs", "7" for "7 day plan", "?" for neither. */
object ProjectMark {
    fun letter(title: String): String {
        val first = title.firstOrNull { it.isLetterOrDigit() } ?: return "?"
        return first.uppercase()
    }
}

data class Woke(val at: Instant, val since: Instant? = null)

data class StartedBy(val kind: String, val label: String, val icon: String? = null, val why: String? = null)

data class PhoneLink(val title: String, val url: String, val icon: String? = null) {
    /** Only http or https pages, never a file or another app. */
    val page: String?
        get() {
            val lower = url.lowercase()
            if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return null
            val host = url.substringAfter("://").substringBefore('/').substringBefore('?')
            return if (host.isEmpty()) null else url
        }
}

data class PhoneWaitingForRoom(val until: String, val accountId: String? = null)
data class PhoneWaitingForNetwork(val since: String)

data class PhoneAskLink(val title: String, val url: String)

data class PhoneThread(
    val threadId: String,
    val runnerId: String = "mac",
    val title: String,
    val cwd: String = "~/ThreadbearThreads",
    val accountId: String = "claude-main",
    val provider: String = "claude",
    val model: String? = null,
    val status: ThreadStatus = ThreadStatus.IDLE,
    val needsYou: Boolean = false,
    val unread: Boolean = false,
    val preview: String = "",
    val lastActivityAt: Instant,
    val snoozedUntil: Instant? = null,
    val snoozedUntilRestart: Boolean? = null,
    val wakeNote: String? = null,
    val woke: Woke? = null,
    val startedBy: StartedBy? = null,
    val asked: String? = null,
    val archivedAt: Instant? = null,
    val starredAt: Instant? = null,
    val coordinatorProjectId: String? = null,
    val costUsd: Double? = null,
    val projects: List<ProjectRef>? = null,
    val working: String? = null,
    val pendingApproval: PendingApproval? = null,
    val earliestSeq: Double? = null,
    val asks: List<PhoneAsk>? = null,
    val asksSeq: Double? = null,
    val next: List<String>? = null,
    val nextPick: String? = null,
    val nextSuggested: Double? = null,
    val needs: String? = null,
    val pendingReviews: Double? = null,
    val waitingForRoom: PhoneWaitingForRoom? = null,
    val waitingForNetwork: PhoneWaitingForNetwork? = null,
    val links: List<PhoneLink>? = null,
    /**
     * What the runner found still open on a thread whose last turn needs
     * nothing (backend API 73), for the done card's "Still open" or
     * "Coming back" list. Null when it hasn't checked, or an older runner.
     */
    val looseEnds: List<PhoneLooseEnd>? = null,
    /** Another lab's review of the last turn's change (backend API 76), drawn over that turn's reply. */
    val review: PhoneLabReview? = null,
    /** The turn the done card's fields (review, looseEnds) are from, as message rows name turns (API 76). */
    val cardTurn: String? = null,
    /** Its sharing by link (API 8), null for one never shared. */
    val share: PhoneShare? = null,
    /**
     * What it's waiting on, as the runner worked it out (WaitState.kt). Null
     * from a runner before 23 Nov 2026, which leaves the app's own rule.
     */
    val waitState: WaitState? = null,
    /** The usage pool id when on auto pool rotation (backend API 107). */
    val poolId: String? = null,
    /** Model actually running on this thread (backend API 107). */
    val modelInUse: String? = null,
    /** Explicit effort level set on this thread (backend API 107). */
    val effort: String? = null,
    /** Effective effort level in use on this thread (backend API 107). */
    val effortInUse: String? = null,
) {
    val id get() = threadId
    val isBusy get() = status == ThreadStatus.RUNNING || status == ThreadStatus.STARTING

    /** Whether the Done card follow-ups are mutually exclusive choices. */
    val nextPickOne: Boolean get() = nextPick == "one" && (next?.size ?: 0) > 1

    /** Validated 0-based index for `nextSuggested` when `nextPick == "one"`. */
    val nextSuggestedIndex: Int?
        get() {
            if (!nextPickOne) return null
            val idx = nextSuggested?.wholeCount() ?: return null
            return idx.takeIf { it < (next?.size ?: 0) }
        }

    /** A design review waits on Mike and the thread has finished working. */
    val reviewWaiting get() = waitState?.let { it == WaitState.REVIEW } ?: ((pendingReviews ?: 0.0) > 0 && !isBusy && working == null)

    /** The last turn ended asking Mike for something he hasn't done yet. */
    val waitingOnMike: Boolean
        get() {
            if (needs != "you") return false
            val asks = asks ?: emptyList()
            val open = asks.isEmpty() || asks.any { it.ticked != true }
            return waitState?.let { it == WaitState.NEEDS_YOU && open } ?: (!isBusy && open)
        }

    /**
     * Background work (a shell job, sub-agent or workflow) going with no turn
     * holding it up for Mike: the runner's job state, or, from an older
     * runner, any working line.
     */
    val jobGoing get() = waitState?.let { it == WaitState.JOB } ?: (working != null)

    fun hasEarlier(oldestSeq: Int?): Boolean {
        val earliest = earliestSeq ?: return false
        return oldestSeq != null && oldestSeq.toDouble() > earliest
    }

    val folderName: String
        get() {
            val trimmed = cwd.removeSuffix("/")
            return trimmed.split('/').lastOrNull { it.isNotEmpty() } ?: cwd
        }

    /** Line 2 of a row: the projects, or the folder. */
    val placeText: String
        get() = projects?.takeIf { it.isNotEmpty() }?.joinToString(", ") { it.title } ?: folderName

    companion object {
        fun read(o: JsonObject): PhoneThread = PhoneThread(
            threadId = o.needStr("threadId"),
            runnerId = o.needStr("runnerId"),
            title = o.needStr("title"),
            cwd = o.needStr("cwd"),
            accountId = o.needStr("accountId"),
            provider = o.needStr("provider"),
            model = o.str("model"),
            status = ThreadStatus.of(o.needStr("status")),
            needsYou = o.needBool("needsYou"),
            unread = o.needBool("unread"),
            preview = o.needStr("preview"),
            lastActivityAt = o.needDate("lastActivityAt"),
            snoozedUntil = o.date("snoozedUntil"),
            snoozedUntilRestart = o.bool("snoozedUntilRestart"),
            wakeNote = o.str("wakeNote"),
            woke = o.obj("woke")?.let { w -> w.date("at")?.let { Woke(it, w.date("since")) } },
            startedBy = o.obj("startedBy")?.let { s ->
                val kind = s.str("kind") ?: return@let null
                StartedBy(kind, s.str("label") ?: "", s.str("icon"), s.str("why"))
            },
            asked = o.str("asked"),
            archivedAt = o.date("archivedAt"),
            starredAt = o.date("starredAt"),
            coordinatorProjectId = o.str("coordinatorProjectId")?.takeIf { it.isNotBlank() },
            costUsd = o.num("costUsd"),
            projects = o.arr("projects")?.lossy { val p = it as JsonObject; ProjectRef(p.needStr("id"), p.needStr("title")) },
            working = o.str("working"),
            pendingApproval = o.obj("pendingApproval")?.let { runCatching { PendingApproval.read(it) }.getOrNull() },
            earliestSeq = o.num("earliestSeq"),
            asks = o.arr("asks")?.lossy { PhoneAsk.read(it as JsonObject) },
            asksSeq = o.num("asksSeq"),
            next = o.strings("next"),
            nextPick = o.str("nextPick"),
            nextSuggested = o.num("nextSuggested"),
            needs = o.str("needs"),
            pendingReviews = o.num("pendingReviews"),
            waitingForRoom = o.obj("waitingForRoom")?.let { w -> w.str("until")?.let { PhoneWaitingForRoom(it, w.str("accountId")) } },
            waitingForNetwork = o.obj("waitingForNetwork")?.let { w -> w.str("since")?.let { PhoneWaitingForNetwork(it) } },
            links = o.arr("links")?.lossy { val l = it as JsonObject; PhoneLink(l.needStr("title"), l.needStr("url"), l.str("icon")) },
            looseEnds = o.arr("looseEnds")?.lossy { PhoneLooseEnd.read(it as JsonObject) },
            // Lenient field by field: a ledger in a shape this phone doesn't know never stops the thread loading.
            review = o.obj("review")?.let { runCatching { PhoneLabReview.read(it) }.getOrNull() },
            cardTurn = o.str("cardTurn"),
            share = PhoneShare.read(o.obj("share")),
            waitState = WaitState.of(o.str("waitState")),
            poolId = o.str("poolId"),
            modelInUse = o.str("modelInUse"),
            effort = o.str("effort"),
            effortInUse = o.str("effortInUse"),
        )
    }
}

/** One thing a turn needs from Mike, from its end_turn. */
data class PhoneAsk(
    val action: String,
    val why: String? = null,
    val reply: String? = null,
    val options: List<String>? = null,
    val optionNotes: List<String>? = null,
    val suggested: Double? = null,
    val links: List<PhoneAskLink>? = null,
    val ticked: Boolean? = null,
) {
    /** What to pick from: its options, else the reply it wants ("done"). */
    val choices: List<String>
        get() {
            options?.takeIf { it.isNotEmpty() }?.let { return it }
            val r = reply?.trim()
            return if (r.isNullOrEmpty()) emptyList() else listOf(r)
        }

    /** What choosing `choice` does, only when there's a note for each option. */
    fun note(choice: Int): String? {
        val opts = options?.takeIf { it.isNotEmpty() } ?: return null
        val notes = optionNotes ?: return null
        if (notes.size != opts.size || choice !in notes.indices) return null
        return notes[choice].trim().ifEmpty { null }
    }

    val hasNotes get() = choices.indices.any { note(it) != null }

    val suggestedIndex: Int? get() = suggested?.wholeCount()

    /** The action on one line, a full stop if needed, then the why. */
    val paragraph: String
        get() {
            val line = action.split('\n').map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" ")
            val why = (why ?: "").trim()
            if (why.isEmpty()) return line
            val last = line.lastOrNull { it !in "\"'”’)]*_`" }
            val ends = last != null && last in ".?!…:"
            return (if (ends) line else "$line.") + " " + why
        }

    companion object {
        fun read(o: JsonObject) = PhoneAsk(
            action = o.needStr("action"),
            why = o.str("why"),
            reply = o.str("reply"),
            options = o.strings("options"),
            optionNotes = o.strings("optionNotes"),
            suggested = o.num("suggested"),
            links = o.arr("links")?.lossy { val l = it as JsonObject; PhoneAskLink(l.needStr("title"), l.needStr("url")) },
            ticked = o.bool("ticked"),
        )
    }
}

data class WokeTask(val kind: String, val description: String)

data class MessageButton(
    val id: String,
    val title: String,
    val kind: String,
    val target: String? = null,
    val pressedThreadId: String? = null,
    val failed: String? = null,
)

/**
 * `TOOL` is one line for a tool call (backend API 2). `NOTE` is the line a
 * thread writes when its login runs out and it moves to another or waits
 * for room, or a stopped message is saved (backend API 79, asked for with
 * `notes`): a quiet line of its own, never part of a turn's work.
 */
enum class Role { USER, ASSISTANT, TOOL, NOTE }

data class PhoneMessage(
    val seq: Int,
    val role: Role,
    val text: String,
    val origin: String? = null,
    val toolKind: String? = null,
    val summary: Boolean = false,
    val turn: String? = null,
    val wokeBy: List<WokeTask>? = null,
    val buttons: List<MessageButton>? = null,
    val at: Instant,
    /** A Plan first plan in full (backend API 72): drawn as a plan card, never folded into the turn's working. */
    val plan: Boolean = false,
    /** Why the runner sent its own message, in a few words (backend API 98): "Codex answered". */
    val wakeReason: String? = null,
) {
    companion object {
        fun read(o: JsonObject): PhoneMessage = PhoneMessage(
            // Convex numbers are float64, so seq comes back as 12.0.
            seq = o.needNum("seq").wholeCount() ?: throw BadRow("Not a seq"),
            role = when (o.needStr("role")) {
                "user" -> Role.USER
                "assistant" -> Role.ASSISTANT
                "tool" -> Role.TOOL
                "note" -> Role.NOTE
                else -> throw BadRow("Unknown role")
            },
            text = o.needStr("text"),
            origin = o.str("origin"),
            toolKind = o.str("toolKind"),
            summary = o.bool("summary") ?: false,
            turn = o.str("turn"),
            wokeBy = o.arr("wokeBy")?.lossy { val w = it as JsonObject; WokeTask(w.needStr("kind"), w.str("description") ?: "") },
            buttons = o.arr("buttons")?.lossy { val b = it as JsonObject
                MessageButton(b.needStr("id"), b.needStr("title"), b.needStr("kind"), b.str("target"), b.str("pressedThreadId"), b.str("failed"))
            },
            at = o.needDate("at"),
            plan = o.bool("plan") ?: false,
            wakeReason = o.str("wakeReason"),
        )
    }
}

data class MessageImage(
    val seq: Int,
    val src: String? = null,
    val pinned: Boolean? = null,
    val url: String,
    val width: Int? = null,
    val height: Int? = null,
    /** What it is (API 95): text/html for a live page, which this app doesn't run yet. */
    val mediaType: String? = null,
) {
    /** A live page an agent showed in its reply (the livePages experiment). */
    val isPage: Boolean get() = mediaType == "text/html"

    companion object {
        fun read(o: JsonObject) = MessageImage(
            seq = o.needNum("seq").wholeCount() ?: throw BadRow("Not a seq"),
            src = o.str("src"),
            pinned = o.bool("pinned"),
            url = o.needStr("url"),
            width = o.num("width")?.wholeCount(),
            height = o.num("height")?.wholeCount(),
            mediaType = o.str("mediaType"),
        )
    }
}

data class MessagePage(val messages: List<PhoneMessage>, val hasMore: Boolean, val images: List<MessageImage> = emptyList()) {
    companion object {
        fun read(o: JsonObject) = MessagePage(
            messages = o.arr("messages")?.lossy { PhoneMessage.read(it as JsonObject) } ?: throw BadRow("No messages"),
            hasMore = o.needBool("hasMore"),
            images = o.arr("images")?.lossy { MessageImage.read(it as JsonObject) } ?: emptyList(),
        )
    }
}

data class ThreadDetail(val thread: PhoneThread, val messages: List<PhoneMessage>) {
    companion object {
        fun read(o: JsonObject) = ThreadDetail(
            thread = PhoneThread.read(o.obj("thread") ?: throw BadRow("No thread")),
            messages = o.arr("messages")?.lossy { PhoneMessage.read(it as JsonObject) } ?: emptyList(),
        )
    }
}

data class PhoneRunner(
    val runnerId: String,
    val name: String,
    val version: String? = null,
    val lastSeenAt: Instant,
    val draining: Boolean? = null,
    val placed: Boolean? = null,
    val main: Boolean? = null,
    /** Usage pools configured on this runner (backend API 107). */
    val usagePools: List<PhoneUsagePool>? = null,
    /** Default pool, login, models and efforts on this runner (backend API 107). */
    val defaults: PhoneRunnerDefaults? = null,
) {
    fun isOnline(now: Instant): Boolean = now.toEpochMilli() - lastSeenAt.toEpochMilli() < OFFLINE_AFTER_MS

    companion object {
        /** A heartbeat every 60 s; three missed is offline. */
        const val OFFLINE_AFTER_MS = 180_000L

        fun read(o: JsonObject) = PhoneRunner(
            runnerId = o.needStr("runnerId"),
            name = o.needStr("name"),
            version = o.str("version"),
            lastSeenAt = o.needDate("lastSeenAt"),
            draining = o.bool("draining"),
            placed = o.bool("placed"),
            main = o.bool("main"),
            usagePools = o.arr("usagePools")?.lossy { PhoneUsagePool.read(it as JsonObject) },
            defaults = o.obj("defaults")?.let { runCatching { PhoneRunnerDefaults.read(it) }.getOrNull() },
        )
    }
}

/** phone:me's answer. `site` is the website's address, from a backend that says it (ShareLinks.site). */
data class PhoneIdentity(val name: String, val expiresAt: Instant?, val apiVersion: Int? = null, val pushOff: Boolean? = null, val site: String? = null) {
    val sendsNotifications get() = pushOff != true

    companion object {
        fun read(o: JsonObject) = PhoneIdentity(
            name = o.needStr("name"),
            expiresAt = o.date("expiresAt"),
            apiVersion = o.num("apiVersion")?.wholeCount(),
            pushOff = o.bool("pushOff"),
            site = o.str("site"),
        )
    }
}

/** What the app relies on from the backend (BackendCompatibility). */
object BackendApi {
    const val MESSAGE_PAGES = 2
    const val ASKS = 14
    const val SECRETS = 35
    const val ARCHIVE_VERDICT = 42
    const val THREAD_CHANGES = 43
    const val WAKES = 45
    const val WAITING_SENDS = 57
    const val STOP = 69
    const val STARS = 27
    /** From 8 a thread can be shared by link from the phone (phone:share). */
    const val SHARING = 8
    /** From 3 each phone chooses when it's notified (phone:setNotifications). */
    const val NOTIFICATION_SETTING = 3
    /** From 16 phone:search looks through archived threads past the newest 100. */
    const val SEARCH = 16
    /** From 19 agents file cards in the Pocket (phone:pocket). */
    const val POCKET = 19
    /** From 56 runners have an order (phone:setRunnerOrder). */
    const val RUNNER_ORDER = 56
    /** A message or new thread can carry photos (phone:imageUploadUrl). */
    const val PHOTOS = 18
    /** Accounts carry their models and phone:create takes an effort. */
    const val MODELS = 20
    const val IMAGES = 37
    const val BUTTONS = 59
    const val SLASH_COMMANDS = 62
    const val PLANS = 72
    /** From 79 phone:messages gives a login's notes to an app that asks (`notes`). */
    const val LOGIN_NOTES = 79
    /**
     * From 93 a phone can register a Web Push endpoint (platform "webpush",
     * phone:webPushKey for the VAPID key): the fdroid build's UnifiedPush.
     */
    const val WEB_PUSH = 93
    /**
     * From 86 phone:designReviews and phone:respondReview read and answer a
     * thread's design reviews through its runner, and phone:reviewImages
     * follows their stills. Older backends: a review opens on the Mac.
     */
    const val DESIGN_REVIEWS = 86
    /**
     * From 106 a review's shots carry the agent's marks and their video or
     * sound, and phone:respondReview takes the phone's own marks.
     */
    const val REVIEW_MARKS = 106
    /** From 107 the desktop-twin model picker (pools, usage, defaults, existing-thread settings). */
    const val MOBILE_PICKER = 107
}

enum class CommandState { PENDING, TAKEN, DONE, FAILED }

data class CommandStatus(
    val state: CommandState,
    val note: String? = null,
    val threadId: String? = null,
    /** A slashCommands command's answer (API 62): phone:command's `result`. Anything that isn't a list of commands reads as none. */
    val commands: List<SlashCommand>? = null,
    /** A designReviews command's answer (API 86), from the same `result`. */
    val designReviews: DesignReviewResult? = null,
) {
    companion object {
        fun read(o: JsonObject) = CommandStatus(
            state = when (o.needStr("state")) {
                "pending" -> CommandState.PENDING
                "taken" -> CommandState.TAKEN
                "done" -> CommandState.DONE
                "failed" -> CommandState.FAILED
                else -> throw BadRow("Unknown state")
            },
            note = o.str("note"),
            threadId = o.str("threadId"),
            commands = o.arr("result")?.let { list ->
                runCatching { list.map { SlashCommand.read(it as JsonObject) } }.getOrNull()
            },
            designReviews = DesignReviewResult.fromResult(o["result"]),
        )
    }
}

data class PhoneCounts(val hibernating: Int, val den: Int) {
    companion object {
        fun read(o: JsonObject) = PhoneCounts(o.num("hibernating")?.wholeCount() ?: 0, o.num("den")?.wholeCount() ?: 0)
    }
}

/** A row of phone:wakes: an active schedule and the thread it messages. */
data class ScheduleWake(val scheduleId: String, val threadId: String?, val nextRunAt: Instant?) {
    companion object {
        fun read(o: JsonObject) = ScheduleWake(o.needStr("scheduleId"), o.str("threadId"), o.date("nextRunAt"))
    }
}

enum class ThreadsView(val wire: String) { INBOX("inbox"), HIBERNATING("hibernating"), DEN("den") }

enum class ArchiveVerdict(val wire: String) { WORKED("worked"), DIDNT_WORK("didntWork"), NOT_NEEDED("notNeeded") }

/** Three-state patch field for thread settings updates (API 107). */
sealed interface SettingsField {
    data object Keep : SettingsField
    data object Clear : SettingsField
    data class Set(val value: String) : SettingsField
}

/** Settings patch sent via phone:update (API 107). */
data class ThreadSettingsChange(
    val accountId: String? = null,
    val poolId: SettingsField = SettingsField.Keep,
    val provider: String? = null,
    val model: SettingsField = SettingsField.Keep,
    val effort: SettingsField = SettingsField.Keep,
) {
    val isEmpty: Boolean
        get() = accountId == null && poolId == SettingsField.Keep && provider == null && model == SettingsField.Keep && effort == SettingsField.Keep

    val json: JsonObject
        get() = buildJsonObject {
            accountId?.let { put("accountId", it) }
            when (poolId) {
                SettingsField.Keep -> {}
                SettingsField.Clear -> put("poolId", JsonNull)
                is SettingsField.Set -> put("poolId", poolId.value)
            }
            provider?.let { put("provider", it) }
            when (model) {
                SettingsField.Keep -> {}
                SettingsField.Clear -> put("model", JsonNull)
                is SettingsField.Set -> put("model", model.value)
            }
            when (effort) {
                SettingsField.Keep -> {}
                SettingsField.Clear -> put("effort", JsonNull)
                is SettingsField.Set -> put("effort", effort.value)
            }
        }
}

sealed class ThreadChange {
    data class Snooze(val until: Instant) : ThreadChange()
    data object SnoozeUntilRestart : ThreadChange()
    data object Wake : ThreadChange()
    data object Archive : ThreadChange()
    data class ArchiveWithVerdict(val verdict: ArchiveVerdict) : ThreadChange()
    data object Unarchive : ThreadChange()
    data object MarkSeen : ThreadChange()
    data class Rename(val title: String) : ThreadChange()
    data class Star(val on: Boolean) : ThreadChange()
    data class Settings(val settings: ThreadSettingsChange) : ThreadChange()

    val json: JsonElement
        get() = when (this) {
            is Snooze -> buildJsonObject { put("snooze", buildJsonObject { put("until", until.toString()) }) }
            SnoozeUntilRestart -> buildJsonObject { put("snooze", buildJsonObject { put("untilRestart", true) }) }
            Wake -> buildJsonObject { put("wake", true) }
            Archive -> buildJsonObject { put("archive", true) }
            is ArchiveWithVerdict -> buildJsonObject { put("archive", true); put("verdict", verdict.wire) }
            Unarchive -> buildJsonObject { put("unarchive", true) }
            MarkSeen -> buildJsonObject { put("markSeen", true) }
            is Rename -> buildJsonObject { put("title", title) }
            is Star -> buildJsonObject { put("star", on) }
            is Settings -> settings.json
        }
}

/** phone:waiting: a message from the phone the runner hasn't applied yet. */
data class WaitingSend(
    val commandId: String,
    val state: CommandState,
    val text: String,
    val photos: Int = 0,
    val createdAt: Double,
) {
    val id get() = commandId
    val canCancel get() = state == CommandState.PENDING

    companion object {
        fun read(o: JsonObject) = WaitingSend(
            commandId = o.needStr("commandId"),
            state = CommandStatus.read(o).state,
            text = o.needStr("text"),
            photos = o.num("photos")?.wholeCount() ?: 0,
            createdAt = o.needNum("createdAt"),
        )
    }
}

internal fun JsonPrimitive.stringOrNull(): String? = if (isString) content else null
