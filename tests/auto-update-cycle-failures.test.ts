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
import { runCycle } from "../lib/auto-update/cycle.ts";
import { readState } from "../lib/auto-update/state.ts";
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
