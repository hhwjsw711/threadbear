package com.mikerosoft.threadbear.kit

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject

class ModelsTest {
    private fun obj(text: String) = parseJson(text) as JsonObject

    private val row = """
        {"threadId":"t","runnerId":"r","title":"T","cwd":"/w/misc/","accountId":"a","provider":"claude","status":"idle","needsYou":true,"unread":true,"preview":"p",
         "lastActivityAt":"2026-10-30T00:00:00.000Z","view":"inbox","snoozedUntil":1798000000000,"brandNew":{"x":1},
         "asks":[{"action":"Merge it?","why":"Tests pass.","options":["Merge","Not yet"],"suggested":0.0,"links":[{"title":"Open PR","url":"https://x"}]}],"asksSeq":12.0,"next":["Ship it"],
         "pendingApproval":{"approvalId":"q1","kind":"question","questions":[{"question":"Which?","options":[{"label":"A"},{"label":"B","description":"bee"}]}]}}
    """

    @Test fun badCoordinatorMetadataKeepsTheOrdinaryThread() {
        for (hint in listOf("null", "12", "{}", "\"\"", "\"  \"")) {
            val t = PhoneThread.read(obj(row.replace("\"threadId\":", "\"coordinatorProjectId\":$hint,\"threadId\":")))
            assertNull(t.coordinatorProjectId)
            assertEquals("t", t.threadId)
        }
        assertNull(PhoneThread.read(obj(row)).coordinatorProjectId)
    }

    @Test fun threadRowsDecodeWithTheirCards() {
        val t = PhoneThread.read(obj(row))
        assertEquals(0, t.asks?.first()?.suggestedIndex)
        assertEquals(12.0, t.asksSeq)
        assertEquals(listOf("Ship it"), t.next)
        assertEquals(Instant.ofEpochMilli(1_798_000_000_000), t.snoozedUntil)
        assertEquals("misc", t.folderName)
        assertEquals("misc", t.placeText)
        val q = assertIs<PendingApproval.Questions>(t.pendingApproval)
        assertEquals("bee", q.questions[0].options[1].description)
    }

    @Test fun pickOneFollowUpsAndRecommendedIndex() {
        val pickOne = PhoneThread.read(obj(row.replace(
            """"next":["Ship it"]""",
            """"next":["Option A","Option B"],"nextPick":"one","nextSuggested":1.0""",
        )))
        assertEquals("one", pickOne.nextPick)
        assertTrue(pickOne.nextPickOne)
        assertEquals(1, pickOne.nextSuggestedIndex)

        val badCases = listOf(
            """"next":["A","B"],"nextPick":"one","nextSuggested":1e100""",
            """"next":["A","B"],"nextPick":"one","nextSuggested":2""",
            """"next":["A","B"],"nextPick":"one","nextSuggested":-1""",
            """"next":["A","B"],"nextPick":"one","nextSuggested":0.5""",
            """"next":["A"],"nextPick":"one","nextSuggested":0""",
            """"next":["A","B"],"nextSuggested":0""",
            """"next":["A","B"],"nextPick":"any","nextSuggested":0""",
            """"next":["A","B"],"nextPick":"one","nextSuggested":"0"""",
        )
        for (bad in badCases) {
            val decoded = PhoneThread.read(obj(row.replace(""""next":["Ship it"]""", bad)))
            assertNull(decoded.nextSuggestedIndex, bad)
        }

        val singlePickOne = PhoneThread.read(obj(row.replace(
            """"next":["Ship it"]""",
            """"next":["Only one"],"nextPick":"one"""",
        )))
        assertTrue(!singlePickOne.nextPickOne)
    }

    @Test fun approvalsSecretsAndUnknownKinds() {
        val a = assertIs<PendingApproval.Approval>(PendingApproval.read(obj("""{"approvalId":"a","options":["allow","later","deny"]}""")))
        assertEquals(listOf(ApprovalOption.ALLOW, ApprovalOption.DENY), a.options)
        assertEquals(null, a.reason)
        // What made it ask (backend API 113); a blank one is none.
        val why = assertIs<PendingApproval.Approval>(PendingApproval.read(obj("""{"approvalId":"a","options":["allow"],"reason":"A rule in your settings asks."}""")))
        assertEquals("A rule in your settings asks.", why.reason)
        assertEquals(null, assertIs<PendingApproval.Approval>(PendingApproval.read(obj("""{"approvalId":"a","options":["allow"],"reason":"  "}"""))).reason)
        assertEquals("Permission", a.title)
        assertIs<PendingApproval.Other>(PendingApproval.read(obj("""{"approvalId":"s","kind":"secret","label":"Key"}""")))
        val s = assertIs<PendingApproval.Secret>(PendingApproval.read(obj("""{"approvalId":"s","kind":"secret","label":"Key","key":"k"}""")))
        assertEquals("Key", s.label)
        assertEquals("future", assertIs<PendingApproval.Other>(PendingApproval.read(obj("""{"approvalId":"f","kind":"future"}"""))).kind)
    }

    @Test fun oneUnreadableRowIsSkippedNotTheList() {
        val list = parseJson("[$row, {\"threadId\":\"broken\"}, ${row.replace("\"t\"", "\"t2\"")}]").lossyList(PhoneThread::read)
        assertEquals(listOf("t", "t2"), list.map { it.threadId })
    }

    @Test fun messagePagesSkipUnknownRolesAndReadSeqsAsWholeNumbers() {
        val page = MessagePage.read(obj("""
            {"hasMore":true,"messages":[
              {"seq":3.0,"role":"assistant","text":"- a","summary":true,"at":"2026-10-30T00:00:00.000Z"},
              {"seq":4,"role":"robot","text":"?","at":1},
              {"seq":4.5,"role":"tool","text":"x","at":1},
              {"seq":5,"role":"tool","text":"Run tests","toolKind":"command","at":1798000000000,"turn":"b","wokeBy":[{"kind":"agent","description":"Mine"}]}
            ]}
        """))
        assertEquals(listOf(3, 5), page.messages.map { it.seq })
        assertTrue(page.messages[0].summary)
        assertEquals("Mine", page.messages[1].wokeBy?.single()?.description)
        assertTrue(page.hasMore)
    }

    @Test fun anUnreadableOptionalDateIsAbsentAndHugeOnesAreHeld() {
        val t = PhoneThread.read(obj(row.replace("1798000000000", "\"soon\"")))
        assertNull(t.snoozedUntil)
        val far = PhoneThread.read(obj(row.replace("1798000000000", "1e300")))
        assertEquals(Instant.ofEpochMilli(8_640_000_000_000_000), far.snoozedUntil)
    }

    @Test fun aWaitStateIsReadAndOptional() {
        assertNull(PhoneThread.read(obj(row)).waitState)
        val withState = { v: String -> PhoneThread.read(obj(row.replace("\"view\":\"inbox\"", "\"view\":\"inbox\",\"waitState\":$v"))).waitState }
        assertEquals(WaitState.ON_THREADS, withState("\"onThreads\""))
        assertEquals(WaitState.DONE, withState("\"somethingNew\""))
        assertNull(withState("3"))
    }

    @Test fun identityAndRunners() {
        val me = PhoneIdentity.read(obj("""{"name":"android","expiresAt":null,"apiVersion":71}"""))
        assertEquals(71, me.apiVersion)
        assertTrue(me.sendsNotifications)
        val r = PhoneRunner.read(obj("""{"runnerId":"r","name":"M5","lastSeenAt":${NOW.toEpochMilli() - 60_000}}"""))
        assertTrue(r.isOnline(NOW))
        assertEquals("M5", WaitingSends.offlineRunner("r", listOf(r), NOW.plusSeconds(200)))
    }

    @Test fun threadChangesAreWrittenAsTheBackendTakesThem() {
        assertEquals("""{"archive":true,"verdict":"didntWork"}""", ThreadChange.ArchiveWithVerdict(ArchiveVerdict.DIDNT_WORK).json.toString())
        assertEquals("""{"snooze":{"untilRestart":true}}""", ThreadChange.SnoozeUntilRestart.json.toString())
        assertEquals("""{"star":false}""", ThreadChange.Star(false).json.toString())
        assertEquals("""{"snooze":{"until":"2026-11-03T04:00:00Z"}}""", ThreadChange.Snooze(NOW).json.toString())
    }

    @Test fun askParagraphsAndAnswers() {
        val asks = listOf(
            PhoneAsk("Merge it?", why = "Tests pass.", options = listOf("Merge", "Not yet")),
            PhoneAsk("Add the key", why = "In Settings.", reply = "done"),
        )
        assertEquals("Add the key. In Settings.", asks[1].paragraph)
        assertEquals("Merge it? Tests pass.", asks[0].paragraph)
        assertEquals("2. Add the key\n   done\n\nthanks", AskAnswer.message(asks, mapOf(1 to 0), "thanks"))
        assertEquals("Merge it?\nNot yet", AskAnswer.message(listOf(asks[0]), mapOf(0 to 1)))
        assertTrue(AskAnswer.answers(asks, mapOf(0 to 5)).isEmpty())
        assertEquals("- Check the nightly\n- Refresh the cache\n\nquick", AskAnswer.followUpMessage(listOf("Check the nightly", "Refresh the cache"), " quick \n"))
    }

    @Test fun questionAnswersAreBuiltLikeTheMac() {
        val qs = listOf(
            Question("Which?", "Pick", options = listOf(QuestionOption("A"), QuestionOption("B"))),
            Question("Tests?", multiSelect = true, options = listOf(QuestionOption("Unit"), QuestionOption("E2E"))),
        )
        val answers = Answers.build(qs, mapOf(0 to setOf("B"), 1 to setOf("Unit")), "smoke")
        assertEquals(mapOf("Which?" to "B", "Tests?" to "Unit, smoke"), answers)
        assertEquals("Pick B · Tests? Unit, smoke", Answers.summary(qs, answers))
        val one = listOf(qs[0])
        assertEquals(mapOf("Which?" to "something else"), Answers.build(one, mapOf(0 to setOf("A")), "something else"))
    }

    @Test fun waitingSendsDropOutOnceTheirMessageArrives() {
        val sent = NOW.toEpochMilli().toDouble()
        val waiting = listOf(
            WaitingSend("c1", CommandState.TAKEN, "yes", 0, sent),
            WaitingSend("c2", CommandState.PENDING, "and this", 0, sent + 1),
            WaitingSend("c3", CommandState.TAKEN, "look", 2, sent + 2),
        )
        val old = PhoneMessage(1, Role.USER, "yes", origin = "phone", at = NOW.minusSeconds(3600))
        assertEquals(listOf("c1", "c2", "c3"), WaitingSends.shown(waiting, listOf(old)).map { it.commandId })
        val arrived = PhoneMessage(2, Role.USER, "yes", origin = "phone", at = NOW.plusSeconds(1))
        val pics = PhoneMessage(3, Role.USER, "look\n\n[2 pictures]", origin = "phone", at = NOW.plusSeconds(2))
        assertEquals(listOf("c2"), WaitingSends.shown(waiting, listOf(old, arrived, pics)).map { it.commandId })
        assertEquals("[Picture 1] here\n\n[1 picture]", WaitingSends.mirrored(WaitingSend("x", CommandState.TAKEN, "[Picture 1] here", 2, 0.0)))
    }

    // Daybreak 141: another runner's project with the same id never stands in for the thread's own.
    @Test fun projectsAreLookedUpUnderTheThreadsOwnRunner() {
        val mine = PhoneProject(id = "p_shared", runnerId = "laptop", title = "Main project")
        val theirs = PhoneProject(id = "p_shared", runnerId = "mini", title = "Mini project")
        val projects = ProjectsByRunner(listOf(theirs, mine))
        assertEquals("Main project", projects.find("laptop", "p_shared")?.title)
        assertEquals("Mini project", projects.find("mini", "p_shared")?.title)
        assertNull(projects.find("bruce", "p_shared"))
    }
}
