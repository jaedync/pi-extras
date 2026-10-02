import assert from "node:assert/strict";
import test from "node:test";
import { noteText, questionText, readEnvelopes, reportText } from "../lib/subagents/format.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

function record(extra: Partial<AgentRecord> = {}): AgentRecord {
	return {
		name: "lead-a", parent: "lead", depth: 2, task: "t", model: "openai-codex/gpt-6-luna", readOnly: false, fork: false, blocking: false,
		state: "idle", createdAt: 0, startedAt: 0, endedAt: 16_000, activity: null, toolCalls: 1, usage: { ...NO_USAGE, cost: 0.0012 }, runs: 1,
		sessionFile: "/tmp/lead-a.jsonl", ...extra,
	};
}

test("notes and questions read back as who sent them and what they said", () => {
	assert.deepEqual(readEnvelopes(noteText("main", "Also check docs.\n\nAnd tests.")), [{ kind: "note", from: "main", text: "Also check docs.\n\nAnd tests." }]);
	assert.deepEqual(readEnvelopes(questionText("finder", "Ready for the path?")), [{ kind: "question", from: "finder", text: "Ready for the path?" }]);
	assert.deepEqual(readEnvelopes(noteText("user", "\nstarts blank")), [{ kind: "note", from: "user", text: "starts blank" }]);
});

test("a batch delivered at once, after a resume notice, reads back part by part", () => {
	const notice = "Your previous run was interrupted. Verify the current state before continuing.";
	const text = [notice, noteText("user", "Also docs."), questionText("main", "Which file?"), noteText("finder", "lib/x.ts")].join("\n\n");
	assert.deepEqual(readEnvelopes(text), [
		{ kind: "prompt", text: notice },
		{ kind: "note", from: "user", text: "Also docs." },
		{ kind: "question", from: "main", text: "Which file?" },
		{ kind: "note", from: "finder", text: "lib/x.ts" },
	]);
});

test("a task is one prompt, even when a paragraph merely starts like a message", () => {
	const task = "Count the files.\n\nMessage from the team: be quick.\n\nquestion from main, who knows";
	assert.deepEqual(readEnvelopes(task), [{ kind: "prompt", text: task }]);
	assert.deepEqual(readEnvelopes(""), []);
});

test("a child's report reads back as who, on which model, how it ended and what it said, without the file paths", () => {
	const finished = record({ report: "Found 3.\n\nDetails here.", runs: 2, resumedBy: { from: "lead", text: "Message from lead: count again" }, reportFile: "/tmp/r.md" });
	assert.deepEqual(readEnvelopes(reportText(finished, 0)), [{ kind: "report", from: "lead-a", model: "openai-codex/gpt-6-luna", state: "idle", took: "16s", text: "Found 3.\n\nDetails here." }]);
	assert.deepEqual(readEnvelopes(reportText(record({ state: "failed", error: "rate limited", report: "half done" }), 0)),
		[{ kind: "report", from: "lead-a", model: "openai-codex/gpt-6-luna", state: "failed", took: "16s", text: "rate limited\n\nhalf done" }]);
	assert.deepEqual(readEnvelopes(reportText(record({ state: "stopped", usage: NO_USAGE }), 0)),
		[{ kind: "report", from: "lead-a", model: "openai-codex/gpt-6-luna", state: "stopped", took: "16s", text: "" }]);
	assert.deepEqual(readEnvelopes(reportText(record({ state: "interrupted", report: "partway" }), 0)),
		[{ kind: "report", from: "lead-a", model: "openai-codex/gpt-6-luna", state: "interrupted", took: "16s", text: "partway" }]);
	assert.deepEqual(readEnvelopes(reportText(record({ state: "interrupted", launchError: "model gone" }), 0)),
		[{ kind: "report", from: "lead-a", model: "openai-codex/gpt-6-luna", state: "interrupted", text: "model gone" }]);
});
