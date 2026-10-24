import { test } from "node:test";
import assert from "node:assert/strict";
import type { LimitSnapshot } from "../lib/limit-store.ts";
import type { LimitEntry } from "../lib/status-plus-logic.ts";
import { DEFAULT_GUARD_CONFIG, pendingWarnings, usageReport, warningApplies, type SessionBudget } from "../lib/usage-guard-core.ts";

const NOW = Date.UTC(2026, 9, 12, 12);
const DAY = 86_400_000;
const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const ON = { ...DEFAULT_GUARD_CONFIG, enabled: true };
const snap = (entries: LimitEntry[], atMs = NOW): LimitSnapshot => ({ entries, atMs, source: "poll" });
const week = (usedPct: number): LimitEntry => ({ label: "7d", key: "seven_day", windowSeconds: 604_800, usedPct, resetMs: NOW + 5 * DAY });

function notice(entries: LimitEntry[], budget?: SessionBudget, config = DEFAULT_GUARD_CONFIG) {
	const [warning] = pendingWarnings([["anthropic", snap(entries)]], OPUS, config, budget, new Set(), NOW);
	assert.ok(warning, "a warning fires");
	return { key: warning.key, provider: warning.provider, threshold: warning.threshold, reason: warning.reason, final: warning.final };
}

test("a budget notice lapses when the budget is cleared or changed", () => {
	const budget = { window: "7d", pct: 60 };
	const details = notice([week(61)], budget);
	const live = snap([week(62)]);
	assert.equal(warningApplies(details, OPUS, NOW + DAY, live, budget), true);
	assert.equal(warningApplies(details, OPUS, NOW + DAY, live, null), false);
	// A caller that does not know the budget keeps the notice.
	assert.equal(warningApplies(details, OPUS, NOW + DAY, live), true);
	assert.equal(warningApplies(details, OPUS, NOW + DAY, live, { window: "7d", pct: 80 }), false);
	assert.equal(warningApplies(details, OPUS, NOW + DAY, live, { window: "seven_day", pct: 60 }), true);
});

test("a band or budget notice lapses when the live window falls below it, as after a granted reset", () => {
	const band = notice([week(96)], undefined, ON);
	assert.equal(warningApplies(band, OPUS, NOW + 3_600_000, snap([week(96)])), true);
	assert.equal(warningApplies(band, OPUS, NOW + 3_600_000, snap([week(2)])), false);
	const budget = { window: "7d", pct: 60 };
	const stop = notice([week(61)], budget);
	assert.equal(warningApplies(stop, OPUS, NOW + 3_600_000, snap([week(3)]), budget), false);
});

test("a notice for a window with no reset time lapses when the window falls below it or its reset passes", () => {
	const noReset: LimitEntry = { label: "5h", key: "five_hour", usedPct: 96 };
	const details = notice([noReset], undefined, ON);
	assert.match(details.key, /\|none$/);
	assert.equal(warningApplies(details, OPUS, NOW + DAY, snap([noReset])), true);
	assert.equal(warningApplies(details, OPUS, NOW + 30 * DAY, snap([{ ...noReset, usedPct: 0 }])), false);
	assert.equal(warningApplies(details, OPUS, NOW + DAY, snap([{ ...noReset, resetMs: NOW + 1000 }])), false);
});

test("the usage report does not call a window that already reset exhausted or waitable", () => {
	const entries: LimitEntry[] = [
		{ label: "5h", key: "rolling", windowSeconds: 18_000, usedPct: 100, exhausted: true, resetMs: NOW - 20 * 60_000 },
		{ label: "7d", key: "weekly", windowSeconds: 604_800, usedPct: 40, exhausted: false, resetMs: NOW + 3 * DAY },
	];
	const report = usageReport([["opencode-go", snap(entries, NOW - 40 * 60_000)]], { provider: "opencode-go", id: "glm-5.3" }, DEFAULT_GUARD_CONFIG, undefined, NOW);
	const [rolling] = report.limits;
	assert.equal(rolling.status, "reset");
	assert.equal(rolling.reset?.waitable, false);
	assert.ok(report.notes.some((note) => /already reset/.test(note)));
});

test("the no-data note offers refresh only for a provider that can be polled", () => {
	const none = usageReport([], { provider: "groq", id: "llama" }, DEFAULT_GUARD_CONFIG, undefined, NOW);
	assert.doesNotMatch(none.notes.join(" "), /refresh: true/);
	assert.match(none.notes.join(" "), /response headers/);
	const anthropic = usageReport([], OPUS, DEFAULT_GUARD_CONFIG, undefined, NOW);
	assert.match(anthropic.notes.join(" "), /refresh: true/);
	// Sign in with ChatGPT has a poller, but only through a second login: the note says which.
	const openai = usageReport([], { provider: "openai", id: "gpt-6.1-sol" }, DEFAULT_GUARD_CONFIG, undefined, NOW);
	assert.match(openai.notes.join(" "), /\/login openai-codex/);
});
