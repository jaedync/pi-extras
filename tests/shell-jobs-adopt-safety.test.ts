/**
 * Signal safety of adopted jobs: a group is touched only while its leader is
 * gone or still the recorded process, and hand-overs that no restart claimed
 * do not leave jobs running for good. Real processes, no Pi session.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimForSession, laterLook, leaderState, startIdentity, sweepHandovers, toHandoverJob } from "../lib/shell-jobs-adopt.ts";
import { claimHandover, HANDOVER_MAX_AGE_MS, type Handover, handoverDir, handoverPath, writeHandover } from "../lib/shell-jobs-handover.ts";

const linux = process.platform === "linux";
const dirs: string[] = [];
const children: ChildProcess[] = [];
function temp(prefix = "adopt-safety-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const child of children.splice(0)) try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A detached `sleep`: the leader of its own group, as a job is. */
function group(): ChildProcess {
	const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	children.push(child);
	return child;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms = 3000): Promise<boolean> {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (check()) return true;
	return check();
}
async function gonePid(): Promise<number> {
	const child = spawn("true", { stdio: "ignore" });
	await once(child, "exit");
	return child.pid!;
}
const job = (fields: Record<string, unknown>): Record<string, unknown> => ({ adopted: true, state: "running", ...fields });

function record(agentDir: string, pid: number, pidStart: string | null, writtenAt = Date.now(), sessionFile = "/sessions/a.jsonl"): Handover {
	const logDir = temp("pi-shell-jobs-");
	const value: Handover = {
		version: 1, writtenAt, sessionFile, sessionId: "s1", runtimeId: "abc123def456", logDir, counter: 1, abandoned: 0,
		jobs: [{
			id: "dev", title: "Dev server", command: "sleep 30", cwd: "/tmp", toolCallId: null, pid, pidStart,
			logPath: join(logDir, "dev.log"), exitPath: join(logDir, "dev.exit"), startedAt: writtenAt - 1000, state: "running",
			code: null, signal: null, endedAt: null, claimed: false, attempts: 0, delivered: false, deliveryFailed: false, cleanupError: null, stoppedBackground: 0,
		}],
	};
	writeHandover(agentDir, value);
	return value;
}

test("a live pid with another start time is a new process: its group is never touched", { skip: !linux }, async () => {
	const other = group();
	const exitPath = join(temp(), "job.exit");
	const reused = job({ pid: other.pid, pidStart: "1", exitPath }) as never;
	assert.equal(laterLook(reused, Date.now())?.touchGroup, false, "no exit file");
	writeFileSync(exitPath, "0\n");
	assert.equal(laterLook(reused, Date.now())?.touchGroup, false, "an exit file, but the pid is someone else's now");
});

test("a leader that is gone or still the recorded process leaves its group to clean up", async () => {
	const pid = await gonePid();
	assert.equal(laterLook(job({ pid, pidStart: "1", exitPath: null }) as never, Date.now())?.touchGroup, true);
	const exitPath = join(temp(), "job.exit");
	writeFileSync(exitPath, "3\n");
	const same = group();
	const ended = laterLook(job({ pid: same.pid, pidStart: startIdentity(same.pid!), exitPath }) as never, Date.now());
	assert.equal(ended?.code, 3);
	assert.equal(ended?.touchGroup, true);
});

test("a running child of this process goes over with its start time, also when it started before start times were kept", () => {
	const child = group();
	const saved = toHandoverJob({ ...job({ pid: child.pid, pidStart: undefined, exitPath: null }), adopted: false, title: "x", command: "c", cwd: "/", logPath: "/l", startedAt: 1, code: null, signal: null, endedAt: null, claimed: false, attempts: 0, delivered: false, deliveryFailed: false } as never);
	assert.equal(saved.pidStart, startIdentity(child.pid!));
	assert.equal(typeof saved.pidStart, "string");
	const unverified = toHandoverJob({ ...job({ pid: child.pid, pidStart: undefined, exitPath: null, unverified: true }), title: "x", command: "c", cwd: "/", logPath: "/l", startedAt: 1, code: null, signal: null, endedAt: null, claimed: false, attempts: 0, delivered: false, deliveryFailed: false } as never);
	assert.equal(unverified.pidStart, null, "an adopted job that was never verified stays unverified");
});

test("a stale hand-over stops its jobs that are still the recorded processes, and leaves a reused pid alone", async () => {
	const agentDir = temp();
	const job1 = group();
	record(agentDir, job1.pid!, startIdentity(job1.pid!), Date.now() - HANDOVER_MAX_AGE_MS - 1000);
	assert.equal(claimForSession(agentDir, "startup", { sessionFile: "/sessions/a.jsonl", sessionId: "s1" }, () => {}), undefined);
	assert.ok(await until(() => !alive(job1.pid!)), "the stale job was stopped");
	const other = group();
	record(agentDir, other.pid!, "1", Date.now() - HANDOVER_MAX_AGE_MS - 1000);
	claimForSession(agentDir, "startup", { sessionFile: "/sessions/a.jsonl", sessionId: "s1" }, () => {});
	await new Promise((r) => setTimeout(r, 300));
	assert.ok(alive(other.pid!), "a pid with another start time is not signalled");
});

test("a sweep at any start stops the jobs of hand-overs no restart claimed, and removes leftovers", async () => {
	const agentDir = temp();
	const stale = group();
	const fresh = group();
	record(agentDir, stale.pid!, startIdentity(stale.pid!), Date.now() - HANDOVER_MAX_AGE_MS - 1000, "/sessions/old.jsonl");
	const freshPath = handoverPath(agentDir, "/sessions/new.jsonl");
	record(agentDir, fresh.pid!, startIdentity(fresh.pid!), Date.now(), "/sessions/new.jsonl");
	const dir = handoverDir(agentDir);
	mkdirSync(dir, { recursive: true });
	const leftover = join(dir, "x.json.123.abcd.claimed");
	const young = join(dir, ".y.json.123.abcd.tmp");
	writeFileSync(leftover, "{}", { mode: 0o600 });
	writeFileSync(young, "{}", { mode: 0o600 });
	const old = (Date.now() - 2 * 3600_000) / 1000;
	utimesSync(leftover, old, old);
	assert.equal(await sweepHandovers(agentDir, Date.now(), () => {}), 1);
	assert.ok(await until(() => !alive(stale.pid!)), "the unclaimed job was stopped");
	assert.ok(alive(fresh.pid!), "a hand-over a restart may still claim is left alone");
	assert.ok(existsSync(freshPath));
	assert.equal(existsSync(handoverPath(agentDir, "/sessions/old.jsonl")), false);
	assert.equal(existsSync(leftover), false, "an old claim leftover is removed");
	assert.ok(existsSync(young), "a young temp file may still be in use");
});

test("a start time that cannot be read is not taken as a process that is gone", async () => {
	const gone = await gonePid();
	assert.equal(leaderState(process.pid, "1", () => "1"), "same");
	assert.equal(leaderState(process.pid, "1", () => "2"), "other");
	assert.equal(leaderState(process.pid, "1", () => null), "other", "a live pid whose start time failed to read may be anyone's");
	assert.equal(leaderState(gone, "1", () => null), "gone");
});

test("a sweep never ends a fresh hand-over: not through a stale file under another name, and not in a race", async () => {
	const agentDir = temp();
	const fresh = group();
	record(agentDir, fresh.pid!, startIdentity(fresh.pid!));
	const freshPath = handoverPath(agentDir, "/sessions/a.jsonl");
	// A stale record for the same session under a name that is not its own.
	const odd = join(handoverDir(agentDir), "0123456789abcdef0123456789abcdef.json");
	const stale = JSON.parse(readFileSync(freshPath, "utf8"));
	writeFileSync(odd, JSON.stringify({ ...stale, writtenAt: Date.now() - HANDOVER_MAX_AGE_MS - 1000 }), { mode: 0o600 });
	await sweepHandovers(agentDir, Date.now(), () => {});
	assert.ok(existsSync(freshPath), "the fresh hand-over is still there for the restart");
	assert.ok(alive(fresh.pid!));
	assert.equal(existsSync(odd), false, "a stale file under a name that is not its own is removed");
	// The race: a sweep that read a stale record claims after a restart wrote a fresh one.
	assert.equal(claimHandover(agentDir, "/sessions/a.jsonl", Date.now(), true).kind, "fresh");
	assert.ok(existsSync(freshPath), "a stale-only claim puts a fresh record back");
	assert.equal(claimHandover(agentDir, "/sessions/a.jsonl", Date.now()).kind, "ok");
});

test("a job that is stopping goes over with no start time: its pid may be reaped and reused", () => {
	const child = group();
	const fields = { title: "x", command: "c", cwd: "/", logPath: "/l", startedAt: 1, code: null, signal: null, endedAt: null, claimed: false, attempts: 0, delivered: false, deliveryFailed: false };
	const saved = toHandoverJob({ ...job({ pid: child.pid, pidStart: undefined, exitPath: null }), adopted: false, state: "stopping", ...fields } as never);
	assert.equal(saved.pidStart, null);
});
