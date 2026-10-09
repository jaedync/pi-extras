import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatElapsed } from "./phase-status.ts";
import { formatMetrics, formatTps, type MetricsSummary } from "./phase-metrics.ts";

/** Room for 999.9: a live rate changes on every frame, and TTFT and Time must stay still beside it. */
const LIVE_TPS_DIGITS = 5;

export interface StatusDivider {
	readonly status: string;
	readonly withoutTokens: string;
	readonly elapsedMs?: number;
	readonly compactStatus?: string;
	readonly metrics?: MetricsSummary;
	/** Tokens per second over the latest second; the average shows when no tokens came in it. */
	readonly liveTps?: number;
	readonly hiddenLineCount?: number;
}

export interface DividerPaint {
	border(text: string): string;
	total(text: string): string;
}

/** The step clock stays with status; retire TPS, TTFT, tokens, then total Time. */
export function renderStatusDivider(model: StatusDivider, width: number, paint: DividerPaint): string {
	if (width <= 0) return "";
	const metrics = model.metrics ? formatMetrics(model.metrics) : [];
	const tps = model.liveTps !== undefined ? formatTps(model.liveTps, LIVE_TPS_DIGITS) : metrics.find(part => part.startsWith("TPS"));
	const ttft = metrics.find(part => part.startsWith("TTFT"));
	const overflow = model.hiddenLineCount ? `↑ ${model.hiddenLineCount} ` : "";
	// An idle status has no prompt total, but the editor's hidden-line count still belongs here.
	const time = model.elapsedMs === undefined ? overflow.trim() || undefined : `${overflow}Time ${formatElapsed(model.elapsedMs)}`;
	const choices = [
		[model.status, [tps, ttft, time]],
		[model.status, [ttft, time]],
		[model.status, [time]],
		[model.withoutTokens, [time]],
		[model.withoutTokens, []],
		[model.compactStatus ?? model.withoutTokens, []],
	] as const;
	for (const [status, sections] of choices) {
		const right = sections.flatMap(part => part ? [paint.total(part)] : []).join(paint.border(" ─ "));
		const left = paint.border("─ ") + status;
		const space = width - visibleWidth(left) - (right ? visibleWidth(right) + 4 : 1);
		if (space < 1) continue;
		return left + paint.border(" " + "─".repeat(space)) + (right ? " " + right + paint.border(" ─") : "");
	}
	return truncateToWidth(paint.border("─ ") + (model.compactStatus ?? model.withoutTokens), width, "");
}
