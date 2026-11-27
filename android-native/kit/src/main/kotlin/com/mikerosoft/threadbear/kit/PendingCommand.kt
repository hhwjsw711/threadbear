package com.mikerosoft.threadbear.kit

/**
 * One command this phone sends a runner and waits on (an archive, a star, a
 * reply button, a card's answer, Stop), from the tap to the runner saying how
 * it went, as one state machine: every move is in [step], and
 * [PendingCommands] (the watcher) only feeds it events. The iPhone's kit has
 * the same type (PendingCommand.swift) and the website the same machine
 * (web/src/command.ts); shared/cases/pending-commands.json keeps all three in
 * step and says where they differ.
 *
 *     Idle -tap-> Sending -sent-> Queued -row taken-> Taken -row done-> Done -settle-> Idle
 *                   |               |                  `-row failed-> Failed
 *                   `-sendFailed-> Failed
 *     Sending, Queued and Taken time out when nothing is heard in
 *     [DEADLINE_MS]: still listening, so a late answer lands, but the control
 *     takes taps again (that's its dismiss).
 *
 * Times are epoch milliseconds.
 */
sealed interface PendingCommand {
    /** The backend's id for it, once it has one. */
    val id: String?

    data object Idle : PendingCommand {
        override val id: String? get() = null
    }
    /** The mutation hasn't answered yet. */
    data class Sending(val since: Long) : PendingCommand {
        override val id: String? get() = null
    }
    /** The backend has it; its runner hasn't taken it. */
    data class Queued(override val id: String, val since: Long) : PendingCommand
    /** Its runner has it and hasn't said how it went. */
    data class Taken(override val id: String, val since: Long) : PendingCommand
    /** The runner did it; [result] is phone:command's answer (null once it's gone from the backend). */
    data class Done(override val id: String, val result: CommandStatus?) : PendingCommand
    /** The mutation threw, or the runner refused it; [reason] is null when it said nothing. */
    data class Failed(override val id: String?, val reason: String?) : PendingCommand
    /** Nothing heard in time: the Mac's asleep or offline, or this phone is. Still listening. */
    data class TimedOut(override val id: String?, val taken: Boolean) : PendingCommand

    sealed interface Event {
        data class Tap(val at: Long) : Event
        /** The mutation answered with the command's id. */
        data class Sent(val id: String, val at: Long) : Event
        /** The mutation threw. */
        data class SendFailed(val reason: String) : Event
        /** phone:command's answer changed; null once the command's gone from the backend. */
        data class Row(val row: CommandStatus?, val at: Long) : Event
        /** The clock. */
        data class Deadline(val at: Long) : Event
        /** The connection dropped and came back: nothing could be heard meanwhile. */
        data class Reconnected(val at: Long) : Event
        /** The backend took it back (phone:cancel said yes). */
        data object Cancelled : Event
        /** A moment after done: the row it changed has caught up. */
        data object Settle : Event
    }

    /** The one place a command moves. An event that doesn't apply where it is changes nothing. */
    fun step(event: Event, deadlineMs: Long = DEADLINE_MS): PendingCommand = when (event) {
        is Event.Tap -> when (this) {
            Idle, is Failed, is TimedOut -> Sending(event.at)
            is Sending, is Queued, is Taken, is Done -> this
        }
        is Event.Sent -> when (this) {
            is Sending -> Queued(event.id, event.at)
            is TimedOut -> if (id == null) Queued(event.id, event.at) else this
            Idle, is Queued, is Taken, is Done, is Failed -> this
        }
        is Event.SendFailed -> when (this) {
            is Sending -> Failed(null, event.reason)
            is TimedOut -> if (id == null) Failed(null, event.reason) else this
            Idle, is Queued, is Taken, is Done, is Failed -> this
        }
        is Event.Row -> {
            val (id, taken) = when (this) {
                is Queued -> id to false
                is Taken -> id to true
                is TimedOut -> (id ?: return this) to taken
                Idle, is Sending, is Done, is Failed -> return this
            }
            val row = event.row
            when (row?.state) {
                null -> Done(id, null)
                CommandState.DONE -> Done(id, row)
                CommandState.FAILED -> Failed(id, row.note)
                // Taken is news: the runner is awake, so the clock starts again.
                CommandState.TAKEN -> if (taken) this else Taken(id, event.at)
                CommandState.PENDING -> this
            }
        }
        is Event.Deadline -> when (this) {
            is Sending -> if (event.at - since >= deadlineMs) TimedOut(null, false) else this
            is Queued -> if (event.at - since >= deadlineMs) TimedOut(id, false) else this
            is Taken -> if (event.at - since >= deadlineMs) TimedOut(id, true) else this
            Idle, is Done, is Failed, is TimedOut -> this
        }
        is Event.Reconnected -> when (this) {
            is Queued -> Queued(id, event.at)
            is Taken -> Taken(id, event.at)
            Idle, is Sending, is Done, is Failed, is TimedOut -> this
        }
        Event.Cancelled -> when (this) {
            is Sending, is Queued, is Taken, is TimedOut -> Failed(id, CANCELLED)
            Idle, is Done, is Failed -> this
        }
        Event.Settle -> when (this) {
            is Done -> Idle
            Idle, is Sending, is Queued, is Taken, is Failed, is TimedOut -> this
        }
    }

    /** While the control takes no taps: on its way, or just done and waiting for the row it changed. */
    val locked: Boolean get() = when (this) {
        is Sending, is Queued, is Taken, is Done -> true
        Idle, is Failed, is TimedOut -> false
    }

    /**
     * While a change made at once on the screen should stay made: all but
     * nothing sent, a failure, and a send that timed out before the backend
     * had it (it may never have gone), which put it back.
     */
    val holdsChange: Boolean get() = when (this) {
        is Sending, is Queued, is Taken, is Done -> true
        is TimedOut -> id != null
        Idle, is Failed -> false
    }

    /** Done or failed: nothing more moves it but a settle or a tap. */
    val finished: Boolean get() = when (this) {
        is Done, is Failed -> true
        Idle, is Sending, is Queued, is Taken, is TimedOut -> false
    }

    /** Still to hear how it went. */
    val waiting: Boolean get() = when (this) {
        is Sending, is Queued, is Taken, is TimedOut -> true
        Idle, is Done, is Failed -> false
    }

    /** When the clock should next look, or null for nothing timing. */
    fun deadlineAt(deadlineMs: Long = DEADLINE_MS): Long? = when (this) {
        is Sending -> since + deadlineMs
        is Queued -> since + deadlineMs
        is Taken -> since + deadlineMs
        Idle, is Done, is Failed, is TimedOut -> null
    }

    /** The failure's words, with the control's own when it said none; null unless it failed (a cancel isn't worth saying). */
    fun failure(fallback: String): String? =
        if (this is Failed && reason != CANCELLED) reason?.takeIf { it.isNotBlank() } ?: fallback else null

    /** The line a control that's timed out shows: where it's got to. */
    val timedOutNote: String? get() = when (this) {
        is TimedOut -> when {
            id == null -> "The phone couldn't reach Threadbear's server. Try again."
            taken -> "The Mac has this but hasn't said how it went yet."
            else -> "The Mac hasn't picked this up. It may be asleep or offline; it runs when the Mac is back."
        }
        Idle, is Sending, is Queued, is Taken, is Done, is Failed -> null
    }

    companion object {
        /** The runner takes a command within a second or two while it's online (web's COMMAND_SLOW_MS). */
        const val DEADLINE_MS = 20_000L
        /** What a cancelled command's failure says (the backend's own note too). */
        const val CANCELLED = "Cancelled"
    }
}

/** What a pending command is about, so there's one of each at a time (CommandKey in the iPhone's kit). */
sealed interface CommandKey {
    data class Archive(val threadId: String) : CommandKey
    data class Hibernate(val threadId: String) : CommandKey
    data class Rename(val threadId: String) : CommandKey
    data class Star(val threadId: String) : CommandKey
    data class Wake(val threadId: String) : CommandKey
    data class MarkSeen(val threadId: String) : CommandKey
    data class Unarchive(val threadId: String) : CommandKey
    data class Stop(val threadId: String) : CommandKey
    data class Press(val threadId: String, val buttonId: String) : CommandKey
    /** Sharing by link: on, off or a new link (its value is a ShareAsk's). */
    data class Share(val threadId: String) : CommandKey
    /** Model, effort, pool or login change on an existing thread (API 107). */
    data class Settings(val threadId: String) : CommandKey
    /** An approval, question or secret card, by its approval id. */
    data class Card(val approvalId: String) : CommandKey
    /** Loading or answering one of the thread's design reviews. */
    data class Review(val threadId: String) : CommandKey
}
