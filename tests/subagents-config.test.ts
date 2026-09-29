import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, GUIDE_MAX_CHARS, loadConfig, parseConfig, readGuide } from "../lib/subagents/config.ts";
import { nameFor, taskSlug } from "../lib/subagents/names.ts";

test("config falls back to defaults for missing or invalid values", () => {
	assert.deepEqual(parseConfig({}), DEFAULTS);
	assert.deepEqual(parseConfig({ maxConcurrent: 0, maxDepth: "2", replyTimeoutMs: -1, childToolsExclude: "bash" }), DEFAULTS);
	const config = parseConfig({ defaultModel: " luna ", maxConcurrent: 99, maxDepth: 2, childToolsExclude: ["bash", 3, ""] });
	assert.equal(config.defaultModel, "luna");
	assert.equal(config.maxConcurrent, 16);
	assert.equal(config.maxDepth, 2);
	assert.deepEqual(config.childToolsExclude, ["bash"]);
});

test("config reads the subagents section of pi-extras.json", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagents-config-"));
	try {
		const file = join(dir, "pi-extras.json");
		writeFileSync(file, JSON.stringify({ subagents: { maxConcurrent: 2 }, other: { maxConcurrent: 9 } }));
		assert.equal(loadConfig(file).maxConcurrent, 2);
		assert.deepEqual(loadConfig(join(dir, "missing.json")), DEFAULTS);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("guide joins the user's file and the project's, and caps each", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagents-guide-"));
	try {
		const agentDir = join(dir, "agent");
		const cwd = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		assert.deepEqual(readGuide(agentDir, cwd), { text: "", sources: [] });
		writeFileSync(join(agentDir, "subagent-models.md"), "- luna: cheap\n");
		writeFileSync(join(cwd, ".pi", "subagent-models.md"), "x".repeat(GUIDE_MAX_CHARS + 10));
		const guide = readGuide(agentDir, cwd);
		assert.equal(guide.sources.length, 2);
		assert.match(guide.text, /^- luna: cheap\n\nx+\n\(guide truncated at 4000 characters\)$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("names come from the task, skip filler, and avoid reserved names and collisions", () => {
	assert.equal(taskSlug("Please review the auth token refresh logic"), "review-auth-token");
	assert.equal(taskSlug("!!!"), "");
	assert.equal(taskSlug("Ask main which colour to use, RED or BLUE"), "colour-red-blue");
	const taken = new Set(["review-auth-token"]);
	assert.equal(nameFor(undefined, "Review the auth token refresh", (n) => taken.has(n)), "review-auth-token-2");
	assert.equal(nameFor("Diff Review", "anything", () => false), "diff-review");
	assert.equal(nameFor("main", "anything", () => false), "main-agent");
	assert.equal(nameFor(undefined, "the a an", () => false), "agent");
	assert.ok(nameFor(undefined, "x".repeat(80), () => false).length <= 24);
});

test("a fork digest keeps what was said and one line per tool call, newest first when cut", async () => {
	const { conversationDigest } = await import("../lib/subagents/format.ts");
	const describe = (tool: string, args: any) => `${tool} ${args?.command ?? ""}`.trim();
	const entries = [
		{ type: "message", message: { role: "user", content: "Plan the migration" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Checking." }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] } },
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "huge output" }] } },
		{ type: "custom_message", customType: "subagent-report", content: "scout finished" },
		{ type: "custom_message", customType: "other", content: "ignored" },
	];
	assert.equal(conversationDigest(entries, describe), "User: Plan the migration\n\nmain: Checking.\n[bash ls]\n\nscout finished");
	assert.equal(conversationDigest(entries, describe, 30), "(2 earlier entries omitted)\n\nscout finished");
});
