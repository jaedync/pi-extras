/**
 * Loop Stall. Logs each time Pi's main thread stops for 500 ms or more (the
 * TUI does not answer keys then) to `loop-stall.log` in the agent directory,
 * with what the stall was made of (lib/loop-stall.ts). It changes nothing in
 * how Pi runs.
 *
 * PI_LOOP_STALL=off (or `0`, `false`) disables it. PI_LOOP_STALL_MS sets the
 * threshold in ms (100 or more).
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { appendStallLine, formatStall, isMissing, loopStallWatch, type LoopStallWatch, shortPressure, STALL_MS } from "../lib/loop-stall.ts";
import { errorText, operationalError } from "../lib/operational-log.ts";
import { syncOpsBetween } from "../lib/sync-ops.ts";

const DISABLED = new Set(["0", "off", "false", "none"]);
const MIN_STALL_MS = 100;
/** Enough GC entries to cover one stall window. */
const GC_KEEP = 64;
/** One watcher per process: /reload loads a new copy of this module, which takes over. */
const SLOT = Symbol.for("pi-extras.loop-stall.watch.v1");

type Slot = { [SLOT]?: { stop(): void } };

export function stallThreshold(value: string | undefined): number {
	const parsed = Number(value?.trim());
	return Number.isFinite(parsed) && parsed >= MIN_STALL_MS ? parsed : STALL_MS;
}

function threadCpuMicros(): number | undefined {
	const read = (process as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage;
	if (typeof read !== "function") return undefined;
	const { user, system } = read.call(process);
	return user + system;
}

function ioPressure(): string | undefined {
	try { return shortPressure(readFileSync("/proc/pressure/io", "utf8")); }
	catch (error) {
		// No PSI on this system (not Linux, or a kernel without it); other errors reach onError.
		if (isMissing(error)) return undefined;
		throw error;
	}
}

interface Pause { start: number; duration: number }

/** GC pauses, from V8's own entries; the observer runs only while the watch does. */
function gcPauses(): { between(from: number, to: number): number; stop(): void } {
	const pauses: Pause[] = [];
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) pauses.push({ start: entry.startTime, duration: entry.duration });
		if (pauses.length > GC_KEEP) pauses.splice(0, pauses.length - GC_KEEP);
	});
	observer.observe({ entryTypes: ["gc"] });
	return {
		between: (from, to) => pauses.filter((p) => p.start + p.duration >= from && p.start <= to).reduce((sum, p) => sum + p.duration, 0),
		stop: () => observer.disconnect(),
	};
}

/** `onLine` hears each line after it is written (for tests). */
export function startLoopStall(logFile: string, stallMs: number, onLine?: (line: string) => void): LoopStallWatch {
	const gc = gcPauses();
	const onError = (error: unknown) => operationalError(logFile, "loop-stall", `record failed: ${errorText(error)}`);
	const watch = loopStallWatch({
		now: () => performance.now(),
		wallNow: () => Date.now(),
		threadCpuMicros,
		gcMsBetween: gc.between,
		syncOpsBetween,
		ioPressure,
		memory: () => process.memoryUsage(),
		timers: {
			// Unref'd: the watch never keeps a finished Pi from exiting.
			setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
			clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
		},
		onStall: (stall) => {
			const line = `[loop-stall] ${formatStall(stall)}`;
			appendStallLine(logFile, line);
			onLine?.(line);
		},
		onError,
		stallMs,
	});
	return { stop() { watch.stop(); gc.stop(); } };
}

export default function loopStallExtension(pi: ExtensionAPI): void {
	if (DISABLED.has(process.env.PI_LOOP_STALL?.trim().toLowerCase() ?? "")) return;
	const logFile = join(getAgentDir(), "loop-stall.log");
	const slot = globalThis as Slot;
	pi.on("session_start", () => {
		slot[SLOT]?.stop();
		slot[SLOT] = startLoopStall(logFile, stallThreshold(process.env.PI_LOOP_STALL_MS));
	});
	pi.on("session_shutdown", () => {
		slot[SLOT]?.stop();
		slot[SLOT] = undefined;
	});
}
