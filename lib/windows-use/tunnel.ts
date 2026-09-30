/** A dedicated binary stdio process keeps guest HTTP independent of console calls. */
import { Duplex } from "node:stream";
import type { ClientProcess } from "../computer-use/mcp-link.ts";
import { TransportError } from "./transport.ts";

export type TunnelTarget = { readonly vm: string; readonly service: string } | { readonly tcp: string };
/** A VM's Hyper-V id and windows_use host key; either is missing when there is none. */
export interface VmLookup { readonly id?: string; readonly key?: string }
interface PendingLookup { readonly resolve: (value: VmLookup) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout }
export interface TunnelOptions {
	readonly launch: () => ClientProcess | Promise<ClientProcess>;
	readonly idleMs: number;
	readonly helloTimeoutMs?: number;
}
interface OpenOptions { readonly signal?: AbortSignal; readonly timeoutMs?: number }
export interface TunnelFrame { readonly type: number; readonly stream: number; readonly payload: Buffer }
const MAX_PAYLOAD = 1024 * 1024;
const WRITE_CHUNK = 64 * 1024;
const READ_LIMIT = 4 * MAX_PAYLOAD;
const EMPTY = Buffer.alloc(0);

export function encodeFrame(type: number, stream: number, payload: Buffer = EMPTY): Buffer {
	if (payload.length > MAX_PAYLOAD) throw new Error("tunnel frame payload exceeds 1 MiB");
	const frame = Buffer.allocUnsafe(9 + payload.length);
	frame[0] = type; frame.writeUInt32BE(stream, 1); frame.writeUInt32BE(payload.length, 5);
	payload.copy(frame, 9);
	return frame;
}

/** Allocate each payload once even when Windows pipes fragment it into small chunks. */
export class FrameDecoder {
	private readonly receive: (frame: TunnelFrame) => void;
	private readonly header = Buffer.alloc(9);
	private headerUsed = 0;
	private payload?: Buffer;
	private payloadUsed = 0;
	constructor(receive: (frame: TunnelFrame) => void) { this.receive = receive; }
	push(chunk: Buffer): void {
		let offset = 0;
		while (offset < chunk.length) {
			if (!this.payload) {
				const count = Math.min(9 - this.headerUsed, chunk.length - offset);
				chunk.copy(this.header, this.headerUsed, offset, offset + count);
				this.headerUsed += count; offset += count;
				if (this.headerUsed !== 9) continue;
				const length = this.header.readUInt32BE(5);
				if (length > MAX_PAYLOAD) throw new Error("tunnel frame payload exceeds 1 MiB");
				this.payload = Buffer.allocUnsafe(length);
			}
			const count = Math.min(this.payload.length - this.payloadUsed, chunk.length - offset);
			chunk.copy(this.payload, this.payloadUsed, offset, offset + count);
			this.payloadUsed += count; offset += count;
			if (this.payloadUsed !== this.payload.length) continue;
			const frame = { type: this.header[0]!, stream: this.header.readUInt32BE(1), payload: this.payload };
			this.payload = undefined; this.payloadUsed = 0; this.headerUsed = 0;
			this.receive(frame);
		}
	}
}

class TunnelStream extends Duplex {
	private readonly send: (type: number, payload: Buffer, cb?: (error?: Error | null) => void) => void;
	remoteClosed = false;
	constructor(send: TunnelStream["send"]) {
		super({ allowHalfOpen: true }); this.send = send;
		// Exit can race with the caller attaching its HTTP error listener.
		this.on("error", () => {});
	}
	override _read(): void {}
	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		let offset = 0;
		const next = (error?: Error | null): void => {
			if (error || offset === chunk.length) { callback(error); return; }
			const payload = chunk.subarray(offset, offset + WRITE_CHUNK); offset += payload.length;
			this.send(2, payload, next);
		};
		next();
	}
	override _final(callback: (error?: Error | null) => void): void { this.send(3, EMPTY, callback); }
	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		if (!this.remoteClosed) this.send(4, EMPTY);
		callback(error);
	}
	setNoDelay(): this { return this; }
	setKeepAlive(): this { return this; }
	setTimeout(): this { return this; }
	ref(): this { return this; }
	unref(): this { return this; }
}
interface Pending {
	readonly stream: TunnelStream;
	readonly resolve: (stream: Duplex) => void;
	readonly reject: (error: Error) => void;
	readonly cleanup: () => void;
	opened: boolean;
	cancelled: boolean;
}

class Session {
	readonly ready: Promise<void>;
	private readonly proc: ClientProcess;
	private readonly streams = new Map<number, Pending>();
	private readonly lookups = new Map<number, PendingLookup>();
	private nextId = 1;
	private stderr = "";
	private hello = false;
	private resolveHello!: () => void;
	private rejectHello!: (error: Error) => void;
	private helloTimer: NodeJS.Timeout;
	private readonly changed: () => void;
	error?: Error;
	constructor(proc: ClientProcess, helloMs: number, changed: () => void) {
		this.proc = proc; this.changed = changed;
		this.ready = new Promise((resolve, reject) => { this.resolveHello = resolve; this.rejectHello = reject; });
		this.helloTimer = setTimeout(() => this.fail(new Error("windows_use tunnel HELLO timed out")), helloMs);
		const decoder = new FrameDecoder(frame => this.receive(frame));
		proc.stdout.on("data", (chunk: Buffer) => {
			try { decoder.push(chunk); } catch (error) { this.fail(new Error(`windows_use tunnel protocol error: ${String(error)}`)); }
		});
		proc.stdout.on("error", error => this.fail(error));
		proc.stdin.on("error", error => this.fail(new Error(`windows_use tunnel stdin failed: ${error.message}`)));
		proc.stderr?.on("data", chunk => { this.stderr = `${this.stderr}${chunk}`.slice(-2000); });
		proc.stderr?.on("error", error => { this.stderr = `${this.stderr}\n${error.message}`.slice(-2000); });
		// ClientProcess's minimal interface only names close; actual child emitters also report spawn errors.
		const events = proc as ClientProcess & { once(event: "error", listener: (error: Error) => void): unknown };
		events.once("error", error => this.fail(new Error(`windows_use tunnel failed to start: ${error.message}`)));
		proc.once("close", code => this.fail(new Error(`windows_use tunnel exited (code ${code ?? "unknown"})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`)));
	}
	get active(): number { return [...this.streams.values()].filter(pending => !pending.cancelled).length; }
	close(): void { this.fail(new Error("windows_use tunnel closed")); }
	open(target: TunnelTarget, options: OpenOptions): Promise<Duplex> {
		if (this.error) return Promise.reject(new TransportError(this.error.message, true));
		if (this.nextId > 0xffffffff) return Promise.reject(new TransportError("tunnel stream IDs exhausted", true));
		const limit = options.timeoutMs ?? 30_000;
		const payload = Buffer.from(JSON.stringify({ ...target, timeoutMs: limit }));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const abort = () => {
				pending.cancelled = true;
				pending.cleanup(); reject(new TransportError("windows_use tunnel open cancelled", true));
				// Keep the tombstone until OPENED so a late successful connect is closed.
				this.send(4, id);
			};
			const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
			const stream = new TunnelStream((type, payload, cb) => this.send(type, id, payload, cb));
			const pending: Pending = { stream, resolve, reject, cleanup, opened: false, cancelled: false };
			this.streams.set(id, pending);
			options.signal?.addEventListener("abort", abort, { once: true });
			timer = setTimeout(() => {
				pending.cancelled = true; cleanup(); reject(new TransportError("windows_use tunnel connect timed out", true));
				this.send(4, id);
			}, limit);
			this.send(1, id, payload);
			if (options.signal?.aborted) abort();
		});
	}
	lookup(vm: string, timeoutMs: number): Promise<VmLookup> {
		if (this.error) return Promise.reject(new TransportError(this.error.message, true));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.lookups.delete(id); reject(new TransportError("windows_use tunnel lookup timed out", true)); }, timeoutMs);
			this.lookups.set(id, { resolve, reject, timer });
			this.send(5, id, Buffer.from(JSON.stringify({ vm })));
		});
	}
	private answer(frame: TunnelFrame): void {
		const pending = this.lookups.get(frame.stream);
		// An answer after its timeout finds nobody waiting.
		if (!pending) return;
		this.lookups.delete(frame.stream); clearTimeout(pending.timer);
		const value = JSON.parse(frame.payload.toString()) as Record<string, unknown>;
		if (typeof value.error === "string") { pending.reject(new TransportError(`windows_use tunnel can't look up the VM: ${value.error}`, true)); return; }
		pending.resolve({ ...(typeof value.id === "string" ? { id: value.id } : {}), ...(typeof value.key === "string" ? { key: value.key } : {}) });
	}
	private send(type: number, id: number, payload: Buffer = EMPTY, cb?: (error?: Error | null) => void): void {
		if (this.error) { cb?.(this.error); return; }
		try { this.proc.stdin.write(encodeFrame(type, id, payload), cb); }
		catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); cb?.(this.error); }
	}
	private receive(frame: TunnelFrame): void {
		if (this.error) return;
		if (!this.hello) {
			if (frame.type !== 0x80 || frame.stream !== 0 || JSON.parse(frame.payload.toString()).version !== 1) throw new Error("expected HELLO version 1");
			this.hello = true; clearTimeout(this.helloTimer); this.resolveHello(); return;
		}
		if (frame.type === 0x86 && frame.stream !== 0) { this.answer(frame); return; }
		if (frame.type < 0x81 || frame.type > 0x85 || frame.stream === 0) throw new Error("invalid tunnel frame");
		const pending = this.streams.get(frame.stream);
		if (!pending) throw new Error("unknown tunnel stream");
		const stream = pending.stream;
		switch (frame.type) {
			case 0x81:
				if (pending.opened || frame.payload.length) throw new Error("invalid OPENED");
				pending.opened = true; pending.cleanup();
				if (pending.cancelled) this.send(4, frame.stream); else pending.resolve(stream);
				break;
			case 0x82:
				if (pending.opened) throw new Error("OPEN_FAILED after OPENED");
				pending.reject(new TransportError(String(JSON.parse(frame.payload.toString()).message ?? "tunnel connect failed"), true));
				stream.remoteClosed = true; stream.destroy(); this.remove(frame.stream); break;
			case 0x83:
				if (!pending.opened) throw new Error("DATA before OPENED");
				if (!stream.destroyed && !pending.cancelled) {
					if (stream.readableLength + frame.payload.length > READ_LIMIT) stream.destroy(new Error("tunnel stream receive buffer exceeded 4 MiB"));
					else stream.push(frame.payload);
				}
				break;
			case 0x84:
				if (!pending.opened || frame.payload.length) throw new Error("invalid END");
				if (!stream.destroyed) stream.push(null); break;
			case 0x85:
				if (!pending.opened) throw new Error("CLOSED before OPENED");
				stream.remoteClosed = true;
				if (frame.payload.length) stream.destroy(new Error(frame.payload.toString()));
				else { stream.push(null); if (pending.cancelled) stream.destroy(); }
				this.remove(frame.stream); break;
		}
	}
	private remove(id: number): void { this.streams.get(id)?.cleanup(); this.streams.delete(id); this.changed(); }
	private fail(error: Error): void {
		if (this.error) return;
		this.error = error; clearTimeout(this.helloTimer); this.rejectHello(error);
		for (const pending of this.lookups.values()) { clearTimeout(pending.timer); pending.reject(new TransportError(error.message, true)); }
		this.lookups.clear();
		for (const pending of this.streams.values()) {
			pending.cleanup(); pending.stream.remoteClosed = true;
			if (pending.opened) pending.stream.destroy(error);
			else { pending.reject(new TransportError(error.message, true)); pending.stream.destroy(); }
		}
		this.streams.clear(); this.proc.kill(); this.changed();
	}
}

export class Tunnel {
	private readonly options: TunnelOptions;
	private session?: Session;
	private starting?: Promise<Session>;
	private idleTimer?: NodeJS.Timeout;
	private activeOpens = 0;
	private generation = 0;
	constructor(options: TunnelOptions) { this.options = options; }
	async open(target: TunnelTarget, options: OpenOptions = {}): Promise<Duplex> {
		if (options.signal?.aborted) throw new TransportError("windows_use tunnel open cancelled", true);
		clearTimeout(this.idleTimer); this.activeOpens++;
		try {
			const session = await this.waitForStart(options.signal);
			return await session.open(target, options);
		} catch (error) {
			if (error instanceof TransportError) throw error;
			throw new TransportError(error instanceof Error ? error.message : String(error), true);
		} finally { this.activeOpens--; this.scheduleIdle(); }
	}
	/** A VM's id and host key, read by the tunnel process itself. */
	async lookup(vm: string, options: OpenOptions = {}): Promise<VmLookup> {
		if (options.signal?.aborted) throw new TransportError("windows_use tunnel lookup cancelled", true);
		clearTimeout(this.idleTimer); this.activeOpens++;
		try {
			const session = await this.waitForStart(options.signal);
			return await session.lookup(vm, options.timeoutMs ?? 10_000);
		} catch (error) {
			if (error instanceof TransportError) throw error;
			throw new TransportError(error instanceof Error ? error.message : String(error), true);
		} finally { this.activeOpens--; this.scheduleIdle(); }
	}
	/** Starts the process now; a failure surfaces on the next open. */
	warm(): void {
		this.connect().catch(() => {});
	}
	close(): void {
		this.generation++; clearTimeout(this.idleTimer); this.session?.close(); this.session = undefined;
		this.starting = undefined;
	}
	private waitForStart(signal?: AbortSignal): Promise<Session> {
		return new Promise((resolve, reject) => {
			const abort = () => reject(new TransportError("windows_use tunnel open cancelled", true));
			signal?.addEventListener("abort", abort, { once: true });
			this.connect().then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
			if (signal?.aborted) abort();
		});
	}
	private connect(): Promise<Session> {
		const session = this.session;
		if (session && !session.error) return session.ready.then(() => session);
		if (this.starting) return this.starting;
		const generation = this.generation;
		const starting = Promise.resolve().then(() => this.options.launch()).then(async proc => {
			if (generation !== this.generation) { proc.kill(); throw new Error("windows_use tunnel closed during startup"); }
			const session = new Session(proc, this.options.helloTimeoutMs ?? 30_000, () => this.scheduleIdle());
			this.session = session;
			await session.ready; return session;
		}).finally(() => { if (this.starting === starting) this.starting = undefined; this.scheduleIdle(); });
		this.starting = starting; return starting;
	}
	private scheduleIdle(): void {
		clearTimeout(this.idleTimer);
		if (this.activeOpens || this.session?.active || this.starting || !this.session || this.session.error) return;
		this.idleTimer = setTimeout(() => this.close(), this.options.idleMs); this.idleTimer.unref();
	}
}
