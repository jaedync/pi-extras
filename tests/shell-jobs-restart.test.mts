/**
 * Background shell jobs across a Pi restart (an auto-update of Pi itself):
 * the old process hands its jobs over, the new process for the same session
 * adopts them. Real process groups, no model or network calls.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { __testing, agentDir, cleanup, createFakePi, fire, jiti, loadFreshShellJobs, sleep } from "./support/shell-jobs-harness.mts";

const handover = (await jiti.import("../../lib/shell-jobs-handover.ts")) as typeof import("../lib/shell-jobs-handover.ts");
const intent = (await jiti.import("../../lib/restart-intent.ts")) as typeof import("../lib/restart-intent.ts");

type App = ReturnType<typeof createFakePi>;
const apps: App[] = [];
const groups = new Set<number>();
const logDirs = new Set<string>();
const SESSION = "/sessions/restart-a.jsonl";

afterEach(async () => {
	intent.clearRestart();
	for (const app of apps.splice(0).reverse()) await fire(app.handlers, "session_shutdown", app.ctx, { reason: "quit" });
	for (const pid of groups) {
		try { process.kill(-pid, "SIGKILL"); } catch (error) {
			// macOS answers EPERM for a group whose members are all zombies.
			if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
	groups.clear();
	// A test that failed before its new process claimed the hand-over must not hand it to the next test.
	rmSync(handover.handoverDir(agentDir), { recursive: true, force: true });
	// A dropped or refused hand-over leaves its log folder to the system's temp cleaner; a test removes it.
	for (const dir of logDirs) rmSync(dir, { recursive: true, force: true });
	logDirs.clear();
	rmSync(join(agentDir, "shell-jobs"), { recursive: true, force: true });
	cleanup();
});

/** A new Pi process for `sessionFile`: a fresh module, as a restarted Pi loads it. */
async function boot(options: { sessionFile?: string; sessionId?: string; reason?: string } = {}) {
	const app = createFakePi();
	Object.assign(app.ctx.sessionManager, {
		getSessionFile: () => options.sessionFile ?? SESSION,
		getSessionId: () => options.sessionId ?? "restart-session",
	});
	apps.push(app);
	(await loadFreshShellJobs()).default(app.pi as any);
	await fire(app.handlers, "session_start", app.ctx, { reason: options.reason ?? "startup" });
	return app;
}

async function start(app: App, command: string, title = "Restart job") {
	const result = await app.tools.get("shell_job_start").execute("start", { command, title }, undefined, undefined, app.ctx);
	assert.notEqual(result.isError, true, result.content[0].text);
	groups.add(result.details.pid);
	logDirs.add(dirname(result.details.logPath));
	return result.details as { id: string; pid: number; logPath: string };
}

/** The old Pi's side of a restart: auto-update's intent, then Pi's "quit" shutdown. */
async function restart(app: App) {
	intent.markRestart((app.ctx.sessionManager as unknown as { getSessionFile(): string }).getSessionFile());
	await fire(app.handlers, "session_shutdown", app.ctx, { reason: "quit" });
	apps.splice(apps.indexOf(app), 1);
	intent.clearRestart();
}

const tool = (app: App) => app.tools.get("shell_job");
async function list(app: App) {
	return (await tool(app).execute("list", { op: "list" }, undefined, undefined, app.ctx)).details.jobs as Array<Record<string, unknown>>;
}

const alive = (pgid: number) => {
	try { process.kill(-pgid, 0); return true; } catch (error) {
		// macOS answers EPERM for a group whose members are all zombies: none of them runs.
		if (["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
};

async function until(check: () => boolean, ms = 8000) {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await sleep(20);
	assert.ok(check(), `condition did not become true within ${ms} ms`);
}

const file = () => handover.handoverPath(agentDir, SESSION);

function editHandover(change: (record: Record<string, any>) => void) {
	const record = JSON.parse(readFileSync(file(), "utf8"));
	change(record);
	writeFileSync(file(), JSON.stringify(record), { mode: 0o600 });
}

test("end to end: a job survives the old Pi process, and the new one reports it once with exit 0 and its log", async () => {
	const fixture = fileURLToPath(new URL("./fixtures/shell-jobs-restart.mts", import.meta.url));
	// The job waits for a gate file, not a fixed time: a loaded machine must not let it end before the new process looks.
	const gate = join(mkdtempSync(join(tmpdir(), "restart-gate-")), "go");
	const { stdout } = await promisify(execFile)(process.execPath, [fixture, agentDir, SESSION, `while [ ! -e '${gate}' ]; do sleep 0.05; done; echo done-after-restart`], { timeout: 15_000 });
	const job = JSON.parse(stdout) as { id: string; pid: number; logPath: string; cwd: string };
	groups.add(job.pid);
	try {
		assert.equal(alive(job.pid), true, "the old process exited and the job still runs");
		assert.equal(statSync(file()).mode & 0o777, 0o600);
		const app = await boot();
		const [listed] = await list(app);
		assert.equal(listed.id, job.id);
		assert.equal(listed.state, "running");
		assert.equal(listed.title, "Restart job");
		assert.equal(existsSync(file()), false, "the new process claimed the hand-over file");
		assert.match(JSON.stringify(app.widgets.at(-1)?.value), /restart-job|Restart job/);
		writeFileSync(gate, "");
		await until(() => app.messages.length === 1);
		const [message] = app.messages;
		assert.match(message.message.content, new RegExp(`^Job ${job.id} finished: exit 0 after`));
		assert.match(message.message.content, /done-after-restart/);
		assert.equal(message.message.details?.code, 0);
		await fire(app.handlers, "message_end", app.ctx, { message: { ...message.message, role: "custom" } });
		await fire(app.handlers, "agent_settled", app.ctx);
		await sleep(700);
		assert.equal(app.messages.length, 1, "delivered once");
		const logs = await tool(app).execute("logs", { op: "logs", id: job.id });
		assert.match(logs.content[0].text, /done-after-restart/);
	} finally {
		rmSync(dirname(job.logPath), { recursive: true, force: true });
		rmSync(job.cwd, { recursive: true, force: true });
		rmSync(dirname(gate), { recursive: true, force: true });
	}
});

test("end to end: a job that ends during the gap reports at once after adoption", async () => {
	const fixture = fileURLToPath(new URL("./fixtures/shell-jobs-restart.mts", import.meta.url));
	const { stdout } = await promisify(execFile)(process.execPath, [fixture, agentDir, SESSION, "sleep 0.3; echo ended-in-gap; exit 3"], { timeout: 15_000 });
	const job = JSON.parse(stdout) as { id: string; pid: number; logPath: string; cwd: string };
	groups.add(job.pid);
	try {
		await until(() => !alive(job.pid));
		const app = await boot();
		assert.equal(app.messages.length, 1, "reported during session start");
		assert.match(app.messages[0].message.content, new RegExp(`^Job ${job.id} finished: exit 3 after`));
		assert.match(app.messages[0].message.content, /ended-in-gap/);
	} finally {
		rmSync(dirname(job.logPath), { recursive: true, force: true });
		rmSync(job.cwd, { recursive: true, force: true });
	}
});

test("a job whose process is gone with no exit file reports as ended, exit code unknown", async () => {
	const old = await boot();
	const job = await start(old, "sleep 30");
	await restart(old);
	process.kill(-job.pid, "SIGKILL");
	await until(() => !alive(job.pid));
	// This test process is the leader's parent; wait until it is reaped, as init reaps it after a real restart.
	await until(() => { try { process.kill(job.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } });
	const app = await boot();
	assert.equal(app.messages.length, 1);
	assert.match(app.messages[0].message.content, new RegExp(`^Job ${job.id} ended, exit code unknown, after`));
	assert.equal((await list(app))[0].state, "done");
});

test("a reused pid is never signalled: a start time that does not match is a job that ended", async () => {
	const old = await boot();
	const job = await start(old, "sleep 30");
	await restart(old);
	editHandover((record) => { record.jobs[0].pidStart = "1"; });
	const app = await boot();
	assert.match(app.messages[0]?.message.content ?? "", /exit code unknown/);
	const killed = await tool(app).execute("kill", { op: "kill", id: job.id });
	assert.match(killed.content[0].text, /already finished/);
	await fire(app.handlers, "session_shutdown", app.ctx, { reason: "quit" });
	apps.splice(apps.indexOf(app), 1);
	assert.equal(alive(job.pid), true, "the group of an unverified pid is not touched");
});

test("a corrupt hand-over file does not break session start: it is logged and removed", async () => {
	const old = await boot();
	await start(old, "sleep 30");
	await restart(old);
	writeFileSync(file(), "{\"version\":1,\"jobs\":[", { mode: 0o600 });
	const app = await boot();
	assert.ok(app.tools.has("shell_job_start"), "the session started");
	assert.deepEqual(await list(app), []);
	assert.equal(existsSync(file()), false);
	assert.match(readFileSync(join(agentDir, "shell-jobs.log"), "utf8"), /hand-over/);
	const next = await start(app, "echo still-works");
	assert.ok(next.id);
});

test("a hand-over record older than 24 h is dropped and its job, still the recorded process, is stopped", async () => {
	const old = await boot();
	const job = await start(old, "sleep 30");
	await restart(old);
	editHandover((record) => { record.writtenAt -= handover.HANDOVER_MAX_AGE_MS + 1; });
	const app = await boot();
	assert.deepEqual(await list(app), []);
	assert.equal(existsSync(file()), false);
	// No restart came for it within a day: it stops, as a quit would have stopped it.
	await until(() => !alive(job.pid));
});

for (const [what, reason, marked] of [["a normal quit", "quit", false], ["a new session", "new", true], ["a resume", "resume", true], ["a fork", "fork", true]] as const) {
	test(`only a restart keeps jobs: ${what} stops them and writes no hand-over`, async () => {
		const app = await boot();
		const job = await start(app, "sleep 30");
		if (marked) intent.markRestart(SESSION);
		await fire(app.handlers, "session_shutdown", app.ctx, { reason });
		apps.splice(apps.indexOf(app), 1);
		assert.equal(alive(job.pid), false);
		assert.equal(existsSync(job.logPath), false);
		assert.equal(existsSync(file()), false);
	});
}

test("a restart hands over: the group lives, the runtime leaves the exit net, the log stays", async () => {
	const old = await boot();
	const job = await start(old, "sleep 30");
	const runtime = [...__testing.getRuntimes()].at(-1)!;
	await restart(old);
	assert.equal(alive(job.pid), true);
	assert.equal(__testing.getRuntimes().has(runtime), false, "process exit no longer kills the group");
	assert.equal(existsSync(job.logPath), true);
	const record = JSON.parse(readFileSync(file(), "utf8"));
	assert.equal(record.jobs[0].id, job.id);
	assert.equal(record.jobs[0].pid, job.pid);
	assert.equal(record.jobs[0].command, "sleep 30");
	assert.equal(typeof record.jobs[0].pidStart, "string");
});

test("a fork, a new session or another session does not adopt the hand-over; the same session does", async () => {
	const old = await boot();
	const job = await start(old, "sleep 30");
	await restart(old);
	const fork = await boot({ reason: "fork", sessionFile: "/sessions/fork.jsonl" });
	assert.deepEqual(await list(fork), []);
	const fresh = await boot({ reason: "new" });
	assert.deepEqual(await list(fresh), [], "a new session never adopts, even with the same file");
	assert.equal(existsSync(file()), true, "the hand-over waits for its session");
	const same = await boot();
	assert.equal((await list(same))[0].id, job.id);
});

test("kill on an adopted job stops its verified group with no completion; a quit stops the rest", async () => {
	const old = await boot();
	const first = await start(old, "sleep 30", "First job");
	const second = await start(old, "sleep 30", "Second job");
	await restart(old);
	const app = await boot();
	const killed = await tool(app).execute("kill", { op: "kill", id: first.id });
	assert.equal(killed.isError, undefined, killed.content[0].text);
	assert.equal(alive(first.pid), false);
	await fire(app.handlers, "session_shutdown", app.ctx, { reason: "quit" });
	apps.splice(apps.indexOf(app), 1);
	assert.equal(alive(second.pid), false, "a normal quit after adoption stops adopted jobs");
	assert.equal(existsSync(second.logPath), false, "and removes their logs");
	assert.equal(app.messages.length, 0);
});

test("an undelivered completion crosses the restart once; one already in history is not sent again", async () => {
	const old = await boot();
	const lost = await start(old, "echo lost-once", "Lost job");
	const kept = await start(old, "echo kept-once", "Kept job");
	await until(() => old.messages.length === 2);
	// Pi quit before either steer reached the model; only `kept` was written to the session.
	const keptMessage = old.messages.find((entry) => entry.message.details?.id === kept.id)!.message;
	await restart(old);
	const app = createFakePi();
	Object.assign(app.ctx.sessionManager, { getSessionFile: () => SESSION, getSessionId: () => "restart-session", getBranch: () => [{ type: "custom_message", ...keptMessage }] });
	apps.push(app);
	(await loadFreshShellJobs()).default(app.pi as any);
	await fire(app.handlers, "session_start", app.ctx, { reason: "startup" });
	assert.deepEqual(app.messages.map((entry) => entry.message.details?.id), [lost.id]);
	assert.match(app.messages[0].message.content, /lost-once/);
	await fire(app.handlers, "message_end", app.ctx, { message: { ...app.messages[0].message, role: "custom" } });
	await restart(app);
	const third = await boot();
	assert.equal(third.messages.length, 0, "a delivered completion is not sent after a second restart");
	assert.equal((await list(third)).length, 2, "the jobs are still listed");
});

test("a job with no recorded start time runs on unverified: kill and quit never signal it, and its exit file still reports it", async () => {
	const old = await boot();
	const release = join(old.ctx.cwd, "release");
	const job = await start(old, `while [ ! -f '${release}' ]; do sleep 0.05; done; echo unverified-end`);
	await restart(old);
	editHandover((record) => { record.jobs[0].pidStart = null; });
	const app = await boot();
	const killed = await tool(app).execute("kill", { op: "kill", id: job.id });
	assert.equal(killed.isError, true);
	assert.match(killed.content[0].text, /not signalled/);
	assert.equal(alive(job.pid), true);
	writeFileSync(release, "");
	await until(() => app.messages.length === 1);
	assert.match(app.messages[0].message.content, /finished: exit 0 after[\s\S]*unverified-end/);
});

test("a quit after adoption leaves an unverified job's group alone", async () => {
	const old = await boot();
	const job = await start(old, "sleep 30");
	await restart(old);
	editHandover((record) => { record.jobs[0].pidStart = null; });
	const app = await boot();
	assert.equal((await list(app))[0].state, "running");
	await fire(app.handlers, "session_shutdown", app.ctx, { reason: "quit" });
	apps.splice(apps.indexOf(app), 1);
	assert.equal(alive(job.pid), true);
});

test("a finished job whose completion was never attempted is sent once after the restart", async () => {
	const old = await boot();
	const job = await start(old, "sleep 30");
	await restart(old);
	process.kill(-job.pid, "SIGKILL");
	// As a job that ended while the old process was already closing: done, with no attempt made.
	editHandover((record) => { Object.assign(record.jobs[0], { state: "done", code: 4, endedAt: Date.now(), attempts: 0 }); });
	const app = await boot();
	assert.equal(app.messages.length, 1);
	assert.match(app.messages[0].message.content, new RegExp(`^Job ${job.id} finished: exit 4 after`));
});

for (const verified of [true, false]) {
	test(`the exit net of the adopting process ${verified ? "kills a verified" : "leaves an unverified"} adopted job`, async () => {
		const old = await boot();
		const job = await start(old, "sleep 30");
		await restart(old);
		if (!verified) editHandover((record) => { record.jobs[0].pidStart = null; });
		const fixture = fileURLToPath(new URL("./fixtures/shell-jobs-adopt-exit.mts", import.meta.url));
		const { stdout } = await promisify(execFile)(process.execPath, [fixture, agentDir, SESSION], { timeout: 15_000 });
		assert.deepEqual(JSON.parse(stdout), [job.id]);
		if (verified) await until(() => !alive(job.pid));
		else {
			await sleep(300);
			assert.equal(alive(job.pid), true);
		}
	});
}

test("kill does not retry the cleanup of an adopted finished job: its group cannot be confirmed as the job's", async () => {
	const old = await boot();
	const job = await start(old, "sleep 30");
	await restart(old);
	editHandover((record) => { Object.assign(record.jobs[0], { state: "done", code: 0, endedAt: Date.now(), attempts: 1, delivered: true, cleanupError: "could not terminate the whole process group" }); });
	const app = await boot();
	const killed = await tool(app).execute("kill", { op: "kill", id: job.id });
	assert.equal(killed.isError, true);
	assert.match(killed.content[0].text, /not signalled/);
	assert.equal(alive(job.pid), true);
});
