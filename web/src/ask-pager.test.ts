// The card of asks pages as the desktop does (composer_card.rs is_paged, composer.rs next_unanswered).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPaged, nextUnanswered } from './ask-pager.ts';

test('one ask is never paged, however tall', () => {
  assert.equal(isPaged([{ action: 'x'.repeat(2000), options: ['a', 'b'] }]), false);
});

test('two short asks fit and stay stacked', () => {
  // 26 + 2 * (12 + 23 + 46) = 188
  assert.equal(isPaged([{ action: 'Ship it?', options: ['Yes', 'No'] }, { action: 'Tag it?', options: ['Yes', 'No'] }]), false);
});

test('a third ask tips the card over 240', () => {
  // 26 + 3 * 81 = 269
  const ask = { action: 'Ship it?', options: ['Yes', 'No'] };
  assert.equal(isPaged([ask, ask, ask]), true);
});

test('a long paragraph counts a line per 95 characters', () => {
  const short = { action: 'a'.repeat(50), options: ['Yes'] };
  const long = { action: 'a'.repeat(300), options: ['Yes'] };
  assert.equal(isPaged([short, short]), false);
  assert.equal(isPaged([long, short]), true);
});

test('the why joins the action, with a full stop when the action has none', () => {
  // Two asks of two lines each are 26 + 2 * (12 + 46 + 46) = 234, fits;
  // of three lines each, 280, pages. 40 + ". " + 148 is 190: two lines.
  const two = { action: 'a'.repeat(40), why: 'b'.repeat(148), options: ['Yes'] };
  const three = { ...two, why: 'b'.repeat(149) };
  assert.equal(isPaged([two, two]), false);
  assert.equal(isPaged([three, three]), true);
  // An action that already ends a sentence takes no extra stop.
  const stopped = { action: `${'a'.repeat(39)}.`, why: 'b'.repeat(149), options: ['Yes'] };
  assert.equal(isPaged([stopped, stopped]), false);
});

test('options with notes are 38 each plus one', () => {
  const noted = { action: 'Ship it?', options: ['A', 'B', 'C'], optionNotes: ['x', 'y', 'z'] };
  // 26 + 2 * (12 + 23 + 152) = 400
  assert.equal(isPaged([noted, noted]), true);
});

test('next unanswered wraps and counts this one last', () => {
  const by = { 0: 0, 2: 1 };
  assert.equal(nextUnanswered(0, 3, by, false), 1);
  assert.equal(nextUnanswered(1, 3, { 0: 0, 1: 0, 2: 0 }, true), null);
  assert.equal(nextUnanswered(1, 3, { 0: 0, 2: 0 }, true), 1);
  assert.equal(nextUnanswered(1, 3, { 0: 0, 2: 0 }, false), null);
  assert.equal(nextUnanswered(0, 0, {}, true), null);
});

test('a pick of -1 is unanswered', () => {
  assert.equal(nextUnanswered(0, 2, { 1: -1 }, false), 1);
});
