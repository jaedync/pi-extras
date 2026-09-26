import assert from "node:assert/strict";
import test from "node:test";
import { everyFrame, FRAME_MS, REDUCED_FRAME_MS } from "../lib/band/clock.ts";

test("animations share one frame timer, tick together at the same rate, and stop it when all are gone", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const ticks: string[] = [];
	const stops = [
		everyFrame(() => ticks.push("band")),
		everyFrame(() => ticks.push("spinner"), FRAME_MS),
		everyFrame(() => { throw new Error("a broken row"); }),
		everyFrame(() => ticks.push("reduced"), REDUCED_FRAME_MS),
	];
	t.mock.timers.tick(FRAME_MS);
	assert.deepEqual(ticks, ["band", "spinner"], "same-rate animations fire in one pass, past a failing one");
	t.mock.timers.tick(FRAME_MS * 9);
	assert.equal(ticks.filter((tick) => tick === "reduced").length, 1, "a slower rate is a whole number of frames");
	assert.equal(ticks.filter((tick) => tick === "band").length, 10);
	for (const stop of stops) stop();
	const before = ticks.length;
	t.mock.timers.tick(FRAME_MS * 5);
	assert.equal(ticks.length, before);
});

test("a separately loaded copy of the clock ticks on the same timer", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const copy = (await import(`../lib/band/clock.ts?copy=${Date.now()}`)) as typeof import("../lib/band/clock.ts");
	assert.notEqual(copy.everyFrame, everyFrame, "a distinct module instance");
	const order: string[] = [];
	const stopOne = everyFrame(() => order.push("one"));
	const stopTwo = copy.everyFrame(() => order.push("two"));
	t.mock.timers.tick(FRAME_MS);
	assert.deepEqual(order, ["one", "two"]);
	stopOne();
	stopTwo();
});
