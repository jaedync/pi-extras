import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';

const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8', timeout: 30000,
});
assert.equal(result.status, 0, result.stderr);
const files = JSON.parse(result.stdout)[0].files;
const roots = new Set(['extensions', 'lib', 'themes', 'docs', 'licenses']);
const top = new Set(['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY.md']);
for (const { path } of files) {
  assert.ok(!path.split('/').includes('..'), path);
  assert.ok(top.has(path) || roots.has(path.split('/')[0]), `Unexpected package file: ${path}`);
  assert.ok(!/(?:^|\/)(?:\.env|auth\.json|settings\.json|node_modules|__pycache__)(?:$|[/.])|\.(?:log|jsonl|map|tgz|pem|key|pyc)$/i.test(path), path);
  assert.ok(!lstatSync(resolve(path)).isSymbolicLink(), `Symlink: ${path}`);
}
console.log(`Package allowlist verified: ${files.length} files. Run a secret scan separately before publishing.`);
