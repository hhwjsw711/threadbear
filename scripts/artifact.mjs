import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_SLUG } from '../convex/artifactPage.ts';

const usage = `Usage:
  node scripts/artifact.mjs publish <file.html> <title>
  node scripts/artifact.mjs update <slug> <file.html> <title>
  node scripts/artifact.mjs unpublish <slug>`;

function readHtml(file) {
  const stat = statSync(file);
  if (!stat.isFile() || !/\.html?$/i.test(file) || stat.size > 512 * 1024) {
    throw new Error('Use an HTML file up to 512 KiB for the CLI helper (or up to 10 MB from the Threadbear app).');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
}

function run(name, args) {
  const convex = fileURLToPath(new URL('../node_modules/convex/bin/main.js', import.meta.url));
  const result = spawnSync(process.execPath, [convex, 'run', `artifacts:${name}`, JSON.stringify(args)], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

function main([command, ...args]) {
  if (command === 'publish' && args.length === 2) {
    const [file, title] = args;
    run('publish', { title, html: readHtml(file) });
  } else if (command === 'update' && args.length === 3 && ARTIFACT_SLUG.test(args[0])) {
    const [slug, file, title] = args;
    run('publish', { slug, title, html: readHtml(file) });
  } else if (command === 'unpublish' && args.length === 1 && ARTIFACT_SLUG.test(args[0])) {
    run('unpublish', { slug: args[0] });
  } else {
    throw new Error(usage);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
