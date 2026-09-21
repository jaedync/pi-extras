/** Metrics scoped to the same start/settle span as Total. */
export interface MetricsSummary {
	readonly ttftMinMs?: number;
	readonly ttftMaxMs?: number;
	/** Whole-request throughput: includes TTFT and stream completion, not tools. */
	readonly throughput?: {
		readonly outputTokens: number;
		readonly requestMs: number;
	};
}

interface RequestSample {
	readonly startedAt: number;
	readonly firstAt?: number;
	readonly lastAt?: number;
}

export interface RunMetrics extends MetricsSummary {
	readonly active: boolean;
	readonly request?: RequestSample;
}

export type MetricsEvent =
	| { type: "start" | "settle" | "reset" }
	| { type: "request"; at: number }
	| { type: "delta"; at: number; kind: string; delta?: string }
	| { type: "end"; at: number; output?: number; stopReason: string };

const MS_PER_SECOND = 1000;
const CONTENT_DELTAS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);
const COMPLETED_REASONS = new Set(["stop", "length", "toolUse"]);

export function emptyRunMetrics(): RunMetrics {
	return { active: false };
}

function recordDelta(state: RunMetrics, event: Extract<MetricsEvent, { type: "delta" }>): RunMetrics {
	const sample = state.request;
	if (!sample || !CONTENT_DELTAS.has(event.kind) || !event.delta || !Number.isFinite(event.at)) return state;
	if (event.at < (sample.lastAt ?? sample.startedAt)) return state;
	const firstAt = sample.firstAt ?? event.at;
	const ttft = firstAt - sample.startedAt;
	return {
		...state,
		request: { ...sample, firstAt, lastAt: event.at },
		ttftMinMs: Math.min(state.ttftMinMs ?? ttft, ttft),
		ttftMaxMs: Math.max(state.ttftMaxMs ?? ttft, ttft),
	};
}

function finishRequest(state: RunMetrics, event: Extract<MetricsEvent, { type: "end" }>): RunMetrics {
	const sample = state.request;
	const cleared = { ...state, request: undefined };
	const output = event.output;
	if (!sample || !COMPLETED_REASONS.has(event.stopReason) || !Number.isFinite(event.at)) return cleared;
	const duration = event.at - sample.startedAt;
	if (duration <= 0 || event.at < (sample.lastAt ?? sample.startedAt)
		|| typeof output !== "number" || !Number.isFinite(output) || output <= 0) return cleared;
	// Use the entire request, not first-to-last chunk time. Initial buffering
	// cannot shrink this denominator. Sum matching samples, not per-call rates.
	return {
		...cleared,
		throughput: {
			outputTokens: (state.throughput?.outputTokens ?? 0) + output,
			requestMs: (state.throughput?.requestMs ?? 0) + duration,
		},
	};
}

export function updateRunMetrics(state: RunMetrics, event: MetricsEvent): RunMetrics {
	if (event.type === "reset") return emptyRunMetrics();
	if (event.type === "start") return state.active ? state : { ...emptyRunMetrics(), active: true };
	if (event.type === "settle") return { ...state, active: false, request: undefined };
	if (!state.active) return state;
	if (event.type === "request") {
		return { ...state, request: Number.isFinite(event.at) ? { startedAt: event.at } : undefined };
	}
	if (event.type === "delta") return recordDelta(state, event);
	if (event.type === "end") return finishRequest(state, event);
	return state;
}

export function formatMetrics(summary: MetricsSummary): readonly string[] {
	const { ttftMinMs: min, ttftMaxMs: max, throughput } = summary;
	const outputTokens = throughput?.outputTokens ?? 0;
	const requestMs = throughput?.requestMs ?? 0;
	const minText = min !== undefined ? (min / MS_PER_SECOND).toFixed(1) : undefined;
	const maxText = max !== undefined ? (max / MS_PER_SECOND).toFixed(1) : undefined;
	const ttft = minText !== undefined && maxText !== undefined
		? `TTFT ${minText === maxText ? minText : `${minText}–${maxText}`}s` : undefined;
	const rate = Number.isFinite(requestMs) && Number.isFinite(outputTokens) && requestMs > 0 && outputTokens > 0
		? `TPS ${(outputTokens / (requestMs / MS_PER_SECOND)).toFixed(1)}` : undefined;
	return [rate, ttft].filter((section): section is string => section !== undefined);
}
