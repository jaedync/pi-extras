/**
 * Which git work tree holds a path: the key of the edit lock for an edit
 * there, so children that edit different repositories or worktrees never
 * block each other. Looked up once per directory, so an edit does not start
 * a git process each time.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname } from "node:path";

const GIT_TIMEOUT_MS = 10_000;
/** Directories remembered; past this the cache starts over rather than grow without bound. */
const MAX_CACHED = 2_000;

/** git's top level for the directory `dir`, or undefined outside a work tree or when git fails. */
export function gitTopLevel(dir: string): string | undefined {
	try {
		return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		// Not a work tree (or inside .git): the caller falls back to the child's own workspace.
		return undefined;
	}
}

/** The directory a write to `path` happens in that exists now. */
function existingDir(path: string): string {
	try {
		if (statSync(path).isDirectory()) return path;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
	}
	const parent = dirname(path);
	return parent === path ? path : existingDir(parent);
}

export class WorkTrees {
	private readonly tops = new Map<string, string | undefined>();
	private readonly lookup: (dir: string) => string | undefined;

	constructor(lookup: (dir: string) => string | undefined = gitTopLevel) {
		this.lookup = lookup;
	}

	/** The top level of the work tree that holds the absolute `path`, if any. */
	topOf(path: string): string | undefined {
		let dir: string;
		try { dir = existingDir(path); }
		// A directory it may not read: treated like a path outside any work tree.
		catch { return undefined; }
		if (!this.tops.has(dir)) {
			if (this.tops.size >= MAX_CACHED) this.tops.clear();
			this.tops.set(dir, this.lookup(dir));
		}
		return this.tops.get(dir);
	}
}
