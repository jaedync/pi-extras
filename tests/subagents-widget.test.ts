import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingLines, phaseOf, rowRail, rowSegs, selectRows, shortModel } from "../lib/subagents/widget.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

function record(name: string, extra: Partial<AgentRecord> = {}): AgentRecord {
	return {
		name, parent: "main", depth: 1, task: "t", model: "openai-codex/gpt-6-luna", readOnly: false, fork: false, blocking: false,
		state: "running", createdAt: 0, startedAt: 1_000, activity: "bash npm test", toolCalls: 0, usage: NO_USAGE, runs: 1, ...extra,
	};
}
const text = (segs: Array<{ text: string }>) => segs.map((seg) => seg.text).join("");

test("rows show live agents and finished ones whose report is queued, children under parents", () => {
	const records = [
		record("lead", { thinking: "high" }),
		record("done-long-ago", { state: "idle" }),
		record("reported-soon", { state: "idle" }),
		record("helper", { parent: "lead", depth: 2 }),
	];
	const { rows, hidden } = selectRows(records, new Set(["reported-soon"]));
	assert.deepEqual(rows.map((row) => [row.record.name, row.depth]), [["lead", 0], ["helper", 1], ["reported-soon", 0]]);
	assert.equal(hidden, 0);
	assert.equal(text(rowSegs(rows[0]!)), "lead  gpt-6-luna high  bash npm test");
	assert.equal(text(rowSegs(rows[1]!)), "└ helper  gpt-6-luna  bash npm test");
	assert.equal(text(rowSegs(rows[2]!)), "reported-soon  gpt-6-luna  report queued");
});

test("more than six agents collapse into a count", () => {
	const records = Array.from({ length: 8 }, (_, i) => record(`a${i}`));
	assert.equal(selectRows(records, new Set()).hidden, 2);
});

test("the rail shows context share, spend and elapsed time", () => {
	const busy = record("x", { contextTokens: 50_000, contextWindow: 200_000, usage: { ...NO_USAGE, cost: 0.0123 } });
	assert.equal(text(rowRail(busy, 66_000)), "25%  $0.012  1m 05s");
	assert.equal(text(rowRail(record("tiny", { usage: { ...NO_USAGE, cost: 0.00041 } }), 2_000)), "$0.00041  1.0s");
	assert.equal(text(rowRail(record("q", { state: "queued", startedAt: undefined }), 5_000)), "");
});

test("asking agents are calm and amber; failures red", () => {
	const asking = record("x", { state: "asking", activity: "asking main" });
	assert.deepEqual(phaseOf(asking, 0), { kind: "calm" });
	assert.deepEqual(rowSegs({ record: asking, depth: 0 }).at(-1), { text: "asking main", color: "warning" });
	const failed = record("y", { state: "failed", error: "rate limited" });
	assert.equal(phaseOf(failed, 0).kind, "done");
	assert.deepEqual(rowSegs({ record: failed, depth: 0 }).at(-1), { text: "failed: rate limited", color: "error" });
});

test("queued messages for main show until appended, questions in amber", () => {
	const lines = pendingLines([
		{ id: "1", kind: "note", from: "scout", text: "found\nit", at: 0 },
		{ id: "2", kind: "question", from: "worker", text: "delete?", at: 0 },
		{ id: "3", kind: "report", from: "scout", text: "report", at: 0 },
		{ id: "4", kind: "note", from: "a", text: "x", at: 0 },
		{ id: "5", kind: "note", from: "b", text: "y", at: 0 },
	]);
	assert.deepEqual(lines, [
		{ text: "↳ scout → main: found it", color: "dim" },
		{ text: "? worker → main: delete?", color: "warning" },
		{ text: "↳ a → main: x", color: "dim" },
		{ text: "+1 more queued for main", color: "dim" },
	]);
	assert.equal(shortModel("anthropic/claude-opus-5-5"), "claude-opus-5-5");
});
