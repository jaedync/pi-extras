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
