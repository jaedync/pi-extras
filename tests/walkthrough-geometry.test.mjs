import assert from "node:assert/strict";
import test from "node:test";
import { boxCenter, clipToViewport, containsPoint, insetBox, intersectBox, normalizeBox, roundBox, unionRects } from "../skills/walkthrough-video/scripts/lib/geometry.mjs";

test("normalizeBox reads a DOMRect", () => {
	assert.deepEqual(normalizeBox({ x: 10, y: 20, width: 30, height: 40, top: 20, left: 10, right: 40, bottom: 60 }), { x: 10, y: 20, width: 30, height: 40 });
});

test("normalizeBox reads left/top/right/bottom", () => {
	assert.deepEqual(normalizeBox({ left: 10, top: 20, right: 40, bottom: 60 }), { x: 10, y: 20, width: 30, height: 40 });
});

test("normalizeBox rejects a box with no geometry", () => {
	assert.equal(normalizeBox(null), null);
	assert.equal(normalizeBox({ width: 10 }), null);
});

test("unionRects covers both boxes", () => {
	assert.deepEqual(unionRects([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 30 }]), { x: 0, y: 0, width: 30, height: 35 });
});

test("unionRects of nothing is null", () => {
	assert.equal(unionRects([]), null);
	assert.equal(unionRects([{ x: 0, y: 0, width: 0, height: 0 }]), null);
});

test("unionRects ignores zero-size and null rects", () => {
	assert.deepEqual(unionRects([null, { x: 0, y: 0, width: 0, height: 5 }, { x: 1, y: 2, width: 3, height: 4 }]), { x: 1, y: 2, width: 3, height: 4 });
});

test("intersectBox returns the overlap", () => {
	assert.deepEqual(intersectBox({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }), { x: 5, y: 5, width: 5, height: 5 });
});

test("intersectBox of disjoint boxes is null", () => {
	assert.equal(intersectBox({ x: 0, y: 0, width: 4, height: 4 }, { x: 10, y: 10, width: 4, height: 4 }), null);
});

test("clipToViewport drops a box that is fully outside", () => {
	assert.equal(clipToViewport({ x: 2000, y: 0, width: 100, height: 100 }, { width: 1280, height: 720 }), null);
});

test("clipToViewport cuts a partial box and rounds subpixels", () => {
	assert.deepEqual(clipToViewport({ x: -10.4, y: 700.2, width: 100, height: 50 }, { width: 1280, height: 720 }), { x: 0, y: 700.2, width: 89.6, height: 19.8 });
});

test("insetBox shrinks on every side", () => {
	assert.deepEqual(insetBox({ x: 10, y: 10, width: 20, height: 20 }, 2), { x: 12, y: 12, width: 16, height: 16 });
});

test("insetBox of a box that is too small is null", () => {
	assert.equal(insetBox({ x: 0, y: 0, width: 3, height: 10 }, 2), null);
});

test("containsPoint uses the box edges", () => {
	const box = { x: 0, y: 0, width: 10, height: 10 };
	assert.equal(containsPoint(box, 5, 5), true);
	assert.equal(containsPoint(box, 0, 0), true);
	assert.equal(containsPoint(box, 10, 10), true);
	assert.equal(containsPoint(box, 10.01, 5), false);
});

test("boxCenter is the middle of the box", () => {
	assert.deepEqual(boxCenter({ x: 10, y: 20, width: 100, height: 40 }), { x: 60, y: 40 });
});

test("roundBox keeps two decimals and keeps null", () => {
	assert.deepEqual(roundBox({ x: 1.23456, y: 2, width: 3, height: 4 }, 2), { x: 1.23, y: 2, width: 3, height: 4 });
	assert.equal(roundBox(null), null);
});
