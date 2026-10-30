/**
 * wv film critique <dir>: the folder that a fresh reviewer gets. A reviewer
 * agent cannot watch a film, so the packet turns the rendered film into
 * pictures: the whole film at even steps, the frames around each cut, the
 * waveform with the cues and the cuts on it, plus the shot list, the check and
 * the measures, and the brief with the taste text.
 *
 * The packet is self-sufficient: a reviewer in a read-only sandbox cannot
 * extract frames, so the full-size frames of every shot are files in it. The
 * cold read (cold/) comes before the storyboard, because the review that knew
 * the author's intent scored the gate film 2 points over the owner. Anchor
 * films that the owner scored give the score fixed points on the owner's scale.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loudness } from "./audio.mjs";
import { findMixReport } from "./check.mjs";
import { probeVideo } from "./frames.mjs";
import { failed, run } from "../lib/proc.mjs";
import { labelArgs, tileArgs } from "../lib/review.mjs";
import { clipWindow, formatAdvice, inputEvents, plannedPace } from "./plan.mjs";

const BRIEF = new URL("../../references/critique.md", import.meta.url);
const PLAN_BRIEF = new URL("../../references/plan-critique.md", import.meta.url);
/** The reference films with their devices and numbers; both briefs name it. */
const FILMS_MD = fileURLToPath(new URL("../../references/films.md", import.meta.url));
const WV = fileURLToPath(new URL("../wv.mjs", import.meta.url));

/** The most cells on the timeline sheet; the step grows in quarter seconds to fit. */
export const TIMELINE_CELLS = 48;
/** Frames shown on each side of a cut. */
export const CUT_REACH = 2;
const TIMELINE_PX = 480;
const TIMELINE_COLS = 6;
const CUT_PX = 384;

/**
 * @typedef {{id: string, start: number, end: number, startFrame: number, endFrame: number}} ShotTiming
 * @typedef {{fps: number, duration: number, frames: number, shots: ShotTiming[]}} Timing
 */

/**
 * The frames of the two sheets: each cut with its neighbours, and an even timeline.
 * @param {Timing} timing
 */
export function critiqueFrames(timing) {
	const { fps, frames, shots } = timing;
	const last = frames - 1;
	const shotAt = (frame) => (shots.find((s) => frame >= s.startFrame && frame < s.endFrame) ?? shots.at(-1))?.id ?? "";
	const cuts = shots.slice(1).map((shot, i) => {
		const list = [];
		for (let k = -CUT_REACH; k <= CUT_REACH; k++) {
			const frame = shot.startFrame + k;
			if (frame >= 0 && frame <= last) list.push(frame);
		}
		return { from: shots[i].id, to: shot.id, frame: shot.startFrame, frames: list };
	});
	const duration = frames / fps;
	const step = Math.max(0.25, Math.ceil(duration / (TIMELINE_CELLS - 1) / 0.25) * 0.25);
	const timeline = [];
	for (let t = 0; Math.round(t * fps) < last; t += step) timeline.push({ frame: Math.round(t * fps), shot: shotAt(Math.round(t * fps)) });
	timeline.push({ frame: last, shot: shotAt(last) });
	return { cuts, timeline };
}

/**
 * ffmpeg arguments that write the wanted frames as numbered PNGs in one pass.
 * @param {{video: string, frames: number[], width: number, dir: string}} options
 */
export function selectArgs({ video, frames, width, dir }) {
	const wanted = [...new Set(frames)].sort((a, b) => a - b);
	const select = wanted.map((n) => `eq(n\\,${n})`).join("+");
	return ["-v", "error", "-y", "-i", video, "-an", "-vf", `select='${select}',scale=${width}:-2`, "-fps_mode", "passthrough", `${dir}/%04d.png`];
}

/**
 * ffmpeg arguments for the sound picture: the waveform, each cut as a thin
 * blue line and each cue as a red line, at its time.
 * @param {{audio: string, out: string, duration: number, cues: {t: number}[], cuts: number[], width?: number, height?: number}} options
 */
export function waveArgs({ audio, out, duration, cues, cuts, width = 1600, height = 240 }) {
	// Even x and 2 px: drawbox works on subsampled chroma, so a 1 px line on an odd x loses its colour.
	const x = (t) => 2 * Math.round(Math.max(0, Math.min(width - 2, (t / duration) * width)) / 2);
	const marks = [
		...cuts.map((t) => `drawbox=x=${x(t)}:y=0:w=2:h=${height}:color=0x40a0ff:t=fill`),
		...cues.map((c) => `drawbox=x=${x(c.t)}:y=0:w=2:h=${height}:color=0xff5040:t=fill`),
	];
	// The waveform has a transparent ground; on an opaque one the marks keep their colour.
	const wave = `[0:a]aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=0xd0d0d0:scale=sqrt[w]`;
	const ground = `color=c=0x181818:s=${width}x${height},format=rgba[bg]`;
	const graph = `${wave};${ground};${["[bg][w]overlay=shortest=1,format=rgb24", ...marks].join(",")}`;
	return ["-v", "error", "-y", "-i", audio, "-filter_complex", graph, "-frames:v", "1", out];
}

const num = (n) => Number(n).toFixed(2);

/**
 * The storyboard as the reviewer reads it: each shot's time, length, intent and holds, and the cues.
 * @param {{shots: {id: string, scene: string, what?: string, holds?: [number, number | string][], still?: boolean}[], cues?: {sound: string, t: number, shot: string}[], timing: Timing, title?: string}} film
 */
export function shotTable(film) {
	const rows = film.timing.shots.map((timing, i) => {
		const shot = film.shots[i];
		const holds = shot.still ? "whole shot" : (shot.holds ?? []).map(([a, b]) => `${a}-${b}`).join(", ");
		const cues = (film.cues ?? []).filter((c) => c.shot === timing.id).map((c) => `${c.sound} ${num(c.t)}`).join(", ");
		return `| ${timing.id} | ${shot.scene} | ${num(timing.start)} | ${num(timing.end - timing.start)} | ${shot.what ?? ""} | ${holds} | ${cues} |`;
	});
	return [
		`# Shots${film.title ? `: ${film.title}` : ""}`,
		"",
		`${film.timing.shots.length} shots, ${num(film.timing.duration)} s at ${film.timing.fps} fps. Times are film seconds; holds are seconds from the shot start.`,
		"",
		"| shot | scene | start s | length s | what | planned holds | cues (film s) |",
		"|---|---|---|---|---|---|---|",
		...rows,
		"",
	].join("\n");
}

/**
 * The reviewer's brief: references/critique.md with the sound question, the
 * anchor and the score cap for this film, the files in the packet, and the
 * taste text as it was when the packet was made.
 * @param {{taste: string, files: string[], music?: {bed: boolean | null, none?: string | null}, anchors?: {name: string, score: number, note?: string, folder: string}[], tasteDate?: string | null}} options
 */
export function critiqueBrief({ taste, files, music = { bed: null }, anchors = [], tasteDate = null }) {
	const noBed = music.bed === false || (typeof music.none === "string" && music.none.trim() !== "");
	const sound = noBed
		? `This film has no music bed${music.none ? ` (the storyboard says: "${music.none}")` : ""}. Does the sound still sound complete and alive, or empty? Does each cue sit on a picture event, and is any jump in loudness a startle?`
		: "Is the bed there from the first frame to the last? Does each cue sit on a picture event? Does the loudest moment fall on the end card?";
	const cap = noBed ? "A film with no music bed scores 5 or less unless the storyboard's reason says that the owner accepted it." : "";
	const anchorText = anchors.length
		? [
				"Films that the owner scored, high to low:",
				"",
				...anchors.map((a) => `- \`anchors/${a.folder}/\`: "${a.name}", owner score ${a.score}${a.note ? ` (${a.note})` : ""}.`),
				"",
				"Compare first: for each anchor, better, equal or worse in each of story, phone legibility, motion and sound. Then put the film on the owner's scale:",
				"",
				"- A film that is worse than an anchor in two of the four scores less than that anchor.",
				"- A film scores more than an anchor only when it is better in two of the four and worse in none.",
				"- Give a score that obeys both rules for every anchor. If no score does, give the highest score that obeys the first rule, and name the anchor that conflicts.",
			].join("\n")
		: "No anchor film is set (the author sets one with WV_ANCHORS; see wv film critique in SKILL.md). Score against the reference films only, and say so.";
	const brief = readFileSync(BRIEF, "utf8").trimEnd().replace("{{SOUND_QUESTION}}", sound).replace("{{ANCHOR}}", anchorText).replace(" {{SCORE_CAP}}", cap ? ` ${cap}` : "");
	return `${brief}\n\n## The files in this folder\n\n${files.map((f) => `- ${f}`).join("\n")}\n\n---\n\n${tasteDate ? `The taste text below was read at ${tasteDate}.\n\n` : ""}${taste.trim()}\n`;
}

/**
 * The full-size frames of every shot: its first (the cut frame), middle and last.
 * @param {Timing} timing
 */
export function shotFrames(timing) {
	return timing.shots.flatMap((s) => [
		{ shot: s.id, which: "first", frame: s.startFrame },
		{ shot: s.id, which: "mid", frame: Math.round((s.startFrame + s.endFrame) / 2) },
		{ shot: s.id, which: "last", frame: Math.min(timing.frames - 1, s.endFrame - 1) },
	]);
}

/** LUFS at the bottom and the top of the loudness picture. */
const LOUD_RANGE = [-60, -5];

/**
 * ffmpeg arguments for the loudness picture: a bar for each momentary
 * loudness point, a yellow line at -30 LUFS, red cues and blue cuts.
 * @param {{points: {t: number, m: number}[], duration: number, cues: {t: number}[], cuts: number[], out: string, width?: number, height?: number}} options
 */
export function loudnessArgs({ points, duration, cues, cuts, out, width = 1600, height = 300 }) {
	const x = (t) => 2 * Math.round(Math.max(0, Math.min(width - 2, (t / duration) * width)) / 2);
	const y = (lufs) => Math.round(height - ((Math.max(LOUD_RANGE[0], Math.min(LOUD_RANGE[1], lufs)) - LOUD_RANGE[0]) / (LOUD_RANGE[1] - LOUD_RANGE[0])) * height);
	const bar = Math.max(2, 2 * Math.ceil(width / Math.max(1, points.length) / 2));
	const marks = [
		...points.filter((p) => p.m > LOUD_RANGE[0]).map((p) => `drawbox=x=${x(p.t - 0.1)}:y=${y(p.m)}:w=${bar}:h=${height - y(p.m)}:color=0xb0b0b0:t=fill`),
		`drawbox=x=0:y=${2 * Math.round(y(-30) / 2)}:w=${width}:h=2:color=0xffd040:t=fill`,
		...cuts.map((t) => `drawbox=x=${x(t)}:y=0:w=2:h=${height}:color=0x40a0ff:t=fill`),
		...cues.map((c) => `drawbox=x=${x(c.t)}:y=0:w=2:h=${height}:color=0xff5040:t=fill`),
	];
	return ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x181818:s=${width}x${height}`, "-vf", ["format=rgb24", ...marks].join(","), "-frames:v", "1", out];
}

/** The cue list: each cue's time, shot, sound and the file that the mix used. */
export function cueList(cues, report) {
	const used = report?.cues ?? [];
	const lines = (cues ?? []).map((cue) => {
		const hit = used.find((u) => Math.abs(u.t - cue.t) < 0.002 && u.sound === cue.sound);
		return `${num(cue.t)} s  shot ${cue.shot}  ${cue.sound}${hit?.file ? `  -> ${hit.file}` : ""}${cue.peak !== undefined ? `  peak ${cue.peak} dBFS` : ""}`;
	});
	const extra = used.filter((u) => !(cues ?? []).some((c) => Math.abs(u.t - c.t) < 0.002 && u.sound === c.sound)).map((u) => `${num(u.t)} s  (mix only)  ${u.sound}  -> ${u.file}`);
	return [...(report ? [] : ["no mix report: the file of each cue is not known"]), ...lines, ...extra].join("\n");
}

/** The packet takes at most this many anchors: the critic reads a scale, and each anchor costs a film copy and a sheet. */
export const MAX_ANCHORS = 4;

/**
 * At most `max` anchors from a list sorted high to low, spread evenly from the
 * highest score to the lowest, so the scale keeps both ends.
 * @template T
 * @param {T[]} list
 * @returns {T[]}
 */
export function anchorScale(list, max = MAX_ANCHORS) {
	if (list.length <= max) return [...list];
	if (max <= 1) return list.slice(0, Math.max(0, max));
	return Array.from({ length: max }, (_, i) => list[Math.round((i * (list.length - 1)) / (max - 1))]);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "film";

/**
 * Films that the owner scored: a folder with anchors.json, a list of
 * { file, score, name, note }, files relative to the folder. $WV_ANCHORS, else
 * ~/.config/pi-walkthrough-video/anchors. The package ships none: the films are
 * the owner's. High to low, at most MAX_ANCHORS, each with its packet folder
 * name (score first, so the folder list reads as the scale).
 */
export function loadAnchors(env = process.env, home = homedir()) {
	const dir = env.WV_ANCHORS || join(env.XDG_CONFIG_HOME || join(home, ".config"), "pi-walkthrough-video", "anchors");
	try {
		const list = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
		const found = (Array.isArray(list) ? list : [])
			.filter((a) => a && typeof a.file === "string" && Number.isFinite(Number(a.score)))
			.map((a) => ({ name: String(a.name ?? basename(a.file)), score: Number(a.score), note: String(a.note ?? ""), file: resolve(dir, a.file) }))
			.filter((a) => existsSync(a.file))
			.sort((a, b) => b.score - a.score);
		const seen = new Set();
		return anchorScale(found).map((a) => {
			const base = `${a.score}-${slug(a.name)}`;
			// An anchor can already be named with the suffix that the next one would take (A, A-3, A):
			// number until the name is free, or one anchor's folder would overwrite another's.
			let folder = base;
			for (let n = 2; seen.has(folder); n += 1) folder = `${base}-${n}`;
			seen.add(folder);
			return { ...a, folder };
		});
	} catch {
		return [];
	}
}

/** One anchor's folder in the packet: the film and its timeline sheet. */
async function writeAnchor(anchor, dir, work) {
	const adir = join(dir, "anchors", anchor.folder);
	mkdirSync(adir, { recursive: true });
	copyFileSync(anchor.file, join(adir, "film.mp4"));
	const ainfo = probeVideo(anchor.file);
	const step = Math.max(1, Math.round(ainfo.frames / TIMELINE_CELLS));
	const aframes = Array.from({ length: Math.min(TIMELINE_CELLS, ainfo.frames) }, (_, i) => Math.min(ainfo.frames - 1, i * step));
	const at = await extract(anchor.file, aframes, TIMELINE_PX, join(work, "anchors", anchor.folder));
	await sheet({ cells: [...at.keys()].map((f) => ({ file: at.get(f), label: `${(f / ainfo.fps).toFixed(2)}s` })), cols: TIMELINE_COLS, width: TIMELINE_PX, out: join(adir, "timeline.jpg"), work });
}

/** Runs ffmpeg through the tracked runner and throws with its last line on failure. */
async function ffmpeg(args, what) {
	// 64 MB per stream, stated here so the critique limit does not follow a change of the default.
	const r = await run("ffmpeg", args, { timeoutMs: 10 * 60_000, maxBuffer: 64 << 20 });
	const reason = failed(r, 10);
	if (reason) throw new Error(`ffmpeg could not write ${what}: ${reason}`);
}

const safe = (s) => String(s).replace(/[^\w-]+/g, "_");

/**
 * One file name for each shot id, made unique: "shot-1" and "shot 1" both
 * sanitise to shot_1, and two shots must not share a frame file.
 */
export function uniqueNames(ids) {
	const taken = new Set();
	const names = new Map();
	for (const id of ids) {
		const base = safe(id);
		let name = base;
		for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
		taken.add(name);
		names.set(id, name);
	}
	return names;
}

/** Labels the cells and tiles them into one sheet. */
async function sheet({ cells, cols, width, out, work }) {
	const seq = join(work, "seq");
	rmSync(seq, { recursive: true, force: true });
	mkdirSync(seq, { recursive: true });
	for (const [i, cell] of cells.entries()) await ffmpeg(labelArgs({ src: cell.file, out: join(seq, `cell-${String(i).padStart(3, "0")}.png`), label: cell.label, cellWidth: width }), out);
	await ffmpeg(tileArgs({ dir: seq, count: cells.length, cols, out }), out);
	rmSync(seq, { recursive: true, force: true });
}

/** Extracts frames once and returns a map from frame number to PNG file. */
async function extract(video, frames, width, dir) {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const wanted = [...new Set(frames)].sort((a, b) => a - b);
	await ffmpeg(selectArgs({ video, frames: wanted, width, dir }), dir);
	const files = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
	if (files.length !== wanted.length) throw new Error(`ffmpeg gave ${files.length} of ${wanted.length} frames from ${video}; is the film shorter than film.json says?`);
	return new Map(wanted.map((frame, i) => [frame, join(dir, files[i])]));
}

/**
 * Makes the packet's scratch folder and removes it however the build ends. A
 * packet that failed is removed too: a half-written critique-N must not read
 * as a finished review.
 */
export async function withWorkFolder(dir, build) {
	const work = join(dir, ".work");
	mkdirSync(work, { recursive: true });
	try {
		return await build(dir, work);
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** The next free out/<name>-N folder (critique-N, plan-N), so each round keeps its packet. */
function nextFolder(project, name = "critique") {
	const out = join(project, "out");
	let n = 1;
	while (existsSync(join(out, `${name}-${n}`))) n++;
	return join(out, `${name}-${n}`);
}

/**
 * Runs one wv command and keeps what it printed. It runs through the tracked
 * runner: a child `wv` can last 30 min, and a signal must stop it and wait.
 */
async function wvText(args) {
	const r = await run(process.execPath, [WV, ...args], { env: process.env, timeoutMs: 30 * 60_000 });
	if (r.timedOut) throw new Error(`wv ${args[0]} did not finish in 30 min`);
	// Progress lines ("motion 40% (216/540 frames)") say nothing to a reviewer.
	const stderr = r.stderr.split("\n").filter((line) => !/^\S+ \d+% \(\d+\/\d+ frames\)$/.test(line)).join("\n").trim();
	return `$ wv ${args.join(" ")}\n(exit ${r.code})\n\n${r.stdout}${stderr ? `\n${stderr}` : ""}`.trimEnd();
}

/**
 * Writes the packet into out/critique-N.
 * @param {string} project
 * @param {{video?: string, check?: boolean, measure?: boolean, camera?: boolean, taste?: string, log?: (line: string) => void}} [options]
 */
export async function writeCritique(project, { video, check = true, measure = true, camera = true, taste, log = () => {} } = {}) {
	project = resolve(project);
	const filmFile = join(project, "out", "film.json");
	if (!existsSync(filmFile)) throw new Error(`no out/film.json in ${project}; run wv film build first`);
	const film = JSON.parse(readFileSync(filmFile, "utf8"));
	const source = resolve(video ?? [join(project, "out", "film-sound.mp4"), join(project, "out", "film.mp4")].find((f) => existsSync(f)) ?? join(project, "out", "film.mp4"));
	if (!existsSync(source)) throw new Error(`no rendered film in ${project}/out; run wv film render (and wv film mux), or give --video`);
	const info = probeVideo(source);
	const timing = { ...film.timing, fps: info.fps, frames: info.frames };
	if (Math.abs(info.fps - film.timing.fps) > 0.01) {
		// A preview at another rate: map the shot frames to the video's rate.
		const scale = info.fps / film.timing.fps;
		timing.shots = film.timing.shots.map((s) => ({ ...s, startFrame: Math.round(s.startFrame * scale), endFrame: Math.round(s.endFrame * scale) }));
	}
	return withWorkFolder(nextFolder(project), async (dir, work) => {
		const { cuts, timeline } = critiqueFrames(timing);
		const files = [];
		const seconds = (frame) => (frame / info.fps).toFixed(2);

		const cold = join(dir, "cold");
		mkdirSync(cold, { recursive: true });
		log("critique: timeline");
		const tl = await extract(source, timeline.map((c) => c.frame), TIMELINE_PX, join(work, "timeline"));
		await sheet({ cells: timeline.map((c) => ({ file: tl.get(c.frame), label: `${seconds(c.frame)}s ${safe(c.shot)}` })), cols: TIMELINE_COLS, width: TIMELINE_PX, out: join(cold, "timeline.jpg"), work });
		files.push("cold/timeline.jpg: the whole film at even steps, phone size");

		if (cuts.length) {
			log(`critique: ${cuts.length} cut(s)`);
			const cf = await extract(source, cuts.flatMap((c) => c.frames), CUT_PX, join(work, "cuts"));
			const cells = [];
			for (const cut of cuts) {
				for (let k = -CUT_REACH; k <= CUT_REACH; k++) {
					const frame = cut.frame + k;
					const file = cf.get(frame) ?? cf.get(cut.frame);
					cells.push({ file, label: `${seconds(frame)}s ${safe(k < 0 ? cut.from : cut.to)} ${k > 0 ? "+" : ""}${k}` });
				}
			}
			await sheet({ cells, cols: 2 * CUT_REACH + 1, width: CUT_PX, out: join(cold, "cuts.jpg"), work });
			files.push("cold/cuts.jpg: one row per cut: frames -2, -1, the cut frame 0, +1, +2");
		}
		copyFileSync(source, join(cold, "film.mp4"));
		files.push("cold/film.mp4: the film itself");

		log("critique: full-size frames");
		const wanted = shotFrames(timing);
		const names = uniqueNames(timing.shots.map((s) => s.id));
		const full = await extract(source, wanted.map((w) => w.frame), info.width, join(work, "full"));
		mkdirSync(join(dir, "frames"), { recursive: true });
		for (const w of wanted) await ffmpeg(["-v", "error", "-y", "-i", full.get(w.frame), "-q:v", "2", join(dir, "frames", `${names.get(w.shot) ?? safe(w.shot)}-${w.which}.jpg`)], "frames/");
		files.push("frames/: <shot>-first.jpg (the cut frame), <shot>-mid.jpg and <shot>-last.jpg, full size");

		if (info.audio) {
			log("critique: sound picture");
			await ffmpeg(waveArgs({ audio: source, out: join(dir, "sound.png"), duration: info.duration || timing.duration, cues: film.cues ?? [], cuts: film.timing.shots.slice(1).map((s) => s.start) }), "sound.png");
			files.push("sound.png: the master's waveform; red lines are cues, blue lines are cuts");
			await ffmpeg(loudnessArgs({ points: (await loudness(source)).momentary, duration: info.duration || timing.duration, cues: film.cues ?? [], cuts: film.timing.shots.slice(1).map((s) => s.start), out: join(dir, "loudness.png") }), "loudness.png");
			files.push("loudness.png: momentary loudness; yellow line -30 LUFS, red cues, blue cuts");
		}
		const reportFile = findMixReport(project);
		const report = reportFile ? JSON.parse(readFileSync(reportFile, "utf8")) : null;
		writeFileSync(join(dir, "cues.txt"), `${cueList(film.cues ?? [], report)}\n`);
		files.push("cues.txt: each cue with its time and its sound file");
		const music = { bed: typeof film.music?.none === "string" ? false : report ? Boolean(report.bed) : null, none: film.music?.none ?? null };

		writeFileSync(join(dir, "shots.md"), shotTable(film));
		files.push("shots.md: the storyboard: times, lengths, intent, holds and cues");

		if (check) {
			log("critique: wv check");
			const page = join(project, "out", "index.html");
			writeFileSync(join(dir, "check.txt"), `${await wvText(["check", source, "--storyboard", project, ...(existsSync(page) ? ["--page", page] : []), ...(info.audio ? [] : ["--no-audio"])])}\n`);
			files.push("check.txt: the defect check");
		}
		if (measure) {
			log("critique: wv measure");
			writeFileSync(join(dir, "measure.txt"), `${await wvText(["measure", source, "--storyboard", project, ...(camera ? [] : ["--no-camera"])])}\n`);
			files.push("measure.txt: the numbers beside the reference range");
		}
		const anchors = loadAnchors();
		for (const anchor of anchors) {
			log(`critique: anchor ${anchor.name}`);
			await writeAnchor(anchor, dir, work);
		}
		if (anchors.length) files.push(`anchors/: ${anchors.length} films that the owner scored (${anchors.map((a) => a.score).join(", ")}), each with film.mp4 and timeline.jpg`);

		copyFileSync(FILMS_MD, join(dir, "films.md"));
		files.push("films.md: the 12 reference films, their devices and their measured numbers");

		if (taste === undefined) {
			const { notesPath, tasteText } = await import("./taste.mjs");
			taste = tasteText(notesPath());
		}
		writeFileSync(join(dir, "brief.md"), critiqueBrief({ taste, files, music, anchors, tasteDate: new Date().toISOString() }));
		return { dir, files };
	});
}

/** Cells on a clip's contact sheet. */
export const CLIP_CELLS = 8;

/**
 * The frames of a clip's contact sheet: even steps over the part of the clip
 * that the shot shows ([from, to] clip seconds), each with its clip time and
 * its shot time. A clip shorter than the shot stops at its last frame.
 */
export function clipSheetFrames({ from, to, fps, frames, cells = CLIP_CELLS }) {
	const first = Math.min(frames - 1, Math.max(0, Math.round(from * fps)));
	const last = Math.max(first, Math.min(frames - 1, Math.round(to * fps) - 1));
	const n = Math.max(1, Math.min(cells, last - first + 1));
	const out = [];
	for (let i = 0; i < n; i++) {
		const frame = n === 1 ? first : Math.round(first + (i * (last - first)) / (n - 1));
		out.push({ frame, clipT: frame / fps, shotT: frame / fps - from });
	}
	return out;
}

const where = (t, win) => (t < win.from - 1e-6 ? "before the shot" : t > win.to + 1e-6 ? "after the shot" : `shot ${num(t - win.from)} s`);

/** The app's text in the part of a clip that a shot shows, sample by sample, and the clip's inputs. */
export function clipText(events, win) {
	const fps = events?.fps || 60;
	const lines = [];
	for (const snap of events?.texts ?? []) {
		const t = snap.f / fps;
		if (t < win.from - 1e-6 || t > win.to + 1e-6) continue;
		lines.push(`shot ${num(t - win.from)} s | clip ${num(t)} s: ${snap.items.map((i) => `"${i.text}" (${i.selector})`).join(", ")}`);
	}
	if (!lines.length) lines.push(events?.texts ? "no text sample in this part of the clip" : "the clip has no events.json, so its text is not known");
	const inputs = inputEvents(events);
	lines.push("", ...(inputs.length ? inputs.map((e) => `input ${e.kind} "${e.name}" at clip ${num(e.t)} s (${where(e.t, win)})`) : ["no input (key, click, type, scroll) in this clip"]));
	return `${lines.join("\n")}\n`;
}

const familyText = (family) => (family === null || family === undefined ? "not named" : typeof family === "object" ? `middle (${family.middle})` : family);

/**
 * The plan as the reviewer reads it: each shot's planned time, length,
 * intent and the part of its clip; the pace, the family and the proof.
 * @param {any} film out/film.json
 * @param {Map<string, {fps: number, frames: number, events: any}>} clips by shot id
 */
export function planTable(film, clips = new Map()) {
	const t = film.timing;
	const pace = plannedPace({ fps: t.fps, frames: t.frames, shots: t.shots });
	const rows = t.shots.map((timing, i) => {
		const shot = film.shots[i];
		const win = shot.clip ? clipWindow({ ...timing, params: shot }, t.fps) : null;
		const clip = win ? `${shot.clip.src} ${num(win.from)} to ${num(win.to)} s` : "";
		const follow = shot.follow === undefined ? "" : typeof shot.follow === "string" ? shot.follow : JSON.stringify(shot.follow);
		const subject = shot.subject === undefined ? "" : typeof shot.subject === "string" ? shot.subject : "box";
		return `| ${timing.id} | ${shot.scene} | ${num(timing.start)} | ${num(timing.end - timing.start)} | ${shot.what ?? ""} | ${clip} | ${follow} | ${subject} |`;
	});
	const inputs = t.shots.flatMap((timing, i) => {
		const shot = film.shots[i];
		const info = clips.get(timing.id);
		if (!shot.clip || !info?.events) return [];
		const win = clipWindow({ ...timing, params: shot }, t.fps);
		return inputEvents(info.events).map((e) => `- shot ${timing.id}: ${e.kind} "${e.name}" at ${num(e.t)} s clip time (${where(e.t, win)})`);
	});
	return [
		`# Plan${film.title ? `: ${film.title}` : ""}`,
		"",
		`${t.shots.length} shots, ${num(t.duration)} s at ${t.fps} fps. Times are film seconds. The clip column is the part of the clip that the shot shows, in clip seconds.`,
		"",
		"| shot | scene | start s | length s | what | clip (part shown) | follow | subject |",
		"|---|---|---|---|---|---|---|---|",
		...rows,
		"",
		`Planned pace: ${pace.cutsPerMin.toFixed(1)} cuts a minute, shot median ${num(pace.shotMedianS)} s, CV ${num(pace.shotCv)}: the ${pace.band} band. Family: ${familyText(film.family)}.`,
		"",
		film.proof ? `Proof: shot "${film.proof.shot}": ${film.proof.action}` : "Proof: no proof shot is named.",
		"",
		"Inputs in the clips:",
		...(inputs.length ? inputs : ["- none"]),
		"",
	].join("\n");
}

/** The plan reviewer's brief: references/plan-critique.md, the files and the taste text. */
export function planBrief({ taste, files, tasteDate = null }) {
	const brief = readFileSync(PLAN_BRIEF, "utf8").trimEnd();
	return `${brief}\n\n## The files in this folder\n\n${files.map((f) => `- ${f}`).join("\n")}\n\n---\n\n${tasteDate ? `The taste text below was read at ${tasteDate}.\n\n` : ""}${taste.trim()}\n`;
}

/**
 * Writes the plan packet into out/plan-N: from the built storyboard
 * (out/film.json) and the captured clips, before any render.
 * @param {string} project
 * @param {{taste?: string, log?: (line: string) => void}} [options]
 */
export async function writePlanCritique(project, { taste, log = () => {} } = {}) {
	project = resolve(project);
	const filmFile = join(project, "out", "film.json");
	if (!existsSync(filmFile)) throw new Error(`no out/film.json in ${project}; run wv film build first (the plan packet needs no render)`);
	const film = JSON.parse(readFileSync(filmFile, "utf8"));
	const t = film.timing;
	return withWorkFolder(nextFolder(project, "plan"), async (dir, work) => {
		mkdirSync(join(dir, "clips"), { recursive: true });
		mkdirSync(work, { recursive: true });
		const files = ["plan.md: the storyboard as planned: times, lengths, intent, the part of each clip, the pace, the family and the proof"];
		const names = uniqueNames(t.shots.map((s) => s.id));
		const clips = new Map();
		for (const [i, timing] of t.shots.entries()) {
			const shot = film.shots[i];
			if (!shot.clip?.src) continue;
			const file = [join(project, shot.clip.src), join(project, "out", shot.clip.src)].find((f) => existsSync(f));
			if (!file) throw new Error(`shot "${timing.id}": its clip ${shot.clip.src} does not exist`);
			const info = probeVideo(file);
			const eventsFile = file.replace(/\.[^./]+$/, "") + ".events.json";
			const events = existsSync(eventsFile) ? JSON.parse(readFileSync(eventsFile, "utf8")) : null;
			clips.set(timing.id, { fps: info.fps, frames: info.frames, events });
			const win = clipWindow({ ...timing, params: shot }, t.fps);
			log(`plan: clip sheet of shot ${timing.id}`);
			const cells = clipSheetFrames({ ...win, fps: info.fps, frames: info.frames });
			const name = names.get(timing.id) ?? safe(timing.id);
			const got = await extract(file, cells.map((c) => c.frame), TIMELINE_PX, join(work, name));
			await sheet({ cells: cells.map((c) => ({ file: got.get(c.frame), label: `shot ${num(c.shotT)}s clip ${num(c.clipT)}s` })), cols: 4, width: TIMELINE_PX, out: join(dir, "clips", `${name}.jpg`), work });
			writeFileSync(join(dir, "clips", `${name}.txt`), clipText(events, win));
		}
		if (clips.size) files.push("clips/<shot>.jpg: the part of each clip that its shot shows, at even steps, with shot and clip times; clips/<shot>.txt: its text samples and inputs");
		writeFileSync(join(dir, "plan.md"), planTable(film, clips));
		const adviceFile = join(project, "out", "advice.json");
		const advice = existsSync(adviceFile) ? JSON.parse(readFileSync(adviceFile, "utf8")) : null;
		writeFileSync(join(dir, "advice.txt"), `${advice ? formatAdvice(advice) || "no advice" : "no out/advice.json: run wv film build again"}\n`);
		files.push("advice.txt: the advice of wv film build (not defects)");
		const stills = join(project, "out", "stills", "sheet.jpg");
		if (existsSync(stills)) {
			copyFileSync(stills, join(dir, "stills.jpg"));
			files.push("stills.jpg: the stills of wv film stills (the recreated shots)");
		}
		copyFileSync(FILMS_MD, join(dir, "films.md"));
		files.push("films.md: the 12 reference films, their devices and their measured numbers");
		if (taste === undefined) {
			const { notesPath, tasteText } = await import("./taste.mjs");
			taste = tasteText(notesPath());
		}
		writeFileSync(join(dir, "brief.md"), planBrief({ taste, files, tasteDate: new Date().toISOString() }));
		return { dir, files };
	});
}
