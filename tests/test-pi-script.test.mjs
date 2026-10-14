import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const run = (...args) => spawnSync(process.execPath, ['scripts/test-pi.mjs', '--dry-run', ...args], { encoding: 'utf8' });

test('test:pi plans an install, the checks and a restore for one Pi version', () => {
  const result = run('1.2.0');
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.match(lines[0], /npm install --no-save --ignore-scripts @earendil-works\/pi-coding-agent@1\.2\.0 @earendil-works\/pi-tui@1\.2\.0$/);
  assert.deepEqual(lines.slice(1), ['npm run typecheck', 'npm test', 'npm ci --ignore-scripts']);
});

test('test:pi accepts latest and skips the restore on request', () => {
  const result = run('latest', '--no-restore');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pi-coding-agent@latest @earendil-works\/pi-tui@latest/);
  assert.doesNotMatch(result.stdout, /npm ci/);
});

test('test:pi refuses a version that is not a release number or latest', () => {
  for (const bad of ['', 'github:evil/repo', '1.2.0; rm -rf ~', '^1.0.0']) {
    const result = run(...(bad ? [bad] : []));
    assert.notEqual(result.status, 0, `accepted ${JSON.stringify(bad)}`);
    assert.match(result.stderr, /Usage: npm run test:pi/);
  }
});
