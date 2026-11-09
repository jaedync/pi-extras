/**
 * The child's prompt gate (lib/subagents/child-prompt.ts) and the disposer
 * that uses it, on a fake session that keeps Pi's rules: an abort before the
 * run exists is lost, _startRun resets the abort flag, a compaction may run in
 * _prepareRun, the run starts with preflightResult("started"), Pi's
 * agent_start check stops an aborted run until Pi's dispose removes it, the
 * agent's own listeners stay, and a steer reaches the queue only when its
 * input handlers end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { GATE_WAIT_MS, promptGate, type GateError } from "../lib/subagents/child-prompt.ts";

/** The gate reports no failure in these tests. */
const unexpected: GateError = (what, error) => { throw new Error(`the gate reported ${what}: ${String(error)}`); };
import { childDisposer } from "../lib/subagents/child.ts";

const flush = async (rounds = 4) => { for (let i = 0; i < rounds; i++) await tick(); };

interface FakeRun { exists: boolean; flag: boolean; loopAborted: boolean; started?: (d: string) => void; end(how: string): void; idle: Promise<void> }

/** A session whose prompt waits before its run until `prepare()`, then until `start()`, then runs until `end()` or an abort. */
function fakeSession() {
	const log: string[] = [];
	let run: FakeRun | undefined;
	const listeners: Array<(event: { type: string }) => void> = [];
	const agentListeners: Array<(event: { type: string }) => void> = [];
	let disposed = false;
	const steers: Array<() => void> = [];
	const session = {
		prompt(text: string, options?: { preflightResult?: (d: string) => void }) {
			log.push(`prompt ${text}`);
			let idle!: () => void;
			const ended = new Promise<void>((resolve) => { idle = resolve; });
			return new Promise<void>((resolve) => {
				run = { exists: false, flag: false, loopAborted: false, idle: ended, ...(options?.preflightResult ? { started: options.preflightResult } : {}),
					end: (how) => { log.push(how); run = undefined; idle(); resolve(); } };
			});
		},
		// Pi's abort: the flag only while the run exists, and then a wait for idle (agent-session.js abort).
		async abort() {
			log.push("abort");
			if (!run?.exists) return;
			run.flag = true;
			await run.idle;
		},
		steer(text: string) { return new Promise<void>((resolve) => steers.push(() => { log.push(`queued ${text}`); resolve(); })); },
		subscribe(listener: (event: { type: string }) => void) { listeners.push(listener); return () => undefined; },
		agent: {
			subscribe(listener: (event: { type: string }) => void) { agentListeners.push(listener); return () => undefined; },
			abort() { log.push("agent abort"); if (run?.exists) run.loopAborted = true; },
		},
		extensionRunner: undefined,
		// Pi's dispose disconnects the session's own agent listener, which holds the agent_start check.
		dispose() { log.push("dispose"); disposed = true; },
	};
	return {
		session, log, steers,
		/** _startRun: the run exists, and the abort flag starts false. */
		prepare() { run!.exists = true; run!.flag = false; },
		/** A compaction in _prepareRun; Pi's abort cancels it. */
		compact() {
			for (const listener of listeners) listener({ type: "compaction_start" });
			log.push(run!.flag ? "compaction cancelled" : "compaction model call");
		},
		/** The end of _prepareRun: preflightResult("started"), then agent_start: Pi's check (until dispose) and the agent's listeners. */
		start() {
			run!.started?.("started");
			if (run!.flag && !disposed) return run!.end("aborted");
			for (const listener of agentListeners) listener({ type: "agent_start" });
			if (run!.loopAborted) return run!.end("aborted");
			log.push("model call");
		},
		end: () => run?.end("ended"),
	};
}

test("an abort before the run exists is kept and stops the run at its start; the abort waits for the prompt (F1)", async () => {
	const fake = fakeSession();
	const gate = promptGate(fake.session, unexpected);
	const prompted = gate.prompt("task");
	let aborted = false;
	const abort = gate.abort().then(() => { aborted = true; });
	await flush();
	assert.equal(aborted, false, "the abort waits for the prompt in flight");
	fake.prepare();
	fake.start();
	await abort;
	await prompted;
	assert.deepEqual(fake.log, ["prompt task", "abort", "abort", "aborted"]);
	assert.equal(gate.busy(), false);
});

test("an abort before the run exists also cancels a compaction before the run", async () => {
	const fake = fakeSession();
	const gate = promptGate(fake.session, unexpected);
	const prompted = gate.prompt("task");
	const abort = gate.abort();
	fake.prepare();
	fake.compact();
	fake.start();
	await abort;
	await prompted;
	assert.deepEqual(fake.log, ["prompt task", "abort", "abort", "compaction cancelled", "abort", "aborted"]);
});

test("an abort with no prompt in flight resolves at once, and a later prompt and its compaction run as usual", async () => {
	const fake = fakeSession();
	const gate = promptGate(fake.session, unexpected);
	await gate.abort();
	const prompted = gate.prompt("next");
	fake.prepare();
	fake.compact();
	fake.start();
	fake.end();
	await prompted;
	assert.deepEqual(fake.log, ["abort", "prompt next", "compaction model call", "model call", "ended"]);
});

test("an abort waits at most GATE_WAIT_MS for a prompt that does not start; the prompt is still stopped when it starts", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const fake = fakeSession();
	const gate = promptGate(fake.session, unexpected);
	const prompted = gate.prompt("task");
	let aborted = false;
	const abort = gate.abort().then(() => { aborted = true; });
	await flush();
	t.mock.timers.tick(GATE_WAIT_MS - 1);
	await flush();
	assert.equal(aborted, false);
	t.mock.timers.tick(1);
	await abort;
	fake.prepare();
	fake.start();
	await prompted;
	assert.deepEqual(fake.log, ["prompt task", "abort", "abort", "aborted"]);
});

test("an abort while Pi's run is in _prepareRun (a before_agent_start handler) waits at most GATE_WAIT_MS, though Pi's own abort waits for idle", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const fake = fakeSession();
	const gate = promptGate(fake.session, unexpected);
	const prompted = gate.prompt("task");
	fake.prepare();
	let aborted = false;
	const abort = gate.abort().then(() => { aborted = true; });
	await flush();
	t.mock.timers.tick(GATE_WAIT_MS - 1);
	await flush();
	assert.equal(aborted, false);
	t.mock.timers.tick(1);
	await abort;
	fake.start();
	await prompted;
	assert.deepEqual(fake.log, ["prompt task", "abort", "abort", "aborted"]);
});

test("an abort after the run started waits for Pi's abort of the loop, with no time limit", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const fake = fakeSession();
	const gate = promptGate(fake.session, unexpected);
	const prompted = gate.prompt("task");
	fake.prepare();
	fake.start();
	let aborted = false;
	const abort = gate.abort().then(() => { aborted = true; });
	t.mock.timers.tick(GATE_WAIT_MS * 2);
	await flush();
	assert.equal(aborted, false, "the loop has not ended");
	fake.end();
	await abort;
	await prompted;
});

test("the prompt returns only once each steer sent meanwhile is in Pi's queue (F5)", async () => {
	const fake = fakeSession();
	const gate = promptGate(fake.session, unexpected);
	assert.equal(gate.steering(), undefined, "no steer in flight: nothing to await");
	let returned = false;
	const prompted = gate.prompt("task").then(() => { returned = true; });
	fake.prepare();
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
	assert.equal(gate.steering(), undefined);
});

test("a dispose with a prompt in flight aborts it and waits for it before Pi's dispose; the run never starts (F2)", async () => {
	const fake = fakeSession();
	const gate = promptGate(fake.session, unexpected);
	const dispose = childDisposer(fake.session as never, () => fake.log.push("unsubscribe"), { dispose: () => fake.log.push("guard") }, gate);
	const prompted = gate.prompt("task");
	const disposed = dispose();
	await flush();
	assert.ok(!fake.log.includes("dispose"), "Pi's dispose waits: it would take away the listener that stops the run");
	fake.prepare();
	fake.start();
	await prompted;
	await disposed;
	assert.deepEqual(fake.log, ["prompt task", "abort", "abort", "aborted", "guard", "unsubscribe", "dispose"]);
	await dispose();
	assert.equal(fake.log.filter((line) => line === "dispose").length, 1);
});

test("a dispose whose wait ends at GATE_WAIT_MS goes on, and the gate stops the prompt that starts later before its first request", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const fake = fakeSession();
	const gate = promptGate(fake.session, unexpected);
	const prompted = gate.prompt("task");
	const disposed = childDisposer(fake.session as never, () => undefined, { dispose() {} }, gate)();
	await flush();
	t.mock.timers.tick(GATE_WAIT_MS);
	await disposed;
	assert.deepEqual(fake.log, ["prompt task", "abort", "dispose"]);
	fake.prepare();
	fake.start();
	await prompted;
	assert.deepEqual(fake.log, ["prompt task", "abort", "dispose", "abort", "agent abort", "aborted"]);
	assert.equal(gate.busy(), false);
});

test("a dispose with no prompt in flight does not abort", async () => {
	const fake = fakeSession();
	const gate = promptGate(fake.session, unexpected);
	await childDisposer(fake.session as never, () => undefined, { dispose() {} }, gate)();
	assert.deepEqual(fake.log, ["dispose"]);
});

test("a steer that Pi refuses and an abort of its own that fails go to the gate's error report, not to the prompt", async () => {
	const fake = fakeSession();
	const reported: string[] = [];
	const gate = promptGate({ ...fake.session, steer: () => Promise.reject(new Error("input handler failed")) }, (what, error) => reported.push(`${what}: ${(error as Error).message}`));
	const prompted = gate.prompt("task");
	fake.prepare();
	fake.start();
	gate.steer("one");
	fake.end();
	await prompted;
	assert.deepEqual(reported, ["a steer: input handler failed"]);
	assert.equal(gate.steering(), undefined);
	const failing = promptGate({ ...fake.session, abort: () => Promise.reject(new Error("abort failed")) }, (what, error) => reported.push(`${what}: ${(error as Error).message}`));
	const next = failing.prompt("next");
	await assert.rejects(failing.abort(), /abort failed/, "the caller's own abort still throws to it");
	fake.prepare();
	fake.start();
	await flush();
	assert.deepEqual(reported.slice(1), ["the abort at the run's start: abort failed"]);
	fake.end();
	await next;
});

