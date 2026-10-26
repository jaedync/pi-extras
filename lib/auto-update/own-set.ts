/**
 * Which store releases this session really runs. settings.json can change
 * between the moment Pi loads the packages and session_start (a cycle may
 * switch in between), so the folders that Pi loaded code from win: the real
 * path of pi-extras itself and the `sourceInfo.path` of each registered tool
 * and command. Only a package that registers neither (a theme or skill set
 * without commands) falls back to the settings snapshot.
 */
import { join, relative, sep } from "node:path";
import { isInside } from "./paths.ts";
import { classify } from "./sources.ts";
import type { PackageRelease } from "./state.ts";

export interface OwnSetInput {
	readonly storeRoot: string;
	/** Store entries in settings.json at session_start. */
	readonly snapshot: readonly string[];
	/** Real paths of loaded code (files or folders); paths outside the store are ignored. */
	readonly loadedPaths: readonly string[];
	/** Releases of the known sets, to name the entry of a loaded release folder. */
	readonly known: readonly PackageRelease[];
}

/** `packages/<key>/<id>` for a path inside it, with its key. */
function releaseOf(path: string, packagesRoot: string): { key: string; dir: string } | undefined {
	if (!path.startsWith("/") || !isInside(path, packagesRoot)) return undefined;
	const [key, id] = relative(packagesRoot, path).split(sep);
	return key && id ? { key, dir: join(packagesRoot, key, id) } : undefined;
}

const within = (path: string, dir: string): boolean => path === dir || isInside(path, dir);

export function loadedEntries(input: OwnSetInput): string[] {
	const packagesRoot = join(input.storeRoot, "packages");
	const loaded = new Map<string, string>();
	for (const path of input.loadedPaths) {
		const release = releaseOf(path, packagesRoot);
		if (release && !loaded.has(release.key)) loaded.set(release.key, release.dir);
	}
	const entryFor = (dir: string, snapshotEntry?: string): string =>
		input.known.find((release) => release.dir === dir)?.entry ?? (snapshotEntry && within(snapshotEntry, dir) ? snapshotEntry : dir);
	const entries: string[] = [];
	for (const entry of input.snapshot) {
		const classified = classify(entry, input.storeRoot);
		if (classified.kind !== "store") continue;
		const dir = loaded.get(classified.key);
		loaded.delete(classified.key);
		entries.push(dir === undefined ? entry : entryFor(dir, entry));
	}
	// Loaded, but settings.json no longer names that source.
	for (const dir of loaded.values()) entries.push(entryFor(dir));
	return entries;
}
