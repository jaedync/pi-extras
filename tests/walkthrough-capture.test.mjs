import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { draftSheetArgs, frameHook, mergeTexts, publishArtifacts, stagingDir } from "../skills/walkthrough-video/scripts/lib/capture.mjs";
import { createFlowApi, racePumpError, waitBudgetMs } from "../skills/walkthrough-video/scripts/lib/flow.mjs";
import { sleep } from "../skills/walkthrough-video/scripts/lib/proc.mjs";

const work = () => mkdtempSync(join(tmpdir(), "wv-staging-"));

test("the staging folder sits beside the output folder, not inside it", () => {
	const out = join(work(), "cap");
	assert.equal(dirname(stagingDir(out)), dirname(out));
	assert.match(stagingDir(out), /^.*cap\.tmp-\d+$/);
});

test("publishing moves the staged files over the old ones and removes the staging folder", () => {
	const root = work();
	const out = join(root, "cap");
	mkdirSync(out);
	for (const name of ["capture.mp4", "events.json", "poster.png"]) writeFileSync(join(out, name), "old");
	const staging = stagingDir(out);
	mkdirSync(staging);
	for (const name of ["capture.mp4", "events.json", "poster.png"]) writeFileSync(join(staging, name), "new");
	publishArtifacts(staging, out);
	for (const name of ["capture.mp4", "events.json", "poster.png"]) assert.equal(readFileSync(join(out, name), "utf8"), "new", name);
	assert.equal(existsSync(staging), false);
	rmSync(root, { recursive: true, force: true });
});

test("publishing into a folder that does not exist yet creates it", () => {
	const root = work();
	const out = join(root, "deep", "cap");
	const staging = stagingDir(out);
	mkdirSync(staging, { recursive: true });
	writeFileSync(join(staging, "events.json"), "new");
	publishArtifacts(staging, out, ["events.json"]);
	assert.equal(readFileSync(join(out, "events.json"), "utf8"), "new");
	rmSync(root, { recursive: true, force: true });
});

// --- stills: which frames repeat (row 1) ---

test("the still tracker keeps one run per stretch of repeated images", async () => {
	const { StillTracker } = await import("../skills/walkthrough-video/scripts/lib/stills.mjs");
	const tracker = new StillTracker();
	const frames = ["a", "a", "b", "b", "b", "c", "d", "d"];
	frames.forEach((hash, i) => tracker.add(hash, i));
	assert.deepEqual(tracker.runs(), [[1, 1], [3, 4], [7, 7]]);
	assert.equal(tracker.stillFrames(), 4);
	assert.equal(tracker.distinctFrames(), 4);
});

test("a run still open at the end of the capture counts to the last frame written", async () => {
	const { StillTracker } = await import("../skills/walkthrough-video/scripts/lib/stills.mjs");
	const tracker = new StillTracker();
	["a", "a", "a"].forEach((hash, i) => tracker.add(hash, i));
	assert.deepEqual(tracker.runs(), [[1, 2]]);
});

test("a capture with few new frames, or a gap between actions, warns and prints the load", async () => {
	const { captureWarnings } = await import("../skills/walkthrough-video/scripts/lib/capture.mjs");
	const events = { frames: 900, stats: { distinct: 40 }, events: [
		{ id: "e1", kind: "goto", startFrame: 0, endFrame: 30, settleFrame: 40 },
		{ id: "e2", kind: "click", startFrame: 800, endFrame: 805, settleFrame: 860 },
	] };
	const warnings = captureWarnings(events, { load: [11.2, 10, 9], cores: 12 });
	assert.equal(warnings.length, 2, JSON.stringify(warnings));
	assert.match(warnings[0], /4 %/);
	assert.match(warnings[0], /load 11\.2/);
	assert.match(warnings[1], /12\.7 s/);
});

test("a healthy capture warns about nothing", async () => {
	const { captureWarnings } = await import("../skills/walkthrough-video/scripts/lib/capture.mjs");
	const events = { frames: 900, stats: { distinct: 400 }, events: [
		{ id: "e1", kind: "goto", startFrame: 0, endFrame: 30, settleFrame: 40 },
		{ id: "e2", kind: "click", startFrame: 300, endFrame: 305, settleFrame: 340 },
	] };
	assert.deepEqual(captureWarnings(events, { load: [1.2, 1, 0.9], cores: 12 }), []);
});

test("the frame hook samples the text every N frames, and the samples merge with the settle samples", async () => {
	const got = [];
	const hook = frameHook({ textEvery: 250, fps: 30, sample: async (f) => [{ text: String(f), selector: "b" }], texts: got });
	for (let f = 0; f < 31; f++) await hook(f);
	assert.deepEqual(got.map((s) => s.f), [0, 8, 16, 24]);
	const merged = mergeTexts([{ f: 10, items: [] }, { f: 16, items: [{ text: "settle" }] }], got);
	assert.deepEqual(merged.map((s) => s.f), [0, 8, 10, 16, 24]);
	assert.equal(merged.find((s) => s.f === 16).items[0].text, "settle");
	// No interval: the hook samples nothing.
	const none = [];
	const off = frameHook({ textEvery: 0, fps: 30, sample: async () => [], texts: none });
	for (let f = 0; f < 31; f++) await off(f);
	assert.equal(none.length, 0);
});

test("the frame hook prints a progress line every 10 s of wall time, with the cost of a frame", async () => {
	const lines = [];
	let wall = 0;
	const hook = frameHook({ fps: 30, sample: async () => [], texts: [], log: (l) => lines.push(l), now: () => wall });
	for (let f = 0; f < 20; f++) {
		wall += 1500;
		await hook(f);
	}
	assert.equal(lines.length, 2);
	assert.match(lines[0], /frame 6 \(0\.20 s of app time\), 1\.50 s a frame/);
});

test("a pump that stopped fails a waiting flow step at once, with the pump's own error", { timeout: 5000 }, async () => {
	const pump = { virtual: true, error: null, frame: () => 0, frameMs: [] };
	const { api } = createFlowApi({ page: {}, pump, fps: 60, viewport: { width: 1280, height: 720 }, dir: tmpdir(), launchSecondary: async () => null, log: () => {} });
	setTimeout(() => {
		pump.error = new Error("beginFrame during capture did not answer within 20 s");
	}, 100);
	const started = performance.now();
	await assert.rejects(() => api.wait(5000), /beginFrame during capture did not answer/);
	assert.ok(performance.now() - started < 2000, `the step waited ${Math.round(performance.now() - started)} ms instead of failing at once`);
});

test("racePumpError rejects with the pump's error and never leaves an unhandled rejection", async () => {
	const pump = { error: new Error("advanceTo did not answer within 60 s") };
	await assert.rejects(() => racePumpError(pump, new Promise(() => {})), /advanceTo did not answer/);
	// The work loses the race; its later rejection must be handled, not thrown at the process.
	const late = new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 150));
	await assert.rejects(() => racePumpError({ error: new Error("stopped") }, late), /stopped/);
	await sleep(250);
});

test("a wait under the virtual clock gets wall time for its frames at the measured cost, not a fixed 120 s", () => {
	assert.equal(waitBudgetMs({ frames: 30, maxMs: 0, frameMs: [] }), 120000);
	// film2: 162 frames at 1.5 s a frame needs about 243 s; the budget gives 4 times that.
	assert.equal(waitBudgetMs({ frames: 162, maxMs: 0, frameMs: [1400, 1500, 1600] }), 162 * 1500 * 4);
});

test("the draft sheet tiles the draft capture every half second with its time", () => {
	const args = draftSheetArgs({ video: "cap/capture.mp4", out: "cap/sheet.jpg", seconds: 9 });
	assert.ok(args.includes("cap/capture.mp4"));
	assert.match(args.join(" "), /fps=2,.*drawtext.*tile=6x3/);
	assert.equal(args.at(-1), "cap/sheet.jpg");
	// A long draft (a 94 s take with a 62 s tile wait) keeps the sheet at 48 cells.
	assert.match(draftSheetArgs({ video: "v", out: "o", seconds: 94.2 }).join(" "), /fps=0\.5095.*tile=6x8/);
});
