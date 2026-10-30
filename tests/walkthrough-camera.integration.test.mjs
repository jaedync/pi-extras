/**
 * Camera scale end to end, opt-in: set WV_INTEGRATION=1.
 *
 * Builds a real project (index.html with the real GSAP, plan.json) with no capture,
 * then reads the zoom that the composition applies at each camera key and focus
 * window. This is the check that a plan key reaches the screen.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPlan } from "../skills/walkthrough-video/scripts/compose.mjs";
import { renderHtml } from "../skills/walkthrough-video/scripts/lib/compose-html.mjs";
import { gateCameraScale } from "../skills/walkthrough-video/scripts/lib/gates.mjs";
import { cameraScaleSamples } from "../skills/walkthrough-video/scripts/lib/gates-run.mjs";
import { paths } from "../skills/walkthrough-video/scripts/lib/paths.mjs";

const skip = process.env.WV_INTEGRATION === "1" ? false : "set WV_INTEGRATION=1 to read the camera from a real composition";

const capture = () => ({
	version: 1, fps: 60, viewport: { width: 1280, height: 720, scale: 3 }, frames: 900,
	cursor: [{ f: 0, x: 900, y: 600 }],
	events: [
		{ id: "e1", kind: "goto", name: "open", startFrame: 0, endFrame: 30, settleFrame: 40, target: null, caret: null, changed: null, fontPx: null },
		{ id: "e2", kind: "mark", name: "notice", startFrame: 120, endFrame: 120, settleFrame: 120, target: { x: 104, y: 240, width: 280, height: 19 }, caret: null, changed: null, fontPx: 13 },
		{ id: "e3", kind: "click", name: "signin", startFrame: 300, endFrame: 302, settleFrame: 340, target: { x: 560, y: 420, width: 160, height: 44 }, caret: null, changed: { x: 0, y: 0, width: 1280, height: 720 }, fontPx: 16 },
	],
	cues: [],
});

function project(work, plan) {
	mkdirSync(join(work, "assets"), { recursive: true });
	const gsap = join(paths().gsap, "dist", "gsap.min.js");
	assert.ok(existsSync(gsap), `gsap is installed at ${gsap} (run wv setup)`);
	copyFileSync(gsap, join(work, "assets", "gsap.min.js"));
	writeFileSync(join(work, "plan.json"), `${JSON.stringify(plan, null, 1)}\n`);
	writeFileSync(join(work, "index.html"), renderHtml(plan, {}, { src: "edit.mp4", ...plan.edit }, "assets/gsap.min.js"));
}

test("the composition applies the plan's camera keys within 2 %", { skip, timeout: 120000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "wv-camera-"));
	try {
		const plan = buildPlan(capture(), { intro: { title: "Test" }, outro: { title: "Done" }, shots: [{ events: ["e1"] }, { events: ["e2", "e3"], caption: "Sign in to reset" }] });
		assert.ok(plan.camera.some((key) => key.zoom > 1.2), JSON.stringify(plan.camera));
		project(work, plan);
		const read = await cameraScaleSamples(work, plan);
		assert.equal(read.error, undefined, read.error);
		const gate = gateCameraScale(plan, read.samples);
		assert.equal(gate.status, "pass", JSON.stringify(gate));
		assert.ok(read.samples.length >= plan.camera.length, JSON.stringify(read.samples));

		// A plan that says something else than the file is what a stale compose looks like.
		const other = { ...plan, camera: plan.camera.map((key) => ({ ...key, zoom: key.zoom * 1.4 })) };
		const stale = gateCameraScale(other, read.samples);
		assert.equal(stale.status, "fail", JSON.stringify(stale));
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
