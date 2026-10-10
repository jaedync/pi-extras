import { test } from "node:test";
import assert from "node:assert/strict";
import { activityWatch, childExtensionPaths, streamingActivity } from "../lib/subagents/child.ts";

const info = (name: string, path: string) => ({ name, sourceInfo: { path } });

test("a child loads only the extension files that own its tools, each once", () => {
	const all = [
		info("read", "builtin:read"),
		info("fetch_content", "/pkgs/web-access/index.ts"),
		info("web_search", "/pkgs/web-access/index.ts"),
		info("agent_send", "/pkgs/remote-pi/dist/index.js"),
		info("message", "<sdk:message>"),
		info("lint", "/home/u/.pi/agent/extensions/lint.ts"),
	];
	assert.deepEqual(childExtensionPaths(all, ["read", "fetch_content", "web_search", "lint", "message"]), [
		"/pkgs/web-access/index.ts",
		"/home/u/.pi/agent/extensions/lint.ts",
	]);
});

test("built-in, SDK and inline owners are never loaded as files", () => {
	const all = [info("read", "builtin:read"), info("mcp_tool", "builtin:mcp"), info("x", "<inline:x>"), info("y", "<sdk:y>")];
	assert.deepEqual(childExtensionPaths(all, ["read", "mcp_tool", "x", "y"]), []);
});

test("a tool the parent does not have loads nothing", () => {
	assert.deepEqual(childExtensionPaths([info("lint", "/e/lint.ts")], ["missing"]), []);
});

test("what a streaming reply says an agent is doing reads as main's phase line does", () => {
	const message = { content: [{ type: "text", text: "x" }, { type: "toolCall", name: "write", arguments: { path: "docs/main.md" } }, { type: "toolCall", name: "bash" }] };
	assert.deepEqual(streamingActivity({ type: "thinking_delta" }, message), { activity: "thinking", work: "thinking" });
	assert.equal(streamingActivity({ type: "thinking_start" }, message), undefined, "an empty thinking block is no thinking yet");
	assert.deepEqual(streamingActivity({ type: "text_delta", contentIndex: 0 }, message), { activity: "writing", work: "writing" });
	assert.equal(streamingActivity({ type: "text_start", contentIndex: 0 }, message), undefined);
	assert.deepEqual(streamingActivity({ type: "toolcall_delta", contentIndex: 1 }, message), { activity: "writing main.md", work: "call" });
	assert.deepEqual(streamingActivity({ type: "toolcall_delta", contentIndex: 2 }, message), { activity: "writing bash call", work: "call" });
	assert.equal(streamingActivity({ type: "toolcall_start" }, message)?.activity, "writing a tool call");
	assert.equal(streamingActivity({ type: "toolcall_start", contentIndex: 0 }, message)?.activity, "writing a tool call");
	assert.equal(streamingActivity({ type: "start" }, message), undefined);
});

test("an agent's session events give its spinner every state main's phase spinner has", () => {
	const watch = activityWatch();
	const waiting = { activity: "waiting for the model", work: "model" };
	assert.deepEqual(watch({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "npm test" } }), { activity: "bash npm test", work: "tool" });
	assert.deepEqual(watch({ type: "tool_execution_start", toolCallId: "b", toolName: "subagent", args: { task: "x", name: "helper", wait: true } }), { activity: "subagent helper", work: "tool" }, "its own call still runs beside the wait");
	assert.deepEqual(watch({ type: "tool_execution_end", toolCallId: "a" }), { activity: "subagent helper", work: "peer" }, "only a wait on another agent is left");
	assert.deepEqual(watch({ type: "tool_execution_end", toolCallId: "b" }), waiting, "every call is done: its model is asked next");
	assert.deepEqual(watch({ type: "auto_retry_start", attempt: 2, maxAttempts: 3 }), { activity: "retrying, attempt 2 of 3", work: "retrying" });
	assert.deepEqual(watch({ type: "auto_retry_end" }), waiting);
	assert.deepEqual(watch({ type: "compaction_start" }), { activity: "compacting context", work: "compacting" });
	assert.deepEqual(watch({ type: "compaction_end" }), waiting);
	assert.deepEqual(watch({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }), { activity: "thinking", work: "thinking" });
	assert.equal(watch({ type: "message_start" }), undefined);
});
