import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { PopupView } from "../lib/band/popup.ts";
import { Sheet } from "../lib/band/sheet.ts";
import { codemodeRenderers } from "../lib/tool-display/codemode.ts";
import { NestedCalls } from "../lib/tool-display/nested.ts";
import * as nested from "../lib/tool-display/nested.ts";
import { harness, row, text, theme } from "./support/tool-rows.ts";

const start = (id: number) => ({ type: "tool_execution_start", parentToolCallId: "script", toolCallId: `script/${id}`, toolName: "read", args: { path: `cell-${id}` } });
const end = (id: number, output = `nested-${id}`) => ({ type: "tool_execution_end", parentToolCallId: "script", toolCallId: `script/${id}`, toolName: "read", result: text(output), isError: false });
const bare = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());

function setup(code = "return 1;", tool = { name: "codemode" }) {
	const h = harness();
	const calls = new NestedCalls(h.now);
	const args = { code };
	const script = row(codemodeRenderers({ ...h.kit, nestedCalls: (id) => calls.get(id) }, tool), args, "script");
	script.update({ executionStarted: true });
	script.click();
	const source = h.popups[0]!;
	return { ...h, calls, script, source, args, view: new PopupView(theme, source) };
}

const copied = (source: ReturnType<typeof setup>["source"], selected: number, key: string) => source.copies!(selected).find((copy) => copy.key === key)?.text();

test("codemode copy callbacks bypass decorative million-column rendering and copy exact source or sanitized result", () => {
	const code = ` \t// ${"x".repeat(128 * 1_024)}\n\treturn '界😀'; \n`;
	const root = `\x1b[31m${"r".repeat(128 * 1_024)}\x1b[0m\n`;
	const h = setup(code);
	for (let id = 1; id <= 3; id++) { h.calls.observe(start(id)); h.calls.observe(end(id)); }
	h.script.update({ executionStarted: true, isPartial: false, result: text(root) });
	const nested = copied(h.source, 2, "o")!;
	assert.ok(nested.length < 100, "copy preview contains no header, args, timing or million-space padding");
	assert.equal(nested, "nested-1");
	assert.equal(copied(h.source, 0, "c"), code, "script copying preserves original whitespace and Unicode");
	assert.equal(copied(h.source, 1, "o"), `${"r".repeat(128 * 1_024)}\n`, "root copy uses full sanitized text, not the result renderer");
	assert.equal(h.source.copies!(2).find((copy) => copy.key === "o")!.label, "copy preview");
});

test("fixed source/result selectors precede actual call selectors; long source lives wholly in the scrollable body", () => {
	const code = Array.from({ length: 100 }, (_, i) => `const statement_${i} = ${i};`).join("\n");
	const h = setup(code);
	h.calls.observe(start(1)); h.calls.observe(end(1));
	h.script.update({ executionStarted: true, isPartial: false, result: text("root result") });
	assert.equal(h.source.stepCount(), 3);
	const head = bare(h.view.head(80, 20));
	assert.equal(head.length, 4, "one details line and exactly one selectable line per view");
	assert.match(head[1]!, /^1 script source$/);
	assert.match(head[2]!, /^2 script result$/);
	assert.match(head[3]!, /^\s*3\s+ƒ1 read/);
	assert.ok(h.view.pick(1));
	assert.equal(h.view.step, 0);
	assert.equal(h.view.bodyLabel(), "script source");
	assert.deepEqual(bare(h.view.body(80)), code.split("\n"));
	assert.ok(h.view.pick(2));
	assert.equal(h.view.bodyLabel(), "script result");
	assert.deepEqual(bare(h.view.body(80)), ["root result"]);
	assert.ok(h.view.pick(3));
	assert.match(h.view.bodyLabel(), /ƒ1 read/);
	assert.match(bare(h.view.body(80)).join("\n"), /nested-1/);
	assert.equal(h.view.pick(4), false, "a JavaScript statement line cannot select a call");
});

test("the real popup sheet scrolls all source lines and copies only a retained call preview", async () => {
	const code = Array.from({ length: 100 }, (_, i) => `const cell_${i} = ${i};`).join("\n");
	const h = setup(code);
	h.calls.observe(start(1)); h.calls.observe(end(1));
	h.script.update({ executionStarted: true, isPartial: false, result: text("root") });
	const copied: string[] = [];
	const sheet = new Sheet({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, theme, h.view, () => {}, { copy: async (value) => { copied.push(value); } });
	try {
		const lines = () => bare(sheet.render(80));
		lines(); sheet.handleInput("g");
		assert.ok(lines().some((line) => /const cell_0 = 0;/.test(line)));
		sheet.handleInput("G");
		assert.ok(lines().some((line) => /const cell_99 = 99;/.test(line)));
		sheet.handleInput("3"); sheet.handleInput("o");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(copied, ["nested-1"]);
	} finally { sheet.dispose(); }
});

test("live nested calls do not retarget source or script-result selection", () => {
	const h = setup("return 'source';");
	assert.equal(h.source.stepCount(), 2);
	assert.equal(h.view.step, 0);
	for (let id = 1; id <= 3; id++) {
		h.calls.observe(start(id));
		h.script.update({ executionStarted: true, result: text("root progress") });
		assert.equal(h.view.step, 0);
		assert.deepEqual(bare(h.view.body(80)), ["return 'source';"]);
	}
	assert.ok(h.view.key("2"));
	for (let id = 4; id <= 6; id++) {
		h.calls.observe(start(id));
		h.script.update({ executionStarted: true, result: text("root progress") });
		assert.equal(h.view.step, 1);
		assert.equal(h.view.bodyLabel(), "script result");
		assert.equal(copied(h.source, 1, "o"), "root progress");
	}
});

test("missing and omitted nested results cannot be copied; retained truncation stays explicitly a preview", () => {
	const missing = setup();
	missing.calls.restore("script", { complete: true, calls: [{ id: "script/1", name: "read", status: "ok", durationMs: 15 }] });
	missing.script.update({ isPartial: false, result: text("root") });
	assert.equal(copied(missing.source, 2, "o"), undefined);
	assert.match(bare(missing.source.output(theme, 80, 2)).join("\n"), /not saved/);
	const h = setup();
	for (let id = 1; id <= 12; id++) { h.calls.observe(start(id)); h.calls.observe(end(id, "x".repeat(20_000))); }
	h.script.update({ executionStarted: true, isPartial: false, result: text("root") });
	assert.equal(copied(h.source, 2, "o"), undefined, "omission marker is not a nested result");
	assert.match(bare(h.source.output(theme, 80, 2)).join("\n"), /omitted/);
	assert.equal(h.source.copies!(13).find((copy) => copy.key === "o")!.label, "copy preview");
	assert.match(copied(h.source, 13, "o")!, /truncated/);
	assert.ok(copied(h.source, 13, "o")!.length < 9_000);
});

test("the popup sheet never invokes the clipboard for a missing nested result", async () => {
	const h = setup();
	h.calls.restore("script", { complete: true, calls: [{ id: "script/1", name: "read", status: "ok" }] });
	h.script.update({ isPartial: false, result: text("root") });
	const copied: string[] = [];
	const sheet = new Sheet({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, theme, h.view, () => {}, { copy: async (value) => { copied.push(value); } });
	try {
		sheet.render(80); sheet.handleInput("3"); sheet.handleInput("o");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(copied, []);
		assert.match(bare(sheet.render(80)).join("\n"), /Nothing to copy yet/);
	} finally { sheet.dispose(); }
});

test("script clipboard strips terminal escapes and unsafe controls without changing execution arguments or normal 128KB text", () => {
	const ordinary = ` \t// ${"x".repeat(128 * 1_024)}\r\nreturn '界😀é'; \r\n`;
	const code = `\x1b[200~${ordinary}\x1b[201~\x00\x01\x08\x0b\x0c\x1e\x7f\x85\x9b`;
	const h = setup(code);
	assert.equal(copied(h.source, 0, "c"), ordinary);
	assert.deepEqual(h.args, { code }, "clipboard sanitization never rewrites the script passed to execution");
});

test("script clipboard removes ESC-form CSI and terminated or incomplete terminal strings", () => {
	const sequences = ["\x1b[2J", "\x1b[31m", "\x1b]52;c;hidden\x07", "\x1b]hidden\x1b\\", "\x1bPprint\x1b\\", "\x1b_private\x1b\\", "\x1b^private\x1b\\", "\x1bXprivate\x1b\\"];
	for (const sequence of sequences) assert.equal(copied(setup(`界${sequence}😀`).source, 0, "c"), "界😀");
	assert.equal(copied(setup("界\x1b_unterminated").source, 0, "c"), "界");
});

test("bare C1 bytes and mojibake never delete ordinary source text or the remaining script", () => {
	for (const byte of [0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f]) {
		const control = String.fromCharCode(byte);
		const tail = "ordinary\r\n\treturn '界😀';";
		assert.equal(copied(setup(`â€${control}${tail}`).source, 0, "c"), `â€${tail}`);
		assert.equal(copied(setup(`界${control}private\x9c😀`).source, 0, "c"), "界private😀");
	}
	assert.equal(copied(setup("界\x9b31m😀").source, 0, "c"), "界31m😀");
});

test("script clipboard handles all supported source aliases and missing input", () => {
	for (const args of [{ code: "\x1b[31mreturn 1;" }, { script: "\x1b[31mreturn 1;" }, { source: "\x1b[31mreturn 1;" }, {}]) {
		const h = harness();
		const script = row(codemodeRenderers(h.kit, { name: "codemode" }), args);
		script.update({ executionStarted: true });
		script.click();
		assert.equal(copied(h.popups[0]!, 0, "c"), Object.keys(args).length ? "return 1;" : undefined);
	}
});

test("saved error-only previews can be copied; omitted output uses a shared sentinel", () => {
	const h = setup();
	h.calls.restore("script", { complete: true, calls: [{ id: "script/error", name: "read", status: "error", error: "saved error\nsecond line" }] });
	h.script.update({ isPartial: false, result: text("root") });
	assert.match(bare(h.source.output(theme, 80, 2)).join("\n"), /saved error/);
	assert.equal(copied(h.source, 2, "o"), "saved error\nsecond line");
	assert.equal(h.source.copies!(2).find((copy) => copy.key === "o")!.label, "copy preview");
	assert.equal((nested as unknown as { OMITTED_OUTPUT?: string }).OMITTED_OUTPUT, "[nested output omitted from live cache; see script result]");
});

test("empty script source has its own explicit empty-state and multiline call names cannot corrupt selector mapping", () => {
	const h = setup("");
	assert.deepEqual(bare(h.source.output(theme, 80, 0)), ["(no script source)"]);
	h.calls.restore("script", { complete: true, calls: [{ id: "script/1", name: "read\n界😀\r\nsecond", status: "error", error: "error" }] });
	h.script.update({ isPartial: false, result: text("root") });
	const head = h.source.head(theme, 80, 2);
	assert.equal(head.length, 3);
	assert.ok(head.every((line) => !/[\r\n]/.test(line)), "a selector always occupies exactly one physical line");
	assert.equal(h.source.outputLabel(2), "ƒ1 read 界😀 second");
});

test("a real sheet keeps selected call C, copy preview and scroll identity when observed call B arrives; pruning C returns to Source", async () => {
	const h = setup();
	h.calls.observe({ ...start(1), toolName: "A" });
	const error = Array.from({ length: 100 }, (_, i) => `C-error-line-${i}`).join("\n");
	const details = { calls: [{ id: "script/C", name: "C", status: "error", error }] };
	h.script.update({ executionStarted: true, result: text("root", details) });
	const copied: string[] = [];
	const sheet = new Sheet({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, theme, h.view, () => {}, { copy: async (value) => { copied.push(value); } });
	try {
		const lines = () => bare(sheet.render(80));
		lines(); sheet.handleInput("4"); lines(); sheet.handleInput("g");
		assert.equal(h.view.step, 3);
		const identity = h.view.bodyKey();
		assert.ok(lines().some((line) => /C-error-line-0\b/.test(line)));
		h.calls.observe({ ...start(2), toolName: "B" });
		h.script.update({ executionStarted: true, result: text("root", details) });
		assert.equal(h.view.step, 4, "C follows its id, not the reused numeric position");
		assert.match(h.view.bodyLabel(), /C$/);
		assert.equal(h.view.bodyKey(), identity, "reordering does not reset the body scroll");
		assert.ok(lines().some((line) => /C-error-line-0\b/.test(line)));
		sheet.handleInput("o"); await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(copied, [error]);
		h.script.update({ executionStarted: true, result: text("root", { calls: [] }) });
		assert.equal(h.view.step, 0, "a pruned call never retargets another call");
		assert.equal(h.view.bodyLabel(), "script source");
		assert.notEqual(h.view.bodyKey(), identity);
		assert.ok(lines().some((line) => /return 1;/.test(line)));
	} finally { sheet.dispose(); }
});

test("duplicate saved/details call ids stay distinct through insertion; removing the second returns to Source", () => {
	for (const storage of ["saved", "details"]) {
		const h = setup();
		const duplicateId = 'script/?:["odd",1]';
		const entries = [{ id: duplicateId, name: "first", status: "error" as const, error: "first-preview" }, { id: duplicateId, name: "second", status: "error" as const, error: "second-preview" }, { id: "script/?", name: "placeholder-first", status: "error" as const, error: "placeholder-1" }, { id: "script/?", name: "placeholder-second", status: "error" as const, error: "placeholder-2" }];
		const result = (calls: typeof entries) => storage === "saved" ? { ...text("root"), nestedCalls: { calls } } : text("root", { calls });
		h.script.update({ isPartial: false, result: result(entries) });
		const keys = h.source.stepKeys!();
		assert.equal(new Set(keys).size, keys.length);
		assert.equal(keys[2], `codemode:call:${JSON.stringify([duplicateId, 0])}`);
		assert.equal(keys[3], `codemode:call:${JSON.stringify([duplicateId, 1])}`);
		assert.ok(h.view.key("4"));
		assert.equal(h.view.step, 3);
		const identity = h.view.bodyKey();
		assert.match(bare(h.view.body(80)).join("\n"), /second-preview/);
		assert.equal(h.view.copies().find((copy) => copy.key === "o")!.text(), "second-preview");
		const inserted = { id: `${duplicateId}:1`, name: "inserted", status: "error" as const, error: "inserted-preview" };
		h.script.update({ isPartial: false, result: result([inserted, ...entries]) });
		assert.equal(h.view.step, 4);
		assert.equal(h.view.bodyKey(), identity);
		assert.equal(h.view.copies().find((copy) => copy.key === "o")!.text(), "second-preview");
		h.script.update({ isPartial: false, result: result([inserted, entries[0]!, ...entries.slice(2)]) });
		assert.equal(h.view.step, 0);
		assert.equal(h.view.bodyLabel(), "script source");
	}
});

test("missing known script arguments preserve the foreign argument fallback; empty args retain the empty state", () => {
	for (const args of [{ expression: "return '界😀';", timeoutMs: 30 }, {}]) {
		const h = harness();
		const script = row(codemodeRenderers(h.kit, { name: "codemode" }), args);
		script.update({ executionStarted: true }); script.click();
		const source = h.popups[0]!;
		const output = bare(source.output(theme, 80, 0)).join("\n");
		if (Object.keys(args).length) {
			assert.match(output, /expression\s+return '界😀';/);
			assert.match(output, /timeoutMs\s+30/);
		} else assert.equal(output, "(no script source)");
		assert.equal(copied(source, 0, "c"), undefined);
		assert.ok(source.output(theme, 1, 0).every((line) => visibleWidth(line) <= 1));
	}
});

test("observed/detail merging has linear id reads and retains the first duplicate detail", () => {
	const h = harness();
	const count = 128;
	let idReads = 0;
	const calls = Array.from({ length: count }, (_, id) => ({ get id() { idReads++; return `script/${id}`; }, name: "read", status: "ok" as const }));
	const details = calls.map((call, id) => ({ id: call.id, name: "read", status: id === 0 ? "cancelled" : "ok", error: id === 0 ? "first cancellation" : undefined }));
	const duplicate = { id: "script/0", name: "read", status: "error", error: "wrong second detail" };
	const script = row(codemodeRenderers({ ...h.kit, nestedCalls: () => ({ complete: true, calls }) }, { name: "codemode" }), { code: "return 1;" }, "script");
	script.update({ executionStarted: true, result: text("root", { calls: [...details, duplicate] }) }); script.click();
	const source = h.popups[0]!;
	idReads = 0;
	assert.equal(source.stepKeys!().length, count + 2);
	assert.ok(idReads <= count * 4, `one merge reads observed ids at most four times each, got ${idReads}`);
	assert.match(bare(source.output(theme, 80, 2)).join("\n"), /aborted/);
	assert.equal(copied(source, 2, "o"), "first cancellation");
});

test("codemode step identity snapshots once per getter and keeps the 256-call bound", () => {
	const h = harness();
	const calls = new NestedCalls(h.now);
	calls.restore("script", { complete: true, calls: Array.from({ length: 300 }, (_, id) => ({ id: `script/${id}`, name: "read", status: "ok", output: "preview" })) });
	let reads = 0;
	const script = row(codemodeRenderers({ ...h.kit, nestedCalls: (id) => { reads++; return calls.get(id); } }, { name: "codemode" }), { code: "return 1;" }, "script");
	script.update({ executionStarted: true });
	script.click();
	const source = h.popups[0]!;
	reads = 0;
	const keys = source.stepKeys!();
	assert.equal(reads, 1);
	assert.equal(keys.length, 258);
	assert.equal(new Set(keys).size, keys.length);
	const view = new PopupView(theme, source);
	reads = 0;
	assert.equal(view.bodyKey(), keys[0]);
	assert.equal(reads, 1);
});

test("popup result keeps foreign vocabulary and selectors stay one line at narrow Unicode widths", () => {
	const h = harness();
	const tool = { name: "codemode", renderResult: () => ({ render: () => ["foreign vocabulary"], invalidate() {} }) };
	const script = row(codemodeRenderers(h.kit, tool), { script: "return '界😀é';" });
	script.update({ isPartial: false, result: text("raw result") });
	script.click();
	const source = h.popups[0]!;
	assert.deepEqual(bare(source.output(theme, 80, 1)), ["foreign vocabulary"]);
	assert.equal(copied(source, 0, "c"), "return '界😀é';");
	assert.equal(copied(source, 1, "o"), "raw result");
	for (const width of [1, 2, 4, 8, 20, 40]) {
		assert.equal(source.head(theme, width, 0).length, 2);
		assert.ok(source.head(theme, width, 0).every((line) => visibleWidth(line) <= width));
		assert.ok(source.output(theme, width, 0).every((line) => visibleWidth(line) <= width), `source width ${width}`);
	}
});
