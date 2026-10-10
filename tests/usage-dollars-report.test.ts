import { test } from "node:test";
import assert from "node:assert/strict";
import type { LimitSnapshot } from "../lib/limit-store.ts";
import { DEFAULT_GUARD_CONFIG, usageReport } from "../lib/usage-guard-core.ts";

const NOW = Date.UTC(2026, 9, 10, 17);
const HOUR = 3_600_000;
const MODEL = { provider: "anthropic", id: "claude-opus-5-5" };
const snapshots: Array<[string, LimitSnapshot]> = [
	["anthropic", { atMs: NOW - 5000, source: "poll", entries: [
		{ label: "5h", key: "five_hour", usedPct: 20, windowSeconds: 18000, resetMs: NOW + HOUR },
		{ label: "7d", key: "seven_day", usedPct: 50, windowSeconds: 604800, resetMs: NOW + 50 * HOUR },
	] }],
	["opencode-go", { atMs: NOW - 5000, source: "poll", entries: [
		{ label: "5h", key: "rolling", usedPct: 0, windowSeconds: 18000, resetMs: NOW + 2 * HOUR },
	] }],
];

test("without dollar inputs the report keeps its old shape", () => {
	const report = usageReport(snapshots, MODEL, DEFAULT_GUARD_CONFIG, undefined, NOW, true, "UTC");
	assert.equal("dollars" in report, false);
	assert.equal(report.limits.some((limit) => "dollars" in limit), false);
});

test("dollar inputs add figures to each limit and a summary with the collector's notes", () => {
	const report = usageReport(snapshots, MODEL, DEFAULT_GUARD_CONFIG, undefined, NOW, true, "UTC", {
		inputs: {
			now: NOW, timeZone: "UTC",
			spend: ({ provider }) => (provider === "anthropic" ? 100 : 0),
			today: { byProvider: { anthropic: 42 } },
			openCodeGo: { plan: "go", caps: {}, models: ["glm-5.3"] },
		},
		notes: ["Tokenfold is not set up."],
	});
	const [five, seven, go] = report.limits;
	assert.equal(five?.dollars?.basis, "implied");
	assert.equal((five?.dollars as { remainingUsd?: number }).remainingUsd, 400);
	assert.equal((seven?.dollars as { remainingUsd?: number }).remainingUsd, 100);
	assert.deepEqual((go?.dollars as { perModel?: unknown }).perModel, { "glm-5.3": { limitUsd: 3, remainingUsd: 3 } });
	assert.deepEqual(report.dollars?.providers.anthropic, { spentTodayUsd: 42, remainingUsd: 100, bindingWindow: "7d" });
	assert.deepEqual(report.dollars?.providers["opencode-go"], { remainingUsdByModel: { "glm-5.3": 3 } });
	assert.ok(report.dollars?.notes.includes("Tokenfold is not set up."));
});

test("a dollar failure drops the dollars and keeps the percent report", () => {
	const report = usageReport(snapshots, MODEL, DEFAULT_GUARD_CONFIG, undefined, NOW, true, "UTC", {
		inputs: { now: NOW, timeZone: "Not/AZone", spend: () => { throw new Error("boom"); } },
		notes: [],
	});
	assert.equal(report.limits.length, 3);
	assert.equal(report.limits.some((limit) => "dollars" in limit), false);
	assert.equal(report.limits[0]?.usedPct, 20);
});
