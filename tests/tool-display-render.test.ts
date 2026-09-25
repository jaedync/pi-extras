import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { editRenderers, readRenderers, writeRenderers } from "../lib/tool-display/files.ts";
import type { Kit, RenderContext } from "../lib/tool-display/kit.ts";
import { searchRenderers } from "../lib/tool-display/search.ts";
import { bashRenderers } from "../lib/tool-display/shell.ts";
import type { Density } from "../lib/tool-display/slot.ts";

const theme = { fg: (_key: string, text: string) => text, bg: (_key: string, text: string) => text, bold: (text: string) => text };

function harness(options: { density?: Density } = {}) {
	let density: Density = options.density ?? "boxed";
	let now = 1_000;
	const kit: Kit = {
		density: () => density,
		hint: () => "ctrl+o to expand",
		highlight: (code) => code.split("\n"),
		language: () => undefined,
		diff: (diff) => diff,
		link: (styled) => styled,
		now: () => now,
	};
	return {
		kit,
		setDensity: (next: Density) => { density = next; },
		advance: (ms: number) => { now += ms; },
	};
}

type Renderers = {
	renderCall(args: unknown, theme: unknown, context: RenderContext): Component;
	renderResult(result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: unknown, context: RenderContext): Component;
};

/** Mimics Pi's tool row: the call slot, then the result slot once there is a result. */
function row(renderers: Renderers, args: unknown) {
	const state: Record<string, unknown> = {};
	let call: Component | undefined;
	let result: Component | undefined;
	let invalidations = 0;
	const context = (over: Partial<RenderContext>, last: unknown): RenderContext => ({
		args, state, lastComponent: last, cwd: "/work", executionStarted: false, argsComplete: true,
		isPartial: true, expanded: false, isError: false, invalidate: () => { invalidations++; }, ...over,
	});
	return {
		update(over: Partial<RenderContext> & { result?: unknown } = {}) {
			const { result: value, ...rest } = over;
			call = renderers.renderCall(args, theme, context(rest, call));
			if (value !== undefined) {
				result = renderers.renderResult(value, { expanded: rest.expanded ?? false, isPartial: rest.isPartial ?? true }, theme, context(rest, result));
			}
		},
		lines(width = 60) {
			return [...(call?.render(width) ?? []), ...(result?.render(width) ?? [])].map((line) => stripTerminalSequences(line).trimEnd());
		},
		invalidations: () => invalidations,
	};
}

/** Boxed rows indent their content by the box padding. */
const boxed = (...lines: string[]) => lines.map((line) => (line ? ` ${line}` : line));
const text = (value: string, details?: unknown) => ({ content: [{ type: "text", text: value }], details });

test("a bash row shows a multi-line command collapsed, then its run time and output tail", () => {
	const h = harness();
	const bash = row(bashRenderers(h.kit), { command: "cd app\nnpm ci\nnpm test\nnpm run lint\necho done" });
	bash.update({ executionStarted: true });
	assert.deepEqual(bash.lines(), boxed(
		"",
		"$ cd app · 0.0s",
		"  npm ci",
		"  npm test",
		"  … 2 more lines (ctrl+o to expand)",
		"",
	));
	h.advance(4_200);
	const output = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
	bash.update({ executionStarted: true, isPartial: false, result: text(output) });
	assert.deepEqual(bash.lines(), boxed(
		"",
		"$ cd app · 4.2s",
		"  npm ci",
		"  npm test",
		"  … 2 more lines (ctrl+o to expand)",
		"",
		"… 3 earlier lines (ctrl+o to expand)",
		"line 4",
		"line 5",
		"line 6",
		"line 7",
		"line 8",
		"",
	));
	bash.update({ executionStarted: true, isPartial: false, expanded: true, result: text(output) });
	assert.equal(bash.lines().filter((line) => line.startsWith(" line ")).length, 8);
	assert.ok(bash.lines().includes("   echo done"));
});

test("a failed bash row puts the exit code in the header instead of the output", () => {
	const h = harness();
	const bash = row(bashRenderers(h.kit), { command: "false", timeout: 600 });
	bash.update({ executionStarted: true });
	h.advance(300);
	bash.update({ executionStarted: true, isPartial: false, isError: true, result: text("oops\n\nCommand exited with code 1") });
	assert.deepEqual(bash.lines(), boxed("", "$ false · timeout 600s · exit 1 · 0.3s", "", "oops", ""));
});

test("the header keeps its metadata when a long command is cut to the width", () => {
	const h = harness();
	const bash = row(bashRenderers(h.kit), { command: `grep -rn ${"x".repeat(80)} .` });
	bash.update({ executionStarted: true, isPartial: false, result: text("(no output)") });
	const [, head] = bash.lines(40);
	assert.equal(head, " $ grep -rn xxxxxxxxxxxxxxxxxxx… · 0.0s");
	assert.equal(bash.lines(40).length, 1 + 1 + 1, "no output adds only the closing padding");
});

test("compact rows lead with a status mark and drop the box padding", () => {
	const h = harness({ density: "compact" });
	const read = row(readRenderers(h.kit), { path: "src/app.ts" });
	read.update();
	assert.deepEqual(read.lines(), ["○ read src/app.ts"]);
	read.update({ isPartial: false, result: text("a\nb\nc") });
	assert.deepEqual(read.lines(), ["✓ read src/app.ts · 3 lines"]);
	// The same row redraws in the other density without being rebuilt.
	h.setDensity("boxed");
	assert.deepEqual(read.lines(), boxed("", "read src/app.ts · 3 lines", ""));
	h.setDensity("compact");
	const failed = row(bashRenderers(h.kit), { command: "exit 3" });
	failed.update({ isPartial: false, isError: true, result: text("Command exited with code 3") });
	assert.deepEqual(failed.lines(), ["✗ $ exit 3 · exit 3"]);
});

test("a read reports partial reads, images, skills and errors", () => {
	const h = harness();
	const partial = row(readRenderers(h.kit), { path: "big.ts", offset: 1, limit: 2 });
	partial.update({ isPartial: false, result: text("a\nb\n\n[98 more lines in file. Use offset=3 to continue.]") });
	assert.equal(partial.lines()[1], " read big.ts:1-2 · 2 of 100 lines");
	const image = row(readRenderers(h.kit), { path: "shot.png" });
	image.update({ isPartial: false, result: { content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: "", mimeType: "image/png" }] } });
	assert.equal(image.lines()[1], " read shot.png · image");
	const skill = row(readRenderers(h.kit), { path: "/skills/blender/SKILL.md" });
	skill.update({ isPartial: false, result: text("x") });
	assert.equal(skill.lines()[1], " skill blender · 1 line");
	const missing = row(readRenderers(h.kit), { path: "nope" });
	missing.update({ isPartial: false, isError: true, result: text("ENOENT: no such file") });
	assert.deepEqual(missing.lines(), boxed("", "read nope", "", "ENOENT: no such file", ""));
	const expanded = row(readRenderers(h.kit), { path: "a.txt" });
	expanded.update({ isPartial: false, expanded: true, result: text("one\ntwo\n") });
	assert.deepEqual(expanded.lines(), boxed("", "read a.txt · 2 lines", "", "one", "two", ""));
});

test("an edit shows added and removed counts and collapses a long diff", () => {
	const h = harness();
	const diff = Array.from({ length: 30 }, (_, index) => `+${index + 1} new ${index}`).concat(["-31 old"]).join("\n");
	const edit = row(editRenderers(h.kit), { path: "a.ts", edits: [{ oldText: "x", newText: "y" }, { oldText: "p", newText: "q" }] });
	edit.update();
	assert.equal(edit.lines()[1], " edit a.ts · 2 edits");
	edit.update({ isPartial: false, result: text("ok", { diff }) });
	const lines = edit.lines();
	assert.equal(lines[1], " edit a.ts · +30 −1");
	assert.equal(lines.filter((line) => line.startsWith(" +")).length, 20);
	assert.equal(lines.at(-2), " … 11 more diff lines (ctrl+o to expand)");
	edit.update({ isPartial: false, expanded: true, result: text("ok", { diff }) });
	assert.equal(edit.lines().filter((line) => /^ [+-]\d/.test(line)).length, 31);
});

test("a write shows its line count and a preview of the file", () => {
	const h = harness();
	const content = Array.from({ length: 14 }, (_, index) => `row ${index}`).join("\n");
	const write = row(writeRenderers(h.kit), { path: "out.txt", content });
	write.update({ argsComplete: false });
	assert.equal(write.lines()[1], " write out.txt · 14 lines…");
	write.update({ isPartial: false, result: text("Successfully wrote") });
	const lines = write.lines();
	assert.equal(lines[1], " write out.txt · 14 lines");
	assert.equal(lines[2], "");
	assert.equal(lines[3], " row 0");
	assert.equal(lines.at(-2), " … 4 more lines (ctrl+o to expand)");
	// A row replayed from a saved session has its result but was never marked complete.
	const replayed = row(writeRenderers(h.kit), { path: "out.txt", content });
	replayed.update({ argsComplete: false, isPartial: false, result: text("Successfully wrote") });
	assert.equal(replayed.lines()[1], " write out.txt · 14 lines");
});

test("grep, find and ls summarize what they found and list it only when expanded", () => {
	const h = harness();
	const grep = row(searchRenderers(h.kit, "grep"), { pattern: "foo", path: "src", glob: "*.ts" });
	grep.update({ isPartial: false, result: text("src/a.ts:1: foo\nsrc/b.ts:2: foo\nsrc/b.ts:9: foo") });
	assert.deepEqual(grep.lines(), boxed("", "grep /foo/ in src (*.ts) · 3 matches in 2 files", ""));
	grep.update({ isPartial: false, expanded: true, result: text("src/a.ts:1: foo\nsrc/b.ts:2: foo\nsrc/b.ts:9: foo") });
	assert.equal(grep.lines().length, 3 + 1 + 3);
	const none = row(searchRenderers(h.kit, "grep"), { pattern: "zzz" });
	none.update({ isPartial: false, result: text("No matches found") });
	assert.equal(none.lines()[1], " grep /zzz/ in . · no matches");
	const find = row(searchRenderers(h.kit, "find"), { pattern: "*.md" });
	find.update({ isPartial: false, result: text("a.md\nb.md\n\n[2 results limit reached]") });
	assert.equal(find.lines()[1], " find *.md in . · 2 files · limit reached");
	const ls = row(searchRenderers(h.kit, "ls"), {});
	ls.update({ isPartial: false, result: text("a/\nb.ts\nc/") });
	assert.equal(ls.lines()[1], " ls . · 3 entries (2 dirs)");
});

test("agent text cannot inject terminal escapes into a row", () => {
	const h = harness();
	const bash = row(bashRenderers(h.kit), { command: "echo \x1b]0;pwned\x07hi" });
	bash.update({ isPartial: false, result: text("\x1b[2Jcleared") });
	assert.ok(bash.lines().every((line) => !line.includes("\x1b")));
});
