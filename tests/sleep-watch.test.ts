import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linuxSleeps, parseEtime, sleepArgsMs, SleepWatch, RUN_VARIABLE, type SleepProcess } from "../lib/sleep-watch.ts";

test("a sleep's arguments give its length, as GNU sleep adds them", () => {
	assert.equal(sleepArgsMs(["sleep", "30"]), 30_000);
	assert.equal(sleepArgsMs(["/usr/bin/sleep", "1m", "30s"]), 90_000);
	assert.equal(sleepArgsMs(["sleep", "0.5"]), 500);
	for (const argv of [["sleep"], ["sleep", "infinity"], ["sleep", "0"], ["sleep", "--help"], ["sleepy", "3"]]) assert.equal(sleepArgsMs(argv), undefined, argv.join(" "));
});

test("ps's elapsed time reads as ms", () => {
	assert.equal(parseEtime("00:07"), 7_000);
	assert.equal(parseEtime("01:02:03"), 3_723_000);
	assert.equal(parseEtime("2-01:00:00"), 176_400_000);
	assert.equal(parseEtime("soon"), undefined);
});

test("a fake /proc reads as sleeps with their group, start, length and run", () => {
	const proc = mkdtempSync(join(tmpdir(), "proc-"));
	try {
		writeFileSync(join(proc, "stat"), "cpu 1 2 3\nbtime 1000\n");
		const add = (pid: number, comm: string, argv: string[], pgid: number, ticks: number, env: string[]) => {
			mkdirSync(join(proc, String(pid)));
			writeFileSync(join(proc, String(pid), "comm"), `${comm}\n`);
			writeFileSync(join(proc, String(pid), "cmdline"), argv.join("\0") + "\0");
			writeFileSync(join(proc, String(pid), "stat"), `${pid} (${comm}) S 1 ${pgid} ${pgid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 0 0`);
			writeFileSync(join(proc, String(pid), "environ"), env.join("\0") + "\0");
		};
		add(40, "sleep", ["sleep", "30"], 39, 250, ["HOME=/h", `${RUN_VARIABLE}=abc`]);
		add(41, "bash", ["bash", "-c", "sleep 30"], 39, 200, []);
		add(42, "sleep", ["sleep", "infinity"], 39, 260, []);
		assert.deepEqual(linuxSleeps(proc), [{ pid: 40, pgid: 39, startedAt: 1_002_500, ms: 30_000, run: "abc" }]);
	} finally {
		rmSync(proc, { recursive: true, force: true });
	}
});

function harness(list: SleepProcess[][]) {
	let now = 0;
	let tick: (() => void) | undefined;
	let scans = 0;
	const watch = new SleepWatch({
		list: () => list[Math.min(scans++, list.length - 1)] ?? [],
		now: () => now,
		timers: { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => { tick = undefined; } },
	});
	return { watch, advance: async (ms: number) => { now += ms; tick?.(); await new Promise((resolve) => setImmediate(resolve)); }, ticking: () => tick !== undefined };
}

test("a watched run collects its sleeps in order, and which one runs now", async () => {
	const a = { pid: 10, pgid: 9, startedAt: 100, ms: 5_000, run: "r1" };
	const b = { pid: 11, pgid: 9, startedAt: 6_000, ms: 5_000, run: "r1" };
	const other = { pid: 20, pgid: 19, startedAt: 100, ms: 9_000, run: "r2" };
	const h = harness([[a, other], [a, other], [], [b]]);
	const stop = h.watch.watch({ run: "r1" });
	assert.equal(h.ticking(), true);
	await h.advance(500);
	assert.deepEqual(h.watch.sleeps({ run: "r1" }), { count: 1, first: [{ index: 0, startedAt: 100, ms: 5_000 }], recent: [{ index: 0, startedAt: 100, ms: 5_000 }], running: { index: 0, startedAt: 100, ms: 5_000 } });
	await h.advance(500);
	await h.advance(500);
	assert.equal(h.watch.sleeps({ run: "r1" })?.running, undefined, "between sleeps nothing runs");
	await h.advance(500);
	const seen = h.watch.sleeps({ run: "r1" })!;
	assert.equal(seen.count, 2);
	assert.deepEqual(seen.running, { index: 1, startedAt: 6_000, ms: 5_000 });
	stop();
	assert.equal(h.ticking(), false, "nothing watched, no scans");
});

test("a job is watched by its process group while something asks, then let go", async () => {
	const s = { pid: 30, pgid: 29, startedAt: 0, ms: 60_000 };
	const h = harness([[s]]);
	assert.equal(h.watch.sleeps({ pgid: 29 }), undefined, "the first ask starts the watch");
	await h.advance(500);
	assert.equal(h.watch.sleeps({ pgid: 29 })?.count, 1);
	for (let index = 0; index < 30; index++) await h.advance(500);
	assert.equal(h.ticking(), false, "no one asked for a while: the watch stops");
});

test("where the system hides environments, a run is never watched", () => {
	let started = 0;
	const watch = new SleepWatch({ list: () => [], seesRuns: false, timers: { setInterval: () => { started++; return 1; }, clearInterval: () => {} } });
	watch.watch({ run: "r" })();
	assert.equal(watch.sleeps({ run: "r" }), undefined);
	assert.equal(started, 0, "no scan for what can't be seen");
	watch.sleeps({ pgid: 7 });
	assert.equal(started, 1, "a job's group still is");
});

test("a real sleep is found by its run variable", { skip: process.platform !== "linux" }, async () => {
	const child = spawn("sleep", ["7"], { env: { ...process.env, [RUN_VARIABLE]: "live-test" }, stdio: "ignore" });
	try {
		await new Promise((resolve) => setTimeout(resolve, 150));
		const found = linuxSleeps().find((sleep) => sleep.pid === child.pid);
		assert.ok(found, "the sleep is listed");
		assert.equal(found.run, "live-test");
		assert.equal(found.ms, 7_000);
		assert.ok(Math.abs(found.startedAt - Date.now()) < 2_000, `${found.startedAt} is near now`);
	} finally {
		child.kill();
	}
});
