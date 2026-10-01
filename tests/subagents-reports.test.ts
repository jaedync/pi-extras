import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestReportFile, reportFilePath, saveReport, writeReport } from "../lib/subagents/reports.ts";
import { capReport, REPORT_MAX_CHARS, reportText } from "../lib/subagents/format.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";
import { Team } from "../lib/subagents/team.ts";
import { commandCompletions } from "../lib/subagents/names.ts";

function record(extra: Partial<AgentRecord> = {}): AgentRecord {
	return { name: "reviewer", parent: "main", depth: 1, task: "Review", model: "faux/cheap", readOnly: false,
		fork: false, blocking: false, state: "idle", createdAt: 0, startedAt: 0, endedAt: 1_000,
		activity: null, toolCalls: 0, usage: NO_USAGE, runs: 1, report: "All good.", ...extra };
}

function scratch(t: { after(fn: () => void): void }): string {
	const dir = fs.mkdtempSync(join(tmpdir(), "subagents-reports-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const session = join(dir, "child.jsonl");
	fs.writeFileSync(session, "session", { mode: 0o640 });
	return session;
}

test("report names preserve the session base and use the existing run counter", () => {
	assert.equal(reportFilePath("/sessions/child.jsonl", 2), "/sessions/child.run-2.report.md");
	assert.equal(reportFilePath("/sessions/child", 1), "/sessions/child.run-1.report.md");
	assert.throws(() => reportFilePath("/sessions/child.jsonl", -1));
});

test("reports publish by hard link only after a full private temp write, and never overwrite", (t) => {
	const session = scratch(t);
	const text = "# Full report\n\n" + "evidence 🍎\n".repeat(2_000);
	const file = reportFilePath(session, 1);
	let linked = false;
	const io = { ...fs, linkSync(from: fs.PathLike, to: fs.PathLike) {
		assert.equal(fs.existsSync(file), false);
		assert.equal(fs.readFileSync(from, "utf8"), text);
		assert.equal(fs.statSync(from).mode & 0o777, 0o600);
		linked = true;
		fs.linkSync(from, to);
	} };
	assert.equal(writeReport(session, 1, text, io), file);
	assert.ok(linked);
	assert.equal(fs.readFileSync(file, "utf8"), text);
	assert.throws(() => writeReport(session, 1, "replacement"));
	assert.equal(fs.readFileSync(file, "utf8"), text);
	assert.deepEqual(fs.readdirSync(join(session, "..")), ["child.jsonl", "child.run-1.report.md"]);
	const second = writeReport(session, 2, "second run");
	assert.equal(fs.readFileSync(second, "utf8"), "second run");
	assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("failed publication cleans the temp file and leaves no partial report", (t) => {
	const session = scratch(t);
	assert.throws(() => writeReport(session, 1, "full", { ...fs, linkSync() { throw new Error("disk failure"); } }), /disk failure/);
	assert.deepEqual(fs.readdirSync(join(session, "..")), ["child.jsonl"]);
});

test("failed writes clean up and an occupied temp file is never removed", (t) => {
	const session = scratch(t);
	assert.throws(() => writeReport(session, 1, "full", { ...fs, writeFileSync() { throw new Error("disk full"); } }), /disk full/);
	assert.deepEqual(fs.readdirSync(join(session, "..")), ["child.jsonl"]);
	const temp = `${reportFilePath(session, 1)}.tmp`;
	fs.writeFileSync(temp, "another writer");
	assert.equal(fs.readFileSync(writeReport(session, 1, "full"), "utf8"), "full");
	assert.equal(fs.readFileSync(temp, "utf8"), "another writer");
});

test("report permissions never exceed the session's owner permissions", (t) => {
	const session = scratch(t);
	fs.chmodSync(session, 0o400);
	const file = writeReport(session, 1, "private");
	assert.equal(fs.statSync(file).mode & 0o777, 0o400);
});

test("report save failure logs and keeps today's session-file fallback", (t) => {
	const sessionFile = join(scratch(t), "missing.jsonl");
	const original = record({ sessionFile, report: "x".repeat(REPORT_MAX_CHARS + 1), reportFile: "/older.report.md" });
	const errors: string[] = [];
	const saved = saveReport(original, (message) => errors.push(message));
	assert.equal(saved.reportFile, undefined);
	assert.equal(saved.report, original.report);
	assert.equal(original.reportFile, "/older.report.md");
	assert.equal(errors.length, 1);
	assert.match(errors[0]!, /could not write.*report/);
	assert.match(reportText(saved, 1_000), /whole report is the last assistant message in/);
});

test("every outcome with final text carries a report path and a bounded preview", (t) => {
	const sessionFile = scratch(t);
	for (const [index, state] of (["idle", "failed", "stopped"] as const).entries()) {
		const saved = saveReport(record({ sessionFile, runs: index + 1, state, error: "provider failed", report: "x".repeat(REPORT_MAX_CHARS) + "CRITICAL END" }));
		const message = reportText(saved, 1_000);
		assert.ok(message.includes(`Report: ${saved.reportFile}`));
		assert.ok(message.includes(`The whole report is in ${saved.reportFile}.`));
		assert.ok(!message.includes("CRITICAL END"));
		assert.ok(!message.includes("last assistant message"));
		assert.equal(fs.readFileSync(saved.reportFile!, "utf8"), saved.report);
	}
	const short = saveReport(record({ sessionFile, runs: 4 }));
	assert.ok(reportText(short, 1_000).includes(`Report: ${short.reportFile}`));
	assert.ok(reportText(short, 1_000).endsWith("All good."));
	assert.equal(capReport("short"), "short");
});

test("empty final text does not create a report file", (t) => {
	const sessionFile = scratch(t);
	assert.equal(saveReport(record({ sessionFile, report: undefined })).reportFile, undefined);
	assert.deepEqual(fs.readdirSync(join(sessionFile, "..")), ["child.jsonl"]);
});

test("a failed or stopped child saves final text before delivering completion", async (t) => {
	for (const state of ["failed", "stopped"] as const) {
		const sessionFile = scratch(t);
		let started!: () => void;
		const ready = new Promise<void>((resolve) => { started = resolve; });
		let fail!: (error: Error) => void;
		let startedRun = false;
		const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100,
			deliverToMain(delivery) {
				assert.equal(delivery.kind, "report");
				if (delivery.kind === "report") assert.equal(fs.readFileSync(delivery.record.reportFile!, "utf8"), "partial evidence");
			},
			launcher: { async launch() { return { sessionFile, prompt: () => new Promise<void>((_, reject) => { startedRun = true; fail = reject; started(); }),
				lastText: () => "partial evidence", steer() {}, takeQueued: () => [], messages: () => [{ role: "assistant", content: [{ type: "text", text: "partial evidence" }] }].slice(startedRun ? 0 : 1), abort: async () => {}, dispose: async () => {} }; } },
		});
		t.after(() => { void team.close(); });
		assert.ok(team.spawn({ task: "review", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false }).ok);
		await ready;
		if (state === "failed") fail(new Error("provider failed"));
		else await team.stop("review");
		const done = await team.whenDone("review");
		assert.equal(done.state, state);
		assert.equal(fs.readFileSync(done.reportFile!, "utf8"), "partial evidence");
	}
});

test("a disk failure cannot block the completion delivery or its waiter", async (t) => {
	const sessionFile = join(scratch(t), "missing.jsonl");
	const warnings: string[] = [];
	t.mock.method(console, "warn", () => assert.fail("warnings must use the injected UI callback"));
	const full = "x".repeat(REPORT_MAX_CHARS + 1);
	let message = "";
	const messages: unknown[] = [];
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100, warn: (text) => warnings.push(text),
		deliverToMain(delivery) { if (delivery.kind === "report") message = reportText(delivery.record, 1_000); },
		launcher: { async launch() { return { sessionFile, prompt: async () => { messages.push({ role: "assistant", content: [{ type: "text", text: full }] }); }, lastText: () => full, steer() {},
			takeQueued: () => [], messages: () => messages, abort: async () => {}, dispose: async () => {} }; } },
	});
	t.after(() => { void team.close(); });
	assert.ok(team.spawn({ task: "review", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false }).ok);
	const done = await team.whenDone("review");
	assert.equal(done.state, "idle");
	assert.equal(done.report, full);
	assert.equal(done.reportFile, undefined);
	assert.equal(warnings.length, 1);
	assert.ok(message.includes(`The whole report is the last assistant message in ${sessionFile}.`));
});

test("latest report discovery survives lost in-memory paths and uses numeric run order", (t) => {
	const session = scratch(t);
	writeReport(session, 2, "two");
	writeReport(session, 10, "ten");
	fs.writeFileSync(join(session, "..", "other.run-99.report.md"), "not this agent");
	fs.writeFileSync(`${reportFilePath(session, 20)}.tmp`, "unfinished");
	fs.mkdirSync(reportFilePath(session, 30));
	assert.equal(latestReportFile(session), reportFilePath(session, 10));
	assert.equal(latestReportFile(join(session, "..", "missing.jsonl")), undefined);
	const prior = record({ sessionFile: session, reportFile: reportFilePath(session, 10), report: undefined });
	assert.equal(saveReport(prior).reportFile, prior.reportFile);
});

test("atomic publication cannot overwrite a file created by a competing writer", (t) => {
	const session = scratch(t);
	const file = reportFilePath(session, 1);
	assert.throws(() => writeReport(session, 1, "new", { ...fs, linkSync(from, to) {
		fs.writeFileSync(to, "winner");
		fs.linkSync(from, to);
	} }), /EEXIST/);
	assert.equal(fs.readFileSync(file, "utf8"), "winner");
	assert.deepEqual(fs.readdirSync(join(session, "..")), ["child.jsonl", "child.run-1.report.md"]);
});

test("throwing close still removes the attempt's temp file", (t) => {
	const session = scratch(t);
	assert.throws(() => writeReport(session, 1, "new", { ...fs, closeSync(fd) {
		fs.closeSync(fd);
		throw new Error("close failed");
	} }), /close failed/);
	assert.deepEqual(fs.readdirSync(join(session, "..")), ["child.jsonl"]);
});

test("preview cuts preserve surrogate pairs and close open Markdown fences", () => {
	const text = "x".repeat(REPORT_MAX_CHARS - 1) + "🍎tail";
	const preview = capReport(text, undefined, "/full.report.md");
	assert.ok(preview.startsWith("x".repeat(REPORT_MAX_CHARS - 1) + "\n\n(report cut"));
	assert.ok(!preview.includes("\ud83c"));
	const fenced = capReport("```ts\n" + "x".repeat(REPORT_MAX_CHARS), undefined, "/full.report.md");
	assert.match(fenced, /\n```\n\n\(report cut/);
	assert.equal((fenced.match(/```/g) ?? []).length % 2, 0);
});

test("resumed failed and stopped runs never reuse the previous assistant's text", async (t) => {
	for (const state of ["failed", "stopped"] as const) {
		const sessionFile = scratch(t);
		const messages: unknown[] = [];
		let resumed!: () => void;
		let reject!: (error: Error) => void;
		const ready = new Promise<void>((resolve) => { resumed = resolve; });
		let calls = 0;
		let completion = "";
		const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100,
			deliverToMain(delivery) { if (delivery.kind === "report") completion = reportText(delivery.record, 1_000); },
			launcher: { async launch() { return { sessionFile, prompt: async () => {
				if (++calls === 1) { messages.push({ role: "assistant", content: [{ type: "text", text: "previous report" }] }); return; }
				await new Promise<void>((_, fail) => { reject = fail; resumed(); });
			}, lastText: () => "previous report", messages: () => messages, steer() {}, takeQueued: () => [], abort: async () => {}, dispose: async () => {} }; } },
		});
		t.after(() => { void team.close(); });
		team.spawn({ task: "review", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false });
		const first = await team.whenDone("review");
		assert.equal(fs.readFileSync(first.reportFile!, "utf8"), "previous report");
		await team.send("main", "review", "Do more");
		await ready;
		if (state === "failed") reject(new Error("auth failed before reply"));
		else await team.stop("review");
		const second = await team.whenDone("review");
		assert.equal(second.report, undefined);
		assert.equal(fs.existsSync(reportFilePath(sessionFile, 2)), false);
		assert.ok(!completion.includes("previous report"));
		assert.equal(second.reportFile, first.reportFile, "the latest saved report remains available to the user");
	}
});

test("a throwing warning callback cannot stop report delivery or its waiter", async (t) => {
	const sessionFile = join(scratch(t), "missing.jsonl");
	let messages: unknown[] = [];
	let delivered = false;
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100,
		warn() { throw new Error("extension context is stale"); },
		deliverToMain() { delivered = true; },
		launcher: { async launch() { return { sessionFile, prompt: async () => { messages = [{ role: "assistant", content: [{ type: "text", text: "own report" }] }]; },
			lastText: () => "own report", messages: () => messages, steer() {}, takeQueued: () => [], abort: async () => {}, dispose: async () => {} }; } },
	});
	t.after(() => { void team.close(); });
	team.spawn({ task: "review", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false });
	const done = await team.whenDone("review");
	assert.equal(done.report, "own report");
	assert.equal(done.reportFile, undefined);
	assert.ok(delivered);
});

test("temp cleanup failure after publication is a successful save with a warning", (t) => {
	const session = scratch(t);
	const warnings: string[] = [];
	const file = writeReport(session, 1, "saved in full", { ...fs, unlinkSync() { throw new Error("cleanup denied"); } }, (message) => warnings.push(message));
	assert.equal(fs.readFileSync(file, "utf8"), "saved in full");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /temporary report.*cleanup denied/);
});

test("unsupported hard links fall back to exclusive, flushed writes without overwriting", (t) => {
	const session = scratch(t);
	for (const [index, code] of ["EPERM", "ENOTSUP", "EXDEV"].entries()) {
		const file = reportFilePath(session, index + 1);
		const writes: Array<{ fd: number; flag: string }> = [];
		const flushed: number[] = [];
		const io = { ...fs, linkSync() { throw Object.assign(new Error(code), { code }); },
			openSync(path: fs.PathLike, flag: fs.OpenMode, mode?: fs.Mode | null) { const fd = fs.openSync(path, flag, mode); writes.push({ fd, flag: String(flag) }); return fd; },
			fsyncSync(fd: number) { flushed.push(fd); fs.fsyncSync(fd); } };
		assert.equal(writeReport(session, index + 1, "fallback", io), file);
		assert.equal(fs.readFileSync(file, "utf8"), "fallback");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.equal(writes.at(-1)!.flag, "wx");
		assert.ok(flushed.includes(writes.at(-1)!.fd));
		assert.throws(() => writeReport(session, index + 1, "replacement", io), /EEXIST/);
		assert.equal(fs.readFileSync(file, "utf8"), "fallback");
	}
	assert.ok(fs.readdirSync(join(session, "..")).every((name) => !name.endsWith(".tmp")));
});

test("current-run text matches Pi trimming and empty-final-message semantics", async (t) => {
	const cases = [
		{ final: { role: "assistant", content: [{ type: "text", text: "  final answer  \n" }] }, expected: "final answer" },
		{ final: { role: "assistant", content: [] }, expected: undefined },
		{ final: { role: "assistant", content: [{ type: "thinking", thinking: "done" }] }, expected: undefined },
		{ final: { role: "assistant", stopReason: "aborted", content: [] }, expected: "narration" },
		{ final: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "  partial  " }] }, expected: "partial" },
	];
	for (const item of cases) {
		let messages: unknown[] = [];
		const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100, deliverToMain() {},
			launcher: { async launch() { return { prompt: async () => { messages = [{ role: "assistant", content: [{ type: "text", text: "  narration  " }] }, item.final]; },
				lastText: () => undefined, messages: () => messages, steer() {}, takeQueued: () => [], abort: async () => {}, dispose: async () => {} }; } },
		});
		t.after(() => { void team.close(); });
		team.spawn({ task: "review", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false });
		assert.equal((await team.whenDone("review")).report, item.expected);
	}
});

test("report commands complete agent names and close when complete", () => {
	assert.deepEqual(commandCompletions("report re", ["reviewer"])?.map((item) => item.value), ["report reviewer"]);
	assert.equal(commandCompletions("report reviewer", ["reviewer", "reviewer-2"]), null);
});
