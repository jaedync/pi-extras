/**
 * `wv check`: block a film only on objective defects. Taste is the author's
 * job and the critique's; this command finds what is wrong whatever the
 * taste:
 *
 * - repeat_at_cut: the first frames after a cut repeat the picture, so the
 *   motion stops for a moment exactly where the eye expects action.
 * - freeze: a still picture of 0.2 s or more that the storyboard did not ask
 *   for (declare intended stills as `holds` or `still: true`).
 * - ghost_at_cut: a frame at a cut that mixes the two shots.
 * - staircase: a moving shot whose motion lands in lumps every few frames.
 *   HyperFrames hands frames to its capture workers in turn, and each Chrome
 *   rasterizes a slowly scaling layer at its own scale, so with 4 workers
 *   every 4th frame jumps and a slow drift plays as steps.
 * - length: the picture is not the storyboard's length. A mux cuts the end of
 *   the film when the master is shorter, so a short picture is a defect.
 * - loudness, true_peak, clipping, no_audio: the master is out of range.
 * - quiet_sound, loudness_jump, silence, no_bed, rejected_sound: the sound
 *   floor. The film rated 4 of 10 was under -30 LUFS momentary for 75 % of
 *   its length, jumped 36 LU to its end ring, had no bed and used a stock
 *   chime that the owner rejected; the film rated 7 had 4 % and 7 LU.
 * - The page checks (wv check --page): colors that are not in the product
 *   CSS, text too small to read on a phone, text cut by the frame, private
 *   data in the film's text and sources.
 */
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { clippedSamples, loudness, quietGaps, soundFloor } from "./audio.mjs";
import { loadRejected, rejectedCues } from "../lib/rejected.mjs";
import { blend, frameFacts, probeVideo } from "./frames.mjs";
import { loadStoryboard } from "./storyboard.mjs";
import { UsageError } from "../lib/args.mjs";

/** A still picture shorter than this is an ease that comes to rest, not a freeze. */
export const FREEZE_MIN_S = 0.2;
/** Frames after a cut where a repeated picture reads as a hitch. */
export const CUT_HEAD_FRAMES = 3;
/**
 * A frame after a cut that mpdecimate calls a repeat still moves when it
 * changes at least STILL_DIFF grey levels (mean, small copy) and at least
 * STEADY_SHARE of the shot's steady motion just after the head. A 4 % linear
 * drift on centred text moves 0.054 levels a frame all through the shot,
 * under mpdecimate's block threshold. The golden film's hitches moved 0.001
 * to 0.1 levels before motion of about 1: a stop. A true repeat is 0.000.
 */
export const STILL_DIFF = 0.01;
export const STEADY_SHARE = 0.5;
/** Holds are rounded to frames by the author; allow this slack at each end. */
const HOLD_SLACK = 2;
export const LOUDNESS = { target: -16, tolerance: 1, truePeakMax: -1, clippedMax: 2, peakBoundDb: 1 };

/**
 * A master under the range whose true peak is within peakBoundDb of the
 * ceiling is peak-bound: sparse sound (cues, no bed) that wv sound mix cannot
 * raise without crushing its transients. It is quiet by nature, not a defect.
 */
export function peakBound(facts, limits = LOUDNESS) {
	return facts.lufs !== null && facts.truePeak !== null && facts.lufs < limits.target - limits.tolerance && facts.truePeak >= limits.truePeakMax - limits.peakBoundDb;
}

/** The staircase test: a window of this many frame steps, periods 3 to 8 frames (2 is Chrome's own alternation). */
export const STAIR = { window: 32, minPeriod: 3, maxPeriod: 8, ratio: 1.6, wins: 0.9, minWindows: 3 };

const at = (frame, fps) => `${(frame / fps).toFixed(3)} s`;

function inHolds(holds, from, to) {
	return holds.some(([h0, h1]) => from >= h0 - HOLD_SLACK && to <= h1 + HOLD_SLACK);
}

function shotAt(sb, frame) {
	return sb.shots.find((shot) => frame >= shot.startFrame && frame < shot.endFrame) ?? sb.shots[sb.shots.length - 1];
}

/** Runs of consecutive repeated frames: [first repeated frame, count]. */
export function repeatRuns(repeats) {
	const runs = [];
	for (let i = 0; i < repeats.length; i++) {
		if (!repeats[i]) continue;
		let j = i;
		while (j + 1 < repeats.length && repeats[j + 1]) j++;
		runs.push([i, j - i + 1]);
		i = j;
	}
	return runs;
}

/**
 * Stretches where one phase of a period carries the motion: in every cycle of
 * the window the same frame makes the biggest step, and its mean step is
 * `ratio` times the others'. Windows that touch a cut or a hold are skipped.
 * Returns [{ from, to, period, ratio }] in frames.
 */
export function staircases(diffs, sb, opts = STAIR) {
	const n = opts.window;
	const blocked = new Set();
	for (const cut of sb.cuts) for (let f = cut - 1; f <= cut + 1; f++) blocked.add(f);
	const hits = [];
	for (let i = 1; i + n <= diffs.length; i += 4) {
		let clear = !sb.holds.some(([h0, h1]) => i + n > h0 - HOLD_SLACK && i < h1 + HOLD_SLACK);
		for (let f = i - 1; f <= i + n && clear; f++) if (blocked.has(f)) clear = false;
		if (!clear) continue;
		const w = diffs.slice(i, i + n);
		for (let p = opts.minPeriod; p <= opts.maxPeriod; p++) {
			const cycles = Math.floor(n / p);
			const phase = Array.from({ length: p }, (_, j) => {
				let sum = 0;
				for (let c = 0; c < cycles; c++) sum += w[c * p + j];
				return sum / cycles;
			});
			const top = phase.indexOf(Math.max(...phase));
			const rest = phase.reduce((sum, v, k) => (k === top ? sum : sum + v), 0) / (p - 1);
			let wins = 0;
			for (let c = 0; c < cycles; c++) if (w[c * p + top] >= Math.max(...w.slice(c * p, c * p + p))) wins++;
			if (rest > 0 && phase[top] / rest >= opts.ratio && wins / cycles >= opts.wins) {
				hits.push({ from: i, to: i + n, period: p, ratio: phase[top] / rest });
				break;
			}
		}
	}
	const runs = [];
	for (const hit of hits) {
		const last = runs[runs.length - 1];
		if (last && hit.from <= last.to && hit.period === last.period) {
			last.to = hit.to;
			last.windows++;
			last.ratio = Math.max(last.ratio, hit.ratio);
		} else runs.push({ ...hit, windows: 1 });
	}
	return runs.filter((r) => r.windows >= opts.minWindows).map(({ windows: _w, ...r }) => ({ ...r, ratio: Math.round(r.ratio * 100) / 100 }));
}

/** The ghost test for frame g between a (the frame before) and b (after). */
function isGhost(a, g, b) {
	if (!a || !g || !b) return null;
	const mix = blend(a, g, b);
	if (mix.alpha < 0.1 || mix.alpha > 0.9) return null;
	if (mix.contrast < 8 || mix.far < 2 || mix.err > 0.35 * mix.far) return null;
	return mix;
}

/** The defects that the frames show, given the storyboard's cuts and holds. */
export function videoDefects(facts, sb) {
	const { fps, repeats, near } = facts;
	const diffs = facts.diffs ?? [];
	const defects = [];
	if (Number.isFinite(facts.frames) && Math.abs(facts.frames - sb.frames) > 1)
		defects.push({
			kind: "length",
			frame: Math.min(facts.frames, sb.frames),
			message: `the film has ${facts.frames} frames (${(facts.frames / fps).toFixed(2)} s) and the storyboard ${sb.frames} frames (${(sb.frames / fps).toFixed(2)} s): the picture is not the planned length, so a shot or its end is missing`,
			fix: `render the picture again with wv film render, then wv sound mix and wv film mux; a master mixed for another cut truncates the film at the mux`,
		});
	for (const cut of sb.cuts) {
		const shot = shotAt(sb, cut);
		const after = diffs.slice(cut + CUT_HEAD_FRAMES + 1, Math.min(shot.endFrame, cut + CUT_HEAD_FRAMES + 10)).sort((a, b) => a - b);
		const steady = after.length ? after[Math.floor(after.length / 2)] : Infinity;
		const still = (f) => repeats[f] && !((diffs[f] ?? 0) >= STILL_DIFF && (diffs[f] ?? 0) >= STEADY_SHARE * steady);
		let count = 0;
		for (let f = cut + 1; f <= cut + CUT_HEAD_FRAMES && f < repeats.length; f++) if (still(f) && !inHolds(sb.holds, f, f)) count++;
		if (count > 0)
			defects.push({
				kind: "repeat_at_cut",
				frame: cut,
				count,
				message: `${count} of the first ${CUT_HEAD_FRAMES} frames of shot "${shot.id}" at ${at(cut, fps)} repeat the picture, so the motion stops at the cut`,
				fix: `start the shot's motion before the cut (cut on action: begin its tweens a few frames before ${at(cut, fps)}), or declare a still opening with holds: [[0, ${((CUT_HEAD_FRAMES + 1) / fps).toFixed(3)}]] on the shot`,
			});
		for (const [g, a, b] of [[cut, cut - 1, cut + 1], [cut - 1, cut - 2, cut]]) {
			const mix = isGhost(near?.get(a), near?.get(g), near?.get(b));
			if (mix)
				defects.push({
					kind: "ghost_at_cut",
					frame: g,
					message: `frame ${g} (${at(g, fps)}) at the cut into shot "${shot.id}" mixes the two shots (${Math.round(mix.alpha * 100)} % of the frame before it)`,
					fix: "render without page motion blur on the frames next to a cut, or hide the other shot with display: none on that frame (a blur sampler reads across the cut)",
				});
		}
	}
	for (const run of staircases(facts.diffs ?? [], sb)) {
		const shot = shotAt(sb, run.from);
		defects.push({
			kind: "staircase",
			frame: run.from,
			period: run.period,
			seconds: Math.round(((run.to - run.from) / fps) * 1000) / 1000,
			message: `the motion in shot "${shot.id}" from ${at(run.from, fps)} to ${at(run.to, fps)} lands in steps: every ${run.period}th frame carries ${run.ratio}x the move of the others, so a smooth drift plays as a staircase`,
			fix: `render again with wv film render (it captures with one worker; a render with --workers ${run.period} or auto interleaves ${run.period} browsers that rasterize the layer differently)`,
		});
	}
	for (const [first, count] of repeatRuns(repeats)) {
		const from = first - 1;
		const to = first + count - 1;
		const seconds = (count + 1) / fps;
		if (seconds < FREEZE_MIN_S - 1e-9 || inHolds(sb.holds, from, to)) continue;
		const shot = shotAt(sb, from);
		defects.push({
			kind: "freeze",
			frame: from,
			seconds: Math.round(seconds * 1000) / 1000,
			message: `the picture is still for ${seconds.toFixed(2)} s from ${at(from, fps)} to ${at(to + 1, fps)} in shot "${shot.id}", and the storyboard does not hold it`,
			fix: `if the stillness is meant, declare it on shot "${shot.id}": holds: [[${((from - shot.startFrame) / fps).toFixed(2)}, ${to + 1 >= shot.endFrame - HOLD_SLACK ? '"end"' : ((to + 1 - shot.startFrame) / fps).toFixed(2)}]]; if not, keep something moving (a drift, the next entrance) or end the shot sooner`,
		});
	}
	return defects.sort((x, y) => x.frame - y.frame);
}

/** Loudness, true peak and clipping of the master. Null facts mean the film has no sound. */
export function audioDefects(facts, limits = LOUDNESS) {
	if (!facts) return [{ kind: "no_audio", frame: 0, message: "the film has no audio stream; every reference film carries sound for its whole length", fix: "mix the sound with wv sound and mux it, or pass --no-audio while the picture is still in work" }];
	const defects = [];
	if (facts.lufs === null || (Math.abs(facts.lufs - limits.target) > limits.tolerance && !peakBound(facts, limits)))
		defects.push({ kind: "loudness", frame: 0, message: `integrated loudness is ${facts.lufs} LUFS; the range is ${limits.target - limits.tolerance} to ${limits.target + limits.tolerance} LUFS`, fix: "master with wv sound mix (it sets -16 LUFS), then mux again" });
	if (facts.truePeak !== null && facts.truePeak > limits.truePeakMax)
		defects.push({ kind: "true_peak", frame: 0, message: `true peak is ${facts.truePeak} dBTP; the ceiling is ${limits.truePeakMax} dBTP`, fix: "master with wv sound mix (its limiter keeps the true peak at -1 dBTP), and mux with -c:a aac -b:a 256k or higher" });
	if (facts.clipped > limits.clippedMax) defects.push({ kind: "clipping", frame: 0, message: `${facts.clipped} samples sit at full scale`, fix: "lower the cue peaks or the bed fader, then master again" });
	return defects;
}

/** The sound floor limits. */
export const SOUND_FLOOR = { quietShareMax: 0.25, jumpMaxLu: 20, silenceMaxS: 1.5 };

/**
 * The sound floor defects. `facts`: quietShare, jumpLu, jumpAt, silence runs
 * ({ from, to } s), bed (true, false, or null when no mix report says), and
 * the rejected cues. A storyboard with music: { none: "why" } has no bed by
 * choice: its quiet share and jump become notes. A shot with silence: true
 * may be digitally silent.
 */
export function soundDefects(facts, sb, limits = SOUND_FLOOR) {
	const defects = [];
	const noBed = typeof sb.music?.none === "string" && sb.music.none.trim() !== "";
	const pct = (v) => `${Math.round(v * 100)} %`;
	if (facts.bed === false && !noBed)
		defects.push({ kind: "no_bed", frame: 0, message: "the master has no music bed; room tone and cues are not a bed, and the films without one scored lowest", fix: "compose a bed with wv sound score (references/score.md) and mix it with wv sound mix --bed; or, only when the owner asked for no music, set music: { none: \"<the owner's reason>\" } in the storyboard" });
	if (!noBed && facts.quietShare > limits.quietShareMax)
		defects.push({ kind: "quiet_sound", frame: 0, message: `the sound is under -30 LUFS momentary for ${pct(facts.quietShare)} of the film (the limit is ${pct(limits.quietShareMax)}): it sounds empty`, fix: "put a music bed under the whole film (wv sound score, then wv sound mix --bed)" });
	if (!noBed && facts.jumpLu > limits.jumpMaxLu)
		defects.push({ kind: "loudness_jump", frame: Math.round((facts.jumpAt ?? 0) * sb.fps), message: `the momentary loudness jumps ${facts.jumpLu.toFixed(1)} LU over the 3 s before it at ${(facts.jumpAt ?? 0).toFixed(1)} s (the limit is ${limits.jumpMaxLu} LU): it startles`, fix: "raise the floor under that moment (a bed), or lower the cue's peak in its scene" });
	const declared = sb.shots.filter((shot) => shot.params?.silence === true).map((shot) => [shot.startFrame / sb.fps, shot.endFrame / sb.fps]);
	for (const run of facts.silence ?? []) {
		if (run.to - run.from <= limits.silenceMaxS + 1e-9) continue;
		if (declared.some(([a, b]) => run.from >= a - 0.1 && run.to <= b + 0.1)) continue;
		defects.push({ kind: "silence", frame: Math.round(run.from * sb.fps), message: `the sound is digitally silent (under -60 dBFS) for ${(run.to - run.from).toFixed(1)} s from ${run.from.toFixed(1)} s`, fix: "put the bed under it; if the silence is the point, set silence: true on that shot in the storyboard" });
	}
	for (const cue of facts.rejected ?? [])
		defects.push({ kind: "rejected_sound", frame: Math.round((cue.t ?? 0) * sb.fps), message: `the cue at ${Number(cue.t ?? 0).toFixed(2)} s uses ${cue.file}, a sound the owner rejected${cue.why ? ` (${cue.why})` : ""}`, fix: "replace it in the scene's ctx.cue with another sound, or no sound; the bed can carry the moment" });
	return defects;
}

/**
 * The refusal for a mux whose master is shorter than the picture, or null.
 * ffmpeg's -shortest then cuts the end of the film, usually the end card, and
 * both streams come out the same length, so wv check cannot see it.
 */
export function masterLengthRefusal({ fps, videoS, audioS }) {
	if (videoS === null || audioS === null) return null;
	if (videoS - audioS <= 1 / fps + 1e-3) return null;
	return `the master is ${audioS.toFixed(2)} s and the picture ${videoS.toFixed(2)} s: the master is ${(videoS - audioS).toFixed(2)} s shorter, so the mux would cut that much from the end of the film. Fix: run wv sound mix again for this cut, then wv film mux.`;
}

/**
 * The lengths of the muxed film: the sound track and the master in the mix
 * report against the picture. An AAC frame (21 ms) of padding is allowed.
 * film2 passed with a stale master: its mix step failed, and the mux put the
 * master of the longer cut before it under the new picture.
 */
export function muxDefects({ fps, videoS, audioS = null, masterS = null }) {
	const slack = Math.max(1 / fps, 0.025) + 1e-3;
	const defects = [];
	const s = (v) => `${v.toFixed(2)} s`;
	if (audioS !== null && Math.abs(audioS - videoS) > slack)
		defects.push({ kind: "mux_length", frame: 0, message: `the sound track is ${s(audioS)} and the picture ${s(videoS)}: they differ by more than a frame`, fix: "mix the master for this cut (wv sound mix out/cues.json ...), then wv film mux again" });
	if (masterS !== null && Math.abs(masterS - videoS) > slack)
		defects.push({ kind: "stale_master", frame: 0, message: `the mix report's master is ${s(masterS)} and the picture ${s(videoS)}: the sound was mixed for another cut`, fix: "run wv film build, wv sound mix and wv film mux again, so the master is mixed for this cut" });
	return defects;
}

/** Stream durations in seconds: { video, audio } (null when a stream has none). */
export function streamSeconds(file) {
	const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", file], { encoding: "utf8", timeout: 60000 });
	const streams = r.status === 0 ? (JSON.parse(r.stdout).streams ?? []) : [];
	const of = (type) => {
		const d = Number(streams.find((x) => x.codec_type === type)?.duration);
		return Number.isFinite(d) ? d : null;
	};
	return { video: of("video"), audio: of("audio") };
}

/** The mix report: --mix, else out/master.wav.report.json beside the storyboard's project. */
export function findMixReport(storyboard, mix = null) {
	if (mix) return resolve(mix);
	const path = resolve(storyboard);
	const dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
	for (const candidate of [join(dir, "out", "master.wav.report.json"), join(dir, "master.wav.report.json")]) if (existsSync(candidate)) return candidate;
	return null;
}

/** Runs every check that the inputs allow. */
export async function checkFilm({ video, storyboard, audio = true, page = null, tokens = null, mix = null, log = (_line) => {} }) {
	const planned = await loadStoryboard(storyboard);
	const fps = probeVideo(video).fps;
	const notes = [];
	if (Math.abs(fps - planned.fps) > 0.01) notes.push(`the video runs at ${fps} fps and the storyboard at ${planned.fps} fps; the cuts are timed for ${fps} fps`);
	const sb = Math.abs(fps - planned.fps) > 0.01 ? await loadStoryboard(storyboard, { fps }) : planned;
	// Read the owner's list even when the film has no mix report: a list that does not
	// parse must fail the check, not pass as "no rejected sound found".
	const rejectedList = loadRejected(undefined, undefined, (line) => {
		throw new Error(`${line} Fix the file, then run wv check again.`);
	});
	const facts = await frameFacts(video, { cuts: sb.cuts });
	log(`frames: ${facts.frames}, ${facts.repeats.filter(Boolean).length} repeat the frame before`);
	const defects = videoDefects(facts, sb);
	if (audio) {
		const sound = facts.audio ? { ...(await loudness(video)), clipped: await clippedSamples(video) } : null;
		defects.push(...audioDefects(sound));
		if (sound) {
			const floor = soundFloor(sound.momentary);
			const gaps = await quietGaps(video);
			const reportFile = findMixReport(storyboard, mix);
			let bed = null;
			let rejected = [];
			const streams = streamSeconds(video);
			let masterS = null;
			if (reportFile && existsSync(reportFile)) {
				const report = JSON.parse(readFileSync(reportFile, "utf8"));
				bed = Boolean(report.bed);
				masterS = Number.isFinite(report.duration_s) ? report.duration_s : null;
				rejected = rejectedCues(report.cues ?? [], report.sfx ?? "", rejectedList).map((cue) => ({ ...cue, why: rejectedList.why }));
				if (!report.sfx) notes.push(`${reportFile} does not name its sound folder (mix it again), so rejected sounds were matched by file name only`);
			} else notes.push("no mix report (out/master.wav.report.json or --mix): the bed and the rejected sounds were not checked");
			defects.push(...soundDefects({ ...floor, silence: gaps.silence, bed, rejected }, sb));
			defects.push(...muxDefects({ fps, videoS: streams.video ?? facts.frames / fps, audioS: streams.audio, masterS }));
			if (typeof sb.music?.none === "string") notes.push(`no music bed by choice: ${sb.music.none} (under -30 LUFS for ${Math.round(floor.quietShare * 100)} %, largest jump ${floor.jumpLu.toFixed(1)} LU)`);
		}
		if (sound && peakBound(sound)) notes.push(`the master is ${sound.lufs} LUFS with its true peak at ${sound.truePeak} dBTP: sparse sound that cannot be louder without crushing it (not a defect; wv measure compares it with the references)`);
	}
	const advice = [];
	if (page) {
		const { pageDefects } = await import("./page-check.mjs");
		defects.push(...(await pageDefects({ page, tokens, storyboard: sb, log, notes, advice })));
	} else notes.push("page checks skipped (no --page): colors, text size, text in frame and private data were not checked");
	return { ok: defects.length === 0, defects, notes, advice, frames: facts.frames, fps: facts.fps };
}

const USAGE = `Usage: wv check <film.mp4> --storyboard <storyboard.ts|json|film dir> [options]

Blocks the film on objective defects only, and prints one FAIL line and a Fix line for each:
  repeat_at_cut   the first ${CUT_HEAD_FRAMES} frames after a cut repeat the picture
  freeze          a still picture of ${FREEZE_MIN_S} s or more that the storyboard does not hold
  ghost_at_cut    a frame at a cut that mixes the two shots
  staircase       a moving shot whose motion lands in steps every 3 to 8 frames
  loudness        integrated loudness outside ${LOUDNESS.target} +/- ${LOUDNESS.tolerance} LUFS (a quieter master
                  whose true peak is at the ceiling is sparse sound, a note, not a defect)
  true_peak       true peak above ${LOUDNESS.truePeakMax} dBTP
  clipping        samples at full scale
  no_audio        the film has no sound
  no_bed          the mix report says the master has no music bed (unless music: { none: "why" })
  quiet_sound     under -30 LUFS momentary for more than 25 % of the film
  loudness_jump   momentary loudness more than 20 LU over the 3 s before it
  silence         digital silence (under -60 dBFS) for more than 1.5 s outside a shot with silence: true
  length          the picture is not the storyboard's length, by more than a frame
  mux_length      the sound track and the picture differ by more than a frame
  stale_master    the mix report's master is not as long as the picture (mixed for another cut)
  rejected_sound  a cue uses a sound that the owner rejected (references/rejected-sounds.json,
                  plus $WV_REJECTED_SOUNDS or ~/.config/pi-walkthrough-video/rejected-sounds.json)
With --page (the built film page): color, text_small, text_cut, private; and advice (not a
defect) when a shot's subject is under 5 % of the frame width at its largest.

Options:
  --storyboard <p>  the planned timeline: cuts and holds (required)
  --page <file>     the built film page (out/index.html) for the page checks
  --tokens <file>   tokens.json from wv lift (the product palette for the color check)
  --mix <file>      the report of wv sound mix (default: out/master.wav.report.json in the project)
  --no-audio        skip the sound checks (a silent picture render)
  --json            print one JSON object
Exit code 1 when a defect is found.`;

export async function main(argv) {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	let parsed;
	try {
		parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { storyboard: { type: "string" }, page: { type: "string" }, tokens: { type: "string" }, mix: { type: "string" }, "no-audio": { type: "boolean" }, json: { type: "boolean" } } });
	} catch (error) {
		throw new UsageError(`check: ${error.message}`);
	}
	const { values, positionals } = parsed;
	if (positionals.length !== 1) throw new UsageError("wv check needs one video file");
	if (!values.storyboard) throw new UsageError("wv check needs --storyboard (the planned cuts and holds)");
	const result = await checkFilm({ video: positionals[0], storyboard: values.storyboard, audio: !values["no-audio"], page: values.page ?? null, tokens: values.tokens ?? null, mix: values.mix ?? null, log: values.json ? () => {} : (line) => process.stderr.write(`${line}\n`) });
	if (values.json) process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
	else {
		for (const d of result.defects) process.stdout.write(`FAIL ${d.kind}: ${d.message}\n  Fix: ${d.fix}\n`);
		for (const note of result.notes) process.stdout.write(`note: ${note}\n`);
		for (const a of result.advice) process.stdout.write(`advice ${a.kind}: ${a.message}\n  Fix: ${a.fix}\n`);
		process.stdout.write(result.ok ? "check: no defects\n" : `check: ${result.defects.length} defect(s)\n`);
	}
	return result.ok ? 0 : 1;
}
