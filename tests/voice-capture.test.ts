import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameChunker, captureCommands, hasAudioInput, probeAudioInput, type AudioProbe } from "../lib/voice/capture.ts";
import { deviceProbeCommand, runDeviceProbe, systemProbe } from "../lib/voice/audio-input.ts";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinDictation, splitForPaste } from "../lib/voice/insert.ts";

test("Linux prefers PulseAudio tools, then ALSA", () => {
	const all = captureCommands("linux", () => true).map((c) => c.command);
	assert.deepEqual(all, ["parecord", "ffmpeg", "arecord"]);
	assert.deepEqual(captureCommands("linux", (bin) => bin === "arecord").map((c) => c.command), ["arecord"]);
});

test("macOS falls back to ffmpeg avfoundation only when installed", () => {
	assert.deepEqual(captureCommands("darwin", () => false), []);
	const [ffmpeg] = captureCommands("darwin", () => true);
	assert.equal(ffmpeg.command, "ffmpeg");
	assert.ok(ffmpeg.args.includes("avfoundation"));
	assert.ok(ffmpeg.args.includes(":default"));
	assert.ok(captureCommands("darwin", () => true, "USB Mic")[0]!.args.includes(":USB Mic"), "a chosen mic is opened by name");
});

test("every capture command emits raw 16 kHz mono s16le", () => {
	for (const { args } of captureCommands("linux", () => true)) {
		const joined = args.join(" ");
		assert.match(joined, /16000/);
		assert.match(joined, /s16le|S16_LE/);
	}
});

test("chunker regroups arbitrary byte chunks into fixed frames", () => {
	const frames: Int16Array[] = [];
	const chunker = new FrameChunker(4, (f) => frames.push(f));
	chunker.push(Buffer.from([1, 0, 2, 0, 3]));
	chunker.push(Buffer.from([0, 4, 0, 5, 0]));
	assert.deepEqual(frames.map((f) => [...f]), [[1, 2, 3, 4]]);
	chunker.push(Buffer.from([0xff, 0xff, 7, 0, 8, 0]));
	assert.deepEqual(frames.map((f) => [...f]), [[1, 2, 3, 4], [5, -1, 7, 8]]);
});

const PCM = "/proc/asound/pcm";
const OUTPUT_ONLY = "00-00: bcm2835 Headphones : bcm2835 Headphones : playback 8\n01-00: MAI PCM i2s-hifi-0 : MAI PCM i2s-hifi-0 : playback 1\n";
const WITH_MIC = "00-00: ALC892 Analog : ALC892 Analog : playback 1 : capture 1\n00-03: HDMI 0 : HDMI 0 : playback 1\n";

function linuxProbe(given: Record<string, string>, sources?: readonly string[], now = 0): AudioProbe & { asked: number; servers: string[]; files: Record<string, string> } {
	const files = { ...given };
	const probe = {
		asked: 0,
		servers: [] as string[],
		files,
		exists: (path: string) => path in files,
		read: (path: string) => files[path] ?? "",
		write: (path: string, text: string) => { files[path] = text; },
		sources: (server: string) => {
			probe.asked++;
			probe.servers.push(server);
			return sources;
		},
		now: () => now,
	};
	return probe;
}

test("Linux audio input needs a capture stream or a PulseAudio source, not just a sound card", () => {
	assert.equal(hasAudioInput("linux", {}, linuxProbe({})), false);
	assert.equal(hasAudioInput("linux", {}, linuxProbe({ [PCM]: OUTPUT_ONLY, "/proc/asound/cards": " 0 [Headphones ]: bcm2835" })), false, "an output-only card is no microphone");
	assert.equal(hasAudioInput("linux", {}, linuxProbe({ [PCM]: WITH_MIC })), true);
	const wslg = { "/mnt/wslg/PulseServer": "" };
	assert.equal(hasAudioInput("linux", {}, linuxProbe(wslg, ["RDPSink.monitor", "RDPSource"])), true, "WSLg's source is an input");
	assert.equal(hasAudioInput("linux", {}, linuxProbe(wslg, ["RDPSink.monitor"])), false, "a sink's monitor is output");
	assert.equal(hasAudioInput("linux", {}, linuxProbe(wslg, undefined)), false, "no answer from pactl decides nothing");
	const socket = linuxProbe({ "/run/user/1/pulse/native": "" }, ["alsa_input.usb-mic"]);
	assert.equal(hasAudioInput("linux", { XDG_RUNTIME_DIR: "/run/user/1" }, socket), true);
	assert.equal(hasAudioInput("linux", { PULSE_SERVER: "tcp:host" }, linuxProbe({}, ["auto_null.monitor"])), false);
	const quiet = linuxProbe({ [PCM]: OUTPUT_ONLY }, ["alsa_input.usb-mic"]);
	assert.equal(hasAudioInput("linux", {}, quiet), false);
	assert.equal(quiet.asked, 0, "without a PulseAudio socket, pactl is never run, so it cannot start a daemon");
	assert.equal(hasAudioInput("win32", {}, linuxProbe({ [PCM]: WITH_MIC })), false);
});

test("Linux asks only the server whose socket it found, and saves pactl's answer for a day", () => {
	const env = { PI_VOICE_HOME: "/voice", XDG_RUNTIME_DIR: "/run/user/1" };
	const socket = linuxProbe({ "/run/user/1/pulse/native": "" }, ["alsa_output.hdmi.monitor"], 1_000);
	assert.equal(hasAudioInput("linux", env, socket), false);
	assert.deepEqual(socket.servers, ["unix:/run/user/1/pulse/native"], "a named server turns libpulse's autospawn off, so a stale socket starts no daemon");
	assert.deepEqual(JSON.parse(socket.files["/voice/audio-input.json"]!), { input: false, at: 1_000 });
	assert.equal(hasAudioInput("linux", env, socket), false);
	assert.equal(socket.asked, 1, "the next session reads the saved answer and runs no pactl");
	const wslg = linuxProbe({ "/mnt/wslg/PulseServer": "" }, ["RDPSource"]);
	hasAudioInput("linux", { PI_VOICE_HOME: "/voice" }, wslg);
	assert.deepEqual(wslg.servers, ["unix:/mnt/wslg/PulseServer"]);
	const named = linuxProbe({}, ["mic"]);
	hasAudioInput("linux", { PI_VOICE_HOME: "/voice", PULSE_SERVER: "tcp:host" }, named);
	assert.deepEqual(named.servers, ["tcp:host"]);
	const unsaved = linuxProbe({ [PCM]: WITH_MIC });
	hasAudioInput("linux", { PI_VOICE_HOME: "/voice" }, unsaved);
	assert.equal(unsaved.files["/voice/audio-input.json"], undefined, "a capture stream needs no saved answer");
});

const HOME = "/voice";
const VERDICT = `${HOME}/audio-input.json`;
const DAY = 24 * 60 * 60 * 1000;

function macProbe(cache: string | undefined, now = 10 * DAY): AudioProbe {
	return { exists: (path) => path === VERDICT && cache !== undefined, read: () => cache ?? "", write: () => {}, sources: () => undefined, now: () => now };
}

test("macOS trusts only a fresh probe verdict, and otherwise decides nothing", () => {
	const env = { PI_VOICE_HOME: HOME };
	assert.equal(hasAudioInput("darwin", env, macProbe(undefined)), false, "no verdict yet: no automatic download");
	assert.equal(hasAudioInput("darwin", env, macProbe(JSON.stringify({ input: true, at: 10 * DAY - 1_000 }))), true);
	assert.equal(hasAudioInput("darwin", env, macProbe(JSON.stringify({ input: false, at: 10 * DAY - 1_000 }))), false);
	assert.equal(hasAudioInput("darwin", env, macProbe(JSON.stringify({ input: true, at: 8 * DAY }))), false, "a verdict older than a day is stale");
	assert.equal(hasAudioInput("darwin", env, macProbe(JSON.stringify({ input: true, at: 11 * DAY }))), false, "a verdict from the future is stale");
	assert.equal(hasAudioInput("darwin", env, macProbe("{not json")), false);
	assert.equal(hasAudioInput("darwin", env, macProbe(JSON.stringify({ input: "yes", at: 10 * DAY }))), false);
});

function probeDeps(cache?: string) {
	const written: Array<{ path: string; text: string }> = [];
	let done: ((devices: number | undefined) => void) | undefined;
	const deps = {
		...macProbe(cache),
		runs: 0,
		killed: 0,
		written,
		finish: (devices: number | undefined) => done!(devices),
		write: (path: string, text: string) => { written.push({ path, text }); },
		run: (callback: (devices: number | undefined) => void) => {
			deps.runs++;
			done = callback;
			return () => { deps.killed++; };
		},
	};
	return deps;
}

test("a macOS probe in the background saves its verdict and starts setup when it finds a microphone", () => {
	const env = { PI_VOICE_HOME: HOME };
	const found = probeDeps();
	let starts = 0;
	probeAudioInput("darwin", env, () => starts++, found);
	assert.equal(found.runs, 1, "no verdict: the probe starts");
	found.finish(2);
	assert.equal(starts, 1);
	assert.deepEqual(found.written.map((entry) => [entry.path, JSON.parse(entry.text)]), [[VERDICT, { input: true, at: 10 * DAY }]]);

	const none = probeDeps();
	probeAudioInput("darwin", env, () => starts++, none);
	none.finish(0);
	assert.equal(starts, 1, "no microphone: no setup");
	assert.deepEqual(JSON.parse(none.written[0]!.text), { input: false, at: 10 * DAY });

	const failed = probeDeps();
	probeAudioInput("darwin", env, () => starts++, failed);
	failed.finish(undefined);
	assert.equal(starts, 1);
	assert.deepEqual(failed.written, [], "a probe that fails or times out decides nothing and saves nothing");
});

test("a macOS probe is skipped with a fresh verdict, off macOS, and ends with the session", () => {
	const env = { PI_VOICE_HOME: HOME };
	const fresh = probeDeps(JSON.stringify({ input: false, at: 10 * DAY - 1_000 }));
	probeAudioInput("darwin", env, () => assert.fail("no setup"), fresh);
	assert.equal(fresh.runs, 0);
	const linux = probeDeps();
	probeAudioInput("linux", env, () => assert.fail("no setup"), linux);
	assert.equal(linux.runs, 0);

	const ended = probeDeps(JSON.stringify({ input: true, at: 0 }));
	const stop = probeAudioInput("darwin", env, () => assert.fail("no setup after the session ends"), ended);
	assert.equal(ended.runs, 1, "a stale verdict is probed again");
	stop();
	assert.equal(ended.killed, 1);
	ended.finish(1);
	assert.deepEqual(ended.written, []);
});

test("the device probe child reports its count, and is killed at its timeout", async () => {
	const count = await new Promise<number | undefined>((resolve) => runDeviceProbe(resolve, { command: process.execPath, args: ["-e", "process.stdout.write('3')"] }));
	assert.equal(count, 3);
	const garbage = await new Promise<number | undefined>((resolve) => runDeviceProbe(resolve, { command: process.execPath, args: ["-e", "process.stdout.write('lots')"] }));
	assert.equal(garbage, undefined);
	const started = Date.now();
	const hung = await new Promise<number | undefined>((resolve) => runDeviceProbe(resolve, { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, 300));
	assert.equal(hung, undefined);
	assert.ok(Date.now() - started < 5_000, "the timeout ends a hung probe");
	const notes: string[] = [];
	const missing = await new Promise<number | undefined>((resolve) => runDeviceProbe(resolve, { command: "/nonexistent/pi-extras-probe", args: [] }, 1_000, (note) => notes.push(note)));
	assert.equal(missing, undefined);
	assert.match(notes.join("\n"), /microphone check could not run: .*ENOENT/, "a probe that cannot start says why in the log");
});

test("dictation joins existing text with a single space", () => {
	assert.equal(joinDictation("", "hello"), "hello");
	assert.equal(joinDictation("fix the", "parser"), " parser");
	assert.equal(joinDictation("fix the ", "parser"), "parser");
	assert.equal(joinDictation("line\n", "next"), "next");
	assert.equal(joinDictation("x", "  spaced  "), " spaced");
	assert.equal(joinDictation("x", "   "), "");
});

test("long dictation is split below the paste-collapse threshold at word boundaries", () => {
	const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
	const pieces = splitForPaste(text, 900);
	assert.ok(pieces.length > 1);
	assert.ok(pieces.every((p) => p.length <= 900));
	assert.equal(pieces.join(""), text);
	assert.ok(pieces.slice(0, -1).every((p) => p.endsWith(" ")), "cuts land after a space");
	assert.deepEqual(splitForPaste("short", 900), ["short"]);
	assert.deepEqual(splitForPaste("x".repeat(20), 8), ["xxxxxxxx", "xxxxxxxx", "xxxx"]);
});

test("the device probe runs only under a plain node binary, never through Pi's own binary", () => {
	const node = { bun: false, sea: false, execPath: "/usr/local/bin/node" };
	assert.equal(deviceProbeCommand(node)?.command, "/usr/local/bin/node");
	assert.equal(deviceProbeCommand({ ...node, execPath: "C:\\Program Files\\nodejs\\node.exe" })?.command, "C:\\Program Files\\nodejs\\node.exe");
	assert.equal(deviceProbeCommand({ ...node, execPath: "/opt/homebrew/bin/nodejs" })?.command, "/opt/homebrew/bin/nodejs");
	assert.equal(deviceProbeCommand({ ...node, bun: true }), undefined, "a Bun binary would read -e as an extension");
	assert.equal(deviceProbeCommand({ ...node, sea: true }), undefined, "so would a single executable application");
	assert.equal(deviceProbeCommand({ ...node, execPath: "/Users/me/.local/bin/pi" }), undefined);
});

test("a verdict that cannot be saved leaves no temporary file behind", () => {
	const dir = mkdtempSync(join(tmpdir(), "audio-verdict-"));
	try {
		const target = join(dir, "audio-input.json");
		mkdirSync(join(target, "blocker"), { recursive: true });
		assert.throws(() => systemProbe.write(target, "{}"));
		assert.deepEqual(readdirSync(dir), ["audio-input.json"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
