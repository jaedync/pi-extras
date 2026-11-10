/**
 * Finds stalls of Pi's main thread and says what they were made of.
 *
 * A timer that should fire every TICK_MS fires late when the thread was busy
 * or blocked; the lateness is the stall. For each stall the record gives the
 * main thread's own CPU time in the window (close to the stall: JavaScript or
 * GC work; close to zero: a blocking system call such as fsync, or no CPU to
 * run on), the GC pause time, the slow synchronous operations that
 * `timedSync` recorded (lib/sync-ops.ts), and the disk I/O pressure.
 */
import { appendFileSync, renameSync, statSync } from "node:fs";
import type { SyncOp } from "./sync-ops.ts";

/** How often the timer should fire. */
export const TICK_MS = 250;
/** The shortest stall worth a log line: below it a user hardly notices a pause. */
export const STALL_MS = 500;
/** GC entries arrive after the stall that held them; wait this long before the record is made. */
export const SETTLE_MS = 50;
/** The log is rotated once it grows past this. */
export const LOG_MAX_BYTES = 1024 * 1024;

export interface Stall {
	/** Wall-clock time the stall was found, ms since the epoch. */
	readonly at: number;
	/** How late the timer fired. */
	readonly lagMs: number;
	/** The window the facts below cover: from the last on-time tick to the late one. */
	readonly windowMs: number;
	/** Main-thread CPU time in the window; undefined where Node can't tell (before 23.9). */
	readonly threadCpuMs: number | undefined;
	readonly gcMs: number;
	readonly syncOps: readonly SyncOp[];
	/** The first lines of /proc/pressure/io, shortened; undefined off Linux. */
	readonly ioPressure: string | undefined;
	readonly heapMb: number;
	readonly rssMb: number;
}

export interface LoopStallDeps {
	/** Monotonic ms (performance.now()). */
	readonly now: () => number;
	readonly wallNow: () => number;
	/** The main thread's CPU time in microseconds, or undefined where unknown. */
	readonly threadCpuMicros: () => number | undefined;
	readonly gcMsBetween: (from: number, to: number) => number;
	readonly syncOpsBetween: (from: number, to: number) => readonly SyncOp[];
	readonly ioPressure: () => string | undefined;
	readonly memory: () => { heapUsed: number; rss: number };
	readonly timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
	readonly onStall: (stall: Stall) => void;
	readonly onError: (error: unknown) => void;
	readonly stallMs?: number;
	readonly tickMs?: number;
}

export interface LoopStallWatch {
	stop(): void;
}

const MB = 1024 * 1024;

export function loopStallWatch(deps: LoopStallDeps): LoopStallWatch {
	const tickMs = deps.tickMs ?? TICK_MS;
	const stallMs = deps.stallMs ?? STALL_MS;
	let stopped = false;
	let timer: unknown;
	let settle: unknown;
	let armedAt = deps.now();
	let armedCpu = deps.threadCpuMicros();

	const arm = () => {
		armedAt = deps.now();
		armedCpu = deps.threadCpuMicros();
		timer = deps.timers.setTimeout(tick, tickMs);
	};

	function tick(): void {
		timer = undefined;
		if (stopped) return;
		const firedAt = deps.now();
		const lagMs = firedAt - armedAt - tickMs;
		if (lagMs >= stallMs) {
			const from = armedAt;
			const cpu = deps.threadCpuMicros();
			const threadCpuMs = cpu !== undefined && armedCpu !== undefined ? (cpu - armedCpu) / 1000 : undefined;
			const at = deps.wallNow();
			settle = deps.timers.setTimeout(() => {
				settle = undefined;
				if (stopped) return;
				try {
					const { heapUsed, rss } = deps.memory();
					deps.onStall({
						at, lagMs, windowMs: firedAt - from, threadCpuMs, gcMs: deps.gcMsBetween(from, firedAt),
						syncOps: deps.syncOpsBetween(from, firedAt), ioPressure: deps.ioPressure(),
						heapMb: heapUsed / MB, rssMb: rss / MB,
					});
				} catch (error) { deps.onError(error); }
			}, SETTLE_MS);
		}
		arm();
	}

	arm();
	return {
		stop() {
			stopped = true;
			if (timer !== undefined) deps.timers.clearTimeout(timer);
			if (settle !== undefined) deps.timers.clearTimeout(settle);
			timer = undefined;
			settle = undefined;
		},
	};
}

const round = (ms: number) => Math.round(ms);

/** One log line; it names kinds of operations and numbers, never paths or content. */
export function formatStall(stall: Stall): string {
	const cpu = stall.threadCpuMs === undefined ? "CPU unknown" : `CPU ${round(stall.threadCpuMs)} ms`;
	const ops = stall.syncOps.length === 0 ? "none recorded"
		: stall.syncOps.map((op) => `${op.label} ${round(op.ms)} ms`).join(", ");
	return [
		`${new Date(stall.at).toISOString()} main thread stalled ${round(stall.lagMs)} ms`,
		`(window ${round(stall.windowMs)} ms: ${cpu}, GC ${round(stall.gcMs)} ms)`,
		`sync ops: ${ops};`,
		`io: ${stall.ioPressure ?? "unknown"};`,
		`heap ${round(stall.heapMb)} MB, rss ${round(stall.rssMb)} MB`,
	].join(" ");
}

/** `some avg10=.. full avg10=..` from the text of /proc/pressure/io. */
export function shortPressure(text: string): string | undefined {
	const parts = text.split("\n").flatMap((line) => {
		const match = /^(some|full) avg10=([\d.]+)/.exec(line);
		return match ? [`${match[1]} avg10=${match[2]}`] : [];
	});
	return parts.length > 0 ? parts.join(" ") : undefined;
}

/** True for an ENOENT error: the file or the kernel feature is not there. */
export function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Appends a line, first moving a log past `maxBytes` to `<file>.1` (one old copy is kept). */
export function appendStallLine(file: string, line: string, maxBytes = LOG_MAX_BYTES): void {
	let size = 0;
	try { size = statSync(file).size; }
	catch (error) { if (!isMissing(error)) throw error; }
	if (size > maxBytes) renameSync(file, `${file}.1`);
	appendFileSync(file, `${line}\n`, { mode: 0o600 });
}
