import { test } from "node:test";
import assert from "node:assert/strict";
import { LineDecoder, MAX_LINE_BYTES, encodeMessage, parseDaemonEvent, pcmToBase64 } from "../lib/voice/protocol.ts";

test("messages are newline-delimited JSON", () => {
	assert.equal(encodeMessage({ t: "stop", id: 3 }), '{"t":"stop","id":3}\n');
});

test("decoder reassembles lines split across chunks", () => {
	const decoder = new LineDecoder();
	assert.deepEqual(decoder.push(Buffer.from('{"t":"status","state":"lo')), []);
	assert.deepEqual(decoder.push(Buffer.from('ading"}\n{"t":"final","id":1,"text":"hi"}\n')), [
		{ t: "status", state: "loading" },
		{ t: "final", id: 1, text: "hi" },
	]);
});

test("decoder skips malformed lines instead of throwing", () => {
	const decoder = new LineDecoder();
	assert.deepEqual(decoder.push(Buffer.from('not json\n{"t":"x"}\n')), [{ t: "x" }]);
});

test("decoder drops an oversized line and recovers", () => {
	const decoder = new LineDecoder();
	decoder.push(Buffer.alloc(MAX_LINE_BYTES + 10, 0x61));
	assert.deepEqual(decoder.push(Buffer.from('aaa\n{"t":"ok"}\n')), [{ t: "ok" }]);
});

test("daemon events are validated by shape", () => {
	assert.deepEqual(parseDaemonEvent({ t: "status", state: "ready", backend: "mlx", model: "v3" }), { t: "status", state: "ready", backend: "mlx", model: "v3" });
	assert.deepEqual(parseDaemonEvent({ t: "vad", id: 1, speaking: true }), { t: "vad", id: 1, speaking: true });
	assert.deepEqual(parseDaemonEvent({ t: "chunk", id: 1, index: 0, state: "done" }), { t: "chunk", id: 1, index: 0, state: "done" });
	assert.deepEqual(parseDaemonEvent({ t: "chunk", id: 1, index: 0, state: "queued", ms: 2400 }), { t: "chunk", id: 1, index: 0, state: "queued", ms: 2400 });
	assert.deepEqual(parseDaemonEvent({ t: "chunk", id: 1, index: 0, state: "done", text: "fix it" }), { t: "chunk", id: 1, index: 0, state: "done", text: "fix it" });
	assert.deepEqual(parseDaemonEvent({ t: "chunk", id: 1, index: 0, state: "done", text: 5, ms: "x" }), { t: "chunk", id: 1, index: 0, state: "done" }, "bad optional fields are dropped");
	assert.deepEqual(parseDaemonEvent({ t: "final", id: 2, text: "hello" }), { t: "final", id: 2, text: "hello" });
	assert.deepEqual(parseDaemonEvent({ t: "error", message: "boom" }), { t: "error", message: "boom" });
	assert.equal(parseDaemonEvent({ t: "chunk", id: 1, index: 0, state: "exploded" }), undefined);
	assert.equal(parseDaemonEvent({ t: "final", id: "1", text: "x" }), undefined);
	assert.equal(parseDaemonEvent(null), undefined);
});

test("PCM frames encode as little-endian base64", () => {
	assert.equal(pcmToBase64(new Int16Array([1, -1])), Buffer.from([1, 0, 0xff, 0xff]).toString("base64"));
});
