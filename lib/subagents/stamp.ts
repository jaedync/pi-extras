/**
 * What a child's launch read, so an open session is reused only while a
 * launch now would make the same one: the module generation that launched it
 * (each /reload evaluates this package again), and the identity of each file
 * its settings, models and extensions came from. A file's identity is its
 * stat, so an edit, a replacement or a removal changes it without a parse.
 *
 * Main's model runtime reads models.json only when Pi starts and when /model
 * opens, and children share it for their credentials. A launch refreshes it
 * first when models.json changed since the last refresh, as Pi does when an
 * extension registers a provider: from disk only, one refresh at a time per
 * runtime, and never from a file that does not parse, since a half-saved
 * file would drop main's custom models too.
 */
import { readFileSync, statSync } from "node:fs";
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

interface Refreshable {
	refresh(options: { allowNetwork: boolean }): Promise<unknown>;
}

/** What one runtime last read of models.json, and the refresh under way. */
interface ModelsRead {
	readonly identity?: string;
	readonly warned?: string;
	readonly pending?: Promise<void>;
}

const READS = Symbol.for("pi-extras.subagents.models-read");

/** On globalThis, since a /reload's copy of this module shares main's runtime. */
function reads(): WeakMap<object, ModelsRead> {
	const holder = globalThis as unknown as Record<symbol, WeakMap<object, ModelsRead> | undefined>;
	return holder[READS] ??= new WeakMap();
}

/** Pi's own JSON reading of models.json: a byte order mark, line comments and trailing commas are allowed. */
function parseProblem(path: string): string | undefined {
	let text: string;
	try { text = readFileSync(path, "utf8"); }
	catch (error) {
		// No file is no custom models, which Pi reads the same way.
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : (error as Error).message;
	}
	const stripped = text.replace(/^\uFEFF/, "")
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : ""));
	try {
		const parsed: unknown = JSON.parse(stripped);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? undefined : "it is not a JSON object";
	} catch (error) {
		return (error as Error).message;
	}
}

/** Brings the shared runtime up to models.json before a launch picks its model; a problem is told and the launch goes on. */
export async function freshModels(runtime: object, modelsPath: string, warn: (message: string) => void): Promise<void> {
	if (typeof (runtime as Partial<Refreshable>).refresh !== "function") return;
	const seen = reads();
	// Another launch's refresh may have read the same file; look again once it is done.
	for (let read = seen.get(runtime); read?.pending; read = seen.get(runtime)) await read.pending;
	const before = seen.get(runtime) ?? {};
	const identity = fileIdentity(modelsPath);
	if (identity === before.identity) return;
	const problem = parseProblem(modelsPath);
	if (problem) {
		if (before.warned !== identity) warn(`subagents: ${modelsPath} does not parse (${problem}). Children use the models loaded before; fix the file.`);
		seen.set(runtime, { ...before, warned: identity });
		return;
	}
	const pending = (runtime as Refreshable).refresh({ allowNetwork: false }).then(
		() => { seen.set(runtime, { identity }); },
		(error: unknown) => {
			// Marked as read all the same, so every launch does not warn again until the file changes.
			seen.set(runtime, { identity, warned: identity });
			warn(`subagents: could not read ${modelsPath} into the model runtime: ${(error as Error).message}. Children use the models loaded before.`);
		});
	seen.set(runtime, { ...before, pending });
	await pending;
}
