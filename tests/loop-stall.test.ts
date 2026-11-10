import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import loopStallExtension, { stallThreshold, startLoopStall } from "../extensions/loop-stall.ts";
import { appendStallLine, formatStall, loopStallWatch, SETTLE_MS, shortPressure, STALL_MS, TICK_MS, type Stall } from "../lib/loop-stall.ts";
import { clearSyncOps, syncOpsBetween, timedSync, type SyncOp } from "../lib/sync-ops.ts";

/** A clock and timers the test moves by hand; `block` stands for main-thread work that holds every timer back. */
function fakeTime() {
	let now = 1_000;
	let cpu = 0;
	let next = 1;
	const pending = new Map<number, { at: number; fn: () => void }>();
	const runDue = () => {
		for (;;) {
			const due = [...pending.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) return;
			pending.delete(due[0]);
			due[1].fn();
		}
	};
	return {
		now: () => now,
		cpu: () => cpu,
		timers: {
			setTimeout: (fn: () => void, ms: number) => { const id = next++; pending.set(id, { at: now + ms, fn }); return id; },
			clearTimeout: (id: unknown) => { pending.delete(id as number); },
		},
		pending: () => pending.size,
		/** Time passes with the loop free: each timer fires on time. */
		advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const due = [...pending.values()].map((t) => t.at).filter((at) => at <= end).sort((a, b) => a - b)[0];
				if (due === undefined) break;
				now = due;
				runDue();
			}
			now = end;
		},
		/** The thread is held for `ms` (using `cpuMs` of CPU), then the loop runs what is late. */
		block(ms: number, cpuMs: number) { now += ms; cpu += cpuMs * 1000; runDue(); },
	};
}

function setup(extra: { ops?: readonly SyncOp[]; gcMs?: number; cpu?: boolean } = {}) {
	const time = fakeTime();
	const stalls: Stall[] = [];
	const errors: unknown[] = [];
	const watch = loopStallWatch({
		now: time.now, wallNow: () => Date.UTC(2026, 10, 10, 2, 0, 0), threadCpuMicros: extra.cpu === false ? () => undefined : time.cpu,
		gcMsBetween: () => extra.gcMs ?? 0, syncOpsBetween: () => extra.ops ?? [], ioPressure: () => "some avg10=49.24 full avg10=42.87",
		memory: () => ({ heapUsed: 300 * 1024 * 1024, rss: 540 * 1024 * 1024 }), timers: time.timers,
		onStall: (stall) => stalls.push(stall), onError: (error) => errors.push(error),
	});
	return { time, stalls, errors, watch };
}

test("a loop that keeps time records no stall", () => {
	const { time, stalls } = setup();
	time.advance(60_000);
	time.block(STALL_MS - 1, 100);
	time.advance(1_000);
	assert.deepEqual(stalls, []);
});

test("a blocked thread is one stall with its length, its CPU time and what ran in it", () => {
	const ops = [{ label: "subagents index save", startedAt: 1_100, ms: 9_590 }];
	const { time, stalls } = setup({ ops, gcMs: 12 });
	time.advance(TICK_MS / 2);
	time.block(9_600, 40);
	assert.equal(stalls.length, 0, "the record waits for late GC entries");
	time.advance(SETTLE_MS);
	assert.equal(stalls.length, 1);
	const [stall] = stalls;
	assert.equal(stall!.lagMs, 9_600 + TICK_MS / 2 - TICK_MS);
	assert.equal(stall!.windowMs, 9_600 + TICK_MS / 2);
	assert.equal(stall!.threadCpuMs, 40);
	assert.equal(stall!.gcMs, 12);
	assert.deepEqual(stall!.syncOps, ops);
	assert.equal(stall!.heapMb, 300);
	time.advance(10_000);
	assert.equal(stalls.length, 1, "the watch goes on after a stall without a second record");
});

test("stop ends the watch, also with a record still waiting", () => {
	const { time, stalls, watch } = setup();
	time.block(2_000, 0);
	watch.stop();
	assert.equal(time.pending(), 0, "no timer is left behind");
	time.advance(10_000);
	assert.equal(stalls.length, 0);
});

test("a record that fails goes to onError and the watch goes on", () => {
	const time = fakeTime();
	const errors: unknown[] = [];
	let calls = 0;
	loopStallWatch({
		now: time.now, wallNow: () => 0, threadCpuMicros: () => undefined, gcMsBetween: () => 0, syncOpsBetween: () => [],
		ioPressure: () => undefined, memory: () => { throw new Error("no memory info"); }, timers: time.timers,
		onStall: () => { calls++; }, onError: (error) => errors.push(error),
	});
	time.block(1_000, 0);
	time.advance(SETTLE_MS);
	time.block(1_000, 0);
	time.advance(SETTLE_MS);
	assert.equal(errors.length, 2);
	assert.equal(calls, 0);
});

test("the log line gives the numbers and names only kinds of operations", () => {
	const line = formatStall({ at: Date.UTC(2026, 10, 10, 2, 0, 0), lagMs: 9_612.4, windowMs: 9_700, threadCpuMs: 38.6, gcMs: 0,
		syncOps: [{ label: "subagents index save", startedAt: 0, ms: 9_601 }], ioPressure: "some avg10=49.24 full avg10=42.87", heapMb: 312.2, rssMb: 540 });
	assert.equal(line, "2026-11-10T02:00:00.000Z main thread stalled 9612 ms (window 9700 ms: CPU 39 ms, GC 0 ms) sync ops: subagents index save 9601 ms; io: some avg10=49.24 full avg10=42.87; heap 312 MB, rss 540 MB");
	const unknown = formatStall({ at: 0, lagMs: 600, windowMs: 850, threadCpuMs: undefined, gcMs: 5, syncOps: [], ioPressure: undefined, heapMb: 1, rssMb: 2 });
	assert.match(unknown, /CPU unknown, GC 5 ms\) sync ops: none recorded; io: unknown;/);
});

test("the pressure text keeps the avg10 of each line", () => {
	assert.equal(shortPressure("some avg10=49.24 avg60=37.75 avg300=30.74 total=1\nfull avg10=42.87 avg60=32.11 avg300=25.59 total=2\n"), "some avg10=49.24 full avg10=42.87");
	assert.equal(shortPressure("garbage"), undefined);
});

test("the log keeps one old copy once it passes its size", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "loop-stall-log-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "loop-stall.log");
	appendStallLine(file, "one", 10);
	assert.equal(readFileSync(file, "utf8"), "one\n");
	writeFileSync(file, "x".repeat(11));
	appendStallLine(file, "two", 10);
	assert.equal(readFileSync(file, "utf8"), "two\n");
	assert.equal(readFileSync(`${file}.1`, "utf8"), "x".repeat(11));
});

test("timedSync records only slow operations, and passes results and errors through", () => {
	clearSyncOps();
	let clock = 0;
	const now = () => clock;
	assert.equal(timedSync("quick", () => { clock += 10; return 7; }, now), 7);
	assert.throws(() => timedSync("slow failing", () => { clock += 80; throw new Error("EIO"); }, now), /EIO/);
	assert.deepEqual(syncOpsBetween(0, 1_000).map((op) => [op.label, op.ms]), [["slow failing", 80]]);
	assert.deepEqual(syncOpsBetween(500, 1_000), []);
	clearSyncOps();
});

test("the threshold comes from PI_LOOP_STALL_MS when it is a number of 100 or more", () => {
	assert.equal(stallThreshold(undefined), STALL_MS);
	assert.equal(stallThreshold("250"), 250);
	assert.equal(stallThreshold("50"), STALL_MS);
	assert.equal(stallThreshold("soon"), STALL_MS);
});

type Handler = (event: unknown, ctx: unknown) => void;

function install(env: string | undefined): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const previous = process.env.PI_LOOP_STALL;
	if (env === undefined) delete process.env.PI_LOOP_STALL;
	else process.env.PI_LOOP_STALL = env;
	try {
		loopStallExtension({ on: (name: string, fn: Handler) => { handlers.set(name, fn); } } as never);
	} finally {
		if (previous === undefined) delete process.env.PI_LOOP_STALL;
		else process.env.PI_LOOP_STALL = previous;
	}
	return handlers;
}

test("PI_LOOP_STALL=off leaves the session alone; otherwise it watches from start to shutdown", () => {
	for (const off of ["off", "0", "false"]) assert.equal(install(off).size, 0, off);
	const handlers = install(undefined);
	assert.deepEqual([...handlers.keys()].sort(), ["session_shutdown", "session_start"]);
	// A second start (a /reload copy) takes over the first watch; the timers are unref'd either way.
	handlers.get("session_start")!({}, {});
	handlers.get("session_start")!({}, {});
	handlers.get("session_shutdown")!({}, {});
});

/** Holds the thread for real, as a synchronous fsync does. */
function busyWait(ms: number): void {
	const end = performance.now() + ms;
	while (performance.now() < end) { /* hold the thread */ }
}

test("end to end: a real blocked thread is logged with the slow sync operation that held it", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "loop-stall-e2e-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "loop-stall.log");
	clearSyncOps();
	let heard: (line: string) => void = () => {};
	const logged = new Promise<string>((resolve) => { heard = resolve; });
	// The watch's first timer is armed now, so holding the thread at once makes it late.
	const watch = startLoopStall(file, 300, (l) => heard(l));
	let line: string;
	try {
		timedSync("probe write", () => busyWait(900));
		line = await logged;
	} finally { watch.stop(); clearSyncOps(); }
	assert.equal(readFileSync(file, "utf8"), `${line}\n`, "the line is in the log");
	assert.match(line, /^\[loop-stall\] \S+Z main thread stalled \d+ ms \(window \d+ ms: CPU \d+ ms, GC \d+ ms\) sync ops: probe write \d+ ms;/);
	const stalled = Number(/stalled (\d+) ms/.exec(line)![1]);
	assert.ok(stalled >= 300 && stalled < 3_000, `stall of ${stalled} ms`);
});
