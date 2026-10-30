import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "../skills/walkthrough-video/scripts/lib/paths.mjs";
import test from "node:test";
import { estimateCacheBytes, estimateFilmCacheBytes, extractCacheDir, formatGB, makeRenderCacheDir, removeRenderCacheDir, spaceRefusal } from "../skills/walkthrough-video/scripts/lib/render-cache.mjs";

test("the extract cache is HyperFrames' default path for this user", () => {
	assert.equal(extractCacheDir({}, "/tmp", 1000), "/tmp/hyperframes-extract-cache-1000");
	assert.equal(extractCacheDir({ HYPERFRAMES_EXTRACT_CACHE_DIR: "/var/tmp/hf" }, "/tmp", 1000), "/var/tmp/hf");
	for (const off of ["off", "none", "false", "0"]) assert.equal(extractCacheDir({ HYPERFRAMES_EXTRACT_CACHE_DIR: off }, "/tmp", 1000), null, off);
});

/**
 * What a HyperFrames dist folder says about its cache path:
 * null when nothing is installed, `{ text: "" }` when it is installed in an
 * unknown format (a failure, so wv gets updated), else the matching source.
 */
export function readBundle(dist) {
	if (!existsSync(dist)) return null;
	for (const name of readdirSync(dist)) {
		if (!name.endsWith(".js")) continue;
		const text = readFileSync(join(dist, name), "utf8");
		if (text.includes("hyperframes-extract-cache-")) return { text };
	}
	return { text: "" };
}

const bundle = readBundle(join(paths().hyperframes, "dist"));
const skip = bundle === null ? `HyperFrames is not installed at ${paths().hyperframes}; run wv setup` : false;

test("an installed HyperFrames with an unknown cache format fails the test, and no install skips it", () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-bundle-"));
	try {
		assert.equal(readBundle(join(dir, "missing")), null, "no dist folder: not installed");
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "index.js"), "const cache = somethingElse;");
		assert.deepEqual(readBundle(join(dir, "dist")), { text: "" }, "installed, unknown format: the caller fails, it does not skip");
		writeFileSync(join(dir, "dist", "index.js"), "const cache = `hyperframes-extract-cache-${process.getuid()}`;");
		assert.match(readBundle(join(dir, "dist")).text, /hyperframes-extract-cache-/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the extract cache path is the one the installed HyperFrames makes, read from its code", { skip }, () => {
	// Read the library's own template, not wv's formula: a renamed folder would leave wv
	// deleting nothing and the cache growing.
	assert.ok(bundle.text, "HyperFrames is installed but names no hyperframes-extract-cache folder: update extractCacheDir and this test");
	const match = /`([^`]*hyperframes-extract-cache[^`]*)`/.exec(bundle.text);
	assert.ok(match, "the installed HyperFrames names its cache folder in one template string; update this test and extractCacheDir");
	const literal = match[1];
	const expected = `/tmp/${literal.replace(/\$\{[^}]*\}/g, "1000")}`;
	assert.equal(extractCacheDir({}, "/tmp", 1000), expected, `the installed HyperFrames names ${literal}`);
	// The uid is the only variable part, and it is the caller's to give.
	assert.equal(extractCacheDir({}, "/tmp", "u"), expected.replace("1000", "u"));
});

test("the frame cache estimate counts four bytes a pixel for every rendered frame", () => {
	const plan = { fps: 60, output: { width: 1920, height: 1080 }, edit: { start: 1.85, duration: 30 }, outroS: 2.4 };
	// 1.85 + 30 + 2.4 = 34.25 s at 60 fps = 2055 frames.
	assert.equal(estimateCacheBytes(plan), 2055 * 1920 * 1080 * 4);
});

test("a render that does not fit refuses with the numbers, the cause and the path", () => {
	const refusal = spaceRefusal({ needed: 5_153_126_400, free: 2_040_109_465, cacheDir: "/tmp/wv-does-not-exist-1000", tmp: "/tmp" });
	assert.ok(refusal, "a refusal message");
	assert.match(refusal, /^\/tmp is full: 4\.8 GB needed, 1\.9 GB free\./);
	assert.match(refusal, /\/tmp\/wv-does-not-exist-1000/);
	assert.match(refusal, /Fix: .*TMPDIR=<a folder on a disk/);
	assert.doesNotMatch(refusal, /hfcache/);
	assert.equal(spaceRefusal({ needed: 1_000_000, free: 2_000_000_000, cacheDir: "/tmp/x" }), null);
});

test("the refusal names the filesystem that is full, not the temp folder when the cache is elsewhere", () => {
	const refusal = spaceRefusal({ needed: 5_000_000_000, free: 1_000_000_000, cacheDir: "/var/tmp/wv-cache", tmp: "/tmp" });
	assert.match(refusal, /^\/var\/tmp is full:/);
	assert.match(refusal, /\/var\/tmp\/wv-cache/);
	const elsewhere = spaceRefusal({ needed: 5_000_000_000, free: 1_000_000_000, cacheDir: "/mnt/big/hf", tmp: "/tmp" });
	assert.match(elsewhere, /^\/mnt is full:/);
});

test("a film caches only the frames of its captured clips, about one byte a pixel as PNG", () => {
	// The gate film's preview was refused for 6.1 GB: every film frame at 1920x1080 RGBA, though only clips are cached.
	assert.equal(estimateFilmCacheBytes({ fps: 30, shots: [{ seconds: 2.3 }, { seconds: 2.9, clip: { width: 2560, height: 1440 } }] }), 88 * 2560 * 1440);
	assert.equal(estimateFilmCacheBytes({ fps: 60, shots: [{ seconds: 30 }] }), 0);
});

test("gigabytes print with one decimal", () => {
	assert.equal(formatGB(1_073_741_824), "1.0 GB");
	assert.equal(formatGB(5_153_126_400), "4.8 GB");
});

const cacheBase = () => mkdtempSync(join(tmpdir(), "wv-cache-"));

test("each render caches into its own folder, and the cleanup leaves every other folder alone", () => {
	const base = cacheBase();
	mkdirSync(join(base, "hfcache-v8-abc"));
	mkdirSync(join(base, "other-agent-work"));
	writeFileSync(join(base, "hfcache-v8-abc", "frame.png"), "x");
	const dir = makeRenderCacheDir(base, { pid: 4242, now: 1_700_000_000_000 });
	assert.equal(dir, join(base, "wv-4242-1700000000000"), "the render's own folder, named after the pid and the time");
	writeFileSync(join(dir, "hfcache-v8-new"), "frame");
	removeRenderCacheDir(dir);
	assert.equal(existsSync(dir), false, "the render's folder is gone");
	assert.deepEqual(readdirSync(base).sort(), ["hfcache-v8-abc", "other-agent-work"], "another program's folders and the shared cache stay");
});

test("cache cleanup turns off with the cache, and two renders never share a folder", () => {
	assert.equal(makeRenderCacheDir(null), null);
	const base = cacheBase();
	const a = makeRenderCacheDir(base, { pid: 1, now: 5 });
	const b = makeRenderCacheDir(base, { pid: 2, now: 6 });
	assert.notEqual(a, b);
	assert.deepEqual(readdirSync(base).sort(), ["wv-1-5", "wv-2-6"]);
});

test("a failed render still deletes its cache folder", async () => {
	const home = mkdtempSync(join(tmpdir(), "wv-home-"));
	const base = cacheBase();
	mkdirSync(join(base, "other-agent-work"));
	const project = mkdtempSync(join(tmpdir(), "wv-proj-"));
	// A stand-in for the pinned HyperFrames: it writes into the folder it is given, then fails.
	const bin = join(home, "pi-walkthrough-video", "node_modules", ".bin", "hyperframes");
	mkdirSync(join(home, "pi-walkthrough-video", "node_modules", ".bin"), { recursive: true });
	writeFileSync(bin, '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--frames-cache-dir" ]; then mkdir -p "$2"; : > "$2/frame.png"; fi\n  shift\ndone\nexit 1\n');
	chmodSync(bin, 0o755);
	mkdirSync(join(project, "assets"), { recursive: true });
	writeFileSync(join(project, "assets", "gsap.min.js"), "// gsap");
	writeFileSync(join(project, "plan.json"), JSON.stringify({ fps: 30, output: { width: 640, height: 360 }, edit: { start: 0, duration: 1 } }));
	const env = { ...process.env, XDG_CACHE_HOME: home, HYPERFRAMES_EXTRACT_CACHE_DIR: base, TMPDIR: base };
	const saved = { ...process.env };
	Object.assign(process.env, env);
	try {
		const { render } = await import("../skills/walkthrough-video/scripts/hf.mjs");
		await assert.rejects(() => render([project]), /hyperframes render failed/);
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	}
	assert.deepEqual(readdirSync(base).sort(), ["other-agent-work"], "the failed render left no cache folder and no other work was deleted");
});

// --- render progress, the errno, and the preview composition ---

test("a run that hits its timeout says so, and keeps the signal that stopped it", async () => {
	const { runStreaming } = await import("../skills/walkthrough-video/scripts/lib/proc.mjs");
	const { failureDetail } = await import("../skills/walkthrough-video/scripts/hf.mjs");
	const started = Date.now();
	const r = await runStreaming("sleep", ["30"], { timeoutMs: 300 });
	assert.ok(Date.now() - started < 5000, "the timeout stops the child");
	assert.equal(r.timedOut, true);
	assert.equal(r.code, null);
	// The stop sends SIGTERM first, and sleep dies from it: the signal that stopped the run.
	assert.equal(r.signal, "SIGTERM", "the signal that stopped the run is kept");
	assert.match(failureDetail(r, 60 * 60_000), /timed out after 60 min/);
});

test("a failed render says why: a timeout, a kill, or the last lines of its output", async () => {
	const { failureDetail } = await import("../skills/walkthrough-video/scripts/hf.mjs");
	assert.match(failureDetail({ code: null, signal: "SIGKILL", timedOut: true, stdout: "", stderr: "" }, 60 * 60_000), /timed out after 60 min/);
	assert.match(failureDetail({ code: null, signal: "SIGTERM", stdout: "", stderr: "" }), /SIGTERM/);
	const detail = failureDetail({ code: 1, stdout: "", stderr: "[INFO] start\nError: composition not found in index.html\n" });
	assert.match(detail, /composition not found/);
	assert.doesNotMatch(detail, /\[INFO\]/);
});

test("a HyperFrames progress line becomes a percentage and a stage", async () => {
	const { progressOf } = await import("../skills/walkthrough-video/scripts/hf.mjs");
	assert.deepEqual(progressOf("  ███████████░░░░░░░░  44%  capturing frames"), { pct: 44, stage: "capturing frames" });
	assert.deepEqual(progressOf("100% done"), { pct: 100, stage: "done" });
	assert.equal(progressOf("[INFO] starting render"), null);
});

test("errno -122 reads as a full disk, not a code bug", async () => {
	const { diskError } = await import("../skills/walkthrough-video/scripts/hf.mjs");
	const message = diskError("Video extraction failed: Unknown system error -122");
	assert.ok(message, "a message");
	assert.match(message, /full|EDQUOT/);
	assert.match(message, /cache/);
	assert.equal(diskError("hyperframes: composition not found"), null);
	assert.ok(diskError("ffmpeg: No space left on device"));
});

/** A project that wv preview and wv render can read, without a render: a plan, GSAP and nothing else. */
async function projectForRender(prefix) {
	const { buildPlan } = await import("../skills/walkthrough-video/scripts/compose.mjs");
	const project = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(join(project, "assets"), { recursive: true });
	writeFileSync(join(project, "assets", "gsap.min.js"), "// gsap");
	const capture = {
		version: 1, fps: 60, viewport: { width: 1280, height: 720, scale: 2 }, frames: 300,
		cursor: [{ f: 0, x: 900, y: 600 }],
		events: [{ id: "e1", kind: "goto", name: "open", startFrame: 0, endFrame: 20, settleFrame: 30, target: null, caret: null, changed: null, fontPx: null }],
		cues: [],
	};
	writeFileSync(join(project, "plan.json"), JSON.stringify(buildPlan(capture, { shots: [{ events: ["e1"], caption: "Open" }] })));
	return project;
}

test("wv render refuses a project with no local GSAP, with the fix in the message", { timeout: 30000 }, async () => {
	const { main } = await import("../skills/walkthrough-video/scripts/wv.mjs");
	const home = mkdtempSync(join(tmpdir(), "wv-nogsap-home-"));
	const base = mkdtempSync(join(tmpdir(), "wv-nogsap-cache-"));
	const project = await projectForRender("wv-nogsap-proj-");
	// An old project: a CDN tag and no assets/gsap.min.js, which preview, render and gates refuse.
	rmSync(join(project, "assets", "gsap.min.js"), { force: true });
	writeFileSync(join(project, "index.html"), '<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>');
	const bin = join(home, "pi-walkthrough-video", "node_modules", ".bin", "hyperframes");
	mkdirSync(dirname(bin), { recursive: true });
	writeFileSync(bin, "#!/bin/sh\nexit 1\n");
	chmodSync(bin, 0o755);
	try {
		const said = [];
		const write = process.stderr.write;
		process.stderr.write = (chunk) => {
			said.push(String(chunk));
			return true;
		};
		const before = { ...process.env };
		Object.assign(process.env, { XDG_CACHE_HOME: home, HYPERFRAMES_EXTRACT_CACHE_DIR: base });
		let code;
		try {
			code = await main(["render", project, "--out", join(project, "out.mp4")]);
		} finally {
			process.stderr.write = write;
			for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
			Object.assign(process.env, before);
		}
		assert.equal(code, 1);
		assert.match(said.join(""), /no local GSAP/);
		assert.match(said.join(""), /wv compose again/);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(base, { recursive: true, force: true });
		rmSync(project, { recursive: true, force: true });
	}
});

test("a preview with no HyperFrames leaves no preview.html and no cache folder", { timeout: 30000 }, async () => {
	const { main } = await import("../skills/walkthrough-video/scripts/wv.mjs");
	const home = mkdtempSync(join(tmpdir(), "wv-nohf-home-"));
	const base = mkdtempSync(join(tmpdir(), "wv-nohf-cache-"));
	const project = await projectForRender("wv-nohf-proj-");
	try {
		const said = [];
		const write = process.stderr.write;
		process.stderr.write = (chunk) => {
			said.push(String(chunk));
			return true;
		};
		let code;
		const env = { ...process.env, XDG_CACHE_HOME: home, HYPERFRAMES_EXTRACT_CACHE_DIR: base };
		const before = { ...process.env };
		Object.assign(process.env, env);
		try {
			code = await main(["preview", project]);
		} finally {
			process.stderr.write = write;
			for (const key of Object.keys(env)) if (!(key in before)) delete process.env[key];
			Object.assign(process.env, before);
		}
		assert.equal(code, 1, "a missing HyperFrames is an error");
		assert.match(said.join(""), /not installed/);
		assert.equal(existsSync(join(project, "preview.html")), false, "no preview composition is left behind");
		assert.deepEqual(readdirSync(base), [], "no cache folder is left behind");
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(base, { recursive: true, force: true });
		rmSync(project, { recursive: true, force: true });
	}
});

test("a render with no HyperFrames leaves no cache folder", { timeout: 30000 }, async () => {
	const { main } = await import("../skills/walkthrough-video/scripts/wv.mjs");
	const home = mkdtempSync(join(tmpdir(), "wv-nohf2-home-"));
	const base = mkdtempSync(join(tmpdir(), "wv-nohf2-cache-"));
	const project = await projectForRender("wv-nohf2-proj-");
	try {
		const before = { ...process.env };
		Object.assign(process.env, { XDG_CACHE_HOME: home, HYPERFRAMES_EXTRACT_CACHE_DIR: base });
		const write = process.stderr.write;
		const said = [];
		process.stderr.write = (chunk) => {
			said.push(String(chunk));
			return true;
		};
		let code;
		try {
			code = await main(["render", project, "--out", join(project, "out.mp4")]);
		} finally {
			process.stderr.write = write;
			for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
			Object.assign(process.env, before);
		}
		assert.equal(code, 1, "a missing HyperFrames is an error");
		assert.match(said.join(""), /not installed/);
		assert.deepEqual(readdirSync(base), [], "no cache folder is left behind");
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(base, { recursive: true, force: true });
		rmSync(project, { recursive: true, force: true });
	}
});

test("the preview is 640x360 for a 1080p plan, and any other size keeps 16:9", async () => {
	const { previewHtml, previewScale } = await import("../skills/walkthrough-video/scripts/hf.mjs");
	assert.deepEqual(previewScale({ width: 1920, height: 1080 }), { width: 640, height: 360, scale: 360 / 1080 });
	const portrait = previewScale({ width: 1080, height: 1920 });
	assert.equal(portrait.height, 360);
	assert.equal(portrait.width % 2, 0);
});

test("the preview composition is the plan at a third of the size, with the whole look", async () => {
	const { previewHtml } = await import("../skills/walkthrough-video/scripts/hf.mjs");
	const { buildPlan } = await import("../skills/walkthrough-video/scripts/compose.mjs");
	const capture = {
		fps: 60, viewport: { width: 1280, height: 720, scale: 2 }, frames: 600,
		events: [{ id: "e1", kind: "click", name: "go", startFrame: 60, endFrame: 62, settleFrame: 80, target: { x: 100, y: 100, width: 200, height: 40 }, caret: null, changed: null, fontPx: 16 }],
		cursor: [{ f: 0, x: 10, y: 10 }],
	};
	const plan = buildPlan(capture, { shots: [{ events: ["e1"], caption: "Open the board" }] });
	plan.look = { ground: "#123456", ink: "#ffffff", font: "Karla" };
	plan.cards = { intro: { title: "Pointer" }, outro: null };
	plan.fontCss = "@font-face { font-family: Karla; }";
	const preview = previewHtml(plan, "assets/gsap.min.js");
	assert.match(preview.html, /data-width="640" data-height="360"/);
	assert.match(preview.html, /font-size: 18\.67px/, "the caption scales with the output height");
	assert.match(preview.html, /#cam \{ position: absolute; left: 0; top: 0; width: 640px; height: 360px/, "the camera frame is the preview size");
	assert.doesNotMatch(preview.html, /id="stage"/, "no wrapper: the composition itself is smaller");
	assert.match(preview.html, /Open the board/);
	assert.match(preview.html, /#123456/);
	assert.match(preview.html, /@font-face/);
	assert.match(preview.html, /Pointer/);
});

test("a preview that cannot write preview.html still removes its cache folder", { timeout: 30000 }, async () => {
	const { main } = await import("../skills/walkthrough-video/scripts/wv.mjs");
	const home = mkdtempSync(join(tmpdir(), "wv-eisdir-home-"));
	const base = mkdtempSync(join(tmpdir(), "wv-eisdir-cache-"));
	const project = await projectForRender("wv-eisdir-proj-");
	// A directory where the preview composition must go: the write fails with EISDIR.
	mkdirSync(join(project, "preview.html"));
	const bin = join(home, "pi-walkthrough-video", "node_modules", ".bin", "hyperframes");
	mkdirSync(dirname(bin), { recursive: true });
	writeFileSync(bin, "#!/bin/sh\nexit 0\n");
	chmodSync(bin, 0o755);
	const write = process.stderr.write;
	const said = [];
	process.stderr.write = (chunk) => {
		said.push(String(chunk));
		return true;
	};
	const before = { ...process.env };
	Object.assign(process.env, { XDG_CACHE_HOME: home, HYPERFRAMES_EXTRACT_CACHE_DIR: base });
	let code;
	try {
		code = await main(["preview", project]);
	} finally {
		process.stderr.write = write;
		for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
		Object.assign(process.env, before);
		rmSync(home, { recursive: true, force: true });
		rmSync(project, { recursive: true, force: true });
	}
	try {
		assert.equal(code, 1, `the preview failed: ${said.join("")}`);
		assert.deepEqual(readdirSync(base), [], "no cache folder is left behind");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("a preview whose write fails leaves no preview file and no cache folder", { timeout: 30000 }, async () => {
	const { main } = await import("../skills/walkthrough-video/scripts/wv.mjs");
	const home = mkdtempSync(join(tmpdir(), "wv-eacces-home-"));
	const base = mkdtempSync(join(tmpdir(), "wv-eacces-cache-"));
	const project = await projectForRender("wv-eacces-proj-");
	const bin = join(home, "pi-walkthrough-video", "node_modules", ".bin", "hyperframes");
	mkdirSync(dirname(bin), { recursive: true });
	writeFileSync(bin, "#!/bin/sh\nexit 0\n");
	chmodSync(bin, 0o755);
	// A project that cannot be written: preview.html cannot even be created.
	chmodSync(project, 0o555);
	const write = process.stderr.write;
	const said = [];
	process.stderr.write = (chunk) => {
		said.push(String(chunk));
		return true;
	};
	const before = { ...process.env };
	Object.assign(process.env, { XDG_CACHE_HOME: home, HYPERFRAMES_EXTRACT_CACHE_DIR: base });
	let code;
	try {
		code = await main(["preview", project]);
	} finally {
		process.stderr.write = write;
		chmodSync(project, 0o755);
		for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
		Object.assign(process.env, before);
		rmSync(home, { recursive: true, force: true });
	}
	// Read the project before it is deleted, or the check proves nothing.
	try {
		assert.equal(code, 1, `the preview failed: ${said.join("")}`);
		assert.equal(existsSync(join(project, "preview.html")), false, "no partial composition is left");
		assert.deepEqual(readdirSync(base), [], "no cache folder is left behind");
	} finally {
		rmSync(project, { recursive: true, force: true });
		rmSync(base, { recursive: true, force: true });
	}
});

test("a preview whose write fails halfway leaves no preview file and no cache folder (G6)", { timeout: 30000 }, async () => {
	const home = mkdtempSync(join(tmpdir(), "wv-partial-home-"));
	const base = mkdtempSync(join(tmpdir(), "wv-partial-cache-"));
	const project = await projectForRender("wv-partial-proj-");
	// A fake hyperframes, as the other preview tests use: the test must fail at the write,
	// not at a missing runtime.
	const bin = join(home, "pi-walkthrough-video", "node_modules", ".bin", "hyperframes");
	mkdirSync(dirname(bin), { recursive: true });
	writeFileSync(bin, "#!/bin/sh\nexit 0\n");
	chmodSync(bin, 0o755);
	const before = { ...process.env };
	Object.assign(process.env, { XDG_CACHE_HOME: home, HYPERFRAMES_EXTRACT_CACHE_DIR: base });
	const { preview } = await import("../skills/walkthrough-video/scripts/hf.mjs");
	try {
		// A partial write, then ENOSPC: the file exists when the error is thrown.
		const write = (file, html) => {
			writeFileSync(file, html.slice(0, 64));
			const error = new Error("ENOSPC: no space left on device");
			error.code = "ENOSPC";
			throw error;
		};
		await assert.rejects(preview([project], { write }), /ENOSPC/);
		assert.equal(existsSync(join(project, "preview.html")), false, "the partial composition is removed");
		assert.deepEqual(readdirSync(base), [], "no cache folder is left behind");
	} finally {
		Object.assign(process.env, before);
		rmSync(project, { recursive: true, force: true });
		rmSync(base, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});
