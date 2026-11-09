import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { stepFailure } from '../scripts/test-step.mjs';

test('a step that the limit stops is named as a timeout, not as a failure', () => {
  const result = spawnSync('sleep', ['5'], { timeout: 100 });
  const message = stepFailure('test:unit', result, 100);
  assert.match(message, /^test:unit was stopped at the 0\.1-second limit/);
  // The runner reports the files that the stop cut as cancelled; the message says why.
  assert.match(message, /cancelled/);
});

test('a step that exits with an error is a failure with its exit code', () => {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(stepFailure('test:unit', result, 1000), 'test:unit failed with exit code 3');
});

test('a step that passes is no failure', () => {
  assert.equal(stepFailure('test:unit', spawnSync(process.execPath, ['-e', '']), 1000), undefined);
});
