/**
 * A message steered during a run's check, while the child's input handler
 * waits, reaches the child (found by the review of the F5 fix in
 * formal/subagents-lifecycle/README.md). The handle runs the real prompt gate
 * over a fake session whose steer is queued only when the test says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import { promptGate, type GateError } from "../lib/subagents/child-prompt.ts";

/** The gate reports no failure in these tests. */
const unexpected: GateError = (what, error) => { throw new Error(`the gate reported ${what}: ${String(error)}`); };
import type { CheckRun, ChildHandle, MainDelivery } from "../lib/subagents/types.ts";

const flush = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await tick(); };

test("a message steered during the check, while the input handler waits, is the run's next prompt, not lost", async () => {
	const main: MainDelivery[] = [];
	const prompts: string[] = [];
	const transcript: unknown[] = [];
	const queue: string[] = [];
	const landings: Array<() => void> = [];
	let endPrompt: (() => void) | undefined;
	let passCheck: ((run: CheckRun) => void) | undefined;
	const session = {
		prompt: (text: string) => { prompts.push(text); transcript.push({ role: "user", content: [{ type: "text", text }] }); return new Promise<void>((resolve) => { endPrompt = resolve; }); },
		abort: async () => undefined,
		// The input handlers await I/O; the message reaches Pi's queue when the test lands it.
		steer: (text: string) => new Promise<void>((resolve) => landings.push(() => { queue.push(text); resolve(); })),
	};
	const gate = promptGate(session, unexpected);
	const team = new Team({
		maxConcurrent: 1, maxDepth: 2, replyTimeoutMs: 60_000, idleReleaseMs: 1e9, deliverToMain: (delivery) => main.push(delivery),
		launcher: {
			launch: async (): Promise<ChildHandle> => ({
				prompt: (text) => gate.prompt(text), steer: (text) => gate.steer(text), abort: () => gate.abort(), steering: () => gate.steering(),
				lastText: () => undefined, messages: () => transcript, takeQueued: () => queue.splice(0), dispose: async () => undefined,
				check: () => new Promise<CheckRun>((resolve) => { passCheck = resolve; }),
			}),
		},
	});
	assert.ok(team.spawn({ name: "kid", task: "Task", parent: "main", model: "m", readOnly: false, fork: false, blocking: false, check: { command: "npm test", fixUntilPass: 0 } }).ok);
	await flush();
	transcript.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] });
	endPrompt!();
	await flush();
	assert.ok(passCheck, "the check runs");
	assert.equal((await team.send("main", "kid", "Also do Y.")).ok, true);
	passCheck!({ exitCode: 0, output: "ok" });
	await flush();
	assert.equal(team.get("kid")!.state, "running", "the run waits for the steer that is still in the input handlers");
	assert.equal(main.filter((delivery) => delivery.kind === "report").length, 0);
	landings.shift()!();
	await flush();
	assert.equal(prompts.length, 2, "the steered message is the run's next prompt");
	assert.match(prompts[1]!, /Also do Y\./);
	assert.deepEqual(queue, []);
});
