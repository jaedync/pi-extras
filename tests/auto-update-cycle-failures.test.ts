/**
 * Full cycles in a temp machine (tests/support/auto-update-world.ts): real
 * git with local repositories, a fake npm, and the real development Pi in
 * the smoke test. This file: sets that fail the smoke test (the bad
 * mark, and the search for the culprit when two changes fail together).
 * The cycle tests are in four files, so that they run in parallel.
 */
import assert from "node:assert/strict";
import { readlinkSync } from "node:fs";
import test from "node:test";
import { DEFAULT_CONFIG } from "../lib/auto-update/config.ts";
import { runCycle } from "../lib/auto-update/cycle.ts";
import { SMOKE_TIMEOUT_MS, type SmokeResult } from "../lib/auto-update/smoke.ts";
import { readState, SUSPECT_WAIT_MS } from "../lib/auto-update/state.ts";
import { statusLines } from "../lib/auto-update/status.ts";
import { tagRelease } from "./support/auto-update-fixtures.ts";
import { enabled, GIT_KEY, NPM_KEY } from "./support/auto-update-world.ts";

test("a broken release fails the smoke test, is marked bad, is not tried again, and the current set stays", async (t) => {
	const w = await enabled(t);
	const before = readState(w.paths.state).current!;
	const settingsBefore = w.read(w.settings);
	const commit = tagRelease(w.gitRepo, "load-error", "2.0.0");
	const result = await runCycle(w.cycleDeps(), { force: true });
	assert.equal(result.outcome, "smoke-failed", result.message);
	assert.match(result.message, /fixture-git 2\.0\.0 failed its test: .*Failed to load extension/);
	const state = readState(w.paths.state);
	assert.deepEqual(state.current, before);
	assert.ok(state.bad[GIT_KEY]?.[`2.0.0-${commit.slice(0, 7)}`], "the broken version is marked bad");
	assert.match(state.lastError?.message ?? "", /failed its test/);
	assert.equal(w.read(w.settings), settingsBefore);
	assert.equal(readlinkSync(w.paths.piCurrent), "pi/1.4.0");
	// Two changes at once: only the broken one is marked; the good one passes alone.
	w.setRegistry("fixture-npm", "1.0.2");
	const both = await runCycle(w.cycleDeps(), { force: true });
	assert.equal(both.outcome, "switched", both.message);
	assert.equal(readState(w.paths.state).current!.packages[NPM_KEY]!.id, "1.0.2");
	assert.equal(readState(w.paths.state).current!.packages[GIT_KEY]!.id, before.packages[GIT_KEY]!.id, "the bad tag is skipped");
});

test("when two changes fail together, each is tried alone and only the culprit is marked", async (t) => {
	const w = await enabled(t);
	const commit = tagRelease(w.gitRepo, "handler-error", "3.0.0");
	w.setRegistry("fixture-npm", "1.0.3");
	const result = await runCycle(w.cycleDeps(), { force: true });
	assert.equal(result.outcome, "smoke-failed");
	const bad = readState(w.paths.state).bad;
	assert.ok(bad[GIT_KEY]?.[`3.0.0-${commit.slice(0, 7)}`]);
	assert.equal(bad[NPM_KEY], undefined, "the good npm update is not blamed");
	const next = await runCycle(w.cycleDeps(), { force: true });
	assert.equal(next.outcome, "switched");
	assert.equal(readState(w.paths.state).current!.packages[NPM_KEY]!.id, "1.0.3");
});

test("a test that the hard limit ends leaves its releases suspect; after 2 such tries they wait 24 h, then get one more try", async (t) => {
	const w = await enabled(t);
	const commit = tagRelease(w.gitRepo, "good", "2.0.0");
	const id = `2.0.0-${commit.slice(0, 7)}`;
	let clock = Date.now();
	// Stands for a cycle that the hard limit ended during the test: no verdict comes back.
	const killed = async (): Promise<SmokeResult> => {
		throw new Error("stopped by the hard limit");
	};
	for (const tries of [1, 2]) {
		const result = await runCycle(w.cycleDeps({ smoke: killed, now: () => clock }), { force: true });
		assert.equal(result.outcome, "error", result.message);
		const state = readState(w.paths.state);
		assert.equal(state.suspect?.[GIT_KEY]?.[id]?.tries, tries);
		assert.equal(state.bad[GIT_KEY], undefined, "not bad: the test gave no verdict");
		clock += 60_000;
	}
	let tested = 0;
	const passing = async (): Promise<SmokeResult> => {
		tested++;
		return { ok: true, ms: 1 };
	};
	const skipped = await runCycle(w.cycleDeps({ smoke: passing, now: () => clock }), { force: true });
	assert.equal(skipped.outcome, "no-change", skipped.message);
	assert.equal(tested, 0, "the same work is not done a third time in a row");
	assert.match(statusLines(readState(w.paths.state), { ...DEFAULT_CONFIG, enabled: true }, clock).join("\n"), /fixture-git 2\.0\.0-\w+ \(its test did not finish 2 times/);
	clock += SUSPECT_WAIT_MS;
	const retried = await runCycle(w.cycleDeps({ smoke: passing, now: () => clock }), { force: true });
	assert.equal(retried.outcome, "switched", retried.message);
	assert.equal(tested, 1);
	assert.equal(readState(w.paths.state).suspect?.[GIT_KEY], undefined, "a verdict clears the mark");
});

test("the culprit search starts no test that the cycle limit would cut off; the untested changes stay suspect, not bad", async (t) => {
	const w = await enabled(t);
	tagRelease(w.gitRepo, "good", "2.0.0");
	w.setRegistry("fixture-npm", "1.0.2");
	let clock = Date.now();
	let tested = 0;
	const failing = async (): Promise<SmokeResult> => {
		tested++;
		clock += SMOKE_TIMEOUT_MS;
		return { ok: false, reason: "boom" };
	};
	const result = await runCycle(w.cycleDeps({ smoke: failing, now: () => clock, limitMs: 2 * SMOKE_TIMEOUT_MS - 1 }), { force: true });
	assert.equal(result.outcome, "smoke-failed", result.message);
	assert.match(result.message, /did not finish/);
	assert.equal(tested, 1, "after the first test, a second one could pass the limit");
	const state = readState(w.paths.state);
	assert.deepEqual(state.bad, {}, "no verdict, so nothing is bad");
	assert.equal(Object.values(state.suspect?.[GIT_KEY] ?? {})[0]?.tries, 1);
	assert.equal(Object.values(state.suspect?.[NPM_KEY] ?? {})[0]?.tries, 1);
});
