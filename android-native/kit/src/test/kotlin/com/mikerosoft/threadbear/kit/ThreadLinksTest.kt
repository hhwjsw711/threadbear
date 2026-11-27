package com.mikerosoft.threadbear.kit

import com.mikerosoft.threadbear.kit.Role.ASSISTANT
import com.mikerosoft.threadbear.kit.Role.TOOL
import com.mikerosoft.threadbear.kit.Role.USER
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject

class ThreadLinksTest {
    private fun message(seq: Int, role: Role, text: String, summary: Boolean = false) = msg(seq, role, text, seq * 60.0, summary = summary)

    /** Two finished turns, each folded. */
    private val items = Turns.fold(listOf(
        message(1, USER, "First"),
        message(2, TOOL, "Run the tests"),
        message(3, ASSISTANT, "All done.", summary = true),
        message(4, USER, "Second"),
        message(5, TOOL, "Run the tests"),
        message(6, ASSISTANT, "Now the risky part."),
        message(7, TOOL, "Commit, land, retire the old simulator"),
        message(8, TOOL, "Edited ~/dev/a.swift"),
        message(9, ASSISTANT, "- [Landed](work:Commit, land)\n- [Tested](work:run the tests)", summary = true),
    ), busy = false)

    private fun worked(i: Int) = (items[i] as ThreadItem.Worked).worked

    @Test fun escapesTheDestinationsAgentsWrite() {
        // Mike's screenshot, 1 Nov: this came through as raw text on the phone.
        val written = "and that's [landed on main](work:Commit, land, retire the old shared simulator) as `ec865ff`."
        val escaped = ThreadLinks.escapeDestinations(written)
        assertEquals("and that's [landed on main](work:Commit,%20land,%20retire%20the%20old%20shared%20simulator) as `ec865ff`.", escaped)
        val destination = Regex("""\]\(([^)]*)\)""").find(escaped)!!.groupValues[1]
        assertEquals(ThreadLinks.Target.Step("Commit, land, retire the old shared simulator"), ThreadLinks.target(destination))
    }

    @Test fun leavesEverythingElseAlone() {
        val web = "[x](https://a.b/c) and [y](/a/b.md)"
        assertEquals(web, ThreadLinks.escapeDestinations(web))
        assertEquals("[done](work:npm%20test)", ThreadLinks.escapeDestinations("[done](work:npm%20test)"))
        val span = "Write `[a](work:npm test)` like that, [b](work:npm test)"
        assertEquals("Write `[a](work:npm test)` like that, [b](work:npm%20test)", ThreadLinks.escapeDestinations(span))
    }

    @Test fun aQuoteCanHaveBracketsInIt() {
        val escaped = ThreadLinks.escapeDestinations("[a](work:npm test (unit)) next")
        assertEquals("[a](work:npm%20test%20%28unit%29) next", escaped)
        assertEquals(ThreadLinks.Target.Step("npm test (unit)"), ThreadLinks.target("work:npm%20test%20%28unit%29"))
    }

    @Test fun readsEachKindOfLink() {
        assertEquals(ThreadLinks.Target.Thread("a1b2c3d4"), ThreadLinks.target("thread:a1b2c3d4"))
        assertEquals(ThreadLinks.Target.Review("abc"), ThreadLinks.target("review:abc"))
        assertNull(ThreadLinks.target("https://a.b"))
    }

    @Test fun aWorkLinkFindsItsStepInItsOwnTurn() {
        val second = worked(4)
        val first = worked(1)
        assertEquals(ThreadLinks.Hit(second, 7), ThreadLinks.find("commit,  LAND", 9, items))
        // In both turns: the second's, as the link's in the second.
        assertEquals(ThreadLinks.Hit(second, 5), ThreadLinks.find("Run the tests", 9, items))
        assertEquals(ThreadLinks.Hit(first, 2), ThreadLinks.find("Run the tests", 3, items))
        // The card of asks has no message of its own, so the latest turn.
        assertEquals(ThreadLinks.Hit(second, 5), ThreadLinks.find("Run the tests", null, items))
        // A line the agent wrote, and a path as it wrote it.
        assertEquals(ThreadLinks.Hit(second, 6), ThreadLinks.find("risky part", 9, items))
        assertEquals(ThreadLinks.Hit(second, 8), ThreadLinks.find("/Users/alex/dev/a.swift", 9, items))
    }

    @Test fun wordsFoundNowhereStillOpenTheWorking() {
        assertEquals(ThreadLinks.Hit(worked(4), null), ThreadLinks.find("npm run nothing", 9, items))
    }

    @Test fun aLinkDoesNotFindItself() {
        // Its own words are in the summary, which isn't a step.
        assertEquals(ThreadLinks.Hit(worked(4), null), ThreadLinks.find("Landed", 9, items))
    }

    @Test fun aTurnStillGoingShowsItsLinesSoFar() {
        val going = Turns.fold(listOf(message(1, USER, "Go"), message(2, TOOL, "Run the tests"), message(3, ASSISTANT, "[Ran](work:run the tests)")), busy = true)
        assertEquals(2, ThreadLinks.find("run the tests", 3, going)?.step)
        assertEquals(listOf<ThreadItem>(ThreadItem.Tools(listOf(message(2, TOOL, "Run the tests")))), ThreadLinks.find("run the tests", 3, going)?.turn?.items)
        assertNull(ThreadLinks.find("nothing", 3, going)?.step)
    }

    @Test fun noWorkingNoSheet() {
        val quick = Turns.fold(listOf(message(1, USER, "Hi"), message(2, ASSISTANT, "[Hello](work:nothing)")), busy = false)
        assertNull(ThreadLinks.find("nothing", 2, quick))
    }

    /** A shared case file's cases this app runs: those whose `differs` doesn't name Android. */
    private fun shared(path: String): List<JsonObject> =
        (parseJson(File(path).readText()) as JsonObject).arr("cases")!!.map { it as JsonObject }.filter { it.obj("differs")?.containsKey("android") != true }

    private fun JsonObject?.asTarget(): Map<String, String>? = this?.let { mapOf("kind" to it.str("kind")!!, "value" to it.str("value")!!) }

    /** A target as the shared cases write it. */
    private fun neutral(t: ThreadLinks.Target?): Map<String, String>? = when (t) {
        null -> null
        is ThreadLinks.Target.Step -> mapOf("kind" to "step", "value" to t.quote)
        is ThreadLinks.Target.Thread -> mapOf("kind" to "thread", "value" to t.id)
        is ThreadLinks.Target.Review -> mapOf("kind" to "review", "value" to t.id)
        is ThreadLinks.Target.Button -> mapOf("kind" to "button", "value" to t.id)
    }

    /** What a link opens, against the cases the desktop app, the iPhone and the website run too. */
    @Test fun linksMatchTheSharedCases() {
        val cases = shared("../../shared/cases/thread-links.json")
        assertTrue(cases.size > 5)
        for (c in cases) {
            val want = (c["expect"] as? JsonObject).asTarget()
            assertEquals(want, neutral(ThreadLinks.target(c.str("input")!!)), c.str("name"))
        }
    }

    /** Escaping work links and the step one finds, against the cases the iPhone and the website run too. */
    @Test fun workLinksMatchTheSharedCases() {
        val cases = shared("../../shared/cases/work-links.json")
        assertTrue(cases.size > 10)
        val destination = Regex("""\]\(((?:[^()\s]|\([^()\s]*\))*)\)""")
        for (c in cases) {
            val name = c.str("name")
            val input = c.obj("input")!!
            val expect = c.obj("expect")!!
            if (input.str("op") == "escape") {
                val want = expect.arr("links")!!.map { (it as? JsonObject).asTarget() }
                val escaped = ThreadLinks.escapeDestinations(input.str("markdown")!!)
                val got = destination.findAll(escaped).map { m -> neutral(ThreadLinks.target(m.groupValues[1])) }.toList()
                assertEquals(want, got, name)
            } else {
                val rows = input.arr("rows")!!.map { r ->
                    val o = r as JsonObject
                    val seq = o.num("seq")!!.toInt()
                    message(seq, Role.valueOf(o.str("role")!!.uppercase()), o.str("text")!!, summary = o.bool("summary") ?: false)
                }
                val items = Turns.fold(rows, busy = input.bool("busy") ?: false)
                val hit = ThreadLinks.find(input.str("quote")!!, input.num("from")?.toInt(), items)
                assertEquals(expect.num("step")?.toInt(), hit?.step, name)
            }
        }
    }
}
