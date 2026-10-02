import assert from "node:assert/strict";
import test from "node:test";
import { callPhrase } from "../lib/tool-phrase.ts";

test("a write or edit being written reads as writing or editing the file, never as writing a write call", () => {
	assert.equal(callPhrase("write", { path: "/tmp/notes/main.md", content: "line 1" }), "writing main.md");
	assert.equal(callPhrase("edit", { path: "lib/cc-phase.ts" }), "editing cc-phase.ts");
	assert.equal(callPhrase("write", { path: "C:\\Users\\me\\notes.txt" }), "writing notes.txt");
	// Before the path has streamed in, the verb alone.
	for (const args of [undefined, {}, { path: "" }, { path: 42 }, { path: "dir/" }]) assert.equal(callPhrase("write", args), "writing", JSON.stringify(args));
});

test("any other call is a call being written, named by its tool", () => {
	assert.equal(callPhrase("bash", { command: "ls" }), "writing bash call");
	assert.equal(callPhrase("web_search"), "writing web_search call");
	assert.equal(callPhrase(undefined), "writing a tool call");
	assert.equal(callPhrase(" \u202e "), "writing a tool call");
});

test("names and paths from the model can't move the cursor or run on", () => {
	assert.equal(callPhrase("ba\x1b[31msh\n"), "writing bash call");
	assert.equal(callPhrase("write", { path: "evil\x1b]0;x\x07\u202ename.md" }), "writing evilname.md");
	assert.ok(callPhrase("write", { path: `${"a".repeat(200)}.md` }).length <= "writing ".length + 48);
});
