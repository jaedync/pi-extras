/**
 * Frees a Pi process's garbage while it is idle.
 *
 * V8 collects in full only when its heap fills or the program goes quiet, and
 * an idle Pi is never quiet: spinners, the footer and the job widget allocate
 * every second. So a session holds tens to hundreds of megabytes of dead
 * objects between runs. Once the agent has been idle for a while, one
 * last-resort collection frees them and gives the pages back to the system.
 * It runs while nothing waits on it, at most once per gap, and only when the
 * process has grown since the last one.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

/** How long the agent must be idle before a collection. */
export const IDLE_MS = 30_000;
/** The shortest time between two collections. */
export const MIN_GAP_MS = 5 * 60_000;
/** How much the process must grow after a collection before the next is worth its pause. */
export const MIN_GROWTH_BYTES = 16 * 1024 * 1024;

type Gc = (options?: { type?: string; execution?: string; flavor?: string }) => void;

/**
 * A collection that also returns freed pages to the system, or undefined
 * where V8 offers none. Turning `--expose-gc` on only for one new context gets
 * the function without putting `gc` on Pi's global object.
 */
export function lastResortCollector(): (() => void) | undefined {
	const existing = (globalThis as { gc?: unknown }).gc;
	let gc = typeof existing === "function" ? (existing as Gc) : undefined;
	if (!gc) {
		try {
			setFlagsFromString("--expose-gc");
			const found: unknown = runInNewContext("gc");
			if (typeof found === "function") gc = found as Gc;
		} catch {
			return undefined;
		} finally {
			setFlagsFromString("--no-expose-gc");
		}
	}
	const collect = gc;
	if (!collect) return undefined;
	return () => collect({ type: "major", execution: "sync", flavor: "last-resort" });
}

// Each extension gets its own copy of this module, so the count lives on the global object.
const BUSY = Symbol.for("pi-extras.idle-gc.busy.v1");

function busyCount(): { count: number } {
	const shared = globalThis as { [BUSY]?: { count: number } };
	shared[BUSY] ??= { count: 0 };
	return shared[BUSY];
}

/** Marks the process busy, for work that the main session's runs do not show (a subagent's run). Returns the release. */
export function holdBusy(): () => void {
	const busy = busyCount();
	busy.count++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		busy.count--;
	};
}

export function processBusy(): boolean {
	return busyCount().count > 0;
}

export interface IdleGcDeps {
	readonly collect: () => void;
	/** The process's resident size in bytes. */
	readonly rss: () => number;
	readonly now: () => number;
	readonly timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
	readonly onError: (error: unknown) => void;
}

export interface IdleGc {
	/** The agent stopped working: collect once it has stayed idle. */
	idle(): void;
	/** The agent started working: no collection now. */
	busy(): void;
	stop(): void;
}

export function idleGc(deps: IdleGcDeps): IdleGc {
	let timer: unknown;
	let stopped = false;
	let lastAt = Number.NEGATIVE_INFINITY;
	let lastRss = Number.NEGATIVE_INFINITY;

	const cancel = () => {
		if (timer !== undefined) deps.timers.clearTimeout(timer);
		timer = undefined;
	};
	const arm = (ms: number) => {
		cancel();
		timer = deps.timers.setTimeout(fire, ms);
	};
	function fire(): void {
		timer = undefined;
		if (stopped) return;
		// A subagent still streams; look again after another idle wait.
		if (processBusy()) return arm(IDLE_MS);
		if (deps.rss() < lastRss + MIN_GROWTH_BYTES) return;
		try {
			deps.collect();
		} catch (error) {
			stopped = true;
			deps.onError(error);
			return;
		}
		lastAt = deps.now();
		lastRss = deps.rss();
	}

	return {
		idle() {
			if (stopped) return;
			arm(Math.max(IDLE_MS, lastAt + MIN_GAP_MS - deps.now()));
		},
		busy: cancel,
		stop() {
			stopped = true;
			cancel();
		},
	};
}
