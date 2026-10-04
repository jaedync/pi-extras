import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import { NO_USAGE, type AgentRecord, type SpawnRequest } from "../lib/subagents/types.ts";

const request = (patch: Partial<SpawnRequest> = {}): SpawnRequest => ({ name: "scout", task: "Write a file", parent: "main", model: "test/model", readOnly: false, fork: false, blocking: false, ...patch });
const record = (patch: Partial<AgentRecord> = {}): AgentRecord => ({ ...request(), name: "scout", depth: 1, state: "idle", activity: null, runs: 1, createdAt: 1, toolCalls: 0, usage: NO_USAGE, ...patch });

function harness(maxConcurrent = 4) {
	const finishes = new Map<string, () => void>();
	const team = new Team({ maxConcurrent, maxDepth: 4, replyTimeoutMs: 100,
		deliverToMain() {}, launcher: { async launch(r) { return {
			prompt: () => new Promise<void>((resolve) => finishes.set(r.name, resolve)),
			steer() {}, abort: async () => {}, dispose: async () => {}, messages: () => [], takeQueued: () => [], lastText: () => undefined,
		}; } },
	});
	return { team, finishes };
}

test("a second shared writer is refused even when the first is queued", async () => {
	const { team } = harness(0);
	assert.ok(team.spawn(request()).ok);
	const refused = team.spawn(request({ name: "other" }));
	assert.equal(refused.ok, false);
	assert.match(!refused.ok ? refused.error : "", /scout is already writing.*isolation: "worktree".*readOnly.*report/);
	assert.equal(team.get("other"), undefined);
	await team.close();
});

for (const state of ["queued", "starting", "running", "asking", "waiting"] as const) {
	test(`a ${state} writer owns the shared checkout`, async () => {
		const { team } = harness();
		team.restore([record({ state })]);
		assert.equal(team.spawn(request({ name: "other" })).ok, false);
		assert.ok(team.spawn(request({ name: "reader", readOnly: true })).ok);
		await team.close();
	});
}

test("a completed writer frees the checkout for another writer", async () => {
	const { team, finishes } = harness();
	assert.ok(team.spawn(request()).ok);
	await tick();
	finishes.get("scout")!();
	await team.whenDone("scout");
	assert.ok(team.spawn(request({ name: "other" })).ok);
	await team.close();
});

test("writing siblings are not ancestors or descendants", async () => {
	const { team } = harness();
	assert.ok(team.spawn(request()).ok);
	assert.ok(team.spawn(request({ name: "first", parent: "scout" })).ok);
	assert.equal(team.spawn(request({ name: "second", parent: "scout" })).ok, false);
	await team.close();
});

test("read-only and worktree records never count as shared writers", async () => {
	const { team } = harness();
	team.restore([record({ name: "isolated", state: "running", worktree: { path: "/tmp/isolated", branch: "subagent/isolated", base: "a".repeat(40) } })]);
	assert.ok(team.spawn(request()).ok);
	assert.ok(team.spawn(request({ name: "reader", readOnly: true })).ok);
	await team.close();
});

test("a writer can start descendants and resume an ancestor beside its live descendant", async () => {
	const { team } = harness();
	assert.ok(team.spawn(request()).ok);
	assert.ok(team.spawn(request({ name: "helper", parent: "scout" })).ok);
	assert.ok(team.spawn(request({ name: "nested", parent: "helper" })).ok);
	await tick();
	team.markRecovery("scout", { state: "idle" });
	assert.ok((await team.send("main", "scout", "Continue")).ok);
	assert.ok((await team.send("main", "scout", "Keep going")).ok);
	await team.close();
});

for (const held of [true, false]) {
	test(`a ${held ? "held" : "released"} idle writer cannot resume beside another writer`, async () => {
		const { team, finishes } = harness();
		if (held) {
			assert.ok(team.spawn(request()).ok);
			await tick();
			finishes.get("scout")!();
			await team.whenDone("scout");
		} else team.restore([record()]);
		assert.ok(team.spawn(request({ name: "other" })).ok);
		const before = team.get("scout");
		const refused = await team.send("main", "scout", "Continue", { expectReply: true });
		assert.equal(refused.ok, false);
		assert.match(!refused.ok ? refused.error : "", /other is already writing/);
		assert.equal(team.get("scout"), before, "a refused resume must not replace the record");
		await team.close();
	});
}

for (const state of ["failed", "stopped", "interrupted"] as const) {
	test(`a ${state} shared writer cannot resume beside a live writer`, async () => {
		const { team } = harness();
		team.restore([record({ state, answeredMain: true })]);
		assert.ok(team.spawn(request({ name: "other" })).ok);
		const before = team.get("scout");
		assert.equal((await team.send("main", "scout", "Continue")).ok, false);
		assert.equal(team.get("scout"), before);
		await team.close();
	});
}
