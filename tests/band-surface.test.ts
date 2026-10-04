import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Sheet, type SheetSource } from "../lib/band/sheet.ts";
import { bodyBackground, onBackground, panelBackground } from "../lib/band/surface.ts";
import { quiet } from "./support/quiet-theme.ts";

const BG = "\x1b[48;2;1;2;3m";

test("a background covers the whole width and comes back after a reset inside the line", () => {
	const [line] = onBackground(["a\x1b[0mb\x1b[49mc"], 6, BG);
	assert.equal(line, `${BG}a\x1b[0m${BG}b${BG}c   \x1b[49m`);
	assert.equal(stripTerminalSequences(line!).length, 6);
	assert.deepEqual(onBackground(["x"], 4, undefined), ["x"], "no background leaves the lines alone");
});

test("a background comes back after any code that clears it, not after colors that merely contain a 0 or 49", () => {
	const [mixed] = onBackground(["a\x1b[0;3mb\x1b[39;49mc\x1b[mdone"], 10, BG);
	assert.equal(mixed, `${BG}a\x1b[0;3m${BG}b\x1b[39;49m${BG}c\x1b[m${BG}done   \x1b[49m`);
	const colors = "\x1b[38;2;0;49;0mx\x1b[48;5;0my\x1b[38;5;49mz";
	assert.equal(onBackground([colors], 3, BG)[0], `${BG}${colors}\x1b[49m`, "color values are not resets");
});

test("a line wider than its row is cut to fit, with or without a background", () => {
	// Pi stops drawing, and throws, on a line wider than the terminal.
	const wide = "     indented text past the edge";
	for (let width = 1; width <= 12; width++) {
		for (const bg of [BG, undefined]) {
			const [line] = onBackground([wide], width, bg);
			assert.ok(visibleWidth(line!) <= width, `width ${width}, ${bg ? "with" : "without"} a background`);
		}
	}
	assert.equal(stripTerminalSequences(onBackground([wide], 8, BG)[0]!), "     in…");
});

test("tool bodies use the theme's tool gray and popups a lighter panel", () => {
	const theme = quiet();
	assert.equal(bodyBackground(theme), theme.getBgAnsi("toolPendingBg"));
	const panel = /48;2;(\d+);(\d+);(\d+)m/.exec(panelBackground(theme) ?? "");
	const body = /48;2;(\d+);(\d+);(\d+)m/.exec(bodyBackground(theme) ?? "");
	assert.ok(panel && body);
	assert.ok(Number(panel[1]) > Number(body[1]) + 5, "the panel stands a step above the tool gray");
});

const source: SheetSource = {
	title: () => "bash",
	band: (width) => " $ ls".padEnd(width),
	head: () => ["in ~/proj"],
	bodyLabel: () => "output",
	body: () => ["a", "b"],
	foot: () => ["composer"],
	keys: () => [{ key: "esc", label: "close" }],
	live: () => false,
};

test("a sheet's title bar and footer sit on the panel, its head and composer on the tool gray, its body on the terminal", () => {
	const theme = quiet();
	const lines = new Sheet({ requestRender() {}, terminal: { rows: 12, columns: 40 } }, theme, source, () => undefined).render(40);
	const panel = panelBackground(theme)!;
	const gray = bodyBackground(theme)!;
	assert.ok(lines[0]!.startsWith(panel), "title bar");
	assert.ok(lines.at(-1)!.startsWith(panel), "footer");
	assert.ok(lines[2]!.startsWith(gray), "head");
	assert.ok(lines.at(-2)!.startsWith(gray), "composer");
	assert.ok(!lines[4]!.includes("\x1b[48;"), "body rows have no background of their own");
	assert.equal(stripTerminalSequences(lines[4]!).trim(), "a");
});
