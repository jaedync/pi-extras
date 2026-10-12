/**
 * Keeps a session's subagents through /reload (contract.ts says what may
 * cross from one evaluation of this package to the next). The module serving
 * a session binds its ports to the host (`PortBinding`). On a reload it parks
 * the host on globalThis, keyed by Pi's SessionManager, which a reload keeps
 * even for an in-memory session, and the next module claims it there and
 * binds its own ports. A host nobody claims (the reload failed) closes as a
 * reload closed it before: its children are interrupted and the index saved,
 * so the next start resumes them. An exit while it is parked records the same,
 * as a quit.
 */
import type { HostPorts, HostState, ModelScope, ParkedHost } from "./contract.ts";
import type { AgentRecord, ChildHandle, ChildHooks, Launcher } from "./types.ts";

/** How long a parked host waits for the next module; a reload takes well under a second. */
export const PARK_TIMEOUT_MS = 30_000;
/** How long a start waits for a parked host that closes on its own; past it, the start goes on and may find the lease still held. */
const CLOSE_WAIT_MS = 15_000;
/** Notices kept while parked; any past these are counted, not kept. */
const HELD_NOTICES = 20;

/** Shared by every evaluation of this package in the process; its members never change shape. */
export interface Registry {
	generation: number;
	parked: WeakMap<object, ParkedHost>;
	/** Parked hosts that closed on their own (timeout, exit), until they have let go of the lease. */
	closing: WeakMap<object, Promise<void>>;
}

const REGISTRY = Symbol.for("pi-extras.subagents.host");

function registry(): Registry {
	const holder = globalThis as unknown as Record<symbol, Partial<Registry> | undefined>;
	const found = holder[REGISTRY] ??= {};
	found.generation ??= 0;
	found.parked ??= new WeakMap();
	found.closing ??= new WeakMap();
	return found as Registry;
}

/** A number for this evaluation of the package, larger than any before it in this process. */
export function nextGeneration(): number {
	return ++registry().generation;
}

/** The host Pi's reload left for `session`, taken off the shelf; undefined when there is none. */
export function takeParked(session: object): ParkedHost | undefined {
	const { parked } = registry();
	const entry = parked.get(session);
	parked.delete(session);
	return entry;
}

/**
 * Settles once the host a reload parked for `session` and nobody claimed has
 * closed, or after a bound: its close aborts children first and releases the
 * lease last, so a start that opened the index sooner would find it owned.
 * False when the bound came first and that host may still hold the lease.
 */
export async function closingHost(session: object, waitMs = CLOSE_WAIT_MS): Promise<boolean> {
	const closing = registry().closing.get(session);
	if (!closing) return true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), waitMs); timer.unref?.(); });
	// Its own failure is logged where it closed; this start only needs it over.
	try { return await Promise.race([closing.then(() => true, () => true), bound]); }
	finally { clearTimeout(timer); }
}

/** Leaves `host` for the module Pi loads next; `log` records what happens to it when no module claims it. */
export function parkHost(session: object, host: HostState, options: { timeoutMs?: number; log(message: string): void }): void {
	const { parked } = registry();
	const timeoutMs = options.timeoutMs ?? PARK_TIMEOUT_MS;
	let settled = false;
	const settle = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		process.off("exit", onExit);
		if (parked.get(session) === entry) parked.delete(session);
	};
	const close = (reason: string): Promise<void> => {
		settle();
		const closing = host.close(reason);
		const { closing: shelf } = registry();
		shelf.set(session, closing);
		const forget = () => { if (shelf.get(session) === closing) shelf.delete(session); };
		closing.then(forget, forget);
		return closing;
	};
	const timer = setTimeout(() => {
		options.log(`no module took over the subagents within ${timeoutMs / 1000} s of a /reload, so they were interrupted`);
		close("reload").catch((error: unknown) => options.log(`interrupting them failed: ${(error as Error).message}`));
	}, timeoutMs);
	timer.unref?.();
	// Only what runs at once happens on exit: the host interrupts its children and saves the index first.
	const onExit = () => { void close("quit"); };
	process.once("exit", onExit);
	const entry: ParkedHost = {
		version: host.version,
		claim: () => { settle(); return host; },
		close,
	};
	parked.set(session, entry);
}

/**
 * The ports a host uses: the serving module's, or, while Pi reloads, ones that
 * hold mail, queue notices and keep launches waiting for the next module's
 * launcher, so a child started in that gap runs the new code.
 */
export class PortBinding {
	readonly ports: HostPorts;
	private bound: HostPorts | undefined;
	private scope: ModelScope;
	private notices: Array<{ message: string; level: "info" | "warning" }> = [];
	private dropped = 0;
	private sends: Array<Parameters<HostPorts["send"]>> = [];
	private waiting: Array<{ resolve(launcher: Launcher): void; reject(error: Error): void }> = [];
	/** Where notices go that no module will see: those of a host that closes while parked. */
	private log: ((message: string) => void) | undefined;
	private closing = false;
	private closed = false;

	constructor(ports: HostPorts) {
		this.bound = ports;
		this.scope = ports.models();
		this.ports = {
			send: (message, options) => {
				if (this.closing || this.closed) return;
				if (this.bound) this.bound.send(message, options);
				else this.sends.push([message, options]);
			},
			// A closing host hands its mail over itself (host-state.ts), so none goes out on its own.
			route: () => this.closing || !this.bound ? "hold" : this.bound.route(),
			notify: (message, level) => this.notify(message, level),
			teamChanged: () => this.bound?.teamChanged(),
			mailChanged: () => this.bound?.mailChanged(),
			launcher: {
				launch: (record, hooks) => this.launch(record, hooks),
				// While parked nothing is current: the next module's launcher makes the next session.
				current: (handle) => this.bound ? this.bound.launcher.current?.(handle) ?? true : false,
			},
			models: () => this.bound ? (this.scope = this.bound.models()) : this.scope,
		};
	}

	bind(ports: HostPorts): void {
		if (this.closing || this.closed) throw new Error("This session's subagents are closed.");
		this.bound = ports;
		this.scope = ports.models();
		for (const [message, options] of this.sends.splice(0)) {
			try { ports.send(message, options); }
			catch (error) { ports.notify(`subagents: could not send main a message held during /reload: ${(error as Error).message}`, "warning"); }
		}
		for (const { message, level } of this.notices.splice(0)) ports.notify(message, level);
		if (this.dropped > 0) ports.notify(`subagents: ${this.dropped} more notices came during /reload and were dropped.`, "warning");
		this.dropped = 0;
		for (const waiter of this.waiting.splice(0)) waiter.resolve(ports.launcher);
	}

	park(log?: (message: string) => void): void {
		this.bound = undefined;
		this.log = log;
	}

	/**
	 * The host begins to close: mail and launches stop, and notices still go
	 * to the module bound now, else to the park log, until `close`. Notices
	 * kept for a module that will not come go to that log now. Returns the
	 * ports bound now, which the closing host hands its mail to.
	 */
	beginClose(): HostPorts | undefined {
		this.closing = true;
		this.sends = [];
		for (const waiter of this.waiting.splice(0)) waiter.reject(new Error("The session is shutting down."));
		for (const { message } of this.notices.splice(0)) this.log?.(message);
		if (this.dropped > 0) this.log?.(`${this.dropped} more notices came while the subagents were parked.`);
		this.dropped = 0;
		return this.bound;
	}

	/** Nothing reaches a module after this: a late notice from a host that is gone would use a `ctx` Pi has replaced. */
	close(): void {
		this.beginClose();
		this.closed = true;
		this.bound = undefined;
	}

	private notify(message: string, level: "info" | "warning"): void {
		if (this.closed) return void this.log?.(message);
		if (this.bound) return this.bound.notify(message, level);
		if (this.closing) return void this.log?.(message);
		if (this.notices.length < HELD_NOTICES) this.notices.push({ message, level });
		else this.dropped++;
	}

	private async launch(record: AgentRecord, hooks: ChildHooks): Promise<ChildHandle> {
		if (this.closing || this.closed) throw new Error("The session is shutting down.");
		const launcher = this.bound?.launcher ?? await new Promise<Launcher>((resolve, reject) => { this.waiting.push({ resolve, reject }); });
		return launcher.launch(record, hooks);
	}
}
