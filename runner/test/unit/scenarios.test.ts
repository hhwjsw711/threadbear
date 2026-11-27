// Each scenario plays one thread and reads it three ways (helpers/routes.ts):
// on this runner, on another runner's thread from the Mac through Convex, and
// on the iPhone and the website. What a person sees (the card, its notes and
// pick, the follow-ups, the messages and their pictures) has to be the same
// on all three, or the difference has to be in KNOWN below with why. A
// decision card's notes (8 Nov) went missing on the way to another Mac with
// every test passing, as nothing compared the routes.
//
// A new feature that changes what a thread shows gets a scenario here. The
// agent building it writes it; it runs in the quick check in a second or two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threeWays, type View } from '../helpers/routes.ts';
import { SCENARIOS } from '../helpers/scenario-list.ts';
import { phoneReviewScenario } from '../helpers/phone-review-scenario.ts';
import { tmpDir } from '../helpers/fakes.ts';
import { makePng } from '../helpers/png.ts';
import fs from 'node:fs';
import path from 'node:path';

test('phone reads review previews and submits a revision-checked answer through Convex', phoneReviewScenario);

type Route = 'relay' | 'phone';
type Field = 'needs' | 'asks' | 'next' | 'nextPick' | 'nextSuggested' | 'looseEnds' | 'review' | 'plans' | 'messages' | 'notes' | 'pictures' | 'failed' | 'origins' | 'waitState' | 'coordinatorProjectId';

// Differences that are meant, each with why. A test below fails once one
// of these stops being a difference, so the list can't outlive its reason.
const KNOWN: { route: Route; field: Field; why: string }[] = [
  { route: 'phone', field: 'pictures', why: "phone:thread carries words only; the phone gets a message's pictures from phone:images." },
];


function pick(v: View, field: Field): unknown {
  switch (field) {
    case 'messages':
      return v.messages.map(({ role, text }) => ({ role, text }));
    case 'pictures':
      return v.messages.map((m) => m.pictures);
    case 'origins':
      return v.messages.map((m) => m.origin ?? null);
    default:
      return field === 'needs' || field === 'nextPick' || field === 'nextSuggested' || field === 'review' || field === 'waitState' || field === 'coordinatorProjectId' ? (v[field] ?? null) : v[field];
  }
}
const FIELDS: Field[] = ['needs', 'asks', 'next', 'nextPick', 'nextSuggested', 'looseEnds', 'review', 'plans', 'messages', 'notes', 'pictures', 'failed', 'origins', 'waitState', 'coordinatorProjectId'];
const known = (route: Route, field: Field) => KNOWN.find((k) => k.route === route && k.field === field);

for (const s of SCENARIOS) {
  test(`the same on every route: ${s.name}`, async () => {
    const { views, refused } = await threeWays(s.play);
    assert.deepEqual(refused, [], 'the backend took everything the runner sent');
    for (const route of ['relay', 'phone'] as const) {
      for (const field of FIELDS) {
        if (known(route, field)) continue;
        assert.deepEqual(pick(views[route], field), pick(views.here, field), `${field} differs on ${route === 'relay' ? 'another Mac (through Convex)' : 'the phone and website'}`);
      }
    }
  });
}

test('each known difference is still a difference, and says why', async () => {
  const all = await Promise.all(SCENARIOS.map((s) => threeWays(s.play)));
  for (const k of KNOWN) {
    assert.ok(k.why.trim().endsWith('.'), 'says why, as a sentence');
    const differs = all.some(({ views }) => JSON.stringify(pick(views[k.route], k.field)) !== JSON.stringify(pick(views.here, k.field)));
    assert.ok(differs, `${k.field} on ${k.route} is the same as here now: take it out of KNOWN`);
  }
});

// The same real backend as the route scenarios: a second pane already has
// every row except an older reply. Reopening it must restore that reply
// without replaying all the synthetic markers it already showed.
test('another Mac reopens a thread with only the reply its pane missed', async () => {
  const { relay, relayEvents, threadId, refused } = await threeWays((p) => {
    p.say('The earlier reply.');
    p.endTurn({ needs: 'nothing' });
    p.send('Carry on.');
    p.say('The latest reply.');
    p.endTurn({ needs: 'nothing' });
  });
  assert.deepEqual(refused, []);
  const missing = relayEvents.find((e) => e.type === 'assistant.text' && e.text === 'The earlier reply.');
  assert.ok(missing);
  const seen: [number, number][] = [];
  for (const seq of relayEvents.map((e) => Number(e.seq)).filter((seq) => seq !== missing.seq).sort((a, b) => a - b)) {
    const last = seen.at(-1);
    if (last && seq <= last[1] + 1) last[1] = Math.max(seq, last[1]);
    else seen.push([seq, seq]);
  }
  const reply = await relay.call(threadId, 'threads.subscribe', { afterSeq: Math.max(...relayEvents.map((e) => Number(e.seq))), relaySeen: seen }) as { events: Record<string, unknown>[] };
  assert.deepEqual(reply.events.map((e) => e.seq), [missing.seq]);
  assert.equal(reply.events[0]?.text, 'The earlier reply.');
});

// 17 Nov 2026: a picture pasted on one Mac into the other's thread reached
// it and showed as a message with no picture on the Mac it was pasted on.
// The runner that has the thread puts it up for the phone; the other Mac's
// relay gives the app the message with its pictures (backend API 87), and
// the file itself when the app asks its runner for it (files.read with that
// runner's id).
test("another Mac gets a message's pictures, and each file from the backend", async () => {
  const dir = tmpDir('tb-scenario-');
  const png = makePng(6, 4);
  const files = ['a.png', 'b.png'].map((name) => path.join(dir, name));
  for (const f of files) fs.writeFileSync(f, png);
  const { relay, relayEvents, runnerId, refused, views } = await threeWays((p) => {
    p.say('Ready.');
    p.endTurn({ needs: 'nothing' });
    // One placed in the words, one not.
    p.send('like [Picture 2] please', files.map((f) => ({ path: f, mediaType: 'image/png' })));
    p.say('Done.');
    p.endTurn({ needs: 'nothing' });
    // One picture, and a marker that is only words (Codex's review, 18 Nov).
    p.send('[Picture 1] and the literal token [Picture 2]', [{ path: files[0]!, mediaType: 'image/png' }]);
    p.say('Seen.');
    p.endTurn({ needs: 'nothing' });
  });
  assert.deepEqual(refused, []);
  const said = relayEvents.find((e) => e.type === 'user.message' && String(e.text).includes('please'))!;
  // The words as on the Mac that has the thread: no line counting the pictures.
  assert.equal(said.text, 'like [Picture 2] please');
  assert.deepEqual(views.relay.messages, views.here.messages);
  assert.deepEqual(views.relay.messages.map((m) => m.pictures), views.here.messages.map((m) => m.pictures));
  assert.deepEqual(said.images.map((i: { mediaType: string; width?: number; height?: number }) => [i.mediaType, i.width, i.height]), [['image/png', 6, 4], ['image/png', 6, 4]]);
  for (const image of said.images as { path: string }[]) {
    const read = await relay.readFile(runnerId, image.path);
    assert.deepEqual(Buffer.from(read.data, 'base64'), Buffer.from(png));
    assert.equal(read.mediaType, 'image/png');
    assert.equal(read.truncated, false);
  }
  // Nothing else on that Mac is read this way.
  await assert.rejects(relay.readFile(runnerId, path.join(dir, 'other.png')), /kept there for now/);
});


test('a coordinator and its questions, reads and replies are the same on every route', async () => {
  for (const read of [false, true]) {
    const { views, refused } = await threeWays((p) => {
      p.coordinate('p_threadbear');
      p.say('The project state is ready.');
      p.endTurn({ needs: 'you', asks: [{ question: 'Start the first task?', options: [{ label: 'Start it' }, { label: 'Wait' }] }] });
      p.sendFromPhone('Start it.');
      p.say('The helper finished. Should I land the change?');
      const decision = { needs: 'you', asks: [{ question: 'Land the change?', taskId: 'landing-decision', options: [{ label: 'Land it' }, { label: 'Not now' }], suggested: 0 }] };
      p.endTurn(decision);
      p.queuedReminder('A project check is due.', 'project-check');
      p.say('The check found nothing new.');
      p.endTurn(decision, undefined, true);
      if (read) p.read();
    });
    assert.deepEqual(refused, []);
    assert.equal(views.here.asks[0]?.taskId, 'landing-decision');
    const mirroredAsks = views.here.asks.map(({ taskId: _taskId, ...ask }) => ask);
    for (const route of ['here', 'relay', 'phone'] as const) {
      const view = views[route];
      assert.equal(view.coordinatorProjectId, 'p_threadbear', route);
      assert.equal(view.unread, !read, route);
      assert.equal(view.needs, 'you', 'reading does not answer the coordinator');
      assert.deepEqual(view.asks, route === 'here' ? views.here.asks : mirroredAsks);
      assert.deepEqual(view.asks[0]?.options, ['Land it', 'Not now']);
      assert.deepEqual(view.messages, views.here.messages);
      assert.ok(view.messages.some((m) => m.role === 'user' && m.text === 'Start it.' && m.origin === 'phone'));
    }
  }
});
