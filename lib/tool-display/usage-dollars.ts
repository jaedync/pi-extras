/**
 * The usage popup's dollar lines: each limit's figures under its row, and the
 * report's summary of spend today and dollars left. The model receives the
 * whole report as JSON; these lines let the user read the same figures.
 */
import { SEP } from "../cc-phase.ts";
import { formatDuration } from "../status-plus-logic.ts";
import type { BalanceDollars, BudgetDollars, DollarsSummary, EntryDollars, ProviderDollars, WindowDollars } from "../usage-dollars/core.ts";

const cents = (value: number): string => {
	const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	return value < 0 ? `-$${text}` : `$${text}`;
};

/** Whole dollars, for the band, where width is short. */
export const wholeDollars = (value: number): string => `$${Math.round(value).toLocaleString("en-US")}`;

const join = (parts: ReadonlyArray<string | false | undefined>): string => parts.filter(Boolean).join(SEP);

function sourceText(dollars: WindowDollars): string | undefined {
	if (dollars.source === "tokenfold") return `Tokenfold (${dollars.scope ?? "all personal machines"})`;
	return dollars.source === "local" ? "this machine only" : undefined;
}

function windowLines(dollars: WindowDollars): string[] {
	if (dollars.perModel) {
		const models = Object.entries(dollars.perModel).map(([model, figures]) => `${model} ${cents(figures.remainingUsd)} of ${cents(figures.limitUsd)}`);
		return [join(models), ...(dollars.note ? [dollars.note] : [])].filter(Boolean);
	}
	const size = dollars.limitUsd !== undefined && dollars.remainingUsd !== undefined
		? `${cents(dollars.remainingUsd)} left of ${cents(dollars.limitUsd)}` : undefined;
	const main = join([
		size,
		dollars.spentUsd !== undefined && `${cents(dollars.spentUsd)} spent`,
		sourceText(dollars),
		dollars.dataAgeSeconds !== undefined && `${formatDuration(dollars.dataAgeSeconds * 1000, true)} old`,
		dollars.sizeFrom && "size from an earlier window",
	]);
	return [main, ...(dollars.note ? [dollars.note] : [])].filter(Boolean);
}

function meterLines(dollars: BudgetDollars): string[] {
	return [
		join([`${cents(dollars.remainingUsd)} left of ${cents(dollars.limitUsd)}`, `resets ${dollars.resetsAtLocal}${dollars.resetApprox ? " (approximate)" : ""}`]),
		join([
			`${dollars.businessDaysLeft} business days left`,
			dollars.perBusinessDayUsd !== undefined && `${cents(dollars.perBusinessDayUsd)} per business day`,
			dollars.spentTodayUsd !== undefined && `${cents(dollars.spentTodayUsd)} spent today`,
			dollars.leftTodayUsd !== undefined && `${cents(dollars.leftTodayUsd)} left today`,
		]),
	];
}

function balanceLines(dollars: BalanceDollars): string[] {
	const budget = dollars.budget;
	return [join([
		`${cents(dollars.balanceUsd)} balance`,
		dollars.spentTodayUtcUsd !== undefined && `${cents(dollars.spentTodayUtcUsd)} spent today (UTC)`,
		dollars.keyLimitRemainingUsd !== undefined && `key limit ${cents(dollars.keyLimitRemainingUsd)} left`,
		budget && `budget ${cents(budget.remainingUsd)} left of ${cents(budget.limitUsd)}${budget.resetInterval ? ` (${budget.resetInterval})` : ""}`,
	])];
}

/** Plain lines for one limit's dollars; the caller indents and paints them. */
export function limitDollarLines(dollars: EntryDollars | undefined): string[] {
	if (!dollars) return [];
	if (dollars.basis === "meter") return meterLines(dollars);
	if (dollars.basis === "balance") return balanceLines(dollars);
	return windowLines(dollars);
}

function providerLine(provider: string, figures: ProviderDollars): string {
	const models = Object.entries(figures.remainingUsdByModel ?? {}).map(([model, usd]) => `${model} ${cents(usd)} left`);
	return `${provider}: ${join([
		figures.spentTodayUsd !== undefined && `${cents(figures.spentTodayUsd)} today`,
		figures.remainingUsd !== undefined && `${cents(figures.remainingUsd)} left (${figures.bindingWindow ?? "tightest window"})`,
		...models,
		(figures.unsizedWindows?.length ?? 0) > 0 && `no size yet: ${figures.unsizedWindows!.join(" ")}`,
	]) || "no figures"}`;
}

/** The summary block: a heading, today's spend, then one line per provider. */
export function summaryLines(summary: DollarsSummary): { heading: string; lines: string[] } {
	const today = join([
		`${cents(summary.spentTodayThisMachineUsd)} on this machine`,
		summary.spentTodayAllPersonalMachinesUsd !== undefined && `${cents(summary.spentTodayAllPersonalMachinesUsd)} on all personal machines`,
	]);
	return {
		heading: `Dollars, ${summary.date} (${summary.timeZone})`,
		lines: [`today: ${today}`, ...Object.entries(summary.providers).map(([provider, figures]) => providerLine(provider, figures))],
	};
}
