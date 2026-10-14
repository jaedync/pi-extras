/**
 * What a child's launch read, so an open session is reused only while a
 * launch now would make the same one: the module generation that launched it
 * (each /reload evaluates this package again), and the identity of each file
 * its settings, models and resources came from. A file's identity is its
 * stat, so an edit, a replacement or a removal changes it without a parse.
 *
 * Extension files are not inputs: Pi caches extension code by working
 * directory until main's next /reload, which changes the generation, so a
 * relaunch for an edited one would load the same code.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileIdentity } from "../file-identity.ts";

export interface LaunchStamp {
	readonly generation: number;
	readonly files: ReadonlyArray<readonly [path: string, identity: string]>;
}

// Moved to lib/ so code outside subagents can use it; its callers here keep this import.
export { fileIdentity };

export function stampOf(generation: number, paths: readonly string[]): LaunchStamp {
	return { generation, files: [...new Set(paths)].map((path) => [path, fileIdentity(path)] as const) };
}

/**
 * Adds files the launch read after its stamp was taken. One that changed
 * since `since`, when the launch began, may have been read before or after
 * the change, so it gets an identity no later look matches: the session is
 * stale at its next pause, never current with old content.
 */
export function withFiles(stamp: LaunchStamp, paths: readonly string[], since: number): LaunchStamp {
	const known = new Set(stamp.files.map(([path]) => path));
	const added = [...new Set(paths)].filter((path) => !known.has(path)).map((path) => {
		const identity = fileIdentity(path);
		return [path, changedSince(path, since) ? `read-during-launch:${identity}` : identity] as const;
	});
	return { ...stamp, files: [...stamp.files, ...added] };
}

/** Whether its content was written at or after `since`; a change of owner or mode is no new content. */
function changedSince(path: string, since: number): boolean {
	try { return statSync(path).mtimeMs >= since; }
	catch { return false; /* absent or unreadable: its identity says so */ }
}

/** Whether a launch by `generation` now would read what `stamp` read. */
export function stampCurrent(stamp: LaunchStamp, generation: number): boolean {
	return stamp.generation === generation && stamp.files.every(([path, identity]) => fileIdentity(path) === identity);
}

/** Each file whose identity changed since `stamp` was taken, as `path@identity` of what is there now. */
export function changedFiles(stamp: LaunchStamp): string[] {
	return stamp.files.flatMap(([path, identity]) => {
		const now = fileIdentity(path);
		return now === identity ? [] : [`${path}@${now}`];
	});
}

/**
 * The files a launch reads before its resources: global and project settings,
 * models, and pi-extras.json, which the child's quota guard and Cache
 * Compaction read. Its `subagents` keys come from the session start instead
 * (serve.ts), since they also shape main's tools and the team.
 */
export function launchFiles(agentDir: string, cwd: string, configDir: string): string[] {
	return [join(agentDir, "settings.json"), join(cwd, configDir, "settings.json"), join(agentDir, "models.json"), join(agentDir, "pi-extras.json")];
}

/** What a child's resource loader reports it read (Pi's `ResourceLoader`). */
export interface ReadResources {
	getAgentsFiles(): { agentsFiles: ReadonlyArray<{ path: string }> };
	getSystemPromptSource(): { path: string } | undefined;
	getAppendSystemPromptSources(): ReadonlyArray<{ path: string }>;
	getSkills(): { skills: ReadonlyArray<{ filePath: string }> };
}

/**
 * The context files, system prompt files and skills the loader used, as it
 * names them. A file added where it would look is not among them; the next
 * /reload makes every session stale, so it reaches children by then. A loader
 * that can't say what it read adds nothing, and its sessions stay current
 * until that /reload, as before stamps.
 */
export function resourceFiles(loader: Partial<ReadResources>): string[] {
	const system = loader.getSystemPromptSource?.();
	return [
		...(loader.getAgentsFiles?.().agentsFiles ?? []).map((file) => file.path),
		...(system ? [system.path] : []),
		...(loader.getAppendSystemPromptSources?.() ?? []).map((source) => source.path),
		...(loader.getSkills?.().skills ?? []).map((skill) => skill.filePath),
	];
}
