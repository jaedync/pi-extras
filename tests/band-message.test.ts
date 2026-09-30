import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { markdownIsSafe, MAX_EXPANDED_LINES, messageBody } from "../lib/band/message.ts";
import { createMeshMessageRenderer } from "../lib/tool-display/mesh.ts";
import { quiet } from "./support/quiet-theme.ts";

initTheme("dark");
const theme = quiet();
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
function counting() {
	const base = getMarkdownTheme();
	const counter = { calls: 0 };
	const markdown = { ...base, highlightCode: (code: string, lang?: string) => { counter.calls++; return base.highlightCode!(code, lang); } };
	return { markdown, counter };
}

// Mail comes from other sessions and subagents, so a hostile or buggy body must not reach the parser.
const deepQuote = "> ".repeat(3000) + "hello";
const deepList = Array.from({ length: 2000 }, (_, i) => "  ".repeat(i) + "- x").join("\n");

test("deeply nested or oversized mail never reaches the Markdown parser", () => {
	assert.equal(markdownIsSafe(deepQuote), false);
	assert.equal(markdownIsSafe(deepList), false);
	assert.equal(markdownIsSafe("x".repeat(200_000)), false);
	assert.equal(markdownIsSafe("line\n".repeat(20_000)), false);
	assert.equal(markdownIsSafe("## Plan\n\n> quoted\n>> twice\n\n- a\n  - b\n    - c\n\n```js\nconst x = 1;\n```"), true);
});

test("unsafe mail renders as bounded plain text with a note, quickly", () => {
	for (const text of [deepQuote, deepList]) {
		const started = performance.now();
		const lines = plain(messageBody(theme, 100, text, "text", null, getMarkdownTheme()));
		assert.ok(performance.now() - started < 500, "plain fallback stays fast");
		assert.match(lines.join("\n"), /plain text/);
		assert.ok(lines.length <= MAX_EXPANDED_LINES + 2, `bounded: ${lines.length}`);
	}
});

test("the expanded view of a huge plain body is bounded", () => {
	const lines = plain(messageBody(theme, 80, "word ".repeat(400_000), "text", null));
	assert.ok(lines.length <= MAX_EXPANDED_LINES + 2, `bounded: ${lines.length}`);
	assert.match(lines.at(-1)!, /more (lines|characters)/);
});

test("a Markdown render that throws falls back to plain text", () => {
	const markdown = { ...getMarkdownTheme(), highlightCode: () => { throw new RangeError("Maximum call stack size exceeded"); } };
	const lines = plain(messageBody(theme, 80, "```js\nconst x = 1;\n```", "text", null, markdown));
	assert.match(lines.join("\n"), /const x = 1;/);
});

test("a mesh row parses its body once although Pi hands out a fresh Markdown theme each call", () => {
	const counter = { calls: 0 };
	// Pi's getMarkdownTheme() builds a new object per call; the row asks for one every frame.
	const source = () => ({ ...getMarkdownTheme(), highlightCode: (code: string, lang?: string) => { counter.calls++; return getMarkdownTheme().highlightCode!(code, lang); } });
	const body = "```js\n" + Array.from({ length: 150 }, (_, i) => `const w${i} = ${i};`).join("\n") + "\n```";
	const message = { role: "custom", customType: "remote-pi:mesh-message", display: true, timestamp: 0,
		content: `[agent-network] message from "/Users/x@peer" (id=01a):\n${body}\n\n(If a reply is expected, call agent_send with to="/Users/x@peer" and re="01a".)` };
	const row = createMeshMessageRenderer(source)(message as never, { expanded: false } as never, theme as never)!;
	for (let i = 0; i < 20; i++) row.render(100);
	assert.equal(counter.calls, 1);
});

test("repeated redraws reuse the rendered body until width or theme changes", () => {
	const { markdown, counter } = counting();
	const text = "```js\n" + Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n```";
	for (let i = 0; i < 20; i++) messageBody(theme, 100, text, "text", 8, markdown);
	assert.equal(counter.calls, 1, "one parse for twenty frames");
	messageBody(theme, 100, text, "text", null, markdown);
	assert.equal(counter.calls, 1, "expanding reuses the same layout");
	messageBody(theme, 90, text, "text", 8, markdown);
	assert.equal(counter.calls, 2, "a new width lays out again");
	messageBody(quiet(), 90, text, "text", 8, markdown);
	assert.equal(counter.calls, 3, "a new theme lays out again");
});
