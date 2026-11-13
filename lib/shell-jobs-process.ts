/**
 * shell-jobs-process: process-group ownership for background shell jobs.
 *
 * Owns the job/runtime record shapes, the process-wide registry that survives
 * Pi `/reload`, signal-based group termination, residual-group tracking, and
 * the `exit` crash net. No Pi API lives here so this layer stays testable and
 * out of the extension's way.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { killScopeNow, reapScope, scopeMembers, scopeSlice, signal as signalPid } from "./process-tree.ts";
import { mayStop } from "./shell-jobs-adopt.ts";
import { TERM_GRACE_MS } from "./shell-jobs-core.ts";
import type { JobsWidget } from "./shell-jobs-widget.ts";

export type JobState = "running" | "stopping" | "done";

export interface Job {
	readonly id: string;
	readonly pid: number;
	readonly command: string;
	/** Model-supplied label shown ahead of the command; null when it gave none. */
	readonly title: string | null;
	/** The tool call that started it, so its transcript row can find it again. */
	readonly toolCallId: string | null;
	readonly cwd: string;
	readonly logPath: string;
	readonly startedAt: number;
	readonly epoch: number;
	readonly state: JobState;
	readonly code: number | null;
	readonly signal: string | null;
	readonly endedAt: number | null;
	readonly claimed: boolean;
	readonly attempts: number;
	readonly delivered: boolean;
	readonly deliveryFailed: boolean;
	readonly cleanupError: string | null;
	readonly runtimeId: string;
	/**
	 * Processes still in the group when the shell exited, which the exit cleanup
	 * stopped: a count, null when there were some but the count is unknown, and
	 * absent or 0 when there were none (a job parked by an older version has no field).
	 */
	readonly stoppedBackground?: number | null;
	/** The job's process start time, read when it started, to tell it from a later process with the same pid. */
	readonly pidStart?: string | null;
	/** Where the exit-code wrapper writes the code; absent for a job an older version started. */
	readonly exitPath?: string | null;
	/** Taken over from the Pi process before a restart: not a child of this process. */
	readonly adopted?: boolean;
	/** Adopted with no start time to check, so it is never signalled. */
	readonly unverified?: boolean;
	/** It ended while no Pi watched it and left no exit code. */
	readonly codeUnknown?: boolean;
}

export interface Deferred {
	readonly promise: Promise<Job>;
	readonly resolve: (job: Job) => void;
}

/**
 * Where Pi holds a sent completion that is not in the session yet.
 * - steered: in the queue of a running agent loop, or the first message of a run.
 * - pending: sent while no agent loop ran. Pi starts a run for it (now, or
 *   after agent_settled handlers end), or a running session takes it later.
 */
export type HeldCompletion = "steered" | "pending";

export interface Delivery {
	flush(): Promise<void>;
}

export interface Runtime {
	readonly runtimeId: string;
	readonly jobs: Map<string, Job>;
	readonly finals: Map<string, Deferred>;
	readonly pendingPids: Set<number>;
	/** A pgid that cleanup could not confirm gone, and the time its claim started. */
	readonly residualClaims: Map<number, number>;
	abandoned: number;
	residualTimer: ReturnType<typeof setInterval> | null;
	logDir: string | null;
	counter: number;
	epoch: number;
	pending: number;
	closing: boolean;
	/** Set when cleanup has ended, so the reaper may take the runtime out of the exit net. */
	released?: boolean;
	readonly outbox: Set<string>;
	/** Completions sent to Pi that are not in the session yet. Absent on a runtime an older version parked. */
	held?: Map<string, HeldCompletion>;
	delivery: Delivery | null;
	widget: JobsWidget;
	/** Set while parked for a reload; absent on a runtime an older version parked. */
	reloadTimer?: ReturnType<typeof setTimeout> | null;
	/** Checks adopted jobs for their end; set while any runs. */
	adoptTimer?: ReturnType<typeof setInterval> | null;
}

interface GlobalRegistry {
	readonly runtimes: Set<Runtime>;
	exitNetInstalled: boolean;
	reloads: WeakMap<object, Runtime>;
	/**
	 * The systemd scope of each job's process group, by pgid, while the job
	 * owns it. A scope holds every process of the job, also one that left the
	 * group by setsid. Absent on a registry that an older version made.
	 */
	scopes?: Map<number, string>;
}

export const EXIT_KILL_DELAY_MS = 25;
export const KILL_POLL_MS = 400;
export const RESIDUAL_RECHECK_MS = 2000;
export const RESIDUAL_DEADLINE_MS = 30000;
/** A reload that has not claimed its parked runtime by now did not load shell-jobs again. */
export const RELOAD_CLAIM_MS = 60_000;

const REGISTRY_KEY = Symbol.for("pi.shell-jobs.registry");

/**
 * The registry lives on globalThis because Pi re-evaluates the module on
 * /reload with a fresh module scope; a module-level Set would orphan the old
 * runtime and add a second `exit` listener on every reload.
 */
export function registry(): GlobalRegistry {
	const holder = globalThis as unknown as Record<symbol, GlobalRegistry | undefined>;
	let found = holder[REGISTRY_KEY];
	if (!found) {
		found = { runtimes: new Set(), exitNetInstalled: false, reloads: new WeakMap() };
		holder[REGISTRY_KEY] = found;
	}
	// The exit net may have been installed by a pre-handoff version of this module.
	found.reloads ??= new WeakMap();
	found.scopes ??= new Map();
	return found;
}

/** `runtimeId` is given when the runtime takes over a hand-over: its completions keep the id that history already holds. */
export function createRuntime(widget: JobsWidget, runtimeId = randomUUID().replace(/-/g, "").slice(0, 12)): Runtime {
	const runtime: Runtime = {
		runtimeId,
		jobs: new Map(), finals: new Map(), pendingPids: new Set(), residualClaims: new Map(),
		outbox: new Set(), delivery: null, abandoned: 0, residualTimer: null,
		logDir: null, counter: 0, epoch: 0, pending: 0, closing: false, widget,
		released: false,
	};
	defineLegacyAlias(runtime);
	registry().runtimes.add(runtime);
	installExitNet();
	return runtime;
}

/** A runtime as v0.39.0 and older made it: claims were a Set of pgids, and `released` did not exist. */
type LegacyRuntime = Omit<Runtime, "residualClaims"> & { residualClaims?: Map<number, number>; residualPids?: Set<number> };

/**
 * Give a runtime the `residualPids` view that a v0.39.0 or older exit listener reads.
 * That listener stays installed for the life of the process after an update and /reload,
 * so without the view it throws on Pi's exit and skips the remaining groups.
 * It is not enumerable, so copies and logs of the runtime do not carry it.
 */
function defineLegacyAlias(runtime: Runtime): void {
	Object.defineProperty(runtime, "residualPids", {
		configurable: true,
		enumerable: false,
		get: () => new Set(runtime.residualClaims.keys()),
	});
}

/**
 * Bring a runtime that an older version of this module parked to the current shape.
 * A /reload after an update hands the new code the old object, and it must not
 * read fields that the old code never set.
 */
export function upgradeRuntime(runtime: Runtime): Runtime {
	const legacy = runtime as unknown as LegacyRuntime;
	if (!(legacy.residualClaims instanceof Map)) {
		// The old claims had no start time; a claim starts now, so it gets a full deadline.
		const now = Date.now();
		legacy.residualClaims = new Map([...(legacy.residualPids ?? [])].map((pgid) => [pgid, now]));
		// The old reaper's closure prunes residualPids, not the claims: only the new reaper may run.
		if (runtime.residualTimer != null) clearInterval(runtime.residualTimer);
		runtime.residualTimer = null;
		defineLegacyAlias(runtime);
		if (runtime.residualClaims.size > 0) scheduleResidualReaper(runtime);
	}
	runtime.released ??= false;
	return runtime;
}

/** Claimed pgids of a runtime of any version, for the exit net. */
function claimedPgids(runtime: Runtime): Iterable<number> {
	const legacy = runtime as unknown as LegacyRuntime;
	return legacy.residualClaims?.keys() ?? legacy.residualPids ?? [];
}

/** The raw SessionManager is stable across reload, even for in-memory sessions.
 * Use it only as an identity token, never as an old context to call into.
 */
export function takeReload(session: object): Runtime | undefined {
	const runtime = registry().reloads.get(session);
	registry().reloads.delete(session);
	if (runtime?.reloadTimer) clearTimeout(runtime.reloadTimer);
	if (runtime) runtime.reloadTimer = null;
	return runtime && !runtime.closing && registry().runtimes.has(runtime) ? upgradeRuntime(runtime) : undefined;
}

/**
 * Hold a runtime for the next load of this extension. When the reload does not
 * load shell-jobs again, nothing claims it, so after `claimMs` it goes to
 * `abandon` (the old load's shutdown) rather than running until Pi exits.
 */
export function parkForReload(session: object, runtime: Runtime, abandon: () => void, claimMs = RELOAD_CLAIM_MS): void {
	runtime.delivery = null;
	runtime.widget.detach();
	registry().reloads.set(session, runtime);
	if (runtime.reloadTimer) clearTimeout(runtime.reloadTimer);
	const timer = setTimeout(() => {
		runtime.reloadTimer = null;
		if (registry().reloads.get(session) !== runtime) return;
		registry().reloads.delete(session);
		abandon();
	}, claimMs);
	// Pi's exit is not held up: the exit net kills the groups then.
	timer.unref?.();
	runtime.reloadTimer = timer;
}

/** `exit 0`, `signal SIGKILL`, or the live state while a job has no outcome yet. */
export function jobStatusText(job: Job): string {
	if (job.code !== null) return `exit ${job.code}`;
	if (job.signal !== null) return `signal ${job.signal}`;
	if (job.codeUnknown === true && job.state === "done") return "exit code unknown";
	return job.state;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The unit names that shell-jobs gives its scopes (lib/process-tree.ts unitName). */
const JOB_SCOPE = /^pi-job-\d+-[0-9a-f]+\.scope$/;

function scopes(): Map<number, string> {
	return registry().scopes ??= new Map();
}

/** Record the scope that holds a job's process group. */
export function rememberScope(pgid: number, dir: string): void {
	scopes().set(pgid, dir);
}

/** Drop the record of a job's scope: its spawn failed, or the job no longer owns its group. */
export function forgetScope(pgid: number): void {
	registry().scopes?.delete(pgid);
}

/** Whether a folder is a shell-jobs scope of this user's slice: the only kind a hand-over may name. */
export function isJobScope(dir: string): boolean {
	const slice = scopeSlice();
	return slice !== null && JOB_SCOPE.test(basename(dir)) && dir === join(slice, basename(dir));
}

/**
 * The scope of a job's group: the one recorded at its start, or given by the
 * hand-over that adopted it. Never one read from /proc: a pid that is not
 * verified may now be another job's process.
 */
export function scopeOf(pgid: number): string | undefined {
	return scopes().get(pgid);
}

/** Whether any process of the job is left: in its group, or in its scope. */
export function treeAlive(pgid: number): boolean {
	if (groupExists(pgid)) return true;
	const scope = scopes().get(pgid);
	return scope !== undefined && scopeMembers(scope).length > 0;
}

function killQuietly(pgid: number): void {
	const scope = registry().scopes?.get(pgid);
	if (scope !== undefined) { killScopeNow(scope); reapScope(scope, true); }
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {
		// Already gone, or unsignalable; there is nothing safer to do on exit.
	}
}

export function groupExists(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

type SignalOutcome = "sent" | "gone" | "denied";
export type CleanupOutcome = { cleaned: boolean; denied: boolean };

function signalGroup(pgid: number, signal: NodeJS.Signals): SignalOutcome {
	try {
		process.kill(-pgid, signal);
		return "sent";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "gone";
		if (code === "EPERM") return "denied";
		throw error;
	}
}

/** Poll until the group disappears or the budget runs out. */
async function waitForGroupGone(pgid: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		await sleep(EXIT_KILL_DELAY_MS);
		if (!treeAlive(pgid)) return true;
	}
	return !treeAlive(pgid);
}

/** How many processes a group still has, or null when `pgrep` cannot tell. */
export function groupSize(pgid: number): Promise<number | null> {
	// A scope holds the group and every process that left it.
	const scope = scopes().get(pgid);
	if (scope !== undefined) return Promise.resolve(scopeMembers(scope).length);
	return new Promise((resolve) => {
		execFile("pgrep", ["-g", String(pgid)], { timeout: 2000 }, (error, stdout, stderr) => {
			// pgrep exits 1, silent, when nothing matches. Anything else is a failure to look,
			// such as BusyBox, which has no -g and exits 1 with its usage text.
			if (error && ((error as { code?: unknown }).code !== 1 || stderr.trim().length > 0)) resolve(null);
			else resolve(stdout.split("\n").filter((line) => line.trim().length > 0).length);
		});
	});
}

/** TERM the group, wait up to the grace period for it to drain, then KILL. */
export async function stopGroup(pgid: number, graceMs = TERM_GRACE_MS): Promise<CleanupOutcome> {
	const scope = scopeOf(pgid);
	const outcome = await stopTree(pgid, scope, graceMs);
	if (scope !== undefined) reapScope(scope);
	if (outcome.cleaned && scope !== undefined) scopes().delete(pgid);
	return outcome;
}

/** Signal every process of a job's scope; the group gets its own signal. */
function signalScope(scope: string | undefined, signal: NodeJS.Signals): void {
	if (scope === undefined) return;
	for (const pid of scopeMembers(scope)) signalPid(pid, signal);
}

async function stopTree(pgid: number, scope: string | undefined, graceMs: number): Promise<CleanupOutcome> {
	const term = signalGroup(pgid, "SIGTERM");
	signalScope(scope, "SIGTERM");
	if (!treeAlive(pgid)) return { cleaned: true, denied: false };
	const denied = term === "denied";
	if (await waitForGroupGone(pgid, graceMs)) return { cleaned: true, denied };
	const killed = signalGroup(pgid, "SIGKILL");
	if (scope !== undefined) killScopeNow(scope);
	if (!treeAlive(pgid)) return { cleaned: true, denied };
	// Confirm death instead of assuming it: a killed group takes a moment to
	// disappear, and claiming success early both warns falsely and drops
	// ownership of a group that may still be alive.
	if (await waitForGroupGone(pgid, KILL_POLL_MS)) return { cleaned: true, denied };
	return { cleaned: false, denied: denied || killed === "denied" };
}

/** Record whether this runtime still owns an unconfirmed group for the exit net. */
export function recordResidual(runtime: Runtime, pgid: number, cleaned: boolean): void {
	if (cleaned) {
		runtime.residualClaims.delete(pgid);
		// No claim is left to recheck.
		if (runtime.residualClaims.size === 0) stopResidualReaper(runtime);
		return;
	}
	// Keep the first claim time: a repeated claim must not move the deadline.
	if (!runtime.residualClaims.has(pgid)) runtime.residualClaims.set(pgid, Date.now());
	// Recheck during the session too. The exit net kills every claimed pgid, and the
	// OS can give a number that no group uses to an unrelated group later.
	scheduleResidualReaper(runtime);
}

/** Drop the recheck timer. The claims stay, for a shutdown to recheck or the exit net to kill. */
function stopResidualReaper(runtime: Runtime): void {
	if (runtime.residualTimer !== null) clearInterval(runtime.residualTimer);
	runtime.residualTimer = null;
}

/** Close a descriptor and drop a log file that no job ended up owning. */
export function discardLog(logPath: string, fd: number | null): void {
	if (fd !== null) {
		try {
			closeSync(fd);
		} catch {
			// The descriptor may already be closed on this path.
		}
	}
	try {
		unlinkSync(logPath);
	} catch {
		// The file may already be gone; this is best effort.
	}
}

export function installExitNet(): void {
	const reg = registry();
	if (reg.exitNetInstalled) return;
	reg.exitNetInstalled = true;
	process.on("exit", () => {
		for (const runtime of reg.runtimes) {
			for (const job of runtime.jobs.values()) {
				if (job.state !== "done" && mayStop(job)) killQuietly(job.pid);
			}
			for (const pid of runtime.pendingPids) killQuietly(pid);
			for (const pid of claimedPgids(runtime)) killQuietly(pid);
		}
	});
}

/**
 * Recheck groups that outlived cleanup, and release the runtime once cleanup
 * has ended and no claim is left. A SIGKILLed group is essentially always gone
 * within a moment; each claim gets its own deadline, and after it the PGID claim
 * is dropped rather than signaling a number the OS may have since reused for an
 * unrelated process. The timings are parameters so a test does not wait 30 s.
 */
export function scheduleResidualReaper(
	runtime: Runtime,
	deadlineMs = RESIDUAL_DEADLINE_MS,
	recheckMs = RESIDUAL_RECHECK_MS,
): void {
	if (runtime.residualTimer !== null) return;
	const timer = setInterval(() => {
		const now = Date.now();
		for (const [pgid, claimedAt] of [...runtime.residualClaims]) {
			// Each claim gets its own wait: a group first rechecked late must not lose its claim early.
			if (now - claimedAt >= deadlineMs || !treeAlive(pgid)) runtime.residualClaims.delete(pgid);
		}
		if (runtime.residualClaims.size > 0) return;
		stopResidualReaper(runtime);
		// Only the end of cleanup releases the runtime. Before that, live jobs still need the exit net.
		if (runtime.released === true) registry().runtimes.delete(runtime);
	}, recheckMs);
	timer.unref?.();
	runtime.residualTimer = timer;
}
