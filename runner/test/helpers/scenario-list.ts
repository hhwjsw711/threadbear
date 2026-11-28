// The scenarios: threads that each show something a person sees (a card,
// its notes, follow-ups, pictures in a message), played the same way by the
// unit tests (scenarios.test.ts, which compare this runner, another Mac and
// the phone in memory) and by the parity run (scripts/parity-seed.ts, which
// writes them into a real throwaway backend for the screenshots). Add one
// when a change alters what a thread shows.
import fs from 'node:fs';
import path from 'node:path';
import type { Play } from './routes.ts';
import { makePng } from './png.ts';
import { tmpDir } from './fakes.ts';

// shows: words each surface must show for it, which the parity run checks
// on the website and the Mac app as well as taking their pictures.
export type Scenario = { name: string; play: (p: Play) => void; shows: string[] };

export const SCENARIOS: Scenario[] = [
  {
    name: 'a phone message goes before an old pile of reminders',
    shows: ['Park the work now.', 'The work is parked.', 'Latest check-in'],
    play: (p) => {
      p.queuedReminder('Old check-in', 'check-in');
      p.queuedReminder('Latest check-in', 'check-in');
      p.sendFromPhone('Park the work now.');
      p.say('The work is parked.');
      p.endTurn({ needs: 'nothing' }, true);
      p.say('The latest check-in sees that the work is parked.');
      p.endTurn({ needs: 'nothing' });
    },
  },
  {
    name: 'a Notion board card mentioned beside a draft picture',
    shows: ['Please check', 'Pick the share button colour'],
    play: (p) => {
      p.say('Ready for the card.');
      p.endTurn({ needs: 'nothing' });
      const dir = tmpDir('tb-board-mention-');
      const file = path.join(dir, 'draft.png');
      fs.writeFileSync(file, makePng(4, 4));
      p.send('Please check [Picture 1] [Pick the share button colour](https://www.notion.so/1a2b3c4d5e6f40718293a4b5c6d7e8f9) ', [{ path: file, mediaType: 'image/png' }]);
      p.say('I will read Pick the share button colour and compare the picture.');
      p.endTurn({ needs: 'nothing' });
    },
  },
  {
    name: 'a message saved after Stop before the model started',
    shows: ['Please fix the spot in this picture.', 'Your stopped message and pictures are saved for your next message.', 'Continuing on another model.', 'I can fix the spot.'],
    play: (p) => {
      p.say('Ready.');
      p.endTurn({ needs: 'nothing' });
      p.send('Please fix the spot in this picture.');
      p.earlyStop();
      p.send('Continuing on another model.');
      p.say('I can fix the spot.');
      p.endTurn({ needs: 'nothing' });
    },
  },
  {
    name: 'a coordinator turn stopped by a runner update',
    shows: ['Use the canvas.', 'I saved your choice.'],
    play: async (p) => {
      p.coordinate('p_canvas');
      p.endTurn({ needs: 'nothing' });
      p.send('Use the canvas.');
      p.say('I saved your choice.');
      await p.stopForHandover();
    },
  },
  {
    name: 'a coordinator asks a new question while a prior decision is still open',
    shows: ['Which venue should I book?', 'What time works?', 'Town hall', 'Ten'],
    play: (p) => {
      p.coordinate('p_event');
      const venue = { question: 'Which venue should I book?', options: [{ label: 'Town hall' }, { label: 'Not now' }] };
      p.say('I can book the town hall.');
      p.endTurn({ needs: 'you', asks: [venue] });
      p.send('What about the time?');
      p.say('Ten is available.');
      p.endTurn({ needs: 'you', asks: [
        { question: 'What time works?', options: [{ label: 'Ten' }, { label: 'Not now' }] },
        venue,
      ] });
    },
  },
  {
    name: 'a message sent from the phone app',
    shows: ['The photo can wait until tomorrow.'],
    play: (p) => {
      p.say('I will check the photo.');
      p.endTurn({ needs: 'nothing' });
      p.sendFromPhone('The photo can wait until tomorrow.');
      p.say('All right, I will leave it for tomorrow.');
      p.endTurn({ needs: 'nothing' });
    },
  },
  {
    // bruce's Claude login was signed out (canary, 13 Nov): its turns
    // failed there, and this Mac showed each as an empty reply.
    name: 'a turn that failed',
    shows: ['The last turn failed'],
    play: (p) => {
      p.fail('Failed to authenticate: OAuth session expired and could not be refreshed');
    },
  },
  {
    // A Pixel thread ran out on one login and carried on on another, and
    // on the Mac it showed the limit's words and then a reply, with
    // nothing to say it had changed login (13 Nov). The note isn't in
    // `shows`: the website and the phone leave it out.
    name: 'a thread that moved to another login',
    shows: ['Half way there.'],
    play: (p) => {
      p.say('Half way there.');
      p.endTurn({ needs: 'nothing' });
      p.loginMoved();
    },
  },
  {
    name: 'a decision card, with what each answer does and a pick',
    shows: ['Same thread or new?', 'One thread that moves', 'The old one is archived'],
    play: (p) => {
      p.say('Two ways to go.');
      p.endTurn({ needs: 'you', asks: [{ question: 'Same thread or new?', options: [{ label: 'Same', does: 'One thread that moves' }, { label: 'New', does: 'The old one is archived' }], suggested: 1 }] });
    },
  },
  {
    name: 'two asks, one with a link to look at',
    shows: ['Deploy the fix?', 'See the diff', 'Plug in the phone and say when.'],
    play: (p) => {
      p.say('Two things.');
      p.endTurn({ needs: 'you', asks: [
        { question: 'Deploy the fix?', options: [{ label: 'Deploy' }, { label: 'Wait' }], links: [{ title: 'See the diff', url: 'https://github.com/mikecann/threadbear/pull/1' }] },
        { question: 'Plug in the phone and say when.' },
      ] });
    },
  },
  {
    // 21 Nov 2026: the review link was dropped on the way to the phone, so a
    // pick between three mocks showed there as a bare question.
    name: 'a pick between mockups, linking their review',
    shows: ['Which way should a waiting thread show its fix?', 'Open the three mocks'],
    play: (p) => {
      p.say('Three mocks are up.');
      p.endTurn({ needs: 'you', asks: [{ question: 'Which way should a waiting thread show its fix?', links: [{ title: 'Open the three mocks', url: 'review:0a7d18e2-5c14-45d3-ae06-5e1e13aa47d5' }] }] });
    },
  },
  {
    name: 'a done card with follow-ups',
    shows: ['Landed it.', 'Make the phone show Stop on a running thread', 'Check the website draws the new card'],
    play: (p) => {
      p.say('Landed it.');
      p.endTurn({ needs: 'nothing', next: ['Make the phone show Stop on a running thread', 'Check the website draws the new card'] });
    },
  },
  {
    name: 'a done card with pick-one follow-ups and a recommendation',
    shows: ['Ready for the next move.', 'Ship the quick fix now', 'Refactor the store first'],
    play: (p) => {
      p.say('Ready for the next move.');
      p.endTurn({ needs: 'nothing', next: ['Ship the quick fix now', 'Refactor the store first'], nextPick: 'one', nextSuggested: 0 });
    },
  },
  {
    // The done card's loose ends (experiment looseEnds): a check-in it
    // booked, under "Coming back" with its time (API 73 for the phone).
    name: 'a done card with a check-in booked',
    shows: ['Checked it in.', 'Coming back', 'Look at how the experiment went'],
    play: (p) => {
      p.looseEnds({ title: 'Look at how the experiment went', at: '2026-11-15T01:30:00.000Z' });
      p.say('Checked it in.');
      p.endTurn({ needs: 'nothing' });
    },
  },
  {
    // Review by another lab (runner/lab-review.ts): the turn that answered
    // the reviewer's findings carries the ledger to its done card.
    name: "a done card with another lab's review findings and what was done about each",
    shows: ['Fixed the refresh bug.', 'Drops the session on refresh.', 'Logs the token.'],
    play: (p) => {
      p.reviewed({
        reviewer: 'Codex (codex-1)', independent: true, rounds: 1, threadId: 'review-1', passed: false,
        findings: [
          { id: 1, round: 1, severity: 'high', claim: 'Drops the session on refresh.', where: 'src/app.ts:3' },
          { id: 2, round: 1, severity: 'low', claim: 'Logs the token.' },
        ],
      });
      p.say('Fixed the refresh bug.');
      p.endTurn({ needs: 'nothing', findings: [{ id: 1, outcome: 'fixed' }, { id: 2, outcome: 'disputed', note: 'It logs a hash.' }] });
    },
  },
  {
    // Plan first: the plan in full goes to the phone as a plan row (API 72).
    name: 'a Plan first plan',
    shows: ['Bots and webhook triggers', 'Add a bots table'],
    play: (p) => {
      p.proposePlan('# Bots and webhook triggers\n\n1. Add a bots table\n2. Call the webhook on each new message');
      p.say('The plan is ready for you.');
      p.endTurn({ needs: 'you' });
    },
  },
  {
    // Go ahead pressed on that runner: another Mac's card says so too, from
    // the plan's row (planDecision, API 76), not a guess from what follows.
    name: 'a Plan first plan that went ahead',
    shows: ['Bots and webhook triggers', 'Building it.'],
    play: (p) => {
      p.proposePlan('# Bots and webhook triggers\n\n1. Add a bots table');
      p.say('The plan is ready for you.');
      p.endTurn({ needs: 'you' });
      p.approvePlan();
      p.say('Building it.');
      p.endTurn({ needs: 'nothing' });
    },
  },
  {
    name: 'a thread the quiet inbox archived, brought back with Should have shown me',
    // The notes saying it was archived and brought back are the Mac's own,
    // like every archive note: only a login's notes go to the mirror
    // (sync.ts toMessageDoc), so the phone, the website and another Mac
    // show the reply alone (parity run, 23 Nov 2026).
    shows: ['Renamed the setting.'],
    play: (p) => {
      p.say('Renamed the setting.');
      p.endTurn({ needs: 'nothing' });
      p.quietlyArchived('A receipt for what was asked.');
      p.shouldHaveShown();
    },
  },
  {
    name: 'a reply with no card',
    shows: ['Just an answer.'],
    play: (p) => {
      p.say('Just an answer.');
      p.endTurn({ needs: 'nothing' });
    },
  },
  {
    // Mike changes the agent's email in its box on the Mac and sends it with
    // his answer: his bubble shows his words and a chip, not the line to the
    // agent and the raw fence (20 Nov).
    name: 'a message with an edited email draft on its end',
    shows: ['Send it', 'Your edited email', 'Sent your version.'],
    play: (p) => {
      p.say("Here's a reply:\n\n```email\nHi Geoff,\n\nCan you send it again?\n```");
      p.endTurn({ needs: 'nothing' });
      p.send("Send it\n\nI edited your draft. Use my version below exactly as it is, not yours:\n\n```email\nHi Geoff,\n\nI don't think it came through. Can you send it again please?\n```");
      p.say('Sent your version.');
      p.endTurn({ needs: 'nothing' });
    },
  },
  {
    name: 'Alex sends two pictures placed in his words',
    shows: ['should look like', 'They differ in colour.'],
    play: (p) => {
      p.say('Ready.');
      p.endTurn({ needs: 'nothing' });
      const dir = tmpDir('tb-scenario-');
      const pics = [1, 2].map((i) => {
        const file = path.join(dir, `p${i}.png`);
        fs.writeFileSync(file, makePng(4, 4));
        return { path: file, mediaType: 'image/png' };
      });
      p.send('this [Picture 1] should look like [Picture 2]', pics);
      p.say('They differ in colour.');
      p.endTurn({ needs: 'nothing' });
    },
  },
];
