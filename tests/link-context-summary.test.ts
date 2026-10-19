import assert from "node:assert/strict";
import test from "node:test";
import { hostOf, platformName, reason, shortUrl, summaryOf } from "../lib/link-context/names.ts";
import { proseLines, threadSummary } from "../lib/link-context/summary.ts";

test("prose lines skip headings, HTML, links on their own and link lists, and read links as their words", () => {
	const markdown = [
		"# Terminal emulator - Wikipedia",
		"https://en.wikipedia.org/wiki/Terminal_emulator",
		"",
		"<p align=\"center\"><img src=\"x.svg\"></p>",
		"https://en.wikipedia.org/wiki/File:Xterm.png[xterm](https://en.wikipedia.org/wiki/Xterm), a terminal",
		"This article needs [more citations](https://en.wikipedia.org/wiki/Wikipedia:Verifiability). Please help [improve this article](https://en.wikipedia.org/wiki/Special:EditPage/Terminal_emulator).",
		"",
		"A **terminal emulator** is a [computer program](https://en.wikipedia.org/wiki/Application_software) that emulates a video terminal within some other display architecture.",
		"> A quoted line.",
	].join("\n");
	assert.deepEqual(proseLines(markdown, "Terminal emulator - Wikipedia", 3), [
		"A terminal emulator is a computer program that emulates a video terminal within some other display architecture.",
		"A quoted line.",
	]);
	assert.deepEqual(proseLines("", "x", 3), []);
	assert.deepEqual(proseLines("one\ntwo\nthree", "", 2), ["one", "two"]);
});

test("prose lines skip fenced code, with its fences and its language", () => {
	assert.deepEqual(proseLines("```json\n{\n  \"args\": {}\n}\n```\nAfter the code.", "", 2), ["After the code."]);
	assert.deepEqual(proseLines("~~~~\ncode\n~~~~\n", "", 2), []);
});

test("prose lines skip a page's bracketed bits: edit links, footnote marks", () => {
	assert.deepEqual(proseLines("Program that emulates a video terminal\n[edit]\n[1]\nA terminal emulator is a program.", "", 2), ["Program that emulates a video terminal", "A terminal emulator is a program."]);
});

test("prose lines join a reply's byline to its text, and show dates without the time", () => {
	const markdown = "**dhouston** · 2007-04-04T19:16:40Z · 104 points\n\n## Replies (2 of 71)\n\n- **dhouston** · 2007-04-04T19:22:55Z\n  oh, and a mac port is coming :)\n  - **vlad** · 2007-04-05T01:48:11Z\n    Drew, this is awesome!";
	assert.deepEqual(proseLines(markdown, "", 5), ["dhouston · 2007-04-04 · 104 points", "dhouston: oh, and a mac port is coming :)", "vlad: Drew, this is awesome!"]);
});

test("a thread's summary: who, when, stats and replies; the post's first line; the first reply", () => {
	const post = { author: "Ben", handle: "@benk", date: "2026-10-01T10:00:00Z", text: "# Title\nhttps://e.test\n\nFirst line of the post.\nSecond line.", stats: "12 likes" };
	const replies = [{ post: { author: "amy", text: "A [linked](https://e.test/a) reply." }, depth: 0 }];
	assert.deepEqual(threadSummary(post, replies, 40), ["Ben (@benk) · 2026-10-01 · 12 likes · 40 replies", "First line of the post.", "amy: A linked reply."]);
	assert.deepEqual(threadSummary({ author: "Solo", text: "" }, []), ["Solo"]);
	assert.deepEqual(threadSummary({ author: "One", text: "hi" }, [], 1), ["One · 1 reply", "hi"]);
});

test("names: platforms by their real names, web pages by host, URLs short, failures without the host again", () => {
	assert.equal(platformName("hackernews", "https://news.ycombinator.com/item?id=1"), "Hacker News");
	assert.equal(platformName("github", ""), "GitHub");
	assert.equal(platformName("youtube", ""), "YouTube");
	assert.equal(platformName("dailymotion", ""), "Dailymotion");
	assert.equal(platformName("web", "https://www.example.com/a"), "example.com");
	assert.equal(platformName(undefined, "https://e.test/"), "e.test");
	assert.equal(hostOf("not a url"), "not a url");
	assert.equal(shortUrl("https://www.github.com/a/b/"), "github.com/a/b");
	assert.equal(reason("httpbin.org answered HTTP 404 (page not found)", "https://httpbin.org/status/404"), "HTTP 404 (page not found)");
	assert.equal(reason("The page timed out.", "https://e.test/"), "The page timed out.");
});

test("a result's summary: the adapter's lines, else the first prose lines; never more than three", () => {
	assert.deepEqual(summaryOf({ platform: "x", title: "t", url: "u", markdown: "body", summary: ["a", "b", "c", "d"] }), ["a", "b", "c"]);
	assert.deepEqual(summaryOf({ platform: "web", title: "T", url: "u", markdown: "# T\n\nbody line\n\nmore" }), ["body line", "more"]);
});
