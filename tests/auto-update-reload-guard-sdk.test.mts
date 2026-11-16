/**
 * Regression for the 2026-11-16 incident: an auto-update reload ended four Pi
 * sessions, because one extension's dependency had changed on disk between two
 * loads and the new code threw in an async step. The child process
 * (support/reload-mixed-modules.mts) runs a real Pi session through that reload.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = fileURLToPath(new URL("./support/reload-mixed-modules.mts", import.meta.url));
const run = (mode: "guard" | "bare") => spawnSync(process.execPath, [child, mode], { encoding: "utf8", timeout: 60_000 });

test("without the guard, the mixed-module reload ends the process (the incident)", { timeout: 90_000 }, () => {
	const result = run("bare");
	assert.notEqual(result.status, 0, `the process lived on: ${result.stdout}`);
	assert.match(result.stderr, /_config\.b\) is not a function/);
});

test("with the reload guard, the session stays alive and the user is told which error happened", { timeout: 90_000 }, () => {
	const result = run("guard");
	assert.equal(result.status, 0, result.stderr);
	const line = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
	assert.equal(line.alive, true);
	assert.equal(line.loaded, "v2", "the new index.js ran with the cached config.js");
	assert.equal(line.reported.length, 1);
	assert.match(line.reported[0], /TypeError: \(0 , _config\.b\) is not a function/);
});
