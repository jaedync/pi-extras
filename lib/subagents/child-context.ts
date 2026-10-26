/**
 * A child's context files. A main session's AGENTS.md files carry rules for talking to the user,
 * publishing and long runs that a child never needs, and every child request pays for them. When
 * `<agentDir>/AGENTS.child.md` exists, a child gets it in place of the global AGENTS.md, and keeps
 * only the project files at or below its project root (the nearest `.git`, else its cwd): a
 * workspace file such as `~/dev/AGENTS.md` above the repository drops out. `full` (the spawn's
 * `fullInstructions`) keeps every file, as main has them.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const CHILD_INSTRUCTIONS_FILE = "AGENTS.child.md";

export interface ContextFile {
	readonly path: string;
	readonly content: string;
}

/** The nearest directory at or above `cwd` that holds `.git` (a directory, or a worktree's file); else `cwd`. */
export function projectRoot(cwd: string): string {
	let dir = resolve(cwd);
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return resolve(cwd);
		dir = parent;
	}
}

function readChildFile(agentDir: string): ContextFile | undefined {
	const path = join(agentDir, CHILD_INSTRUCTIONS_FILE);
	try {
		const content = readFileSync(path, "utf8");
		return content.trim().length === 0 ? undefined : { path, content };
	} catch {
		return undefined;
	}
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`);

export function childContextFiles(files: readonly ContextFile[], options: { agentDir: string; cwd: string; full: boolean }): ContextFile[] {
	if (options.full) return [...files];
	const child = readChildFile(options.agentDir);
	if (!child) return [...files];
	const agentDir = resolve(options.agentDir);
	const root = projectRoot(options.cwd);
	const project = files.filter((file) => dirname(resolve(file.path)) !== agentDir && within(dirname(resolve(file.path)), root));
	return [child, ...project];
}
