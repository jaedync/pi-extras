import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	MAX_CHUNK_MS,
	PULSE_DEPTH,
	PULSE_PERIOD_MS,
	blendAnsi,
	bottomBorderIndex,
	chunkGlyph,
	extractScrollIndicator,
	isClipped,
	levelFromPcm,
	meter,
	modelLabel,
	overlayVoiceRow,
	renderIndicator,
	renderStatus,
	renderVoiceBorder,
	type BorderPaint,
	type IndicatorState,
	type Palette,
} from "../lib/voice/indicator.ts";

const tag: Palette = {
	accent: (s) => `<a>${s}</a>`,
	dim: (s) => `<d>${s}</d>`,
	warn: (s) => `<w>${s}</w>`,
	error: (s) => `<e>${s}</e>`,
	muted: (s) => `<m>${s}</m>`,
};
const plain: Palette = { accent: (s) => s, dim: (s) => s, warn: (s) => s, error: (s) => s, muted: (s) => s };

const base: IndicatorState = {
	phase: "recording",
	startedAt: 0,
	levels: [],
	speaking: false,
	chunks: [],
	queuedMs: 0,
};

test("chunk glyphs never blink: the same state always draws the same", () => {
	for (const state of ["filling", "queued", "decoding", "done"] as const) {
		const glyphs = new Set([0, 60, 120, 700, 1400, 3000].map((now) => chunkGlyph({ state, openedAt: 0 }, now, tag)));
		assert.equal(glyphs.size, 1, state);
	}
});

test("chunk glyphs: done solid, decoding marked, queued dim hollow", () => {
	assert.equal(chunkGlyph({ state: "done", openedAt: 0 }, 0, tag), "<a>◆</a>");
	assert.equal(chunkGlyph({ state: "decoding", openedAt: 0 }, 0, tag), "<a>◈</a>");
	assert.equal(chunkGlyph({ state: "queued", openedAt: 0 }, 0, tag), "<d>◇</d>");
});

test("a filling chunk warms up as it nears the forced cut", () => {
	const at = (fraction: number) => chunkGlyph({ state: "filling", openedAt: 0 }, MAX_CHUNK_MS * fraction, tag);
	assert.equal(at(0), "<d>◇</d>");
	assert.equal(at(0.5), "<a>◇</a>");
	assert.equal(at(0.9), "<w>◇</w>");
	assert.equal(at(2), "<w>◇</w>");
});

test("the meter grows from the middle, two samples per cell", () => {
	const cells = (levels: number[]) => [...stripVTControlCharacters(meter(levels, plain))];
	assert.equal(cells([]).length, 14);
	assert.deepEqual(cells([0, 0, 0.3, 0.3, 1, 1]).slice(-3), ["⠀", "⠶", "⣿"]);
	assert.equal(cells([0.3, 1]).at(-1), "⢾", "left sample middle, right sample full");
	assert.equal(cells([1, 0]).at(-1), "⡇");
	assert.equal(cells(Array(100).fill(1)).length, 14, "old samples scroll off");
});

test("meter cells are colored by loudness, red at the top", () => {
	const last = (levels: number[]) => meter(levels, tag).match(/<(\w)>[^<]*<\/\1>$/)![1];
	assert.equal(last([0.05, 0.05]), "d");
	assert.equal(last([0.3, 0.6]), "a");
	assert.equal(last([0.5, 0.85]), "w");
	assert.equal(last([0.97, 0.2]), "e", "the louder sample of the pair decides");
});

test("the dot is red while recording and dim once stopped", () => {
	const dot = (state: IndicatorState) => renderIndicator(state, 0, 80, tag);
	assert.match(dot(base), /<e>●<\/e>/);
	assert.match(dot({ ...base, speaking: true }), /<e>●<\/e>/);
	assert.match(dot({ ...base, phase: "connecting" }), /<e>●<\/e>/);
	assert.match(dot({ ...base, phase: "finishing", stoppedAt: 0 }), /<d>○<\/d>/);
});

test("the recording dot breathes gently from full red to a softer red and back", () => {
	let amount: number | undefined;
	const pulsing: Palette = { ...tag, pulse: (s, a) => { amount = a; return `<p>${s}</p>`; } };
	const at = (now: number, state: IndicatorState = base) => {
		amount = undefined;
		const line = renderIndicator(state, now, 80, pulsing);
		return { amount, line };
	};
	assert.equal(at(0).amount, 0, "starts at full red");
	assert.match(at(0).line, /<p>●<\/p>/);
	assert.ok(Math.abs(at(PULSE_PERIOD_MS / 2).amount! - PULSE_DEPTH) < 1e-9, "softest halfway through");
	assert.ok(at(PULSE_PERIOD_MS).amount! < 1e-9, "full red again");
	assert.ok(PULSE_DEPTH <= 0.5 && PULSE_PERIOD_MS >= 2000, "gentle: shallow and slow");
	for (let t = 0; t < PULSE_PERIOD_MS; t += 100) {
		assert.ok(Math.abs(at(t + 100).amount! - at(t).amount!) <= 0.06, `no jump between frames at ${t}ms`);
	}
	const stopped = at(1200, { ...base, phase: "finishing", stoppedAt: 1000 });
	assert.equal(stopped.amount, undefined);
	assert.match(stopped.line, /<d>○<\/d>/);
});

test("blendAnsi mixes truecolor theme colors and declines anything else", () => {
	const red = "\x1b[38;2;200;0;0m";
	const gray = "\x1b[38;2;100;100;100m";
	assert.equal(blendAnsi(red, gray, 0), red);
	assert.equal(blendAnsi(red, gray, 0.5), "\x1b[38;2;150;50;50m");
	assert.equal(blendAnsi("\x1b[38;5;196m", gray, 0.5), undefined, "256-color themes stay steady");
	assert.equal(blendAnsi(red, "\x1b[39m", 0.5), undefined);
});

test("the clock is muted", () => {
	assert.match(renderIndicator({ ...base, startedAt: 0 }, 3000, 80, tag), /<m>0:03<\/m>/);
});

test("recording line shows clock, meter and chunks", () => {
	const line = stripVTControlCharacters(renderIndicator({
		...base,
		speaking: true,
		levels: [0, 0.5, 1],
		chunks: [{ state: "done", openedAt: 0 }, { state: "filling", openedAt: 11_000 }],
		backend: "mlx",
	}, 12_400, 80, plain));
	assert.match(line, /● 0:12/);
	assert.match(line, /⠶⣿|⢾⣿|⣿/);
	assert.match(line, /◆/);
	assert.match(line, /mlx/);
});

test("before the daemon connects, buffered audio shows as a queue", () => {
	const line = renderIndicator({ ...base, phase: "connecting", queuedMs: 2400 }, 2400, 80, plain);
	assert.match(line, /2\.4s queued/);
});

test("loading is labelled; a quick finish and inserted stay quiet so the typed text speaks for itself", () => {
	assert.match(renderIndicator({ ...base, phase: "loading", backend: "mlx" }, 1000, 80, plain), /loading/);
	assert.doesNotMatch(renderIndicator({ ...base, phase: "finishing", stoppedAt: 5000 }, 5200, 80, plain), /transcribing|⠋|⠙/);
	assert.doesNotMatch(renderIndicator({ ...base, phase: "inserted", stoppedAt: 5000 }, 5200, 80, plain), /inserted|✓/);
	assert.match(renderIndicator({ ...base, phase: "error", message: "no mic" }, 0, 80, plain), /no mic/);
});

test("a wait after stop says what it is waiting for and that esc cancels", () => {
	const stopped: IndicatorState = { ...base, phase: "finishing", stoppedAt: 5000 };
	const at = (state: IndicatorState, now: number) => renderIndicator(state, now, 120, plain);
	assert.doesNotMatch(at({ ...stopped, loadingModel: true }, 5900), /loading|esc/, "quiet for the first second");
	assert.match(at({ ...stopped, loadingModel: true }, 6000), /loading the speech model {2}esc cancels/);
	assert.match(at(stopped, 6000), /transcribing {2}esc cancels/);
	assert.match(at({ ...stopped, queuedMs: 800 }, 6000), /starting voice {2}esc cancels/);
	const noted = at({ ...stopped, loadingModel: true, message: "recording stopped at 5 minutes" }, 6000);
	assert.match(noted, /loading the speech model {2}recording stopped at 5 minutes {2}esc cancels/);
	const border = renderVoiceBorder({ ...stopped, loadingModel: true }, undefined, 6000, 120, plain, plainPaint);
	assert.match(border, /loading the speech model {2}esc cancels/);
});

test("clock freezes when recording stops", () => {
	const line = renderIndicator({ ...base, phase: "finishing", stoppedAt: 3000 }, 9000, 80, plain);
	assert.match(line, /0:03/);
});

test("long dictations collapse old chunks into a count", () => {
	const chunks = Array.from({ length: 30 }, () => ({ state: "done" as const, openedAt: 0 }));
	const line = renderIndicator({ ...base, chunks }, 0, 120, plain);
	assert.match(line, /\+18/);
});

test("line never exceeds the given width", () => {
	const line = renderIndicator({ ...base, levels: Array(40).fill(1), backend: "cpu-large" }, 0, 20, tag);
	assert.ok(stripVTControlCharacters(line.replace(/<\/?[adwem]>/g, "")).length <= 20);
});

test("status line composes the indicator with setup progress", () => {
	assert.equal(renderStatus(undefined, undefined, 0, plain), undefined);
	assert.equal(stripVTControlCharacters(renderStatus(undefined, "downloading mlx 40%", 0, plain)!), "downloading mlx 40%");
	const both = stripVTControlCharacters(renderStatus({ ...base, speaking: true }, "downloading mlx 40%", 12_400, plain)!);
	assert.match(both, /● 0:12/);
	assert.match(both, /downloading mlx 40%/);
});

const plainPaint: BorderPaint = { border: (text) => text, measure: visibleWidth, truncate: (text, max) => truncateToWidth(text, max, "") };

test("the model label names the backend and the model", () => {
	assert.equal(modelLabel({ ...base, backend: "mlx", model: "parakeet 0.6b-v3" }, plain), "mlx parakeet 0.6b-v3");
	assert.equal(modelLabel({ ...base, backend: "cpu" }, plain), "cpu");
	assert.equal(modelLabel(base, plain), "");
});

test("voice border draws the indicator between rails with the model right justified", () => {
	const line = renderVoiceBorder(
		{ ...base, speaking: true, backend: "mlx", model: "parakeet 0.6b-v3", chunks: [{ state: "done", openedAt: 0 }] },
		undefined,
		12_400,
		80,
		plain,
		plainPaint,
	);
	const text = stripTerminalSequences(line);
	assert.match(text, /^── ● 0:12/);
	assert.match(text, /◆/);
	assert.match(text, / mlx parakeet 0\.6b-v3 ──$/, "model sits at the right, padded like the left");
	assert.equal(visibleWidth(line), 80);
});

test("narrow borders drop the meter, then the model, then clip", () => {
	const state = { ...base, speaking: true, levels: [0.5, 1], chunks: [{ state: "done" as const, openedAt: 0 }], backend: "mlx" };
	const wide = stripTerminalSequences(renderVoiceBorder(state, undefined, 0, 80, plain, plainPaint));
	const mid = stripTerminalSequences(renderVoiceBorder(state, undefined, 0, 24, plain, plainPaint));
	const tiny = stripTerminalSequences(renderVoiceBorder(state, undefined, 0, 14, plain, plainPaint));
	const clipped = renderVoiceBorder(state, undefined, 0, 6, plain, plainPaint);
	assert.match(wide, /⣿|⠶|⢾/);
	assert.match(wide, /mlx ──$/, "model kept on a wide line");
	assert.ok(!/[\u2801-\u28ff]/.test(mid) && !mid.includes("⠀"), "meter dropped first");
	assert.match(mid, /● 0:00/, "clock kept");
	assert.match(mid, /◆/, "chunks kept");
	assert.match(mid, /mlx ──$/, "model still kept");
	assert.ok(!tiny.includes("mlx"), "model dropped before the clock");
	assert.match(tiny, /● 0:00/);
	assert.equal(visibleWidth(clipped), 6);
});

test("setup progress rides along on the border", () => {
	const line = renderVoiceBorder({ ...base, speaking: true }, "downloading mlx 40%", 0, 80, plain, plainPaint);
	assert.match(stripTerminalSequences(line), /downloading mlx 40%/);
});

test("the hidden-lines label survives at the right edge", () => {
	const line = renderVoiceBorder({ ...base, speaking: true }, undefined, 0, 60, plain, plainPaint, "↓ 3 more");
	const text = stripTerminalSequences(line);
	assert.match(text, /↓ 3 more ──$/);
	assert.equal(visibleWidth(line), 60);
});

test("scroll indicator extraction", () => {
	assert.equal(extractScrollIndicator("─── ↓ 3 more "), "↓ 3 more");
	assert.equal(extractScrollIndicator("──── ↓ 3 more ───"), "↓ 3 more");
	assert.equal(extractScrollIndicator("─".repeat(20)), undefined);
	assert.equal(extractScrollIndicator("\x1b[2m────\x1b[0m"), undefined);
	assert.equal(extractScrollIndicator("──── ↑ 12 more ───"), "↑ 12 more", "the top border's label");
});

test("the voice row replaces the top or the bottom border and keeps its scroll label", () => {
	const base = { renderedVisibleLineCount: 2 };
	const lines = ["─── ↑ 4 more ───", "a", "b", "─── ↓ 3 more ───", "autocomplete"];
	const draw = (overflow?: string) => `VOICE ${overflow ?? "-"}`;
	assert.deepEqual(overlayVoiceRow(lines, base, "top", draw), ["VOICE ↑ 4 more", "a", "b", "─── ↓ 3 more ───", "autocomplete"]);
	assert.deepEqual(overlayVoiceRow(lines, base, "bottom", draw), ["─── ↑ 4 more ───", "a", "b", "VOICE ↓ 3 more", "autocomplete"]);
	assert.equal(lines[0], "─── ↑ 4 more ───", "the input is not mutated");
	assert.deepEqual(overlayVoiceRow(["top", "a"], base, "bottom", draw), ["top", "a"], "no bottom border found");
	assert.deepEqual(overlayVoiceRow([], base, "top", draw), []);
});

test("bottom border index walks wrapper chains and verifies the border", () => {
	const lines = ["top", "a", "b", "────────", "autocomplete"];
	assert.equal(bottomBorderIndex({ base: { base: { renderedVisibleLineCount: 2 } } }, lines), 3);
	assert.equal(bottomBorderIndex({ renderedVisibleLineCount: 2 }, lines), 3);
	assert.equal(bottomBorderIndex({ renderedVisibleLineCount: 2 }, ["top", "a", "b"]), -1);
	assert.equal(bottomBorderIndex({ renderedVisibleLineCount: 1 }, lines), -1, "index 2 is a content line");
	assert.equal(bottomBorderIndex({}, lines), -1);
	const scrolled = ["top", "a", "────── ↓ 3 more ──", "auto"];
	assert.equal(bottomBorderIndex({ renderedVisibleLineCount: 1 }, scrolled), 2);
});

test("PCM level maps silence to zero and full scale to one", () => {
	assert.equal(levelFromPcm(new Int16Array(512)), 0);
	assert.equal(levelFromPcm(new Int16Array(512).fill(32767)), 1);
	const mid = levelFromPcm(new Int16Array(512).fill(1000));
	assert.ok(mid > 0 && mid < 1, String(mid));
});

test("clipping needs several full-scale samples, not one stray peak", () => {
	const frame = new Int16Array(1600).fill(1000);
	assert.equal(isClipped(frame), false);
	frame[10] = 32_767;
	assert.equal(isClipped(frame), false, "one sample is a transient");
	frame.fill(-32_768, 20, 24);
	assert.equal(isClipped(frame), true);
});

test("clipping shows a brief too-loud warning", () => {
	const state = { ...base, speaking: true, clippedAt: 1000 };
	assert.match(stripTerminalSequences(renderVoiceBorder(state, undefined, 1500, 80, plain, plainPaint)), /too loud/);
	assert.match(renderIndicator(state, 1500, 80, plain), /too loud/);
	assert.ok(!stripTerminalSequences(renderVoiceBorder(state, undefined, 4000, 80, plain, plainPaint)).includes("too loud"));
	assert.match(renderVoiceBorder(state, undefined, 1500, 80, tag, plainPaint), /<w>[^<]*too loud/, "drawn as a warning");
});

test("the microphone is always named, before the model", () => {
	const state = { ...base, device: "MacBook Pro Microphone", backend: "mlx", model: "parakeet 0.6b-v3" };
	for (const now of [500, 60_000]) {
		const text = stripTerminalSequences(renderVoiceBorder(state, undefined, now, 100, plain, plainPaint));
		assert.match(text, / MacBook Pro Microphone mlx parakeet 0\.6b-v3 ──$/);
	}
	assert.doesNotMatch(stripTerminalSequences(renderVoiceBorder(state, undefined, 0, 100, plain, plainPaint)), /·/);
	const narrow = stripTerminalSequences(renderVoiceBorder({ ...state, levels: [1, 1] }, undefined, 0, 50, plain, plainPaint));
	assert.match(narrow, /MacBook Pro Microphone ──$/, "the model drops before the mic");
	assert.match(renderIndicator(state, 0, 120, plain), /MacBook Pro Microphone/);
});

test("a quiet mic is called out as a warning while recording", () => {
	const state: IndicatorState = { ...base, quiet: true, device: "Jump Desktop Microphone" };
	const border = stripTerminalSequences(renderVoiceBorder(state, undefined, 0, 100, plain, plainPaint));
	assert.match(border, /▼ can't hear you, try \/voice mic/);
	assert.match(renderIndicator(state, 0, 100, plain), /can't hear you/);
	assert.match(renderVoiceBorder(state, undefined, 0, 100, tag, plainPaint), /<w>▼ can't hear you/);
	assert.ok(!renderIndicator({ ...state, quiet: false }, 0, 100, plain).includes("can't hear"));
	assert.ok(!renderIndicator({ ...state, phase: "finishing", stoppedAt: 0 }, 0, 100, plain).includes("can't hear"));
});

test("a note shows while finishing", () => {
	const state: IndicatorState = { ...base, phase: "finishing", stoppedAt: 0, message: "stopped at 5:00, setup still running" };
	assert.match(stripTerminalSequences(renderVoiceBorder(state, undefined, 0, 120, plain, plainPaint)), /stopped at 5:00/);
});
