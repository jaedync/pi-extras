/**
 * wv check blocks a film only on objective defects. The rules are pure
 * functions over frame facts, tested here with hand-made facts; one test
 * renders a small synthetic film with ffmpeg and plants each defect in it.
 * The golden film test runs with WV_INTEGRATION=1 when the file is on disk.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { audioDefects, checkFilm, masterLengthRefusal, staircases, videoDefects, muxDefects } from "../skills/walkthrough-video/scripts/film/check.mjs";
import { normalizeStoryboard } from "../skills/walkthrough-video/scripts/film/storyboard.mjs";

const WV = fileURLToPath(new URL("../skills/walkthrough-video/scripts/wv.mjs", import.meta.url));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** Facts for a 3 s, 60 fps film that moves on every frame. */
function facts(patch = {}) {
	const frames = 180;
	return { fps: 60, frames, repeats: Array.from({ length: frames }, () => false), diffs: Array.from({ length: frames }, (_, i) => (i === 0 ? 0 : 1)), near: new Map(), ...patch };
}
const twoShots = (extra = {}) => normalizeStoryboard({ fps: 60, shots: [{ id: "a", seconds: 1 }, { id: "b", seconds: 2, ...extra }] });
const withRepeats = (list) => {
	const f = facts();
	for (const i of list) {
		f.repeats[i] = true;
		f.diffs[i] = 0;
	}
	return f;
};
const kinds = (defects) => defects.map((d) => d.kind);

test("a film shorter than the storyboard, by more than a frame, is a length defect that names both", () => {
	// A master mixed for a longer cut, then muxed with -shortest, cuts the end of the picture.
	const short = videoDefects(facts({ frames: 150 }), twoShots());
	assert.deepEqual(kinds(short), ["length"]);
	assert.match(short[0].message, /150 frames/);
	assert.match(short[0].message, /180 frames/);
	assert.match(short[0].fix, /wv film render/);
	assert.deepEqual(videoDefects(facts({ frames: 179 }), twoShots()), [], "one frame of slack is rounding");
});

test("a mux refuses a master shorter than the picture by more than a frame, and names both lengths", () => {
	const refusal = masterLengthRefusal({ fps: 60, videoS: 30, audioS: 24.5 });
	assert.ok(refusal);
	assert.match(refusal, /24\.5\d s/);
	assert.match(refusal, /30\.00 s/);
	assert.match(refusal, /wv sound mix/);
	assert.equal(masterLengthRefusal({ fps: 60, videoS: 30, audioS: 29.99 }), null, "a frame of rounding is not a defect");
	assert.equal(masterLengthRefusal({ fps: 30, videoS: 30, audioS: 30.5 }), null, "a longer master is cut to the picture");
});

test("a slow drift on centred text that mpdecimate calls a repeat still moves, so it is no repeat_at_cut", () => {
	// A synthetic 4 % linear drift on centred text after a cut: mpdecimate dropped 2 of the first
	// 3 frames, but each of them moves 0.054 levels, as fast as the rest of the shot (a true repeat: 0.000).
	const f = facts();
	for (let i = 61; i < 180; i++) f.diffs[i] = 0.054;
	for (const i of [61, 63]) f.repeats[i] = true;
	assert.deepEqual(videoDefects(f, twoShots()), []);
	f.diffs[63] = 0.001;
	assert.equal(videoDefects(f, twoShots())[0].count, 1);
	// The golden film's 2 s cut: the head moves 0.050 and 0.009, then the shot's motion is about 1:
	// the head is a stop that the owner saw, so it stays a defect.
	const golden = withRepeats([61, 62]);
	golden.diffs[61] = 0.05;
	golden.diffs[62] = 0.009;
	assert.equal(videoDefects(golden, twoShots())[0].count, 2);
});

test("a film that moves on every frame has no defects", () => {
	assert.deepEqual(videoDefects(facts(), twoShots()), []);
});

test("repeated frames just after a cut are a defect, named with the cut time and the count", () => {
	const defects = videoDefects(withRepeats([61, 62]), twoShots());
	assert.deepEqual(kinds(defects), ["repeat_at_cut"]);
	assert.equal(defects[0].frame, 60);
	assert.equal(defects[0].count, 2);
	assert.match(defects[0].message, /1\.000 s/);
	assert.match(defects[0].fix, /cut on action|hold/i);
});

test("a still opening that the storyboard declares is not a defect", () => {
	assert.deepEqual(videoDefects(withRepeats([61, 62]), twoShots({ holds: [[0, 0.1]] })), []);
});

test("a run of repeats of 0.2 s or more inside a shot is a freeze unless the storyboard holds it", () => {
	const run = Array.from({ length: 18 }, (_, i) => 100 + i);
	const defects = videoDefects(withRepeats(run), twoShots());
	assert.deepEqual(kinds(defects), ["freeze"]);
	assert.equal(defects[0].frame, 99);
	assert.ok(Math.abs(defects[0].seconds - 0.3) < 0.02);
	assert.deepEqual(videoDefects(withRepeats(run), twoShots({ holds: [[0.6, 1.0]] })), []);
	// A shorter still run (an ease that comes to rest) is not a freeze.
	assert.deepEqual(videoDefects(withRepeats(run.slice(0, 8)), twoShots()), []);
});

/** Facts whose steps repeat `cycle` from frame `from` to `to`: a drift that lands in lumps. */
function stepped(cycle, from = 70, to = 170, base = 0.03) {
	const f = facts();
	f.diffs = f.diffs.map((d, i) => (i === 0 ? 0 : i >= from && i < to ? cycle[(i - from) % cycle.length] : base));
	return f;
}

test("a drift that moves in periodic lumps (every 4th frame carries the motion) is a staircase", () => {
	const defects = videoDefects(stepped([0.035, 0.072, 0.044, 0.027]), twoShots());
	assert.deepEqual(kinds(defects), ["staircase"]);
	assert.equal(defects[0].period, 4);
	assert.match(defects[0].message, /shot "b"/);
	assert.match(defects[0].message, /every 4/);
	assert.match(defects[0].fix, /--workers 1|wv film render/);
});

test("an even drift, Chrome's own two-frame alternation and an ease are not a staircase", () => {
	assert.deepEqual(staircases(stepped([0.04]).diffs, twoShots()), []);
	assert.deepEqual(staircases(stepped([0.049, 0.029]).diffs, twoShots()), []);
	const ease = facts();
	ease.diffs = ease.diffs.map((_, i) => (i === 0 ? 0 : 2 * Math.exp(-i / 40)));
	assert.deepEqual(staircases(ease.diffs, twoShots()), []);
});

test("a staircase inside a declared hold, or a lone pop on a cut, is not a defect", () => {
	assert.deepEqual(videoDefects(stepped([0.035, 0.072, 0.044, 0.027]), twoShots({ holds: [[0, 2]] })), []);
	const cut = facts();
	cut.diffs = cut.diffs.map((d, i) => (i === 60 ? 40 : 0.04));
	assert.deepEqual(staircases(cut.diffs, twoShots()), []);
});

test("a hold covers its own frames only: a freeze that runs past it is still a defect", () => {
	const run = Array.from({ length: 40 }, (_, i) => 100 + i);
	assert.deepEqual(kinds(videoDefects(withRepeats(run), twoShots({ holds: [[0.6, 0.8]] }))), ["freeze"]);
});

test("a frame at a cut that mixes the two shots is a ghost", () => {
	const n = 64;
	const a = new Uint8Array(n).fill(40);
	const b = new Uint8Array(n).fill(200);
	const ghost = new Uint8Array(n).fill(120);
	const near = new Map([[58, a], [59, a], [60, ghost], [61, b]]);
	assert.deepEqual(kinds(videoDefects(facts({ near }), twoShots())), ["ghost_at_cut"]);
	const clean = new Map([[58, a], [59, a], [60, b], [61, b]]);
	assert.deepEqual(videoDefects(facts({ near: clean }), twoShots()), []);
});

test("loudness out of range, a true peak over -1 dBTP and clipped samples are defects", () => {
	assert.deepEqual(audioDefects({ lufs: -16.4, truePeak: -1.6, clipped: 0 }), []);
	assert.deepEqual(kinds(audioDefects({ lufs: -20.4, truePeak: -3, clipped: 0 })), ["loudness"]);
	assert.deepEqual(kinds(audioDefects({ lufs: -16, truePeak: -0.2, clipped: 0 })), ["true_peak"]);
	assert.deepEqual(kinds(audioDefects({ lufs: -16, truePeak: -1.2, clipped: 40 })), ["clipping"]);
	// A sparse master (cues, no bed) is peak-bound: its peaks sit at the ceiling, so it cannot be louder.
	assert.deepEqual(audioDefects({ lufs: -21.8, truePeak: -1.0, clipped: 0 }), []);
	assert.deepEqual(kinds(audioDefects({ lufs: -21.8, truePeak: -2.5, clipped: 0 })), ["loudness"], "headroom left: it was not mastered");
	assert.deepEqual(kinds(audioDefects({ lufs: -13.5, truePeak: -1.0, clipped: 0 })), ["loudness"], "too loud is always a defect");
	assert.deepEqual(kinds(audioDefects(null)), ["no_audio"]);
});

/** Writes a 640x360 60 fps film from a frame function, with an optional tone (dB over ffmpeg's -18 dBFS sine). */
function renderSynthetic(file, frameAt, frames, { tone = null } = {}) {
	const W = 640;
	const H = 360;
	const args = ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", "60", "-i", "-"];
	if (tone) args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${frames / 60},volume=${tone}dB`);
	args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p");
	if (tone) args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
	args.push(file);
	return new Promise((resolve, reject) => {
		const ff = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "inherit"] });
		ff.on("error", reject);
		ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
		for (let i = 0; i < frames; i++) ff.stdin.write(frameAt(i, W, H));
		ff.stdin.end();
	});
}

/** A bright square that moves 6 px a frame, on a ground that differs by shot. */
function square(i, W, H, ground) {
	const buf = Buffer.alloc(W * H, ground);
	const x0 = 40 + ((i * 6) % (W - 140));
	for (let y = 120; y < 220; y++) buf.fill(ground > 128 ? 20 : 235, y * W + x0, y * W + x0 + 100);
	return buf;
}

test("wv check finds the planted repeat, freeze and ghost in a synthetic film", { skip: hasFfmpeg ? false : "ffmpeg is not on PATH", timeout: 60000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-check-"));
	try {
		const film = join(dir, "film.mp4");
		const repeat = new Set([61, 62]);
		const freeze = new Set(Array.from({ length: 18 }, (_, i) => 120 + i));
		await renderSynthetic(
			film,
			(i, W, H) => {
				// The shot-a picture is a dark ground, shot b a light one; frame 59 mixes both (the ghost).
				let j = i;
				if (repeat.has(i)) j = 60;
				if (freeze.has(i)) j = 119;
				if (i === 59) {
					const a = square(58, W, H, 40);
					const b = square(61, W, H, 200);
					return Buffer.from(a.map((v, k) => (v + b[k]) >> 1));
				}
				return square(j, W, H, j < 60 ? 40 : 200);
			},
			180,
		);
		writeFileSync(join(dir, "storyboard.json"), JSON.stringify({ fps: 60, shots: [{ id: "a", seconds: 1 }, { id: "b", seconds: 2 }] }));
		const result = await checkFilm({ video: film, storyboard: join(dir, "storyboard.json"), audio: false });
		const found = kinds(result.defects);
		assert.ok(found.includes("repeat_at_cut"), found.join(","));
		assert.ok(found.includes("freeze"), found.join(","));
		assert.ok(found.includes("ghost_at_cut"), found.join(","));
		assert.equal(result.ok, false);
		const cli = spawnSync(process.execPath, [WV, "check", film, "--storyboard", join(dir, "storyboard.json"), "--no-audio"], { encoding: "utf8" });
		assert.equal(cli.status, 1, cli.stdout + cli.stderr);
		assert.match(cli.stdout, /FAIL repeat_at_cut/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("wv check passes a clean synthetic film with good loudness", { skip: hasFfmpeg ? false : "ffmpeg is not on PATH", timeout: 60000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-check-"));
	try {
		const film = join(dir, "film.mp4");
		await renderSynthetic(film, (i, W, H) => square(i, W, H, i < 60 ? 40 : 200), 180, { tone: 6 });
		writeFileSync(join(dir, "storyboard.json"), JSON.stringify({ fps: 60, shots: [{ id: "a", seconds: 1 }, { id: "b", seconds: 2 }] }));
		const result = await checkFilm({ video: film, storyboard: join(dir, "storyboard.json") });
		assert.deepEqual(kinds(result.defects), [], JSON.stringify(result.defects, null, 1));
		assert.equal(result.ok, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("wv check fails when the owner's rejected-sounds list does not parse", { skip: hasFfmpeg ? false : "ffmpeg is not on PATH", timeout: 60000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-check-rej-"));
	try {
		const film = join(dir, "film.mp4");
		await renderSynthetic(film, (i, W, H) => square(i, W, H, i < 60 ? 40 : 200), 180);
		writeFileSync(join(dir, "storyboard.json"), JSON.stringify({ fps: 60, shots: [{ id: "a", seconds: 1 }, { id: "b", seconds: 2 }] }));
		const list = join(dir, "rejected-sounds.json");
		writeFileSync(list, "not json");
		const r = spawnSync(process.execPath, [WV, "check", film, "--storyboard", join(dir, "storyboard.json"), "--no-audio"], { encoding: "utf8", env: { ...process.env, WV_REJECTED_SOUNDS: list } });
		assert.equal(r.status, 1, r.stdout + r.stderr);
		assert.match(`${r.stdout}${r.stderr}`, /rejected-sounds\.json/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a length mismatch is one defect, not a defect and a note that says the same", { skip: hasFfmpeg ? false : "ffmpeg is not on PATH", timeout: 60000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-check-len-"));
	try {
		const film = join(dir, "film.mp4");
		await renderSynthetic(film, (i, W, H) => square(i, W, H, i < 60 ? 40 : 200), 180);
		// The storyboard plans 4 s at 60 fps; the picture is 3 s.
		writeFileSync(join(dir, "storyboard.json"), JSON.stringify({ fps: 60, shots: [{ id: "a", seconds: 1 }, { id: "b", seconds: 3 }] }));
		const result = await checkFilm({ video: film, storyboard: join(dir, "storyboard.json"), audio: false });
		assert.equal(kinds(result.defects).filter((kind) => kind === "length").length, 1);
		assert.equal(result.notes.filter((note) => /has \d+ frames/.test(note)).length, 0, `the note repeats the defect: ${result.notes.join(" | ")}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const GOLDEN = "/tmp/wv-golden/pointer-film.mp4";
const GOLDEN_SB = "/tmp/wv-golden/src/storyboard.json";
const goldenSkip = process.env.WV_INTEGRATION !== "1" ? "set WV_INTEGRATION=1 to check the golden film" : !existsSync(GOLDEN) || !existsSync(GOLDEN_SB) ? "the golden film is not on disk" : false;

test("wv check fails the golden film on its repeated frames at cuts and the freeze at 23.07 s", { skip: goldenSkip, timeout: 120000 }, async () => {
	const result = await checkFilm({ video: GOLDEN, storyboard: GOLDEN_SB });
	assert.equal(result.ok, false);
	const atCuts = result.defects.filter((d) => d.kind === "repeat_at_cut").map((d) => d.frame / 60);
	for (const t of [2, 4, 6, 11, 15, 17]) assert.ok(atCuts.includes(t), `repeat at the ${t} s cut: ${atCuts.join(", ")}`);
	const freezes = result.defects.filter((d) => d.kind === "freeze");
	// main measured a 0.25 s freeze from 23.07 s and a 0.45 s freeze from 26.55 s; a reported freeze must cover each.
	const covers = (from, seconds) => freezes.some((d) => d.frame / 60 <= from + 0.01 && d.frame / 60 + d.seconds >= from + seconds - 0.01);
	assert.ok(covers(23.07, 0.25), JSON.stringify(freezes));
	assert.ok(covers(26.55, 0.45), JSON.stringify(freezes));
});

test("mux: a sound track or a master whose length is not the picture's, by more than a frame, is a defect", () => {
	assert.deepEqual(muxDefects({ fps: 30, videoS: 25, audioS: 25.021, masterS: 25 }), []);
	const [track] = muxDefects({ fps: 30, videoS: 25, audioS: 25.8, masterS: null });
	assert.equal(track.kind, "mux_length");
	assert.match(track.message, /25\.80 s.*25\.00 s/);
	// film2: the mix failed, and the mux took the master of the longer cut before it (-shortest cut it to the picture).
	const [stale] = muxDefects({ fps: 30, videoS: 25, audioS: 25, masterS: 25.8 });
	assert.equal(stale.kind, "stale_master");
	assert.match(stale.fix, /wv sound mix.*wv film mux/);
	assert.deepEqual(muxDefects({ fps: 60, videoS: 10, audioS: null, masterS: null }), []);
});

test("a freeze that runs to the end of its shot gets a hold fix that runs to \"end\"", () => {
	const run = Array.from({ length: 59 }, (_, i) => 121 + i);
	const [d] = videoDefects(withRepeats(run), twoShots());
	assert.equal(d.kind, "freeze");
	assert.match(d.fix, /holds: \[\[1\.00, "end"\]\]/);
	assert.deepEqual(videoDefects(withRepeats(run), twoShots({ holds: [[1, "end"]] })), []);
});
