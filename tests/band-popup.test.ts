import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Popup, type PopupSource } from "../lib/band/popup.ts";
import { quiet } from "./support/quiet-theme.ts";

function source(options: { steps?: number; lines?: number; live?: boolean } = {}): PopupSource & { selectedSeen: number[] } {
	const selectedSeen: number[] = [];
	return {
		selectedSeen,
		label: () => "bash · 3 commands",
		band: (_theme, width) => " $ a && b && c".padEnd(width),
		details: () => "in ~/proj · timeout 60s",
		head: (_theme, _width, selected) => Array.from({ length: options.steps ?? 0 }, (_, index) => `${index === selected ? ">" : " "} step ${index + 1}`),
		stepCount: () => options.steps ?? 0,
		firstStep: () => 1,
		outputLabel: (selected) => `output of ${selected + 1}`,
		output: (_theme, _width, selected) => {
			selectedSeen.push(selected);
			return Array.from({ length: options.lines ?? 5 }, (_, index) => `s${selected + 1} line ${index + 1}`);
		},
		live: () => options.live ?? false,
	};
}

function popup(src: PopupSource, rows = 30) {
	let renders = 0;
	let closed = 0;
	const tui = { requestRender: () => { renders++; }, terminal: { rows, columns: 80 } };
	const view = new Popup(tui, quiet(), src, () => { closed++; });
	return { view, lines: (width = 60) => view.render(width).map((line) => stripTerminalSequences(line)), renders: () => renders, closed: () => closed };
}

test("the popup frames the band, details, steps and output at the given width", () => {
	const p = popup(source({ steps: 3 }));
	const lines = p.lines();
	assert.ok(lines.every((line) => visibleWidth(line) === 60), "every line is exactly the popup width");
	assert.match(lines[0]!, /^╭─ bash · 3 commands ─+╮$/);
	assert.match(lines[1]!, /^│ \$ a && b && c/);
	assert.match(lines[2]!, /^│ in ~\/proj · timeout 60s +│$/);
	assert.deepEqual(lines.slice(3, 6).map((line) => line.slice(2, 12)), ["  step 1  ", "> step 2  ", "  step 3  "], "the focused step starts selected");
	assert.ok(lines.some((line) => line.includes("output of 2")));
	assert.ok(lines.some((line) => line.includes("s2 line 5")));
	assert.match(lines.at(-1)!, /^╰─+╯$/);
});

test("a step is picked by number, tab or a click on its line", () => {
	const p = popup(source({ steps: 3 }));
	p.lines();
	p.view.handleInput("3");
	assert.equal(p.view.step, 2);
	p.view.handleInput("\t");
	assert.equal(p.view.step, 0);
	p.view.handleInput("9");
	assert.equal(p.view.step, 0, "a number past the last step does nothing");
	p.lines();
	assert.deepEqual(p.view.handleMouse({ type: "click", button: "left", x: 5, y: 4 } as never), { handled: true });
	assert.equal(p.view.step, 1);
	assert.ok(p.lines().some((line) => line.includes("s2 line 1")));
});

test("the output scrolls, and follows the end until scrolled up", () => {
	const p = popup(source({ lines: 100 }), 20);
	let lines = p.lines();
	assert.ok(lines.some((line) => line.includes("s2 line 100")), "starts at the end");
	p.view.handleInput("g");
	lines = p.lines();
	assert.ok(lines.some((line) => line.includes("s2 line 1 ")));
	assert.ok(!lines.some((line) => line.includes("line 100")));
	p.view.handleMouse({ type: "wheel", wheelDelta: 3, x: 0, y: 0 } as never);
	assert.ok(p.lines().some((line) => line.includes("s2 line 4 ")));
	p.view.handleInput("G");
	assert.ok(p.lines().some((line) => line.includes("s2 line 100")));
});

test("escape or q closes it once", () => {
	const p = popup(source());
	p.view.handleInput("\x1b");
	p.view.handleInput("q");
	assert.equal(p.closed(), 1);
});

test("a live popup keeps redrawing and stops once closed", async () => {
	const p = popup(source({ live: true }));
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.ok(p.renders() >= 1);
	p.view.dispose();
	const after = p.renders();
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.equal(p.renders(), after);
});
