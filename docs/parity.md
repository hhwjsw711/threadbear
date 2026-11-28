# Where each thread action works

Made from `runner/src/parity.ts` by `npm run parity-docs` in `runner/`; edit that, not this.
`runner/test/unit/parity.test.ts` checks each row against the code, and fails when a new
thread request has no row, so a feature can't go missing on another Mac or the phone
without someone deciding it should.

"Another Mac" is a thread on another runner opened in the Mac app through Convex. "Website"
and "iPhone" read every thread through Convex, with the same functions (convex/phone.ts).
"Android" is the Android app, which reads the same way through its kit, a port of the iPhone's.

| What | Request | Another Mac | Website | iPhone | Android |
|---|---|---|---|---|---|
| Reading the transcript | `threads.events` | Yes | Yes | Yes | Yes |
| Following it live (relaySeen skips relay events this reader has) | `threads.subscribe` | Yes | Yes | Yes | Yes |
| Opening a tool's output | `threads.heldBody` | Yes | Yes | No: The iPhone shows a tool line, not its output. | No: Android shows a tool line, not its output. |
| Sending a message, pictures too | `threads.send` | Yes | Yes | Yes | Yes |
| Stop | `threads.interrupt` | Yes | Yes | Yes | Yes |
| Rename, archive, star, hibernate, and its pool, login, model or effort | `threads.update` | Yes | Yes | Yes | Yes |
| Marking it read | `threads.markSeen` | Yes | Yes | Yes | Yes |
| Sharing by link | `threads.share` | Yes | Yes | Yes | Yes |
| Answering an approval or a question | `approvals.respond` | Yes | Yes | Yes | Yes |
| Answering a secret card | `secrets.answer` | Yes | Yes | Yes | Yes |
| Pressing a reply button | `buttons.press` | Yes | Yes | Yes | Yes |
| A message's reply buttons | `buttons.list` | Yes | Yes | Yes | Yes |
| The slash command list | `threads.commands` | Yes | Yes | Yes | Yes |
| Hibernate until something happens | `threads.hibernateWhen` | Yes | No: The phone hibernates until a time only. | No: The phone hibernates until a time only. | No: The phone hibernates until a time only. |
| Design reviews | `reviews.list` | No: Reviews open in the Mac app from that Mac. | Yes | Yes | Yes |
| Reading a design review | `reviews.get` | No: Reviews open in the Mac app from that Mac. | Yes | Yes | Yes |
| Answering a design review | `reviews.respond` | No: Reviews open in the Mac app from that Mac. | Yes | Yes | Yes |
| What fills its context | `threads.contextUsage` | No: Asked of the CLI on that Mac; the ring's popover there shows the totals only. | No: Not on the phone. | No: Not on the phone. | No: Not on the phone. |
| Ticking an ask on the card | `threads.tickAsk` | No: Ticks stay on that Mac. | No: The phone sends picks with its answer instead. | No: The phone sends picks with its answer instead. | No: The phone sends picks with its answer instead. |
| Editing a message | `threads.edit` | No: It undoes file changes on that Mac, so it waits for a way to show what it undid. | No: Not on the phone. | No: Not on the phone. | No: Not on the phone. |
| Deleting it | `threads.delete` | No: Done on that Mac. | No: Not on the phone. | No: Not on the phone. | No: Not on the phone. |
| Its highlights | `threads.highlights` | No: Highlights are files on that Mac. | No: Not on the phone. | No: Not on the phone. | No: Not on the phone. |
| Removing a highlight | `threads.removeHighlight` | No: Highlights are files on that Mac. | No: Not on the phone. | No: Not on the phone. | No: Not on the phone. |
| A PR's auto-fix wand | `prWatch.set` | No: The watch runs on the Mac that has the thread. | No: Not on the phone. | No: Not on the phone. | No: Not on the phone. |
| Explain | `threads.explain` | No: Runs a model on that Mac. | No: Not on the phone. | No: Not on the phone. | No: Not on the phone. |
| Reading a sub-agent's work | `threads.subagent` | No: Sub-agents stay on that Mac. | No: Not on the phone. | No: Not on the phone. | No: Not on the phone. |
| A panel being shown | `threads.panelShown` | No: Patches run on that Mac. | No: No panels on the phone. | No: No panels on the phone. | No: No panels on the phone. |
| Opening a panel | `threads.showPanel` | No: Patches run on that Mac. | No: No panels on the phone. | No: No panels on the phone. | No: No panels on the phone. |
| Drawing a panel | `panels.render` | No: Patches run on that Mac. | No: No panels on the phone. | No: No panels on the phone. | No: No panels on the phone. |
| A list panel row's switch | `panels.toggle` | No: Patches run on that Mac. | No: No panels on the phone. | No: No panels on the phone. | No: No panels on the phone. |
| The Convex panel's key | `panels.convexKey` | No: Patches run on that Mac. | No: No panels on the phone. | No: No panels on the phone. | No: No panels on the phone. |
| The Convex panel's deployments | `panels.convexDeployments` | No: Patches run on that Mac. | No: No panels on the phone. | No: No panels on the phone. | No: No panels on the phone. |
| The Convex panel's login | `panels.convexLogin` | No: Patches run on that Mac. | No: No panels on the phone. | No: No panels on the phone. | No: No panels on the phone. |
| An action chip | `actions.run` | No: Patches run on that Mac. | No: No action chips on the phone. | No: No action chips on the phone. | No: No action chips on the phone. |
| Trusting a folder's patches | `patches.trust` | No: Trust is given on that Mac. | No: Not on the phone. | No: Not on the phone. | No: Not on the phone. |
| Approving a plan | `plans.approve` | No: Not sent through Convex from the Mac yet. | No: Not on the phone yet. | No: Not on the phone yet. | No: Not on the phone yet. |
| Starting a design review | `reviews.create` | No: Reviews open in the Mac app from that Mac. | No: Not on the phone. | No: Not on the phone. | No: Not on the phone. |
| Saving a design review | `reviews.save` | No: Reviews open in the Mac app from that Mac. | No: Not on the phone. | No: Not on the phone. | No: Not on the phone. |
| Cancelling a design review | `reviews.cancel` | No: Reviews open in the Mac app from that Mac. | No: Not on the phone. | No: Not on the phone. | No: Not on the phone. |

# What each app draws

Made from `runner/src/draw-parity.ts` with the table above. `runner/test/unit/draw-parity.test.ts`
reads every kind of thing the desktop draws from `desktop/core` and fails when one has no row
(printing the line to paste), and checks each Yes against that app's code. A row still as
pasted (`Desktop only for now.` for all three) is left out of this table.

## Transcript rows and cards (RowKind, reducer/row.rs)

| What | Kind | iPhone | Android | Website |
|---|---|---|---|---|
| The user's message | `row.user` | Yes | Yes | Yes |
| The agent's reply | `row.assistant` | Yes | Yes | Yes |
| A tool line | `row.tool` | Yes | Yes | Yes |
| Permission card | `row.approval` | Yes | Yes | Yes |
| The agent's question card | `row.question` | Yes | Yes | Yes |
| Design review card | `row.review` | Yes | Yes | Yes |
| System note | `row.note` | Yes | Yes | Yes |
| Secret request card | `row.secret` | Yes | Yes | Yes |
| Card of asks under a finished turn | `row.asks` | Yes | Yes | Yes |
| A turn's work folded into one line | `row.group` | Yes | Yes | Yes |
| Working indicator | `row.working` | Yes | Yes | Yes |
| "6 min later" divider before a woken turn | `row.gap` | Yes | Yes | Yes |
| Plan first card, waiting for approval | `row.planCard` | Yes | Yes | Yes |
| Another lab's review of the turn | `row.labReview` | Yes | Yes | Yes |
| A failed turn's error | `row.error` | Yes | No: Not drawn yet. | Yes |
| Background jobs still going | `row.background` | Yes | Yes | No: Not drawn yet. |
| Thinking | `row.reasoning` | No: Not drawn yet. | No: Not drawn yet. | Yes |
| An edit's diff | `row.diff` | No: Not drawn yet. | No: Not drawn yet. | Yes |
| A tool's pictures | `row.images` | No: Not drawn yet. | No: Not drawn yet. | Yes |
| Turn footer ("Worked for 3m") | `row.footer` | No: Not drawn yet. | No: Not drawn yet. | Yes |
| Plan checklist (plan.updated) | `row.plan` | No: Not drawn yet. | No: Not drawn yet. | No: Not drawn yet. |

## Who sent a message, when it isn't the user (reducer/row.rs)

| What | Kind | iPhone | Android | Website |
|---|---|---|---|---|
| The runner's own message, as a quiet line | `origin.runner` | Yes | Yes | Yes |
| A scheduled message, drawn as a schedule | `origin.schedule` | Yes | Yes | Yes |
| Mark on a message sent from the phone | `origin.phone` | Yes | Yes | No: The website sends as the phone, so the mark would be on the user's own messages. |

## A message's fields (TextFields, reducer/event.rs)

| What | Kind | iPhone | Android | Website |
|---|---|---|---|---|
| Pictures sent with a message | `message.images` | Yes | Yes | Yes |
| Who sent a message (see the origin rows) | `message.origin` | Yes | Yes | Yes |
| Why the runner sent its message, on the divider before the turn it started | `message.wakeReason` | Yes | Yes | Yes |
| The turn's summary reply, with the rest folded | `message.summary` | Yes | Yes | Yes |
| The user's answer to a design review | `message.reviewId` | Yes | Yes | No: Not drawn yet. |
| A design review answer's picks and notes | `message.reviewResponse` | Yes | Yes | No: Not drawn yet. |
| The user's answers to a card, each under its question | `message.answers` | Yes | No: Not drawn yet. | No: Not drawn yet. |
| A summary that gives way to a longer reply | `message.givesWay` | No: Not drawn yet. | Yes | No: Not drawn yet. |
| An edited message | `message.editOf` | No: Not drawn yet. | No: Not drawn yet. | No: Not drawn yet. |
| Narration (a paraphrase of what the agent wrote) | `message.narration` | No: Not drawn yet. | No: Not drawn yet. | No: Not drawn yet. |
| One reply's reply | `message.final` | No: Not drawn yet. | No: Not drawn yet. | No: Not drawn yet. |
| Queued CLI part boundary on a reply | `message.part` | No: Not drawn yet. | No: Not drawn yet. | No: Not drawn yet. |

## Each ask on a needs-you or decision card (Ask, reducer/event.rs)

| What | Kind | iPhone | Android | Website |
|---|---|---|---|---|
| The ask itself | `ask.action` | Yes | Yes | Yes |
| Answers to pick from | `ask.options` | Yes | Yes | Yes |
| What each answer does | `ask.optionNotes` | Yes | Yes | Yes |
| The suggested answer | `ask.suggested` | Yes | Yes | Yes |
| The reply it wants back | `ask.reply` | Yes | Yes | Yes |
| Why it asks | `ask.why` | Yes | Yes | Yes |
| Links to go and do it | `ask.links` | Yes | Yes | Yes |
| A ticked ask | `ask.ticked` | Yes | Yes | No: Not drawn yet. |
| The decision task for an open coordinator ask | `ask.taskId` | No: These clients show the current mirrored card. The Mac uses this field to keep the card in place on a background wake. | No: These clients show the current mirrored card. The Mac uses this field to keep the card in place on a background wake. | No: These clients show the current mirrored card. The Mac uses this field to keep the card in place on a background wake. |
| Where to do it | `ask.where` | No: The runner leaves where out of what the backend sends, as the ask's paragraph already says it. | No: The runner leaves where out of what the backend sends, as the ask's paragraph already says it. | No: The runner leaves where out of what the backend sends, as the ask's paragraph already says it. |

## A turn's end: the footer, the needs-you and done cards (TurnCompletion, reducer/event.rs)

| What | Kind | iPhone | Android | Website |
|---|---|---|---|---|
| How long it worked | `turn.durationMs` | Yes | Yes | Yes |
| Needs you or done | `turn.needs` | Yes | Yes | Yes |
| Needs-you card | `turn.asks` | Yes | Yes | Yes |
| Done card's follow-ups | `turn.next` | Yes | Yes | Yes |
| Done card's pick-one follow-up mode | `turn.nextPick` | Yes | Yes | Yes |
| Done card's recommended follow-up | `turn.nextSuggested` | Yes | Yes | Yes |
| Another lab's review ledger | `turn.review` | Yes | Yes | Yes |
| Done card's loose ends | `turn.looseEnds` | Yes | Yes | Yes |
| What it cost | `turn.costUsd` | Yes | No: Not drawn yet. | Yes |
| Completed, stopped or failed | `turn.outcome` | No: Not drawn yet. | Yes | No: Not drawn yet. |
| Fix for a known failure (usage limit, context, sign-in, network) | `turn.errorKind` | No: Not drawn yet. | Yes | No: Not drawn yet. |
| A failed turn's error | `turn.error` | No: Not drawn yet. | No: Not drawn yet. | No: Not drawn yet. |
| Tokens used | `turn.usage` | No: Not drawn yet. | No: Not drawn yet. | No: Not drawn yet. |
| Keep an unchanged coordinator card open across a background wake | `turn.carriedAsks` | No: These clients show the current mirrored card. The Mac uses this field to keep the card in place on a background wake. | No: These clients show the current mirrored card. The Mac uses this field to keep the card in place on a background wake. | No: These clients show the current mirrored card. The Mac uses this field to keep the card in place on a background wake. |

## Inbox sections (inbox.rs)

| What | Kind | iPhone | Android | Website |
|---|---|---|---|---|
| Coordinators section | `section.coordinators` | Yes | Yes | Yes |
| Starred section | `section.starred` | Yes | Yes | Yes |
| Inbox section | `section.inbox` | Yes | Yes | Yes |
| Running section | `section.running` | Yes | Yes | Yes |
| Hibernating section | `section.hibernating` | Yes | Yes | Yes |
| Archived section | `section.archived` | Yes | Yes | Yes |

## An inbox row's status (RowStatus, sidebar.rs)

| What | Kind | iPhone | Android | Website |
|---|---|---|---|---|
| Last activity time | `status.Time` | Yes | Yes | Yes |
| Working spinner and timer | `status.Working` | Yes | Yes | Yes |
| Needs you | `status.NeedsYou` | Yes | Yes | Yes |
| Failed | `status.Failed` | Yes | Yes | Yes |
| Background work and what runs | `status.Background` | Yes | Yes | No: Not drawn yet. |
| Stopped | `status.Stopped` | Yes | Yes | No: Not drawn yet. |

## How an inbox row looks (RowLook, sidebar.rs)

| What | Kind | iPhone | Android | Website |
|---|---|---|---|---|
| Unread dot | `look.unread` | Yes | Yes | Yes |
| Bold title when it wants the user | `look.emphasised` | Yes | Yes | Yes |
| Status in words (a timer only under Running) | `look.labelled` | Yes | Yes | No: Not drawn yet. |
| Done tick | `look.done` | Yes | Yes | No: Not drawn yet. |
| "Woke up" | `look.woke` | Yes | Yes | No: Not drawn yet. |

## Blocks in a reply (rich_block.rs, draft_block.rs)

| What | Kind | iPhone | Android | Website |
|---|---|---|---|---|
| Slack draft | `block.slack` | Yes | Yes | Yes |
| Email draft | `block.email` | Yes | Yes | Yes |
| Draft to copy | `block.draft` | Yes | Yes | Yes |
| Diagram | `block.mermaid` | Yes | Yes | No: Not drawn yet. |
| Small page | `block.html` | Yes | Yes | No: Not drawn yet. |

## Links into the thread from a reply (reply_links.rs)

| What | Kind | iPhone | Android | Website |
|---|---|---|---|---|
| Link to a step of the working | `link.work` | Yes | Yes | Yes |
| Link to another thread | `link.thread` | Yes | Yes | Yes |
| Link to a design review | `link.review` | Yes | Yes | Yes |
| Reply button | `link.button` | Yes | Yes | Yes |

## A thread link's mark (LinkMark, link_marks.rs)

| What | Kind | iPhone | Android | Website |
|---|---|---|---|---|
| Working | `mark.Working` | No: Not drawn yet. | No: Not drawn yet. | No: Not drawn yet. |
| Needs you | `mark.NeedsYou` | No: Not drawn yet. | No: Not drawn yet. | No: Not drawn yet. |
| Failed | `mark.Failed` | No: Not drawn yet. | No: Not drawn yet. | No: Not drawn yet. |
| Done | `mark.Done` | No: Not drawn yet. | No: Not drawn yet. | No: Not drawn yet. |
| Idle | `mark.Idle` | No: Not drawn yet. | No: Not drawn yet. | No: Not drawn yet. |
