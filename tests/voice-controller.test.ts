import { test } from "node:test";
import assert from "node:assert/strict";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import { VoiceController, type DaemonLink, type VoiceUi } from "../lib/voice/controller.ts";
import type { CaptureCallbacks } from "../lib/voice/capture.ts";
import type { IndicatorState } from "../lib/voice/indicator.ts";
import type { ClientMessage, DaemonEvent } from "../lib/voice/protocol.ts";

const PRESS = "\x1b[32;5u";
const REPEAT = "\x1b[32;5:2u";
const RELEASE = "\x1b[32;5:3u";
const LEGACY = "\x00";
const ESC = "\x1b";

function harness(
	editorText = "",
	extras: { blockedHint?: string; device?: string; noAudioTimeoutMs?: number; connect?: () => Promise<void> } = {},
) {
	setKittyProtocolActive(true);
	let now = 0;
	const sent: ClientMessage[] = [];
	const pasted: string[] = [];
	const views: Array<string | undefined> = [];
	const states: Array<IndicatorState | undefined> = [];
	let capture: CaptureCallbacks | undefined;
	let timers: Array<{ at: number; fn: () => void }> = [];
	const schedule = (fn: () => void, ms: number) => {
		const timer = { at: now + ms, fn };
		timers.push(timer);
		return () => (timers = timers.filter((t) => t !== timer));
	};
	/** Moves the fake clock, firing insert-stream frames that fall due. */
	const tick = (ms: number) => {
		const end = now + ms;
		for (;;) {
			const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!next) break;
			timers = timers.filter((t) => t !== next);
			now = next.at;
			next.fn();
		}
		now = end;
	};
	let captureStops = 0;
	const link: DaemonLink = {
		onEvent: () => {},
		onClose: () => {},
		connect: extras.connect ?? (async () => {}),
		send: (m) => sent.push(m),
	};
	const ui: VoiceUi = {
		show: (view) => {
			states.push(view);
			views.push(view && `${view.phase}${view.message ? `:${view.message}` : ""}`);
		},
		paste: (text) => pasted.push(text),
		getEditorText: () => editorText,
	};
	const controller = new VoiceController({
		key: "ctrl+space",
		now: () => now,
		ui,
		link,
		startCapture: (callbacks) => {
			capture = callbacks;
			return { label: "fake", blockedHint: extras.blockedHint, device: extras.device, stop: () => captureStops++ };
		},
		lingerMs: 0,
		noAudioTimeoutMs: extras.noAudioTimeoutMs,
		schedule,
	});
	const emit = (event: DaemonEvent) => link.onEvent(event);
	const lastId = () => (sent.findLast((m) => m.t === "start") as { id: number } | undefined)?.id;
	const flush = () => new Promise((done) => setImmediate(done));
	return {
		controller, sent, pasted, views, states, emit, lastId, flush,
		frame: (value = 500) => capture!.onFrame(new Int16Array(1600).fill(value)),
		tick,
		key: (data: string) => controller.handleInput(data),
		get captureStops() { return captureStops; },
	};
}

test("hold to talk: press starts, release after the threshold stops and inserts", async () => {
	const h = harness("fix the");
	assert.deepEqual(h.key(PRESS), { consume: true });
	await h.flush();
	h.frame();
	h.tick(400);
	assert.deepEqual(h.key(REPEAT), { consume: true });
	h.tick(800);
	h.key(RELEASE);
	assert.equal(h.captureStops, 1);
	assert.equal(h.sent.at(-1)?.t, "stop");
	h.emit({ t: "final", id: h.lastId()!, text: "parser bug" });
	await h.flush();
	h.tick(200);
	assert.equal(h.pasted.join(""), " parser bug");
});

test("tap toggles: quick release keeps recording until the next press", async () => {
	const h = harness();
	h.key(PRESS);
	await h.flush();
	h.tick(100);
	h.key(RELEASE);
	assert.equal(h.captureStops, 0);
	h.tick(3000);
	h.key(PRESS);
	assert.equal(h.captureStops, 1);
	h.key(RELEASE);
	h.emit({ t: "final", id: h.lastId()!, text: "hello" });
	await h.flush();
	h.tick(200);
	assert.equal(h.pasted.join(""), "hello");
});

test("legacy ctrl+space (NUL) works as a toggle", async () => {
	const h = harness();
	h.key(LEGACY);
	await h.flush();
	h.tick(2000);
	assert.deepEqual(h.key(LEGACY), { consume: true });
	assert.equal(h.captureStops, 1);
});

test("escape cancels an active dictation and is consumed; otherwise passes through", async () => {
	const h = harness();
	assert.equal(h.key(ESC), undefined);
	h.key(PRESS);
	await h.flush();
	assert.deepEqual(h.key(ESC), { consume: true });
	assert.equal(h.sent.at(-1)?.t, "cancel");
	assert.equal(h.captureStops, 1);
	assert.equal(h.key(ESC), undefined, "nothing left to cancel");
	// The key machine was reset, so the next press starts fresh.
	h.tick(5000);
	h.key(PRESS);
	await h.flush();
	assert.equal(h.sent.filter((m) => m.t === "start").length, 2);
});

test("other keys are never touched", () => {
	const h = harness();
	assert.equal(h.key("a"), undefined);
	assert.equal(h.key("\x1b[97;5u"), undefined);
});

test("empty transcripts insert nothing and say so", async () => {
	const h = harness();
	h.key(PRESS);
	await h.flush();
	h.tick(1000);
	h.key(RELEASE);
	h.emit({ t: "final", id: h.lastId()!, text: "  " });
	await h.flush();
	assert.deepEqual(h.pasted, []);
	assert.ok(h.views.some((v) => v === "cancelled:no speech heard"), String(h.views));
});

test("an all-zero microphone is reported as a permission problem", async () => {
	const h = harness();
	h.key(PRESS);
	await h.flush();
	for (let i = 0; i < 20; i++) h.frame(0);
	assert.equal(h.captureStops, 1);
	assert.ok(h.views.some((v) => v?.startsWith("error:") && /microphone/.test(v)), String(h.views));
});

test("losing the daemon fails the dictation instead of hanging", async () => {
	const h = harness();
	h.key(PRESS);
	await h.flush();
	h.tick(1000);
	h.key(RELEASE);
	h.controller.onDaemonClosed();
	await h.flush();
	assert.ok(h.views.some((v) => v?.startsWith("error:")));
});

test("toggle() drives the same flow for the /voice command", async () => {
	const h = harness();
	h.controller.toggle();
	await h.flush();
	assert.equal(h.sent[0]?.t, "start");
	h.controller.toggle();
	assert.equal(h.sent.at(-1)?.t, "stop");
});

test("silent frames report the recorder's own hint when it has one", async () => {
	const h = harness("", { blockedHint: "click Allow for ffmpeg on the Mac" });
	h.key(PRESS);
	await h.flush();
	for (let i = 0; i < 20; i++) h.frame(0);
	assert.ok(h.views.includes("error:click Allow for ffmpeg on the Mac"), String(h.views));
});

test("a recorder that never delivers audio is stopped and explained", async () => {
	const h = harness("", { blockedHint: "click Allow for ffmpeg on the Mac", noAudioTimeoutMs: 20 });
	h.key(PRESS);
	await new Promise((done) => setTimeout(done, 60));
	assert.equal(h.captureStops, 1);
	assert.ok(h.views.includes("error:click Allow for ffmpeg on the Mac"), String(h.views));
});

test("audio arriving in time cancels the stall check", async () => {
	const h = harness("", { noAudioTimeoutMs: 20 });
	h.key(PRESS);
	h.frame();
	await new Promise((done) => setTimeout(done, 60));
	assert.equal(h.captureStops, 0);
	assert.ok(!h.views.some((v) => v?.startsWith("error:")), String(h.views));
	h.controller.cancel();
});

test("the input device name reaches the indicator", async () => {
	const h = harness("", { device: "MacBook Pro Microphone" });
	h.key(PRESS);
	await h.flush();
	assert.equal(h.states.at(-1)?.device, "MacBook Pro Microphone");
	h.controller.cancel();
});

test("finished chunks start typing in at release, before the last chunk decodes", async () => {
	const h = harness("note:");
	h.key(PRESS);
	await h.flush();
	h.frame();
	const id = h.lastId()!;
	h.emit({ t: "chunk", id, index: 0, state: "queued", ms: 3000 });
	h.emit({ t: "chunk", id, index: 0, state: "done", text: "first part of the thought" });
	h.tick(4000);
	h.key(PRESS);
	assert.ok(h.pasted.length > 0 && " first part of the thought".startsWith(h.pasted.join("")), String(h.pasted));
	h.emit({ t: "chunk", id, index: 1, state: "queued", ms: 800 });
	h.emit({ t: "chunk", id, index: 1, state: "done", text: "and the rest" });
	h.emit({ t: "final", id, text: "first part of the thought and the rest" });
	await h.flush();
	h.tick(400);
	assert.equal(h.pasted.join(""), " first part of the thought and the rest");
	assert.equal(h.views.at(-1), undefined, "the row hides as soon as the last word is in");
	assert.ok(!h.views.some((v) => v?.startsWith("inserted:")), String(h.views));
});

test("escape while the text is typing in drops the rest", async () => {
	const h = harness();
	h.key(PRESS);
	await h.flush();
	h.frame();
	const id = h.lastId()!;
	const long = Array.from({ length: 80 }, (_, i) => `w${i}`).join(" ");
	h.emit({ t: "chunk", id, index: 0, state: "done", text: long });
	h.tick(4000);
	h.key(PRESS);
	h.tick(20);
	assert.deepEqual(h.key(ESC), { consume: true });
	const typed = h.pasted.join("");
	h.emit({ t: "final", id, text: long });
	await h.flush();
	h.tick(1000);
	assert.equal(h.pasted.join(""), typed);
	assert.ok(typed.length < long.length);
});

test("escape while waiting on the model after stop discards the dictation", async () => {
	const h = harness();
	h.key(PRESS);
	await h.flush();
	h.frame();
	const id = h.lastId()!;
	h.emit({ t: "status", state: "loading", backend: "cpu", model: "parakeet 0.6b-v3" });
	h.emit({ t: "chunk", id, index: 0, state: "queued", ms: 1000 });
	h.tick(4000);
	h.key(PRESS);
	h.tick(20_000);
	assert.equal(h.states.at(-1)?.phase, "finishing");
	assert.equal(h.states.at(-1)?.loadingModel, true);
	assert.deepEqual(h.key(ESC), { consume: true });
	assert.equal(h.sent.at(-1)?.t, "cancel");
	assert.equal(h.states.findLast(Boolean)?.phase, "cancelled");
	h.emit({ t: "status", state: "ready", backend: "cpu", model: "parakeet 0.6b-v3" });
	h.emit({ t: "final", id, text: "too late" });
	await h.flush();
	h.tick(1000);
	assert.deepEqual(h.pasted, []);
	assert.equal(h.key(ESC), undefined, "nothing left to cancel");
});

test("a failure after release still inserts what was already transcribed", async () => {
	const h = harness();
	h.key(PRESS);
	await h.flush();
	h.frame();
	const id = h.lastId()!;
	h.emit({ t: "chunk", id, index: 0, state: "done", text: "the first half survives" });
	h.tick(4000);
	h.key(PRESS);
	h.emit({ t: "error", id, message: "transcription timed out" });
	await h.flush();
	h.tick(1000);
	assert.equal(h.pasted.join(""), "the first half survives");
	assert.match(h.views.at(-1) ?? "", /^error:transcription timed out, kept what was transcribed/);
});

test("losing the daemon mid-recording stops the mic and keeps finished chunks", async () => {
	const h = harness();
	h.key(PRESS);
	await h.flush();
	h.frame();
	const id = h.lastId()!;
	h.emit({ t: "chunk", id, index: 0, state: "done", text: "said before the crash" });
	h.controller.onDaemonClosed();
	await h.flush();
	h.tick(1000);
	assert.equal(h.captureStops, 1);
	assert.equal(h.controller.isRecording, false);
	assert.equal(h.pasted.join(""), "said before the crash");
	assert.match(h.views.at(-1) ?? "", /^error:voice daemon disconnected, kept/);
});

test("a failure with nothing transcribed inserts nothing", async () => {
	const h = harness();
	h.key(PRESS);
	await h.flush();
	h.frame();
	h.tick(1000);
	h.key(PRESS);
	h.emit({ t: "error", id: h.lastId()!, message: "transcription timed out" });
	await h.flush();
	h.tick(1000);
	assert.deepEqual(h.pasted, []);
	assert.equal(h.views.at(-1), "error:transcription timed out");
});

test("recording stops by itself when setup has buffered the maximum, keeping the audio", async () => {
	const h = harness("", { connect: () => new Promise(() => {}) });
	h.key(PRESS);
	await h.flush();
	for (let i = 0; i < 3000; i++) h.frame();
	assert.equal(h.captureStops, 1);
	assert.equal(h.controller.isRecording, false);
	assert.equal(h.states.at(-1)?.phase, "finishing");
	assert.match(h.states.at(-1)?.message ?? "", /5 minutes/);
});

test("an all-zero mic suggests picking another one", async () => {
	const h = harness("", { device: "Jump Desktop Microphone" });
	h.key(PRESS);
	await h.flush();
	for (let i = 0; i < 20; i++) h.frame(0);
	assert.match(h.views.at(-1) ?? "", /^error:no sound from Jump Desktop Microphone: .*\/voice mic/);
});
