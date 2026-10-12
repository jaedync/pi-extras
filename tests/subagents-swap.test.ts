/**
 * A swap: a running child whose session went stale moves to a new session at
 * its next safe turn boundary, as the same run (swap.ts). The fake launcher's
 * sessions end their prompt at a boundary only when the team's `turnEnded`
 * says so, as child.ts does through Pi's `finishTurn`.
 */
import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { turnGoesOn } from "../lib/subagents/child.ts";
import { fileIdentity } from "../lib/subagents/stamp.ts";
import { causeWords, staleCauses, SWAP_NOTE, swapDue, type SwapFacts } from "../lib/subagents/swap.ts";
import { Team, type TeamOptions } from "../lib/subagents/team.ts";
import type { AgentRecord, CheckRun, ChildHandle, ChildHooks, MainDelivery, SpawnRequest } from "../lib/subagents/types.ts";

const settled = async () => { for (let i = 0; i < 8; i++) await tick(); };

interface Session {
	readonly name: string;
	readonly hooks: ChildHooks;
	readonly prompts: string[];
	readonly queue: string[];
	resolve?: () => void;
	disposed: boolean;
}

/**
 * Children whose sessions go stale when the test says so: `reload()` moves the
 * generation on, and a session's stamp may name a file. One transcript per
 * child outlives its sessions, as its session file does.
 */
function harness(options: Partial<TeamOptions> & { files?: (name: string) => Array<[string, string]>; check?: () => Promise<CheckRun> } = {}) {
	const { files, check, ...teamOptions } = options;
	let generation = 1;
	const sessions: Session[] = [];
	const transcripts = new Map<string, unknown[]>();
	const main: MainDelivery[] = [];
	const logged: string[] = [];
	const say = (name: string, message: unknown) => { transcripts.set(name, [...(transcripts.get(name) ?? []), message]); };
	const team = new Team({
		maxConcurrent: 4, maxDepth: 2, replyTimeoutMs: 60_000, warn: () => undefined,
		deliverToMain: (delivery) => main.push(delivery),
		log: (message) => logged.push(message),
		launcher: {
			async launch(record: AgentRecord, hooks: ChildHooks): Promise<ChildHandle> {
				const session: Session = { name: record.name, hooks, prompts: [], queue: [], disposed: false };
				sessions.push(session);
				return {
					sessionFile: `/sessions/${record.name}.jsonl`,
					stamp: { generation, files: files?.(record.name) ?? [] },
					prompt: (text) => new Promise<void>((resolve) => {
						say(record.name, { role: "user", content: [{ type: "text", text }] });
						session.prompts.push(text);
						session.resolve = resolve;
					}),
					steer: (text) => { session.queue.push(text); },
					abort: async () => undefined,
					lastText: () => undefined,
					messages: () => transcripts.get(record.name) ?? [],
					takeQueued: () => session.queue.splice(0),
					dispose: async () => { session.disposed = true; },
					...(check ? { check: () => check() } : {}),
				};
			},
			current: (handle) => handle.stamp?.generation === generation && (handle.stamp?.files ?? []).every(([path, identity]) => fileIdentity(path) === identity),
		},
		...teamOptions,
	});
	const spawn = (name: string, extra: Partial<SpawnRequest> = {}) => {
		const result = team.spawn({ name, task: `Task for ${name}`, parent: "main", model: "test/model", readOnly: false, fork: false, blocking: false, ...extra });
		assert.ok(result.ok, !result.ok ? result.error : "");
		return result.record.name;
	};
	const sessionsOf = (name: string) => sessions.filter((session) => session.name === name);
	const current = (name: string) => sessionsOf(name).at(-1)!;
	/** `name` calls `tool`: its transcript shows the call, and its session reports it as it starts. */
	const call = (name: string, tool: string): string => {
		const id = `call-${(transcripts.get(name) ?? []).length}`;
		say(name, { role: "assistant", content: [{ type: "toolCall", id, name: tool, arguments: {} }] });
		current(name).hooks.toolCalled?.(tool);
		return id;
	};
	/** A turn of `name` ended with its tool results in: the session asks the team, and ends its prompt when told to. */
	const boundary = (name: string): boolean => {
		const session = current(name);
		const id = call(name, "bash");
		say(name, { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }] });
		const ends = session.hooks.turnEnded?.() ?? false;
		if (ends) session.resolve!();
		return ends;
	};
	const finish = (name: string, text: string) => {
		say(name, { role: "assistant", content: [{ type: "text", text }] });
		current(name).resolve!();
	};
	const reports = () => main.filter((delivery) => delivery.kind === "report");
	return { team, main, logged, transcripts, spawn, sessionsOf, current, call, boundary, finish, reports, say, reload: () => { generation++; } };
}

test("a stale session moves to a new session at its next turn boundary, as the same run; a current one never moves", async () => {
	const h = harness();
	const name = h.spawn("impl");
	await settled();
	const before = h.team.get(name)!;
	assert.equal(h.boundary(name), false, "its session is current");
	h.reload();
	assert.equal(h.boundary(name), true);
	assert.match(h.team.get(name)!.activity ?? "", /^moving to a new session: new code/);
	await settled();
	const [first, second] = h.sessionsOf(name);
	assert.equal(first!.disposed, true, "the old session is let go");
	assert.deepEqual(second!.prompts, [SWAP_NOTE], "it continues from its last tool result");
	const now = h.team.get(name)!;
	assert.equal(now.state, "running");
	assert.equal(now.runs, 1, "the same run");
	assert.equal(now.startedAt, before.startedAt, "its time counts from where the run began");
	assert.equal(now.runCost, before.runCost);
	assert.deepEqual(h.logged, [`${name}: run 1 moved to a new session at a turn boundary (new code)`]);
	assert.equal(h.boundary(name), false, "the new session is current");
	h.finish(name, "Done.");
	const done = await h.team.whenDone(name);
	assert.equal(done.report, "Done.");
	assert.equal(h.reports().length, 1, "one run, one report");
	await h.team.close();
});

test("a run that reached its answer after the end, when Pi went on to compact, ends there without a move", async () => {
	const h = harness();
	const name = h.spawn("impl");
	await settled();
	h.reload();
	const session = h.current(name);
	assert.equal(session.hooks.turnEnded?.(), true);
	// Pi compacted after the end and asked once more; that turn was the answer, and the end held for it too.
	h.finish(name, "All done.");
	const done = await h.team.whenDone(name);
	assert.equal(done.report, "All done.");
	assert.equal(h.sessionsOf(name).length, 1, "no new session for a run that ended");
	assert.deepEqual(h.logged, []);
	await h.team.close();
});

test("a turn that only wrote text but has steering waiting ends there too, and the steering is the new session's prompt", async () => {
	const h = harness();
	const name = h.spawn("impl");
	await settled();
	assert.deepEqual(await h.team.send("main", name, "One more thing."), { ok: true, delivered: "steered" });
	h.reload();
	h.say(name, { role: "assistant", content: [{ type: "text", text: "Done, I think." }] });
	const session = h.current(name);
	assert.equal(session.hooks.turnEnded?.(), true);
	session.resolve!();
	await settled();
	assert.equal(h.sessionsOf(name).length, 2);
	const prompts = h.current(name).prompts;
	assert.equal(prompts.length, 1);
	assert.match(prompts[0]!, /One more thing\./);
	assert.doesNotMatch(prompts[0]!, /moved to current code/, "the steering is a real prompt");
	h.finish(name, "Done.");
	assert.equal((await h.team.whenDone(name)).unread, undefined);
	await h.team.close();
});

test("steering the old session had not read goes to the new one with the note, nothing lost or doubled", async () => {
	const h = harness();
	const name = h.spawn("impl");
	await settled();
	assert.deepEqual(await h.team.send("main", name, "Also update the README."), { ok: true, delivered: "steered" });
	h.reload();
	assert.equal(h.boundary(name), true);
	// Steered while the old session ends its prompt, before the swap begins.
	assert.deepEqual(await h.team.send("main", name, "And the CHANGELOG."), { ok: true, delivered: "steered" });
	await settled();
	const prompt = h.current(name).prompts.join("\n\n");
	assert.ok(prompt.startsWith(SWAP_NOTE), prompt);
	for (const text of ["Also update the README.", "And the CHANGELOG."]) assert.equal(prompt.split(text).length, 2, `${text} once`);
	assert.equal(h.team.get(name)!.inbox, undefined);
	h.finish(name, "Done.");
	assert.equal((await h.team.whenDone(name)).unread, undefined, "it read both");
	await h.team.close();
});

test("no swap while it asks, while a subagent blocks it, when its model left the scope, or when swapAtTurn is off", async () => {
	const h = harness();
	const asker = h.spawn("asker");
	const lead = h.spawn("lead");
	await settled();
	const asked = h.team.send(asker, "main", "Which branch?", { expectReply: true });
	assert.ok(h.team.spawn({ name: "helper", task: "help", parent: lead, model: "test/model", readOnly: false, fork: false, blocking: true }).ok);
	await settled();
	h.reload();
	assert.equal(h.boundary(asker), false, "a question it waits on");
	assert.equal(h.boundary(lead), false, "a subagent it waits on with wait: true");
	await h.team.send("main", asker, "main");
	assert.ok((await asked).ok);
	assert.equal(h.boundary(asker), true, "free again at the next boundary");
	await h.team.close();
	for (const options of [{ swapAtTurn: false }, { modelAllowed: () => false }] as Array<Partial<TeamOptions>>) {
		const off = harness(options);
		const name = off.spawn("impl");
		await settled();
		off.reload();
		assert.equal(off.boundary(name), false, JSON.stringify(Object.keys(options)));
		off.finish(name, "Done on the old session.");
		assert.equal((await off.team.whenDone(name)).report, "Done on the old session.");
		assert.equal(off.sessionsOf(name).length, 1);
		await off.team.close();
	}
});

test("each cause swaps once a run: a file read again during the new launch does not swap it again; a later change does", async () => {
	const dir = mkdtempSync(join(tmpdir(), "subagents-swap-"));
	try {
		const settings = join(dir, "settings.json");
		writeFileSync(settings, "{}");
		let launches = 0;
		// The second launch read the file while it changed, as stamp.ts `withFiles` marks it: stale at once.
		const h = harness({ files: () => [[settings, launches++ === 1 ? `read-during-launch:${fileIdentity(settings)}` : fileIdentity(settings)]] });
		const name = h.spawn("impl");
		await settled();
		writeFileSync(settings, JSON.stringify({ theme: "dark" }));
		assert.equal(h.boundary(name), true);
		await settled();
		assert.match(h.logged[0] ?? "", /\(settings\.json changed\)$/);
		assert.equal(h.boundary(name), false, "stale for the same cause it swapped for");
		writeFileSync(settings, JSON.stringify({ theme: "light" }));
		assert.equal(h.boundary(name), true, "a new change is a new cause");
		await settled();
		assert.equal(h.sessionsOf(name).length, 3);
		await h.team.close();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a run that swaps keeps its budget clock", async (t: TestContext) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	const pass = async (ms: number) => { t.mock.timers.tick(ms); await settled(); };
	const h = harness();
	const name = h.spawn("impl", { maxMinutes: 0.001 });
	await settled();
	await pass(40);
	h.reload();
	assert.equal(h.boundary(name), true);
	await settled();
	assert.equal(h.team.get(name)!.state, "running");
	await pass(19);
	assert.equal(h.team.get(name)!.state, "running");
	await pass(1);
	assert.equal(h.team.get(name)!.state, "stopped", "40 ms before the swap and 20 after: its 60 ms are used");
	assert.match(h.team.get(name)!.stopReason ?? "", /0\.001-minute budget/);
	await h.team.close();
});

test("a run that swaps keeps its fix rounds, and a stale session goes before the run's next prompt, which the new one gets", async () => {
	const failing = async (): Promise<CheckRun> => ({ exitCode: 1, output: "broken" });
	const h = harness({ check: failing });
	const name = h.spawn("impl", { check: { command: "npm test", fixUntilPass: 2 } });
	await settled();
	h.call(name, "edit");
	h.reload();
	h.finish(name, "Done.");
	await settled();
	const [first, second] = h.sessionsOf(name);
	assert.equal(first!.prompts.length, 1, "the fix round goes to the new session");
	assert.match(second!.prompts[0] ?? "", /^The harness ran your check[\s\S]*fix round 1 of 2/);
	assert.doesNotMatch(second!.prompts[0] ?? "", /moved to current code/, "a real prompt needs no note");
	h.call(name, "edit");
	h.finish(name, "Fixed.");
	await settled();
	assert.match(h.current(name).prompts.at(-1) ?? "", /fix round 2 of 2/, "the count went on across the swap");
	assert.equal(h.team.get(name)!.runs, 1);
	await h.team.close();
});

test("the rules: a running child that waits on no one swaps for a cause it has not swapped for", () => {
	const facts: SwapFacts = { enabled: true, state: "running", asking: false, blocked: false, ending: false, launchable: true, causes: ["code@1"], handled: new Set() };
	assert.equal(swapDue(facts), true);
	for (const change of [{ enabled: false }, { state: "asking" as const }, { state: "waiting" as const }, { asking: true }, { blocked: true }, { ending: true }, { launchable: false }, { causes: [] }, { handled: new Set(["code@1"]) }]) {
		assert.equal(swapDue({ ...facts, ...change }), false, JSON.stringify(change));
	}
	assert.equal(swapDue({ ...facts, causes: ["code@1", "/a/settings.json@1:2:3:4"], handled: new Set(["code@1"]) }), true, "one new cause is enough");
	assert.deepEqual(staleCauses({ generation: 3, files: [] }, false), ["code@3"]);
	assert.deepEqual(staleCauses({ generation: 3, files: [] }, true), []);
	assert.equal(causeWords(["code@3", "/a/.pi/settings.json@x", "/b/models.json@y", "/c/settings.json@z"]), "new code, settings.json, models.json changed");
});

test("a turn goes on, and so may end for a swap, only after a normal reply with tool results or steering waiting, with no tool running", () => {
	const turn = (stopReason: string, results: number) => ({ message: { stopReason }, toolResults: Array.from({ length: results }, () => ({})) });
	const idle = { queued: false, toolsRunning: 0, compacting: false };
	assert.equal(turnGoesOn(turn("toolUse", 1), idle), true);
	assert.equal(turnGoesOn(turn("stop", 0), idle), false, "the run ends here anyway");
	assert.equal(turnGoesOn(turn("stop", 0), { ...idle, queued: true }), true, "steering waits");
	assert.equal(turnGoesOn(turn("error", 0), { ...idle, queued: true }), false);
	assert.equal(turnGoesOn(turn("aborted", 1), idle), false);
	assert.equal(turnGoesOn(turn("toolUse", 1), { ...idle, toolsRunning: 1 }), false);
	assert.equal(turnGoesOn(turn("toolUse", 1), { ...idle, compacting: true }), false);
});

test("the session ends its loop through Pi's finishTurn only when the team says so, and keeps what was steered in from Pi's queue", async () => {
	const { endAtTurn } = await import("../lib/subagents/child.ts");
	let queue = ["steered before the end"];
	const asked: string[] = [];
	const agent = {
		finishTurn: async (turn: { message: { stopReason?: string } }) => { asked.push(`pi:${turn.message.stopReason}`); return turn.message.stopReason === "length" ? { action: "end" } : undefined; },
		hasQueuedMessages: () => queue.length > 0,
		state: { pendingToolCalls: new Set<string>() },
	};
	const session = { agent, isCompacting: false, clearQueue: () => { const steering = queue; queue = []; return { steering, followUp: [] }; } };
	let swap = false;
	const held: string[] = [];
	const turnEnd = endAtTurn(session as never, { update: () => undefined, turnEnded: () => { asked.push("team"); return swap; } }, held);
	const finish = (stopReason: string, results = 1) => (agent.finishTurn as (turn: unknown) => Promise<unknown>)({ message: { stopReason }, toolResults: Array.from({ length: results }, () => ({})), context: {}, newMessages: [] });
	assert.equal(await finish("toolUse"), undefined, "the team says go on");
	assert.equal(await finish("error"), undefined);
	assert.deepEqual(await finish("length"), { action: "end" }, "Pi's own end stands");
	assert.deepEqual(asked, ["pi:toolUse", "team", "pi:error", "pi:length"], "Pi's handlers run first, and the team is asked only where the loop would go on");
	swap = true;
	assert.deepEqual(await finish("toolUse"), { action: "end" });
	assert.equal(turnEnd.ending(), true);
	assert.deepEqual(held, ["steered before the end"], "out of Pi's queue, or Pi would go on to read it");
	assert.equal(queue.length, 0);
	swap = false;
	assert.deepEqual(await finish("stop", 0), { action: "end" }, "a turn Pi runs after the end, to compact, ends too");
	turnEnd.reset();
	assert.equal(turnEnd.ending(), false, "a new prompt starts clean");
	assert.equal(await finish("toolUse"), undefined);
});
