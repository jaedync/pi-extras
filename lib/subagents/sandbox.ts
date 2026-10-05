/**
 * An OS sandbox for a worktree child's bash commands, so a shell command
 * can't write into the parent's checkout any more than an `edit` can. macOS
 * runs each command under sandbox-exec, Linux under bwrap when it is
 * installed; elsewhere commands run unconfined, as before.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";
import { sourceCheckout } from "./worktree.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const BWRAP = "bwrap";
const PROBE_TIMEOUT_MS = 5_000;
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

const seatbeltString = (text: string): string => `"${text.replace(/[\\"]/g, "\\$&")}"`;
const regexLiteral = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/** Seatbelt's last matching rule wins, so every denial comes before the exceptions. Paths must be resolved: seatbelt matches real paths. */
export function seatbeltProfile(roots: readonly string[]): string {
	const denials = roots.map((root) => `(deny file-write* (subpath ${seatbeltString(root)}))`);
	const exceptions = roots.flatMap((root) => [
		// A worktree's git data and objects live in its checkout's .git, so commits in the worktree write there.
		`(allow file-write* (subpath ${seatbeltString(join(root, ".git"))}))`,
		// Tool caches such as node_modules/.cache; the packages themselves stay the parent's.
		`(allow file-write* (regex ${seatbeltString(`^${regexLiteral(join(root, "node_modules"))}/\\.[^/]+(/|$)`)}))`,
	]);
	return ["(version 1)", "(allow default)", ...denials, ...exceptions].join("\n");
}

function dotEntries(dir: string): string[] {
	try { return readdirSync(dir).filter((name) => name.startsWith(".")).map((name) => join(dir, name)); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return [];
		throw error;
	}
}

/** bwrap binds need existing paths, so only the node_modules dot-entries present now stay writable. */
export function bwrapPrefix(roots: readonly string[]): string[] {
	const writable = roots.flatMap((root) => [join(root, ".git"), ...dotEntries(join(root, "node_modules"))]).filter((path) => existsSync(path));
	return [BWRAP, "--dev-bind", "/", "/", ...roots.flatMap((root) => ["--ro-bind", root, root]), ...writable.flatMap((path) => ["--bind", path, path])];
}

const onPath = (name: string): boolean => (process.env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, name)));

function confinement(roots: readonly string[]): string[] | undefined {
	if (process.platform === "darwin") return existsSync(SANDBOX_EXEC) ? [SANDBOX_EXEC, "-p", seatbeltProfile(roots)] : undefined;
	if (process.platform === "linux") return onPath(BWRAP) ? bwrapPrefix(roots) : undefined;
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
 * The sandbox for bash in the worktree at `path`, or undefined where none is
 * available. `onUnavailable` hears once why an installed sandbox tool failed.
 */
export function sandboxFor(path: string, onUnavailable?: (why: string) => void): Sandbox | undefined {
	const roots = protectedRoots(path).filter((root) => existsSync(root)).map((root) => realpathSync(root));
	const prefix = roots.length > 0 ? confinement(roots) : undefined;
	if (!prefix || broken.has(prefix[0]!)) return undefined;
	const failure = probe(prefix);
	if (failure === undefined) return { root: roots[0]!, prefix };
	broken.add(prefix[0]!);
	onUnavailable?.(failure);
	return undefined;
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
