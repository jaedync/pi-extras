import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { COPIED, Sheet, type SheetSource } from "../lib/band/sheet.ts";
import { frameSubscribers } from "./support/fullscreen.ts";
import { quiet } from "./support/quiet-theme.ts";

const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));
// The quiet theme's muted text color and tool gray, as the scrollbar's thumb and a faint track.
const THUMB = "\x1b[48;2;138;136;130m \x1b[49m";
/** What the scrollbar shows at the end of a raw body row: thumb, track or nothing. */
const barOf = (raw: string) => (raw.includes(THUMB) ? "thumb" : /\x1b\[48;2;[\d;]+m \x1b\[49m\S*$/.test(raw) ? "track" : "none");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Options {
	lines?: number;
	head?: number;
	live?: boolean;
	typing?: boolean;
	foot?: string[];
	notice?: string;
}

function source(options: Options = {}): SheetSource & { picked: number[]; typed: string[] } {
	const picked: number[] = [];
	const typed: string[] = [];
	return {
		picked,
		typed,
		title: () => "bash · 3 commands",
		band: (width) => " $ a && b && c".padEnd(width, " "),
		head: (_width, rows) => Array.from({ length: Math.min(options.head ?? 2, rows) }, (_, index) => `head ${index + 1}`),
		pick: (line) => { picked.push(line); return true; },
		bodyLabel: () => "output",
		body: () => Array.from({ length: options.lines ?? 5 }, (_, index) => `line ${index + 1}`),
		...(options.foot ? { foot: () => options.foot! } : {}),
		copies: () => [{ label: "copy command", key: "c", text: () => "a && b && c" }, { label: "copy output", key: "o", text: () => "line 1" }],
		keys: () => [{ key: "esc", label: "close" }, { key: "↑↓", label: "scroll" }, { key: "c", label: "copy command" }],
		...(options.notice ? { notice: () => ({ text: options.notice!, color: "warning" }) } : {}),
		live: () => options.live ?? false,
		key: (data) => {
			if (!options.typing || data.length !== 1 || data < " ") return false;
			typed.push(data);
			return true;
		},
		typing: options.typing ?? false,
	};
}

function sheet(src: SheetSource, size: { rows?: number; columns?: number } = {}) {
	let closed = 0;
	const copied: string[] = [];
	const tui = { requestRender: () => undefined, terminal: { rows: size.rows ?? 20, columns: size.columns ?? 60 } };
	const view = new Sheet(tui, quiet(), src, () => { closed++; }, { copy: async (text) => { copied.push(text); } });
	const lines = () => plain(view.render(tui.terminal.columns));
	return { view, tui, lines, closed: () => closed, copied };
}

const mouse = (type: TuiMouseEvent["type"], x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent =>
	({ type, button: "left", x, y, screenX: x, screenY: y, width: 60, height: 20, shift: false, alt: false, ctrl: false, ...extra });

test("it fills the terminal: exactly its rows, every line exactly its width", () => {
	for (const [columns, rows] of [[60, 20], [100, 44], [40, 12], [24, 6]] as const) {
		const s = sheet(source({ lines: 200, head: 8 }), { rows, columns });
		const lines = s.lines();
		assert.equal(lines.length, rows, `${columns}x${rows} rows`);
		for (const line of lines) assert.equal(visibleWidth(line), columns, `${columns}x${rows}: ${JSON.stringify(line)}`);
	}
});

test("a title bar with the title, copy buttons and a close button, then the band and the head", () => {
	const lines = sheet(source()).lines();
	assert.match(lines[0]!, /^ bash · 3 commands +copy command {3}copy output {3}✕ $/);
	assert.match(lines[1]!, /^ \$ a && b && c/);
	assert.deepEqual(lines.slice(2, 4).map((line) => line.trim()), ["head 1", "head 2"]);
	assert.match(lines[4]!, /^─ output ─+ 5 lines ─$/);
	assert.deepEqual(lines.slice(5, 10).map((line) => line.trim()), ["line 1", "line 2", "line 3", "line 4", "line 5"]);
	assert.match(lines.at(-1)!, /^ esc close · ↑↓ scroll · c copy command +$/);
});

test("the body fills the rows left and follows the end; the rule says where it is", () => {
	const s = sheet(source({ lines: 100, live: true }), { rows: 20 });
	const lines = s.lines();
	// Title, band, two head lines, rule, footer: 14 rows of body.
	assert.equal(lines[18]!.trim(), "line 100");
	assert.match(lines[4]!, /87–100 of 100 · following ─$/);
});

test("the head is capped so the body keeps room", () => {
	const lines = sheet(source({ head: 30, lines: 50 }), { rows: 20 }).lines();
	const body = lines.filter((line) => /^ line \d+/.test(line));
	assert.ok(body.length >= 3, `body rows: ${body.length}`);
});

test("a scrollbar of colored spaces shows only when the body overflows, its thumb where the view is", () => {
	const fits = sheet(source({ lines: 5 }));
	assert.ok(fits.view.render(60).slice(5, 10).every((raw) => barOf(raw) === "none"), "no bar when it fits");
	const s = sheet(source({ lines: 100 }), { rows: 20 });
	const bar = () => s.view.render(60).slice(5, 19).map(barOf);
	assert.deepEqual(bar().slice(-3), ["track", "thumb", "thumb"], "at the end, the thumb is at the bottom");
	s.view.handleInput("g");
	assert.deepEqual(bar().slice(0, 3), ["thumb", "thumb", "track"], "at the top, the thumb is at the top");
	assert.ok(s.lines().slice(5, 19).every((line) => line.endsWith(" ")), "a copied row ends in a space, which the copy trims");
});

test("esc, q and ctrl+c close it once", () => {
	for (const key of ["\x1b", "q", "\x03"]) {
		const s = sheet(source());
		s.view.handleInput(key);
		s.view.handleInput(key);
		assert.equal(s.closed(), 1, JSON.stringify(key));
	}
});

test("when the view types, letters go to it: q, j, k, g and G are text, not shortcuts", () => {
	const src = source({ typing: true, lines: 100 });
	const s = sheet(src);
	s.lines();
	for (const key of ["q", "j", "k", "g", "G", "c"]) s.view.handleInput(key);
	assert.deepEqual(src.typed, ["q", "j", "k", "g", "G", "c"]);
	assert.equal(s.closed(), 0);
	assert.deepEqual(s.copied, []);
	s.view.handleInput("\x1b");
	assert.equal(s.closed(), 1, "Esc the view passes on still closes");
});

test("arrows, vi keys, page keys, space, home and end move the body; end resumes following", () => {
	const s = sheet(source({ lines: 100, live: true }), { rows: 20 });
	const first = () => Number(s.lines()[5]!.match(/line (\d+)/)![1]);
	s.lines();
	assert.equal(first(), 87);
	s.view.handleInput("\x1b[A");
	assert.equal(first(), 86);
	s.view.handleInput("k");
	assert.equal(first(), 85);
	s.view.handleInput("j");
	assert.equal(first(), 86);
	s.view.handleInput("\x1b[5~");
	assert.equal(first(), 72);
	s.view.handleInput("g");
	assert.equal(first(), 1);
	s.view.handleInput(" ");
	assert.equal(first(), 15);
	s.view.handleInput("\x1b[6~");
	assert.equal(first(), 29);
	assert.doesNotMatch(s.lines()[4]!, /following/);
	s.view.handleInput("G");
	assert.match(s.lines()[4]!, /following/);
	s.view.handleInput("\x1b[H");
	assert.equal(first(), 1);
	s.view.handleInput("\x1b[F");
	assert.equal(first(), 87);
});

test("c and o copy what their buttons copy, and the button says so", async () => {
	const s = sheet(source());
	s.view.handleInput("c");
	s.view.handleInput("o");
	await sleep(0);
	assert.deepEqual(s.copied, ["a && b && c", "line 1"]);
	assert.match(s.lines()[0]!, new RegExp(`${COPIED} {3,}${COPIED} {3,}✕ $`));
});

test("the wheel scrolls; a click on a copy button copies, on ✕ closes, on a head line picks it", async () => {
	const src = source({ lines: 100 });
	const s = sheet(src, { rows: 20 });
	const lines = s.lines();
	s.view.handleMouse(mouse("wheel", 10, 8, { wheelDelta: -3 }));
	assert.match(s.lines()[5]!, /line 84/);
	const copyAt = lines[0]!.indexOf("copy output");
	assert.deepEqual(s.view.handleMouse(mouse("click", copyAt + 2, 0)), { handled: true });
	await sleep(0);
	assert.deepEqual(s.copied, ["line 1"]);
	s.view.handleMouse(mouse("click", 5, 3));
	assert.deepEqual(src.picked, [1]);
	s.view.handleMouse(mouse("click", lines[0]!.indexOf("✕"), 0));
	assert.equal(s.closed(), 1);
});

test("a press on text is left to Pi, so text can be selected and copied", () => {
	const s = sheet(source({ lines: 100 }), { rows: 20 });
	s.lines();
	assert.equal(s.view.handleMouse(mouse("press", 5, 8)), undefined);
	assert.equal(s.view.handleMouse(mouse("click", 5, 8)), undefined);
});

test("dragging the scrollbar thumb scrolls the body", () => {
	const s = sheet(source({ lines: 100 }), { rows: 20 });
	s.lines();
	s.view.handleInput("g");
	s.lines();
	assert.deepEqual(s.view.handleMouse(mouse("press", 59, 5)), { capture: true });
	s.view.handleMouse(mouse("drag", 59, 18));
	s.view.handleMouse(mouse("release", 59, 18));
	assert.match(s.lines()[18]!, /line 100/);
	s.view.handleMouse(mouse("press", 59, 5));
	s.view.handleMouse(mouse("release", 59, 5));
	assert.doesNotMatch(s.lines()[18]!, /line 100/, "a press on the track jumps there");
});

test("a copy that fails says why in the footer", async () => {
	const tui = { requestRender: () => undefined, terminal: { rows: 20, columns: 60 } };
	const view = new Sheet(tui, quiet(), source(), () => undefined, { copy: async () => { throw new Error("no clipboard"); } });
	view.handleInput("c");
	await sleep(0);
	assert.match(plain(view.render(60)).at(-1)!, /Couldn't copy: no clipboard/);
});

test("a notice stands in for the keys, and a composer sits above the footer", () => {
	const lines = sheet(source({ notice: "Delivered.", foot: ["name ▸ ▏write to it"] })).lines();
	assert.match(lines.at(-1)!, /^ Delivered\. +$/);
	assert.match(lines.at(-2)!, /^ name ▸ ▏write to it +$/);
});

test("keys that don't fit are dropped whole from the end", () => {
	const lines = sheet(source(), { columns: 30 }).lines();
	assert.match(lines.at(-1)!, /^ esc close · ↑↓ scroll +$/);
});

test("a live view redraws every frame, and stops once closed", async () => {
	const before = frameSubscribers();
	const s = sheet(source({ live: true }));
	s.lines();
	assert.equal(frameSubscribers(), before + 1);
	s.view.handleInput("\x1b");
	assert.equal(frameSubscribers(), before);
});

test("taken off screen without being closed, it stops its timer", async () => {
	const before = frameSubscribers();
	const s = sheet(source({ live: true }));
	s.view.attach({ getBounds: () => undefined });
	s.lines();
	await sleep(250);
	assert.equal(frameSubscribers(), before);
	assert.equal(s.view.isOpen(), false);
});

test("a theme that can't paint still draws plain text", () => {
	const broken = { ...quiet(), fg: () => { throw new Error("no key"); }, bold: () => { throw new Error("no bold"); } };
	const tui = { requestRender: () => undefined, terminal: { rows: 12, columns: 40 } };
	const lines = plain(new Sheet(tui, broken, source(), () => undefined).render(40));
	assert.equal(lines.length, 12);
	assert.match(lines[0]!, /bash · 3 commands/);
});

test("head and composer lines too long for the width end in …, never cut mid-word", () => {
	const src = { ...source({ foot: ["a composer line much longer than the view is wide"] }), head: () => ["in /private/tmp/a/very/long/path · started 20:41:21"] };
	const lines = sheet(src, { columns: 30, rows: 12 }).lines();
	assert.equal(lines[2], " in /private/tmp/a/very/long… ", "a column of margin on each side");
	assert.equal(lines.at(-2), " a composer line much longer… ");
});
