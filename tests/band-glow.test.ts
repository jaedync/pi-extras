import assert from "node:assert/strict";
import test from "node:test";
import { GLOW_MS, freshness, glowLines, glowing, noteText } from "../lib/band/glow.ts";

const theme = {
	fg: (key: string, text: string) => `<${key}>${text}`,
	getFgAnsi: (key: string) => (key === "text" ? "\x1b[38;2;240;240;240m" : "\x1b[38;2;100;100;100m"),
	getColorMode: () => "truecolor" as const,
};

test("a character is brightest when it arrives and fades to its own color within the glow", () => {
	let trail = noteText(undefined, "task", 10, 0);
	trail = noteText(trail, "task", 20, 100);
	assert.equal(freshness(trail, 19, 100), 1, "the newest character, at once");
	assert.ok(freshness(trail, 19, 100 + GLOW_MS / 2) > 0, "half way through the glow");
	assert.equal(freshness(trail, 19, 100 + GLOW_MS), 0, "after the glow");
	assert.ok(freshness(trail, 5, 100) < freshness(trail, 15, 100), "older characters are dimmer");
	assert.equal(glowing(trail, 100 + GLOW_MS - 1), true);
	assert.equal(glowing(trail, 100 + GLOW_MS), false);
});

test("another text, or a shorter one, starts a new trail; old marks are dropped", () => {
	let trail = noteText(undefined, "task", 10, 0);
	for (let at = 40; at <= 4000; at += 40) trail = noteText(trail, "task", 10 + at / 4, at);
	assert.ok(trail.marks.length <= GLOW_MS / 40 + 2, `the trail holds only the glow's span, not ${trail.marks.length} marks`);
	assert.equal(noteText(trail, "task", 1010, 4000), trail, "no growth, no change");
	assert.deepEqual(noteText(trail, "newText", 3, 4100).marks, [{ length: 3, at: 4100 }]);
	assert.deepEqual(noteText(trail, "task", 5, 4100).marks, [{ length: 5, at: 4100 }]);
});

test("new characters at the end of the last line are painted brighter; the rest keep the base color", () => {
	let trail = noteText(undefined, "t", 8, 0);
	trail = noteText(trail, "t", 12, 1000);
	const [first, last] = glowLines(["abcd", "efghijkl"], 12, trail, 1000, theme, "muted");
	assert.equal(first, "<muted>abcd");
	assert.ok(last!.startsWith("<muted>efgh"), "the four old characters of the line");
	assert.match(last!, /\x1b\[38;2;240;240;240mijkl\x1b\[39m$/, "the four new ones, at full brightness");
	assert.deepEqual(glowLines(["abcd"], 4, trail, 1000 + GLOW_MS, theme, "muted"), ["<muted>abcd"], "faded");
	assert.deepEqual(glowLines(["ijkl"], 12, trail, 1000, { fg: theme.fg }, "muted"), ["<muted>ijkl"], "a theme without colors");
});
