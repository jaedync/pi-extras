/**
 * wv measure gives a film's numbers next to the reference films. Advice only:
 * it never fails a film. The golden film test reproduces main's hand
 * measurements and runs with WV_INTEGRATION=1.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseFreezes, referenceRanges, shotStats, measureFilm, formatReport, splitMoves, freezeMeasure } from "../skills/walkthrough-video/scripts/film/measure.mjs";
import { normalizeStoryboard } from "../skills/walkthrough-video/scripts/film/storyboard.mjs";

const WV = fileURLToPath(new URL("../skills/walkthrough-video/scripts/wv.mjs", import.meta.url));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const golden = () => normalizeStoryboard({ bpm: 120, fps: 60, shots: [4, 4, 4, 4, 2, 4, 4, 4, 4, 4, 4, 4, 4, 4, 6].map((beats, i) => ({ id: `s${i + 1}`, beats })) });

test("shot statistics come from the storyboard's true cut list", () => {
	const s = shotStats(golden().shots.map((shot) => shot.end - shot.start), 30);
	assert.equal(s.cuts, 14);
	assert.equal(s.cutsPerMin, 28);
	assert.equal(s.shotMedianS, 2);
	assert.ok(Math.abs(s.shotCv - 0.18) < 0.01, String(s.shotCv));
});

test("one long shot has no variation and no cuts", () => {
	const s = shotStats([30], 30);
	assert.equal(s.cuts, 0);
	assert.equal(s.shotCv, 0);
});

test("freezedetect output becomes the frozen share and the longest hold", () => {
	const text = "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 1.5\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 0.5\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 2\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 4\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 1.25\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 5.25\n";
	assert.deepEqual(parseFreezes(text, 10), { frozenShare: 0.175, longestHoldS: 1.25, holds: [[1.5, 2], [4, 5.25]] });
	// A freeze that runs to the end has no end line.
	assert.equal(parseFreezes("lavfi.freezedetect.freeze_start: 9\n", 10).frozenShare, 0.1);
});

test("the reference ranges give the median, the range and the montage range of each measure", () => {
	const films = [
		{ slug: "a", family: "montage", cuts_per_min: 30, shot_cv: 0.6 },
		{ slug: "b", family: "montage", cuts_per_min: 34, shot_cv: 1.0 },
		{ slug: "c", family: "one-take", cuts_per_min: 1, shot_cv: null },
	];
	const r = referenceRanges(films);
	assert.deepEqual(r.cuts_per_min.all, { median: 30, min: 1, max: 34, n: 3 });
	assert.deepEqual(r.cuts_per_min.montage, { median: 32, min: 30, max: 34, n: 2 });
	assert.deepEqual(r.shot_cv.all, { median: 0.8, min: 0.6, max: 1, n: 2 });
});

test("the report puts each number beside the reference range, and flags one outside it", () => {
	const text = formatReport({ duration: 30, cutsPerMin: 28, shotMedianS: 2, shotCv: 0.18, cuts: 14, frozenShare: 0.33, longestHoldS: 0.5, lufs: -16.6 });
	assert.match(text, /shot length CV\s+0\.18/);
	assert.match(text, /0\.34 to 1\.38/);
	assert.match(text, /outside/);
});

function renderTwoCuts(file) {
	const W = 320;
	const H = 180;
	return new Promise((resolve, reject) => {
		const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", "30", "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", file], { stdio: ["pipe", "ignore", "inherit"] });
		ff.on("error", reject);
		ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
		for (let i = 0; i < 90; i++) {
			const ground = i < 30 ? 30 : i < 60 ? 220 : 110;
			const buf = Buffer.alloc(W * H, ground);
			const x = 20 + i * 2;
			for (let y = 60; y < 120; y++) buf.fill(ground > 128 ? 0 : 255, y * W + x, y * W + x + 40);
			ff.stdin.write(buf);
		}
		ff.stdin.end();
	});
}

test("a staircase is named, and the still hold and ease peak say they read its steps", () => {
	const text = formatReport({ duration: 30, cuts: 10, longestHoldS: 0.48, easePeak: 0, staircaseS: 2.5, staircase: [{ shot: "end", from: 23.68, to: 26.22, period: 4 }] });
	assert.match(text, /staircase/);
	assert.match(text, /2\.5 s/);
	assert.match(text, /"end"/);
	assert.match(text, /still hold.*ease peak|ease peak.*still hold/);
	assert.doesNotMatch(formatReport({ duration: 30, cuts: 10, longestHoldS: 0.48 }), /staircase/);
});

test("without a storyboard, measure finds hard cuts in the picture", { skip: hasFfmpeg ? false : "ffmpeg is not on PATH", timeout: 60000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-measure-"));
	try {
		const film = join(dir, "film.mp4");
		await renderTwoCuts(film);
		const m = await measureFilm({ video: film, camera: false });
		assert.equal(m.cutSource, "detected");
		assert.equal(m.cuts, 2);
		writeFileSync(join(dir, "sb.json"), JSON.stringify({ fps: 30, shots: [{ id: "a", seconds: 1 }, { id: "b", seconds: 1 }, { id: "c", seconds: 1 }] }));
		const cli = spawnSync(process.execPath, [WV, "measure", film, "--storyboard", join(dir, "sb.json"), "--no-camera", "--json"], { encoding: "utf8" });
		assert.equal(cli.status, 0, cli.stderr);
		const json = JSON.parse(cli.stdout);
		assert.equal(json.cutSource, "storyboard");
		assert.equal(json.cutsPerMin, 40);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const GOLDEN = "/tmp/wv-golden/pointer-film.mp4";
const GOLDEN_SB = "/tmp/wv-golden/src/storyboard.json";
const goldenSkip = process.env.WV_INTEGRATION !== "1" ? "set WV_INTEGRATION=1 to measure the golden film" : !existsSync(GOLDEN) ? "the golden film is not on disk" : false;

test("wv measure reproduces main's numbers for the golden film", { skip: goldenSkip, timeout: 120000 }, async () => {
	const m = await measureFilm({ video: GOLDEN, storyboard: GOLDEN_SB, camera: false });
	assert.equal(m.cutsPerMin, 28);
	assert.ok(Math.abs(m.shotCv - 0.18) < 0.01, String(m.shotCv));
	assert.ok(Math.abs(m.lufs - -16.6) < 0.15, String(m.lufs));
	assert.ok(Math.abs(m.frozenShare - 0.327) < 0.03, String(m.frozenShare));
});

test("camera moves split into the film's own camera and the footage's own motion inside clip shots", () => {
	const read = {
		shots: [
			{ start: 0, end: 2, zoom_max: 1.04, moves: [{ start: 0.2, end: 0.8, peak_at: 0.3 }] },
			{ start: 2, end: 6, zoom_max: 1.9, moves: [{ start: 2, end: 5, peak_at: 0.5 }, { start: 5.2, end: 6, peak_at: 0.4 }] },
		],
	};
	const split = splitMoves(read, [{ id: "fly", from: 2, to: 6 }]);
	assert.deepEqual(split.film, { seconds: 2, moves: 1, timeInMove: 0.3, moveMedianS: 0.6, zoomMax: 1.04 });
	assert.deepEqual(split.clips, { seconds: 4, moves: 2, timeInMove: 0.95, moveMedianS: 1.9, zoomMax: 1.9, shots: ["fly"] });
	const report = formatReport({ duration: 6, cuts: 1, cutsPerMin: 10, moveSplit: split });
	assert.match(report, /outside clips: 30 % in a move, 1 moves, median 0\.60 s, zoom max 1\.04x/);
	assert.match(report, /inside clips \(fly\): 95 % in a move, 2 moves, median 1\.90 s, zoom max 1\.90x/);
	assert.match(report, /footage's own motion/);
	assert.equal(splitMoves(read, []), null);
});

test("a freezedetect failure is an error, not a frozen share of 0 %", () => {
	const text = "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 1.5\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 2\n";
	assert.equal(freezeMeasure({ status: 0, stderr: text }, 10).frozenShare, 0.05);
	assert.throws(() => freezeMeasure({ status: 1, stderr: "Invalid data found when processing input" }, 10), /freezedetect failed[\s\S]*Invalid data/);
	assert.throws(() => freezeMeasure({ status: null, error: new Error("spawn ffmpeg ENOENT") }, 10), /freezedetect failed[\s\S]*ENOENT/);
});
