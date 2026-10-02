import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { quiet } from "./support/quiet-theme.ts";
import assert from "node:assert/strict";
import { hiddenLine, listLabel, nameSegs, pendingLines, rowColumns, factSegs, runTime, presenceLine, rowSegs, selectRows, shortModel } from "../lib/subagents/widget.ts";
import { AGENT_HUE, agentHue, doingGlyph, doingOf } from "../lib/band/agent-look.ts";
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
	const columns = rowColumns(rows, 66_000);
	assert.deepEqual(columns, { name: 13, time: 5 });
	const glyph = doingGlyph("tool", 0, "reduced").glyph;
	// Names and times line up; what each is doing starts in one column; the model trails, unpadded, with the facts.
	assert.equal(text(rowSegs(rows[0]!, 66_000, "reduced", columns)), `◆ ${"lead".padEnd(columns.name)}  1m05s  ${glyph} bash npm test  gpt-6-luna high`);
	assert.equal(text(rowSegs(rows[1]!, 66_000, "reduced", columns)), `└ ◆ ${"helper".padEnd(columns.name - 2)}  1m05s  ${glyph} bash npm test  gpt-6-luna`);
	assert.equal(text(rowSegs(rows[2]!, 66_000, "reduced", columns)), `◆ ${"reported-soon".padEnd(columns.name)}  1m05s   ✓  report queued  gpt-6-luna`);
});

test("more than six agents collapse into a count", () => {
	const records = Array.from({ length: 8 }, (_, i) => record(`a${i}`));
	assert.equal(selectRows(records, new Set()).hidden, 2);
});

test("presence orders time, doing, then model and spend before context, with no background or rail", () => {
	const busy = record("x", { contextTokens: 50_000, contextWindow: 200_000, usage: { ...NO_USAGE, cost: 0.0123 } });
	assert.equal(text(factSegs(busy)), "gpt-6-luna · $0.012 · ctx 25%");
	assert.equal(runTime(busy, 66_000), "1m05s");
	assert.equal(text(factSegs(record("tiny", { usage: { ...NO_USAGE, cost: 0.00041 } }))), "gpt-6-luna · $0.00041");
	assert.equal(runTime(record("q", { state: "queued", startedAt: undefined }), 5_000), undefined);
	const line = presenceLine(quiet() as never, { record: busy, depth: 0 }, 100, 66_000, "reduced");
	assert.equal(stripTerminalSequences(line).trimEnd(), `  ◆ x  1m05s  ${doingGlyph("tool", 66_000, "reduced").glyph} bash npm test  gpt-6-luna · $0.012 · ctx 25%`);
	assert.doesNotMatch(line, /\x1b\[48;|▍/);
});

test("a running agent with no activity says thinking; times align right so what each does starts in one column", () => {
	const rows = [{ record: record("short", { activity: null }), depth: 0 }, { record: record("longer", { startedAt: 0 }), depth: 0 }];
	const columns = rowColumns(rows, 60_000);
	assert.equal(columns.time, 5);
	const lines = rows.map((row) => stripTerminalSequences(presenceLine(quiet() as never, row, 100, 60_000, "reduced", columns)));
	assert.match(lines[0]!, /59\.0s  \S{3} thinking  gpt-6-luna/);
	assert.equal(lines[0]!.indexOf("thinking") , lines[1]!.indexOf("bash npm test"));
});

test("an ended agent's glyph slot says how it ended, in the slot's three cells", () => {
	const ended = (state: "idle" | "failed" | "stopped" | "interrupted") => rowSegs({ record: record("x", { state }), depth: 0 });
	const slot = (segs: ReturnType<typeof rowSegs>) => segs.find((seg) => /^ \S $/.test(seg.text));
	assert.deepEqual(slot(ended("idle")), { text: " ✓ ", color: "success" });
	assert.deepEqual(slot(ended("failed")), { text: " ✗ ", color: "error" });
	assert.deepEqual(slot(ended("stopped")), { text: " ■ ", color: "muted" });
	assert.deepEqual(slot(ended("interrupted")), { text: " ! ", color: "warning" });
});

test("asking agents use the asking glyph and amber words; failures settle in red", () => {
	const asking = record("x", { state: "asking", activity: "asking main" });
	assert.equal(doingOf(asking), "asking");
	assert.ok(rowSegs({ record: asking, depth: 0 }).some((seg) => seg.text === "asking main" && seg.color === "warning"));
	const failed = record("y", { state: "failed", error: "rate limited" });
	assert.equal(doingOf(failed), "done");
	assert.ok(rowSegs({ record: failed, depth: 0 }).some((seg) => seg.text === "failed: rate limited" && seg.color === "error"));
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

test("a child main is blocked on shows only inline, not in the widget", () => {
	const records = [record("inline", { blocking: true }), record("bg"), record("nested", { parent: "bg", depth: 2, blocking: true })];
	assert.deepEqual(selectRows(records, new Set()).rows.map((row) => row.record.name), ["bg", "nested"]);
});

test("hidden agents are counted in the right number", () => {
	assert.equal(hiddenLine(1), "+1 more agent");
	assert.equal(hiddenLine(3), "+3 more agents");
});

test("the /subagents picker says what each agent is, did and cost", () => {
	const done = record("reader", { state: "idle", task: "Report the value of REPORT_MAX_CHARS in format.ts", startedAt: 1_000, endedAt: 12_000, usage: { ...NO_USAGE, cost: 0.0012 } });
	assert.equal(listLabel(done, 8, 20_000), "reader    finished  gpt-6-luna  $0.0012  11.0s  Report the value of REPORT_MAX_CHARS in format.ts");
	assert.equal(listLabel(record("scan", { state: "queued", startedAt: undefined }), 4, 20_000), "scan  queued    gpt-6-luna  t");
});

test("a picker line fits the width it is given", () => {
	const long = record("reader", { state: "idle", task: "Read /Users/someone/project/lib/subagents/format.ts and report the value of REPORT_MAX_CHARS. Be concise.", usage: { ...NO_USAGE, cost: 0.0009 }, endedAt: 5_800 });
	const line = listLabel(long, 6, 10_000, 60);
	assert.equal(line.length, 60);
	assert.ok(line.endsWith("…"));
});

test("a restored record without a run start times its run from creation, never from now", () => {
	// Records restored from before run starts were saved carry only createdAt and endedAt.
	const legacy = record("old", { state: "interrupted", createdAt: 1_000, startedAt: undefined, endedAt: 195_855 });
	assert.equal(runTime(legacy, 50_000_000), "3m14s");
	assert.match(listLabel(legacy, 4, 50_000_000), /interrupted.*3m14s/);
});

test("an agent's name and its own spinner wear its provider's color; tool work keeps the tool color", () => {
	const codex = agentHue("openai-codex/gpt-6-luna");
	assert.deepEqual(nameSegs(record("lead")).map((seg) => seg.color), [codex, codex]);
	assert.deepEqual(nameSegs(record("local", { model: "redarch-lora/qwen3" })).map((seg) => seg.color), [AGENT_HUE, AGENT_HUE]);
	const thinking = rowSegs({ record: record("lead", { activity: null }), depth: 0 }, 5_000, "reduced", { name: 4, time: 4 });
	assert.equal(thinking.find((seg) => seg.text === doingGlyph("thinking", 5_000, "reduced").glyph)?.color, codex);
	const tool = rowSegs({ record: record("lead"), depth: 0 }, 5_000, "reduced", { name: 4, time: 4 });
	assert.equal(tool.find((seg) => seg.text === doingGlyph("tool", 5_000, "reduced").glyph)?.color, "accent");
});
