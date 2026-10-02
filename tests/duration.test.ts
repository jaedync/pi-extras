import assert from "node:assert/strict";
import test from "node:test";
import { minutesAndUp } from "../lib/duration.ts";

test("past a minute, a duration is its two coarsest units run together", () => {
	assert.equal(minutesAndUp(60), "1m00s");
	assert.equal(minutesAndUp(1_463), "24m23s");
	assert.equal(minutesAndUp(3_599), "59m59s");
	assert.equal(minutesAndUp(3_600), "1h00m");
	assert.equal(minutesAndUp(6_659), "1h50m");
	assert.equal(minutesAndUp(90_000), "25h00m");
});
