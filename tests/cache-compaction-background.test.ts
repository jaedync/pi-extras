import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, isMeridian } from "../lib/cache-compaction/core.ts";
import { BACKGROUND_SESSION_SUFFIX, DEFAULT_BACKGROUND_PERCENT, backgroundDue, backgroundHeaders, backgroundInstruction, fileOpsOf, tailFits } from "../lib/cache-compaction/background.ts";

test("background compaction is opt-in, with a validated start percent", () => {
	assert.equal(loadConfig({}).background, false);
	assert.equal(loadConfig({}).backgroundPercent, DEFAULT_BACKGROUND_PERCENT);
	assert.equal(DEFAULT_BACKGROUND_PERCENT, 90);
	assert.equal(loadConfig({ background: true, backgroundPercent: 75 }).background, true);
	assert.equal(loadConfig({ background: true, backgroundPercent: 75 }).backgroundPercent, 75);
	for (const bad of [49, 100, 80.5, "85", null, -1]) assert.equal(loadConfig({ backgroundPercent: bad }).backgroundPercent, DEFAULT_BACKGROUND_PERCENT, String(bad));
	assert.equal(loadConfig({ background: "yes" }).background, false);
});

test("the background summary starts from the percent up to Pi's own trigger, never past it", () => {
	// Pi compacts when tokens > window - reserve; 90% of 183,616 is 165,254.4.
	assert.equal(backgroundDue(165254, 183616, 90), false);
	assert.equal(backgroundDue(165255, 183616, 90), true);
	assert.equal(backgroundDue(183616, 183616, 90), true);
	assert.equal(backgroundDue(183617, 183616, 90), false, "Pi compacts now; a background request cannot help");
	assert.equal(backgroundDue(50000, 16000 - 16384, 90), false, "a reserve larger than the window leaves no trigger");
	assert.equal(backgroundDue(Number.NaN, 183616, 90), false);
});

test("only Meridian gets its own session key, so its turn lock never makes the main turn wait", () => {
	const meridian = { api: "anthropic-messages", baseUrl: "http://127.0.0.1:3456" };
	assert.equal(isMeridian(meridian), true);
	assert.equal(isMeridian({ api: "anthropic-messages", baseUrl: "http://localhost:3456/v1" }), true);
	assert.equal(isMeridian({ api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }), false);
	assert.equal(isMeridian({ api: "openai-completions", baseUrl: "http://127.0.0.1:3456" }), false);
	assert.deepEqual(backgroundHeaders(meridian, "s1", { "X-Session-Affinity": "s1", "x-meridian-agent": "pi" }), { "x-meridian-agent": "pi", "x-session-affinity": `s1${BACKGROUND_SESSION_SUFFIX}` });
	assert.deepEqual(backgroundHeaders(meridian, "s1", undefined), { "x-session-affinity": `s1${BACKGROUND_SESSION_SUFFIX}` });
	// Other providers route their cache by the session; a new key could miss it.
	const other = { api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
	assert.deepEqual(backgroundHeaders(other, "s1", { "x-session-affinity": "s1" }), { "x-session-affinity": "s1" });
	assert.equal(backgroundHeaders(other, "s1", undefined), undefined);
});

test("file operations come from tool calls and from the nested calls of a codemode result", () => {
	const messages: any[] = [
		{ role: "user", content: "read a.ts", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } }, { type: "toolCall", id: "2", name: "edit", arguments: { path: "b.ts" } }, { type: "toolCall", id: "3", name: "bash", arguments: { command: "ls" } }], timestamp: 2 },
		{ role: "toolResult", toolCallId: "4", toolName: "codemode", content: [], isError: false, timestamp: 3, nestedCalls: { complete: true, calls: [{ id: "n", name: "write", arguments: { path: "c.ts" }, status: "ok" }] } },
		{ role: "assistant", content: [{ type: "toolCall", id: "5", name: "read", arguments: { path: 7 } }], timestamp: 4 },
	];
	const ops = fileOpsOf(messages);
	assert.deepEqual([...ops.read], ["a.ts"]);
	assert.deepEqual([...ops.edited], ["b.ts"]);
	assert.deepEqual([...ops.written], ["c.ts"]);
});

test("the background instruction summarizes the whole transcript and keeps the request in progress", () => {
	const first = backgroundInstruction({});
	assert.match(first, /^COMPACTION CHECKPOINT REQUEST/);
	assert.match(first, /Do not call tools/);
	assert.match(first, /Summarize the whole transcript above/);
	assert.match(first, /latest user request/);
	assert.match(first, /## Goal/);
	assert.match(first, /Create a structured context checkpoint/);
	const update = backgroundInstruction({ previousSummary: true });
	assert.match(update, /Update the existing structured summary/);
	assert.doesNotMatch(update, /Create a structured context checkpoint/);
});

test("a held summary fits only when the context after it stays under half of Pi's trigger", () => {
	assert.equal(tailFits(91808, 183616), true);
	assert.equal(tailFits(91809, 183616), false);
	assert.equal(tailFits(10, -384), false);
});
