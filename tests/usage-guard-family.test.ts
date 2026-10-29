import { test } from "node:test";
import assert from "node:assert/strict";
import type { LimitSnapshot } from "../lib/limit-store.ts";
import { openaiLogin } from "./support/plan-login.ts";
import {
	DEFAULT_GUARD_CONFIG,
	NO_ENDPOINT_REASON,
	OPENAI_METER_REASON,
	missingReason,
	pendingWarnings,
	pricedProviders,
	unavailableLimits,
	unmeteredModel,
	usageReport,
	warningApplies,
} from "../lib/usage-guard-core.ts";
import { windowReading } from "../lib/subagents/windows.ts";

const NOW = 1_800_000_000_000;
const RESET = NOW + 3_600_000;
const ON = { ...DEFAULT_GUARD_CONFIG, enabled: true };
const CLAUDE_CODE = { provider: "claude-code", id: "claude-opus-5-5" };
const BUDGET = { label: "", kind: "budget" as const, remainingText: "$369/$3000", usedUsd: 2631.04, limitUsd: 3000 };

const snap = (entries: LimitSnapshot["entries"]): LimitSnapshot => ({ entries, atMs: NOW - 10_000, source: "poll" });

test("the usage report gives a claude-code model the anthropic family's budget, and no missing reading", () => {
	const snapshots: Array<[string, LimitSnapshot]> = [["anthropic", snap([BUDGET])]];
	const unavailable = unavailableLimits([{ provider: "claude-code" }, { provider: "anthropic" }], snapshots);
	assert.deepEqual(unavailable, {});
	const report = usageReport(snapshots, CLAUDE_CODE, ON, undefined, NOW, true, "UTC", undefined, [], unavailable);
	assert.equal(report.limitsUnavailable, undefined);
	assert.deepEqual(report.limits.map((limit) => [limit.provider, limit.remaining, limit.applies]), [["anthropic", "$369/$3000", true]]);
	assert.ok(!report.notes.some((note) => /No usage data yet/.test(note)), report.notes.join("\n"));
	assert.ok(report.notes.some((note) => /reports no subscription windows/.test(note)), "a budget alone fires no warnings, and the report says so");
});

test("limitsUnavailable lists a family once, by its family id, with the most specific reason", (t) => {
	openaiLogin(t);
	assert.deepEqual(unavailableLimits([{ provider: "claude-code" }, { provider: "anthropic" }, { provider: "kimi-coding" }], []), {
		anthropic: missingReason("anthropic"),
		"kimi-coding": NO_ENDPOINT_REASON,
	});
	assert.deepEqual(unavailableLimits([{ provider: "openai-codex" }, { provider: "openai" }], []), { "openai-codex": OPENAI_METER_REASON });
	// A claude-code model has a poller through its family, so it is no longer a provider with no endpoint.
	assert.notEqual(missingReason("claude-code"), NO_ENDPOINT_REASON);
});

test("Usage Guard warns a claude-code session about the anthropic family's windows, and its notices stay valid", () => {
	const snapshots: Array<[string, LimitSnapshot]> = [["anthropic", snap([{ label: "7d", key: "seven_day", usedPct: 92, resetMs: RESET }])]];
	const warnings = pendingWarnings(snapshots, CLAUDE_CODE, ON, undefined, new Set(), NOW);
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0]!.provider, "anthropic");
	const details = { key: warnings[0]!.key, reason: "band", provider: "anthropic", threshold: warnings[0]!.threshold };
	assert.equal(warningApplies(details, CLAUDE_CODE, NOW, snapshots[0]![1]), true);
	assert.equal(warningApplies(details, { provider: "openai-codex", id: "gpt-6-luna" }, NOW, snapshots[0]![1]), false);
});

test("a claude-code subagent's maxWindowPct reads the anthropic family's window", () => {
	const store = new Map<string, LimitSnapshot>([["anthropic", snap([{ label: "5h", usedPct: 26, resetMs: RESET }, { label: "7d", usedPct: 44, resetMs: RESET }])]]);
	assert.deepEqual(windowReading((provider) => store.get(provider), "claude-code/claude-opus-5-5", NOW), { reading: { label: "anthropic 7d", pct: 44 } });
	const budgetOnly = new Map<string, LimitSnapshot>([["anthropic", snap([BUDGET])]]);
	const found = windowReading((provider) => budgetOnly.get(provider), "claude-code/claude-opus-5-5", NOW);
	assert.ok("why" in found && /anthropic reports no usage windows for claude-opus-5-5/.test(found.why), JSON.stringify(found));
});

test("a zero-cost model is metered only when another provider of its family has a priced model", () => {
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const priced = pricedProviders([
		{ provider: "anthropic", cost: { input: 5, output: 25 } },
		{ provider: "claude-code", cost: zero },
		{ provider: "openrouter", cost: { input: 1, output: 2 } },
		{ provider: "openrouter", cost: zero },
		{ provider: "fw01", cost: zero },
		{ provider: "fw01" },
	]);
	assert.equal(unmeteredModel({ provider: "claude-code", cost: zero }, priced), false, "the Anthropic plan bills it");
	assert.equal(unmeteredModel({ provider: "openrouter", cost: zero }, priced), true, "an OpenRouter :free model stays free");
	assert.equal(unmeteredModel({ provider: "fw01", cost: zero }, priced), true, "a local model next to one with no cost stays free");
	assert.equal(unmeteredModel({ provider: "anthropic", cost: { input: 5 } }, priced), false);
});
