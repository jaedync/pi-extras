/**
 * `wv sound`: the film's sound, offline. A cue sheet says where each sound's
 * onset lands and how loud it peaks; this module places every cue, cuts single
 * hits from a continuous take, back-times the music bed so its biggest lift
 * lands on the film second the author chose, and masters the mix to a loudness
 * target under a true-peak ceiling. `tempo` measures a bed without librosa and
 * `backtime` says where a bed must start for a planned lift.
 *
 * The measures and the mix run in the runtime venv (scripts/py/sound.py) with
 * numpy and soundfile only. ffmpeg does the resampling, the loudness and the
 * limiter; the rubberband CLI changes the tempo of a bed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { UsageError } from "../lib/args.mjs";
import { MUSIC_KIT_DOWNLOAD_BYTES, formatBytes, musicKitStatus } from "../lib/music-kit.mjs";
import { paths } from "../lib/paths.mjs";
import { run } from "../lib/proc.mjs";
import { loadRejected, rejectedCues } from "../lib/rejected.mjs";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "..", "py", "sound.py");
const SCORE_PY = join(dirname(fileURLToPath(import.meta.url)), "..", "py", "score");
export const SCORE_TEMPLATE = fileURLToPath(new URL("../../templates/score/score.py", import.meta.url));
const DEFAULT_TARGET_LUFS = -16;
/** 0.5 dB under the -1 dBTP delivery limit: the AAC encode in wv film mux adds up to a few tenths. */
const DEFAULT_TRUE_PEAK = -1.5;
const DEFAULTS = { underCuesDb: -21, fadeIn: 0.3, fadeOut: 1.4 };
const MUSIC_RANGES = { liftAt: [0, 3600], underCuesDb: [-60, 0], fadeIn: [0, 10], fadeOut: [0, 10], bpm: [40, 300] };
const TOP_LIFTS = 5;

const HELP = `Usage: wv sound <subcommand> [options]

The film's sound, mixed offline. No network, no service.

Subcommands:
  mix <cues.json> --sfx <dir> --out <master.wav>
                    place every cue at its onset and peak, back-time the bed, master
  tempo <music.wav> measure the tempo, the first beat, the downbeats and the lifts
  backtime <music.wav> --lift-at <s> --duration <s>
                    where a bed must start so its biggest lift lands on --lift-at
  score <score.py> --cues <out/cues.json> --out <dir> [--fps <n>]
                    render a score written in code (templates/score/score.py); a score
                    that plays a sampled part needs the music kit (wv setup --music).
                    Then
                    check every planned hit (10 ms) and every note against its chord;
                    --fps sets the frame column of the hit table (default: the cue
                    sheet's fps, else 60)

mix options:
  --bed <music.wav>   music bed; its biggest lift goes to music.liftAt. A score from
                      wv sound score (hit-plan.json beside it) starts at 0 s instead:
                      it is already timed to the film
  --target <LUFS>     master loudness, -60 to 0 (default ${DEFAULT_TARGET_LUFS})
  --true-peak <dBTP>  master true peak ceiling, -20 to 0 (default ${DEFAULT_TRUE_PEAK})
  --json              print the report instead of the summary

tempo and backtime also take --json.

The cue sheet is JSON:
  {
    "duration": 30.0,
    "cues": [
      { "t": 1.23, "sound": "card-land", "peak": -17 },
      { "t": 4.59, "sound": "typing", "peak": -21 },
      { "t": 27.0, "sound": "end-hit.wav", "peak": -12 }
    ],
    "music": { "liftAt": 27.0, "underCuesDb": -21, "fadeIn": 0.3, "fadeOut": 1.4, "bpm": 120 }
  }

"t" is the film second where the sound's onset starts, "peak" its level in dBFS.
"sound" is a family, which takes the next <name>-NN.wav in round robin (single
hits cut from <name>-take-NN.wav when there are no -NN files), or one <name>.wav.

mix writes the master, <out>.fx.wav (the cues alone, unmastered) and
<out>.report.json. tempo measures without librosa: spectral flux, an 8-beat
autocorrelation and a beat grid fitted to the onsets.`;

function fail(message) {
	throw new UsageError(message);
}

/**
 * Parses one subcommand's options, with the subcommand in front of each message.
 * @returns {{values: Record<string, any>, positionals: string[]}}
 */
function parse(command, argv, options) {
	try {
		return parseArgs({ args: argv, allowPositionals: true, strict: true, options });
	} catch (error) {
		throw new UsageError(`${command}: ${error.message}`);
	}
}

function decimal(value, flag, min, max) {
	const number = Number(value);
	if (!Number.isFinite(number) || number < min || number > max) fail(`${flag} must be a number from ${min} to ${max} (got "${value}")`);
	return number;
}

function positional(positionals, name, command) {
	if (!positionals[0]) fail(`${command} needs a ${name}`);
	if (positionals.length > 1) fail(`${command} takes one ${name} (got "${positionals.slice(1).join(" ")}")`);
	return positionals[0];
}

/** Reads and checks the cue sheet, so a typo costs no Python run. */
function readCueSheet(file) {
	const path = resolve(file);
	if (!existsSync(path)) throw new Error(`${path} does not exist. Give the path of the cue sheet JSON.`);
	let raw;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`cannot read ${path}: ${error.message}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must be an object with duration and cues`);
	const duration = Number(raw.duration);
	if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${path}: duration must be a number of seconds above 0 (got ${JSON.stringify(raw.duration)})`);
	if (!Array.isArray(raw.cues)) throw new Error(`${path}: cues must be a list of {"t", "sound", "peak"}`);
	const cues = raw.cues.map((cue, index) => {
		const where = `${path}: cue ${index + 1}`;
		if (!cue || typeof cue !== "object") throw new Error(`${where} is not an object`);
		const t = Number(cue.t);
		if (!Number.isFinite(t) || t < 0) throw new Error(`${where} has t ${JSON.stringify(cue.t)}; t is the film second where the sound starts, 0 or more`);
		const peak = Number(cue.peak);
		if (!Number.isFinite(peak) || peak < -100 || peak > 0) throw new Error(`${where} (${JSON.stringify(cue.sound)} at ${t} s) has peak ${JSON.stringify(cue.peak)}; peak is a level in dBFS from -100 to 0`);
		if (typeof cue.sound !== "string" || !cue.sound.trim()) throw new Error(`${where} has no sound; give a family name or a .wav name`);
		return { t, sound: cue.sound.trim(), peak };
	});
	return { duration, cues, music: readMusic(path, raw.music) };
}

/**
 * The music block: liftAt plus the fader, with the documented defaults.
 * @returns {{underCuesDb: number, fadeIn: number, fadeOut: number, liftAt?: number, bpm?: number, placeAt?: number} | null}
 */
function readMusic(path, raw) {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: music must be an object (liftAt, underCuesDb, fadeIn, fadeOut, bpm)`);
	const music = {};
	for (const [key, [min, max]] of Object.entries(MUSIC_RANGES)) {
		if (raw[key] === undefined) continue;
		const value = Number(raw[key]);
		if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${path}: music.${key} must be a number from ${min} to ${max} (got ${JSON.stringify(raw[key])})`);
		music[key] = value;
	}
	return { underCuesDb: DEFAULTS.underCuesDb, fadeIn: DEFAULTS.fadeIn, fadeOut: DEFAULTS.fadeOut, ...music };
}

/** Runs one job in the venv and reads back its JSON answer. The temp folder holds every intermediate. */
async function pythonJob(job) {
	const python = paths().python;
	if (!existsSync(python)) throw new Error(`the runtime venv is not installed (${python}). Run "wv setup", then try again.`);
	const folder = mkdtempSync(join(tmpdir(), "wv-sound-"));
	const file = join(folder, "job.json");
	try {
		writeFileSync(file, JSON.stringify({ ...job, tmp: folder }));
		const result = await run(python, ["-I", HELPER, file], { timeoutMs: 30 * 60_000 });
		if (result.code !== 0) {
			const reported = result.stderr.match(/^ERROR: (.*)$/m);
			const detail = reported ? reported[1] : (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
			throw new Error(detail || `sound.py exited with ${result.code}`);
		}
		try {
			return JSON.parse(result.stdout);
		} catch (error) {
			throw new Error(`sound.py gave no answer: ${result.stdout.trim().slice(0, 200) || error.message}`);
		}
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

async function mix(argv) {
	const { values, positionals } = parse("mix", argv, {
		sfx: { type: "string" },
		out: { type: "string" },
		bed: { type: "string" },
		target: { type: "string" },
		"true-peak": { type: "string" },
		json: { type: "boolean" },
	});
	const cueFile = positional(positionals, "cue sheet", "mix");
	if (!values.out) fail("mix needs --out <master.wav>");
	if (!values.sfx) fail("mix needs --sfx <dir> with the sound files");
	const sheet = readCueSheet(cueFile);
	const sfx = resolve(values.sfx);
	if (!existsSync(sfx) || !statSync(sfx).isDirectory()) throw new Error(`--sfx ${sfx} is not a folder of sound files`);
	const out = resolve(values.out);
	mkdirSync(dirname(out), { recursive: true });
	const bed = values.bed === undefined ? null : resolve(values.bed);
	if (bed && !existsSync(bed)) throw new Error(`--bed ${bed} does not exist`);
	// A score from wv sound score is rendered to the cue sheet: it already has the film's timing.
	const composed = Boolean(bed && existsSync(join(dirname(bed), "hit-plan.json")));
	if (composed) sheet.music = { ...(sheet.music ?? readMusic(cueFile, {})), placeAt: 0 };
	else if (bed && (!sheet.music || sheet.music.liftAt === undefined)) throw new Error(`${cueFile} needs music.liftAt when --bed is used: the film second where the bed's biggest lift lands`);
	const target = values.target === undefined ? DEFAULT_TARGET_LUFS : decimal(values.target, "--target", -60, 0);
	const truePeak = values["true-peak"] === undefined ? DEFAULT_TRUE_PEAK : decimal(values["true-peak"], "--true-peak", -20, 0);
	// The owner's list decides what may not ship: a list that does not parse is an error, not a warning.
	const rejected = loadRejected(undefined, undefined, (line) => {
		throw new Error(`${line} Fix the file, then mix again.`);
	});
	const report = await pythonJob({ command: "mix", sheet, sfx, out, bed, target, true_peak: truePeak });
	// wv check reads the folder to match rejected sounds by content, not only by name.
	report.sfx = sfx;
	writeFileSync(`${out}.report.json`, `${JSON.stringify(report, null, 1)}\n`);
	const bad = rejectedCues(report.cues ?? [], sfx, rejected);
	if (bad.length) throw new Error(`the mix uses sound(s) that the owner rejected: ${bad.map((c) => `${c.file} at ${Number(c.t).toFixed(2)} s`).join(", ")}. ${rejected.why} Replace the cue in its scene, then mix again.`);
	if (values.json) {
		process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
		return 0;
	}
	const lines = [
		`${report.out}: ${report.master_lufs.toFixed(1)} LUFS, ${report.master_true_peak.toFixed(1)} dBTP, gain ${report.gain_db.toFixed(1)} dB, ${report.limit_rounds} limiter round(s)`,
		...(report.peak_bound ? [`peak-bound: the peaks reach ${report.ceiling_dbtp} dBTP before the loudness reaches ${report.target_lufs} LUFS, so the master stays at ${report.master_lufs.toFixed(1)} LUFS (the limiter takes ${report.limiter_db.toFixed(1)} dB, at most 3). A bed or denser sound makes it louder.`] : []),
		`${report.cues.length} cue(s); fx stem ${report.fx}; report ${report.out}.report.json`,
	];
	if (report.bed?.placed === "score") lines.push(`bed ${report.bed.file}: composed score: placed at 0 s (no lift search, no stretch), ${report.bed.lufs_after_fader} LUFS`);
	else if (report.bed) {
		const stretch = report.bed.stretch_ratio === 1 ? "no stretch" : `stretched x${report.bed.stretch_ratio.toFixed(3)}`;
		lines.push(`bed ${report.bed.file}: ${report.bed.bpm_measured.toFixed(2)} to ${report.bed.bpm_target.toFixed(2)} BPM (${stretch}), lift at ${report.bed.lift_in_bed_s.toFixed(3)} s, offset ${report.bed.offset_s.toFixed(3)} s, ${report.bed.lufs_after_fader} LUFS`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

/**
 * The three runs of wv sound score: the score itself (with the film's length,
 * the cue sheet and the voices on its path), the hit check, the harmony check.
 */
export function scoreSteps({ score, out, cues, duration, python, fps = null, kit = paths().musicKit, env = process.env }) {
	const base = { ...env, PYTHONPATH: [SCORE_PY, env.PYTHONPATH].filter(Boolean).join(":"), WV_SCORE_DURATION: String(duration), WV_SCORE_CUES: cues, WV_MUSIC_KIT: kit };
	return [
		{ name: "render", cmd: python, args: ["-I", "-B", "-c", "import runpy, sys; sys.path.insert(0, sys.argv[1]); sys.argv = sys.argv[2:]; runpy.run_path(sys.argv[0], run_name='__main__')", SCORE_PY, score, out], env: base },
		{ name: "hits", cmd: python, args: ["-I", "-B", join(SCORE_PY, "hit_check.py"), out, ...(fps ? [String(fps)] : [])], env: base },
		{ name: "harmony", cmd: python, args: ["-I", "-B", join(SCORE_PY, "harmony_lint.py"), out], env: base },
	];
}

/**
 * A score that plays a sampled part needs the music kit; the synth voices do
 * not. The markers are the sampler call, load_sample, and the two paths that
 * sc.py exports for the maps (KIT, PIANO).
 */
export function scoreNeedsKit(text) {
	return /\bsfz_render\s*\(|\bload_sample\s*\(|\bPIANO\b|\bKIT\b/.test(String(text));
}

/** The files a score run writes in --out. An earlier run's copy is not this run's result. */
export const SCORE_RESULTS = ["hit-table.md", "hit-plan.json", "notes.json"];

/** Removes the result files of an earlier run from --out. */
export function clearScoreResults(out) {
	for (const name of SCORE_RESULTS) rmSync(join(out, name), { force: true });
}

/**
 * The hit table's text, or an error. A run that writes no table failed, whatever
 * its exit code: hit_check.py prints a traceback and exits 1 on a missing stem,
 * and reading the table of an earlier run would report that result as this one.
 */
export function readHitTable(out, { code, text }) {
	const table = join(out, "hit-table.md");
	if (code === 2) throw new Error(`the hit check refused its input: ${String(text).trim().split("\n").pop()}`);
	if (!existsSync(table)) throw new Error(`the hit check wrote no hit-table.md (exit ${code}): ${String(text).trim().split("\n").slice(-3).join(" ")}`);
	return readFileSync(table, "utf8");
}

async function score(argv) {
	const { values, positionals } = parse("score", argv, { cues: { type: "string" }, out: { type: "string" }, duration: { type: "string" }, fps: { type: "string" } });
	const file = resolve(positional(positionals, "score file (copy templates/score/score.py)", "score"));
	if (!existsSync(file)) throw new Error(`${file} does not exist. Copy ${SCORE_TEMPLATE} into the film project first.`);
	if (!values.out) fail("score needs --out <dir> for score.wav, the stems and render/");
	if (!values.cues && values.duration === undefined) fail("score needs --cues <out/cues.json> (the film's length and picture events) or --duration <s>");
	const cues = values.cues ? resolve(values.cues) : "";
	const duration = values.duration !== undefined ? decimal(values.duration, "--duration", 1, 600) : readCueSheet(cues).duration;
	// A sampled score is refused before any render, with the fix in the message.
	const kit = paths().musicKit;
	if (scoreNeedsKit(readFileSync(file, "utf8")) && !musicKitStatus(kit).present) {
		throw new Error(`this score plays a sampled part, and the music kit is not installed at ${kit}. Run "wv setup --music" (about ${formatBytes(MUSIC_KIT_DOWNLOAD_BYTES)}, about 5 min on 16 cores), then run this command again. A score with only synth voices needs no kit.`);
	}
	const python = paths().python;
	if (!existsSync(python)) throw new Error(`the runtime venv is not installed (${python}). Run "wv setup", then try again.`);
	const out = resolve(values.out);
	mkdirSync(out, { recursive: true });
	// The render, the hit check and the harmony check write into --out; old results must not read as new.
	clearScoreResults(out);
	let failed = false;
	// The hit table gives frames, so the check needs the film's rate: the cue sheet carries it.
	const fps = values.fps !== undefined ? Number(values.fps) : (cues ? readCueSheet(cues).fps : null) ?? 60;
	if (!Number.isInteger(fps) || fps < 1 || fps > 240) fail("--fps must be a whole number of frames a second from 1 to 240");
	for (const step of scoreSteps({ score: file, out, cues, duration, python, fps })) {
		const r = await run(step.cmd, step.args, { env: step.env, timeoutMs: 30 * 60_000 });
		const text = `${r.stdout}\n${r.stderr}`;
		if (step.name === "render") {
			if (r.code !== 0) throw new Error(`the score failed: ${text.trim().split("\n").slice(-4).join(" ")}`);
			process.stdout.write(`render: ${r.stdout.trim().split("\n").pop()}\n`);
		} else if (step.name === "hits") {
			const rows = readHitTable(out, { code: r.code, text }).split("\n").filter((line) => /\| (yes|NO) \|$/.test(line));
			const good = rows.filter((line) => line.endsWith("| yes |")).length;
			process.stdout.write(`hits: ${good} of ${rows.length} within 10 ms (${join(out, "hit-table.md")})\n`);
			for (const line of rows.filter((l) => l.endsWith("| NO |"))) process.stdout.write(`  MISS ${line}\n`);
			failed ||= r.code !== 0;
		} else {
			const flagged = Number(/flags:\s*(\d+)/.exec(r.stdout)?.[1] ?? NaN);
			if (!Number.isFinite(flagged)) throw new Error(`the harmony check failed: ${text.trim().split("\n").pop()}`);
			process.stdout.write(`harmony: ${flagged} flagged note(s)\n`);
			for (const line of r.stdout.split("\n").filter((l) => l && !l.startsWith("flags:"))) process.stdout.write(`  ${line}\n`);
			failed ||= flagged > 0;
		}
	}
	process.stdout.write(failed ? "score: fix the lines above, then run wv sound score again\n" : `score: ${join(out, "score.wav")}; mix it with wv sound mix --bed\n`);
	return failed ? 1 : 0;
}

async function tempo(argv) {
	const { values, positionals } = parse("tempo", argv, { json: { type: "boolean" } });
	const file = resolve(positional(positionals, "music file", "tempo"));
	if (!existsSync(file)) throw new Error(`${file} does not exist`);
	const analysis = await pythonJob({ command: "tempo", file });
	if (values.json) {
		process.stdout.write(`${JSON.stringify(analysis, null, 1)}\n`);
		return 0;
	}
	const lines = [`${analysis.bpm.toFixed(2)} BPM, first beat ${analysis.first_beat_s.toFixed(3)} s, ${analysis.beats.length} beats, ${analysis.downbeats.length} downbeats in ${analysis.duration_s.toFixed(1)} s`];
	if (analysis.lifts.length) {
		lines.push("downbeat_s  rise_dB  level_after_dB");
		for (const lift of analysis.lifts.slice(0, TOP_LIFTS)) lines.push(`${lift.downbeat_s.toFixed(3).padStart(10)}  ${lift.rise_db.toFixed(2).padStart(7)}  ${lift.level_after_db.toFixed(2).padStart(14)}`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

async function backtime(argv) {
	const { values, positionals } = parse("backtime", argv, { "lift-at": { type: "string" }, duration: { type: "string" }, json: { type: "boolean" } });
	const file = resolve(positional(positionals, "music file", "backtime"));
	if (!existsSync(file)) throw new Error(`${file} does not exist`);
	if (values["lift-at"] === undefined) fail("backtime needs --lift-at <film s>, the film second where the lift must land");
	if (values.duration === undefined) fail("backtime needs --duration <film s>, the film's length");
	const liftAt = decimal(values["lift-at"], "--lift-at", 0, 3600);
	const duration = decimal(values.duration, "--duration", 0.1, 3600);
	const answer = await pythonJob({ command: "backtime", file, lift_at: liftAt, duration });
	if (values.json) {
		process.stdout.write(`${JSON.stringify(answer, null, 1)}\n`);
		return 0;
	}
	process.stdout.write(`offset ${answer.offset_s.toFixed(3)} s in ${basename(file)}: the lift at ${answer.lift_in_bed_s.toFixed(3)} s lands at ${liftAt.toFixed(3)} s of the film, which runs to ${(answer.offset_s + duration).toFixed(3)} s of the bed's ${answer.bed_duration_s.toFixed(3)} s\n`);
	return 0;
}

export async function main(argv) {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}
	const [command, ...rest] = argv;
	switch (command) {
		case "mix":
			return await mix(rest);
		case "tempo":
			return await tempo(rest);
		case "backtime":
			return await backtime(rest);
		case "score":
			return await score(rest);
		case undefined:
			fail(`needs a subcommand: mix, tempo, backtime or score. Try "wv sound --help".`);
			break;
		default:
			fail(`unknown subcommand "${command}": use mix, tempo, backtime or score. Try "wv sound --help".`);
	}
	return 2;
}
