/** Isolated child workspaces retain the parent's current files without changing its index. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Worktree } from "./types.ts";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const WORKTREE_SUFFIX = ".worktrees";
const MAX_NAMES = 10_000;
const EXCLUDE_DEPENDENCIES = ":(exclude)node_modules";

function git(cwd: string, args: readonly string[], index?: string): string {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER,
			...(index ? { env: { ...process.env, GIT_INDEX_FILE: index } } : {}),
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		const detail = (error as { stderr?: string }).stderr || (error as Error).message;
		throw new Error(`Git ${args[0]} failed: ${String(detail).replace(/\s+/g, " ").trim().slice(0, 300)}`);
	}
}

/** Whether `tree`'s ignore rules cover its own `node_modules`; git exits 1 for "not ignored". */
function dependenciesIgnored(tree: string): boolean {
	try {
		execFileSync("git", ["-C", tree, "check-ignore", "-q", "node_modules"], { timeout: GIT_TIMEOUT_MS, stdio: "ignore" });
		return true;
	} catch (error) {
		if ((error as { status?: unknown }).status === 1) return false;
		throw new Error(`Git check-ignore failed: ${(error as Error).message.replace(/\s+/g, " ").trim().slice(0, 300)}`);
	}
}

/**
 * Dependencies stay shared; never commit an untracked directory or apply its symlink over the source.
 * Git refuses a pathspec that names an ignored path, so the exclusion is left out where the tree
 * ignores `node_modules` already. Each tree is asked: `node_modules/` ignores the source's directory
 * but not the worktree's symlink.
 */
function dependencyPaths(tree: string, base?: string): string[] {
	const tracked = git(tree, [...(base ? ["ls-tree", "-z", base] : ["ls-files", "-z"]), "--", "node_modules"]);
	return tracked || dependenciesIgnored(tree) ? [] : ["--", ".", EXCLUDE_DEPENDENCIES];
}

function snapshot(root: string, name: string): string {
	const temporary = mkdtempSync(join(tmpdir(), "pi-subagent-index-"));
	const index = join(temporary, "index");
	try {
		let head: string;
		try { head = git(root, ["rev-parse", "--verify", "HEAD"]).trim(); }
		catch (error) { throw new Error(`Worktree isolation needs an initial commit (HEAD). ${(error as Error).message}`); }
		git(root, ["read-tree", head], index);
		git(root, ["add", "-A", ...dependencyPaths(root)], index);
		const tree = git(root, ["write-tree"], index).trim();
		return git(root, ["commit-tree", tree, "-p", head, "-m", `subagent ${name}: base (main's uncommitted changes)`], index).trim();
	} finally { rmSync(temporary, { recursive: true, force: true }); }
}

function pathExists(path: string): boolean {
	try { lstatSync(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function available(root: string, name: string): { path: string; branch: string } {
	const branches = new Set(git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/subagent/"]).trim().split("\n"));
	for (let suffix = 1; suffix <= MAX_NAMES; suffix++) {
		const candidate = suffix === 1 ? name : `${name}-${suffix}`;
		const path = join(`${root}${WORKTREE_SUFFIX}`, candidate);
		const branch = `subagent/${candidate}`;
		if (!pathExists(path) && !branches.has(`refs/heads/${branch}`)) return { path, branch };
	}
	throw new Error(`No free worktree name for ${name}. Remove unused subagent worktrees and branches first.`);
}

function linkDependencies(root: string, path: string): void {
	const source = join(root, "node_modules");
	if (!existsSync(source) || git(root, ["ls-files", "-z", "--", "node_modules"]) || pathExists(join(path, "node_modules"))) return;
	symlinkSync(source, join(path, "node_modules"), "dir");
}

export function createWorktree(cwd: string, name: string): Worktree {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("Invalid subagent worktree name.");
	let root: string;
	try { root = git(cwd, ["rev-parse", "--show-toplevel"]).trim(); }
	catch (error) { throw new Error(`Worktree isolation needs a git repository in the parent's workspace. ${(error as Error).message}`); }
	const location = available(root, name);
	const base = snapshot(root, name);
	mkdirSync(dirname(location.path), { recursive: true });
	git(root, ["worktree", "add", "-b", location.branch, location.path, base]);
	try { linkDependencies(root, location.path); }
	catch (error) { throw new Error(`Could not link node_modules: ${(error as Error).message}. Worktree retained at ${location.path} on ${location.branch}.`); }
	return { ...location, base };
}

export function workspaceError(path: string): string | undefined {
	return existsSync(path) ? undefined : `The child workspace no longer exists: ${path}. Restore this workspace before resuming.`;
}

/** A tool's path as Pi's edit and write tools read it: an `@` prefix dropped, `~` and file URLs expanded. */
function toolPath(path: string): string {
	const bare = path.startsWith("@") ? path.slice(1) : path;
	if (bare === "~") return homedir();
	if (bare.startsWith("~/")) return join(homedir(), bare.slice(2));
	return bare.startsWith("file://") ? fileURLToPath(bare) : bare;
}

const ADVICE = "Edit only files inside it; your parent applies your changes to its checkout from your report.";

function within(dir: string, target: string): boolean {
	const rel = relative(dir, target);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/**
 * Where a write to the absolute `path` lands: the symlinks of its nearest
 * existing ancestor resolved, and a dangling final link followed, as the OS
 * does. A path that can't be resolved (a link loop, no permission) is
 * returned as written; the write fails there anyway.
 */
export function realTarget(path: string): string {
	try { return realpathSync(path); }
	catch (error) {
		if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") return path;
	}
	const parent = dirname(path);
	if (parent === path) return path;
	let link: string | undefined;
	try { link = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined; }
	catch (error) { if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") return path; }
	return link === undefined ? join(realTarget(parent), basename(path)) : realTarget(resolve(parent, link));
}

/** Where an `edit` or `write` call's `path`, read from `cwd`, lands; undefined for a malformed path. */
export function editTarget(cwd: string, path: unknown): string | undefined {
	return typeof path === "string" ? realTarget(resolve(cwd, toolPath(path))) : undefined;
}

/**
 * Why an edit of `path` would leave the child's worktree, or undefined. A
 * path inside it that resolves outside, through the `node_modules` link into
 * the parent's checkout for one, is refused too.
 */
export function outsideWorktree(worktree: Worktree, cwd: string, path: unknown): string | undefined {
	// The tool refuses a missing or malformed path itself.
	if (typeof path !== "string") return undefined;
	const target = resolve(cwd, toolPath(path));
	if (!within(worktree.path, target)) return `${target} is outside your worktree ${worktree.path}. ${ADVICE}`;
	const real = realTarget(target);
	if (within(realTarget(worktree.path), real)) return undefined;
	return `${target} resolves to ${real}, outside your worktree ${worktree.path}. ${ADVICE}`;
}

/** The checkout `path` was made from, when it is a subagent worktree (`<root>.worktrees/<name>`). */
export function sourceCheckout(path: string): string | undefined {
	const container = dirname(path);
	return container.endsWith(WORKTREE_SUFFIX) && container.length > WORKTREE_SUFFIX.length ? container.slice(0, -WORKTREE_SUFFIX.length) : undefined;
}

/** Persisted paths are used as command arguments and prompt text, never shell input. */
export function validWorktree(value: unknown): value is Worktree {
	if (!value || typeof value !== "object") return false;
	const w = value as Worktree;
	return typeof w.path === "string" && isAbsolute(w.path) && !/[\0\r\n]/.test(w.path)
		&& typeof w.branch === "string" && /^subagent\/[a-z0-9][a-z0-9-]*$/.test(w.branch)
		&& typeof w.base === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(w.base);
}

const quote = (value: string): string => /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

export function worktreeFooter(worktree: Worktree): string {
	const { path, branch, base } = worktree;
	try {
		const paths = dependencyPaths(path, base);
		git(path, ["add", "-A", ...paths]);
		const files = git(path, ["diff", "--cached", "--name-only", "-z", base, ...paths]).split("\0").filter(Boolean).length;
		const commits = git(path, ["rev-list", "--count", `${base}..HEAD`]).trim();
		const root = sourceCheckout(path);
		if (root === undefined) throw new Error("The saved worktree path has no source checkout.");
		const pathspec = paths.length ? ` ${paths.map(quote).join(" ")}` : "";
		return `\n\nWorktree: ${path} (${branch}); ${files} ${files === 1 ? "file differs" : "files differ"} from base, ${commits} ${commits === "1" ? "commit" : "commits"}.\n`
			+ `Apply: git -C ${quote(path)} add -A${pathspec} && git -C ${quote(path)} diff --binary --cached ${base}${pathspec} | git -C ${quote(root)} apply\n`
			+ `After you applied the changes (deletes this worktree): git worktree remove --force ${quote(path)} && git branch -D ${quote(branch)}`;
	} catch (error) {
		return `\n\nWorktree report unavailable: ${String((error as Error).message).replace(/\s+/g, " ").slice(0, 300)} (${path}, ${branch}).`;
	}
}
