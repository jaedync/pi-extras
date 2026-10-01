import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildIndex, legacyRecords } from "../lib/subagents/restore.ts";
import { Team } from "../lib/subagents/team.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

const warn = (message: string) => assert.fail(message);

export const record = (patch: Partial<AgentRecord> = {}): AgentRecord => ({
	name: "helper", parent: "main", depth: 1, model: "faux/cheap", task: "Check files", readOnly: false,
	fork: false, blocking: false, state: "idle", createdAt: 1, activity: null, runs: 1, toolCalls: 0, usage: NO_USAGE, ...patch,
});

test("the child index atomically preserves records and refuses another parent", () => {
	const dir = mkdtempSync(join(tmpdir(), "child-index-"));
	try {
		const index = new ChildIndex(dir, "parent-1", dir);
		index.save([record({ thinking: "high", runs: 3 })]);
		assert.equal(new ChildIndex(dir, "parent-1", dir).load(warn)[0]?.runs, 3);
		assert.equal(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).version, 1);
		assert.throws(() => new ChildIndex(dir, "other-parent", dir).load(warn), /parent/);
		writeFileSync(join(dir, "index.json"), '{"version":1,"parentSession":"parent-1","records":[{"name":"bad"}]}');
		assert.throws(() => index.load(warn), /invalid/i);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy restoration joins tool arguments to result names and session files", () => {
	const records = legacyRecords([
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { task: "Check the files", name: "hard-tasks", model: "cheap", thinking: "high", readOnly: true } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "subagent", details: { name: "hard-tasks", model: "faux/cheap", sessionFile: "/children/hard-tasks.jsonl" } } },
	], "/children", "main", 1, undefined, warn);
	assert.equal(records[0]?.name, "hard-tasks");
	assert.equal(records[0]?.task, "Check the files");
	assert.equal(records[0]?.model, "faux/cheap");
	assert.equal(records[0]?.readOnly, true);
});

test("restoring a roster reserves its names without launching or delivering reports", () => {
	let launches = 0;
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100,
		launcher: { async launch() { launches++; throw new Error("test"); } }, deliverToMain() { assert.fail("restoration is not a report"); } });
	team.restore([record()]);
	assert.equal(launches, 0);
	assert.equal(team.get("helper")?.state, "idle");
	assert.equal(team.spawn({ name: "helper", task: "New work", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: true }).ok, true);
	assert.ok(team.get("helper-2"));
});
