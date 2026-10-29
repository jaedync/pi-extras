import { test } from "node:test";
import assert from "node:assert/strict";
import type { LimitSnapshot } from "../lib/limit-store.ts";
import { createLimitStore } from "../lib/limit-store.ts";
import { limitKey, noteAnthropicApiKey, planBilled } from "../lib/plan-billing.ts";
import { scopeFor } from "../lib/rate-limit-recovery/core.ts";
import { windowReading } from "../lib/subagents/windows.ts";
import { DEFAULT_GUARD_CONFIG, pendingWarnings, unavailableLimits, usageReport } from "../lib/usage-guard-core.ts";
import { pollAnthropicUsage } from "../lib/status-plus-limits.ts";
import { openaiLogin } from "./support/plan-login.ts";

const NOW = 1_800_000_000_000;
const ON = { ...DEFAULT_GUARD_CONFIG, enabled: true };
const snap = (usedPct: number): LimitSnapshot => ({ entries: [{ label: "7d", key: "seven_day", usedPct, resetMs: NOW + 3_600_000 }], atMs: NOW - 1000, source: "poll" });

test("subscription logins bill their family's plan; API keys bill per token", (t) => {
	for (const id of ["claude-code", "meridian", "openai-codex", "anthropic", "openrouter"]) assert.equal(planBilled(id), true, id);
	openaiLogin(t, "oauth");
	assert.equal(planBilled("openai"), true);
	assert.equal(limitKey("openai"), "openai-codex");
	openaiLogin(t, "api_key");
	assert.equal(planBilled("openai"), false);
	assert.equal(limitKey("openai"), "openai");
	noteAnthropicApiKey(true);
	t.after(() => noteAnthropicApiKey(false));
	assert.equal(planBilled("anthropic"), false);
	assert.equal(limitKey("anthropic"), "anthropic:api-key");
	assert.equal(limitKey("claude-code"), "anthropic");
});

test("an openai API-key model gets no Codex plan limits, window reading or cooldown", (t) => {
	openaiLogin(t, "api_key");
	const model = { provider: "openai", id: "gpt-6.1-sol" };
	const snapshots: Array<[string, LimitSnapshot]> = [["openai-codex", snap(96)]];
	const report = usageReport(snapshots, model, ON, undefined, NOW, true);
	assert.ok(report.limits.every((limit) => !limit.applies), JSON.stringify(report.limits));
	assert.deepEqual(pendingWarnings(snapshots, model, ON, undefined, new Set(), NOW), []);
	assert.deepEqual(Object.keys(unavailableLimits([model], snapshots)), ["openai"]);
	const found = windowReading((provider) => new Map(snapshots).get(provider), "openai/gpt-6.1-sol", NOW);
	assert.ok("why" in found, JSON.stringify(found));
	assert.notEqual(scopeFor(model), scopeFor({ provider: "openai-codex", id: "gpt-6-luna" }));
	// The store keeps its own readings apart from the plan's.
	const store = createLimitStore();
	store.set("openai-codex", snap(96));
	assert.equal(store.get(limitKey("openai")), undefined);
});

test("an anthropic API key gets no plan limits, while claude-code keeps them", async (t) => {
	t.after(() => noteAnthropicApiKey(false));
	const fetchImpl = async () => new Response(JSON.stringify({ seven_day: { utilization: 96 } }));
	const ctx = { modelRegistry: { getApiKeyForProvider: async () => "sk-ant-api03-test", getProvider: () => undefined } };
	await pollAnthropicUsage(ctx, fetchImpl, () => ({ token: "cc-test-token" }));
	assert.equal(planBilled("anthropic"), false, "the poll notes that Pi's anthropic credential is an API key");
	const snapshots: Array<[string, LimitSnapshot]> = [["anthropic", snap(96)]];
	const api = { provider: "anthropic", id: "claude-opus-5-5" };
	assert.ok(usageReport(snapshots, api, ON, undefined, NOW, true).limits.every((limit) => !limit.applies));
	assert.ok("why" in windowReading((provider) => new Map(snapshots).get(provider), "anthropic/claude-opus-5-5", NOW));
	assert.notEqual(scopeFor({ ...api, api: "anthropic-messages" }), scopeFor({ provider: "claude-code", id: "claude-opus-5-5" }), "an API key keeps its own cooldown");
	const plan = usageReport(snapshots, { provider: "claude-code", id: "claude-opus-5-5" }, ON, undefined, NOW, true);
	assert.ok(plan.limits.some((limit) => limit.applies));
	// A proxy route, or an OAuth login, is the plan again.
	await pollAnthropicUsage({ modelRegistry: { getApiKeyForProvider: async () => "pi-oauth-token", getProvider: () => undefined } }, fetchImpl, () => undefined);
	assert.equal(planBilled("anthropic"), true);
});
