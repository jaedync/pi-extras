import { test } from "node:test";
import assert from "node:assert/strict";
import { childExtensionPaths, streamingActivity } from "../lib/subagents/child.ts";

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
	assert.equal(streamingActivity({ type: "thinking_delta" }, message), "thinking");
	assert.equal(streamingActivity({ type: "text_delta", contentIndex: 0 }, message), "writing");
	assert.equal(streamingActivity({ type: "toolcall_delta", contentIndex: 1 }, message), "writing main.md");
	assert.equal(streamingActivity({ type: "toolcall_delta", contentIndex: 2 }, message), "writing bash call");
	assert.equal(streamingActivity({ type: "toolcall_start" }, message), "writing a tool call");
	assert.equal(streamingActivity({ type: "toolcall_start", contentIndex: 0 }, message), "writing a tool call");
	assert.equal(streamingActivity({ type: "start" }, message), undefined);
});
