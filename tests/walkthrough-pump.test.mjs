/**
 * The frame pump's clock window: the install script carries the next frame's
 * time, so a document the app opens during frame k+1 starts at k+1 and never
 * one frame behind the document it replaces. The model is the reviewer's: a
 * document at 5010 ms, a navigation during the next frame's callbacks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClockScripts } from "../skills/walkthrough-video/scripts/lib/clock-scripts.mjs";
import { FramePump } from "../skills/walkthrough-video/scripts/lib/pump.mjs";

const SKILL = fileURLToPath(new URL("../skills/walkthrough-video/scripts/", import.meta.url));

/**
 * A page model: the installed script is the start time of the next document,
 * and `Runtime.evaluate` is where the app's callbacks run. `navigateOn` opens a
 * new document during that frame's callbacks, the way an app's link does.
 */
function pageModel({ dt, frames, navigateOn = null, beforeNavigate = null }) {
	const documents = [];
	let installed = null;
	let scripts = null;
	const cdp = {
		send: async (method, params) => {
			if (method === "Page.addScriptToEvaluateOnNewDocument") {
				installed = Number(params.source);
				return { identifier: `script-${installed}` };
			}
			if (method === "Page.removeScriptToEvaluateOnNewDocument") return {};
			if (method === "Runtime.evaluate") {
				const frame = Number(/advanceTo\(([0-9.]+)/.exec(params.expression)?.[1] ?? 0);
				if (frame === navigateOn) {
					// The capture's beforeNavigate runs before the navigation and publishes its own value.
					if (beforeNavigate) await scripts.replace(beforeNavigate());
					documents.push({ loadedAt: frame, start: installed });
				}
				return { result: { value: 0 } };
			}
			return {};
		},
	};
	scripts = createClockScripts({ send: cdp.send, source: (ms) => String(ms) });
	const pump = new FramePump({ cdp, fps: 1000 / dt, output: "/dev/null", clock: "virtual" });
	// The capture's own pieces, without ffmpeg: one still image per frame, and a slot that only counts.
	pump.screenshot = async () => Buffer.from("frame");
	pump.writeSlot = async () => {
		pump.written++;
	};
	pump.onAdvance = (ms) => scripts.replace(ms);
	return { pump, scripts, documents, frames };
}

test("a document opened during frame k+1 starts at k+1, not at k (G2)", async () => {
	// dt 10 ms, frame 2 is where the app navigates: the old document was at 5010 ms in the review model.
	const model = pageModel({ dt: 10, frames: 4, navigateOn: 20 });
	model.pump.onFrame = () => {
		if (model.pump.written >= model.frames) model.pump.stopping = true;
	};
	await model.pump.runVirtual();
	assert.equal(model.pump.error, null, "the pump ran without an error");
	assert.equal(model.documents.length, 1, "the app navigated once");
	const opened = model.documents[0];
	assert.equal(opened.loadedAt, 20, "the navigation happened during frame 2");
	assert.ok(opened.start >= 20, `the new document started at ${opened.start} ms, behind the frame it opened in`);
});

test("a pump clock update failure stops the capture with that error (G2)", async () => {
	const model = pageModel({ dt: 10, frames: 3 });
	let adds = 0;
	model.pump.onAdvance = async () => {
		if (++adds === 2) throw new Error("clock: the start time was not updated");
	};
	await model.pump.runVirtual();
	assert.ok(model.pump.error instanceof Error, "the pump kept the failure");
	assert.match(model.pump.error.message, /start time was not updated/);
	assert.ok(model.pump.written <= 2, `the pump stopped after ${model.pump.written} frames`);
});

test("the pump publishes the next frame before the callbacks of that frame (G2 source guard)", () => {
	// The shortfall in the review model needs the publish to happen in the same iteration as the advance.
	const source = readFileSync(`${SKILL}lib/pump.mjs`, "utf8");
	assert.match(source, /onAdvance\(\(index \+ 1\) \* this\.dt\)/, "the install script carries frame k+1");
});

test("a navigation in the first frame starts at frame 1, not at 0 (M2)", async () => {
	// No seed in the model: the pump must publish frame 1 before its first advance.
	const model = pageModel({ dt: 10, frames: 2, navigateOn: 10 });
	model.pump.onFrame = () => {
		if (model.pump.written >= model.frames) model.pump.stopping = true;
	};
	await model.pump.runVirtual();
	assert.equal(model.pump.error, null);
	assert.equal(model.documents.length, 1);
	assert.ok(model.documents[0].start >= 10, `the first-frame document started at ${model.documents[0].start} ms`);
});

test("a navigation that computes an earlier time cannot publish it (M2)", async () => {
	// The app navigates during frame 3; wv's navigation hook computes (frame()+1)*dt = 30,
	// but the pump already published 40. The new document must not go back to 30.
	// Navigate during frame 4, after the pump published 40 for it. The hook's own value is 30.
	const model = pageModel({ dt: 10, frames: 5, navigateOn: 40, beforeNavigate: () => (model.pump.frame() + 1) * model.pump.dt });
	model.pump.onFrame = () => {
		if (model.pump.written >= model.frames) model.pump.stopping = true;
	};
	await model.pump.runVirtual();
	assert.equal(model.pump.error, null);
	assert.ok(model.documents.length >= 1, "the app navigated");
	assert.ok(model.documents[0].start >= 40, `the document started at ${model.documents[0].start} ms, behind the forecast of 40 ms`);
});
