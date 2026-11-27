// node --test web/src/thread-links.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { escapeDestinations, findStep, readLink, type LinkTarget } from './thread-links.ts';

type Expected = { kind: string; value: string } | null;
type Row = { seq: number; role: 'user' | 'assistant' | 'tool' | 'note'; text: string; summary?: boolean };

// A target as the shared cases write it.
function neutral(t: LinkTarget | undefined): Expected {
  if (!t) return null;
  switch (t.kind) {
    case 'step':
      return { kind: 'step', value: t.quote };
    case 'thread':
    case 'button':
    case 'review':
      return { kind: t.kind, value: t.id };
    case 'plain':
      return { kind: 'plain', value: '' };
  }
}

function load<C>(name: string): C[] {
  const { cases } = JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as { cases: (C & { differs?: Record<string, string> })[] };
  return cases.filter((c) => !c.differs?.web);
}

// The cases the desktop app and the phones run too.
test('links into the thread read as the shared cases say', () => {
  const cases = load<{ name: string; input: string; expect: Expected }>('../../shared/cases/thread-links.json');
  assert.ok(cases.length > 5);
  for (const c of cases) assert.deepEqual(neutral(readLink(c.input)), c.expect, c.name);
});

// The cases the phones run too: escaping, then each link destination with no
// space left in it, read; and the step a work link finds.
test('work links escape and find their steps as the shared cases say', () => {
  type Case =
    | { name: string; input: { op: 'escape'; markdown: string }; expect: { links: Expected[] } }
    | { name: string; input: { op: 'find'; quote: string; from: number | null; busy: boolean; rows: Row[] }; expect: { step: number | null } };
  const cases = load<Case>('../../shared/cases/work-links.json');
  assert.ok(cases.length > 10);
  for (const c of cases) {
    if (c.input.op === 'escape') {
      const escaped = escapeDestinations(c.input.markdown);
      const want = (c.expect as { links: Expected[] }).links;
      const got = [...escaped.matchAll(/\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g)].map((m) => neutral(readLink(m[1]!)));
      assert.deepEqual(got, want, c.name);
    } else {
      assert.ok(c.input.from !== null, `${c.name}: the website's links always have their message`);
      const step = findStep(c.input.quote, c.input.from, c.input.rows);
      assert.equal(step ?? null, (c.expect as { step: number | null }).step, c.name);
    }
  }
});
