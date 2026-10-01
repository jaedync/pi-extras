import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatElapsed } from "./phase-status.ts";
import { formatMetrics, type MetricsSummary } from "./phase-metrics.ts";

export interface StatusDivider {
	readonly status: string;
	readonly withoutTokens: string;
	readonly elapsedMs: number;
	readonly metrics?: MetricsSummary;
	readonly hiddenLineCount?: number;
}

export interface DividerPaint {
	border(text: string): string;
	total(text: string): string;
}

/** Preserve the left status first. Metrics retire in TPS, TTFT, tokens order. */
export function renderStatusDivider(model: StatusDivider, width: number, paint: DividerPaint): string {
	if (width <= 0) return "";
	const metrics = model.metrics ? formatMetrics(model.metrics) : [];
	const tps = metrics.find(part => part.startsWith("TPS"));
	const ttft = metrics.find(part => part.startsWith("TTFT"));
	const overflow = model.hiddenLineCount ? `↑ ${model.hiddenLineCount} ` : "";
	const time = `${overflow}Time ${formatElapsed(model.elapsedMs)}`;
	const choices = [
		[model.status, [tps, ttft, time]],
		[model.status, [ttft, time]],
		[model.status, [time]],
		[model.withoutTokens, [time]],
		[model.withoutTokens, []],
	] as const;
	for (const [status, sections] of choices) {
		const right = sections.flatMap(part => part ? [paint.total(part)] : []).join(paint.border(" ─ "));
		const left = paint.border("─ ") + status;
		const space = width - visibleWidth(left) - (right ? visibleWidth(right) + 4 : 1);
		if (space < 1) continue;
		return left + paint.border(" " + "─".repeat(space)) + (right ? " " + right + paint.border(" ─") : "");
	}
	return truncateToWidth(paint.border("─ ") + model.withoutTokens, width, "");
}
