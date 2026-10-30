/**
 * wv raises its own OOM score at start, so the kernel stops a render or a
 * capture (which inherit the score) before the user's other processes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_OOM_SCORE_ADJ, raiseOomScore } from "../skills/walkthrough-video/scripts/lib/oom.mjs";

function fakeProc(current) {
	const writes = [];
	return {
		writes,
		read: () => `${current}\n`,
		write: (value) => writes.push(value),
	};
}

test("raises a lower score to the default on Linux", () => {
	const proc = fakeProc(0);
	const result = raiseOomScore({ platform: "linux", env: {}, ...proc });
	assert.deepEqual(proc.writes, [String(DEFAULT_OOM_SCORE_ADJ)]);
	assert.deepEqual(result, { changed: true, from: 0, to: DEFAULT_OOM_SCORE_ADJ });
});

test("never lowers a score that is already higher", () => {
	const proc = fakeProc(900);
	const result = raiseOomScore({ platform: "linux", env: {}, ...proc });
	assert.deepEqual(proc.writes, []);
	assert.equal(result.changed, false);
});

test("WV_OOM_SCORE_ADJ sets the target, and off skips it", () => {
	const set = fakeProc(0);
	raiseOomScore({ platform: "linux", env: { WV_OOM_SCORE_ADJ: "300" }, ...set });
	assert.deepEqual(set.writes, ["300"]);

	const off = fakeProc(0);
	const result = raiseOomScore({ platform: "linux", env: { WV_OOM_SCORE_ADJ: "off" }, ...off });
	assert.deepEqual(off.writes, []);
	assert.equal(result.changed, false);
});

test("an invalid WV_OOM_SCORE_ADJ is an error, not a silent default", () => {
	const proc = fakeProc(0);
	const result = raiseOomScore({ platform: "linux", env: { WV_OOM_SCORE_ADJ: "high" }, ...proc });
	assert.deepEqual(proc.writes, []);
	assert.match(result.error, /WV_OOM_SCORE_ADJ/);
});

test("does nothing on other platforms", () => {
	const proc = fakeProc(0);
	const result = raiseOomScore({ platform: "darwin", env: {}, ...proc });
	assert.deepEqual(proc.writes, []);
	assert.equal(result.changed, false);
});

test("a failed write is reported in the result", () => {
	const result = raiseOomScore({
		platform: "linux",
		env: {},
		read: () => "0",
		write: () => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		},
	});
	assert.equal(result.changed, false);
	assert.match(result.error, /permission denied/);
});
