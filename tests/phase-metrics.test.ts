import assert from "node:assert/strict";
import test from "node:test";
import { formatMetrics, emptyRunMetrics, updateRunMetrics, type RunMetrics, type MetricsEvent } from "../lib/phase-metrics.ts";

function apply(events: readonly MetricsEvent[], initial = emptyRunMetrics()): RunMetrics {
	return events.reduce(updateRunMetrics, initial);
}
const start: MetricsEvent = { type: "start" };
const request = (at: number): MetricsEvent => ({ type: "request", at });
const delta = (at: number, kind = "text_delta", text = "x"): MetricsEvent => ({ type: "delta", at, kind, delta: text });
const end: MetricsEvent = { type: "end", at: 10000, stopReason: "stop" };
const finish = (at: number, output = 100, stopReason = "stop"): MetricsEvent => ({ type: "end", at, output, stopReason });

test("collapses TTFT values that match at displayed precision", () => {
	for (const [min, max] of [[2600, 2600], [2601, 2640]]) {
		assert.deepEqual(formatMetrics({ ttftMinMs: min, ttftMaxMs: max }), ["TTFT 2.6s"]);
	}
	assert.deepEqual(formatMetrics({ ttftMinMs: 2601, ttftMaxMs: 2700 }), ["TTFT 2.6–2.7s"]);
	assert.deepEqual(formatMetrics(emptyRunMetrics()), []);
});

test("whole-request throughput includes TTFT and is independent of buffered chunk arrival", () => {
	for (const firstAt of [100, 2600, 3199]) {
		const result = apply([start, request(0), delta(firstAt), finish(3200, 18)]);
		assert.deepEqual(result.throughput, { outputTokens: 18, requestMs: 3200 });
		assert.equal(formatMetrics(result)[0], "TPS 5.6");
	}
});

test("sums tokens and request durations, excludes tool gaps and does not double count", () => {
	const first = apply([start, request(0), delta(500), finish(2000, 100)]);
	const result = apply([start, request(20000), delta(22400), finish(24000, 100, "toolUse"), finish(25000, 100)], first);
	assert.deepEqual(result.throughput, { outputTokens: 200, requestMs: 6000 });
	assert.deepEqual(formatMetrics(result), ["TPS 33.3", "TTFT 0.5–2.4s"]);
	assert.deepEqual(first.throughput, { outputTokens: 100, requestMs: 2000 });
	const settled = apply([{ type: "settle" }], result);
	assert.deepEqual(settled.throughput, result.throughput);
	assert.equal(apply([start], settled).throughput, undefined);
});

test("omits invalid, missing, failed and untimed samples without diluting valid totals", () => {
	const baseline = apply([start, request(0), finish(1000, 50)]);
	for (const output of [undefined, 0, -1, NaN, Infinity]) {
		assert.deepEqual(apply([request(2000), { type: "end", at: 3000, output, stopReason: "stop" }], baseline).throughput, baseline.throughput);
	}
	for (const reason of ["error", "aborted", "pending", "deferred"]) {
		assert.deepEqual(apply([request(2000), finish(3000, 100, reason)], baseline).throughput, baseline.throughput);
	}
	for (const at of [0, -1, NaN, Infinity]) {
		assert.equal(apply([start, request(0), finish(at)]).throughput, undefined);
	}
	assert.equal(apply([start, finish(1000)]).throughput, undefined);
	assert.equal(apply([start, request(0), delta(2000), finish(1000)]).throughput, undefined);
	assert.deepEqual(apply([start, request(0), finish(1000, 10, "length")]).throughput, { outputTokens: 10, requestMs: 1000 });
});

test("renders validated throughput totals and ignores legacy decode fields", () => {
	assert.deepEqual(formatMetrics({ throughput: { outputTokens: 200, requestMs: 3000 } }), ["TPS 66.7"]);
	assert.deepEqual(formatMetrics({ ...emptyRunMetrics(), outputTokens: 200, decodeMs: 1 } as RunMetrics), []);
	for (const bad of [0, -1, NaN, Infinity]) {
		assert.deepEqual(formatMetrics({ throughput: { outputTokens: bad, requestMs: 1000 } }), []);
		assert.deepEqual(formatMetrics({ throughput: { outputTokens: 100, requestMs: bad } }), []);
	}
});

test("aggregates TTFT across requests, including thinking and tool-call deltas", () => {
	const result = apply([start, request(0), delta(800), delta(2800), end,
		request(20000), delta(22400, "thinking_delta"), delta(23400, "toolcall_delta"), end]);
	assert.equal(result.ttftMinMs, 800);
	assert.equal(result.ttftMaxMs, 2400);
	assert.equal(result.throughput, undefined);
});

test("starts TTFT at request and ignores metadata and empty deltas", () => {
	const result = apply([start, request(100), delta(200, "text_start"), delta(300, "thinking_delta", ""),
		delta(500), delta(1500), delta(9000, "text_end"), end]);
	assert.equal(result.ttftMinMs, 400);
	assert.equal(result.ttftMaxMs, 400);
});

test("retains aggregate through continuation starts, settles, then resets for next run", () => {
	const first = apply([start, request(0), delta(100), end]);
	const resumed = apply([start, request(2000), delta(2200), end], first);
	assert.equal(resumed.ttftMaxMs, 200);
	const settled = apply([{ type: "settle" }], resumed);
	assert.equal(settled.ttftMaxMs, 200);
	assert.equal(settled.active, false);
	assert.deepEqual(apply([start], settled), { ...emptyRunMetrics(), active: true });
	assert.deepEqual(apply([{ type: "reset" }], resumed), emptyRunMetrics());
	assert.equal(first.ttftMaxMs, 100, "previous state stays immutable");
});

test("message end clears unfinished request and ignores subsequent deltas", () => {
	const result = apply([start, request(0), end, delta(100), end]);
	assert.equal(result.request, undefined);
	assert.equal(result.ttftMinMs, undefined);
});

test("new request discards unfinished sample; out-of-run and untimed streams are ignored", () => {
	assert.deepEqual(apply([request(0), delta(100), end]), emptyRunMetrics());
	assert.equal(apply([start, delta(100), delta(1100), end]).ttftMinMs, undefined);
	const result = apply([start, request(0), delta(100), request(5000), delta(5300), finish(6000, 50)]);
	assert.equal(result.ttftMaxMs, 300);
	assert.deepEqual(result.throughput, { outputTokens: 50, requestMs: 1000 });
});

test("rejects nonfinite and backwards timestamps", () => {
	const result = apply([start, request(NaN), delta(100), request(1000), delta(900), delta(Infinity), delta(1100), delta(1050), end]);
	assert.equal(result.ttftMinMs, 100);
	assert.equal(result.ttftMaxMs, 100);
});
