/**
 * Full cycles in a temp machine (tests/support/auto-update-world.ts): real
 * git with local repositories, a fake npm, and the real development Pi in
 * the smoke test. This file: new versions (install, test and switch,
 * the updater lock, crash repair and new entries).
 * The cycle tests are in four files, so that they run in parallel.
 */
import assert from "node:assert/strict";
import { readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runCycle } from "../lib/auto-update/cycle.ts";
import { readState } from "../lib/auto-update/state.ts";
import { flipPiCurrent } from "../lib/auto-update/switch.ts";
import { fixturePackage, PI_NAME, tagRelease } from "./support/auto-update-fixtures.ts";
import { enabled, entrySources, GIT_KEY, NPM_KEY, ORIGINAL_SETTINGS } from "./support/auto-update-world.ts";

test("a new tag and a new npm version are installed, tested and switched; the old set becomes previous", async (t) => {
	const w = await enabled(t);
	const first = readState(w.paths.state).current!;
	tagRelease(w.gitRepo, "good", "1.1.0");
	w.setRegistry("fixture-npm", "1.0.1");
	const result = await runCycle(w.cycleDeps(), { force: true });
	assert.equal(result.outcome, "switched", result.message);
	assert.match(result.message, /fixture-git 1\.1\.0, fixture-npm 1\.0\.1/);
	const state = readState(w.paths.state);
	assert.deepEqual(state.previous, first);
	assert.match(state.current!.packages[GIT_KEY]!.id, /^1\.1\.0-/);
	assert.equal(state.current!.packages[NPM_KEY]!.id, "1.0.1");
	assert.equal(entrySources(w)[0], state.current!.packages[GIT_KEY]!.entry);
	assert.equal(state.activity, undefined, "the status activity is cleared");
	const quiet = await runCycle(w.cycleDeps());
	assert.equal(quiet.outcome, "throttled", "a second check within the interval does nothing");
	const none = await runCycle(w.cycleDeps(), { force: true });
	assert.equal(none.outcome, "no-change");
});

test("two cycles started together install a release once (the updater lock)", async (t) => {
	const w = await enabled(t);
	w.setRegistry(PI_NAME, "1.4.1");
	process.env.FAKE_NPM_DELAY_MS = "1500";
	t.after(() => delete process.env.FAKE_NPM_DELAY_MS);
	const results = await Promise.all([w.cli("check", "--force"), w.cli("check", "--force")]);
	const installs = w.read(w.npmLog).split("\n").filter((line) => line.startsWith("install -g") && line.includes("@1.4.1"));
	assert.equal(installs.length, 1, w.read(w.npmLog));
	assert.deepEqual(results.map((result) => result.stdout.trim()).sort(), ["Another update cycle runs now.", "Updated: Pi 1.4.1."]);
	assert.equal(readlinkSync(w.paths.piCurrent), "pi/1.4.1");
});

test("a crash between the switch steps is repaired by the next cycle", async (t) => {
	const w = await enabled(t);
	tagRelease(w.gitRepo, "good", "1.2.0");
	w.setRegistry(PI_NAME, "1.4.2");
	assert.equal((await runCycle(w.cycleDeps(), { force: true })).outcome, "switched");
	const good = readState(w.paths.state);
	// Crash 1: state.json names the new set, but the link and settings still name the old one.
	flipPiCurrent(w.paths, good.previous!.pi.dir);
	writeFileSync(w.settings, ORIGINAL_SETTINGS(w.gitUrl).replace(w.gitUrl, good.previous!.packages[GIT_KEY]!.entry));
	const repaired = await runCycle(w.cycleDeps(), { force: true });
	assert.equal(repaired.outcome, "no-change", repaired.message);
	assert.equal(readlinkSync(w.paths.piCurrent), "pi/1.4.2");
	assert.equal(entrySources(w)[0], good.current!.packages[GIT_KEY]!.entry);
	// Crash 2: the link flipped, settings not yet rewritten.
	writeFileSync(w.settings, ORIGINAL_SETTINGS(w.gitUrl).replace(w.gitUrl, good.previous!.packages[GIT_KEY]!.entry));
	await runCycle(w.cycleDeps(), { force: true });
	assert.equal(entrySources(w)[0], good.current!.packages[GIT_KEY]!.entry);
});

test("a new unpinned entry that the user adds is adopted at the next cycle", async (t) => {
	const w = await enabled(t);
	const extra = fixturePackage(join(w.root, "extra-src"), "good", "fixture-extra");
	w.setRegistry("fixture-extra", "0.1.0", extra);
	const settings = JSON.parse(w.read(w.settings));
	writeFileSync(w.settings, JSON.stringify({ ...settings, packages: [...settings.packages, "npm:fixture-extra"] }, null, 2));
	const result = await runCycle(w.cycleDeps(), { force: true });
	assert.equal(result.outcome, "switched", result.message);
	assert.equal(entrySources(w).at(-1), join(w.paths.root, "packages", "npm-fixture-extra-b75661ca", "0.1.0", "node_modules", "fixture-extra"));
	assert.equal(readState(w.paths.state).managed["npm-fixture-extra-b75661ca"]?.original, "npm:fixture-extra");
});
