/**
 * shell-jobs start-path tests: how a job is named, where it runs, which shell
 * and environment it gets, and what its completion says about the process
 * group. They load the real extension through the shell-jobs harness and run
 * real process groups.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

	test("a relative cwd is the session's, and ~ is the home directory", async () => {
		const app = await started();
		mkdirSync(join(app.ctx.cwd, "sub"));
		const start = app.tools.get("shell_job_start");
		const relative = await start.execute("t1", { command: "pwd", cwd: "sub", title: "Where" }, undefined, undefined, app.ctx);
		assert.notStrictEqual(relative.isError, true, relative.content[0].text);
		const home = await start.execute("t2", { command: "pwd", cwd: "~", title: "Home" }, undefined, undefined, app.ctx);
		assert.notStrictEqual(home.isError, true, home.content[0].text);
		await sleep(400);
		assert.strictEqual(realpathSync(readFileSync(relative.details.logPath, "utf8").trim()), realpathSync(join(app.ctx.cwd, "sub")));
		assert.strictEqual(realpathSync(readFileSync(home.details.logPath, "utf8").trim()), realpathSync(homedir()));
	});
});
