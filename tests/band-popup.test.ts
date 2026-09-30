import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { PopupView, type PopupSource } from "../lib/band/popup.ts";
import { Sheet } from "../lib/band/sheet.ts";
import { quiet } from "./support/quiet-theme.ts";

interface Options {
	steps?: number;
	lines?: number;
	live?: boolean;
	command?: string;
	head?: string[];
	details?: string;
}

function source(options: Options = {}): PopupSource {
	const command = options.command ?? "a && b && c";
	return {
		label: () => "bash · 3 commands",
		band: (_theme, width) => ` $ ${command}`.slice(0, width - 1).padEnd(width),
		details: () => options.details ?? "in ~/proj · timeout 60s",
		head: (_theme, _width, selected) => options.head ?? (options.steps
			? Array.from({ length: options.steps }, (_, index) => `${index === selected ? ">" : " "} step ${index + 1}`)
			: [`$ ${command}`]),
		stepCount: () => options.steps ?? 0,
		firstStep: () => (options.steps ? 1 : 0),
		outputLabel: (selected) => `output of ${selected + 1}`,
		output: (_theme, width, selected) => Array.from({ length: options.lines ?? 5 }, (_, index) => `\x1b[31ms${selected + 1} line ${index + 1}\x1b[39m`.slice(0, width + 10)),
		live: () => options.live ?? false,
	};
}

function popup(src: PopupSource, rows = 30, columns = 80) {
	const copied: string[] = [];
	let closed = 0;
	const tui = { requestRender: () => undefined, terminal: { rows, columns } };
	const view = new PopupView(quiet(), src);
	const sheet = new Sheet(tui, quiet(), view, () => { closed++; }, { copy: async (text) => { copied.push(text); } });
	const lines = () => sheet.render(columns).map((line) => stripTerminalSequences(line));
	const click = (x: number, y: number) => sheet.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: columns, height: rows, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
	return { view, sheet, lines, click, copied, closed: () => closed };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("it covers the terminal: title bar, band, details, steps, then the selected step's output", () => {
	const p = popup(source({ steps: 3 }));
	const lines = p.lines();
	assert.equal(lines.length, 30);
	assert.ok(lines.every((line) => visibleWidth(line) === 80));
	assert.match(lines[0]!, /^ bash · 3 commands .*copy output {3}✕ $/);
	assert.match(lines[1]!, /^ \$ a && b && c/);
	assert.equal(lines[2]!.trim(), "in ~/proj · timeout 60s");
	assert.deepEqual(lines.slice(3, 6).map((line) => line.trim()), ["step 1", "> step 2", "step 3"], "the focused step starts selected");
	assert.match(lines[6]!, /^─ output of 2 ─+ 5 lines ─$/);
	assert.equal(lines[7]!.trim(), "s2 line 1");
	assert.match(lines.at(-1)!, /^ esc close · 1–3 step · ↑↓ scroll · o copy output · g\/G top\/end/);
});

test("a step is picked by number, tab, the arrows or a click on its line", () => {
	const p = popup(source({ steps: 3 }));
	p.lines();
	p.sheet.handleInput("3");
	assert.equal(p.view.step, 2);
	p.sheet.handleInput("\t");
	assert.equal(p.view.step, 0);
	p.sheet.handleInput("\x1b[Z");
	assert.equal(p.view.step, 2);
	p.sheet.handleInput("\x1b[C");
	assert.equal(p.view.step, 0);
	p.sheet.handleInput("\x1b[D");
	assert.equal(p.view.step, 2);
	p.sheet.handleInput("9");
	assert.equal(p.view.step, 2, "a number past the last step does nothing");
	assert.deepEqual(p.click(10, 4), { handled: true });
	assert.equal(p.view.step, 1, "row 4 is the second step, under the details line");
	assert.equal(p.click(10, 2), undefined, "the details line is not a step");
	assert.match(p.lines()[6]!, /output of 2/);
});

test("a new step's output shows its end, even after scrolling the last one", () => {
	const p = popup(source({ steps: 2, lines: 100 }), 20);
	p.lines();
	p.sheet.handleInput("g");
	assert.equal(p.lines()[6]!.replace(/[│┃█]$/, "").trim(), "s2 line 1");
	p.sheet.handleInput("1");
	assert.match(p.lines().at(-2)!, /s1 line 100/);
});

test("a command the band shows whole is not repeated under it; one it cuts is shown in full", () => {
	const short = popup(source()).lines();
	assert.equal(short[2]!.trim(), "in ~/proj · timeout 60s");
	assert.match(short[3]!, /^─ output of 1/, "no repeat of the command");
	const long = "x".repeat(120);
	const cut = popup(source({ command: long, head: [`$ ${long.slice(0, 70)}`, long.slice(70)] })).lines();
	assert.match(cut[3]!, /^ \$ x{70}/);
	assert.match(cut[4]!, /^ x{50}/);
});

test("a head taller than its room says how much it hid", () => {
	const lines = popup(source({ head: Array.from({ length: 40 }, (_, index) => `cmd ${index}`), details: "" }), 24).lines();
	assert.ok(lines.some((line) => /… \d+ more lines/.test(line)));
	assert.ok(lines.filter((line) => / s1 line/.test(line)).length >= 3, "the output keeps its rows");
});

test("copy output copies the selected step's text, unstyled and unwrapped", async () => {
	const p = popup(source({ steps: 2, lines: 2 }));
	p.lines();
	p.sheet.handleInput("o");
	await sleep(0);
	assert.deepEqual(p.copied, ["s2 line 1\ns2 line 2"]);
});

test("optional step identity follows reorders, preserves the body key, and falls back to the first view when pruned", () => {
	let keys = ["source", "result", "call:A", "call:C"];
	let reads = 0;
	const src = { ...source(), firstStep: () => 0, stepCount: () => keys.length, stepKeys: () => { reads++; return keys; } };
	const view = new PopupView(quiet(), src);
	view.key("4");
	reads = 0;
	assert.equal(view.step, 3);
	assert.equal(reads, 1, "the selected getter requests one bounded key list, not a key callback per index");
	reads = 0;
	assert.equal(view.bodyKey(), "call:C");
	assert.equal(reads, 1);
	keys = ["source", "result", "call:A", "call:B", "call:C"];
	assert.equal(view.step, 4);
	assert.equal(view.bodyKey(), "call:C");
	keys = ["source", "result", "call:A", "call:B"];
	assert.equal(view.step, 0);
	assert.equal(view.bodyKey(), "source");
	assert.ok(view.key("\t"));
	assert.equal(view.step, 1);
	assert.equal(view.bodyKey(), "result");
	assert.ok(view.pick(3));
	assert.equal(view.step, 2);
	assert.equal(view.bodyKey(), "call:A");
});

test("sources without step identities keep their numeric selection, body keys and native mouse/key navigation", () => {
	const p = popup(source({ steps: 3 }));
	assert.equal(p.view.bodyKey(), 1);
	p.lines(); p.sheet.handleInput("3");
	assert.equal(p.view.bodyKey(), 2);
	p.sheet.handleInput("\t");
	assert.equal(p.view.bodyKey(), 0);
	assert.deepEqual(p.click(10, 4), { handled: true });
	assert.equal(p.view.bodyKey(), 1);
});

test("a source can offer its own copies", async () => {
	const src = { ...source(), copies: () => [{ label: "copy command", key: "c", text: () => "a && b && c" }] };
	const p = popup(src);
	assert.match(p.lines()[0]!, /copy command {3}✕ $/);
	p.sheet.handleInput("c");
	await sleep(0);
	assert.deepEqual(p.copied, ["a && b && c"]);
});

test("no output says so, and whether more may come", () => {
	const empty = (live: boolean) => popup({ ...source({ live }), output: () => [] }).lines().find((line) => /no output/.test(line))!.trim();
	assert.equal(empty(true), "(no output yet)");
	assert.equal(empty(false), "(no output)");
});
