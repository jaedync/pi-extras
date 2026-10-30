import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadStoryboard, normalizeStoryboard } from "../skills/walkthrough-video/scripts/film/storyboard.mjs";

// The golden film's storyboard: lengths in beats at 120 BPM, 15 shots, 30 s.
const golden = () => ({
	bpm: 120,
	offset: 0,
	fps: 60,
	shots: [4, 4, 4, 4, 2, 4, 4, 4, 4, 4, 4, 4, 4, 4, 6].map((beats, i) => ({ id: `s${i + 1}`, beats, ...(i === 12 ? { hold: 0.3 } : {}) })),
});

test("a beat storyboard becomes shots in seconds and frames, with the true cut list", () => {
	const sb = normalizeStoryboard(golden());
	assert.equal(sb.fps, 60);
	assert.equal(sb.shots.length, 15);
	assert.equal(sb.duration, 30);
	assert.equal(sb.frames, 1800);
	assert.deepEqual(sb.cuts, [120, 240, 360, 480, 540, 660, 780, 900, 1020, 1140, 1260, 1380, 1500, 1620]);
	assert.deepEqual(sb.shots[4], { id: "s5", start: 8, end: 9, startFrame: 480, endFrame: 540, holds: [], params: { beats: 2 } });
	// A shot parameter called "hold" is the author's own data, not a planned freeze.
	assert.deepEqual(sb.shots[12].holds, []);
});

test("a shot in seconds or frames keeps its length; holds are frames inside the film", () => {
	const sb = normalizeStoryboard({
		fps: 30,
		shots: [
			{ id: "open", seconds: 1.5 },
			{ id: "proof", frames: 75, holds: [[1, 2.5]] },
			{ id: "end", seconds: 2, still: true },
		],
	});
	assert.deepEqual(sb.cuts, [45, 120]);
	assert.equal(sb.duration, 6);
	assert.deepEqual(sb.shots[1].holds, [[75, 120]]);
	assert.deepEqual(sb.shots[2].holds, [[120, 180]]);
});

test("cuts land on whole frames, and the rounding never drifts", () => {
	const sb = normalizeStoryboard({ fps: 60, shots: Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, seconds: 1.01 })) });
	assert.equal(sb.shots[29].endFrame, Math.round(30 * 1.01 * 60));
	for (const shot of sb.shots) assert.ok(Number.isInteger(shot.startFrame) && Number.isInteger(shot.endFrame));
});

test("a wrong storyboard names the shot and the field", () => {
	assert.throws(() => normalizeStoryboard({ fps: 60, shots: [] }), /at least one shot/);
	assert.throws(() => normalizeStoryboard({ fps: 60, shots: [{ id: "a" }] }), /shot "a".*seconds, frames or beats/);
	assert.throws(() => normalizeStoryboard({ fps: 60, shots: [{ id: "a", beats: 4 }] }), /beats.*bpm/);
	assert.throws(() => normalizeStoryboard({ fps: 60, shots: [{ id: "a", seconds: 1 }, { id: "a", seconds: 1 }] }), /"a" twice/);
	assert.throws(() => normalizeStoryboard({ fps: 60, shots: [{ id: "a", seconds: 1, holds: [[0.5, 2]] }] }), /shot "a".*hold.*0.5 to 2.*inside/);
	assert.throws(() => normalizeStoryboard({ fps: 0, shots: [{ id: "a", seconds: 1 }] }), /fps/);
});

test("loadStoryboard reads JSON, a TypeScript module, or a built film manifest", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-sb-"));
	try {
		writeFileSync(join(dir, "golden.json"), JSON.stringify(golden()));
		assert.equal((await loadStoryboard(join(dir, "golden.json"))).cuts.length, 14);
		writeFileSync(join(dir, "storyboard.ts"), `type Shot = { id: string; seconds: number };\nconst shots: Shot[] = [{ id: "a", seconds: 1 }, { id: "b", seconds: 2 }];\nexport default { fps: 60, shots };\n`);
		assert.deepEqual((await loadStoryboard(join(dir, "storyboard.ts"))).cuts, [60]);
		const manifest = { version: 1, kind: "wv-film", fps: 60, shots: [{ id: "a", seconds: 1 }, { id: "b", seconds: 1 }], cues: [] };
		writeFileSync(join(dir, "film.json"), JSON.stringify(manifest));
		assert.deepEqual((await loadStoryboard(join(dir, "film.json"))).cuts, [60]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadStoryboard times a storyboard for a render at another fps", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-sb-"));
	try {
		const file = join(dir, "storyboard.json");
		writeFileSync(file, JSON.stringify({ fps: 60, bpm: 120, shots: [{ id: "a", beats: 4 }, { id: "b", beats: 2, holds: [[0.5, 1]] }] }));
		const sb = await loadStoryboard(file, { fps: 30 });
		assert.equal(sb.fps, 30);
		assert.deepEqual(sb.cuts, [60]);
		assert.deepEqual(sb.holds, [[75, 90]]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a hold may run to the end of its shot, so a re-time does not break it", () => {
	const sb = normalizeStoryboard({ fps: 30, shots: [{ id: "a", seconds: 2 }, { id: "end", seconds: 5.2, holds: [[2.4, "end"]] }] });
	assert.deepEqual(sb.shots[1].holds, [[60 + 72, 216]]);
	const longer = normalizeStoryboard({ fps: 30, shots: [{ id: "a", seconds: 2 }, { id: "end", seconds: 6, holds: [[2.4, "end"]] }] });
	assert.deepEqual(longer.shots[1].holds, [[132, 240]]);
	assert.throws(() => normalizeStoryboard({ fps: 30, shots: [{ id: "a", seconds: 2, holds: [["start", "end"]] }] }), /hold/);
	assert.throws(() => normalizeStoryboard({ fps: 30, shots: [{ id: "a", seconds: 2, holds: [[2.5, "end"]] }] }), /inside/);
});

test("fps and the frame size are whole numbers, and a fractional one is named", () => {
	const good = { fps: 30, width: 1080, height: 1920, shots: [{ id: "a", seconds: 1 }] };
	assert.equal(normalizeStoryboard(good).fps, 30);
	for (const bad of [{ ...good, fps: 29.97 }, { ...good, fps: 0 }, { ...good, width: 1080.5 }, { ...good, height: -1080 }, { ...good, width: "1080" }]) {
		assert.throws(() => normalizeStoryboard(bad), /whole number|positive integer/i, JSON.stringify(bad));
	}
});
