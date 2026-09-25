import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { installThinkingTail, tailOf, thinkingRuns, viewFor, type ThinkingHost, type ThinkingMode } from "../lib/tool-display/thinking.ts";

initTheme("dark");

const thinking = (text: string) => ({ type: "thinking", thinking: text });
const said = (text: string) => ({ type: "text", text });
const message = (...content: object[]) => ({ role: "assistant", content, stopReason: "stop" }) as never;
const LONG = Array.from({ length: 8 }, (_, index) => `step ${index + 1}`).join("\n\n");

function host(over: Partial<ThinkingHost> & { mode?: () => ThinkingMode | undefined } = {}): ThinkingHost {
	return { mode: () => "tail", hiddenAtStart: () => true, theme: () => undefined, hint: () => "click for all", ...over };
}

const plain = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).trim()).filter((line) => line !== "");

function click(component: AssistantMessageComponent, row: number) {
	return component.handleMouse({ type: "click", button: "left", x: 2, y: row, screenX: 2, screenY: row, width: 60, height: 20 } as never);
}

test("thinking runs group consecutive blocks and know whether anything follows them", () => {
	const runs = thinkingRuns([thinking("a"), thinking(" "), thinking("b"), said("x"), thinking("c")] as never);
	assert.deepEqual(runs, [{ text: "a\n\nb", trailing: false }, { text: "c", trailing: true }]);
	assert.deepEqual(thinkingRuns([thinking("  "), said("x")] as never), []);
});

test("a block rests in the chosen style and flips to the other once toggled", () => {
	assert.equal(viewFor("tail", false, false), "tail");
	assert.equal(viewFor("tail", true, false), "full");
	assert.equal(viewFor("tail", true, true), "tail");
	assert.equal(viewFor("collapsed", false, true), "full");
	assert.equal(viewFor("full", true, false), "tail");
	assert.deepEqual(tailOf(["a", "b", "c", "d", ""], 3), { lines: ["b", "c", "d"], skipped: 1 });
	assert.deepEqual(tailOf(["a"], 3), { lines: ["a"], skipped: 0 });
});

test("a thinking block shows a label, how many lines are hidden, and its newest three", () => {
	const undo = installThinkingTail(host());
	try {
		const component = new AssistantMessageComponent(message(thinking(LONG), said("done")), true);
		const lines = plain(component.render(60));
		assert.deepEqual(lines, ["Thought", "… 12 earlier lines (click for all)", "step 7", "step 8", "done"]);
	} finally {
		undo();
	}
});

test("while it streams the label says it is thinking, and a short block shows whole", () => {
	const undo = installThinkingTail(host());
	try {
		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(message(thinking("one line")), true);
		assert.deepEqual(plain(component.render(60)), ["Thinking...", "one line"]);
		component.updateContent(message(thinking("one line"), said("answer")), true);
		assert.equal(plain(component.render(60))[0], "Thought", "text after it means the block is done");
	} finally {
		undo();
	}
});

test("a click shows a block in full and another brings back the tail, across rebuilds", () => {
	const undo = installThinkingTail(host());
	try {
		const component = new AssistantMessageComponent(message(thinking(LONG), said("done")), true);
		component.render(60);
		assert.ok(click(component, 2));
		const full = plain(component.render(60));
		assert.ok(full.includes("step 1") && full.includes("step 8") && !full.includes("Thought"));
		component.updateContent(message(thinking(LONG), said("done")));
		assert.ok(plain(component.render(60)).includes("step 1"), "a rebuild while streaming keeps the choice");
		assert.ok(click(component, 2));
		assert.equal(plain(component.render(60))[0], "Thought");
	} finally {
		undo();
	}
});

test("Pi's thinking toggle switches every block between the resting style and full", () => {
	const undo = installThinkingTail(host());
	try {
		const component = new AssistantMessageComponent(message(thinking(LONG)), true);
		component.setHideThinkingBlock(false);
		assert.ok(plain(component.render(60)).includes("step 1"));
		component.setHideThinkingBlock(true);
		assert.equal(plain(component.render(60))[0], "Thought");
	} finally {
		undo();
	}
});

test("the collapsed style is the label alone, and an unset mode or undo leaves Pi's own rendering", () => {
	let mode: ThinkingMode | undefined = "collapsed";
	const undo = installThinkingTail(host({ mode: () => mode }));
	const component = new AssistantMessageComponent(message(thinking(LONG), said("done")), true);
	assert.deepEqual(plain(component.render(60)), ["Thought", "done"]);
	mode = undefined;
	component.updateContent(message(thinking(LONG), said("done")));
	assert.deepEqual(plain(component.render(60)), ["Thinking...", "done"]);
	mode = "tail";
	undo();
	component.updateContent(message(thinking(LONG), said("done")));
	assert.deepEqual(plain(component.render(60)), ["Thinking...", "done"]);
});

test("installing again replaces the host rather than stacking patches", () => {
	const first = installThinkingTail(host({ mode: () => "collapsed" }));
	const patched = AssistantMessageComponent.prototype.updateContent;
	const second = installThinkingTail(host({ mode: () => "tail" }));
	try {
		assert.equal(AssistantMessageComponent.prototype.updateContent, patched);
		first();
		const component = new AssistantMessageComponent(message(thinking(LONG), said("done")), true);
		assert.equal(plain(component.render(60))[1], "… 12 earlier lines (click for all)", "an old undo leaves the new host in place");
	} finally {
		second();
	}
});
