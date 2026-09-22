/**
 * Provider usage limits for status-plus: response-header parsers with a
 * generic fallback, and throttled pollers for providers whose quotas are not
 * in headers. A fresh poll snapshot outranks header parses so richer data is
 * not clobbered between polls. Adding a provider means adding a table entry.
 */
import {
	pollCodexUsage,
	pollOpenCodeGoUsage,
	type ProviderUsage,
	type RegistryLike,
} from "./provider-limits.ts";
import {
	formatMoney,
	parseProxyQuota,
	proxyQuotaUrl,
	quotaKeyParts,
	quotaLabel,
	toEpochMs,
	windowLabel,
	type LimitEntry,
} from "./status-plus-logic.ts";

export interface PollerContext {
	model?: { provider: string; baseUrl?: string };
	modelRegistry: RegistryLike & { getProvider(id: string): { baseUrl?: string } | undefined };
}

export type LimitPoller = (ctx: PollerContext) => Promise<LimitEntry[] | undefined>;

/** Poll cadence: `normalMs` at rest, `hotMs` while a window sits near a warning threshold. */
export interface PollInterval {
	normalMs: number;
	hotMs: number;
}

export const REFRESH_INTERVAL_MS = 30_000;
/** A poll snapshot younger than this outranks header-derived entries. */
export const POLL_FRESH_MS = 15 * 60_000;
/** A forced poll (tool refresh) still waits this long after the previous one. */
export const FORCED_POLL_FLOOR_MS = 5_000;
/** Failed polls back off exponentially up to this gap. */
export const MAX_BACKOFF_MS = 10 * 60_000;
const MAX_BACKOFF_DOUBLINGS = 6;
const POLL_TIMEOUT_MS = 10_000;

/** Gap before the next poll: hot windows poll faster, consecutive failures back off. */
export function pollGapMs(interval: PollInterval, failures: number, hot: boolean): number {
	const base = hot ? interval.hotMs : interval.normalMs;
	const doublings = Math.min(MAX_BACKOFF_DOUBLINGS, Math.max(0, failures));
	return Math.min(Math.max(base, MAX_BACKOFF_MS), base * 2 ** doublings);
}
const KEY_LABELS: Record<string, string> = { primary: "5h", secondary: "7d", rolling: "5h", weekly: "7d", monthly: "mo" };

function parseNumberHeader(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Tolerate epoch seconds, epoch ms, or ISO timestamps in reset headers. */
function parseResetHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return toEpochMs(numeric);
	const iso = Date.parse(value);
	return Number.isFinite(iso) ? iso : undefined;
}

/** Highest-pressure entries first, capped to keep the line compact. */
export function topEntries(entries: LimitEntry[], max = 3): LimitEntry[] {
	return [...entries].sort((a, b) => (b.usedPct ?? -1) - (a.usedPct ?? -1)).slice(0, max);
}

/** ChatGPT/Codex backend: x-codex-{primary,secondary}-* used-percent windows. */
export function parseCodexLimits(headers: Record<string, string>, now = Date.now()): LimitEntry[] {
	const entries: LimitEntry[] = [];
	for (const [kind, fallbackLabel] of [["primary", "5h"], ["secondary", "7d"]] as const) {
		const usedPct = parseNumberHeader(headers[`x-codex-${kind}-used-percent`]);
		if (usedPct === undefined) continue;
		const windowMinutes = parseNumberHeader(headers[`x-codex-${kind}-window-minutes`]);
		const resetSeconds =
			parseNumberHeader(headers[`x-codex-${kind}-resets-in-seconds`]) ??
			parseNumberHeader(headers[`x-codex-${kind}-reset-after-seconds`]);
		entries.push({
			label: windowMinutes ? windowLabel(windowMinutes) : fallbackLabel,
			usedPct,
			resetMs: resetSeconds !== undefined ? now + resetSeconds * 1000 : undefined,
		});
	}
	return entries;
}

/**
 * Anthropic: subscription plans send unified utilization headers; API-key
 * orgs send limit/remaining/reset triplets. The overage bucket is dollar
 * spend and renders from the poller with amounts, so it is skipped here.
 */
export function parseAnthropicLimits(headers: Record<string, string>): LimitEntry[] {
	const unified: LimitEntry[] = [];
	const unifiedReset = parseResetHeader(headers["anthropic-ratelimit-unified-reset"]);
	for (const [key, value] of Object.entries(headers)) {
		const match = key.match(/^anthropic-ratelimit-unified-(.+)-utilization$/);
		if (!match || match[1] === "overage") continue;
		const raw = Number(value);
		if (!Number.isFinite(raw)) continue;
		unified.push({
			label: match[1],
			usedPct: raw <= 1 ? raw * 100 : raw,
			resetMs: parseResetHeader(headers[`anthropic-ratelimit-unified-${match[1]}-reset`]) ?? unifiedReset,
		});
	}
	if (unified.length > 0) return topEntries(unified);

	const pairs: LimitEntry[] = [];
	for (const [key, value] of Object.entries(headers)) {
		const match = key.match(/^anthropic-ratelimit-([a-z-]+)-limit$/);
		if (!match || match[1] === "overage") continue;
		const limit = Number(value);
		const remaining = parseNumberHeader(headers[`anthropic-ratelimit-${match[1]}-remaining`]);
		if (!Number.isFinite(limit) || limit <= 0 || remaining === undefined) continue;
		pairs.push({
			label: match[1],
			usedPct: ((limit - remaining) / limit) * 100,
			resetMs: parseResetHeader(headers[`anthropic-ratelimit-${match[1]}-reset`]),
		});
	}
	return topEntries(pairs);
}

/** Generic fallback: plain x-ratelimit-limit/remaining/reset. */
export function parseGenericLimits(headers: Record<string, string>): LimitEntry[] {
	const limit = parseNumberHeader(headers["x-ratelimit-limit"]);
	const remaining = parseNumberHeader(headers["x-ratelimit-remaining"]);
	if (limit === undefined || limit <= 0 || remaining === undefined) return [];
	return [{
		label: "req",
		usedPct: ((limit - remaining) / limit) * 100,
		resetMs: parseResetHeader(headers["x-ratelimit-reset"]),
	}];
}

const LIMIT_HEADER_PARSERS: Record<string, (headers: Record<string, string>) => LimitEntry[]> = {
	"openai-codex": (headers) => parseCodexLimits(headers),
	anthropic: parseAnthropicLimits,
};

export function parseLimitHeaders(provider: string, headers: Record<string, string>): LimitEntry[] {
	const parsed = LIMIT_HEADER_PARSERS[provider]?.(headers) ?? [];
	return parsed.length > 0 ? parsed : parseGenericLimits(headers);
}

/**
 * Codex reports its window length, so the label follows it ("5h", "7d").
 * The percentage saturates at 100 while requests still succeed, so the
 * account-level allowed/limit_reached flags are carried on every window.
 */
export function codexEntries(usage: ProviderUsage): LimitEntry[] {
	return usage.windows.map((window) => ({
		label: window.windowSeconds ? windowLabel(window.windowSeconds / 60) : KEY_LABELS[window.key] ?? window.key,
		key: window.key,
		usedPct: window.pct,
		resetMs: window.resetsAtMs,
		...(usage.limitReached !== undefined ? { exhausted: usage.limitReached } : {}),
		...(usage.allowed !== undefined ? { allowed: usage.allowed } : {}),
	}));
}

/** Go windows are fixed by name; "mo" reads better than "30d" for a calendar quota. */
export function openCodeGoEntries(usage: ProviderUsage): LimitEntry[] {
	return usage.windows.map((window) => ({
		label: KEY_LABELS[window.key] ?? window.key,
		key: window.key,
		usedPct: window.pct,
		resetMs: window.resetsAtMs,
		exhausted: window.exhausted === true,
	}));
}

/** Anthropic OAuth windows are keyed five_hour, seven_day, seven_day_<family>. */
const OAUTH_WINDOW_KEY = /^(five_hour|seven_day)(_[a-z0-9_]+)?$/;

function providerBaseUrl(ctx: PollerContext): string | undefined {
	return ctx.model?.provider === "anthropic" ? ctx.model.baseUrl : ctx.modelRegistry.getProvider("anthropic")?.baseUrl;
}

/** The local proxy route is cheap and self-caching; Anthropic's own endpoint is not. */
export function anthropicPollInterval(ctx: PollerContext): PollInterval {
	return proxyQuotaUrl(providerBaseUrl(ctx))
		? { normalMs: 60_000, hotMs: 20_000 }
		: { normalMs: 5 * 60_000, hotMs: 60_000 };
}

/**
 * Anthropic usage: prefer an Anthropic-compatible proxy's local quota route,
 * otherwise the OAuth endpoint. Both expose windows and optional spend.
 */
export async function pollAnthropicUsage(ctx: PollerContext): Promise<LimitEntry[] | undefined> {
	const quotaUrl = proxyQuotaUrl(providerBaseUrl(ctx));
	if (quotaUrl) {
		const response = await fetch(quotaUrl, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
		if (!response.ok) return undefined;
		const entries = parseProxyQuota(await response.json());
		return entries.length > 0 ? entries : undefined;
	}

	const token = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
	if (!token) return undefined;
	const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
		headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
		signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;
	const body = (await response.json()) as Record<string, unknown>;
	const entries: LimitEntry[] = [];
	for (const [key, raw] of Object.entries(body)) {
		if (!OAUTH_WINDOW_KEY.test(key)) continue;
		const window = raw as { utilization?: unknown; resets_at?: unknown } | null | undefined;
		if (!window || typeof window.utilization !== "number") continue;
		const { family } = quotaKeyParts(key);
		entries.push({
			label: quotaLabel(key),
			key,
			...(family ? { modelFamily: family } : {}),
			usedPct: window.utilization,
			resetMs: typeof window.resets_at === "string" ? Date.parse(window.resets_at) || undefined : undefined,
		});
	}

	const spend = body.spend as {
		enabled?: unknown;
		used?: { amount_minor?: unknown; exponent?: unknown };
		limit?: { amount_minor?: unknown };
	} | null | undefined;
	if (spend?.enabled && typeof spend.used?.amount_minor === "number" && typeof spend.limit?.amount_minor === "number") {
		const scale = 10 ** (typeof spend.used.exponent === "number" ? spend.used.exponent : 2);
		const used = spend.used.amount_minor / scale;
		const limit = spend.limit.amount_minor / scale;
		if (limit > 0) {
			// Dollars only: a percent would render in alarm colors for a quota
			// that is expected to be consumed. No reset is reported, so the
			// next UTC month boundary stands in, marked approximate.
			const nowDate = new Date();
			entries.push({
				label: "",
				kind: "budget",
				remainingText: `$${formatMoney(limit - used)}/$${formatMoney(limit)}`,
				resetMs: Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1),
				resetApprox: true,
			});
		}
	}
	return entries;
}

/** OpenRouter has no quota headers; poll the credits endpoint instead. */
export async function pollOpenRouterCredits(ctx: PollerContext): Promise<LimitEntry[] | undefined> {
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
	if (!apiKey) return undefined;
	const response = await fetch("https://openrouter.ai/api/v1/credits", {
		headers: { authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;
	const body = (await response.json()) as { data?: { total_credits?: unknown; total_usage?: unknown } };
	const total = body.data?.total_credits;
	const used = body.data?.total_usage;
	if (typeof total !== "number" || typeof used !== "number") return undefined;
	return [{ label: "", kind: "credits", remainingText: `$${formatMoney(total - used)} credits` }];
}

async function pollCodexEntries(ctx: PollerContext): Promise<LimitEntry[] | undefined> {
	const usage = await pollCodexUsage(ctx.modelRegistry);
	return usage ? codexEntries(usage) : undefined;
}

async function pollOpenCodeGoEntries(ctx: PollerContext): Promise<LimitEntry[] | undefined> {
	const usage = await pollOpenCodeGoUsage(ctx.modelRegistry);
	return usage ? openCodeGoEntries(usage) : undefined;
}

/** Throttled non-header limit sources. */
export const LIMIT_POLLERS: Record<string, { interval: (ctx: PollerContext) => PollInterval; poll: LimitPoller }> = {
	anthropic: { interval: anthropicPollInterval, poll: pollAnthropicUsage },
	"openai-codex": { interval: () => ({ normalMs: 60_000, hotMs: REFRESH_INTERVAL_MS }), poll: pollCodexEntries },
	"opencode-go": { interval: () => ({ normalMs: 60_000, hotMs: REFRESH_INTERVAL_MS }), poll: pollOpenCodeGoEntries },
	openrouter: { interval: () => ({ normalMs: 10 * 60_000, hotMs: 5 * 60_000 }), poll: pollOpenRouterCredits },
};
