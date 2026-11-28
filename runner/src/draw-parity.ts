// What the desktop app draws in a thread and the inbox, and whether the
// iPhone app, the Android app and the website draw it too. parity.ts covers
// what each can *do* (a thread request); this covers what each *shows*. Mike
// kept finding things built on the desktop that never reached the phones, or
// looked different there: the done card's follow-ups, a decision card's
// per-answer notes, folded "Worked for" turns, scheduled messages, secret
// cards not looking urgent (34 reports by 21 Nov 2026).
//
// One row per kind of thing, keyed `<family>.<name>`. draw-parity.test.ts
// reads the kinds from desktop/core (the transcript's RowKind, the decoders'
// wire keys, the inbox's sections and row looks, reply blocks and links), so
// a new one there fails until it has a row here, and the failure prints the
// line to paste. Each app says 'yes' or { no: 'why, in plain words.' }:
// "Not drawn yet." for a gap nobody chose, or the reason it's left out. A
// 'yes' is checked against that app's code: its sign (the name after the
// dot, unless `sign` gives that app's own name for it) must be in the app's
// sources, so a yes nobody built fails too. Forks: a desktop-only addition
// is one pasted line with three no's. docs/parity.md's second table is made
// from this (npm run parity-docs).

export const PLATFORMS = ['ios', 'android', 'web'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Drawn = 'yes' | { no: string };
export type DrawRow = { what: string; ios: Drawn; android: Drawn; web: Drawn; sign?: Partial<Record<Platform, string>> };

/** Where each family's kinds are read from, and its heading in the doc. */
export const FAMILIES: Record<string, string> = {
  row: 'Transcript rows and cards (RowKind, reducer/row.rs)',
  origin: "Who sent a message, when it isn't the user (reducer/row.rs)",
  message: "A message's fields (TextFields, reducer/event.rs)",
  ask: 'Each ask on a needs-you or decision card (Ask, reducer/event.rs)',
  turn: "A turn's end: the footer, the needs-you and done cards (TurnCompletion, reducer/event.rs)",
  section: 'Inbox sections (inbox.rs)',
  status: "An inbox row's status (RowStatus, sidebar.rs)",
  look: 'How an inbox row looks (RowLook, sidebar.rs)',
  block: 'Blocks in a reply (rich_block.rs, draft_block.rs)',
  link: 'Links into the thread from a reply (reply_links.rs)',
  mark: "A thread link's mark (LinkMark, link_marks.rs)",
};

const NOT_YET = { no: 'Not drawn yet.' };
const CURRENT_ASK_CARD = { no: 'These clients show the current mirrored card. The Mac uses this field to keep the card in place on a background wake.' };

export const DRAWN: Record<string, DrawRow> = {
  'row.user': { what: "The user's message", ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'UserBubble' } },
  'row.assistant': { what: "The agent's reply", ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'MessageView' } },
  'row.reasoning': { what: 'Thinking', ios: NOT_YET, android: NOT_YET, web: 'yes' },
  'row.tool': { what: 'A tool line', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'toolKind', android: 'ToolRunView', web: 'toolKind' } },
  'row.diff': { what: "An edit's diff", ios: NOT_YET, android: NOT_YET, web: 'yes', sign: { web: 'diffFiles' } },
  'row.images': { what: "A tool's pictures", ios: NOT_YET, android: NOT_YET, web: 'yes', sign: { web: 'HeldPicture' } },
  'row.approval': { what: 'Permission card', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'ApprovalCard' } },
  'row.question': { what: "The agent's question card", ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'QuestionCard', web: 'questions' } },
  'row.review': { what: 'Design review card', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'DesignReviewsView', android: 'DesignReviewsDialog', web: 'ReviewBoard' } },
  'row.plan': { what: 'Plan checklist (plan.updated)', ios: NOT_YET, android: NOT_YET, web: NOT_YET },
  'row.footer': { what: 'Turn footer ("Worked for 3m")', ios: NOT_YET, android: NOT_YET, web: 'yes', sign: { web: 'meta' } },
  'row.note': { what: 'System note', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'LoginNoteView', android: 'LoginNoteView', web: 'isNote' } },
  'row.error': { what: "A failed turn's error", ios: 'yes', android: NOT_YET, web: 'yes' },
  'row.secret': { what: 'Secret request card', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'SecretCard', android: 'SecretCard' } },
  'row.asks': { what: 'Card of asks under a finished turn', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'AsksCard', android: 'AsksCard' } },
  'row.group': { what: "A turn's work folded into one line", ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'WorkedView', android: 'WorkedView', web: 'workedTitle' } },
  'row.working': { what: 'Working indicator', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'WorkingLine', android: 'WorkingLine' } },
  'row.background': { what: 'Background jobs still going', ios: 'yes', android: 'yes', web: NOT_YET, sign: { ios: 'working', android: 'working' } },
  'row.gap': { what: '"6 min later" divider before a woken turn', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'wokeBy', android: 'wokeBy', web: 'gapLabel' } },
  'row.planCard': { what: 'Plan first card, waiting for approval', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'PlanCard', android: 'PlanCard', web: 'PlanCard' } },
  'row.labReview': { what: "Another lab's review of the turn", ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'ReviewRow', android: 'ReviewRow', web: 'ReviewRow' } },
  'origin.phone': { what: 'Mark on a message sent from the phone', ios: 'yes', android: 'yes', web: { no: 'The website sends as the phone, so the mark would be on the user\'s own messages.' }, sign: { ios: 'PhoneMark', android: 'PhoneMark' } },
  'origin.runner': { what: "The runner's own message, as a quiet line", ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'originText' } },
  'origin.schedule': { what: 'A scheduled message, drawn as a schedule', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'ScheduledMessageCard' } },
  'message.images': { what: 'Pictures sent with a message', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'pasted', android: 'pasted', web: 'pastedOf' } },
  'message.origin': { what: "Who sent a message (see the origin rows)", ios: 'yes', android: 'yes', web: 'yes' },
  'message.wakeReason': { what: "Why the runner sent its message, on the divider before the turn it started", ios: 'yes', android: 'yes', web: 'yes' },
  'message.answers': { what: "The user's answers to a card, each under its question", ios: 'yes', android: NOT_YET, web: NOT_YET },
  'message.editOf': { what: 'An edited message', ios: NOT_YET, android: NOT_YET, web: NOT_YET },
  'message.reviewId': { what: "The user's answer to a design review", ios: 'yes', android: 'yes', web: NOT_YET, sign: { ios: 'ReviewAnswer', android: 'ReviewAnswer' } },
  'message.reviewResponse': { what: "A design review answer's picks and notes", ios: 'yes', android: 'yes', web: NOT_YET, sign: { ios: 'ReviewAnswer', android: 'ReviewLines' } },
  'message.summary': { what: "The turn's summary reply, with the rest folded", ios: 'yes', android: 'yes', web: 'yes' },
  'message.narration': { what: 'Narration (a paraphrase of what the agent wrote)', ios: NOT_YET, android: NOT_YET, web: NOT_YET },
  'message.givesWay': { what: 'A summary that gives way to a longer reply', ios: NOT_YET, android: 'yes', web: NOT_YET, sign: { android: 'replyIndexes' } },
  'message.final': { what: "One reply's reply", ios: NOT_YET, android: NOT_YET, web: NOT_YET },
  'message.part': { what: 'Queued CLI part boundary on a reply', ios: NOT_YET, android: NOT_YET, web: NOT_YET },
  'ask.action': { what: 'The ask itself', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'paragraph', android: 'paragraph' } },
  'ask.taskId': { what: 'The decision task for an open coordinator ask', ios: CURRENT_ASK_CARD, android: CURRENT_ASK_CARD, web: CURRENT_ASK_CARD },
  'ask.options': { what: 'Answers to pick from', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'choices' } },
  'ask.optionNotes': { what: 'What each answer does', ios: 'yes', android: 'yes', web: 'yes' },
  'ask.suggested': { what: 'The suggested answer', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'suggestedIndex' } },
  'ask.where': { what: 'Where to do it', ios: { no: 'The runner leaves where out of what the backend sends, as the ask\'s paragraph already says it.' }, android: { no: 'The runner leaves where out of what the backend sends, as the ask\'s paragraph already says it.' }, web: { no: 'The runner leaves where out of what the backend sends, as the ask\'s paragraph already says it.' } },
  'ask.reply': { what: 'The reply it wants back', ios: 'yes', android: 'yes', web: 'yes' },
  'ask.why': { what: 'Why it asks', ios: 'yes', android: 'yes', web: 'yes' },
  'ask.links': { what: 'Links to go and do it', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'PhoneAskLink', android: 'PhoneAskLink' } },
  'ask.ticked': { what: 'A ticked ask', ios: 'yes', android: 'yes', web: NOT_YET },
  'turn.error': { what: "A failed turn's error", ios: NOT_YET, android: NOT_YET, web: NOT_YET },
  'turn.outcome': { what: 'Completed, stopped or failed', ios: NOT_YET, android: 'yes', web: NOT_YET, sign: { android: 'ERROR' } },
  'turn.durationMs': { what: 'How long it worked', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'WorkedTurn', android: 'durationSeconds', web: 'duration' } },
  'turn.costUsd': { what: 'What it cost', ios: 'yes', android: NOT_YET, web: 'yes' },
  'turn.usage': { what: 'Tokens used', ios: NOT_YET, android: NOT_YET, web: NOT_YET },
  'turn.errorKind': { what: 'Fix for a known failure (usage limit, context, sign-in, network)', ios: NOT_YET, android: 'yes', web: NOT_YET, sign: { android: 'waitingForNetwork' } },
  'turn.needs': { what: 'Needs you or done', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'waitingOnMike' } },
  'turn.asks': { what: 'Needs-you card', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'asksSeq' } },
  'turn.carriedAsks': { what: 'Keep an unchanged coordinator card open across a background wake', ios: CURRENT_ASK_CARD, android: CURRENT_ASK_CARD, web: CURRENT_ASK_CARD },
  'turn.next': { what: "Done card's follow-ups", ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'nextPicks', android: 'sendFollowUps', web: 'followUpMessage' } },
  'turn.nextPick': { what: "Done card's pick-one follow-up mode", ios: 'yes', android: 'yes', web: 'yes' },
  'turn.nextSuggested': { what: "Done card's recommended follow-up", ios: 'yes', android: 'yes', web: 'yes' },
  'turn.review': { what: "Another lab's review ledger", ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'LabReviewText', android: 'LabReviewText', web: 'LabReviewLedger' } },
  'turn.looseEnds': { what: "Done card's loose ends", ios: 'yes', android: 'yes', web: 'yes' },
  'section.coordinators': { what: 'Coordinators section', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'coordinators', android: 'COORDINATORS', web: 'coordinators' } },
  'section.starred': { what: 'Starred section', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'STARRED' } },
  'section.inbox': { what: 'Inbox section', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'INBOX' } },
  'section.running': { what: 'Running section', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'RUNNING' } },
  'section.hibernating': { what: 'Hibernating section', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'HIBERNATING' } },
  'section.archived': { what: 'Archived section', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'ARCHIVED' } },
  'status.Time': { what: 'Last activity time', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'RelativeTime', android: 'RelativeTime', web: 'lastActivityMs' } },
  'status.Working': { what: 'Working spinner and timer', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'workingLabel', android: 'workingLabel', web: 'busy' } },
  'status.Background': { what: 'Background work and what runs', ios: 'yes', android: 'yes', web: NOT_YET, sign: { ios: 'working', android: 'doing' } },
  'status.NeedsYou': { what: 'Needs you', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'needsYou', android: 'NEEDS_YOU', web: 'needsYou' } },
  'status.Failed': { what: 'Failed', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'failed', android: 'FAILED' } },
  'status.Stopped': { what: 'Stopped', ios: 'yes', android: 'yes', web: NOT_YET, sign: { ios: 'stopped', android: 'STOPPED' } },
  'look.unread': { what: 'Unread dot', ios: 'yes', android: 'yes', web: 'yes' },
  'look.emphasised': { what: 'Bold title when it wants the user', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'SemiBold', web: 'needs' } },
  'look.labelled': { what: 'Status in words (a timer only under Running)', ios: 'yes', android: 'yes', web: NOT_YET, sign: { ios: 'underRunning', android: 'underRunning' } },
  'look.done': { what: 'Done tick', ios: 'yes', android: 'yes', web: NOT_YET },
  'look.woke': { what: '"Woke up"', ios: 'yes', android: 'yes', web: NOT_YET },
  'block.mermaid': { what: 'Diagram', ios: 'yes', android: 'yes', web: NOT_YET, sign: { android: 'MERMAID' } },
  'block.html': { what: 'Small page', ios: 'yes', android: 'yes', web: NOT_YET, sign: { android: 'HTML' } },
  'block.slack': { what: 'Slack draft', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'SLACK' } },
  'block.email': { what: 'Email draft', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'EMAIL' } },
  'block.draft': { what: 'Draft to copy', ios: 'yes', android: 'yes', web: 'yes', sign: { android: 'DRAFT' } },
  'link.work': { what: 'Link to a step of the working', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'workLink', android: 'workLink', web: 'findStep' } },
  'link.thread': { what: 'Link to another thread', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'pushThread', android: 'LocalPushThread', web: 'threadPath' } },
  'link.review': { what: 'Link to a design review', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'designReviewShown', android: 'reviewShown', web: 'openReview' } },
  'link.button': { what: 'Reply button', ios: 'yes', android: 'yes', web: 'yes', sign: { ios: 'ReplyButtonPill', android: 'ReplyButtonPill', web: 'ReplyButton' } },
  'mark.Working': { what: 'Working', ios: NOT_YET, android: NOT_YET, web: NOT_YET },
  'mark.NeedsYou': { what: 'Needs you', ios: NOT_YET, android: NOT_YET, web: NOT_YET },
  'mark.Failed': { what: 'Failed', ios: NOT_YET, android: NOT_YET, web: NOT_YET },
  'mark.Done': { what: 'Done', ios: NOT_YET, android: NOT_YET, web: NOT_YET },
  'mark.Idle': { what: 'Idle', ios: NOT_YET, android: NOT_YET, web: NOT_YET },
};

/** The name a platform's code must have for its yes to hold. */
export function signFor(kind: string, row: DrawRow, p: Platform): string {
  return row.sign?.[p] ?? kind.slice(kind.indexOf('.') + 1);
}

/** A pasted row's answer, left as it is: kept out of the doc, so pasting
 * the test's line is all a fork has to do. */
export const PASTED_NO = 'Desktop only for now.';

/** The line a new kind's row starts as, for the test's failure to print. */
export function pasteLine(kind: string): string {
  const no = `{ no: '${PASTED_NO}' }`;
  return `'${kind}': { what: '${kind.slice(kind.indexOf('.') + 1)}', ios: ${no}, android: ${no}, web: ${no} },`;
}

/** docs/parity.md's second table, by family, drawn everywhere first. */
export function drawParityDoc(): string {
  const cell = (w: Drawn) => (w === 'yes' ? 'Yes' : `No: ${w.no}`);
  const out = [
    '# What each app draws',
    '',
    'Made from `runner/src/draw-parity.ts` with the table above. `runner/test/unit/draw-parity.test.ts`',
    "reads every kind of thing the desktop draws from `desktop/core` and fails when one has no row",
    "(printing the line to paste), and checks each Yes against that app's code. A row still as",
    `pasted (\`${PASTED_NO}\` for all three) is left out of this table.`,
    '',
  ];
  for (const [family, heading] of Object.entries(FAMILIES)) {
    const pasted = (r: DrawRow) => PLATFORMS.every((p) => r[p] !== 'yes' && r[p].no === PASTED_NO);
    const rows = Object.entries(DRAWN).filter(([k, r]) => k.startsWith(`${family}.`) && !pasted(r));
    if (rows.length === 0) continue;
    out.push(`## ${heading}`, '', '| What | Kind | iPhone | Android | Website |', '|---|---|---|---|---|');
    const score = (r: DrawRow) => PLATFORMS.filter((p) => r[p] === 'yes').length;
    rows.sort(([, a], [, b]) => score(b) - score(a));
    for (const [k, r] of rows) out.push(`| ${r.what} | \`${k}\` | ${cell(r.ios)} | ${cell(r.android)} | ${cell(r.web)} |`);
    out.push('');
  }
  return out.join('\n');
}
