/** `after`: a spawn that waits for other agents to end before its first run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { afterBlock, busyInGroup } from "../lib/subagents/after.ts";
import { ChildIndex } from "../lib/subagents/restore.ts";
import type { AgentRecord, MainDelivery } from "../lib/subagents/types.ts";
import { teamHarness } from "./support/team-harness.ts";

/** A harness whose children have session files on disk, so their reports are saved and named. */
function onDisk(options: Parameters<typeof teamHarness>[0] = {}) {
	const dir = mkdtempSync(join(tmpdir(), "subagents-after-"));
	const h = teamHarness({ sessionDir: dir, warn: () => undefined, ...options });
	const spawn = (task: string, extra: Parameters<typeof h.spawn>[1] = {}) => {
		const name = h.spawn(task, extra);
		writeFileSync(join(dir, `${name}.jsonl`), "");
		return name;
	};
	return { ...h, spawn, dir, done: async () => { await h.team.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const reports = (main: readonly MainDelivery[]) => main.filter((delivery): delivery is Extract<MainDelivery, { kind: "report" }> => delivery.kind === "report");

test("a spawn after another agent stays queued until it ends, then starts with its report's path", async () => {
	const h = onDisk();
	try {
		const impl = h.spawn("implement it", { name: "impl" });
		const review = h.spawn("review impl's change", { name: "review", after: ["impl"] });
		await tick();
		assert.equal(h.team.get(review)!.state, "queued");
		assert.equal(h.team.get(review)!.activity, "after impl", "the widget shows what it waits for");
		assert.equal(h.calls.get(review), undefined, "nothing launched yet");
		h.lastCall(impl).finish("Implemented.");
		await tick(); await tick();
		assert.equal(h.team.get(review)!.state, "running");
		const prompt = h.lastCall(review).text;
		assert.match(prompt, /^review impl's change\n\n/);
		const file = h.team.get(impl)!.reportFile!;
		assert.ok(file.endsWith("impl.run-1.report.md"), file);
		assert.ok(prompt.includes(`- impl finished. Report: ${file}`), prompt);
		assert.ok(!prompt.includes("Implemented."), "the report text stays out; the child reads what it needs");
	} finally { await h.done(); }
});

test("after is checked: unknown names, the spawner, and agents the spawner waits on are refused", async () => {
	const h = teamHarness({ maxDepth: 3 });
	const lead = h.spawn("lead the work", { name: "lead" });
	await tick();
	const refused = (parent: string, after: string[]) => {
		const result = h.team.spawn({ task: "x", parent, model: "m", readOnly: false, fork: false, blocking: false, after });
		assert.equal(result.ok, false);
		return result.ok ? "" : result.error;
	};
	assert.match(refused("main", ["ghost"]), /"ghost", which is not an agent\. Agents: main, lead\./);
	assert.match(refused("main", ["main"]), /can't name main: that is you/);
	assert.match(refused(lead, ["main"]), /"main", which is not an agent/);
	assert.match(refused(lead, [lead]), /can't name lead: that is you/);
	assert.ok(h.team.spawn({ name: "helper", task: "help", parent: lead, model: "m", readOnly: false, fork: false, blocking: false }).ok);
	await tick();
	assert.match(refused("helper", ["lead"]), /can't name lead: it waits for you/);
	assert.match(refused("main", Array.from({ length: 17 }, () => "lead")), /at most 16/);
	const twice = h.team.spawn({ name: "twice", task: "x", parent: "main", model: "m", readOnly: false, fork: false, blocking: false, after: [lead, lead] });
	assert.ok(twice.ok);
	assert.deepEqual(twice.record.after, ["lead"], "a name given twice is kept once");
	await h.team.close();
});

test("after is refused when the named agent can't end before the spawner does, through held spawns, subagents or owed answers", async () => {
	const h = teamHarness({ maxDepth: 2 });
	const impl = h.spawn("impl", { name: "impl" });
	h.spawn("review", { name: "review", after: [impl] });
	await tick();
	const docs = h.team.spawn({ name: "docs", task: "docs", parent: impl, model: "m", readOnly: false, fork: false, blocking: false, after: ["review"] });
	assert.match(docs.ok ? "" : docs.error, /after can't name review: it waits for you, directly or through other agents, so neither would end\./);
	const [x, a] = [h.spawn("x", { name: "x" }), h.spawn("a", { name: "a" })];
	h.spawn("q", { name: "q", after: [x] });
	await tick();
	assert.ok((await h.team.send(x, a, "What is the port?", { expectReply: true })).ok);
	const helper = h.team.spawn({ name: "helper", task: "help", parent: a, model: "m", readOnly: false, fork: false, blocking: false, after: ["q"] });
	assert.match(helper.ok ? "" : helper.error, /after can't name q: it waits for you/, "q waits for x, which waits for a's answer");
	assert.ok(h.team.spawn({ name: "fine", task: "f", parent: a, model: "m", readOnly: false, fork: false, blocking: false, after: [impl] }).ok, "impl does not wait for a");
	await h.team.close();
});

test("a failed, stopped or interrupted agent counts as ended, and the block says how each ended", () => {
	const base = { parent: "main", depth: 1, task: "t", model: "m", readOnly: false, fork: false, blocking: false, createdAt: 0, activity: null, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, runs: 1 } as const;
	const records = new Map<string, AgentRecord>([
		["a", { ...base, name: "a", state: "failed", error: "rate limited", reportFile: "/s/a.run-1.report.md" }],
		["b", { ...base, name: "b", state: "stopped", stopReason: "over its 60-minute budget", sessionFile: "/s/b.jsonl" }],
		["c", { ...base, name: "c", state: "interrupted" }],
	]);
	const block = afterBlock({ ...base, name: "d", state: "queued", runs: 0, after: ["a", "b", "c"] }, (name) => records.get(name));
	assert.match(block, /- a failed: rate limited\. Report: \/s\/a\.run-1\.report\.md/);
	assert.match(block, /- b was stopped over its 60-minute budget\. No report; its session: \/s\/b\.jsonl/);
	assert.match(block, /- c was interrupted; that counts as ended, and it may resume later\. No report\./);
});

test("an agent waiting for another holds no slot, and a stop while it waits just drops it", async () => {
	const h = teamHarness({ maxConcurrent: 1 });
	const first = h.spawn("first job", { name: "first" });
	const later = h.spawn("after first", { name: "later", after: [first] });
	const other = h.spawn("other job", { name: "other" });
	await tick();
	assert.deepEqual([first, later, other].map((name) => h.team.get(name)!.state), ["running", "queued", "queued"]);
	h.lastCall(first).finish("done");
	await tick(); await tick();
	assert.equal(h.team.get(later)!.state, "running", "it was first in line once its wait ended");
	assert.equal(h.team.get(later)!.activity === "after first", false);
	const third = h.spawn("waits on later", { name: "third", after: [later] });
	const stopped = await h.team.stop(third, { by: "main" });
	assert.equal(stopped?.state, "stopped");
	assert.ok(!h.launched.some((launch) => launch.name === third), "never launched");
	assert.equal(reports(h.main).some((delivery) => delivery.record.name === third), false, "its parent stopped it and has the record");
	await h.team.close();
});

test("the run's time budget starts when it starts, not while it waits", async () => {
	let now = 1_000;
	const h = teamHarness({ now: () => now });
	const first = h.spawn("first", { name: "first" });
	const later = h.spawn("later", { name: "later", after: [first] });
	await tick();
	now = 61_000;
	h.lastCall(first).finish("done");
	await tick(); await tick();
	assert.equal(h.team.get(later)!.createdAt, 1_000);
	assert.equal(h.team.get(later)!.startedAt, 61_000);
	await h.team.close();
});

test("an idle report that a waiting spawn of the same parent picks up does not wake that parent; a failure does", async () => {
	const h = teamHarness();
	const impl = h.spawn("impl", { name: "impl" });
	h.spawn("review", { name: "review", after: [impl] });
	await tick();
	h.lastCall(impl).finish("Implemented.");
	await tick();
	assert.equal(reports(h.main).at(-1)?.quiet, true, "review takes it up; main reads it at its next turn");
	const broken = h.spawn("broken", { name: "broken" });
	h.spawn("fix", { name: "fix", after: [broken] });
	await tick();
	h.lastCall(broken).fail(new Error("crashed"));
	await tick();
	assert.equal(reports(h.main).at(-1)?.record.name, broken);
	assert.equal(reports(h.main).at(-1)?.quiet, undefined, "a failure is news");
	await h.team.close();
});

test("no agent can ask a spawn that waits for its after agents a question; a note waits for its start", async () => {
	const h = teamHarness({ maxDepth: 2 });
	const impl = h.spawn("impl", { name: "impl" });
	const other = h.spawn("other", { name: "other" });
	h.spawn("review", { name: "review", after: [impl] });
	await tick();
	assert.ok(h.team.spawn({ name: "helper", task: "help", parent: impl, model: "m", readOnly: false, fork: false, blocking: false }).ok);
	await tick();
	for (const asker of [impl, "helper", other]) {
		const asked = await h.team.send(asker, "review", "Is this right?", { expectReply: true });
		assert.equal(asked.ok, false);
		assert.match(asked.ok ? "" : asked.error, /review has not started: it starts after impl ends\. Send a note instead \(no expectReply\); it reads it when it starts\./);
	}
	assert.deepEqual(await h.team.send(impl, "review", "fyi: see lib/x.ts"), { ok: true, delivered: "queued" });
	assert.deepEqual(await h.team.send("main", "review", "What will you check first?", { expectReply: true }), { ok: true, delivered: "queued" }, "main never waits, so it may ask");
	await h.team.close();
});

test("a question chain through a peer can't end at a waiting spawn, in either order", async () => {
	const h = teamHarness({ maxDepth: 2 });
	const [x, a] = [h.spawn("x", { name: "x" }), h.spawn("a", { name: "a" })];
	h.spawn("q", { name: "q", after: [x] });
	await tick();
	assert.ok((await h.team.send(x, a, "What is the port?", { expectReply: true })).ok);
	assert.equal((await h.team.send(a, "q", "What will you review?", { expectReply: true })).ok, false, "a waits for q, q for x, x for a");
	const b = h.spawn("b", { name: "b" });
	await tick();
	assert.equal((await h.team.send(b, "q", "What will you review?", { expectReply: true })).ok, false, "asked first, then x could ask b");
	await h.team.close();
});

test("a spawn waiting for its after agents does not keep its group's reports waiting", () => {
	const base = { parent: "main", depth: 1, task: "t", model: "m", readOnly: false, fork: false, blocking: false, createdAt: 0, activity: null, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, runs: 0, group: "g" } as const;
	const records: AgentRecord[] = [
		{ ...base, name: "old", state: "running", group: "earlier", runs: 1 },
		{ ...base, name: "done", state: "idle", runs: 1 },
		{ ...base, name: "held", state: "queued", after: ["old"] },
	];
	assert.equal(busyInGroup(records, "g", "done"), false, "held waits for old, so the group has nothing working");
	assert.equal(busyInGroup(records.map((r) => (r.name === "old" ? { ...r, state: "idle" as const } : r)), "g", "done"), true, "once old ended it is about to work");
});

test("after is kept in the index and a restored spawn that never ran waits again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "subagents-after-index-"));
	try {
		const h = teamHarness({ sessionDir: dir });
		h.spawn("first", { name: "first" });
		h.spawn("later", { name: "later", after: ["first"] });
		await tick();
		const index = new ChildIndex(dir, "parent", dir);
		index.save(h.team.list());
		await h.team.close();
		const loaded = new ChildIndex(dir, "parent", dir).load(() => undefined);
		assert.deepEqual(loaded.find((record) => record.name === "later")?.after, ["first"]);
		const again = teamHarness();
		again.team.restore([{ ...loaded.find((r) => r.name === "first")!, state: "interrupted" }, { ...loaded.find((r) => r.name === "later")!, state: "interrupted" }]);
		assert.deepEqual(await again.team.send("main", "first", "Continue"), { ok: true, delivered: "resumed" });
		assert.deepEqual(await again.team.send("main", "later", "Continue"), { ok: true, delivered: "resumed" });
		await tick(); await tick();
		assert.equal(again.team.get("later")!.state, "queued", "first runs again, so later waits");
		again.lastCall("first").finish("done");
		await tick(); await tick();
		assert.match(again.lastCall("later").text, /- first finished\./);
		await again.team.close();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the subagent tool passes after on and says the spawn waits", async () => {
	const { subagentTool } = await import("../lib/subagents/tools.ts");
	const h = teamHarness();
	const luna = { ref: "openai-codex/gpt-6-luna", model: { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" } };
	const tool = subagentTool({ team: h.team, allowed: [luna as never], fallbackModel: luna.ref, thinking: {}, modelTable: "", guide: "", replyTimeoutMs: 60_000, now: Date.now }, "main");
	const properties = (tool.parameters as { properties: Record<string, { description?: string }> }).properties;
	assert.match(properties.after?.description ?? "", /must end first/);
	h.spawn("impl", { name: "impl" });
	const result = await (tool.execute as any)("id", { task: "Review impl", name: "review", after: ["impl"] }, undefined, undefined);
	assert.match(result.content[0].text, /It waits for impl to end, then starts\./);
	assert.deepEqual(h.team.get("review")?.after, ["impl"]);
	await assert.rejects((tool.execute as any)("id", { task: "x", after: ["nobody"] }, undefined, undefined), /"nobody", which is not an agent/);
	await h.team.close();
});

test("wait: true with after is refused: the caller could not answer a question from an agent the spawn waits for", async () => {
	const { subagentTool } = await import("../lib/subagents/tools.ts");
	const h = teamHarness();
	const luna = { ref: "openai-codex/gpt-6-luna", model: { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" } };
	const tool = subagentTool({ team: h.team, allowed: [luna as never], fallbackModel: luna.ref, thinking: {}, modelTable: "", guide: "", replyTimeoutMs: 60_000, now: Date.now }, "main");
	h.spawn("impl", { name: "impl" });
	await assert.rejects((tool.execute as any)("id", { task: "Check impl", name: "check", after: ["impl"], wait: true }, undefined, undefined),
		/wait: true can't go with after: the agents it waits for may need an answer from you first\. Leave out wait; its report arrives as a message\./);
	assert.equal(h.team.get("check"), undefined, "nothing was recorded");
	await h.team.close();
});
