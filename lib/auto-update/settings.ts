/**
 * The `packages` list of Pi's global settings.json. Auto-update changes only
 * that field, under Pi's settings lock, and replaces the file atomically. Pi
 * merges only the fields a session changed when it saves, so a running
 * session never writes an old `packages` list back.
 */
import { isDeepStrictEqual } from "node:util";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonObject, writeJsonAtomic } from "../json-file.ts";
import { withSettingsLock } from "./settings-lock.ts";

export const settingsFile = (agentDir: string): string => join(agentDir, "settings.json");

function packagesOf(settings: Record<string, unknown>): unknown[] {
	return Array.isArray(settings.packages) ? settings.packages : [];
}

/** The packages list; empty when the file is missing. Throws `UnreadableJsonError` for a broken file. */
export function readSettingsPackages(file: string): unknown[] {
	return packagesOf(readJsonObject(file));
}

export interface PackagesChange {
	readonly before: readonly unknown[];
	readonly after: readonly unknown[];
	readonly changed: boolean;
}

/** Replaces `packages` with `change(packages)`; writes nothing when the list is the same. */
export function rewriteSettingsPackages(file: string, change: (packages: readonly unknown[]) => unknown[]): PackagesChange {
	mkdirSync(dirname(file), { recursive: true });
	return withSettingsLock(file, () => {
		const settings = readJsonObject(file);
		const before = packagesOf(settings);
		const after = change(before);
		const changed = !isDeepStrictEqual(before, after);
		if (changed) writeJsonAtomic(file, { ...settings, packages: after });
		return { before, after, changed };
	});
}
