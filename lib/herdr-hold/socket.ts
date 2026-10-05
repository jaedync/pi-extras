/**
 * Puts the gate on writes to Herdr's API socket. Herdr's Pi integration runs in
 * this process and opens the socket with `net.createConnection`, so wrapping
 * that one function lets the integration load and run unchanged. Connections to
 * any other endpoint are untouched. The wrap lives in a `Symbol.for` slot so a
 * copy loaded by `/reload` reuses it instead of wrapping twice.
 */
import net from "node:net";
import { ackFor, Gate, readReport } from "./gate.ts";

/** How long a gate may stay without an owner (a `/reload` gap) before it lets go. */
export const ORPHAN_MS = 10_000;
// Herdr's integration tries twice with these timeouts; the replay does the same.
const ATTEMPT_TIMEOUTS_MS = [500, 1500] as const;

type CreateConnection = typeof net.createConnection;

interface Slot {
	readonly original: CreateConnection;
	readonly wrapped: CreateConnection;
	readonly endpoint: string;
	readonly gate: Gate;
	owner: object | undefined;
	orphanTimer: ReturnType<typeof setTimeout> | undefined;
}

const KEY = Symbol.for("pi-extras.herdr-hold.v1");
const registry = globalThis as typeof globalThis & { [key: symbol]: Slot | undefined };

export interface HerdrEnv {
	readonly endpoint: string;
	readonly paneId: string;
}

/** Herdr's endpoint and pane, computed the way its integration does, or undefined outside Herdr. */
export function herdrEnv(env: NodeJS.ProcessEnv, platform = process.platform): HerdrEnv | undefined {
	const socketPath = env.HERDR_SOCKET_PATH, paneId = env.HERDR_PANE_ID;
	if (env.HERDR_ENV !== "1" || !socketPath || !paneId) return undefined;
	return { endpoint: platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath, paneId };
}

function targets(args: unknown[], endpoint: string): boolean {
	const first = args[0];
	if (typeof first === "string") return first === endpoint;
	return !!first && typeof first === "object" && (first as { path?: unknown }).path === endpoint;
}

function attempt(original: CreateConnection, endpoint: string, bytes: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let done = false;
		const socket = original(endpoint);
		const finish = (delivered: boolean) => {
			if (done) return;
			done = true; clearTimeout(timer); socket.destroy(); resolve(delivered);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		timer.unref();
		socket.on("error", () => finish(false));
		socket.on("connect", () => socket.write(bytes));
		socket.on("data", () => finish(true));
		socket.on("end", () => finish(false));
	});
}

/** Sends held bytes with Herdr's retry policy; a lost replay leaves the pane working until the next turn. */
async function replay(original: CreateConnection, endpoint: string, bytes: string): Promise<void> {
	for (const timeout of ATTEMPT_TIMEOUTS_MS) if (await attempt(original, endpoint, bytes, timeout)) return;
}

function wrap(slotRef: () => Slot | undefined, original: CreateConnection, endpoint: string): CreateConnection {
	return function (this: unknown, ...args: unknown[]) {
		const socket = (original as (...a: unknown[]) => net.Socket).apply(this, args);
		const slot = slotRef();
		if (!slot || !targets(args, endpoint)) return socket;
		const write = socket.write;
		socket.write = function (this: net.Socket, chunk: unknown, ...rest: unknown[]) {
			if (slot.gate.write(chunk) !== "hold") return (write as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
			const report = readReport(chunk, slot.gate.paneId);
			const callback = rest.find((value) => typeof value === "function") as (() => void) | undefined;
			process.nextTick(() => { callback?.(); if (report && !socket.destroyed) socket.emit("data", Buffer.from(ackFor(report))); });
			return true;
		} as typeof socket.write;
		return socket;
	} as CreateConnection;
}

/**
 * Takes the gate for this Herdr pane, wrapping the socket once per process.
 * A gate left by `/reload` keeps its held report and counts for the new owner.
 */
export function adoptGate(owner: object, env: HerdrEnv): Gate {
	const existing = registry[KEY];
	if (existing && existing.endpoint === env.endpoint && existing.gate.paneId === env.paneId && net.createConnection === existing.wrapped) {
		if (existing.orphanTimer) clearTimeout(existing.orphanTimer);
		existing.orphanTimer = undefined;
		existing.owner = owner;
		return existing.gate;
	}
	if (existing) releaseSlot(existing);
	const original = net.createConnection;
	const gate = new Gate({ paneId: env.paneId, send: (bytes) => { void replay(original, env.endpoint, bytes); } });
	const wrapped = wrap(() => registry[KEY], original, env.endpoint);
	registry[KEY] = { original, wrapped, endpoint: env.endpoint, gate, owner, orphanTimer: undefined };
	net.createConnection = wrapped;
	return gate;
}

function releaseSlot(slot: Slot): void {
	if (slot.orphanTimer) clearTimeout(slot.orphanTimer);
	// Another wrapper placed later stays in charge; ours then only stops gating.
	if (net.createConnection === slot.wrapped) net.createConnection = slot.original;
	if (registry[KEY] === slot) registry[KEY] = undefined;
}

/**
 * The owner is going away. On `/reload` the next copy adopts the gate; if none
 * does within ORPHAN_MS, the held idle goes out and the socket is unwrapped.
 * On quit the held report is dropped; Herdr sees the agent exit by itself.
 */
export function leaveGate(owner: object, reason: string, orphanMs = ORPHAN_MS): void {
	const slot = registry[KEY];
	if (!slot || slot.owner !== owner) return;
	slot.owner = undefined;
	if (reason === "quit") { slot.gate.drop(); releaseSlot(slot); return; }
	slot.orphanTimer = setTimeout(() => {
		if (registry[KEY] !== slot || slot.owner) return;
		releaseSlot(slot);
		slot.gate.flush();
	}, orphanMs);
	slot.orphanTimer.unref();
}

/** Tests: the live gate, if any. */
export function currentGate(): Gate | undefined { return registry[KEY]?.gate; }
