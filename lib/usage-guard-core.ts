/**
 * Pure logic for usage-guard: which limit windows govern the active model,
 * when a threshold crossing deserves one warning, and the report the
 * `usage` tool returns. No I/O; the extension wires this to Pi.
 */
import type { LimitSnapshot } from "./limit-store.ts";
import { formatDuration, quotaKeyParts, quotaLabel, type LimitEntry, type LimitKind } from "./status-plus-logic.ts";
import { localTime } from "./usage-time.ts";
import { LIMIT_POLLERS } from "./status-plus-limits.ts";
import { familyMembers, providerFamily, sameFamily } from "./provider-family.ts";
import { paceText, usagePace, type UsagePace } from "./usage-pace.ts";
import { dollarsSummary, entryDollars, type DollarInputs, type DollarsSummary, type EntryDollars } from "./usage-dollars/core.ts";
export { localTime } from "./usage-time.ts";

export interface GuardConfig {
	/** Band and provider-block warnings. Off by default; a session budget always warns. */
	enabled: boolean;
	/** Ascending percentages; the last one is the wrap-up warning. */
	bands: number[];
	/** Added to the reset time when suggesting how long to sleep before resuming. */
	resumeMarginSeconds: number;
	/** A window this close below its next threshold makes its provider poll faster. */
	proximityPct: number;
	/** A reset at most this far away is worth sleeping through instead of stopping. */
	maxWaitSeconds: number;
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
	enabled: false,
	bands: [90, 95],
	// Enough to absorb reset drift between polls without idling long after the window reopens.
	resumeMarginSeconds: 3 * 60,
	proximityPct: 10,
	// Covers any five-hour window, and a weekly window in its last five hours; any window counts by time to reset.
	maxWaitSeconds: 5 * 3600,
};

/** One window the agent has been told to stay under for this session. */
export interface SessionBudget {
	window: string;
	pct: number;
}

export interface ActiveModel {
	provider?: string;
	id?: string;
	/** Zero token cost in the model catalog, as for a local model. */
	unmetered?: boolean;
}

const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** True when the catalog prices every token kind it lists at zero: a local or free model. */
export function isUnmetered(cost: Partial<Record<(typeof PRICE_KEYS)[number], number>> | undefined): boolean {
	const prices = PRICE_KEYS.map((key) => cost?.[key]).filter((price) => price !== undefined);
	return prices.length > 0 && prices.every((price) => price === 0);
}

type Priced = { provider: string; cost?: Parameters<typeof isUnmetered>[0] };

/** Families with a model the catalog prices; one with no price listed counts as priced, as in isUnmetered. */
export function pricedFamilies(models: Iterable<Priced>): Set<string> {
	const priced = new Set<string>();
	for (const model of models) if (!isUnmetered(model.cost)) priced.add(providerFamily(model.provider));
	return priced;
}

/** Zero token cost, and no model of its family priced: a zero-cost claude-code listing still bills the Anthropic plan. */
export const unmeteredModel = (model: Priced, priced: ReadonlySet<string>): boolean =>
	isUnmetered(model.cost) && !priced.has(providerFamily(model.provider));

export type WarningReason = "band" | "budget" | "exhausted";

export interface Warning {
	key: string;
	provider: string;
	entry: LimitEntry;
	threshold: number;
	reason: WarningReason;
	/** Wrap-up warning: highest band, a session budget, or a blocked window. */
	final: boolean;
}

function finiteNumbers(value: unknown): number[] {
	return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];
}

/** Accept a loosely typed config object; anything malformed falls back to the default. */
export function normalizeGuardConfig(raw: unknown): GuardConfig {
	const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const bands = [...new Set(finiteNumbers(record.bands).filter((band) => band > 0 && band <= 100))].sort((a, b) => a - b);
	const nonNegative = (value: unknown, fallback: number): number =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
	return {
		enabled: record.enabled === true,
		bands: bands.length ? bands : DEFAULT_GUARD_CONFIG.bands,
		resumeMarginSeconds: nonNegative(record.resumeMarginSeconds, DEFAULT_GUARD_CONFIG.resumeMarginSeconds),
		proximityPct: nonNegative(record.proximityPct, DEFAULT_GUARD_CONFIG.proximityPct),
		maxWaitSeconds: nonNegative(record.maxWaitSeconds, DEFAULT_GUARD_CONFIG.maxWaitSeconds),
	};
}

export function entryKind(entry: LimitEntry): LimitKind {
	if (entry.kind) return entry.kind;
	if (entry.usedPct !== undefined) return "window";
	return entry.remainingText?.includes("/") ? "budget" : "credits";
}

/** Model-scoped windows (seven_day_fable) govern only ids that carry the family token. */
export function entryApplies(entry: LimitEntry, model: ActiveModel): boolean {
	if (!entry.modelFamily) return true;
	const tokens = (model.id ?? "").toLowerCase().split(/[^a-z0-9]+/);
	return tokens.includes(entry.modelFamily.toLowerCase());
}

/** Reset time recorded in a warning key, when the window reported one. */
function keyResetMs(key: string): number | undefined {
	const reset = key.slice(key.lastIndexOf("|") + 1);
	return /^\d+$/.test(reset) ? Number(reset) : undefined;
}

/** A notice's window and threshold, from its details or, for older notices, its key (provider|window|threshold|reset). */
function noticeParts(record: Record<string, unknown>, key: string): { provider: string; window: string; threshold: number } {
	const [legacyProvider, window = "", threshold] = key.split("|");
	return {
		provider: typeof record.provider === "string" ? record.provider : legacyProvider,
		window,
		threshold: typeof record.threshold === "number" ? record.threshold : Number(threshold),
	};
}

/**
 * A band or budget notice says its window reached a threshold. It no longer
 * holds when the budget it names was cleared or changed (`budget` null or
 * another one; undefined means the caller does not know), or when the live
 * window is below the threshold (a granted reset) or past its reset.
 */
function thresholdLapsed(
	record: Record<string, unknown>,
	parts: { window: string; threshold: number },
	current: LimitEntry | undefined,
	now: number | undefined,
	budget: SessionBudget | null | undefined,
): boolean {
	if (record.reason === "budget" && budget !== undefined) {
		const named = { label: quotaLabel(parts.window), key: parts.window };
		if (!budget || budget.pct !== parts.threshold || !budgetMatches(named, budget)) return true;
	}
	if (!current) return false;
	if (now !== undefined && current.resetMs !== undefined && current.resetMs <= now) return true;
	return current.usedPct !== undefined && Number.isFinite(parts.threshold) && current.usedPct < parts.threshold;
}

/**
 * Recheck automatic notices at request time, including notices queued by older
 * extension versions. A notice lapses once its window resets: it stays in raw
 * history but would otherwise keep telling the model to wait out a limit that
 * no longer exists. `snapshot` is the active provider's.
 */
export function warningApplies(details: unknown, model: ActiveModel, now?: number, snapshot?: LimitSnapshot, budget?: SessionBudget | null): boolean {
	if (!details || typeof details !== "object") return true;
	const record = details as Record<string, unknown>;
	if (typeof record.key !== "string" || !["band", "budget", "exhausted"].includes(String(record.reason))) return true;
	const resetMs = keyResetMs(record.key);
	if (now !== undefined && resetMs !== undefined && now >= resetMs) return false;
	const parts = noticeParts(record, record.key);
	const modelFamily = typeof record.modelFamily === "string" ? record.modelFamily : quotaKeyParts(parts.window).family;
	// Notices name the family whose reading fired them; an older one may name a member.
	if (!sameFamily(parts.provider, model.provider)) return false;
	const current = snapshot?.entries.find((entry) => (entry.key ?? entry.label) === parts.window);
	// Keep raw history, but do not carry a disproved block or a void threshold into another model request.
	if (record.reason === "exhausted" && current?.exhausted === false) return false;
	if (record.reason !== "exhausted" && thresholdLapsed(record, parts, current, now, budget)) return false;
	return entryApplies({ label: "", modelFamily }, model);
}

export function budgetMatches(entry: LimitEntry, budget: SessionBudget | undefined): boolean {
	if (!budget) return false;
	const wanted = budget.window.toLowerCase();
	return entry.label.toLowerCase() === wanted || entry.key?.toLowerCase() === wanted;
}

/** A session budget replaces the configured bands for the window it names, and applies even with warnings off. */
export function thresholdsFor(entry: LimitEntry, config: GuardConfig, budget: SessionBudget | undefined): number[] {
	if (budgetMatches(entry, budget)) return [budget!.pct];
	return config.enabled ? config.bands : [];
}

/** Highest threshold at or below the percentage. */
export function bandFor(pct: number, thresholds: number[]): number | undefined {
	return thresholds.filter((threshold) => pct >= threshold).sort((a, b) => b - a)[0];
}

/**
 * Resets drift by sub-second amounts between polls (a proxy recomputes them
 * on every fetch), so one cycle is a tolerance around a reset, not an exact
 * timestamp. Consecutive cycles of any known window are hours apart.
 */
export const CYCLE_TOLERANCE_MS = 10 * 60_000;

function cyclePrefix(provider: string, entry: LimitEntry, threshold: number, reason: WarningReason): string {
	return [provider, entry.key ?? entry.label, reason === "exhausted" ? "x" : threshold].join("|");
}

/** One warning per provider, window, threshold and reset cycle. */
export function warningKey(provider: string, entry: LimitEntry, threshold: number, reason: WarningReason): string {
	return `${cyclePrefix(provider, entry, threshold, reason)}|${entry.resetMs ?? "none"}`;
}

/** True when a fired key names the same window, threshold and a reset within tolerance. */
export function alreadyFired(
	fired: ReadonlySet<string>,
	provider: string,
	entry: LimitEntry,
	threshold: number,
	reason: WarningReason,
): boolean {
	const prefix = `${cyclePrefix(provider, entry, threshold, reason)}|`;
	for (const key of fired) {
		if (!key.startsWith(prefix)) continue;
		const tail = key.slice(prefix.length);
		if (tail === "none" || entry.resetMs === undefined) {
			if (tail === "none" && entry.resetMs === undefined) return true;
			continue;
		}
		const firedReset = Number(tail);
		if (Number.isFinite(firedReset) && Math.abs(firedReset - entry.resetMs) <= CYCLE_TOLERANCE_MS) return true;
	}
	return false;
}

function activeWindows(
	snapshots: Iterable<[string, LimitSnapshot]>,
	model: ActiveModel,
	now: number,
): Array<{ provider: string; entry: LimitEntry }> {
	const result: Array<{ provider: string; entry: LimitEntry }> = [];
	if (!model.provider) return result;
	for (const [provider, snapshot] of snapshots) {
		if (!sameFamily(provider, model.provider)) continue;
		for (const entry of snapshot.entries) {
			if (entryKind(entry) !== "window" || entry.usedPct === undefined) continue;
			if (!entryApplies(entry, model)) continue;
			// A reset already in the past means the snapshot is stale, not that the window is full.
			if (entry.resetMs !== undefined && entry.resetMs <= now) continue;
			result.push({ provider, entry });
		}
	}
	return result;
}

function classify(
	entry: LimitEntry,
	config: GuardConfig,
	budget: SessionBudget | undefined,
): { threshold: number; reason: WarningReason; final: boolean } | undefined {
	const thresholds = thresholdsFor(entry, config, budget);
	if (thresholds.length === 0) return undefined;
	if (entry.exhausted) return { threshold: 100, reason: "exhausted", final: true };
	// Claude Code's last reading can overstate a window: alone it is no reason to warn.
	if (entry.approximate) return undefined;
	const threshold = bandFor(entry.usedPct as number, thresholds);
	if (threshold === undefined) return undefined;
	const budgeted = budgetMatches(entry, budget);
	return { threshold, reason: budgeted ? "budget" : "band", final: budgeted || threshold === Math.max(...thresholds) };
}

/**
 * Hard cap: once a window's wrap-up has been sent this cycle, nothing more is
 * said about it. A later provider block adds nothing the request error won't.
 */
function finalFired(
	fired: ReadonlySet<string>,
	provider: string,
	entry: LimitEntry,
	config: GuardConfig,
	budget: SessionBudget | undefined,
): boolean {
	const top = Math.max(...thresholdsFor(entry, config, budget));
	return alreadyFired(fired, provider, entry, top, "band") || alreadyFired(fired, provider, entry, 100, "exhausted");
}

/** Threshold crossings not yet announced this cycle, for the active provider only. */
export function pendingWarnings(
	snapshots: Iterable<[string, LimitSnapshot]>,
	model: ActiveModel,
	config: GuardConfig,
	budget: SessionBudget | undefined,
	fired: ReadonlySet<string>,
	now: number,
): Warning[] {
	const warnings: Warning[] = [];
	for (const { provider, entry } of activeWindows(snapshots, model, now)) {
		const hit = classify(entry, config, budget);
		if (!hit) continue;
		if (alreadyFired(fired, provider, entry, hit.threshold, hit.reason)) continue;
		if (finalFired(fired, provider, entry, config, budget)) continue;
		warnings.push({ key: warningKey(provider, entry, hit.threshold, hit.reason), provider, entry, ...hit });
	}
	return warnings;
}

/** Providers with a governing window sitting just under its next threshold. */
export function hotProviders(
	snapshots: Iterable<[string, LimitSnapshot]>,
	model: ActiveModel,
	config: GuardConfig,
	budget: SessionBudget | undefined,
	now: number,
): Set<string> {
	const hot = new Set<string>();
	for (const { provider, entry } of activeWindows(snapshots, model, now)) {
		if (entry.approximate) continue;
		const pct = entry.usedPct as number;
		const next = thresholdsFor(entry, config, budget).filter((threshold) => threshold > pct).sort((a, b) => a - b)[0];
		if (next !== undefined && next - pct <= config.proximityPct) hot.add(provider);
	}
	return hot;
}

export interface ResetTiming {
	resetsAt: string;
	resetsAtLocal: string;
	resetsInSeconds: number;
	resumeAfterSeconds: number;
	/** Near and exact enough that sleeping resumeAfterSeconds beats stopping. */
	waitable: boolean;
	resetApprox?: boolean;
}

export function resetTiming(entry: LimitEntry, config: GuardConfig, now: number, timeZone?: string): ResetTiming | undefined {
	if (entry.resetMs === undefined || !Number.isFinite(new Date(entry.resetMs).getTime())) return undefined;
	const resetsInSeconds = Math.max(0, Math.ceil((entry.resetMs - now) / 1000));
	return {
		resetsAt: new Date(entry.resetMs).toISOString(),
		resetsAtLocal: localTime(entry.resetMs, timeZone),
		resetsInSeconds,
		resumeAfterSeconds: resetsInSeconds + config.resumeMarginSeconds,
		waitable: !entry.resetApprox && resetsInSeconds <= config.maxWaitSeconds,
		...(entry.resetApprox ? { resetApprox: true } : {}),
	};
}

/**
 * What the final warning asks for. A session budget is a warning point, not a
 * stop: agents that read "budget" as a limit stopped work the user wanted
 * done. A near reset is slept through so the run keeps going; stopping is
 * reserved for a reset days away. Either way, work that nearly fits is
 * finished rather than cut short.
 */
function guidance(warning: Warning, timing: ResetTiming | undefined, config: GuardConfig): string {
	if (warning.reason === "budget") {
		return "The session budget is a warning point, not a limit: say in your next status note that the window reached it, " +
			"then keep working on the task. Stop here only if the user told you to stop at this point.";
	}
	if (timing?.waitable) {
		const margin = formatDuration(config.resumeMarginSeconds * 1000, false);
		return "This limit does not have to end the task. Finish anything that fits in the remaining headroom. " +
			`If more remains, pause at a clean checkpoint and sleep through the reset: call shell_job_start with command \`sleep ${timing.resumeAfterSeconds}\` ` +
			`and title "Wait for usage reset", then end your turn. This is a deliberate wait, not polling; its completion wakes you ${margin} after the reset, ` +
			`so continue the task from there. Without background jobs, run \`sleep ${timing.resumeAfterSeconds}\` in the foreground with a longer timeout.`;
	}
	return "The reset is too far away to wait for. If what remains of the current task is small, finish it; " +
		"otherwise stop at a clean checkpoint (commit or record state) and summarize where things stand.";
}

function scopeNote(warning: Warning): string {
	return warning.entry.modelFamily
		? ` This window governs only ${warning.entry.modelFamily} models on ${warning.provider}; other models are not affected by it.`
		: "";
}

function windowName(provider: string, entry: LimitEntry): string {
	return `${provider} ${entry.label || entry.key || "window"}`;
}

/** Short, self-contained text for the agent; final warnings carry the resume recipe. */
export function warningMessage(warning: Warning, config: GuardConfig, now: number, timeZone?: string): string {
	const { entry, threshold, reason, final } = warning;
	const pct = Math.round(entry.usedPct ?? 0);
	const name = windowName(warning.provider, entry);
	const timing = resetTiming(entry, config, now, timeZone);
	const reset = timing
		? ` Resets ${timing.resetsAtLocal} (in ${formatDuration(timing.resetsInSeconds * 1000, false)}).`
		: "";
	const paceClause = paceText(usagePace(entry, now, timeZone), timing?.resetsInSeconds);
	const pace = paceClause ? ` Pace: ${paceClause}.` : "";
	const cause = reason === "exhausted"
		? `${name} is blocked by the provider (${pct}% used).`
		: reason === "budget"
			? `${name} reached the session budget: ${pct}% used, budget ${threshold}%.`
			: `${name} is at ${pct}% (threshold ${threshold}%).`;
	const codexNote = entry.allowed === true && pct >= 100 && reason !== "exhausted"
		? " The provider still accepts requests; the percentage is capped at 100."
		: "";
	if (!final) {
		return `Usage notice: ${cause}${reset}${pace}${codexNote} Advance notice only: keep working normally. Use the usage tool for details.`;
	}
	return `Usage warning: ${cause}${reset}${pace}${codexNote} ${guidance(warning, timing, config)}${scopeNote(warning)}`;
}

/** A reading this much older than its snapshot was kept from an earlier poll. */
const KEPT_READING_MS = 60_000;
const APPROXIMATE_SOURCE = "from Claude Code's last response";
const STALE_SOURCE = "an earlier usage-endpoint reading, more than 30 minutes old";
const NO_PERCENT_SOURCE = "a rejection with no percent, so 100% is inferred";
const APPROXIMATE_NOTE = "Limits marked approximate come from Claude Code's last response, or are usage-endpoint readings more than 30 minutes old, " +
	"because the usage endpoint did not answer, or are rejections that gave no percent, shown as 100%. " +
	"They can lag or read high, fire no threshold warnings, and have no dollar figures.";

const RESET_PASSED_NOTE = "Limits with status \"reset\" already reset since their last reading, so their percent is from the previous cycle. " +
	"The next poll or response gives the new reading.";

export interface UsageReportLimit {
	provider: string;
	window: string;
	key?: string;
	kind: LimitKind;
	applies: boolean;
	usedPct?: number;
	remaining?: string;
	/** "reset": the reading is from before a reset that has passed, so its percent is the previous cycle's. */
	status: "ok" | "exhausted" | "full-but-allowed" | "reset";
	thresholds?: number[];
	nextThreshold?: number;
	headroomPct?: number;
	budgetPct?: number;
	/** Set when the reading is not the usage endpoint's. */
	approximate?: string;
	/** Set when the reading is older than its snapshot: a poll that could not read the window kept it. */
	readingAgeSeconds?: number;
	reset?: ResetTiming;
	pace?: UsagePace;
	dollars?: EntryDollars;
}

/** What the usage tool gathered for dollar figures, and why any source is missing. */
export interface CollectedDollars {
	inputs: DollarInputs;
	notes: string[];
}

export interface UsageReport {
	asOf: string;
	model: ActiveModel;
	warnings: "on" | "off";
	budget: SessionBudget | null;
	snapshotAgeSeconds: Record<string, number>;
	limits: UsageReportLimit[];
	/** Scoped models with zero token cost: subagent choices that use no limit. */
	unmeteredModels?: string[];
	/** Paid providers in scope with no limit reading, and why; listed only with includeAll. */
	limitsUnavailable?: Record<string, string>;
	notes: string[];
	dollars?: DollarsSummary;
}

function reportLimit(
	provider: string,
	entry: LimitEntry,
	model: ActiveModel,
	config: GuardConfig,
	budget: SessionBudget | undefined,
	now: number,
	timeZone?: string,
	dollarInputs?: DollarInputs,
): UsageReportLimit {
	const limit = reportLimitFigures(provider, entry, model, config, budget, now, timeZone);
	const dollars = dollarInputs ? safely(() => entryDollars(provider, entry, dollarInputs)) : undefined;
	return dollars ? { ...limit, dollars } : limit;
}

/** Dollar figures are extra: a fault there must not cost the agent its percent report. */
function safely<T>(compute: () => T): T | undefined {
	try {
		return compute();
	} catch {
		return undefined;
	}
}

function reportLimitFigures(
	provider: string,
	entry: LimitEntry,
	model: ActiveModel,
	config: GuardConfig,
	budget: SessionBudget | undefined,
	now: number,
	timeZone?: string,
): UsageReportLimit {
	const kind = entryKind(entry);
	const applies = sameFamily(provider, model.provider) && entryApplies(entry, model);
	const pct = entry.usedPct;
	const passed = entry.resetMs !== undefined && entry.resetMs <= now;
	const status = passed ? "reset" : entry.exhausted ? "exhausted" : entry.allowed === true && pct !== undefined && pct >= 100 ? "full-but-allowed" : "ok";
	const base: UsageReportLimit = {
		provider,
		window: entry.label || entry.key || kind,
		...(entry.key ? { key: entry.key } : {}),
		kind,
		applies,
		...(pct !== undefined ? { usedPct: Math.round(pct * 10) / 10 } : {}),
		...(entry.remainingText ? { remaining: entry.remainingText } : {}),
		status,
		...(entry.approximate ? { approximate: entry.noPercent ? NO_PERCENT_SOURCE : entry.stale ? STALE_SOURCE : APPROXIMATE_SOURCE } : {}),
	};
	const timing = resetTiming(entry, config, now, timeZone);
	// Nothing is left to wait for after the reset.
	const reset = timing && passed ? { ...timing, waitable: false } : timing;
	const pace = usagePace(entry, now, timeZone);
	if (kind !== "window" || pct === undefined) return { ...base, ...(reset ? { reset } : {}) };
	const thresholds = thresholdsFor(entry, config, budget);
	const next = thresholds.filter((threshold) => threshold > pct).sort((a, b) => a - b)[0];
	return {
		...base,
		thresholds,
		...(next !== undefined ? { nextThreshold: next, headroomPct: Math.round((next - pct) * 10) / 10 } : {}),
		...(budgetMatches(entry, budget) ? { budgetPct: budget!.pct } : {}),
		...(reset ? { reset } : {}),
		...(pace ? { pace } : {}),
	};
}

export const NO_ENDPOINT_REASON = "It has no usage endpoint to poll. Limits show only if its responses carry rate-limit headers.";
export const NO_READING_REASON = "No reading yet: the poll is pending, failed, or waits for its gap. Call again later with refresh: true.";
/** Sign in with ChatGPT reports no usage itself; an openai-codex login reads the same plan (status-plus-limits.ts). */
export const OPENAI_METER_REASON = "Sign in with ChatGPT reports no usage. Its ChatGPT plan windows show only when an openai-codex login is also present (/login openai-codex), and only for an OAuth openai login, not an API key.";

/** Why a provider that can be polled may still have no reading, when that is not just a pending poll. A Pi login decision, so by provider id. */
const PROVIDER_REASONS: Readonly<Record<string, string>> = { openai: OPENAI_METER_REASON };

/** Whether the provider's family has a usage poller (status-plus-limits.ts). */
const polled = (provider: string): boolean => Object.hasOwn(LIMIT_POLLERS, providerFamily(provider));

export const missingReason = (provider: string): string =>
	PROVIDER_REASONS[provider] ?? (polled(provider) ? NO_READING_REASON : NO_ENDPOINT_REASON);

/**
 * Paid provider families in scope that have no limit snapshot, by family id,
 * with the most specific reason of their members in scope. A provider whose
 * scoped models are all unmetered is left out: it has no limit.
 */
export function unavailableLimits(
	models: ReadonlyArray<{ provider: string; unmetered?: boolean }>,
	snapshots: Iterable<[string, LimitSnapshot]>,
): Record<string, string> {
	const known = new Set([...snapshots].map(([provider]) => providerFamily(provider)));
	const metered = new Set(models.filter((model) => !model.unmetered).map((model) => model.provider));
	const result: Record<string, string> = {};
	for (const family of [...new Set([...metered].map((provider) => providerFamily(provider)))].sort()) {
		if (known.has(family)) continue;
		const member = familyMembers(family).find((provider) => metered.has(provider) && Object.hasOwn(PROVIDER_REASONS, provider));
		result[family] = missingReason(member ?? family);
	}
	return result;
}

/** What the report cannot show in its figures: missing data, approximate or outdated readings, a budget that matches nothing. */
function reportNotes(
	limits: readonly UsageReportLimit[],
	model: ActiveModel,
	budget: SessionBudget | undefined,
	sawActiveProvider: boolean,
	unmeteredModels: readonly string[],
	unavailable: Readonly<Record<string, string>>,
): string[] {
	const notes: string[] = [];
	const provider = model.provider ?? "the active provider";
	const ownWindows = limits.some((limit) => limit.kind === "window" && limit.applies);
	// Without this, a local model reads other providers' full windows as its own and rations work it gets for free.
	if (model.unmetered && !ownWindows) {
		notes.push(`${provider}/${model.id ?? "model"} has zero token cost and reports no usage limits. Usage does not limit this session's own work: keep working without regard to usage.`);
	} else if (!sawActiveProvider) {
		notes.push(model.provider && Object.hasOwn(PROVIDER_REASONS, model.provider)
			? `No usage data yet for ${provider}. ${PROVIDER_REASONS[model.provider]}`
			: model.provider && !polled(model.provider)
			? `No usage data yet for ${provider}. It has no usage endpoint to poll, so limits come only from response headers after its next request.`
			: `No usage data yet for ${provider}; call again with refresh: true after a request has been made.`);
	} else if (!ownWindows) {
		notes.push(`${provider} reports no subscription windows for this model; only per-minute rate limits, balances or budgets apply, and no usage warnings will fire.`);
	}
	if (limits.some((limit) => !limit.applies)) {
		notes.push("Limits with applies: false do not govern the active model. They matter only for subagents that you start on that provider.");
	}
	if (unmeteredModels.length) {
		notes.push("unmeteredModels have zero token cost and no usage limits: a subagent on one of them uses no limit or budget.");
	}
	if (Object.keys(unavailable).length) {
		notes.push("limitsUnavailable lists paid providers in scope with no limit reading. Their headroom is unknown, not zero.");
	}
	if (limits.some((limit) => limit.approximate)) notes.push(APPROXIMATE_NOTE);
	if (limits.some((limit) => limit.status === "reset")) notes.push(RESET_PASSED_NOTE);
	if (budget && !limits.some((limit) => limit.budgetPct !== undefined)) {
		notes.push(`Session budget targets window "${budget.window}", which no applicable limit matches; it will not fire.`);
	}
	return notes;
}

export function usageReport(
	snapshots: Iterable<[string, LimitSnapshot]>,
	model: ActiveModel,
	config: GuardConfig,
	budget: SessionBudget | undefined,
	now: number,
	includeAll = false,
	timeZone?: string,
	dollars?: CollectedDollars,
	/** Scoped models with zero token cost, as `provider/id`; listed only with includeAll. */
	unmeteredModels: readonly string[] = [],
	/** From unavailableLimits(); listed only with includeAll. */
	unavailable: Readonly<Record<string, string>> = {},
): UsageReport {
	const limits: UsageReportLimit[] = [];
	const snapshotAgeSeconds: Record<string, number> = {};
	let sawActiveProvider = false;
	for (const [provider, snapshot] of snapshots) {
		const active = sameFamily(provider, model.provider);
		if (active) sawActiveProvider = true;
		if (!active && !includeAll) continue;
		snapshotAgeSeconds[provider] = Math.max(0, Math.round((now - snapshot.atMs) / 1000));
		for (const entry of snapshot.entries) {
			const limit = reportLimit(provider, entry, model, config, budget, now, timeZone, dollars?.inputs);
			const kept = entry.sampledMs !== undefined && snapshot.atMs - entry.sampledMs > KEPT_READING_MS;
			if (limit.applies || includeAll) limits.push(kept ? { ...limit, readingAgeSeconds: Math.max(0, Math.round((now - entry.sampledMs!) / 1000)) } : limit);
		}
	}
	const listed = includeAll ? [...unmeteredModels] : [];
	const missing = includeAll ? { ...unavailable } : {};
	const notes = reportNotes(limits, model, budget, sawActiveProvider, listed, missing);
	// Notes go before the figures: a model reads the JSON in order and must know which limits are its own first.
	const report: UsageReport = {
		asOf: new Date(now).toISOString(),
		model,
		notes,
		...(listed.length ? { unmeteredModels: listed } : {}),
		...(Object.keys(missing).length ? { limitsUnavailable: missing } : {}),
		warnings: config.enabled ? "on" : "off",
		budget: budget ?? null,
		snapshotAgeSeconds,
		limits,
	};
	const summary = dollars ? safely(() => dollarsSummary(limits, dollars.inputs)) : undefined;
	if (!dollars || !summary) return report;
	return { ...report, dollars: { ...summary, notes: [...summary.notes, ...dollars.notes] } };
}
