import assert from "node:assert/strict";
import test from "node:test";
import { everyFrame, FRAME_MS, REDUCED_FRAME_MS } from "../lib/band/clock.ts";

test("the 40ms word sweep does not double the refresh rate of existing tool bands", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const ticks: string[] = [];
	const band = everyFrame(() => ticks.push("band"));
	const sweep = everyFrame(() => ticks.push("sweep"), 40);
	t.after(() => { band(); sweep(); });
	t.mock.timers.tick(40);
	assert.deepEqual(ticks, ["sweep"]);
	t.mock.timers.tick(80);
	assert.deepEqual(ticks, ["sweep", "sweep", "band", "sweep"]);
});

test("the fastest active request owns the timer and sign-off alone really ticks at 40ms",t=>{
 t.mock.timers.enable({apis:["setInterval"]});
 const state=()=> (globalThis as Record<symbol,{period?:number}>)[Symbol.for("pi-extras.frame-ticker.v5")]!;
 const band=everyFrame(()=>{},100);assert.equal(state().period,120);
 const wave=everyFrame(()=>{},40);assert.equal(state().period,40);
 wave();assert.equal(state().period,120);band();assert.equal(state().period,undefined);
});

test("animations share one frame timer, tick together at the same rate, and stop it when all are gone", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const ticks: string[] = [];
	const stops = [
		everyFrame(() => ticks.push("band")),
		everyFrame(() => ticks.push("spinner"), FRAME_MS),
		everyFrame(() => { throw new Error("a broken row"); }),
		everyFrame(() => ticks.push("reduced"), REDUCED_FRAME_MS),
	];
	t.after(()=>{for(const stop of stops)stop();});
	t.mock.timers.tick(FRAME_MS);
	assert.deepEqual(ticks, ["band", "spinner"], "same-rate animations fire in one pass, past a failing one");
	t.mock.timers.tick(REDUCED_FRAME_MS - FRAME_MS);
	assert.equal(ticks.filter((tick) => tick === "reduced").length, 1, "a slower rate is a whole number of frames");
	assert.equal(ticks.filter((tick) => tick === "band").length, Math.floor(REDUCED_FRAME_MS / FRAME_MS));
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
