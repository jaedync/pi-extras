import assert from "node:assert/strict";
import { test } from "node:test";
import { isPlanLimitText, parsePlanHint, planHintOf, recordPlanHint, resetFromReadings, sanitizedPlanError, takePlanHint, windowName, READING_MAX_AGE_MS } from "../lib/rate-limit-recovery/plan-limit.ts";
import { isQuotaError, isTransientRateLimit } from "../lib/rate-limit-recovery/transient.ts";
import { parseRateLimit } from "../lib/rate-limit-recovery/core.ts";

const NOW = Date.parse("2026-11-17T19:00:00Z");
const HOUR = 3600_000;
const RECORDED = "The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.";

test("Codex's usage_limit_reached body gives the reset and the window; other types do not count", () => {
	const body = { error: { type: "usage_limit_reached", message: "prose", plan_type: "plus", resets_at: (NOW + 2 * HOUR) / 1000, limit_window_minutes: 300 } };
	assert.deepEqual(planHintOf(body, NOW), { type: "usage_limit_reached", resetAtMs: NOW + 2 * HOUR, windowMinutes: 300 });
	assert.deepEqual(planHintOf({ type: "error", status: 429, error: body.error }, NOW), { type: "usage_limit_reached", resetAtMs: NOW + 2 * HOUR, windowMinutes: 300 }, "the WebSocket event form");
	assert.deepEqual(planHintOf({ error: { code: "subscription_sharing_usage_limit_exceeded" } }, NOW), { type: "subscription_sharing_usage_limit_exceeded" });
	assert.deepEqual(planHintOf({ error: { type: "usage_limit_reached", resets_in_seconds: 60 } }, NOW), { type: "usage_limit_reached", resetAtMs: NOW + 60_000 });
	for (const type of ["usage_not_included", "insufficient_quota", "rate_limit_exceeded", "subscription_sharing_workplace_individual_usage_limit_exceeded"]) {
		assert.equal(planHintOf({ error: { type, resets_at: NOW / 1000 + 60 } }, NOW), undefined, type);
	}
});

test("a reset outside the clock's bounds or a bad window length is dropped, not trusted", () => {
	for (const resets_at of [(NOW - 10 * 60_000) / 1000, (NOW + 9 * 24 * HOUR) / 1000, Number.NaN, "1790000000", null]) {
		assert.equal(planHintOf({ error: { type: "usage_limit_reached", resets_at } }, NOW)?.resetAtMs, undefined, String(resets_at));
	}
	for (const limit_window_minutes of [0, -5, 1.5, 99_999_999, "300"]) {
		assert.equal(planHintOf({ error: { type: "usage_limit_reached", limit_window_minutes } }, NOW)?.windowMinutes, undefined, String(limit_window_minutes));
	}
});

test("the transport's own error keeps only validated fields and parses back", () => {
	const text = sanitizedPlanError({ type: "usage_limit_reached", resetAtMs: NOW + HOUR, windowMinutes: 300 });
	assert.equal(text, `Provider usage limit: {"type":"usage_limit_reached","resets_at":${(NOW + HOUR) / 1000},"limit_window_minutes":300}`);
	assert.deepEqual(parsePlanHint(text, NOW), { type: "usage_limit_reached", resetAtMs: NOW + HOUR, windowMinutes: 300 });
	// It stays out of the structured rate-limit path and Pi's short retries, as a quota.
	assert.equal(parseRateLimit(text), undefined);
	assert.equal(isTransientRateLimit({ stopReason: "error", errorMessage: text }), false);
	assert.equal(isQuotaError(text), true);
});

test("plan-limit text: the code, the recorded prose and Pi's Codex text; not a workspace admin limit", () => {
	assert.equal(isPlanLimitText(RECORDED), true);
	assert.equal(isPlanLimitText(`subscription_sharing_usage_limit_exceeded: ${RECORDED}`), true);
	assert.equal(isPlanLimitText("You have hit your ChatGPT usage limit (plus plan). Try again in ~95 min."), true);
	assert.equal(isPlanLimitText("subscription_sharing_workplace_individual_usage_limit_exceeded: limit"), false);
	assert.equal(isPlanLimitText("Codex error: The usage limit has been reached"), false, "bare prose needs the transport's structure");
	assert.equal(isPlanLimitText("insufficient_quota"), false);
	assert.equal(isPlanLimitText("x".repeat(40_000) + RECORDED), false);
});

test("a hint belongs to its run, is read once, and expires", (t) => {
	const run = new AbortController().signal;
	const other = new AbortController().signal;
	recordPlanHint(run, { type: "usage_limit_reached", resetAtMs: NOW });
	assert.equal(takePlanHint(other), undefined);
	assert.deepEqual(takePlanHint(run), { type: "usage_limit_reached", resetAtMs: NOW });
	assert.equal(takePlanHint(run), undefined);
	t.mock.timers.enable({ apis: ["Date"], now: NOW });
	recordPlanHint(run, { type: "usage_limit_reached" });
	t.mock.timers.tick(30_001);
	assert.equal(takePlanHint(run), undefined);
});

test("window names follow the footer's labels", () => {
	assert.deepEqual([300, 10080, 1440, 90].map(windowName), ["5h", "7d", "1d", "90m"]);
});

const entry = (over: Record<string, unknown>) => ({ label: "5h", key: "primary", usedPct: 100, exhausted: true, resetMs: NOW + HOUR, sampledMs: NOW, ...over });

test("the readings name the full window; the last reset wins when several are full", () => {
	assert.deepEqual(resetFromReadings({ entries: [entry({}), entry({ label: "7d", key: "secondary", usedPct: 50, exhausted: false, resetMs: NOW + 90 * HOUR })], atMs: NOW, source: "poll" }, NOW), { resetAtMs: NOW + HOUR, window: "5h" });
	assert.deepEqual(resetFromReadings({ entries: [entry({}), entry({ label: "7d", key: "secondary", resetMs: NOW + 50 * HOUR })], atMs: NOW, source: "poll" }, NOW), { resetAtMs: NOW + 50 * HOUR, window: "7d" });
	// Codex reports 100% while it still accepts requests: only a blocked flag or allowed=false counts.
	assert.equal(resetFromReadings({ entries: [entry({ exhausted: undefined, allowed: true })], atMs: NOW, source: "poll" }, NOW), "not-blocked");
	assert.deepEqual(resetFromReadings({ entries: [entry({ exhausted: undefined, allowed: false })], atMs: NOW, source: "poll" }, NOW), { resetAtMs: NOW + HOUR, window: "5h" });
});

test("no reading can be trusted: none, too old, stale or approximate", () => {
	assert.equal(resetFromReadings(undefined, NOW), "no-reading");
	assert.equal(resetFromReadings({ entries: [entry({ sampledMs: NOW - READING_MAX_AGE_MS - 1 })], atMs: NOW, source: "poll" }, NOW), "no-reading");
	assert.equal(resetFromReadings({ entries: [entry({ sampledMs: undefined })], atMs: NOW - READING_MAX_AGE_MS - 1, source: "poll" }, NOW), "no-reading");
	assert.equal(resetFromReadings({ entries: [entry({ stale: true })], atMs: NOW, source: "poll" }, NOW), "no-reading");
	assert.equal(resetFromReadings({ entries: [entry({ approximate: true })], atMs: NOW, source: "poll" }, NOW), "no-reading");
	assert.deepEqual(resetFromReadings({ entries: [entry({ sampledMs: NOW - READING_MAX_AGE_MS })], atMs: NOW, source: "poll" }, NOW), { resetAtMs: NOW + HOUR, window: "5h" });
});

test("a full window with no reset, or a reset already past, gives no wait", () => {
	assert.equal(resetFromReadings({ entries: [entry({ resetMs: undefined })], atMs: NOW, source: "poll" }, NOW), "no-reset");
	assert.equal(resetFromReadings({ entries: [entry({ resetMs: NOW })], atMs: NOW, source: "poll" }, NOW), "no-reset");
	assert.equal(resetFromReadings({ entries: [entry({}), entry({ label: "7d", resetMs: undefined })], atMs: NOW, source: "poll" }, NOW), "no-reset", "every full window must clear");
});
