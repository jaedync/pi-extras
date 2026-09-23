import { delay } from './async.js';
import { KagiError } from './errors.js';

export interface PacerOptions {
  /** Searches allowed in flight at once. */
  concurrency: number;
  /** Minimum gap between request starts, so a batch does not reach Kagi in one instant. */
  spacingMs: number;
  /** Request starts allowed per window, so a looping agent cannot hammer the account. */
  pagesPerWindow: number;
  windowMs: number;
}

/** Time source and sleep, injectable so pacing can be tested without wall-clock jitter. */
export interface PacerClock {
  now: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Bounds how many searches run at once and how fast their requests start. */
export class RequestPacer {
  private active = 0;
  private waiters: Array<() => void> = [];
  private starts: number[] = [];
  private nextStart = 0;
  private readonly options: PacerOptions;
  private readonly clock: PacerClock;

  constructor(options: PacerOptions, clock: PacerClock = { now: Date.now, wait: delay }) {
    this.options = options;
    this.clock = clock;
  }

  /** Waits for a search slot; the returned function frees it exactly once. */
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new KagiError('cancelled');
    if (this.active < this.options.concurrency) this.active++;
    else {
      await new Promise<void>((resolve, reject) => {
        const grant = () => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { this.waiters = this.waiters.filter(waiter => waiter !== grant); reject(new KagiError('cancelled')); };
        this.waiters = [...this.waiters, grant];
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const [next, ...rest] = this.waiters;
      this.waiters = rest;
      // Hand the slot straight to the next waiter so a new arrival cannot take it first.
      if (next) next(); else this.active--;
    };
  }

  /**
   * Reserves the next request start and waits for it. A start that would land after
   * `deadline` is refused up front rather than held until the search times out.
   */
  async start(signal: AbortSignal, deadline: number): Promise<void> {
    const now = this.clock.now();
    const recent = this.starts.filter(at => at > now - this.options.windowMs);
    const windowFull = recent.length >= this.options.pagesPerWindow;
    const at = Math.max(now, this.nextStart, windowFull ? recent[recent.length - this.options.pagesPerWindow] + this.options.windowMs : 0);
    if (at > deadline) throw new KagiError('pace');
    // Reserved synchronously, so concurrent callers never claim the same start.
    this.starts = [...recent, at];
    this.nextStart = at + this.options.spacingMs;
    await this.clock.wait(at - this.clock.now(), signal);
  }
}
