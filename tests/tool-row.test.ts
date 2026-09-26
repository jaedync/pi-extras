import assert from "node:assert/strict";
import test from "node:test";
import { markRow, rowKind, TOOL_ROW } from "../lib/tool-row.ts";

test("a mark is a copy of the definition, read back by any copy of the module", () => {
	const definition = { name: "usage", execute: () => undefined };
	const marked = markRow(definition, "usage");
	assert.notEqual(marked, definition);
	assert.equal(rowKind(definition), undefined, "the original is not changed");
	assert.equal(rowKind(marked), "usage");
	assert.equal(rowKind({ ...marked }), "usage", "a spread, as Pi makes of a definition, keeps it");
	assert.equal(TOOL_ROW, Symbol.for("pi-extras.tool-row.v1"));
	assert.equal(rowKind({ [TOOL_ROW]: "sideways" }), undefined, "an unknown mark reads as none");
	assert.equal(rowKind(undefined), undefined);
});
