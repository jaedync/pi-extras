import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionScanner } from "../lib/subagents/session-scan.ts";
import { ChildIndex, discoverOrphans, recoverRoster, restoreRecord } from "../lib/subagents/restore.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";
import { runKey, runLogEntry } from "../lib/subagents/runlog.ts";

const warn = (message: string) => assert.fail(message);
const record: AgentRecord = { name: "helper", parent: "main", depth: 1, model: "faux/cheap", task: "Original task", readOnly: false, fork: false,
	blocking: false, state: "idle", createdAt: 1, activity: null, runs: 1, toolCalls: 0, usage: NO_USAGE };
const json = (text: string) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("scanning is parse-only, caches transcripts and messages, and isolates invalid files", () => {
	const dir = mkdtempSync(join(tmpdir(), "child-scan-"));
	let parses = 0;
	const scanner = createSessionScanner((text) => { parses++; return json(text); }, () => {});
	try {
		const valid = join(dir, "helper.jsonl");
		const empty = join(dir, "empty.jsonl");
		const invalid = join(dir, "invalid.jsonl");
		writeFileSync(valid, [JSON.stringify({ type: "session", id: "root", cwd: dir, version: 3 }),
			JSON.stringify({ type: "message", id: "message", parentId: null, message: { role: "user", content: "Original task" } })].join("\n"));
		writeFileSync(empty, ""); writeFileSync(invalid, "not a session");
		const branch = scanner.branch(valid);
		assert.equal(scanner.branch(valid), branch);
		assert.equal(scanner.messages(valid), scanner.messages(valid));
		assert.equal(parses, 1);
		assert.throws(() => scanner.branch(empty));
		assert.equal(readFileSync(empty, "utf8"), "", "an empty file is never rewritten");
		const roster = recoverRoster([{ ...record, sessionFile: valid }], dir, scanner.branch, warn);
		assert.equal(roster.length, 1, "one non-Pi file cannot disable the valid child");
		assert.equal(discoverOrphans(dir, roster, scanner.branch, warn).length, 0);
		const broken = recoverRoster([{ ...record, sessionFile: invalid }], dir, scanner.branch, warn);
		assert.match(broken[0]!.restoreError!, /JSON|session/i);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("index activity updates are throttled, state updates flush, and stale temp files are removed", () => {
	const dir = mkdtempSync(join(tmpdir(), "child-index-updates-"));
	try {
		const index = new ChildIndex(dir, "parent", dir);
		index.save([record]);
		index.update([{ ...record, activity: "writing" }], (error) => assert.fail(String(error)));
		assert.equal(index.load(warn)[0]?.activity, null);
		index.update([{ ...record, state: "interrupted", activity: "writing" }], (error) => assert.fail(String(error)));
		assert.equal(index.load(warn)[0]?.state, "interrupted");
		writeFileSync(join(dir, "index.json.stray.tmp"), "partial");
		index.load(warn);
		assert.throws(() => readFileSync(join(dir, "index.json.stray.tmp")));
		index.save([record]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hard-kill accounting ends at persisted activity and stopping it shares the same log identity", () => {
	const restored = restoreRecord({ ...record, state: "running" }, [{ type: "message", timestamp: "1970-01-01T00:00:10.000Z", message: { role: "assistant", stopReason: "toolUse", content: [] } }], warn);
	assert.equal(restored.endedAt, 10_000);
	assert.equal(runKey(runLogEntry(restored, 99_000, "parent")), runKey(runLogEntry({ ...restored, state: "stopped" }, 99_000, "parent")));
});
