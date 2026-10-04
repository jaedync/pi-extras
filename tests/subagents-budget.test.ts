import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { Team, type TeamOptions } from "../lib/subagents/team.ts";
import { reportText } from "../lib/subagents/format.ts";
import type { AgentRecord, ChildHandle, ChildHooks, MainDelivery, SpawnRequest, Usage } from "../lib/subagents/types.ts";

/** A budget of this many minutes runs out in about 60 ms. */
const SHORT = 0.001;
const usage = (cost: number): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost });

/** Children that work until stopped; the test drives their usage and transcript. */
function harness(options: Partial<TeamOptions> = {}) {
	const hooks = new Map<string, ChildHooks>();
	const prompts = new Map<string, string[]>();
	const finishes = new Map<string, () => void>();
	const transcripts = new Map<string, unknown[]>();
	const aborted: string[] = [];
	const main: MainDelivery[] = [];
	const team = new Team({
		maxConcurrent: 4, maxDepth: 3, replyTimeoutMs: 60_000,
		deliverToMain: (delivery) => main.push(delivery),
		launcher: {
			async launch(record: AgentRecord, hook: ChildHooks): Promise<ChildHandle> {
				hooks.set(record.name, hook);
				const transcript = transcripts.get(record.name) ?? [];
				transcripts.set(record.name, transcript);
				return {
					prompt: (text) => {
						prompts.set(record.name, [...(prompts.get(record.name) ?? []), text]);
						return new Promise<void>((resolve) => finishes.set(record.name, resolve));
					},
					steer: () => undefined,
					abort: async () => { aborted.push(record.name); },
					lastText: () => undefined,
					messages: () => transcript,
					takeQueued: () => [],
					dispose: async () => undefined,
				};
			},
		},
		...options,
	});
	const spawn = (name: string, extra: Partial<SpawnRequest> = {}) => {
		const result = team.spawn({ name, task: `Task for ${name}`, parent: "main", model: "test/model", readOnly: true, fork: false, blocking: false, ...extra });
		assert.ok(result.ok, !result.ok ? result.error : "");
		return result.record.name;
	};
	const say = (name: string, text: string) => transcripts.get(name)!.push({ role: "assistant", content: [{ type: "text", text }] });
	const finish = (name: string) => finishes.get(name)!();
	return { team, hooks, prompts, aborted, main, spawn, say, finish };
}

test("a run over its time budget is stopped, and main gets a report that says why", async () => {
	const h = harness();
	const name = h.spawn("slow", { maxMinutes: SHORT });
	await tick(); await tick();
	h.say(name, "Halfway through the survey.");
	await sleep(150);
	const record = h.team.get(name)!;
	assert.equal(record.state, "stopped");
	assert.equal(record.stopReason, `over its ${SHORT}-minute budget`);
	assert.deepEqual(h.aborted, [name]);
	const reports = h.main.filter((delivery) => delivery.kind === "report");
	assert.equal(reports.length, 1, "not silent: its parent did not ask for the stop");
	const text = reportText(record, Date.now());
	assert.match(text, /slow \(test\/model\) was stopped after \d+s: over its 0\.001-minute budget\./);
	assert.match(text, /Last message before it stopped:\nHalfway through the survey\./);
});

test("time spent asking does not count against the budget", async () => {
	const h = harness();
	const name = h.spawn("asker", { maxMinutes: SHORT });
	await tick(); await tick();
	const asked = h.team.send(name, "main", "Which branch?", { expectReply: true });
	await sleep(150);
	assert.equal(h.team.get(name)?.state, "asking", "blocked on main, so its clock is paused");
	await h.team.send("main", name, "main");
	assert.ok((await asked).ok);
	assert.equal(h.team.get(name)?.state, "running");
	await sleep(150);
	assert.equal(h.team.get(name)?.state, "stopped", "the clock runs again once it works");
});

test("a run over its cost budget is stopped; cost counts this run only", async () => {
	const h = harness();
	const name = h.spawn("spender", { maxCost: 0.5 });
	await tick(); await tick();
	h.hooks.get(name)!.update({ usage: usage(0.4) });
	assert.equal(h.team.get(name)?.state, "running");
	h.hooks.get(name)!.update({ usage: usage(0.6) });
	assert.equal(h.team.get(name)?.state, "stopped");
	assert.equal(h.team.get(name)?.stopReason, "over its $0.50 cost budget");
	assert.ok((await h.team.send("main", name, "Continue, but cheaply.")).ok);
	await tick(); await tick();
	assert.equal(h.team.get(name)?.state, "running");
	assert.equal(h.team.get(name)?.maxCost, 0.5, "a resumed run keeps the same limits");
	assert.equal(h.team.get(name)?.stopReason, undefined, "the new run has not been stopped");
	assert.match(h.prompts.get(name)!.at(-1)!, /Your previous run was stopped over its \$0\.50 cost budget\. This run has a fresh budget\./);
	h.hooks.get(name)!.update({ usage: usage(0.9) });
	assert.equal(h.team.get(name)?.state, "running", "0.30 spent in this run");
	h.hooks.get(name)!.update({ usage: usage(1.1) });
	assert.equal(h.team.get(name)?.state, "stopped");
	await h.team.close();
});

test("a resumed run gets a fresh time budget", async () => {
	const h = harness();
	const name = h.spawn("again", { maxMinutes: SHORT });
	await sleep(150);
	assert.equal(h.team.get(name)?.state, "stopped");
	assert.ok((await h.team.send("main", name, "Continue.")).ok);
	await tick(); await tick();
	assert.equal(h.team.get(name)?.state, "running");
	await sleep(150);
	assert.equal(h.team.get(name)?.state, "stopped");
	assert.equal(h.main.filter((delivery) => delivery.kind === "report").length, 2);
});

test("over budget stops its subagents silently and wakes its own parent with the report", async () => {
	const h = harness();
	const lead = h.spawn("lead");
	await tick(); await tick();
	const helper = h.spawn("helper", { parent: lead, maxMinutes: SHORT });
	await tick(); await tick();
	const nested = h.spawn("nested", { parent: helper });
	await tick(); await tick();
	h.say(helper, "Found two of three.");
	await sleep(150);
	assert.equal(h.team.get(helper)?.state, "stopped");
	assert.equal(h.team.get(nested)?.state, "stopped");
	assert.equal(h.team.get(nested)?.stopReason, undefined, "stopped by its parent, not by its own budget");
	assert.equal(h.team.get(lead)?.state, "running", "its parent was working and stays on it");
	assert.deepEqual(h.main, [], "the report goes to its parent, not main");
	await h.team.close();
});

test("a parent waiting on its subagents is woken by one's over-budget report", async () => {
	const h = harness();
	const lead = h.spawn("lead");
	await tick(); await tick();
	const helper = h.spawn("helper", { parent: lead, maxMinutes: SHORT });
	await tick(); await tick();
	h.finish(lead);
	await tick();
	assert.equal(h.team.get(lead)?.state, "waiting");
	await sleep(150);
	assert.equal(h.team.get(helper)?.state, "stopped");
	assert.equal(h.team.get(lead)?.state, "running", "the report resumes it");
	assert.match(h.prompts.get(lead)!.at(-1)!, /helper \(test\/model\) was stopped after \d+s: over its 0\.001-minute budget\./);
	await h.team.close();
});

test("the configured budget applies when the call names none, and is kept on the record", async () => {
	const h = harness({ runBudget: { minutes: 30, cost: 2 } });
	const name = h.spawn("defaults");
	assert.equal(h.team.get(name)?.maxMinutes, 30);
	assert.equal(h.team.get(name)?.maxCost, 2);
	const own = h.spawn("own", { maxMinutes: 5, maxCost: 0.25 });
	assert.equal(h.team.get(own)?.maxMinutes, 5);
	assert.equal(h.team.get(own)?.maxCost, 0.25);
	for (const bad of [{ maxMinutes: 0 }, { maxMinutes: -1 }, { maxCost: 0 }, { maxMinutes: Number.NaN }, { maxMinutes: 100_000 }]) {
		const result = h.team.spawn({ task: "Bad budget", parent: "main", model: "test/model", readOnly: true, fork: false, blocking: false, ...bad });
		assert.equal(result.ok, false, JSON.stringify(bad));
		assert.match(!result.ok ? result.error : "", /maxMinutes|maxCost/);
	}
	await h.team.close();
});

test("without a configured budget, a run has no limit", async () => {
	const h = harness();
	const name = h.spawn("free");
	assert.equal(h.team.get(name)?.maxMinutes, undefined);
	assert.equal(h.team.get(name)?.maxCost, undefined);
	await h.team.close();
});

test("a budget stop wakes main, where a stop the user asked for does not", async () => {
	const { MainMail } = await import("../lib/subagents/deliver.ts");
	const sent: Array<{ triggerTurn: boolean; content: string; stopReason?: string }> = [];
	const box = new MainMail({ port: { send: (message, options) => sent.push({ triggerTurn: options.triggerTurn, content: message.content,
		stopReason: (message.details as { reports?: Array<{ stopReason?: string }> }).reports?.[0]?.stopReason }) }, batchMs: 1 });
	const base: AgentRecord = { name: "slow", parent: "main", depth: 1, task: "t", model: "test/model", readOnly: false, fork: false, blocking: false,
		state: "stopped", createdAt: 0, startedAt: 0, endedAt: 3_600_000, activity: null, toolCalls: 0, usage: usage(0), runs: 1 };
	box.deliver({ kind: "report", record: { ...base, stopReason: "over its 60-minute budget" } });
	await sleep(10);
	box.deliver({ kind: "report", record: base });
	await sleep(10);
	assert.deepEqual(sent.map((item) => item.triggerTurn), [true, false]);
	assert.match(sent[0]!.content, /slow \(test\/model\) was stopped after 1h.*: over its 60-minute budget\./);
	assert.equal(sent[0]!.stopReason, "over its 60-minute budget");
	box.dispose();
});

test("a budget stop reads back as a stopped report with its reason", async () => {
	const { readEnvelopes } = await import("../lib/subagents/format.ts");
	const record: AgentRecord = { name: "slow", parent: "lead", depth: 2, task: "t", model: "test/model", readOnly: false, fork: false, blocking: false,
		state: "stopped", createdAt: 0, startedAt: 0, endedAt: 16_000, activity: null, toolCalls: 0, usage: usage(0), runs: 1,
		stopReason: "over its 60-minute budget", report: "half done" };
	assert.deepEqual(readEnvelopes(reportText(record, 0)),
		[{ kind: "report", from: "slow", model: "test/model", state: "stopped", took: "16s", text: "over its 60-minute budget\n\nhalf done" }]);
});

test("budgets and stop reasons persist in the index, and old records without them still load", async (t) => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { ChildIndex } = await import("../lib/subagents/restore.ts");
	const dir = mkdtempSync(join(tmpdir(), "subagent-budget-index-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const index = new ChildIndex(dir, "parent", "/parent");
	const warn = (message: string) => assert.fail(message);
	const base: AgentRecord = { name: "slow", parent: "main", depth: 1, task: "t", model: "test/model", readOnly: false, fork: false, blocking: false,
		state: "stopped", createdAt: 0, activity: null, toolCalls: 0, usage: usage(0), runs: 1 };
	index.save([{ ...base, maxMinutes: 30, maxCost: 1.5, stopReason: "over its 30-minute budget" }]);
	const [loaded] = new ChildIndex(dir, "parent", "/parent").load(warn);
	assert.deepEqual([loaded?.maxMinutes, loaded?.maxCost, loaded?.stopReason], [30, 1.5, "over its 30-minute budget"]);
	index.save([base]);
	assert.equal(index.load(warn)[0]?.maxMinutes, undefined);
	for (const bad of [{ maxMinutes: 0 }, { maxMinutes: "60" }, { maxCost: -1 }, { stopReason: 3 }]) {
		index.save([{ ...base, ...bad } as never]);
		assert.throws(() => index.load(warn), /Invalid child index/, JSON.stringify(bad));
	}
});

test("config: maxRunMinutes defaults to 60 and maxRunCost to no limit", async () => {
	const { DEFAULTS, parseConfig } = await import("../lib/subagents/config.ts");
	assert.equal(DEFAULTS.maxRunMinutes, 60);
	assert.equal(DEFAULTS.maxRunCost, null);
	assert.deepEqual([parseConfig({ maxRunMinutes: 15, maxRunCost: 2.5 }).maxRunMinutes, parseConfig({ maxRunMinutes: 15, maxRunCost: 2.5 }).maxRunCost], [15, 2.5]);
	assert.equal(parseConfig({ maxRunMinutes: 0.5 }).maxRunMinutes, 0.5);
	for (const bad of [0, -5, "60", Number.NaN]) assert.equal(parseConfig({ maxRunMinutes: bad, maxRunCost: bad }).maxRunMinutes, 60);
	for (const bad of [0, -5, "1", Number.NaN]) assert.equal(parseConfig({ maxRunCost: bad }).maxRunCost, null);
	assert.equal(parseConfig({ maxRunMinutes: 1e9 }).maxRunMinutes, 24 * 60, "capped to what a timer can wait");
});

test("the subagent tool forwards maxMinutes and maxCost and describes them", async (t) => {
	const { subagentTool } = await import("../lib/subagents/tools.ts");
	const h = harness();
	const luna = { ref: "test/model", model: { provider: "test", id: "model", name: "Model" } };
	const tool = subagentTool({ team: h.team, allowed: [luna as never], fallbackModel: luna.ref, thinking: {}, modelTable: "", guide: "", replyTimeoutMs: 60_000, now: Date.now }, "main");
	t.mock.method(h.team, "spawn", (request: SpawnRequest) => {
		assert.equal(request.maxMinutes, 90);
		assert.equal(request.maxCost, 3);
		return { ok: false, error: "spawn fixture" };
	});
	assert.match(tool.description, /maxMinutes/);
	assert.match(tool.description, /maxCost/);
	await assert.rejects((tool.execute as any)("id", { task: "Long job", maxMinutes: 90, maxCost: 3 }, undefined, undefined), /spawn fixture/);
	await h.team.close();
});
