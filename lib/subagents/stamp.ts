/**
 * What a child's launch read, so an open session is reused only while a
 * launch now would make the same one: the module generation that launched it
 * (each /reload evaluates this package again), and the identity of each file
 * its settings, models and extensions came from. A file's identity is its
 * stat, so an edit, a replacement or a removal changes it without a parse.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

export interface LaunchStamp {
	readonly generation: number;
	readonly files: ReadonlyArray<readonly [path: string, identity: string]>;
}

/** Changes when the file is written, replaced or removed. */
export function fileIdentity(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// A file that can't be read now may be readable at the next look; that is a change too.
		return code === "ENOENT" || code === "ENOTDIR" ? "absent" : `unreadable:${code ?? "unknown"}`;
	}
}

export function stampOf(generation: number, paths: readonly string[]): LaunchStamp {
	return { generation, files: [...new Set(paths)].map((path) => [path, fileIdentity(path)] as const) };
}

/** Whether a launch by `generation` now would read what `stamp` read. */
export function stampCurrent(stamp: LaunchStamp, generation: number): boolean {
	return stamp.generation === generation && stamp.files.every(([path, identity]) => fileIdentity(path) === identity);
}

/** The files a child's launch takes its settings and models from, then the extensions that own its tools. */
export function launchFiles(agentDir: string, cwd: string, configDir: string, extensionPaths: readonly string[]): string[] {
	return [join(agentDir, "settings.json"), join(cwd, configDir, "settings.json"), join(agentDir, "models.json"), join(agentDir, "pi-extras.json"), ...extensionPaths];
}
