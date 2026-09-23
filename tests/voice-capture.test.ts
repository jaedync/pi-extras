import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameChunker, captureCommands, hasAudioInput } from "../lib/voice/capture.ts";
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

test("audio input detection: WSLg pulse, pulse socket, ALSA card, or nothing", () => {
	const none = { exists: () => false, read: () => "" };
	assert.equal(hasAudioInput("linux", {}, none), false);
	assert.equal(hasAudioInput("linux", {}, { exists: (p) => p === "/mnt/wslg/PulseServer", read: () => "" }), true);
	assert.equal(hasAudioInput("linux", { XDG_RUNTIME_DIR: "/run/user/1" }, { exists: (p) => p === "/run/user/1/pulse/native", read: () => "" }), true);
	assert.equal(hasAudioInput("linux", { PULSE_SERVER: "tcp:host" }, none), true);
	assert.equal(hasAudioInput("linux", {}, { exists: (p) => p === "/proc/asound/cards", read: () => " 0 [PCH ]: HDA-Intel" }), true);
	assert.equal(hasAudioInput("linux", {}, { exists: (p) => p === "/proc/asound/cards", read: () => "--- no soundcards ---" }), false);
	assert.equal(hasAudioInput("darwin", {}, none), true);
	assert.equal(hasAudioInput("win32", {}, none), false);
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
