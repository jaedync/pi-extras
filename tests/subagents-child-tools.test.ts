import { test } from "node:test";
import assert from "node:assert/strict";
import { childExtensionPaths } from "../lib/subagents/child.ts";

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
