/** A run at its budget: its tools stop, it writes a report in the same session, and a backstop stops one that does not. */
import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import type { CheckRun } from "../lib/subagents/types.ts";
import { teamHarness } from "./support/team-harness.ts";

/** A budget of this many minutes runs out after 60 ms of work. */
const SHORT = 0.001;
const SHORT_MS = 60;
const REASON = "over its 0.001-minute budget";
const BLOCKED = "Blocked: this run's budget is used up. Do not call tools. Write your final report now.";
const PROMPT = /^Your 0\.001-minute budget for this run is used up\. Do not call tools; they are blocked\. Write your final report to main now, from what you have: what is done \(with evidence\), what is not done or not verified, what you leave behind \(uncommitted edits, worktrees, running processes\), and the next steps to finish\./;

function clock(t: TestContext): (ms: number) => Promise<void> {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	return async (ms) => {
		t.mock.timers.tick(ms);
		for (let i = 0; i < 8; i++) await tick();
	};
}
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const toolReply = (id = "call-1") => ({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }] });
const reports = (h: ReturnType<typeof teamHarness>) => h.main.filter((delivery) => delivery.kind === "report");

/** A child at its time limit, with the harness and its hooks. */
async function atLimit(t: TestContext, options: Parameters<typeof teamHarness>[0] = {}, extra: Parameters<ReturnType<typeof teamHarness>["spawn"]>[1] = {}) {
	const pass = clock(t);
	const h = teamHarness(options);
	const name = h.spawn("survey", { name: "survey", maxMinutes: SHORT, ...extra });
	await settle();
	await pass(SHORT_MS);
	return { h, name, pass, hooks: h.hooks.get(name)! };
}

test("at its time limit a run's tools are blocked, and at the next turn boundary it is asked for its report in the same session", async (t) => {
	const { h, name, hooks } = await atLimit(t);
	const record = h.team.get(name)!;
	assert.equal(record.state, "running", "not stopped");
	assert.equal(record.activity, `wrapping up: ${REASON}`);
	assert.deepEqual(h.aborts, [], "the run goes on");
	assert.equal(hooks.wrapUp?.(), BLOCKED);
	hooks.update({ activity: "bash ls", work: "tool" });
	assert.equal(h.team.get(name)!.activity, `wrapping up: ${REASON}`, "the widget keeps saying why");
	assert.equal(hooks.turnEnded?.(), true, "the loop ends at the turn boundary");
	h.lastCall(name).end(toolReply());
	await settle();
	assert.equal(h.calls.get(name)!.length, 2);
	assert.match(h.lastCall(name).text, PROMPT);
	assert.doesNotMatch(h.lastCall(name).text, /subagents/);
	assert.equal(h.launched.length, 1, "the same session");
	h.lastCall(name).finish("Read 2 of 4 files. Not done: the other 2.");
	await settle();
	const ended = h.team.get(name)!;
	assert.equal(ended.state, "idle");
	assert.equal(ended.budgetEnd, REASON);
	assert.equal(ended.stopReason, undefined);
	assert.equal(ended.report, "Read 2 of 4 files. Not done: the other 2.");
	assert.equal(hooks.wrapUp?.(), undefined);
	const sent = reports(h);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.kind === "report" && sent[0].record.budgetEnd, REASON);
	await h.team.close();
});

test("a run whose reply at the limit calls no tool has finished: that reply is its report, with no extra turn", async (t) => {
	const { h, name } = await atLimit(t);
	h.lastCall(name).finish("All four files read.");
	await settle();
	assert.equal(h.calls.get(name)!.length, 1);
	assert.equal(h.team.get(name)!.state, "idle");
	assert.equal(h.team.get(name)!.budgetEnd, REASON);
	assert.equal(h.team.get(name)!.report, "All four files read.");
	await h.team.close();
});

test("the cost budget wraps up the same way, and the cost check does not fire again during the wrap-up", async () => {
	const h = teamHarness();
	const name = h.spawn("spender", { name: "spender", maxCost: 0.5 });
	await settle();
	const hooks = h.hooks.get(name)!;
	hooks.update({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.6 } });
	assert.equal(h.team.get(name)!.activity, "wrapping up: over its $0.50 cost budget");
	assert.equal(hooks.turnEnded?.(), true);
	h.lastCall(name).end(toolReply());
	await settle();
	hooks.update({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 3 } });
	assert.equal(h.team.get(name)!.state, "running");
	assert.match(h.lastCall(name).text, /^Your \$0\.50 cost budget for this run is used up\./);
	h.lastCall(name).finish("Spent it on the survey.");
	await settle();
	assert.equal(h.team.get(name)!.state, "idle");
	assert.equal(h.team.get(name)!.budgetEnd, "over its $0.50 cost budget");
	await h.team.close();
});

test("at the limit the child's live subagents stop without a report, and the wrap-up prompt names them and their sessions", async (t) => {
	const pass = clock(t);
	const h = teamHarness();
	const lead = h.spawn("lead", { name: "lead", maxMinutes: SHORT });
	await settle();
	assert.ok(h.team.spawn({ name: "helper", task: "help", parent: lead, model: "m", readOnly: false, fork: false, blocking: false }).ok);
	assert.ok(h.team.spawn({ name: "idle-one", task: "done", parent: lead, model: "m", readOnly: false, fork: false, blocking: false }).ok);
	await settle();
	h.lastCall("idle-one").finish("Finished early.");
	await settle();
	await pass(SHORT_MS);
	assert.equal(h.team.get("helper")!.state, "stopped");
	assert.equal(h.team.get("helper")!.stopReason, undefined);
	assert.equal(h.team.get("idle-one")!.state, "idle", "only live subagents stop");
	assert.equal(h.hooks.get(lead)!.turnEnded?.(), true);
	h.lastCall(lead).end(toolReply());
	await settle();
	assert.match(h.lastCall(lead).text, /Your subagents were stopped: helper \(running; session \/sessions\/helper\.jsonl\)\.$/);
	assert.doesNotMatch(h.lastCall(lead).text, /idle-one/);
	assert.equal(h.calls.get(lead)!.filter((call) => /helper/.test(call.text) && /Report|stopped after/.test(call.text)).length, 0, "no report of helper reaches lead");
	await h.team.close();
});

test("a tool call still running after the grace is aborted, and the run goes on in the same session with the wrap-up prompt", async (t) => {
	const { h, name, pass } = await atLimit(t, { budgetTimes: { toolGraceMs: 1_000 } });
	await pass(999);
	assert.deepEqual(h.aborts, []);
	await pass(1);
	assert.deepEqual(h.aborts, [name]);
	h.lastCall(name).end({ ...toolReply(), stopReason: "aborted" });
	await settle();
	assert.equal(h.team.get(name)!.state, "running", "the abort is not a stop");
	assert.match(h.lastCall(name).text, PROMPT);
	h.lastCall(name).finish("Stopped mid-build; the build did not finish.");
	await settle();
	assert.equal(h.team.get(name)!.state, "idle");
	assert.equal(h.team.get(name)!.budgetEnd, REASON);
	assert.equal(h.launched.length, 1);
	await h.team.close();
});

test("a run that reaches its turn boundary within the grace is not aborted", async (t) => {
	const { h, name, hooks, pass } = await atLimit(t, { budgetTimes: { toolGraceMs: 1_000 } });
	assert.equal(hooks.turnEnded?.(), true);
	h.lastCall(name).end(toolReply());
	await settle();
	await pass(2_000);
	assert.deepEqual(h.aborts, []);
	assert.match(h.lastCall(name).text, PROMPT);
	await h.team.close();
});

test("a wrap-up reply that still calls tools gets at most 2 blocked rounds, then the run stops as before", async (t) => {
	const { h, name, hooks } = await atLimit(t);
	assert.equal(hooks.turnEnded?.(), true);
	h.lastCall(name).end(toolReply());
	await settle();
	assert.match(h.lastCall(name).text, PROMPT);
	assert.equal(hooks.turnEnded?.(), false, "round 1: the model gets another turn");
	assert.equal(hooks.turnEnded?.(), true, "round 2: the loop ends");
	h.lastCall(name).end(toolReply("call-2"));
	await settle();
	const record = h.team.get(name)!;
	assert.equal(record.state, "stopped");
	assert.equal(record.stopReason, REASON);
	assert.equal(record.budgetEnd, undefined);
	assert.equal(h.calls.get(name)!.length, 2);
	await h.team.close();
});

test("a wrap-up that has not ended by the backstop stops the run as before, with its last message", async (t) => {
	const { h, name, pass } = await atLimit(t, { budgetTimes: { backstopMs: 5_000, toolGraceMs: 100_000 } });
	h.transcripts.get(name)!.push({ role: "assistant", content: [{ type: "text", text: "Halfway." }] });
	await pass(4_999);
	assert.equal(h.team.get(name)!.state, "running");
	await pass(1);
	const record = h.team.get(name)!;
	assert.equal(record.state, "stopped");
	assert.equal(record.stopReason, REASON);
	assert.equal(record.report, "Halfway.");
	assert.equal(reports(h).length, 1);
	await h.team.close();
});

test("a model error during the wrap-up stops the run as before: no fallback model", async (t) => {
	const { h, name, hooks } = await atLimit(t, { fallbackModels: ["other/model"] });
	assert.equal(hooks.turnEnded?.(), true);
	h.lastCall(name).end(toolReply());
	await settle();
	h.lastCall(name).fail(new Error("429 usage limit reached"));
	await settle();
	assert.equal(h.team.get(name)!.state, "stopped");
	assert.equal(h.team.get(name)!.stopReason, REASON);
	assert.equal(h.team.get(name)!.model, "openai-codex/gpt-6-luna");
	assert.equal(h.launched.length, 1);
	await h.team.close();
});

test("a model error in the turn at the limit stops the run too, with no fallback", async (t) => {
	const { h, name } = await atLimit(t, { fallbackModels: ["other/model"] });
	h.lastCall(name).fail(new Error("429 usage limit reached"));
	await settle();
	assert.equal(h.team.get(name)!.state, "stopped");
	assert.equal(h.launched.length, 1);
	await h.team.close();
});

test("mail that comes during the wrap-up waits unread for the child's next run, which is told how the last one ended", async (t) => {
	const { h, name, hooks } = await atLimit(t);
	assert.deepEqual(await h.team.send("main", name, "Also look at the docs."), { ok: true, delivered: "steered" });
	assert.equal(hooks.turnEnded?.(), true);
	h.lastCall(name).end(toolReply());
	await settle();
	assert.doesNotMatch(h.lastCall(name).text, /Also look at the docs/);
	h.lastCall(name).finish("Partial report.");
	await settle();
	const ended = h.team.get(name)!;
	assert.equal(ended.state, "idle");
	assert.deepEqual(ended.inbox, ["Message from main:\nAlso look at the docs."]);
	assert.equal(ended.unread, undefined);
	assert.ok((await h.team.send("main", name, "Continue.")).ok);
	await settle();
	const resumed = h.lastCall(name).text;
	assert.match(resumed, /^Your previous run reached its 0\.001-minute budget and ended with a wrap-up report\. This run has a fresh budget\. Its last tool call may not have completed/);
	assert.match(resumed, /Message from main:\nAlso look at the docs\.\n\nMessage from main:\nContinue\./);
	assert.equal(h.team.get(name)!.budgetEnd, undefined, "the new run has not reached its budget");
	assert.equal(h.team.get(name)!.inbox, undefined);
	await h.team.close();
});

test("a resumed run after a wrap-up gets a fresh budget and can wrap up again", async (t) => {
	const { h, name, pass } = await atLimit(t);
	h.lastCall(name).finish("Report one.");
	await settle();
	assert.ok((await h.team.send("main", name, "Continue.")).ok);
	await settle();
	assert.equal(h.team.get(name)!.activity === `wrapping up: ${REASON}`, false);
	assert.equal(h.hooks.get(name)!.wrapUp?.(), undefined);
	await pass(SHORT_MS - 1);
	assert.equal(h.hooks.get(name)!.wrapUp?.(), undefined, "a fresh clock");
	await pass(1);
	assert.equal(h.hooks.get(name)!.wrapUp?.(), BLOCKED);
	h.lastCall(name).finish("Report two.");
	await settle();
	assert.equal(h.team.get(name)!.budgetEnd, REASON);
	assert.equal(reports(h).length, 2);
	await h.team.close();
});

test("a limit during the check aborts it, and the reply before it is the report: no check result, no wrap-up turn", async (t) => {
	const pass = clock(t);
	const asked: AbortSignal[] = [];
	const h = teamHarness({ check: (_record, _command, options) => new Promise<CheckRun>((resolve) => {
		asked.push(options.signal);
		options.signal.addEventListener("abort", () => resolve({ exitCode: null, output: "aborted" }));
	}) });
	const name = h.spawn("checked", { name: "checked", maxMinutes: SHORT, check: { command: "npm test", fixUntilPass: 1 } });
	await settle();
	h.lastCall(name).finish("Done, tests not run yet.");
	await settle();
	assert.equal(asked.length, 1);
	await pass(SHORT_MS);
	assert.equal(asked[0]!.aborted, true);
	const record = h.team.get(name)!;
	assert.equal(record.state, "idle");
	assert.equal(record.budgetEnd, REASON);
	assert.equal(record.checked, undefined, "an aborted check is no result");
	assert.equal(record.report, "Done, tests not run yet.");
	assert.equal(h.calls.get(name)!.length, 1);
	await h.team.close();
});

test("a run that wraps up gets no check after its report", async (t) => {
	const asked: string[] = [];
	const { h, name } = await atLimit(t, { check: async (record) => { asked.push(record.name); return { exitCode: 0, output: "ok" }; } }, { check: { command: "npm test", fixUntilPass: 0 } });
	h.lastCall(name).finish("Report.");
	await settle();
	assert.equal(h.team.get(name)!.state, "idle");
	assert.deepEqual(asked, []);
	await h.team.close();
});

test("a stop during the wrap-up ends it as a stop, and its timers do nothing later", async (t) => {
	const { h, name, pass } = await atLimit(t, { budgetTimes: { backstopMs: 5_000, toolGraceMs: 1_000 } });
	const stopped = await h.team.stop(name, { by: "main" });
	assert.equal(stopped?.state, "stopped");
	assert.equal(stopped?.stopReason, undefined);
	const aborts = h.aborts.length;
	await pass(10_000);
	assert.equal(h.aborts.length, aborts);
	assert.equal(h.team.get(name)!.stopReason, undefined);
	await h.team.close();
});

test("a close during the wrap-up interrupts the child, and the backstop does not stop it later", async (t) => {
	const { h, name, pass } = await atLimit(t, { budgetTimes: { backstopMs: 5_000 } });
	await h.team.close();
	await pass(10_000);
	assert.equal(h.team.get(name)!.state, "interrupted");
});

test("a child that wraps up can't start a subagent", async (t) => {
	const { h, name } = await atLimit(t);
	const spawned = h.team.spawn({ name: "late", task: "late", parent: name, model: "m", readOnly: false, fork: false, blocking: false });
	assert.match(spawned.ok ? "" : spawned.error, /survey is wrapping up at its budget; it can't start subagents now\./);
	await h.team.close();
});

test("a report written at the budget is news even from a run a peer's question started", async (t) => {
	const pass = clock(t);
	const h = teamHarness();
	const asker = h.spawn("asker", { name: "asker" });
	const helper = h.spawn("helper", { name: "helper", maxMinutes: SHORT });
	await settle();
	h.lastCall(helper).finish("First run done.");
	await settle();
	h.main.length = 0;
	assert.ok((await h.team.send(asker, helper, "Which port?", { expectReply: true })).ok);
	await settle();
	assert.equal(h.team.get(helper)!.state, "running");
	await pass(SHORT_MS);
	h.lastCall(helper).finish("Port 8080; ran out of time for the rest.");
	await settle();
	const sent = reports(h);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.kind === "report" && sent[0].quiet, undefined, "it wakes main");
	await h.team.close();
});

test("a reply at the limit that calls no tool is not the report when subagents were stopped: the child is told and reports on them", async (t) => {
	const pass = clock(t);
	const h = teamHarness();
	const lead = h.spawn("lead", { name: "lead", maxMinutes: SHORT });
	await settle();
	assert.ok(h.team.spawn({ name: "helper", task: "help", parent: lead, model: "m", readOnly: false, fork: false, blocking: false }).ok);
	await settle();
	await pass(SHORT_MS);
	assert.equal(h.team.get("helper")!.state, "stopped");
	h.lastCall(lead).finish("I wait for helper to report.");
	await settle();
	assert.equal(h.calls.get(lead)!.length, 2, "a wrap-up prompt, though the reply called no tool");
	assert.match(h.lastCall(lead).text, /Your subagents were stopped: helper \(running; session \/sessions\/helper\.jsonl\)\.$/);
	h.lastCall(lead).finish("helper was stopped before it reported; its work is in /sessions/helper.jsonl.");
	await settle();
	assert.equal(h.team.get(lead)!.state, "idle");
	assert.match(h.team.get(lead)!.report ?? "", /helper was stopped/);
	await h.team.close();
});

test("the subagents stop all at once at the limit, and a stop that fails is reported, not left unhandled", async (t) => {
	const warned: string[] = [];
	const pass = clock(t);
	const h = teamHarness({ warn: (message) => warned.push(message) });
	const lead = h.spawn("lead", { name: "lead", maxMinutes: SHORT });
	await settle();
	for (const name of ["one", "two"]) assert.ok(h.team.spawn({ name, task: name, parent: lead, model: "m", readOnly: false, fork: false, blocking: false }).ok);
	await settle();
	const stop = h.team.stop.bind(h.team);
	const started: string[] = [];
	t.mock.method(h.team, "stop", (name: string, options?: { by?: string; reason?: string }) => {
		started.push(name);
		return name === "one" ? new Promise(() => undefined) : name === "two" ? Promise.reject(new Error("disk full")) : stop(name, options);
	});
	await pass(SHORT_MS);
	assert.deepEqual(started, ["one", "two"], "a stop that hangs does not hold up the next");
	assert.match(warned.join("\n"), /two.*disk full/);
	await h.team.close();
});
