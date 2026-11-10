/**
 * A process-wide record of slow synchronous operations on Pi's main thread
 * (an fsync, a large file read), so the stall log can name what ran during a
 * stall (extensions/loop-stall.ts). The record lives in a Symbol.for slot:
 * a copy that /reload loads and the modules of child sessions share it.
 * Labels name the kind of operation, never a path or any content.
 */
import { performance } from "node:perf_hooks";

export interface SyncOp {
	readonly label: string;
	/** performance.now() at the start. */
	readonly startedAt: number;
	readonly ms: number;
}

const SLOT = Symbol.for("pi-extras.sync-ops.v1");
/** Enough for the operations of one stall; older ones are of no use to it. */
const KEEP = 32;
/** Shorter operations can't explain a stall worth a log line. */
export const SLOW_SYNC_MS = 50;

type Slot = { [SLOT]?: SyncOp[] };

function ring(): SyncOp[] {
	const slot = globalThis as Slot;
	slot[SLOT] ??= [];
	return slot[SLOT];
}

export function noteSyncOp(op: SyncOp): void {
	const ops = ring();
	ops.push(op);
	// In place: the slot is shared across module copies, so it must stay the same array.
	if (ops.length > KEEP) ops.splice(0, ops.length - KEEP);
}

/** Runs `fn` and records it when it takes `SLOW_SYNC_MS` or more; the result and any error pass through. */
export function timedSync<T>(label: string, fn: () => T, now: () => number = () => performance.now()): T {
	const startedAt = now();
	try { return fn(); }
	finally {
		const ms = now() - startedAt;
		if (ms >= SLOW_SYNC_MS) noteSyncOp({ label, startedAt, ms });
	}
}

/** The recorded operations that overlap the window [from, to], in performance.now() time. */
export function syncOpsBetween(from: number, to: number): SyncOp[] {
	return ring().filter((op) => op.startedAt + op.ms >= from && op.startedAt <= to);
}

/** For tests: forget every recorded operation. */
export function clearSyncOps(): void {
	ring().length = 0;
}
