import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAIN_ENTRY } from "../lib/chain/run.ts";
import { slimRecord } from "../lib/status-plus-slim.ts";
import { messageIdentity } from "../lib/status-plus-usage.ts";
import type { BranchEntry } from "../lib/status-plus-transcript.ts";

const T = 1_750_000_000_000;
const at = new Date(T).toISOString();
const long = (letter: string) => letter.repeat(5000);
const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } };

test("a reply keeps its usage, tool calls and identity, not its text", () => {
	const reply = { type: "message", id: "a1", parentId: "u1", timestamp: at, message: {
		role: "assistant", provider: "anthropic", model: "m", timestamp: T, responseId: "resp-1", stopReason: "toolUse", usage,
		content: [
			{ type: "thinking", thinking: long("t") },
			{ type: "text", text: long("x") },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls && pwd" } },
			{ type: "toolCall", id: "c2", name: "write", arguments: { path: "/a", content: long("w") } },
		],
	} };
	const slim = slimRecord(reply) as BranchEntry & { message: { content: unknown; usage: unknown } };
	assert.ok(JSON.stringify(slim).length < 600);
	assert.deepEqual(slim.message.content, [
		{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls && pwd" } },
		{ type: "toolCall", id: "c2", name: "write" },
	]);
	assert.deepEqual(slim.message.usage, usage);
	const prompt = { type: "message", id: "u1", timestamp: at, message: { role: "user", timestamp: T, content: long("p") } };
	for (const entry of [reply, prompt]) {
		const kept = slimRecord(entry) as BranchEntry;
		for (const [withId, owner] of [[true, "parent"], [true, "child.jsonl"], [false, "parent"]] as const) {
			assert.equal(messageIdentity(kept, withId, owner), messageIdentity(entry as BranchEntry, withId, owner));
		}
	}
});

test("tool output goes; subagent results, script calls and the entries a walk counts stay", () => {
	const read = { type: "message", id: "r1", timestamp: at, message: {
		role: "toolResult", toolCallId: "c1", toolName: "read", timestamp: T, isError: false,
		content: [{ type: "text", text: long("x") }], details: { diff: long("d") },
	} };
	assert.deepEqual(slimRecord(read), { type: "message", id: "r1", timestamp: at, message: { role: "toolResult", toolCallId: "c1", toolName: "read", timestamp: T, isError: false } });

	const script = { type: "message", id: "r2", timestamp: at, message: {
		role: "toolResult", toolCallId: "c2", toolName: "codemode", timestamp: T, content: [{ type: "text", text: long("x") }],
		nestedCalls: { complete: true, calls: [{ id: "n1", name: "bash", arguments: { command: "a; b" }, error: long("e") }, { id: "n2", name: "read", arguments: { path: long("p") } }] },
	} };
	assert.deepEqual((slimRecord(script) as { message: { nestedCalls: unknown } }).message.nestedCalls,
		{ calls: [{ id: "n1", name: "bash", arguments: { command: "a; b" } }, { id: "n2", name: "read" }] });

	const spawn = { type: "message", id: "r3", timestamp: at, message: {
		role: "toolResult", toolCallId: "c3", toolName: "subagent", timestamp: T,
		content: [{ type: "text", text: "Started worker." }], details: { name: "worker", sessionFile: "/s/worker.jsonl" },
	} };
	const notice = { type: "custom_message", id: "m1", timestamp: at, customType: "subagent-notify", content: `run x finished`, details: { runId: "x" }, display: true };
	const chain = { type: "custom", id: "m2", timestamp: at, customType: CHAIN_ENTRY, data: { toolCallId: "c1", ran: 2 } };
	const billing = { type: "custom", id: "m3", timestamp: at, customType: "status-plus-billing-source", data: { messageTimestampMs: T, provider: "opencode" } };
	for (const kept of [spawn, notice, chain, billing]) assert.deepEqual(slimRecord(kept), kept);
	assert.equal(slimRecord({ type: "custom", id: "m4", timestamp: at, customType: "voice-state", data: { audio: long("a") } }), undefined);
	assert.equal(slimRecord({ type: "label", id: "m5", timestamp: at, label: "x" }), undefined);

	assert.deepEqual(slimRecord({ type: "compaction", id: "k1", timestamp: at, summary: long("s"), firstKeptEntryId: "a1", tokensBefore: 9, usage }),
		{ type: "compaction", id: "k1", timestamp: at, usage });
	const model = { type: "model_change", id: "k2", timestamp: at, provider: "openai", modelId: "gpt" };
	assert.deepEqual(slimRecord(model), model);
	const refresh = { type: "usage", id: "k3", timestamp: at, kind: "cache_warm", provider: "anthropic", model: "m", usage };
	assert.deepEqual(slimRecord(refresh), refresh);
	assert.deepEqual(slimRecord({ type: "session", version: 3, id: "s1", timestamp: at, cwd: "/w", parentSession: "/p.jsonl" }),
		{ type: "session", id: "s1", timestamp: at, parentSession: "/p.jsonl" });
});

test("artifact transcript messages are kept like session messages; their other records are not", () => {
	const record = { recordType: "message", sourceEventType: "message_end", timestamp: at, message: { role: "user", timestamp: T, content: long("p") } };
	const slim = slimRecord(record) as { recordType: string; sourceEventType: string; message: { content: unknown } };
	assert.deepEqual([slim.recordType, slim.sourceEventType, slim.message.content], ["message", "message_end", []]);
	assert.equal(slimRecord({ recordType: "tool_start", timestamp: at, args: long("a") }), undefined);
	assert.equal(slimRecord("not a record"), undefined);
});
