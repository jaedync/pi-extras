/**
 * A panel: the same task on several models at once (parallel) or one after
 * another without the earlier reports (sequential), for independent opinions.
 * The parent gets one message when the last member ends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { MainMail } from "../lib/subagents/deliver.ts";
import { memberName, shortModel } from "../lib/subagents/panel.ts";
import { stopTool, subagentTool } from "../lib/subagents/tools.ts";
import type { MainDelivery } from "../lib/subagents/types.ts";
import { teamHarness } from "./support/team-harness.ts";

const choice = (provider: string, id: string) => ({ ref: `${provider}/${id}`, model: { provider, id, name: id } });
const ALLOWED = [choice("anthropic", "claude-opus-5-5"), choice("openai-codex", "gpt-6-luna"), choice("opencode-go", "glm-5.3")];

function setup() {
	const h = teamHarness({ sessionDir: "/sessions" });
	const tool = subagentTool({ team: h.team, allowed: ALLOWED as never, fallbackModel: ALLOWED[0]!.ref, thinking: {}, modelTable: "", guide: "", replyTimeoutMs: 60_000, now: Date.now }, "main");
	const run = (params: Record<string, unknown>) => (tool.execute as any)("id", params, undefined, undefined);
	const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };
	return { ...h, tool, run, settle };
}

const panels = (main: readonly MainDelivery[]) => main.filter((delivery): delivery is Extract<MainDelivery, { kind: "panel" }> => delivery.kind === "panel");
const reports = (main: readonly MainDelivery[]) => main.filter((delivery) => delivery.kind === "report");

test("member names are the panel name and a short model name, at most 24 characters", () => {
	assert.equal(shortModel("claude-opus-5-5"), "opus-5-5");
	assert.equal(shortModel("glm-5.3"), "glm-5-3");
	assert.equal(memberName("review", "claude-opus-5-5"), "review-opus-5-5");
	assert.ok(memberName("a-very-long-review-name-indeed", "qwen38-iq3xxs-lora1-152k").length <= 24);
});

test("a parallel panel starts one child per model on the same task, and the parent gets one message when the last ends", async () => {
	const h = setup();
	const result = await h.run({ task: "Review the plan.", name: "review", models: ["opus", "luna", "glm"], maxMinutes: 30 });
	const names = ["review-opus-5-5", "review-gpt-6-luna", "review-glm-5-3"];
	assert.deepEqual(result.details.children.map((child: { name: string }) => child.name), names);
	assert.match(result.content[0].text, /^Started the panel review: 3 subagents on the same task, in parallel\./);
	await h.settle();
	for (const name of names) {
		assert.equal(h.lastCall(name).text.endsWith("Review the plan."), true, "the same task");
		assert.equal(h.team.get(name)!.maxMinutes, 30, "each its own budget");
		assert.equal(h.team.get(name)!.panel, "review");
	}
	h.lastCall(names[0]!).finish("Opus says yes.");
	h.lastCall(names[1]!).finish("Luna says no.");
	await h.settle();
	assert.equal(reports(h.main).length, 0, "held until the last ends");
	assert.equal(panels(h.main).length, 0);
	h.lastCall(names[2]!).finish("GLM says maybe.");
	await h.settle();
	const [panel] = panels(h.main);
	assert.ok(panel);
	assert.equal(panel.panel, "review");
	assert.deepEqual(panel.records.map((record) => record.name), names);
	assert.equal(reports(h.main).length, 0);
	for (const name of names) assert.equal(h.team.get(name)!.panelDone, true);
	// A later run of a member reports on its own.
	await h.team.send("main", names[0]!, "And the tests?");
	await h.settle();
	h.lastCall(names[0]!).finish("Tests pass.");
	await h.settle();
	assert.equal(reports(h.main).length, 1);
	await h.team.close();
});

test("a sequential panel starts each member after the one before, without its report", async () => {
	const h = setup();
	const result = await h.run({ task: "Pick a name.", name: "naming", models: ["opus", "luna"], mode: "sequential" });
	assert.match(result.content[0].text, /one after another; each starts when the one before ends and gets no earlier report\./);
	await h.settle();
	assert.equal(h.team.get("naming-gpt-6-luna")!.state, "queued");
	assert.deepEqual(h.team.get("naming-gpt-6-luna")!.after, ["naming-opus-5-5"]);
	assert.equal(h.team.get("naming-gpt-6-luna")!.afterReports, false);
	h.lastCall("naming-opus-5-5").finish("Call it Kiln.");
	await h.settle();
	const second = h.lastCall("naming-gpt-6-luna").text;
	assert.doesNotMatch(second, /Report:|Kiln/);
	assert.equal(panels(h.main).length, 0);
	h.lastCall("naming-gpt-6-luna").finish("Call it Forge.");
	await h.settle();
	assert.equal(panels(h.main).length, 1);
	await h.team.close();
});

test("a stopped member counts as ended; a stop of the last pending member sends the panel message", async () => {
	const h = setup();
	await h.run({ task: "Audit it.", name: "audit", models: ["opus", "luna"] });
	await h.settle();
	h.lastCall("audit-opus-5-5").finish("Clean.");
	await h.settle();
	const stop = stopTool({ team: h.team } as never, "main");
	await (stop.execute as any)("id", { name: "audit-gpt-6-luna" }, undefined, undefined);
	await h.settle();
	const [panel] = panels(h.main);
	assert.ok(panel);
	assert.deepEqual(panel.records.map((record) => record.state), ["idle", "stopped"]);
	await h.team.close();
});

test("a child's panel reaches the child as one message", async () => {
	const h = setup();
	const lead = h.spawn("lead the review", { name: "lead" });
	await h.settle();
	const tool = subagentTool({ team: h.team, allowed: ALLOWED as never, fallbackModel: ALLOWED[0]!.ref, thinking: {}, modelTable: "", guide: "", replyTimeoutMs: 60_000, now: Date.now }, lead);
	await (tool.execute as any)("id", { task: "Check it.", name: "check", models: ["opus", "luna"] }, undefined, undefined);
	await h.settle();
	h.lastCall("check-opus-5-5").finish("A.");
	await h.settle();
	assert.equal((h.steered.get(lead) ?? []).length, 0);
	h.lastCall("check-gpt-6-luna").finish("B.");
	await h.settle();
	const got = h.steered.get(lead) ?? [];
	assert.equal(got.length, 1);
	assert.match(got[0]!, /Panel check ended: 2 agents on the same task\./);
	await h.team.close();
});

test("a panel needs 2 to 8 known, different models, and can't go with model or wait", async () => {
	const h = setup();
	await assert.rejects(h.run({ task: "x", models: ["opus"] }), /at least 2 models/);
	await assert.rejects(h.run({ task: "x", models: ["opus", "opus"] }), /twice/);
	await assert.rejects(h.run({ task: "x", models: ["opus", "nope"] }), /nope/);
	await assert.rejects(h.run({ task: "x", models: ["opus", "luna"], model: "glm" }), /model or models, not both/);
	await assert.rejects(h.run({ task: "x", models: ["opus", "luna"], wait: true }), /wait/);
	await assert.rejects(h.run({ task: "x", mode: "sequential" }), /mode goes with models/);
	assert.equal(h.team.list().length, 0, "nothing started");
	await h.team.close();
});

test("main gets the panel as one report message: a summary line per member, then each report", async () => {
	const posted: Array<{ content: string; details: { kind: string; reports: unknown[] } }> = [];
	const mail = new MainMail({ port: { send: (message: never) => { posted.push(message); } } as never, batchMs: 10 });
	const record = (name: string, extra: Record<string, unknown>) => ({ name, parent: "main", depth: 1, task: "t", model: "anthropic/claude-opus-5-5", readOnly: false, fork: false, blocking: false,
		state: "idle", createdAt: 0, startedAt: 0, endedAt: 90_000, activity: null, toolCalls: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1.5 }, runs: 1, sessionFile: `/s/${name}.jsonl`, ...extra }) as never;
	mail.deliver({ kind: "panel", panel: "review", records: [record("review-a", { report: "Yes.", reportFile: "/s/review-a.run-1.report.md" }), record("review-b", { state: "failed", error: "rate limited" })] });
	await tick();
	assert.equal(posted.length, 1);
	const text = posted[0]!.content;
	assert.match(text, /^Panel review ended: 2 agents on the same task\.\n- review-a \(anthropic\/claude-opus-5-5\): finished after 1m30s, \$1\.50\. Report: \/s\/review-a\.run-1\.report\.md\n- review-b \(anthropic\/claude-opus-5-5\): failed after 1m30s, \$1\.50\. Session: \/s\/review-b\.jsonl\n\n---\n\n/);
	assert.equal(posted[0]!.details.reports.length, 2);
});
