/**
 * What a child may not read: every subagent's sessions and reports, and
 * main's session. An agent asked for an independent opinion must not read the
 * work of the agents beside it, and no child needs main's whole transcript.
 * Its own files, its subagents' and the reports it was given stay readable.
 *
 * Pi's read, grep, find and ls tools are checked before and after they run
 * (child.ts), so a symlink made between the two can't take a read past the
 * check. A child's bash runs with the folder covered by an empty tmpfs where
 * a sandbox tool is available (sandbox.ts).
 */
import { resolve, sep } from "node:path";
import type { HostTeam } from "./contract.ts";
import type { AgentRecord } from "./types.ts";
import { realTarget, toolPath } from "./worktree.ts";

/** The tools whose `path` is checked. */
export const HIDDEN_READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
/** The tools that read everything under their path, so a path that holds a hidden one is refused too. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(["grep", "find"]);

export interface HiddenPaths {
	/** Real paths of the folders a child may not read. */
	readonly dirs: readonly string[];
	/** Real paths of single files a child may not read. */
	readonly files: readonly string[];
	/** Whether the child may read the real path `path` in a hidden folder: its own files, its subagents', the reports given to it. */
	readable(path: string): boolean;
}

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

/** Why the child may not run `tool` with `input` from `cwd`, or undefined when it may. */
export function hiddenReason(hidden: HiddenPaths, tool: string, input: unknown, cwd: string): string | undefined {
	if (!HIDDEN_READ_TOOLS.has(tool)) return undefined;
	const raw = (input as { path?: unknown } | undefined)?.path;
	// A malformed path fails in the tool itself.
	if (raw !== undefined && typeof raw !== "string") return undefined;
	const shown = raw ?? ".";
	const target = realTarget(resolve(cwd, toolPath(shown)));
	if (hidden.files.includes(target) || hidden.dirs.some((dir) => within(target, dir) && !hidden.readable(target))) {
		return `${shown} is hidden from subagents: it holds other agents' sessions and reports, or main's session. Read your own files, your subagents' and the reports you were given; ask your parent for anything else.`;
	}
	if (!SEARCH_TOOLS.has(tool)) return undefined;
	if (hidden.dirs.some((dir) => within(dir, target) && dir !== target)) return `${shown} holds a folder hidden from subagents (other agents' sessions and reports). Search a narrower folder.`;
	if (hidden.files.some((file) => within(file, target))) return `${shown} holds a file hidden from subagents (main's session). Search a narrower folder.`;
	return undefined;
}

/** The files of the agent whose session is `sessionFile`: the session itself and each `<base>.<anything>` beside it, such as its run reports. */
export function ownsFile(sessionFile: string, path: string): boolean {
	const real = realTarget(sessionFile);
	return path === real || path.startsWith(`${real.replace(/\.jsonl$/, "")}.`);
}

/**
 * What a child may not read: every session's subagent folder (`folder`) and
 * main's session file. It may read its own files, those of agents under it,
 * and the reports of the agents it started after, unless it was told not to
 * get them (afterReports: false). Read from the team at each call, so a
 * subagent it starts later counts.
 */
export function hiddenFrom(folder: string, mainSession: string | undefined, team: () => Pick<HostTeam, "get" | "list" | "under">): (record: AgentRecord) => HiddenPaths {
	const dirs = [realTarget(folder)];
	const files = mainSession ? [realTarget(mainSession)] : [];
	return (record) => ({
		dirs, files,
		readable(path) {
			const now = team();
			const self = now.get(record.name) ?? record;
			const given = self.afterReports === false ? [] : self.after ?? [];
			return now.list().some((other) => other.sessionFile !== undefined && ownsFile(other.sessionFile, path)
				&& (other.name === self.name || now.under(other.name, self.name) || given.includes(other.name)));
		},
	});
}
