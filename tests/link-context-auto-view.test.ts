import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { autoLines, createAutoRenderer, waitLine, type WaitLink } from "../lib/link-context/auto-view.ts";
import { autoMessage, type LinkResult } from "../lib/link-context/auto-message.ts";
import type { Pulled } from "../lib/link-context/types.ts";
import { BG, bgOf, FG, fgOf, quiet } from "./support/quiet-theme.ts";
import { band, colorOf } from "./support/tool-rows.ts";

const theme = quiet();

/** The foreground color at the first character of `piece`, for a band painted one column at a time. */
function colorAt(raw: string, piece: string): string | undefined {
	let plain = "";
	let color: string | undefined;
	for (let i = 0; i < raw.length;) {
		const escape = /^\x1b\[[\d;]*m/.exec(raw.slice(i));
		if (escape) {
			if (escape[0].startsWith("\x1b[38;2;")) color = escape[0];
			i += escape[0].length;
			continue;
		}
		plain += raw[i++];
		if (plain.endsWith(piece.charAt(0)) && stripTerminalSequences(raw.slice(i - 1)).startsWith(piece)) return color;
	}
	return undefined;
}
const strip = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const pulled = (url: string, extra: Partial<Pulled> = {}): Pulled => ({ platform: "web", title: `Title of ${url}`, url, markdown: "body", ...extra });
const GH = "https://github.com/earendil-works/pi-mono";
const WIKI = "https://en.wikipedia.org/wiki/Terminal_emulator";
const BAD = "https://httpbin.org/status/500";
const results: LinkResult[] = [
	{ url: GH, state: "read", pulled: pulled(GH, { platform: "github", title: "earendil-works/pi", summary: ["AI agent toolkit", "116.4K stars"] }) },
	{ url: WIKI, state: "read", pulled: pulled(WIKI, { title: "Terminal emulator - Wikipedia", markdown: "x".repeat(24_360), images: [{ type: "image", data: "AA==", mimeType: "image/png" }], summary: ["Program that emulates a video terminal"] }) },
	{ url: BAD, state: "failed", error: "httpbin.org answered HTTP 500" },
];

test("the message's band carries its status as a tool row does: the outcome's color, the failures and the time on the right", () => {
	const details = autoMessage(results, 0, 827).details;
	const lines = autoLines(theme, 100, details, false);
	assert.deepEqual(strip(lines), [
		band("pull_link 2 of 3 links from your message", "1 failed   827ms", 100),
		"  │ GitHub            earendil-works/pi",
		"  │ en.wikipedia.org  Terminal emulator - Wikipedia  1 image, first 12k of 24k chars",
		"  │ httpbin.org       failed: HTTP 500",
	]);
	assert.equal(colorOf(lines[0]!, "●"), fgOf(FG.success!), "some links were read: the dot is green");
	assert.equal(colorOf(lines[0]!, "1 failed"), fgOf(FG.error!));
	assert.equal(colorOf(lines[3]!, "failed: HTTP 500"), fgOf(FG.error!));
});

test("expanded, each link adds its address and its summary", () => {
	const lines = strip(autoLines(theme, 100, autoMessage(results, 0, 827).details, true));
	assert.deepEqual(lines.slice(1, 6), [
		"  │ GitHub            earendil-works/pi",
		"  │                   https://github.com/earendil-works/pi-mono",
		"  │                   AI agent toolkit",
		"  │                   116.4K stars",
		"  │ en.wikipedia.org  Terminal emulator - Wikipedia  1 image, first 12k of 24k chars",
	]);
	assert.equal(lines.at(-1), "  │                   https://httpbin.org/status/500");
});

test("no link read: a red band when they failed, a warning when they are still being read", () => {
	const failed = autoLines(theme, 80, autoMessage([{ url: BAD, state: "failed", error: "boom" }], 0, 1_200).details, false);
	assert.equal(strip(failed)[0], band("pull_link 0 of 1 link from your message", "1 failed  1.2s", 80));
	assert.equal(colorOf(failed[0]!, "●"), fgOf(FG.error!));
	const late = autoLines(theme, 80, autoMessage([{ url: "https://e.test/slow", state: "reading" }], 0, 15_000).details, false);
	assert.equal(strip(late)[0], band("pull_link 0 of 1 link from your message", "1 still reading  15.0s", 80));
	assert.equal(strip(late)[1], "  │ e.test  still reading; pull_link uses its result when it is ready");
});

test("collapsed, three links show and the rest are counted; links past the limit are named", () => {
	const many: LinkResult[] = Array.from({ length: 5 }, (_, i) => ({ url: `https://e.test/${i}`, state: "read", pulled: pulled(`https://e.test/${i}`) }));
	const skipped: LinkResult[] = [{ url: "https://e.test/6", state: "skipped" }];
	const details = autoMessage([...many, ...skipped], 90, 300).details;
	const lines = strip(autoLines(theme, 100, details, false, "click or ctrl+o to expand"));
	assert.equal(lines[0], band("pull_link 5 of 96 links from your message", "91 not read   300ms", 100));
	assert.deepEqual(lines.slice(1), [
		"  │ e.test  Title of https://e.test/0",
		"  │ e.test  Title of https://e.test/1",
		"  │ e.test  Title of https://e.test/2",
		"  │ … 93 more links (click or ctrl+o to expand)",
	]);
	const all = strip(autoLines(theme, 100, details, true));
	assert.equal(all.at(-3), "  │ e.test  not read: only the first 5 links are read");
	assert.equal(all.at(-2), "  │         https://e.test/6");
	assert.equal(all.at(-1), "  │ … and 90 more links, not read");
});

test("a message saved by an older version draws without summaries or a time; bad details draw nothing", () => {
	const old = { links: [{ url: GH, state: "read", title: "earendil-works/pi", platform: "github", chars: 10 }], counts: { read: 1, failed: 0, reading: 0, skipped: 0 } };
	assert.deepEqual(strip(autoLines(theme, 60, old, false)), [band("pull_link 1 link from your message", "", 60), "  │ GitHub  earendil-works/pi"]);
	assert.deepEqual(autoLines(theme, 60, undefined, false), []);
	assert.deepEqual(autoLines(theme, 60, { links: "x" }, false), []);
});

test("titles and errors from sites carry no terminal escapes", () => {
	const evil: LinkResult[] = [{ url: "https://e.test/a", state: "read", pulled: pulled("https://e.test/a", { title: "T\x1b]8;;evil\x07itle", summary: ["s\x1b[31mred"] }) }];
	const lines = autoLines(theme, 80, autoMessage(evil, 0, 10).details, true).join("\n");
	assert.doesNotMatch(lines, /\x07|\x1b\[31m|\x1b\]8;;evil/);
});

test("the renderer expands on a click, and ctrl+o resets the click", () => {
	const renderer = createAutoRenderer();
	const message = { details: autoMessage(results, 0, 827).details } as never;
	const collapsed = renderer(message, { expanded: false } as never, theme as never)!;
	assert.equal(collapsed.render(100).length, 4);
	(collapsed as { handleMouse(event: unknown): unknown }).handleMouse({ type: "click", button: "left" });
	assert.equal(collapsed.render(100).length, 10);
	assert.equal(renderer(message, { expanded: true } as never, theme as never)!.render(100).length, 10);
	assert.equal(renderer({ details: undefined } as never, { expanded: false } as never, theme as never), undefined);
});

test("the wait line: a running band with each link's state and the time against the limit", () => {
	const links: WaitLink[] = [
		{ url: GH, state: "read", platform: "github" },
		{ url: WIKI, state: "reading" },
		{ url: BAD, state: "failed" },
	];
	const line = waitLine(theme, 100, links, 2_100, 15_000, 2_100, "reduced");
	assert.equal(stripTerminalSequences(line).trimEnd(), band("pull_link GitHub, en.wikipedia.org, httpbin.org failed", "2.1s / 15s", 100));
	assert.equal(colorAt(line, "GitHub"), fgOf(FG.text!));
	assert.equal(colorAt(line, "en.wikipedia.org"), fgOf(FG.dim!));
	assert.equal(colorAt(line, "httpbin.org failed"), fgOf(FG.error!));
	assert.ok(line.includes(bgOf(BG.toolPendingBg!)) || /\x1b\[48;2;/.test(line), "the band has a background");
});
