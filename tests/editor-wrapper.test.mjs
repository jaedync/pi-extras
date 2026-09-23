import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { agentRoot } from "./support/pi-runtime.mjs";
const { createJiti } = createRequire(join(agentRoot, "package.json"))("jiti");
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": fileURLToPath(new URL("./fixtures/phase-editor-api.mjs", import.meta.url)),
		"@earendil-works/pi-tui": createRequire(join(agentRoot, "package.json")).resolve("@earendil-works/pi-tui"),
	},
});
const { EditorSlot } = await jiti.import("../lib/editor-wrapper.ts");

const tui = { requestRender() {} };
const theme = { borderColor: (text) => text };

function baseEditor() {
	const calls = [];
	let text = "";
	return {
		calls,
		render: (width) => ["─".repeat(width), "input"],
		getText: () => text,
		setText: (next) => { text = next; calls.push(["setText", next]); },
		handleInput: (data) => calls.push(["input", data]),
		invalidate: () => calls.push(["invalidate"]),
		setWorkingStatusIndicator: (indicator) => calls.push(["status", indicator]),
	};
}

function host(initial) {
	let factory = initial;
	return { ui: { getEditorComponent: () => factory, setEditorComponent: (next) => { factory = next; } }, get factory() { return factory; } };
}

test("the wrapper draws over the base editor's lines and forwards everything else", () => {
	const base = baseEditor();
	const ctx = host(() => base);
	const statuses = [];
	new EditorSlot().install(ctx, () => ({
		render: (lines, width) => [`top ${width}`, ...lines.slice(1)],
		onWorkingStatus: (indicator) => statuses.push(indicator),
	}));
	const editor = ctx.factory(tui, theme, {});
	assert.deepEqual(editor.render(12), ["top 12", "input"]);
	editor.onSubmit = () => {};
	editor.handleInput("x");
	assert.equal(base.onSubmit, editor.onSubmit, "callbacks reach the base before it sees input");
	editor.setText("hello");
	assert.equal(editor.getText(), "hello");
	editor.setWorkingStatusIndicator({ kind: "retry" });
	assert.deepEqual(statuses, [{ kind: "retry" }]);
	assert.deepEqual(base.calls.filter(([name]) => name !== "invalidate"), [["input", "x"], ["setText", "hello"], ["status", { kind: "retry" }]]);
});

test("an empty render is passed through undecorated", () => {
	const base = { ...baseEditor(), render: () => [] };
	const ctx = host(() => base);
	new EditorSlot().install(ctx, () => ({ render: () => assert.fail("nothing to draw on") }));
	assert.deepEqual(ctx.factory(tui, theme, {}).render(10), []);
});

test("reinstalling for a new session wraps the original editor, not the old wrapper", () => {
	const base = baseEditor();
	const ctx = host(() => base);
	const slot = new EditorSlot();
	const decorate = () => ({ render: (lines) => [`${lines[0]}+`, ...lines.slice(1)] });
	slot.install(ctx, decorate);
	slot.install(ctx, decorate);
	assert.deepEqual(ctx.factory(tui, theme, {}).render(3), ["───+", "input"]);
});

test("wrappers chain, each drawing its own row, and restore only undoes its own", () => {
	const base = baseEditor();
	const original = () => base;
	const ctx = host(original);
	const inner = new EditorSlot();
	const outer = new EditorSlot();
	inner.install(ctx, () => ({ render: (lines) => ["inner", ...lines.slice(1)] }));
	const innerFactory = ctx.factory;
	outer.install(ctx, () => ({ render: (lines) => [lines[0], "outer"] }));
	assert.deepEqual(ctx.factory(tui, theme, {}).render(5), ["inner", "outer"]);
	inner.restore(ctx);
	assert.notEqual(ctx.factory, original, "the outer wrapper is still installed, so inner leaves it alone");
	outer.restore(ctx);
	assert.equal(ctx.factory, innerFactory);
});

test("with no editor installed the wrapper builds on Pi's default editor", () => {
	const ctx = host(undefined);
	new EditorSlot().install(ctx, () => ({ render: (lines) => lines }));
	const editor = ctx.factory(tui, theme, {});
	editor.setText("typed");
	assert.equal(editor.getText(), "typed");
});

test("restore without an install leaves the editor alone", () => {
	let sets = 0;
	const ctx = { ui: { getEditorComponent: () => undefined, setEditorComponent: () => { sets += 1; } } };
	new EditorSlot().restore(ctx);
	assert.equal(sets, 0);
});
