import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHARED_CACHES, leakReport, runTmpDir, sharedLeakWarning, testTmpPrefixes, tmpLeakFailure } from '../scripts/tmp-guard.mjs';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tmp-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('an empty run folder passes and one leaked folder fails with its prefix', (t) => {
  const base = scratch(t);
  const run = runTmpDir(base, join(base, 'cache'));
  assert.match(run, /[/\\]pxt-[^/\\]{6}$/, 'a short run folder keeps socket paths under the macOS limit');
  assert.equal(tmpLeakFailure(run), null, 'the cache links are not leaks');
  mkdirSync(join(run, 'jiti-esm'));
  assert.equal(tmpLeakFailure(run), null, "jiti's ESM fallback folder is not a leak");
  mkdirSync(join(run, 'status-plus-children-AbC123'));
  assert.match(tmpLeakFailure(run), /left 1 entries[\s\S]*status-plus-children-\* x1/);
});

test('leaks group by prefix, largest group first', () => {
  const report = leakReport(['spend-ledger-a1', 'dollars-agent-x', 'dollars-agent-y', 'dollars-agent-z', 'loose.txt']);
  const lines = report.split('\n').slice(1);
  assert.deepEqual(lines, ['  dollars-agent-* x3', '  spend-ledger-* x1', '  loose.* x1']);
  assert.match(report, /^the tests left 5 entries/);
});

test('the prefixes come from mkdtemp calls, also over two lines and with a literal /tmp', (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'a.test.ts'), 'mkdtempSync(join(tmpdir(), "usage-guard-"));\nmkdtemp(\n  join(tmpdir(),\n "spend-ledger-"));'
    + ' mkdtempSync(path.join(os.tmpdir(), "path-join-")); mkdtempSync(join(tmpdir(), "pv-"));');
  mkdirSync(join(dir, 'support'));
  writeFileSync(join(dir, 'support', 'b.mts'), "mkdtempSync('/tmp/roshell-'); mkdtempSync(join(other, 'nested-'));");
  writeFileSync(join(dir, 'notes.md'), 'mkdtempSync("ignored-")');
  assert.deepEqual(testTmpPrefixes(dir).sort(), ['path-join-', 'roshell-', 'spend-ledger-', 'usage-guard-'], 'a prefix under 4 characters is dropped');
});

test('the shared folder warns only for new entries with a test prefix', () => {
  const before = ['usage-guard-old', 'other'];
  const after = [...before, 'usage-guard-new', 'rpi-chaos-1', 'unrelated'];
  assert.equal(sharedLeakWarning(before, before, ['usage-guard-']), null);
  const warning = sharedLeakWarning(before, after, ['usage-guard-']);
  assert.match(warning, /^warning: 1 new entries/);
  assert.match(warning, /usage-guard-new/);
  assert.doesNotMatch(warning, /usage-guard-old|rpi-chaos|unrelated/);
});

test('the run folder links each shared cache to a folder that outlives the run', (t) => {
  const base = scratch(t);
  const run = runTmpDir(base, join(base, 'cache'));
  for (const name of SHARED_CACHES) {
    assert.ok(lstatSync(join(run, name)).isSymbolicLink(), name);
    assert.equal(readlinkSync(join(run, name)), join(base, 'cache', `pi-extras-test-${name}`));
  }
  rmSync(run, { recursive: true, force: true });
  for (const name of SHARED_CACHES) assert.ok(lstatSync(join(base, 'cache', `pi-extras-test-${name}`)).isDirectory(), `${name} survives the run`);
});

test("the run folder's jiti links to the transform cache of the smoke and SDK tests, so one cache serves both", async (t) => {
  const { TEST_TRANSFORM_CACHE } = await import('./support/transform-cache.mjs');
  const run = runTmpDir(scratch(t));
  assert.equal(readlinkSync(join(run, 'jiti')).replace(/[/\\]$/, ''), TEST_TRANSFORM_CACHE.replace(/[/\\]$/, ''));
  assert.match(readlinkSync(join(run, 'node-compile-cache')), /pi-extras-test-node-compile-cache[/\\]?$/);
});
