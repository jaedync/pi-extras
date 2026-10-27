import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { collect } from "../lib/status-plus-transcript.ts";
import { clockNote, runClockHead } from "../lib/subagents/format.ts";
import { SWAP_NOTE } from "../lib/subagents/swap.ts";

const T = 1_750_000_000_000;
const iso = (n: number) => new Date(n).toISOString();
const run = "11111111-1111-1111-1111-111111111111";
const other = "22222222-2222-2222-2222-222222222222";
function reply(id: string, provider = "anthropic", start = T, tools = 1, tool = "read") {
	return { type: "message", id, timestamp: iso(start + 1000), message: {
		role: "assistant", provider, model: "model", timestamp: start,
		content: Array.from({ length: tools }, (_, i) => ({ type: "toolCall", id: `${id}-${i}`, name: tool })),
		usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 4, cost: { total: 0.5 } },
	} };
}
const prompt = (id: string, timestamp = T) => ({ type: "message", id, timestamp: iso(timestamp), message: { role: "user", timestamp, content: id } });
const result = (details: unknown, toolName = "subagent", toolCallId = "call") => ({ type: "message", timestamp: iso(T), message: { role: "toolResult", toolName, toolCallId, details } });
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "status-plus-children-"));
	const parent = join(dir, "parent.jsonl");
	const artifacts = join(dir, "subagent-artifacts");
	mkdirSync(artifacts);
	const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
	const session = (rid: string, entries: unknown[], index = 0) => {
		const path = join(dir, "parent", rid, `run-${index}`, "session.jsonl");
		mkdirSync(join(dir, "parent", rid, `run-${index}`), { recursive: true });
		writeFileSync(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
		return path;
	};
	const meta = (rid: string, value: unknown, index = 0) => { const path = join(artifacts, `${rid}_worker_${index}_meta.json`); json(path, value); return path; };
	const stats = (branch: any[], childIndex?: string, entries?: any[]) => collect({ getBranch: () => branch, getSessionDir: () => dir, getSessionFile: () => parent, getChildIndex: () => childIndex,
		...(entries ? { getEntries: () => entries } : {}), costOf: m => m.usage.cost.total });
	return { dir, parent, artifacts, session, meta, json, stats };
}

/** A subagents team index and its children's sessions in its folder, named without run ids. */
function team(f: ReturnType<typeof fixture>) {
	const dir = join(f.dir, "subagents", "parent-session");
	mkdirSync(dir, { recursive: true });
	const index = join(dir, "index.json");
	const records: unknown[] = [];
	const spawn = (name: string, createdAt: number, entries: unknown[], parent = "main", extra: object = {}) => {
		const sessionFile = join(dir, `${iso(createdAt).replace(/[:.]/g, "-")}_${name}_0a1b2c3d.jsonl`);
		writeFileSync(sessionFile, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
		records.push({ name, parent, depth: parent === "main" ? 1 : 2, createdAt, state: "running", model: "openai/model", sessionFile, ...extra });
		f.json(index, { version: 1, parentSession: "parent-session", cwd: f.dir, records });
		return sessionFile;
	};
	return { index, spawn };
}

/** A reply that calls codemode, its batch still running from `start`. */
const scriptCall = (start: number) => reply(`call-${start}`, "anthropic", start - 1000, 1, "codemode");

/** A reply whose tool batch runs from `start` to `end`, with a codemode result whose script called `subagent`. */
function script(start: number, end: number) {
	// Pi stamps every result of a batch when the batch ends, so `durationMs` does not give a result's start.
	return [scriptCall(start), { type: "message", timestamp: iso(end), message: {
		role: "toolResult", toolName: "codemode", toolCallId: `call-${start}-0`, timestamp: end, durationMs: 5, details: { calls: [] },
		// A long task leaves out the arguments, so the call does not name the child.
		nestedCalls: { calls: [{ id: `call-${start}-0/1`, name: "subagent", status: "ok", argumentsBytes: 9000, durationMs: 20 }], complete: false },
	} }];
}

const report = (sessionFile: string) => ({ type: "custom_message", customType: "subagent-report", timestamp: iso(T + 9000), content: "**worker** finished", display: true,
	details: { id: "sa-1", kind: "report", reports: [{ name: "worker", model: "openai/model", state: "idle", cost: .5, toolCalls: 1, sessionFile }] } });

test("a report does not charge a child that this branch did not start", () => {
	const f = fixture();
	const sessionFile = team(f).spawn("worker", T + 1500, [prompt("task", T + 1500), reply("w", "openai", T + 2000)]);
	const stats = f.stats([prompt("parent"), report(sessionFile)]);
	assert.deepEqual([stats.prompts, stats.turns, stats.providers.size], [1, 0, 0]);
});

test("a script's running child is charged through the team index, not its own children or orphans", () => {
	const f = fixture();
	const t = team(f);
	t.spawn("worker", T + 1500, [prompt("task", T + 1500), reply("w", "openai", T + 1600)]);
	// In the window, but started by the child, or found on disk with no call that started it.
	t.spawn("helper", T + 1700, [prompt("help", T + 1700), reply("h", "opencode-go", T + 1800)], "worker");
	t.spawn("orphan", T + 1800, [prompt("lost", T + 1800), reply("o", "opencode-go", T + 1900)], "main", { orphaned: true });
	const stats = f.stats([prompt("parent"), ...script(T + 1000, T + 2000)], t.index);
	assert.equal(stats.providers.get("openai")?.cost, .5);
	assert.equal(stats.providers.has("opencode-go"), false);
	// Without the index, nothing on the branch names them.
	assert.equal(f.stats([prompt("parent"), ...script(T + 1000, T + 2000)]).providers.has("openai"), false);
});

test("a script still running at the branch tip charges the children it started so far", () => {
	const f = fixture();
	const t = team(f);
	t.spawn("worker", T + 1500, [prompt("task", T + 1500), reply("w", "openai", T + 1600)]);
	const later = { type: "custom", customType: "pi-extras.thinking-times", timestamp: iso(T + 1200), data: {} };
	assert.equal(f.stats([prompt("parent"), scriptCall(T + 1000), later], t.index).providers.get("openai")?.cost, .5);
});

test("a script batch that never got results ends at the next message", () => {
	const f = fixture();
	const t = team(f);
	t.spawn("before", T + 1500, [prompt("a", T + 1500), reply("b", "openai", T + 1600)]);
	t.spawn("after", T + 3500, [prompt("c", T + 3500), reply("d", "opencode-go", T + 3600)]);
	const stats = f.stats([prompt("parent"), scriptCall(T + 1000), prompt("after the crash", T + 3000)], t.index);
	assert.equal(stats.providers.get("openai")?.cost, .5);
	assert.equal(stats.providers.has("opencode-go"), false);
});

test("a script call whose result is on another branch ends at that result, not now or at a later prompt", () => {
	const f = fixture();
	const t = team(f);
	t.spawn("during", T + 1500, [prompt("a", T + 1500), reply("b", "openai", T + 1600)]);
	t.spawn("elsewhere", T + 5000, [prompt("c", T + 5000), reply("d", "opencode-go", T + 5100)]);
	const [call, result] = script(T + 1000, T + 2000);
	const file = [prompt("parent"), call, result, prompt("other branch", T + 4000), ...script(T + 4500, T + 5500)];
	// `/tree` to the reply, then a prompt typed from there much later.
	for (const branch of [[prompt("parent"), call], [prompt("parent"), call, prompt("from the tree", T + 60_000)]]) {
		const stats = f.stats(branch, t.index, file);
		assert.equal(stats.providers.get("openai")?.cost, .5);
		assert.equal(stats.providers.has("opencode-go"), false);
	}
});

test("a script call in a reply that was aborted or failed ran no script", () => {
	const f = fixture();
	const t = team(f);
	t.spawn("later", T + 5000, [prompt("c", T + 5000), reply("d", "opencode-go", T + 5100)]);
	for (const stopReason of ["aborted", "error", "length"]) {
		const call = scriptCall(T + 1000);
		const stats = f.stats([prompt("parent"), { ...call, message: { ...call.message, stopReason } }], t.index);
		assert.equal(stats.providers.has("opencode-go"), false);
	}
});

test("a user shell command during a running script does not end its batch", () => {
	const f = fixture();
	const t = team(f);
	t.spawn("worker", T + 3000, [prompt("a", T + 3000), reply("b", "openai", T + 3100)]);
	const shell = { type: "message", timestamp: iso(T + 2000), message: { role: "bashExecution", command: "ls", output: "", timestamp: T + 2000 } };
	assert.equal(f.stats([prompt("parent"), scriptCall(T + 1000), shell], t.index).providers.get("openai")?.cost, .5);
});

test("a direct start, a script in the same batch and the report charge one child once", () => {
	const f = fixture();
	const t = team(f);
	const sessionFile = t.spawn("worker", T + 1500, [prompt("task", T + 1500), reply("w", "openai", T + 1600)]);
	const [call, codemode] = script(T + 1000, T + 2000);
	const direct = result({ name: "worker", model: "openai/model", sessionFile, wait: false }, "subagent", "spawn");
	const stats = f.stats([prompt("parent"), call, direct, codemode, report(sessionFile)], t.index);
	assert.deepEqual([stats.prompts, stats.turns], [2, 2]);
	assert.equal(stats.providers.get("openai")?.cost, .5);
});

/** The first prompt of a child's run, as team.ts `run` writes it. */
const runStart = (id: string, at: number) => ({ type: "message", id, timestamp: iso(at), message: { role: "user", timestamp: at, content: [{ type: "text", text: `${runClockHead({ now: at, minutes: 60 })}\n\n${id}` }] } });

/** Main's `message` call at `at` and its result: direct, or nested in a codemode script. */
function resume(to: string, at: number, how: "direct" | "script" | "long" = "direct", delivered = "resumed", end = at + 100) {
	const call = reply(`msg-${at}`, "anthropic", at - 1000, 1, how === "direct" ? "message" : "codemode");
	// Pi leaves out a nested call's arguments over 8 KiB, so a long message does not name the child.
	const nested = how === "long" ? { argumentsBytes: 9000 } : { arguments: { to, text: "go on" } };
	const message = how === "direct"
		? { role: "toolResult", toolName: "message", toolCallId: `msg-${at}-0`, details: { to, delivered } }
		: { role: "toolResult", toolName: "codemode", toolCallId: `msg-${at}-0`, details: { calls: [] },
			nestedCalls: { calls: [{ id: `msg-${at}-0/1`, name: "message", status: "ok", ...nested }], complete: how !== "long" } };
	return [call, { type: "message", id: `msg-${at}-result`, timestamp: iso(end), message }];
}

test("a resumed child's runs count on the branch that started each run, not its whole session on each", () => {
	// A script that waits for run 1 to end, then resumes the child.
	for (const [how, at] of [["direct", T + 5000], ["script", T + 5000], ["script", T + 2200]] as const) {
		const f = fixture();
		const t = team(f);
		// Run 1 from a script on branch A; run 2 from main's message on branch B, after /undo.
		t.spawn("worker", T + 1500, [runStart("task", T + 1500), reply("w1", "openai", T + 1600), runStart("again", T + 5200), reply("w2", "openai", T + 5300)]);
		const a = [prompt("parent"), ...script(T + 1000, T + 2000)];
		const b = [prompt("parent"), prompt("other way", T + 2100), ...resume("worker", at, how, "resumed", T + 5100)];
		const file = [...a, ...b.slice(1)];
		assert.equal(f.stats(a, t.index, file).providers.get("openai")?.cost, .5, `${how} at ${at}: branch A`);
		assert.equal(f.stats(b, t.index, file).providers.get("openai")?.cost, .5, `${how} at ${at}: branch B`);
	}
});

test("one message call starts at most one run, and a later call claims the run after it", () => {
	const f = fixture();
	const t = team(f);
	t.spawn("worker", T + 1500, [runStart("task", T + 1500), reply("w1", "openai", T + 1600), runStart("again", T + 5200), reply("w2", "openai", T + 5300),
		runStart("third", T + 9000), reply("w3", "openai", T + 9100)]);
	const spawn = script(T + 1000, T + 2000);
	const b = [prompt("parent"), prompt("other way", T + 8000), ...resume("worker", T + 8500)];
	const file = (a: any[]) => [...a, ...b.slice(1)];
	// A script on A resumes run 2 and ends after it, or a direct call's batch does; B resumes run 3.
	for (const how of ["script", "direct"] as const) {
		const a = [prompt("parent"), ...spawn, prompt("resume", T + 4000), ...resume("worker", T + 5000, how, "resumed", T + 7000)];
		assert.equal(f.stats(a, t.index, file(a)).providers.get("openai")?.cost, 1, `${how}: branch A`);
		assert.equal(f.stats(b, t.index, file(a)).providers.get("openai")?.cost, .5, `${how}: branch B`);
	}
});

test("a script that steered run 1 and ended after it does not take run 2 from the branch that resumed it", () => {
	const f = fixture();
	const t = team(f);
	t.spawn("worker", T + 1500, [runStart("task", T + 1500), reply("w1", "openai", T + 1600), runStart("again", T + 5200), reply("w2", "openai", T + 5300)]);
	const [call, result] = script(T + 1000, T + 3000) as any[];
	const steer = { id: `call-${T + 1000}-0/2`, name: "message", status: "ok", arguments: { to: "worker", text: "also this" } };
	const a = [prompt("parent"), call, { ...result, message: { ...result.message, nestedCalls: { ...result.message.nestedCalls, calls: [...result.message.nestedCalls.calls, steer] } } }];
	const b = [prompt("parent"), prompt("other way", T + 4000), ...resume("worker", T + 5000)];
	const file = [...a, ...b.slice(1)];
	assert.equal(f.stats(a, t.index, file).providers.get("openai")?.cost, .5);
	assert.equal(f.stats(b, t.index, file).providers.get("openai")?.cost, .5);
});

test("a script's message too long to keep its arguments resumes the child whose run starts in its batch", () => {
	const f = fixture();
	const t = team(f);
	t.spawn("worker", T + 1500, [runStart("task", T + 1500), reply("w1", "openai", T + 1600), runStart("again", T + 5200), reply("w2", "openai", T + 5300)]);
	t.spawn("idle", T + 1600, [runStart("other", T + 1600), reply("i1", "opencode-go", T + 1700)], "main", {});
	const a = [prompt("parent"), ...script(T + 1000, T + 2000)];
	const b = [prompt("parent"), prompt("other way", T + 4000), ...resume("worker", T + 5000, "long", "resumed", T + 5300)];
	const file = [...a, ...b.slice(1)];
	assert.equal(f.stats(a, t.index, file).providers.get("openai")?.cost, .5);
	const onB = f.stats(b, t.index, file);
	assert.equal(onB.providers.get("openai")?.cost, .5);
	assert.equal(onB.providers.has("opencode-go"), false);
});

/** One batch on main whose script sends `calls` (`message` arguments, or undefined for one too long to keep), from `from` to `to`. */
function messages(from: number, to: number, calls: Array<object | undefined>) {
	const call = reply(`batch-${from}`, "anthropic", from - 1000, 1, "codemode");
	const nested = calls.map((args, i) => ({ id: `batch-${from}-0/${i}`, name: "message", status: "ok", ...(args ? { arguments: args } : { argumentsBytes: 9000 }) }));
	return [call, { type: "message", id: `batch-${from}-result`, timestamp: iso(to), message: { role: "toolResult", toolName: "codemode", toolCallId: `batch-${from}-0`,
		details: { calls: [] }, nestedCalls: { calls: nested, complete: calls.every(Boolean) } } }];
}

test("a message that names no child resumes one run, the same on every branch, whichever child a walk reads first", () => {
	const f = fixture();
	const t = team(f);
	// y from a script on A; x from a direct call on A. B's long message resumes y; a peer resumes x in that batch.
	t.spawn("y", T + 1500, [runStart("y1", T + 1500), reply("y1", "openai", T + 1600), runStart("y2", T + 5200), reply("y2", "openai", T + 5300)]);
	const x = t.spawn("x", T + 3000, [runStart("x1", T + 3000), reply("x1", "opencode-go", T + 3100), runStart("x2", T + 5400), reply("x2", "opencode-go", T + 5500)]);
	const a = [prompt("parent"), ...script(T + 1000, T + 2000), result({ name: "x", model: "opencode-go/model", sessionFile: x, wait: false }, "subagent", "spawn-x")];
	const b = [prompt("parent"), prompt("other way", T + 4000), ...messages(T + 5000, T + 7000, [undefined])];
	const file = [...a, ...b.slice(1)];
	const [onA, onB] = [f.stats(a, t.index, file), f.stats(b, t.index, file)];
	assert.deepEqual([onA.providers.get("openai")?.cost, onA.providers.get("opencode-go")?.cost], [.5, 1]);
	assert.deepEqual([onB.providers.get("openai")?.cost, onB.providers.has("opencode-go")], [.5, false]);
});

test("a message that names its child explains that run, so the batch's nameless message resumes the other child", () => {
	const f = fixture();
	const t = team(f);
	t.spawn("x", T + 1500, [runStart("x1", T + 1500), reply("x1", "opencode-go", T + 1600), runStart("x2", T + 5200), reply("x2", "opencode-go", T + 5300)]);
	t.spawn("y", T + 1600, [runStart("y1", T + 1600), reply("y1", "openai", T + 1700), runStart("y2", T + 5300), reply("y2", "openai", T + 5400)]);
	const a = [prompt("parent"), ...script(T + 1000, T + 2000)];
	const b = [prompt("parent"), prompt("other way", T + 4000), ...messages(T + 5000, T + 7000, [{ to: "x", text: "go on" }, undefined])];
	const file = [...a, ...b.slice(1)];
	for (const branch of [a, b]) {
		const stats = f.stats(branch, t.index, file);
		assert.deepEqual([stats.providers.get("openai")?.cost, stats.providers.get("opencode-go")?.cost], [.5, .5]);
	}
});

test("a direct spawn recorded at its session's old folder is one child with the index's copy, so a nameless resume counts once", () => {
	const f = fixture();
	const t = team(f);
	const entries = [runStart("x1", T + 1500), reply("x1", "openai", T + 1600), runStart("x2", T + 5200), reply("x2", "openai", T + 5300)];
	const now = t.spawn("x", T + 1500, entries);
	// The folder was copied: the spawn's result still names the old path, and the index is rebased to the new one.
	const old = join(f.dir, "old-folder", basename(now));
	mkdirSync(dirname(old), { recursive: true });
	writeFileSync(old, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
	const a = [prompt("parent"), result({ name: "x", model: "openai/model", sessionFile: old, wait: false }, "subagent", "spawn-x")];
	const b = [prompt("parent"), prompt("other way", T + 4000), ...messages(T + 5000, T + 7000, [undefined])];
	const file = [...a, ...b.slice(1)];
	assert.equal(f.stats(a, t.index, file).providers.get("openai")?.cost, .5);
	assert.equal(f.stats(b, t.index, file).providers.get("openai")?.cost, .5);
});

test("a nameless message does not read a child whose last run ended before its batch", () => {
	const f = fixture();
	const t = team(f);
	// The index says z ended before the batch; a run its file shows in the batch is not read.
	t.spawn("z", T + 1500, [runStart("z1", T + 1500), reply("z1", "openai", T + 1600), runStart("z2", T + 5200), reply("z2", "openai", T + 5300)], "main",
		{ state: "idle", endedAt: T + 3000 });
	const b = [prompt("parent"), prompt("other way", T + 4000), ...messages(T + 5000, T + 7000, [undefined])];
	assert.equal(f.stats(b, t.index, b).providers.has("openai"), false);
	t.spawn("live", T + 1600, [runStart("l1", T + 1600), reply("l1", "opencode-go", T + 1700), runStart("l2", T + 5200), reply("l2", "opencode-go", T + 5300)], "main",
		{ state: "running", endedAt: T + 3000 });
	assert.equal(f.stats(b, t.index, b).providers.get("opencode-go")?.cost, .5);
});

test("what a child writes at its relaunch before the run's prompt does not end the run before it", () => {
	const f = fixture();
	const t = team(f);
	const change = { type: "model_change", id: "mc", timestamp: iso(T + 5150), provider: "openai", modelId: "model" };
	const thinking = { type: "thinking_level_change", id: "tl", timestamp: iso(T + 5160), thinkingLevel: "high" };
	t.spawn("worker", T + 1500, [runStart("task", T + 1500), reply("w1", "openai", T + 1600), change, thinking, runStart("again", T + 5200), reply("w2", "openai", T + 5300)]);
	const a = [prompt("parent"), ...script(T + 1000, T + 2000)];
	const b = [prompt("parent"), prompt("other way", T + 4000), ...resume("worker", T + 5000)];
	const file = [...a, ...b.slice(1)];
	assert.equal(f.stats(a, t.index, file).providers.get("openai")?.cost, .5);
	assert.equal(f.stats(b, t.index, file).providers.get("openai")?.cost, .5);
});

test("a run that main did not start counts on the branch that spawned the child", () => {
	const f = fixture();
	const t = team(f);
	// Run 2 from main's message on branch B; run 3 an auto-resume after a restore, or a peer's message.
	t.spawn("worker", T + 1500, [runStart("task", T + 1500), reply("w1", "openai", T + 1600), runStart("again", T + 5200), reply("w2", "openai", T + 5300),
		runStart("restored", T + 9000), reply("w3", "openai", T + 9100)]);
	const a = [prompt("parent"), ...script(T + 1000, T + 2000)];
	// A message to a running child steers its run; it starts none.
	const b = [prompt("parent"), prompt("other way", T + 4000), ...resume("worker", T + 5000), ...resume("worker", T + 5250, "direct", "steered")];
	const file = [...a, ...b.slice(1)];
	assert.equal(f.stats(a, t.index, file).providers.get("openai")?.cost, 1);
	assert.equal(f.stats(b, t.index, file).providers.get("openai")?.cost, .5);
});

test("a run that moved to a new session or model is still one run, charged once", () => {
	const f = fixture();
	const t = team(f);
	// Run 2 moves at a turn boundary (swap.ts) and falls back to another model: both go on in the same session file.
	const moved = { type: "message", id: "moved", timestamp: iso(T + 6400), message: { role: "user", timestamp: T + 6400,
		content: `${clockNote({ now: T + 6400, usedMs: 200, minutes: 60 })}\n\n${SWAP_NOTE}` } };
	const tool = { type: "message", id: "tool", timestamp: iso(T + 6350), message: { role: "toolResult", toolName: "read", toolCallId: "w2-0", content: [] } };
	t.spawn("worker", T + 1500, [runStart("task", T + 1500), reply("w1", "openai", T + 1600), runStart("again", T + 5200), reply("w2", "openai", T + 5300), tool,
		moved, reply("w3", "opencode-go", T + 6500)]);
	const a = [prompt("parent"), ...script(T + 1000, T + 2000)];
	const b = [prompt("parent"), prompt("other way", T + 4000), ...resume("worker", T + 5000)];
	const file = [...a, ...b.slice(1)];
	const [onA, onB] = [f.stats(a, t.index, file), f.stats(b, t.index, file)];
	assert.equal(onA.providers.get("openai")?.cost, .5);
	assert.equal(onA.providers.has("opencode-go"), false);
	assert.equal(onB.providers.get("openai")?.cost, .5);
	assert.equal(onB.providers.get("opencode-go")?.cost, .5);
});

test("a child that a script started on a branch /undo removed is not charged", () => {
	const f = fixture();
	const t = team(f);
	t.spawn("old", T + 1500, [prompt("old", T + 1500), reply("o", "opencode-go", T + 1600)]);
	t.spawn("new", T + 5500, [prompt("new", T + 5500), reply("n", "openai", T + 5600)]);
	assert.equal(f.stats([prompt("parent"), ...script(T + 1000, T + 2000)], t.index).providers.get("opencode-go")?.cost, .5);
	const stats = f.stats([prompt("parent"), prompt("again", T + 4000), ...script(T + 5000, T + 6000)], t.index);
	assert.equal(stats.providers.get("openai")?.cost, .5);
	assert.equal(stats.providers.has("opencode-go"), false);
	assert.equal(f.stats([prompt("parent")], t.index).providers.size, 0);
});

test("combined parent and parallel children sum request spans, leaving parent cache state alone", () => {
	const f = fixture();
	f.session(run, [prompt("child"), reply("child-a", "openai", T + 2000, 2)]);
	f.session(other, [prompt("child2"), reply("child-b", "openai", T + 2000, 3)]);
	const stats = f.stats([prompt("parent"), reply("parent-a"), result({ workflowChildren: { children: [{ runId: run }, { runId: other }] } })]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [3, 3, 6]);
	assert.deepEqual(stats.tokens, { input: 30, output: 6, cacheRead: 90, cacheWrite: 12 });
	assert.deepEqual(stats.providers.get("openai"), { cost: 1, airtimeMs: 2000, inputTokens: 88, outputTokens: 4 });
	assert.equal(stats.lastApiEndMs, T + 1000);
	assert.equal(stats.cacheHitPct, 30 / 44 * 100);
});

test("inline, status, notification and metadata refer to one child, not four", () => {
	const f = fixture();
	const sessionFile = f.session(run, [prompt("child"), reply("a")]);
	const metadataPath = f.meta(run, { model: "anthropic/model", usage: { turns: 1, input: 10, output: 2, cacheRead: 30, cacheWrite: 4, cost: .5 }, toolCount: 1, sessionFile });
	const child = { index: 0, agent: "worker", sessionFile, artifactPaths: { metadataPath }, usage: { turns: 1, cost: .5 } };
	const stats = f.stats([result({ runId: run, results: [child] }), result({ runId: run, results: [child] }, "subagent_status"), { type: "custom_message", timestamp: iso(T), customType: "subagent-notify", content: `run ${run} finished` }]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [1, 1, 1]);
	assert.equal(stats.providers.get("anthropic")?.cost, .5);
});

test("metadata-only fallback includes available totals, never wall time or invented prompts", () => {
	const f = fixture();
	f.meta(run, { model: "openai/model", usage: { turns: 9, input: 12, output: 3, cacheRead: 4, cacheWrite: 5, cost: 2 }, toolCount: 7, durationMs: 999999 });
	const stats = f.stats([result({ runId: run })]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [0, 9, 7]);
	assert.deepEqual(stats.tokens, { input: 12, output: 3, cacheRead: 4, cacheWrite: 5 });
	// A single-model summary attributes its token totals to that provider, like its cost.
	assert.deepEqual(stats.providers.get("openai"), { cost: 2, airtimeMs: 0, inputTokens: 21, outputTokens: 3 });
});

test("missing and partial metadata and growing sessions are retried", () => {
	const f = fixture();
	const branch = [result({ runId: run })];
	assert.equal(f.stats(branch).turns, 0);
	const file = f.meta(run, {});
	writeFileSync(file, '{"usage":');
	assert.equal(f.stats(branch).turns, 0);
	f.meta(run, { model: "anthropic/model", usage: { turns: 1, cost: .5 } });
	assert.equal(f.stats(branch).turns, 1);
	const path = f.session(run, [prompt("child"), reply("a")]);
	assert.equal(f.stats(branch).prompts, 1);
	appendFileSync(path, JSON.stringify(reply("b", "anthropic", T + 2000)) + "\n");
	assert.equal(f.stats(branch).turns, 2);
});

test("fork history, resumed sessions and nested cycles count each request once", () => {
	const f = fixture();
	const inherited = [prompt("parent"), reply("parent-a")];
	const nested = result({ runId: other });
	const child = [...inherited, prompt("child", T + 2000), reply("child-a", "openai", T + 2000), nested];
	f.session(run, child);
	f.session(run, [...child, reply("resume", "openai", T + 3000)], 1);
	f.session(other, [...child, prompt("nested", T + 4000), reply("nested-a", "openai", T + 4000), result({ runId: run })]);
	const stats = f.stats([...inherited, result({ workflowChildren: { children: [{ runId: run }, { runId: other }] } })]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [3, 4, 4]);
	assert.equal(stats.providers.get("openai")?.cost, 1.5);
});

test("legacy results without index count messages and dedup tool result replay", () => {
	const f = fixture();
	const details = { results: [{ agent: "worker", step: 1, model: "anthropic/model", messages: [prompt("p").message, reply("a").message], usage: { turns: 1, cost: .5 } }] };
	const stats = f.stats([result(details), result(details)]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [1, 1, 1]);
	assert.deepEqual(stats.providers.get("anthropic"), { cost: .5, airtimeMs: 0, inputTokens: 44, outputTokens: 2 });
});

test("artifact initial_prompt is not an extra prompt; tool events do not duplicate assistant tools", () => {
	const f = fixture();
	const transcriptPath = join(f.artifacts, `${run}_worker_0_transcript.jsonl`);
	const a = reply("a");
	writeFileSync(transcriptPath, [
		{ recordType: "message", sourceEventType: "initial_prompt", message: { role: "user", content: "p" }, timestamp: iso(T) },
		{ recordType: "message", sourceEventType: "message_end", message: prompt("p").message, timestamp: iso(T) },
		{ recordType: "message", sourceEventType: "message_end", message: a.message, timestamp: a.timestamp },
		{ recordType: "tool_start", toolName: "read", toolCallId: "a-0" },
	].map(e => JSON.stringify(e)).join("\n"));
	const stats = f.stats([result({ runId: run })]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [1, 1, 1]);
	assert.deepEqual(stats.providers.get("anthropic"), { cost: .5, airtimeMs: 1000, inputTokens: 44, outputTokens: 2 });
});

test("workflow JSON notifications discover structured runIds, not arbitrary output UUIDs", () => {
	const f = fixture();
	f.meta(run, { model: "anthropic/model", usage: { cost: 1, turns: 1 } });
	f.meta(other, { model: "anthropic/model", usage: { cost: 50, turns: 50 } });
	const stats = f.stats([{ type: "custom_message", timestamp: iso(T), customType: "subagent-notify", content: `Background task completed: **workflow**\nWorkflow completed with 1 child run(s). Return: ${JSON.stringify({ implementation: [{ runId: run, agent: "worker", output: `Unrelated ${other}` }] })}` }]);
	assert.equal(stats.turns, 1);
	assert.equal(stats.providers.get("anthropic")?.cost, 1);
	assert.equal(f.stats([prompt(other)]).turns, 0);
});

test("model-attempt fallback splits provider costs without adding attempts twice", () => {
	const f = fixture();
	f.meta(run, { model: "openai/model", usage: { cost: 3, turns: 5 }, modelAttempts: [
		{ model: "anthropic/model", usage: { cost: 1, turns: 2 } },
		{ model: "openai/model", usage: { cost: 2, turns: 3 } },
	] });
	const stats = f.stats([result({ runId: run })]);
	assert.equal(stats.turns, 5);
	assert.equal(stats.providers.get("anthropic")?.cost, 1);
	assert.equal(stats.providers.get("openai")?.cost, 2);
});

test("same run parallel indices retain every child's metadata", () => {
	const f = fixture();
	f.meta(run, { model: "anthropic/m", usage: { cost: 1, turns: 2 }, toolCount: 3 });
	f.meta(run, { model: "openai/m", usage: { cost: 2, turns: 4 }, toolCount: 5 }, 1);
	const stats = f.stats([result({ runId: run, results: [{ index: 0, agent: "worker", model: "anthropic/m", usage: { cost: 1 } }] })]);
	assert.deepEqual([stats.turns, stats.toolCalls], [6, 8]);
	assert.equal(stats.providers.get("openai")?.cost, 2);
});

test("resumed run aliases sharing a native file do not add their summaries again", () => {
	const f = fixture();
	const sessionFile = f.session(run, [prompt("p"), reply("a")]);
	const details = (runId: string) => ({ runId, results: [{ agent: "worker", index: 0, sessionFile, model: "anthropic/m", usage: { cost: .5, turns: 1 } }] });
	const stats = f.stats([result(details(run)), result(details(other), "subagent_wait", "wait")]);
	assert.deepEqual([stats.turns, stats.prompts, stats.toolCalls], [1, 1, 1]);
	assert.equal(stats.providers.get("anthropic")?.cost, .5);
});

test("linked async workflow inventory updates while the parent branch stays unchanged", () => {
	const f = fixture();
	const asyncDir = join(f.dir, "async-workflow");
	mkdirSync(asyncDir);
	const branch = [result({ runId: other, asyncDir, mode: "workflow", results: [] })];
	f.json(join(asyncDir, "status.json"), { workflowChildren: { children: [] } });
	assert.equal(f.stats(branch).turns, 0);
	f.session(run, [prompt("p"), reply("a")]);
	f.json(join(asyncDir, "status.json"), { workflowChildren: { children: [{ runId: run, agent: "worker" }] } });
	assert.equal(f.stats(branch).turns, 1);
	assert.equal(f.stats([]).turns, 0); // undo/switch must not retain cached totals
});

test("workflow return values can use arbitrary keys but not prose run references", () => {
	const f = fixture();
	f.meta(run, { model: "anthropic/m", usage: { cost: 1, turns: 1 } });
	f.meta(other, { model: "anthropic/m", usage: { cost: 99, turns: 99 } });
	const content = `Workflow completed. Return: ${JSON.stringify({ customLane: [{ runId: run, agent: "worker", output: `run ${other} finished` }] })}`;
	const stats = f.stats([{ type: "custom_message", customType: "subagent-notify", timestamp: iso(T), content }]);
	assert.equal(stats.turns, 1);
});

test("artifact supplements a partial native session without duplicating its messages", () => {
	const f = fixture();
	const a = reply("a");
	const b = reply("b", "openai", T + 2000);
	f.session(run, [prompt("p"), a]);
	const path = join(f.artifacts, `${run}_worker_0_transcript.jsonl`);
	writeFileSync(path, [prompt("p"), a, b].map(e => JSON.stringify({ recordType: "message", sourceEventType: "message_end", timestamp: e.timestamp, message: e.message })).join("\n"));
	const stats = f.stats([result({ runId: run })]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [1, 2, 2]);
	assert.equal(stats.providers.get("openai")?.airtimeMs, 1000);
});

test("child billing markers stay attributable and do not reset the parent's cache", () => {
	const f = fixture();
	f.session(run, [reply("a", "opencode-go", T + 2000), { type: "custom", customType: "status-plus-billing-source", timestamp: iso(T + 2000), data: { provider: "opencode", messageTimestampMs: T + 2000 } }, { type: "compaction", timestamp: iso(T + 4000) }]);
	const stats = f.stats([reply("parent"), result({ runId: run })]);
	assert.equal(stats.providers.get("opencode")?.cost, .5);
	assert.equal(stats.lastContextResetMs, undefined);
	assert.equal(stats.lastApiEndMs, T + 1000);
});

test("fork header excludes inherited history even when it is not on the current parent branch", () => {
	const f = fixture();
	f.session(run, [{ type: "session", id: "child", timestamp: iso(T + 2000), parentSession: f.parent }, prompt("old-parent"), reply("old-parent"), result({ runId: other }), prompt("child", T + 3000), reply("new", "openai", T + 3000)]);
	f.meta(other, { model: "anthropic/m", usage: { cost: 99, turns: 99 } });
	const stats = f.stats([result({ runId: run })]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [1, 1, 1]);
	assert.equal(stats.providers.has("anthropic"), false);
});

test("missing earlier attempt is attributed to its provider, not the last model", () => {
	const f = fixture();
	f.session(run, [reply("final", "openai")]);
	f.meta(run, { model: "openai/m", usage: { cost: 1.5, turns: 2 }, modelAttempts: [
		{ model: "anthropic/m", usage: { cost: 1, turns: 1 } },
		{ model: "openai/m", usage: { cost: .5, turns: 1 } },
	] });
	const stats = f.stats([result({ runId: run })]);
	assert.equal(stats.providers.get("anthropic")?.cost, 1);
	assert.equal(stats.providers.get("openai")?.cost, .5);
});

test("current notification correlation lines discover children without harvesting output UUIDs", () => {
	const f = fixture();
	f.meta(run, { model: "anthropic/m", usage: { cost: 1, turns: 1 } });
	f.meta(other, { model: "anthropic/m", usage: { cost: 99, turns: 99 } });
	const stats = f.stats([{ type: "custom_message", customType: "subagent-notify", timestamp: iso(T), content: `Background task completed: **workflow**\n\nOutput references ${other}\n\nChild runs: custom=${run} (completed)` }]);
	assert.equal(stats.turns, 1);
});

test("nested legacy child messages are discovered without double counting tool-result usage", () => {
	const f = fixture();
	const nestedDetails = { runId: other, results: [{ agent: "worker", index: 0, model: "openai/m", usage: { cost: 2, turns: 2 } }] };
	const child = { agent: "worker", messages: [prompt("p").message, reply("a").message, { ...result(nestedDetails).message, usage: { cost: { total: 2 }, input: 500 } }], usage: { cost: .5, turns: 1 }, model: "anthropic/m" };
	const stats = f.stats([result({ results: [child] })]);
	assert.equal(stats.turns, 3);
	assert.equal(stats.providers.get("openai")?.cost, 2);
	assert.equal(stats.tokens.input, 10);
});

test("workflowKey results alias later child inventory rather than charging the workflow twice", () => {
	const f = fixture();
	f.meta(run, { model: "anthropic/m", usage: { cost: 1, turns: 2 }, toolCount: 3 });
	const stats = f.stats([
		result({ runId: other, results: [{ workflowKey: "lane", agent: "worker", index: 0, model: "anthropic/m", usage: { cost: 1, turns: 2 } }] }),
		result({ workflowChildren: { workflowRunId: other, children: [{ childId: "lane", runId: run, agent: "worker" }] } }, "subagent_status", "status"),
	]);
	assert.equal(stats.turns, 2);
	assert.equal(stats.toolCalls, 3);
	assert.equal(stats.providers.get("anthropic")?.cost, 1);
});

test("an incomplete assistant record cannot break the footer", () => {
	const f = fixture();
	f.session(run, [prompt("p"), { type: "message", timestamp: iso(T + 1000), message: { role: "assistant", timestamp: T, provider: "anthropic", model: "m" } }]);
	const stats = f.stats([result({ runId: run })]);
	assert.equal(stats.turns, 1);
	assert.equal(stats.providers.get("anthropic")?.cost, 0);
});

test("native user prompt suppresses an artifact-only initial_prompt marker", () => {
	const f = fixture();
	f.session(run, [prompt("p"), reply("a")]);
	const transcriptPath = join(f.artifacts, `${run}_worker_0_transcript.jsonl`);
	writeFileSync(transcriptPath, JSON.stringify({ recordType: "message", sourceEventType: "initial_prompt", timestamp: iso(T), message: { role: "user", content: "p" } }) + "\n");
	assert.equal(f.stats([result({ runId: run })]).prompts, 1);
});

test("detached inline snapshots cannot hide refreshed final metadata", () => {
	const f = fixture();
	const metadataPath = f.meta(run, { model: "anthropic/m", usage: { turns: 1, input: 10, cost: .5 }, toolCount: 1 });
	const branch = [result({ runId: run, results: [{ index: 0, agent: "worker", model: "anthropic/m", usage: { turns: 1, input: 10, cost: .5 }, artifactPaths: { metadataPath } }] })];
	assert.equal(f.stats(branch).turns, 1);
	f.meta(run, { model: "anthropic/m", usage: { turns: 9, input: 90, cost: 4.5 }, toolCount: 9 });
	const stats = f.stats(branch);
	assert.deepEqual([stats.turns, stats.toolCalls, stats.tokens.input], [9, 9, 90]);
	assert.equal(stats.providers.get("anthropic")?.cost, 4.5);
});

test("run aliases sharing only a metadata file count its usage once", () => {
	const f = fixture();
	const metadataPath = f.meta(run, { model: "anthropic/m", usage: { turns: 2, input: 20, cost: 1 }, toolCount: 3 });
	const child = { index: 0, agent: "worker", model: "anthropic/m", usage: { turns: 2, input: 20, cost: 1 }, toolCount: 3, artifactPaths: { metadataPath } };
	const stats = f.stats([result({ runId: run, results: [child] }), result({ runId: other, results: [child] }, "subagent_status", "status")]);
	assert.deepEqual([stats.turns, stats.toolCalls, stats.tokens.input], [2, 3, 20]);
	assert.equal(stats.providers.get("anthropic")?.cost, 1);
});

test("independent parallel prompts with identical text and timestamps are still distinct", () => {
	const f = fixture();
	const p = prompt("same-task");
	f.session(run, [{ ...p, id: "first-prompt" }, reply("a")]);
	f.session(other, [{ ...p, id: "second-prompt" }, reply("b")]);
	assert.equal(f.stats([result({ workflowChildren: { children: [{ runId: run }, { runId: other }] } })]).prompts, 2);
});

test("runs named only by current subagent notices are found under this session's own directory", () => {
	const f = fixture();
	const third = "33333333-3333-3333-3333-333333333333";
	f.session(run, [prompt("a"), reply("a", "openai", T + 2000)]);
	f.session(other, [prompt("b"), reply("b", "openai", T + 3000)]);
	f.session(third, [prompt("c"), reply("c", "openai", T + 4000)]);
	const stats = f.stats([
		{ type: "custom_message", customType: "subagent-incremental-child-notify", timestamp: iso(T), content: `Workflow child completed: **review**\nWorkflow run: ${"4".repeat(8)}-4444-4444-4444-${"4".repeat(12)}\nChild run: ${run}\nStatus: workflow still running` },
		{ type: "custom_message", customType: "subagent-notify", timestamp: iso(T), content: `Background task completed: **workflow**\nChild outputs:\n- key=build run=${other} status=completed` },
		{ type: "custom_message", customType: "subagent_supervisor_request", timestamp: iso(T), content: "needs a decision", details: { runId: third, agent: "worker" } },
	]);
	assert.deepEqual([stats.prompts, stats.turns], [3, 3]);
	assert.equal(stats.providers.get("openai")?.cost, 1.5);
});

test("a run named in prose is not charged from the shared artifact directory or from outside the subagent protocol", () => {
	const f = fixture();
	f.meta(run, { model: "anthropic/m", usage: { cost: 99, turns: 99 } });
	f.session(other, [prompt("b"), reply("b")]);
	const stats = f.stats([
		{ type: "custom_message", customType: "subagent-notify", timestamp: iso(T), content: `Child outputs:\n- key=a run=${run} status=completed` },
		{ type: "message", timestamp: iso(T), message: { role: "toolResult", toolName: "bash", toolCallId: "b", content: [{ type: "text", text: `ls ${other}` }] } },
	]);
	assert.deepEqual([stats.turns, stats.providers.size], [0, 0]);
});

test("one child reachable under two run ids is charged once", () => {
	const f = fixture();
	const a = reply("a", "openai", T + 2000);
	const b = reply("b", "openai", T + 4000);
	f.session(other, [prompt("task"), a, b]);
	// The artifact copy lacks row ids and stopped early, like a detached child's receipt.
	const record = (e: any) => JSON.stringify({ recordType: "message", sourceEventType: "message_end", timestamp: e.timestamp, message: e.message });
	writeFileSync(join(f.artifacts, `${run}_worker_transcript.jsonl`), [prompt("task"), a].map(record).join("\n"));
	f.meta(run, { model: "openai/model", usage: { turns: 1, cost: .5 } });
	const notice = { type: "custom_message", customType: "subagent-incremental-child-notify", timestamp: iso(T), content: `Child run: ${other}` };
	for (const branch of [[result({ runId: run }), notice], [notice, result({ runId: run })]]) {
		const stats = f.stats(branch);
		assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [1, 2, 2]);
		assert.equal(stats.providers.get("openai")?.cost, 1);
	}
});

test("children too big for one walk's reads reach their full total, then keep it on every walk", (t) => {
	const f = fixture();
	t.after(() => rmSync(f.dir, { recursive: true, force: true }));
	// Ten 7 MB children are more than one walk reads or the cache once held: walks alternated $4.50 and $5.00.
	const output = [{ type: "text", text: "x".repeat(7 * 1024 * 1024) }];
	const branch = Array.from({ length: 10 }, (_, i) => {
		const sessionFile = join(f.dir, `child-${i}.jsonl`);
		const read = { type: "message", id: `out-${i}`, timestamp: iso(T), message: { role: "toolResult", toolCallId: `read-${i}`, toolName: "read", content: output } };
		writeFileSync(sessionFile, [prompt(`task-${i}`), read, reply(`child-${i}`)].map(e => JSON.stringify(e)).join("\n") + "\n");
		return result({ name: `child-${i}`, sessionFile }, "subagent", `spawn-${i}`);
	});
	const walks = Array.from({ length: 4 }, () => f.stats(branch));
	assert.equal(walks[0].partial, true);
	assert.deepEqual(walks.slice(1).map(s => [s.providers.get("anthropic")?.cost, s.partial ?? false]), [[5, false], [5, false], [5, false]]);
});
