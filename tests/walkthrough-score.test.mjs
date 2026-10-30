/**
 * wv sound score renders a score written in code and proves it: every planned
 * hit within 10 ms of its picture time, and no flagged note. The render test
 * runs when the runtime venv has scipy and mido (wv setup installs them).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { clearScoreResults, readHitTable, SCORE_TEMPLATE, scoreSteps } from "../skills/walkthrough-video/scripts/film/sound.mjs";
import { paths } from "../skills/walkthrough-video/scripts/lib/paths.mjs";

const WV = fileURLToPath(new URL("../skills/walkthrough-video/scripts/wv.mjs", import.meta.url));
const python = paths().python;
const ready = existsSync(python) && spawnSync(python, ["-c", "import scipy, mido, pedalboard, soundfile"]).status === 0;

test("the score runs, then the hit check and the harmony check, with the film's length", () => {
	const steps = scoreSteps({ score: "/f/score.py", out: "/f/score", cues: "/f/out/cues.json", duration: 26.3, python: "/py" });
	assert.deepEqual(steps.map((s) => s.name), ["render", "hits", "harmony"]);
	assert.deepEqual(steps[0].args.slice(-2), ["/f/score.py", "/f/score"]);
	assert.equal(steps[0].env.WV_SCORE_DURATION, "26.3");
	assert.equal(steps[0].env.WV_SCORE_CUES, "/f/out/cues.json");
	assert.match(steps[0].env.PYTHONPATH, /py[/\\]score/);
	assert.ok(steps.every((s) => s.cmd === "/py"));
	assert.ok(existsSync(SCORE_TEMPLATE));
});

test("a score run clears the earlier hit table and plan, and a run that writes no table fails", () => {
	const out = mkdtempSync(join(tmpdir(), "wv-score-stale-"));
	try {
		const stale = ["hit-table.md", "hit-plan.json", "notes.json"];
		for (const name of stale) writeFileSync(join(out, name), "old run");
		clearScoreResults(out);
		for (const name of stale) assert.equal(existsSync(join(out, name)), false, `${name} belongs to the run that wrote it`);
		// hit_check.py crashed on a missing stem: an old table must never read as this run's result.
		assert.throws(() => readHitTable(out, { code: 1, text: "Traceback\
FileNotFoundError: render/pad.wav" }), /wrote no hit-table\.md/);
		writeFileSync(join(out, "hit-table.md"), "| 0.500 | 0.500 | 0.000 | yes |\n");
		assert.match(readHitTable(out, { code: 0, text: "" }), /yes/);
		assert.throws(() => readHitTable(out, { code: 2, text: "usage: hit_check.py" }), /hit check/);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

test("wv sound score renders the template and passes its checks; a late hit fails", { skip: ready ? false : "the runtime venv has no scipy or mido (run wv setup)", timeout: 120000 }, () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-score-"));
	try {
		copyFileSync(SCORE_TEMPLATE, join(dir, "score.py"));
		writeFileSync(join(dir, "cues.json"), JSON.stringify({ duration: 6, cues: [], music: { liftAt: 4, bpm: 120 } }));
		const ok = spawnSync(process.execPath, [WV, "sound", "score", join(dir, "score.py"), "--cues", join(dir, "cues.json"), "--out", join(dir, "out")], { encoding: "utf8" });
		assert.equal(ok.status, 0, ok.stdout + ok.stderr);
		assert.ok(existsSync(join(dir, "out", "score.wav")));
		assert.match(ok.stdout, /hits: 1 of 1 within 10 ms/);
		assert.match(ok.stdout, /harmony: 0 flagged/);
		// The kick lands 40 ms after the planned picture time: the check must catch it.
		const late = readFileSync(join(dir, "score.py"), "utf8").replace("place(kick, kick808(1.0), t)", "place(kick, kick808(1.0), t + 0.04)");
		writeFileSync(join(dir, "score.py"), late);
		const bad = spawnSync(process.execPath, [WV, "sound", "score", join(dir, "score.py"), "--cues", join(dir, "cues.json"), "--out", join(dir, "out")], { encoding: "utf8" });
		assert.equal(bad.status, 1, bad.stdout + bad.stderr);
		assert.match(bad.stdout, /hits: 0 of 1 within 10 ms/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
