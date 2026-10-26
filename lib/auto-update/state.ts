/**
 * state.json: the current and previous sets, versions that failed, and what
 * the updater does now. Only the updater writes it, under the updater lock;
 * sessions read it. Each write replaces the file atomically.
 */
import { readJsonObject, writeJsonAtomic } from "../json-file.ts";

export const STATE_VERSION = 1;

export interface PiRelease {
	readonly version: string;
	/** The real folder `pi/<version>` (an npm prefix). */
	readonly dir: string;
	/** The npm package name, when it is not `@earendil-works/pi-coding-agent`. */
	readonly name?: string;
}

export interface PackageRelease {
	/** The settings source the release came from, e.g. `git:github.com/jaedync/pi-extras`. */
	readonly origin: string;
	readonly id: string;
	/** The release folder `packages/<key>/<id>`. */
	readonly dir: string;
	/** The folder settings.json names: the package root inside `dir`. */
	readonly entry: string;
	/** Shown to the user: `pi-extras 0.30.0`. */
	readonly label?: string;
}

export interface UpdateSet {
	readonly pi: PiRelease;
	readonly packages: Readonly<Record<string, PackageRelease>>;
}

export interface BadMark {
	readonly reason: string;
	readonly at: number;
}

/**
 * A release whose test began but gave no verdict: the hard cycle limit (or a
 * crash) ended the process during the test. It is not bad: nothing showed a
 * fault, and a busy machine can cause it. After SUSPECT_TRIES such tries in
 * a row, cycles skip the release for SUSPECT_WAIT_MS, so a test that cannot
 * finish does not use every cycle; then it gets one more try. A verdict (the
 * release passes, or it is marked bad) removes the mark.
 */
export interface SuspectMark {
	readonly at: number;
	readonly tries: number;
}

export const SUSPECT_TRIES = 2;
export const SUSPECT_WAIT_MS = 24 * 60 * 60_000;

/** One managed settings entry as it was before auto-update rewrote it, for `disable`. */
export interface ManagedEntry {
	readonly origin: string;
	readonly original: unknown;
}

export interface EnableRecord {
	readonly at: number;
	/** The launcher path (`~/.local/bin/pi`). */
	readonly launcher: string;
	/** What the launcher path was before: a symlink target, so `disable` can put it back. */
	readonly previousLink: string;
	/** The Pi binary that the launcher falls back to when `pi-current` is missing. */
	readonly fallbackPi: string;
	/** The real path of the agent dir whose settings.json the store serves. Cycles for another agent dir refuse. */
	readonly agentDir?: string;
}

export interface UpdateState {
	readonly version: number;
	readonly current?: UpdateSet;
	readonly previous?: UpdateSet;
	/** Store key (or `pi`) -> release id -> why it failed. */
	readonly bad: Readonly<Record<string, Readonly<Record<string, BadMark>>>>;
	/** Store key (or `pi`) -> release id -> tests that gave no verdict. */
	readonly suspect?: Readonly<Record<string, Readonly<Record<string, SuspectMark>>>>;
	readonly lastCheck?: number;
	readonly lastError?: { readonly at: number; readonly message: string };
	/** What a cycle does now, for the status line. Cleared at the end of the cycle. */
	readonly activity?: { readonly text: string; readonly since: number; readonly pid: number };
	/** Newest release found per store key (and `pi`), for `/pi-extras update`. */
	readonly newest?: Readonly<Record<string, string>>;
	readonly managed: Readonly<Record<string, ManagedEntry>>;
	readonly enabled?: EnableRecord;
	/** Set while the launcher path no longer holds the launcher (something wrote over it). */
	readonly launcherProblem?: { readonly at: number; readonly message: string };
}

export function emptyState(): UpdateState {
	return { version: STATE_VERSION, bad: {}, managed: {} };
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function validPi(value: unknown): boolean {
	return isObject(value) && isString(value.version) && isString(value.dir);
}

function validRelease(value: unknown): boolean {
	return isObject(value) && isString(value.origin) && isString(value.id) && isString(value.dir) && isString(value.entry);
}

export function validSet(value: unknown): value is UpdateSet {
	return isObject(value) && validPi(value.pi) && isObject(value.packages) && Object.values(value.packages).every(validRelease);
}

export class StateError extends Error {}

/** The state in `file`; empty when there is none. Throws when the file is not a state this code wrote. */
export function readState(file: string): UpdateState {
	const raw = readJsonObject(file);
	if (Object.keys(raw).length === 0) return emptyState();
	for (const field of ["current", "previous"] as const) {
		if (raw[field] !== undefined && !validSet(raw[field])) throw new StateError(`${file}: "${field}" is not a valid set. Fix or remove state.json.`);
	}
	if (raw.version !== STATE_VERSION) throw new StateError(`${file}: unknown state version ${String(raw.version)}.`);
	return {
		...(raw as unknown as UpdateState),
		bad: isObject(raw.bad) ? (raw.bad as UpdateState["bad"]) : {},
		managed: isObject(raw.managed) ? (raw.managed as UpdateState["managed"]) : {},
		...(isObject(raw.suspect) ? { suspect: raw.suspect as UpdateState["suspect"] } : {}),
	};
}

export function writeState(file: string, state: UpdateState): void {
	writeJsonAtomic(file, state);
}

/** Reads, changes and writes the state. Call only while holding the updater lock. */
export function updateState(file: string, change: (state: UpdateState) => UpdateState): UpdateState {
	const next = change(readState(file));
	writeState(file, next);
	return next;
}

export function isBad(state: UpdateState, key: string, id: string): boolean {
	return state.bad[key]?.[id] !== undefined;
}

export function markBad(state: UpdateState, key: string, id: string, reason: string, at: number): UpdateState {
	return { ...state, bad: { ...state.bad, [key]: { ...state.bad[key], [id]: { reason, at } } } };
}

/** True while cycles skip this release: it failed its test, or its test gave no verdict too often of late. */
export function isBlocked(state: UpdateState, key: string, id: string, now: number): boolean {
	if (isBad(state, key, id)) return true;
	const mark = state.suspect?.[key]?.[id];
	return mark !== undefined && mark.tries >= SUSPECT_TRIES && now - mark.at < SUSPECT_WAIT_MS;
}

/** Counts one more test of each release that has not given its verdict yet. */
export function markSuspect(state: UpdateState, releases: readonly { key: string; id: string }[], at: number): UpdateState {
	const suspect = { ...state.suspect };
	for (const { key, id } of releases) suspect[key] = { ...suspect[key], [id]: { at, tries: (suspect[key]?.[id]?.tries ?? 0) + 1 } };
	return { ...state, suspect };
}

/** Removes the marks of releases that got a verdict. */
export function clearSuspect(state: UpdateState, releases: readonly { key: string; id: string }[]): UpdateState {
	const suspect: Record<string, Readonly<Record<string, SuspectMark>>> = { ...state.suspect };
	for (const { key, id } of releases) {
		const { [id]: _done, ...rest } = suspect[key] ?? {};
		if (Object.keys(rest).length > 0) suspect[key] = rest;
		else delete suspect[key];
	}
	const { suspect: _old, ...rest } = state;
	return Object.keys(suspect).length > 0 ? { ...rest, suspect } : rest;
}

/** Every release folder a set uses (Pi and packages). */
export function setDirs(set: UpdateSet | undefined): string[] {
	if (!set) return [];
	return [set.pi.dir, ...Object.values(set.packages).map((release) => release.dir)];
}

export function sameSet(a: UpdateSet | undefined, b: UpdateSet | undefined): boolean {
	if (!a || !b) return a === b;
	const keys = (set: UpdateSet) => Object.keys(set.packages).sort();
	return a.pi.dir === b.pi.dir && JSON.stringify(keys(a)) === JSON.stringify(keys(b)) && keys(a).every((key) => a.packages[key]?.dir === b.packages[key]?.dir && a.packages[key]?.entry === b.packages[key]?.entry);
}
