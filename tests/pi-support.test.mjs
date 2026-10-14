import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

const read = (path) => readFileSync(resolve(fileURLToPath(new URL('../', import.meta.url)), path), 'utf8');
const pkg = JSON.parse(read('package.json'));
const PI_PACKAGES = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'];

// pi-extras supports only the latest Pi (CONTRIBUTING.md). The minimum in the README and the peer ranges is the
// development pin, which the lockfile CI job tests; the pi-versions job tests the Pi that npm serves now.
test('README, peer ranges and the development pin state the same minimum Pi, and CI tests the latest Pi', () => {
  const minimums = PI_PACKAGES.map((name) => pkg.peerDependencies[name].match(/^>=(\d+\.\d+\.\d+)$/)?.[1]);
  assert.ok(minimums.every(Boolean), `peer ranges must be ">=x.y.z": ${minimums}`);
  const [minimum] = minimums;
  assert.deepEqual(minimums, [minimum, minimum]);
  assert.equal(pkg.devDependencies[PI_PACKAGES[0]], minimum, 'the minimum must be the development pin');
  assert.ok(read('README.md').includes(`Requires Pi **${minimum} or newer**`), 'README minimum differs from the peer range');
  const matrix = read('.github/workflows/ci.yml').match(/^\s+pi: \[(.*)\]$/m)?.[1].split(',').map((item) => item.trim().replace(/['"]/g, ''));
  assert.deepEqual(matrix, ['latest'], 'CI must test the latest Pi');
});

test('the development pins are one Pi release, and it is not older than the minimum', () => {
  const pins = PI_PACKAGES.map((name) => pkg.devDependencies[name]);
  assert.match(pins[0], /^\d+\.\d+\.\d+$/);
  assert.equal(pins[1], pins[0]);
  const lock = JSON.parse(read('package-lock.json')).packages;
  for (const name of PI_PACKAGES) assert.equal(lock[`node_modules/${name}`].version, pins[0], `${name} lock entry`);
});

test('CI runs on a daily schedule and by hand, with read-only permissions', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /^\s+schedule:\s*\n\s+- cron: '[^']+'/m);
  assert.match(ci, /^\s+workflow_dispatch:/m);
  assert.match(ci, /^permissions:\n\s+contents: read$/m);
});
