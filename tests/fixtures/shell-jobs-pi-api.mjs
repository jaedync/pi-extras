/**
 * Alias target for `@earendil-works/pi-coding-agent` when the shell-jobs UI tests
 * load the real extension through jiti. The renderer needs only the two display
 * helpers Pi re-exports, so read them from the running installation instead of
 * the package root, which loads experimental server code.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { agentRoot } from '../support/pi-runtime.mjs';

export const { keyHint } = await import(pathToFileURL(join(agentRoot, "dist/modes/interactive/components/keybinding-hints.js")).href);
export const { truncateToVisualLines } = await import(pathToFileURL(join(agentRoot, "dist/modes/interactive/components/visual-truncate.js")).href);
