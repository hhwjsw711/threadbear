// Every place the GPUI app asks GPUI to focus something hands AppKit's
// keyboard to GPUI's view with it (crate::web_panels::keyboard_to_app). GPUI's
// view never takes the keyboard back from a web panel's page by itself, so a
// request without it left letters going to the page, or beeping, while the
// caret sat in the box asked for (12 Nov: a picture dropped on the composer
// while a page had the keyboard). Here rather than in the crate's own tests,
// as ./check.sh --quick runs these on every landing and not those.
// A review can release only GPUI's reply focus while CEF keeps AppKit keys;
// its native focus regression also deliberately creates that stale state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../desktop/gpui/src');
const request = /window\.focus\(|\.focus\(window, cx\)/;
// A drawing's fallback focus, not something asked for: said so just above it.
const leaves = "Leaves AppKit's keyboard where it is";

function rustFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? rustFiles(path.join(dir, e.name)) : e.name.endsWith('.rs') ? [path.join(dir, e.name)] : []));
}

test('focus requests reclaim AppKit keys except native review handoffs', () => {
  const missing: string[] = [];
  const nativePageFocus: string[] = [];
  let requests = 0;
  for (const file of rustFiles(src)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!request.test(line) || line.trim().startsWith('//')) return;
      requests += 1;
      const after = lines.slice(i, i + 3).join('\n');
      const before = lines.slice(Math.max(0, i - 4), i).join('\n');
      if (path.relative(src, file) === 'review_window.rs') {
        if (line.trim() === 'window.focus(&self.focus, cx);' && before.includes('fn release_reply_keys(') && before.includes('if self.page_has_keys() && self.reply_focused(window, cx)')) {
          nativePageFocus.push('release reply focus while CEF owns keys');
          return;
        }
        if (line.trim() === 'window.focus(&reply, cx); // Deliberately leave AppKit with CEF.') {
          nativePageFocus.push('probe stale reply focus');
          return;
        }
      }
      if (!after.includes('keyboard_to_app(window)') && !before.includes(leaves)) missing.push(`${path.relative(src, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.ok(requests > 20, `found only ${requests} focus requests: has the pattern stopped matching?`);
  assert.deepEqual(nativePageFocus.sort(), ['probe stale reply focus', 'release reply focus while CEF owns keys']);
  assert.deepEqual(missing, [], 'add crate::web_panels::keyboard_to_app(window) after each of these');
});
