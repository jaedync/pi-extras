import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { linkSpec } from "../lib/tool-display/link.ts";
import { toolRenderers } from "../lib/tool-display/tool.ts";
import { FG, fgOf } from "./support/quiet-theme.ts";
import { band, colorOf, harness, row, text, theme } from "./support/tool-rows.ts";

const strip = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const wrapped = (url: string, body: string) => `<untrusted-content source="${url}">\n${body}\n</untrusted-content>`;
const HN = "https://news.ycombinator.com/item?id=8863";
const hnDetails = { platform: "hackernews", title: "My YC app: Dropbox", url: HN, chars: 1_380, images: 0, cached: false, durationMs: 700, preview: ["dhouston · 2007-04-04 · 104 points · 71 replies", "dhouston: oh, and a mac port is coming :)"] };

test("a pull_link row: a short link, the options and the platform in the band; the title and summary under it", () => {
	const h = harness();
	const pull = row(toolRenderers(h.kit, linkSpec) as never, { url: HN, comments: 5 });
	pull.update({ executionStarted: true });
	h.advance(700);
	pull.update({ executionStarted: true, isPartial: false, result: text(wrapped(HN, "# My YC app: Dropbox\nbody"), hnDetails) });
	assert.deepEqual(pull.lines(90), [
		band("pull_link news.ycombinator.com/item?id=8863, 5 comments, Hacker News", "700ms", 90),
		"    My YC app: Dropbox",
		"    dhouston · 2007-04-04 · 104 points · 71 replies",
		"    dhouston: oh, and a mac port is coming :)",
	]);
	const raw = pull.raw(90);
	assert.equal(colorOf(raw[0]!, "news.ycombinator"), fgOf(FG.accent!), "the link stands out");
	assert.match(raw[0]!, /\x1b\]8;;https:\/\/news\.ycombinator\.com\/item\?id=8863\x1b\\/, "the short link opens the full one");
	assert.equal(colorOf(raw[2]!, "dhouston"), fgOf(FG.muted!));
	pull.click();
	const popup = h.popups.at(-1)!;
	assert.equal(popup.details(), "Hacker News, 1,380 chars, took 0.7s");
	assert.deepEqual(strip(popup.output(theme, 60, 0)), ["# My YC app: Dropbox", "body"], "the popup has the result without its wrapper");
});

test("a pull_link row expanded adds the full link; a long result names its page, images and the cache", () => {
	const h = harness();
	const url = "https://www.youtube.com/watch?v=abc";
	const pull = row(toolRenderers(h.kit, linkSpec) as never, { url, frames: 6, offset: 40_000 });
	const details = { platform: "youtube", title: "A video", url, chars: 90_000, images: 2, next: 80_000, cached: true, preview: ["Chan · 2026-01-01 · 12:31"] };
	pull.update({ isPartial: false, expanded: true, result: text(wrapped(url, "x"), details) });
	assert.deepEqual(pull.lines(110), [
		band("pull_link youtube.com/watch?v=abc, 6 frames, from 40,000, YouTube, 2 images, page 2 of 3, cached", "", 110),
		"    A video",
		"    Chan · 2026-01-01 · 12:31",
		"    https://www.youtube.com/watch?v=abc",
	]);
});

test("a running pull_link row names its step in the rail; a failure names the reason without the host", () => {
	const h = harness();
	const pull = row(toolRenderers(h.kit, linkSpec) as never, { url: "https://httpbin.org/status/404" });
	pull.update({ executionStarted: true, result: text("Reading captions…", { progress: "Reading captions" }) });
	h.advance(3_400);
	pull.update({ executionStarted: true, result: text("Reading captions…", { progress: "Reading captions" }) });
	assert.match(pull.lines(80)[0]!, /^. pull_link httpbin\.org\/status\/404 +reading captions   3\.4s$/);
	pull.update({ executionStarted: true, isPartial: false, isError: true, result: text("httpbin.org answered HTTP 404 (page not found)") });
	assert.deepEqual(pull.lines(80), [band("pull_link httpbin.org/status/404", "failed  3.4s", 80), "    HTTP 404 (page not found)"]);
});

test("a pull_link row saved before summaries shows the first prose lines of its result", () => {
	const h = harness();
	const url = "https://e.test/a";
	const pull = row(toolRenderers(h.kit, linkSpec) as never, { url });
	pull.update({ isPartial: false, result: text(wrapped(url, "# Old page\nhttps://e.test/a\n\nFirst line.\n\nSecond line."), { platform: "web", title: "Old page", url, chars: 40 }) });
	assert.deepEqual(pull.lines(60), [band("pull_link e.test/a, e.test"), "    Old page", "    First line.", "    Second line."]);
});
