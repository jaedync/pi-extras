/**
 * One warm connection to the Computer Use client, shared by every call until
 * it has been idle for a while. Keeping it open avoids a restart per prompt and
 * keeps the element indices from the last get_app_state valid across turns.
 */
import { type ClientProcess, McpLink } from "./mcp-link.ts";

export type Approval = "once" | "always" | "deny";

/** The client asking the user to let the agent use an app. Text is control-free and length-capped. */
export interface ApprovalRequest {
	/** The app's name as the client resolved it, or "" if the message had an unfamiliar shape. */
	readonly app: string;
	readonly message: string;
	/** The client's risk warning, with "ChatGPT" replaced by "the agent" since that is who asks. */
	readonly warning?: string;
	readonly highRisk: boolean;
	/** Whether the client offers to remember the answer ("Always allow"). */
	readonly canRemember: boolean;
	/** Aborts when the call is cancelled; the answer is then ignored and the request declined. */
	readonly signal: AbortSignal;
}

export interface CallOptions {
	/** Asked when the client wants the user to allow an app. */
	readonly approve: (request: ApprovalRequest) => Promise<Approval>;
	readonly signal?: AbortSignal;
}

export type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
	readonly content: ContentBlock[];
	readonly isError: boolean;
	/** Set on the call that had to start the client: how long that took. */
	readonly startupMs?: number;
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
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
const MAX_MESSAGE_CHARS = 200;
const MAX_WARNING_CHARS = 600;
/** The client's wording, captured from Computer Use 26.819: "Allow ChatGPT to use Safari?". */
const APPROVAL_MESSAGE = /^Allow \S+ to use (.+)\?$/;
const DECLINE = { action: "decline" } as const;

function plain(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const text = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Only the one shape the client uses for app approvals is answered: a form
 * with nothing to fill in. Anything else (a URL to open, fields to fill) is
 * declined unseen, so saying yes to an app can never mean saying yes to that.
 */
function approvalRequest(params: unknown, signal: AbortSignal): ApprovalRequest | undefined {
	const request = record(params);
	const schema = record(request.requestedSchema);
	const properties = schema.properties === undefined ? {} : schema.properties;
	const required = schema.required === undefined ? [] : schema.required;
	if (request.mode !== undefined && request.mode !== "form") return undefined;
	if (schema.type !== "object" || !properties || typeof properties !== "object" || Object.keys(properties).length > 0) return undefined;
	if (!Array.isArray(required) || required.length > 0) return undefined;
	const message = plain(request.message, MAX_MESSAGE_CHARS);
	if (!message) return undefined;
	const meta = record(request._meta);
	const warning = plain(meta.subtitle, MAX_WARNING_CHARS).replace(/\bChatGPT\b/g, "the agent");
	return {
		app: APPROVAL_MESSAGE.exec(message)?.[1] ?? "",
		message,
		warning: warning || undefined,
		highRisk: meta.riskLevel === "high",
		canRemember: Array.isArray(meta.persist) && meta.persist.includes("always"),
		signal,
	};
}

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
			const cold = this.state !== "ready";
			const started = performance.now();
			const link = await this.connect(signal);
			const startupMs = cold ? Math.round(performance.now() - started) : undefined;
			this.current = { options, pause: () => clearTimeout(timer), resume: arm };
			arm();
			const result = toResult(await link.request("tools/call", { name: tool, arguments: args }, signal));
			return startupMs === undefined ? result : { ...result, startupMs };
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
		if (!call) return DECLINE;
		// The dialog closes when the call is cancelled, and nothing is accepted after that.
		const cancelled = new AbortController();
		const signal = call.options.signal ? AbortSignal.any([call.options.signal, cancelled.signal]) : cancelled.signal;
		const request = approvalRequest(params, signal);
		if (!request || signal.aborted) return DECLINE;
		call.pause();
		try {
			const answer = await call.options.approve(request).catch(() => "deny" as const);
			if (signal.aborted || answer === "deny") return DECLINE;
			return answer === "always" && request.canRemember ? { action: "accept", content: {}, _meta: { persist: "always" } } : { action: "accept", content: {} };
		} finally {
			cancelled.abort();
			call.resume();
		}
	}
}
