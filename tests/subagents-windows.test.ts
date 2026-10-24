/** `maxWindowPct`: a run wraps up when the usage window that governs its model reaches the limit. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import type { LimitSnapshot } from "../lib/limit-store.ts";
import { childInstructions } from "../lib/subagents/format.ts";
import { subagentTool } from "../lib/subagents/tools.ts";
import { windowReading, type WindowLookup, type WindowReading } from "../lib/subagents/windows.ts";
import { NO_USAGE } from "../lib/subagents/types.ts";
import { teamHarness } from "./support/team-harness.ts";

const snap = (entries: LimitSnapshot["entries"]): LimitSnapshot => ({ entries, atMs: 0, source: "poll" });

test("the reading is the fullest window that governs the model; a model-family window only for its family", () => {
	const store = new Map<string, LimitSnapshot>([
		["anthropic", snap([{ label: "5h", usedPct: 26 }, { label: "7d", usedPct: 44 }, { label: "7d-fable", usedPct: 90, modelFamily: "fable" }, { label: "credits", kind: "credits", remainingText: "$5" }])],
		["openai-codex", snap([{ label: "5h", usedPct: 5, exhausted: true }])],
		["opencode-go", snap([{ label: "monthly", kind: "budget", remainingText: "$3 / $10" }])],
	]);
	const get = (provider: string) => store.get(provider);
	assert.deepEqual(windowReading(get, "anthropic/claude-opus-5-5"), { reading: { label: "anthropic 7d", pct: 44 } });
	assert.deepEqual(windowReading(get, "anthropic/claude-fable-5-1"), { reading: { label: "anthropic 7d-fable", pct: 90 } });
	assert.deepEqual(windowReading(get, "openai-codex/gpt-6-luna"), { reading: { label: "openai-codex 5h", pct: 100 } }, "a blocked window is full");
	const glm = windowReading(get, "opencode-go/glm-5.3");
	assert.ok("why" in glm && /reports no usage windows for glm-5\.3/.test(glm.why));
	const openai = windowReading(get, "openai/gpt-6.1-sol");
	assert.ok("why" in openai && /Sign in with ChatGPT reports no usage/.test(openai.why), "openai says why");
});

test("a running child wraps up when its window reaches maxWindowPct, at a usage update or when the store changes", async () => {
	let reading: WindowReading | undefined = { label: "anthropic 7d", pct: 70 };
	const h = teamHarness({ windowUse: () => reading });
	const name = h.spawn("Work.", { name: "worker", maxWindowPct: 80, model: "anthropic/claude-opus-5-5" });
	const plain = h.spawn("Work.", { name: "plain", model: "anthropic/claude-opus-5-5" });
	await tick(); await tick();
	h.hooks.get(name)!.update({ usage: { ...NO_USAGE, cost: 0.1 } });
	assert.doesNotMatch(h.team.get(name)!.activity ?? "", /wrapping up/);
	reading = { label: "anthropic 7d", pct: 81 };
	h.team.windowsChanged();
	assert.equal(h.team.get(name)!.activity, "wrapping up: over its 80% limit on the anthropic 7d window");
	assert.doesNotMatch(h.team.get(plain)!.activity ?? "", /wrapping up/, "no limit, no wrap-up");
	await h.team.close();
});

test("maxWindowPct is checked at spawn and kept on the record", () => {
	const h = teamHarness();
	const bad = h.team.spawn({ task: "x", parent: "main", model: "m", readOnly: false, fork: false, blocking: false, maxWindowPct: 0 });
	assert.equal(bad.ok, false);
	assert.match(bad.ok ? "" : bad.error, /maxWindowPct must be a number from 1 to 100/);
	const name = h.spawn("x", { maxWindowPct: 90 });
	assert.equal(h.team.get(name)!.maxWindowPct, 90);
});

test("the spawn refuses a window already at the limit, and says when a provider gives no reading", async () => {
	const h = teamHarness();
	const allowed = [
		{ ref: "anthropic/claude-opus-5-5", model: { provider: "anthropic", id: "claude-opus-5-5", name: "Opus" } },
		{ ref: "openai/gpt-6.1-sol", model: { provider: "openai", id: "gpt-6.1-sol", name: "Sol" } },
	];
	let anthropic = 85;
	const windows = (model: string): WindowLookup => model.startsWith("anthropic/") ? { reading: { label: "anthropic 7d", pct: anthropic } } : { why: "Sign in with ChatGPT reports no usage." };
	const tool = subagentTool({ team: h.team, allowed: allowed as never, fallbackModel: allowed[0]!.ref, thinking: {}, modelTable: "", guide: "", replyTimeoutMs: 60_000, now: Date.now, windows }, "main");
	const run = (params: Record<string, unknown>) => (tool.execute as any)("id", params, undefined, undefined);
	await assert.rejects(run({ task: "x", maxWindowPct: 80 }), /The anthropic 7d window is at 85%, at or over maxWindowPct 80/);
	anthropic = 40;
	const ok = await run({ task: "x", name: "fine", maxWindowPct: 80 });
	assert.doesNotMatch(ok.content[0].text, /can't act/);
	const sol = await run({ task: "x", name: "sol", model: "sol", maxWindowPct: 80 });
	assert.match(sol.content[0].text, /maxWindowPct can't act on openai\/gpt-6\.1-sol now: Sign in with ChatGPT reports no usage\. A time or cost budget \(maxMinutes, maxCost\) still applies\./);
	await h.team.close();
});

test("the child's instructions name its window limit", () => {
	const base = { name: "scout", parent: "main", readOnly: false, canSpawn: false, roster: "" };
	assert.match(childInstructions({ ...base, budget: { minutes: 30 }, windowPct: 80 }), /It also wraps up when the usage window of your model reaches 80%\. At the limit/);
	assert.match(childInstructions({ ...base, windowPct: 80 }), /## Budget\nIt also wraps up when the usage window of your model reaches 80%\. At the limit/);
});
