import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatElapsed, parseStatusMessage, phaseAfterFirstTokenWait, renderLastRunBorder } from "../lib/phase-status.ts";

const identityPaint = {
	border: (text: string) => text,
	phase: (text: string) => text,
	dim: (text: string) => text,
	total: (text: string) => text,
	warning: (text: string) => text,
	measure: visibleWidth,
	truncate: (text: string, width: number) => truncateToWidth(text, width, ""),
};
const metrics = { ttftMinMs: 800, ttftMaxMs: 2400, throughput: { outputTokens: 200, requestMs: 3000 } };

test("last-run metrics order TPS then TTFT with separators painted like the rail", () => {
	const paint = { ...identityPaint, border: (text: string) => `\x1b[35m${text}\x1b[0m` };
	const row = renderLastRunBorder(227800, 120, paint, 7, metrics);
	assert.equal(visibleWidth(row), 120);
	assert.match(stripTerminalSequences(row), /TPS 66\.7 ─ TTFT 0\.8–2\.4s ─ ↑ 7 Last 03:47\.8 ─$/);
	assert.equal(row.split(paint.border(" ─ ")).length - 1, 2);
	assert.ok(row.startsWith(paint.border("─")));
});
test("last-run metrics fall back to timer-only without overflowing", () => {
	for (let width = 0; width <= 160; width++) {
		assert.equal(visibleWidth(renderLastRunBorder(227800, width, identityPaint, 7, metrics)), width);
	}
	const row = renderLastRunBorder(227800, 34, identityPaint, undefined, metrics);
	assert.doesNotMatch(row, /TTFT|TPS/);
	assert.match(row, /Last 03:47\.8/);
});
test("last-run borders omit unavailable sections and their separators", () => {
	for (const summary of [{}, { ttftMinMs: 2601, ttftMaxMs: 2640 }, { throughput: { outputTokens: 37, requestMs: 1000 } }]) {
		const row = renderLastRunBorder(3200, 120, identityPaint, undefined, summary);
		assert.equal(visibleWidth(row), 120);
		assert.doesNotMatch(row, /n\/a/i);
		if ("ttftMinMs" in summary) {
			assert.match(row, /TTFT 2\.6s ─ Last/);
			assert.doesNotMatch(row, /TPS/);
		} else if ("throughput" in summary) {
			assert.match(row, /TPS 37\.0 ─ Last/);
			assert.doesNotMatch(row, /TTFT/);
		} else assert.doesNotMatch(row, /TTFT|TPS|•/);
	}
});
test("formats elapsed time without capping long turns", () => {
	assert.equal(formatElapsed(0), "00:00.0");
	assert.equal(formatElapsed(599_999), "09:59.9");
	assert.equal(formatElapsed(3_599_999), "59:59.9");
	assert.equal(formatElapsed(3_600_000), "1:00:00.0");
	assert.equal(formatElapsed(86_400_000), "1d 00:00:00.0");
	assert.equal(formatElapsed(106_635_967_800), "1234d 05:06:07.8");
});
test("escalates response-start latency into useful states", () => {
	assert.deepEqual(phaseAfterFirstTokenWait(0), { label: "Waiting for first token", tone: "phase" });
	assert.deepEqual(phaseAfterFirstTokenWait(29_999), { label: "Waiting for first token", tone: "phase" });
	assert.deepEqual(phaseAfterFirstTokenWait(30_000), { label: "Slow response", tone: "warning" });
	assert.deepEqual(phaseAfterFirstTokenWait(120_000), { label: "Stalled", tone: "error" });
});
test("persists completed run time, day count and editor overflow in idle borders", () => {
	assert.match(renderLastRunBorder(42_700, 64, identityPaint), / Last 00:42\.7 ─$/);
	assert.match(renderLastRunBorder(106_635_967_800, 64, identityPaint), / Last 1234d 05:06:07\.8 ─$/);
	assert.match(renderLastRunBorder(42_700, 48, identityPaint, 7), /↑ 7 Last 00:42\.7 ─$/);
});
test("status labels strip bidi and invisible formatting", () => {
	const invisible = "\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
	assert.deepEqual(parseStatusMessage(`Com${invisible}pacting... (Esc to cancel)`), { label: "Compacting", detail: "Esc cancel" });
});
test("splits Pi status text into a label, cancel detail and retry attempt", () => {
	assert.deepEqual(parseStatusMessage("Auto-compacting... (Esc to cancel)"), { label: "Auto-compacting", detail: "Esc cancel" });
	assert.deepEqual(parseStatusMessage("Context overflow detected, Auto-compacting... (ctrl+c to cancel)"), {
		label: "Context overflow detected, Auto-compacting", detail: "ctrl+c cancel",
	});
	assert.deepEqual(parseStatusMessage(" Retrying (2/3) in 4s…\n(Esc to cancel) "), {
		label: "Retrying (2/3) in 4s", detail: "Esc cancel", attempt: "2/3",
	});
	assert.deepEqual(parseStatusMessage("Summarizing branch..."), { label: "Summarizing branch" });
	assert.deepEqual(parseStatusMessage("Retrying (1/3) in 2s... ( to cancel)"), {
		label: "Retrying (1/3) in 2s", detail: "cancel", attempt: "1/3",
	});
});
