import { defineConfig } from 'vitest/config';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { agentRoot } from './tests/support/pi-runtime.mjs';

export default defineConfig({
  resolve: { alias: {
    '@earendil-works/pi-coding-agent': join(agentRoot, 'dist/bundle/index.js'),
    '@earendil-works/pi-tui': createRequire(join(agentRoot, 'package.json')).resolve('@earendil-works/pi-tui'),
  } },
  test: { include: ['tests/kagi/**/*.test.ts'], testTimeout: 10000, hookTimeout: 10000 },
});
