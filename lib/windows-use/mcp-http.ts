/** Relay readiness proves whether retry is safe; after HTTP starts, it never is. */
import { request, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Tunnel, TunnelTarget } from "./tunnel.ts";
import { TransportError } from "./transport.ts";

interface RelayOptions {
	readonly signal?: AbortSignal;
	/** For the open and the relay's status byte together. */
	readonly timeoutMs?: number;
	/** For the open alone: a missing relay never refuses a Hyper-V socket, it only times out. */
	readonly openTimeoutMs?: number;
}
interface PostOptions extends RelayOptions { readonly key: string; readonly message: unknown }
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_HANDSHAKE_BYTES = 64 * 1024;

export async function openRelay(tunnel: Tunnel, target: TunnelTarget, options: RelayOptions = {}): Promise<Duplex> {
	const limit = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), limit);
	const signal = options.signal ? AbortSignal.any([timeout.signal, options.signal]) : timeout.signal;
	try {
		const stream = await tunnel.open(target, { signal, timeoutMs: Math.min(options.openTimeoutMs ?? limit, limit) });
		return await readStatus(stream, signal);
	} catch (error) {
		if (timeout.signal.aborted && !options.signal?.aborted) throw new TransportError(`windows_use relay handshake timed out after ${Math.round(limit / 1000)} s`, true);
		if (error instanceof TransportError) throw error;
		throw new TransportError(error instanceof Error ? error.message : String(error), true);
	} finally { clearTimeout(timer); }
}

function readStatus(stream: Duplex, signal: AbortSignal): Promise<Duplex> {
	return new Promise((resolve, reject) => {
		let status: number | undefined, bytes = 0, done = false;
		const message: Buffer[] = [];
		const cleanup = () => {
			stream.removeListener("readable", readable); stream.removeListener("end", end);
			stream.removeListener("error", error); stream.removeListener("close", close);
			signal.removeEventListener("abort", abort);
		};
		const fail = (text: string) => {
			if (done) return;
			done = true; cleanup(); stream.destroy(); reject(new TransportError(text, true));
		};
		const readable = () => {
			let chunk: Buffer | null;
			while ((chunk = stream.read()) !== null) {
				if (status === undefined) { status = chunk[0]; chunk = chunk.subarray(1); }
				if (status === 1) { done = true; cleanup(); if (chunk.length) stream.unshift(chunk); resolve(stream); return; }
				if (status !== 0) { fail("Windows-MCP relay returned an invalid status byte"); return; }
				bytes += chunk.length;
				if (bytes > MAX_HANDSHAKE_BYTES) { fail("Windows-MCP relay error exceeded 64 KiB"); return; }
				message.push(chunk);
			}
		};
		const end = () => fail(status === 0 ? Buffer.concat(message).toString("utf8") || "Windows-MCP relay is not ready" : "Windows-MCP relay closed before readiness");
		const close = () => end();
		const error = (cause: Error) => fail(`Windows-MCP relay failed before readiness: ${cause.message}`);
		const abort = () => fail("windows_use relay handshake cancelled");
		stream.on("readable", readable); stream.once("end", end); stream.once("error", error); stream.once("close", close);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		else { readable(); if (!done && (stream.readableEnded || stream.destroyed)) end(); }
	});
}

/** Match Send-Mcp's event boundaries, including a final event without a blank line. */
function parseMessages(body: string, contentType: string): unknown[] {
	if (contentType.split(";", 1)[0]!.trim().toLowerCase() !== "text/event-stream") return body.trim() ? [JSON.parse(body.trim())] : [];
	const messages: unknown[] = [];
	let data = "";
	const flush = () => { if (data.length) { messages.push(JSON.parse(data)); data = ""; } };
	for (const line of body.split(/\r?\n/)) {
		if (line === "") flush();
		else if (line.startsWith("data:")) {
			const value = line.slice(5).replace(/^ /, "");
			data = `${data}${data.length ? "\n" : ""}${value}`;
		}
	}
	flush(); return messages;
}

type Finish = (error?: Error, messages?: unknown[]) => void;
function readResponse(res: IncomingMessage, redact: (text: string) => string, finish: Finish, lost: (error: Error) => void): void {
	res.once("error", lost);
	if (res.statusCode === 202) { res.resume(); finish(undefined, []); return; }
	const chunks: Buffer[] = []; let bytes = 0;
	res.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		if (bytes > MAX_BODY_BYTES) lost(new Error("Windows-MCP response exceeded 64 MiB"));
		else chunks.push(chunk);
	});
	res.once("aborted", () => lost(new Error("response closed before completion")));
	res.once("end", () => {
		if (!res.complete) { lost(new Error("response closed before completion")); return; }
		const text = Buffer.concat(chunks).toString("utf8"), status = res.statusCode ?? 0;
		if (status < 200 || status >= 300) { finish(new TransportError(`Windows-MCP answered HTTP ${status}: ${redact(text).slice(0, 2000)}`)); return; }
		try { finish(undefined, parseMessages(text, res.headers["content-type"] ?? "application/json")); }
		catch (error) { finish(new TransportError(redact(`Windows-MCP returned invalid JSON; the call may have run: ${String(error)}`))); }
	});
}

/** No agent means a socket (or Authorization) cannot cross calls. */
export function postMcp(stream: Duplex, options: PostOptions): Promise<unknown[]> {
	const limit = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const redact = (text: string) => options.key ? text.replaceAll(options.key, "[redacted]") : text;
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (error?: Error, messages?: unknown[]) => {
			if (done) return;
			done = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
			if (error) reject(error); else resolve(messages ?? []);
			stream.destroy();
		};
		const lost = (error: Error) => finish(new TransportError(redact(`lost the tunnel connection to Windows-MCP; the call may have run: ${error.message}`)));
		const abort = () => finish(new Error("windows_use tunnel mcp call cancelled"));
		const timer = setTimeout(() => finish(new TransportError(`windows_use tunnel mcp timed out after ${Math.round(limit / 1000)} s; the call may have run`, false, true)), limit);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) { abort(); return; }
		let body: string;
		try { body = typeof options.message === "string" ? options.message : JSON.stringify(options.message); }
		catch (error) { lost(error instanceof Error ? error : new Error(String(error))); return; }
		try {
			const req = request({
				// agent:false constructs a TCP Agent and ignores createConnection in Node.
				host: "localhost", method: "POST", path: "/mcp", createConnection: () => stream,
				headers: {
					"Content-Type": "application/json", Accept: "application/json, text/event-stream",
					Authorization: `Bearer ${options.key}`, Connection: "close", "Content-Length": Buffer.byteLength(body),
				},
			}, res => readResponse(res, redact, finish, lost));
			req.once("error", lost);
			req.end(body);
		} catch (error) { lost(error instanceof Error ? error : new Error(String(error))); }
	});
}
