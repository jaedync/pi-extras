import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildIndex, discoverOrphans, legacyRecords } from "../lib/subagents/restore.ts";
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

test("the index keeps each child's context size and drops one it can't use", () => {
	const dir = mkdtempSync(join(tmpdir(), "child-index-"));
	try {
		const file = join(dir, "index.json");
		new ChildIndex(dir, "parent-1", dir).save([record({ contextTokens: 48_200, contextWindow: 200_000, compactAt: 100_000 })]);
		const [kept] = new ChildIndex(dir, "parent-1", dir).load(warn);
		assert.deepEqual([kept?.contextTokens, kept?.contextWindow, kept?.compactAt], [48_200, 200_000, 100_000]);
		const data = JSON.parse(readFileSync(file, "utf8"));
		data.records[0] = { ...data.records[0], contextTokens: "lots", contextWindow: -5, compactAt: Number.POSITIVE_INFINITY.toString() };
		writeFileSync(file, JSON.stringify(data));
		const [dropped] = new ChildIndex(dir, "parent-1", dir).load(warn);
		assert.equal(dropped?.name, "helper", "the child itself is still restored");
		assert.deepEqual(["contextTokens" in dropped!, "contextWindow" in dropped!, "compactAt" in dropped!], [false, false, false]);
		data.records[0] = { ...data.records[0], contextTokens: 48_200, contextWindow: 200_000, compactAt: 0 };
		writeFileSync(file, JSON.stringify(data));
		const [old] = new ChildIndex(dir, "parent-1", dir).load(warn);
		assert.deepEqual([old?.contextWindow, "compactAt" in old!], [200_000, false], "a bad point is dropped and the window stands in, as for a record saved before points");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an index saved under another path for its folder points its children into the folder, and a path that is no session file still fails", () => {
	const dir = mkdtempSync(join(tmpdir(), "child-index-"));
	try {
		// A session started on another machine, as on a Mac where the home folder was /Users/<name>.
		const moved = "/Users/someone/.pi/agent/sessions/subagents/parent-1/2026-10-13T10-00-00-000Z_a_1234abcd.jsonl";
		const here = join(dir, "2026-10-13T11-00-00-000Z_b_5678abcd.jsonl");
		writeFileSync(join(dir, "2026-10-13T10-00-00-000Z_a_1234abcd.jsonl"), "");
		new ChildIndex(dir, "parent-1", dir).save([record({ name: "a", sessionFile: moved }), record({ name: "b", sessionFile: here })]);
		const warnings: string[] = [];
		const loaded = new ChildIndex(dir, "parent-1", dir).load((message) => warnings.push(message));
		assert.deepEqual(loaded.map((child) => child.sessionFile), [join(dir, "2026-10-13T10-00-00-000Z_a_1234abcd.jsonl"), here]);
		assert.equal(warnings.length, 1, warnings.join("\n"));
		assert.match(warnings[0]!, /1 saved child session path/);
		assert.deepEqual(discoverOrphans(dir, loaded, () => assert.fail("an indexed transcript is no orphan"), warn), []);
		for (const bad of ["/etc/passwd", "/elsewhere/..", "/elsewhere/notes.txt"]) {
			new ChildIndex(dir, "parent-1", dir).save([record({ sessionFile: bad })]);
			assert.throws(() => new ChildIndex(dir, "parent-1", dir).load(() => undefined), /Invalid child session path/, bad);
		}
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

test("mail a closing host keeps is saved with the index, read back once, and anything malformed is left out with a warning", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagents-mail-"));
	try {
		const report = { message: { customType: "subagent-report", content: "Report", display: true, details: { id: "sa-1", kind: "report" as const, reports: [] } }, wakes: true };
		const index = new ChildIndex(dir, "parent", dir);
		index.keepMail([report]);
		index.save([], "reload", "owner");
		const saved = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
		assert.deepEqual(saved.mail, [report]);
		const foreign = { message: { customType: "other", content: "x", display: true, details: { id: "x", kind: "note" } }, wakes: true };
		const hollow = { message: { ...report.message, details: { id: "sa-2", kind: "report" } }, wakes: true };
		writeFileSync(join(dir, "index.json"), JSON.stringify({ ...saved, mail: [...saved.mail, foreign, hollow] }));
		const warnings: string[] = [];
		const next = new ChildIndex(dir, "parent", dir);
		next.load((message) => warnings.push(message));
		assert.equal(warnings.length, 1, "one warning for what is left out");
		assert.deepEqual(next.takeMail(), [report]);
		assert.deepEqual(next.takeMail(), [], "taken once");
		next.save([]);
		assert.equal(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).mail, undefined);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
