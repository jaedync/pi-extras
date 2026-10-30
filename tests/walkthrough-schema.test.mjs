import assert from "node:assert/strict";
import test from "node:test";
import { validateEvents, validatePlan } from "../skills/walkthrough-video/scripts/lib/schema.mjs";
import { clickEvent, sampleEvents, samplePlan } from "./walkthrough-support.mjs";

test("a well-formed events.json validates", () => {
	const result = validateEvents(sampleEvents());
	assert.equal(result.ok, true, result.problems.join("; "));
});

test("a missing required field is named with its path", () => {
	const events = sampleEvents();
	delete events.events[0].settleFrame;
	const result = validateEvents(events);
	assert.equal(result.ok, false);
	assert.match(result.problems.join("\n"), /events\[0\]\.settleFrame/);
});

test("an event whose frames go backwards is refused", () => {
	const events = sampleEvents({ events: [clickEvent({ startFrame: 80, endFrame: 70, settleFrame: 90 })] });
	const result = validateEvents(events);
	assert.equal(result.ok, false);
	assert.match(result.problems.join("\n"), /endFrame/);
});

test("an event past the last frame is refused", () => {
	const events = sampleEvents({ events: [clickEvent({ settleFrame: 400 })] });
	assert.equal(validateEvents(events).ok, false);
});

test("an unknown event kind is refused", () => {
	const events = sampleEvents({ events: [clickEvent({ kind: "drag" })] });
	const result = validateEvents(events);
	assert.equal(result.ok, false);
	assert.match(result.problems.join("\n"), /kind/);
});

test("a box with a negative size is refused", () => {
	const events = sampleEvents({ events: [clickEvent({ changed: { x: 0, y: 0, width: -4, height: 10 } })] });
	assert.equal(validateEvents(events).ok, false);
});

test("null caret and null changed are allowed", () => {
	const events = sampleEvents({ events: [clickEvent({ kind: "goto", caret: null, changed: null, target: null })] });
	assert.equal(validateEvents(events).ok, true);
});

test("an events file that is not an object is refused", () => {
	assert.equal(validateEvents([]).ok, false);
	assert.equal(validateEvents(null).ok, false);
});

test("a plan that matches the design validates", () => {
	const result = validatePlan(samplePlan());
	assert.equal(result.ok, true, result.problems.join("; "));
});

test("a plan clip with a negative hold is refused", () => {
	assert.equal(validatePlan(samplePlan({ clips: [{ from: 0, to: 10, at: 0, speed: 1, hold: -1 }] })).ok, false);
});

test("a plan with a clip that runs backwards is refused", () => {
	assert.equal(validatePlan(samplePlan({ clips: [{ from: 20, to: 10, at: 0, speed: 1 }] })).ok, false);
});

test("a plan with a speed of 0 is refused", () => {
	assert.equal(validatePlan(samplePlan({ clips: [{ from: 0, to: 10, at: 0, speed: 0 }] })).ok, false);
});

test("the validator collects more than one problem", () => {
	const events = sampleEvents({ fps: 0, frames: -1 });
	const result = validateEvents(events);
	assert.ok(result.problems.length >= 2, result.problems.join("; "));
});

test("a shot caption takes a string or a text and place object", async () => {
	const { validateShots } = await import("../skills/walkthrough-video/scripts/lib/schema.mjs");
	const events = sampleEvents();
	const ok = [
		{ shots: [{ events: ["e1"], caption: "Open the menu" }] },
		{ shots: [{ events: ["e1"], caption: { text: "Open the menu", place: "top" } }] },
		{ shots: [{ events: ["e1"], cursor: "hide" }] },
		{ shots: [{ events: ["e1"], caption: { text: "Open the menu", place: "bottom" } }] },
	];
	for (const shots of ok) assert.deepEqual(validateShots(shots, events.events), [], JSON.stringify(shots));
	const bad = [
		{ shots: [{ events: ["e1"], caption: { text: "Open the menu", place: "middle" } }] },
		{ shots: [{ events: ["e1"], caption: { place: "top" } }] },
		{ shots: [{ events: ["e1"], caption: { text: 42 } }] },
	];
	for (const shots of bad) assert.match(validateShots(shots, events.events).join("; "), /caption/, JSON.stringify(shots));
});

test("a look colour is a #hex value and a look font a plain family name, and both are validation errors", async () => {
	const { validateShots } = await import("../skills/walkthrough-video/scripts/lib/schema.mjs");
	const { lookOf } = await import("../skills/walkthrough-video/scripts/lib/compose-html.mjs");
	const events = sampleEvents();
	const ok = [
		{ shots: [{ events: ["e1"] }], look: { ground: "#faf5f2", ink: "#fff", accent: "#d0552cff", font: "Karla" } },
		{ shots: [{ events: ["e1"] }], look: { font: "IBM Plex Mono" } },
	];
	for (const shots of ok) assert.deepEqual(validateShots(shots, events.events), [], JSON.stringify(shots));
	const bad = [
		{ shots: [{ events: ["e1"] }], look: { ground: "rgb(250,245,242)" } },
		{ shots: [{ events: ["e1"] }], look: { ink: "white" } },
		{ shots: [{ events: ["e1"] }], look: { accent: "oklch(0.7 0.1 40)" } },
		{ shots: [{ events: ["e1"] }], look: { ground: "#ff" } },
		{ shots: [{ events: ["e1"] }], look: { font: "Karla; } body { display: none" } },
		{ shots: [{ events: ["e1"] }], look: { font: "A".repeat(61) } },
	];
	for (const shots of bad) assert.match(validateShots(shots, events.events).join("; "), /look\./, JSON.stringify(shots));
	// The composer uses the same rule: a value that reaches it is never replaced with a default
	// without a word. The schema reports the error; lookOf refuses an invalid value too.
	assert.deepEqual(lookOf({ look: { ground: "#FFF", ink: "#123456", accent: "#d0552cff", font: "Karla" } }), { ground: "#FFF", ink: "#123456", accent: "#d0552cff", font: "Karla", cursor: "dark" });
	assert.throws(() => lookOf({ look: { ground: "rgb(1,2,3)" } }), /look\.ground/);
	assert.throws(() => lookOf({ look: { font: "A".repeat(61) } }), /look\.font/);
});

test("a shot trim and cut are validated", async () => {
	const { validateShots } = await import("../skills/walkthrough-video/scripts/lib/schema.mjs");
	const events = sampleEvents();
	const ok = [
		{ shots: [{ events: ["e1"], trim: { start: 0.5 } }] },
		{ shots: [{ events: ["e1"], trim: { start: 0.2, end: 0.8 } }] },
		{ shots: [{ events: ["e1"], cut: true }] },
	];
	for (const shots of ok) assert.deepEqual(validateShots(shots, events.events), [], JSON.stringify(shots));
	const bad = [
		{ shots: [{ events: ["e1"], trim: { start: -1 } }] },
		{ shots: [{ events: ["e1"], trim: { start: 0.8, end: 0.2 } }] },
		{ shots: [{ events: ["e1"], trim: { end: 0 } }] },
		{ shots: [{ events: ["e1"], trim: { middle: 1 } }] },
		{ shots: [{ events: ["e1"], trim: 1 }] },
		{ shots: [{ events: ["e1"], cut: "yes" }] },
	];
	for (const shots of bad) assert.match(validateShots(shots, events.events).join("; "), /trim|cut/, JSON.stringify(shots));
});
