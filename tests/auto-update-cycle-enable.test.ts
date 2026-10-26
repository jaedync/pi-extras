/**
 * Full cycles in a temp machine (tests/support/auto-update-world.ts): real
 * git with local repositories, a fake npm, and the real development Pi in
 * the smoke test. This file: enable and disable (the first set, the
 * launcher, the pi-managed marker, a symlinked store, the undo copy and
 * skip sources).
 * The cycle tests are in four files, so that they run in parallel.
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, writeConfig } from "../lib/auto-update/config.ts";
import { runCycle } from "../lib/auto-update/cycle.ts";
import { readSettingsPackages } from "../lib/auto-update/settings.ts";
import { readState } from "../lib/auto-update/state.ts";
import { PI_NAME, removeTree, tagRelease } from "./support/auto-update-fixtures.ts";
import { enabled, entrySources, GIT_KEY, NPM_KEY, ORIGINAL_SETTINGS, world } from "./support/auto-update-world.ts";

test("enable builds, tests and switches the first set; disable restores the exact previous files", async (t) => {
	const w = world(t);
	tagRelease(w.gitRepo, "good", "1.0.0");
	const beforeSettings = w.read(w.settings);
	const beforeLink = readlinkSync(w.launcher);
	const result = await w.cli("enable");
	assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /Changed .*\.local\/bin\/pi: it was a link to \.\.\/lib\/node_modules\/@earendil-works\/pi-coding-agent\/dist\/bundle\/cli\.js\. It is now the pi-extras launcher\./);
	assert.match(result.stdout, /Changed .*settings\.json: https:\/\/git\.example\.invalid\/jaedync\/fixture-git -> .*\/packages\/git-git\.example\.invalid-jaedync-fixture-git-[0-9a-f]{8}\/1\.0\.0-[0-9a-f]{7}\n/);
	assert.match(result.stdout, /Changed .*settings\.json: npm:fixture-npm -> .*\/fixture-npm\n/, "the source only, not the whole entry");
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

test("a symlinked store path: enable writes the real path into settings.json and the launcher", async (t) => {
	const w = world(t);
	tagRelease(w.gitRepo, "good", "1.0.0");
	const link = join(w.root, "store-link");
	symlinkSync(w.paths.root, link);
	w.env.PI_EXTRAS_UPDATE_STORE = link;
	const result = await w.cli("enable");
	assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
	const real = realpathSync(w.paths.root);
	const stored = entrySources(w).filter((source) => source.includes("packages"));
	assert.equal(stored.length, 2);
	for (const source of stored) assert.ok(source.startsWith(`${real}/`), source);
	assert.match(w.read(w.launcher), new RegExp(`^STORE='${real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`, "m"));
});

test("with the store gone, disable restores settings.json and the link from the copy in the agent dir", async (t) => {
	const w = world(t);
	tagRelease(w.gitRepo, "good", "1.0.0");
	const beforeSettings = w.read(w.settings);
	const beforeLink = readlinkSync(w.launcher);
	assert.equal((await w.cli("enable")).code, 0);
	const undo = join(w.agentDir, "pi-extras-update-undo.json");
	assert.ok(existsSync(undo), "enable keeps the undo data beside pi-extras.json");
	assert.equal(lstatSync(undo).mode & 0o777, 0o600);
	removeTree(w.paths.root);
	assert.equal(existsSync(w.paths.root), false);
	const off = await w.cli("disable");
	assert.equal(off.code, 0, `${off.stdout}\n${off.stderr}`);
	assert.match(off.stdout, /copy in .*pi-extras-update-undo\.json/);
	assert.equal(w.read(w.settings), beforeSettings, "settings.json is byte for byte as before");
	assert.equal(readlinkSync(w.launcher), beforeLink);
	assert.equal(existsSync(undo), false, "disable removes the copy");
	assert.match((await w.cli("disable")).stdout, /not on/);
});

test("enable leaves a source with mode skip as the user wrote it", async (t) => {
	const w = world(t);
	tagRelease(w.gitRepo, "good", "1.0.0");
	writeConfig(w.agentDir, { sources: { [w.gitUrl]: "skip" } });
	const result = await w.cli("enable");
	assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
	assert.equal(entrySources(w)[0], w.gitUrl, "skip: not taken into the store");
	assert.deepEqual(Object.keys(readState(w.paths.state).current!.packages), [NPM_KEY]);
	assert.equal((await runCycle(w.cycleDeps({ config: { ...DEFAULT_CONFIG, enabled: true, sources: { [w.gitUrl]: "skip" } } }), { force: true })).outcome, "no-change");
	assert.equal(entrySources(w)[0], w.gitUrl);
});
