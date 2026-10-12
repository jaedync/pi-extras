/**
 * shell-jobs start-path tests: how a job is named, where it runs, which shell
 * and environment it gets, and what its completion says about the process
 * group. They load the real extension through the shell-jobs harness and run
 * real process groups.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, createFakePi, fire, shellJobs, sleep } from "./support/shell-jobs-harness.mts";

afterEach(cleanup);

async function started() {
	const app = createFakePi();
	shellJobs(app.pi as any);
	await fire(app.handlers, "session_start", app.ctx);
	return app;
}

describe("start", () => {
	test("untitled jobs named from a bare slash start and free their slot", async () => {
		const app = await started();
		const start = app.tools.get("shell_job_start");
		for (let index = 0; index < 9; index++) {
			const result = await start.execute(`t${index}`, { command: "ls /" }, undefined, undefined, app.ctx);
			assert.notStrictEqual(result.isError, true, result.content[0].text);
			await sleep(150);
		}
	});
});
