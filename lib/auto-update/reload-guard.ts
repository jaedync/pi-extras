/**
 * Keeps a Pi process alive through the update reload. An extension's async
 * step that fails after a reload (for example new code that meets an old
 * module from Node's ESM cache) gives an unhandled rejection, and with no
 * listener Node turns it into an uncaught exception, which ends Pi. For a
 * short window around each update reload this guard listens, logs the error
 * and tells the user. After the window, Node's own handling is back.
 *
 * A synchronous throw from a timer or an event callback is an uncaught
 * exception, which Pi's own handler turns into an exit before any listener
 * here could act. The guard cannot keep Pi alive then; the restart in place of
 * a reload (in-place.ts) is the protection for that case.
 *
 * One guard per process, on globalThis: the reload loads this module again,
 * and the new module must reach the listener that the old one added.
 */

/** From the start of the reload to this long after its end. */
export const RELOAD_GUARD_MS = 120_000;

type Listener = (reason: unknown) => void;
export interface GuardTarget {
	on(event: "unhandledRejection", listener: Listener): unknown;
	off(event: "unhandledRejection", listener: Listener): unknown;
}
export interface GuardClock {
	readonly now: () => number;
	/** A one-shot timer that does not keep the process alive; returns its stop. */
	readonly setOnce: (fn: () => void, ms: number) => () => void;
}

/** "TypeError: message" on one line, for a notice. */
export function errorLine(reason: unknown): string {
	const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
	return text.replace(/\s*[\r\n]+\s*/g, " ");
}

export class ReloadGuard {
	private readonly target: GuardTarget;
	private readonly clock: GuardClock;
	private stopTimer: (() => void) | undefined;
	private log: (line: string) => void = () => {};
	private reporter: ((text: string) => void) | undefined;
	private pending: string[] = [];
	private readonly listener: Listener = (reason) => this.caught(reason);
	/** The last error of the log itself, for a debugger: there is no other place left to write it. */
	lastLogError: unknown;

	constructor(target: GuardTarget, clock: GuardClock) {
		this.target = target;
		this.clock = clock;
	}

	get armed(): boolean {
		return this.stopTimer !== undefined;
	}

	/** Opens the window, or moves its end to `ms` from now. */
	arm(ms: number, log: (line: string) => void): void {
		this.log = log;
		if (this.stopTimer) this.stopTimer();
		else this.target.on("unhandledRejection", this.listener);
		this.stopTimer = this.clock.setOnce(() => this.disarm(), ms);
	}

	disarm(): void {
		if (!this.stopTimer) return;
		this.stopTimer();
		this.stopTimer = undefined;
		this.target.off("unhandledRejection", this.listener);
		// The log has them; a session that starts hours later must not show them as new.
		this.pending = [];
	}

	/** The live session's notice, or undefined while no session can show one. Errors caught meanwhile wait for the next reporter. */
	setReporter(reporter: ((text: string) => void) | undefined): void {
		this.reporter = reporter;
		if (!reporter) return;
		for (const text of this.pending.splice(0)) this.report(text);
	}

	private caught(reason: unknown): void {
		const text = errorLine(reason);
		const stack = reason instanceof Error && reason.stack ? ` | ${reason.stack.split("\n").slice(1, 4).map((line) => line.trim()).join(" | ")}` : "";
		this.safeLog(`unhandled rejection after the update reload: ${text}${stack}`);
		if (this.reporter) this.report(text);
		else this.pending.push(text);
	}

	private report(text: string): void {
		try {
			this.reporter?.(text);
		} catch (error) {
			this.safeLog(`could not tell the user: ${errorLine(error)}`);
		}
	}

	private safeLog(line: string): void {
		try {
			this.log(line);
		} catch (error) {
			// A log that cannot write must not turn the caught error into a new one.
			this.lastLogError = error;
		}
	}
}

/** Versioned: a later pi-extras that keeps another shape here picks a new symbol. */
const SLOT = Symbol.for("pi-extras.auto-update.reload-guard.v1");

export function processReloadGuard(): ReloadGuard {
	const slot = globalThis as { [SLOT]?: ReloadGuard };
	return (slot[SLOT] ??= new ReloadGuard(process, {
		now: Date.now,
		setOnce: (fn, ms) => {
			const handle = setTimeout(fn, ms).unref();
			return () => clearTimeout(handle);
		},
	}));
}
