import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireParent } from "../lib/subagents/ownership.ts";
import { ChildIndex, recoverRoster, reportRunFloor } from "../lib/subagents/restore.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";
import { doingOf } from "../lib/band/agent-look.ts";
import { selectRows } from "../lib/subagents/widget.ts";

const warn = (message: string) => assert.fail(message);
const r = (name: string, patch: Partial<AgentRecord> = {}): AgentRecord => ({ name, parent: "main", depth: 1, model: "faux/cheap",
	task: "Check files", readOnly: false, fork: false, blocking: false, state: "idle", createdAt: 1, activity: null, runs: 1,
	toolCalls: 0, usage: NO_USAGE, ...patch });

test("concurrent parents cannot own or overwrite the same child roster", () => {
	const dir = mkdtempSync(join(tmpdir(), "child-owner-"));
	try {
		const release = acquireParent(dir);
		assert.throws(() => acquireParent(dir), /already.*process/i);
		release();
		acquireParent(dir)();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("PID reuse and an old crashed reaper do not strand the lease, and busy errors name its path", { skip: process.platform === "win32" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "child-stale-owner-"));
	try {
		const lock = join(dir, ".owner"); mkdirSync(lock);
		writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "old", started: "old process birth", birthFormat: "utc-c" }));
		const reaping = join(lock, "reaping"); mkdirSync(reaping);
		utimesSync(reaping, new Date(0), new Date(0));
		const release = acquireParent(dir);
		assert.throws(() => acquireParent(dir), (error: unknown) => (error as Error).message.includes(lock) && (error as Error).message.includes("remove"));
		release();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("report filenames set the restored run floor and reportFile never enters the index", () => {
	const dir = mkdtempSync(join(tmpdir(), "child-runs-"));
	try {
		const sessionFile = join(dir, "helper.jsonl");
		writeFileSync(join(dir, "helper.run-4.report.md"), "Report");
		assert.equal(reportRunFloor(sessionFile, 1, warn), 4);
		const index = new ChildIndex(dir, "parent", dir);
		index.save([{ ...r("helper", { sessionFile }), reportFile: "not persisted" } as AgentRecord]);
		assert.equal((index.load(warn)[0] as any).reportFile, undefined);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy grandchildren retain their parent and depth without being adopted from a fork", () => {
	const dir = mkdtempSync(join(tmpdir(), "child-nested-"));
	try {
		const lead = join(dir, "lead.jsonl");
		const helper = join(dir, "helper.jsonl");
		writeFileSync(lead, "synthetic"); writeFileSync(helper, "synthetic");
		const branch = [
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "spawn", name: "subagent", arguments: { task: "Nested work" } }] } },
			{ type: "message", message: { role: "toolResult", toolName: "subagent", toolCallId: "spawn", details: { name: "helper", model: "faux/cheap", sessionFile: helper } } },
		];
		const roster = recoverRoster([r("lead", { sessionFile: lead })], dir, (file) => file === lead ? branch : [], warn);
		assert.equal(roster.find((v) => v.name === "helper")?.parent, "lead");
		assert.equal(roster.find((v) => v.name === "helper")?.depth, 2);
		assert.equal(recoverRoster([], join(dir, "new-parent"), () => branch, warn).length, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a saved running record with no transcript is still interrupted and reserves its name", () => {
	const roster = recoverRoster([r("missing", { state: "running", sessionFile: "/missing/session.jsonl" })], "/missing", () => [], warn);
	assert.equal(roster[0]?.state, "interrupted");
	assert.equal(roster[0]?.name, "missing");
});

test("interrupted restored children remain visible and calm rather than failed", () => {
	const interrupted = r("helper", { state: "interrupted", restored: true });
	assert.equal(selectRows([interrupted], new Set()).rows.length, 1);
	assert.equal(doingOf(interrupted), "done", "an interrupted child has no live activity animation");
});
