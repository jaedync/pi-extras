/**
 * Settings and remote sources for the usage tool's dollar figures: Tokenfold's
 * read-only /api/ha (spend across every personal machine on one Claude
 * account), OpenRouter's key endpoint, and the daily anchor that turns a
 * monthly meter into "spent today". Every input is untrusted and validated.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { localDateKey } from "./calendar.ts";
import type { OpenRouterBudget, OpenRouterKeyInfo, TokenfoldSnapshot, TokenfoldWindow } from "./core.ts";
import { isOpenCodeGoPlan, type OpenCodeGoPlan } from "./opencode-go.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const SOURCE_TIMEOUT_MS = 3000;
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

export interface TokenfoldConfig {
	url: string;
	keyFile: string;
}

export interface DollarsConfig {
	tokenfold?: TokenfoldConfig;
	openCodeGo: { plan: OpenCodeGoPlan; caps: Record<string, number> };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
// Printable ASCII with no spaces: API keys, never a sentence or a pasted config.
const KEY_PATTERN = /^[\x21-\x7e]{16,256}$/;

function expandHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Plain http only to this machine, so the read key never crosses a network in clear. */
function tokenfoldUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		const allowed = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
		return allowed && !url.username && !url.password ? `${url.origin}${url.pathname.replace(/\/+$/, "")}` : undefined;
	} catch {
		return undefined;
	}
}

export function normalizeDollarsConfig(raw: unknown): DollarsConfig {
	const record = isObject(raw) ? raw : {};
	const tokenfold = isObject(record.tokenfold) ? record.tokenfold : {};
	const url = tokenfoldUrl(tokenfold.url);
	const keyFile = typeof tokenfold.keyFile === "string" && tokenfold.keyFile.trim() ? expandHome(tokenfold.keyFile.trim()) : undefined;
	const go = isObject(record.opencodeGo) ? record.opencodeGo : {};
	const caps = Object.fromEntries(Object.entries(isObject(go.monthlyCaps) ? go.monthlyCaps : {})
		.filter((pair): pair is [string, number] => finite(pair[1]) && pair[1] > 0));
	return {
		...(url && keyFile ? { tokenfold: { url, keyFile } } : {}),
		openCodeGo: { plan: isOpenCodeGoPlan(go.plan) ? go.plan : "go", caps },
	};
}

export function readKeyFile(path: string): string | undefined {
	try {
		const key = readFileSync(path, "utf8").trim();
		return KEY_PATTERN.test(key) ? key : undefined;
	} catch {
		return undefined;
	}
}

function tokenfoldWindow(raw: unknown): TokenfoldWindow | undefined {
	if (!isObject(raw) || !finite(raw.pct_used) || !finite(raw.spend_usd) || typeof raw.resets_at !== "string") return undefined;
	const resetsAtMs = Date.parse(raw.resets_at);
	if (!Number.isFinite(resetsAtMs)) return undefined;
	return {
		pctUsed: raw.pct_used,
		spendUsd: raw.spend_usd,
		...(finite(raw.implied_limit_usd) && raw.implied_limit_usd > 0 ? { impliedLimitUsd: raw.implied_limit_usd } : {}),
		resetsAtMs,
	};
}

export function parseTokenfoldHa(body: unknown, fetchedAtMs: number): TokenfoldSnapshot | undefined {
	if (!isObject(body)) return undefined;
	const fiveHour = tokenfoldWindow(body.five_hour);
	const weekly = tokenfoldWindow(body.weekly);
	return {
		fetchedAtMs,
		...(finite(body.updated_at_epoch) ? { updatedAtMs: body.updated_at_epoch * 1000 } : {}),
		...(finite(body.cost_today_usd) ? { costTodayUsd: body.cost_today_usd } : {}),
		...(fiveHour ? { fiveHour } : {}),
		...(weekly ? { weekly } : {}),
	};
}

export interface TokenfoldResult {
	snapshot?: TokenfoldSnapshot;
	/** For the report's notes: never the key, the URL or the response body. */
	error?: string;
}

export async function fetchTokenfold(config: TokenfoldConfig, key: string, now: number, fetchImpl: FetchLike = fetch): Promise<TokenfoldResult> {
	try {
		const response = await fetchImpl(`${config.url}/api/ha`, {
			headers: { "x-api-key": key },
			signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
		});
		if (!response.ok) return { error: `Tokenfold refused the request (HTTP ${response.status}).` };
		const snapshot = parseTokenfoldHa(await response.json(), now);
		return snapshot ? { snapshot } : { error: "Tokenfold sent a response this version cannot read." };
	} catch (error) {
		const name = (error as Error)?.name === "TimeoutError" ? "timed out" : "could not be reached";
		return { error: `Tokenfold ${name}.` };
	}
}

function openRouterBudget(raw: unknown): OpenRouterBudget | undefined {
	if (!isObject(raw) || !finite(raw.limit_usd) || !finite(raw.spend_usd) || !finite(raw.remaining_usd)) return undefined;
	return {
		limitUsd: raw.limit_usd,
		spendUsd: raw.spend_usd,
		remainingUsd: raw.remaining_usd,
		...(typeof raw.reset_interval === "string" ? { resetInterval: raw.reset_interval } : {}),
		...(typeof raw.resets_at === "string" ? { resetsAt: raw.resets_at } : {}),
	};
}

export function parseOpenRouterKey(body: unknown): OpenRouterKeyInfo | undefined {
	const data = isObject(body) && isObject(body.data) ? body.data : undefined;
	if (!data) return undefined;
	const budget = openRouterBudget(data.effective_budget);
	return {
		...(finite(data.usage_daily) ? { usageDailyUsd: data.usage_daily } : {}),
		...(finite(data.limit_remaining) ? { limitRemainingUsd: data.limit_remaining } : {}),
		...(budget ? { effectiveBudget: budget } : {}),
	};
}

export async function fetchOpenRouterKey(apiKey: string, fetchImpl: FetchLike = fetch): Promise<OpenRouterKeyInfo | undefined> {
	try {
		const response = await fetchImpl(OPENROUTER_KEY_URL, {
			headers: { authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
		});
		return response.ok ? parseOpenRouterKey(await response.json()) : undefined;
	} catch {
		return undefined;
	}
}

export interface MeterAnchor {
	date: string;
	usedUsd: number;
	atMs: number;
}

/**
 * The first meter reading of each local day. A reading below the anchor means
 * the meter started a new month during the day, so the day counts from zero.
 */
export function advanceMeterDay(prev: MeterAnchor | undefined, usedUsd: number, now: number, timeZone: string): MeterAnchor {
	const date = localDateKey(now, timeZone);
	if (!prev || prev.date !== date) return { date, usedUsd, atMs: now };
	if (usedUsd < prev.usedUsd) return { ...prev, usedUsd: 0 };
	return prev;
}
