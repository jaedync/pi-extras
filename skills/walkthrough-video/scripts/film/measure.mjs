/**
 * `wv measure`: a film's numbers next to the measured reference films
 * (references/films.json). Advice only: it never fails a film. Each number
 * is a question for the author ("my shots are all the same length: is that
 * the rhythm I want?"), not a target.
 *
 * Cuts come from the storyboard when one is given, because a scene detector
 * misses cuts between two similar grounds; without one, ffmpeg's scdet finds
 * the hard cuts.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { failed, run } from "../lib/proc.mjs";
import { loudness, quietGaps, soundFloor } from "./audio.mjs";
import { eachSmallFrame, meanAbsDiff, probeVideo } from "./frames.mjs";
import { staircases } from "./check.mjs";
import { loadStoryboard } from "./storyboard.mjs";
import { UsageError } from "../lib/args.mjs";

const FILMS = JSON.parse(readFileSync(new URL("../../references/films.json", import.meta.url), "utf8"));

/**
 * The rows of the report: the film's key, the reference key, the label and the format.
 * @type {[string, string, string, (v: number) => string][]}
 */
export const MEASURES = [
	["cutsPerMin", "cuts_per_min", "cuts per minute", (v) => v.toFixed(1)],
	["shotMedianS", "shot_median_s", "shot length median s", (v) => v.toFixed(2)],
	["shotCv", "shot_cv", "shot length CV", (v) => v.toFixed(2)],
	["timeInMove", "time_in_move", "time in a camera move", (v) => `${Math.round(v * 100)} %`],
	["moveMedianS", "move_median_s", "camera move median s", (v) => v.toFixed(2)],
	["easePeak", "ease_peak", "ease peak (0.5 = symmetric)", (v) => v.toFixed(2)],
	["zoomMax", "zoom_max", "zoom max in a shot", (v) => `${v.toFixed(2)}x`],
	["frozenShare", "frozen_share", "frozen picture", (v) => `${Math.round(v * 100)} %`],
	["longestHoldS", "longest_hold_s", "longest still hold s", (v) => v.toFixed(2)],
	["lufs", "lufs", "integrated loudness LUFS", (v) => v.toFixed(1)],
	["truePeak", "true_peak", "true peak dBTP", (v) => v.toFixed(1)],
	["quietLongestS", "quiet_longest_s", "longest quiet gap s", (v) => v.toFixed(1)],
	["quietShare", "quiet_share", "under -30 LUFS momentary", (v) => `${Math.round(v * 100)} %`],
	["jumpLu", "jump_lu", "momentary jump over 3 s floor LU", (v) => v.toFixed(1)],
	["silenceShare", "silence_share", "digital silence", (v) => `${Math.round(v * 100)} %`],
	["silenceLongestS", "silence_longest_s", "longest digital silence s", (v) => v.toFixed(1)],
];

function quantile(sorted, q) {
	if (sorted.length === 0) return null;
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const r3 = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);

/** Cut rate, shot length median, p10, p90 and CV (population standard deviation over the mean). */
export function shotStats(lengths, duration) {
	const sorted = [...lengths].sort((a, b) => a - b);
	const mean = lengths.reduce((s, v) => s + v, 0) / lengths.length;
	const sd = Math.sqrt(lengths.reduce((s, v) => s + (v - mean) ** 2, 0) / lengths.length);
	const cuts = lengths.length - 1;
	return {
		cuts,
		cutsPerMin: r3((cuts / duration) * 60),
		shotMedianS: r3(quantile(sorted, 0.5)),
		shotP10S: r3(quantile(sorted, 0.1)),
		shotP90S: r3(quantile(sorted, 0.9)),
		shotCv: r3(mean > 0 ? sd / mean : 0),
	};
}

/** ffmpeg freezedetect lines to the frozen share of the film and the longest hold. */
export function parseFreezes(text, duration) {
	const holds = [];
	let start = null;
	for (const line of text.split("\n")) {
		const s = /freeze_start:\s*([0-9.]+)/.exec(line);
		const e = /freeze_end:\s*([0-9.]+)/.exec(line);
		if (s) start = Number(s[1]);
		if (e && start !== null) {
			holds.push([start, Number(e[1])]);
			start = null;
		}
	}
	if (start !== null) holds.push([start, duration]);
	const total = holds.reduce((sum, [a, b]) => sum + (b - a), 0);
	return { frozenShare: r3(total / duration), longestHoldS: r3(Math.max(0, ...holds.map(([a, b]) => b - a))), holds };
}

/** Median and range of every reference measure, for all films and for the montage family. */
export function referenceRanges(films = FILMS.films) {
	const out = {};
	const keys = new Set(films.flatMap((film) => Object.keys(film)));
	for (const key of keys) {
		const pick = (list) => {
			const values = list.map((film) => film[key]).filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
			return values.length ? { median: r3(quantile(values, 0.5)), min: values[0], max: values[values.length - 1], n: values.length } : null;
		};
		const all = pick(films);
		if (all) out[key] = { all, montage: pick(films.filter((film) => film.family === "montage")) };
	}
	return out;
}

/** Hard cuts by ffmpeg scdet: frame indices where a new shot starts. */
export async function detectCuts(file, fps, { threshold = 12, timeoutMs = 20 * 60_000 } = {}) {
	const r = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-an", "-vf", `scdet=threshold=${threshold}`, "-f", "null", "-"], { timeoutMs });
	const reason = failed(r, Math.max(1, Math.round(timeoutMs / 60_000)));
	if (reason) throw new Error(`ffmpeg scdet failed: ${reason}`);
	return [...r.stderr.matchAll(/lavfi\.scd\.time:\s*([0-9.]+)/g)].map((m) => Math.round(Number(m[1]) * fps)).filter((f, i, all) => f > 0 && all.indexOf(f) === i);
}

/**
 * The camera estimator's moves, split by the storyboard's clip shots: the
 * motion inside a clip is mostly the footage's own (a flight, a scroll), not
 * the film's camera. Null when the film has no clip shots.
 * @param {{ shots: { start: number, end: number, zoom_max: number, moves: { start: number, end: number }[] }[] }} read
 * @param {{ id: string, from: number, to: number }[]} clips seconds of each clip shot
 */
export function splitMoves(read, clips) {
	if (!clips.length) return null;
	const inClip = (shot) => clips.find((c) => (shot.start + shot.end) / 2 >= c.from && (shot.start + shot.end) / 2 < c.to);
	const part = (shots) => {
		const seconds = shots.reduce((sum, shot) => sum + shot.end - shot.start, 0);
		const lengths = shots.flatMap((shot) => shot.moves.map((m) => m.end - m.start)).sort((a, b) => a - b);
		const moving = lengths.reduce((sum, v) => sum + v, 0);
		return { seconds: r3(seconds), moves: lengths.length, timeInMove: r3(seconds > 0 ? moving / seconds : 0), moveMedianS: r3(quantile(lengths, 0.5) ?? 0), zoomMax: r3(Math.max(1, ...shots.map((shot) => shot.zoom_max))) };
	};
	const clipShots = read.shots.filter(inClip);
	const names = [...new Set(clipShots.map((shot) => inClip(shot)?.id))];
	return { film: part(read.shots.filter((shot) => !inClip(shot))), clips: { ...part(clipShots), shots: names } };
}

/**
 * The freeze measure from a finished ffmpeg run. A failed run would read as
 * "frozen 0 %", so it is an error: a silent pass hides a film that ffmpeg could
 * not decode.
 */
export function freezeMeasure(result, duration) {
	// run() gives {code, timedOut, stderr}; a spawnSync result has {status, error}.
	if (result?.error) throw new Error(`ffmpeg freezedetect failed: ${result.error.message}`);
	if (result?.timedOut) throw new Error("ffmpeg freezedetect did not finish in 20 min");
	const code = result?.code ?? result?.status;
	if (code !== 0) throw new Error(`ffmpeg freezedetect failed (exit ${code}): ${String(result?.stderr ?? "").trim().split("\n").slice(-2).join(" ")}`);
	return parseFreezes(result?.stderr ?? "", duration);
}

/** Everything wv measure reports, as one object. */
export async function measureFilm({ video, storyboard = null, camera = true, log = (_line) => {} }) {
	const probe = probeVideo(video);
	const duration = probe.frames / probe.fps;
	let cutFrames;
	let cutSource;
	let sb = null;
	if (storyboard) {
		sb = await loadStoryboard(storyboard);
		cutFrames = sb.cuts.map((f) => Math.round((f / sb.fps) * probe.fps));
		cutSource = "storyboard";
	} else {
		cutFrames = await detectCuts(video, probe.fps);
		cutSource = "detected";
	}
	const edges = [0, ...cutFrames, probe.frames];
	const lengths = edges.slice(1).map((end, i) => (end - edges[i]) / probe.fps);
	const result = /** @type {Record<string, any>} */ ({ video, duration: r3(duration), fps: probe.fps, cutSource, cutFrames, ...shotStats(lengths, duration) });
	const freeze = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", video, "-an", "-vf", "freezedetect=n=0.001:d=0.15", "-f", "null", "-"], { timeoutMs: 20 * 60_000 });
	Object.assign(result, freezeMeasure(freeze, duration));
	delete result.holds;
	// freezedetect and the camera estimator read a stepped drift as holds and stops, so name the steps.
	const diffs = [0];
	let previous = null;
	await eachSmallFrame(video, (_index, pixels) => {
		if (previous) diffs.push(meanAbsDiff(previous, pixels));
		previous = pixels;
	});
	const plan = sb && Math.abs(sb.fps - probe.fps) < 0.01 ? sb : { cuts: cutFrames, holds: [], shots: [] };
	result.staircase = staircases(diffs, plan).map((run) => ({ shot: plan.shots.find((s) => run.from >= s.startFrame && run.from < s.endFrame)?.id ?? null, from: r3(run.from / probe.fps), to: r3(run.to / probe.fps), period: run.period }));
	result.staircaseS = r3(result.staircase.reduce((sum, run) => sum + run.to - run.from, 0));
	if (probe.audio) {
		const loud = await loudness(video);
		const gaps = await quietGaps(video);
		const floor = soundFloor(loud.momentary);
		Object.assign(result, { lufs: loud.lufs, lra: loud.lra, truePeak: loud.truePeak, quietLongestS: r3(gaps.longestS), quietShare: floor.quietShare, jumpLu: floor.jumpLu, jumpAt: floor.jumpAt, silenceShare: gaps.silenceShare, silenceLongestS: gaps.silenceLongestS });
	}
	if (camera) {
		try {
			const { cameraMoves } = await import("./motion.mjs");
			const moves = await cameraMoves(video, { fps: probe.fps, cuts: cutFrames }, { log });
			Object.assign(result, { timeInMove: moves.time_in_move_share, moveMedianS: moves.move_dur_median_s, easePeak: moves.ease_peak_median, zoomMax: moves.zoom_max_in_shot, moves: moves.moves_n });
			const clips = (sb?.shots ?? []).filter((shot) => shot.params?.clip).map((shot) => ({ id: shot.id, from: shot.startFrame / sb.fps, to: shot.endFrame / sb.fps }));
			const split = splitMoves(moves, clips);
			if (split) result.moveSplit = split;
		} catch (error) {
			result.cameraError = String(error?.message ?? error);
		}
	}
	return result;
}

const range = (r, fmt) => (r ? `${fmt(r.median)} (${fmt(r.min)} to ${fmt(r.max)})` : "-");

/** The text report: one row per measure, the film beside all references and the montage family. */
export function formatReport(m, ranges = referenceRanges()) {
	const lines = [`${"measure".padEnd(30)} ${"film".padEnd(9)} ${"references: median (range)".padEnd(30)} montage films`];
	const outside = [];
	for (const [key, ref, label, fmt] of MEASURES) {
		const value = m[key];
		if (value === undefined || value === null) continue;
		const r = ranges[ref];
		lines.push(`${label.padEnd(30)} ${fmt(value).padEnd(9)} ${range(r?.all, fmt).padEnd(30)} ${range(r?.montage, fmt)}`);
		if (r?.all && (value < r.all.min || value > r.all.max)) outside.push(`${label} ${fmt(value)} is outside the reference range ${fmt(r.all.min)} to ${fmt(r.all.max)}`);
	}
	lines.push("", `cuts: ${m.cuts} (${m.cutSource ?? "storyboard"}), length ${m.duration} s`);
	if (m.moveSplit) {
		const part = (p) => `${Math.round(p.timeInMove * 100)} % in a move, ${p.moves} moves, median ${p.moveMedianS.toFixed(2)} s, zoom max ${p.zoomMax.toFixed(2)}x`;
		lines.push(`camera, outside clips: ${part(m.moveSplit.film)} (${m.moveSplit.film.seconds} s)`);
		lines.push(`camera, inside clips (${m.moveSplit.clips.shots.join(", ")}): ${part(m.moveSplit.clips)} (${m.moveSplit.clips.seconds} s). This is mostly the footage's own motion (a flight, a scroll), so compare the film's camera with the references by the outside line.`);
	}
	for (const line of outside) lines.push(`advice: ${line}. Is that a choice?`);
	if (m.staircaseS > 0) {
		const where = (m.staircase ?? []).map((run) => `${run.shot ? `"${run.shot}" ` : ""}${run.from.toFixed(2)} to ${run.to.toFixed(2)} s (every ${run.period} frames)`).join(", ");
		lines.push(`staircase: ${m.staircaseS.toFixed(1)} s of motion lands in steps: ${where}. The longest still hold and the ease peak read these steps as holds and stops, so they are not style numbers until wv check passes; render with wv film render (one worker).`);
	}
	return lines.join("\n");
}

const USAGE = `Usage: wv measure <film.mp4> [--storyboard <storyboard.ts|json|film dir>] [--no-camera] [--json]

Prints the film's numbers beside the 12 measured reference films (references/films.json):
cuts per minute, shot length median and CV, time in a camera move, move length, ease peak,
zoom, frozen picture, the longest hold, loudness, true peak and the longest quiet gap.
Advice only: the exit code is 0 whatever the numbers say.

Options:
  --storyboard <p>  use the storyboard's true cut list (a detector misses cuts between similar grounds)
  --no-camera       skip the camera estimator (it takes a minute or two on a 30 s film)
  --json            print one JSON object`;

export async function main(argv) {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	let parsed;
	try {
		parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { storyboard: { type: "string" }, "no-camera": { type: "boolean" }, json: { type: "boolean" } } });
	} catch (error) {
		throw new UsageError(`measure: ${error.message}`);
	}
	const { values, positionals } = parsed;
	if (positionals.length !== 1) throw new UsageError("wv measure needs one video file");
	const m = await measureFilm({ video: positionals[0], storyboard: values.storyboard ?? null, camera: !values["no-camera"], log: (line) => process.stderr.write(`${line}\n`) });
	process.stdout.write(values.json ? `${JSON.stringify(m, null, 1)}\n` : `${formatReport(m)}\n`);
	return 0;
}
