/**
 * Files of loaded packages that changed on disk after the process started.
 * Pi's loader reads .ts files again at each reload, but Node keeps native ES
 * modules (.js, .mjs, .cjs) in its cache by real path. When a package's files
 * change in place, a reload mixes new modules with cached old ones, and the
 * new code can call exports that the old modules lack (incident 2026-11-16).
 * A restart gives every module from disk again.
 */
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const NATIVE = /\.(?:js|mjs|cjs)$/;
/** A walk stops after this many entries: a package is never this large, a wrong root (a home folder) can be. */
const MAX_ENTRIES = 50_000;
const MAX_RESULTS = 20;

/** The nearest folder at or above `path` that has a package.json; the path's own folder when none has. */
export function packageRoot(path: string): string {
	let dir = isDirectory(path) ? path : dirname(path);
	for (let up = dir; ; up = dirname(up)) {
		if (existsSync(join(up, "package.json"))) return up;
		if (dirname(up) === up) return dir;
	}
}

function isDirectory(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** A folder or file that went away during the walk is no change to report; other errors go to the caller. */
function gone(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Native-module files under the packages of `paths` with a change time after
 * `sinceMs`. Symlinks are not followed; `.git` is skipped. Paths that do not
 * exist give nothing. An unreadable folder throws: the caller logs it.
 */
export function changedInPlace(paths: readonly string[], sinceMs: number, options: { readonly maxResults?: number } = {}): string[] {
	const maxResults = options.maxResults ?? MAX_RESULTS;
	const roots = [...new Set(paths.filter(existsSync).map(packageRoot))];
	const found: string[] = [];
	let entries = 0;
	const walk = (dir: string): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch (error) {
			if (gone(error)) return;
			throw error;
		}
		for (const name of names) {
			if (found.length >= maxResults || ++entries > MAX_ENTRIES) return;
			if (name === ".git") continue;
			const path = join(dir, name);
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (!stat) continue;
			if (stat.isDirectory()) walk(path);
			else if (stat.isFile() && NATIVE.test(name) && Math.max(stat.mtimeMs, stat.ctimeMs) > sinceMs) found.push(path);
		}
	};
	// A root inside another root is walked with the outer one.
	for (const root of roots.filter((root) => !roots.some((other) => other !== root && root.startsWith(`${other}/`)))) walk(root);
	return found;
}
