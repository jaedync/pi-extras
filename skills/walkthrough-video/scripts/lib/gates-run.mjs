/**
 * `wv gates`: the gates of the design, with the ones that touch the world here
 * (the ffmpeg luma scan for blank frames, the Chromium camera read, the
 * HyperFrames check). Gate math is pure and lives in gates.mjs.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cameraScaleTimes, gateBlankFrame, gateCameraChurn, gateCameraScale, gateCaptionClear, gateCursorOnTarget, gateDeadStretch, gateFocusInSafe, gateNoUpscale, gateSmoothness, gateTextReadable, gateVoiceFits } from "./gates.mjs";
import { hyperframesBin, hyperframesMissing } from "./paths.mjs";
import { requireProjectGsap } from "./gsap.mjs";
import { HYPERFRAMES_ENV, pathWithNode, run } from "./proc.mjs";
import { launchBrowser, trackBrowser } from "./browser.mjs";
import { chromiumPath, loadPlaywright } from "./runtime.mjs";
import { describeProblems, validateEvents, validatePlan } from "./schema.mjs";
import { planFingerprint, planHashInHtml } from "./fingerprint.mjs";

function readJson(file, what) {
	if (!existsSync(file)) throw new Error(`cannot find ${file}. ${what}`);
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`${file} is not JSON: ${error.message}`);
	}
}

/** The ffmpeg command for gate 5. -ss before -i: it seeks the input, not the filter output. */
export function blankScanArgs({ video, start, span, rate = 10 }) {
	return ["-v", "error", "-ss", start.toFixed(4), "-i", video, "-t", span.toFixed(4), "-an", "-vf", `fps=${rate},signalstats,metadata=print:file=-`, "-f", "null", "-"];
}

/**
 * Samples luma min and max at `rate` frames per second over the kept capture
 * range. A near-uniform frame has a tiny range (gate 5).
 */
export async function scanBlankSamples(video, plan, { rate = 10, ffmpeg = "ffmpeg" } = {}) {
	const clips = plan.clips ?? [];
	if (clips.length === 0) return [];
	const from = Math.min(...clips.map((clip) => clip.from));
	const to = Math.max(...clips.map((clip) => clip.to));
	const start = from / plan.fps;
	const span = (to - from + 1) / plan.fps;
	// After -i, -ss would cut the output of the filter graph, so the metadata filter
	// would print the frames from the start of the file instead.
	const args = blankScanArgs({ video, start, span, rate });
	const result = await run(ffmpeg, args, { timeoutMs: 10 * 60_000 });
	if (result.code !== 0) throw new Error(`ffmpeg could not scan ${video}: ${(result.stderr || result.stdout).trim().split("\n").slice(-2).join(" ")}`);
	return parseSignalStats(result.stdout, start);
}

/**
 * Reads `fps=N,signalstats,metadata=print:file=-` output:
 *   frame:12 pts:... pts_time:1.2   then lavfi.signalstats.YMIN=.. YMAX=..
 * Returns [{t, ymin, ymax}] with t in capture seconds.
 */
export function parseSignalStats(text, startSeconds = 0) {
	const samples = [];
	let current = null;
	for (const line of String(text).split("\n")) {
		const frameLine = line.match(/^frame:\d+.*pts_time:([\d.]+)/);
		if (frameLine) {
			current = { t: startSeconds + Number(frameLine[1]), ymin: null, ymax: null };
			samples.push(current);
			continue;
		}
		const value = line.match(/^lavfi\.signalstats\.(YMIN|YMAX)=([\d.]+)/);
		if (value && current) current[value[1] === "YMIN" ? "ymin" : "ymax"] = Number(value[2]);
	}
	return samples.filter((sample) => Number.isFinite(sample.ymin) && Number.isFinite(sample.ymax));
}

function firstIssues(parsed) {
	const list = [parsed?.issues, parsed?.problems, parsed?.errors].find(Array.isArray);
	if (!list || list.length === 0) return undefined;
	return list.slice(0, 3).map((item) => (typeof item === "string" ? item : item?.message ?? item?.rule ?? JSON.stringify(item))).join("; ");
}

/** Gate 8: hyperframes check on the project, unless it has no index.html. */
async function hyperframesGate(project) {
	if (!existsSync(join(project, "index.html"))) return { id: "hyperframes_check", status: "skip", detail: "no index.html in the project", fix: null };
	// No package-runner fallback: it installed unpinned packages at gate time.
	const bin = hyperframesBin();
	if (!bin) return { id: "hyperframes_check", status: "fail", detail: hyperframesMissing(), fix: "Run wv setup, then run wv gates again." };
	let result;
	try {
		result = await run(bin, ["check", "--json"], { cwd: project, env: { ...process.env, ...HYPERFRAMES_ENV, PATH: pathWithNode() }, timeoutMs: 10 * 60_000 });
	} catch (error) {
		return { id: "hyperframes_check", status: "fail", detail: `could not run hyperframes: ${error.message}`, fix: "Run wv setup, then run wv gates again." };
	}
	let parsed = null;
	const start = result.stdout.indexOf("{");
	if (start >= 0) {
		try {
			parsed = JSON.parse(result.stdout.slice(start, result.stdout.lastIndexOf("}") + 1));
		} catch {
			parsed = null;
		}
	}
	const codeOk = result.code === 0;
	const jsonOk = parsed?.ok !== false && !(Array.isArray(parsed?.errors) && parsed.errors.length > 0);
	if (codeOk && jsonOk) return { id: "hyperframes_check", status: "pass", detail: parsed?.summary ?? "hyperframes check passed", fix: null };
	const reason = firstIssues(parsed) ?? (result.stderr || result.stdout).trim().split("\n").slice(-2).join(" ") ?? `exit code ${result.code}`;
	return { id: "hyperframes_check", status: "fail", detail: `hyperframes check failed: ${reason}`, fix: "Fix the issues that hyperframes check reports, then run wv gates again." };
}

/**
 * Why the project's index.html is not the one this plan.json belongs to, or
 * null when they match (or there is no index.html yet). Pure.
 */
export function checkProjectMatchesPlan(plan, html) {
	if (html === null || html === undefined) return null;
	const found = planHashInHtml(html);
	if (found === planFingerprint(plan)) return null;
	return found
		? `index.html was built from another plan (fingerprint ${found}, plan.json is ${planFingerprint(plan)}). Run 'wv compose' again, then render and gate the new project.`
		: "index.html has no plan fingerprint, so it may belong to another plan. Run 'wv compose' again before you render or gate it.";
}

/**
 * Reads the zoom that the composition on disk really applies: loads index.html in
 * Chromium, seeks the GSAP timeline to each time, and reads the scale of #cam.
 * Gate 11 compares that with plan.json, so a camera key that never reaches the
 * screen fails in seconds instead of after a two minute render.
 */
export async function cameraScaleSamples(projectDir, plan) {
	const { chromium } = await loadPlaywright();
	const executablePath = chromiumPath(chromium);
	if (!executablePath) return { error: "the full chromium browser is not installed" };
	let browser = null;
	let untrack = () => {};
	try {
		browser = await launchBrowser(chromium, { executablePath, args: ["--autoplay-policy=no-user-gesture-required"] });
		untrack = trackBrowser(browser);
		const page = await browser.newPage({ viewport: { width: plan.output.width, height: plan.output.height }, deviceScaleFactor: 1 });
		// HyperFrames defines this global before the composition script runs; a bare browser does not.
		await page.addInitScript(() => {
			globalThis.__timelines ??= {};
		});
		await page.goto(pathToFileURL(join(projectDir, "index.html")).href, { waitUntil: "load", timeout: 30000 });
		await page.waitForFunction(() => Boolean(globalThis.__timelines?.main), undefined, { timeout: 20000 });
		const samples = [];
		for (const t of cameraScaleTimes(plan)) {
			const scale = await page.evaluate((time) => {
				const timeline = globalThis.__timelines.main;
				timeline.pause();
				timeline.seek(time, false);
				const transform = getComputedStyle(document.getElementById("cam")).transform;
				const match = /matrix\(([^)]+)\)/.exec(transform);
				return match ? Number(match[1].split(",")[0]) : null;
			}, t);
			if (Number.isFinite(scale) && scale > 0) samples.push({ t, scale });
		}
		return { samples };
	} catch (error) {
		return { error: String(error?.message ?? error).split("\n")[0] };
	} finally {
		untrack();
		await browser?.close().catch(() => {});
	}
}

export async function runGates({ project, capture, log = () => {} }) {
	const projectDir = resolve(project);
	const captureDir = resolve(capture);
	const plan = readJson(join(projectDir, "plan.json"), "Run 'wv compose' to write it");
	const events = readJson(join(captureDir, "events.json"), "Run 'wv capture' first.");

	const planCheck = validatePlan(plan);
	if (!planCheck.ok) throw new Error(`${join(projectDir, "plan.json")} does not match the design:\n  ${describeProblems(planCheck.problems)}`);
	const eventsCheck = validateEvents(events);
	if (!eventsCheck.ok) throw new Error(`${join(captureDir, "events.json")} does not match the design:\n  ${describeProblems(eventsCheck.problems)}`);

	const indexPath = join(projectDir, "index.html");
	if (existsSync(indexPath)) {
		// The page loads its own GSAP; without it the camera gate cannot read the composition.
		requireProjectGsap(projectDir);
		const stale = checkProjectMatchesPlan(plan, readFileSync(indexPath, "utf8"));
		if (stale) throw new Error(`${indexPath}: ${stale}`);
	}

	const gates = [];
	const timed = async (id, work) => {
		const started = performance.now();
		const gate = await work();
		gates.push({ id, ...gate, ms: Math.round(performance.now() - started) });
	};
	await timed("cursor_on_target", () => gateCursorOnTarget(plan, events));
	await timed("focus_in_safe", () => gateFocusInSafe(plan, events));
	await timed("no_upscale", () => gateNoUpscale(plan));
	await timed("text_readable", () => gateTextReadable(plan, events));
	await timed("blank_frame", async () => {
		const video = join(captureDir, events.video || "capture.mp4");
		if (!existsSync(video)) return { status: "fail", detail: `no video at ${video}`, fix: "Run wv capture again, into this directory." };
		try {
			return gateBlankFrame(plan, await scanBlankSamples(video, plan));
		} catch (error) {
			return { status: "fail", detail: error.message, fix: "Check that ffmpeg can read capture.mp4, then run wv gates again." };
		}
	});
	await timed("dead_stretch", () => gateDeadStretch(plan, events));
	await timed("camera_churn", () => gateCameraChurn(plan));
	await timed("voice_fits", () => gateVoiceFits(plan));
	await timed("caption_clear", () => gateCaptionClear(plan, events));
	await timed("smoothness", () => gateSmoothness(plan, events));
	await timed("camera_scale", async () => {
		if (!existsSync(join(projectDir, "index.html"))) return { status: "skip", detail: "no index.html in the project", fix: null };
		const read = await cameraScaleSamples(projectDir, plan);
		if (read.error) return { status: "fail", detail: `could not read the camera from index.html: ${read.error}`, fix: "Run 'wv setup' (chromium), then 'wv compose' again, and gate the new project." };
		return gateCameraScale(plan, read.samples);
	});
	await timed("hyperframes_check", () => hyperframesGate(projectDir));

	const ok = gates.every((gate) => gate.status !== "fail");
	for (const gate of gates) {
		log(`${gate.id.padEnd(20)} ${gate.status.toUpperCase().padEnd(5)} ${String(gate.ms).padStart(5)} ms  ${gate.detail}`);
		if (gate.status === "fail" && gate.fix) log(`  Fix: ${gate.fix}`);
	}
	return { ok, project: projectDir, capture: captureDir, gates };
}
