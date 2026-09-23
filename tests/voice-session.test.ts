import { test } from "node:test";
import assert from "node:assert/strict";
import { DictationSession, type SessionTransport } from "../lib/voice/session.ts";
import type { ClientMessage } from "../lib/voice/protocol.ts";

function harness() {
	const sent: ClientMessage[] = [];
	let now = 0;
	const transport: SessionTransport = { send: (m) => sent.push(m) };
	const session = new DictationSession({ id: 7, now: () => now, onChange: () => {} });
	return { sent, session, transport, tick: (ms: number) => (now += ms) };
}

const frame = (value = 1000) => new Int16Array(1600).fill(value); // 100 ms

test("audio before the daemon connects is buffered and replayed in order", () => {
	const { sent, session, transport, tick } = harness();
	session.pushFrame(frame(1));
	tick(100);
	session.pushFrame(frame(2));
	assert.equal(sent.length, 0);
	assert.equal(session.view.phase, "connecting");
	assert.equal(session.view.queuedMs, 200);
	session.attach(transport);
	assert.deepEqual(sent.map((m) => m.t), ["start", "audio", "audio"]);
	assert.equal(session.view.queuedMs, 0);
	session.pushFrame(frame(3));
	assert.equal(sent.at(-1)?.t, "audio");
});

test("status loading then ready moves the phase", () => {
	const { session, transport } = harness();
	session.attach(transport);
	session.handleEvent({ t: "status", state: "loading", backend: "mlx" });
	assert.equal(session.view.phase, "loading");
	session.handleEvent({ t: "status", state: "ready", backend: "mlx", model: "parakeet 0.6b-v3" });
	assert.equal(session.view.phase, "recording");
	assert.equal(session.view.backend, "mlx");
	assert.equal(session.view.model, "parakeet 0.6b-v3");
});

test("vad and chunk events drive the chunk row", () => {
	const { session, transport, tick } = harness();
	session.attach(transport);
	session.handleEvent({ t: "vad", id: 7, speaking: true });
	assert.deepEqual(session.view.chunks.map((c) => c.state), ["filling"]);
	tick(3000);
	session.handleEvent({ t: "chunk", id: 7, index: 0, state: "queued" });
	session.handleEvent({ t: "vad", id: 7, speaking: false });
	assert.deepEqual(session.view.chunks.map((c) => c.state), ["queued"]);
	session.handleEvent({ t: "chunk", id: 7, index: 0, state: "decoding" });
	session.handleEvent({ t: "chunk", id: 7, index: 0, state: "done" });
	assert.deepEqual(session.view.chunks.map((c) => c.state), ["done"]);
});

test("a forced split while still speaking opens a new filling chunk", () => {
	const { session, transport, tick } = harness();
	session.attach(transport);
	session.handleEvent({ t: "vad", id: 7, speaking: true });
	tick(12_000);
	session.handleEvent({ t: "chunk", id: 7, index: 0, state: "queued" });
	const [first, second] = session.view.chunks;
	assert.equal(first.state, "queued");
	assert.equal(second.state, "filling");
	assert.equal(second.openedAt, 12_000);
});

test("events for other utterances are ignored", () => {
	const { session, transport } = harness();
	session.attach(transport);
	session.handleEvent({ t: "vad", id: 99, speaking: true });
	assert.equal(session.view.chunks.length, 0);
});

test("stop resolves with the final text", async () => {
	const { sent, session, transport } = harness();
	session.attach(transport);
	const result = session.stop();
	assert.equal(sent.at(-1)?.t, "stop");
	assert.equal(session.view.phase, "finishing");
	session.handleEvent({ t: "final", id: 7, text: "hello world" });
	assert.equal(await result, "hello world");
});

test("stopping before the daemon connects sends everything once attached", async () => {
	const { sent, session, transport } = harness();
	session.pushFrame(frame());
	const result = session.stop();
	session.attach(transport);
	assert.deepEqual(sent.map((m) => m.t), ["start", "audio", "stop"]);
	session.handleEvent({ t: "final", id: 7, text: "late" });
	assert.equal(await result, "late");
});

test("cancel rejects a pending stop and tells the daemon", async () => {
	const { sent, session, transport } = harness();
	session.attach(transport);
	const result = session.stop();
	session.cancel();
	assert.equal(sent.at(-1)?.t, "cancel");
	await assert.rejects(result, /cancelled/);
	assert.equal(session.view.phase, "cancelled");
});

test("daemon errors for this utterance fail the stop", async () => {
	const { session, transport } = harness();
	session.attach(transport);
	const result = session.stop();
	session.handleEvent({ t: "error", id: 7, message: "decoder crashed" });
	await assert.rejects(result, /decoder crashed/);
});

test("levels track input loudness, capped to the meter history", () => {
	const { session } = harness();
	for (let i = 0; i < 100; i++) session.pushFrame(frame(i % 2 ? 20000 : 0));
	assert.ok(session.view.levels.length <= 64);
	assert.ok(session.view.levels.at(-1)! > 0.5);
});

test("full-scale samples mark the moment of clipping", () => {
	const { session, tick } = harness();
	tick(500);
	session.pushFrame(frame(20_000));
	assert.equal(session.view.clippedAt, undefined);
	tick(100);
	session.pushFrame(frame(32_767));
	assert.equal(session.view.clippedAt, 600);
	tick(100);
	session.pushFrame(frame(-32_768));
	assert.equal(session.view.clippedAt, 700);
});

test("the input device is recorded on the view", () => {
	const { session } = harness();
	session.setDevice("MacBook Pro Microphone");
	assert.equal(session.view.device, "MacBook Pro Microphone");
});

test("ready text is the in-order transcript of finished chunks, skipping empty ones", () => {
	const { session, transport } = harness();
	session.attach(transport);
	const chunk = (index: number, state: "queued" | "decoding" | "done", text?: string) =>
		session.handleEvent({ t: "chunk", id: 7, index, state, ...(text === undefined ? {} : { text }) });
	chunk(0, "queued");
	chunk(1, "queued");
	chunk(2, "queued");
	assert.equal(session.readyText(), "");
	chunk(0, "done", "fix the");
	chunk(2, "done", "bug");
	assert.equal(session.readyText(), "fix the", "a gap stops the text");
	chunk(1, "done", "");
	assert.equal(session.readyText(), "fix the bug");
});

test("the wait estimate uses pending audio and this machine's measured decode speed", () => {
	const { session, transport, tick } = harness();
	session.attach(transport);
	session.handleEvent({ t: "chunk", id: 7, index: 0, state: "queued", ms: 2000 });
	assert.equal(session.estimateWaitMs(), 2000 / 20 + 50, "assumes 20x realtime before measuring");
	session.handleEvent({ t: "chunk", id: 7, index: 0, state: "decoding" });
	tick(50);
	session.handleEvent({ t: "chunk", id: 7, index: 0, state: "done", text: "a" });
	session.handleEvent({ t: "chunk", id: 7, index: 1, state: "queued", ms: 4000 });
	assert.equal(session.estimateWaitMs(), 4000 / 40 + 50, "measured 2 s in 50 ms");
});

test("speech still being captured at stop counts toward the wait", () => {
	const { session, transport, tick } = harness();
	session.attach(transport);
	session.handleEvent({ t: "vad", id: 7, speaking: true });
	tick(3000);
	void session.stop();
	assert.equal(session.estimateWaitMs(), 3000 / 20 + 50);
});

test("a mic that stays near-silent for 3 s is flagged quiet until it hears something", () => {
	const { session, transport } = harness();
	session.attach(transport);
	for (let i = 0; i < 29; i++) session.pushFrame(frame(20));
	assert.equal(session.view.quiet, undefined, "not yet: under 3 s of audio");
	session.pushFrame(frame(20));
	assert.equal(session.view.quiet, true);
	session.pushFrame(frame(1000));
	assert.equal(session.view.quiet, false);
	for (let i = 0; i < 60; i++) session.pushFrame(frame(0));
	assert.equal(session.view.quiet, false, "a pause after speech is not a dead mic");
});

test("room noise from a working mic is never flagged quiet", () => {
	const { session, transport } = harness();
	session.attach(transport);
	// -43 dBFS: the MacBook Pro microphone in a quiet room.
	for (let i = 0; i < 60; i++) session.pushFrame(frame(230));
	assert.notEqual(session.view.quiet, true);
});

test("audio buffered during setup is capped, and the cap is reported", () => {
	const { sent, session, transport } = harness();
	const fiveMinutes = 5 * 60 * 10;
	for (let i = 0; i < fiveMinutes - 1; i++) session.pushFrame(frame());
	assert.equal(session.bufferFull, false);
	session.pushFrame(frame());
	assert.equal(session.bufferFull, true);
	session.pushFrame(frame());
	assert.equal(session.view.queuedMs, 300_000, "nothing past the cap is kept");
	session.attach(transport);
	assert.equal(sent.filter((m) => m.t === "audio").length, fiveMinutes);
	assert.equal(session.bufferFull, false);
});

test("a note shows on the view without changing the phase", () => {
	const { session } = harness();
	session.note("setup is still running");
	assert.equal(session.view.message, "setup is still running");
	assert.equal(session.view.phase, "connecting");
});
