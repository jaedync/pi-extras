import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInterruptedRuns, loggedRunKeys } from "../lib/subagents/runlog.ts";
import { installSignalRecorder } from "../lib/subagents/signals.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

const interrupted: AgentRecord = { name: "helper", parent: "main", depth: 1, model: "faux/cheap", task: "Check files",
	readOnly: false, fork: false, blocking: false, state: "interrupted", createdAt: 1, activity: "write notes.txt", runs: 1,
	toolCalls: 0, usage: NO_USAGE, sessionFile: "/sessions/helper.jsonl" };

test("restoration logs hard-kill interruptions once per parent, child session and run", () => {
	const dir = mkdtempSync(join(tmpdir(), "interrupted-log-"));
	try {
		const file = join(dir, "runs.jsonl");
		appendInterruptedRuns(file, [interrupted], "parent-1", 10);
		appendInterruptedRuns(file, [interrupted], "parent-1", 20);
		assert.equal(loggedRunKeys(file).size, 1);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).state, "interrupted");
		appendInterruptedRuns(file, [{ ...interrupted, runs: 2 }], "parent-1", 30);
		assert.equal(loggedRunKeys(file).size, 2);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("signal recording is synchronous, leaves existing host listeners alone and uninstalls cleanly", () => {
	const events: string[] = [];
	const host = () => events.push("host");
	process.on("SIGTERM", host);
	const before = process.listenerCount("SIGTERM");
	const remove = installSignalRecorder((signal) => events.push(signal));
	try {
		process.emit("SIGTERM");
		assert.deepEqual(events, ["SIGTERM", "host"]);
		assert.equal(process.listenerCount("SIGTERM"), before + 1);
	} finally { remove(); process.off("SIGTERM", host); }
	assert.equal(process.listeners("SIGTERM").includes(host), false);
});
