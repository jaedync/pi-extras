import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { closeOnOutsideClick } from "../lib/band/modal.ts";
import { Popup, type PopupSource } from "../lib/band/popup.ts";
import { bodyBackground, onBackground, panelBackground } from "../lib/band/surface.ts";
import { quiet } from "./support/quiet-theme.ts";

const BG = "\x1b[48;2;1;2;3m";

test("a background covers the whole width and comes back after a reset inside the line", () => {
	const [line] = onBackground(["a\x1b[0mb\x1b[49mc"], 6, BG);
	assert.equal(line, `${BG}a\x1b[0m${BG}b${BG}c   \x1b[49m`);
	assert.equal(stripTerminalSequences(line!).length, 6);
	assert.deepEqual(onBackground(["x"], 4, undefined), ["x"], "no background leaves the lines alone");
});

test("tool bodies use the theme's tool gray and popups a lighter panel", () => {
	const theme = quiet();
	assert.equal(bodyBackground(theme), theme.getBgAnsi("toolPendingBg"));
	const panel = /48;2;(\d+);(\d+);(\d+)m/.exec(panelBackground(theme) ?? "");
	const body = /48;2;(\d+);(\d+);(\d+)m/.exec(bodyBackground(theme) ?? "");
	assert.ok(panel && body);
	assert.ok(Number(panel[1]) > Number(body[1]) + 5, "the panel stands a step above the tool gray");
});

function mouse(type: TuiMouseEvent["type"], button: TuiMouseEvent["button"] = "left"): TuiMouseEvent {
	return { type, button, x: 1, y: 1, screenX: 1, screenY: 1, width: 80, height: 24 } as TuiMouseEvent;
}

/** Stands in for Pi's fullscreen TUI: a transcript dispatch that records what reached it. */
function fakeTui() {
	const reached: string[] = [];
	class Tui {
		requestRender() {}
		terminal = { rows: 30, columns: 80 };
		dispatchMouseToLayout(event: TuiMouseEvent) {
			reached.push(event.type);
			return undefined;
		}
	}
	return { tui: new Tui(), reached };
}

test("a left press outside closes the popup and never reaches the transcript", () => {
	const { tui, reached } = fakeTui();
	let closed = 0;
	const undo = closeOnOutsideClick(tui, () => { closed++; });
	const result = tui.dispatchMouseToLayout(mouse("press")) as { handled?: boolean; target?: { component: { handleMouse(): unknown } } } | undefined;
	assert.equal(closed, 1);
	assert.equal(result?.handled, true, "the press is taken, so the release and click that follow go to its target");
	assert.deepEqual(result?.target?.component.handleMouse(), { handled: true });
	tui.dispatchMouseToLayout(mouse("wheel", "none" as never));
	tui.dispatchMouseToLayout(mouse("press", "right"));
	assert.deepEqual(reached, ["wheel", "press"], "scrolling and other buttons still reach the transcript");
	undo();
	assert.equal(Object.prototype.hasOwnProperty.call(tui, "dispatchMouseToLayout"), false, "undo puts Pi's own dispatch back");
	tui.dispatchMouseToLayout(mouse("press"));
	assert.equal(closed, 1);
});

test("a TUI without a transcript dispatch (Pi's classic view) is left alone", () => {
	const tui = { requestRender() {}, terminal: { rows: 30, columns: 80 } };
	closeOnOutsideClick(tui, () => assert.fail("never called"))();
	assert.deepEqual(Object.keys(tui), ["requestRender", "terminal"]);
});

const source: PopupSource = {
	label: () => "bash",
	band: (_theme, width) => " $ ls".padEnd(width),
	details: () => "in ~/proj",
	head: () => [],
	stepCount: () => 0,
	firstStep: () => 0,
	outputLabel: () => "output",
	output: () => ["a", "b"],
	live: () => false,
};

test("the popup sits on its panel and closes on a click outside, once", () => {
	const { tui, reached } = fakeTui();
	const theme = quiet();
	let closed = 0;
	const popup = new Popup(tui, theme, source, () => { closed++; });
	const panel = panelBackground(theme)!;
	assert.ok(popup.render(40).every((line) => line.startsWith(panel)));
	tui.dispatchMouseToLayout(mouse("press"));
	assert.equal(closed, 1);
	popup.handleInput("\x1b");
	assert.equal(closed, 1, "closing again does nothing");
	tui.dispatchMouseToLayout(mouse("press"));
	assert.deepEqual(reached, ["press"], "once closed, clicks reach the transcript again");
});
