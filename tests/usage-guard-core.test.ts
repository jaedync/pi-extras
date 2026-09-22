import { test } from "node:test";
import assert from "node:assert/strict";
import type { LimitSnapshot } from "../lib/limit-store.ts";
import type { LimitEntry } from "../lib/status-plus-logic.ts";
import {
	CYCLE_TOLERANCE_MS,
	DEFAULT_GUARD_CONFIG,
	alreadyFired,
	bandFor,
	entryApplies,
	entryKind,
	hotProviders,
	normalizeGuardConfig,
	pendingWarnings,
	resetTiming,
	usageReport,
	warningKey,
	warningMessage,
	type Warning,
} from "../lib/usage-guard-core.ts";

const NOW = 1_800_000_000_000;
const RESET = NOW + 3_600_000;
const FABLE = { provider: "anthropic", id: "claude-fable-5-1" };
const SONNET = { provider: "anthropic", id: "claude-sonnet-5" };
const ON = { ...DEFAULT_GUARD_CONFIG, enabled: true };

function snapshot(entries: LimitEntry[], atMs = NOW - 10_000): LimitSnapshot {
	return { entries, atMs, source: "poll" };
}

function anthropic(fivePct: number, sevenPct: number, fablePct: number): Array<[string, LimitSnapshot]> {
	return [["anthropic", snapshot([
		{ label: "5h", key: "five_hour", usedPct: fivePct, resetMs: RESET, allowed: true },
		{ label: "7d", key: "seven_day", usedPct: sevenPct, resetMs: RESET + 86_400_000, allowed: true },
		{ label: "7d-fable", key: "seven_day_fable", modelFamily: "fable", usedPct: fablePct, resetMs: RESET + 86_400_000, allowed: true },
	])]];
}

test("model-scoped windows govern only ids carrying the family token", () => {
	const fable: LimitEntry = { label: "7d-fable", modelFamily: "fable", usedPct: 1 };
	assert.equal(entryApplies(fable, FABLE), true);
	assert.equal(entryApplies(fable, SONNET), false);
	assert.equal(entryApplies(fable, { provider: "anthropic" }), false);
	assert.equal(entryApplies({ label: "7d", usedPct: 1 }, SONNET), true);
});

test("entry kinds are explicit when set and inferred from shape otherwise", () => {
	assert.equal(entryKind({ label: "5h", usedPct: 3 }), "window");
	assert.equal(entryKind({ label: "", remainingText: "$87.50/$100" }), "budget");
	assert.equal(entryKind({ label: "", remainingText: "$12 credits" }), "credits");
	assert.equal(entryKind({ label: "", kind: "budget", remainingText: "$12 credits" }), "budget");
});

test("bandFor picks the highest crossed threshold", () => {
	assert.equal(bandFor(89.9, [90, 95]), undefined);
	assert.equal(bandFor(90, [90, 95]), 90);
	assert.equal(bandFor(97, [90, 95]), 95);
	assert.equal(bandFor(100, [60]), 60);
});

test("config normalization sorts bands, drops junk and keeps defaults", () => {
	assert.deepEqual(normalizeGuardConfig(undefined), DEFAULT_GUARD_CONFIG);
	assert.deepEqual(normalizeGuardConfig({ enabled: true, bands: [95, "x", 80, 80, 0, 101], resumeMarginSeconds: -1 }), {
		enabled: true, bands: [80, 95], resumeMarginSeconds: 300, proximityPct: 10,
	});
	// Anything but an explicit true stays quiet.
	assert.equal(normalizeGuardConfig({ enabled: "yes" }).enabled, false);
});

test("a crossing warns once per window, threshold and reset cycle", () => {
	const fired = new Set<string>();
	const first = pendingWarnings(anthropic(20, 91, 30), SONNET, ON, undefined, fired, NOW);
	assert.equal(first.length, 1);
	assert.equal(first[0].entry.label, "7d");
	assert.equal(first[0].threshold, 90);
	assert.equal(first[0].final, false);
	for (const warning of first) fired.add(warning.key);
	// Same band, later reading: silent.
	assert.deepEqual(pendingWarnings(anthropic(20, 93, 30), SONNET, ON, undefined, fired, NOW), []);
	// Next band: one more, and it is the wrap-up.
	const second = pendingWarnings(anthropic(20, 96, 30), SONNET, ON, undefined, fired, NOW);
	assert.equal(second.length, 1);
	assert.equal(second[0].threshold, 95);
	assert.equal(second[0].final, true);
	for (const warning of second) fired.add(warning.key);
	// A new reset cycle changes the key, so the next cycle warns again.
	const nextCycle: Array<[string, LimitSnapshot]> = [["anthropic", snapshot([
		{ label: "7d", key: "seven_day", usedPct: 96, resetMs: RESET + 7 * 86_400_000 },
	])]];
	assert.equal(pendingWarnings(nextCycle, SONNET, ON, undefined, fired, NOW).length, 1);
});

test("a reset that drifts between polls is the same cycle; one hours away is not", () => {
	const fired = new Set<string>();
	const at = (resetMs: number): Array<[string, LimitSnapshot]> => [["anthropic", snapshot([
		{ label: "7d", key: "seven_day", usedPct: 91, resetMs },
	])]];
	const firedReset = RESET + 806;
	const first = pendingWarnings(at(firedReset), SONNET, ON, undefined, fired, NOW);
	assert.equal(first.length, 1);
	fired.add(first[0].key);
	// A proxy recomputing the reset shifts it by milliseconds, or a few seconds, each fetch.
	assert.deepEqual(pendingWarnings(at(RESET + 565), SONNET, ON, undefined, fired, NOW), []);
	assert.deepEqual(pendingWarnings(at(RESET - 30_000), SONNET, ON, undefined, fired, NOW), []);
	assert.deepEqual(pendingWarnings(at(firedReset + CYCLE_TOLERANCE_MS), SONNET, ON, undefined, fired, NOW), []);
	assert.equal(pendingWarnings(at(firedReset + CYCLE_TOLERANCE_MS + 1), SONNET, ON, undefined, fired, NOW).length, 1);
	// A different threshold, window or provider on the same reset is a different key.
	const entry: LimitEntry = { label: "7d", key: "seven_day", usedPct: 91, resetMs: RESET + 565 };
	assert.equal(alreadyFired(fired, "anthropic", entry, 90, "band"), true);
	assert.equal(alreadyFired(fired, "anthropic", entry, 95, "band"), false);
	assert.equal(alreadyFired(fired, "anthropic", { ...entry, key: "seven_day_fable" }, 90, "band"), false);
	assert.equal(alreadyFired(fired, "openai-codex", entry, 90, "band"), false);
	// Windows without a reset match only keys without one.
	assert.equal(alreadyFired(fired, "anthropic", { label: "7d", key: "seven_day", usedPct: 91 }, 90, "band"), false);
	fired.add(warningKey("anthropic", { label: "req", usedPct: 91 }, 90, "band"));
	assert.equal(alreadyFired(fired, "anthropic", { label: "req", usedPct: 92 }, 90, "band"), true);
	assert.equal(alreadyFired(fired, "anthropic", { label: "req", usedPct: 92, resetMs: RESET }, 90, "band"), false);
});

test("wrap-up guidance says stop, never sleep, and names model-scoped windows", () => {
	const scoped: Warning = {
		key: "k", provider: "anthropic", threshold: 95, reason: "band", final: true,
		entry: { label: "7d-fable", key: "seven_day_fable", modelFamily: "fable", usedPct: 96, resetMs: NOW + 40 * 3_600_000 },
	};
	const text = warningMessage(scoped, ON, NOW, "UTC");
	assert.match(text, /where things stand\. Then stop and report\. This window governs only fable models on anthropic; other models are not affected by it\.$/);
	assert.doesNotMatch(text, /sleep/);
	const near = warningMessage({ ...scoped, entry: { ...scoped.entry, resetMs: NOW + 3_600_000 } }, ON, NOW, "UTC");
	assert.doesNotMatch(near, /sleep/);
	const plain = warningMessage({ ...scoped, entry: { label: "7d", usedPct: 96 } }, ON, NOW, "UTC");
	assert.match(plain, /where things stand\. Then stop and report\.$/);
});

test("with warnings off, bands and blocks stay silent but a budget window still fires", () => {
	const fired = new Set<string>();
	assert.deepEqual(pendingWarnings(anthropic(96, 96, 96), FABLE, DEFAULT_GUARD_CONFIG, undefined, fired, NOW), []);
	assert.deepEqual([...hotProviders(anthropic(20, 85, 30), SONNET, DEFAULT_GUARD_CONFIG, undefined, NOW)], []);
	const blocked: Array<[string, LimitSnapshot]> = [["anthropic", snapshot([
		{ label: "5h", key: "five_hour", usedPct: 100, resetMs: RESET, exhausted: true },
	])]];
	assert.deepEqual(pendingWarnings(blocked, SONNET, DEFAULT_GUARD_CONFIG, undefined, fired, NOW), []);
	const budget = { window: "7d", pct: 60 };
	const warnings = pendingWarnings(anthropic(20, 61, 30), SONNET, DEFAULT_GUARD_CONFIG, budget, fired, NOW);
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0].reason, "budget");
	assert.deepEqual([...hotProviders(anthropic(20, 52, 30), SONNET, DEFAULT_GUARD_CONFIG, budget, NOW)], ["anthropic"]);
	// A block on the budgeted window is worth one final warning too.
	const blockedBudget: Array<[string, LimitSnapshot]> = [["anthropic", snapshot([
		{ label: "7d", key: "seven_day", usedPct: 100, resetMs: RESET, exhausted: true },
	])]];
	assert.equal(pendingWarnings(blockedBudget, SONNET, DEFAULT_GUARD_CONFIG, budget, new Set(), NOW)[0]?.reason, "exhausted");
	const report = usageReport(anthropic(20, 61, 30), SONNET, DEFAULT_GUARD_CONFIG, undefined, NOW, false, "UTC");
	assert.equal(report.warnings, "off");
	assert.deepEqual(report.limits[0].thresholds, []);
});

test("windows for other models, other providers, stale resets and disabled guards stay silent", () => {
	const fired = new Set<string>();
	// Fable weekly is at 96 but the active model is Sonnet.
	assert.deepEqual(pendingWarnings(anthropic(20, 30, 96), SONNET, ON, undefined, fired, NOW), []);
	// Switch to Fable: it applies.
	assert.equal(pendingWarnings(anthropic(20, 30, 96), FABLE, ON, undefined, fired, NOW).length, 1);
	// Another provider's snapshot never warns for the active one.
	const codex: Array<[string, LimitSnapshot]> = [["openai-codex", snapshot([{ label: "7d", usedPct: 100, resetMs: RESET }])]];
	assert.deepEqual(pendingWarnings(codex, SONNET, ON, undefined, fired, NOW), []);
	// A reset in the past means the snapshot is stale.
	const stale: Array<[string, LimitSnapshot]> = [["anthropic", snapshot([{ label: "5h", usedPct: 99, resetMs: NOW - 1 }])]];
	assert.deepEqual(pendingWarnings(stale, SONNET, ON, undefined, fired, NOW), []);
	assert.deepEqual(pendingWarnings(anthropic(99, 99, 99), FABLE, { ...ON, enabled: false }, undefined, fired, NOW), []);
});

test("a session budget replaces the bands for its window and is final", () => {
	const fired = new Set<string>();
	const budget = { window: "7d", pct: 60 };
	const warnings = pendingWarnings(anthropic(20, 61, 30), SONNET, ON, budget, fired, NOW);
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0].reason, "budget");
	assert.equal(warnings[0].threshold, 60);
	assert.equal(warnings[0].final, true);
	assert.match(warningMessage(warnings[0], ON, NOW, "UTC"), /session budget: 61% used, budget 60%/);
	// The 5h window still uses the configured bands.
	const five = pendingWarnings(anthropic(92, 10, 30), SONNET, ON, budget, fired, NOW);
	assert.equal(five.length, 1);
	assert.equal(five[0].reason, "band");
});

test("an exhausted window is final regardless of its percentage", () => {
	const exhausted: Array<[string, LimitSnapshot]> = [["opencode-go", snapshot([
		{ label: "5h", key: "rolling", usedPct: 100, resetMs: RESET, exhausted: true },
	])]];
	const warnings = pendingWarnings(exhausted, { provider: "opencode-go", id: "x" }, ON, undefined, new Set(), NOW);
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0].reason, "exhausted");
	assert.equal(warnings[0].key, warningKey("opencode-go", warnings[0].entry, 100, "exhausted"));
	assert.match(warningMessage(warnings[0], ON, NOW, "UTC"), /blocked by the provider/);
});

test("warning text carries reset, resume delay and the Codex saturation note", () => {
	const codex: Array<[string, LimitSnapshot]> = [["openai-codex", snapshot([
		{ label: "7d", key: "primary", usedPct: 100, resetMs: RESET, allowed: true },
	])]];
	const [warning] = pendingWarnings(codex, { provider: "openai-codex", id: "gpt-5-codex" }, ON, undefined, new Set(), NOW);
	const text = warningMessage(warning, ON, NOW, "UTC");
	assert.match(text, /^Usage warning: openai-codex 7d is at 100% \(threshold 95%\)\./);
	assert.match(text, /Resets .* \(in 1h\)\./);
	assert.match(text, /still accepts requests; the percentage is capped at 100/);
	assert.doesNotMatch(text, /sleep/);
	const notice = warningMessage({ ...warning, threshold: 90, final: false }, ON, NOW, "UTC");
	assert.match(notice, /^Usage notice: /);
	assert.doesNotMatch(notice, /sleep/);
});

test("hot providers sit within proximity of their next threshold", () => {
	assert.deepEqual([...hotProviders(anthropic(20, 82, 30), SONNET, ON, undefined, NOW)], ["anthropic"]);
	assert.deepEqual([...hotProviders(anthropic(20, 79, 30), SONNET, ON, undefined, NOW)], []);
	// Fable at 88 only matters when Fable is active.
	assert.deepEqual([...hotProviders(anthropic(20, 10, 88), SONNET, ON, undefined, NOW)], []);
	assert.deepEqual([...hotProviders(anthropic(20, 10, 88), FABLE, ON, undefined, NOW)], ["anthropic"]);
	// A budget moves the threshold, so proximity follows it.
	assert.deepEqual([...hotProviders(anthropic(20, 52, 30), SONNET, ON, { window: "7d", pct: 60 }, NOW)], ["anthropic"]);
});

test("reset timing reports ISO, local, seconds and the resume margin", () => {
	const timing = resetTiming({ label: "5h", usedPct: 1, resetMs: RESET }, ON, NOW, "UTC");
	assert.equal(timing?.resetsAt, new Date(RESET).toISOString());
	assert.equal(timing?.resetsInSeconds, 3600);
	assert.equal(timing?.resumeAfterSeconds, 3900);
	assert.match(timing?.resetsAtLocal ?? "", /UTC$/);
	assert.equal(resetTiming({ label: "x" }, ON, NOW), undefined);
	assert.equal(resetTiming({ label: "", resetMs: RESET, resetApprox: true }, ON, NOW, "UTC")?.resetApprox, true);
});

test("the report keeps governing windows by default and explains the gaps", () => {
	const snapshots: Array<[string, LimitSnapshot]> = [
		...anthropic(5, 31, 62),
		["openai-codex", snapshot([{ label: "7d", key: "primary", usedPct: 100, resetMs: RESET, allowed: true }])],
	];
	const report = usageReport(snapshots, SONNET, ON, { window: "7d", pct: 60 }, NOW, false, "UTC");
	assert.deepEqual(report.limits.map((limit) => limit.window), ["5h", "7d"]);
	assert.equal(report.limits[1].budgetPct, 60);
	assert.equal(report.limits[1].nextThreshold, 60);
	assert.equal(report.limits[1].headroomPct, 29);
	assert.equal(report.limits[0].reset?.resumeAfterSeconds, 3900);
	assert.deepEqual(report.snapshotAgeSeconds, { anthropic: 10 });
	assert.deepEqual(report.notes, []);
	assert.equal(report.budget?.pct, 60);

	const everything = usageReport(snapshots, SONNET, ON, undefined, NOW, true, "UTC");
	assert.deepEqual(everything.limits.map((limit) => `${limit.provider}/${limit.window}/${limit.applies}`), [
		"anthropic/5h/true", "anthropic/7d/true", "anthropic/7d-fable/false", "openai-codex/7d/false",
	]);
	assert.equal(everything.limits[3].status, "full-but-allowed");
});

test("per-minute rate limits from headers are reported but never warned on", () => {
	const rate: Array<[string, LimitSnapshot]> = [["anthropic", { entries: [
		{ label: "tokens", kind: "rate", usedPct: 97, resetMs: NOW + 40_000 },
	], atMs: NOW, source: "headers" }]];
	assert.deepEqual(pendingWarnings(rate, SONNET, ON, undefined, new Set(), NOW), []);
	assert.deepEqual([...hotProviders(rate, SONNET, ON, undefined, NOW)], []);
	const report = usageReport(rate, SONNET, ON, undefined, NOW, false, "UTC");
	assert.equal(report.limits[0].kind, "rate");
	assert.equal(report.limits[0].thresholds, undefined);
	assert.match(report.notes[0], /no subscription windows/);
});

test("the report says when a provider has no percentage windows or no data", () => {
	const budgetOnly: Array<[string, LimitSnapshot]> = [["anthropic", snapshot([
		{ label: "", kind: "budget", remainingText: "$87.50/$100", resetMs: RESET, resetApprox: true },
	])]];
	const report = usageReport(budgetOnly, SONNET, ON, { window: "7d", pct: 60 }, NOW, false, "UTC");
	assert.equal(report.limits.length, 1);
	assert.equal(report.limits[0].kind, "budget");
	assert.equal(report.limits[0].reset?.resetApprox, true);
	assert.match(report.notes[0], /no subscription windows/);
	assert.match(report.notes[1], /budget targets window "7d"/);
	const empty = usageReport([], SONNET, ON, undefined, NOW, false, "UTC");
	assert.match(empty.notes[0], /No usage data yet for anthropic/);
});
