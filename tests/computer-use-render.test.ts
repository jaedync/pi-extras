import assert from "node:assert/strict";
import test from "node:test";
import { callLines, resultLines, type RowDetails } from "../lib/computer-use/render.ts";

const paint = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
const plain = (code: string) => code.split("\n");
const hint = "ctrl+o to expand";
const strip = (lines: string[]) => lines.map((line) => line.trimEnd());

test("the call row shows the script as code, collapsed to its first lines", () => {
	const code = Array.from({ length: 9 }, (_, index) => `await sky.click({ app: "Finder", element_index: "${index}" });`).join("\n");
	const collapsed = strip(callLines({ code }, { expanded: false, paint, highlight: plain, hint }));
	assert.equal(collapsed[0], "computer_use 9 lines");
	assert.equal(collapsed[1], '  await sky.click({ app: "Finder", element_index: "0" });');
	assert.equal(collapsed.length, 1 + 6 + 1);
	assert.equal(collapsed.at(-1), "  … 3 more lines (ctrl+o to expand)");
	assert.equal(callLines({ code }, { expanded: true, paint, highlight: plain, hint }).length, 1 + 9);
	assert.deepEqual(strip(callLines({ code: "emit(1)" }, { expanded: false, paint, highlight: plain, hint })), ["computer_use", "  emit(1)"]);
	assert.deepEqual(strip(callLines({}, { expanded: false, paint, highlight: plain, hint })), ["computer_use …"]);
});

const details: RowDetails = {
	calls: [
		{ method: "get_app_state", app: "Finder", detail: "", ms: 272, ok: true, approval: "always", startupMs: 940 },
		{ method: "type_text", app: "Finder", detail: '"hello"', ms: 31, ok: true },
		{ method: "click", app: "Finder", detail: "#12", ms: 48, ok: false, error: "no such element" },
	],
	durationMs: 1290,
};

test("the result row lists each call with its target, timing and approval, then a summary", () => {
	const lines = strip(resultLines({ content: [{ type: "text", text: "tree line 1\ntree line 2" }, { type: "image", data: "x", mimeType: "image/png" }], details }, { expanded: false, isError: false, paint, hint }));
	assert.deepEqual(lines, [
		"✓ get_app_state Finder         272ms  started client 940ms, always allowed",
		'✓ type_text     Finder "hello"  31ms',
		"✗ click         Finder #12      48ms  no such element",
		"tree line 1",
		"tree line 2",
		"3 calls in 1.3s, 1 screenshot",
	]);
});

test("long emitted text is previewed and expands", () => {
	const text = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
	const collapsed = strip(resultLines({ content: [{ type: "text", text }], details: { calls: [], durationMs: 5 } }, { expanded: false, isError: false, paint, hint }));
	assert.deepEqual(collapsed.slice(-2), ["… 7 more lines (ctrl+o to expand)", "0 calls in 5ms"]);
	const expanded = resultLines({ content: [{ type: "text", text }], details: { calls: [], durationMs: 5 } }, { expanded: true, isError: false, paint, hint });
	assert.equal(expanded.length, 12 + 1);
});

test("a running script shows finished calls and the one in flight", () => {
	const lines = strip(resultLines({ content: [], details: { calls: details.calls!.slice(0, 1), running: { method: "click", app: "Finder", detail: "#12" } } }, { expanded: false, isError: false, paint, hint, partial: true }));
	assert.deepEqual(lines, [
		"✓ get_app_state Finder     272ms  started client 940ms, always allowed",
		"… click         Finder #12",
	]);
});

test("a failed run keeps the timeline it streamed and shows the error", () => {
	const lines = strip(resultLines({ content: [{ type: "text", text: "Computer Use code stopped: no such element" }], details: {} }, { expanded: false, isError: true, paint, hint, last: details }));
	assert.equal(lines[0].startsWith("✓ get_app_state"), true);
	assert.deepEqual(lines.slice(-1), ["Computer Use code stopped: no such element"]);
});

test("rows from 0.4.0 transcripts, which stored call names only, still render", () => {
	const lines = strip(resultLines({ content: [{ type: "text", text: "ok" }], details: { calls: ["list_apps", "click"] } as never }, { expanded: false, isError: false, paint, hint }));
	assert.deepEqual(lines, ["list_apps, click", "ok"]);
});

test("denied and session-only approvals are labelled", () => {
	const lines = strip(resultLines({ content: [], details: { calls: [
		{ method: "get_app_state", app: "Safari", detail: "", ms: 3000, ok: false, error: "User denied Safari", approval: "deny" },
		{ method: "get_app_state", app: "Notes", detail: "", ms: 1000, ok: true, approval: "once" },
	], durationMs: 4000 } }, { expanded: false, isError: false, paint, hint }));
	assert.match(lines[0], /3\.0s  not allowed$/);
	assert.match(lines[1], /1\.0s  allowed for this session$/);
});
