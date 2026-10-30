import assert from "node:assert/strict";
import test from "node:test";
import { cameraAt, cameraTransform, cursorAt, devicePixelsPerOutputPixel, frameForOutputTime, outputTimeForFrame, visibleSourceWidth } from "../skills/walkthrough-video/scripts/lib/plantime.mjs";
import { samplePlan } from "./walkthrough-support.mjs";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ""} ${actual} != ${expected}`);

test("outputTimeForFrame maps a frame inside a clip at speed 1", () => {
	near(outputTimeForFrame(samplePlan(), 60), 1);
});

test("speed 2 halves the output time of a frame", () => {
	near(outputTimeForFrame(samplePlan({ clips: [{ from: 30, to: 240, at: 2, speed: 2 }] }), 90), 2.5);
});

test("a frame outside every clip has no output time", () => {
	assert.equal(outputTimeForFrame(samplePlan({ clips: [{ from: 100, to: 200, at: 0, speed: 1 }] }), 50), null);
	assert.equal(outputTimeForFrame(samplePlan(), 241), null);
});

test("the seed frame of a clip is its at time", () => {
	near(outputTimeForFrame(samplePlan({ clips: [{ from: 120, to: 240, at: 3, speed: 1 }] }), 120), 3);
});

test("a clip hold adds to the clip end but not to the frame mapping", () => {
	const plan = samplePlan({ clips: [{ from: 0, to: 120, at: 0, speed: 1, hold: 1.5 }] });
	near(outputTimeForFrame(plan, 120), 2);
	near(outputTimeForFrame(plan, 60), 1);
	assert.equal(frameForOutputTime(plan, 2.5), 120, "the held frame is the last frame of the clip");
});

test("frameForOutputTime is the inverse of outputTimeForFrame", () => {
	const plan = samplePlan({ clips: [{ from: 0, to: 60, at: 0, speed: 1 }, { from: 120, to: 240, at: 4, speed: 2 }] });
	assert.equal(frameForOutputTime(plan, 0.5), 30);
	assert.equal(frameForOutputTime(plan, 5), 240);
	assert.equal(frameForOutputTime(plan, 99), null);
});

test("cameraAt holds a keyframe until the composition starts its move", () => {
	const camera = cameraAt(samplePlan(), 2);
	assert.equal(camera.cx, 640);
	assert.equal(camera.cy, 360);
	assert.equal(camera.zoom, 1.15);
});

test("cameraAt before the first keyframe returns the first one", () => {
	const camera = cameraAt(samplePlan(), -1);
	assert.equal(camera.zoom, 1.15);
});

test("cameraAt after the last keyframe holds the last one", () => {
	const camera = cameraAt(samplePlan(), 10);
	assert.equal(camera.zoom, 1.2);
	assert.equal(camera.cy, 300);
});

test("cursorAt interpolates between keyframes", () => {
	const cursor = cursorAt(samplePlan(), 0.5);
	near(cursor.x, 570);
	near(cursor.y, 300);
});

test("cursorAt clamps outside the keyframe range and returns null with no keyframes", () => {
	assert.deepEqual(cursorAt(samplePlan(), -2), { x: 640, y: 360 });
	assert.deepEqual(cursorAt(samplePlan(), 9), { x: 500, y: 240 });
	assert.equal(cursorAt(samplePlan({ cursor: [] }), 1), null);
});

test("cameraTransform maps the camera centre to the output centre", () => {
	const plan = samplePlan();
	const box = cameraTransform(plan, cameraAt(plan, 0), { x: 640, y: 360, width: 0, height: 0 });
	near(box.x + box.width, 960);
	near(box.y + box.height, 540);
});

test("cameraTransform scales a box by zoom and output width", () => {
	const plan = samplePlan();
	const camera = { cx: 640, cy: 360, zoom: 2 };
	// 1 CSS px becomes 1920 * 2 / 1280 = 3 output px.
	const box = cameraTransform(plan, camera, { x: 640, y: 360, width: 100, height: 50 });
	near(box.x, 960);
	near(box.y, 540);
	near(box.width, 300);
	near(box.height, 150);
});

test("cameraTransform handles a box that is not centred", () => {
	const plan = samplePlan();
	const box = cameraTransform(plan, { cx: 640, cy: 360, zoom: 1 }, { x: 640, y: 360, width: 20, height: 20 });
	near(box.x, 960);
	near(box.y, 540);
	near(box.width, 30);
});

test("devicePixelsPerOutputPixel is the gate 3 formula", () => {
	const plan = samplePlan();
	const ratio = devicePixelsPerOutputPixel(plan, { zoom: 1.5 });
	near(ratio, (2 * 1280) / (1.5 * 1920));
	assert.ok(ratio < 1);
});

test("visibleSourceWidth shrinks with zoom", () => {
	near(visibleSourceWidth(samplePlan(), 2), 640);
	near(visibleSourceWidth(samplePlan(), 1), 1280);
});

test("the gate camera eases between keys the way the composition moves", () => {
	// The composition tweens each move over min(0.7 s, the gap) with power3.inOut,
	// from the previous key to c.t - duration. The gates must read the same values.
	const plan = samplePlan();
	const mid = cameraAt(plan, 3.15); // half of the move that starts at 2.8 and ends at 3.5
	near(mid.zoom, 1.175, 1e-3);
	near(mid.cy, 330, 1e-3);
	near(cameraAt(plan, 2.7).zoom, 1.15); // the key is held until its move starts
	near(cameraAt(plan, 3.5).zoom, 1.2);
	near(cameraAt(plan, 5).zoom, 1.2);
});

test("a short gap between keys eases over that gap only", () => {
	const plan = samplePlan({ camera: [{ t: 0, cx: 640, cy: 360, zoom: 1 }, { t: 0.4, cx: 500, cy: 300, zoom: 2, ease: "none" }] });
	near(cameraAt(plan, 0.2).zoom, 1.5); // ease none: linear over the 0.4 s gap
	near(cameraAt(plan, 0.1).zoom, 1.25);
	near(cameraAt(plan, 0.5).zoom, 2);
});
