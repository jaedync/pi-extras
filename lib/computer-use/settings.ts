/**
 * The apps mode, kept under `computerUse` in pi-extras.json next to the other
 * persistent settings, and read on every call so a change in one Pi session
 * applies to all of them.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** ask: allow per app. all: allow every app without asking. none: refuse every call. */
export type AppsMode = "ask" | "all" | "none";
export const MODES: readonly AppsMode[] = ["ask", "all", "none"];
const SECTION = "computerUse";

export const CONFIG_FILE = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-extras.json");

function readConfig(file: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

const section = (config: Record<string, unknown>): Record<string, unknown> => {
	const value = config[SECTION];
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
};

/** Anything but a known mode reads as "ask", the middle setting, rather than widening or blocking access. */
export function readAppsMode(file = CONFIG_FILE): AppsMode {
	const mode = section(readConfig(file)).apps;
	return MODES.includes(mode as AppsMode) ? mode as AppsMode : "ask";
}

export function writeAppsMode(mode: AppsMode, file = CONFIG_FILE): void {
	const config = readConfig(file);
	const next = { ...config, [SECTION]: { ...section(config), apps: mode } };
	const temp = join(dirname(file), `.pi-extras.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
