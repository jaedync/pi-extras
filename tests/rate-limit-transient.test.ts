import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BASE_DELAY_MS, MAX_ATTEMPTS, MAX_DELAY_MS, TransientBackoff, exhaustedMessage, isTransientRateLimit, planTransient, waitingMessage } from "../lib/rate-limit-recovery/transient.ts";
import { parseRetryAfter, recordRetryHint, takeRetryHint } from "../lib/rate-limit-recovery/retry-hint.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "../lib/rate-limit-recovery/config.ts";
import { agentRoot } from "./support/pi-runtime.mjs";

const aiDist = join(agentRoot, "node_modules/@earendil-works/pi-ai/dist");
const { isRetryableAssistantError } = await import(pathToFileURL(join(aiDist, "utils/retry.js")).href);
const { isContextOverflow } = await import(pathToFileURL(join(aiDist, "utils/overflow.js")).href);

const LUNA = "openai/gpt-6-luna is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations";
const LEGACY = '429: {"message":"Provider returned error","code":429,"metadata":{"raw":"deepseek/deepseek-v4.1-flash is temporarily rate-limited upstream. Please retry shortly","provider_name":"Novita"}}';
const failed = (errorMessage: string): any => ({ role: "assistant", stopReason: "error", errorMessage, provider: "openrouter", model: "openai/gpt-6-luna", content: [], usage: {} });
const half = () => 0.5;

test("OpenRouter upstream limits and bare 429s are transient", () => {
	for (const text of [LUNA, LEGACY, "429 Too Many Requests", "Rate limit reached for requests", "too many requests, slow down"]) assert.equal(isTransientRateLimit(failed(text)), true, text);
});

test("quotas, billing, structured quota errors and other failures are not transient", () => {
	const structured = JSON.stringify({ type: "error", error: { type: "rate_limit_error", retry_after: 30, message: "slow down" } });
	const unstructured = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
	for (const text of [
		structured, unstructured, "You exceeded your current quota (insufficient_quota)", "Request quota exceeded for openrouter: a temporary provider rate limit.",
		"Monthly usage limit reached", "billing hard limit", "Codex error: The usage limit has been reached", "529 overloaded_error", "502 Bad Gateway", "fetch failed",
	]) assert.equal(isTransientRateLimit(failed(text)), false, text);
	assert.equal(isTransientRateLimit({ ...failed(LUNA), stopReason: "aborted" }), false);
	assert.equal(isTransientRateLimit({ ...failed(LUNA), errorMessage: undefined }), false);
	assert.equal(isTransientRateLimit(failed(`${LUNA}${"x".repeat(40_000)}`)), false, "oversized text is not scanned");
});

test("backoff doubles from 5 s, caps at 60 s, jitters, and stops at the budget", () => {
	const delays: number[] = [];
	let state = { attempts: 0, spentMs: 0 };
	for (;;) {
		const plan = planTransient(state, 180_000, half);
		if (typeof plan === "string") { assert.equal(plan, "budget"); break; }
		delays.push(plan.delayMs);
		state = { attempts: plan.attempt, spentMs: state.spentMs + plan.delayMs };
	}
	// The last wait uses what remains of the budget rather than giving up early.
	assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 60_000, 45_000]);
	const low = planTransient({ attempts: 0, spentMs: 0 }, 180_000, () => 0);
	const high = planTransient({ attempts: 0, spentMs: 0 }, 180_000, () => 0.999);
	assert.ok(typeof low !== "string" && typeof high !== "string");
	assert.equal(low.delayMs, BASE_DELAY_MS * 0.8);
	assert.ok(high.delayMs > BASE_DELAY_MS * 1.19 && high.delayMs <= BASE_DELAY_MS * 1.2);
	const capped = planTransient({ attempts: 8, spentMs: 0 }, 900_000, () => 0.999);
	assert.ok(typeof capped !== "string" && capped.delayMs <= MAX_DELAY_MS * 1.2);
	assert.equal(planTransient({ attempts: MAX_ATTEMPTS, spentMs: 0 }, 900_000, half), "attempts");
	// The attempt cap is a backstop: even the largest budget runs out first.
	let longest = { attempts: 0, spentMs: 0 };
	for (let plan = planTransient(longest, 900_000, () => 0); typeof plan !== "string"; plan = planTransient(longest, 900_000, () => 0)) longest = { attempts: plan.attempt, spentMs: longest.spentMs + plan.delayMs };
	assert.ok(longest.attempts < MAX_ATTEMPTS, `${longest.attempts} attempts in 900 s`);
	assert.equal(planTransient({ attempts: 1, spentMs: 177_000 }, 180_000, half), "budget", "less than one base delay left");
});

test("a Retry-After hint is a minimum on the schedule and is refused beyond the budget", () => {
	const hinted = planTransient({ attempts: 0, spentMs: 0 }, 180_000, half, 12.2);
	assert.ok(typeof hinted !== "string");
	assert.deepEqual([hinted.delayMs, hinted.hinted], [12_200, true]);
	const short = planTransient({ attempts: 2, spentMs: 15_000 }, 180_000, half, 1);
	assert.ok(typeof short !== "string");
	assert.deepEqual([short.delayMs, short.hinted], [20_000, false], "a short hint never shortens the backoff");
	// Repeated one-second hints still use the whole budget, not ten quick attempts.
	const delays: number[] = [];
	let state = { attempts: 0, spentMs: 0 };
	for (let plan = planTransient(state, 180_000, half, 1); typeof plan !== "string"; plan = planTransient(state, 180_000, half, 1)) {
		delays.push(plan.delayMs);
		state = { attempts: plan.attempt, spentMs: state.spentMs + plan.delayMs };
	}
	assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 60_000, 45_000]);
	assert.equal(planTransient({ attempts: 0, spentMs: 0 }, 180_000, half, 600), "hint-too-long");
});

test("replacement messages stop Pi's own retry and are never read as context overflow", () => {
	const plan = planTransient({ attempts: 0, spentMs: 0 }, 180_000, half);
	assert.ok(typeof plan !== "string");
	const messages = [
		waitingMessage("openrouter/openai/gpt-6-luna", plan, 180_000),
		exhaustedMessage("openrouter/openai/gpt-6-luna", "budget", { attempts: 5, spentMs: 135_000 }),
		exhaustedMessage("openrouter/openai/gpt-6-luna", "hint-too-long", { attempts: 0, spentMs: 0 }, 600),
		exhaustedMessage("openrouter/openai/gpt-6-luna", "attempts", { attempts: 30, spentMs: 500_000 }),
	];
	for (const text of messages) {
		const message = { ...failed(text), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		assert.equal(isRetryableAssistantError(message), false, text);
		assert.equal(isContextOverflow(message, 100_000), false, text);
		assert.equal(isTransientRateLimit(message), false, "a rewritten message is never handled twice");
		assert.doesNotMatch(text, /temporarily rate-limited upstream|add your own key/, "provider prose is not repeated");
	}
	assert.match(messages[0]!, /Waiting 5 s/);
	assert.match(messages[1]!, /5 automatic retries over 2 min 15 s/);
	assert.match(messages[2]!, /asked to wait 600 seconds/);
	assert.match(messages[3]!, /automatic retry limit of 30/);
	assert.doesNotMatch(messages[3]!, /raise rateLimitRecovery/, "a bigger budget cannot help past the retry limit");
});

test("Retry-After parsing accepts seconds, milliseconds and HTTP dates within a day", () => {
	const now = Date.parse("2026-09-30T02:00:00Z");
	assert.equal(parseRetryAfter(new Headers({ "retry-after": "7" }), now), 7);
	assert.equal(parseRetryAfter(new Headers({ "retry-after": "2.5" }), now), 2.5);
	assert.equal(parseRetryAfter(new Headers({ "retry-after-ms": "1500", "retry-after": "9" }), now), 1.5);
	assert.equal(parseRetryAfter(new Headers({ "retry-after": "Wed, 30 Sep 2026 02:00:30 GMT" }), now), 30);
	assert.equal(parseRetryAfter(new Headers({ "retry-after": "Wed, 30 Sep 2026 01:59:00 GMT" }), now), 0);
	for (const value of ["-1", "soon", "", "90000", "1e3"]) assert.equal(parseRetryAfter(new Headers({ "retry-after": value }), now), undefined, value);
	assert.equal(parseRetryAfter(new Headers(), now), undefined);
});

test("a recorded hint belongs to one run, is taken once, and expires", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-30T02:00:00Z") });
	const run = new AbortController().signal;
	const concurrent = new AbortController().signal;
	recordRetryHint(run, 8);
	assert.equal(takeRetryHint(concurrent), undefined, "a parallel session on the same provider never sees it");
	assert.equal(takeRetryHint(run), 8);
	assert.equal(takeRetryHint(run), undefined);
	recordRetryHint(run, 8);
	t.mock.timers.tick(31_000);
	assert.equal(takeRetryHint(run), undefined);
	recordRetryHint(undefined, 8);
	assert.equal(takeRetryHint(undefined), undefined);
});

test("transient waiting is on by default, bounded, and 0 disables it", () => {
	assert.equal(DEFAULT_CONFIG.transientMaxWaitSeconds, 180);
	assert.equal(normalizeConfig({ transientMaxWaitSeconds: 0 }).transientMaxWaitSeconds, 0);
	assert.equal(normalizeConfig({ transientMaxWaitSeconds: 10 }).transientMaxWaitSeconds, 10);
	assert.equal(normalizeConfig({ transientMaxWaitSeconds: 900 }).transientMaxWaitSeconds, 900);
	for (const invalid of [5, 901, -1, "60", Infinity, null]) assert.equal(normalizeConfig({ transientMaxWaitSeconds: invalid }).transientMaxWaitSeconds, 180);
});

function backoff(options: { budgetMs?: number; wait?: (ms: number, signal: AbortSignal) => Promise<boolean> } = {}) {
	const waits: number[] = [];
	const b = new TransientBackoff({ budgetMs: () => options.budgetMs ?? 180_000, random: half,
		wait: options.wait ?? (async (ms) => { waits.push(ms); return true; }) });
	const controller = new AbortController();
	const ctx = { signal: controller.signal } as never;
	const turn = (entryId: string) => ({ message: { role: "assistant", stopReason: "error" }, messageEntryId: entryId, entries: [] }) as never;
	return { b, waits, ctx, controller, turn };
}

test("the backoff owns a transient error, waits, omits the failed attempt and resumes once", async () => {
	const f = backoff();
	const replaced = f.b.messageEnd(failed(LUNA) as never, f.ctx);
	assert.ok(replaced);
	assert.match(replaced.errorMessage!, /Waiting 5 s/);
	const result = await f.b.turnEnd(f.turn("entry-1"), f.ctx);
	assert.deepEqual(result, { entries: [{ type: "context_edit", targetId: "entry-1", replacement: null }] });
	assert.deepEqual(f.waits, [5_000]);
	assert.equal(f.b.consumeReady(), true);
	assert.equal(f.b.consumeReady(), false);
	// A second failure in the same streak backs off further.
	f.b.messageEnd(failed(LUNA) as never, f.ctx);
	await f.b.turnEnd(f.turn("entry-2"), f.ctx);
	assert.deepEqual(f.waits, [5_000, 10_000]);
	// Success ends the streak; the next limit starts from the base delay again.
	assert.equal(f.b.messageEnd({ ...failed(""), stopReason: "stop", errorMessage: undefined } as never, f.ctx), undefined);
	f.b.messageEnd(failed(LUNA) as never, f.ctx);
	await f.b.turnEnd(f.turn("entry-3"), f.ctx);
	assert.deepEqual(f.waits, [5_000, 10_000, 5_000]);
});

test("an exhausted budget ends the run with a non-retryable message and no wait", async () => {
	// 4 s left after the first wait is less than one base delay.
	const f = backoff({ budgetMs: 9_000 });
	f.b.messageEnd(failed(LUNA) as never, f.ctx);
	await f.b.turnEnd(f.turn("a"), f.ctx);
	f.b.consumeReady();
	const final = f.b.messageEnd(failed(LUNA) as never, f.ctx);
	assert.match(final!.errorMessage!, /persisted after 1 automatic retry over 5 s/);
	assert.equal(await f.b.turnEnd(f.turn("b"), f.ctx), undefined);
	assert.equal(f.b.consumeReady(), false);
	assert.deepEqual(f.waits, [5_000]);
});

test("disabled, uncancellable or non-transient errors are left to Pi", async () => {
	const off = backoff({ budgetMs: 0 });
	assert.equal(off.b.messageEnd(failed(LUNA) as never, off.ctx), undefined);
	const f = backoff();
	assert.equal(f.b.messageEnd(failed("502 Bad Gateway") as never, f.ctx), undefined);
	assert.equal(f.b.messageEnd(failed(LUNA) as never, {} as never), undefined, "no run signal to cancel a wait");
	f.controller.abort();
	assert.equal(f.b.messageEnd(failed(LUNA) as never, f.ctx), undefined, "already cancelled");
	assert.equal(await f.b.turnEnd(f.turn("x"), f.ctx), undefined);
});

test("cancelling during the wait ends the run without resuming", async () => {
	let started!: () => void;
	const waiting = new Promise<void>((resolve) => { started = resolve; });
	const f = backoff({ wait: (_ms, signal) => new Promise((resolve) => { started(); signal.addEventListener("abort", () => resolve(false), { once: true }); }) });
	f.b.messageEnd(failed(LUNA) as never, f.ctx);
	const result = f.b.turnEnd(f.turn("c"), f.ctx);
	await waiting;
	f.b.cancel();
	assert.equal(await result, undefined);
	assert.equal(f.b.consumeReady(), false);
});

test("skipping the wait (a model switch) resumes at once and releases the timer", async () => {
	let started!: () => void;
	let released = false;
	const waiting = new Promise<void>((resolve) => { started = resolve; });
	const f = backoff({ wait: (_ms, signal) => new Promise((resolve) => { started(); signal.addEventListener("abort", () => { released = true; resolve(false); }, { once: true }); }) });
	f.b.messageEnd(failed(LUNA) as never, f.ctx);
	const result = f.b.turnEnd(f.turn("s"), f.ctx);
	await waiting;
	assert.equal(f.b.waiting, true);
	f.b.skip();
	assert.deepEqual(await result, { entries: [{ type: "context_edit", targetId: "s", replacement: null }] });
	assert.equal(f.b.consumeReady(), true);
	assert.equal(released, true);
	assert.equal(f.b.waiting, false);
	f.b.skip();
});

test("a hint recorded for a quota error is discarded, not handed to the next limit", async () => {
	const f = backoff();
	recordRetryHint((f.ctx as any).signal, 600);
	const quota = JSON.stringify({ type: "error", error: { type: "rate_limit_error", retry_after: 600, message: "slow down" } });
	assert.equal(f.b.messageEnd(failed(quota) as never, f.ctx), undefined);
	f.b.messageEnd(failed(LUNA) as never, f.ctx);
	await f.b.turnEnd(f.turn("q"), f.ctx);
	assert.deepEqual(f.waits, [5_000]);
});

test("a Retry-After recorded by the transport sets the next wait", async () => {
	const f = backoff();
	recordRetryHint((f.ctx as any).signal, 17);
	f.b.messageEnd(failed(LUNA) as never, f.ctx);
	await f.b.turnEnd(f.turn("h"), f.ctx);
	assert.deepEqual(f.waits, [17_000]);
});
