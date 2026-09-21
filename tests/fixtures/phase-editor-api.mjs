// Use real installed UI primitives without importing the unrelated experimental
// server barrel, which currently requires the missing pi-server package.
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot as root } from '../support/pi-runtime.mjs';
const components = join(root, "dist/modes/interactive/components");
export const { CustomEditor } = await import(pathToFileURL(join(components, "custom-editor.js")).href);
export const { keyText } = await import(pathToFileURL(join(components, "keybinding-hints.js")).href);
