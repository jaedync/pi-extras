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
		assert.deepEqual(loadConfig(join(dir, "missing.json"), {}), DEFAULTS);
		assert.equal(loadConfig(file, { PI_SUBAGENTS_MAX_DEPTH: "2" }).maxDepth, 2);
		assert.equal(loadConfig(file, { PI_SUBAGENTS_MAX_DEPTH: "zero" }).maxDepth, 1);
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

test("run stats total each model's runs, outcomes, time and spend", async () => {
	const { statsByModel, statsText } = await import("../lib/subagents/runlog.ts");
	const line = (model: string, state: string, cost: number, durationMs: number) => JSON.stringify({ model, state, usage: { cost }, durationMs, toolCalls: 2 });
	const stats = statsByModel([line("a/luna", "idle", 0.001, 4_000), line("a/luna", "failed", 0.003, 6_000), "not json", line("b/sol", "idle", 0.02, 30_000)]);
	assert.deepEqual(stats.map((s) => [s.model, s.runs, s.ok, s.failed]), [["a/luna", 2, 1, 1], ["b/sol", 1, 1, 0]]);
	const text = statsText(stats, (ms) => `${ms / 1000}s`, (v) => v.toFixed(4)).split("\n");
	assert.equal(text[0], "a/luna     2 runs (1 failed)  avg 5s, 2.0 tools, $0.0020  total $0.0040");
	assert.equal(text[1], "b/sol      1 run   avg 30s, 2.0 tools, $0.0200  total $0.0200");
});

test("/subagents completions close once the command is complete, so Enter runs it", async () => {
	const { commandCompletions } = await import("../lib/subagents/names.ts");
	const values = (prefix: string, names: string[]) => commandCompletions(prefix, names)?.map((item) => item.value) ?? null;
	assert.deepEqual(values("st", ["long-job"]), ["stats", "stop all", "stop long-job"]);
	assert.deepEqual(values("stop lo", ["long-job"]), ["stop long-job"]);
	assert.equal(values("stop long-job", ["long-job", "long-job-2"]), null);
	assert.equal(values("stats", []), null);
	assert.equal(values("zzz", []), null);
});
