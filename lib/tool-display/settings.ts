/**
 * Tool Display's switches, kept under `toolDisplay` in pi-extras.json: the
 * extension itself, whether it draws other extensions' tool rows too, the
 * step breakdown of chained bash commands, reduced motion, how thinking
 * blocks rest, and folded mode (off unless chosen). Anything missing or
 * unrecognised reads as the default.
 */
import type { Motion } from "../band/band.ts";
import { CONFIG_FILE, readSection, writeSection } from "../extras-config.ts";
import { THINKING_MODES, type ThinkingMode } from "./thinking.ts";

export interface DisplaySettings {
	readonly enabled: boolean;
	/** Draw other extensions' tool rows with the band too. */
	readonly others: boolean;
	readonly chains: boolean;
	readonly motion: Motion;
	readonly thinking: ThinkingMode;
	/**
	 * Fold each run of work between replies into one line (lib/fold). Its own
	 * key: the removed 0.17 folding saved `fold: true`, which must not opt in.
	 */
	readonly folded: boolean;
}

export const DEFAULT_SETTINGS: DisplaySettings = { enabled: true, others: true, chains: true, motion: "full", thinking: "tail", folded: false };
const SECTION = "toolDisplay";

export function readSettings(file = CONFIG_FILE): DisplaySettings {
	const section = readSection(SECTION, file);
	return {
		enabled: section.enabled !== false,
		others: section.others !== false,
		chains: section.chains !== false,
		motion: section.motion === "reduced" ? "reduced" : "full",
		thinking: THINKING_MODES.find((mode) => mode === section.thinking) ?? "tail",
		folded: section.folded === true,
	};
}

export function writeSettings(settings: DisplaySettings, file = CONFIG_FILE): void {
	writeSection(SECTION, { enabled: settings.enabled, others: settings.others, chains: settings.chains, motion: settings.motion, thinking: settings.thinking, folded: settings.folded }, file);
}
