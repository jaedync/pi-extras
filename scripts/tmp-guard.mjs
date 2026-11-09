// Temp-folder leak guard for scripts/test.mjs.
// Leaked test folders filled op01's /tmp (a tmpfs) until every session got ENOSPC (2026-11-09). The suite runs with
// TMPDIR set to one fresh folder per run, so a test that does not remove its own temp folder leaves an entry there and
// fails the run. A plain before/after count of the shared /tmp would also count other sessions' files.
import { mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOWN = 20;

// Caches that tools keep in TMPDIR and that serve every run: Pi's jiti transforms (a cold cache made Pi load all of
// pi-extras in over 55 s on a loaded op01) and Node's compile cache from Pi's CLI. Each one links to a folder of this
// checkout, so it stays warm, stays off the shared /tmp and goes away with the worktree.
export const SHARED_CACHES = ['jiti', 'node-compile-cache'];
const CACHE_ROOT = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url));

export function runTmpDir(home, cacheRoot = CACHE_ROOT) {
  const dir = join(home, 'tmp');
  mkdirSync(dir, { recursive: true });
  for (const name of SHARED_CACHES) {
    const target = join(cacheRoot, `pi-extras-test-${name}`);
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(dir, name), 'dir');
  }
  return dir;
}

// Group names by prefix (up to the first digit or the random suffix of mkdtemp) so 300 leaks of one test read as one line.
function prefixOf(name) {
  const match = /^(.*?[-_.])[^-_.]*$/.exec(name);
  return match ? match[1] : name;
}

export function leakReport(names) {
  if (names.length === 0) return null;
  const counts = new Map();
  for (const name of names) counts.set(prefixOf(name), (counts.get(prefixOf(name)) ?? 0) + 1);
  const lines = [...counts].sort((a, b) => b[1] - a[1]).slice(0, SHOWN).map(([prefix, n]) => `  ${prefix}* x${n}`);
  return `the tests left ${names.length} entries in their temp folder; remove each temp folder in t.after or afterEach:\n${lines.join('\n')}`;
}

export function tmpLeakFailure(dir) {
  return leakReport(readdirSync(dir).filter((name) => !SHARED_CACHES.includes(name)));
}

// A test that names "/tmp" itself skips TMPDIR. Other sessions write to the shared folder at the same time, so new
// entries there only give a warning, and only for the prefixes that the test sources pass to mkdtemp.
const MKDTEMP_PREFIX = /mkdtemp(?:Sync)?\(\s*(?:join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*)?["'`](?:\/tmp\/)?([^"'`$/]+)/g;

export function testTmpPrefixes(testsDir) {
  const prefixes = new Set();
  for (const file of readdirSync(testsDir, { recursive: true })) {
    if (!/\.m?[jt]s$/.test(file)) continue;
    for (const match of readFileSync(join(testsDir, file), 'utf8').matchAll(MKDTEMP_PREFIX)) prefixes.add(match[1]);
  }
  return [...prefixes];
}

export function sharedLeakWarning(before, after, prefixes) {
  const seen = new Set(before);
  const names = after.filter((name) => !seen.has(name) && prefixes.some((prefix) => name.startsWith(prefix)));
  if (names.length === 0) return null;
  return `warning: ${names.length} new entries in the shared temp folder have test prefixes (a test that skips TMPDIR, or another session):\n`
    + names.slice(0, SHOWN).map((name) => `  ${name}`).join('\n');
}
