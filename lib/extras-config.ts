/**
 * pi-extras.json: one file of persistent settings, a section per extension.
 * Writes go through a temporary file and a rename, so two Pi sessions saving
 * at once never leave a half-written file.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_FILE = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-extras.json");

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

function readConfig(file: string): Json {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return isObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** A section of the file; empty when the file or section is missing or unreadable. */
export function readSection(name: string, file = CONFIG_FILE): Json {
	const value = readConfig(file)[name];
	return isObject(value) ? value : {};
}

/** Merges `patch` into a section, keeping everything else in the file. */
export function writeSection(name: string, patch: Json, file = CONFIG_FILE): void {
	const config = readConfig(file);
	const next = { ...config, [name]: { ...(isObject(config[name]) ? config[name] : {}), ...patch } };
	const temp = join(dirname(file), `.pi-extras.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
