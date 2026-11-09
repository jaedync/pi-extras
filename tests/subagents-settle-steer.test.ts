/**
 * A message sent to a child as its run ends is not lost between the run's
 * last look at its queue and settle (residual R1 in
 * formal/subagents-lifecycle/README.md). The handle runs the real prompt gate
 * over a fake session whose steer, like Pi's, takes a microtask to queue.
 * The send starts after a chain of 0 to 9 microtasks, so one of them lands in
 * the window that once dropped it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import { promptGate, type GateError } from "../lib/subagents/child-prompt.ts";
import type { ChildHandle, MainDelivery } from "../lib/subagents/types.ts";

const unexpected: GateError = (what, error) => { throw new Error(`the gate reported ${what}: ${String(error)}`); };
const flush = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await tick(); };

async function sendAsRunEnds(depth: number) {
	const main: MainDelivery[] = [];
	const prompts: string[] = [];
	const transcript: unknown[] = [];
	const queue: string[] = [];
	let endPrompt: (() => void) | undefined;
	const session = {
		prompt: (text: string) => { prompts.push(text); transcript.push({ role: "user", content: [{ type: "text", text }] }); return new Promise<void>((resolve) => { endPrompt = resolve; }); },
		abort: async () => undefined,
		// Pi's steer awaits the input handlers (one microtask with none) before it queues the message.
		steer: async (text: string) => { await undefined; queue.push(text); },
	};
	const gate = promptGate(session, unexpected);
	const team = new Team({
		maxConcurrent: 1, maxDepth: 2, replyTimeoutMs: 60_000, idleReleaseMs: 1e9, deliverToMain: (delivery) => main.push(delivery),
		launcher: {
			launch: async (): Promise<ChildHandle> => ({
				prompt: (text) => gate.prompt(text), steer: (text) => gate.steer(text), abort: () => gate.abort(), steering: () => gate.steering(),
				lastText: () => undefined, messages: () => transcript, takeQueued: () => queue.splice(0), dispose: async () => undefined,
			}),
		},
	});
	assert.ok(team.spawn({ name: "kid", task: "Task", parent: "main", model: "m", readOnly: false, fork: false, blocking: false }).ok);
	await flush();
	transcript.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] });
	let chain: Promise<unknown> = Promise.resolve();
	for (let i = 0; i < depth; i++) chain = chain.then(() => undefined);
	const sent = chain.then(() => team.send("main", "kid", "Also do Y."));
	endPrompt!();
	assert.equal((await sent).ok, true);
	await flush();
	return { prompts, queue, record: team.get("kid")! };
}

test("a message sent as a child's run ends is its next prompt, never left in an idle session's queue", async () => {
	for (let depth = 0; depth < 10; depth++) {
		const { prompts, queue, record } = await sendAsRunEnds(depth);
		assert.deepEqual(queue, [], `depth ${depth}: nothing waits in the idle session's queue`);
		assert.equal(prompts.length, 2, `depth ${depth}: the message started the next prompt`);
		assert.match(prompts[1]!, /Also do Y\./, `depth ${depth}`);
		assert.equal(record.state, "running", `depth ${depth}`);
	}
});
