import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { quiet } from "./support/quiet-theme.ts";
import assert from "node:assert/strict";
import { BULLET_GLYPH } from "../lib/band/glyph.ts";
import { transcriptLines } from "../lib/subagents/transcript.ts";
import { createMessageRenderer, createReportRenderer, messageCallRow, subagentCallRow, subagentResultRow } from "../lib/subagents/render.ts";
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

test("a report band shows cost, tokens and time; an answered report stays one band until clicked", () => {
	const report = createReportRenderer()({ details: { id: "5", kind: "report", reports: [
		{ name: "scout", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 65_000, cost: 0.42, toolCalls: 9, tokens: { input: 41_700, output: 3_400 }, report: "a\nb" },
		{ name: "reader", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 5_000, cost: 0.01, toolCalls: 1, tokens: { input: 900, output: 120 }, answered: true, report: "lib/a.ts\nlib/b.ts" },
	] } } as any, { expanded: false } as any, theme)!;
	const lines = report.render(100).map(strip);
	assert.match(lines[0]!, /scout finished  gpt-6-luna.*\$0\.42  42k in · 3\.4k out  1m 05s/);
	assert.deepEqual(lines.slice(1, 3).map((line) => line.trim()), ["a", "b"]);
	assert.match(lines[3]!, /reader finished  gpt-6-luna  answered above.*\$0\.010  900 in · 120 out  5\.0s/);
	assert.equal(lines[4]!.trim(), "… 2 lines (click to show)", "the answer is already on screen; the report waits for a click");
	assert.equal(lines.length, 5);
	(report as any).handleMouse({ type: "click", button: "left" });
	assert.deepEqual(report.render(100).map(strip).slice(4).map((line) => line.trim()), ["lib/a.ts", "lib/b.ts"]);
});

test("an answered report without final text is just its band", () => {
	const report = createReportRenderer()({ details: { id: "7", kind: "report", reports: [
		{ name: "quiet", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 2_000, cost: 0, toolCalls: 1, answered: true },
	] } } as any, { expanded: false } as any, theme)!;
	assert.equal(report.render(100).length, 1);
});

test("a report saved before tokens were recorded still shows cost and time", () => {
	const report = createReportRenderer()({ details: { id: "6", kind: "report", reports: [
		{ name: "old", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 5_000, cost: 0.01, toolCalls: 1, report: "done" },
	] } } as any, { expanded: false } as any, theme)!;
	const head = strip(report.render(100)[0]!);
	assert.match(head, /\$0\.010?  5\.0s/);
	assert.doesNotMatch(head, / in · /);
});

test("a background subagent row stays calm and says so; a finished one shows cost and time", () => {
	const record: AgentRecord = { name: "scout", parent: "main", depth: 1, task: "Find it", model: "openai-codex/gpt-6-luna", readOnly: false, fork: false,
		blocking: false, state: "running", createdAt: 0, startedAt: Date.now() - 3_000, activity: "bash ls", toolCalls: 1, usage: NO_USAGE, runs: 1 };
	const context = { state: { agent: "scout" }, isPartial: false, executionStarted: true };
	let current = record;
	const row = subagentCallRow({ task: "Find it" }, theme, context, () => current);
	assert.match(strip(row.render(80)[0]!), /^ {3}↳ scout  gpt-6-luna  Find it.*in background/);
	current = { ...record, state: "idle", endedAt: record.startedAt! + 12_000, usage: { ...NO_USAGE, cost: 0.002 } };
	assert.match(strip(row.render(80)[0]!), /done.*\$0\.0020  12\.0s/);
});

test("a subagent main waits on shows the task, the full rail and what it is doing", () => {
	const record: AgentRecord = { name: "count-lib", parent: "main", depth: 1, task: "Count the files", model: "openai-codex/gpt-6-luna", readOnly: true, fork: false,
		blocking: true, state: "running", createdAt: 0, startedAt: Date.now() - 3_000, activity: "bash ls lib", toolCalls: 1,
		usage: { ...NO_USAGE, cost: 0.0021 }, contextTokens: 13_600, contextWindow: 272_000, runs: 1 };
	const context = { state: { agent: "count-lib" }, isPartial: false, executionStarted: true };
	let current = record;
	const row = subagentCallRow({ task: "Count the files" }, theme, context, () => current);
	const lines = row.render(100).map(strip);
	assert.match(lines[0]!, /count-lib  gpt-6-luna  Count the files.*ctx 5%  \$0\.0021  3\.0s/);
	assert.equal(lines.length, 2);
	assert.match(lines[1]!, /^ {4}bash ls lib/);
	current = { ...record, state: "idle", activity: null, endedAt: record.startedAt! + 47_000 };
	const done = row.render(100).map(strip);
	assert.equal(done.length, 1);
	assert.match(done[0]!, /ctx 5%  \$0\.0021  47\.0s/);
});

test("while main waits, progress shows only in the call row, not as a partial result", () => {
	const partial = { content: [{ type: "text", text: "calling a tool" }], details: { name: "count-lib", wait: true, activity: "calling a tool" } };
	assert.deepEqual(subagentResultRow(partial, theme, { state: {}, isPartial: true, executionStarted: true }).render(100), []);
	const final = { content: [{ type: "text", text: "Found 15 files." }], details: { name: "count-lib", wait: true } };
	assert.match(strip(subagentResultRow(final, theme, { state: {}, isPartial: false, executionStarted: true }).render(100).join("\n")), /Found 15 files\./);
});

const md = { heading: (t: string) => t, link: (t: string) => t, linkUrl: (t: string) => t, code: (t: string) => t, codeBlock: (t: string) => t,
	codeBlockBorder: (t: string) => t, quote: (t: string) => t, quoteBorder: (t: string) => t, hr: (t: string) => t, listBullet: (t: string) => t,
	bold: (t: string) => t, italic: (t: string) => t, strikethrough: (t: string) => t, underline: (t: string) => t };

test("a waited-on child's result shows only its report, as Markdown", () => {
	const content = "count-lib (openai-codex/gpt-6-luna, $0.0055) finished after 56s. Message it to follow up; it keeps its context.\nSession: /s/count-lib.jsonl\n\nTotal: **15** `.ts` files";
	const context = { state: {}, isPartial: false, executionStarted: true };
	const withReport = subagentResultRow({ content: [{ type: "text", text: content }], details: { name: "count-lib", wait: true, report: "Total: **15** `.ts` files" } }, theme, context, () => md as never);
	assert.deepEqual(withReport.render(100).map(strip).map((line) => line.trim()), ["Total: 15 .ts files"]);
	// Sessions saved before details carried the report.
	const older = subagentResultRow({ content: [{ type: "text", text: content }], details: { name: "count-lib", wait: true } }, theme, context, () => md as never);
	assert.deepEqual(older.render(100).map(strip).map((line) => line.trim()), ["Total: 15 .ts files"]);
});

test("report and message bands render Markdown", () => {
	const report = createReportRenderer(() => md as never)({ details: { id: "2", kind: "report", reports: [
		{ name: "scout", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 5_000, cost: 0, toolCalls: 0, report: "Found **3** in `lib/`" },
	] } } as any, { expanded: false } as any, theme)!;
	assert.equal(strip(report.render(80)[1]!).trim(), "Found 3 in lib/");
	const message = createMessageRenderer(() => md as never)({ details: { id: "1", kind: "note", from: "scout", text: "see **this**" } } as any, { expanded: false } as any, theme)!;
	assert.equal(strip(message.render(80)[1]!).trim(), "see this");
});

test("a queued background child's row says queued", () => {
	const record: AgentRecord = { name: "job-5", parent: "main", depth: 1, task: "Wait", model: "openai-codex/gpt-6-luna", readOnly: false, fork: false,
		blocking: false, state: "queued", createdAt: 0, activity: "queued", toolCalls: 0, usage: NO_USAGE, runs: 0 };
	const row = subagentCallRow({ task: "Wait" }, theme, { state: { agent: "job-5" }, isPartial: false, executionStarted: true }, () => record);
	assert.match(strip(row.render(80)[0]!), /^ {3}↳ job-5  gpt-6-luna  Wait.*queued\s*$/);
});

test("expanding a background row shows its whole task, not the text written for the model", () => {
	const task = "First run `sleep 12` with bash. Then count all files under /Users/someone/project/tests and report the count in one line.";
	const record: AgentRecord = { name: "test-scan", parent: "main", depth: 1, task, model: "openai-codex/gpt-6-astra", readOnly: false, fork: false,
		blocking: false, state: "running", createdAt: 0, startedAt: Date.now(), activity: "bash sleep 12", toolCalls: 0, usage: NO_USAGE, runs: 1 };
	const context = { state: { agent: "test-scan" }, isPartial: false, executionStarted: true, expanded: true };
	const call = subagentCallRow({ task }, theme, context, () => record).render(80).map(strip);
	assert.ok(call.length > 2, "the task wraps under the band");
	assert.match(call.slice(1).join(" ").replace(/\s+/g, " "), /count all files under \/Users\/someone\/project\/tests and report/);
	const started = { content: [{ type: "text", text: "Started test-scan on openai-codex/gpt-6-astra. Talk to it with message({ to: \"test-scan\", text })." }], details: { name: "test-scan" } };
	assert.deepEqual(subagentResultRow(started, theme, context).render(80), []);
});

test("a stopped child's report band says it was stopped before reporting", () => {
	const report = createReportRenderer()({ details: { id: "3", kind: "report", reports: [
		{ name: "long-job", model: "openai-codex/gpt-6-luna", state: "stopped", startedAt: 0, endedAt: 9_600, cost: 0.0004, toolCalls: 1 },
	] } } as any, { expanded: false } as any, theme)!;
	assert.equal(strip(report.render(80)[1]!).trim(), "Stopped before it wrote a report.");
});

test("one hidden line is a line, not lines", () => {
	const report = createReportRenderer()({ details: { id: "4", kind: "report", reports: [
		{ name: "digest", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 1_000, cost: 0, toolCalls: 0, report: "a\nb\nc\nd" },
	] } } as any, { expanded: false } as any, theme)!;
	assert.match(strip(report.render(80)[4]!), /… 1 more line \(click to show\)/);
});

test("handoff chips keep Shell Jobs' tint only under their words and remain still; restored, error and wait rows stay bands", () => {
	const record: AgentRecord = { name: "scout", parent: "main", depth: 1, task: "界😀é", model: "openai-codex/luna", readOnly: true, fork: false,
		blocking: false, state: "running", createdAt: 0, startedAt: 0, activity: "working", toolCalls: 1, usage: NO_USAGE, runs: 1 };
	const ctx = { state: { agent: "scout" }, isPartial: false, executionStarted: true };
	const tinted = quiet();
	const row = subagentCallRow({ task: record.task }, tinted as never, ctx, () => record);
	const raw = row.render(100)[0]!;
	assert.equal(raw, row.render(100)[0]!, "no clock or sweep in the chip");
	assert.match(strip(raw), /^ {3}↳ scout/);
	assert.match(raw, /\x1b\[49m(?:\x1b\[[0-9;]*m)* {20,}\x1b\[0m$/, "no background under trailing space");
	for (const width of [1, 2, 4, 8, 20, 40]) assert.ok(row.render(width).every((line) => visibleWidth(line) <= width));
	for (const [args, context, lookup] of [
		[{ wait: true }, ctx, () => record],
		[{}, { ...ctx, isError: true }, () => record],
		[{}, ctx, () => undefined],
		[{}, { ...ctx, expanded: true }, () => record],
	] as const) assert.doesNotMatch(strip(subagentCallRow(args, theme, context, lookup).render(100)[0]!), /↳/);
});

test("a wait that ended early says why in plain words", () => {
	const context = { state: {}, isPartial: false, executionStarted: true };
	const asked = subagentResultRow({ content: [{ type: "text", text: "Stopped waiting: checker asked you something. Answer with message({ to: \"checker\", text })." }], details: { name: "checker", wait: true, detached: true, asked: true } }, theme, context);
	assert.deepEqual(asked.render(100).map(strip).map((line) => line.trim()), ["It asked you something, so the wait ended. Its report will arrive as a message."]);
	const escaped = subagentResultRow({ content: [{ type: "text", text: "Stopped waiting. checker keeps running." }], details: { name: "checker", wait: true, detached: true } }, theme, context);
	assert.deepEqual(escaped.render(100).map(strip).map((line) => line.trim()), ["You stopped waiting. It keeps running, and its report will arrive as a message."]);
});

test("report and message rows never draw wider than the terminal, however narrow", () => {
	// Pi stops drawing, and throws, on a line wider than the terminal.
	const long = Array.from({ length: 8 }, (_, i) => `line ${i + 1} with a few more words`).join("\n");
	const report = createReportRenderer()({ details: { id: "9", kind: "report", reports: [
		{ name: "scout", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 5_000, cost: 0.0004, toolCalls: 2, report: long },
	] } } as any, { expanded: false } as any, theme)!;
	const message = createMessageRenderer()({ details: { id: "1", kind: "question", from: "scout", text: "Delete it? It is a longer question." } } as any, { expanded: false } as any, theme)!;
	for (let width = 1; width <= 40; width++) {
		for (const line of [...report.render(width), ...message.render(width)]) assert.ok(visibleWidth(line) <= width, `width ${width}: ${strip(line)}`);
	}
});

test("an unstarted subagent or message call spins only while the model writes it", () => {
	const rows = {
		subagent: (context: object, streaming: () => boolean) => subagentCallRow({ task: "Find it" }, theme, context, () => undefined, streaming),
		message: (context: object, streaming: () => boolean) => messageCallRow({ to: "scout", text: "hi" }, theme, context, streaming),
	};
	const margin = (lines: string[]) => strip(lines[0]!).slice(0, 2);
	for (const [kind, row] of Object.entries(rows)) {
		const writing = { state: {}, isPartial: true, executionStarted: false, argsComplete: false };
		assert.equal(margin(row(writing, () => true).render(80)), `${BULLET_GLYPH} `, `${kind}: written now, its bullet is dim`);
		assert.equal(margin(row({ ...writing, argsComplete: true }, () => false).render(80)), `${BULLET_GLYPH} `, `${kind}: written, it waits its turn`);
		// A resumed session rebuilds a call without its result as unstarted and never completes its arguments.
		assert.equal(margin(row({ ...writing, state: {} }, () => false).render(80)), "  ", `${kind}: rebuilt from history, it stays still`);
		// The row keeps what it was built as: one built while streaming stops once the stream ends.
		let streaming = true;
		const live = row({ ...writing, state: {} }, () => streaming);
		streaming = false;
		assert.equal(margin(live.render(80)), "  ", `${kind}: its message ended`);
	}
});
