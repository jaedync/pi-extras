/**
 * The apps mode, kept under `computerUse` in pi-extras.json next to the other
 * persistent settings, and read on every call so a change in one Pi session
 * applies to all of them.
 */
import { CONFIG_FILE, readSection, writeSection } from "../extras-config.ts";

/** ask: allow per app. all: allow every app without asking. none: refuse every call. */
export type AppsMode = "ask" | "all" | "none";
export const MODES: readonly AppsMode[] = ["ask", "all", "none"];
const SECTION = "computerUse";

/** Anything but a known mode reads as "ask", the middle setting, rather than widening or blocking access. */
export function readAppsMode(file = CONFIG_FILE): AppsMode {
	const mode = readSection(SECTION, file).apps;
	return MODES.includes(mode as AppsMode) ? mode as AppsMode : "ask";
}

/** Throws `UnreadableJsonError`, and keeps the file, when pi-extras.json does not parse. */
export function writeAppsMode(mode: AppsMode, file = CONFIG_FILE): void {
	writeSection(SECTION, { apps: mode }, file);
}
