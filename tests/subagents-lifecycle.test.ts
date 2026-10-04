import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import type { AgentRecord, ChildHandle, ChildHooks, MainDelivery, SpawnRequest } from "../lib/subagents/types.ts";

interface Call { text: string; finish(result: string): void; fail(error: Error): void }

/** A launcher whose children finish only when the test says so, counting launches and disposals. */
function harness(options: { idleReleaseMs?: number; maxDepth?: number } = {}) {
	const calls = new Map<string, Call[]>();
	const launches = new Map<string, number>();
	const disposed: string[] = [];
	const main: MainDelivery[] = [];
	const team = new Team({
		maxConcurrent: 4,
		maxDepth: options.maxDepth ?? 2,
		replyTimeoutMs: 60_000,
		...(options.idleReleaseMs !== undefined ? { idleReleaseMs: options.idleReleaseMs } : {}),
		deliverToMain: (delivery) => main.push(delivery),
		launcher: {
			async launch(record: AgentRecord, _hooks: ChildHooks): Promise<ChildHandle> {
				launches.set(record.name, (launches.get(record.name) ?? 0) + 1);
				const transcript: unknown[] = [];
				return {
					sessionFile: `/sessions/${record.name}.jsonl`,
					prompt: (text) => new Promise<void>((resolve, reject) => {
						calls.set(record.name, [...(calls.get(record.name) ?? []), {
							text,
							finish: (result) => { transcript.push({ role: "assistant", content: [{ type: "text", text: result }] }); resolve(); },
							fail: reject,
						}]);
					}),
					steer: () => undefined,
					abort: async () => undefined,
					lastText: () => undefined,
					messages: () => transcript,
					takeQueued: () => [],
					dispose: async () => { disposed.push(record.name); },
				};
			},
		},
	});
	const spawn = (task: string, extra: Partial<SpawnRequest> = {}) => {
		const result = team.spawn({ task, parent: "main", model: "openai-codex/gpt-6-luna", readOnly: false, fork: false, blocking: false, ...extra });
		assert.ok(result.ok, !result.ok ? result.error : "");
		return result.record.name;
	};
	const lastCall = (name: string) => calls.get(name)!.at(-1)!;
	return { team, calls, launches, disposed, main, spawn, lastCall };
}

test("its parent stopping a child gets the stopped record back, and no report follows", async () => {
	const h = harness();
	const name = h.spawn("Survey everything");
	await tick();
	h.lastCall(name); // running
	const stopped = await h.team.stop(name, { by: "main" });
	assert.equal(stopped?.state, "stopped");
	assert.deepEqual(h.main, [], "main asked for it, so no stopped report wakes or reaches it");
});

test("the user stopping a child still reports it to main", async () => {
	const h = harness();
	const name = h.spawn("Survey everything");
	await tick();
	await h.team.stop(name);
	assert.deepEqual(h.main.map((d) => d.kind), ["report"]);
});

test("stopping a child that has already ended does nothing", async () => {
	const h = harness();
	const name = h.spawn("Quick look");
	await tick();
	h.lastCall(name).finish("Done.");
	await h.team.whenDone(name);
	assert.equal(await h.team.stop(name, { by: "main" }), undefined);
	assert.equal(h.team.get(name)?.state, "idle");
});

test("a stopped or failed child's session is released at once", async () => {
	const h = harness();
	const stopped = h.spawn("Stop me");
	const failed = h.spawn("Fail me");
	await tick();
	await h.team.stop(stopped, { by: "main" });
	h.lastCall(failed).fail(new Error("boom"));
	await h.team.whenDone(failed);
	await tick();
	assert.deepEqual(h.disposed.sort(), [failed, stopped].sort());
});

test("a finished child's session is released after a quiet spell, and a message relaunches it from its file", async () => {
	const h = harness({ idleReleaseMs: 20 });
	const name = h.spawn("Look once");
	await tick();
	h.lastCall(name).finish("First report.");
	await h.team.whenDone(name);
	assert.deepEqual(h.disposed, [], "not released at once: a follow-up often comes quickly");
	await sleep(40);
	assert.deepEqual(h.disposed, [name]);
	const sent = await h.team.send("main", name, "One more thing.");
	assert.ok(sent.ok && sent.delivered === "resumed");
	await tick(); await tick();
	assert.equal(h.launches.get(name), 2, "relaunched from its session file");
	assert.match(h.lastCall(name).text, /One more thing\./);
});

test("a message before the quiet spell ends keeps the session and cancels the release", async () => {
	const h = harness({ idleReleaseMs: 30 });
	const name = h.spawn("Look once");
	await tick();
	h.lastCall(name).finish("First report.");
	await h.team.whenDone(name);
	await h.team.send("main", name, "Follow up.");
	await sleep(50);
	assert.deepEqual(h.disposed, [], "still running, so still held");
	assert.equal(h.launches.get(name), 1);
});

test("a question to a peer returns at once, and the peer's answer wakes the asker", async () => {
	const h = harness();
	const asker = h.spawn("Asker", { name: "asker" });
	const target = h.spawn("Target", { name: "target" });
	await tick();
	const asked = await h.team.send(asker, target, "Which file?", { expectReply: true });
	assert.deepEqual(asked, { ok: true, delivered: "steered" }, "no reply in the result: it never waited");
	assert.equal(h.team.get(asker)?.state, "running");
	h.lastCall(asker).finish("Asked target; nothing else to do.");
	await tick();
	assert.equal(h.team.get(asker)?.state, "waiting", "it owes no report until its question is answered");
	assert.match(h.team.get(asker)?.activity ?? "", /waiting for target to answer/);
	assert.equal(h.main.filter((delivery) => delivery.kind === "report").length, 0);
	await h.team.send(target, asker, "lib/x.ts");
	await tick();
	assert.equal(h.team.get(asker)?.state, "running", "the answer resumes it");
	assert.match(h.lastCall(asker).text, /Message from target:\nlib\/x\.ts/);
	h.lastCall(asker).finish("The file is lib/x.ts.");
	await tick();
	assert.equal(h.team.get(asker)?.state, "idle");
	await h.team.close();
});

test("a peer that ends without answering hands the asker how its run ended", async () => {
	const h = harness();
	const asker = h.spawn("Asker", { name: "asker" });
	const target = h.spawn("Target", { name: "target" });
	await tick();
	await h.team.send(asker, target, "Which file?", { expectReply: true });
	h.lastCall(asker).finish("Waiting on target.");
	await tick();
	h.lastCall(target).finish("Never saw the question.");
	await tick();
	assert.equal(h.team.get(asker)?.state, "running");
	assert.match(h.lastCall(asker).text, /target ended without answering you[\s\S]*Never saw the question\./);
	await h.team.close();
});

test("a parent's question to its own subagent doesn't block it either", async () => {
	const h = harness();
	const lead = h.spawn("Lead", { name: "lead" });
	await tick();
	const helper = h.spawn("Helper", { name: "helper", parent: lead });
	await tick();
	assert.deepEqual(await h.team.send(lead, helper, "Done yet?", { expectReply: true }), { ok: true, delivered: "steered" });
	h.lastCall(lead).finish("Asked helper.");
	await tick();
	assert.equal(h.team.get(lead)?.state, "waiting");
	h.lastCall(helper).finish("helper: 3 files");
	await tick();
	assert.match(h.lastCall(lead).text, /helper: 3 files/, "its report is the answer");
	await h.team.close();
});

test("a question up the tree still waits for the answer", async () => {
	const h = harness();
	const lead = h.spawn("Lead", { name: "lead" });
	await tick();
	const helper = h.spawn("Helper", { name: "helper", parent: lead });
	await tick();
	const asked = h.team.send(helper, lead, "npm or pnpm?", { expectReply: true });
	await tick();
	assert.equal(h.team.get(helper)?.state, "asking");
	await h.team.send(lead, helper, "npm");
	assert.deepEqual(await asked, { ok: true, delivered: "replied", reply: "npm" });
	await h.team.close();
});

test("a failed child resumes from its session when its parent messages it, told how the last run ended", async () => {
	const h = harness();
	const name = h.spawn("Fragile work");
	await tick();
	h.lastCall(name).fail(new Error("provider overloaded"));
	await h.team.whenDone(name);
	const sent = await h.team.send("main", name, "Try again, please.");
	assert.ok(sent.ok && sent.delivered === "resumed");
	await tick(); await tick();
	assert.equal(h.launches.get(name), 2, "relaunched from its session file");
	assert.match(h.lastCall(name).text, /Your previous run failed: provider overloaded\./);
	assert.match(h.lastCall(name).text, /Try again, please\./);
	assert.equal(h.team.get(name)?.error, undefined, "the old error is cleared for the new run");
	h.lastCall(name).finish("Worked this time.");
	assert.equal((await h.team.whenDone(name)).state, "idle");
});

test("a child its parent stopped resumes when the parent messages it again", async () => {
	const h = harness();
	const name = h.spawn("Long survey");
	await tick();
	await h.team.stop(name, { by: "main" });
	const sent = await h.team.send("main", name, "Only do the lib folder.");
	assert.ok(sent.ok && sent.delivered === "resumed");
	await tick(); await tick();
	assert.match(h.lastCall(name).text, /Your previous run was stopped\./);
	await h.team.close();
});

test("a sibling's note can't resume a failed child; it says who can", async () => {
	const h = harness();
	const failed = h.spawn("Fails", { name: "fails" });
	const peer = h.spawn("Peer", { name: "peer" });
	await tick();
	h.lastCall(failed).fail(new Error("boom"));
	await h.team.whenDone(failed);
	const note = await h.team.send(peer, failed, "FYI");
	assert.equal(note.ok, false);
	assert.match(!note.ok ? note.error : "", /fails has failed; only main or the user can resume it/);
	await h.team.close();
});
