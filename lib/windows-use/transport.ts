/** Failures between the host and a guest's Windows-MCP, as opposed to a tool's own errors. */

/** Host errors that prove a request never reached the server, so sending it again is safe. */
export const NOT_SENT = /^(cannot reach Windows-MCP|VM '.*' has no IPv4 address|Windows-MCP is not set up)/;

/** The host's own limit ran out: the server took the request and never answered. */
export const HOST_TIMEOUT = /^windows_use host mcp timed out after/;

export class TransportError extends Error {
	/** True only when the request provably never reached the server. */
	readonly unsent: boolean;
	readonly timedOut: boolean;

	constructor(message: string, unsent = false, timedOut = false) {
		super(message);
		this.unsent = unsent;
		this.timedOut = timedOut;
	}
}

