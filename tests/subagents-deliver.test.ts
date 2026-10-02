import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { MainMail, MESSAGE_TYPE, REPORT_TYPE, type OutgoingMessage, type ReportSummary, type Route } from "../lib/subagents/deliver.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

function record(name: string, extra: Partial<AgentRecord> = {}): AgentRecord {
	return {
		name, parent: "main", depth: 1, task: "t", model: "openai-codex/gpt-6-luna", readOnly: false, fork: false, blocking: false,
		state: "idle", createdAt: 0, startedAt: 0, endedAt: 65_000, activity: null, toolCalls: 3, usage: { ...NO_USAGE, cost: 0.0042 },
		runs: 1, report: `${name} says done`, sessionFile: `/s/${name}.jsonl`, ...extra,
	};
}

function mail(batchMs = 20) {
	const sent: Array<{ message: OutgoingMessage; options: { triggerTurn: boolean; deliverAs?: string } }> = [];
	const box = new MainMail({ port: { send: (message, options) => sent.push({ message, options }) }, batchMs, now: () => 70_000 });
	return { box, sent };
}

test("notes, questions and replies all wake main, steered in while it works", () => {
	const { box, sent } = mail();
	box.deliver({ kind: "note", from: "scout", text: "found it" });
	box.deliver({ kind: "question", from: "worker", text: "delete it?" });
	box.deliver({ kind: "reply", from: "scout", text: "lib/a.ts" });
	// A child sends a note only when it would change what main is doing, so an idle main must not sit on it.
	assert.deepEqual(sent.map((s) => [s.message.customType, s.options.triggerTurn, s.options.deliverAs]),
		[[MESSAGE_TYPE, true, "steer"], [MESSAGE_TYPE, true, "steer"], [MESSAGE_TYPE, true, "steer"]]);
	assert.equal(sent[0]!.message.content, "Message from scout:\nfound it");
	assert.match(sent[1]!.message.content, /^Question from worker, who is waiting for your reply \(answer with message\(\{ to: "worker", text \}\)\):\ndelete it\?$/);
	assert.equal(sent[2]!.message.content, "Answer from scout:\nlib/a.ts");
	assert.equal(sent[1]!.options.deliverAs, "steer");
});

test("what the user said to a child directly is recorded without waking main", () => {
	const { box, sent } = mail();
	box.deliver({ kind: "relay", from: "user", to: "scout", text: "stop after the tests", answered: false });
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.options.triggerTurn, false);
	assert.equal(sent[0]!.message.content, "The user messaged scout directly:\nstop after the tests");
});

test("everything stays pending until Pi appends it", () => {
	const { box, sent } = mail();
	box.deliver({ kind: "note", from: "scout", text: "one" });
	assert.equal(box.pending().length, 1);
	box.acknowledge(sent[0]!.message.details.id);
	assert.equal(box.pending().length, 0);
});

test("nothing is sent or scheduled after dispose", async () => {
	const { box, sent } = mail(5);
	box.dispose();
	box.deliver({ kind: "report", record: record("late") });
	box.deliver({ kind: "note", from: "late", text: "hi" });
	await sleep(20);
	assert.equal(sent.length, 0);
	assert.equal(box.pending().length, 0);
});

test("messages Pi appended silently are found in the transcript", () => {
	const { box, sent } = mail();
	box.deliver({ kind: "note", from: "scout", text: "one" });
	box.deliver({ kind: "note", from: "scout", text: "two" });
	const [first] = sent.map((s) => s.message);
	box.reconcile([{ type: "message" }, { type: "custom_message", customType: first!.customType, details: first!.details }]);
	assert.deepEqual(box.pending().map((item) => item.text), ["two"]);
});

test("reports close together become one message and one turn", async () => {
	const { box, sent } = mail(20);
	box.deliver({ kind: "report", record: record("alpha") });
	box.deliver({ kind: "report", record: record("beta") });
	assert.equal(sent.length, 0);
	assert.deepEqual(box.pending().map((item) => item.from), ["alpha", "beta"]);
	await sleep(40);
	assert.equal(sent.length, 1);
	const [{ message, options }] = sent;
	assert.equal(message.customType, REPORT_TYPE);
	assert.equal(options.triggerTurn, true);
	assert.match(message.content, /^alpha \(openai-codex\/gpt-6-luna, \$0\.0042\) finished after 1m05s\. Message it to follow up[\s\S]*alpha says done\n\n---\n\nbeta/);
	assert.deepEqual(box.pending().map((item) => item.from), ["alpha, beta"]);
	box.dispose();
});

test("a report waits for the rest of its group, then all arrive as one message", async () => {
	const sent: OutgoingMessage[] = [];
	let busy = new Set(["beta"]);
	const box = new MainMail({
		port: { send: (message) => sent.push(message) }, batchMs: 5, groupWaitMs: 1_000,
		groupBusy: (_group, except) => [...busy].some((name) => name !== except),
	});
	box.deliver({ kind: "report", record: record("alpha", { group: "turn-1" }) });
	await sleep(20);
	assert.equal(sent.length, 0);
	busy = new Set();
	box.deliver({ kind: "report", record: record("beta", { group: "turn-1" }) });
	await sleep(20);
	assert.equal(sent.length, 1);
	assert.match(sent[0]!.content, /^alpha[\s\S]*---[\s\S]*beta/);
	box.dispose();
});

test("a held report is released after groupWaitMs even if the group is still busy", async () => {
	const sent: OutgoingMessage[] = [];
	const box = new MainMail({ port: { send: (message) => sent.push(message) }, batchMs: 5, groupWaitMs: 30, groupBusy: () => true });
	box.deliver({ kind: "report", record: record("alpha", { group: "turn-1" }) });
	await sleep(15);
	assert.equal(sent.length, 0);
	await sleep(40);
	assert.equal(sent.length, 1);
	box.dispose();
});

test("a report of a child the user stopped does not wake main", async () => {
	const { box, sent } = mail(5);
	box.deliver({ kind: "report", record: record("gamma", { state: "stopped" }) });
	await sleep(20);
	assert.equal(sent[0]!.options.triggerTurn, false);
	assert.match(sent[0]!.message.content, /gamma .* was stopped after/);
});

test("a report whose run already answered main shows its counters without waking main", async () => {
	const { box, sent } = mail(5);
	const usage = { input: 1_200, output: 300, cacheRead: 40_000, cacheWrite: 500, cost: 0.0042 };
	box.deliver({ kind: "report", record: record("reader", { answeredMain: true, usage }) });
	await sleep(20);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.message.customType, REPORT_TYPE);
	assert.equal(sent[0]!.options.triggerTurn, false);
	// Main already has the answer, but the user still sees what the run took.
	assert.equal(sent[0]!.message.display, true);
	const summary = (sent[0]!.message.details as { reports: ReportSummary[] }).reports[0]!;
	assert.equal(summary.answered, true);
	assert.deepEqual(summary.tokens, { input: 41_700, output: 300 });
});

test("an ordinary report summary carries tokens but is not marked answered", async () => {
	const { box, sent } = mail(5);
	box.deliver({ kind: "report", record: record("scout", { usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0 } }) });
	box.deliver({ kind: "report", record: record("idle-cost") });
	await sleep(20);
	const [scout, empty] = (sent[0]!.message.details as { reports: ReportSummary[] }).reports;
	assert.equal(scout!.answered, undefined);
	assert.deepEqual(scout!.tokens, { input: 10, output: 20 });
	assert.equal(empty!.tokens, undefined, "no tokens recorded, nothing to show");
});

function routed(start: Route, retryMs?: number) {
	let route = start;
	const sent: Array<{ message: OutgoingMessage; options: { triggerTurn: boolean; deliverAs?: string } }> = [];
	const box = new MainMail({ port: { send: (message, options) => sent.push({ message, options }) }, batchMs: 5, now: () => 70_000, route: () => route, ...(retryMs ? { retryMs } : {}) });
	return { box, sent, set: (next: Route) => { route = next; } };
}

const custom = (id: string) => ({ role: "custom", customType: MESSAGE_TYPE, details: { id } });
const user = { role: "user" };
const reply = { role: "assistant" };

test("while main compacts, mail waits, still shown as pending, and goes out in order once main can take it", () => {
	const { box, sent, set } = routed("hold");
	box.deliver({ kind: "note", from: "scout", text: "one" });
	box.deliver({ kind: "relay", from: "user", to: "scout", text: "two", answered: false });
	box.deliver({ kind: "question", from: "worker", text: "three?" });
	// Waking main now would start a turn on the context being summarized.
	assert.equal(sent.length, 0);
	assert.equal(box.pending().length, 3);
	box.retry();
	assert.equal(sent.length, 0, "still compacting");
	set("wake");
	box.retry();
	// In Pi the first one starts a run, so what follows goes as "queue"; the route is held fixed here to check the order.
	assert.deepEqual(sent.map((s) => [(s.message.details as { text: string }).text, s.options.triggerTurn]), [["one", true], ["two", false], ["three?", true]]);
});

test("held mail goes out on its own, in order, once main can take it", async () => {
	const { box, sent, set } = routed("hold", 5);
	box.deliver({ kind: "note", from: "scout", text: "first" });
	box.deliver({ kind: "note", from: "scout", text: "second" });
	set("wake");
	assert.equal(sent.length, 0, "nothing told it yet");
	await sleep(25);
	assert.deepEqual(sent.map((s) => (s.message.details as { text: string }).text), ["first", "second"]);
});

test("while main works, mail lands at its next turn boundary instead of the queue Esc clears, and main owes it a reply", () => {
	const { box, sent } = routed("queue");
	box.deliver({ kind: "note", from: "scout", text: "found it" });
	assert.deepEqual(sent[0]!.options, { triggerTurn: false });
	const id = sent[0]!.message.details.id;
	assert.equal(box.owed({ contextMessages: [user, reply], pendingMessages: [custom(id)] }), true, "not in the transcript yet");
	assert.equal(box.owed({ contextMessages: [user, reply, custom(id)], pendingMessages: [] }), true, "landed after main's last reply");
	assert.equal(box.owed({ contextMessages: [user, custom(id), reply], pendingMessages: [] }), false, "main has replied since");
	assert.equal(box.owed({ contextMessages: [user, reply, custom(id)], pendingMessages: [] }), false, "once read, it stays read");
});

test("mail main need not answer is never owed, and mail compacted away stops being owed rather than looping", async () => {
	const { box, sent } = routed("queue");
	box.deliver({ kind: "relay", from: "user", to: "scout", text: "fyi", answered: false });
	box.deliver({ kind: "report", record: record("halted", { state: "stopped" }) });
	await sleep(20);
	assert.deepEqual(sent.map((s) => s.options.triggerTurn), [false, false]);
	const ids = sent.map((s) => s.message.details.id);
	assert.equal(box.owed({ contextMessages: [user, reply, ...ids.map(custom)], pendingMessages: [] }), false);
	box.deliver({ kind: "note", from: "scout", text: "gone" });
	assert.equal(box.owed({ contextMessages: [user, reply], pendingMessages: [] }), false);
});

test("a report that wakes main is owed a reply when it lands mid-run", async () => {
	const { box, sent } = routed("queue");
	box.deliver({ kind: "report", record: record("scout") });
	await sleep(20);
	assert.deepEqual(sent[0]!.options, { triggerTurn: false });
	const landed = { role: "custom", customType: REPORT_TYPE, details: { id: sent[0]!.message.details.id } };
	assert.equal(box.owed({ contextMessages: [user, reply, landed], pendingMessages: [] }), true);
});

test("held mail is dropped with the session", async () => {
	const { box, sent, set } = routed("hold", 5);
	box.deliver({ kind: "note", from: "scout", text: "late" });
	box.dispose();
	set("wake");
	await sleep(20);
	assert.equal(sent.length, 0);
});

test("after a /compact stops main, a hidden reminder wakes it for mail it hadn't replied to", () => {
	const { box, sent, set } = routed("queue");
	box.deliver({ kind: "note", from: "scout", text: "found it" });
	box.deliver({ kind: "question", from: "worker", text: "delete it?" });
	box.deliver({ kind: "relay", from: "user", to: "scout", text: "fyi", answered: false });
	set("wake");
	box.remind();
	const reminder = sent.at(-1)!;
	assert.equal(sent.length, 4);
	assert.deepEqual(reminder.options, { triggerTurn: true, deliverAs: "steer" });
	// Main reads it; the user already sees the mail it points at.
	assert.equal(reminder.message.display, false);
	assert.match(reminder.message.content, /scout, worker/);
	assert.doesNotMatch(reminder.message.content, /user/, "a relay asked for no reply");
	assert.equal(box.pending().length, 3, "the reminder is not mail waiting to land");
	box.remind();
	assert.equal(sent.length, 4, "one reminder for the same mail");
});

test("with nothing owed there is no reminder", () => {
	const { box, sent } = routed("wake");
	box.deliver({ kind: "note", from: "scout", text: "read at once" });
	box.remind();
	assert.equal(sent.length, 1);
});

test("mail main has replied after, as a turn ends, is no longer owed, so a reminder never names it", () => {
	const { box, sent, set } = routed("queue");
	box.deliver({ kind: "note", from: "scout", text: "handled" });
	box.deliver({ kind: "note", from: "worker", text: "not yet" });
	const [handled, pending] = sent.map((s) => s.message.details.id);
	const landed = (id: string) => ({ type: "custom_message", customType: MESSAGE_TYPE, details: { id } });
	const replied = (stopReason: string) => ({ type: "message", message: { role: "assistant", stopReason } });
	box.answered([landed(handled!), replied("toolUse"), landed(pending!), replied("aborted")]);
	set("wake");
	box.remind();
	assert.match(sent.at(-1)!.message.content, /before you replied to worker\./, "an aborted reply is no reply");
	assert.doesNotMatch(sent.at(-1)!.message.content, /scout/);
});
