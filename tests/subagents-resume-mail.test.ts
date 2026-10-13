/**
 * The message that resumes a child is never lost: when its launch can't go
 * (a stop, a failed launch, a close), it waits in the child's inbox.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import { type AgentRecord, type ChildHandle, type MainDelivery, NO_USAGE } from "../lib/subagents/types.ts";
import { teamHarness } from "./support/team-harness.ts";

const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await tick(); };

const saved = (over: Partial<AgentRecord>): AgentRecord => ({ name: "reviewer", parent: "main", depth: 1, task: "Review", model: "m", readOnly: false, fork: false,
	blocking: false, state: "idle", createdAt: 1, activity: null, toolCalls: 0, usage: { ...NO_USAGE }, runs: 1, restored: true, ...over });

test("stopping a child whose relaunch is queued keeps the message in its inbox", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.team.restore([saved({ state: "stopped" })]);
	h.spawn("Build it", { name: "builder" }); await flush();
	const sent = await h.team.send("main", "reviewer", "Resume: also review db/017.sql.");
	assert.equal(sent.ok && sent.delivered, "resumed");
	await h.team.stop("reviewer");
	const reviewer = h.team.get("reviewer")!;
	assert.equal(reviewer.state, "stopped");
	assert.ok((reviewer.inbox ?? []).some((message) => message.includes("db/017.sql")), "main's message waits for the next run");
	assert.ok(!(reviewer.inbox ?? []).some((message) => message.includes("previous run was stopped")), "only the message waits, not the resume note");
});

test("a message that queued a relaunch survives a close before the launch, and the next run reads it", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.team.restore([saved({})]);
	h.spawn("Build it", { name: "builder" }); await flush();
	assert.equal((await h.team.send("main", "reviewer", "Also review the migration in db/017.sql.")).ok, true);
	await h.team.close("quit");
	const index = h.team.list();
	assert.ok((index.find((record) => record.name === "reviewer")!.inbox ?? []).some((message) => message.includes("db/017.sql")));
	const next = teamHarness();
	next.team.restore(index.map((record) => ({ ...record, restored: true })));
	await next.team.send("user", "reviewer", "Continue your task and report the outcome."); await flush();
	assert.match(next.lastCall("reviewer").text, /db\/017\.sql/);
});

test("a helper's report to a waiting lead waits in its inbox when the lead's relaunch fails", async () => {
	const finish = new Map<string, (text: string) => void>();
	let reloaded = false;
	const main: MainDelivery[] = [];
	const team = new Team({ maxConcurrent: 8, maxDepth: 2, replyTimeoutMs: 60_000, deliverToMain: (delivery) => main.push(delivery), warn: () => undefined,
		launcher: {
			async launch(record: AgentRecord): Promise<ChildHandle> {
				if (reloaded && record.name === "lead") throw new Error("Extension error while loading the child's tools.");
				const transcript: unknown[] = [];
				return { prompt: (text) => new Promise<void>((resolve) => {
					transcript.push({ role: "user", content: text });
					finish.set(record.name, (said) => { transcript.push({ role: "assistant", content: [{ type: "text", text: said }] }); resolve(); });
				}),
				steer: () => undefined, abort: async () => undefined, lastText: () => undefined, messages: () => transcript, takeQueued: () => [], dispose: async () => undefined };
			},
			// After a /reload, held sessions are stale.
			current: () => !reloaded,
		} });
	assert.ok(team.spawn({ name: "lead", task: "Lead", parent: "main", model: "m", readOnly: false, fork: false, blocking: false }).ok); await flush();
	assert.ok(team.spawn({ name: "helper", task: "Help", parent: "lead", model: "m", readOnly: false, fork: false, blocking: false }).ok); await flush();
	finish.get("lead")!("Started helper; waiting."); await flush();
	assert.equal(team.get("lead")!.state, "waiting");
	reloaded = true;
	finish.get("helper")!("FINDING: the leak is in pool.ts:88"); await flush();
	const lead = team.get("lead")!;
	assert.equal(lead.state, "interrupted");
	assert.ok((lead.inbox ?? []).some((message) => message.includes("pool.ts:88")), "the helper's report waits for the lead's next run");
});

test("main resumes a grandchild as its parent would: a note to an idle one, and a message to a stopped or paused one", async () => {
	const h = teamHarness();
	h.team.restore([saved({ name: "lead" }), saved({ name: "idle-helper", parent: "lead", depth: 2 }),
		saved({ name: "stopped-helper", parent: "lead", depth: 2, state: "stopped" }),
		saved({ name: "paused-helper", parent: "lead", depth: 2, state: "interrupted", interruptionId: "i", interruptedBy: "quit" })]);
	for (const name of ["idle-helper", "stopped-helper", "paused-helper"]) {
		const sent = await h.team.send("main", name, "Please also check parser.ts");
		assert.equal(sent.ok && sent.delivered, "resumed", name);
	}
	await flush();
	assert.deepEqual(h.launched.map((launch) => launch.name).sort(), ["idle-helper", "paused-helper", "stopped-helper"]);
	assert.equal(h.team.get("lead")!.state, "idle", "its parent stays as it was");
});

test("a relaunch reads older inbox mail before the message that started it, after the resume note", async () => {
	const h = teamHarness();
	h.team.restore([saved({ name: "dev", state: "stopped", inbox: ["Message from peer:\nOLD: use the v1 API."] })]);
	await h.team.send("main", "dev", "NEW: v1 is gone, use the v2 API."); await flush();
	const prompt = h.lastCall("dev").text;
	assert.match(prompt, /Your previous run was stopped\.[\s\S]*OLD[\s\S]*NEW/);
	assert.equal(h.team.get("dev")!.inbox, undefined);
});

test("a spawn group holds only its first run's reports: a later run leaves the group", async () => {
	const h = teamHarness();
	h.spawn("Quick", { name: "quick", group: "run-0-1" });
	h.spawn("Long", { name: "long", group: "run-0-1" });
	await flush();
	assert.equal(h.team.get("quick")!.group, "run-0-1");
	h.lastCall("quick").finish("quick done"); await flush();
	assert.equal(h.team.get("quick")!.group, "run-0-1", "its first report still waits for the group");
	await h.team.send("main", "quick", "Which file was it?", { expectReply: true }); await flush();
	assert.equal(h.team.get("quick")!.group, undefined);
	assert.equal(h.team.get("long")!.group, "run-0-1");
});

test("mail that comes while a relaunch waits in line follows the message that started the relaunch", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.spawn("A", { name: "a" }); await flush();
	await h.team.stop("a"); await flush();
	h.spawn("B", { name: "b" }); await flush();
	const first = await h.team.send("main", "a", "FIRST: change of plan.");
	assert.equal(first.ok && first.delivered, "resumed");
	await h.team.send("main", "a", "SECOND: and also this."); await flush();
	h.lastCall("b").finish("b done"); await flush();
	const text = h.lastCall("a").text;
	assert.ok(text.indexOf("FIRST") >= 0 && text.indexOf("FIRST") < text.indexOf("SECOND"), `oldest first: ${text}`);
});

test("a parked message keeps its place before mail that came after it", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	h.team.restore([saved({ state: "stopped" })]);
	h.spawn("Build it", { name: "builder" }); await flush();
	await h.team.send("main", "reviewer", "FIRST: review db/017.sql.");
	await h.team.send("main", "reviewer", "SECOND: and db/018.sql.");
	await h.team.stop("reviewer");
	const inbox = (h.team.get("reviewer")!.inbox ?? []).join("\n");
	assert.ok(inbox.indexOf("FIRST") >= 0 && inbox.indexOf("FIRST") < inbox.indexOf("SECOND"), inbox);
});

test("swap: mail carried from the old session comes before mail that came during the new launch", async () => {
	const transcript: unknown[] = [];
	const prompts: string[][] = [];
	const resolvers: Array<() => void> = [];
	const queues: string[][] = [];
	let gate: (() => void) | undefined;
	let launches = 0;
	let stale = false;
	const team = new Team({
		maxConcurrent: 4, maxDepth: 2, replyTimeoutMs: 60_000, warn: () => undefined, deliverToMain: () => undefined,
		launcher: {
			async launch(): Promise<ChildHandle> {
				const id = launches++;
				if (id > 0) await new Promise<void>((resolve) => { gate = resolve; });
				prompts[id] = []; queues[id] = [];
				return {
					sessionFile: "/sessions/impl.jsonl", stamp: { generation: id, files: [] },
					prompt: (text) => new Promise<void>((resolve) => { transcript.push({ role: "user", content: [{ type: "text", text }] }); prompts[id]!.push(text); resolvers[id] = resolve; }),
					steer: (text) => { queues[id]!.push(text); },
					abort: async () => undefined, lastText: () => undefined, messages: () => transcript,
					takeQueued: () => queues[id]!.splice(0), dispose: async () => undefined,
				};
			},
			current: (handle) => !(stale && handle.stamp?.generation === 0),
			codeCurrent: (handle) => !(stale && handle.stamp?.generation === 0),
		},
	});
	assert.ok(team.spawn({ name: "impl", task: "Task", parent: "main", model: "m", readOnly: false, fork: false, blocking: false }).ok);
	await flush();
	assert.equal((await team.send("main", "impl", "OLD mail.")).ok, true);
	stale = true;
	transcript.push({ role: "assistant", content: [{ type: "text", text: "Done, I think." }] });
	assert.equal((team as unknown as { turnEnded(name: string): boolean }).turnEnded("impl"), true);
	resolvers[0]!();
	await flush();
	assert.equal(team.get("impl")!.state, "starting");
	assert.equal((await team.send("main", "impl", "NEW mail.")).ok, true);
	gate!();
	await flush();
	const prompt = prompts[1]!.join("\n\n");
	assert.ok(prompt.indexOf("OLD mail.") >= 0 && prompt.indexOf("OLD mail.") < prompt.indexOf("NEW mail."), `order: ${prompt}`);
	await team.close();
});
