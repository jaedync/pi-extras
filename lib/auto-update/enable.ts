/**
 * `enable` and `disable`: the only commands that change files outside Pi's
 * agent dir. `enable` builds and tests the first set, records what it
 * replaces, installs the launcher at ~/.local/bin/pi and switches. `disable`
 * puts back the old ~/.local/bin/pi and the original settings entries. Both
 * print exactly what they changed.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { join, sep } from "node:path";
import { waitForLock, type FileLock } from "../file-lock.ts";
import { UnreadableJsonError } from "../json-file.ts";
import { readConfig, writeConfig } from "./config.ts";
import { LOCK_STALE_MS, smokeEntries, switchTo } from "./cycle.ts";
import { INSTALL_TIMEOUT_MS, installPi } from "./install.ts";
import { installLauncher, isLauncher, linkAt, renderLauncher, restoreLink, syncPiMarker } from "./launcher.ts";
import type { Log } from "./log.ts";
import type { StorePaths } from "./paths.ts";
import { PI_NAME, trackedSources, wantedPackage, type LookupDeps } from "./plan.ts";
import { readSettingsPackages, rewriteSettingsPackages, settingsFile } from "./settings.ts";
import type { SmokeInput, SmokeResult } from "./smoke.ts";
import { sanitize, type Runner } from "./run.ts";
import { entrySource, restoreOriginals } from "./sources.ts";
import { emptyState, readState, StateError, updateState, writeState, type EnableRecord, type ManagedEntry, type PackageRelease, type UpdateSet, type UpdateState } from "./state.ts";
import { readUndo, removeUndo, undoFile } from "./undo.ts";
import { newestNpm } from "./versions.ts";

export interface EnableDeps {
	readonly home: string;
	readonly agentDir: string;
	readonly paths: StorePaths;
	readonly runner: Runner;
	readonly smoke: (input: SmokeInput) => Promise<SmokeResult>;
	readonly now: () => number;
	readonly log: Log;
	/** The pi-extras folder whose CLI the launcher runs when the store has none. */
	readonly extrasDir: string;
	readonly node: string;
	readonly platform: NodeJS.Platform;
	readonly out: (line: string) => void;
}

export const launcherPath = (home: string): string => join(home, ".local", "bin", "pi");
/** Short: a cycle that holds the lock longer is told to the user, who runs the command again. */
const LOCK_WAIT_MS = 2_000;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

export class CommandError extends Error {}

/** A settings entry for the terminal: its source only, credentials removed (a git URL can hold a token). */
export function describeEntry(entry: unknown): string {
	const source = entrySource(entry);
	return source === undefined ? "(an entry without a source)" : sanitize(source);
}

interface OldPi {
	readonly link: string;
	readonly real: string;
	readonly name: string;
	readonly version: string;
}

/** The Pi that ~/.local/bin/pi starts now: a symlink into an npm prefix, as `npm install -g` makes it. */
function findOldPi(path: string): OldPi {
	const link = linkAt(path);
	if (link === undefined) {
		const what = existsSync(path) ? "is not a symlink" : "does not exist";
		throw new CommandError(`${path} ${what}. Enable needs ~/.local/bin/pi as the link that "npm install -g" makes for Pi. Nothing changed.`);
	}
	const real = realpathSync(path);
	const marker = `${sep}lib${sep}node_modules${sep}`;
	const at = real.lastIndexOf(marker);
	const rest = at < 0 ? [] : real.slice(at + marker.length).split(sep);
	const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
	const manifest = name ? readManifest(join(real.slice(0, at + marker.length), name, "package.json")) : undefined;
	if (!name || typeof manifest?.version !== "string" || !name.endsWith("pi-coding-agent")) {
		throw new CommandError(`${path} points to ${real}, which is not Pi in an npm prefix. Nothing changed.`);
	}
	return { link, real, name, version: manifest.version };
}

function readManifest(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

async function checkTools(deps: EnableDeps): Promise<void> {
	if (deps.platform !== "linux" && deps.platform !== "darwin") throw new CommandError(`Auto-update runs on Linux and macOS only, not on ${deps.platform}. Nothing changed.`);
	for (const tool of ["npm", "git"]) {
		const result = await deps.runner(tool, ["--version"], { timeoutMs: 30_000 });
		if (result.code !== 0) throw new CommandError(`Auto-update needs ${tool}, and "${tool} --version" failed. Install ${tool}, then try again. Nothing changed.`);
	}
}

function takeLock(paths: StorePaths): FileLock {
	try {
		return waitForLock(paths.lock, LOCK_WAIT_MS, { staleMs: LOCK_STALE_MS });
	} catch {
		throw new CommandError("An update cycle runs now. Try again in a few minutes. Nothing changed.");
	}
}

/** Builds the first set from the newest releases. Any failure stops `enable`: nothing is switched yet. */
async function firstSet(deps: EnableDeps, old: OldPi, packages: readonly unknown[]): Promise<UpdateSet> {
	const config = { ...readConfig(deps.agentDir), enabled: true };
	const lookup: LookupDeps = { paths: deps.paths, runner: deps.runner, now: deps.now, config, install: { runner: deps.runner, now: deps.now, timeoutMs: INSTALL_TIMEOUT_MS } };
	const seed = emptyState();
	// With `pi: "skip"`, or when no release is old enough, the first set keeps the Pi version that runs now.
	const newest = config.pi === "skip" ? undefined : await newestNpm(old.name, deps.runner, { minAgeHours: config.minReleaseAgeHours, now: deps.now() });
	const version = newest ?? old.version;
	deps.out(`Installing Pi ${version} into ${deps.paths.root}.`);
	const piRelease = await installPi(deps.paths, old.name, version, lookup.install);
	const releases: Record<string, PackageRelease> = {};
	for (const tracked of trackedSources(packages, seed, config, deps.paths.root)) {
		// The user told the updater to leave this source alone: its entry stays as written.
		if (tracked.mode === "skip") continue;
		const wanted = await wantedPackage(tracked, seed, lookup);
		if (!wanted) continue;
		deps.out(`Installing ${wanted.label}.`);
		releases[tracked.key] = await wanted.install();
	}
	return { pi: { ...piRelease, name: old.name === PI_NAME ? undefined : old.name }, packages: releases };
}

export async function enable(deps: EnableDeps): Promise<void> {
	await checkTools(deps);
	const launcher = launcherPath(deps.home);
	const state = readState(deps.paths.state);
	if (isLauncher(launcher) && state.enabled) {
		deps.out(`Auto-update is already on. The launcher is at ${launcher}. Nothing changed.`);
		return;
	}
	const old = findOldPi(launcher);
	const lock = takeLock(deps.paths);
	try {
		const settings = settingsFile(deps.agentDir);
		const packages = readSettingsPackages(settings);
		const set = await firstSet(deps, old, packages);
		deps.out(`Testing Pi ${set.pi.version} with ${plural(Object.keys(set.packages).length, "package")}.`);
		const smoke = await deps.smoke({ piDir: set.pi.dir, packages: smokeEntries(packages, set, deps.paths.root) });
		if (!smoke.ok) throw new CommandError(`The test of the new versions failed: ${smoke.reason}. Nothing was switched. The store at ${deps.paths.root} has the new folders; "gc" removes them.`);
		writeState(deps.paths.state, { ...state, lastCheck: deps.now(), enabled: { at: deps.now(), launcher, previousLink: old.link, fallbackPi: old.real, agentDir: realpathSync(deps.agentDir) } });
		switchTo(deps, set, packages);
		const after = readSettingsPackages(settings);
		installLauncher(launcher, renderLauncher({ store: deps.paths.root, fallbackPi: old.real, fallbackExtras: deps.extrasDir, node: deps.node }));
		writeConfig(deps.agentDir, { enabled: true });
		syncPiMarker(deps.paths, readConfig(deps.agentDir));
		deps.log(`enabled: Pi ${set.pi.version}, ${plural(Object.keys(set.packages).length, "package")}`);
		deps.out(`Changed ${launcher}: it was a link to ${old.link}. It is now the pi-extras launcher.`);
		packages.forEach((entry, index) => {
			if (JSON.stringify(entry) !== JSON.stringify(after[index])) deps.out(`Changed ${settings}: ${describeEntry(entry)} -> ${describeEntry(after[index])}`);
		});
		deps.out(`Changed ${join(deps.agentDir, "pi-extras.json")}: autoUpdate.enabled is true.`);
		deps.out(`Pi ${set.pi.version} runs from ${join(deps.paths.root, "pi-current")}. Start a new Pi session to use it.`);
	} finally {
		lock.release();
	}
}

/** What disable undoes: from state.json, or from the copy in the agent dir when the store is gone or broken. */
function undoSource(deps: Pick<EnableDeps, "agentDir" | "paths">): { enabled: EnableRecord; managed: Readonly<Record<string, ManagedEntry>>; storeRoot: string; fromCopy: boolean } | undefined {
	let state: UpdateState | undefined;
	try {
		state = readState(deps.paths.state);
	} catch {
		// A state.json this code cannot read: the copy decides.
		state = undefined;
	}
	const copy = readUndo(deps.agentDir);
	if (state?.enabled) return { enabled: state.enabled, managed: { ...copy?.managed, ...state.managed }, storeRoot: deps.paths.root, fromCopy: false };
	if (copy) return { enabled: copy.enabled, managed: copy.managed, storeRoot: copy.storeRoot, fromCopy: true };
	return undefined;
}

/**
 * Drops the enable record from state.json. A state.json this code cannot
 * read moves aside (`state.json.corrupt-<time>`), and an empty state takes
 * its place: disable has done its work from the copy by then, and must end.
 */
function clearEnableState(paths: StorePaths, now: number): void {
	try {
		updateState(paths.state, (current) => ({ ...current, enabled: undefined, current: undefined, previous: undefined, managed: {} }));
	} catch (error) {
		if (!(error instanceof StateError) && !(error instanceof UnreadableJsonError)) throw error;
		renameSync(paths.state, `${paths.state}.corrupt-${now}`);
		writeState(paths.state, emptyState());
	}
}

export async function disable(deps: Pick<EnableDeps, "home" | "agentDir" | "paths" | "now" | "log" | "out">): Promise<void> {
	const source = undoSource(deps);
	if (!source) {
		deps.out("Auto-update is not on. Nothing changed.");
		return;
	}
	const lock = takeLock(deps.paths);
	try {
		if (source.fromCopy) deps.out(`The store has no record of enable, so disable uses the copy in ${undoFile(deps.agentDir)}.`);
		const { launcher, previousLink } = source.enabled;
		if (isLauncher(launcher)) {
			restoreLink(launcher, previousLink);
			deps.out(`Changed ${launcher}: it is a link to ${previousLink} again.`);
		} else {
			deps.out(`${launcher} is not the pi-extras launcher now, so it stays as it is.`);
		}
		const settings = settingsFile(deps.agentDir);
		const change = rewriteSettingsPackages(settings, (packages) => restoreOriginals(packages, source.managed, source.storeRoot));
		change.before.forEach((entry, index) => {
			if (JSON.stringify(entry) !== JSON.stringify(change.after[index])) deps.out(`Changed ${settings}: ${describeEntry(entry)} -> ${describeEntry(change.after[index])}`);
		});
		writeConfig(deps.agentDir, { enabled: false });
		syncPiMarker(deps.paths, { enabled: false, pi: "skip" });
		deps.out(`Changed ${join(deps.agentDir, "pi-extras.json")}: autoUpdate.enabled is false.`);
		// Running sessions may still load from the store, so it stays; "gc" removes what no live session uses.
		clearEnableState(deps.paths, deps.now());
		removeUndo(deps.agentDir);
		deps.log("disabled");
		deps.out(`The store at ${deps.paths.root} stays while Pi sessions use it. Run "gc" later to remove what no session uses.`);
		deps.out("Pi installs the original packages again at its next start.");
	} finally {
		lock.release();
	}
}

/** True when a store path exists as a real folder: for `status`. */
export function storeExists(paths: StorePaths): boolean {
	try {
		return lstatSync(paths.root).isDirectory();
	} catch {
		return false;
	}
}
