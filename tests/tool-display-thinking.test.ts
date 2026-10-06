import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { flatThinking, installThinkingTail, JOIN, tailLines, thinkingRuns, ThinkingView, viewFor, type ThinkingHost, type ThinkingMode } from "../lib/tool-display/thinking.ts";

initTheme("dark");

const thinking = (text: string) => ({ type: "thinking", thinking: text });
const said = (text: string) => ({ type: "text", text });
const message = (...content: object[]) => ({ role: "assistant", content, stopReason: "stop" }) as never;
const LONG = Array.from({ length: 8 }, (_, index) => `step ${index + 1}`).join("\n\n");

function host(over: Partial<ThinkingHost> & { mode?: () => ThinkingMode | undefined } = {}): ThinkingHost {
	return { mode: () => "tail", hiddenAtStart: () => true, theme: () => undefined, ...over };
}

/** Plain text, with the no-break space the tail glues `·` on with read as a space. */
const spaced = (text: string) => text.replace(/\u00a0/g, " ");
const plain = (lines: readonly string[]) => lines.map((line) => spaced(stripTerminalSequences(line)).trim()).filter((line) => line !== "");

function click(component: AssistantMessageComponent, row: number) {
	return component.handleMouse({ type: "click", button: "left", x: 2, y: row, screenX: 2, screenY: row, width: 60, height: 20 } as never);
}

test("thinking runs group consecutive blocks as Pi draws them", () => {
	const runs = thinkingRuns([thinking("a"), thinking(" "), thinking("b"), said("x"), thinking("c")] as never);
	assert.deepEqual(runs, ["a\n\nb", "c"]);
	assert.deepEqual(thinkingRuns([thinking("  "), said("x")] as never), []);
});

test("a block rests in the chosen style and flips to the other once toggled", () => {
	assert.equal(viewFor("tail", false, false), "tail");
	assert.equal(viewFor("tail", true, false), "full");
	assert.equal(viewFor("tail", true, true), "tail");
	assert.equal(viewFor("collapsed", false, true), "full");
	assert.equal(viewFor("full", true, false), "tail");
});

test("a tail runs the block's lines together, dropping line markup, so it fills with text", () => {
	const flat = (text: string) => spaced(flatThinking(text));
	assert.equal(flat("one\n\ntwo\nthree"), "one · two three", "a line that continues its paragraph joins with a space");
	assert.equal(flat("Done.\n\nNext:\n- check\n\nit, then"), "Done. Next: check · it, then", "a sentence end or a colon joins with a space");
	assert.equal(
		flat("## Plan\nread **the** file\n2. edit `x`\n   and more\n> quoted [docs](https://x.dev)\n\n```ts\nconst a = 1\nconst b = 2\n```\n~~old~~   new"),
		"Plan · read the file · edit x and more · quoted docs · const a = 1 · const b = 2 · old new",
	);
	assert.equal(flat("\n  \n"), "");
	assert.equal(flatThinking("a\n\nb"), `a${JOIN}b`);
	assert.deepEqual(tailLines("a\n\nb", 20), { lines: [`a${JOIN}b`], cut: false });
	const long = tailLines(Array.from({ length: 30 }, (_, index) => `thought ${index}`).join("\n\n"), 30);
	assert.equal(long.cut, true);
	assert.equal(long.lines.length, 3);
	assert.ok(long.lines.at(-1)!.endsWith("thought 29"), long.lines.at(-1));
	assert.ok(long.lines.every((line) => line.length <= 28), "cut lines leave room for the ellipsis");
	const huge = tailLines("word ".repeat(200_000), 50);
	assert.equal(huge.lines.length, 3, "a huge block wraps only its end");
});

test("a tail of a block with many short lines shows several of them at once", () => {
	const undo = installThinkingTail(host());
	try {
		const component = new AssistantMessageComponent(message(thinking("one\n\ntwo\n\nthree\n\nlast paragraph\nstill last")), true);
		assert.deepEqual(plain(component.render(60)), ["one · two · three · last paragraph still last"]);
		const wrapped = new AssistantMessageComponent(message(thinking(`one\n\ntwo\n\n${"word ".repeat(30).trim()}`)), true);
		const lines = plain(wrapped.render(40));
		assert.equal(lines.length, 3);
		assert.ok(lines[0]!.startsWith("… "), lines[0]);
	} finally {
		undo();
	}
});

test("a tail never draws Pi's rendering of the block, and keeps its drawing while the reply streams", () => {
	// Pi's bundle has its own copy of pi-tui's Markdown; count the renders of the one it uses.
	const PiMarkdown = (new AssistantMessageComponent(message(said("x")), false) as unknown as { contentContainer: { children: object[] } })
		.contentContainer.children.find((child) => child.constructor.name === "Markdown")!.constructor as { prototype: { render(width: number): string[] } };
	const undo = installThinkingTail(host());
	const render = PiMarkdown.prototype.render;
	let wraps = 0;
	PiMarkdown.prototype.render = function (this: { text: string }, width: number) {
		if (this.text.includes("step 8")) wraps++;
		return render.call(this, width);
	};
	try {
		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(message(thinking(LONG), said("a")), true);
		const first = plain(component.render(60));
		for (const reply of ["ab", "abc", "abcd"]) {
			component.updateContent(message(thinking(LONG), said(reply)), true);
			assert.deepEqual(plain(component.render(60)).slice(0, 2), first.slice(0, 2));
		}
		assert.equal(wraps, 0);
	} finally {
		PiMarkdown.prototype.render = render;
		undo();
	}
});

test("a view keeps its drawing between frames and draws again on a new width or invalidate", () => {
	let renders = 0;
	let view: ThinkingMode = "full";
	const full = { render: (width: number) => { renders++; return Array.from({ length: 6 }, (_, index) => `line ${index} at ${width}`); }, invalidate: () => {} };
	const block = new ThinkingView({ full, text: "a\n\nb", view: () => view, label: () => "Thinking...", pad: 0, host: host(), toggle: () => {} });
	const first = block.render(40);
	assert.equal(block.render(40), first);
	assert.equal(renders, 1, "a repeat frame reuses the drawing");
	assert.notEqual(block.render(50), first, "a new width draws again");
	block.invalidate();
	block.render(50);
	assert.equal(renders, 3, "an invalidated block draws again");
	view = "tail";
	assert.deepEqual(block.render(50).map(spaced), ["a · b"]);
	view = "collapsed";
	assert.deepEqual(block.render(50), ["Thinking..."]);
});

test("a long thinking block shows its newest three lines, the first opening with an ellipsis", () => {
	const undo = installThinkingTail(host());
	try {
		const long = Array.from({ length: 20 }, (_, index) => `step ${index + 1}`).join("\n\n");
		const component = new AssistantMessageComponent(message(thinking(long), said("done")), true);
		const shown = plain(component.render(40));
		assert.equal(shown.length, 4);
		assert.ok(shown[0]!.startsWith("… "), shown[0]);
		assert.ok(shown[2]!.endsWith("step 20"), shown[2]);
		assert.equal(shown[3], "done");
		const wrapped = new AssistantMessageComponent(message(thinking("word ".repeat(60).trim())), true);
		const lines = wrapped.render(30).map((line) => stripTerminalSequences(line)).filter((line) => line.trim() !== "");
		assert.equal(lines.length, 3);
		assert.ok(lines[0]!.startsWith(" … word"));
		assert.ok(lines.every((line) => line.trimEnd().length <= 30), "the cut tail still fits the width");
	} finally {
		undo();
	}
});

test("a block of three lines or fewer shows whole, with no label, while streaming or done", () => {
	const undo = installThinkingTail(host());
	try {
		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(message(thinking("one line")), true);
		assert.deepEqual(plain(component.render(60)), ["one line"]);
		component.updateContent(message(thinking("a\n\nb"), said("answer")), false);
		assert.deepEqual(plain(component.render(60)), ["a · b", "answer"]);
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
		assert.ok(full.includes("step 1") && full.includes("step 8"));
		component.updateContent(message(thinking(LONG), said("done")));
		assert.ok(plain(component.render(60)).includes("step 1"), "a rebuild while streaming keeps the choice");
		assert.ok(click(component, 2));
		assert.deepEqual(plain(component.render(60)).slice(0, 2), ["step 1 · step 2 · step 3 · step 4 · step 5 · step 6 · step", "7 · step 8"]);
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
		assert.deepEqual(plain(component.render(60)).slice(0, 2), ["step 1 · step 2 · step 3 · step 4 · step 5 · step 6 · step", "7 · step 8"]);
	} finally {
		undo();
	}
});

test("the collapsed style is the label alone, and an unset mode or undo leaves Pi's own rendering", () => {
	let mode: ThinkingMode | undefined = "collapsed";
	const undo = installThinkingTail(host({ mode: () => mode }));
	const component = new AssistantMessageComponent(message(thinking(LONG), said("done")), true);
	assert.deepEqual(plain(component.render(60)), ["Thinking...", "done"]);
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
		assert.equal(plain(component.render(60)).length, 3, "an old undo leaves the new host in place: a two-line tail and the reply");
	} finally {
		second();
	}
});

test("in folded mode a reply leaves out its thinking and the spacing around it", () => {
	let folds = true;
	const undo = installThinkingTail(host({ gutter: () => true, summary: () => "∴ Thought", folds: () => folds }));
	try {
		const reply = new AssistantMessageComponent(message(thinking(LONG), said("done")), true);
		assert.deepEqual(reply.render(60).map((line) => stripTerminalSequences(line).trimEnd()), ["", "● done"], "one blank line, then the reply");
		const quiet = new AssistantMessageComponent(message(thinking(LONG)), true);
		assert.deepEqual(quiet.render(60), [], "a reply of thinking alone draws nothing");
		folds = false;
		quiet.invalidate();
		assert.deepEqual(plain(quiet.render(60)), ["∴ Thought"], "an open group shows it again");
	} finally {
		undo();
	}
});
