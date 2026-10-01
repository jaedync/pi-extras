import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { reportText } from "../lib/subagents/format.ts";
import { Team } from "../lib/subagents/team.ts";
import { acquireParent } from "../lib/subagents/ownership.ts";
import { ChildIndex, recoverRoster, reportRunFloor } from "../lib/subagents/restore.ts";
import { createSessionScanner } from "../lib/subagents/session-scan.ts";
import { runKey, runLogEntry } from "../lib/subagents/runlog.ts";
import { NO_USAGE, type AgentRecord, type MainDelivery } from "../lib/subagents/types.ts";

const record = (patch: Partial<AgentRecord> = {}): AgentRecord => ({ name: "helper", parent: "main", depth: 1, model: "old/model", task: "Task",
	readOnly: false, fork: false, blocking: false, state: "interrupted", createdAt: 1, activity: null, runs: 1, toolCalls: 0, usage: NO_USAGE, restored: true, ...patch });
const handle = () => ({ async prompt() {}, steer() {}, async abort() {}, lastText: () => "Done", messages: () => [], takeQueued: () => [], async dispose() {} });

test("reload interruption of an automatic attempt does not reset its retry budget", async () => {
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100, deliverToMain() {}, launcher: { async launch() { return { ...handle(), prompt: () => new Promise<void>(() => {}) }; } } });
	team.restore([record({ autoResumeAttempts: 1 })]);
	await team.send("main", "helper", "Continue", { automatic: true });
	await tick();
	team.interrupt("reload", "owner");
	assert.equal(team.get("helper")?.autoResumeAttempts, 1);
	await team.close();
});

test("a different hostname cannot steal a lease and leaves the old owner intact", () => {
	const dir = mkdtempSync(join(tmpdir(), "lease-host-"));
	try {
		const lock = join(dir, ".owner"); mkdirSync(lock);
		const file = join(lock, "owner.json");
		writeFileSync(file, JSON.stringify({ pid: process.pid, token: "original", host: "different-host.example", started: "old" }));
		assert.throws(() => acquireParent(dir), (error: unknown) => (error as Error).message.includes(lock) && (error as Error).message.includes("remove"));
		assert.equal(JSON.parse(readFileSync(file, "utf8")).token, "original");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("process birth identity is independent of the contender's TZ and locale", { skip: process.platform === "win32" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "lease-zone-"));
	const module = new URL("../lib/subagents/ownership.ts", import.meta.url).href;
	try {
		const release = acquireParent(dir);
		try {
			const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { acquireParent } from ${JSON.stringify(module)}; try { acquireParent(${JSON.stringify(dir)})(); process.exit(4); } catch (error) { console.log(error.message); }`],
				{ env: { ...process.env, TZ: "Pacific/Honolulu", LC_ALL: "fr_FR.UTF-8" }, encoding: "utf8" });
			assert.equal(child.status, 0, child.stderr);
			assert.match(child.stdout, /already owned/);
		} finally { release(); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit model substitutions are included in the sender's result", async () => {
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100, deliverToMain() {}, launcher: { async launch() { return handle(); } },
		prepareResume: () => ({ model: "new/model", note: "Continuing on a new model", notice: "Model old/model is not available now, running on new/model." }) });
	team.restore([record()]);
	const result = await team.send("main", "helper", "Continue");
	assert.equal(result.ok && result.notice, "Model old/model is not available now, running on new/model.");
	await team.close();
});

test("a failed resume launch remains retryable and has a distinct log identity", async () => {
	let launches = 0;
	const deliveries: MainDelivery[] = [];
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100, deliverToMain: (delivery) => deliveries.push(delivery), launcher: { async launch() { if (++launches === 1) throw new Error("Saved session missing"); return handle(); } } });
	team.restore([record()]);
	await team.send("main", "helper", "Continue");
	const failed = await team.whenDone("helper");
	assert.equal(failed.state, "interrupted");
	assert.match(failed.error!, /Saved session missing/);
	assert.equal(deliveries[0]?.kind, "report");
	if (deliveries[0]?.kind === "report") {
		assert.equal(deliveries[0].record.state, "interrupted", "main sees the retryable state too");
		assert.match(deliveries[0].record.report!, /Resume launch failed: Saved session missing/);
		assert.match(reportText(deliveries[0].record, 100).split("\n")[0]!, /could not resume: Saved session missing/);
		assert.doesNotMatch(reportText(deliveries[0].record, 100).split("\n")[0]!, /finished after/);
	}
	const entry = runLogEntry(failed, 100, "parent");
	assert.equal(entry.event, "resume_launch_failed");
	assert.notEqual(runKey(entry), runKey(runLogEntry(record(), 100, "parent")));
	assert.equal((await team.send("main", "helper", "Try again")).ok, true);
	assert.equal((await team.whenDone("helper")).state, "idle");
	await team.close();
});

test("interrupted reports identify paused work instead of claiming completion", () => {
	const text = reportText(record({ report: "Partial work", startedAt: 10, endedAt: 20 }), 100);
	assert.match(text.split("\n")[0]!, /was interrupted after/);
	assert.doesNotMatch(text.split("\n")[0]!, /finished after/);
	assert.match(text, /Resume explicitly/);
	assert.match(text, /Partial work/);
});

test("transcript snapshots use a bounded LRU and retain recently inspected files", () => {
	const dir = mkdtempSync(join(tmpdir(), "scan-lru-"));
	let parses = 0;
	const scanner = createSessionScanner((text) => { parses++; return text.split("\n").map((line) => JSON.parse(line)); }, () => {});
	try {
		const files = Array.from({ length: 65 }, (_, i) => join(dir, `${i}.jsonl`));
		for (const file of files) writeFileSync(file, JSON.stringify({ type: "session", id: "header", cwd: dir, version: 3 }));
		for (const file of files.slice(0, 64)) scanner.branch(file);
		const hot = scanner.branch(files[0]!);
		scanner.branch(files[64]!);
		assert.equal(scanner.branch(files[0]!), hot);
		assert.equal(parses, 65);
		scanner.branch(files[1]!);
		assert.equal(parses, 66, "the least recently inspected snapshot was evicted");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unreadable directory listing does not disable the saved roster", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
	const root = mkdtempSync(join(tmpdir(), "restore-unreadable-"));
	const index = new ChildIndex(root, "parent", root);
	const file = join(index.dir, "helper.jsonl");
	const original = console.warn;
	const warnings: string[] = [];
	try {
		index.save([record({ sessionFile: file, runs: 3 })]);
		writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "child", cwd: root }));
		chmodSync(index.dir, 0o300);
		console.warn = () => assert.fail("restoration warnings must use the caller's notification channel");
		const warn = (warning: string) => warnings.push(warning);
		const loaded = index.load(warn);
		assert.equal(loaded.length, 1);
		const records = recoverRoster(loaded, index.dir, () => [], warn);
		assert.equal(records.length, 1);
		assert.equal(records[0]?.runs, 3);
		assert.equal(warnings.length, 1);
	} finally {
		console.warn = original;
		chmodSync(index.dir, 0o700);
		rmSync(root, { recursive: true, force: true });
	}
});

test("unreadable report lookup preserves indexed runs and warns only once", () => {
	const dir = mkdtempSync(join(tmpdir(), "report-permission-"));
	const warnings: string[] = [];
	try {
		const deny = () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); };
		assert.equal(reportRunFloor(join(dir, "child.jsonl"), 3, (warning) => warnings.push(warning), deny), 3);
		assert.equal(reportRunFloor(join(dir, "child.jsonl"), 3, (warning) => warnings.push(warning), deny), 3);
		assert.equal(warnings.length, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
