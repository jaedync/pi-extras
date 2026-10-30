/**
 * wv film: the page, the cue sheet and the contact-sheet times come from the
 * storyboard's whole-frame timing. The end-to-end build (esbuild, Chromium)
 * runs with WV_INTEGRATION=1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkClips, clipLengthAdvice, clipSrcProblem, cueSheet, timelineLengthError, filmHtml, findTsc, inlineBrandCss, main as filmMain, muxArgs, renderArgs, stillTimes } from "../skills/walkthrough-video/scripts/film/film.mjs";
import { normalizeStoryboard } from "../skills/walkthrough-video/scripts/film/storyboard.mjs";

const WV = fileURLToPath(new URL("../skills/walkthrough-video/scripts/wv.mjs", import.meta.url));
const SKILL_DIR = fileURLToPath(new URL("../skills/walkthrough-video/", import.meta.url));

const SB = {
	title: "Test <film>",
	fps: 60,
	bpm: 120,
	shots: [
		{ id: "a", scene: "claim", beats: 4, text: "Hi" },
		{ id: "b", scene: "footage", seconds: 1.5, clip: { src: "assets/cap.mp4", from: 2.25 } },
		{ id: "c", scene: "end", beats: 2 },
	],
	music: { liftAtShot: "c", db: -21, fadeIn: 0.3, fadeOut: 1.4 },
};

function timingOf(sb) {
	const n = normalizeStoryboard(sb);
	return { fps: n.fps, width: n.width, height: n.height, duration: n.duration, frames: n.frames, shots: n.shots.map(({ id, start, end, startFrame, endFrame }) => ({ id, start, end, startFrame, endFrame })) };
}

test("the page has one composition, a section per shot and the clip on its shot's frames", () => {
	const timing = timingOf(SB);
	const html = filmHtml({ storyboard: SB, timing, tokens: {}, bundle: "/*bundle*/", brandCss: ":root{--x:1}" });
	assert.match(html, /data-composition-id="main" data-fps="60" data-start="0" data-duration="4.5" data-width="1920" data-height="1080"/);
	assert.equal((html.match(/<section class="shot"/g) ?? []).length, 3);
	assert.match(html, /<section class="shot" id="b" data-scene="footage"><div class="cam">\s*<video id="clip-b" class="clip" src="assets\/cap.mp4" muted playsinline data-start="2" data-duration="1.5" data-media-start="2.25" data-track-index="1"><\/video>/);
	assert.match(html, /<title>Test &lt;film&gt;<\/title>/);
	assert.match(html, /<style id="brand">\n:root\{--x:1\}/);
	const data = JSON.parse(html.match(/<script id="film-data" type="application\/json">(.*)<\/script>/)[1]);
	assert.equal(data.timing.shots[1].startFrame, 120);
	assert.doesNotMatch(html, /app\.css/);
	assert.match(filmHtml({ storyboard: SB, timing, tokens: {}, bundle: "", appCss: true }), /href="brand\/app.css"/);
});

test("film data cannot close its script element", () => {
	const sb = { ...SB, title: "</script><script>alert(1)</script>" };
	const html = filmHtml({ storyboard: sb, timing: timingOf(sb), tokens: {}, bundle: "" });
	assert.equal((html.match(/<\/script>/g) ?? []).length, 3, "gsap, film-data and the bundle only");
});

test("brand.css inlines with its font files under brand/", () => {
	const css = "@font-face { src: url('fonts/k.woff2') format('woff2'); } .a { background: url(data:image/svg+xml,x); } .b { background: url(\"https://x/y.png\"); }";
	const out = inlineBrandCss(css);
	assert.match(out, /url\('brand\/fonts\/k\.woff2'\)/);
	assert.match(out, /url\(data:image\/svg\+xml,x\)/);
	assert.match(out, /url\("https:\/\/x\/y\.png"\)/);
});

test("the cue sheet carries the cues and back-times the music to the lift shot", () => {
	const timing = timingOf(SB);
	const sheet = cueSheet(SB, timing, [{ sound: "land", t: 0.5, shot: "a", peak: -17 }, { sound: "key", t: 2.1, shot: "b" }]);
	assert.equal(sheet.duration, 4.5);
	assert.deepEqual(sheet.cues, [{ t: 0.5, sound: "land", peak: -17, shot: "a" }, { t: 2.1, sound: "key", peak: -18, shot: "b" }]);
	assert.deepEqual(sheet.music, { liftAt: 3.5, underCuesDb: -21, fadeIn: 0.3, fadeOut: 1.4, bpm: 120 });
	assert.throws(() => cueSheet({ ...SB, music: { liftAtShot: "zz" } }, timing, []), /liftAtShot is "zz"/);
});

test("contact-sheet times: the frame before each cut, the cut, each shot's middle and the last frame", () => {
	const times = stillTimes(timingOf(SB));
	assert.deepEqual(times, [1, 1.9833, 2, 2.75, 3.4833, 3.5, 4, 4.4833]);
});

test("the master renders with one capture worker, so a slow drift moves on every frame", () => {
	const args = renderArgs({ fps: 60, quality: "delivery", out: "/o/film.mp4" });
	assert.equal(args[args.indexOf("--workers") + 1], "1");
	const fast = renderArgs({ fps: 60, quality: "delivery", out: "/o/film.mp4", workers: "auto" });
	assert.equal(fast[fast.indexOf("--workers") + 1], "auto");
	assert.equal(args.at(-1), "/o/film.mp4");
	assert.ok(renderArgs({ fps: 60, quality: "delivery", out: "x", cacheDir: "/c" }).includes("/c"));
});

test("mux copies the picture and cuts the sound to it", () => {
	const args = muxArgs({ video: "v.mp4", audio: "m.wav", out: "o.mp4" });
	assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2), ["-c:v", "copy"]);
	assert.ok(args.includes("-shortest"));
	assert.equal(args.at(-1), "o.mp4");
});

const skipNoFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 ? false : "ffmpeg is not installed";

test("wv film mux refuses a master that is shorter than the picture, and names both lengths", { skip: skipNoFfmpeg, timeout: 120000 }, () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-mux-"));
	mkdirSync(join(dir, "out"), { recursive: true });
	const video = join(dir, "out", "film.mp4");
	const audio = join(dir, "master.wav");
	const long = join(dir, "long.wav");
	assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]).status, 0);
	assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "48000", audio]).status, 0);
	assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "48000", long]).status, 0);
	let r = spawnSync(process.execPath, [WV, "film", "mux", dir, "--audio", audio], { encoding: "utf8" });
	assert.equal(r.status, 1, `a short master must refuse: ${r.stdout}`);
	assert.match(r.stderr, /1\.0\d s/);
	assert.match(r.stderr, /2\.0\d s/);
	assert.match(r.stderr, /wv sound mix/);
	assert.equal(existsSync(join(dir, "out", "film-sound.mp4")), false, "no truncated film is written");
	// A master that is longer than the picture is cut to the picture, as before.
	r = spawnSync(process.execPath, [WV, "film", "mux", dir, "--audio", long], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(join(dir, "out", "film-sound.mp4")), true);
});

test("a film render that fails deletes its own cache folder and nothing else", async () => {
	const home = mkdtempSync(join(tmpdir(), "wv-film-home-"));
	const base = mkdtempSync(join(tmpdir(), "wv-film-cache-"));
	mkdirSync(join(base, "other-agent-work"));
	const project = mkdtempSync(join(tmpdir(), "wv-film-proj-"));
	mkdirSync(join(project, "out"), { recursive: true });
	writeFileSync(join(project, "out", "film.json"), JSON.stringify({ timing: { fps: 30, shots: [{ id: "a", start: 0, end: 1 }] }, shots: [{}] }));
	// A stand-in for the pinned HyperFrames: it writes into the folder it is given, then fails.
	const bin = join(home, "pi-walkthrough-video", "node_modules", ".bin", "hyperframes");
	mkdirSync(join(home, "pi-walkthrough-video", "node_modules", ".bin"), { recursive: true });
	writeFileSync(bin, '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--frames-cache-dir" ]; then mkdir -p "$2"; : > "$2/frame.png"; fi\n  shift\ndone\nexit 1\n');
	chmodSync(bin, 0o755);
	const saved = { ...process.env };
	Object.assign(process.env, { XDG_CACHE_HOME: home, HYPERFRAMES_EXTRACT_CACHE_DIR: base, TMPDIR: base });
	try {
		await assert.rejects(() => filmMain(["render", project]), /hyperframes render failed/);
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	}
	assert.deepEqual(readdirSync(base), ["other-agent-work"], "the failed render left no cache folder and deleted no other work");
});

const skip = process.env.WV_INTEGRATION === "1" ? false : "set WV_INTEGRATION=1 to build the template in a browser";

test("wv film new and build: the template bundles, type-checks and gives its cues", { skip, timeout: 120000 }, () => {
	const work = mkdtempSync(join(tmpdir(), "wv-film-"));
	try {
		const dir = join(work, "film");
		let r = spawnSync(process.execPath, [WV, "film", "new", dir], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		r = spawnSync(process.execPath, [WV, "film", "build", dir], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.doesNotMatch(r.stderr, /type check is skipped/);
		const film = JSON.parse(readFileSync(join(dir, "out", "film.json"), "utf8"));
		assert.equal(film.timing.duration, 9);
		assert.deepEqual(film.cues.map((c) => [c.sound, c.t]), [["land", 2.25], ["land", 2.55], ["land", 2.85]]);
		assert.ok(existsSync(join(dir, "out", "kit", "gsap.min.js")));
		const cues = JSON.parse(readFileSync(join(dir, "out", "cues.json"), "utf8"));
		assert.equal(cues.music.liftAt, 6);
		// A type error stops the build.
		const bad = join(dir, "scenes", "claim.ts");
		const src = readFileSync(bad, "utf8");
		spawnSync("sh", ["-c", `printf '%s' "$1" > "$2"`, "_", src.replace("String(ctx.shot.text", "Number(ctx.shot.text").replace("wordsHost.textContent = text;", "wordsHost.textContent = text;\nconst n: string = 5;\nvoid n;"), bad]);
		r = spawnSync(process.execPath, [WV, "film", "build", dir], { encoding: "utf8" });
		assert.equal(r.status, 1);
		assert.match(r.stderr, /does not type-check/);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});

test("the film type check uses the runtime's TypeScript first, then a dev checkout", () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-tsc-"));
	try {
		const runtime = join(dir, "typescript");
		mkdirSync(join(runtime, "bin"), { recursive: true });
		writeFileSync(join(runtime, "package.json"), JSON.stringify({ bin: { tsc: "./bin/tsc" } }));
		assert.equal(findTsc([runtime]), null, "a bin that does not exist is not a tsc");
		writeFileSync(join(runtime, "bin", "tsc"), "");
		assert.equal(findTsc([runtime, null]), join(runtime, "bin", "tsc"));
		assert.equal(findTsc([join(dir, "missing")]), null);
		assert.match(String(findTsc([join(dir, "missing"), null])), /typescript[\\/]bin[\\/]tsc$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the drift ease leaves the cut fast and keeps a floor speed to the end, so its tail is not a freeze", async () => {
	const { driftOut } = await import("../skills/walkthrough-video/templates/film/kit/ease.ts");
	const f = driftOut(0.4);
	assert.equal(f(0), 0);
	assert.equal(f(1), 1);
	const slope = (x) => (f(Math.min(1, x + 1e-4)) - f(Math.max(0, x - 1e-4))) / (Math.min(1, x + 1e-4) - Math.max(0, x - 1e-4));
	assert.ok(slope(0) >= 1.5, `start slope ${slope(0)}`);
	assert.ok(Math.abs(slope(1) - 0.4) < 0.01, `end slope ${slope(1)}`);
	for (let x = 0; x < 1; x += 0.05) assert.ok(f(x + 0.05) > f(x));
	const motion = readFileSync(new URL("../skills/walkthrough-video/templates/film/kit/motion.ts", import.meta.url), "utf8");
	assert.match(motion, /opts\.ease \?\? ctx\.ease\.drift/);
});

test("a film render runs with the node that runs wv on PATH and names a timeout as a timeout", async () => {
	const { filmRenderEnv, hyperframesFailure } = await import("../skills/walkthrough-video/scripts/film/film.mjs");
	const env = filmRenderEnv({ PATH: "/usr/bin", HOME: "/home/x" });
	assert.equal(env.PATH.split(":").at(-1), "/usr/bin", "the old PATH stays behind node");
	assert.equal(env.HOME, "/home/x");
	assert.equal(env.PATH.split(":")[0], dirname(process.execPath), "the Node that runs wv comes first");
	assert.equal(hyperframesFailure({ code: null, timedOut: true, stdout: "", stderr: "[INFO] x" }, "render"), "hyperframes render timed out after 60 min: [INFO] x");
	assert.equal(hyperframesFailure({ code: 2, stdout: "boom line", stderr: "" }, "render"), "hyperframes render failed (exit 2): boom line");
});

test("a failed packet leaves no half-written folder, and two shot ids never share a frame file", async () => {
	const { withWorkFolder, uniqueNames } = await import("../skills/walkthrough-video/scripts/film/critique.mjs");
	const dir = join(mkdtempSync(join(tmpdir(), "wv-critique-")), "critique-1");
	try {
		await assert.rejects(() => withWorkFolder(dir, async (_dir, work) => {
			writeFileSync(join(work, "half.png"), "x");
			throw new Error("ffmpeg failed");
		}), /ffmpeg failed/);
		assert.equal(existsSync(dir), false, "the partial packet is removed");
		const kept = await withWorkFolder(dir, async (out) => {
			writeFileSync(join(out, "brief.md"), "ok");
			return "done";
		});
		assert.equal(kept, "done");
		assert.equal(existsSync(join(dir, ".work")), false);
		assert.equal(existsSync(join(dir, "brief.md")), true);
	} finally {
		rmSync(dirname(dir), { recursive: true, force: true });
	}
	const names = uniqueNames(["shot 1", "shot_1", "shot/1", "intro"]);
	assert.deepEqual([...names.values()], ["shot_1", "shot_1-2", "shot_1-3", "intro"]);
	// The plan packet writes its clip sheets with those names, not with safe(id) again.
	const source = readFileSync(join(SKILL_DIR, "scripts/film/critique.mjs"), "utf8");
	assert.match(source, /names\.get\(timing\.id\)/, "the plan clip sheet uses the unique name");
	assert.doesNotMatch(source, /clips", `\$\{safe\(timing\.id\)\}/, "no clip sheet is named with the colliding name");
});

test("a product scene escapes the storyboard text it puts into the page", async () => {
	const { esc } = await import("../skills/walkthrough-video/templates/film/kit/escape.ts");
	assert.equal(esc('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
	assert.equal(esc("Rows & <b>bold</b>"), "Rows &amp; &lt;b&gt;bold&lt;/b&gt;");
	assert.equal(esc(undefined), "");
	const source = readFileSync(join(SKILL_DIR, "templates/film/scenes/product.ts"), "utf8");
	assert.match(source, /esc\(ctx\.shot\.title\)/, "the title is escaped");
	assert.match(source, /esc\(r\)/, "each row is escaped");
});

test("stills refuse a --cols that is not a whole number of columns", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-cols-"));
	try {
		for (const bad of ["abc", "0", "2.5", "40"]) await assert.rejects(() => filmMain(["stills", dir, "--cols", bad]), /--cols/, `--cols ${bad}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a clip path must sit inside assets/, because the page loads it from out/", () => {
	assert.equal(clipSrcProblem("assets/create.mp4"), null);
	assert.match(clipSrcProblem("clips/x.mp4"), /outside assets/);
	assert.match(clipSrcProblem("../x.mp4"), /not a path inside assets/);
	assert.match(clipSrcProblem("/tmp/x.mp4"), /not a path inside assets/);
	assert.match(clipSrcProblem("http://localhost:3000/x.mp4"), /not a path inside assets/);
});

test("a clip path is checked where the page loads it: out/, after the copy", () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-clip-out-"));
	try {
		mkdirSync(join(dir, "assets"), { recursive: true });
		mkdirSync(join(dir, "out", "assets"), { recursive: true });
		writeFileSync(join(dir, "assets", "here.mp4"), "");
		const norm = normalizeStoryboard({ fps: 30, shots: [{ id: "a", seconds: 1, clip: { src: "assets/here.mp4" } }] });
		// In the project but not in the built page: the render would show black, so the build refuses it.
		assert.throws(() => checkClips(join(dir, "out"), norm), /assets\/here\.mp4 is not in/);
		writeFileSync(join(dir, "out", "assets", "here.mp4"), "");
		assert.doesNotThrow(() => checkClips(join(dir, "out"), norm));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a clip shorter than the part its shot shows gets advice that names both lengths", () => {
	const norm = normalizeStoryboard({ fps: 30, shots: [{ id: "a", seconds: 3, clip: { src: "assets/cap.mp4", from: 2 } }] });
	const short = clipLengthAdvice(norm, () => ({ duration: 2.5, fps: 60 }));
	assert.equal(short.length, 1);
	assert.equal(short[0].kind, "clip_short");
	assert.match(short[0].message, /"a"/);
	assert.match(short[0].message, /3\.00 s from 2\.00 s/);
	assert.match(short[0].message, /2\.50 s/);
	assert.deepEqual(clipLengthAdvice(norm, () => ({ duration: 5.2, fps: 60 })), [], "a clip that covers the part is fine");
	assert.deepEqual(clipLengthAdvice(norm, () => null), [], "an unreadable clip is not this advice");
});

test("build refuses a storyboard whose clip file does not exist", () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-clips-"));
	try {
		mkdirSync(join(dir, "assets"));
		writeFileSync(join(dir, "assets", "here.mp4"), "");
		const norm = normalizeStoryboard({ fps: 30, shots: [{ id: "a", seconds: 1, clip: { src: "assets/here.mp4" } }, { id: "b", seconds: 1, clip: { src: "assets/gone.mp4" } }] });
		assert.throws(() => checkClips(dir, norm), /shot "b".*assets\/gone\.mp4.*is not in/);
		assert.doesNotThrow(() => checkClips(dir, normalizeStoryboard({ fps: 30, shots: [{ id: "a", seconds: 1, clip: { src: "assets/here.mp4" } }] })));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an entrance that starts before the film's 0 s plays from part way in: the film keeps its length, and frame 0 already moves", async () => {
	const gsapFile = join(process.env.HOME, ".cache", "pi-walkthrough-video", "node_modules", "gsap", "dist", "gsap.js");
	if (!existsSync(gsapFile)) return;
	const { createRequire } = await import("node:module");
	globalThis.gsap = createRequire(import.meta.url)(gsapFile).gsap;
	const { drift, pop, riseWords, LEAD } = await import("../skills/walkthrough-video/templates/film/kit/motion.ts");
	const tl = globalThis.gsap.timeline({ paused: true });
	const cam = { scale: 1 };
	const words = [{ yPercent: 0 }, { yPercent: 0 }];
	const badge = { scale: 1, opacity: 1 };
	const ctx = { tl, cam, d: 3, at: (s) => s, ease: { settle: "none", spring: "none", drift: "none" } };
	riseWords(ctx, words, LEAD, { dur: 1, each: 0.1 });
	pop(ctx, badge, LEAD, { dur: 1 });
	drift(ctx);
	tl.set({}, {}, 3);
	// GSAP moves every child later when one starts below 0: the film would be 3.1 s.
	assert.equal(tl.duration(), 3);
	tl.seek(0.4, false);
	tl.seek(0, false);
	assert.ok(Math.abs(words[0].yPercent - 118 * 0.9) < 0.01, `word 0 at frame 0: ${words[0].yPercent}`);
	assert.ok(Math.abs(words[1].yPercent - 118) < 0.01, `word 1 waits for its stagger: ${words[1].yPercent}`);
	assert.ok(Math.abs(badge.scale - 0.1) < 0.01, `pop at frame 0: ${badge.scale}`);
	assert.ok(Math.abs(cam.scale - (1 + 0.04 * (0.1 / 3.1))) < 1e-4, `drift at frame 0: ${cam.scale}`);
	tl.seek(0.9, false);
	assert.equal(words[0].yPercent, 0);
	// A later shot (its start is after 0 s) is placed as before.
	const tl2 = globalThis.gsap.timeline({ paused: true });
	const late = [{ yPercent: 0 }];
	riseWords({ ...ctx, tl: tl2, at: (s) => 5 + s }, late, LEAD, { dur: 1 });
	assert.equal(tl2.getChildren()[0].startTime(), 4.9);
});

test("a timeline of the wrong length names both causes: a tween before 0 s, and a tween after the shot ends", () => {
	assert.equal(timelineLengthError(25.02, { duration: 25, fps: 30 }), null);
	const message = timelineLengthError(25.1, { duration: 25, fps: 30 });
	assert.match(message, /25\.100 s but the storyboard is 25 s/);
	assert.match(message, /before 0 s.*place\(\)/);
	assert.match(message, /after its shot ends/);
});
