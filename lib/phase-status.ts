import { formatMetrics, type MetricsSummary } from "./phase-metrics.ts";

export type PhaseAlertTone = "phase" | "warning" | "error";

export interface PhaseBorderPaint {
	border(text: string): string;
	phase(text: string): string;
	dim(text: string): string;
	total(text: string): string;
	warning(text: string): string;
	error?(text: string): string;
	measure(text: string): number;
	truncate(text: string, width: number): string;
}

const FIRST_TOKEN_SLOW_MS = 30_000;
const FIRST_TOKEN_STALLED_MS = 120_000;
const BORDER_EDGE_WIDTH = 2;
const MIN_RAIL_WIDTH = 1;
const RAIL = "─";

function safeElapsed(elapsedMs: number): number {
	return Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
}

export function formatElapsed(elapsedMs: number): string {
	const tenths = Math.floor(safeElapsed(elapsedMs) / 100);
	const totalSeconds = Math.floor(tenths / 10);
	const days = Math.floor(totalSeconds / 86_400);
	const totalHours = Math.floor(totalSeconds / 3_600);
	const hours = totalHours % 24;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const seconds = totalSeconds % 60;
	const fraction = tenths % 10;
	const clock = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${fraction}`;
	if (days > 0) return `${days}d ${clock}`;
	if (totalHours > 0) return `${totalHours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${fraction}`;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${fraction}`;
}

function formatCompactElapsed(elapsedMs: number): string {
	const totalSeconds = Math.floor(safeElapsed(elapsedMs) / 1_000);
	const days = Math.floor(totalSeconds / 86_400);
	const totalHours = Math.floor(totalSeconds / 3_600);
	const hours = totalHours % 24;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const seconds = totalSeconds % 60;
	const clock = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	if (days > 0) return `${days}d ${clock}`;
	if (totalHours > 0) return `${totalHours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function phaseAfterFirstTokenWait(elapsedMs: number): { label: string; tone: PhaseAlertTone } {
	if (elapsedMs >= FIRST_TOKEN_STALLED_MS) return { label: "Stalled", tone: "error" };
	if (elapsedMs >= FIRST_TOKEN_SLOW_MS) return { label: "Slow response", tone: "warning" };
	return { label: "Waiting for first token", tone: "phase" };
}

function cleanInline(text: string): string {
	return text.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
}

export interface StatusMessage {
	label: string;
	detail?: string;
	attempt?: string;
}

/** Splits Pi's status text into the divider's label and detail, preserving its wording. */
export function parseStatusMessage(text: string): StatusMessage {
	const clean = cleanInline(text);
	const hint = clean.match(/\s*\(([^()]*?)\s*to cancel\)$/);
	const body = hint ? clean.slice(0, hint.index) : clean;
	const label = body.replace(/\s*(?:\.{3}|…)$/, "").trim();
	const attempt = label.match(/\((\d+\/\d+)\)/)?.[1];
	const key = hint?.[1]?.trim();
	return {
		label,
		...(hint ? { detail: key ? `${key} cancel` : "cancel" } : {}),
		...(attempt ? { attempt } : {}),
	};
}

function withMetrics(timers: readonly [string, string], metrics: MetricsSummary | undefined, paint: PhaseBorderPaint): string[] {
	const paintedTimers = timers.map((text) => paint.total(text));
	const sections = metrics ? formatMetrics(metrics) : [];
	if (sections.length === 0) return paintedTimers;
	const separator = paint.border(` ${RAIL} `);
	const prefix = paint.total(" ") + sections.map((text) => paint.total(text)).join(separator);
	// Keep timer-only variants as the narrow-terminal fallback.
	return [prefix + separator + paint.total(timers[0].trimStart()), ...paintedTimers];
}

function lastRunVariants(totalElapsedMs: number, hiddenLineCount: number | undefined, paint: PhaseBorderPaint, metrics?: MetricsSummary): string[] {
	const overflow = hiddenLineCount && hiddenLineCount > 0 ? `↑ ${hiddenLineCount} ` : "";
	const compactOverflow = hiddenLineCount && hiddenLineCount > 0 ? `↑${hiddenLineCount} ` : "";
	return withMetrics([
		` ${overflow}Last ${formatElapsed(totalElapsedMs)} `,
		` ${compactOverflow}Last ${formatCompactElapsed(totalElapsedMs)} `,
	], metrics, paint);
}

function compose(left: string, right: string, width: number, paint: PhaseBorderPaint): string | undefined {
	const railWidth = width - BORDER_EDGE_WIDTH - paint.measure(left) - paint.measure(right);
	if (railWidth < MIN_RAIL_WIDTH) return undefined;
	return `${paint.border(RAIL)}${left}${paint.border(RAIL.repeat(railWidth))}${right}${paint.border(RAIL)}`;
}

/** A border that is all rail but for the last-run metrics at its right end. */
function timerBorder(variants: readonly string[], minimalRight: string, width: number, paint: PhaseBorderPaint): string {
	if (width <= 0) return "";
	for (const right of variants) {
		const line = compose("", right, width, paint);
		if (line) return line;
	}
	return compose("", minimalRight, width, paint) ?? paint.border(RAIL.repeat(width));
}

export function renderLastRunBorder(
	totalElapsedMs: number,
	width: number,
	paint: PhaseBorderPaint,
	hiddenLineCount?: number,
	metrics?: MetricsSummary,
): string {
	const variants = lastRunVariants(totalElapsedMs, hiddenLineCount, paint, metrics);
	return timerBorder(variants, paint.total(`L${formatCompactElapsed(totalElapsedMs)}`), width, paint);
}
