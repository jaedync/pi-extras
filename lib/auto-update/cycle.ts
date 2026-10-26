/**
 * One update cycle: look up the newest releases, install what is missing,
 * smoke-test the candidate set, switch, collect garbage. One cycle at a time
 * per machine (the updater lock), and at most one per interval however many
 * sessions ask (the `lastCheck` throttle, checked again under the lock).
 */
import { join } from "node:path";
import { tryLock } from "../file-lock.ts";
import { isOffline } from "../offline.ts";
import type { AutoUpdateConfig } from "./config.ts";
import { collectGarbage, mappedPaths } from "./gc.ts";
import { INSTALL_TIMEOUT_MS } from "./install.ts";
import { isLauncher, syncPiMarker } from "./launcher.ts";
import { readLiveLeases } from "./leases.ts";
import type { Log } from "./log.ts";
import { EXTRAS_DIR, type StorePaths } from "./paths.ts";
import { PI_KEY, trackedSources, wantedPackage, wantedPi, type LookupDeps, type Tracked, type Wanted } from "./plan.ts";
import type { Runner } from "./run.ts";
import { readSettingsPackages, settingsFile } from "./settings.ts";
import { applySet, entryKey } from "./sources.ts";
import { markBad, readState, sameSet, updateState, type PackageRelease, type PiRelease, type UpdateSet, type UpdateState } from "./state.ts";
import { applySwitch, piCurrentMatches, settingsMatch } from "./switch.ts";
import type { SmokeInput, SmokeResult } from "./smoke.ts";

export const CYCLE_LIMIT_MS = 10 * 60_000;
/** Past this, a lock whose holder still lives is taken over: that cycle is stuck far beyond its limit. */
export const LOCK_STALE_MS = 2 * CYCLE_LIMIT_MS;

export interface CycleDeps {
	readonly paths: StorePaths;
	readonly agentDir: string;
	readonly config: AutoUpdateConfig;
	readonly runner: Runner;
	readonly smoke: (input: SmokeInput) => Promise<SmokeResult>;
	readonly now: () => number;
	readonly log: Log;
	readonly env?: NodeJS.ProcessEnv;
	readonly limitMs?: number;
}

export type CycleOutcome = "disabled" | "paused" | "offline" | "throttled" | "locked" | "no-change" | "switched" | "smoke-failed" | "error";

export interface CycleResult {
	readonly outcome: CycleOutcome;
	readonly message: string;
}

/** Why a cycle must not run now, or undefined. */
function gate(deps: CycleDeps, state: UpdateState, force: boolean): CycleResult | undefined {
	if (!deps.config.enabled || !state.current) return { outcome: "disabled", message: "Auto-update is off. Run the enable command first." };
	if (isOffline(deps.env ?? process.env)) return { outcome: "offline", message: "PI_OFFLINE is set: no check." };
	if (deps.config.paused && !force) return { outcome: "paused", message: "Auto-update is paused." };
	const interval = deps.config.intervalMinutes * 60_000;
	if (!force && state.lastCheck !== undefined && deps.now() - state.lastCheck < interval) return { outcome: "throttled", message: "Checked recently." };
	return undefined;
}

export async function runCycle(deps: CycleDeps, options: { force?: boolean } = {}): Promise<CycleResult> {
	const force = options.force === true;
	try {
		syncPiMarker(deps.paths, deps.config);
	} catch (error) {
		// Only Pi's own banner depends on it; the cycle goes on.
		deps.log(`could not update pi-managed: ${(error as Error).message}`);
	}
	const early = gate(deps, readState(deps.paths.state), force);
	if (early) return early;
	const lock = tryLock(deps.paths.lock, { staleMs: LOCK_STALE_MS });
	if (!lock) return { outcome: "locked", message: "Another update cycle runs now." };
	try {
		const state = readState(deps.paths.state);
		// Another session's cycle may have finished between the first look and the lock.
		const again = gate(deps, state, force);
		if (again) return again;
		return await lockedCycle(deps, state);
	} catch (error) {
		const message = (error as Error).message;
		deps.log(`cycle failed: ${message}`);
		safeUpdate(deps, (state) => ({ ...state, lastError: { at: deps.now(), message } }));
		return { outcome: "error", message };
	} finally {
		safeUpdate(deps, (state) => (state.activity ? { ...state, activity: undefined } : state));
		lock.release();
	}
}

function safeUpdate(deps: CycleDeps, change: (state: UpdateState) => UpdateState): void {
	try {
		updateState(deps.paths.state, change);
	} catch (error) {
		deps.log(`could not update state.json: ${(error as Error).message}`);
	}
}

function setActivity(deps: CycleDeps, text: string): void {
	updateState(deps.paths.state, (state) => ({ ...state, activity: { text, since: deps.now(), pid: process.pid } }));
}

/** Fixes a crash between switch steps: pi-current and settings must match `state.current`. */
export function repair(deps: Pick<CycleDeps, "paths" | "agentDir" | "log">, state: UpdateState): boolean {
	if (!state.current) return false;
	const packages = readSettingsPackages(settingsFile(deps.agentDir));
	if (piCurrentMatches(deps.paths, state.current) && settingsMatch(packages, state.current, deps.paths.root)) return false;
	const result = applySwitch(deps.paths, settingsFile(deps.agentDir), state.current);
	deps.log(`repaired the switch (link ${result.linkChanged ? "fixed" : "ok"}, settings ${result.settingsChanged ? "fixed" : "ok"})`);
	return true;
}

/**
 * What to tell the user when the launcher that enable installed is gone (for
 * example "npm install -g" of Pi wrote over it). The cycle does not put it
 * back: the file is outside the store, and the user changed it.
 */
export function launcherProblem(state: UpdateState): string | undefined {
	const launcher = state.enabled?.launcher;
	if (!launcher || isLauncher(launcher)) return undefined;
	return `${launcher} is no longer the pi-extras launcher (for example, "npm install -g" of Pi wrote over it). New Pi sessions do not start from the store. Run "node ${join(EXTRAS_DIR, "lib", "auto-update", "cli.ts")} enable" again to put it back, or "disable" to turn auto-update off.`;
}

function recordLauncher(deps: CycleDeps, state: UpdateState): string | undefined {
	const problem = launcherProblem(state);
	if (problem === state.launcherProblem?.message) return problem;
	if (problem) deps.log(`launcher problem: ${problem}`);
	updateState(deps.paths.state, (now) => ({ ...now, launcherProblem: problem ? { at: deps.now(), message: problem } : undefined }));
	return problem;
}

interface Lookup {
	readonly pi: Wanted<PiRelease> | undefined;
	readonly packages: Wanted<PackageRelease>[];
	readonly errors: string[];
}

async function lookUp(deps: CycleDeps, state: UpdateState, tracked: readonly Tracked[], lookup: LookupDeps): Promise<Lookup> {
	const errors: string[] = [];
	const guard = async <T>(what: string, fallback: T | undefined, work: () => Promise<T | undefined>): Promise<T | undefined> => {
		try {
			return await work();
		} catch (error) {
			errors.push(`${what}: ${(error as Error).message}`);
			return fallback;
		}
	};
	const currentPi = state.current?.pi;
	const pi = await guard("Pi", currentPi && { key: PI_KEY, id: currentPi.version, label: `Pi ${currentPi.version}`, current: currentPi, install: async () => currentPi }, () => wantedPi(state, lookup));
	const packages: Wanted<PackageRelease>[] = [];
	for (const source of tracked) {
		const current = state.current?.packages[source.key];
		const fallback = current && { key: source.key, id: current.id, label: current.label ?? current.id, current, install: async () => current };
		const wanted = await guard(source.origin.label, fallback, () => wantedPackage(source, state, lookup));
		if (wanted) packages.push(wanted);
	}
	for (const error of errors) deps.log(`lookup failed: ${error}`);
	return { pi, packages, errors };
}

/** Installs what the candidate needs. A failed install keeps that source at its current release. */
async function installAll(deps: CycleDeps, found: Lookup, deadline: number): Promise<{ set: UpdateSet | undefined; errors: string[] }> {
	const errors: string[] = [];
	const get = async <T>(wanted: Wanted<T>): Promise<T | undefined> => {
		if (wanted.current) return wanted.current;
		if (deps.now() > deadline) {
			errors.push(`${wanted.label}: no time left in this cycle`);
			return undefined;
		}
		setActivity(deps, `installing ${wanted.label}`);
		deps.log(`installing ${wanted.label}`);
		try {
			return await wanted.install();
		} catch (error) {
			errors.push(`${wanted.label}: ${(error as Error).message}`);
			deps.log(`install failed: ${wanted.label}: ${(error as Error).message}`);
			return undefined;
		}
	};
	const pi = found.pi ? ((await get(found.pi)) ?? found.pi.current) : undefined;
	if (!pi) return { set: undefined, errors: [...errors, "no Pi release to use"] };
	const packages: Record<string, PackageRelease> = {};
	for (const wanted of found.packages) {
		const release = (await get(wanted)) ?? wanted.current;
		if (release) packages[wanted.key] = release;
	}
	return { set: { pi, packages }, errors };
}

/** The managed entries of settings, rewritten for `set`: what a session on that set loads. */
export function smokeEntries(packages: readonly unknown[], set: UpdateSet, storeRoot: string): unknown[] {
	const inSet = packages.filter((entry) => {
		const key = entryKey(entry, storeRoot);
		return key !== undefined && set.packages[key] !== undefined;
	});
	return applySet(inSet, set, storeRoot);
}

/** The keys (and `pi`) whose release differs between two sets. */
export function changedKeys(from: UpdateSet, to: UpdateSet): string[] {
	const keys = new Set([...Object.keys(from.packages), ...Object.keys(to.packages)]);
	const changed = [...keys].filter((key) => from.packages[key]?.dir !== to.packages[key]?.dir);
	return from.pi.dir === to.pi.dir ? changed : [PI_KEY, ...changed];
}

/** `base` with only `key` taken from `candidate`. */
function withOne(base: UpdateSet, candidate: UpdateSet, key: string): UpdateSet {
	if (key === PI_KEY) return { ...base, pi: candidate.pi };
	const packages = { ...base.packages };
	const release = candidate.packages[key];
	if (release) packages[key] = release;
	else delete packages[key];
	return { ...base, packages };
}

function idOf(set: UpdateSet, key: string): string | undefined {
	return key === PI_KEY ? set.pi.version : set.packages[key]?.id;
}

function labelOf(set: UpdateSet, key: string): string {
	return key === PI_KEY ? `Pi ${set.pi.version}` : (set.packages[key]?.label ?? key);
}

/** Finds which changes broke the candidate: one change is the culprit; several are tried alone against the current set. */
async function findCulprits(deps: CycleDeps, current: UpdateSet, candidate: UpdateSet, packages: readonly unknown[], deadline: number): Promise<{ key: string; reason: string }[]> {
	const changes = changedKeys(current, candidate).filter((key) => idOf(candidate, key) !== undefined);
	if (changes.length <= 1) return changes.map((key) => ({ key, reason: "the smoke test failed" }));
	const culprits: { key: string; reason: string }[] = [];
	for (const key of changes) {
		if (deps.now() > deadline) break;
		setActivity(deps, `testing ${labelOf(candidate, key)} alone`);
		const alone = withOne(current, candidate, key);
		const result = await deps.smoke({ piDir: alone.pi.dir, packages: smokeEntries(packages, alone, deps.paths.root) });
		if (!result.ok) culprits.push({ key, reason: result.reason });
	}
	// Each change passed alone, so only the combination fails: mark them all, the next releases decide.
	return culprits.length > 0 ? culprits : changes.map((key) => ({ key, reason: "failed only together with other updates" }));
}

async function lockedCycle(deps: CycleDeps, initial: UpdateState): Promise<CycleResult> {
	const deadline = deps.now() + (deps.limitMs ?? CYCLE_LIMIT_MS);
	repair(deps, initial);
	const problem = recordLauncher(deps, initial);
	const packages = readSettingsPackages(settingsFile(deps.agentDir));
	const tracked = trackedSources(packages, initial, deps.config, deps.paths.root);
	setActivity(deps, "checking for updates");
	const lookup: LookupDeps = { paths: deps.paths, runner: deps.runner, now: deps.now, config: deps.config, install: { runner: deps.runner, now: deps.now, timeoutMs: INSTALL_TIMEOUT_MS } };
	const found = await lookUp(deps, initial, tracked, lookup);
	const newest = Object.fromEntries([...(found.pi ? [[PI_KEY, found.pi.id]] : []), ...found.packages.map((wanted) => [wanted.key, wanted.id])]);
	let state = updateState(deps.paths.state, (current) => ({ ...current, lastCheck: deps.now(), newest }));
	const current = state.current!;
	const installed = await installAll(deps, found, deadline);
	const errors = [...(problem ? [problem] : []), ...found.errors, ...installed.errors];
	const candidate = installed.set;
	if (!candidate || sameSet(candidate, current)) {
		finish(deps, errors);
		collect(deps);
		return { outcome: errors.length > 0 ? "error" : "no-change", message: errors[0] ?? "Everything is up to date." };
	}
	const labels = changedKeys(current, candidate).filter((key) => idOf(candidate, key)).map((key) => labelOf(candidate, key));
	setActivity(deps, `testing ${labels.join(", ")}`);
	const smoke = await deps.smoke({ piDir: candidate.pi.dir, packages: smokeEntries(packages, candidate, deps.paths.root) });
	if (!smoke.ok) {
		deps.log(`smoke test failed for ${labels.join(", ")}: ${smoke.reason}`);
		const culprits = await findCulprits(deps, current, candidate, packages, deadline);
		state = updateState(deps.paths.state, (now) => culprits.reduce((next, culprit) => markBad(next, culprit.key, idOf(candidate, culprit.key)!, culprit.reason, deps.now()), now));
		const message = `The update to ${labels.join(", ")} failed its test: ${smoke.reason}. The current versions stay.`;
		updateState(deps.paths.state, (now) => ({ ...now, lastError: { at: deps.now(), message } }));
		for (const culprit of culprits) deps.log(`marked bad: ${labelOf(candidate, culprit.key)} (${culprit.reason})`);
		return { outcome: "smoke-failed", message };
	}
	switchTo(deps, candidate, packages);
	deps.log(`switched to ${labels.join(", ")}`);
	finish(deps, errors);
	collect(deps);
	return { outcome: "switched", message: `Updated: ${labels.join(", ")}.` };
}

/** Records the new current set (with the original of each newly managed entry, for `disable`), then flips the link and settings. */
export function switchTo(deps: Pick<CycleDeps, "paths" | "agentDir" | "now">, candidate: UpdateSet, packages: readonly unknown[]): void {
	updateState(deps.paths.state, (state) => {
		const managed = { ...state.managed };
		for (const entry of packages) {
			const key = entryKey(entry, deps.paths.root);
			const release = key === undefined ? undefined : candidate.packages[key];
			if (key !== undefined && release && !managed[key]) managed[key] = { origin: release.origin, original: entry };
		}
		return { ...state, previous: state.current, current: candidate, managed };
	});
	applySwitch(deps.paths, settingsFile(deps.agentDir), candidate);
}

function finish(deps: CycleDeps, errors: readonly string[]): void {
	updateState(deps.paths.state, (state) => {
		if (errors.length === 0) return state.lastError ? { ...state, lastError: undefined } : state;
		return { ...state, lastError: { at: deps.now(), message: errors.join("; ").slice(0, 500) } };
	});
}

/** GC never fails a cycle: what it could not remove now, it tries again next time. */
export function collect(deps: Pick<CycleDeps, "paths" | "now" | "log">): void {
	try {
		const result = collectGarbage({ paths: deps.paths, state: readState(deps.paths.state), leases: readLiveLeases(deps.paths), now: deps.now(), mapped: mappedPaths });
		for (const dir of result.removed) deps.log(`removed ${dir}`);
		for (const failure of result.failed) deps.log(`could not remove ${failure.dir}: ${failure.reason}`);
	} catch (error) {
		deps.log(`gc failed: ${(error as Error).message}`);
	}
}
