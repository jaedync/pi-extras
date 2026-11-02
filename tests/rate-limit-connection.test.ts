import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { connectionHint } from "../lib/rate-limit-recovery/connection.ts";
import { TransientBackoff, connectionExhaustedMessage, connectionFailure, connectionWaitingMessage, isConnectionReport, isProxyTurnLimit, isQuotaError, isTransientRateLimit, planTransient } from "../lib/rate-limit-recovery/transient.ts";
import { classifyFailure } from "../lib/subagents/fallback.ts";
import { piAiRoot } from "./support/pi-runtime.mjs";

const aiDist = join(piAiRoot, "dist");
const { isRetryableAssistantError } = await import(pathToFileURL(join(aiDist, "utils/retry.js")).href);
const { isContextOverflow } = await import(pathToFileURL(join(aiDist, "utils/overflow.js")).href);

// Exact texts from op01 sessions that stopped a run until a person typed.
const CONNECTION = "Connection error.";
const TERMINATED = "terminated";
const TIMED_OUT = "Request timed out.";
const UPSTREAM_TIMEOUT = '{"type":"error","error":{"type":"upstream_timeout","message":"Upstream stalled: no data for 90001ms"}}';
const BOOKKEEPING = '{"type":"error","error":{"type":"overloaded_error","message":"Meridian\'s session bookkeeping is saturated: an active bookkeeping transaction has stalled. This is proxy load, not the request; retry shortly.","retry_after":5}}';
const ENDPOINT = '503: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}';
const ENGINE_STOPPED = '503: {"message":"no engine is serving (state stopped)","type":"engine_unavailable"}';
// Texts that must still stop the run.
const SHARING = "The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.";
const OVERFLOW = '400: {"message":"The prompt (271737 tokens) plus max_tokens (1) exceeds the context window of 262144 tokens.","type":"invalid_request_error","param":"max_tokens","code":null}';
const LUNA = "openai/gpt-6-luna is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations";
const MERIDIAN_TURNS = '{"type":"error","error":{"type":"api_error","message":"Claude Code returned an error result: Reached maximum number of turns (1)"}}';

const failed = (errorMessage: string): any => ({ role: "assistant", stopReason: "error", errorMessage, provider: "anthropic", model: "claude-opus-5-5", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const half = () => 0.5;

test("dropped connections, stalls, busy proxies and unavailable gateways are connection failures", () => {
	const cases: Record<string, string> = {
		[CONNECTION]: "dropped", [TERMINATED]: "dropped", "read ECONNRESET": "dropped", "connect ECONNREFUSED 127.0.0.1:3456": "dropped", "socket hang up": "dropped",
		[TIMED_OUT]: "slow", [UPSTREAM_TIMEOUT]: "slow",
		[BOOKKEEPING]: "busy", '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}': "busy",
		[ENDPOINT]: "down", [ENGINE_STOPPED]: "down", "502 Bad Gateway": "down", "504 Gateway Timeout": "down", '503 {"error":{"message":"The model is overloaded"}}': "down",
	};
	for (const [text, cause] of Object.entries(cases)) {
		assert.equal(connectionFailure(failed(text)), cause, text);
		assert.equal(isTransientRateLimit(failed(text)), false, `${text} is not a rate limit`);
		assert.equal(isProxyTurnLimit(failed(text)), false, `${text} is not the proxy turn limit`);
	}
});

test("quotas, usage limits, auth, context overflow and other failures are not connection failures", () => {
	for (const text of [
		SHARING, "You exceeded your current quota (insufficient_quota)", "billing hard limit", "Monthly usage limit reached",
		'{"error":{"code":"api_key_expired","message":"API key expired. Please renew the API key."}}',
		'503: {"error":{"code":"api_key_expired","message":"Service unavailable for this key"}}',
		'401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
		OVERFLOW, LUNA, MERIDIAN_TURNS,
		// Pi's own retry keeps errors outside this class.
		"500 temporary upstream failure", '503: {"message":"model not served here"}', "fetch failed",
		// A mention inside longer prose is not the transport's own report.
		"The tool printed: Connection error. Then it went on.", "Process terminated by signal",
	]) assert.equal(connectionFailure(failed(text)), undefined, text);
	assert.equal(connectionFailure({ ...failed(CONNECTION), stopReason: "aborted" }), undefined);
	assert.equal(connectionFailure({ ...failed(CONNECTION), errorMessage: undefined }), undefined);
	assert.equal(connectionFailure(failed(`${UPSTREAM_TIMEOUT}${" ".repeat(40_000)}`)), undefined, "oversized text is not scanned");
});

test("retry_after in the error body is read in seconds and clamped", () => {
	assert.equal(connectionHint(BOOKKEEPING), 5);
	assert.equal(connectionHint('{"type":"error","error":{"type":"overloaded_error","message":"busy"},"retry_after":2.5}'), 2.5);
	assert.equal(connectionHint('{"type":"error","error":{"type":"overloaded_error","message":"busy","retry_after":3600}}'), 60, "a long hint cannot hold the run");
	for (const text of [CONNECTION, UPSTREAM_TIMEOUT, '{"error":{"type":"overloaded_error","retry_after":-1}}', '{"error":{"type":"overloaded_error","retry_after":"5"}}', "{not json retry_after: 5}"]) assert.equal(connectionHint(text), undefined, text);
});

test("connection reports stop Pi's own retry and are never read as overflow, quota, rate limit or a second failure", () => {
	const plan = planTransient({ attempts: 0, spentMs: 0 }, 180_000, half);
	assert.ok(typeof plan !== "string");
	const messages = [
		...(["dropped", "slow", "busy", "down"] as const).map((cause) => connectionWaitingMessage(cause, plan, 180_000)),
		connectionExhaustedMessage("down", "budget", { attempts: 6, spentMs: 180_000 }),
		connectionExhaustedMessage("busy", "hint-too-long", { attempts: 2, spentMs: 175_000 }, 60),
		connectionExhaustedMessage("dropped", "attempts", { attempts: 30, spentMs: 600_000 }),
	];
	for (const text of messages) {
		const message = failed(text);
		assert.equal(isRetryableAssistantError(message), false, text);
		assert.equal(isContextOverflow(message, 100_000), false, text);
		assert.equal(connectionFailure(message), undefined, "a rewritten message is never handled twice");
		assert.equal(isTransientRateLimit(message), false, text);
		assert.equal(isQuotaError(text), false, text);
		assert.equal(isConnectionReport(text), true, text);
		// A subagent whose connection never came back moves on to its fallback model.
		assert.equal(classifyFailure(text)?.kind, "overloaded", text);
	}
	assert.match(messages[0]!, /^Provider connection failure: the connection dropped\. Sending the request again in 5 s \(retry 1, at most 3 min of waiting in total\)\. Esc cancels\.$/);
	assert.match(messages[4]!, /persisted after 6 automatic retries over 3 min\. .*raise transientMaxWaitSeconds/);
	assert.match(messages[5]!, /asked to wait 60 seconds/);
	assert.match(messages[6]!, /automatic retry limit of 30/);
	assert.doesNotMatch(messages[6]!, /raise/, "a bigger budget cannot help past the retry limit");
	assert.doesNotMatch(messages.join("\n"), /Meridian|bookkeeping|Endpoint/, "provider prose is not repeated");
});

function backoff(budgetMs = 180_000, random = half) {
	const waits: number[] = [];
	const b = new TransientBackoff({ budgetMs: () => budgetMs, random, wait: async (ms) => { waits.push(ms); return true; } });
	const ctx = { signal: new AbortController().signal } as never;
	const turn = (entryId: string) => ({ message: { role: "assistant", stopReason: "error" }, toolResults: [], messageEntryId: entryId, entries: [] }) as never;
	// One failed reply and its turn; true when the backoff sends the request again.
	const fail = async (text: string, id = "e") => {
		const replaced = b.messageEnd(failed(text) as never, ctx);
		const resumed = await b.turnEnd(turn(id), ctx);
		return { replaced: replaced?.errorMessage, resumed: resumed !== undefined && b.consumeReady() };
	};
	return { b, waits, ctx, fail };
}

test("each connection failure from the sessions is waited out with backoff and resumed", async () => {
	for (const text of [CONNECTION, TERMINATED, TIMED_OUT, UPSTREAM_TIMEOUT, BOOKKEEPING, ENDPOINT]) {
		const f = backoff();
		const first = await f.fail(text);
		assert.equal(first.resumed, true, text);
		assert.match(first.replaced!, /^Provider connection failure: /, text);
		const second = await f.fail(text);
		assert.equal(second.resumed, true, text);
		assert.deepEqual(f.waits, [5_000, 10_000], text);
	}
});

test("a stopped local engine is retried only within the budget, then the run stops", async () => {
	const f = backoff();
	for (let i = 0; i < 6; i++) assert.equal((await f.fail(ENGINE_STOPPED, `s${i}`)).resumed, true);
	const last = await f.fail(ENGINE_STOPPED, "s6");
	assert.equal(last.resumed, false);
	assert.match(last.replaced!, /persisted after 6 automatic retries over 3 min/);
	assert.deepEqual(f.waits, [5_000, 10_000, 20_000, 40_000, 60_000, 45_000]);
	assert.equal(f.waits.reduce((sum, ms) => sum + ms, 0), 180_000);
});

test("the body's retry_after is a floor on the next wait, and a clamped long one is refused past the budget", async () => {
	// Without the hint, jitter 0 would wait 4 s.
	const f = backoff(180_000, () => 0);
	await f.fail(BOOKKEEPING);
	assert.deepEqual(f.waits, [5_000]);
	const g = backoff(10_000, () => 0);
	const long = '{"type":"error","error":{"type":"overloaded_error","message":"busy","retry_after":3600}}';
	const refused = await g.fail(long);
	assert.equal(refused.resumed, false);
	assert.match(refused.replaced!, /asked to wait 60 seconds/);
});

test("a zero budget leaves connection failures to Pi's own retry", async () => {
	const f = backoff(0);
	assert.equal(f.b.messageEnd(failed(CONNECTION) as never, f.ctx), undefined);
	assert.deepEqual(f.waits, []);
});

test("connection failures and rate limits keep separate streaks, and other errors do not reset them", async () => {
	const f = backoff();
	await f.fail(CONNECTION);
	await f.fail(LUNA);
	// Pi's own retry owns this one; it neither waits here nor ends the connection streak.
	assert.equal(f.b.messageEnd(failed("500 temporary upstream failure") as never, f.ctx), undefined);
	await f.fail(UPSTREAM_TIMEOUT);
	await f.fail(LUNA);
	assert.deepEqual(f.waits, [5_000, 5_000, 10_000, 10_000]);
	f.b.messageEnd({ ...failed(""), stopReason: "stop", errorMessage: undefined } as never, f.ctx);
	await f.fail(CONNECTION);
	assert.deepEqual(f.waits.at(-1), 5_000, "a reply that succeeds ends the streak");
});
