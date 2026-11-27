package com.mikerosoft.threadbear.kit

import java.io.File
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * The rows the backend's phone API returns, decoded by this kit's models
 * (shared/cases/wire-rows.json). The iPhone decodes the same samples
 * (WireRowsTests.swift), so a field one app reads and the other doesn't is
 * written down there as a difference, not found by a user.
 */
class WireRowsTest {
    @Test fun theSharedCases() {
        val file = File("../../shared/cases/wire-rows.json")
        val cases = (parseJson(file.readText()) as JsonObject).arr("cases")!!
        assertTrue(cases.size >= 20)
        val problems = mutableListOf<String>()
        for (c in cases) {
            val o = c as JsonObject
            val name = o.str("name")!!
            if (o.obj("differs")?.containsKey("android") == true) continue
            val input = o.obj("input")!!
            val fields = try {
                fields(input.str("kind")!!, input.obj("row")!!)
            } catch (e: Exception) {
                problems += "$name: $e"
                continue
            }
            for ((path, want) in o.obj("expect")!!) {
                if (!fields.containsKey(path)) {
                    problems += "$name: Android doesn't read ${input.str("kind")} $path"
                    continue
                }
                val got = fields[path]
                if (plain(want) != got) problems += "$name: $path is $got, not ${plain(want)}"
            }
        }
        if (problems.isNotEmpty()) fail(problems.joinToString("\n"))
    }

    // A JSON value as the fields below give theirs: a String, a Double, a Boolean or null.
    private fun plain(e: JsonElement): Any? = when {
        e is JsonNull -> null
        e is JsonPrimitive && e.isString -> e.content
        e is JsonPrimitive -> e.booleanOrNull ?: e.doubleOrNull
        else -> e.toString()
    }

    private fun fields(kind: String, row: JsonObject): Map<String, Any?> = when (kind) {
        "thread" -> thread(PhoneThread.read(row))
        "message" -> message(PhoneMessage.read(row))
        "page" -> MessagePage.read(row).let { p ->
            mutableMapOf<String, Any?>("hasMore" to p.hasMore).also {
                it.putAll(under("messages", list(p.messages, ::message)))
                it.putAll(under("images", list(p.images) { i ->
                    mapOf("seq" to n(i.seq), "src" to i.src, "pinned" to i.pinned, "url" to i.url, "width" to n(i.width), "height" to n(i.height), "mediaType" to i.mediaType)
                }))
            }
        }
        "detail" -> ThreadDetail.read(row).let { d -> under("thread", thread(d.thread)) + under("messages", list(d.messages, ::message)) }
        "runner" -> PhoneRunner.read(row).let { r ->
            mutableMapOf<String, Any?>(
                "runnerId" to r.runnerId, "name" to r.name, "version" to r.version, "lastSeenAt" to ms(r.lastSeenAt),
                "draining" to r.draining, "placed" to r.placed, "main" to r.main,
            ).also { m ->
                m += under("usagePools", list(r.usagePools) { p ->
                    mapOf("id" to p.id, "title" to p.title) + under("accountIds", list(p.accountIds) { mapOf("" to it) })
                })
                r.defaults?.let { d ->
                    m["defaults.poolId"] = d.poolId
                    m["defaults.accountId"] = d.accountId
                    d.models?.forEach { (k, v) -> m["defaults.models.$k"] = v }
                    d.efforts?.forEach { (k, v) -> m["defaults.efforts.$k"] = v }
                }
            }
        }
        "identity" -> PhoneIdentity.read(row).let { i -> mapOf("name" to i.name, "expiresAt" to ms(i.expiresAt), "apiVersion" to n(i.apiVersion), "pushOff" to i.pushOff) }
        "project" -> PhoneProject.read(row).let { p ->
            mapOf("id" to p.id, "runnerId" to p.runnerId, "title" to p.title, "archived" to p.archived, "icon.symbol" to p.icon?.symbol, "icon.url" to p.icon?.url, "icon.by" to p.icon?.by)
        }
        "counts" -> PhoneCounts.read(row).let { c -> mapOf("hibernating" to n(c.hibernating), "den" to n(c.den)) }
        "command" -> CommandStatus.read(row).let { c ->
            mapOf("state" to c.state.name.lowercase(), "note" to c.note, "threadId" to c.threadId) +
                under("commands", list(c.commands) { x -> mapOf("name" to x.name, "source" to x.source) })
        }
        "waiting" -> WaitingSend.read(row).let { w ->
            mapOf("commandId" to w.commandId, "state" to w.state.name.lowercase(), "text" to w.text, "photos" to n(w.photos), "createdAt" to w.createdAt)
        }
        "pocket" -> PocketCard.read(row).let { p ->
            mapOf("id" to p.id, "title" to p.title, "text" to p.text, "place" to p.place, "icon" to p.icon, "threadId" to p.threadId, "source" to p.source, "updatedAt" to p.updatedAt)
        }
        "account" -> PhoneAccount.read(row).let { a ->
            mutableMapOf<String, Any?>(
                "id" to a.id, "runnerId" to a.runnerId, "provider" to a.provider, "title" to a.title,
                "note" to a.note, "email" to a.email, "plan" to a.plan,
                "defaultModel" to a.defaultModel, "defaultEffort" to a.defaultEffort,
                "signedOut" to a.signedOut, "planEnded" to a.planEnded,
            ).also { m ->
                a.usage?.let { u ->
                    m += under("usage.windows", list(u.windows) { w ->
                        mapOf("kind" to w.kind, "title" to w.title, "remainingPercent" to w.remainingPercent, "resetsAt" to ms(w.resetsAt))
                    })
                }
                m += under("models", list(a.models) { mod ->
                    mapOf("id" to mod.id, "model" to mod.model, "title" to mod.title, "description" to mod.description, "defaultEffort" to mod.defaultEffort) +
                        under("effortLevels", list(mod.effortLevels) { mapOf("" to it) })
                })
            }
        }
        "wake" -> ScheduleWake.read(row).let { w -> mapOf("scheduleId" to w.scheduleId, "threadId" to w.threadId, "nextRunAt" to ms(w.nextRunAt)) }
        else -> fail("no row kind $kind")
    }

    private fun thread(t: PhoneThread): Map<String, Any?> {
        val f = mutableMapOf<String, Any?>(
            "threadId" to t.threadId, "runnerId" to t.runnerId, "title" to t.title, "cwd" to t.cwd, "accountId" to t.accountId,
            "provider" to t.provider, "poolId" to t.poolId,
            "model" to t.model, "modelInUse" to t.modelInUse, "effort" to t.effort, "effortInUse" to t.effortInUse,
            "status" to t.status.name.lowercase(), "needsYou" to t.needsYou,
            "unread" to t.unread, "preview" to t.preview, "lastActivityAt" to ms(t.lastActivityAt), "snoozedUntil" to ms(t.snoozedUntil),
            "snoozedUntilRestart" to t.snoozedUntilRestart, "wakeNote" to t.wakeNote, "woke.at" to ms(t.woke?.at), "woke.since" to ms(t.woke?.since),
            "startedBy.kind" to t.startedBy?.kind, "startedBy.label" to t.startedBy?.label, "startedBy.icon" to t.startedBy?.icon,
            "startedBy.why" to t.startedBy?.why, "asked" to t.asked, "archivedAt" to ms(t.archivedAt), "starredAt" to ms(t.starredAt),
            "costUsd" to t.costUsd, "working" to t.working, "earliestSeq" to t.earliestSeq, "asksSeq" to t.asksSeq, "needs" to t.needs,
            "pendingReviews" to t.pendingReviews, "waitingForRoom.until" to t.waitingForRoom?.until,
            "waitingForRoom.accountId" to t.waitingForRoom?.accountId, "waitingForNetwork.since" to t.waitingForNetwork?.since,
        )
        f += under("projects", list(t.projects) { mapOf("id" to it.id, "title" to it.title) })
        f += under("next", list(t.next) { mapOf("" to it) })
        f["nextPick"] = t.nextPick
        f["nextSuggested"] = t.nextSuggested
        f += under("links", list(t.links) { mapOf("title" to it.title, "url" to it.url, "icon" to it.icon) })
        f["cardTurn"] = t.cardTurn
        f += under("looseEnds", list(t.looseEnds) { mapOf("kind" to it.kind, "text" to it.text, "threadId" to it.threadId, "at" to it.at) })
        t.review?.let { r ->
            f += under("review", mapOf(
                "reviewer" to r.reviewer, "independent" to r.independent, "rounds" to n(r.rounds), "threadId" to r.threadId, "passed" to r.passed,
                "unstructured" to r.unstructured, "unchecked" to r.unchecked,
            ) + under("findings", list(r.findings) { x ->
                mapOf("id" to n(x.id), "severity" to x.severity, "claim" to x.claim, "where" to x.where, "outcome" to x.outcome, "note" to x.note)
            }))
        }
        f += under("asks", list(t.asks) { a ->
            mapOf("action" to a.action, "why" to a.why, "suggested" to a.suggested, "ticked" to a.ticked) +
                under("options", list(a.options) { mapOf("" to it) }) +
                under("optionNotes", list(a.optionNotes) { mapOf("" to it) }) +
                under("links", list(a.links) { mapOf("title" to it.title, "url" to it.url) })
        })
        t.pendingApproval?.let { p ->
            val a = mutableMapOf<String, Any?>("id" to p.id)
            when (p) {
                is PendingApproval.Approval -> {
                    a["kind"] = "approval"
                    a["planSeq"] = n(p.planSeq)
                    a += under("options", list(p.options) { mapOf("" to it.wire) })
                }
                is PendingApproval.Questions -> {
                    a["kind"] = "question"
                    a += under("questions", list(p.questions) { q -> mapOf("question" to q.question) + under("options", list(q.options) { mapOf("label" to it.label) }) })
                }
                is PendingApproval.Secret -> a["kind"] = "secret"
                is PendingApproval.Other -> a["kind"] = "other:" + p.kind
            }
            f += under("pendingApproval", a)
        }
        return f
    }

    private fun message(m: PhoneMessage): Map<String, Any?> =
        mapOf(
            "seq" to n(m.seq), "role" to m.role.name.lowercase(), "text" to m.text, "origin" to m.origin, "toolKind" to m.toolKind,
            "summary" to m.summary, "plan" to m.plan, "turn" to m.turn, "at" to ms(m.at),
            "wakeReason" to m.wakeReason,
        ) +
            under("wokeBy", list(m.wokeBy) { mapOf("kind" to it.kind, "description" to it.description) }) +
            under("buttons", list(m.buttons) { b ->
                mapOf("id" to b.id, "title" to b.title, "kind" to b.kind, "target" to b.target, "pressedThreadId" to b.pressedThreadId, "failed" to b.failed)
            })

    // A list as `count` and `<index>.<field>` ("" for the item itself).
    private fun <T> list(items: List<T>?, each: (T) -> Map<String, Any?>): Map<String, Any?> {
        val out = mutableMapOf<String, Any?>("count" to (items?.size ?: 0).toDouble())
        items?.forEachIndexed { i, item -> each(item).forEach { (k, v) -> out[if (k.isEmpty()) "$i" else "$i.$k"] = v } }
        return out
    }

    private fun under(prefix: String, fields: Map<String, Any?>): Map<String, Any?> =
        fields.mapKeys { (k, _) -> if (k.isEmpty()) prefix else "$prefix.$k" }

    private fun n(v: Int?): Double? = v?.toDouble()

    private fun ms(t: Instant?): Double? = t?.toEpochMilli()?.toDouble()
}
