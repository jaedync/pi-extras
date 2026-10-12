import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth as cellWidth } from "@earendil-works/pi-tui";
import { overlayVisible, padEndVisible, padStartVisible, stripAnsi, truncateStart, truncateVisible, visibleWidth } from "../lib/ansi.ts";

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

const link = (url: string, text: string) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

test("width counts terminal cells: wide characters take two, escapes and OSC 8 links none", () => {
	assert.equal(visibleWidth("日本語"), 6);
	assert.equal(visibleWidth("👍x"), 3);
	assert.equal(visibleWidth("👨‍👩‍👧"), 2);
	assert.equal(visibleWidth(red("日本")), 4);
	assert.equal(visibleWidth(link("https://example.com", "docs")), 4);
	assert.equal(stripAnsi(link("https://example.com", "docs")), "docs");
});

test("truncation of wide characters never passes the width", () => {
	for (let width = 1; width <= 12; width++) {
		for (const text of ["日本語".repeat(5), red("ab日本cd語"), `${link("https://example.com", "日本語のリンク")} tail`, "👨‍👩‍👧👍🎙️x".repeat(3)]) {
			const cut = truncateVisible(text, width, "…");
			assert.ok(cellWidth(cut) <= width, `${JSON.stringify(text)} at ${width}: ${cellWidth(cut)}`);
		}
	}
	assert.equal(stripAnsi(truncateVisible("日本語", 4, "…")), "日…");
	// A link that is cut keeps its closing sequence, so the rest of the line is not a link.
	const cut = truncateVisible(`${link("https://example.com", "abcdef")}`, 4, "…");
	assert.ok(cut.endsWith("\x1b]8;;\x07"), JSON.stringify(cut));
});

test("a marker wider than the room is left out", () => {
	assert.ok(cellWidth(truncateVisible("abcdef", 1, "……")) <= 1);
});

test("overlay over wide characters keeps the suffix in its columns", () => {
	const base = "日本語 tail";
	const result = overlayVisible(base, 1, "x");
	assert.equal(cellWidth(result), cellWidth(base));
	assert.equal(stripAnsi(result).slice(-4), "tail");
	const over = overlayVisible("abcdef", 2, "日");
	assert.equal(stripAnsi(over), "ab日ef");
});

test("keeping the tail of a path counts wide characters", () => {
	const path = "~/プロジェクト/日本語のリポジトリ";
	for (let width = 1; width <= 20; width++) assert.ok(cellWidth(truncateStart(path, width)) <= width, `${width}`);
	assert.equal(truncateStart("~/ab", 10), "~/ab");
});
