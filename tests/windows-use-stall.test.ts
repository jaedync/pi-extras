import assert from "node:assert/strict";
import test from "node:test";
import { readFront } from "../lib/windows-use/stall.ts";

test("the front window is read from the guest's JSON, and no window in front (the Idle process) is none", () => {
	assert.deepEqual(readFront('Response: {"process":"mmc","title":"Console","responding":false}\n\nStatus Code: 0'), { process: "mmc", title: "Console", responding: false });
	assert.equal(readFront('Response: {"process":"Idle","title":"","responding":true}\n\nStatus Code: 0'), undefined);
	assert.equal(readFront("Response: \n\nStatus Code: 0"), undefined);
	assert.equal(readFront("Response: {not json}"), undefined);
});
