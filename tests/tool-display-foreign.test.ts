import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { BORROWED_REFRESH_MS, foreignRenderers, keyArg, type ForeignTool } from "../lib/tool-display/foreign.ts";
import { FG, fgOf } from "./support/quiet-theme.ts";
import { band, colorOf, harness, row, text, theme } from "./support/tool-rows.ts";

const plain = (value: string) => new Text(value, 0, 0);
const strip = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());

/** A tool that draws its own rows, the way pi-web-access's fetch_content does. */
function fetchTool(over: Partial<ForeignTool> = {}): ForeignTool & { calls: { call: number; result: number } } {
	const calls = { call: 0, result: 0 };
	return {
		name: "fetch_content",
		label: "Fetch Content",
		calls,
		renderCall: ((args: { url: string }) => {
			calls.call++;
			return plain(`fetch ${args.url}`);
		}) as never,
		renderResult: ((result: { content: { text: string }[] }, options: { expanded: boolean }) => {
			calls.result++;
			const [first = "", ...rest] = result.content[0]!.text.split("\n");
			return plain(options.expanded ? [first, ...rest].join("\n") : `${first} (${rest.length} more)`);
		}) as never,
		...over,
	};
}

test("an adopted row's band takes the tool's own call line, and its body the tool's own result", () => {
	const h = harness();
	const fetch = row(foreignRenderers(h.kit, fetchTool()) as never, { url: "https://example.test/a" });
	fetch.update({ executionStarted: true });
	h.advance(1_200);
	fetch.update({ executionStarted: true, isPartial: false, result: text("Example Domain\nline 2\nline 3") });
	assert.deepEqual(fetch.lines(), [
		band("fetch_content https://example.test/a", "1.2s"),
		"   Example Domain (2 more)",
	], "the tool's short name for itself (`fetch`) is dropped, since the band names the tool");
});

test("without words of its own, the band shows the argument that says what the call is about", () => {
	const h = harness();
	const bare = row(foreignRenderers(h.kit, { name: "agent_send" }) as never, { to: "peer", message: "hello\nthere" });
	bare.update({ isPartial: false, result: text("Delivered") });
	assert.deepEqual(bare.lines(), [band("agent_send hello"), "   Delivered"], "no renderers: the key argument and the result's text");

	const throwing = row(foreignRenderers(h.kit, fetchTool({ renderCall: () => { throw new Error("bad"); } })) as never, { url: "https://example.test/b" });
	throwing.update({ isPartial: false, result: text("Title\nmore") });
	assert.equal(throwing.lines()[0], band("fetch_content https://example.test/b"));

	const labelOnly = row(foreignRenderers(h.kit, { name: "update_goal_progress", label: "Update Goal Progress", renderCall: () => plain("Update Goal Progress") } as never) as never, { summary: "Halfway" });
	labelOnly.update({ isPartial: false, result: text("ok") });
	assert.equal(labelOnly.lines()[0], band("update_goal_progress Halfway"), "a call line that only repeats the label says nothing");
});

test("a result that only repeats the call, or can't be drawn, shows the result's text instead", () => {
	const h = harness();
	const echo = row(foreignRenderers(h.kit, { name: "mcp", renderCall: () => plain("mcp search"), renderResult: () => plain("mcp search · 3 lines (Ctrl+O)") } as never) as never, { tool: "search" });
	echo.update({ isPartial: false, result: text("### Result\n42") });
	assert.deepEqual(echo.lines(), [band("mcp search"), "   ### Result", "   42"]);

	const broken = row(foreignRenderers(h.kit, fetchTool({ renderResult: () => { throw new Error("bad"); } })) as never, { url: "https://example.test/c" });
	broken.update({ isPartial: false, result: text("raw text") });
	assert.deepEqual(broken.lines().slice(1), ["   raw text"]);
});

test("a long result shows its first lines and how many more; expanded, all of it", () => {
	const h = harness();
	const tool: ForeignTool = { name: "get_goal", renderResult: ((result: { content: { text: string }[] }) => plain(result.content[0]!.text)) as never };
	const long = Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join("\n");
	const goal = row(foreignRenderers(h.kit, tool) as never, {});
	goal.update({ isPartial: false, result: text(long) });
	assert.deepEqual(goal.lines(), [band("get_goal"), "   line 1", "   line 2", "   line 3", "   line 4", "   … 3 more lines (click for all)"]);
	goal.update({ isPartial: false, expanded: true, result: text(long) });
	assert.equal(goal.lines().length, 8);
});

test("a failed call says so in the rail and shows its error in red", () => {
	const h = harness();
	const fetch = row(foreignRenderers(h.kit, fetchTool()) as never, { url: "https://example.test/d" });
	fetch.update({ isPartial: false, isError: true, result: text("HTTP 403: Forbidden") });
	assert.deepEqual(fetch.lines(), [band("fetch_content https://example.test/d", "failed"), "   HTTP 403: Forbidden"]);
	assert.equal(colorOf(fetch.raw()[1]!, "HTTP 403"), fgOf(FG.error!), "the error is the theme's error color");
});

test("the tool's renderers are asked again when Pi has something new, not on every animation frame", () => {
	const h = harness();
	const tool = fetchTool();
	const fetch = row(foreignRenderers(h.kit, tool) as never, { url: "https://example.test/e" });
	const partial = text("Loading\nstep 1");
	// Pi hands the result renderer a fresh wrapper each time around the same content.
	const again = () => fetch.update({ executionStarted: true, result: { content: partial.content, details: partial.details } });
	again();
	fetch.lines();
	const before = { ...tool.calls };
	for (let frame = 0; frame < 5; frame++) {
		h.advance(16);
		again();
		fetch.lines();
	}
	assert.deepEqual(tool.calls, before, "frames within the refresh time reuse what the tool drew");
	h.advance(BORROWED_REFRESH_MS);
	again();
	fetch.lines();
	assert.deepEqual(tool.calls, { call: before.call + 1, result: before.result + 1 }, "a tool that changed its result in place still shows it soon after");
	fetch.update({ executionStarted: true, result: text("Loaded\nstep 1\nstep 2") });
	assert.deepEqual(fetch.lines().slice(1), ["   Loaded (2 more)"], "a new result is drawn at once");
});

test("the popup lists every argument and the tool's whole result", () => {
	const h = harness();
	const fetch = row(foreignRenderers(h.kit, fetchTool()) as never, { url: "https://example.test/f", prompt: "what is\nthis page", limit: 3 });
	fetch.update({ isPartial: false, result: text("Title\nline 2\nline 3") });
	fetch.click();
	const source = h.popups.at(-1)!;
	assert.equal(source.label(), "fetch_content");
	assert.equal(source.details(), "Fetch Content");
	assert.deepEqual(strip(source.head(theme, 60, 0)), [
		"url     https://example.test/f",
		"prompt  what is",
		"        this page",
		"limit   3",
	]);
	assert.deepEqual(strip(source.output(theme, 60, 0)), ["Title", "line 2", "line 3"]);
});

test("the key argument is the most telling one that reads as text", () => {
	assert.equal(keyArg({ id: "r1", query: "rust async" }), "rust async");
	assert.equal(keyArg({ urls: ["https://a.test", "https://b.test", "https://c.test"] }), "https://a.test +2");
	assert.equal(keyArg({ count: 3, note: "\n  second line first  " }), "second line first");
	assert.equal(keyArg({ count: 3 }), undefined);
	assert.equal(keyArg("text"), undefined);
});
