/** OpenAI chat-completions payloads (Pi's openai-completions API), synthetic data only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { capturePayload, conversationKey, fallbackReason, idleLimitMs, loadConfig, mergePayload, payloadHashes, requestOutputLimit } from "../lib/cache-compaction/core.ts";

const API = "openai-completions";
const tools = [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
const conversation = (): Record<string, unknown>[] => [
	{ role: "system", content: "You are a synthetic coding agent." },
	{ role: "user", content: "Read notes.txt and summarize it." },
	{ role: "assistant", content: null, reasoning_content: "I should read the file first.", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"notes.txt\"}" } }] },
	{ role: "tool", content: "alpha\nbeta", tool_call_id: "call_1" },
	{ role: "user", content: [{ type: "text", text: "Also check the image." }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
];
const request = (messages = conversation(), extra: Record<string, unknown> = {}) => ({
	model: "local-256k", messages, stream: true, stream_options: { include_usage: true }, max_tokens: 32768,
	tools, reasoning_effort: "high", parallel_tool_calls: true, temperature: 0.6, ...extra,
});
const instruction = { role: "user", content: [{ type: "text", text: "COMPACTION CHECKPOINT REQUEST." }] };
const finalAnswer = { role: "assistant", content: "Notes hold alpha and beta.", reasoning_content: "Done reading." };

test("chat completions use messages as the conversation key", () => {
	assert.equal(conversationKey(API), "messages");
	assert.equal(conversationKey("mistral-conversations"), undefined);
});

test("capture keeps every prompt-shaping field once and never the transcript", () => {
	const original = request(conversation(), { tool_choice: "auto", chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } });
	const captured = capturePayload(API, original)!;
	assert.equal("messages" in captured, false);
	assert.deepEqual(captured.tools, tools);
	assert.notEqual(captured.tools, tools, "a later mutation of the live payload must not reach the capture");
	assert.equal(captured.tool_choice, "auto");
	assert.deepEqual(captured.chat_template_kwargs, { enable_thinking: true, preserve_thinking: true });
	assert.equal(capturePayload(API, { model: "m", input: [] }), undefined);
});

test("summary merge keeps system, tools, tool_choice and thinking fields, appends the instruction and takes only the new cap", () => {
	const original = request(conversation(), { tool_choice: "auto", chat_template_kwargs: { enable_thinking: true } });
	const captured = capturePayload(API, original)!;
	const prefix = payloadHashes(API, original)!;
	// pi-ai builds the summary payload without effort and with the context-clamped cap; Pi's own tool_choice is never set.
	const generated = { model: "local-256k", messages: [...conversation(), finalAnswer, instruction], stream: true, stream_options: { include_usage: true }, max_tokens: 15000, tools, tool_choice: "none" };
	const merged = mergePayload(API, captured, generated, prefix);
	const { messages, max_tokens, ...fields } = merged;
	const { messages: _old, max_tokens: _cap, ...originalFields } = original;
	assert.deepEqual(fields, originalFields, "every prompt-shaping field is the captured one");
	assert.equal(max_tokens, 15000);
	assert.equal(merged.tool_choice, "auto", "tool_choice none would drop the tool block from the rendered system prompt");
	assert.deepEqual((messages as unknown[]).slice(0, original.messages.length), original.messages);
	assert.deepEqual((messages as unknown[]).at(-1), instruction);
	assert.equal("tool_choice" in mergePayload(API, capturePayload(API, request())!, generated, prefix), false, "an absent captured tool_choice stays absent");
});

test("max_completion_tokens payloads replace that field and never add max_tokens", () => {
	const { max_tokens: _cap, ...base } = request();
	const original = { ...base, max_completion_tokens: 32768 };
	const merged = mergePayload(API, capturePayload(API, original)!, { messages: [...conversation(), instruction], max_completion_tokens: 12000 }, payloadHashes(API, original));
	assert.equal(merged.max_completion_tokens, 12000);
	assert.equal("max_tokens" in merged, false);
	assert.equal(requestOutputLimit({ max_completion_tokens: 12000 }), 12000);
});

test("prefix guard covers tool calls, tool results, reasoning and multi-part content", () => {
	const original = request();
	const prefix = payloadHashes(API, original)!;
	const changed = (index: number, patch: Record<string, unknown>) => conversation().map((message, i) => i === index ? { ...message, ...patch } : message);
	const cases: Array<[string, unknown[]]> = [
		["system text", changed(0, { content: "You are another agent." })],
		["tool call arguments", changed(2, { tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"other.txt\"}" } }] })],
		["replayed reasoning", changed(2, { reasoning_content: "Different thoughts." })],
		["reasoning field name", changed(2, { reasoning_content: undefined, reasoning: "I should read the file first." })],
		["tool result", changed(3, { content: "alpha\ngamma" })],
		["tool call id", changed(3, { tool_call_id: "call_2" })],
		["image part", changed(4, { content: [{ type: "text", text: "Also check the image." }] })],
	];
	for (const [name, messages] of cases) assert.throws(() => mergePayload(API, capturePayload(API, original)!, { messages: [...messages, instruction], max_tokens: 1000 }, prefix), /prefix-changed/, name);
	assert.doesNotThrow(() => mergePayload(API, capturePayload(API, original)!, { messages: [...conversation(), finalAnswer, instruction], max_tokens: 1000 }, prefix));
});

test("moved Anthropic-format cache markers do not break the prefix", () => {
	// pi-ai puts cache_control on the last message's text, turning string content into one text part.
	const marked = conversation().map((message, i, all) => i === all.length - 2 ? { ...message, content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }] } : message);
	const original = request(marked.slice(0, -1));
	const next = [...conversation().slice(0, -1), { role: "user", content: [{ type: "text", text: "instruction", cache_control: { type: "ephemeral" } }] }];
	assert.doesNotThrow(() => mergePayload(API, capturePayload(API, original)!, { messages: next, max_tokens: 1000 }, payloadHashes(API, original)));
	// Two text parts are a different shape, so they still count as a change.
	const split = [...conversation().slice(0, 3), { role: "tool", content: [{ type: "text", text: "alpha\n" }, { type: "text", text: "beta" }], tool_call_id: "call_1" }, instruction];
	assert.throws(() => mergePayload(API, capturePayload(API, original)!, { messages: split, max_tokens: 1000 }, payloadHashes(API, original)), /prefix-changed/);
});

test("a captured thinking budget falls back when the summary cap leaves no room", () => {
	for (const field of ["thinking_token_budget", "thinking_budget_tokens", "thinking_budget", "max_thinking_tokens"]) {
		const captured = capturePayload(API, request(conversation(), { [field]: 7000 }))!;
		assert.throws(() => mergePayload(API, captured, { messages: [instruction], max_tokens: 14000 }), /thinking-budget/, field);
		assert.equal(mergePayload(API, captured, { messages: [instruction], max_tokens: 16000 })[field], 7000, field);
	}
});

test("local OpenAI-compatible engines get a long idle default; hosted and overridden ones do not", () => {
	const local = (baseUrl: string) => idleLimitMs(loadConfig({}), { provider: "engine", api: API, baseUrl });
	for (const url of ["http://engine.example.ts.net:8000/v1", "http://127.0.0.1:8080/v1", "http://localhost:1234/v1", "http://[::1]:8000/v1", "http://10.0.0.5:8092/v1", "http://192.168.1.5/v1", "http://172.20.0.2:8000/v1", "http://100.101.102.103:8000/v1", "http://gpubox:8000/v1", "http://box.local:8000/v1", "http://[fd7a:115c:a1e0::1]:8000/v1"]) assert.equal(local(url), 25 * 60000, url);
	for (const url of ["https://api.openai.com/v1", "https://openrouter.ai/api/v1", "https://opencode.ai/zen/go/v1", "http://172.32.0.1/v1", "http://100.128.0.1/v1", "not a url", ""]) assert.equal(local(url), 4 * 60000, url);
	assert.equal(idleLimitMs(loadConfig({}), { provider: "engine", api: "anthropic-messages", baseUrl: "http://10.0.0.2:8000" }), 4 * 60000, "only chat completions gets the local default");
	assert.equal(idleLimitMs(loadConfig({ idleSeconds: { engine: 600 } }), { provider: "engine", api: API, baseUrl: "http://127.0.0.1:8080/v1" }), 600000);
});

test("chat completions no longer fall back as unsupported", () => {
	const model = { provider: "engine", id: "local-256k", api: API, contextWindow: 258048, baseUrl: "http://127.0.0.1:8000/v1" };
	const gate = { enabled: true, captured: { ...model, sessionId: "s", at: 100 }, model, sessionId: "s", now: 200, idleMs: 1000, reason: "threshold", aborted: false };
	assert.equal(fallbackReason(gate), undefined);
	assert.equal(fallbackReason({ ...gate, now: 1200 }), "cold-cache");
});
