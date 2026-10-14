import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { RunBudgets } from "../lib/subagents/budget.ts";
import { childInstructions } from "../lib/subagents/format.ts";
import { teamHarness } from "./support/team-harness.ts";

const MINUTE = 60_000;

function clock(t: TestContext): (ms: number) => Promise<void> {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	return async (ms) => {
		t.mock.timers.tick(ms);
		for (let i = 0; i < 6; i++) await tick();
	};
}

function budgets() {
	const notes: Array<{ name: string; text: string }> = [];
	const over: string[] = [];
	const runs = new RunBudgets({ now: Date.now, over: (name, reason) => over.push(`${name}: ${reason}`), near: (name, text) => notes.push({ name, text }) });
	return { runs, notes, over };
}

test("the child's instructions name the run's budgets, and only the ones it has", () => {
	const base = { name: "scout", parent: "main", readOnly: false, canSpawn: false, roster: "" };
	const both = childInstructions({ ...base, budget: { minutes: 60, cost: 2 } });
	assert.match(both, /## Budget\nThis run may work 60 minutes \(time counts only while you work\) and spend \$2\.00\. Near the end you get a note\. At the limit, tool calls are blocked and you must write your final report at once\./);
	assert.match(childInstructions({ ...base, budget: { minutes: 15 } }), /This run may work 15 minutes \(time counts only while you work\)\. Near the end/);
	assert.match(childInstructions({ ...base, budget: { cost: 0.5 } }), /This run may spend \$0\.50\. Near the end/);
	assert.doesNotMatch(childInstructions({ ...base, budget: {} }), /## Budget/);
	assert.doesNotMatch(childInstructions(base), /## Budget/);
});

test("a run gets one note at 80% of its time budget", async (t) => {
	const pass = clock(t);
	const { runs, notes } = budgets();
	runs.start("scout", { minutes: 60 }, 0);
	await pass(48 * MINUTE - 1);
	assert.equal(notes.length, 0);
	await pass(1);
	assert.deepEqual(notes, [{ name: "scout", text: "About 12 minutes are left in this run's time budget. Plan so that you can write your report before then. At the limit, tool calls stop and you must report." }]);
	runs.follow("scout", "asking");
	runs.follow("scout", "running");
	await pass(5 * MINUTE);
	assert.equal(notes.length, 1, "one note per run");
	runs.clear();
});

test("time paused while the run asks does not count toward the note", async (t) => {
	const pass = clock(t);
	const { runs, notes } = budgets();
	runs.start("scout", { minutes: 10 }, 0);
	await pass(4 * MINUTE);
	runs.follow("scout", "asking");
	await pass(60 * MINUTE);
	assert.equal(notes.length, 0);
	runs.follow("scout", "running");
	await pass(4 * MINUTE);
	assert.match(notes[0]?.text ?? "", /^About 2 minutes are left/);
	runs.clear();
});

test("a run under 5 minutes gets no time note, and a 5-minute run is told about 1 minute", async (t) => {
	const pass = clock(t);
	const { runs, notes, over } = budgets();
	runs.start("short", { minutes: 4.9 }, 0);
	await pass(4.9 * MINUTE);
	assert.equal(notes.length, 0);
	assert.equal(over.length, 1);
	runs.start("five", { minutes: 5 }, 0);
	await pass(4 * MINUTE);
	assert.match(notes[0]?.text ?? "", /^About 1 minute is left in this run's time budget\./);
	runs.clear();
});

test("a run that goes on keeps the notes it got: no second note after a fallback, a swap or a wake", async (t) => {
	const pass = clock(t);
	const { runs, notes } = budgets();
	runs.start("scout", { minutes: 10, cost: 1 }, 0);
	await pass(8 * MINUTE);
	runs.spent("scout", 0.85);
	assert.equal(notes.length, 2);
	const used = runs.used("scout");
	runs.start("scout", { minutes: 10, cost: 1 }, 0.85, used);
	runs.spent("scout", 0.9);
	await pass(MINUTE);
	assert.equal(notes.length, 2, "the same run is not told again");
	runs.start("scout", { minutes: 10, cost: 1 }, 0.9);
	await pass(8 * MINUTE);
	runs.spent("scout", 1.75);
	assert.equal(notes.length, 4, "a new run gets its own notes");
	runs.clear();
});

test("a run gets one note at 80% of its cost budget, with what is left", () => {
	const { runs, notes } = budgets();
	runs.start("spender", { cost: 2 }, 1);
	runs.spent("spender", 2.5);
	assert.equal(notes.length, 0);
	runs.spent("spender", 2.62);
	assert.deepEqual(notes, [{ name: "spender", text: "About $0.38 is left of this run's $2.00 cost budget. Plan so that you can write your report before then. At the limit, tool calls stop and you must report." }]);
	runs.spent("spender", 2.8);
	assert.equal(notes.length, 1);
	runs.clear();
});

test("the team steers the note into the running child", async (t) => {
	const pass = clock(t);
	const h = teamHarness();
	const name = h.spawn("work", { name: "work", maxMinutes: 10 });
	await tick(); await tick();
	await pass(8 * MINUTE);
	assert.deepEqual(h.steered.get(name), ["About 2 minutes are left in this run's time budget. Plan so that you can write your report before then. At the limit, tool calls stop and you must report."]);
	await h.team.close();
});

test("a note is not steered while the harness runs the child's check: it would become a prompt of its own", async (t) => {
	const pass = clock(t);
	let release!: () => void;
	const h = teamHarness({ check: () => new Promise((resolve) => { release = () => resolve({ exitCode: 0, output: "ok" }); }) });
	const name = h.spawn("work", { name: "work", maxMinutes: 10, check: { command: "npm test", fixUntilPass: 0 } });
	await tick(); await tick();
	h.lastCall(name).finish("Done.");
	await tick(); await tick();
	await pass(8 * MINUTE);
	assert.equal(h.steered.get(name), undefined);
	release();
	assert.equal((await h.team.whenDone(name)).state, "idle");
	await h.team.close();
});
