/**
 * A job's systemd scope goes into the restart hand-over, so the Pi that adopts
 * the job still ends the job's setsid children when the job's shell has ended.
 * A scope is never read back from /proc for a leader that is not verified,
 * and a hand-over scope that is not a shell-jobs scope is refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { newScope, scopeSupported, scopeSlice } from "../lib/process-tree.ts";
import { registry, scopeOf, stopGroup, type Job } from "../lib/shell-jobs-process.ts";
import { jobsFromHandover, toHandoverJob } from "../lib/shell-jobs-adopt.ts";
import { type Handover, parseHandover } from "../lib/shell-jobs-handover.ts";
import { killMarked, marked, marker as mark, survivors } from "./support/process-marks.ts";

const scope = scopeSupported();
const marker = () => mark(5000);

function job(pid: number): Job {
	return {
		id: "tree", pid, pidStart: null, command: "x", title: null, toolCallId: null, cwd: "/tmp", logPath: "/tmp/pi-shell-jobs-x/tree.log",
		exitPath: "/tmp/pi-shell-jobs-x/tree.exit", startedAt: 1, epoch: 0, state: "running", code: null, signal: null, endedAt: null,
		claimed: false, attempts: 0, delivered: false, deliveryFailed: false, cleanupError: null, runtimeId: "r1",
	};
}

function handover(jobs: Handover["jobs"]): Handover {
	return { version: 1, writtenAt: 1, sessionFile: "/s.jsonl", sessionId: null, runtimeId: "r1", logDir: "/tmp/pi-shell-jobs-x", counter: 1, abandoned: 0, jobs };
}

/** Round trip through the file format, as a restart does. */
function reread(record: Handover): Handover {
	const parsed = parseHandover(JSON.stringify(record));
	assert.notEqual(typeof parsed, "string", String(parsed));
	return parsed as Handover;
}

test("an adopted job's setsid child ends when the job's shell has ended", { skip: scope ? false : "no systemd user scope here", timeout: 20_000 }, async () => {
	const value = marker();
	try {
		const wrapped = newScope("pi-job", ["/bin/sh", "-c", `setsid sh -c 'sleep ${value}' & sleep 0.3`]);
		assert.ok(wrapped);
		const [file, ...args] = wrapped.argv;
		const child = spawn(file!, args, { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] });
		await once(child, "spawn");
		const pid = child.pid!;
		registry().scopes!.set(pid, wrapped.dir);
		const saved = reread(handover([toHandoverJob(job(pid))]));
		assert.equal(saved.jobs[0]!.scope, wrapped.dir);
		await once(child, "exit");
		assert.ok(marked(value).length > 0, "the setsid child runs on");
		// A new Pi process: no scope is known until the hand-over gives it.
		registry().scopes!.delete(pid);
		jobsFromHandover(saved, "r2", 1);
		assert.equal(scopeOf(pid), wrapped.dir);
		const outcome = await stopGroup(pid, 300);
		assert.equal(outcome.cleaned, true);
		assert.deepEqual(await survivors(value), []);
	} finally { killMarked(value); }
});

test("a scope is not read from /proc for a pid that has no record", { skip: scope ? false : "no systemd user scope here", timeout: 20_000 }, async () => {
	const value = marker();
	try {
		const wrapped = newScope("pi-job", ["/bin/sh", "-c", `sleep ${value}`]);
		assert.ok(wrapped);
		const [file, ...args] = wrapped.argv;
		const child = spawn(file!, args, { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] });
		await once(child, "spawn");
		for (let waited = 0; waited < 3000 && marked(value).length === 0; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
		registry().scopes!.delete(child.pid!);
		assert.equal(scopeOf(child.pid!), undefined);
	} finally { killMarked(value); }
});

test("a hand-over scope that is not a shell-jobs scope under this user's slice is refused", () => {
	const slice = scopeSlice() ?? "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice";
	const bad = [
		join(slice, "pi-bash-1-abc.scope"),
		"/sys/fs/cgroup/system.slice/pi-job-1-abc.scope",
		join(slice, "..", "pi-job-1-abc.scope"),
	];
	for (const [index, dir] of bad.entries()) {
		const pid = 2 ** 22 + 100 + index;
		const saved = reread(handover([{ ...toHandoverJob(job(pid)), scope: dir }]));
		registry().scopes!.delete(pid);
		jobsFromHandover(saved, "r2", 1);
		assert.equal(scopeOf(pid), undefined, dir);
	}
	assert.equal(typeof parseHandover(JSON.stringify(handover([{ ...toHandoverJob(job(2 ** 22 + 200)), scope: 7 as unknown as string }]))), "string");
});
