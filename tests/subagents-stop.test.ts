import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import { type AgentRecord, type ChildHandle, type MainDelivery, NO_USAGE } from "../lib/subagents/types.ts";

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
