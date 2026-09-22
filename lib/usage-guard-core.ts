/**
 * Pure logic for usage-guard: which limit windows govern the active model,
 * when a threshold crossing deserves one warning, and the report the
 * `usage` tool returns. No I/O; the extension wires this to Pi.
 */
import type { LimitSnapshot } from "./limit-store.ts";
import { STATUS_TIME_ZONE, formatDuration, type LimitEntry, type LimitKind } from "./status-plus-logic.ts";

export interface GuardConfig {
	enabled: boolean;
	/** Ascending percentages; the last one is the wrap-up warning. */
	bands: number[];
	/** Added to the reset time when suggesting when to resume autonomously. */
	resumeMarginSeconds: number;
	/** A window this close below its next threshold makes its provider poll faster. */
	proximityPct: number;
	/** A reset further away than this is not worth waiting for; the agent should stop and report. */
	maxWaitSeconds: number;
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
	enabled: true,
	bands: [90, 95],
	resumeMarginSeconds: 5 * 60,
	proximityPct: 10,
	// Covers any five-hour window; weekly resets are days away and never waitable.
	maxWaitSeconds: 6 * 3600,
};

/** One window the agent has been told to stay under for this session. */
export interface SessionBudget {
	window: string;
	pct: number;
}

export interface ActiveModel {
	provider?: string;
	id?: string;
}

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
		enabled: record.enabled !== false,
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

export function budgetMatches(entry: LimitEntry, budget: SessionBudget | undefined): boolean {
	if (!budget) return false;
	const wanted = budget.window.toLowerCase();
	return entry.label.toLowerCase() === wanted || entry.key?.toLowerCase() === wanted;
}

/** A session budget replaces the configured bands for the window it names. */
export function thresholdsFor(entry: LimitEntry, config: GuardConfig, budget: SessionBudget | undefined): number[] {
	return budgetMatches(entry, budget) ? [budget!.pct] : config.bands;
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
	for (const [provider, snapshot] of snapshots) {
		if (model.provider && provider !== model.provider) continue;
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
	if (entry.exhausted) return { threshold: 100, reason: "exhausted", final: true };
	const threshold = bandFor(entry.usedPct as number, thresholds);
	if (threshold === undefined) return undefined;
	const budgeted = budgetMatches(entry, budget);
	return { threshold, reason: budgeted ? "budget" : "band", final: budgeted || threshold === Math.max(...thresholds) };
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
	if (!config.enabled) return [];
	const warnings: Warning[] = [];
	for (const { provider, entry } of activeWindows(snapshots, model, now)) {
		const hit = classify(entry, config, budget);
		if (!hit) continue;
		if (alreadyFired(fired, provider, entry, hit.threshold, hit.reason)) continue;
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
	if (!config.enabled) return hot;
	for (const { provider, entry } of activeWindows(snapshots, model, now)) {
		const pct = entry.usedPct as number;
		const next = thresholdsFor(entry, config, budget).filter((threshold) => threshold > pct).sort((a, b) => a - b)[0];
		if (next !== undefined && next - pct <= config.proximityPct) hot.add(provider);
	}
	return hot;
}

export function localTime(epochMs: number, timeZone = STATUS_TIME_ZONE): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
	}).format(new Date(epochMs));
}

export interface ResetTiming {
	resetsAt: string;
	resetsAtLocal: string;
	resetsInSeconds: number;
	resumeAfterSeconds: number;
	/** Near enough (and exact enough) that waiting for it is a reasonable option. */
	waitable: boolean;
	resetApprox?: boolean;
}

export function resetTiming(entry: LimitEntry, config: GuardConfig, now: number, timeZone?: string): ResetTiming | undefined {
	if (entry.resetMs === undefined) return undefined;
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
 * What follows the wrap-up. Waiting is offered only when the reset is near
 * and only for unattended work; a days-away reset is never worth sleeping for.
 */
function continuation(warning: Warning, timing: ResetTiming | undefined): string {
	const scoped = warning.entry.modelFamily
		? ` This window governs only ${warning.entry.modelFamily} models on ${warning.provider}; other models are not affected by it.`
		: "";
	if (!timing) return ` Then stop and report.${scoped}`;
	if (timing.waitable) {
		return ` Then stop and report. Only if you must continue unattended, wait for the reset with a background job (\`sleep ${timing.resumeAfterSeconds}\`) and resume when it completes.${scoped}`;
	}
	return ` Then stop and report; the reset is too far away to wait for.${scoped}`;
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
	const cause = reason === "exhausted"
		? `${name} is blocked by the provider (${pct}% used).`
		: reason === "budget"
			? `${name} reached the session budget: ${pct}% used, budget ${threshold}%.`
			: `${name} is at ${pct}% (threshold ${threshold}%).`;
	const codexNote = entry.allowed === true && pct >= 100 && reason !== "exhausted"
		? " The provider still accepts requests; the percentage is capped at 100."
		: "";
	if (!final) {
		return `Usage notice: ${cause}${reset}${codexNote} Avoid starting large new work; prefer finishing what is in progress. Use the usage tool for details.`;
	}
	return `Usage warning: ${cause}${reset}${codexNote} Wrap up at a good stopping point now: finish the current step, commit or record state, and summarize where things stand.${continuation(warning, timing)}`;
}

export interface UsageReportLimit {
	provider: string;
	window: string;
	key?: string;
	kind: LimitKind;
	applies: boolean;
	usedPct?: number;
	remaining?: string;
	status: "ok" | "exhausted" | "full-but-allowed";
	thresholds?: number[];
	nextThreshold?: number;
	headroomPct?: number;
	budgetPct?: number;
	reset?: ResetTiming;
}

export interface UsageReport {
	asOf: string;
	model: ActiveModel;
	warnings: "on" | "off";
	budget: SessionBudget | null;
	snapshotAgeSeconds: Record<string, number>;
	limits: UsageReportLimit[];
	notes: string[];
}

function reportLimit(
	provider: string,
	entry: LimitEntry,
	model: ActiveModel,
	config: GuardConfig,
	budget: SessionBudget | undefined,
	now: number,
	timeZone?: string,
): UsageReportLimit {
	const kind = entryKind(entry);
	const applies = (!model.provider || provider === model.provider) && entryApplies(entry, model);
	const pct = entry.usedPct;
	const status = entry.exhausted ? "exhausted" : entry.allowed === true && pct !== undefined && pct >= 100 ? "full-but-allowed" : "ok";
	const base: UsageReportLimit = {
		provider,
		window: entry.label || entry.key || kind,
		...(entry.key ? { key: entry.key } : {}),
		kind,
		applies,
		...(pct !== undefined ? { usedPct: Math.round(pct * 10) / 10 } : {}),
		...(entry.remainingText ? { remaining: entry.remainingText } : {}),
		status,
	};
	const reset = resetTiming(entry, config, now, timeZone);
	if (kind !== "window" || pct === undefined) return { ...base, ...(reset ? { reset } : {}) };
	const thresholds = thresholdsFor(entry, config, budget);
	const next = thresholds.filter((threshold) => threshold > pct).sort((a, b) => a - b)[0];
	return {
		...base,
		thresholds,
		...(next !== undefined ? { nextThreshold: next, headroomPct: Math.round((next - pct) * 10) / 10 } : {}),
		...(budgetMatches(entry, budget) ? { budgetPct: budget!.pct } : {}),
		...(reset ? { reset } : {}),
	};
}

export function usageReport(
	snapshots: Iterable<[string, LimitSnapshot]>,
	model: ActiveModel,
	config: GuardConfig,
	budget: SessionBudget | undefined,
	now: number,
	includeAll = false,
	timeZone?: string,
): UsageReport {
	const limits: UsageReportLimit[] = [];
	const snapshotAgeSeconds: Record<string, number> = {};
	let sawActiveProvider = false;
	for (const [provider, snapshot] of snapshots) {
		const active = !model.provider || provider === model.provider;
		if (active) sawActiveProvider = true;
		if (!active && !includeAll) continue;
		snapshotAgeSeconds[provider] = Math.max(0, Math.round((now - snapshot.atMs) / 1000));
		for (const entry of snapshot.entries) {
			const limit = reportLimit(provider, entry, model, config, budget, now, timeZone);
			if (limit.applies || includeAll) limits.push(limit);
		}
	}
	const notes: string[] = [];
	const provider = model.provider ?? "the active provider";
	if (!sawActiveProvider) {
		notes.push(`No usage data yet for ${provider}; call again with refresh: true after a request has been made.`);
	} else if (!limits.some((limit) => limit.kind === "window" && limit.applies)) {
		notes.push(`${provider} reports no rolling percentage windows for this model; only balance or budget figures apply and no usage warnings will fire.`);
	}
	if (budget && !limits.some((limit) => limit.budgetPct !== undefined)) {
		notes.push(`Session budget targets window "${budget.window}", which no applicable limit matches; it will not fire.`);
	}
	return {
		asOf: new Date(now).toISOString(),
		model,
		warnings: config.enabled ? "on" : "off",
		budget: budget ?? null,
		snapshotAgeSeconds,
		limits,
		notes,
	};
}
