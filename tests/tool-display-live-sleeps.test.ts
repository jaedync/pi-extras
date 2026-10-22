import assert from "node:assert/strict";
import test from "node:test";
import type { ShellOperations } from "../lib/chain/exec.ts";
import { RUN_VARIABLE, SleepWatch } from "../lib/sleep-watch.ts";
import { liveSleepRuns, runOperations } from "../lib/tool-display/live-sleeps.ts";

test("a bash call's shell gets its run in its environment, and its sleeps are found by it", async () => {
	const envs: Array<NodeJS.ProcessEnv | undefined> = [];
	const base: ShellOperations = { exec: async (_command, _cwd, options) => { envs.push(options.env); return { exitCode: 0 }; } };
	const operations = runOperations(base);
	const watch = new SleepWatch({ list: () => [{ pid: 5, pgid: 4, startedAt: 0, ms: 9_000, run: "run-1" }], timers: { setInterval: () => 1, clearInterval: () => {} } });
	const runs = liveSleepRuns(watch, () => "run-1");
	let during: unknown = "unset";
	const bash = runs.wrap({
		execute: async (toolCallId: string) => {
			await operations.exec("sleep 9", "/", { onData: () => {}, env: { HOME: "/h" } });
			during = runs.sleeps(toolCallId);
			return "ok";
		},
	});
	assert.equal(await bash.execute("call-1", {}, undefined, undefined, undefined), "ok");
	assert.deepEqual(envs[0], { HOME: "/h", [RUN_VARIABLE]: "run-1" });
	assert.equal(during, undefined, "nothing scanned yet");
	assert.equal(runs.sleeps("call-1"), undefined, "an ended call has no run");
	await operations.exec("true", "/", { onData: () => {}, env: { HOME: "/h" } });
	assert.deepEqual(envs[1], { HOME: "/h" }, "outside a call the environment is left alone");
});
