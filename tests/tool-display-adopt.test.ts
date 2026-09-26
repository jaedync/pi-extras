import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { canAdopt, installAdoption, type AdoptHost, type RowRenderers } from "../lib/tool-display/adopt.ts";
import { foreignRenderers } from "../lib/tool-display/foreign.ts";
import { harness } from "./support/tool-rows.ts";

initTheme("dark");

type Definition = { name: string; renderShell?: string; renderCall?: () => unknown; renderResult?: () => unknown };

/** Pi's tool row, reduced to the lookups the patch replaces. */
function fakeRowClass() {
	return class FakeRow {
		readonly toolDefinition?: Definition;
		constructor(definition?: Definition) { this.toolDefinition = definition; }
		getRenderShell() { return this.toolDefinition?.renderShell ?? "default"; }
		getCallRenderer() { return this.toolDefinition?.renderCall; }
		getResultRenderer() { return this.toolDefinition?.renderResult; }
	};
}

const ours: RowRenderers = { renderCall: () => "our call", renderResult: () => "our result" };
const theirs = (name: string): Definition => ({ name, renderCall: () => `${name} call`, renderResult: () => `${name} result` });
const drawsOnly = (...names: string[]): AdoptHost => ({ renderersFor: (definition) => (names.includes((definition as Definition).name) ? ours : undefined) });

test("rows of tools the host draws get its renderers and draw themselves; other rows stay as they were", () => {
	const Row = fakeRowClass();
	const undo = installAdoption(drawsOnly("fetch_content"), Row.prototype);
	try {
		const adopted = new Row(theirs("fetch_content"));
		assert.equal(adopted.getRenderShell(), "self");
		assert.equal(adopted.getCallRenderer(), ours.renderCall);
		assert.equal(adopted.getResultRenderer(), ours.renderResult);
		const left = new Row(theirs("bash"));
		assert.equal(left.getRenderShell(), "default");
		assert.equal((left.getCallRenderer() as () => string)(), "bash call");
		assert.equal(new Row(undefined).getCallRenderer(), undefined, "a row without a definition is Pi's fallback");
	} finally {
		undo();
	}
});

test("a row keeps the choice made when it was built, since Pi picks its container then", () => {
	const Row = fakeRowClass();
	let draw = true;
	const undo = installAdoption({ renderersFor: () => (draw ? ours : undefined) }, Row.prototype);
	try {
		const early = new Row(theirs("mcp"));
		assert.equal(early.getRenderShell(), "self");
		draw = false;
		assert.equal(early.getCallRenderer(), ours.renderCall);
		assert.equal(new Row(theirs("mcp")).getRenderShell(), "default", "a new row follows the new choice");
	} finally {
		undo();
	}
});

test("a host that throws leaves the row to Pi", () => {
	const Row = fakeRowClass();
	const undo = installAdoption({ renderersFor: () => { throw new Error("broken"); } }, Row.prototype);
	try {
		assert.equal(new Row(theirs("mcp")).getRenderShell(), "default");
	} finally {
		undo();
	}
});

test("installing again, as a reload does, takes over the one patch; undone, the patch passes straight through", () => {
	const Row = fakeRowClass();
	const first = installAdoption(drawsOnly("a"), Row.prototype);
	const patched = Row.prototype.getRenderShell;
	const second = installAdoption(drawsOnly("b"), Row.prototype);
	assert.equal(Row.prototype.getRenderShell, patched, "not wrapped twice");
	assert.equal(new Row(theirs("a")).getRenderShell(), "default", "the first host is no longer asked");
	assert.equal(new Row(theirs("b")).getRenderShell(), "self");
	first();
	assert.equal(new Row(theirs("b")).getRenderShell(), "self", "an old undo leaves the new host in place");
	second();
	assert.equal(new Row(theirs("b")).getRenderShell(), "default");
	const third = installAdoption(drawsOnly("b"), Row.prototype);
	assert.equal(new Row(theirs("b")).getRenderShell(), "self");
	third();
});

test("a row class without the lookups is left alone", () => {
	class Other { render() { return []; } }
	assert.equal(canAdopt(Other.prototype), false);
	const undo = installAdoption(drawsOnly("a"), Other.prototype);
	assert.deepEqual(Object.getOwnPropertySymbols(Other.prototype), []);
	undo();
});

test("Pi's tool row still has the lookups Tool Display patches, and draws an adopted row with the band", () => {
	assert.equal(canAdopt(), true, "if this fails, Pi changed ToolExecutionComponent: other tools' rows fall back to their own renderers");
	const h = harness();
	const tool = { name: "x_tool", renderCall: () => new Text("x_tool their call", 0, 0), renderResult: () => new Text("their result", 0, 0) };
	const undo = installAdoption({ renderersFor: (definition) => (definition === tool ? (foreignRenderers(h.kit, tool as never) as never) : undefined) });
	try {
		const ui = { requestRender() {} };
		const adopted = new ToolExecutionComponent("x_tool", "call-1", { note: "hi" }, {}, tool as never, ui as never, "/work");
		adopted.updateResult({ content: [{ type: "text", text: "done" }], isError: false } as never, false);
		const lines = adopted.render(60).map((line) => stripTerminalSequences(line).trimEnd()).filter((line) => line !== "");
		assert.deepEqual(lines, [" x_tool their call", "   their result"]);
		const other = { ...tool };
		const left = new ToolExecutionComponent("x_tool", "call-2", {}, {}, other as never, ui as never, "/work");
		assert.equal((left as unknown as { getCallRenderer(): unknown }).getCallRenderer(), other.renderCall);
	} finally {
		undo();
	}
});
