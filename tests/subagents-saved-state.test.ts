/**
 * What the index and session files keep across a restart or a /reload: a
 * held answer, records with odd paths, a stopped run's report, unread mail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parkHost, takeParked } from "../lib/subagents/host.ts";
import { ChildIndex, restoreRecord } from "../lib/subagents/restore.ts";
import { Team } from "../lib/subagents/team.ts";
import { type AgentRecord, NO_USAGE } from "../lib/subagents/types.ts";
import { hostHarness } from "./support/host-harness.ts";

const savedRecord = (over: Partial<AgentRecord>): AgentRecord => ({ name: "x", parent: "main", depth: 1, task: "T", model: "m", readOnly: false, fork: false,
	blocking: false, state: "idle", createdAt: 1, activity: null, toolCalls: 0, usage: { ...NO_USAGE }, runs: 1, ...over });

test("a held answer stays held when a quiet host is renewed after a /reload", async () => {
	const h = hostHarness({ resumePolicy: "notify" });
	try {
		const host = h.open(h.portsFor("first"));
		const name = h.spawn(host, "Ask main something");
		await tick();
		host.park();
		const session = {};
		parkHost(session, host, { log: () => undefined });
		const asked = host.team.send(name, "main", "Which branch?", { expectReply: true });
		await sleep(10);
		await takeParked(session)!.close("reload");
		await asked;
		const reopened = h.open(h.portsFor("next"));
		await reopened.restore("startup");
		await sleep(20);
		for (const item of reopened.mail.pending()) reopened.mail.acknowledge(item.id);
		assert.equal(reopened.team.get(name)?.state, "interrupted");
		// What Service.renew does once an adopted host from an older generation is quiet.
		const renewed = h.open(h.portsFor("renewed"), { lease: reopened.handOver(), generation: 2 });
		await reopened.retire();
		const answer = await renewed.team.send("main", name, "release/2.0");
		assert.equal(answer.ok && answer.delivered, "inbox", "the answer waits for the user to resume it");
		assert.equal(renewed.team.get(name)?.state, "interrupted");
		await renewed.close();
	} finally { h.cleanup(); }
});

test("a main directory whose name has a tab still leaves a readable index", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-extras-index-")));
	try {
		const mainCwd = join(base, "client\tnotes");
		mkdirSync(mainCwd);
		const team = new Team({ cwd: mainCwd, maxConcurrent: 0, maxDepth: 1, replyTimeoutMs: 1000, deliverToMain: () => undefined,
			launcher: { launch: async () => { throw new Error("unused"); } } });
		assert.ok(team.spawn({ task: "Look", parent: "main", model: "m", readOnly: false, fork: false, blocking: false }).ok);
		const dir = join(base, "sessions");
		new ChildIndex(dir, "s1", mainCwd).save(team.list());
		const warnings: string[] = [];
		const loaded = new ChildIndex(dir, "s1", mainCwd).load((message) => warnings.push(message));
		assert.deepEqual(loaded.map((record) => record.name), ["look"]);
		assert.equal(loaded[0]!.checkout, undefined, "a checkout with a control character is looked up again, not trusted");
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("an index saved with a checkout that has a control character loads, and the checkout is looked up again", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-extras-index-")));
	try {
		writeFileSync(join(base, "index.json"), JSON.stringify({ version: 1, parentSession: "s1", cwd: base,
			records: [savedRecord({ name: "ok", checkout: "/tmp/client\tnotes" })] }));
		const loaded = new ChildIndex(base, "s1", base).load(() => undefined);
		assert.deepEqual(loaded.map((record) => record.name), ["ok"]);
		assert.equal(loaded[0]!.checkout, undefined);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("a worktree spawn from a directory with a control character is refused before git runs", () => {
	const team = new Team({ cwd: "/tmp/client\tnotes", maxConcurrent: 0, maxDepth: 1, replyTimeoutMs: 1000, deliverToMain: () => undefined,
		launcher: { launch: async () => { throw new Error("unused"); } } });
	const spawned = team.spawn({ task: "Look", parent: "main", model: "m", readOnly: false, fork: false, blocking: false, isolation: "worktree" });
	assert.equal(spawned.ok, false);
	assert.match(!spawned.ok ? spawned.error : "", /control character/);
});

test("a restored run that was stopped or failed before its first reply keeps no older run's report", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "Task" } },
		{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "RUN 1 REPORT: all tests pass." }] } },
		{ type: "message", message: { role: "user", content: "Message from main:\nNow fix the lint errors." } },
	];
	for (const state of ["stopped", "failed"] as const) {
		const restored = restoreRecord(savedRecord({ name: "fixer", state, runs: 2, report: undefined }), entries, () => undefined);
		assert.equal(restored.report, undefined, state);
	}
	const idle = restoreRecord(savedRecord({ name: "fixer", state: "idle", runs: 1, report: undefined }), entries.slice(0, 2), () => undefined);
	assert.equal(idle.report, "RUN 1 REPORT: all tests pass.", "an index that lags the session still gets the last answer");
});

test("a restore keeps an unread message although an earlier run read the same text", () => {
	const note = "Message from main:\nPost a status update.";
	const session = [
		{ role: "user", content: "Task", timestamp: 1_000 },
		{ role: "user", content: note, timestamp: 1_100 },
		{ role: "assistant", content: [{ type: "text", text: "Status: halfway." }], timestamp: 1_200 },
		{ role: "user", content: "Message from main:\nKeep going.", timestamp: 2_000 },
	];
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 1000, deliverToMain: () => undefined,
		launcher: { launch: async () => { throw new Error("unused"); } }, messagesFor: () => session });
	// Run 2, which started at 2000, was steered the same request again and had not read it when Pi quit.
	team.restore([savedRecord({ name: "dev", state: "interrupted", startedAt: 2_000, unread: [note] }),
		savedRecord({ name: "read-it", state: "interrupted", startedAt: 1_000, unread: [note] })]);
	assert.deepEqual(team.get("dev")!.inbox, [note]);
	assert.equal(team.get("read-it")!.inbox, undefined, "a run that read it does not get it again");
});

test("a cwd that leads through a symlink to a directory with a control character is refused", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-extras-index-")));
	try {
		const real = join(base, "client\tnotes");
		mkdirSync(real);
		symlinkSync(real, join(base, "link"));
		const team = new Team({ cwd: base, maxConcurrent: 0, maxDepth: 1, replyTimeoutMs: 1000, deliverToMain: () => undefined,
			launcher: { launch: async () => { throw new Error("unused"); } } });
		const spawned = team.spawn({ task: "Look", parent: "main", model: "m", readOnly: false, fork: false, blocking: false, cwd: join(base, "link") });
		assert.equal(spawned.ok, false);
		assert.match(!spawned.ok ? spawned.error : "", /control characters/);
	} finally { rmSync(base, { recursive: true, force: true }); }
});
