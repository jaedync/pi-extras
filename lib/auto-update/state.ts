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
}

export interface UpdateState {
	readonly version: number;
	readonly current?: UpdateSet;
	readonly previous?: UpdateSet;
	/** Store key (or `pi`) -> release id -> why it failed. */
	readonly bad: Readonly<Record<string, Readonly<Record<string, BadMark>>>>;
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
