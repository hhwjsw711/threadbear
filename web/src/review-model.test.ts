// node --test web/src/review-model.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMark,
  canSend,
  cutOutRect,
  draftArgument,
  finishDrawing,
  fit,
  layout,
  htmlLabelWidth,
  markCapacity,
  nextMarkNumber,
  optionLabel,
  overNote,
  parseReviewResult,
  pick,
  pickNone,
  removeMark,
  reopening,
  reviewSources,
  sendLabel,
  stopIndex,
  stops,
  takeMacMarks,
  toward,
  wheelAction,
  wobble,
  zoomAt,
  type DesignReview,
  type Measure,
  type ReviewDraft,
} from './review-model.ts';

const measure: Measure = { words: () => 66, note: (t) => ({ w: Math.min(330, t.length * 12), h: 40 }) };

function review(over: Partial<DesignReview> = {}): DesignReview {
  return {
    id: 'r1',
    title: 'Sidebar',
    status: 'pending',
    revision: 3,
    note: 'Three directions for the sidebar.',
    draft: { notes: {} },
    canMark: true,
    options: [
      { id: 'A', title: 'Compact', note: 'Tight rows', shots: [{ src: 'review:r1:' + 'a'.repeat(64), kind: 'image', marks: [{ kind: 'circle', box: [0.6, 0.1, 0.9, 0.4], note: 'this', ink: 'yellow' }, { kind: 'circle', box: [0.1, 0.1, 0.2, 0.2], note: 'left side' }] }] },
      { id: 'B', title: 'B. Roomy', shots: [{ src: 'review:r1:' + 'b'.repeat(64), kind: 'image' }, { src: 'review:r1:' + 'c'.repeat(64), kind: 'video', media: 'review:r1:' + 'd'.repeat(64) }] },
      { id: 'Today', title: 'Today', reference: true, shots: [{ src: 'review:r1:' + 'e'.repeat(64), kind: 'image' }] },
    ],
    ...over,
  };
}

test('reads the runner’s JSON text, dropping marks it can’t read', () => {
  const r = review();
  const raw = JSON.stringify({ review: { ...r, options: [{ ...r.options[0], shots: [{ ...r.options[0]!.shots[0], marks: [{ kind: 'circle', box: [0, 0, 1] }, { kind: 'pin', box: [0.5, 0.5, 0.5, 0.5] }] }] }], draft: { notes: { A: 'nice' }, pickedIds: ['A'], nextMark: 2, markCount: 2 } } });
  const parsed = parseReviewResult(raw)!;
  assert.equal(parsed.review?.options[0]!.shots[0]!.marks?.length, 1);
  assert.deepEqual(parsed.review?.draft, { notes: { A: 'nice' }, pickedIds: ['A'], nextMark: 2, markCount: 2 });
  assert.deepEqual(parseReviewResult('{"reviews":[{"id":"x","title":"One"}],"truncated":true}'), { reviews: [{ id: 'x', title: 'One' }], truncated: true });
  assert.equal(parseReviewResult('not json'), undefined);
  assert.equal(parseReviewResult('{"review":{"id":1}}'), undefined);
});

test('sources are every still and media, once', () => {
  assert.equal(reviewSources(review()).length, 5);
});

test('marks number on from the Mac’s and share the cap of 20', () => {
  const d: ReviewDraft = { notes: {}, nextMark: 3, markCount: 2 };
  assert.equal(nextMarkNumber(d), 4);
  assert.equal(markCapacity(d), 18);
  const added = addMark(d, { kind: 'circle', optionId: 'A', shot: 0, box: [0, 0, 0.5, 0.5] })!;
  assert.equal(added.draft.reply, '[Mark 4] ');
  assert.equal(nextMarkNumber(added.draft), 5);
  const full: ReviewDraft = { notes: {}, markCount: 20 };
  assert.equal(addMark(full, { kind: 'pin', optionId: 'A', shot: 0, box: [0, 0, 0, 0] }), undefined);
});

test('a mark goes in at the caret, spaced, or on the end', () => {
  const d: ReviewDraft = { notes: {}, reply: 'make this bigger' };
  const mid = addMark(d, { kind: 'circle', optionId: 'A', shot: 0, box: [0, 0, 1, 1] }, { start: 9, end: 9 })!;
  assert.equal(mid.draft.reply, 'make this [Mark 1] bigger');
  assert.equal(mid.caret, 'make this [Mark 1]'.length);
  const end = addMark(d, { kind: 'circle', optionId: 'A', shot: 0, box: [0, 0, 1, 1] })!;
  assert.equal(end.draft.reply, 'make this bigger [Mark 1] ');
  assert.deepEqual(removeMark(end.draft, 1), { notes: {}, reply: 'make this bigger ' });
});

test('the Mac’s new marks renumber the browser’s, and the reply follows', () => {
  const mine: ReviewDraft = { notes: {}, nextMark: 0, markCount: 0, reply: 'see [Mark 1] and [Mark 2]', marks: [{ n: 1, kind: 'circle', optionId: 'A', shot: 0, box: [0, 0, 1, 1] }, { n: 2, kind: 'pin', optionId: 'B', shot: 0, box: [0, 0, 0, 0] }] };
  const now = takeMacMarks(mine, { notes: {}, nextMark: 2, markCount: 2 });
  assert.deepEqual(now.marks?.map((m) => m.n), [3, 4]);
  assert.equal(now.reply, 'see [Mark 3] and [Mark 4]');
  // An answered review shows as the runner keeps it.
  const answered = review({ status: 'answered', draft: { notes: { A: 'x' } } });
  assert.deepEqual(reopening(answered, mine), { notes: { A: 'x' } });
  // Too many after the Mac's: says how many to take off.
  const over = takeMacMarks(mine, { notes: {}, nextMark: 19, markCount: 19 });
  assert.equal(overNote(over), 'The Mac added marks, so remove 1 of yours to send.');
});

test('picks, None of them and what Send says', () => {
  const r = review();
  let d: ReviewDraft = { notes: {} };
  assert.equal(canSend(d, r), false);
  assert.equal(sendLabel(d, r, false), 'Send');
  d = pick(d, 'B', true);
  d = pick(d, 'A', true);
  assert.deepEqual(d.pickedIds, ['A', 'B']);
  assert.equal(sendLabel(d, r, false), 'Send A + B');
  assert.equal(canSend(d, r), true);
  d = pickNone(d, true);
  assert.equal(d.pickedIds, undefined);
  assert.equal(sendLabel(d, r, false), 'Send none of them');
  // A reference can't be picked, or marked.
  assert.equal(canSend(pick({ notes: {} }, 'Today', true), r), false);
  assert.equal(canSend({ notes: {}, marks: [{ n: 1, kind: 'pin', optionId: 'Today', shot: 0, box: [0, 0, 0, 0] }] }, r), false);
  assert.equal(canSend({ notes: {}, reply: 'hi' }, review({ status: 'answered' })), false);
  assert.equal(sendLabel({ notes: {}, reply: 'hi' }, r, true), 'Sending…');
});

test('the answer sends notes as a list and marks with their cut-outs', () => {
  const d: ReviewDraft = { notes: { B: 'b', A: 'a' }, pickedIds: ['A'], pickedId: 'A', reply: 'r', marks: [{ n: 2, kind: 'pin', optionId: 'A', shot: 0, box: [0.1, 0.1, 0.1, 0.1], path: [[0.1, 0.1]] }, { n: 1, kind: 'circle', optionId: 'A', shot: 0, box: [0, 0, 1, 1] }] };
  assert.deepEqual(draftArgument(d, new Map([[1, 'kg2']])), {
    notes: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }],
    pickedIds: ['A'],
    reply: 'r',
    marks: [
      { n: 1, kind: 'circle', optionId: 'A', shot: 0, box: [0, 0, 1, 1], storageId: 'kg2' },
      { n: 2, kind: 'pin', optionId: 'A', shot: 0, box: [0.1, 0.1, 0.1, 0.1] },
    ],
  });
  assert.equal('marks' in draftArgument({ notes: {} }), false);
});

test('the board lays options in a staggered row with the lead first, and tours them', () => {
  const r = review();
  const board = layout(r, () => 4 / 3, measure);
  assert.ok(board.lead);
  const [a, b, c] = board.options;
  assert.ok(a!.frame.x > board.lead!.w);
  assert.equal(b!.frame.y, 130);
  assert.equal(c!.frame.y, 50);
  // A has a note on its left, so it's pushed right to make room.
  assert.equal(a!.frame.x, 440 + 140 + 96 + 330 + 40);
  assert.equal(a!.shots[0]!.notes.length, 2);
  assert.equal(a!.shots[0]!.notes.find((n) => n.left)?.mark, 1);
  // B's second shot has a caption over it; its first doesn't.
  assert.equal(b!.shots[0]!.caption.h, 0);
  assert.equal(b!.shots[1]!.caption.h, 34);
  const tour = stops(board);
  assert.deepEqual(tour.map((s) => s.lit.kind), ['lead', 'start', 'opening', 'opening', 'shot', 'opening', 'all']);
  assert.equal(stopIndex(tour, 1, 1), 4);
  assert.equal(optionLabel(r.options[0]!), 'A. Compact');
  assert.equal(optionLabel(r.options[1]!), 'B. Roomy');
});

test('the camera fits, zooms round a point and flies straight', () => {
  const cam = fit({ x: 0, y: 0, w: 1000, h: 500 }, { x: 0, y: 0, w: 500, h: 500 }, 0, 1.4);
  assert.equal(cam.s, 0.5);
  const z = zoomAt(cam, { x: 100, y: 100 }, 2);
  assert.equal(z.s, 1);
  // The point under the pointer stays put.
  assert.equal((100 - cam.tx) / cam.s, (100 - z.tx) / z.s);
  const half = toward({ s: 1, tx: 0, ty: 0 }, { s: 4, tx: 0, ty: 0 }, 0.5, { w: 100, h: 100 });
  assert.equal(half.s, 2);
});

test('a mouse wheel zooms, a trackpad moves, a pinch zooms', () => {
  assert.equal(wheelAction({ deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: false, metaKey: false, wheelDeltaY: 120 }).kind, 'zoom');
  assert.ok((wheelAction({ deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: false, metaKey: false, wheelDeltaY: 120 }) as { factor: number }).factor > 1);
  assert.equal(wheelAction({ deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: false, metaKey: false }).kind, 'zoom');
  assert.deepEqual(wheelAction({ deltaX: 2, deltaY: 7, deltaMode: 0, ctrlKey: false, metaKey: false, wheelDeltaY: -21 }), { kind: 'pan', dx: -2, dy: -7 });
  assert.deepEqual(wheelAction({ deltaX: 0, deltaY: 7, deltaMode: 0, ctrlKey: false, metaKey: false, wheelDeltaY: -21 }), { kind: 'pan', dx: -0, dy: -7 });
  const pinch = wheelAction({ deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: true, metaKey: false });
  assert.equal(pinch.kind, 'zoom');
  assert.ok((pinch as { factor: number }).factor > 1);
});

test('a drawing becomes a mark on the picture under it, never on a reference', () => {
  const r = review();
  const board = layout(r, () => 4 / 3, measure);
  const pic = board.options[0]!.shots[0]!.picture;
  const ring = [0, 1, 2, 3, 4].map((i) => ({ x: pic.x + 100 + 50 * Math.cos(i), y: pic.y + 100 + 50 * Math.sin(i) }));
  const mark = finishDrawing(board, r, 'circle', ring, 0)!;
  assert.equal(mark.optionId, 'A');
  assert.ok(mark.box.every((x) => x >= 0 && x <= 1));
  const ref = board.options[2]!.shots[0]!.picture;
  assert.equal(finishDrawing(board, r, 'pin', [{ x: ref.x + 5, y: ref.y + 5 }], 0), undefined);
  assert.equal(finishDrawing(board, r, 'circle', ring.slice(0, 2), 0), undefined);
  const pin = finishDrawing(board, r, 'pin', [{ x: pic.x + pic.w / 2, y: pic.y + pic.h / 2 }], 0)!;
  assert.deepEqual(pin.box, [0.5, 0.5, 0.5, 0.5]);
});

test('a cut-out is the marked part, padded, at most 480 wide', () => {
  assert.deepEqual(cutOutRect([0.5, 0.5, 0.25, 0.25], 1000, 800), { sx: 210, sy: 168, sw: 330, sh: 264, w: 330, h: 264 });
  const wide = cutOutRect([0, 0, 1, 1], 2000, 1000)!;
  assert.equal(wide.w, 480);
  assert.equal(cutOutRect([0, 0], 10, 10), undefined);
});

test('the wobble is the Mac’s mulberry32', () => {
  const w = wobble(7);
  const a = w();
  assert.ok(a >= 0 && a <= 1);
  assert.equal(wobble(7)(), a);
});


test('HTML sources fetch only the still and reserve a separate control band', () => {
  const r = review({options: [{id: 'A', title: 'HTML', shots: [{src: 'still', media: 'sealed-html', kind: 'page'}]}]});
  assert.deepEqual(reviewSources(r), ['still']);
  const laid = layout(r, () => 4 / 3, measure);
  const shot = laid.options[0]!.shots[0]!;
  assert.equal(shot.picture.y - (shot.caption.y + shot.caption.h), 48);
});


test('compact HTML headers leave label space beside fixed pills only when their rows overlap', () => {
  for (const scale of [0.25, 0.4, 0.6, 1, 1.4]) {
    const r = review({options: [{id: 'A', title: 'A long HTML title', shots: [{src: 'one', kind: 'page'}, {src: 'two', kind: 'page', title: 'A long later caption'}]}]});
    const laid = layout(r, () => 4 / 3, measure).options[0]!;
    for (const shot of laid.shots) {
      assert.equal(shot.picture.y - (shot.caption.y + shot.caption.h), 48);
      for (const label of [laid.title, shot.caption]) {
        const width = htmlLabelWidth(label, shot.picture, scale);
        const top = shot.picture.y - 32 / scale;
        if (shot.picture.w * scale >= 210 && label.y < top + 26 / scale && label.y + label.h > top) {
          assert.ok((label.x + width) * scale <= (shot.picture.x + shot.picture.w) * scale - 220);
        } else assert.equal(width, label.w);
      }
    }
  }
});


test('HTML label clearance follows open, zoom-in flights and zoom-out using the same board', () => {
  const r = review({options: [{id: 'A', title: 'Recommended HTML', shots: [{src: 'still', kind: 'page'}]}]});
  const option = layout(r, () => 4 / 3, measure).options[0]!;
  const widths = [0.4, 1, 1.4, 0.4].map((scale) => htmlLabelWidth(option.title, option.shots[0]!.picture, scale));
  assert.deepEqual(widths, [90, 640, 640, 90]);
  assert.deepEqual(widths.map((width, i) => width * [0.4, 1, 1.4, 0.4][i]! >= 190), [false, true, true, false], 'tight headers collapse the recommendation so the title retains room');
});
