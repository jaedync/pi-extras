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
import type { Worktree } from "./types.ts";
import { gitCall, type GitCall } from "./worktree.ts";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** State by absolute path. */
export type Fingerprint = ReadonlyMap<string, string>;

async function git(cwd: string, args: readonly string[], call?: GitCall): Promise<string> {
	try {
		// No optional locks: status must not take index.lock while the child's own git commands run.
		const { stdout } = await run("git", ["--no-optional-locks", "-C", cwd, ...call?.args ?? [], ...args], {
			encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, ...(call ? { env: { ...process.env, ...call.env } } : {}),
		});
		return stdout;
	} catch (error) {
		const failure = error as { stderr?: string; killed?: boolean; message: string };
		const detail = failure.killed ? `timed out after ${GIT_TIMEOUT_MS / 1000} seconds` : failure.stderr || failure.message;
		throw new Error(`git ${args[0]} failed: ${String(detail).replace(/\s+/g, " ").trim().slice(0, 300)}`);
	}
}

// Git's words when its search up from the directory finds no repository. A broken repository words it differently, so it still fails.
// Anchored, because other failures quote a path, which can hold any words.
const NO_REPOSITORY = /^git rev-parse failed: fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point )/;
// The C locale keeps those words in English whatever the user's language is.
const ENGLISH: GitCall = { args: [], env: { LC_ALL: "C" } };

/** The top level of the git work tree that holds `cwd`, or undefined when no repository holds it. */
export async function gitRoot(cwd: string): Promise<string | undefined> {
	try { return (await git(cwd, ["rev-parse", "--show-toplevel"], ENGLISH)).trim(); }
	catch (error) {
		if (NO_REPOSITORY.test((error as Error).message)) return undefined;
		throw error;
	}
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

/** `worktree` is the child's, when `root` is its worktree: the child can write its git data, and gitCall keeps git from running what it put there. */
export async function fingerprint(root: string, worktree?: Worktree): Promise<Fingerprint> {
	const listed = statusPaths(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], gitCall(worktree)));
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
