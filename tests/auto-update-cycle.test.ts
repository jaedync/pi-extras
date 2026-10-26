/**
 * Full cycles in a temp machine (tests/support/auto-update-world.ts): real
 * git with local repositories, a fake npm, and the real development Pi in
 * the smoke test.
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, writeConfig } from "../lib/auto-update/config.ts";
import { runCycle } from "../lib/auto-update/cycle.ts";
import { processStart, writeLease } from "../lib/auto-update/leases.ts";
import { readSettingsPackages } from "../lib/auto-update/settings.ts";
import { readState } from "../lib/auto-update/state.ts";
import { flipPiCurrent } from "../lib/auto-update/switch.ts";
import { fixturePackage, PI_NAME, tagRelease } from "./support/auto-update-fixtures.ts";
import { ORIGINAL_SETTINGS, world, type World } from "./support/auto-update-world.ts";

const GIT_KEY = "git-git.example.invalid-jaedync-fixture-git";
const NPM_KEY = "npm-fixture-npm";

async function enabled(t: test.TestContext): Promise<World> {
	const w = world(t);
	tagRelease(w.gitRepo, "good", "1.0.0");
	const result = await w.cli("enable");
	assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
	return w;
}

const entrySources = (w: World) => readSettingsPackages(w.settings).map((entry) => (typeof entry === "string" ? entry : (entry as { source: string }).source));

test("enable builds, tests and switches the first set; disable restores the exact previous files", async (t) => {
	const w = world(t);
	tagRelease(w.gitRepo, "good", "1.0.0");
	const beforeSettings = w.read(w.settings);
	const beforeLink = readlinkSync(w.launcher);
	const result = await w.cli("enable");
	assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /Changed .*\.local\/bin\/pi: it was a link to \.\.\/lib\/node_modules\/@earendil-works\/pi-coding-agent\/dist\/bundle\/cli\.js\. It is now the pi-extras launcher\./);
	assert.match(result.stdout, /Changed .*settings\.json: "https:\/\/git\.example\.invalid\/jaedync\/fixture-git" -> ".*\/packages\/git-git\.example\.invalid-jaedync-fixture-git\/1\.0\.0-[0-9a-f]{7}"/);
	const state = readState(w.paths.state);
	assert.equal(state.current?.pi.version, "1.4.0");
	assert.deepEqual(Object.keys(state.current?.packages ?? {}).sort(), [GIT_KEY, NPM_KEY]);
	assert.equal(readlinkSync(w.paths.piCurrent), "pi/1.4.0");
	const sources = entrySources(w);
	assert.equal(sources[0], state.current?.packages[GIT_KEY]?.entry);
	assert.equal(sources[1], join(w.paths.root, "packages", NPM_KEY, "1.0.0", "node_modules", "fixture-npm"));
	assert.deepEqual(sources.slice(2), ["/local/pinned-path", "npm:pinned@1.0.0"], "pinned and local entries stay");
	assert.deepEqual((readSettingsPackages(w.settings)[1] as { extensions: string[] }).extensions, ["extensions/main.ts"], "filters stay");
	assert.ok(lstatSync(w.launcher).isFile());
	assert.match(w.read(w.launcher), /# pi-extras auto-update launcher v1/);
	assert.equal(JSON.parse(w.read(join(w.agentDir, "pi-extras.json"))).autoUpdate.enabled, true);
	const again = await w.cli("enable");
	assert.match(again.stdout, /already on/);

	const off = await w.cli("disable");
	assert.equal(off.code, 0, off.stderr);
	assert.equal(w.read(w.settings), beforeSettings, "settings.json is byte for byte as before");
	assert.equal(readlinkSync(w.launcher), beforeLink, "~/.local/bin/pi is the same link again");
	assert.equal(JSON.parse(w.read(join(w.agentDir, "pi-extras.json"))).autoUpdate.enabled, false);
	assert.equal(readState(w.paths.state).enabled, undefined);
	assert.ok(existsSync(join(w.paths.root, "pi", "1.4.0")), "the store stays for running sessions");
});

test("enable refuses a ~/.local/bin/pi that is not npm's link, and changes nothing", async (t) => {
	const w = world(t);
	writeFileSync(w.launcher + ".x", "#!/bin/sh\n");
	rmSync(w.launcher);
	renameSync(w.launcher + ".x", w.launcher);
	const result = await w.cli("enable");
	assert.equal(result.code, 1);
	assert.match(result.stderr, /is not a symlink\. Enable needs ~\/\.local\/bin\/pi as the link that "npm install -g" makes for Pi\. Nothing changed\./);
	assert.equal(w.read(w.settings), ORIGINAL_SETTINGS(w.gitUrl));
});

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

test("a new unpinned entry that the user adds is adopted at the next cycle", async (t) => {
	const w = await enabled(t);
	const extra = fixturePackage(join(w.root, "extra-src"), "good", "fixture-extra");
	w.setRegistry("fixture-extra", "0.1.0", extra);
	const settings = JSON.parse(w.read(w.settings));
	writeFileSync(w.settings, JSON.stringify({ ...settings, packages: [...settings.packages, "npm:fixture-extra"] }, null, 2));
	const result = await runCycle(w.cycleDeps(), { force: true });
	assert.equal(result.outcome, "switched", result.message);
	assert.equal(entrySources(w).at(-1), join(w.paths.root, "packages", "npm-fixture-extra", "0.1.0", "node_modules", "fixture-extra"));
	assert.equal(readState(w.paths.state).managed["npm-fixture-extra"]?.original, "npm:fixture-extra");
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

test("the pi-managed marker follows the config: on after enable, off with pi: \"skip\" at the next cycle, off after disable", async (t) => {
	const w = await enabled(t);
	const marker = join(w.paths.root, "pi-managed");
	assert.ok(existsSync(marker), "enable: auto-update manages Pi");
	writeConfig(w.agentDir, { pi: "skip" });
	await runCycle(w.cycleDeps({ config: { ...DEFAULT_CONFIG, enabled: true, pi: "skip" } }));
	assert.equal(existsSync(marker), false, "even a throttled cycle brings the marker in step");
	await runCycle(w.cycleDeps());
	assert.ok(existsSync(marker));
	await w.cli("disable");
	assert.equal(existsSync(marker), false);
});

test("a launcher that something wrote over is reported, not fixed; enable again puts it back", async (t) => {
	const w = await enabled(t);
	// What "npm install -g" of Pi does: a new link at ~/.local/bin/pi.
	rmSync(w.launcher);
	symlinkSync(`../lib/node_modules/${PI_NAME}/dist/bundle/cli.js`, w.launcher);
	const result = await runCycle(w.cycleDeps(), { force: true });
	assert.match(result.message, /\.local\/bin\/pi is no longer the pi-extras launcher/);
	assert.ok(lstatSync(w.launcher).isSymbolicLink(), "the cycle does not change a file outside the store");
	const state = readState(w.paths.state);
	assert.match(state.lastError?.message ?? "", /Run "node .*cli\.ts enable" again to put it back, or "disable"/);
	assert.match(state.launcherProblem?.message ?? "", /no longer the pi-extras launcher/);
	const again = await w.cli("enable");
	assert.equal(again.code, 0, `${again.stdout}\n${again.stderr}`);
	assert.ok(lstatSync(w.launcher).isFile());
	await runCycle(w.cycleDeps(), { force: true });
	assert.equal(readState(w.paths.state).launcherProblem, undefined);
	assert.equal(readState(w.paths.state).lastError, undefined);
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
	assert.equal(state.bad["npm-fixture-extra"], undefined, "the previous set had no fixture-extra: not a rollback of it");
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
