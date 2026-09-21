import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

// Tests use the pinned development dependency, never a machine-specific prefix.
function resolveRoot() {
  let path = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  while (!existsSync(join(path, 'package.json'))) {
    const parent = dirname(path);
    if (parent === path) throw new Error('Cannot locate the Pi package root');
    path = parent;
  }
  return path;
}
export const agentRoot = process.env.PI_TEST_AGENT_ROOT || resolveRoot();
