import assert from "node:assert/strict";
import { test } from "node:test";
import { mixColors, stripTerminalSequences, type Color } from "@earendil-works/pi-tui";
import { lightAt, shimmerAt, shimmerWords, SHIMMER_PEAK, SHIMMER_REACH } from "../lib/fold/shimmer.ts";

const rgb = (r: number, g: number, b: number): Color => ({ kind: "rgb", r, g, b });
const MUTED = rgb(138, 136, 130);
const TEXT = rgb(207, 205, 198);

/** Names the colors the tests compare: the gray, the band's middle, or `lit` for the levels between. */
const PEAK = mixColors(MUTED, TEXT, SHIMMER_PEAK);
const named = (color: Color | undefined) => (color === MUTED ? "gray" : JSON.stringify(color) === JSON.stringify(PEAK) ? "peak" : "lit");

/** A theme that writes each styled run as `[color:text]` and each plain one as `<key:text>`. */
const theme = {
	colors: { muted: MUTED, text: TEXT },
	style: (text: string, options: { fg?: Color }) => `[${named(options.fg)}:${text}]`,
	fg: (key: string, text: string) => `<${key}:${text}>`,
};

test("the band's light is full at its middle and falls off softly to nothing at its reach", () => {
	assert.equal(lightAt(10, 10), 1);
	assert.ok(lightAt(12, 10) > 0 && lightAt(12, 10) < 1);
	assert.equal(lightAt(10 + SHIMMER_REACH, 10), 0);
	assert.equal(lightAt(10 - SHIMMER_REACH - 3, 10), 0);
	assert.equal(lightAt(8, 10), lightAt(12, 10), "even on both sides");
});

test("the band crosses the words left to right, starting and ending off them, then rests", () => {
	assert.equal(shimmerAt(20, 0), -SHIMMER_REACH, "it enters from the left");
	assert.ok(shimmerAt(20, 1_000) > shimmerAt(20, 500), "and moves right");
	const positions = Array.from({ length: 200 }, (_, at) => shimmerAt(20, at * 50));
	assert.ok(Math.max(...positions) >= 20 + SHIMMER_REACH, "it leaves past the last column");
	assert.ok(positions.some((at) => at > 20 + SHIMMER_REACH), "and rests off the words before the next pass");
});

test("words in the tone are lit around the band and keep the settled gray elsewhere; other parts keep their own color", () => {
	const segments = [{ key: "muted", text: "Ran 2 commands" }, { key: "muted", text: ", " }, { key: "error", text: "ls failed" }];
	const at = (ms: number) => shimmerWords(segments, "muted", ms, theme)!;
	const resting = at(0);
	assert.equal(stripTerminalSequences(resting).replace(/\[\w+:|\]|<\w+:|>/g, ""), "Ran 2 commands, ls failed", "every character is drawn once");
	assert.equal(resting, "[gray:Ran 2 commands][gray:, ]<error:ls failed>", "the band is off the words: all settled gray");
	const lit = at(((4 + SHIMMER_REACH) * 1_000) / 12);
	assert.equal(lit, "[lit:R][lit:a][lit:n][lit: ][peak:2][lit: ][lit:c][lit:o][lit:m][gray:mands][gray:, ]<error:ls failed>",
		"column 4 is the band's middle; each column within its reach has its own level, and columns 9 on keep the gray in one run");
});

test("without the theme's colors there is no shimmer", () => {
	assert.equal(shimmerWords([{ key: "muted", text: "Ran" }], "muted", 0, { fg: theme.fg }), undefined);
	assert.equal(shimmerWords([{ key: "muted", text: "Ran" }], "muted", 0, { ...theme, colors: { muted: MUTED } }), undefined);
});
