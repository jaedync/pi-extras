import { test } from "node:test";
import assert from "node:assert/strict";
import { transcriptLines } from "../lib/subagents/transcript.ts";
import { createMessageRenderer, createReportRenderer, subagentCallRow } from "../lib/subagents/render.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

const plain = (_color: string, text: string) => text;
const describe = (tool: string, args: any) => `${tool} ${args?.command ?? args?.path ?? ""}`.trim();
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "");
const theme = { fg: (_k: string, t: string) => t, bg: (_k: string, t: string) => t, bold: (t: string) => t, getFgAnsi: () => "", getBgAnsi: () => "" } as any;

test("transcript shows prompts, text, one line per tool call and short results", () => {
	const lines = transcriptLines([
		{ role: "system", content: "hidden" },
		{ role: "user", content: "Count files" },
		{ role: "assistant", content: [{ type: "thinking", thinking: "Let me\nthink" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] },
		{ role: "toolResult", content: [{ type: "text", text: "a\nb\nc\nd\ne" }] },
		{ role: "toolResult", isError: true, content: [{ type: "text", text: "boom\x1b[31m" }] },
		{ role: "assistant", content: [{ type: "text", text: "Found 5." }] },
	], 60, plain, describe);
	assert.deepEqual(lines.map((line) => line.trimEnd()), [
		"▸ Count files",
		"  thinking: Let me",
		"  ⚙ bash ls",
		"    a", "    b", "    c",
		"    … 2 more lines",
		"    boom",
		"",
		"Found 5.",
	]);
});

test("a message band shows who wrote and whether it asks; a report shows its first lines", () => {
	const message = createMessageRenderer()({ details: { id: "1", kind: "question", from: "scout", text: "Delete it?" } } as any, { expanded: false } as any, theme)!;
	const text = message.render(80).map(strip);
	assert.match(text[0]!, /scout → main.*asks/);
	assert.match(text[1]!, /Delete it\?/);
	const long = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n");
	const report = createReportRenderer()({ details: { id: "2", kind: "report", reports: [
		{ name: "scout", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 5_000, cost: 0.0004, toolCalls: 2, report: long },
	] } } as any, { expanded: false } as any, theme)!;
	const lines = report.render(80).map(strip);
	assert.match(lines[0]!, /scout finished  gpt-6-luna.*\$0\.00040  5\.0s/);
	assert.deepEqual(lines.slice(1, 4).map((line) => line.trim()), ["line 1", "line 2", "line 3"]);
	assert.match(lines[4]!, /… 5 more lines \(click to show\)/);
	(report as any).handleMouse({ type: "click", button: "left" });
	assert.equal(report.render(80).length, 1 + 8);
});

test("a background subagent row stays calm and says so; a finished one shows cost and time", () => {
	const record: AgentRecord = { name: "scout", parent: "main", depth: 1, task: "Find it", model: "openai-codex/gpt-6-luna", readOnly: false, fork: false,
		blocking: false, state: "running", createdAt: 0, startedAt: Date.now() - 3_000, activity: "bash ls", toolCalls: 1, usage: NO_USAGE, runs: 1 };
	const context = { state: { agent: "scout" }, isPartial: false, executionStarted: true };
	let current = record;
	const row = subagentCallRow({ task: "Find it" }, theme, context, () => current);
	assert.match(strip(row.render(80)[0]!), /scout  gpt-6-luna  Find it.*in background/);
	current = { ...record, state: "idle", endedAt: record.startedAt! + 12_000, usage: { ...NO_USAGE, cost: 0.002 } };
	assert.match(strip(row.render(80)[0]!), /\$0\.0020  12\.0s/);
});
