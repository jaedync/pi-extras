import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { computerUseSpec } from "../lib/tool-display/computer.ts";
import { toolRenderers } from "../lib/tool-display/tool.ts";
import { usageSpec } from "../lib/tool-display/usage.ts";
import { webSearchSpec } from "../lib/tool-display/web.ts";
import { FG, fgOf } from "./support/quiet-theme.ts";
import { band, colorOf, harness, row, text, theme } from "./support/tool-rows.ts";

const strip = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const searchResults = (count: number) => Array.from({ length: count }, (_, index) => ({
	rank: index + 1, title: `Result ${index + 1}`, url: `https://www.site${index + 1}.test/page`, snippet: `Snippet ${index + 1}`, excerptClipped: false,
}));

test("a web search row says what was searched and how many results came back, with the first three under it", () => {
	const h = harness();
	const search = row(toolRenderers(h.kit, webSearchSpec("web_search")) as never, { query: "rust async", domain: "docs.rs", limit: 8 });
	search.update({ executionStarted: true });
	h.advance(2_800);
	const details = { resultCount: 5, requestedCount: 8, pagesFetched: 2, durationMs: 2_800, status: "complete", results: searchResults(5) };
	search.update({ executionStarted: true, isPartial: false, result: text("five results", details) });
	assert.deepEqual(search.lines(), [
		band("web_search rust async site:docs.rs · 5 results", "2.8s"),
		"   1. Result 1  site1.test",
		"   2. Result 2  site2.test",
		"   3. Result 3  site3.test",
		"   … 2 more results (click for all)",
	]);
	assert.equal(colorOf(search.raw()[0]!, " rust async"), fgOf(FG.accent!), "the query stands out");
	search.click();
	const popup = h.popups.at(-1)!;
	assert.equal(popup.details(), "Kagi search · limit 8 · took 2.8s");
	const output = strip(popup.output(theme, 60, 0));
	assert.deepEqual(output.slice(0, 4), ["1. Result 1  site1.test", "   https://www.site1.test/page", "   Snippet 1", ""]);
	assert.equal(output.at(-1), "5 results · of 8 requested · 2 pages");
});

test("a web search row names an empty, partial or cached search, and a failure in words", () => {
	const h = harness();
	const empty = row(toolRenderers(h.kit, webSearchSpec("kagi_search")) as never, { query: "nothing" });
	empty.update({ isPartial: false, result: text("No results", { resultCount: 0 }) });
	assert.deepEqual(empty.lines(), [band("kagi_search nothing · no results")]);
	const partial = row(toolRenderers(h.kit, webSearchSpec("web_search")) as never, { query: "q" });
	partial.update({ isPartial: false, result: text("", { resultCount: 1, status: "partial", cached: true, results: searchResults(1) }) });
	assert.equal(partial.lines()[0], band("web_search q · 1 result · partial · cached"));
	const failed = row(toolRenderers(h.kit, webSearchSpec("web_search")) as never, { query: "q" });
	failed.update({ isPartial: false, isError: true, result: text("Kagi markup is unrecognized.") });
	assert.deepEqual(failed.lines(), [band("web_search q", "failed"), "   Kagi markup is unrecognized."]);
});

const call = (method: string, app: string, detail: string, over: object = {}) => ({ method, app, detail, ms: 120, ok: true, ...over });

test("a computer use row names the apps, then counts the calls and screenshots once it ends", () => {
	const h = harness();
	const code = 'await sky.click({ app: "Safari" });\nemit("done");';
	const use = row(toolRenderers(h.kit, computerUseSpec) as never, { code });
	use.update({});
	assert.equal(use.lines()[0], band('computer_use await sky.click({ app: "Safari" });', "queued"), "before any call, the script's first line");
	use.update({ executionStarted: true, result: text("", { calls: [call("get_app_state", "Safari", "full tree")], running: { method: "click", app: "Safari", detail: "element 7" } }) });
	assert.deepEqual(use.lines().slice(1), [
		"   get_app_state  Safari full tree  120ms",
		"   click          Safari element 7  …",
	]);
	const calls = [
		call("get_app_state", "Safari", "full tree"),
		call("click", "Safari", "element 7"),
		call("type_text", "Safari", '"hello"'),
		call("click", "Notes", "element 3", { ok: false, error: "Element not found\nstack" }),
		call("press_key", "Notes", "Return", { ok: false, approval: "deny" }),
		call("get_app_state", "Notes", "diff"),
	];
	const content = [{ type: "text", text: "one\ntwo\nthree\nfour\nfive" }, { type: "image", data: "AA==", mimeType: "image/png" }];
	use.update({ executionStarted: true, isPartial: false, result: { content, details: { calls, durationMs: 900 } } });
	const lines = use.lines(80);
	assert.match(lines[0]!, /^ computer_use Safari, Notes · 6 calls · 1 screenshot +\d+ms$/);
	assert.deepEqual(lines.slice(1), [
		"   … 2 earlier calls (click for all)",
		"   type_text      Safari \"hello\"  120ms",
		"   click          Notes element 3  120ms · failed: Element not found",
		"   press_key      Notes Return  120ms · not allowed",
		"   get_app_state  Notes diff  120ms",
		"   one",
		"   two",
		"   three",
		"   … 2 more lines (click for all)",
	]);
	assert.ok(!lines.join("\n").match(/[✓✗✔✘]/), "failures are named in words, never marked");
	use.click();
	const popup = h.popups.at(-1)!;
	assert.equal(popup.details(), "6 Computer Use calls · took 900ms");
	assert.deepEqual(strip(popup.head(theme, 80, 0)), code.split("\n"));
	assert.equal(strip(popup.output(theme, 80, 0)).length, 6 + 1 + 5, "every call, a gap, then everything the script emitted");
});

const limit = (window: string, usedPct: number, over: object = {}) => ({
	provider: "anthropic", window, kind: "window", applies: true, usedPct, status: "ok",
	reset: { resetsAt: "", resetsAtLocal: "Tue 3:40 PM", resetsInSeconds: 3 * 3600 + 32 * 60, resumeAfterSeconds: 0 }, ...over,
});

function report(limits: object[], over: object = {}) {
	return { asOf: "", model: { provider: "anthropic", id: "claude-x" }, warnings: "on", budget: null, snapshotAgeSeconds: {}, limits, notes: [], ...over };
}

test("a usage row answers in its band: each window that applies, amber when close and red when spent", () => {
	const h = harness();
	const usage = row(toolRenderers(h.kit, usageSpec) as never, {});
	const limits = [limit("5h", 35), limit("7d", 85), limit("7d-opus", 100, { applies: false, status: "exhausted" })];
	usage.update({ isPartial: false, result: text("{}", report(limits, { notes: ["Snapshot is 10 minutes old."] })) });
	assert.deepEqual(usage.lines(), [band("usage 5h 35% 7d 85%"), "   Snapshot is 10 minutes old."]);
	assert.equal(colorOf(usage.raw()[0]!, " 7d 85%"), fgOf(FG.warning!));
	assert.equal(colorOf(usage.raw()[0]!, " 5h 35%"), fgOf(FG.toolOutput!));
	usage.click();
	const output = strip(h.popups.at(-1)!.output(theme, 80, 0));
	assert.deepEqual(output.slice(0, 3), [
		"5h        35%  resets in 3h 32m (Tue 3:40 PM)",
		"7d        85%  resets in 3h 32m (Tue 3:40 PM)",
		"7d-opus  100%  other model · resets in 3h 32m (Tue 3:40 PM)",
	]);

	const spent = row(toolRenderers(h.kit, usageSpec) as never, { setBudget: { window: "5h", pct: 90 } });
	spent.update({ isPartial: false, result: text("{}", report([limit("5h", 100, { status: "exhausted" })], { budget: { window: "5h", pct: 90 } })) });
	assert.equal(spent.lines()[0], band("usage 5h 100% · budget 5h at 90%"));
	assert.equal(colorOf(spent.raw()[0]!, " 5h 100%"), fgOf(FG.error!));
});
