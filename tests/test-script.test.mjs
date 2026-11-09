import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { stepFailure } from '../scripts/test-step.mjs';

test('a step that the limit stops is named as a timeout, with the time it ran, not as a failure', () => {
  const result = spawnSync('sleep', ['5'], { timeout: 100 });
  const message = stepFailure('test:unit', result, 100, 132_400);
  assert.match(message, /^test:unit was stopped at the 0\.1-second limit after 132\.4 s/);
  // The runner reports the files that the stop cut as cancelled; the message says why.
  assert.match(message, /cancelled/);
});

test('a step that exits with an error is a failure with its exit code and the time it ran', () => {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(stepFailure('test:unit', result, 1000, 2_040), 'test:unit failed with exit code 3 after 2.0 s');
});

test('a step that a signal from outside stops names the signal', () => {
  const result = spawnSync('sh', ['-c', 'kill -TERM $$']);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(stepFailure('test:unit', result, 1000, 300), 'test:unit was stopped by SIGTERM after 0.3 s');
});

test('a step that passes is no failure', () => {
  assert.equal(stepFailure('test:unit', spawnSync(process.execPath, ['-e', '']), 1000, 10), undefined);
});
