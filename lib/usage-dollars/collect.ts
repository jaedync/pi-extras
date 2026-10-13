/**
 * Gathers what the usage tool needs for dollar figures. Remote answers are
 * cached for a minute, because agents call the tool before each piece of
 * work and Tokenfold's numbers move on a two-minute poll. Each source fails
 * open into a note: a report without dollars beats no report.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withFileLock } from "../file-lock.ts";
import { isOffline } from "../offline.ts";
import type { LimitSnapshot } from "../limit-store.ts";
import { STATUS_TIME_ZONE, type LimitEntry } from "../status-plus-logic.ts";
import { localDateKey, localDayStartMs } from "./calendar.ts";
import { entryDollars, sizeKey, type DollarInputs, type OpenRouterKeyInfo, type TokenfoldSnapshot, type WindowSize } from "./core.ts";
import { createSpendLedger, type SpendLedger } from "./ledger.ts";
import { advanceReading, evidenceOf, isWindowReading, type WindowEvidence, type WindowReading } from "./resets.ts";
import {
	advanceMeterDay,
	fetchOpenRouterKey,
	fetchTokenfold,
	normalizeDollarsConfig,
	readKeyFile,
	type FetchLike,
	type MeterAnchor,
} from "./sources.ts";

const CONFIG_SECTION = "usageDollars";
const REMOTE_TTL_MS = 60_000;
// The longest window priced from local spend is seven days; a day more covers late resets.
const LEDGER_MAX_AGE_MS = 8 * 86_400_000;
const LEDGER_MIN_REFRESH_MS = 5_000;
const RECENT_MODELS_MS = 7 * 86_400_000;
/**
 * Polls and response events observe on Pi's main thread, so a busy state-file
 * lock is skipped quickly; the next observation records the change. A usage
 * call, which the user asked for, waits longer.
 */
const OBSERVE_LOCK_WAIT_MS = 100;
const COLLECT_LOCK_WAIT_MS = 3_000;

export interface CollectContext {
	snapshots: Array<[string, LimitSnapshot]>;
	model: { provider?: string; id?: string };
	/** The session's scoped models: the ones agents may pick for subagents. */
	scopedModels: Array<{ provider: string; id: string }>;
	getApiKey: (provider: string) => Promise<string | undefined>;
	now: number;
	force?: boolean;
}

export interface CollectorOptions {
	agentDir: string;
	configFile?: string;
	timeZone?: string;
	fetch?: FetchLike;
}

interface Cached<T> {
	atMs: number;
	/** The source the answer came from; changed settings must not reuse it. */
	key: string;
	/** The request itself, so calls that overlap share one fetch. */
	value: Promise<T>;
}

interface MeterReading {
	provider: string;
	usedUsd: number;
	atMs: number;
}

type Anchors = Record<string, MeterAnchor>;
type Sizes = Record<string, WindowSize>;
type Readings = Record<string, WindowReading>;

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function isAnchor(value: unknown): value is MeterAnchor {
	const anchor = value as MeterAnchor | null;
	return !!anchor && typeof anchor.date === "string" && Number.isFinite(anchor.usedUsd) && Number.isFinite(anchor.atMs);
}

function readAnchors(file: string): Anchors {
	const raw = readJson(file);
	if (!raw || typeof raw !== "object") return {};
	return Object.fromEntries(Object.entries(raw).filter((pair): pair is [string, MeterAnchor] => isAnchor(pair[1])));
}

function readSizes(file: string): Sizes {
	const raw = readJson(file);
	if (!raw || typeof raw !== "object") return {};
	return Object.fromEntries(Object.entries(raw).filter((pair): pair is [string, WindowSize] => {
		const size = pair[1] as WindowSize | null;
		return !!size && Number.isFinite(size.limitUsd) && size.limitUsd > 0 && Number.isFinite(size.atMs)
			&& (size.source === "tokenfold" || size.source === "local");
	}));
}

function readReadings(file: string): Readings {
	const raw = readJson(file);
	if (!raw || typeof raw !== "object") return {};
	return Object.fromEntries(Object.entries(raw).filter((pair): pair is [string, WindowReading] => isWindowReading(pair[1])));
}

/** False when the file could not be saved; the caller reports it. */
function writeJson(file: string, value: unknown): boolean {
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
		writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		renameSync(temp, file);
		return true;
	} catch {
		rmSync(temp, { force: true });
		return false;
	}
}

/** The note for each step that failed: a state file that could not be saved, or an observer that threw. */
const PROBLEM_NOTES: Record<string, string> = {
	"meter-day.json": "Could not save meter-day.json in the usage-dollars folder, so spent today can count from the wrong reading.",
	"window-readings.json": "Could not save window-readings.json in the usage-dollars folder, so granted resets can be missed, and window sizes can read high.",
	"window-sizes-v2.json": "Could not save window-sizes-v2.json in the usage-dollars folder, so the start of the next cycle can have no dollar size.",
	"meter readings": "Could not record the meter readings, so spent today can be missing.",
	"window readings": "Could not record the window readings, so granted resets can be missed, and window sizes can read high.",
};

function evidenceMap(readings: Readings): Record<string, WindowEvidence> {
	return Object.fromEntries(Object.entries(readings).flatMap(([key, record]) => {
		const seen = evidenceOf(record);
		return seen ? [[key, seen]] : [];
	}));
}

function meterReadings(snapshots: Array<[string, LimitSnapshot]>): MeterReading[] {
	const readings: MeterReading[] = [];
	for (const [provider, snapshot] of snapshots) {
		const meter = snapshot.entries.find((entry) => entry.kind === "budget" && Number.isFinite(entry.usedUsd));
		if (meter) readings.push({ provider, usedUsd: meter.usedUsd as number, atMs: readingTime(meter, snapshot) });
	}
	return readings;
}

/** A reading kept from an earlier poll counts at its own time, not at the time of the poll that kept it. */
function readingTime(entry: LimitEntry, snapshot: LimitSnapshot): number {
	return entry.sampledMs !== undefined && Number.isFinite(entry.sampledMs) && entry.sampledMs <= snapshot.atMs ? entry.sampledMs : snapshot.atMs;
}

/**
 * The window readings a snapshot gives. An approximate reading (Claude Code's
 * last one, sent when a proxy's usage-endpoint source is down) can read 96%
 * against a real 38%: recorded, the return to 38% would look like a granted reset.
 */
function windowReadings(provider: string, snapshot: LimitSnapshot) {
	return snapshot.entries
		.filter((entry) => (entry.kind ?? "window") === "window" && !entry.approximate && Number.isFinite(entry.usedPct) && Number.isFinite(entry.resetMs))
		.map((entry) => ({ key: sizeKey(provider, entry), pct: entry.usedPct as number, resetMs: entry.resetMs as number, atMs: readingTime(entry, snapshot) }));
}

/** Reuse a cached answer for the same source within the TTL, unless forced. */
function cached<T>(entry: Cached<T> | undefined, key: string, now: number, force: boolean, load: () => Promise<T>): Cached<T> {
	if (entry && !force && entry.key === key && now - entry.atMs < REMOTE_TTL_MS) return entry;
	return { atMs: now, key, value: load() };
}

export function createDollarsCollector(options: CollectorOptions) {
	const configFile = options.configFile ?? join(options.agentDir, "pi-extras.json");
	const anchorFile = join(options.agentDir, "usage-dollars", "meter-day.json");
	// v2: sizes kept before granted resets were handled can be several times too large, and early in a
	// later cycle (under 5% used) nothing would replace them. Ignore the old file instead.
	const sizesFile = join(options.agentDir, "usage-dollars", "window-sizes-v2.json");
	const readingsFile = join(options.agentDir, "usage-dollars", "window-readings.json");
	const timeZone = options.timeZone ?? STATUS_TIME_ZONE;
	const fetchImpl = options.fetch ?? fetch;
	const ledger: SpendLedger = createSpendLedger({
		root: join(options.agentDir, "sessions"), maxAgeMs: LEDGER_MAX_AGE_MS, minRefreshMs: LEDGER_MIN_REFRESH_MS,
	});
	// Steps whose last run failed (PROBLEM_NOTES keys); collect() reports them, and a later success clears them.
	let problems = new Set<string>();
	function mark(name: string, ok: boolean): void {
		if (ok !== problems.has(name)) return;
		const next = new Set(problems);
		if (ok) next.delete(name);
		else next.add(name);
		problems = next;
	}
	function save(file: string, value: unknown): void {
		mark(basename(file), writeJson(file, value));
	}
	/**
	 * Change a shared state file, so processes that observe at the same time
	 * keep each other's changes. Nothing new takes no lock. A change takes the
	 * lock, reads the file again and saves. When the lock stays busy for
	 * `waitMs`, the change still counts for this call, the write is skipped,
	 * and the report names the file. An error from `change` goes to the caller.
	 */
	function update<T>(file: string, read: (file: string) => T, change: (current: T) => T, waitMs: number): T {
		const current = read(file);
		const next = change(current);
		if (next === current) {
			// The file already holds this, so a note about an earlier skipped write no longer applies.
			mark(basename(file), true);
			return current;
		}
		let locked = false;
		try {
			mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
			return withFileLock(file, () => {
				locked = true;
				const fresh = read(file);
				const merged = change(fresh);
				if (merged !== fresh) save(file, merged);
				else mark(basename(file), true);
				return merged;
			}, waitMs);
		} catch (error) {
			if (locked) throw error;
			mark(basename(file), false);
			return next;
		}
	}
	/** Each observer runs on its own, so one failing step does not stop the other at every poll. */
	function attempt<T>(name: string, run: () => T, fallback: () => T): T {
		try {
			const value = run();
			mark(name, true);
			return value;
		} catch {
			mark(name, false);
			return fallback();
		}
	}
	let tokenfold: Cached<{ snapshot?: TokenfoldSnapshot; error?: string }> | undefined;
	let openRouter: Cached<OpenRouterKeyInfo | undefined> | undefined;

	/**
	 * Record the first meter reading of each local day; another process may
	 * already have. A reading taken before local midnight (a stored snapshot
	 * loaded at startup) would put yesterday's spend into today.
	 */
	function observeMeters(snapshots: Array<[string, LimitSnapshot]>, now: number): Anchors {
		const dayStart = localDayStartMs(now, timeZone);
		const readings = meterReadings(snapshots).filter((reading) => reading.atMs >= dayStart && reading.atMs <= now);
		if (readings.length === 0) return readAnchors(anchorFile);
		return update(anchorFile, readAnchors, (stored) => readings.reduce((next, reading) => {
			const anchor = advanceMeterDay(next[reading.provider], reading.usedUsd, reading.atMs, timeZone);
			return anchor === next[reading.provider] ? next : { ...next, [reading.provider]: anchor };
		}, stored), OBSERVE_LOCK_WAIT_MS);
	}

	/**
	 * Record what the polls show, for every process: the first meter reading
	 * of each day and the last reading of each window. The poll hook calls
	 * this, so a granted reset is found at the first poll after it, not at the
	 * next usage call.
	 */
	function observe(snapshots: Array<[string, LimitSnapshot]>, now: number): { anchors: Anchors; resetEvidence: Record<string, WindowEvidence> } {
		return {
			anchors: attempt("meter readings", () => observeMeters(snapshots, now), () => readAnchors(anchorFile)),
			resetEvidence: attempt("window readings", () => observeWindows(snapshots, now), () => evidenceMap(readReadings(readingsFile))),
		};
	}

	/**
	 * Keep the last reading of each subscription window, shared by processes,
	 * to see granted mid-window resets. Returns the granted resets by sizeKey().
	 */
	function observeWindows(snapshots: Array<[string, LimitSnapshot]>, now: number): Record<string, WindowEvidence> {
		const readings = snapshots.flatMap(([provider, snapshot]) => {
			if (!Number.isFinite(snapshot.atMs) || snapshot.atMs > now) return [];
			return windowReadings(provider, snapshot);
		});
		if (readings.length === 0) return evidenceMap(readReadings(readingsFile));
		// Read under the lock, so another process's newer readings are the base.
		const next = update(readingsFile, readReadings, (stored) => readings.reduce((current, { key, ...reading }) => {
			const record = advanceReading(current[key], reading);
			return record === current[key] ? current : { ...current, [key]: record };
		}, stored), OBSERVE_LOCK_WAIT_MS);
		return evidenceMap(next);
	}

	async function tokenfoldFor(config: ReturnType<typeof normalizeDollarsConfig>, now: number, force: boolean, notes: string[]) {
		if (config.tokenfold && isOffline()) {
			notes.push("Pi is offline (PI_OFFLINE), so Tokenfold was not asked; Claude window dollars count this machine's spend only.");
			return undefined;
		}
		if (!config.tokenfold) {
			notes.push("Tokenfold is not set up (usageDollars.tokenfold in pi-extras.json), so Claude window dollars count this machine's spend only.");
			return undefined;
		}
		const key = readKeyFile(config.tokenfold.keyFile);
		if (!key) {
			notes.push("The Tokenfold key file is missing or does not hold a key; Claude window dollars count this machine's spend only.");
			return undefined;
		}
		const source = config.tokenfold;
		tokenfold = cached(tokenfold, source.url, now, force, () => fetchTokenfold(source, key, now, fetchImpl));
		const result = await tokenfold.value;
		if (result.error) notes.push(`${result.error} Claude window dollars count this machine's spend only.`);
		return result.snapshot;
	}

	/** Only for a user of OpenRouter: one whose session already polls its credits. */
	async function openRouterFor(context: CollectContext): Promise<OpenRouterKeyInfo | undefined> {
		if (isOffline() || !context.snapshots.some(([provider]) => provider === "openrouter")) return undefined;
		const key = await context.getApiKey("openrouter").catch(() => undefined);
		if (!key) return undefined;
		openRouter = cached(openRouter, "openrouter", context.now, context.force === true, () => fetchOpenRouterKey(key, fetchImpl));
		return openRouter.value;
	}

	/**
	 * Keep each window's size from this cycle's evidence, so the start of the
	 * next cycle (under 5% used) still has a dollar size. Shared by processes.
	 */
	function rememberSizes(snapshots: Array<[string, LimitSnapshot]>, inputs: DollarInputs): Sizes {
		const sizes: Array<[string, WindowSize]> = [];
		for (const [provider, snapshot] of snapshots) {
			for (const entry of snapshot.entries) {
				const dollars = entryDollars(provider, entry, inputs);
				// A start found after a gap in the readings misses spend: that size reads low and must not carry to the next cycle.
				if (!dollars || dollars.basis !== "implied" || dollars.sizeFrom || dollars.spendStartApprox || dollars.limitUsd === undefined) continue;
				sizes.push([sizeKey(provider, entry), { limitUsd: dollars.limitUsd, atMs: inputs.now, source: dollars.source === "tokenfold" ? "tokenfold" : "local" }]);
			}
		}
		if (sizes.length === 0) return readSizes(sizesFile);
		return update(sizesFile, readSizes, (stored) => sizes.reduce((next, [key, size]) =>
			next[key]?.limitUsd === size.limitUsd ? next : { ...next, [key]: size }, stored), COLLECT_LOCK_WAIT_MS);
	}

	function openCodeGoModels(context: CollectContext): string[] {
		const scoped = context.scopedModels.filter((model) => model.provider === "opencode-go").map((model) => model.id);
		const active = context.model.provider === "opencode-go" && context.model.id ? [context.model.id] : [];
		return [...new Set([...scoped, ...active, ...ledger.models("opencode-go", context.now - RECENT_MODELS_MS)])];
	}

	async function collect(context: CollectContext): Promise<{ inputs: DollarInputs; notes: string[] }> {
		const notes: string[] = [];
		const config = normalizeDollarsConfig((readJson(configFile) as Record<string, unknown> | undefined)?.[CONFIG_SECTION]);
		const [snapshot, openRouterKey, ledgerOk] = await Promise.all([
			tokenfoldFor(config, context.now, context.force === true, notes),
			openRouterFor(context),
			ledger.refresh(context.now).then(() => true, () => false),
		]);
		if (!ledgerOk) notes.push("Local session files could not be read; spend on this machine is missing.");
		const { anchors, resetEvidence } = observe(context.snapshots, context.now);
		const today = localDateKey(context.now, timeZone);
		const meterToday = Object.fromEntries(meterReadings(context.snapshots)
			.filter((reading) => anchors[reading.provider]?.date === today)
			.map(({ provider, usedUsd }) => [provider, { spentUsd: Math.max(0, usedUsd - anchors[provider]!.usedUsd), sinceMs: anchors[provider]!.atMs }]));
		const inputs: DollarInputs = {
			now: context.now,
			timeZone,
			...(ledgerOk ? {
				spend: (query) => ledger.sum(query),
				today: { byProvider: ledger.byProvider(localDayStartMs(context.now, timeZone), context.now) },
			} : {}),
			...(snapshot ? { tokenfold: snapshot } : {}),
			...(Object.keys(meterToday).length ? { meterToday } : {}),
			...(openRouterKey ? { openRouterKey } : {}),
			...(Object.keys(resetEvidence).length ? { resetEvidence } : {}),
			openCodeGo: { ...config.openCodeGo, models: openCodeGoModels(context) },
		};
		const lastSizes = rememberSizes(context.snapshots, inputs);
		for (const name of problems) notes.push(PROBLEM_NOTES[name] ?? `Could not complete ${name}; a figure can be wrong.`);
		return { inputs: Object.keys(lastSizes).length ? { ...inputs, lastSizes } : inputs, notes };
	}

	return { collect, observe };
}

export type DollarsCollector = ReturnType<typeof createDollarsCollector>;
