import assert from "node:assert/strict";
import test from "node:test";
import { stripAnsi } from "../lib/ansi.ts";
import {
	formatElapsed,
	phaseAfterFirstTokenWait,
	renderLastRunBorder,
	renderPhaseBorder,
	summarizeRunningTools,
	type PhaseBorderModel,
} from "../lib/phase-status.ts";

function cellWidth(char: string): number {
	if (/\p{Mark}/u.test(char)) return 0;
	if (/\p{Extended_Pictographic}/u.test(char) || /[\u3000-\u9fff\uf900-\ufaff]/u.test(char)) return 2;
	return 1;
}

function visibleWidth(text: string): number {
	return [...stripAnsi(text)].reduce((width, char) => width + cellWidth(char), 0);
}

function truncateToWidth(text: string, width: number, marker = ""): string {
	if (visibleWidth(text) <= width) return text;
	const limit = Math.max(0, width - visibleWidth(marker));
	let result = "";
	let used = 0;
	for (const char of stripAnsi(text)) {
		const nextWidth = cellWidth(char);
		if (used + nextWidth > limit) break;
		result += char;
		used += nextWidth;
	}
	return result + marker;
}

const identityPaint = {
	border: (text: string) => text,
	phase: (text: string) => text,
	dim: (text: string) => text,
	total: (text: string) => text,
	warning: (text: string) => text,
	measure: visibleWidth,
	truncate: (text: string, width: number) => truncateToWidth(text, width, ""),
};

function model(overrides: Partial<PhaseBorderModel> = {}): PhaseBorderModel {
	return {
		spinner: "⠹",
		phaseElapsedMs: 12_400,
		totalElapsedMs: 227_800,
		label: "Run",
		detail: "bash ×2, edit",
		tone: "phase",
		...overrides,
	};
}

const metrics = { ttftMinMs: 800, ttftMaxMs: 2400, throughput: { outputTokens: 200, requestMs: 3000 } };

test("orders TPS then TTFT with separators painted exactly like the border rail", () => {
	const paint = {
		...identityPaint,
		border: (text: string) => `\x1b[35m${text}\x1b[0m`,
		dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
	};
	const live = renderPhaseBorder(model({ metrics }), 120, paint);
	const last = renderLastRunBorder(227800, 120, paint, 7, metrics);
	for (const line of [live, last]) {
		assert.equal(visibleWidth(line), 120);
		assert.match(stripAnsi(line), /TPS 66\.7 ─ TTFT 0\.8–2\.4s ─ /);
		assert.equal(line.split(paint.border(" ─ ")).length - 1, 2);
		assert.ok(line.startsWith(paint.border("─")));
		assert.doesNotMatch(line, /•/);
	}
	assert.match(stripAnsi(last), /↑ 7 Last 03:47\.8 ─$/);
});

test("metrics fall back to timer-only on narrow terminals without overflowing", () => {
	for (let width = 0; width <= 160; width++) {
		assert.equal(visibleWidth(renderPhaseBorder(model({ metrics }), width, identityPaint)), width);
		assert.equal(visibleWidth(renderLastRunBorder(227800, width, identityPaint, 7, metrics)), width);
	}
	const line = renderPhaseBorder(model({ metrics }), 34, identityPaint);
	assert.doesNotMatch(line, /TTFT|TPS/);
	assert.match(line, /Time 03:47\.8/);
});

test("omits unavailable sections and their separators in live and last borders", () => {
	for (const summary of [
		{},
		{ ttftMinMs: 2601, ttftMaxMs: 2640 },
		{ throughput: { outputTokens: 37, requestMs: 1000 } },
	]) {
		for (const line of [
			renderPhaseBorder(model({ metrics: summary }), 120, identityPaint),
			renderLastRunBorder(3200, 120, identityPaint, undefined, summary),
		]) {
			assert.equal(visibleWidth(line), 120);
			assert.doesNotMatch(line, /n\/a/i);
			if ("ttftMinMs" in summary) {
				assert.match(line, /TTFT 2\.6s ─ (Time|Last)/);
				assert.doesNotMatch(line, /TPS/);
			} else if ("throughput" in summary) {
				assert.match(line, /TPS 37\.0 ─ (Time|Last)/);
				assert.doesNotMatch(line, /TTFT/);
			} else {
				assert.doesNotMatch(line, /TTFT|TPS|•/);
			}
		}
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
	assert.deepEqual(phaseAfterFirstTokenWait(0), { label: "Starting response", tone: "phase" });
	assert.deepEqual(phaseAfterFirstTokenWait(29_999), { label: "Starting response", tone: "phase" });
	assert.deepEqual(phaseAfterFirstTokenWait(30_000), { label: "Slow response", tone: "warning" });
	assert.deepEqual(phaseAfterFirstTokenWait(120_000), { label: "Stalled", tone: "error" });
});

test("summarizes parallel tools with counts and bounded detail", () => {
	assert.equal(summarizeRunningTools(["bash", "bash", "edit"]), "bash ×2, edit");
	assert.equal(summarizeRunningTools(["bash", "edit", "read", "write"]), "bash, edit, +2");
	assert.equal(summarizeRunningTools([]), undefined);
});

test("fills the unused border and right-aligns the total timer", () => {
	const line = renderPhaseBorder(model(), 80, identityPaint);
	assert.equal(visibleWidth(line), 80);
	assert.match(line, /^─ ⠹ 00:12\.4 Run bash ×2, edit ─+/);
	assert.match(line, /Time 03:47\.8 ─$/);
});

test("preserves the total timer and rail on narrow terminals", () => {
	const line = renderPhaseBorder(model(), 34, identityPaint);
	assert.equal(visibleWidth(line), 34);
	assert.match(line, /─+/);
	assert.match(line, /03:47\.8 ─$/);
	assert.doesNotMatch(line, /bash/);
});

test("renders the total timer with more contrast than dim details", () => {
	const line = renderPhaseBorder(model(), 80, {
		...identityPaint,
		dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
		total: (text: string) => `\x1b[1m${text}\x1b[22m`,
	});
	assert.match(line, /\x1b\[1m Time 03:47\.8 \x1b\[22m/);
});

test("keeps exact terminal width with ANSI-colored segments", () => {
	const ansi = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
	const line = renderPhaseBorder(model({ tone: "warning" }), 72, {
		...identityPaint,
		border: ansi(90),
		phase: ansi(36),
		dim: ansi(90),
		warning: ansi(33),
		error: ansi(31),
	});
	assert.equal(visibleWidth(line), 72);
	assert.match(stripAnsi(line), /Slow response|Run/);
	assert.match(stripAnsi(line), /Time 03:47\.8 ─$/);
});

test("uses terminal cells for CJK, emoji, and combining marks", () => {
	const line = renderPhaseBorder(model({ detail: "工具, 🙂, e\u0301" }), 64, identityPaint);
	assert.equal(visibleWidth(line), 64);
	assert.match(line, /Time 03:47\.8 ─$/);
});

test("adds editor overflow before the anchored total when it fits", () => {
	const line = renderPhaseBorder(model({ hiddenLineCount: 7 }), 80, identityPaint);
	assert.equal(visibleWidth(line), 80);
	assert.match(line, /↑ 7 Time 03:47\.8 ─$/);
});

test("persists the completed run time in an idle native border", () => {
	const line = renderLastRunBorder(42_700, 64, identityPaint);
	assert.equal(visibleWidth(line), 64);
	assert.match(line, /^─+/);
	assert.match(line, / Last 00:42\.7 ─$/);
});

test("keeps an expanding day count right-aligned", () => {
	const line = renderLastRunBorder(106_635_967_800, 64, identityPaint);
	assert.equal(visibleWidth(line), 64);
	assert.match(line, / Last 1234d 05:06:07\.8 ─$/);
});

test("keeps editor overflow beside the completed run time", () => {
	const line = renderLastRunBorder(42_700, 48, identityPaint, 7);
	assert.equal(visibleWidth(line), 48);
	assert.match(line, /↑ 7 Last 00:42\.7 ─$/);
});
