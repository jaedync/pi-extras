/**
 * The usage row. The band carries the answer: each window that governs the
 * model with how much of it is used, the dollars left, and the session budget
 * when the call set one. The popup lists every limit with when it resets and
 * its dollars, then the dollar summary, and copies the JSON the model got.
 */
import { plainText, UNWRAPPED } from "../band/popup.ts";
import { SEP } from "../cc-phase.ts";
import type { Seg } from "../band/band.ts";
import type { UsageReport, UsageReportLimit } from "../usage-guard-core.ts";
import { paceText } from "../usage-pace.ts";
import { sanitize } from "./format.ts";
import { limitDollarLines, summaryLines, wholeDollars } from "./usage-dollars.ts";
import { errorLines, mutedSeg, resultText, titleSeg, wrapAll, type PaintKey } from "./kit.ts";
import type { ToolSpec, View } from "./tool.ts";

/** Used share from which a window reads as close to its limit. */
export const USAGE_WARN_PCT = 80;

const flat = (text: string) => sanitize(text).replace(/\s+/g, " ").trim();
const failed = (view: View) => !view.context.isPartial && view.context.isError;

function reportOf(view: View): UsageReport | undefined {
	if (!view.result || view.context.isPartial || failed(view)) return undefined;
	const details = view.result.details as Partial<UsageReport> | undefined;
	return details && Array.isArray(details.limits) ? (details as UsageReport) : undefined;
}

function tone(limit: UsageReportLimit): PaintKey {
	if (limit.status === "exhausted") return "error";
	return (limit.usedPct ?? 0) >= USAGE_WARN_PCT ? "warning" : "toolOutput";
}

const pct = (value: number) => `${Math.round(value)}%`;

function budgetSegs(view: View, report: UsageReport | undefined): Seg[] {
	const args = (view.context.args ?? {}) as { setBudget?: { window?: unknown; pct?: unknown }; clearBudget?: unknown };
	if (args.clearBudget === true) return [mutedSeg(`${SEP}budget cleared`)];
	const budget = report?.budget ?? (typeof args.setBudget?.window === "string" && typeof args.setBudget.pct === "number" ? { window: args.setBudget.window, pct: args.setBudget.pct } : null);
	return args.setBudget && budget ? [mutedSeg(`${SEP}budget ${flat(budget.window)} at ${pct(budget.pct)}`)] : [];
}

function dollarsLeftSegs(report: UsageReport | undefined): Seg[] {
	const left = report?.model.provider ? report.dollars?.providers[report.model.provider]?.remainingUsd : undefined;
	return left !== undefined ? [mutedSeg(`${SEP}${wholeDollars(left)} left`)] : [];
}

/** With several providers in one report, "5h" alone could be any of them. */
function rowLabel(limit: UsageReportLimit, named: boolean): string {
	return flat(named ? `${limit.provider} ${limit.window}` : limit.window).trim();
}

function resetText(limit: UsageReportLimit): string {
	const seconds = limit.reset?.resetsInSeconds;
	if (seconds === undefined) return "";
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const within = hours >= 48 ? `${Math.round(hours / 24)}d` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
	return `resets in ${within}${limit.reset?.resetsAtLocal ? ` (${flat(limit.reset.resetsAtLocal)})` : ""}`;
}

export const usageSpec: ToolSpec = {
	name: "usage",
	label: () => "usage",
	title(view) {
		const report = reportOf(view);
		const windows = (report?.limits ?? []).filter((limit) => limit.applies && limit.usedPct !== undefined);
		return [
			titleSeg("usage"),
			...windows.map((limit): Seg => ({ text: ` ${flat(limit.window)} ${pct(limit.usedPct!)}${limit.pace ? ` (${flat(limit.pace.state)})` : ""}`, color: tone(limit) })),
			...dollarsLeftSegs(report),
			...budgetSegs(view, report),
		];
	},
	body(view, width) {
		if (failed(view)) return wrapAll(errorLines(view.paint, resultText(view.result)), width);
		return wrapAll((reportOf(view)?.notes ?? []).map((note) => view.paint.fg("muted", flat(note))), width);
	},
	details(view) {
		const model = reportOf(view)?.model;
		return model?.provider ? [model.provider, model.id].filter(Boolean).join(SEP) : "";
	},
	outputLabel: () => "limits",
	output(view, width) {
		if (failed(view)) return wrapAll(errorLines(view.paint, resultText(view.result)), width);
		const report = reportOf(view);
		if (!report) return [view.paint.fg("dim", view.context.isPartial ? "(reading…)" : "(no report)")];
		const named = new Set(report.limits.map((limit) => limit.provider)).size > 1;
		const labelWidth = Math.max(0, ...report.limits.map((limit) => rowLabel(limit, named).length));
		// Dollar lines start under the note column: label, two spaces, the percent, two spaces.
		const indent = " ".repeat(labelWidth + 8);
		const rows = report.limits.flatMap((limit) => {
			const used = limit.usedPct !== undefined ? pct(limit.usedPct).padStart(4) : (limit.remaining ? flat(limit.remaining) : "").padStart(4);
			const note = [limit.applies ? "" : "other model", limit.budgetPct !== undefined ? `budget ${pct(limit.budgetPct)}` : "", resetText(limit), paceText(limit.pace, limit.reset?.resetsInSeconds)].filter(Boolean).join(SEP);
			const head = `${view.paint.fg("toolOutput", rowLabel(limit, named).padEnd(labelWidth))}  ${view.paint.fg(tone(limit), used)}  ${view.paint.fg("muted", note)}`;
			return [head, ...limitDollarLines(limit.dollars).map((line) => `${indent}${view.paint.fg("dim", flat(line))}`)];
		});
		const summary = report.dollars ? summaryLines(report.dollars) : undefined;
		const summaryBlock = summary ? ["", view.paint.fg("toolOutput", flat(summary.heading)), ...summary.lines.map((line) => view.paint.fg("muted", flat(line)))] : [];
		const notes = [...report.notes, ...(report.dollars?.notes ?? [])].map((note) => view.paint.fg("muted", flat(note)));
		return wrapAll([...rows, ...summaryBlock, ...(notes.length > 0 ? ["", ...notes] : [])], width);
	},
	copies(view) {
		return [
			{ label: "copy output", key: "o", text: () => plainText(usageSpec.output(view, UNWRAPPED, 0)) || undefined },
			{ label: "copy JSON", key: "j", text: () => resultText(view.result) || undefined },
		];
	},
};
