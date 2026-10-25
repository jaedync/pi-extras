/**
 * One section of a shared JSON settings file, without Pi imports, so that a
 * plain `node` process (the auto-update CLI) can use it as well as Pi.
 * See lib/extras-config.ts for the rules the writes follow.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "./file-lock.ts";
import { readJsonObject, resolveTarget, writeJsonAtomic } from "./json-file.ts";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

/** A section of `file`; empty when the file or section is missing or unreadable. */
export function readSectionFrom(file: string, name: string): Json {
	let config: Json;
	try {
		config = readJsonObject(file);
	} catch {
		// Deliberate: a save into the same file throws and tells the user.
		return {};
	}
	const value = config[name];
	return isObject(value) ? value : {};
}

/**
 * Replaces a section with `change(current)` under the file's lock, keeping
 * everything else as it is at the moment of the write. Throws
 * `UnreadableJsonError` when the file exists but does not parse.
 */
export function updateSectionIn(file: string, name: string, change: (current: Json) => Json): Json {
	const target = resolveTarget(file);
	mkdirSync(dirname(target), { recursive: true });
	return withFileLock(target, () => {
		const config = readJsonObject(target);
		const section = change(isObject(config[name]) ? config[name] : {});
		writeJsonAtomic(target, { ...config, [name]: section });
		return section;
	});
}
