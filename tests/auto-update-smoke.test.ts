/** The smoke test against the repo's real development Pi, with fixture packages. No network, no real agent dir. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { smokeTest, SMOKE_DIR_PREFIX, sweepSmokeDirs } from "../lib/auto-update/smoke.ts";
import { fixturePackage, piPrefix, removeTree } from "./support/auto-update-fixtures.ts";

function scratch(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "au-smoke-"));
	t.after(() => removeTree(dir));
	return dir;
}

test("a set whose packages load passes, with filters kept on the entry", async (t) => {
	const root = scratch(t);
	const pi = piPrefix(join(root, "pi"));
	const good = fixturePackage(join(root, "good"), "good");
	const result = await smokeTest({ piDir: pi, packages: [{ source: good, extensions: ["extensions/main.ts"] }], timeoutMs: 45_000 });
	assert.deepEqual(result.ok ? "ok" : result.reason, "ok");
});

test("a package that fails to load fails the smoke test with Pi's reason", async (t) => {
	const root = scratch(t);
	const pi = piPrefix(join(root, "pi"));
	const good = fixturePackage(join(root, "good"), "good");
	const bad = fixturePackage(join(root, "bad"), "load-error", "broken");
	const result = await smokeTest({ piDir: pi, packages: [good, bad], timeoutMs: 45_000 });
	assert.equal(result.ok, false);
	assert.match(!result.ok ? result.reason : "", /Failed to load extension.*missing-module/);
});

test("an extension that throws at session start fails the smoke test", async (t) => {
	const root = scratch(t);
	const pi = piPrefix(join(root, "pi"));
	const bad = fixturePackage(join(root, "bad"), "handler-error", "throws");
	const result = await smokeTest({ piDir: pi, packages: [bad], timeoutMs: 45_000 });
	assert.equal(result.ok, false);
	assert.match(!result.ok ? result.reason : "", /failed in session_start: fixture failure/);
});

test("a candidate without bin/pi fails at once", async (t) => {
	const result = await smokeTest({ piDir: join(scratch(t), "none"), packages: [] });
	assert.deepEqual(result, { ok: false, reason: "the candidate Pi has no bin/pi" });
});

test("a Pi that cannot start gives no verdict; a Pi that fails gives one", async (t) => {
	const dir = scratch(t);
	mkdirSync(join(dir, "pi", "bin"), { recursive: true });
	writeFileSync(join(dir, "pi", "bin", "pi"), "process.exit(3);\n");
	writeFileSync(join(dir, "pi", "package.json"), JSON.stringify({ type: "commonjs" }));
	const missingNode = await smokeTest({ piDir: join(dir, "pi"), packages: [], node: join(dir, "no-such-node"), timeoutMs: 5_000 });
	assert.match(missingNode.ok ? "" : missingNode.reason, /Pi did not start/);
	assert.equal(!missingNode.ok && missingNode.inconclusive, true);
	const exits = await smokeTest({ piDir: join(dir, "pi"), packages: [], timeoutMs: 5_000 });
	assert.match(exits.ok ? "" : exits.reason, /Pi exited \(3\)/);
	assert.equal(!exits.ok && exits.inconclusive, undefined, "an exit is a verdict");
});

test("pi-extras itself passes the smoke test", async () => {
	const result = await smokeTest({ piDir: piPrefix(join(mkdtempSync(join(tmpdir(), "au-smoke-x-")), "pi")), packages: [new URL("../", import.meta.url).pathname.replace(/\/$/, "")], timeoutMs: 55_000 });
	assert.deepEqual(result.ok ? "ok" : result.reason, "ok");
});

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("a smoke Pi that does not answer is stopped with all its children (its own process group)", { skip: process.platform === "win32" }, async (t) => {
	const dir = scratch(t);
	const pidFile = join(dir, "grandchild.pid");
	mkdirSync(join(dir, "pi", "bin"), { recursive: true });
	// A Pi that starts a child (an MCP server, a tool) and then never replies.
	writeFileSync(join(dir, "pi", "bin", "pi"), `const { spawn } = require("node:child_process");
const child = spawn("sleep", ["300"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`);
	writeFileSync(join(dir, "pi", "package.json"), JSON.stringify({ type: "commonjs" }));
	let grandchild = 0;
	t.after(() => {
		if (grandchild && alive(grandchild)) process.kill(grandchild, "SIGKILL");
	});
	const result = await smokeTest({ piDir: join(dir, "pi"), packages: [], timeoutMs: 1_500 });
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.reason, /no reply within/);
	assert.equal(!result.ok && result.inconclusive, true, "a timeout (for example under load) is no verdict on the set");
	grandchild = Number(readFileSync(pidFile, "utf8"));
	for (let i = 0; i < 40 && alive(grandchild); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(alive(grandchild), false, "the child of the smoke Pi is gone too");
});

test("old smoke folders that a stopped cycle left are removed; new ones and other folders stay", (t) => {
	const dir = scratch(t);
	const now = Date.now();
	const old = join(dir, `${SMOKE_DIR_PREFIX}old1`);
	const young = join(dir, `${SMOKE_DIR_PREFIX}new1`);
	const other = join(dir, "someone-else-old");
	for (const folder of [old, young, other]) mkdirSync(join(folder, "home", "tmp"), { recursive: true });
	writeFileSync(join(old, "home", "file"), "x");
	const past = new Date(now - 11 * 60_000);
	utimesSync(old, past, past);
	utimesSync(other, past, past);
	assert.deepEqual(sweepSmokeDirs(dir, now, 10 * 60_000), [old]);
	assert.equal(existsSync(old), false);
	assert.equal(existsSync(young), true);
	assert.equal(existsSync(other), true);
});
