// Citations of the runner protocol (scripts/protocol-citations.mjs): each
// `docs/protocol/<file>.md, "Section"` in the repo names a section that's in
// that file, so a section renamed or moved fails the landing that does it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
type Cite = { path: string; file?: string; name: string; part?: string };
type Citations = {
  citations: (text: string) => Cite[];
  check: (root: string) => { file: string; line: number; cite: string; why: string }[];
  rewrite: (text: string, map: Map<string, string[]>, root: string) => string;
  sections: (root: string) => Map<string, string[]>;
};
const pc = (await import(pathToFileURL(path.join(ROOT, 'scripts', 'protocol-citations.mjs')).href)) as Citations;

test('every citation of the protocol in the repo names a section in the file it names', () => {
  const bad = pc.check(ROOT);
  assert.deepEqual(
    bad.map((b) => `${b.file}:${b.line}: ${b.cite}: ${b.why}`),
    [],
    'Name the file the section is in now (the table in docs/protocol.md says), or the section as its heading or bold label has it. node scripts/protocol-citations.mjs points old docs/protocol.md citations at their file.',
  );
});

test('the forms a citation takes: comma, colon, a bracket, backticks, across a comment line, a heading before the label', () => {
  const text = [
    '// one (docs/protocol/needs-you.md, "Needs you").',
    '/// two docs/protocol/needs-you.md: "One reply"',
    '// three (`docs/protocol/connection.md`, "Auth")',
    '// four (docs/protocol/needs-you.md,',
    '// "Needs',
    '// you")',
    '// five docs/protocol/projects.md, Projects, "Links"',
    '// six protocol.md ("Warm start")',
    '// not one: docs/protocol.md has the rules',
  ].join('\n');
  assert.deepEqual(
    pc.citations(text).map((c) => [c.file, c.name, c.part]),
    [
      ['needs-you', 'Needs you', undefined],
      ['needs-you', 'One reply', undefined],
      ['connection', 'Auth', undefined],
      ['needs-you', 'Needs you', undefined],
      ['projects', 'Links', 'Projects'],
      [undefined, 'Warm start', undefined],
    ],
  );
});

test('an old citation is pointed at the file its section went to, a heading before a label of the same name', () => {
  const map = pc.sections(ROOT);
  const before = '// (docs/protocol.md, "Patches") and (protocol.md, "Warm start") and docs/protocol.md, Sync, "quickAsk" and (docs/protocol.md, "Older and newer clients")';
  assert.equal(
    pc.rewrite(before, map, ROOT),
    '// (docs/protocol/patches.md, "Patches") and (protocol/connection.md, "Warm start") and docs/protocol/moves.md, Sync, "quickAsk" and (docs/protocol.md, "Older and newer clients")',
  );
});
