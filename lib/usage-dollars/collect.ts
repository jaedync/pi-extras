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
import { localDayStartMs } from "./calendar.ts";
import type { DollarInputs, OpenRouterKeyInfo, TokenfoldSnapshot } from "./core.ts";
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
	value: T;
}

type Anchors = Record<string, MeterAnchor>;

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

function writeAnchors(file: string, anchors: Anchors): void {
	mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(anchors)}\n`, { mode: 0o600 });
		renameSync(temp, file);
	} catch {
		rmSync(temp, { force: true });
	}
}

function meterReadings(snapshots: Array<[string, LimitSnapshot]>): Array<[string, number]> {
	const readings: Array<[string, number]> = [];
	for (const [provider, snapshot] of snapshots) {
		const meter = snapshot.entries.find((entry) => entry.kind === "budget" && Number.isFinite(entry.usedUsd));
		if (meter) readings.push([provider, meter.usedUsd as number]);
	}
	return readings;
}

export function createDollarsCollector(options: CollectorOptions) {
	const configFile = options.configFile ?? join(options.agentDir, "pi-extras.json");
	const anchorFile = join(options.agentDir, "usage-dollars", "meter-day.json");
	const timeZone = options.timeZone ?? STATUS_TIME_ZONE;
	const fetchImpl = options.fetch ?? fetch;
	const ledger: SpendLedger = createSpendLedger({
		root: join(options.agentDir, "sessions"), maxAgeMs: LEDGER_MAX_AGE_MS, minRefreshMs: LEDGER_MIN_REFRESH_MS,
	});
	let tokenfold: Cached<{ snapshot?: TokenfoldSnapshot; error?: string }> | undefined;
	let openRouter: Cached<OpenRouterKeyInfo | undefined> | undefined;

	/** Record the first meter reading of each local day; another process may already have. */
	function observe(snapshots: Array<[string, LimitSnapshot]>, now: number): Anchors {
		const stored = readAnchors(anchorFile);
		let next = stored;
		for (const [provider, usedUsd] of meterReadings(snapshots)) {
			const anchor = advanceMeterDay(stored[provider], usedUsd, now, timeZone);
			if (anchor !== stored[provider]) next = { ...next, [provider]: anchor };
		}
		if (next !== stored) writeAnchors(anchorFile, next);
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
		if (force || !tokenfold || now - tokenfold.atMs >= REMOTE_TTL_MS) {
			tokenfold = { atMs: now, value: await fetchTokenfold(config.tokenfold, key, now, fetchImpl) };
		}
		if (tokenfold.value.error) notes.push(`${tokenfold.value.error} Claude window dollars count this machine's spend only.`);
		return tokenfold.value.snapshot;
	}

	async function openRouterFor(context: CollectContext): Promise<OpenRouterKeyInfo | undefined> {
		const key = await context.getApiKey("openrouter").catch(() => undefined);
		if (!key) return undefined;
		if (context.force || !openRouter || context.now - openRouter.atMs >= REMOTE_TTL_MS) {
			openRouter = { atMs: context.now, value: await fetchOpenRouterKey(key, fetchImpl) };
		}
		return openRouter.value;
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
		const meterToday = Object.fromEntries(meterReadings(context.snapshots)
			.filter(([provider]) => anchors[provider])
			.map(([provider, usedUsd]) => [provider, { spentUsd: Math.max(0, usedUsd - anchors[provider]!.usedUsd), sinceMs: anchors[provider]!.atMs }]));
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
		return { inputs, notes };
	}

	return { collect, observe };
}

export type DollarsCollector = ReturnType<typeof createDollarsCollector>;
