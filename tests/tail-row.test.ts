import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { queueContainer, TailRow } from "../lib/tail-row.ts";
import { agentRoot } from "./support/pi-runtime.mjs";

interface Box { children: unknown[]; render(width: number): string[] }

/** A container that draws its own lines, like Pi's. */
function box(lines: string[] = []): Box {
	return { children: [], render: () => [...lines] };
}

const editor = () => ({ render: () => ["─"], invalidate() {} });

/** Pi's interactive layout: transcript, queued messages, status, widgets, editor, widgets, footer. */
function layout(mounted: object, queued: string[] = []) {
	const queue = box(queued);
	const editorBox = box();
	editorBox.children.push(mounted);
	return { tui: { children: [box(), queue, box(), box(), editorBox, box(), box()] }, queue };
}

const QUEUED = ["", " Steering: check the logs", " ↳ Alt+Up to edit all queued messages"];

test("draws its lines right above the messages queued for the agent", () => {
	const ed = editor();
	const { tui, queue } = layout(ed, QUEUED);
	const row = new TailRow();
	assert.equal(row.attach(tui, ed, () => ["", " ⠦ Running bash"]), true);
	assert.deepEqual(queue.render(80), ["", " ⠦ Running bash", ...QUEUED]);
	row.detach();
});

test("passes the queue's own lines through while there is nothing to draw", () => {
	const ed = editor();
	const { tui, queue } = layout(ed, QUEUED);
	const row = new TailRow();
	row.attach(tui, ed, () => []);
	assert.deepEqual(queue.render(80), QUEUED);
	row.detach();
});

test("finds the editor inside other extensions' wrappers", () => {
	const ed = editor();
	const { tui, queue } = layout({ base: { base: ed } });
	const row = new TailRow();
	assert.equal(row.attach(tui, ed, () => ["x"]), true);
	assert.deepEqual(queue.render(80), ["x"]);
	row.detach();
});

test("leaves any other layout alone", () => {
	const ed = editor();
	const { tui } = layout(ed);
	const cases: unknown[] = [
		undefined,
		{},
		{ children: tui.children.slice(0, 6) },
		{ children: [...tui.children, box()] },
		{ children: [tui.children[4], ...tui.children.slice(1, 4), tui.children[0], ...tui.children.slice(5)] },
		{ children: [tui.children[0], { render: () => [] }, ...tui.children.slice(2)] },
		layout(editor()).tui,
	];
	for (const candidate of cases) {
		assert.equal(queueContainer(candidate, ed), undefined);
		assert.equal(new TailRow().attach(candidate, ed, () => ["x"]), false);
	}
	assert.equal(tui.children[1]!.render(80).length, 0, "the real queue was never hooked");
});

test("detaching hands the queue back, and a later attach draws its lines once", () => {
	const ed = editor();
	const { tui, queue } = layout(ed, QUEUED);
	const first = new TailRow();
	first.attach(tui, ed, () => ["first"]);
	first.detach();
	assert.deepEqual(queue.render(80), QUEUED);
	const second = new TailRow();
	second.attach(tui, ed, () => ["second"]);
	assert.deepEqual(queue.render(80), ["second", ...QUEUED]);
	second.detach();
});

test("an older owner detaching late leaves the newer owner's lines", () => {
	const ed = editor();
	const { tui, queue } = layout(ed);
	const old = new TailRow();
	old.attach(tui, ed, () => ["old"]);
	const current = new TailRow();
	current.attach(tui, ed, () => ["new"]);
	old.detach();
	assert.deepEqual(queue.render(80), ["new"]);
	current.detach();
	assert.deepEqual(queue.render(80), []);
});

test("a draw that throws leaves the queue as Pi drew it", () => {
	const ed = editor();
	const { tui, queue } = layout(ed, QUEUED);
	const row = new TailRow();
	row.attach(tui, ed, () => { throw new Error("boom"); });
	assert.deepEqual(queue.render(80), QUEUED);
	row.detach();
});

/** Pi's own source, whitespace collapsed. */
function piSource(file: string): string {
	return readFileSync(join(agentRoot, "dist/modes/interactive", file), "utf8").replace(/\s+/g, " ");
}

test("Pi still mounts its queued messages right after the transcript, with the editor fifth", () => {
	// When this fails, the phase line quietly falls back to the editor border: check lib/tail-row.ts.
	const mode = piSource("interactive-mode.js");
	const order = ["document", "pendingMessages", "status", "widgetContainerAbove", "editor", "widgetContainerBelow", "footer"]
		.map((name) => `this.${name.startsWith("widget") ? name : `${name}Container`}`).join(", ");
	assert.ok(mode.includes(`this.mountInteractiveTui(this.renderer, [ ${order}, ]);`), "layout order changed");
	assert.ok(mode.includes("const newEditor = factory(this.ui, "), "editors no longer get the live TUI");
	assert.ok(mode.includes("this.ui = createInteractiveTuiReference(() => this.renderer);"), "the TUI reference changed");
	assert.match(piSource("chat-viewport.js"), /const dock = new VStack\(\[ \{ component: options\.pendingMessages,/);
});
