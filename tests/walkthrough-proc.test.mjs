/**
 * The process tree: an identity per process, one table per snapshot, and a stop
 * that reaches the descendants a killed parent would have reparented. The tree
 * is mocked here, so the walk can be 10 000 deep and 6 000 wide without a real
 * fork; the timeout tests run real processes that hold their pipes open.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_TREE, psReader, run, snapshotTree, stopTrees } from "../skills/walkthrough-video/scripts/lib/proc.mjs";

const SKILL = fileURLToPath(new URL("../skills/walkthrough-video/scripts/", import.meta.url));

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Waits for a pid to disappear, because SIGKILL delivery and the reap can trail the resolution. */
async function gone(pid, tries = 40) {
	for (let i = 0; i < tries; i++) {
		if (!alive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

/** A reader over a fixed table: pid, parent and start time, as /proc or ps gives them. */
function tableReader(rows, { overrides = {} } = {}) {
	const table = new Map(rows.map((row) => [row.pid, { ppid: row.ppid, start: row.start ?? `start-${row.pid}` }]));
	for (const [pid, row] of Object.entries(overrides)) table.set(Number(pid), row);
	return {
		start: (pid) => table.get(pid)?.start,
		table: () => new Map(table),
		alive: (entries) => entries.filter((entry) => table.get(entry.pid)?.start === entry.start),
	};
}

/** Every root needs its identity: a root is a pid plus the start time seen at spawn. */
const rootOf = (pid) => ({ pid, start: `start-${pid}` });

test("a wide tree returns no more than the cap, without duplicate pids, and says it was cut", () => {
	const rows = [{ pid: 1, ppid: 0 }, ...Array.from({ length: 6000 }, (_, i) => ({ pid: i + 2, ppid: 1 }))];
	const reader = tableReader(rows);
	const snap = snapshotTree([rootOf(1)], reader.table());
	assert.equal(snap.entries.length, MAX_TREE, `${snap.entries.length} entries`);
	assert.equal(snap.entries[0].pid, 1, "the root is the first entry");
	assert.equal(new Set(snap.entries.map((entry) => entry.pid)).size, snap.entries.length, "no pid appears twice");
	assert.equal(snap.truncated, true, "the caller can report that the tree was cut");
});

test("a chain 10 000 deep does not overflow the stack", () => {
	const rows = Array.from({ length: 10_000 }, (_, i) => ({ pid: i + 1, ppid: i }));
	const snap = snapshotTree([rootOf(1)], tableReader(rows).table());
	assert.equal(snap.entries.length, MAX_TREE);
	assert.equal(snap.truncated, true);
});

test("a root is walked once, and a child is one entry", () => {
	const snap = snapshotTree([rootOf(1), rootOf(1)], tableReader([{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }, { pid: 3, ppid: 1 }]).table());
	assert.deepEqual(snap.entries.map((entry) => entry.pid), [1, 2, 3]);
	assert.equal(snap.truncated, false);
});

test("a pid whose start time changed is not signalled", async () => {
	// A root that a new process owns now reports a different start time: it is not ours.
	const reader = tableReader([{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }], { overrides: { 1: { ppid: 0, start: "a-new-process" } } });
	const snap = snapshotTree([rootOf(1)], reader.table());
	assert.deepEqual(snap.entries, [], "the walk does not start from a reused pid");
	const signals = [];
	const result = await stopTrees([snap], { reader, signal: (pid, name) => signals.push([pid, name]), graceMs: 50, killMs: 50 });
	assert.deepEqual(signals, [], "no signal goes to the new owner");
	assert.equal(result.survivors.length, 0);
});

test("a failed ps is unknown, never matching: no signal goes to a reused pid", async () => {
	const rows = ["    1     0 Thu Oct 29 20:00:00 2026", "  120     1 Fri Oct 30 00:00:00 2026", ""].join("\n");
	let answer = { status: 0, stdout: rows };
	const reader = psReader({ exec: () => answer });
	// The saved root is from yesterday; the table now names a new process.
	const stale = [{ pid: 120, start: "Thu Oct 29 12:00:00 2026" }];
	assert.deepEqual(snapshotTree(stale, reader.table()).entries, [], "the new owner is not walked");
	// Even a matching identity is not signalled when ps cannot answer: unknown is not matching.
	const live = [{ pid: 120, start: "Fri Oct 30 00:00:00 2026" }];
	answer = { status: 1, stdout: "" };
	const signals = [];
	const result = await stopTrees([{ entries: live }], { reader, signal: (pid, name) => signals.push([pid, name]), graceMs: 0, killMs: 0 });
	assert.deepEqual(signals, [], "a failed ps sends no signal");
	assert.deepEqual(result.survivors, [], "a failed ps leaves no known survivor");
	assert.deepEqual(result.unresolved, live, "a failed ps is unknown, so the pid is reported as unresolved");
});

test("the ps reader takes the tree and the start times from one ps call", () => {
	const calls = [];
	const table = ["    1     0 Thu Oct 29 20:00:00 2026", "  120     1 Thu Oct 29 23:00:00 2026", "  121   120 Thu Oct 29 23:00:01 2026", ""].join("\n");
	const reader = psReader({
		exec: (args) => {
			calls.push(args);
			return { status: 0, stdout: table };
		},
	});
	const snap = snapshotTree([{ pid: 120, start: "Thu Oct 29 23:00:00 2026" }], reader.table());
	assert.equal(calls.length, 1, "one ps call, not one per pid");
	assert.equal(calls[0].join(" "), "-A -o pid=,ppid=,lstart=");
	assert.deepEqual(snap.entries.map((entry) => entry.pid), [120, 121]);
	assert.equal(snap.entries[1].start, "Thu Oct 29 23:00:01 2026", "the start time is the identity");
});

test("a timed-out run returns only after the whole tree is stopped", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-pipes-"));
	const pidFile = join(dir, "grandchild.pid");
	// The parent waits and dies on SIGTERM; the grandchild ignores SIGTERM and keeps stdout.
	const script = join(dir, "tree.sh");
	writeFileSync(script, `#!/bin/sh\nsh -c 'trap "" TERM; while :; do sleep 0.2; done' &\necho $! > ${pidFile}\nwait\n`);
	chmodSync(script, 0o755);
	try {
		const result = await run(script, [], { timeoutMs: 500 });
		assert.equal(result.timedOut, true, "the timeout is reported");
		const grandchild = Number(readFileSync(pidFile, "utf8").trim());
		// The call resolved after the stop: the grandchild is already gone, not "about to be".
		assert.equal(await gone(grandchild), true, `the grandchild ${grandchild} outlived the run`);
		// The direct child died from the SIGTERM; the escalation was for its grandchild.
		assert.match(result.signal, /^SIG(?:TERM|KILL)$/, `the result keeps the stop signal: ${result.signal}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a timed-out worker exits at once: the timeout deadline leaves no timer behind (F8, L2)", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-timer-out-"));
	const worker = join(dir, "worker.mjs");
	// A cooperative child: it exits on SIGTERM, so the stop is quick and the timeout is the long part.
	// The worker reports "done" after run() resolves; a leaked deadline timer delays only its exit.
	writeFileSync(worker, `import { run } from ${JSON.stringify(join(SKILL, "lib/proc.mjs"))};\nconst r = await run("sleep", ["30"], { timeoutMs: 300, stopDeadlineMs: 8000 });\nif (!(r.timedOut && r.code === null)) process.exitCode = 1;\nprocess.stdout.write("done");\n`);
	try {
		const watcher = spawn(process.execPath, [worker], { stdio: ["ignore", "pipe", "ignore"] });
		const exited = new Promise((resolve) => watcher.on("exit", resolve));
		let doneAt = 0;
		watcher.stdout.on("data", (chunk) => {
			if (!doneAt && String(chunk).includes("done")) doneAt = Date.now();
		});
		const code = await exited;
		assert.equal(code, 0, "the worker saw a timeout with a null code");
		assert.ok(doneAt > 0, "the worker reported that run() resolved");
		const after = Date.now() - doneAt;
		assert.ok(after < 1000, `the worker exited ${after} ms after run() resolved; a leftover deadline timer kept it alive`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a timed-out command whose child closes its pipes still returns only after the stop (F2)", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-closed-"));
	const pidFile = join(dir, "grandchild.pid");
	// The parent closes its own stdout and stderr, so an early close event is possible; the grandchild ignores SIGTERM.
	const script = join(dir, "closed.sh");
	// The parent closes its pipes and runs on: its close event comes before the stop ends, while the
	// grandchild that ignores SIGTERM still runs. The parent is alive at the timeout, so the
	// snapshot can reach the grandchild.
	// The grandchild is started with its output discarded, so only the parent holds the pipes.
	writeFileSync(script, `#!/bin/sh\nsh -c 'trap "" TERM; while :; do sleep 0.2; done' >/dev/null 2>&1 &\necho $! > ${pidFile}\nexec 1>&- 2>&-\nwhile :; do sleep 0.2; done\n`);
	chmodSync(script, 0o755);
	try {
		const result = await run(script, [], { timeoutMs: 400 });
		assert.equal(result.timedOut, true);
		const grandchild = Number(readFileSync(pidFile, "utf8").trim());
		assert.equal(await gone(grandchild), true, `the grandchild ${grandchild} outlived the run`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a finished worker exits at once: the timeout deadline leaves no timer behind", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-timer-"));
	const script = join(dir, "worker.mjs");
	writeFileSync(script, `import { run } from ${JSON.stringify(join(SKILL, "lib/proc.mjs"))};\nawait run("sleep", ["0.1"], {});\n`);
	try {
		const started = Date.now();
		const worker = spawn(process.execPath, [script], { stdio: "ignore" });
		const code = await new Promise((resolve) => worker.on("exit", resolve));
		const elapsed = Date.now() - started;
		assert.equal(code, 0);
		assert.ok(elapsed < 1000, `the worker exited ${elapsed} ms after it started; a leftover deadline timer kept it alive`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stop reports that the tree was cut", async () => {
	const rows = [{ pid: 1, ppid: 0 }, ...Array.from({ length: 6000 }, (_, i) => ({ pid: i + 2, ppid: 1 }))];
	const reader = tableReader(rows);
	const snap = snapshotTree([rootOf(1)], reader.table());
	const signals = [];
	const result = await stopTrees([snap], { reader, signal: () => signals.push(1), graceMs: 0, killMs: 0 });
	assert.equal(result.truncated, true, "the caller can warn that 1000 pids were not reached");
	assert.ok(signals.length > 0, "the entries that fit in the cap are signalled");
});

test("a tracked child's whole tree is stopped, and a survivor is reported", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-survivor-"));
	const pidFile = join(dir, "grandchild.pid");
	const report = join(dir, "report.json");
	const script = join(dir, "tree.sh");
	writeFileSync(script, `#!/bin/sh\nsh -c 'trap "" TERM; while :; do sleep 0.2; done' &\necho $! > ${pidFile}\nwait\n`);
	chmodSync(script, 0o755);
	const holder = join(dir, "holder.mjs");
	writeFileSync(
		holder,
		`import { writeFileSync } from "node:fs";
import { spawnChild, stopChildTrees } from ${JSON.stringify(join(SKILL, "lib/proc.mjs"))};
spawnChild(${JSON.stringify(script)}, [], { stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 500));
const result = await stopChildTrees({ graceMs: 1000, killMs: 2000 });
writeFileSync(${JSON.stringify(report)}, JSON.stringify({ survivors: result.survivors, truncated: result.truncated }));
`,
	);
	const parent = spawn(process.execPath, [holder], { stdio: "inherit" });
	try {
		for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
		const grandchild = Number(readFileSync(pidFile, "utf8").trim());
		await new Promise((resolve) => parent.on("exit", resolve));
		const result = JSON.parse(readFileSync(report, "utf8"));
		assert.deepEqual(result.survivors, [], "no survivor is left behind");
		assert.equal(await gone(grandchild), true, `the grandchild ${grandchild} is still running`);
	} finally {
		parent.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a pid that changes owner between two signals is not signalled (G1)", async () => {
	// The child's end lets a new process take the parent's pid: the second signal must check again.
	const table = new Map([[1, "start-1"], [2, "start-2"]]);
	const reader = {
		start: (pid) => table.get(pid),
		table: () => new Map([...table].map(([pid, start]) => [pid, { ppid: pid === 2 ? 1 : 0, start }])),
		alive: (entries) => entries.filter((entry) => table.get(entry.pid) === entry.start),
	};
	const signals = [];
	await stopTrees([{ entries: [rootOf(1), { pid: 2, start: "start-2" }] }], {
		reader,
		graceMs: 0,
		killMs: 0,
		signal: (pid, name) => {
			signals.push([pid, name]);
			if (pid === 2 && name === "SIGTERM") {
				table.delete(2);
				table.set(1, "new-owner");
			}
		},
	});
	assert.deepEqual(signals.filter(([pid]) => pid === 1), [], "the parent pid is another process now, so it gets no signal");
});

test("an unknown process table is reported as unresolved, not as gone (G5)", async () => {
	// ps fails, so no pid can be confirmed: the stop must not claim the tree is gone.
	let failing = false;
	const reader = {
		start: () => "start-1",
		table: () => new Map([[1, { ppid: 0, start: "start-1" }]]),
		alive: () => (failing ? null : []),
	};
	const entries = [{ pid: 1, start: "start-1" }];
	// ps answers for the first identity check, then fails for every read after the signal.
	const result = await stopTrees([{ entries }], { reader, graceMs: 100, killMs: 100, signal: () => { failing = true; } });
	assert.deepEqual(result.unresolved, entries, "the pid is unknown, so it is unresolved");
	assert.deepEqual(result.survivors, [], "unknown is not a confirmed survivor");
	assert.equal(result.lastSignal, "SIGKILL", "the last signal that was sent is reported, not an invented one");
});

test("a stop reports the signal it sent last and the identities it could not settle (G8)", async () => {
	// The tree never settles: the report must name SIGKILL and keep the entries as unresolved.
	const rows = [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }];
	const table = new Map(rows.map((row) => [row.pid, { ppid: row.ppid, start: `start-${row.pid}` }]));
	const reader = {
		start: (pid) => table.get(pid)?.start,
		table: () => new Map(table),
		alive: () => null,
	};
	const signals = [];
	const result = await stopTrees([{ entries: [rootOf(1), { pid: 2, start: "start-2" }] }], { reader, graceMs: 0, killMs: 0, signal: (pid, name) => signals.push([pid, name]) });
	assert.deepEqual(signals, [[2, "SIGTERM"], [1, "SIGTERM"], [1, "SIGKILL"], [2, "SIGKILL"]], "children first, then both, with the identity checked each time");
	assert.equal(result.lastSignal, "SIGKILL", "the last signal is reported, not an invented SIGTERM");
	assert.equal(result.escalated, true);
	assert.equal(result.unresolved.length, 2, "an unreadable table leaves identities unresolved");
});

test("a command timeout stops only that command's tree (G4)", { timeout: 30000 }, async () => {
	const sibling = spawn("sleep", ["30"], { stdio: "ignore" });
	try {
		const result = await run("sleep", ["30"], { timeoutMs: 400 });
		assert.equal(result.timedOut, true);
		assert.equal(result.code, null, "a timed-out command is never a success");
		assert.equal(alive(sibling.pid), true, "a sibling child of wv outlived another command's timeout");
	} finally {
		sibling.kill("SIGKILL");
	}
});

test("a command that writes past the byte cap keeps nothing after the overflow (H1)", { timeout: 30000 }, async () => {
	// A fast writer that ignores SIGTERM: without a check before the append, memory grows for 3 s.
	const dir = mkdtempSync(join(tmpdir(), "wv-cap-"));
	const script = join(dir, "fast.sh");
	writeFileSync(script, `#!/bin/sh\ntrap "" TERM\nwhile :; do printf 'x%.0s' 1 2 3 4 5 6 7 8; done\n`);
	chmodSync(script, 0o755);
	try {
		const error = await run(script, [], { maxBuffer: 1024, timeoutMs: 20000 }).then(() => null, (e) => e);
		assert.ok(error instanceof Error, "the call rejects");
		assert.match(error.message, /output over/);
		assert.ok(error.retained <= 1024 + 65536, `retained ${error.retained} bytes after a 1024-byte cap`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	await assert.rejects(run("yes", [], { maxBuffer: 4096, timeoutMs: 20000 }), /output over/);
	// Below the cap the same command is stopped by its timeout, not by the cap.
	const small = await run("sh", ["-c", "head -c 100 /dev/zero"], { maxBuffer: 4096 });
	assert.equal(small.code, 0);
	assert.equal(small.stdout.length, 100);
});

test("a stop that misses its deadline reports the last signal and the unresolved pids (G8)", { timeout: 30000 }, async () => {
	// The child ignores SIGTERM, and the stop deadline is shorter than its grace: the stop cannot settle it.
	const dir = mkdtempSync(join(tmpdir(), "wv-deadline-"));
	const script = join(dir, "stubborn.sh");
	writeFileSync(script, `#!/bin/sh\ntrap "" TERM\nsleep 30\n`);
	chmodSync(script, 0o755);
	try {
		const result = await run(script, [], { timeoutMs: 300, stopDeadlineMs: 50 });
		assert.equal(result.timedOut, true);
		assert.equal(result.code, null);
		assert.match(result.signal, /^SIGTERM$/, "the signal the stop sent is reported");
		assert.ok(result.unresolved.length > 0, "the stopped tree is unresolved, not an empty survivor list");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a timed-out ffmpeg that exits 0 is a failure at the callers (G3)", { timeout: 40000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-exit0-"));
	// ffmpeg exits 0 when it gets SIGTERM: the old callers saw a normal exit and used empty output.
	const fake = join(dir, "ffmpeg");
	writeFileSync(fake, `#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 0.2; done\n`);
	chmodSync(fake, 0o755);
	writeFileSync(join(dir, "film.mp4"), "not a video");
	const saved = process.env.PATH;
	process.env.PATH = `${dir}${delimiter}${saved ?? ""}`;
	try {
		const { loudness } = await import("../skills/walkthrough-video/scripts/film/audio.mjs");
		const { detectCuts } = await import("../skills/walkthrough-video/scripts/film/measure.mjs");
		await assert.rejects(loudness(join(dir, "film.mp4"), { timeoutMs: 300 }), /did not finish in 1 min/);
		await assert.rejects(detectCuts(join(dir, "film.mp4"), 60, { timeoutMs: 300 }), /did not finish in 1 min/);
	} finally {
		process.env.PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a silent failure still has a reason, so a caller cannot read it as success (M1)", { timeout: 40000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-silent-"));
	// ffmpeg exits 7 with no output; another command kills itself with SIGKILL.
	const fake = join(dir, "ffmpeg");
	writeFileSync(fake, "#!/bin/sh\nexit 7\n");
	chmodSync(fake, 0o755);
	writeFileSync(join(dir, "film.mp4"), "not a video");
	const saved = process.env.PATH;
	process.env.PATH = `${dir}${delimiter}${saved ?? ""}`;
	try {
		const { failed } = await import("../skills/walkthrough-video/scripts/lib/proc.mjs");
		const { loudness } = await import("../skills/walkthrough-video/scripts/film/audio.mjs");
		const { detectCuts } = await import("../skills/walkthrough-video/scripts/film/measure.mjs");
		await assert.rejects(loudness(join(dir, "film.mp4")), /exit code 7/);
		await assert.rejects(detectCuts(join(dir, "film.mp4"), 60), /exit code 7/);
		const killed = await run("sh", ["-c", "kill -9 $$"], {});
		assert.equal(killed.code, null);
		assert.equal(killed.timedOut, false);
		assert.match(failed(killed, 10), /stopped by SIGKILL/, "a self-killed command names the signal");
		assert.equal(failed({ code: 0, stderr: "" }, 10), null, "a clean exit is not a failure");
	} finally {
		process.env.PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed first table read reports the saved roots as unresolved (G5 rest)", { timeout: 30000 }, async () => {
	// A real child, so the saved root is a real identity; every read fails, as a broken ps does.
	const child = spawn("sleep", ["30"], { stdio: "ignore" });
	const { detectReader } = await import("../skills/walkthrough-video/scripts/lib/proc.mjs");
	const root = { pid: child.pid, start: detectReader().start(child.pid) };
	assert.ok(root.start, "the child has an identity");
	const broken = {
		table: () => null,
		start: () => undefined,
		alive: () => null,
	};
	try {
		const snap = snapshotTree([root], broken.table());
		assert.deepEqual(snap.entries.map((entry) => entry.pid), [child.pid], "the saved root survives the failed read");
		const signals = [];
		const result = await stopTrees([snap], { reader: broken, graceMs: 0, killMs: 0, signal: (pid, name) => signals.push([pid, name]) });
		assert.deepEqual(signals, [], "an unknown identity is never signalled");
		assert.deepEqual(result.unresolved.map((entry) => entry.pid), [child.pid], "the child is unresolved, not silently gone");
		assert.deepEqual(result.survivors, [], "unknown is not a confirmed survivor");
	} finally {
		child.kill("SIGKILL");
	}
});

test("the whole-tool stop survives a failed first table read and keeps the tracked roots", { timeout: 30000 }, async () => {
	// A broken ps on macOS makes table() null; the shutdown must not throw on it.
	const { spawnChild, stopChildTrees } = await import("../skills/walkthrough-video/scripts/lib/proc.mjs");
	const child = spawnChild("sleep", ["30"], { stdio: "ignore" });
	const broken = { table: () => null, start: () => undefined, alive: () => null };
	try {
		const signals = [];
		const result = await stopChildTrees({ reader: broken, graceMs: 0, killMs: 0, signal: (pid, name) => signals.push([pid, name]) });
		assert.deepEqual(signals, [], "an unknown identity is never signalled");
		assert.ok(result.unresolved.some((entry) => entry.pid === child.pid), "the tracked child is unresolved, not silently gone");
	} finally {
		child.kill("SIGKILL");
	}
});
