/**
 * The camera estimator, end to end: motion.py run through film/motion.mjs on
 * synthetic clips whose camera motion is known. Each clip is built with the
 * runtime venv's numpy and cv2 (or ffmpeg) from a textured image, so ORB has
 * real features to match. The file is skipped when the venv or its cv2 is
 * missing: `wv setup` installs both.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { cameraMoves, estimatorReady } from "../skills/walkthrough-video/scripts/film/motion.mjs";
import { paths } from "../skills/walkthrough-video/scripts/lib/paths.mjs";

const python = paths().python;
const reason = estimatorReady(python) ? false : `the runtime venv with cv2 is missing at ${python}: run wv setup`;
const haveFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const skip = reason || (haveFfmpeg ? false : "ffmpeg is not installed");

const FPS = 60;
const WIDTH = 960;
const HEIGHT = 540;
/** 0.25 s still, then a 0.7 s cosine-eased move, then still: 2 s at 60 fps. */
const MOVE_START = 15;
const MOVE_END = 57;
const PAN_PX = 150;

const work = mkdtempSync(join(tmpdir(), "wv-motion-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

/** Builds one synthetic clip in the temp dir and returns its path. */
const BUILDER = String.raw`
import subprocess, sys
import cv2, numpy as np

kind, out, fps, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
MOVE_START, MOVE_END, PAN_PX = 15, 57, 150


def source(seed):
	"""A UI-like page: random blocks plus text, so ORB has corners and edges."""
	rng = np.random.default_rng(seed)
	img = np.full((h, w, 3), 26, np.uint8)
	img[:, :] = (38, 34, 32)
	for _ in range(28):
		x = int(rng.integers(0, w - 40)); y = int(rng.integers(0, h - 30))
		bw = int(rng.integers(24, 150)); bh = int(rng.integers(12, 56))
		c = tuple(int(v) for v in rng.integers(60, 235, 3))
		cv2.rectangle(img, (x, y), (min(x + bw, w - 1), min(y + bh, h - 1)), c, -1)
	cv2.rectangle(img, (20, 20), (w - 21, h - 21), (210, 208, 200), 2)
	for i, line in enumerate(["Trial expired", "Usage 12 of 40", "Sign in to continue", "Camera check", "Frame 1080"]):
		cv2.putText(img, line, (40, 70 + i * 62), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (240, 240, 240), 2, cv2.LINE_AA)
	return cv2.GaussianBlur(img, (3, 3), 0)


def ease(x):
	return 0.5 - 0.5 * np.cos(np.pi * float(np.clip(x, 0.0, 1.0)))


def moved(img, i):
	s = 1.0 if i < MOVE_START else (1.5 if i > MOVE_END else 1.0 + 0.5 * ease((i - MOVE_START) / (MOVE_END - MOVE_START)))
	tx = 0.0 if i < MOVE_START else (PAN_PX if i > MOVE_END else PAN_PX * ease((i - MOVE_START) / (MOVE_END - MOVE_START)))
	cw, ch = int(w / s), int(h / s)
	cx, cy = w / 2 + tx, h / 2
	x0 = int(np.clip(cx - cw / 2, 0, w - cw)); y0 = int(np.clip(cy - ch / 2, 0, h - ch))
	return cv2.resize(img[y0:y0 + ch, x0:x0 + cw], (w, h), interpolation=cv2.INTER_AREA)


def panned(img, i, axis):
	"""A pan with no zoom: a fixed window over the page moves sideways or up."""
	e = 0.0 if i < MOVE_START else (1.0 if i > MOVE_END else ease((i - MOVE_START) / (MOVE_END - MOVE_START)))
	dx = PAN_PX * e if axis == "x" else 0.0
	dy = -PAN_PX * e if axis == "y" else 0.0
	cw, ch = w - 2 * PAN_PX, h - 2 * PAN_PX
	cx, cy = w / 2 + dx, h / 2 + dy
	x0 = int(np.clip(cx - cw / 2, 0, w - cw)); y0 = int(np.clip(cy - ch / 2, 0, h - ch))
	return cv2.resize(img[y0:y0 + ch, x0:x0 + cw], (w, h), interpolation=cv2.INTER_AREA)


n = int(round(2 * fps))
one = source(1)
if kind == "still":
	frames = [one] * n
elif kind == "move":
	frames = [moved(one, i) for i in range(n)]
elif kind == "panx":
	frames = [panned(one, i, "x") for i in range(n)]
elif kind == "pany":
	frames = [panned(one, i, "y") for i in range(n)]
elif kind == "cut2":
	two = source(7)
	frames = [one if i < n // 2 else two for i in range(n)]
else:
	raise SystemExit("unknown clip kind " + kind)

p = subprocess.Popen(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
	"-s", "%dx%d" % (w, h), "-r", str(fps), "-i", "-", "-c:v", "libx264", "-preset", "veryfast",
	"-crf", "12", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
for f in frames:
	p.stdin.write(np.ascontiguousarray(f).tobytes())
p.stdin.close()
raise SystemExit(p.wait())
`;

const built = new Map();

function clip(kind) {
	if (!built.has(kind)) {
		const file = join(work, `${kind}.mp4`);
		const made = spawnSync(python, ["-I", "-c", BUILDER, kind, file, String(FPS), String(WIDTH), String(HEIGHT)], { encoding: "utf8", timeout: 120000 });
		assert.equal(made.status, 0, `building the ${kind} clip failed: ${made.stderr || made.error}`);
		built.set(kind, file);
	}
	return built.get(kind);
}

/** The estimator reports seconds; keep every comparison in one place. */
const near = (actual, expected, tolerance) => Math.abs(actual - expected) <= tolerance;

test("a still clip is not moving and does not zoom", { skip, timeout: 180000 }, async () => {
	const read = await cameraMoves(clip("still"), { fps: FPS, cuts: [] });
	assert.equal(read.frames, 120);
	assert.equal(read.shots.length, 1);
	assert.equal(read.moves_n, 0, JSON.stringify(read.shots));
	assert.equal(read.time_in_move_share, 0);
	assert.ok(near(read.zoom_max_in_shot, 1, 0.01), `zoom_max_in_shot ${read.zoom_max_in_shot}`);
	assert.ok(read.shots[0].valid_frac >= 0.9, `valid_frac ${read.shots[0].valid_frac}`);
});

test("the calibration move reads back as zoom 1.5 over 0.7 s with an ease peak at 0.5", { skip, timeout: 180000 }, async () => {
	const read = await cameraMoves(clip("move"), { fps: FPS, cuts: [] });
	assert.equal(read.moves_n, 1, JSON.stringify(read.shots[0].moves));
	assert.ok(near(read.zoom_max_in_shot, 1.5, 0.045), `zoom_max_in_shot ${read.zoom_max_in_shot}`);
	const [move] = read.shots[0].moves;
	const seconds = move.end - move.start;
	assert.ok(near(seconds, 0.7, 0.15), `move duration ${seconds} s (moves ${JSON.stringify(read.shots[0].moves)})`);
	assert.ok(near(move.peak_at, 0.5, 0.15), `peak_at ${move.peak_at}`);
	assert.ok(near(read.ease_peak_median, 0.5, 0.15), `ease_peak_median ${read.ease_peak_median}`);
	assert.ok(near(read.move_dur_median_s, 0.7, 0.15), `move_dur_median_s ${read.move_dur_median_s}`);
});

test("a horizontal pan with no zoom reads as a camera move", { skip, timeout: 180000 }, async () => {
	const read = await cameraMoves(clip("panx"), { fps: FPS, cuts: [] });
	assert.equal(read.moves_n, 1, JSON.stringify(read.shots[0].moves));
	const [move] = read.shots[0].moves;
	assert.ok(near(move.end - move.start, 0.7, 0.15), `move duration ${move.end - move.start} s`);
	assert.ok(near(read.zoom_max_in_shot, 1, 0.02), `zoom_max_in_shot ${read.zoom_max_in_shot}`);
	assert.ok(read.pan_max_in_shot_widths > 0.1, `pan_max_in_shot_widths ${read.pan_max_in_shot_widths}`);
});

test("an upward pan with no zoom reads as a camera move", { skip, timeout: 180000 }, async () => {
	const read = await cameraMoves(clip("pany"), { fps: FPS, cuts: [] });
	assert.equal(read.moves_n, 1, JSON.stringify(read.shots[0].moves));
	assert.ok(near(read.zoom_max_in_shot, 1, 0.02), `zoom_max_in_shot ${read.zoom_max_in_shot}`);
	assert.ok(read.pan_max_in_shot_widths > 0.1, `pan_max_in_shot_widths ${read.pan_max_in_shot_widths}`);
});

test("a cut between two still images splits the shots and starts no move", { skip, timeout: 180000 }, async () => {
	const read = await cameraMoves(clip("cut2"), { fps: FPS, cuts: [60] });
	assert.equal(read.shots.length, 2, JSON.stringify(read.shots.map((shot) => [shot.start, shot.end])));
	assert.equal(read.shots[0].start, 0);
	assert.equal(read.shots[0].end, 1);
	assert.equal(read.shots[1].start, 1);
	assert.equal(read.shots[1].end, 2);
	assert.equal(read.moves_n, 0, JSON.stringify(read.shots));
	for (const shot of read.shots) {
		for (const move of shot.moves) assert.ok(move.start >= shot.start && move.end <= shot.end, `move ${JSON.stringify(move)} leaves its shot ${shot.start} to ${shot.end}`);
	}
});

test("the same clip with no cut list still reports one shot", { skip, timeout: 180000 }, async () => {
	const read = await cameraMoves(clip("cut2"), { fps: FPS, cuts: [] });
	assert.equal(read.shots.length, 1);
	assert.equal(read.frames, 120);
	for (const key of ["zoom_max_in_shot", "pan_max_in_shot_widths", "time_in_move_share"]) assert.ok(Number.isFinite(read[key]), `${key} is not a number: ${read[key]}`);
	for (const shot of read.shots) {
		assert.ok(Number.isFinite(shot.valid_frac) && Number.isFinite(shot.persp_median), JSON.stringify(shot));
	}
});
