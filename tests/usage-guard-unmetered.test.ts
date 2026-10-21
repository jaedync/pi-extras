import { test } from "node:test";
import assert from "node:assert/strict";
import type { LimitSnapshot } from "../lib/limit-store.ts";
import type { LimitEntry } from "../lib/status-plus-logic.ts";
import { DEFAULT_GUARD_CONFIG, isUnmetered, usageReport } from "../lib/usage-guard-core.ts";

const NOW = Date.UTC(2026, 9, 21, 12);
const DAY = 86_400_000;
const LOCAL = { provider: "fw01", id: "qwen3.8-flash-next", unmetered: true };
const ON = { ...DEFAULT_GUARD_CONFIG, enabled: true };
const snap = (entries: LimitEntry[]): LimitSnapshot => ({ entries, atMs: NOW, source: "poll" });
const week = (usedPct: number): LimitEntry => ({ label: "7d", key: "seven_day", windowSeconds: 604_800, usedPct, resetMs: NOW + DAY });

test("a model is unmetered only when every catalog price is zero", () => {
	assert.equal(isUnmetered({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), true);
	assert.equal(isUnmetered({ input: 0, output: 0.1, cacheRead: 0, cacheWrite: 0 }), false);
	assert.equal(isUnmetered({ input: 0, output: 0 }), true);
	assert.equal(isUnmetered(undefined), false);
	assert.equal(isUnmetered({}), false);
});

test("an unmetered active model is told first that usage does not limit its own work", () => {
	const report = usageReport([], LOCAL, ON, undefined, NOW);
	assert.equal(report.model.unmetered, true);
	assert.match(report.notes[0], /fw01\/qwen3\.8-flash-next has zero token cost/);
	assert.match(report.notes[0], /does not limit this session/);
	// The generic no-data note suggested limits were still coming.
	assert.doesNotMatch(report.notes.join(" "), /response headers|No usage data yet/);
});

test("limits of other providers are marked as relevant only to subagents", () => {
	const report = usageReport([["anthropic", snap([week(94)])]], LOCAL, ON, undefined, NOW, true);
	assert.equal(report.limits[0].applies, false);
	assert.ok(report.notes.some((note) => /applies: false/.test(note) && /subagents/.test(note)));
	const own = usageReport([["anthropic", snap([week(94)])]], { provider: "anthropic", id: "claude-opus-5-5" }, ON, undefined, NOW, true);
	assert.ok(!own.notes.some((note) => /applies: false/.test(note)), "no note when every listed limit applies");
});

test("the full report lists unmetered models as subagent choices", () => {
	const free = ["fw01/qwen3.8-flash-next", "redarch-lora/qwen38"];
	const all = usageReport([], LOCAL, ON, undefined, NOW, true, undefined, undefined, free);
	assert.deepEqual(all.unmeteredModels, free);
	assert.ok(all.notes.some((note) => /unmeteredModels/.test(note)));
	const short = usageReport([], LOCAL, ON, undefined, NOW, false, undefined, undefined, free);
	assert.equal(short.unmeteredModels, undefined);
});

test("a zero-cost model whose provider reports windows does not claim to have no limits", () => {
	const report = usageReport([["fw01", snap([week(50)])]], LOCAL, ON, undefined, NOW);
	assert.equal(report.limits[0].applies, true);
	assert.doesNotMatch(report.notes.join(" "), /does not limit this session/);
});
