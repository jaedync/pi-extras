/**
 * shell-jobs-adopt: the process side of a hand-over. Turns a runtime's jobs
 * into a hand-over record and a record back into jobs, and tells when an
 * adopted job ended. An adopted job is not this process's child, so it ends
 * when its exit file appears (the wrapper in shell-jobs-launch writes it) or
 * when its process is gone. A pid is signalled only while its start time
 * still matches the one recorded when the job started: a reused pid is never
 * signalled. No Pi API lives here.
 */
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { processStart } from "./auto-update/leases.ts";
import { claimHandover, type Handover, handoverDir, HANDOVER_MAX_AGE_MS, type HandoverJob, handoverPath, ownLogDir, parseHandover, readExitCode } from "./shell-jobs-handover.ts";
import { type Job, type Runtime, stopGroup } from "./shell-jobs-process.ts";

/** How often a process that is not this one's child is checked for its end. */
export const ADOPTED_POLL_MS = 500;

/** The start time of `pid` as the system tells it, or null when it cannot tell (no such process, or no /proc and no ps). */
export function startIdentity(pid: number): string | null {
	try {
		return processStart(pid) ?? null;
	} catch {
		return null;
	}
}

/**
 * True when a signal to this job's group reaches this job: always for a child
 * of this process (it cannot be reaped, so its pid cannot be reused, before
 * Pi sees its exit), and for an adopted job only while its leader is the
 * process that was recorded.
 */
export function mayStop(job: Job): boolean {
	if (job.adopted !== true) return true;
	if (job.unverified === true || typeof job.pidStart !== "string") return false;
	return startIdentity(job.pid) === job.pidStart;
}

/** A process that is gone or a zombie no one reaped yet: on Linux /proc tells both; elsewhere only that the pid exists. */
function processAlive(job: Job): boolean {
	if (process.platform === "linux") {
		let stat: string;
		try {
			stat = readFileSync(`/proc/${job.pid}/stat`, "utf8");
		} catch {
			return false;
		}
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (fields[0] === "Z" || fields[0] === "X") return false;
		return typeof job.pidStart !== "string" || fields[19] === job.pidStart;
	}
	if (!pidExists(job.pid)) return false;
	// Elsewhere ps gives the start time: a pid that another process now holds means the job ended. A failed read keeps waiting.
	if (typeof job.pidStart !== "string") return true;
	const current = startIdentity(job.pid);
	return current === null || current === job.pidStart;
}

export interface Ending {
	readonly code: number | null;
	readonly codeUnknown: boolean;
	readonly endedAt: number;
	/** The group may hold leftovers of this job, so it may be cleaned up: false when the job ended unseen. */
	readonly touchGroup: boolean;
}

function exitEnding(job: Job, now: number, touchGroup: boolean): Ending | null {
	if (typeof job.exitPath !== "string") return null;
	const code = readExitCode(job.exitPath);
	if (code === undefined) return null;
	let endedAt = now;
	try {
		endedAt = Math.min(now, statSync(job.exitPath).mtimeMs);
	} catch {
		// Gone between the two reads; the time of this check stands in.
	}
	return { code, codeUnknown: code === null, endedAt, touchGroup };
}

const unknownEnding = (now: number): Ending => ({ code: null, codeUnknown: true, endedAt: now, touchGroup: false });

/**
 * The first look at an adopted job that was running at the hand-over: still
 * the same process (null), or how it ended in the gap. Its group is left
 * alone, since nothing here saw it alive. A job with no recorded start time
 * runs on unverified: it ends by its exit file, and is never signalled.
 */
export function firstLook(job: Job, now: number): { ending: Ending | null; unverified: boolean } {
	const exited = exitEnding(job, now, false);
	if (exited) return { ending: exited, unverified: false };
	if (typeof job.pidStart === "string") {
		return startIdentity(job.pid) === job.pidStart ? { ending: null, unverified: false } : { ending: unknownEnding(now), unverified: false };
	}
	return processAlive(job) ? { ending: null, unverified: true } : { ending: unknownEnding(now), unverified: false };
}

/**
 * The group of an ended leader may still be cleaned up: the leader is gone (its
 * id cannot be reused as a group id while members of the old group live), or it
 * is still the recorded process (a zombie). A live pid with another start time
 * is a new process, so the group with its id is not this job's.
 */
function groupStillOurs(job: Job): boolean {
	if (job.unverified === true || typeof job.pidStart !== "string") return false;
	return leaderState(job.pid, job.pidStart) !== "other";
}

/** True unless the system says that no process has this pid. */
function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * The recorded leader now: the same process, gone, or another (or unknown)
 * process. A start time that cannot be read (ps failed, /proc refused) counts
 * as gone only when the pid is free; else it may be anyone's.
 */
export function leaderState(pid: number, pidStart: string, read: (pid: number) => string | null = startIdentity, exists: (pid: number) => boolean = pidExists): "same" | "gone" | "other" {
	const current = read(pid);
	if (current === pidStart) return "same";
	if (current !== null) return "other";
	return exists(pid) ? "other" : "gone";
}

/** A later look: the exit file, else the process; the exit file is read again once the process is gone, since it is written first. */
export function laterLook(job: Job, now: number): Ending | null {
	const exited = exitEnding(job, now, false);
	if (exited) return { ...exited, touchGroup: groupStillOurs(job) };
	if (processAlive(job)) return null;
	const ending = exitEnding(job, now, false) ?? unknownEnding(now);
	return { ...ending, touchGroup: groupStillOurs(job) };
}

/**
 * The recorded start time, else, for a running child of this process (a job
 * from before start times were kept), its start time now: it is not reaped
 * yet, so its pid still names it. An adopted job never verified stays without.
 */
function handoverStart(job: Job): string | null {
	if (typeof job.pidStart === "string") return job.pidStart;
	// Only "running" holds an unreaped pid: Node reaps the child before the exit event that moves it to "stopping".
	if (job.adopted === true || job.state !== "running") return null;
	return startIdentity(job.pid);
}

export function toHandoverJob(job: Job): HandoverJob {
	const done = job.state === "done";
	return {
		id: job.id, title: typeof job.title === "string" ? job.title : null, command: job.command, cwd: job.cwd,
		toolCallId: job.toolCallId ?? null, pid: job.pid, pidStart: handoverStart(job),
		logPath: job.logPath, exitPath: typeof job.exitPath === "string" ? job.exitPath : null, startedAt: job.startedAt,
		// A job that is stopping has exited already, or a kill has it: the next process reads how it ended.
		state: done ? "done" : "running",
		code: done ? job.code : null, signal: done ? job.signal : null, endedAt: done ? job.endedAt : null,
		claimed: job.claimed, attempts: job.attempts, delivered: job.delivered, deliveryFailed: job.deliveryFailed,
		cleanupError: done ? job.cleanupError : null, stoppedBackground: job.stoppedBackground ?? 0,
		...(job.codeUnknown === true ? { codeUnknown: true } : {}),
	};
}

export function buildHandover(runtime: Runtime, logDir: string, session: { file: string; id: string | null }, now: number): Handover {
	return {
		version: 1, writtenAt: now, sessionFile: session.file, sessionId: session.id, runtimeId: runtime.runtimeId,
		logDir, counter: runtime.counter, abandoned: runtime.abandoned,
		jobs: [...runtime.jobs.values()].map(toHandoverJob),
	};
}

/**
 * The jobs of a record, as this runtime holds them. A finished completion
 * that was never acknowledged counts as attempted, so the session-start
 * reconcile looks for it in history and sends it only when it is not there.
 */
export function jobsFromHandover(record: Handover, runtimeId: string, epoch: number): Job[] {
	return record.jobs.map((saved) => {
		const undelivered = saved.state === "done" && !saved.delivered && !saved.claimed;
		return {
			...saved,
			epoch,
			runtimeId,
			adopted: true,
			attempts: undelivered ? Math.max(1, saved.attempts) : saved.attempts,
		};
	});
}

type Log = (what: string, error: unknown) => void;

/**
 * The session's hand-over, when this start continues the session that a
 * restart ended: a restart starts `pi --session <file>` ("startup"), and a
 * /resume of that file is the same session too; a new session or a fork
 * never adopts. Problems are logged, never thrown, so a session always starts.
 */
export function claimForSession(agentDir: string, reason: unknown, session: { sessionFile?: string; sessionId?: string }, log: Log): Handover | undefined {
	if (reason !== "startup" && reason !== "resume") return undefined;
	if (session.sessionFile === undefined) return undefined;
	try {
		const claimed = claimHandover(agentDir, session.sessionFile, Date.now());
		if (claimed.kind === "none" || claimed.kind === "fresh") return undefined;
		if (claimed.kind === "bad") {
			log("hand-over file refused", new Error(claimed.reason));
			return undefined;
		}
		if (claimed.kind === "stale") {
			stopUnclaimed(claimed.record, log);
			log("hand-over dropped", new Error(`older than 24 h; its jobs that still run were stopped`));
			return undefined;
		}
		const record = claimed.record;
		if (record.sessionId !== null && session.sessionId !== undefined && record.sessionId !== session.sessionId) {
			log("hand-over file refused", new Error("it names another session id"));
			return undefined;
		}
		if (!ownLogDir(record.logDir)) {
			log("hand-over file refused", new Error("its log folder is gone or not this user's"));
			return undefined;
		}
		return record;
	} catch (error) {
		log("could not read the hand-over", error);
		return undefined;
	}
}

/**
 * A hand-over that no restart claimed in time: its jobs would run on with no
 * owner for good, so they stop as a quit would have stopped them. Only a job
 * whose leader is still the recorded process is signalled.
 */
function stopUnclaimed(record: Handover, log: Log): Promise<unknown> {
	const verified = record.jobs.filter((job) => job.state === "running" && typeof job.pidStart === "string" && job.pid > 1 && startIdentity(job.pid) === job.pidStart);
	return Promise.all(verified.map((job) => stopGroup(job.pid).catch((error: unknown) => log(`could not stop job ${job.id} of an unclaimed hand-over`, error))));
}

// A claim or temp file this old is a leftover of a process that died mid-claim; a younger one may still be in use.
const LEFTOVER_MAX_AGE_MS = 60 * 60_000;

/**
 * At any session start: stop the jobs of hand-overs older than the adoption
 * limit (no restart came for them) and remove old claim and temp leftovers,
 * which hold command text. Returns how many hand-overs it ended.
 */
export async function sweepHandovers(agentDir: string, now: number, log: Log): Promise<number> {
	const dir = handoverDir(agentDir);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	let ended = 0;
	for (const name of names) {
		const path = join(dir, name);
		try {
			if (name.endsWith(".claimed") || name.endsWith(".tmp")) {
				if (now - statSync(path).mtimeMs > LEFTOVER_MAX_AGE_MS) rmSync(path, { force: true });
				continue;
			}
			if (!name.endsWith(".json")) continue;
			// The age is the record's own; the claim below checks owner and mode, and only the file named for its session counts.
			const parsed = parseHandover(readFileSync(path, "utf8"));
			if (typeof parsed === "string" || now - parsed.writtenAt <= HANDOVER_MAX_AGE_MS) continue;
			// A file under another name than its session's is not a hand-over any restart reads: remove it, and claim nothing.
			if (name !== basename(handoverPath(agentDir, parsed.sessionFile))) {
				rmSync(path, { force: true });
				continue;
			}
			// Stale only: a restart may have written a fresh record since the read above, and that one stays.
			const claimed = claimHandover(agentDir, parsed.sessionFile, now, true);
			if (claimed.kind !== "stale") continue;
			await stopUnclaimed(claimed.record, log);
			ended++;
		} catch (error) {
			log("hand-over sweep failed for one file", error);
		}
	}
	return ended;
}

export function stopAdoptPoll(runtime: Runtime): void {
	if (runtime.adoptTimer) clearInterval(runtime.adoptTimer);
	runtime.adoptTimer = null;
}

/** Check the adopted jobs that still run until each ends, then call `ended` once for it. */
export function watchAdopted(runtime: Runtime, ended: (id: string, ending: Ending) => Promise<void>, log: Log): void {
	stopAdoptPoll(runtime);
	const running = () => [...runtime.jobs.values()].filter((job) => job.adopted === true && job.state !== "done");
	if (running().length === 0) return;
	// A job whose end is being recorded is not looked at again, so its end is recorded once.
	const ending = new Set<string>();
	const timer = setInterval(() => {
		const jobs = running();
		if (runtime.closing || jobs.length === 0) {
			if (runtime.adoptTimer === timer) stopAdoptPoll(runtime);
			return;
		}
		for (const job of jobs) {
			if (ending.has(job.id)) continue;
			let found: Ending | null;
			try {
				found = laterLook(job, Date.now());
			} catch (error) {
				log(`job ${job.id} check failed`, error);
				continue;
			}
			if (found === null) continue;
			ending.add(job.id);
			ended(job.id, found)
				.catch((error: unknown) => log(`job ${job.id} finalize failed`, error))
				.finally(() => ending.delete(job.id));
		}
	}, ADOPTED_POLL_MS);
	timer.unref?.();
	runtime.adoptTimer = timer;
}
