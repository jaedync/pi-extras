import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexUsage } from "../lib/provider-limits.ts";
import { codexEntries, parseAnthropicLimits, parseCodexLimits } from "../lib/status-plus-limits.ts";
import { DEFAULT_GUARD_CONFIG, pendingWarnings } from "../lib/usage-guard-core.ts";
import type { LimitSnapshot } from "../lib/limit-store.ts";
import type { LimitEntry } from "../lib/status-plus-logic.ts";

const NOW = Date.UTC(2026, 9, 12, 12);
const RESET = NOW + 3_600_000;
const ON = { ...DEFAULT_GUARD_CONFIG, enabled: true };
const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const snap = (entries: LimitEntry[], source: LimitSnapshot["source"]): LimitSnapshot => ({ entries, atMs: NOW, source });

test("Anthropic header windows carry the keys a poll gives them", () => {
	const entries = parseAnthropicLimits({
		"anthropic-ratelimit-unified-5h-utilization": "0.2",
		"anthropic-ratelimit-unified-7d-utilization": "0.3",
		"anthropic-ratelimit-unified-7d_fable-utilization": "0.97",
	}, NOW);
	const byKey = Object.fromEntries(entries.map((entry) => [entry.key, entry]));
	assert.deepEqual(Object.keys(byKey).sort(), ["five_hour", "seven_day", "seven_day_fable"]);
	assert.equal(byKey.five_hour.label, "5h");
	assert.equal(byKey.seven_day_fable.label, "7d-fable");
	assert.equal(byKey.seven_day_fable.modelFamily, "fable");
	assert.equal(byKey.seven_day_fable.windowSeconds, 604_800);
});

test("a warning a poll fired does not fire again when headers replace the snapshot", () => {
	const fired = new Set<string>();
	const poll: LimitEntry = { label: "5h", key: "five_hour", windowSeconds: 18_000, usedPct: 96, resetMs: RESET };
	for (const warning of pendingWarnings([["anthropic", snap([poll], "poll")]], OPUS, ON, undefined, fired, NOW)) fired.add(warning.key);
	assert.equal(fired.size, 1);
	const headers = parseAnthropicLimits({
		"anthropic-ratelimit-unified-5h-utilization": "0.96",
		"anthropic-ratelimit-unified-5h-reset": String(Math.floor(RESET / 1000)),
	}, NOW);
	assert.deepEqual(pendingWarnings([["anthropic", snap(headers, "headers")]], OPUS, ON, undefined, fired, NOW + 16 * 60_000), []);
	const budget = pendingWarnings([["anthropic", snap(headers, "headers")]], OPUS, DEFAULT_GUARD_CONFIG, { window: "five_hour", pct: 50 }, new Set(), NOW);
	assert.equal(budget.length, 1);
});

test("a model-family header window warns only that family", () => {
	const entries = parseAnthropicLimits({
		"anthropic-ratelimit-unified-7d_fable-utilization": "0.97",
		"anthropic-ratelimit-unified-7d_fable-reset": String(Math.floor(RESET / 1000)),
	}, NOW);
	assert.deepEqual(pendingWarnings([["anthropic", snap(entries, "headers")]], OPUS, ON, undefined, new Set(), NOW), []);
	const fable = pendingWarnings([["anthropic", snap(entries, "headers")]], { provider: "anthropic", id: "claude-fable-5-1" }, ON, undefined, new Set(), NOW);
	assert.equal(fable.length, 1);
});

test("Codex header and poll windows share keys by window length", () => {
	const headers = parseCodexLimits({
		"x-codex-primary-used-percent": "35", "x-codex-primary-window-minutes": "300",
		"x-codex-secondary-used-percent": "80", "x-codex-secondary-window-minutes": "10080",
	}, NOW);
	assert.deepEqual(headers.map((entry) => entry.key), ["five_hour", "seven_day"]);
	const polled = codexEntries({ provider: "codex", windows: [
		{ key: "primary", pct: 35, windowSeconds: 18_000 }, { key: "secondary", pct: 80, windowSeconds: 604_800 },
	] });
	assert.deepEqual(polled.map((entry) => entry.key), ["five_hour", "seven_day"]);
	// A plan whose primary slot is weekly gets the weekly key, not the 5h one.
	assert.deepEqual(codexEntries({ provider: "codex", windows: [{ key: "primary", pct: 1, windowSeconds: 604_800 }] }).map((entry) => entry.key), ["seven_day"]);
	// With no window length, the slot name stays the key on both paths.
	assert.equal(parseCodexLimits({ "x-codex-secondary-used-percent": "3" }, NOW)[0].key, "secondary");
	assert.equal(codexEntries({ provider: "codex", windows: [{ key: "secondary", pct: 3 }] })[0].key, "secondary");
});

test("Codex limit_reached marks only the full window exhausted", () => {
	const usage = parseCodexUsage({ plan_type: "plus", rate_limit: { allowed: false, limit_reached: true,
		primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_at: Math.floor(NOW / 1000) + 3600 },
		secondary_window: { used_percent: 31, limit_window_seconds: 604_800, reset_at: Math.floor(NOW / 1000) + 5 * 86_400 } } })!;
	const entries = codexEntries(usage);
	assert.deepEqual(entries.map((entry) => [entry.label, entry.exhausted]), [["5h", true], ["7d", false]]);
	// No window reads full: the fullest one is the block.
	const odd = codexEntries({ provider: "codex", limitReached: true, windows: [
		{ key: "primary", pct: 90, windowSeconds: 18_000 }, { key: "secondary", pct: 99, windowSeconds: 604_800 },
	] });
	assert.deepEqual(odd.map((entry) => entry.exhausted), [false, true]);
});
