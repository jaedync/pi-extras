/**
 * Files of loaded packages that changed on disk after the process started.
 * Pi's loader reads .ts files again at each reload, but Node keeps native ES
 * modules (.js, .mjs, .cjs) in its cache by real path. When a package's files
 * change in place, a reload mixes new modules with cached old ones, and the
 * new code can call exports that the old modules lack (incident 2026-11-16).
 * A restart gives every module from disk again.
 */
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const NATIVE = /\.(?:js|mjs|cjs)$/;
/** A walk stops after this many entries: a package is never this large, a wrong root (a whole repository) can be. */
const MAX_ENTRIES = 50_000;
const MAX_RESULTS = 20;

/** The nearest folder at or above `path` that has a package.json; the path's own folder when none has. */
export function packageRoot(path: string): string {
	const dir = isDirectory(path) ? path : dirname(path);
	for (let up = dir; ; up = dirname(up)) {
		if (existsSync(join(up, "package.json"))) return up;
		if (dirname(up) === up) return dir;
	}
}

function isDirectory(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** The node_modules folder that holds `root` (also under a scope), whose packages npm hoisted for it; else undefined. */
function hoistedFolder(root: string): string | undefined {
	const parent = dirname(root);
	if (basename(parent) === "node_modules") return parent;
	return basename(parent).startsWith("@") && basename(dirname(parent)) === "node_modules" ? dirname(parent) : undefined;
}

/** The folders to walk for `paths`: each package with its hoisted dependencies, a folder inside another left out. */
export function walkRoots(paths: readonly string[]): string[] {
	const roots = new Set<string>();
	for (const path of paths.filter(existsSync)) {
		const root = packageRoot(path);
		roots.add(hoistedFolder(root) ?? root);
	}
	const all = [...roots];
	return all.filter((root) => !all.some((other) => other !== root && root.startsWith(`${other}/`)));
}

export interface ChangedOptions {
	readonly maxResults?: number;
	readonly maxEntries?: number;
	/** Called once when the walk stops at `maxEntries`, with that number. */
	readonly onLimit?: (entries: number) => void;
}

/**
 * Native-module files under the packages of `paths` whose content changed
 * (mtime) after `sinceMs`. A package's own files come before any
 * node_modules folder, so a large dependency tree cannot hide them. Symlinks
 * are not followed, `.git` is skipped, and unreadable or vanished folders
 * are skipped.
 */
export function changedInPlace(paths: readonly string[], sinceMs: number, options: ChangedOptions = {}): string[] {
	const maxResults = options.maxResults ?? MAX_RESULTS;
	const maxEntries = options.maxEntries ?? MAX_ENTRIES;
	const found: string[] = [];
	const own: string[] = [];
	const deps: string[] = [];
	for (const root of walkRoots(paths)) (basename(root) === "node_modules" ? deps : own).push(root);
	let entries = 0;
	const next = () => own.shift() ?? deps.shift();
	for (let dir = next(); dir !== undefined && found.length < maxResults; dir = next()) {
		for (const name of readable(dir)) {
			if (found.length >= maxResults) break;
			if (++entries > maxEntries) {
				options.onLimit?.(maxEntries);
				return found;
			}
			if (name === ".git") continue;
			const path = join(dir, name);
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (stat?.isDirectory()) (name === "node_modules" || basename(dir) === "node_modules" ? deps : own).push(path);
			// mtime, not ctime: a hard link or a chmod changes ctime but no module.
			else if (stat?.isFile() && NATIVE.test(name) && stat.mtimeMs > sinceMs) found.push(path);
		}
	}
	return found;
}

/** The names in `dir`; none for a folder that went away or that this user cannot read. */
function readable(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR") return [];
		throw error;
	}
}
