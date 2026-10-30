/**
 * `wv capture`: run a flow against a live page, pump frames with
 * HeadlessExperimental.beginFrame, and write capture.mp4, events.json and
 * poster.png on one clock.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFlowApi } from "./flow.mjs";
import { onSignalCleanup } from "./signals.mjs";
import { installInstrument, textsOf } from "./instrument.mjs";
import { launchBrowser, trackUntilClosed } from "./browser.mjs";
import { FramePump } from "./pump.mjs";
import { createClockScripts } from "./clock-scripts.mjs";
import { virtualClockScript } from "./vclock.mjs";
import { chromiumPath, headlessShellPath, loadPlaywright } from "./runtime.mjs";
import { hasFfmpeg, run, sleep, withTimeout } from "./proc.mjs";

const PROBE_HTML = "data:text/html,<body style='margin:0;background:%23123'><canvas id=c width=200 height=100></canvas><script>const gl=document.getElementById('c').getContext('webgl');if(gl){gl.clearColor(0.1,0.4,0.9,1);gl.clear(gl.COLOR_BUFFER_BIT)}</script></body>";

function browserArgs({ width, height, scale, gpu }) {
	const args = [
		"--deterministic-mode",
		"--enable-begin-frame-control",
		"--disable-new-content-rendering-timeout",
		"--run-all-compositor-stages-before-draw",
		"--disable-threaded-animation",
		"--disable-threaded-scrolling",
		"--disable-checker-imaging",
		"--disable-image-animation-resync",
		"--enable-surface-synchronization",
		`--force-device-scale-factor=${scale}`,
		`--window-size=${width},${height}`,
	];
	if (gpu) {
		args.push("--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu-rasterization", "--ignore-gpu-blocklist");
		if (process.platform === "darwin") args.splice(args.indexOf("--use-angle=gl-egl"), 1, "--use-angle=metal");
	}
	return args;
}

async function openSession(chromium, { shell, width, height, scale, gpu }) {
	const browser = await launchBrowser(chromium, { executablePath: shell, args: browserArgs({ width, height, scale, gpu }) });
	try {
		const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: "no-preference" });
		const page = await context.newPage();
		const cdp = await context.newCDPSession(page);
		await cdp.send("HeadlessExperimental.enable");
		return { browser, context, page, cdp };
	} catch (error) {
		await browser.close().catch(() => {});
		throw error;
	}
}

/** One beginFrame probe: a data URL, a warm-up without display updates, then a screenshot. */
async function probeBeginFrame({ page, cdp }) {
	try {
		await page.goto(PROBE_HTML, { timeout: 15000 });
		await withTimeout(cdp.send("HeadlessExperimental.beginFrame", { frameTimeTicks: 0, interval: 1000 / 60, noDisplayUpdates: true }), 10000, "beginFrame GPU probe (warm-up)");
		const shot = await withTimeout(cdp.send("HeadlessExperimental.beginFrame", { frameTimeTicks: 1000 / 60, interval: 1000 / 60, screenshot: { format: "png" } }), 10000, "beginFrame GPU probe (screenshot)");
		return Boolean(shot?.screenshotData);
	} catch {
		return false;
	}
}

/**
 * Launches the captured browser. With `auto` it tries the GPU flags first and
 * falls back to software raster when the beginFrame probe does not answer.
 */
async function openCaptured(chromium, shell, options, log) {
	if (options.gpu === "off") return { session: await openSession(chromium, { ...options, shell, gpu: false }), gpu: false };
	log(`launching chrome-headless-shell with GPU flags (${options.gpu})`);
	const probed = await openSession(chromium, { ...options, shell, gpu: true });
	if (await probeBeginFrame(probed)) return { session: probed, gpu: true };
	if (options.gpu === "on") {
		await probed.browser.close().catch(() => {});
		throw new Error("beginFrame did not answer with the GPU flags (--gpu on). Try --gpu auto or --gpu off.");
	}
	log("GPU flags failed the beginFrame probe; using software raster");
	await probed.browser.close().catch(() => {});
	return { session: await openSession(chromium, { ...options, shell, gpu: false }), gpu: false };
}

async function loadFlow(file) {
	const module = await import(pathToFileURL(file).href).catch((error) => {
		throw new Error(`cannot load the flow module ${file}: ${error.message}`);
	});
	if (typeof module.default !== "function") throw new Error(`${file} must export default async function (wv) {}`);
	return module.default;
}

function writePoster(video, frame, poster) {
	const result = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", video, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", poster], { encoding: "utf8", timeout: 60000 });
	if (result.status !== 0) throw new Error(`could not write poster.png: ${(result.stderr || result.error?.message || "").trim()}`);
}

/** Below this share of new frames the capture is mostly the pump repeating one image. */
export const LOW_UNIQUE_SHARE = 0.05;
/** A pause between two actions longer than this is worth telling the agent about. */
export const LONG_ACTION_GAP_S = 10;

/**
 * The warnings `wv capture` prints when the capture itself went wrong: a host
 * too busy to give new frames, or a flow that idled for a long stretch. Pure, so
 * the thresholds are tested. `env` carries the load average and the core count
 * that the capture recorded.
 */
export function captureWarnings(capture, env = {}) {
	const warnings = [];
	const frames = capture?.frames ?? 0;
	const distinct = capture?.stats?.distinct;
	const load = Array.isArray(env.load) ? env.load : [];
	const cores = env.cores ?? availableParallelism();
	const host = load.length ? ` Host load ${load[0].toFixed(1)} on ${cores} cores.` : "";
	if (frames > 0 && typeof distinct === "number") {
		const share = distinct / frames;
		if (share < LOW_UNIQUE_SHARE) {
			warnings.push(
				`only ${Math.round(share * 100)} % of the ${frames} frames show a new image (${distinct} of ${frames}).${host} ` +
					`Either the page changed the screen only ${distinct} times, which is fine for a calm UI, or the host could not keep up and the pump repeated the last image. The smoothness gate tells the two apart. ` +
					"Fix: close other work on the host; use --gpu on for a canvas or WebGL view; capture a 16:9 --width 1024 --scale 2 when the zoom allows. The edit compresses this idle time, but a slow capture also costs smoothness.",
			);
		}
	}
	const events = Array.isArray(capture?.events) ? capture.events : [];
	for (let i = 1; i < events.length; i++) {
		const prev = events[i - 1];
		const next = events[i];
		const gapFrames = (next.startFrame ?? 0) - (prev.settleFrame ?? prev.endFrame ?? 0);
		const gapS = gapFrames / (capture.fps || 60);
		if (gapS <= LONG_ACTION_GAP_S) continue;
		warnings.push(`the flow did nothing for ${gapS.toFixed(1)} s between ${prev.id} and ${next.id} (capture frames ${prev.settleFrame ?? prev.endFrame} to ${next.startFrame}).${host} Fix: shorten the idle time, or give the idle screen a wv.say line and a shot of its own.`);
	}
	return warnings;
}

/** The largest canvas on the page, or null. The slowest captures are canvas or WebGL views. */
async function describeCanvas(page) {
	try {
		return await page.evaluate(() => {
			const list = [...document.querySelectorAll("canvas")];
			if (list.length === 0) return null;
			const biggest = list.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
			let webgl = false;
			try {
				webgl = Boolean(biggest.getContext("webgl2") || biggest.getContext("webgl"));
			} catch {
				webgl = false;
			}
			return { count: list.length, width: biggest.width, height: biggest.height, webgl };
		});
	} catch {
		return null;
	}
}

/** The files a capture publishes. A capture writes them to a staging folder first. */
export const ARTIFACTS = ["capture.mp4", "events.json", "poster.png"];

/**
 * The staging folder beside --out. A capture that fails at a flow step writes
 * nothing into --out, so the last good capture stays intact.
 */
export function stagingDir(outDir) {
	return `${outDir}.tmp-${process.pid}`;
}

/** Moves the staged artifacts over the old ones, then removes the staging folder. */
export function publishArtifacts(staging, outDir, artifacts = ARTIFACTS) {
	mkdirSync(outDir, { recursive: true });
	for (const name of artifacts) renameSync(join(staging, name), join(outDir, name));
	rmSync(staging, { recursive: true, force: true });
}

/** Frame count from ffprobe; null when ffprobe is not installed. */
function probeFrameCount(video) {
	const result = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", video], { encoding: "utf8", timeout: 60000 });
	if (result.error) return null;
	const count = Number.parseInt(result.stdout.trim(), 10);
	return Number.isFinite(count) ? count : null;
}

/** events.json, the frame-count self check and poster.png. */
function writeArtifacts({ outDir, fps, scale, width, height, gpu, clock, pump, created, load, canvas, log }) {
	const videoPath = join(outDir, "capture.mp4");
	const eventsPath = join(outDir, "events.json");
	const posterPath = join(outDir, "poster.png");
	const stats = pump.stats();
	const frames = stats.frames;
	writeFileSync(
		eventsPath,
		`${JSON.stringify(
			{
				version: 1,
				fps,
				viewport: { width, height, scale },
				video: "capture.mp4",
				// virtual: app time is frame time (one frame of app time per frame); real: wall-clock slots.
				clock,
				frames,
				stats: {
					unique: stats.unique,
					repeated: stats.repeated,
					maxLagMs: stats.maxLagMs,
					gpu,
					distinct: stats.distinct,
					frameMs: stats.frameMs,
					load: load.map((value) => Math.round(value * 100) / 100),
					cores: availableParallelism(),
					canvas,
				},
				stills: stats.stills,
				cursor: created.cursor,
				events: created.events,
				cues: created.cues,
				// The app's text after each settle, for the text floor on a film's clips (wv check --page).
				texts: created.texts ?? [],
			},
			null,
			2,
		)}\n`,
	);

	const actual = probeFrameCount(videoPath);
	if (actual !== null && actual !== frames) throw new Error(`capture.mp4 has ${actual} frames but events.json says ${frames}; the frame pump and ffmpeg disagree`);

	const firstSettled = created.events.find((event) => event.settleFrame !== undefined) ?? null;
	const posterFrame = Math.min(frames - 1, Math.max(0, firstSettled ? firstSettled.settleFrame : 0));
	writePoster(videoPath, posterFrame, posterPath);
	const stillFrames = stats.stills.reduce((sum, [from, to]) => sum + (to - from + 1), 0);
	log(`${frames} frames (${stats.distinct} distinct, ${stillFrames} repeated, max lag ${stats.maxLagMs} ms, frame draw p50 ${stats.frameMs.p50} ms), ${created.events.length} events, ${created.cues.length} cues`);
	log(`host load ${load.map((value) => value.toFixed(2)).join(" ")} on ${availableParallelism()} cores${canvas ? `, canvas ${canvas.width}x${canvas.height}${canvas.webgl ? " (WebGL)" : ""}` : ""}`);
	return { out: outDir, frames, stats, events: created.events, cues: created.cues, gpu, posterFrame, video: videoPath, eventsFile: eventsPath, poster: posterPath };
}

/**
 * The pump's hook after each frame: with textEvery (ms of app time), a text
 * sample every N frames, so a HUD value has a time series and not only the
 * samples after each settled step.
 */
export function frameHook({ textEvery = 0, fps, sample, texts, log = null, now = () => performance.now(), progressMs = 10000, cost = null }) {
	const every = textEvery > 0 ? Math.max(1, Math.round((textEvery * fps) / 1000)) : 0;
	// A slow page (WebGL in software) takes seconds a frame: say where the capture is.
	let lastWall = now();
	let lastFrame = -1;
	return async (frame) => {
		const wall = now();
		if (log && wall - lastWall >= progressMs) {
			const perFrame = cost ? cost() : (wall - lastWall) / 1000 / Math.max(1, frame - lastFrame);
			log(`frame ${frame} (${(frame / fps).toFixed(2)} s of app time), ${perFrame.toFixed(2)} s a frame`);
			lastWall = wall;
			lastFrame = frame;
		}
		if (!every || frame % every !== 0) return;
		const items = await sample(frame).catch(() => null);
		if (items) texts.push({ f: frame, items });
	};
}

/** ffmpeg arguments for the draft's contact sheet: a frame every half second (at most 48 cells), with its time, 6 across. */
export function draftSheetArgs({ video, out, seconds, maxCells = 48 }) {
	const rate = Math.min(2, Math.floor((maxCells / Math.max(seconds, 0.5)) * 1e4) / 1e4);
	const cells = Math.max(1, Math.min(maxCells, Math.ceil(seconds * rate)));
	const rows = Math.ceil(cells / 6);
	return ["-v", "error", "-y", "-i", video, "-vf", `fps=${rate},scale=480:-2,drawtext=text='%{pts\\:hms}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6,tile=6x${rows}:padding=4:margin=4`, "-frames:v", "1", out];
}

/** The settle samples and the interval samples in frame order; a settle sample wins on the same frame. */
export function mergeTexts(settled, interval) {
	const byFrame = new Map();
	for (const snap of interval) byFrame.set(snap.f, snap);
	for (const snap of settled) byFrame.set(snap.f, snap);
	return [...byFrame.values()].sort((a, b) => a.f - b.f);
}

export async function capture(options) {
	const { fps, scale, width, height, crf } = options;
	const log = options.log ?? (() => {});
	const outDir = resolve(options.out);
	const staging = stagingDir(outDir);
	const videoPath = join(staging, "capture.mp4");
	const eventsPath = join(staging, "events.json");
	const posterPath = join(staging, "poster.png");

	const flow = await loadFlow(resolve(options.flow));
	if (!hasFfmpeg()) throw new Error("ffmpeg is not on PATH. Install it with your package manager (pacman -S ffmpeg), then run wv capture again.");
	const { chromium } = await loadPlaywright();
	const shell = headlessShellPath(chromium);
	if (!shell) throw new Error("chrome-headless-shell is not installed for playwright-core. Run 'wv setup', then try again.");

	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	let session = null;
	let pump = null;
	let created = null;
	let failure = null;
	// A signal runs no finally: the staging folder and the browser must go anyway.
	const cleanups = [
		onSignalCleanup(() => {
			rmSync(staging, { recursive: true, force: true });
		}),
		onSignalCleanup(async () => {
			// No catch: the shutdown runner reports the error or the timeout with the cleanup name.
			await withTimeout(session?.browser.close() ?? Promise.resolve(), 5000, "the browser");
		}, "the browser"),
	];

	try {
		const opened = await openCaptured(chromium, shell, { width, height, scale, gpu: options.gpu }, log);
		session = opened.session;
		log(`capturing ${width}x${height} at scale ${scale}, ${fps} fps, GPU ${opened.gpu ? "on" : "off"}, ${options.clock ?? "virtual"} clock`);
		await session.page.goto("about:blank");
		const clock = options.clock ?? "virtual";
		// The clock goes in first, so any document, and any wv script that reads time, gets app time.
		// The install script carries the capture time at which the next document starts; the
		// controller replaces it after every advance, so a document that the app opens itself
		// also starts at the last advance time.
		const epoch = Date.now();
		/** Replaces the clock install script with the current capture time. */
		let pumpFresh = null;
		// The Page domain must be enabled, or a new document ignores the script.
		await session.cdp.send("Page.enable");
		const clockScripts = createClockScripts({ send: (method, params) => session.cdp.send(method, params), source: (ms) => virtualClockScript(epoch, ms), log });
		if (clock === "virtual") await clockScripts.replace(0);
		const beforeNavigate = async () => {
			// A capture on the real clock installs no clock script, so its documents keep real time.
			if (clock !== "virtual") return;
			await clockScripts.replace(Math.max(0, (pump.frame() + 1) * pump.dt));
		};
		pumpFresh = (t) => (clock === "virtual" ? clockScripts.replace(t) : Promise.resolve());
		await installInstrument(session.page);

		pump = new FramePump({ cdp: session.cdp, fps, output: videoPath, crf, clock });
		pump.onAdvance = pumpFresh;
		const intervalTexts = [];
		pump.onFrame = frameHook({ textEvery: options.textEvery ?? 0, fps, sample: () => textsOf(session.page), texts: intervalTexts, log, cost: () => {
			// The draw time of the last frames: under the real clock a slot is always 1/fps.
			const recent = pump.frameMs.slice(-30).sort((a, b) => a - b);
			return recent.length ? recent[Math.floor(recent.length / 2)] / 1000 : 0;
		} });
		await pump.seed();
		pump.start();

		created = createFlowApi({
			page: session.page,
			pump,
			fps,
			viewport: { width, height },
			dir: outDir,
			beforeNavigate,
			log,
			launchSecondary: async () => {
				const full = chromiumPath(chromium);
				if (!full) throw new Error("the full chromium browser is not installed; run 'wv setup'");
				const secondary = await launchBrowser(chromium, { executablePath: full });
				// Registered here, not by the flow: a signal must close it even when the flow never
				// returns. The registration goes away when the flow closes the browser normally.
				return trackUntilClosed(secondary);
			},
		});

		await flow(created.api);
		// The load average during the capture, not idle before it: a busy host is the first cause of
		// repeated frames, and the agent needs it in the same output as the frame counts.
		const load = loadavg();
		const canvas = await describeCanvas(session.page);
		// Let the last settle show for a few frames before the last slot is written.
		await sleep(Math.max(400, (8 * 1000) / fps));
		await pump.stop();
		created.texts = mergeTexts(created.texts ?? [], intervalTexts);
		const written = writeArtifacts({ outDir: staging, fps, scale, width, height, gpu: opened.gpu, clock: options.clock ?? "virtual", pump, created, load, canvas, log });
		if (options.draft) {
			// The draft is for the eye: one sheet of the whole take, before the frame-exact capture.
			const r = await run("ffmpeg", draftSheetArgs({ video: videoPath, out: join(staging, "sheet.jpg"), seconds: written.frames / fps }), { timeoutMs: 120_000 });
			if (r.code === 0) log(`draft sheet: ${join(outDir, "sheet.jpg")}`);
			else log(`draft sheet failed: ${r.timedOut ? "ffmpeg did not finish in 2 min" : (r.stderr || "").trim().split("\n").slice(-1).join(" ")}`);
		}
		publishArtifacts(staging, outDir, existsSync(join(staging, "sheet.jpg")) ? [...ARTIFACTS, "sheet.jpg"] : ARTIFACTS);
		const warnings = captureWarnings(
			{ version: 1, fps, frames: written.frames, stats: { distinct: written.stats.distinct }, events: created.events },
			{ load, cores: availableParallelism() },
		);
		return {
			...written,
			out: outDir,
			video: join(outDir, "capture.mp4"),
			eventsFile: join(outDir, "events.json"),
			poster: join(outDir, "poster.png"),
			load,
			warnings,
		};
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		for (const drop of cleanups) drop();
		await created?.api.close().catch(() => {});
		await pump?.stop().catch(() => {});
		await session?.browser.close().catch(() => {});
		if (failure) {
			rmSync(staging, { recursive: true, force: true });
			log(`capture failed; the last good capture in ${outDir} is untouched`);
		}
	}
}
