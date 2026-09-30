import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { codemodeRenderers } from "../lib/tool-display/codemode.ts";
import { NestedCalls } from "../lib/tool-display/nested.ts";
import { harness, row, text, theme } from "./support/tool-rows.ts";

const start = (id: string, parent = "script", name = "read") => ({ type: "tool_execution_start", toolCallId: id, parentToolCallId: parent, toolName: name, args: { path: "界😀/file" } });
const end = (id: string, error = false) => ({ type: "tool_execution_end", toolCallId: id, parentToolCallId: "script", toolName: "read", result: text(error ? "failed" : "contents"), isError: error });
const setup = () => {
	const h = harness();
	const calls = new NestedCalls(h.now);
	const kit = { ...h.kit, nestedCalls: (id: string) => calls.get(id) };
	const script = row(codemodeRenderers(kit, { name: "codemode" }), { code: "await tools.read({ path: '界😀/file' });" }, "script");
	return { ...h, calls, script };
};

test("codemode observes actual nested calls, overlap and timing, never JS syntax", () => {
	const h = setup();
	h.script.update({ executionStarted: true });
	assert.match(h.script.lines()[0]!, /\{\} codemode · JavaScript/);
	assert.equal(h.script.lines().length, 1, "does not guess execution from JS source");
	h.calls.observe(start("script/1"));
	h.advance(120);
	h.calls.observe(start("script/2", "script", "bash"));
	h.script.update({ executionStarted: true });
	assert.match(h.script.lines().join("\n"), /ƒ1.*read.*overlap.*running/);
	assert.match(h.script.lines().join("\n"), /ƒ2.*bash.*overlap.*running/);
	h.advance(280);
	h.calls.observe(end("script/1"));
	h.calls.observe(end("script/2", true));
	h.script.update({ executionStarted: true, isPartial: false, result: text("script failed"), isError: true });
	assert.match(h.script.lines().join("\n"), /read.*done.*400ms/);
	assert.match(h.script.lines().join("\n"), /bash.*failed.*280ms/);
	assert.ok(h.script.click());
	assert.match(h.popups[0]!.head(theme, 80, 0).join("\n"), /await tools.read/);
	assert.match(h.popups[0]!.output(theme, 80, 0).join("\n"), /contents/);
});

test("nested records restore duration and unfinished status without guessed starts or overlap", () => {
	const h = setup();
	h.calls.restore("script", { complete: false, calls: [
		{ id: "script/1", name: "read", status: "ok", durationMs: 35 },
		{ id: "script/2", name: "bash", status: "unfinished" },
	] });
	h.script.update({ isPartial: false, result: text("result") });
	const lines = h.script.lines().join("\n");
	assert.match(lines, /read.*done.*35ms/);
	assert.match(lines, /bash.*unfinished/);
	assert.match(lines, /incomplete/);
	assert.doesNotMatch(lines, /parallel|overlap|running|0ms|sequential/);
	assert.doesNotMatch(h.script.lines()[0]!, /\d+ms|\d+\.\ds/);
	h.script.click();
	assert.match(h.popups[0]!.output(theme, 80, 0).join("\n"), /not saved/);
});

test("older and foreign codemode tools fall back to their words and full script with no fake calls", () => {
	const h = harness();
	const tool = { name: "codemode", renderResult: () => ({ render: () => ["their result"], invalidate() {} }) };
	const script = row(codemodeRenderers(h.kit, tool), { code: "Promise.all([unrelated(), nope()]);\nreturn '界😀';" });
	script.update({ isPartial: false, expanded: true, result: text("foreign output") });
	assert.match(script.lines().join("\n"), /Promise.all/);
	assert.match(script.lines().join("\n"), /their result/);
	assert.doesNotMatch(script.lines().join("\n"), /ƒ\d|parallel|overlap|sequential/);
});

test("built-in streamed details are authoritative fallback, bounded and safe at narrow widths", () => {
	const h = setup();
	const calls = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: "read界😀", args: "{path: 'file'}", status: i === 11 ? "cancelled" : "ok", durationMs: i + 1 }));
	h.script.update({ executionStarted: true, isPartial: false, result: text("output", { calls }) });
	assert.ok(h.script.lines().length <= 8);
	assert.match(h.script.lines().join("\n"), /earlier call/);
	assert.match(h.script.lines().join("\n"), /aborted/);
	for (const width of [1, 2, 4, 8, 20, 40]) {
		assert.ok(h.script.raw(width).every((line) => visibleWidth(line) <= width), `width ${width}`);
	}
});

test("nested descendants are not mistaken for parallel siblings and reduced motion stays steady", () => {
	const h = setup();
	h.calls.observe(start("script/1"));
	h.calls.observe(start("script/1/1", "script/1", "write"));
	assert.ok(h.calls.get("script")!.calls.every((call) => !call.overlapping));
	h.calls.observe(end("script/1"));
	h.calls.observe({ ...end("script/1/1"), parentToolCallId: "script/1" });
	h.calls.observe(start("script/2"));
	assert.ok(h.calls.get("script")!.calls.every((call) => !call.overlapping), "non-overlapping call lifetimes never receive an overlap label");
	const reduced = { ...h.kit, motion: () => "reduced" as const, nestedCalls: (id: string) => h.calls.get(id) };
	const script = row(codemodeRenderers(reduced, { name: "codemode" }), { code: "return 1;" }, "script");
	script.update({ executionStarted: true });
	assert.deepEqual(script.raw(), script.raw());
	h.advance(50);
	h.calls.observe(end("script/2", true));
	script.update({ executionStarted: true, isPartial: false, result: text("aborted", { calls: [{ id: "script/2", name: "read", status: "cancelled" }] }), isError: true });
	assert.match(script.lines().join("\n"), /read.*aborted/);
});

test("live nested output is bounded with honest truncation and omission notices", () => {
	const calls = new NestedCalls(() => 1);
	for (let i = 0; i < 12; i++) {
		calls.observe(start(`script/${i}`));
		calls.observe({ ...end(`script/${i}`), result: text("x".repeat(20_000)) });
	}
	const snapshot = calls.get("script")!;
	assert.ok(snapshot.calls.reduce((sum, call) => sum + (call.args?.length ?? 0) + (call.output?.length ?? 0), 0) < 70_000);
	assert.equal(snapshot.complete, false);
	assert.ok(snapshot.calls.some((call) => call.output?.includes("truncated")));
	assert.ok(snapshot.calls.some((call) => call.output?.includes("omitted")));
});

test("nested tracking is bounded, ignores malformed records, preserves updates and closes unfinished live calls honestly", () => {
	let now = 100;
	const calls = new NestedCalls(() => now);
	calls.observe(start("script/1"));
	calls.observe({ ...start("script/1"), type: "tool_execution_update", partialResult: text("partial") });
	assert.equal(calls.get("script")!.calls.length, 1);
	now = 400;
	calls.finish("script");
	assert.equal(calls.get("script")!.calls[0]!.status, "unfinished");
	assert.equal(calls.get("script")!.calls[0]!.durationMs, 300);
	calls.restore("bad", { calls: [null, { id: "1", name: "x", status: "ok", durationMs: -1 }] });
	assert.equal(calls.get("bad")!.calls.length, 1);
	assert.equal(calls.get("bad")!.calls[0]!.durationMs, undefined);
	for (let i = 0; i < 300; i++) calls.observe(start(`many/${i}`, "many"));
	assert.equal(calls.get("many")!.calls.length, 256);
	assert.equal(calls.get("many")!.complete, false);
	calls.clear();
	assert.equal(calls.get("script"), undefined);
});
