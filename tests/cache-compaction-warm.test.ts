import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../lib/cache-compaction/core.ts";
import { CACHE_WARM_ENTRY, WAKE_PENDING_EVENT, WARM_INSTRUCTION, WakeSet, artifactWakes, feedbackIds, formWakeKey, retryAt, payloadThinkingBudget, cacheLifetimeMs, loadWarmConfig, readWakePending, warmCostEstimate, warmDelayMs, warmStop } from "../lib/cache-compaction/warm.ts";

test("warm config defaults on, with an 8-hour cap, a 20k floor and the Anthropic API", () => {
	assert.deepEqual(loadWarmConfig(undefined), { enabled: true, maxHours: 8, minTokens: 20000, apis: ["anthropic-messages"], formTools: ["artifact_ask"] });
	assert.deepEqual(loadConfig({}).warm, loadWarmConfig(undefined));
	assert.equal(loadConfig({ warm: { enabled: false } }).warm.enabled, false);
});

test("warm config keeps valid values and replaces bad ones with defaults", () => {
	const good = loadWarmConfig({ enabled: false, maxHours: 2.5, minTokens: 5000, apis: ["openai-responses"], formTools: ["ask_form"] });
	assert.deepEqual(good, { enabled: false, maxHours: 2.5, minTokens: 5000, apis: ["openai-responses"], formTools: ["ask_form"] });
	const bad = loadWarmConfig({ enabled: "yes", maxHours: -1, minTokens: "20", apis: "anthropic-messages", formTools: [1, "x"] });
	assert.deepEqual(bad, { enabled: true, maxHours: 8, minTokens: 20000, apis: ["anthropic-messages"], formTools: ["x"] });
	assert.deepEqual(loadWarmConfig({ formTools: "artifact_ask" }).formTools, ["artifact_ask"]);
	assert.equal(loadWarmConfig({ maxHours: 100 }).maxHours, 8, "more than 48 hours is not a wait");
	assert.equal(loadWarmConfig({ minTokens: -5 }).minTokens, 20000);
	assert.deepEqual(loadWarmConfig({ apis: [] }).apis, [], "an empty list turns warming off for every API");
});

test("the cache lifetime comes from the payload's ttl, else Meridian's one hour, else five minutes", () => {
	const long = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [] };
	const short = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "u", cache_control: { type: "ephemeral" } }] }] };
	const native = { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" };
	const meridian = { api: "anthropic-messages", baseUrl: "http://127.0.0.1:3456" };
	assert.equal(cacheLifetimeMs(long, native), 3_600_000);
	assert.equal(cacheLifetimeMs(short, native), 300_000);
	assert.equal(cacheLifetimeMs(short, meridian), 3_600_000);
	assert.equal(cacheLifetimeMs(undefined, native), 300_000);
});

test("the warm period is 90% of the lifetime with at least ten seconds of margin, like Pi's", () => {
	assert.equal(warmDelayMs(3_600_000), 3_240_000);
	assert.equal(warmDelayMs(300_000), 270_000);
	assert.equal(warmDelayMs(60_000), 50_000);
	assert.equal(warmDelayMs(10_000), undefined);
});

const cost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 };
const base = { promptTokens: 46000, cost, spent: 0, ttlMs: 3_600_000, maxHours: 8, minTokens: 20000, realAt: 0, now: 3_240_000, dueAt: 3_240_000 };

test("a warm costs a cache read of the prompt, a small written tail and a few output tokens", () => {
	const expected = (46000 * 0.5 + 1000 * 10 + 16 * 25) / 1e6;
	assert.ok(Math.abs(warmCostEstimate(46000, cost) - expected) < 1e-12);
});

test("warmStop allows a warm inside the cap with a cheaper warm than a miss", () => {
	assert.equal(warmStop(base), undefined);
});

test("warmStop stops below the token floor, at the cap, without prices and after a late timer", () => {
	assert.equal(warmStop({ ...base, promptTokens: 19999 }), "small-context");
	assert.equal(warmStop({ ...base, now: 8 * 3_600_000, dueAt: 8 * 3_600_000 }), "max-hours");
	assert.equal(warmStop({ ...base, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), "no-prices");
	// Pi's rule: a timer may run late, but past half the remaining margin the entry is likely gone.
	assert.equal(warmStop({ ...base, now: 3_240_000 + 180_001 }), "deadline-missed");
	assert.equal(warmStop({ ...base, now: 3_240_000 + 180_000 }), undefined);
});

test("warmStop stops when the warms of this wait would cost more than the miss they prevent", () => {
	const miss = 46000 * (10 - 0.5) / 1e6;
	const next = warmCostEstimate(46000, cost);
	assert.equal(warmStop({ ...base, spent: miss - next - 1e-9 }), undefined);
	assert.equal(warmStop({ ...base, spent: miss - next + 1e-9 }), "break-even");
	// A five-minute cache: break-even comes after about an hour of warms, not after eight.
	const short = { ...base, ttlMs: 300_000, maxHours: 8 };
	let spent = 0; let warms = 0;
	while (warmStop({ ...short, spent }) === undefined && warms < 1000) { spent += next; warms++; }
	assert.ok(warms * 270 / 3600 < 1.5, `stopped after ${warms} warms`);
});

test("the wake set holds keys per session and clears on demand", () => {
	const wakes = new WakeSet();
	assert.equal(wakes.size, 0);
	wakes.set("shell:1", true); wakes.set("artifact:a", true); wakes.set("artifact:b", true);
	assert.equal(wakes.size, 3);
	wakes.set("shell:1", false);
	assert.equal(wakes.size, 2);
	wakes.clearPrefix("artifact:");
	assert.equal(wakes.size, 0);
	wakes.set("x", true); wakes.clear();
	assert.equal(wakes.size, 0);
});

test("the wake-pending event contract is validated at the boundary", () => {
	assert.equal(WAKE_PENDING_EVENT, "pi-extras:wake-pending");
	assert.deepEqual(readWakePending({ sessionId: "s", key: "k", pending: true }), { sessionId: "s", key: "k", pending: true });
	for (const bad of [null, "x", { sessionId: "s", key: "k" }, { sessionId: 1, key: "k", pending: true }, { sessionId: "s", key: "", pending: false }]) assert.equal(readWakePending(bad), undefined, JSON.stringify(bad));
});

test("a watched artifact form or page marks a wake; watch false or an error does not", () => {
	const tools = ["artifact_ask", "artifact_publish"];
	assert.equal(artifactWakes(tools, "artifact_ask", { title: "t" }, false), true);
	assert.equal(artifactWakes(tools, "artifact_publish", { html: "<p>" }, false), true);
	assert.equal(artifactWakes(tools, "artifact_ask", { watch: false }, false), false);
	assert.equal(artifactWakes(tools, "artifact_ask", { title: "t" }, true), false);
	assert.equal(artifactWakes(tools, "bash", {}, false), false);
	// MCP adapters prefix tool names; the configured name is the suffix.
	assert.equal(artifactWakes(tools, "mcp__oc__artifact_ask", {}, false), true);
});

test("the warm instruction asks for one word and no tools, and the entry type is stable", () => {
	assert.match(WARM_INSTRUCTION, /Reply with the single word ok/);
	assert.match(WARM_INSTRUCTION, /Do not use tools/);
	assert.equal(CACHE_WARM_ENTRY, "pi-extras.cache-warm");
});

test("a deferred warm retries in 30-second steps until half the margin after its due time", () => {
	// One hour: due at 54 min, margin 6 min, deadline 3 min after due.
	assert.equal(retryAt(3_240_000, 3_240_000, 3_600_000), 3_270_000);
	assert.equal(retryAt(3_240_000 + 150_000, 3_240_000, 3_600_000), 3_240_000 + 180_000);
	assert.equal(retryAt(3_240_000 + 150_001, 3_240_000, 3_600_000), undefined);
	assert.equal(retryAt(0, 0, 10_000), undefined, "no warm period at all");
});

test("a thinking budget in the payload is found for each API shape", () => {
	assert.equal(payloadThinkingBudget({ thinking: { type: "enabled", budget_tokens: 1024 } }), 1024);
	assert.equal(payloadThinkingBudget({ thinking: { type: "adaptive" } }), undefined);
	assert.equal(payloadThinkingBudget({ config: { thinkingConfig: { thinkingBudget: 512 } } }), 512);
	assert.equal(payloadThinkingBudget({ thinking_token_budget: 300 }), 300);
	assert.equal(payloadThinkingBudget(undefined), undefined);
});

test("a form wake is keyed by the form's id, so its feedback can find it", () => {
	assert.equal(formWakeKey("call-1", { tool: "ask", form: { id: "f7", url: "https://artifact.test/f7", role: "form" } }), "artifact:f7");
	assert.equal(formWakeKey("call-1", { tool: "publish", pages: [{ id: "p2" }] }), "artifact:p2");
	// An older extension sends no details, and a call id is all there is.
	assert.equal(formWakeKey("call-1", {}), "artifact:call-1");
	assert.deepEqual(feedbackIds({ changes: [{ kind: "answer", artifact_id: "f7" }, { kind: "comment" }] }), ["f7"]);
	assert.deepEqual(feedbackIds(undefined), []);
});

test("feedback answers only the forms it names, and all of them when it names none", () => {
	const wakes = new WakeSet();
	wakes.set("artifact:f1", true);
	wakes.set("artifact:f2", true);
	wakes.set("background:shell", true);
	wakes.answer(["f1"]);
	assert.equal(wakes.size, 2, "the other form and the background job stay");
	wakes.answer(["f9"]);
	assert.equal(wakes.size, 1, "a form the wakes do not know clears every form");
});
