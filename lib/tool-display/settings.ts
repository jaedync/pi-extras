/**
 * The row density, kept under `toolDisplay` in pi-extras.json next to the
 * other persistent settings.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Density } from "./slot.ts";

export const DENSITIES: readonly Density[] = ["boxed", "compact"];
const SECTION = "toolDisplay";

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

/** Anything but a known density reads as boxed, Pi's own look. */
export function readDensity(file = CONFIG_FILE): Density {
	const density = section(readConfig(file)).density;
	return DENSITIES.includes(density as Density) ? density as Density : "boxed";
}

export function writeDensity(density: Density, file = CONFIG_FILE): void {
	const config = readConfig(file);
	const next = { ...config, [SECTION]: { ...section(config), density } };
	const temp = join(dirname(file), `.pi-extras.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
