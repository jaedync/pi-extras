/**
 * Runs the real Python daemon in --fake mode (energy VAD, stub ASR, stdlib
 * only) and drives it through the real socket client and dictation session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DaemonClient } from "../lib/voice/client.ts";
import { DictationSession } from "../lib/voice/session.ts";
import type { DaemonEvent } from "../lib/voice/protocol.ts";

const python = ["python3", "python"].find((bin) => spawnSync(bin, ["--version"]).status === 0);
const daemonPath = resolve(import.meta.dirname, "../lib/voice/daemon/voice_daemon.py");
const skip = python ? false : "python3 not available";

function tone(ms: number, amplitude: number): Int16Array {
	const samples = new Int16Array((16000 * ms) / 1000);
	for (let i = 0; i < samples.length; i++) samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / 16000));
	return samples;
}

function* frames(audio: Int16Array, size = 1600) {
	for (let i = 0; i < audio.length; i += size) yield audio.subarray(i, i + size);
}

function setup(extra: string[] = []) {
	// Short path: macOS limits Unix socket paths to 104 bytes.
	const home = mkdtempSync(join(tmpdir(), "pv-"));
	mkdirSync(join(home, "sessions"), { recursive: true });
	writeFileSync(join(home, "sessions", String(process.pid)), "");
	const children: ChildProcess[] = [];
	const spawnDaemon = () => {
		const child = spawn(python!, [daemonPath, "--home", home, "--fake", "--idle-exit", "1", ...extra], { stdio: ["ignore", "ignore", "pipe"] });
		children.push(child);
	};
	const cleanup = () => {
		for (const child of children) child.kill("SIGTERM");
		rmSync(home, { recursive: true, force: true });
	};
	return { home, spawnDaemon, cleanup, children };
}

test("dictation round trip through the fake daemon", { skip, timeout: 20_000 }, async () => {
	const { home, spawnDaemon, cleanup } = setup();
	try {
		const client = new DaemonClient({ socketPath: join(home, "daemon.sock"), spawnDaemon });
		const session = new DictationSession({ id: 1, now: Date.now, onChange: () => {} });
		const events: DaemonEvent[] = [];
		client.onEvent = (event) => {
			events.push(event);
			session.handleEvent(event);
		};
		// Speech, pause, speech: two chunks, the pause kept as lead-in to the second.
		const audio = [tone(800, 8000), new Int16Array(16000 * 0.6), tone(500, 8000), new Int16Array(16000 * 0.2)];
		for (const part of audio) for (const f of frames(part)) session.pushFrame(f);
		await client.connect();
		session.attach(client);
		const text = await session.stop();
		assert.equal(text, "<0.8s> <1.3s>");
		assert.deepEqual(session.view.chunks.map((c) => c.state), ["done", "done"]);
		const chunkEvents = events.filter((e) => e.t === "chunk");
		assert.ok(chunkEvents.filter((e) => e.state === "queued").every((e) => e.ms! > 0), "queued chunks carry their audio length");
		assert.deepEqual(chunkEvents.filter((e) => e.state === "done").map((e) => e.text), ["<0.8s>", "<1.3s>"]);
		assert.equal(session.readyText(), text);
		client.close();
	} finally {
		cleanup();
	}
});

test("audio recorded while the model is still loading is transcribed once it loads", { skip, timeout: 20_000 }, async () => {
	const { home, spawnDaemon, cleanup } = setup(["--load-delay", "1.5"]);
	try {
		const client = new DaemonClient({ socketPath: join(home, "daemon.sock"), spawnDaemon });
		const session = new DictationSession({ id: 1, now: Date.now, onChange: () => {} });
		const states: string[] = [];
		client.onEvent = (event) => {
			if (event.t === "status") states.push(event.state);
			session.handleEvent(event);
		};
		await client.connect();
		session.attach(client);
		const audio = [tone(800, 8000), new Int16Array(16000 * 0.6), tone(500, 8000), new Int16Array(16000 * 0.2)];
		for (const part of audio) for (const f of frames(part)) session.pushFrame(f);
		// Both chunks are queued and the recording stopped before the model is ready.
		const text = await session.stop();
		assert.equal(states[0], "loading");
		assert.equal(text, "<0.8s> <1.3s>");
		client.close();
	} finally {
		cleanup();
	}
});

test("status reports loading while a model swap holds up decoding", { skip, timeout: 20_000 }, () => {
	const home = mkdtempSync(join(tmpdir(), "pv-"));
	try {
		const script = `
import sys
sys.path.insert(0, ${JSON.stringify(dirname(daemonPath))})
import voice_daemon as vd
d = vd.Daemon(sys.argv[1], True)
d.asr, d.asr_tier = vd.FakeAsr(), "fake"
before = d.status()["state"]
d.loading = True
print(before, d.status()["state"])
`;
		const run = spawnSync(python!, ["-c", script, home], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout.trim(), "ready loading");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

/** Feeds `parts` (seconds, amplitude) through the daemon's chunker with the energy VAD. */
function chunk(parts: [number, number][]) {
	const script = `
import json, math, sys
from array import array
sys.path.insert(0, ${JSON.stringify(dirname(daemonPath))})
import voice_daemon as vd
SR = vd.SAMPLE_RATE
audio = array("f")
for seconds, amp in json.loads(sys.argv[1]):
    audio += array("f", (amp * math.sin(2 * math.pi * 220 * i / SR) for i in range(int(seconds * SR))))
audio = audio[: len(audio) - len(audio) % vd.VAD_WINDOW]
chunker = vd.Chunker(vd.EnergyVad())
chunks = []
step = 3 * vd.VAD_WINDOW
for i in range(0, len(audio), step):
    chunker.accept(audio[i : i + step])
    chunks += chunker.take(False)
chunker.vad.flush()
chunks += chunker.take(True)
audible = lambda s: sum(1 for x in s if abs(x) > 0.001)
print(json.dumps({"seconds": [len(c) / SR for c in chunks], "audible": sum(audible(c) for c in chunks), "all_audible": audible(audio), "held": len(chunker.audio or [])}))
`;
	const run = spawnSync(python!, ["-c", script, JSON.stringify(parts)], { encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	return JSON.parse(run.stdout) as { seconds: number[]; audible: number; all_audible: number; held: number };
}

test("pauses cut chunks without dropping a word too quiet for the VAD", { skip, timeout: 20_000 }, () => {
	// Phrase, pause, a soft "the" the VAD scores as silence, then the next phrase and a trailing pause.
	const result = chunk([[1, 0.25], [0.6, 0], [0.3, 0.015], [0.05, 0], [1, 0.25], [0.6, 0]]);
	assert.equal(result.seconds.length, 2);
	assert.equal(result.audible, result.all_audible, "every audible sample reaches a chunk");
	const decoded = result.seconds.reduce((a, b) => a + b, 0);
	assert.ok(decoded < 3.5, `the trailing pause alone is not decoded (${decoded}s)`);
});

test("a long pause keeps at most one second of lead-in and is not held in memory", { skip, timeout: 20_000 }, () => {
	const result = chunk([[1, 0.25], [8, 0], [1, 0.25], [0.6, 0]]);
	assert.equal(result.seconds.length, 2);
	assert.equal(result.audible, result.all_audible);
	assert.ok(result.seconds[1]! <= 2.1, `second chunk ${result.seconds[1]}s`);
	assert.equal(result.held, 0, "nothing left once finished");
});

test("a second daemon exits when one already holds the lock", { skip, timeout: 20_000 }, async () => {
	const { home, spawnDaemon, cleanup, children } = setup();
	try {
		const client = new DaemonClient({ socketPath: join(home, "daemon.sock"), spawnDaemon });
		await client.connect();
		const second = spawn(python!, [daemonPath, "--home", home, "--fake"], { stdio: "ignore" });
		const code = await new Promise<number | null>((done) => second.on("exit", done));
		assert.equal(code, 0);
		assert.equal(children.length, 1);
		client.close();
	} finally {
		cleanup();
	}
});

test("daemon exits once no Pi session lease is alive", { skip, timeout: 30_000 }, async () => {
	const { home, spawnDaemon, cleanup, children } = setup();
	try {
		const client = new DaemonClient({ socketPath: join(home, "daemon.sock"), spawnDaemon });
		await client.connect();
		client.close();
		// Replace our live lease with a pid that cannot exist.
		rmSync(join(home, "sessions", String(process.pid)));
		writeFileSync(join(home, "sessions", "999999"), "");
		const code = await new Promise<number | null>((done) => children[0].on("exit", done));
		assert.equal(code, 0);
		assert.equal(existsSync(join(home, "daemon.sock")), false);
		assert.equal(existsSync(join(home, "sessions", "999999")), false, "dead lease pruned");
	} finally {
		cleanup();
	}
});

test("daemon exits after going unused even while a Pi session stays connected", { skip, timeout: 30_000 }, async () => {
	const { home, spawnDaemon, cleanup, children } = setup(["--unused-exit", "1"]);
	try {
		const client = new DaemonClient({ socketPath: join(home, "daemon.sock"), spawnDaemon });
		let closed = false;
		client.onClose = () => (closed = true);
		await client.connect();
		const code = await new Promise<number | null>((done) => children[0].on("exit", done));
		assert.equal(code, 0);
		assert.equal(existsSync(join(home, "sessions", String(process.pid))), true, "the lease was still alive");
		await new Promise((done) => setTimeout(done, 100));
		assert.equal(closed, true, "the session hears it and starts a new daemon on next use");
	} finally {
		cleanup();
	}
});

test("a dictation in progress keeps an unused-timeout daemon alive", { skip, timeout: 30_000 }, async () => {
	const { home, spawnDaemon, cleanup, children } = setup(["--unused-exit", "1"]);
	try {
		const client = new DaemonClient({ socketPath: join(home, "daemon.sock"), spawnDaemon });
		await client.connect();
		const session = new DictationSession({ id: 1, now: Date.now, onChange: () => {} });
		session.attach(client);
		client.onEvent = (event) => session.handleEvent(event);
		// Hold a silent recording open for three timeouts, sending audio like a live mic.
		for (let i = 0; i < 30; i++) {
			session.pushFrame(new Int16Array(1600));
			await new Promise((done) => setTimeout(done, 100));
		}
		assert.equal(children[0].exitCode, null, "still running");
		client.close();
	} finally {
		cleanup();
	}
});
