import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, defaultFits, firstAfterCompaction, MIN_CALIBRATION_TOKENS, summaryChars, tokenRatio } from "../lib/cache-compaction/bounded.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (chars: number, at = 1) => ({ role: "user" as const, content: "x".repeat(chars), timestamp: at });
const reply = (usage: Partial<typeof zero>, stopReason = "stop") => ({ role: "assistant" as const, api: "openai-completions", provider: "p", model: "m", content: [{ type: "text" as const, text: "ok" }], stopReason, timestamp: 2, usage: { ...zero, ...usage } }) as any;

const scope = { from: 0, provider: "p", id: "m", api: "openai-completions" };
test("token ratio compares the provider's prompt count with Pi's estimate of the same messages", () => {
	const before = user(4 * 50_000);
	assert.equal(tokenRatio([before, reply({ cacheRead: 70_000 })], scope), 1.4, "cache fields count when input is 0");
	assert.equal(tokenRatio([before, reply({ input: 30_000, cacheWrite: 40_000 })], scope), 1.4);
	assert.equal(tokenRatio([before, reply({ cacheRead: 70_000 }), user(10), reply({}, "error")], scope), 1.4, "a failed reply has no usage to learn from");
	assert.equal(tokenRatio([before, reply({ cacheRead: 500_000 })], scope), 2, "clamped above");
	assert.equal(tokenRatio([before, reply({ cacheRead: 20_000 })], scope), 1, "never below Pi's own estimate");
	assert.equal(tokenRatio([user(4 * (MIN_CALIBRATION_TOKENS - 1)), reply({ cacheRead: 30_000 })], scope), 1, "tool schemas dominate small prompts");
	assert.equal(tokenRatio([before], scope), 1);
});

test("reasoning leaves the estimate only on chat completions, where templates can drop it", () => {
	const before = user(4 * 50_000);
	const thinking = { ...reply({ cacheRead: 35_000 }), content: [{ type: "thinking", thinking: "t".repeat(4 * 50_000) }, { type: "text", text: "ok" }] };
	const messages = [before, thinking, user(10), reply({ cacheRead: 70_000 })];
	assert.ok(Math.abs(tokenRatio(messages, scope) - 1.4) < 0.001);
	assert.equal(tokenRatio(messages, { ...scope, api: "anthropic-messages" }), 1, "a provider that keeps reasoning counts it");
});

test("token ratio counts every system message, as a later patch carries only its changes", () => {
	const system = (chars: number) => ({ role: "system" as const, content: [{ type: "text" as const, text: "s".repeat(chars) }], timestamp: 0 }) as any;
	// A tokenizer equal to Pi's estimate: 30k system tokens, a 5k-token patch, 20k of conversation.
	const messages = [system(4 * 30_000), user(4 * 10_000), system(4 * 5_000), user(4 * 10_000), reply({ input: 55_000 })];
	assert.equal(tokenRatio(messages, scope), 1);
});

test("token ratio ignores replies before the latest compaction and replies of another model", () => {
	const before = user(4 * 50_000);
	assert.equal(tokenRatio([before, reply({ cacheRead: 70_000 })], { ...scope, from: 2 }), 1, "a kept reply carries usage from before the compaction");
	assert.equal(tokenRatio([before, reply({ cacheRead: 70_000 })], { ...scope, id: "other" }), 1);
	assert.equal(tokenRatio([before, reply({ cacheRead: 70_000 })], { ...scope, provider: "other" }), 1);
	const projection = { entries: [{ sourceEntry: { id: "c", type: "compaction" }, messages: [user(1)] }, { sourceEntry: { id: "k", type: "message" }, messages: [user(2)] }, { sourceEntry: { id: "n", type: "message" }, messages: [user(3)] }] };
	const branch = [{ id: "k", type: "message" }, { id: "c", type: "compaction" }, { id: "n", type: "message" }];
	assert.equal(firstAfterCompaction(projection as any, branch as any), 2);
	assert.equal(firstAfterCompaction({ entries: projection.entries.slice(1) } as any, [branch[0], branch[2]] as any), 0);
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
	for (const part of chunks) assert.ok(summaryChars(part) - summaryChars([]) <= 2 * one + 10, "each part stays under the budget");
});

test("a part ends before a user message or a final reply when one is near, so a tool call keeps its result", () => {
	const call = { ...reply({}), stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } }] };
	const result = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "r".repeat(900) }], isError: false, timestamp: 3 } as any;
	const messages = [user(1000, 1), reply({}), user(1000, 2), call, result, user(1000, 4)];
	const size = (part: any[]) => summaryChars(part) - summaryChars([]);
	const budget = size(messages.slice(0, 4)) + 5;
	const chunks = chunk(messages, budget)!;
	assert.deepEqual(chunks.flat(), messages);
	assert.ok(!chunks.some((part) => { const last: any = part.at(-1); return last?.role === "assistant" && last.content.some((block: any) => block.type === "toolCall"); }), "no part ends on a tool call");
});
