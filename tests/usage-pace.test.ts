import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GUARD_CONFIG, usageReport, warningMessage, type Warning } from "../lib/usage-guard-core.ts";
import type { LimitSnapshot } from "../lib/limit-store.ts";
import { parseProxyQuota, type LimitEntry } from "../lib/status-plus-logic.ts";
import { codexEntries, openCodeGoEntries, parseAnthropicLimits, parseCodexLimits, pollAnthropicUsage } from "../lib/status-plus-limits.ts";
import { parseOpenCodeGoUsage, parseCodexUsage } from "../lib/provider-limits.ts";

const NOW = Date.parse("2026-10-02T06:10:00Z");
const RESET = Date.parse("2026-10-02T09:10:00Z");
const ON = { ...DEFAULT_GUARD_CONFIG, enabled: true };
const MODEL = { provider: "anthropic", id: "claude-opus-5-5" };
function limit(entry: LimitEntry, now = NOW) {
	return usageReport([["anthropic", { entries: [entry], atMs: now, source: "poll" }]], MODEL, ON, undefined, now, false, "UTC").limits[0];
}
const five = (usedPct: number): LimitEntry => ({ label: "5h", key: "five_hour", usedPct, resetMs: RESET, windowSeconds: 18000 });

test("pace uses elapsed time, even usage, projection, and the estimated time to 100 percent", () => {
	const pace = limit(five(60)).pace;
	assert.equal(pace?.durationSeconds, 18000);
	assert.equal(pace?.elapsedFraction, 0.4);
	assert.equal(pace?.expectedUsagePct, 40);
	assert.equal(pace?.projectedUsagePct, 150);
	assert.equal(pace?.state, "above pace");
	assert.equal(pace?.reaches100At, "2026-10-02T07:30:00.000Z");
	assert.match(pace?.reaches100AtLocal ?? "", /UTC$/);
	assert.equal(pace?.reaches100InSeconds, 4800);
	const warning: Warning = { key: "k", provider: "anthropic", entry: five(60), reason: "budget", threshold: 60, final: true };
	assert.match(warningMessage(warning, ON, NOW, "UTC"), /above pace: 100% in about 1h20m, before the reset in 3h/);
});

test("the on-pace band is inclusive from 90 through 110 projected percent", () => {
	const half = RESET - 9000_000;
	for (const [pct, state] of [[44.9, "below pace"], [45, "on pace"], [50, "on pace"], [55, "on pace"], [55.1, "above pace"]] as const) {
		const pace = limit(five(pct), half).pace;
		assert.equal(pace?.state, state);
		assert.equal(pace?.reaches100At !== undefined, state === "above pace");
	}
});

test("early windows and tiny usage omit noisy projections, including the October 2 sample", () => {
	const now = Date.parse("2026-10-02T04:11:43Z");
	const pace = limit(five(3), now).pace;
	assert.equal(pace?.state, "too early to tell");
	assert.ok((pace?.elapsedFraction ?? 1) < 0.05);
	assert.equal(pace?.projectedUsagePct, undefined);
	assert.equal(pace?.reaches100At, undefined);
	assert.equal(limit(five(60), RESET - 18000_000).pace?.state, "too early to tell");
	assert.equal(limit(five(0)).pace?.state, "too early to tell");
	assert.equal(limit(five(0.9)).pace?.state, "too early to tell");
	assert.notEqual(limit(five(1), RESET - 0.95 * 18000_000).pace?.state, "too early to tell");
});

test("missing, approximate, expired, non-window, and invalid timing do not invent pace", () => {
	for (const entry of [
		{ label: "unknown", usedPct: 50, resetMs: RESET },
		{ ...five(50), resetMs: undefined },
		{ ...five(50), resetApprox: true },
		{ ...five(50), kind: "rate" as const },
		{ ...five(50), resetMs: NOW },
		{ ...five(50), resetMs: NOW - 1 },
		{ ...five(50), resetMs: NOW + 18000_000 + 1 },
		{ ...five(50), resetMs: Infinity },
		{ ...five(50), windowSeconds: 0 },
		{ ...five(50), windowSeconds: NaN },
		{ ...five(50), usedPct: NaN },
		{ ...five(50), usedPct: -1 },
		{ ...five(50), usedPct: Number.MAX_VALUE },
	]) assert.equal(limit(entry).pace, undefined);
});

test("100 percent and overage do not suggest negative waiting times", () => {
	for (const pct of [100, 120]) {
		const pace = limit(five(pct)).pace;
		assert.equal(pace?.state, "above pace");
		assert.equal(pace?.reaches100InSeconds, 0);
		assert.ok(Date.parse(pace?.reaches100At ?? "") <= NOW);
		assert.match(warningMessage({ key: "k", provider: "anthropic", entry: five(pct), threshold: 95, reason: "band", final: false }, ON, NOW), /above pace: 100% already reached/);
	}
});

test("known Anthropic and named Go windows carry duration; Codex uses its reported duration", () => {
	const proxy = parseProxyQuota({ buckets: ["five_hour", "seven_day", "seven_day_opus", "unknown", "constructor", "__proto__"].map((type) => ({ type, utilization: 0.2, resetsAt: RESET })) });
	assert.deepEqual(proxy.map((entry) => entry.windowSeconds), [18000, 604800, 604800, undefined, undefined, undefined]);
	assert.deepEqual(parseAnthropicLimits({
		"anthropic-ratelimit-unified-5h-utilization": "0.1",
		"anthropic-ratelimit-unified-7d-utilization": "0.2",
	}).map((entry) => entry.windowSeconds), [604800, 18000]);
	const go = openCodeGoEntries(parseOpenCodeGoUsage({ usage: {
		rolling: { percent: 20 }, weekly: { percent: 30 }, monthly: { percent: 40 },
	} })!);
	assert.deepEqual(go.map((entry) => entry.windowSeconds), [18000, 604800, 2592000]);
	const codex = codexEntries(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 604800 } } })!);
	assert.equal(codex[0].windowSeconds, 604800, "primary can be weekly");
	assert.equal(codexEntries({ provider: "codex", windows: [{ key: "primary", pct: 50 }] })[0].windowSeconds, undefined);
	assert.equal(parseCodexLimits({ "x-codex-primary-used-percent": "10", "x-codex-primary-window-minutes": "300" })[0].windowSeconds, 18000);
});

test("the full report gives pace for weekly family, weekly Codex primary, and all Go windows", () => {
	const weeklyReset = NOW + 0.5 * 604800_000;
	const snapshots: Array<[string, LimitSnapshot]> = [
		["anthropic", { entries: parseProxyQuota({ buckets: [{ type: "seven_day_opus", utilization: 0.6, resetsAt: weeklyReset }] }), atMs: NOW, source: "poll" }],
		["openai-codex", { entries: codexEntries({ provider: "codex", windows: [{ key: "primary", pct: 60, windowSeconds: 604800, resetsAtMs: weeklyReset }] }), atMs: NOW, source: "poll" }],
		["opencode-go", { entries: openCodeGoEntries({ provider: "opencode-go", windows: [
			{ key: "rolling", pct: 60, windowSeconds: 18000, resetsAtMs: NOW + 9000_000 },
			{ key: "weekly", pct: 60, windowSeconds: 604800, resetsAtMs: weeklyReset },
			{ key: "monthly", pct: 60, windowSeconds: 2592000, resetsAtMs: NOW + 1296000_000 },
		] }), atMs: NOW, source: "poll" }],
	];
	const report = usageReport(snapshots, MODEL, ON, undefined, NOW, true, "UTC");
	assert.equal(report.limits.length, 5);
	for (const entry of report.limits) {
		assert.equal(entry.pace?.elapsedFraction, 0.5);
		assert.equal(entry.pace?.projectedUsagePct, 120);
		assert.equal(entry.pace?.state, "above pace");
		assert.match(entry.pace?.reaches100AtLocal ?? "", /UTC$/);
	}
});

test("Anthropic OAuth windows carry duration without exposing credentials", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({
		five_hour: { utilization: 20, resets_at: new Date(RESET).toISOString() },
		seven_day_opus: { utilization: 30, resets_at: new Date(RESET).toISOString() },
	}));
	try {
		const entries = await pollAnthropicUsage({ modelRegistry: {
			getProvider: () => undefined, getApiKeyForProvider: async () => "test-only-token",
		} });
		assert.deepEqual(entries?.map((entry) => entry.windowSeconds), [18000, 604800]);
	} finally { globalThis.fetch = original; }
});
