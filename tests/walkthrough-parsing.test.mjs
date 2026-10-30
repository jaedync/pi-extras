/**
 * Parsers that read text from outside the process: ffmpeg's signalstats
 * output and the narration script. No child process runs here.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { blankScanArgs, parseSignalStats } from "../skills/walkthrough-video/scripts/lib/gates-run.mjs";
import { downloadModel } from "../skills/walkthrough-video/scripts/lib/setup.mjs";
import { readScript } from "../skills/walkthrough-video/scripts/lib/voice.mjs";

const STATS = `frame:0    pts:0       pts_time:0
lavfi.signalstats.YMIN=16
lavfi.signalstats.YAVG=200.5
lavfi.signalstats.YMAX=235
frame:1    pts:1024    pts_time:0.1
lavfi.signalstats.YMIN=0
lavfi.signalstats.YMAX=12
`;

test("parseSignalStats reads one sample per frame, in capture seconds", () => {
	const samples = parseSignalStats(STATS, 2);
	assert.deepEqual(samples, [
		{ t: 2, ymin: 16, ymax: 235 },
		{ t: 2.1, ymin: 0, ymax: 12 },
	]);
});

test("parseSignalStats ignores lines it does not know and a frame with no stats", () => {
	const text = `${STATS}frame:2    pts:2048    pts_time:0.2\nlavfi.signalstats.YAVG=3\n`;
	const samples = parseSignalStats(text, 0);
	assert.equal(samples.length, 2, "the third frame has no YMIN or YMAX");
});

test("blankScanArgs seeks the input before decoding, not the filter output", () => {
	const args = blankScanArgs({ video: "capture.mp4", start: 0.5667, span: 2.5167, rate: 10 });
	assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "-ss must come before -i or the samples start at frame 0");
	assert.equal(args[args.indexOf("-ss") + 1], "0.5667");
	assert.equal(args[args.indexOf("-i") + 1], "capture.mp4");
	assert.match(args[args.indexOf("-vf") + 1], /^fps=10,signalstats,metadata=print:file=-$/);
});

test("parseSignalStats on empty output returns nothing", () => {
	assert.deepEqual(parseSignalStats("", 0), []);
});

function withScript(content, run) {
	const dir = mkdtempSync(join(tmpdir(), "wv-script-"));
	const file = join(dir, "script.json");
	writeFileSync(file, content);
	try {
		return run(file);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("readScript trims text and keeps ids", () => {
	const lines = withScript(JSON.stringify([{ id: "l1", text: "  Hello.  " }]), readScript);
	assert.deepEqual(lines, [{ id: "l1", text: "Hello." }]);
});

test("readScript refuses a duplicate id", () => {
	assert.throws(
		() => withScript(JSON.stringify([{ id: "l1", text: "a" }, { id: "l1", text: "b" }]), readScript),
		/duplicate id/,
	);
});

test("readScript refuses an id that is not a safe file name", () => {
	assert.throws(() => withScript(JSON.stringify([{ id: "../escape", text: "a" }]), readScript), /must match/);
});

test("readScript refuses empty text and an empty list", () => {
	assert.throws(() => withScript(JSON.stringify([{ id: "l1", text: " " }]), readScript), /non-empty string/);
	assert.throws(() => withScript("[]", readScript), /non-empty array/);
});

test("readScript names a file that is not JSON", () => {
	assert.throws(() => withScript("{oops", readScript), /cannot read/);
});

test("downloadModel writes a file whose SHA-256 matches the pin", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-model-"));
	try {
		const body = Buffer.from("kokoro model bytes");
		const url = `data:application/octet-stream;base64,${body.toString("base64")}`;
		const dest = join(dir, "model.onnx");
		await downloadModel(url, dest, createHash("sha256").update(body).digest("hex"));
		assert.equal(readFileSync(dest, "utf8"), "kokoro model bytes");
		assert.equal(existsSync(`${dest}.part`), false, "the .part file is renamed away");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("downloadModel refuses a file whose SHA-256 differs and leaves nothing behind", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-model-"));
	try {
		const url = `data:application/octet-stream;base64,${Buffer.from("wrong").toString("base64")}`;
		const dest = join(dir, "model.onnx");
		await assert.rejects(() => downloadModel(url, dest, "0".repeat(64)), /checksum mismatch/);
		assert.equal(existsSync(dest), false);
		assert.equal(existsSync(`${dest}.part`), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
