import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { agentRoot, piAiRoot } from './support/pi-runtime.mjs';

// Pi 1.0.0 nests pi-ai under pi-coding-agent; later releases let npm hoist it. Tests must work with both layouts.
test('piAiRoot finds the pi-ai that the selected Pi uses', () => {
  assert.ok(existsSync(join(piAiRoot, 'dist/index.js')), `no pi-ai build in ${piAiRoot}`);
  assert.ok(existsSync(join(agentRoot, 'dist/index.js')));
});
