/**
 * A child run that meets a ChatGPT plan usage limit: the child fails fast, and
 * the team holds the run until the reset and resumes it in the same run
 * (lib/subagents/plan-wait.ts). Time and timers are injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { capturePlanLimit, failureMessage } from "../lib/rate-limit-recovery/core.ts";
import { DEFAULT_CONFIG, normalizeConfig, type RecoveryConfig, SUBAGENT_PLAN_WAIT_DEFAULT, subagentPlanWaitOn } from "../lib/rate-limit-recovery/config.ts";
import { ChildIndex } from "../lib/subagents/restore.ts";
import { recoveryDecision } from "../lib/subagents/recovery.ts";
import { createChildRateLimitGuard } from "../lib/rate-limit-recovery/child.ts";
import { REAL_TIMER } from "../lib/subagents/plan-wait.ts";
import { agentStatus } from "../lib/subagents/status.ts";
import { teamHarness } from "./support/team-harness.ts";
import "./support/plan-login.ts";

const SOL = "openai-codex/gpt-6.1-sol";
const LUNA = "openai-codex/gpt-6-luna";
const OPUS = "anthropic/claude-opus-5-5";
const MIN = 60_000;
const HOUR = 60 * MIN;
const START = Date.parse("2026-11-17T20:00:00.000Z");
const ON: RecoveryConfig = { ...DEFAULT_CONFIG, autoWait: true };
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

/** A timer the test fires by hand; it records each delay it was set for. */
function fakeTimer() {
	let id = 0;
	const pending = new Map<number, { fn: () => void; ms: number }>();
	const delays: number[] = [];
	return {
		pending, delays,
		set(fn: () => void, ms: number) { pending.set(++id, { fn, ms }); delays.push(ms); return id; },
		clear(handle: unknown) { pending.delete(handle as number); },
		fire() { for (const [key, entry] of [...pending]) { pending.delete(key); entry.fn(); } },
	};
}

/** `none`: a team without the settings reader, as one made before plan waits. */
function setup(config: RecoveryConfig | "none" = ON, extra: Parameters<typeof teamHarness>[0] = {}) {
	const clock = { now: START };
	const timer = fakeTimer();
	const h = teamHarness({ now: () => clock.now, ...(config === "none" ? {} : { planWait: () => config }), planTimer: timer, ...extra });
	/** The child guard caught a Codex plan limit with this reset: the handle has it, and the run fails with the guard's text. */
	const planFail = (name: string, resetAtMs: number, model = SOL) => {
		const [provider, id] = model.split("/") as [string, string];
		const limit = capturePlanLimit({ provider, id }, clock.now, { resetAtMs, window: "5h" });
		h.planLimits.set(name, limit);
		h.lastCall(name).fail(new Error(failureMessage(limit, clock.now, "The subagent's own session never waits. Choose another provider or retry after the reset.")));
	};
	return { h, clock, timer, planFail };
}

test("a run that meets a plan limit waits for the reset and goes on as the same run, on the same model", async () => {
	const { h, clock, timer, planFail } = setup();
	const name = h.spawn("Long task", { model: SOL, maxMinutes: 60 });
	await tick();
	clock.now += 10 * MIN;
	const reset = clock.now + 2 * HOUR;
	planFail(name, reset);
	await settle();
	let record = h.team.get(name)!;
	assert.equal(record.state, "queued", "it holds no slot while it waits");
	assert.equal(record.error, undefined, "the run did not fail");
	assert.equal(record.activity, "waiting for the ChatGPT plan reset until 22:10 UTC");
	assert.equal(agentStatus(record, (other) => h.team.get(other), clock.now), `${name} waiting for the ChatGPT plan reset until 22:10 UTC`, "the Team now: line");
	assert.deepEqual(record.planWait, { run: 1, waits: 1, waitedMs: 0, pausedAt: START + 10 * MIN, resetAt: reset, resumeAt: reset + 10_000, window: "5h" });
	assert.deepEqual(timer.delays, [2 * HOUR + 10_000], "the timer ends at the reset plus the margin");
	assert.equal(h.launched.length, 1);
	assert.equal(h.main.length, 0, "no report goes up while it waits");
	clock.now = reset + 10_000;
	timer.fire();
	await settle();
	record = h.team.get(name)!;
	assert.equal(record.state, "running");
	assert.equal(record.runs, 1, "the same run");
	assert.equal(record.model, SOL);
	assert.deepEqual(h.launched.map((launch) => launch.model), [SOL, SOL]);
	const text = h.lastCall(name).text;
	assert.match(text, /You waited for the ChatGPT plan usage limit to reset, from 2026-11-17T20:10:00\.000Z to 2026-11-17T22:10:10\.000Z \(UTC\)\./);
	assert.doesNotMatch(text, /Long task/, "the session has the task already");
	assert.doesNotMatch(text, /Request quota exceeded/, "no failure text reaches the child");
	const used = h.team.budgetClock(name)!.usedMs;
	assert.ok(used >= 10 * MIN && used < 11 * MIN, `the wait does not use the work clock: ${used} ms`);
	assert.equal(h.team.get(name)!.planWait?.pausedAt, undefined);
	assert.equal(h.team.get(name)!.planWait?.waitedMs, 2 * HOUR + 10_000);
	h.lastCall(name).finish("Done.");
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "idle");
	assert.deepEqual(h.main.map((delivery) => delivery.kind), ["report"]);
	await h.team.close();
});

test("a stop during the wait ends it: the timer goes and nothing launches", async () => {
	const { h, clock, timer, planFail } = setup();
	const name = h.spawn("Task", { model: SOL });
	await tick();
	planFail(name, clock.now + HOUR);
	await settle();
	assert.equal(timer.pending.size, 1);
	const stopped = await h.team.stop(name);
	assert.equal(stopped?.state, "stopped");
	assert.equal(timer.pending.size, 0);
	assert.equal(h.team.get(name)!.planWait?.pausedAt, undefined, "the record no longer says it waits");
	await settle();
	assert.equal(h.launched.length, 1);
	assert.deepEqual(h.main.map((delivery) => delivery.kind), ["report"]);
	await h.team.close();
});

test("a usable fallback model goes first; the run waits only when no fallback is left", async () => {
	const first = setup(ON, { fallbackModels: [OPUS] });
	const a = first.h.spawn("Task", { model: SOL });
	await tick();
	first.planFail(a, first.clock.now + HOUR);
	await settle();
	assert.equal(first.h.team.get(a)!.model, OPUS);
	assert.equal(first.h.team.get(a)!.state, "running");
	assert.equal(first.timer.pending.size, 0);
	await first.h.team.close();
	// The other Codex model bills the same plan, so the quota blocks it too.
	const second = setup(ON, { fallbackModels: [LUNA] });
	const b = second.h.spawn("Task", { model: SOL });
	await tick();
	second.planFail(b, second.clock.now + HOUR);
	await settle();
	assert.equal(second.h.team.get(b)!.state, "queued");
	assert.equal(second.h.team.get(b)!.model, SOL);
	assert.equal(second.timer.pending.size, 1);
	await second.h.team.close();
});

for (const [label, config] of [
	["autoWait off", { ...DEFAULT_CONFIG, autoWait: false }],
	["subagentPlanWait false", { ...ON, subagentPlanWait: false }],
	["no config reader", "none"],
] as const) test(`with ${label} the run fails as before`, async () => {
	const { h, clock, timer, planFail } = setup(config as RecoveryConfig | "none");
	const name = h.spawn("Task", { model: SOL });
	await tick();
	planFail(name, clock.now + HOUR);
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "failed");
	assert.match(done.error ?? "", /^Request quota exceeded for openai-codex: the ChatGPT plan usage limit was reached \(the 5h window is full\)\. Expected reset at .*retry after the reset\.$/);
	assert.equal(timer.pending.size, 0);
	await h.team.close();
});

test("only a ChatGPT plan limit with an exact reset waits", async () => {
	const { h, clock, timer } = setup();
	const name = h.spawn("Task", { model: SOL });
	await tick();
	h.planLimits.set(name, capturePlanLimit({ provider: "openai-codex", id: "gpt-6.1-sol" }, clock.now, { window: "5h" }));
	h.lastCall(name).fail(new Error("Request quota exceeded for openai-codex: the ChatGPT plan usage limit was reached. The reset time is unknown."));
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "failed");
	assert.match(done.error ?? "", /The parent did not wait for the plan reset: the reset time is unknown\.$/);
	const other = h.spawn("Other", { model: OPUS });
	await tick();
	h.lastCall(other).fail(new Error("429 usage limit reached for this billing period"));
	assert.equal((await h.team.whenDone(other)).state, "failed");
	assert.equal(timer.pending.size, 0);
	await h.team.close();
});

test("a reset beyond maxWaitSeconds fails the run with the reason", async () => {
	const { h, clock, timer, planFail } = setup({ ...ON, maxWaitSeconds: 3600 });
	const name = h.spawn("Task", { model: SOL });
	await tick();
	planFail(name, clock.now + 2 * HOUR);
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "failed");
	assert.match(done.error ?? "", /The parent did not wait for the plan reset: it is more than 3600 seconds away \(rateLimitRecovery\.maxWaitSeconds\)\.$/);
	assert.equal(timer.pending.size, 0);
	await h.team.close();
});

test("maxRecoveries caps the waits of one run; a second limit after a resume waits again", async () => {
	const { h, clock, timer, planFail } = setup({ ...ON, maxRecoveries: 2 });
	const name = h.spawn("Task", { model: SOL });
	await tick();
	for (let wait = 1; wait <= 2; wait++) {
		planFail(name, clock.now + HOUR);
		await settle();
		assert.equal(h.team.get(name)!.state, "queued", `wait ${wait}`);
		clock.now += HOUR + 10_000;
		timer.fire();
		await settle();
		assert.equal(h.team.get(name)!.state, "running");
	}
	planFail(name, clock.now + HOUR);
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "failed");
	assert.equal(done.runs, 1);
	assert.match(done.error ?? "", /The parent did not wait for the plan reset: this run already waited 2 times \(rateLimitRecovery\.maxRecoveries\)\.$/);
	await h.team.close();
});

test("planWaitBudget run: the waits of one run share maxWaitSeconds", async () => {
	const { h, clock, timer, planFail } = setup({ ...ON, planWaitBudget: "run" });
	const name = h.spawn("Task", { model: SOL });
	await tick();
	planFail(name, clock.now + 4 * HOUR);
	await settle();
	clock.now += 4 * HOUR + 10_000;
	timer.fire();
	await settle();
	planFail(name, clock.now + 2 * HOUR);
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "failed");
	assert.match(done.error ?? "", /the waits of this run would pass 18000 seconds \(rateLimitRecovery\.maxWaitSeconds, planWaitBudget "run"\)\.$/);
	await h.team.close();
});

test("a new run starts with no waits counted", async () => {
	const { h, clock, timer, planFail } = setup({ ...ON, maxRecoveries: 1 });
	const name = h.spawn("Task", { model: SOL });
	await tick();
	planFail(name, clock.now + HOUR);
	await settle();
	clock.now += HOUR + 10_000;
	timer.fire();
	await settle();
	h.lastCall(name).finish("Done.");
	await h.team.whenDone(name);
	await h.team.send("main", name, "One more thing.");
	await settle();
	assert.equal(h.team.get(name)!.runs, 2);
	planFail(name, clock.now + HOUR);
	await settle();
	assert.equal(h.team.get(name)!.state, "queued");
	assert.equal(h.team.get(name)!.planWait?.waits, 1);
	await h.team.close();
});

test("a message from main or the parent during the wait resumes the run at once; a peer's note waits in the inbox", async () => {
	const { h, clock, timer, planFail } = setup();
	const name = h.spawn("Task", { model: SOL });
	const peer = h.spawn("Peer", { model: OPUS });
	await tick();
	planFail(name, clock.now + 2 * HOUR);
	await settle();
	const noted = await h.team.send(peer, name, "FYI: the parser moved.");
	assert.equal(noted.ok && noted.delivered, "inbox");
	assert.equal(h.team.get(name)!.state, "queued");
	assert.equal(timer.pending.size, 1);
	clock.now += 30 * MIN;
	const sent = await h.team.send("main", name, "Go on now.");
	assert.equal(sent.ok && sent.delivered, "resumed");
	assert.equal(timer.pending.size, 0);
	await settle();
	const record = h.team.get(name)!;
	assert.equal(record.state, "running");
	assert.equal(record.runs, 1, "the same run");
	const text = h.lastCall(name).text;
	assert.match(text, /from 2026-11-17T20:00:00\.000Z to 2026-11-17T20:30:00\.000Z \(UTC\)\. That is [^.]+\. A message resumed you before the expected reset at 2026-11-17T22:00:00\.000Z, so the plan can still be limited\./);
	assert.match(text, /FYI: the parser moved\./);
	assert.match(text, /Go on now\./);
	await h.team.close();
});

test("a report from its own subagent does not end the wait: it waits in the inbox for the resumed run", async () => {
	const { h, clock, timer, planFail } = setup();
	const lead = h.spawn("Lead", { model: SOL });
	await tick();
	const helper = h.spawn("Helper", { model: OPUS, parent: lead });
	await tick();
	planFail(lead, clock.now + HOUR);
	await settle();
	h.lastCall(helper).finish("Helper result.");
	await settle();
	assert.equal(h.team.get(lead)!.state, "queued");
	assert.equal(timer.pending.size, 1);
	assert.match((h.team.get(lead)!.inbox ?? []).join("\n"), /Helper result\./);
	clock.now += HOUR + 10_000;
	timer.fire();
	await settle();
	assert.equal(h.team.get(lead)!.state, "running");
	assert.match(h.lastCall(lead).text, /The expected reset time has passed\.[\s\S]*Helper result\./);
	await h.team.close();
});

test("a parent blocked on the waiting subagent (wait: true) stops its own work clock until the run goes on", async () => {
	const { h, clock, timer, planFail } = setup();
	const lead = h.spawn("Lead", { model: OPUS, maxMinutes: 30 });
	await tick();
	clock.now += 5 * MIN;
	const helper = h.spawn("Helper", { model: SOL, parent: lead, blocking: true });
	await tick();
	planFail(helper, clock.now + 2 * HOUR);
	await settle();
	assert.equal(h.team.get(helper)!.state, "queued", "a reset past the parent's budget still waits: the parent's clock stops");
	const before = h.team.budgetClock(lead)!.usedMs;
	clock.now += 2 * HOUR + 10_000;
	assert.equal(h.team.budgetClock(lead)!.usedMs, before, "no work time while its subagent waits");
	assert.ok(before >= 5 * MIN && before < 6 * MIN, `${before}`);
	timer.fire();
	await settle();
	assert.equal(h.team.get(helper)!.state, "running");
	clock.now += MIN;
	assert.equal(h.team.budgetClock(lead)!.usedMs, before + MIN, "the clock goes on with the run");
	await h.team.close();
});

test("a parent whose clock still runs: the subagent waits only when the parent's budget outlasts the wait", async () => {
	const { h, clock, timer, planFail } = setup();
	const lead = h.spawn("Lead", { model: OPUS, maxMinutes: 30 });
	await tick();
	const far = h.spawn("Far", { model: SOL, parent: lead });
	const near = h.spawn("Near", { model: SOL, parent: lead });
	await tick();
	clock.now += 5 * MIN;
	planFail(far, clock.now + HOUR);
	const done = await h.team.whenDone(far);
	assert.equal(done.state, "failed");
	assert.match(done.error ?? "", /The parent did not wait for the plan reset: Lead's work clock has 25 minutes left, less than the wait of 61 minutes, and its budget would stop this run\.$/i);
	planFail(near, clock.now + 10 * MIN);
	await settle();
	assert.equal(h.team.get(near)!.state, "queued");
	assert.equal(timer.pending.size, 1);
	await h.team.close();
});

test("a late update through the released session's hooks changes nothing while the run waits", async () => {
	const { h, clock, planFail } = setup();
	const name = h.spawn("Task", { model: SOL, maxCost: 1 });
	await tick();
	const old = h.hooks.get(name)!;
	planFail(name, clock.now + HOUR);
	await settle();
	const held = h.team.get(name)!;
	old.update({ activity: "thinking", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 5 } });
	await settle();
	const after = h.team.get(name)!;
	assert.equal(after.state, "queued");
	assert.equal(after.activity, held.activity);
	assert.equal(after.usage.cost, held.usage.cost);
	await h.team.close();
});

test("the edit lock stays with the waiting run, and a refusal says until when", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "plan-wait-lock-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { h, clock, planFail } = setup(ON, { cwd: dir });
	const writer = h.spawn("Write", { name: "writer", model: SOL });
	const other = h.spawn("Other", { name: "other", model: OPUS });
	await tick();
	assert.equal(h.team.claimEdit(writer, join(dir, "a.txt")), undefined);
	planFail(writer, clock.now + HOUR);
	await settle();
	assert.match(h.team.claimEdit(other, join(dir, "b.txt")) ?? "", /^writer holds the edit lock .* while it waits for the ChatGPT plan reset until 21:00 UTC, and keeps it until its run ends\./);
	await h.team.close();
});

test("a message that ends the wait while every slot is taken says it is queued", async () => {
	const { h, clock, planFail } = setup(ON, { maxConcurrent: 1 });
	const name = h.spawn("Task", { model: SOL });
	await tick();
	planFail(name, clock.now + HOUR);
	await settle();
	const busy = h.spawn("Busy", { model: OPUS });
	await settle();
	assert.equal(h.team.get(busy)!.state, "running");
	const sent = await h.team.send("main", name, "Go on.");
	assert.equal(sent.ok && sent.delivered, "queued");
	assert.equal(h.team.get(name)!.state, "queued");
	await h.team.close();
});

test("the real timer does not hold the process open", () => {
	const handle = REAL_TIMER.set(() => undefined, 60_000) as ReturnType<typeof setTimeout>;
	try { assert.equal(handle.hasRef(), false); }
	finally { REAL_TIMER.clear(handle); }
});

test("a close during the wait clears the timer and leaves the child interrupted with the wait on its row", async () => {
	const { h, clock, timer, planFail } = setup();
	const name = h.spawn("Task", { model: SOL });
	await tick();
	planFail(name, clock.now + HOUR);
	await settle();
	await h.team.close();
	assert.equal(timer.pending.size, 0);
	const record = h.team.get(name)!;
	assert.equal(record.state, "interrupted");
	assert.match(record.activity ?? "", /waiting for the ChatGPT plan reset until 21:00 UTC/);
	assert.equal(record.planWait?.resumeAt, clock.now + HOUR + 10_000);
	const why = recoveryDecision({ ...record, interruptionId: "x", interruptedBy: "quit" }, { reason: "startup", policy: "reload", owner: "o", allowed: new Set([SOL]), moved: false }).why;
	assert.match(why, /It was waiting for the ChatGPT plan reset at 2026-11-17T21:00:00\.000Z\./);
});

test("a parent failure stops its waiting subagent", async () => {
	const { h, clock, timer, planFail } = setup();
	const parent = h.spawn("Lead", { model: OPUS });
	await tick();
	const child = h.spawn("Helper", { model: SOL, parent });
	await tick();
	planFail(child, clock.now + HOUR);
	await settle();
	assert.equal(timer.pending.size, 1);
	h.lastCall(parent).fail(new Error("prompt is too long: 250000 tokens > 200000 maximum"));
	await settle();
	assert.equal(h.team.get(child)!.state, "stopped");
	assert.equal(timer.pending.size, 0);
	await h.team.close();
});

test("the wait survives the index, and a bad one is refused", () => {
	const dir = mkdtempSync(join(tmpdir(), "plan-wait-index-"));
	try {
		const planWait = { run: 1, waits: 1, waitedMs: 0, pausedAt: 5, resetAt: 10, resumeAt: 20, window: "5h" };
		const record = { name: "waiter", parent: "main", depth: 1, model: SOL, task: "t", readOnly: false, fork: false, blocking: false, state: "interrupted" as const,
			createdAt: 1, startedAt: 2, activity: "waiting for the ChatGPT plan reset until 21:00 UTC", runs: 1, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, planWait };
		new ChildIndex(dir, "p", dir).save([record]);
		assert.deepEqual(new ChildIndex(dir, "p", dir).load((message) => assert.fail(message))[0]?.planWait, planWait);
		new ChildIndex(dir, "p", dir).save([{ ...record, planWait: { ...planWait, waits: "1" as never } }]);
		assert.throws(() => new ChildIndex(dir, "p", dir).load((message) => assert.fail(message)), /invalid/i);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("subagentPlanWait: unset follows autoWait, a boolean wins", () => {
	assert.equal(SUBAGENT_PLAN_WAIT_DEFAULT, "autoWait");
	assert.equal(normalizeConfig({}).subagentPlanWait, undefined);
	assert.equal(normalizeConfig({ subagentPlanWait: "yes" }).subagentPlanWait, undefined);
	assert.equal(subagentPlanWaitOn(normalizeConfig({ autoWait: true })), true);
	assert.equal(subagentPlanWaitOn(normalizeConfig({ autoWait: false })), false);
	assert.equal(subagentPlanWaitOn(normalizeConfig({ autoWait: true, subagentPlanWait: false })), false);
	assert.equal(subagentPlanWaitOn(normalizeConfig({ autoWait: false, subagentPlanWait: true })), true);
});

test("the child guard keeps the plan limit of its last reply, and only that one", () => {
	const controller = new AbortController();
	const ctx = { signal: controller.signal, abort: () => controller.abort(), ui: { notify() {} } };
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const guard = createChildRateLimitGuard({ onWarning() {} });
	guard.extension.factory({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler), appendEntry() {} } as never);
	try {
		const resetsAt = Date.now() + HOUR;
		const errorMessage = JSON.stringify({ error: { type: "usage_limit_reached", resets_at: Math.floor(resetsAt / 1000), limit_window_minutes: 300 } });
		const plan = { role: "assistant", provider: "openai-codex", api: "openai-codex-responses", model: "gpt-6.1-sol", timestamp: 0, stopReason: "error", content: [], errorMessage };
		const result = handlers.get("message_end")!({ message: plan }, ctx) as { message: { errorMessage: string } };
		assert.match(result.message.errorMessage, /the 5h window is full/);
		assert.match(result.message.errorMessage, /The subagent's own session never waits\./);
		assert.equal(guard.planLimit()?.kind, "plan");
		assert.equal(guard.planLimit()?.resetAtMs, Math.floor(resetsAt / 1000) * 1000);
		handlers.get("message_end")!({ message: { ...plan, stopReason: "stop", errorMessage: undefined } }, ctx);
		assert.equal(guard.planLimit(), undefined, "a later reply clears it");
	} finally { guard.dispose(); }
});

/** A seeded order of events around one wait: timers, stops, closes and messages leave no timer behind. */
test("event orders: a timer runs only while the record waits, and none outlives a stop or a close", async () => {
	for (let seed = 1; seed <= 60; seed++) {
		let state = seed;
		const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
		const { h, clock, timer, planFail } = setup({ ...ON, maxRecoveries: 3 });
		const lead = h.spawn("Lead", { model: OPUS, maxMinutes: 600 });
		const peer = h.spawn("Peer", { model: OPUS });
		await tick();
		// Every third seed blocks its parent (wait: true), so the parent's clock follows the wait.
		const name = h.spawn("Task", { model: SOL, parent: lead, blocking: seed % 3 === 0 });
		await tick();
		const trace: string[] = [];
		let closed = false;
		for (let step = 0; step < 10 && !closed; step++) {
			const record = h.team.get(name)!;
			const running = record.state === "running" && h.calls.get(name)?.length;
			const events = ["advance", "fire", "message", "parent", "peer", "stop", "close", ...(running ? ["plan", "plan", "finish"] : [])];
			const event = events[Math.floor(random() * events.length)]!;
			trace.push(event);
			const launches = h.launched.length;
			const waitedBefore = record.state === "queued" && record.planWait?.pausedAt !== undefined;
			if (event === "plan") planFail(name, clock.now + HOUR);
			else if (event === "finish") h.lastCall(name).finish("Done.");
			else if (event === "advance") clock.now += 20 * MIN;
			else if (event === "fire") timer.fire();
			else if (event === "message") await h.team.send("main", name, `Note ${step}.`);
			else if (event === "parent") await h.team.send(lead, name, `From the lead ${step}.`);
			else if (event === "peer") await h.team.send(peer, name, `From a peer ${step}.`);
			else if (event === "stop") await h.team.stop(name);
			else { await h.team.close(); closed = true; }
			await settle();
			const after = h.team.get(name)!;
			const waits = after.state === "queued" && after.planWait?.pausedAt !== undefined;
			assert.equal(timer.pending.size, waits ? 1 : 0, `seed ${seed}: ${trace.join(" ")}: ${after.state}`);
			if (after.planWait?.pausedAt !== undefined) assert.ok(after.state === "queued" || after.state === "interrupted", `seed ${seed}: ${trace.join(" ")}: a wait on a ${after.state} record`);
			if (event === "stop" || event === "close") assert.equal(h.launched.length, launches, `seed ${seed}: ${trace.join(" ")}: a launch after ${event}`);
			assert.ok((after.planWait?.waits ?? 0) <= 3);
			// A peer's note never ends a wait.
			if (event === "peer" && waitedBefore) assert.ok(waits && h.launched.length === launches, `seed ${seed}: ${trace.join(" ")}: a peer ended the wait`);
			// The lead's clock stops exactly while its blocking subagent waits.
			const leadClock = h.team.budgetClock(lead);
			if (leadClock && h.team.get(lead)!.state === "running") {
				const before = leadClock.usedMs;
				clock.now += 1;
				const moved = h.team.budgetClock(lead)!.usedMs !== before;
				assert.equal(moved, !(waits && after.blocking), `seed ${seed}: ${trace.join(" ")}: the lead's clock ${moved ? "ran" : "stopped"}`);
			}
		}
		if (!closed) await h.team.close();
		assert.equal(timer.pending.size, 0, `seed ${seed}: ${trace.join(" ")}`);
	}
});
