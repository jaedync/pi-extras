/** Isolated child workspaces retain the parent's current files without changing its index. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { devNull, homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Worktree } from "./types.ts";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const WORKTREE_SUFFIX = ".worktrees";
const MAX_NAMES = 10_000;
const EXCLUDE_DEPENDENCIES = ":(exclude)node_modules";

/** How main runs git in a work tree (`gitCall`): arguments before the command, and environment. */
export interface GitCall {
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

const PLAIN: GitCall = { args: [], env: {} };

function git(cwd: string, args: readonly string[], index?: string, call: GitCall = PLAIN): string {
	try {
		return execFileSync("git", ["-C", cwd, ...call.args, ...args], {
			encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER,
			env: { ...process.env, ...call.env, ...(index ? { GIT_INDEX_FILE: index } : {}) },
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		const detail = (error as { stderr?: string }).stderr || (error as Error).message;
		throw new Error(`Git ${args[0]} failed: ${String(detail).replace(/\s+/g, " ").trim().slice(0, 300)}`);
	}
}

/** Whether `tree`'s ignore rules cover its own `node_modules`; git exits 1 for "not ignored". */
function dependenciesIgnored(tree: string, call: GitCall): boolean {
	try {
		execFileSync("git", ["-C", tree, ...call.args, "check-ignore", "-q", "node_modules"], { timeout: GIT_TIMEOUT_MS, stdio: "ignore", env: { ...process.env, ...call.env } });
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
function dependencyPaths(tree: string, base?: string, call: GitCall = PLAIN): string[] {
	const tracked = git(tree, [...(base ? ["ls-tree", "-z", base] : ["ls-files", "-z"]), "--", "node_modules"], undefined, call);
	return tracked || dependenciesIgnored(tree, call) ? [] : ["--", ".", EXCLUDE_DEPENDENCIES];
}

function snapshot(root: string, name: string, call: GitCall): string {
	const temporary = mkdtempSync(join(tmpdir(), "pi-subagent-index-"));
	const index = join(temporary, "index");
	try {
		let head: string;
		try { head = git(root, ["rev-parse", "--verify", "HEAD"], undefined, call).trim(); }
		catch (error) { throw new Error(`Worktree isolation needs an initial commit (HEAD). ${(error as Error).message}`); }
		git(root, ["read-tree", head], index, call);
		const tree = treeOf(root, dependencyPaths(root, undefined, call), call, index);
		return git(root, ["commit-tree", tree, "-p", head, "-m", `subagent ${name}: base (main's uncommitted changes)`], index, call).trim();
	} finally { rmSync(temporary, { recursive: true, force: true }); }
}

function pathExists(path: string): boolean {
	try { lstatSync(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function available(root: string, name: string, call: GitCall): { path: string; branch: string } {
	const branches = new Set(git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/subagent/"], undefined, call).trim().split("\n"));
	for (let suffix = 1; suffix <= MAX_NAMES; suffix++) {
		const candidate = suffix === 1 ? name : `${name}-${suffix}`;
		const path = join(`${root}${WORKTREE_SUFFIX}`, candidate);
		const branch = `subagent/${candidate}`;
		if (!pathExists(path) && !branches.has(`refs/heads/${branch}`)) return { path, branch };
	}
	throw new Error(`No free worktree name for ${name}. Remove unused subagent worktrees and branches first.`);
}

function linkDependencies(root: string, path: string, call: GitCall): void {
	const source = join(root, "node_modules");
	if (!existsSync(source) || git(root, ["ls-files", "-z", "--", "node_modules"], undefined, call) || pathExists(join(path, "node_modules"))) return;
	symlinkSync(source, join(path, "node_modules"), "dir");
}

/**
 * A worktree of the repository at `cwd`; `named` is a cwd the spawn gave,
 * which an error names instead of the parent's workspace. `from` is the
 * worktree of the child that spawns, which the new one is made from: main
 * runs git there only through its verified git folders (`gitCall`).
 */
export function createWorktree(cwd: string, name: string, named?: string, from?: Worktree): Worktree {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("Invalid subagent worktree name.");
	const call = gitCall(from);
	let root: string;
	try { root = from?.path ?? git(cwd, ["rev-parse", "--show-toplevel"]).trim(); }
	catch (error) { throw new Error(`Worktree isolation needs a git repository in ${named ?? "the parent's workspace"}. ${(error as Error).message}`); }
	const location = available(root, name, call);
	const base = snapshot(root, name, call);
	mkdirSync(dirname(location.path), { recursive: true });
	git(root, ["worktree", "add", "-b", location.branch, location.path, base], undefined, call);
	try { linkDependencies(root, location.path, call); }
	catch (error) { throw new Error(`Could not link node_modules: ${(error as Error).message}. Worktree retained at ${location.path} on ${location.branch}.`); }
	return { ...location, base };
}

export function workspaceError(path: string): string | undefined {
	return existsSync(path) ? undefined : `The child workspace no longer exists: ${path}. Restore this workspace before resuming.`;
}

/** The spaces Pi's `resolveToCwd` turns into plain ones before it resolves a tool's path (Pi's utils/paths.ts). */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Git Bash, MSYS, Cygwin and WSL drive paths as Windows reads them (Pi's `normalizeWindowsShellPath`). */
function windowsShellPath(path: string): string {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
	const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
	if (!match) return path;
	return `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

/**
 * A tool's path as Pi's edit and write tools read it (Pi's `normalizePath`):
 * Unicode spaces made plain, an `@` prefix dropped, Windows shell paths
 * converted on Windows, `~` and file URLs expanded.
 */
function toolPath(path: string): string {
	const spaced = path.replace(UNICODE_SPACES, " ");
	const bare = spaced.startsWith("@") ? spaced.slice(1) : spaced;
	const windows = process.platform === "win32";
	const native = windows ? windowsShellPath(bare) : bare;
	if (native === "~") return homedir();
	if (native.startsWith("~/") || (windows && native.startsWith("~\\"))) return join(homedir(), native.slice(2));
	return native.startsWith("file://") ? fileURLToPath(native) : native;
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

/** Where `dir`, a directory of the checkout `root`, is in the worktree `tree` made from it; the worktree's top when it has no such directory. */
export function placeInWorktree(tree: string, root: string, dir: string): string {
	if (!within(root, dir)) return tree;
	const place = join(tree, relative(root, dir));
	try { return statSync(place).isDirectory() ? place : tree; }
	// An ignored directory is not copied into the worktree.
	catch { return tree; }
}

/** Where `path`, inside the worktree, is in the checkout it was made from; `path` itself outside it. */
export function sourcePlace(worktree: Worktree, path: string): string {
	const source = sourceCheckout(worktree.path);
	return source !== undefined && within(worktree.path, path) ? join(source, relative(worktree.path, path)) : path;
}

/** The checkout `path` was made from, when it is a subagent worktree (`<root>.worktrees/<name>`). */
export function sourceCheckout(path: string): string | undefined {
	const container = dirname(path);
	return container.endsWith(WORKTREE_SUFFIX) && container.length > WORKTREE_SUFFIX.length ? container.slice(0, -WORKTREE_SUFFIX.length) : undefined;
}

const oneLine = (error: unknown): string => String((error as { stderr?: unknown }).stderr || (error as Error).message).replace(/\s+/g, " ").trim().slice(0, 200);

/** The repository's shared git folder, real, as the checkout `root` names it; or why not. */
export function commonGitDir(root: string): { dir: string } | { why: string } {
	try {
		const out = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
		return { dir: realpathSync(out.trim()) };
	} catch (error) { return { why: `git can't find the git folder of ${root}: ${oneLine(error)}` }; }
}

/** Whether the folder `dir` is a real folder whose `gitdir` file names `want`, compared as text. */
function namesWorktree(dir: string, want: string): boolean {
	try {
		if (!lstatSync(dir).isDirectory()) return false;
		return resolve(dir, readFileSync(join(dir, "gitdir"), "utf8").trim()) === want;
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false;
		throw error;
	}
}

/**
 * The git folder in `common/worktrees` of the worktree at `path` (its real
 * path, as `createWorktree` saved it), or why not. The worktree's `.git` and
 * its own git folder are the child's to write, so neither is followed: the
 * folder is the one real folder whose `gitdir` text names this worktree. A
 * child can rewrite only its own folder's, which then names nothing or makes
 * a second match, and both are refused.
 */
export function worktreeGitDir(path: string, common: string): { dir: string } | { why: string } {
	const folder = join(common, "worktrees");
	const refused = `No folder in ${folder} is ${join(path, ".git")}'s alone.`;
	try {
		const found = readdirSync(folder).map((name) => join(folder, name)).filter((dir) => namesWorktree(dir, join(path, ".git")));
		return found.length === 1 ? { dir: found[0]! } : { why: refused };
	} catch (error) { return { why: `${refused} ${oneLine(error)}` }; }
}

/**
 * Config for main's git commands in a work tree that a child can write: no
 * fsmonitor program, no hooks, no automatic gc, and no look into submodules,
 * whose git folders the child can write too. A `-c` wins over every config file.
 */
const SAFE_CONFIG = ["core.fsmonitor=false", `core.hooksPath=${devNull}`, "diff.ignoreSubmodules=all", "submodule.recurse=false", "gc.auto=0", "maintenance.auto=false"]
	.flatMap((setting) => ["-c", setting]);

/**
 * The checkout that the worktree at `path` comes from at the end of its
 * chain: a nested worktree's parent worktree is a child's to write, its
 * first checkout is not.
 */
export function firstCheckout(path: string): string | undefined {
	const source = sourceCheckout(path);
	return source === undefined ? undefined : firstCheckout(source) ?? source;
}

/**
 * How main runs git in a child's `worktree` (a record's): with the worktree's
 * own git folder and the shared one, so git reads neither the `.git` nor the
 * `commondir` file, which the child can write. Without a worktree, only the
 * safe config. Throws when the worktree's git folder can't be told.
 */
export function gitCall(worktree: Pick<Worktree, "path"> | undefined): GitCall {
	if (!worktree) return { args: SAFE_CONFIG, env: {} };
	const first = firstCheckout(worktree.path);
	if (first === undefined || !existsSync(first)) throw new Error(`${worktree.path} has no source checkout on disk.`);
	const common = commonGitDir(realpathSync(first));
	if ("why" in common) throw new Error(common.why);
	const own = worktreeGitDir(worktree.path, common.dir);
	if ("why" in own) throw new Error(own.why);
	return { args: ["--git-dir", own.dir, "--work-tree", worktree.path, ...SAFE_CONFIG], env: { GIT_COMMON_DIR: common.dir } };
}

/** The tree of the work tree's files now: `git add -A` into the index, then `write-tree`, both with `call` and `index`. */
function treeOf(path: string, paths: readonly string[], call: GitCall, index?: string): string {
	git(path, ["add", "-A", ...paths], index, call);
	return git(path, ["write-tree"], index, call).trim();
}

/** Persisted paths are used as command arguments and prompt text, never shell input. */
export function validWorktree(value: unknown): value is Worktree {
	if (!value || typeof value !== "object") return false;
	const w = value as Worktree;
	return typeof w.path === "string" && isAbsolute(w.path) && !/[\0\r\n]/.test(w.path)
		&& typeof w.branch === "string" && /^subagent\/[a-z0-9][a-z0-9-]*$/.test(w.branch)
		&& typeof w.base === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(w.base);
}

// zsh expands an unquoted word that starts with "=" (=ls gives /bin/ls), so only an inner "=" stays bare.
const quote = (value: string): string => /^[a-zA-Z0-9_./-][a-zA-Z0-9_./=-]*$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/**
 * A shell command that runs git in `root`. When `root` is a subagent's
 * worktree (a nested worktree's parent), git gets its verified git folders,
 * so the line never follows the `.git` file that child can write.
 */
function gitIn(root: string): string {
	if (firstCheckout(root) === undefined) return `git -C ${quote(root)}`;
	const { args, env } = gitCall({ path: root });
	const assignments = Object.entries(env).map(([name, value]) => `${name}=${quote(value)} `).join("");
	return `${assignments}git -C ${quote(root)} ${args.map(quote).join(" ")}`;
}

/** Runs `count` against a temporary index of the worktree's files as they are, so the child's own staging stays as it was. */
function withTemporaryIndex<T>(path: string, paths: readonly string[], call: GitCall, count: (index: string) => T): T {
	const temporary = mkdtempSync(join(tmpdir(), "pi-subagent-index-"));
	const index = join(temporary, "index");
	try {
		git(path, ["read-tree", "HEAD"], index, call);
		git(path, ["add", "-A", ...paths], index, call);
		return count(index);
	} finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function worktreeFooter(worktree: Worktree): string {
	const { path, branch, base } = worktree;
	try {
		const call = gitCall(worktree);
		const paths = dependencyPaths(path, base, call);
		// One temporary index: the child's own staging stays as it was, and the tree is the snapshot the counts describe.
		const { files, tree } = withTemporaryIndex(path, paths, call, (index) => ({
			files: git(path, ["diff", "--cached", "--name-only", "-z", base, ...paths], index, call).split("\0").filter(Boolean).length,
			tree: git(path, ["write-tree"], index, call).trim(),
		}));
		const commits = git(path, ["rev-list", "--count", `${base}..HEAD`], undefined, call).trim();
		const root = sourceCheckout(path);
		if (root === undefined) throw new Error("The saved worktree path has no source checkout.");
		const pathspec = paths.length ? ` ${paths.map(quote).join(" ")}` : "";
		return `\n\nWorktree: ${path} (${branch}); ${files} ${files === 1 ? "file differs" : "files differ"} from base, ${commits} ${commits === "1" ? "commit" : "commits"}.\n`
			// Git runs only in the parent's checkout, on the tree written above, so main's bash never reads the child's git data.
			+ `Apply: ${gitIn(root)} diff --binary --no-ext-diff --no-textconv ${base} ${tree}${pathspec} | ${gitIn(root)} apply\n`
			+ `After you applied the changes (deletes this worktree): git worktree remove --force ${quote(path)} && git branch -D ${quote(branch)}`;
	} catch (error) {
		return `\n\nWorktree report unavailable: ${String((error as Error).message).replace(/\s+/g, " ").slice(0, 300)} (${path}, ${branch}).`;
	}
}
