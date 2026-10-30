/**
 * Fixtures for the walkthrough unit tests: a small plan.json and events.json
 * that pass every gate, and builders that change one field at a time.
 */

/** A plan that passes gates 1 to 7 as written. */
export function samplePlan(patch = {}) {
	return {
		version: 1,
		fps: 60,
		output: { width: 1920, height: 1080 },
		source: { width: 1280, height: 720, scale: 2 },
		clips: [{ from: 0, to: 240, at: 0, speed: 1 }],
		camera: [
			{ t: 0, cx: 640, cy: 360, zoom: 1.15, ease: "power3.inOut" },
			{ t: 3.5, cx: 640, cy: 300, zoom: 1.2, ease: "power3.inOut" },
		],
		cursor: [
			{ t: 0, x: 640, y: 360 },
			{ t: 1, x: 500, y: 240, click: true, event: "e1" },
		],
		focus: [{ start: 0.5, end: 1.5, event: "e1", box: "target" }],
		captions: [{ start: 0.5, end: 2, text: "Name the game." }],
		voice: [{ start: 0.4, end: 2.1, text: "Name the game.", file: "voice/0.wav", seconds: 1.6 }],
		...patch,
	};
}

export function clickEvent(patch = {}) {
	return {
		id: "e1",
		kind: "click",
		name: "click-go",
		startFrame: 60,
		endFrame: 62,
		settleFrame: 70,
		target: { x: 440, y: 200, width: 200, height: 60 },
		caret: null,
		changed: { x: 440, y: 200, width: 200, height: 60 },
		fontPx: 20,
		text: null,
		label: "Play",
		caption: null,
		...patch,
	};
}

/** An events.json that matches samplePlan(). */
export function sampleEvents(patch = {}) {
	return {
		version: 1,
		fps: 60,
		viewport: { width: 1280, height: 720, scale: 2 },
		video: "capture.mp4",
		frames: 240,
		stats: { unique: 120, repeated: 120, maxLagMs: 40, gpu: true },
		cursor: [{ f: 0, x: 640, y: 360 }],
		events: [clickEvent()],
		cues: [],
		...patch,
	};
}

/** Samples for gate 5, in capture seconds. */
export function samples(...items) {
	return items.map(([t, ymin, ymax]) => ({ t, ymin, ymax }));
}
