import assert from "node:assert/strict";
import test from "node:test";
import { shownPath } from "../lib/tool-display/kit.ts";

test("a path shows home as ~ only where home ends at a path separator", (t) => {
	const saved = process.env.HOME;
	t.after(() => { process.env.HOME = saved; });
	process.env.HOME = "/home/al";
	assert.equal(shownPath("/home/al"), "~");
	assert.equal(shownPath("/home/al/notes.md"), "~/notes.md");
	assert.equal(shownPath("/home/alice/secret.txt"), "/home/alice/secret.txt", "another user's home is not ours");
	assert.equal(shownPath("/home/al-backup/x"), "/home/al-backup/x");
});
