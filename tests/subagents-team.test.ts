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
	const transcripts = new Map<string, unknown[]>();
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
							finish: (result) => {
								last = result;
								transcripts.set(record.name, [...(transcripts.get(record.name) ?? []), { role: "assistant", content: [{ type: "text", text: result }] }]);
								resolve();
							},
							fail: reject,
						}]);
					}),
					steer: (text) => steered.set(record.name, [...(steered.get(record.name) ?? []), text]),
					abort: async () => { aborted.push(record.name); },
					lastText: () => last,
					messages: () => transcripts.get(record.name) ?? [],
					takeQueued: () => { const late = queuedLate.get(record.name) ?? []; queuedLate.delete(record.name); return late; },
					dispose: async () => undefined,
				};
			},
		},
	});
	const spawn = (task: string, extra: Partial<SpawnRequest> = {}) => {
		const result = team.spawn({ task, parent: "main", model: "openai-codex/gpt-6-luna", readOnly: true, fork: false, blocking: false, ...extra });
		assert.ok(result.ok, !result.ok ? result.error : "");
		return result.record.name;
	};
	const lastCall = (name: string) => calls.get(name)!.at(-1)!;
	/** The child's latest response, making these tool calls. */
	const responds = (name: string, ...tools: string[]) => transcripts.set(name, [
		{ role: "assistant", content: tools.map((tool, i) => ({ type: "toolCall", id: `call-${i}`, name: tool, arguments: {} })) },
	]);
	return { team, calls, steered, aborted, hooks, queuedLate, main, spawn, lastCall, responds };
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
	assert.deepEqual(await h.team.send(a, b, "Which file had the bug?", { expectReply: true }), { ok: true, delivered: "resumed" });
	await tick();
	assert.equal(h.team.get(b)!.state, "running");
	assert.match(h.lastCall(b).text, /fyi: touched lib\/x.ts[\s\S]*Question from alpha-work/);
	assert.deepEqual(await h.team.send(b, a, "lib/y.ts:40"), { ok: true, delivered: "steered" }, "the answer comes as a message");
	assert.match(h.steered.get(a)!.at(-1)!, /Message from beta-work:\nlib\/y.ts:40/);
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
	h.responds(name, "message");
	await h.team.send(name, "main", "Message from X");
	assert.equal(h.main.at(-1)?.kind, "reply");
	// The message call that carried the answer ends; that alone is not more work.
	h.hooks.get(name)!.update({ toolCalls: 1 });
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

test("a run that keeps working after answering main's question still wakes main with its report", async () => {
	const h = harness();
	const name = h.spawn("read format.ts");
	await tick();
	h.lastCall(name).finish("capReport is 12k");
	await h.team.whenDone(name);
	await h.team.send("main", name, "Fix the other files too?", { expectReply: true });
	await tick();
	await h.team.send(name, "main", "Yes, starting now.");
	assert.equal(h.main.at(-1)?.kind, "reply");
	h.hooks.get(name)!.update({ toolCalls: 1 });
	h.hooks.get(name)!.update({ toolCalls: 2 });
	h.lastCall(name).finish("Fixed 14 files; two need review.");
	await tick();
	const report = h.main.at(-1) as { kind: string; record: AgentRecord };
	assert.equal(report.kind, "report");
	assert.equal(report.record.answeredMain, undefined, "an hour of work after a quick answer is news main must wake for");
});

/** Main resumes a finished child with a question; the child's first run ended as `first`. */
async function resumedWithQuestion(h: ReturnType<typeof harness>, task: string) {
	const name = h.spawn(task);
	await tick();
	h.lastCall(name).finish("first");
	await h.team.whenDone(name);
	await h.team.send("main", name, "Can you take this further?", { expectReply: true });
	await tick();
	return name;
}

const lastReport = (h: ReturnType<typeof harness>) => {
	const delivery = h.main.at(-1) as { kind: string; record: AgentRecord };
	assert.equal(delivery.kind, "report");
	return delivery.record;
};

test("an answer given before the child waits on its own subagent does not silence the later report", async () => {
	const h = harness({ maxDepth: 2 });
	const lead = await resumedWithQuestion(h, "coordinate the audit");
	const helper = h.team.spawn({ task: "helper audit work", parent: lead, model: "openai-codex/gpt-6-luna", readOnly: false, fork: false, blocking: false });
	assert.ok(helper.ok);
	h.hooks.get(lead)!.update({ toolCalls: 1 });
	await h.team.send(lead, "main", "Dispatched a helper; I'll report.");
	h.hooks.get(lead)!.update({ toolCalls: 2 });
	h.lastCall(lead).finish("waiting on the helper");
	await tick();
	assert.equal(h.team.get(lead)!.state, "waiting");
	await tick();
	h.lastCall(helper.record.name).finish("helper found two issues");
	await tick();
	h.lastCall(lead).finish("Audit done: two issues, both fixed.");
	await tick();
	assert.equal(lastReport(h).answeredMain, undefined, "the helper's report was new input, so the final report is news");
});

test("answering main's status question in a run main started with a note does not silence the deliverable", async () => {
	const h = harness();
	const name = h.spawn("write the migration");
	await tick();
	h.lastCall(name).finish("first");
	await h.team.whenDone(name);
	await h.team.send("main", name, "Now apply it to the other tables.");
	await tick();
	h.hooks.get(name)!.update({ toolCalls: 7 });
	await h.team.send("main", name, "Status?", { expectReply: true });
	await h.team.send(name, "main", "Almost done, writing up.");
	assert.equal(h.main.at(-1)?.kind, "reply");
	h.hooks.get(name)!.update({ toolCalls: 8 });
	h.lastCall(name).finish("Migration applied to 14 tables.");
	await tick();
	assert.equal(lastReport(h).answeredMain, undefined);
});

test("a second question steered into an answered run makes its report news again", async () => {
	const h = harness();
	const name = await resumedWithQuestion(h, "profile the build");
	await h.team.send(name, "main", "Yes: webpack dominates.");
	h.hooks.get(name)!.update({ toolCalls: 1 });
	await h.team.send("main", name, "And the fix?", { expectReply: true });
	await h.team.send(name, "main", "Working on it.");
	h.hooks.get(name)!.update({ toolCalls: 2 });
	h.lastCall(name).finish("Cut build time from 90s to 31s by caching loaders.");
	await tick();
	assert.equal(lastReport(h).answeredMain, undefined);
});

test("an answer sent in one response with other tool calls still wakes main with the report", async () => {
	const h = harness();
	const name = await resumedWithQuestion(h, "tidy the config");
	// Sequential execution: the edit in the same response ends before the answer is sent.
	h.responds(name, "edit", "message");
	h.hooks.get(name)!.update({ toolCalls: 1 });
	await h.team.send(name, "main", "Yes, done.");
	h.hooks.get(name)!.update({ toolCalls: 2 });
	h.lastCall(name).finish("Renamed the key and updated its three readers.");
	await tick();
	assert.equal(lastReport(h).answeredMain, undefined, "the edit's outcome is news the answer could not include");
});

test("an answer not carried by a lone message call wakes main with the report", async () => {
	const h = harness();
	const traceless = await resumedWithQuestion(h, "scan the logs");
	await h.team.send(traceless, "main", "Nothing unusual.");
	h.hooks.get(traceless)!.update({ toolCalls: 1 });
	h.lastCall(traceless).finish("Nothing unusual.");
	await tick();
	assert.equal(lastReport(h).answeredMain, undefined, "without the carrying response, err toward waking");
	const nested = await resumedWithQuestion(h, "run the script");
	h.responds(nested, "run_script");
	await h.team.send(nested, "main", "Started.");
	h.hooks.get(nested)!.update({ toolCalls: 1 });
	h.lastCall(nested).finish("Script finished: 3 warnings.");
	await tick();
	assert.equal(lastReport(h).answeredMain, undefined, "a script that sent the answer may have done more work");
});

test("a run that fails after answering main still wakes main with the failure", async () => {
	const h = harness();
	const name = await resumedWithQuestion(h, "check the quota");
	await h.team.send(name, "main", "Checking now.");
	h.hooks.get(name)!.update({ toolCalls: 1 });
	h.lastCall(name).fail(new Error("usage limit reached"));
	await tick();
	const report = lastReport(h);
	assert.equal(report.state, "failed");
	assert.equal(report.answeredMain, undefined);
});

test("a child asking two of its subagents goes on working, and waits for both answers before it reports", async () => {
	const h = harness({ maxDepth: 2 });
	const lead = h.spawn("lead the work");
	await tick();
	const a = h.spawn("part alpha", { parent: lead });
	const b = h.spawn("part beta", { parent: lead });
	await tick();
	assert.equal((await h.team.send(lead, a, "Done yet?", { expectReply: true })).ok, true);
	assert.equal((await h.team.send(lead, b, "Done yet?", { expectReply: true })).ok, true);
	assert.equal(h.team.get(lead)!.state, "running", "it never blocks on them");
	await h.team.send(a, lead, "alpha done");
	assert.match(h.steered.get(lead)!.at(-1)!, /alpha done/);
	h.lastCall(lead).finish("asked both");
	await tick();
	assert.equal(h.team.get(lead)!.state, "waiting");
	await h.team.send(b, lead, "beta done");
	await tick();
	assert.equal(h.team.get(lead)!.state, "running", "the last answer resumes it");
	assert.match(h.lastCall(lead).text, /beta done/);
});

test("a child's report answers its parent's open question to it", async () => {
	const h = harness({ maxDepth: 2 });
	const lead = h.spawn("lead the work");
	await tick();
	const a = h.spawn("part alpha", { parent: lead });
	await tick();
	assert.equal((await h.team.send(lead, a, "Report when you are done.", { expectReply: true })).ok, true);
	h.lastCall(a).finish("alpha: 3 files");
	await tick();
	assert.equal((h.steered.get(lead) ?? []).filter((text) => text.includes("alpha: 3 files")).length, 1, "delivered once, as the report");
	h.lastCall(lead).finish("done");
	await tick();
	assert.equal(h.team.get(lead)!.state, "idle", "nothing is owed any more");
});

test("a child its parent waits on can't narrate to it, and asking it ends the wait", async () => {
	const h = harness();
	const name = h.spawn("quick check", { blocking: true });
	await tick();
	const note = await h.team.send(name, "main", "starting now");
	assert.equal(note.ok, false);
	assert.match((note as { error: string }).error, /main is waiting for your report; put this in it/);
	assert.equal(h.main.length, 0);
	const asked = h.team.send(name, "main", "Which lockfile?", { expectReply: true });
	await tick();
	assert.equal(h.team.get(name)!.blocking, false, "main stops waiting, so it can answer");
	assert.deepEqual(h.main.at(-1), { kind: "question", from: name, text: "Which lockfile?" });
	await h.team.send("main", name, "package-lock.json");
	assert.deepEqual(await asked, { ok: true, delivered: "replied", reply: "package-lock.json" });
	h.lastCall(name).finish("done");
	await tick();
	assert.equal(h.main.at(-1)?.kind, "report", "its report now arrives as a message");
});
