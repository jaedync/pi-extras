import { test } from "node:test";
import assert from "node:assert/strict";
import { overlayVisible, padEndVisible, padStartVisible, stripAnsi, truncateVisible, visibleWidth } from "../lib/ansi.ts";

const red = (t: string) => `\x1b[31m${t}\x1b[39m`;

test("overlay replaces cells without shifting the suffix and restores its ANSI styling", () => {
	const base = red("abc │ tail");
	const result = overlayVisible(base, 3, "\x1b[32m+$0.9\x1b[39m");
	assert.equal(stripAnsi(result), "abc+$0.9il");
	assert.ok(result.endsWith("\x1b[31mil\x1b[39m"), result);
	assert.equal(stripAnsi(overlayVisible("abc", 1, "12345")), "a12345");
	assert.equal(stripAnsi(overlayVisible("abc", 5, "x")), "abc  x");
});

test("visible width ignores escape sequences", () => {
	assert.equal(visibleWidth(red("abc")), 3);
	assert.equal(visibleWidth("\x1b[38;2;1;2;3m█▏░\x1b[39m"), 3);
	assert.equal(stripAnsi(red("x")), "x");
});

test("padding measures visible width, not string length", () => {
	assert.equal(padEndVisible(red("ab"), 5), `${red("ab")}   `);
	assert.equal(padStartVisible(red("ab"), 5), `   ${red("ab")}`);
	assert.equal(padEndVisible("toolong", 3), "toolong");
});

test("truncation keeps escapes balanced and appends the marker", () => {
	assert.equal(truncateVisible("abcdefgh", 5, "…"), "abcd…");
	assert.equal(truncateVisible("abc", 5, "…"), "abc");
	const cut = truncateVisible(red("abcdefgh"), 5, "…");
	assert.equal(stripAnsi(cut), "abcd…");
	assert.equal(visibleWidth(cut), 5);
});
