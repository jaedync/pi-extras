/**
 * Dollar figures for the usage tool, so an agent can budget work and
 * subagents in money as well as percent. Pure: the collector gathers local
 * spend, Tokenfold's cross-machine spend, meters and balances, and this turns
 * them into per-limit figures and a per-provider summary.
 *
 * Subscription windows report percent only. Their dollar size is implied by
 * spend in the window divided by the percent used, the same arithmetic
 * Tokenfold uses (app/ha.py), so both agree when both are present.
 */
import type { LimitEntry } from "../status-plus-logic.ts";
import { businessDaysLeft, calendarDaysLeft, localDateKey, localDayStartMs, nextUtcMonthStartMs } from "./calendar.ts";
import { OPENCODE_GO_WINDOW_SHARE, openCodeGoMonthlyCap, type OpenCodeGoPlan } from "./opencode-go.ts";
import { localTime } from "../usage-time.ts";

/** Below this, the provider's rounding of the percent swamps the estimate (Tokenfold uses the same floor). */
export const MIN_PCT_FOR_IMPLIED = 5;
/** Tokenfold truncates resets to the minute and polls every two minutes; a different cycle is hours away. */
export const TOKENFOLD_RESET_TOLERANCE_MS = 10 * 60_000;

const FIVE_HOURS_S = 5 * 3600;
const SEVEN_DAYS_S = 7 * 86400;

export interface SpendQuery {
	provider: string;
	sinceMs: number;
	untilMs: number;
	/** Count only model ids that carry this token ("fable"). */
	family?: string;
}

export interface TokenfoldWindow {
	pctUsed: number;
	spendUsd: number;
	impliedLimitUsd?: number;
	resetsAtMs: number;
}

export interface TokenfoldSnapshot {
	fetchedAtMs: number;
	/** When Tokenfold last sampled the quota. */
	updatedAtMs?: number;
	costTodayUsd?: number;
	fiveHour?: TokenfoldWindow;
	weekly?: TokenfoldWindow;
}

export interface OpenRouterBudget {
	limitUsd: number;
	spendUsd: number;
	remainingUsd: number;
	resetInterval?: string;
	resetsAt?: string;
}

export interface OpenRouterKeyInfo {
	usageDailyUsd?: number;
	limitRemainingUsd?: number;
	effectiveBudget?: OpenRouterBudget;
}

export interface DollarInputs {
	now: number;
	timeZone: string;
	/** Local transcript spend; absent when the ledger could not be read. */
	spend?: (query: SpendQuery) => number;
	/** Local transcript spend since local midnight, by provider. */
	today?: { byProvider: Record<string, number> };
	tokenfold?: TokenfoldSnapshot;
	/** Meter growth since the first reading of the local day, by provider. */
	meterToday?: Record<string, { spentUsd: number; sinceMs: number }>;
	openRouterKey?: OpenRouterKeyInfo;
	openCodeGo?: { plan: OpenCodeGoPlan; caps: Record<string, number>; models: string[] };
}

export interface ModelDollars {
	limitUsd: number;
	remainingUsd: number;
}

export interface WindowDollars {
	basis: "implied" | "plan cap";
	source: "tokenfold" | "local" | "plan table";
	scope?: "all personal machines" | "this machine";
	spentUsd?: number;
	limitUsd?: number;
	remainingUsd?: number;
	perModel?: Record<string, ModelDollars>;
	dataAgeSeconds?: number;
	note?: string;
}

export interface BudgetDollars {
	basis: "meter";
	source: "provider";
	limitUsd: number;
	spentUsd: number;
	remainingUsd: number;
	resetsAt: string;
	resetsAtLocal: string;
	resetApprox?: boolean;
	calendarDaysLeft: number;
	businessDaysLeft: number;
	/** What remains, from the start of today, spread over the business days left. */
	perBusinessDayUsd?: number;
	spentTodayUsd?: number;
	spentTodaySinceLocal?: string;
	/** Today's share minus today's spend; negative when today is over its share. */
	leftTodayUsd?: number;
}

export interface BalanceDollars {
	basis: "balance";
	source: "provider";
	balanceUsd: number;
	spentTodayUtcUsd?: number;
	keyLimitRemainingUsd?: number;
	budget?: OpenRouterBudget;
}

export type EntryDollars = WindowDollars | BudgetDollars | BalanceDollars;

const money = (value: number): number => Math.round(value * 100) / 100;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function impliedLimitUsd(spentUsd: number, pctUsed: number): number | undefined {
	if (!finite(spentUsd) || !finite(pctUsed) || spentUsd <= 0 || pctUsed < MIN_PCT_FOR_IMPLIED) return undefined;
	return money(spentUsd / (pctUsed / 100));
}

const remainingOf = (limitUsd: number, pctUsed: number): number => money(Math.max(0, limitUsd * (100 - pctUsed) / 100));

function tokenfoldWindow(provider: string, entry: LimitEntry, inputs: DollarInputs): TokenfoldWindow | undefined {
	// Tokenfold's windows are the personal Claude account's, across all models.
	if (provider !== "anthropic" || entry.modelFamily || !inputs.tokenfold) return undefined;
	if (entry.windowSeconds === FIVE_HOURS_S) return inputs.tokenfold.fiveHour;
	if (entry.windowSeconds === SEVEN_DAYS_S) return inputs.tokenfold.weekly;
	return undefined;
}

function fromTokenfold(window: TokenfoldWindow, pct: number, tokenfold: TokenfoldSnapshot, now: number): WindowDollars {
	const limitUsd = window.impliedLimitUsd ?? impliedLimitUsd(window.spendUsd, window.pctUsed);
	const ageFrom = tokenfold.updatedAtMs ?? tokenfold.fetchedAtMs;
	return {
		basis: "implied",
		source: "tokenfold",
		scope: "all personal machines",
		spentUsd: money(window.spendUsd),
		...(limitUsd !== undefined ? { limitUsd, remainingUsd: remainingOf(limitUsd, pct) } : {}),
		dataAgeSeconds: Math.max(0, Math.round((now - ageFrom) / 1000)),
		...(limitUsd === undefined ? { note: `Under ${MIN_PCT_FOR_IMPLIED}% used: too little to size the window.` } : {}),
	};
}

function fromLocal(provider: string, entry: LimitEntry, inputs: DollarInputs, mismatch: boolean): WindowDollars | undefined {
	const { windowSeconds, resetMs, usedPct } = entry;
	if (!inputs.spend || !finite(windowSeconds) || !finite(resetMs) || !finite(usedPct)) return undefined;
	const query: SpendQuery = {
		provider, sinceMs: resetMs - windowSeconds * 1000, untilMs: inputs.now,
		...(entry.modelFamily ? { family: entry.modelFamily } : {}),
	};
	const spentUsd = money(inputs.spend(query));
	const limitUsd = impliedLimitUsd(spentUsd, usedPct);
	const notes = [
		mismatch ? "Tokenfold reports another window cycle, so this uses local spend." : "",
		limitUsd === undefined
			? `Under ${MIN_PCT_FOR_IMPLIED}% used or no spend here: too little to size the window.`
			: "Counts spend on this machine only; use on other machines makes the limit read low.",
	].filter(Boolean);
	return {
		basis: "implied",
		source: "local",
		scope: "this machine",
		spentUsd,
		...(limitUsd !== undefined ? { limitUsd, remainingUsd: remainingOf(limitUsd, usedPct) } : {}),
		note: notes.join(" "),
	};
}

function openCodeGoDollars(entry: LimitEntry, inputs: DollarInputs): WindowDollars | undefined {
	const share = OPENCODE_GO_WINDOW_SHARE[entry.key ?? ""];
	const config = inputs.openCodeGo;
	if (share === undefined || !config || !finite(entry.usedPct)) return undefined;
	const perModel: Record<string, ModelDollars> = {};
	const unknown: string[] = [];
	for (const model of config.models) {
		const monthly = openCodeGoMonthlyCap(model, config.plan, config.caps);
		if (monthly === undefined) {
			unknown.push(model);
			continue;
		}
		const limitUsd = money(monthly * share);
		perModel[model] = { limitUsd, remainingUsd: remainingOf(limitUsd, entry.usedPct) };
	}
	if (Object.keys(perModel).length === 0 && unknown.length === 0) return undefined;
	return {
		basis: "plan cap",
		source: "plan table",
		perModel,
		...(unknown.length ? { note: `No published cap for: ${unknown.join(", ")}.` } : {}),
	};
}

function windowDollars(provider: string, entry: LimitEntry, inputs: DollarInputs): WindowDollars | undefined {
	if (!finite(entry.usedPct)) return undefined;
	if (provider === "opencode-go") return openCodeGoDollars(entry, inputs);
	const window = tokenfoldWindow(provider, entry, inputs);
	const matches = !!window && finite(entry.resetMs) && Math.abs(window.resetsAtMs - entry.resetMs) <= TOKENFOLD_RESET_TOLERANCE_MS;
	if (window && matches) return fromTokenfold(window, entry.usedPct, inputs.tokenfold!, inputs.now);
	return fromLocal(provider, entry, inputs, !!window);
}

function isBusinessDay(epochMs: number, timeZone: string): boolean {
	const weekday = new Date(`${localDateKey(epochMs, timeZone)}T00:00:00Z`).getUTCDay();
	return weekday !== 0 && weekday !== 6;
}

function budgetDollars(provider: string, entry: LimitEntry, inputs: DollarInputs): BudgetDollars | undefined {
	const { usedUsd, limitUsd } = entry;
	if (!finite(usedUsd) || !finite(limitUsd) || limitUsd <= 0) return undefined;
	const { now, timeZone } = inputs;
	const resetMs = finite(entry.resetMs) ? entry.resetMs : nextUtcMonthStartMs(now);
	const remainingUsd = money(Math.max(0, limitUsd - usedUsd));
	const businessDays = businessDaysLeft(now, resetMs, timeZone);
	const today = inputs.meterToday?.[provider];
	const workday = isBusinessDay(now, timeZone);
	// Today's spend goes back into the pot so the share is fixed for the whole day.
	const pot = remainingUsd + (today && workday ? today.spentUsd : 0);
	const perBusinessDayUsd = businessDays > 0 ? money(pot / businessDays) : undefined;
	return {
		basis: "meter",
		source: "provider",
		limitUsd: money(limitUsd),
		spentUsd: money(usedUsd),
		remainingUsd,
		resetsAt: new Date(resetMs).toISOString(),
		resetsAtLocal: localTime(resetMs, timeZone),
		...(entry.resetApprox || !finite(entry.resetMs) ? { resetApprox: true } : {}),
		calendarDaysLeft: calendarDaysLeft(now, resetMs, timeZone),
		businessDaysLeft: businessDays,
		...(perBusinessDayUsd !== undefined ? { perBusinessDayUsd } : {}),
		...(today ? { spentTodayUsd: money(today.spentUsd), spentTodaySinceLocal: localTime(today.sinceMs, timeZone) } : {}),
		...(today && workday && perBusinessDayUsd !== undefined ? { leftTodayUsd: money(perBusinessDayUsd - today.spentUsd) } : {}),
	};
}

function balanceDollars(provider: string, entry: LimitEntry, inputs: DollarInputs): BalanceDollars | undefined {
	if (!finite(entry.balanceUsd)) return undefined;
	const key = provider === "openrouter" ? inputs.openRouterKey : undefined;
	return {
		basis: "balance",
		source: "provider",
		balanceUsd: money(entry.balanceUsd),
		...(finite(key?.usageDailyUsd) ? { spentTodayUtcUsd: money(key.usageDailyUsd) } : {}),
		...(finite(key?.limitRemainingUsd) ? { keyLimitRemainingUsd: money(key.limitRemainingUsd) } : {}),
		...(key?.effectiveBudget ? { budget: key.effectiveBudget } : {}),
	};
}

export function entryDollars(provider: string, entry: LimitEntry, inputs: DollarInputs): EntryDollars | undefined {
	const kind = entry.kind ?? (entry.usedPct !== undefined ? "window" : undefined);
	if (kind === "window") return windowDollars(provider, entry, inputs);
	if (kind === "budget") return budgetDollars(provider, entry, inputs);
	if (kind === "credits") return balanceDollars(provider, entry, inputs);
	return undefined;
}

export interface ProviderDollars {
	spentTodayUsd?: number;
	/** The tightest applicable window's remaining dollars. */
	remainingUsd?: number;
	bindingWindow?: string;
	/** OpenCode Go: the tightest window per model. */
	remainingUsdByModel?: Record<string, number>;
}

export interface DollarsSummary {
	date: string;
	timeZone: string;
	spentTodayThisMachineUsd: number;
	spentTodayAllPersonalMachinesUsd?: number;
	providers: Record<string, ProviderDollars>;
	notes: string[];
}

export interface SummaryLimit {
	provider: string;
	window: string;
	applies: boolean;
	dollars?: EntryDollars;
}

const BASE_NOTES = [
	"Spend is the API list price of the tokens used, from the model catalog, not a bill; meters and balances are the provider's own amounts.",
	"Subscription windows report percent only: their dollar size is implied by spend in the window divided by the percent used, and moves with the model mix.",
];

function tightest(provider: ProviderDollars, window: string, dollars: WindowDollars): ProviderDollars {
	if (dollars.perModel) {
		const byModel = { ...provider.remainingUsdByModel };
		for (const [model, figures] of Object.entries(dollars.perModel)) {
			byModel[model] = Math.min(byModel[model] ?? Infinity, figures.remainingUsd);
		}
		return { ...provider, remainingUsdByModel: byModel };
	}
	if (!finite(dollars.remainingUsd)) return provider;
	if (finite(provider.remainingUsd) && provider.remainingUsd <= dollars.remainingUsd) return provider;
	return { ...provider, remainingUsd: dollars.remainingUsd, bindingWindow: window };
}

/**
 * Model-scoped windows (7d-fable) bind only their family, so they stay out of
 * a provider's summary unless they govern the active model. OpenCode Go
 * windows bind every model, active or not.
 */
export function dollarsSummary(limits: readonly SummaryLimit[], inputs: DollarInputs): DollarsSummary {
	const providers: Record<string, ProviderDollars> = {};
	for (const [provider, usd] of Object.entries(inputs.today?.byProvider ?? {})) {
		if (usd > 0) providers[provider] = { spentTodayUsd: money(usd) };
	}
	for (const limit of limits) {
		const dollars = limit.dollars;
		if (!dollars || dollars.basis === "meter" || dollars.basis === "balance") continue;
		if (!limit.applies && !dollars.perModel && limits.some((other) => other.provider === limit.provider && other.applies)) continue;
		providers[limit.provider] = tightest(providers[limit.provider] ?? {}, limit.window, dollars);
	}
	const thisMachine = Object.values(inputs.today?.byProvider ?? {}).reduce((total, usd) => total + usd, 0);
	return {
		date: localDateKey(inputs.now, inputs.timeZone),
		timeZone: inputs.timeZone,
		spentTodayThisMachineUsd: money(thisMachine),
		...(finite(inputs.tokenfold?.costTodayUsd) ? { spentTodayAllPersonalMachinesUsd: money(inputs.tokenfold.costTodayUsd) } : {}),
		providers,
		notes: [...BASE_NOTES],
	};
}

/** Local midnight, for the collector's "today" queries. */
export const todayStartMs = (inputs: Pick<DollarInputs, "now" | "timeZone">): number => localDayStartMs(inputs.now, inputs.timeZone);
