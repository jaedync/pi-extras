import { test } from "node:test";
import assert from "node:assert/strict";
import idleGcExtension from "../extensions/idle-gc.ts";
import { IDLE_MS, MIN_GAP_MS, MIN_GROWTH_BYTES, holdBusy, idleGc, lastResortCollector, processBusy } from "../lib/idle-gc.ts";

const MB = 1024 * 1024;

/** A clock and timers the test moves by hand. */
function fakeTime() {
	let now = 1_000_000;
	let next = 1;
	const pending = new Map<number, { at: number; fn: () => void }>();
	return {
		now: () => now,
		timers: {
			setTimeout: (fn: () => void, ms: number) => { const id = next++; pending.set(id, { at: now + ms, fn }); return id; },
			clearTimeout: (id: unknown) => { pending.delete(id as number); },
		},
		pending: () => pending.size,
		advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				pending.delete(due[0]);
				now = due[1].at;
				due[1].fn();
			}
			now = end;
		},
	};
}

function setup(rss = () => 200 * MB) {
	const time = fakeTime();
	const collected: number[] = [];
	const errors: unknown[] = [];
	const gc = idleGc({ collect: () => collected.push(time.now()), rss, now: time.now, timers: time.timers, onError: (error) => errors.push(error) });
	return { time, collected, errors, gc };
}

test("an idle session collects once, after it has been idle for a while", () => {
	const { time, collected, gc } = setup();
	gc.idle();
	time.advance(IDLE_MS - 1);
	assert.equal(collected.length, 0);
	time.advance(1);
	assert.equal(collected.length, 1);
	time.advance(10 * MIN_GAP_MS);
	assert.equal(collected.length, 1, "no repeat without a new idle period");
});

test("work that starts before the wait ends cancels the collection", () => {
	const { time, collected, gc } = setup();
	gc.idle();
	time.advance(IDLE_MS / 2);
	gc.busy();
	time.advance(IDLE_MS * 2);
	assert.equal(collected.length, 0);
	assert.equal(time.pending(), 0);
});

test("collections keep a minimum gap, and wait for the session to grow", () => {
	let rss = 200 * MB;
	const { time, collected, gc } = setup(() => rss);
	gc.idle();
	time.advance(IDLE_MS);
	assert.equal(collected.length, 1);
	rss += MIN_GROWTH_BYTES * 2;
	gc.idle();
	time.advance(IDLE_MS);
	assert.equal(collected.length, 1, "too soon after the last one");
	time.advance(MIN_GAP_MS);
	assert.equal(collected.length, 2, "runs once the gap has passed");
	gc.idle();
	time.advance(MIN_GAP_MS + IDLE_MS);
	assert.equal(collected.length, 2, "skipped: the process did not grow since");
});

test("while any session in the process works, the collection waits", () => {
	const { time, collected, gc } = setup();
	const release = holdBusy();
	try {
		assert.equal(processBusy(), true);
		gc.idle();
		time.advance(IDLE_MS * 3);
		assert.equal(collected.length, 0);
	} finally {
		release();
	}
	release();
	assert.equal(processBusy(), false, "a second release changes nothing");
	time.advance(IDLE_MS);
	assert.equal(collected.length, 1);
});

test("a collector that fails stops the feature for the session and reports once", () => {
	const time = fakeTime();
	const errors: unknown[] = [];
	let calls = 0;
	const gc = idleGc({ collect: () => { calls++; throw new Error("no gc"); }, rss: () => 0, now: time.now, timers: time.timers, onError: (error) => errors.push(error) });
	gc.idle();
	time.advance(IDLE_MS);
	gc.idle();
	time.advance(MIN_GAP_MS + IDLE_MS);
	assert.equal(calls, 1);
	assert.equal(errors.length, 1);
});

test("a stopped watcher ignores later idle periods", () => {
	const { time, collected, gc } = setup();
	gc.idle();
	gc.stop();
	gc.idle();
	time.advance(IDLE_MS * 3);
	assert.equal(collected.length, 0);
	assert.equal(time.pending(), 0);
});

test("the last-resort collector runs without leaving gc on the global object", () => {
	const hadGc = typeof (globalThis as { gc?: unknown }).gc === "function";
	const collect = lastResortCollector();
	assert.equal(typeof collect, "function");
	collect!();
	assert.equal(typeof (globalThis as { gc?: unknown }).gc === "function", hadGc);
});

type Handler = (...args: unknown[]) => unknown;

function install(env: string | undefined): Map<string, Handler> {
	const previous = process.env.PI_IDLE_GC;
	if (env === undefined) delete process.env.PI_IDLE_GC;
	else process.env.PI_IDLE_GC = env;
	const handlers = new Map<string, Handler>();
	try {
		idleGcExtension({ on: (name: string, fn: Handler) => { handlers.set(name, fn); } } as never);
	} finally {
		if (previous === undefined) delete process.env.PI_IDLE_GC;
		else process.env.PI_IDLE_GC = previous;
	}
	return handlers;
}

test("PI_IDLE_GC=off leaves the session alone; otherwise it follows the agent's runs", () => {
	for (const off of ["off", "0", "false"]) assert.equal(install(off).size, 0, off);
	const handlers = install(undefined);
	assert.deepEqual([...handlers.keys()].sort(), ["agent_end", "agent_start", "session_shutdown", "session_start"]);
	// The real timer is unref'd, so a session that ends during the wait exits at once.
	handlers.get("session_start")!({}, {});
	handlers.get("session_shutdown")!({}, {});
});
