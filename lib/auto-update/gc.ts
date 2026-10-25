/**
 * Removes release folders nothing can load any more. A folder stays while it
 * is in the current or previous set, while a live lease names it, for an hour
 * after its install, and (Linux) while any process maps a file in it. Runs
 * only under the updater lock, so no install writes into the store meanwhile.
 * Removal never follows a symlink out of the store.
 */
import { chmodSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Lease } from "./leases.ts";
import { isInside, type StorePaths } from "./paths.ts";
import { setDirs, type UpdateState } from "./state.ts";

export const MIN_AGE_MS = 3_600_000;
/** A staging folder older than this belongs to a cycle that stopped (the cycle limit is 10 minutes). */
export const STAGING_MAX_AGE_MS = 15 * 60_000;
export const RELEASE_MARKER = ".pi-extras-release.json";
export const STAGING_TAG = ".staging-";

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

function listDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
}

/** Pi folders and package release folders, staging folders included. */
function candidates(paths: StorePaths): string[] {
	return [...listDirs(paths.piRoot), ...listDirs(paths.packagesRoot).flatMap(listDirs)];
}

function installedAt(dir: string): number {
	try {
		const marker = JSON.parse(readFileSync(join(dir, RELEASE_MARKER), "utf8")) as { installedAt?: unknown };
		if (typeof marker.installedAt === "number") return marker.installedAt;
	} catch {
		// No marker (a staging folder, or one from before markers): the folder's own time decides.
	}
	return lstatSync(dir).mtimeMs;
}

/**
 * Files under `roots` that a live process maps (Linux `/proc/<pid>/maps`).
 * Node reads .ts and .js files without mapping them, so this catches native
 * addons and binaries; the leases cover the rest.
 */
export function mappedPaths(roots: readonly string[]): Set<string> {
	const found = new Set<string>();
	if (process.platform !== "linux") return found;
	let pids: string[];
	try {
		pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	} catch {
		return found;
	}
	for (const pid of pids) {
		let maps: string;
		try {
			maps = readFileSync(`/proc/${pid}/maps`, "utf8");
		} catch {
			// Gone, or another user's process: it cannot map our files without our read access anyway.
			continue;
		}
		for (const line of maps.split("\n")) {
			const slash = line.indexOf("/");
			if (slash < 0) continue;
			const path = line.slice(slash).replace(/ \(deleted\)$/, "");
			if (roots.some((root) => path.startsWith(root))) found.add(path);
		}
	}
	return found;
}

/** Adds owner write to every folder and file under `dir` without following symlinks. */
function makeWritable(dir: string): void {
	const stat = lstatSync(dir);
	if (stat.isSymbolicLink()) return;
	chmodSync(dir, (stat.mode & 0o777) | 0o200);
	if (!stat.isDirectory()) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) makeWritable(join(dir, entry.name));
		else if (entry.isFile()) chmodSync(join(dir, entry.name), (lstatSync(join(dir, entry.name)).mode & 0o777) | 0o200);
	}
}

/** Removes one store folder, or throws when it is not a real folder inside the store. */
export function removeStoreDir(paths: StorePaths, dir: string): void {
	const root = realpathSync(paths.root);
	const stat = lstatSync(dir);
	if (stat.isSymbolicLink() || !stat.isDirectory() || !isInside(realpathSync(dir), root)) throw new Error(`refusing to remove ${dir}: not a folder inside the store`);
	makeWritable(dir);
	// rmSync removes a symlink itself, never what it points to.
	rmSync(dir, { recursive: true, force: true });
}

export interface GcOptions {
	readonly paths: StorePaths;
	readonly state: UpdateState;
	readonly leases: readonly Lease[];
	readonly now: number;
	readonly minAgeMs?: number;
	readonly mapped?: (roots: readonly string[]) => Set<string>;
}

export interface GcResult {
	readonly removed: string[];
	readonly failed: { readonly dir: string; readonly reason: string }[];
}

function keepReason(dir: string, options: GcOptions, inUse: readonly string[], mapped: () => Set<string>): string | undefined {
	if (dir.includes(STAGING_TAG)) return options.now - lstatSync(dir).mtimeMs < STAGING_MAX_AGE_MS ? "staging" : undefined;
	if (inUse.some((used) => used === dir || isInside(used, dir))) return "in use";
	if (options.now - installedAt(dir) < (options.minAgeMs ?? MIN_AGE_MS)) return "young";
	if ([...mapped()].some((path) => isInside(path, dir))) return "mapped";
	return undefined;
}

export function collectGarbage(options: GcOptions): GcResult {
	const { paths, state, leases } = options;
	const inUse = [...setDirs(state.current), ...setDirs(state.previous), ...leases.flatMap((lease) => [lease.piDir, ...lease.releases])].map((dir) => resolve(dir));
	let scanned: Set<string> | undefined;
	const mapped = () => (scanned ??= (options.mapped ?? mappedPaths)([paths.root]));
	const removed: string[] = [];
	const failed: { dir: string; reason: string }[] = [];
	for (const dir of candidates(paths)) {
		if (keepReason(dir, options, inUse, mapped) !== undefined) continue;
		try {
			removeStoreDir(paths, dir);
			removed.push(dir);
		} catch (error) {
			failed.push({ dir, reason: (error as Error).message });
		}
	}
	for (const keyDir of listDirs(paths.packagesRoot)) {
		try {
			rmdirSync(keyDir);
		} catch {
			// Not empty: other releases of this source remain.
		}
	}
	return { removed, failed };
}
