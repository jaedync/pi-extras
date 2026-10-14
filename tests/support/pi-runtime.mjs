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

// Pi 1.0.0 nests pi-ai inside pi-coding-agent; later releases let npm hoist it next to Pi. Look in both places.
function resolvePiAi(root) {
  const candidates = [join(root, 'node_modules/@earendil-works/pi-ai'), join(dirname(root), 'pi-ai')];
  const found = candidates.find((path) => existsSync(join(path, 'dist/index.js')));
  if (!found) throw new Error(`Cannot locate pi-ai for the Pi runtime at ${root}`);
  return found;
}
export const piAiRoot = resolvePiAi(agentRoot);
