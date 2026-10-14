import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ARTIFACT_SPECS, isArtifactTool } from "../lib/tool-display/artifact.ts";
import { expiryText } from "../lib/tool-display/artifact-kit.ts";
import { toolRenderers } from "../lib/tool-display/tool.ts";
import { FG, fgOf } from "./support/quiet-theme.ts";
import { band, harness, row, text, theme } from "./support/tool-rows.ts";

const strip = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const DAY = 86_400;
// The harness clock starts at 1 s; a page that expires in 30 days from then.
const page = (id: string, extra: object = {}) => ({
	id, title: "MS-01 mini rack", url: `https://artifact.test/${id}/`, inbox_url: `https://inbox.test/#${id}`, private: false,
	expires_at: 1 + 30 * DAY, check: { state: "ok", problems: [] }, ...extra,
});
const withImage = (body: string, details: object) => ({ content: [{ type: "text", text: body }, { type: "image", data: "AA==", mimeType: "image/jpeg" }], details });

function draw(name: string, args: object, result: object, options: { width?: number; expanded?: boolean } = {}) {
	const h = harness();
	const shown = row(toolRenderers(h.kit, ARTIFACT_SPECS[name]!) as never, args);
	shown.update({ isPartial: false, expanded: options.expanded ?? false, result });
	return { h, shown, lines: shown.lines(options.width ?? 80) };
}

test("each declared artifact tool has a row of its own; the old names keep the generic band, and every artifact row hides images", () => {
	assert.deepEqual(Object.keys(ARTIFACT_SPECS).sort(), ["artifact_ask", "artifact_check", "artifact_feedback", "artifact_find", "artifact_publish"]);
	for (const name of ["artifact_new", "artifact_answers", "artifact_comments"]) assert.equal(ARTIFACT_SPECS[name], undefined);
	assert.ok(isArtifactTool("artifact_new") && isArtifactTool("artifact_publish") && !isArtifactTool("read"));
});

test("a published page: its address, when it expires and its check under the band; the image is a line, never drawn", () => {
	const problem = "the page has no dark theme: it stays light when the reader's system is dark";
	const details = { tool: "publish", update: false, template: null, watching: true,
		pages: [page("7rv5", { check: { state: "problems", problems: [problem], sheet: "/tmp/artifact-sheets/7rv5.jpg" } })] };
	const { lines, shown, h } = draw("artifact_publish", { path: "/work/ms01-minirack", title: "MS-01 mini rack", expires: "30d" }, withImage("Published: …", details));
	assert.deepEqual(lines, [
		band("publish MS-01 mini rack", "", 80),
		"    https://artifact.test/7rv5/",
		"    expires in 30d, check: 1 problem, check image sent to the model",
		`    ${problem}`,
	], "a single problem takes the row a hint would take");
	assert.ok(shown.raw(80)[1]!.includes(`${fgOf(FG.accent!)}https://artifact.test/7rv5/`), "the address stands out");
	assert.doesNotMatch(lines.join("\n"), /artifact-sheets/, "the image's file is for the expanded view");
	shown.click();
	const output = strip(h.popups.at(-1)!.output(theme, 100, 0));
	assert.ok(output.includes("check image: /tmp/artifact-sheets/7rv5.jpg"));
	assert.ok(output.includes("Published: …"), "the popup ends with the text the model got");
	const copies = h.popups.at(-1)!.copies!(0);
	assert.equal(copies[0]!.label, "copy URL");
	assert.equal(copies[0]!.text(), "https://artifact.test/7rv5/");
});

test("problems fold into a hint, and ctrl+o shows each with the kept image", () => {
	const details = { tool: "publish", update: true, template: "markdown", watching: false,
		pages: [page("r1", { check: { state: "problems", problems: ["low contrast", "a broken image"], sheet: "/tmp/artifact-sheets/r1.jpg" } })] };
	const collapsed = draw("artifact_publish", { markdown: "# R", update: "r1" }, withImage("…", details)).lines;
	assert.deepEqual(collapsed, [
		band("publish report, new version", "", 80),
		"    https://artifact.test/r1/",
		"    expires in 30d, check: 2 problems, watch off, check image sent to the model",
		"    … 2 problems (click for all)",
	]);
	const expanded = draw("artifact_publish", { markdown: "# R", update: "r1" }, withImage("…", details), { expanded: true }).lines;
	assert.deepEqual(expanded.slice(3), ["    low contrast", "    a broken image", "    check image: /tmp/artifact-sheets/r1.jpg"]);
});

test("a private page shows its inbox link; a split gallery lists its first pages", () => {
	const priv = draw("artifact_publish", { html: "<h1>x</h1>", title: "Plan", private: true },
		text("…", { tool: "publish", update: false, template: null, watching: true, pages: [page("p1", { private: true })] })).lines;
	assert.deepEqual(priv.slice(0, 2), [band("publish Plan, private", "", 80), "    https://inbox.test/#p1"]);
	const pages = [1, 2, 3, 4].map((n) => page(`g${n}`, { page: n }));
	const gallery = draw("artifact_publish", { template: "gallery", inputs: ["shots"], title: "Shots" },
		text("…", { tool: "publish", update: false, template: "gallery", watching: true, pages })).lines;
	assert.deepEqual(gallery, [
		band("publish Shots, 4 pages", "", 80),
		"    page 1  https://artifact.test/g1/",
		"    page 2  https://artifact.test/g2/",
		"    … 2 more pages (click for all)",
		"    expires in 30d, check: no problems",
	]);
	const wrote = draw("artifact_publish", { template: "motion", inputs: ["s.html"], output: "clip" },
		text("Wrote /work/clip.", { tool: "publish", wrote: "/work/clip", template: "motion" })).lines;
	assert.deepEqual(wrote, [band("publish motion", "", 80), "    wrote /work/clip"]);
});

test("an ask row counts its questions and shows the form and its page, with no image", () => {
	const details = { tool: "ask", update: false, title: "Media library", questions: 4, watching: true,
		form: page("f1", { role: "form", title: "Media library" }), page: page("p1", { role: "page", title: "Media library" }) };
	const args = { title: "Media library: four open decisions", questions: [{}, {}, {}, {}], page: "# Plan" };
	assert.deepEqual(draw("artifact_ask", args, text("Form: …", details)).lines, [
		band("ask Media library: four open decisions, 4 questions", "", 80),
		"    form  https://artifact.test/f1/",
		"    page  https://artifact.test/p1/",
		"    expires in 30d, check: no problems, watching for answers",
	]);
	const bad = { ...details, page: page("p1", { role: "page", check: { state: "problems", problems: ["low contrast"] } }) };
	assert.equal(draw("artifact_ask", args, text("…", bad), { width: 100 }).lines[3], "    expires in 30d, form check: no problems, page check: 1 problem, watching for answers");
});

test("rows of an older artifact extension, whose details are {}, show the text and never throw", () => {
	const old = "Form: https://a/f1/ (id f1). It links to the page.\nPage: https://a/p1/ (id p1).\nExpires 2026-10-27T21:28:06Z.\nform check: no problems.\npage check: no problems.\nGive the user the form URL.";
	for (const name of Object.keys(ARTIFACT_SPECS)) {
		const { lines } = draw(name, { title: "T", query: "q", id: "x", target: "t" }, withImage(old, {}));
		assert.equal(lines.length, 6, `${name}: band, 4 lines and a hint`);
		assert.equal(lines[1], "    Form: https://a/f1/ (id f1). It links to the page.");
		assert.equal(lines[5], "    … 2 more lines (click for all)");
	}
	const partial = row(toolRenderers(harness().kit, ARTIFACT_SPECS.artifact_publish!) as never, {});
	partial.update({ isPartial: true, executionStarted: true, result: text("", { tool: "publish" }) });
	assert.equal(partial.lines(80).length, 1, "a running call has only its band");
	const broken = draw("artifact_publish", { title: "T" }, text("", { tool: "publish", pages: [null, { id: 3 }, "x"] })).lines;
	assert.deepEqual(broken, [band("publish T", "", 80)], "details of the wrong shape show nothing rather than throw");
	const failed = row(toolRenderers(harness().kit, ARTIFACT_SPECS.artifact_publish!) as never, { title: "T" });
	failed.update({ isPartial: false, isError: true, result: text("artifact failed (exit 2):\nno such file") });
	assert.deepEqual(failed.lines(80), [band("publish T", "failed", 80), "    artifact failed (exit 2):", "    no such file"]);
});

test("at 40 columns a long title is cut in the band and every line fits", () => {
	const details = { tool: "ask", update: false, title: "x", questions: 4, watching: true,
		form: page("formid", { role: "form" }), page: page("pageid", { role: "page" }) };
	const { lines, shown } = draw("artifact_ask", { title: "A very long form title that never fits in forty columns", questions: [1, 2, 3, 4] }, text("…", details), { width: 40 });
	assert.match(lines[0]!, /^● ask A very long form title that neve…$/);
	for (const line of shown.raw(40)) assert.ok(visibleWidth(line) <= 40, `fits: ${stripTerminalSequences(line)}`);
});

test("feedback rows count what came back and list it one line each", () => {
	const changes = [{ kind: "answer", artifact_id: "f1", title: "MS-01 10G network plan" }, { kind: "comment", artifact_id: "p1", title: "Q3 report" }];
	assert.deepEqual(draw("artifact_feedback", { wait_seconds: 60 }, text("…", { tool: "feedback", mode: "new", waited: 60, watched: 3, changes, again: [] })).lines, [
		band("feedback waits up to 60s, 1 answer, 1 comment", "", 80),
		"    answer  MS-01 10G network plan",
		"    comment  Q3 report",
	]);
	assert.deepEqual(draw("artifact_feedback", {}, text("…", { tool: "feedback", mode: "new", waited: 0, watched: 2, changes: [], again: [changes[0]] })).lines, [
		band("feedback, nothing new", "", 80),
		"    nothing new, watching 2 artifacts",
		"    sent before: answer  MS-01 10G network plan",
	]);
	assert.deepEqual(draw("artifact_feedback", { id: "f1" }, text("…", { tool: "feedback", mode: "read", id: "f1", answers: 2, threads: 1 })).lines,
		[band("feedback f1", "", 80), "    2 answers, 1 open thread"]);
	assert.deepEqual(draw("artifact_feedback", { id: "f1", reply_to: 3, text: "Done.", resolve: true },
		text("replied to thread 3\nmore", { tool: "feedback", mode: "reply", id: "f1", thread: 3, resolved: true })).lines,
	[band("feedback reply to thread 3 on f1", "", 80), "    replied to thread 3"]);
});

test("a search lists one line for each hit, cut at the width; a read names the artifact and how much it read", () => {
	const hits = [1, 2, 3, 4, 5].map((n) => ({ id: `a${n}`, title: `Latency report ${n}`, kind: "report", match: n === 2 ? "answer" : "text",
		snippet: "after the cache fix the p99 dropped from 800 ms to 120 ms in every region", updated_at: 1 }));
	const search = draw("artifact_find", { query: "cache fix" }, text("…", { tool: "find", mode: "search", query: "cache fix", offset: 0, more: true, hits })).lines;
	assert.equal(search[0], band("find artifacts cache fix, 5 results, more", "", 80));
	assert.equal(search[2], "    Latency report 2  report, answer  after the cache fix the p99 dropped from …");
	assert.equal(search.length, 5);
	assert.equal(search[4], "    … 2 more results (click for all)");
	const none = draw("artifact_find", { query: "zzz" }, text("…", { tool: "find", mode: "search", query: "zzz", offset: 0, more: false, hits: [] })).lines;
	assert.deepEqual(none, [band("find artifacts zzz, no results", "", 80), "    no results"]);
	const read = draw("artifact_find", { id: "aaa", rev: 2 }, text("…", { tool: "find", mode: "read", id: "aaa", title: "Plan", kind: "report",
		url: "https://a/aaa/", offset: 0, end: 5, total: 12, more: true, rev: 2, current: 5, answers: 1, threads: 0 })).lines;
	assert.deepEqual(read, [band("read artifact Plan", "", 80), "    https://a/aaa/", "    report, version 2 of 5, characters 0 to 5 of 12, 1 answer, 0 open threads"]);
});

test("a check row names its problems in the band and lists them, with a line for the image", () => {
	const details = { tool: "check", target: "site", problems: ["low contrast [phone dark]", "a broken image"], sheet: "/tmp/artifact-sheets/check-1.jpg" };
	const { lines } = draw("artifact_check", { target: "site" }, withImage("…", details));
	assert.deepEqual(lines, [band("check site, 2 problems", "", 80), "    low contrast [phone dark]", "    a broken image", "    check image sent to the model"]);
	assert.equal(draw("artifact_check", { target: "site" }, withImage("…", details), { expanded: true }).lines.at(-1), "    check image: /tmp/artifact-sheets/check-1.jpg");
	assert.equal(draw("artifact_check", { target: "site" }, withImage("…", { ...details, problems: [] })).lines[0], band("check site, no problems", "", 80));
});

test("an expiry reads in the coarsest unit that says enough", () => {
	assert.equal(expiryText(null, 0), "no expiry");
	assert.equal(expiryText(10, 20_000), "expired");
	assert.equal(expiryText(90 * 60, 0), "expires in 90m");
	assert.equal(expiryText(5 * 3600, 0), "expires in 5h");
	assert.equal(expiryText(14 * DAY, 0), "expires in 14d");
});
