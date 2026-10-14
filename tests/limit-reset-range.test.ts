import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexUsage } from "../lib/provider-limits.ts";
import { parseAnthropicLimits, parseCodexLimits, parseGenericLimits, parseLimitHeaders } from "../lib/status-plus-limits.ts";
import { hhmm, parseProxyQuota } from "../lib/status-plus-logic.ts";
import { resetLabel } from "../lib/status-plus-render.ts";
import { footerLayout, type FooterModel } from "../lib/status-plus-footer.ts";
import { localTime } from "../lib/usage-time.ts";

const NOW = 1_800_000_000_000;
/** Past the largest time a Date can hold (8.64e15 ms), in each unit a header could use. */
const OUT_OF_RANGE = ["1e306", "1e20", String(1.8e18), "9e15"];

test("reset headers beyond the Date range are dropped, not kept as a reset time", () => {
	for (const reset of OUT_OF_RANGE) {
		const generic = parseGenericLimits({ "x-ratelimit-limit": "100", "x-ratelimit-remaining": "3", "x-ratelimit-reset": reset });
		assert.equal(generic[0]?.resetMs, undefined, `generic ${reset}`);
		const unified = parseAnthropicLimits({
			"anthropic-ratelimit-unified-5h-utilization": "0.5",
			"anthropic-ratelimit-unified-5h-reset": reset,
		});
		assert.equal(unified[0]?.resetMs, undefined, `unified ${reset}`);
		const pairs = parseAnthropicLimits({
			"anthropic-ratelimit-tokens-limit": "100",
			"anthropic-ratelimit-tokens-remaining": "50",
			"anthropic-ratelimit-tokens-reset": reset,
		});
		assert.equal(pairs[0]?.resetMs, undefined, `pairs ${reset}`);
	}
});

test("a Codex reset countdown beyond the Date range is dropped", () => {
	for (const seconds of ["1e306", "1e300", "1e13"]) {
		const [entry] = parseCodexLimits({ "x-codex-primary-used-percent": "40", "x-codex-primary-resets-in-seconds": seconds }, NOW);
		assert.equal(entry.usedPct, 40);
		assert.equal(entry.resetMs, undefined, seconds);
	}
});

test("polled resets beyond the Date range are dropped", () => {
	const codex = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 10, reset_at: 1e300 } } });
	assert.equal(codex?.windows[0].resetsAtMs, undefined);
	const proxy = parseProxyQuota({ buckets: [{ type: "five_hour", utilization: 0.5, resetsAt: 1e300 }] });
	assert.equal(proxy[0].resetMs, undefined);
});

test("time labels for a time no Date can hold do not throw", () => {
	for (const ms of [Infinity, -Infinity, Number.NaN, 1e300, 9e15]) {
		assert.doesNotThrow(() => resetLabel(ms, NOW), `resetLabel ${ms}`);
		assert.equal(resetLabel(ms, NOW), "");
		assert.equal(hhmm(ms), "--:--");
		assert.doesNotThrow(() => localTime(ms), `localTime ${ms}`);
	}
	assert.doesNotThrow(() => resetLabel(NOW, Infinity));
});

test("a footer row whose snapshot holds an out-of-range reset still renders", () => {
	const model: FooterModel = {
		nowMs: NOW, lastApiEndMs: NOW,
		cache: { kind: "warm", tone: "dim", label: "1m warm" },
		context: { usedTokens: 100, limitTokens: 1000, percent: 10 },
		modelName: "test", counters: { prompts: 1, turns: 1, toolCalls: 1 }, cwd: "~",
		tokens: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1 },
		rows: [{ id: "anthropic", cost: 1, airtimeMs: 1000, tokens: { input: 1, output: 1 }, entries: [
			{ label: "5h", usedPct: 50, resetMs: 1e300 },
			{ label: "7d", usedPct: 99, resetMs: Infinity },
		] }],
		extensionStatuses: [],
	};
	const paint = { fg: (_tone: string, text: string) => text };
	for (const width of [200, 60]) assert.doesNotThrow(() => footerLayout(model, width, paint));
});

test("a small numeric reset is a countdown in seconds, not a time in 1970", () => {
	const [generic] = parseGenericLimits({ "x-ratelimit-limit": "100", "x-ratelimit-remaining": "3", "x-ratelimit-reset": "60" }, NOW);
	assert.equal(generic.resetMs, NOW + 60_000);
	const [pair] = parseAnthropicLimits({
		"anthropic-ratelimit-tokens-limit": "100",
		"anthropic-ratelimit-tokens-remaining": "50",
		"anthropic-ratelimit-tokens-reset": "0.5",
	}, NOW);
	assert.equal(pair.resetMs, NOW + 500);
	// Epoch seconds and milliseconds keep their meaning.
	const [epoch] = parseGenericLimits({ "x-ratelimit-limit": "100", "x-ratelimit-remaining": "3", "x-ratelimit-reset": "1800003600" }, NOW);
	assert.equal(epoch.resetMs, 1_800_003_600_000);
	const [negative] = parseGenericLimits({ "x-ratelimit-limit": "100", "x-ratelimit-remaining": "3", "x-ratelimit-reset": "-5" }, NOW);
	assert.equal(negative.resetMs, undefined);
});

test("a remaining count outside 0..limit gives no percentage", () => {
	for (const [limit, remaining] of [["100", "150"], ["5e-324", "1e308"], ["100", "-1"]]) {
		assert.deepEqual(parseGenericLimits({ "x-ratelimit-limit": limit, "x-ratelimit-remaining": remaining }, NOW), [], `${limit}/${remaining}`);
		assert.deepEqual(parseAnthropicLimits({
			"anthropic-ratelimit-requests-limit": limit,
			"anthropic-ratelimit-requests-remaining": remaining,
		}, NOW), [], `${limit}/${remaining}`);
	}
	const [full] = parseGenericLimits({ "x-ratelimit-limit": "100", "x-ratelimit-remaining": "100" }, NOW);
	assert.equal(full.usedPct, 0);
});

// An epoch in microseconds (about 1.8e15) is a valid Date some 56,000 years ahead.
test("an epoch reset more than 400 days ahead is dropped as a misread unit", () => {
	const micro = String(NOW * 1000);
	assert.equal(parseGenericLimits({ "x-ratelimit-limit": "100", "x-ratelimit-remaining": "3", "x-ratelimit-reset": micro }, NOW)[0].resetMs, undefined);
	assert.equal(parseAnthropicLimits({ "anthropic-ratelimit-unified-5h-utilization": "0.5", "anthropic-ratelimit-unified-5h-reset": micro }, NOW)[0].resetMs, undefined);
	assert.equal(parseProxyQuota({ buckets: [{ type: "five_hour", utilization: 0.5, resetsAt: NOW * 1000 }] })[0].resetMs, undefined);
	// The horizon counts from the caller's clock.
	const later = 2_000_000_000_000;
	assert.equal(parseProxyQuota({ buckets: [{ type: "five_hour", utilization: 0.5, resetsAt: later }] }, later - 3_600_000)[0].resetMs, later);
	// A monthly reset a month ahead stays.
	const month = String(Math.round((NOW + 31 * 86_400_000) / 1000));
	assert.equal(parseGenericLimits({ "x-ratelimit-limit": "100", "x-ratelimit-remaining": "3", "x-ratelimit-reset": month }, NOW)[0].resetMs, Number(month) * 1000);
});

test("header percentages stay within 0..100", () => {
	const unified = parseAnthropicLimits({ "anthropic-ratelimit-unified-5h-utilization": "-0.5", "anthropic-ratelimit-unified-7d-utilization": "250" }, NOW);
	assert.deepEqual(unified.map((entry) => entry.usedPct).sort((a, b) => (a ?? 0) - (b ?? 0)), [0, 100]);
	const codex = parseCodexLimits({ "x-codex-primary-used-percent": "-3", "x-codex-secondary-used-percent": "140" }, NOW);
	assert.deepEqual(codex.map((entry) => entry.usedPct), [0, 100]);
});

test("a limit header of Infinity is no reading, not NaN percent", () => {
	const entries = parseLimitHeaders("anthropic", { "anthropic-ratelimit-requests-limit": "Infinity", "anthropic-ratelimit-requests-remaining": "150" }, NOW);
	assert.ok(entries.every((entry) => Number.isFinite(entry.usedPct)), JSON.stringify(entries));
});
