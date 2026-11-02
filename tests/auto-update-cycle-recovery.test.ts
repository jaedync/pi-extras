/**
 * Full cycles in a temp machine (tests/support/auto-update-world.ts): real
 * git with local repositories, a fake npm, and the real development Pi in
 * the smoke test. This file: rollback, and the cleanup of what a
 * crashed or stopped cycle left (staging folders, locks, smoke folders).
 * The cycle tests are in six files, so that they run in parallel.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CYCLE_LIMIT_MS, runCycle } from "../lib/auto-update/cycle.ts";
import { SMOKE_DIR_PREFIX } from "../lib/auto-update/smoke.ts";
import { readState } from "../lib/auto-update/state.ts";
import { fixturePackage, PI_NAME } from "./support/auto-update-fixtures.ts";
import { enabled, GIT_KEY } from "./support/auto-update-world.ts";

test("rollback returns to the previous set and marks the newer versions bad; status lists the mark, and retry clears it and checks", async (t) => {
	const w = await enabled(t);
	const first = readState(w.paths.state).current!;
	w.setRegistry(PI_NAME, "1.4.3");
	assert.equal((await runCycle(w.cycleDeps(), { force: true })).outcome, "switched");
	const result = await w.cli("rollback");
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /Rolled back to: Pi 1\.4\.0/);
	const state = readState(w.paths.state);
	assert.deepEqual(state.current, first);
	assert.equal(readlinkSync(w.paths.piCurrent), "pi/1.4.0");
	assert.ok(state.bad.pi?.["1.4.3"]);
	assert.equal((await runCycle(w.cycleDeps(), { force: true })).outcome, "no-change", "the rolled-back version is not installed again");
	// The way out of a bad mark: status names it, retry clears it and checks at once.
	const status = await w.cli("status");
	assert.match(status.stdout, /\nBad: Pi 1\.4\.3 \(\d{4}-\d{2}-\d{2}\): rolled back by the user\n/);
	assert.match(status.stdout, /Use \/pi-extras update retry to test it again/);
	const retried = await w.cli("retry");
	assert.equal(retried.code, 0, retried.stderr);
	assert.match(retried.stdout, /^Cleared 1 bad mark and 0 suspect marks\.\n.*Updated: Pi 1\.4\.3/s);
	const after = readState(w.paths.state);
	assert.deepEqual(after.bad, {});
	assert.equal(after.current!.pi.version, "1.4.3");
	assert.match(w.read(w.paths.log), /retry: cleared the bad marks of Pi 1\.4\.3/);
	assert.doesNotMatch((await w.cli("status")).stdout, /Bad:|update retry/);
});

test("a stale staging folder from a crashed install is removed; a lock of a dead process is taken over", async (t) => {
	const w = await enabled(t);
	const staging = join(w.paths.packagesRoot, GIT_KEY, "9.9.9-abcdef0.staging-deadbeef");
	mkdirSync(staging, { recursive: true });
	const old = new Date(Date.now() - 3_600_000);
	utimesSync(staging, old, old);
	writeFileSync(w.paths.lock, "999999999 deadbeef");
	const result = await runCycle(w.cycleDeps(), { force: true });
	assert.equal(result.outcome, "no-change", result.message);
	assert.equal(existsSync(staging), false);
	assert.equal(existsSync(w.paths.lock), false);
});

test("rollback after a new source was added marks only the sources both sets have", async (t) => {
	const w = await enabled(t);
	const extra = fixturePackage(join(w.root, "extra-src"), "good", "fixture-extra");
	w.setRegistry("fixture-extra", "0.1.0", extra);
	w.setRegistry(PI_NAME, "1.4.3");
	const settings = JSON.parse(w.read(w.settings));
	writeFileSync(w.settings, JSON.stringify({ ...settings, packages: [...settings.packages, "npm:fixture-extra"] }, null, 2));
	assert.equal((await runCycle(w.cycleDeps(), { force: true })).outcome, "switched");
	const result = await w.cli("rollback");
	assert.equal(result.code, 0, result.stderr);
	const state = readState(w.paths.state);
	assert.ok(state.bad.pi?.["1.4.3"], "Pi changed in both sets: bad");
	assert.equal(state.bad["npm-fixture-extra-b75661ca"], undefined, "the previous set had no fixture-extra: not a rollback of it");
});

test("a cycle removes the old smoke folder that a stopped cycle left in the temp folder", async (t) => {
	const w = await enabled(t);
	const left = join(tmpdir(), `${SMOKE_DIR_PREFIX}au-gc-test-${process.pid}`);
	mkdirSync(join(left, "home"), { recursive: true });
	t.after(() => rmSync(left, { recursive: true, force: true }));
	const past = new Date(Date.now() - CYCLE_LIMIT_MS - 60_000);
	utimesSync(left, past, past);
	// A running test's folder: young by the wall clock, also when the cycle's own clock runs a day ahead.
	const live = join(tmpdir(), `${SMOKE_DIR_PREFIX}au-gc-live-${process.pid}`);
	mkdirSync(join(live, "home"), { recursive: true });
	t.after(() => rmSync(live, { recursive: true, force: true }));
	const result = await runCycle(w.cycleDeps({ now: () => Date.now() + 24 * 3_600_000 }), { force: true });
	assert.equal(result.outcome, "no-change", result.message);
	assert.equal(existsSync(left), false);
	assert.equal(existsSync(live), true);
});
