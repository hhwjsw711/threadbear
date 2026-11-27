// runner/scripts/canary.ts runs its checks at the top level and exits before
// the end of the file, so a top-level const or let declared below the exit is
// still uninitialised when the checks reach it. Daybreak, 10 Nov (finding
// 81): BLIP sat down there, so the first failed read threw "Cannot access
// 'BLIP' before initialization" instead of being tried again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/canary.ts');

test('the canary declares every top-level const and let before it exits', () => {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const exit = lines.findIndex((l) => /^process\.exit\(/.test(l));
  assert.ok(exit > 0, 'the top-level exit');
  const late = lines.slice(exit + 1).filter((l) => /^(export )?(const|let) /.test(l));
  assert.deepEqual(late, []);
  assert.ok(lines.slice(0, exit).some((l) => l.startsWith('const BLIP = ')), 'BLIP is up top');
});

// Codex's review, 10 Nov: the canary prints other runners' names and their
// followProblem too, so its lines go through forTerminal as tb status's do.
test("the canary's lines reach the terminal through forTerminal", () => {
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /console\.log\(`\$\{ok \? 'ok  ' : 'FAIL'\} \$\{forTerminal\(line\)/);
  assert.equal(text.match(/console\.(log|error)\(/g)?.length, 1, 'say is the only place it prints');
});

// 27 Nov: the RAMP card was empty, so every remote Claude login refused the
// turn (past due, or the org had turned subscription access off). That is the
// login, same as a usage limit. The canary tries another provider, and skips
// the machine only when nothing else there can answer.
test('a refused Claude subscription tries another login instead of failing the runner', () => {
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /payment is past due/);
  assert.match(text, /disabled claude subscription access/);
  assert.match(text, /no other one there can answer/);
  assert.match(text, /pickLogin/);
});

// A failed remote turn can mean a usage limit, not a sign-out. On 24 Nov
// all three weekly-limit failures were reported as signed-out logins.
test('a failed first turn points to its evidence without diagnosing a sign-out', () => {
  const text = fs.readFileSync(file, 'utf8');
  const branch = text.match(/if \(first\.card\?\.outcome === 'failed'\) \{([\s\S]*?)\n    \}/)?.[1];
  assert.ok(branch, 'the failed first-turn report');
  assert.match(branch, /thread \$\{id\}/, 'identify the remote thread');
  assert.match(branch, /events on \$\{r\.name\} say why/, 'point to the recorded failure');
  assert.doesNotMatch(branch, /signed.out|auth status/, 'the canary has not checked that login');
});
