import { formatMetrics, type MetricsSummary } from "./phase-metrics.ts";

export type PhaseAlertTone = "phase" | "warning" | "error";

export interface PhaseBorderModel {
	spinner: string;
	phaseElapsedMs: number;
	totalElapsedMs: number;
	label: string;
	detail?: string;
	tone: PhaseAlertTone;
	hiddenLineCount?: number;
	metrics?: MetricsSummary;
}

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
const MAX_TOOL_GROUPS = 2;
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
	return { label: "Starting response", tone: "phase" };
}

function cleanInline(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
}

export interface StatusMessage {
	label: string;
	detail?: string;
	attempt?: string;
}

/**
 * Splits Pi's status text ("Retrying (2/3) in 4s... (Esc to cancel)") into the
 * phase border's label and dim detail, so Pi keeps ownership of the wording.
 */
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

export function summarizeRunningTools(toolNames: readonly string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const rawName of toolNames) {
		const name = cleanInline(rawName);
		if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	if (counts.size === 0) return undefined;
	const groups = [...counts.entries()];
	const shown = groups.slice(0, MAX_TOOL_GROUPS).map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
	const omitted = groups.slice(MAX_TOOL_GROUPS).reduce((total, [, count]) => total + count, 0);
	if (omitted > 0) shown.push(`+${omitted}`);
	return shown.join(", ");
}

function tonePainter(model: PhaseBorderModel, paint: PhaseBorderPaint): (text: string) => string {
	if (model.tone === "error") return paint.error ?? paint.warning;
	if (model.tone === "warning") return paint.warning;
	return paint.phase;
}

function leftVariants(model: PhaseBorderModel, paint: PhaseBorderPaint): string[] {
	const phasePaint = tonePainter(model, paint);
	const detail = model.detail ? cleanInline(model.detail) : undefined;
	const fullCore = `${phasePaint(model.spinner)} ${paint.dim(formatElapsed(model.phaseElapsedMs))} ${phasePaint(model.label)}`;
	const compactCore = `${phasePaint(model.spinner)} ${paint.dim(formatCompactElapsed(model.phaseElapsedMs))} ${phasePaint(model.label)}`;
	return [
		` ${fullCore}${detail ? ` ${paint.dim(detail)}` : ""} `,
		` ${fullCore} `,
		` ${compactCore} `,
		` ${phasePaint(model.spinner)} ${phasePaint(model.label)} `,
	];
}

function rightVariants(model: PhaseBorderModel, paint: PhaseBorderPaint): string[] {
	const overflow = model.hiddenLineCount && model.hiddenLineCount > 0 ? `↑ ${model.hiddenLineCount} ` : "";
	const full = ` ${overflow}Time ${formatElapsed(model.totalElapsedMs)} `;
	const compact = ` ${model.hiddenLineCount && model.hiddenLineCount > 0 ? `↑${model.hiddenLineCount} ` : ""}Σ ${formatCompactElapsed(model.totalElapsedMs)} `;
	return withMetrics([full, compact], model.metrics, paint);
}

function withMetrics(timers: readonly [string, string], metrics: MetricsSummary | undefined, paint: PhaseBorderPaint): string[] {
	const paintedTimers = timers.map((text) => paint.total(text));
	const sections = metrics ? formatMetrics(metrics) : [];
	if (sections.length === 0) return paintedTimers;
	const separator = paint.border(` ${RAIL} `);
	const prefix = paint.total(" ") + sections.map((text) => paint.total(text)).join(separator);
	// Keep the original timer-only variants as the narrow-terminal fallback.
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

export function renderPhaseBorder(model: PhaseBorderModel, width: number, paint: PhaseBorderPaint): string {
	if (width <= 0) return "";
	const left = leftVariants(model, paint);
	for (const right of rightVariants(model, paint)) {
		for (const candidate of left) {
			const line = compose(candidate, right, width, paint);
			if (line) return line;
		}
	}
	const minimalRight = paint.total(`Σ${formatCompactElapsed(model.totalElapsedMs)}`);
	const roomForLeft = Math.max(0, width - BORDER_EDGE_WIDTH - MIN_RAIL_WIDTH - paint.measure(minimalRight));
	const clippedLeft = paint.truncate(left[left.length - 1] ?? "", roomForLeft);
	return compose(clippedLeft, minimalRight, width, paint) ?? paint.border(RAIL.repeat(width));
}

export function renderLastRunBorder(
	totalElapsedMs: number,
	width: number,
	paint: PhaseBorderPaint,
	hiddenLineCount?: number,
	metrics?: MetricsSummary,
): string {
	if (width <= 0) return "";
	for (const right of lastRunVariants(totalElapsedMs, hiddenLineCount, paint, metrics)) {
		const line = compose("", right, width, paint);
		if (line) return line;
	}
	const minimalRight = paint.total(`L${formatCompactElapsed(totalElapsedMs)}`);
	return compose("", minimalRight, width, paint) ?? paint.border(RAIL.repeat(width));
}
