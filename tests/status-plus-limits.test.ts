import { test } from "node:test";
import assert from "node:assert/strict";
import {
	codexEntries,
	openCodeGoEntries,
	parseAnthropicLimits,
	parseCodexLimits,
	parseLimitHeaders,
	topEntries,
} from "../lib/status-plus-limits.ts";

const NOW = 1_800_000_000_000;

test("codex headers map to window labels and absolute resets", () => {
	const entries = parseCodexLimits({
		"x-codex-primary-used-percent": "35",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-resets-in-seconds": "600",
		"x-codex-secondary-used-percent": "80",
		"x-codex-secondary-reset-after-seconds": "86400",
	}, NOW);
	assert.deepEqual(entries, [
		{ label: "5h", usedPct: 35, resetMs: NOW + 600_000 },
		{ label: "7d", usedPct: 80, resetMs: NOW + 86_400_000 },
	]);
});

test("anthropic unified headers win over api-key triplets and drop overage", () => {
	const unified = parseAnthropicLimits({
		"anthropic-ratelimit-unified-5h-utilization": "0.25",
		"anthropic-ratelimit-unified-7d-utilization": "60",
		"anthropic-ratelimit-unified-overage-utilization": "0.9",
		"anthropic-ratelimit-unified-reset": "2000000000",
	});
	assert.deepEqual(unified, [
		{ label: "7d", usedPct: 60, resetMs: 2_000_000_000_000 },
		{ label: "5h", usedPct: 25, resetMs: 2_000_000_000_000 },
	]);
	const triplets = parseAnthropicLimits({
		"anthropic-ratelimit-tokens-limit": "1000",
		"anthropic-ratelimit-tokens-remaining": "250",
		"anthropic-ratelimit-tokens-reset": "2033-05-18T03:33:20Z",
	});
	assert.deepEqual(triplets, [{ label: "tokens", usedPct: 75, resetMs: Date.parse("2033-05-18T03:33:20Z") }]);
});

test("unknown providers fall back to generic x-ratelimit headers", () => {
	assert.deepEqual(parseLimitHeaders("mystery", {
		"x-ratelimit-limit": "10", "x-ratelimit-remaining": "4", "x-ratelimit-reset": "1750000000",
	}), [{ label: "req", usedPct: 60, resetMs: 1_750_000_000_000 }]);
	assert.deepEqual(parseLimitHeaders("mystery", {}), []);
});

test("topEntries keeps the three highest-pressure windows", () => {
	const entries = topEntries([
		{ label: "a", usedPct: 10 }, { label: "b", usedPct: 90 }, { label: "c" }, { label: "d", usedPct: 50 },
	]);
	assert.deepEqual(entries.map((entry) => entry.label), ["b", "d", "a"]);
});

test("shared poller windows become footer entries with short labels", () => {
	assert.deepEqual(codexEntries({
		provider: "codex", plan: "plus",
		windows: [
			{ key: "primary", pct: 42, windowSeconds: 18000, resetsAtMs: 1 },
			{ key: "secondary", pct: 7, resetsAtMs: 2 },
		],
	}), [{ label: "5h", usedPct: 42, resetMs: 1 }, { label: "7d", usedPct: 7, resetMs: 2 }]);
	assert.deepEqual(openCodeGoEntries({
		provider: "opencode-go",
		windows: [
			{ key: "rolling", pct: 100, windowSeconds: 18000, resetsAtMs: 3, exhausted: true },
			{ key: "monthly", pct: 9, windowSeconds: 2_592_000, exhausted: false },
		],
	}), [
		{ label: "5h", usedPct: 100, resetMs: 3, exhausted: true },
		{ label: "mo", usedPct: 9, resetMs: undefined, exhausted: false },
	]);
});
