/**
 * Gathers what the usage tool needs for dollar figures. Remote answers are
 * cached for a minute, because agents call the tool before each piece of
 * work and Tokenfold's numbers move on a two-minute poll. Each source fails
 * open into a note: a report without dollars beats no report.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LimitSnapshot } from "../limit-store.ts";
import { STATUS_TIME_ZONE } from "../status-plus-logic.ts";
import { localDateKey, localDayStartMs } from "./calendar.ts";
import { entryDollars, sizeKey, type DollarInputs, type OpenRouterKeyInfo, type TokenfoldSnapshot, type WindowSize } from "./core.ts";
import { createSpendLedger, type SpendLedger } from "./ledger.ts";
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

function writeJson(file: string, value: unknown): void {
	mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		renameSync(temp, file);
	} catch {
		rmSync(temp, { force: true });
	}
}

function meterReadings(snapshots: Array<[string, LimitSnapshot]>): MeterReading[] {
	const readings: MeterReading[] = [];
	for (const [provider, snapshot] of snapshots) {
		const meter = snapshot.entries.find((entry) => entry.kind === "budget" && Number.isFinite(entry.usedUsd));
		if (meter) readings.push({ provider, usedUsd: meter.usedUsd as number, atMs: snapshot.atMs });
	}
	return readings;
}

/** Reuse a cached answer for the same source within the TTL, unless forced. */
function cached<T>(entry: Cached<T> | undefined, key: string, now: number, force: boolean, load: () => Promise<T>): Cached<T> {
	if (entry && !force && entry.key === key && now - entry.atMs < REMOTE_TTL_MS) return entry;
	return { atMs: now, key, value: load() };
}

export function createDollarsCollector(options: CollectorOptions) {
	const configFile = options.configFile ?? join(options.agentDir, "pi-extras.json");
	const anchorFile = join(options.agentDir, "usage-dollars", "meter-day.json");
	const sizesFile = join(options.agentDir, "usage-dollars", "window-sizes.json");
	const timeZone = options.timeZone ?? STATUS_TIME_ZONE;
	const fetchImpl = options.fetch ?? fetch;
	const ledger: SpendLedger = createSpendLedger({
		root: join(options.agentDir, "sessions"), maxAgeMs: LEDGER_MAX_AGE_MS, minRefreshMs: LEDGER_MIN_REFRESH_MS,
	});
	let tokenfold: Cached<{ snapshot?: TokenfoldSnapshot; error?: string }> | undefined;
	let openRouter: Cached<OpenRouterKeyInfo | undefined> | undefined;

	/**
	 * Record the first meter reading of each local day; another process may
	 * already have. A reading taken before local midnight (a stored snapshot
	 * loaded at startup) would put yesterday's spend into today.
	 */
	function observe(snapshots: Array<[string, LimitSnapshot]>, now: number): Anchors {
		const dayStart = localDayStartMs(now, timeZone);
		const stored = readAnchors(anchorFile);
		let next = stored;
		for (const reading of meterReadings(snapshots)) {
			if (reading.atMs < dayStart || reading.atMs > now) continue;
			const anchor = advanceMeterDay(next[reading.provider], reading.usedUsd, reading.atMs, timeZone);
			if (anchor !== next[reading.provider]) next = { ...next, [reading.provider]: anchor };
		}
		if (next !== stored) writeJson(anchorFile, next);
		return next;
	}

	async function tokenfoldFor(config: ReturnType<typeof normalizeDollarsConfig>, now: number, force: boolean, notes: string[]) {
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
		if (!context.snapshots.some(([provider]) => provider === "openrouter")) return undefined;
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
		const stored = readSizes(sizesFile);
		let next = stored;
		for (const [provider, snapshot] of snapshots) {
			for (const entry of snapshot.entries) {
				const dollars = entryDollars(provider, entry, inputs);
				if (!dollars || dollars.basis !== "implied" || dollars.sizeFrom || dollars.limitUsd === undefined) continue;
				const key = sizeKey(provider, entry);
				if (stored[key]?.limitUsd === dollars.limitUsd) continue;
				next = { ...next, [key]: { limitUsd: dollars.limitUsd, atMs: inputs.now, source: dollars.source === "tokenfold" ? "tokenfold" : "local" } };
			}
		}
		if (next !== stored) writeJson(sizesFile, next);
		return next;
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
		const anchors = observe(context.snapshots, context.now);
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
			openCodeGo: { ...config.openCodeGo, models: openCodeGoModels(context) },
		};
		const lastSizes = rememberSizes(context.snapshots, inputs);
		return { inputs: Object.keys(lastSizes).length ? { ...inputs, lastSizes } : inputs, notes };
	}

	return { collect, observe };
}

export type DollarsCollector = ReturnType<typeof createDollarsCollector>;
