import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { paths } from "../skills/walkthrough-video/scripts/lib/paths.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCORE_PY = join(ROOT, "skills", "walkthrough-video", "scripts", "py", "score");
const WV = join(ROOT, "skills", "walkthrough-video", "scripts", "wv.mjs");
const PYTHON = paths().python;
/** npm test runs with a temp HOME, so the venv is often absent: skip the whole file then. */
const missingVenv = existsSync(PYTHON) ? false : `the sound tests need the runtime venv python (${PYTHON}); run "wv setup", then try again`;

/**
 * Fixtures: a click track with an accent every 4 beats, a kick with off-beat
 * hats, a bed whose level jumps 10 dB at a downbeat, and two round-robin
 * click files and one typing take. Written by the venv python, so the tests
 * measure the code against audio it did not make itself.
 */
const FIXTURES = `
import sys
import numpy as np
import soundfile as sf

out = sys.argv[1]
SR = 48000

def write(name, x, rate=SR):
    sf.write(out + "/" + name, np.clip(x, -1, 1), rate, subtype="PCM_16")

def to_rate(x, rate):
    # Linear interpolation is enough for a fixture: same pitch and tempo at another rate.
    return np.interp(np.arange(int(round(len(x) * rate / SR))) * (SR / rate), np.arange(len(x)), x)

def click(freq=2000.0, dur=0.02, decay=60.0, amp=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = amp * np.sin(2 * np.pi * freq * t) * np.exp(-t * decay)
    x[:48] *= np.linspace(0, 1, 48)
    return x

def track(bpm, dur, accent_every=4, accent_gain=1.0, base_gain=0.4):
    x = np.zeros(int(dur * SR))
    period = 60.0 / bpm
    c = click()
    k = 0
    while True:
        t = k * period
        if t >= dur - 0.05:
            break
        s = int(round(t * SR))
        m = min(len(c), len(x) - s)
        x[s:s + m] += (accent_gain if k % accent_every == 0 else base_gain) * c[:m]
        k += 1
    return x

def kick_hat(bpm, dur):
    x = np.zeros(int(dur * SR))
    period = 60.0 / bpm
    kick = click(freq=60.0, dur=0.12, decay=18.0, amp=0.7)
    for k in range(int(dur / period)):
        s = int(round(k * period * SR))
        m = min(len(kick), len(x) - s)
        x[s:s + m] += kick[:m]
        s2 = int(round((k + 0.5) * period * SR))
        hat = click(freq=9000.0, dur=0.03, decay=120.0, amp=0.5)
        m = min(len(hat), len(x) - s2)
        x[s2:s2 + m] += hat[:m]
    return x

def bed(dur=40.0, bpm=120.0, lift_at=24.0, lift_db=10.0):
    x = track(bpm, dur)
    rng = np.random.default_rng(7)
    pad = np.convolve(rng.standard_normal(len(x)) * 0.02, np.ones(240) / 240, "same")
    x = x + pad
    x[int(lift_at * SR):] *= 10 ** (lift_db / 20.0)
    return x

def sfx(name, freq, decay, amp, lead_s=0.005):
    return np.concatenate([np.zeros(int(lead_s * SR)), click(freq=freq, decay=decay, amp=amp)])

write("click-120.wav", track(120, 30))
write("click-117.wav", track(117, 30))
write("kick-128.wav", kick_hat(128, 30))
write("bed-40.wav", bed())
write("bed-100.wav", bed(bpm=100.0))
write("bed-441.wav", to_rate(bed(), 44100), rate=44100)
write("sfx/tick-01.wav", sfx("tick-01.wav", 2000.0, 60.0, 1.0))
write("sfx/tick441.wav", to_rate(sfx("tick441.wav", 2000.0, 60.0, 1.0), 44100), rate=44100)
write("sfx/tick-02.wav", sfx("tick-02.wav", 1200.0, 40.0, 0.5))
write("sfx/slam.wav", sfx("slam.wav", 400.0, 25.0, 0.8, lead_s=0.01))
write("sfx/snap.wav", sfx("snap.wav", 3000.0, 400.0, 1.0))
# A recorded card landing: 150 ms of soft slide at 15 % of the peak before the hit.
slide = np.random.default_rng(3).standard_normal(int(0.15 * SR)) * 0.05
write("sfx/soft-land.wav", np.concatenate([slide, click(freq=900.0, decay=40.0, amp=1.0)]))
hits = [sfx("hit", 1500.0 + 100.0 * i, 70.0, 0.6 + 0.05 * i) for i in range(6)]
take = np.zeros(int(2.4 * SR))
for i, h in enumerate(hits):
    s = int(0.3 * SR) + i * int(0.33 * SR)
    take[s:s + len(h)] += h
write("sfx/typing-take-01.wav", take)
# A mono take whose last hit is cut off by the end of the file: the cut pads it.
tail = np.zeros(int(1.0 * SR))
last = sfx("tail", 1200.0, 50.0, 0.7)
cut = int(0.01 * SR)
tail[-cut:] = last[:cut]
write("sfx/tail-take-01.wav", tail)
# A file with a .wav name that holds no audio.
open(out + "/sfx/broken.wav", "w").write("not a wav")
print("ok")
`;

function makeFixtures() {
	const dir = mkdtempSync(join(tmpdir(), "wv-sound-"));
	mkdirSync(join(dir, "sfx"), { recursive: true });
	const script = join(dir, "make-fixtures.py");
	writeFileSync(script, FIXTURES);
	const result = spawnSync(PYTHON, ["-I", script, dir], { encoding: "utf8" });
	assert.equal(result.status, 0, `the fixtures failed: ${result.stderr}`);
	return {
		dir,
		click120: join(dir, "click-120.wav"),
		click117: join(dir, "click-117.wav"),
		kick128: join(dir, "kick-128.wav"),
		bed: join(dir, "bed-40.wav"),
		bed100: join(dir, "bed-100.wav"),
		bed441: join(dir, "bed-441.wav"),
		sfx: join(dir, "sfx"),
	};
}

const fixtures = missingVenv ? null : makeFixtures();
after(() => {
	if (fixtures) rmSync(fixtures.dir, { recursive: true, force: true });
});

/** Runs the real command through wv, so the test reads the same exit code and text the author does. */
function run(argv) {
	const result = spawnSync(process.execPath, [WV, "sound", ...argv], { encoding: "utf8" });
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeCues(file, sheet) {
	writeFileSync(file, JSON.stringify(sheet, null, 1));
	return file;
}

/** Decodes the left channel of a WAV at 48 kHz with ffmpeg; no downmix gain, so peaks read true. */
function readMono(file) {
	const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-af", "pan=mono|c0=c0", "-f", "f32le", "-ar", "48000", "-"], { maxBuffer: 1 << 28 });
	assert.equal(result.status, 0, `ffmpeg could not read ${file}: ${result.stderr}`);
	const buffer = result.stdout;
	return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}

/** Integrated loudness and true peak, as the command itself measures them. */
function measure(file) {
	const result = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
	assert.equal(result.status, 0, `ffmpeg could not measure ${file}: ${result.stderr}`);
	const loudness = [...result.stderr.matchAll(/I:\s+(-?[0-9.]+) LUFS/g)];
	const peaks = [...result.stderr.matchAll(/Peak:\s+(-?[0-9.]+) dBFS/g)];
	assert.ok(loudness.length && peaks.length, `no loudness in the ebur128 output for ${file}`);
	return { lufs: Number(loudness[loudness.length - 1][1]), truePeak: Number(peaks[peaks.length - 1][1]) };
}

/** The first sample that passes 10 % of the region's peak, and the region's peak in dBFS. */
function onsetAndPeak(samples, t, span = 0.2) {
	const from = Math.max(0, Math.round((t - 0.05) * 48000));
	const to = Math.min(samples.length, Math.round((t + span) * 48000));
	let peak = 0;
	for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]));
	let onset = -1;
	for (let i = from; i < to; i++) {
		if (Math.abs(samples[i]) > peak * 0.1) {
			onset = i;
			break;
		}
	}
	return { onset: onset / 48000, peakDb: 20 * Math.log10(peak), found: onset >= 0 };
}

test("tempo reads 120 and 117 BPM and puts the downbeats on the accents", { skip: missingVenv }, async () => {
	const a = await run(["tempo", fixtures.click120, "--json"]);
	const b = await run(["tempo", fixtures.click117, "--json"]);
	assert.equal(a.code, 0);
	assert.equal(b.code, 0);
	const one = JSON.parse(a.stdout);
	const two = JSON.parse(b.stdout);
	assert.ok(Math.abs(one.bpm - 120) <= 0.05, `120 BPM track read as ${one.bpm}`);
	assert.ok(Math.abs(two.bpm - 117) <= 0.05, `117 BPM track read as ${two.bpm}`);
	assert.ok(one.downbeats.length >= 12, `only ${one.downbeats.length} downbeats in a 30 s track`);
	for (const beat of one.downbeats) assert.ok(Math.abs(beat - 2 * Math.round(beat / 2)) < 0.03, `the downbeat at ${beat} s is not on an accent (every 2 s)`);
});

test("a four-on-the-floor kick with off-beat hats reads 128 BPM, not 64 or 256", { skip: missingVenv }, async () => {
	const result = await run(["tempo", fixtures.kick128, "--json"]);
	assert.equal(result.code, 0);
	const measured = JSON.parse(result.stdout);
	assert.ok(Math.abs(measured.bpm - 128) <= 0.1, `the 128 BPM kick track read as ${measured.bpm}`);
});

test("the biggest lift is the downbeat where the bed jumps 10 dB", { skip: missingVenv }, async () => {
	const result = await run(["tempo", fixtures.bed, "--json"]);
	assert.equal(result.code, 0);
	const measured = JSON.parse(result.stdout);
	assert.ok(measured.lifts.length >= 5, `only ${measured.lifts.length} lifts ranked`);
	assert.ok(Math.abs(measured.lifts[0].downbeat_s - 24) <= 0.05, `the biggest lift is at ${measured.lifts[0].downbeat_s} s, not 24 s`);
	assert.ok(measured.lifts[0].rise_db > 6, `the lift reads ${measured.lifts[0].rise_db} dB`);
});

test("backtime puts the lift where the film needs it, and names the shortfall when the bed cannot", { skip: missingVenv }, async () => {
	const ok = await run(["backtime", fixtures.bed, "--lift-at", "10", "--duration", "14", "--json"]);
	assert.equal(ok.code, 0, ok.stderr);
	assert.ok(Math.abs(JSON.parse(ok.stdout).offset_s - 14) <= 0.05, `offset ${JSON.parse(ok.stdout).offset_s} s, not 14 s`);
	const short = await run(["backtime", fixtures.bed, "--lift-at", "2", "--duration", "30"]);
	assert.equal(short.code, 1, "a bed that cannot be back-timed must fail");
	assert.match(short.stderr, /12\.0 s/, `the message must say the bed is 12.0 s too short: ${short.stderr}`);
});

test("cues land on their time to 1 ms, the family goes round robin and every peak is set", { skip: missingVenv }, async () => {
	const cues = writeCues(join(fixtures.dir, "place-cues.json"), {
		duration: 4,
		cues: [
			{ t: 1, sound: "tick", peak: -17 },
			{ t: 2.5, sound: "tick", peak: -21 },
			{ t: 3, sound: "tick", peak: -14 },
		],
	});
	const out = join(fixtures.dir, "place-master.wav");
	const result = await run(["mix", cues, "--sfx", fixtures.sfx, "--out", out]);
	assert.equal(result.code, 0, result.stderr);
	const report = JSON.parse(readFileSync(`${out}.report.json`, "utf8"));
	assert.deepEqual(report.cues.map((cue) => cue.file), ["tick-01.wav", "tick-02.wav", "tick-01.wav"]);
	const fx = readMono(`${out}.fx.wav`);
	for (const [index, cue] of report.cues.entries()) {
		const at = onsetAndPeak(fx, cue.t);
		assert.ok(at.found, `no sound near ${cue.t} s`);
		assert.ok(Math.abs(at.onset - cue.t) <= 0.001, `cue ${index + 1} onsets at ${at.onset} s, not ${cue.t} s`);
		assert.ok(Math.abs(at.peakDb - cue.peak) <= 0.5, `cue ${index + 1} peaks at ${at.peakDb.toFixed(2)} dBFS, not ${cue.peak}`);
	}
});

test("a cue with a soft lead-in lands its hit on the cue time, not its first whisper", { skip: missingVenv }, async () => {
	const cues = writeCues(join(fixtures.dir, "soft-cues.json"), {
		duration: 4, fps: 60,
		cues: [{ t: 1.5, sound: "soft-land.wav", peak: -6 }],
	});
	const out = join(fixtures.dir, "soft.wav");
	const result = await run(["mix", cues, "--sfx", fixtures.sfx, "--out", out]);
	assert.equal(result.code, 0, result.stderr);
	const fx = readMono(`${out}.fx.wav`);
	const from = Math.round(1.3 * 48000);
	let peak = 0;
	for (let i = from; i < Math.round(1.8 * 48000); i++) peak = Math.max(peak, Math.abs(fx[i]));
	let hit = from;
	while (Math.abs(fx[hit]) <= peak * 0.5) hit++;
	assert.ok(Math.abs(hit / 48000 - 1.5) <= 0.001, `the hit lands at ${(hit / 48000).toFixed(4)} s, not 1.5 s`);
});

test("a literal .wav cue and a typing take both work, and the take rotates its hits", { skip: missingVenv }, async () => {
	const cues = writeCues(join(fixtures.dir, "take-cues.json"), {
		duration: 4,
		cues: [
			{ t: 0.2, sound: "slam.wav", peak: -12 },
			{ t: 1, sound: "typing", peak: -21 },
			{ t: 1.5, sound: "typing", peak: -21 },
			{ t: 2, sound: "typing", peak: -21 },
			{ t: 2.5, sound: "typing", peak: -21 },
		],
	});
	const out = join(fixtures.dir, "take-master.wav");
	const result = await run(["mix", cues, "--sfx", fixtures.sfx, "--out", out]);
	assert.equal(result.code, 0, result.stderr);
	const report = JSON.parse(readFileSync(`${out}.report.json`, "utf8"));
	assert.equal(report.cues[0].file, "slam.wav");
	const takeFiles = report.cues.slice(1).map((cue) => cue.file);
	assert.equal(new Set(takeFiles).size, 4, `four cues used ${takeFiles.join(", ")}`);
	for (const name of takeFiles) assert.match(name, /typing-take-01\.wav/);
	const fx = readMono(`${out}.fx.wav`);
	for (const cue of report.cues) {
		const at = onsetAndPeak(fx, cue.t, 0.12);
		assert.ok(at.found, `no sound near ${cue.t} s`);
		assert.ok(Math.abs(at.onset - cue.t) <= 0.001, `the cue at ${cue.t} s onsets at ${at.onset} s`);
	}
});

test("a cue name with one file and no family, like ctx.cue(\"slam\"), uses slam.wav", { skip: missingVenv }, async () => {
	const cues = writeCues(join(fixtures.dir, "single-cues.json"), { duration: 2, cues: [{ t: 0.5, sound: "slam", peak: -12 }] });
	const out = join(fixtures.dir, "single-master.wav");
	const result = await run(["mix", cues, "--sfx", fixtures.sfx, "--out", out]);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(JSON.parse(readFileSync(`${out}.report.json`, "utf8")).cues[0].file, "slam.wav");
});

test("a cue name cannot leave the sfx folder: a path, a slash or a dot name is refused", { skip: missingVenv }, async () => {
	for (const name of ["../escape.wav", "/tmp/escape.wav", "sub/escape.wav", ".hidden.wav"]) {
		const cues = writeCues(join(fixtures.dir, `path-${Buffer.from(name).toString("hex")}.json`), { duration: 2, cues: [{ t: 0.5, sound: name, peak: -12 }] });
		const result = await run(["mix", cues, "--sfx", fixtures.sfx, "--out", join(fixtures.dir, "path-master.wav")]);
		assert.notEqual(result.code, 0, `"${name}" was accepted`);
		assert.match(result.stderr, /sfx folder/, `"${name}": ${result.stderr}`);
	}
});

test("a mono take whose last hit is cut off pads in its own channel count, not in stereo", { skip: missingVenv }, async () => {
	const cues = writeCues(join(fixtures.dir, "tail-cues.json"), { duration: 2, cues: [{ t: 0.2, sound: "tail", peak: -14 }] });
	const out = join(fixtures.dir, "tail-master.wav");
	const result = await run(["mix", cues, "--sfx", fixtures.sfx, "--out", out]);
	assert.equal(result.code, 0, result.stderr);
	assert.match(JSON.parse(readFileSync(`${out}.report.json`, "utf8")).cues[0].file, /tail-take-01\.wav/);
});

test("a sound file that holds no audio fails with the file and the reason, not an empty line", { skip: missingVenv }, async () => {
	const cues = writeCues(join(fixtures.dir, "broken-cues.json"), { duration: 2, cues: [{ t: 0.5, sound: "broken.wav", peak: -12 }] });
	const result = await run(["mix", cues, "--sfx", fixtures.sfx, "--out", join(fixtures.dir, "broken-master.wav")]);
	assert.notEqual(result.code, 0);
	// The loader already wraps a decode failure with the file and the reason: this pins that text.
	assert.match(result.stderr, /cannot read .*broken\.wav: Error opening[^\n]*Format not recognised/);
	assert.doesNotMatch(result.stderr, /: *$/m);
});

test("a sparse mix of cues only stops at the ceiling: the limiter takes at most 3 dB, and the report says so", { skip: missingVenv }, async () => {
	const cues = writeCues(join(fixtures.dir, "sparse-cues.json"), {
		duration: 9,
		cues: [{ t: 4, sound: "snap.wav", peak: -18 }],
	});
	const out = join(fixtures.dir, "sparse-master.wav");
	const result = await run(["mix", cues, "--sfx", fixtures.sfx, "--out", out]);
	assert.equal(result.code, 0, result.stderr);
	const report = JSON.parse(readFileSync(`${out}.report.json`, "utf8"));
	assert.equal(report.peak_bound, true, `a sparse mix reaches the ceiling before the target: ${JSON.stringify({ ...report, cues: undefined })}`);
	assert.ok(report.limiter_db <= 3.05, `the limiter took ${report.limiter_db} dB off the peaks`);
	assert.ok(report.master_true_peak <= -1.5 + 1e-9, `true peak ${report.master_true_peak}; the default ceiling leaves 0.5 dB for the AAC encode`);
	assert.ok(report.master_lufs < -16.5, `a sparse mix cannot be at ${report.master_lufs} LUFS without crushing its transients`);
	assert.match(result.stdout + result.stderr, /peak-bound/);
});

test("a mix with a bed is mastered to -16 LUFS without going over -1 dBTP", { skip: missingVenv }, async () => {
	const cues = writeCues(join(fixtures.dir, "master-cues.json"), {
		duration: 10,
		cues: [
			{ t: 0.5, sound: "tick", peak: -16 },
			{ t: 3, sound: "click.wav", peak: -14 },
			{ t: 6.5, sound: "tick", peak: -17 },
		],
		music: { liftAt: 4, underCuesDb: -12, fadeIn: 0.3, fadeOut: 0.8, bpm: 120 },
	});
	writeFileSync(join(fixtures.sfx, "click.wav"), readFileSync(join(fixtures.sfx, "tick-01.wav")));
	const out = join(fixtures.dir, "master.wav");
	const result = await run(["mix", cues, "--sfx", fixtures.sfx, "--out", out, "--bed", fixtures.bed]);
	assert.equal(result.code, 0, result.stderr);
	const measured = measure(out);
	assert.ok(Math.abs(measured.lufs + 16) <= 0.5, `the master is ${measured.lufs} LUFS, not -16`);
	assert.ok(measured.truePeak <= -1, `the master true peak is ${measured.truePeak} dBTP, above -1`);
	const report = JSON.parse(readFileSync(`${out}.report.json`, "utf8"));
	assert.equal(report.peak_bound, false, "a bed carries the loudness, so the master reaches the target");
	assert.ok(Math.abs(report.master_lufs - measured.lufs) <= 0.2, `the report says ${report.master_lufs} LUFS, ffmpeg says ${measured.lufs}`);
	assert.ok(report.bed && Math.abs(report.bed.offset_s - (report.bed.lift_in_bed_s - 4)) <= 0.05, `the bed offset is ${report.bed && report.bed.offset_s} s`);
});

test("a composed score (hit-plan.json beside it) is placed at 0 s: it has the film's timing, so no lift search and no liftAt", { skip: missingVenv }, async () => {
	const score = join(fixtures.dir, "score");
	mkdirSync(score, { recursive: true });
	// The fixture bed lifts at 24 s; a liftAt of 2 would fail the back-timing of a library bed.
	writeFileSync(join(score, "score.wav"), readFileSync(fixtures.bed100));
	writeFileSync(join(score, "hit-plan.json"), JSON.stringify([["end", 8, "kick"]]));
	for (const music of [{ underCuesDb: -12, bpm: 120 }, { liftAt: 2, underCuesDb: -12, bpm: 120 }]) {
		const cues = writeCues(join(fixtures.dir, "score-cues.json"), { duration: 10, cues: [{ t: 3, sound: "tick", peak: -16 }], music });
		const out = join(fixtures.dir, "score-master.wav");
		const result = await run(["mix", cues, "--sfx", fixtures.sfx, "--out", out, "--bed", join(score, "score.wav")]);
		assert.equal(result.code, 0, result.stderr);
		const report = JSON.parse(readFileSync(`${out}.report.json`, "utf8"));
		assert.equal(report.bed.offset_s, 0);
		assert.equal(report.bed.stretch_ratio, 1, "a score is rendered at the film's tempo: no stretch");
		assert.equal(report.bed.placed, "score");
		assert.match(result.stdout, /composed score: placed at 0 s/);
	}
});

test("a bed at another tempo is stretched to the film's tempo, and its lift still does the back-timing", { skip: missingVenv }, async () => {
	const cues = writeCues(join(fixtures.dir, "stretch-cues.json"), {
		duration: 10,
		cues: [{ t: 1, sound: "tick", peak: -12 }],
		music: { liftAt: 6, underCuesDb: -10, fadeIn: 0.3, fadeOut: 0.8, bpm: 120 },
	});
	const out = join(fixtures.dir, "stretch-master.wav");
	const result = await run(["mix", cues, "--sfx", fixtures.sfx, "--out", out, "--bed", fixtures.bed100]);
	assert.equal(result.code, 0, result.stderr);
	const report = JSON.parse(readFileSync(`${out}.report.json`, "utf8"));
	assert.ok(Math.abs(report.bed.bpm_measured - 100) <= 0.5, `the bed reads ${report.bed.bpm_measured} BPM, not 100`);
	assert.equal(report.bed.bpm_target, 120);
	assert.ok(Math.abs(report.bed.stretch_ratio - 100 / 120) <= 0.01, `the stretch ratio is ${report.bed.stretch_ratio}, not ${(100 / 120).toFixed(4)}`);
	assert.ok(Math.abs(report.bed.lift_in_bed_s - 24 * report.bed.stretch_ratio) <= 0.3, `the lift is at ${report.bed.lift_in_bed_s} s, not ${(24 * report.bed.stretch_ratio).toFixed(3)} s after the stretch`);
	assert.ok(Math.abs(report.bed.offset_s - (report.bed.lift_in_bed_s - 6)) <= 0.01, `the offset is ${report.bed.offset_s} s, not lift minus 6 s`);
	assert.ok(report.master_true_peak <= -1, `the master true peak is ${report.master_true_peak} dBTP`);
});

test("44.1 kHz files are resampled, and the master is 48 kHz 24 bit", { skip: missingVenv }, async () => {
	const cues = writeCues(join(fixtures.dir, "resample-cues.json"), {
		duration: 6,
		cues: [{ t: 1, sound: "tick441.wav", peak: -18 }],
		music: { liftAt: 4, underCuesDb: -14, fadeIn: 0.3, fadeOut: 1 },
	});
	const out = join(fixtures.dir, "resample-master.wav");
	const result = await run(["mix", cues, "--sfx", fixtures.sfx, "--out", out, "--bed", fixtures.bed441]);
	assert.equal(result.code, 0, result.stderr);
	const report = JSON.parse(readFileSync(`${out}.report.json`, "utf8"));
	assert.ok(Math.abs(report.bed.bpm_measured - 120) <= 0.5, `the 44.1 kHz bed reads ${report.bed.bpm_measured} BPM after resampling, not 120`);
	const at = onsetAndPeak(readMono(`${out}.fx.wav`), 1);
	assert.ok(at.found && Math.abs(at.onset - 1) <= 0.001, `the 44.1 kHz cue onsets at ${at.onset} s, not 1 s`);
	assert.ok(Math.abs(at.peakDb + 18) <= 0.5, `the 44.1 kHz cue peaks at ${at.peakDb.toFixed(2)} dBFS, not -18`);
	const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate,bits_per_raw_sample", "-of", "default=nw=1:nk=1", out], { encoding: "utf8" });
	assert.deepEqual(probe.stdout.trim().split("\n"), ["48000", "24"], `the master must be 48 kHz 24 bit: ${probe.stdout}`);
});

test("the CLI prints its own help and fails with a message that names the value", { skip: missingVenv }, () => {
	const help = spawnSync(process.execPath, [WV, "sound", "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0, help.stderr);
	for (const name of ["mix", "tempo", "backtime"]) assert.match(help.stdout, new RegExp(name), `the help does not name ${name}`);
	const missing = join(fixtures.dir, "no-such-cues.json");
	const failed = spawnSync(process.execPath, [WV, "sound", "mix", missing, "--sfx", fixtures.sfx, "--out", join(fixtures.dir, "x.wav")], { encoding: "utf8" });
	assert.equal(failed.status, 1, `a missing cue file must exit 1: ${failed.stderr}`);
	assert.ok(failed.stderr.includes(missing), `the message must name ${missing}: ${failed.stderr}`);
	const cues = writeCues(join(fixtures.dir, "bad-family.json"), { duration: 2, cues: [{ t: 1, sound: "nope", peak: -18 }] });
	const unknown = spawnSync(process.execPath, [WV, "sound", "mix", cues, "--sfx", fixtures.sfx, "--out", join(fixtures.dir, "x.wav")], { encoding: "utf8" });
	assert.equal(unknown.status, 1);
	assert.match(unknown.stderr, /nope/, `the message must name the family: ${unknown.stderr}`);
	assert.ok(unknown.stderr.includes(fixtures.sfx), `the message must name the sfx folder: ${unknown.stderr}`);
});

test("the score library exports no bars or beats for one film: those belong to the score that writes them", { skip: missingVenv }, async () => {
	const script = `
import sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, "skills", "walkthrough-video", "scripts", "py", "score"))})
import sc
print("B", hasattr(sc, "B"), "BARS", hasattr(sc, "BARS"))
`;
	const result = spawnSync(PYTHON, ["-I", "-B", "-c", script], { encoding: "utf8", env: { ...process.env, WV_SCORE_DURATION: "4" } });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /B False BARS False/);
});

test("the limiter threshold stops at ffmpeg's minimum, so a deep reduction does not fail inside ffmpeg", { skip: missingVenv }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-limit-"));
	try {
		const script = join(dir, "limit.py");
		writeFileSync(script, `
import sys
import numpy as np, soundfile as sf
sys.path.insert(0, ${JSON.stringify(join(ROOT, "skills", "walkthrough-video", "scripts", "py"))})
import sound
pre = f"{sys.argv[1]}/pre.wav"
sr = 48000
t = np.arange(sr) / sr
x = (0.8 * np.sin(2 * np.pi * 200 * t) * np.exp(-t * 8))[:, None] * np.ones((1, 2))
sf.write(pre, x, sr)
print("floor", sound.deeper_limit(0.5, 60.0))
print("small", round(sound.deeper_limit(0.5, 1.0), 4))
sound.write_master(pre, f"{sys.argv[1]}/out.wav", 12.0, sound.LIMITER_MIN)
y, _ = sf.read(f"{sys.argv[1]}/out.wav")
print("peak", round(float(np.abs(y).max()), 3))
`);
		const result = spawnSync(PYTHON, ["-I", "-B", script, dir], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /floor 0\.0625/);
		assert.match(result.stdout, /small 0\.44[0-9][0-9]/);
		assert.match(result.stdout, /peak 0\.06[0-9]/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the hit table gives frames at the film's own rate, and the score run passes it", async () => {
	const { scoreSteps } = await import("../skills/walkthrough-video/scripts/film/sound.mjs");
	const steps = scoreSteps({ score: "/film/score.py", out: "/film/out", cues: "", duration: 4, python: "/venv/python", fps: 30 });
	const hits = steps.find((step) => step.name === "hits");
	assert.equal(hits.args.at(-1), "30", `the hit check is told the film's fps: ${hits.args.join(" ")}`);
	const plain = scoreSteps({ score: "/film/score.py", out: "/film/out", cues: "", duration: 4, python: "/venv/python" });
	assert.equal(plain.find((step) => step.name === "hits").args.length, 4, "without an fps the check keeps its default");
});

test("the hit tools refuse a hit too near the edge of the file, and name the film's fps", { skip: missingVenv }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-hits-"));
	try {
		const script = join(dir, "make-hits.py");
		writeFileSync(script, `
import json, os, sys
import numpy as np, soundfile as sf
d = sys.argv[1]
sr = 48000
os.makedirs(f"{d}/render", exist_ok=True)
def click(at, dur=1.0):
    x = np.zeros(int(dur * sr))
    n = int(0.02 * sr); s = int(at * sr)
    t = np.arange(n) / sr
    x[s:s + n] = np.sin(2 * np.pi * 1200 * t) * np.exp(-t * 40)
    return x
def write(path, at):
    sf.write(path, click(at), sr)
write(f"{d}/render/part.wav", 0.5)
write(f"{d}/score.wav", 0.5)
json.dump([["hit", 0.5, "part"]], open(f"{d}/hit-plan.json", "w"))
`);
		const made = spawnSync(PYTHON, ["-I", script, dir], { encoding: "utf8" });
		assert.equal(made.status, 0, made.stderr);
		const at30 = spawnSync(PYTHON, ["-I", "-B", join(SCORE_PY, "hit_check.py"), dir, "30"], { encoding: "utf8" });
		assert.equal(at30.status, 0, at30.stderr || at30.stdout);
		assert.match(at30.stdout, /frame \(30 fps\)/);
		// A hit at 5 ms would need a window before the file starts: refuse it, do not read from the end.
		writeFileSync(join(dir, "hit-plan.json"), JSON.stringify([["edge", 0.005, "part"]]));
		const edge = spawnSync(PYTHON, ["-I", "-B", join(SCORE_PY, "hit_check.py"), dir, "30"], { encoding: "utf8" });
		assert.equal(edge.status, 2, `exit ${edge.status}: ${edge.stdout}${edge.stderr}`);
		assert.match(`${edge.stdout}${edge.stderr}`, /too near the start or end/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
