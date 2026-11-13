/**
 * A shell-jobs kill ends every process of the job, also one that called
 * setsid and so left the job's process group. Each test marks its processes
 * with a unique sleep length and SIGKILLs every marked process at its end.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	test("e4. a systemd-run that cannot start the scope still runs the job, in its own group", { timeout: 20_000 }, async () => {
		const app = await started();
		const start = app.tools.get("shell_job_start");
		// A first job makes this module instance probe with the real systemd-run.
		const probe = await start.execute("p", { command: "true", title: "Probe" }, undefined, undefined, app.ctx);
		assert.notStrictEqual(probe.isError, true, probe.content[0].text);
		const dir = mkdtempSync(join(tmpdir(), "tree-fake-systemd-run-"));
		writeFileSync(join(dir, "systemd-run"), "#!/bin/sh\necho 'Failed to connect to bus: fake' >&2\nexit 1\n");
		chmodSync(join(dir, "systemd-run"), 0o755);
		const path = process.env.PATH;
		process.env.PATH = `${dir}:${path ?? ""}`;
		try {
			const result = await start.execute("f", { command: "echo ran-job", title: "Fake" }, undefined, undefined, app.ctx);
			assert.notStrictEqual(result.isError, true, result.content[0].text);
			const id = (result.details as { id: string }).id;
			let text = "";
			for (let waited = 0; waited < 5000 && !text.includes("ran-job"); waited += 100) {
				await sleep(100);
				const logs = await app.tools.get("shell_job").execute("l", { op: "logs", id }, undefined, undefined, app.ctx);
				text = logs.content.map((c: { text: string }) => c.text).join("\n");
			}
			assert.match(text, /ran-job/);
			assert.doesNotMatch(text, /Failed to connect/);
		} finally {
			process.env.PATH = path;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
