/**
 * Moving the machine to a set: `pi-current` and the managed settings
 * entries. Each step is atomic (a symlink renamed over the old one; the
 * settings file replaced under Pi's lock), and every step is idempotent, so
 * the next cycle repairs a crash between two steps by running them again.
 */
import { randomBytes } from "node:crypto";
import { readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { relative } from "node:path";
import type { StorePaths } from "./paths.ts";
import { rewriteSettingsPackages } from "./settings.ts";
import { applySet, entrySource } from "./sources.ts";
import type { UpdateSet } from "./state.ts";

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

function currentLink(path: string): string | undefined {
	try {
		return readlinkSync(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "EINVAL") return undefined;
		throw error;
	}
}

/** Points `pi-current` at `piDir` (relative, so the store can move). True when it changed. */
export function flipPiCurrent(paths: StorePaths, piDir: string): boolean {
	const target = relative(paths.root, piDir);
	if (currentLink(paths.piCurrent) === target) return false;
	const temp = `${paths.piCurrent}.tmp-${randomBytes(4).toString("hex")}`;
	symlinkSync(target, temp);
	try {
		renameSync(temp, paths.piCurrent);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	return true;
}

/** True when `pi-current` points at the set's Pi. */
export function piCurrentMatches(paths: StorePaths, set: UpdateSet): boolean {
	return currentLink(paths.piCurrent) === relative(paths.root, set.pi.dir);
}

/** True when every settings entry of a set key names that key's release. */
export function settingsMatch(packages: readonly unknown[], set: UpdateSet, storeRoot: string): boolean {
	const applied = applySet(packages, set, storeRoot);
	return applied.every((entry, index) => entrySource(entry) === entrySource(packages[index]));
}

export interface SwitchResult {
	readonly linkChanged: boolean;
	readonly settingsChanged: boolean;
}

/** Brings `pi-current` and settings.json to `set`. */
export function applySwitch(paths: StorePaths, settingsFile: string, set: UpdateSet): SwitchResult {
	const linkChanged = flipPiCurrent(paths, set.pi.dir);
	const { changed } = rewriteSettingsPackages(settingsFile, (packages) => applySet(packages, set, paths.root));
	return { linkChanged, settingsChanged: changed };
}
