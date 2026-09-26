/**
 * One timer for every animated row. A running band re-renders about ten times
 * a second; a finished one keeps ticking only until its flash settles. With
 * reduced motion the rate drops to once a second, enough to keep times moving.
 *
 * Every animation in pi-extras (bands, the phase spinner, the jobs widget,
 * popups) ticks off one shared frame timer. Pi redraws the whole screen for
 * each render request that isn't merged with another, so timers of the same
 * rate running out of step would each cost a full redraw.
 */

export const FRAME_MS = 100;
export const REDUCED_FRAME_MS = 1_000;

export interface Timers {
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(timer: unknown): void;
}

interface Ticker {
	readonly subscribers: Set<{ readonly fn: () => void; readonly every: number; count: number }>;
	timer: ReturnType<typeof setInterval> | undefined;
}

// On globalThis because each extension loads its own copy of this module; the shape is versioned so an older copy never shares a different one.
const TICKER = Symbol.for("pi-extras.frame-ticker.v1");

function ticker(): Ticker {
	const global = globalThis as Record<symbol, Ticker | undefined>;
	return (global[TICKER] ??= { subscribers: new Set(), timer: undefined });
}

/**
 * Calls `fn` every `ms` (rounded to whole frames) on the shared frame timer,
 * until the returned function is called. Callers in the same frame run in the
 * same turn of the event loop, so Pi draws them in one render.
 */
export function everyFrame(fn: () => void, ms = FRAME_MS): () => void {
	const shared = ticker();
	const entry = { fn, every: Math.max(1, Math.round(ms / FRAME_MS)), count: 0 };
	shared.subscribers.add(entry);
	if (!shared.timer) {
		shared.timer = setInterval(() => {
			for (const subscriber of [...shared.subscribers]) {
				subscriber.count++;
				if (subscriber.count < subscriber.every) continue;
				subscriber.count = 0;
				try {
					subscriber.fn();
				} catch {
					// One animation that fails to redraw must not stop the others.
				}
			}
		}, FRAME_MS);
		// Animation alone must never keep the process alive.
		shared.timer.unref?.();
	}
	return () => {
		shared.subscribers.delete(entry);
		if (shared.subscribers.size > 0 || !shared.timer) return;
		clearInterval(shared.timer);
		shared.timer = undefined;
	};
}

const systemTimers: Timers = {
	setInterval: (fn, ms) => everyFrame(fn, ms),
	clearInterval: (stop) => (stop as () => void)(),
};

export class AnimationClock {
	private readonly timers: Timers;
	private readonly subscribers = new Set<() => void>();
	private timer: unknown;
	private reduced = false;

	constructor(timers: Timers = systemTimers) {
		this.timers = timers;
	}

	/** Calls `tick` on every frame until the returned function is called. */
	add(tick: () => void): () => void {
		const entry = () => tick();
		this.subscribers.add(entry);
		this.ensure();
		return () => {
			this.subscribers.delete(entry);
			if (this.subscribers.size === 0) this.halt();
		};
	}

	setReduced(reduced: boolean): void {
		if (this.reduced === reduced) return;
		this.reduced = reduced;
		if (this.timer !== undefined) {
			this.halt();
			this.ensure();
		}
	}

	get size(): number {
		return this.subscribers.size;
	}

	stop(): void {
		this.subscribers.clear();
		this.halt();
	}

	private ensure(): void {
		if (this.timer !== undefined || this.subscribers.size === 0) return;
		this.timer = this.timers.setInterval(() => {
			for (const tick of [...this.subscribers]) {
				try {
					tick();
				} catch {
					// A row that fails to redraw must not stop the others.
				}
			}
		}, this.reduced ? REDUCED_FRAME_MS : FRAME_MS);
	}

	private halt(): void {
		if (this.timer === undefined) return;
		this.timers.clearInterval(this.timer);
		this.timer = undefined;
	}
}
