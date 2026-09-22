/** Pure helpers for status-plus: money, time, quota shapes, catalog cost. */

/**
 * "window": a percentage against a rolling quota with a hard reset.
 * "budget": a spend balance against a limit (monthly, approximate reset).
 * "credits": a prepaid balance with no reset.
 */
export type LimitKind = "window" | "budget" | "credits";

export interface LimitEntry {
	label: string;
	/** Source window key ("five_hour", "seven_day_fable", "primary") when the provider names it. */
	key?: string;
	kind?: LimitKind;
	/** Model family token when the window only governs matching model ids ("fable"). */
	modelFamily?: string;
	/** Provider says the window is blocking regardless of the percentage. */
	exhausted?: boolean;
	/** Provider says requests still go through (Codex reports 100% while allowed). */
	allowed?: boolean;
	usedPct?: number;
	remainingText?: string;
	resetApprox?: boolean;
	resetMs?: number;
}

export interface UsageCounts {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface CostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CostTier extends CostRates {
	inputTokensAbove: number;
}

export interface ModelCost extends CostRates {
	tiers?: CostTier[];
}

/** Keep clock and reset labels in the user's zone unless explicitly overridden. */
export const STATUS_TIME_ZONE = process.env.STATUSLINE_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

/** At least two decimals; small amounts keep two significant digits ($0.0012). */
/** Decimal places that give `value` two significant figures below a dime, cents otherwise. */
export function moneyDecimals(value: number): number {
	if (value >= 100) return 0;
	if (value >= 0.1 || value <= 0) return 2;
	return Math.min(8, Math.ceil(-Math.log10(value)) + 1);
}

/**
 * Trailing zeros are kept (0.0030, not 0.003) so a figure's width only changes
 * when its magnitude does, which keeps the grid still while a counter moves.
 */
export function formatMoney(value: number): string {
	return value.toFixed(moneyDecimals(value));
}

/** Format `value` with the digit count of `reference`, for a moving figure that must not change width. */
export function formatMoneyLike(value: number, reference: number): string {
	return value.toFixed(moneyDecimals(reference));
}

export function hhmm(epochMs: number, timeZone = STATUS_TIME_ZONE): string {
	return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone })
		.format(new Date(epochMs));
}

/**
 * Compact duration: seconds detail below one minute (when enabled), m/s below
 * an hour, h/m below a day, then d/h.
 */
export function formatDuration(ms: number, withSeconds: boolean): string {
	const seconds = Math.max(0, ms) / 1000;
	if (withSeconds && seconds < 10) return `${seconds.toFixed(1)}s`;

	const totalSeconds = Math.round(seconds);
	if (withSeconds && totalSeconds < 60) return `${totalSeconds}s`;

	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) {
		return withSeconds ? `${totalMinutes}m${String(totalSeconds % 60).padStart(2, "0")}s` : `${totalMinutes}m`;
	}

	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 24) {
		const m = totalMinutes % 60;
		return m ? `${totalHours}h${m}m` : `${totalHours}h`;
	}

	const days = Math.floor(totalHours / 24);
	const h = totalHours % 24;
	return h ? `${days}d${h}h` : `${days}d`;
}

/** Tolerate seconds or milliseconds epochs. */
export function toEpochMs(timestamp: number): number {
	return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

/** 300 -> "5h", 10080 -> "7d", 45 -> "45m". */
export function windowLabel(minutes: number): string {
	if (minutes < 60) return `${minutes}m`;
	if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
	return `${Math.round(minutes / (24 * 60))}d`;
}

/** Returns the conventional quota endpoint for an Anthropic-compatible proxy. */
export function proxyQuotaUrl(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (url.hostname.toLowerCase() === "api.anthropic.com") return undefined;
		return new URL("/v1/usage/quota", url.origin).toString();
	} catch {
		return undefined;
	}
}

const QUOTA_BASE_LABELS: Record<string, string> = { five_hour: "5h", seven_day: "7d", one_day: "1d", thirty_day: "30d" };

/**
 * Split a quota key into its base window and optional model family:
 * "seven_day_fable" -> { base: "seven_day", family: "fable" }. Unknown
 * bases are kept whole so nothing is misread as model-specific.
 */
export function quotaKeyParts(type: string): { base: string; family?: string } {
	for (const base of Object.keys(QUOTA_BASE_LABELS)) {
		if (type === base) return { base };
		if (type.startsWith(`${base}_`)) return { base, family: type.slice(base.length + 1) };
	}
	return { base: type };
}

export function quotaLabel(type: string): string {
	const { base, family } = quotaKeyParts(type);
	const baseLabel = QUOTA_BASE_LABELS[base] ?? base.replaceAll("_", "-");
	return family ? `${baseLabel}-${family.replaceAll("_", "-")}` : baseLabel;
}

interface ProxyQuotaBucket {
	type?: unknown;
	status?: unknown;
	utilization?: unknown;
	resetsAt?: unknown;
}

interface ProxyExtraUsage {
	isEnabled?: unknown;
	monthlyLimit?: unknown;
	usedCredits?: unknown;
	currency?: unknown;
}

/** Normalize fractional proxy quotas into the percentage-based footer format. */
export function parseProxyQuota(body: unknown): LimitEntry[] {
	if (!body || typeof body !== "object") return [];
	const record = body as { buckets?: unknown; extraUsage?: unknown };
	const entries: LimitEntry[] = [];

	if (Array.isArray(record.buckets)) {
		for (const raw of record.buckets) {
			if (!raw || typeof raw !== "object") continue;
			const bucket = raw as ProxyQuotaBucket;
			if (typeof bucket.type !== "string" || typeof bucket.utilization !== "number") continue;
			if (!Number.isFinite(bucket.utilization)) continue;
			const resetMs = typeof bucket.resetsAt === "number" && Number.isFinite(bucket.resetsAt)
				? bucket.resetsAt
				: undefined;
			const { family } = quotaKeyParts(bucket.type);
			entries.push({
				label: quotaLabel(bucket.type),
				key: bucket.type,
				...(family ? { modelFamily: family } : {}),
				usedPct: bucket.utilization <= 1 ? bucket.utilization * 100 : bucket.utilization,
				resetMs,
				exhausted: bucket.status === "rejected",
				...(bucket.status === "allowed" ? { allowed: true } : {}),
			});
		}
	}

	const extra = record.extraUsage as ProxyExtraUsage | null | undefined;
	if (
		extra?.isEnabled === true &&
		typeof extra.monthlyLimit === "number" &&
		Number.isFinite(extra.monthlyLimit) &&
		extra.monthlyLimit > 0 &&
		typeof extra.usedCredits === "number" &&
		Number.isFinite(extra.usedCredits)
	) {
		const prefix = extra.currency === "USD" || extra.currency === undefined ? "$" : `${String(extra.currency)} `;
		entries.push({
			label: "",
			kind: "budget",
			remainingText: `${prefix}${formatMoney(extra.monthlyLimit - extra.usedCredits)}/${prefix}${formatMoney(extra.monthlyLimit)}`,
		});
	}

	return entries;
}

/** Recompute catalog pricing for transcripts persisted before rates were configured. */
export function estimateUsageCost(usage: UsageCounts, modelCost: ModelCost): number {
	const totalInput = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	const tier = [...(modelCost.tiers ?? [])]
		.filter((candidate) => totalInput > candidate.inputTokensAbove)
		.sort((left, right) => right.inputTokensAbove - left.inputTokensAbove)[0];
	const rates = tier ?? modelCost;
	return (
		((usage.input ?? 0) * rates.input +
			(usage.output ?? 0) * rates.output +
			(usage.cacheRead ?? 0) * rates.cacheRead +
			(usage.cacheWrite ?? 0) * rates.cacheWrite) /
		1_000_000
	);
}
