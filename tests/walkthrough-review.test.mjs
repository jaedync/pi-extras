import assert from "node:assert/strict";
import test from "node:test";
import { BEAT_SETTLE_S, beatPages, labelArgs, reviewTimes, SEAM_OFFSETS, tileArgs, timeLabel } from "../skills/walkthrough-video/scripts/lib/review.mjs";

const plan = () => ({
	version: 1, fps: 60, output: { width: 1920, height: 1080 }, source: { width: 1280, height: 720, scale: 2 },
	introS: 2.2, outroS: 2.4,
	edit: { start: 1.85, duration: 9 },
	beats: [{ name: "shot-1", t: 1.85 }, { name: "shot-2", t: 4 }, { name: "shot-3", t: 7 }],
	shots: [{ from: 0, to: 129, start: 1.85, end: 4, picture: 2.15 }, { from: 129, to: 300, start: 4, end: 7, picture: 3 }, { from: 300, to: 540, start: 7, end: 10.85, picture: 3.85 }],
	clips: [], camera: [], cursor: [], focus: [], captions: [], voice: [],
});

test("a seam sheet is made for a shot cut, not for a caption or a beat", () => {
	const times = reviewTimes(plan());
	// Two shot cuts plus the cut into the outro card. A caption or a beat adds nothing.
	assert.equal(times.seams.length, 3, JSON.stringify(times.seams.map((s) => s.t)));
	assert.deepEqual(times.seams.map((s) => s.t), [4, 7, 10.85]);
	assert.ok(times.seams[0].times.length === SEAM_OFFSETS.length);
	for (const seam of times.seams) assert.deepEqual(seam.times, SEAM_OFFSETS.map((o) => Math.round((seam.t + o) * 1000) / 1000));
});

test("a beat shows each shot just after it starts, and its middle when it is long", () => {
	const times = reviewTimes(plan());
	const first = times.beats.find((b) => b.label === "shot 1");
	assert.equal(first.t, 1.85 + BEAT_SETTLE_S);
	assert.ok(times.beats.some((b) => b.label === "shot 1 mid"));
	assert.ok(times.beats.every((b) => b.t > 0 && b.t < times.total));
});

test("one capture per distinct moment, and nothing past the end", () => {
	const times = reviewTimes(plan());
	const wanted = times.beats.length + times.seams.length * SEAM_OFFSETS.length;
	assert.ok(times.times.length <= wanted, `${times.times.length} of ${wanted}`);
	assert.equal(new Set(times.times).size, times.times.length);
	assert.deepEqual(times.times, [...times.times].sort((a, b) => a - b));
	const near = reviewTimes({ ...plan(), outroS: 0, shots: [{ start: 1.85, end: 1.9 }] });
	assert.equal(near.seams.length, 0, "a cut at the first frame is not a cut");
});

test("the label and tile commands name the time and the grid", () => {
	const label = labelArgs({ src: "a.png", out: "b.png", label: timeLabel(2.5), cellWidth: 480 });
	assert.ok(label.join(" ").includes("scale=480:-2,drawtext=text='2.5s'"), label.join(" "));
	assert.equal(timeLabel(0), "0s");
	assert.equal(timeLabel(12.04), "12s");
	const tile = tileArgs({ dir: "/d", count: 6, cols: 4, out: "/o.jpg" });
	assert.ok(tile.join(" ").includes("tile=4x2"), tile.join(" "));
	assert.ok(tileArgs({ dir: "/d", count: 16, cols: 4, out: "/o.jpg" }).join(" ").includes("tile=4x4"));
});

test("beat sheets are named and paginated", () => {
	const beats = Array.from({ length: 20 }, (_, i) => ({ t: i, label: `shot ${i}` }));
	const pages = beatPages(beats);
	assert.equal(pages.length, 2);
	assert.deepEqual(pages.map((p) => p.name), ["review-beats-1", "review-beats-2"]);
	assert.equal(beatPages(beats.slice(0, 5))[0].name, "review-beats");
});
