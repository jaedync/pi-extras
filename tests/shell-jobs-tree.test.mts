/**
 * A shell-jobs kill ends every process of the job, also one that called
 * setsid and so left the job's process group. Each test marks its processes
 * with a unique sleep length and SIGKILLs every marked process at its end.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { scopeSupported } from "../lib/process-tree.ts";
import { killMarked, marked, marker as mark, survivors } from "./support/process-marks.ts";
import { cleanup, createFakePi, fire, shellJobs, sleep } from "./support/shell-jobs-harness.mts";

afterEach(cleanup);

const marker = () => mark(2000);

const scope = scopeSupported();

async function started() {
	const app = createFakePi();
	shellJobs(app.pi as any);
	await fire(app.handlers, "session_start", app.ctx);
	return app;
}

async function startJob(app: Awaited<ReturnType<typeof started>>, command: string, value: string) {
	const result = await app.tools.get("shell_job_start").execute(`t-${Math.random()}`, { command, title: "Tree" }, undefined, undefined, app.ctx);
	assert.notStrictEqual(result.isError, true, result.content[0].text);
	// Wait until the setsid child runs, so the kill has something to miss.
	for (let waited = 0; waited < 3000 && marked(value).length === 0; waited += 25) await sleep(25);
	assert.ok(marked(value).length > 0, "the marked child started");
	return result.details as { id: string; pid: number };
}

describe("shell-jobs ends the whole tree", { skip: scope ? false : "no systemd user scope here" }, () => {
	test("e. kill ends a child that called setsid", { timeout: 20_000 }, async () => {
		const value = marker();
		try {
			const app = await started();
			const job = await startJob(app, `setsid sh -c 'trap "" TERM; sleep ${value}' & sleep 30`, value);
			const killed = await app.tools.get("shell_job").execute("k", { op: "kill", id: job.id }, undefined, undefined, app.ctx);
			assert.strictEqual(killed.details.state, "done");
			assert.deepEqual(await survivors(value), []);
		} finally { killMarked(value); }
	});

	test("e2. a job's setsid child ends when the job's shell ends", { timeout: 20_000 }, async () => {
		const value = marker();
		try {
			const app = await started();
			await startJob(app, `setsid sh -c 'sleep ${value}' & sleep 0.5`, value);
			assert.deepEqual(await survivors(value, 6000), []);
		} finally { killMarked(value); }
	});

	test("e3. session_shutdown ends a child that called setsid", { timeout: 20_000 }, async () => {
		const value = marker();
		try {
			const app = await started();
			await startJob(app, `setsid sh -c 'sleep ${value}' & sleep 30`, value);
			await fire(app.handlers, "session_shutdown", app.ctx, { reason: "quit" });
			assert.deepEqual(await survivors(value), []);
		} finally { killMarked(value); }
	});
});
