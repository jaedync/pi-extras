/**
 * The hand-over file that lets background shell jobs outlive a Pi restart,
 * the exit-code wrapper, and the restart intent that auto-update sets.
 * Pure library code and real `sh` processes; no Pi session.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimHandover,
	HANDOVER_MAX_AGE_MS,
	type Handover,
	handoverPath,
	readExitCode,
	writeHandover,
} from "../lib/shell-jobs-handover.ts";
import { withExitFile } from "../lib/shell-jobs-launch.ts";
import { clearRestart, markRestart, RESTART_INTENT_MS, restartPending } from "../lib/restart-intent.ts";

const dirs: string[] = [];
function temp(prefix = "handover-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	clearRestart();
});

function record(overrides: Partial<Handover> = {}): Handover {
	const logDir = overrides.logDir ?? temp("pi-shell-jobs-");
	return {
		version: 1,
		writtenAt: Date.now(),
		sessionFile: "/sessions/a.jsonl",
		sessionId: "s1",
		runtimeId: "abc123def456",
		logDir,
		counter: 1,
		abandoned: 0,
		jobs: [{
			id: "run-tests", title: "Run tests", command: "npm test", cwd: "/tmp", toolCallId: "call-1",
			pid: 4242, pidStart: "12345", logPath: join(logDir, "run-tests.log"), exitPath: join(logDir, "run-tests.exit"),
			startedAt: Date.now() - 1000, state: "running", code: null, signal: null, endedAt: null,
			claimed: false, attempts: 0, delivered: false, deliveryFailed: false, cleanupError: null, stoppedBackground: 0,
		}],
		...overrides,
	};
}

test("a hand-over file is written with mode 0600 in a 0700 folder and is read back once", () => {
	const agentDir = temp();
	const written = record();
	const path = writeHandover(agentDir, written);
	assert.equal(path, handoverPath(agentDir, written.sessionFile));
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(statSync(join(agentDir, "shell-jobs", "handover")).mode & 0o777, 0o700);
	assert.deepEqual(readdirSync(join(agentDir, "shell-jobs", "handover")), [path.split("/").at(-1)], "no temp file left behind");
	const claimed = claimHandover(agentDir, written.sessionFile, Date.now());
	assert.equal(claimed.kind, "ok");
	assert.deepEqual(claimed.kind === "ok" ? claimed.record : undefined, written);
	assert.equal(existsSync(path), false, "a claim removes the file");
	assert.deepEqual(claimHandover(agentDir, written.sessionFile, Date.now()), { kind: "none" }, "a second claim finds nothing");
});

test("each session has its own hand-over file", () => {
	const agentDir = temp();
	assert.notEqual(handoverPath(agentDir, "/sessions/a.jsonl"), handoverPath(agentDir, "/sessions/b.jsonl"));
	writeHandover(agentDir, record());
	assert.deepEqual(claimHandover(agentDir, "/sessions/b.jsonl", Date.now()), { kind: "none" });
});

test("a corrupt, partial or forged hand-over file is refused with a reason and removed", () => {
	const agentDir = temp();
	const good = record();
	const bad: Array<[string, string]> = [
		["garbage", "not json at all"],
		["partial", JSON.stringify(good).slice(0, 40)],
		["wrong version", JSON.stringify({ ...good, version: 2 })],
		["other session", JSON.stringify({ ...good, sessionFile: "/sessions/other.jsonl" })],
		["bad id", JSON.stringify({ ...good, jobs: [{ ...good.jobs[0], id: "../x" }] })],
		["log outside its folder", JSON.stringify({ ...good, jobs: [{ ...good.jobs[0], logPath: "/etc/passwd" }] })],
		["exit file outside its folder", JSON.stringify({ ...good, jobs: [{ ...good.jobs[0], exitPath: "/tmp/x.exit" }] })],
		["folder not a job folder", JSON.stringify({ ...good, logDir: "/home" })],
		["bad pid", JSON.stringify({ ...good, jobs: [{ ...good.jobs[0], pid: -1 }] })],
		["pid 1", JSON.stringify({ ...good, jobs: [{ ...good.jobs[0], pid: 1 }] })],
	];
	for (const [what, text] of bad) {
		const path = handoverPath(agentDir, good.sessionFile);
		mkdirSync(join(agentDir, "shell-jobs", "handover"), { recursive: true, mode: 0o700 });
		writeFileSync(path, text, { mode: 0o600 });
		const claimed = claimHandover(agentDir, good.sessionFile, Date.now());
		assert.equal(claimed.kind, "bad", what);
		assert.equal(typeof (claimed as { reason?: unknown }).reason, "string", what);
		assert.equal(existsSync(path), false, `${what}: the file is removed`);
	}
});

test("a hand-over file that others can read is refused", () => {
	const agentDir = temp();
	const path = writeHandover(agentDir, record());
	chmodSync(path, 0o644);
	assert.equal(claimHandover(agentDir, "/sessions/a.jsonl", Date.now()).kind, "bad");
});

test("a record older than 24 h is dropped", () => {
	const agentDir = temp();
	const now = Date.now();
	writeHandover(agentDir, record({ writtenAt: now - HANDOVER_MAX_AGE_MS - 1 }));
	assert.equal(claimHandover(agentDir, "/sessions/a.jsonl", now).kind, "stale");
	writeHandover(agentDir, record({ writtenAt: now - HANDOVER_MAX_AGE_MS + 1000 }));
	assert.equal(claimHandover(agentDir, "/sessions/a.jsonl", now).kind, "ok");
});

test("an exit file gives a code, or null for garbage, or undefined when there is none", () => {
	const dir = temp();
	const path = join(dir, "j.exit");
	assert.equal(readExitCode(path), undefined);
	writeFileSync(path, "0\n");
	assert.equal(readExitCode(path), 0);
	writeFileSync(path, "137\n");
	assert.equal(readExitCode(path), 137);
	writeFileSync(path, "lots\n");
	assert.equal(readExitCode(path), null);
	writeFileSync(path, "");
	assert.equal(readExitCode(path), null);
});

async function run(launch: { shell: string; args: readonly string[]; env: NodeJS.ProcessEnv }) {
	const child = spawn(launch.shell, [...launch.args], { env: launch.env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (chunk) => { out += chunk; });
	const [code] = await once(child, "exit");
	return { code: code as number, out };
}

test("the wrapper writes the command's exit code next to the log and keeps its status and output", async () => {
	const dir = temp();
	const exitPath = join(dir, "it's here.exit");
	const plain = { shell: "/bin/bash", args: ["-c", "echo \"$0\" out; exit 7"], env: process.env };
	const result = await run(withExitFile(plain, exitPath));
	assert.equal(result.code, 7);
	assert.equal(result.out, "/bin/bash out\n");
	assert.equal(readFileSync(exitPath, "utf8"), "7\n");
	assert.deepEqual(readdirSync(dir), ["it's here.exit"], "no temp file left behind");
	const ok = await run(withExitFile({ ...plain, args: ["-c", "true"] }, exitPath));
	assert.equal(ok.code, 0);
	assert.equal(readExitCode(exitPath), 0);
});

test("restart intent: set for one session file, cleared, and expires", () => {
	const now = 1_000_000;
	assert.equal(restartPending("/s/a.jsonl", now), false);
	markRestart("/s/a.jsonl", now);
	assert.equal(restartPending("/s/a.jsonl", now + 1), true);
	assert.equal(restartPending("/s/b.jsonl", now + 1), false, "another session");
	assert.equal(restartPending(undefined, now + 1), false, "a session with no file");
	assert.equal(restartPending("/s/a.jsonl", now + RESTART_INTENT_MS + 1), false, "an old intent");
	clearRestart();
	assert.equal(restartPending("/s/a.jsonl", now + 1), false);
});
