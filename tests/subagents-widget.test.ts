import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { quiet } from "./support/quiet-theme.ts";
import assert from "node:assert/strict";
import { agentRows, createAgentsWidget, listLabel, nameSegs, pendingLines, rowColumns, factSegs, runTime, presenceLine, rowSegs, shortModel } from "../lib/subagents/widget.ts";
import { COLLAPSED_ROWS, controlLine, expandedBudget, fitRows, shownCount } from "../lib/subagents/overflow.ts";
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
	const rows = agentRows(records, new Set(["reported-soon"]));
	assert.deepEqual(rows.map((row) => [row.record.name, row.depth]), [["lead", 0], ["helper", 1], ["reported-soon", 0]]);
	const columns = rowColumns(rows, 66_000);
	assert.deepEqual(columns, { name: 13, time: 5 });
	const glyph = doingGlyph("tool", 0, "reduced").glyph;
	// Names and times line up; what each is doing starts in one column; the model trails, unpadded, with the facts.
	assert.equal(text(rowSegs(rows[0]!, 66_000, "reduced", columns)), `◆ ${"lead".padEnd(columns.name)}  1m05s  ${glyph} bash npm test  gpt-6-luna high`);
	assert.equal(text(rowSegs(rows[1]!, 66_000, "reduced", columns)), `└ ◆ ${"helper".padEnd(columns.name - 2)}  1m05s  ${glyph} bash npm test  gpt-6-luna`);
	assert.equal(text(rowSegs(rows[2]!, 66_000, "reduced", columns)), `◆ ${"reported-soon".padEnd(columns.name)}  1m05s   ✓  report queued  gpt-6-luna`);
});

test("up to four agents show whole; a fifth turns the last row into the control line, so it never says +1 more", () => {
	for (const total of [0, 1, 4]) assert.equal(shownCount(total, false, 20), total);
	assert.equal(shownCount(5, false, 20), 3);
	assert.equal(shownCount(10, false, 20), 3);
	// Expanded, the rows take the budget but the control line keeps its own.
	assert.equal(shownCount(10, true, 20), 10);
	assert.equal(shownCount(30, true, 20), 19);
	assert.equal(shownCount(4, true, 20), 4);
	// Expanded never leaves one agent behind either: two go, so the line has a reason to exist.
	assert.equal(shownCount(20, true, 20), 18);
	assert.equal(shownCount(5, true, 5), 3);
});

test("expanded rows take at most half of what the editor and footer leave, never fewer than collapsed", () => {
	assert.equal(expandedBudget(50, 0), 20);
	assert.equal(expandedBudget(50, 2), 18, "mail to main shares the room");
	assert.equal(expandedBudget(12, 0), COLLAPSED_ROWS);
});

test("what doesn't fit is the least urgent: asking, failed and interrupted first, then working, queued, finished; shown rows keep tree order", () => {
	const records = [
		record("done-a", { state: "idle" }), record("lead"), record("helper", { parent: "lead", depth: 2 }),
		record("waits", { state: "queued" }), record("asks", { state: "asking", activity: "asking main" }), record("broke", { state: "failed", error: "x" }),
	];
	const rows = agentRows(records, new Set(["done-a", "broke"]));
	const { shown, hidden } = fitRows(rows, 3);
	assert.deepEqual(shown.map((row) => row.record.name), ["lead", "asks", "broke"]);
	assert.deepEqual(hidden.map((row) => row.record.name), ["done-a", "helper", "waits"]);
	assert.deepEqual(fitRows(rows, 6).shown, rows);
	// A child shown without its parent is not drawn as nested under a row that isn't there.
	const family = agentRows([record("lead", { state: "idle" }), record("helper", { parent: "lead", depth: 2 }), record("other")], new Set(["lead"]));
	assert.deepEqual(fitRows(family, 2).shown.map((row) => [row.record.name, row.depth]), [["helper", 0], ["other", 0]]);
});

test("the control line says how many more and what they are doing, then offers view and expand", () => {
	const hidden = agentRows([record("a"), record("b"), record("c", { state: "idle" }), record("d", { state: "asking" })], new Set(["c"]));
	const control = controlLine(hidden, 7, "expand", 120);
	const line = `  ${text(control.segs)}`;
	assert.equal(line, "  +4 more subagents · 1 asking · 2 working · 1 finished  (view)  (expand)");
	assert.equal(control.segs.find((seg) => seg.text === "1 asking")?.color, "warning");
	assert.deepEqual(control.more, [2, 2 + "+4 more subagents".length]);
	assert.deepEqual(control.view, [line.indexOf("(view)"), line.indexOf("(view)") + 6]);
	assert.deepEqual(control.toggle, [line.indexOf("(expand)"), line.indexOf("(expand)") + 8]);
	assert.match(text(controlLine(hidden, 7, "collapse", 120).segs), /\(view\)  \(collapse\)$/);
	assert.equal(text(controlLine([], 10, "collapse", 120).segs), "10 subagents  (view)  (collapse)");
	// Narrower, what the hidden agents are doing goes first, then the word subagents; the buttons stay whole.
	assert.equal(text(controlLine(hidden, 7, "expand", 40).segs), "+4 more subagents  (view)  (expand)");
	assert.equal(text(controlLine(hidden, 7, "expand", 30).segs), "+4 more  (view)  (expand)");
	// Narrower still, the count goes too, and nothing cut off can be clicked.
	const narrow = controlLine(hidden, 7, "expand", 20);
	assert.equal(text(narrow.segs), "(view)  (expand)");
	assert.deepEqual([narrow.more, narrow.view, narrow.toggle], [[2, 2], [2, 8], [10, 18]]);
	const cut = controlLine(hidden, 7, "expand", 12);
	assert.deepEqual([cut.view, cut.toggle], [[2, 8], [10, 10]], "only the 8 columns before the ellipsis are drawn");
	// With nothing to expand into, there is no toggle.
	const fixed = controlLine(hidden, 7, null, 120);
	assert.equal(text(fixed.segs), "+4 more subagents · 1 asking · 2 working · 1 finished  (view)");
	assert.equal(fixed.toggle, null);
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
	assert.deepEqual(agentRows(records, new Set()).map((row) => row.record.name), ["bg", "nested"]);
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

test("the widget's control line opens the view, expands to fit and collapses back; rows open their inspector", () => {
	let records = Array.from({ length: 10 }, (_, i) => record(`agent-${i}`));
	let factory: ((host: unknown, theme: unknown) => { render(width: number): string[]; handleMouse(event: object): unknown }) | undefined;
	const ui = { setWidget: (_id: string, content: unknown) => { factory = content as typeof factory; } };
	const selected: string[] = [];
	let viewed = 0;
	const widget = createAgentsWidget(() => "reduced");
	widget.attach(ui, () => ({ records, pending: [] }), (name) => selected.push(name), () => { viewed++; });
	const host = { requestRender: () => undefined, terminal: { rows: 40, columns: 120 } };
	let component = factory!(host, quiet());
	const draw = () => component.render(120).map((line) => stripTerminalSequences(line).trimEnd());
	const click = (lines: string[], y: number, word: string) => component.handleMouse({ type: "click", button: "left", x: lines[y]!.indexOf(word) + 1, y });
	let lines = draw();
	assert.equal(lines.length, 4);
	assert.equal(lines[3], "  +7 more subagents · 7 working  (view)  (expand)");
	assert.deepEqual(click(lines, 0, "agent-0"), { handled: true });
	assert.deepEqual(selected, ["agent-0"]);
	click(lines, 3, "(view)");
	click(lines, 3, "+7 more");
	assert.equal(viewed, 2, "the count opens the view too");
	assert.equal(component.handleMouse({ type: "click", button: "left", x: lines[3]!.length + 5, y: 3 }), undefined);
	assert.deepEqual(click(lines, 3, "(expand)"), { handled: true, render: true });
	lines = draw();
	assert.equal(lines.length, 11, "40 rows leave room for all ten");
	assert.equal(lines[10], "  10 subagents  (view)  (collapse)");
	click(lines, 10, "(collapse)");
	assert.equal(draw().length, 4);
	click(draw(), 3, "(expand)");
	// Once every agent is gone the widget empties, and the next batch starts collapsed.
	records = [];
	widget.update();
	records = Array.from({ length: 6 }, (_, i) => record(`next-${i}`));
	widget.update();
	component = factory!(host, quiet());
	assert.equal(draw().length, 4);
	// A terminal too short to give the rows more room offers no (expand) that would do nothing.
	component = factory!({ ...host, terminal: { rows: 12, columns: 120 } }, quiet());
	lines = draw();
	assert.equal(lines[3], "  +3 more subagents · 3 working  (view)");
	assert.equal(component.handleMouse({ type: "click", button: "left", x: lines[3]!.length + 4, y: 3 }), undefined);
	widget.detach();
});
