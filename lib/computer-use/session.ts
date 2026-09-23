/**
 * One warm connection to the Computer Use client, shared by every call until
 * it has been idle for a while. Keeping it open avoids a restart per prompt and
 * keeps the element indices from the last get_app_state valid across turns.
 */
import { type ClientProcess, McpLink } from "./mcp-link.ts";

export type Approval = "once" | "always" | "deny";

export interface CallOptions {
	/** Asked when the client wants the user to allow an app; `canRemember` offers "always". */
	readonly approve: (message: string, canRemember: boolean) => Promise<Approval>;
	readonly signal?: AbortSignal;
}

export type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
	readonly content: ContentBlock[];
	readonly isError: boolean;
}

export interface SessionOptions {
	readonly launch: () => Promise<ClientProcess>;
	/** Close the client after this long without a call. */
	readonly idleMs: number;
	/** Longest a single call may run, not counting time the user spends on an approval. */
	readonly callTimeoutMs: number;
	readonly startTimeoutMs?: number;
}

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_START_TIMEOUT_MS = 15_000;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function toResult(raw: unknown): ToolResult {
	const result = record(raw);
	const blocks = Array.isArray(result.content) ? result.content.map(record) : [];
	const content = blocks.flatMap((block): ContentBlock[] => {
		if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
		if (block.type === "image" && typeof block.data === "string") return [{ type: "image", data: block.data, mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png" }];
		return [];
	});
	return { content, isError: result.isError === true };
}

export class SkySession {
	private readonly options: SessionOptions;
	private link?: McpLink;
	private starting?: Promise<McpLink>;
	private queue: Promise<unknown> = Promise.resolve();
	private idleTimer?: NodeJS.Timeout;
	private current?: { options: CallOptions; pause(): void; resume(): void };

	constructor(options: SessionOptions) {
		this.options = options;
	}

	get state(): "closed" | "starting" | "ready" {
		if (this.link && !this.link.closed) return "ready";
		return this.starting ? "starting" : "closed";
	}

	/** Calls run one at a time: an approval request must reach the call that caused it. */
	call(tool: string, args: Record<string, unknown>, options: CallOptions): Promise<ToolResult> {
		const run = this.queue.then(() => this.run(tool, args, options));
		this.queue = run.catch(() => {});
		return run;
	}

	async close(): Promise<void> {
		clearTimeout(this.idleTimer);
		const link = this.link ?? await this.starting?.catch(() => undefined);
		this.link = undefined;
		link?.close();
	}

	private async run(tool: string, args: Record<string, unknown>, options: CallOptions): Promise<ToolResult> {
		clearTimeout(this.idleTimer);
		const timeout = new AbortController();
		let timer: NodeJS.Timeout | undefined;
		const arm = () => { timer = setTimeout(() => timeout.abort(), this.options.callTimeoutMs); };
		const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
		try {
			const link = await this.connect(signal);
			this.current = { options, pause: () => clearTimeout(timer), resume: arm };
			arm();
			return toResult(await link.request("tools/call", { name: tool, arguments: args }, signal));
		} catch (error) {
			if (!timeout.signal.aborted) throw error;
			// The client is still busy with the abandoned call; start fresh next time.
			await this.close();
			throw new Error(`Computer Use ${tool} timed out after ${this.options.callTimeoutMs} ms`);
		} finally {
			clearTimeout(timer);
			this.current = undefined;
			this.idleTimer = setTimeout(() => void this.close(), this.options.idleMs);
			this.idleTimer.unref();
		}
	}

	private async connect(signal: AbortSignal): Promise<McpLink> {
		if (this.link && !this.link.closed) return this.link;
		this.starting ??= this.start().finally(() => { this.starting = undefined; });
		const link = await this.starting;
		if (signal.aborted) throw new Error("Computer Use call cancelled");
		return link;
	}

	private async start(): Promise<McpLink> {
		const link = new McpLink(await this.options.launch());
		link.onServerRequest = (method, params) => this.serve(method, params);
		const startup = AbortSignal.timeout(this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
		try {
			await link.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: { elicitation: {} }, clientInfo: { name: "pi-extras", version: "1" } }, startup);
		} catch (error) {
			link.close();
			throw startup.aborted ? new Error("Computer Use client did not start in time") : error;
		}
		link.notify("notifications/initialized");
		this.link = link;
		return link;
	}

	private async serve(method: string, params: unknown): Promise<unknown> {
		if (method === "ping") return {};
		if (method !== "elicitation/create") throw Object.assign(new Error(`unsupported request ${method}`), { code: -32601 });
		const call = this.current;
		if (!call) return { action: "decline" };
		const request = record(params);
		const persist = record(request._meta).persist;
		const canRemember = Array.isArray(persist) && persist.includes("always");
		call.pause();
		try {
			const answer = await call.options.approve(typeof request.message === "string" ? request.message : "Allow Computer Use?", canRemember);
			if (answer === "deny") return { action: "decline" };
			return answer === "always" && canRemember ? { action: "accept", content: {}, _meta: { persist: "always" } } : { action: "accept", content: {} };
		} finally {
			call.resume();
		}
	}
}
