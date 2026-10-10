import assert from "node:assert/strict";
import test from "node:test";
import { PEN_FRAMES } from "../lib/band/glyph.ts";
import { editSpec, writeSpec } from "../lib/tool-display/files.ts";
import { toolRenderers } from "../lib/tool-display/tool.ts";
import { harness, row } from "./support/tool-rows.ts";

const brief = "one two three four five six seven eight nine ten";

test("a call written now shows a pen, its size and time, and its newest lines under the band", () => {
	const h = harness();
	const edit = row(toolRenderers(h.kit, editSpec) as never, {});
	edit.update({ argsComplete: false, args: {} });
	h.advance(4_100);
	let lines = edit.lines(40);
	assert.equal(lines.length, 1, "a held call has nothing to preview");
	assert.ok(PEN_FRAMES.includes(lines[0]![0]!), `a pen in the margin, not ${lines[0]![0]}`);
	assert.match(lines[0]!, /writing   4\.1s$/);
	const args = { path: "lib/a.ts", edits: [{ oldText: "const a = 1;", newText: brief }] };
	edit.update({ argsComplete: false, args });
	h.advance(200);
	lines = edit.lines(40);
	assert.match(lines[0]!, new RegExp(`writing   ${JSON.stringify(args).length} chars   4\\.3s$`));
	assert.deepEqual(lines.slice(1), ["    one two three four five six seven", "    eight nine ten▍"]);
	edit.update({ argsComplete: true, args });
	lines = edit.lines(40);
	assert.equal(lines.length, 1, "the preview goes once the arguments are complete");
	assert.match(lines[0]!, /queued$/);
});

test("a row that shows its own lines while written keeps them, and a call rebuilt from history shows no draft", () => {
	const h = harness();
	const write = row(toolRenderers(h.kit, writeSpec) as never, {});
	write.update({ argsComplete: false, args: { path: "a.md", content: brief } });
	assert.ok(!write.lines(40).some((line) => line.endsWith("▍")), "write draws the file itself");
	const old = row(toolRenderers({ ...h.kit, streaming: () => false }, editSpec) as never, {});
	old.update({ argsComplete: false, args: { path: "a.ts", edits: [{ oldText: "a", newText: brief }] } });
	assert.deepEqual(old.lines(40).length, 1);
	assert.doesNotMatch(old.lines(40)[0]!, /writing/);
	let streaming = true;
	const cut = row(toolRenderers({ ...h.kit, streaming: () => streaming }, editSpec) as never, {}, "call-3");
	cut.update({ argsComplete: false, args: { path: "a.ts", edits: [{ oldText: "a", newText: brief }] } });
	assert.equal(cut.lines(40).length, 3);
	streaming = false;
	h.advance(5_000);
	cut.update({ argsComplete: false, args: { path: "a.ts", edits: [{ oldText: "a", newText: brief }] } });
	assert.deepEqual(cut.lines(40), ["  edit a.ts"], "its message ended: no pen, clock or preview");
});

test("an earlier call of a message reads as queued once the model has written it, while it writes the next", () => {
	const h = harness();
	const done = new Set<string>();
	const kit = { ...h.kit, written: (id: string) => done.has(id) };
	const first = row(toolRenderers(kit, editSpec) as never, {}, "call-1");
	first.update({ argsComplete: false, args: { path: "a.ts", edits: [{ oldText: "a", newText: brief }] } });
	assert.equal(first.lines(40).length, 3);
	done.add("call-1");
	h.advance(1_000);
	h.tick();
	assert.deepEqual(first.lines(40), [first.lines(40)[0]!], "no preview");
	assert.match(first.lines(40)[0]!, /^● edit a\.ts +queued$/);
});
