import assert from "node:assert/strict";
import test from "node:test";
import { BLANK_LUMA_RANGE, clampedSides, cameraScaleTimes, gateBlankFrame, gateCameraScale, gateCaptionClear, gateCursorOnTarget, gateDeadStretch, gateFocusInSafe, gateNoUpscale, gateSmoothness, gateTextReadable, gateVoiceFits } from "../skills/walkthrough-video/scripts/lib/gates.mjs";
import { clickEvent, sampleEvents, samplePlan, samples } from "./walkthrough-support.mjs";

const byId = (gates, id) => gates.find((gate) => gate.id === id);

test("gate 1 passes when the cursor is on the clicked target", () => {
	const gate = gateCursorOnTarget(samplePlan(), sampleEvents());
	assert.equal(gate.status, "pass", JSON.stringify(gate));
	assert.equal(gate.checked, 1);
});

test("gate 1 fails when the cursor is outside the target and names the time", () => {
	const plan = samplePlan({ cursor: [{ t: 0, x: 10, y: 10 }, { t: 1, x: 20, y: 20, click: true, event: "e1" }] });
	const gate = gateCursorOnTarget(plan, sampleEvents());
	assert.equal(gate.status, "fail");
	assert.match(gate.detail, /1\.000s/);
	assert.ok(gate.fix && gate.fix.length > 10);
});

test("gate 1 treats a click on the 2 px inset border as outside", () => {
	const plan = samplePlan({ cursor: [{ t: 0, x: 640, y: 360 }, { t: 1, x: 441, y: 240, click: true, event: "e1" }] });
	assert.equal(gateCursorOnTarget(plan, sampleEvents()).status, "fail");
});

test("gate 1 falls back to click events when plan.cursor has no click flags", () => {
	const plan = samplePlan({ cursor: [{ t: 0, x: 640, y: 360 }, { t: 1, x: 500, y: 240 }] });
	const gate = gateCursorOnTarget(plan, sampleEvents());
	assert.equal(gate.status, "pass");
	assert.equal(gate.checked, 1);
});

test("gate 1 skips when there are no clicks", () => {
	const gate = gateCursorOnTarget(samplePlan({ cursor: [], focus: [] }), sampleEvents({ events: [] }));
	assert.equal(gate.status, "skip");
});

test("gate 1 skips a click whose frame the plan does not keep", () => {
	const plan = samplePlan({ clips: [{ from: 0, to: 30, at: 0, speed: 1 }] });
	const gate = gateCursorOnTarget(plan, sampleEvents());
	assert.equal(gate.status, "skip");
});

test("gate 2 passes when the focus box is inside the title-safe area", () => {
	assert.equal(gateFocusInSafe(samplePlan(), sampleEvents()).status, "pass");
});

test("gate 2 fails when the camera pushes the focus box out of the safe area", () => {
	const plan = samplePlan({ focus: [{ start: 0.5, end: 1.5, event: "e1", box: "changed" }] });
	const events = sampleEvents({ events: [clickEvent({ changed: { x: 0, y: 0, width: 200, height: 60 } })] });
	const gate = gateFocusInSafe(plan, events);
	assert.equal(gate.status, "fail");
	assert.match(gate.detail, /outside the output frame/);
});

test("gate 2 allows the margin on a side where the camera is clamped to the source edge", () => {
	// The camera clamps to cx 455.84 and cy 256.41, so the box sits in the left margin
	// (x 75) and may do so: the camera cannot move further left without showing past the source.
	const plan = samplePlan({ camera: [{ t: 0, cx: 455.84, cy: 256.41, zoom: 1.404, ease: "power3.inOut" }] });
	const target = { x: 53.13, y: 72.94, width: 200, height: 24 };
	const events = sampleEvents({ events: [clickEvent({ target, changed: target })] });
	assert.equal(gateFocusInSafe(plan, events).status, "pass");
});

test("gate 2 fails the same box when the camera is not clamped", () => {
	// cx 500 is inside the source, so the left side is not clamped; x 13 is in the margin.
	const plan = samplePlan({ camera: [{ t: 0, cx: 500, cy: 360, zoom: 1.404, ease: "power3.inOut" }] });
	const events = sampleEvents({ events: [clickEvent({ target: { x: 53.13, y: 200, width: 200, height: 24 } })] });
	const gate = gateFocusInSafe(plan, events);
	assert.equal(gate.status, "fail");
	assert.match(gate.detail, /title-safe margin on the left side/);
});

test("gate 2 fails a box that is partly outside the output frame", () => {
	const plan = samplePlan({ camera: [{ t: 0, cx: 640, cy: 360, zoom: 1.2, ease: "power3.inOut" }] });
	const events = sampleEvents({ events: [clickEvent({ target: { x: 0, y: 0, width: 100, height: 50 } })] });
	const gate = gateFocusInSafe(plan, events);
	assert.equal(gate.status, "fail");
	assert.match(gate.detail, /outside the output frame/);
});

test("clampedSides reports the edges the camera cannot pass", () => {
	// At zoom 1 the camera shows the whole source, so it is clamped on every side.
	assert.deepEqual(clampedSides(samplePlan(), { cx: 640, cy: 360, zoom: 1 }), { left: true, right: true, top: true, bottom: true });
	// At zoom 2 the view is 640x360 CSS px and the centre is in the middle of the source.
	assert.deepEqual(clampedSides(samplePlan(), { cx: 640, cy: 360, zoom: 2 }), { left: false, right: false, top: false, bottom: false });
	assert.deepEqual(clampedSides(samplePlan(), { cx: 200, cy: 360, zoom: 2 }), { left: true, right: false, top: false, bottom: false });
});

test("gate 2 skips with no focus windows", () => {
	assert.equal(gateFocusInSafe(samplePlan({ focus: [] }), sampleEvents()).status, "skip");
});

test("gate 2 skips a focus window whose event or box is missing", () => {
	const plan = samplePlan({ focus: [{ start: 0.5, end: 1.5, event: "nope", box: "caret" }] });
	assert.equal(gateFocusInSafe(plan, sampleEvents()).status, "skip");
});

test("gate 3 passes when every camera keyframe keeps 1 source pixel per output pixel", () => {
	const gate = gateNoUpscale(samplePlan());
	assert.equal(gate.status, "pass");
	assert.equal(gate.checked, 2);
});

test("gate 3 fails on a zoom that upscales", () => {
	const plan = samplePlan({ camera: [{ t: 0, cx: 640, cy: 360, zoom: 2, ease: "power3.inOut" }] });
	const gate = gateNoUpscale(plan);
	assert.equal(gate.status, "fail");
	assert.match(gate.detail, /0\.67/);
});

test("gate 3 skips with no camera keyframes", () => {
	assert.equal(gateNoUpscale(samplePlan({ camera: [] })).status, "skip");
});

test("gate 4 passes when the focused text is 28 px or more", () => {
	assert.equal(gateTextReadable(samplePlan(), sampleEvents()).status, "pass");
});

test("gate 4 fails when the type is too small at the focus zoom", () => {
	const events = sampleEvents({ events: [clickEvent({ fontPx: 12 })] });
	const gate = gateTextReadable(samplePlan(), events);
	assert.equal(gate.status, "fail");
	assert.match(gate.detail, /px/);
});

test("gate 4 accepts a zoom rounded to three decimals that lands a hundredth of a pixel short", () => {
	// 20 px * 1.15 * 1.5 = 34.5 px; a plan that rounds 1.15 to 1.1498 gives 34.494 px.
	const plan = samplePlan({ camera: [{ t: 0, cx: 640, cy: 360, zoom: 1.1498, ease: "power3.inOut" }] });
	assert.equal(gateTextReadable(plan, sampleEvents()).status, "pass");
});

test("gate 4 rejects text a whole pixel below the floor", () => {
	// 15.5 px * 1.15 * 1.5 = 26.7 px, 1.4 px under the 28.08 px floor.
	const events = sampleEvents({ events: [clickEvent({ fontPx: 15.5 })] });
	assert.equal(gateTextReadable(samplePlan(), events).status, "fail");
});

test("gate 4 skips a focus window with no fontPx", () => {
	const events = sampleEvents({ events: [clickEvent({ fontPx: null })] });
	assert.equal(gateTextReadable(samplePlan(), events).status, "skip");
});

test("gate 5 passes when every kept frame has luma variation", () => {
	const gate = gateBlankFrame(samplePlan(), samples([0.5, 20, 220], [1, 10, 240]));
	assert.equal(gate.status, "pass");
	assert.equal(gate.checked, 2);
});

test("gate 5 fails on a near-uniform frame inside a kept clip", () => {
	const gate = gateBlankFrame(samplePlan(), samples([0.5, 200, 200 + BLANK_LUMA_RANGE - 1]));
	assert.equal(gate.status, "fail");
	assert.match(gate.detail, /0\.500s/);
});

test("gate 5 ignores a blank frame outside the kept clips", () => {
	const plan = samplePlan({ clips: [{ from: 60, to: 120, at: 0, speed: 1 }] });
	const gate = gateBlankFrame(plan, samples([0.1, 0, 0], [1.2, 0, 200]));
	assert.equal(gate.status, "pass");
});

test("gate 5 skips when the capture could not be scanned", () => {
	assert.equal(gateBlankFrame(samplePlan(), []).status, "skip");
});

test("gate 6 passes when no output stretch is longer than 3 s", () => {
	assert.equal(gateDeadStretch(samplePlan(), sampleEvents()).status, "pass");
});

test("gate 6 fails on a 4 s stretch with nothing to look at", () => {
	const plan = samplePlan({ camera: [], captions: [], cursor: [], voice: [] });
	const gate = gateDeadStretch(plan, sampleEvents({ events: [] }));
	assert.equal(gate.status, "fail");
	assert.match(gate.detail, /4\.0 s/);
});

test("gate 6 ignores a gap that is not inside a kept clip", () => {
	const plan = samplePlan({ clips: [{ from: 0, to: 60, at: 0, speed: 1 }, { from: 120, to: 180, at: 10, speed: 1 }], camera: [], captions: [], cursor: [] });
	// The 8 s hole between the clips is a jump cut, not dead footage.
	assert.equal(gateDeadStretch(plan, sampleEvents({ events: [] })).status, "pass");
});

test("gate 6 counts a short clip hold as intentional", () => {
	const plan = samplePlan({ clips: [{ from: 0, to: 60, at: 0, speed: 1, hold: 2 }], camera: [], captions: [], cursor: [] });
	assert.equal(gateDeadStretch(plan, sampleEvents({ events: [] })).status, "pass");
});

test("gate 7 passes when the voice line fits its window", () => {
	assert.equal(gateVoiceFits(samplePlan()).status, "pass");
});

test("gate 7 fails when a voice line is longer than its window", () => {
	const plan = samplePlan({ voice: [{ start: 0.4, end: 2.1, text: "x", file: "voice/0.wav", seconds: 2.4 }] });
	const gate = gateVoiceFits(plan);
	assert.equal(gate.status, "fail");
	assert.match(gate.detail, /2\.4/);
});

test("gate 7 skips with no voice lines", () => {
	assert.equal(gateVoiceFits(samplePlan({ voice: [] })).status, "skip");
});

test("every gate names its id and a detail", () => {
	const gates = [gateCursorOnTarget(samplePlan(), sampleEvents()), gateFocusInSafe(samplePlan(), sampleEvents()), gateNoUpscale(samplePlan()), gateTextReadable(samplePlan(), sampleEvents()), gateBlankFrame(samplePlan(), samples([0.5, 0, 200])), gateDeadStretch(samplePlan()), gateVoiceFits(samplePlan())];
	for (const gate of gates) {
		assert.ok(gate.id, "id");
		assert.ok(["pass", "fail", "skip"].includes(gate.status), `${gate.id}: ${gate.status}`);
		assert.equal(typeof gate.detail, "string");
	}
	assert.equal(byId(gates, "cursor_on_target").id, "cursor_on_target");
});

test("gate 4 names the capture scale when the text needs more zoom than the pixels allow", () => {
	const gate = gateTextReadable(samplePlan(), sampleEvents({ events: [clickEvent({ fontPx: 12 })] }));
	assert.match(gate.fix, /--scale 3/);
});

test("gate 4 names a smaller element when the box is too wide to zoom", () => {
	const wide = clickEvent({ fontPx: 16, target: { x: 40, y: 200, width: 1100, height: 60 } });
	const plan = samplePlan({ camera: [{ t: 0, cx: 640, cy: 360, zoom: 1, ease: "none" }] });
	const gate = gateTextReadable(plan, sampleEvents({ events: [wide] }));
	assert.equal(gate.status, "fail");
	assert.match(gate.fix, /smaller element/);
	assert.doesNotMatch(gate.fix, /--scale/);
});

test("gate 6 points at the shot speed, not at plan.json", () => {
	const plan = samplePlan({ camera: [], captions: [], cursor: [], voice: [] });
	const gate = gateDeadStretch(plan, sampleEvents({ events: [] }));
	assert.match(gate.fix, /"speed"/);
	assert.doesNotMatch(gate.fix, /plan\.clips/);
});

test("gate 9 passes when no control of the shot is under its caption", () => {
	assert.equal(gateCaptionClear(samplePlan(), sampleEvents()).status, "pass");
});

test("gate 9 fails when a clicked control sits under the caption, and passes with the caption on top", () => {
	const low = sampleEvents({ events: [clickEvent({ target: { x: 300, y: 640, width: 200, height: 50 }, changed: null })] });
	const plan = samplePlan({ camera: [{ t: 0, cx: 640, cy: 360, zoom: 1, ease: "none" }] });
	const gate = gateCaptionClear(plan, low);
	assert.equal(gate.status, "fail");
	assert.match(gate.detail, /e1/);
	const top = samplePlan({ camera: plan.camera, captions: [{ ...plan.captions[0], place: "top" }] });
	assert.equal(gateCaptionClear(top, low).status, "pass");
});

test("gate 6 does not count a still frame under a voice line as dead", () => {
	const plan = samplePlan({ camera: [], captions: [], cursor: [], voice: [{ start: 0.2, end: 4, text: "x", file: "v.wav", seconds: 3.6 }] });
	assert.equal(gateDeadStretch(plan, sampleEvents({ events: [] })).status, "pass");
});

test("gate 6 lists every dead stretch, not only the worst", () => {
	const plan = samplePlan({ clips: [{ from: 0, to: 600, at: 0, speed: 1 }], camera: [], captions: [{ start: 4.5, end: 5, text: "x" }], cursor: [], voice: [] });
	const gate = gateDeadStretch(plan, sampleEvents({ events: [] }));
	assert.equal(gate.status, "fail");
	assert.match(gate.detail, /from 0\.000s to 4\.500s.*from 5\.000s to 10\.000s/);
});

test("gate 6 still fails a still frame longer than 6 s, even under a voice line", () => {
	const plan = samplePlan({ clips: [{ from: 0, to: 600, at: 0, speed: 1 }], camera: [], captions: [], cursor: [], voice: [{ start: 0.2, end: 9, text: "x", file: "v.wav", seconds: 8.5 }] });
	const gate = gateDeadStretch(plan, sampleEvents({ events: [] }));
	assert.equal(gate.status, "fail");
	assert.match(gate.fix, /voice/);
});

const wideSource = { width: 1280, height: 720, scale: 3 };

test("the text gap names the widest box that still fits at the needed zoom", () => {
	// 13 px text needs zoom 1.44; at that zoom only about 414 px of box width fits inside the safe area.
	const event = clickEvent({ target: { x: 100, y: 100, width: 420, height: 40 }, changed: null, fontPx: 13 });
	const plan = samplePlan({ source: wideSource, camera: [{ t: 0, cx: 640, cy: 360, zoom: 1.422 }], focus: [{ start: 0.5, end: 1.5, event: "e1", box: "target" }] });
	const gate = gateTextReadable(plan, sampleEvents({ viewport: wideSource, events: [event] }));
	assert.equal(gate.status, "fail", JSON.stringify(gate));
	const widest = Number((gate.fix.match(/only (\d+) px/) ?? [])[1]);
	assert.ok(widest > 380 && widest < 420, `the fix names the widest box that fits (got "${gate.fix}")`);
});

test("the text gap names the cost of a higher --scale", () => {
	const event = clickEvent({ fontPx: 13 });
	const plan = samplePlan({ camera: [{ t: 0, cx: 640, cy: 360, zoom: 1.333 }] });
	const gate = gateTextReadable(plan, sampleEvents({ events: [event] }));
	assert.equal(gate.status, "fail");
	assert.match(gate.fix, /--scale 3/);
	assert.match(gate.fix, /1024/);
	assert.match(gate.fix, /longer|slower|drop frames/);
});

test("text within 0.2 px of the floor is rounding, not a defect", () => {
	// 14 px at the 2x capture limit: 28.00 px against a 28.08 px floor.
	const plan = samplePlan({ camera: [{ t: 0, cx: 640, cy: 360, zoom: 1.333 }], focus: [{ start: 0.5, end: 1.5, event: "e1", box: "target" }] });
	const gate = gateTextReadable(plan, sampleEvents({ events: [clickEvent({ fontPx: 14 })] }));
	assert.equal(gate.status, "pass", JSON.stringify(gate));
});

test("a camera that makes three moves inside 2 s fails camera_churn", async () => {
	const { gateCameraChurn } = await import("../skills/walkthrough-video/scripts/lib/gates.mjs");
	const plan = samplePlan({ camera: [
		{ t: 0, cx: 640, cy: 360, zoom: 1 },
		{ t: 2.0, cx: 400, cy: 300, zoom: 1.6 },
		{ t: 2.6, cx: 640, cy: 360, zoom: 1 },
		{ t: 3.2, cx: 500, cy: 320, zoom: 1.5 },
	] });
	const gate = gateCameraChurn(plan);
	assert.equal(gate.status, "fail", JSON.stringify(gate));
	assert.match(gate.detail, /3 moves/);
	assert.ok(gate.fix);
});

test("camera_churn passes two moves inside 2 s and skips a still camera", async () => {
	const { gateCameraChurn } = await import("../skills/walkthrough-video/scripts/lib/gates.mjs");
	const two = samplePlan({ camera: [
		{ t: 0, cx: 640, cy: 360, zoom: 1 },
		{ t: 2.0, cx: 400, cy: 300, zoom: 1.6 },
		{ t: 6.0, cx: 640, cy: 360, zoom: 1 },
		{ t: 9.0, cx: 500, cy: 320, zoom: 1.5 },
	] });
	assert.equal(gateCameraChurn(two).status, "pass");
	assert.equal(gateCameraChurn(samplePlan({ camera: [{ t: 0, cx: 640, cy: 360, zoom: 1 }] })).status, "skip");
});

test("gate 9 ignores a change that is far from the control it came from", () => {
	// A radio click at the top of the form repaints a sticky bar far below it, under the caption.
	const events = sampleEvents({ events: [clickEvent({ target: { x: 300, y: 120, width: 24, height: 24 }, changed: { x: 100, y: 580, width: 400, height: 120 } })] });
	const plan = samplePlan({ camera: [{ t: 0, cx: 640, cy: 360, zoom: 1, ease: "none" }] });
	assert.equal(gateCaptionClear(plan, events).status, "pass");
});

test("the blank_frame fix names trim and cut, with a number for the trim", () => {
	const plan = samplePlan({ clips: [{ from: 0, to: 240, at: 0, speed: 2 }] });
	const gate = gateBlankFrame(plan, samples([1.0, 2, 3]));
	assert.equal(gate.status, "fail");
	assert.match(gate.fix, /"trim": \{"start": [\d.]+\}/);
	assert.match(gate.fix, /"cut": true/);
	assert.match(gate.fix, /splash|launch/);
});

test("camera_scale passes a render whose zoom matches the plan", async () => {
	const plan = samplePlan({ camera: [{ t: 0, cx: 640, cy: 360, zoom: 1 }, { t: 2.8, cx: 400, cy: 300, zoom: 1.44, ease: "none" }] });
	const samples = [{ t: 1, scale: 1 }, { t: 3.5, scale: 1.44 }, { t: 4, scale: 1.449 }];
	const gate = gateCameraScale(plan, samples);
	assert.equal(gate.status, "pass", JSON.stringify(gate));
	assert.equal(gate.checked, 3);
});

test("camera_scale fails a render whose zoom does not reach the plan key", async () => {
	const plan = samplePlan({ camera: [{ t: 0, cx: 640, cy: 360, zoom: 1 }, { t: 2.8, cx: 400, cy: 300, zoom: 1.44, ease: "none" }] });
	const gate = gateCameraScale(plan, [{ t: 3.5, scale: 1.14 }]);
	assert.equal(gate.status, "fail");
	assert.match(gate.detail, /1\.44/);
	assert.match(gate.fix, /compose|index\.html/);
	assert.equal(gateCameraScale(plan, []).status, "skip");
});

test("camera_scale samples the camera keys and the focus windows", async () => {
	const plan = samplePlan({ camera: [{ t: 0, cx: 640, cy: 360, zoom: 1 }, { t: 2.8, cx: 400, cy: 300, zoom: 1.44 }], focus: [{ start: 3, end: 4, event: "e1", box: "target" }] });
	const times = cameraScaleTimes(plan);
	assert.ok(times.includes(0) && times.includes(2.8), JSON.stringify(times));
	assert.ok(times.includes(3.5), "the middle of the focus window is sampled");
	assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

// --- smoothness (row 1b): unique frames per second inside a shot ---

/** sampleEvents with the per-frame data that a capture now writes. */
const laggyEvents = (stills, p95 = 22) => sampleEvents({ stats: { unique: 40, repeated: 200, maxLagMs: 900, gpu: true, distinct: 40, load: [11.2, 10.4, 9.1], cores: 12, frameMs: { p50: 22, p95 } }, stills });

/** A plan for one shot of 4 s at 60 fps (240 frames). */
const oneShot = () => samplePlan({ shots: [{ from: 0, to: 240, start: 0, end: 4, picture: 4 }] });

test("smoothness fails a shot with motion that shows fewer than 20 new frames a second", () => {
	const stills = [];
	for (let from = 2; from < 240; from += 12) stills.push([from, from + 9]);
	const gate = gateSmoothness(oneShot(), laggyEvents(stills, 180));
	assert.equal(gate.status, "fail", JSON.stringify(gate));
	assert.match(gate.detail, /10\.\d new frames a second/);
	assert.match(gate.fix, /load/, "the fix line names the host load");
	assert.match(gate.fix, /--gpu on|scale/);
});

test("smoothness passes a shot with 20 or more new frames a second", () => {
	const stills = [];
	for (let from = 2; from < 240; from += 6) stills.push([from, from + 2]);
	const gate = gateSmoothness(oneShot(), laggyEvents(stills));
	assert.equal(gate.status, "pass", JSON.stringify(gate));
});

test("smoothness skips a shot that shows one still picture", () => {
	const gate = gateSmoothness(oneShot(), laggyEvents([[2, 239]]));
	assert.equal(gate.status, "skip", JSON.stringify(gate));
});

test("smoothness skips a calm UI that changes in steps, with long pauses", () => {
	// Three new frames between pauses of one second or more, on a host that kept up: not a slideshow.
	const gate = gateSmoothness(oneShot(), laggyEvents([[2, 60], [62, 70], [72, 239]]));
	assert.equal(gate.status, "skip", JSON.stringify(gate));
});

test("smoothness fails a shot that froze on a busy host, even though it looks like a calm UI", () => {
	// The real case: a 4x capture on a host at load 17, 413 frames with 17 new images and a frame
	// draw p95 of 539 ms. The still runs are long, but the capture could not keep up.
	const plan = samplePlan({ shots: [{ from: 85, to: 391, start: 1.5, end: 13.7, picture: 10.2 }] });
	const events = laggyEvents([[89, 92], [94, 102], [104, 337], [339, 391]], 539);
	const gate = gateSmoothness(plan, events);
	assert.equal(gate.status, "fail", JSON.stringify(gate));
	assert.match(gate.fix, /load 11\.2 on 12 cores/);
	assert.match(gate.detail, /new frames a second/);
});

test("smoothness skips a capture without per-frame data", () => {
	assert.equal(gateSmoothness(oneShot(), sampleEvents()).status, "skip");
	assert.equal(gateSmoothness(samplePlan(), laggyEvents([[2, 239]])).status, "skip", "a plan without shot ranges");
});
