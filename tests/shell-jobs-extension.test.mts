/**
 * shell-jobs live extension integration tests.
 *
 *   node --test pi/tests/shell-jobs-extension.test.mts
 *
 * Not part of the `node --test pi/tests/*.test.ts` suite: the harness loads the
 * real modules through Pi's jiti aliases, so an installed Pi runtime is needed.
 * The cases run real detached process groups through the tool handlers and
 * assert on group death rather than on mocks.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	__testing,
	cleanup,
	contains,
	fakeTui,
	core,
	createFakePi,
	doesNotContain,
	fire,
	shellJobs,
	sleep,
	tempDir,
	tui,
	widget,
} from "./support/shell-jobs-harness.mts";

const { DETAILS_BUDGET_BYTES, LOG_READ_BYTES, MAX_LIVE, PAYLOAD_CAP_BYTES, TEXT_BUDGET_BYTES, jsonEscapedBytes } = core;
const { SPINNER_FRAMES, WIDGET_REFRESH_MS } = widget;
const { visibleWidth } = tui;

afterEach(cleanup);

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("extension integration", () => {
	test("registers both tools after session_start and skips on collision", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		assert.strictEqual(app.tools.has("shell_job_start"), true);
		assert.strictEqual(app.tools.has("shell_job"), true);

		const blocked = createFakePi(["shell_job_start"]);
		shellJobs(blocked.pi as any);
		await fire(blocked.handlers, "session_start", blocked.ctx);
		assert.strictEqual(blocked.tools.has("shell_job_start"), false);
		assert.strictEqual(blocked.tools.has("shell_job"), true);
		assert.ok(blocked.notices.length > 0);
	});

	test("starts a job without blocking and captures ordered output", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const start = app.tools.get("shell_job_start");
		const started = Date.now();
		const result = await start.execute("t1", { command: "echo out; echo err 1>&2; sleep 0.3" }, undefined, undefined, app.ctx);
		assert.ok(Date.now() - started < 250);
		const details = result.details as { id: string; logPath: string; pid: number };
		assert.strictEqual(details.id, "j1");
		assert.strictEqual(groupAlive(details.pid), true);
		await sleep(600);
		const logs = await app.tools.get("shell_job").execute("t2", { op: "logs", id: "j1" }, undefined, undefined, app.ctx);
		const text = logs.content.map((c: { text: string }) => c.text).join("\n");
		contains(text, "out");
		contains(text, "err");
		assert.ok(text.indexOf("out") < text.indexOf("err"));
		assert.strictEqual(groupAlive(details.pid), false);
	});

	test("notifies exactly once on natural completion with the right message shape", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "echo done" }, undefined, undefined, app.ctx);
		await sleep(500);
		await sleep(200);
		const completions = app.messages.filter((m) => m.message.customType === "shell-job-complete");
		assert.strictEqual((completions).length, 1);
		assert.strictEqual(completions[0].options?.triggerTurn, true);
		assert.strictEqual(completions[0].options?.deliverAs, "steer");
		contains(completions[0].message.content, "exit 0");
		contains(completions[0].message.content, "done");
	});

	test("kill terminates the whole process group and suppresses the completion message", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const started = await app.tools
			.get("shell_job_start")
			.execute("t1", { command: "sleep 30 & sleep 30" }, undefined, undefined, app.ctx);
		const pgid = (started.details as { pid: number }).pid;
		const killed = await app.tools.get("shell_job").execute("t2", { op: "kill", id: "j1" }, undefined, undefined, app.ctx);
		assert.strictEqual(killed.details.state, "done");
		await sleep(400);
		assert.strictEqual(groupAlive(pgid), false);
		assert.strictEqual((app.messages.filter((m) => m.message.customType === "shell-job-complete")).length, 0);
	});

	test("lists jobs with state and read-only log page", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "echo one" }, undefined, undefined, app.ctx);
		await sleep(400);
		const listed = await app.tools.get("shell_job").execute("t2", { op: "list" }, undefined, undefined, app.ctx);
		assert.strictEqual((listed.details.jobs).length, 1);
		assert.strictEqual(listed.details.jobs[0].id, "j1");
		assert.strictEqual(listed.details.jobs[0].state, "done");
		// Status text already carries the state; it must not be printed twice.
		assert.strictEqual(listed.content[0].text, "j1 exit 0 echo one");
	});

	test("a title is flattened, echoed in the list, and carried on the completion", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const start = app.tools.get("shell_job_start");
		assert.strictEqual(typeof start.parameters.properties.title, "object");
		const started = await start.execute("t1", { command: "echo one", title: "  Say\n  one " }, undefined, undefined, app.ctx);
		assert.strictEqual(started.details.title, "Say one");
		await sleep(400);
		const listed = await app.tools.get("shell_job").execute("t2", { op: "list" }, undefined, undefined, app.ctx);
		assert.strictEqual(listed.content[0].text, "j1 exit 0 [Say one] echo one");
		assert.strictEqual(listed.details.jobs[0].title, "Say one");
		const completion = app.messages.find((m) => m.message.customType === "shell-job-complete")!;
		assert.ok(completion, "expected a completion");
		contains(completion.message.content, "Job j1 finished: exit 0");
		contains(completion.message.content, "\ntitle: Say one\nlog: ");
		assert.strictEqual(completion.message.details?.title, "Say one");
		// An untitled job is unchanged: no title line, a null title in details.
		await start.execute("t3", { command: "echo two" }, undefined, undefined, app.ctx);
		await sleep(400);
		const plain = app.messages.filter((m) => m.message.customType === "shell-job-complete").at(-1)!;
		doesNotContain(plain.message.content, "title:");
		assert.strictEqual(plain.message.details?.title, null);
		assert.strictEqual((await app.tools.get("shell_job").execute("t4", { op: "list" }, undefined, undefined, app.ctx)).details.jobs[0].title, null);
		assert.strictEqual((await start.execute("t5", { command: "true", title: "   " }, undefined, undefined, app.ctx)).isError, true);
	});

	test("session_shutdown kills live groups and stops notifying", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const started = await app.tools
			.get("shell_job_start")
			.execute("t1", { command: "sleep 30" }, undefined, undefined, app.ctx);
		const pgid = (started.details as { pid: number }).pid;
		await fire(app.handlers, "session_shutdown", app.ctx);
		await sleep(400);
		assert.strictEqual(groupAlive(pgid), false);
		assert.strictEqual((app.messages.filter((m) => m.message.customType === "shell-job-complete")).length, 0);
	});

	test("enforces the live job limit", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const start = app.tools.get("shell_job_start");
		const results: boolean[] = [];
		for (let i = 0; i < MAX_LIVE + 1; i++) {
			const result = await start.execute(`t${i}`, { command: "sleep 30" }, undefined, undefined, app.ctx);
			results.push(result.isError !== true);
		}
		assert.strictEqual((results.filter(Boolean)).length, MAX_LIVE);
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("parallel starts get distinct ids", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const start = app.tools.get("shell_job_start");
		const [first, second] = await Promise.all([
			start.execute("t1", { command: "sleep 30" }, undefined, undefined, app.ctx),
			start.execute("t2", { command: "sleep 30" }, undefined, undefined, app.ctx),
		]);
		assert.notStrictEqual(first.isError, true);
		assert.notStrictEqual(second.isError, true);
		assert.deepStrictEqual([first.details.id, second.details.id].sort(), ["j1", "j2"]);
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("an instant exit still notifies exactly once", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "true" }, undefined, undefined, app.ctx);
		await sleep(700);
		assert.strictEqual((app.messages.filter((m) => m.message.customType === "shell-job-complete")).length, 1);
	});

	test("rejects a missing working directory before spawning", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const result = await app.tools
			.get("shell_job_start")
			.execute("t1", { command: "echo hi", cwd: "/nonexistent-shell-jobs-dir" }, undefined, undefined, app.ctx);
		assert.strictEqual(result.isError, true);
		assert.strictEqual((app.messages).length, 0);
	});

	test("a TERM-ignoring process group is KILLed on shutdown with no orphans", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const started = await app.tools
			.get("shell_job_start")
			.execute("t1", { command: "trap '' TERM; sleep 30 & wait" }, undefined, undefined, app.ctx);
		const pgid = (started.details as { pid: number }).pid;
		await sleep(150);
		assert.strictEqual(groupAlive(pgid), true);
		await fire(app.handlers, "session_shutdown", app.ctx);
		assert.strictEqual(groupAlive(pgid), false);
		assert.strictEqual((app.messages).length, 0);
	});

	test("parallel starts cannot exceed the live limit", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const start = app.tools.get("shell_job_start");
		const results = await Promise.all(
			Array.from({ length: MAX_LIVE + 3 }, (_, i) =>
				start.execute(`t${i}`, { command: "sleep 30" }, undefined, undefined, app.ctx),
			),
		);
		assert.strictEqual((results.filter((r) => r.isError !== true)).length, MAX_LIVE);
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("shutdown reaps a job whose spawn is still in flight", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const pending = app.tools.get("shell_job_start").execute("t1", { command: "sleep 30" }, undefined, undefined, app.ctx);
		await fire(app.handlers, "session_shutdown", app.ctx);
		const result = await pending;
		const pgid = (result.details as { pid?: number } | undefined)?.pid;
		if (typeof pgid === "number") {
			assert.strictEqual(groupAlive(pgid), false);
		} else {
			// The only acceptable no-pid outcome is a reported failure, never a
			// silent success that would leave an orphan.
			assert.strictEqual((result as { isError?: boolean }).isError, true);
		}
	});

	test("kill during residual-group cleanup does not also send a completion", async (t) => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const originalKill = process.kill.bind(process);
		const cleanupStarted = new Promise<void>((resolve) => {
			t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
				const result = originalKill(pid, signal);
				if (pid < 0 && signal === "SIGTERM") resolve();
				return result;
			});
		});
		// The parent must not exit until its child ignores TERM. Otherwise the
		// cleanup can correctly finish before the test ever requests a kill.
		const command = "mkfifo ready; ( trap '' TERM; printf 'ready\\n' > ready; exec sleep 30 ) & read -r ready < ready; exit 0";
		const started = await app.tools.get("shell_job_start")
			.execute("t1", { command }, undefined, undefined, app.ctx);
		const pgid = (started.details as { pid: number }).pid;
		await cleanupStarted;
		const runtime = [...__testing.getRuntimes()].pop()!;
		assert.strictEqual(runtime.jobs.get("j1")?.state, "stopping");
		const killed = await app.tools.get("shell_job").execute("t2", { op: "kill", id: "j1" }, undefined, undefined, app.ctx);
		assert.strictEqual(killed.details.state, "done");
		assert.strictEqual(groupAlive(pgid), false);
		assert.strictEqual((app.messages.filter((m) => m.message.customType === "shell-job-complete")).length, 0);
	});

	test("retained jobs and finalizers stay bounded", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const start = app.tools.get("shell_job_start");
		let failures = 0;
		const logPaths: string[] = [];
		for (let i = 0; i < 130; i++) {
			const result = await start.execute(`t${i}`, { command: "true" }, undefined, undefined, app.ctx);
			if ((result as { isError?: boolean }).isError) failures += 1;
			else logPaths.push((result.details as { logPath: string }).logPath);
			// Wait for actual exits rather than racing an 80ms guess on a loaded host.
			if (i % 6 === 5) {
				const runtime = [...__testing.getRuntimes()].pop()!;
				await Promise.all([...runtime.finals.values()].map((final) => final.promise));
			}
		}
		assert.strictEqual(failures, 0);
		await sleep(500);
		const runtime = [...__testing.getRuntimes()].pop();
		assert.notStrictEqual(runtime, undefined);
		assert.ok(runtime!.jobs.size <= 128);
		assert.ok(runtime!.finals.size <= 128);
		// Nothing acknowledges completions here, so the bound must have been held by
		// abandoning recovery records, not by refusing starts.
		assert.ok(runtime!.abandoned > 0);
		const listed = await app.tools.get("shell_job").execute("t9", { op: "list" }, undefined, undefined, app.ctx);
		assert.strictEqual(listed.details.abandoned, runtime!.abandoned);
		// An abandoned completion keeps its log as the last inspection path.
		const live = new Set([...runtime!.jobs.values()].map((job) => job.logPath));
		const evicted = logPaths.filter((path) => !live.has(path));
		assert.ok(evicted.length > 0);
		assert.strictEqual(evicted.every((path) => existsSync(path)), true);
	});

	test("start details stay inside the response budget for a control-character cwd", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		// Legal on Linux and macOS, and 6x-escaped in JSON, so the raw path cannot
		// be echoed back inside the details payload. macOS caps the whole path at
		// PATH_MAX (1024), so the assertion is the bounded preview, not the byte
		// total; on Linux the same raw echo would also blow the response budget.
		const segments = Array.from({ length: 6 }, () => "\u0001".repeat(120));
		const weird = join(tempDir(), ...segments);
		mkdirSync(weird, { recursive: true });
		const result = await app.tools.get("shell_job_start").execute("t1", { command: "true", cwd: weird }, undefined, undefined, app.ctx);
		assert.ok(!(result as { isError?: boolean }).isError);
		assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= PAYLOAD_CAP_BYTES);
		assert.strictEqual((result.details as { cwd: string }).cwd.includes("\u0001"), false);
		assert.ok((result.details as { cwd: string }).cwd.length <= 200);
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("malformed log bytes cannot push a page past the budget or skip its tail", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		// 0xff decodes to U+FFFD, a 3x expansion, so the window has to shrink
		// before its offsets are reported.
		const started = await app.tools
			.get("shell_job_start")
			.execute("t1", { command: "printf 'A'; printf '\\377%.0s' $(seq 1 4094); printf 'Z'; sleep 0.2" }, undefined, undefined, app.ctx);
		assert.ok(!(started as { isError?: boolean }).isError);
		await sleep(600);
		const page1 = await app.tools.get("shell_job").execute("t2", { op: "logs", id: "j1", offset: 0, bytes: LOG_READ_BYTES }, undefined, undefined, app.ctx);
		const first = page1.content[0].text as string;
		doesNotContain(first, "truncated");
		assert.ok(jsonEscapedBytes(first) <= TEXT_BUDGET_BYTES);
		const next = page1.details.nextOffset as number;
		assert.ok(next < 4096);
		const page2 = await app.tools.get("shell_job").execute("t3", { op: "logs", id: "j1", offset: next, bytes: LOG_READ_BYTES }, undefined, undefined, app.ctx);
		contains(page2.content[0].text, "Z");
	});

	test("an acknowledged completion clears the delivery-failure flag", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "echo done" }, undefined, undefined, app.ctx);
		await sleep(700);
		for (let i = 0; i < 3; i++) await fire(app.handlers, "agent_settled", app.ctx);
		const before = await app.tools.get("shell_job").execute("t2", { op: "list" }, undefined, undefined, app.ctx);
		assert.strictEqual(before.details.jobs[0].deliveryFailed, true);
		const details = app.messages.filter((m) => m.message.customType === "shell-job-complete").at(-1)!.message.details;
		app.handlers.get("message_end")![0]({ message: { role: "custom", customType: "shell-job-complete", details } }, app.ctx);
		const after = await app.tools.get("shell_job").execute("t3", { op: "list" }, undefined, undefined, app.ctx);
		assert.strictEqual(after.details.jobs[0].deliveryFailed, false);
		assert.strictEqual(app.widgets.at(-1)?.value, undefined);
	});

	test("log pagination offsets match the bytes actually returned", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		// Tabs double when serialized, so a page must fit by construction rather
		// than being trimmed after its offsets were computed.
		const started = await app.tools
			.get("shell_job_start")
			.execute("t1", { command: "printf '\\t%.0s' $(seq 1 20000); sleep 0.2" }, undefined, undefined, app.ctx);
		assert.ok(!(started as { isError?: boolean }).isError);
		await sleep(600);
		const page = await app.tools.get("shell_job").execute("t2", { op: "logs", id: "j1", offset: 0, bytes: LOG_READ_BYTES }, undefined, undefined, app.ctx);
		const text = page.content[0].text as string;
		doesNotContain(text, "truncated");
		assert.strictEqual(text.length, LOG_READ_BYTES);
		assert.strictEqual(page.details.nextOffset, LOG_READ_BYTES);
		assert.strictEqual(page.details.eof, false);
	});

	test("list details stay within the payload cap", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const start = app.tools.get("shell_job_start");
		const long = ":" + " ".repeat(20000);
		for (let i = 0; i < 8; i++) {
			await start.execute(`t${i}`, { command: long, cwd: app.ctx.cwd }, undefined, undefined, app.ctx);
		}
		const listed = await app.tools.get("shell_job").execute("t9", { op: "list" }, undefined, undefined, app.ctx);
		assert.ok(Buffer.byteLength(JSON.stringify(listed.details), "utf8") <= DETAILS_BUDGET_BYTES);
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("installs at most one process exit listener across instances", () => {
		const before = process.listenerCount("exit");
		for (let i = 0; i < 4; i++) shellJobs(createFakePi().pi as any);
		assert.ok(process.listenerCount("exit") <= before + 1);
	});

	test("re-sends a completion that never reached session history", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "echo done" }, undefined, undefined, app.ctx);
		await sleep(700);
		const completions = () => app.messages.filter((m) => m.message.customType === "shell-job-complete");
		assert.strictEqual((completions()).length, 1);
		const runtimeId = completions()[0].message.details?.runtimeId;
		assert.strictEqual(typeof runtimeId, "string");
		const branchOf = (entries: unknown[]) => ({ ...app.ctx, sessionManager: { getBranch: () => entries as Array<Record<string, unknown>> } });

		// A history entry from an earlier runtime (same j1 after a restart) must not
		// count as delivery for this runtime.
		await fire(app.handlers, "agent_settled", branchOf([{ type: "custom_message", customType: "shell-job-complete", details: { id: "j1", runtimeId: "earlier-runtime" } }]));
		assert.strictEqual((completions()).length, 2);

		// Empty history: simulate an abort that cleared the queued follow-up.
		await fire(app.handlers, "agent_settled", app.ctx);
		assert.strictEqual((completions()).length, 3);
		// Attempt cap stops the loop even if delivery keeps failing.
		await fire(app.handlers, "agent_settled", app.ctx);
		assert.strictEqual((completions()).length, 3);

		// Once history contains this runtime's entry, reconcile marks it delivered.
		await fire(app.handlers, "agent_settled", branchOf([{ type: "custom_message", customType: "shell-job-complete", details: { id: "j1", runtimeId } }]));
		assert.strictEqual((completions()).length, 3);
	});

	test("reconcile re-queues every undelivered completion in one settle", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		for (const command of ["echo one", "echo two", "echo three"]) {
			await app.tools.get("shell_job_start").execute("t", { command }, undefined, undefined, app.ctx);
		}
		await sleep(900);
		const completions = () => app.messages.filter((m) => m.message.customType === "shell-job-complete");
		assert.strictEqual((completions()).length, 3);
		// One settle re-queues all three, the way queued user messages behave.
		await fire(app.handlers, "agent_settled", app.ctx);
		assert.strictEqual((completions()).length, 6);
		await fire(app.handlers, "agent_settled", app.ctx);
		assert.strictEqual((completions()).length, 9);
		// The next round would exceed the attempt cap, so it flags instead of sending.
		await fire(app.handlers, "agent_settled", app.ctx);
		assert.strictEqual((completions()).length, 9);
		const listed = await app.tools.get("shell_job").execute("t9", { op: "list" }, undefined, undefined, app.ctx);
		assert.strictEqual(listed.details.jobs.every((job: { deliveryFailed: boolean }) => job.deliveryFailed), true);
	});

	test("completion messages carry the tail and its native truncation notice", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "seq 1 40" }, undefined, undefined, app.ctx);
		await sleep(800);
		const message = app.messages.find((m) => m.message.customType === "shell-job-complete")!;
		contains(message.message.content, "Job j1 finished: exit 0 after");
		// The log line is always the second line, truncated or not.
		assert.match(message.message.content, /^Job j1 finished: exit 0 after [\d.]+s\nlog: \S+\/j1\.log\n\n/);
		assert.match(message.message.content, /\[Showing lines 11-40 of 40\. Full output: /);
		doesNotContain(message.message.content, "bounded to");
		assert.strictEqual(message.message.details?.truncated, true);
		assert.strictEqual(message.message.details?.totalLines, 40);
		assert.strictEqual(message.message.details?.command, "seq 1 40");
	});

	test("completion messages name the log when nothing was truncated", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "echo short" }, undefined, undefined, app.ctx);
		await sleep(800);
		const message = app.messages.find((m) => m.message.customType === "shell-job-complete")!;
		doesNotContain(message.message.content, "[Showing");
		contains(message.message.content, "log: ");
		assert.strictEqual(message.message.details?.truncated, false);
	});

	test("delivers completions as steering messages so a running run absorbs them", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "echo one" }, undefined, undefined, app.ctx);
		await sleep(600);
		const completion = app.messages.find((m) => m.message.customType === "shell-job-complete")!;
		// Steering is injected before the next assistant response in the same run.
		// A follow-up waits for the model to stop first, so the completion costs a
		// separate request that resends the entire conversation.
		assert.strictEqual(completion.options?.deliverAs, "steer");
		assert.strictEqual(completion.options?.triggerTurn, true);
	});

	test("message_end marks a completion delivered and suppresses re-send", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "echo done" }, undefined, undefined, app.ctx);
		await sleep(700);
		const completions = () => app.messages.filter((m) => m.message.customType === "shell-job-complete");
		assert.strictEqual((completions()).length, 1);
		const details = completions()[0].message.details ?? {};
		const handler = app.handlers.get("message_end")![0];
		handler({ message: { role: "custom", customType: "shell-job-complete", details } }, app.ctx);
		await fire(app.handlers, "agent_settled", app.ctx);
		assert.strictEqual((completions()).length, 1);
	});

	test("keeps a finished job visible until its completion is acknowledged", async () => {
		const app = createFakePi([], "rpc");
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "echo one" }, undefined, undefined, app.ctx);
		await sleep(600);
		// The completion is queued behind the running turn and no message_end has
		// fired, so the row must survive the exit and read as pending rather than
		// blinking out and reappearing on the next unrelated update.
		const pending = app.widgets.at(-1)?.value;
		assert.strictEqual(Array.isArray(pending), true);
		contains(JSON.stringify(pending), "exit 0 · pending");
		// Acknowledging the message clears the row.
		const details = app.messages.at(-1)!.message.details;
		app.handlers.get("message_end")![0]({ message: { role: "custom", customType: "shell-job-complete", details } }, app.ctx);
		assert.strictEqual(app.widgets.at(-1)?.value, undefined);
	});

	test("renders job rows in RPC mode and clears them on shutdown", async () => {
		const app = createFakePi([], "rpc");
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "sleep 30" }, undefined, undefined, app.ctx);
		const shown = app.widgets.at(-1);
		assert.strictEqual(shown?.id, "shell-jobs");
		assert.strictEqual(Array.isArray(shown?.value), true);
		contains(JSON.stringify(shown?.value), "j1");
		contains(JSON.stringify(shown?.value), "sleep 30");
		// No header row and no elapsed column: RPC cannot tick a timer.
		doesNotContain(JSON.stringify(shown?.value), "running");
		await fire(app.handlers, "session_shutdown", app.ctx);
		assert.strictEqual(app.widgets.at(-1)?.value, undefined);
	});

	test("in TUI mode the widget installs a live component factory", async () => {
		const app = createFakePi([], "tui");
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "sleep 30 && npm test -- --watchAll=false" }, undefined, undefined, app.ctx);
		const value = app.widgets.at(-1)?.value;
		assert.strictEqual(typeof value, "function");
		const renders: number[] = [];
		const component = (value as (tui: unknown, theme: unknown) => { render(width: number): string[] })(
			{ requestRender: () => renders.push(Date.now()) },
			{ fg: (_key: string, text: string) => text },
		);
		const lines = component.render(24);
		assert.match(lines[0], new RegExp(`^ [${SPINNER_FRAMES.join("")}]  j1`));
		// truncateToWidth adds ANSI resets, so width must be measured visibly.
		assert.ok(visibleWidth(lines[0]) <= 24);
		// 24 columns is narrower than the row, so the command must be truncated.
		doesNotContain(lines[0], "watchAll");
		const widgetCalls = app.widgets.length;
		await sleep(WIDGET_REFRESH_MS + 500);
		// The timer asks for a render instead of re-setting the widget.
		assert.ok(renders.length > 0);
		assert.strictEqual(app.widgets.length, widgetCalls);
		// A theme missing a key degrades to plain text instead of breaking the widget.
		const degrade = (value as (tui: unknown, theme: unknown) => { render(width: number): string[] })(
			{ requestRender: () => {} },
			{ fg: () => { throw new Error("no such theme key"); } },
		);
		const fallback = degrade.render(24);
		contains(fallback[0], "j1");
		assert.ok(visibleWidth(fallback[0]) <= 24);
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("removes the session log directory on shutdown", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const started = await app.tools.get("shell_job_start").execute("t1", { command: "echo hi" }, undefined, undefined, app.ctx);
		const logDir = dirname((started.details as { logPath: string }).logPath);
		assert.strictEqual(existsSync(logDir), true);
		await sleep(400);
		await fire(app.handlers, "session_shutdown", app.ctx);
		assert.strictEqual(existsSync(logDir), false);
	});
});

describe("inspector hooks", () => {
	const plainTheme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
	const click = { type: "click", button: "left", x: 2, y: 0, screenX: 2, screenY: 0, width: 80, height: 10, shift: false, alt: false, ctrl: false };
	type App = ReturnType<typeof createFakePi>;

	async function startApp(mode = "tui") {
		const app = createFakePi([], mode);
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		return app;
	}

	/** Build the overlay pi would show from the last recorded `ui.custom` call. */
	function lastOverlay(app: App) {
		const entry = app.overlays.at(-1)!;
		const component = entry.factory(fakeTui(), plainTheme, {}, entry.resolve);
		return { entry, component, text: () => component.render(80).join("\n") };
	}

	/** Close the overlay the way a user would and let the extension notice. */
	async function closeOverlay(component: any) {
		component.handleInput("\u001b");
		await sleep(5);
	}

	test("clicking a start row opens the inspector for that job, one at a time", async () => {
		const app = await startApp();
		const start = app.tools.get("shell_job_start");
		const started = await start.execute("call-1", { command: "sleep 30", title: "Nap" }, undefined, undefined, app.ctx);
		const context = { toolCallId: "call-1", expanded: false, state: {} };
		const header = start.renderCall({ command: "sleep 30", title: "Nap" }, plainTheme, context);
		assert.deepStrictEqual(header.handleMouse(click), { handled: true });
		assert.strictEqual(app.overlays.length, 1);
		const first = lastOverlay(app);
		contains(first.text(), "Nap");
		contains(first.text(), "$ sleep 30");
		// While one is open, another click does not stack a second overlay.
		header.handleMouse(click);
		assert.strictEqual(app.overlays.length, 1);
		await closeOverlay(first.component);
		// The result slot opens it as well, and other mouse events fall through.
		const body = start.renderResult(started, { expanded: false }, plainTheme, context);
		assert.strictEqual(body.handleMouse({ ...click, button: "right" }), undefined);
		assert.strictEqual(body.handleMouse({ ...click, type: "move" }), undefined);
		assert.deepStrictEqual(body.handleMouse(click), { handled: true });
		assert.strictEqual(app.overlays.length, 2);
		await closeOverlay(lastOverlay(app).component);
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("a start row with no live job notifies when it names one and falls through otherwise", async () => {
		const app = await startApp();
		const start = app.tools.get("shell_job_start");
		const stale = { content: [{ type: "text", text: "Started j9 (pid 1) in /tmp" }], details: { id: "j9" } };
		const body = start.renderResult(stale, { expanded: false }, plainTheme, { toolCallId: "old-call", expanded: false, state: {} });
		assert.deepStrictEqual(body.handleMouse(click), { handled: true });
		assert.strictEqual(app.overlays.length, 0);
		contains(app.notices.at(-1)?.text, "j9");
		contains(app.notices.at(-1)?.text, "earlier session");
		// A header that resolves to nothing leaves the click to pi's expand toggle.
		const header = start.renderCall({ command: "x" }, plainTheme, { toolCallId: "old-call", expanded: false, state: {} });
		assert.strictEqual(header.handleMouse(click), undefined);
		assert.strictEqual(start.renderCall({ command: "x" }, plainTheme).handleMouse(click), undefined);
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("clicking a manage row opens the job it addressed, only for this session", async () => {
		const app = await startApp();
		await app.tools.get("shell_job_start").execute("call-1", { command: "sleep 30", title: "Nap" }, undefined, undefined, app.ctx);
		const manage = app.tools.get("shell_job");
		const logs = await manage.execute("call-2", { op: "logs", id: "j1" }, undefined, undefined, app.ctx);
		assert.strictEqual(typeof logs.details.runtimeId, "string");
		const context = { toolCallId: "call-2", expanded: false, state: {} };
		// The result slot renders first in pi's order and records what the row is about.
		manage.renderResult(logs, { expanded: false }, plainTheme, context);
		const header = manage.renderCall({ op: "logs", id: "j1" }, plainTheme, context);
		assert.deepStrictEqual(header.handleMouse(click), { handled: true });
		assert.strictEqual(app.overlays.length, 1);
		const shown = lastOverlay(app);
		contains(shown.text(), "Nap");
		await closeOverlay(shown.component);
		// The same id from an earlier session is not this session's j1.
		const foreign = { toolCallId: "call-3", expanded: false, state: {} };
		manage.renderResult({ ...logs, details: { ...logs.details, runtimeId: "other" } }, { expanded: false }, plainTheme, foreign);
		assert.strictEqual(manage.renderCall({ op: "logs", id: "j1" }, plainTheme, foreign).handleMouse(click), undefined);
		// A list names no job, so its row keeps pi's expand toggle.
		const listed = await manage.execute("call-4", { op: "list" }, undefined, undefined, app.ctx);
		const listContext = { toolCallId: "call-4", expanded: false, state: {} };
		assert.strictEqual(manage.renderResult(listed, { expanded: false }, plainTheme, listContext).handleMouse(click), undefined);
		assert.strictEqual(app.overlays.length, 1);
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("/jobs opens a job by id, offers a picker otherwise, and completes ids", async () => {
		const app = await startApp();
		const command = app.commands.get("jobs")!;
		assert.strictEqual(typeof command.description, "string");
		await command.handler("", app.ctx);
		contains(app.notices.at(-1)?.text, "No shell jobs");
		const start = app.tools.get("shell_job_start");
		await start.execute("c1", { command: "sleep 30", title: "Nap" }, undefined, undefined, app.ctx);
		await start.execute("c2", { command: "sleep 31", title: "Second" }, undefined, undefined, app.ctx);
		await command.handler("j2", app.ctx);
		assert.strictEqual(app.overlays.length, 1);
		const direct = lastOverlay(app);
		contains(direct.text(), "Second");
		await closeOverlay(direct.component);
		// No argument with several jobs: a picker, newest first, cancel opens nothing.
		await command.handler("  ", app.ctx);
		assert.strictEqual(app.selects.length, 1);
		assert.strictEqual(app.overlays.length, 1);
		const options = app.selects[0].options;
		assert.strictEqual(options.length, 2);
		assert.strictEqual(options[0].startsWith("j2"), true);
		contains(options[0], "Second");
		contains(options[1], "sleep 30");
		app.selectAnswers.push(options[1]);
		await command.handler("", app.ctx);
		assert.strictEqual(app.overlays.length, 2);
		const picked = lastOverlay(app);
		contains(picked.text(), "Nap");
		await closeOverlay(picked.component);
		await command.handler("j7", app.ctx);
		contains(app.notices.at(-1)?.text, "Unknown job j7");
		assert.strictEqual(app.overlays.length, 2);
		const completions = await command.getArgumentCompletions("j");
		assert.deepStrictEqual(completions.map((item: { value: string }) => item.value), ["j2", "j1"]);
		assert.deepStrictEqual((await command.getArgumentCompletions("j1")).map((item: { value: string }) => item.value), ["j1"]);
		assert.deepStrictEqual(await command.getArgumentCompletions("zzz"), []);
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("clicking a widget row opens that job", async () => {
		const app = await startApp();
		const start = app.tools.get("shell_job_start");
		await start.execute("c1", { command: "sleep 30", title: "Nap" }, undefined, undefined, app.ctx);
		await start.execute("c2", { command: "sleep 31", title: "Second" }, undefined, undefined, app.ctx);
		const factory = app.widgets.at(-1)?.value as (host: unknown, theme: unknown) => any;
		const rows = factory({ requestRender: () => {} }, plainTheme);
		rows.render(80);
		assert.deepStrictEqual(rows.handleMouse({ ...click, y: 1 }), { handled: true });
		const shown = lastOverlay(app);
		contains(shown.text(), "Second");
		await closeOverlay(shown.component);
		// Past the last row, or not a left click: nothing.
		assert.strictEqual(rows.handleMouse({ ...click, y: 7 }), undefined);
		assert.strictEqual(rows.handleMouse({ ...click, y: 0, button: "middle" }), undefined);
		assert.strictEqual(app.overlays.length, 1);
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("outside the TUI nothing tries to open an overlay", async () => {
		const app = await startApp("rpc");
		const start = app.tools.get("shell_job_start");
		await start.execute("c1", { command: "sleep 30" }, undefined, undefined, app.ctx);
		const header = start.renderCall({ command: "sleep 30" }, plainTheme, { toolCallId: "c1", expanded: false, state: {} });
		assert.strictEqual(header.handleMouse?.(click), undefined);
		await app.commands.get("jobs")!.handler("j1", app.ctx);
		assert.strictEqual(app.overlays.length, 0);
		contains(app.notices.at(-1)?.text, "TUI");
		await fire(app.handlers, "session_shutdown", app.ctx);
	});
});
