import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ansi256ToRgb, bgSgr, mix, parseAnsiColor, rgbTo256 } from "../lib/band/color.ts";
import { AnimationClock } from "../lib/band/clock.ts";
import { bandBackground, easedFill, formatTime, renderBand, type BandPhase, type Seg } from "../lib/band/band.ts";
import { paletteFrom, type BandTheme } from "../lib/band/palette.ts";
import { quiet } from "./support/quiet-theme.ts";

test("theme colors are read back from truecolor and 256-color escapes", () => {
	assert.deepEqual(parseAnsiColor("\x1b[38;2;143;180;200m"), [143, 180, 200]);
	assert.deepEqual(parseAnsiColor("\x1b[48;2;35;35;38m"), [35, 35, 38]);
	assert.deepEqual(parseAnsiColor("\x1b[38;5;196m"), [255, 0, 0]);
	assert.deepEqual(parseAnsiColor("\x1b[48;5;236m"), ansi256ToRgb(236));
	assert.equal(parseAnsiColor("\x1b[39m"), undefined);
	assert.equal(parseAnsiColor(""), undefined);
});

test("colors mix linearly and map to the nearest 256-color entry", () => {
	assert.deepEqual(mix([0, 0, 0], [200, 100, 50], 0.5), [100, 50, 25]);
	assert.deepEqual(mix([10, 10, 10], [20, 20, 20], 2), [20, 20, 20]);
	assert.equal(rgbTo256([255, 0, 0]), 196);
	assert.equal(rgbTo256([128, 128, 128]), 244);
	assert.equal(bgSgr([1, 2, 3], "truecolor"), "\x1b[48;2;1;2;3m");
	assert.equal(bgSgr([255, 0, 0], "256color"), "\x1b[48;5;196m");
});

test("times read as milliseconds, tenths of a second, then minutes", () => {
	assert.equal(formatTime(0), "1ms");
	assert.equal(formatTime(40), "40ms");
	assert.equal(formatTime(999), "999ms");
	assert.equal(formatTime(8_640), "8.6s");
	assert.equal(formatTime(59_960), "59.9s");
	assert.equal(formatTime(134_000), "2m 14s");
	assert.equal(formatTime(3_725_000), "62m 05s");
});

test("eased fill moves fast early and reaches the end with the timeout", () => {
	assert.equal(easedFill(0), 0);
	assert.equal(easedFill(1), 1);
	assert.ok(Math.abs(easedFill(5 / 300) - 0.12) < 0.01);
	assert.ok(Math.abs(easedFill(30 / 300) - 0.4) < 0.01);
	assert.ok(easedFill(0.5) > 0.8);
	assert.equal(easedFill(2), 1);
});

test("a palette is built from the theme's tool backgrounds and status colors", () => {
	const palette = paletteFrom(quiet());
	assert.ok(palette);
	assert.deepEqual(palette.base, [0x23, 0x23, 0x26]);
	// Finished states are tinted further toward their hue than the theme's own backgrounds.
	assert.ok(palette.ok[1] > 0x28);
	assert.ok(palette.fail[0] > 0x2b);
	assert.ok(palette.timeout[0] - palette.timeout[2] > palette.base[0] - palette.base[2] + 10);
});

test("a theme whose tool background is the terminal default has no palette", () => {
	const theme = { ...quiet(), getBgAnsi: () => "\x1b[49m" };
	assert.equal(paletteFrom(theme), undefined);
});

const segs: Seg[] = [{ text: "$", color: "accent", bold: true }, { text: " npm run build --workspace packages/app", color: "text" }];

test("the rail is drawn in full and the title is cut to fit", () => {
	const palette = paletteFrom(quiet())!;
	const phase: BandPhase = { kind: "done", outcome: "fail", sinceMs: 5_000 };
	const line = renderBand(quiet(), palette, { width: 40, phase, segs, rail: [{ text: "exit 1", color: "error" }, { text: "  ", color: "dim" }, { text: "4.2s", color: "muted" }], clockMs: 0 });
	const plain = stripTerminalSequences(line);
	assert.equal(visibleWidth(plain), 40);
	assert.equal(plain, " $ npm run build --works…  exit 1  4.2s ");
});

test("a band fills its whole width with a background, even when the title is short", () => {
	const palette = paletteFrom(quiet())!;
	const line = renderBand(quiet(), palette, { width: 20, phase: { kind: "done", outcome: "ok", sinceMs: 5_000 }, segs: [{ text: "ls", color: "toolTitle", bold: true }], rail: [], clockMs: 0 });
	assert.equal(stripTerminalSequences(line), " ls" + " ".repeat(17));
	assert.match(line, /\x1b\[48;2;/);
	assert.match(line, /\x1b\[1m/);
	assert.ok(line.endsWith("\x1b[0m"));
});

test("wide characters are never split by the cut", () => {
	const palette = paletteFrom(quiet())!;
	const line = renderBand(quiet(), palette, { width: 12, phase: { kind: "writing" }, segs: [{ text: "echo 日本語日本語", color: "text" }], rail: [], clockMs: 0 });
	const plain = stripTerminalSequences(line);
	assert.equal(visibleWidth(plain), 12);
	assert.ok(plain.includes("…"));
});

test("links wrap their text in OSC 8 without taking a column", () => {
	const palette = paletteFrom(quiet())!;
	const line = renderBand(quiet(), palette, { width: 30, phase: { kind: "writing" }, segs: [{ text: "read", color: "toolTitle" }, { text: " a.ts", color: "accent", link: "file:///w/a.ts" }], rail: [], clockMs: 0 });
	assert.match(line, /\x1b\]8;;file:\/\/\/w\/a\.ts\x1b\\ a\.ts\x1b\]8;;\x1b\\/);
	assert.equal(visibleWidth(stripTerminalSequences(line)), 30);
});

test("without a palette the band falls back to the theme's own background", () => {
	const calls: string[] = [];
	const theme: BandTheme = { ...quiet(), bg: (key, text) => { calls.push(key); return `[${text}]`; } };
	const line = renderBand(theme, undefined, { width: 10, phase: { kind: "done", outcome: "fail", sinceMs: 0 }, segs: [{ text: "ls", color: "text" }], rail: [], clockMs: 0 });
	assert.deepEqual(calls, ["toolErrorBg"]);
	assert.equal(stripTerminalSequences(line), "[ ls       ]");
});

test("progress fills from the left, eased, and warms toward the warning color near the timeout", () => {
	const palette = paletteFrom(quiet())!;
	const early = bandBackground(palette, { kind: "running", elapsedMs: 5_000, timeoutMs: 300_000 }, 100, 0, "full");
	assert.notDeepEqual(early(5), early(60));
	const edge = Array.from({ length: 100 }, (_, x) => early(x)).findIndex((color, x, all) => x > 0 && color.join() === all[99]!.join());
	assert.ok(edge > 10 && edge < 22, `edge at ${edge}`);
	const late = bandBackground(palette, { kind: "running", elapsedMs: 280_000, timeoutMs: 300_000 }, 100, 0, "full");
	// Red and green gain on blue as the fill warms toward amber.
	assert.ok(late(5)[0] - late(5)[2] > early(5)[0] - early(5)[2]);
});

test("without a timeout a bright sweep crosses the band over time", () => {
	const palette = paletteFrom(quiet())!;
	const at = (clockMs: number) => bandBackground(palette, { kind: "running", elapsedMs: 1_000 }, 80, clockMs, "full");
	const brightest = (bg: (x: number) => readonly number[]) => Array.from({ length: 80 }, (_, x) => x).reduce((best, x) => (bg(x)[2]! > bg(best)[2]! ? x : best), 0);
	assert.ok(brightest(at(900)) > brightest(at(300)));
});

test("reduced motion holds a steady tint while running and skips the finish flash", () => {
	const palette = paletteFrom(quiet())!;
	const sweep = bandBackground(palette, { kind: "running", elapsedMs: 1_000 }, 80, 700, "reduced");
	assert.deepEqual(sweep(3), sweep(70));
	const flash = bandBackground(palette, { kind: "done", outcome: "ok", sinceMs: 10 }, 80, 0, "reduced");
	assert.deepEqual(flash(0), palette.ok);
});

test("a finished band flashes brighter, then settles on its status color", () => {
	const palette = paletteFrom(quiet())!;
	const fresh = bandBackground(palette, { kind: "done", outcome: "ok", sinceMs: 50 }, 80, 0, "full");
	const settled = bandBackground(palette, { kind: "done", outcome: "ok", sinceMs: 2_000 }, 80, 0, "full");
	assert.ok(fresh(0)[1]! > settled(0)[1]!);
	assert.deepEqual(settled(0), palette.ok);
	assert.deepEqual(bandBackground(palette, { kind: "done", outcome: "timeout", sinceMs: 5_000 }, 80, 0, "full")(0), palette.timeout);
	assert.deepEqual(bandBackground(palette, { kind: "done", outcome: "aborted", sinceMs: 5_000 }, 80, 0, "full")(0), palette.aborted);
});

test("the animation clock ticks only while something is registered", () => {
	const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
	const clock = new AnimationClock({
		setInterval: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
		clearInterval: (timer) => { (timer as { cleared: boolean }).cleared = true; },
	});
	let ticks = 0;
	const off = clock.add(() => { ticks++; });
	assert.equal(timers.length, 1);
	assert.equal(timers[0]!.ms, 100);
	timers[0]!.fn();
	assert.equal(ticks, 1);
	clock.add(() => { ticks += 10; });
	assert.equal(timers.length, 1, "one timer serves every row");
	timers[0]!.fn();
	assert.equal(ticks, 12);
	off();
	clock.setReduced(true);
	assert.equal(timers.at(-1)!.ms, 1_000);
	clock.stop();
	assert.ok(timers.every((timer) => timer.cleared));
});
