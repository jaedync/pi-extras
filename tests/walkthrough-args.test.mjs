import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { UsageError, parseCommandLine, usageText } from "../skills/walkthrough-video/scripts/lib/args.mjs";

const WV = fileURLToPath(new URL("../skills/walkthrough-video/scripts/wv.mjs", import.meta.url));
const SETUP = fileURLToPath(new URL("../skills/walkthrough-video/scripts/lib/setup.mjs", import.meta.url));

test("the setup messages name every package it installs and do not tell the user to delete a file that is gone", async () => {
	const setup = await import("../skills/walkthrough-video/scripts/lib/setup.mjs").catch(() => null);
	assert.ok(setup, `setup.mjs is at ${SETUP}`);
	const names = setup.pythonPackageNames();
	for (const name of ["kokoro-onnx", "soundfile", "numpy", "onnxruntime", "opencv-python-headless", "scipy", "mido", "pedalboard"]) assert.ok(names.includes(name), `${name} is in the install message: ${names.join(", ")}`);
	assert.doesNotMatch(setup.checksumMismatch("/x/kokoro.onnx", "abc123"), /Delete it/);
	assert.match(setup.checksumMismatch("/x/kokoro.onnx", "abc123"), /abc123/);
});

test("wv runs when it is reached through a symlink, as a link in ~/bin is", () => {
	// The real path of the file and the path of the link differ; a check on the paths alone
	// makes wv a silent no-op that exits 0, and an agent reads that as a pass.
	const dir = mkdtempSync(join(tmpdir(), "wv-link-"));
	const link = join(dir, "wv");
	symlinkSync(WV, link);
	const r = spawnSync(process.execPath, [link, "--help"], { encoding: "utf8", timeout: 60000 });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /wv/, "the help text, not an empty output");
	assert.ok(r.stdout.trim().length > 20, `stdout was ${JSON.stringify(r.stdout)}`);
});

test("setup takes no positional arguments", () => {
	assert.deepEqual(parseCommandLine(["setup"]), { command: "setup", check: false, json: false, music: false });
});

test("setup accepts --check and --json", () => {
	assert.deepEqual(parseCommandLine(["setup", "--check", "--json"]), { command: "setup", check: true, json: true, music: false });
	assert.deepEqual(parseCommandLine(["setup", "--music"]), { command: "setup", check: false, json: false, music: true });
});

test("capture fills the documented defaults", () => {
	const parsed = parseCommandLine(["capture", "flow.mjs", "--out", "out/first"]);
	assert.equal(parsed.command, "capture");
	assert.equal(parsed.flow, "flow.mjs");
	assert.equal(parsed.out, "out/first");
	assert.equal(parsed.fps, 60);
	assert.equal(parsed.scale, 2);
	assert.equal(parsed.width, 1280);
	assert.equal(parsed.height, 720);
	assert.equal(parsed.gpu, "auto");
	assert.equal(parsed.crf, 12);
});

test("capture reads every option", () => {
	const parsed = parseCommandLine(["capture", "flow.mjs", "--out", "o", "--fps", "30", "--scale", "1", "--width", "1920", "--height", "1080", "--gpu", "off", "--crf", "18"]);
	assert.equal(parsed.fps, 30);
	assert.equal(parsed.scale, 1);
	assert.equal(parsed.width, 1920);
	assert.equal(parsed.crf, 18);
	assert.equal(parsed.gpu, "off");
});

test("an unknown option fails with a message that names it", () => {
	assert.throws(() => parseCommandLine(["capture", "flow.mjs", "--out", "o", "--fps", "60", "--fpps", "30"]), (error) => error instanceof UsageError && /fpps/.test(error.message));
});

test("capture without --out fails", () => {
	assert.throws(() => parseCommandLine(["capture", "flow.mjs"]), /--out/);
});

test("capture without a flow fails", () => {
	assert.throws(() => parseCommandLine(["capture", "--out", "o"]), /flow/);
});

test("an fps outside 1 to 240 fails", () => {
	assert.throws(() => parseCommandLine(["capture", "f.mjs", "--out", "o", "--fps", "0"]), /--fps/);
	assert.throws(() => parseCommandLine(["capture", "f.mjs", "--out", "o", "--fps", "24.5"]), /--fps/);
});

test("a gpu mode other than auto, on or off fails", () => {
	assert.throws(() => parseCommandLine(["capture", "f.mjs", "--out", "o", "--gpu", "maybe"]), /auto/);
});

test("voice takes a script and an output directory", () => {
	const parsed = parseCommandLine(["voice", "script.json", "--out", "out/voice", "--speed", "1.1"]);
	assert.equal(parsed.command, "voice");
	assert.equal(parsed.script, "script.json");
	assert.equal(parsed.voice, "am_michael");
	assert.equal(parsed.speed, 1.1);
});

test("voice without a script fails", () => {
	assert.throws(() => parseCommandLine(["voice", "--out", "o"]), /script/);
});

test("gates needs a project and a capture directory", () => {
	assert.throws(() => parseCommandLine(["gates", "project"]), /--capture/);
	const parsed = parseCommandLine(["gates", "project", "--capture", "cap", "--json"]);
	assert.equal(parsed.project, "project");
	assert.equal(parsed.capture, "cap");
	assert.equal(parsed.json, true);
});

test("an unknown subcommand fails and lists the known ones", () => {
	assert.throws(() => parseCommandLine(["publish"]), (error) => /publish/.test(error.message) && /capture/.test(error.message));
});

test("no arguments asks for a subcommand", () => {
	assert.throws(() => parseCommandLine([]), /subcommand/);
});

test("--help anywhere prints help instead of running", () => {
	assert.deepEqual(parseCommandLine(["--help"]), { help: true });
	assert.deepEqual(parseCommandLine(["capture", "--help"]), { command: "capture", help: true });
});

test("usage text documents each subcommand and the flow API", () => {
	for (const command of ["setup", "capture", "voice", "gates"]) {
		const text = usageText(command);
		assert.match(text, new RegExp(`wv ${command}`), command);
	}
	assert.match(usageText("capture"), /--out/);
	assert.match(usageText("capture"), /page\.mouse|mouse/);
});

test("render and review answer --help instead of passing it to HyperFrames", () => {
	assert.deepEqual(parseCommandLine(["review", "--help"]), { command: "review", help: true });
	assert.deepEqual(parseCommandLine(["render", "proj", "-h"]), { command: "render", help: true });
});

test("wv review lists beat and phone sheets and folds the seam sheets into one line", async () => {
	const { sheetSummary } = await import("../skills/walkthrough-video/scripts/hf.mjs");
	const lines = sheetSummary(["/s/review-beats-1.jpg", "/s/review-seam-01.jpg", "/s/review-seam-02.jpg", "/s/review-phone-1.jpg"]);
	assert.deepEqual(lines, ["/s/review-beats-1.jpg", "/s/review-phone-1.jpg", "2 seam sheet(s): /s/review-seam-*.jpg"]);
});

test("capture samples the app's text on an interval only when --text-every asks for it", () => {
	assert.equal(parseCommandLine(["capture", "flow.mjs", "--out", "o"]).textEvery, 0);
	assert.equal(parseCommandLine(["capture", "flow.mjs", "--out", "o", "--text-every", "250"]).textEvery, 250);
	assert.throws(() => parseCommandLine(["capture", "flow.mjs", "--out", "o", "--text-every", "5"]), /--text-every/);
});

test("capture --draft is a cheap wall-clock pass: scale 1, real clock, 10 fps, and a contact sheet", () => {
	const draft = parseCommandLine(["capture", "flow.mjs", "--out", "o", "--draft", "--fps", "30", "--scale", "2"]);
	assert.equal(draft.draft, true);
	assert.equal(draft.scale, 1);
	assert.equal(draft.clock, "real");
	assert.equal(draft.fps, 10);
	assert.equal(parseCommandLine(["capture", "flow.mjs", "--out", "o"]).draft, false);
});
