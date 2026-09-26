import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences } from "@earendil-works/pi-tui";
import { cutTail, installThinkingTail, paragraphStarts, tailOf, thinkingRuns, ThinkingView, viewFor, type ThinkingHost, type ThinkingMode } from "../lib/tool-display/thinking.ts";

initTheme("dark");

const thinking = (text: string) => ({ type: "thinking", thinking: text });
const said = (text: string) => ({ type: "text", text });
const message = (...content: object[]) => ({ role: "assistant", content, stopReason: "stop" }) as never;
const LONG = Array.from({ length: 8 }, (_, index) => `step ${index + 1}`).join("\n\n");

function host(over: Partial<ThinkingHost> & { mode?: () => ThinkingMode | undefined } = {}): ThinkingHost {
	return { mode: () => "tail", hiddenAtStart: () => true, theme: () => undefined, ...over };
}

const plain = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).trim()).filter((line) => line !== "");

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
	assert.deepEqual(tailOf(["a", "b", "c", "d", ""], 3), { lines: ["b", "c", "d"], skipped: 1 });
	assert.deepEqual(tailOf(["a"], 3), { lines: ["a"], skipped: 0 });
	assert.deepEqual(tailOf(["a", "b", "  ", "c", "d"], 3), { lines: ["c", "d"], skipped: 3 }, "never opens on a paragraph gap");
});

test("a tail that would open on a paragraph gap puts the ellipsis on the next paragraph", () => {
	const undo = installThinkingTail(host());
	try {
		const component = new AssistantMessageComponent(message(thinking("one\n\ntwo\n\nthree\n\nlast paragraph\nstill last")), true);
		assert.deepEqual(plain(component.render(60)), ["… last paragraph", "still last"]);
		const wrapped = new AssistantMessageComponent(message(thinking(`one\n\ntwo\n\n${"word ".repeat(15).trim()}`)), true);
		const lines = plain(wrapped.render(40));
		assert.ok(lines[0]!.startsWith("… word"), lines[0]);
	} finally {
		undo();
	}
});

test("a tail keeps its drawing between frames instead of redrawing Pi's rendering", () => {
	let renders = 0;
	let view: ThinkingMode = "tail";
	const full = { render: (width: number) => { renders++; return Array.from({ length: 6 }, (_, index) => `line ${index} at ${width}`); }, invalidate: () => {} };
	const block = new ThinkingView({ full, view: () => view, label: () => "Thinking...", pad: 0, host: host(), toggle: () => {} });
	const first = block.render(40);
	const drawn = renders;
	assert.equal(block.render(40), first);
	assert.equal(renders, drawn, "a repeat frame reuses the drawing");
	assert.notEqual(block.render(50), first, "a new width draws again");
	block.invalidate();
	block.render(50);
	assert.ok(renders > drawn + 2, "an invalidated block draws again");
	view = "collapsed";
	assert.deepEqual(block.render(50), ["Thinking..."]);
});

test("paragraph starts skip fences, lists and the first line", () => {
	const text = "intro\n\n```\ncode\n\nmore code\n```\n\n- item\n\n2. item\n\n> quote\n\n# Heading\n\nlast";
	assert.deepEqual(paragraphStarts(text).map((start) => text.slice(start).split("\n")[0]), ["# Heading", "last"]);
	const tildes = "a\n\n~~~~\n```\n\nstill code\n~~~~\n\nafter";
	assert.deepEqual(paragraphStarts(tildes).map((start) => tildes.slice(start)), ["after"]);
});

test("a tail wrapped from a late paragraph matches the whole block's newest lines", () => {
	const markdown = getMarkdownTheme();
	const style = { color: (text: string) => `\x1b[3m${text}\x1b[23m`, italic: true };
	const prose = (index: number) => `Paragraph ${index}: weighing **how** the \`change\` interacts with the renderer and which checks to run next, then *why*.`;
	const samples = [
		Array.from({ length: 60 }, (_, index) => prose(index)).join("\n\n"),
		Array.from({ length: 40 }, (_, index) => index % 5 === 0 ? `## Part ${index}\n\n\`\`\`ts\nconst a = ${index};\n\nconst b = a;\n\`\`\`` : index % 7 === 0 ? `- one ${index}\n- two\n\n1. first\n2. second` : prose(index)).join("\n\n"),
		`${Array.from({ length: 50 }, (_, index) => prose(index)).join("\n\n")}\n\n\`\`\`\nopen fence still streaming\n\nwith blank lines`,
	];
	for (const text of samples) {
		for (const width of [30, 58, 118]) {
			const whole = new Markdown(text, 1, 0, markdown, style);
			const cut = cutTail(new Markdown(text, 1, 0, markdown, style), width, 3);
			assert.ok(cut, "long safe text takes the short path");
			assert.deepEqual(cut, tailOf(whole.render(width), 3).lines);
		}
	}
	const short = new Markdown(prose(1), 1, 0, markdown, style);
	assert.equal(cutTail(short, 60, 3), undefined, "a short block is wrapped whole");
	const linked = new Markdown(`${samples[0]}\n\n[ref]: https://example.com`, 1, 0, markdown, style);
	assert.equal(cutTail(linked, 60, 3), undefined, "link definitions reach across paragraphs");
});

test("a long thinking block shows its newest three lines, the first opening with an ellipsis", () => {
	const undo = installThinkingTail(host());
	try {
		const component = new AssistantMessageComponent(message(thinking(LONG), said("done")), true);
		const raw = component.render(40);
		assert.deepEqual(plain(raw), ["… step 7", "step 8", "done"]);
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
		assert.deepEqual(plain(component.render(60)), ["a", "b", "answer"]);
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
		assert.equal(plain(component.render(60))[0], "… step 7");
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
		assert.equal(plain(component.render(60))[0], "… step 7");
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
		assert.equal(plain(component.render(60))[0], "… step 7", "an old undo leaves the new host in place");
	} finally {
		second();
	}
});
