/**
 * Tool Display's switches, kept under `toolDisplay` in pi-extras.json: the
 * extension itself, the step breakdown of chained bash commands, and reduced
 * motion. Anything missing or unrecognised reads as the default.
 */
import type { Motion } from "../band/band.ts";
import { CONFIG_FILE, readSection, writeSection } from "../extras-config.ts";

export interface DisplaySettings {
	readonly enabled: boolean;
	readonly chains: boolean;
	readonly motion: Motion;
}

export const DEFAULT_SETTINGS: DisplaySettings = { enabled: true, chains: true, motion: "full" };
const SECTION = "toolDisplay";

export function readSettings(file = CONFIG_FILE): DisplaySettings {
	const section = readSection(SECTION, file);
	return {
		enabled: section.enabled !== false,
		chains: section.chains !== false,
		motion: section.motion === "reduced" ? "reduced" : "full",
	};
}

export function writeSettings(settings: DisplaySettings, file = CONFIG_FILE): void {
	writeSection(SECTION, { enabled: settings.enabled, chains: settings.chains, motion: settings.motion }, file);
}
