import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import type { AgentRecord, ChildHandle, ChildHooks, MainDelivery, SpawnRequest } from "../lib/subagents/types.ts";

interface Call { text: string; finish(result: string): void; fail(error: Error): void }

/** A launcher whose children finish only when the test says so. */
function harness(options: { maxConcurrent?: number; maxDepth?: number; replyTimeoutMs?: number; launchError?: Error } = {}) {
	const calls = new Map<string, Call[]>();
	const steered = new Map<string, string[]>();
	const aborted: string[] = [];
	const hooks = new Map<string, ChildHooks>();
	const queuedLate = new Map<string, string[]>();
	const main: MainDelivery[] = [];
	const team = new Team({
		maxConcurrent: options.maxConcurrent ?? 4,
		maxDepth: options.maxDepth ?? 1,
		replyTimeoutMs: options.replyTimeoutMs ?? 60_000,
		deliverToMain: (delivery) => main.push(delivery),
		launcher: {
			async launch(record: AgentRecord, childHooks: ChildHooks): Promise<ChildHandle> {
				if (options.launchError) throw options.launchError;
				hooks.set(record.name, childHooks);
				let last: string | undefined;
				return {
					sessionFile: `/sessions/${record.name}.jsonl`,
					prompt: (text) => new Promise<void>((resolve, reject) => {
						calls.set(record.name, [...(calls.get(record.name) ?? []), {
							text,
							finish: (result) => { last = result; resolve(); },
							fail: reject,
						}]);
					}),
					steer: (text) => steered.set(record.name, [...(steered.get(record.name) ?? []), text]),
					abort: async () => { aborted.push(record.name); },
					lastText: () => last,
					messages: () => [],
					takeQueued: () => { const late = queuedLate.get(record.name) ?? []; queuedLate.delete(record.name); return late; },
					dispose: async () => undefined,
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
	return { team, calls, steered, aborted, hooks, queuedLate, main, spawn, lastCall };
}

test("a child runs its task and reports to main once", async () => {
	const h = harness();
	const name = h.spawn("Review the auth module");
	assert.equal(name, "review-auth-module");
	await tick();
	assert.equal(h.team.get(name)!.state, "running");
	assert.equal(h.lastCall(name).text, "Review the auth module");
	h.lastCall(name).finish("All good.");
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "idle");
	assert.equal(done.report, "All good.");
	assert.equal(done.sessionFile, "/sessions/review-auth-module.jsonl");
	assert.deepEqual(h.main.map((d) => d.kind), ["report"]);
});

test("children beyond maxConcurrent queue and start as slots free up", async () => {
	const h = harness({ maxConcurrent: 2 });
	const [a, b, c] = [h.spawn("alpha task"), h.spawn("beta task"), h.spawn("gamma task")];
	await tick();
	assert.deepEqual([a, b, c].map((n) => h.team.get(n)!.state), ["running", "running", "queued"]);
	h.lastCall(a).finish("done");
	await h.team.whenDone(a);
	await tick();
	assert.equal(h.team.get(c)!.state, "running");
});

test("a blocking child reports to its caller, not as a message; detaching restores the message", async () => {
	const h = harness();
	const quiet = h.spawn("quick check", { blocking: true });
	await tick();
	h.lastCall(quiet).finish("ok");
	assert.equal((await h.team.whenDone(quiet)).report, "ok");
	assert.equal(h.main.length, 0);
	const detached = h.spawn("slow check", { blocking: true });
	await tick();
	h.team.detach(detached);
	h.lastCall(detached).finish("late");
	await h.team.whenDone(detached);
	assert.deepEqual(h.main.map((d) => d.kind), ["report"]);
});

test("a question to main blocks the child until main replies", async () => {
	const h = harness();
	const name = h.spawn("migrate the schema");
	await tick();
	const asked = h.team.send(name, "main", "Drop the legacy column?", { expectReply: true });
	await tick();
	assert.equal(h.team.get(name)!.state, "asking");
	assert.deepEqual(h.main.at(-1), { kind: "question", from: name, text: "Drop the legacy column?" });
	const reply = await h.team.send("main", name, "Yes, drop it.");
	assert.deepEqual(reply, { ok: true, delivered: "replied" });
	assert.deepEqual(await asked, { ok: true, delivered: "replied", reply: "Yes, drop it." });
	assert.equal(h.team.get(name)!.state, "running");
	assert.equal(h.steered.get(name), undefined);
});

test("an unanswered question times out with guidance", async () => {
	const h = harness({ replyTimeoutMs: 20 });
	const name = h.spawn("anything");
	await tick();
	const result = await h.team.send(name, "main", "Well?", { expectReply: true });
	assert.equal(result.ok, false);
	assert.match(!result.ok ? result.error : "", /No reply from main.*best judgment/);
});

test("main steers a running child and resumes a finished one with its context", async () => {
	const h = harness();
	const name = h.spawn("scan the repo");
	await tick();
	assert.deepEqual(await h.team.send("main", name, "Skip vendor/"), { ok: true, delivered: "steered" });
	assert.deepEqual(h.steered.get(name), ["Message from main:\nSkip vendor/"]);
	h.lastCall(name).finish("first report");
	await h.team.whenDone(name);
	assert.deepEqual(await h.team.send("main", name, "Now check tests/"), { ok: true, delivered: "resumed" });
	await tick();
	assert.equal(h.team.get(name)!.state, "running");
	assert.equal(h.team.get(name)!.runs, 2);
	h.lastCall(name).finish("second report");
	await tick();
	assert.equal(h.team.get(name)!.report, "second report");
	assert.equal(h.main.filter((d) => d.kind === "report").length, 2);
});

test("a sibling's note to a finished child waits in its inbox; a question resumes it", async () => {
	const h = harness();
	const [a, b] = [h.spawn("alpha work"), h.spawn("beta work")];
	await tick();
	h.lastCall(b).finish("beta done");
	await h.team.whenDone(b);
	assert.deepEqual(await h.team.send(a, b, "fyi: touched lib/x.ts"), { ok: true, delivered: "inbox" });
	assert.equal(h.calls.get(b)!.length, 1);
	const asked = h.team.send(a, b, "Which file had the bug?", { expectReply: true });
	await tick();
	assert.equal(h.team.get(b)!.state, "running");
	assert.match(h.lastCall(b).text, /fyi: touched lib\/x.ts[\s\S]*Question from alpha-work/);
	await h.team.send(b, a, "lib/y.ts:40");
	assert.deepEqual(await asked, { ok: true, delivered: "replied", reply: "lib/y.ts:40" });
});

test("steering that lands as a run ends starts another run instead of being lost", async () => {
	const h = harness();
	const name = h.spawn("edge case");
	await tick();
	h.queuedLate.set(name, ["late note"]);
	h.lastCall(name).finish("first");
	await tick();
	assert.equal(h.lastCall(name).text, "late note");
	assert.equal(h.team.get(name)!.state, "running");
});

test("launch and run failures report as failed", async () => {
	const broken = harness({ launchError: new Error("no credentials") });
	const name = broken.spawn("anything");
	const done = await broken.team.whenDone(name);
	assert.equal(done.state, "failed");
	assert.equal(done.error, "no credentials");
	const h = harness();
	const other = h.spawn("other");
	await tick();
	h.lastCall(other).fail(new Error("rate limited"));
	assert.equal((await h.team.whenDone(other)).error, "rate limited");
	assert.equal(h.main.length, 1);
});

test("stop aborts the child and its children, and reports it stopped", async () => {
	const h = harness({ maxDepth: 2 });
	const parent = h.spawn("lead");
	await tick();
	const child = h.team.spawn({ task: "helper", parent, model: "m", readOnly: false, fork: false, blocking: false });
	assert.ok(child.ok);
	await tick();
	await h.team.stop(parent);
	assert.deepEqual(h.aborted.sort(), ["helper", "lead"]);
	assert.equal(h.team.get(parent)!.state, "stopped");
	assert.equal(h.team.get("helper")!.state, "stopped");
});

test("depth is limited; a nested parent waits for its children before reporting", async () => {
	const flat = harness();
	const lead = flat.spawn("lead");
	const refused = flat.team.spawn({ task: "helper", parent: lead, model: "m", readOnly: false, fork: false, blocking: false });
	assert.equal(refused.ok, false);

	const h = harness({ maxDepth: 2 });
	const parent = h.spawn("lead");
	await tick();
	assert.ok(h.team.spawn({ task: "helper", parent, model: "m", readOnly: false, fork: false, blocking: false }).ok);
	await tick();
	h.lastCall(parent).finish("started helper");
	await tick();
	assert.equal(h.team.get(parent)!.state, "waiting");
	assert.equal(h.main.length, 0);
	h.lastCall("helper").finish("helper result");
	await tick();
	assert.match(h.lastCall(parent).text, /helper \(m\) finished[\s\S]*helper result/);
	h.lastCall(parent).finish("final with helper");
	const done = await h.team.whenDone(parent);
	assert.equal(done.report, "final with helper");
	assert.deepEqual(h.main.map((d) => d.kind), ["report"]);
});

test("broadcast reaches live siblings and main; asking everyone is refused", async () => {
	const h = harness();
	const [a, b] = [h.spawn("alpha"), h.spawn("beta")];
	await tick();
	assert.equal((await h.team.send(a, "all", "heads up")).ok, true);
	assert.deepEqual(h.steered.get(b), ["Message from alpha:\nheads up"]);
	assert.deepEqual(h.main.at(-1), { kind: "note", from: a, text: "heads up" });
	assert.equal((await h.team.send(a, "all", "?", { expectReply: true })).ok, false);
	assert.equal((await h.team.send("main", "nobody", "hi")).ok, false);
});

test("the user answers a child's question from the inspector, and resumes finished children", async () => {
	const h = harness();
	const name = h.spawn("delete old rows");
	await tick();
	const asked = h.team.send(name, "main", "Delete 40k rows?", { expectReply: true });
	await tick();
	assert.deepEqual(await h.team.send("user", name, "No, keep them."), { ok: true, delivered: "replied" });
	assert.deepEqual(h.main.at(-1), { kind: "relay", from: "user", to: name, text: "No, keep them.", answered: true });
	assert.deepEqual(await asked, { ok: true, delivered: "replied", reply: "No, keep them." });
	h.lastCall(name).finish("kept");
	await h.team.whenDone(name);
	assert.deepEqual(await h.team.send("user", name, "Now archive them."), { ok: true, delivered: "resumed" });
	assert.deepEqual(h.main.at(-1), { kind: "relay", from: "user", to: name, text: "Now archive them.", answered: false });
	await tick();
	h.lastCall(name).finish("archived");
	await tick();
	const report = h.main.at(-1);
	assert.equal(report?.kind, "report");
	const { reportText } = await import("../lib/subagents/format.ts");
	assert.match(reportText((report as { record: AgentRecord }).record, Date.now()), /This run \(2\) handled: Message from user: Now archive them\./);
});

test("main never blocks: its question is delivered and the answer wakes it as a reply", async () => {
	const h = harness();
	const name = h.spawn("audit deps");
	await tick();
	assert.deepEqual(await h.team.send("main", name, "Which lockfile?", { expectReply: true }), { ok: true, delivered: "steered" });
	assert.match(h.steered.get(name)![0]!, /^Question from main, who is waiting for your reply/);
	await h.team.send(name, "main", "package-lock.json");
	assert.deepEqual(h.main.at(-1), { kind: "reply", from: name, text: "package-lock.json" });
	await h.team.send(name, "main", "also found a stale dep");
	assert.deepEqual(h.main.at(-1), { kind: "note", from: name, text: "also found a stale dep" });
});

test("a resumed run is timed on its own and names what started it", async () => {
	let clock = 0;
	const h = harness();
	(h.team as unknown as { now: () => number }).now = () => clock;
	const name = h.spawn("scan the repo");
	await tick();
	clock = 11_000;
	h.lastCall(name).finish("first");
	await h.team.whenDone(name);
	clock = 30_000;
	await h.team.send("main", name, "Which file?", { expectReply: true });
	await tick();
	assert.equal(h.team.get(name)!.startedAt, 30_000);
	clock = 40_000;
	h.lastCall(name).finish("second");
	await tick();
	const { reportText } = await import("../lib/subagents/format.ts");
	const text = reportText(h.team.get(name)!, clock);
	assert.match(text, /finished after 10s\./);
	assert.match(text, /This run \(2\) handled: Question from main: Which file\?\n/);
});

test("a report doesn't wake main again once the run answered main's question", async () => {
	const h = harness();
	const name = h.spawn("read format.ts");
	await tick();
	h.lastCall(name).finish("capReport is 12k");
	await h.team.whenDone(name);
	assert.equal((h.main.at(-1) as { record: AgentRecord }).record.answeredMain, undefined);
	await h.team.send("main", name, "What does noteText return?", { expectReply: true });
	await tick();
	await h.team.send(name, "main", "Message from X");
	assert.equal(h.main.at(-1)?.kind, "reply");
	h.lastCall(name).finish("Message from X");
	await tick();
	assert.equal((h.main.at(-1) as { record: AgentRecord }).record.answeredMain, true);
	// A later run that main starts with a plain message reports normally.
	await h.team.send("main", name, "Now check the tests.");
	await tick();
	h.lastCall(name).finish("tests fine");
	await tick();
	assert.equal((h.main.at(-1) as { record: AgentRecord }).record.answeredMain, undefined);
});
