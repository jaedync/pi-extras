import { test } from "node:test";
import assert from "node:assert/strict";
import {
	FORCED_POLL_FLOOR_MS,
	LIMIT_POLLERS,
	MAX_BACKOFF_MS,
	anthropicPollInterval,
	codexEntries,
	openCodeGoEntries,
	parseAnthropicLimits,
	parseCodexLimits,
	parseLimitHeaders,
	pollGapMs,
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
	assert.deepEqual(triplets, [{ label: "tokens", kind: "rate", usedPct: 75, resetMs: Date.parse("2033-05-18T03:33:20Z") }]);
});

test("unknown providers fall back to generic x-ratelimit headers", () => {
	assert.deepEqual(parseLimitHeaders("mystery", {
		"x-ratelimit-limit": "10", "x-ratelimit-remaining": "4", "x-ratelimit-reset": "1750000000",
	}), [{ label: "req", kind: "rate", usedPct: 60, resetMs: 1_750_000_000_000 }]);
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
	}), [{ label: "5h", key: "primary", usedPct: 42, resetMs: 1 }, { label: "7d", key: "secondary", usedPct: 7, resetMs: 2 }]);
	assert.deepEqual(codexEntries({
		provider: "codex", allowed: true, limitReached: false,
		windows: [{ key: "primary", pct: 100, windowSeconds: 604800, resetsAtMs: 9 }],
	}), [{ label: "7d", key: "primary", usedPct: 100, resetMs: 9, exhausted: false, allowed: true }]);
	assert.deepEqual(openCodeGoEntries({
		provider: "opencode-go",
		windows: [
			{ key: "rolling", pct: 100, windowSeconds: 18000, resetsAtMs: 3, exhausted: true },
			{ key: "monthly", pct: 9, windowSeconds: 2_592_000, exhausted: false },
		],
	}), [
		{ label: "5h", key: "rolling", usedPct: 100, resetMs: 3, exhausted: true },
		{ label: "mo", key: "monthly", usedPct: 9, resetMs: undefined, exhausted: false },
	]);
});

test("poll gaps tighten when hot, back off on failures, and cap", () => {
	const interval = { normalMs: 60_000, hotMs: 20_000 };
	assert.equal(pollGapMs(interval, 0, false), 60_000);
	assert.equal(pollGapMs(interval, 0, true), 20_000);
	assert.equal(pollGapMs(interval, 1, false), 120_000);
	assert.equal(pollGapMs(interval, 3, true), 160_000);
	assert.equal(pollGapMs(interval, 20, false), MAX_BACKOFF_MS);
	// A slow poller's own interval is never shortened by the cap.
	assert.equal(pollGapMs({ normalMs: 15 * 60_000, hotMs: 5 * 60_000 }, 9, false), 15 * 60_000);
	assert.ok(FORCED_POLL_FLOOR_MS < interval.hotMs);
});

test("anthropic polls the local proxy route often and Anthropic itself rarely", () => {
	const registry = (baseUrl?: string) => ({
		async getApiKeyForProvider() { return undefined; },
		getProvider: () => (baseUrl ? { baseUrl } : undefined),
	});
	assert.deepEqual(anthropicPollInterval({ modelRegistry: registry("http://127.0.0.1:3456") }), { normalMs: 60_000, hotMs: 20_000 });
	assert.deepEqual(anthropicPollInterval({ modelRegistry: registry() }), { normalMs: 300_000, hotMs: 60_000 });
	assert.deepEqual(
		anthropicPollInterval({ model: { provider: "anthropic", baseUrl: "https://api.anthropic.com" }, modelRegistry: registry("http://127.0.0.1:3456") }),
		{ normalMs: 300_000, hotMs: 60_000 },
	);
	assert.equal(LIMIT_POLLERS.anthropic.interval, anthropicPollInterval);
	assert.equal(LIMIT_POLLERS["openai-codex"].interval({ modelRegistry: registry() }).normalMs, 60_000);
});
