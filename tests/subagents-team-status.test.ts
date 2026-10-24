/** What main reads about the rest of its team where it already looks: its mail and its own tool results. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { MainMail, type OutgoingMessage, type Route } from "../lib/subagents/deliver.ts";
import { agentStatus, shortTime, stillWorking, teamNow } from "../lib/subagents/status.ts";
import { mainMessageTool, stopTool } from "../lib/subagents/tools.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";
import { teamHarness } from "./support/team-harness.ts";

const NOW = 10_000_000;

function record(name: string, extra: Partial<AgentRecord> = {}): AgentRecord {
	return {
		name, parent: "main", depth: 1, task: "t", model: "m", readOnly: false, fork: false, blocking: false,
		state: "running", createdAt: 0, startedAt: NOW - 37 * 60_000, activity: "thinking", toolCalls: 3, usage: { ...NO_USAGE, cost: 17.2 }, runs: 1, ...extra,
	};
}

test("one agent reads as its name, what it waits on, and its current run's time and cost", () => {
	const impl = record("impl");
	const get = (name: string) => (name === "impl" ? impl : undefined);
	assert.equal(agentStatus(impl, get, NOW), "impl 37m $17.20");
	assert.equal(agentStatus(record("again", { runs: 2, runCost: 15, startedAt: NOW - 4 * 60_000 }), get, NOW), "again 4m $2.20", "the cost of this run only");
	assert.equal(agentStatus(record("review", { state: "queued", after: ["impl"], runs: 0, usage: NO_USAGE }), get, NOW), "review queued after impl");
	assert.equal(agentStatus(record("next", { state: "queued", runs: 0, usage: NO_USAGE }), get, NOW), "next queued");
	assert.equal(agentStatus(record("asker", { state: "asking", askingWho: "main", startedAt: NOW - 45_000, usage: NO_USAGE }), get, NOW), "asker waiting on main 45s");
	assert.equal(agentStatus(record("lead", { state: "waiting", owed: ["peer"] }), get, NOW), "lead waiting on peer 37m $17.20");
	assert.equal(agentStatus(record("lead", { state: "waiting" }), get, NOW), "lead waiting on its subagents 37m $17.20");
	assert.equal(agentStatus(record("tester", { activity: "check: npm test" }), get, NOW), "tester checking 37m $17.20");
	assert.equal(agentStatus(record("paused", { state: "interrupted" }), get, NOW), "paused interrupted");
	assert.deepEqual([shortTime(59_000), shortTime(60_000), shortTime(3_900_000)], ["59s", "1m", "1h05m"]);
});

test("a working agent shows its context size; one that ended or has no reading yet does not", () => {
	const get = () => undefined;
	assert.equal(agentStatus(record("impl", { contextTokens: 84_200 }), get, NOW), "impl 37m $17.20 ctx 84k");
	assert.equal(agentStatus(record("lead", { state: "waiting", contextTokens: 9_400 }), get, NOW), "lead waiting on its subagents 37m $17.20 ctx 9.4k");
	assert.equal(agentStatus(record("fresh"), get, NOW), "fresh 37m $17.20");
	assert.equal(teamNow([record("impl", { contextTokens: 140_000 }), record("done", { state: "idle", contextTokens: 200_000 })], NOW), "Team now: impl 37m $17.20 ctx 140k; 1 ended.");
});

test("the still-working line names the other live agents, capped, and is absent when none is live", () => {
	const records = [record("impl"), record("review", { startedAt: NOW - 4 * 60_000, usage: { ...NO_USAGE, cost: 1.85 } }), record("done", { state: "idle" })];
	assert.equal(stillWorking(records, ["done"], NOW), "Still working: impl 37m $17.20, review 4m $1.85");
	assert.equal(stillWorking(records, ["impl", "review"], NOW), undefined);
	const many = Array.from({ length: 11 }, (_, i) => record(`a${i}`, { usage: NO_USAGE, startedAt: NOW }));
	assert.equal(stillWorking(many, [], NOW), "Still working: a0 0s, a1 0s, a2 0s, a3 0s, a4 0s, a5 0s, a6 0s, a7 0s, +3 more");
});

test("main's roster lists live and interrupted agents and only counts the ended ones", () => {
	const records = [record("impl"), record("paused", { state: "interrupted" }), record("a", { state: "idle" }), record("b", { state: "failed" })];
	assert.equal(teamNow(records, NOW), "Team now: impl 37m $17.20, paused interrupted; 2 ended.");
	assert.equal(teamNow([record("a", { state: "idle" })], NOW), "Team now: no agent is working; 1 ended.");
	assert.equal(teamNow([], NOW), "Team now: no agents.");
});

function mailTo(records: () => AgentRecord[], route: () => Route = () => "wake") {
	const sent: Array<{ message: OutgoingMessage; triggerTurn: boolean }> = [];
	const box = new MainMail({
		port: { send: (message, options) => sent.push({ message, triggerTurn: options.triggerTurn }) },
		batchMs: 5, now: () => NOW, route, retryMs: 5,
		status: (except) => stillWorking(records(), except, NOW),
	});
	return { box, sent };
}

test("each delivery to main ends with one status line, computed when it is sent, not when it was queued", async () => {
	let records = [record("impl"), record("scout", { usage: NO_USAGE, startedAt: NOW - 60_000 })];
	let where: Route = "hold";
	const { box, sent } = mailTo(() => records, () => where);
	box.deliver({ kind: "note", from: "scout", text: "found it" });
	assert.equal(sent.length, 0, "held while main compacts");
	records = [record("impl"), record("scout", { state: "idle" }), record("review", { state: "queued", runs: 0, after: ["impl"], usage: NO_USAGE })];
	where = "wake";
	box.retry();
	assert.equal(sent[0]!.message.content, "Message from scout:\nfound it\n\nStill working: impl 37m $17.20, review queued after impl");
	box.deliver({ kind: "report", record: record("impl", { state: "idle", report: "done" }) });
	box.deliver({ kind: "report", record: record("review", { state: "idle", report: "ok" }) });
	await sleep(20);
	const batched = sent.at(-1)!.message;
	assert.equal(batched.details.kind, "report");
	assert.equal((batched.content.match(/Still working/g) ?? []).length, 0, "the two it reports are the only live ones besides scout, which ended");
	records = [record("impl", { state: "idle" }), record("other")];
	box.deliver({ kind: "relay", from: "user", to: "impl", text: "thanks", answered: false });
	assert.match(sent.at(-1)!.message.content, /\n\nStill working: other 37m \$17\.20$/);
	box.dispose();
});

test("a report batch counts once, and mail taken for a headless boundary gets the line too", async () => {
	const records = [record("a", { state: "idle" }), record("b", { state: "idle" }), record("c")];
	const { box, sent } = mailTo(() => records);
	box.deliver({ kind: "report", record: records[0]! });
	box.deliver({ kind: "report", record: records[1]! });
	await sleep(20);
	assert.equal(sent.length, 1);
	assert.equal((sent[0]!.message.content.match(/Still working: c 37m \$17\.20/g) ?? []).length, 1);
	const held = mailTo(() => records, () => "hold");
	held.box.deliver({ kind: "note", from: "a", text: "late" });
	const { messages } = held.box.takeAll();
	assert.match(messages[0]!.content, /late\n\nStill working: c 37m \$17\.20$/);
	box.dispose();
	held.box.dispose();
});

test("main's message and stop results end with its roster; a child's do not change", async () => {
	const h = teamHarness();
	const luna = { ref: "openai-codex/gpt-6-luna", model: { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" } };
	const tc = { team: h.team, allowed: [luna as never], fallbackModel: luna.ref, thinking: {}, modelTable: "", guide: "", replyTimeoutMs: 60_000, now: Date.now };
	const impl = h.spawn("impl", { name: "impl" });
	const review = h.spawn("review", { name: "review", after: [impl] });
	const old = h.spawn("old", { name: "old" });
	await tick();
	h.lastCall(old).finish("Done.");
	await tick(); await tick();
	const sent = await (mainMessageTool(tc).execute as any)("id", { to: impl, text: "Hurry." }, undefined, undefined);
	assert.match(sent.content[0].text, /^Delivered; it reads it after its current tool call\.\n\nTeam now: impl 0s, review queued after impl; 1 ended\.$/);
	const stopped = await (stopTool(tc, "main").execute as any)("id", { name: review }, undefined, undefined);
	assert.match(stopped.content[0].text, /\n\nTeam now: impl 0s; 2 ended\.$/);
	const all = await (stopTool(tc, "main").execute as any)("id", { name: "all" }, undefined, undefined);
	assert.match(all.content[0].text, /\n\nTeam now: no agent is working; 3 ended\.$/);
	await h.team.close();
});
