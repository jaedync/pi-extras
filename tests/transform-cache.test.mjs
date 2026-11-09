import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import test from 'node:test';
import { agentRoot } from './support/pi-runtime.mjs';
import { TEST_TRANSFORM_CACHE } from './support/transform-cache.mjs';

test('the test transform cache is per Pi version, so an upgrade does not reuse old transforms', () => {
  const { version } = JSON.parse(readFileSync(join(agentRoot, 'package.json'), 'utf8'));
  assert.match(basename(TEST_TRANSFORM_CACHE), new RegExp(`^pi-extras-test-jiti-pi-${version.replaceAll('.', '\\.')}(-jiti-\\d+\\.\\d+\\.\\d+)?$`));
});
