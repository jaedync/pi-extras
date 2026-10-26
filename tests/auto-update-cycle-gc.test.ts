/**
 * Full cycles in a temp machine (tests/support/auto-update-world.ts): real
 * git with local repositories, a fake npm, and the real development Pi in
 * the smoke test. This file: rollback and GC (leases, folders that
 * settings.json names, and stale staging folders).
 * The cycle tests are in four files, so that they run in parallel.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CYCLE_LIMIT_MS, runCycle } from "../lib/auto-update/cycle.ts";
import { SMOKE_DIR_PREFIX } from "../lib/auto-update/smoke.ts";
import { processStart, writeLease } from "../lib/auto-update/leases.ts";
import { readState } from "../lib/auto-update/state.ts";
import { fixturePackage, PI_NAME, tagRelease } from "./support/auto-update-fixtures.ts";
import { enabled, GIT_KEY } from "./support/auto-update-world.ts";

test("GC keeps a release that a live session leases and removes it once the lease ends", async (t) => {
	const w = await enabled(t);
	const v1 = readState(w.paths.state).current!.packages[GIT_KEY]!;
	tagRelease(w.gitRepo, "good", "1.1.0");
	assert.equal((await runCycle(w.cycleDeps(), { force: true })).outcome, "switched");
	tagRelease(w.gitRepo, "good", "1.2.0");
	const late = () => Date.now() + 2 * 3_600_000;
	writeLease(w.paths, { pid: process.pid, start: processStart(process.pid)!, piVersion: "1.4.0", piDir: join(w.paths.root, "pi", "1.4.0"), releases: [v1.entry], extrasDir: "/x", mode: "tui", updatedAt: Date.now() });
	assert.equal((await runCycle(w.cycleDeps({ now: late }), { force: true })).outcome, "switched");
	assert.ok(existsSync(v1.dir), "v1 is neither current nor previous, but a live lease names it");
	rmSync(w.paths.leases, { recursive: true, force: true });
	tagRelease(w.gitRepo, "good", "1.3.0");
	assert.equal((await runCycle(w.cycleDeps({ now: late }), { force: true })).outcome, "switched");
	assert.equal(existsSync(v1.dir), false, "removed once nothing uses it");
	assert.deepEqual(readdirSync(join(w.paths.packagesRoot, GIT_KEY)).length, 2, "current and previous stay");
});

test("rollback returns to the previous set and marks the newer versions bad", async (t) => {
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

test("GC keeps a store folder that settings.json names, also when no set has it", async (t) => {
	const w = await enabled(t);
	const named = join(w.paths.packagesRoot, "npm-fixture-zzz", "1.0.0");
	mkdirSync(named, { recursive: true });
	writeFileSync(join(named, ".pi-extras-release.json"), JSON.stringify({ installedAt: 0 }));
	const settings = JSON.parse(w.read(w.settings));
	writeFileSync(w.settings, JSON.stringify({ ...settings, packages: [...settings.packages, named] }, null, 2));
	const late = () => Date.now() + 2 * 3_600_000;
	await runCycle(w.cycleDeps({ now: late }), { force: true });
	assert.ok(existsSync(named), "new sessions load it");
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
