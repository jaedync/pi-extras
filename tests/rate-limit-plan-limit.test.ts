import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import recovery from "../extensions/rate-limit-recovery.ts";
import { createLimitStore } from "../lib/limit-store.ts";
import { openaiLogin } from "./support/plan-login.ts";
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

test("plan-limit text: Sign in with ChatGPT's code and recorded prose; not Pi's Codex text or a workspace admin limit", () => {
	assert.equal(isPlanLimitText(RECORDED), true);
	assert.equal(isPlanLimitText(`subscription_sharing_usage_limit_exceeded: ${RECORDED}`), true);
	// Pi writes this for every Codex 429, so a Codex limit needs the transport's structure.
	assert.equal(isPlanLimitText("You have hit your ChatGPT usage limit (plus plan). Try again in ~95 min."), false);
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

// The controller with a fake Pi: the order of events around the forced plan poll.
type Handler = (event: any, ctx: any) => any;
function controller(t: { after(fn: () => void): void }, config: Record<string, unknown>, mode = "tui", refresh: () => Promise<void> = async () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "plan-controller-"));
	const file = join(dir, "pi-extras.json");
	writeFileSync(file, JSON.stringify({ rateLimitRecovery: config }));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const handlers = new Map<string, Handler>();
	const limits = createLimitStore();
	const polls: string[] = [];
	limits.setRefresher(async (provider) => { polls.push(provider); await refresh(); });
	let controller = new AbortController();
	const provider = { id: "openai", name: "openai", stream() {}, streamSimple() {} };
	const ctx = {
		mode, hasUI: mode === "tui", get signal() { return controller.signal; },
		model: { provider: "openai", api: "openai-responses", id: "gpt-6.2-sol" },
		modelRegistry: { getProvider: () => provider, getRegisteredNativeProvider: () => provider, getRegisteredProviderConfig: () => undefined, registerProvider() {}, unregisterProvider() {} },
		sessionManager: { getBranch: () => [] },
		abort() { controller.abort(); },
		ui: { notify() {}, setWidget() {}, getEditorText: () => "", onTerminalInput: () => () => {} },
	};
	recovery({ on: (name: string, handler: Handler) => handlers.set(name, handler), appendEntry() {}, registerCommand() {}, sendMessage() {} } as never,
		{ configFile: file, env: {}, limits, wait: async () => true });
	const emit = (name: string, event: any = {}) => Promise.resolve(handlers.get(name)?.(event, ctx));
	const failure = { role: "assistant", provider: "openai", api: "openai-responses", model: "gpt-6.2-sol", content: [], stopReason: "error", errorMessage: `subscription_sharing_usage_limit_exceeded: ${RECORDED}`, timestamp: Date.now() };
	return { emit, polls, failure, ctx, newRun() { controller = new AbortController(); } };
}

test("no forced poll when no wait can follow: waiting off, or not an interactive session", async (t) => {
	openaiLogin(t);
	for (const [config, mode] of [[{ autoWait: false }, "tui"], [{ autoWait: true }, "print"]] as const) {
		const f = controller(t, config, mode);
		await f.emit("session_start");
		const result = await f.emit("message_end", { message: f.failure });
		assert.deepEqual(f.polls, [], `${JSON.stringify(config)} ${mode}`);
		assert.match(result.message.errorMessage, /ChatGPT plan usage limit was reached/);
		assert.doesNotMatch(result.message.errorMessage, /Subscription Sharing/);
	}
});

test("Esc during the forced poll ends the hold at once", async (t) => {
	openaiLogin(t);
	const f = controller(t, { autoWait: true }, "tui", () => new Promise(() => {}));
	await f.emit("session_start");
	const started = Date.now();
	setTimeout(() => f.ctx.abort(), 50);
	await f.emit("message_end", { message: f.failure });
	assert.ok(Date.now() - started < 1000, `held ${Date.now() - started} ms after the abort`);
});

test("a session that ends and starts again during the poll gets no limit from the old run", async (t) => {
	openaiLogin(t);
	let release = () => {};
	const f = controller(t, { autoWait: true }, "tui", () => new Promise<void>((resolve) => { release = resolve; }));
	await f.emit("session_start");
	const pending = f.emit("message_end", { message: f.failure });
	await new Promise((resolve) => setImmediate(resolve));
	await f.emit("session_shutdown");
	await f.emit("session_start");
	release();
	assert.equal(await pending, undefined);
	assert.equal(await f.emit("cache_warming_decision"), undefined, "the new session keeps warming its cache");
});
