/**
 * The run log: one line per finished run, with that run's own usage, so
 * `/subagents stats` adds runs up right; private to the user.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { appendRunLog, runLogEntry, statsByModel, statsText } from "../lib/subagents/runlog.ts";
import { Team } from "../lib/subagents/team.ts";
import { type AgentRecord, type ChildHandle, type ChildHooks, LIVE_STATES } from "../lib/subagents/types.ts";

const flush = async () => { for (let i = 0; i < 4; i++) await tick(); };

test("each run's line holds that run's own usage, so three $1 runs add up to $3", async () => {
	let finish: (() => void) | undefined;
	let hooks: ChildHooks | undefined;
	let spent = 0;
	let calls = 0;
	const team = new Team({ maxConcurrent: 2, maxDepth: 1, replyTimeoutMs: 1000, deliverToMain: () => undefined,
		launcher: { async launch(_record: AgentRecord, childHooks: ChildHooks): Promise<ChildHandle> {
			hooks = childHooks;
			const transcript: unknown[] = [];
			return { prompt: () => new Promise<void>((resolve) => { finish = () => {
				// One $1 reply with 2 tool calls per run, as the child's session reports it: running totals.
				spent += 1; calls += 2;
				hooks!.update({ toolCalls: calls, usage: { input: 10 * calls, output: 10, cacheRead: 0, cacheWrite: 0, cost: spent } });
				transcript.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
				resolve();
			}; }),
			steer: () => undefined, abort: async () => undefined, lastText: () => undefined, messages: () => transcript, takeQueued: () => [], dispose: async () => undefined };
		} } });
	const lines = new Map<number, string>();
	team.onChange((record) => { if (record && !LIVE_STATES.has(record.state)) lines.set(record.runs, JSON.stringify(runLogEntry(record, Date.now(), "s"))); });
	assert.ok(team.spawn({ name: "w", task: "t", parent: "main", model: "p/m", readOnly: false, fork: false, blocking: false }).ok);
	for (let run = 1; run <= 3; run++) {
		if (run > 1) await team.send("main", "w", "again");
		await flush();
		finish!();
		await flush();
	}
	const entries = [...lines.values()].map((line) => JSON.parse(line));
	assert.deepEqual(entries.map((entry) => [entry.format, entry.usage.cost, entry.toolCalls, entry.usage.input]), [[2, 1, 2, 20], [2, 1, 2, 20], [2, 1, 2, 20]]);
	const [stats] = statsByModel([...lines.values()]);
	assert.equal(stats!.cost, 3);
	assert.equal(stats!.toolCalls, 6);
});

test("a record saved before runs kept their start writes its totals, and no format", () => {
	const legacy: AgentRecord = { name: "old", parent: "main", depth: 1, task: "t", model: "p/m", readOnly: false, fork: false, blocking: false,
		state: "idle", createdAt: 1, activity: null, toolCalls: 7, usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 2 }, runs: 3 };
	const entry = runLogEntry(legacy, 10, "s");
	assert.equal(entry.format, undefined);
	assert.equal(entry.toolCalls, 7);
});

test("the run log is private: the file is 0600 and its directory 0700", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-extras-runlog-"));
	try {
		const file = join(home, "subagents", "runs.jsonl");
		appendRunLog(file, { model: "p/m" });
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.equal(statSync(join(home, "subagents")).mode & 0o777, 0o700);
		const older = join(home, "older.jsonl");
		writeFileSync(older, "", { mode: 0o644 });
		appendRunLog(older, { model: "p/m" });
		assert.equal(statSync(older).mode & 0o777, 0o600, "a log made before is made private too");
		assert.equal(readFileSync(older, "utf8"), '{"model":"p/m"}\n');
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("a run that reported at its budget is logged with that budget, and stats count it apart from ok runs", () => {
	const base: AgentRecord = { name: "w", parent: "main", depth: 1, task: "t", model: "p/m", readOnly: false, fork: false, blocking: false,
		state: "idle", createdAt: 1, activity: null, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, runs: 1 };
	const entry = runLogEntry({ ...base, budgetEnd: "over its 60-minute budget" }, 10, "s");
	assert.equal(entry.budgetEnd, "over its 60-minute budget");
	assert.equal(runLogEntry(base, 10, "s").budgetEnd, undefined);
	const [stats] = statsByModel([JSON.stringify(entry), JSON.stringify(runLogEntry(base, 10, "s"))]);
	assert.deepEqual([stats!.runs, stats!.ok, stats!.atBudget], [2, 1, 1]);
	assert.match(statsText(statsByModel([JSON.stringify(entry)]), () => "1s", (value) => value.toFixed(2)), /1 run \(1 at budget\)/);
});
