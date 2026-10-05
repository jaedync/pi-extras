/**
 * What a git workspace's changed files look like now: each path `git status`
 * lists, with its status, size and modification time, so a further edit to an
 * already dirty file shows too. Ignored files are not listed, so caches and
 * build output never count as changes.
 */
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** State by absolute path. */
export type Fingerprint = ReadonlyMap<string, string>;

async function git(cwd: string, args: readonly string[]): Promise<string> {
	try {
		// No optional locks: status must not take index.lock while the child's own git commands run.
		const { stdout } = await run("git", ["--no-optional-locks", "-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
		return stdout;
	} catch (error) {
		const failure = error as { stderr?: string; killed?: boolean; message: string };
		const detail = failure.killed ? `timed out after ${GIT_TIMEOUT_MS / 1000} seconds` : failure.stderr || failure.message;
		throw new Error(`git ${args[0]} failed: ${String(detail).replace(/\s+/g, " ").trim().slice(0, 300)}`);
	}
}

/** The top level of the git work tree that holds `cwd`. */
export async function gitRoot(cwd: string): Promise<string> {
	return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

/** Status code by path from `git status --porcelain=v1 -z`, where a rename or copy's source follows as its own field. */
export function statusPaths(output: string): Map<string, string> {
	const fields = output.split("\0");
	const entries = new Map<string, string>();
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index]!;
		if (field.length < 4) continue;
		const code = field.slice(0, 2);
		entries.set(field.slice(3), code);
		if (code[0] === "R" || code[0] === "C") entries.set(fields[++index] ?? "", code);
	}
	entries.delete("");
	return entries;
}

async function stamp(path: string): Promise<string> {
	try {
		const stats = await lstat(path);
		return `${stats.size} ${stats.mtimeMs}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return "missing";
		throw error;
	}
}

export async function fingerprint(root: string): Promise<Fingerprint> {
	const listed = statusPaths(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
	const states = await Promise.all([...listed].map(async ([path, code]) => {
		const absolute = join(root, path);
		return [absolute, `${code} ${await stamp(absolute)}`] as const;
	}));
	return new Map(states);
}

/** The paths whose state differs, listed in either fingerprint. */
export function changedPaths(before: Fingerprint, after: Fingerprint): string[] {
	const paths = new Set([...before.keys(), ...after.keys()]);
	return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}
