/**
 * Windows-MCP over a Hyper-V socket: the host tunnel carries each call to the
 * guest relay, which forwards it to the server on the guest's loopback. It
 * needs no guest IP network, so a full-tunnel VPN inside the guest leaves it
 * working, and a call in flight holds no host process that console input needs.
 */
import type { Duplex } from "node:stream";
import type { HostCalls } from "./guest.ts";
import { openRelay, postMcp } from "./mcp-http.ts";
import { CONTROL_SERVICE, controlRequest, DATA_SERVICE, readControlReply, type ControlReply } from "./relay.ts";
import { TransportError } from "./transport.ts";
import type { Tunnel } from "./tunnel.ts";

export type ControlOp = "ping" | "session" | "restart";

export interface RelayCallOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

/** What a Guest needs from its relay; tests supply their own. */
export interface RelayCalls {
	/** Posts one JSON-RPC message; TransportError marks what never reached the server. */
	mcp(message: string, options: RelayCallOptions): Promise<unknown[]>;
	/** Rejects with an unsent TransportError when the relay can't be reached. */
	control(op: ControlOp, options?: RelayCallOptions): Promise<ControlReply>;
	/** Drops cached credentials, as after setup writes a new key. */
	forget(): void;
}

/**
 * A missing relay never refuses a Hyper-V socket: the connect waits until the
 * caller gives up. Live connects to a listening relay took 10 to 90 ms.
 */
export const RELAY_CONNECT_MS = 2_500;
const CONTROL_MS = 15_000;
const MAX_REPLY = 16 * 1024;

interface Auth { readonly id: string; readonly key: string }

export class RelayChannel implements RelayCalls {
	private readonly tunnel: Tunnel;
	private readonly host: HostCalls;
	private readonly vm: string;
	private auth?: Promise<Auth>;

	constructor(options: { readonly tunnel: Tunnel; readonly host: HostCalls; readonly vm: string }) {
		this.tunnel = options.tunnel;
		this.host = options.host;
		this.vm = options.vm;
	}

	forget(): void {
		this.auth = undefined;
	}

	async mcp(message: string, options: RelayCallOptions): Promise<unknown[]> {
		const { id, key } = await this.credentials(options.signal);
		const stream = await openRelay(this.tunnel, { vm: id, service: DATA_SERVICE }, { signal: options.signal, timeoutMs: RELAY_CONNECT_MS });
		try {
			return await postMcp(stream, { key, message, signal: options.signal, timeoutMs: options.timeoutMs });
		} catch (error) {
			// Authentication fails before the server runs anything, so the call can be sent again.
			if (error instanceof TransportError && /^Windows-MCP answered HTTP 401\b/.test(error.message)) {
				this.forget();
				throw new TransportError(`Windows-MCP on '${this.vm}' rejected the host's key`, true);
			}
			throw error;
		}
	}

	async control(op: ControlOp, options: RelayCallOptions = {}): Promise<ControlReply> {
		const { id, key } = await this.credentials(options.signal);
		const stream = await this.tunnel.open({ vm: id, service: CONTROL_SERVICE }, { signal: options.signal, timeoutMs: RELAY_CONNECT_MS });
		const line = await exchange(stream, controlRequest(key, op), options.timeoutMs ?? CONTROL_MS, options.signal);
		let reply: ControlReply;
		try { reply = readControlReply(line); } catch (error) { throw new TransportError(`windows_use relay on '${this.vm}': ${error instanceof Error ? error.message : String(error)}`, true); }
		if (!reply.ok && reply.error === "unauthorized") {
			this.forget();
			throw new TransportError(`the windows_use relay on '${this.vm}' rejected the host's key`, true);
		}
		return reply;
	}

	private credentials(signal?: AbortSignal): Promise<Auth> {
		this.auth ??= (async () => {
			let value: { id?: unknown; key?: unknown };
			try {
				value = await this.host.call("relayAuth", { vm: this.vm }, { signal }) as typeof value;
			} catch (error) {
				if (signal?.aborted) throw error;
				// Nothing was sent to the guest; the caller falls back to the IP route.
				throw new TransportError(`the windows_use host can't identify '${this.vm}': ${error instanceof Error ? error.message : String(error)}`, true);
			}
			if (typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id)) throw new TransportError(`Hyper-V reported no id for '${this.vm}'`, true);
			if (typeof value.key !== "string" || !value.key) throw new TransportError(`Windows-MCP is not set up on '${this.vm}'`, true);
			return { id: value.id, key: value.key };
		})();
		const pending = this.auth;
		// A failed lookup (VM off, host restarting) must not stick.
		pending.catch(() => { if (this.auth === pending) this.auth = undefined; });
		return pending;
	}
}

/** Writes one request line and reads one reply line; the relay closes after it. */
function exchange(stream: Duplex, request: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const done = (error?: Error, line?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			stream.removeAllListeners("data");
			stream.destroy();
			if (error) reject(error); else resolve(line!);
		};
		const abort = () => done(new Error("windows_use call cancelled"));
		const timer = setTimeout(() => done(new TransportError(`the windows_use relay didn't answer within ${Math.round(timeoutMs / 1000)} s`, false, true)), timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		stream.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			size += chunk.length;
			const text = Buffer.concat(chunks).toString("utf8");
			const end = text.indexOf("\n");
			if (end >= 0) done(undefined, text.slice(0, end));
			else if (size > MAX_REPLY) done(new TransportError("the windows_use relay's reply is too long", false));
		});
		stream.once("end", () => done(new TransportError("the windows_use relay closed without answering", false)));
		stream.once("error", (error: Error) => done(new TransportError(`the windows_use relay connection failed: ${error.message}`, false)));
		stream.write(request);
	});
}
