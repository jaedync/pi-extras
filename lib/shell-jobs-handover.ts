/**
 * shell-jobs-handover: the file that carries a session's background jobs
 * across a Pi restart. The old process writes it at shutdown (atomically,
 * mode 0600, in a 0700 folder under the agent dir), and the next process for
 * the same session claims it once at session start. The file holds commands,
 * so a file that others could read, or that does not parse to exactly the
 * expected shape, is refused and removed. No Pi API lives here.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isJobId } from "./shell-jobs-core.ts";
import { timedSync } from "./sync-ops.ts";

/** A record that waited longer than this for its session is dropped, and its jobs that are still the recorded processes are stopped. */
export const HANDOVER_MAX_AGE_MS = 24 * 60 * 60_000;
export const HANDOVER_VERSION = 1;
/** Job log folders are `mkdtemp(<tmp>/pi-shell-jobs-)`; nothing else is ever adopted, or later removed. */
export const LOG_DIR_PREFIX = "pi-shell-jobs-";

export interface HandoverJob {
	readonly id: string;
	readonly title: string | null;
	readonly command: string;
	readonly cwd: string;
	readonly toolCallId: string | null;
	readonly pid: number;
	/** The process start time when the job started (lib/auto-update/leases.ts processStart); null when the system could not tell. */
	readonly pidStart: string | null;
	readonly logPath: string;
	/** Where the wrapper writes the exit code; null for a job an older version started. */
	readonly exitPath: string | null;
	readonly startedAt: number;
	readonly state: "running" | "done";
	readonly code: number | null;
	readonly signal: string | null;
	readonly endedAt: number | null;
	readonly claimed: boolean;
	readonly attempts: number;
	readonly delivered: boolean;
	readonly deliveryFailed: boolean;
	readonly cleanupError: string | null;
	readonly stoppedBackground: number | null;
	readonly codeUnknown?: boolean;
	/** The job's systemd scope folder (lib/process-tree.ts); absent or null for a job with none, or one an older version wrote. */
	readonly scope?: string | null;
}

export interface Handover {
	readonly version: 1;
	readonly writtenAt: number;
	readonly sessionFile: string;
	readonly sessionId: string | null;
	readonly runtimeId: string;
	readonly logDir: string;
	readonly counter: number;
	readonly abandoned: number;
	readonly jobs: readonly HandoverJob[];
}

export type Claimed =
	| { readonly kind: "none" }
	| { readonly kind: "ok"; readonly record: Handover }
	| { readonly kind: "stale"; readonly record: Handover }
	/** Only from a stale-only claim: the record was fresh and is back in place. */
	| { readonly kind: "fresh" }
	| { readonly kind: "bad"; readonly reason: string };

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const uid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

export function handoverDir(agentDir: string): string {
	return join(agentDir, "shell-jobs", "handover");
}

/** One file per session file; the name is a hash, so no path ends up in a file name. */
export function handoverPath(agentDir: string, sessionFile: string): string {
	return join(handoverDir(agentDir), `${createHash("sha256").update(sessionFile).digest("hex").slice(0, 32)}.json`);
}

/** A folder this user owns, not a link, that only this user can enter. */
function ownFolder(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = lstatSync(dir);
	if (!stat.isDirectory()) throw new Error(`${dir} is not a folder`);
	const me = uid();
	if (me !== undefined && stat.uid !== me) throw new Error(`${dir} belongs to another user`);
	if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** Write the record with one rename, so a reader never sees half of it. Returns the path. */
export function writeHandover(agentDir: string, record: Handover): string {
	const dir = handoverDir(agentDir);
	ownFolder(dir);
	const path = handoverPath(agentDir, record.sessionFile);
	const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		// Synchronous on purpose: the next copy reads it right after a reload.
		timedSync("shell-jobs handover write", () => {
			const fd = openSync(temp, "wx", 0o600);
			try {
				writeFileSync(fd, `${JSON.stringify(record)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		});
		chmodSync(temp, 0o600);
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	return path;
}

/**
 * Take the session's record, once: a rename makes the claim, so two Pi
 * processes that open the same session cannot both adopt its jobs. The file
 * is gone after any outcome but "none".
 */
export function claimHandover(agentDir: string, sessionFile: string, now: number, staleOnly = false): Claimed {
	const path = handoverPath(agentDir, sessionFile);
	const claimed = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.claimed`;
	try {
		renameSync(path, claimed);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "none" };
		return { kind: "bad", reason: `could not claim it: ${(error as Error).message}` };
	}
	try {
		const stat = lstatSync(claimed);
		const me = uid();
		if (!stat.isFile()) return { kind: "bad", reason: "it is not a regular file" };
		if (me !== undefined && stat.uid !== me) return { kind: "bad", reason: "it belongs to another user" };
		if ((stat.mode & 0o077) !== 0) return { kind: "bad", reason: "others can read it" };
		const record = parseHandover(readFileSync(claimed, "utf8"));
		if (typeof record === "string") return { kind: "bad", reason: record };
		if (record.sessionFile !== sessionFile) return { kind: "bad", reason: "it names another session" };
		if (now - record.writtenAt > HANDOVER_MAX_AGE_MS) return { kind: "stale", record };
		if (staleOnly) {
			// A link, not a rename: a newer record written meanwhile is not replaced.
			try { linkSync(claimed, path); } catch { /* a newer record is in place, or the folder is gone */ }
			return { kind: "fresh" };
		}
		return { kind: "ok", record };
	} catch (error) {
		return { kind: "bad", reason: (error as Error).message };
	} finally {
		rmSync(claimed, { force: true });
	}
}

const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isCode = (value: unknown): value is number | null => value === null || (isCount(value) && value <= 255);
const isBool = (value: unknown): value is boolean => typeof value === "boolean";

/** The parsed record, or the reason it was refused. */
export function parseHandover(text: string): Handover | string {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		return `it is not JSON (${(error as Error).message})`;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return "it is not an object";
	if (value.version !== HANDOVER_VERSION) return `version ${String(value.version)} is not ${HANDOVER_VERSION}`;
	const { writtenAt, sessionFile, sessionId, runtimeId, logDir, counter, abandoned, jobs } = value;
	if (!isCount(writtenAt) || !isText(sessionFile) || !isTextOrNull(sessionId) || !isCount(counter) || !isCount(abandoned)) return "a session field is missing or wrong";
	if (!isText(runtimeId) || !/^[A-Za-z0-9]{1,64}$/.test(runtimeId)) return "the runtime id is wrong";
	if (!isText(logDir) || !isAbsolute(logDir) || !basename(logDir).startsWith(LOG_DIR_PREFIX) || logDir.includes("\0")) return "the log folder is not a job log folder";
	if (!Array.isArray(jobs) || jobs.length > 1024) return "the job list is wrong";
	const parsed: HandoverJob[] = [];
	for (const raw of jobs) {
		const job = parseJob(raw, logDir);
		if (typeof job === "string") return job;
		parsed.push(job);
	}
	return { version: 1, writtenAt, sessionFile, sessionId, runtimeId, logDir, counter, abandoned, jobs: parsed };
}

function parseJob(raw: unknown, logDir: string): HandoverJob | string {
	if (!raw || typeof raw !== "object") return "a job is not an object";
	const job = raw as Record<string, unknown>;
	const id = job.id;
	if (!isText(id) || !isJobId(id)) return "a job id is wrong";
	const where = `job ${id}`;
	// pid 1 and below would signal init or every process this user owns.
	if (!isCount(job.pid) || job.pid <= 1) return `${where}: the pid is wrong`;
	if (job.logPath !== join(logDir, `${id}.log`)) return `${where}: the log is outside its folder`;
	if (job.exitPath !== null && job.exitPath !== join(logDir, `${id}.exit`)) return `${where}: the exit file is outside its folder`;
	if (job.state !== "running" && job.state !== "done") return `${where}: the state is wrong`;
	const fields = isTextOrNull(job.title) && isText(job.command) && isText(job.cwd) && isTextOrNull(job.toolCallId) && isTextOrNull(job.pidStart) &&
		isCount(job.startedAt) && isCode(job.code) && isTextOrNull(job.signal) && (job.endedAt === null || isCount(job.endedAt)) &&
		isBool(job.claimed) && isCount(job.attempts) && isBool(job.delivered) && isBool(job.deliveryFailed) && isTextOrNull(job.cleanupError) &&
		(job.stoppedBackground === null || isCount(job.stoppedBackground)) && (job.codeUnknown === undefined || isBool(job.codeUnknown)) &&
		(job.scope === undefined || isTextOrNull(job.scope));
	if (!fields) return `${where}: a field is missing or wrong`;
	return job as unknown as HandoverJob;
}

/** True when `dir` is a job log folder this user owns, so it may be adopted and later removed. */
export function ownLogDir(dir: string): boolean {
	try {
		const stat = lstatSync(dir);
		const me = uid();
		return stat.isDirectory() && (me === undefined || stat.uid === me) && basename(dir).startsWith(LOG_DIR_PREFIX) && isAbsolute(dirname(dir));
	} catch {
		return false;
	}
}

/** The code the wrapper wrote: a number, null when the file holds something else, undefined when there is no file. */
export function readExitCode(exitPath: string): number | null | undefined {
	let text: string;
	try {
		text = readFileSync(exitPath, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		return null;
	}
	const match = /^(\d{1,3})\n?$/.exec(text);
	if (!match) return null;
	const code = Number(match[1]);
	return code <= 255 ? code : null;
}
