/**
 * One timer for every animated row. A running band re-renders about ten times
 * a second; a finished one keeps ticking only until its flash settles. With
 * reduced motion the rate drops to once a second, enough to keep times moving.
 */

export const FRAME_MS = 100;
export const REDUCED_FRAME_MS = 1_000;

export interface Timers {
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(timer: unknown): void;
}

const systemTimers: Timers = {
	setInterval: (fn, ms) => {
		const timer = setInterval(fn, ms);
		// Animation alone must never keep the process alive.
		timer.unref?.();
		return timer;
	},
	clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
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
