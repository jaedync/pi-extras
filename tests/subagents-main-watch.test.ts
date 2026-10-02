import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { watchMain } from "../lib/subagents/main-watch.ts";

/** watchMain over a fake event bus and clock, with a mail that records what it was asked. */
function harness() {
	const handlers = new Map<string, Array<(event: object, ctx: object) => unknown>>();
	const pi = { on: (name: string, handler: (event: object, ctx: object) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
	let time = 0;
	let idle = true;
	const calls: string[] = [];
	const mail = { retry: () => calls.push("retry"), owed: () => false, remind: () => calls.push("remind"), answered: () => calls.push("answered") };
	const watch = watchMain(pi as never, () => mail as never, () => time);
	const emit = async (name: string, event: object = {}, ctx: object = {}) => {
		const results = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler({ type: name, ...event }, ctx));
		return results;
	};
	return {
		emit, calls,
		at: (ms: number) => { time = ms; },
		idle: (value: boolean) => { idle = value; },
		route: () => watch.route({ isIdle: () => idle }),
	};
}

const aborted = { messages: [{ role: "assistant", stopReason: "aborted" }] };
const finished = { messages: [{ role: "assistant", stopReason: "stop" }] };
const failed = { messages: [{ role: "assistant", stopReason: "error" }] };

test("idle main is woken, working main gets mail at its next turn boundary, and mail waits while it compacts or settles", async () => {
	const h = harness();
	assert.equal(h.route(), "wake");
	h.idle(false);
	assert.equal(h.route(), "hold", "busy with no run: compacting or summarizing a branch");
	await h.emit("agent_start");
	assert.equal(h.route(), "queue");
	assert.deepEqual(await h.emit("agent_before_settle", { context: {} }), [undefined]);
	assert.equal(h.route(), "hold", "past the settle check, mail would land unread");
	await h.emit("agent_start");
	assert.equal(h.route(), "queue", "a continued run takes mail again");
	await h.emit("agent_settled");
	h.idle(true);
	assert.equal(h.route(), "wake");
	assert.ok(h.calls.filter((call) => call === "retry").length >= 3, "each change gives held mail another try");
});

test("a prompt in its preflight holds mail until its run starts, for at most the grace", async () => {
	const h = harness();
	await h.emit("input");
	assert.equal(h.route(), "hold");
	h.at(1_999);
	assert.equal(h.route(), "hold");
	h.at(2_000);
	assert.equal(h.route(), "wake", "an input another extension handled starts no run");
	h.at(3_000);
	await h.emit("input");
	await h.emit("agent_start");
	await h.emit("agent_settled");
	assert.equal(h.route(), "wake", "the prompt's run has started and ended");
});

test("a compaction Pi runs before a prompt gives the prompt its grace again", async () => {
	const h = harness();
	await h.emit("input");
	h.idle(false);
	h.at(5_000);
	await h.emit("session_compact", { reason: "threshold" });
	h.idle(true);
	h.at(5_100);
	assert.equal(h.route(), "hold");
	h.at(7_000);
	assert.equal(h.route(), "wake");
});

test("a reminder follows only a /compact that stopped main's run, however long other handlers take", async () => {
	type Case = { reason?: string; outcome?: "done" | "failed" | "cancelled"; said?: boolean; checked?: boolean };
	const stopping = async (end: object, compactAt: number, { reason = "manual", outcome = "done", said = false, checked = end === finished }: Case = {}) => {
		const h = harness();
		let branch: object[] = [{ type: "message", id: "u1" }, { type: "message", id: "a1" }, { type: "custom_message", id: "n1" }];
		const ctx = { sessionManager: { getBranch: () => branch } };
		await h.emit("agent_start");
		await h.emit("agent_end", end);
		// Pi reaches the settle check only for a run nobody stopped.
		if (checked) await h.emit("agent_before_settle", { context: {} });
		h.at(100);
		await h.emit("agent_settled", {}, ctx);
		// Entries that aren't conversation (another extension's state) don't count as something said.
		branch = [...branch, { type: "custom", id: "state" }, ...(said ? [{ type: "message", id: "u2" }] : [])];
		h.at(compactAt);
		await h.emit("session_before_compact", { reason }, ctx);
		if (outcome === "done") await h.emit("session_compact", { reason });
		else await h.emit("session_compact_failed", { reason, aborted: outcome === "cancelled" });
		return h.calls.includes("remind");
	};
	assert.equal(await stopping(aborted, 110), true, "/compact mid-run");
	assert.equal(await stopping(aborted, 30_000), true, "another extension's handler took a while before ours ran");
	assert.equal(await stopping(aborted, 110, { outcome: "failed" }), true, "the compaction failed, main is still stopped");
	assert.equal(await stopping(aborted, 110, { outcome: "cancelled" }), false, "the user cancelled it too");
	assert.equal(await stopping(aborted, 120_000), false, "Esc, then a /compact much later");
	assert.equal(await stopping(aborted, 110, { said: true }), false, "Esc, then a new prompt, then a /compact");
	assert.equal(await stopping(finished, 110), false, "the run had ended on its own");
	assert.equal(await stopping(failed, 110), true, "stopped while waiting to retry, after an error reply");
	assert.equal(await stopping({ messages: [{ role: "assistant", stopReason: "toolUse" }, { role: "toolResult" }] }, 110), true, "stopped inside a tool call");
	assert.equal(await stopping(finished, 110, { checked: false }), true, "stopped in the compaction Pi runs after a turn");
	assert.equal(await stopping(aborted, 110, { reason: "threshold" }), false, "Pi's own compaction stops nothing");
});

test("every turn's end tells the mail what main has replied after", async () => {
	const h = harness();
	await h.emit("turn_end", {}, { sessionManager: { getBranch: () => [] } });
	assert.deepEqual(h.calls, ["answered"]);
	await h.emit("turn_end", {}, { sessionManager: { getBranch: () => { throw new Error("stale"); } } });
	await sleep(0);
});

test("input from long ago doesn't hold mail after every later compaction", async () => {
	const h = harness();
	await h.emit("input");
	h.at(400_000);
	await h.emit("session_compact", { reason: "manual" });
	h.at(400_100);
	assert.equal(h.route(), "wake");
});
