/**
 * The child's prompt gate (lib/subagents/child-prompt.ts) and the disposer
 * that uses it, on a fake session that keeps Pi's rules: an abort before the
 * run starts is lost, the run starts with preflightResult("started"), and a
 * steer reaches the queue only when its input handlers end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { promptGate } from "../lib/subagents/child-prompt.ts";
import { childDisposer } from "../lib/subagents/child.ts";

const flush = async (rounds = 4) => { for (let i = 0; i < rounds; i++) await tick(); };

/** A session whose prompt waits in its pre-run window until `start()`, then runs until `end()` or an abort. */
function fakeSession() {
	const log: string[] = [];
	let run: { active: boolean; aborted: boolean; started?: (d: string) => void; end(): void } | undefined;
	const steers: Array<() => void> = [];
	const session = {
		prompt(text: string, options?: { preflightResult?: (d: string) => void }) {
			log.push(`prompt ${text}`);
			return new Promise<void>((resolve) => {
				run = { active: false, aborted: false, ...(options?.preflightResult ? { started: options.preflightResult } : {}),
					end: () => { log.push(run!.aborted ? "aborted" : "ended"); run = undefined; resolve(); } };
			});
		},
		// Pi's abort: the flag only while the run exists; it waits for the run to end.
		async abort() {
			log.push("abort");
			if (run?.active) { run.aborted = true; run.end(); }
		},
		steer(text: string) { return new Promise<void>((resolve) => steers.push(() => { log.push(`queued ${text}`); resolve(); })); },
		extensionRunner: undefined,
		dispose() { log.push("dispose"); },
	};
	return {
		session, log, steers,
		/** _startRun: the run exists; Pi calls preflightResult, then its agent_start check stops an aborted run. */
		start() {
			run!.active = true;
			run!.started?.("started");
			if (run?.aborted === false) log.push("model call");
		},
		end: () => run?.end(),
	};
}

test("an abort before the run starts is kept and stops the run at its start; the abort waits for the prompt (F1)", async () => {
	const fake = fakeSession();
	const gate = promptGate(fake.session);
	const prompted = gate.prompt("task");
	let aborted = false;
	const abort = gate.abort().then(() => { aborted = true; });
	await flush();
	assert.equal(aborted, false, "the abort waits for the prompt in flight");
	fake.start();
	await abort;
	await prompted;
	assert.deepEqual(fake.log, ["prompt task", "abort", "abort", "aborted"]);
	assert.equal(gate.busy(), false);
});

test("an abort with no prompt in flight resolves at once, and a later prompt runs as usual", async () => {
	const fake = fakeSession();
	const gate = promptGate(fake.session);
	await gate.abort();
	const prompted = gate.prompt("next");
	fake.start();
	fake.end();
	await prompted;
	assert.deepEqual(fake.log, ["abort", "prompt next", "model call", "ended"]);
});

test("the prompt returns only once each steer sent meanwhile is in Pi's queue (F5)", async () => {
	const fake = fakeSession();
	const gate = promptGate(fake.session);
	let returned = false;
	const prompted = gate.prompt("task").then(() => { returned = true; });
	fake.start();
	gate.steer("one");
	fake.end();
	await flush();
	assert.equal(returned, false, "a steer still waits for its input handlers");
	gate.steer("two");
	fake.steers.shift()!();
	await flush();
	assert.equal(returned, false, "a steer sent while the prompt waits is waited for too");
	fake.steers.shift()!();
	await prompted;
	assert.deepEqual(fake.log.slice(-2), ["queued one", "queued two"]);
});

test("a dispose with a prompt in flight aborts it and waits for it before Pi's dispose (F2)", async () => {
	const fake = fakeSession();
	const gate = promptGate(fake.session);
	const dispose = childDisposer(fake.session as never, () => fake.log.push("unsubscribe"), { dispose: () => fake.log.push("guard") }, gate);
	const prompted = gate.prompt("task");
	const disposed = dispose();
	await flush();
	assert.ok(!fake.log.includes("dispose"), "Pi's dispose waits: it would take away the listener that stops the run");
	fake.start();
	await prompted;
	await disposed;
	assert.deepEqual(fake.log, ["prompt task", "abort", "abort", "aborted", "guard", "unsubscribe", "dispose"]);
	await dispose();
	assert.equal(fake.log.filter((line) => line === "dispose").length, 1);
});

test("a dispose with no prompt in flight does not abort", async () => {
	const fake = fakeSession();
	const gate = promptGate(fake.session);
	await childDisposer(fake.session as never, () => undefined, { dispose() {} }, gate)();
	assert.deepEqual(fake.log, ["dispose"]);
});
