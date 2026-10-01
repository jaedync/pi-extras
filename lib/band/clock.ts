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

export const FRAME_QUANTUM_MS = 40;
export const FRAME_MS = 120;
export const REDUCED_FRAME_MS = 1_000;

export interface Timers {
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(timer: unknown): void;
}

interface Subscriber { readonly fn: () => void; readonly ms: number; readonly elapsed: number }
interface Ticker {
	readonly subscribers: Map<symbol, Subscriber>;
	timer: ReturnType<typeof setInterval> | undefined;
	period?: number;
	failures?: number;
	lastFailure?: string;
}

// On globalThis because each extension loads its own copy of this module; the shape is versioned so an older copy never shares a different one.
const TICKER = Symbol.for("pi-extras.frame-ticker.v5");

function ticker(): Ticker {
	const global = globalThis as Record<symbol, Ticker | undefined>;
	return (global[TICKER] ??= { subscribers: new Map(), timer: undefined });
}

const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
function refreshTicker(shared: Ticker): void {
	const period = shared.subscribers.size ? [...shared.subscribers.values()].map(entry => entry.ms).reduce(gcd) : undefined;
	if (shared.period === period) return;
	if (shared.timer) clearInterval(shared.timer);
	shared.timer = undefined;
	shared.period = period;
	if (period === undefined) return;
	shared.timer = setInterval(() => {
		for (const [id, entry] of [...shared.subscribers]) {
			if (shared.subscribers.get(id) !== entry) continue;
			const elapsed = entry.elapsed + period;
			shared.subscribers.set(id, { ...entry, elapsed: elapsed % entry.ms });
			if (elapsed < entry.ms) continue;
			try { entry.fn(); } catch (error) {
				// Keep the owner's handle alive so transient failures recover. Console output would corrupt Pi's screen.
				shared.failures = Math.min(Number.MAX_SAFE_INTEGER, (shared.failures ?? 0) + 1);
				shared.lastFailure = error instanceof Error ? error.name.replace(/[^\w.-]/g, "").slice(0, 80) : "NonErrorThrow";
			}
		}
	}, period);
	shared.timer.unref?.();
}

/** Aligned consumers share their coarsest common clock, so slower animations never jitter or reset. */
export function everyFrame(fn: () => void, ms = FRAME_MS): () => void {
	const shared = ticker(), id = Symbol("frame");
	shared.subscribers.set(id, { fn, ms: Math.max(FRAME_QUANTUM_MS, Math.ceil((Number.isFinite(ms) ? ms : FRAME_MS) / FRAME_QUANTUM_MS) * FRAME_QUANTUM_MS), elapsed: 0 });
	refreshTicker(shared);
	return () => { shared.subscribers.delete(id); refreshTicker(shared); };
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
