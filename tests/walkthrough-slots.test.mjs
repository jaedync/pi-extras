import assert from "node:assert/strict";
import test from "node:test";
import { SlotClock, slotDueMs, slotFor } from "../skills/walkthrough-video/scripts/lib/slots.mjs";

test("slotFor floors a wall-clock offset onto a frame slot", () => {
	assert.equal(slotFor(0, 60), 0);
	assert.equal(slotFor(16.6, 60), 0);
	assert.equal(slotFor(16.7, 60), 1);
	assert.equal(slotFor(1000, 60), 60);
	assert.equal(slotFor(1000, 30), 30);
});

test("slotDueMs is the inverse of slotFor at slot boundaries", () => {
	assert.equal(slotDueMs(0, 60), 0);
	assert.equal(slotDueMs(1, 60), 1000 / 60);
	assert.equal(slotDueMs(60, 60), 1000);
});

test("the first take claims slot 0 with no repeats", () => {
	const clock = new SlotClock(60);
	assert.deepEqual(clock.take(0), { slot: 0, repeats: 0 });
	assert.equal(clock.next, 1);
});

test("a take in the next slot repeats nothing", () => {
	const clock = new SlotClock(60);
	clock.take(0);
	assert.deepEqual(clock.take(20), { slot: 1, repeats: 0 });
});

test("a late take repeats the last image for every missed slot", () => {
	const clock = new SlotClock(60);
	clock.take(0);
	// 50 ms is slot 3 while the clock expects slot 1: slots 1 and 2 get the last image.
	assert.deepEqual(clock.take(50), { slot: 3, repeats: 2 });
	assert.equal(clock.next, 4);
});

test("a second take in the same slot is refused", () => {
	const clock = new SlotClock(60);
	clock.take(0);
	assert.equal(clock.take(5), null);
	assert.equal(clock.take(8), null);
});

test("a take before the next slot is due is refused", () => {
	const clock = new SlotClock(60);
	clock.take(20);
	assert.equal(clock.take(25), null);
});

test("frame count equals the number of elapsed slots", () => {
	const clock = new SlotClock(60);
	let frames = 0;
	// Captures at jittery times: one image per claimed slot, repeats fill the rest.
	for (const at of [0, 17, 51, 70, 120, 121, 200, 260, 400, 401, 500, 999]) {
		const taken = clock.take(at);
		if (!taken) continue;
		frames += taken.repeats + 1;
	}
	assert.equal(frames, clock.next);
	assert.equal(clock.next, slotFor(999, 60) + 1);
});

test("a long stall fills the video with the last image, not with a gap", () => {
	const clock = new SlotClock(60);
	clock.take(0);
	const taken = clock.take(1000);
	assert.equal(taken.slot, 60);
	assert.equal(taken.repeats, 59);
	assert.equal(taken.repeats + 1 + 1, 61);
});

test("thirty fps gives thirty slots in one second", () => {
	const clock = new SlotClock(30);
	clock.take(0);
	clock.take(999);
	assert.equal(clock.next, 30);
});
