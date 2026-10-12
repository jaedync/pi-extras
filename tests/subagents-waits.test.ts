/**
 * No agent waits forever: a waiting parent wakes when its last subagent ends,
 * an asker waits only on agents that can still answer, and a question that
 * would close a loop of waiting agents is refused.
 */
import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { type AgentRecord, NO_USAGE } from "../lib/subagents/types.ts";
import { teamHarness } from "./support/team-harness.ts";

const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await tick(); };

const saved = (over: Partial<AgentRecord>): AgentRecord => ({ name: "expert", parent: "main", depth: 1, task: "Know things", model: "m", readOnly: false, fork: false,
	blocking: false, state: "idle", createdAt: 1, activity: null, toolCalls: 0, usage: { ...NO_USAGE }, runs: 1, restored: true, ...over });

test("a parent waiting on its subagent wakes when that subagent's peer-started run ends quietly", async () => {
	const h = teamHarness();
	h.spawn("x", { name: "x" });
	h.spawn("z", { name: "z" });
	await flush();
	h.spawn("y", { name: "y", parent: "x" }); await flush();
	h.lastCall("y").finish("y done"); await flush();
	h.lastCall("x").finish("x done"); await flush();
	await h.team.send("main", "x", "Also check the docs."); await flush();
	// A peer's question starts a run of y that no one above it asked for.
	await h.team.send("z", "y", "Which API version do you use?", { expectReply: true }); await flush();
	h.lastCall("x").finish("x waits on y"); await flush();
	assert.equal(h.team.get("x")!.state, "waiting");
	h.lastCall("y").finish("v2"); await flush();
	assert.equal(h.team.get("x")!.state, "running", "x has no live subagent left, so its run goes on");
	assert.match(h.lastCall("x").text, /v2/);
});

const expertWontLaunch = () => teamHarness({ refuse: (record) => record.name === "expert" ? new Error("The saved child session is missing: /x.jsonl.") : undefined });

test("an asker whose peer can't resume to answer hears so, and its run does not wait on it", async () => {
	const h = expertWontLaunch();
	h.team.restore([saved({})]);
	h.spawn("Work", { name: "worker" }); await flush();
	assert.equal((await h.team.send("worker", "expert", "Which API should I use?", { expectReply: true })).ok, true);
	await flush();
	assert.equal(h.team.get("expert")!.state, "interrupted");
	assert.equal(h.team.get("worker")!.owed, undefined, "the answer can't come");
	assert.match((h.steered.get("worker") ?? []).join("\n"), /expert ended without answering you/);
	h.lastCall("worker").finish("Done without the answer."); await flush();
	assert.equal(h.team.get("worker")!.state, "idle");
	assert.equal(h.team.quiet(), true);
});

test("a parent whose subagent can't resume to answer gets the failure once, and its next run ends", async () => {
	const h = expertWontLaunch();
	h.spawn("Lead", { name: "lead" }); await flush();
	h.team.restore([saved({ parent: "lead", depth: 2 })]);
	assert.equal((await h.team.send("lead", "expert", "Status?", { expectReply: true })).ok, true);
	await flush();
	assert.match((h.steered.get("lead") ?? []).join("\n"), /could not resume/);
	h.lastCall("lead").finish("Read the failure; nothing else to do."); await flush();
	assert.equal(h.team.get("lead")!.state, "idle");
});

test("after a restart, a resumed asker does not wait on a peer that is still paused", async () => {
	const h = teamHarness();
	h.team.restore([saved({ name: "worker", state: "interrupted", owed: ["expert"], interruptionId: "i", interruptedBy: "quit" }),
		saved({ state: "interrupted", interruptionId: "j", interruptedBy: "quit" })]);
	await h.team.send("user", "worker", "Continue your task and report the outcome."); await flush();
	h.lastCall("worker").finish("All done except the API question."); await flush();
	assert.equal(h.team.get("worker")!.state, "idle");
	assert.deepEqual(h.main.flatMap((delivery) => delivery.kind === "report" ? [delivery.record.name] : []), ["worker"]);
});

test("a question back to a peer that waits for the asker's answer is refused", async () => {
	const h = teamHarness();
	h.spawn("A", { name: "a" });
	h.spawn("B", { name: "b" });
	await flush();
	assert.equal((await h.team.send("a", "b", "What schema do you use?", { expectReply: true })).ok, true);
	const back = await h.team.send("b", "a", "Which file are you editing?", { expectReply: true });
	assert.equal(back.ok, false);
	assert.match(!back.ok ? back.error : "", /a waits for you.*Send a note instead/s);
	assert.equal((await h.team.send("b", "a", "I edit schema.ts.")).ok, true, "a note still goes");
});

test("a question to a grandparent, which waits on the asker through its subagents, is refused", async () => {
	const h = teamHarness({ maxDepth: 3 });
	h.spawn("Lead", { name: "lead" }); await flush();
	h.spawn("Mid", { name: "mid", parent: "lead" }); await flush();
	h.spawn("Leaf", { name: "leaf", parent: "mid" }); await flush();
	const asked = await h.team.send("leaf", "lead", "Is the API frozen?", { expectReply: true });
	assert.equal(asked.ok, false);
	assert.match(!asked.ok ? asked.error : "", /lead waits for you/);
});

test("a question to an agent that does not wait for the asker still goes", async () => {
	const h = teamHarness({ maxDepth: 3 });
	h.spawn("Lead", { name: "lead" }); await flush();
	h.spawn("Mid", { name: "mid", parent: "lead" }); await flush();
	h.spawn("Peer", { name: "peer" }); await flush();
	assert.equal((await h.team.send("lead", "mid", "Status?", { expectReply: true })).ok, true, "a parent may ask its subagent");
	assert.equal((await h.team.send("mid", "peer", "Which port?", { expectReply: true })).ok, true);
});

test("a parent woken from waiting goes on with the same run and the budget it has left", async (t: TestContext) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	const pass = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
	const h = teamHarness();
	// 0.001 minutes = 60 ms of work.
	h.spawn("Coordinate", { name: "lead", maxMinutes: 0.001 }); await flush();
	for (let i = 1; i <= 3; i++) {
		h.spawn("Help", { name: `helper-${i}`, parent: "lead" }); await flush();
		await pass(15);
		h.lastCall("lead").finish("waiting"); await flush();
		assert.equal(h.team.get("lead")!.state, "waiting");
		await pass(1000);
		assert.equal(h.team.get("lead")!.state, "waiting", "time spent waiting does not count");
		h.lastCall(`helper-${i}`).finish(`helper-${i} done`); await flush();
	}
	assert.equal(h.team.get("lead")!.state, "running");
	await pass(14);
	assert.equal(h.team.get("lead")!.state, "running");
	await pass(1);
	const lead = h.team.get("lead")!;
	assert.equal(lead.runs, 1, "one run, woken three times");
	assert.equal(lead.state, "stopped", "45 ms before the wakes and 15 after: its 60 ms are used");
	assert.match(lead.stopReason ?? "", /budget/);
});
