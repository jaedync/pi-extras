import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ChainRun } from "../lib/chain/run.ts";
import { splitChain } from "../lib/chain/split.ts";
import { editRenderers, readRenderers, writeRenderers } from "../lib/tool-display/files.ts";
import { searchRenderers } from "../lib/tool-display/search.ts";
import { bashRenderers } from "../lib/tool-display/shell.ts";
import { band, harness, row, text, theme } from "./support/tool-rows.ts";

test("a bash row runs against its timeout, then keeps the time and the last lines of output", () => {
	const h = harness();
	const bash = row(bashRenderers(h.kit), { command: "cd app\nnpm ci\nnpm test\nnpm run lint\necho done", timeout: 120 });
	bash.update({ argsComplete: false });
	assert.deepEqual(bash.lines(), [band("$ cd app  +4 lines")]);
	bash.update();
	assert.deepEqual(bash.lines(), [band("$ cd app  +4 lines", "queued")]);
	bash.update({ executionStarted: true });
	h.advance(8_600);
	bash.update({ executionStarted: true });
	assert.deepEqual(bash.lines(), [band("$ cd app  +4 lines", "8.6s / 120s")]);
	h.advance(3_400);
	const output = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
	bash.update({ executionStarted: true, isPartial: false, result: text(output) });
	assert.deepEqual(bash.lines(), [
		band("$ cd app  +4 lines", "12.0s"),
		"   … 4 earlier lines (click for all)",
		"   line 5",
		"   line 6",
		"   line 7",
		"   line 8",
	]);
	bash.update({ executionStarted: true, isPartial: false, expanded: true, result: text(output) });
	const expanded = bash.lines();
	assert.equal(expanded.filter((line) => line.startsWith("   line ")).length, 8);
	assert.ok(expanded.includes("   echo done"), "expanded, the whole command shows under the band");
});

test("a failed bash row says how it ended in the rail, not in the output", () => {
	const h = harness();
	const bash = row(bashRenderers(h.kit), { command: "false" });
	bash.update({ executionStarted: true });
	h.advance(300);
	bash.update({ executionStarted: true, isPartial: false, isError: true, result: text("oops\n\nCommand exited with code 1") });
	assert.deepEqual(bash.lines(), [band("$ false", "exit 1  300ms"), "   oops"]);
	const slow = row(bashRenderers(h.kit), { command: "sleep 99", timeout: 5 });
	slow.update({ executionStarted: true });
	h.advance(5_000);
	slow.update({ executionStarted: true, isPartial: false, isError: true, result: text("Command timed out after 5 seconds") });
	assert.deepEqual(slow.lines(), [band("$ sleep 99", "timed out  5.0s")]);
});

test("a long command is cut to fit and the rail stays whole", () => {
	const h = harness();
	const bash = row(bashRenderers(h.kit), { command: `grep -rn ${"x".repeat(80)} .` });
	bash.update({ executionStarted: true });
	h.advance(12_300);
	bash.update({ executionStarted: true, isPartial: false, result: text("(no output)") });
	const [head] = bash.lines(40);
	assert.equal(head!.length, 39);
	assert.ok(head!.endsWith("…  12.3s"), head);
	assert.equal(bash.lines(40).length, 1, "no output adds nothing under the band");
});

test("a row replayed from history has no times", () => {
	const h = harness();
	const bash = row(bashRenderers(h.kit), { command: "ls" });
	bash.update({ isPartial: false, result: text("a\nb") });
	assert.deepEqual(bash.lines(), [band("$ ls"), "   a", "   b"]);
});

test("a chained command gets a line per step, with output under the step that matters", () => {
	const h = harness();
	const command = "cd src && npm run lint && npm test && npm run build";
	const run = new ChainRun(splitChain(command)!, h.now());
	h.runs.set("call-1", run);
	const bash = row(bashRenderers(h.kit), { command, timeout: 120 });
	bash.update({ executionStarted: true });
	for (const step of [0, 1]) {
		run.mark({ kind: "start", step }, h.now());
		run.write(step === 1 ? "lint clean\n" : "");
		h.advance(step === 0 ? 5 : 1_400);
		run.mark({ kind: "end", step, code: 0 }, h.now());
	}
	run.mark({ kind: "start", step: 2 }, h.now());
	run.write(["✓ one", "✓ two", "✓ three", "✓ four"].join("\n") + "\n");
	h.advance(600);
	bash.update({ executionStarted: true });
	assert.deepEqual(bash.lines(), [
		" $ cd src && npm run lint && npm tes…  2 of 3   2.0s / 120s",
		"    1  npm run lint                                    1.4s",
		"    2  npm test                                       600ms",
		"        … 1 earlier line (click for all)",
		"        ✓ two",
		"        ✓ three",
		"        ✓ four",
		"    3  npm run build",
	]);
	run.mark({ kind: "end", step: 2, code: 1 }, h.now());
	run.finish("fail", h.now());
	bash.update({ executionStarted: true, isPartial: false, isError: true, result: text("…\n\nCommand exited with code 1") });
	const done = bash.lines();
	assert.ok(done[0]!.endsWith("exit 1 at 2 of 3  2.0s"), JSON.stringify(done[0]));
	assert.ok(done.some((line) => /^ {4}3 +npm run build +skipped$/.test(line)), done.join("\n"));
	assert.ok(done.some((line) => /^ {4}2 +npm test +exit 1 +600ms$/.test(line)), done.join("\n"));
});

test("a || fallback that ran reads as handled, and the chain as a success", () => {
	const h = harness();
	const command = "grep -q NOPE a.ts || echo none";
	const run = new ChainRun(splitChain(command)!, h.now());
	h.runs.set("call-1", run);
	run.mark({ kind: "start", step: 0 }, h.now());
	run.mark({ kind: "end", step: 0, code: 1 }, h.now() + 5);
	run.mark({ kind: "start", step: 1 }, h.now() + 5);
	run.write("none\n");
	run.mark({ kind: "end", step: 1, code: 0 }, h.now() + 6);
	run.finish("ok", h.now() + 6);
	const bash = row(bashRenderers(h.kit), { command });
	bash.update({ executionStarted: true });
	h.advance(6);
	bash.update({ executionStarted: true, isPartial: false, result: text("none") });
	const lines = bash.lines();
	assert.ok(lines[0]!.endsWith("2 commands   6ms"), lines[0]);
	assert.match(lines[1]!, /^ {3} 1 +grep -q NOPE a\.ts +exit 1 +5ms$/);
	assert.match(lines[2]!, /^ {3} 2 +echo none +1ms$/);
	assert.equal(lines[3], "        none");
});

test("a running row animates until its finish settles, then stops asking for frames", () => {
	const h = harness();
	const bash = row(bashRenderers(h.kit), { command: "sleep 1" });
	bash.update({ executionStarted: true });
	bash.lines();
	assert.ok(h.running(), "a running band asks for frames");
	const before = bash.invalidations();
	h.tick();
	assert.equal(bash.invalidations(), before + 1);
	h.advance(1_000);
	bash.update({ executionStarted: true, isPartial: false, result: text("") });
	bash.lines();
	assert.ok(h.running(), "the finish flashes for a moment");
	h.advance(900);
	h.tick();
	bash.lines();
	assert.equal(h.running(), false);
});

test("a click on a row opens its popup with the whole command and output", () => {
	const h = harness();
	const bash = row(bashRenderers(h.kit), { command: "npm ci\nnpm test", timeout: 60 });
	bash.update({ executionStarted: true });
	bash.update({ executionStarted: true, isPartial: false, result: text(Array.from({ length: 30 }, (_, index) => `out ${index}`).join("\n")) });
	bash.lines();
	assert.deepEqual(bash.click(), { handled: true });
	const source = h.popups[0]!;
	assert.equal(source.label(), "bash");
	assert.match(source.details(), /^in \/work · timeout 60s · started \d\d:\d\d:\d\d$/);
	assert.deepEqual(source.head(theme, 40, 0).map((line) => stripTerminalSequences(line)), ["$ npm ci", "  npm test"]);
	assert.equal(source.output(theme, 40, 0).length, 30);
	assert.equal(source.stepCount(), 0);
	assert.equal(source.live(), false);
});

test("a read reports partial reads, images, skills and errors", () => {
	const h = harness();
	const partial = row(readRenderers(h.kit), { path: "big.ts", offset: 1, limit: 2 });
	partial.update({ isPartial: false, result: text("a\nb\n\n[98 more lines in file. Use offset=3 to continue.]") });
	assert.deepEqual(partial.lines(), [band("read big.ts:1-2 · 2 of 100 lines")]);
	const image = row(readRenderers(h.kit), { path: "shot.png" });
	image.update({ isPartial: false, result: { content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: "", mimeType: "image/png" }] } });
	assert.deepEqual(image.lines(), [band("read shot.png · image")]);
	const skill = row(readRenderers(h.kit), { path: "/skills/blender/SKILL.md" });
	skill.update({ isPartial: false, result: text("x") });
	assert.deepEqual(skill.lines(), [band("skill blender · 1 line")]);
	const missing = row(readRenderers(h.kit), { path: "nope" });
	missing.update({ isPartial: false, isError: true, result: text("ENOENT: no such file") });
	assert.deepEqual(missing.lines(), [band("read nope", "failed"), "   ENOENT: no such file"]);
	const expanded = row(readRenderers(h.kit), { path: "a.txt" });
	expanded.update({ isPartial: false, expanded: true, result: text("one\ntwo\n") });
	assert.deepEqual(expanded.lines(), [band("read a.txt · 2 lines"), "   one", "   two"]);
});

test("an edit shows added and removed counts and collapses a long diff", () => {
	const h = harness();
	const diff = Array.from({ length: 30 }, (_, index) => `+${index + 1} new ${index}`).concat(["-31 old"]).join("\n");
	const edit = row(editRenderers(h.kit), { path: "a.ts", edits: [{ oldText: "x", newText: "y" }, { oldText: "p", newText: "q" }] });
	edit.update();
	assert.equal(edit.lines()[0], band("edit a.ts · 2 edits", "queued"));
	edit.update({ isPartial: false, result: text("ok", { diff }) });
	const lines = edit.lines();
	assert.equal(lines[0], band("edit a.ts · +30 −1"));
	assert.equal(lines.filter((line) => line.startsWith("   +")).length, 20);
	assert.equal(lines.at(-1), "   … 11 more diff lines (click for all)");
	edit.update({ isPartial: false, expanded: true, result: text("ok", { diff }) });
	assert.equal(edit.lines().filter((line) => /^ {3}[+-]\d/.test(line)).length, 31);
});

test("a write shows its line count and a preview of the file", () => {
	const h = harness();
	const content = Array.from({ length: 14 }, (_, index) => `row ${index}`).join("\n");
	const write = row(writeRenderers(h.kit), { path: "out.txt", content });
	write.update({ argsComplete: false });
	assert.equal(write.lines()[0], band("write out.txt · 14 lines…"));
	write.update({ isPartial: false, result: text("Successfully wrote") });
	const lines = write.lines();
	assert.equal(lines[0], band("write out.txt · 14 lines"));
	// The end of the file, where a streaming write is, with a count of what is above it.
	assert.deepEqual(lines.slice(1), ["   … 11 earlier lines (click for all)", "   row 11", "   row 12", "   row 13"]);
	write.update({ isPartial: false, expanded: true, result: text("Successfully wrote") });
	assert.equal(write.lines().filter((line) => line.startsWith("   row ")).length, 14);
	// A row replayed from a saved session has its result but was never marked complete.
	const replayed = row(writeRenderers(h.kit), { path: "out.txt", content });
	replayed.update({ argsComplete: false, isPartial: false, result: text("Successfully wrote") });
	assert.equal(replayed.lines()[0], band("write out.txt · 14 lines"));
});

test("everything under a band sits on the theme's tool gray, padded to the full width", () => {
	const h = harness();
	const gray = theme.getBgAnsi("toolPendingBg");
	const bash = row(bashRenderers(h.kit), { command: "echo hi" });
	bash.update({ isPartial: false, executionStarted: true, result: text("hi\nthere") });
	const [head, ...body] = bash.raw(40);
	assert.ok(!head!.startsWith(gray), "the band keeps its own color");
	assert.ok(body.length > 0);
	for (const line of body) {
		assert.ok(line.startsWith(gray), "each body line opens on the gray");
		assert.equal(stripTerminalSequences(line).length, 40);
	}
	const write = row(writeRenderers(h.kit), { path: "a.txt", content: "one\ntwo" });
	write.update({ isPartial: false, result: text("Successfully wrote") });
	assert.ok(write.raw(40).slice(1).every((line) => line.startsWith(gray)));
});

test("grep, find and ls summarize what they found and list it only when expanded", () => {
	const h = harness();
	const found = text("src/a.ts:1: foo\nsrc/b.ts:2: foo\nsrc/b.ts:9: foo");
	const grep = row(searchRenderers(h.kit, "grep"), { pattern: "foo", path: "src", glob: "*.ts" });
	grep.update({ isPartial: false, result: found });
	assert.deepEqual(grep.lines(), [band("grep /foo/ in src (*.ts) · 3 matches in 2 files")]);
	grep.update({ isPartial: false, expanded: true, result: found });
	assert.equal(grep.lines().length, 1 + 3);
	const none = row(searchRenderers(h.kit, "grep"), { pattern: "zzz" });
	none.update({ isPartial: false, result: text("No matches found") });
	assert.equal(none.lines()[0], band("grep /zzz/ in . · no matches"));
	const find = row(searchRenderers(h.kit, "find"), { pattern: "*.md" });
	find.update({ isPartial: false, result: text("a.md\nb.md\n\n[2 results limit reached]") });
	assert.equal(find.lines()[0], band("find *.md in . · 2 files · limit reached"));
	const ls = row(searchRenderers(h.kit, "ls"), {});
	ls.update({ isPartial: false, result: text("a/\nb.ts\nc/") });
	assert.equal(ls.lines()[0], band("ls . · 3 entries (2 dirs)"));
});

test("bands are colored by status: green done, red failed", () => {
	const h = harness();
	const ok = row(bashRenderers(h.kit), { command: "true" });
	ok.update({ executionStarted: true });
	h.advance(2_000);
	ok.update({ executionStarted: true, isPartial: false, result: text("") });
	const bad = row(bashRenderers(h.kit), { command: "false" }, "call-2");
	bad.update({ executionStarted: true });
	bad.update({ executionStarted: true, isPartial: false, isError: true, result: text("Command exited with code 1") });
	h.advance(2_000);
	const bg = (line: string) => /\x1b\[48;2;(\d+);(\d+);(\d+)m/.exec(line)!.slice(1).map(Number);
	const [or, og] = bg(ok.raw()[0]!);
	const [br, bgreen] = bg(bad.raw()[0]!);
	assert.ok(og! > or!, "a success leans green");
	assert.ok(br! > bgreen!, "a failure leans red");
});

test("agent text cannot inject terminal escapes into a row", () => {
	const h = harness();
	const bash = row(bashRenderers(h.kit), { command: "echo \x1b]0;pwned\x07hi" });
	bash.update({ isPartial: false, result: text("\x1b[2Jcleared") });
	for (const line of bash.raw()) {
		assert.ok(!line.includes("\x1b]0;"), "no title escape");
		assert.ok(!line.includes("\x1b[2J"), "no clear-screen escape");
	}
});
