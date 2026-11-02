import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, defaultFits, MIN_CALIBRATION_TOKENS, summaryChars, tokenRatio } from "../lib/cache-compaction/bounded.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (chars: number, at = 1) => ({ role: "user" as const, content: "x".repeat(chars), timestamp: at });
const reply = (usage: Partial<typeof zero>, stopReason = "stop") => ({ role: "assistant" as const, api: "openai-completions", provider: "p", model: "m", content: [{ type: "text" as const, text: "ok" }], stopReason, timestamp: 2, usage: { ...zero, ...usage } }) as any;

test("token ratio compares the provider's prompt count with Pi's estimate of the same messages", () => {
	const before = user(4 * 50_000);
	assert.equal(tokenRatio([before, reply({ cacheRead: 70_000 })]), 1.4, "cache fields count when input is 0");
	assert.equal(tokenRatio([before, reply({ input: 30_000, cacheWrite: 40_000 })]), 1.4);
	assert.equal(tokenRatio([before, reply({ cacheRead: 70_000 }), user(10), reply({}, "error")]), 1.4, "a failed reply has no usage to learn from");
	assert.equal(tokenRatio([before, reply({ cacheRead: 500_000 })]), 2, "clamped above");
	assert.equal(tokenRatio([before, reply({ cacheRead: 20_000 })]), 1, "never below Pi's own estimate");
	assert.equal(tokenRatio([user(4 * (MIN_CALIBRATION_TOKENS - 1)), reply({ cacheRead: 30_000 })]), 1, "tool schemas dominate small prompts");
	assert.equal(tokenRatio([before]), 1);
	const thinking = { ...reply({ cacheRead: 35_000 }), content: [{ type: "thinking", thinking: "t".repeat(4 * 50_000) }, { type: "text", text: "ok" }] };
	assert.ok(Math.abs(tokenRatio([before, thinking, user(10), reply({ cacheRead: 70_000 })]) - 1.4) < 0.001, "reasoning that a template drops is not in the estimate");
});

test("the default summary fits only if its real count plus pi-ai's clamped max_tokens stays in the window", () => {
	const model = { contextWindow: 100_000, maxTokens: 32_768 };
	// 79k real tokens at 1.4: the stalled request shape.
	assert.equal(defaultFits(226_000, model, 1.4), false);
	assert.equal(defaultFits(226_000, model, 1), true, "Pi's estimate alone would send it");
	assert.equal(defaultFits(40_000, model, 1.4), true);
	assert.equal(defaultFits(380_000, model, 1), false, "the clamp leaves no room for a summary");
});

test("chunks keep message order, stay under the budget, and refuse a message that alone is too large", () => {
	const messages = [user(1000, 1), user(1000, 2), user(1000, 3)];
	const one = summaryChars([messages[0]]) - summaryChars([]);
	const chunks = chunk(messages, 2 * one + 10)!;
	assert.deepEqual(chunks.map((part) => part.length), [2, 1]);
	assert.deepEqual(chunks.flat(), messages);
	assert.equal(chunk(messages, 10), undefined);
});
