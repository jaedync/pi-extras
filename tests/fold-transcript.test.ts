import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Spacer, stripTerminalSequences, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { commandsIn, cut, factsOfCall, findTranscript, FoldRow, FoldView, installFold, speaks, tokensOf, type Box, type FoldHost, type ReplyMessage } from "../lib/fold/transcript.ts";

/** A stand-in row: fixed lines, counting renders. */
class Row implements Component {
	renders = 0;
	invalidations = 0;
	/** The width of each render. */
	readonly widths: number[] = [];
	private readonly lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(width: number): string[] {
		this.renders++;
		this.widths.push(width);
		return this.lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
	}
	invalidate(): void {
		this.invalidations++;
	}
}

class ToolRow extends Row {
	expanded = false;
	result?: { isError?: boolean };
	readonly toolName: string;
	readonly toolCallId: string;
	isPartial: boolean;
	constructor(toolName: string, toolCallId: string, isPartial = false, failed = false) {
		super(["", `● ${toolName}`]);
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.isPartial = isPartial;
		if (!isPartial) this.result = { isError: failed };
	}
}

/** Pi's reply asks the thinking patch, through the view, each time it is built. */
let building: FoldView | undefined;

class Reply extends Row {
	readonly contentContainer = {};
	folded?: boolean;
	override invalidate(): void {
		super.invalidate();
		this.folded = building?.foldsThinking(this);
	}
	lastMessage: ReplyMessage;
	isStreaming: boolean;
	constructor(lastMessage: ReplyMessage, isStreaming = false, lines?: string[]) {
		super(lines ?? (speaks(lastMessage) ? ["", "● said"] : []));
		this.lastMessage = lastMessage;
		this.isStreaming = isStreaming;
	}
}

const quiet = (over: Partial<ReplyMessage> = {}): ReplyMessage => ({ content: [{ type: "thinking", thinking: "hm" }, { type: "toolCall" }], usage: { output: 100 }, timestamp: 1_000, ...over });
const said = (over: Partial<ReplyMessage> = {}): ReplyMessage => ({ content: [{ type: "text", text: "ok" }], usage: { output: 50 }, timestamp: 9_000, ...over });

function host(over: Partial<FoldHost> = {}) {
	const calls = { animate: [] as boolean[], redraws: 0 };
	const value: FoldHost = {
		enabled: () => true,
		theme: () => undefined,
		busy: () => false,
		now: () => 10_000,
		reduced: () => true,
		toolEndedAt: (id) => ({ a: 3_000, b: 5_500 } as Record<string, number>)[id],
		thoughtMs: () => undefined,
		nestedOf: () => undefined,
		animate: (live) => { calls.animate.push(live); },
		redraw: () => { calls.redraws++; },
		...over,
	};
	return { value, calls };
}

const text = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).replace(/ {2,}/g, "  ").trimEnd());

function chatOf(children: Component[]): Box {
	const chat = new Container();
	chat.children = children;
	return chat as unknown as Box;
}

function viewOf(value: FoldHost): FoldView {
	building = new FoldView(value);
	return building;
}

test("a run of work between replies draws as one line, with every row still rendered", () => {
	const user = new Row(["", " prompt"]);
	const first = new Reply(said({ content: [{ type: "text", text: "looking" }, { type: "toolCall" }], timestamp: 1_000 }));
	const read = new ToolRow("read", "a");
	const thinking = new Reply(quiet({ timestamp: 4_000 }));
	const bash = new ToolRow("bash", "b");
	const answer = new Reply(said());
	const chat = chatOf([new Spacer(1), user, first, read, thinking, bash, answer]);
	const { value } = host();
	const lines = viewOf(value).render(chat, 100);
	assert.deepEqual(text(lines), ["", "", " prompt", "", "● said", "  ● Read 1 file, ran 1 command, ↓150 4.5s", "", "● said"], "the line hangs under the reply that made the calls");
	assert.ok([read, bash].every((row) => row.renders === 1), "folded rows keep their own render running");
	assert.deepEqual([read.widths, bash.widths], [[96], [96]], "at the width they have when the run opens");
	assert.deepEqual([thinking.invalidations, thinking.renders], [1, 1], "a reply Pi built before it was in the transcript is built again, without its thinking, before it draws");
	assert.equal(thinking.folded, true);
	const layout = chat.mouseLayout!;
	assert.equal(layout.children.reduce((sum, child) => sum + child.height, 0), lines.length, "the mouse layout matches the lines");
	assert.ok(layout.children[3]!.component instanceof FoldRow);
	assert.ok(lines.every((line) => visibleWidth(line) <= 100));
});

test("the last group is live while the agent runs, and asks for frames", () => {
	const { value, calls } = host({ busy: () => true });
	const streaming = new Reply(quiet({ content: [{ type: "thinking", thinking: "x".repeat(400) }], usage: { output: 1 }, timestamp: 9_000 }), true);
	const chat = chatOf([new Reply(said({ timestamp: 1 })), new ToolRow("edit", "c", true), streaming]);
	const lines = text(viewOf(value).render(chat, 100));
	// The reply that made the call counts too; reduced motion holds the spinner's first frame.
	assert.equal(lines.at(-1), "  ⠋ Editing 1 file, ↓150 9.9s");
	assert.deepEqual(calls.animate, [true]);
	const { value: idle, calls: idleCalls } = host();
	viewOf(idle).render(chat, 100);
	assert.deepEqual(idleCalls.animate, [false]);
});

test("a click opens a group, showing its rows and its replies' thinking, and another closes it", () => {
	const { value, calls } = host();
	const thinking = new Reply(quiet(), false, ["", "∴ Thought"]);
	const read = new ToolRow("read", "a");
	const chat = chatOf([thinking, read, new Reply(said())]);
	const view = viewOf(value);
	assert.equal(view.foldsThinking(thinking), false, "not before it is in this transcript");
	view.render(chat, 80);
	assert.equal(view.foldsThinking(thinking), true);
	const row = chat.mouseLayout!.children[0]!.component as FoldRow;
	assert.equal(row.handleMouse({ type: "click", button: "left", y: 0 } as never), undefined, "the blank line above is not the target");
	assert.deepEqual(row.handleMouse({ type: "click", button: "left", y: 1 } as never), { handled: true });
	assert.equal(calls.redraws, 1);
	const open = text(view.render(chat, 80));
	assert.deepEqual(open.slice(0, 6), ["", "● Read 1 file, ↓100 2.0s", "│ ∴ Thought", "│", "│ ● read", "╰─ close"], "its rows in a rule, without the first one's blank line");
	assert.equal(thinking.folded, false, "the reply is built again with its thinking");
	const builds = thinking.invalidations;
	view.render(chat, 80);
	assert.equal(thinking.invalidations, builds, "once");
	row.handleMouse({ type: "click", button: "left", y: 1 } as never);
	view.render(chat, 80);
	assert.equal(thinking.folded, true, "and again without it once the group closes");
	assert.equal(row.handleMouse({ type: "click", button: "right", y: 1 } as never), undefined);
});

test("Pi's expand key opens every group through the rows it expands", () => {
	const { value } = host();
	const read = new ToolRow("read", "a");
	const chat = chatOf([read, new Reply(said())]);
	const view = viewOf(value);
	assert.equal(view.render(chat, 80).length, 4);
	read.expanded = true;
	assert.deepEqual(text(view.render(chat, 80)).slice(0, 4), ["", "● Read 1 file", "│ ● read", "╰─ close"]);
});

test("failed calls are counted in the error color's words, and a narrow line still fits", () => {
	const { value } = host();
	const chat = chatOf([new ToolRow("bash", "a", false, true), new ToolRow("bash", "b")]);
	const lines = viewOf(value).render(chat, 100);
	assert.match(text(lines)[1]!, /^● Ran 2 commands, 1 failed$/);
	for (const width of [1, 5, 20, 40]) assert.ok(viewOf(value).render(chat, width).every((line) => visibleWidth(line) <= width), `${width}`);
});

test("an empty finished group draws nothing", () => {
	const { value } = host();
	const chat = chatOf([new Reply({ content: [] }), new Reply(said())]);
	assert.deepEqual(text(viewOf(value).render(chat, 80)), ["", "● said"]);
});

test("a reply speaks with text, or with a notice of how it ended", () => {
	assert.equal(speaks(said()), true);
	assert.equal(speaks(quiet()), false);
	assert.equal(speaks({ content: [{ type: "text", text: "  " }] }), false);
	assert.equal(speaks({ content: [], stopReason: "error" }), true);
	assert.equal(speaks({ content: [{ type: "toolCall" }], stopReason: "aborted" }), false, "Pi shows the abort on the call rows");
	assert.equal(speaks({ content: [{ type: "toolCall" }], stopReason: "length" }), true);
	assert.equal(speaks(undefined), false);
});

test("tokens are the reported count, or a character estimate while streaming", () => {
	assert.equal(tokensOf(quiet(), false), 100);
	assert.equal(tokensOf({ content: [{ type: "thinking", thinking: "x".repeat(40) }, { type: "toolCall", arguments: { a: 1 } }], usage: { output: 1 } }, true), (40 + 7) / 4);
	assert.equal(tokensOf({ content: [{ type: "text", text: "abcd" }] }, false), 1);
});

test("the transcript is found only in Pi's layout", () => {
	const chat = new Container();
	const document = new Container();
	document.children = [new Container(), new Container(), chat];
	const tui = { children: [document, ...Array.from({ length: 6 }, () => new Container())] };
	assert.equal(findTranscript(tui), chat);
	assert.equal(findTranscript({ children: tui.children.slice(1) }), undefined);
	assert.equal(findTranscript({ children: [new Container(), ...tui.children.slice(1)] }), undefined);
	assert.equal(findTranscript(undefined), undefined);
});

test("the patch draws through the newest view while it is on, and Pi's render otherwise", () => {
	const chat = chatOf([new ToolRow("read", "a"), new Reply(said())]);
	const pi = text(chat.render(80));
	let on = true;
	const first = installFold(chat, viewOf(host().value), () => on);
	const patched = chat.render;
	assert.notDeepEqual(text(chat.render(80)), pi);
	on = false;
	assert.deepEqual(text(chat.render(80)), pi);
	on = true;
	const failing = viewOf(host().value);
	failing.render = () => { throw new Error("boom"); };
	const second = installFold(chat, failing, () => true);
	assert.equal(chat.render, patched, "a reload takes over the one patch");
	building = undefined;
	assert.deepEqual(text(chat.render(80)), pi, "a failing view leaves Pi's render");
	first();
	assert.deepEqual(text(chat.render(80)), pi, "an old undo leaves the new view in place");
	second();
	assert.deepEqual(text(chat.render(80)), pi);
});

test("a notice Pi adds mid-run, such as ctrl+o's status line, neither splits the group nor stops it being live", () => {
	const { value } = host({ busy: () => true });
	const note = new Text("Tool output: expanded", 1, 0);
	const later = new ToolRow("read", "b", true);
	const chat = chatOf([new Reply(said({ timestamp: 1 })), new ToolRow("bash", "a"), new Spacer(1), note, later]);
	const lines = text(viewOf(value).render(chat, 100));
	assert.match(lines[2]!, /^  ⠋ Ran 1 command, reading 1 file/);
	assert.deepEqual(lines.slice(3), ["", " Tool output: expanded"]);
});

test("a group with a call still running stays live when a reply follows it", () => {
	const { value } = host({ busy: () => true });
	const chat = chatOf([new ToolRow("bash", "a", true), new Reply(said())]);
	assert.match(text(viewOf(value).render(chat, 100))[1]!, /^⠋ Running 1 command/);
});

test("with ctrl+o's rows expanded, a click closes a group; an open group keeps its spacers", () => {
	const { value } = host();
	const read = new ToolRow("read", "a");
	read.expanded = true;
	const chat = chatOf([read, new Spacer(1), new ToolRow("bash", "b"), new Reply(said())]);
	const view = viewOf(value);
	assert.deepEqual(text(view.render(chat, 80)).slice(1, 7), ["● Read 1 file, ran 1 command", "│ ● read", "│", "│", "│ ● bash", "╰─ close"], "the spacer between the rows stays");
	const row = chat.mouseLayout!.children[0]!.component as FoldRow;
	row.handleMouse({ type: "click", button: "left", y: 1 } as never);
	assert.deepEqual(text(view.render(chat, 80)), ["", "● Read 1 file, ran 1 command", "", "● said"]);
});

test("a settled group is not worked out again on every frame", () => {
	let worked = 0;
	const { value } = host({ thoughtMs: () => { worked++; return undefined; } });
	const chat = chatOf([new Reply(said({ timestamp: 1 })), new ToolRow("read", "a"), new Reply(said())]);
	const view = viewOf(value);
	const first = view.render(chat, 80);
	const count = worked;
	assert.deepEqual(view.render(chat, 80), first);
	assert.equal(worked, count);
});

const thinkingThenWords = (over: Partial<ReplyMessage> = {}): ReplyMessage => ({ content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "ok" }], usage: { output: 30 }, timestamp: 1_000, ...over });

test("a reply that thought and then spoke keeps a Thought line above its words", () => {
	const { value } = host({ thoughtMs: () => 2_500 });
	const chat = chatOf([new Row(["", " prompt"]), new Reply(thinkingThenWords())]);
	assert.deepEqual(text(viewOf(value).render(chat, 80)), ["", " prompt", "", "∴ Thought for 2.5s", "● said"], "right above its words, with no figures");
});

test("its thinking counts once: in the Thought line, not again in the line of the calls it made", () => {
	const { value } = host({ thoughtMs: () => 500 });
	const narrating = new Reply(thinkingThenWords({ content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "looking" }, { type: "toolCall" }] }));
	const chat = chatOf([narrating, new ToolRow("read", "a"), new Reply(said())]);
	const lines = text(viewOf(value).render(chat, 80));
	assert.equal(lines[1], "∴ Thought for 0.5s");
	assert.equal(lines[3], "  ● Read 1 file, 1.5s", "no reply of its own to count; its time starts when the reply stopped thinking (1.0s + 0.5s) and runs to the result (3.0s)");
});

test("a reply streaming its words below a finished Thought line does not keep the line live", () => {
	const { value } = host({ busy: () => true });
	const chat = chatOf([new ToolRow("read", "a"), new Reply(thinkingThenWords(), true)]);
	assert.match(text(viewOf(value).render(chat, 80))[1]!, /^● Read 1 file, /);
});

test("a settled line uses the theme's darker grays", () => {
	const keys: string[] = [];
	const { value } = host({ theme: () => ({ fg: (key: string, text: string) => { keys.push(key); return text; } }) });
	viewOf(value).render(chatOf([new ToolRow("read", "a")]), 80);
	assert.deepEqual(keys, ["muted", "dim", "dim"], "the words muted; the bullet and the figures dim");
});

test("on a narrow line the words become the total count, then the figures go, then the words are cut", () => {
	const { value } = host();
	const chat = chatOf([new Reply(said({ timestamp: 1 })), new ToolRow("read", "a"), new ToolRow("bash", "b"), new ToolRow("edit", "c")]);
	const at = (width: number) => text(viewOf(value).render(chat, width))[2]!;
	assert.equal(at(100), "  ● Read 1 file, ran 1 command, edited 1 file, ↓50 5.4s");
	assert.equal(at(50), "  ● Used 3 tools, ↓50 5.4s", "every kind doesn't fit: the total count");
	assert.equal(at(20), "  ● Used 3 tools", "too narrow for both: the words win");
	assert.equal(at(12), "  ● Used 3…");
});

test("a cut keeps each part's color and leaves no comma or space before the ellipsis", () => {
	const parts = [{ key: "text", text: "Ran 2 commands" }, { key: "text", text: ", " }, { key: "error", text: "1 failed" }];
	assert.deepEqual(cut(parts, 40), parts, "it fits");
	assert.deepEqual(cut(parts, 20), [{ key: "text", text: "Ran 2 commands" }, { key: "text", text: ", " }, { key: "error", text: "1 f…" }]);
	assert.deepEqual(cut(parts, 19).at(-1), { key: "error", text: "1…" }, "a space before the cut goes too");
	assert.deepEqual(cut(parts, 16), [{ key: "text", text: "Ran 2 commands…" }], "a part left with only a comma goes");
	assert.deepEqual(cut(parts, 1), [{ key: "text", text: "…" }]);
});

test("a chained command counts each step, and a leading cd is a place, not a step", () => {
	assert.equal(commandsIn({ command: "sleep 2; echo ok" }), 2);
	assert.equal(commandsIn({ command: "cd lib && npm test && npm run lint" }), 2);
	assert.equal(commandsIn({ command: "npm test" }), 1);
	assert.equal(commandsIn('{"command":"a && b && c"}'), 3, "a nested call's arguments come as JSON text");
	assert.equal(commandsIn("[arguments omitted from live cache]"), 1);
	assert.equal(commandsIn(undefined), 1);
});

test("a script counts the calls it made in its place, and still says when it runs or fails", () => {
	const nested = [{ name: "bash", status: "ok", args: '{"command":"a && b"}' }, { name: "read", status: "error" }];
	assert.deepEqual(factsOfCall("codemode", {}, false, false, nested), [
		{ name: "bash", running: false, failed: false, count: 2 },
		{ name: "read", running: false, failed: true, count: 1, label: "read" },
	]);
	assert.deepEqual(factsOfCall("codemode", {}, false, true, []), [{ name: "codemode", running: false, failed: true, label: "codemode" }], "no calls known: the script itself");
	assert.deepEqual(factsOfCall("codemode", {}, true, false, nested).at(-1), { name: "codemode", running: true, failed: false, count: 0 });
	const { value } = host({ nestedOf: (id) => (id === "s" ? nested : undefined) });
	const chat = chatOf([new ToolRow("codemode", "s"), new ToolRow("bash", "b")]);
	(chat.children[1] as unknown as { args: unknown }).args = { command: "ls; pwd; date" };
	assert.match(text(viewOf(value).render(chat, 100))[1]!, /^● Ran 5 commands, read 1 file, read failed/, "the one failed call is named");
});

/** A tool row that notes the clicks it gets. */
class ClickRow extends ToolRow {
	readonly events: Array<{ x: number; y: number; width: number }> = [];
	handleMouse(event: { x: number; y: number; width: number }) {
		this.events.push({ x: event.x, y: event.y, width: event.width });
		return { handled: true };
	}
}

const click = (chat: Box, y: number, x = 6, width = 80) =>
	(chat as unknown as Container).handleMouse({ type: "click", button: "left", x, y, width, height: 100, screenX: x, screenY: y, shift: false, alt: false, ctrl: false } as never);

test("an open run hangs its rows in a rule under its line, and the rule's end closes it", () => {
	const { value } = host();
	const read = new ClickRow("read", "a");
	const chat = chatOf([new Reply(said({ content: [{ type: "text", text: "looking" }, { type: "toolCall" }], timestamp: 1_000 })), read, new Reply(said())]);
	const view = viewOf(value);
	view.render(chat, 80);
	const row = chat.mouseLayout!.children[1]!.component as FoldRow;
	assert.equal(row.handleMouse({ type: "click", button: "left", y: 0 } as never)?.handled, true, "a hung line has no blank line above it");
	const lines = view.render(chat, 80);
	assert.deepEqual(text(lines), ["", "● said", "  ● Read 1 file, ↓50 2.0s", "  │ ● read", "  ╰─ close", "", "● said"]);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
	assert.deepEqual(read.widths.at(-1), 76);
	click(chat, 3, 6);
	assert.deepEqual(read.events, [{ x: 2, y: 1, width: 76 }], "a click on a row reaches it where the row drew it");
	click(chat, 4);
	assert.deepEqual(text(view.render(chat, 80)), ["", "● said", "  ● Read 1 file, ↓50 2.0s", "", "● said"], "closed");
	for (const width of [1, 3, 5, 20]) {
		row.open = true;
		assert.ok(view.render(chat, width).every((line) => visibleWidth(line) <= width), `${width}`);
	}
});

test("an open run's line is brighter than a closed one", () => {
	const keys: string[] = [];
	const { value } = host({ theme: () => ({ fg: (key: string, text: string) => { keys.push(key); return text; } }) });
	const chat = chatOf([new ToolRow("read", "a")]);
	const view = viewOf(value);
	view.render(chat, 80);
	(chat.mouseLayout!.children[0]!.component as FoldRow).open = true;
	keys.length = 0;
	view.render(chat, 80);
	assert.deepEqual(keys.slice(0, 3), ["text", "muted", "dim"], "the words in the text color, the bullet muted, the figures dim");
});

test("an open Thought line shows the reply's thinking in full right under it", () => {
	const { value } = host({ thoughtMs: () => 2_500 });
	const reply = new Reply(thinkingThenWords(), false, ["", "  plan", "", "● said"]);
	const chat = chatOf([new Row(["", " prompt"]), reply]);
	const view = viewOf(value);
	view.render(chat, 80);
	assert.equal(view.expandsThinking(reply), false);
	const row = chat.mouseLayout!.children[1]!.component as FoldRow;
	row.handleMouse({ type: "click", button: "left", y: 1 } as never);
	assert.deepEqual(text(view.render(chat, 80)), ["", " prompt", "", "∴ Thought for 2.5s", "  plan", "", "● said"], "no rule: the thinking is the reply's own");
	assert.equal(view.expandsThinking(reply), true);
	assert.equal(reply.folded, false);
});

test("a call names its file and, when it fails, what it ran", () => {
	assert.deepEqual(factsOfCall("edit", { path: "lib/status/footer.ts" }, false, false, undefined), [{ name: "edit", running: false, failed: false, file: "footer.ts" }]);
	assert.deepEqual(factsOfCall("bash", { command: "ls node_modules\npwd" }, false, true, undefined), [{ name: "bash", running: false, failed: true, count: 2, label: "ls node_modules pwd" }]);
	assert.equal(factsOfCall("bash", { command: "x".repeat(80) }, false, true, undefined)[0]!.label, `${"x".repeat(31)}…`);
	assert.equal(factsOfCall("mcp__oc__web_search", {}, false, true, undefined)[0]!.label, "web_search");
	assert.equal(factsOfCall("read", { path: "a/b.ts" }, false, true, undefined)[0]!.label, "read b.ts");
	assert.equal(factsOfCall("bash", {}, false, true, undefined)[0]!.label, undefined, "a shell call without its command");
	const nested = [{ name: "write", status: "error", args: '{"path":"x/y.md"}' }];
	assert.deepEqual(factsOfCall("codemode", {}, false, false, nested), [{ name: "write", running: false, failed: true, count: 1, file: "y.md", label: "write y.md" }]);
});

test("calls after a reply that draws nothing keep their own blank line, as nothing is there to hang under", () => {
	const { value } = host();
	const chat = chatOf([new Row(["", " prompt"]), new Reply(said({ timestamp: 1_000 }), false, []), new ToolRow("read", "a")]);
	assert.deepEqual(text(viewOf(value).render(chat, 80)), ["", " prompt", "", "● Read 1 file, ↓50 2.0s"]);
});
