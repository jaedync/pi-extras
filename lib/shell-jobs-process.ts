/**
 * shell-jobs-process: process-group ownership for background shell jobs.
 *
 * Owns the job/runtime record shapes, the process-wide registry that survives
 * Pi `/reload`, signal-based group termination, residual-group tracking, and
 * the `exit` crash net. No Pi API lives here so this layer stays testable and
 * out of the extension's way.
 */
import { randomUUID } from "node:crypto";
import { closeSync, unlinkSync } from "node:fs";
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
}

export interface Deferred {
	readonly promise: Promise<Job>;
	readonly resolve: (job: Job) => void;
}

export interface Delivery {
	flush(): Promise<void>;
}

export interface Runtime {
	readonly runtimeId: string;
	readonly jobs: Map<string, Job>;
	readonly finals: Map<string, Deferred>;
	readonly pendingPids: Set<number>;
	readonly residualPids: Set<number>;
	abandoned: number;
	residualTimer: ReturnType<typeof setInterval> | null;
	logDir: string | null;
	counter: number;
	epoch: number;
	pending: number;
	closing: boolean;
	readonly outbox: Set<string>;
	delivery: Delivery | null;
	widget: JobsWidget;
}

interface GlobalRegistry {
	readonly runtimes: Set<Runtime>;
	exitNetInstalled: boolean;
	reloads: WeakMap<object, Runtime>;
}

export const EXIT_KILL_DELAY_MS = 25;
export const KILL_POLL_MS = 400;
export const RESIDUAL_RECHECK_MS = 2000;
export const RESIDUAL_DEADLINE_MS = 30000;

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
	return found;
}

export function createRuntime(widget: JobsWidget): Runtime {
	const runtime: Runtime = {
		runtimeId: randomUUID().replace(/-/g, "").slice(0, 12),
		jobs: new Map(), finals: new Map(), pendingPids: new Set(), residualPids: new Set(),
		outbox: new Set(), delivery: null, abandoned: 0, residualTimer: null,
		logDir: null, counter: 0, epoch: 0, pending: 0, closing: false, widget,
	};
	registry().runtimes.add(runtime);
	installExitNet();
	return runtime;
}

/** The raw SessionManager is stable across reload, even for in-memory sessions.
 * Use it only as an identity token, never as an old context to call into.
 */
export function takeReload(session: object): Runtime | undefined {
	const runtime = registry().reloads.get(session);
	registry().reloads.delete(session);
	return runtime && !runtime.closing && registry().runtimes.has(runtime) ? runtime : undefined;
}

export function parkForReload(session: object, runtime: Runtime): void {
	runtime.delivery = null;
	runtime.widget.detach();
	registry().reloads.set(session, runtime);
}

/** `exit 0`, `signal SIGKILL`, or the live state while a job has no outcome yet. */
export function jobStatusText(job: Job): string {
	if (job.code !== null) return `exit ${job.code}`;
	if (job.signal !== null) return `signal ${job.signal}`;
	return job.state;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function killQuietly(pgid: number): void {
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
		if (!groupExists(pgid)) return true;
	}
	return !groupExists(pgid);
}

/** TERM the group, wait up to the grace period for it to drain, then KILL. */
export async function stopGroup(pgid: number, graceMs = TERM_GRACE_MS): Promise<CleanupOutcome> {
	const term = signalGroup(pgid, "SIGTERM");
	if (term === "gone") return { cleaned: true, denied: false };
	const denied = term === "denied";
	if (await waitForGroupGone(pgid, graceMs)) return { cleaned: true, denied };
	const killed = signalGroup(pgid, "SIGKILL");
	if (killed === "gone") return { cleaned: true, denied };
	// Confirm death instead of assuming it: a killed group takes a moment to
	// disappear, and claiming success early both warns falsely and drops
	// ownership of a group that may still be alive.
	if (await waitForGroupGone(pgid, KILL_POLL_MS)) return { cleaned: true, denied };
	return { cleaned: false, denied: denied || killed === "denied" };
}

/** Record whether this runtime still owns an unconfirmed group for the exit net. */
export function recordResidual(runtime: Runtime, pgid: number, cleaned: boolean): void {
	if (cleaned) runtime.residualPids.delete(pgid);
	else runtime.residualPids.add(pgid);
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
				if (job.state !== "done") killQuietly(job.pid);
			}
			for (const pid of runtime.pendingPids) killQuietly(pid);
			for (const pid of runtime.residualPids) killQuietly(pid);
		}
	});
}

/**
 * Recheck groups that outlived cleanup so their runtime can be released. A
 * SIGKILLed group is essentially always gone within a moment; after the
 * deadline the PGID claim is dropped rather than signaling a number the OS may
 * have since reused for an unrelated process.
 */
export function scheduleResidualReaper(runtime: Runtime): void {
	if (runtime.residualTimer !== null) return;
	const deadline = Date.now() + RESIDUAL_DEADLINE_MS;
	const timer = setInterval(() => {
		const expired = Date.now() >= deadline;
		for (const pgid of [...runtime.residualPids]) {
			if (expired || !groupExists(pgid)) runtime.residualPids.delete(pgid);
		}
		if (runtime.residualPids.size > 0) return;
		if (runtime.residualTimer !== null) clearInterval(runtime.residualTimer);
		runtime.residualTimer = null;
		registry().runtimes.delete(runtime);
	}, RESIDUAL_RECHECK_MS);
	timer.unref?.();
	runtime.residualTimer = timer;
}
