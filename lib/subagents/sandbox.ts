/**
 * An OS sandbox for a worktree child's bash commands, so a shell command
 * can't write into the parent's checkout any more than an `edit` can. macOS
 * runs each command under sandbox-exec, Linux under bwrap when it is
 * installed; elsewhere commands run unconfined, as before. Every child's bash
 * also gets the paths hidden from subagents (hidden.ts) covered: an empty
 * tmpfs over each folder and /dev/null over each file on Linux, denied reads
 * on macOS.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";
import type { Worktree } from "./types.ts";
import { commonGitDir, sourceCheckout, worktreeGitDir } from "./worktree.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const BWRAP = "bwrap";
const PROBE_TIMEOUT_MS = 5_000;
/** The one node_modules entry a worktree child may write: tool caches. The packages, `.bin` shims and package-manager files stay the parent's. */
const CACHE_DIR = join("node_modules", ".cache");
const ARG_VARIABLE = "PI_SUBAGENT_SANDBOX_ARG_";
const COMMAND_VARIABLE = "PI_SUBAGENT_SANDBOX_COMMAND";

export interface Sandbox {
	/** The parent's checkout, named when a write is denied. */
	root: string;
	/** The command that confines the shell and the child's own command after it. */
	prefix: readonly string[];
}

/** Every checkout the worktree at `path` was made from, nearest first: a nested worktree protects its parent's worktree and main's checkout. */
export function protectedRoots(path: string): string[] {
	const root = sourceCheckout(path);
	return root === undefined ? [] : [root, ...protectedRoots(root)];
}

/**
 * What commits in a worktree write in its repository's git data, which lives
 * in the parent's checkout. The hooks, config, info/ and the other branches stay read-only.
 */
export interface GitWrites {
	/** Written as a whole: the worktree's own git folder and the shared object store. */
	readonly trees: readonly string[];
	/** Its branch's ref and reflog, each replaced through a lock file beside it, in a folder git may have to make again. */
	readonly files: readonly string[];
	/**
	 * Files in the trees above that stay read-only: the worktree's `config.worktree`, which git reads as config,
	 * also for main's git commands, when the repository turns on extensions.worktreeConfig (git sparse-checkout does).
	 */
	readonly readOnly: readonly string[];
}

export const NO_GIT_WRITES: GitWrites = { trees: [], files: [], readOnly: [] };

/** What a child's bash may not read (hidden.ts), as real paths. */
export interface Hiding {
	readonly dirs: readonly string[];
	readonly files: readonly string[];
}

export const NO_HIDING: Hiding = { dirs: [], files: [] };

/** Seatbelt rules that deny reads of the hidden paths; last, since the last matching rule wins. */
export function seatbeltHiding(hiding: Hiding): string[] {
	return [...hiding.dirs.map((dir) => `(deny file-read* (subpath ${seatbeltString(dir)}))`), ...hiding.files.map((file) => `(deny file-read* (literal ${seatbeltString(file)}))`)];
}

/** bwrap arguments that cover the hidden paths that exist: a bind needs a path to bind over. */
export function bwrapHiding(hiding: Hiding): string[] {
	return [...hiding.dirs.filter((dir) => existsSync(dir)).flatMap((dir) => ["--tmpfs", dir]),
		...hiding.files.filter((file) => existsSync(file)).flatMap((file) => ["--ro-bind", "/dev/null", file])];
}

/**
 * What git needs to write for `git add`, `git commit` and `git status` in
 * the worktree, read from `root`, its real source checkout; or why it can't
 * be told. The branch comes from the record, not the worktree's HEAD, which
 * the child can move.
 */
export function gitWrites(worktree: Pick<Worktree, "path" | "branch">, root: string): GitWrites | string {
	const common = commonGitDir(root);
	if ("why" in common) return common.why;
	const own = worktreeGitDir(worktree.path, common.dir);
	if ("why" in own) return own.why;
	const ref = join("refs", "heads", worktree.branch);
	return { trees: [own.dir, join(common.dir, "objects")], files: [join(common.dir, ref), join(common.dir, "logs", ref)], readOnly: [join(own.dir, "config.worktree")] };
}

const seatbeltString = (text: string): string => `"${text.replace(/[\\"]/g, "\\$&")}"`;
const regexLiteral = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

const folders = (files: readonly string[]): string[] => [...new Set(files.map((file) => dirname(file)))];

/** Seatbelt's last matching rule wins, so every denial comes before the exceptions. Paths must be resolved: seatbelt matches real paths. */
export function seatbeltProfile(roots: readonly string[], git: GitWrites, hiding: Hiding = NO_HIDING): string {
	const denials = roots.map((root) => `(deny file-write* (subpath ${seatbeltString(root)}))`);
	const exceptions = [
		...git.trees.map((tree) => `(allow file-write* (subpath ${seatbeltString(tree)}))`),
		...git.files.map((file) => `(allow file-write* (regex ${seatbeltString(`^${regexLiteral(file)}(\\.lock)?$`)}))`),
		// Only the folder itself, so git can make it again after `git pack-refs` removed it; nothing in it beyond the files above.
		...folders(git.files).map((folder) => `(allow file-write* (literal ${seatbeltString(folder)}))`),
		...roots.map((root) => `(allow file-write* (subpath ${seatbeltString(join(root, CACHE_DIR))}))`),
		// After the allows, which it narrows.
		...git.readOnly.map((file) => `(deny file-write* (literal ${seatbeltString(file)}))`),
		...seatbeltHiding(hiding),
	];
	return ["(version 1)", "(allow default)", ...denials, ...exceptions].join("\n");
}

/**
 * bwrap binds need existing paths. A bind over a file would make git's rename
 * of the lock file onto it fail, so the branch's ref and reflog folders are
 * bound whole: there, a child can also move another subagent's branch. Main
 * makes them first, since `git pack-refs` or gc can remove them.
 */
export function bwrapPrefix(roots: readonly string[], git: GitWrites, hiding: Hiding = NO_HIDING): string[] {
	for (const folder of folders(git.files)) mkdirSync(folder, { recursive: true });
	// A read-only bind needs a file to bind; an empty config changes nothing for git.
	for (const file of git.readOnly) if (!existsSync(file)) writeFileSync(file, "", { flag: "wx" });
	const writable = [...git.trees, ...folders(git.files), ...roots.map((root) => join(root, CACHE_DIR))].filter((path) => existsSync(path));
	return [BWRAP, "--dev-bind", "/", "/", ...roots.flatMap((root) => ["--ro-bind", root, root]), ...writable.flatMap((path) => ["--bind", path, path]),
		...git.readOnly.flatMap((file) => ["--ro-bind", file, file]), ...bwrapHiding(hiding)];
}

const onPath = (name: string): boolean => (process.env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, name)));

function confinement(roots: readonly string[], git: () => GitWrites, hiding: Hiding): string[] | undefined {
	if (process.platform === "darwin") return existsSync(SANDBOX_EXEC) ? [SANDBOX_EXEC, "-p", seatbeltProfile(roots, git(), hiding)] : undefined;
	if (process.platform === "linux") return onPath(BWRAP) ? bwrapPrefix(roots, git(), hiding) : undefined;
	return undefined;
}

/** The prefix that only hides paths, for a child with no worktree; undefined where no sandbox tool is available. */
export function hidingPrefix(hiding: Hiding, platform: NodeJS.Platform = process.platform): string[] | undefined {
	if (platform === "darwin") return existsSync(SANDBOX_EXEC) ? [SANDBOX_EXEC, "-p", ["(version 1)", "(allow default)", ...seatbeltHiding(hiding)].join("\n")] : undefined;
	if (platform === "linux") return onPath(BWRAP) ? [BWRAP, "--dev-bind", "/", "/", ...bwrapHiding(hiding)] : undefined;
	return undefined;
}

/** Tools that failed once (Pi itself sandboxed, user namespaces off) aren't tried or reported again in this process. */
const broken = new Set<string>();

function probe(prefix: readonly string[]): string | undefined {
	try {
		execFileSync(prefix[0]!, [...prefix.slice(1), "true"], { stdio: ["ignore", "ignore", "pipe"], timeout: PROBE_TIMEOUT_MS });
		return undefined;
	} catch (error) {
		const detail = String((error as { stderr?: unknown }).stderr || (error as Error).message).replace(/\s+/g, " ").trim().slice(0, 200);
		return `${prefix[0]} failed: ${detail}`;
	}
}

/**
 * The sandbox for bash in `worktree`, or undefined where none is available.
 * `onUnavailable` hears once why an installed sandbox tool failed;
 * `onNoGit` why the sandbox keeps all git data read-only, so commits fail.
 */
export function sandboxFor(worktree: Pick<Worktree, "path" | "branch">, onUnavailable?: (why: string) => void, onNoGit?: (why: string) => void, hiding: Hiding = NO_HIDING): Sandbox | undefined {
	const roots = protectedRoots(worktree.path).filter((root) => existsSync(root)).map((root) => realpathSync(root));
	const git = (): GitWrites => {
		// The first checkout, not a parent worktree, whose .git the parent child can write.
		const found = gitWrites(worktree, roots.at(-1)!);
		if (typeof found !== "string") return found;
		onNoGit?.(found);
		return NO_GIT_WRITES;
	};
	const prefix = roots.length > 0 ? confinement(roots, git, hiding) : undefined;
	if (!prefix || !works(prefix, onUnavailable)) return undefined;
	return { root: roots[0]!, prefix };
}

/** Whether the sandbox tool of `prefix` runs here; the first failure is told once and the tool is not tried again. */
function works(prefix: readonly string[], onUnavailable?: (why: string) => void): boolean {
	if (broken.has(prefix[0]!)) return false;
	const failure = probe(prefix);
	if (failure === undefined) return true;
	broken.add(prefix[0]!);
	onUnavailable?.(failure);
	return false;
}

/**
 * The prefix that hides paths from the bash of a child with no worktree, or
 * undefined where no sandbox tool runs; `onUnavailable` hears once why one failed.
 */
export function hidingFor(hiding: Hiding, onUnavailable?: (why: string) => void): readonly string[] | undefined {
	if (hiding.dirs.length === 0 && hiding.files.length === 0) return undefined;
	const prefix = hidingPrefix(hiding);
	return prefix && works(prefix, onUnavailable) ? prefix : undefined;
}

/**
 * A spawn hook that runs the command under `prefix`. The prefix and the
 * command travel in environment variables, so the shell line is fixed text
 * with nothing to quote, and the variables are gone before the command runs.
 * `$0` is the shell Pi started, which then runs the child's own command.
 */
export function confine(prefix: readonly string[]): (context: BashSpawnContext) => BashSpawnContext {
	const names = prefix.map((_, index) => `${ARG_VARIABLE}${index}`);
	const line = `set -- ${names.map((name) => `"$${name}"`).join(" ")} "$0" -c "$${COMMAND_VARIABLE}"; unset ${[...names, COMMAND_VARIABLE].join(" ")}; exec "$@"`;
	return (context) => ({
		...context,
		command: line,
		env: { ...context.env, ...Object.fromEntries(names.map((name, index) => [name, prefix[index]])), [COMMAND_VARIABLE]: context.command },
	});
}

const DENIED_WRITE = /Operation not permitted|Read-only file system/;

/** The line a command's result gets when its output shows the sandbox denied a write, whatever its exit code. */
export function deniedWriteNote(sandbox: Sandbox, output: string): string | undefined {
	if (!DENIED_WRITE.test(output)) return undefined;
	return `Writes outside your worktree are blocked. ${sandbox.root} is your parent's checkout, and node_modules links into it. Change files only in your worktree, or tell your parent what to change there.`;
}
