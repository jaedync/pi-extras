/**
 * The small part of MCP the Computer Use client needs: newline-delimited
 * JSON-RPC over a child's stdio, in both directions. The client asks us for
 * approval (elicitation) in the middle of a tool call, so server requests are
 * answered by a handler while our own requests are still pending.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface ClientProcess {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable | null;
	kill(signal?: NodeJS.Signals): boolean;
	once(event: "close", listener: (code: number | null) => void): unknown;
}

export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>;

interface Waiter {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

/** Enough of the client's stderr to explain an exit without flooding the error. */
const STDERR_TAIL_CHARS = 400;
const METHOD_NOT_FOUND = -32601;

export class McpLink {
	private readonly proc: ClientProcess;
	private readonly pending = new Map<number, Waiter>();
	private nextId = 1;
	private stderrTail = "";
	private exitError?: Error;
	onServerRequest: ServerRequestHandler = async (method) => {
		throw Object.assign(new Error(`unsupported request ${method}`), { code: METHOD_NOT_FOUND });
	};

	constructor(proc: ClientProcess) {
		this.proc = proc;
		createInterface({ input: proc.stdout }).on("line", (line) => this.receive(line));
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
		});
		// A closed pipe is reported by the exit below; without a listener it would crash Pi.
		proc.stdin.on("error", () => {});
		proc.once("close", (code) => {
			const detail = this.stderrTail.trim();
			this.exitError = new Error(`Computer Use client exited (code ${code ?? "unknown"})${detail ? `: ${detail}` : ""}`);
			for (const waiter of this.pending.values()) waiter.reject(this.exitError);
			this.pending.clear();
		});
	}

	get closed(): boolean {
		return this.exitError !== undefined;
	}

	request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		if (this.exitError) return Promise.reject(this.exitError);
		if (signal?.aborted) return Promise.reject(new Error("Computer Use call cancelled"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const abort = () => {
				// The client may still answer; that late response is dropped as unknown.
				this.pending.delete(id);
				reject(new Error("Computer Use call cancelled"));
			};
			signal?.addEventListener("abort", abort, { once: true });
			const done = () => signal?.removeEventListener("abort", abort);
			this.pending.set(id, {
				resolve: (value) => { done(); resolve(value); },
				reject: (error) => { done(); reject(error); },
			});
			this.write({ id, method, params });
		});
	}

	notify(method: string, params?: unknown): void {
		this.write({ method, ...(params === undefined ? {} : { params }) });
	}

	close(): void {
		if (!this.exitError) this.proc.kill("SIGTERM");
	}

	private write(message: object): void {
		this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	}

	private receive(line: string): void {
		let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };
		try { message = JSON.parse(line); } catch { return; }
		if (typeof message.method === "string") {
			if (message.id !== undefined) void this.answer(message.id, message.method, message.params);
			return;
		}
		if (typeof message.id !== "number") return;
		const waiter = this.pending.get(message.id);
		if (!waiter) return;
		this.pending.delete(message.id);
		if (message.error) waiter.reject(new Error(String(message.error.message ?? "Computer Use request failed")));
		else waiter.resolve(message.result);
	}

	private async answer(id: unknown, method: string, params: unknown): Promise<void> {
		try {
			this.write({ id, result: await this.onServerRequest(method, params) });
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			this.write({ id, error: { code: typeof code === "number" ? code : -32603, message: error instanceof Error ? error.message : String(error) } });
		}
	}
}
