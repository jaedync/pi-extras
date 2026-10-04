import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fgOf, quiet } from "./support/quiet-theme.ts";
import { colorOf } from "./support/tool-rows.ts";
import { agentHue } from "../lib/band/agent-look.ts";
import assert from "node:assert/strict";
import { envelopeLines, type Painter, type Voices } from "../lib/subagents/transcript.ts";
import { noteText, questionText, readEnvelopes, reportText } from "../lib/subagents/format.ts";
import { createMessageRenderer, createReportRenderer, messageCallRow, subagentCallRow, subagentResultRow } from "../lib/subagents/render.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

const plain = (_color: string, text: string) => text;
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "");
const theme = quiet() as any;
const bodyText = (line: string) => line.trim();
const voices: Voices = { self: "surveyor", hue: (name) => agentHue(name === "finder" ? "anthropic/claude-sonnet-5-5" : name === "surveyor" ? "openai-codex/gpt-6-luna" : undefined) };

/** What an agent was told, as the inspector sets each delivery: a blank line, then its rows; a plain prompt is Pi's user message, so it is left out here. */
function told(messages: Array<{ content: unknown }>, width: number, paint: Painter): string[] {
	const text = (content: unknown) => typeof content === "string" ? content : (content as Array<{ text?: string }>).map((block) => block.text ?? "").join("\n");
	return messages.flatMap((message) => readEnvelopes(text(message.content)).flatMap((part) => (part.kind === "prompt" ? [] : ["", ...envelopeLines(part, width, paint, voices)])));
}

test("agent mail names its sender and asks; a report previews its first lines", () => {
	const message = createMessageRenderer()({ details: { id: "1", kind: "question", from: "scout", text: "Delete it?" } } as any, { expanded: false } as any, theme)!;
	const text = message.render(80).map(strip);
	assert.match(text[0]!, /scout → main.*asks/);
	assert.match(text[1]!, /Delete it\?/);
	const long = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n");
	const report = createReportRenderer()({ details: { id: "2", kind: "report", reports: [
		{ name: "scout", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 5_000, cost: 0.0004, toolCalls: 2, report: long },
	] } } as any, { expanded: false } as any, theme)!;
	const lines = report.render(80).map(strip);
	assert.ok(!lines.includes(""), "one report has no separator row");
	assert.match(lines[0]!, /  ◆ scout reported  5\.0s  gpt-6-luna  \$0\.00040/);
	assert.deepEqual(lines.slice(1, 4).map(bodyText), ["line 1", "line 2", "line 3"]);
	assert.match(lines[4]!, /… 5 more lines \(click to show\)/);
	(report as any).handleMouse({ type: "click", button: "left" });
	assert.equal(report.render(80).length, 1 + 8);
});

test("report headers show time, model and cost; multiple reports have a blank separator and answered bodies wait for a click", () => {
	const report = createReportRenderer()({ details: { id: "5", kind: "report", reports: [
		{ name: "scout", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 65_000, cost: 0.42, toolCalls: 9, tokens: { input: 41_700, output: 3_400 }, report: "a\nb" },
		{ name: "reader", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 5_000, cost: 0.01, toolCalls: 1, tokens: { input: 900, output: 120 }, answered: true, report: "lib/a.ts\nlib/b.ts" },
	] } } as any, { expanded: false } as any, theme)!;
	const lines = report.render(100).map(strip);
	assert.match(lines[0]!, /  ◆ scout reported  1m05s  gpt-6-luna  \$0\.42 · 42k in · 3\.4k out/);
	assert.deepEqual(lines.slice(1, 3).map(bodyText), ["a", "b"]);
	assert.equal(lines[3], "", "a blank row separates reports, not their headers from their bodies");
	assert.match(lines[4]!, /  ◆ reader reported  5\.0s  gpt-6-luna  \$0\.010 · 900 in · 120 out  answered above/);
	assert.equal(bodyText(lines[5]!), "… 2 lines (click to show)", "the answer is already on screen; the report waits for a click");
	assert.equal(lines.length, 6);
	(report as any).handleMouse({ type: "click", button: "left" });
	assert.equal(report.render(100)[3], "", "expansion keeps the separator");
	assert.deepEqual(report.render(100).map(strip).slice(5).map(bodyText), ["lib/a.ts", "lib/b.ts"]);
});

test("an answered report without final text is just its header", () => {
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
	assert.match(head, /reported  5\.0s  gpt-6-luna  \$0\.010?/);
	assert.doesNotMatch(head, / in · /);
});

test("a background agent joins with its task below; its final status shows elapsed time", () => {
	const record: AgentRecord = { name: "scout", parent: "main", depth: 1, task: "Find it", model: "openai-codex/gpt-6-luna", readOnly: false, fork: false,
		blocking: false, state: "running", createdAt: 0, startedAt: Date.now() - 3_000, activity: "bash ls", toolCalls: 1, usage: NO_USAGE, runs: 1 };
	const context = { state: { agent: "scout" }, isPartial: false, executionStarted: true };
	let current = record;
	const row = subagentCallRow({ task: "Find it" }, theme, context, () => current);
	assert.match(strip(row.render(80)[0]!), /^ {2}◆ scout joined  gpt-6-luna  working/);
	assert.equal(bodyText(strip(row.render(80)[1]!)), "Find it");
	current = { ...record, state: "idle", endedAt: record.startedAt! + 12_000, usage: { ...NO_USAGE, cost: 0.002 } };
	assert.match(strip(row.render(80)[0]!), /finished · 12\.0s/);
});

test("a waited agent shows one compact presence line with animated activity, then settles without a task", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	const record: AgentRecord = { name: "count-lib", parent: "main", depth: 1, task: "Count the files", model: "openai-codex/gpt-6-luna", readOnly: true, fork: false,
		blocking: true, state: "running", createdAt: 0, startedAt: Date.now() - 3_000, activity: "bash ls lib", toolCalls: 1,
		usage: { ...NO_USAGE, cost: 0.0021 }, contextTokens: 13_600, contextWindow: 272_000, runs: 1 };
	const context = { state: { agent: "count-lib" }, isPartial: false, executionStarted: true };
	let current = record;
	const row = subagentCallRow({ task: "Count the files" }, theme, context, () => current);
	const lines = row.render(100).map(strip);
	assert.match(lines[0]!, /^ {2}◆ count-lib  3\.0s  \$0\.0021  gpt-6-luna  \S{3} bash ls lib/);
	assert.equal(lines.length, 1);
	assert.doesNotMatch(row.render(100)[0]!, /\x1b\[48;|▍/);
	assert.doesNotMatch(lines.join("\n"), /Count the files/);
	current = { ...record, state: "idle", activity: null, endedAt: record.startedAt! + 47_000 };
	const done = row.render(100).map(strip);
	assert.equal(done.length, 1);
	assert.match(done[0]!, /finished · 47\.0s/);
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
	assert.deepEqual(withReport.render(100).map(strip).map(bodyText), ["Total: 15 .ts files"]);
	// Sessions saved before details carried the report.
	const older = subagentResultRow({ content: [{ type: "text", text: content }], details: { name: "count-lib", wait: true } }, theme, context, () => md as never);
	assert.deepEqual(older.render(100).map(strip).map(bodyText), ["Total: 15 .ts files"]);
});

test("report and mail bodies render Markdown indented under their names", () => {
	const report = createReportRenderer(() => md as never)({ details: { id: "2", kind: "report", reports: [
		{ name: "scout", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 5_000, cost: 0, toolCalls: 0, report: "Found **3** in `lib/`" },
	] } } as any, { expanded: false } as any, theme)!;
	assert.equal(bodyText(strip(report.render(80)[1]!)), "Found 3 in lib/");
	const message = createMessageRenderer(() => md as never)({ details: { id: "1", kind: "note", from: "scout", text: "see **this**" } } as any, { expanded: false } as any, theme)!;
	assert.equal(bodyText(strip(message.render(80)[1]!)), "see this");
});

test("a queued background child's row says queued", () => {
	const record: AgentRecord = { name: "job-5", parent: "main", depth: 1, task: "Wait", model: "openai-codex/gpt-6-luna", readOnly: false, fork: false,
		blocking: false, state: "queued", createdAt: 0, activity: "queued", toolCalls: 0, usage: NO_USAGE, runs: 0 };
	const row = subagentCallRow({ task: "Wait" }, theme, { state: { agent: "job-5" }, isPartial: false, executionStarted: true }, () => record);
	assert.match(strip(row.render(80)[0]!), /^ {2}◇ job-5 joined  gpt-6-luna  queued\s*$/);
});

test("expanding a background row shows its whole task, not the text written for the model", () => {
	const task = "First run `sleep 12` with bash. Then count all files under /Users/someone/project/tests and report the count in one line.";
	const record: AgentRecord = { name: "test-scan", parent: "main", depth: 1, task, model: "openai-codex/gpt-6-astra", readOnly: false, fork: false,
		blocking: false, state: "running", createdAt: 0, startedAt: Date.now(), activity: "bash sleep 12", toolCalls: 0, usage: NO_USAGE, runs: 1 };
	const context = { state: { agent: "test-scan" }, isPartial: false, executionStarted: true, expanded: true };
	const call = subagentCallRow({ task }, theme, context, () => record).render(80).map(strip);
	assert.ok(call.length > 2, "the task wraps under the colleague header");
	assert.match(call.slice(1).map(bodyText).join(" ").replace(/\s+/g, " "), /count all files under \/Users\/someone\/project\/tests and report/);
	const started = { content: [{ type: "text", text: "Started test-scan on openai-codex/gpt-6-astra. Talk to it with message({ to: \"test-scan\", text })." }], details: { name: "test-scan" } };
	assert.deepEqual(subagentResultRow(started, theme, context).render(80), []);
});

test("a stopped agent's report says it was stopped before reporting", () => {
	const report = createReportRenderer()({ details: { id: "3", kind: "report", reports: [
		{ name: "long-job", model: "openai-codex/gpt-6-luna", state: "stopped", startedAt: 0, endedAt: 9_600, cost: 0.0004, toolCalls: 1 },
	] } } as any, { expanded: false } as any, theme)!;
	assert.equal(bodyText(strip(report.render(80)[1]!)), "Stopped before it wrote a report.");
});

test("one hidden line is a line, not lines", () => {
	const report = createReportRenderer()({ details: { id: "4", kind: "report", reports: [
		{ name: "digest", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 1_000, cost: 0, toolCalls: 0, report: "a\nb\nc\nd" },
	] } } as any, { expanded: false } as any, theme)!;
	assert.match(strip(report.render(80)[4]!), /… 1 more line \(click to show\)/);
});

test("background agent rows stay still without a background; all call states keep the margin", () => {
	const record: AgentRecord = { name: "scout", parent: "main", depth: 1, task: "界😀é", model: "openai-codex/luna", readOnly: true, fork: false,
		blocking: false, state: "running", createdAt: 0, startedAt: 0, activity: "working", toolCalls: 1, usage: NO_USAGE, runs: 1 };
	const ctx = { state: { agent: "scout" }, isPartial: false, executionStarted: true };
	const tinted = quiet();
	const row = subagentCallRow({ task: record.task }, tinted as never, ctx, () => record);
	const raw = row.render(100)[0]!;
	assert.equal(raw, row.render(100)[0]!, "no clock or sweep in a background call");
	assert.match(strip(raw), /^ {2}◆ scout joined/);
	assert.equal(visibleWidth(raw), 100);
	assert.doesNotMatch(raw, /\x1b\[48;|▍/, "no agent surface or rail");
	for (const width of [1, 2, 4, 8, 20, 40]) assert.ok(row.render(width).every((line) => visibleWidth(line) <= width));
	for (const [args, context, lookup] of [
		[{ wait: true }, ctx, () => record],
		[{}, { ...ctx, isError: true }, () => record],
		[{}, ctx, () => undefined],
		[{}, { ...ctx, expanded: true }, () => record],
	] as const) {
		const lines = subagentCallRow(args, theme, context, lookup).render(100);
		assert.match(strip(lines[0]!), /^ {2}◆ /);
		for (const line of lines) assert.doesNotMatch(line, /\x1b\[48;|▍/);
	}
});

test("a wait that ended early says why in plain words", () => {
	const context = { state: {}, isPartial: false, executionStarted: true };
	const asked = subagentResultRow({ content: [{ type: "text", text: "Stopped waiting: checker asked you something. Answer with message({ to: \"checker\", text })." }], details: { name: "checker", wait: true, detached: true, asked: true } }, theme, context);
	assert.deepEqual(asked.render(100).map(strip).map(bodyText), ["It asked you something, so the wait ended. Its report will arrive as a message."]);
	const escaped = subagentResultRow({ content: [{ type: "text", text: "Stopped waiting. checker keeps running." }], details: { name: "checker", wait: true, detached: true } }, theme, context);
	assert.deepEqual(escaped.render(100).map(strip).map(bodyText), ["You stopped waiting. It keeps running, and its report will arrive as a message."]);
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

test("unstarted agent calls use a hollow avatar; message calls keep their arrow and margin", () => {
	const rows = {
		subagent: (context: object, streaming: () => boolean) => subagentCallRow({ task: "Find it" }, theme, context, () => undefined, streaming),
		message: (context: object, streaming: () => boolean) => messageCallRow({ to: "scout", text: "hi" }, theme, context, streaming),
	};
	const identity = (lines: string[]) => strip(lines[0]!).slice(0, 4);
	for (const [kind, row] of Object.entries(rows)) {
		const writing = { state: {}, isPartial: true, executionStarted: false, argsComplete: false };
		const expected = kind === "subagent" ? "  ◇ " : "  → ";
		assert.equal(identity(row(writing, () => true).render(80)), expected, `${kind}: being written`);
		assert.equal(identity(row({ ...writing, argsComplete: true }, () => false).render(80)), expected, `${kind}: waiting its turn`);
		// A resumed session rebuilds a call without its result as unstarted and never completes its arguments.
		assert.equal(identity(row({ ...writing, state: {} }, () => false).render(80)), expected, `${kind}: rebuilt from history`);
		// Ending the model stream never turns the conversation margin into a tool spinner.
		let streaming = true;
		const live = row({ ...writing, state: {} }, () => streaming);
		streaming = false;
		assert.equal(identity(live.render(80)), expected, `${kind}: its message ended`);
	}
});

test("what you wrote to an agent reads as an arrow to it, not as an agent speaking", () => {
	const render = createMessageRenderer();
	const relay = render({ details: { kind: "relay", id: "m1", from: "user", to: "reviewer", text: "Check the docs too.", answered: false } } as any, { expanded: false, outputPad: 1 }, theme)!;
	const [head] = relay.render(60).map(strip);
	assert.ok(head!.startsWith("  → reviewer"), head);
	assert.ok(!head!.includes("◆"), head);
	assert.ok(head!.trimEnd().endsWith("you wrote"), head);
});

test("every row of an agent wears its provider's color: joining, reporting, its mail and what is sent to it", () => {
	const codex = fgOf(agentHue("openai-codex/gpt-6-luna"));
	const record: AgentRecord = { name: "scout", parent: "main", depth: 1, task: "Find it", model: "openai-codex/gpt-6-luna", readOnly: false, fork: false,
		blocking: false, state: "running", createdAt: 0, startedAt: Date.now() - 3_000, activity: "bash ls", toolCalls: 1, usage: NO_USAGE, runs: 1 };
	const lookup = (name: string) => (name === "scout" ? record : undefined);
	const first = (component: { render(width: number): string[] }) => component.render(80)[0]!;
	const done = { state: { agent: "scout" }, isPartial: false, executionStarted: true };
	assert.equal(colorOf(first(subagentCallRow({ task: "Find it" }, theme, done, lookup)), "◆ scout"), codex);
	const report = createReportRenderer()({ details: { id: "2", kind: "report", reports: [
		{ name: "scout", model: "openai-codex/gpt-6-luna", state: "idle", startedAt: 0, endedAt: 5_000, cost: 0, toolCalls: 1, report: "done" },
	] } } as any, { expanded: false } as any, theme)!;
	assert.equal(colorOf(first(report), "◆ scout"), codex);
	const mail = createMessageRenderer(undefined, lookup);
	assert.equal(colorOf(first(mail({ details: { id: "1", kind: "question", from: "scout", text: "Delete it?" } } as any, { expanded: false } as any, theme)!), "◆ scout"), codex);
	assert.equal(colorOf(first(mail({ details: { kind: "relay", id: "m1", from: "user", to: "scout", text: "Also docs.", answered: false } } as any, { expanded: false } as any, theme)!), "→ scout"), codex);
	assert.equal(colorOf(first(messageCallRow({ to: "scout", text: "hi" }, theme, { state: {} }, () => false, lookup)), "→ scout"), codex);
	// An agent this session no longer knows keeps the purple.
	assert.equal(colorOf(first(mail({ details: { id: "3", kind: "note", from: "ghost", text: "hi" } } as any, { expanded: false } as any, theme)!), "◆ ghost"), fgOf("#b294b0"));
});

test("what an agent was told reads as the conversation main shows: arrows from you and main, the ◆ of the agent that sent it", () => {
	const tag = (color: string, text: string) => `<${color}>${text}`;
	const child: AgentRecord = { name: "lead-a", parent: "surveyor", depth: 2, task: "t", model: "opencode-go/deepseek-v4.1-flash", readOnly: false, fork: false, blocking: false,
		state: "idle", createdAt: 0, startedAt: 0, endedAt: 16_000, activity: null, toolCalls: 1, usage: NO_USAGE, runs: 1, report: "Found 3." };
	const batch = [noteText("user", "Also say which is longer."), questionText("main", "Which file?"), noteText("finder", "lib/x.ts")].join("\n\n");
	const lines = told([
		{ content: "Survey the files" },
		{ content: [{ type: "text", text: batch }] },
		{ content: reportText(child, 0) },
		{ content: reportText({ ...child, state: "failed", error: "rate limited", report: undefined }, 0) },
	], 100, tag); // The tags count as visible width; terminal escapes don't.
	assert.deepEqual(lines.map((line) => strip(line).replace(/<[^>]+>/g, "").trimEnd()), [
		"",
		"→ surveyor  you wrote",
		"  Also say which is longer.",
		"",
		"→ surveyor  main asks",
		"  Which file?",
		"",
		"◆ finder → surveyor  note",
		"  lib/x.ts",
		"",
		"◆ lead-a reported  16s  deepseek-v4.1-flash",
		"  Found 3.",
		"",
		"◆ lead-a ✗ failed  16s  deepseek-v4.1-flash",
		"  rate limited",
	]);
	const line = (start: string) => lines.find((candidate) => strip(candidate).replace(/<[^>]+>/g, "").startsWith(start))!;
	assert.match(line("→ surveyor  you"), new RegExp(`^\\x1b\\[1m<${agentHue("openai-codex/x")}>→ surveyor\\x1b\\[22m  <dim>you wrote$`));
	assert.match(line("→ surveyor  main"), /<dim>main <warning>asks$/);
	assert.match(line("◆ finder"), new RegExp(`^\\x1b\\[1m<${agentHue("anthropic/x")}>◆ finder\\x1b\\[22m<dim> → surveyor  <dim>note$`));
	assert.match(line("◆ lead-a reported"), new RegExp(`<${agentHue("opencode-go/x")}>◆ lead-a.*<muted> reported  <text>16s  <dim>deepseek`));
	assert.match(line("◆ lead-a ✗"), /<error> ✗ failed/);
	assert.equal(lines[lines.indexOf(line("◆ lead-a ✗")) + 1], "  <error>rate limited");
	assert.equal(lines[lines.indexOf(line("◆ finder")) + 1], "  <customMessageText>lib/x.ts");
	// A header is cut to the width; only the text under it wraps.
	assert.ok(visibleWidth(told([{ content: noteText("finder", "x") }], 12, plain)[1]!) <= 12);
});
