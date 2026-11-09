/**
 * The live repros of formal/subagents-lifecycle (findings F1 to F5) as
 * regression tests: each script runs the real Team, the real child launcher
 * and real Pi sessions on Pi's faux model, and exits 1 while its finding is
 * there. Each control shows the same path with the cause taken away.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const FOLDER = fileURLToPath(new URL("../formal/subagents-lifecycle/", import.meta.url));

interface Run { status: number | null; stdout: string; stderr: string }

/** Runs one repro script; the scripts spend most of their time waiting, so they all start at once. */
function run(script: string, ...args: string[]): Promise<Run> {
	return new Promise((resolve) => {
		const child = execFile(process.execPath, [`${FOLDER}${script}`, ...args], { encoding: "utf8", timeout: 90_000, env: process.env },
			(_error, stdout, stderr) => resolve({ status: child.exitCode, stdout, stderr }));
	});
}

const RUNS = [["repro-f1.mts"], ["repro-f1.mts", "--no-stop"], ["repro-f2.mts"], ["repro-f2.mts", "--no-message"], ["repro-f3.mts"],
	["repro-f3.mts", "--no-message"], ["repro-f4.mts"], ["repro-f4-byparent.mts"], ["repro-f4-byparent.mts", "--alone"], ["repro-f5.mts"], ["repro-f5.mts", "--no-hold"]];
const runs = new Map(RUNS.map((args) => [args.join(" "), run(args[0]!, ...args.slice(1))]));

async function repro(script: string, ...args: string[]): Promise<Record<string, any>> {
	const result = await runs.get([script, ...args].join(" "))!;
	const line = result.stdout.trim().split("\n").at(-1) ?? "";
	assert.equal(result.status, 0, `${script} ${args.join(" ")} exited ${result.status}: ${line}\n${result.stderr.slice(-2000)}`);
	return JSON.parse(line);
}

test("F1: a stop while the child's prompt waits in an input handler stops it before any model call", { timeout: 100_000 }, async () => {
	const result = await repro("repro-f1.mts");
	assert.equal(result.modelCallsAfter, 0);
	assert.equal(result.state, "stopped");
	assert.equal((await repro("repro-f1.mts", "--no-stop")).modelCallsAfter, 2, "the control runs as usual");
});

test("F2: a message during a stop's abort of a preparing prompt leaves the old session with no model call", { timeout: 100_000 }, async () => {
	const result = await repro("repro-f2.mts");
	assert.equal(result.oldSessionModelCalls, 0);
	assert.equal(result.launches, 2, "the message still relaunched the child");
	assert.equal((await repro("repro-f2.mts", "--no-message")).oldSessionModelCalls, 0);
});

test("F3: a second stop of a child that a message relaunched during the first stop is not refused", { timeout: 100_000 }, async () => {
	const result = await repro("repro-f3.mts");
	assert.equal(result.secondStopRefused, false);
	assert.equal(result.finalState, "stopped");
	assert.equal(result.newSessionBashRuns, 0, "the relaunched run stopped in its first bash call");
	await repro("repro-f3.mts", "--no-message");
});

test("F4: an old stop that ends late leaves the newer stop's mark, and a stop by main stays silent", { timeout: 100_000 }, async () => {
	assert.equal((await repro("repro-f4.mts")).afterFirstStop.stopping, true);
	assert.deepEqual((await repro("repro-f4-byparent.mts")).reports, [{ name: "kid", state: "idle" }]);
	assert.equal((await repro("repro-f4-byparent.mts", "--alone")).stoppedReports, 0);
});

test("F5: a message steered while the child's input handler waits reaches the child", { timeout: 100_000 }, async () => {
	const result = await repro("repro-f5.mts");
	assert.equal(result.afterSteerLands.inTranscript, true);
	assert.equal(result.afterIdleRelease.messageKeptAnywhere, true);
	assert.equal((await repro("repro-f5.mts", "--no-hold")).afterIdleRelease.messageKeptAnywhere, true);
});
