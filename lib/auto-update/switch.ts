/**
 * Moving the machine to a set: `pi-current` and the managed settings
 * entries. Each step is atomic (a symlink renamed over the old one; the
 * settings file replaced under Pi's lock), and every step is idempotent, so
 * the next cycle repairs a crash between two steps by running them again.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
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

/** Points the link `path` at `dir` (relative, so the store can move). True when it changed. */
function flipLink(paths: StorePaths, path: string, dir: string): boolean {
	const target = relative(paths.root, dir);
	if (currentLink(path) === target) return false;
	const temp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
	symlinkSync(target, temp);
	try {
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	return true;
}

export function flipPiCurrent(paths: StorePaths, piDir: string): boolean {
	return flipLink(paths, paths.piCurrent, piDir);
}

/** The set's pi-extras release folder (its package.json name is "pi-extras"), if the set has one. */
export function extrasEntry(set: UpdateSet): string | undefined {
	return Object.values(set.packages).find((release) => {
		try {
			return (JSON.parse(readFileSync(join(release.entry, "package.json"), "utf8")) as { name?: unknown }).name === "pi-extras";
		} catch {
			return false;
		}
	})?.entry;
}

/** `extras-current`: the CLI the launcher runs for `pi update`. Left alone when the set has no pi-extras. */
function flipExtrasCurrent(paths: StorePaths, set: UpdateSet): void {
	const entry = extrasEntry(set);
	if (entry) flipLink(paths, join(paths.root, "extras-current"), entry);
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
	flipExtrasCurrent(paths, set);
	const { changed } = rewriteSettingsPackages(settingsFile, (packages) => applySet(packages, set, paths.root));
	return { linkChanged, settingsChanged: changed };
}
