import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { MainMail, MESSAGE_TYPE, REPORT_TYPE, type OutgoingMessage } from "../lib/subagents/deliver.ts";
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

test("notes never wake main; questions and replies do", () => {
	const { box, sent } = mail();
	box.deliver({ kind: "note", from: "scout", text: "found it" });
	box.deliver({ kind: "question", from: "worker", text: "delete it?" });
	box.deliver({ kind: "reply", from: "scout", text: "lib/a.ts" });
	assert.deepEqual(sent.map((s) => [s.message.customType, s.options.triggerTurn]), [[MESSAGE_TYPE, false], [MESSAGE_TYPE, true], [MESSAGE_TYPE, true]]);
	assert.equal(sent[0]!.message.content, "Message from scout:\nfound it");
	assert.match(sent[1]!.message.content, /^Question from worker, who is waiting for your reply \(answer with message\(\{ to: "worker", text \}\)\):\ndelete it\?$/);
	assert.equal(sent[2]!.message.content, "Answer from scout:\nlib/a.ts");
	assert.equal(sent[1]!.options.deliverAs, "steer");
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
