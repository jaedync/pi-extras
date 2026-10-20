import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { RunBudgets } from "../lib/subagents/budget.ts";
import { teamHarness } from "./support/team-harness.ts";

const MINUTE = 60_000;
/** Fewer notes than the default, so each test can count them. */
const SHARES = { progressShares: [0.25, 0.5] };

/** A mocked tick runs each timer with the time at the end of the tick, so tests stop at each note. */
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
	const runs = new RunBudgets({ now: Date.now, over: (name, reason) => over.push(`${name}: ${reason}`), near: (name, text) => notes.push({ name, text }), notes: SHARES });
	return { runs, notes, over };
}

test("a 5-minute run gets its notes, the last one with about 1 minute left", async (t) => {
	const pass = clock(t);
	const { runs, notes } = budgets();
	runs.start("five", { minutes: 5 }, 0);
	for (const minutes of [1.25, 1.25, 1.5]) await pass(minutes * MINUTE);
	assert.equal(notes.length, 3);
	assert.match(notes[2]?.text ?? "", /^\[Budget clock\] 4 of 5 work minutes used, 1 left\..* Plan so that you can write your report before then\./);
	runs.clear();
});

test("a run that goes on keeps the notes it got: no second note after a fallback, a swap or a wake", async (t) => {
	const pass = clock(t);
	const { runs, notes } = budgets();
	runs.start("scout", { minutes: 10, cost: 1 }, 0);
	for (const minutes of [2.5, 2.5, 3]) await pass(minutes * MINUTE);
	runs.spent("scout", 0.85);
	assert.equal(notes.length, 4, "three time notes and the cost note");
	const used = runs.used("scout");
	runs.start("scout", { minutes: 10, cost: 1 }, 0.85, used);
	runs.spent("scout", 0.9);
	await pass(MINUTE);
	assert.equal(notes.length, 4, "the same run is not told again");
	runs.start("scout", { minutes: 10, cost: 1 }, 0.9);
	for (const minutes of [2.5, 2.5, 3]) await pass(minutes * MINUTE);
	runs.spent("scout", 1.75);
	assert.equal(notes.length, 8, "a new run gets its own notes");
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
	const h = teamHarness({ budgetTimes: SHARES });
	const name = h.spawn("work", { name: "work", maxMinutes: 10 });
	await tick(); await tick();
	for (const minutes of [2.5, 2.5, 3]) await pass(minutes * MINUTE);
	assert.deepEqual(h.steered.get(name), [
		"[Budget clock] 2.5 of 10 work minutes used, 7.5 left. If you do not wait, the budget ends at 00:26 UTC.",
		"[Budget clock] 5 of 10 work minutes used, 5 left. If you do not wait, the budget ends at 00:26 UTC.",
		"[Budget clock] 8 of 10 work minutes used, 2 left. If you do not wait, the budget ends at 00:26 UTC. Plan so that you can write your report before then. At the limit, tool calls stop and you must report.",
	]);
	await h.team.close();
});

test("a note is not steered while the harness runs the child's check: it would become a prompt of its own", async (t) => {
	const pass = clock(t);
	let release!: () => void;
	const h = teamHarness({ budgetTimes: SHARES, check: () => new Promise((resolve) => { release = () => resolve({ exitCode: 0, output: "ok" }); }) });
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
