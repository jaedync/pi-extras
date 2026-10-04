import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import { MainMail, type OutgoingMessage } from "../lib/subagents/deliver.ts";
import { NO_USAGE, type AgentRecord, type ChildHandle, type MainDelivery, type SpawnRequest } from "../lib/subagents/types.ts";

interface Call { text: string; finish(result: string): void; fail(error: Error): void }

/** Children that finish or fail when the test says, as in the lifecycle tests. */
function harness() {
	const calls = new Map<string, Call[]>();
	const main: MainDelivery[] = [];
	const team = new Team({
		maxConcurrent: 8, maxDepth: 2, replyTimeoutMs: 60_000,
		deliverToMain: (delivery) => main.push(delivery),
		launcher: {
			async launch(record: AgentRecord): Promise<ChildHandle> {
				const transcript: unknown[] = [];
				return {
					prompt: (text) => new Promise<void>((resolve, reject) => {
						calls.set(record.name, [...(calls.get(record.name) ?? []), {
							text,
							finish: (result) => { transcript.push({ role: "assistant", content: [{ type: "text", text: result }] }); resolve(); },
							fail: reject,
						}]);
					}),
					steer: () => undefined, abort: async () => undefined, lastText: () => undefined,
					messages: () => transcript, takeQueued: () => [], dispose: async () => undefined,
				};
			},
		},
	});
	const spawn = async (name: string, extra: Partial<SpawnRequest> = {}) => {
		const result = team.spawn({ name, task: `Task for ${name}`, parent: "main", model: "test/model", readOnly: false, fork: false, blocking: false, ...extra });
		assert.ok(result.ok, !result.ok ? result.error : "");
		await tick(); await tick();
		return name;
	};
	const last = (name: string) => calls.get(name)!.at(-1)!;
	const finish = async (name: string, text: string) => { last(name).finish(text); await tick(); await tick(); };
	const reports = () => main.filter((delivery): delivery is Extract<MainDelivery, { kind: "report" }> => delivery.kind === "report");
	return { team, calls, main, spawn, last, finish, reports };
}

/** `peer` asks idle `target` a question, which resumes it; `target` answers. */
async function peerResumes(h: ReturnType<typeof harness>, peer: string, target: string) {
	const asked = await h.team.send(peer, target, "Which file has the config?", { expectReply: true });
	assert.deepEqual(asked, { ok: true, delivered: "resumed" });
	await tick(); await tick();
	assert.equal(h.team.get(target)?.state, "running");
	assert.ok((await h.team.send(target, peer, "lib/config.ts")).ok);
}

test("a run a peer started that ends idle reports to main without waking it", async () => {
	const h = harness();
	const target = await h.spawn("target");
	const peer = await h.spawn("peer");
	await h.finish(target, "First report.");
	assert.equal(h.reports().at(-1)?.quiet, undefined, "its first run was main's: it wakes main");
	await peerResumes(h, peer, target);
	await h.finish(target, "Answered peer.");
	const report = h.reports().at(-1)!;
	assert.equal(report.record.name, target);
	assert.equal(report.record.report, "Answered peer.");
	assert.equal(report.quiet, true, "main reads it at its next turn");
	await h.team.close();
});

test("a run main started after a peer's run wakes main again", async () => {
	const h = harness();
	const target = await h.spawn("target");
	const peer = await h.spawn("peer");
	await h.finish(target, "First report.");
	await peerResumes(h, peer, target);
	await h.finish(target, "Answered peer.");
	assert.ok((await h.team.send("main", target, "One more check.")).ok);
	await tick(); await tick();
	await h.finish(target, "Checked.");
	assert.equal(h.reports().at(-1)?.quiet, undefined);
	await h.team.close();
});

test("a failed run a peer started still wakes main", async () => {
	const h = harness();
	const target = await h.spawn("target");
	const peer = await h.spawn("peer");
	await h.finish(target, "First report.");
	await peerResumes(h, peer, target);
	h.last(target).fail(new Error("provider overloaded"));
	await h.team.whenDone(target);
	const report = h.reports().at(-1)!;
	assert.equal(report.record.state, "failed");
	assert.equal(report.quiet, undefined);
	await h.team.close();
});

test("a run a peer started goes into an idle parent's inbox without resuming it", async () => {
	const h = harness();
	const lead = await h.spawn("lead");
	const target = await h.spawn("target", { parent: lead });
	const peer = await h.spawn("peer");
	await h.finish(target, "First report.");
	await h.finish(lead, "Lead done.");
	assert.equal(h.team.get(lead)?.state, "idle");
	const leadRuns = h.calls.get(lead)!.length;
	await peerResumes(h, peer, target);
	await h.finish(target, "Answered peer.");
	assert.equal(h.team.get(lead)?.state, "idle", "not resumed");
	assert.equal(h.calls.get(lead)!.length, leadRuns);
	assert.ok((await h.team.send("main", lead, "Anything new?")).ok);
	await tick(); await tick();
	assert.match(h.last(lead).text, /target \(test\/model\) finished after .*Answered peer\./s, "it reads the report on its next run");
	await h.team.close();
});

test("a failed run a peer started still resumes its parent", async () => {
	const h = harness();
	const lead = await h.spawn("lead");
	const target = await h.spawn("target", { parent: lead });
	const peer = await h.spawn("peer");
	await h.finish(target, "First report.");
	await h.finish(lead, "Lead done.");
	await peerResumes(h, peer, target);
	h.last(target).fail(new Error("boom"));
	await h.team.whenDone(target);
	await tick(); await tick();
	assert.equal(h.team.get(lead)?.state, "running");
	assert.match(h.last(lead).text, /target \(test\/model\) failed after .*: boom/);
	await h.team.close();
});

test("a parent that asks during a peer's run still gets a report that wakes it", async () => {
	const h = harness();
	const lead = await h.spawn("lead");
	const target = await h.spawn("target", { parent: lead });
	const peer = await h.spawn("peer");
	await h.finish(target, "First report.");
	await peerResumes(h, peer, target);
	assert.ok((await h.team.send(lead, target, "Also, how many files?", { expectReply: true })).ok);
	await h.finish(lead, "Asked target.");
	assert.equal(h.team.get(lead)?.state, "waiting");
	await h.finish(target, "Answered peer; 3 files.");
	assert.equal(h.team.get(lead)?.state, "running", "its question is answered by the report");
	await h.team.close();
});

test("main's note during a peer's run makes its report wake main", async () => {
	const h = harness();
	const target = await h.spawn("target");
	const peer = await h.spawn("peer");
	await h.finish(target, "First report.");
	await peerResumes(h, peer, target);
	assert.ok((await h.team.send("main", target, "Also note the version.")).ok);
	await h.finish(target, "Answered peer; version 2.");
	assert.equal(h.reports().at(-1)?.quiet, undefined);
	await h.team.close();
});

test("a quiet report reaches main at once without starting a turn, and stays pending until it lands", async () => {
	const sent: Array<{ message: OutgoingMessage; triggerTurn: boolean }> = [];
	const box = new MainMail({ port: { send: (message, options) => sent.push({ message, triggerTurn: options.triggerTurn }) }, batchMs: 1_000 });
	const record: AgentRecord = { name: "target", parent: "main", depth: 1, task: "t", model: "test/model", readOnly: false, fork: false, blocking: false,
		state: "idle", createdAt: 0, startedAt: 0, endedAt: 5_000, activity: null, toolCalls: 1, usage: NO_USAGE, runs: 2, report: "Answered peer." };
	box.deliver({ kind: "report", record, quiet: true });
	assert.equal(sent.length, 1, "not held for a batch: nothing waits on it");
	assert.equal(sent[0]!.triggerTurn, false);
	assert.match(sent[0]!.message.content, /target \(test\/model\) finished after 5s/);
	assert.deepEqual(box.pending().map((item) => item.kind), ["report"]);
	assert.equal(box.waiting(), false, "a headless run does not wait for main to read it");
	box.acknowledge((sent[0]!.message.details as { id: string }).id);
	assert.deepEqual(box.pending(), []);
	await sleep(5);
	box.dispose();
});
