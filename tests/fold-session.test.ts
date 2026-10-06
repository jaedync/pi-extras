import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { watchFold } from "../lib/fold/index.ts";

type Handler = (event: unknown, ctx: unknown) => void;

class Row implements Component {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly isPartial = false;
	readonly result = { isError: false };
	constructor(toolName: string, toolCallId: string) {
		this.toolName = toolName;
		this.toolCallId = toolCallId;
	}
	render(): string[] {
		return ["", `● ${this.toolName}`];
	}
	invalidate(): void {}
}

class Reply implements Component {
	readonly contentContainer = {};
	readonly isStreaming = false;
	readonly lastMessage: unknown;
	invalidated = 0;
	constructor(lastMessage: unknown) {
		this.lastMessage = lastMessage;
	}
	render(): string[] {
		return [];
	}
	invalidate(): void {
		this.invalidated++;
	}
}

function stage(options: { mode?: string; layout?: boolean } = {}) {
	const handlers = new Map<string, Handler[]>();
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
	const fire = (name: string, event: unknown = {}, ctx: unknown = context) => { for (const handler of handlers.get(name) ?? []) handler(event, ctx); };
	const chat = new Container();
	const document = new Container();
	document.children = [new Container(), new Container(), chat];
	let renders = 0;
	const tui = { children: options.layout === false ? [] : [document, ...Array.from({ length: 6 }, () => new Container())], requestRender: () => { renders++; } };
	const widgets: Array<[string, unknown]> = [];
	const notes: string[] = [];
	let broken = false;
	const reply = { role: "assistant", content: [{ type: "toolCall" }], usage: { output: 10, input: 1_000_000, cost: { total: 0 } }, provider: "p", model: "m", timestamp: 1_000 };
	const context = {
		mode: options.mode ?? "tui",
		ui: {
			get theme() {
				if (broken) throw new Error("boom");
				return undefined;
			},
			notify: (message: string) => { notes.push(message); },
			setWidget: (key: string, factory: unknown) => {
				widgets.push([key, factory]);
				if (typeof factory === "function") factory(tui, undefined);
			},
		},
		modelRegistry: { find: () => ({ cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 } }) },
		sessionManager: { getBranch: () => [{ type: "message", message: { role: "toolResult", toolCallId: "a", timestamp: 4_000 } }] },
	};
	let enabled = true;
	let busy = false;
	const ticks: Array<() => void> = [];
	let stopped = 0;
	const fold = watchFold(pi as never, {
		enabled: () => enabled,
		reduced: () => true,
		busy: () => busy,
		now: () => 9_000,
		frames: (tick) => {
			ticks.push(tick);
			return () => { stopped++; };
		},
	});
	const rows = { reply: new Reply(reply), row: new Row("read", "a") };
	chat.children = [rows.reply, rows.row];
	return {
		fold, fire, chat, widgets, rows, ticks, notes,
		breakTheme: () => { broken = true; },
		renders: () => renders, stopped: () => stopped,
		set: (next: { enabled?: boolean; busy?: boolean }) => { enabled = next.enabled ?? enabled; busy = next.busy ?? busy; },
	};
}

const plain = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).replace(/ {2,}/g, "  ").trimEnd());

test("a session folds Pi's transcript, pricing replies from the model when Pi recorded no cost", () => {
	const s = stage();
	s.fire("session_start");
	assert.equal(s.widgets.length, 0, "nothing of Pi's is touched before folded mode is on");
	assert.equal(s.fold.refresh(), true);
	assert.equal(s.fold.active(), true);
	assert.deepEqual(s.widgets.map(([key, factory]) => [key, typeof factory]), [["pi-extras.fold-probe", "function"], ["pi-extras.fold-probe", "undefined"]], "the probe widget comes down at once");
	assert.deepEqual(plain(s.chat.render(100)), ["", "▸ Read 1 file  1 tool · 10 tokens · $2.00 · 3.0s"], "the end time comes from the saved result");
	s.fire("message_end", { message: { role: "toolResult", toolCallId: "a", timestamp: 6_000 } });
	assert.match(plain(s.chat.render(100))[1]!, /· 5\.0s$/, "a new result moves it");
	const builds = s.rows.reply.invalidated;
	s.chat.render(100);
	assert.equal(s.rows.reply.invalidated, builds, "a reply the thinking patch never asks about is not built again every frame");
});

test("frames run while a line is live, and switching off stops them and builds the replies again", () => {
	const s = stage();
	s.fire("session_start");
	s.fold.refresh();
	s.set({ busy: true });
	s.chat.render(100);
	assert.equal(s.ticks.length, 1);
	const before = s.renders();
	s.ticks[0]!();
	assert.equal(s.renders(), before + 1);
	s.set({ enabled: false });
	const built = s.rows.reply.invalidated;
	assert.equal(s.fold.refresh(), false);
	assert.equal(s.stopped(), 1);
	assert.ok(s.rows.reply.invalidated > built);
	assert.deepEqual(plain(s.chat.render(100)), ["", "● read"], "Pi's own rows again");
	assert.equal(s.fold.foldsThinking(s.rows.reply), false);
});

test("print mode and an unknown layout leave the transcript alone; shutdown takes the view down", () => {
	const print = stage({ mode: "print" });
	print.fire("session_start");
	assert.equal(print.fold.refresh(), false);
	assert.equal(print.widgets.length, 0);
	assert.deepEqual(plain(print.chat.render(100)), ["", "● read"]);
	const odd = stage({ layout: false });
	odd.fire("session_start");
	assert.equal(odd.fold.refresh(), false, "an unknown layout is not folded");
	assert.deepEqual(plain(odd.chat.render(100)), ["", "● read"]);
	const s = stage();
	s.fire("session_start");
	s.fold.refresh();
	s.fire("session_shutdown");
	assert.deepEqual(plain(s.chat.render(100)), ["", "● read"]);
	assert.equal(s.fold.foldsThinking(s.rows.reply), false);
});

test("a view that throws leaves Pi's rows, stops its frames, and warns once", () => {
	const s = stage();
	s.fire("session_start");
	s.fold.refresh();
	s.set({ busy: true });
	s.chat.render(100);
	assert.equal(s.ticks.length, 1);
	s.breakTheme();
	assert.deepEqual(plain(s.chat.render(100)).length, 2);
	s.chat.render(100);
	assert.equal(s.stopped(), 1);
	assert.equal(s.notes.length, 1);
	assert.match(s.notes[0]!, /could not draw the transcript/);
});
