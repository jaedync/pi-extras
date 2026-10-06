import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { EditLocks } from "../lib/subagents/edit-lock.ts";
import { Team } from "../lib/subagents/team.ts";
import { NO_USAGE, type AgentRecord, type SpawnRequest } from "../lib/subagents/types.ts";

const request = (patch: Partial<SpawnRequest> = {}): SpawnRequest => ({ name: "scout", task: "Write a file", parent: "main", model: "test/model", readOnly: false, fork: false, blocking: false, ...patch });
const record = (patch: Partial<AgentRecord> = {}): AgentRecord => ({ ...request(), name: "scout", depth: 1, state: "idle", activity: null, runs: 1, createdAt: 1, toolCalls: 0, usage: NO_USAGE, ...patch });
const worktree = (name: string) => ({ path: `/tmp/repo.worktrees/${name}`, branch: `subagent/${name}`, base: "a".repeat(40) });
const LOCKED = /^scout is editing files outside git until its run ends\. Do work that does not edit files, or tell main you need a cwd of your own\.$/;

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

test("two children that may edit start side by side; the lock waits for the first edit", async () => {
	const { team } = harness();
	assert.ok(team.spawn(request()).ok);
	assert.ok(team.spawn(request({ name: "other" })).ok, "no refusal at spawn any more");
	await tick();
	assert.equal(team.claimEdit("scout"), undefined, "the first edit takes the free lock");
	assert.equal(team.claimEdit("scout"), undefined, "its holder edits again");
	assert.match(team.claimEdit("other") ?? "", LOCKED);
	await team.close();
});

for (const state of ["queued", "starting", "running", "asking", "waiting"] as const) {
	test(`a ${state} holder keeps the lock`, async () => {
		const { team } = harness();
		team.restore([record({ state: "running" }), record({ name: "other", state: "running" })]);
		assert.equal(team.claimEdit("scout"), undefined);
		team.markRecovery("scout", { state });
		assert.match(team.claimEdit("other") ?? "", LOCKED);
		await team.close();
	});
}

for (const state of ["idle", "failed", "stopped", "interrupted"] as const) {
	test(`a holder that becomes ${state} frees the lock`, async () => {
		const { team } = harness();
		team.restore([record({ state: "running" }), record({ name: "other", state: "running" })]);
		assert.equal(team.claimEdit("scout"), undefined);
		team.markRecovery("scout", { state });
		assert.equal(team.claimEdit("other"), undefined);
		team.markRecovery("scout", { state: "running" });
		assert.match(team.claimEdit("scout") ?? "", /^other is editing files outside git/, "resuming does not take the lock back");
		await team.close();
	});
}

test("a finished run frees the lock for another child", async () => {
	const { team, finishes } = harness();
	assert.ok(team.spawn(request()).ok);
	assert.ok(team.spawn(request({ name: "other" })).ok);
	await tick();
	assert.equal(team.claimEdit("scout"), undefined);
	finishes.get("scout")!();
	await team.whenDone("scout");
	assert.equal(team.claimEdit("other"), undefined);
	await team.close();
});

test("a holder's own helpers edit beside it; its siblings' helpers do not", async () => {
	const { team } = harness();
	team.restore([
		record({ state: "running" }),
		record({ name: "helper", parent: "scout", depth: 2, state: "running" }),
		record({ name: "nested", parent: "helper", depth: 3, state: "running" }),
		record({ name: "other", state: "running" }),
		record({ name: "cousin", parent: "other", depth: 2, state: "running" }),
	]);
	assert.equal(team.claimEdit("scout"), undefined);
	assert.equal(team.claimEdit("helper"), undefined);
	assert.equal(team.claimEdit("nested"), undefined);
	assert.match(team.claimEdit("cousin") ?? "", /^scout is editing files outside git .* tell other you need a cwd of your own/);
	await team.close();
});

test("an ancestor that edits after its helper takes the lock, so the helper ending does not free it", async () => {
	const { team } = harness();
	team.restore([
		record({ state: "running" }),
		record({ name: "helper", parent: "scout", depth: 2, state: "running" }),
		record({ name: "other", state: "running" }),
	]);
	assert.equal(team.claimEdit("helper"), undefined);
	assert.equal(team.claimEdit("scout"), undefined);
	team.markRecovery("helper", { state: "idle" });
	assert.match(team.claimEdit("other") ?? "", LOCKED);
	await team.close();
});

test("each worktree has its own lock, shared by the helpers that inherit it", async () => {
	const { team } = harness();
	team.restore([
		record({ state: "running" }),
		record({ name: "isolated", state: "running", worktree: worktree("isolated") }),
		record({ name: "first", parent: "isolated", depth: 2, state: "running", worktree: worktree("isolated") }),
		record({ name: "second", parent: "isolated", depth: 2, state: "running", worktree: worktree("isolated") }),
		record({ name: "apart", state: "running", worktree: worktree("apart") }),
	]);
	assert.equal(team.claimEdit("scout"), undefined);
	assert.equal(team.claimEdit("first"), undefined, "the shared checkout's holder does not lock a worktree");
	assert.match(team.claimEdit("second") ?? "", /^first is editing files in the worktree \/tmp\/repo\.worktrees\/isolated until its run ends\. .* tell isolated you need a worktree/);
	assert.equal(team.claimEdit("apart"), undefined);
	await team.close();
});

test("an agent the team does not know cannot take a lock", async () => {
	const { team } = harness();
	assert.match(team.claimEdit("ghost") ?? "", /No agent named ghost/);
	await team.close();
});

for (const held of [true, false]) {
	test(`a ${held ? "held" : "released"} idle child resumes beside another live child`, async () => {
		const { team, finishes } = harness();
		if (held) {
			assert.ok(team.spawn(request()).ok);
			await tick();
			finishes.get("scout")!();
			await team.whenDone("scout");
		} else team.restore([record()]);
		assert.ok(team.spawn(request({ name: "other" })).ok);
		const resumed = await team.send("main", "scout", "Continue", { expectReply: true });
		assert.ok(resumed.ok, !resumed.ok ? resumed.error : "");
		await team.close();
	});
}

for (const state of ["failed", "stopped", "interrupted"] as const) {
	test(`a ${state} child resumes beside a live child`, async () => {
		const { team } = harness();
		team.restore([record({ state })]);
		assert.ok(team.spawn(request({ name: "other" })).ok);
		assert.ok((await team.send("main", "scout", "Continue")).ok);
		await team.close();
	});
}

test("a lock whose holder is gone or no longer working never blocks an edit", () => {
	const records = new Map<string, AgentRecord>();
	const add = (name: string, state: AgentRecord["state"]) => records.set(name, { name, parent: "main", state } as AgentRecord);
	const locks = new EditLocks({ get: (name) => records.get(name), under: () => false });
	add("first", "running");
	add("second", "running");
	assert.equal(locks.claim("first"), undefined);
	assert.match(locks.claim("second") ?? "", /first is editing files outside git/);
	// The holder ends without its change reaching follow(), or its record is dropped.
	add("first", "idle");
	assert.equal(locks.claim("second"), undefined, "an ended holder lets go");
	records.delete("second");
	add("third", "running");
	assert.equal(locks.claim("third"), undefined, "a vanished holder lets go");
});
