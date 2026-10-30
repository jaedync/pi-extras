/**
 * `wv film`: the film project. The author writes the film as code (a typed
 * storyboard and one TypeScript module per scene); this command makes the
 * project, bundles it into one HyperFrames page and renders it.
 *
 *   wv film new <dir> [--lift <liftDir>]   copy the template (and the lifted brand)
 *   wv film build <dir>                    out/index.html, out/film.json, out/cues.json
 *   wv film preview <dir>                  out/preview.mp4: 30 fps, draft, no blur
 *   wv film render <dir>                   out/film.mp4 at the storyboard's fps
 *   wv film stills <dir> [--at t,t,...]    a contact sheet: each cut, its neighbours, mid-shot
 *   wv film critique <dir>                the packet for a fresh reviewer
 *   wv film critique --plan <dir>         the plan packet, before the first render
 *   wv film mux <dir> --audio <wav>        out/film-sound.mp4: the picture with the master
 *
 * The build runs the bundle once in Chromium to read the cues that the
 * scenes placed, so the cue sheet always matches the picture.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { UsageError } from "../lib/args.mjs";
import { paths } from "../lib/paths.mjs";
import { HYPERFRAMES_ENV, pathWithNode, run, runStreaming } from "../lib/proc.mjs";
import { estimateFilmCacheBytes, extractCacheDir, formatGB, freeBytes, makeRenderCacheDir, removeRenderCacheDir, spaceRefusal } from "../lib/render-cache.mjs";
import { launchBrowser, trackBrowser } from "../lib/browser.mjs";
import { loadPlaywright } from "../lib/runtime.mjs";
import { formatAdvice, loadClipEvents, planAdvice } from "./plan.mjs";
import { masterLengthRefusal, streamSeconds } from "./check.mjs";
import { probeVideo } from "./frames.mjs";

/** probeVideo, or null for a file that ffprobe cannot read (the build reports the clip elsewhere). */
const probeFile = (file) => {
	try {
		return probeVideo(file);
	} catch {
		return null;
	}
};
import { onSignalCleanup } from "../lib/signals.mjs";
import { normalizeStoryboard } from "./storyboard.mjs";

export const TEMPLATE = fileURLToPath(new URL("../../templates/film/", import.meta.url));

const USAGE = `wv film new <dir> [--lift <liftDir>] [--force]
wv film build <dir> [--no-typecheck]
wv film preview <dir>
wv film render <dir> [--quality delivery|looks|draft] [--workers 1|N|auto]
wv film stills <dir> [--at <t,t,...>] [--cols 4]
wv film mux <dir> --audio <master.wav> [--video <file>]
wv film critique <dir> [--video <file>] [--no-check] [--no-measure] [--no-camera]
wv film critique --plan <dir>

new      copies the film template into <dir>: storyboard.ts, film.ts,
         scenes/*.ts, kit/, film.css, brand/ and assets/. --lift copies a
         wv lift folder into brand/ (tokens, brand.css, app.css, fonts).
build    type-checks the project (when TypeScript is available), bundles
         film.ts, and writes out/index.html (the HyperFrames page),
         out/film.json (the storyboard with its whole-frame timing and the
         cues) and out/cues.json (the cue sheet for wv sound mix).
preview  renders out/preview.mp4 at 30 fps, quality draft, no motion blur.
render   renders out/film.mp4 at the storyboard's fps, with one capture
         worker: more workers are faster, but they interleave browsers that
         rasterize a slow drift differently, and the drift plays in steps
         (wv check: staircase). Use --workers auto only for a draft.
stills   writes out/stills/sheet.jpg: the frame before each cut, the cut
         frame, and the middle of each shot; or the --at times (seconds).
mux      puts the master from wv sound mix on out/film.mp4 (or --video):
         the picture is copied, the sound is AAC 320k, the length is the
         picture's. Refuses a master that is shorter than the picture, which
         would cut the end of the film. Writes out/film-sound.mp4.
critique writes out/critique-N/ for a fresh reviewer: cold/ (timeline.jpg,
         cuts.jpg and film.mp4, for a cold read), frames/ (first, middle and
         last frame of every shot, full size), sound.png, loudness.png,
         cues.txt, shots.md, check.txt, measure.txt, anchor/ (a film the
         owner scored, from $WV_ANCHORS or ~/.config/pi-walkthrough-video/
         anchors/anchors.json) and brief.md (references/critique.md with
         today's taste text) and films.md. Uses out/film-sound.mp4, else
         out/film.mp4, or --video.
         --plan writes out/plan-N/ before any render, from out/film.json (wv
         film build) and the clips: plan.md (times, lengths, intent, the part
         of each clip, the planned pace and family, the proof), clips/<shot>.jpg
         (a contact sheet of each clip's part, with times) and .txt (its text
         samples and inputs), advice.txt, stills.jpg (if made), films.md and
         brief.md (references/plan-critique.md with today's taste text).`;

/** HTML-escapes text for an attribute or a text node. */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The JSON that goes inside a <script> element, safe against "</script>". */
const scriptJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

const seconds = (n) => String(Number(n.toFixed(6)));

/**
 * The HyperFrames page: one root composition, one section per shot (with its
 * clip, if any), the film data, GSAP and the bundle.
 */
export function filmHtml({ storyboard, timing, tokens, bundle, brandCss = "", appCss = false, motionBlur = false }) {
	const { fps, width, height, duration } = timing;
	const sections = timing.shots.map((shot, index) => {
		const raw = storyboard.shots[index];
		const clip = raw.clip
			? `\n      <video id="clip-${esc(shot.id)}" class="clip" src="${esc(raw.clip.src)}" muted playsinline data-start="${seconds(shot.startFrame / fps)}" data-duration="${seconds((shot.endFrame - shot.startFrame) / fps)}"${raw.clip.from ? ` data-media-start="${seconds(raw.clip.from)}"` : ""} data-track-index="${index}"></video>`
			: "";
		return `    <section class="shot" id="${esc(shot.id)}" data-scene="${esc(raw.scene)}"><div class="cam">${clip}</div></section>`;
	});
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${width}, height=${height}" />
<title>${esc(storyboard.title ?? "film")}</title>
<style id="brand">
${inlineBrandCss(brandCss)}
</style>
${appCss ? `<link rel="stylesheet" href="brand/app.css" />\n` : ""}<link rel="stylesheet" href="film.css" />
<style>html, body { width: ${width}px; height: ${height}px; } #root { position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; overflow: hidden; }</style>
<script src="kit/gsap.min.js"></script>
</head>
<body>
  <div id="root" data-composition-id="main" data-fps="${fps}" data-start="0" data-duration="${seconds(duration)}" data-width="${width}" data-height="${height}"${motionBlur ? ` data-motion-blur="on"` : ""}>
${sections.join("\n")}
  </div>
<script id="film-data" type="application/json">${scriptJson({ storyboard, timing, tokens })}</script>
<script>
${bundle}
</script>
</body>
</html>
`;
}

/**
 * brand.css for an inline <style>: HyperFrames reads @font-face rules only
 * from the HTML itself, and replaces any other family with its own face. Font
 * URLs move from brand/ to the page's folder.
 */
export function inlineBrandCss(css) {
	return String(css)
		.replace(/url\((['"]?)(?!data:|https?:|\/)([^'")]+)\1\)/g, (_, q, path) => `url(${q}brand/${path}${q})`)
		.replace(/<\/style/gi, "<\\/style");
}

/** The peak of a cue that does not give one, dBFS: under a -16 LUFS master with room for the bed. */
export const DEFAULT_CUE_PEAK = -18;

/** The cue sheet for wv sound mix: cue times from the page, the bed's lift from the storyboard. */
export function cueSheet(storyboard, timing, cues) {
	const music = storyboard.music ?? {};
	const liftShot = music.liftAtShot ? timing.shots.find((s) => s.id === music.liftAtShot) : null;
	if (music.liftAtShot && !liftShot) throw new Error(`storyboard: music.liftAtShot is "${music.liftAtShot}", which is not a shot id`);
	return {
		duration: timing.duration,
		fps: timing.fps,
		cues: cues.map((c) => ({ t: c.t, sound: c.sound, peak: c.peak ?? DEFAULT_CUE_PEAK, shot: c.shot })),
		music: {
			...(liftShot ? { liftAt: liftShot.startFrame / timing.fps } : {}),
			...(music.db !== undefined ? { underCuesDb: music.db } : {}),
			...(music.fadeIn !== undefined ? { fadeIn: music.fadeIn } : {}),
			...(music.fadeOut !== undefined ? { fadeOut: music.fadeOut } : {}),
			...(storyboard.bpm ? { bpm: storyboard.bpm } : {}),
			...(music.bed ? { bed: music.bed } : {}),
		},
	};
}

/** The contact sheet times: the last frame before each cut, the cut frame, and each shot's middle. */
export function stillTimes(timing) {
	const f = (frame) => Number((frame / timing.fps).toFixed(4));
	const times = new Set();
	for (const [i, shot] of timing.shots.entries()) {
		if (i > 0) {
			times.add(f(shot.startFrame - 1));
			times.add(f(shot.startFrame));
		}
		times.add(f(Math.round((shot.startFrame + shot.endFrame) / 2)));
	}
	times.add(f(timing.frames - 1));
	return [...times].sort((a, b) => a - b);
}

/** ffmpeg arguments to put a master on a picture: the video copied, the sound AAC 320k, cut to the picture. */
export function muxArgs({ video, audio, out }) {
	return ["-v", "error", "-y", "-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-shortest", "-movflags", "+faststart", out];
}

/** esbuild from the runtime cache (it comes with hyperframes). */
async function loadEsbuild() {
	const root = join(paths().root, "node_modules");
	try {
		const require = createRequire(join(root, "noop.js"));
		return (await import(pathToFileURL(require.resolve("esbuild")).href)).default ?? (await import(pathToFileURL(require.resolve("esbuild")).href));
	} catch {
		throw new Error(`esbuild is not in ${root}. Run wv setup.`);
	}
}

/** Bundles one entry to a string. */
async function bundleEntry(esbuild, entry, format) {
	const result = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format, target: "chrome120", platform: format === "esm" ? "node" : "browser", logLevel: "silent", legalComments: "none" });
	return result.outputFiles[0].text;
}

/** The project's storyboard: bundled, so storyboard.ts may import helpers. */
export async function readProjectStoryboard(dir, esbuild) {
	const entry = ["storyboard.ts", "storyboard.mjs", "storyboard.json"].map((name) => join(dir, name)).find((file) => existsSync(file));
	if (!entry) throw new Error(`no storyboard.ts or storyboard.json in ${dir}`);
	if (entry.endsWith(".json")) return JSON.parse(readFileSync(entry, "utf8"));
	const code = await bundleEntry(esbuild ?? (await loadEsbuild()), entry, "esm");
	const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
	if (!module.default) throw new Error(`${entry} must default-export the storyboard`);
	return module.default;
}

/** tsc from the runtime (wv setup), else from a dev checkout next to this skill, or null. */
export function findTsc(roots = [paths().typescript, null]) {
	for (const root of roots) {
		try {
			const pkg = root ? join(root, "package.json") : createRequire(import.meta.url).resolve("typescript/package.json");
			if (!existsSync(pkg)) continue;
			const bin = JSON.parse(readFileSync(pkg, "utf8")).bin?.tsc;
			if (bin && existsSync(join(dirname(pkg), bin))) return join(dirname(pkg), bin);
		} catch {
			// not here: try the next place
		}
	}
	return null;
}

/**
 * Why a clip `src` cannot work in the built page, or null. The page loads it
 * from out/, and the build copies only brand/ and assets/ there, so a path
 * outside assets/ renders as a black shot with no error.
 */
export function clipSrcProblem(src) {
	if (/^(?:[a-z]+:|\/|~)/i.test(src) || src.split(/[\\/]/).includes("..")) return `${src} is not a path inside assets/: the page loads it from out/, so it must be relative (assets/create.mp4)`;
	if (!/^assets\//.test(src)) return `${src} is outside assets/: the build copies only brand/ and assets/ into out/`;
	return null;
}

/** Fails when a shot's clip is outside assets/ or not in the folder the page loads it from. */
export function checkClips(pageDir, norm) {
	const problems = [];
	for (const shot of norm.shots) {
		const src = shot.params?.clip?.src;
		if (typeof src !== "string") continue;
		const problem = clipSrcProblem(src);
		if (problem) problems.push(`shot "${shot.id}": ${problem}`);
		else if (!existsSync(join(pageDir, src))) problems.push(`shot "${shot.id}": its clip ${src} is not in ${pageDir}`);
	}
	if (problems.length) throw new Error(problems.join("; "));
}

/** Advice when a clip is shorter than the part its shot shows: the last frame holds. */
export function clipLengthAdvice(norm, probe) {
	const advice = [];
	for (const shot of norm.shots) {
		const clip = shot.params?.clip;
		if (typeof clip?.src !== "string") continue;
		const info = probe(clip.src);
		if (!info || !Number.isFinite(info.duration)) continue;
		const from = Number(clip.from ?? 0);
		const need = shot.end - shot.start;
		if (info.duration >= from + need - 1 / (info.fps || 30)) continue;
		advice.push({
			kind: "clip_short",
			message: `shot "${shot.id}" shows ${need.toFixed(2)} s from ${from.toFixed(2)} s of ${clip.src}, but the clip is ${info.duration.toFixed(2)} s: the shot runs past its last frame`,
			fix: "capture a longer clip, start the shot later in the clip (clip.from), or shorten the shot",
		});
	}
	return advice;
}

export function newProject(dir, { lift = null, force = false, log = (_line) => {} } = {}) {
	const target = resolve(dir);
	if (existsSync(target) && readdirSync(target).length && !force) throw new Error(`${target} is not empty; use --force to write over it`);
	cpSync(TEMPLATE, target, { recursive: true });
	if (lift) {
		const from = resolve(lift);
		if (!existsSync(join(from, "tokens.json"))) throw new Error(`${from} has no tokens.json; run wv lift first`);
		for (const name of ["tokens.json", "brand.css", "app.css", "fonts"]) if (existsSync(join(from, name))) cpSync(join(from, name), join(target, "brand", name), { recursive: true });
		log(`brand from ${from}`);
	}
	return target;
}

export async function build(dir, { typecheck = true, log = (_line) => {} } = {}) {
	const project = resolve(dir);
	if (!existsSync(join(project, "film.ts"))) throw new Error(`${project} has no film.ts; make a project with wv film new`);
	if (typecheck) {
		const tsc = findTsc();
		if (!tsc) log("build: TypeScript is not installed, so the type check is skipped. Run wv setup to install it.");
		else {
			// Through the tracked runner: a 10 min type check must not block the signal path.
			const r = await run(process.execPath, [tsc, "-p", project], { cwd: project, timeoutMs: 10 * 60_000 });
			if (r.timedOut) throw new Error("the type check did not finish in 10 min. Check the film for a slow type, or build with --no-typecheck.");
			if (r.code !== 0) throw new Error(`the film does not type-check:\n${(r.stdout + r.stderr).trim()}`);
		}
	}
	const esbuild = await loadEsbuild();
	const storyboard = await readProjectStoryboard(project, esbuild);
	const norm = normalizeStoryboard(storyboard);
	const timing = { fps: norm.fps, width: norm.width, height: norm.height, duration: norm.duration, frames: norm.frames, shots: norm.shots.map(({ id, start, end, startFrame, endFrame }) => ({ id, start, end, startFrame, endFrame })) };
	const tokensFile = join(project, "brand", "tokens.json");
	// The page gets the roles, not where they came from: the lift URL is often a local address.
	const { source: _source, states: _states, facts: _facts, ...tokens } = existsSync(tokensFile) ? JSON.parse(readFileSync(tokensFile, "utf8")) : {};
	if (Array.isArray(tokens.fonts)) tokens.fonts = tokens.fonts.map(({ src: _src, ...font }) => font);
	const bundle = await bundleEntry(esbuild, join(project, "film.ts"), "iife");

	const out = join(project, "out");
	mkdirSync(out, { recursive: true });
	for (const name of ["brand", "assets"]) {
		rmSync(join(out, name), { recursive: true, force: true });
		if (existsSync(join(project, name))) cpSync(join(project, name), join(out, name), { recursive: true });
	}
	cpSync(join(project, "film.css"), join(out, "film.css"));
	// Check the clips where the page loads them, after the copy: out/ is what the render reads.
	checkClips(out, norm);
	mkdirSync(join(out, "kit"), { recursive: true });
	const gsap = join(paths().root, "node_modules", "gsap", "dist", "gsap.min.js");
	if (!existsSync(gsap)) throw new Error(`GSAP is not in ${dirname(gsap)}. Run wv setup.`);
	cpSync(gsap, join(out, "kit", "gsap.min.js"));
	const brandFile = join(project, "brand", "brand.css");
	const brandCss = existsSync(brandFile) ? readFileSync(brandFile, "utf8") : "";
	const html = filmHtml({ storyboard, timing, tokens, bundle, brandCss, appCss: storyboard.appCss === true && existsSync(join(project, "brand", "app.css")), motionBlur: storyboard.motionBlur === true });
	writeFileSync(join(out, "index.html"), html);

	const page = await runPage(join(out, "index.html"), timing, norm);
	const film = { ...storyboard, cues: page.cues, timing };
	writeFileSync(join(out, "film.json"), `${JSON.stringify(film, null, 1)}\n`);
	writeFileSync(join(out, "cues.json"), `${JSON.stringify(cueSheet(storyboard, timing, page.cues), null, 1)}\n`);
	// Advice before the first render: what the storyboard and the clips already say.
	const advice = [...planAdvice({ norm, clips: loadClipEvents(project, norm) }), ...clipLengthAdvice(norm, (rel) => probeFile(join(project, rel))), ...page.advice];
	for (const note of page.notes) log(`build: ${note}`);
	writeFileSync(join(out, "advice.json"), `${JSON.stringify(advice, null, 1)}\n`);
	if (advice.length) log(formatAdvice(advice));
	log(`build: ${timing.shots.length} shots, ${timing.duration} s, ${timing.frames} frames, ${page.cues.length} cues, ${advice.length} advice -> ${out}`);
	return { out, timing, cues: page.cues, advice };
}

/** The build error when the film timeline is not as long as the storyboard, or null. */
export function timelineLengthError(length, timing) {
	if (Math.abs(length - timing.duration) <= 1 / timing.fps) return null;
	return `the timeline is ${length.toFixed(3)} s but the storyboard is ${timing.duration} s. A tween that starts before 0 s (a LEAD on the first shot) moves the whole film later: place it with place() from kit/motion.ts, as riseWords, pop and drift do. Or a scene places a tween after its shot ends`;
}

/** Runs the built page once in Chromium: errors fail the build, the cues come back, and each shot's subject is measured. */
async function runPage(file, timing, norm) {
	const { chromium } = await loadPlaywright();
	const browser = await launchBrowser(chromium);
	const untrack = trackBrowser(browser);
	try {
		const page = await browser.newPage({ viewport: { width: timing.width, height: timing.height } });
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
		await page.waitForFunction(() => /** @type {any} */ (window).__film?.ready === true, null, { timeout: 15000 }).catch(() => {});
		if (errors.length) throw new Error(`the film page threw: ${errors.join("; ")}`);
		const state = await page.evaluate(() => {
			const w = /** @type {any} */ (window);
			return { ready: w.__film?.ready === true, cues: w.__film?.cues ?? [], length: w.__timelines?.main?.duration() ?? 0 };
		});
		if (!state.ready) throw new Error("the film page did not call mountFilm (window.__film.ready is not set)");
		const lengthError = timelineLengthError(state.length, timing);
		if (lengthError) throw new Error(lengthError);
		const { measureSubjects, subjectAdvice } = await import("./page-check.mjs");
		const notes = [];
		const advice = subjectAdvice(await measureSubjects(page, norm, dirname(file), notes), norm);
		return { ...state, advice, notes };
	} finally {
		untrack();
		await browser.close().catch(() => {});
	}
}

/** @returns {[string, string[]] | null} */
function hyperframesCommand() {
	const bin = join(paths().root, "node_modules", ".bin", "hyperframes");
	return existsSync(bin) ? [bin, []] : null;
}

function readFilm(project) {
	const file = join(project, "out", "film.json");
	if (!existsSync(file)) throw new Error(`no out/film.json in ${project}; run wv film build first`);
	return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * The environment of a film render: the Node that runs wv on PATH (the
 * HyperFrames bin starts with `#!/usr/bin/env node`), and no npm update check.
 */
export function filmRenderEnv(env = process.env) {
	return { ...env, ...HYPERFRAMES_ENV, PATH: pathWithNode(env) };
}


/** Why a HyperFrames run failed: a timeout says so, another failure keeps its last lines. */
export function hyperframesFailure(r, what) {
	const lines = `${r.stderr ?? ""}\n${r.stdout ?? ""}`.trim().split("\n").filter(Boolean).slice(-4).join(" ");
	if (r.timedOut) return `hyperframes ${what} timed out after 60 min: ${lines}`;
	return `hyperframes ${what} failed (exit ${r.code}): ${lines}`;
}

async function hyperframes(project, args, log) {
	const command = hyperframesCommand();
	if (!command) throw new Error("hyperframes is not installed; run wv setup");
	const [cmd, pre] = command;
	let last = -1;
	const r = await runStreaming(cmd, [...pre, ...args], {
		cwd: join(project, "out"),
		env: filmRenderEnv(),
		timeoutMs: 60 * 60_000,
		onLine: (line) => {
			const m = /(\d{1,3})\s*%/.exec(line);
			if (m && Number(m[1]) >= last + 10) {
				last = Number(m[1]);
				log(`hyperframes: ${last} %`);
			}
		},
	});
	if (r.code !== 0) throw new Error(hyperframesFailure(r, args[0]));
	return r;
}

/**
 * HyperFrames render arguments. One capture worker by default: HyperFrames
 * hands frames to its workers in turn, and each Chrome rasterizes a slowly
 * scaling layer at its own scale, so 4 workers make a slow drift jump on every
 * 4th frame (measured on the gate film's end card: steps 0.9, 2.7, 1.3, 0.7
 * against an even 1.0, 0.7 from one worker). x264 settings were not the cause.
 */
export function renderArgs({ fps, quality, out, workers = "1", cacheDir = null, extra = [] }) {
	return ["render", "--fps", String(fps), "--quality", quality, "--video-frame-format", "png", "--workers", String(workers), ...extra, ...(cacheDir ? ["--frames-cache-dir", cacheDir] : []), "-o", out];
}

/** Renders with the frame cache inside the space on the host, and removes this render's cache folder. */
async function renderFilm(project, { fps, quality, output, workers = "1", extra = [], log }) {
	const film = readFilm(project);
	const base = extractCacheDir();
	let cacheDir = null;
	if (base) {
		const { probeVideo } = await import("./frames.mjs");
		const shots = film.timing.shots.map((t, i) => {
			const src = film.shots[i]?.clip?.src;
			const file = src ? join(project, "out", src) : null;
			const info = file && existsSync(file) ? probeVideo(file) : null;
			return { seconds: t.end - t.start, ...(info ? { clip: { width: info.width, height: info.height } } : {}) };
		});
		const needed = estimateFilmCacheBytes({ fps, shots });
		const refusal = spaceRefusal({ needed, free: freeBytes(base), cacheDir: base });
		if (refusal) throw new Error(refusal);
		cacheDir = makeRenderCacheDir(base);
		log(`frame cache ${cacheDir}: about ${formatGB(needed)} needed`);
	}
	const out = join(project, "out", output);
	const dropCache = onSignalCleanup(() => removeRenderCacheDir(cacheDir));
	try {
		await hyperframes(project, renderArgs({ fps, quality, out, workers, cacheDir, extra }), log);
	} finally {
		dropCache();
		// A render that fails, runs out of memory or hits the timeout leaves GBs of frames.
		try {
			removeRenderCacheDir(cacheDir);
		} catch {
			// A cache folder that cannot be deleted is not a render failure.
		}
	}
	return out;
}

async function stills(project, { at = null, cols = 4, log }) {
	const film = readFilm(project);
	const times = at ?? stillTimes(film.timing);
	const dir = join(project, "out", "stills");
	rmSync(dir, { recursive: true, force: true });
	await hyperframes(project, ["snapshot", "--at", times.join(","), "--no-end", "-o", join(dir, "frames")], log);
	const { snapshotStills, writeSheet } = await import("../hf.mjs");
	const shots = snapshotStills(join(dir, "frames"));
	if (!shots.length) throw new Error(`hyperframes wrote no stills into ${join(dir, "frames")}`);
	const sheet = await writeSheet({ items: shots, cols, cellWidth: 480, out: join(dir, "sheet.jpg"), cells: join(dir, "cells") });
	rmSync(join(dir, "cells"), { recursive: true, force: true });
	return { sheet, frames: shots.map((s) => s.file) };
}

export async function main(argv) {
	const [sub, ...rest] = argv;
	if (!sub || sub === "--help" || sub === "-h" || rest.includes("--help")) {
		process.stdout.write(`${USAGE}\n`);
		return sub ? 0 : 2;
	}
	let parsed;
	try {
		parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { lift: { type: "string" }, force: { type: "boolean" }, "no-typecheck": { type: "boolean" }, quality: { type: "string" }, at: { type: "string" }, cols: { type: "string" }, audio: { type: "string" }, video: { type: "string" }, "no-check": { type: "boolean" }, "no-measure": { type: "boolean" }, "no-camera": { type: "boolean" }, workers: { type: "string" }, plan: { type: "boolean" } } });
	} catch (error) {
		throw new UsageError(`film: ${error.message}`);
	}
	const { values, positionals } = parsed;
	if (positionals.length !== 1) throw new UsageError(`wv film ${sub} needs one project directory`);
	const dir = resolve(positionals[0]);
	const log = (line) => process.stderr.write(`${line}\n`);
	switch (sub) {
		case "new":
			process.stdout.write(`${newProject(dir, { lift: values.lift ?? null, force: values.force, log })}\n`);
			return 0;
		case "build":
			await build(dir, { typecheck: !values["no-typecheck"], log });
			process.stdout.write(`${join(dir, "out", "index.html")}\n`);
			return 0;
		case "preview":
			process.stdout.write(`${await renderFilm(dir, { fps: 30, quality: "draft", output: "preview.mp4", workers: "auto", extra: ["--page-motion-blur", "off"], log })}\n`);
			return 0;
		case "render": {
			const quality = values.quality ?? "delivery";
			if (!["delivery", "looks", "draft"].includes(quality)) throw new UsageError("--quality must be delivery, looks or draft");
			const workers = values.workers ?? "1";
			if (!/^(auto|[1-9]\d?)$/.test(workers)) throw new UsageError("--workers must be a number from 1 to 99 or auto");
			process.stdout.write(`${await renderFilm(dir, { fps: readFilm(dir).timing.fps, quality, output: "film.mp4", workers, log })}\n`);
			return 0;
		}
		case "stills": {
			const at = values.at ? values.at.split(",").map(Number) : null;
			if (at && at.some((t) => !Number.isFinite(t) || t < 0)) throw new UsageError("--at takes times in seconds, like 1.5,3,4.25");
			const cols = values.cols === undefined ? 4 : Number(values.cols);
			if (!Number.isInteger(cols) || cols < 1 || cols > 12) throw new UsageError("--cols must be a whole number of columns from 1 to 12");
			const result = await stills(dir, { at, cols, log });
			process.stdout.write(`${result.sheet}\n`);
			return 0;
		}
		case "mux": {
			if (!values.audio) throw new UsageError("wv film mux needs --audio <master.wav> (from wv sound mix)");
			const video = resolve(values.video ?? join(dir, "out", "film.mp4"));
			if (!existsSync(video)) throw new Error(`${video} does not exist; run wv film render first`);
			const audio = resolve(values.audio);
			if (!existsSync(audio)) throw new Error(`${audio} does not exist; run wv sound mix first`);
			// Both lengths before the mux: -shortest would cut the picture, and the muxed file gives no sign of it.
			const refusal = masterLengthRefusal({ fps: probeVideo(video).fps, videoS: streamSeconds(video).video, audioS: streamSeconds(audio).audio });
			if (refusal) throw new Error(refusal);
			const out = join(dirname(video), "film-sound.mp4");
			const r = await run("ffmpeg", muxArgs({ video, audio, out }), { timeoutMs: 10 * 60_000 });
			if (r.timedOut) throw new Error(`ffmpeg did not finish the mux in 10 min: ${(r.stderr || "").trim().split("\n").slice(-2).join(" ")}`);
			if (r.code !== 0) throw new Error(`ffmpeg could not mux: ${(r.stderr || "").trim().split("\n").slice(-2).join(" ")}`);
			process.stdout.write(`${out}\n`);
			return 0;
		}
		case "critique": {
			const { writeCritique, writePlanCritique } = await import("./critique.mjs");
			if (values.plan) {
				const plan = await writePlanCritique(dir, { log });
				process.stdout.write(`${join(plan.dir, "brief.md")}\n`);
				return 0;
			}
			const result = await writeCritique(dir, { video: values.video, check: !values["no-check"], measure: !values["no-measure"], camera: !values["no-camera"], log });
			process.stdout.write(`${join(result.dir, "brief.md")}\n`);
			return 0;
		}
		default:
			throw new UsageError(`unknown wv film subcommand "${sub}"; use new, build, preview, render, stills, mux or critique`);
	}
}
