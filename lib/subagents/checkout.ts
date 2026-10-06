/**
 * Where a child works. `cwd` is the directory a spawn names for it; its
 * checkout is git's top level of that directory, or the directory itself
 * outside git, with links resolved, so two paths to one place are one
 * checkout. The edit lock keys a child's edits outside git by its checkout
 * (edit-lock.ts).
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { gitTopLevel } from "./work-trees.ts";

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** Characters a path to work in never needs: they break a saved line or move the terminal. */
export const CONTROL = /[\x00-\x1f\x7f]/;

/** The real path of the directory `input` names: absolute, or under `~/`; it must exist. */
export function resolveCwd(input: string, home = homedir()): string {
	// Saved, put in prompts and drawn in the terminal.
	if (CONTROL.test(input)) throw new Error("cwd must not contain control characters.");
	const expanded = input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
	if (!isAbsolute(expanded)) throw new Error(`cwd must be an absolute path or start with ~/: ${input}`);
	let real: string;
	try { real = realpathSync(expanded); }
	catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") throw new Error(`cwd ${input} does not exist.`);
		throw new Error(`cwd ${input} can't be read: ${(error as Error).message}`);
	}
	if (!statSync(real).isDirectory()) throw new Error(`cwd ${input} is not a directory.`);
	return real;
}

/** The checkout of the directory `dir`: git's top level, or `dir` outside git, as a real path. */
export function checkoutOf(dir: string): string {
	const place = gitTopLevel(dir) ?? dir;
	// A directory that is gone keeps its path; resuming it is refused (worktree.ts workspaceError).
	try { return realpathSync(place); }
	catch { return place; }
}
