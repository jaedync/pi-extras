/**
 * The sound floor: a film is not quiet for a quarter of its length, does not
 * jump 20 LU over its own floor, has no long digital silence, has a music bed
 * unless the storyboard says why not, and uses no sound the owner rejected.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMomentary, silenceRuns, soundFloor } from "../skills/walkthrough-video/scripts/film/audio.mjs";
import { soundDefects } from "../skills/walkthrough-video/scripts/film/check.mjs";
import { formatReport } from "../skills/walkthrough-video/scripts/film/measure.mjs";
import { normalizeStoryboard } from "../skills/walkthrough-video/scripts/film/storyboard.mjs";

const WV = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "walkthrough-video", "scripts", "wv.mjs");
import { loadRejected, rejectedCues } from "../skills/walkthrough-video/scripts/lib/rejected.mjs";

const kinds = (defects) => defects.map((d) => d.kind);
const sb = (extra = {}, shot = {}) => normalizeStoryboard({ fps: 60, shots: [{ id: "a", seconds: 5 }, { id: "b", seconds: 5, ...shot }], ...extra });
/** Momentary loudness every 100 ms: `level(t)` LUFS for t from 0 to `seconds`. */
const series = (seconds, level) => Array.from({ length: Math.round(seconds * 10) }, (_, i) => ({ t: (i + 1) / 10, m: level((i + 1) / 10) }));

test("ebur128 lines become momentary loudness points", () => {
	const text = "[Parsed_ebur128_0 @ 0x1] t: 0.0999792  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS\n[Parsed_ebur128_0 @ 0x1] t: 0.499979   TARGET:-23 LUFS    M: -18.2 S:-20.1     I: -19.0 LUFS\n  Summary:\n  I: -16 LUFS";
	assert.deepEqual(parseMomentary(text), [{ t: 0.1, m: -120.7 }, { t: 0.5, m: -18.2 }]);
});

test("the sound floor: the share under -30 LUFS and the largest jump over the 3 s floor", () => {
	const bed = soundFloor(series(10, (t) => (t > 6 && t < 6.5 ? -10 : -20)));
	assert.equal(bed.quietShare, 0);
	assert.ok(Math.abs(bed.jumpLu - 10) < 0.01);
	const roomTone = soundFloor(series(10, (t) => (t > 9 ? -9 : -45)));
	assert.ok(roomTone.quietShare > 0.85);
	assert.ok(Math.abs(roomTone.jumpLu - 36) < 0.01);
	assert.ok(Math.abs(roomTone.jumpAt - 9.1) < 0.01);
});

test("digital silence runs come from 100 ms windows under -60 dBFS", () => {
	const levels = [-20, -90, -90, -90, -200, -30, -61, -61, -20];
	const runs = silenceRuns(levels, 0.1);
	assert.deepEqual(runs.map((r) => [Number(r.from.toFixed(2)), Number(r.to.toFixed(2))]), [[0.1, 0.5], [0.6, 0.8]]);
});

test("a quiet film, a loud jump and long silence are defects; a film with music: { none } gets notes for the first two", () => {
	const quiet = { quietShare: 0.75, jumpLu: 36, jumpAt: 23.4, silence: [{ from: 1, to: 3.2 }], bed: false };
	assert.deepEqual(kinds(soundDefects(quiet, sb())).sort(), ["loudness_jump", "no_bed", "quiet_sound", "silence"]);
	const none = soundDefects(quiet, sb({ music: { none: "the owner asked for app sounds only" } }));
	assert.deepEqual(kinds(none).sort(), ["silence"]);
	const good = { quietShare: 0.04, jumpLu: 7, jumpAt: 1, silence: [{ from: 0, to: 0.5 }], bed: true };
	assert.deepEqual(soundDefects(good, sb()), []);
	for (const d of soundDefects(quiet, sb())) assert.match(d.fix, /\w/);
	assert.match(soundDefects(quiet, sb()).find((d) => d.kind === "no_bed").fix, /wv sound score/);
});

test("silence inside a shot that declares it is not a defect", () => {
	const facts = { quietShare: 0, jumpLu: 0, silence: [{ from: 6, to: 8 }], bed: true };
	assert.deepEqual(kinds(soundDefects(facts, sb())), ["silence"]);
	assert.deepEqual(soundDefects(facts, sb({}, { silence: true })), []);
});

test("an unknown bed (no mix report) is not a defect", () => {
	assert.deepEqual(soundDefects({ quietShare: 0, jumpLu: 0, silence: [], bed: null }, sb()), []);
});

test("wv sound mix refuses to mix when the owner's list does not parse", () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-rej-mix-"));
	try {
		const list = join(dir, "rejected-sounds.json");
		writeFileSync(list, '{ "names": ["x"], }');
		mkdirSync(join(dir, "sfx"), { recursive: true });
		const cues = join(dir, "cues.json");
		writeFileSync(cues, JSON.stringify({ duration: 2, cues: [{ t: 0.5, sound: "x.wav", peak: -12 }] }));
		const r = spawnSync(process.execPath, [WV, "sound", "mix", cues, "--sfx", join(dir, "sfx"), "--out", join(dir, "m.wav")], { encoding: "utf8", env: { ...process.env, WV_REJECTED_SOUNDS: list } });
		assert.equal(r.status, 1, r.stderr);
		assert.match(r.stderr, /rejected-sounds\.json/);
		assert.match(r.stderr, /Fix the file/);
		assert.equal(existsSync(join(dir, "m.wav")), false, "no master is written");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a user list that is not valid JSON is reported, not dropped in silence", () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-rej-bad-"));
	try {
		const file = join(dir, "rejected-sounds.json");
		writeFileSync(file, '{ "names": ["from-user-list.wav"], }');
		const said = [];
		const list = loadRejected({ WV_REJECTED_SOUNDS: file }, dir, (line) => said.push(line));
		assert.ok(!list.names.includes("from-user-list.wav"), "the broken list adds nothing");
		assert.ok(said.length === 1, `one message: ${JSON.stringify(said)}`);
		assert.match(said[0], /rejected-sounds\.json/);
		assert.match(said[0], /JSON/i);
		// A good list stays quiet.
		writeFileSync(file, JSON.stringify({ names: ["reveal-0*.wav"], why: "cheap" }));
		const quiet = [];
		const good = loadRejected({ WV_REJECTED_SOUNDS: file }, dir, (line) => quiet.push(line));
		assert.deepEqual(quiet, []);
		assert.ok(good.names.includes("reveal-0*.wav"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the owner's rejected sounds match by file name or by content", () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-rej-"));
	try {
		writeFileSync(join(dir, "ding.wav"), "same bytes");
		writeFileSync(join(dir, "card-01.wav"), "other");
		const rejected = { names: ["reveal-0*.wav"], sha256: [createHash("sha256").update("same bytes").digest("hex")] };
		const cues = [{ file: "reveal-02.wav" }, { file: "ding.wav" }, { file: "card-01.wav" }];
		assert.deepEqual(rejectedCues(cues, dir, rejected).map((c) => c.file), ["reveal-02.wav", "ding.wav"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	const list = loadRejected({});
	assert.ok(list.names.includes("reveal-0*.wav"));
	assert.equal(list.sha256.length, 4);
});

test("a rejected sound in the mix is a defect", () => {
	const defects = soundDefects({ quietShare: 0, jumpLu: 0, silence: [], bed: true, rejected: [{ file: "reveal-01.wav", t: 9.2, why: "stock confirmation chime" }] }, sb());
	assert.deepEqual(kinds(defects), ["rejected_sound"]);
	assert.match(defects[0].message, /reveal-01\.wav/);
});

test("wv measure prints the quiet share, the jump and the digital silence", () => {
	const text = formatReport({ duration: 26, cuts: 9, quietShare: 0.75, jumpLu: 36, silenceShare: 0.66, silenceLongestS: 4 });
	assert.match(text, /under -30 LUFS momentary\s+75 %/);
	assert.match(text, /momentary jump over 3 s floor LU\s+36\.0/);
	assert.match(text, /digital silence\s+66 %/);
	assert.match(text, /longest digital silence s\s+4\.0/);
});
