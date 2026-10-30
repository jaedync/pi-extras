// wv render <projectDir> [--out file] [--quality delivery|looks|draft] [--gif] [--keep-cache]
// wv preview <projectDir> [--out file]
// wv review <projectDir>
// Thin wrappers over the pinned HyperFrames CLI with the settings that suit UI captures:
// PNG frame extraction (JPEG softens UI text), the plan's fps, and no telemetry.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hyperframesBin, hyperframesMissing, paths } from "./lib/paths.mjs";
import { requireProjectGsap } from "./lib/gsap.mjs";
import { onSignalCleanup } from "./lib/signals.mjs";
import { HYPERFRAMES_ENV, failed, pathWithNode, run, runStreaming } from "./lib/proc.mjs";
import { estimateCacheBytes, extractCacheDir, formatGB, freeBytes, makeRenderCacheDir, removeRenderCacheDir, spaceRefusal } from "./lib/render-cache.mjs";
import { renderHtml } from "./lib/compose-html.mjs";
import { BEAT_CELL_PX, BEAT_COLS, beatPages, labelArgs, PHONE_CELL_PX, PHONE_COLS, reviewTimes, SEAM_CELL_PX, tileArgs, timeLabel } from "./lib/review.mjs";

export const HF_ENV = HYPERFRAMES_ENV;
const QUALITIES = new Set(["draft", "looks", "delivery"]);
const HF_TIMEOUT_MS = 60 * 60_000;

/**
 * The installed HyperFrames binary. wv never installs one at run time (the old
 * package-runner fallback pulled unpinned dependencies into a render), so a
 * missing install is a refusal with the fix.
 * @returns {string}
 */
export function hyperframesCommand() {
	const bin = hyperframesBin();
	if (!bin) throw new Error(hyperframesMissing());
	return bin;
}

/** The percentage and the stage of a HyperFrames progress line, or null. */
export function progressOf(line) {
	const match = /(\d{1,3})\s*%/.exec(line);
	if (!match) return null;
	const pct = Math.min(100, Number.parseInt(match[1], 10));
	const stage = line
		.split("%")
		.slice(1)
		.join("%")
		.replace(/[\u2500-\u257f|]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return { pct, stage };
}

/**
 * Why a HyperFrames run failed: a timeout or a kill says so (its exit code is
 * null), and any other failure carries the last lines of its output, so the
 * agent does not have to run the render again to see the message.
 */
export function failureDetail(result, timeoutMs = HF_TIMEOUT_MS) {
	if (result.timedOut) return `it timed out after ${Math.round(timeoutMs / 60000)} min`;
	if (result.code === null && result.signal) return `it was stopped by ${result.signal}`;
	if (result.code === null) return "it exited with no code (killed)";
	const lines = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("[INFO]"));
	return lines.slice(-3).join(" ");
}

/** The frame cache flags for a render: its own folder, or no cache at all. */
export function renderCacheArgs(cacheDir) {
	return ["--frames-cache-dir", cacheDir ?? "off"];
}

/**
 * The errno a failed render really carries. HyperFrames prints "Unknown system
 * error -122" for EDQUOT (disk quota or tmpfs full), which reads like a code bug.
 */
export function diskError(text) {
	if (!/-122\b|EDQUOT|No space left on device|Disk quota exceeded/i.test(text ?? "")) return null;
	return "the disk that holds the HyperFrames frame cache is full (EDQUOT, errno -122), so the render could not write its extracted frames. Free space in the cache folder (hfcache-* entries are only a cache) or render fewer frames with wv preview, then run wv render again.";
}

/** The render arguments for a project: pure, so tests can check them. */
export function renderArgs(plan, { out, quality = "delivery", gif = false }) {
	if (!QUALITIES.has(quality)) throw new Error(`--quality must be one of ${[...QUALITIES].join(", ")}.`);
	if (gif) return ["render", "--format", "gif", "--fps", "15", "--video-frame-format", "png", "-o", out];
	return ["render", "--fps", String(plan.fps ?? 60), "--quality", quality, "--video-frame-format", "png", "-o", out];
}

function readPlan(project) {
	const file = join(project, "plan.json");
	if (!existsSync(file)) throw new Error(`No plan.json in ${project}. Run wv compose first.`);
	return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * The free space check before a render, and the cache folder this render owns.
 * Refuses before HyperFrames writes a single frame, because the failure it
 * replaces ("Unknown system error -122") arrives after minutes of extraction.
 */
export function prepareCache(plan, { env = process.env, tmp = undefined, log = (_line) => {} } = {}) {
	const base = extractCacheDir(env, tmp);
	if (!base) return { cacheDir: null };
	const needed = estimateCacheBytes(plan);
	const free = freeBytes(base);
	const refusal = spaceRefusal({ needed, free, cacheDir: base, ...(tmp ? { tmp } : {}) });
	if (refusal) throw new Error(refusal);
	const cacheDir = makeRenderCacheDir(base);
	log(`frame cache ${cacheDir}: about ${formatGB(needed)} needed, ${formatGB(free)} free`);
	return { cacheDir };
}

/** Deletes this render's own cache folder, unless the caller keeps it (nothing reads a kept folder). */
export function cleanCache(cacheDir, { keep = false, log = (_line) => {} } = {}) {
	if (!cacheDir || keep) return false;
	try {
		removeRenderCacheDir(cacheDir);
	} catch {
		// A cache folder that cannot be deleted is not a render failure.
	}
	log(`deleted the frame cache folder ${cacheDir}`);
	return true;
}

/** A progress line and a heartbeat, so a minute-long render is not silent. */
function renderProgressLines(log, started) {
	let lastPct = -1;
	let lastLine = "";
	const timer = setInterval(() => {
		const seconds = Math.round((performance.now() - started) / 1000);
		log(`render: ${Math.floor(seconds / 60)} m ${seconds % 60} s, ${lastPct >= 0 ? `${lastPct} %` : "waiting for the first frame"}${lastLine ? ` (${lastLine})` : ""}`);
	}, 10_000);
	if (timer.unref) timer.unref();
	return {
		line(text) {
			const progress = progressOf(text);
			if (!progress) return;
			lastLine = progress.stage;
			if (progress.pct === lastPct) return;
			lastPct = progress.pct;
			log(`render: ${progress.pct} %${progress.stage ? ` ${progress.stage}` : ""}`);
		},
		stop() {
			clearInterval(timer);
		},
	};
}

export async function render(argv) {
	const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string" }, quality: { type: "string" }, gif: { type: "boolean" }, "keep-cache": { type: "boolean" } } });
	if (positionals.length !== 1) throw new Error("Usage: wv render <projectDir> [--out file.mp4] [--quality delivery|looks|draft] [--gif] [--keep-cache]");
	const project = resolve(positionals[0]);
	const out = resolve(values.out ?? join(project, values.gif ? "walkthrough.gif" : "walkthrough.mp4"));
	const plan = readPlan(project);
	const log = (line) => process.stderr.write(`${line}\n`);
	// An old project can still hold a CDN GSAP tag: refuse it here too, as preview does.
	requireProjectGsap(project);
	const args = renderArgs(plan, { out, quality: values.quality, gif: values.gif });
	// Resolve the binary first: a missing HyperFrames must fail before a cache folder exists.
	const cmd = hyperframesCommand();
	const cache = prepareCache(plan, { log });
	const keepCache = Boolean(values["keep-cache"]);
	const dropCache = onSignalCleanup(() => cleanCache(cache.cacheDir, { keep: keepCache, log }));
	const started = performance.now();
	const progress = renderProgressLines(log, started);
	let r;
	try {
		r = await runStreaming(cmd, [...args, ...renderCacheArgs(cache.cacheDir)], { cwd: project, env: { ...process.env, ...HF_ENV, PATH: pathWithNode() }, timeoutMs: HF_TIMEOUT_MS, onLine: (line) => progress.line(line) });
	} catch (error) {
		throw new Error(`hyperframes failed: ${error.message}. Run wv setup; a render that takes over 60 min stops.`);
	} finally {
		progress.stop();
		dropCache();
		// Success, failure or kill by the host: the cache is this render's, so it goes.
		cleanCache(cache.cacheDir, { keep: keepCache, log });
	}
	const output = `${r.stdout}\n${r.stderr}`;
	process.stderr.write(r.stderr.split("\n").filter((l) => !l.startsWith("[INFO]") && /error|warn|complete|rendered in/i.test(l)).join("\n") + "\n");
	if (r.code !== 0) {
		const disk = diskError(output);
		if (disk) throw new Error(`hyperframes render failed: ${disk}`);
		throw new Error(`hyperframes render failed: ${failureDetail(r, HF_TIMEOUT_MS)}.`);
	}
	console.log(out);
	return 0;
}

/**
 * `wv preview`: the project at 640x360 and 30 fps, no motion blur, quality
 * draft. A quick look at the whole video costs about a minute instead of the
 * two to five of a delivery render.
 */
export function previewScale(output) {
	const height = Math.min(360, output.height);
	const width = Math.round(((output.width * height) / output.height) / 2) * 2;
	return { width, height, scale: height / output.height };
}

/**
 * The preview composition: the same plan at 640x360. Every size in index.html is written for a
 * 1080 high frame and scaled by the output height, so a smaller output keeps the layout, the text
 * sizes and the camera, and only the pixel count drops.
 */
export function previewHtml(plan, gsapSrc) {
	const { width, height } = previewScale(plan.output);
	const shots = { look: plan.look ?? {}, intro: plan.cards?.intro ?? null, outro: plan.cards?.outro ?? null };
	const scaled = { ...plan, output: { width, height } };
	return { width, height, html: renderHtml(scaled, shots, { src: "edit.mp4", start: plan.edit.start, duration: plan.edit.duration }, gsapSrc, plan.fontCss ?? "") };
}

/**
 * `options.write` is the seam the test uses to inject a partial write; the CLI
 * takes the default. A preview that fails at any step, also while writing, must
 * leave neither preview.html nor its cache folder behind.
 */
export async function preview(argv, { write = writeFileSync } = {}) {
	const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string" } } });
	if (positionals.length !== 1) throw new Error("Usage: wv preview <projectDir> [--out file.mp4]");
	const project = resolve(positionals[0]);
	const out = resolve(values.out ?? join(project, "preview.mp4"));
	const plan = readPlan(project);
	const log = (line) => process.stderr.write(`${line}\n`);
	// The project's own GSAP, never a CDN copy: the page stays local and needs no network.
	requireProjectGsap(project);
	const preview = previewHtml(plan, "assets/gsap.min.js");
	// The preview composition sits beside index.html so every asset path works unchanged. It is
	// removed again before wv returns: hyperframes check refuses a project with two root
	// compositions, and the preview is a throwaway.
	// Resolve the binary and check the space before the first write: a refusal must leave
	// no preview.html (the next hyperframes check would see two root compositions) and no folder.
	const cmd = hyperframesCommand();
	const cache = prepareCache({ ...plan, output: { width: preview.width, height: preview.height } }, { log });
	const dropCache = onSignalCleanup(() => cleanCache(cache.cacheDir, { log }));
	const previewFile = join(project, "preview.html");
	// Everything after the cache folder exists runs under the cache cleanup, so a write that
	// fails (preview.html is a directory, a read-only project) leaves no folder behind either.
	let r;
	// Registered before the write: a partial write that then fails leaves no composition.
	const dropPreview = onSignalCleanup(() => rmSync(previewFile, { force: true }), "preview.html");
	try {
		write(previewFile, preview.html);
		log(`preview: ${preview.width}x${preview.height}, 30 fps, draft`);
		const args = ["render", "-c", "preview.html", "--fps", "30", "--quality", "draft", "--page-motion-blur", "off", "--video-frame-format", "png", "-o", out];
		const started = performance.now();
		const progress = renderProgressLines(log, started);
		try {
			r = await runStreaming(cmd, [...args, ...renderCacheArgs(cache.cacheDir)], { cwd: project, env: { ...process.env, ...HF_ENV, PATH: pathWithNode() }, timeoutMs: HF_TIMEOUT_MS, onLine: (line) => progress.line(line) });
		} finally {
			progress.stop();
		}
	} finally {
		// The outer finally, so a failed write (a partial file, then ENOSPC) removes it too.
		try {
			try {
				dropPreview();
			} finally {
				// A partial write is a file too: remove it even when the cleanup above failed.
				rmSync(previewFile, { force: true });
			}
		} finally {
			// A failed preview removal must not keep the cache cleanup from running.
			try {
				dropCache();
			} finally {
				cleanCache(cache.cacheDir, { log });
			}
		}
	}
	if (r.code !== 0) {
		const disk = diskError(`${r.stdout}\n${r.stderr}`);
		if (disk) throw new Error(`hyperframes preview failed: ${disk}`);
		throw new Error(`hyperframes preview failed: ${failureDetail(r, HF_TIMEOUT_MS)}.`);
	}
	console.log(out);
	return 0;
}

/** The still frames a snapshot wrote, in capture order: [{file, t}]. */
export function snapshotStills(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.map((name) => {
			const match = /-at-([\d.]+)s\.png$/.exec(name);
			return match ? { file: join(dir, name), t: Number(match[1]) } : null;
		})
		.filter(Boolean)
		.sort((a, b) => a.t - b.t);
}

const pad3 = (i) => String(i).padStart(3, "0");

/**
 * One sheet: label each still with its time, tile them, write a JPEG. The cells
 * are made once per size and time, because a beat can also be a seam frame.
 */
export async function writeSheet({ items, cols, cellWidth, out, cells, ffmpeg = "ffmpeg" }) {
	mkdirSync(cells, { recursive: true });
	const labelled = [];
	for (const [i, item] of items.entries()) {
		const key = join(cells, `${cellWidth}-${item.t.toFixed(2)}.png`);
		if (!existsSync(key)) {
			const r = spawnSync(ffmpeg, labelArgs({ src: item.file, out: key, label: timeLabel(item.t), cellWidth }), { encoding: "utf8", timeout: 60_000 });
			if (r.status !== 0) throw new Error(`ffmpeg could not label ${item.file}: ${(r.stderr || "").trim().split("\n").slice(-1).join(" ")}`);
		}
		labelled.push(key);
	}
	const seq = join(cells, "seq");
	rmSync(seq, { recursive: true, force: true });
	mkdirSync(seq, { recursive: true });
	for (const [i, file] of labelled.entries()) copyFileSync(file, join(seq, `cell-${pad3(i)}.png`));
	const r = await run(ffmpeg, tileArgs({ dir: seq, count: labelled.length, cols, out }), { timeoutMs: 120_000 });
	rmSync(seq, { recursive: true, force: true });
	const reason = failed(r, 2);
	if (reason) throw new Error(`ffmpeg could not write ${out}: ${reason}`);
	return out;
}

/**
 * Writes the review sheets and prints their paths: one beat sheet per 16 beats,
 * one phone sheet, and exactly one seam sheet per shot cut. One snapshot call
 * for every still, so the cost follows the shot list, not the caption count.
 */
export async function review(argv) {
	const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string" } } });
	if (positionals.length !== 1) throw new Error("Usage: wv review <projectDir> [--out <dir>]");
	const project = resolve(positionals[0]);
	const plan = readPlan(project);
	const times = reviewTimes(plan);
	if (times.times.length === 0) throw new Error("the plan has no shots to review; run wv compose first.");
	const outDir = resolve(values.out ?? join(project, ".hyperframes", "artifacts", `review-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`));
	mkdirSync(outDir, { recursive: true });
	const framesDir = join(outDir, "frames");
	const log = (line) => process.stderr.write(`${line}\n`);
	const cmd = hyperframesCommand();
	const at = times.times.map((t) => String(Number(t.toFixed(3)))).join(",");
	const started = performance.now();
	const progress = renderProgressLines(log, started);
	let r;
	try {
		r = await runStreaming(cmd, ["snapshot", "--at", at, "--no-end", "-o", framesDir], { cwd: project, env: { ...process.env, ...HF_ENV, PATH: pathWithNode() }, timeoutMs: HF_TIMEOUT_MS, onLine: (line) => progress.line(line) });
	} finally {
		progress.stop();
	}
	if (r.code !== 0) throw new Error(`hyperframes snapshot failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")}`);
	const stills = snapshotStills(framesDir);
	if (stills.length === 0) throw new Error(`hyperframes wrote no stills into ${framesDir}.`);
	const nearest = (t) => stills.reduce((best, still) => (Math.abs(still.t - t) < Math.abs(best.t - t) ? still : best), stills[0]);
	const cells = join(outDir, "cells");
	const sheets = [];
	for (const page of beatPages(times.beats)) {
		sheets.push(await writeSheet({ items: page.items.map((beat) => ({ ...nearest(beat.t), t: beat.t })), cols: BEAT_COLS, cellWidth: BEAT_CELL_PX, out: join(outDir, `${page.name}.jpg`), cells }));
	}
	sheets.push(await writeSheet({ items: times.beats.map((beat) => ({ ...nearest(beat.t), t: beat.t })), cols: PHONE_COLS, cellWidth: PHONE_CELL_PX, out: join(outDir, "review-phone.jpg"), cells }));
	for (const [index, seam] of times.seams.entries()) {
		const name = `review-seam-${String(index + 1).padStart(2, "0")}`;
		sheets.push(await writeSheet({ items: seam.times.map((t) => ({ ...nearest(t), t })), cols: seam.times.length, cellWidth: SEAM_CELL_PX, out: join(outDir, `${name}.jpg`), cells }));
		log(`seam ${index + 1} at ${seam.t}s (${seam.from} -> ${seam.to})`);
	}
	rmSync(cells, { recursive: true, force: true });
	for (const line of sheetSummary(sheets)) console.log(line);
	console.log(`${times.seams.length} seam sheet(s) for ${times.beats.length} beat(s) in ${outDir}`);
	return 0;
}

/** Beat and phone sheets one per line; the seam sheets (one per cut) as one folder line. */
export function sheetSummary(sheets) {
	const seams = sheets.filter((s) => /review-seam/.test(s));
	const lines = sheets.filter((s) => !/review-seam/.test(s));
	if (seams.length) lines.push(`${seams.length} seam sheet(s): ${dirname(seams[0])}/review-seam-*.jpg`);
	return lines;
}
