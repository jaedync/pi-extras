/**
 * shell-jobs start-path tests: how a job is named, where it runs, which shell
 * and environment it gets, and what its completion says about the process
 * group. They load the real extension through the shell-jobs harness and run
 * real process groups.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentDir, cleanup, createFakePi, fire, shellJobs, sleep, tempDir } from "./support/shell-jobs-harness.mts";

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
	// `spawn` is an internal method, so the types do not list it.
	const proto = ChildProcess.prototype as unknown as { spawn(this: ChildProcess, ...args: unknown[]): unknown };
	const original = proto.spawn;
	const children: ChildProcess[] = [];
	proto.spawn = function (this: ChildProcess, ...args: unknown[]) {
		children.push(this);
		return original.apply(this, args);
	};
	return { children, restore() { proto.spawn = original; } };
}

/** Run `body` with some process variables set, as a parent Pi or a login shell would leave them. */
async function withEnv<T>(values: Record<string, string>, body: () => Promise<T>): Promise<T> {
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	try {
		return await body();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** Start one job and return what it printed once it is done. */
async function output(app: Awaited<ReturnType<typeof started>>, command: string): Promise<string> {
	const result = await app.tools.get("shell_job_start").execute(`t-${Math.random()}`, { command, title: "Probe" }, undefined, undefined, app.ctx);
	assert.notStrictEqual(result.isError, true, result.content[0].text);
	for (let waited = 0; waited < 3000 && app.messages.every((m) => m.message.details?.id !== result.details.id); waited += 50) await sleep(50);
	return readFileSync(result.details.logPath, "utf8").trim();
}

async function started() {
	const app = createFakePi();
	shellJobs(app.pi as any);
	await fire(app.handlers, "session_start", app.ctx);
	return app;
}

describe("isolation", () => {
	test("the harness points Pi's agent directory at a scratch directory of its own", () => {
		assert.strictEqual(process.env.PI_CODING_AGENT_DIR, agentDir);
		assert.ok(agentDir.startsWith(realpathSync(tmpdir())) || agentDir.startsWith(tmpdir()), agentDir);
	});
});

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

describe("shell and environment, as Pi's bash tool has them", () => {
	const which = 'echo "${BASH_VERSION:+bash}${ZSH_VERSION:+zsh}"';

	test("a job runs in Pi's shell, not the login shell", { skip: !existsSync("/bin/zsh") }, async () => {
		await withAgentDir(() => withEnv({ SHELL: "/bin/zsh" }, async () => {
			const app = await started();
			assert.strictEqual(await output(app, which), "bash");
			assert.strictEqual(await output(app, "echo *.nomatch-glob"), "*.nomatch-glob");
		}));
	});

	test("Pi's shellPath and shellCommandPrefix settings apply to a job", { skip: !existsSync("/bin/zsh") }, async () => {
		await withAgentDir(async (dir) => {
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ shellPath: "/bin/zsh", shellCommandPrefix: "export JOB_PREFIX=applied" }));
			const app = await started();
			assert.strictEqual(await output(app, `${which}; echo $JOB_PREFIX`), "zsh\napplied");
		});
	});

	test("shell settings are read when the session starts, as Pi's bash tool reads them, not at each job", async () => {
		await withAgentDir(async (dir) => {
			const settings = join(dir, "settings.json");
			writeFileSync(settings, JSON.stringify({ shellCommandPrefix: "export JOB_PREFIX=first" }));
			const app = await started();
			writeFileSync(settings, JSON.stringify({ shellCommandPrefix: "export JOB_PREFIX=second" }));
			assert.strictEqual(await output(app, "echo $JOB_PREFIX"), "first");
			// A reload loads the extension again, and the new load reads the settings again.
			const reloaded = await started();
			assert.strictEqual(await output(reloaded, "echo $JOB_PREFIX"), "second");
		});
	});

	test("a shellPath that does not exist fails the start with Pi's reason", async () => {
		await withAgentDir(async (dir) => {
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ shellPath: join(dir, "no-such-shell") }));
			const app = await started();
			const result = await app.tools.get("shell_job_start").execute("t1", { command: "true" }, undefined, undefined, app.ctx);
			assert.strictEqual(result.isError, true);
			assert.match(result.content[0].text, /Custom shell path not found/);
		});
	});

	test("a job gets Pi's bin directory first in PATH and this session's PI_ variables", async () => {
		await withAgentDir((dir) => withEnv({ PI_SESSION_ID: "stale-parent", PI_SESSION_FILE: "/stale.jsonl", PI_MODEL: "parent-model", PI_PROVIDER: "parent", PI_REASONING_LEVEL: "high" }, async () => {
			const app = await started();
			Object.assign(app.ctx, {
				sessionManager: { ...app.ctx.sessionManager, getSessionId: () => "this-session", getSessionFile: () => undefined },
				model: { provider: "anthropic", id: "claude-x" },
			});
			const printed = await output(app, 'echo "${PATH%%:*}|${PI_SESSION_ID-unset}|${PI_SESSION_FILE-unset}|${PI_PROVIDER-unset}|${PI_MODEL-unset}|${PI_REASONING_LEVEL-unset}"');
			assert.strictEqual(printed, `${join(dir, "bin")}|this-session|unset|anthropic|claude-x|unset`);
		}));
	});
});

describe("background processes at exit", () => {
	test("the completion says how many background processes were still running and were stopped", async () => {
		await withAgentDir(async () => {
			const app = await started();
			const start = app.tools.get("shell_job_start");
			const daemon = await start.execute("t1", { command: "sleep 30 & sleep 30 & echo server started", title: "Start server" }, undefined, undefined, app.ctx);
			const plain = await start.execute("t2", { command: "echo plain", title: "Plain" }, undefined, undefined, app.ctx);
			const completion = async (id: string) => {
				for (let waited = 0; waited < 4000; waited += 50) {
					const found = app.messages.find((m) => m.message.details?.id === id);
					if (found) return found.message.content;
					await sleep(50);
				}
				throw new Error(`no completion for ${id}`);
			};
			const text = await completion(daemon.details.id);
			assert.match(text, /^stopped: 2 background processes that were still running when the command exited$/m);
			assert.doesNotMatch(await completion(plain.details.id), /background process/);
			let alive = true;
			try { process.kill(-daemon.details.pid, 0); } catch { alive = false; }
			assert.strictEqual(alive, false, "the group is still stopped at exit");
		});
	});
});
