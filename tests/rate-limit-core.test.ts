import assert from "node:assert/strict";
import { test } from "node:test";
import { captureLimit, failureMessage, parseRateLimit, planWait, resumedMessage, scopeFor, sameScope } from "../lib/rate-limit-recovery/core.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "../lib/rate-limit-recovery/config.ts";

const NOW = Date.parse("2026-09-30T02:00:00.000Z");
const error = (retry_after: unknown = 9905, type = "rate_limit_error") => JSON.stringify({ type: "error", error: { type, message: "upstream arbitrary text", retry_after } });
const model = { provider: "anthropic", model: "claude-opus-5-5", api: "anthropic-messages" };
const captured = () => captureLimit(model, parseRateLimit(error())!, NOW);

test("recognizes structured rate limits with seconds at either supported level", () => {
	assert.deepEqual(parseRateLimit(error()), { retryAfterSeconds: 9905 });
	assert.deepEqual(parseRateLimit(`Error: 429 ${error(0.25)}`), { retryAfterSeconds: 0.25 });
	assert.deepEqual(parseRateLimit(JSON.stringify({ type: "error", error: { type: "rate_limit_error" }, retry_after: 12 })), { retryAfterSeconds: 12 });
	assert.deepEqual(parseRateLimit(JSON.stringify({ type: "rate_limit_error", retry_after: 0 })), { retryAfterSeconds: 0 });
});

test("rejects unrelated or oversized bodies and does not guess timing", () => {
	for (const text of [undefined, {}, "rate limit in 2 hours", "{", error(1, "authentication_error"), "x".repeat(40_000) + error()]) {
		assert.equal(parseRateLimit(text), undefined);
	}
	for (const seconds of ["9905", -1, null, true, Number.MAX_VALUE]) {
		assert.deepEqual(parseRateLimit(error(seconds)), {});
	}
	assert.deepEqual(parseRateLimit(JSON.stringify({ error: { type: "rate_limit_error", retryAfterMs: 10_000 } })), {});
});

test("captures a reset estimate without retaining untrusted provider text", () => {
	const limit = captured();
	assert.equal(limit.resetAtMs, NOW + 9_905_000);
	assert.equal(limit.scope, "anthropic");
	assert.ok(!JSON.stringify(limit).includes("upstream arbitrary text"));
	const warning = failureMessage(limit, NOW, "Automatic waiting is off.");
	assert.match(warning, /quota exceeded.*anthropic/i);
	assert.match(warning, /2026-09-30T04:45:05.000Z/);
	assert.match(warning, /9905 seconds/);
	assert.match(warning, /expected/i);
	assert.ok(!warning.includes("upstream arbitrary text"));
	assert.match(failureMessage(captureLimit(model, {}, NOW), NOW, "Subagents never wait."), /reset time is unknown/i);
});

test("Anthropic aliases and Claude model switches share cooldown scope", () => {
	assert.equal(scopeFor(model), "anthropic");
	for (const selected of [
		{ provider: "anthropic", id: "claude-sonnet-5-5" },
		{ provider: "meridian", id: "some-alias", api: "anthropic-messages" },
		{ provider: "openrouter", id: "anthropic/claude-sonnet", api: "openai-completions" },
	]) assert.equal(sameScope("anthropic", selected), true);
	assert.equal(sameScope("anthropic", { provider: "openai-codex", id: "gpt-6" }), false);
	assert.equal(sameScope("provider:other", { provider: "other", id: "new-model" }), true);
	assert.equal(sameScope("provider:other", { provider: "third", id: "old-model" }), false);
});

test("planning includes the safety margin and never clamps an excessive wait", () => {
	const config = { ...DEFAULT_CONFIG, autoWait: true };
	assert.deepEqual(planWait(captured(), config, 0, 0, NOW), {
		delayMs: 9_915_000, pausedAtMs: NOW, resumeAtMs: NOW + 9_915_000,
	});
	const atCap = captureLimit(model, { retryAfterSeconds: 18_000 }, NOW);
	assert.equal(planWait(atCap, config, 0, 0, NOW), "too-long");
	assert.equal(planWait(captured(), config, 0, 3, NOW), "attempt-limit");
	assert.equal(planWait(captured(), config, 10_000_000, 1, NOW), "wait-budget");
	assert.equal(planWait(captureLimit(model, {}, NOW), config, 0, 0, NOW), "unknown-reset");
});

test("remaining time accounts for time already elapsed after the rejection", () => {
	const config = { ...DEFAULT_CONFIG, autoWait: true };
	const next = planWait(captured(), config, 0, 0, NOW + 5_000);
	assert.equal(typeof next, "object");
	if (typeof next === "object") assert.equal(next.delayMs, 9_910_000);
});

test("the resume notice reports measured elapsed time and both unambiguous timestamps", () => {
	const content = resumedMessage(captured(), NOW, NOW + 9_920_234, { provider: "anthropic", id: "claude-sonnet-5-5" });
	assert.match(content, /9920.234 seconds/);
	assert.match(content, /Paused at: 2026-09-30T02:00:00.000Z/);
	assert.match(content, /Resumed at: 2026-09-30T04:45:20.234Z/);
	assert.match(content, /claude-opus-5-5/);
	assert.match(content, /claude-sonnet-5-5/);
	assert.match(content, /newer user instructions/i);
});

test("configuration is opt-in and bounded, with defensive immutable defaults", () => {
	assert.equal(normalizeConfig({}).autoWait, false);
	assert.deepEqual(normalizeConfig({ autoWait: true, resumeMarginSeconds: 0 }), { ...DEFAULT_CONFIG, autoWait: true, resumeMarginSeconds: 0 });
	assert.deepEqual(normalizeConfig({ maxWaitSeconds: -1, maxRecoveries: Infinity, resumeMarginSeconds: "10" }), DEFAULT_CONFIG);
	assert.equal(normalizeConfig({ maxWaitSeconds: Number.MAX_VALUE }).maxWaitSeconds, DEFAULT_CONFIG.maxWaitSeconds);
	assert.equal(normalizeConfig({ maxWaitSeconds: 18_001 }).maxWaitSeconds, 18_000);
	assert.equal(normalizeConfig({ maxWaitSeconds: 604_800 }).maxWaitSeconds, 18_000);
	assert.equal(normalizeConfig({ maxRecoveries: 0 }).maxRecoveries, 0);
	assert.notEqual(normalizeConfig({}), DEFAULT_CONFIG);
});

test("the Anthropic stall watchdog is on by default, bounded, and 0 disables it", () => {
	assert.equal(DEFAULT_CONFIG.anthropicFirstEventSeconds, 45);
	assert.equal(normalizeConfig({ anthropicFirstEventSeconds: 0 }).anthropicFirstEventSeconds, 0);
	assert.equal(normalizeConfig({ anthropicFirstEventSeconds: 10 }).anthropicFirstEventSeconds, 10);
	assert.equal(normalizeConfig({ anthropicFirstEventSeconds: 600 }).anthropicFirstEventSeconds, 600);
	for (const invalid of [5, 601, -1, "30", Infinity, null]) assert.equal(normalizeConfig({ anthropicFirstEventSeconds: invalid }).anthropicFirstEventSeconds, 45);
});
