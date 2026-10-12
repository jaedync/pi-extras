/**
 * shell-jobs start-path tests: how a job is named, where it runs, which shell
 * and environment it gets, and what its completion says about the process
 * group. They load the real extension through the shell-jobs harness and run
 * real process groups.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanup, createFakePi, fire, shellJobs, sleep, tempDir } from "./support/shell-jobs-harness.mts";

afterEach(cleanup);

/** Run `body` with PI_CODING_AGENT_DIR on a fresh directory, so nothing reads or writes the real one. */
async function withAgentDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = tempDir();
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return await body(dir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

/** Record each child process made while it is on; every spawn goes through this prototype method. */
function captureSpawns(): { children: ChildProcess[]; restore(): void } {
	const original = ChildProcess.prototype.spawn;
	const children: ChildProcess[] = [];
	ChildProcess.prototype.spawn = function (this: ChildProcess, ...args: Parameters<typeof original>) {
		children.push(this);
		return original.apply(this, args);
	};
	return { children, restore() { ChildProcess.prototype.spawn = original; } };
}

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

	test("an error event from a running job's process is logged, not thrown", async () => {
		await withAgentDir(async (dir) => {
			const spawns = captureSpawns();
			try {
				const app = await started();
				const result = await app.tools.get("shell_job_start").execute("t1", { command: "sleep 0.3", title: "Nap" }, undefined, undefined, app.ctx);
				assert.notStrictEqual(result.isError, true, result.content[0].text);
				assert.strictEqual(spawns.children.length, 1);
				assert.doesNotThrow(() => spawns.children[0]!.emit("error", new Error("late failure")));
				assert.match(readFileSync(join(dir, "shell-jobs.log"), "utf8"), /late failure/);
				await sleep(600);
			} finally {
				spawns.restore();
			}
		});
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
