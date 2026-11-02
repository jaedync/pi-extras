/**
 * Full cycles in a temp machine (tests/support/auto-update-world.ts): real
 * git with local repositories, a fake npm, and the real development Pi in
 * the smoke test. This file: GC (session and launcher leases, and
 * folders that settings.json names).
 * The cycle tests are in six files, so that they run in parallel.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runCycle } from "../lib/auto-update/cycle.ts";
import { processStart, readLiveLeases, writeLease } from "../lib/auto-update/leases.ts";
import { readState } from "../lib/auto-update/state.ts";
import { PI_NAME, tagRelease } from "./support/auto-update-fixtures.ts";
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

test("a Pi with --no-extensions that the launcher started keeps its Pi folder through GC (the launcher lease)", async (t) => {
	const w = await enabled(t);
	const pi140 = join(w.paths.root, "pi", "1.4.0");
	// No pi-extras in this Pi: no session lease, and its process title "pi" hides its path from the process scan.
	// Its own empty agent dir: the world's settings name packages that this Pi would try to install.
	const agentDir = join(w.root, "bare-agent");
	mkdirSync(agentDir);
	const pi = spawn(w.launcher, ["--no-extensions", "--no-session", "--mode", "rpc"], { cwd: w.root, env: { ...process.env, ...w.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["pipe", "ignore", "pipe"] });
	const closed = new Promise<number | null>((resolve) => pi.on("close", resolve));
	let stderr = "";
	pi.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	t.after(() => pi.kill("SIGKILL"));
	const deadline = Date.now() + 20_000;
	while (!readLiveLeases(w.paths).some((lease) => lease.mode === "launcher")) {
		assert.ok(Date.now() < deadline, "the launcher wrote no lease");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const late = () => Date.now() + 2 * 3_600_000;
	for (const version of ["1.4.1", "1.4.2"]) {
		w.setRegistry(PI_NAME, version);
		assert.equal((await runCycle(w.cycleDeps({ now: late }), { force: true })).outcome, "switched");
	}
	assert.equal(pi.exitCode, null, `Pi still runs: ${stderr}`);
	assert.ok(existsSync(pi140), "1.4.0 is neither current nor previous, but the launcher's lease names it");
	pi.stdin.end();
	await closed;
	assert.deepEqual(readLiveLeases(w.paths), [], "the launcher removed its lease when it ended");
	w.setRegistry(PI_NAME, "1.4.3");
	assert.equal((await runCycle(w.cycleDeps({ now: late }), { force: true })).outcome, "switched");
	assert.equal(existsSync(pi140), false, "removed once the launcher ended");
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

