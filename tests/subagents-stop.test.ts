import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import { stopOrder } from "../lib/subagents/after.ts";
import { stopTool } from "../lib/subagents/tools.ts";
import { teamHarness } from "./support/team-harness.ts";
import { type AgentRecord, type ChildHandle, type ChildHooks, type MainDelivery, NO_USAGE, type SpawnRequest } from "../lib/subagents/types.ts";

const flush = async (rounds = 4) => { for (let i = 0; i < rounds; i++) await tick(); };

test("a stop while the child starts, then a message: only the new launch runs, and the old session goes", async () => {
	const launches: Array<(handle: ChildHandle) => void> = [];
	const prompts: string[] = [];
	const disposed: number[] = [];
	const team = new Team({
		maxConcurrent: 4, maxDepth: 2, replyTimeoutMs: 60_000, deliverToMain: () => undefined,
		launcher: {
			launch: () => {
				const id = launches.length + 1;
				return new Promise((resolve) => launches.push(() => resolve({
					prompt: (text) => { prompts.push(`launch${id}: ${text}`); return new Promise(() => undefined); },
					steer: () => undefined, abort: async () => undefined, lastText: () => undefined,
					messages: () => [], takeQueued: () => [], dispose: async () => { disposed.push(id); },
				})));
			},
		},
	});
	const spawned = team.spawn({ task: "Task", parent: "main", model: "m", readOnly: false, fork: false, blocking: false });
	assert.ok(spawned.ok);
	const { name } = spawned.record;
	await tick();
	assert.equal(team.get(name)?.state, "starting");
	await team.stop(name, { by: "main" });
	assert.equal((await team.send("main", name, "Carry on with X.")).ok, true);
	launches[0]!(undefined as never);
	await flush();
	launches[1]!(undefined as never);
	await flush();
	assert.equal(prompts.length, 1);
	assert.match(prompts[0]!, /^launch2: /);
	assert.deepEqual(disposed, [1]);
	assert.equal(team.get(name)?.state, "running");
});

test("a message during a stop's abort relaunches the child, and the aborted run does not settle the new one", async () => {
	const main: MainDelivery[] = [];
	const prompts: string[] = [];
	let launches = 0;
	let endFirst: (() => void) | undefined;
	let endAbort: (() => void) | undefined;
	const team = new Team({
		maxConcurrent: 4, maxDepth: 2, replyTimeoutMs: 60_000, deliverToMain: (delivery) => main.push(delivery),
		launcher: {
			async launch(): Promise<ChildHandle> {
				const id = ++launches;
				const transcript: unknown[] = [];
				return {
					prompt: (text) => {
						prompts.push(`launch${id}: ${text}`);
						return new Promise<void>((resolve) => {
							if (id === 1) endFirst = () => { transcript.push({ role: "assistant", content: [{ type: "text", text: "partial" }] }); resolve(); };
						});
					},
					steer: () => undefined,
					// Pi's abort waits for the agent loop to wind down.
					abort: () => new Promise<void>((resolve) => { endAbort = () => { endFirst?.(); resolve(); }; }),
					lastText: () => undefined, messages: () => transcript, takeQueued: () => [], dispose: async () => undefined,
				};
			},
		},
	});
	const spawned = team.spawn({ task: "Task", parent: "main", model: "m", readOnly: false, fork: false, blocking: false });
	assert.ok(spawned.ok);
	const { name } = spawned.record;
	await flush();
	const stopping = team.stop(name, { by: "main" });
	await tick();
	assert.equal((await team.send("main", name, "Change of plan: do Y.")).ok, true);
	await flush();
	endAbort!();
	await stopping;
	await flush();
	assert.equal(team.get(name)!.state, "running");
	assert.equal(launches, 2);
	assert.equal(main.filter((delivery) => delivery.kind === "report").length, 0, "neither the stop nor the aborted run reports over the new run");
});

const restored = (over: Partial<AgentRecord>): AgentRecord => ({ name: "paused", parent: "main", depth: 1, task: "T", model: "m", readOnly: false, fork: false,
	blocking: false, state: "interrupted", createdAt: 1, activity: null, toolCalls: 0, usage: { ...NO_USAGE }, runs: 1, restored: true, ...over });

test("stopping an interrupted child keeps the report of its last run", async () => {
	const main: MainDelivery[] = [];
	const team = new Team({ maxConcurrent: 4, maxDepth: 2, replyTimeoutMs: 60_000, deliverToMain: (delivery) => main.push(delivery),
		launcher: { launch: async () => { throw new Error("no launch"); } } });
	team.restore([restored({ report: "Half-way: found the bug in parser.ts" })]);
	const stopped = await team.stop("paused");
	assert.equal(stopped?.report, "Half-way: found the bug in parser.ts");
	const report = main.find((delivery) => delivery.kind === "report");
	assert.equal(report?.kind === "report" ? report.record.report : undefined, "Half-way: found the bug in parser.ts");
});

/** Children whose abort takes a while, as a real session's does, and whose reports name what they said. */
function slowAbortTeam(abortMs = 60) {
	const main: MainDelivery[] = [];
	const finish = new Map<string, (text: string) => void>();
	const hooks = new Map<string, ChildHooks>();
	const team = new Team({ maxConcurrent: 8, maxDepth: 2, replyTimeoutMs: 60_000, deliverToMain: (delivery) => main.push(delivery), warn: () => undefined,
		launcher: { async launch(record: AgentRecord, childHooks: ChildHooks): Promise<ChildHandle> {
			hooks.set(record.name, childHooks);
			const transcript: unknown[] = [];
			return { prompt: (text) => new Promise<void>((resolve) => {
				transcript.push({ role: "user", content: text });
				finish.set(record.name, (said) => { transcript.push({ role: "assistant", content: [{ type: "text", text: said }] }); resolve(); });
			}),
			steer: () => undefined, abort: () => sleep(abortMs).then(() => finish.get(record.name)?.("aborted")),
			lastText: () => undefined, messages: () => transcript, takeQueued: () => [], dispose: async () => undefined };
		} } });
	const spawn = (name: string, parent: string, extra: Partial<SpawnRequest> = {}) =>
		team.spawn({ name, task: name, parent, model: "m", readOnly: false, fork: false, blocking: false, ...extra });
	const reports = () => main.flatMap((delivery) => delivery.kind === "report" ? [delivery.record.name] : []);
	return { team, main, finish, hooks, spawn, reports };
}

test("a parent that is stopping can't start a subagent that would outlive the stop", async () => {
	const h = slowAbortTeam();
	assert.ok(h.spawn("lead", "main").ok); await flush();
	assert.ok(h.spawn("old-helper", "lead").ok); await flush();
	const stopping = h.team.stop("lead");
	await sleep(10);
	const late = h.spawn("new-helper", "lead");
	assert.equal(late.ok, false);
	assert.match(!late.ok ? late.error : "", /lead is stopping/);
	await stopping;
	assert.equal(h.team.get("lead")!.state, "stopped");
	assert.equal(h.team.get("old-helper")!.state, "stopped");
});

test("a second stop during a stop, as a budget stop gives, reports the parent once", async () => {
	const h = slowAbortTeam();
	assert.ok(h.spawn("lead", "main", { maxCost: 1 }).ok); await flush();
	assert.ok(h.spawn("helper", "lead").ok); await flush();
	const userStop = h.team.stop("lead");
	await sleep(10);
	// The lead's reply in flight ends, and its usage crosses the budget while helper's abort winds down.
	h.hooks.get("lead")!.update({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 1.5 } });
	assert.equal(await h.team.stop("lead"), undefined);
	await userStop; await sleep(80); await flush();
	assert.deepEqual(h.reports(), ["lead"]);
});

test("the usage of the request a stop aborts reaches the record", async () => {
	let hooks!: ChildHooks;
	const team = new Team({ maxConcurrent: 4, maxDepth: 1, replyTimeoutMs: 1000, deliverToMain: () => undefined, warn: () => undefined,
		launcher: { async launch(_record: AgentRecord, childHooks: ChildHooks): Promise<ChildHandle> {
			hooks = childHooks;
			let done!: () => void;
			return { prompt: () => new Promise<void>((resolve) => { done = resolve; }), steer: () => undefined,
				// As Pi does: the aborted reply ends with the usage its request already ran up (message_end).
				abort: async () => { await sleep(5); hooks.update({ usage: { input: 180_000, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.92 } }); done(); },
				lastText: () => undefined, messages: () => [], takeQueued: () => [], dispose: async () => undefined };
		} } });
	assert.ok(team.spawn({ name: "big", task: "t", parent: "main", model: "m", readOnly: false, fork: false, blocking: false }).ok); await flush();
	hooks.update({ usage: { input: 100_000, output: 2000, cacheRead: 0, cacheWrite: 0, cost: 0.55 } });
	const stopped = await team.stop("big");
	assert.equal(stopped!.usage.cost, 0.92);
	assert.equal(stopped!.state, "stopped");
});

test("an agent that fails stops its subagents, and their reports go to main instead of being lost", async () => {
	const h = teamHarness({ maxDepth: 3 });
	h.spawn("mid", { name: "mid" }); await flush();
	h.spawn("leaf", { name: "leaf", parent: "mid" }); await flush();
	h.lastCall("mid").fail(new Error("invalid_request_error: something the model did"));
	await flush();
	assert.equal(h.team.get("mid")!.state, "failed");
	const leaf = h.team.get("leaf")!;
	assert.equal(leaf.state, "stopped");
	assert.match(leaf.stopReason ?? "", /mid failed/);
	assert.deepEqual(h.main.flatMap((delivery) => delivery.kind === "report" ? [delivery.record.name] : []), ["mid", "leaf"]);
});

test("the report of a subagent whose parent failed goes to the nearest live ancestor", async () => {
	const h = teamHarness({ maxDepth: 3 });
	h.spawn("top", { name: "top" }); await flush();
	h.spawn("mid", { name: "mid", parent: "top" }); await flush();
	h.spawn("leaf", { name: "leaf", parent: "mid" }); await flush();
	h.lastCall("mid").fail(new Error("invalid_request_error: something the model did"));
	await flush();
	const toTop = (h.steered.get("top") ?? []).join("\n");
	assert.match(toTop, /mid \(/, "top hears of its own child's failure");
	assert.match(toTop, /leaf's parent mid has ended/, "and gets leaf's report too");
	assert.equal(h.main.filter((delivery) => delivery.kind === "report").length, 0);
});

test("stop all and a parent's stop end a held after spawn before what it waits for, so it never launches", async () => {
	const h = teamHarness({ maxDepth: 3 });
	h.spawn("impl", { name: "impl" }); await flush();
	h.spawn("review", { name: "review", after: ["impl"] }); await flush();
	assert.equal(h.team.get("review")!.state, "queued");
	const all = await (stopTool({ team: h.team }, "main").execute as any)("id", { name: "all" }, undefined, undefined);
	assert.deepEqual(all.details.stopped.sort(), ["impl", "review"]);
	h.spawn("lead", { name: "lead" }); await flush();
	h.spawn("build", { name: "build", parent: "lead" }); await flush();
	h.spawn("check", { name: "check", parent: "lead", after: ["build"] }); await flush();
	await h.team.stop("lead");
	assert.deepEqual(h.launched.map((launch) => launch.name), ["impl", "lead", "build"]);
});

test("stopOrder puts agents that have not started first", () => {
	const order = stopOrder([{ name: "a", state: "running" }, { name: "b", state: "queued" }, { name: "c", state: "waiting" }, { name: "d", state: "queued" }] as const);
	assert.deepEqual(order.map((record) => record.name), ["b", "d", "a", "c"]);
});

test("a refused message leaves the target's check as it was; a delivered one sets it", async () => {
	const h = teamHarness({ maxDepth: 3 });
	h.spawn("lead", { name: "lead" }); await flush();
	h.spawn("leaf", { name: "leaf", parent: "lead" }); await flush();
	h.lastCall("leaf").fail(new Error("boom")); await flush();
	const refused = await h.team.send("main", "leaf", "Retry.", { check: { command: "make", fixUntilPass: 2 } });
	assert.equal(refused.ok, false);
	assert.equal(h.team.get("leaf")!.check, undefined);
	const sent = await h.team.send("main", "lead", "Also run the tests.", { check: { command: "make test" } });
	assert.equal(sent.ok, true);
	assert.equal(h.team.get("lead")!.check?.command, "make test");
});
