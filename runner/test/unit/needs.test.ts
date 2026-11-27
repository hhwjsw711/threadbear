import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PersistedEvent } from '../../src/protocol.ts';
import { AGENT_MESSAGE_PREFIX } from '../../src/protocol.ts';
import { handsOverAStep, offersToTakeItBack, PLAIN_CARD_NUDGE, plainCardNudge, plainCardNudged, wantsPlainCard, TRY_IT_FIRST, tryFirstNudge, archiveFromTool, snoozeFromTool, bylineFromTool, endedThisTurn, CODEX_END_TURN_DESCRIPTION, CODEX_ONE_REPLY_DESCRIPTION, END_TURN_DESCRIPTION, END_TURN_FULL_NAME, endTurnDescription, needsFromText, needsFromTool, ONE_REPLY_DESCRIPTION, replyAsks, replyAsksNudge, replyWithoutRepeat, splitReplySection, projectStepNudge, summaryFromTool, summaryMarkdown, turnReply, unansweredItems } from '../../src/needs.ts';
import { END_TURN_TOOL } from '../../src/needs.ts';
import { SERVER_NAME } from '../../src/threadbear-mcp.ts';
import { ClaudeNormalizer, fileContext } from '../../src/adapters/claude/normalize.ts';

test('end_turn input: nothing, you with asks, and junk falls back', () => {
  assert.deepEqual(needsFromTool({ needs: 'nothing', asks: [{ action: 'ignored' }] }), { needs: 'nothing' });
  assert.deepEqual(
    needsFromTool({ needs: 'you', asks: [{ action: ' Paste the key ', where: 'Settings › Models', reply: 'done' }, { action: '' }, 'x', { action: 'Pick a budget', where: '' }] }),
    { needs: 'you', asks: [{ action: 'Paste the key', where: 'Settings › Models', reply: 'done' }, { action: 'Pick a budget' }] },
  );
  assert.deepEqual(needsFromTool({ needs: 'you' }), { needs: 'you' });
  // askWhen "jobsEnd": the asks wait for the thread's own shell jobs.
  assert.deepEqual(needsFromTool({ needs: 'you', askWhen: 'jobsEnd' }), { needs: 'you', afterJobs: true });
  assert.deepEqual(needsFromTool({ asks: [{ question: 'Ship it?' }], askWhen: 'jobsEnd' }), { needs: 'you', asks: [{ action: 'Ship it?' }], afterJobs: true });
  assert.deepEqual(needsFromTool({ needs: 'you', askWhen: 'now' }), { needs: 'you' });
  assert.deepEqual(needsFromTool({ needs: 'nothing', askWhen: 'jobsEnd' }), { needs: 'nothing' });
  assert.equal(needsFromTool({ needs: 'maybe' }), undefined);
  // archive only counts with needs "nothing": a thread that asks for something stays in the inbox.
  assert.equal(archiveFromTool({ needs: 'nothing', archive: true }), true);
  assert.equal(archiveFromTool({ needs: 'you', archive: true }), false);
  assert.equal(archiveFromTool({ needs: 'nothing', archive: 'yes' }), false);
  assert.equal(archiveFromTool({ needs: 'nothing' }), false);
  assert.equal(archiveFromTool(undefined), false);
  assert.equal(snoozeFromTool({ needs: 'nothing', snooze: ' 2h ' }), '2h');
  assert.equal(snoozeFromTool({ needs: 'you', snooze: '2h' }), undefined);
  assert.equal(snoozeFromTool({ needs: 'nothing', snooze: 'off' }), undefined);
  assert.equal(snoozeFromTool({ needs: 'nothing', snooze: '' }), undefined);
  assert.equal(snoozeFromTool({ snooze: 'when the phone arrives' }), 'when the phone arrives');
  assert.equal(needsFromTool(null), undefined);
  assert.equal(needsFromTool({ needs: 'you', asks: Array.from({ length: 20 }, (_, i) => ({ action: `a${i}` })) })!.asks!.length, 10);
});

test('end_turn input: next steps go with needs nothing only', () => {
  // Mike, 30 Oct: follow-ups in the prose got lost under a done card.
  assert.deepEqual(needsFromTool({ needs: 'nothing', next: [' Show Mac mini pictures ', '', 7, 'Show Mac mini pictures', 'Start Mac mini threads'] }), {
    needs: 'nothing',
    next: ['Show Mac mini pictures', 'Start Mac mini threads'],
  });
  assert.deepEqual(needsFromTool({ summary: ['Done.'], next: ['Do the next bit'] }), { needs: 'nothing', next: ['Do the next bit'] });
  assert.equal(needsFromTool({ needs: 'nothing', next: ['a', 'b', 'c', 'd'] })!.next!.length, 3);
  assert.equal(needsFromTool({ needs: 'nothing', next: ['x'.repeat(500)] })!.next![0].length, 120);
  assert.deepEqual(needsFromTool({ needs: 'nothing', next: 'not a list' }), { needs: 'nothing' });
  // A card of asks has its own buttons.
  assert.deepEqual(needsFromTool({ needs: 'you', asks: [{ action: 'Pick one' }], next: ['Later'], nextPick: 'one', nextSuggested: 0 }), { needs: 'you', asks: [{ action: 'Pick one' }] });
  // Pick-one mode and recommendation: only with 2+ items, remapped through dedup.
  assert.deepEqual(needsFromTool({ needs: 'nothing', next: ['Option A', 'Option B'], nextPick: 'one', nextSuggested: 1 }), {
    needs: 'nothing',
    next: ['Option A', 'Option B'],
    nextPick: 'one',
    nextSuggested: 1,
  });
  // Deduping an earlier duplicate remaps nextSuggested to the kept item's new index.
  assert.deepEqual(needsFromTool({ needs: 'nothing', next: ['First', '', 'First', 'Second'], nextPick: 'one', nextSuggested: 3 }), {
    needs: 'nothing',
    next: ['First', 'Second'],
    nextPick: 'one',
    nextSuggested: 1,
  });
  // Single item drops nextPick and nextSuggested; "any" omits them; out-of-range drops nextSuggested.
  assert.deepEqual(needsFromTool({ needs: 'nothing', next: ['Only one'], nextPick: 'one', nextSuggested: 0 }), {
    needs: 'nothing',
    next: ['Only one'],
  });
  assert.deepEqual(needsFromTool({ needs: 'nothing', next: ['A', 'B'], nextPick: 'any', nextSuggested: 0 }), {
    needs: 'nothing',
    next: ['A', 'B'],
  });
  assert.deepEqual(needsFromTool({ needs: 'nothing', next: ['A', 'B'], nextPick: 'one', nextSuggested: 5 }), {
    needs: 'nothing',
    next: ['A', 'B'],
    nextPick: 'one',
  });
  assert.deepEqual(needsFromTool({ needs: 'nothing', next: ['A', 'B'], nextSuggested: 0 }), {
    needs: 'nothing',
    next: ['A', 'B'],
  });
});

test('end_turn input: needs left out comes from the asks', () => {
  // Agents filling in a summary forgot needs 2 times in 9 (29 Oct 2026).
  assert.deepEqual(needsFromTool({ asks: [{ action: 'Paste the key', why: 'For the deploy.' }] }), { needs: 'you', asks: [{ action: 'Paste the key', why: 'For the deploy.' }] });
  assert.deepEqual(needsFromTool({ summary: ['Fixed it.'] }), { needs: 'nothing' });
  assert.deepEqual(needsFromTool({ asks: [{ action: '' }] }), { needs: 'nothing' });
  assert.deepEqual(needsFromTool({}), { needs: 'nothing' });
  assert.equal(archiveFromTool({ archive: true }), true);
  assert.equal(archiveFromTool({ archive: true, asks: [{ action: 'Look' }] }), false);
});

test('end_turn summary: bullets kept tidy, a few at most, none is undefined', () => {
  assert.deepEqual(summaryFromTool({ summary: ['- Fixed the slug bug.', ' • [Tests pass](work:npm test) ', '', 3, '* Committed as `b08255b`.'] }), ['Fixed the slug bug.', '[Tests pass](work:npm test)', 'Committed as `b08255b`.']);
  assert.equal(summaryFromTool({ summary: [] }), undefined);
  assert.equal(summaryFromTool({ summary: 'Fixed it.' }), undefined);
  assert.equal(summaryFromTool({ needs: 'nothing' }), undefined);
  assert.equal(summaryFromTool({ summary: Array.from({ length: 12 }, (_, i) => `b${i}`) })!.length, 8);
  assert.equal(summaryFromTool({ summary: ['x'.repeat(600)] })![0].length, 400);
  assert.equal(summaryMarkdown(['One.', 'Two.']), '- One.\n- Two.');
});

test("end_turn's description asks for a short summary with links into the thread", () => {
  for (const d of [END_TURN_DESCRIPTION, CODEX_END_TURN_DESCRIPTION]) {
    assert.match(d, /summary/);
    assert.match(d, /work:/);
    assert.match(d, /thread:/);
  }
});

test('end_turn input: a decision keeps its why, options and a valid pick', () => {
  assert.deepEqual(
    needsFromTool({ needs: 'you', asks: [{ action: 'Merge #52?', why: ' Preview is green. ', options: ['Merge', ' ', 'Test locally', 3], suggested: 1 }] }),
    { needs: 'you', asks: [{ action: 'Merge #52?', why: 'Preview is green.', options: ['Merge', 'Test locally'], suggested: 1 }] },
  );
  // A pick that isn't one of the options is dropped, and so is one with no options.
  assert.deepEqual(needsFromTool({ needs: 'you', asks: [{ action: 'a', options: ['x'], suggested: 4 }] })!.asks, [{ action: 'a', options: ['x'] }]);
  assert.deepEqual(needsFromTool({ needs: 'you', asks: [{ action: 'a', options: [], suggested: 0 }] })!.asks, [{ action: 'a' }]);
  assert.equal(needsFromTool({ needs: 'you', asks: [{ action: 'a', options: Array.from({ length: 9 }, (_, i) => `o${i}`) }] })!.asks![0].options!.length, 6);
});

// Thread 95e13589, 17 Nov 2026: an older-form ask listed its two options in
// why, in the other order, with "(my pick)" on one, as well as giving them as
// buttons, and the card showed the list instead of notes under the buttons.
test('end_turn input: a why that lists the options again becomes their notes', () => {
  const why = 'Right now a release only reaches followers. Should an admin be able to announce it to everyone?\n- Followers only (simplest)\n- Followers by default, with an "announce to everyone" switch per release (my pick)';
  assert.deepEqual(needsFromTool({ needs: 'you', asks: [{ action: 'Decide who sees a release.', why, options: ['Add an announce switch', 'Followers only'], suggested: 0 }] })!.asks, [
    {
      action: 'Decide who sees a release.',
      why: 'Right now a release only reaches followers. Should an admin be able to announce it to everyone?',
      options: ['Add an announce switch', 'Followers only'],
      optionNotes: ['Followers by default, with an "announce to everyone" switch per release', 'Followers only (simplest)'],
      suggested: 0,
    },
  ]);
  // Several questions, or a list that doesn't match the buttons one for
  // one, stays in the text.
  const questions = 'Two things:\n- Which region?\n- How many replicas?';
  assert.equal(needsFromTool({ needs: 'you', asks: [{ action: 'a', why: questions, options: ['Sydney', 'Tokyo'] }] })!.asks![0].why, questions);
  const three = 'Pick one:\n- Merge it\n- Test it\n- Close it';
  assert.equal(needsFromTool({ needs: 'you', asks: [{ action: 'a', why: three, options: ['Merge', 'Test'] }] })!.asks![0].why, three);
  // Notes the agent gave itself win.
  const own = needsFromTool({ needs: 'you', asks: [{ question: 'Merge it?\n- Merge now\n- Test first', options: [{ label: 'Merge', does: 'I merge' }, { label: 'Test' }] }] })!.asks![0];
  assert.deepEqual(own.optionNotes, ['I merge', '']);
});

test('end_turn input: links to go and do the thing, web or local, a few at most', () => {
  const asks = needsFromTool({
    needs: 'you',
    asks: [{
      action: 'Log in to Hugging Face',
      links: [
        { title: ' Open login page ', url: 'https://huggingface.co/login' },
        { title: 'Notes', url: '~/dev/notes.md' },
        { title: 'Spec', url: '/Users/m/spec.md' },
        { title: 'Bad scheme', url: 'javascript:alert(1)' },
        { title: '', url: 'https://example.com' },
        { title: 'No url' },
        'junk',
        { title: 'Fourth good one', url: 'http://localhost:3000' },
      ],
    }],
  })!.asks!;
  assert.deepEqual(asks[0].links, [
    { title: 'Open login page', url: 'https://huggingface.co/login' },
    { title: 'Notes', url: '~/dev/notes.md' },
    { title: 'Spec', url: '/Users/m/spec.md' },
  ]);
  assert.equal(needsFromTool({ needs: 'you', asks: [{ action: 'a', links: [] }] })!.asks![0].links, undefined);
});

test('end_turn input: a link can open one of the thread\'s reviews', () => {
  const asks = needsFromTool({
    needs: 'you',
    asks: [{
      action: 'Pick a banner',
      links: [
        { title: 'Compare banners', url: 'review:5f1c2a90-1b2c-4d5e-8f90-0a1b2c3d4e5f' },
        { title: 'Empty', url: 'review:' },
        { title: 'Odd', url: 'review:<script>' },
      ],
    }],
  })!.asks!;
  assert.deepEqual(asks[0].links, [{ title: 'Compare banners', url: 'review:5f1c2a90-1b2c-4d5e-8f90-0a1b2c3d4e5f' }]);
});

test('the section: a bold heading then a numbered list, with a reply phrase', () => {
  const text = [
    'The Settings window is in.',
    '',
    '**What I need from you**',
    '',
    '1. Open Settings > Models, paste your OpenRouter key, then reply "key set".',
    '   It only needs a small credit limit.',
    '',
    '2. Say whether **$1 a day** is right.',
    '',
    "Meanwhile I'll keep going on the app side.",
  ].join('\n');
  assert.deepEqual(needsFromText(text), {
    needs: 'you',
    asks: [
      { action: 'Open Settings > Models, paste your OpenRouter key, then reply "key set". It only needs a small credit limit.', reply: 'key set' },
      { action: 'Say whether $1 a day is right.' },
    ],
  });
});

test('the section: "nothing needed" under the heading, on its line, or with no heading', () => {
  assert.deepEqual(needsFromText('Done.\n\n**What I need from you**\n\nNothing needed from you right now. It is finished.'), { needs: 'nothing' });
  assert.deepEqual(needsFromText('Done.\n\n**What I need from you:** nothing right now. Still building.'), { needs: 'nothing' });
  assert.deepEqual(needsFromText('Done.\n\nNothing needed from you right now, the work is done. Next step: archive it.'), { needs: 'nothing' });
  assert.deepEqual(needsFromText('I wrote the file. The task is finished, and nothing is needed from you right now.'), { needs: 'nothing' });
});

test('the section: follow-ups listed after "nothing needed" are the done card\'s next', () => {
  // Thread 13096d04's last message (30 Oct 2026), which skipped end_turn.
  const text = [
    "Meeting Archive is running again on your Mac. I've checked it myself: it's up.",
    '',
    'So everything from this thread is now live:',
    '- **On your Mac:** the app records calls again.',
    '- **On Mac mini:** new calls get their speakers labelled by Nemotron 3 Diarization.',
    '',
    'Nothing needed from you right now; the work is finished. Two follow-ups are worth doing:',
    "- **Check your next call:** confirm Mac mini actually used Nemotron on it. Its background service is the one setup I couldn't test before deploying.",
    '- **Try a bigger Whisper model:** the transcribed words are now the weaker part of the notes.',
  ].join('\n');
  assert.deepEqual(needsFromText(text), {
    needs: 'nothing',
    next: ['Check your next call: confirm Mac mini actually used Nemotron on it', 'Try a bigger Whisper model: the transcribed words are now the weaker part of the notes'],
  });
  // A line of lead-in, a cap of three, and long ones cut at a word.
  const many = ['Nothing needed from you right now.', '', 'Worth doing next:', '', '1. One', '2. Two', '3. Three', '4. Four'].join('\n');
  assert.deepEqual(needsFromText(many), { needs: 'nothing', next: ['One', 'Two', 'Three'] });
  const long = needsFromText(`Nothing needed from you right now.\n- ${'word '.repeat(40)}`)!;
  assert.ok(long.next![0].length <= 120 && long.next![0].endsWith('word'));
  // Prose after it, or a list before it, is no follow-up.
  assert.deepEqual(needsFromText('Nothing needed from you right now. If you want, I can compare them.'), { needs: 'nothing' });
  assert.deepEqual(needsFromText('Done:\n- a\n- b\n\nNothing needed from you right now.'), { needs: 'nothing' });
  assert.deepEqual(needsFromText('Nothing needed from you right now.\n\nThe tests pass and it is on main.\nMore prose.\n- not a follow-up'), { needs: 'nothing' });
  // Under the heading too: "nothing" and then a list is follow-ups, not asks.
  assert.deepEqual(needsFromText('**What I need from you**\n\nNothing right now. Worth doing next:\n- Try the bigger model.'), { needs: 'nothing', next: ['Try the bigger model'] });
});

test('the section: the last heading wins, a mention in a sentence does not count', () => {
  const text = [
    'Agents end with a **What I need from you** section, which we could parse.',
    '',
    '**What I need from you**',
    '',
    '- Reply "go" to build it.',
  ].join('\n');
  assert.deepEqual(needsFromText(text), { needs: 'you', asks: [{ action: 'Reply "go" to build it.', reply: 'go' }] });
  assert.equal(needsFromText('It reads the "What I need from you" heading. I will report back.'), undefined);
  assert.equal(needsFromText('All done here.'), undefined);
});

test('the section: a # heading, and prose under it with no list is one ask', () => {
  assert.deepEqual(needsFromText('## What I need from you\n\n1. Say yes or no.'), { needs: 'you', asks: [{ action: 'Say yes or no.' }] });
  assert.deepEqual(needsFromText('**What I need from you**\n\nRestart the app when you get a minute.'), { needs: 'you', asks: [{ action: 'Restart the app when you get a minute.' }] });
});

test('the section: choices under an ask stay with it, and a choice is not a reply', () => {
  const text = [
    '**What I need from you**',
    '',
    '1. Pick a fix and reply with it:',
    '   - "fix it": I make the tests work.',
    '   - "leave it": nothing changes.',
    '2. Decide on the filter. Reply "filter" or "wait".',
  ].join('\n');
  assert.deepEqual(needsFromText(text), {
    needs: 'you',
    asks: [
      { action: 'Pick a fix and reply with it: "fix it": I make the tests work. "leave it": nothing changes.' },
      { action: 'Decide on the filter. Reply "filter" or "wait".', options: ['filter', 'wait'] },
    ],
  });
});

// Fable skipped end_turn and wrote this; the card had one button (28 Oct 2026).
test('the section: every quoted answer in a list is a choice', () => {
  const ask = (line: string) => needsFromText(`**What I need from you**\n\n1. ${line}`)!.asks![0];
  assert.deepEqual(
    ask('Say whether to keep "Browser" or rename the row to "Website". Reply with "Land it", "Website, then land it", or what else to change.').options,
    ['Land it', 'Website, then land it'],
  );
  assert.deepEqual(ask('Reply "merge", "wait" or "close".').options, ['merge', 'wait', 'close']);
  assert.deepEqual(ask('Reply “yes” / “no”.').options, ['yes', 'no']);
  // A quote that isn't straight after the reply word isn't one of them.
  assert.deepEqual(ask('Reply "go" when the "Export" step is done.'), { action: 'Reply "go" when the "Export" step is done.', reply: 'go' });
});

test('the section: a code block in an ask stays in it', () => {
  const text = '**What I need from you**\n\n1. Run this:\n```\n- not an item\n```\nThen reply "done".';
  assert.deepEqual(needsFromText(text), { needs: 'you', asks: [{ action: 'Run this: ``` - not an item ``` Then reply "done".', reply: 'done' }] });
});

// ------------------------------------------------------------ turnReply

// Events as the thread's log has them, seq in order, with only the fields
// the check reads.
function log(...items: (Record<string, unknown> & { type: string })[]): PersistedEvent[] {
  return items.map((e, i) => ({ seq: i + 1, ts: '2026-10-28T06:10:00Z', threadId: 't', ...e }) as unknown as PersistedEvent);
}
const END = END_TURN_FULL_NAME;
const user = (text = 'hi') => ({ type: 'user.message', text, images: [] });
const started = { type: 'turn.started', turnId: 'turn-1' };
const text = (text: string, itemId = 'm1') => ({ type: 'assistant.text', itemId, text });
const thought = (itemId = 'r1') => ({ type: 'reasoning', itemId, text: 'Custom firmware would not help much.' });
const call = (itemId: string, name: string) => ({ type: 'tool.call', itemId, name, kind: 'mcp', title: name, input: {} });
const result = (itemId: string) => ({ type: 'tool.result', itemId, ok: true, text: '', truncated: false, images: [] });

test('turnReply: the full tool name is the one the server registers', () => {
  assert.equal(END, `mcp__${SERVER_NAME}__${END_TURN_TOOL}`);
});

test('turnReply: a message, then end_turn, is a reply; thinking and tool calls alone are not', () => {
  assert.deepEqual(turnReply(log(user(), started, thought(), text('No, the camera is not where the delay is.'), call('e1', END))), { landed: true, replied: true });
  // What happened on 28 Oct: the answer drafted in thinking, two commands, then end_turn.
  assert.deepEqual(turnReply(log(user(), started, thought(), call('b1', 'Bash'), result('b1'), call('b2', 'Bash'), result('b2'), thought('r2'), call('e1', END))), { landed: true, replied: false });
  // A progress line, then more work, then end_turn: the line isn't the answer.
  assert.deepEqual(turnReply(log(user(), started, text('Found it, checking one thing.'), call('s1', 'mcp__agent-archive__search_archive'), result('s1'), call('e1', END))), { landed: true, replied: false });
  // Nothing at all.
  assert.deepEqual(turnReply(log(user(), started, call('e1', END))), { landed: true, replied: false });
});

test("turnReply: the thread's own tools after the message don't count as work, nor does a refused end_turn", () => {
  const own = `mcp__${SERVER_NAME}__pin`;
  assert.deepEqual(turnReply(log(user(), started, text('Done, pinned.'), call('p1', own), result('p1'), call('e1', END))), { landed: true, replied: true });
  // Loading end_turn's deferred schema isn't work either (a Haiku thread was refused for it, 28 Oct).
  assert.deepEqual(turnReply(log(user(), started, text('Hello.'), call('ts', 'ToolSearch'), result('ts'), call('e1', END))), { landed: true, replied: true });
  // Refused once, the reply written, called again.
  assert.deepEqual(turnReply(log(user(), started, call('b1', 'Bash'), result('b1'), call('e1', END), result('e1'), text('All green.'), call('e2', END))), { landed: true, replied: true });
  // A tool still running (no result) isn't work done after the message.
  assert.deepEqual(turnReply(log(user(), started, call('b1', 'Bash'), text('Started the build; back when it finishes.'), call('e1', END))), { landed: true, replied: true });
});

test('turnReply: only the current turn counts, and a message from Alex mid-turn wants a reply of its own', () => {
  // Last turn's answer doesn't carry over.
  assert.deepEqual(turnReply(log(user(), { type: 'turn.started', turnId: 'turn-0' }, text('Earlier answer.'), { type: 'turn.completed', turnId: 'turn-0', outcome: 'completed', durationMs: 1 }, user('again'), started, call('e1', END))), { landed: true, replied: false });
  assert.deepEqual(turnReply(log(user(), started, text('Working on it.'), user('also do X'), call('e1', END))), { landed: true, replied: false });
  assert.deepEqual(turnReply(log(user(), started, text('Working on it.'), user('also do X'), text('Did X too.', 'm2'), call('e1', END))), { landed: true, replied: true });
});

test('endedThisTurn: a message after the taken end_turn opens it again, even one sent while the call ran', () => {
  const noted = { ...result('e1'), text: 'Noted: this thread is done.' } as never;
  assert.equal(endedThisTurn(log(user(), started, call('e1', END), noted)), true);
  assert.equal(endedThisTurn(log(user(), started, call('e1', END), noted, user('Archive'))), false);
  // Sent before the result came back: the agent called it without having seen the message.
  assert.equal(endedThisTurn(log(user(), started, call('e1', END), user('Archive'), noted)), false);
  // And one taken after the message ends it again.
  assert.equal(endedThisTurn(log(user(), started, call('e1', END), noted, user('Archive'), call('e2', END), { ...result('e2'), text: 'Noted: this thread is done.' } as never)), true);
});

test("turnReply: not landed until the call is in the events; a Codex child's items are ignored", () => {
  assert.deepEqual(turnReply(log(user(), started, text('Done.'))), { landed: false, replied: true });
  assert.deepEqual(turnReply(log(user(), started, call('b1', 'Bash'), result('b1'))), { landed: false, replied: false });
  // The child's text and its own end_turn are not the thread's.
  assert.deepEqual(turnReply(log(user(), started, text('Done.'), call('child/b1', 'Bash'), result('child/b1'), call('child/e1', END), call('e1', END))), { landed: true, replied: true });
});

// The 29 Oct refusals (threads 1edccf6f and ec75fe8b): the reply came as a
// thinking block signed as narration, straight before end_turn, after a
// create_thread result. Run the CLI's frames through the Claude normaliser
// as the runner does: that reply counts, and a plain thought still doesn't.
test('turnReply: a reply the CLI sent as a narration block counts; a thought before end_turn still does not', () => {
  const sig = (kind: string) => Buffer.concat([Buffer.from('0804128e110a11081318023801', 'hex'), Buffer.from([0x42, kind.length]), Buffer.from(kind)]).toString('base64');
  const turn = (kind: string) => {
    const n = new ClaudeNormalizer(fileContext('/work', '/nowhere/media', '/nowhere/blobs'));
    n.sent();
    const frame = (id: string, content: unknown[]) => ({ type: 'assistant', message: { id, content }, parent_tool_use_id: null });
    const evs = [
      frame('m1', [{ type: 'tool_use', id: 'c1', name: 'mcp__threadbear__create_thread', input: {} }]),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Started thread 3fee4428' }] }, parent_tool_use_id: null },
      frame('m2', [{ type: 'thinking', thinking: 'Wrap up.', signature: sig('thinking') }]),
      frame('m2', [{ type: 'thinking', thinking: "I've started a thread to fix the refusals.", signature: sig(kind) }]),
      frame('m2', [{ type: 'tool_use', id: 'e1', name: END, input: { needs: 'nothing' } }]),
    ]
      .flatMap((m) => n.handle(m))
      .flatMap((o) => (o.kind === 'event' ? [o.event as Record<string, unknown> & { type: string }] : []));
    return turnReply(log(user(), started, ...evs));
  };
  // Its text is only the API's summary of what the agent wrote.
  assert.deepEqual(turn('narration'), { landed: true, replied: true, narrationOnly: true });
  assert.deepEqual(turn('thinking'), { landed: true, replied: false });
});

test('turnReply: a reply in words after a narration block is not narration-only; one before work does not count', () => {
  const narrated = (itemId: string) => ({ type: 'assistant.text', itemId, text: 'I sent the steps.', narration: true });
  assert.deepEqual(turnReply(log(user(), started, narrated('a'), call('e1', END))), { landed: true, replied: true, narrationOnly: true });
  assert.deepEqual(turnReply(log(user(), started, narrated('a'), text('Step 1: ...', 'b'), call('e1', END))), { landed: true, replied: true });
  assert.deepEqual(turnReply(log(user(), started, text('Step 1: ...', 'b'), narrated('a'), call('e1', END))), { landed: true, replied: true });
  // Words before work, then only narration since: narration-only.
  assert.deepEqual(turnReply(log(user(), started, text('Checking.', 'b'), call('b1', 'Bash'), result('b1'), narrated('a'), call('e1', END))), { landed: true, replied: true, narrationOnly: true });
  // A status line, then Threadbear's own read tools, then the answer as
  // narration (29 Oct 2026): the status line isn't the reply.
  const read = 'mcp__threadbear__read_thread';
  assert.deepEqual(turnReply(log(user(), started, text('Looking into it.', 'b'), call('r1', read), result('r1'), narrated('a'), call('e1', END))), { landed: true, replied: true, narrationOnly: true });
  // The same with ToolSearch loading end_turn between them.
  assert.deepEqual(turnReply(log(user(), started, text("I'll lay out three designs.", 'b'), call('t1', 'ToolSearch'), result('t1'), narrated('a'), call('e1', END))), { landed: true, replied: true, narrationOnly: true });
  // Words, then a pin, then end_turn: the words are the reply.
  assert.deepEqual(turnReply(log(user(), started, text('Step 1: ...', 'b'), call('p1', 'mcp__threadbear__pin'), result('p1'), call('e1', END))), { landed: true, replied: true });
});

test("end_turn's description asks for the words naming a link's target to be that link", () => {
  // Mike, 29 Oct: plain "the screenshots in Highlights" over a button for the same screenshot.
  for (const d of [END_TURN_DESCRIPTION, CODEX_END_TURN_DESCRIPTION]) assert.match(d, /make those words a link to the same url/);
});

test('with bullet replies off, end_turn asks for a normal message first', () => {
  assert.equal(endTurnDescription('claude', true), END_TURN_DESCRIPTION);
  assert.equal(endTurnDescription('codex', true), CODEX_END_TURN_DESCRIPTION);
  assert.match(endTurnDescription('claude', false), /Write your reply as an ordinary message/);
  assert.match(endTurnDescription('claude', false), /refused until the turn has that message/);
  assert.match(endTurnDescription('codex', false), /Write your reply as your final answer/);
  for (const provider of ['claude', 'codex'] as const) {
    assert.doesNotMatch(endTurnDescription(provider, false), /the bullets are the reply|one short line/);
    assert.match(endTurnDescription(provider, false), /make those words a link to the same url/);
  }
});

test('a byline is one short line, or nothing', () => {
  assert.equal(bylineFromTool({ byline: ' network blip,\n sorted ' }), 'network blip, sorted');
  assert.equal(bylineFromTool({ byline: '   ' }), undefined);
  assert.equal(bylineFromTool({ byline: 3 }), undefined);
  assert.equal(bylineFromTool(undefined), undefined);
  assert.equal(bylineFromTool({ byline: 'x'.repeat(200) })?.length, 80);
});

test('the card text is cut at a word with an ellipsis, never mid-word', () => {
  const why = 'Or step away from the keyboard and say "go", and I\'ll do the picker myself, though you might see it move. '.repeat(8);
  const ask = needsFromTool({ asks: [{ action: 'Add the runner to Full Disk Access.', why }] })?.asks?.[0];
  assert.ok(ask?.why && ask.why.length <= 500);
  assert.match(ask!.why!, /\w…$/);
  assert.doesNotMatch(ask!.why!, / \w…$/, 'not a single letter before the ellipsis');
});

test('one reply: its description says the reply comes after end_turn, and keeps the card out of it', () => {
  assert.equal(endTurnDescription('claude', true, true), ONE_REPLY_DESCRIPTION);
  assert.equal(endTurnDescription('codex', false, true), CODEX_ONE_REPLY_DESCRIPTION);
  assert.match(ONE_REPLY_DESCRIPTION, /write your reply as ordinary text straight after it/);
  assert.match(ONE_REPLY_DESCRIPTION, /Never write a "What I need from you" section/);
  assert.match(CODEX_ONE_REPLY_DESCRIPTION, /your final answer/);
  // Far shorter than the bullets' one.
  assert.ok(ONE_REPLY_DESCRIPTION.length < END_TURN_DESCRIPTION.length * 0.6);
});

test('one reply: a closing section comes off the reply, bold, # or a bare line', () => {
  const bare = splitReplySection("Fixed it.\n\nWhat I need from you:\n1. Tell me whether to deploy.\n2. Check the logs.");
  assert.equal(bare.reply, 'Fixed it.');
  assert.equal(bare.needs?.needs, 'you');
  assert.equal(bare.needs?.asks?.length, 2);
  const heading = splitReplySection('Fixed it.\n\n## What I need from you\n1. Run it with your key.');
  assert.equal(heading.reply, 'Fixed it.');
  assert.equal(heading.needs?.asks?.[0].action, 'Run it with your key.');
  const nothing = splitReplySection('Fixed and committed.\n\nNothing needed from you right now.\n\n- Check it on production tomorrow');
  assert.equal(nothing.reply, 'Fixed and committed.');
  assert.deepEqual(nothing.needs, { needs: 'nothing', next: ['Check it on production tomorrow'] });
  // A mention in a sentence isn't a section, and a reply with none is kept whole.
  const none = splitReplySection('The script says nothing needed from you is wrong, so I fixed it.');
  assert.equal(none.needs, undefined);
  assert.equal(none.reply, 'The script says nothing needed from you is wrong, so I fixed it.');
});

// Thread 649fc651 (21 Nov 2026): asked "Anything you need from me here?", the
// agent's reply opened "Nothing needed from you." and went on for two
// paragraphs. Everything from that line down came off as the closing
// section, which was the whole reply, and Mike got a blank answer.
test('one reply: a "Nothing needed from you" line comes off only as a closing section the card shows all of', () => {
  const nothing = { needs: 'nothing' as const };
  const whole = (reply: string, needs: object = nothing, why = reply) => assert.deepEqual(splitReplySection(reply), { reply, needs }, why);
  // The answer opens with it and says more on the same line and after it.
  whole('Nothing needed from you. The sprinklers are on Auto, and the next run is Monday at 6:00.\n\nThe only thing outstanding is the re-test. This thread is asleep until then.');
  // More on the line that the card doesn't show: the line stays.
  whole('Sent the form.\n\nNothing needed from you right now. This picks up again by itself on 23 Nov.');
  whole("Drafted the post.\n\nNothing needed from you right now apart from posting that in Slack when you're ready.");
  for (const line of ['Nothing needed from you right now.', '**Nothing needed from you.**', 'Nothing else is needed from you for now']) {
    // The bare line closing a reply comes off, as before.
    assert.deepEqual(splitReplySection(`Fixed and committed.\n\n${line}\n`), { reply: 'Fixed and committed.', needs: nothing }, line);
    // Words after it aren't on the card, so it isn't a closing section.
    whole(`${line}\n\nThe deploy is still going.\nIt takes about ten minutes.`, nothing, line);
    whole(`Fixed.\n\n${line}\n\nThe deploy is still going.`, nothing, line);
    // A reply that is only the line stays as written: the done card has no words of its own.
    whole(line, nothing, line);
  }
  whole('**What I need from you:** nothing right now.');
  // A plain list of follow-ups straight under it goes to the card with it.
  const next = { needs: 'nothing' as const, next: ['Check it on production tomorrow'] };
  const item = '- Check it on production tomorrow.';
  assert.deepEqual(splitReplySection('Fixed.\n\n**Nothing needed from you right now.**\n\n- Check it on production tomorrow\n'), { reply: 'Fixed.', needs: next });
  assert.deepEqual(splitReplySection('Fixed.\n\nNothing needed from you.\n1. Check one\n2. Check `two`!\n3. See   v1.2'), { reply: 'Fixed.', needs: { needs: 'nothing', next: ['Check one', 'Check `two`!', 'See v1.2'] } });
  // Words after the list aren't on the card.
  whole(`Fixed.\n\nNothing needed from you right now.\n${item}\n\nThe deploy is still going.`, next);
  // Nor is a lead-in, on the line or under it, short or not: it may be news (from Codex's and Gemini's reviews).
  for (const section of [
    `Nothing needed from you right now. One follow-up is worth doing:\n\n${item}`,
    `Nothing needed from you right now.\n\nWorth doing next:\n${item}`,
    `Nothing needed from you.\nOnly after the backup finishes:\n${item}`,
    `Nothing needed from you.\nThe database is still offline.\n${item}`,
    `Nothing needed from you. The database is still offline; my next step is:\n${item}`,
    `Nothing needed from you right now apart from posting these when you're ready:\n${item}`,
    `Nothing needed from you right now. The deploy finished at 3pm.\n\nWorth doing next:\n${item}`,
    `Nothing needed from you right now.\n\nThe sprinklers are on Auto, and the next run is Monday at 6:00. This thread is asleep until then.\n\n${item}`,
  ]) whole(`Fixed.\n\n${section}`, next, section);
  // A follow-up that says more than its row on the card: a why, a line under it, a link, a command.
  whole(`Fixed.\n\nNothing needed from you right now.\n${item} It needs a real login.`, next);
  whole(`Fixed.\n\nNothing needed from you right now.\n${item}\n  It needs a real login.`, next);
  whole('Fixed.\n\nNothing needed from you right now.\n- Check it on [production](https://example.com/admin) tomorrow', { needs: 'nothing', next: ['Check it on production tomorrow'] });
  whole(`Fixed.\n\nNothing needed from you right now.\n${item}\n  \`\`\`bash\n  curl -fsS https://example.com/health\n  \`\`\``, next);
  // ...with or without a full stop on the item (from Gemini's second review): lines under it are read into its row.
  const bare = '- Check it on production tomorrow';
  whole(`Fixed.\n\nNothing needed from you right now.\n${bare}\n  It needs a real login`, { needs: 'nothing', next: ['Check it on production tomorrow It needs a real login'] });
  whole(`Fixed.\n\nNothing needed from you right now.\n${bare}\n  \`\`\`bash\n  curl -fsS https://example.com/health\n  \`\`\``, { needs: 'nothing', next: ['Check it on production tomorrow ```bash curl -fsS https://example.com/health ```'] });
  whole('Fixed.\n\nNothing needed from you right now.\n  - Check one\n  - Check two\n  - Check three\n  - Check four', { needs: 'nothing', next: ['Check one - Check two - Check three - Check four'] });
  whole(`Fixed.\n\nNothing needed from you right now.\n${bare}\n  - on the admin page`, { needs: 'nothing', next: ['Check it on production tomorrow - on the admin page'] });
  // The row takes ** out, bold or not.
  whole('Fixed.\n\nNothing needed from you right now.\n- Run the tests on src/**/*.ts and test/**/*.ts', { needs: 'nothing', next: ['Run the tests on src//*.ts and test//*.ts'] });
  whole('Fixed.\n\nNothing needed from you right now.\n- **Check it** on production tomorrow', next);
  // ...and the item's full stop, which may not be a sentence's (from Codex's reviews).
  whole(`Fixed.\n\nNothing needed from you right now.\n${item}`, next);
  whole('Fixed.\n\nNothing needed from you.\n- Run touch release.', { needs: 'nothing', next: ['Run touch release'] });
  whole('Fixed.\n\nNothing needed from you.\n- Run cd ..', { needs: 'nothing', next: ['Run cd .'] });
  whole('Fixed.\n\nNothing needed from you.\n- Run cp backup .', { needs: 'nothing', next: ['Run cp backup'] });
  // An indented list reads as one item (as it always has), so its other items aren't rows.
  whole('Fixed.\n\nNothing needed from you right now.\n  - Check one.\n  - Check two.\n  - Check three.\n  - Check four.', { needs: 'nothing', next: ['Check one'] });
  // One the card cut for length.
  const long = 'Before restarting the service, inspect the release notes and compare all environment settings against the current production deployment and never reset the production database';
  const cut = splitReplySection(`Updated.\n\nNothing needed from you.\n- ${long}`);
  assert.ok(cut.reply.endsWith(long) && cut.needs?.next?.[0] && cut.needs.next[0].length < long.length);
  // A list after an opening line is the answer, not a closing section.
  whole("Nothing else is needed from you, so it's fine to archive.\n\nWhen the video goes public, I'll:\n\n1. Publish the article. It has the title.\n2. Draft the post.\n\nI also tidied up.", {
    needs: 'nothing',
    next: ['Publish the article', 'Draft the post'],
  });
  // More follow-ups than the card holds, or the same one twice: the list stays.
  whole('Fixed.\n\nNothing needed from you right now.\n- Check one\n- Check two\n- Check three\n- Check four', { needs: 'nothing', next: ['Check one', 'Check two', 'Check three'] });
  whole('Fixed.\n\nNothing needed from you right now.\n- Check one\n- Check one', { needs: 'nothing', next: ['Check one'] });
  // Quoted as output, in an indented code block (from Gemini's review).
  whole('Here is the exact output:\n\n    Nothing needed from you right now.');
  // Line endings and blank lines around a reply that is only the section.
  whole('\r\n\r\nNothing needed from you right now.\r\n');
  assert.deepEqual(splitReplySection('Fixed.\r\n\r\nNothing needed from you right now.\r\n'), { reply: 'Fixed.', needs: nothing });
});

// Thread 7ac017b7 (3 Nov 2026): six of eight replies under a card went on to
// write the card out again, and that looked like not using the card at all.
test('one reply: a section repeating the card comes off the reply, and one saying more stays', () => {
  const card = { needs: 'you' as const, asks: [{ action: 'Press Bring Them In.' }] };
  const repeat = 'It is ready.\n\n**What I need from you**\n1. On build-box, press Bring Them In, then tell me.';
  assert.equal(replyWithoutRepeat(repeat, card), 'It is ready.');
  // What comes after the list isn't on the card, so it stays.
  assert.equal(replyWithoutRepeat(`${repeat}\n  Say how it went.\n\nOne follow-up: try a clash next.`, card), 'It is ready.\n\nOne follow-up: try a clash next.');
  // Two things asked and one on the card: the second is only in the reply.
  const more = 'It is ready.\n\n**What I need from you**\n1. Press Bring Them In.\n2. Send me the log.';
  assert.equal(replyWithoutRepeat(more, card), more);
  // Saying nothing is needed under a card isn't a repeat of it.
  const nothing = 'It is ready. Nothing needed from you right now.';
  assert.equal(replyWithoutRepeat(nothing, card), nothing);
  // No section, and no asks on the card: left alone.
  assert.equal(replyWithoutRepeat('It is ready.', card), 'It is ready.');
  assert.equal(replyWithoutRepeat(repeat, { needs: 'nothing', next: ['Try it'] }), repeat);
});

// Alex pressed ? on rows in the agent's shorthand, with no reason given
// (~/code/misc/end-turn-eval/next-rows). Every form of end_turn has to say
// how to write one, as agents are on all of them.
test('every form of end_turn says how to write a follow-up row', () => {
  for (const provider of ['claude', 'codex'] as const) {
    for (const [bullets, oneReply] of [[true, false], [false, false], [false, true]] as const) {
      const d = endTurnDescription(provider, bullets, oneReply);
      assert.match(d, /with this thread forgotten/);
      assert.match(d, /No names from the code or your working/);
      assert.match(d, /with the reason in the same line/);
      assert.doesNotMatch(d, /about 8 words/);
    }
  }
});

// Mike couldn't follow cards whose buttons were the agent's own names for
// the options ("B: thin machine", 8a971407, 17 Nov). A line in the
// description did nothing in replays; a once-a-turn note did
// (~/dev/me/misc/end-turn-eval/asks), so it's that, and not the description.
test('a card with answers to pick from gets the plain-card note, unless it opens a review', () => {
  assert.ok(wantsPlainCard([{ action: 'Which design?', options: ['B: thin machine', 'C: no machine'] }]));
  assert.ok(wantsPlainCard([{ action: 'Done?' }, { action: 'Deploy?', options: ['Deploy it', 'Hold off'] }]));
  assert.ok(!wantsPlainCard([{ action: 'Run claude setup-token on the Hetzner box.' }]), 'a step with no answers');
  assert.ok(!wantsPlainCard([]));
  // Lettered mockups in a show_options review are fine as they are.
  assert.ok(!wantsPlainCard([{ action: 'Which thumbnail?', options: ['A: glitch', 'B: scanner'], links: [{ title: 'Compare them', url: 'review:abc-123' }] }]));
  assert.ok(wantsPlainCard([{ action: 'Which design?', options: ['B: thin machine'], links: [{ title: 'Read the assessment', url: '/Users/x/assessment.md' }] }]));
  const note = plainCardNudge();
  assert.ok(note.startsWith(PLAIN_CARD_NUDGE));
  assert.match(note, /call end_turn again as it was/);
  assert.match(note, /once a turn/);
  for (const provider of ['claude', 'codex'] as const)
    for (const [bullets, oneReply] of [[true, false], [false, false], [false, true]] as const)
      assert.doesNotMatch(endTurnDescription(provider, bullets, oneReply), /read this card as the user will/, 'not standing context');
});

test('every form of end_turn says to try a step first', () => {
  for (const provider of ['claude', 'codex'] as const) {
    for (const [bullets, oneReply] of [[true, false], [false, false], [true, true]]) {
      const d = endTurnDescription(provider, bullets, oneReply);
      assert.ok(d.includes(TRY_IT_FIRST), `${provider} ${bullets} ${oneReply}`);
      assert.doesNotMatch(d, /when you could plausibly do it yourself/);
    }
  }
});

// On 18 Nov the try-first note, on a "Do it for me / I'll do it" card about
// ~/.aws/config, got an agent to rewrite the file without the user's answer
// (David Clark's fork, 32cda3c2d). Their credentials are theirs to change.
test("the try-first wording counts a change to the user's credentials as theirs", () => {
  for (const text of [TRY_IT_FIRST, tryFirstNudge()]) assert.match(text, /credentials \(~\/\.aws, ~\/\.ssh, Keychain, tokens\)/);
});

test('offersToTakeItBack knows the answers real cards used, and leaves others alone', () => {
  const offers = (o: string) => offersToTakeItBack([{ action: 'x', options: [o] }]);
  for (const o of ['Can you do it?', 'Can you do it in Chrome?', 'Connected, you do it', 'Do it for me later', 'Can you do the copies?', 'Try it yourself']) assert.ok(offers(o), o);
  for (const o of ['Done', 'Signed in', 'Deploy it', "I can't do it", 'Not yet', 'Hold off']) assert.ok(!offers(o), o);
  assert.ok(!offersToTakeItBack([{ action: 'Can you do it?' }]));
});

// The cards Mike was handed steps on, 19 Nov 2026 (0b6b183c, 854d950f,
// 2ee8aeec), and the choices from the same threads that aren't steps.
test('handsOverAStep knows a step from a choice', () => {
  const card = (action: string, options?: string[], links?: { title: string; url: string }[]) => handsOverAStep([{ action, options, links }]);
  for (const [action, options] of [
    ["In the ADEMark user's System Settings on Tinker Desk, turn on the three things in my reply, then tell me.", ['Done', 'Stuck']],
    ['On Tinker Desk, allow Desk Runner to use Removable Volumes (System Settings > Privacy & Security > Files & Folders)', ['Done', 'Land without it']],
    ["Unlock Tinker Desk's screen (Screen Sharing or at the desk) so the Backspace test can click in the app", ['Unlocked', 'Land it anyway']],
    ["Tinker Desk's screen is on the ademark login (locked). Switch it back to mikeysee, or land the fix without the last test?", ['Switched back', 'Land it anyway']],
    ['Skip Apple Account sign-in on Tinker Desk, finish the setup screens. Done?', ['Done', 'Stuck']],
    ['Turn on the setting.', ['Done', 'Can you do it?']],
    ['Please enable Desk Runner’s Removable Volumes access.', ['I’ve enabled it', 'Stuck']],
    ['**Turn on** the switch.', undefined],
    ['Can you enable Desk Runner’s Removable Volumes access?', ['Enabled', 'Stuck']],
    ['Log into Tinker Desk as ademark.', undefined],
    ['In [Google Cloud Console](https://console.cloud.google.com/apis/credentials?project=app), copy the Gemini API key.', undefined],
    ['In [the AI Studio tab](https://aistudio.google.com/apikey), copy the key.', undefined],
    ['On Tinker Desk, in System Settings, allow Desk Runner on removable volumes.', undefined],
    ['Allow Desk Runner to use Removable Volumes in order to run the tests.', ['Done', 'Stuck']],
    ['Drag and drop the cert into Keychain Access.', undefined],
    ['Click Cancel on the Apple Account prompt on Tinker Desk, then finish setup.', undefined],
    ['On Tinker Desk, can you allow Desk Runner to use Removable Volumes?', ['Enabled', 'Stuck']],
    ['Desk Runner needs the external drive.', ['Done — run the test', 'Land without it']],
    ['Desk Runner needs the external drive.', ["I've turned it on", 'Land without it']],
    ["Tinker Desk is on the ademark login.", ['Switched back to mikeysee', 'Land it anyway']],
    ['Allow Desk Runner on Tinker Desk to read its files, so I can run the test?', ["I've allowed it", 'Land without it']],
    ['Sign in to the store.', ['Signed in', 'Hold off']],
  ] as const) assert.ok(card(action, options && [...options]), action);
  for (const [action, options] of [
    ['What should we do about getting Threadbear onto ADEMark once the GPUI app is out?', ['Private run first', 'Request it now', 'Skip it']],
    ["Ready to type Tinker Desk's login password into a private card so I can set up the benchmark user myself?", ['Ask me now', "I'll do the steps"]],
    ["Should I tell you when Tinker Desk's screen is free, so you can switch to the ADEMark user then?", ['Yes, tell me', "I'll just do it"]],
    ['Can I log your account out of Tinker Desk tonight?', ['Yes, tonight', 'Not yet']],
    ['Delete the old Linux install on the Dell laptop, now that nothing uses it?', ['Delete it', 'Leave it']],
    ['Which households should get the portal email?', ['Ever paid + affiliates', 'Paid this or last year']],
    ['Let me know which name you like', ['Bramble', 'Thicket']],
    ['Dictate a sentence on your phone and tell me what it typed', undefined],
    ['Which pricing model should we use?', ['Fixed price', 'Hourly']],
    ['Which URL should the share link use?', ['Signed URL', 'Public URL']],
    ['Default for the new switch?', ['Enabled', 'Disabled']],
    ['Send this email to Emily?', ['Approved', 'Edit first']],
    ["Let's decide which plan to use.", ['Credits', 'Plan']],
    ['Delete the old Linux install on the Dell laptop.', ['Delete it', 'Leave it']],
    ['Buy the weather station kit (about A$246).', ['Order it', 'Wait']],
    ['In the Google AI Studio tab I brought forward, set up prepay on the Convex billing account and buy US$50 of credit.', ['Done']],
    ['Delete the old Linux install on the Dell laptop.', ['Done', 'Stuck']],
    ['Click Delete Account to close it for good.', undefined],
    ['Complete the payment in Stripe.', ['Done']],
    ['In [the AI Studio tab](https://aistudio.google.com/billing), set up prepay.', ['Done']],
    ['**Install the new Tandem now?**', ['Install now', 'Later']],
    ['Install the new Tandem now? It restarts the app.', ['Install now', 'Later']],
    ['Open PRs #38 and #41 both touch auth. Which should I merge first?', ['#38', '#41']],
    ['Which apps should this list show?', ['Installed apps', 'All apps']],
    ['Keep going with the old plan?', ["I've changed my mind", 'Keep going']],
  ] as const) assert.ok(!card(action, options && [...options]), action);
  assert.ok(!card('Turn on one of these', ['Done'], [{ title: 'Review', url: 'review:abc' }]), 'a review is a pick');
  assert.ok(handsOverAStep([{ action: 'Which design?', options: ['A', 'B'], links: [{ title: 'Review', url: 'review:abc' }] }, { action: 'Allow Desk Runner on removable volumes.', options: ['Done'] }]), "a review doesn't hide the card's other asks");
  assert.ok(handsOverAStep([{ action: 'Desk Runner needs removable volumes', reply: 'done' }]), "the older form's reply counts");
  assert.ok(!handsOverAStep([{ action: 'Click Confirm.', why: 'This deletes the account for good.', options: ['Done'] }]), "a why that deletes isn't pressed on");
});

// Run on the card was taken out (14 Nov 2026): a session that loaded
// end_turn while it was on can still pass asks[].run, which is ignored.
test("an ask's old run argument is dropped", () => {
  const asks = needsFromTool({ needs: 'you', asks: [{ question: 'Run it?', run: 'npm test' }] })?.asks;
  assert.deepEqual(asks, [{ action: 'Run it?' }]);
});

// Thread dcdc60a3 (11 Nov 2026), and Codex's review of the fix: a notice
// handed over in a batch with a one-reply end_turn's "Now write your reply",
// before or after it, leaves the reply that follows as that reply; only a
// tool call after it is the agent acting on the notice.
test('WakeRead: a notice handed over with "Now write your reply" opens the turn only at a call', async () => {
  const { WakeRead, oneReplyAccepted } = await import('../../src/needs.ts');
  const note = { type: 'system.note', wake: true as const };
  const endTurn = { type: 'tool.result', itemId: 'e1', ok: true, text: oneReplyAccepted(true) };
  const other = { type: 'tool.result', itemId: 'b1', ok: true, text: 'ok' };
  const reply = { type: 'assistant.text', itemId: 'm1' };
  const call = { type: 'tool.call', itemId: 'c1' };
  const calls = (w: InstanceType<typeof WakeRead>) => {
    w.see({ type: 'tool.call', itemId: 'e1', name: END_TURN_FULL_NAME });
    w.see({ type: 'tool.call', itemId: 'b1', name: 'Bash' });
  };
  for (const batch of [[note, endTurn], [note, other, endTurn], [endTurn, note, other], [other, note, endTurn]]) {
    const w = new WakeRead();
    calls(w);
    for (const e of batch) assert.equal(w.see(e), false);
    assert.equal(w.see({ type: 'reasoning', itemId: 'r1' }), false);
    assert.equal(w.see(reply), false, JSON.stringify(batch));
    assert.equal(w.see(call), true);
  }
  // Without it, the first step after the batch opens it, as before.
  const w = new WakeRead();
  w.see(note);
  w.see(other);
  assert.equal(w.see(reply), true);
  // A command's output that quotes the answer isn't end_turn's.
  const q = new WakeRead();
  calls(q);
  q.see(note);
  q.see({ ...other, text: endTurn.text });
  assert.equal(q.see(reply), true);
  // An end_turn answer from an earlier batch doesn't carry over.
  const v = new WakeRead();
  calls(v);
  v.see(endTurn);
  v.see(reply);
  v.see(note);
  v.see(other);
  assert.equal(v.see({ type: 'assistant.text', itemId: 'm2' }), true);
});

// The two real ones from the week to 13 Nov 2026 (threads 0222c475, 7a98a6fd),
// and what the check must leave alone: over 2,935 done replies it found only
// those two, once a quoted question stopped counting.
test("replyAsks: a reply's closing question or go-ahead, and nothing softer", () => {
  const go = "Yes, I think it's ready to go live:\n- **Approved:** Alex Wheaton approved it.\n- **Cost:** about $9 a day.\n\nSay go and I'll merge main into prod, then check on convex.dev that /examples loads.";
  assert.equal(replyAsks(go), "Say go and I'll merge main into prod, then check on convex.dev that /examples loads.");
  assert.equal(replyAsks('Four fork fixes are in. Plan and Ask (#8) overlaps the mode you already have. Which do you want to start with?'), 'Which do you want to start with?');
  // Put to the user mid-paragraph, with a line after it.
  assert.equal(replyAsks('The fix is on main.\n\nWant me to deploy it now? It takes about two minutes.'), 'Want me to deploy it now?');
  assert.equal(replyAsks("It's built and tested. I'll release it once you say **go**."), "I'll release it once you say **go**.");
  assert.equal(replyAsks('Both are ready:\n1. The quick one\n2. The thorough one\n\n**Which should I run?**'), 'Which should I run?');
  // The agent's own view, an optional offer, a "tell me if it's off" line.
  assert.equal(replyAsks("It keeps what you'd already got right. I'd say yes, and mention the trust change."), undefined);
  assert.equal(replyAsks("With 2 failures in 4 days, neither is urgent. Tell me if you want the Cloudflare rule and I'll set it up."), undefined);
  assert.equal(replyAsks("If the bars are too jumpy, tell me and I'll tune them."), undefined);
  assert.equal(replyAsks("I won't post anything until you say so."), undefined);
  // The agent talking, and words it quotes.
  assert.equal(replyAsks('Why does this matter? Because the deploy sends everything on main. It is all there now.'), undefined);
  assert.equal(replyAsks('Worth a quick look before someone asks "how is this different?"'), undefined);
  // A draft for someone else isn't the agent asking.
  assert.equal(replyAsks("Here's the reply for Keith:\n\n```draft\nDoes Thursday work for you?\n```"), undefined);
  assert.equal(replyAsks('He wrote:\n\n> Can you ship it today?'), undefined);
  assert.equal(replyAsks('Done. It is on convex.dev now.'), undefined);
  assert.equal(replyAsks(''), undefined);
  // The dot in a name isn't a sentence's end.
  assert.equal(replyAsks('Release it to convex.dev now, or after v1.2 is out?'), 'Release it to convex.dev now, or after v1.2 is out?');
});

test('replyAsksNudge quotes the sentence, clipped, and says the reply stands', () => {
  const n = replyAsksNudge('Which do you want to start with?');
  assert.match(n, /^Your reply closes by asking the user something \("Which do you want to start with\?"\)/);
  assert.match(n, /Your message above is the reply: don't write it again/);
  // It names the field the ask goes in: told "as its ask, with ... options",
  // a thread sent ask and options as end_turn's own keys (19 Nov).
  assert.match(n, /asks: \[\{ question, options: \[\{ label \}\] \}\]/);
  assert.ok(replyAsksNudge(`Should I ${'really '.repeat(60)}do it?`).length < 800);
});

// The Done-in-a-project note's list of earlier items (needs.ts, unansweredItems).
test('unansweredItems: cards Mike saw, less what he answered by card, words or a review pick; not agents, and not what an edit cut', () => {
  let seq = 0;
  const ev = (body: Record<string, unknown>) => ({ seq: ++seq, ts: '', threadId: 't', turnId: 'x', ...body }) as unknown as PersistedEvent;
  const done = (next: string[]) => ev({ type: 'turn.completed', turnId: 'x', outcome: 'completed', durationMs: 1, needs: 'nothing', next });
  const asks = (list: { action: string; links?: { title: string; url: string }[] }[]) => ev({ type: 'turn.completed', turnId: 'x', outcome: 'completed', durationMs: 1, needs: 'you', asks: list });
  const said = (text: string, extra: Record<string, unknown> = {}) => ev({ type: 'user.message', text, images: [], ...extra });
  const events = [
    done(['Email Peter the link', 'Load the rest of the photos']),
    said('Load the rest of the photos'),
    asks([{ action: 'Pick a look for the site', links: [{ title: 'Compare', url: 'review:abcdef12-3456' }] }, { action: 'Send it to the list now?' }]),
    said('Review: looks (abcdef12-3456-7890)\n\nPicked A.', { reviewId: 'abcdef12-3456-7890' }),
    said(`${AGENT_MESSAGE_PREFIX}x] Email Peter the link`),
    said('Send it to the list now?\nWait', { origin: 'runner' }),
    done(['Old idea that got cut']),
  ];
  events.push(ev({ type: 'thread.rewound', fromSeq: events.at(-1)!.seq, toSeq: events.at(-1)!.seq, files: {} }));
  assert.deepEqual(unansweredItems(events), ['Email Peter the link', 'Send it to the list now?']);
  // A card answer names the ask; what the new card already carries isn't listed again.
  assert.deepEqual(unansweredItems([...events, said('x', { answers: [{ action: 'Send it to the list now?', answer: 'Wait' }] })], ['Email Peter the link']), []);
});

test('unansweredItems: items an earlier project-step note listed before a Done turn are dropped unless raised again', () => {
  let seq = 0;
  const ev = (body: Record<string, unknown>) => ({ seq: ++seq, ts: '', threadId: 't', turnId: 'x', ...body }) as unknown as PersistedEvent;
  const started = () => ev({ type: 'turn.started' });
  const asks = (list: { action: string }[]) => ev({ type: 'turn.completed', outcome: 'completed', durationMs: 1, needs: 'you', asks: list });
  const done = (next: string[] = []) => ev({ type: 'turn.completed', outcome: 'completed', durationMs: 1, needs: 'nothing', next });
  const note = (open: string[], prefix = '') => ev({ type: 'tool.result', itemId: `n${seq}`, ok: false, text: `${prefix}${projectStepNudge([{ title: 'Home', state: 'Plugs' }], open)}`, truncated: false, images: [] });

  // Turn 1 asks a question; Mike replies in other words ("Microwave").
  const base = [
    started(),
    asks([{ action: 'What should the new plug be called?' }, { action: 'Check "Plug" wiring' }]),
    ev({ type: 'user.message', text: 'Microwave', images: [] }),
  ];

  // Turn 2 gets the note, heeds it by asking instead of saying Done: still open.
  const heeded = [...base, started(), note(['What should the new plug be called?']), asks([{ action: 'Pick a room' }])];
  assert.deepEqual(unansweredItems(heeded), ['What should the new plug be called?', 'Check "Plug" wiring', 'Pick a room']);

  // Turn 2 gets the note, heeds it by snoozing instead of plain Done: still open.
  const snoozed = [
    ...base,
    started(),
    note(['What should the new plug be called?']),
    ev({ type: 'tool.call', itemId: 's1', name: 'mcp__threadbear__end_turn', kind: 'mcp', title: 'end_turn', input: { needs: 'nothing', snooze: '2h' } }),
    ev({ type: 'tool.result', itemId: 's1', ok: true, text: 'Noted.', truncated: false, images: [] }),
    done(),
  ];
  assert.deepEqual(unansweredItems(snoozed), ['What should the new plug be called?', 'Check "Plug" wiring']);

  const acceptDone = (input: Record<string, unknown> = { needs: 'nothing' }) => {
    const id = `d${seq}`;
    return [
      ev({ type: 'tool.call', itemId: id, name: 'mcp__threadbear__end_turn', kind: 'mcp', title: 'end_turn', input }),
      ev({ type: 'tool.result', itemId: id, ok: true, text: 'Noted.', truncated: false, images: [] }),
    ];
  };

  // Turn 2 gets the note, then archives: left alone like a snooze, so still open.
  const archived = [...base, started(), note(['What should the new plug be called?']), ...acceptDone({ needs: 'nothing', archive: true }), done()];
  assert.deepEqual(unansweredItems(archived), ['What should the new plug be called?', 'Check "Plug" wiring']);

  // Turn 2 gets the note and stops without an accepted second Done call: still open.
  const refusedOnly = [...base, started(), note(['What should the new plug be called?']), done()];
  assert.deepEqual(unansweredItems(refusedOnly), ['What should the new plug be called?', 'Check "Plug" wiring']);

  // Turn 2 gets the note (including Antigravity's error prefix) and still says Done: dropped,
  // while items not listed in that note stay open.
  const settled = [...base, started(), note(['What should the new plug be called?'], 'Encountered error in step execution: '), ...acceptDone(), done()];
  assert.deepEqual(unansweredItems(settled), ['Check "Plug" wiring']);

  // If the same item is asked again in a later turn, it is open again.
  const raisedAgain = [...settled, started(), asks([{ action: 'What should the new plug be called?' }])];
  assert.deepEqual(unansweredItems(raisedAgain), ['Check "Plug" wiring', 'What should the new plug be called?']);

  // A project state mentioning an item in quotes doesn't count as listing it in the earlier-items clause.
  const inStateOnly = [
    ...base,
    started(),
    ev({ type: 'tool.result', itemId: 'p1', ok: false, text: projectStepNudge([{ title: 'Home', state: 'Decide "What should the new plug be called?"' }], []), truncated: false, images: [] }),
    ...acceptDone(),
    done(),
  ];
  assert.deepEqual(unansweredItems(inStateOnly), ['What should the new plug be called?', 'Check "Plug" wiring']);

  // A rewound Done turn doesn't settle items.
  const rewoundEvents = [...settled];
  const fromSeq = base.at(-1)!.seq + 1;
  const toSeq = rewoundEvents.at(-1)!.seq;
  rewoundEvents.push(ev({ type: 'thread.rewound', fromSeq, toSeq, files: {} }));
  assert.deepEqual(unansweredItems(rewoundEvents), ['What should the new plug be called?', 'Check "Plug" wiring']);
});

test('plainCardNudged recognizes Antigravity-prefixed tool errors too', () => {
  const events = [
    { seq: 1, ts: '2026-11-26T00:00:00.000Z', threadId: 't', type: 'turn.started' as const, turnId: 'turn-1' },
    { seq: 2, ts: '2026-11-26T00:00:01.000Z', threadId: 't', type: 'tool.result' as const, itemId: 'c1', ok: false, text: `Encountered error in step execution: ${plainCardNudge()}`, truncated: false, images: [] },
  ];
  assert.equal(plainCardNudged(events), true);
});
