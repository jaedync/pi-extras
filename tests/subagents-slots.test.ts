/**
 * maxConcurrent holds for every way a child goes on: a held session that a
 * message resumes, a parent woken from waiting, and an asker that got its
 * answer all wait in line for a free slot. A child started with wait: true
 * runs in the slot of the parent it blocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { subagentTool } from "../lib/subagents/tools.ts";
import { ACTIVE_STATES, LIVE_STATES } from "../lib/subagents/types.ts";
import { teamHarness } from "./support/team-harness.ts";

const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await tick(); };

const activeNames = (h: ReturnType<typeof teamHarness>) => h.team.list().filter((record) => ACTIVE_STATES.has(record.state)).map((record) => record.name);

test("children that wait on their own subagents (wait: true) lend them their slots", async () => {
	const h = teamHarness({ maxConcurrent: 2 });
	h.spawn("Lead A", { name: "lead-a" });
	h.spawn("Lead B", { name: "lead-b" });
	h.spawn("Other", { name: "other" });
	await flush();
	const context = { team: h.team, allowed: [{ ref: "m", short: "m" }], fallbackModel: "m", thinking: {}, modelTable: "", guide: "", replyTimeoutMs: 60_000, now: Date.now };
	const waits = ["lead-a", "lead-b"].map((lead) => (subagentTool(context as never, lead).execute as any)("id", { task: `Quick check for ${lead}`, name: `check-${lead}`, wait: true }, undefined, undefined, undefined));
	await flush();
	assert.equal(h.team.get("check-lead-a")!.state, "running");
	assert.equal(h.team.get("check-lead-b")!.state, "running");
	assert.equal(h.team.get("other")!.state, "queued", "a blocked parent's slot is its subagent's, not the next in line's");
	h.lastCall("check-lead-a").finish("A is fine");
	h.lastCall("check-lead-b").finish("B is fine");
	const results = await Promise.all(waits);
	assert.match(results[0].content[0].text, /A is fine/);
	await flush();
	assert.equal(h.team.get("other")!.state, "queued", "the leads have their slots back");
});

test("a message to an idle child with a held session waits for a free slot", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.spawn("A", { name: "a" }); await flush();
	h.lastCall("a").finish("a done"); await flush();
	h.spawn("B", { name: "b" }); await flush();
	const sent = await h.team.send("main", "a", "One more thing: check the tests too."); await flush();
	assert.equal(sent.ok, true);
	assert.deepEqual(activeNames(h), ["b"]);
	assert.equal(h.team.get("a")!.state, "queued");
	h.lastCall("b").finish("b done"); await flush();
	assert.deepEqual(activeNames(h), ["a"]);
	assert.match(h.lastCall("a").text, /check the tests too/);
	assert.equal(h.team.get("a")!.runs, 2);
});

test("a parent woken from waiting goes on only when a slot is free, ahead of what has not started, as the same run", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.spawn("Lead", { name: "lead" }); await flush();
	h.spawn("Helper", { name: "helper", parent: "lead" });
	h.lastCall("lead").finish("waiting on helper"); await flush();
	assert.equal(h.team.get("lead")!.state, "waiting");
	h.spawn("Other", { name: "other" }); await flush();
	assert.deepEqual(activeNames(h), ["helper"]);
	assert.equal((await h.team.send("main", "lead", "Also note the release date.")).ok, true); await flush();
	assert.equal(h.team.get("lead")!.state, "queued");
	assert.deepEqual(activeNames(h), ["helper"]);
	h.lastCall("helper").finish("helper done"); await flush();
	assert.deepEqual(activeNames(h), ["lead"], "work under way goes ahead of a spawn that has not started");
	assert.match(h.lastCall("lead").text, /release date[\s\S]*helper done/);
	assert.equal(h.team.get("lead")!.runs, 1);
	assert.equal(h.team.get("other")!.state, "queued");
});

test("an asker that gets its answer goes on only when a slot is free", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.spawn("A", { name: "a" });
	h.spawn("B", { name: "b" });
	await flush();
	let answered = false;
	const asking = h.team.send("a", "main", "Which branch?", { expectReply: true }).then((result) => { answered = true; return result; });
	await flush();
	assert.deepEqual(activeNames(h), ["b"], "the asker freed its slot");
	await h.team.send("main", "a", "Use develop."); await flush();
	assert.equal(answered, false, "the answer waits for a slot");
	assert.equal(h.team.get("a")!.state, "queued");
	assert.deepEqual(activeNames(h), ["b"]);
	h.lastCall("b").finish("b done"); await flush();
	const result = await asking;
	assert.equal(result.ok && result.reply, "Use develop.");
	assert.deepEqual(activeNames(h), ["a"]);
});

test("a stop of an agent that waits for a slot keeps its message and ends its wait", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.spawn("A", { name: "a" }); await flush();
	h.lastCall("a").finish("a done"); await flush();
	h.spawn("B", { name: "b" }); await flush();
	await h.team.send("main", "a", "Check the tests too."); await flush();
	await h.team.stop("a");
	assert.equal(h.team.get("a")!.state, "stopped");
	assert.match((h.team.get("a")!.inbox ?? []).join("\n"), /Check the tests too/);
	h.lastCall("b").finish("b done"); await flush();
	assert.deepEqual(activeNames(h), []);
});

/** Slots in use: a parent blocked on its wait: true subagent shares that subagent's. */
const slotsUsed = (h: ReturnType<typeof teamHarness>) => {
	const records = h.team.list();
	const blocked = new Set(records.filter((record) => record.blocking && LIVE_STATES.has(record.state)).map((record) => record.parent));
	return records.filter((record) => ACTIVE_STATES.has(record.state) && !blocked.has(record.name)).map((record) => record.name);
};

test("a parent whose wait: true child ended while another agent had their slot waits for a free one", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.spawn("Lead", { name: "lead" }); await flush();
	h.spawn("Other", { name: "other" }); await flush();
	const context = { team: h.team, allowed: [{ ref: "m", short: "m" }], fallbackModel: "m", thinking: {}, modelTable: "", guide: "", replyTimeoutMs: 60_000, now: Date.now };
	let returned = false;
	const waiting = (subagentTool(context as never, "lead").execute as any)("id", { task: "check", name: "check", wait: true }, undefined, undefined, undefined)
		.catch((error: Error) => error).finally(() => { returned = true; });
	await flush();
	assert.deepEqual(slotsUsed(h), ["check"]);
	void h.team.send("check", "main", "Which branch?", { expectReply: true }); await flush();
	assert.deepEqual(slotsUsed(h), ["other"], "the asker freed the slot it shared with lead");
	await h.team.stop("check"); await flush();
	assert.equal(returned, false, "lead's wait holds until a slot is free");
	assert.equal(h.team.get("lead")!.state, "queued");
	assert.deepEqual(slotsUsed(h), ["other"]);
	h.lastCall("other").finish("other done"); await flush();
	await waiting;
	assert.equal(returned, true);
	assert.deepEqual(slotsUsed(h), ["lead"]);
});

test("a child that rests in a bash sleep lends its slot, and waits in line for one after", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.spawn("A", { name: "a" });
	h.spawn("B", { name: "b" });
	await flush();
	h.hooks.get("a")!.update({ activity: "bash sleep 240; git status" });
	let rested = false;
	const resting = h.hooks.get("a")!.rest!(20).then(() => { rested = true; });
	await flush();
	assert.equal(h.team.get("b")!.state, "running", "the sleeper's slot went to the next in line");
	assert.equal(h.team.get("a")!.state, "running", "its bash call still runs");
	await new Promise((resolve) => setTimeout(resolve, 40)); await flush();
	assert.equal(rested, false, "b holds the slot, so a waits for it");
	assert.equal(h.team.get("a")!.state, "queued");
	h.lastCall("b").finish("b done"); await flush();
	await resting;
	assert.equal(h.team.get("a")!.state, "running");
	assert.equal(h.team.get("a")!.activity, "bash sleep 240; git status");
	assert.deepEqual(slotsUsed(h), ["a"]);
});

test("a rest that ends with a slot free goes on at once", async () => {
	const h = teamHarness({ maxConcurrent: 2 });
	h.spawn("A", { name: "a" }); await flush();
	await h.hooks.get("a")!.rest!(5);
	assert.equal(h.team.get("a")!.state, "running");
	assert.deepEqual(slotsUsed(h), ["a"]);
});

test("a stop of a child that waits for its slot back after a rest ends the wait", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.spawn("A", { name: "a" });
	h.spawn("B", { name: "b" });
	await flush();
	const resting = h.hooks.get("a")!.rest!(5);
	await new Promise((resolve) => setTimeout(resolve, 20)); await flush();
	assert.equal(h.team.get("a")!.state, "queued");
	await h.team.stop("a");
	assert.equal(await resting, false, "nothing more of the command runs");
	assert.equal(h.team.get("a")!.state, "stopped");
	assert.deepEqual(slotsUsed(h), ["b"]);
});

test("each agent in line for a slot says its place, and a resumed one does not keep its old activity", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.spawn("A", { name: "a" }); await flush();
	h.hooks.get("a")!.update({ activity: "bash git push" });
	h.lastCall("a").finish("a done"); await flush();
	h.spawn("B", { name: "b" });
	h.spawn("C", { name: "c" });
	await flush();
	assert.equal(h.team.get("c")!.activity, "next in line for a slot");
	await h.team.send("main", "a", "One more thing."); await flush();
	assert.equal(h.team.get("a")!.activity, "next in line for a slot", "work under way goes first");
	assert.equal(h.team.get("c")!.activity, "2nd in line for a slot");
});

test("a stop of a resting child with a live subagent ends the rest before the abort, with no slot", async () => {
	const h = teamHarness({ maxConcurrent: 2 });
	h.spawn("A", { name: "a" });
	h.spawn("B", { name: "b" });
	await flush();
	h.spawn("Helper", { name: "helper", parent: "a" });
	const resting = h.hooks.get("a")!.rest!(5);
	await new Promise((resolve) => setTimeout(resolve, 20)); await flush();
	assert.equal(h.team.get("a")!.state, "queued");
	let settled: boolean | undefined;
	void resting.then((held) => { settled = held; });
	const stopping = h.team.stop("a");
	await tick();
	assert.notEqual(settled, true, "the rest never says it holds a slot");
	await stopping;
	assert.equal(await resting, false);
});

test("an abort of the bash call while it waits in line after a rest ends the wait at once", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.spawn("A", { name: "a" });
	h.spawn("B", { name: "b" });
	await flush();
	h.hooks.get("a")!.update({ activity: "bash sleep 60; ls" });
	const controller = new AbortController();
	const resting = h.hooks.get("a")!.rest!(5, controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 20)); await flush();
	assert.equal(h.team.get("a")!.state, "queued");
	controller.abort();
	assert.equal(await resting, false);
	assert.equal(h.team.get("a")!.state, "running", "its run winds down as an aborted call leaves it");
	assert.equal(h.team.get("a")!.activity, "bash sleep 60; ls");
	assert.equal(h.team.get("b")!.state, "running");
});

test("mail to a child that waits in line after a rest is steered to it when it goes on", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.spawn("A", { name: "a" });
	h.spawn("B", { name: "b" });
	await flush();
	const resting = h.hooks.get("a")!.rest!(5);
	await new Promise((resolve) => setTimeout(resolve, 20)); await flush();
	assert.equal(h.team.get("a")!.state, "queued");
	assert.equal((await h.team.send("main", "a", "Also check the docs.")).ok, true);
	h.lastCall("b").finish("b done"); await flush();
	assert.equal(await resting, true);
	assert.match((h.steered.get("a") ?? []).join("\n"), /Also check the docs\./);
	assert.equal(h.team.get("a")!.inbox, undefined);
	assert.equal(h.lastCall("a").text, "A", "no new run: the same run reads it");
});

test("a resting child's row says its slot is lent, and the old activity comes back", async () => {
	const h = teamHarness({ maxConcurrent: 2 });
	h.spawn("A", { name: "a" }); await flush();
	h.hooks.get("a")!.update({ activity: "bash sleep 60; ls" });
	const resting = h.hooks.get("a")!.rest!(15);
	assert.equal(h.team.get("a")!.activity, "bash sleep 60; ls (slot lent)");
	assert.equal(await resting, true);
	assert.equal(h.team.get("a")!.activity, "bash sleep 60; ls");
});

test("an abort during a rest puts the old activity back", async () => {
	const h = teamHarness({ maxConcurrent: 2 });
	h.spawn("A", { name: "a" }); await flush();
	h.hooks.get("a")!.update({ activity: "bash sleep 240; gh run view" });
	const controller = new AbortController();
	const resting = h.hooks.get("a")!.rest!(60_000, controller.signal);
	assert.equal(h.team.get("a")!.activity, "bash sleep 240; gh run view (slot lent)");
	controller.abort();
	assert.equal(await resting, false);
	assert.equal(h.team.get("a")!.activity, "bash sleep 240; gh run view");
});
