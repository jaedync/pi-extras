/**
 * A child can't see a clock, and without one it guesses its time used far too
 * high and stops early (scripts/budget-replay.mjs). Each run's first prompt
 * gives its start and end on the wall clock, notes give the work minutes used
 * and left, and a run that goes on or waited is told where it stands.
 */
import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { RunBudgets } from "../lib/subagents/budget.ts";
import { childInstructions, clockNote, runClockHead } from "../lib/subagents/format.ts";
import { Team } from "../lib/subagents/team.ts";
import type { ChildHandle } from "../lib/subagents/types.ts";
import { teamHarness } from "./support/team-harness.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-19T23:37:03.000Z");
const now = () => Date.now();
const PLAN = "Plan so that you can write your report before then. At the limit, tool calls stop and you must report.";
/** Fewer notes than the default, so each test can name each one. */
const SHARES = { progressShares: [0.25, 0.5] };

function clock(t: TestContext): (ms: number) => Promise<void> {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
	return async (ms) => {
		t.mock.timers.tick(ms);
		for (let i = 0; i < 6; i++) await tick();
	};
}

function budgets() {
	const notes: string[] = [];
	const runs = new RunBudgets({ now, over: () => undefined, near: (_name, text) => notes.push(text), notes: SHARES });
	return { runs, notes };
}

test("the head gives the start, the budget, the end if the run does not wait, date -u, and that notes come", () => {
	assert.equal(runClockHead({ now: T0, minutes: 60, notes: true }),
		"[Budget clock] This run started at 23:37 UTC on 2026-10-19 with a time budget of 60 work minutes. If you do not wait, the budget ends at 00:37 UTC on 2026-10-20. If you have a shell, run `date -u` to see the time now. Do not estimate the time from the work you did. Notes during the run give the work minutes used and left.");
	assert.equal(runClockHead({ now: T0 - 30 * MINUTE, minutes: 4 }),
		"[Budget clock] This run started at 23:07 UTC on 2026-10-19 with a time budget of 4 work minutes. If you do not wait, the budget ends at 23:11 UTC. If you have a shell, run `date -u` to see the time now. Do not estimate the time from the work you did.");
});

test("a clock note gives work minutes used and left, tenths under 10, and the end on the wall clock", () => {
	assert.equal(clockNote({ now: T0, usedMs: 2.5 * MINUTE, minutes: 10 }), "[Budget clock] 2.5 of 10 work minutes used, 7.5 left. If you do not wait, the budget ends at 23:44 UTC.");
	assert.equal(clockNote({ now: T0, usedMs: 47.3 * MINUTE, minutes: 120 }), "[Budget clock] 47 of 120 work minutes used, 73 left. If you do not wait, the budget ends at 00:49 UTC on 2026-10-20.");
	assert.equal(clockNote({ now: T0, usedMs: 8 * MINUTE, minutes: 10, plan: true }), `[Budget clock] 8 of 10 work minutes used, 2 left. If you do not wait, the budget ends at 23:39 UTC. ${PLAN}`);
	assert.match(clockNote({ now: T0, usedMs: 11 * MINUTE, minutes: 10 }), /11 of 10 work minutes used, 0 left\. If you do not wait, the budget ends at 23:37 UTC\./);
});

test("the instructions say how the budget counts and where the clock is, and never change between runs", () => {
	const base = { name: "scout", parent: "main", readOnly: false, canSpawn: false, roster: "" };
	assert.match(childInstructions({ ...base, budget: { minutes: 60, cost: 2 } }),
		/## Budget\nThis run may work 60 minutes and spend \$2\.00\. Time counts only while you work, not while you wait for an answer, for your subagents or for a free slot\. The first message of each run gives its start time and the time its budget ends if you do not wait\. Near the end of the cost budget you get a note\. At the limit, tool calls are blocked and you must write your final report at once\./);
	assert.match(childInstructions({ ...base, budget: { minutes: 15 } }), /This run may work 15 minutes\. Time counts only while you work, .* if you do not wait\. At the limit/);
	assert.match(childInstructions({ ...base, budget: { cost: 0.5 } }), /This run may spend \$0\.50\. Near the end of the cost budget you get a note\. At the limit/);
	assert.doesNotMatch(childInstructions({ ...base, budget: { minutes: 60 } }), /\d{2}:\d{2}|UTC|Near the end/, "no wall-clock time in the system prompt");
	assert.doesNotMatch(childInstructions(base), /## Budget/);
});

test("by default a run gets a note at each tenth of its time budget up to 80%; under 5 minutes, none", () => {
	const runs = new RunBudgets({ now: () => T0, over: () => undefined });
	runs.start("scout", { minutes: 60 }, 0);
	assert.deepEqual(runs.clock("scout")?.shares, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
	runs.start("short", { minutes: 4.9 }, 0);
	assert.deepEqual(runs.clock("short")?.shares, []);
	runs.clear();
});

test("a fresh run gets a note at each progress share and at 80% of its time budget; only the last asks for a plan to report", async (t) => {
	const pass = clock(t);
	const { runs, notes } = budgets();
	runs.start("scout", { minutes: 60 }, 0);
	assert.deepEqual(runs.clock("scout"), { usedMs: 0, minutes: 60, shares: [0.25, 0.5, 0.8] });
	await pass(15 * MINUTE - 1);
	assert.deepEqual(notes, []);
	await pass(1);
	assert.deepEqual(notes, ["[Budget clock] 15 of 60 work minutes used, 45 left. If you do not wait, the budget ends at 00:37 UTC on 2026-10-20."]);
	await pass(15 * MINUTE);
	assert.equal(notes[1], "[Budget clock] 30 of 60 work minutes used, 30 left. If you do not wait, the budget ends at 00:37 UTC.");
	await pass(18 * MINUTE);
	assert.equal(notes[2], `[Budget clock] 48 of 60 work minutes used, 12 left. If you do not wait, the budget ends at 00:37 UTC. ${PLAN}`, "after midnight the end is on the same day");
	await pass(11 * MINUTE);
	assert.equal(notes.length, 3);
	runs.clear();
});

test("a paused run: notes count work time only, and a wait of a minute or more ends with a note of the new end", async (t) => {
	const pass = clock(t);
	const { runs, notes } = budgets();
	runs.start("scout", { minutes: 10 }, 0);
	await pass(1 * MINUTE);
	runs.follow("scout", "asking");
	await pass(5 * MINUTE);
	assert.deepEqual(notes, [], "no note while it waits");
	runs.follow("scout", "running");
	assert.deepEqual(notes, ["[Budget clock] 1 of 10 work minutes used, 9 left. If you do not wait, the budget ends at 23:52 UTC."], "the wait moved the end by 5 minutes");
	await pass(1.5 * MINUTE);
	assert.equal(notes[1], "[Budget clock] 2.5 of 10 work minutes used, 7.5 left. If you do not wait, the budget ends at 23:52 UTC.");
	runs.follow("scout", "waiting");
	await pass(59_999);
	runs.follow("scout", "queued");
	runs.follow("scout", "running");
	assert.equal(notes.length, 2, "a wait under a minute gets no note");
	await pass(2.5 * MINUTE);
	assert.match(notes[2] ?? "", /^\[Budget clock\] 5 of 10 work minutes used, 5 left\. If you do not wait, the budget ends at 23:53 UTC\.$/);
	runs.clear();
});

test("a run under 5 minutes gets the clock but no notes, not even after a wait", async (t) => {
	const pass = clock(t);
	const { runs, notes } = budgets();
	runs.start("short", { minutes: 4.9 }, 0);
	assert.deepEqual(runs.clock("short"), { usedMs: 0, minutes: 4.9, shares: [] });
	await pass(MINUTE);
	runs.follow("short", "asking");
	await pass(10 * MINUTE);
	runs.follow("short", "running");
	await pass(3.8 * MINUTE);
	assert.deepEqual(notes, []);
	runs.clear();
});

test("a run with no time budget has no clock and no time notes; its cost note is as before", async (t) => {
	const pass = clock(t);
	const { runs, notes } = budgets();
	runs.start("spender", { cost: 2 }, 0);
	assert.equal(runs.clock("spender"), undefined);
	runs.follow("spender", "asking");
	await pass(10 * MINUTE);
	runs.follow("spender", "running");
	await pass(60 * MINUTE);
	assert.deepEqual(notes, []);
	runs.spent("spender", 1.7);
	assert.deepEqual(notes, ["About $0.30 is left of this run's $2.00 cost budget. Plan so that you can write your report before then. At the limit, tool calls stop and you must report."]);
	runs.start("none", {}, 0);
	assert.equal(runs.clock("none"), undefined);
	runs.clear();
});

test("a run that goes on keeps its used time and the notes it got; a note it passed untold is skipped, but not the last", async (t) => {
	const pass = clock(t);
	const { runs, notes } = budgets();
	runs.start("scout", { minutes: 10 }, 0);
	await pass(3 * MINUTE);
	assert.equal(notes.length, 1);
	const used = runs.used("scout");
	runs.start("scout", { minutes: 10 }, 0, used);
	assert.equal(runs.clock("scout")?.usedMs, 3 * MINUTE);
	await pass(2 * MINUTE);
	assert.equal(notes.length, 2, "the 25% note is not repeated; the 50% note comes at 5 work minutes");
	assert.match(notes[1]!, /^\[Budget clock\] 5 of 10 work minutes used, 5 left\./);
	runs.start("late", { minutes: 10 }, 0, { costAtStart: 0, usedMs: 6 * MINUTE, noted: [] });
	await pass(MINUTE);
	assert.equal(notes.length, 2, "the 25% and 50% notes passed: no late progress note");
	await pass(MINUTE);
	assert.match(notes[2]!, /^\[Budget clock\] 8 of 10 work minutes used, 2 left\..*Plan so that/);
	runs.start("past", { minutes: 10 }, 0, { costAtStart: 0, usedMs: 9 * MINUTE, noted: [] });
	await pass(0);
	assert.match(notes[3]!, /^\[Budget clock\] 9 of 10 work minutes used, 1 left\..*Plan so that/, "the last note comes at once");
	runs.clear();
});

test("a fresh run's first prompt starts with its clock head; a run with no time budget gets none", async (t) => {
	clock(t);
	const h = teamHarness({ budgetTimes: SHARES, now });
	const timed = h.spawn("Read the files.", { name: "timed", maxMinutes: 10 });
	const plain = h.spawn("Read the files.", { name: "plain" });
	await tick(); await tick();
	assert.equal(h.lastCall(timed).text, `${runClockHead({ now: T0, minutes: 10, notes: true })}\n\nRead the files.`);
	assert.equal(h.lastCall(plain).text, "Read the files.");
	await h.team.close();
});

test("a run under 5 minutes gets a head with no notes", async (t) => {
	clock(t);
	const h = teamHarness({ budgetTimes: SHARES, now });
	const name = h.spawn("Look.", { name: "short", maxMinutes: 4 });
	await tick(); await tick();
	assert.equal(h.lastCall(name).text, `${runClockHead({ now: T0, minutes: 4 })}\n\nLook.`);
	assert.doesNotMatch(h.lastCall(name).text, /Notes during/);
	await h.team.close();
});

test("a resumed run gets a fresh head with its new start, then its resume warning", async (t) => {
	const pass = clock(t);
	const h = teamHarness({ now, budgetTimes: { ...SHARES, toolGraceMs: MINUTE, backstopMs: 4 * MINUTE } });
	const name = h.spawn("Work.", { name: "again", maxMinutes: 10 });
	await tick(); await tick();
	await pass(10 * MINUTE);
	h.lastCall(name).finish("Wrap-up report.");
	await tick(); await tick();
	assert.equal(h.team.get(name)?.budgetEnd, "over its 10-minute budget");
	await pass(20 * MINUTE);
	assert.ok((await h.team.send("main", name, "Continue.")).ok);
	await tick(); await tick();
	const text = h.lastCall(name).text;
	assert.ok(text.startsWith(`${runClockHead({ now: T0 + 30 * MINUTE, minutes: 10, notes: true })}\n\n`), text);
	assert.match(text, /This run started at 00:07 UTC on 2026-10-20 .*\n\nYour previous run reached its 10-minute budget and ended with a wrap-up report\. This run has a fresh budget\./s);
	await pass(2.5 * MINUTE);
	assert.match(h.steered.get(name)?.at(-1) ?? "", /^\[Budget clock\] 2\.5 of 10 work minutes used, 7\.5 left\./, "the new run's notes start again");
	await h.team.close();
});

test("a run woken from waiting on its subagents goes on with a clock line, not a head, and keeps its notes", async (t) => {
	const pass = clock(t);
	const h = teamHarness({ budgetTimes: SHARES, now, maxDepth: 3 });
	const lead = h.spawn("Lead.", { name: "lead", maxMinutes: 10 });
	await tick(); await tick();
	// A mocked tick runs a timer with the time at the end of the tick: stop at the note.
	await pass(2.5 * MINUTE);
	await pass(0.5 * MINUTE);
	assert.deepEqual(h.steered.get(lead), ["[Budget clock] 2.5 of 10 work minutes used, 7.5 left. If you do not wait, the budget ends at 23:47 UTC."]);
	const helper = h.spawn("Help.", { name: "helper", parent: lead });
	await tick(); await tick();
	h.lastCall(lead).finish("Waiting for helper.");
	await tick(); await tick();
	assert.equal(h.team.get(lead)?.state, "waiting");
	await pass(20 * MINUTE);
	h.lastCall(helper).finish("Helped.");
	await tick(); await tick(); await tick();
	assert.equal(h.team.get(lead)?.state, "running");
	const text = h.lastCall(lead).text;
	assert.ok(text.startsWith("[Budget clock] 3 of 10 work minutes used, 7 left. If you do not wait, the budget ends at 00:07 UTC.\n\n"), text);
	assert.doesNotMatch(text, /This run started/);
	await pass(2 * MINUTE);
	assert.equal(h.steered.get(lead)?.length, 2, "no second 25% note");
	assert.match(h.steered.get(lead)!.at(-1)!, /^\[Budget clock\] 5 of 10 work minutes used, 5 left\./);
	await h.team.close();
});

test("a run that goes on on a fallback model keeps its clock and gets a clock line", async (t) => {
	const pass = clock(t);
	const h = teamHarness({ budgetTimes: SHARES, now, fallbackModels: ["anthropic/claude-opus-5-5"] });
	const name = h.spawn("Fix it.", { name: "fixer", maxMinutes: 10, model: "openai-codex/gpt-6.1-sol" });
	await tick(); await tick();
	await pass(2.5 * MINUTE);
	await pass(1.5 * MINUTE);
	h.lastCall(name).fail(new Error("You have hit your ChatGPT usage limit (plus plan). Try again in ~154 min."));
	for (let i = 0; i < 12; i++) await tick();
	assert.equal(h.team.get(name)?.model, "anthropic/claude-opus-5-5");
	const text = h.lastCall(name).text;
	assert.ok(text.startsWith("[Budget clock] 4 of 10 work minutes used, 6 left. If you do not wait, the budget ends at 23:47 UTC.\n\nYour model "), text);
	await pass(MINUTE);
	assert.deepEqual(h.steered.get(name)?.map((note) => note.slice(0, 40)), ["[Budget clock] 2.5 of 10 work minutes us", "[Budget clock] 5 of 10 work minutes used"]);
	await h.team.close();
});

test("a run that moves to a new session at a turn keeps its clock and gets a clock line", async (t) => {
	const pass = clock(t);
	const prompts: string[][] = [];
	const resolvers: Array<() => void> = [];
	const transcript: unknown[] = [];
	let launches = 0;
	let stale = false;
	const team = new Team({
		maxConcurrent: 4, maxDepth: 2, replyTimeoutMs: 60_000, warn: () => undefined, deliverToMain: () => undefined, now, budgetTimes: SHARES,
		launcher: {
			async launch(): Promise<ChildHandle> {
				const id = launches++;
				prompts[id] = [];
				return {
					sessionFile: "/sessions/impl.jsonl", stamp: { generation: id, files: [] },
					prompt: (text: string) => new Promise<void>((resolve) => { transcript.push({ role: "user", content: [{ type: "text", text }] }); prompts[id]!.push(text); resolvers[id] = resolve; }),
					steer: () => undefined, abort: async () => undefined, lastText: () => undefined, messages: () => transcript,
					takeQueued: () => [], dispose: async () => undefined,
				};
			},
			current: (handle) => !(stale && handle.stamp?.generation === 0),
			codeCurrent: (handle) => !(stale && handle.stamp?.generation === 0),
		},
	});
	assert.ok(team.spawn({ name: "impl", task: "Task", parent: "main", model: "m", readOnly: false, fork: false, blocking: false, maxMinutes: 10 }).ok);
	for (let i = 0; i < 12; i++) await tick();
	await pass(6 * MINUTE);
	stale = true;
	transcript.push({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] });
	assert.equal((team as unknown as { turnEnded(name: string): boolean }).turnEnded("impl"), true);
	resolvers[0]!();
	for (let i = 0; i < 12; i++) await tick();
	assert.equal(prompts[1]?.length, 1);
	assert.ok(prompts[1]![0]!.startsWith("[Budget clock] 6 of 10 work minutes used, 4 left. If you do not wait, the budget ends at 23:47 UTC.\n\n[Your session moved"), prompts[1]![0]);
	await team.close();
});

test("after a wait on main's answer of a minute or more, the run is steered a note of its new end", async (t) => {
	const pass = clock(t);
	const h = teamHarness({ budgetTimes: SHARES, now, replyTimeoutMs: 10 * MINUTE });
	const name = h.spawn("Ask.", { name: "asker", maxMinutes: 10 });
	await tick(); await tick();
	await pass(MINUTE);
	const asked = h.team.send(name, "main", "Which branch?", { expectReply: true });
	await tick();
	assert.equal(h.team.get(name)?.state, "asking");
	await pass(3 * MINUTE);
	await h.team.send("main", name, "main");
	assert.ok((await asked).ok);
	assert.deepEqual(h.steered.get(name), ["[Budget clock] 1 of 10 work minutes used, 9 left. If you do not wait, the budget ends at 23:50 UTC."]);
	const quick = h.team.send(name, "main", "And the remote?", { expectReply: true });
	await tick();
	await pass(30_000);
	await h.team.send("main", name, "origin");
	assert.ok((await quick).ok);
	assert.equal(h.steered.get(name)?.length, 1, "a wait under a minute moves the end too little for a note");
	await h.team.close();
});
