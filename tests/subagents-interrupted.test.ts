import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import { restoreRecord, shouldResume, restorationNotice } from "../lib/subagents/restore.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

const record = (state: AgentRecord["state"] = "idle"): AgentRecord => ({ name: "helper", parent: "main", depth: 1,
	model: "faux/cheap", task: "Check files", readOnly: false, fork: false, blocking: false, state, createdAt: 1,
	activity: "write notes.txt", runs: 1, toolCalls: 0, usage: NO_USAGE, sessionFile: "/sessions/helper.jsonl" });
const message = (value: unknown) => ({ type: "message", message: value });

test("reload defaults to resuming while startup only notifies, with explicit overrides", () => {
	assert.equal(shouldResume("reload", "reload"), true);
	assert.equal(shouldResume("startup", "reload"), false);
	assert.equal(shouldResume("resume", "always"), true);
	assert.equal(shouldResume("reload", "notify"), false);
	const notice = restorationNotice([record("interrupted")], false, "startup");
	assert.match(notice, /helper.*Check files.*write notes.txt/);
	assert.match(notice, /resume <name>|message/);
});

test("aborted, running and unfinished tool sessions restore interrupted, not failed", () => {
	assert.equal(restoreRecord(record(), [message({ role: "assistant", stopReason: "aborted", content: [] })]).state, "interrupted");
	assert.equal(restoreRecord(record("running"), [message({ role: "assistant", stopReason: "stop", content: [] })]).state, "interrupted");
	assert.equal(restoreRecord(record(), [message({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call", name: "write" }] })]).state, "interrupted");
	assert.equal(restoreRecord(record(), [message({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] })]).state, "idle");
});

test("messaging a restored interrupted child reopens once and includes a verification warning", async () => {
	const prompts: string[] = [];
	let launches = 0;
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100, deliverToMain() {}, launcher: {
		async launch(r) {
			launches++;
			assert.equal(r.sessionFile, "/sessions/helper.jsonl");
			return { async prompt(text) { prompts.push(text); }, steer() {}, async abort() {}, lastText: () => "Done",
				messages: () => [], takeQueued: () => [], async dispose() {} };
		},
	} });
	team.restore([record("interrupted")]);
	assert.deepEqual(await team.send("main", "helper", "Continue"), { ok: true, delivered: "resumed" });
	await tick();
	assert.equal(launches, 1);
	assert.match(prompts[0]!, /last tool call may not have completed.*files may have changed.*verify/i);
	assert.match(prompts[0]!, /Continue/);
	assert.equal(team.get("helper")?.runs, 2);
	await team.close();
});

test("an interrupted queued child with no user transcript receives its original task before the resume note", async () => {
	const prompts: string[] = [];
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100, deliverToMain() {}, launcher: {
		async launch() { return { async prompt(text) { prompts.push(text); }, steer() {}, async abort() {}, lastText: () => "Done",
			messages: () => [], takeQueued: () => [], async dispose() {} }; },
	} });
	team.restore([{ ...record("interrupted"), runs: 0, task: "THE ORIGINAL COMPLETE BRIEF" }]);
	await team.send("main", "helper", "Continue");
	await team.whenDone("helper");
	assert.ok(prompts[0]?.startsWith("THE ORIGINAL COMPLETE BRIEF\n\n"));
	assert.match(prompts[0]!, /last tool call may not have completed/);
	await team.close();
});

test("shutdown freezes running records as interrupted and emits no stopped report", async () => {
	const main: unknown[] = [];
	let aborted = 0;
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100, deliverToMain: (d) => main.push(d), launcher: {
		async launch() { return { prompt: () => new Promise<void>(() => {}), steer() {}, async abort() { aborted++; },
			lastText: () => "", messages: () => [], takeQueued: () => [], async dispose() {} }; },
	} });
	team.spawn({ task: "Work", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false });
	await tick();
	await team.close();
	assert.equal(team.get("work")?.state, "interrupted");
	assert.equal(aborted, 1);
	assert.deepEqual(main, []);
});
