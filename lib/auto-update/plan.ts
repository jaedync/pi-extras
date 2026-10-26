/**
 * What a cycle wants: the newest usable release of Pi and of each managed
 * source, compared with the current set. Lookups that fail keep the current
 * release of that source, so one unreachable host does not stop the rest.
 */
import type { AutoUpdateConfig, SourceMode } from "./config.ts";
import { installGitRelease, installNpmRelease, installPi, type InstallDeps } from "./install.ts";
import type { StorePaths } from "./paths.ts";
import type { Runner } from "./run.ts";
import { classify, entryKey, entrySource, type Origin } from "./sources.ts";
import { isBlocked, type PackageRelease, type PiRelease, type UpdateState } from "./state.ts";
import { newestGit, newestNpm, npmMinAgeHours } from "./versions.ts";

export const PI_KEY = "pi";
export const PI_NAME = "@earendil-works/pi-coding-agent";

export interface Tracked {
	readonly key: string;
	readonly origin: Origin;
	readonly mode: SourceMode;
	/** The settings entry as it is now. */
	readonly entry: unknown;
}

function originOf(source: string, storeRoot: string): Origin | undefined {
	const classified = classify(source, storeRoot);
	return classified.kind === "managed" ? classified.origin : undefined;
}

/** The managed sources in settings.json, each once, with the mode the config gives it. */
export function trackedSources(packages: readonly unknown[], state: UpdateState, config: AutoUpdateConfig, storeRoot: string): Tracked[] {
	const seen = new Set<string>();
	const tracked: Tracked[] = [];
	for (const entry of packages) {
		const key = entryKey(entry, storeRoot);
		if (key === undefined || seen.has(key)) continue;
		const source = entrySource(entry) ?? "";
		const classified = classify(source, storeRoot);
		const recorded = state.current?.packages[key]?.origin ?? state.managed[key]?.origin;
		const origin = classified.kind === "managed" ? classified.origin : recorded ? originOf(recorded, storeRoot) : undefined;
		if (!origin) continue;
		seen.add(key);
		tracked.push({ key, origin, entry, mode: config.sources[origin.source] ?? config.sources[key] ?? "tags" });
	}
	return tracked;
}

/** One release a cycle wants: already installed (the current one), or to install. */
export interface Wanted<T> {
	readonly key: string;
	readonly id: string;
	readonly label: string;
	readonly current?: T;
	readonly install: () => Promise<T>;
}

export interface LookupDeps {
	readonly paths: StorePaths;
	readonly runner: Runner;
	readonly now: () => number;
	readonly config: AutoUpdateConfig;
	readonly install: InstallDeps;
	/** npm's min-release-age in hours; the cycle reads it once. */
	readonly npmMinAgeHours?: () => Promise<number>;
}

const keep = <T>(key: string, id: string, label: string, release: T): Wanted<T> => ({ key, id, label, current: release, install: async () => release });

/** The release a source should be at, or undefined to leave it out (skipped, or nothing usable). */
export async function wantedPackage(tracked: Tracked, state: UpdateState, deps: LookupDeps): Promise<Wanted<PackageRelease> | undefined> {
	const current = state.current?.packages[tracked.key];
	const kept = current ? keep(tracked.key, current.id, current.label ?? current.id, current) : undefined;
	if (tracked.mode === "skip") return kept;
	const { origin } = tracked;
	if (origin.kind === "npm") {
		// The install keeps npm's own age rule (unlike Pi's), so the version must pass it too.
		const npmAge = await (deps.npmMinAgeHours ?? (() => npmMinAgeHours(deps.runner)))();
		const version = await newestNpm(origin.name, deps.runner, { minAgeHours: Math.max(deps.config.minReleaseAgeHours, npmAge), now: deps.now() });
		if (version === undefined || version === current?.id || isBlocked(state, tracked.key, version, deps.now())) return kept;
		return { key: tracked.key, id: version, label: `${origin.label} ${version}`, install: () => installNpmRelease(deps.paths, origin, version, deps.install) };
	}
	const release = await newestGit(origin.url, tracked.mode, deps.runner, { prereleases: deps.config.prereleases });
	if (release.id === current?.id || isBlocked(state, tracked.key, release.id, deps.now())) return kept;
	const shown = release.version ?? release.commit.slice(0, 7);
	return { key: tracked.key, id: release.id, label: `${origin.label} ${shown}`, install: () => installGitRelease(deps.paths, origin, release, deps.install) };
}

export async function wantedPi(state: UpdateState, deps: LookupDeps): Promise<Wanted<PiRelease> | undefined> {
	const current = state.current?.pi;
	const name = current?.name ?? PI_NAME;
	const kept = current ? keep(PI_KEY, current.version, `Pi ${current.version}`, current) : undefined;
	if (deps.config.pi === "skip") return kept;
	// Not npm's min-release-age: installPi turns it off, as `pi update` does.
	const version = await newestNpm(name, deps.runner, { minAgeHours: deps.config.minReleaseAgeHours, now: deps.now() });
	if (version === undefined || version === current?.version || isBlocked(state, PI_KEY, version, deps.now())) return kept;
	return {
		key: PI_KEY, id: version, label: `Pi ${version}`,
		install: async () => ({ ...(await installPi(deps.paths, name, version, deps.install)), name }),
	};
}
