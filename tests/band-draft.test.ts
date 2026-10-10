import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { draftRail, draftPreview, flowing, noteDraft, writingText } from "../lib/band/draft.ts";

const theme = { fg: (_key: string, text: string) => text };
const plain = (segs: ReadonlyArray<{ text: string }>) => segs.map((seg) => seg.text).join("");

test("a draft counts its arguments, and flows only while they grow", () => {
	let draft = noteDraft(undefined, {}, 1000);
	assert.equal(draft.chars, 0, "a call that has started, with no arguments yet");
	assert.equal(flowing(draft, 1000), false);
	const args = { name: "range-review" };
	draft = noteDraft(draft, args, 1500);
	assert.equal(draft.chars, JSON.stringify(args).length);
	assert.equal(flowing(draft, 1800), true);
	assert.equal(flowing(noteDraft(draft, { ...args }, 2000), 2000), false, "the same arguments again do not flow");
	assert.equal(draft.startedAt, 1000, "the clock counts from the start of the call");
});

test("the text written now is the last string; between values, the last long one", () => {
	const task = "Review the byte-range support in this small file server.";
	assert.equal(writingText({ name: "range-review", task: "Review" }), "Review");
	assert.equal(writingText({ name: "range-review", task, readOnly: true }), task, "a flag after the brief keeps the brief");
	assert.equal(writingText({ path: "lib/live-rate.ts", edits: [{ oldText: "const a = 1;", newText: "const b" }] }), "const b", "any depth");
	assert.equal(writingText({ maxMinutes: 25 }), "");
});

test("the rail says writing, the size so far and the time", () => {
	const draft = noteDraft(noteDraft(undefined, {}, 0), { task: "x".repeat(1190) }, 500);
	assert.equal(plain(draftRail(draft, 6200)), "writing   1,201 chars   6.2s");
	assert.equal(plain(draftRail(noteDraft(undefined, {}, 0), 4100)), "writing   4.1s", "a held call has no size");
});

test("the preview is the newest lines of the text, with a caret after the last", () => {
	const text = "one two three four five six seven eight nine ten";
	const draft = noteDraft(undefined, { task: text }, 0);
	const lines = draftPreview(draft, 15, 5000, theme, "full").map(stripTerminalSequences);
	assert.deepEqual(lines, ["seven eight", "nine ten▍"]);
	assert.deepEqual(draftPreview(noteDraft(undefined, {}, 0), 40, 0, theme, "full"), [], "nothing to show yet");
	assert.equal(draftPreview(noteDraft(undefined, { task: "a\x1b[2Jb\tc" }, 0), 40, 0, theme, "full")[0], "ab  c▍", "control characters go");
});
