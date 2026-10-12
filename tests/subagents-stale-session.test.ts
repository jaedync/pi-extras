import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import type { AgentRecord, ChildHandle, ChildHooks, MainDelivery, SpawnRequest } from "../lib/subagents/types.ts";

interface Call { text: string; finish(result: string): void }

/**
 * A launcher whose sessions go stale when the test says so, as a /reload or an
 * edited settings.json makes them; it counts launches and disposals.
 */
function harness() {
	const calls = new Map<string, Call[]>();
	const launches = new Map<string, number>();
	const disposed: string[] = [];
	const main: MainDelivery[] = [];
	let generation = 1;
	const team = new Team({
		maxConcurrent: 4, maxDepth: 2, replyTimeoutMs: 60_000,
		deliverToMain: (delivery) => main.push(delivery),
		launcher: {
			async launch(record: AgentRecord, _hooks: ChildHooks): Promise<ChildHandle> {
				launches.set(record.name, (launches.get(record.name) ?? 0) + 1);
				const transcript: unknown[] = [];
				return {
					sessionFile: `/sessions/${record.name}.jsonl`,
					stamp: { generation, files: [] },
					prompt: (text) => new Promise<void>((resolve) => {
						transcript.push({ role: "user", content: [{ type: "text", text }] });
						calls.set(record.name, [...(calls.get(record.name) ?? []), {
							text, finish: (result) => { transcript.push({ role: "assistant", content: [{ type: "text", text: result }] }); resolve(); },
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
			current: (handle) => handle.stamp?.generation === generation,
		},
	});
	const spawn = (task: string, extra: Partial<SpawnRequest> = {}) => {
		const result = team.spawn({ task, parent: "main", model: "openai-codex/gpt-6-luna", readOnly: false, fork: false, blocking: false, ...extra });
		assert.ok(result.ok, !result.ok ? result.error : "");
		return result.record.name;
	};
	const lastCall = (name: string) => calls.get(name)!.at(-1)!;
	return { team, calls, launches, disposed, main, spawn, lastCall, reload: () => { generation++; } };
}

test("a message to a finished child whose session is stale relaunches it from its file, counted as its next run", async () => {
	const h = harness();
	const name = h.spawn("Look once");
	await tick();
	h.lastCall(name).finish("First report.");
	await h.team.whenDone(name);
	assert.deepEqual(h.disposed, [], "a current session is kept for a follow-up");
	h.reload();
	const sent = await h.team.send("main", name, "One more thing.");
	assert.ok(sent.ok && sent.delivered === "resumed");
	await tick(); await tick();
	assert.deepEqual(h.disposed, [name], "the stale session is let go first");
	assert.equal(h.launches.get(name), 2, "relaunched with what a launch reads now");
	assert.match(h.lastCall(name).text, /One more thing\./);
	assert.equal(h.team.get(name)?.runs, 2);
	assert.equal(h.team.get(name)?.sessionFile, `/sessions/${name}.jsonl`, "the same transcript goes on");
	h.lastCall(name).finish("Second report.");
	const done = await h.team.whenDone(name);
	assert.equal(done.report, "Second report.");
	assert.deepEqual(h.main.map((delivery) => delivery.kind), ["report", "report"]);
});

test("a message to a finished child whose session is current reuses it", async () => {
	const h = harness();
	const name = h.spawn("Look once");
	await tick();
	h.lastCall(name).finish("First report.");
	await h.team.whenDone(name);
	await h.team.send("main", name, "Follow up.");
	await tick();
	assert.equal(h.launches.get(name), 1);
	assert.deepEqual(h.disposed, []);
});

test("a running child keeps its stale session until its run ends, then lets it go at once", async () => {
	const h = harness();
	const name = h.spawn("Work a while");
	await tick();
	h.reload();
	await h.team.send("main", name, "Also check the tests.");
	assert.deepEqual(h.disposed, [], "steered into the session it runs on");
	assert.equal(h.launches.get(name), 1);
	h.lastCall(name).finish("Done.");
	await h.team.whenDone(name);
	await tick();
	assert.deepEqual(h.disposed, [name], "released at its natural pause instead of after the quiet spell");
	await h.team.send("main", name, "Again, please.");
	await tick(); await tick();
	assert.equal(h.launches.get(name), 2, "its next run starts on what a launch reads now");
});

test("a child waiting on its own subagents relaunches when their report arrives on a stale session", async () => {
	const h = harness();
	const parent = h.spawn("Lead the work");
	await tick();
	const helper = h.team.spawn({ task: "Help", parent, model: "openai-codex/gpt-6-luna", readOnly: false, fork: false, blocking: false });
	assert.ok(helper.ok);
	await tick();
	h.lastCall(parent).finish("Waiting for my helper.");
	await tick();
	assert.equal(h.team.get(parent)?.state, "waiting");
	h.reload();
	h.lastCall(helper.record.name).finish("Helped.");
	await tick(); await tick(); await tick();
	assert.ok(h.disposed.includes(parent), "the stale session is let go");
	assert.equal(h.launches.get(parent), 2);
	assert.match(h.lastCall(parent).text, /Helped\./, "the helper's report starts its next run");
});
