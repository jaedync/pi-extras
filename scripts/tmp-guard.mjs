// Temp-folder leak guard for scripts/test.mjs.
// Leaked test folders filled op01's /tmp (a tmpfs) until every session got ENOSPC (2026-11-09). The suite runs with
// TMPDIR set to one fresh folder per run, so a test that does not remove its own temp folder leaves an entry there and
// fails the run. A plain before/after count of the shared /tmp would also count other sessions' files.
// It does not see: the test:kagi step (vitest keeps its own cache in a folder of the run home), leaks into HOME (the
// run home goes at the end), tests that give a child their own TMPDIR, or Windows, where os.tmpdir() ignores TMPDIR.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_TRANSFORM_CACHE } from '../tests/support/transform-cache.mjs';

const SHOWN = 20;
// The run folder is a short sibling of the run home: macOS limits a Unix socket path to 103 bytes, and voice tests
// bind sockets two levels below TMPDIR.
const RUN_PREFIX = 'pxt-';

// Caches that tools keep in TMPDIR and that serve every run: Pi's jiti transforms (a cold cache made Pi load all of
// pi-extras in over 55 s on a loaded op01) and Node's compile cache from Pi's CLI. Each one links to a folder of this
// checkout, so it stays warm, stays off the shared /tmp and goes away with the worktree.
export const SHARED_CACHES = ['jiti', 'node-compile-cache'];
// jiti's ESM fallback removes its files but keeps this folder.
const IGNORED = [...SHARED_CACHES, 'jiti-esm'];
const CACHE_ROOT = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url));

// jiti uses the cache that the smoke and codemode SDK tests link (tests/support/transform-cache.mjs): one warm cache,
// named by the Pi and jiti versions, serves the whole suite.
function cacheTarget(name, cacheRoot) {
  if (name === 'jiti' && cacheRoot === CACHE_ROOT) return TEST_TRANSFORM_CACHE;
  return join(cacheRoot, `pi-extras-test-${name}`);
}

export function runTmpDir(base = tmpdir(), cacheRoot = CACHE_ROOT) {
  const dir = mkdtempSync(join(base, RUN_PREFIX));
  for (const name of SHARED_CACHES) {
    const target = cacheTarget(name, cacheRoot);
    mkdirSync(target, { recursive: true });
    // A junction needs no admin rights on Windows; other systems ignore the type.
    symlinkSync(target, join(dir, name), 'junction');
  }
  return dir;
}

// Group names by the part before their last "-", "_" or "." (the random suffix of mkdtemp), so 300 leaks of one test
// read as one line.
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
  return leakReport(readdirSync(dir).filter((name) => !IGNORED.includes(name)));
}

// A test that names "/tmp" itself skips TMPDIR. Other sessions write to the shared folder at the same time, so new
// entries there only give a warning, and only for the prefixes that the test sources pass to mkdtemp.
// Prefixes shorter than this also match other programs' files in /tmp.
const MIN_PREFIX = 4;
const MKDTEMP_PREFIX = /mkdtemp(?:Sync)?\(\s*(?:(?:path\.)?join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*)?["'`](?:\/tmp\/)?([^"'`$/]+)/g;

export function testTmpPrefixes(testsDir) {
  const prefixes = new Set();
  for (const file of readdirSync(testsDir, { recursive: true })) {
    if (!/\.m?[jt]s$/.test(file)) continue;
    for (const [, prefix] of readFileSync(join(testsDir, file), 'utf8').matchAll(MKDTEMP_PREFIX)) {
      if (prefix.length >= MIN_PREFIX) prefixes.add(prefix);
    }
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
