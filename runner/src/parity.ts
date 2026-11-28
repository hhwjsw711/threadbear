// Where each request about a thread works, besides on this runner's own
// threads. The Mac app reaches another runner's thread through this runner
// and Convex (relay.ts), and the iPhone and the website reach every thread
// through Convex (convex/phone.ts). A feature built on this runner's own
// threads alone used to go missing on the others without anyone deciding it
// should: pictures to Hetzner, a decision card's notes, send_message to a
// cloud thread (8 Nov). Every thread request (rpc.ts THREAD_METHODS) has a
// row here, and parity.test.ts checks each against the code: `relay: 'yes'`
// means relay.ts answers it, and `phone: { via }` names the convex/phone.ts
// function the phone and the website use. A new request fails that test
// until its row says where it works, so leaving one out is a choice, with
// its reason written down.
//
// The relay half is what another runner's thread can do from the Mac, which
// opens it through its own runner and Convex. `ios` is where the iPhone app
// (ios/) lags the website, which the phone column is checked against: a
// phone `via` the iPhone doesn't call says why there, and parity.test.ts
// checks it calls every other one (the phone had no sharing at all
// while this said "Yes", Ville's report of 22 Nov). `android` is where the Android
// app (android-native/, a port of the iPhone's kit) lags the phone column: a
// phone `via` it doesn't call says why here, and parity.test.ts checks every
// other `via` is called by its kit, so a port that lands flips the test. The
// rows the API sends it are checked field by field in shared/cases/wire-rows.json.
// What each app *draws* is draw-parity.ts, the doc's second table.
// docs/parity.md is made from this (npm run parity-docs).

import { drawParityDoc } from './draw-parity.ts';

export type Where = 'yes' | { no: string };
export type PhoneWhere = { via: string } | { no: string };
export type Row = { what: string; relay: Where; phone: PhoneWhere; ios?: { no: string }; android?: { no: string } };

export const THREAD_REQUESTS: Record<string, Row> = {
  'threads.events': { what: 'Reading the transcript', relay: 'yes', phone: { via: 'messages' } },
  'threads.subscribe': { what: 'Following it live (relaySeen skips relay events this reader has)', relay: 'yes', phone: { via: 'messages' } },
  'threads.heldBody': { what: "Opening a tool's output", relay: 'yes', phone: { via: 'eventBody' }, ios: { no: 'The iPhone shows a tool line, not its output.' }, android: { no: 'Android shows a tool line, not its output.' } },
  'threads.send': { what: 'Sending a message, pictures too', relay: 'yes', phone: { via: 'send' } },
  'threads.interrupt': { what: 'Stop', relay: 'yes', phone: { via: 'interrupt' } },
  'threads.update': { what: 'Rename, archive, star, hibernate, and its pool, login, model or effort', relay: 'yes', phone: { via: 'update' } },
  'threads.markSeen': { what: 'Marking it read', relay: 'yes', phone: { via: 'update' } },
  'threads.hibernateWhen': { what: 'Hibernate until something happens', relay: 'yes', phone: { no: 'The phone hibernates until a time only.' } },
  'threads.share': { what: 'Sharing by link', relay: 'yes', phone: { via: 'share' } },
  'approvals.respond': { what: 'Answering an approval or a question', relay: 'yes', phone: { via: 'respond' } },
  'secrets.answer': { what: 'Answering a secret card', relay: 'yes', phone: { via: 'secret' } },
  'buttons.press': { what: 'Pressing a reply button', relay: 'yes', phone: { via: 'press' } },
  'buttons.list': { what: "A message's reply buttons", relay: 'yes', phone: { via: 'messages' } },
  'threads.commands': { what: 'The slash command list', relay: 'yes', phone: { via: 'slashCommands' } },
  'threads.contextUsage': { what: 'What fills its context', relay: { no: "Asked of the CLI on that Mac; the ring's popover there shows the totals only." }, phone: { no: 'Not on the phone.' } },
  'threads.tickAsk': { what: 'Ticking an ask on the card', relay: { no: 'Ticks stay on that Mac.' }, phone: { no: 'The phone sends picks with its answer instead.' } },
  'threads.edit': { what: 'Editing a message', relay: { no: 'It undoes file changes on that Mac, so it waits for a way to show what it undid.' }, phone: { no: 'Not on the phone.' } },
  'threads.delete': { what: 'Deleting it', relay: { no: 'Done on that Mac.' }, phone: { no: 'Not on the phone.' } },
  'threads.highlights': { what: 'Its highlights', relay: { no: 'Highlights are files on that Mac.' }, phone: { no: 'Not on the phone.' } },
  'threads.removeHighlight': { what: 'Removing a highlight', relay: { no: 'Highlights are files on that Mac.' }, phone: { no: 'Not on the phone.' } },
  'prWatch.set': { what: "A PR's auto-fix wand", relay: { no: 'The watch runs on the Mac that has the thread.' }, phone: { no: 'Not on the phone.' } },
  'threads.explain': { what: 'Explain', relay: { no: 'Runs a model on that Mac.' }, phone: { no: 'Not on the phone.' } },
  'threads.subagent': { what: "Reading a sub-agent's work", relay: { no: 'Sub-agents stay on that Mac.' }, phone: { no: 'Not on the phone.' } },
  'threads.panelShown': { what: 'A panel being shown', relay: { no: 'Patches run on that Mac.' }, phone: { no: 'No panels on the phone.' } },
  'threads.showPanel': { what: 'Opening a panel', relay: { no: 'Patches run on that Mac.' }, phone: { no: 'No panels on the phone.' } },
  'panels.render': { what: 'Drawing a panel', relay: { no: 'Patches run on that Mac.' }, phone: { no: 'No panels on the phone.' } },
  'panels.toggle': { what: "A list panel row's switch", relay: { no: 'Patches run on that Mac.' }, phone: { no: 'No panels on the phone.' } },
  'panels.convexKey': { what: "The Convex panel's key", relay: { no: 'Patches run on that Mac.' }, phone: { no: 'No panels on the phone.' } },
  'panels.convexDeployments': { what: "The Convex panel's deployments", relay: { no: 'Patches run on that Mac.' }, phone: { no: 'No panels on the phone.' } },
  'panels.convexLogin': { what: "The Convex panel's login", relay: { no: 'Patches run on that Mac.' }, phone: { no: 'No panels on the phone.' } },
  'actions.run': { what: 'An action chip', relay: { no: 'Patches run on that Mac.' }, phone: { no: 'No action chips on the phone.' } },
  'patches.trust': { what: "Trusting a folder's patches", relay: { no: 'Trust is given on that Mac.' }, phone: { no: 'Not on the phone.' } },
  'plans.approve': { what: 'Approving a plan', relay: { no: 'Not sent through Convex from the Mac yet.' }, phone: { no: 'Not on the phone yet.' } },
  'reviews.list': { what: 'Design reviews', relay: { no: 'Reviews open in the Mac app from that Mac.' }, phone: { via: 'designReviews' } },
  'reviews.create': { what: 'Starting a design review', relay: { no: 'Reviews open in the Mac app from that Mac.' }, phone: { no: 'Not on the phone.' } },
  'reviews.get': { what: 'Reading a design review', relay: { no: 'Reviews open in the Mac app from that Mac.' }, phone: { via: 'designReviews' } },
  'reviews.save': { what: 'Saving a design review', relay: { no: 'Reviews open in the Mac app from that Mac.' }, phone: { no: 'Not on the phone.' } },
  'reviews.respond': { what: 'Answering a design review', relay: { no: 'Reviews open in the Mac app from that Mac.' }, phone: { via: 'respondReview' } },
  'reviews.cancel': { what: 'Cancelling a design review', relay: { no: 'Reviews open in the Mac app from that Mac.' }, phone: { no: 'Not on the phone.' } },
};

/** docs/parity.md: the table, works first, then the gaps. */
export function parityDoc(): string {
  const cell = (w: Where | PhoneWhere) => (w === 'yes' || 'via' in w ? 'Yes' : `No: ${w.no}`);
  const ios = (r: Row) => (r.ios ? `No: ${r.ios.no}` : cell(r.phone));
  const android = (r: Row) => (r.android ? `No: ${r.android.no}` : cell(r.phone));
  const rows = Object.entries(THREAD_REQUESTS).sort(([, a], [, b]) => score(b) - score(a));
  return [
    '# Where each thread action works',
    '',
    'Made from `runner/src/parity.ts` by `npm run parity-docs` in `runner/`; edit that, not this.',
    '`runner/test/unit/parity.test.ts` checks each row against the code, and fails when a new',
    "thread request has no row, so a feature can't go missing on another Mac or the phone",
    'without someone deciding it should.',
    '',
    '"Another Mac" is a thread on another runner opened in the Mac app through Convex. "Website"',
    'and "iPhone" read every thread through Convex, with the same functions (convex/phone.ts).',
    '"Android" is the Android app, which reads the same way through its kit, a port of the iPhone\'s.',
    '',
    '| What | Request | Another Mac | Website | iPhone | Android |',
    '|---|---|---|---|---|---|',
    ...rows.map(([method, r]) => `| ${r.what} | \`${method}\` | ${cell(r.relay)} | ${cell(r.phone)} | ${ios(r)} | ${android(r)} |`),
    '',
    drawParityDoc(),
  ].join('\n');
}

function score(r: Row): number {
  return (r.relay === 'yes' ? 2 : 0) + ('via' in r.phone ? 1 : 0);
}
