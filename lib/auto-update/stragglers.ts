/**
 * Processes that a smoke test Pi left behind. An extension can start a
 * server in its own session or process group (the pi-intercom broker does),
 * so the stop of Pi's group does not reach it, and it outlives the test with
 * a deleted home. Each smoke Pi gets a unique marker in its environment; a
 * child inherits it, so a scan for the marker finds those servers.
 */
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { signal } from "../process-tree.ts";

export const SMOKE_MARKER_VAR = "PI_EXTRAS_SMOKE_ID";
const POLL_MS = 100;
/** A read of /proc/<pid>/environ or a ps run that takes longer is stuck (a process in D state holds its memory lock). */
const SCAN_LIMIT_MS = 5_000;
/** `ps -E -ww` prints the whole environment of every process of the user: several MB on a busy Mac. */
const PS_MAX_BUFFER = 64 * 1024 * 1024;

const run = promisify(execFile);

/** A process that exited during the scan (ENOENT, ESRCH) or belongs to another user (EACCES, EPERM). */
const NOT_OURS = new Set(["ENOENT", "ESRCH", "EACCES", "EPERM"]);
const codeOf = (error: unknown) => (typeof error === "object" && error !== null && "code" in error ? String(error.code) : "");

/**
 * The environment of a process; undefined when it is gone, not ours, or stuck past the limit. Other failures throw.
 * An abort signal cannot end a read that the kernel blocks, so a timer ends the wait instead; the stuck read keeps
 * one worker thread until the kernel returns.
 */
async function environ(pid: number): Promise<string | undefined> {
	let timer: NodeJS.Timeout | undefined;
	const stuck = new Promise<undefined>((done) => { timer = setTimeout(done, SCAN_LIMIT_MS, undefined); });
	try {
		return await Promise.race([readFile(`/proc/${pid}/environ`, "utf8"), stuck]);
	} catch (error) {
		if (NOT_OURS.has(codeOf(error))) return undefined;
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/** Linux: /proc/<pid>/environ, readable only for our own processes. Async, so a stuck read cannot block the cycle. */
async function procMarked(entry: string): Promise<number[]> {
	const pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number);
	const environments = await Promise.all(pids.map(environ));
	return pids.filter((_, index) => environments[index]?.split("\0").includes(entry));
}

/** macOS and others: `ps -E` appends each process's environment to its command line. */
async function psMarked(entry: string): Promise<number[]> {
	const uid = process.getuid?.();
	const { stdout } = await run("ps", ["-E", "-ww", "-o", "pid=,command=", ...(uid === undefined ? [] : ["-U", String(uid)])],
		{ encoding: "utf8", maxBuffer: PS_MAX_BUFFER, timeout: SCAN_LIMIT_MS });
	return stdout.split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s(.*)$/.exec(line);
		return match && match[2].split(/\s/).includes(entry) ? [Number(match[1])] : [];
	});
}

/** The pids of this user's processes whose environment holds `PI_EXTRAS_SMOKE_ID=<marker>`, except this process. */
export async function markedPids(marker: string, platform: NodeJS.Platform = process.platform): Promise<number[]> {
	const entry = `${SMOKE_MARKER_VAR}=${marker}`;
	const found = platform === "linux" ? await procMarked(entry) : await psMarked(entry);
	return found.filter((pid) => pid !== process.pid);
}

/** Signals each pid; one that fails does not stop the others. Returns the pids it reached, and throws the failures after. */
function signalAll(pids: readonly number[], name: NodeJS.Signals): number[] {
	const reached: number[] = [];
	const failures: unknown[] = [];
	for (const pid of pids) {
		try {
			if (signal(pid, name)) reached.push(pid);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, `could not signal ${failures.length} of ${pids.length} processes`);
	return reached;
}

/**
 * SIGTERM to each marked process, then SIGKILL after `graceMs` to the ones that still carry the marker: a pid that
 * exited in the grace time can belong to another process by then. Returns the pids it signalled.
 */
export async function stopMarked(marker: string, graceMs: number): Promise<number[]> {
	const pids = signalAll(await markedPids(marker), "SIGTERM");
	for (let waited = 0; waited < graceMs && pids.some((pid) => signal(pid, 0)); waited += POLL_MS) {
		await new Promise((done) => setTimeout(done, POLL_MS));
	}
	if (pids.some((pid) => signal(pid, 0))) {
		const left = new Set(await markedPids(marker));
		signalAll(pids.filter((pid) => left.has(pid)), "SIGKILL");
	}
	return pids;
}
