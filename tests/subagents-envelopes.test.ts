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
	assert.deepEqual(readEnvelopes(reportText(record({ state: "stopped", usage: NO_USAGE, startedAt: undefined, runs: 0 }), 0)),
		[{ kind: "report", from: "lead-a", model: "openai-codex/gpt-6-luna", state: "stopped", text: "" }]);
	assert.deepEqual(readEnvelopes(reportText(record({ state: "interrupted", report: "partway" }), 0)),
		[{ kind: "report", from: "lead-a", model: "openai-codex/gpt-6-luna", state: "interrupted", took: "16s", text: "partway" }]);
	assert.deepEqual(readEnvelopes(reportText(record({ state: "interrupted", launchError: "model gone" }), 0)),
		[{ kind: "report", from: "lead-a", model: "openai-codex/gpt-6-luna", state: "interrupted", text: "model gone" }]);
});

test("a report of an agent with a large context says that a fresh subagent probably costs less than a follow-up", () => {
	const big = reportText(record({ report: "Done.", contextTokens: 140_000 }), 0);
	assert.match(big, /\nContext: 140k tokens\. A follow-up re-reads all of it each turn; for unrelated work, a fresh subagent probably costs less\.\n/);
	assert.deepEqual(readEnvelopes(big), [{ kind: "report", from: "lead-a", model: "openai-codex/gpt-6-luna", state: "idle", took: "16s", text: "Done." }], "a meta line, not the report");
	assert.doesNotMatch(reportText(record({ report: "Done.", contextTokens: 99_999 }), 0), /Context:/, "under 100k a follow-up is the cheaper way");
	assert.match(reportText(record({ state: "failed", error: "x", contextTokens: 120_000 }), 0), /\nContext: 120k tokens\./);
});

test("a report written at the budget says so for the model, reads back as an idle report, and keeps its body for the inspector", async () => {
	const { reportBody } = await import("../lib/subagents/format.ts");
	const atBudget = record({ budgetEnd: "over its 60-minute budget", report: "Half done.\n\nNext: the tests." });
	const text = reportText(atBudget, 0);
	assert.match(text, /^lead-a \(openai-codex\/gpt-6-luna, \$0\.0012\) reached its 60-minute budget after 16s and wrote this report when told to stop\. Its work may be incomplete\. Message it to continue with a fresh budget; it keeps its context\.\nSession: \/tmp\/lead-a\.jsonl\n\nHalf done\./);
	assert.deepEqual(readEnvelopes(text), [{ kind: "report", from: "lead-a", model: "openai-codex/gpt-6-luna", state: "idle", took: "16s",
		text: "reached its 60-minute budget\n\nHalf done.\n\nNext: the tests." }]);
	assert.equal(reportBody(text), "Half done.\n\nNext: the tests.");
	const cost = reportText(record({ budgetEnd: "over its $0.50 cost budget", report: "x", check: { command: "npm test", fixUntilPass: 0 } }), 0);
	assert.match(cost, / reached its \$0\.50 cost budget after 16s and wrote this report when told to stop\. Its work may be incomplete, and its check did not run\. Message it/);
	const checked = record({ budgetEnd: "over its 60-minute budget", report: "x", check: { command: "npm test", fixUntilPass: 1 },
		checked: { run: 1, command: "npm test", exitCode: 1, durationMs: 1_000, tail: "fail", attempt: 1, attempts: 2 } });
	assert.match(reportText(checked, 0), /its check did not run again\./);
	const [read] = readEnvelopes(cost);
	assert.equal(read?.kind === "report" && read.state, "idle");
	const [window] = readEnvelopes(reportText(record({ budgetEnd: "over its 80% limit on the anthropic 7d window", report: "x" }), 0));
	assert.equal(window?.kind === "report" && window.state, "idle", "a window-limit report reads back too");
	assert.match(window?.text ?? "", /^reached its 80% limit on the anthropic 7d window\n/);
});
