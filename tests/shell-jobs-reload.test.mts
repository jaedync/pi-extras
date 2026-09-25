/** Real process groups and fresh module evaluations, no model or network calls. */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	__testing, cleanup, core, createFakePi, delivery, fire, loadFreshShellJobs, shellJobs, sleep,
} from "./support/shell-jobs-harness.mts";

type App = ReturnType<typeof createFakePi>;
const apps: App[] = [];
const pids = new Set<number>();

afterEach(async () => {
	for (const app of apps.splice(0).reverse()) await fire(app.handlers, "session_shutdown", app.ctx, { reason: "quit" });
	// A failing reload test must not leave detached commands behind.
	for (const pid of pids) {
		try { process.kill(-pid, "SIGKILL"); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	pids.clear();
	cleanup();
});

async function boot(previous?: App, reason = previous ? "reload" : "startup", mode = "rpc") {
	const app = createFakePi([], mode);
	if (previous) app.ctx.sessionManager = previous.ctx.sessionManager;
	apps.push(app);
	const factory = previous ? (await loadFreshShellJobs()).default : shellJobs;
	factory(app.pi as any);
	await fire(app.handlers, "session_start", app.ctx, { reason });
	return app;
}

async function start(app: App, command = "sleep 30") {
	const result = await app.tools.get("shell_job_start").execute("start", { command }, undefined, undefined, app.ctx);
	assert.notEqual(result.isError, true, result.content[0].text);
	pids.add(result.details.pid);
	return result.details as { id: string; pid: number; logPath: string };
}

async function list(app: App) {
	return (await app.tools.get("shell_job").execute("list", { op: "list" }, undefined, undefined, app.ctx)).details.jobs;
}

async function pause(app: App) {
	await fire(app.handlers, "session_shutdown", app.ctx, { reason: "reload" });
}

async function until(check: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!check() && Date.now() < deadline) await sleep(10);
	assert.ok(check(), "condition did not become true within 5s");
}

async function acknowledge(app: App) {
	const message = app.messages.at(-1)!.message;
	await fire(app.handlers, "message_end", app.ctx, { message: { ...message, role: "custom" } });
	app.ctx.sessionManager.getBranch = () => [{ type: "custom_message", ...message }];
}

test("reload preserves pid, log, runtime identity, counter, widget and kill control", async () => {
	const first = await boot();
	const job = await start(first, "echo before; sleep 30");
	const runtime = [...__testing.getRuntimes()][0];
	await pause(first);
	assert.doesNotThrow(() => process.kill(-job.pid, 0));
	assert.ok(existsSync(job.logPath));
	assert.equal(first.widgets.at(-1)?.value, undefined);
	const second = await boot(first);
	assert.deepEqual([...__testing.getRuntimes()], [runtime]);
	const [restored] = await list(second);
	assert.equal(restored.logPath, job.logPath);
	assert.equal(restored.startedAt, runtime.jobs.get(job.id)!.startedAt);
	assert.match(JSON.stringify(second.widgets.at(-1)?.value), /echo-before/);
	const next = await start(second);
	assert.equal(next.id, "sleep-30");
	const logs = await second.tools.get("shell_job").execute("logs", { op: "logs", id: job.id });
	assert.match(logs.content[0].text, /before/);
	const killed = await second.tools.get("shell_job").execute("kill", { op: "kill", id: job.id });
	assert.equal(killed.details.state, "done");
	assert.throws(() => process.kill(-job.pid, 0));
	assert.equal(first.messages.length + second.messages.length, 0);
});

test("a completion in the reload gap is delivered once through the replacement API", async () => {
	const first = await boot();
	const release = join(first.ctx.cwd, "release");
	const job = await start(first, `while [ ! -f '${release}' ]; do sleep 0.02; done; echo during-reload`);
	const runtime = [...__testing.getRuntimes()][0];
	await pause(first);
	writeFileSync(release, "");
	await until(() => runtime.jobs.get(job.id)?.state === "done");
	assert.equal(first.messages.length, 0);
	assert.ok(existsSync(job.logPath));
	const second = await boot(first);
	await until(() => second.messages.length === 1);
	assert.match(second.messages[0].message.content, /during-reload/);
	assert.equal(second.messages[0].message.details?.runtimeId, runtime.runtimeId);
	await acknowledge(second);
	await fire(second.handlers, "agent_settled", second.ctx);
	await pause(second);
	const third = await boot(second);
	assert.equal(third.messages.length, 0);
	assert.equal(second.messages.length, 1);
});

test("a spawn in flight survives reload without releasing its live slot", async () => {
	const first = await boot();
	const pending = first.tools.get("shell_job_start").execute("start", { command: "sleep 30" }, undefined, undefined, first.ctx);
	await pause(first);
	const result = await pending;
	assert.notEqual(result.isError, true);
	pids.add(result.details.pid);
	assert.doesNotThrow(() => process.kill(-result.details.pid, 0));
	const second = await boot(first);
	assert.equal((await list(second)).length, 1);
	assert.equal((await start(second)).id, "sleep-30-2");
});

test("repeated reloads keep one runtime and exit listener, without stale tools or events", async () => {
	let current = await boot();
	const first = current;
	await start(first);
	const runtime = [...__testing.getRuntimes()][0];
	const listeners = process.listenerCount("exit");
	for (let i = 0; i < 3; i++) {
		await pause(current);
		current = await boot(current);
		assert.equal((await list(current)).length, 1);
		assert.equal(__testing.getRuntimes().size, 1);
		assert.equal(process.listenerCount("exit"), listeners);
	}
	const stale = await first.tools.get("shell_job_start").execute("stale", { command: "true" }, undefined, undefined, first.ctx);
	assert.equal(stale.isError, true);
	const staleKill = await first.tools.get("shell_job").execute("stale", { op: "kill", id: "sleep-30" });
	assert.equal(staleKill.isError, true);
	await fire(first.handlers, "message_end", first.ctx, {
		message: { role: "custom", customType: "shell-job-complete", details: { id: "sleep-30", runtimeId: runtime.runtimeId } },
	});
	assert.equal(runtime.jobs.get("sleep-30")!.delivered, false);
});

test("another session in the same process cannot adopt a parked runtime", async () => {
	const first = await boot();
	await start(first);
	await pause(first);
	const unrelated = createFakePi();
	unrelated.ctx.cwd = first.ctx.cwd;
	Object.assign(first.ctx.sessionManager, { getSessionId: () => "same-id" });
	Object.assign(unrelated.ctx.sessionManager, { getSessionId: () => "same-id" });
	apps.push(unrelated);
	(await loadFreshShellJobs()).default(unrelated.pi as any);
	await fire(unrelated.handlers, "session_start", unrelated.ctx, { reason: "reload" });
	assert.equal((await list(unrelated)).length, 0);
	const second = await boot(first);
	assert.equal((await list(second)).length, 1);
	assert.equal((await list(unrelated)).length, 0);
});

for (const reason of ["quit", "new", "resume", "fork"]) {
	test(`${reason} after reload still terminates jobs and removes logs`, async () => {
		const first = await boot();
		const job = await start(first);
		await pause(first);
		const second = await boot(first);
		await fire(second.handlers, "session_shutdown", second.ctx, { reason });
		assert.throws(() => process.kill(-job.pid, 0));
		assert.equal(existsSync(job.logPath), false);
		assert.equal(first.messages.length + second.messages.length, 0);
		assert.equal(__testing.getRuntimes().size, 0);
	});
}

test("history acknowledgement missed during reload prevents a duplicate", async () => {
	const first = await boot();
	await start(first, "echo once");
	await until(() => first.messages.length === 1);
	const message = first.messages[0].message;
	first.ctx.sessionManager.getBranch = () => [{ type: "custom_message", ...message }];
	await pause(first);
	const second = await boot(first);
	assert.equal(second.messages.length, 0);
	assert.equal([...__testing.getRuntimes()][0].jobs.get("echo-once")!.delivered, true);
});

test("reload does not requeue a completion still owned by a busy Pi turn", async () => {
	const first = await boot();
	first.ctx.isIdle = () => false;
	await start(first, "echo queued");
	await until(() => first.messages.length === 1);
	await pause(first);
	const second = createFakePi();
	second.ctx.sessionManager = first.ctx.sessionManager;
	second.ctx.isIdle = () => false;
	apps.push(second);
	(await loadFreshShellJobs()).default(second.pi as any);
	await fire(second.handlers, "session_start", second.ctx, { reason: "reload" });
	assert.equal(second.messages.length, 0);
	// Once Pi has discarded that queue and settled, normal bounded recovery applies.
	second.ctx.isIdle = () => true;
	await fire(second.handlers, "agent_settled", second.ctx);
	assert.equal(second.messages.length, 1);
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("reload during a tail read leaves delivery to the new API, without a duplicate or extra attempt", async () => {
	const first = await boot();
	const runtime = [...__testing.getRuntimes()][0];
	const entered = deferred();
	const release = deferred();
	delivery.attachDelivery(runtime, first.pi as any, async (...args) => {
		entered.resolve();
		await release.promise;
		return core.readLogTail(...args);
	});
	await start(first, "echo tail-read-race");
	await entered.promise;
	const oldFlight = runtime.delivery!.flush();
	await pause(first);
	const second = await boot(first);
	assert.equal(second.messages.length, 1);
	release.resolve();
	await oldFlight;
	assert.equal(first.messages.length, 0);
	assert.equal(second.messages.length, 1);
	assert.equal(runtime.jobs.get("echo-tail-read-race")!.attempts, 1);
});

test("tail read errors during actual shutdown cannot send or reject a process callback", async () => {
	const first = await boot();
	const runtime = [...__testing.getRuntimes()][0];
	const entered = deferred();
	const release = deferred();
	delivery.attachDelivery(runtime, first.pi as any, async () => {
		entered.resolve();
		await release.promise;
		throw new Error("test log vanished");
	});
	await start(first, "echo shutdown-race");
	await entered.promise;
	const oldFlight = runtime.delivery!.flush();
	await fire(first.handlers, "session_shutdown", first.ctx, { reason: "quit" });
	release.resolve();
	await oldFlight;
	assert.equal(first.messages.length, 0);
});

test("live limit and completion attempt cap survive repeated reloads", async () => {
	let current = await boot();
	await start(current, "echo retry");
	await until(() => current.messages.length === 1);
	for (let i = 0; i < 4; i++) {
		await pause(current);
		current = await boot(current);
	}
	const runtime = [...__testing.getRuntimes()][0];
	assert.equal(runtime.jobs.get("echo-retry")!.attempts, 3);
	assert.equal(runtime.jobs.get("echo-retry")!.deliveryFailed, true);
	assert.equal(apps.reduce((n, app) => n + app.messages.length, 0), 3);
	for (let i = 0; i < core.MAX_LIVE; i++) await start(current);
	await pause(current);
	current = await boot(current);
	const over = await current.tools.get("shell_job_start").execute("over", { command: "true" }, undefined, undefined, current.ctx);
	assert.equal(over.isError, true);
	assert.match(over.content[0].text, /Too many live jobs/);
});

test("a kill in progress across reload keeps its claim and never emits a completion", async () => {
	const first = await boot();
	const job = await start(first, "trap '' TERM; echo ready; sleep 30 & wait");
	await until(() => readFileSync(job.logPath, "utf8").includes("ready"));
	const kill = first.tools.get("shell_job").execute("kill", { op: "kill", id: "trap" });
	await pause(first);
	const second = await boot(first);
	assert.equal((await list(second))[0].state, "stopping");
	const result = await kill;
	assert.equal(result.details.state, "done");
	assert.equal(first.messages.length + second.messages.length, 0);
	await fire(second.handlers, "agent_settled", second.ctx);
	assert.equal(second.messages.length, 0);
});

test("TUI reload stops the old timer and attaches only the replacement widget", async () => {
	const first = await boot(undefined, "startup", "tui");
	await start(first);
	let oldRenders = 0;
	const oldFactory = first.widgets.at(-1)!.value as Function;
	oldFactory({ requestRender: () => oldRenders++ }, { fg: (_key: string, text: string) => text });
	await pause(first);
	const before = oldRenders;
	const second = await boot(first, "reload", "tui");
	let newRenders = 0;
	const newFactory = second.widgets.at(-1)!.value as Function;
	assert.notEqual(newFactory, oldFactory);
	newFactory({ requestRender: () => newRenders++ }, { fg: (_key: string, text: string) => text });
	await sleep(550);
	assert.equal(oldRenders, before);
	assert.ok(newRenders >= 1);
});

test("loading a factory without starting a session owns no runtime or exit listener", () => {
	const listeners = process.listenerCount("exit");
	shellJobs(createFakePi().pi as any);
	assert.equal(__testing.getRuntimes().size, 0);
	assert.equal(process.listenerCount("exit"), listeners);
});

test("the process exit safety net still kills groups if the extension never reattaches", async () => {
	const fixture = fileURLToPath(new URL("./fixtures/shell-jobs-exit-net.mts", import.meta.url));
	const { stdout } = await promisify(execFile)(process.execPath, [fixture], { timeout: 10_000 });
	const job = JSON.parse(stdout) as { pid: number; logPath: string; cwd: string };
	try {
		await until(() => {
			try { process.kill(-job.pid, 0); return false; } catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
				throw error;
			}
		});
	} finally {
		rmSync(dirname(job.logPath), { recursive: true, force: true });
		rmSync(job.cwd, { recursive: true, force: true });
	}
});
