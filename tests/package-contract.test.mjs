import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
test('package explicitly exports seven extensions and one theme', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.pi.extensions, [
    'extensions/status-plus.ts', 'extensions/usage-guard.ts', 'extensions/phase-spinner.ts',
    'extensions/shell-jobs.ts', 'extensions/bash-default-timeout.ts',
    'extensions/kagi-search.ts', 'extensions/voice.ts',
  ]);
  assert.deepEqual(pkg.pi.themes, ['themes/quiet.json']);
  for (const path of [...pkg.pi.extensions, ...pkg.pi.themes]) assert.ok(existsSync(resolve(root, path)), path);
  assert.equal(pkg.private, true);
  assert.ok(pkg.files.includes('lib/'));
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts[name], undefined);
});

test('the version matches the lockfile and the top changelog entry', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  const top = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8').match(/^## (\d+\.\d+\.\d+)/m);
  assert.equal(top?.[1], pkg.version);
});

test('every minor and major release ships a freshly rendered preview image', async () => {
  const { previewProblems } = await import('../scripts/preview/image-facts.mjs');
  assert.deepEqual(previewProblems(root), []);
});

test('Kagi remains a separate search tool by default', () => {
  const entry = readFileSync(resolve(root, 'lib/kagi/index.ts'), 'utf8');
  assert.match(entry, /KAGI_TOOL_NAME \|\| 'kagi_search'/);
});
