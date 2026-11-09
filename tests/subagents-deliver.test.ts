import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { MainMail } from "../lib/subagents/deliver.ts";
import { MESSAGE_TYPE, REPORT_TYPE, type OutgoingMessage, type ReportSummary, type Route } from "../lib/subagents/contract.ts";
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

test("a next-turn reminder starts no turn, waits in Pi for main's next one, and is owed once that turn starts with it", () => {
	const { box, sent, set } = routed("queue");
	box.deliver({ kind: "note", from: "scout", text: "found it" });
	// It landed while main worked, then a /compact stopped main before it replied.
	box.acknowledge(sent[0]!.message.details.id);
	assert.equal(box.idle(), false, "main owes the note a reply");
	set("wake");
	box.remind({ nextTurn: true });
	const reminder = sent.at(-1)!;
	assert.equal(sent.length, 2);
	assert.deepEqual(reminder.options, { triggerTurn: false, deliverAs: "nextTurn" }, "Esc during the summary starts no turn (owner answer 846)");
	assert.match(reminder.message.content, /scout/);
	assert.equal(box.idle(), true, "no turn has started with it yet, so nothing keeps main from settling");
	box.remind({ nextTurn: true });
	assert.equal(sent.length, 2, "one reminder for the same mail");
	// message_end: the user's next message started a turn, and the reminder went in with it.
	box.acknowledge(reminder.message.details.id);
	assert.equal(box.idle(), false, "main owes the reminder a reply in that turn");
});

test("with nothing owed there is no reminder", () => {
	const { box, sent } = routed("wake");
	box.deliver({ kind: "note", from: "scout", text: "read at once" });
	box.remind();
	assert.equal(sent.length, 1);
});

test("mail that starts main's turn is owed once it lands, so a /compact that stops that turn reminds main of it", () => {
	const { box, sent } = routed("wake");
	box.deliver({ kind: "note", from: "scout", text: "found it" });
	const id = sent[0]!.message.details.id;
	assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: "steer" });
	box.remind();
	assert.equal(sent.length, 1, "not owed while Pi may still hold it");
	assert.equal(box.owed({ contextMessages: [], pendingMessages: [] }), false, "a turn Pi never starts can't keep main from settling");
	// message_end: the note went into main's context as its turn's starting message.
	box.acknowledge(id);
	assert.equal(box.idle(), false, "main owes the note a reply");
	box.remind();
	assert.equal(sent.length, 2);
	assert.match(sent[1]!.message.content, /scout/);
});

test("mail that lands without a turn, or whose wake send failed, is not owed for starting one", () => {
	const { box, sent } = routed("wake");
	box.deliver({ kind: "relay", from: "user", to: "scout", text: "fyi", answered: false });
	box.acknowledge(sent[0]!.message.details.id);
	assert.equal(box.idle(), true, "a relay asks for no reply");
	let fail = true;
	const tried: OutgoingMessage[] = [];
	const failing = new MainMail({ batchMs: 5, route: () => "wake", retryMs: 1_000_000,
		port: { send: (message) => { tried.push(message); if (fail) throw new Error("This session's subagents are closed."); } } });
	failing.deliver({ kind: "note", from: "scout", text: "found it" });
	const id = tried[0]!.details.id;
	fail = false;
	// A message_end for that id, say from a host that resent it, makes this mail owe nothing.
	failing.acknowledge(id);
	failing.remind();
	assert.equal(tried.length, 1, "no reminder for mail whose send failed");
	failing.dispose();
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

test("main's reply to mail it owed is a change, however it is seen, so a host waiting for quiet looks again", () => {
	let route: Route = "queue";
	let changes = 0;
	const sent: OutgoingMessage[] = [];
	const box = new MainMail({ port: { send: (message) => sent.push(message) }, batchMs: 5, route: () => route, onChange: () => { changes++; } });
	const owe = (text: string) => {
		box.deliver({ kind: "note", from: "scout", text });
		const { id } = sent.at(-1)!.details;
		box.acknowledge(id);
		return id;
	};
	const settled = () => { const before = changes; return () => changes - before; };
	const viaContext = owe("one");
	let count = settled();
	assert.equal(box.owed({ contextMessages: [user, custom(viaContext), reply], pendingMessages: [] }), false);
	assert.equal(count(), 1, "the context shows main replied");
	assert.equal(box.idle(), true);
	const viaBranch = owe("two");
	count = settled();
	box.answered([{ type: "custom_message", customType: MESSAGE_TYPE, details: { id: viaBranch } }, { type: "message", message: { role: "assistant", stopReason: "stop" } }]);
	assert.equal(count(), 1, "the branch shows main replied");
	owe("three");
	route = "wake";
	count = settled();
	box.remind();
	assert.equal(count(), 1, "a reminder settles what main owed");
	count = settled();
	box.answered([]);
	assert.equal(box.owed({ contextMessages: [], pendingMessages: [] }), false);
	assert.equal(count(), 0, "nothing owed, nothing changed");
});

test("mail that leaves the outbox on a retry tells the listener, so a quiet takeover sees the mail idle", () => {
	let route: Route = "queue";
	let changes = 0;
	const sent: string[] = [];
	const mail = new MainMail({ batchMs: 5, route: () => route, onChange: () => { changes++; }, retryMs: 1_000_000,
		port: { send: (message) => sent.push(message.details.kind) } });
	mail.deliver({ kind: "note", from: "lead", text: "FYI" });
	mail.acknowledge(mail.pending()[0]!.id);
	route = "hold";
	mail.remind();
	assert.equal(mail.idle(), false, "the reminder waits in the outbox");
	const before = changes;
	route = "wake";
	mail.retry();
	assert.deepEqual(sent, ["note", "reminder"]);
	assert.equal(mail.idle(), true);
	assert.ok(changes > before);
	mail.dispose();
});

test("a send that fails keeps the mail to main and tries it again", () => {
	let fail = true;
	const sent: Array<{ message: OutgoingMessage; options: { triggerTurn: boolean; deliverAs?: string } }> = [];
	const box = new MainMail({ batchMs: 5, route: () => "queue", retryMs: 1_000_000,
		port: { send: (message, options) => { if (fail) throw new Error("This session's subagents are closed."); sent.push({ message, options }); } } });
	box.deliver({ kind: "note", from: "scout", text: "found it" });
	assert.equal(sent.length, 0, "the send failed");
	// The mail is not lost: it stays queued, so a reload can hand it over again.
	assert.deepEqual(box.pending().map((item) => item.text), ["found it"]);
	assert.equal(box.waiting(), true, "the note still waits to reach main");
	assert.equal(box.idle(), false);
	// Main never saw it, so it owes no reply and no reminder names it.
	box.remind();
	assert.equal(sent.length, 0, "no reminder for mail that never landed");
	fail = false;
	box.retry();
	assert.equal(sent.length, 1, "the same mail goes once, not twice");
	assert.equal(sent[0]!.message.content, "Message from scout:\nfound it");
	assert.deepEqual(sent[0]!.options, { triggerTurn: false });
	assert.deepEqual(box.pending().map((item) => item.text), ["found it"], "still pending until Pi appends it");
	box.dispose();
});

test("a failed send is tried again on the retry timer", async () => {
	let fail = true;
	const sent: OutgoingMessage[] = [];
	const box = new MainMail({ batchMs: 5, route: () => "queue", retryMs: 5,
		port: { send: (message) => { if (fail) throw new Error("This session's subagents are closed."); sent.push(message); } } });
	box.deliver({ kind: "note", from: "scout", text: "found it" });
	fail = false;
	await sleep(30);
	assert.deepEqual(sent.map((message) => message.content), ["Message from scout:\nfound it"]);
	assert.equal(box.waiting(), false);
	box.dispose();
});
