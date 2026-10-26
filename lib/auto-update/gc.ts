/**
 * Removes release folders nothing can load any more. A folder stays while it
 * is in the current or previous set, while settings.json or a live lease
 * names it, for an hour after its install, and (Linux) while any process
 * maps a file in it, runs it or works in it. Runs only under the updater
 * lock, so no install writes into the store meanwhile. Removal never follows
 * a symlink out of the store. All comparisons use real paths: a symlink in
 * the store path must not hide a folder in use.
 */
import { chmodSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Lease } from "./leases.ts";
import { isInside, storePaths, type StorePaths } from "./paths.ts";
import { setDirs, type UpdateState } from "./state.ts";

export const MIN_AGE_MS = 3_600_000;
/** A staging folder older than this belongs to a cycle that stopped (the cycle limit is 10 minutes). */
export const STAGING_MAX_AGE_MS = 15 * 60_000;
export const RELEASE_MARKER = ".pi-extras-release.json";
export const STAGING_TAG = ".staging-";
/** Exactly what install.ts makes: `<final>.staging-<8 hex>`. A release id may hold ".staging-" too. */
const STAGING_NAME = /\.staging-[0-9a-f]{8}$/;

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
		// Most processes map nothing from the store: skip their maps without a split.
		if (!roots.some((root) => maps.includes(root))) continue;
		for (const line of maps.split("\n")) {
			const slash = line.indexOf("/");
			if (slash < 0) continue;
			const path = line.slice(slash).replace(/ \(deleted\)$/, "");
			if (roots.some((root) => path.startsWith(root))) found.add(path);
		}
	}
	return found;
}

/** Store paths that live processes use (Linux): mapped files, command-line arguments and working folders. */
export function processPaths(roots: readonly string[]): Set<string> {
	return new Set([...processRefs(roots), ...mappedPaths(roots)]);
}

/**
 * Store paths in the command lines and working folders of live processes
 * (Linux). This finds the children of a Pi (tools, MCP servers), not Pi
 * itself: Pi sets `process.title` to "pi", which writes over its command
 * line. Leases and the current and previous sets protect Pi. Cheaper than
 * the maps scan, so GC reads it first.
 */
export function processRefs(roots: readonly string[]): Set<string> {
	const found = new Set<string>();
	if (process.platform !== "linux") return found;
	let pids: string[];
	try {
		pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	} catch {
		return found;
	}
	const under = (path: string) => roots.some((root) => path === root || path.startsWith(`${root}/`));
	for (const pid of pids) {
		try {
			for (const arg of readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")) {
				// `--flag=/path` names the path after the "=".
				const at = roots.map((root) => arg.indexOf(root)).find((index) => index >= 0);
				if (at !== undefined && under(arg.slice(at))) found.add(arg.slice(at));
			}
		} catch {
			// Gone, or not ours.
		}
		try {
			const cwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
			if (under(cwd)) found.add(cwd);
		} catch {
			// Another user's process: no access to its folder link.
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
	/** Store entries that the global settings.json names: new sessions load them. */
	readonly named?: readonly string[];
	readonly now: number;
	readonly minAgeMs?: number;
	/** Command-line and working-folder scan (default `processRefs`). */
	readonly refs?: (roots: readonly string[]) => Set<string>;
	/** Maps scan (default `mappedPaths`): read only when `refs` leaves a folder undecided. */
	readonly mapped?: (roots: readonly string[]) => Set<string>;
}

export interface GcResult {
	readonly removed: string[];
	readonly failed: { readonly dir: string; readonly reason: string }[];
}

/** Scans that run at most once for each GC, and only when a folder needs them. */
interface Scans {
	readonly refs: () => Set<string>;
	readonly mapped: () => Set<string>;
}

const within = (paths: Set<string>, dir: string): boolean => [...paths].some((path) => path === dir || isInside(path, dir));

function keepReason(dir: string, options: GcOptions, inUse: readonly string[], scans: Scans): string | undefined {
	if (inUse.some((used) => used === dir || isInside(used, dir))) return "in use";
	if (STAGING_NAME.test(basename(dir))) return options.now - lstatSync(dir).mtimeMs < STAGING_MAX_AGE_MS ? "staging" : undefined;
	if (options.now - installedAt(dir) < (options.minAgeMs ?? MIN_AGE_MS)) return "young";
	if (within(scans.refs(), dir)) return "process";
	if (within(scans.mapped(), dir)) return "mapped";
	return undefined;
}

/** The real path of `path`, or of its nearest folder that exists (a folder that went away keeps its place). */
function realOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = resolve(path, "..");
		return parent === path ? path : join(realOr(parent), basename(path));
	}
}

/** Restart requests that no launcher read (it was killed) and old start stamps: a launcher reads its request within seconds. */
export const RESTART_FILE_MAX_AGE_MS = 24 * 3_600_000;

function sweepRestartFiles(paths: StorePaths, now: number): string[] {
	let names: string[];
	try {
		names = readdirSync(paths.restart);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of names) {
		const file = join(paths.restart, name);
		try {
			const stat = lstatSync(file);
			if (!stat.isFile() || now - stat.mtimeMs < RESTART_FILE_MAX_AGE_MS) continue;
			rmSync(file, { force: true });
			removed.push(file);
		} catch {
			// Gone already: the launcher read it.
		}
	}
	return removed;
}

export function collectGarbage(options: GcOptions): GcResult {
	const { state, leases } = options;
	const paths = storePaths(realpathSync(options.paths.root));
	const used = [...setDirs(state.current), ...setDirs(state.previous), ...(options.named ?? []), ...leases.flatMap((lease) => [lease.piDir, ...lease.releases])];
	const inUse = used.map((dir) => realOr(resolve(dir)));
	const once = (scan: (roots: readonly string[]) => Set<string>) => {
		let found: Set<string> | undefined;
		return () => (found ??= new Set([...scan([paths.root])].map(realOr)));
	};
	const scans: Scans = { refs: once(options.refs ?? processRefs), mapped: once(options.mapped ?? mappedPaths) };
	const removed: string[] = [];
	const failed: { dir: string; reason: string }[] = [];
	for (const dir of candidates(paths)) {
		if (keepReason(dir, options, inUse, scans) !== undefined) continue;
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
	removed.push(...sweepRestartFiles(paths, options.now));
	return { removed, failed };
}
