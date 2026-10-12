/**
 * No agent waits forever: a waiting parent wakes when its last subagent ends,
 * an asker waits only on agents that can still answer, and a question that
 * would close a loop of waiting agents is refused.
 */
import { test } from "node:test";
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
