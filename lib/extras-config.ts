/**
 * pi-extras.json: one file of persistent settings, a section per extension.
 * Each write takes a lock, reads the file again, changes only its own
 * section, and replaces the file through a temporary file and a rename. So
 * two Pi sessions that save together keep both changes, and a reader never
 * sees half a file. A file that exists but does not parse is never written:
 * the save throws `UnreadableJsonError` instead of replacing every setting.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readSectionFrom, updateSectionIn } from "./json-section.ts";

export { UnreadableJsonError } from "./json-file.ts";

export const CONFIG_FILE = join(getAgentDir(), "pi-extras.json");

export const DISPLAY_SETTINGS_EVENT = "pi-extras:tool-display-settings";
/** Tool Display's folded mode: `{ live }`, when a folded line starts or stops moving, so the phase spinner yields its motion to it. */
export const FOLD_LIVE_EVENT = "pi-extras:fold-live";

type Json = Record<string, unknown>;

/**
 * A section of the file; empty when the file or section is missing or
 * unreadable, so every extension runs on its defaults. Saving into an
 * unreadable file throws instead (see `updateSection`).
 */
export function readSection(name: string, file = CONFIG_FILE): Json {
	return readSectionFrom(file, name);
}

export type MotionSetting = "full" | "reduced";

/**
 * Tool Display's motion choice (`/tool-display motion`), for everything that
 * animates: read once, then kept current from the settings event.
 */
export function watchMotion(events?: { on(name: string, handler: (value: unknown) => void): unknown }): () => MotionSetting {
	let motion: MotionSetting = readSection("toolDisplay").motion === "reduced" ? "reduced" : "full";
	events?.on(DISPLAY_SETTINGS_EVENT, (value) => {
		const next = (value as { motion?: unknown } | undefined)?.motion;
		if (next === "reduced" || next === "full") motion = next;
	});
	return () => motion;
}

/**
 * Replaces a section with `change(current)`, keeping everything else in the
 * file as it is at the moment of the write. Returns the section written.
 * Throws `UnreadableJsonError` when the file exists but does not parse, and
 * leaves the file as it was.
 */
export function updateSection(name: string, change: (current: Json) => Json, file = CONFIG_FILE): Json {
	return updateSectionIn(file, name, change);
}

/** Merges `patch` into a section, keeping everything else in the file. */
export function writeSection(name: string, patch: Json, file = CONFIG_FILE): Json {
	return updateSection(name, (current) => ({ ...current, ...patch }), file);
}
