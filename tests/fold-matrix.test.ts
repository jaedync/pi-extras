/**
 * Every way a thinking block can draw with Tool Display, against Pi's own
 * reply, tool row and container: fold mode on and off, each thinking style,
 * Pi's hide-thinking setting at the start and its toggle (ctrl+t), a fold
 * group closed, opened by a click or by Pi's expand key (ctrl+o), or opened
 * and closed again, a reply that still thinks or one that is done, several
 * transcript shapes, and a click on a thinking block or none. Each drawing is
 * checked against the invariants below; the phase spinner's tail is read from
 * the settings Tool Display would publish.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, getMarkdownTheme, initTheme, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { FoldRow } from "../lib/fold/row.ts";
import { elapsed } from "../lib/fold/summary.ts";
import { FoldView, installFold, type Box } from "../lib/fold/transcript.ts";
import { thoughtFor } from "../lib/tool-display/index.ts";
import { liveTailShown } from "../lib/tool-display/live-thinking.ts";
import { installThinkingTail, thoughtLabel, type ThinkingMode } from "../lib/tool-display/thinking.ts";

initTheme("dark");

const WIDTH = 80;
const ui = { requestRender() {} };
const MODES: readonly ThinkingMode[] = ["tail", "collapsed", "full"];
const OPENINGS = ["closed", "click", "ctrl+o", "open-close"] as const;
type Opening = (typeof OPENINGS)[number];
/** The live run's time so far. */
const LIVE_MS = 3_300;
/** Each live paragraph says LIVE, so any part of it shows where it is drawn. */
const LIVE_TEXT = Array.from({ length: 9 }, (_, index) => `LIVE idea ${index + 1} goes on for a while to fill a line.`).join("\n\n");

const plain = (line: string) => stripTerminalSequences(line).replace(/\u00a0/g, " ").trimEnd();
const blank = (line: string) => plain(line).replace(/^\s*│/, "").trim() === "";

/** What the harness shares with the thinking patch and the fold view; set before each case. */
const state = {
	fold: true,
	mode: "tail" as ThinkingMode,
	hiddenAtStart: true,
	/** Pi's hide-thinking setting as the thinking patch last heard it (ctrl+t). */
	hidden: undefined as boolean | undefined,
	liveOpen: false,
	expanded: false,
	busy: false,
	durations: new Map<object, number[]>(),
	liveMessage: undefined as object | undefined,
	view: undefined as FoldView | undefined,
};

function duration(message: object, run: number, live = false): number | undefined {
	const runs = state.durations.get(message);
	// The live run has a time so far, and none of its own yet.
	if (message === state.liveMessage && run === (runs?.length ?? 0) - 1) return live ? LIVE_MS : undefined;
	return runs?.[run];
}

installThinkingTail({
	mode: () => state.mode,
	hiddenAtStart: () => state.hiddenAtStart,
	theme: () => undefined,
	gutter: () => true,
	folds: (reply) => state.view?.foldsThinking(reply) ?? false,
	expands: (reply) => state.view?.expandsThinking(reply) ?? false,
	opens: (reply) => state.view?.opensThinking(reply) ?? false,
	summary: (message, run) => thoughtLabel(duration(message, run)),
	hidden: (hide) => { state.hidden = hide; },
});

/** The settings Tool Display publishes for the phase spinner. */
const published = () => ({
	hidesLiveThinking: true,
	folds: state.fold,
	thinking: state.mode,
	thinkingToggled: (state.hidden ?? state.hiddenAtStart) !== state.hiddenAtStart,
	liveOpen: state.liveOpen,
});

type Part = Record<string, unknown>;
const think = (text: string): Part => ({ type: "thinking", thinking: text });
const words = (text: string): Part => ({ type: "text", text });
const call = (id: string): Part => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } });

interface Shape {
	readonly name: string;
	readonly build: (add: Adder) => void;
	/** A group with calls holds finished thinking, which ctrl+t flips when the group is open (S2). */
	readonly callThinking: boolean;
	/** No thinking text at all. */
	readonly quiet?: boolean;
	/** The reply that streams, in place of a reply of live thinking after the shape. */
	readonly live?: (add: Adder) => void;
}

interface Adder {
	reply(content: Part[], over?: Part, streaming?: boolean): void;
	row(id: string, failed?: boolean): void;
}

const SHAPES: readonly Shape[] = [
	{ name: "alone", callThinking: false, build: (add) => add.reply([think("Mull it alone.")]) },
	{ name: "said", callThinking: false, build: (add) => add.reply([think("Mull before words."), words("The answer.")]) },
	{ name: "call", callThinking: true, build: (add) => { add.reply([think("Mull, then read."), call("c1")], { stopReason: "toolUse" }); add.row("c1"); } },
	{
		name: "two", callThinking: true, build: (add) => {
			add.reply([think("Mull one."), call("c1")], { stopReason: "toolUse" });
			add.row("c1");
			add.reply([think("Mull two."), call("c2")], { stopReason: "toolUse" });
			add.row("c2");
			add.reply([words("All read.")]);
		},
	},
	{
		name: "empty", callThinking: true, build: (add) => {
			add.reply([think("Mull with a gap."), think(""), call("c1")], { stopReason: "toolUse" });
			add.row("c1");
			add.reply([think("")]);
		},
	},
	{
		name: "aborted", callThinking: true, build: (add) => {
			add.reply([think("Mull, then stop."), call("c1")], { stopReason: "aborted", errorMessage: "Request was aborted" });
			add.row("c1", true);
		},
	},
	{
		// It thought and read, then thought and spoke: its words close the group with calls.
		name: "callsaid", callThinking: true, build: (add) => {
			add.reply([think("Mull, then read."), call("c1")], { stopReason: "toolUse" });
			add.row("c1");
			add.reply([think("Mull over the file."), words("It says one.")]);
		},
	},
	{
		// An empty block first, then words and thinking: the timer counts the empty run, as the label must.
		name: "gap", callThinking: false,
		build: (add) => add.reply([think(""), words("Let me look."), think("Mull after.")]),
	},
	{ name: "error", callThinking: false, build: (add) => add.reply([think("Mull, then fail.")], { stopReason: "error", errorMessage: "Overloaded" }) },
	// A provider that keeps its thinking to itself sends an empty block, and still counts its tokens.
	{ name: "redacted", callThinking: false, quiet: true, build: (add) => add.reply([think("")]) },
	{
		// It spoke, then thinks again in the same reply.
		name: "late", callThinking: false,
		build: (add) => add.reply([think("Mull first."), words("Let me look again."), think("Mull again.")]),
		live: (add) => add.reply([think("Mull first."), words("Let me look again."), think(LIVE_TEXT)], {}, true),
	},
];

interface Case {
	readonly fold: boolean;
	readonly mode: ThinkingMode;
	readonly hiddenAtStart: boolean;
	readonly presses: number;
	/** ctrl+t is pressed after the groups open, not before. */
	readonly late: boolean;
	readonly opening: Opening;
	readonly streaming: boolean;
	readonly shape: Shape;
	readonly clickThinking: boolean;
}

const keyOf = (c: Case, over: Partial<Case> = {}) => {
	const k = { ...c, ...over };
	return `${k.fold}|${k.mode}|${k.hiddenAtStart}|${k.presses}|${k.late}|${k.opening}|${k.streaming}|${k.shape.name}|${k.clickThinking}`;
};

interface Drawing {
	readonly lines: string[];
	readonly layout: Array<{ component: Component; height: number }>;
	/** What each layout entry draws when asked again, at once. */
	readonly owned: string[][];
	/** The phase spinner draws the live tail under the transcript. */
	readonly spinnerTail: boolean;
	/** Durations of the finished runs, in order. */
	readonly runs: number[];
	/** Every time text a line may say: each run's, each sum of them, the live time. */
	readonly times: Set<string>;
	/** A click on a thinking block landed. */
	readonly clicked: boolean;
}

function build(c: Case): { chat: Container; replies: AssistantMessageComponent[] } {
	const chat = new Container();
	const replies: AssistantMessageComponent[] = [];
	let at = 1_000;
	let next = 0;
	chat.addChild(new Spacer(1));
	chat.addChild(new UserMessageComponent("Do the thing.", getMarkdownTheme(), 1));
	const add: Adder = {
		reply(content, over = {}, streaming = false) {
			const message = { role: "assistant", content, stopReason: "stop", usage: { output: 40 }, timestamp: (at += 1_000), ...over };
			const runs = content.filter((part, index) => part.type === "thinking" && content[index - 1]?.type !== "thinking");
			state.durations.set(message, runs.map(() => 1_100 * 2 ** next++));
			if (streaming) {
				state.liveMessage = message;
				// As Pi builds the reply it streams: empty, then each update.
				const live = new AssistantMessageComponent(undefined, c.hiddenAtStart);
				chat.addChild(live);
				live.updateContent(message as never, true);
				replies.push(live);
				return;
			}
			const reply = new AssistantMessageComponent(message as never, c.hiddenAtStart);
			chat.addChild(reply);
			replies.push(reply);
		},
		row(id, failed = false) {
			const row = new ToolExecutionComponent("read", id, { path: `${id}.ts` }, {}, undefined, ui as never, "/tmp");
			row.updateResult({ content: [{ type: "text", text: failed ? "Operation aborted" : `export const ${id} = 1;` }], isError: failed });
			chat.addChild(row);
		},
	};
	if (c.streaming && c.shape.live) c.shape.live(add);
	else c.shape.build(add);
	if (c.streaming && !c.shape.live) add.reply([think(LIVE_TEXT)], { usage: { output: 0 } }, true);
	return { chat, replies };
}

const isEnd = (component: Component) => component.constructor.name === "FoldEnd";

/** Clicks each fold line once, from the top, or each rule's end, or each line of a group still open: a click opens or closes that group. */
function clickLines(chat: Container, how: "lines" | "ends" | "open" = "lines"): void {
	const viaEnd = how === "ends";
	const done = new Set<Component>();
	for (let guard = 0; guard < 20; guard++) {
		const lines = chat.render(WIDTH);
		const layout = (chat as unknown as Box).mouseLayout?.children ?? [];
		let y = 0;
		let target: number | undefined;
		layout.forEach((entry) => {
			const end = viaEnd && isEnd(entry.component) && !done.has(entry.component);
			const row = !viaEnd && entry.component instanceof FoldRow && !done.has(entry.component) && (how === "lines" || entry.component.open);
			if (target === undefined && (end || row)) {
				done.add(entry.component);
				target = y + entry.height - 1;
			}
			y += entry.height;
		});
		if (target === undefined) return;
		chat.handleMouse({ type: "click", button: "left", x: 4, y: target, width: WIDTH, height: lines.length } as never);
	}
}

/** Lines drawn by a fold line or a rule's end, which are not a thinking block. */
function foldLines(layout: Drawing["layout"]): Set<number> {
	const own = new Set<number>();
	let y = 0;
	for (const entry of layout) {
		if (entry.component instanceof FoldRow || isEnd(entry.component)) for (let i = 0; i < entry.height; i++) own.add(y + i);
		y += entry.height;
	}
	return own;
}

const THINKING = /∴ Thought|Mull|LIVE/;

function clickThinking(chat: Container): boolean {
	const lines = chat.render(WIDTH);
	const fold = foldLines((chat as unknown as Box).mouseLayout?.children ?? []);
	const y = lines.findIndex((line, index) => !fold.has(index) && THINKING.test(plain(line)));
	if (y < 0) return false;
	chat.handleMouse({ type: "click", button: "left", x: 6, y, width: WIDTH, height: lines.length } as never);
	return true;
}

function subsetSums(values: readonly number[]): number[] {
	return values.reduce<number[]>((sums, value) => [...sums, ...sums.map((sum) => sum + value)], [0]).filter((sum) => sum > 0);
}

/** Sets the state for a case and makes a fresh fold view over it. */
function freshView(c: Pick<Case, "fold" | "mode" | "hiddenAtStart" | "streaming">): FoldView {
	state.fold = c.fold;
	state.mode = c.mode;
	state.hiddenAtStart = c.hiddenAtStart;
	state.hidden = undefined;
	state.liveOpen = false;
	state.expanded = false;
	state.busy = c.streaming;
	state.durations = new Map();
	state.liveMessage = undefined;
	const view = new FoldView({
		enabled: () => state.fold, theme: () => undefined, busy: () => state.busy, now: () => 60_000, reduced: () => true,
		toolEndedAt: () => undefined, nestedOf: () => undefined, animate() {}, redraw() {},
		thoughtMs: (message, live) => thoughtFor(message, (reply, run) => duration(reply, run, live)),
		toolsExpanded: () => state.expanded,
		liveOpen: (open) => { state.liveOpen = open; },
	});
	state.view = view;
	return view;
}

/** Pushes ctrl+t as many times as the case says, as Pi's updateThinkingBlockVisibility does. */
function pressCtrlT(c: Case, chat: Container, replies: readonly AssistantMessageComponent[]): void {
	let hide = c.hiddenAtStart;
	for (let pressed = 0; pressed < c.presses; pressed++) {
		hide = !hide;
		for (const reply of replies) reply.setHideThinkingBlock(hide);
		chat.render(WIDTH);
	}
}

/** Opens the groups the way the case says. */
function openGroups(c: Case, chat: Container): void {
	if (c.opening === "click" || c.opening === "open-close") clickLines(chat);
	if (c.opening === "open-close") {
		// Closed by the rule's end where there is one; a group whose words follow its line has none.
		clickLines(chat, "ends");
		clickLines(chat, "open");
	}
	if (c.opening !== "ctrl+o") return;
	// As Pi's setToolsExpanded does: only children with setExpanded hear it.
	state.expanded = true;
	for (const child of chat.children) {
		const expandable = child as Component & { setExpanded?: (expanded: boolean) => void };
		if (typeof expandable.setExpanded === "function") expandable.setExpanded(true);
	}
}

function draw(c: Case): Drawing {
	const view = freshView(c);
	const { chat, replies } = build(c);
	const undo = installFold(chat as unknown as Box, view, () => state.fold);
	try {
		chat.render(WIDTH);
		if (!c.late) pressCtrlT(c, chat, replies);
		openGroups(c, chat);
		if (c.late) pressCtrlT(c, chat, replies);
		const clicked = c.clickThinking ? clickThinking(chat) : false;
		const lines = chat.render(WIDTH);
		// Pi's container writes the layout too, so it is there with fold mode off.
		const layout = [...((chat as unknown as Box).mouseLayout?.children ?? [])];
		const owned = layout.map((entry) => entry.component.render(WIDTH).map(plain));
		const runs = [...state.durations.values()].flat();
		const times = new Set([...subsetSums(runs), ...subsetSums(runs).map((sum) => sum + LIVE_MS), LIVE_MS].map(elapsed));
		return { lines, layout, owned, spinnerTail: c.streaming && liveTailShown(published()), runs, times, clicked };
	} finally {
		undo();
	}
}

function* cases(): Generator<Case> {
	for (const fold of [false, true]) for (const mode of MODES) for (const hiddenAtStart of [true, false]) for (const presses of [0, 1, 2]) for (const late of presses === 1 && fold ? [false, true] : [false])
		for (const opening of fold ? OPENINGS : (["closed"] as const)) for (const streaming of [false, true]) for (const shape of SHAPES)
			for (const clickThinking of [false, true]) yield { fold, mode, hiddenAtStart, presses, late, opening, streaming, shape, clickThinking };
}

/** Where the live thinking should show, by S3 and S6. */
function liveExpected(c: Case): "inline" | "tail" | "none" {
	const toggled = c.presses % 2 === 1;
	if (c.fold) return c.opening === "click" || c.opening === "ctrl+o" ? "inline" : toggled ? "tail" : "none";
	if (c.mode === "collapsed") return toggled ? "tail" : "none";
	return "tail";
}

const open = (c: Case) => c.fold && (c.opening === "click" || c.opening === "ctrl+o");

function checkOne(c: Case, d: Drawing, fail: (invariant: string, detail: string) => void): void {
	const text = d.lines.map(plain);
	// I1: one label for the same thinking; never a Thought line right under another.
	const labels = text.map((line) => line.match(/Thought for ([^\s,]+)/)?.[1]).filter((time): time is string => !!time);
	const seen = new Set<string>();
	for (const label of labels) {
		if (seen.has(label)) fail("I1", `two "Thought for ${label}"`);
		seen.add(label);
	}
	const shown = text.filter((line) => !blank(line));
	shown.forEach((line, index) => {
		if (index > 0 && /∴ Thought/.test(line) && /∴ Thought/.test(shown[index - 1]!)) fail("I1", `a Thought line under a Thought line: ${shown[index - 1]} / ${line}`);
	});
	// I4: one format and one measure for every time text.
	for (const label of labels) if (!d.times.has(label)) fail("I4", `"Thought for ${label}" is not one of ${[...d.times].slice(0, 6).join(", ")}…`);
	// I3: the live thinking in at most one place, the place S3 and S6 name.
	if (c.streaming) {
		const inline = text.some((line) => line.includes("LIVE"));
		const place = inline && d.spinnerTail ? "both" : inline ? "inline" : d.spinnerTail ? "tail" : "none";
		if (place !== liveExpected(c)) fail("I3", `live thinking: ${place}, wanted ${liveExpected(c)}`);
	} else if (text.some((line) => line.includes("LIVE"))) fail("I3", "no live reply, yet LIVE shows");
	// I8: no doubled blank line. Pi pads its own rows with lines of a background color, which are not blank.
	const empty = (line: string) => blank(line) && !/\x1b\[[\d;]*\b48[;:]/.test(line);
	d.lines.forEach((line, index) => { if (index > 0 && empty(line) && empty(d.lines[index - 1]!)) fail("I8", `two blank lines at ${index}`); });
	if (!c.fold) return;
	// I7: the mouse layout matches the lines, and each entry drew its own lines.
	const total = d.layout.reduce((sum, entry) => sum + entry.height, 0);
	if (total !== d.lines.length) fail("I7", `layout ${total} lines, drawn ${d.lines.length}`);
	let y = 0;
	let rowAt: number | undefined;
	for (const [index, entry] of d.layout.entries()) {
		const own = d.owned[index]!;
		for (let i = 0; i < entry.height; i++) {
			const drawn = text[y + i] ?? "";
			if (!drawn.endsWith(own[i] ?? "\u0000") && !(own[i] === "" && blank(drawn))) fail("I7", `line ${y + i} "${drawn}" is not what its component draws: "${own[i]}"`);
		}
		if (entry.component instanceof FoldRow) rowAt = y + entry.height;
		// I2: an open group draws something between its line and its end.
		if (isEnd(entry.component) && rowAt !== undefined && text.slice(rowAt, y).every(blank)) fail("I2", `an empty open group at ${y}`);
		// I8: a line of thinking alone sits right on its tucked reply.
		const after = d.layout[index + 1];
		if (entry.component instanceof FoldRow && /∴/.test(text[y + entry.height - 1]!) && after && !(after.component instanceof Spacer) && !(after.component instanceof FoldRow) && after.height > 0 && blank(text[y + entry.height]!)) {
			fail("I8", `a blank line under the Thought line at ${y}`);
		}
		y += entry.height;
	}
	if (d.lines.some((line) => visibleWidth(line) > WIDTH)) fail("I7", "a line is wider than the screen");
	if (open(c) && text.some((line) => line.includes("╰─ close")) && !text.some((line) => /\S/.test(line.replace(/[│╰─]|close/g, "")))) fail("I2", "only a rule");
}

function checkPairs(c: Case, drawings: ReadonlyMap<string, Drawing>, fail: (invariant: string, detail: string) => void): void {
	const d = drawings.get(keyOf(c))!;
	const same = (other: Drawing | undefined) => !!other && other.lines.join("\n") === d.lines.join("\n") && other.spinnerTail === d.spinnerTail;
	if (c.presses === 0) {
		// I5: ctrl+t changes the thinking it applies to, and nothing else.
		const pressed = drawings.get(keyOf(c, { presses: 1 }));
		// Unfolded, ctrl+t flips finished thinking; folded, only live thinking and an open group's calls' thinking.
		const applies = c.fold ? c.streaming || (open(c) && c.shape.callThinking) : !c.shape.quiet || (c.streaming && c.mode === "collapsed");
		if (applies === same(pressed)) fail("I5", applies ? "ctrl+t changed nothing" : "ctrl+t changed thinking it must not touch");
		if (!same(drawings.get(keyOf(c, { presses: 2 })))) fail("I5", "two presses differ from none");
	}
	// I6: ctrl+t before the groups open or after, the same drawing.
	if (c.late && !same(drawings.get(keyOf(c, { late: false })))) fail("I6", "ctrl+t after opening differs from ctrl+t before");
	// I6: open then close draws what was there before.
	if (c.fold && c.opening === "open-close" && !same(drawings.get(keyOf(c, { opening: "closed" })))) fail("I6", "open then close differs from closed");
	// S5: ctrl+o opens as a click does.
	if (c.fold && c.opening === "ctrl+o" && !c.clickThinking && !same(drawings.get(keyOf(c, { opening: "click" })))) fail("S5", "ctrl+o differs from a click");
	// S1: a click on the thinking of an open group of thinking alone changes nothing.
	if (open(c) && !c.shape.callThinking && !c.streaming && c.clickThinking && !same(drawings.get(keyOf(c, { clickThinking: false })))) fail("S1", "a click on the thinking changed it");
	// I4: the same thinking reads the same with fold mode on and off.
	// Shapes whose fold line holds one run of thinking, so one label says the same.
	if (c.fold && ["alone", "said", "error"].includes(c.shape.name) && !c.streaming && c.opening === "closed" && !c.clickThinking && c.presses === 0) {
		const time = (drawing: Drawing | undefined) => drawing?.lines.map(plain).find((line) => /Thought for/.test(line))?.match(/Thought for ([^\s,]+)/)?.[1];
		const unfolded = drawings.get(keyOf(c, { fold: false, opening: "closed", mode: "collapsed" }));
		if (time(d) !== time(unfolded)) fail("I4", `folded "${time(d)}", unfolded "${time(unfolded)}"`);
	}
}

test("the thinking matrix: every combination keeps the invariants", () => {
	const drawings = new Map<string, Drawing>();
	const all = [...cases()];
	for (const c of all) drawings.set(keyOf(c), draw(c));
	const failures = new Map<string, { count: number; first: string }>();
	for (const c of all) {
		const fail = (invariant: string, detail: string) => {
			const key = `${invariant}: ${detail.replace(/\d+(\.\d+)?/g, "#")}`;
			const kept = failures.get(key);
			if (kept) kept.count++;
			else failures.set(key, { count: 1, first: `${keyOf(c)}\n  ${detail}\n${drawings.get(keyOf(c))!.lines.map((line) => `    |${plain(line)}`).join("\n")}` });
		};
		checkOne(c, drawings.get(keyOf(c))!, fail);
		checkPairs(c, drawings, fail);
	}
	const report = [...failures.entries()].map(([key, { count, first }]) => `${key} (${count} cases)\n  first: ${first}`).join("\n\n");
	assert.equal(failures.size, 0, `${all.length} cases, ${failures.size} kinds of failure:\n\n${report}`);
});

const base: Omit<Case, "shape" | "streaming"> = { fold: true, mode: "tail", hiddenAtStart: true, presses: 0, late: false, opening: "click", clickThinking: false };

/** Builds the case, opens every group, and returns what a click on line `y` leaves. */
function clickedAt(c: Case, y: number): { before: string[]; after: string[] } {
	const view = freshView(c);
	const { chat } = build(c);
	const undo = installFold(chat as unknown as Box, view, () => true);
	try {
		chat.render(WIDTH);
		clickLines(chat);
		const before = chat.render(WIDTH).map(plain);
		chat.handleMouse({ type: "click", button: "left", x: 6, y, width: WIDTH, height: before.length } as never);
		return { before, after: chat.render(WIDTH).map(plain) };
	} finally {
		undo();
	}
}

test("a click on any line inside an open group leaves the group open; only its line and its end close it", () => {
	for (const shape of SHAPES) for (const streaming of [false, true]) {
		const c: Case = { ...base, shape, streaming };
		const { before } = clickedAt(c, -1);
		const closes = before.filter((line) => line.includes("╰─ close")).length;
		before.forEach((line, y) => {
			if (!line.startsWith("│") && !line.startsWith("  │")) return;
			const { after } = clickedAt(c, y);
			assert.equal(after.filter((drawn) => drawn.includes("╰─ close")).length, closes, `${shape.name} ${streaming ? "live" : "done"}: a click on "${line}" closed a group`);
		});
	}
});

test("an open live group stays open as its reply stops thinking: its thinking then shows in full, under its one label", () => {
	for (const mode of MODES) for (const presses of [0, 1]) {
		const view = freshView({ fold: true, mode, hiddenAtStart: true, streaming: true });
		const chat = new Container();
		chat.addChild(new UserMessageComponent("Do the thing.", getMarkdownTheme(), 1));
		const reply = new AssistantMessageComponent(undefined, true);
		chat.addChild(reply);
		const thinking = { role: "assistant", content: [think(LIVE_TEXT)], timestamp: 2_000 };
		state.liveMessage = thinking;
		reply.updateContent(thinking as never, true);
		if (presses) reply.setHideThinkingBlock(false);
		const undo = installFold(chat as unknown as Box, view, () => true);
		try {
			chat.render(WIDTH);
			clickLines(chat);
			assert.ok(chat.render(WIDTH).map(plain).some((line) => line.includes("LIVE")), `${mode}/${presses}: the open group shows the live thinking`);
			const spoken = { ...thinking, content: [think(LIVE_TEXT), words("Here it is.")] };
			state.liveMessage = undefined;
			state.durations.set(spoken, [4_400]);
			reply.updateContent(spoken as never, true);
			const lines = chat.render(WIDTH).map(plain);
			assert.equal(lines.filter((line) => /Thought/.test(line)).length, 1, `${mode}/${presses}: one label: ${lines.join(" / ")}`);
			assert.ok(lines.some((line) => line.includes("LIVE idea 1 ")), `${mode}/${presses}: in full`);
			state.busy = false;
			const finished = { ...spoken, stopReason: "stop" };
			state.durations.set(finished, [4_400]);
			reply.updateContent(finished as never, false);
			const done = chat.render(WIDTH).map(plain);
			assert.deepEqual(done.filter((line) => /Thought/.test(line)), ["∴ Thought for 4.4s"], `${mode}/${presses}: done`);
			assert.ok(done.some((line) => line.includes("LIVE idea 1 ")));
		} finally {
			undo();
		}
	}
});

/** As Pi's setToolsExpanded does: only children with setExpanded hear it. Then Pi draws. */
function ctrlO(chat: Container, expanded: boolean): void {
	state.expanded = expanded;
	for (const child of chat.children) {
		const expandable = child as Component & { setExpanded?: (expanded: boolean) => void };
		if (typeof expandable.setExpanded === "function") expandable.setExpanded(expanded);
	}
	chat.render(WIDTH);
}

test("ctrl+o opens every group and closes every group, whatever a click did before", () => {
	for (const shape of SHAPES) for (const streaming of [false, true]) {
		const c: Case = { ...base, shape, streaming };
		const drawn = (steps: (chat: Container) => void) => {
			const { chat } = build(c);
			const undo = installFold(chat as unknown as Box, freshView(c), () => true);
			try {
				chat.render(WIDTH);
				steps(chat);
				return chat.render(WIDTH).map(plain);
			} finally {
				undo();
			}
		};
		const name = `${shape.name} ${streaming ? "live" : "done"}`;
		const closed = drawn(() => {});
		const opened = drawn((chat) => ctrlO(chat, true));
		assert.deepEqual(drawn((chat) => { ctrlO(chat, true); ctrlO(chat, false); }), closed, `${name}: ctrl+o twice`);
		assert.deepEqual(drawn((chat) => { clickLines(chat); ctrlO(chat, true); }), opened, `${name}: a click, then ctrl+o`);
		assert.deepEqual(drawn((chat) => { ctrlO(chat, true); clickLines(chat); ctrlO(chat, false); ctrlO(chat, true); }), opened, `${name}: ctrl+o, a click to close, ctrl+o twice`);
	}
});

test("folded mode and the thinking style can change while a reply thinks: the live thinking still shows in one place", () => {
	const c: Case = { ...base, shape: SHAPES[0]!, streaming: true };
	const { chat } = build(c);
	const undo = installFold(chat as unknown as Box, freshView(c), () => state.fold);
	const place = () => {
		const inline = chat.render(WIDTH).map(plain).filter((line) => line.includes("LIVE")).length;
		const tail = liveTailShown(published());
		return inline > 0 && tail ? "both" : inline > 3 ? "inline full" : inline > 0 ? "inline" : tail ? "tail" : "none";
	};
	try {
		chat.render(WIDTH);
		ctrlO(chat, true);
		assert.equal(place(), "inline", "an open group");
		state.mode = "full";
		assert.equal(place(), "inline full", "the full style, on the next frame");
		state.mode = "collapsed";
		assert.equal(place(), "inline", "the collapsed style: the tail in the open group");
		state.mode = "tail";
		// As /tool-display folded off does: Tool Display builds the transcript again.
		state.fold = false;
		chat.invalidate();
		assert.equal(place(), "tail", "unfolded: the spinner's tail");
		state.fold = true;
		assert.equal(place(), "inline", "folded again: the open group, on its first frame");
		ctrlO(chat, false);
		assert.equal(place(), "none", "a closed group: only its line");
	} finally {
		undo();
	}
});
