// Convex refuses a push whose module path has anything but letters, digits,
// underscores and periods (27 Nov 2026: convex/pool-backups.ts stopped the
// backend deploy at c90e651). Catch it here, before landing, not at deploy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const CONVEX = path.resolve(import.meta.dirname, '../../../convex');

function modules(dir: string, rel = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '_generated' || entry.name === 'node_modules') return [];
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return [relPath, ...modules(path.join(dir, entry.name), relPath)];
    return /\.(ts|js)$/.test(entry.name) ? [relPath] : [];
  });
}

test('every convex/ module path is one Convex will deploy', () => {
  const bad = modules(CONVEX).filter((p) => p.split('/').some((part) => !/^[A-Za-z0-9_.]+$/.test(part)));
  assert.deepEqual(bad, [], 'rename these with camelCase (no hyphens): Convex rejects the whole push');
});
