/**
 * The Windows-side host process (host.ps1), started on first use through WSL
 * interop and kept warm between calls: PowerShell and the Hyper-V module take
 * seconds to load, far longer than a single console action.
 */
import { type ClientProcess, McpLink } from "../computer-use/mcp-link.ts";
import type { HostCallOptions, HostCalls } from "./guest.ts";

const NAMES = { process: "windows_use host (powershell.exe)", call: "windows_use" } as const;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface HostSessionOptions {
	readonly launch: () => ClientProcess | Promise<ClientProcess>;
	/** Close the host after this long without a call. */
	readonly idleMs: number;
	readonly timeoutMs?: number;
}

export class HostSession implements HostCalls {
	private readonly options: HostSessionOptions;
	private link?: McpLink;
	private starting?: Promise<McpLink>;
	private idleTimer?: NodeJS.Timeout;
	private active = 0;

	constructor(options: HostSessionOptions) {
		this.options = options;
	}

	get state(): "closed" | "starting" | "ready" {
		if (this.link && !this.link.closed) return "ready";
		return this.starting ? "starting" : "closed";
	}

	async call(method: string, params: Record<string, unknown> = {}, options: HostCallOptions = {}): Promise<unknown> {
		clearTimeout(this.idleTimer);
		this.active++;
		const limit = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const timeout = AbortSignal.timeout(limit);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		try {
			const link = await this.connect();
			return await link.request(method, params, signal);
		} catch (error) {
			if (!timeout.aborted || options.signal?.aborted) throw error;
			// The host is still busy with the abandoned call; start fresh next time.
			this.close();
			throw new Error(`windows_use host ${method} timed out after ${Math.round(limit / 1000)} s`);
		} finally {
			if (--this.active === 0) {
				this.idleTimer = setTimeout(() => this.close(), this.options.idleMs);
				this.idleTimer.unref();
			}
		}
	}

	close(): void {
		clearTimeout(this.idleTimer);
		this.link?.close();
		this.link = undefined;
	}

	private async connect(): Promise<McpLink> {
		if (this.link && !this.link.closed) return this.link;
		this.starting ??= Promise.resolve(this.options.launch())
			.then((proc) => (this.link = new McpLink(proc, NAMES)))
			.finally(() => { this.starting = undefined; });
		return this.starting;
	}
}
