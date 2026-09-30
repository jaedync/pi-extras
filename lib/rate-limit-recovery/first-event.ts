/**
 * Anthropic can hold a subscription (OAuth) request near :00/:30 UTC: HTTP 200, then only
 * keep-alive pings for minutes and no message_start (earendil-works/pi#10019). Pings reset
 * Pi's HTTP idle timer, so the turn never fails and auto-retry never runs. This watchdog
 * fails such a stream with "timed out", which Pi's retry classifier already treats as
 * transient, so Pi's own backoff and attempt limit handle the retry.
 */
export const ANTHROPIC_API = "anthropic-messages";
export const DEFAULT_FIRST_EVENT_SECONDS = 45;
export const ANTHROPIC_HOSTS: ReadonlySet<string> = new Set(["api.anthropic.com"]);
const MESSAGES_PATH = "/v1/messages";
// Pings are tiny; a partial line longer than this is not a pending event name.
const MAX_PARTIAL_CHARS = 4096;

export interface FirstEventPolicy {
	/** Wait after response headers for the first non-ping SSE event; 0 disables. */
	readonly timeoutMs: number;
	readonly hosts: ReadonlySet<string>;
}

export function stallMessage(timeoutMs: number): string {
	return `Anthropic stream timed out: no response event ${timeoutMs / 1000}s after headers (keep-alive pings only).`;
}

function requestHeaders(input: RequestInfo | URL, init: RequestInit | undefined): Headers {
	// Like fetch(), init.headers replaces a Request's headers rather than merging with them.
	return new Headers(init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined);
}

/** Subscription auth sends a bearer token; API-key requests were not seen stalling. */
export function subscriptionMessagesRequest(input: RequestInfo | URL, init: RequestInit | undefined, hosts: ReadonlySet<string>): boolean {
	let url: URL;
	try { url = new URL(input instanceof Request ? input.url : String(input)); } catch { return false; }
	if (!hosts.has(url.host) || !url.pathname.endsWith(MESSAGES_PATH)) return false;
	const headers = requestHeaders(input, init);
	return headers.has("authorization") && !headers.has("x-api-key");
}

interface ScanState { readonly partial: string; readonly overflow: boolean }

function scan(state: ScanState, text: string): { readonly seen: boolean; readonly state: ScanState } {
	const lines = (state.partial + text).split(/\r\n|\r|\n/);
	const last = lines.pop() ?? "";
	// After an overlong line, text up to the next break is its tail, never a new event name.
	const complete = state.overflow ? lines.slice(1) : lines;
	const seen = complete.some((line) => line.startsWith("event:") && line.slice("event:".length).trim() !== "ping");
	const overflow = last.length > MAX_PARTIAL_CHARS || (state.overflow && lines.length === 0);
	return { seen, state: { partial: overflow ? "" : last, overflow } };
}

/** Pass the body through unchanged, failing it only if no non-ping event arrives in time. */
export function watchFirstEvent(response: Response, timeoutMs: number, signal?: AbortSignal): Response {
	if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let scanned: ScanState = { partial: "", overflow: false };
	let seen = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const disarm = () => { clearTimeout(timer); signal?.removeEventListener("abort", disarm); };
	const settle = () => { settled = true; disarm(); };
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			// An abort already errors the fetch body; the stall error must not replace it.
			signal?.addEventListener("abort", disarm, { once: true });
			timer = setTimeout(() => {
				if (seen || settled) return;
				settle();
				controller.error(new Error(stallMessage(timeoutMs)));
				// Never await: cancelling a held read can wait on the network.
				void reader.cancel().catch(() => undefined);
			}, timeoutMs);
		},
		async pull(controller) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try { chunk = await reader.read(); }
			catch (error) {
				if (!settled) { settle(); controller.error(error); }
				return;
			}
			if (settled) return;
			if (chunk.done) { settle(); controller.close(); return; }
			if (!seen) {
				const result = scan(scanned, decoder.decode(chunk.value, { stream: true }));
				scanned = result.state;
				if (result.seen) { seen = true; disarm(); }
			}
			controller.enqueue(chunk.value);
		},
		cancel(reason) {
			settle();
			return reader.cancel(reason);
		},
	});
	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function guardFirstEvent(api: string, input: RequestInfo | URL, init: RequestInit | undefined, response: Response, policy: FirstEventPolicy | undefined, signal?: AbortSignal): Response {
	if (api !== ANTHROPIC_API || !policy || policy.timeoutMs <= 0 || !subscriptionMessagesRequest(input, init, policy.hosts)) return response;
	return watchFirstEvent(response, policy.timeoutMs, signal);
}
