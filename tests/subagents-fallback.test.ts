import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { classifyFailure, fallbackChain } from "../lib/subagents/fallback.ts";
import { parseConfig } from "../lib/subagents/config.ts";
import { readEnvelopes, reportText } from "../lib/subagents/format.ts";
import { ChildIndex } from "../lib/subagents/restore.ts";
import { exhaustedMessage } from "../lib/rate-limit-recovery/transient.ts";
import { captureLimit, failureMessage } from "../lib/rate-limit-recovery/core.ts";
import { SETUP_FAILURE } from "../lib/rate-limit-recovery/child.ts";
import { teamHarness } from "./support/team-harness.ts";

const SOL = "openai-codex/gpt-6.1-sol";
const LUNA = "openai-codex/gpt-6-luna";
const OPUS = "anthropic/claude-opus-5-5";
const GLM = "openrouter/glm-5";
const CODEX_LIMIT = "Codex error: The usage limit has been reached";
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };

test("a failure is a reason to fall back only when the model can't serve the run", () => {
	assert.deepEqual(classifyFailure(CODEX_LIMIT), { kind: "quota", reason: "usage limit reached" });
	const guarded = failureMessage(captureLimit({ provider: "openai-codex", id: "gpt-6.1-sol" }, {}, 0), 0, "Choose another provider.");
	assert.equal(classifyFailure(guarded)?.kind, "quota", "the child guard's own quota report");
	const waited = exhaustedMessage("anthropic/claude-opus-5-5", "budget", { attempts: 3, spentMs: 60_000 });
	assert.deepEqual(classifyFailure(waited), { kind: "rate-limit", reason: "rate limit" }, "a rate limit the recovery did not wait out is not the provider's quota");
	assert.equal(classifyFailure("429 Too Many Requests")?.kind, "rate-limit");
	assert.equal(classifyFailure('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')?.kind, "overloaded");
	assert.equal(classifyFailure("503 Service Unavailable")?.kind, "overloaded");
	assert.equal(classifyFailure("No API key for provider: anthropic")?.kind, "credentials");
	assert.equal(classifyFailure("401 Unauthorized: your OAuth token has expired")?.kind, "credentials");
	assert.equal(classifyFailure('Model "gpt-9" not found for provider "openai"')?.kind, "not-found");
	for (const other of ["prompt is too long: 250000 tokens > 200000 maximum", "400 invalid_request_error: messages.0.content is empty",
		"Request was aborted", "Tool bash failed: exit 1", SETUP_FAILURE, "context_length_exceeded: rate limit of context"]) {
		assert.equal(classifyFailure(other), undefined, other);
	}
});

test("the fallback chain defaults to the default subagent model, and [] turns it off", () => {
	const allowed = [OPUS, SOL, LUNA].map((ref) => ({ ref, model: { provider: ref.split("/")[0]!, id: ref.split("/")[1]! } }));
	const warnings: string[] = [];
	assert.deepEqual(fallbackChain(undefined, OPUS, allowed, (message) => warnings.push(message)), [OPUS]);
	assert.deepEqual(fallbackChain([], OPUS, allowed, (message) => warnings.push(message)), []);
	assert.deepEqual(fallbackChain(["opus", "gpt-9", "luna", "opus"], OPUS, allowed, (message) => warnings.push(message)), [OPUS, LUNA]);
	assert.deepEqual(warnings, ['subagents.fallbackModels: "gpt-9" is not one of the allowed models: anthropic/claude-opus-5-5, openai-codex/gpt-6.1-sol, openai-codex/gpt-6-luna. It is skipped.']);
	assert.deepEqual(parseConfig({ fallbackModels: ["opus", 3, " "] }).fallbackModels, ["opus"]);
	assert.equal(parseConfig({}).fallbackModels, undefined);
});

test("a run whose model hit its usage limit goes on on the fallback model, and its report says so", async () => {
	const h = teamHarness({ fallbackModels: [OPUS] });
	const name = h.spawn("Fix the parser", { model: SOL });
	await tick();
	h.lastCall(name).fail(new Error(CODEX_LIMIT));
	await settle();
	const record = h.team.get(name)!;
	assert.equal(record.state, "running");
	assert.equal(record.model, OPUS, "the widget row shows the model it runs on now");
	assert.equal(record.runs, 1, "the same run");
	assert.deepEqual(h.launched.map((launch) => launch.model), [SOL, OPUS]);
	assert.equal(h.lastCall(name).text, `Your model ${SOL} failed: usage limit reached. You now run on ${OPUS}. Check the current state of files before you continue your work.`);
	assert.deepEqual(record.fallbacks?.map(({ from, to, reason }) => ({ from, to, reason })), [{ from: SOL, to: OPUS, reason: "usage limit reached" }]);
	h.lastCall(name).finish("Parser fixed.");
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "idle");
	assert.match(reportText(done, Date.now()), new RegExp(`\\nRan on ${OPUS} after ${SOL} failed: usage limit reached\\.\\n`));
	assert.deepEqual(h.main.map((delivery) => delivery.kind), ["report"]);
	await h.team.close();
});

test("a failure the model is not to blame for fails as before", async () => {
	const h = teamHarness({ fallbackModels: [OPUS] });
	const name = h.spawn("Read everything", { model: SOL });
	await tick();
	h.lastCall(name).fail(new Error("prompt is too long: 250000 tokens > 200000 maximum"));
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "failed");
	assert.equal(done.error, "prompt is too long: 250000 tokens > 200000 maximum");
	assert.deepEqual(h.launched.map((launch) => launch.model), [SOL]);
	await h.team.close();
});

test("a provider's quota skips its other models; an overload does not", async () => {
	const quota = teamHarness({ fallbackModels: [LUNA, OPUS] });
	const a = quota.spawn("Task a", { model: SOL });
	await tick();
	quota.lastCall(a).fail(new Error(CODEX_LIMIT));
	await settle();
	assert.equal(quota.team.get(a)?.model, OPUS);
	await quota.team.close();
	const overload = teamHarness({ fallbackModels: [LUNA, OPUS] });
	const b = overload.spawn("Task b", { model: SOL });
	await tick();
	overload.lastCall(b).fail(new Error("503 Service Unavailable"));
	await settle();
	assert.equal(overload.team.get(b)?.model, LUNA);
	await overload.team.close();
});

test("a fallback model that can't launch passes the run on to the next one", async () => {
	const h = teamHarness({ fallbackModels: [OPUS, GLM], refuse: (record) => record.model === OPUS ? new Error("No API key for provider: anthropic") : undefined });
	const name = h.spawn("Task", { model: SOL });
	await tick();
	h.lastCall(name).fail(new Error(CODEX_LIMIT));
	await settle();
	assert.equal(h.team.get(name)?.model, GLM);
	assert.equal(h.team.get(name)?.state, "running");
	assert.deepEqual(h.launched.map((launch) => launch.model), [SOL, OPUS, GLM]);
	assert.match(h.lastCall(name).text, new RegExp(`^Your model ${OPUS} failed: missing or expired credentials\\. You now run on ${GLM}\\.`));
	await h.team.close();
});

test("when the chain runs out the run fails, and the report lists what it tried", async () => {
	const h = teamHarness({ fallbackModels: [OPUS] });
	const name = h.spawn("Task", { model: SOL });
	await tick();
	h.lastCall(name).fail(new Error(CODEX_LIMIT));
	await settle();
	h.lastCall(name).fail(new Error("529 Overloaded"));
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "failed");
	assert.equal(done.error, "529 Overloaded. No fallback model is left to try.");
	const report = reportText(done, Date.now());
	assert.match(report, new RegExp(`^${done.name} \\(${OPUS}\\) failed after .*: 529 Overloaded\\. No fallback model is left to try\\.`));
	assert.match(report, new RegExp(`\\nRan on ${OPUS} after ${SOL} failed: usage limit reached\\.`));
	assert.deepEqual(h.launched.map((launch) => launch.model), [SOL, OPUS], "one try per model");
	await h.team.close();
});

test("with nothing in the chain to try, the failure says how to add one", async () => {
	const h = teamHarness({ fallbackModels: [SOL] });
	const name = h.spawn("Task", { model: SOL });
	await tick();
	h.lastCall(name).fail(new Error(CODEX_LIMIT));
	const done = await h.team.whenDone(name);
	assert.equal(done.error, `${CODEX_LIMIT}. No fallback model is available; add one to subagents.fallbackModels.`);
	await h.team.close();
});

test("fallbackModels: [] turns fallback off", async () => {
	const h = teamHarness({ fallbackModels: [] });
	const name = h.spawn("Task", { model: SOL });
	await tick();
	h.lastCall(name).fail(new Error(CODEX_LIMIT));
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "failed");
	assert.equal(done.error, CODEX_LIMIT);
	await h.team.close();
});

test("a fallback continues the run's budget: what it spent before still counts", async () => {
	const h = teamHarness({ fallbackModels: [OPUS] });
	const name = h.spawn("Task", { model: SOL, maxCost: 1 });
	await tick();
	const startedAt = h.team.get(name)!.startedAt;
	h.hooks.get(name)!.update({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.6 } });
	h.lastCall(name).fail(new Error(CODEX_LIMIT));
	await settle();
	assert.equal(h.team.get(name)?.state, "running");
	assert.equal(h.team.get(name)?.startedAt, startedAt, "the run's time counts from its start");
	h.hooks.get(name)!.update({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1.1 } });
	await settle();
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "stopped");
	assert.match(done.stopReason ?? "", /cost budget/);
	await h.team.close();
});

test("the fallback history survives the index, and a report with one still reads back in the inspector", () => {
	const dir = mkdtempSync(join(tmpdir(), "fallback-index-"));
	try {
		const step = { run: 1, from: SOL, to: OPUS, kind: "quota" as const, reason: "usage limit reached", at: 5 };
		const record = { name: "fixer", parent: "main", depth: 1, model: OPUS, task: "t", readOnly: false, fork: false, blocking: false, state: "idle" as const,
			createdAt: 1, startedAt: 0, endedAt: 16_000, activity: null, runs: 1, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, fallbacks: [step] };
		new ChildIndex(dir, "p", dir).save([record]);
		assert.deepEqual(new ChildIndex(dir, "p", dir).load((message) => assert.fail(message))[0]?.fallbacks, [step]);
		new ChildIndex(dir, "p", dir).save([{ ...record, fallbacks: [{ ...step, run: "1" as never }] }]);
		assert.throws(() => new ChildIndex(dir, "p", dir).load((message) => assert.fail(message)), /invalid/i);
		assert.deepEqual(readEnvelopes(reportText({ ...record, report: "Fixed." }, 0)), [{ kind: "report", from: "fixer", model: OPUS, state: "idle", took: "16s",
			text: `Ran on ${OPUS} after ${SOL} failed: usage limit reached.\n\nFixed.` }]);
		assert.doesNotMatch(reportText({ ...record, runs: 2, report: "Next." }, 0), /Ran on/, "a later run names only its own switches");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
