/**
 * The culprit search: which changes of a candidate set broke its smoke
 * test. Each test goes through verdictOf, which starts a test only when a
 * whole one fits before the cycle's deadline. cycle.ts applies the result
 * (bad marks, suspect marks, the switch).
 */
import { PI_KEY } from "./plan.ts";
import { SMOKE_RESERVE_MS, type SmokeInput, type SmokeResult } from "./smoke.ts";
import { applySet, entryKey } from "./sources.ts";
import type { UpdateSet } from "./state.ts";
import type { StorePaths } from "./paths.ts";

export interface SearchDeps {
	readonly paths: StorePaths;
	readonly smoke: (input: SmokeInput) => Promise<SmokeResult>;
	readonly now: () => number;
	/** Shows what runs now (the status activity). */
	readonly activity: (text: string) => void;
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
export function withOne(base: UpdateSet, candidate: UpdateSet, key: string): UpdateSet {
	if (key === PI_KEY) return { ...base, pi: candidate.pi };
	const packages = { ...base.packages };
	const release = candidate.packages[key];
	if (release) packages[key] = release;
	else delete packages[key];
	return { ...base, packages };
}

export function idOf(set: UpdateSet, key: string): string | undefined {
	return key === PI_KEY ? set.pi.version : set.packages[key]?.id;
}

export function labelOf(set: UpdateSet, key: string): string {
	return key === PI_KEY ? `Pi ${set.pi.version}` : (set.packages[key]?.label ?? key);
}

/** A test's answer for one set: "none" when it gave no verdict (a timeout, Pi did not start) or no time was left. */
export type Verdict = { readonly kind: "pass" } | { readonly kind: "fail"; readonly reason: string } | { readonly kind: "none"; readonly reason: string };

/** Tests `set` when a whole test fits before the deadline. */
export async function verdictOf(deps: SearchDeps, set: UpdateSet, packages: readonly unknown[], deadline: number, activity: string): Promise<Verdict> {
	if (deps.now() + SMOKE_RESERVE_MS > deadline) return { kind: "none", reason: "no time left in this check" };
	deps.activity(activity);
	const result = await deps.smoke({ piDir: set.pi.dir, packages: smokeEntries(packages, set, deps.paths.root) });
	if (result.ok) return { kind: "pass" };
	return result.inconclusive ? { kind: "none", reason: result.reason } : { kind: "fail", reason: result.reason };
}

/** `base` with each of `keys` taken from `candidate`. */
function withAll(base: UpdateSet, candidate: UpdateSet, keys: readonly string[]): UpdateSet {
	return keys.reduce((set, key) => withOne(set, candidate, key), base);
}

export interface Search {
	/** Changes to mark bad. */
	readonly culprits: readonly { key: string; reason: string }[];
	/** Changes with a verdict that is not bad: their suspect marks go. */
	readonly cleared: readonly string[];
	/** A set that passed its test, to switch to now. */
	readonly passing?: UpdateSet;
	/** False when a test gave no verdict or the time ran out: the changes left keep their suspect marks. */
	readonly complete: boolean;
}

/**
 * Finds which changes broke a candidate that failed its test (a real
 * failure, not a timeout). A test that gives no verdict stops the search
 * and marks nothing more.
 *
 * 1. Each change alone on the current set.
 * 2. Each passed alone: the combination once more. It passes (the first
 *    failure was not repeatable) or all are bad together.
 * 3. Leave one out: a change whose removal makes the candidate pass is
 *    the culprit, also when the other changes need each other (a Pi and a
 *    package that needs that Pi).
 * 4. No single removal helps: start from the changes that passed alone and
 *    add each failed change back; the ones that make that set fail are bad.
 */
export async function findCulprits(deps: SearchDeps, current: UpdateSet, candidate: UpdateSet, packages: readonly unknown[], deadline: number, firstReason: string): Promise<Search> {
	// Sources that the candidate drops are dropped in every set tried here.
	const base: UpdateSet = { ...current, packages: Object.fromEntries(Object.entries(current.packages).filter(([key]) => candidate.packages[key])) };
	const changes = changedKeys(base, candidate).filter((key) => idOf(candidate, key) !== undefined);
	if (changes.length <= 1) return { culprits: changes.map((key) => ({ key, reason: firstReason })), cleared: [], complete: true };
	const stopped = (cleared: readonly string[], passing?: UpdateSet): Search => ({ culprits: [], cleared, passing, complete: false });
	const passed: string[] = [];
	const failed: { key: string; reason: string }[] = [];
	for (const key of changes) {
		const alone = await verdictOf(deps, withOne(base, candidate, key), packages, deadline, `testing ${labelOf(candidate, key)} alone`);
		if (alone.kind === "none") return stopped(passed);
		if (alone.kind === "pass") passed.push(key);
		else failed.push({ key, reason: alone.reason });
	}
	if (failed.length === 0) {
		const again = await verdictOf(deps, candidate, packages, deadline, "testing all updates together again");
		if (again.kind === "none") return stopped(passed);
		if (again.kind === "pass") return { culprits: [], cleared: changes, passing: candidate, complete: true };
		return { culprits: changes.map((key) => ({ key, reason: "failed only together with other updates" })), cleared: [], complete: true };
	}
	for (const culprit of failed) {
		const without = withOne(candidate, base, culprit.key);
		const result = await verdictOf(deps, without, packages, deadline, `testing the updates without ${labelOf(candidate, culprit.key)}`);
		if (result.kind === "none") return stopped(passed);
		if (result.kind === "pass") return { culprits: [culprit], cleared: changes.filter((key) => key !== culprit.key), passing: without, complete: true };
	}
	let set = withAll(base, candidate, passed);
	if (passed.length > 1) {
		const start = await verdictOf(deps, set, packages, deadline, "testing the updates that passed alone");
		if (start.kind === "none") return stopped(passed);
		// They pass alone but not together, and the rest fail alone: only the failures alone are sure.
		if (start.kind === "fail") return { culprits: failed, cleared: [], complete: true };
	}
	const accepted = [...passed];
	const culprits: { key: string; reason: string }[] = [];
	for (const candidateFailure of failed) {
		const next = withOne(set, candidate, candidateFailure.key);
		const result = await verdictOf(deps, next, packages, deadline, `testing ${labelOf(candidate, candidateFailure.key)} with the updates that work`);
		if (result.kind === "none") return { culprits, cleared: accepted, passing: accepted.length > 0 ? set : undefined, complete: false };
		if (result.kind === "pass") {
			set = next;
			accepted.push(candidateFailure.key);
		} else culprits.push({ key: candidateFailure.key, reason: result.reason });
	}
	return { culprits, cleared: accepted, passing: accepted.length > 0 ? set : undefined, complete: true };
}
